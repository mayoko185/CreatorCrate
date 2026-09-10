import { describe, expect, it } from 'vitest';
import { normalizeProjectOptionColor } from '../src/static/client/project-option-color-picker.js';

describe('Project option picker color normalization', () => {
  it.each(['#a1b2c3', 'a1b2c3', '  #A1b2C3  '])('normalizes %s', input => {
    expect(normalizeProjectOptionColor(input)).toBe('#A1B2C3');
  });
  it.each(['', '#abc', '#12345678', 'red', '#12345G', '#123456; color:red', null, undefined])('rejects %s', input => {
    expect(normalizeProjectOptionColor(input)).toBeNull();
  });
});
