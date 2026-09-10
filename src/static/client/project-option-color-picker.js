import { enhanceViewportDisclosures, updateAssetViewerFilterDisclosureState } from './dropdowns.js';

const CONTROL = '[data-project-option-color-control]';
const PALETTE = [
  '#64748B', '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6',
  '#0EA5E9', '#3B82F6', '#8B5CF6', '#D946EF', '#EC4899', '#FFFFFF',
  '#AAAAAA', '#22D3EE', '#34D399', '#A78BFA', '#9CA3AF', '#FF8A94',
];

export function normalizeProjectOptionColor(value) {
  const text = String(value ?? '').trim();
  return /^#?[0-9a-f]{6}$/i.test(text) ? `#${text.replace(/^#/, '').toUpperCase()}` : null;
}

// Replacement callers may pass one region (or control); listeners bind once per node.
export function enhanceProjectOptionColorPickers(scope = globalThis.document) {
  const controls = [...(scope?.querySelectorAll?.(CONTROL) || [])];
  if (scope?.matches?.(CONTROL)) controls.unshift(scope);
  let count = 0;
  for (const control of controls) {
    if (control.dataset.projectOptionColorBound) continue;
    const value = control.querySelector('[data-project-option-color-value]');
    const button = control.querySelector('[data-project-option-color-trigger]');
    const initial = normalizeProjectOptionColor(value?.value);
    if (!initial || !button) continue;
    const document = control.ownerDocument;
    const disclosure = document.createElement('details');
    disclosure.setAttribute('data-cc-viewport-disclosure', '');
    const trigger = document.createElement('summary');
    for (const attribute of button.attributes) trigger.setAttribute(attribute.name, attribute.value);
    trigger.removeAttribute('type');
    trigger.removeAttribute('aria-haspopup');
    trigger.setAttribute('role', 'button');
    trigger.append(...button.childNodes);
    button.replaceWith(disclosure);
    disclosure.append(trigger);
    const panel = document.createElement('div');
    panel.className = 'asset-filter-multiselect-panel project-option-color-panel';
    panel.id = `${trigger.id}-picker`;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', trigger.getAttribute('aria-label'));
    trigger.setAttribute('aria-controls', panel.id);
    const palette = document.createElement('div');
    palette.className = 'project-option-color-palette';
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `${trigger.id}-hex`;
    label.textContent = 'Hex color';
    const hex = document.createElement('input');
    hex.id = `${trigger.id}-hex`;
    hex.type = 'text';
    hex.setAttribute('autocomplete', 'off');
    hex.setAttribute('spellcheck', 'false');
    hex.setAttribute('aria-describedby', `${trigger.id}-error`);
    const error = document.createElement('p');
    error.id = `${trigger.id}-error`;
    error.className = 'field-error-message';
    error.setAttribute('role', 'status');
    error.hidden = true;
    const preview = document.createElement('p');
    preview.className = 'help-text';
    preview.setAttribute('data-color-preview', '');
    preview.setAttribute('aria-live', 'polite');
    field.append(label, hex, error);
    panel.append(palette, field, preview);
    disclosure.append(panel);
    const feedback = (invalid) => {
      hex.setAttribute('aria-invalid', String(invalid));
      hex.closest('.field').classList.toggle('field-error', invalid);
      error.hidden = !invalid;
      error.textContent = invalid ? 'Enter six hexadecimal digits, for example #3B82F6.' : '';
    };
    const select = (color, emit = true) => {
      const previousColor = value.value;
      value.value = color;
      control.dataset.projectOptionPendingColor = color;
      hex.value = color;
      trigger.querySelector('.project-option-color-swatch').style.setProperty('--project-option-color', color);
      trigger.querySelector('.project-option-color-code').textContent = color;
      panel.querySelector('[data-color-preview]').textContent = `Selected color: ${color}`;
      palette.querySelectorAll('button').forEach(swatch => swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color)));
      feedback(false);
      if (emit && previousColor !== color) {
        control.dispatchEvent(new document.defaultView.CustomEvent('project-option-color-change', {
          bubbles: true, detail: { color, previousColor },
        }));
      }
      if (disclosure.open) updateAssetViewerFilterDisclosureState(disclosure);
    };
    for (const color of PALETTE) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'project-option-color-choice';
      swatch.dataset.color = color;
      swatch.style.setProperty('--project-option-color', color);
      swatch.setAttribute('aria-label', `Select ${color}`);
      swatch.addEventListener('click', () => select(color));
      palette.append(swatch);
    }
    const applyHex = () => {
      const color = normalizeProjectOptionColor(hex.value);
      if (color) select(color);
      else { feedback(true); updateAssetViewerFilterDisclosureState(disclosure); }
    };
    hex.addEventListener('change', applyHex);
    hex.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); applyHex(); }
    });
    disclosure.addEventListener('toggle', () => {
      if (disclosure.open) select(normalizeProjectOptionColor(value.value) || control.dataset.projectOptionPendingColor, false);
    });
    select(initial, false);
    control.dataset.projectOptionColorBound = 'true';
    count += 1;
  }
  if (controls.length) enhanceViewportDisclosures(scope.ownerDocument || scope);
  return count;
}
