import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { buildAssetLibraryUrl } from '../src/routes/asset-library-query.js';
import { formatIsoTimestamp, formatSqliteTimestamp } from '../src/util/date.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const TEMPLATE_PATH = path.join(VIEWS_DIR, 'assets', 'index.njk');
const ASSET_INFORMATION_PARTIAL_PATH = path.join(VIEWS_DIR, 'partials', 'asset-information.njk');
const STYLESHEET_PATH = path.join(VIEWS_DIR, '..', 'static', 'creatorcrate.css');
const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');

const alphaAsset = {
  id: 101,
  project_id: 1,
  project_title: 'Alpha Project',
  filename: 'shared.png',
  relative_path: 'renders/shared.png',
  nested_path: '',
  category_directory_slug: 'renders',
  extension: 'png',
  mime_type: 'image/png',
  size_bytes: 1024,
  formattedSize: '1 KB',
  modified_at: '2026-08-01 10:00:00',
  formattedModified: 'August 1, 2026 at 10:00 AM',
  formattedDimensions: '1920 × 1080',
  project_status: 'in-progress',
  project_type: 'images',
  projectStatusOption: {
    value: 'in-progress',
    label: 'In Progress',
    color: '#2F81F7',
    tintPercent: 18,
    foregroundColor: '#79B8FF',
  },
  projectTypeOption: {
    value: 'images',
    label: 'Illustration',
    color: '#A371F7',
    tintPercent: 18,
    foregroundColor: '#D2A8FF',
  },
  is_present: 1,
  category_display_name: 'Renders',
  category_enabled: 1,
  release_usage_count: 2,
  release_titles: [
    { id: 301, title: 'Alpha Release' },
    { id: 302, title: 'Zeta Release' },
  ],
  preview: { kind: 'image', previewable: true },
  preview_state: 'previewable',
  thumbnail_url: '/projects/1/assets/101/thumbnail?v=alpha',
  preview_url: '/projects/1/assets/101/preview?v=alpha',
};

const betaAsset = {
  id: 202,
  project_id: 2,
  project_title: 'Beta Project',
  filename: 'shared.png',
  relative_path: 'source/shared.png',
  nested_path: '',
  category_directory_slug: 'source',
  extension: 'png',
  mime_type: 'image/png',
  size_bytes: 2048,
  formattedSize: '2 KB',
  modified_at: null,
  formattedModified: '—',
  formattedDimensions: '—',
  project_status: 'planned',
  project_type: 'animation',
  projectStatusOption: {
    value: 'planned',
    label: 'Planned',
    color: '#8B949E',
    tintPercent: 20,
    foregroundColor: '#C9D1D9',
  },
  projectTypeOption: {
    value: 'animation',
    label: 'Animation',
    color: '#D29922',
    tintPercent: 18,
    foregroundColor: '#E3B341',
  },
  is_present: 0,
  category_display_name: null,
  category_enabled: null,
  release_usage_count: 0,
  release_titles: [],
  preview: { kind: null, previewable: false },
  preview_state: 'missing',
  thumbnail_url: null,
  preview_url: null,
};

function option(value, label, selected = false) {
  return { value, label, selected };
}

function makeModel(overrides = {}) {
  const filters = {
    projectId: null,
    categories: [],
    tags: [],
    search: null,
    extensions: [],
    presence: 'all',
    usage: 'all',
    sort: 'filename',
    order: 'asc',
    view: 'grid',
    ...overrides.filters,
  };
  const assets = overrides.assets ?? [alphaAsset, betaAsset];
  const page = overrides.page ?? 1;
  const pageSize = overrides.pageSize ?? 25;
  const pageCount = overrides.pageCount ?? 1;
  const model = {
    assets,
    total: overrides.total ?? assets.length,
    page,
    pageSize,
    pageCount,
    hasPreviousPage: overrides.hasPreviousPage ?? page > 1,
    hasNextPage: overrides.hasNextPage ?? page < pageCount,
    filters,
    presentation: { view: filters.view, ...overrides.presentation },
    context: { ...filters, page, pageSize },
    projectOptions: [
      { id: 1, title: 'Alpha Project' },
      { id: 2, title: 'Beta Project' },
    ],
    categoryOptions: [
      option('all', 'All categories', filters.categories.length === 0),
      option('uncategorized', 'Uncategorized', filters.categories.includes('uncategorized')),
      option('renders', 'Renders', filters.categories.includes('renders')),
    ],
    extensionOptions: [option('png', 'png', filters.extensions.includes('png'))],
    presenceOptions: [
      option('all', 'All assets', filters.presence === 'all'),
      option('present', 'Present', filters.presence === 'present'),
      option('missing', 'Missing', filters.presence === 'missing'),
    ],
    usageOptions: [
      option('all', 'All assets', filters.usage === 'all'),
      option('used', 'Used in releases', filters.usage === 'used'),
      option('unused', 'Not used in releases', filters.usage === 'unused'),
    ],
    sortOptions: [
      option('filename', 'Filename', filters.sort === 'filename'),
      option('project', 'Project', filters.sort === 'project'),
    ],
    viewOptions: [
      option('grid', 'Grid', filters.view === 'grid'),
      option('list', 'List', filters.view === 'list'),
    ],
    tagOptions: [],
    orderOptions: [
      option('asc', 'Ascending', filters.order === 'asc'),
      option('desc', 'Descending', filters.order === 'desc'),
    ],
    pageSizeOptions: [
      option(10, '10', pageSize === 10),
      option(25, '25', pageSize === 25),
      option(50, '50', pageSize === 50),
      option(100, '100', pageSize === 100),
      option(150, '150', pageSize === 150),
      option(200, '200', pageSize === 200),
      option('all', 'View All', pageSize === 'all'),
    ],
    nsfwFilterEnabled: false,
    _csrf: '',
    clearFiltersUrl: overrides.clearFiltersUrl ?? `/asset-viewer?resetFilters=1&view=${filters.view}`,
    assetViewerDefaults: { fields: [] },
    assetViewerDefaultsDialogOpen: false,
    assetViewerDefaultsReturnUrl: '/asset-viewer',
    assetViewerNsfwReturnUrl: '/asset-viewer',
    ...overrides,
    filters,
  };

  model.presentation = { view: filters.view, ...model.presentation };
  model.context = { ...filters, page, pageSize, ...overrides.context };
  model.categoryFilterOptions = (model.categoryOptions || []).filter((candidate) => candidate.value !== 'all');
  model.categoryFilterSelectedValues = model.categoryFilterOptions
    .filter((candidate) => candidate.selected)
    .map((candidate) => candidate.value);
  model.tagFilterSelectedValues = (model.tagOptions || [])
    .filter((candidate) => candidate.selected)
    .map((candidate) => candidate.value);
  model.extensionFilterSelectedValues = (model.extensionOptions || [])
    .filter((candidate) => candidate.selected)
    .map((candidate) => candidate.value);
  // WP9b: the route's Projects / Project Types multi-select model.
  const selectedProjects = (filters.projectIds ?? (filters.projectId ? [filters.projectId] : [])).map(String);
  const activeProjects = new Set(model.projectOptions.map((project) => String(project.id)));
  model.projectFilterSelectedValues = overrides.projectFilterSelectedValues ?? selectedProjects;
  model.projectFilterOptions = overrides.projectFilterOptions ?? [
    ...selectedProjects.filter((value) => !activeProjects.has(value)).map((value) => ({
      value,
      label: `Unavailable project (ID ${value})`,
      selected: true,
      unavailable: true,
      classes: 'asset-library-project-option--unavailable',
      attributes: [['data-asset-library-unavailable-project', true]],
    })),
    ...model.projectOptions.map((project) => ({
      value: String(project.id), label: project.title, selected: selectedProjects.includes(String(project.id)),
    })),
  ];
  const selectedTypes = filters.projectTypes ?? [];
  model.projectTypeFilterSelectedValues = overrides.projectTypeFilterSelectedValues ?? selectedTypes;
  model.projectTypeFilterOptions = overrides.projectTypeFilterOptions ?? [
    { value: 'comic', label: 'Comic', selected: selectedTypes.includes('comic') },
    { value: 'images', label: 'Illustration', selected: selectedTypes.includes('images') },
  ];
  return model;
}

