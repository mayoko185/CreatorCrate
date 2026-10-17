import { describe, it, expect, afterEach } from 'vitest';
import {
  ASSET_GRID_STYLE_STORAGE_KEYS,
  enhanceAssetGridStyle,
  readGridStyle,
} from '../src/static/client/size-preferences.js';

// Release Grid style: browser-stored, per-screen, presentation-only.
const previousStorage = globalThis.localStorage;

function useStorage(storage) {
  globalThis.localStorage = storage;
}

function memoryStorage(initial = {}) {
  const values = { ...initial };
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null),
    setItem: (key, value) => { writes.push([key, value]); values[key] = String(value); },
  };
}

// A screen scope holding one rendered grid and one native Grid style select.
function fakeScreen(screen) {
  const grid = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const scope = { querySelectorAll: (selector) => (selector === '.asset-grid' ? [grid] : []) };
  const listeners = [];
  const control = {
    value: 'uncropped',
    dataset: {},
    getAttribute: (name) => (name === 'data-asset-grid-style-control' ? screen : null),
    closest: (selector) => (selector === '.asset-browser-content' ? scope : null),
    addEventListener: (type, listener) => listeners.push([type, listener]),
    change(value) {
      this.value = value;
      listeners.filter(([type]) => type === 'change').forEach(([, listener]) => listener());
    },
  };
  const root = { querySelectorAll: () => [control] };
  return { grid, control, root, listeners };
}

afterEach(() => {
  if (previousStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousStorage;
});

describe('Release Grid style preferences', () => {
  it('uses the approved, separate storage keys', () => {
    expect(ASSET_GRID_STYLE_STORAGE_KEYS).toEqual({
      'release-detail': 'creatorcrate-release-detail-grid-style',
      'release-assets': 'creatorcrate-release-assets-grid-style',
    });
  });

  it('falls back to Uncropped for missing, invalid or unreadable values', () => {
    const key = ASSET_GRID_STYLE_STORAGE_KEYS['release-detail'];
    useStorage(memoryStorage());
    expect(readGridStyle(key)).toBe('uncropped');
    for (const value of ['Cropped', 'stretched', '', 'cropped ']) {
      useStorage(memoryStorage({ [key]: value }));
      expect(readGridStyle(key)).toBe('uncropped');
    }
    useStorage(memoryStorage({ [key]: 'cropped' }));
    expect(readGridStyle(key)).toBe('cropped');
    useStorage({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readGridStyle(key)).toBe('uncropped');
    delete globalThis.localStorage;
    expect(readGridStyle(key)).toBe('uncropped');
  });

  it('restores without writing, binds once and writes only its own key on change', () => {
    const storage = memoryStorage({ 'creatorcrate-release-assets-grid-style': 'cropped' });
    useStorage(storage);
    const { grid, control, root, listeners } = fakeScreen('release-assets');

    expect(enhanceAssetGridStyle(root)).toBe(1);
    expect(enhanceAssetGridStyle(root)).toBe(1);
    expect(grid.attributes['data-grid-style']).toBe('cropped');
    expect(control.value).toBe('cropped');
    expect(listeners).toHaveLength(1);
    expect(storage.writes).toEqual([]);

    control.change('uncropped');
    expect(grid.attributes['data-grid-style']).toBe('uncropped');
    expect(storage.writes).toEqual([['creatorcrate-release-assets-grid-style', 'uncropped']]);
    expect(storage.values['creatorcrate-release-detail-grid-style']).toBeUndefined();

    // An unexpected value never reaches the grid.
    control.change('stretched');
    expect(grid.attributes['data-grid-style']).toBe('uncropped');
    expect(control.value).toBe('uncropped');
  });

  it('keeps working when storage is unavailable and ignores unknown screens', () => {
    useStorage({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    const { grid, control, root } = fakeScreen('release-detail');
    expect(enhanceAssetGridStyle(root)).toBe(1);
    expect(grid.attributes['data-grid-style']).toBe('uncropped');
    expect(() => control.change('cropped')).not.toThrow();
    expect(grid.attributes['data-grid-style']).toBe('cropped');

    const unknown = fakeScreen('project-assets');
    expect(enhanceAssetGridStyle(unknown.root)).toBe(0);
    expect(unknown.grid.attributes).toEqual({});
    expect(unknown.listeners).toHaveLength(0);
  });
});
