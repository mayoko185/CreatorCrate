/**
 * Scope UI behavior for the Convert / Workflow Prompt / Watermark processing
 * dialogs on /projects/:id/assets.
 *
 * Exercises the shared scopeSection markup + processing.js logic against a
 * minimal DOM shim: default-scope precedence, manual-scope stability,
 * request serialization, and preview invalidation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  return { dialog, root, trigger, scope, previewBtn, applyBtn, status, errorText, result, resultBody };
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

describe('Processing background-job polling', () => {
  let doc;
  let fetchMock;

  const ok = (body, status = 200) => ({ ok: true, status, json: async () => body });
  const failed = (status, message, code = 'PROCESSING_JOB_STATE') => ({
    ok: false,
    status,
    json: async () => ({ ok: false, error: { code, message } }),
  });
  const job = (id, state, { progress = null, result = null, error = null } = {}) => ({
    ok: true,
    job: { id, state, progress, result, error },
  });
  const deferred = () => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  };

  beforeEach(() => {
    doc = makeDocument();
    vi.stubGlobal('document', doc);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function previewAndApply(fixture) {
    fixture.scope.projectRadio.checked = true;
    enhanceProcessingDialogs(doc);
    fixture.trigger.dispatch('click', { target: fixture.trigger });
    await flush();
    fixture.previewBtn.dispatch('click', { target: fixture.previewBtn });
    await flush();
    fixture.applyBtn.dispatch('click', { target: fixture.applyBtn });
    await flush();
  }

  it('accepts 202 work, polls queued/running progress, blocks duplicate Apply, and keeps one poll loop', async () => {
    vi.useFakeTimers();
    const calls = [];
    let polls = 0;
    fetchMock = vi.fn(async (url, init = {}) => {
      calls.push({ url, method: init.method || 'POST' });
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'convert', jobId: 'job-1' }, 202);
      if (url === '/processing/jobs/job-1') {
        polls += 1;
        if (polls === 1) return ok(job('job-1', 'queued'));
        if (polls === 2) return ok(job('job-1', 'running', { progress: { completed: 1, total: 3 } }));
        return ok(job('job-1', 'running', { progress: { completed: 2, total: 3 } }));
      }
      if (url === '/projects/1/scan') return ok({ ok: true });
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'convert' });

    await previewAndApply(fixture);
    fixture.applyBtn.dispatch('click', { target: fixture.applyBtn });
    await flush();
    expect(calls.filter((call) => call.url.endsWith('/apply'))).toHaveLength(1);
    expect(fixture.status.textContent).toBe('Processing queued.');
    expect(fixture.result.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(fixture.status.textContent).toBe('Processing… 1 of 3.');

    expect(polls).toBe(2);
    expect(fixture.result.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes succeeded jobs from job.result.result and uses job.result.refreshUrl for the normal refresh flow', async () => {
    const calls = [];
    fetchMock = vi.fn(async (url) => {
      calls.push(url);
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'convert', jobId: 'job-succeeded' }, 202);
      if (url === '/processing/jobs/job-succeeded') {
        return ok(job('job-succeeded', 'succeeded', {
          result: { result: { convertedCount: 1, requestedCount: 1, format: 'webp' }, refreshUrl: '/projects/1/assets' },
        }));
      }
      if (url === '/projects/1/scan') return ok({ ok: true });
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'convert' });

    await previewAndApply(fixture);
    await flush();

    expect(fixture.result.hidden).toBe(false);
    expect(fixture.resultBody.children[0].textContent).toContain('Converted 1 of 1 asset');
    expect(calls).toContain('/projects/1/scan');
  });

  it('lets only the first succeeded poll own completion while its rescan is pending across reopen', async () => {
    vi.useFakeTimers();
    const firstStatus = deferred();
    const rescan = deferred();
    let polls = 0;
    let rescans = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'convert', jobId: 'job-terminal-owner' }, 202);
      if (url === '/processing/jobs/job-terminal-owner') {
        polls += 1;
        if (polls === 1) return firstStatus.promise;
        return ok(job('job-terminal-owner', 'succeeded', {
          result: { result: { convertedCount: 1, requestedCount: 1, format: 'webp' }, refreshUrl: '/projects/1/assets' },
        }));
      }
      if (url === '/projects/1/scan') {
        rescans += 1;
        return rescan.promise;
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'convert' });
    let resultRenders = 0;
    const appendResult = fixture.resultBody.append.bind(fixture.resultBody);
    fixture.resultBody.append = (...nodes) => {
      resultRenders += 1;
      return appendResult(...nodes);
    };

    await previewAndApply(fixture);
    expect(polls).toBe(1);

    firstStatus.resolve(ok(job('job-terminal-owner', 'succeeded', {
      result: { result: { convertedCount: 1, requestedCount: 1, format: 'webp' }, refreshUrl: '/projects/1/assets' },
    })));
    await flush();

    expect(rescans).toBe(1);
    expect(resultRenders).toBe(1);

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    fixture.trigger.dispatch('click', { target: fixture.trigger });
    await flush();

    expect(polls).toBe(2);
    expect(rescans).toBe(1);
    expect(resultRenders).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    rescan.resolve(ok({ ok: true }));
    await flush();

    expect(rescans).toBe(1);
    expect(resultRenders).toBe(1);
    expect(fixture.root.__ccProcessingJob).toBeNull();
    expect(fixture.root.__ccProcessingBusy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an older succeeded completion clear a newer active job', async () => {
    vi.useFakeTimers();
    const rescan = deferred();
    let newerPolls = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'convert', jobId: 'job-older' }, 202);
      if (url === '/processing/jobs/job-older') {
        return ok(job('job-older', 'succeeded', {
          result: { result: { convertedCount: 1, requestedCount: 1, format: 'webp' }, refreshUrl: '/projects/1/assets' },
        }));
      }
      if (url === '/processing/jobs/job-newer') {
        newerPolls += 1;
        return ok(job('job-newer', 'running', { progress: { completed: 1, total: 2 } }));
      }
      if (url === '/projects/1/scan') return rescan.promise;
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'convert' });

    await previewAndApply(fixture);
    await flush();

    const newerJob = { id: 'job-newer', state: 'running', progress: null };
    fixture.root.__ccProcessingJob = newerJob;
    fixture.root.__ccProcessingBusy = true;
    rescan.resolve(ok({ ok: true }));
    await flush();

    expect(fixture.root.__ccProcessingJob).toBe(newerJob);
    expect(fixture.root.__ccProcessingBusy).toBe(true);

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    fixture.trigger.dispatch('click', { target: fixture.trigger });
    await flush();

    expect(newerPolls).toBe(1);
    expect(fixture.root.__ccProcessingJob).toBe(newerJob);
    expect(fixture.status.textContent).toBe('Processing… 1 of 2.');
    expect(vi.getTimerCount()).toBe(1);

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces the sanitized failed-job error and stops polling', async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-failed' }, 202);
      if (url === '/processing/jobs/job-failed') {
        return ok(job('job-failed', 'failed', { error: { code: 'PROCESSING_FAILED', message: 'Processing could not be completed.' } }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);

    expect(fixture.errorText.textContent).toBe('Processing could not be completed.');
    expect(fixture.status.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates cancelled jobs without leaving a poll timer', async () => {
    vi.useFakeTimers();
    let polls = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-cancelled' }, 202);
      if (url === '/processing/jobs/job-cancelled') {
        polls += 1;
        return ok(job('job-cancelled', 'cancelled'));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);

    expect(fixture.status.textContent).toBe('Processing cancelled.');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toBe(1);
  });

  it('uses the existing dialog close affordance to cancel a queued job', async () => {
    vi.useFakeTimers();
    let polls = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-queued' }, 202);
      if (url === '/processing/jobs/job-queued') {
        polls += 1;
        return ok(job('job-queued', 'queued'));
      }
      if (url === '/processing/jobs/job-queued/cancel') return ok(job('job-queued', 'cancelled'));
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();

    expect(fixture.status.textContent).toBe('Processing cancelled.');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toBe(1);
  });

  it('retains a queued job when it becomes running before the close cancellation reaches the server', async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-queued-race' }, 202);
      if (url === '/processing/jobs/job-queued-race') return ok(job('job-queued-race', 'queued'));
      if (url === '/processing/jobs/job-queued-race/cancel') return failed(409, 'Processing has already started.');
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/processing/jobs/job-queued-race/cancel', expect.objectContaining({ method: 'POST' }));
    expect(fixture.root.__ccProcessingJob?.id).toBe('job-queued-race');
    expect(fixture.status.textContent).toBe('Processing queued.');
    expect(fixture.errorText.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not request cancellation when closing a job already known to be running', async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-running' }, 202);
      if (url === '/processing/jobs/job-running') return ok(job('job-running', 'running', { progress: { completed: 1, total: 2 } }));
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();

    expect(fetchMock).not.toHaveBeenCalledWith('/processing/jobs/job-running/cancel', expect.anything());
    expect(fixture.root.__ccProcessingJob?.state).toBe('running');
    expect(fixture.status.textContent).toBe('Processing… 1 of 2.');
    expect(fixture.errorText.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a queued job returned after close without starting a hidden poll loop', async () => {
    vi.useFakeTimers();
    const applyResponse = deferred();
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return applyResponse.promise;
      if (url === '/processing/jobs/job-after-close/cancel') return ok(job('job-after-close', 'cancelled'));
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    fixture.dialog.dispatch('close', { target: fixture.dialog });
    applyResponse.resolve(ok({ ok: true, operation: 'archive', jobId: 'job-after-close' }, 202));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/processing/jobs/job-after-close/cancel', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).not.toHaveBeenCalledWith('/processing/jobs/job-after-close', expect.anything());
    expect(fixture.root.__ccProcessingJob).toBeNull();
    expect(fixture.status.textContent).toBe('Processing cancelled.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reopens a pending Apply submission before a late 202 and starts polling without cancellation', async () => {
    vi.useFakeTimers();
    const applyResponse = deferred();
    let polls = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return applyResponse.promise;
      if (url === '/processing/jobs/job-reopened') {
        polls += 1;
        if (polls === 1) return ok(job('job-reopened', 'running', { progress: { completed: 1, total: 2 } }));
        return ok(job('job-reopened', 'succeeded'));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    const submission = fixture.root.__ccProcessingSubmission;
    fixture.dialog.dispatch('close', { target: fixture.dialog });
    expect(submission.closed).toBe(true);

    fixture.trigger.dispatch('click', { target: fixture.trigger });
    await flush();
    expect(fixture.root.__ccProcessingSubmission).toBe(submission);
    expect(submission.closed).toBe(false);

    applyResponse.resolve(ok({ ok: true, operation: 'archive', jobId: 'job-reopened' }, 202));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/apply'))).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalledWith('/processing/jobs/job-reopened/cancel', expect.anything());
    expect(fixture.root.__ccProcessingJob?.id).toBe('job-reopened');
    expect(fixture.root.__ccProcessingJob?.state).toBe('running');
    expect(fixture.status.textContent).toBe('Processing… 1 of 2.');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();

    expect(polls).toBe(2);
    expect(fixture.root.__ccProcessingJob).toBeNull();
    expect(fixture.root.__ccProcessingBusy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a late returned running job after cancellation 409 and resumes its single poll on reopen', async () => {
    vi.useFakeTimers();
    const applyResponse = deferred();
    let cancels = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return applyResponse.promise;
      if (url === '/processing/jobs/job-racing/cancel') {
        cancels += 1;
        return failed(409, 'Processing has already started.');
      }
      if (url === '/processing/jobs/job-racing') {
        return ok(job('job-racing', 'running', { progress: { completed: 1, total: 2 } }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    fixture.dialog.dispatch('close', { target: fixture.dialog });
    applyResponse.resolve(ok({ ok: true, operation: 'archive', jobId: 'job-racing' }, 202));
    await flush();

    expect(cancels).toBe(1);
    expect(fetchMock).not.toHaveBeenCalledWith('/processing/jobs/job-racing', expect.anything());
    expect(fixture.root.__ccProcessingJob?.id).toBe('job-racing');
    expect(vi.getTimerCount()).toBe(0);

    fixture.trigger.dispatch('click', { target: fixture.trigger });
    await flush();
    fixture.applyBtn.dispatch('click', { target: fixture.applyBtn });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fixture.status.textContent).toBe('Processing… 1 of 2.');
    expect(vi.getTimerCount()).toBe(1);

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();
    expect(cancels).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a reopened generation poll while a stale generation request remains unresolved', async () => {
    vi.useFakeTimers();
    const stalePoll = deferred();
    const currentPoll = deferred();
    let polls = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-generation' }, 202);
      if (url === '/processing/jobs/job-generation') {
        polls += 1;
        if (polls === 1) return stalePoll.promise;
        if (polls === 2) return currentPoll.promise;
        return ok(job('job-generation', 'running', { progress: { completed: 1, total: 2 } }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    expect(polls).toBe(1);
    fixture.root.__ccProcessingJob.state = 'running';

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    fixture.trigger.dispatch('click', { target: fixture.trigger });
    await flush();

    expect(polls).toBe(2);
    expect(fixture.root.__ccProcessingJobPolling.generation).toBe(fixture.root.__ccProcessingJobPollGeneration);

    stalePoll.resolve(ok(job('job-generation', 'queued')));
    await flush();

    expect(fixture.root.__ccProcessingJob.state).toBe('running');
    expect(fixture.root.__ccProcessingJobPolling.generation).toBe(fixture.root.__ccProcessingJobPollGeneration);

    currentPoll.resolve(ok(job('job-generation', 'running', { progress: { completed: 1, total: 2 } })));
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(polls).toBe(3);
    expect(vi.getTimerCount()).toBe(1);

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops permanently when an evicted processing job is no longer found', async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-evicted' }, 202);
      if (url === '/processing/jobs/job-evicted') {
        return failed(404, 'Processing job not found.', 'PROCESSING_JOB_NOT_FOUND');
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);

    expect(fixture.root.__ccProcessingJob).toBeNull();
    expect(fixture.root.__ccProcessingBusy).toBe(false);
    expect(fixture.applyBtn.disabled).toBe(false);
    expect(fixture.errorText.textContent).toBe('The processing result is no longer available.');
    expect(fixture.status.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries transient processing job polling errors without releasing Apply', async () => {
    vi.useFakeTimers();
    let polls = 0;
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return ok({ ok: true, operation: 'archive', jobId: 'job-transient' }, 202);
      if (url === '/processing/jobs/job-transient') {
        polls += 1;
        throw new Error('Temporary network failure.');
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);

    expect(fixture.root.__ccProcessingJob?.id).toBe('job-transient');
    expect(fixture.root.__ccProcessingBusy).toBe(true);
    expect(fixture.status.textContent).toBe('Could not check processing status. Retrying…');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(polls).toBe(2);
    expect(fixture.root.__ccProcessingJob?.id).toBe('job-transient');
    expect(fixture.root.__ccProcessingBusy).toBe(true);

    fixture.dialog.dispatch('close', { target: fixture.dialog });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reopens only the active pending submission generation', async () => {
    const fixture = buildDialogRoot(doc, { operation: 'archive' });
    const staleSubmission = { generation: 1, closed: true };
    const activeSubmission = { generation: 2, closed: true };
    fixture.root.__ccProcessingSubmissionGeneration = activeSubmission.generation;
    fixture.root.__ccProcessingSubmission = activeSubmission;

    enhanceProcessingDialogs(doc);
    fixture.trigger.dispatch('click', { target: fixture.trigger });
    await flush();

    expect(activeSubmission.closed).toBe(false);
    expect(staleSubmission.closed).toBe(true);
    expect(fixture.root.__ccProcessingSubmission).toBe(activeSubmission);
  });

  it('ignores a stale late 202 that belongs to an earlier submission generation', async () => {
    const applyResponse = deferred();
    fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/plan')) return ok({ ok: true, plan: { counts: { total: 1, eligible: 1 }, items: [] } });
      if (url.endsWith('/apply')) return applyResponse.promise;
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = buildDialogRoot(doc, { operation: 'archive' });

    await previewAndApply(fixture);
    const newerJob = { id: 'job-newer', state: 'running', progress: null };
    fixture.root.__ccProcessingSubmissionGeneration = 2;
    fixture.root.__ccProcessingSubmission = { generation: 2, closed: false };
    fixture.root.__ccProcessingJob = newerJob;
    applyResponse.resolve(ok({ ok: true, operation: 'archive', jobId: 'job-stale' }, 202));
    await flush();

    expect(fixture.root.__ccProcessingJob).toBe(newerJob);
    expect(fetchMock).not.toHaveBeenCalledWith('/processing/jobs/job-stale/cancel', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('/processing/jobs/job-stale', expect.anything());
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
