import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const STYLESHEET_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
const css = readFileSync(STYLESHEET_PATH, 'utf8');

function renderDropdown(method, config) {
  return env.renderString(
    `{% import "partials/dropdown.njk" as dropdown %}{{ dropdown[method](config) }}`,
    { method, config },
  );
}

function renderEmptyMultiSelect(overrides = {}) {
  return renderDropdown('multiSelect', {
    id: 'empty-filter',
    name: 'item',
    label: 'Item',
    options: [],
    ...overrides,
  });
}

describe('shared dropdown template', () => {
  it('renders the single-select shell, radio semantics, IDs, ARIA links, and selected value', () => {
    const html = renderDropdown('singleSelect', {
      id: 'format-filter',
      name: 'format',
      label: 'Format',
      options: [
        { value: 'png', label: 'PNG' },
        { value: 'kra', label: 'Krita', selected: true },
      ],
      selected: 'kra',
      placeholder: 'All formats',
      panelLabel: 'Format options',
    });

    expect(html).toContain('class="asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown"');
    expect(html).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(html).toContain('id="format-filter-trigger" aria-controls="format-filter-options"');
    expect(html).toContain('aria-label="Format filter: Krita"');
    expect(html).toContain('role="radiogroup" aria-label="Format options"');
    expect(html).toMatch(/name="format" type="radio" value=""[^>]*>/);
    expect(html).toMatch(/name="format" type="radio" value="kra" checked>/);
    expect(html).not.toContain('type="checkbox"');
  });

  it('renders searchable single-selects through the shared shell with configurable keys and search metadata', () => {
    const html = renderDropdown('searchableSingleSelect', {
      id: 'project-filter',
      name: 'project',
      label: 'Project',
      options: [
        { id: '1', title: 'Alpha Project' },
        { id: '2', title: 'Beta Project' },
      ],
      valueKey: 'id',
      labelKey: 'title',
      selected: '2',
      placeholder: 'All projects',
      searchLabel: 'Search projects',
       searchInputId: 'project-filter-search',
      noResultsText: 'No matching projects',
      optionListLabel: 'Project choices',
      inputAttributes: [['data-project-option', true]],
    });

    expect(html).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(html).toContain('data-cc-dropdown-searchable');
    expect(html).toContain('data-cc-dropdown-type="searchable-single"');
    expect(html).toContain('id="project-filter-trigger" aria-controls="project-filter-options"');
    expect(html).toContain('<label class="asset-project-filter-search-label" for="project-filter-search">Search projects</label>');
    expect(html).toMatch(/<input id="project-filter-search" class="asset-project-filter-search" type="search" autocomplete="off" data-cc-dropdown-search aria-controls="project-filter-option-list">/);
    expect(html).not.toMatch(/<input id="project-filter-search"[^>]*\bname=/);
    expect(html).toContain('id="project-filter-option-list" class="asset-project-filter-option-list" data-cc-dropdown-option-list role="radiogroup" aria-label="Project choices"');
    expect(html).toContain('class="asset-filter-multiselect-option asset-project-filter-option"');
    expect(html).toContain('role="status" aria-live="polite" hidden');
    expect(html).toContain('No matching projects');
    expect(html).toMatch(/name="project" type="radio" value=""[^>]*>/);
    expect(html).toMatch(/name="project" type="radio" value="2" checked[^>]*data-project-option/);
    expect(html).toContain('Beta Project');
    expect((html.match(/data-project-option/g) || []).length).toBe(2);
  });

  it('supports searchable single-selects without a placeholder while preserving the shared radio contract', () => {
    const html = renderDropdown('searchableSingleSelect', {
      id: 'format-search',
      name: 'format',
      label: 'Format',
      options: [
        { value: 'png', label: 'PNG' },
        { value: 'kra', label: 'Krita' },
      ],
      selected: 'png',
    });

    expect(html).not.toContain('format-search-option-all');
    expect((html.match(/name="format" type="radio"/g) || []).length).toBe(2);
    expect(html).toContain('data-cc-dropdown-searchable');
    expect(html).toContain('aria-label="Format options"');
  });

  it('renders the same shell in multiple mode with checkbox semantics and selected summary', () => {
    const html = renderDropdown('multiSelect', {
      id: 'tag-filter',
      name: 'tag',
      label: 'Tag',
      options: [
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' },
        { value: 'gamma', label: 'Gamma' },
      ],
      selectedValues: ['alpha', 'beta'],
      emptySummary: 'All tags',
      countLabel: 'tags',
      panelLabel: 'Tag options',
    });

    expect(html).toContain('class="asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown"');
    expect(html).toContain('data-cc-dropdown data-cc-dropdown-mode="multiple"');
    expect(html).toContain('id="tag-filter-trigger" aria-controls="tag-filter-options"');
    expect(html).toContain('aria-label="Tag filter: 2 tags selected"');
    expect(html).toContain('role="group" aria-label="Tag options"');
    expect((html.match(/name="tag" type="checkbox"/g) || []).length).toBe(3);
    expect((html.match(/name="tag" type="checkbox" value="(?:alpha|beta)" checked/g) || []).length).toBe(2);
    expect(html).not.toContain('type="radio"');
  });

  it('preserves plain emptyOptionText output for empty multi-selects', () => {
    const html = renderEmptyMultiSelect({ emptyOptionText: 'No options available.' });

    expect(html).toContain('<p class="asset-filter-multiselect-empty">No options available.</p>');
  });

  it('renders a structured empty state with natural text, link, and suffix spacing', () => {
    const html = renderEmptyMultiSelect({
      emptyState: {
        text: 'No tags available.',
        link: { text: 'Add tags in Settings', href: '/settings/tags' },
        suffix: '.',
      },
    });

    expect(html).toContain(
      '<p class="asset-filter-multiselect-empty">No tags available. <a href="/settings/tags">Add tags in Settings</a>.</p>',
    );
  });

  it('escapes structured link text', () => {
    const html = renderEmptyMultiSelect({
      emptyState: {
        text: 'No tags available.',
        link: { text: '<b>Tags & "more"</b>', href: '/settings/tags' },
      },
    });

    expect(html).toContain(
      '<a href="/settings/tags">&lt;b&gt;Tags &amp; &quot;more&quot;&lt;/b&gt;</a>',
    );
  });

  it('escapes structured link hrefs', () => {
    const html = renderEmptyMultiSelect({
      emptyState: {
        text: 'No tags available.',
        link: { text: 'Add tags', href: '"/settings?kind=tag&next=<script>' },
      },
    });

    expect(html).toContain(
      'href="&quot;/settings?kind=tag&amp;next=&lt;script&gt;"',
    );
  });

  it('escapes structured leading and suffix text', () => {
    const html = renderEmptyMultiSelect({
      emptyState: {
        text: '<script>alert("x")</script> &',
        link: { text: 'Add tags', href: '/settings/tags' },
        suffix: '<b>now</b> &',
      },
    });

    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;');
    expect(html).toContain('&lt;b&gt;now&lt;/b&gt; &amp;');
  });

  it('does not pass raw structured empty-state HTML through', () => {
    const html = renderEmptyMultiSelect({
      emptyState: {
        text: '<script>alert(1)</script>',
        link: { text: '<b>Click</b>', href: '"><script>alert(2)</script>' },
        suffix: '<img src=x onerror=alert(3)>',
      },
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<img');
  });

  it('gives emptyState precedence over emptyOptionText', () => {
    const html = renderEmptyMultiSelect({
      emptyOptionText: 'Legacy empty text',
      emptyState: {
        text: 'No projects available.',
        link: { text: 'Create a project', href: '/projects/new' },
        suffix: '.',
      },
    });

    expect(html).toContain('No projects available. <a href="/projects/new">Create a project</a>.');
    expect(html).not.toContain('Legacy empty text');
  });

  it('does not render an empty-state paragraph when options exist', () => {
    const html = renderEmptyMultiSelect({
      options: [{ value: 'existing', label: 'Existing option' }],
      emptyState: {
        text: 'No options available.',
        link: { text: 'Create an option', href: '/options/new' },
        suffix: '.',
      },
    });

    expect(html).not.toContain('class="asset-filter-multiselect-empty"');
    expect(html).toContain('Existing option');
  });

  it('renders no empty paragraph for a multi-select with neither empty config', () => {
    const html = renderEmptyMultiSelect();

    expect(html).not.toContain('class="asset-filter-multiselect-empty"');
  });

  it('does not render structured empty state for single-selects', () => {
    const html = renderDropdown('singleSelect', {
      id: 'project-filter',
      name: 'project',
      label: 'Project',
      options: [],
      emptyState: {
        text: 'No projects available.',
        link: { text: 'Create a project', href: '/projects/new' },
        suffix: '.',
      },
    });

    expect(html).not.toContain('No projects available.');
    expect(html).not.toContain('href="/projects/new"');
  });

  it('does not render structured empty state for searchable single-selects', () => {
    const html = renderDropdown('searchableSingleSelect', {
      id: 'project-filter',
      name: 'project',
      label: 'Project',
      options: [],
      emptyState: {
        text: 'No projects available.',
        link: { text: 'Create a project', href: '/projects/new' },
        suffix: '.',
      },
    });

    expect(html).not.toContain('No projects available.');
    expect(html).not.toContain('href="/projects/new"');
    expect(html).toContain('No matching options');
  });

  it('renders an optional native-select source while keeping the enhanced shell available', () => {
    const html = renderDropdown('singleSelect', {
      id: 'action-select',
      name: 'action',
      label: 'Action',
      options: [{ value: 'one', label: 'One' }],
      selected: 'one',
      placeholder: 'Choose an action',
      nativeSelect: true,
    });

    expect(html).toContain('data-cc-dropdown-native-select');
    expect(html).toContain('name="action"');
    expect(html).toContain('<details class="asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown"');
    expect(html).toContain('data-cc-dropdown-mode="single"');
    expect(html).not.toMatch(/<input id="action-select-option-one" name="action"/);
  });

  it('supports generic field and option attributes with option-level selection and suffixes', () => {
    const html = renderDropdown('singleSelect', {
      id: 'category-filter',
      name: 'category',
      label: 'Category',
      fieldAttributes: [['data-category-filter', true]],
      options: [
        {
          id: 'category-option-all',
          value: 'all',
          label: 'All categories',
          attributes: [['data-category-presence', 'all']],
          selected: false,
        },
        {
          id: 'category-option-missing',
          value: 'all',
          label: 'Missing',
          attributes: [['data-category-presence', 'missing']],
          selected: true,
          suffix: '(special)',
          suffixClass: 'category-marker',
        },
      ],
      panelLabel: 'Category options',
    });

    expect(html).toContain('<fieldset class="field asset-filter-multiselect-field" data-category-filter>');
    expect(html).toContain('data-category-presence="missing"');
    expect(html).toMatch(/id="category-option-missing"[^>]*checked/);
    expect(html).not.toMatch(/id="category-option-all"[^>]*checked/);
    expect(html).toContain('Missing <em class="category-marker">(special)</em>');
  });

  it('keeps native fallback attributes and enhanced bridge metadata generic', () => {
    const html = renderDropdown('singleSelect', {
      id: 'defaults-view-dropdown',
      name: 'view',
      label: 'View',
      compact: true,
      dispatchNativeChange: true,
      selected: 'invalid',
      leadingOption: {
        value: 'invalid',
        label: 'Submitted value: invalid',
        attributes: [['data-dialog-submitted-value', true]],
        selected: true,
      },
      options: [{ value: 'grid', label: 'Grid' }],
      nativeSelect: {
        id: 'defaults-view',
        attributes: [['required', true]],
      },
    });

    expect(html).toContain('class="field asset-filter-multiselect-field cc-dropdown-field--compact"');
    expect(html).toContain('<select id="defaults-view" name="view" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="View" required>');
    expect(html).toContain('<option value="invalid" selected data-dialog-submitted-value>Submitted value: invalid</option>');
    expect(html).toContain('data-cc-dropdown-dispatch-native-change');
    expect(html).toContain('cc-dropdown--compact');
    expect(html).toMatch(/id="defaults-view-dropdown-option-leading"[^>]*value="invalid"[^>]*checked[^>]*data-dialog-submitted-value/);
    expect(html).not.toMatch(/id="defaults-view-dropdown-option-leading" name="view"/);
  });

  it('gives compact triggers a smaller bounded contract while preserving default sizing', () => {
    const defaultSummaryRule = css.match(/\.asset-filter-multiselect summary\s*\{[^}]*\}/)?.[0] || '';
    const compactSummaryRule = css.match(/\.cc-dropdown--compact summary\s*\{[^}]*\}/)?.[0] || '';

    expect(defaultSummaryRule).toContain('min-height: 2.5rem');
    expect(defaultSummaryRule).toContain('padding: var(--space-sm)');
    expect(defaultSummaryRule).toContain('font-size: 1rem');
    expect(compactSummaryRule).toContain('min-height: 2rem');
    expect(compactSummaryRule).toContain('padding: var(--space-xs)');
    expect(compactSummaryRule).toContain('font-size: 0.8125rem');
    expect(compactSummaryRule).toContain('line-height: 1.25');
    expect(css.indexOf(compactSummaryRule)).toBeGreaterThan(css.indexOf(defaultSummaryRule));
    expect(css).toMatch(/\.cc-dropdown--compact\s*\{[^}]*max-width:\s*min\(8rem,\s*100%\)/);
    expect(css).toMatch(/\.cc-dropdown--compact summary::after\s*\{[^}]*margin-left:\s*0/);
    expect(css).toMatch(/\.cc-dropdown--compact \.asset-filter-multiselect-panel\s*\{[^}]*top:\s*auto[^}]*bottom:\s*calc\(100% \+ var\(--space-xs\)\)/);
    expect(css).toMatch(/\.asset-filter-multiselect-panel\s*\{[^}]*top:\s*calc\(100% \+ var\(--space-xs\)\)/);
  });
});
