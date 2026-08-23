/**
 * Client-side preset management UI for the Convert / Workflow Prompt /
 * Watermark processing dialogs (/projects/:id/assets).
 *
 * This exercises the real enhanceProcessingDialogs() wiring against a small,
 * purpose-built DOM shim (no jsdom dependency in this project) that mirrors
 * the actual markup produced by presetSection()/planFooter() in
 * processing-dialogs.njk. It proves: Save as preset, Update, Rename,
 * Delete, Modified-from-preset tracking, selector refresh, Preview
 * invalidation, and that preset payloads never carry runtime-only scope
 * state (projectId/assetIds/categoryId/directory/recursive/scope).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decorateWatermarkDropdownOptions, enhanceProcessingDialogs, syncWatermarkFormatSettings } from '../src/static/processing.js';
import { enhanceAppDialogs, enhanceNumberInputs } from '../src/static/creatorcrate.js';

// ─── Minimal DOM shim ─────────────────────────────────────────────────────

function splitSelectorGroups(selector) {
  return selector.split(',').map((part) => part.trim()).filter(Boolean);
}

function splitCompoundParts(group) {
  return group.split(/\s+/).filter(Boolean);
}

function matchesSimple(node, part) {
  if (!node || node.nodeType !== 1) return false;
  if (part.startsWith('#')) return node.id === part.slice(1);
  let rest = part;
  if (rest.includes(':checked')) {
    if (!node.checked) return false;
    rest = rest.replace(':checked', '');
  }
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    if (node.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  for (const [, cls] of rest.matchAll(/\.([\w-]+)/g)) {
    if (!node.classList.contains(cls)) return false;
  }
  for (const [, name, expected] of rest.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (expected !== undefined && actual !== expected) return false;
  }
  return true;
}

function matchesChain(node, parts) {
  const selfPart = parts[parts.length - 1];
  if (!matchesSimple(node, selfPart)) return false;
  if (parts.length === 1) return true;
  let ancestorIndex = parts.length - 2;
  let current = node.parentNode;
  while (current && ancestorIndex >= 0) {
    if (matchesSimple(current, parts[ancestorIndex])) ancestorIndex -= 1;
    current = current.parentNode;
  }
  return ancestorIndex < 0;
}

function makeNode(tagName, attrs = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    parentElement: null,
    ownerDocument: null,
    __attrs: new Map(),
    __listeners: [],
    dataset: {},
    hidden: false,
    disabled: false,
    __checked: false,
    textContent: '',
    classList: {
      values: new Set(),
      add(...names) { names.forEach((n) => this.values.add(n)); },
      remove(...names) { names.forEach((n) => this.values.delete(n)); },
      toggle(name, force) {
        const next = force === undefined ? !this.values.has(name) : force;
        if (next) this.values.add(name); else this.values.delete(name);
        return next;
      },
      contains(name) { return this.values.has(name); },
    },
    setAttribute(name, rawValue) {
      const value = String(rawValue);
      this.__attrs.set(name, value);
      if (name === 'checked') this.checked = true;
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
      if (name === 'class') value.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
      if (name.startsWith('data-')) {
        this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
    },
    getAttribute(name) { return this.__attrs.has(name) ? this.__attrs.get(name) : null; },
    hasAttribute(name) { return this.__attrs.has(name); },
    removeAttribute(name) {
      this.__attrs.delete(name);
      if (name === 'hidden') this.hidden = false;
      if (name === 'disabled') this.disabled = false;
      if (name.startsWith('data-')) {
        delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      }
    },
    matches(selector) {
      return splitSelectorGroups(selector).some((group) => matchesChain(this, splitCompoundParts(group)));
    },
    closest(selector) {
      const parts = splitSelectorGroups(selector);
      let current = this;
      while (current) {
        if (parts.some((part) => matchesSimple(current, part))) return current;
        current = current.parentNode;
      }
      return null;
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    appendChild(child) {
      if (child.parentNode) child.remove();
      this.children.push(child);
      child.parentNode = this;
      child.parentElement = this;
      const doc = this.ownerDocument || (this.nodeType === 9 ? this : null);
      const adopt = (n) => { n.ownerDocument = doc; n.children.forEach(adopt); };
      adopt(child);
      if (this.tagName === 'SELECT' && child.tagName === 'OPTION') this.options.push(child);
      return child;
    },
    insertBefore(child, referenceNode) {
      if (child.parentNode) child.remove();
      const index = this.children.indexOf(referenceNode);
      if (index < 0) return this.appendChild(child);
      this.children.splice(index, 0, child);
      child.parentNode = this;
      child.parentElement = this;
      const doc = this.ownerDocument || (this.nodeType === 9 ? this : null);
      const adopt = (n) => { n.ownerDocument = doc; n.children.forEach(adopt); };
      adopt(child);
      return child;
    },
    append(...nodes) { nodes.forEach((n) => { if (n && typeof n === 'object') this.appendChild(n); }); },
    remove() {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      if (parent.tagName === 'SELECT') {
        const optionIndex = parent.options.indexOf(this);
        if (optionIndex >= 0) parent.options.splice(optionIndex, 1);
      }
      this.parentNode = null;
      this.parentElement = null;
    },
    cloneNode(deep) {
      const clone = makeNode(this.tagName.toLowerCase());
      this.__attrs.forEach((value, name) => clone.setAttribute(name, value));
      clone.checked = this.checked;
      clone.value = this.value;
      clone.textContent = this.textContent;
      if (deep) this.children.forEach((child) => clone.appendChild(child.cloneNode(true)));
      return clone;
    },
    addEventListener(type, handler) { this.__listeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const index = this.__listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (index >= 0) this.__listeners.splice(index, 1);
    },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: props.target || this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      let node = event.target;
      while (node) {
        node.__listeners.filter((l) => l.type === type).forEach((l) => l.handler(event));
        node = node.parentNode;
      }
      return event;
    },
    dispatchEvent(event) { return this.dispatch(event.type, { ...event, target: this }); },
    focus() { this.focused = true; },
    querySelectorAll(selector) {
      const groups = splitSelectorGroups(selector).map(splitCompoundParts);
      const result = [];
      const visit = (node) => {
        node.children.forEach((child) => {
          if (groups.some((parts) => matchesChain(child, parts))) result.push(child);
          visit(child);
        });
      };
      visit(this);
      return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
  if (node.tagName === 'SELECT') node.options = [];
  if (node.tagName === 'TEMPLATE') node.content = makeNode('template-content');
  // id/name/type/value are reflected attributes in real DOM: plain property
  // assignment (as processing.js does for rule-row radio names) must stay
  // visible to attribute-based selector matching, so back them by __attrs.
  ['id', 'name', 'type', 'value'].forEach((attrName) => {
    Object.defineProperty(node, attrName, {
      get() { return node.__attrs.has(attrName) ? node.__attrs.get(attrName) : ''; },
      set(value) { node.__attrs.set(attrName, String(value)); },
    });
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set() { node.children.slice().forEach((child) => child.remove()); },
  });
  // Real radio inputs sharing a `name` are mutually exclusive within their
  // tree; the shim has no native form association, so emulate it here.
  Object.defineProperty(node, 'checked', {
    get() { return node.__checked; },
    set(value) {
      node.__checked = value;
      if (value && node.type === 'radio' && node.name) {
        let top = node;
        while (top.parentNode) top = top.parentNode;
        top.querySelectorAll(`input[type="radio"][name="${node.name}"]`).forEach((radio) => {
          if (radio !== node) radio.__checked = false;
        });
      }
    },
  });
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function makeDocument() {
  const doc = makeNode('document');
  doc.nodeType = 9;
  doc.ownerDocument = doc;
  doc.getElementById = (id) => doc.querySelector(`#${id}`);
  doc.createElement = (tag) => makeNode(tag);
  doc.defaultView = {
    Event: function FakeEvent(type, opts) { this.type = type; Object.assign(this, opts); },
    confirm: vi.fn(() => true),
    location: { search: '' },
    URLSearchParams,
  };
  return doc;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// ─── Fixture builders (mirror processing-dialogs.njk output) ────────────

function addOption(select, value, label = value) {
  const option = makeNode('option', { value });
  option.textContent = label;
  select.appendChild(option);
  return option;
}

function buildField(doc, { field, type, tag = 'input', inputType = 'text', omitIfEmpty = false, checked, value, options } = {}) {
  const attrs = { 'data-processing-field': field, 'data-processing-type': type };
  if (omitIfEmpty) attrs['data-processing-omit-if-empty'] = 'true';
  if (tag === 'select') {
    const select = makeNode('select', attrs);
    (options || []).forEach(([v, label]) => addOption(select, v, label));
    if (value !== undefined) select.value = value;
    return select;
  }
  if (inputType === 'checkbox') {
    const input = makeNode('input', { ...attrs, type: 'checkbox' });
    input.checked = Boolean(checked);
    return input;
  }
  const input = makeNode('input', { ...attrs, type: inputType });
  if (value !== undefined) input.value = value;
  return input;
}

function buildPresetSection(prefix) {
  const wrap = makeNode('div', { class: 'field app-dialog-field' });
  const select = makeNode('select', { 'data-processing-preset-select': '' });
  addOption(select, '', 'Custom');
  wrap.appendChild(select);
  const modified = makeNode('p', { 'data-processing-preset-modified': '', hidden: '' });
  wrap.appendChild(modified);

  const actions = makeNode('div', { 'data-processing-preset-actions': '' });
  const saveBtn = makeNode('button', { type: 'button', 'data-processing-preset-save': '' });
  const updateBtn = makeNode('button', { type: 'button', 'data-processing-preset-update': '', disabled: '' });
  const renameBtn = makeNode('button', { type: 'button', 'data-processing-preset-rename': '', disabled: '' });
  const deleteBtn = makeNode('button', { type: 'button', 'data-processing-preset-delete': '', disabled: '' });
  const exportBtn = makeNode('button', { type: 'button', 'data-processing-preset-export': '', disabled: '' });
  const importBtn = makeNode('button', { type: 'button', 'data-processing-preset-import': '' });
  const importInput = makeNode('input', { type: 'file', 'data-processing-preset-import-input': '', hidden: '' });
  importInput.files = [];
  actions.append(saveBtn, updateBtn, renameBtn, deleteBtn, exportBtn, importBtn, importInput);
  wrap.appendChild(actions);

  const nameForm = makeNode('form', { 'data-processing-preset-name-form': '', hidden: '' });
  const label = makeNode('label', { 'data-processing-preset-name-label': '' });
  const nameInput = makeNode('input', { type: 'text', 'data-processing-preset-name-input': '' });
  nameForm.append(label, nameInput);
  const submit = makeNode('button', { type: 'submit', 'data-processing-preset-name-submit': '' });
  const cancel = makeNode('button', { type: 'button', 'data-processing-preset-name-cancel': '' });
  nameForm.append(submit, cancel);
  wrap.appendChild(nameForm);

  return {
    wrap, select, modified, saveBtn, updateBtn, renameBtn, deleteBtn, exportBtn, importBtn, importInput,
    nameForm, nameInput, cancel,
  };
}

function buildPlanFooter() {
  const error = makeNode('div', { 'data-processing-error': '', hidden: '' });
  const errorText = makeNode('p', { 'data-processing-error-text': '' });
  error.appendChild(errorText);
  const plan = makeNode('div', { 'data-processing-plan': '', hidden: '' });
  const result = makeNode('div', { 'data-processing-result': '', hidden: '' });
  const status = makeNode('div', { 'data-processing-status': '' });
  const previewBtn = makeNode('button', { type: 'button', 'data-processing-preview': '' });
  const applyBtn = makeNode('button', { type: 'button', 'data-processing-apply': '', disabled: '' });
  return { error, errorText, plan, result, status, previewBtn, applyBtn, nodes: [error, plan, result, status, previewBtn, applyBtn] };
}

function mountDialog(doc, dialogId, root) {
  const dialog = makeNode('dialog', { id: dialogId });
  dialog.appendChild(root);
  const trigger = makeNode('button', { type: 'button', 'data-dialog-open': dialogId });
  doc.appendChild(dialog);
  doc.appendChild(trigger);
  return { dialog, trigger };
}

function attachSharedConfirmationDialog(doc) {
  const dialog = makeNode('dialog', { id: 'app-confirmation-dialog', 'data-app-dialog': '' });
  const title = makeNode('h2', { id: 'app-confirmation-dialog-title' });
  title.textContent = 'Confirm action';
  const message = makeNode('p', { 'data-app-dialog-confirmation-message': '' });
  const close = makeNode('button', { type: 'button', 'data-dialog-close': '' });
  const cancel = makeNode('button', { type: 'button', 'data-dialog-close': '', 'data-app-dialog-confirmation-cancel': '' });
  const confirm = makeNode('button', { type: 'button', 'data-app-dialog-confirmation-confirm': '' });
  confirm.textContent = 'Confirm';
  dialog.showModal = vi.fn(() => { dialog.open = true; dialog.setAttribute('open', ''); });
  dialog.close = vi.fn(() => { dialog.open = false; dialog.removeAttribute('open'); dialog.dispatch('close'); });
  dialog.append(title, message, close, cancel, confirm);
  doc.appendChild(dialog);
  return { dialog, title, message, close, cancel, confirm };
}

function attachEnhancedPresetDropdown(fixture) {
  const dropdown = makeNode('details', { 'data-cc-dropdown': '' });
  const summary = makeNode('summary');
  dropdown.appendChild(summary);
  fixture.preset.wrap.appendChild(dropdown);
  return summary;
}

function buildConvertRoot(doc, projectId = '1') {
  const root = makeNode('div', {
    'data-processing-root': '', 'data-processing-operation': 'convert',
    'data-project-id': projectId, 'data-csrf': 'csrf-token',
  });
  const preset = buildPresetSection('convert');
  root.appendChild(preset.wrap);
  const format = buildField(doc, { field: 'format', type: 'string', tag: 'select', options: [['png', 'PNG'], ['webp', 'WebP']], value: 'webp' });
  const quality = buildField(doc, { field: 'quality', type: 'int', omitIfEmpty: true, value: '' });
  const originalHandling = buildField(doc, { field: 'originalHandling', type: 'string', tag: 'select', options: [['keep', 'Keep'], ['delete', 'Delete']], value: 'keep' });
  root.append(format, quality, originalHandling);
  const footer = buildPlanFooter();
  footer.nodes.forEach((node) => root.appendChild(node));
  const mounted = mountDialog(doc, 'processing-convert-dialog', root);
  return { root, preset, format, quality, originalHandling, footer, ...mounted };
}

function buildRuleRowTemplate() {
  const template = makeNode('template', { 'data-processing-rule-row-template': '' });
  const row = makeNode('li', { 'data-processing-rule-row': '' });
  const type = makeNode('div', { 'data-processing-rule-type': '' });
  const fieldset = makeNode('fieldset');
  const nativeSelect = makeNode('select', {
    id: 'workflow-rule-operation',
    'data-cc-dropdown-native-select': '',
    'data-processing-rule-operation': '',
  });
  const dropdown = makeNode('details', {
    id: 'workflow-rule-operation-dropdown',
    'data-cc-dropdown': '',
    'data-cc-dropdown-mode': 'single',
    'data-cc-dropdown-dispatch-native-change': '',
    hidden: '',
  });
  const summary = makeNode('summary', {
    id: 'workflow-rule-operation-dropdown-trigger',
    'aria-controls': 'workflow-rule-operation-dropdown-options',
    'aria-label': 'Operation filter: Remove',
  });
  const summaryCurrent = makeNode('span', { 'data-cc-dropdown-summary-current': '' });
  summaryCurrent.textContent = 'Remove';
  summary.appendChild(summaryCurrent);
  const panel = makeNode('div', {
    id: 'workflow-rule-operation-dropdown-options',
    class: 'asset-filter-multiselect-panel',
  });

  ['remove', 'replace', 'prepend', 'append'].forEach((value, index) => {
    addOption(nativeSelect, value, value[0].toUpperCase() + value.slice(1));
    const option = makeNode('div', { class: 'asset-filter-multiselect-option' });
    const label = makeNode('label', { for: `workflow-rule-operation-option-${index + 1}` });
    label.textContent = value[0].toUpperCase() + value.slice(1);
    const input = makeNode('input', {
      id: `workflow-rule-operation-option-${index + 1}`,
      type: 'radio',
      value,
    });
    input.checked = index === 0;
    label.appendChild(input);
    option.appendChild(label);
    panel.appendChild(option);
  });

  nativeSelect.value = 'remove';
  dropdown.append(summary, panel);
  fieldset.append(nativeSelect, dropdown);
  type.appendChild(fieldset);
  row.appendChild(type);
  row.appendChild(makeNode('input', { type: 'text', 'data-processing-rule-text': '' }));
  const search = makeNode('input', { type: 'text', 'data-processing-rule-search': '', hidden: '' });
  const replacement = makeNode('input', { type: 'text', 'data-processing-rule-replacement': '', hidden: '' });
  row.append(search, replacement);
  row.appendChild(makeNode('button', { type: 'button', 'data-processing-remove-rule': '' }));
  template.content.appendChild(row);
  return template;
}

let workflowDialogCount = 0;

function buildWorkflowRoot(doc, projectId = '1') {
  const root = makeNode('div', {
    'data-processing-root': '', 'data-processing-operation': 'workflow-prompt',
    'data-project-id': projectId, 'data-csrf': 'csrf-token',
  });
  const preset = buildPresetSection('workflow');
  root.appendChild(preset.wrap);
  root.appendChild(buildRuleRowTemplate());
  const sides = {};
  ['positive', 'negative'].forEach((side) => {
    const section = makeNode('div', { 'data-processing-rules': side });
    const list = makeNode('ul', { 'data-processing-rule-list': '' });
    section.appendChild(list);
    const addButton = makeNode('button', { type: 'button', 'data-processing-add-rule': side });
    section.appendChild(addButton);
    root.appendChild(section);
    sides[side] = { section, list, addButton };
  });
  const footer = buildPlanFooter();
  footer.nodes.forEach((node) => root.appendChild(node));
  workflowDialogCount += 1;
  const mounted = mountDialog(doc, `processing-workflow-dialog-${workflowDialogCount}`, root);
  return { root, preset, sides, footer, ...mounted };
}

function buildWatermarkRoot(doc, projectId = '1', dialogId = 'processing-watermark-dialog') {
  const root = makeNode('div', {
    'data-processing-root': '', 'data-processing-operation': 'watermark',
    'data-project-id': projectId, 'data-csrf': 'csrf-token',
  });
  const preset = buildPresetSection('watermark');
  root.appendChild(preset.wrap);

  const watermarkSelect = buildField(doc, { field: 'watermarkId', type: 'int-or-null', tag: 'select', options: [] });
  watermarkSelect.id = 'watermark-resource-select';
  const setDefaultButton = makeNode('button', { type: 'button', 'data-processing-set-default-watermark': '', disabled: '' });
  const defaultStatus = makeNode('p', { 'data-processing-watermark-default-status': '', hidden: '' });
  root.append(watermarkSelect, setDefaultButton, defaultStatus);

  const mode = makeNode('input', { type: 'hidden', 'data-processing-field': 'mode', 'data-processing-type': 'string', value: 'custom' });
  root.appendChild(mode);

  const scope = makeNode('fieldset', { 'data-processing-scope': '' });
  scope.appendChild(makeNode('input', {
    type: 'radio', value: 'project', 'data-processing-scope-option': 'project', checked: '',
  }));
  root.appendChild(scope);

  // Placement / geometry
  const position = buildField(doc, { field: 'position', type: 'string', tag: 'select', options: [['bl', 'Bottom-left'], ['tr', 'Top-right']], value: 'bl' });
  const marginRatio = buildField(doc, { field: 'marginRatio', type: 'float', omitIfEmpty: true, value: '0.02' });
  // Resize
  const maxDimension = buildField(doc, { field: 'maxDimension', type: 'int', omitIfEmpty: true, value: '1100' });
  // Output
  const primaryFormat = buildField(doc, { field: 'primaryFormat', type: 'string', tag: 'select', options: [['none', 'None'], ['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']], value: 'png' });
  const secondaryFormat = buildField(doc, { field: 'secondaryFormat', type: 'string', tag: 'select', options: [['none', 'None'], ['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']], value: 'none' });
  const resizedFormat = buildField(doc, { field: 'resizedFormat', type: 'string', tag: 'select', options: [['none', 'None'], ['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']], value: 'none' });
  const outputCategorySlug = buildField(doc, { field: 'outputCategorySlug', type: 'string', tag: 'select', options: [['wm', 'Watermarked'], ['wm-lq', 'Watermarked low quality']], value: 'wm' });
  const outputCategoryHelp = makeNode('p', { 'data-processing-output-category-help': '' });
  // Format-dependent output settings
  const quality = buildField(doc, { field: 'quality', type: 'int', omitIfEmpty: true, value: '90' });
  const webpLossless = buildField(doc, { field: 'webpLossless', type: 'bool', inputType: 'checkbox', checked: false });
  const jpegBackground = buildField(doc, { field: 'jpegBackground', type: 'string', omitIfEmpty: true, value: 'white' });
  // Canonical suffix fields
  const unresizedSuffix = buildField(doc, { field: 'unresizedSuffix', type: 'string', omitIfEmpty: true, value: '_wm' });
  const resizedSuffix = buildField(doc, { field: 'resizedSuffix', type: 'string', omitIfEmpty: true, value: '_lq_wm' });
  // Delete source
  const deleteSource = buildField(doc, { field: 'deleteSource', type: 'bool', inputType: 'checkbox', checked: false });
  // Archive controls intentionally live in the standalone Archives dialog.
  root.append(
    position, marginRatio, maxDimension, primaryFormat, secondaryFormat, resizedFormat, outputCategorySlug, outputCategoryHelp, quality, webpLossless, jpegBackground,
    unresizedSuffix, resizedSuffix, deleteSource,
  );

  const previewSection = makeNode('section', { 'data-processing-watermark-preview': '', hidden: '' });
  const previewState = makeNode('p', { 'data-processing-watermark-preview-state': '' });
  const previewSource = makeNode('p', { 'data-processing-watermark-preview-source': '', hidden: '' });
  const previewImageWrap = makeNode('div', { 'data-processing-watermark-preview-image-wrap': '', hidden: '' });
  const previewImage = makeNode('img', { 'data-processing-watermark-preview-image': '' });
  previewImageWrap.appendChild(previewImage);
  previewSection.append(previewState, previewSource, previewImageWrap);
  root.appendChild(previewSection);

  const footer = buildPlanFooter();
  footer.nodes.forEach((node) => root.appendChild(node));
  const mounted = mountDialog(doc, dialogId, root);
  return {
    root, preset, watermarkSelect, setDefaultButton, defaultStatus, position, marginRatio, maxDimension,
    primaryFormat, secondaryFormat, resizedFormat, outputCategorySlug, outputCategoryHelp, quality, webpLossless, jpegBackground, unresizedSuffix, resizedSuffix,
    deleteSource, footer, scope, previewSection, previewState, previewSource, previewImageWrap, previewImage, ...mounted,
  };
}

function buildManageWatermarksRoot(doc) {
  const root = makeNode('div', {
    'data-processing-manage-watermarks': '',
    'data-csrf': 'csrf-token',
  });
  const error = makeNode('div', { 'data-processing-error': '', hidden: '' });
  const errorText = makeNode('p', { 'data-processing-error-text': '' });
  error.appendChild(errorText);
  const list = makeNode('ul', { 'data-processing-watermark-list': '' });
  const scanButton = makeNode('button', { type: 'button', 'data-processing-scan-watermarks': '' });
  const status = makeNode('div', { 'data-processing-status': '' });
  root.append(error, list, scanButton, status);
  const mounted = mountDialog(doc, 'processing-manage-watermarks-dialog', root);
  return { root, error, errorText, list, scanButton, status, ...mounted };
}

function buildManageScaleMapRoot(doc) {
  const root = makeNode('div', { 'data-processing-manage-scale-map': '', 'data-csrf': 'csrf-token' });
  const error = makeNode('div', { 'data-processing-error': '', hidden: '' });
  const errorText = makeNode('p', { 'data-processing-error-text': '' });
  error.appendChild(errorText);
  const editor = makeNode('div', { 'data-processing-scale-map-editor': '' });
  const rows = makeNode('div', { 'data-processing-scale-map-rows': '' });
  const addRow = makeNode('button', { type: 'button', 'data-processing-scale-map-add-row': '' });
  const defaultInput = makeNode('input', { 'data-processing-scale-map-default': '' });
  const save = makeNode('button', { type: 'button', 'data-processing-scale-map-save': '' });
  const status = makeNode('div', { 'data-processing-status': '' });
  editor.append(rows, addRow, defaultInput, save);
  root.append(error, editor, status);
  const mounted = mountDialog(doc, 'processing-manage-scale-map-dialog', root);
  return { root, error, errorText, rows, addRow, defaultInput, save, status, ...mounted };
}

// ─── Fetch mock: an in-memory preset store shaped like the real routes ──

function makeFetchMock() {
  const presets = new Map();
  const candidates = [{ id: 7, filename: 'oliver.png', relativePath: 'watermarks/oliver.png' }];
  let nextId = 100;
  let scaleMapDefinition = { '1024x1024': 0.37, default: 0.1 };
  let defaultWatermarkId = null;
  const calls = [];

  function ok(body) { return { ok: true, status: 200, json: async () => body }; }
  function fail(status, code, message) {
    return { ok: false, status, json: async () => ({ ok: false, error: { code, message } }) };
  }

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method || 'POST';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    if (url.startsWith('/processing/presets') && method === 'GET') {
      const params = new URLSearchParams(url.split('?')[1] || '');
      const operationType = params.get('operationType');
      const list = Array.from(presets.values()).filter((p) => !operationType || p.operationType === operationType);
      return ok({ ok: true, presets: list });
    }
    if (url === '/processing/presets' && method === 'POST') {
      const existing = Array.from(presets.values())
        .find((p) => p.operationType === body.operationType && p.displayName === body.displayName);
      if (existing) return fail(409, 'PRESET_NAME_CONFLICT', 'A preset with that operation type and display name already exists.');
      const preset = {
        id: nextId, operationType: body.operationType, displayName: body.displayName,
        config: body.config, watermarkId: body.watermarkId ?? null,
      };
      nextId += 1;
      presets.set(String(preset.id), preset);
      return ok({ ok: true, preset });
    }
    if (url === '/processing/presets/import' && method === 'POST') {
      const imported = [];
      let renamed = 0;
      for (const entry of body.presets || []) {
        const baseName = entry.displayName;
        let displayName = baseName;
        let suffix = 0;
        while (Array.from(presets.values()).some((preset) => (
          preset.operationType === body.operationType
          && preset.displayName.toLowerCase() === displayName.toLowerCase()
        ))) {
          suffix += 1;
          displayName = `${baseName} (${suffix})`;
        }
        if (displayName !== baseName) renamed += 1;
        const preset = {
          id: nextId, operationType: body.operationType, displayName,
          config: entry.config, watermarkId: null,
        };
        nextId += 1;
        presets.set(String(preset.id), preset);
        imported.push(preset);
      }
      return ok({ ok: true, imported: imported.length, renamed, presets: imported });
    }
    const renameMatch = url.match(/^\/processing\/presets\/(\d+)\/rename$/);
    if (renameMatch && method === 'POST') {
      const preset = presets.get(renameMatch[1]);
      if (!preset) return fail(404, 'PRESET_NOT_FOUND', 'Processing preset not found.');
      const dup = Array.from(presets.values())
        .find((p) => p.id !== preset.id && p.operationType === preset.operationType && p.displayName === body.displayName);
      if (dup) return fail(409, 'PRESET_NAME_CONFLICT', 'A preset with that operation type and display name already exists.');
      preset.displayName = body.displayName;
      return ok({ ok: true, preset });
    }
    const replaceMatch = url.match(/^\/processing\/presets\/(\d+)\/replace$/);
    if (replaceMatch && method === 'POST') {
      const preset = presets.get(replaceMatch[1]);
      if (!preset) return fail(404, 'PRESET_NOT_FOUND', 'Processing preset not found.');
      preset.config = body.config;
      if (Object.hasOwn(body, 'watermarkId')) preset.watermarkId = body.watermarkId;
      return ok({ ok: true, preset });
    }
    const deleteMatch = url.match(/^\/processing\/presets\/(\d+)\/delete$/);
    if (deleteMatch && method === 'POST') {
      const id = deleteMatch[1];
      if (!presets.has(id)) return fail(404, 'PRESET_NOT_FOUND', 'Processing preset not found.');
      presets.delete(id);
      return ok({ ok: true, id: Number(id) });
    }
    if (url === '/processing/watermarks/default' && method === 'GET') return ok({ ok: true, watermarkId: defaultWatermarkId });
    if (url === '/processing/watermarks/default' && method === 'POST') {
      defaultWatermarkId = body.watermarkId;
      return ok({ ok: true, watermarkId: defaultWatermarkId });
    }
    if (url === '/processing/watermarks' && method === 'GET') return ok({ ok: true, watermarks: candidates });
    if (url === '/processing/watermarks/scan' && method === 'POST') return ok({ ok: true, scan: { added: 1, updated: 0, restored: 0, removed: 0, total: candidates.length }, watermarks: candidates });
    if (url === '/processing/scale-map' && method === 'GET') return ok({ ok: true, definition: scaleMapDefinition });
    if (url === '/processing/scale-map/replace' && method === 'POST') {
      scaleMapDefinition = body.definition;
      return ok({ ok: true, definition: scaleMapDefinition });
    }
    if (url === '/projects/1/assets/processing/watermark/plan' && method === 'POST') {
      return ok({ ok: true, plan: { operation: 'watermark', counts: {}, items: [] } });
    }
    if (url === '/projects/1/assets/processing/watermark/preview-image' && method === 'POST') {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return {
              'Content-Type': 'image/png',
              'X-CreatorCrate-Preview-Source': 'source.png',
              'X-CreatorCrate-Preview-Eligible-Count': '2',
              'X-CreatorCrate-Preview-Variant': 'resized',
            }[name] || null;
          },
        },
        blob: async () => new Blob(['preview-bytes'], { type: 'image/png' }),
      };
    }
    if (url === '/projects/1/assets/processing/watermark/apply' && method === 'POST') {
      return ok({ ok: true, result: { generatedCount: 1, requestedCount: 1 } });
    }
  throw new Error(`Unhandled fetch: ${method} ${url}`);
  });

  return {
    fetchMock,
    presets,
    candidates,
    calls,
    getScaleMap: () => scaleMapDefinition,
    setDefaultWatermarkId: (id) => { defaultWatermarkId = id; },
    seed: (preset) => presets.set(String(preset.id), preset),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Processing dialog preset management', () => {
  let doc;
  let fetchState;

  beforeEach(() => {
    doc = makeDocument();
    fetchState = makeFetchMock();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('fetch', fetchState.fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openDialog(fixture) {
    doc.dispatch('click', { target: fixture.trigger });
    await flush();
  }

  describe('Convert dialog', () => {
    it('shows Save as preset enabled and Update/Rename/Delete disabled from Custom', async () => {
      const fixture = buildConvertRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      expect(fixture.preset.saveBtn.disabled).toBeFalsy();
      expect(fixture.preset.updateBtn.disabled).toBe(true);
      expect(fixture.preset.renameBtn.disabled).toBe(true);
      expect(fixture.preset.deleteBtn.disabled).toBe(true);
      expect(fixture.preset.exportBtn.disabled).toBe(true);
    });

    it('exports every saved Convert configuration, independent of selection or unsaved form changes', async () => {
      let exportedBlob;
      vi.stubGlobal('URL', {
        createObjectURL: vi.fn((blob) => { exportedBlob = blob; return 'blob:creatorcrate-preset'; }),
        revokeObjectURL: vi.fn(),
      });
      const fixture = buildConvertRoot(doc);
      fetchState.seed({
        id: 5, operationType: 'convert', displayName: 'Patreon',
        config: { format: 'webp', quality: 85, originalHandling: 'move' },
        systemKey: 'convert-system', watermarkId: null,
      });
      fetchState.seed({
        id: 6, operationType: 'convert', displayName: 'Social',
        config: { format: 'png', quality: 72, originalHandling: 'keep' },
        watermarkId: null,
      });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '5';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.quality.value = '60';
      fixture.quality.dispatch('change', { target: fixture.quality });
      fixture.preset.exportBtn.dispatch('click');
      await flush();

      const exported = JSON.parse(await exportedBlob.text());
      expect(exported).toEqual({
        creatorcrate: 'processing-presets',
        version: 1,
        operationType: 'convert',
        presets: [
          {
            displayName: 'Patreon',
            config: { format: 'webp', quality: 85, originalHandling: 'move' },
          },
          {
            displayName: 'Social',
            config: { format: 'png', quality: 72, originalHandling: 'keep' },
          },
        ],
      });
      expect(fixture.preset.exportBtn.disabled).toBe(false);
    });

    it('imports every preset, persists through the bundle endpoint, refreshes the selector, and leaves the form alone', async () => {
      const fixture = buildConvertRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.root.__ccPreviewValid = true;
      fixture.footer.applyBtn.disabled = false;

      fixture.preset.importInput.files = [{
        text: async () => JSON.stringify({
          creatorcrate: 'processing-presets', version: 1, operationType: 'convert',
          presets: [
            { displayName: 'Imported A', config: { format: 'png', quality: 72, originalHandling: 'keep' } },
            { displayName: 'Imported B', config: { format: 'webp', quality: 80, originalHandling: 'delete' } },
          ],
        }),
      }];
      fixture.preset.importInput.dispatch('change', { target: fixture.preset.importInput });
      await flush();

      expect(fixture.format.value).toBe('webp');
      expect(fixture.quality.value).toBe('');
      expect(fixture.originalHandling.value).toBe('keep');
      expect(fixture.preset.select.value).toBe('');
      expect(fixture.preset.exportBtn.disabled).toBe(false);
      expect(fixture.preset.select.options.some((o) => o.textContent === 'Imported A')).toBe(true);
      expect(fixture.preset.select.options.some((o) => o.textContent === 'Imported B')).toBe(true);
      expect(fixture.root.__ccPreviewValid).toBe(true);
      expect(fixture.footer.applyBtn.disabled).toBe(false);
      expect(fixture.footer.error.hidden).toBe(true);
      expect(fixture.footer.status.textContent).toContain('Imported 2 presets.');
      const importCall = fetchState.calls.find((call) => call.url === '/processing/presets/import');
      expect(importCall.body.presets).toHaveLength(2);
      expect(fetchState.calls.some((call) => call.url === '/processing/presets' && call.method === 'POST')).toBe(false);
    });

    it('rejects malformed, wrong-version, wrong-operation, and forbidden-field settings files in-dialog', async () => {
      const fixture = buildConvertRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      const files = [
        'not-json',
        JSON.stringify({ creatorcrate: 'processing-preset', version: 1, operationType: 'convert', presets: [] }),
        JSON.stringify({ creatorcrate: 'processing-presets', version: 2, operationType: 'convert', presets: [] }),
        JSON.stringify({ creatorcrate: 'processing-presets', version: 1, operationType: 'watermark', presets: [] }),
        JSON.stringify({ creatorcrate: 'processing-presets', version: 1, operationType: 'convert', presets: [
          { displayName: 'Bad', config: { format: 'webp', originalHandling: 'keep', projectId: 1 } },
        ] }),
      ];

      for (const content of files) {
        fixture.preset.importInput.files = [{ text: async () => content }];
        fixture.preset.importInput.dispatch('change', { target: fixture.preset.importInput });
        await flush();
        expect(fixture.footer.error.hidden).toBe(false);
        expect(fixture.footer.errorText.textContent).not.toContain('SELECT ');
        expect(fixture.footer.errorText.textContent).not.toMatch(/[A-Za-z]:\\/);
      }
      expect(fixture.preset.select.value).toBe('');
      expect(fetchState.calls.some((call) => call.url === '/processing/presets/import' && call.method === 'POST')).toBe(false);
    });

    it('saves the current form as a new preset, selects it, refreshes the selector, and leaves the form unchanged', async () => {
      const fixture = buildConvertRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.quality.value = '77';
      fixture.preset.saveBtn.dispatch('click');
      await flush();
      expect(fixture.preset.nameForm.hidden).toBe(false);

      fixture.preset.nameInput.value = 'My Convert Preset';
      fixture.preset.nameForm.dispatch('submit', { target: fixture.preset.nameForm });
      await flush();

      const createCall = fetchState.calls.find((c) => c.url === '/processing/presets' && c.method === 'POST');
      expect(createCall.body).toEqual({
        operationType: 'convert',
        displayName: 'My Convert Preset',
        config: { format: 'webp', quality: 77, originalHandling: 'keep' },
      });
      // Payload safety: no runtime/scope-only keys ever leave the client.
      const forbidden = ['projectId', 'assetIds', 'categoryId', 'directory', 'recursive', 'scope'];
      forbidden.forEach((key) => expect(Object.keys(createCall.body)).not.toContain(key));
      expect(Object.keys(createCall.body.config)).not.toContain('scope');

      expect(fixture.preset.select.value).toBe('100');
      expect(fixture.preset.select.options.some((o) => o.value === '100' && o.textContent === 'My Convert Preset')).toBe(true);
      expect(fixture.quality.value).toBe('77');
      expect(fixture.preset.modified.hidden).toBe(true);
      expect(fixture.preset.nameForm.hidden).toBe(true);
      expect(fixture.preset.updateBtn.disabled).toBe(false);
      expect(fixture.preset.renameBtn.disabled).toBe(false);
      expect(fixture.preset.deleteBtn.disabled).toBe(false);
    });

    it('marks Modified from preset after editing a field, and Update persists the change while keeping the same preset selected', async () => {
      const fixture = buildConvertRoot(doc);
      fetchState.seed({ id: 5, operationType: 'convert', displayName: 'WebP 85', config: { format: 'webp', quality: 85, originalHandling: 'keep' }, watermarkId: null });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '5';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      expect(fixture.quality.value).toBe('85');
      expect(fixture.preset.modified.hidden).toBe(true);
      expect(fixture.preset.updateBtn.disabled).toBe(false);

      // Simulate a prior successful Preview so we can prove it gets invalidated.
      fixture.root.__ccPreviewValid = true;
      fixture.footer.applyBtn.disabled = false;

      fixture.quality.value = '60';
      fixture.quality.dispatch('change', { target: fixture.quality });
      expect(fixture.preset.modified.hidden).toBe(false);
      expect(fixture.footer.applyBtn.disabled).toBe(true);

      fixture.preset.updateBtn.dispatch('click');
      await flush();

      const replaceCall = fetchState.calls.find((c) => c.url === '/processing/presets/5/replace');
      expect(replaceCall.body).toEqual({ config: { format: 'webp', quality: 60, originalHandling: 'keep' } });
      expect(fixture.preset.select.value).toBe('5');
      expect(fixture.preset.modified.hidden).toBe(true);
      expect(fetchState.presets.get('5').config.quality).toBe(60);
    });

    it('renames the selected preset and updates the selector label immediately, remaining selected', async () => {
      const fixture = buildConvertRoot(doc);
      fetchState.seed({ id: 5, operationType: 'convert', displayName: 'Old name', config: { format: 'webp', quality: 85, originalHandling: 'keep' }, watermarkId: null });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '5';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });

      fixture.preset.renameBtn.dispatch('click');
      expect(fixture.preset.nameForm.hidden).toBe(false);
      expect(fixture.preset.nameInput.value).toBe('Old name');

      fixture.preset.nameInput.value = 'New name';
      fixture.preset.nameForm.dispatch('submit', { target: fixture.preset.nameForm });
      await flush();

      const renameCall = fetchState.calls.find((c) => c.url === '/processing/presets/5/rename');
      expect(renameCall.body).toEqual({ displayName: 'New name' });
      expect(fixture.preset.select.value).toBe('5');
      expect(fixture.preset.select.options.find((o) => o.value === '5').textContent).toBe('New name');
    });

    it('cleanly reports a duplicate preset name inside the dialog, without alert()', async () => {
      const fixture = buildConvertRoot(doc);
      fetchState.seed({ id: 5, operationType: 'convert', displayName: 'Taken', config: { format: 'webp', quality: 85, originalHandling: 'keep' }, watermarkId: null });
      const alertSpy = vi.fn();
      vi.stubGlobal('alert', alertSpy);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.saveBtn.dispatch('click');
      fixture.preset.nameInput.value = 'Taken';
      fixture.preset.nameForm.dispatch('submit', { target: fixture.preset.nameForm });
      await flush();

      expect(alertSpy).not.toHaveBeenCalled();
      expect(fixture.footer.error.hidden).toBe(false);
      expect(fixture.footer.errorText.textContent).toContain('already exists');
      expect(fixture.footer.errorText.textContent).not.toMatch(/[A-Za-z]:\\/);
      expect(fixture.footer.errorText.textContent).not.toContain('SELECT ');
    });

    it('opens the shared Delete preset dialog once, blocks mutations while pending, and restores Delete focus on cancel', async () => {
      const fixture = buildConvertRoot(doc);
      const confirmation = attachSharedConfirmationDialog(doc);
      fetchState.seed({ id: 5, operationType: 'convert', displayName: 'Doomed', config: { format: 'webp', quality: 85, originalHandling: 'keep' }, watermarkId: null });
      const nativeConfirm = vi.fn();
      doc.defaultView.confirm = nativeConfirm;
      enhanceAppDialogs(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '5';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.preset.deleteBtn.dispatch('click');
      fixture.preset.deleteBtn.dispatch('click');
      fixture.preset.updateBtn.dispatch('click');
      await flush();

      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(confirmation.dialog.showModal).toHaveBeenCalledTimes(1);
      expect(confirmation.title.textContent).toBe('Delete preset');
      expect(confirmation.confirm.textContent).toBe('Delete preset');
      expect(confirmation.message.textContent).toBe('Delete the preset "Doomed"? This does not delete Watermarks, scale maps, or generated files.');
      expect(fetchState.calls.some((call) => call.url === '/processing/presets/5/replace')).toBe(false);

      confirmation.cancel.dispatch('click');
      await flush();

      expect(fetchState.calls.some((call) => call.url === '/processing/presets/5/delete')).toBe(false);
      expect(fixture.root.__ccPresetBusy).toBe(false);
      expect(fixture.preset.deleteBtn.focused).toBe(true);
    });

    it('deletes the captured preset exactly once after confirmation and focuses the enhanced selector', async () => {
      const fixture = buildConvertRoot(doc);
      const confirmation = attachSharedConfirmationDialog(doc);
      const dropdownSummary = attachEnhancedPresetDropdown(fixture);
      fetchState.seed({ id: 5, operationType: 'convert', displayName: 'Doomed', config: { format: 'webp', quality: 85, originalHandling: 'keep' }, watermarkId: null });
      fetchState.seed({ id: 6, operationType: 'convert', displayName: 'Keep me', config: { format: 'png', quality: 72, originalHandling: 'keep' }, watermarkId: null });
      enhanceAppDialogs(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '5';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.quality.value = '42';
      fixture.quality.dispatch('change', { target: fixture.quality });
      fixture.root.__ccPreviewValid = true;
      fixture.footer.applyBtn.disabled = false;
      fixture.preset.deleteBtn.dispatch('click');
      await flush();

      fixture.preset.select.value = '6';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.preset.updateBtn.dispatch('click');
      confirmation.confirm.dispatch('click');
      await flush();

      expect(fetchState.calls.filter((call) => call.url === '/processing/presets/5/delete')).toHaveLength(1);
      expect(fetchState.calls.some((call) => call.url === '/processing/presets/6/delete')).toBe(false);
      expect(fetchState.calls.some((call) => call.url === '/processing/presets/6/replace')).toBe(false);
      expect(fixture.root.__ccPresetBusy).toBe(false);
      expect(fixture.preset.select.value).toBe('');
      expect(fixture.quality.value).toBe('42');
      expect(fixture.preset.modified.hidden).toBe(true);
      expect(fixture.footer.applyBtn.disabled).toBe(true);
      expect(fixture.preset.updateBtn.disabled).toBe(true);
      expect(fixture.preset.renameBtn.disabled).toBe(true);
      expect(fixture.preset.deleteBtn.disabled).toBe(true);
      expect(dropdownSummary.focused).toBe(true);
      expect(fixture.preset.select.focused).not.toBe(true);
    });

    it('clears preset busy state when the confirmed deletion fails', async () => {
      const fixture = buildConvertRoot(doc);
      const confirmation = attachSharedConfirmationDialog(doc);
      fetchState.seed({ id: 5, operationType: 'convert', displayName: 'Doomed', config: { format: 'webp', quality: 85, originalHandling: 'keep' }, watermarkId: null });
      enhanceAppDialogs(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.preset.select.value = '5';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.preset.deleteBtn.dispatch('click');
      await flush();
      fetchState.fetchMock.mockImplementationOnce(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: { message: 'Could not delete preset.' } }),
      }));
      confirmation.confirm.dispatch('click');
      await flush();

      expect(fixture.root.__ccPresetBusy).toBe(false);
      expect(fixture.footer.error.hidden).toBe(false);
      expect(fetchState.presets.has('5')).toBe(true);
    });
  });

  describe('Workflow prompt dialog', () => {
    function addRule(fixture, side, { type, text, search, replacement }) {
      fixture.sides[side].addButton.dispatch('click');
      const row = fixture.sides[side].list.children[fixture.sides[side].list.children.length - 1];
      const operation = row.querySelector('[data-processing-rule-operation]');
      operation.value = type;
      operation.dispatch('change', { target: operation });
      if (type === 'replace') {
        row.querySelector('[data-processing-rule-search]').value = search ?? '';
        row.querySelector('[data-processing-rule-replacement]').value = replacement ?? '';
      } else {
        row.querySelector('[data-processing-rule-text]').value = text ?? '';
      }
      return row;
    }

    it('round-trips Remove/Replace(empty search)/Prepend/Append rules through save, load, and update', async () => {
      const fixture = buildWorkflowRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      // Dialog-open seeds one placeholder empty-Remove row per side so the
      // list is never confusingly blank; clear those before adding our own.
      fixture.sides.positive.list.children.slice().forEach((row) => row.remove());
      fixture.sides.negative.list.children.slice().forEach((row) => row.remove());

      addRule(fixture, 'positive', { type: 'remove', text: 'masterwork, ' });
      addRule(fixture, 'positive', { type: 'replace', search: '', replacement: 'new lora' });
      addRule(fixture, 'negative', { type: 'prepend', text: 'extra abs, ' });
      addRule(fixture, 'negative', { type: 'append', text: ', low quality' });

      fixture.preset.saveBtn.dispatch('click');
      fixture.preset.nameInput.value = 'My Workflow Preset';
      fixture.preset.nameForm.dispatch('submit', { target: fixture.preset.nameForm });
      await flush();

      const expectedConfig = {
        positive: { rules: [{ type: 'remove', text: 'masterwork, ' }, { type: 'replace', search: '', replacement: 'new lora' }] },
        negative: { rules: [{ type: 'prepend', text: 'extra abs, ' }, { type: 'append', text: ', low quality' }] },
      };
      const createCall = fetchState.calls.find((c) => c.url === '/processing/presets' && c.method === 'POST');
      expect(createCall.body).toEqual({ operationType: 'workflow-prompt', displayName: 'My Workflow Preset', config: expectedConfig });

      // Reload it into a fresh dialog instance and verify identical structured rules.
      const reload = buildWorkflowRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(reload);
      reload.preset.select.value = '100';
      reload.preset.select.dispatch('change', { target: reload.preset.select });

      const collectSide = (fixtureRef, side) => fixtureRef.sides[side].list.children.map((row) => {
        const type = row.querySelector('[data-processing-rule-operation]').value;
        if (type === 'replace') {
          return { type, search: row.querySelector('[data-processing-rule-search]').value, replacement: row.querySelector('[data-processing-rule-replacement]').value };
        }
        return { type, text: row.querySelector('[data-processing-rule-text]').value };
      });
      expect(collectSide(reload, 'positive')).toEqual(expectedConfig.positive.rules);
      expect(collectSide(reload, 'negative')).toEqual(expectedConfig.negative.rules);
      const restoredReplace = reload.sides.positive.list.children[1];
      expect(restoredReplace.querySelector('[data-processing-rule-operation]').value).toBe('replace');
      expect(restoredReplace.querySelector('[data-cc-dropdown-summary-current]').textContent).toBe('Replace');

      // Modify and Update: change the prepend rule's text.
      reload.sides.negative.list.children[0].querySelector('[data-processing-rule-text]').value = 'changed abs, ';
      reload.sides.negative.list.children[0].querySelector('[data-processing-rule-text]').dispatch('change', { target: reload.sides.negative.list.children[0].querySelector('[data-processing-rule-text]') });
      expect(reload.preset.modified.hidden).toBe(false);

      reload.preset.updateBtn.dispatch('click');
      await flush();
      const replaceCall = fetchState.calls.find((c) => c.url === '/processing/presets/100/replace');
      expect(replaceCall.body.config.negative.rules[0]).toEqual({ type: 'prepend', text: 'changed abs, ' });
      expect(Object.keys(replaceCall.body)).not.toContain('scope');
    });

    it('creates native operation-select rows with unique dropdown IDs and references', async () => {
      const fixture = buildWorkflowRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.sides.positive.list.children.slice().forEach((row) => row.remove());

      const first = addRule(fixture, 'positive', { type: 'prepend', text: 'first' });
      const second = addRule(fixture, 'positive', { type: 'replace', search: 'old', replacement: 'new' });

      expect(first.querySelector('[data-processing-rule-operation]')).toBeTruthy();
      expect(first.querySelector('[data-processing-rule-type]').tagName).toBe('DIV');
      expect(first.querySelector('[data-processing-rule-text]').hidden).toBe(false);
      expect(second.querySelector('[data-processing-rule-text]').hidden).toBe(true);
      expect(second.querySelector('[data-processing-rule-search]').hidden).toBe(false);
      expect(second.querySelector('[data-processing-rule-replacement]').hidden).toBe(false);

      const firstIds = first.querySelectorAll('[id]').map((element) => element.id);
      const secondIds = second.querySelectorAll('[id]').map((element) => element.id);
      expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);

      [first, second].forEach((row) => {
        row.querySelectorAll('[for], [aria-controls]').forEach((element) => {
          element.getAttribute(element.hasAttribute('for') ? 'for' : 'aria-controls')
            .split(/\s+/)
            .forEach((id) => expect(row.querySelector(`#${id}`)).toBeTruthy());
        });
      });
    });

    it('keeps each native operation select independent when a later row changes', async () => {
      const fixture = buildWorkflowRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.sides.positive.list.children.slice().forEach((row) => row.remove());

      const first = addRule(fixture, 'positive', { type: 'prepend', text: 'first' });
      const second = addRule(fixture, 'positive', { type: 'append', text: 'second' });
      const secondOperation = second.querySelector('[data-processing-rule-operation]');
      secondOperation.value = 'remove';
      secondOperation.dispatch('change', { target: secondOperation });

      fixture.preset.saveBtn.dispatch('click');
      fixture.preset.nameInput.value = 'Independent operations';
      fixture.preset.nameForm.dispatch('submit', { target: fixture.preset.nameForm });
      await flush();

      const createCall = fetchState.calls.find((call) => call.url === '/processing/presets' && call.method === 'POST');
      expect(first.querySelector('[data-processing-rule-operation]').value).toBe('prepend');
      expect(createCall.body.config.positive.rules).toEqual([
        { type: 'prepend', text: 'first' },
        { type: 'remove', text: 'second' },
      ]);
    });

    it('exports all Workflow rules faithfully, including order and an empty Replace search', async () => {
      let exportedBlob;
      vi.stubGlobal('URL', {
        createObjectURL: vi.fn((blob) => { exportedBlob = blob; return 'blob:creatorcrate-workflow'; }),
        revokeObjectURL: vi.fn(),
      });
      const fixture = buildWorkflowRoot(doc);
      fetchState.seed({
        id: 11, operationType: 'workflow-prompt', displayName: 'Workflow portable',
        config: {
          positive: [
            { type: 'remove', text: 'masterwork, ' },
            { type: 'replace', search: '', replacement: 'new lora' },
          ],
          negative: [
            { type: 'prepend', text: 'extra abs, ' },
            { type: 'append', text: ', low quality' },
          ],
        }, watermarkId: null,
      });
      fetchState.seed({
        id: 12, operationType: 'workflow-prompt', displayName: 'Workflow second',
        config: {
          positive: [{ type: 'append', text: 'positive' }],
          negative: [{ type: 'remove', text: 'negative' }],
        }, watermarkId: null,
      });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.preset.select.value = '11';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.preset.exportBtn.dispatch('click');
      await flush();

      const exported = JSON.parse(await exportedBlob.text());
      expect(exported).toMatchObject({
        creatorcrate: 'processing-presets',
        version: 1,
        operationType: 'workflow-prompt',
      });
      expect(exported.presets).toHaveLength(2);
      expect(exported.presets[0].config).toEqual({
        positive: [
          { type: 'remove', text: 'masterwork, ' },
          { type: 'replace', search: '', replacement: 'new lora' },
        ],
        negative: [
          { type: 'prepend', text: 'extra abs, ' },
          { type: 'append', text: ', low quality' },
        ],
      });
      expect(exported.presets[1]).toEqual({
        displayName: 'Workflow second',
        config: {
          positive: [{ type: 'append', text: 'positive' }],
          negative: [{ type: 'remove', text: 'negative' }],
        },
      });

      const imported = buildWorkflowRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(imported);
      imported.preset.importInput.files = [{ text: async () => JSON.stringify(exported) }];
      imported.preset.importInput.dispatch('change', { target: imported.preset.importInput });
      await flush();
      expect(imported.preset.select.value).toBe('');
      expect(imported.preset.select.options.some((o) => o.textContent === 'Workflow portable')).toBe(true);
      expect(fetchState.calls.some((call) => call.url === '/processing/presets/import' && call.method === 'POST')).toBe(true);
    });
  });

  describe('Watermark dialog', () => {
    it('applies the present global default without dirtying the preset and persists only when requested', async () => {
      fetchState.candidates.push({ id: 8, filename: 'benji.png', relativePath: 'benji.png' });
      fetchState.setDefaultWatermarkId(7);
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);

      expect(fixture.setDefaultButton.disabled).toBe(true);
      await openDialog(fixture);
      expect(fixture.watermarkSelect.value).toBe('7');
      expect(fixture.defaultStatus.hidden).toBe(false);
      expect(fixture.defaultStatus.textContent).toBe('Default Watermark');
      expect(fixture.setDefaultButton.disabled).toBe(true);

      fixture.watermarkSelect.value = '8';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      expect(fixture.setDefaultButton.disabled).toBe(false);
      fixture.root.__ccDirty = false;
      fixture.footer.applyBtn.disabled = false;
      fixture.setDefaultButton.dispatch('click', { target: fixture.setDefaultButton });
      await flush();

      expect(fetchState.calls).toContainEqual({
        url: '/processing/watermarks/default', method: 'POST', body: { watermarkId: 8 },
      });
      expect(fixture.root.__ccDirty).toBe(false);
      expect(fixture.footer.applyBtn.disabled).toBe(false);
      expect(fixture.setDefaultButton.disabled).toBe(true);
      expect(fixture.defaultStatus.textContent).toBe('Default Watermark');
    });
    it('shows format-dependent settings from all three output slots while preserving values', async () => {
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      syncWatermarkFormatSettings(fixture.root);

      expect(fixture.jpegBackground.hidden).toBe(true);
      expect(fixture.webpLossless.hidden).toBe(true);
      expect(fixture.quality.hidden).toBe(true);

      fixture.primaryFormat.value = 'jpeg';
      fixture.primaryFormat.dispatch('change', { target: fixture.primaryFormat });
      expect(fixture.jpegBackground.hidden).toBe(false);
      expect(fixture.webpLossless.hidden).toBe(true);
      expect(fixture.quality.hidden).toBe(false);

      fixture.jpegBackground.value = 'lavender';
      fixture.quality.value = '73';
      fixture.primaryFormat.value = 'png';
      fixture.primaryFormat.dispatch('change', { target: fixture.primaryFormat });
      expect(fixture.jpegBackground.hidden).toBe(true);
      expect(fixture.quality.hidden).toBe(true);
      expect(fixture.jpegBackground.value).toBe('lavender');
      expect(fixture.quality.value).toBe('73');

      fixture.secondaryFormat.value = 'jpeg';
      fixture.secondaryFormat.dispatch('change', { target: fixture.secondaryFormat });
      expect(fixture.jpegBackground.hidden).toBe(false);
      expect(fixture.quality.hidden).toBe(false);
      fixture.secondaryFormat.value = 'none';
      fixture.secondaryFormat.dispatch('change', { target: fixture.secondaryFormat });

      fixture.resizedFormat.value = 'jpeg';
      fixture.resizedFormat.dispatch('change', { target: fixture.resizedFormat });
      expect(fixture.jpegBackground.hidden).toBe(false);
      expect(fixture.quality.hidden).toBe(false);
      fixture.resizedFormat.value = 'none';
      fixture.resizedFormat.dispatch('change', { target: fixture.resizedFormat });

      fixture.secondaryFormat.value = 'webp';
      fixture.secondaryFormat.dispatch('change', { target: fixture.secondaryFormat });
      expect(fixture.webpLossless.hidden).toBe(false);
      expect(fixture.quality.hidden).toBe(false);
      fixture.webpLossless.checked = true;
      fixture.webpLossless.dispatch('change', { target: fixture.webpLossless });
      expect(fixture.quality.hidden).toBe(true);
      expect(fixture.quality.value).toBe('73');
      fixture.webpLossless.checked = false;
      fixture.webpLossless.dispatch('change', { target: fixture.webpLossless });
      expect(fixture.quality.hidden).toBe(false);
    });

    it('loads and replaces the singleton Scale Map, invalidating Watermark Preview', async () => {
      const watermark = buildWatermarkRoot(doc);
      const manage = buildManageScaleMapRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(manage);

      expect(fetchState.calls.some((call) => call.url === '/processing/scale-map' && call.method === 'GET')).toBe(true);
      const [width, height, scale] = manage.rows.children[0].querySelectorAll('input');
      expect([width.value, height.value, scale.value]).toEqual(['1024', '1024', '0.37']);
      watermark.root.__ccPreviewValid = true;
      watermark.footer.applyBtn.disabled = false;
      width.value = '1024';
      height.value = '1024';
      scale.value = '0.4';
      manage.save.dispatch('click');
      await flush();

      expect(fetchState.getScaleMap()).toEqual({ '1024x1024': 0.4, default: 0.1 });
      expect(watermark.root.__ccPreviewValid).toBe(false);
      expect(watermark.footer.applyBtn.disabled).toBe(true);
      expect(manage.status.textContent).toContain('Preview has been invalidated');
    });

    it('exports all Watermark settings without runtime Watermark, path, or Scale Map state', async () => {
      let exportedBlob;
      vi.stubGlobal('URL', {
        createObjectURL: vi.fn((blob) => { exportedBlob = blob; return 'blob:creatorcrate-watermark'; }),
        revokeObjectURL: vi.fn(),
      });
      const fixture = buildWatermarkRoot(doc);
      fetchState.seed({
        id: 12, operationType: 'watermark', displayName: 'Patreon',
        config: {
          mode: 'patreon', position: 'bl', outputFormat: 'png', quality: 90, maxDimension: null,
          watermarkAssetId: 77, watermarkId: 88, scaleMapId: 99, outputDirectory: 'project-output',
        }, watermarkId: 88,
      });
      fetchState.seed({
        id: 13, operationType: 'watermark', displayName: 'Social',
        config: { mode: 'social', position: 'br', outputFormat: 'jpg', quality: 80, singleSuffix: '_legacy', watermarkId: 89, scaleMapId: 100 },
        watermarkId: 89,
      });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.preset.select.value = '12';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.preset.exportBtn.dispatch('click');
      await flush();

      expect(exportedBlob, fixture.footer.errorText.textContent).toBeTruthy();
      const exported = JSON.parse(await exportedBlob.text());
      expect(exported).toMatchObject({
        creatorcrate: 'processing-presets', version: 1, operationType: 'watermark',
      });
      expect(exported.presets).toHaveLength(2);
      expect(exported.presets[0].displayName).toBe('Patreon');
      expect(exported.presets[0].config).not.toHaveProperty('watermarkAssetId');
      expect(exported.presets[0].config).not.toHaveProperty('watermarkId');
      expect(exported.presets[0].config).not.toHaveProperty('scaleMapId');
      expect(exported.presets[0].config).not.toHaveProperty('scaleMap');
      expect(exported.presets[0].config).not.toHaveProperty('outputDirectory');
      expect(exported.presets[0].config).not.toHaveProperty('outputDir');
      expect(exported.presets[0].config).not.toHaveProperty('outputCategoryId');
      expect(exported.presets[0].config.outputCategorySlug).toBe('project-output');
      expect(exported.presets[1]).toEqual({
        displayName: 'Social',
        config: { mode: 'social', position: 'br', primaryFormat: 'jpeg', secondaryFormat: null, resizedFormat: null, quality: 80, unresizedSuffix: '_legacy' },
      });
      expect(exported.presets[1].config).not.toHaveProperty('singleSuffix');
      expect(exported.presets[1].config).not.toHaveProperty('suffix');
      expect(exported).not.toHaveProperty('projectId');
      expect(exported).not.toHaveProperty('systemKey');
    });

    it('loads legacy singleSuffix configs into the canonical unresized field', async () => {
      const fixture = buildWatermarkRoot(doc);
      fetchState.seed({
        id: 14, operationType: 'watermark', displayName: 'Legacy suffix',
        config: { mode: 'custom', outputFormat: 'png', singleSuffix: '_legacy' },
        watermarkId: null,
      });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '14';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      await flush();

      expect(fixture.unresizedSuffix.value).toBe('_legacy');
      expect(fixture.resizedSuffix.value).toBe('');
    });

    it('rejects the removed single-preset and embedded Scale Map format without mutation', async () => {
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });

      fixture.preset.importInput.files = [{
        text: async () => JSON.stringify({
          creatorcrate: 'processing-preset', version: 1, operationType: 'watermark', displayName: 'Portable',
          config: { mode: 'custom', position: 'bl', outputFormat: 'png', quality: 90 },
          scaleMap: { displayName: 'Portable map', definition: { '1920x1080': 0.22, default: 0.1 } },
        }),
      }];
      fixture.preset.importInput.dispatch('change', { target: fixture.preset.importInput });
      await flush();

      expect(fixture.preset.select.value).toBe('');
      expect(fixture.watermarkSelect.value).toBe('7');
      expect(fixture.footer.error.hidden).toBe(false);
      expect(fixture.footer.status.textContent).not.toContain('imported');
      expect(fetchState.calls.some((call) => call.url === '/processing/presets/import' && call.method === 'POST')).toBe(false);
      expect(fetchState.calls.some((call) => call.url === '/processing/scale-map/replace')).toBe(false);
    });

    it('excludes runtime Watermark and Scale Map bindings from preset Save/Update', async () => {
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.watermarkSelect.value = '7';

      fixture.preset.saveBtn.dispatch('click');
      fixture.preset.nameInput.value = 'My Watermark Preset';
      fixture.preset.nameForm.dispatch('submit', { target: fixture.preset.nameForm });
      await flush();

      const createCall = fetchState.calls.find((c) => c.url === '/processing/presets' && c.method === 'POST');
      expect(createCall.body.operationType).toBe('watermark');
      expect(createCall.body).not.toHaveProperty('scaleMapId');
      expect(createCall.body).not.toHaveProperty('watermarkAssetId');
      expect(createCall.body).not.toHaveProperty('watermarkId');
      expect(createCall.body.config).not.toHaveProperty('watermarkAssetId');
      expect(createCall.body.config).not.toHaveProperty('watermarkId');
      expect(createCall.body.config).not.toHaveProperty('scaleMapId');
      expect(createCall.body.config).toMatchObject({
        mode: 'custom',
        position: 'bl',
        marginRatio: 0.02,
        maxDimension: 1100,
        primaryFormat: 'png',
        secondaryFormat: null,
        resizedFormat: null,
        unresizedSuffix: '_wm',
        resizedSuffix: '_lq_wm',
      });
      ['outputFormat', 'alsoUnresized', 'additionalFormats', 'additionalFormatsResized']
        .forEach((key) => expect(createCall.body.config).not.toHaveProperty(key));
      [
        'makeArchives', 'archiveIncludeResized', 'replaceExistingArchives', 'archiveFormat',
        'zipJpgQuality', 'zipWebpQuality', 'setName', 'archivePrefix', 'zipBaseName',
        'makeCbz', 'cbzJpgQuality', 'cbzPrefix', 'cbzFrom',
      ].forEach((key) => expect(createCall.body.config).not.toHaveProperty(key));
      const forbidden = ['projectId', 'assetIds', 'categoryId', 'directory', 'recursive', 'scope'];
      forbidden.forEach((key) => expect(Object.keys(createCall.body)).not.toContain(key));
    });

    it('keeps global Watermark selection runtime-only and does not mark the preset modified', async () => {
      const fixture = buildWatermarkRoot(doc);
      fetchState.seed({
        id: 6, operationType: 'watermark', displayName: 'Social Watermark',
        config: { mode: 'social', position: 'bl', marginRatio: 0.02, maxDimension: 1100, outputFormat: 'png', unresizedSuffix: '_wm', resizedSuffix: '_lq_wm', makeArchives: false, makeCbz: false, archiveFormat: 'zip', archivePrefix: '', alsoUnresized: false, deleteSource: true, additionalFormats: [] },
        watermarkId: null,
      });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '6';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      expect(fixture.watermarkSelect.value).toBe('');
      expect(fixture.preset.modified.hidden).toBe(true);

      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      expect(fixture.preset.modified.hidden).toBe(true);

      fixture.preset.updateBtn.dispatch('click');
      await flush();
      const replaceCall = fetchState.calls.find((c) => c.url === '/processing/presets/6/replace');
      expect(replaceCall.body).not.toHaveProperty('scaleMapId');
      expect(replaceCall.body).not.toHaveProperty('watermarkAssetId');
      expect(replaceCall.body).not.toHaveProperty('watermarkId');
      expect(replaceCall.body.config).toMatchObject({
        makeArchives: false,
        makeCbz: false,
        archiveFormat: 'zip',
        archivePrefix: '',
      });
      expect(fetchState.presets.get('6').watermarkId).toBeNull();
    });

    it('uses watermarkId for custom Preview and Apply payloads', async () => {
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      fixture.footer.previewBtn.dispatch('click');
      await flush();

      const previewCall = fetchState.calls.find((c) => c.url === '/projects/1/assets/processing/watermark/plan');
      expect(previewCall.body.options.watermarkId).toBe(7);
      expect(previewCall.body.options).not.toHaveProperty('watermarkAssetId');
      expect(previewCall.body.options).not.toHaveProperty('scaleMapId');
      expect(fixture.footer.applyBtn.disabled).toBe(false);

      fixture.footer.applyBtn.dispatch('click');
      await flush();
      const applyCall = fetchState.calls.find((c) => c.url === '/projects/1/assets/processing/watermark/apply');
      expect(applyCall.body.options.watermarkId).toBe(7);
      expect(applyCall.body.options).not.toHaveProperty('watermarkAssetId');
    });

    it('keeps the Plan and displays a Blob-backed Watermark image preview that is revoked on invalidation', async () => {
      const createObjectURL = vi.fn(() => 'blob:watermark-preview');
      const revokeObjectURL = vi.fn();
      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      fixture.footer.previewBtn.dispatch('click');
      await flush();

      expect(fixture.footer.plan.hidden).toBe(false);
      expect(fixture.previewSection.hidden).toBe(false);
      expect(fixture.previewImage.src).toBe('blob:watermark-preview');
      expect(fixture.previewImageWrap.hidden).toBe(false);
      expect(fixture.previewSource.textContent).toContain('Previewing source.png');
      expect(fixture.previewSource.textContent).toContain('first eligible asset of 2');
      expect(fetchState.calls.some((call) => call.url === '/projects/1/assets/processing/watermark/preview-image')).toBe(true);

      fixture.outputCategorySlug.value = 'wm-lq';
      fixture.outputCategorySlug.dispatch('change', { target: fixture.outputCategorySlug });
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:watermark-preview');
      expect(fixture.previewSection.hidden).toBe(true);
    });

    it('keeps the active object URL on image load and replaces a decode failure with controlled preview state', async () => {
      const createObjectURL = vi.fn(() => 'blob:watermark-preview');
      const revokeObjectURL = vi.fn();
      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      fixture.footer.previewBtn.dispatch('click');
      await flush();

      fixture.previewImage.dispatch('load');
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(fixture.root.__ccWatermarkPreviewUrl).toBe('blob:watermark-preview');

      fixture.previewImage.dispatch('error');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:watermark-preview');
      expect(fixture.root.__ccWatermarkPreviewUrl).toBeNull();
      expect(fixture.previewImage.getAttribute('src')).toBeNull();
      expect(fixture.previewImageWrap.hidden).toBe(true);
      expect(fixture.previewState.textContent).toBe('The image preview could not be displayed.');
      expect(fixture.footer.plan.hidden).toBe(false);
    });

    it('invalidates Apply but keeps Preview available across valid Output category changes', async () => {
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      expect(fixture.footer.previewBtn.disabled).toBe(false);
      expect(fixture.footer.applyBtn.disabled).toBe(true);

      fixture.footer.previewBtn.dispatch('click');
      await flush();
      expect(fixture.footer.applyBtn.disabled).toBe(false);

      fixture.outputCategorySlug.value = 'wm-lq';
      fixture.outputCategorySlug.dispatch('change', { target: fixture.outputCategorySlug });
      expect(fixture.root.__ccPreviewValid).toBe(false);
      expect(fixture.footer.applyBtn.disabled).toBe(true);
      expect(fixture.footer.previewBtn.disabled).toBe(false);

      fixture.outputCategorySlug.value = '';
      fixture.outputCategorySlug.dispatch('change', { target: fixture.outputCategorySlug });
      expect(fixture.footer.previewBtn.disabled).toBe(true);

      fixture.outputCategorySlug.value = 'wm';
      fixture.outputCategorySlug.dispatch('change', { target: fixture.outputCategorySlug });
      expect(fixture.footer.previewBtn.disabled).toBe(false);
    });

    it('invalidates Preview when the selected global Watermark changes', async () => {
      const fixture = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      fixture.root.__ccPreviewValid = true;
      fixture.footer.applyBtn.disabled = false;

      fixture.watermarkSelect.value = '';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });

      expect(fixture.root.__ccPreviewValid).toBe(false);
      expect(fixture.footer.applyBtn.disabled).toBe(true);
      expect(fixture.footer.previewBtn.disabled).toBe(true);
    });

    it('uses the selected global Watermark as runtimeResources for preset Preview', async () => {
      const fixture = buildWatermarkRoot(doc);
      fetchState.seed({
        id: 6, operationType: 'watermark', displayName: 'Social Watermark',
        config: { mode: 'social', position: 'bl', marginRatio: 0.02, maxDimension: 1100, outputFormat: 'png', unresizedSuffix: '_wm', resizedSuffix: '_lq_wm' },
        watermarkId: null,
      });
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      fixture.preset.select.value = '6';
      fixture.preset.select.dispatch('change', { target: fixture.preset.select });
      fixture.watermarkSelect.value = '7';
      fixture.watermarkSelect.dispatch('change', { target: fixture.watermarkSelect });
      fixture.footer.previewBtn.dispatch('click');
      await flush();

      const previewCall = fetchState.calls.find((c) => c.url === '/projects/1/assets/processing/watermark/plan');
      expect(previewCall.body.presetId).toBe(6);
      expect(previewCall.body.runtimeResources).toEqual({ watermarkId: 7 });
      expect(previewCall.body).not.toHaveProperty('options');
      expect(previewCall.body.runtimeResources).not.toHaveProperty('watermarkAssetId');
      expect(previewCall.body.runtimeResources).not.toHaveProperty('scaleMapId');
    });
  });

  describe('Global Watermarks manager', () => {
    it('decorates global Watermark options without changing the text-only native selection', () => {
      const fixture = buildWatermarkRoot(doc);
      addOption(fixture.watermarkSelect, '', 'Select a global Watermark…');
      addOption(fixture.watermarkSelect, '7', 'oliver.png — watermarks/oliver.png');
      const dropdown = makeNode('details', { 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' });
      const placeholder = makeNode('div');
      const placeholderLabel = makeNode('label');
      placeholderLabel.append(makeNode('input', { type: 'radio', value: '' }), makeNode('span'));
      placeholderLabel.children[1].textContent = 'Select a global Watermark…';
      placeholder.appendChild(placeholderLabel);
      const candidate = makeNode('div');
      const candidateLabel = makeNode('label');
      candidateLabel.append(makeNode('input', { type: 'radio', value: '7' }), makeNode('span'));
      candidateLabel.children[1].textContent = 'oliver.png — watermarks/oliver.png';
      candidate.appendChild(candidateLabel);
      dropdown.append(placeholder, candidate);
      fixture.root.appendChild(dropdown);
      fixture.root.__ccWatermarkCandidates = new Map([
        ['7', { id: 7, filename: 'oliver.png', relativePath: 'watermarks/oliver.png' }],
      ]);

      decorateWatermarkDropdownOptions(fixture.root);
      decorateWatermarkDropdownOptions(fixture.root);

      expect(placeholder.querySelector('img')).toBeNull();
      const image = candidate.querySelector('img');
      expect(image.getAttribute('src')).toBe('/processing/watermarks/7/image');
      expect(image.getAttribute('alt')).toBe('');
      expect(image.getAttribute('loading')).toBe('lazy');
      expect(candidate.querySelector('.processing-watermark-option-copy').textContent).toContain('oliver.png');
      expect(candidate.querySelectorAll('img')).toHaveLength(1);
      expect(fixture.watermarkSelect.options[1].textContent).toBe('oliver.png — watermarks/oliver.png');
    });

    it('loads global Watermark IDs into the processing selector', async () => {
      const processing = buildWatermarkRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(processing);

      expect(processing.watermarkSelect.options).toHaveLength(1);
      expect(processing.watermarkSelect.options[0].value).toBe('7');
      expect(processing.watermarkSelect.options[0].textContent).toContain('oliver.png');
      expect(processing.footer.previewBtn.disabled).toBe(true);
      processing.watermarkSelect.value = '7';
      processing.watermarkSelect.dispatch('change', { target: processing.watermarkSelect });
      expect(processing.footer.previewBtn.disabled).toBe(false);
    });

    it('uses the identical global candidate list for different project dialogs', async () => {
      const firstProject = buildWatermarkRoot(doc, '1');
      const secondProject = buildWatermarkRoot(doc, '8', 'processing-watermark-dialog-8');
      enhanceProcessingDialogs(doc);
      await openDialog(firstProject);
      await openDialog(secondProject);

      expect(firstProject.watermarkSelect.options.map((option) => [option.value, option.textContent]))
        .toEqual(secondProject.watermarkSelect.options.map((option) => [option.value, option.textContent]));
      expect(fetchState.calls.filter((call) => call.url === '/processing/watermarks' && call.method === 'GET')).toHaveLength(2);
      expect(fetchState.calls.some((call) => call.url.includes('/projects/1/watermarks'))).toBe(false);
      expect(fetchState.calls.some((call) => call.url.includes('/projects/8/watermarks'))).toBe(false);
    });

    it('loads global candidates, renders a safe thumbnail, and exposes no registry controls', async () => {
      const fixture = buildManageWatermarksRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      expect(fetchState.calls.some((call) => call.url === '/processing/watermarks' && call.method === 'GET')).toBe(true);
      expect(fixture.list.children).toHaveLength(1);
      const row = fixture.list.children[0];
      expect(row.dataset.watermarkId).toBe('7');
      expect(row.querySelector('img').src).toBe('/processing/watermarks/7/image');
      expect(row.querySelector('[data-processing-rename-watermark]')).toBeNull();
      expect(row.querySelector('[data-processing-replace-watermark]')).toBeNull();
      expect(row.querySelector('[data-processing-delete-watermark]')).toBeNull();
      expect(row.querySelector('input[type="file"]')).toBeNull();
    });

    it('renders the global-folder empty state when no candidates are indexed', async () => {
      fetchState.candidates.splice(0);
      const processing = buildWatermarkRoot(doc);
      const fixture = buildManageWatermarksRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(processing);
      await openDialog(fixture);

      expect(processing.watermarkSelect.options).toHaveLength(0);
      expect(processing.footer.previewBtn.disabled).toBe(true);
      expect(fixture.list.children).toHaveLength(1);
      expect(fixture.list.children[0].textContent).toContain('No Watermark PNGs found.');
    });

    it('scans the global Watermark folder, refreshes both views, preserves then clears selection', async () => {
      const processing = buildWatermarkRoot(doc);
      const manage = buildManageWatermarksRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(processing);
      processing.watermarkSelect.value = '7';
      processing.watermarkSelect.dispatch('change', { target: processing.watermarkSelect });
      processing.root.__ccPreviewValid = true;
      processing.footer.applyBtn.disabled = false;

      fetchState.candidates.push({ id: 8, filename: 'rory.png', relativePath: 'watermarks/rory.png' });
      await openDialog(manage);
      manage.scanButton.dispatch('click');
      await flush();

      expect(fetchState.calls.some((call) => call.url === '/processing/watermarks/scan' && call.method === 'POST')).toBe(true);
      expect(manage.list.children).toHaveLength(2);
      expect(processing.watermarkSelect.value).toBe('7');
      expect(processing.watermarkSelect.options.filter((option) => option.value === '7')).toHaveLength(1);
      expect(processing.watermarkSelect.options.some((option) => option.value === '8')).toBe(true);
      expect(manage.status.textContent).toContain('Scan complete');
      ['added', 'updated', 'restored', 'removed', 'total'].forEach((label) => expect(manage.status.textContent).toContain(label));
      expect(processing.footer.applyBtn.disabled).toBe(false);

      fetchState.candidates.splice(0);
      manage.scanButton.dispatch('click');
      await flush();
      expect(processing.watermarkSelect.value).toBe('');
      expect(processing.root.__ccPreviewValid).toBe(false);
      expect(processing.footer.applyBtn.disabled).toBe(true);
      expect(manage.list.children[0].textContent).toContain('No Watermark PNGs found.');
    });

    it('keeps global Scan available independently of project state', async () => {
      const fixture = buildManageWatermarksRoot(doc);
      enhanceProcessingDialogs(doc);
      await openDialog(fixture);

      expect(fixture.list.children).toHaveLength(1);
      expect(fixture.scanButton.disabled).toBe(false);
      fixture.scanButton.dispatch('click');
      await flush();
      expect(fetchState.calls.some((call) => call.url === '/processing/watermarks/scan')).toBe(true);
    });
  });

  describe('Shared number steppers', () => {
    it('enhances number fields once, uses native steps, and mirrors their accessible and disabled state', () => {
      const root = makeNode('div');
      const field = makeNode('div', { class: 'field' });
      const label = makeNode('label', { for: 'watermark-opacity' });
      label.textContent = 'Opacity';
      const input = makeNode('input', {
        id: 'watermark-opacity', type: 'number', min: '0', max: '100', step: '0.5', value: '99.5',
      });
      const inputEvents = vi.fn();
      const changeEvents = vi.fn();
      input.addEventListener('input', inputEvents);
      input.addEventListener('change', changeEvents);
      input.stepUp = vi.fn(() => {
        if (input.value !== '100') input.value = '100';
      });
      input.stepDown = vi.fn(() => {
        if (input.value !== '0') input.value = '99.5';
      });
      field.append(label, input);
      root.appendChild(field);
      doc.appendChild(root);

      expect(enhanceNumberInputs(doc)).toBe(1);
      expect(enhanceNumberInputs(doc)).toBe(0);
      const wrapper = input.parentNode;
      const [decrement, increment] = wrapper.children.slice(1);
      expect(root.querySelectorAll('[data-number-stepper]')).toHaveLength(1);
      expect([decrement.textContent, increment.textContent]).toEqual(['−', '+']);
      expect(decrement.getAttribute('aria-label')).toBe('Decrease Opacity');
      expect(increment.getAttribute('aria-label')).toBe('Increase Opacity');

      increment.dispatch('click');
      increment.dispatch('click');
      decrement.dispatch('click');
      expect(input.value).toBe('99.5');
      expect(input.stepUp).toHaveBeenCalledTimes(2);
      expect(input.stepDown).toHaveBeenCalledTimes(1);
      expect(inputEvents).toHaveBeenCalledTimes(2);
      expect(changeEvents).toHaveBeenCalledTimes(2);

      input.disabled = true;
      enhanceNumberInputs(doc);
      expect(decrement.disabled).toBe(true);
      expect(increment.disabled).toBe(true);
      input.disabled = false;
      enhanceNumberInputs(doc);
      expect(decrement.disabled).toBe(false);

      input.readOnly = true;
      increment.dispatch('click');
      expect(input.stepUp).toHaveBeenCalledTimes(2);

      const dynamic = makeNode('input', { type: 'number', value: '1', step: '1' });
      dynamic.stepUp = vi.fn(() => { dynamic.value = '2'; });
      root.appendChild(dynamic);
      expect(enhanceNumberInputs(root)).toBe(1);
      expect(dynamic.parentNode.querySelectorAll('[data-number-stepper-direction]')).toHaveLength(2);
    });

    it('initializes representative asset surfaces without an observer, avoids repeated DOM writes, and enhances replacement roots', () => {
      const observer = vi.fn(() => {
        throw new Error('The number-stepper enhancement must not install a document observer.');
      });
      doc.defaultView.MutationObserver = observer;

      const projects = makeNode('main', { 'data-projects-live-region': '' });
      const projectAssets = makeNode('main', { 'data-project-assets-live-region': '' });
      const assetViewer = makeNode('main', { 'data-asset-library-live-region': '' });
      const makeNumberField = (labelText) => {
        const field = makeNode('div', { class: 'field' });
        const label = makeNode('label');
        label.textContent = labelText;
        const input = makeNode('input', { type: 'number', value: '1', step: '1' });
        field.append(label, input);
        return { field, input };
      };
      const projectField = makeNumberField('Projects per page');
      const assetField = makeNumberField('Asset size');
      const viewerField = makeNumberField('Viewer zoom');
      projects.appendChild(projectField.field);
      projectAssets.appendChild(assetField.field);
      assetViewer.appendChild(viewerField.field);
      doc.append(projects, projectAssets, assetViewer);

      expect(() => enhanceNumberInputs(doc)).not.toThrow();
      expect(observer).not.toHaveBeenCalled();
      expect(doc.querySelectorAll('[data-number-stepper]')).toHaveLength(3);

      const enhancedNodes = doc.querySelectorAll('[data-number-stepper], [data-number-stepper-direction]');
      let writes = 0;
      enhancedNodes.forEach((node) => {
        const setAttribute = node.setAttribute.bind(node);
        node.setAttribute = (...args) => {
          writes += 1;
          return setAttribute(...args);
        };
      });
      expect(enhanceNumberInputs(doc)).toBe(0);
      expect(enhanceNumberInputs(doc)).toBe(0);
      expect(writes).toBe(0);

      const replacement = makeNode('main', { 'data-project-assets-live-region': '' });
      const replacementField = makeNumberField('Replacement asset size');
      replacement.appendChild(replacementField.field);
      projectAssets.children.slice().forEach((child) => child.remove());
      projectAssets.appendChild(replacement);
      expect(enhanceNumberInputs(replacement)).toBe(1);
      expect(enhanceNumberInputs(replacement)).toBe(0);
      expect(replacement.querySelectorAll('[data-number-stepper]')).toHaveLength(1);
      expect(replacement.querySelectorAll('[data-number-stepper-direction]')).toHaveLength(2);
    });

    it('enhances dynamically inserted scale-map number fields through Processing lifecycle', () => {
      const scaleMap = buildManageScaleMapRoot(doc);
      enhanceProcessingDialogs(doc);

      scaleMap.addRow.dispatch('click');

      expect(scaleMap.rows.querySelectorAll('input[type="number"]')).toHaveLength(3);
      expect(scaleMap.rows.querySelectorAll('[data-number-stepper]')).toHaveLength(3);
      expect(scaleMap.rows.querySelectorAll('[data-number-stepper-direction]')).toHaveLength(6);
    });

    it('routes a real Watermark numeric change through Processing dirty tracking', async () => {
      const fixture = buildWatermarkRoot(doc);
      const field = makeNode('div', { class: 'field' });
      const label = makeNode('label', { for: 'watermark-opacity' });
      label.textContent = 'Opacity';
      const opacity = makeNode('input', {
        id: 'watermark-opacity', type: 'number', value: '75', step: '5',
        'data-processing-field': 'opacity', 'data-processing-type': 'float',
      });
      opacity.stepUp = vi.fn(() => { opacity.value = '80'; });
      field.append(label, opacity);
      fixture.root.appendChild(field);

      enhanceProcessingDialogs(doc);
      await openDialog(fixture);
      fixture.root.__ccPreviewValid = true;
      fixture.footer.applyBtn.disabled = false;
      fixture.footer.previewBtn.disabled = false;
      enhanceNumberInputs(doc);

      opacity.parentNode.querySelector('[data-number-stepper-direction="increment"]').dispatch('click');

      expect(opacity.value).toBe('80');
      expect(opacity.stepUp).toHaveBeenCalledTimes(1);
      expect(fixture.root.__ccPreviewValid).toBe(false);
      expect(fixture.footer.applyBtn.disabled).toBe(true);
      expect(fixture.footer.previewBtn.disabled).toBe(false);
    });
  });
});
