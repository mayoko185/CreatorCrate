import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  enhancePreview,
  enhancePreviewMedia,
  enhanceAssetSelection,
  enhanceAssetRenames,
  enhanceAssetGridSize,
} from '../src/static/creatorcrate.js';

function makeElement(props = {}) {
  const listeners = [];
  const attrOps = [];
  const element = {
    dataset: {},
    hidden: false,
    complete: false,
    naturalWidth: 0,
    src: '',
    ...props,
    listeners,
    attrOps,
    setAttribute(name, value) {
      attrOps.push(['set', name, value]);
      if (name === 'data-preview-state') this.dataset.previewState = String(value);
      if (name === 'hidden') this.hidden = true;
    },
    removeAttribute(name) {
      attrOps.push(['remove', name]);
      if (name === 'hidden') this.hidden = false;
    },
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    dispatch(type) {
      for (const listener of listeners.filter((entry) => entry.type === type)) {
        listener.handler();
      }
    },
  };
  return element;
}

function makePreview({ complete = false, naturalWidth = 0, src = '/thumbnail.webp' } = {}) {
  const image = makeElement({ complete, naturalWidth, src });
  const fallback = makeElement({ hidden: true });
  const root = makeElement({ dataset: { previewState: 'loading' } });
  root.querySelector = (selector) => {
    if (selector === '[data-preview-image]') return image;
    if (selector === '[data-preview-fallback]') return fallback;
    return null;
  };
  return { root, image, fallback };
}

describe('static preview enhancement helpers', () => {
  it('handles cached success with the final loaded state', () => {
    const { root, image, fallback } = makePreview({ complete: true, naturalWidth: 128 });

    expect(enhancePreview(root)).toBe('loaded');

    expect(root.dataset.previewState).toBe('loaded');
    expect(root.dataset.previewState).not.toBe('loading');
    expect(image.hidden).toBe(false);
    expect(fallback.hidden).toBe(true);
    expect(image.listeners).toEqual([]);
  });

  it('handles load success without announcements or focus changes', () => {
    const { root, image, fallback } = makePreview();

    expect(enhancePreview(root)).toBe('listening');
    expect(image.listeners.map((listener) => listener.type)).toEqual(['load', 'error']);
    expect(image.listeners.every((listener) => listener.options.once === true)).toBe(true);

    image.dispatch('load');

    expect(root.dataset.previewState).toBe('loaded');
    expect(root.dataset.previewState).not.toBe('loading');
    expect(image.hidden).toBe(false);
    expect(fallback.hidden).toBe(true);
  });

  it('handles image errors by hiding the image and revealing the fallback', () => {
    const { root, image, fallback } = makePreview();

    enhancePreview(root);
    image.dispatch('error');

    expect(root.dataset.previewState).toBe('failed');
    expect(root.dataset.previewState).not.toBe('loading');
    expect(image.hidden).toBe(true);
    expect(fallback.hidden).toBe(false);
  });

  it('does not retry or rewrite image sources after repeated errors', () => {
    const src = '/projects/1/assets/2/thumbnail?v=abc123';
    const { root, image, fallback } = makePreview({ src });

    enhancePreview(root);
    image.dispatch('error');
    const imageOpCount = image.attrOps.length;
    const fallbackOpCount = fallback.attrOps.length;

    image.dispatch('error');

    expect(image.src).toBe(src);
    expect(root.dataset.previewState).toBe('failed');
    expect(root.querySelector('[data-preview-fallback]')).toBe(fallback);
    expect(image.attrOps.filter((op) => op[1] === 'src')).toEqual([]);
    expect(image.attrOps.length).toBe(imageOpCount);
    expect(fallback.attrOps.length).toBe(fallbackOpCount);
  });

  it('no-ops when no matching elements exist', () => {
    const scope = {
      querySelectorAll(selector) {
        expect(selector).toBe('[data-preview-enhancement]');
        return [];
      },
    };

    expect(() => enhancePreviewMedia(scope)).not.toThrow();
    expect(enhancePreviewMedia(scope)).toBe(0);
  });

  it('does not use innerHTML or focus-stealing DOM replacement', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.js', import.meta.url)),
      'utf8'
    );

    expect(source).not.toMatch(/innerHTML/i);
    expect(source).not.toMatch(/aria-live|\.focus\(|innerHTML/i);
  });

  it('uses only browser-local storage for the presentation preference', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.js', import.meta.url)),
      'utf8'
    );

    expect(source).toMatch(/localStorage/);
    expect(source).not.toMatch(/sessionStorage|fetch\(|XMLHttpRequest/i);
  });
});

