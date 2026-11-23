import { describe, expect, it, vi } from 'vitest';
import { enhanceDropdowns } from '../src/static/creatorcrate.js';
import { updateAssetViewerFilterDisclosureState } from '../src/static/client/dropdowns.js';

function makeMockElement(tag, document = null) {
  const attrs = {};
  const children = [];
  const node = {
    tagName: String(tag).toUpperCase(),
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
    addEventListener(type, handler) {
      listeners.push({ type, handler });
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
    scope, dropdown, inputs, summary, summaryAttrs, currentSummary, nativeSelect, widthSizer,
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
  return {
    getInputs: () => Array.from(fixture.dropdown.querySelectorAll('input[type="radio"]')),
  };
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

  it('closes on outside click and Escape and returns focus to the trigger', () => {
    const fixture = makeDropdown('multiple', [{ value: 'alpha', label: 'Alpha' }]);
    const outside = { closest() { return null; } };

    expect(enhanceDropdowns(fixture.scope)).toBe(1);

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

  it('keeps only the newly opened dropdown open and ignores clicks inside it', () => {
    const first = makeDropdown('single', [{ value: 'png', label: 'PNG' }], ['png']);
    const second = makeDropdown('single', [{ value: 'kra', label: 'Krita' }], ['kra']);
    first.scope.querySelectorAll = (selector) => (
      selector === '[data-cc-dropdown]' ? [first.dropdown, second.dropdown] : []
    );

    enhanceDropdowns(first.scope);
    first.dropdown.open = true;
    second.dropdown.open = true;
    first.scope.dispatch('toggle', second.dropdown);

    expect(first.dropdown.open).toBe(false);
    expect(second.dropdown.open).toBe(true);

    first.scope.dispatch('click', second.inputs[0]);
    expect(second.dropdown.open).toBe(true);
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

  it('prevents non-composing Enter only in the searchable field', () => {
    const fixture = makeSearchableDropdown([{ value: '1', label: 'Alpha Project' }], ['1']);

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

  it('synchronizes native-backed multiple selections exactly once after repeated enhancement', () => {
    const fixture = makeDropdown('multiple', [
      { value: 'alpha', label: 'Alpha' },
      { value: 'beta', label: 'Beta' },
      { value: 'gamma', label: 'Gamma' },
    ], [], { value: '', dispatchNativeChange: true });
    fixture.nativeSelect.multiple = true;
    fixture.nativeSelect.options.forEach((option) => {
      option.selected = option.value === 'alpha' || option.value === 'gamma';
    });
    const checkedValues = () => new Set(
      fixture.inputs.filter((input) => input.checked).map((input) => input.value),
    );
    const nativeValues = () => new Set(
      fixture.nativeSelect.options.filter((option) => option.selected).map((option) => option.value),
    );

    enhanceDropdowns(fixture.scope);
    enhanceDropdowns(fixture.scope);

    expect(checkedValues()).toEqual(new Set(['alpha', 'gamma']));

    fixture.inputs[0].checked = false;
    fixture.inputs[1].checked = true;
    fixture.scope.dispatch('change', fixture.inputs[1]);

    expect(nativeValues()).toEqual(new Set(['beta', 'gamma']));
    expect(fixture.nativeSelect.dispatchEvent).toHaveBeenCalledTimes(1);

    let nativeResyncWrites = 0;
    fixture.inputs.forEach((input) => {
      let checked = input.checked;
      Object.defineProperty(input, 'checked', {
        configurable: true,
        get: () => checked,
        set(value) {
          nativeResyncWrites += 1;
          checked = value;
        },
      });
    });
    fixture.nativeSelect.options.forEach((option) => {
      option.selected = option.value === 'alpha' || option.value === 'beta';
    });
    fixture.scope.dispatch('change', fixture.nativeSelect);

    expect(checkedValues()).toEqual(new Set(['alpha', 'beta']));
    expect(nativeResyncWrites).toBe(3);
  });

  it('keeps native-backed radios grouped and dispatches the canonical native change when configured', () => {
    const fixture = makeDropdown('single', [
      { value: '2000', label: '2 s' },
      { value: '4000', label: '4 s' },
      { value: '6000', label: '6 s' },
    ], [], { value: '4000', dispatchNativeChange: true });

    enhanceDropdowns(fixture.scope);
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
    expect(fixture.summary.tabIndex).toBe(-1);
    expect(fixture.summaryAttrs['aria-disabled']).toBe('true');

    fixture.dropdown.open = true;
    const click = fixture.scope.dispatch('click', fixture.summary);
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.dropdown.open).toBe(false);
    fixture.dropdown.open = true;
    fixture.scope.dispatch('toggle', fixture.dropdown);
    expect(fixture.dropdown.open).toBe(false);

    fixture.nativeSelect.disabled = false;
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.inputs.every((input) => !input.disabled)).toBe(true);
    expect(fixture.summary.disabled).toBe(false);
    expect(fixture.summary.tabIndex).toBe(0);
    expect(fixture.summaryAttrs['aria-disabled']).toBeUndefined();
  });

  it('adds and removes enhanced options when the native select changes', () => {
    const fixture = makeDropdown('single', [
      { value: 'png', label: 'PNG' },
    ], [], { value: 'png', dispatchNativeChange: true });
    const { getInputs } = wireNativeSyncFixture(fixture);

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
  it('keeps literal native option labels mirrored exactly across repeated rebuilds', () => {
    const fixture = makeDropdown('single', [
      { value: 'custom', label: 'Custom' },
    ], [], { value: 'custom', dispatchNativeChange: true });
    wireNativeSyncFixture(fixture);

    enhanceDropdowns(fixture.scope);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual(['Custom']);

    fixture.nativeSelect.options.push(
      { value: 'preset-a', textContent: 'A' },
      { value: 'unsafe', textContent: '<img src=x onerror=alert(1)>' },
    );
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual([
      'Custom', 'A', '<img src=x onerror=alert(1)>',
    ]);

    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children).toHaveLength(3);

    fixture.nativeSelect.options[1].textContent = 'Preset A Renamed';
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual([
      'Custom', 'Preset A Renamed', '<img src=x onerror=alert(1)>',
    ]);

    fixture.nativeSelect.options.splice(1, 1);
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children.map((span) => span.textContent)).toEqual([
      'Custom', '<img src=x onerror=alert(1)>',
    ]);

    fixture.nativeSelect.options.length = 0;
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(fixture.widthSizer.children).toEqual([]);
  });
});

describe('viewport disclosure right-edge clamp', () => {
  function viewportDisclosure({ triggerLeft, clientWidth, innerWidth }) {
    const panel = {
      style: {},
      getBoundingClientRect() { return { width: 240, height: 120 }; },
      setAttribute() {},
      removeAttribute() {},
    };
    const summary = {
      getBoundingClientRect() { return { left: triggerLeft, top: 100, bottom: 130, right: triggerLeft + 120, width: 120 }; },
      setAttribute() {},
    };
    return {
      panel,
      disclosure: {
        open: true,
        isConnected: true,
        hasAttribute: (name) => name === 'data-cc-viewport-disclosure',
        querySelector: (selector) => (selector === 'summary' ? summary : panel),
        ownerDocument: {
          documentElement: { clientWidth, scrollTop: 0 },
          defaultView: {
            innerWidth,
            innerHeight: 640,
            addEventListener() {},
            removeEventListener() {},
            getComputedStyle() { return { maxWidth: 'none' }; },
          },
        },
      },
    };
  }

  it('keeps the panel inside the usable width when a classic scrollbar reserves a gutter', () => {
    const { disclosure, panel } = viewportDisclosure({ triggerLeft: 60, clientWidth: 305, innerWidth: 320 });
    updateAssetViewerFilterDisclosureState(disclosure);
    expect(panel.style.left).toBe('57px');
  });

  it('does not shift a panel that already fits', () => {
    const { disclosure, panel } = viewportDisclosure({ triggerLeft: 20, clientWidth: 305, innerWidth: 320 });
    updateAssetViewerFilterDisclosureState(disclosure);
    expect(panel.style.left).toBe('20px');
  });
});

describe('opt-in Select all filter dropdowns (Filters & Defaults M2 WP5)', () => {
  const EXTENSIONS = [
    { value: 'all', label: 'All extensions' },
    { value: 'jpg', label: '.jpg' },
    { value: 'png', label: '.png' },
    { value: 'webp', label: '.webp' },
  ];

  function markSelectAll(input) {
    input.hasAttribute = (name) => name === 'data-cc-dropdown-select-all';
    return input;
  }

  // Native-backed control: the native catalogue has the neutral 'all' value,
  // rendered as the leading Select all row (the defaults catalogues' shape).
  function selectAllFixture(nativeSelected = [], { emptySummary = 'All extensions' } = {}) {
    const fixture = makeDropdown('multiple', EXTENSIONS, [], { value: '', dispatchNativeChange: true });
    fixture.nativeSelect.multiple = true;
    fixture.nativeSelect.options.forEach((option) => {
      option.selected = nativeSelected.includes(option.value);
    });
    fixture.dropdown.dataset.ccDropdownSelectAll = 'all';
    fixture.dropdown.dataset.ccDropdownEmptySummary = emptySummary;
    fixture.dropdown.dataset.ccDropdownCountLabel = 'extensions';
    markSelectAll(fixture.inputs[0]);
    const [selectAll, jpg, png, webp] = fixture.inputs;
    const nativeValues = () => fixture.nativeSelect.options
      .filter((option) => option.selected).map((option) => option.value);
    const checkedValues = () => fixture.inputs.filter((input) => input.checked).map((input) => input.value);
    return { ...fixture, selectAll, jpg, png, webp, nativeValues, checkedValues };
  }

  it('Select all clears individual values and a value leaves All, keeping rows, native values and summary in step', () => {
    const fixture = selectAllFixture(['jpg', 'png']);
    enhanceDropdowns(fixture.scope);
    expect(fixture.checkedValues()).toEqual(['jpg', 'png']);
    expect(fixture.currentSummary.textContent).toBe('2 extensions selected');

    fixture.selectAll.checked = true;
    fixture.scope.dispatch('change', fixture.selectAll);
    expect(fixture.checkedValues()).toEqual(['all']);
    expect(fixture.nativeValues()).toEqual(['all']);
    expect(fixture.currentSummary.textContent).toBe('All extensions');
    expect(fixture.summaryAttrs['aria-label']).toBe('Tag filter: All extensions');
    expect(fixture.nativeSelect.dispatchEvent).toHaveBeenCalledTimes(1);

    fixture.jpg.checked = true;
    fixture.scope.dispatch('change', fixture.jpg);
    expect(fixture.checkedValues()).toEqual(['jpg']);
    expect(fixture.nativeValues()).toEqual(['jpg']);
    expect(fixture.currentSummary.textContent).toBe('.jpg');
    expect(fixture.nativeSelect.dispatchEvent).toHaveBeenCalledTimes(2);

    // Clearing the last explicit value returns to the unrestricted state.
    fixture.jpg.checked = false;
    fixture.scope.dispatch('change', fixture.jpg);
    expect(fixture.checkedValues()).toEqual(['all']);
    expect(fixture.nativeValues()).toEqual(['all']);
    expect(fixture.currentSummary.textContent).toBe('All extensions');
    expect(fixture.nativeSelect.dispatchEvent).toHaveBeenCalledTimes(3);
  });

  it('shows the unrestricted state on load and after reopening, and an explicit full set stays explicit', () => {
    const unrestricted = selectAllFixture([]);
    enhanceDropdowns(unrestricted.scope);
    expect(unrestricted.checkedValues()).toEqual(['all']);
    expect(unrestricted.currentSummary.textContent).toBe('All extensions');
    unrestricted.dropdown.open = true;
    unrestricted.scope.dispatch('toggle', unrestricted.dropdown);
    unrestricted.dropdown.open = false;
    unrestricted.scope.dispatch('toggle', unrestricted.dropdown);
    unrestricted.dropdown.open = true;
    unrestricted.scope.dispatch('toggle', unrestricted.dropdown);
    expect(unrestricted.checkedValues()).toEqual(['all']);

    const everyValue = selectAllFixture(['jpg', 'png', 'webp']);
    enhanceDropdowns(everyValue.scope);
    expect(everyValue.checkedValues()).toEqual(['jpg', 'png', 'webp']);
    expect(everyValue.currentSummary.textContent).toBe('3 extensions selected');
  });

  it('cancels keyboard or pointer activation of a checked Select all without a change event', () => {
    const fixture = selectAllFixture([]);
    enhanceDropdowns(fixture.scope);

    // Space on the focused checkbox, or a click, toggles it before the click event.
    fixture.selectAll.checked = false;
    const cancelled = fixture.scope.dispatch('click', fixture.selectAll);
    expect(cancelled.defaultPrevented).toBe(true);
    expect(fixture.nativeSelect.dispatchEvent).not.toHaveBeenCalled();

    // A fallback change (no click) still lands on the unrestricted state.
    fixture.scope.dispatch('change', fixture.selectAll);
    expect(fixture.selectAll.checked).toBe(true);

    fixture.png.checked = true;
    fixture.scope.dispatch('change', fixture.png);
    expect(fixture.selectAll.checked).toBe(false);
    fixture.selectAll.checked = true;
    expect(fixture.scope.dispatch('click', fixture.selectAll).defaultPrevented).toBe(false);
    expect(fixture.scope.dispatch('click', fixture.webp).defaultPrevented).toBe(false);
  });

  it('dispatches exactly one native change per user selection', () => {
    const fixture = selectAllFixture(['jpg', 'png', 'webp']);
    enhanceDropdowns(fixture.scope);
    enhanceDropdowns(fixture.scope);

    fixture.selectAll.checked = true;
    fixture.scope.dispatch('change', fixture.selectAll);
    expect(fixture.nativeSelect.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(fixture.checkedValues()).toEqual(['all']);
  });

  it('includes values discovered later while unrestricted, and keeps an explicit set restricted', () => {
    const fixture = makeDropdown('multiple', EXTENSIONS.slice(0, 2), [], { value: '', dispatchNativeChange: true });
    fixture.nativeSelect.multiple = true;
    fixture.nativeSelect.options.forEach((option) => { option.selected = false; });
    fixture.dropdown.dataset.ccDropdownSelectAll = 'all';
    fixture.dropdown.dataset.ccDropdownEmptySummary = 'All extensions';
    fixture.dropdown.dataset.ccDropdownCountLabel = 'extensions';
    wireNativeSyncFixture(fixture);
    const document = fixture.dropdown.ownerDocument;
    const panel = fixture.dropdown.querySelector('.asset-filter-multiselect-panel');
    const wrapper = document.createElement('div');
    wrapper.setAttribute('class', 'asset-filter-multiselect-option cc-dropdown-select-all-option');
    const selectAll = markSelectAll(document.createElement('input'));
    selectAll.setAttribute('type', 'checkbox');
    selectAll.setAttribute('value', 'all');
    wrapper.appendChild(selectAll);
    panel.appendChild(wrapper);
    const checkboxes = () => fixture.dropdown.querySelectorAll('input[type="checkbox"]');
    const checkedValues = () => checkboxes().filter((input) => input.checked).map((input) => input.value);
    const nativeValues = () => fixture.nativeSelect.options
      .filter((option) => option.selected).map((option) => option.value);
    const routed = (input) => {
      const closest = input.closest.bind(input);
      input.closest = (selector) => (selector === '[data-cc-dropdown]' ? fixture.dropdown : closest(selector));
      return input;
    };
    routed(selectAll);

    enhanceDropdowns(fixture.scope);
    expect(checkboxes().map((input) => input.value)).toEqual(['all', 'jpg']);
    expect(checkedValues()).toEqual(['all']);

    fixture.nativeSelect.options.push({ value: 'webp', textContent: '.webp', selected: false });
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(checkboxes().map((input) => input.value)).toEqual(['all', 'jpg', 'webp']);
    expect(checkedValues()).toEqual(['all']);
    expect(fixture.currentSummary.textContent).toBe('All extensions');

    const jpg = routed(checkboxes()[1]);
    jpg.checked = true;
    fixture.scope.dispatch('change', jpg);
    expect(nativeValues()).toEqual(['jpg']);

    fixture.nativeSelect.options.push({ value: 'png', textContent: '.png', selected: false });
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(checkedValues()).toEqual(['jpg']);
    expect(nativeValues()).toEqual(['jpg']);

    // A catalogue without the neutral option keeps the Select all row; unrestricted
    // then leaves the native select empty (the existing unrestricted value).
    fixture.nativeSelect.options.splice(0, 1);
    fixture.scope.dispatch('change', fixture.nativeSelect);
    expect(checkboxes()[0]).toBe(selectAll);
    selectAll.checked = true;
    fixture.scope.dispatch('change', selectAll);
    expect(checkedValues()).toEqual(['all']);
    expect(nativeValues()).toEqual([]);
  });

  it('handles an empty option list without errors', () => {
    const fixture = makeDropdown('multiple', [], [], { value: '', dispatchNativeChange: true });
    fixture.nativeSelect.multiple = true;
    fixture.dropdown.dataset.ccDropdownSelectAll = 'all';
    fixture.dropdown.dataset.ccDropdownEmptySummary = '';
    const selectAll = markSelectAll({
      type: 'checkbox',
      value: 'all',
      checked: false,
      closest(selector) {
        if (selector === 'label') return { textContent: 'Select all' };
        if (selector === '[data-cc-dropdown]') return fixture.dropdown;
        return null;
      },
    });
    fixture.inputs.push(selectAll);

    expect(() => enhanceDropdowns(fixture.scope)).not.toThrow();
    expect(selectAll.checked).toBe(true);
    expect(fixture.currentSummary.textContent).toBe('All');
  });

  it('leaves dropdowns that do not opt in unchanged, including a literal "all" option', () => {
    const fixture = makeDropdown('multiple', [
      { value: 'all', label: 'All' },
      { value: 'alpha', label: 'Alpha' },
    ], ['all']);
    enhanceDropdowns(fixture.scope);
    const [all, alpha] = fixture.inputs;

    alpha.checked = true;
    fixture.scope.dispatch('change', alpha);
    expect(all.checked).toBe(true);
    expect(fixture.currentSummary.textContent).toBe('2 tags selected');

    all.checked = false;
    expect(fixture.scope.dispatch('click', all).defaultPrevented).toBe(false);
    alpha.checked = false;
    fixture.scope.dispatch('change', alpha);
    expect(all.checked).toBe(false);
    expect(fixture.currentSummary.textContent).toBe('All tags');
  });
});

describe('Filters & Defaults dialog dropdown overlay hook', () => {
  function dialogDropdown(bodyClassName) {
    const panelStyle = {};
    const panel = {
      style: panelStyle,
      getBoundingClientRect() { return { width: 240, height: 120 }; },
      setAttribute() {},
      removeAttribute() {},
    };
    const summary = {
      getBoundingClientRect() { return { left: 40, top: 200, bottom: 236, right: 280, width: 240 }; },
      setAttribute() {},
    };
    const body = {
      scrollTop: 0,
      scrollLeft: 0,
      classList: {
        contains: (name) => bodyClassName.split(' ').includes(name),
        remove() {},
        toggle() {},
      },
      closest: () => null,
      addEventListener() {},
      removeEventListener() {},
    };
    const dropdown = {
      open: true,
      isConnected: true,
      hasAttribute: () => false,
      closest: (selector) => (selector === '.app-dialog-body' ? body : null),
      querySelector: (selector) => (selector === 'summary' ? summary : panel),
      ownerDocument: {
        documentElement: { clientWidth: 1200 },
        defaultView: {
          innerWidth: 1200,
          innerHeight: 800,
          addEventListener() {},
          removeEventListener() {},
          getComputedStyle() { return { maxWidth: 'none' }; },
        },
      },
    };
    return { dropdown, panelStyle };
  }

  it('opens panels in the scrolling Filters & Defaults body as fixed overlays', () => {
    const { dropdown, panelStyle } = dialogDropdown('app-dialog-body filters-defaults-dialog-body');
    updateAssetViewerFilterDisclosureState(dropdown);
    expect(panelStyle.position).toBe('fixed');
    expect(panelStyle.top).toBe('240px');
  });

  it('does not change other dialog bodies', () => {
    const { dropdown, panelStyle } = dialogDropdown('app-dialog-body');
    updateAssetViewerFilterDisclosureState(dropdown);
    expect(panelStyle.position).toBeUndefined();
  });
});

describe('open dialog dropdown re-anchoring after layout changes (consolidated review F1)', () => {
  function layoutDropdown() {
    const observers = { mutation: [], resize: [] };
    const frames = new Map();
    let nextFrame = 1;
    const writes = [];
    const panelAttributes = new Set();
    const panelStyle = {
      setProperty(property, value) { writes.push(property); this[property] = value; },
      removeProperty(property) { delete this[property]; },
    };
    const panel = {
      style: panelStyle,
      scrollTop: 0,
      scrollHeight: 120,
      getBoundingClientRect() { return { width: 240, height: 120 }; },
      setAttribute(name) { panelAttributes.add(name); },
      removeAttribute(name) { panelAttributes.delete(name); },
      hasAttribute(name) { return panelAttributes.has(name); },
    };
    const trigger = { top: 200 };
    const summary = {
      getBoundingClientRect() {
        return { left: 40, top: trigger.top, bottom: trigger.top + 36, right: 280, width: 240 };
      },
      setAttribute() {},
      focus: vi.fn(),
    };
    const dialog = { id: 'dialog' };
    const body = {
      scrollTop: 0,
      scrollLeft: 0,
      isConnected: true,
      classList: {
        contains: (name) => ['app-dialog-body', 'filters-defaults-dialog-body'].includes(name),
        remove() {},
        toggle() {},
      },
      closest: (selector) => (selector === '[data-app-dialog]' ? dialog : null),
      addEventListener() {},
      removeEventListener() {},
    };
    class FakeMutationObserver {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.mutation.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; }
    }
    class FakeResizeObserver {
      constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.resize.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
    }
    const view = {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle() { return { maxWidth: 'none' }; },
      MutationObserver: FakeMutationObserver,
      ResizeObserver: FakeResizeObserver,
      requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
    };
    const dropdown = {
      open: true,
      isConnected: true,
      hasAttribute: () => false,
      removeAttribute() {},
      closest: (selector) => (selector === '.app-dialog-body' ? body : null),
      querySelector: (selector) => (selector === 'summary' ? summary : panel),
      ownerDocument: { documentElement: { clientWidth: 1200 }, defaultView: view },
    };
    const runFrames = () => {
      const pending = Array.from(frames.values());
      frames.clear();
      pending.forEach((callback) => callback());
    };
    const mutate = (records = [{ type: 'childList', target: dialog }]) => {
      observers.mutation.forEach((observer) => !observer.disconnected && observer.callback(records));
    };
    return { dropdown, panel, panelStyle, trigger, dialog, summary, observers, frames, writes, runFrames, mutate };
  }

  it('re-places an open panel when dialog content moves its trigger, once per frame', () => {
    const fixture = layoutDropdown();
    updateAssetViewerFilterDisclosureState(fixture.dropdown);
    expect(fixture.panelStyle.top).toBe('240px');
    const [layoutObserver] = fixture.observers.mutation;
    expect(layoutObserver.target).toBe(fixture.dialog);
    expect(layoutObserver.options).toMatchObject({ childList: true, subtree: true, attributes: true });
    expect(layoutObserver.options.attributeFilter).toEqual(expect.arrayContaining(['hidden', 'class']));
    expect(fixture.observers.resize[0].targets).toEqual([fixture.summary, fixture.dialog]);

    // A notice inserted above the trigger moves it 60px without resizing it.
    fixture.trigger.top = 260;
    fixture.mutate();
    fixture.mutate();
    expect(fixture.frames.size).toBe(1);
    expect(fixture.panelStyle.top).toBe('240px');
    fixture.runFrames();
    expect(fixture.panelStyle.top).toBe('300px');

    // Removal moves it back; the same mechanism follows.
    fixture.trigger.top = 200;
    fixture.observers.resize[0].callback([]);
    fixture.runFrames();
    expect(fixture.panelStyle.top).toBe('240px');
  });

  it('ignores its own panel style writes and does no writes when the trigger did not move', () => {
    const fixture = layoutDropdown();
    updateAssetViewerFilterDisclosureState(fixture.dropdown);
    fixture.mutate([{ type: 'attributes', target: fixture.panel, attributeName: 'style' }]);
    expect(fixture.frames.size).toBe(0);

    fixture.writes.length = 0;
    fixture.mutate();
    fixture.runFrames();
    expect(fixture.writes).toEqual([]);
    expect(fixture.frames.size).toBe(0);
  });

  it('stops observing and cancels a pending frame when the dropdown closes', () => {
    const fixture = layoutDropdown();
    updateAssetViewerFilterDisclosureState(fixture.dropdown);
    fixture.trigger.top = 260;
    fixture.mutate();
    expect(fixture.frames.size).toBe(1);

    fixture.dropdown.open = false;
    updateAssetViewerFilterDisclosureState(fixture.dropdown);
    expect(fixture.frames.size).toBe(0);
    expect(fixture.observers.mutation.every((observer) => observer.disconnected)).toBe(true);
    expect(fixture.observers.resize.every((observer) => observer.disconnected)).toBe(true);
    expect(fixture.panelStyle.position).toBeUndefined();
  });

  it('cleans up without placing when the open dropdown was detached by a replacement', () => {
    const fixture = layoutDropdown();
    updateAssetViewerFilterDisclosureState(fixture.dropdown);
    fixture.dropdown.isConnected = false;
    fixture.writes.length = 0;
    fixture.mutate();
    fixture.runFrames();
    expect(fixture.writes).toEqual([]);
    expect(fixture.observers.mutation.every((observer) => observer.disconnected)).toBe(true);
    expect(fixture.observers.resize.every((observer) => observer.disconnected)).toBe(true);
    fixture.mutate();
    expect(fixture.frames.size).toBe(0);
  });
});

describe('searchable multi-select filter dropdowns (Filters & Defaults M3 WP9b)', () => {
  // The Asset Library Projects shape: a searchable multi-select whose
  // unrestricted Select all row has an empty value (no query key).
  function searchableMultiFixture(selectedValues) {
    const fixture = makeDropdown('multiple', [
      { value: '', label: 'Select all' },
      { value: '1', label: 'Alpha Project' },
      { value: '2', label: 'Beta Project' },
      { value: '3', label: 'Gamma Project' },
    ], selectedValues);
    const { dropdown, inputs } = fixture;
    dropdown.dataset.ccDropdownSearchable = '';
    dropdown.dataset.ccDropdownSelectAll = '';
    dropdown.dataset.ccDropdownEmptySummary = 'All projects';
    dropdown.dataset.ccDropdownCountLabel = 'projects';
    inputs[0].hasAttribute = (name) => name === 'data-cc-dropdown-select-all';
    const rows = inputs.map((input) => ({
      hidden: false,
      querySelector(selector) {
        return selector === 'input[type="checkbox"]' ? input : null;
      },
      setAttribute(name) {
        if (name === 'hidden') this.hidden = true;
      },
      removeAttribute(name) {
        if (name === 'hidden') this.hidden = false;
      },
    }));
    const search = {
      value: '',
      closest: (selector) => (selector === '[data-cc-dropdown]' ? dropdown : null),
      setAttribute() {},
      removeAttribute() {},
    };
    const noResults = {
      hidden: true,
      setAttribute(name) { if (name === 'hidden') this.hidden = true; },
      removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
    };
    const querySelector = dropdown.querySelector.bind(dropdown);
    dropdown.querySelector = (selector) => {
      if (selector === '[data-cc-dropdown-search]') return search;
      if (selector === '[data-cc-dropdown-option-list]') {
        return { querySelectorAll: (candidate) => (candidate === '.asset-filter-multiselect-option' ? rows : []) };
      }
      if (selector === '[data-cc-dropdown-no-results]') return noResults;
      return querySelector(selector);
    };
    const checkedValues = () => inputs.filter((input) => input.checked).map((input) => input.value);
    return { ...fixture, rows, search, noResults, checkedValues };
  }

  it('hides only non-matching rows: hidden selections stay checked and Select all stays visible', () => {
    const fixture = searchableMultiFixture(['1', '3']);
    enhanceDropdowns(fixture.scope);
    expect(fixture.currentSummary.textContent).toBe('2 projects selected');
    expect(fixture.inputs[0].checked).toBe(false);

    fixture.search.value = 'beta';
    fixture.scope.dispatch('input', fixture.search);
    expect(fixture.rows.map((row) => row.hidden)).toEqual([false, true, false, true]);
    expect(fixture.checkedValues()).toEqual(['1', '3']);

    // Choosing a visible Project keeps the hidden selections and the menu open.
    fixture.dropdown.open = true;
    fixture.inputs[2].checked = true;
    fixture.scope.dispatch('change', fixture.inputs[2]);
    expect(fixture.checkedValues()).toEqual(['1', '2', '3']);
    expect(fixture.currentSummary.textContent).toBe('3 projects selected');
    expect(fixture.dropdown.open).toBe(true);

    fixture.search.value = '';
    fixture.scope.dispatch('input', fixture.search);
    expect(fixture.rows.map((row) => row.hidden)).toEqual([false, false, false, false]);
  });

  it('Select all is unrestricted: it clears individual Projects instead of checking them all', () => {
    const fixture = searchableMultiFixture(['2']);
    enhanceDropdowns(fixture.scope);
    expect(fixture.currentSummary.textContent).toBe('Beta Project');

    fixture.inputs[0].checked = true;
    fixture.scope.dispatch('change', fixture.inputs[0]);
    expect(fixture.checkedValues()).toEqual(['']);
    expect(fixture.currentSummary.textContent).toBe('All projects');

    // Clearing the last individual value returns to unrestricted.
    fixture.inputs[3].checked = true;
    fixture.scope.dispatch('change', fixture.inputs[3]);
    expect(fixture.checkedValues()).toEqual(['3']);
    fixture.inputs[3].checked = false;
    fixture.scope.dispatch('change', fixture.inputs[3]);
    expect(fixture.checkedValues()).toEqual(['']);
  });
});

describe('carried hidden selections (Filters & Defaults M3 R10)', () => {
  // A pending Releases / Calendar destination keeps a Project without a
  // rendered option in a hidden form input marked data-cc-dropdown-carried-value.
  function carriedFixture(selectedValues, carriedValues, { carriedName = 'project' } = {}) {
    const fixture = makeDropdown('multiple', [
      { value: '', label: 'Select all' },
      { value: '1', label: 'Alpha Project' },
      { value: '2', label: 'Beta Project' },
    ], selectedValues);
    const { dropdown, inputs, summary } = fixture;
    dropdown.dataset.ccDropdownSelectAll = '';
    dropdown.dataset.ccDropdownEmptySummary = 'All projects';
    dropdown.dataset.ccDropdownCountLabel = 'projects';
    inputs[0].hasAttribute = (name) => name === 'data-cc-dropdown-select-all';
    inputs.forEach((input) => { input.name = 'project'; });
    const carriers = [];
    const carriedSelector = 'input[data-cc-dropdown-carried-value]';
    // P3-C1 follow-up: a minimal document models HTML form ownership. Carriers can
    // sit inside the dropdown's form, outside it, or inside another real form, and
    // a form="" attribute names their owner by id. No carrier reports `.form`
    // unless a spec gives one, so ownership is never inferred from containment.
    const isInside = (node, ancestor) => {
      let current = node?.parentNode;
      while (current) {
        if (current === ancestor) return true;
        current = current.parentNode;
      }
      return false;
    };
    const document = {
      nodeType: 9,
      getElementById: (id) => [form, otherForm].find((candidate) => candidate.id === id) || null,
      querySelectorAll: (selector) => (selector === carriedSelector ? carriers.slice() : []),
    };
    const form = {
      tagName: 'FORM', id: 'list-releases-filter', nodeType: 1, ownerDocument: document, parentNode: document, children: [],
      querySelectorAll: (selector) => (selector === carriedSelector
        ? carriers.filter((carrier) => isInside(carrier, form)) : []),
    };
    const otherForm = {
      tagName: 'FORM', id: 'other-form', nodeType: 1, ownerDocument: document, parentNode: document, children: [],
      querySelectorAll: (selector) => (selector === carriedSelector
        ? carriers.filter((carrier) => isInside(carrier, otherForm)) : []),
    };
    const outside = { tagName: 'DIV', nodeType: 1, ownerDocument: document, parentNode: document, children: [] };
    const places = { inside: form, outside, other: otherForm };
    carriedValues.forEach((spec) => {
      // P3: a spec is a value or { value, disabled, fieldset: { disabled, inLegend }, form,
      // place: 'inside' | 'outside' | 'other', formAttr }.
      const {
        value, disabled = false, fieldset = null, form: owner, place = 'inside', formAttr = null,
      } = typeof spec === 'string' ? { value: spec } : spec;
      let parentNode = places[place];
      if (fieldset) {
        const fieldsetNode = {
          tagName: 'FIELDSET', disabled: Boolean(fieldset.disabled), parentNode, children: [],
          hasAttribute: (name) => name === 'disabled' && Boolean(fieldset.disabled),
        };
        parentNode.children.push(fieldsetNode);
        parentNode = fieldsetNode;
        if (fieldset.inLegend) {
          const legend = { tagName: 'LEGEND', parentNode: fieldsetNode, children: [] };
          fieldsetNode.children.push(legend);
          parentNode = legend;
        }
      }
      const carrier = {
        type: 'hidden',
        value,
        disabled,
        parentNode,
        ownerDocument: document,
        getAttribute: (name) => {
          if (name === 'name') return carriedName;
          if (name === 'form') return formAttr;
          return null;
        },
        hasAttribute: (name) => (name === 'disabled' && carrier.disabled) || (name === 'form' && formAttr !== null),
        remove() {
          carriers.splice(carriers.indexOf(carrier), 1);
          carrier.parentNode.children.splice(carrier.parentNode.children.indexOf(carrier), 1);
          carrier.parentNode = null;
        },
      };
      if (owner !== undefined) carrier.form = owner === 'self' ? form : owner;
      parentNode.children?.push(carrier);
      carriers.push(carrier);
    });
    dropdown.closest = (selector) => (selector === 'form' ? form : null);
    const checkedValues = () => inputs.filter((input) => input.checked).map((input) => input.value);
    return { ...fixture, carriers, checkedValues, summary, form, otherForm, document };
  }

  // Test oracle: the HTML form owner (form="" by id, else the nearest ancestor form)
  // and native FormData eligibility, written independently of the product helper.
  function ownerOf(fixture, carrier) {
    if (carrier.form !== undefined) return carrier.form;
    const formAttr = carrier.getAttribute('form');
    if (formAttr !== null) return fixture.document.getElementById(formAttr);
    let node = carrier.parentNode;
    while (node && node.tagName !== 'FORM') node = node.parentNode;
    return node || null;
  }

  function submittedTo(fixture, targetForm) {
    return fixture.carriers
      .filter((carrier) => {
        if (carrier.disabled) return false;
        if (ownerOf(fixture, carrier) !== targetForm) return false;
        let child = carrier;
        let node = carrier.parentNode;
        while (node && node.nodeType !== 9) {
          const legend = node.tagName === 'FIELDSET' ? node.children.find((element) => element.tagName === 'LEGEND') : null;
          if (node.tagName === 'FIELDSET' && node.disabled && legend !== child) return false;
          child = node;
          node = node.parentNode;
        }
        return true;
      })
      .map((carrier) => carrier.value);
  }

  it('a hidden-only selection is restricted: Select all unchecked, summary never All', () => {
    const fixture = carriedFixture([], ['999999']);
    enhanceDropdowns(fixture.scope);
    expect(fixture.inputs[0].checked).toBe(false);
    expect(fixture.currentSummary.textContent).toBe('1 project selected');
    expect(fixture.summaryAttrs['aria-label']).toBe('Tag filter: 1 project selected');
  });

  it('one Select all activation (pointer or Space) is not cancelled and clears the carried value', () => {
    const fixture = carriedFixture([], ['999999', '888888']);
    enhanceDropdowns(fixture.scope);
    expect(fixture.currentSummary.textContent).toBe('2 projects selected');
    // The browser toggles the box to checked before the click event.
    fixture.inputs[0].checked = true;
    expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(false);
    fixture.scope.dispatch('change', fixture.inputs[0]);
    expect(fixture.carriers).toHaveLength(0);
    expect(fixture.checkedValues()).toEqual(['']);
    expect(fixture.currentSummary.textContent).toBe('All projects');
    // Genuinely unrestricted again: the existing no-op guard applies.
    fixture.inputs[0].checked = false;
    expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(true);
  });

  it('mixed visible + carried values count once each; choosing a value replaces the carried intent', () => {
    const fixture = carriedFixture(['2'], ['999999', '2']);
    enhanceDropdowns(fixture.scope);
    expect(fixture.inputs[0].checked).toBe(false);
    expect(fixture.currentSummary.textContent).toBe('2 projects selected');
    fixture.inputs[1].checked = true;
    fixture.scope.dispatch('change', fixture.inputs[1]);
    expect(fixture.carriers).toHaveLength(0);
    expect(fixture.checkedValues()).toEqual(['1', '2']);
    expect(fixture.currentSummary.textContent).toBe('2 projects selected');
  });

  /*
   * P3 correction 1: only a carrier native submission would include counts.
   * submitted() mirrors FormData for these carriers so the display is compared
   * with what the form actually sends.
   */
  describe('P3: disabled carriers are not active selections', () => {
    const submitted = (fixture) => submittedTo(fixture, fixture.form);

    it('a disabled-only carrier is unrestricted: All, Select all checked, its click stays a no-op', () => {
      const fixture = carriedFixture([], [{ value: '999999', disabled: true }]);
      enhanceDropdowns(fixture.scope);
      expect(submitted(fixture)).toEqual([]);
      expect(fixture.inputs[0].checked).toBe(true);
      expect(fixture.currentSummary.textContent).toBe('All projects');
      // Pointer click or Space on the checked Select all (the browser unchecks first).
      fixture.inputs[0].checked = false;
      expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(true);
      // The intentionally disabled input is neither re-enabled nor removed.
      expect(fixture.carriers).toHaveLength(1);
      expect(fixture.carriers[0].disabled).toBe(true);
    });

    it('an enabled-only carrier stays restricted and one Select all activation clears it', () => {
      const fixture = carriedFixture([], [{ value: '999999', disabled: false }]);
      enhanceDropdowns(fixture.scope);
      expect(submitted(fixture)).toEqual(['999999']);
      expect(fixture.inputs[0].checked).toBe(false);
      expect(fixture.currentSummary.textContent).toBe('1 project selected');
      fixture.inputs[0].checked = true;
      expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(false);
      fixture.scope.dispatch('change', fixture.inputs[0]);
      expect(fixture.carriers).toHaveLength(0);
      expect(fixture.currentSummary.textContent).toBe('All projects');
    });

    it('mixed enabled + disabled carriers count only distinct enabled values', () => {
      const fixture = carriedFixture(['2'], [
        '999999',
        { value: '999999', disabled: true },
        { value: '888888', disabled: true },
        '777777',
        '777777',
        '2',
      ]);
      enhanceDropdowns(fixture.scope);
      // Rendered 2 + carried 999999, 777777 (888888 is disabled; duplicates count once).
      expect(new Set(submitted(fixture).filter((value) => value !== '2'))).toEqual(new Set(['999999', '777777']));
      expect(fixture.currentSummary.textContent).toBe('3 projects selected');
      expect(fixture.inputs[0].checked).toBe(false);
      // Select all clears this dimension's active carriers; disabled ones are left untouched.
      fixture.inputs[0].checked = true;
      expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(false);
      fixture.scope.dispatch('change', fixture.inputs[0]);
      expect(fixture.checkedValues()).toEqual(['']);
      expect(fixture.carriers.map((carrier) => [carrier.value, carrier.disabled]))
        .toEqual([['999999', true], ['888888', true]]);
      expect(submitted(fixture)).toEqual([]);
      expect(fixture.currentSummary.textContent).toBe('All projects');
    });

    it('a carrier inside a disabled fieldset does not count; one in its first legend does', () => {
      const disabledFieldset = carriedFixture([], [{ value: '999999', fieldset: { disabled: true } }]);
      enhanceDropdowns(disabledFieldset.scope);
      expect(submitted(disabledFieldset)).toEqual([]);
      expect(disabledFieldset.inputs[0].checked).toBe(true);
      expect(disabledFieldset.currentSummary.textContent).toBe('All projects');

      const enabledFieldset = carriedFixture([], [{ value: '999999', fieldset: { disabled: false } }]);
      enhanceDropdowns(enabledFieldset.scope);
      expect(submitted(enabledFieldset)).toEqual(['999999']);
      expect(enabledFieldset.currentSummary.textContent).toBe('1 project selected');

      const legend = carriedFixture([], [{ value: '999999', fieldset: { disabled: true, inLegend: true } }]);
      enhanceDropdowns(legend.scope);
      expect(submitted(legend)).toEqual(['999999']);
      expect(legend.inputs[0].checked).toBe(false);
      expect(legend.currentSummary.textContent).toBe('1 project selected');
    });

    it('a carrier owned by another form (form="" attribute) does not count', () => {
      const other = {};
      const fixture = carriedFixture([], [{ value: '999999', form: other }, { value: '777777', form: 'self' }]);
      enhanceDropdowns(fixture.scope);
      expect(submitted(fixture)).toEqual(['777777']);
      expect(fixture.currentSummary.textContent).toBe('1 project selected');

      const orphan = carriedFixture([], [{ value: '999999', form: null }]);
      enhanceDropdowns(orphan.scope);
      expect(orphan.currentSummary.textContent).toBe('All projects');
      expect(orphan.inputs[0].checked).toBe(true);
    });

    it('a carrier disabled after enhancement stops counting on the next refresh', () => {
      const fixture = carriedFixture([], ['999999', '888888']);
      enhanceDropdowns(fixture.scope);
      expect(fixture.currentSummary.textContent).toBe('2 projects selected');
      fixture.carriers[0].disabled = true;
      fixture.carriers[1].disabled = true;
      enhanceDropdowns(fixture.scope);
      expect(fixture.inputs[0].checked).toBe(true);
      expect(fixture.currentSummary.textContent).toBe('All projects');
      fixture.carriers[1].disabled = false;
      enhanceDropdowns(fixture.scope);
      expect(fixture.inputs[0].checked).toBe(false);
      expect(fixture.currentSummary.textContent).toBe('1 project selected');
    });
  });

  describe('P3-C1 follow-up: carriers follow their HTML form owner, not DOM containment', () => {
    const external = (value, extra = {}) => ({ value, place: 'outside', formAttr: 'list-releases-filter', ...extra });
    const foreignInside = (value, extra = {}) => ({ value, place: 'inside', formAttr: 'other-form', ...extra });
    const activateSelectAll = (fixture) => {
      // Pointer or Space: the browser toggles the box, then dispatches click and change.
      fixture.inputs[0].checked = true;
      const click = fixture.scope.dispatch('click', fixture.inputs[0]);
      fixture.scope.dispatch('change', fixture.inputs[0]);
      return click;
    };

    it('1. a carrier outside the form but owned by it (form="") is counted and submitted', () => {
      const fixture = carriedFixture([], [external('999999')]);
      enhanceDropdowns(fixture.scope);
      expect(submittedTo(fixture, fixture.form)).toEqual(['999999']);
      expect(fixture.inputs[0].checked).toBe(false);
      expect(fixture.currentSummary.textContent).toBe('1 project selected');
      expect(fixture.summaryAttrs['aria-label']).toBe('Tag filter: 1 project selected');
    });

    it('2. a carrier inside the form but owned by another form is not counted', () => {
      const fixture = carriedFixture([], [foreignInside('999999')]);
      enhanceDropdowns(fixture.scope);
      expect(submittedTo(fixture, fixture.form)).toEqual([]);
      expect(submittedTo(fixture, fixture.otherForm)).toEqual(['999999']);
      expect(fixture.inputs[0].checked).toBe(true);
      expect(fixture.currentSummary.textContent).toBe('All projects');
      // Genuinely unrestricted: the checked Select all stays a no-op.
      fixture.inputs[0].checked = false;
      expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(true);
      expect(fixture.carriers).toHaveLength(1);
    });

    it('3. editing the first form does not remove the second form carrier', () => {
      const fixture = carriedFixture([], ['777777', foreignInside('999999'), { value: '888888', place: 'other' }]);
      enhanceDropdowns(fixture.scope);
      expect(fixture.currentSummary.textContent).toBe('1 project selected');
      fixture.inputs[1].checked = true;
      fixture.scope.dispatch('change', fixture.inputs[1]);
      expect(fixture.carriers.map((carrier) => carrier.value)).toEqual(['999999', '888888']);
      expect(submittedTo(fixture, fixture.otherForm)).toEqual(['999999', '888888']);
      expect(submittedTo(fixture, fixture.form)).toEqual([]);
      expect(fixture.checkedValues()).toEqual(['1']);
      expect(fixture.currentSummary.textContent).toBe('Alpha Project');
    });

    it('4. one Select all activation removes the external carrier it owns', () => {
      const fixture = carriedFixture([], [external('999999'), foreignInside('555555')]);
      enhanceDropdowns(fixture.scope);
      expect(fixture.currentSummary.textContent).toBe('1 project selected');
      expect(activateSelectAll(fixture).defaultPrevented).toBe(false);
      expect(fixture.carriers.map((carrier) => carrier.value)).toEqual(['555555']);
      expect(submittedTo(fixture, fixture.form)).toEqual([]);
      expect(fixture.checkedValues()).toEqual(['']);
      expect(fixture.currentSummary.textContent).toBe('All projects');
    });

    it('5. a disabled external carrier (or one in a disabled fieldset) is ignored and left in place', () => {
      const fixture = carriedFixture([], [
        external('999999', { disabled: true }),
        external('888888', { fieldset: { disabled: true } }),
      ]);
      enhanceDropdowns(fixture.scope);
      expect(submittedTo(fixture, fixture.form)).toEqual([]);
      expect(fixture.inputs[0].checked).toBe(true);
      expect(fixture.currentSummary.textContent).toBe('All projects');
      fixture.inputs[0].checked = false;
      expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(true);
      expect(fixture.carriers).toHaveLength(2);
      expect(fixture.carriers[0].disabled).toBe(true);

      const legend = carriedFixture([], [external('777777', { fieldset: { disabled: true, inLegend: true } })]);
      enhanceDropdowns(legend.scope);
      expect(submittedTo(legend, legend.form)).toEqual(['777777']);
      expect(legend.currentSummary.textContent).toBe('1 project selected');

      // A foreign-owned carrier in a disabled fieldset inside this form neither counts nor submits.
      const foreignDisabled = carriedFixture([], [foreignInside('666666', { fieldset: { disabled: true } })]);
      enhanceDropdowns(foreignDisabled.scope);
      expect(foreignDisabled.currentSummary.textContent).toBe('All projects');
      expect(submittedTo(foreignDisabled, foreignDisabled.otherForm)).toEqual([]);
    });

    it('6. mixed visible, internal and external carriers count distinct submitted values once', () => {
      const fixture = carriedFixture(['2'], [
        '999999',
        external('999999'),
        external('777777'),
        external('2'),
        foreignInside('444444'),
        { value: '333333', place: 'outside' },
        external('111111', { disabled: true }),
      ]);
      enhanceDropdowns(fixture.scope);
      // Rendered 2 + carried 999999, 777777 (the unowned 333333, foreign 444444 and
      // disabled 111111 never submit with this form).
      expect(new Set(submittedTo(fixture, fixture.form))).toEqual(new Set(['999999', '777777', '2']));
      expect(fixture.currentSummary.textContent).toBe('3 projects selected');
      expect(fixture.inputs[0].checked).toBe(false);
      // An unrelated refresh keeps the restriction.
      enhanceDropdowns(fixture.scope);
      expect(fixture.currentSummary.textContent).toBe('3 projects selected');
    });

    it('7. Select all (keyboard Space) clears only this dimension and owner', () => {
      const fixture = carriedFixture([], [external('999999'), foreignInside('555555')]);
      enhanceDropdowns(fixture.scope);
      // A Type carrier owned by the same form belongs to another dimension.
      const typeFixture = carriedFixture([], [external('audio')], { carriedName: 'type' });
      enhanceDropdowns(typeFixture.scope);
      expect(typeFixture.currentSummary.textContent).toBe('All projects');

      expect(activateSelectAll(fixture).defaultPrevented).toBe(false);
      expect(fixture.carriers.map((carrier) => carrier.value)).toEqual(['555555']);
      expect(fixture.currentSummary.textContent).toBe('All projects');
      activateSelectAll(typeFixture);
      expect(typeFixture.carriers.map((carrier) => carrier.value)).toEqual(['audio']);
    });
  });

  it('a carrier of another field name is ignored', () => {
    const fixture = carriedFixture([], ['audio'], { carriedName: 'type' });
    enhanceDropdowns(fixture.scope);
    expect(fixture.inputs[0].checked).toBe(true);
    expect(fixture.currentSummary.textContent).toBe('All projects');
    fixture.inputs[0].checked = false;
    expect(fixture.scope.dispatch('click', fixture.inputs[0]).defaultPrevented).toBe(true);
    expect(fixture.carriers).toHaveLength(1);
  });
});
