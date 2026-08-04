import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { buildAssetLibraryUrl } from '../src/routes/asset-library-query.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const TEMPLATE_PATH = path.join(VIEWS_DIR, 'assets', 'index.njk');
const PROJECT_ASSET_VIEWER_PATH = path.join(VIEWS_DIR, 'projects', 'asset-viewer.njk');

const alphaAsset = {
  id: 101,
  project_id: 1,
  project_title: 'Alpha Project',
  filename: 'shared.png',
  relative_path: 'renders/shared.png',
  extension: 'png',
  mime_type: 'image/png',
  size_bytes: 1024,
  modified_at: '2026-08-01 10:00:00',
  is_present: 1,
  category_display_name: 'Renders',
  category_enabled: 1,
  release_usage_count: 2,
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
  extension: 'png',
  mime_type: 'image/png',
  size_bytes: 2048,
  modified_at: null,
  is_present: 0,
  category_display_name: null,
  category_enabled: null,
  release_usage_count: 0,
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
    category: 'all',
    tag: null,
    search: null,
    extension: null,
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
      option('all', 'All categories', filters.category === 'all'),
      option('uncategorized', 'Uncategorized', filters.category === 'uncategorized'),
      option('renders', 'Renders', filters.category === 'renders'),
    ],
    extensionOptions: [option('png', 'png', filters.extension === 'png')],
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
        category: 'renders',
        tag: 2,
        search: 'shared',
        extension: 'png',
        presence: 'missing',
        usage: 'used',
        sort: 'project',
        order: 'desc',
        view: 'list',
      },
      presentation: { view: 'list' },
      pageSize: 50,
      tagOptions: [
        { value: '1', displayName: 'Alpha Tag' },
        { value: '2', displayName: 'Beta Tag' },
      ],
    });

    expect(html).toMatch(/<form class="filters" method="get" action="\/assets">/);
    expect(html).toContain('<input type="hidden" name="view" value="list">');
    expect(html).toMatch(/<option value="2" selected>Beta Project<\/option>/);
    expect(html).toMatch(/<option value="renders" selected>Renders<\/option>/);
    expect(html).toMatch(/<select id="asset-tag" name="tag">[\s\S]*<option value="2" selected>Beta Tag<\/option>/);
    expect(html).toMatch(/id="asset-search"[^>]*value="shared"/);
    expect(html).toMatch(/<option value="png" selected>\.png<\/option>/);
    expect(html).toMatch(/<option value="missing" selected>Missing<\/option>/);
    expect(html).toMatch(/<option value="used" selected>Used in releases<\/option>/);
    expect(html).toMatch(/<option value="project" selected>Project<\/option>/);
    expect(html).toMatch(/<option value="desc" selected>Descending<\/option>/);
    expect(html).toMatch(/<option value="50" selected>50<\/option>/);
    expect(html).toContain('>Clear filters</a>');
  });

  it('renders multiple-project grid items with contextual detail and preview links', () => {
    const html = renderPage();

    expect(html).toMatch(/<ul class="asset-grid"[^>]*aria-label="Assets across active projects">/);
    expect((html.match(/class="asset-grid-item/g) || []).length).toBe(2);
    expect(html).toContain('href="/projects/1"');
    expect(html).toContain('href="/projects/2"');
    expect(html).toContain('>Alpha Project</a>');
    expect(html).toContain('>Beta Project</a>');
    expect(html).toContain('href="/projects/1/assets/101"');
    expect(html).toContain('href="/projects/2/assets/202"');
    expect(html).toContain('src="/projects/1/assets/101/preview?v=alpha"');
    expect(html).toContain('aria-label="View preview of shared.png from Alpha Project"');
    expect(html).toContain('aria-label="View details for shared.png from Alpha Project"');
    expect(html).toContain('aria-label="View details for shared.png from Beta Project"');
    expect(html).toMatch(/class="asset-card-category">[\s\S]*?Category:\s*[\s\S]*?Renders[\s\S]*?<\/span>/);
    expect(html).toMatch(/class="asset-card-category">[\s\S]*?Category:\s*[\s\S]*?Uncategorized[\s\S]*?<\/span>/);
    expect(html).toContain('Missing at last scan');
    expect(html).toContain('Used in 2 releases');
    expect(html).toContain('Not used by a release');
    expect(html).toContain('1024 bytes');
    expect(html).toContain('renders/shared.png');
    expect(html).toContain('source/shared.png');
  });

  it('renders assigned display names in grid cards without exposing tag internals or false untagged labels', () => {
    const html = renderPage({
      assets: [
        {
          ...alphaAsset,
          tags: [
            { id: 987654, normalized_name: 'shared-render-secret', displayName: 'Shared Render Tag' },
            { displayName: 'Alpha Render Tag' },
          ],
        },
        {
          ...betaAsset,
          tags: [{ displayName: 'Shared Render Tag' }],
        },
      ],
    });

    expect(html).toContain('<ul class="asset-card-tags" aria-label="Assigned tags">');
    expect((html.match(/<li>\s*Shared Render Tag\s*<\/li>/g) || [])).toHaveLength(2);
    expect(html).toContain('<li>Alpha Render Tag</li>');
    expect(html).not.toContain('shared-render-secret');
    expect(html).not.toContain('987654');
    expect(html).not.toContain('Untagged');
  });

  it('renders multiple-project list items with the same read-only metadata contract', () => {
    const html = renderPage({
      filters: { view: 'list' },
      presentation: { view: 'list' },
    });

    expect(html).toMatch(/<table class="data-table asset-table">/);
    expect((html.match(/<tr class="is-missing">/g) || []).length).toBe(1);
    expect(html).toContain('>Alpha Project</a>');
    expect(html).toContain('>Beta Project</a>');
    expect(html).toContain('href="/projects/1/assets/101"');
    expect(html).toContain('href="/projects/2/assets/202"');
    expect(html).toContain('class="asset-thumb-link" href="/projects/1/assets/101"');
    expect(html).toContain('class="asset-file-link" href="/projects/1/assets/101"');
    expect(html).toContain('class="asset-file-link" href="/projects/2/assets/202"');
    expect(html).toMatch(/class="asset-category-cell">[\s\S]*?Renders[\s\S]*?<\/td>/);
    expect(html).toMatch(/class="asset-category-cell">[\s\S]*?Uncategorized[\s\S]*?<\/td>/);
    expect(html).toContain('Present at last scan');
    expect(html).toContain('Missing at last scan');
    expect(html).toContain('Used in 2 releases');
    expect(html).toContain('Not used by a release');
  });

  it('renders a Tags column with aligned cells and leaves untagged cells neutral', () => {
    const html = renderPage({
      assets: [
        { ...alphaAsset, tags: [{ displayName: 'Shared List Tag' }] },
        { ...betaAsset, tags: [] },
      ],
      filters: { view: 'list' },
      presentation: { view: 'list' },
    });
    const table = html.match(/<table class="data-table asset-table">[\s\S]*?<\/table>/)?.[0];
    const header = table?.match(/<thead>[\s\S]*?<\/thead>/)?.[0];
    const body = table?.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0];
    const rows = body?.match(/<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/g) || [];

    expect(table).toBeDefined();
    expect(header).toContain('<th scope="col">Tags</th>');
    expect((header.match(/<th\b/g) || [])).toHaveLength(10);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.match(/<td\b/g) || []).length)).toEqual([10, 10]);
    expect(table).toContain('<ul class="asset-tag-list" aria-label="Assigned tags">');
    expect(table).toContain('<li>Shared List Tag</li>');

    const untaggedRow = rows.find((row) => row.includes('/projects/2/assets/202'));
    expect(untaggedRow).toBeDefined();
    expect(untaggedRow).not.toContain('asset-tag-list');
    expect(untaggedRow).not.toContain('Untagged');
  });

  it('contains only the read-only filter form and no mutation controls', () => {
    const html = renderPage();
    const forms = html.match(/<form\b[^>]*>/g) || [];

    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="get"');
    expect(html).not.toMatch(/method="post"/i);
    expect(html).not.toMatch(/Scan Now|Rename|Move file|Add selected|Set as primary|select all/i);
    expect(html).not.toContain('name="selectedAssetIds"');
  });

  it('renders tag filtering without adding tag sorting controls', () => {
    const html = renderPage();

    expect(html).toContain('<select id="asset-tag" name="tag" disabled>');
    expect(html).toContain('<option value="" selected>All tags</option>');
    expect(html).not.toContain('sort=tag');
  });

  it('uses supplied URLs for clear and pagination links without rebuilding query strings in the template', () => {
    const model = {
      filters: {
        projectId: 2,
        category: 'renders',
        tag: 7,
        search: 'shared',
        extension: 'png',
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
      tagOptions: [{ value: '7', displayName: 'Context Tag' }],
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
      category: 'all',
      search: null,
      extension: null,
      tag: null,
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

  it('renders distinct unfiltered and filtered empty states, with a clear link only for filtered results', () => {
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
    expect(filtered).toMatch(/<div class="empty-state-actions">[\s\S]*>Clear filters<\/a>/);
    expect(filtered).not.toContain('No assets across active projects');
  });

  it('keeps the existing project-scoped asset detail template unchanged', () => {
    const source = fs.readFileSync(PROJECT_ASSET_VIEWER_PATH, 'utf8');

    expect(source).toContain('{% set page_title = "Assets — " ~ project.title ~ " — " ~ asset.filename %}');
    expect(source).toContain('action="/projects/{{ project.id }}/assets/{{ asset.id }}/primary-image"');
  });
});