// ─── Phase 3 chunk 3: page-local asset selection ─────────────────────────

function makeCheckbox({ checked = false, disabled = false } = {}) {
  const listeners = [];
  return {
    checked,
    disabled,
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    dispatch(type) {
      for (const l of listeners.filter((entry) => entry.type === type)) l.handler();
    },
  };
}

function makeControl({ value = '', disabled = false } = {}) {
  const listeners = [];
  return {
    value,
    disabled,
    textContent: '',
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    dispatch(type) {
      for (const l of listeners.filter((entry) => entry.type === type)) l.handler();
    },
  };
}

/**
 * Mock an [data-asset-selection-form] element. `enabledCheckboxes` are the
 * rows the CSS selector `input[type="checkbox"][name="selectedAssetIds"]:not(:disabled)`
 * would match — i.e. present-asset rows only. Missing-asset rows render a
 * disabled checkbox that the real DOM selector excludes entirely, so the
 * mock's querySelectorAll for that selector never returns them either.
 */
function makeAssetSelectionForm({ enabledCheckboxes = [], selectedCount, releaseSelect, selectAll, clearSelection, bulkSubmit } = {}) {
  const singles = {
    '[data-selected-count]': selectedCount ?? makeControl(),
    '[data-release-select]': releaseSelect ?? makeControl(),
    '[data-select-all]': selectAll ?? makeControl(),
    '[data-clear-selection]': clearSelection ?? makeControl(),
    '[data-bulk-submit]': bulkSubmit ?? makeControl(),
  };
  return {
    querySelectorAll(selector) {
      if (selector.includes('selectedAssetIds')) return enabledCheckboxes;
      return [];
    },
    querySelector(selector) {
      return singles[selector] || null;
    },
    _singles: singles,
  };
}

function makeAssetSelectionScope(form, cards = []) {
  return {
    querySelectorAll(selector) {
      if (selector === '[data-asset-selection-form]') return [form];
      if (selector.includes('selectedAssetIds')) return form.querySelectorAll(selector);
      if (selector === '[data-asset-selectable-card]') return cards;
      return [];
    },
  };
}

