import { describe, expect, it } from 'vitest';
import { syncProjectAssetCategoryConsumers } from '../src/static/client/project-asset-category-sync.js';

function option(value, label, disabled = false) {
  return { value, textContent: label, disabled, cloneNode() { return option(value, label, disabled); } };
}

function select(id, options, value) {
  return {
    id,
    options,
    value,
    nextElementSibling: null,
    replaceChildren(...next) { this.options = next; },
    closest() { return this.root; },
  };
}

function fallback(text = '', hidden = true) {
  const content = (value) => ({ textContent: value, cloneNode() { return content(value); } });
  return {
    id: 'manager-default-fallback',
    hidden,
    childNodes: [content(text)],
    replaceChildren(...next) { this.childNodes = next; },
  };
}

function page(scopes, output, defaultSelect, fallbackNotice = null) {
  const controls = new Map([...scopes, output, defaultSelect, fallbackNotice].filter(Boolean).map((item) => [item.id, item]));
  return { getElementById: (id) => controls.get(id) || null };
}

function fixture() {
  const scopes = ['convert', 'workflow', 'watermark', 'archive'].map((name) => {
    const control = select(`${name}-category`, [option('', 'Select a category'), option('1', 'Alpha'), option('2', 'Beta (disabled)')], '1');
    const category = { checked: true };
    const project = { checked: false };
    control.root = {
      querySelector: (query) => query.includes('="category"') ? category : project,
      __ccProcessingJob: null,
      __ccProcessingBusy: false,
    };
    return { control, category, project };
  });
  const output = select('watermark-output', [option('', 'Choose an output category'), option('alpha', 'Alpha')], 'alpha');
  const defaultSelect = select('manager-default', [option('all', 'All Categories'), option('1', 'Alpha')], '1');
  const fallbackNotice = fallback();
  const assetBrowserDefault = { confirmedValue: '1', pending: false };
  const manager = {
    querySelector: (query) => query === '[data-asset-browser-default-fallback]' ? fallbackNotice : defaultSelect,
    __creatorCrateAppDialogState: { assetBrowserDefault },
  };
  const document = {
    querySelectorAll: () => scopes.map(({ control }) => control),
    querySelector: () => output,
    getElementById: () => manager,
  };
  return { scopes, output, defaultSelect, fallbackNotice, assetBrowserDefault, document };
}

