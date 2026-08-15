import { describe, expect, it, vi } from 'vitest';
import { enhanceDropdowns } from '../src/static/creatorcrate.js';

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
      options: options.map(({ value }) => ({ value, selected: value === nativeConfig.value })),
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

  return { scope, dropdown, inputs, summary, summaryAttrs, currentSummary, listeners, nativeSelect };
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
});
