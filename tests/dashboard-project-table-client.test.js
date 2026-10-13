import { describe, expect, it } from 'vitest';
import { enhanceDashboardProjectTable } from '../src/static/client/dashboard.js';

function element(attributes = {}, { textContent = '' } = {}) {
  const attrs = new Map(Object.entries(attributes));
  const listeners = new Map();
  return {
    dataset: {},
    disabled: attrs.has('disabled'),
    textContent,
    children: [],
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type, event) { listeners.get(type)?.(event); },
    contains(node) { return node === this || this.children.includes(node); },
    closest(selector) { return selector === '[data-dashboard-status-filter]' && attrs.has('data-dashboard-status-filter') ? this : null; },
  };
}

function dashboard({ tabs, rowStatuses, complete = true }) {
  const buttons = tabs.map((value) => element({
    'data-dashboard-status-filter': value,
    'aria-pressed': value === 'all' ? 'true' : 'false',
    disabled: '',
  }));
  const group = element({ 'data-dashboard-status-filters': '' });
  group.children = buttons;
  group.querySelectorAll = () => buttons;
  const rows = rowStatuses.map((status, index) => element({ 'data-status': status, 'data-project-id': String(index + 1) }));
  const table = element({ 'data-complete': complete ? 'true' : 'false' });
  table.querySelectorAll = () => rows;
  const region = element();
  const empty = element({ hidden: '' });
  const total = rowStatuses.length;
  const count = element({}, { textContent: `${total} of ${total} active projects · archived hidden` });
  const parts = {
    '[data-dashboard-status-filters]': group,
    '[data-dashboard-projects-table]': table,
    '[data-dashboard-projects-count]': count,
    '[data-dashboard-projects-filter-empty]': empty,
    '[data-dashboard-projects-table-region]': region,
  };
  const section = element();
  section.querySelector = (selector) => parts[selector] || null;
  const root = { querySelectorAll: (selector) => (selector === '[data-dashboard-projects]' ? [section] : []) };
  const click = (value) => {
    const button = buttons.find((candidate) => candidate.getAttribute('data-dashboard-status-filter') === value);
    group.dispatch('click', { target: button });
  };
  const pressed = () => buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('data-dashboard-status-filter'));
  const visibleIds = () => rows.filter((row) => !row.hasAttribute('hidden')).map((row) => row.getAttribute('data-project-id'));
  return { root, group, buttons, rows, region, empty, count, click, pressed, visibleIds };
}

describe('enhanceDashboardProjectTable', () => {
  it('enables the status buttons with All selected and every row visible', () => {
    const view = dashboard({ tabs: ['all', 'planning', 'in_progress'], rowStatuses: ['planning', 'in_progress', 'planning'] });
    enhanceDashboardProjectTable(view.root);

    expect(view.buttons.every((button) => button.disabled === false)).toBe(true);
    expect(view.pressed()).toEqual(['all']);
    expect(view.visibleIds()).toEqual(['1', '2', '3']);
    expect(view.count.textContent).toBe('3 of 3 active projects · archived hidden');
    expect(view.empty.hasAttribute('hidden')).toBe(true);
  });

  it('filters rows by the selected catalogue status and restores them with All', () => {
    const view = dashboard({ tabs: ['all', 'planning', 'custom_review'], rowStatuses: ['planning', 'custom_review', 'planning'] });
    enhanceDashboardProjectTable(view.root);

    view.click('custom_review');
    expect(view.pressed()).toEqual(['custom_review']);
    expect(view.visibleIds()).toEqual(['2']);
    expect(view.count.textContent).toBe('1 of 3 active projects · archived hidden');

    view.click('planning');
    expect(view.pressed()).toEqual(['planning']);
    expect(view.visibleIds()).toEqual(['1', '3']);
    expect(view.count.textContent).toBe('2 of 3 active projects · archived hidden');

    view.click('all');
    expect(view.pressed()).toEqual(['all']);
    expect(view.visibleIds()).toEqual(['1', '2', '3']);
    expect(view.count.textContent).toBe('3 of 3 active projects · archived hidden');
  });

  it('shows the empty message for a zero-match status and keeps the filters usable', () => {
    const view = dashboard({ tabs: ['all', 'planning', 'complete'], rowStatuses: ['planning', 'planning'] });
    enhanceDashboardProjectTable(view.root);

    view.click('complete');
    expect(view.visibleIds()).toEqual([]);
    expect(view.region.hasAttribute('hidden')).toBe(true);
    expect(view.empty.hasAttribute('hidden')).toBe(false);
    expect(view.count.textContent).toBe('0 of 2 active projects · archived hidden');
    expect(view.buttons.every((button) => button.disabled === false)).toBe(true);

    view.click('all');
    expect(view.region.hasAttribute('hidden')).toBe(false);
    expect(view.empty.hasAttribute('hidden')).toBe(true);
    expect(view.visibleIds()).toEqual(['1', '2']);
  });

  it('restores an explicit valid selection and falls back to All otherwise', () => {
    const restored = dashboard({ tabs: ['all', 'planning', 'in_progress'], rowStatuses: ['planning', 'in_progress'] });
    enhanceDashboardProjectTable(restored.root, { initialStatus: 'in_progress' });
    expect(restored.pressed()).toEqual(['in_progress']);
    expect(restored.visibleIds()).toEqual(['2']);

    const unknown = dashboard({ tabs: ['all', 'planning'], rowStatuses: ['planning'] });
    enhanceDashboardProjectTable(unknown.root, { initialStatus: 'archived' });
    expect(unknown.pressed()).toEqual(['all']);
    expect(unknown.visibleIds()).toEqual(['1']);
  });

  it('uses singular wording when one active project exists', () => {
    const view = dashboard({ tabs: ['all', 'planning', 'complete'], rowStatuses: ['planning'] });
    enhanceDashboardProjectTable(view.root);
    view.click('complete');
    expect(view.count.textContent).toBe('0 of 1 active project · archived hidden');
  });

  it('leaves an incomplete table untouched', () => {
    const view = dashboard({ tabs: ['all', 'planning'], rowStatuses: ['planning'], complete: false });
    expect(enhanceDashboardProjectTable(view.root)).toEqual([]);
    expect(view.buttons.every((button) => button.disabled === true)).toBe(true);
    expect(view.count.textContent).toBe('1 of 1 active projects · archived hidden');
  });

  it('is idempotent', () => {
    const view = dashboard({ tabs: ['all', 'planning'], rowStatuses: ['planning'] });
    expect(enhanceDashboardProjectTable(view.root)).toHaveLength(1);
    expect(enhanceDashboardProjectTable(view.root)).toEqual([]);
  });

  it('ignores clicks outside a status button', () => {
    const view = dashboard({ tabs: ['all', 'planning'], rowStatuses: ['planning', 'other'] });
    enhanceDashboardProjectTable(view.root);
    view.group.dispatch('click', { target: { closest: () => null } });
    expect(view.pressed()).toEqual(['all']);
    expect(view.visibleIds()).toEqual(['1', '2']);
  });
});