function dialogMarkup(html) {
  return html.match(/<dialog id="asset-viewer-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

function renderPage(overrides = {}) {
  const model = makeModel(overrides);
  const state = {
    ...model.filters,
    page: model.page,
    pageSize: model.pageSize,
    presentation: {
      view: model.presentation.view,
      sort: { state: 'valid' },
      order: { state: 'valid' },
      pageSize: { state: 'valid' },
    },
  };
  const pageUrl = overrides.pageUrl ?? ((urlOverrides = {}) => buildAssetLibraryUrl(state, urlOverrides));
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  env.addFilter('formatIsoTimestamp', formatIsoTimestamp);
  env.addFilter('formatSqliteTimestamp', formatSqliteTimestamp);
  return env.render('assets/index.njk', {
    ...model,
    pageUrl,
    appName: 'CreatorCrate',
    auth: { enabled: false, authenticated: false },
    shell: { appName: 'CreatorCrate', activeSection: 'Assets', navigation: [] },
  });
}

// The page also mounts the shared unified viewer dialog (Milestone B), whose
// slideshow speed control is itself a shared dropdown; page-content counts
// leave that dialog out.
function withoutUnifiedViewer(html) {
  return html.replace(/<dialog id="unified-viewer-dialog"[\s\S]*?<\/dialog>/, '');
}

function renderAssetInformation(asset = alphaAsset, options = {}) {
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  return env.renderString(
    '{% import "partials/asset-information.njk" as assetInformation %}{{ assetInformation.render(asset, options) }}',
    { asset, options },
  );
}

function href(url) {
  return url.replaceAll('&', '&amp;');
}

describe('cross-project Asset Viewer template', () => {
  it('sets the page heading and uses the shared layout title contract without a title block', () => {
    const html = renderPage();
    const source = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    expect(html).toMatch(/<h1 class="app-section-title">Asset Viewer<\/h1>/);
    expect(html).toContain('<title>CreatorCrate — Asset Viewer</title>');
    expect(source).not.toContain('{% block title %}');
    expect(source).not.toMatch(/<h1\b/);
  });

  it('renders the GET filter form with current selections and preserves list view', () => {
    const html = renderPage({
      filters: {
        projectId: 2,
        categories: ['renders'],
        tags: [2],
        search: 'shared',
        extensions: ['png'],
        presence: 'missing',
        usage: 'used',
        sort: 'project',
        order: 'desc',
        view: 'list',
      },
      presentation: { view: 'list' },
      pageSize: 50,
      tagOptions: [
        { value: '1', displayName: 'Alpha Tag', selected: false },
        { value: '2', displayName: 'Beta Tag', selected: true },
      ],
    });

    expect(html).toMatch(/<dialog id="asset-viewer-filter-dialog"[\s\S]*?<form id="asset-filters" class="filters-defaults-filters" method="get" action="\/asset-viewer">/);
    expect(html.indexOf('id="asset-viewer-filter-dialog"')).toBeGreaterThan(html.indexOf('data-asset-library-live-region'));
    // View is a real control in Miscellaneous now, not a hidden carry-over.
    expect(html).not.toContain('<input type="hidden" name="view" value="list">');
    expect(html).toMatch(/<input[^>]+name="view"[^>]+type="radio"[^>]+value="list" checked>/);
    expect(html).toContain('aria-label="Projects filter: Beta Project"');
    expect(html).toContain('<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">Beta Project</span>');
    expect(html).toMatch(/<input[^>]+name="project" type="checkbox" value="2" checked>/);
    expect(html).toContain('aria-label="Category filter: Renders"');
    expect(html).toMatch(/<input[^>]+name="category"[^>]+value="renders" checked>/);
    expect(html).toContain('aria-label="Tag filter: Beta Tag"');
    expect(html).toMatch(/<input[^>]+name="tag"[^>]+value="2" checked>/);
    // WP9b: the results Search field (distinct from the dropdown option searches).
    expect(html).not.toContain('id="asset-search"');
    expect(html).toMatch(/<label for="asset-library-search">Search<\/label>/);
    expect(html).toMatch(/<input id="asset-library-search" name="search" type="search" value="shared" maxlength="128"/);
    expect((html.match(/<input[^>]+name="search"/g) || [])).toHaveLength(1);
    expect(html).toMatch(/<label[^>]+for="asset-project-filter-search">Search projects<\/label>/);
    expect(html).toMatch(/id="asset-project-filter-search"[^>]*type="search"/);
    expect(html).toMatch(/<label[^>]+for="asset-project-type-filter-search">Search project types<\/label>/);
    expect(html).toContain('aria-label="Extension filter: .png"');
    expect(html).toMatch(/<input[^>]+name="extension"[^>]+value="png" checked>/);
    expect(html).toContain('aria-label="Presence filter: Missing"');
    expect(html).toContain('aria-label="Release usage filter: Used in releases"');
    expect(html).toContain('aria-label="Sort by filter: Project"');
    expect(html).toContain('aria-label="Sort order filter: Descending"');
    expect(html).toContain('aria-label="Assets per page filter: 50"');
    for (const label of ['Missing', 'Used in releases', 'Project', 'Descending', '50', 'List']) {
      expect(html).toContain(`<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">${label}</span>`);
    }
    expect(html).toMatch(/<input[^>]+name="presence"[^>]+type="radio"[^>]+value="missing" checked>/);
    expect(html).toMatch(/<input[^>]+name="usage"[^>]+type="radio"[^>]+value="used" checked>/);
    expect(html).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
    expect(html).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(html).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
    for (const [name, count] of [['presence', 3], ['usage', 3], ['sort', 2], ['order', 2], ['pageSize', 7], ['view', 2]]) {
      expect((html.match(new RegExp(`name="${name}"[^>]+type="radio"`, 'g')) || [])).toHaveLength(count);
    }
    // Thirteen controls: Search plus twelve dropdowns (Projects, Project
    // Types, Category, Presence, Usage, Tag, Extension, Sort by, Sort order,
    // View, Grid style, Assets per page). B5b retired the legacy slideshow
    // scaffold (and its speed dropdown) in favour of the unified viewer.
    expect((withoutUnifiedViewer(html).match(/data-cc-dropdown data-cc-dropdown-mode="(?:single|multiple)"/g) || [])).toHaveLength(12);
    expect(html).not.toMatch(/<select[^>]+id="asset-(presence|usage|sort|order|page-size)"/);
    for (const [triggerId, optionsId] of [
      ['asset-presence-filter-trigger', 'asset-presence-filter-options'],
      ['asset-usage-filter-trigger', 'asset-usage-filter-options'],
      ['asset-sort-filter-trigger', 'asset-sort-filter-options'],
      ['asset-order-filter-trigger', 'asset-order-filter-options'],
      ['asset-page-size-filter-trigger', 'asset-page-size-filter-options'],
      ['asset-view-filter-trigger', 'asset-view-filter-options'],
      ['asset-grid-style-filter-trigger', 'asset-grid-style-filter-options'],
    ]) {
      const disclosure = (html.match(/<details[^>]*data-cc-dropdown[\s\S]*?<\/details>/g) || [])
        .find((candidate) => candidate.includes(`aria-controls="${optionsId}"`)) || '';
      expect(disclosure).toContain(`id="${triggerId}"`);
      expect(disclosure).toContain(`aria-controls="${optionsId}"`);
      expect(disclosure).toContain('aria-expanded="false"');
      expect(disclosure).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
      expect(disclosure).not.toContain('data-asset-viewer-filter-disclosure');
    }
    expect(html).toContain('data-asset-library-filters-reset');
    expect(html).toContain('<button class="button button-primary" type="submit" data-asset-library-filters-reset>Reset filters</button>');
  });

  it('WP9b: retires the separate Defaults entry; the filter icon opens Filters & Defaults', () => {
    const html = renderPage();
    const toolbar = html.match(/<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>/)?.[0] ?? '';

    expect(html).not.toContain('href="/asset-viewer?defaults=1"');
    expect(html).not.toContain('data-asset-viewer-defaults-link');
    expect(html).not.toContain('asset-viewer-defaults-dialog');
    expect(html).not.toContain('aria-label="Asset Viewer defaults"');
    expect(html).not.toContain('aria-label="Filter assets"');
    expect(toolbar).toContain('href="#asset-viewer-filter-dialog" aria-label="Filters &amp; Defaults"');
    expect(toolbar).toContain('data-dialog-open="asset-viewer-filter-dialog" data-tooltip="Filters &amp; Defaults"');
    expect((toolbar.match(/data-dialog-open=/g) || [])).toHaveLength(1);
  });

  it('keeps the exact page-size selector available when View All has one page', () => {
    const html = renderPage({ pageSize: 'all', pageCount: 1 });
    const control = html.match(/<details[^>]*id="asset-page-size-filter"[\s\S]*?<\/details>/)?.[0] || '';

    expect(control).not.toBe('');
    expect([...control.matchAll(/name="pageSize"[^>]*value="([^"]+)"/g)].map(([, value]) => value))
      .toEqual(['10', '25', '50', '100', '150', '200', 'all']);
    expect(control).toMatch(/name="pageSize"[^>]*value="all" checked/);
    expect(control).toContain('View All');
    expect(html).not.toContain('aria-label="Asset Viewer pages"');
  });

  it('WP9b: hosts both forms in the combined Filters & Defaults dialog pattern', () => {
    const html = renderPage();
    const toolbar = html.match(/<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>/)?.[0] ?? '';
    const dialogHtml = dialogMarkup(html);

    expect(toolbar).toContain('href="#asset-viewer-filter-dialog"');
    expect(toolbar).toContain('data-dialog-open="asset-viewer-filter-dialog"');
    expect(dialogHtml).toMatch(/<dialog id="asset-viewer-filter-dialog" class="app-dialog app-dialog--utility app-dialog--filters-defaults asset-library-filters-defaults" data-app-dialog/);
    expect(dialogHtml).toMatch(/<div class="app-dialog-body filters-defaults-dialog-body">\s*<form id="asset-viewer-defaults-form"/);
    expect(dialogHtml).toContain('<footer class="app-dialog-footer filters-defaults-footer">');
    expect(dialogHtml).not.toContain('page-defaults-grid');
    expect(toolbar).not.toContain('data-asset-library-reset');
    expect(toolbar).not.toContain('data-asset-library-filters-reset');
  });

  it('WP9b: renders Projects as a searchable multi-select with an unrestricted Select all', () => {
    const emptyHtml = renderPage();
    const selectedHtml = renderPage({ filters: { projectIds: [1, 2], projectId: null } });
    const projectFilter = (html) => html.match(/<details[^>]*id="asset-project-filter"[\s\S]*?<\/details>/)?.[0] || '';

    expect(emptyHtml).not.toMatch(/<select[^>]+(?:id="asset-project"|name="project")/);
    expect(emptyHtml).toContain('<legend>Projects</legend>');
    expect(projectFilter(emptyHtml)).toContain('data-cc-dropdown-mode="multiple" data-cc-dropdown-searchable data-cc-dropdown-type="searchable-multiple"');
    expect(projectFilter(emptyHtml)).toContain('data-cc-dropdown-select-all=""');
    expect((emptyHtml.match(/data-asset-viewer-filter-disclosure/g) || [])).toHaveLength(0);
    expect(emptyHtml).toContain('id="asset-project-filter-trigger" aria-controls="asset-project-filter-options"');
    expect(emptyHtml).toContain('id="asset-project-filter-search" class="asset-project-filter-search" type="search" autocomplete="off" data-cc-dropdown-search');
    expect(emptyHtml).toContain('id="asset-project-filter-option-list" class="asset-project-filter-option-list" data-cc-dropdown-option-list role="group"');
    expect(emptyHtml).toContain('data-cc-dropdown-no-results');
    // Select all is the unrestricted filter: checked, empty value (no query key),
    // and it never checks the individual Projects.
    expect(projectFilter(emptyHtml)).toMatch(/<input id="asset-project-option-select-all" name="project" type="checkbox" value="" data-cc-dropdown-select-all checked>/);
    expect(projectFilter(emptyHtml)).toMatch(/<input[^>]+name="project" type="checkbox" value="1">/);
    expect(projectFilter(emptyHtml)).toMatch(/<input[^>]+name="project" type="checkbox" value="2">/);
    expect(projectFilter(emptyHtml)).toContain('>All projects</span>');
    expect(emptyHtml).toContain('aria-label="Projects filter: All projects"');
    expect(emptyHtml).not.toMatch(/<input[^>]+type="hidden"[^>]+name="project"/);
    expect((emptyHtml.match(/<input[^>]+name="project"[^>]+type="checkbox"/g) || [])).toHaveLength(3);
    expect(emptyHtml).not.toMatch(/name="project"[^>]+type="radio"/);

    expect(selectedHtml).toContain('aria-label="Projects filter: 2 projects selected"');
    expect(selectedHtml).toContain('<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">2 projects selected</span>');
    expect(projectFilter(selectedHtml)).toMatch(/<input id="asset-project-option-select-all" name="project" type="checkbox" value="" data-cc-dropdown-select-all>/);
    expect(projectFilter(selectedHtml)).toMatch(/name="project" type="checkbox" value="1" checked>/);
    expect(projectFilter(selectedHtml)).toMatch(/name="project" type="checkbox" value="2" checked>/);
    expect(selectedHtml).not.toMatch(/<input id="asset-project-filter-search"[^>]+name="project"/);
  });

  it('WP9b: keeps an unavailable selected Project as a checked ID-labelled restriction, never All projects', () => {
    const html = renderPage({ filters: { projectIds: [999999], projectId: 999999 } });
    const projectFilter = html.match(/<details[^>]*id="asset-project-filter"[\s\S]*?<\/details>/)?.[0] || '';

    expect(projectFilter).toMatch(/name="project" type="checkbox" value="999999" checked data-asset-library-unavailable-project>/);
    expect(projectFilter).toContain('Unavailable project (ID 999999)');
    expect(projectFilter).toContain('asset-library-project-option--unavailable');
    expect(projectFilter).toMatch(/<input id="asset-project-option-select-all" name="project" type="checkbox" value="" data-cc-dropdown-select-all>/);
    expect(projectFilter).toContain('<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">Unavailable project (ID 999999)</span>');
    expect(projectFilter).not.toContain('aria-label="Projects filter: All projects"');

    const mixed = renderPage({ filters: { projectIds: [2, 999999], projectId: null } });
    const mixedFilter = mixed.match(/<details[^>]*id="asset-project-filter"[\s\S]*?<\/details>/)?.[0] || '';
    expect(mixedFilter).toContain('aria-label="Projects filter: 2 projects selected"');
    expect(mixedFilter).toMatch(/value="999999" checked/);
    expect(mixedFilter).toMatch(/value="2" checked/);
  });

  it('WP9b: renders Project Types as a searchable multi-select over the catalogue values', () => {
    const emptyHtml = renderPage();
    const selectedHtml = renderPage({ filters: { projectTypes: ['comic', 'images'] } });
    const typeFilter = (html) => html.match(/<details[^>]*id="asset-project-type-filter"[\s\S]*?<\/details>/)?.[0] || '';

    expect(emptyHtml).toContain('<legend>Project Types</legend>');
    expect(typeFilter(emptyHtml)).toContain('data-cc-dropdown-searchable');
    expect(typeFilter(emptyHtml)).toMatch(/<input id="asset-project-type-option-select-all" name="type" type="checkbox" value="" data-cc-dropdown-select-all checked>/);
    expect(typeFilter(emptyHtml)).toMatch(/name="type" type="checkbox" value="comic">/);
    expect(typeFilter(emptyHtml)).toMatch(/name="type" type="checkbox" value="images">/);
    expect(typeFilter(emptyHtml)).toContain('>Illustration</span>');
    expect(emptyHtml).toContain('aria-label="Project Types filter: All project types"');

    expect(selectedHtml).toContain('aria-label="Project Types filter: 2 project types selected"');
    expect(typeFilter(selectedHtml)).toMatch(/name="type" type="checkbox" value="comic" checked>/);
    expect(typeFilter(selectedHtml)).toMatch(/name="type" type="checkbox" value="images" checked>/);
    expect(typeFilter(selectedHtml)).toMatch(/<input id="asset-project-type-option-select-all" name="type" type="checkbox" value="" data-cc-dropdown-select-all>/);
  });

  it('renders repeated checkbox parameters, simultaneous checked values, and empty summaries', () => {
    const emptyHtml = renderPage();
    expect(emptyHtml).toContain('aria-label="Category filter: Any category"');
    expect(emptyHtml).toContain('aria-label="Tag filter: Any tag"');
    expect(emptyHtml).toContain('aria-label="Extension filter: Any extension"');

    const html = renderPage({
      filters: {
        categories: ['uncategorized', 'renders'],
        tags: [1, 2],
        extensions: ['jpg', 'png'],
      },
      categoryOptions: [
        option('all', 'All categories', false),
        option('uncategorized', 'Uncategorized', true),
        option('renders', 'Renders', true),
      ],
      extensionOptions: [
        option('jpg', 'jpg', true),
        option('png', 'png', true),
      ],
      tagOptions: [
        { value: '1', displayName: 'Alpha Tag', selected: true },
        { value: '2', displayName: 'Beta Tag', selected: true },
      ],
    });

    expect(html).toContain('2 categories selected');
    expect(html).toContain('2 tags selected');
    expect(html).toContain('2 extensions selected');
    expect((html.match(/data-asset-viewer-filter-disclosure/g) || [])).toHaveLength(0);
    for (const id of ['asset-category-filter-trigger', 'asset-tag-filter-trigger', 'asset-extension-filter-trigger']) {
      expect(html).toContain(`id="${id}"`);
    }
    // WP9b: each multi-select leads with an unrestricted Select all row whose
    // value is empty, so it never adds a query key.
    expect((html.match(/name="category"/g) || [])).toHaveLength(3);
    expect((html.match(/name="tag"/g) || [])).toHaveLength(3);
    expect((html.match(/name="extension"/g) || [])).toHaveLength(3);
    for (const name of ['category', 'tag', 'extension']) {
      expect(html).toMatch(new RegExp(`name="${name}" type="checkbox" value="" data-cc-dropdown-select-all>`));
    }
    expect((html.match(/name="category"[^>]+checked/g) || [])).toHaveLength(2);
    expect((html.match(/name="tag"[^>]+checked/g) || [])).toHaveLength(2);
    expect((html.match(/name="extension"[^>]+checked/g) || [])).toHaveLength(2);
    for (const [optionsId, inputName] of [
      ['asset-category-filter-options', 'category'],
      ['asset-tag-filter-options', 'tag'],
      ['asset-extension-filter-options', 'extension'],
    ]) {
      const disclosure = (html.match(/<details[^>]*data-cc-dropdown[\s\S]*?<\/details>/g) || [])
        .find((candidate) => candidate.includes(`aria-controls="${optionsId}"`)) || '';
      expect(disclosure).toContain('asset-filter-multiselect--sized');
      expect(disclosure).toContain('asset-filter-multiselect-summary-current');
      expect(disclosure).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
      expect(disclosure).toMatch(new RegExp(`<label for="[^"]+">\\s*<input[^>]+name="${inputName}"`));
    }
    expect(html).not.toContain('id="asset-search"');
    expect((html.match(/<input[^>]+name="search"/g) || [])).toHaveLength(1);
    expect(html).not.toMatch(/<select[^>]+(?:id="asset-(tag|category|extension)"|name="(tag|category|extension)")/);
    expect(html).not.toMatch(/type="hidden"[^>]+name="(tag|category|extension)"/);
  });

  it('keeps native fallback selects canonical when single-select option collections are empty', () => {
    const html = renderPage({
      presenceOptions: [],
      usageOptions: [],
      sortOptions: [],
      orderOptions: [],
      pageSizeOptions: [],
    });

    expect(html).toContain('<select id="asset-presence" name="presence" class="cc-dropdown-native-select" data-cc-dropdown-native-select');
    expect(html).toContain('<select id="asset-usage" name="usage" class="cc-dropdown-native-select" data-cc-dropdown-native-select');
    expect(html).toContain('<select id="asset-sort" name="sort" class="cc-dropdown-native-select" data-cc-dropdown-native-select');
    expect(html).toContain('<input id="asset-order" name="order" type="text" value="asc">');
    expect(html).toContain('<input id="asset-page-size" name="pageSize" type="number" value="25">');
    // Presence, Usage, Sort by, View and the native-backed Grid style.
    expect((withoutUnifiedViewer(html).match(/data-cc-dropdown data-cc-dropdown-mode="single"/g) || [])).toHaveLength(5);
    expect((html.match(/data-asset-viewer-filter-disclosure/g) || [])).toHaveLength(0);
    for (const id of [
      'asset-presence-filter-trigger',
      'asset-usage-filter-trigger',
      'asset-sort-filter-trigger',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="asset-order-filter-trigger"');
    expect(html).not.toContain('id="asset-page-size-filter-trigger"');
  });

  it('renders Grid cards without footers while retaining top-bar and preview information markup', () => {
    const html = renderPage();
    const cards = html.match(/<article class="asset-card asset-viewer-grid-card"[\s\S]*?<\/article>/g) || [];
    const alphaCard = cards.find((card) => card.includes('Alpha Project'));
    const betaCard = cards.find((card) => card.includes('Beta Project'));
    const topRow = alphaCard?.match(/<div class="asset-card-top asset-viewer-grid-card-top">[\s\S]*?<\/div>/)?.[0];
    const betaTopRow = betaCard?.match(/<div class="asset-card-top asset-viewer-grid-card-top">[\s\S]*?<\/div>/)?.[0];

    expect(html).toMatch(/<ul class="asset-grid"[^>]*aria-label="Assets across active projects">/);
    expect((html.match(/class="asset-grid-item/g) || []).length).toBe(2);
    expect(html).toContain('data-asset-grid-size-controls');
    expect((html.match(/<input[^>]+data-grid-size-slider[^>]+type="range"/g) || [])).toHaveLength(1);
    expect(html).toMatch(/<input[^>]+data-grid-size-slider[^>]+type="range"[^>]+min="1"[^>]+max="3"[^>]+step="1"[^>]+value="2"/);
    expect(html).toMatch(/<input[^>]+data-grid-size-slider[^>]+aria-label="Grid size"/);
    expect(html).toContain('aria-valuenow="2" aria-valuetext="Default"');
    expect(html).not.toContain('data-grid-size-current');
    expect(html).not.toContain('asset-grid-size-heading');
    expect(html).not.toMatch(/>Grid size<\/(?:label|span|output)/);
    expect(html).not.toMatch(/<button[^>]+data-grid-size="(?:compact|default|large)"/);
    expect(html).toContain('data-grid-size-labels-interactive');
    const optionLabels = [...html.matchAll(/data-grid-size-option-label="(compact|default|large)"[^>]*>([^<]+)</g)];
    expect(optionLabels.map(([, value]) => value)).toEqual(['compact', 'default', 'large']);
    expect(optionLabels.map(([, , label]) => label)).toEqual(['Compact', 'Default', 'Large']);
    expect(html).toMatch(/is-active[^>]*data-grid-size-option-label="default"[^>]*>Default</);
    expect(cards).toHaveLength(2);
    expect(alphaCard).toBeDefined();
    expect(betaCard).toBeDefined();
    expect(topRow).toBeDefined();
    expect(betaTopRow).toBeDefined();
    expect((topRow?.match(/class="asset-indicator\b/g) || [])).toHaveLength(0);
    expect((betaTopRow?.match(/class="asset-indicator\b/g) || [])).toHaveLength(0);
    expect(topRow).not.toContain('asset-card-usage');
    expect(betaTopRow).not.toContain('asset-card-usage');
    expect(topRow).toContain('class="asset-details-link asset-details-link--present asset-tooltip asset-tooltip--right" href="/projects/1/assets/101"');
    expect(topRow).toContain('aria-label="Asset details | File present"');
    expect(topRow).toContain('data-tooltip="Asset details | File present"');
    expect(betaTopRow).toContain('class="asset-details-link asset-details-link--missing asset-tooltip asset-tooltip--right" href="/projects/2/assets/202"');
    expect(betaTopRow).toContain('aria-label="Asset details | File missing!"');
    expect(betaTopRow).toContain('data-tooltip="Asset details | File missing!"');
    expect(topRow).toContain('<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/>');
    expect(topRow).toContain('<span class="sr-only">View details</span>');

    expect(alphaCard).toContain('data-asset-viewer-preview');
    expect(alphaCard).toContain('data-asset-info-card');
    expect(alphaCard).toContain('data-asset-info-card popover="manual"');
    expect(alphaCard).toContain('aria-label="View preview of shared.png"');
    expect(alphaCard).toContain('src="/projects/1/assets/101/preview?v=alpha"');
    expect(alphaCard).toContain('alt=""');
    expect(alphaCard).not.toContain('asset-viewer-grid-card-title-area');
    expect(betaCard).not.toContain('asset-viewer-grid-card-title-area');

    const infoCard = alphaCard?.match(/<div class="asset-viewer-grid-card-info"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';
    for (const field of ['Filename', 'Project', 'Category', 'Extension', 'Size', 'Dimensions', 'Modified', 'Release usage']) {
      expect((alphaCard.match(new RegExp(`<dt>${field}</dt>`, 'g')) || [])).toHaveLength(1);
    }
    expect(infoCard).not.toContain('<dt>Location</dt>');
    expect(infoCard).not.toContain('<dt>Presence</dt>');
    expect(infoCard).toContain('<dd>shared.png</dd>');
    expect(infoCard).toContain('<dd>Alpha Project</dd>');
    expect(alphaCard).toContain('Renders');
    expect(alphaCard).toContain('<dd>1 KB</dd>');
    expect(alphaCard).toContain('<dd>1920 × 1080</dd>');
    expect(alphaCard).toContain('<dd>August 1, 2026 at 10:00 AM</dd>');
    expect(alphaCard).toContain('Used in 2 releases');
    expect(alphaCard).toContain('Effective tags');
    expect(infoCard).toContain('class="status-badge project-option-badge project-status-badge status-badge--draft"');
    expect(infoCard).toContain('class="status-badge project-option-badge project-type-badge"');
    expect(infoCard).toContain('--project-badge-bg: #2F81F7; --project-badge-tint: 18%; --project-badge-fg: #79B8FF');
    expect(infoCard).toContain('--project-badge-bg: #A371F7; --project-badge-tint: 18%; --project-badge-fg: #D2A8FF');
    expect(infoCard).toContain('>In Progress</span>');
    expect(infoCard).toContain('>Illustration</span>');
    expect(infoCard).not.toContain('·');
    const fieldOrder = ['Filename', 'Project', 'Category', 'Extension', 'Size', 'Dimensions', 'Modified', 'Release usage'];
    for (let index = 1; index < fieldOrder.length; index += 1) {
      expect(infoCard.indexOf(`<dt>${fieldOrder[index - 1]}</dt>`))
        .toBeLessThan(infoCard.indexOf(`<dt>${fieldOrder[index]}</dt>`));
    }
    expect(infoCard.indexOf('Effective tags')).toBeLessThan(infoCard.lastIndexOf('>Project</span>'));
    expect(alphaCard).not.toContain('data-asset-info-trigger');
    expect(alphaCard).not.toContain('asset-select-checkbox');
    expect(alphaCard).not.toMatch(/\d+\s+of\s+\d+/);
    expect(alphaCard).not.toMatch(/Rename|Move file|selectedAssetIds/);
  });

  it('renders assigned display names in grid cards without exposing tag internals or false untagged labels', () => {
    const html = renderPage({
      assets: [
        {
          ...alphaAsset,
          tags: [
            { id: 987654, normalized_name: 'shared-render-secret', displayName: 'Shared Render Tag', origin: 'direct' },
            { displayName: 'Alpha Render Tag', origin: 'inherited' },
          ],
        },
        {
          ...betaAsset,
          tags: [{ displayName: 'Shared Render Tag' }],
        },
      ],
    });

    expect(html).toContain('<ul class="asset-viewer-grid-card-info-tags" aria-label="Effective tags">');
    expect((html.match(/<li>\s*Shared Render Tag\s*<\/li>/g) || [])).toHaveLength(2);
    expect(html).toContain('<li>Alpha Render Tag <span class="asset-tag-origin"><span class="sr-only">Inherited from </span>Project</span></li>');
    expect(html).not.toContain('shared-render-secret');
    expect(html).not.toContain('987654');
    expect(html).not.toContain('Untagged');
  });

  it('renders the eight-column Dashboard List with thumbnail, title trigger, project link and compact cells', () => {
    const html = renderPage({
      filters: { view: 'list' },
      presentation: { view: 'list' },
    });
    const cards = html.match(/<article class="asset-list-card"[\s\S]*?<\/article>/g) || [];
    const alphaCard = cards.find((card) => card.includes('data-asset-id="101"'));
    const betaCard = cards.find((card) => card.includes('data-asset-id="202"'));
    const columns = ['asset', 'project', 'category', 'type', 'presence', 'releases', 'size', 'modified'];

    expect(html).toContain('<div class="dashboard dashboard-panel asset-list-panel">');
    expect(html).toContain('<div class="dashboard-table-scroll asset-list-scroll" role="region" aria-label="Asset table" tabindex="0">');
    expect(html).toContain(`<div class="asset-list-table asset-list-table--library" data-asset-list-columns="${columns.join(' ')}">`);
    const header = html.match(/<div class="asset-list-header" aria-hidden="true">([\s\S]*?)<\/div>/)?.[1] || '';
    expect([...header.matchAll(/asset-list-cell--(\w+)">([^<]*)</g)].map((match) => [match[1], match[2]])).toEqual([
      ['asset', 'Asset'], ['project', 'Project'], ['category', 'Category'], ['type', 'Type'], ['presence', 'Presence'],
      ['releases', 'Releases'], ['size', 'Size'], ['modified', 'Modified'],
    ]);
    expect(html).toMatch(/<ul class="asset-list asset-list--library" role="list" aria-label="Assets across active projects">/);
    expect(html).not.toContain('<table class="data-table asset-table">');
    expect((html.match(/<li class="asset-list-item/g) || []).length).toBe(2);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const cardCells = [...card.matchAll(/class="asset-list-cell asset-list-cell--(\w+)/g)].map((match) => match[1]);
      expect(cardCells).toEqual(columns);
    }
    expect(html).not.toContain('asset-list-cell--select');
    expect(html).not.toContain('selectedAssetIds');
    expect(html).not.toContain('data-asset-grid-size-controls');

    // Asset: Dashboard thumbnail box with the unified-viewer preview link
    // (project-qualified, Asset Library hook only), and a title that opens
    // the information card instead of navigating.
    expect(alphaCard).toContain('class="asset-list-card-media dashboard-thumb" data-preview-enhancement data-preview-state="loading"');
    expect(alphaCard).toContain('class="asset-list-card-media-link" href="/projects/1/assets/101" aria-label="View preview of shared.png from Alpha Project" data-asset-library-preview-id="101" data-asset-library-preview-project-id="1"');
    expect(alphaCard).not.toContain('data-project-assets-preview-id');
    expect(alphaCard).toContain('src="/projects/1/assets/101/preview?v=alpha"');
    expect(alphaCard).not.toContain('src="/projects/1/assets/101/thumbnail?v=alpha"');
    expect(alphaCard).toMatch(/<div class="dashboard-title-info asset-list-card-title-info" data-dashboard-title-info>\s*<h2 class="asset-list-card-title">\s*<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="asset-library-list-info-101" aria-expanded="false">shared\.png<\/button>\s*<\/h2>/);
    expect(html).not.toContain('class="asset-file-link"');
    expect(alphaCard).toMatch(/data-asset-containing-location>\s*renders\s*<\/span>/);
    expect(betaCard).toMatch(/data-asset-containing-location>\s*source\s*<\/span>/);
    expect(betaCard).toContain('class="asset-list-card-media-placeholder asset-list-card-media-placeholder--missing" title="Missing at last scan"');

    const cell = (card, column) => card?.match(new RegExp(`class="asset-list-cell asset-list-cell--${column}[\\s\\S]*?</(?:dl|div)>`))?.[0] || '';
    expect(cell(alphaCard, 'project')).toContain('<a class="asset-project-link" href="/projects/1" aria-label="View project Alpha Project">Alpha Project</a>');
    expect(cell(betaCard, 'project')).toContain('href="/projects/2"');
    expect(cell(alphaCard, 'category')).toContain('Renders');
    expect(cell(betaCard, 'category')).toContain('Uncategorized');
    expect(cell(alphaCard, 'type')).toContain('<span class="asset-type-label">PNG</span>');
    expect(cell(alphaCard, 'presence')).toContain('asset-indicator--present');
    expect(cell(betaCard, 'presence')).toContain('asset-indicator--missing');
    expect(cell(alphaCard, 'releases')).toContain('aria-label="Used in 2 releases"');
    expect(cell(alphaCard, 'releases')).toContain('<span class="asset-list-card-release-count" aria-hidden="true">2</span>');
    expect(cell(alphaCard, 'releases')).not.toContain('Alpha Release');
    expect(cell(betaCard, 'releases')).toContain('aria-label="Not used by a release"');
    expect(cell(alphaCard, 'size')).toContain('<dd>1 KB</dd>');
    expect(cell(alphaCard, 'modified')).toContain('<dd>August 1, 2026 at 10:00 AM</dd>');
    expect(cell(betaCard, 'modified')).toContain('<span class="dashboard-muted">—</span>');
    // No Actions column: navigation lives in the title information card.
    for (const card of [alphaCard, betaCard]) {
      expect(card).not.toContain('asset-list-cell--actions');
      expect(card).not.toContain('asset-list-card-actions');
      expect(card).not.toContain('asset-details-link');
    }
    expect(header).not.toContain('Actions');
  });

  it('fills each List information card with actions, identity, project, file facts, tags and releases', () => {
    const html = renderPage({
      assets: [
        {
          ...alphaAsset,
          previewAltText: 'Alpha render',
          tags: [
            { displayName: 'Direct List Tag', origin: 'direct' },
            { displayName: 'Inherited List Tag', origin: 'inherited' },
          ],
        },
        { ...betaAsset, tags: [] },
      ],
      filters: { view: 'list' },
      presentation: { view: 'list' },
    });
    const info = (id) => html.match(new RegExp(`<div id="asset-library-list-info-${id}"[\\s\\S]*?<\\/article>`))?.[0] || '';
    const alpha = info(101);
    const beta = info(202);
    const fact = (card, label) => card.match(new RegExp(`<dt>${label}</dt><dd[^>]*>([\\s\\S]*?)</dd>`))?.[1]?.replace(/\s+/g, ' ').trim();

    expect(alpha).toContain('data-calendar-info-card popover="manual"');
    expect(alpha).toContain('aria-label="Details for shared.png"');
    expect(alpha).toContain('<a class="button button-small button-secondary" href="/projects/1/assets/101">Open asset</a>');
    expect(alpha).toContain('<a class="button button-small button-secondary" href="/projects/1">Open project</a>');
    expect(alpha).toContain('<h3 class="asset-viewer-grid-card-info-heading asset-list-info-filename">shared.png</h3>');
    expect(alpha).toMatch(/<img class="calendar-release-info-image"\s+data-preview-image src="\/projects\/1\/assets\/101\/preview\?v=alpha" alt="Alpha render"/);
    expect(fact(alpha, 'Path')).toBe('renders/shared.png');
    expect(fact(alpha, 'Preview')).toBeUndefined();
    expect(fact(alpha, 'Project')).toBe('Alpha Project');
    expect(fact(alpha, 'Project status')).toContain('In Progress');
    expect(fact(alpha, 'Project type')).toContain('Illustration');
    expect(fact(alpha, 'Category')).toBe('Renders');
    expect(fact(alpha, 'Type')).toBe('PNG (.png)');
    expect(fact(alpha, 'Presence')).toBe('Present');
    expect(fact(alpha, 'Size')).toBe('1 KB (1024 bytes)');
    expect(fact(alpha, 'Modified')).toBe('August 1, 2026 at 10:00 AM');
    expect(alpha).toContain('<ul class="asset-viewer-grid-card-info-tags" aria-label="Effective tags">');
    expect(alpha).toContain('<li>Direct List Tag</li>');
    expect(alpha).toContain('<li>Inherited List Tag <span class="asset-tag-origin"><span class="sr-only">Inherited from </span>Project</span></li>');
    expect(alpha).toContain('<li><a href="/releases/301">Alpha Release</a></li>');
    expect(alpha).toContain('<li><a href="/releases/302">Zeta Release</a></li>');

    expect(beta).not.toContain('<img');
    expect(fact(beta, 'Preview')).toBe('File missing at last scan');
    expect(fact(beta, 'Presence')).toBe('Missing at last scan');
    expect(fact(beta, 'Category')).toBe('Uncategorized');
    expect(fact(beta, 'Modified')).toBe('—');
    expect(beta).toContain('<a class="button button-small button-secondary" href="/projects/2">Open project</a>');
    expect(beta).toContain('No effective tags');
    expect(beta).toContain('Not used by a release');
  });

  it('marks unsupported and video List previews without loading media in the information card', () => {
    const html = renderPage({
      assets: [
        { ...alphaAsset, id: 505, filename: 'notes.txt', extension: 'txt', preview: { kind: null, previewable: false }, preview_state: 'unsupported', thumbnail_url: null, preview_url: null },
        { ...alphaAsset, id: 606, filename: 'clip.mp4', extension: 'mp4', preview: { kind: 'video', previewable: false, playbackUrl: '/projects/1/assets/606/original' }, preview_state: 'video', thumbnail_url: null, preview_url: null },
        { ...alphaAsset, id: 707, filename: 'nsfw.png', nsfwBlur: true },
      ],
      filters: { view: 'list' },
      presentation: { view: 'list' },
    });
    const info = (id) => html.match(new RegExp(`<div id="asset-library-list-info-${id}"[\\s\\S]*?<\\/article>`))?.[0] || '';

    expect(html).toContain('<span class="asset-list-card-media-placeholder" title="TXT — preview not supported">TXT<span class="sr-only"> — preview not supported</span></span>');
    expect(info(505)).toContain('TXT — preview not supported');
    expect(info(505)).not.toContain('<img');
    expect(info(606)).toContain('MP4 video — play it from the row thumbnail');
    expect(info(606)).not.toMatch(/<img|<video/);
    expect(html).toContain('class="asset-list-card-media-image asset-image--nsfw-blurred"');
    expect(info(707)).toContain('class="calendar-release-info-image project-image--nsfw-blurred"');
  });

  it('styles List cards with a non-square stretched media region and a full-width content region', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');
    const listStyles = css.match(/\/\* ── Asset Viewer list:[\s\S]*?(?=\/\* ── Reduced motion)/)?.[0];
    const cardRule = listStyles?.match(/(?:^|\n)\s*\.asset-list-card\s*\{[^}]*\}/)?.[0];
    const mediaRule = listStyles?.match(/\.asset-list-card-media\s*\{[^}]*\}/)?.[0];
    const mediaImageRule = listStyles?.match(/\.asset-list-card-media-image\s*\{[^}]*\}/)?.[0];
    const bodyRule = listStyles?.match(/\.asset-list-card-body\s*\{[^}]*\}/)?.[0];
    const metadataRule = listStyles?.match(/\.asset-list-card-metadata\s*\{[^}]*\}/)?.[0];
    const projectRule = listStyles?.match(/\.asset-list-card-meta--project\s*\{[^}]*\}/)?.[0];
    const extensionRule = listStyles?.match(/\.asset-list-card-meta--extension\s*\{[^}]*\}/)?.[0];
    const associationsRule = listStyles?.match(/\.asset-list-card-associations\s*\{[^}]*\}/)?.[0];
    const associationRule = listStyles?.match(/\.asset-list-card-association\s*\{[^}]*\}/)?.[0];

    expect(listStyles).toBeDefined();
    expect(cardRule).toBeDefined();
    expect(cardRule).toContain('display: grid;');
    expect(cardRule).toContain('grid-template-columns: clamp(7rem, 20%, 15rem) minmax(0, 1fr);');
    expect(cardRule).toContain('align-items: stretch;');
    expect(cardRule).toContain('padding: var(--space-sm);');
    expect(cardRule).toContain('border: 1px solid var(--border);');
    expect(cardRule).not.toContain('grid-template-areas');
    expect(cardRule).not.toContain('9.5rem');
    expect(cardRule).not.toContain('88px');

    expect(mediaRule).toBeDefined();
    expect(mediaRule).toContain('align-self: stretch;');
    expect(mediaRule).toContain('width: 100%;');
    expect(mediaRule).toContain('min-height: 10rem;');
    expect(mediaRule).not.toMatch(/(?<![-\w])height\s*:/);
    expect(mediaRule).not.toContain('aspect-ratio');
    expect(mediaRule).not.toContain('9.5rem');
    expect(mediaRule).not.toContain('5.5rem');

    expect(mediaImageRule).toBeDefined();
    expect(mediaImageRule).toContain('width: 100%;');
    expect(mediaImageRule).toContain('height: 100%;');
    expect(mediaImageRule).toContain('object-fit: contain;');
    expect(mediaImageRule).not.toContain('object-fit: cover;');
    expect(listStyles).not.toContain('aspect-ratio');
    expect(listStyles).not.toContain('object-fit: cover;');
    expect(bodyRule).toBeDefined();
    expect(bodyRule).toContain('grid-column: 2;');
    expect(bodyRule).toContain('width: 100%;');
    expect(metadataRule).toBeDefined();
    expect(metadataRule).toContain('display: flex;');
    expect(metadataRule).toContain('flex-wrap: wrap;');
    expect(metadataRule).not.toContain('grid-template-columns');
    expect(projectRule).toBeDefined();
    expect(projectRule).toContain('flex: 2 1 15rem;');
    expect(extensionRule).toBeDefined();
    expect(extensionRule).toContain('flex: 0 1 6rem;');
    expect(associationsRule).toBeDefined();
    expect(associationsRule).toContain('display: flex;');
    expect(associationsRule).toContain('flex-wrap: wrap;');
    expect(associationRule).toBeDefined();
    expect(associationRule).toContain('flex: 1 1 18rem;');
    expect(associationRule).toContain('min-width: min(100%, 16rem);');
    expect(listStyles).toMatch(/\.asset-list-card-association\s*\{[^}]*flex:\s*1\s+1\s+18rem[\s\S]*?\}/);
    expect(listStyles).toMatch(/\.asset-list-card-association\s*\{[^}]*\}[\s\S]*?@media\s*\(max-width:\s*540px\)[\s\S]*?\.asset-list-card-association\s*\{[^}]*flex-basis:\s*100%/);
    expect(listStyles).not.toContain('grid-template-columns: repeat(auto-fit');
    expect(listStyles).not.toContain('grid-column: 1 / -1;');
    expect(listStyles).not.toContain('grid-column: span 2;');
    expect(listStyles).not.toContain('asset-list-card-actions');
  });

  it('keeps List title, project, release, and preview links out of visited-purple styling', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');

    expect(css).toMatch(/\.asset-list-card \.asset-list-card-title \.asset-file-link,[\s\S]*?\.asset-list-card \.asset-list-card-title \.asset-file-link:visited[\s\S]*?color:\s*var\(--text\)/);
    expect(css).toMatch(/\.asset-list-card \.asset-project-link,[\s\S]*?\.asset-list-card \.asset-project-link:visited,[\s\S]*?\.asset-list-card \.asset-list-card-release-link,[\s\S]*?\.asset-list-card \.asset-list-card-release-link:visited[\s\S]*?color:\s*var\(--link\)/);
    expect(css).toMatch(/\.asset-list-card \.asset-list-card-title \.asset-file-link:hover,[\s\S]*?\.asset-list-card \.asset-list-card-title \.asset-file-link:focus-visible[\s\S]*?color:\s*var\(--accent\)/);
    expect(css).toMatch(/\.asset-list-card \.asset-project-link:hover,[\s\S]*?\.asset-list-card \.asset-project-link:focus-visible,[\s\S]*?\.asset-list-card \.asset-list-card-release-link:hover,[\s\S]*?\.asset-list-card \.asset-list-card-release-link:focus-visible[\s\S]*?color:\s*var\(--accent-2\)/);
  });

  it('uses the larger preview derivative for ordinary and Krita List media', () => {
    const assets = [
      alphaAsset,
      {
        ...alphaAsset,
        id: 303,
        filename: 'photo.jpg',
        relative_path: 'references/photo.jpg',
        category_directory_slug: 'references',
        extension: 'jpg',
        preview: { kind: 'image', previewable: true },
        thumbnail_url: '/projects/1/assets/303/thumbnail?v=jpg',
        preview_url: '/projects/1/assets/303/preview?v=jpg',
      },
      {
        ...alphaAsset,
        id: 404,
        filename: 'painting.kra',
        relative_path: 'source/painting.kra',
        category_directory_slug: 'source',
        extension: 'kra',
        mime_type: 'application/x-krita',
        preview: { kind: 'krita', previewable: true },
        thumbnail_url: '/projects/1/assets/404/thumbnail?v=kra',
        preview_url: '/projects/1/assets/404/preview?v=kra',
      },
    ];
    const html = renderPage({
      assets,
      filters: { view: 'list' },
      presentation: { view: 'list' },
    });
    const cards = html.match(/<article class="asset-list-card"[\s\S]*?<\/article>/g) || [];

    expect(cards).toHaveLength(3);
    for (const asset of assets) {
      const card = cards.find((candidate) => candidate.includes(`assets/${asset.id}`));
      expect(card).toContain(`src="${asset.preview_url}"`);
      expect(card).not.toContain(`src="${asset.thumbnail_url}"`);
    }
  });

  it('styles Grid cards with compact wrapping release and tag regions', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');

    expect(css).toMatch(/\.asset-viewer-grid-card\s*\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.asset-viewer-grid-card:hover,[\s\S]*?\.asset-viewer-grid-card:focus-within\s*\{[^}]*z-index:\s*60/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info\s*\{[\s\S]*?width:\s*min\(24rem,\s*calc\(100vw\s*-\s*2rem\)\)/);
    expect(css).toMatch(/\.asset-viewer-filters\s*\{[^}]*z-index:\s*20/);
    expect(css).toMatch(/\.asset-filter-multiselect\[open\]\s*\{[^}]*z-index:\s*40/);
    expect(css).toMatch(/\.asset-filter-multiselect-panel\s*\{[\s\S]*?z-index:\s*50/);
    expect(css).toMatch(/\.asset-viewer-grid-card-preview\s*\{[^}]*overflow:\s*visible/);
    expect(css).not.toMatch(/\.asset-grid\s*\{[^}]*overflow:\s*(?:hidden|clip|auto|scroll)/);
    expect(css).not.toMatch(/\.asset-browser-content\s*\{[^}]*overflow:\s*(?:hidden|clip|auto|scroll)/);
    expect(css).not.toMatch(/\.asset-viewer-filters\s*\{[^}]*overflow:\s*(?:hidden|clip|auto|scroll)/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info-tags\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.asset-viewer-grid-card-title-releases\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.asset-viewer-grid-card-title \.asset-file-link\s*\{[^}]*color:\s*var\(--text\)/);
    expect(css).toMatch(/\.asset-viewer-grid-card-project-link:visited,[\s\S]*?\.asset-viewer-grid-card-release-link:visited[\s\S]*?color:\s*var\(--link\)/);
    expect(css).toMatch(/\.asset-details-link--present\s*\{\s*color:\s*var\(--success\)/);
    expect(css).toMatch(/\.asset-details-link--missing\s*\{\s*color:\s*var\(--danger\)/);
    expect(css).toMatch(/\.asset-details-link--present svg,[\s\S]*?\.asset-details-link--missing svg\s*\{\s*width:\s*1\.375rem;\s*height:\s*1\.375rem/);
  });

  it('separates View and Grid-size controls and keeps the grouped toolbar wrap-safe', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');

    expect(css).toMatch(/\.asset-viewer-display-controls\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?column-gap:\s*var\(--space-xl\);[\s\S]*?row-gap:\s*var\(--space-md\)/);
    expect(css).toMatch(/\.asset-viewer-display-controls \.view-switcher,[\s\S]*?\.asset-viewer-display-controls \.asset-grid-size-controls[\s\S]*?margin-bottom:\s*0/);
    expect(css).toMatch(/\.asset-viewer-grid-size-controls\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?min-width:\s*min\(100%,\s*11rem\)[\s\S]*?max-width:\s*11rem/);
    expect(css).not.toMatch(/\.asset-viewer-grid-size-controls\s*\{[\s\S]*?max-width:\s*22rem/);
    expect(css).toMatch(/\.asset-grid-size-slider:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/\.asset-grid-size-option-labels \.?\[data-grid-size-option-label\]\.is-active\s*\{[\s\S]*?font-weight:\s*700/);
    expect(css).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.asset-viewer-display-controls\s*\{[\s\S]*?row-gap:\s*var\(--space-sm\)[\s\S]*?\.asset-viewer-grid-size-controls\s*\{[\s\S]*?flex-basis:\s*100%/);
  });

  it('styles Asset Viewer filter disclosures as scoped scrollable controls with focus states', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');

    expect(css).toMatch(/#asset-viewer-filter-dialog \.page-defaults-grid > \.asset-viewer-filter-field\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none/);
    expect(css).toMatch(/#asset-viewer-filter-dialog \.page-defaults-grid > \.asset-viewer-filter-field--project\s*\{[^}]*grid-column:\s*1 \/ -1/);
    expect(css).toMatch(/\.asset-filter-multiselect-panel\s*\{[\s\S]*?max-height:\s*20rem[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.asset-filter-multiselect-panel\s*\{[\s\S]*?scrollbar-width:\s*thin/);
    expect(css).toMatch(/\.asset-filter-multiselect summary:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/\.asset-filter-multiselect-option input:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.asset-filter-multiselect-panel\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.asset-viewer-project-filter \.asset-project-filter-panel\s*\{[\s\S]*?max-height:\s*20rem[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.asset-viewer-project-filter \.asset-project-filter-option-list\s*\{[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list\s*\{[\s\S]*?scrollbar-color:\s*var\(--border-strong\)\s+transparent[\s\S]*?scrollbar-width:\s*thin/);
    expect(css).not.toMatch(/#(?:project|asset)-project-filter\s+\.asset-project-filter-option-list/);
    expect(css).toMatch(/\.asset-filter-multiselect-field\s*\{[^}]*flex:\s*0 1 auto[^}]*width:\s*max-content/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized\s*\{[^}]*width:\s*max-content[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-summary\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*max-content/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-summary-width\s*\{[\s\S]*?max-height:\s*0[\s\S]*?overflow:\s*hidden[\s\S]*?visibility:\s*hidden[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-panel\s*\{[\s\S]*?width:\s*max-content[\s\S]*?max-width:\s*min\(/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-option > label\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.asset-viewer-project-filter \.asset-filter-multiselect-summary-current\s*\{[\s\S]*?text-overflow:\s*ellipsis/);
    expect(css).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.asset-filter-multiselect-field\s*\{[\s\S]*?width:\s*100%[\s\S]*?max-width:\s*100%/);
  });

  it('presents transformed Grid-card information in the native popover top layer', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');
    const sidebarLayer = Number(css.match(/--shell-z-sidebar:\s*(\d+)/)?.[1]);
    const contentLayer = Number(css.match(/--shell-z-content:\s*(\d+)/)?.[1]);

    expect(css).toMatch(/\.app-main\s*\{[\s\S]*?position:\s*relative[\s\S]*?z-index:\s*var\(--shell-z-content\)/);
    expect(css).toMatch(/\.app-sidebar\s*\{[\s\S]*?position:\s*fixed[\s\S]*?z-index:\s*var\(--shell-z-sidebar\)/);
    expect(sidebarLayer).toBeGreaterThan(contentLayer);
    expect(sidebarLayer).toBeGreaterThan(60);
    expect(css).toMatch(/\.asset-viewer-grid-card:hover,[\s\S]*?\.asset-viewer-grid-card:focus-within\s*\{[\s\S]*?transform:\s*translateY\(-2px\)/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*auto/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info\s*\{[\s\S]*?background:\s*color-mix\([\s\S]*?backdrop-filter:\s*blur\(10px\)/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info\[data-info-card-open="true"\]\s*\{[\s\S]*?display:\s*block/);
  });

  it('contains the filter form, NSFW form, and defaults dialog form but no asset-mutation controls', () => {
    const html = renderPage({ _csrf: 'test-csrf', nsfwFilterEnabled: false });
    const forms = html.match(/<form\b[^>]*>/g) || [];

    // Filters (GET), Reset filters (GET), NSFW and Save new defaults; Reset
    // defaults (F3) is a JavaScript-only control with no form.
    expect(forms).toHaveLength(4);
    expect(forms.find((f) => f.includes('method="get"'))).toBeDefined();
    expect(forms.find((f) => f.includes('action="/asset-viewer/nsfw-filter"'))).toBeDefined();
    // F2: Save new defaults is JavaScript-only; its form has no native POST.
    expect(forms.find((f) => f.includes('id="asset-viewer-defaults-form"') && f.includes('method="dialog"'))).toBeDefined();
    expect(forms.find((f) => f.includes('action="/asset-viewer/defaults"'))).toBeUndefined();
    expect(forms.find((f) => f.includes('action="/asset-viewer/defaults/reset"'))).toBeUndefined();
    // Filter "Select all" rows are the unrestricted filter, not asset selection.
    expect(html.replaceAll('<span>Select all</span>', '')).not.toMatch(/Manually scan project files|Rename|Move file|Add selected|Set as primary|select all/i);
    expect(html).not.toContain('name="selectedAssetIds"');
    expect(html).not.toContain('asset-select-checkbox');
    expect(html).not.toContain('asset-rename-trigger');
  });

  it('renders tag filtering without adding tag sorting controls', () => {
    const html = renderPage();

    expect(html).toContain('id="asset-tag-filter-trigger"');
    expect(html).toContain('aria-label="Tag filter: Any tag"');
    expect(html).toContain('No tags available');
    expect(html).not.toContain('<select id="asset-tag"');
    expect(html).not.toContain('sort=tag');
  });

  it.each(['grid', 'list'])('both Asset Viewer Reset controls use supplied %s intent', (view) => {
    const clearFiltersUrl = '/asset-viewer?resetFilters=1&view=' + view;
    const html = renderPage({ assets: [], hasAnyAssets: true, filters: { view, search: 'missing' }, clearFiltersUrl });
    const resetForm = html.match(/<form class="asset-viewer-filter-reset filters-defaults-reset-form"[^>]*>/)?.[0] ?? '';
    const emptyReset = html.match(/<a\b[^>]*data-asset-library-reset[^>]*>/)?.[0] ?? '';
    expect(resetForm).toContain('action="' + href(clearFiltersUrl) + '"');
    expect(emptyReset).toContain('href="' + href(clearFiltersUrl) + '"');
  });

  it('imports Asset information independently and includes the Project-name field by default', () => {
    const pageSource = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const source = fs.readFileSync(ASSET_INFORMATION_PARTIAL_PATH, 'utf8');
    const html = renderAssetInformation();

    expect(pageSource).toContain('{% import "partials/asset-information.njk" as assetInformation %}');
    expect(pageSource).toContain('{{ assetInformation.render(asset) }}');
    expect(pageSource).not.toContain('{% macro renderGridAssetInfo');
    expect(source).not.toContain('pageUrl');
    expect(html).toContain('data-asset-info-card popover="manual"');
    expect(html).toContain('<dt>Project</dt>');
    expect(html).toContain('<dd>Alpha Project</dd>');
  });

  it('omits only the Project-name field when showProjectName is false', () => {
    const html = renderAssetInformation({
      ...alphaAsset,
      tags: [{ displayName: 'Shared Render Tag', origin: 'inherited' }],
    }, { showProjectName: false });

    expect(html).not.toContain('<dt>Project</dt>');
    expect(html).not.toContain('<dd>Alpha Project</dd>');
    for (const field of ['Filename', 'Category', 'Extension', 'Size', 'Dimensions', 'Modified', 'Release usage']) {
      expect(html).toContain(`<dt>${field}</dt>`);
    }
    expect(html).toContain('Effective tags');
    expect(html).toContain('Shared Render Tag');
    expect(html).toContain('<span class="asset-viewer-grid-card-info-section-label">Project</span>');
    expect(html).toContain('>In Progress</span>');
    expect(html).toContain('>Illustration</span>');
  });

  it('prefers explicit effectiveTags while retaining the existing tags fallback', () => {
    const effectiveHtml = renderAssetInformation({
      ...alphaAsset,
      tags: [{ displayName: 'Assigned only', origin: 'direct' }],
      effectiveTags: [{ displayName: 'Inherited presentation', origin: 'inherited' }],
    });
    const assetLibraryHtml = renderAssetInformation({
      ...alphaAsset,
      tags: [{ displayName: 'Asset Library effective tag', origin: 'direct' }],
    });

    expect(effectiveHtml).toContain('Inherited presentation');
    expect(effectiveHtml).toContain('Inherited from');
    expect(effectiveHtml).not.toContain('Assigned only');
    expect(assetLibraryHtml).toContain('Asset Library effective tag');
  });

  it('escapes Asset information filename, project, and catalogue labels', () => {
    const html = renderPage({
      assets: [{
        ...alphaAsset,
        filename: '<asset>.png',
        project_title: 'Project & <Studio>',
        projectStatusOption: {
          ...alphaAsset.projectStatusOption,
          label: '<Ready>',
        },
        projectTypeOption: {
          ...alphaAsset.projectTypeOption,
          label: 'Art & Design',
        },
      }],
    });
    const infoCard = html.match(/<div class="asset-viewer-grid-card-info"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';

    expect(infoCard).toContain('&lt;asset&gt;.png');
    expect(infoCard).toContain('Project &amp; &lt;Studio&gt;');
    expect(infoCard).toContain('&lt;Ready&gt;</span>');
    expect(infoCard).toContain('>Art &amp; Design</span>');
    expect(infoCard).not.toContain('·');
    expect(infoCard).not.toContain('<asset>');
    expect(infoCard).not.toContain('<Ready>');
  });

  it('uses supplied URLs for reset and pagination links without rebuilding query strings in the template', () => {
    const model = {
      filters: {
        projectId: 2,
        categories: ['renders'],
        tags: [7],
        search: 'shared',
        extensions: ['png'],
        presence: 'present',
        usage: 'used',
        sort: 'project',
        order: 'desc',
        view: 'list',
      },
      presentation: { view: 'list' },
      page: 2,
      pageSize: 50,
      pageCount: 3,
      hasPreviousPage: true,
      hasNextPage: true,
      tagOptions: [{ value: '7', displayName: 'Context Tag', selected: true }],
    };
    const clearUrl = '/asset-viewer?resetFilters=1&view=list';
    const html = renderPage({ ...model, clearFiltersUrl: clearUrl });
    const state = {
      ...model.filters,
      page: model.page,
      pageSize: model.pageSize,
      presentation: {
        view: 'list',
        sort: { state: 'valid' },
        order: { state: 'valid' },
        pageSize: { state: 'valid' },
      },
    };
    const previousUrl = buildAssetLibraryUrl(state, { page: 1 });
    const nextUrl = buildAssetLibraryUrl(state, { page: 3 });

    expect(html).toContain(`href="${href(previousUrl)}"`);
    expect(html).toContain(`href="${href(nextUrl)}"`);
    expect(html).toContain(`action="${href(clearUrl)}"`);
    expect(html).toMatch(/<nav class="pagination"[^>]*aria-label="Asset Viewer pages">/);
    expect(html).toContain('Page 2 of 3');
  });

  it('renders distinct unfiltered and filtered empty states, with a reset link only for filtered results', () => {
    const unfiltered = renderPage({ assets: [], total: 0 });
    expect(unfiltered).toContain('No assets across active projects');
    expect(unfiltered).not.toContain('No assets match the current filters');
    expect(unfiltered).not.toMatch(/<div class="empty-state-actions">/);
    expect(unfiltered).not.toContain('Manually scan project files');

    const filtered = renderPage({
      assets: [],
      total: 0,
      hasAnyAssets: true,
      filters: { search: 'missing-name' },
    });
    const reset = filtered.match(/<a\b[^>]*data-asset-library-reset[^>]*>Reset<\/a>/)?.[0] ?? '';
    expect(filtered).toContain('No assets match the current filters');
    expect(reset).toContain('href="/asset-viewer?resetFilters=1&amp;view=grid"');
    expect(reset).toContain('data-asset-library-reset');
    expect(filtered).not.toContain('No assets across active projects');
  });

  it('wraps the content area in a live region with a status element', () => {
    const html = renderPage();
    expect(html).toContain('data-asset-library-live-region');
    expect(html).toMatch(/<span class="sr-only" data-asset-library-live-status aria-live="polite" aria-atomic="true"><\/span>/);
    const regionStart = html.indexOf('data-asset-library-live-region');
    const formStart = html.indexOf('id="asset-filters"');
    const gridStart = html.indexOf('class="asset-grid"');
    expect(regionStart).toBeLessThan(formStart);
    expect(regionStart).toBeLessThan(gridStart);
  });

  it('renders accessible shared tooltip-only view-switcher links in icon mode', () => {
    const html = renderPage();
    const switcher = html.match(/<nav class="view-switcher" aria-label="Asset display">[\s\S]*?<\/nav>/)?.[0] ?? '';
    const links = switcher.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];

    expect(links).toHaveLength(2);
    expect(links[0]).toContain('class="view-switcher-option view-switcher-option--icon asset-tooltip asset-tooltip--right"');
    expect(links[0]).toMatch(/href="\/asset-viewer\?[^\"]*view=grid(?:&amp;[^\"]*)?"/);
    expect(links[0]).toContain('aria-current="page"');
    expect(links[0]).toContain('aria-label="Grid view"');
    expect(links[0]).toContain('data-tooltip="Grid view"');
    expect(links[1]).toMatch(/href="\/asset-viewer\?[^\"]*view=list(?:&amp;[^\"]*)?"/);
    expect(links[1]).not.toContain('aria-current');
    expect(links[1]).toContain('aria-label="List view"');
    expect(links[1]).toContain('data-tooltip="List view"');
    expect(switcher).not.toMatch(/\btitle=/);
  });

  it('keeps shared tooltips readable and unclipped without losing switcher corner rounding', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');

    expect(css).toMatch(/\.asset-tooltip\[data-tooltip\]::after\s*\{[^}]*font-size:\s*0\.875rem/);
    expect(css).toMatch(/\.asset-tooltip\[data-tooltip\]:focus-visible::after\s*\{[^}]*opacity:\s*1/);
    expect(css).toMatch(/\.view-switcher\s*\{[^}]*border-radius:\s*var\(--radius-md\);[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.view-switcher-option:first-child\s*\{[^}]*border-radius:\s*var\(--radius-md\) 0 0 var\(--radius-md\)/);
    expect(css).toMatch(/\.view-switcher-option:last-child\s*\{[^}]*border-radius:\s*0 var\(--radius-md\) var\(--radius-md\) 0/);
  });

  it('renders interactive grid-size labels as buttons when in grid view', () => {
    const html = renderPage();
    expect(html).toMatch(/<button[^>]+data-grid-size-option-label/);
    expect(html).toMatch(/aria-pressed="(true|false)"/);

    const listHtml = renderPage({ filters: { view: 'list' }, presentation: { view: 'list' } });
    expect(listHtml).not.toMatch(/<button[^>]+data-grid-size-option-label/);
  });

  it('renders the NSFW toggle form in the toolbar', () => {
    const html = renderPage({ _csrf: 'test-csrf', nsfwFilterEnabled: false });

    expect(html).toContain('data-asset-library-nsfw-filter');
    expect(html).toContain('action="/asset-viewer/nsfw-filter"');
    expect(html).toContain('data-asset-library-nsfw-toggle');
    expect(html).toContain('data-asset-library-nsfw-value');
    expect(html).toMatch(/name="_csrf" value="test-csrf"/);

    const toggle = html.match(/<button[^>]*data-asset-library-nsfw-toggle[^>]*>/)?.[0] ?? '';
    expect(toggle).toContain('aria-pressed="false"');
    expect(toggle).toContain('aria-label="Enable NSFW filter"');
    expect(toggle).toContain('data-tooltip="Enable NSFW filter"');
  });

  it('renders the NSFW toggle as pressed when filter is enabled', () => {
    const html = renderPage({ _csrf: 'test-csrf', nsfwFilterEnabled: true });

    const toggle = html.match(/<button[^>]*data-asset-library-nsfw-toggle[^>]*>/)?.[0] ?? '';
    expect(toggle).toContain('aria-pressed="true"');
    expect(toggle).toContain('aria-label="Disable NSFW filter"');

    const valueInput = html.match(/<input[^>]*data-asset-library-nsfw-value[^>]*>/)?.[0] ?? '';
    expect(valueInput).toContain('value="0"');
  });

  it('applies NSFW blur class to grid preview images when asset has nsfwBlur', () => {
    const html = renderPage({
      assets: [{
        ...alphaAsset,
        nsfwBlur: true,
      }],
    });
    expect(html).toContain('asset-image--nsfw-blurred');

    const clean = renderPage({
      assets: [{
        ...alphaAsset,
        nsfwBlur: false,
      }],
    });
    expect(clean).not.toContain('asset-image--nsfw-blurred');
  });

  it('applies NSFW blur class to list preview images when asset has nsfwBlur', () => {
    const html = renderPage({
      filters: { view: 'list' },
      presentation: { view: 'list' },
      assets: [{
        ...alphaAsset,
        nsfwBlur: true,
      }],
    });
    expect(html).toContain('asset-image--nsfw-blurred');
  });

  it('project complete-category table opts preview thumbnails into the slideshow', () => {
    const html = renderProjectAssetsPage({
      assets: [{
        id: 73,
        filename: 'table-preview.png',
        displayFilename: 'table-preview',
        extension: 'png',
        typeLabel: 'PNG',
        is_present: true,
        hasThumbnail: true,
        thumbnail_url: '/projects/1/assets/73/thumbnail?v=table',
        preview: { kind: 'image' },
        viewerUrl: '/projects/1/assets/73',
        releaseSummary: { mode: 'none' },
        tags: [],
        categoryLabel: 'Renders',
        categoryDisabled: false,
        presenceLabel: 'Present',
      }],
      total: 1,
      filters: { view: 'list' },
      categoryCapabilities: {
        hasCompleteCategoryMembership: true,
        canReorderCategory: false,
        canAutoRename: false,
        category: null,
      },
      submittedSelectedAssetIds: [],
    });

    expect(html).toContain('class="asset-list-card-media-link" href="/projects/1/assets/73" aria-label="View preview of table-preview.png from Test Project" data-project-assets-preview-id="73"');
    expect(html).toMatch(/class="calendar-release-info-actions">\s*<a class="button button-small button-secondary" href="\/projects\/1\/assets\/73">Open asset<\/a>/);
    expect(html).not.toContain('asset-details-link');
  });

  it('WP9b: renders one Filters & Defaults dialog with three sections and the exact footer', () => {
    const html = renderPage({ _csrf: 'test-csrf' });
    const dialogHtml = dialogMarkup(html);
    const footer = dialogHtml.match(/<footer class="app-dialog-footer filters-defaults-footer">[\s\S]*?<\/footer>/)?.[0] || '';

    expect((html.match(/<dialog id="asset-viewer-filter-dialog"/g) || [])).toHaveLength(1);
    expect(html).not.toContain('id="asset-viewer-defaults-dialog"');
    expect(dialogHtml).toMatch(/<h2 id="asset-viewer-filter-dialog-title">Filters &amp; Defaults<\/h2>\s*<p class="app-dialog-subtitle">Asset Library<\/p>/);
    expect(dialogHtml).toContain('aria-label="Close Filters &amp; Defaults"');
    expect((dialogHtml.match(/data-dialog-close/g) || [])).toHaveLength(1);
    expect([...dialogHtml.matchAll(/<section class="filters-defaults-section"[^>]*>\s*<h3[^>]*>([^<]+)<\/h3>/g)].map(([, heading]) => heading))
      .toEqual(['Filters', 'Sort options', 'Miscellaneous']);

    const sections = dialogHtml.split('<section class="filters-defaults-section"').slice(1);
    const legends = (markup) => [...markup.matchAll(/<legend>([^<]+)<\/legend>|<label for="asset-library-search">([^<]+)<\/label>/g)]
      .map(([, legend, label]) => legend || label);
    expect(legends(sections[0])).toEqual(['Search', 'Projects', 'Project Types', 'Category', 'Presence', 'Release usage', 'Tag', 'Extension']);
    expect(legends(sections[1])).toEqual(['Sort by', 'Sort order']);
    expect(legends(sections[2])).toEqual(['View', 'Grid style', 'Assets per page']);

    // R1: exactly Save new defaults | Reset defaults | Reset filters in DOM
    // (and so Tab) order; no Cancel. Save and Reset defaults are secondary,
    // Reset filters carries the footer's primary treatment.
    expect([...footer.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(([, label]) => label.trim()))
      .toEqual(['Save new defaults', 'Reset defaults', 'Reset filters']);
    expect([...footer.matchAll(/<button class="([^"]+)"/g)].map(([, cls]) => cls))
      .toEqual(['button button-secondary', 'button button-secondary', 'button button-primary']);
    expect(dialogHtml).not.toMatch(/>\s*(?:Cancel|Apply|Done|Close)\s*</);
    expect(footer).toContain('<button class="button button-primary" type="submit" data-asset-library-filters-reset>Reset filters</button>');
    // F3: JavaScript-only Reset defaults — disabled type="button", no form.
    expect(footer).toContain('<button class="button button-secondary" type="button" disabled data-asset-library-defaults-reset>Reset defaults</button>');
    // F2: JavaScript-only Save — never a native submit control; rendered
    // disabled until the explicit-save controller arms it.
    expect(footer).toContain('<button class="button button-secondary" type="button" disabled data-asset-library-defaults-save>Save new defaults</button>');
    expect(footer).not.toContain('form="asset-viewer-defaults-form"');
    expect(footer).toMatch(/<form class="asset-viewer-filter-reset filters-defaults-reset-form" method="get" action="[^"]*resetFilters=1[^"]*">\s*<input type="hidden" name="resetFilters" value="1">/);
    expect(footer).not.toContain('asset-viewer-defaults-reset-form');
    expect(footer).not.toContain('/asset-viewer/defaults/reset');
    expect(footer).not.toMatch(/method="post"/);
    expect(footer).not.toContain('data-asset-library-defaults-native');
    // Reset filters is the WP9a transport hook, not the engine's link hook.
    expect(footer).not.toContain('data-asset-library-reset');
  });

  it('WP9b: opts the defaults form into explicit save and retires the autosave contract', () => {
    const html = renderPage({
      _csrf: 'test-csrf',
      assetViewerDefaultsGeneration: 12,
      assetViewerDefaultsReturnUrl: '/asset-viewer?project=1&project=2&type=comic&type=images&usage=used',
      assetViewerDefaultsAuthority: {
        fields: ['view', 'gridStyle', 'sort', 'order', 'pageSize', 'extension', 'category', 'presence', 'tag'],
        savedKeys: ['view', 'sort'],
        current: {
          view: 'list', gridStyle: 'cropped', sort: 'project', order: 'desc', pageSize: '50',
          extension: ['jpg', 'png'], category: 'all', presence: 'present', tag: ['7'],
        },
      },
    });
    const form = html.match(/<form id="asset-viewer-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';

    // F2: no native mutation — a native submission only closes the dialog.
    expect(form).toMatch(/^<form id="asset-viewer-defaults-form" method="dialog" class="filters-defaults-defaults-form"\s+data-dialog-form data-dialog-async="false" data-defaults-explicit-save novalidate>/);
    expect(form).not.toMatch(/\baction=|method="post"/);
    expect(form).not.toContain('data-asset-viewer-defaults-autosave');
    expect(html).not.toContain('data-asset-viewer-defaults-autosave');
    expect(html).not.toContain('data-autosubmit');
    expect(form).toContain('<input type="hidden" name="_csrf" value="test-csrf">');
    expect(form).toContain('data-settings-fetch-save-status role="status" aria-live="polite" aria-atomic="true"');
    expect(form).toMatch(/<p class="filters-defaults-saved-indicator" data-asset-library-defaults-indicator>2 of 9 defaults saved\.<\/p>/);
    // No Global / Project-only scope selector on the Asset Library.
    expect(html).not.toContain('filters-defaults-scope');
    expect(html).not.toMatch(/name="scope"/);
    // No visible defaults controls, and (F2) no hidden snapshot a native
    // POST could send: the controller builds the snapshot from the installed
    // authority at Save time.
    expect(form).not.toContain('data-cc-dropdown');
    expect(form).not.toContain('data-asset-library-defaults-native');
    expect(form).not.toMatch(/name="(?:view|gridStyle|sort|order|pageSize|extension|category|presence|tag|defaultsGeneration|returnTo)"/);
    // Temporary filters are never part of the defaults form.
    expect(form).not.toMatch(/name="(?:project|type|search|usage)"/);
    // F3: Reset defaults renders no native form or generation/returnTo
    // fields; the controller sends the authority's generation.
    expect(html).not.toContain('asset-viewer-defaults-reset-form');
    expect(html).not.toContain('name="defaultsGeneration"');
    expect(html).not.toContain('/asset-viewer/defaults/reset');
    expect(html).not.toContain('data-asset-library-defaults-native');
  });

  it('WP9b: Grid style is an unnamed session control that never joins the GET', () => {
    const html = renderPage({ gridStyle: 'cropped' });
    const field = html.match(/<fieldset[^>]*data-asset-library-grid-style-field[\s\S]*?<\/fieldset>/)?.[0] || '';

    expect(field).toMatch(/<select id="asset-library-grid-style" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Grid style" data-asset-library-grid-style>/);
    expect(field).not.toMatch(/name="/);
    expect(field).toMatch(/<option value="cropped" selected>Cropped<\/option>/);
    expect(field).toContain('data-cc-dropdown-dispatch-native-change');
    expect(html).toContain('data-grid-style="cropped"');
  });

  it('R2: Grid style starts visible for Grid and hidden (not removed, disabled or renamed) for List', () => {
    const fieldOf = (html) => html.match(/<fieldset[^>]*data-asset-library-grid-style-field[\s\S]*?<\/fieldset>/)?.[0] || '';
    const openTag = (html) => html.match(/<fieldset[^>]*data-asset-library-grid-style-field[^>]*>/)?.[0] || '';

    const grid = renderPage({ gridStyle: 'cropped' });
    expect(openTag(grid)).toContain('data-filters-visible-when-view="grid"');
    expect(openTag(grid)).not.toMatch(/\shidden(\s|>|=)/);
    expect(grid).toMatch(/name="view"[^>]*value="grid"[^>]*checked/);

    const list = renderPage({ gridStyle: 'cropped', filters: { view: 'list' }, presentation: { view: 'list' } });
    expect(openTag(list)).toContain('data-filters-visible-when-view="grid"');
    expect(openTag(list)).toMatch(/\shidden(\s|>|=)/);
    expect(list).toMatch(/name="view"[^>]*value="list"[^>]*checked/);
    const field = fieldOf(list);
    // Hidden is presentation only: the same control, value and identity.
    expect(field).toMatch(/<select id="asset-library-grid-style" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Grid style" data-asset-library-grid-style>/);
    expect(field).toMatch(/<option value="cropped" selected>Cropped<\/option>/);
    expect(field).not.toContain('disabled');
    // View and Assets per page stay visible in List.
    const fieldsets = [...list.matchAll(/<fieldset[^>]*>\s*<legend>([^<]+)<\/legend>/g)];
    ['View', 'Assets per page'].forEach((legend) => {
      const tag = fieldsets.find((match) => match[1] === legend)?.[0] || '';
      expect(tag).not.toBe('');
      expect(tag).not.toMatch(/\shidden(\s|>|=)/);
    });
  });

  it('WP9b: shows saved-state presence, not value equality, in the initial indicator', () => {
    const fields = ['view', 'gridStyle', 'sort', 'order', 'pageSize', 'extension', 'category', 'presence', 'tag'];
    const indicator = (savedKeys) => renderPage({ assetViewerDefaultsAuthority: { fields, savedKeys, current: null } })
      .match(/data-asset-library-defaults-indicator>([^<]*)</)?.[1];
    expect(indicator([])).toBe('No saved defaults.');
    expect(indicator(fields)).toBe('Defaults saved.');
    expect(indicator(['gridStyle'])).toBe('1 of 9 defaults saved.');
  });

  it('does not render a no-JavaScript Filter submit fallback', () => {
    const html = renderPage();
    expect(html).not.toContain('<noscript>');
  });
});

const PROJECT_ASSETS_PATH = path.join(VIEWS_DIR, 'projects', 'assets.njk');

function renderProjectAssetsPage(overrides = {}) {
  const project = overrides.project ?? { id: 1, title: 'Test Project', archived_at: null };
  const filters = {
    view: 'grid', category: 'all', presence: 'all', usage: 'all',
    sort: 'filename', order: 'asc',
    ...overrides.filters,
  };
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  env.addFilter('formatIsoTimestamp', formatIsoTimestamp);
  env.addFilter('formatSqliteTimestamp', formatSqliteTimestamp);
  return env.render('projects/assets.njk', {
    project,
    assets: [],
    total: 0,
    page: 1,
    pageSize: 25,
    pageCount: 0,
    hasPreviousPage: false,
    hasNextPage: false,
    filters,
    context: {},
    contextFields: [],
    categoryNavigation: { totalCount: 0, missingCount: 0, uncategorizedCount: 0, enabled: [], disabled: [] },
    categoryOptions: [],
    tagOptions: [],
    presenceOptions: [],
    usageOptions: [],
    sortOptions: [],
    orderOptions: [],
    pageSizeOptions: [],
    preserveViewQuery: false,
    preservePageSizeQuery: false,
    pageUrl: () => '/test',
    projectAssetsDefaults: { fields: [] },
    projectAssetsDefaultsDialogOpen: false,
    resetFiltersUrl: `/projects/${project.id}/assets?resetFilters=1&view=${filters.view}`,
    projectAssetsDefaultsReturnUrl: '/projects/1/assets',
    projectAssetsDefaultsUrl: '/projects/1/assets?defaults=1',
    nsfwFilterEnabled: false,
    projectAssetsNsfwReturnUrl: '/projects/1/assets',
    _csrf: 'test-csrf',
    appName: 'CreatorCrate',
    auth: { enabled: false, authenticated: false },
    shell: { appName: 'CreatorCrate', activeSection: 'Projects', navigation: [] },
    ...overrides,
    filters,
    project,
  });
}

describe('Project Assets Asset Information popup', () => {
  const projectAsset = {
    ...alphaAsset,
    displayFilename: 'shared',
    viewerUrl: '/projects/1/assets/101',
    categoryLabel: 'Renders',
    categoryDisabled: false,
    typeLabel: 'PNG',
    locationLabel: 'renders',
    presenceLabel: 'Present',
    releaseSummary: {
      mode: 'some',
      releases: [{ release_id: 301, title: 'Alpha Release', role: 'primary' }],
    },
    tags: [{ displayName: 'Assigned only' }],
    effectiveTags: [{ displayName: 'Inherited project tag', origin: 'inherited' }],
  };

  it.each([
    ['ordinary', false],
    ['complete-category', true],
  ])('renders the shared popup on %s grid cards without a bottom body', (_surface, completeCategorySurface) => {
    const html = renderProjectAssetsPage({
      assets: [projectAsset],
      total: 1,
      categoryCapabilities: {
        hasCompleteCategoryMembership: completeCategorySurface,
        canReorderCategory: completeCategorySurface,
        canAutoRename: completeCategorySurface,
        category: completeCategorySurface
          ? { categoryId: 5, displayName: 'Renders', orderedAssetIds: [101], orderedAssetIdsJson: '[101]' }
          : null,
      },
      submittedSelectedAssetIds: [],
    });
    const card = html.match(/<article class="asset-card asset-card--project[\s\S]*?<\/article>/)?.[0] ?? '';
    const info = card.slice(card.indexOf('<div class="asset-viewer-grid-card-info"'));

    expect(card).toMatch(/class="asset-card-media[^"\n]*" data-asset-viewer-preview data-preview-enhancement/);
    expect(card).toMatch(/data-asset-viewer-preview[\s\S]*data-asset-info-card popover="manual"/);
    expect((card.match(/data-asset-info-card/g) || [])).toHaveLength(1);
    expect(info).not.toContain('<dt>Project</dt>');
    for (const field of ['Filename', 'Category', 'Extension', 'Size', 'Dimensions', 'Modified', 'Release usage']) {
      expect(info).toContain(`<dt>${field}</dt>`);
    }
    expect(info).toContain('1920 × 1080');
    expect(info).toContain('Used in 2 releases');
    expect(info).toContain('Inherited project tag');
    expect(info).toContain('<span class="asset-viewer-grid-card-info-section-label">Project</span>');
    expect(info).toContain('>In Progress</span>');
    expect(info).toContain('>Illustration</span>');

    expect(card).toContain('class="asset-card-top"');
    expect(card).not.toContain('class="asset-indicator');
    expect(card).not.toContain('class="asset-card-usage"');
    expect(card).toContain('class="asset-details-link asset-details-link--present asset-tooltip asset-tooltip--right" href="/projects/1/assets/101"');
    expect(card).toMatch(/aria-label="Asset details \| File present"\s+data-tooltip="Asset details \| File present"/);
    expect(card).toContain('class="asset-card-media-link" href="/projects/1/assets/101"');
    expect(card).toContain('data-project-assets-preview-id="101"');
    expect(card).toContain('class="asset-select-checkbox"');
    expect(card).not.toContain('data-asset-rename-trigger');
    expect(card).not.toContain('data-asset-rename-editor');
    expect(card).not.toContain('class="asset-card-body"');
    expect(card).not.toContain('asset-card-title-controls');
    expect(card).not.toContain('asset-card-primary-metadata');
    expect(card).not.toContain('asset-card-associations-region');
    expect(card).not.toContain('Assigned only');
    if (completeCategorySurface) {
      expect(html).toContain('data-auto-rename-asset-id="101"');
      expect(html).toMatch(/data-auto-rename-asset-id="101"[\s\S]*?draggable="true"[\s\S]*?tabindex="0"/);
    }
  });

  it('exposes the authoritative complete category order on the ordering surface and Auto Rename form for a filtered subset', () => {
    const fullOrder = [205, 101, 309];
    const html = renderProjectAssetsPage({
      _csrf: 'test-csrf',
      assets: [projectAsset],
      total: 1,
      page: 1,
      pageCount: 2,
      categoryCapabilities: {
        hasCompleteCategoryMembership: false,
        canReorderCategory: true,
        canAutoRename: true,
        category: {
          categoryId: 5,
          displayName: 'Renders',
          directorySlug: 'renders',
          orderedAssetIds: fullOrder,
          orderedAssetIdsJson: JSON.stringify(fullOrder),
        },
      },
      submittedSelectedAssetIds: [],
    });
    const surface = html.match(/<section class="asset-auto-rename-surface"[^>]*>/)?.[0] ?? '';

    expect(surface).toContain('data-auto-rename-base-order="[205,101,309]"');
    expect(surface).toContain('data-category-membership-complete="false"');
    expect(surface).toContain('data-category-reorder-enabled="true"');
    expect(surface).toContain('data-auto-rename-enabled="true"');
    expect((html.match(/data-auto-rename-base-order=/g) || [])).toHaveLength(1);

    // One Auto Rename form, initialized from the same complete sequence.
    expect((html.match(/<form id="auto-rename-assets-form"/g) || [])).toHaveLength(1);
    expect(html).toMatch(/<input type="hidden" name="orderedAssetIds" value="\[205,101,309\]"\s+data-auto-rename-order-input>/);
    expect(html).toContain('<input type="hidden" name="categoryId" value="5">');
    // Only the visible asset is an ordering item; hidden members exist only in the order.
    expect(html.match(/data-auto-rename-asset-id="(\d+)"/g)).toEqual(['data-auto-rename-asset-id="101"']);
    // Incomplete membership keeps pagination.
    expect(html).toContain('class="pagination-next"');
  });

  it('submits the shared browsing context with Auto Rename Preview without duplicating category or view', () => {
    const html = renderProjectAssetsPage({
      _csrf: 'test-csrf',
      assets: [projectAsset],
      total: 1,
      filters: { view: 'list' },
      context: {
        category: '5',
        tag: ['7', '8'],
        search: 'hero',
        extension: ['png'],
        presence: 'all',
        usage: 'all',
        sort: 'modified',
        order: 'desc',
        page: 2,
        pageSize: 50,
        view: 'list',
        inheritedFilterDefaults: 'tag',
      },
      contextFields: ['category', 'tag', 'search', 'extension', 'presence', 'usage', 'sort', 'order', 'page', 'pageSize', 'view', 'inheritedFilterDefaults'],
      categoryCapabilities: {
        hasCompleteCategoryMembership: false,
        canReorderCategory: true,
        canAutoRename: true,
        category: {
          categoryId: 5,
          displayName: 'Renders',
          directorySlug: 'renders',
          orderedAssetIds: [101],
          orderedAssetIdsJson: '[101]',
        },
      },
      submittedSelectedAssetIds: [],
    });
    const form = html.match(/<form id="auto-rename-assets-form"[\s\S]*?<\/form>/)?.[0] ?? '';
    const values = (name) => [...form.matchAll(new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`, 'g'))]
      .map((match) => match[1]);

    expect(values('_csrf')).toEqual(['test-csrf']);
    expect(values('categoryId')).toEqual(['5']);
    expect(values('orderedAssetIds')).toEqual(['[101]']);
    expect(values('selectedAssetIds')).toEqual(['[]']);
    expect(values('category')).toEqual([]);
    expect(values('view')).toEqual(['list']);
    expect(values('tag')).toEqual(['7', '8']);
    expect(values('search')).toEqual(['hero']);
    expect(values('extension')).toEqual(['png']);
    expect(values('sort')).toEqual(['modified']);
    expect(values('order')).toEqual(['desc']);
    expect(values('page')).toEqual(['2']);
    expect(values('pageSize')).toEqual(['50']);
    expect(values('inheritedFilterDefaults')).toEqual(['tag']);
  });

  it('maps missing Project Assets Details status while preserving List presence and release information', () => {
    const missingAsset = {
      ...projectAsset,
      is_present: 0,
      presenceLabel: 'Missing at last scan',
    };
    const gridHtml = renderProjectAssetsPage({ assets: [missingAsset], total: 1, submittedSelectedAssetIds: [] });
    const listHtml = renderProjectAssetsPage({
      assets: [missingAsset],
      total: 1,
      filters: { view: 'list' },
      submittedSelectedAssetIds: [],
    });
    const gridCard = gridHtml.match(/<article class="asset-card asset-card--project[\s\S]*?<\/article>/)?.[0] ?? '';
    const listCard = listHtml.match(/<article class="asset-list-card asset-list-card--project[\s\S]*?<\/article>/)?.[0] ?? '';

    expect(gridCard).not.toContain('class="asset-indicator');
    expect(gridCard).not.toContain('class="asset-card-usage"');
    expect(gridCard).toContain('class="asset-details-link asset-details-link--missing asset-tooltip asset-tooltip--right" href="/projects/1/assets/101"');
    expect(gridCard).toMatch(/aria-label="Asset details \| File missing!"\s+data-tooltip="Asset details \| File missing!"/);
    expect(gridCard).toContain('Used in 2 releases');
    expect(listCard).toContain('asset-indicator--missing');
    expect(listCard).toContain('class="asset-list-card-release-usage"');
    expect(listCard).toContain('Alpha Release');
    expect(listCard).not.toContain('asset-details-link');
  });

  it('does not render the Project Assets Details control', () => {
    const html = renderProjectAssetsPage();

    expect(html).not.toContain('id="asset-grid-details-toggle"');
    expect(html).not.toContain('data-asset-grid-details-toggle');
    expect(html).not.toContain('class="asset-grid-details-control"');
  });

  it('uses the shared renderer with Project-name omission while leaving Asset Viewer defaults unchanged', () => {
    const projectSource = fs.readFileSync(PROJECT_ASSETS_PATH, 'utf8');
    const assetViewerSource = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    expect(projectSource).toContain('{% import "partials/asset-information.njk" as assetInformation %}');
    expect(projectSource).toContain('{{ assetInformation.render(asset, { showProjectName: false }) }}');
    expect(assetViewerSource).toContain('{{ assetInformation.render(asset) }}');
  });
});

describe('slideshow scaffold — static UI', () => {
  it('asset-viewer page: Reset is inside the Filter dialog rather than the toolbar', () => {
    const html = renderPage();
    const toolbarDiv = html.match(/<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>/)?.[0] ?? '';
    const filterDialog = html.slice(html.indexOf('<dialog id="asset-viewer-filter-dialog"'));
    expect(toolbarDiv).toContain('data-asset-library-slideshow-trigger');
    expect(toolbarDiv).not.toContain('data-asset-library-reset');
    expect(toolbarDiv).not.toContain('data-asset-library-filters-reset');
    expect(filterDialog).toContain('data-asset-library-filters-reset');
  });

  it('asset-viewer page: slideshow trigger has accessible label and styled tooltip', () => {
    const html = renderPage();
    const trigger = html.match(/<button\b[^>]*data-asset-library-slideshow-trigger[^>]*>/)?.[0] ?? '';
    expect(trigger).toContain('aria-label="Start slideshow"');
    expect(trigger).toContain('data-tooltip="Start slideshow"');
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).not.toContain('title=');
  });

  it('both asset pages use button-small sizing for Slideshow', () => {
    const viewerTriggerClass = renderPage().match(/<button class="([^"]*\bslideshow-trigger\b[^"]*)"[^>]*data-asset-library-slideshow-trigger/)?.[1] ?? '';
    const projectTriggerClass = renderProjectAssetsPage().match(/<button class="([^"]*\bslideshow-trigger\b[^"]*)"[^>]*data-project-assets-slideshow-trigger/)?.[1] ?? '';
    expect(viewerTriggerClass).toContain('button-secondary');
    expect(viewerTriggerClass).toContain('button-small');
    expect(projectTriggerClass).toContain('button-secondary');
    expect(projectTriggerClass).toContain('button-small');

    expect(css).toMatch(/\.slideshow-trigger\s*\{[^}]*margin-inline-end:\s*var\(--space-xs\)/);
    expect(css).not.toMatch(/\.slideshow-trigger\s*\{[^}]*line-height:/);
    expect(css).toMatch(/\.asset-viewer-display-controls\s+\.project-filter-actions\s*\{[^}]*gap:\s*var\(--space-sm\)/);
  });

  // Only the unified viewer owns image activation.
  it('asset-viewer page: the unified viewer replaces the legacy slideshow scaffold', () => {
    const entries = [
      { id: 101, projectId: 1, filename: 'shared.png', previewUrl: '/projects/1/assets/101/preview?v=a', viewerUrl: '/projects/1/assets/101', revision: 'a' },
      { id: 202, projectId: 2, filename: 'shared.png', previewUrl: '/projects/2/assets/202/preview?v=b', viewerUrl: '/projects/2/assets/202', revision: 'b' },
    ];
    const html = renderPage({ slideshowSequenceJson: JSON.stringify(entries) });
    expect(html).not.toContain('data-slideshow-scaffold');
    expect(html).not.toContain('data-slideshow-trigger');
    expect(html).not.toContain('data-slideshow-play-pause');
    expect(html).not.toContain('data-slideshow-preview');
    expect(html).not.toContain('data-project-assets-preview-id');
    expect(html).not.toContain('data-project-assets-slideshow-trigger');
    expect(html).not.toContain('data-project-assets-viewer-sequence');
    expect(html.match(/<dialog id="unified-viewer-dialog"/g)).toHaveLength(1);
  });

  it('asset-viewer page: the viewer offers fullscreen, original size and 2/4/6 s speeds', () => {
    const viewer = renderPage().match(/<dialog id="unified-viewer-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
    expect(viewer).toContain('data-unified-viewer-fullscreen');
    expect(viewer).toContain('aria-label="Enter fullscreen"');
    expect(viewer).toContain('data-unified-viewer-original');
    const speedSelect = viewer.match(/<select[^>]*data-unified-viewer-speed[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(speedSelect).toContain('value="2000"');
    expect(speedSelect).toMatch(/value="4000" selected/);
    expect(speedSelect).toContain('value="6000"');
  });

  it('asset-viewer page: the sequence and viewer dialog stay outside the replaceable live region', () => {
    const html = renderPage();
    const regionStart = html.indexOf('<div data-asset-library-live-region>');
    const filterDialogStart = html.indexOf('<dialog id="asset-viewer-filter-dialog"');
    const sequenceStart = html.indexOf('data-asset-library-viewer-sequence');
    const viewerStart = html.indexOf('<dialog id="unified-viewer-dialog"');
    expect(regionStart).toBeGreaterThan(-1);
    // The Slideshow button is region content; the overlay block (filter and
    // defaults dialogs, then the sequence) and the layout-mounted viewer
    // follow the region, so a replacement can never remove them.
    const trigger = html.indexOf('data-asset-library-slideshow-trigger');
    expect(trigger).toBeGreaterThan(regionStart);
    expect(trigger).toBeLessThan(filterDialogStart);
    expect(html).not.toContain('<dialog id="asset-viewer-defaults-dialog"');
    expect(sequenceStart).toBeGreaterThan(filterDialogStart);
    expect(viewerStart).toBeGreaterThan(sequenceStart);
  });

  it('asset-viewer page: toolbar has Filters & Defaults, NSFW, and Slideshow controls', () => {
    const html = renderPage({ _csrf: 'test-csrf', nsfwFilterEnabled: false });
    expect(html).toContain('data-dialog-open="asset-viewer-filter-dialog"');
    expect(html).not.toContain('data-dialog-open="asset-viewer-defaults-dialog"');
    expect(html).toContain('data-asset-library-nsfw-toggle');
    expect(html).toContain('data-asset-library-slideshow-trigger');
    expect(html).toContain('data-asset-library-filters-reset');
    expect(html).not.toContain('href="/asset-viewer?defaults=1"');
    expect(html).not.toContain('<noscript>');
  });

  it('project assets page: slideshow trigger exists before Filter in DOM order', () => {
    const html = renderProjectAssetsPage();
    const triggerPos = html.indexOf('data-project-assets-slideshow-trigger');
    const filterPos = html.indexOf('id="asset-filters"');
    expect(triggerPos).toBeGreaterThan(-1);
    expect(filterPos).toBeGreaterThan(-1);
    expect(triggerPos).toBeLessThan(filterPos);
  });

  it('project assets page: slideshow trigger has accessible label and tooltip', () => {
    const html = renderProjectAssetsPage();
    const trigger = html.match(/<button\b[^>]*data-project-assets-slideshow-trigger[^>]*>/)?.[0] ?? '';
    expect(trigger).toContain('aria-label="Start slideshow"');
    expect(trigger).toContain('data-tooltip="Start slideshow"');
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).not.toContain('title=');
  });

  // Project Assets shares the same viewer dialog as the other image hosts.
  it('project assets page: the unified viewer replaces the legacy slideshow scaffold', () => {
    const entries = [{ id: 5, projectId: 1, filename: 'a.png', previewUrl: '/p/5' }];
    const html = renderProjectAssetsPage({ slideshowSequenceJson: JSON.stringify(entries) });
    expect(html).not.toContain('data-slideshow-scaffold');
    expect(html).not.toContain('data-slideshow-trigger');
    expect(html).not.toContain('data-slideshow-play-pause');
    expect(html.match(/<dialog id="unified-viewer-dialog"/g)).toHaveLength(1);

    const sequence = html.match(/<script[^>]*data-project-assets-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(sequence?.[0]).toContain('type="application/json"');
    expect(sequence?.[0]).toContain('data-project-id="1"');
    expect(sequence?.[0]).toContain('data-viewer-label="Test Project"');
    expect(JSON.parse(sequence[1])).toEqual(entries);
    expect(html.match(/data-project-assets-viewer-sequence/g)).toHaveLength(1);
    // The authoritative sequence is page overlay data, after the live region's
    // overlay dialogs rather than inside the replaceable region.
    expect(html.indexOf('data-project-assets-viewer-sequence'))
      .toBeGreaterThan(html.indexOf('<dialog id="project-assets-filter-dialog"'));
  });

  it('project assets page: the viewer offers fullscreen, original size and 2/4/6 s speeds', () => {
    const html = renderProjectAssetsPage();
    const viewer = html.match(/<dialog id="unified-viewer-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
    expect(viewer).toContain('data-unified-viewer-fullscreen');
    expect(viewer).toContain('aria-label="Enter fullscreen"');
    expect(viewer).toContain('data-unified-viewer-original');
    const speedSelect = viewer.match(/<select[^>]*data-unified-viewer-speed[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(speedSelect).toContain('value="2000"');
    expect(speedSelect).toMatch(/value="4000" selected/);
    expect(speedSelect).toContain('value="6000"');
  });

  it('project assets page: the viewer speed uses the compact shared dropdown beside play/pause', () => {
    const html = renderProjectAssetsPage();
    const playback = html.match(/<div class="unified-viewer-playback"[\s\S]*?data-unified-viewer-next/)?.[0] ?? '';
    const playPauseEnd = playback.indexOf('</button>', playback.indexOf('data-unified-viewer-play'));
    const speedFieldStart = playback.indexOf('<fieldset', playPauseEnd);
    const speedDetails = html.match(/<details[^>]*id="unified-viewer-speed-dropdown"[^>]*>/)?.[0] || '';
    const extensionDetails = html.match(/<details[^>]*id="asset-extension-filter"[^>]*>/)?.[0] || '';

    expect(playPauseEnd).toBeGreaterThan(-1);
    expect(speedFieldStart).toBeGreaterThan(playPauseEnd);
    expect(playback.slice(speedFieldStart)).toContain('cc-dropdown-field--compact');
    expect(speedDetails).toContain('cc-dropdown--compact');
    expect(extensionDetails).toContain('cc-dropdown');
    expect(extensionDetails).not.toContain('cc-dropdown--compact');
  });

  it.each(['grid', 'list'])('project assets Reset form consumes the supplied %s URL', (view) => {
    const action = `/projects/1/assets?resetFilters=1&view=${view}`;
    const html = renderProjectAssetsPage({
      filters: { view }, resetFiltersUrl: action,
      emptyState: { kind: 'filtered', title: 'No matches' },
    });
    const filterDialog = html.match(/<dialog id="project-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
    const resetForm = filterDialog.match(/<form class="projects-filter-reset filters-defaults-reset-form"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? '';

    expect(resetForm).toContain(`method="get" action="/projects/1/assets?resetFilters=1&amp;view=${view}"`);
    expect(resetForm).toContain('type="submit" data-project-assets-reset>Reset filters</button>');
  });

  it('project assets page: Filters & Defaults dialog owns the persistent filters and Reset controls', () => {
    const html = renderProjectAssetsPage();
    const filterControl = html.match(/<a[^>]*data-dialog-open="project-assets-filter-dialog"[^>]*>/)?.[0] ?? '';
    const filterDialog = html.match(/<dialog id="project-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';

    expect(filterControl).toContain('href="#project-assets-filter-dialog"');
    expect(filterControl).toContain('aria-label="Filters & Defaults"');
    expect(filterDialog).toContain('<form id="asset-filters" class="filters-defaults-filters" method="get" action="/projects/1/assets">');
    expect(filterDialog).toContain('<form class="projects-filter-reset filters-defaults-reset-form" method="get" action="/projects/1/assets?resetFilters=1&amp;view=grid">');
    expect(filterDialog).toContain('type="submit" data-project-assets-reset>Reset filters</button>');
    expect(html.match(/id="project-assets-filter-dialog"/g)).toHaveLength(1);
    expect(html.match(/id="asset-filters"/g)).toHaveLength(1);
    expect(html.match(/data-project-assets-reset/g)).toHaveLength(1);
    expect(html).not.toContain('type="submit" form="asset-filters"');
    expect(html).not.toContain('>Reset</span>');
    // WP7: the separate Defaults dialog and its cog are gone.
    expect(html).not.toContain('href="/projects/1/assets?defaults=1"');
    expect(html).not.toContain('project-assets-defaults-dialog');
    expect(html.match(/data-dialog-open="project-assets-filter-dialog"/g)).toHaveLength(1);
  });

  it('project assets page: Filters & Defaults keeps the approved structure (WP7)', () => {
    const field = (name, label, options, multi = false) => ({
      name, label, id: `projectAssets-default-${name}`, multi,
      options: options.map((value) => ({ value, label: value })),
      selectedValue: multi ? undefined : options[0], selectedValues: multi ? [] : undefined,
    });
    const html = renderProjectAssetsPage({
      projectAssetsDefaults: {
        fields: [
          field('view', 'View', ['grid', 'list']),
          field('gridStyle', 'Grid style', ['uncropped', 'cropped']),
          field('gridSize', 'Grid size', ['compact', 'default', 'large']),
          field('listSize', 'List size', ['compact', 'large']),
          field('sort', 'Sort', ['filename', 'modified']),
          field('order', 'Order', ['asc', 'desc']),
          field('pageSize', 'Page Size', ['25', 'all']),
          field('extension', 'Extension', ['png'], true),
          field('tag', 'Tag', [], true),
        ],
      },
    });
    const dialog = html.match(/<dialog id="project-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';

    expect(dialog).toMatch(/class="app-dialog app-dialog--utility app-dialog--filters-defaults"/);
    expect(dialog).toContain('<h2 id="project-assets-filter-dialog-title">Filters &amp; Defaults</h2>');
    expect(dialog).toContain('<p class="app-dialog-subtitle">Project Assets</p>');
    expect(dialog).toContain('aria-label="Close Filters &amp; Defaults"');

    // Status row: compact indicator and inline Global / Project only radios.
    const statusRow = dialog.match(/<div class="filters-defaults-status-row">[\s\S]*?<\/fieldset>/)?.[0] ?? '';
    expect(statusRow).toContain('data-project-assets-defaults-indicator');
    expect(statusRow).toContain('<fieldset class="filters-defaults-scope" data-project-assets-defaults-scope>');
    expect(statusRow).toMatch(/class="filters-defaults-scope-option"[\s\S]*?name="scope" value="global"[\s\S]*?Global/);
    expect(statusRow).toMatch(/class="filters-defaults-scope-option"[\s\S]*?name="scope" value="project"[\s\S]*?Project only/);
    expect(dialog).not.toContain('page-defaults-scope-options');
    // Package A U3: the fieldset legend reads "Use default:" and still names the
    // native radio group; the indicator comes first (left column), scope second.
    expect(statusRow).toMatch(/<fieldset class="filters-defaults-scope" data-project-assets-defaults-scope>\s*<legend>Use default:<\/legend>/);
    expect(dialog).not.toContain('Defaults scope:');
    expect(statusRow.indexOf('data-project-assets-defaults-indicator')).toBeLessThan(statusRow.indexOf('<fieldset'));
    const scopeRadios = [...statusRow.matchAll(/<label class="filters-defaults-scope-option" for="([^"]+)">\s*<input id="([^"]+)" type="radio" name="scope" value="(global|project)"/g)];
    expect(scopeRadios.map((match) => match[3])).toEqual(['global', 'project']);
    for (const match of scopeRadios) expect(match[1]).toBe(match[2]);

    // Three boxed sections in order, with their controls in order.
    const headings = [...dialog.matchAll(/<section class="filters-defaults-section"[^>]*>\s*<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
    expect(headings).toEqual(['Filters', 'Sort options', 'Miscellaneous']);
    // User acceptance: the old section titles are gone from this dialog.
    expect(dialog).not.toContain('Available filters');
    expect(dialog).not.toContain('Available sort options');
    const legendsIn = (heading) => {
      const section = dialog.match(new RegExp(`<h3[^>]*>${heading}<\\/h3>[\\s\\S]*?<\\/section>`))?.[0] ?? '';
      return [...section.matchAll(/<legend[^>]*>([^<]+)<\/legend>|<label for="search">(Search)<\/label>/g)]
        .map((match) => match[1] || match[2]);
    };
    expect(legendsIn('Filters')).toEqual(['Category', 'Search', 'Tag', 'Extension', 'Presence', 'Release usage']);
    expect(legendsIn('Sort options')).toEqual(['Sort by', 'Sort order']);
    expect(legendsIn('Miscellaneous')).toEqual(['View', 'Grid style', 'Grid size default', 'List size default', 'Assets per page']);

    // Exactly three footer actions, grouped; no Cancel, Apply, Done or Close.
    const footer = dialog.match(/<footer class="app-dialog-footer filters-defaults-footer">[\s\S]*?<\/footer>/)?.[0] ?? '';
    const actions = [...footer.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1].trim());
    // R1: Save new defaults | Reset defaults | Reset filters, in DOM order.
    expect(actions).toEqual(['Save new defaults', 'Reset defaults', 'Reset filters']);
    expect(footer).toContain('<button class="button button-secondary" type="submit" form="project-assets-defaults-form" data-project-assets-defaults-save>Save new defaults</button>');
    expect(footer).toContain('<button class="button button-secondary" type="button" data-project-assets-defaults-reset');
    expect(footer).toContain('<button class="button button-primary" type="submit" data-project-assets-reset>Reset filters</button>');
    expect([...footer.matchAll(/<button class="([^"]+)"/g)].map(([, cls]) => cls))
      .toEqual(['button button-secondary', 'button button-secondary', 'button button-primary']);
    expect(dialog).not.toMatch(/>\s*(Cancel|Apply|Done)\s*</);
    expect((dialog.match(/<footer/g) || [])).toHaveLength(1);

    // Two owning forms, never nested; Extension and Tag lead with Select all.
    expect(dialog).not.toMatch(/<form[^>]*>(?:(?!<\/form>)[\s\S])*<form/);
    expect(dialog).toMatch(/id="asset-tag-filter"[^>]*data-cc-dropdown-select-all="all"/);
    expect(dialog).toMatch(/id="asset-extension-filter"[^>]*data-cc-dropdown-select-all="all"/);
    expect(dialog).not.toMatch(/id="asset-category-filter"[^>]*data-cc-dropdown-select-all/);
  });
});

describe('slideshow sequence — data contract', () => {
  it('asset-viewer page: renders the authoritative viewer sequence script element', () => {
    const html = renderPage({ slideshowSequenceJson: '[]' });
    expect(html).toContain('data-asset-library-viewer-sequence');
    const scriptMatch = html.match(/<script[^>]*data-asset-library-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => JSON.parse(scriptMatch[1])).not.toThrow();
  });

  it('asset-viewer page: sequence defaults to empty array when slideshowSequenceJson is not provided', () => {
    const html = renderPage();
    const scriptMatch = html.match(/<script[^>]*data-asset-library-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(JSON.parse(scriptMatch[1])).toEqual([]);
  });

  it('asset-viewer page: sequence contains expected entry fields', () => {
    const sequence = [
      { id: 101, filename: 'hero.png', previewUrl: '/projects/1/assets/101/preview?v=abc', viewerUrl: '/projects/1/assets/101', originalUrl: '/projects/1/assets/101/original' },
    ];
    const html = renderPage({ slideshowSequenceJson: JSON.stringify(sequence) });
    const scriptMatch = html.match(/<script[^>]*data-asset-library-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    const parsed = JSON.parse(scriptMatch[1]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 101, filename: 'hero.png' });
    expect(parsed[0].previewUrl).toContain('/preview?');
    expect(parsed[0].viewerUrl).toContain('/projects/1/assets/101');
    expect(parsed[0].originalUrl).toContain('/projects/1/assets/101/original');
    expect(parsed[0].previewUrl).not.toContain('/original');
    expect(parsed[0].thumbnailUrl).toBeUndefined();
  });

  it('asset-viewer page: one Asset Library viewer sequence carries the complete server JSON unchanged', () => {
    // Cross-project entries with equal filenames stay distinct by project.
    const sequence = [
      { id: 7, projectId: 2, filename: 'a.png', previewUrl: '/projects/2/assets/7/preview?v=x', viewerUrl: '/projects/2/assets/7', revision: 'x' },
      { id: 1, projectId: 1, filename: 'a.png', previewUrl: '/projects/1/assets/1/preview?v=y', viewerUrl: '/projects/1/assets/1', revision: 'y' },
    ];
    const html = renderPage({ slideshowSequenceJson: JSON.stringify(sequence) });
    const script = html.match(/<script[^>]*data-asset-library-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(script?.[0]).toContain('type="application/json"');
    expect(script?.[0]).toContain('data-viewer-label="Asset Viewer"');
    expect(JSON.parse(script[1])).toEqual(sequence);
    expect(html.match(/data-asset-library-viewer-sequence/g)).toHaveLength(1);
    expect(html).not.toContain('data-slideshow-sequence');
  });

  it('asset-viewer page: sequence JSON is escaped so </script> in filenames cannot break the element', () => {
    const sequence = [{ id: 1, filename: '</script><script>alert(1)', previewUrl: '/projects/1/assets/1/preview?v=x', viewerUrl: '/projects/1/assets/1' }];
    const escapedJson = JSON.stringify(sequence).replace(/<\//g, '<\\/');
    const html = renderPage({ slideshowSequenceJson: escapedJson });
    const scriptMatch = html.match(/<script[^>]*data-asset-library-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const parsed = JSON.parse(scriptMatch[1]);
    expect(parsed[0].filename).toBe('</script><script>alert(1)');
  });

  it('project assets page: renders the authoritative Project Assets viewer sequence script', () => {
    const html = renderProjectAssetsPage({ slideshowSequenceJson: '[]' });
    expect(html).toContain('data-project-assets-viewer-sequence');
    const scriptMatch = html.match(/<script[^>]*data-project-assets-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => JSON.parse(scriptMatch[1])).not.toThrow();
  });

  it('project assets page: sequence defaults to empty array when slideshowSequenceJson is not provided', () => {
    const html = renderProjectAssetsPage();
    const scriptMatch = html.match(/<script[^>]*data-project-assets-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(JSON.parse(scriptMatch[1])).toEqual([]);
  });

  it('project assets page: sequence contains expected entry fields', () => {
    const sequence = [
      { id: 42, filename: 'cover.png', previewUrl: '/projects/5/assets/42/preview?v=xyz', viewerUrl: '/projects/5/assets/42', originalUrl: '/projects/5/assets/42/original' },
    ];
    const html = renderProjectAssetsPage({ slideshowSequenceJson: JSON.stringify(sequence) });
    const scriptMatch = html.match(/<script[^>]*data-project-assets-viewer-sequence[^>]*>([\s\S]*?)<\/script>/);
    const parsed = JSON.parse(scriptMatch[1]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 42, filename: 'cover.png' });
    expect(parsed[0].previewUrl).toContain('/preview?');
    expect(parsed[0].viewerUrl).toContain('/projects/5/assets/42');
    expect(parsed[0].originalUrl).toContain('/projects/5/assets/42/original');
    expect(parsed[0].previewUrl).not.toContain('/original');
    expect(parsed[0].thumbnailUrl).toBeUndefined();
  });
});

// B5b: only eligible image thumbnails carry the Asset Library viewer hook,
// qualified by project so equal filenames in different projects stay apart.
describe('Asset Library unified viewer hooks', () => {
  const comicAsset = {
    ...alphaAsset,
    id: 404,
    filename: 'issue.cbz',
    relative_path: 'comics/issue.cbz',
    extension: 'cbz',
    mime_type: 'application/vnd.comicbook+zip',
    preview: { kind: 'unsupported', previewable: false, comic: { format: 'cbz' } },
    preview_state: 'unsupported',
    thumbnail_url: null,
    preview_url: null,
  };
  const missingAsset = { ...alphaAsset, id: 505, is_present: 0, preview_state: 'missing' };
  // Same filename as alphaAsset, in another project.
  const betaImage = {
    ...alphaAsset,
    id: 202,
    project_id: 2,
    project_title: 'Beta Project',
    thumbnail_url: '/projects/2/assets/202/thumbnail?v=beta',
    preview_url: '/projects/2/assets/202/preview?v=beta',
  };

  it.each(['grid', 'list'])('%s image thumbnails carry project-qualified hooks and keep their details href', (view) => {
    const html = renderPage({ assets: [alphaAsset, betaImage], filters: { view }, presentation: { view } });
    const links = [...html.matchAll(/<a class="asset-(?:list-)?card-media-link[^"]*"[^>]*>/g)].map((match) => match[0]);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('href="/projects/1/assets/101"');
    expect(links[0]).toContain('data-asset-library-preview-id="101" data-asset-library-preview-project-id="1"');
    expect(links[1]).toContain('href="/projects/2/assets/202"');
    expect(links[1]).toContain('data-asset-library-preview-id="202" data-asset-library-preview-project-id="2"');
    expect(html).not.toContain('data-project-assets-preview-id');
    // Details links remain plain navigation.
    if (view === 'grid') {
      const details = [...html.matchAll(/<a class="asset-details-link[^>]*>/g)].map((match) => match[0]);
      expect(details).toHaveLength(2);
      details.forEach((link) => expect(link).not.toContain('data-asset-library-preview-id'));
    }
  });

  it.each(['grid', 'list'])('%s comic and missing cards have no image viewer hook', (view) => {
    const html = renderPage({ assets: [comicAsset, missingAsset], filters: { view }, presentation: { view } });
    expect(html).not.toContain('data-asset-library-preview-id');
    expect(html).toContain('href="/projects/1/assets/404"');
  });
});

describe('Asset Library supported video presentation', () => {
  const videoAsset = {
    ...alphaAsset,
    id: 303,
    filename: 'clip.mp4',
    relative_path: 'renders/clip.mp4',
    extension: 'mp4',
    mime_type: 'video/mp4',
    formattedDimensions: '—',
    preview: { kind: 'video', previewable: false, playbackUrl: '/projects/1/assets/303/original' },
    preview_state: 'video',
    thumbnail_url: null,
    preview_url: null,
    detailUrl: '/projects/1/assets/303?pageSize=all',
  };

  it.each(['grid', 'list'])('renders %s video cards with an inert intrinsic-size frame that opens the shared video preview', (view) => {
    const html = renderPage({ assets: [videoAsset], filters: { view }, presentation: { view } });
    const card = html.match(/<article class="asset-(?:list-)?card[\s\S]*?<\/article>/)?.[0];

    expect(card).toBeDefined();
    expect(card).not.toMatch(/<img/);
    expect(card).toMatch(/<video class="asset-video-frame-media" src="\/projects\/1\/assets\/303\/original"\s+preload="metadata" playsinline disablepictureinpicture aria-hidden="true" data-asset-video-frame><\/video>/);
    // The List title trigger's aria-controls is not a <video controls>.
    expect(card).not.toMatch(/autoplay|(?<!aria-)\bcontrols\b/);
    expect((card.match(/<video\b/g) || [])).toHaveLength(1);
    expect(card).not.toContain('data-project-assets-preview-id');
    expect(card).not.toContain('data-asset-library-preview-id');
    // Unmodified clicks open the shared preview dialog; the href keeps library viewer navigation.
    expect(card).toContain('data-asset-video-preview-trigger data-video-src="/projects/1/assets/303/original" data-video-title="clip.mp4"');
    expect(card).toContain('data-asset-video-placeholder hidden');
    expect(card).toContain('MP4 video');
    expect(card).toMatch(/<a class="asset-(?:list-)?card-media-link asset-video-link" href="\/projects\/1\/assets\/303\?pageSize=all" aria-label="Play video clip/);
    expect(card).toContain('Alpha Project');
  });
});