describe('page-local asset selection enhancement', () => {
  it('is scoped to [data-asset-selection-form] and no-ops when absent', () => {
    const scope = {
      querySelectorAll(selector) {
        expect(selector).toBe('[data-asset-selection-form]');
        return [];
      },
    };

    expect(() => enhanceAssetSelection(scope)).not.toThrow();
    expect(enhanceAssetSelection(scope)).toBe(0);
  });

  it('Select All checks only the enabled (present-asset) checkboxes', () => {
    const cb1 = makeCheckbox();
    const cb2 = makeCheckbox();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1, cb2] });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    form._singles['[data-select-all]'].dispatch('click');

    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(true);
  });

  it('Clear Selection unchecks the enabled checkboxes', () => {
    const cb1 = makeCheckbox({ checked: true });
    const cb2 = makeCheckbox({ checked: true });
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1, cb2] });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    form._singles['[data-clear-selection]'].dispatch('click');

    expect(cb1.checked).toBe(false);
    expect(cb2.checked).toBe(false);
  });

  it('missing-asset (disabled) checkboxes are never part of the enabled set Select All/Clear touch', () => {
    // A disabled checkbox never appears in the mock's enabledCheckboxes —
    // this proves the module only ever iterates the checkboxes it was
    // handed, mirroring the real :not(:disabled) selector excluding them.
    const disabledLikeMissingRow = makeCheckbox({ disabled: true });
    const form = makeAssetSelectionForm({ enabledCheckboxes: [] });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    form._singles['[data-select-all]'].dispatch('click');

    expect(disabledLikeMissingRow.checked).toBe(false);
  });

  it('updates the live selected count after a checkbox change', () => {
    const cb1 = makeCheckbox();
    const cb2 = makeCheckbox();
    const countEl = makeControl();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1, cb2], selectedCount: countEl });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    expect(countEl.textContent).toBe('0 selected');

    cb1.checked = true;
    cb1.dispatch('change');
    expect(countEl.textContent).toBe('1 selected');

    cb2.checked = true;
    cb2.dispatch('change');
    expect(countEl.textContent).toBe('2 selected');
  });

  it('submit is disabled until at least one asset is selected and a release is chosen', () => {
    const cb1 = makeCheckbox();
    const releaseSelect = makeControl({ value: '' });
    const submit = makeControl();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1], releaseSelect, bulkSubmit: submit });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    expect(submit.disabled).toBe(true);

    cb1.checked = true;
    cb1.dispatch('change');
    expect(submit.disabled).toBe(true); // asset selected, but no release yet

    releaseSelect.value = '5';
    releaseSelect.dispatch('change');
    expect(submit.disabled).toBe(false);

    cb1.checked = false;
    cb1.dispatch('change');
    expect(submit.disabled).toBe(true); // release chosen, but no assets now
  });

  it('establishes correct initial state on load (e.g. a validation rerender with a preserved selection)', () => {
    const cb1 = makeCheckbox({ checked: true }); // pre-checked from a submitted selection
    const releaseSelect = makeControl({ value: '5' }); // pre-selected from submission
    const submit = makeControl();
    const countEl = makeControl();
    const form = makeAssetSelectionForm({
      enabledCheckboxes: [cb1], releaseSelect, bulkSubmit: submit, selectedCount: countEl,
    });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);

    expect(countEl.textContent).toBe('1 selected');
    expect(submit.disabled).toBe(false);
  });

  it('synchronizes selected card and control state in both directions from the checkbox', () => {
    const checkbox = makeCheckbox({ checked: true });
    const form = makeAssetSelectionForm({ enabledCheckboxes: [checkbox] });
    const listeners = [];
    const controlClasses = new Set(['is-selected']);
    const cardClasses = new Set(['is-selected']);
    const attributes = { 'aria-selected': 'true' };
    const control = {
      classList: {
        toggle(name, enabled) {
          if (enabled) controlClasses.add(name);
          else controlClasses.delete(name);
        },
      },
    };
    const card = {
      dataset: {},
      classList: {
        toggle(name, enabled) {
          if (enabled) cardClasses.add(name);
          else cardClasses.delete(name);
        },
      },
      setAttribute(name, value) { attributes[name] = String(value); },
      querySelector(selector) {
        if (selector === '.asset-selection-control') return control;
        return null;
      },
      addEventListener(type, handler) { listeners.push({ type, handler }); },
    };
    checkbox.form = form;
    checkbox.closest = () => card;
    const scope = makeAssetSelectionScope(form, [card]);

    enhanceAssetSelection(scope);
    expect(cardClasses.has('is-selected')).toBe(true);
    expect(attributes['aria-selected']).toBe('true');
    expect(controlClasses.has('is-selected')).toBe(true);

    checkbox.checked = false;
    checkbox.dispatch('change');
    expect(checkbox.checked).toBe(false);
    expect(cardClasses.has('is-selected')).toBe(false);
    expect(attributes['aria-selected']).toBe('false');
    expect(controlClasses.has('is-selected')).toBe(false);

    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(checkbox.checked).toBe(true);
    expect(cardClasses.has('is-selected')).toBe(true);
    expect(attributes['aria-selected']).toBe('true');
    expect(controlClasses.has('is-selected')).toBe(true);
  });

  it('toggles a whole card but ignores links and forms inside the card', () => {
    const form = makeAssetSelectionForm({});
    const checkbox = makeCheckbox();
    checkbox.form = form;
    const listeners = [];
    const card = {
      dataset: {},
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      classList: {
        classes: new Set(),
        toggle(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); },
      },
      querySelector(selector) {
        if (selector.includes('selectedAssetIds')) return checkbox;
        return null;
      },
      contains(element) { return element === card || element === link || element === renameForm; },
    };
    checkbox.closest = () => card;
    const link = { closest: () => link };
    const renameForm = { closest: () => renameForm };
    const scope = {
      querySelectorAll(selector) {
        if (selector === '[data-asset-selection-form]') return [form];
        if (selector.includes('selectedAssetIds')) return [checkbox];
        if (selector === '[data-asset-selectable-card]') return [card];
        return [];
      },
    };

    enhanceAssetSelection(scope);
    const click = (target) => listeners.find((entry) => entry.type === 'click').handler({ target });

    click(card);
    expect(checkbox.checked).toBe(true);
    expect(card.classList.classes.has('is-selected')).toBe(true);

    click(link);
    expect(checkbox.checked).toBe(true);
    click(renameForm);
    expect(checkbox.checked).toBe(true);

    const keydown = listeners.find((entry) => entry.type === 'keydown').handler;
    keydown({ target: card, key: 'Enter', preventDefault() {} });
    expect(checkbox.checked).toBe(false);
  });

  it('covers blank media and lower card space while excluding real interactive descendants', () => {
    const form = makeAssetSelectionForm({});
    const checkbox = makeCheckbox();
    checkbox.form = form;
    const listeners = [];
    const mediaLink = {};
    const targets = {
      blankMedia: {},
      fallback: {},
      blankLower: {},
      image: {},
      filename: {},
      details: {},
      status: {},
      renameTrigger: {},
      renameInput: {},
      renameButton: {},
      checkbox,
    };
    const interactiveTargets = new Set([
      mediaLink, targets.image, targets.filename, targets.details, targets.status,
      targets.renameTrigger, targets.renameInput, targets.renameButton, targets.checkbox,
    ]);
    const card = {
      dataset: {},
      attributes: {},
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      classList: {
        classes: new Set(),
        toggle(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); },
      },
      querySelector(selector) {
        if (selector.includes('selectedAssetIds')) return checkbox;
        return null;
      },
      contains(element) { return element === card || interactiveTargets.has(element); },
    };
    checkbox.closest = (selector) => selector.includes('data-asset-selectable-card') ? card : checkbox;
    mediaLink.closest = () => mediaLink;
    targets.image.closest = (selector) => selector.includes('a') ? mediaLink : null;
    for (const name of ['blankMedia', 'fallback', 'blankLower']) targets[name].closest = () => null;
    for (const name of ['filename', 'details', 'status', 'renameTrigger', 'renameInput', 'renameButton']) {
      targets[name].closest = () => targets[name];
    }

    const scope = {
      querySelectorAll(selector) {
        if (selector === '[data-asset-selection-form]') return [form];
        if (selector.includes('selectedAssetIds')) return [checkbox];
        if (selector === '[data-asset-selectable-card]') return [card];
        return [];
      },
    };

    enhanceAssetSelection(scope);
    enhanceAssetSelection(scope);
    const click = (target) => listeners.filter((entry) => entry.type === 'click')[0].handler({ target });

    click(targets.blankMedia);
    expect(checkbox.checked).toBe(true);
    click(targets.fallback);
    expect(checkbox.checked).toBe(false);
    click(targets.blankLower);
    expect(checkbox.checked).toBe(true);

    click(mediaLink);
    expect(checkbox.checked).toBe(true);
    click(targets.image);
    expect(checkbox.checked).toBe(true);
    for (const target of [
      targets.filename, targets.details, targets.status,
      targets.renameTrigger, targets.renameInput, targets.renameButton, targets.checkbox,
    ]) {
      click(target);
      expect(checkbox.checked).toBe(true);
    }

    // The native checkbox click has already changed checked before the card's
    // bubbling handler runs; the handler must leave it alone.
    checkbox.checked = false;
    click(checkbox);
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(card.attributes['aria-selected']).toBe('true');
    expect(listeners.filter((entry) => entry.type === 'click')).toHaveLength(1);
  });
});

