import { describe, it, expect, vi } from 'vitest';
import {
  closeAppDialogById,
  enhanceAssetEditDialog,
  enhanceAppDialogs,
  directorySlugFromDisplayName,
  enhanceCategoryReorder,
  enhanceCategorySlugAutofill,
  enhanceConfirmations,
  enhanceDropdowns,
  enhanceProjectAssetCategoryManagement,
  enhanceProjectAssetsDefaultsFetchSave,
  enhanceProjectAssetsDefaultsScope,
  enhanceProjectsDefaultsFetchSave,
  enhanceReleasesDefaultsFetchSave,
  enhanceReleasesLiveFiltering,
  openAppDialogById,
  setAppDialogBaseline,
} from '../src/static/creatorcrate.js';
import { syncProjectAssetsSizePreferences, vetoAppDialogReturn } from '../src/static/client/app-dialogs.js';
import { DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE } from '../src/static/client/projects-defaults-fetch-save.js';
import {
  markProjectAssetsDefaultsRendered,
  projectAssetsDefaultsGridStyleOnlyChange,
  projectAssetsDefaultsSaveBlockedReason,
} from '../src/static/client/project-assets-defaults-scope.js';

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
  // Keep className and classList in step so class selectors find elements the
  // code under test creates with `element.className = ...`.
  Object.defineProperty(node, 'className', {
    get() { return [...this.classList.values].join(' '); },
    set(value) { this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); },
    enumerable: true,
  });
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

