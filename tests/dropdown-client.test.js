import { describe, expect, it, vi } from 'vitest';
import { enhanceDropdowns } from '../src/static/creatorcrate.js';

function makeMockElement(tag, document = null) {
  const attrs = {};
  const children = [];
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    ownerDocument: document,
    parentNode: null,
    children,
    textContent: '',
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
      if (name === 'value' && tag === 'input') this.value = String(value);
      if (name === 'type' && tag === 'input') this.type = String(value);
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    appendChild(child) {
      children.push(child);
      if (child) child.parentNode = this;
      return child;
    },
    remove() {
      if (this.parentNode) {
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
      }
    },
    closest(selector) {
      if (selector === '.asset-filter-multiselect-option' && this.getAttribute('class')?.includes('asset-filter-multiselect-option')) return this;
      if (selector === '[data-cc-dropdown]') return null;
      let node = this.parentNode;
      while (node) {
        if (selector === '.asset-filter-multiselect-option' && node.getAttribute?.('class')?.includes('asset-filter-multiselect-option')) return node;
        node = node.parentNode;
      }
      return null;
    },
    querySelector(selector) {
      for (const child of children) {
        const found = child.querySelector?.(selector);
        if (found) return found;
        if (matchesSelector(child, selector)) return child;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      for (const child of children) {
        if (matchesSelector(child, selector)) results.push(child);
        results.push(...(child.querySelectorAll?.(selector) || []));
      }
      return results;
    },
  };
  if (tag === 'input') {
    node.value = '';
    node.checked = false;
    node.type = 'text';
    node.disabled = false;
  }
  return node;
}

function matchesSelector(el, selector) {
  if (selector === 'input[type="radio"]' && el.tagName === 'INPUT' && el.getAttribute('type') === 'radio') return true;
  if (selector === 'input[type="checkbox"]' && el.tagName === 'INPUT' && el.getAttribute('type') === 'checkbox') return true;
  if (selector === '.asset-filter-multiselect-option' && el.getAttribute('class')?.includes('asset-filter-multiselect-option')) return true;
  return false;
}

function makeMockDocument() {
  return {
    createElement(tag) {
      return makeMockElement(tag, this);
    },
    defaultView: { Event },
  };
}

function makeDropdown(mode, options, selectedValues = [], nativeConfig = null) {
  const listeners = [];
  const summaryAttrs = {
    'aria-label': `${mode === 'single' ? 'Format' : 'Tag'} filter: Initial`,
  };
  const currentSummary = { textContent: 'Initial' };
  const summary = {
    focused: false,
    setAttribute(name, value) {
      summaryAttrs[name] = String(value);
    },
    getAttribute(name) {
      return summaryAttrs[name] ?? null;
    },
    removeAttribute(name) {
      delete summaryAttrs[name];
    },
    focus() {
      this.focused = true;
    },
  };
    let nativeOptions = options.map(({ value, label }) => ({
      value,
      label,
      textContent: label ?? value,
      selected: value === (nativeConfig?.value ?? ''),
    }));
    const widthSizerSpans = [];
    const widthSizer = {
      get children() {
        return widthSizerSpans.slice();
      },
      appendChild(child) {
        widthSizerSpans.push(child);
        return child;
      },
      replaceChildren(...children) {
        widthSizerSpans.length = 0;
        children.forEach((child) => widthSizerSpans.push(child));
      },
    };
    const inputs = options.map(({ value, label }, index) => {
      const input = {
        type: mode === 'single' ? 'radio' : 'checkbox',
        name: mode === 'single' ? 'format' : 'tag',
        value,
        checked: selectedValues.includes(value),
        closest(selector) {
          if (selector === 'label') return { textContent: label };
          if (selector === '[data-cc-dropdown]') return dropdown;
          return null;
        },
      };
      input.id = `${mode}-${index}`;
      return input;
    });
  const dropdown = {
    dataset: {
      ccDropdownMode: mode,
      ccDropdownEmptySummary: mode === 'multiple' ? 'All tags' : '',
      ccDropdownCountLabel: mode === 'multiple' ? 'tags' : 'items',
    },
    open: false,
    querySelector(selector) {
      if (selector === 'summary') return summary;
      if (selector === '.asset-filter-multiselect-summary-current') return currentSummary;
      if (selector === '.asset-filter-multiselect-summary-width') return widthSizer;
      if (selector === 'input[type="radio"]:checked') return inputs.find((input) => input.checked) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[type="radio"]' || selector === 'input[type="checkbox"]') return inputs;
      return [];
    },
  };

  summary.closest = (selector) => (selector === '[data-cc-dropdown]' ? dropdown : null);
  let nativeSelect = null;
  if (nativeConfig) {
    nativeSelect = {
      value: nativeConfig.value,
      hidden: false,
      disabled: Boolean(nativeConfig.disabled),
      options: nativeOptions,
      setAttribute(name) {
        if (name === 'hidden') this.hidden = true;
        if (name === 'disabled') this.disabled = true;
      },
      removeAttribute(name) {
        if (name === 'hidden') this.hidden = false;
        if (name === 'disabled') this.disabled = false;
      },
      hasAttribute(name) {
        return name === 'disabled' && this.disabled;
      },
      dispatchEvent: vi.fn(),
    };
    const field = {
      querySelector(selector) {
        if (selector === '[data-cc-dropdown-native-select]') return nativeSelect;
        if (selector === '[data-cc-dropdown]') return dropdown;
        return null;
      },
    };
    dropdown.parentElement = field;
    dropdown.parentNode = field;
    nativeSelect.parentElement = field;
    nativeSelect.parentNode = field;
    nativeSelect.closest = (selector) => (selector === '[data-cc-dropdown]' ? dropdown : null);
    if (nativeConfig.dispatchNativeChange) dropdown.dataset.ccDropdownDispatchNativeChange = '';
  }

  const scope = {
    dataset: {},
    querySelectorAll(selector) {
      return selector === '[data-cc-dropdown]' ? [dropdown] : [];
    },
    addEventListener(type, handler, optionsArg) {
      listeners.push({ type, handler, options: optionsArg });
    },
    dispatch(type, target, props = {}) {
      const event = {
        type,
        target,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...props,
      };
      listeners.filter((listener) => listener.type === type)
        .forEach((listener) => listener.handler(event));
      return event;
    },
  };

  return {
    scope, dropdown, inputs, summary, summaryAttrs, currentSummary, listeners, nativeSelect, widthSizer,
  };
}

