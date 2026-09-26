import { describe, expect, it } from 'vitest';
import { enhanceProjectImageSettings } from '../src/static/client/project-image-settings.js';

function makeGroup(value, conditions) {
  const listeners = new Map();
  const format = {
    value,
    dataset: {},
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const fields = conditions.map((condition) => {
    const input = { value: condition === 'webp' ? '73' : '1440', disabled: false };
    return {
      hidden: false,
      input,
      getAttribute: () => condition,
      querySelectorAll: () => [input],
    };
  });
  const row = conditions.includes('generated') ? { hidden: false } : null;
  const layout = conditions.includes('generated') ? null : {
    attributes: { 'data-project-image-layout': value },
    setAttribute(name, next) { this.attributes[name] = next; },
  };
  const group = {
    querySelector: (selector) => {
      if (selector === '[data-project-image-fields-row]') return row;
      if (selector === '[data-project-image-layout]') return layout;
      return format;
    },
    querySelectorAll: () => fields,
  };
  return { group, format, fields, row, layout, change: (next) => { format.value = next; listeners.get('change')(); } };
}

describe('project image settings controls', () => {
  it('toggles only the dependent fields and retains their values', () => {
    const thumbnail = makeGroup('webp', ['webp']);
    const preview = makeGroup('webp', ['webp', 'generated']);
    const scope = { querySelectorAll: () => [thumbnail.group, preview.group] };
    expect(enhanceProjectImageSettings(scope)).toBe(2);
    expect(enhanceProjectImageSettings(scope)).toBe(0);

    thumbnail.change('png');
    expect(thumbnail.fields[0].hidden).toBe(true);
    expect(thumbnail.fields[0].input.disabled).toBe(true);
    preview.change('png');
    expect(preview.fields.map((field) => field.hidden)).toEqual([true, false]);
    expect(preview.row.hidden).toBe(false);
    preview.change('original');
    expect(preview.fields.map((field) => field.hidden)).toEqual([true, true]);
    expect(preview.row.hidden).toBe(true);
    expect(preview.fields.map((field) => field.input.disabled)).toEqual([true, true]);
    preview.change('webp');
    thumbnail.change('webp');
    expect(preview.row.hidden).toBe(false);
    expect([...thumbnail.fields, ...preview.fields].map((field) => field.input.value))
      .toEqual(['73', '73', '1440']);
    expect([...thumbnail.fields, ...preview.fields].every((field) => !field.hidden && !field.input.disabled))
      .toBe(true);
  });

  it('pairs thumbnail Format with Maximum dimension for PNG and restores the WebP layout', () => {
    const thumbnail = makeGroup('webp', ['webp']);
    enhanceProjectImageSettings({ querySelectorAll: () => [thumbnail.group] });
    expect(thumbnail.layout.attributes['data-project-image-layout']).toBe('webp');

    thumbnail.change('png');
    expect(thumbnail.layout.attributes['data-project-image-layout']).toBe('png');
    expect(thumbnail.fields[0].hidden).toBe(true);

    thumbnail.change('webp');
    expect(thumbnail.layout.attributes['data-project-image-layout']).toBe('webp');
    expect(thumbnail.fields[0].hidden).toBe(false);
    expect(thumbnail.fields[0].input.value).toBe('73');
  });
});
