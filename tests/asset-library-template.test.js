import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { buildAssetLibraryUrl } from '../src/routes/asset-library-query.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const TEMPLATE_PATH = path.join(VIEWS_DIR, 'assets', 'index.njk');
const PROJECT_ASSET_VIEWER_PATH = path.join(VIEWS_DIR, 'projects', 'asset-viewer.njk');
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
  modified_at: '2026-08-01 10:00:00',
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
  modified_at: null,
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
    ],
    ...overrides,
    filters,
  };

  model.presentation = { view: filters.view, ...model.presentation };
  model.context = { ...filters, page, pageSize, ...overrides.context };
  return model;
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
  return env.render('assets/index.njk', {
    ...model,
    pageUrl,
    appName: 'CreatorCrate',
    auth: { enabled: false, authenticated: false },
    shell: { appName: 'CreatorCrate', activeSection: 'Assets', navigation: [] },
  });
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

    expect(html).toMatch(/<form id="asset-filters" class="filters asset-viewer-filters asset-viewer-filters--asset-viewer" method="get" action="\/assets">/);
    expect(html).toMatch(/<div class="asset-viewer-display-controls">[\s\S]*?<div class="project-filter-actions">[\s\S]*?<button class="button" type="submit" form="asset-filters">Filter<\/button>\s*<a class="button button-secondary" href="[^"]+">Reset<\/a>\s*<\/div>\s*<\/div>\s*<form id="asset-filters"/);
    expect(html).toContain('<input type="hidden" name="view" value="list">');
    expect(html).toContain('aria-label="Project filter: Beta Project"');
    expect(html).toMatch(/<span class="asset-filter-multiselect-summary" data-asset-project-filter-summary>\s*<span class="asset-filter-multiselect-summary-current" data-asset-project-filter-current-summary>Beta Project<\/span>[\s\S]*?<span class="asset-filter-multiselect-summary-width" aria-hidden="true">[\s\S]*?<\/span>\s*<\/span>/);
    expect(html).toMatch(/<input id="asset-project-option-2" name="project" type="radio" value="2" checked>/);
    expect(html).toContain('aria-label="Category filter: Renders"');
    expect(html).toMatch(/<input[^>]+name="category"[^>]+value="renders" checked>/);
    expect(html).toContain('aria-label="Tag filter: Beta Tag"');
    expect(html).toMatch(/<input[^>]+name="tag"[^>]+value="2" checked>/);
    expect(html).not.toContain('id="asset-search"');
    expect(html).not.toMatch(/<label[^>]+for="asset-search"/);
    expect(html).not.toMatch(/<input[^>]+name="search"/);
    expect(html).toMatch(/<label[^>]+for="asset-project-filter-search">Search projects<\/label>/);
    expect(html).toMatch(/id="asset-project-filter-search"[^>]*type="search"/);
    expect(html).toContain('aria-label="Extension filter: .png"');
    expect(html).toMatch(/<input[^>]+name="extension"[^>]+value="png" checked>/);
    expect(html).toContain('aria-label="Presence filter: Missing"');
    expect(html).toContain('aria-label="Release usage filter: Used in releases"');
    expect(html).toContain('aria-label="Sort by filter: Project"');
    expect(html).toContain('aria-label="Sort order filter: Descending"');
    expect(html).toContain('aria-label="Page size filter: 50"');
    for (const label of ['Missing', 'Used in releases', 'Project', 'Descending', '50']) {
      expect(html).toContain(`<span class="asset-filter-multiselect-summary-current">${label}</span>`);
    }
    expect(html).toMatch(/<input[^>]+name="presence"[^>]+type="radio"[^>]+value="missing" checked>/);
    expect(html).toMatch(/<input[^>]+name="usage"[^>]+type="radio"[^>]+value="used" checked>/);
    expect(html).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
    expect(html).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(html).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
    for (const [name, count] of [['presence', 3], ['usage', 3], ['sort', 2], ['order', 2], ['pageSize', 4]]) {
      expect((html.match(new RegExp(`name="${name}"[^>]+type="radio"`, 'g')) || [])).toHaveLength(count);
    }
    expect(html).not.toMatch(/<select[^>]+id="asset-(presence|usage|sort|order|page-size)"/);
    for (const [triggerId, optionsId] of [
      ['asset-presence-filter-trigger', 'asset-presence-filter-options'],
      ['asset-usage-filter-trigger', 'asset-usage-filter-options'],
      ['asset-sort-filter-trigger', 'asset-sort-filter-options'],
      ['asset-order-filter-trigger', 'asset-order-filter-options'],
      ['asset-page-size-filter-trigger', 'asset-page-size-filter-options'],
    ]) {
      const disclosure = (html.match(/<details[^>]*data-asset-viewer-filter-disclosure[\s\S]*?<\/details>/g) || [])
        .find((candidate) => candidate.includes(`aria-controls="${optionsId}"`)) || '';
      expect(disclosure).toContain(`id="${triggerId}"`);
      expect(disclosure).toContain(`aria-controls="${optionsId}"`);
      expect(disclosure).toContain('aria-expanded="false"');
      expect(disclosure).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
    }
    expect(html).toContain('>Reset</a>');
  });

  it('renders the Asset Viewer defaults link with correct href and accessibility text', () => {
    const html = renderPage();

    expect(html).toContain('href="/settings/defaults#defaults-asset-viewer"');
    expect(html).toContain('aria-label="Asset Viewer defaults"');
    expect(html).toContain('data-tooltip="Asset Viewer defaults"');
  });

  it('renders Project as a searchable single-select disclosure with safe radio values', () => {
    const emptyHtml = renderPage();
    const selectedHtml = renderPage({ filters: { projectId: 2 } });

    expect(emptyHtml).not.toMatch(/<select[^>]+(?:id="asset-project"|name="project")/);
    expect(emptyHtml).toContain('<legend>Project</legend>');
    expect(emptyHtml).toContain('data-asset-project-filter');
    expect((emptyHtml.match(/data-asset-viewer-filter-disclosure/g) || [])).toHaveLength(9);
    expect(emptyHtml).toContain('id="asset-project-filter-search" class="asset-project-filter-search" type="search"');
    expect(emptyHtml).toMatch(/<input id="asset-project-option-all" name="project" type="radio" value="" checked>/);
    expect(emptyHtml).toMatch(/<input id="asset-project-option-1" name="project" type="radio" value="1">/);
    expect(emptyHtml).toMatch(/<input id="asset-project-option-2" name="project" type="radio" value="2">/);
    expect(emptyHtml).toContain('>All projects</span>');
    expect(emptyHtml).not.toMatch(/<input[^>]+type="hidden"[^>]+name="project"/);
    expect((emptyHtml.match(/<input[^>]+name="project"[^>]+type="radio"/g) || [])).toHaveLength(3);

    expect(selectedHtml).toContain('aria-expanded="false"');
    expect(selectedHtml).toContain('aria-label="Project filter: Beta Project"');
    expect(selectedHtml).toMatch(/<span class="asset-filter-multiselect-summary" data-asset-project-filter-summary>\s*<span class="asset-filter-multiselect-summary-current" data-asset-project-filter-current-summary>Beta Project<\/span>[\s\S]*?<span class="asset-filter-multiselect-summary-width" aria-hidden="true">[\s\S]*?<\/span>\s*<\/span>/);
    expect(selectedHtml).toMatch(/<input id="asset-project-option-all" name="project" type="radio" value="">/);
    expect(selectedHtml).toMatch(/<input id="asset-project-option-2" name="project" type="radio" value="2" checked>/);
    expect(selectedHtml).not.toMatch(/<input id="asset-project-filter-search"[^>]+name="project"/);
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
    expect((html.match(/data-asset-viewer-filter-disclosure/g) || [])).toHaveLength(9);
    for (const id of ['asset-category-filter-trigger', 'asset-tag-filter-trigger', 'asset-extension-filter-trigger']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect((html.match(/name="category"/g) || [])).toHaveLength(2);
    expect((html.match(/name="tag"/g) || [])).toHaveLength(2);
    expect((html.match(/name="extension"/g) || [])).toHaveLength(2);
    expect((html.match(/name="category"[^>]+checked/g) || [])).toHaveLength(2);
    expect((html.match(/name="tag"[^>]+checked/g) || [])).toHaveLength(2);
    expect((html.match(/name="extension"[^>]+checked/g) || [])).toHaveLength(2);
    for (const [optionsId, inputName] of [
      ['asset-project-filter-options', 'project'],
      ['asset-category-filter-options', 'category'],
      ['asset-tag-filter-options', 'tag'],
      ['asset-extension-filter-options', 'extension'],
    ]) {
      const disclosure = (html.match(/<details[^>]*data-asset-viewer-filter-disclosure[\s\S]*?<\/details>/g) || [])
        .find((candidate) => candidate.includes(`aria-controls="${optionsId}"`)) || '';
      expect(disclosure).toContain('asset-filter-multiselect--sized');
      expect(disclosure).toContain('asset-filter-multiselect-summary-current');
      expect(disclosure).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
      expect(disclosure).toMatch(new RegExp(`<label for="[^"]+">\\s*<input[^>]+name="${inputName}"`));
    }
    expect(html).not.toContain('id="asset-search"');
    expect(html).not.toMatch(/<input[^>]+name="search"/);
    expect(html).not.toMatch(/<select[^>]+(?:id="asset-(tag|category|extension)"|name="(tag|category|extension)")/);
    expect(html).not.toMatch(/type="hidden"[^>]+name="(tag|category|extension)"/);
  });

  it('retains legacy fallback fields when single-select option collections are empty', () => {
    const html = renderPage({
      presenceOptions: [],
      usageOptions: [],
      sortOptions: [],
      orderOptions: [],
      pageSizeOptions: [],
    });

    expect(html).toContain('<select id="asset-presence" name="presence">');
    expect(html).toContain('<select id="asset-usage" name="usage">');
    expect(html).toContain('<select id="asset-sort" name="sort">');
    expect(html).toContain('<input id="asset-order" name="order" type="text" value="asc">');
    expect(html).toContain('<input id="asset-page-size" name="pageSize" type="number" value="25">');
    expect((html.match(/data-asset-viewer-filter-disclosure/g) || [])).toHaveLength(4);
    for (const id of [
      'asset-presence-filter-trigger',
      'asset-usage-filter-trigger',
      'asset-sort-filter-trigger',
      'asset-order-filter-trigger',
      'asset-page-size-filter-trigger',
    ]) {
      expect(html).not.toContain(`id="${id}"`);
    }
  });

  it('renders exact three-region Grid cards with retained indicators, preview info, and title-only footers', () => {
    const html = renderPage();
    const cards = html.match(/<article class="asset-card asset-viewer-grid-card"[\s\S]*?<\/article>/g) || [];
    const alphaCard = cards.find((card) => card.includes('Alpha Project'));
    const betaCard = cards.find((card) => card.includes('Beta Project'));
    const topRow = alphaCard?.match(/<div class="asset-card-top asset-viewer-grid-card-top">[\s\S]*?<\/div>/)?.[0];
    const titleArea = alphaCard?.match(/<div class="asset-card-body asset-viewer-grid-card-title-area">[\s\S]*?<\/div>\s*<\/article>/)?.[0];

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
    const optionLabels = [...html.matchAll(/data-grid-size-option-label="(compact|default|large)"[^>]*>([^<]+)</g)];
    expect(optionLabels.map(([, value]) => value)).toEqual(['compact', 'default', 'large']);
    expect(optionLabels.map(([, , label]) => label)).toEqual(['Compact', 'Default', 'Large']);
    expect(html).toMatch(/data-grid-size-option-label="default" class="is-active">Default</);
    expect(cards).toHaveLength(2);
    expect(alphaCard).toBeDefined();
    expect(betaCard).toBeDefined();
    expect(topRow).toBeDefined();
    expect((topRow?.match(/class="asset-indicator\b/g) || [])).toHaveLength(2);
    expect(topRow).toContain('asset-indicator--present');
    expect(topRow).toContain('aria-label="Present"');
    expect(topRow).toContain('asset-indicator--used');
    expect(topRow).toContain('aria-label="Used in 2 releases"');

    expect(alphaCard).toContain('data-asset-viewer-preview');
    expect(alphaCard).toContain('data-asset-info-card');
    expect(alphaCard).toContain('aria-label="View preview of shared.png"');
    expect(alphaCard).toContain('class="asset-file-link" href="/projects/1/assets/101"');
    expect(alphaCard).toContain('src="/projects/1/assets/101/preview?v=alpha"');
    expect(alphaCard).toContain('alt=""');
    expect(alphaCard).toContain('>Alpha Project</a>');
    expect(alphaCard).toContain('href="/releases/301">Alpha Release</a>');
    expect(alphaCard).toContain('href="/releases/302">Zeta Release</a>');
    expect(alphaCard.indexOf('href="/releases/301">Alpha Release</a>')).toBeLessThan(
      alphaCard.indexOf('href="/releases/302">Zeta Release</a>'),
    );
    expect(betaCard).toContain('>Beta Project</a>');
    expect(betaCard).toContain('Not in any release');

    expect(titleArea).toBeDefined();
    expect(titleArea).toContain('>shared.png</a>');
    expect(titleArea).toContain('>Alpha Project</a>');
    expect(titleArea).toContain('Alpha Release');
    expect(titleArea).toContain('Zeta Release');
    expect(titleArea).not.toContain('renders/shared.png');
    expect(titleArea).not.toContain('Renders');
    expect(titleArea).not.toContain('1024 bytes');
    expect(titleArea).not.toContain('2026-08-01 10:00:00');
    expect(titleArea).not.toContain('Effective tags');
    expect(titleArea).not.toContain('Asset information');
    expect(titleArea).not.toContain('View asset details');

    for (const field of ['Location', 'Category', 'Extension', 'Size', 'Modified', 'Presence', 'Release usage']) {
      expect((alphaCard.match(new RegExp(`<dt>${field}</dt>`, 'g')) || [])).toHaveLength(1);
    }
    expect(alphaCard).toContain('renders/shared.png');
    expect(alphaCard).toContain('Renders');
    expect(alphaCard).toContain('1024 bytes');
    expect(alphaCard).toContain('2026-08-01 10:00:00');
    expect(alphaCard).toContain('Present at last scan');
    expect(alphaCard).toContain('Used in 2 releases');
    expect(alphaCard).not.toContain('asset-details-link');
    expect(alphaCard).not.toContain('data-tooltip="View asset details"');
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

  it('renders compact Projects-style List cards with detail, preview, metadata, release, and fallback links', () => {
    const html = renderPage({
      filters: { view: 'list' },
      presentation: { view: 'list' },
    });
    const source = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const cards = html.match(/<article class="asset-list-card"[\s\S]*?<\/article>/g) || [];
    const alphaCard = cards.find((card) => card.includes('Alpha Project'));

    expect(html).toMatch(/<ul class="asset-list" role="list" aria-label="Assets across active projects">/);
    expect(html).not.toContain('<table class="data-table asset-table">');
    expect((html.match(/<li class="asset-list-item/g) || []).length).toBe(2);
    expect(cards).toHaveLength(2);
    expect(alphaCard).toBeDefined();
    expect(source).toMatch(/<article class="asset-list-card"[\s\S]*?>\s*\{\{ renderListPreview\(asset, detailUrl, displayName\) \}\}\s*<div class="asset-list-card-body">[\s\S]*?<\/div>\s*<\/article>/);
    expect(source).not.toContain('asset-list-card-actions');
    expect(html).toContain('>Alpha Project</a>');
    expect(html).toContain('>Beta Project</a>');
    expect(html).toContain('href="/projects/1/assets/101"');
    expect(html).toContain('href="/projects/2/assets/202"');
    expect(html).toContain('class="asset-list-card-media-link" href="/projects/1/assets/101"');
    expect(html).toContain('class="asset-list-card-media-image"');
    expect(html).toContain('src="/projects/1/assets/101/preview?v=alpha"');
    expect(html).not.toContain('src="/projects/1/assets/101/thumbnail?v=alpha"');
    expect(html).toContain('alt=""');
    expect(html).toContain('class="asset-file-link" href="/projects/1/assets/101"');
    expect(html).toContain('class="asset-file-link" href="/projects/2/assets/202"');
    expect(html).toMatch(/data-asset-containing-location[\s\S]*?renders[\s\S]*?<\/span>/);
    expect(html).toMatch(/data-asset-containing-location[\s\S]*?source[\s\S]*?<\/span>/);
    expect(html).not.toContain('renders/shared.png');
    expect(html).not.toContain('source/shared.png');
    expect(html).toContain('<dt>Project</dt>');
    expect(html).toContain('<dt>Category</dt>');
    expect(html).toContain('<div class="asset-list-card-associations">');
    expect(html).toContain('<section class="asset-list-card-association asset-list-card-association--tags">');
    expect(html).toContain('<h3 class="asset-list-card-association-label">Effective tags</h3>');
    expect(html).toContain('<section class="asset-list-card-association asset-list-card-association--releases">');
    expect(html).toContain('<h3 class="asset-list-card-association-label">Releases</h3>');
    expect(html).toContain('Renders');
    expect(html).toContain('Uncategorized');
    expect(html).toContain('Present at last scan');
    expect(html).toContain('Missing at last scan');
    for (const field of ['Project', 'Category', 'Extension', 'Size', 'Modified']) {
      expect((alphaCard?.match(new RegExp(`<dt>${field}</dt>`, 'g')) || [])).toHaveLength(1);
    }
    expect(alphaCard).toContain('.png');
    expect(alphaCard).toContain('1024 bytes');
    expect(alphaCard).toContain('2026-08-01 10:00:00');
    expect(html).toContain('class="asset-list-card-release-link" href="/releases/301">Alpha Release</a>');
    expect(html).toContain('Not in any release');
    expect(html).not.toContain('data-asset-grid-size-controls');

    const title = alphaCard?.match(/<h2 class="asset-list-card-title">[\s\S]*?<\/h2>/)?.[0];
    const location = alphaCard?.match(/<span class="asset-list-card-location"[\s\S]*?<\/span>/)?.[0];
    expect(title).toBeDefined();
    expect(location).toBeDefined();
    expect((title?.match(/>shared\.png<\/a>/g) || [])).toHaveLength(1);
    expect(location).not.toContain('shared.png');
  });

  it('renders direct and inherited effective tags with a subtle project-origin indicator', () => {
    const html = renderPage({
      assets: [
        {
          ...alphaAsset,
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

    expect(html).toContain('<ul class="asset-list-card-tags" aria-label="Effective tags">');
    expect(html).toContain('Direct List Tag');
    expect(html).toContain('Inherited List Tag');
    expect(html).toContain('<span class="asset-tag-origin"><span class="sr-only">Inherited from </span>Project</span>');
    expect(html).toContain('No effective tags');
    expect(html).not.toContain('shared-list-secret');
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
    expect(css).toMatch(/\.asset-viewer-grid-card-info\s*\{[^}]*display:\s*none[\s\S]*?position:\s*absolute[^}]*z-index:\s*30/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info\s*\{[\s\S]*?width:\s*min\(24rem,\s*calc\(100vw\s*-\s*2rem\)\)/);
    expect(css).toMatch(/\.asset-viewer-filters\s*\{[^}]*z-index:\s*20/);
    expect(css).toMatch(/\.asset-filter-multiselect\[open\]\s*\{[^}]*z-index:\s*40/);
    expect(css).toMatch(/\.asset-filter-multiselect-panel\s*\{[\s\S]*?z-index:\s*50/);
    expect(css).toMatch(/\.asset-viewer-grid-card-preview\s*\{[^}]*overflow:\s*visible/);
    expect(css).not.toMatch(/\.asset-grid\s*\{[^}]*overflow:\s*(?:hidden|clip|auto|scroll)/);
    expect(css).not.toMatch(/\.asset-browser-content\s*\{[^}]*overflow:\s*(?:hidden|clip|auto|scroll)/);
    expect(css).not.toMatch(/\.asset-viewer-filters\s*\{[^}]*overflow:\s*(?:hidden|clip|auto|scroll)/);
    expect(css).toMatch(/\.asset-viewer-grid-card-preview:hover \.asset-viewer-grid-card-info,[\s\S]*?\.asset-viewer-grid-card-preview:focus-within \.asset-viewer-grid-card-info\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info-tags\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.asset-viewer-grid-card-title-releases\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.asset-viewer-grid-card-title \.asset-file-link\s*\{[^}]*color:\s*var\(--text\)/);
    expect(css).toMatch(/\.asset-viewer-grid-card-project-link:visited,[\s\S]*?\.asset-viewer-grid-card-release-link:visited[\s\S]*?color:\s*var\(--link\)/);
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

    expect(css).toMatch(/\.asset-viewer-filters\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.asset-filter-multiselect-panel\s*\{[\s\S]*?max-height:\s*20rem[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.asset-filter-multiselect summary:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/\.asset-filter-multiselect-option input:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.asset-filter-multiselect-panel\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.asset-viewer-project-filter \.asset-project-filter-panel\s*\{[\s\S]*?max-height:\s*20rem[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.asset-viewer-project-filter \.asset-project-filter-option-list\s*\{[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.asset-filter-multiselect-field\s*\{[^}]*flex:\s*0 1 auto[^}]*width:\s*max-content/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized\s*\{[^}]*width:\s*max-content[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-summary\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*max-content/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-summary-width\s*\{[\s\S]*?max-height:\s*0[\s\S]*?overflow:\s*hidden[\s\S]*?visibility:\s*hidden[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-panel\s*\{[\s\S]*?width:\s*max-content[\s\S]*?max-width:\s*min\(/);
    expect(css).toMatch(/\.asset-filter-multiselect--sized \.asset-filter-multiselect-option > label\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.asset-viewer-project-filter \.asset-filter-multiselect-summary-current\s*\{[\s\S]*?text-overflow:\s*ellipsis/);
    expect(css).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.asset-filter-multiselect-field\s*\{[\s\S]*?width:\s*100%[\s\S]*?max-width:\s*100%/);
  });

  it('keeps transformed Grid cards and hover information below the global navigation root', () => {
    const css = fs.readFileSync(STYLESHEET_PATH, 'utf8');
    const sidebarLayer = Number(css.match(/--shell-z-sidebar:\s*(\d+)/)?.[1]);
    const contentLayer = Number(css.match(/--shell-z-content:\s*(\d+)/)?.[1]);

    expect(css).toMatch(/\.app-main\s*\{[\s\S]*?position:\s*relative[\s\S]*?z-index:\s*var\(--shell-z-content\)/);
    expect(css).toMatch(/\.app-sidebar\s*\{[\s\S]*?position:\s*fixed[\s\S]*?z-index:\s*var\(--shell-z-sidebar\)/);
    expect(sidebarLayer).toBeGreaterThan(contentLayer);
    expect(sidebarLayer).toBeGreaterThan(60);
    expect(css).toMatch(/\.asset-viewer-grid-card:hover,[\s\S]*?\.asset-viewer-grid-card:focus-within\s*\{[\s\S]*?transform:\s*translateY\(-2px\)/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info\s*\{[\s\S]*?position:\s*absolute[\s\S]*?z-index:\s*30/);
    expect(css).toMatch(/\.asset-viewer-grid-card-preview:hover \.asset-viewer-grid-card-info,[\s\S]*?\.asset-viewer-grid-card-preview:focus-within \.asset-viewer-grid-card-info\s*\{[\s\S]*?display:\s*block/);
  });

  it('contains only the read-only filter form and no mutation controls', () => {
    const html = renderPage();
    const forms = html.match(/<form\b[^>]*>/g) || [];

    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="get"');
    expect(html).not.toMatch(/method="post"/i);
    expect(html).not.toMatch(/Scan Now|Rename|Move file|Add selected|Set as primary|select all/i);
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
    const html = renderPage(model);
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
    const clearUrl = buildAssetLibraryUrl(state, {
      projectId: null,
      categories: null,
      search: null,
      extensions: null,
      tags: null,
      presence: 'all',
      usage: 'all',
      page: 1,
    });

    expect(html).toContain(`href="${href(previousUrl)}"`);
    expect(html).toContain(`href="${href(nextUrl)}"`);
    expect(html).toContain(`href="${href(clearUrl)}"`);
    expect(html).toMatch(/<nav class="pagination"[^>]*aria-label="Asset Viewer pages">/);
    expect(html).toContain('Page 2 of 3');
  });

  it('renders distinct unfiltered and filtered empty states, with a reset link only for filtered results', () => {
    const unfiltered = renderPage({ assets: [], total: 0 });
    expect(unfiltered).toContain('No assets across active projects');
    expect(unfiltered).not.toContain('No assets match the current filters');
    expect(unfiltered).not.toMatch(/<div class="empty-state-actions">/);
    expect(unfiltered).not.toContain('Scan Now');

    const filtered = renderPage({
      assets: [],
      total: 0,
      hasAnyAssets: true,
      filters: { search: 'missing-name' },
    });
    expect(filtered).toContain('No assets match the current filters');
    expect(filtered).toMatch(/<div class="empty-state-actions">[\s\S]*>Reset<\/a>/);
    expect(filtered).not.toContain('No assets across active projects');
  });

  it('keeps the existing project-scoped asset detail template unchanged', () => {
    const source = fs.readFileSync(PROJECT_ASSET_VIEWER_PATH, 'utf8');

    expect(source).toContain('{% set page_title = "Assets — " ~ project.title ~ " — " ~ asset.filename %}');
    expect(source).toContain('action="/projects/{{ project.id }}/assets/{{ asset.id }}/primary-image"');
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
    _csrf: 'test-csrf',
    appName: 'CreatorCrate',
    auth: { enabled: false, authenticated: false },
    shell: { appName: 'CreatorCrate', activeSection: 'Projects', navigation: [] },
    ...overrides,
    filters,
    project,
  });
}

describe('slideshow scaffold — static UI', () => {
  it('asset-viewer page: slideshow trigger exists before Filter in DOM order', () => {
    const html = renderPage();
    const filterActionsDiv = html.match(/<div class="project-filter-actions">[\s\S]*?<\/div>/)?.[0] ?? '';
    const triggerPos = filterActionsDiv.indexOf('data-slideshow-trigger');
    const filterPos = filterActionsDiv.indexOf('type="submit" form="asset-filters"');
    expect(triggerPos).toBeGreaterThan(-1);
    expect(filterPos).toBeGreaterThan(-1);
    expect(triggerPos).toBeLessThan(filterPos);
  });

  it('asset-viewer page: slideshow trigger has accessible label and tooltip', () => {
    const html = renderPage();
    expect(html).toContain('data-slideshow-trigger');
    expect(html).toContain('aria-label="Start slideshow"');
    expect(html).toContain('title="Start slideshow"');
  });

  it('both asset pages use the shared Filter button sizing for Slideshow', () => {
    for (const html of [renderPage(), renderProjectAssetsPage()]) {
      const triggerClass = html.match(/<button class="([^"]*\bslideshow-trigger\b[^"]*)"[^>]*data-slideshow-trigger/)?.[1] ?? '';
      expect(triggerClass).toContain('button');
      expect(triggerClass).toContain('button-secondary');
      expect(triggerClass).not.toContain('button-small');
    }

    expect(css).toMatch(/\.slideshow-trigger\s*\{[^}]*margin-inline-end:\s*var\(--space-xs\)/);
    expect(css).not.toMatch(/\.slideshow-trigger\s*\{[^}]*line-height:/);
    expect(css).toMatch(/\.asset-viewer-display-controls\s+\.project-filter-actions\s*\{[^}]*gap:\s*var\(--space-sm\)/);
  });

  it('asset-viewer page: slideshow scaffold is present, hidden, and inert', () => {
    const html = renderPage();
    expect(html).toContain('data-slideshow-scaffold');
    expect(html).toMatch(/data-slideshow-scaffold[^>]* hidden/);
    expect(html).toMatch(/data-slideshow-scaffold[^>]* inert/);
  });

  it('asset-viewer page: scaffold contains all required control hooks', () => {
    const html = renderPage();
    expect(html).toContain('data-slideshow-preview');
    expect(html).toContain('data-slideshow-prev');
    expect(html).toContain('data-slideshow-next');
    expect(html).toContain('data-slideshow-play-pause');
    expect(html).toContain('data-slideshow-speed');
    expect(html).toContain('data-slideshow-status');
    expect(html).toContain('data-slideshow-close');
    expect(html).toContain('data-slideshow-fullscreen');
    expect(html).toContain('data-slideshow-original-size');
    expect(html).toContain('aria-label="View original size"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-slideshow-media-status');
    expect(html).toContain('aria-label="Enter fullscreen"');
  });

  it('asset-viewer page: speed select preserves 2 s, 4 s default, and 6 s options', () => {
    const html = renderPage();
    const speedSelect = html.match(/<select[^>]*data-slideshow-speed[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(speedSelect).toContain('value="2000"');
    expect(speedSelect).toMatch(/value="4000" selected/);
    expect(speedSelect).toContain('value="6000"');
  });

  it('asset-viewer page: existing Filter, Reset, and Defaults controls remain present', () => {
    const html = renderPage();
    expect(html).toContain('type="submit" form="asset-filters"');
    expect(html).toContain('>Filter</button>');
    expect(html).toContain('>Reset</a>');
    expect(html).toContain('href="/settings/defaults#defaults-asset-viewer"');
  });

  it('project assets page: slideshow trigger exists before Filter in DOM order', () => {
    const html = renderProjectAssetsPage();
    const filterActionsDiv = html.match(/<div class="project-filter-actions">[\s\S]*?<\/div>/)?.[0] ?? '';
    const triggerPos = filterActionsDiv.indexOf('data-slideshow-trigger');
    const filterPos = filterActionsDiv.indexOf('type="submit" form="asset-filters"');
    expect(triggerPos).toBeGreaterThan(-1);
    expect(filterPos).toBeGreaterThan(-1);
    expect(triggerPos).toBeLessThan(filterPos);
  });

  it('project assets page: slideshow trigger has accessible label and tooltip', () => {
    const html = renderProjectAssetsPage();
    expect(html).toContain('data-slideshow-trigger');
    expect(html).toContain('aria-label="Start slideshow"');
    expect(html).toContain('title="Start slideshow"');
  });

  it('project assets page: slideshow scaffold is present, hidden, and inert', () => {
    const html = renderProjectAssetsPage();
    expect(html).toContain('data-slideshow-scaffold');
    expect(html).toMatch(/data-slideshow-scaffold[^>]* hidden/);
    expect(html).toMatch(/data-slideshow-scaffold[^>]* inert/);
  });

  it('project assets page: fullscreen control and speed options are present', () => {
    const html = renderProjectAssetsPage();
    expect(html).toContain('data-slideshow-fullscreen');
    expect(html).toContain('data-slideshow-original-size');
    expect(html).toContain('aria-label="View original size"');
    expect(html).toContain('data-slideshow-media-status');
    expect(html).toContain('aria-label="Enter fullscreen"');
    const speedSelect = html.match(/<select[^>]*data-slideshow-speed[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(speedSelect).toContain('value="2000"');
    expect(speedSelect).toMatch(/value="4000" selected/);
    expect(speedSelect).toContain('value="6000"');
  });

  it('project assets page: existing Filter, Reset, and Defaults controls remain present', () => {
    const html = renderProjectAssetsPage();
    expect(html).toContain('type="submit" form="asset-filters"');
    expect(html).toContain('>Filter</button>');
    expect(html).toContain('>Reset</a>');
    expect(html).toContain('href="/settings/defaults#defaults-project-assets"');
  });
});

describe('slideshow sequence — data contract', () => {
  it('asset-viewer page: renders slideshow sequence script element inside the scaffold', () => {
    const html = renderPage({ slideshowSequenceJson: '[]' });
    expect(html).toContain('data-slideshow-sequence');
    const scriptMatch = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => JSON.parse(scriptMatch[1])).not.toThrow();
  });

  it('asset-viewer page: sequence defaults to empty array when slideshowSequenceJson is not provided', () => {
    const html = renderPage();
    const scriptMatch = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(JSON.parse(scriptMatch[1])).toEqual([]);
  });

  it('asset-viewer page: sequence contains expected entry fields', () => {
    const sequence = [
      { id: 101, filename: 'hero.png', previewUrl: '/projects/1/assets/101/preview?v=abc', viewerUrl: '/projects/1/assets/101', originalUrl: '/projects/1/assets/101/original' },
    ];
    const html = renderPage({ slideshowSequenceJson: JSON.stringify(sequence) });
    const scriptMatch = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
    const parsed = JSON.parse(scriptMatch[1]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 101, filename: 'hero.png' });
    expect(parsed[0].previewUrl).toContain('/preview?');
    expect(parsed[0].viewerUrl).toContain('/projects/1/assets/101');
    expect(parsed[0].originalUrl).toContain('/projects/1/assets/101/original');
    expect(parsed[0].previewUrl).not.toContain('/original');
    expect(parsed[0].thumbnailUrl).toBeUndefined();
  });

  it('asset-viewer page: sequence script element is inside the scaffold element', () => {
    const sequence = [{ id: 1, filename: 'a.png', previewUrl: '/projects/1/assets/1/preview?v=x', viewerUrl: '/projects/1/assets/1' }];
    const html = renderPage({ slideshowSequenceJson: JSON.stringify(sequence) });
    const scaffoldMatch = html.match(/<div[^>]*data-slideshow-scaffold[^>]*>([\s\S]*?)<\/div>/);
    expect(scaffoldMatch).not.toBeNull();
    expect(scaffoldMatch[0]).toContain('data-slideshow-sequence');
  });

  it('asset-viewer page: sequence JSON is escaped so </script> in filenames cannot break the element', () => {
    const sequence = [{ id: 1, filename: '</script><script>alert(1)', previewUrl: '/projects/1/assets/1/preview?v=x', viewerUrl: '/projects/1/assets/1' }];
    const escapedJson = JSON.stringify(sequence).replace(/<\//g, '<\\/');
    const html = renderPage({ slideshowSequenceJson: escapedJson });
    const scriptMatch = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const parsed = JSON.parse(scriptMatch[1]);
    expect(parsed[0].filename).toBe('</script><script>alert(1)');
  });

  it('project assets page: renders slideshow sequence script element inside the scaffold', () => {
    const html = renderProjectAssetsPage({ slideshowSequenceJson: '[]' });
    expect(html).toContain('data-slideshow-sequence');
    const scriptMatch = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => JSON.parse(scriptMatch[1])).not.toThrow();
  });

  it('project assets page: sequence defaults to empty array when slideshowSequenceJson is not provided', () => {
    const html = renderProjectAssetsPage();
    const scriptMatch = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(JSON.parse(scriptMatch[1])).toEqual([]);
  });

  it('project assets page: sequence contains expected entry fields', () => {
    const sequence = [
      { id: 42, filename: 'cover.png', previewUrl: '/projects/5/assets/42/preview?v=xyz', viewerUrl: '/projects/5/assets/42', originalUrl: '/projects/5/assets/42/original' },
    ];
    const html = renderProjectAssetsPage({ slideshowSequenceJson: JSON.stringify(sequence) });
    const scriptMatch = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
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