function makeSearchableDropdown(options, selectedValues = []) {
  const fixture = makeDropdown('single', options, selectedValues);
  const { dropdown, inputs } = fixture;
  dropdown.dataset.ccDropdownSearchable = '';

  const rows = inputs.map((input) => {
    const row = {
      hidden: false,
      querySelector(selector) {
        return selector === 'input[type="radio"]' ? input : null;
      },
      setAttribute(name) {
        if (name === 'hidden') this.hidden = true;
      },
      removeAttribute(name) {
        if (name === 'hidden') this.hidden = false;
      },
    };
    return row;
  });
  const optionList = {
    querySelectorAll(selector) {
      return selector === '.asset-filter-multiselect-option' ? rows : [];
    },
  };
  const search = {
    value: '',
    closest(selector) {
      return selector === '[data-cc-dropdown]' ? dropdown : null;
    },
    setAttribute() {},
    removeAttribute() {},
  };
  const noResults = {
    hidden: true,
    setAttribute(name) {
      if (name === 'hidden') this.hidden = true;
    },
    removeAttribute(name) {
      if (name === 'hidden') this.hidden = false;
    },
  };
  const querySelector = dropdown.querySelector.bind(dropdown);
  dropdown.querySelector = (selector) => {
    if (selector === '[data-cc-dropdown-search]') return search;
    if (selector === '[data-cc-dropdown-option-list]') return optionList;
    if (selector === '[data-cc-dropdown-no-results]') return noResults;
    return querySelector(selector);
  };

  return { ...fixture, rows, optionList, search, noResults };
}

function wireNativeSyncFixture(fixture) {
  const document = makeMockDocument();
  const panel = makeMockElement('div', document);
  const field = {
    querySelector(selector) {
      if (selector === '[data-cc-dropdown-native-select]') return fixture.nativeSelect;
      if (selector === '[data-cc-dropdown]') return fixture.dropdown;
      return null;
    },
  };
  const originalQuerySelector = fixture.dropdown.querySelector.bind(fixture.dropdown);
  fixture.dropdown.ownerDocument = document;
  fixture.dropdown.querySelector = (selector) => {
    if (selector === '[data-cc-dropdown-option-list]' || selector === '.asset-filter-multiselect-panel') return panel;
    if (selector === 'input[type="radio"]:checked') return panel.querySelectorAll('input[type="radio"]').find((input) => input.checked) || null;
    return originalQuerySelector(selector);
  };
  fixture.dropdown.querySelectorAll = (selector) => panel.querySelectorAll(selector);
  fixture.dropdown.parentElement = field;
  fixture.dropdown.parentNode = field;
  return { document, panel };
}