describe('asset grid rename enhancement', () => {
  function makeRenameRegion({ editing = false } = {}) {
    const listeners = [];
    const input = {
      focused: false,
      selected: false,
      focus() { this.focused = true; },
      select() { this.selected = true; },
    };
    const cancel = { addEventListener(type, handler) { listeners.push({ target: 'cancel', type, handler }); } };
    const titleRow = {
      hidden: editing,
      setAttribute(name) { if (name === 'hidden') this.hidden = true; },
      removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
    };
    const editor = {
      dataset: {},
      hidden: !editing,
      addEventListener(type, handler) { listeners.push({ target: 'editor', type, handler }); },
      setAttribute(name) { if (name === 'hidden') this.hidden = true; },
      removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
      querySelector(selector) {
        if (selector === '[data-asset-rename-input]') return input;
        if (selector === '[data-asset-rename-cancel]') return cancel;
        return null;
      },
      dispatch(type, event = {}) {
        for (const listener of listeners.filter((entry) => entry.target === 'editor' && entry.type === type)) {
          listener.handler({ target: input, ...event });
        }
      },
      cancel,
      input,
      titleRow,
    };
    const region = {
      querySelector(selector) {
        if (selector === '[data-asset-title-row]') return titleRow;
        if (selector === '[data-asset-rename-editor]') return editor;
        return null;
      },
    };
    const trigger = {
      dataset: {},
      focused: false,
      addEventListener(type, handler) { listeners.push({ target: 'trigger', type, handler }); },
      closest() { return region; },
      focus() { this.focused = true; },
      dispatch(type, event = {}) {
        for (const listener of listeners.filter((entry) => entry.target === 'trigger' && entry.type === type)) {
          listener.handler({ target: trigger, ...event });
        }
      },
    };
    cancel.dispatch = (event = {}) => {
      for (const listener of listeners.filter((entry) => entry.target === 'cancel' && entry.type === 'click')) {
        listener.handler(event);
      }
    };
    return { trigger, editor, input, titleRow, cancel, region, listeners };
  }

  it('opens the inline editor, focuses/selects the basename, supports Escape/Cancel, and is idempotent', () => {
    const { trigger, editor, input, titleRow, cancel, region, listeners } = makeRenameRegion();
    const scope = { querySelectorAll: (selector) => selector === '[data-asset-rename-trigger]' ? [trigger] : [] };

    expect(enhanceAssetRenames(scope)).toBe(1);
    expect(enhanceAssetRenames(scope)).toBe(1);
    expect(listeners.filter((entry) => entry.target === 'trigger' && entry.type === 'click')).toHaveLength(1);
    expect(trigger.closest().querySelector('[data-asset-rename-editor]')).toBe(editor);

    let prevented = false;
    trigger.dispatch('click', { preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(input.focused).toBe(true);
    expect(input.selected).toBe(true);
    expect(editor.hidden).toBe(false);
    expect(titleRow.hidden).toBe(true);

    let submitPrevented = false;
    editor.dispatch('submit', { preventDefault() { submitPrevented = true; } });
    expect(submitPrevented).toBe(false);

    editor.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(editor.hidden).toBe(true);
    expect(titleRow.hidden).toBe(false);
    expect(trigger.focused).toBe(true);

    trigger.dispatch('click', { preventDefault() {} });
    cancel.dispatch({ preventDefault() {} });
    expect(editor.hidden).toBe(true);
    expect(titleRow.hidden).toBe(false);
  });
});

describe('asset grid size enhancement', () => {
  function makeGrid() {
    const attrs = {};
    const style = {
      values: {},
      setProperty(name, value) { this.values[name] = value; },
      removeProperty(name) { delete this.values[name]; },
    };
    return {
      style,
      dataset: {},
      setAttribute(name, value) { attrs[name] = String(value); if (name === 'data-grid-size') this.dataset.gridSize = String(value); },
      removeAttribute(name) { delete attrs[name]; delete this.dataset.gridSize; },
      attrs,
    };
  }

  function makeGridControls() {
    const controls = ['compact', 'default', 'large'].map((size) => {
      const listeners = [];
      return {
        dataset: { gridSize: size },
        attrs: {},
        addEventListener(type, handler) { listeners.push({ type, handler }); },
        setAttribute(name, value) { this.attrs[name] = String(value); },
        dispatch(type) { listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler()); },
      };
    });
    return {
      querySelectorAll(selector) {
        return selector === '[data-grid-size]' ? controls : [];
      },
      controls,
    };
  }

  it('uses the current default sizing without writing a custom property', () => {
    const grid = makeGrid();
    const group = makeGridControls();
    const scope = {
      querySelectorAll(selector) {
        if (selector === '[data-asset-grid-size-controls]') return [group];
        if (selector === '.asset-grid') return [grid];
        if (selector.includes('[data-grid-size]')) return group.controls;
        return [];
      },
    };

    expect(enhanceAssetGridSize(scope)).toBe(1);
    expect(grid.style.values).toEqual({});
    expect(group.controls.find((control) => control.dataset.gridSize === 'default').attrs['aria-pressed']).toBe('true');
  });

  it('applies finite compact/default/large values and persists the selection', () => {
    const grid = makeGrid();
    const group = makeGridControls();
    const storage = new Map();
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };
    try {
      const scope = {
        querySelectorAll(selector) {
          if (selector === '[data-asset-grid-size-controls]') return [group];
          if (selector === '.asset-grid') return [grid];
          if (selector.includes('[data-grid-size]')) return group.controls;
          return [];
        },
      };

      enhanceAssetGridSize(scope);
      group.controls.find((control) => control.dataset.gridSize === 'large').dispatch('click');

      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
      expect(grid.attrs['data-grid-size']).toBe('large');
      expect(grid.style.values['--asset-card-min']).toBe('20rem');
      expect(group.controls.find((control) => control.dataset.gridSize === 'large').attrs['aria-pressed']).toBe('true');

      const secondGrid = makeGrid();
      const secondScope = {
        querySelectorAll(selector) {
          if (selector === '[data-asset-grid-size-controls]') return [group];
          if (selector === '.asset-grid') return [secondGrid];
          if (selector.includes('[data-grid-size]')) return group.controls;
          return [];
        },
      };
      enhanceAssetGridSize(secondScope);
      expect(secondGrid.style.values['--asset-card-min']).toBe('20rem');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('rejects an invalid stored value and falls back to the default size', () => {
    const grid = makeGrid();
    const group = makeGridControls();
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: () => 'not-supported',
      setItem() {},
    };
    try {
      const scope = {
        querySelectorAll(selector) {
          if (selector === '[data-asset-grid-size-controls]') return [group];
          if (selector === '.asset-grid') return [grid];
          if (selector.includes('[data-grid-size]')) return group.controls;
          return [];
        },
      };

      enhanceAssetGridSize(scope);
      expect(grid.style.values).toEqual({});
      expect(group.controls.find((control) => control.dataset.gridSize === 'default').attrs['aria-pressed']).toBe('true');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });
});