const PROJECT_ASSETS_DEFAULT_KEYS = [
  'view', 'gridStyle', 'gridSize', 'listSize', 'sort', 'order', 'pageSize', 'extension', 'tag',
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

function projectAssetsDefaultsHtml(values, activeScope = 'global', savedDefaults = null) {
  const saved = savedDefaults
    ? `<script type="application/json" data-project-assets-saved-defaults>${JSON.stringify(savedDefaults)}</script>`
    : '';
  return `<form id="project-assets-defaults-form"><input name="loadedScope" value="${activeScope}"><script type="application/json" data-project-assets-default-values>${JSON.stringify(values)}</script>${saved}</form>`;
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
      const savedMatch = String(html).match(
        /<script type="application\/json" data-project-assets-saved-defaults>([\s\S]*?)<\/script>/,
      );
      const savedScript = savedMatch ? { textContent: savedMatch[1] } : null;
      const form = {
        querySelector: (selector) => {
          if (selector === 'input[name="loadedScope"]') return scope ? { value: scope[1] } : null;
          if (selector === 'script[type="application/json"][data-project-assets-default-values]') return script;
          if (selector === 'script[type="application/json"][data-project-assets-saved-defaults]') return savedScript;
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
  const dialogId = projectAssetsDefaults ? 'project-assets-filter-dialog' : 'projects-defaults-dialog';
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
    dialogBody.scrollTop = 0;
  }
  const defaultFields = projectAssetsDefaults
    ? (projectAssetsScope ? [
      ['view', 'grid', ['grid', 'list']],
      ['gridStyle', 'uncropped', ['uncropped', 'cropped']],
      ['gridSize', 'default', ['compact', 'default', 'large']],
      ['listSize', 'large', ['compact', 'large']],
      ['sort', 'filename', ['filename', 'modified', 'size', 'category']],
      ['order', 'asc', ['asc', 'desc']],
      ['pageSize', '25', ['10', '25', '50', '100']],
      ['extension', 'jpg', [{ value: 'jpg', label: '.JPG' }, { value: 'png', label: '.PNG' }]],
      ['tag', '1', [{ value: '1', label: 'Landscape' }, { value: '2', label: 'Portrait' }]],
    ] : [
      ['view', 'grid', ['grid', 'list']],
      ['gridStyle', 'uncropped', ['uncropped', 'cropped']],
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
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
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
  if (scrollableDialog) {
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

const CATEGORY_MANAGEMENT_RETURN_TO = '/projects/1/assets';

function makeCategoryManagementBody({ categoryId = '1', categoryName = 'Original', invalidRename = false } = {}) {
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
    type: 'hidden',
    name: 'returnTo',
    value: CATEGORY_MANAGEMENT_RETURN_TO,
  }));
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
  addForm.appendChild(makeElement('input', { type: 'hidden', name: 'enabled', value: '0' }));
  const addEnabled = makeElement('input', { type: 'checkbox', name: 'enabled', value: '1' });
  addEnabled.checked = true;
  addForm.appendChild(addEnabled);
  const addSubmit = makeElement('button', { type: 'submit' });
  addForm.appendChild(addSubmit);
  body.appendChild(addForm);

  const list = makeElement('div', { class: 'category-reorder-list', 'data-category-reorder-list': '' });
  const item = makeElement('article', {
    'data-category-reorder-item': '',
    'data-category-id': categoryId,
    'data-category-label': categoryName,
  });
  item.appendChild(makeElement('button', { type: 'button', 'data-category-reorder-handle': '' }));
  const renameForm = makeElement('form', {
    class: 'category-name-form',
    action: `/projects/1/asset-categories/${categoryId}/name`,
    method: 'post',
  });
  renameForm.appendChild(makeElement('input', { type: 'hidden', name: '_csrf', value: 'csrf-token' }));
  renameForm.appendChild(makeElement('input', {
    type: 'hidden',
    name: 'returnTo',
    value: CATEGORY_MANAGEMENT_RETURN_TO,
  }));
  const renameInputAttrs = { name: 'displayName', id: `name-${categoryId}`, value: categoryName };
  if (invalidRename) {
    renameInputAttrs['aria-describedby'] = `name-${categoryId}-error`;
    renameInputAttrs['aria-invalid'] = 'true';
  }
  renameForm.appendChild(makeElement('input', renameInputAttrs));
  renameForm.appendChild(makeElement('button', { type: 'submit' }));
  if (invalidRename) {
    const renameError = makeElement('span', {
      class: 'field-error-message',
      id: `name-${categoryId}-error`,
      role: 'alert',
    });
    renameError.textContent = 'Display name is required.';
    renameForm.appendChild(renameError);
  }
  item.appendChild(renameForm);
  const deleteForm = makeElement('form', {
    action: `/projects/1/asset-categories/${categoryId}/delete`,
    method: 'post',
    'data-category-management-delete-form': '',
  });
  deleteForm.appendChild(makeElement('input', { type: 'hidden', name: '_csrf', value: 'csrf-token' }));
  deleteForm.appendChild(makeElement('input', {
    type: 'hidden',
    name: 'returnTo',
    value: CATEGORY_MANAGEMENT_RETURN_TO,
  }));
  deleteForm.appendChild(makeElement('button', {
    type: 'submit',
    'data-confirm': 'Delete this category?',
  }));
  item.appendChild(deleteForm);
  list.appendChild(item);
  body.appendChild(list);
  return { body, addSubmit };
}

function makeCategoryDialogPage({ categoryId = '1' } = {}) {
  const page = makeDialogPage({ standardDropdowns: true });
  const dialogId = 'project-asset-category-management-dialog';
  page.dialog.setAttribute('id', dialogId);
  page.trigger.setAttribute('data-dialog-open', dialogId);
  const card = page.dialog.querySelector('.app-dialog-card');
  const initial = makeCategoryManagementBody({ categoryId });
  card.appendChild(initial.body);

  let replacement = makeCategoryManagementBody({ categoryId, categoryName: 'Added category' });
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

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function markOrdinaryDialogForm(page) {
  page.form.setAttribute('data-dialog-async', 'false');
  page.form.setAttribute('data-dialog-reset-on-close', '');
  const controls = page.form.querySelectorAll('select, input, textarea');
  const initial = controls.map((control) => ({
    control,
    value: control.value,
    checked: control.checked,
    selected: control.options?.map((option) => option.selected),
  }));
  page.form.reset = vi.fn(() => {
    initial.forEach(({ control, value, checked, selected }) => {
      control.value = value;
      if (checked !== undefined) control.checked = checked;
      selected?.forEach((isSelected, index) => { control.options[index].selected = isSelected; });
    });
  });
}

describe('Reusable app dialog enhancement', () => {
  it('restores Edit Asset forms and disclosures from confirmed server values', () => {
    const page = makeDialogPage();
    page.dialog.setAttribute('id', 'asset-edit-dialog');
    page.trigger.setAttribute('data-dialog-open', 'asset-edit-dialog');
    page.form.setAttribute('id', 'asset-edit-form');
    page.form.setAttribute('data-dialog-async', 'false');
    page.form.setAttribute('data-confirmed-tag-ids', '2');
    page.form.reset = vi.fn();

    const tagsField = makeElement('div');
    const tagDropdown = addStandardDropdown(
      tagsField, null, 'assetTags', ['1', '2'], '1', false, 'multiple', ['1'],
    ).details;
    tagDropdown.setAttribute('id', 'asset-tags-form');
    const tags = tagDropdown.querySelectorAll('input[type="checkbox"]');
    page.form.appendChild(tagsField);

    const renameForm = makeElement('form');
    const filename = makeElement('input', {
      id: 'rename-filename', value: 'failed-draft.png', 'data-confirmed-value': 'confirmed.png',
    });
    filename.defaultValue = 'failed-draft.png';
    renameForm.appendChild(filename);
    renameForm.reset = vi.fn(() => { filename.value = filename.defaultValue; });
    page.dialog.appendChild(renameForm);

    const moveForm = makeElement('form');
    const destination = makeElement('select', {
      id: 'move-destination', 'data-confirmed-value': '3',
    });
    addOption(destination, '3', false);
    addOption(destination, '4', true);
    destination.value = '4';
    moveForm.appendChild(destination);
    moveForm.reset = vi.fn(() => { destination.value = '4'; });
    page.dialog.appendChild(moveForm);

    const bookForm = makeElement('form');
    const book = makeElement('select', { name: 'bookId' });
    addOption(book, '', true);
    addOption(book, '11');
    book.value = '';
    bookForm.appendChild(book);
    bookForm.reset = vi.fn(() => { book.value = ''; });
    page.dialog.appendChild(bookForm);

    const disclosure = makeElement('details');
    disclosure.open = true;
    page.dialog.appendChild(disclosure);
    enhanceAppDialogs(page.document);
    enhanceAssetEditDialog(page.document);

    openAppDialogById(page.document, page.dialog.id, page.trigger);
    filename.value = 'abandoned.png';
    destination.value = '4';
    book.value = '11';
    tags[0].checked = true;
    tags[1].checked = false;
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(filename.value).toBe('confirmed.png');
    expect(destination.value).toBe('3');
    expect(book.value).toBe('');
    expect(tags.map((option) => option.checked)).toEqual([false, true]);
    expect(tagDropdown.querySelector('[data-cc-dropdown-summary-current]').textContent).toBe('2');
    expect(disclosure.open).toBe(false);
    expect(renameForm.reset).toHaveBeenCalledOnce();
    expect(moveForm.reset).toHaveBeenCalledOnce();
    expect(bookForm.reset).toHaveBeenCalledOnce();
  });

  it('restores the native-backed Move destination dropdown from the confirmed value', () => {
    const page = makeDialogPage();
    page.dialog.setAttribute('id', 'asset-edit-dialog');
    page.trigger.setAttribute('data-dialog-open', 'asset-edit-dialog');
    page.form.setAttribute('data-dialog-async', 'false');
    page.form.reset = vi.fn();

    const moveForm = makeElement('form');
    const destination = makeElement('select', {
      id: 'move-destination', name: 'destinationCategory', 'data-confirmed-value': '3',
    });
    addOption(destination, 'uncategorized', false, 'Uncategorized');
    addOption(destination, '3', false, 'Renders');
    addOption(destination, '4', true, 'Sketches');
    destination.value = '4';
    const moveField = makeElement('div');
    const { details: moveDropdown } = addStandardDropdown(moveField, destination, 'move-destination', [
      { value: 'uncategorized', label: 'Uncategorized' },
      { value: '3', label: 'Renders' },
      { value: '4', label: 'Sketches' },
    ], '4');
    moveForm.appendChild(moveField);
    moveForm.reset = vi.fn(() => { destination.value = '4'; });
    page.dialog.appendChild(moveForm);
    const radios = moveDropdown.querySelectorAll('input[type="radio"]');

    enhanceAppDialogs(page.document);
    enhanceAssetEditDialog(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    // An abandoned draft selection in the custom control.
    destination.value = 'uncategorized';
    radios.forEach((radio) => { radio.checked = radio.value === 'uncategorized'; });
    moveDropdown.open = true;
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(destination.value).toBe('3');
    expect(radios.map((radio) => radio.checked)).toEqual([false, true, false]);
    expect(moveDropdown.querySelector('[data-cc-dropdown-summary-current]').textContent).toBe('Renders');
    expect(moveDropdown.querySelector('summary').getAttribute('aria-label')).toBe('move-destination filter: Renders');
    expect(moveDropdown.open).toBe(false);
    expect(moveForm.reset).toHaveBeenCalledOnce();
  });

  it('uses a newly confirmed Edit Asset value after a successful operation', () => {
    const page = makeDialogPage();
    page.dialog.setAttribute('id', 'asset-edit-dialog');
    page.trigger.setAttribute('data-dialog-open', 'asset-edit-dialog');
    page.form.setAttribute('data-dialog-async', 'false');
    page.form.reset = vi.fn();
    const filename = makeElement('input', {
      id: 'rename-filename', value: 'renamed.png', 'data-confirmed-value': 'renamed.png',
    });
    page.form.appendChild(filename);
    enhanceAppDialogs(page.document);
    enhanceAssetEditDialog(page.document);

    openAppDialogById(page.document, page.dialog.id, page.trigger);
    filename.value = 'another-draft.png';
    closeAppDialogById(page.document, page.dialog.id);
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(filename.value).toBe('renamed.png');
  });
  it('restores a New dialog draft after accepted close and reopen', () => {
    const page = makeDialogPage();
    const title = makeElement('input', { name: 'title', value: '' });
    page.form.appendChild(title);
    markOrdinaryDialogForm(page);
    enhanceAppDialogs(page.document);

    openAppDialogById(page.document, page.dialog.id, page.trigger);
    title.value = 'Abandoned';
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(title.value).toBe('');
    expect(page.form.reset).toHaveBeenCalledOnce();
  });

  it('discards a rejected New Project rerender only after accepted dismissal', () => {
    const page = makeDialogPage();
    const title = makeElement('input', { name: 'title', value: 'Rejected project' });
    const link = makeElement('input', { name: 'patreonUrl', value: 'invalid-link' });
    page.form.appendChild(title);
    page.form.appendChild(link);
    markOrdinaryDialogForm(page);
    page.form.setAttribute('data-dialog-reset-values', JSON.stringify({ title: '', patreonUrl: '' }));
    enhanceAppDialogs(page.document);

    expect(title.value).toBe('Rejected project');
    expect(link.value).toBe('invalid-link');
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(title.value).toBe('');
    expect(link.value).toBe('');
  });

  it('discards a rejected publication date after accepted dismissal', () => {
    const page = makeDialogPage();
    const date = makeElement('input', { type: 'date', name: 'publishedDate', value: '2026-10-03' });
    page.form.appendChild(date);
    markOrdinaryDialogForm(page);
    page.form.setAttribute('data-dialog-reset-values', JSON.stringify({ publishedDate: '2026-09-24' }));
    enhanceAppDialogs(page.document);

    expect(date.value).toBe('2026-10-03');
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(date.value).toBe('2026-09-24');
  });

  it('resets a rejected Update project status choice to Keep current status after dismissal', () => {
    const page = makeDialogPage();
    const field = makeElement('div');
    const dropdown = addStandardDropdown(field, null, 'projectStatus', [
      { value: '', label: 'Keep current status' },
      { value: 'ready', label: 'Ready' },
    ], 'ready');
    const radios = dropdown.panel.querySelectorAll('input[type="radio"]');
    radios.forEach((radio) => radio.setAttribute('name', 'projectStatus'));
    dropdown.summary.querySelector('[data-cc-dropdown-summary-current]').textContent = 'Ready';
    page.form.appendChild(field);
    markOrdinaryDialogForm(page);
    page.form.setAttribute('data-dialog-reset-values', JSON.stringify({ projectStatus: '' }));
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);

    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(dropdown.summary.querySelector('[data-cc-dropdown-summary-current]').textContent)
      .toBe('Keep current status');
  });

  it('restores persisted Edit values after a rejected rerender', () => {
    const page = makeDialogPage();
    const title = makeElement('input', { name: 'title', value: 'Rejected edit' });
    page.form.appendChild(title);
    markOrdinaryDialogForm(page);
    page.form.setAttribute('data-dialog-reset-values', JSON.stringify({ title: 'Persisted title' }));
    enhanceAppDialogs(page.document);

    expect(title.value).toBe('Rejected edit');
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(title.value).toBe('Persisted title');
  });

  it('restores an Edit dialog and its custom dropdown to confirmed values', () => {
    const page = makeDialogPage({ standardDropdowns: true });
    const title = makeElement('input', { name: 'title', value: 'Confirmed' });
    page.form.appendChild(title);
    markOrdinaryDialogForm(page);
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);

    openAppDialogById(page.document, page.dialog.id, page.trigger);
    title.value = 'Abandoned';
    const radios = page.dropdowns.view.panel.querySelectorAll('input[type="radio"]');
    radios[1].checked = true;
    page.document.dispatch('change', { target: radios[1] });
    expect(page.fields.view.value).toBe('list');
    page.dialog.dispatch('cancel', { target: page.dialog });
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(title.value).toBe('Confirmed');
    expect(page.fields.view.value).toBe('grid');
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(page.dropdowns.view.summary.querySelector('[data-cc-dropdown-summary-current]').textContent).toBe('grid');
  });

  it('keeps an ordinary draft intact when an async close guard rejects dismissal', async () => {
    const page = makeDialogPage();
    const title = makeElement('input', { name: 'title', value: 'Confirmed' });
    page.form.appendChild(title);
    markOrdinaryDialogForm(page);
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    title.value = 'Draft';
    page.dialog.__creatorCrateAppDialogState.beforeClose = () => Promise.resolve(false);

    page.close.dispatch('click');
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(title.value).toBe('Draft');
    expect(page.form.reset).not.toHaveBeenCalled();
  });

  it('captures the exact live list URL in a hosted create form', () => {
    const page = makeDialogPage();
    const dialogId = 'project-create-dialog';
    const href = '/projects/new';
    const invocationLocation = '/projects?search=needle&sort=title&order=asc&page=3#projects-list';
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
  });

  it('returns a hosted dialog to its validated invocation location', () => {
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
    page.close.dispatch('click');

    expect(page.dialog.open).toBe(false);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('/projects/7/assets?view=list&page=3#asset-42');
  });

  it('returns a hosted dialog without navigating to a protocol-relative location', () => {
    const page = makeDialogPage();
    page.form.appendChild(makeElement('input', {
      type: 'hidden',
      name: 'returnTo',
      value: '//attacker.example/path',
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
    page.close.dispatch('click');

    expect(page.dialog.open).toBe(false);
    expect(assign).not.toHaveBeenCalled();
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

  describe('WP11A-F1 — return vetoes (vetoAppDialogReturn)', () => {
    function vetoPage() {
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
      return { page, assign };
    }

    it('a vetoed dismissal closes the dialog but stays on the page; the veto is read at every dismissal', () => {
      const { page, assign } = vetoPage();
      const held = { value: true };
      expect(vetoAppDialogReturn(page.document, page.dialog.id, () => held.value)).toBe(true);

      for (let round = 0; round < 3; round += 1) {
        openAppDialogById(page.document, page.dialog.id, page.trigger);
        page.close.dispatch('click');
        expect(page.dialog.open).toBe(false);
      }
      expect(assign).not.toHaveBeenCalled();

      // Once the predicate no longer holds, the established return is back.
      held.value = false;
      openAppDialogById(page.document, page.dialog.id, page.trigger);
      page.close.dispatch('click');
      expect(assign).toHaveBeenCalledOnce();
      expect(assign).toHaveBeenCalledWith('/projects/7/assets?view=list');
    });

    it('vetoes are independent: one that releases cannot lift another, and a throwing veto vetoes', () => {
      const { page, assign } = vetoPage();
      const archive = { held: true };
      const remove = { held: true };
      const archiveVeto = () => archive.held;
      vetoAppDialogReturn(page.document, page.dialog.id, archiveVeto);
      vetoAppDialogReturn(page.document, page.dialog.id, archiveVeto);
      vetoAppDialogReturn(page.document, page.dialog.id, () => remove.held);
      expect(page.dialog.__creatorCrateAppDialogState.returnVetoes.size).toBe(2);

      archive.held = false;
      openAppDialogById(page.document, page.dialog.id, page.trigger);
      page.close.dispatch('click');
      expect(assign).not.toHaveBeenCalled();

      remove.held = false;
      vetoAppDialogReturn(page.document, page.dialog.id, () => { throw new Error('unreadable'); });
      openAppDialogById(page.document, page.dialog.id, page.trigger);
      page.close.dispatch('click');
      expect(page.dialog.open).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    });

    it('a dialog without vetoes, or an unknown dialog id, keeps the established return', () => {
      const { page, assign } = vetoPage();
      expect(vetoAppDialogReturn(page.document, 'no-such-dialog', () => true)).toBe(false);
      expect(vetoAppDialogReturn(page.document, page.dialog.id, null)).toBe(false);
      openAppDialogById(page.document, page.dialog.id, page.trigger);
      page.close.dispatch('click');
      expect(assign).toHaveBeenCalledOnce();
    });
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

  it.each(['X', 'Escape', 'native cancel', 'backdrop', 'programmatic'])(
    '%s dismisses once, restores its live opener, and preserves body lock state',
    (path) => {
      const page = makeDialogPage();
      markOrdinaryDialogForm(page);
      page.region.appendChild(page.trigger);
      const submit = vi.fn();
      page.form.addEventListener('submit', submit);

      expect(enhanceAppDialogs(page.document)).toBe(1);
      expect(enhanceAppDialogs(page.document)).toBe(1);
      const onClose = vi.fn();
      page.dialog.__creatorCrateAppDialogState.onClose = onClose;
      const opener = path === 'Escape'
        ? makeElement('a', {
          href: '/projects?defaults=1',
          'data-dialog-open': 'projects-defaults-dialog',
        })
        : page.trigger;
      if (opener !== page.trigger) page.trigger.replaceWith(opener);

      const openEvent = page.document.dispatch('click', { target: opener });
      expect(openEvent.defaultPrevented).toBe(true);
      expect(page.dialog.open).toBe(true);
      expect(page.close.focused).toBe(true);
      expect(page.document.body.classList.contains('app-dialog-open')).toBe(true);
      page.fields.view.value = 'list';

      if (path === 'X') page.close.dispatch('click');
      else if (path === 'Escape') page.dialog.dispatch('keydown', { key: 'Escape', target: page.dialog });
      else if (path === 'native cancel') page.dialog.dispatch('cancel', { target: page.dialog });
      else if (path === 'backdrop') {
        page.dialog.dispatch('click', { target: page.form });
        expect(page.dialog.open).toBe(true);
        page.dialog.dispatch('pointerdown', { target: page.dialog, pointerId: 1 });
        page.document.dispatch('pointerup', { target: page.dialog, pointerId: 1 });
        page.dialog.dispatch('click', { target: page.dialog });
      } else closeAppDialogById(page.document, page.dialog.id);

      expect(page.dialog.close).toHaveBeenCalledOnce();
      expect(page.dialog.open).toBe(false);
      expect(page.document.activeElement).toBe(opener);
      expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
      expect(onClose).toHaveBeenCalledOnce();
      expect(page.form.reset).toHaveBeenCalledOnce();
      expect(page.fields.view.value).toBe('grid');
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('keeps text-selection drags open and accepts the next genuine backdrop gesture', () => {
    const page = makeDialogPage();
    const input = makeElement('input', { name: 'title', value: 'Existing project title' });
    page.form.appendChild(input);
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    const beforeClose = vi.fn(() => true);
    page.dialog.__creatorCrateAppDialogState.beforeClose = beforeClose;

    page.dialog.dispatch('pointerdown', { target: input, pointerId: 1 });
    page.document.dispatch('pointerup', { target: page.dialog, pointerId: 1 });
    page.dialog.dispatch('click', { target: page.dialog });

    expect(page.dialog.open).toBe(true);
    expect(beforeClose).not.toHaveBeenCalled();

    page.dialog.dispatch('pointerdown', { target: page.dialog, pointerId: 2 });
    page.document.dispatch('pointerup', { target: page.dialog, pointerId: 2 });
    page.dialog.dispatch('click', { target: page.dialog });

    expect(beforeClose).toHaveBeenCalledOnce();
    expect(page.dialog.close).toHaveBeenCalledOnce();
    expect(page.dialog.open).toBe(false);
  });

  it('keeps the dialog open when a backdrop press ends inside its content', () => {
    const page = makeDialogPage();
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    const beforeClose = vi.fn(() => true);
    page.dialog.__creatorCrateAppDialogState.beforeClose = beforeClose;

    page.dialog.dispatch('pointerdown', { target: page.dialog, pointerId: 1 });
    page.document.dispatch('pointerup', { target: page.form, pointerId: 1 });
    page.dialog.dispatch('click', { target: page.dialog });

    expect(page.dialog.open).toBe(true);
    expect(beforeClose).not.toHaveBeenCalled();
  });

  it('does not use a canceled backdrop press for a later click', () => {
    const page = makeDialogPage();
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    const beforeClose = vi.fn(() => true);
    page.dialog.__creatorCrateAppDialogState.beforeClose = beforeClose;

    page.dialog.dispatch('pointerdown', { target: page.dialog, pointerId: 1 });
    page.document.dispatch('pointercancel', { target: page.dialog, pointerId: 1 });
    page.dialog.dispatch('click', { target: page.dialog });

    expect(page.dialog.open).toBe(true);
    expect(beforeClose).not.toHaveBeenCalled();
  });

  it('uses one async pre-close guard and suppresses native cancellation until dismissal is allowed', async () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    const onClose = vi.fn();
    page.dialog.__creatorCrateAppDialogState.onClose = onClose;
    let resolveGuard;
    const beforeClose = vi.fn(() => new Promise(resolve => { resolveGuard = resolve; }));
    page.dialog.__creatorCrateAppDialogState.beforeClose = beforeClose;

    const cancelEvent = page.dialog.dispatch('cancel', { target: page.dialog });

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(beforeClose).toHaveBeenCalledOnce();
    expect(page.dialog.open).toBe(true);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(page.dialog.close).not.toHaveBeenCalled();
    await flush();
    expect(page.dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    resolveGuard(true);
    await flush();
    expect(page.dialog.close).toHaveBeenCalledOnce();
    expect(page.dialog.open).toBe(false);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
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

    expect(closeAppDialogById(page.document, page.dialog.id)).toBe(true);
    expect(page.document.activeElement).toBe(explicitOpener);
  });

  it('traps forward and reverse Tab movement at the dialog boundaries', () => {
    const page = makeDialogPage();
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id);

    page.save.focus();
    const forward = page.dialog.dispatch('keydown', { key: 'Tab', target: page.save });
    expect(forward.defaultPrevented).toBe(true);
    expect(page.document.activeElement).toBe(page.close);

    page.close.focus();
    const reverse = page.dialog.dispatch('keydown', {
      key: 'Tab',
      shiftKey: true,
      target: page.close,
    });
    expect(reverse.defaultPrevented).toBe(true);
    expect(page.document.activeElement).toBe(page.save);
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
    page.dialog.dispatch('pointerdown', { target: page.dialog, pointerId: 1 });
    page.document.dispatch('pointerup', { target: page.dialog, pointerId: 1 });
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
        global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', gridDetails: 'shown', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
        project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', gridDetails: 'hidden', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
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
      view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc',
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

  it('keeps separate unsaved drafts for Global and Project only', () => {
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

  it('fails closed for malformed or unrepresentable Project Assets scope values', () => {
    const malformed = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true });
    malformed.form.querySelector('script[type="application/json"][data-project-assets-default-values]').textContent = '{';
    const malformedInitial = projectAssetsDefaultValues(malformed.fields);
    expect(enhanceProjectAssetsDefaultsScope(malformed.document)).toBe(0);
    changeProjectAssetsScope(malformed, 'project');
    expect(projectAssetsDefaultValues(malformed.fields)).toEqual(malformedInitial);
    expect(malformed.form.querySelector('input[name="loadedScope"]').value).toBe('global');

    const values = {
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'gif', tag: '2' },
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
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.fields.view.value = 'list';
    page.fields.sort.value = 'title';
    page.fields.order.value = 'asc';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch.mock.calls[0][0]).toBe('/projects/defaults');
    expect(page.windowObject.fetch.mock.calls[0][1].method).toBe('POST');
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

  it('reopens from the latest confirmed async save after a later abandoned edit', async () => {
    const page = makeDialogPage();
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        values: { view: 'list', sort: 'title', order: 'asc' },
      }),
    });
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    page.fields.view.value = 'list';
    page.fields.sort.value = 'title';
    page.fields.order.value = 'asc';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    openAppDialogById(page.document, page.dialog.id, page.trigger);
    expect(page.fields.view.value).toBe('list');
    page.fields.view.value = 'grid';
    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);

    expect(page.fields.view.value).toBe('list');
    expect(page.fields.sort.value).toBe('title');
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

  it('cleans an open scrollable dropdown when its dialog closes', () => {
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

    expect(viewDropdown.open).toBe(true);
    expect(panel.getAttribute('data-cc-dropdown-overlay')).toBe('');
    expect(panel.style.getPropertyValue('position')).toBe('fixed');
    expect(body.listeners.filter(({ type }) => type === 'scroll')).toHaveLength(1);

    page.close.dispatch('click');
    expect(page.dialog.open).toBe(false);
    expect(viewDropdown.open).toBe(false);
    expect(panel.getAttribute('data-cc-dropdown-overlay')).toBeNull();
    expect(panel.style.getPropertyValue('position')).toBe('');
    expect(body.listeners.filter(({ type }) => type === 'scroll')).toHaveLength(0);
    expect(page.windowObject.removeEventListener).toHaveBeenCalled();
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

  it.each([
    [
      'default',
      null,
      'Saving defaults.',
      'Could not save defaults. Check your connection and try again.',
      'Projects defaults could not be saved. Your selections were kept.',
    ],
    [
      'configured',
      {
        'data-dialog-pending-message': 'Clearing logs…',
        'data-dialog-error-message': 'Logs could not be cleared.',
        'data-dialog-network-error-message': 'Could not clear logs.',
      },
      'Clearing logs…',
      'Could not clear logs.',
      'Logs could not be cleared. Your selections were kept.',
    ],
  ])('keeps the dialog open and reports network failures with %s messages', async (
    _label,
    dialogMessages,
    pendingMessage,
    networkMessage,
    errorMessage,
  ) => {
    const page = makeDialogPage({ dialogMessages });
    page.region.appendChild(page.trigger);
    let rejectRequest;
    page.windowObject.fetch.mockImplementation(() => new Promise((resolve, reject) => {
      rejectRequest = reject;
    }));
    enhanceAppDialogs(page.document);
    const successHook = vi.fn();
    page.dialog.__creatorCrateAppDialogState.onSuccessfulSubmit = successHook;
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe(pendingMessage);
    rejectRequest(new Error('network down'));
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe(networkMessage);
    expect(page.dialog.querySelector('[data-dialog-error-text]').textContent).toBe(errorMessage);
    expect(successHook).not.toHaveBeenCalled();
  });

  it('announces a confirmed Manage Categories default change without closing the dialog', async () => {
    const page = makeDialogPage({ standardDropdowns: true, liveDefault: true });
    page.dialog.setAttribute('id', 'project-asset-category-management-dialog');
    page.trigger.setAttribute('data-dialog-open', 'project-asset-category-management-dialog');
    page.region.appendChild(page.trigger);
    const changed = vi.fn();
    page.document.addEventListener('project-asset-categories-changed', changed);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', values: { defaultCategory: 'category:1' } }),
    });
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    page.dropdowns.defaultCategory.panel.querySelectorAll('input[type="radio"]')[2].checked = true;
    page.document.dispatch('change', { target: page.dropdowns.defaultCategory.panel.querySelectorAll('input[type="radio"]')[2] });
    await flush();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(page.dialog.open).toBe(true);
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
      expect(enhanceProjectAssetsAutosavePage(page)).toBe(9);
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
        gridStyle: 'cropped',
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
        {
          onError: expect.any(Function),
          acknowledgedControls: new Set(['view']),
          form: page.form,
          acknowledgementFailed: false,
        },
      );
      expect(page.dialog.open).toBe(true);
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a Grid style-only change only from the acknowledged effective values', async () => {
    const values = {
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
    };
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: values,
      projectAssetsDefaultsAutosave: true,
    });
    setProjectAssetsDefaultValues(page.fields, values.global);
    let acknowledged = { ...values, global: { ...values.global, gridStyle: 'cropped' } };
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({
      url: 'http://creatorcrate.test/projects/1/assets?notice=project_assets_defaults_saved',
      html: acknowledged ? projectAssetsDefaultsHtml(acknowledged, 'global') : '<p>unreadable</p>',
    })));
    installFetchGlobals(page, fetch);
    const seen = [];
    const refresh = vi.fn((_document, _destination, _generation, options) => {
      seen.push({
        gridStyle: projectAssetsDefaultsGridStyleOnlyChange(options.form),
        acknowledgementFailed: options.acknowledgementFailed,
      });
      markProjectAssetsDefaultsRendered(options.form);
      return 'applied';
    });
    const save = async (name, value) => {
      page.fields[name].value = value;
      page.fields[name].dispatch('change');
      await flush();
      await flush();
    };

    try {
      enhanceProjectAssetsAutosavePage(page, { refresh });
      page.document.dispatch('click', { target: page.trigger });
      await flush();

      // The server-confirmed style, not the submitted one, is reported.
      await save('gridStyle', 'cropped');
      // Once rendered, a same-style acknowledgement is no longer a style change.
      expect(projectAssetsDefaultsGridStyleOnlyChange(page.form)).toBeNull();
      // Any other changed effective default keeps the full refresh.
      acknowledged = { ...values, global: { ...values.global, gridStyle: 'uncropped', sort: 'modified' } };
      await save('gridStyle', 'uncropped');
      // An unreadable acknowledgement never restyles in place.
      acknowledged = null;
      await save('gridStyle', 'cropped');

      expect(seen).toEqual([
        { gridStyle: 'cropped', acknowledgementFailed: false },
        { gridStyle: null, acknowledgementFailed: false },
        { gridStyle: null, acknowledgementFailed: true },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('saves a Global scope switch once after hydrating its complete paired snapshot', async () => {
    const values = {
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
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
        gridStyle: 'uncropped',
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
        {
          onError: expect.any(Function),
          acknowledgedControls: new Set(['view', 'sort']),
          form: page.form,
          acknowledgementFailed: false,
        },
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
        page.document, destination, 17,
        {
          onError: expect.any(Function),
          acknowledgedControls: new Set(['view']),
          form: page.form,
          acknowledgementFailed: false,
        },
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
    const shared = { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' };
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

  it('reconciles a Project-only acknowledgement from both authoritative server snapshots', async () => {
    const values = {
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'compact', listSize: 'large', sort: 'filename', order: 'desc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'modified', order: 'asc', pageSize: '50', extension: 'png', tag: '2' },
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
      global: { ...initial.global, gridSize: 'compact', listSize: 'compact' },
      project: { ...initial.project },
    };
    const finalAuthoritative = {
      global: { ...initial.global, gridSize: 'large', listSize: 'large' },
      project: { ...initial.project },
    };
    const fetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const storage = new Map([
      ['creatorcrate-asset-grid-size', 'default'],
      ['creatorcrate-asset-list-size', 'default'],
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
      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent))
        .toEqual(firstAuthoritative);
      expect(page.fields.gridSize.value).toBe('large');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('default');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('default');

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
        {
          onError: expect.any(Function),
          acknowledgedControls: new Set(['gridSize']),
          form: page.form,
          acknowledgementFailed: false,
        },
      );
      expect(storage.get('creatorcrate-asset-grid-size')).toBe(finalAuthoritative.global.gridSize);
      expect(storage.get('creatorcrate-asset-list-size')).toBe(finalAuthoritative.global.listSize);
      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent))
        .toEqual(finalAuthoritative);
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.fields.gridSize.value).toBe('large');
      expect(page.fields.listSize.value).toBe('large');
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
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'gif', tag: '2' },
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
    const storage = new Map([
      ['creatorcrate-asset-grid-size', 'compact'],
      ['creatorcrate-asset-list-size', 'compact'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
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
      expect(refresh).not.toHaveBeenCalled();
      expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(storage).toEqual(new Map([
        ['creatorcrate-asset-grid-size', 'compact'],
        ['creatorcrate-asset-list-size', 'compact'],
      ]));

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

  it.each(['invalid scope', 'missing snapshot'])('keeps committed scopes intact for %s response authority', async (failure) => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const html = {
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
      expect(fetch.mock.calls[0][0]).toBe('/projects/defaults');
      expect(page.fields.view.value).toBe('list');
      expect(Object.fromEntries(fetch.mock.calls[0][1].body.entries())).toMatchObject({
        view: 'list', sort: 'created', order: 'desc', status: 'all', projectType: 'all', tag: 'all',
      });

      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');
      page.fields.order.value = 'asc';
      page.fields.order.dispatch('change');
      expect(fetch).toHaveBeenCalledTimes(1);

      page.fields.status.value = 'ready';
      page.fields.status.dispatch('input');

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
      expect(page.fields.status.value).toBe('ready');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('dismissal does not cancel a pending save or restore stale values on reopen', async () => {
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

      page.close.dispatch('click');
      expect(page.dialog.open).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][1]).not.toHaveProperty('signal');

      pending.resolve(response());
      await flush();
      expect(page.status.textContent).toBe('Settings saved.');
      expect(page.fields.view.value).toBe('list');

      page.document.dispatch('click', { target: page.trigger });
      expect(page.dialog.open).toBe(true);
      expect(page.fields.view.value).toBe('list');
      expect(fetch).toHaveBeenCalledOnce();
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
      page.document.dispatch('click', { target: page.trigger });
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
      expect(page.dialog.open).toBe(true);
      expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');

      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');
      await flush();
      expect(page.fields.sort.value).toBe('title');
      expect(page.status.textContent).toBe('Settings saved.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
      expect(renderedError.hidden).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
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
    let mountedFormsAtRefresh = [];
    const mountedValuesAtRefresh = [];
    const refresh = vi.fn((currentDocument, _url, _authority, { onError }) => {
      mountedFormsAtRefresh = currentDocument.querySelectorAll('#projects-defaults-form');
      const mountedForm = mountedFormsAtRefresh[0];
      mountedValuesAtRefresh.push({
        view: mountedForm?.querySelector('[name="view"]')?.value,
        sort: mountedForm?.querySelector('[name="sort"]')?.value,
        order: mountedForm?.querySelector('[name="order"]')?.value,
      });
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
      second.resolve(response({
        url: successUrl,
        html: `
          <div data-projects-live-region>
            <dialog id="projects-defaults-dialog" open>
              <form id="projects-defaults-form" action="/projects/defaults" method="post" data-projects-defaults-autosave>
                <select id="projects-default-view" name="view"><option value="grid" selected>Grid</option></select>
                <select id="projects-default-sort" name="sort"><option value="updated" selected>Updated</option></select>
                <select id="projects-default-order" name="order"><option value="asc" selected>Ascending</option></select>
              </form>
            </dialog>
          </div>
        `,
      }));
      await flush();

      expect(beginRefresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith(page.document, successUrl, 7, {
        onError: expect.any(Function),
        acknowledgedControls: new Set(['view', 'sort']),
        form: page.form,
        acknowledgementFailed: false,
      });
      expect(mountedFormsAtRefresh).toHaveLength(1);
      expect(mountedFormsAtRefresh[0]).toBe(page.form);
      expect(mountedValuesAtRefresh).toEqual([{ view: 'list', sort: 'title', order: 'desc' }]);
      expect(page.dialog.open).toBe(true);
      expect(page.fields.view.value).toBe('list');
      expect(page.fields.sort.value).toBe('title');
      expect(page.status.textContent).toBe('Settings saved, but Projects could not refresh. Refresh the page to see the saved defaults.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');
      page.close.dispatch('click');
      page.document.dispatch('click', { target: page.trigger });
      expect(page.fields.view.value).toBe('list');
      expect(page.fields.sort.value).toBe('title');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the default Releases refresh path once and reports its refresh failure', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    page.form.setAttribute('id', 'releases-defaults-form');
    page.form.setAttribute('action', '/releases/defaults');
    page.form.removeAttribute('data-projects-defaults-autosave');
    page.form.setAttribute('data-releases-defaults-autosave', '');
    Object.entries(page.fields).forEach(([name, field]) => {
      if (name !== 'sort' && name !== 'order') field.removeAttribute('data-autosubmit');
    });
    page.region.removeAttribute('data-projects-live-region');
    page.region.setAttribute('data-releases-live-region', '');
    page.region.appendChild(makeElement('div', { 'data-releases-live-status': '' }));
    const refreshedRegion = makeElement('div', { 'data-releases-live-region': '' });
    const refreshedStatus = makeElement('div', { 'data-releases-live-status': '' });
    refreshedRegion.appendChild(refreshedStatus);
    page.windowObject.location = {
      href: 'http://creatorcrate.test/releases?sort=created&order=desc',
      assign: vi.fn(),
    };
    page.windowObject.history = {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    };
    page.windowObject.DOMParser = class DOMParserMock {
      parseFromString(html) {
        return {
          querySelector: (selector) => {
            if (selector === '[data-releases-live-region]' && html === 'releases-refresh-success') {
              return refreshedRegion;
            }
            return null;
          },
        };
      }
    };
    const firstSuccessUrl = 'http://creatorcrate.test/releases?sort=title&order=desc&notice=releases_defaults_saved';
    const secondSuccessUrl = 'http://creatorcrate.test/releases?sort=title&order=asc&notice=releases_defaults_saved';
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ url: firstSuccessUrl }))
      .mockResolvedValueOnce(response({
        redirected: false,
        url: 'http://creatorcrate.test/releases?sort=title&order=desc',
        html: 'releases-refresh-success',
      }))
      .mockResolvedValueOnce(response({ url: secondSuccessUrl }))
      .mockRejectedValueOnce(new Error('offline'));
    page.windowObject.fetch = fetch;
    installFetchGlobals(page, fetch);

    try {
      page.region.appendChild(page.trigger);
      enhanceDropdowns(page.document);
      enhanceAppDialogs(page.document);
      enhanceReleasesLiveFiltering(page.document);
      expect(enhanceReleasesDefaultsFetchSave(page.document)).toBe(2);
      expect(enhanceReleasesDefaultsFetchSave(page.document)).toBe(0);

      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');
      await flush();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(1, '/releases/defaults', expect.objectContaining({
        method: 'POST',
        redirect: 'follow',
      }));
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        firstSuccessUrl,
        expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
      );
      expect(page.document.querySelector('[data-releases-live-region]')).toBe(refreshedRegion);

      page.fields.order.value = 'asc';
      page.fields.order.dispatch('change');
      await flush();

      expect(fetch).toHaveBeenCalledTimes(4);
      expect(fetch).toHaveBeenNthCalledWith(3, '/releases/defaults', expect.objectContaining({ method: 'POST' }));
      expect(fetch).toHaveBeenNthCalledWith(4, secondSuccessUrl, expect.objectContaining({ method: 'GET' }));
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');
      expect(page.status.textContent).toBe('Settings saved, but Releases could not refresh. Refresh the page to see the saved defaults.');
      expect(refreshedRegion.getAttribute('data-releases-live-state')).toBe('error');
      expect(refreshedStatus.textContent).toBe(
        'Defaults were saved, but Releases could not refresh. Refresh the page to see the saved defaults.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('WP4 explicit save transport', () => {
    function makeExplicitProjectAssetsPage({ explicit = true } = {}) {
      // Editing selects keep `data-autosubmit="fetch"` to prove explicit mode
      // binds only the save control, not every fetch-marked control.
      const page = makeDialogPage({
        standardDropdowns: true,
        projectAssetsDefaults: true,
        projectAssetsScope: true,
        projectAssetsDefaultsAutosave: true,
      });
      if (explicit) page.form.setAttribute(DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE, '');
      const intent = makeElement('input', {
        type: 'hidden', name: 'intent', value: 'save', 'data-autosubmit': 'fetch',
      });
      intent.form = page.form;
      page.form.appendChild(intent);
      return page;
    }

    function postBody(fetch, index) {
      return Object.fromEntries(fetch.mock.calls[index][1].body.entries());
    }

    function deferred() {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      return { promise, resolve };
    }

    // WP6: a scope change in explicit mode is an activation (covered below), so
    // this keeps proving that editing controls never writes.
    it('posts nothing on control changes and sends one intent=save write per Save action', async () => {
      const page = makeExplicitProjectAssetsPage();
      const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
      const pending = deferred();
      const fetch = vi.fn().mockReturnValueOnce(pending.promise);
      installFetchGlobals(page, fetch);

      try {
        expect(enhanceProjectAssetsAutosavePage(page)).toBe(1);
        expect(enhanceProjectAssetsDefaultsFetchSave(page.document, page.projectAssetsDefaultsRefreshOptions)).toBe(0);
        page.document.dispatch('click', { target: page.trigger });
        await flush();

        page.fields.sort.value = 'modified';
        page.fields.sort.dispatch('change');
        page.fields.sort.value = 'size';
        page.fields.sort.dispatch('change');
        await flush();
        expect(fetch).not.toHaveBeenCalled();
        expect(page.projectAssetsDefaultsRefreshOptions.beginRefresh).not.toHaveBeenCalled();

        const first = page.form.dispatch('submit');
        const repeat = page.form.dispatch('submit');
        await flush();

        expect(first.defaultPrevented).toBe(true);
        expect(repeat.defaultPrevented).toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe(page.form.action);
        expect(String(fetch.mock.calls[0][0])).not.toMatch(/\/reset$/);
        expect(postBody(fetch, 0)).toEqual({
          _csrf: 'csrf-token',
          scope: 'global',
          loadedScope: 'global',
          ...initial.global,
          sort: 'size',
          intent: 'save',
        });
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('pending');

        pending.resolve(response({
          url: 'http://creatorcrate.test/projects/1/assets?sort=size&notice=project_assets_defaults_saved',
          html: projectAssetsDefaultsHtml({ global: { ...initial.global, sort: 'size' }, project: initial.project }),
        }));
        await flush();

        expect(fetch).toHaveBeenCalledOnce();
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledOnce();
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
        expect(page.dialog.open).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('keeps values through validation and network failures without claiming success or retrying', async () => {
      const page = makeExplicitProjectAssetsPage();
      const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
      const fetch = vi.fn()
        .mockResolvedValueOnce(response({ ok: false, redirected: false, html: '<p>Invalid sort.</p>' }))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(response({
          url: 'http://creatorcrate.test/projects/1/assets?notice=project_assets_defaults_saved',
          html: projectAssetsDefaultsHtml({ global: { ...initial.global, sort: 'modified' }, project: initial.project }),
        }));
      installFetchGlobals(page, fetch);

      try {
        enhanceProjectAssetsAutosavePage(page);
        page.document.dispatch('click', { target: page.trigger });
        await flush();
        page.fields.sort.value = 'modified';
        page.fields.sort.dispatch('change');

        page.form.dispatch('submit');
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(page.fields.sort.value).toBe('modified');
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');
        expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).not.toHaveBeenCalled();

        page.form.dispatch('submit');
        await flush();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(page.fields.sort.value).toBe('modified');
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).not.toHaveBeenCalled();

        page.form.dispatch('submit');
        await flush();
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(postBody(fetch, 2)).toMatchObject({ intent: 'save', sort: 'modified' });
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('sends a newer Save after the older one acknowledges without overwriting newer controls', async () => {
      const page = makeExplicitProjectAssetsPage();
      const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
      const older = deferred();
      const newer = deferred();
      const fetch = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      installFetchGlobals(page, fetch);

      try {
        enhanceProjectAssetsAutosavePage(page);
        page.document.dispatch('click', { target: page.trigger });
        await flush();
        page.fields.sort.value = 'modified';
        page.form.dispatch('submit');
        await flush();
        page.fields.sort.value = 'size';
        page.fields.sort.dispatch('change');
        page.form.dispatch('submit');
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);

        older.resolve(response({
          url: 'http://creatorcrate.test/projects/1/assets?sort=modified&notice=project_assets_defaults_saved',
          html: projectAssetsDefaultsHtml({ global: { ...initial.global, sort: 'modified' }, project: initial.project }),
        }));
        await flush();
        expect(page.fields.sort.value).toBe('size');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(postBody(fetch, 1)).toMatchObject({ intent: 'save', sort: 'size' });
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).not.toHaveBeenCalled();

        newer.resolve(response({
          url: 'http://creatorcrate.test/projects/1/assets?sort=size&notice=project_assets_defaults_saved',
          html: projectAssetsDefaultsHtml({ global: { ...initial.global, sort: 'size' }, project: initial.project }),
        }));
        await flush();
        expect(page.fields.sort.value).toBe('size');
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledOnce();
        expect(page.projectAssetsDefaultsRefreshOptions.refresh.mock.calls[0][1]).toContain('sort=size');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('drops a duplicate button or keyboard Save while pending without a native POST or false success', async () => {
      const page = makeExplicitProjectAssetsPage();
      const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
      const pending = deferred();
      const fetch = vi.fn().mockReturnValueOnce(pending.promise);
      installFetchGlobals(page, fetch);

      try {
        enhanceProjectAssetsAutosavePage(page);
        page.document.dispatch('click', { target: page.trigger });
        await flush();
        page.fields.sort.value = 'modified';

        const first = page.form.dispatch('submit', { submitter: page.save });
        await flush();
        // A repeat click and an Enter-key implicit submission (no submitter)
        // carry the identical in-flight payload.
        const repeatClick = page.form.dispatch('submit', { submitter: page.save });
        const repeatKeyboard = page.form.dispatch('submit', { submitter: null });
        await flush();

        expect([first, repeatClick, repeatKeyboard].map((event) => event.defaultPrevented))
          .toEqual([true, true, true]);
        expect(fetch).toHaveBeenCalledOnce();
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('pending');
        expect(page.form.getAttribute('aria-busy')).toBe('true');
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).not.toHaveBeenCalled();
        expect(page.dialog.open).toBe(true);

        pending.resolve(response({
          url: 'http://creatorcrate.test/projects/1/assets?sort=modified&notice=project_assets_defaults_saved',
          html: projectAssetsDefaultsHtml({ global: { ...initial.global, sort: 'modified' }, project: initial.project }),
        }));
        await flush();
        expect(fetch).toHaveBeenCalledOnce();
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      ['the save control is missing', (page) => page.form.querySelector('input[name="intent"]').remove()],
      ['fetch is unavailable so the save control never binds', () => vi.stubGlobal('fetch', undefined)],
    ])('blocks the native POST and reports an error when %s', async (_label, breakBinding) => {
      const page = makeExplicitProjectAssetsPage();
      const fetch = vi.fn();
      installFetchGlobals(page, fetch);

      try {
        breakBinding(page);
        enhanceProjectAssetsAutosavePage(page);
        page.document.dispatch('click', { target: page.trigger });
        await flush();

        const click = page.form.dispatch('submit', { submitter: page.save });
        const keyboard = page.form.dispatch('submit', { submitter: null });
        await flush();

        expect(click.defaultPrevented).toBe(true);
        expect(keyboard.defaultPrevented).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');
        expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');
        expect(page.projectAssetsDefaultsRefreshOptions.refresh).not.toHaveBeenCalled();
        expect(page.dialog.open).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('leaves a form without the opt-in on change autosave and its submit unintercepted', async () => {
      const page = makeExplicitProjectAssetsPage({ explicit: false });
      page.form.querySelector('input[name="intent"]').remove();
      const fetch = vi.fn().mockResolvedValue(response({
        url: 'http://creatorcrate.test/projects/1/assets?notice=project_assets_defaults_saved',
      }));
      installFetchGlobals(page, fetch);

      try {
        expect(enhanceProjectAssetsAutosavePage(page)).toBe(9);
        page.document.dispatch('click', { target: page.trigger });
        await flush();
        expect(page.form.dispatch('submit').defaultPrevented).toBe(false);
        await flush();
        expect(fetch).not.toHaveBeenCalled();

        page.fields.sort.value = 'modified';
        page.fields.sort.dispatch('change');
        await flush();
        expect(fetch).toHaveBeenCalledOnce();
        expect(postBody(fetch, 0)).not.toHaveProperty('intent');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('WP6 explicit-save scope activation', () => {
    const GLOBAL = { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' };
    const PROJECT = { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' };
    const RETURN_TO = '/projects/1/assets?category=7&search=needle&presence=present&usage=used&page=3';

    function makeActivationPage({ loadedScope = 'global' } = {}) {
      const page = makeDialogPage({
        standardDropdowns: true,
        projectAssetsDefaults: true,
        projectAssetsScope: true,
        projectAssetsDefaultsAutosave: true,
        projectAssetsScopeValues: { global: GLOBAL, project: PROJECT },
        loadedScope,
      });
      page.form.setAttribute(DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE, '');
      const intent = makeElement('input', { type: 'hidden', name: 'intent', value: 'save', 'data-autosubmit': 'fetch' });
      intent.form = page.form;
      page.form.appendChild(intent);
      page.form.appendChild(makeElement('input', { type: 'hidden', name: 'returnTo', value: RETURN_TO }));
      if (loadedScope === 'project') setProjectAssetsDefaultValues(page.fields, PROJECT);
      return page;
    }

    function enhance(page) {
      page.region.appendChild(page.trigger);
      installProjectAssetsResponseParser(page);
      enhanceDropdowns(page.document);
      page.beginActivationRefresh = vi.fn(() => 31);
      page.refreshActivation = vi.fn(() => 'started');
      enhanceProjectAssetsDefaultsScope(page.document, {
        beginRefresh: page.beginActivationRefresh,
        refreshActivation: page.refreshActivation,
      });
      enhanceAppDialogs(page.document);
      page.saveRefresh = vi.fn(() => 'started');
      enhanceProjectAssetsDefaultsFetchSave(page.document, { beginRefresh: vi.fn(() => 17), refresh: page.saveRefresh });
      page.document.dispatch('click', { target: page.trigger });
    }

    function stubStorage() {
      const storage = new Map();
      vi.stubGlobal('localStorage', {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      });
      return storage;
    }

    function json(payload, { ok = true, status = 200 } = {}) {
      return { ok, status, json: async () => payload };
    }

    function acknowledgement(activeScope, values) {
      return json({
        status: 'success',
        activation: { activeScope, previousScope: activeScope === 'project' ? 'global' : 'project', changed: true },
        savedDefaults: {},
        defaults: { scope: activeScope, ...values, effective: values[activeScope] },
      });
    }

    function html(values, activeScope) {
      return { ok: true, status: 200, text: async () => projectAssetsDefaultsHtml(values, activeScope) };
    }

    const body = (fetch, index) => Object.fromEntries(fetch.mock.calls[index][1].body.entries());
    const posts = (fetch) => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    const loadedScope = (page) => page.form.querySelector('input[name="loadedScope"]').value;
    const storedValues = (page) => JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);

    function deferredResult() {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      return { promise, resolve };
    }

    it('activates Project only without saving: pending stays unacknowledged, the acknowledgement loads inherited values once', async () => {
      const page = makeActivationPage();
      const pending = deferredResult();
      const fetch = vi.fn().mockReturnValueOnce(pending.promise);
      const storage = stubStorage();
      installFetchGlobals(page, fetch);

      try {
        enhance(page);
        // An unsaved eligible edit made before switching is replaced, not saved.
        page.fields.sort.value = 'size';
        page.fields.sort.dispatch('change');
        const nativeEvents = vi.fn();
        Object.values(page.fields).forEach((select) => {
          select.addEventListener('change', nativeEvents);
          select.addEventListener('input', nativeEvents);
        });

        changeProjectAssetsScope(page, 'project');
        await flush();

        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe('/projects/1/assets/defaults');
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Accept: 'application/json' } });
        expect(body(fetch, 0)).toEqual({
          _csrf: 'csrf-token', returnTo: RETURN_TO, intent: 'activate-scope', scope: 'project',
        });
        expect(loadedScope(page)).toBe('global');
        expect(page.scopeControls.global.disabled).toBe(true);
        expect(page.scopeControls.project.disabled).toBe(true);
        expect(page.scopeControls.scope.getAttribute('aria-busy')).toBe('true');
        expect(page.status.textContent).toBe('Loading Project-only defaults.');
        expect(storage.size).toBe(0);
        expect(page.beginActivationRefresh).toHaveBeenCalledOnce();
        expect(page.refreshActivation).not.toHaveBeenCalled();

        // A Save while switching is refused visibly, never sent.
        expect(page.form.dispatch('submit').defaultPrevented).toBe(true);
        await flush();
        expect(fetch).toHaveBeenCalledOnce();
        expect(page.status.textContent).toBe('Wait for the defaults scope to finish changing before saving.');
        expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');

        // Missing Project-only overrides come back resolved from Global.
        const project = { ...GLOBAL, view: 'list', sort: 'modified', gridSize: 'large' };
        pending.resolve(acknowledgement('project', { global: GLOBAL, project }));
        await flush();

        expect(loadedScope(page)).toBe('project');
        expect(page.scopeControls.project.checked).toBe(true);
        expect(page.scopeControls.project.disabled).toBe(false);
        expect(page.scopeControls.scope.getAttribute('aria-busy')).toBeNull();
        expect(projectAssetsDefaultValues(page.fields)).toEqual(project);
        expect(storedValues(page)).toEqual({ global: GLOBAL, project });
        expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
        expect(storage.get('creatorcrate-asset-list-size')).toBe(GLOBAL.listSize);
        // Native and visible dropdown state agree, with no synthetic change.
        expect(nativeEvents).not.toHaveBeenCalled();
        const sortChoice = page.dropdowns.sort.panel.querySelectorAll('input').find((input) => input.checked);
        expect(sortChoice.value).toBe('modified');
        expect(page.refreshActivation).toHaveBeenCalledOnce();
        expect(page.refreshActivation).toHaveBeenCalledWith(
          page.document, 31, project, expect.objectContaining({ presentationUnchanged: false }),
        );
        expect(page.status.textContent).toBe('Project-only defaults loaded.');
        expect(posts(fetch)).toHaveLength(1);
        expect(page.saveRefresh).not.toHaveBeenCalled();
        expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('activates Global with dormant Project-only overrides intact and the next Save targets the acknowledged scope', async () => {
      const page = makeActivationPage({ loadedScope: 'project' });
      const fetch = vi.fn()
        .mockResolvedValueOnce(acknowledgement('global', { global: GLOBAL, project: PROJECT }))
        .mockResolvedValueOnce(response({
          url: 'http://creatorcrate.test/projects/1/assets?sort=size&notice=project_assets_defaults_saved',
          html: projectAssetsDefaultsHtml({ global: { ...GLOBAL, sort: 'size' }, project: PROJECT }, 'global'),
        }));
      stubStorage();
      installFetchGlobals(page, fetch);

      try {
        enhance(page);
        changeProjectAssetsScope(page, 'global');
        await flush();

        expect(body(fetch, 0)).toEqual({ _csrf: 'csrf-token', returnTo: RETURN_TO, intent: 'activate-scope', scope: 'global' });
        expect(loadedScope(page)).toBe('global');
        expect(projectAssetsDefaultValues(page.fields)).toEqual(GLOBAL);
        expect(storedValues(page).project).toEqual(PROJECT);

        page.fields.sort.value = 'size';
        page.fields.sort.dispatch('change');
        page.form.dispatch('submit');
        await flush();

        expect(body(fetch, 1)).toEqual({
          _csrf: 'csrf-token', returnTo: RETURN_TO, scope: 'global', loadedScope: 'global',
          ...GLOBAL, sort: 'size', intent: 'save',
        });
        expect(page.saveRefresh).toHaveBeenCalledOnce();
        expect(loadedScope(page)).toBe('global');
        expect(storedValues(page)).toEqual({ global: { ...GLOBAL, sort: 'size' }, project: PROJECT });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      ['a 422 refusal', () => json({ status: 'error', errors: { scope: 'Choose a scope.' } }, { ok: false, status: 422 })],
      ['a 500 that made no change', () => json({ status: 'error', message: 'No changes were made.' }, { ok: false, status: 500 })],
    ])('keeps the acknowledged scope and current controls after %s', async (_label, failure) => {
      const page = makeActivationPage();
      const fetch = vi.fn().mockResolvedValueOnce(failure());
      const storage = stubStorage();
      installFetchGlobals(page, fetch);

      try {
        enhance(page);
        page.fields.sort.value = 'size';
        page.fields.sort.dispatch('change');
        changeProjectAssetsScope(page, 'project');
        await flush();

        expect(fetch).toHaveBeenCalledOnce();
        expect(loadedScope(page)).toBe('global');
        expect(page.scopeControls.global.checked).toBe(true);
        expect(page.scopeControls.project.checked).toBe(false);
        expect(page.scopeControls.project.disabled).toBe(false);
        expect(page.fields.sort.value).toBe('size');
        expect(storedValues(page)).toEqual({ global: GLOBAL, project: PROJECT });
        expect(storage.size).toBe(0);
        expect(page.refreshActivation).not.toHaveBeenCalled();
        const message = 'Defaults scope could not be changed. The previous scope is still active.';
        expect(page.status.textContent).toBe(message);
        expect(page.form.querySelector('[data-dialog-error-text]').textContent).toBe(message);
        expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('reconciles a committed activation whose read-back failed through a GET, never a second POST', async () => {
      const page = makeActivationPage();
      const fetch = vi.fn()
        .mockResolvedValueOnce(json({ status: 'error', activation: { activeScope: 'project' } }, { ok: false, status: 500 }))
        .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'project'));
      const storage = stubStorage();
      installFetchGlobals(page, fetch);

      try {
        enhance(page);
        changeProjectAssetsScope(page, 'project');
        await flush();
        await flush();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toBe(RETURN_TO);
        expect(fetch.mock.calls[1][1].method).toBe('GET');
        expect(posts(fetch)).toHaveLength(1);
        expect(loadedScope(page)).toBe('project');
        expect(projectAssetsDefaultValues(page.fields)).toEqual(PROJECT);
        expect(storage.get('creatorcrate-asset-grid-size')).toBe(PROJECT.gridSize);
        expect(page.refreshActivation).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('blocks Save after an unconfirmable outcome until a read-only check settles the active scope', async () => {
      const page = makeActivationPage();
      const fetch = vi.fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'global'));
      const storage = stubStorage();
      installFetchGlobals(page, fetch);

      try {
        enhance(page);
        changeProjectAssetsScope(page, 'project');
        await flush();
        await flush();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(loadedScope(page)).toBe('global');
        expect(page.scopeControls.global.checked).toBe(true);
        expect(page.scopeControls.project.disabled).toBe(false);
        expect(page.status.textContent).toBe(
          'Could not confirm whether the defaults scope changed. Choose a scope to check again, or reload the page.',
        );
        page.form.dispatch('submit');
        await flush();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(page.status.textContent).toBe(
          'The active defaults scope could not be confirmed. Choose a scope to check it before saving.',
        );

        // Choosing a scope again only reads; it never repeats the POST.
        changeProjectAssetsScope(page, 'project');
        expect(page.scopeControls.global.checked).toBe(true);
        await flush();
        await flush();

        expect(fetch).toHaveBeenCalledTimes(3);
        expect(fetch.mock.calls[2][1].method).toBe('GET');
        expect(posts(fetch)).toHaveLength(1);
        expect(loadedScope(page)).toBe('global');
        expect(page.status.textContent).toBe('Global defaults are active.');
        expect(storage.size).toBe(0);
        expect(page.refreshActivation).not.toHaveBeenCalled();
        expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('keeps newer edits made while an activation was pending and still commits the acknowledged scope', async () => {
      const page = makeActivationPage();
      const pending = deferredResult();
      const fetch = vi.fn().mockReturnValueOnce(pending.promise);
      stubStorage();
      installFetchGlobals(page, fetch);

      try {
        enhance(page);
        changeProjectAssetsScope(page, 'project');
        await flush();
        page.fields.sort.value = 'size';
        page.fields.sort.dispatch('change');
        pending.resolve(acknowledgement('project', { global: GLOBAL, project: PROJECT }));
        await flush();

        expect(loadedScope(page)).toBe('project');
        expect(page.fields.sort.value).toBe('size');
        expect(page.fields.view.value).toBe(GLOBAL.view);
        expect(storedValues(page)).toEqual({ global: GLOBAL, project: PROJECT });
        expect(page.status.textContent).toBe(
          'Project-only defaults are active. Your newer changes were kept and are not saved.',
        );
        expect(posts(fetch)).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('refuses an activation while a Save is pending so neither can write against a stale scope', async () => {
      const page = makeActivationPage();
      const save = deferredResult();
      const fetch = vi.fn()
        .mockReturnValueOnce(save.promise)
        .mockResolvedValueOnce(acknowledgement('project', { global: { ...GLOBAL, sort: 'size' }, project: PROJECT }));
      stubStorage();
      installFetchGlobals(page, fetch);

      try {
        enhance(page);
        page.fields.sort.value = 'size';
        page.form.dispatch('submit');
        await flush();
        expect(body(fetch, 0)).toMatchObject({ intent: 'save', scope: 'global', loadedScope: 'global' });

        changeProjectAssetsScope(page, 'project');
        await flush();
        expect(fetch).toHaveBeenCalledOnce();
        expect(page.scopeControls.global.checked).toBe(true);
        expect(loadedScope(page)).toBe('global');
        expect(page.status.textContent).toBe('Wait for the current save to finish before changing the defaults scope.');

        save.resolve(response({
          url: 'http://creatorcrate.test/projects/1/assets?sort=size&notice=project_assets_defaults_saved',
          html: projectAssetsDefaultsHtml({ global: { ...GLOBAL, sort: 'size' }, project: PROJECT }, 'global'),
        }));
        await flush();
        expect(loadedScope(page)).toBe('global');

        changeProjectAssetsScope(page, 'project');
        await flush();
        expect(body(fetch, 1)).toEqual({ _csrf: 'csrf-token', returnTo: RETURN_TO, intent: 'activate-scope', scope: 'project' });
        expect(loadedScope(page)).toBe('project');
        expect(projectAssetsDefaultValues(page.fields)).toEqual(PROJECT);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // Milestone 2 Correction A. The combined Filters & Defaults dialog: the
    // defaults form opts in to the live controls and sits beside the rendered grid.
    function makeLivePage(options = {}) {
      const page = makeActivationPage(options);
      page.form.setAttribute('data-defaults-live-controls', '');
      page.liveRegion = makeElement('div', { 'data-project-assets-live-region': '' });
      page.grid = makeElement('ul', {
        class: 'asset-grid',
        'data-grid-style': options.loadedScope === 'project' ? PROJECT.gridStyle : GLOBAL.gridStyle,
      });
      page.liveRegion.appendChild(page.grid);
      page.document.body.appendChild(page.liveRegion);
      page.reset = makeElement('button', { type: 'button', 'data-project-assets-defaults-reset': '' });
      page.dialog.appendChild(page.reset);
      return page;
    }

    function enhanceLive(page) {
      page.region.appendChild(page.trigger);
      installProjectAssetsResponseParser(page);
      enhanceDropdowns(page.document);
      page.beginActivationRefresh = vi.fn(() => 31);
      page.refreshActivation = vi.fn(() => 'applied');
      enhanceProjectAssetsDefaultsScope(page.document, {
        beginRefresh: page.beginActivationRefresh,
        refreshActivation: page.refreshActivation,
        confirm: vi.fn(async () => true),
      });
      enhanceAppDialogs(page.document);
      page.document.dispatch('click', { target: page.trigger });
    }

    function chooseDefault(page, name, value) {
      page.fields[name].value = value;
      page.fields[name].dispatch('change');
    }

    const SIZE_KEYS = ['creatorcrate-asset-grid-size', 'creatorcrate-asset-list-size'];
    const storedSizes = (storage) => SIZE_KEYS.map((key) => storage.get(key));

    describe('Correction A F1 — browser size synchronization', () => {
      it('recognizes the combined Filters & Defaults dialog and no other dialog', () => {
        const storage = stubStorage();
        try {
          ['project-assets-defaults-dialog', 'projects-defaults-dialog', 'releases-defaults-dialog', 'asset-library-filter-dialog']
            .forEach((id) => syncProjectAssetsSizePreferences({ id }, { gridSize: 'compact', listSize: 'compact' }));
          expect(storage.size).toBe(0);

          syncProjectAssetsSizePreferences({ id: 'project-assets-filter-dialog' }, { gridSize: 'compact', listSize: 'bogus' });
          expect(storedSizes(storage)).toEqual(['compact', undefined]);
          syncProjectAssetsSizePreferences({ id: 'project-assets-filter-dialog' }, { gridSize: 'large', listSize: 'compact' });
          expect(storedSizes(storage)).toEqual(['large', 'compact']);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('writes the saved sizes only when a Save is acknowledged, never for a draft, a failure or a pending Save', async () => {
        const page = makeActivationPage();
        const save = deferredResult();
        const fetch = vi.fn()
          .mockResolvedValueOnce(response({ ok: false, redirected: false, html: '<p>Invalid size.</p>' }))
          .mockReturnValueOnce(save.promise);
        const storage = stubStorage();
        SIZE_KEYS.forEach((key) => storage.set(key, 'large'));
        installFetchGlobals(page, fetch);

        try {
          enhance(page);
          chooseDefault(page, 'gridSize', 'compact');
          chooseDefault(page, 'listSize', 'compact');
          await flush();
          // The size defaults are drafts: no write of any kind before Save.
          expect(fetch).not.toHaveBeenCalled();
          expect(storedSizes(storage)).toEqual(['large', 'large']);

          page.form.dispatch('submit');
          await flush();
          expect(fetch).toHaveBeenCalledTimes(1);
          expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');
          expect(storedSizes(storage)).toEqual(['large', 'large']);

          page.form.dispatch('submit');
          await flush();
          expect(fetch).toHaveBeenCalledTimes(2);
          expect(body(fetch, 1)).toMatchObject({ intent: 'save', gridSize: 'compact', listSize: 'compact' });
          expect(storedSizes(storage)).toEqual(['large', 'large']);

          save.resolve(response({
            url: 'http://creatorcrate.test/projects/1/assets?notice=project_assets_defaults_saved',
            html: projectAssetsDefaultsHtml(
              { global: { ...GLOBAL, gridSize: 'compact', listSize: 'compact' }, project: PROJECT },
              'global',
            ),
          }));
          await flush();
          expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
          expect(storedSizes(storage)).toEqual(['compact', 'compact']);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('loads each acknowledged scope\'s own sizes: Project-only, then Global', async () => {
        const page = makeLivePage();
        const fetch = vi.fn()
          .mockResolvedValueOnce(acknowledgement('project', { global: GLOBAL, project: PROJECT }))
          .mockResolvedValueOnce(acknowledgement('global', { global: GLOBAL, project: PROJECT }));
        const storage = stubStorage();
        installFetchGlobals(page, fetch);

        try {
          enhanceLive(page);
          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(loadedScope(page)).toBe('project');
          expect(storedSizes(storage)).toEqual([PROJECT.gridSize, PROJECT.listSize]);

          changeProjectAssetsScope(page, 'global');
          await flush();
          expect(loadedScope(page)).toBe('global');
          expect(storedSizes(storage)).toEqual([GLOBAL.gridSize, GLOBAL.listSize]);
          expect(page.refreshActivation).toHaveBeenCalledTimes(2);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('leaves the browser sizes alone when defaults are reset', async () => {
        const page = makeLivePage();
        const fetch = vi.fn().mockResolvedValueOnce(json({
          status: 'success',
          reset: { scope: 'global', changed: true },
          defaults: { scope: 'global', global: GLOBAL, project: GLOBAL },
        }));
        const storage = stubStorage();
        SIZE_KEYS.forEach((key) => storage.set(key, 'compact'));
        installFetchGlobals(page, fetch);

        try {
          enhanceLive(page);
          page.reset.dispatch('click');
          await flush();
          await flush();

          expect(fetch).toHaveBeenCalledOnce();
          expect(fetch.mock.calls[0][0]).toBe('/projects/1/assets/defaults/reset');
          expect(page.status.textContent).toBe('Global defaults reset. Project-only defaults were kept.');
          expect(storedSizes(storage)).toEqual(['compact', 'compact']);
          expect(storage.size).toBe(2);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    // Milestone 2 Correction C (F5): an acknowledged reset that changes the
    // defaults navigation is built against re-reads the current view, once,
    // through the post-mutation refresh; nothing else does.
    // Package B: Reset filters is a live GET whose restored controls are not
    // on screen until it installs, so it and the defaults operations exclude
    // each other, and nothing it does saves, activates or writes storage.
    describe('Package B — Reset filters operation ownership', () => {
      const RESET_EVENT = 'project-assets-filters-reset';
      const pendingReset = (page, reset) => {
        page.document.__creatorCrateProjectAssetsLiveFiltering = { projectAssetsFiltersReset: reset };
      };
      const announce = (page, id, phase) => page.document.dispatch(RESET_EVENT, {
        detail: { id, phase, generation: 4, url: 'http://creatorcrate.test/projects/1/assets?resetFilters=1' },
      });
      function addFiltersReset(page) {
        const button = makeElement('button', { type: 'submit', 'data-project-assets-reset': '' });
        page.dialog.appendChild(button);
        return button;
      }

      it('refuses Save, scope activation and Reset defaults while Reset filters owns the live region', async () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhanceLive(page);
          pendingReset(page, { id: 1, generation: 4, phase: 'pending' });
          announce(page, 1, 'started');

          // The explicit-save transport refuses a Save with this reason (WP6).
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe('Wait for Reset filters to finish before saving.');

          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(fetch).not.toHaveBeenCalled();
          expect(loadedScope(page)).toBe('global');
          expect(page.scopeControls.global.checked).toBe(true);
          expect(page.beginActivationRefresh).not.toHaveBeenCalled();
          expect(page.status.textContent).toBe('Wait for Reset filters to finish before changing the defaults scope.');

          page.reset.dispatch('click');
          await flush();
          expect(fetch).not.toHaveBeenCalled();
          expect(page.status.textContent).toBe('Wait for Reset filters to finish before resetting defaults.');

          // Installed: every operation is available again; nothing was written.
          page.document.dispatch(RESET_EVENT, { detail: {
            id: 1, phase: 'prepared', generation: 4, url: 'http://creatorcrate.test/projects/1/assets?resetFilters=1',
            parsed: new page.windowObject.DOMParser().parseFromString(projectAssetsDefaultsHtml({ global: GLOBAL, project: PROJECT })),
          } });
          pendingReset(page, null);
          announce(page, 1, 'installed');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();

          fetch.mockResolvedValueOnce(acknowledgement('project', { global: GLOBAL, project: PROJECT }));
          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(fetch).toHaveBeenCalledOnce();
          expect(body(fetch, 0)).toMatchObject({ intent: 'activate-scope', scope: 'project' });
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('a failed or superseded Reset releases the guards without a defaults POST', async () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        installFetchGlobals(page, fetch);
        try {
          enhanceLive(page);
          for (const [id, phase] of [[1, 'failed'], [2, 'superseded']]) {
            pendingReset(page, { id, generation: 4, phase: 'pending' });
            announce(page, id, 'started');
            expect(projectAssetsDefaultsSaveBlockedReason(page.form)).not.toBeNull();
            pendingReset(page, null);
            announce(page, id, phase);
            expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
          }
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('refuses Reset filters before the live engine sees it while a defaults operation is pending', async () => {
        const page = makeLivePage();
        const pending = deferredResult();
        const fetch = vi.fn().mockReturnValueOnce(pending.promise);
        installFetchGlobals(page, fetch);
        try {
          enhanceLive(page);
          const filtersReset = addFiltersReset(page);
          const engineClick = vi.fn();
          filtersReset.addEventListener('click', engineClick);

          // Idle: the click is left to the live engine.
          const idle = page.document.dispatch('click', { target: filtersReset });
          expect(idle.defaultPrevented).toBe(false);

          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(fetch).toHaveBeenCalledOnce();
          const busy = page.document.dispatch('click', { target: filtersReset });
          expect(busy.defaultPrevented).toBe(true);
          expect(page.status.textContent).toBe('Wait for the current defaults operation to finish before resetting filters.');
          expect(fetch).toHaveBeenCalledOnce();

          pending.resolve(acknowledgement('project', { global: GLOBAL, project: PROJECT }));
          await flush();
          expect(page.document.dispatch('click', { target: filtersReset }).defaultPrevented).toBe(false);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    // Package C: an installed Reset filters also restores Grid style and the
    // Grid/List size defaults to the active scope's resolved saved/default
    // values, each unless the user chose it after the Reset began. Nothing is
    // saved, activated or written to browser storage.
    describe('Package C — Reset filters restores Grid style and sizes', () => {
      const RESET_EVENT = 'project-assets-filters-reset';
      const SAVED = { ...GLOBAL, gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' };
      function enhancePresentation(page) {
        page.previews = { gridSize: [], listSize: [] };
        page.region.appendChild(page.trigger);
        installProjectAssetsResponseParser(page);
        enhanceDropdowns(page.document);
        enhanceProjectAssetsDefaultsScope(page.document, {
          beginRefresh: vi.fn(() => 31),
          refreshActivation: vi.fn(() => 'applied'),
          confirm: vi.fn(async () => true),
          previewGridSize: (scope, size) => page.previews.gridSize.push(size),
          previewListSize: (scope, size) => page.previews.listSize.push(size),
          resolveSizes: () => ({ gridSize: 'large', listSize: 'large' }),
        });
        enhanceAppDialogs(page.document);
        page.document.dispatch('click', { target: page.trigger });
      }
      const parsedPage = (page, values, scope) => new page.windowObject.DOMParser()
        .parseFromString(projectAssetsDefaultsHtml(values, scope));
      const setPending = (page, reset) => {
        page.document.__creatorCrateProjectAssetsLiveFiltering = { projectAssetsFiltersReset: reset };
      };
      const announce = (page, id, phase, extra = {}) => page.document.dispatch(RESET_EVENT, {
        detail: { id, phase, generation: 4, url: 'http://creatorcrate.test/projects/1/assets?resetFilters=1', ...extra },
      });
      const start = (page, id) => {
        setPending(page, { id, generation: 4, phase: 'pending' });
        announce(page, id, 'started');
      };
      const install = (page, id, values, scope = 'global') => {
        announce(page, id, 'prepared', { parsed: parsedPage(page, values, scope) });
        setPending(page, null);
        page.document.dispatch('project-assets-region-loaded');
        announce(page, id, 'installed');
      };
      const presentation = (page) => ({
        gridStyle: page.fields.gridStyle.value,
        gridSize: page.fields.gridSize.value,
        listSize: page.fields.listSize.value,
        rendered: page.grid.getAttribute('data-grid-style'),
        gridPreview: page.previews.gridSize.at(-1),
        listPreview: page.previews.listSize.at(-1),
      });
      const checkedOption = (page, key) => page.dropdowns[key].panel.querySelectorAll('input')
        .find((input) => input.checked)?.value;

      it('restores saved Global style and sizes over older unsaved previews, without writing anything', async () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        storage.set('creatorcrate-asset-grid-size', 'large');
        storage.set('creatorcrate-asset-list-size', 'large');
        installFetchGlobals(page, fetch);
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          chooseDefault(page, 'gridSize', 'large');
          chooseDefault(page, 'listSize', 'large');
          expect(presentation(page)).toMatchObject({ rendered: 'uncropped', gridPreview: 'large', listPreview: 'large' });

          start(page, 1);
          install(page, 1, { global: SAVED, project: PROJECT });

          expect(presentation(page)).toEqual({
            gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact',
            rendered: 'cropped', gridPreview: 'compact', listPreview: 'compact',
          });
          ['gridStyle', 'gridSize', 'listSize'].forEach((key) => {
            expect(checkedOption(page, key)).toBe(SAVED[key]);
          });
          expect(storedSizes(storage)).toEqual(['large', 'large']);
          expect(storage.size).toBe(2);
          expect(fetch).not.toHaveBeenCalled();
          expect(storedValues(page).global).toEqual(GLOBAL);

          // A later region keeps the restored presentation; reopening shows it.
          const replacement = makeElement('ul', { class: 'asset-grid', 'data-grid-style': 'uncropped' });
          page.grid.replaceWith(replacement);
          page.grid = replacement;
          page.document.dispatch('project-assets-region-loaded');
          expect(presentation(page)).toMatchObject({ rendered: 'cropped', gridPreview: 'compact', listPreview: 'compact' });
          closeAppDialogById(page.document, page.dialog.id);
          page.document.dispatch('click', { target: page.trigger });
          expect(presentation(page)).toMatchObject({ gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
          expect(storedSizes(storage)).toEqual(['large', 'large']);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('resolves each setting from the active Project-only snapshot, including inherited Global values', () => {
        const page = makeLivePage({ loadedScope: 'project' });
        stubStorage();
        installFetchGlobals(page, vi.fn());
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          chooseDefault(page, 'gridSize', 'default');
          chooseDefault(page, 'listSize', 'large');
          start(page, 1);
          // Project only overrides Grid style; its sizes inherit Global's.
          const global = { ...GLOBAL, gridStyle: 'uncropped', gridSize: 'compact', listSize: 'compact' };
          const project = { ...global, gridStyle: 'cropped' };
          install(page, 1, { global, project }, 'project');
          expect(presentation(page)).toMatchObject({
            gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact', rendered: 'cropped',
          });
          expect(loadedScope(page)).toBe('project');
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('shows the application fallbacks as Reset previews, even where they equal a stored size', () => {
        const page = makeLivePage();
        const storage = stubStorage();
        storage.set('creatorcrate-asset-list-size', 'large');
        installFetchGlobals(page, vi.fn());
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'cropped');
          chooseDefault(page, 'gridSize', 'compact');
          chooseDefault(page, 'listSize', 'compact');
          start(page, 1);
          install(page, 1, { global: GLOBAL, project: GLOBAL });
          expect(presentation(page)).toEqual({
            gridStyle: 'uncropped', gridSize: 'default', listSize: 'large',
            rendered: 'uncropped', gridPreview: 'default', listPreview: 'large',
          });
          expect(storage.get('creatorcrate-asset-list-size')).toBe('large');
          expect(storage.size).toBe(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('keeps only the settings chosen after the Reset began; other edits protect nothing', () => {
        const page = makeLivePage();
        stubStorage();
        installFetchGlobals(page, vi.fn());
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          chooseDefault(page, 'listSize', 'large');
          start(page, 1);
          // Newer: a Grid size choice and a Sort change while Reset is pending.
          chooseDefault(page, 'gridSize', 'large');
          chooseDefault(page, 'sort', 'category');
          install(page, 1, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({
            gridStyle: 'cropped', gridSize: 'large', listSize: 'compact',
            rendered: 'cropped', gridPreview: 'large', listPreview: 'compact',
          });

          // A newer style choice stands while both sizes are restored.
          chooseDefault(page, 'gridSize', 'default');
          chooseDefault(page, 'listSize', 'large');
          start(page, 2);
          chooseDefault(page, 'gridStyle', 'uncropped');
          install(page, 2, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({
            gridStyle: 'uncropped', gridSize: 'compact', listSize: 'compact',
            rendered: 'uncropped', gridPreview: 'compact', listPreview: 'compact',
          });
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('installs nothing from a failed or superseded Reset, and its Retry keeps the original boundary', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          chooseDefault(page, 'gridSize', 'large');
          chooseDefault(page, 'listSize', 'compact');
          const before = presentation(page);

          start(page, 1);
          setPending(page, null);
          announce(page, 1, 'superseded');
          expect(presentation(page)).toEqual(before);

          start(page, 2);
          // A List size chosen while the original Reset was pending.
          chooseDefault(page, 'listSize', 'large');
          announce(page, 2, 'prepared', { parsed: parsedPage(page, { global: SAVED, project: PROJECT }, 'global') });
          setPending(page, null);
          announce(page, 2, 'failed');
          expect(presentation(page)).toMatchObject({ gridStyle: 'uncropped', gridSize: 'large', rendered: 'uncropped' });

          // Retry is the same Reset: the List size chosen during it stands.
          start(page, 3);
          install(page, 3, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({
            gridStyle: 'cropped', gridSize: 'compact', listSize: 'large', rendered: 'cropped',
            gridPreview: 'compact', listPreview: 'large',
          });

          // A new Reset filters click after a failure is a new Reset.
          start(page, 4);
          chooseDefault(page, 'gridSize', 'large');
          setPending(page, null);
          announce(page, 4, 'failed');
          const filtersReset = makeElement('button', { type: 'submit', 'data-project-assets-reset': '' });
          page.dialog.appendChild(filtersReset);
          page.document.dispatch('click', { target: filtersReset });
          start(page, 5);
          install(page, 5, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({
            gridSize: 'compact', listSize: 'compact', gridPreview: 'compact', listPreview: 'compact',
          });
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('lets an acknowledged scope activation replace the Reset previews with its own sizes', async () => {
        const page = makeLivePage();
        const fetch = vi.fn().mockResolvedValueOnce(acknowledgement('project', { global: SAVED, project: PROJECT }));
        stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridSize', 'large');
          start(page, 1);
          install(page, 1, { global: SAVED, project: PROJECT });
          expect(page.fields.gridSize.value).toBe('compact');
          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(loadedScope(page)).toBe('project');
          expect(presentation(page)).toMatchObject({
            gridStyle: PROJECT.gridStyle, gridSize: PROJECT.gridSize, listSize: PROJECT.listSize,
          });
          expect(posts(fetch)).toHaveLength(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      // F11/F12: re-choosing the shown Grid style or size while a Reset is
      // pending, or between a failed Reset and its GET-only Retry, is a choice
      // newer than that Reset, made by pointer or by Space.
      const RESET_URL = 'http://creatorcrate.test/projects/1/assets?resetFilters=1';
      const radioFor = (page, name, value = page.fields[name].value) => page.dropdowns[name].panel
        .querySelectorAll('input').find((input) => input.value === value);
      const wrapperFor = (page, name) => page.fields[name].closest('[data-dialog-field]');
      // As the real dropdown does after a choice: its radios follow the field.
      const syncRadios = (page, name) => page.dropdowns[name].panel.querySelectorAll('input').forEach((input) => {
        input.checked = input.value === page.fields[name].value;
      });
      const clickShown = (page, name) => {
        syncRadios(page, name);
        wrapperFor(page, name).dispatch('click', { target: radioFor(page, name), detail: 1 });
      };
      const pressSpace = (page, name, target = radioFor(page, name), { repeats = 0, click = false, ...keys } = {}) => {
        syncRadios(page, name);
        const wrapper = wrapperFor(page, name);
        wrapper.dispatch('keydown', { key: ' ', target, repeat: false, ...keys });
        for (let i = 0; i < repeats; i += 1) wrapper.dispatch('keydown', { key: ' ', target, repeat: true, ...keys });
        wrapper.dispatch('keyup', { key: ' ', target, ...keys });
        if (click) wrapper.dispatch('click', { target, detail: 0 });
      };
      // A failed Reset whose GET-only Retry is (or, after newer navigation, is
      // no longer) the one the live engine shows.
      const failReset = (page, id, { retry = true } = {}) => {
        page.document.__creatorCrateProjectAssetsLiveFiltering = {
          projectAssetsFiltersReset: null,
          loadFailure: retry ? { url: new URL(RESET_URL) } : null,
        };
        announce(page, id, 'failed');
      };
      const supersedeRetry = (page) => {
        page.document.__creatorCrateProjectAssetsLiveFiltering = { projectAssetsFiltersReset: null, loadFailure: null };
      };

      it('F11: a pointer or Space re-choice of the shown Grid style survives a held Reset', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          const changes = [];
          page.fields.gridStyle.addEventListener('change', () => changes.push('change'));

          // F11-A: pointer.
          start(page, 1);
          clickShown(page, 'gridStyle');
          install(page, 1, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({
            gridStyle: 'uncropped', rendered: 'uncropped', gridSize: 'compact', listSize: 'compact',
          });
          expect(checkedOption(page, 'gridStyle')).toBe('uncropped');

          // F11-B: Space with held-key repeats and a trailing keyboard click: one choice.
          chooseDefault(page, 'gridSize', 'large');
          start(page, 2);
          pressSpace(page, 'gridStyle', radioFor(page, 'gridStyle'), { repeats: 4, click: true });
          install(page, 2, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ gridStyle: 'uncropped', rendered: 'uncropped', gridSize: 'compact' });

          // Outside a Reset the same re-choice is not an edit, so the next Reset restores.
          clickShown(page, 'gridStyle');
          pressSpace(page, 'gridStyle');
          start(page, 3);
          install(page, 3, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ gridStyle: 'cropped', rendered: 'cropped' });

          // F11-C: a different style takes the ordinary change path (once).
          start(page, 4);
          const before = changes.length;
          chooseDefault(page, 'gridStyle', 'uncropped');
          expect(changes.length).toBe(before + 1);
          install(page, 4, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ gridStyle: 'uncropped', rendered: 'uncropped' });
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('F12: a shown size re-chosen after a failed Reset survives repeated failed Retries', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          chooseDefault(page, 'gridSize', 'large');
          chooseDefault(page, 'listSize', 'large');

          // F12-A: List by pointer, between failed attempts.
          start(page, 1);
          failReset(page, 1);
          clickShown(page, 'listSize');
          start(page, 2);
          failReset(page, 2);
          start(page, 3);
          failReset(page, 3);
          start(page, 4);
          install(page, 4, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({
            gridStyle: 'cropped', gridSize: 'compact', listSize: 'large',
            rendered: 'cropped', gridPreview: 'compact', listPreview: 'large',
          });
          expect(checkedOption(page, 'listSize')).toBe('large');

          // F12-B: Grid by Space (with repeats), between failed attempts.
          chooseDefault(page, 'gridSize', 'large');
          start(page, 5);
          failReset(page, 5);
          pressSpace(page, 'gridSize', radioFor(page, 'gridSize'), { repeats: 3 });
          start(page, 6);
          failReset(page, 6);
          start(page, 7);
          install(page, 7, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ gridSize: 'large', listSize: 'compact', gridPreview: 'large' });
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('F12: a new Reset takes a fresh boundary, and superseded Retry ownership retires', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        const filtersReset = makeElement('button', { type: 'submit', 'data-project-assets-reset': '' });
        try {
          enhancePresentation(page);
          page.dialog.appendChild(filtersReset);
          chooseDefault(page, 'listSize', 'large');
          chooseDefault(page, 'gridSize', 'large');

          // F12-C: a re-choice under a failed Reset does not outlive a new Reset click.
          start(page, 1);
          failReset(page, 1);
          clickShown(page, 'listSize');
          page.document.dispatch('click', { target: filtersReset });
          start(page, 2);
          install(page, 2, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ gridSize: 'compact', listSize: 'compact' });

          // F12-D: navigation that supersedes the failed Reset's Retry ends its
          // ownership, before or after that navigation installs.
          chooseDefault(page, 'listSize', 'large');
          start(page, 3);
          failReset(page, 3);
          supersedeRetry(page);
          clickShown(page, 'listSize');
          pressSpace(page, 'listSize');
          page.document.dispatch('click', { target: filtersReset });
          start(page, 4);
          install(page, 4, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ listSize: 'compact', listPreview: 'compact' });

          chooseDefault(page, 'listSize', 'large');
          start(page, 5);
          failReset(page, 5);
          // Another load installs; any Reset Retry on screen afterward is not this one's.
          page.document.dispatch('project-assets-region-loaded');
          page.document.__creatorCrateProjectAssetsLiveFiltering.loadFailure = { url: new URL(RESET_URL) };
          clickShown(page, 'listSize');
          start(page, 6);
          install(page, 6, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ listSize: 'compact' });

          // F12-E: modifiers, unmatched keyup, repeats alone, Enter and other
          // options are not choices of the shown size.
          chooseDefault(page, 'listSize', 'large');
          start(page, 7);
          failReset(page, 7);
          const shown = radioFor(page, 'listSize');
          const wrapper = wrapperFor(page, 'listSize');
          pressSpace(page, 'listSize', shown, { ctrlKey: true });
          pressSpace(page, 'listSize', shown, { altKey: true });
          wrapper.dispatch('keyup', { key: ' ', target: shown });
          wrapper.dispatch('keydown', { key: ' ', target: shown, repeat: true });
          wrapper.dispatch('keyup', { key: ' ', target: shown });
          wrapper.dispatch('keydown', { key: 'Enter', target: shown });
          wrapper.dispatch('keyup', { key: 'Enter', target: shown });
          pressSpace(page, 'listSize', radioFor(page, 'listSize', 'compact'));
          start(page, 8);
          install(page, 8, { global: SAVED, project: PROJECT });
          expect(presentation(page)).toMatchObject({ listSize: 'compact' });
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      // F13: another tab changed the active scope while this Reset was pending.
      const savedMeta = (activeScope) => ({
        activeScope,
        hasSavedDefaults: true,
        global: { saved: true },
        project: { saved: true, inheritance: 'full' },
      });
      const parsedWith = (page, values, scope, meta) => new page.windowObject.DOMParser()
        .parseFromString(projectAssetsDefaultsHtml(values, scope, meta));

      it('F13: adopts the response scope before install, so the next Save targets it', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          start(page, 1);
          const projectOnly = { ...SAVED, view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' };
          announce(page, 1, 'prepared', {
            parsed: parsedWith(page, { global: SAVED, project: projectOnly }, 'project', savedMeta('project')),
          });
          // Adopted at the prepared boundary, before the region installs.
          expect(loadedScope(page)).toBe('project');
          expect(page.scopeControls.project.checked).toBe(true);
          expect(page.scopeControls.global.checked).toBe(false);
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe('Wait for Reset filters to finish before saving.');
          setPending(page, null);
          page.document.dispatch('project-assets-region-loaded');
          announce(page, 1, 'installed');

          expect(presentation(page)).toMatchObject({
            gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', rendered: 'cropped',
          });
          expect(storedValues(page)).toEqual({ global: SAVED, project: projectOnly });
          expect(page.status.textContent).toBe('Project-only defaults are active.');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('F13: fails closed when the response cannot establish its scope, and ignores stale Resets', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        const unresolved = 'The active defaults scope could not be confirmed. Choose a scope to check it before saving.';
        try {
          enhancePresentation(page);
          chooseDefault(page, 'gridStyle', 'uncropped');
          chooseDefault(page, 'gridSize', 'large');

          // A stale Reset's late prepared/installed does nothing.
          start(page, 1);
          start(page, 2);
          announce(page, 1, 'prepared', {
            parsed: parsedWith(page, { global: SAVED, project: PROJECT }, 'project', savedMeta('project')),
          });
          announce(page, 1, 'installed');
          expect(loadedScope(page)).toBe('global');

          // Another scope without its saved-state metadata: not accepted, no cached fallback.
          announce(page, 2, 'prepared', { parsed: parsedWith(page, { global: SAVED, project: PROJECT }, 'project') });
          setPending(page, null);
          page.document.dispatch('project-assets-region-loaded');
          announce(page, 2, 'installed');
          expect(loadedScope(page)).toBe('global');
          expect(presentation(page)).toMatchObject({ gridStyle: 'uncropped', gridSize: 'large', rendered: 'uncropped' });
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(unresolved);

          // A malformed response is likewise not accepted.
          start(page, 3);
          announce(page, 3, 'prepared', { parsed: { querySelector: () => null } });
          setPending(page, null);
          announce(page, 3, 'installed');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(unresolved);
          expect(storedValues(page).global).toEqual(GLOBAL);
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      // F14: a Reset adopted another tab's scope when prepared, but its region
      // never installed: the controls still show the previous scope.
      const INCOMPLETE = 'Reset filters did not finish loading the active defaults. Retry it, or use Reset filters again, before saving.';
      const PROJECT_ONLY = { ...SAVED, view: 'grid', gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' };
      const adoptAndFail = (page, id) => {
        start(page, id);
        announce(page, id, 'prepared', {
          parsed: parsedWith(page, { global: SAVED, project: PROJECT_ONLY }, 'project', savedMeta('project')),
        });
        expect(loadedScope(page)).toBe('project');
        failReset(page, id);
      };
      const enhanceWithSave = (page) => {
        enhancePresentation(page);
        enhanceProjectAssetsDefaultsFetchSave(page.document, { beginRefresh: vi.fn(() => 17), refresh: vi.fn(() => 'started') });
      };
      const attemptSave = async (page) => {
        page.form.dispatch('submit', { submitter: page.save });
        page.form.dispatch('submit', { submitter: null });
        await flush();
      };

      it('F14: Save stays refused after a prepared Reset adopts a scope but fails to install, through failed Retries', async () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhanceWithSave(page);
          chooseDefault(page, 'gridStyle', 'cropped');
          chooseDefault(page, 'gridSize', 'compact');
          chooseDefault(page, 'listSize', 'compact');

          // 1–2. Prepared (scope adopted), install failed: Save refused, no POST.
          adoptAndFail(page, 1);
          expect(presentation(page)).toMatchObject({ gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(INCOMPLETE);
          expect(page.status.textContent).toBe(INCOMPLETE);
          await attemptSave(page);
          expect(fetch).not.toHaveBeenCalled();
          expect(page.status.textContent).toBe(INCOMPLETE);

          // 3–4. A Retry failing before its response, and one failing after
          // preparing (the scope already matches): still refused.
          start(page, 2);
          failReset(page, 2);
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(INCOMPLETE);
          start(page, 3);
          announce(page, 3, 'prepared', { parsed: parsedPage(page, { global: SAVED, project: PROJECT_ONLY }, 'project') });
          failReset(page, 3);
          await attemptSave(page);
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(INCOMPLETE);
          expect(fetch).not.toHaveBeenCalled();

          // 5–6. The owning Retry installs the Project-only state: Save allowed.
          start(page, 4);
          install(page, 4, { global: SAVED, project: PROJECT_ONLY }, 'project');
          expect(presentation(page)).toMatchObject({
            gridStyle: 'uncropped', gridSize: 'large', listSize: 'large',
            rendered: 'uncropped', gridPreview: 'large', listPreview: 'large',
          });
          expect(checkedOption(page, 'gridStyle')).toBe('uncropped');
          expect(loadedScope(page)).toBe('project');
          expect(storedValues(page)).toEqual({ global: SAVED, project: PROJECT_ONLY });
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
          expect(page.status.textContent).toBe('Project-only defaults are active.');
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('F14: superseded, stale and ordinary loads keep Save refused; only an installed Reset ends it', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);
        try {
          enhanceWithSave(page);
          chooseDefault(page, 'gridStyle', 'cropped');

          // A superseded prepared Reset keeps the refusal, and its late
          // callbacks (the engine never sends them, but a stale id) do nothing.
          start(page, 1);
          announce(page, 1, 'prepared', {
            parsed: parsedWith(page, { global: SAVED, project: PROJECT_ONLY }, 'project', savedMeta('project')),
          });
          setPending(page, null);
          announce(page, 1, 'superseded');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(INCOMPLETE);
          announce(page, 1, 'installed');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(INCOMPLETE);

          // Unrelated navigation installs a region: not a restored presentation.
          page.document.dispatch('project-assets-region-loaded');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(INCOMPLETE);

          // A newer Reset superseded by a later one: the stale one's install
          // cannot clear the refusal.
          start(page, 2);
          start(page, 3);
          announce(page, 2, 'prepared', { parsed: parsedPage(page, { global: SAVED, project: PROJECT_ONLY }, 'project') });
          announce(page, 2, 'installed');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe('Wait for Reset filters to finish before saving.');

          // A malformed response installs without confirming anything: refused.
          announce(page, 3, 'prepared', { parsed: { querySelector: () => null } });
          setPending(page, null);
          announce(page, 3, 'installed');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(INCOMPLETE);
          expect(presentation(page).gridStyle).not.toBe('uncropped');

          // A new owning Reset that installs ends it.
          start(page, 4);
          install(page, 4, { global: SAVED, project: PROJECT_ONLY }, 'project');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).not.toBe(INCOMPLETE);
          expect(presentation(page)).toMatchObject({ gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('F14: a Reset that prepared the scope already active and failed leaves Save available', () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        installFetchGlobals(page, fetch);
        try {
          enhanceWithSave(page);
          start(page, 1);
          announce(page, 1, 'prepared', { parsed: parsedPage(page, { global: SAVED, project: PROJECT }, 'global') });
          failReset(page, 1);
          expect(loadedScope(page)).toBe('global');
          expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    describe('Correction C F5 — reset navigation reconciliation', () => {
      function enhanceResetLive(page, refreshAfterMutation) {
        page.region.appendChild(page.trigger);
        installProjectAssetsResponseParser(page);
        enhanceDropdowns(page.document);
        enhanceProjectAssetsDefaultsScope(page.document, {
          beginRefresh: vi.fn(() => 31),
          refreshActivation: vi.fn(() => 'applied'),
          refreshAfterMutation,
          confirm: vi.fn(async () => true),
        });
        enhanceAppDialogs(page.document);
        page.document.dispatch('click', { target: page.trigger });
      }
      const resetJson = (scope, changed, defaults) => json({
        status: 'success', reset: { scope, changed }, defaults,
      });
      const PROJECT_RESET = 'Project-only defaults reset. This project now uses Global defaults.';
      const REFRESH_FAILED = 'Defaults were reset, but Project Assets could not refresh, so its page and view links are unavailable. Retry, or reload the page.';

      it('re-reads the current view once after a reset that changes the navigation defaults', async () => {
        const page = makeLivePage({ loadedScope: 'project' });
        const refreshAfterMutation = vi.fn(async () => ({ status: 'installed' }));
        const fetch = vi.fn().mockResolvedValueOnce(
          resetJson('project', true, { scope: 'global', global: GLOBAL, project: GLOBAL }),
        );
        installFetchGlobals(page, fetch);
        try {
          enhanceResetLive(page, refreshAfterMutation);
          page.reset.dispatch('click');
          await flush();
          await flush();
          expect(fetch).toHaveBeenCalledOnce();
          expect(refreshAfterMutation).toHaveBeenCalledOnce();
          expect(refreshAfterMutation.mock.calls[0][0]).toBe(page.document);
          expect(typeof refreshAfterMutation.mock.calls[0][1].onRecovered).toBe('function');
          expect(loadedScope(page)).toBe('global');
          expect(page.status.textContent).toBe(PROJECT_RESET);
          expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('re-reads nothing for a no-op reset, an unchanged navigation default or a failed reset', async () => {
        const page = makeLivePage({ loadedScope: 'project' });
        const refreshAfterMutation = vi.fn(async () => ({ status: 'installed' }));
        const fetch = vi.fn()
          .mockResolvedValueOnce(resetJson('project', false, { scope: 'project', global: GLOBAL, project: PROJECT }))
          // Only the Grid style and sizes differ: no link depends on them.
          .mockResolvedValueOnce(resetJson('project', true, {
            scope: 'project',
            global: GLOBAL,
            project: { ...PROJECT, gridStyle: 'uncropped', gridSize: 'default', listSize: 'large' },
          }))
          .mockResolvedValueOnce(json({ status: 'error' }, { ok: false, status: 422 }));
        installFetchGlobals(page, fetch);
        try {
          enhanceResetLive(page, refreshAfterMutation);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            page.reset.dispatch('click');
            await flush();
            await flush();
          }
          expect(fetch).toHaveBeenCalledTimes(3);
          expect(page.status.textContent).toBe('Defaults could not be reset. No changes were made.');
          expect(refreshAfterMutation).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('keeps a reset committed when its re-read fails, never re-sends it, and clears the failure on recovery', async () => {
        const page = makeLivePage({ loadedScope: 'project' });
        let recovered;
        const refreshAfterMutation = vi.fn(async (_document, { onRecovered }) => {
          recovered = onRecovered;
          return { status: 'failed' };
        });
        const fetch = vi.fn().mockResolvedValueOnce(
          resetJson('project', true, { scope: 'global', global: GLOBAL, project: GLOBAL }),
        );
        installFetchGlobals(page, fetch);
        try {
          enhanceResetLive(page, refreshAfterMutation);
          page.reset.dispatch('click');
          await flush();
          await flush();
          expect(fetch).toHaveBeenCalledOnce();
          expect(loadedScope(page)).toBe('global');
          expect(page.status.textContent).toBe(REFRESH_FAILED);
          expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');

          recovered({});
          expect(page.status.textContent).toBe(PROJECT_RESET);
          expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
          expect(fetch).toHaveBeenCalledOnce();
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    // Milestone 2 Correction D. F6: an acknowledged reset keeps the displayed
    // sizes through the page's size fallbacks, never browser storage. F7: its
    // re-read marks the rendered page and view links obsolete.
    describe('Correction D F6/F7 — reset presentation and stale links', () => {
      function enhanceResetLive(page, refreshAfterMutation, retainDisplayedSizes) {
        page.region.appendChild(page.trigger);
        installProjectAssetsResponseParser(page);
        enhanceDropdowns(page.document);
        enhanceProjectAssetsDefaultsScope(page.document, {
          beginRefresh: vi.fn(() => 31),
          refreshActivation: vi.fn(() => 'applied'),
          refreshAfterMutation,
          retainDisplayedSizes,
          confirm: vi.fn(async () => true),
        });
        enhanceAppDialogs(page.document);
        page.document.dispatch('click', { target: page.trigger });
      }
      const resetJson = (scope, changed, defaults) => json({
        status: 'success', reset: { scope, changed }, defaults,
      });

      it('retains the displayed sizes and marks links stale for a committed reset, writing no storage', async () => {
        const page = makeLivePage({ loadedScope: 'project' });
        const refreshAfterMutation = vi.fn(async () => ({ status: 'failed' }));
        const retainDisplayedSizes = vi.fn(() => true);
        const storage = stubStorage();
        const fetch = vi.fn().mockResolvedValueOnce(
          resetJson('project', true, { scope: 'global', global: GLOBAL, project: GLOBAL }),
        );
        installFetchGlobals(page, fetch);
        try {
          enhanceResetLive(page, refreshAfterMutation, retainDisplayedSizes);
          page.reset.dispatch('click');
          await flush();
          await flush();
          expect(fetch).toHaveBeenCalledOnce();
          expect(retainDisplayedSizes).toHaveBeenCalledOnce();
          expect(retainDisplayedSizes.mock.calls[0][0]).toBe(page.document);
          expect(retainDisplayedSizes.mock.calls[0][1]).toMatchObject({
            gridSize: GLOBAL.gridSize, listSize: GLOBAL.listSize,
          });
          expect(refreshAfterMutation).toHaveBeenCalledOnce();
          expect(refreshAfterMutation.mock.calls[0][1].staleNavigation).toBe(true);
          expect(storage.size).toBe(0);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('retains sizes even when no link depends on the reset, and does nothing for a no-op or failed reset', async () => {
        const page = makeLivePage({ loadedScope: 'project' });
        const refreshAfterMutation = vi.fn(async () => ({ status: 'installed' }));
        const retainDisplayedSizes = vi.fn(() => true);
        const storage = stubStorage();
        const fetch = vi.fn()
          .mockResolvedValueOnce(resetJson('project', false, { scope: 'project', global: GLOBAL, project: PROJECT }))
          .mockResolvedValueOnce(json({ status: 'error' }, { ok: false, status: 422 }))
          // Only the Grid style and sizes differ: no link depends on them.
          .mockResolvedValueOnce(resetJson('project', true, {
            scope: 'project',
            global: GLOBAL,
            project: { ...PROJECT, gridStyle: 'uncropped', gridSize: 'default', listSize: 'large' },
          }));
        installFetchGlobals(page, fetch);
        try {
          enhanceResetLive(page, refreshAfterMutation, retainDisplayedSizes);
          for (let attempt = 0; attempt < 2; attempt += 1) {
            page.reset.dispatch('click');
            await flush();
            await flush();
          }
          // No-op and failed resets: nothing retained, no stale links.
          expect(retainDisplayedSizes).not.toHaveBeenCalled();
          expect(refreshAfterMutation).not.toHaveBeenCalled();

          page.reset.dispatch('click');
          await flush();
          await flush();
          expect(fetch).toHaveBeenCalledTimes(3);
          expect(retainDisplayedSizes).toHaveBeenCalledOnce();
          expect(retainDisplayedSizes.mock.calls[0][1]).toMatchObject({ gridSize: 'default', listSize: 'large' });
          expect(refreshAfterMutation).not.toHaveBeenCalled();
          expect(storage.size).toBe(0);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    describe('Correction A F2 — live Grid style', () => {
      it('restyles the grid at once in both directions without any request or stored preference', async () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);

        try {
          enhanceLive(page);
          expect(page.grid.getAttribute('data-grid-style')).toBe('uncropped');

          chooseDefault(page, 'gridStyle', 'cropped');
          expect(page.grid.getAttribute('data-grid-style')).toBe('cropped');
          chooseDefault(page, 'gridStyle', 'uncropped');
          expect(page.grid.getAttribute('data-grid-style')).toBe('uncropped');
          await flush();

          expect(fetch).not.toHaveBeenCalled();
          expect(storage.size).toBe(0);
          expect(storedValues(page)).toEqual({ global: GLOBAL, project: PROJECT });
          expect(page.refreshActivation).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      // User acceptance correction: the size defaults preview live.
      it('previews the size defaults at once: no stored preference, no request, no saved value', async () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        const storage = stubStorage();
        installFetchGlobals(page, fetch);

        try {
          enhanceLive(page);
          chooseDefault(page, 'gridSize', 'large');
          expect(page.grid.getAttribute('data-grid-size')).toBe('large');
          expect(page.grid.style.getPropertyValue?.('--asset-card-min') ?? '20rem').toBe('20rem');
          chooseDefault(page, 'gridSize', 'compact');
          expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
          // List is not shown: its preview is held for when it renders.
          chooseDefault(page, 'listSize', 'compact');
          await flush();

          expect(fetch).not.toHaveBeenCalled();
          expect(storage.size).toBe(0);
          expect(storedValues(page)).toEqual({ global: GLOBAL, project: PROJECT });
          expect(page.grid.getAttribute('data-grid-style')).toBe('uncropped');

          // Switching to List installs a list region resolved from storage
          // and its saved fallback; the held List preview is put back.
          const list = makeElement('ul', { class: 'asset-list', 'data-list-size': 'large' });
          page.grid.replaceWith(list);
          page.document.dispatch('project-assets-region-loaded');
          expect(list.getAttribute('data-list-size')).toBe('compact');

          // Back to Grid: a region rendered with the saved Grid size gets the preview.
          const grid = makeElement('ul', { class: 'asset-grid', 'data-grid-style': 'uncropped' });
          list.replaceWith(grid);
          page.document.dispatch('project-assets-region-loaded');
          expect(grid.getAttribute('data-grid-size')).toBe('compact');
          expect(storage.size).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('reopens showing the sizes in use: a preview, else the stored size, else the saved fallback', () => {
        const page = makeLivePage();
        const storage = stubStorage();
        installFetchGlobals(page, vi.fn());

        try {
          page.liveRegion.setAttribute('data-project-assets-grid-size-default', 'default');
          page.liveRegion.setAttribute('data-project-assets-list-size-default', 'large');
          storage.set('creatorcrate-asset-grid-size', 'compact');
          enhanceLive(page);
          // Opening shows what is displayed, not the saved default.
          expect(page.fields.gridSize.value).toBe('compact');
          expect(page.fields.listSize.value).toBe('large');

          chooseDefault(page, 'listSize', 'compact');
          chooseDefault(page, 'gridSize', 'large');
          closeAppDialogById(page.document, page.dialog.id);
          page.document.dispatch('click', { target: page.trigger });
          expect(page.fields.gridSize.value).toBe('large');
          expect(page.fields.listSize.value).toBe('compact');
          expect(page.grid.getAttribute('data-grid-size')).toBe('large');
          // Closing and reopening wrote nothing.
          expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
          expect(storage.has('creatorcrate-asset-list-size')).toBe(false);
          expect(storedValues(page).global).toMatchObject({ gridSize: 'default', listSize: 'large' });
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('lets an acknowledged activation replace a size preview, but keeps one chosen while it was pending', async () => {
        const page = makeLivePage();
        let release;
        const fetch = vi.fn()
          .mockResolvedValueOnce(acknowledgement('project', { global: GLOBAL, project: PROJECT }))
          .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const storage = stubStorage();
        installFetchGlobals(page, fetch);

        try {
          // The page's own Grid size control, through which acknowledged sizes apply.
          page.liveRegion.appendChild(makeElement('div', { 'data-asset-grid-size-controls': '' }));
          enhanceLive(page);
          chooseDefault(page, 'gridSize', 'compact');
          expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(loadedScope(page)).toBe('project');
          expect(page.fields.gridSize.value).toBe(PROJECT.gridSize);
          expect(storage.get('creatorcrate-asset-grid-size')).toBe(PROJECT.gridSize);
          expect(page.grid.getAttribute('data-grid-size')).toBe(PROJECT.gridSize);
          // The replaced preview is not put back by a later install.
          page.document.dispatch('project-assets-region-loaded');
          expect(page.grid.getAttribute('data-grid-size')).toBe(PROJECT.gridSize);

          changeProjectAssetsScope(page, 'global');
          await flush();
          chooseDefault(page, 'gridSize', 'compact');
          release(acknowledgement('global', { global: GLOBAL, project: PROJECT }));
          await flush();
          expect(loadedScope(page)).toBe('global');
          // The newer choice stands, in the control and on screen; storage got the acknowledged size.
          expect(page.fields.gridSize.value).toBe('compact');
          expect(storage.get('creatorcrate-asset-grid-size')).toBe(GLOBAL.gridSize);
          expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
          page.document.dispatch('project-assets-region-loaded');
          expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
          expect(posts(fetch)).toHaveLength(2);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      // Correction F (F8): a newer edit kept through an activation leaves the
      // untouched size fields on the activated scope's sizes in use.
      it('synchronizes untouched size fields after an activation that kept a newer edit', async () => {
        const page = makeLivePage();
        let releaseProject;
        let releaseGlobal;
        const fetch = vi.fn()
          .mockImplementationOnce(() => new Promise((resolve) => { releaseProject = resolve; }))
          .mockImplementationOnce(() => new Promise((resolve) => { releaseGlobal = resolve; }));
        const storage = stubStorage();
        installFetchGlobals(page, fetch);

        try {
          page.liveRegion.appendChild(makeElement('div', { 'data-asset-grid-size-controls': '' }));
          enhanceLive(page);
          // An older Grid preview, made before the activation starts.
          chooseDefault(page, 'gridSize', 'compact');
          const events = [];
          ['gridSize', 'listSize'].forEach((name) => {
            ['input', 'change'].forEach((type) => page.fields[name].addEventListener(type, () => events.push(`${name}:${type}`)));
          });

          // The reviewer's case: only Sort changes while Project only is pending.
          changeProjectAssetsScope(page, 'project');
          await flush();
          page.fields.sort.value = 'size';
          page.fields.sort.dispatch('change');
          releaseProject(acknowledgement('project', { global: GLOBAL, project: PROJECT }));
          await flush();
          expect(loadedScope(page)).toBe('project');
          expect(page.status.textContent).toBe(
            'Project-only defaults are active. Your newer changes were kept and are not saved.',
          );
          expect(page.fields.sort.value).toBe('size');
          // Both size fields follow the activated scope's sizes in use.
          expect(storedSizes(storage)).toEqual([PROJECT.gridSize, PROJECT.listSize]);
          expect(page.fields.gridSize.value).toBe(PROJECT.gridSize);
          expect(page.fields.listSize.value).toBe(PROJECT.listSize);
          expect(page.grid.getAttribute('data-grid-size')).toBe(PROJECT.gridSize);
          // The older preview is not put back by a later install.
          page.document.dispatch('project-assets-region-loaded');
          expect(page.grid.getAttribute('data-grid-size')).toBe(PROJECT.gridSize);
          expect(page.fields.gridSize.value).toBe(PROJECT.gridSize);

          // A List preview made while Global is pending stands; Grid follows Global.
          changeProjectAssetsScope(page, 'global');
          await flush();
          chooseDefault(page, 'listSize', 'large');
          events.length = 0;
          releaseGlobal(acknowledgement('global', { global: GLOBAL, project: PROJECT }));
          await flush();
          expect(loadedScope(page)).toBe('global');
          expect(storedSizes(storage)).toEqual([GLOBAL.gridSize, GLOBAL.listSize]);
          expect(page.fields.gridSize.value).toBe(GLOBAL.gridSize);
          expect(page.fields.listSize.value).toBe('large');
          // Global's Default grid size is shown without a size attribute.
          expect(page.grid.getAttribute('data-grid-size')).toBeNull();
          // Synchronizing sent no synthetic events and wrote nothing.
          expect(events).toEqual([]);
          expect(posts(fetch)).toHaveLength(2);
          expect(storedValues(page)).toEqual({ global: GLOBAL, project: PROJECT });
        } finally {
          vi.unstubAllGlobals();
        }
      });

      // Correction G (F9): a check made after a failed recovery read is still
      // the original activation's recovery, so edits made since it began stay.
      describe('Correction G F9 — failed scope recovery ownership', () => {
        const unreadable = () => ({ ok: true, status: 200, json: async () => { throw new Error('unreadable'); } });
        const gets = (fetch) => fetch.mock.calls.filter(([, init]) => init?.method === 'GET');

        it('keeps edits made during the activation through repeated failed reads and a GET-only check', async () => {
          const page = makeLivePage();
          let releasePost;
          const fetch = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }))
            .mockRejectedValueOnce(new Error('offline'))
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'project'));
          const storage = stubStorage();
          installFetchGlobals(page, fetch);

          try {
            page.liveRegion.appendChild(makeElement('div', { 'data-asset-grid-size-controls': '' }));
            enhanceLive(page);
            // An older List preview, made before the activation begins.
            chooseDefault(page, 'listSize', 'large');
            changeProjectAssetsScope(page, 'project');
            await flush();
            // Newer edits while the activation is unresolved.
            chooseDefault(page, 'gridSize', 'compact');
            page.fields.sort.value = 'size';
            page.fields.sort.dispatch('change');
            const events = [];
            ['gridSize', 'listSize'].forEach((name) => {
              ['input', 'change'].forEach((type) => page.fields[name].addEventListener(type, () => events.push(`${name}:${type}`)));
            });

            // Unreadable POST, then the automatic recovery read fails.
            releasePost(unreadable());
            await flush();
            await flush();
            expect(page.status.textContent).toBe(
              'Could not confirm whether the defaults scope changed. Choose a scope to check again, or reload the page.',
            );
            expect(loadedScope(page)).toBe('global');
            expect(page.fields.gridSize.value).toBe('compact');
            expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
            expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBe(
              'The active defaults scope could not be confirmed. Choose a scope to check it before saving.',
            );

            // A check that fails again keeps the original boundary.
            changeProjectAssetsScope(page, 'project');
            await flush();
            await flush();
            expect(page.status.textContent).toMatch(/Could not confirm/);
            expect(page.fields.gridSize.value).toBe('compact');

            // The successful GET-only check resolves Project only.
            changeProjectAssetsScope(page, 'project');
            await flush();
            await flush();
            expect(posts(fetch)).toHaveLength(1);
            expect(gets(fetch)).toHaveLength(3);
            expect(gets(fetch).every(([url]) => url === RETURN_TO)).toBe(true);
            expect(loadedScope(page)).toBe('project');
            expect(page.scopeControls.project.checked).toBe(true);
            expect(page.status.textContent).toBe(
              'Project-only defaults are active. Your newer changes were kept and are not saved.',
            );
            // The newer Grid size and Sort stand; the older List preview follows Project only.
            expect(page.fields.gridSize.value).toBe('compact');
            expect(page.fields.listSize.value).toBe(PROJECT.listSize);
            expect(page.fields.sort.value).toBe('size');
            expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
            expect(page.dropdowns.gridSize.panel.querySelectorAll('input').find((input) => input.checked).value)
              .toBe('compact');
            expect(page.dropdowns.listSize.panel.querySelectorAll('input').find((input) => input.checked).value)
              .toBe(PROJECT.listSize);
            expect(storedSizes(storage)).toEqual([PROJECT.gridSize, PROJECT.listSize]);
            // A later install keeps the newer preview.
            page.document.dispatch('project-assets-region-loaded');
            expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
            expect(events).toEqual([]);
            expect(storedValues(page)).toEqual({ global: GLOBAL, project: PROJECT });
            expect(projectAssetsDefaultsSaveBlockedReason(page.form)).toBeNull();
          } finally {
            vi.unstubAllGlobals();
          }
        });

        it('records choosing the size already shown during an unresolved activation, for that size only', async () => {
          const page = makeLivePage();
          let releasePost;
          const fetch = vi.fn()
            .mockResolvedValueOnce(acknowledgement('project', { global: GLOBAL, project: PROJECT }))
            .mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }))
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'global'));
          const storage = stubStorage();
          installFetchGlobals(page, fetch);
          const chooseShown = (name) => {
            const radio = page.dropdowns[name].panel.querySelectorAll('input')
              .find((input) => input.value === page.fields[name].value);
            expect(radio).toBeTruthy();
            page.fields[name].closest('[data-dialog-field]').dispatch('click', { target: radio });
          };

          try {
            page.liveRegion.appendChild(makeElement('div', { 'data-asset-grid-size-controls': '' }));
            enhanceLive(page);
            // Outside a scope operation, re-choosing the shown size is not an edit.
            chooseShown('listSize');
            changeProjectAssetsScope(page, 'project');
            await flush();
            expect(page.status.textContent).toBe('Project-only defaults loaded.');
            expect(page.fields.listSize.value).toBe(PROJECT.listSize);

            // While Global is unresolved, re-choosing the shown Grid size counts.
            changeProjectAssetsScope(page, 'global');
            await flush();
            chooseShown('gridSize');
            releasePost(unreadable());
            await flush();
            await flush();
            expect(page.status.textContent).toMatch(/Could not confirm/);
            changeProjectAssetsScope(page, 'global');
            await flush();
            await flush();
            expect(loadedScope(page)).toBe('global');
            expect(page.status.textContent).toBe(
              'Global defaults are active. Your newer changes were kept and are not saved.',
            );
            expect(page.fields.gridSize.value).toBe(PROJECT.gridSize);
            expect(page.grid.getAttribute('data-grid-size')).toBe(PROJECT.gridSize);
            // The untouched List size follows Global.
            expect(page.fields.listSize.value).toBe(GLOBAL.listSize);
            expect(storedSizes(storage)).toEqual([GLOBAL.gridSize, GLOBAL.listSize]);
            expect(posts(fetch)).toHaveLength(2);
          } finally {
            vi.unstubAllGlobals();
          }
        });

        it('keeps newer edits when the automatic recovery read succeeds at once', async () => {
          const page = makeLivePage();
          let releasePost;
          const fetch = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }))
            .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'project'));
          stubStorage();
          installFetchGlobals(page, fetch);

          try {
            enhanceLive(page);
            changeProjectAssetsScope(page, 'project');
            await flush();
            chooseDefault(page, 'listSize', 'large');
            releasePost(unreadable());
            await flush();
            await flush();
            expect(posts(fetch)).toHaveLength(1);
            expect(gets(fetch)).toHaveLength(1);
            expect(loadedScope(page)).toBe('project');
            expect(page.fields.listSize.value).toBe('large');
            expect(page.fields.gridSize.value).toBe(PROJECT.gridSize);
          } finally {
            vi.unstubAllGlobals();
          }
        });

        it('gives a later fresh activation its own boundary instead of the settled recovery ownership', async () => {
          const page = makeLivePage();
          let releasePost;
          const fetch = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }))
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'project'))
            // The fresh activation: unreadable, read fails, then a check.
            .mockResolvedValueOnce(unreadable())
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'global'));
          stubStorage();
          installFetchGlobals(page, fetch);

          try {
            enhanceLive(page);
            changeProjectAssetsScope(page, 'project');
            await flush();
            chooseDefault(page, 'gridSize', 'compact');
            releasePost(unreadable());
            await flush();
            await flush();
            changeProjectAssetsScope(page, 'project');
            await flush();
            await flush();
            expect(loadedScope(page)).toBe('project');
            expect(page.fields.gridSize.value).toBe('compact');

            // No edit during this activation: the loaded scope replaces everything.
            changeProjectAssetsScope(page, 'global');
            await flush();
            await flush();
            expect(page.status.textContent).toMatch(/Could not confirm/);
            changeProjectAssetsScope(page, 'global');
            await flush();
            await flush();
            expect(posts(fetch)).toHaveLength(2);
            expect(gets(fetch)).toHaveLength(4);
            expect(loadedScope(page)).toBe('global');
            expect(page.status.textContent).toBe('Global defaults loaded.');
            expect(projectAssetsDefaultValues(page.fields)).toEqual(GLOBAL);
          } finally {
            vi.unstubAllGlobals();
          }
        });
      });

      // Correction H (F10): Space on the checked size radio sends no click or
      // change in Chromium; while a scope operation is unresolved it is still an
      // explicit choice of that size.
      describe('Correction H F10 — keyboard choice of the shown size', () => {
        const unreadable = () => ({ ok: true, status: 200, json: async () => { throw new Error('unreadable'); } });
        const gets = (fetch) => fetch.mock.calls.filter(([, init]) => init?.method === 'GET');
        const radioFor = (page, name, value = page.fields[name].value) => page.dropdowns[name].panel
          .querySelectorAll('input').find((input) => input.value === value);
        // A Space press as the browser reports it: keydown (plus held-key
        // repeats), keyup, and optionally the keyboard click some browsers add.
        const pressSpace = (page, name, target, { repeats = 0, click = false, ...keys } = {}) => {
          const wrapper = page.fields[name].closest('[data-dialog-field]');
          wrapper.dispatch('keydown', { key: ' ', target, repeat: false, ...keys });
          for (let i = 0; i < repeats; i += 1) wrapper.dispatch('keydown', { key: ' ', target, repeat: true, ...keys });
          wrapper.dispatch('keyup', { key: ' ', target, ...keys });
          if (click) wrapper.dispatch('click', { target, detail: 0 });
        };

        it('keeps a Space-chosen Grid size through a failed recovery read and a GET-only check', async () => {
          const page = makeLivePage();
          let releasePost;
          const fetch = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }))
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'project'));
          const storage = stubStorage();
          installFetchGlobals(page, fetch);

          try {
            page.liveRegion.appendChild(makeElement('div', { 'data-asset-grid-size-controls': '' }));
            enhanceLive(page);
            changeProjectAssetsScope(page, 'project');
            await flush();
            releasePost(unreadable());
            await flush();
            await flush();
            expect(page.status.textContent).toMatch(/Could not confirm/);
            const events = [];
            ['gridSize', 'listSize'].forEach((name) => {
              ['input', 'change'].forEach((type) => page.fields[name].addEventListener(type, () => events.push(`${name}:${type}`)));
            });

            // Space on the checked Grid radio while the activation is unresolved.
            const shown = radioFor(page, 'gridSize');
            expect(shown.checked).toBe(true);
            pressSpace(page, 'gridSize', shown);
            changeProjectAssetsScope(page, 'project');
            await flush();
            await flush();

            expect(posts(fetch)).toHaveLength(1);
            expect(gets(fetch)).toHaveLength(2);
            expect(gets(fetch).every(([url]) => url === RETURN_TO)).toBe(true);
            expect(loadedScope(page)).toBe('project');
            expect(page.status.textContent).toBe(
              'Project-only defaults are active. Your newer changes were kept and are not saved.',
            );
            // The chosen Grid size stands; the untouched List size follows Project only.
            expect(page.fields.gridSize.value).toBe(GLOBAL.gridSize);
            expect(radioFor(page, 'gridSize').checked).toBe(true);
            expect(page.fields.listSize.value).toBe(PROJECT.listSize);
            expect(storedSizes(storage)).toEqual([PROJECT.gridSize, PROJECT.listSize]);
            expect(events).toEqual([]);
            expect(storedValues(page)).toEqual({ global: GLOBAL, project: PROJECT });
          } finally {
            vi.unstubAllGlobals();
          }
        });

        it('keeps a Space-chosen List size when the automatic recovery read succeeds at once', async () => {
          const page = makeLivePage();
          let releasePost;
          const fetch = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }))
            .mockResolvedValueOnce(html({ global: GLOBAL, project: PROJECT }, 'project'));
          stubStorage();
          installFetchGlobals(page, fetch);

          try {
            enhanceLive(page);
            changeProjectAssetsScope(page, 'project');
            await flush();
            pressSpace(page, 'listSize', radioFor(page, 'listSize'));
            releasePost(unreadable());
            await flush();
            await flush();
            expect(posts(fetch)).toHaveLength(1);
            expect(gets(fetch)).toHaveLength(1);
            expect(loadedScope(page)).toBe('project');
            expect(page.fields.listSize.value).toBe(GLOBAL.listSize);
            expect(page.fields.gridSize.value).toBe(PROJECT.gridSize);
          } finally {
            vi.unstubAllGlobals();
          }
        });

        it('records one press once and ignores repeats, other keys, other targets and settled scopes', async () => {
          const page = makeLivePage();
          let releasePost;
          const fetch = vi.fn()
            .mockResolvedValueOnce(acknowledgement('project', { global: GLOBAL, project: PROJECT }))
            .mockImplementationOnce(() => new Promise((resolve) => { releasePost = resolve; }));
          stubStorage();
          installFetchGlobals(page, fetch);
          const previews = [];
          const previewListSize = (scope, size) => previews.push(size);

          try {
            page.region.appendChild(page.trigger);
            installProjectAssetsResponseParser(page);
            enhanceDropdowns(page.document);
            enhanceProjectAssetsDefaultsScope(page.document, {
              beginRefresh: vi.fn(() => 31),
              refreshActivation: vi.fn(() => 'applied'),
              confirm: vi.fn(async () => true),
              previewListSize,
            });
            enhanceAppDialogs(page.document);
            page.document.dispatch('click', { target: page.trigger });

            // Outside a scope operation, Space on the shown size is not an edit.
            pressSpace(page, 'listSize', radioFor(page, 'listSize'));
            expect(previews).toEqual([]);
            changeProjectAssetsScope(page, 'project');
            await flush();
            expect(page.status.textContent).toBe('Project-only defaults loaded.');
            expect(page.fields.listSize.value).toBe(PROJECT.listSize);

            // Global is pending from here on.
            changeProjectAssetsScope(page, 'global');
            await flush();
            const shown = radioFor(page, 'listSize');
            const other = radioFor(page, 'listSize', GLOBAL.listSize);
            const summary = page.dropdowns.listSize.summary || page.dropdowns.listSize.querySelector?.('summary');
            // Space on the dropdown's summary, on an unchecked option, with a
            // modifier, or a keyup with no matching keydown: no size intent.
            if (summary) pressSpace(page, 'listSize', summary);
            pressSpace(page, 'listSize', other);
            pressSpace(page, 'listSize', shown, { ctrlKey: true });
            page.fields.listSize.closest('[data-dialog-field]').dispatch('keyup', { key: ' ', target: shown });
            // Held-key repeats alone are not a press.
            page.fields.listSize.closest('[data-dialog-field]').dispatch('keydown', { key: ' ', target: shown, repeat: true });
            page.fields.listSize.closest('[data-dialog-field]').dispatch('keyup', { key: ' ', target: shown });
            // Enter is not the radio's activation key.
            const wrapper = page.fields.listSize.closest('[data-dialog-field]');
            wrapper.dispatch('keydown', { key: 'Enter', target: shown });
            wrapper.dispatch('keyup', { key: 'Enter', target: shown });
            expect(previews).toEqual([]);

            // One held press with repeats and the keyboard click some browsers add: once.
            pressSpace(page, 'listSize', shown, { repeats: 5, click: true });
            expect(previews).toEqual([PROJECT.listSize]);
            // A later pointer choice of the same size is its own choice.
            await new Promise((resolve) => setTimeout(resolve, 0));
            page.fields.listSize.closest('[data-dialog-field]').dispatch('click', { target: shown, detail: 1 });
            expect(previews).toEqual([PROJECT.listSize, PROJECT.listSize]);
            expect(posts(fetch)).toHaveLength(2);
            releasePost(acknowledgement('global', { global: GLOBAL, project: PROJECT }));
            await flush();
            await flush();
            expect(loadedScope(page)).toBe('global');
            // The keyboard choice stands; the untouched Grid size follows Global.
            expect(page.fields.listSize.value).toBe(PROJECT.listSize);
            expect(page.fields.gridSize.value).toBe(GLOBAL.gridSize);
            expect(posts(fetch)).toHaveLength(2);
          } finally {
            vi.unstubAllGlobals();
          }
        });
      });

      it('puts the current style back on a newly installed region and shows it when the dialog reopens', async () => {
        const page = makeLivePage();
        const fetch = vi.fn();
        stubStorage();
        installFetchGlobals(page, fetch);

        try {
          enhanceLive(page);
          chooseDefault(page, 'gridStyle', 'cropped');

          // A filter load installs a region rendered with the saved style.
          const replacement = makeElement('ul', { class: 'asset-grid', 'data-grid-style': 'uncropped' });
          page.grid.replaceWith(replacement);
          page.document.dispatch('project-assets-region-loaded');
          expect(replacement.getAttribute('data-grid-style')).toBe('cropped');

          closeAppDialogById(page.document, page.dialog.id);
          page.document.dispatch('click', { target: page.trigger });
          expect(page.fields.gridStyle.value).toBe('cropped');
          expect(page.dropdowns.gridStyle.panel.querySelectorAll('input').find((input) => input.checked).value)
            .toBe('cropped');
          expect(replacement.getAttribute('data-grid-style')).toBe('cropped');
          // The unsaved style is still not a saved default.
          expect(storedValues(page).global.gridStyle).toBe('uncropped');
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('applies an activated scope\'s acknowledged style and keeps the current one when activation fails', async () => {
        const page = makeLivePage();
        const fetch = vi.fn()
          .mockResolvedValueOnce(json({ status: 'error', message: 'No changes were made.' }, { ok: false, status: 500 }))
          .mockResolvedValueOnce(acknowledgement('project', { global: GLOBAL, project: PROJECT }))
          .mockResolvedValueOnce(acknowledgement('global', { global: GLOBAL, project: PROJECT }));
        stubStorage();
        installFetchGlobals(page, fetch);

        try {
          enhanceLive(page);
          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(loadedScope(page)).toBe('global');
          expect(page.grid.getAttribute('data-grid-style')).toBe('uncropped');
          expect(page.fields.gridStyle.value).toBe('uncropped');

          // The mocked refresh reports nothing to reload, so the restyle is
          // the scope module's own doing.
          changeProjectAssetsScope(page, 'project');
          await flush();
          expect(loadedScope(page)).toBe('project');
          expect(page.fields.gridStyle.value).toBe(PROJECT.gridStyle);
          expect(page.grid.getAttribute('data-grid-style')).toBe('cropped');

          changeProjectAssetsScope(page, 'global');
          await flush();
          expect(loadedScope(page)).toBe('global');
          expect(page.fields.gridStyle.value).toBe(GLOBAL.gridStyle);
          expect(page.grid.getAttribute('data-grid-style')).toBe('uncropped');
          expect(posts(fetch).every(([, init]) => init.body.get('intent') === 'activate-scope')).toBe(true);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('leaves a form without the live-controls opt-in on its acknowledged-save restyle only', () => {
        const page = makeLivePage();
        page.form.removeAttribute('data-defaults-live-controls');
        stubStorage();
        installFetchGlobals(page, vi.fn());

        try {
          enhanceLive(page);
          chooseDefault(page, 'gridStyle', 'cropped');
          expect(page.grid.getAttribute('data-grid-style')).toBe('uncropped');
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });
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
    let slugValue = directorySlug.value;
    const recordSlugWrite = vi.fn((value) => { slugValue = value; });
    Object.defineProperty(directorySlug, 'value', {
      configurable: true,
      get: () => slugValue,
      set: recordSlugWrite,
    });

    expect(enhanceCategorySlugAutofill(page.document)).toBe(1);
    expect(enhanceCategorySlugAutofill(page.document)).toBe(1);
    displayName.value = '  My Cool Category!  ';
    const firstTab = displayName.dispatch('keydown', { key: 'Tab' });
    expect(firstTab.defaultPrevented).toBe(false);
    expect(directorySlug.value).toBe('my-cool-category');
    expect(recordSlugWrite).toHaveBeenCalledTimes(1);

    directorySlug.value = 'cool-cat';
    displayName.value = 'A different name';
    const secondTab = displayName.dispatch('keydown', { key: 'Tab' });
    expect(secondTab.defaultPrevented).toBe(false);
    expect(directorySlug.value).toBe('cool-cat');

    directorySlug.value = '';
    const reverseTab = displayName.dispatch('keydown', { key: 'Tab', shiftKey: true });
    expect(reverseTab.defaultPrevented).toBe(false);
    expect(directorySlug.value).toBe('');

    displayName.dispatch('keydown', { key: 'Tab' });
    expect(directorySlug.value).toBe('a-different-name');
  });
});

describe('Live project category mutations', () => {
  it('submits an autofilled add once and re-enhances the authoritative replacement', async () => {
    const page = makeCategoryDialogPage();
    const changed = vi.fn();
    page.document.addEventListener('project-asset-categories-changed', changed);
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
    enhanceProjectAssetCategoryManagement(page.document);
    expect(page.dialog.open).toBe(true);
    const addForm = page.initial.body.querySelector('#project-category-management-add-form');
    const displayName = addForm.querySelector('#add-displayName');
    const directorySlug = addForm.querySelector('#add-directorySlug');
    displayName.value = 'Project category';
    displayName.dispatch('keydown', { key: 'Tab' });
    expect(directorySlug.value).toBe('project-category');
    addForm.dispatch('submit', { submitter: page.initial.addSubmit });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch.mock.calls[0][0]).toBe('/projects/1/asset-categories');
    expect(page.windowObject.fetch.mock.calls[0][1].method).toBe('POST');
    expect(page.windowObject.fetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['returnTo', CATEGORY_MANAGEMENT_RETURN_TO],
      ['displayName', 'Project category'],
      ['directorySlug', 'project-category'],
      ['enabled', '0'],
      ['enabled', '1'],
    ]);
    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-category-label="Added category"]')).toBeTruthy();
    expect(page.dialog.querySelector('[data-category-management-status]').textContent).toBe('Category added.');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(page.document.activeElement?.id).toBe('add-displayName');

    const replacementAddForm = page.dialog.querySelector('#project-category-management-add-form');
    const replacementName = replacementAddForm.querySelector('#add-displayName');
    const replacementSlug = replacementAddForm.querySelector('#add-directorySlug');
    replacementName.value = 'Replacement category';
    replacementName.dispatch('keydown', { key: 'Tab' });
    expect(replacementSlug.value).toBe('replacement-category');

    page.windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    replacementAddForm.dispatch('submit', { submitter: replacementAddForm.querySelector('button') });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(2);
    const mountedBody = page.dialog.querySelector('.project-asset-category-management-dialog-body');
    const mountedAddForm = mountedBody.querySelector('#project-category-management-add-form');
    const mountedName = mountedAddForm.querySelector('#add-displayName');
    const mountedSlug = mountedAddForm.querySelector('#add-directorySlug');
    expect(mountedAddForm).toBe(replacementAddForm);
    expect(mountedName.value).toBe('Replacement category');
    expect(mountedSlug.value).toBe('replacement-category');
    expect(mountedBody.querySelector('[data-category-management-status]').textContent)
      .toMatch(/previous state was kept/i);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('submits the targeted delete after shared-dialog confirmation', async () => {
    const page = makeCategoryDialogPage();
    const changed = vi.fn();
    page.document.addEventListener('project-asset-categories-changed', changed);
    page.setReplacement(makeCategoryManagementBody({ categoryId: '2', categoryName: 'Remaining category' }));
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
    confirmation.confirm.dispatch('click');
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch.mock.calls[0][0]).toBe('/projects/1/asset-categories/1/delete');
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['returnTo', CATEGORY_MANAGEMENT_RETURN_TO],
    ]);
    expect(page.dialog.open).toBe(true);
    const mountedBody = page.dialog.querySelector('.project-asset-category-management-dialog-body');
    expect(mountedBody.querySelector('[data-category-id="1"]')).toBeNull();
    expect(mountedBody.querySelector('[data-category-id="2"][data-category-label="Remaining category"]')).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('targets the selected rename and preserves its server-rendered validation state', async () => {
    const page = makeCategoryDialogPage({ categoryId: '2' });
    const changed = vi.fn();
    page.document.addEventListener('project-asset-categories-changed', changed);
    page.setReplacement(makeCategoryManagementBody({ categoryId: '2', categoryName: 'Submitted name', invalidRename: true }));
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'Could not update the display name. Fix the field below and try again.',
        errors: { displayName: 'Display name is required.' },
        focus: 'name-2',
        html: '<server-rendered-rename-error>',
      }),
    });

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    enhanceConfirmations(page.document);
    enhanceProjectAssetCategoryManagement(page.document);
    expect(page.dialog.open).toBe(true);
    const renameForm = page.initial.body.querySelector('.category-name-form');
    renameForm.querySelector('[name="displayName"]').value = 'Submitted name';
    renameForm.dispatch('submit', { submitter: renameForm.querySelector('button') });
    await flush();

    expect(page.windowObject.fetch.mock.calls[0][0]).toBe('/projects/1/asset-categories/2/name');
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['returnTo', CATEGORY_MANAGEMENT_RETURN_TO],
      ['displayName', 'Submitted name'],
    ]);
    expect(page.dialog.open).toBe(true);
    const mountedBody = page.dialog.querySelector('.project-asset-category-management-dialog-body');
    const mountedRename = mountedBody.querySelector('#name-2');
    expect(mountedBody).not.toBe(page.initial.body);
    expect(mountedRename.getAttribute('aria-invalid')).toBe('true');
    expect(mountedRename.getAttribute('aria-describedby')).toBe('name-2-error');
    expect(mountedBody.querySelector('#name-2-error').textContent).toBe('Display name is required.');
    expect(mountedBody.querySelector('[data-category-label="Submitted name"]')).toBeTruthy();
    expect(mountedBody.querySelector('[data-category-management-status]').getAttribute('role')).toBe('alert');
    expect(page.document.activeElement).toBe(mountedRename);
    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('announces a confirmed rename after replacing the manager body', async () => {
    const page = makeCategoryDialogPage();
    page.setReplacement(makeCategoryManagementBody({ categoryName: 'Renamed' }));
    const changed = vi.fn();
    page.document.addEventListener('project-asset-categories-changed', changed);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', message: 'Category renamed.', html: '<manager-body>' }),
    });
    enhanceAppDialogs(page.document);
    enhanceProjectAssetCategoryManagement(page.document);

    const form = page.initial.body.querySelector('.category-name-form');
    form.dispatch('submit', { submitter: form.querySelector('button') });
    await flush();

    expect(page.dialog.querySelector('[data-category-label="Renamed"]')).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(page.dialog.close).not.toHaveBeenCalled();
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

  it('preserves independent Extension and Tag drafts for each scope', () => {
    const values = {
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: ['jpg', 'png'], tag: ['1', '2'] },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: ['png'], tag: ['2'] },
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
    expect(selectedValues(page.fields.tag)).toEqual(['1', '2']);
    changeProjectAssetsScope(page, 'project');
    expect(selectedValues(page.fields.extension)).toEqual(['png']);
    expect(selectedValues(page.fields.tag)).toEqual(['2']);

    selectValues(page.fields.tag, ['1']);
    expect(selectedValues(page.fields.extension)).toEqual(['png']);
    changeProjectAssetsScope(page, 'global');
    expect(selectedValues(page.fields.extension)).toEqual(['jpg']);
    expect(selectedValues(page.fields.tag)).toEqual(['1', '2']);
    changeProjectAssetsScope(page, 'project');
    expect(selectedValues(page.fields.extension)).toEqual(['png']);
    expect(selectedValues(page.fields.tag)).toEqual(['1']);
  });

  it('fails closed when a committed multi-select member is unavailable', () => {
    const values = {
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: ['jpg'], tag: 'all' },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: ['gif', 'png'], tag: ['2'] },
    };
    const page = makeDialogPage({ projectAssetsDefaults: true, projectAssetsScope: true, projectAssetsScopeValues: values });
    page.fields.extension.multiple = true;
    page.fields.tag.multiple = true;
    enhanceAppDialogs(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);

    page.document.dispatch('click', { target: page.trigger });
    changeProjectAssetsScope(page, 'project');

    expect(selectedValues(page.fields.extension)).toEqual(['jpg']);
    expect(selectedValues(page.fields.tag)).toEqual([]);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
    expect(page.form.querySelector('[data-dialog-error-text]').textContent).toMatch(/could not be changed safely/i);
  });

  it('restores committed neutral all values after discarding concrete drafts', () => {
    const values = {
      global: { view: 'grid', gridStyle: 'uncropped', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: ['jpg', 'png'], tag: ['1', '2'] },
      project: { view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'all', tag: 'all' },
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

    selectValues(page.fields.extension, ['png']);
    selectValues(page.fields.tag, ['2']);
    expect(selectedValues(page.fields.extension)).toEqual(['png']);
    expect(selectedValues(page.fields.tag)).toEqual(['2']);
    closeAppDialogById(page.document, page.dialog.id);
    page.document.dispatch('click', { target: page.trigger });
    expect(selectedValues(page.fields.extension)).toEqual(['jpg', 'png']);
    expect(selectedValues(page.fields.tag)).toEqual(['1', '2']);

    changeProjectAssetsScope(page, 'project');
    expect(selectedValues(page.fields.extension)).toEqual([]);
    expect(selectedValues(page.fields.tag)).toEqual([]);
  });
});

describe('Release Edit async dialog submission', () => {
  const PREFIX = 'release-edit-field-';

  function makeReleaseEditPage({ selected = ['x'], saveDisabled = false, platformError = null } = {}) {
    const page = makeDialogPage();
    const { document, dialog, form } = page;
    dialog.setAttribute('id', 'release-edit-dialog');
    page.trigger.setAttribute('data-dialog-open', 'release-edit-dialog');
    page.region.appendChild(page.trigger);
    form.setAttribute('id', 'release-edit-form');
    form.setAttribute('action', '/releases/7');
    form.setAttribute('data-dialog-reset-on-close', '');
    form.setAttribute('data-dialog-pending-message', 'Saving release…');
    form.setAttribute('data-dialog-success-message', 'Release updated.');
    form.setAttribute('data-dialog-error-message', 'Release could not be saved.');
    form.setAttribute('data-dialog-network-error-message', 'Could not save the release. Check your connection and try again.');
    // The generic page's own fields and in-form Save are replaced by Release's.
    Object.values(page.fields).forEach((select) => select.parentNode.remove());
    page.save.remove();

    const titleField = makeElement('div', { class: 'field', 'data-dialog-field': 'title' });
    const title = makeElement('input', { type: 'text', id: `${PREFIX}title`, name: 'title', value: 'Release' });
    titleField.appendChild(title);
    form.appendChild(titleField);

    const dateField = makeElement('div', { class: 'field', 'data-dialog-field': 'plannedDate' });
    const plannedDate = makeElement('input', {
      type: 'date', id: `${PREFIX}plannedDate`, name: 'plannedDate', value: '2031-01-02',
      'aria-describedby': `${PREFIX}plannedDate-help`,
    });
    dateField.appendChild(plannedDate);
    form.appendChild(dateField);

    const platformsField = makeElement('div', {
      class: 'field release-platforms-field',
      'data-dialog-field': 'selectedPlatforms',
      'data-dialog-error-ref': `${PREFIX}selectedPlatforms-error`,
    });
    platformsField.appendChild(makeElement('input', { type: 'hidden', name: 'selectedPlatformsPresent', value: '1' }));
    const details = makeElement('details', {
      id: `${PREFIX}platforms`, 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'multiple',
      'data-cc-dropdown-empty-summary': 'No platforms selected', 'data-cc-dropdown-count-label': 'platforms',
    });
    const summary = makeElement('summary', { id: `${PREFIX}platforms-trigger` });
    const current = makeElement('span', { 'data-cc-dropdown-summary-current': '' });
    summary.appendChild(current);
    details.appendChild(summary);
    const checkboxes = {};
    for (const [index, platform] of ['x', 'bluesky'].entries()) {
      const label = makeElement('label');
      const checkbox = makeElement('input', {
        type: 'checkbox', id: `${PREFIX}platforms-option-${index + 1}`, name: 'selectedPlatforms', value: platform,
      });
      checkbox.checked = selected.includes(platform);
      label.appendChild(checkbox);
      const text = makeElement('span');
      text.textContent = platform;
      label.appendChild(text);
      details.appendChild(label);
      checkboxes[platform] = checkbox;
    }
    // The multi-select macro wraps the dropdown in its own fieldset, which the
    // server marks with field-error alongside the summary and checkboxes.
    const platformsFieldset = makeElement('fieldset', {
      class: `field asset-filter-multiselect-field asset-viewer-filter-field${platformError ? ' field-error' : ''}`,
    });
    platformsFieldset.appendChild(details);
    platformsField.appendChild(platformsFieldset);
    if (platformError) {
      for (const element of [summary, ...Object.values(checkboxes)]) {
        element.setAttribute('aria-describedby', `${PREFIX}selectedPlatforms-error`);
        element.setAttribute('aria-invalid', 'true');
      }
      const message = makeElement('span', { class: 'field-error-message', id: `${PREFIX}selectedPlatforms-error` });
      message.textContent = platformError;
      platformsField.appendChild(message);
    }
    form.appendChild(platformsField);

    const initial = form.querySelectorAll('input').map((control) => ({ control, value: control.value, checked: control.checked }));
    form.reset = vi.fn(() => {
      initial.forEach(({ control, value, checked }) => {
        control.value = value;
        control.checked = checked;
      });
    });

    // Release's Save sits in the dialog footer, associated through form="…".
    const footer = makeElement('footer');
    const save = makeElement('button', { type: 'submit', form: 'release-edit-form', 'data-dialog-submit': '' });
    save.form = form;
    if (saveDisabled) save.disabled = true;
    footer.appendChild(save);
    dialog.querySelector('.app-dialog-card, div').appendChild(footer);
    document.body.appendChild(dialog);

    return { ...page, title, plannedDate, platformsField, platformsFieldset, details, summary, current, checkboxes, save };
  }

  function checkedPlatforms(page) {
    return Object.values(page.checkboxes).filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  }

  function submittedBody(page, call = 0) {
    return new URLSearchParams(page.windowObject.fetch.mock.calls[call][1].body);
  }

  it('submits a repeated platform group and keeps the draft through structured validation errors', async () => {
    const page = makeReleaseEditPage({ selected: ['x'] });
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        code: 'VALIDATION_FAILED',
        message: 'Fix the highlighted fields and try again.',
        errors: { title: 'Title is required.', selectedPlatforms: 'Cannot deselect a platform while its preparation session is active.' },
        values: { title: '', selectedPlatforms: ['bluesky'] },
      }),
    });
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    page.title.value = '';
    page.checkboxes.x.checked = false;
    page.checkboxes.bluesky.checked = true;
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    const body = submittedBody(page);
    expect(body.getAll('selectedPlatforms')).toEqual(['bluesky']);
    expect(body.get('selectedPlatformsPresent')).toBe('1');
    expect(page.windowObject.fetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });

    expect(page.dialog.open).toBe(true);
    expect(page.title.value).toBe('');
    expect(checkedPlatforms(page)).toEqual(['bluesky']);
    expect(page.title.getAttribute('aria-invalid')).toBe('true');
    expect(page.title.getAttribute('aria-describedby')).toBe(`${PREFIX}title-error`);
    expect(page.platformsField.querySelectorAll('.field-error-message')).toHaveLength(1);
    const platformError = page.platformsField.querySelector('.field-error-message');
    expect(platformError.id).toBe(`${PREFIX}selectedPlatforms-error`);
    expect(platformError.textContent).toBe('Cannot deselect a platform while its preparation session is active.');
    for (const element of [...Object.values(page.checkboxes), page.summary]) {
      expect(element.getAttribute('aria-invalid')).toBe('true');
      expect(element.getAttribute('aria-describedby')).toBe(`${PREFIX}selectedPlatforms-error`);
    }
    expect(page.platformsField.classList.contains('field-error')).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-error]').hidden).toBe(false);
    expect(page.dialog.querySelector('[data-dialog-error-text]').textContent).toBe('Fix the highlighted fields and try again.');
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('Fix the highlighted fields and try again.');
  });

  it('keeps help-text references while showing and clearing errors, then adopts the saved model as its baseline', async () => {
    const page = makeReleaseEditPage({ selected: ['x'] });
    page.windowObject.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          message: 'Fix the highlighted fields and try again.',
          errors: { plannedDate: 'Enter a valid date.' },
          values: { plannedDate: '2031-02-30', selectedPlatforms: ['x', 'bluesky'] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          message: 'Release updated.',
          values: { title: 'Saved release', plannedDate: '2031-03-01', selectedPlatforms: ['x', 'bluesky'] },
        }),
      });
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.checkboxes.bluesky.checked = true;
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.plannedDate.getAttribute('aria-describedby')).toBe(`${PREFIX}plannedDate-help ${PREFIX}plannedDate-error`);
    expect(page.dialog.querySelectorAll('.field-error-message').map((message) => message.id)).toEqual([`${PREFIX}plannedDate-error`]);
    expect(checkedPlatforms(page)).toEqual(['x', 'bluesky']);

    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(false);
    expect(page.plannedDate.getAttribute('aria-describedby')).toBe(`${PREFIX}plannedDate-help`);
    expect(page.plannedDate.getAttribute('aria-invalid')).toBeNull();
    expect(page.dialog.querySelector('.field-error-message')).toBeNull();
    expect(page.document.querySelector('[data-dialog-feedback-text]').textContent).toBe('Release updated.');
    // Closing reset the form to its server-rendered markup; reopening restores the confirmed save.
    expect(page.form.reset).toHaveBeenCalled();
    page.document.dispatch('click', { target: page.trigger });
    expect(page.title.value).toBe('Saved release');
    expect(page.plannedDate.value).toBe('2031-03-01');
    expect(checkedPlatforms(page)).toEqual(['x', 'bluesky']);
  });

  it('disables the external Save while pending, ignores duplicate submits, and restores prior disabled states', async () => {
    const page = makeReleaseEditPage();
    const alreadyDisabled = makeElement('button', { type: 'submit', form: 'release-edit-form', 'data-dialog-submit': '' });
    alreadyDisabled.form = page.form;
    alreadyDisabled.disabled = true;
    page.save.parentNode.appendChild(alreadyDisabled);
    const unrelated = makeElement('button', { type: 'submit', form: 'other-form', 'data-dialog-submit': '' });
    page.save.parentNode.appendChild(unrelated);
    let resolveRequest;
    page.windowObject.fetch.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledOnce();
    expect(page.save.disabled).toBe(true);
    expect(page.save.hasAttribute('disabled')).toBe(true);
    expect(unrelated.disabled).toBe(false);
    expect(page.form.getAttribute('aria-busy')).toBe('true');
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('Saving release…');

    resolveRequest({ ok: false, status: 500, json: async () => ({ status: 'error', code: 'SERVER_ERROR', message: 'Release update failed. Please try again.' }) });
    await flush();

    expect(page.save.disabled).toBe(false);
    expect(page.save.hasAttribute('disabled')).toBe(false);
    expect(alreadyDisabled.disabled).toBe(true);
    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('Release update failed. Please try again.');
    expect(page.dialog.querySelector('.field-error-message')).toBeNull();
  });

  it('keeps the draft and reports Release wording when the request fails', async () => {
    const page = makeReleaseEditPage({ selected: [] });
    page.windowObject.fetch.mockRejectedValue(new Error('offline'));
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.title.value = 'Unsaved draft';
    page.checkboxes.bluesky.checked = true;
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.title.value).toBe('Unsaved draft');
    expect(checkedPlatforms(page)).toEqual(['bluesky']);
    expect(page.save.disabled).toBe(false);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent)
      .toBe('Could not save the release. Check your connection and try again.');
    expect(page.dialog.querySelector('[data-dialog-error-text]').textContent)
      .toBe('Release could not be saved. Your selections were kept.');
  });

  it('adopts an authoritative loaded model as the baseline for later opens and dismissals', () => {
    const page = makeReleaseEditPage({ selected: ['x'] });
    enhanceAppDialogs(page.document);

    expect(setAppDialogBaseline(page.document, 'release-edit-dialog', {
      title: 'Loaded release', plannedDate: '', selectedPlatforms: ['bluesky'],
    })).toBe(true);
    expect(page.title.value).toBe('Loaded release');
    expect(checkedPlatforms(page)).toEqual(['bluesky']);

    page.document.dispatch('click', { target: page.trigger });
    page.title.value = 'Abandoned draft';
    page.checkboxes.x.checked = true;
    page.close.dispatch('click');
    page.document.dispatch('click', { target: page.trigger });

    expect(page.title.value).toBe('Loaded release');
    expect(page.plannedDate.value).toBe('');
    expect(checkedPlatforms(page)).toEqual(['bluesky']);
    expect(setAppDialogBaseline(page.document, 'missing-dialog', {})).toBe(false);
  });

  it('clears a server-rendered Platforms fieldset error on hydration and restores field styling on a new error', async () => {
    const page = makeReleaseEditPage({ selected: ['x'], platformError: 'Choose a supported platform.' });
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'Fix the highlighted fields and try again.',
        errors: { selectedPlatforms: 'Cannot deselect a platform while its preparation session is active.' },
        values: { selectedPlatforms: [] },
      }),
    });
    enhanceAppDialogs(page.document);
    expect(page.platformsFieldset.classList.contains('field-error')).toBe(true);

    // Invalid -> valid: every obsolete error presentation clears.
    setAppDialogBaseline(page.document, 'release-edit-dialog', { title: 'Loaded release', selectedPlatforms: ['bluesky'] });
    expect(page.platformsFieldset.classList.contains('field-error')).toBe(false);
    expect(page.platformsFieldset.classList.contains('asset-filter-multiselect-field')).toBe(true);
    expect(page.platformsFieldset.classList.contains('asset-viewer-filter-field')).toBe(true);
    expect(page.platformsField.classList.contains('field-error')).toBe(false);
    expect(page.platformsField.classList.contains('release-platforms-field')).toBe(true);
    expect(page.platformsField.querySelector('.field-error-message')).toBeNull();
    for (const element of [...Object.values(page.checkboxes), page.summary]) {
      expect(element.getAttribute('aria-invalid')).toBeNull();
      expect(element.getAttribute('aria-describedby')).toBeNull();
    }
    expect(checkedPlatforms(page)).toEqual(['bluesky']);

    // Valid -> invalid: the field wrapper's error class and associations return.
    page.document.dispatch('click', { target: page.trigger });
    page.checkboxes.bluesky.checked = false;
    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    expect(page.platformsField.classList.contains('field-error')).toBe(true);
    expect(page.platformsField.querySelectorAll('.field-error-message').map((message) => message.id))
      .toEqual([`${PREFIX}selectedPlatforms-error`]);
    for (const element of [...Object.values(page.checkboxes), page.summary]) {
      expect(element.getAttribute('aria-invalid')).toBe('true');
      expect(element.getAttribute('aria-describedby')).toBe(`${PREFIX}selectedPlatforms-error`);
    }
  });

  it('restores the hydrated baseline immediately on dismissal and adopts each newly loaded release', async () => {
    const page = makeReleaseEditPage({ selected: ['x'] });
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'Fix the highlighted fields and try again.',
        errors: { title: 'Title is required.' },
        values: { title: '', selectedPlatforms: ['x', 'bluesky'] },
      }),
    });
    enhanceAppDialogs(page.document);
    // The page markup holds Release A (title "Release", platform x).

    setAppDialogBaseline(page.document, 'release-edit-dialog', {
      title: 'Loaded release', plannedDate: '2031-05-06', selectedPlatforms: ['bluesky'],
    });
    page.document.dispatch('click', { target: page.trigger });
    page.title.value = '';
    page.checkboxes.x.checked = true;
    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    // A failed save keeps the draft while the dialog stays open.
    expect(page.dialog.open).toBe(true);
    expect(page.title.value).toBe('');
    expect(checkedPlatforms(page)).toEqual(['x', 'bluesky']);
    expect(page.title.getAttribute('aria-invalid')).toBe('true');

    page.close.dispatch('click');
    // Checked right after dismissal, without reopening.
    expect(page.dialog.open).toBe(false);
    expect(page.form.reset).toHaveBeenCalled();
    expect(page.title.value).toBe('Loaded release');
    expect(page.plannedDate.value).toBe('2031-05-06');
    expect(checkedPlatforms(page)).toEqual(['bluesky']);
    expect(page.current.textContent).toBe('bluesky');
    expect(page.title.getAttribute('aria-invalid')).toBeNull();
    expect(page.dialog.querySelector('.field-error-message')).toBeNull();
    expect(page.dialog.querySelector('[data-dialog-error]').hidden).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('');

    // Loading another release replaces the baseline; nothing of the first survives.
    const loaded = { title: 'Second release', plannedDate: '', selectedPlatforms: ['x'] };
    setAppDialogBaseline(page.document, 'release-edit-dialog', loaded);
    loaded.selectedPlatforms.push('bluesky');
    page.document.dispatch('click', { target: page.trigger });
    page.title.value = 'Abandoned draft';
    page.checkboxes.bluesky.checked = true;
    page.close.dispatch('click');
    expect(page.title.value).toBe('Second release');
    expect(page.plannedDate.value).toBe('');
    expect(checkedPlatforms(page)).toEqual(['x']);
    expect(page.current.textContent).toBe('x');
  });
});