describe('generic dropdown enhancement', () => {
  it('updates a single summary, closes after selection, and synchronizes aria-expanded', () => {
    const fixture = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
      { value: 'kra', label: 'Krita' },
    ], ['png']);
    const [png, kra] = fixture.inputs;

    expect(enhanceDropdowns(fixture.scope)).toBe(1);
    fixture.dropdown.open = true;
    fixture.scope.dispatch('toggle', fixture.dropdown);
    expect(fixture.summaryAttrs['aria-expanded']).toBe('true');

    png.checked = false;
    kra.checked = true;
    fixture.scope.dispatch('change', kra);

    expect(fixture.currentSummary.textContent).toBe('Krita');
    expect(fixture.summaryAttrs['aria-label']).toBe('Format filter: Krita');
    expect(fixture.summaryAttrs.title).toBe('Krita');
    expect(fixture.dropdown.open).toBe(false);
    expect(fixture.summaryAttrs['aria-expanded']).toBe('false');
    expect(fixture.summary.focused).toBe(true);
  });

  it('updates multi summaries while keeping the menu open', () => {
    const fixture = makeDropdown('multiple', [
      { value: 'alpha', label: 'Alpha' },
      { value: 'beta', label: 'Beta' },
      { value: 'gamma', label: 'Gamma' },
    ]);
    const [alpha, beta] = fixture.inputs;

    enhanceDropdowns(fixture.scope);
    fixture.dropdown.open = true;
    fixture.scope.dispatch('toggle', fixture.dropdown);
    alpha.checked = true;
    fixture.scope.dispatch('change', alpha);
    expect(fixture.currentSummary.textContent).toBe('Alpha');
    expect(fixture.dropdown.open).toBe(true);

    beta.checked = true;
    fixture.scope.dispatch('change', beta);
    expect(fixture.currentSummary.textContent).toBe('2 tags selected');
    expect(fixture.summaryAttrs['aria-label']).toBe('Tag filter: 2 tags selected');

    alpha.checked = false;
    beta.checked = false;
    fixture.scope.dispatch('change', beta);
    expect(fixture.currentSummary.textContent).toBe('All tags');
  });

  it('closes on outside click and Escape, returns focus to the trigger, and binds once', () => {
    const fixture = makeDropdown('multiple', [{ value: 'alpha', label: 'Alpha' }]);
    const outside = { closest() { return null; } };

    expect(enhanceDropdowns(fixture.scope)).toBe(1);
    expect(enhanceDropdowns(fixture.scope)).toBe(1);
    expect(fixture.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(fixture.listeners.filter(({ type }) => type === 'keydown')).toHaveLength(1);
    expect(fixture.listeners.filter(({ type }) => type === 'toggle')).toHaveLength(1);

    fixture.dropdown.open = true;
    fixture.scope.dispatch('click', outside);
    expect(fixture.dropdown.open).toBe(false);
    expect(fixture.summaryAttrs['aria-expanded']).toBe('false');

    fixture.dropdown.open = true;
    const escape = fixture.scope.dispatch('keydown', fixture.inputs[0], { key: 'Escape' });
    expect(escape.defaultPrevented).toBe(true);
    expect(fixture.dropdown.open).toBe(false);
    expect(fixture.summary.focused).toBe(true);
  });

  it('re-enhances a replaced live-region dropdown without duplicate listeners', () => {
    const initial = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
      { value: 'kra', label: 'Krita' },
    ], ['png']);
    const replacement = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
      { value: 'kra', label: 'Krita' },
    ], ['kra']);

    expect(enhanceDropdowns(initial.scope)).toBe(1);
    expect(enhanceDropdowns(replacement.scope)).toBe(1);
    expect(enhanceDropdowns(replacement.scope)).toBe(1);
    expect(replacement.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    replacement.inputs[0].checked = true;
    replacement.inputs[1].checked = false;
    replacement.scope.dispatch('change', replacement.inputs[0]);
    expect(replacement.currentSummary.textContent).toBe('PNG');
    expect(replacement.dropdown.open).toBe(false);
  });

  it('filters searchable options case-insensitively, keeps the empty placeholder visible, and toggles no-results', () => {
    const fixture = makeSearchableDropdown([
      { value: '', label: 'All projects' },
      { value: '1', label: 'Alpha Project' },
      { value: '2', label: 'Beta Project' },
    ], ['']);

    enhanceDropdowns(fixture.scope);
    fixture.search.value = 'ALP';
    fixture.scope.dispatch('input', fixture.search);
    expect(fixture.rows.map((row) => row.hidden)).toEqual([false, false, true]);
    expect(fixture.noResults.hidden).toBe(true);

    fixture.search.value = 'missing';
    fixture.scope.dispatch('input', fixture.search);
    expect(fixture.rows.map((row) => row.hidden)).toEqual([false, true, true]);
    expect(fixture.noResults.hidden).toBe(false);

    fixture.search.value = '';
    fixture.scope.dispatch('input', fixture.search);
    expect(fixture.rows.map((row) => row.hidden)).toEqual([false, false, false]);
    expect(fixture.noResults.hidden).toBe(true);
  });

  it('keeps a checked option canonical while filtered and closes/focuses after searchable selection', () => {
    const fixture = makeSearchableDropdown([
      { value: '', label: 'All projects' },
      { value: '1', label: 'Alpha Project' },
      { value: '2', label: 'Beta Project' },
    ], ['1']);
    const [empty, alpha, beta] = fixture.inputs;

    enhanceDropdowns(fixture.scope);
    expect(fixture.currentSummary.textContent).toBe('Alpha Project');
    fixture.search.value = 'beta';
    fixture.scope.dispatch('input', fixture.search);
    expect(alpha.checked).toBe(true);
    expect(fixture.rows[1].hidden).toBe(true);

    fixture.dropdown.open = true;
    empty.checked = false;
    alpha.checked = false;
    beta.checked = true;
    fixture.scope.dispatch('change', beta);
    expect(fixture.currentSummary.textContent).toBe('Beta Project');
    expect(fixture.dropdown.open).toBe(false);
    expect(fixture.summary.focused).toBe(true);
  });

  it('prevents Enter only in the searchable field, closes Escape, and closes on outside click', () => {
    const fixture = makeSearchableDropdown([{ value: '1', label: 'Alpha Project' }], ['1']);
    const outside = { closest() { return null; } };

    enhanceDropdowns(fixture.scope);
    fixture.dropdown.open = true;
    const enter = fixture.scope.dispatch('keydown', fixture.search, { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(true);
    expect(fixture.dropdown.open).toBe(true);

    const composingEnter = fixture.scope.dispatch('keydown', fixture.search, {
      key: 'Enter',
      isComposing: true,
    });
    expect(composingEnter.defaultPrevented).toBe(false);

    const escape = fixture.scope.dispatch('keydown', fixture.search, { key: 'Escape' });
    expect(escape.defaultPrevented).toBe(true);
    expect(fixture.dropdown.open).toBe(false);
    expect(fixture.summary.focused).toBe(true);

    fixture.dropdown.open = true;
    fixture.scope.dispatch('click', outside);
    expect(fixture.dropdown.open).toBe(false);

    const standard = makeDropdown('single', [{ value: '1', label: 'Alpha' }], ['1']);
    enhanceDropdowns(standard.scope);
    const standardEnter = standard.scope.dispatch('keydown', standard.inputs[0], { key: 'Enter' });
    expect(standardEnter.defaultPrevented).toBe(false);
  });

  it('keeps delegated searchable enhancement idempotent and initializes replacement markup', () => {
    const initial = makeSearchableDropdown([
      { value: '1', label: 'Alpha Project' },
      { value: '2', label: 'Beta Project' },
    ], ['1']);
    const replacement = makeSearchableDropdown([
      { value: '1', label: 'Alpha Project' },
      { value: '2', label: 'Beta Project' },
    ], ['2']);
    let current = initial.dropdown;
    const querySelectorAll = initial.scope.querySelectorAll;
    initial.scope.querySelectorAll = (selector) => (
      selector === '[data-cc-dropdown]' ? [current] : querySelectorAll(selector)
    );

    expect(enhanceDropdowns(initial.scope)).toBe(1);
    expect(enhanceDropdowns(initial.scope)).toBe(1);
    expect(initial.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);

    current = replacement.dropdown;
    expect(enhanceDropdowns(initial.scope)).toBe(1);
    expect(replacement.currentSummary.textContent).toBe('Beta Project');
    replacement.search.value = 'alpha';
    initial.scope.dispatch('input', replacement.search);
    expect(replacement.rows.map((row) => row.hidden)).toEqual([false, true]);
  });

  it('synchronizes an optional native select with the enhanced single-select shell', () => {
    const fixture = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
      { value: 'kra', label: 'Krita' },
    ]);
    const nativeSelect = {
      value: 'kra',
      hidden: false,
      options: [
        { value: 'png', selected: false },
        { value: 'kra', selected: true },
      ],
    };
    const field = {
      querySelector(selector) {
        return selector === '[data-cc-dropdown-native-select]' ? nativeSelect : null;
      },
    };
    fixture.dropdown.parentElement = field;
    fixture.dropdown.parentNode = field;

    enhanceDropdowns(fixture.scope);
    expect(nativeSelect.hidden).toBe(true);
    expect(fixture.inputs[0].checked).toBe(false);
    expect(fixture.inputs[1].checked).toBe(true);
    expect(fixture.currentSummary.textContent).toBe('Krita');

    fixture.inputs[0].checked = true;
    fixture.inputs[1].checked = false;
    fixture.scope.dispatch('change', fixture.inputs[0]);
    expect(nativeSelect.value).toBe('png');
  });

  it('keeps native-backed radios grouped and dispatches the canonical native change when configured', () => {
    const fixture = makeDropdown('single', [
      { value: '2000', label: '2 s' },
      { value: '4000', label: '4 s' },
      { value: '6000', label: '6 s' },
    ], [], { value: '4000', dispatchNativeChange: true });

    enhanceDropdowns(fixture.scope);
    expect(fixture.nativeSelect.hidden).toBe(true);
    expect(fixture.inputs.map((input) => input.checked)).toEqual([false, true, false]);

    fixture.inputs[0].checked = true;
    fixture.scope.dispatch('change', fixture.inputs[0]);

    expect(fixture.inputs.map((input) => input.checked)).toEqual([true, false, false]);
    expect(fixture.nativeSelect.value).toBe('2000');
    expect(fixture.nativeSelect.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('propagates disabled state to the enhanced control and prevents opening it', () => {
    const fixture = makeDropdown('single', [
      { value: '2000', label: '2 s' },
      { value: '4000', label: '4 s' },
    ], [], { value: '4000', disabled: true });

    enhanceDropdowns(fixture.scope);
    expect(fixture.inputs.every((input) => input.disabled)).toBe(true);
    expect(fixture.summary.disabled).toBe(true);
    expect(fixture.summaryAttrs['aria-disabled']).toBe('true');

    fixture.dropdown.open = true;
    const click = fixture.scope.dispatch('click', fixture.summary);
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.dropdown.open).toBe(false);

    fixture.nativeSelect.disabled = false;
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.inputs.every((input) => !input.disabled)).toBe(true);
    expect(fixture.summary.disabled).toBe(false);
    expect(fixture.summaryAttrs['aria-disabled']).toBeUndefined();
  });

  it('resyncs enhanced options from a mutated native select and preserves selected value', () => {
    const fixture = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
    ], [], { value: 'png', dispatchNativeChange: true });
    const document = makeMockDocument();
    const panel = makeMockElement('div', document);
    const field = {
      querySelector(selector) {
        if (selector === '[data-cc-dropdown-native-select]') return fixture.nativeSelect;
        if (selector === '[data-cc-dropdown]') return fixture.dropdown;
        return null;
      },
    };
    const originalQuerySelector = fixture.dropdown.querySelector.bind(fixture.dropdown);
    fixture.dropdown.ownerDocument = document;
    fixture.dropdown.querySelector = (selector) => {
      if (selector === '[data-cc-dropdown-option-list]' || selector === '.asset-filter-multiselect-panel') return panel;
      if (selector === 'input[type="radio"]:checked') return panel.querySelectorAll('input[type="radio"]').find((input) => input.checked) || null;
      return originalQuerySelector(selector);
    };
    fixture.dropdown.querySelectorAll = (selector) => panel.querySelectorAll(selector);
    fixture.dropdown.parentElement = field;
    fixture.dropdown.parentNode = field;

    const getInputs = () => Array.from(fixture.dropdown.querySelectorAll('input[type="radio"]'));

    enhanceDropdowns(fixture.scope);
    let inputs = getInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].checked).toBe(true);

    fixture.nativeSelect.options.push({ value: 'kra', selected: false });
    fixture.nativeSelect.value = 'kra';
    fixture.scope.dispatch('change', fixture.nativeSelect);

    inputs = getInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].checked).toBe(false);
    expect(inputs[1].checked).toBe(true);
    expect(fixture.currentSummary.textContent).toBe('kra');
  });

  it('removes stale enhanced options when native select options are deleted', () => {
    const fixture = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
      { value: 'kra', label: 'Krita' },
    ], [], { value: 'png', dispatchNativeChange: true });
    const document = makeMockDocument();
    const panel = makeMockElement('div', document);
    const field = {
      querySelector(selector) {
        if (selector === '[data-cc-dropdown-native-select]') return fixture.nativeSelect;
        if (selector === '[data-cc-dropdown]') return fixture.dropdown;
        return null;
      },
    };
    const originalQuerySelector = fixture.dropdown.querySelector.bind(fixture.dropdown);
    fixture.dropdown.ownerDocument = document;
    fixture.dropdown.querySelector = (selector) => {
      if (selector === '[data-cc-dropdown-option-list]' || selector === '.asset-filter-multiselect-panel') return panel;
      if (selector === 'input[type="radio"]:checked') return panel.querySelectorAll('input[type="radio"]').find((input) => input.checked) || null;
      return originalQuerySelector(selector);
    };
    fixture.dropdown.querySelectorAll = (selector) => panel.querySelectorAll(selector);
    fixture.dropdown.parentElement = field;
    fixture.dropdown.parentNode = field;

    const getInputs = () => Array.from(fixture.dropdown.querySelectorAll('input[type="radio"]'));

    enhanceDropdowns(fixture.scope);
    expect(getInputs()).toHaveLength(2);

    fixture.nativeSelect.options.pop();
    fixture.scope.dispatch('change', fixture.nativeSelect);

    expect(getInputs()).toHaveLength(1);
  });

  it('preserves dialog body scroll position when a dropdown is opened and closed in a scrollable dialog', () => {
    const fixture = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
      { value: 'kra', label: 'Krita' },
    ], [], { value: 'png', dispatchNativeChange: true });
    const dialogBody = {
      nodeType: 1,
      tagName: 'DIV',
      className: 'app-dialog-body processing-dialog-body',
      scrollTop: 250,
      scrollLeft: 0,
      dataset: {},
      classList: {
        contains(name) { return dialogBody.className.includes(name); },
        add() {},
        remove() {},
        toggle() { return false; },
      },
      contains() { return true; },
      getAttribute() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest(selector) {
        if (selector === '.app-dialog-body') return dialogBody;
        if (selector === '[data-app-dialog]') return { querySelector: () => null };
        return null;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const panel = {
      nodeType: 1,
      getBoundingClientRect() { return { width: 300, height: 80 }; },
      style: {},
      removeAttribute() {},
      setAttribute() {},
    };
    const summary = {
      nodeType: 1,
      getBoundingClientRect() { return { left: 10, top: 300, bottom: 330, right: 130, width: 120 }; },
      setAttribute() {},
      focus: () => {},
    };
    fixture.dropdown.className = 'asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown';
    fixture.dropdown.closest = (selector) => {
      if (selector === '.app-dialog-body') return dialogBody;
      if (selector === '[data-app-dialog]') return { querySelector: () => null };
      return null;
    };
    fixture.dropdown.querySelector = (selector) => {
      if (selector === '.asset-filter-multiselect-panel') return panel;
      if (selector === 'summary') return summary;
      return null;
    };
    fixture.dropdown.parentElement = {
      querySelector(selector) {
        if (selector === '[data-cc-dropdown-native-select]') return fixture.nativeSelect;
        if (selector === '[data-cc-dropdown]') return fixture.dropdown;
        return null;
      },
    };
    fixture.dropdown.parentNode = fixture.dropdown.parentElement;
    fixture.dropdown.ownerDocument = {
      defaultView: {
        innerWidth: 640,
        innerHeight: 480,
        addEventListener() {},
        removeEventListener() {},
        getComputedStyle() { return { maxWidth: '200px' }; },
      },
    };

    enhanceDropdowns(fixture.scope);
    fixture.dropdown.open = true;
    fixture.scope.dispatch('toggle', fixture.dropdown);
    expect(dialogBody.scrollTop).toBe(250);
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.width).toBe('200px');
    expect(panel.style.minWidth).toBe('0px');
    expect(panel.style.right).toBeUndefined();

    fixture.dropdown.open = false;
    fixture.scope.dispatch('toggle', fixture.dropdown);
    expect(dialogBody.scrollTop).toBe(250);
    expect(panel.style.minWidth).toBeUndefined();
  });
});