describe('Project Assets category consumers', () => {
  it('reconciles all four processing scopes from rendered IDs, labels, disabled state, and order', () => {
    const state = fixture();
    const render = (options) => page(state.scopes.map(({ control }) => select(control.id, options, '')), null, null);
    syncProjectAssetCategoryConsumers(state.document, render([
      option('', 'Select a category'), option('3', 'New'), option('1', 'Renamed'), option('2', 'Beta (disabled)'),
    ]));
    for (const { control } of state.scopes) {
      expect(control.options.map(({ value, textContent }) => [value, textContent])).toEqual([
        ['', 'Select a category'], ['3', 'New'], ['1', 'Renamed'], ['2', 'Beta (disabled)'],
      ]);
      expect(control.value).toBe('1');
    }
    state.scopes[0].control.value = '2';
    syncProjectAssetCategoryConsumers(state.document, render([
      option('', 'Select a category'), option('2', 'Beta (disabled)'), option('1', 'Renamed'), option('3', 'New'),
    ]));
    expect(state.scopes[0].control.value).toBe('2');
    syncProjectAssetCategoryConsumers(state.document, render([
      option('', 'Select a category'), option('2', 'Beta'), option('1', 'Renamed'), option('3', 'New'),
    ]));
    expect(state.scopes[0].control.value).toBe('2');
    syncProjectAssetCategoryConsumers(state.document, render([option('', 'Select a category'), option('3', 'New')]));
    for (const { control, project } of state.scopes) {
      expect(control.options.map(({ value }) => value)).toEqual(['', '3']);
      expect(project.checked).toBe(true);
    }
  });

  it('keeps Watermark output slug-valued and enabled-only, preserving valid selection', () => {
    const state = fixture();
    const render = (options, selected = '') => page([], select(state.output.id, options, selected), null);
    syncProjectAssetCategoryConsumers(state.document, render([
      option('', 'Choose an output category'), option('alpha', 'Renamed'), option('new-slug', 'New'),
    ]));
    expect(state.output.value).toBe('alpha');
    expect(state.output.options.map(({ value }) => value)).toEqual(['', 'alpha', 'new-slug']);
    syncProjectAssetCategoryConsumers(state.document, render([option('', 'Choose an output category'), option('new-slug', 'New')]));
    expect(state.output.value).toBe('');
    syncProjectAssetCategoryConsumers(state.document, render([
      option('', 'Choose an output category'), option('new-slug', 'New'), option('alpha', 'Renamed'),
    ]));
    expect(state.output.options.map(({ value }) => value)).toEqual(['', 'new-slug', 'alpha']);
  });

  it('uses the rendered manager default after enable, disable, and reorder', () => {
    const state = fixture();
    const render = (options, selected) => page([], null, select(state.defaultSelect.id, options, selected));
    syncProjectAssetCategoryConsumers(state.document, render([
      option('all', 'All Categories'), option('2', 'Beta'), option('1', 'Alpha'),
    ], '2'));
    expect(state.defaultSelect.options.map(({ value }) => value)).toEqual(['all', '2', '1']);
    expect(state.defaultSelect.value).toBe('2');
    expect(state.assetBrowserDefault.confirmedValue).toBe('2');
    syncProjectAssetCategoryConsumers(state.document, render([
      option('all', 'All Categories'), option('1', 'Alpha'),
    ], 'all'));
    expect(state.defaultSelect.options.map(({ value }) => value)).toEqual(['all', '1']);
    expect(state.defaultSelect.value).toBe('all');
  });

  it('shows the server-rendered fallback alongside the confirmed default selection', () => {
    const state = fixture();
    const renderedFallback = fallback('The saved category is disabled. Showing All Categories.', false);
    const rendered = page([], null,
      select(state.defaultSelect.id, [option('all', 'All Categories'), option('1', 'Alpha (disabled)', true)], 'all'),
      renderedFallback);

    syncProjectAssetCategoryConsumers(state.document, rendered);

    expect(state.defaultSelect.value).toBe('all');
    expect(state.assetBrowserDefault.confirmedValue).toBe('all');
    expect(state.fallbackNotice.hidden).toBe(false);
    expect(state.fallbackNotice.childNodes[0].textContent).toBe(renderedFallback.childNodes[0].textContent);
    expect(state.fallbackNotice.childNodes[0]).not.toBe(renderedFallback.childNodes[0]);
  });

  it('removes a stale fallback when the refreshed server document no longer shows one', () => {
    const state = fixture();
    state.fallbackNotice.hidden = false;
    state.fallbackNotice.childNodes[0].textContent = 'The saved category is disabled.';
    const rendered = page([], null,
      select(state.defaultSelect.id, [option('all', 'All Categories'), option('1', 'Alpha')], '1'),
      fallback('', true));

    syncProjectAssetCategoryConsumers(state.document, rendered);

    expect(state.defaultSelect.value).toBe('1');
    expect(state.fallbackNotice.hidden).toBe(true);
    expect(state.fallbackNotice.childNodes[0].textContent).toBe('');
  });

  it('does not change processing job state while synchronizing choices', () => {
    const state = fixture();
    const job = { id: 17, state: 'running' };
    state.scopes[0].control.root.__ccProcessingJob = job;
    const rendered = page([select(state.scopes[0].control.id, [option('', 'Select a category')], '')], null, null);
    syncProjectAssetCategoryConsumers(state.document, rendered);
    expect(state.scopes[0].control.root.__ccProcessingJob).toBe(job);
    expect(state.scopes[0].category.checked).toBe(true);
  });
});
