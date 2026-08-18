/**
 * Scope UI behavior for the Convert / Workflow Prompt / Watermark processing
 * dialogs on /projects/:id/assets.
 *
 * Exercises the shared scopeSection markup + processing.js logic against a
 * minimal DOM shim: default-scope precedence, manual-scope stability,
 * request serialization, and preview invalidation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enhanceDropdowns } from '../src/static/creatorcrate.js';
import { enhanceProcessingDialogs } from '../src/static/processing.js';

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
  if (rest.includes(':not(:disabled)')) {
    if (node.disabled) return false;
    rest = rest.replace(':not(:disabled)', '');
  }
  if (rest.includes(':disabled') && !rest.includes(':not(:disabled)')) {
    if (!node.disabled) return false;
    rest = rest.replace(':disabled', '');
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
      this.children.push(child);
      child.parentNode = this;
      child.parentElement = this;
      const doc = this.ownerDocument || (this.nodeType === 9 ? this : null);
      const adopt = (n) => { n.ownerDocument = doc; n.children.forEach(adopt); };
      adopt(child);
      if (this.tagName === 'SELECT' && child.tagName === 'OPTION') this.options.push(child);
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
    addEventListener(type, handler) { this.__listeners.push({ type, handler }); },
    dispatch(type, props = {}) {
      const event = { type, target: props.target || this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
      let node = event.target;
      while (node) {
        node.__listeners?.filter((l) => l.type === type).forEach((l) => l.handler(event));
        node = node.parentNode;
      }
      return event;
    },
    dispatchEvent(event) { return this.dispatch(event.type, { ...event, target: this }); },
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
  Object.defineProperty(node, 'id', { get() { return node.__attrs.get('id') || ''; }, set(v) { node.setAttribute('id', v); } });
  Object.defineProperty(node, 'name', { get() { return node.__attrs.get('name') || ''; }, set(v) { node.setAttribute('name', v); } });
  Object.defineProperty(node, 'type', { get() { return node.__attrs.get('type') || ''; }, set(v) { node.setAttribute('type', v); } });
  Object.defineProperty(node, 'value', {
    get() { return node.__attrs.has('value') ? node.__attrs.get('value') : ''; },
    set(v) { node.__attrs.set('value', String(v)); },
  });
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

function makeOption(value, label = value, { selected = false, disabled = false } = {}) {
  const option = makeNode('option', { value });
  option.textContent = label;
  option.disabled = disabled;
  if (selected) option.setAttribute('selected', '');
  return option;
}

function addEnhancedCategoryDropdown(categoryField, categorySelect, prefix) {
  const dropdown = makeNode('details', {
    id: `${prefix}-category-select-dropdown`,
    class: 'asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown',
    'data-cc-dropdown': '',
    'data-cc-dropdown-mode': 'single',
    'data-cc-dropdown-dispatch-native-change': '',
  });
  const summary = makeNode('summary', { 'aria-label': 'Category filter: Select a category…' });
  const currentSummary = makeNode('span', { 'data-cc-dropdown-summary-current': '' });
  currentSummary.textContent = 'Select a category…';
  summary.appendChild(currentSummary);
  dropdown.appendChild(summary);

  const panel = makeNode('div', { class: 'asset-filter-multiselect-panel' });
  categorySelect.options.forEach((option) => {
    const row = makeNode('div', { class: 'asset-filter-multiselect-option' });
    const label = makeNode('label');
    const input = makeNode('input', { type: 'radio', value: String(option.value) });
    if (String(option.value) === '') input.checked = true;
    const span = makeNode('span');
    span.textContent = option.textContent;
    label.textContent = option.textContent;
    label.appendChild(input);
    label.appendChild(span);
    row.appendChild(label);
    panel.appendChild(row);
  });
  dropdown.appendChild(panel);
  categoryField.appendChild(dropdown);
  return dropdown;
}

function buildScopeSection(prefix, categories = [], { enhanced = false } = {}) {
  const fieldset = makeNode('section', {
    class: 'settings-section processing-dialog-section',
    'data-processing-scope': '',
    role: 'radiogroup',
    'aria-labelledby': prefix + '-scope-heading',
  });
  const heading = makeNode('h3', { id: prefix + '-scope-heading' });
  heading.textContent = 'Scope';
  fieldset.appendChild(heading);
  const sectionBody = makeNode('div', { class: 'processing-dialog-section-body processing-scope-body' });
  fieldset.appendChild(sectionBody);

  const selectedLabel = makeNode('label', { class: 'field field--checkbox processing-scope-option' });
  const selectedRadio = makeNode('input', {
    type: 'radio', name: prefix + '-scope-type', value: 'selected', 'data-processing-scope-option': 'selected', checked: '',
  });
  selectedLabel.appendChild(selectedRadio);
  selectedLabel.appendChild(makeNode('span'));
  sectionBody.appendChild(selectedLabel);

  const count = makeNode('span', { 'data-processing-selected-count': '' });
  count.textContent = '0';
  selectedLabel.appendChild(count);

  const hint = makeNode('p', { class: 'processing-scope-hint help-text', 'data-processing-selected-hint': '', hidden: '' });
  sectionBody.appendChild(hint);

  const categoryLabel = makeNode('label', { class: 'field field--checkbox processing-scope-option' });
  const categoryRadio = makeNode('input', {
    type: 'radio', name: prefix + '-scope-type', value: 'category', 'data-processing-scope-option': 'category',
  });
  categoryLabel.appendChild(categoryRadio);
  categoryLabel.appendChild(makeNode('span'));
  sectionBody.appendChild(categoryLabel);

  const categoryField = makeNode('div', { class: 'processing-scope-category-field' });
  const categorySelect = makeNode('select', {
    class: 'cc-dropdown-native-select',
    'data-processing-category-select': '',
    'data-cc-dropdown-native-select': '',
    'aria-label': 'Category',
  });
  categorySelect.appendChild(makeOption('', 'Select a category…'));
  categories.forEach((cat) => categorySelect.appendChild(makeOption(String(cat.id), cat.label, { selected: cat.selected })));
  categoryField.appendChild(categorySelect);
  const categoryDropdown = enhanced ? addEnhancedCategoryDropdown(categoryField, categorySelect, prefix) : null;
  sectionBody.appendChild(categoryField);

  const projectLabel = makeNode('label', { class: 'field field--checkbox processing-scope-option' });
  const projectRadio = makeNode('input', {
    type: 'radio', name: prefix + '-scope-type', value: 'project', 'data-processing-scope-option': 'project',
  });
  projectLabel.appendChild(projectRadio);
  projectLabel.appendChild(makeNode('span'));
  sectionBody.appendChild(projectLabel);

  return { fieldset, selectedRadio, categoryRadio, projectRadio, categorySelect, categoryDropdown, hint };
}

function makeCheckbox(value, checked = false) {
  const input = makeNode('input', {
    type: 'checkbox', class: 'asset-select-checkbox', name: 'selectedAssetIds', value: String(value),
  });
  input.checked = checked;
  return input;
}

function buildDialogRoot(doc, { operation = 'convert', categories = [], projectId = '1', enhancedCategory = false } = {}) {
  const dialog = makeNode('dialog', { id: `processing-${operation}-dialog`, class: 'app-dialog app-dialog--processing' });
  const root = makeNode('div', {
    class: 'app-dialog-body processing-dialog-body',
    'data-processing-root': '',
    'data-processing-operation': operation,
    'data-project-id': projectId,
    'data-csrf': 'csrf-token',
  });
  const scope = buildScopeSection(operation, categories, { enhanced: enhancedCategory });
  root.appendChild(scope.fieldset);

  const plan = makeNode('div', { 'data-processing-plan': '', hidden: '' });
  const result = makeNode('div', { 'data-processing-result': '', hidden: '' });
  const resultBody = makeNode('div', { 'data-processing-result-body': '' });
  result.appendChild(resultBody);
  const error = makeNode('div', { 'data-processing-error': '', hidden: '' });
  const errorText = makeNode('p', { 'data-processing-error-text': '' });
  error.appendChild(errorText);
  const status = makeNode('div', { 'data-processing-status': '' });
  const previewBtn = makeNode('button', { type: 'button', 'data-processing-preview': '' });
  const applyBtn = makeNode('button', { type: 'button', 'data-processing-apply': '', disabled: '' });
  root.append(plan, result, error, status, previewBtn, applyBtn);

  dialog.appendChild(root);
  const trigger = makeNode('button', { type: 'button', 'data-dialog-open': `processing-${operation}-dialog` });
  doc.appendChild(dialog);
  doc.appendChild(trigger);

  return { dialog, root, trigger, scope, previewBtn, applyBtn, status, errorText, resultBody };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Processing dialog scope defaults', () => {
  let doc;
  let fetchMock;

  beforeEach(() => {
    doc = makeDocument();
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('A. selects "Selected assets" when assets are checked even on a concrete category page', async () => {
    const checkbox = makeCheckbox(42, true);
    doc.appendChild(checkbox);

    const { root, trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 7, label: 'Final (1)', selected: true }],
    });
    doc.defaultView.location.search = '?category=7';

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    expect(scope.selectedRadio.checked).toBe(true);
    expect(scope.categoryRadio.checked).toBe(false);
    expect(scope.projectRadio.checked).toBe(false);
  });

  it('B. selects "Category" and preselects the current category with no selection', async () => {
    const { root, trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 7, label: 'Final (1)', selected: false }],
    });
    doc.defaultView.location.search = '?category=7';

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    expect(scope.selectedRadio.checked).toBe(false);
    expect(scope.categoryRadio.checked).toBe(true);
    expect(scope.projectRadio.checked).toBe(false);
    expect(scope.categorySelect.value).toBe('7');
  });

  it('C. falls back to "Entire project" on All with no selection', async () => {
    const { root, trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 7, label: 'Final (1)', selected: false }],
    });
    doc.defaultView.location.search = '?category=all';

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    expect(scope.selectedRadio.checked).toBe(false);
    expect(scope.categoryRadio.checked).toBe(false);
    expect(scope.projectRadio.checked).toBe(true);
  });

  it('D. falls back to "Entire project" on Uncategorized with no selection', async () => {
    const { root, trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 7, label: 'Final (1)', selected: false }],
    });
    doc.defaultView.location.search = '?category=uncategorized';

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    expect(scope.projectRadio.checked).toBe(true);
  });

  it('E. still defaults to current category on the ordinary/downgraded surface', async () => {
    const { root, trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 7, label: 'Final (1)', selected: false }],
    });
    doc.defaultView.location.search = '?category=7&search=keep';

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    expect(scope.categoryRadio.checked).toBe(true);
    expect(scope.categorySelect.value).toBe('7');
  });

  it('detects a new current category after a live-filter-style URL change', async () => {
    const { trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [
        { id: 7, label: 'Final (1)', selected: true },
        { id: 8, label: 'WIP (1)', selected: false },
      ],
    });

    doc.defaultView.location.search = '?category=7';
    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();
    expect(scope.categoryRadio.checked).toBe(true);
    expect(scope.categorySelect.value).toBe('7');

    // Simulate live filter switching to a different concrete category.
    doc.defaultView.location.search = '?category=8';
    trigger.dispatch('click', { target: trigger });
    await flush();
    expect(scope.categoryRadio.checked).toBe(true);
    expect(scope.categorySelect.value).toBe('8');
  });
});

describe('Processing category dropdown synchronization', () => {
  it('activates Category scope from an enhanced selection in every processing dialog', async () => {
    for (const operation of ['convert', 'workflow-prompt', 'watermark', 'archive']) {
      const doc = makeDocument();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } }),
      })));
      const { trigger, scope, applyBtn } = buildDialogRoot(doc, {
        operation,
        categories: [
          { id: 6, label: 'Final (1)', selected: false },
          { id: 8, label: 'WIP (1)', selected: false },
        ],
        enhancedCategory: true,
      });

      enhanceDropdowns(doc);
      enhanceProcessingDialogs(doc);
      trigger.dispatch('click', { target: trigger });
      await flush();

      expect(scope.categorySelect.disabled).toBe(false);
      expect(scope.projectRadio.checked).toBe(true);
      applyBtn.disabled = false;

      const enhancedOption = scope.categoryDropdown.querySelector('input[value="8"]');
      enhancedOption.checked = true;
      enhancedOption.dispatch('change', { target: enhancedOption });
      await flush();

      expect(scope.categoryRadio.checked).toBe(true);
      expect(scope.categorySelect.value).toBe('8');
      expect(enhancedOption.checked).toBe(true);
      expect(applyBtn.disabled).toBe(true);
    }
  });

  it('resynchronizes the enhanced summary after live-filter URL category changes', async () => {
    const doc = makeDocument();
    const { trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [
        { id: 6, label: 'Final (1)', selected: false },
        { id: 7, label: 'WIP (1)', selected: false },
      ],
      enhancedCategory: true,
    });

    enhanceDropdowns(doc);
    enhanceProcessingDialogs(doc);
    doc.defaultView.location.search = '?category=6';
    trigger.dispatch('click', { target: trigger });
    await flush();

    const firstOption = scope.categoryDropdown.querySelector('input[value="6"]');
    const currentSummary = scope.categoryDropdown.querySelector('[data-cc-dropdown-summary-current]');
    expect(scope.categoryRadio.checked).toBe(true);
    expect(scope.categorySelect.value).toBe('6');
    expect(firstOption.checked).toBe(true);
    expect(scope.categoryDropdown.querySelectorAll('input[type="radio"]').every((input) => !input.disabled)).toBe(true);
    expect(scope.categoryDropdown.hasAttribute('data-cc-dropdown-disabled')).toBe(false);
    expect(doc.querySelectorAll('[data-cc-dropdown]').filter((dropdown) => dropdown === scope.categoryDropdown)).toHaveLength(1);
    expect(currentSummary.textContent).toBe('Final (1)');

    doc.defaultView.location.search = '?category=7';
    trigger.dispatch('click', { target: trigger });
    await flush();

    expect(scope.categorySelect.value).toBe('7');
    expect(scope.categoryDropdown.querySelector('input[value="7"]').checked).toBe(true);
    expect(currentSummary.textContent).toBe('WIP (1)');
  });
});

describe('Processing dialog live selection behavior', () => {
  let doc;

  beforeEach(() => {
    doc = makeDocument();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } }),
    })));
  });

  it('does not jump back to Selected when a checkbox changes after the user picked a different scope', async () => {
    const checkbox = makeCheckbox(42, true);
    doc.appendChild(checkbox);

    const { trigger, scope } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 7, label: 'Final (1)', selected: false }],
    });

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    // Default with checked asset -> Selected
    expect(scope.selectedRadio.checked).toBe(true);

    // User switches to Project
    scope.projectRadio.checked = true;
    scope.projectRadio.dispatch('change', { target: scope.projectRadio });

    // Then unchecks the asset
    checkbox.checked = false;
    checkbox.dispatch('change', { target: checkbox });
    await flush();

    expect(scope.projectRadio.checked).toBe(true);
    expect(scope.selectedRadio.checked).toBe(false);
  });
});

describe('Processing dialog scope serialization', () => {
  let doc;
  let fetchMock;
  let calls;

  beforeEach(() => {
    doc = makeDocument();
    calls = [];
    fetchMock = vi.fn(async (url, init = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('serializes selected scope with checked IDs', async () => {
    const checkbox = makeCheckbox(42, true);
    doc.appendChild(checkbox);

    const { trigger, previewBtn } = buildDialogRoot(doc, { operation: 'convert' });
    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    previewBtn.dispatch('click', { target: previewBtn });
    await flush();

    expect(calls[0].body.scope).toEqual({ type: 'selected', assetIds: [42] });
  });

  it('serializes category scope with the picker value', async () => {
    const { trigger, scope, previewBtn } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 7, label: 'Final (1)', selected: true }],
    });
    scope.categoryRadio.checked = true;
    doc.defaultView.location.search = '?category=7';

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    previewBtn.dispatch('click', { target: previewBtn });
    await flush();

    expect(calls[0].body.scope).toEqual({ type: 'category', categoryId: 7 });
  });

  it('serializes project scope and never includes directory/recursive fields', async () => {
    const { trigger, scope, previewBtn } = buildDialogRoot(doc, { operation: 'convert' });
    scope.projectRadio.checked = true;

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    previewBtn.dispatch('click', { target: previewBtn });
    await flush();

    expect(calls[0].body.scope).toEqual({ type: 'project' });
    const bodyJson = JSON.stringify(calls[0].body);
    expect(bodyJson).not.toContain('relativePath');
    expect(bodyJson).not.toContain('recursive');
    expect(bodyJson).not.toContain('directory');
  });

  it('ignores an enhanced category placeholder radio when resolving project scope', async () => {
    const { trigger, scope, previewBtn } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [{ id: 8, label: 'WIP (1)', selected: false }],
      enhancedCategory: true,
    });

    enhanceDropdowns(doc);
    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    const placeholder = scope.categoryDropdown.querySelector('input[value=""]');
    expect(placeholder).not.toBeNull();
    expect(placeholder.checked).toBe(true);

    scope.projectRadio.checked = true;
    previewBtn.dispatch('click', { target: previewBtn });
    await flush();

    expect(calls[0].body.scope).toEqual({ type: 'project' });
  });

  it('invalidates preview when scope changes', async () => {
    const checkbox = makeCheckbox(42, true);
    doc.appendChild(checkbox);

    const { trigger, scope, previewBtn, applyBtn } = buildDialogRoot(doc, { operation: 'convert' });
    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    previewBtn.dispatch('click', { target: previewBtn });
    await flush();
    await flush();
    expect(applyBtn.disabled).toBe(false);

    scope.projectRadio.checked = true;
    scope.projectRadio.dispatch('change', { target: scope.projectRadio });

    expect(applyBtn.disabled).toBe(true);
  });

  it('invalidates preview when the category picker changes', async () => {
    const { trigger, scope, previewBtn, applyBtn } = buildDialogRoot(doc, {
      operation: 'convert',
      categories: [
        { id: 7, label: 'Final (1)', selected: true },
        { id: 8, label: 'WIP (1)', selected: false },
      ],
    });
    scope.categoryRadio.checked = true;
    doc.defaultView.location.search = '?category=7';

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    previewBtn.dispatch('click', { target: previewBtn });
    await flush();
    await flush();
    expect(applyBtn.disabled).toBe(false);

    scope.categorySelect.value = '8';
    scope.categorySelect.dispatch('change', { target: scope.categorySelect });

    expect(applyBtn.disabled).toBe(true);
  });

  it('serializes standalone Archive options and uses the explicit archive route', async () => {
    const { root, trigger, scope, previewBtn } = buildDialogRoot(doc, { operation: 'archive' });
    const makeArchives = makeNode('input', { type: 'checkbox', 'data-processing-field': 'makeArchives', 'data-processing-type': 'bool' });
    makeArchives.checked = true;
    const archiveFormat = makeNode('select', { 'data-processing-field': 'archiveFormat', 'data-processing-type': 'string' });
    archiveFormat.appendChild(makeOption('zip', 'ZIP'));
    archiveFormat.appendChild(makeOption('7z', '7z'));
    archiveFormat.value = '7z';
    const setName = makeNode('input', { type: 'text', 'data-processing-field': 'setName', 'data-processing-type': 'string', 'data-processing-omit-if-empty': 'true' });
    setName.value = 'release-set';
    const jpegQuality = makeNode('input', { type: 'number', 'data-processing-field': 'zipJpgQuality', 'data-processing-type': 'int' });
    jpegQuality.value = '80';
    const webpQuality = makeNode('input', { type: 'number', 'data-processing-field': 'zipWebpQuality', 'data-processing-type': 'int' });
    webpQuality.value = '90';
    const replaceExisting = makeNode('input', { type: 'checkbox', 'data-processing-field': 'replaceExistingArchives', 'data-processing-type': 'bool' });
    const makeCbz = makeNode('input', { type: 'checkbox', 'data-processing-field': 'makeCbz', 'data-processing-type': 'bool' });
    makeCbz.checked = true;
    const cbzQuality = makeNode('input', { type: 'number', 'data-processing-field': 'cbzJpgQuality', 'data-processing-type': 'int' });
    cbzQuality.value = '85';
    const cbzPrefix = makeNode('input', { type: 'text', 'data-processing-field': 'cbzPrefix', 'data-processing-type': 'string', 'data-processing-omit-if-empty': 'true' });
    cbzPrefix.value = 'comic_';
    root.append(makeArchives, archiveFormat, setName, jpegQuality, webpQuality, replaceExisting, makeCbz, cbzQuality, cbzPrefix);
    scope.projectRadio.checked = true;

    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();
    previewBtn.dispatch('click', { target: previewBtn });
    await flush();

    expect(calls[0].url).toBe('/projects/1/assets/processing/archive/plan');
    expect(calls[0].body).toEqual({
      scope: { type: 'project' },
      options: {
        makeArchives: true,
        archiveFormat: '7z',
        setName: 'release-set',
        zipJpgQuality: 80,
        zipWebpQuality: 90,
        replaceExistingArchives: false,
        makeCbz: true,
        cbzJpgQuality: 85,
        cbzPrefix: 'comic_',
      },
    });
  });

  it('gates Archive Apply on planner blockers and renders the Apply result after a clean preview', async () => {
    let cleanPlan = false;
    calls = [];
    fetchMock = vi.fn(async (url, init = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/archive/plan')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            plan: {
              operation: 'archive',
              counts: { total: 2, eligible: 2, conflicts: cleanPlan ? 0 : 1 },
              sourceCount: 2,
              entryCount: 4,
              archives: [{
                kind: 'archive-jpg', format: 'zip', containerFormat: 'zip', relativePath: 'archive_jpg.zip',
                quality: 80, entryCount: 2, status: cleanPlan ? 'ready' : 'conflict',
                reasonCode: cleanPlan ? null : 'ARCHIVE_DESTINATION_CONFLICT',
              }],
              operationBlockers: cleanPlan ? [] : [{ code: 'ARCHIVE_DESTINATION_CONFLICT', reason: 'Archive destination already exists.' }],
              items: [],
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            sourceCount: 2,
            artifacts: [{ relativePath: 'archive_jpg.zip', format: 'zip', containerFormat: 'zip', quality: 80, entryCount: 2 }],
          },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { trigger, scope, previewBtn, applyBtn, resultBody } = buildDialogRoot(doc, { operation: 'archive' });
    scope.projectRadio.checked = true;
    enhanceProcessingDialogs(doc);
    trigger.dispatch('click', { target: trigger });
    await flush();

    previewBtn.dispatch('click', { target: previewBtn });
    await flush();
    expect(applyBtn.disabled).toBe(true);

    cleanPlan = true;
    previewBtn.dispatch('click', { target: previewBtn });
    await flush();
    expect(applyBtn.disabled).toBe(false);

    applyBtn.dispatch('click', { target: applyBtn });
    await flush();
    expect(calls.map((call) => call.url)).toEqual([
      '/projects/1/assets/processing/archive/plan',
      '/projects/1/assets/processing/archive/plan',
      '/projects/1/assets/processing/archive/apply',
    ]);
    expect(resultBody.children[0].textContent).toContain('Generated 1 archive artifact');
  });
});