describe('async dropdown intrinsic-width sizer synchronization', () => {
  it('mirrors a single-placeholder native select into the width sizer on initial sync', () => {
    const fixture = makeDropdown('single', [
      { value: 'custom', label: 'Custom' },
    ], [], { value: 'custom', dispatchNativeChange: true });
    wireNativeSyncFixture(fixture);

    enhanceDropdowns(fixture.scope);

    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual(['Custom']);
  });

  it('adds, renames, and removes sizer spans in step with the native select, without duplicating on repeated syncs', () => {
    const fixture = makeDropdown('single', [
      { value: 'custom', label: 'Custom' },
    ], [], { value: 'custom', dispatchNativeChange: true });
    wireNativeSyncFixture(fixture);

    enhanceDropdowns(fixture.scope);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual(['Custom']);

    fixture.nativeSelect.options.push(
      { value: 'preset-a', textContent: 'A' },
      { value: 'preset-long', textContent: 'A Really Long Preset Name' },
    );
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual([
      'Custom', 'A', 'A Really Long Preset Name',
    ]);

    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children).toHaveLength(3);

    fixture.nativeSelect.options[1].textContent = 'Preset A Renamed';
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual([
      'Custom', 'Preset A Renamed', 'A Really Long Preset Name',
    ]);

    fixture.nativeSelect.options.splice(1, 1);
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual([
      'Custom', 'A Really Long Preset Name',
    ]);
  });

  it('leaves a valid, empty sizer when the native select ends up with no options', () => {
    const fixture = makeDropdown('single', [
      { value: 'custom', label: 'Custom' },
    ], [], { value: 'custom', dispatchNativeChange: true });
    wireNativeSyncFixture(fixture);

    enhanceDropdowns(fixture.scope);
    fixture.nativeSelect.options.length = 0;
    fixture.scope.dispatch('change', fixture.nativeSelect);

    expect(fixture.widthSizer.children).toEqual([]);
  });

  it('assigns option text via textContent, preserving it literally rather than parsing it as markup', () => {
    const fixture = makeDropdown('single', [
      { value: 'custom', label: 'Custom' },
    ], [], { value: 'custom', dispatchNativeChange: true });
    wireNativeSyncFixture(fixture);

    enhanceDropdowns(fixture.scope);
    fixture.nativeSelect.options.push({ value: 'unsafe', textContent: '<img src=x onerror=alert(1)>' });
    fixture.scope.dispatch('change', fixture.nativeSelect);

    expect(fixture.widthSizer.children[1].textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('rebuilds the sizer the same way for searchable dropdowns as non-searchable ones', () => {
    const fixture = makeDropdown('single', [
      { value: 'custom', label: 'Custom' },
    ], [], { value: 'custom', dispatchNativeChange: true });
    fixture.dropdown.dataset.ccDropdownSearchable = '';
    wireNativeSyncFixture(fixture);

    enhanceDropdowns(fixture.scope);
    fixture.nativeSelect.options.push({ value: 'preset-a', textContent: 'Preset A' });
    fixture.scope.dispatch('change', fixture.nativeSelect);

    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual(['Custom', 'Preset A']);
  });

  it('keeps selected value, visible summary, and disabled-state synchronization correct while the sizer resyncs', () => {
    const fixture = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
    ], [], { value: 'png', dispatchNativeChange: true });
    wireNativeSyncFixture(fixture);

    enhanceDropdowns(fixture.scope);
    fixture.nativeSelect.options.push({ value: 'kra', textContent: 'Krita' });
    fixture.nativeSelect.value = 'kra';
    fixture.scope.dispatch('change', fixture.nativeSelect);

    expect(fixture.currentSummary.textContent).toBe('kra');
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual(['PNG', 'Krita']);

    fixture.nativeSelect.disabled = true;
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.summary.disabled).toBe(true);

    fixture.nativeSelect.disabled = false;
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.summary.disabled).toBe(false);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual(['PNG', 'Krita']);
  });
});
