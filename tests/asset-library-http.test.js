import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { createWorkflowQueryService } from '../src/services/workflow-query-service.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { extractCsrfToken } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title, overrides = {}) {
  return {
    title,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: '',
    notes: '',
    status: 'tbd',
    projectType: 'images',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}

describe('cross-project Asset Viewer HTTP route', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let projectRepository;
  let assetRepository;
  let assetCategoryRepository;
  let tagRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-library-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });

    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
    tagRepository = createTagRepository(db);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title) {
    return projectRepository.create(projectInput(title));
  }

  function createCategory({ displayName, directorySlug, displayOrder = 0, enabled = true }) {
    return assetCategoryRepository.addDefault({
      displayName,
      directorySlug,
      displayOrder,
      enabled,
    });
  }

  function assignCategory(projectId, { displayName, directorySlug, displayOrder = 0, enabled = true }) {
    return assetCategoryRepository.addProjectCategory({
      projectId,
      displayName,
      directorySlug,
      displayOrder,
      enabled,
    });
  }

  function createAsset(projectId, relativePath, overrides = {}) {
    const filename = overrides.filename ?? path.posix.basename(relativePath);
    const extension = overrides.extension ?? filename.split('.').pop().toLowerCase();
    return assetRepository.upsert(projectId, relativePath, {
      filename,
      extension,
      mimeType: overrides.mimeType ?? ({
        png: 'image/png',
        jpg: 'image/jpeg',
        kra: 'application/x-krita',
      }[extension] || 'application/octet-stream'),
      sizeBytes: overrides.sizeBytes ?? 100,
      modifiedAt: overrides.modifiedAt ?? '2026-08-01 10:00:00',
      categoryId: overrides.categoryId ?? null,
    });
  }

  function installAssetLibraryPageSpy() {
    const projectOptionCatalogueService = app.locals.projectOptionCatalogueService;
    const workflowQueryService = createWorkflowQueryService({
      db,
      projectOptionCatalogueService,
    });
    const observedInputs = [];
    const originalGetAssetLibraryPage = workflowQueryService.getAssetLibraryPage.bind(workflowQueryService);
    const getAssetLibraryPage = vi.spyOn(workflowQueryService, 'getAssetLibraryPage');
    getAssetLibraryPage.mockImplementation((input, options) => {
      observedInputs.push(structuredClone(input));
      return originalGetAssetLibraryPage(input, options);
    });
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      projectOptionCatalogueService,
      workflowQueryService,
    });
    return { getAssetLibraryPage, observedInputs };
  }

  it('redirects the legacy Asset Viewer URL to the canonical route', async () => {
    const response = await request(app).get('/assets').expect(302);

    expect(response.headers.location).toBe('/asset-viewer');
  });

  it('preserves the legacy URL raw query suffix, including repeated keys and encoding', async () => {
    const rawQuery = 'tag=2&tag=1&search=A%2FB+%26+C&defaults=1&notice=kept';
    const response = await request(app).get(`/assets?${rawQuery}`).expect(302);

    expect(response.headers.location).toBe(`/asset-viewer?${rawQuery}`);
  });

  it.each(['/assets', '/assets/defaults', '/assets/nsfw-filter'])(
    'does not expose a POST compatibility alias at %s',
    async (url) => {
      await request(app).post(url).expect(404);
    },
  );

  it.each([
    ['/asset-viewer', 200, undefined],
    // WP9a: Reset restores the effective saved/default View, so the
    // fallback Grid is omitted from the canonical destination.
    ['/asset-viewer?resetFilters=1&view=grid', 302, '/asset-viewer'],
  ])('reuses the first page when neutral defaults leave the effective query unchanged: %s', async (url, status, location) => {
    const catalogueService = app.locals.projectOptionCatalogueService;
    const statusCatalogue = vi.spyOn(catalogueService, 'getStatusCatalogue');
    const projectTypeCatalogue = vi.spyOn(catalogueService, 'getProjectTypeCatalogue');
    writeAssetViewerDefaults({
      category: 'all', tag: 'all', extension: 'all', presence: 'all',
    });

    const { getAssetLibraryPage, observedInputs } = installAssetLibraryPageSpy();

    const response = await request(app).get(url).expect(status);

    expect(response.headers.location).toBe(location);
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(1);
    expect(observedInputs).toHaveLength(1);
    expect(observedInputs[0]).toMatchObject({
      categories: [], tags: [], extensions: [], presence: 'all', pageSize: 25,
    });
    expect(statusCatalogue).toHaveBeenCalledTimes(1);
    expect(projectTypeCatalogue).toHaveBeenCalledTimes(1);
  });

  it('reuses one Project option presentation for an invalid native Defaults POST and reloads it next request', async () => {
    const catalogueService = app.locals.projectOptionCatalogueService;
    const status = catalogueService.addOption('status', {
      name: 'Defaults Review',
      color: '#123456',
    });
    const projectType = catalogueService.addOption('projectType', {
      name: 'Defaults Illustration',
      color: '#654321',
    });
    const project = projectRepository.create(projectInput('Defaults Rerender Project', {
      status: status.value,
      projectType: projectType.value,
    }));
    const asset = createAsset(project.id, 'defaults-rerender.png');
    const firstTag = tagRepository.create({ displayName: 'First default tag', normalizedName: 'first-default-tag' });
    const secondTag = tagRepository.create({ displayName: 'Second default tag', normalizedName: 'second-default-tag' });
    tagRepository.assignToAsset(asset.id, firstTag.id);
    tagRepository.assignToAsset(asset.id, secondTag.id);

    const workflowQueryService = createWorkflowQueryService({
      db,
      projectOptionCatalogueService: catalogueService,
    });
    const buildProjectOptionPresentation = vi.spyOn(
      workflowQueryService,
      'buildAssetLibraryProjectOptionPresentation',
    );
    const getAssetLibraryPage = vi.spyOn(workflowQueryService, 'getAssetLibraryPage');
    const statusCatalogue = vi.spyOn(catalogueService, 'getStatusCatalogue');
    const projectTypeCatalogue = vi.spyOn(catalogueService, 'getProjectTypeCatalogue');
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      projectOptionCatalogueService: catalogueService,
      workflowQueryService,
    });

    const invalid = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({
        returnTo: '/asset-viewer?sort=modified',
        view: 'grid',
        gridStyle: 'uncropped',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: ['png', 'retired'],
        category: 'all',
        presence: 'all',
        tag: [String(firstTag.id), String(secondTag.id)],
      }))
      .expect(422);

    expect(statusCatalogue).toHaveBeenCalledTimes(1);
    expect(projectTypeCatalogue).toHaveBeenCalledTimes(1);
    expect(buildProjectOptionPresentation).toHaveBeenCalledTimes(1);
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(2);
    const pagePresentations = getAssetLibraryPage.mock.calls
      .map(([, options]) => options?.projectOptionPresentation);
    expect(pagePresentations[0]).toBeTruthy();
    expect(pagePresentations[1]).toBe(pagePresentations[0]);

    const defaultsForm = invalid.text.match(/<form id="asset-viewer-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';
    // WP9b: the combined dialog reopens with the rejected field reported in
    // its defaults form; the valid Tag selection is not flagged.
    expect(invalid.text).toMatch(/<dialog id="asset-viewer-filter-dialog"[^>]*data-app-dialog open/);
    expect(defaultsForm).toMatch(/data-asset-library-defaults-field-error="extension">[^<]*not supported for assetViewer\.extension/);
    expect(defaultsForm).not.toContain('data-asset-library-defaults-field-error="tag"');
    expect(invalid.text).toContain('--project-badge-bg: #123456;');
    expect(invalid.text).toContain('>Defaults Review</span>');
    expect(invalid.text).toContain('--project-badge-bg: #654321;');
    expect(invalid.text).toContain('>Defaults Illustration</span>');

    catalogueService.updateOptionColor('status', { value: status.value, color: '#ABCDEF' });
    catalogueService.updateOptionColor('projectType', { value: projectType.value, color: '#FEDCBA' });
    const fresh = await request(app).get('/asset-viewer?sort=modified').expect(200);

    expect(fresh.text).toContain('--project-badge-bg: #ABCDEF;');
    expect(fresh.text).toContain('--project-badge-bg: #FEDCBA;');
    expect(fresh.text).not.toContain('--project-badge-bg: #123456;');
    expect(fresh.text).not.toContain('--project-badge-bg: #654321;');
    expect(statusCatalogue).toHaveBeenCalledTimes(2);
    expect(projectTypeCatalogue).toHaveBeenCalledTimes(2);
  });

  it('keeps rich Project badges current across separate explicit-filter requests', async () => {
    const catalogueService = app.locals.projectOptionCatalogueService;
    const status = catalogueService.addOption('status', {
      name: 'HTTP Bespoke Review',
      color: '#123456',
    });
    const projectType = catalogueService.addOption('projectType', {
      name: 'HTTP Sequential Art',
      color: '#654321',
    });
    const project = projectRepository.create(projectInput('HTTP Catalogue Project', {
      status: status.value,
      projectType: projectType.value,
    }));
    createAsset(project.id, 'catalogue.png');
    const statusCatalogue = vi.spyOn(catalogueService, 'getStatusCatalogue');
    const projectTypeCatalogue = vi.spyOn(catalogueService, 'getProjectTypeCatalogue');

    const first = await request(app).get('/asset-viewer?sort=modified').expect(200);
    expect(first.text).toContain('--project-badge-bg: #123456;');
    expect(first.text).toContain('>HTTP Bespoke Review</span>');
    expect(first.text).toContain('--project-badge-bg: #654321;');
    expect(first.text).toContain('>HTTP Sequential Art</span>');

    catalogueService.updateOptionColor('status', { value: status.value, color: '#ABCDEF' });
    catalogueService.updateOptionColor('projectType', { value: projectType.value, color: '#FEDCBA' });

    const second = await request(app).get('/asset-viewer?sort=modified').expect(200);
    expect(second.text).toContain('--project-badge-bg: #ABCDEF;');
    expect(second.text).toContain('--project-badge-bg: #FEDCBA;');
    expect(second.text).not.toContain('--project-badge-bg: #123456;');
    expect(second.text).not.toContain('--project-badge-bg: #654321;');
    expect(statusCatalogue).toHaveBeenCalledTimes(2);
    expect(projectTypeCatalogue).toHaveBeenCalledTimes(2);
  });

  function markMissing(projectId) {
    assetRepository.markAllMissing(projectId);
  }

  function writePageDefault(page, option, value) {
    const key = PAGE_DEFAULT_DEFINITIONS[page][option].key;
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  // WP9a F6: every Save / Reset defaults carries the generation it was prepared
  // from, as the rendered form's hidden field does. Read at send time.
  function withDefaultsGeneration(body) {
    const generation = String(app.locals.pageDefaultsService.getMutationGeneration('assetViewer'));
    if (typeof body === 'string') return `${body}${body ? '&' : ''}defaultsGeneration=${generation}`;
    return { ...body, defaultsGeneration: generation };
  }

  // WP9b: the combined dialog shows saved defaults through the page's
  // authoritative metadata (stored-key presence + effective values), not
  // through per-field defaults selects.
  function pageAuthority(html) {
    const json = html.match(/<script type="application\/json" data-asset-library-defaults-authority>([\s\S]*?)<\/script>/)?.[1];
    return json ? JSON.parse(json) : null;
  }

  function sortedValues(value) {
    return Array.isArray(value) ? [...value].map(String).sort() : value;
  }

  function writeAssetViewerDefaults(values) {
    for (const [option, value] of Object.entries(values)) {
      writePageDefault('assetViewer', option, value);
    }
  }

  it('rebuilds the page when saved defaults change the effective query', async () => {
    const project = projectRepository.create(projectInput('Changed Filter Defaults', {
      projectType: 'images',
    }));
    createAsset(project.id, 'included.png');
    createAsset(project.id, 'excluded.jpg');
    writeAssetViewerDefaults({ extension: 'png' });
    const { getAssetLibraryPage, observedInputs } = installAssetLibraryPageSpy();

    const redirect = await request(app).get('/asset-viewer').expect(302);

    expect(redirect.headers.location).toBe('/asset-viewer?extension=png');
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(2);
    expect(observedInputs[0].extensions).toEqual([]);
    expect(observedInputs[1].extensions).toEqual(['png']);

    getAssetLibraryPage.mockClear();
    observedInputs.length = 0;
    const rendered = await request(app).get(redirect.headers.location).expect(200);
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(1);
    expect(observedInputs[0].extensions).toEqual(['png']);
    expect(rendered.text).toContain('included.png');
    expect(rendered.text).not.toContain('excluded.jpg');
  });

  it('keeps an explicit valid filter authoritative without rebuilding for a saved default', async () => {
    const project = projectRepository.create(projectInput('Explicit Filter Override', {
      projectType: 'images',
    }));
    createAsset(project.id, 'saved.png');
    createAsset(project.id, 'explicit.jpg');
    writeAssetViewerDefaults({ extension: 'png' });
    const { getAssetLibraryPage, observedInputs } = installAssetLibraryPageSpy();

    const rendered = await request(app).get('/asset-viewer?extension=jpg').expect(200);

    expect(rendered.headers.location).toBeUndefined();
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(1);
    expect(observedInputs[0].extensions).toEqual(['jpg']);
    expect(rendered.text).toContain('explicit.jpg');
    expect(rendered.text).not.toContain('saved.png');
  });

  it('preserves a saved View All page size while reusing the unchanged page model', async () => {
    const project = projectRepository.create(projectInput('View All Default', {
      projectType: 'images',
    }));
    createAsset(project.id, 'all.png');
    writeAssetViewerDefaults({ pageSize: 'all' });
    const { getAssetLibraryPage, observedInputs } = installAssetLibraryPageSpy();

    const redirect = await request(app).get('/asset-viewer').expect(302);

    expect(redirect.headers.location).toBe('/asset-viewer?pageSize=all');
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(1);
    expect(observedInputs[0].pageSize).toBe('all');

    getAssetLibraryPage.mockClear();
    observedInputs.length = 0;
    const rendered = await request(app).get(redirect.headers.location).expect(200);
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(1);
    expect(observedInputs[0].pageSize).toBe('all');
    expect(rendered.text).toMatch(/name="pageSize"[^>]+value="all" checked/);
    expect(rendered.text).not.toContain('NaN');
  });

  it('rebuilds Reset only when its resolved filter defaults change the effective query', async () => {
    const project = projectRepository.create(projectInput('Conditional Reset Rebuild', {
      projectType: 'images',
    }));
    createAsset(project.id, 'reset.png');
    writeAssetViewerDefaults({ extension: 'png' });
    const { getAssetLibraryPage, observedInputs } = installAssetLibraryPageSpy();

    const changed = await request(app)
      .get('/asset-viewer?resetFilters=1&view=list')
      .expect(302);
    expect(changed.headers.location).toBe('/asset-viewer?extension=png');
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(2);
    expect(observedInputs.map((input) => input.extensions)).toEqual([[], ['png']]);

    writeAssetViewerDefaults({ extension: 'all' });
    getAssetLibraryPage.mockClear();
    observedInputs.length = 0;
    const unchanged = await request(app)
      .get('/asset-viewer?resetFilters=1&view=grid')
      .expect(302);
    expect(unchanged.headers.location).toBe('/asset-viewer');
    expect(getAssetLibraryPage).toHaveBeenCalledTimes(1);
    expect(observedInputs[0].extensions).toEqual([]);
  });

  function insertReleaseUsage(projectId, assetId) {
    return insertRelease(projectId, 'Used Asset Release', assetId);
  }

  function insertRelease(projectId, title, assetId) {
    const release = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes,
                            planned_date, published_date, patreon_url, archived_at)
      VALUES (?, ?, '', '', NULL, NULL, NULL, NULL)
      RETURNING id
    `).get(projectId, title);
    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'attachment', 0)
    `).run(release.id, assetId);
    return release;
  }

  it('renders active-project assets, complete options, safe previews, and no mutation actions', async () => {
    createCategory({ displayName: 'Alternate References', directorySlug: 'alternate-references', displayOrder: 1 });
    createCategory({ displayName: 'Hidden', directorySlug: 'hidden', displayOrder: 2, enabled: false });
    createCategory({ displayName: 'Source', directorySlug: 'source', displayOrder: 3 });

    const alpha = createProject('Alpha Project');
    const beta = createProject('Beta Project');
    const archived = createProject('Archived Project');
    projectRepository.archive(archived.id);
    const alphaSource = assignCategory(alpha.id, { displayName: 'Source', directorySlug: 'source' });
    const betaSource = assignCategory(beta.id, { displayName: 'Source', directorySlug: 'source' });

    const alphaAsset = createAsset(alpha.id, 'source/shared.png', { categoryId: alphaSource.id });
    const betaAsset = createAsset(beta.id, 'source/shared.png', { categoryId: betaSource.id });
    const unsupported = createAsset(beta.id, 'source/archive.bin', { extension: 'bin', categoryId: betaSource.id });
    const missing = createAsset(beta.id, 'source/missing.png', { categoryId: betaSource.id });
    createAsset(archived.id, 'source/hidden.png', { categoryId: null });
    markMissing(beta.id);
    assetRepository.restorePresent(beta.id, ['source/shared.png', 'source/archive.bin']);

    const response = await request(app).get('/asset-viewer').expect(200);

    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('<title>CreatorCrate — Asset Viewer</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Asset Viewer</h1>');
    expect(response.text).toContain(
      '<a href="/asset-viewer" class="app-nav-link" data-nav-key="assets" aria-current="page">',
    );
    expect(response.text).toContain(
      '<a href="/asset-viewer" class="mobile-nav-link" data-nav-key="assets" aria-current="page">',
    );
    expect(response.text).toContain('Alpha Project');
    expect(response.text).toContain('Beta Project');
    expect(response.text).not.toContain('Archived Project');
    expect(response.text).not.toContain('hidden.png');
    expect(response.text).toContain(`href="/projects/${alpha.id}/assets/${alphaAsset.id}"`);
    expect(response.text).toContain(`href="/projects/${beta.id}/assets/${betaAsset.id}"`);
    expect(response.text).toContain(`src="/projects/${alpha.id}/assets/${alphaAsset.id}/preview?v=`);
    expect(response.text).not.toContain(`/projects/${beta.id}/assets/${unsupported.id}/preview`);
    expect(response.text).not.toContain(`/projects/${beta.id}/assets/${missing.id}/preview`);

    expect(response.text).not.toMatch(/Manually scan project files|Rename|Move file|Add selected|Set as primary|selectedAssetIds/i);

    await request(app).post('/assets').expect(404);
  });

  it('supports every WP3 page size across controls, defaults, URLs, Reset, views, and detail context', async () => {
    const project = projectRepository.create(projectInput('WP3 Page Size Project', {
      projectType: 'images',
    }));
    const asset = createAsset(project.id, 'wp3-page-size.png');

    for (const pageSize of ['150', '200']) {
      const response = await request(app).get(`/asset-viewer?pageSize=${pageSize}`).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.text).toMatch(new RegExp(`name="pageSize"[^>]+value="${pageSize}" checked`));
    }

    const all = await request(app).get('/asset-viewer?pageSize=all').expect(200);
    const filterForm = all.text.match(/<form id="asset-filters"[\s\S]*?<\/form>/)?.[0] || '';
    const filterPageSizes = [...filterForm.matchAll(/name="pageSize"[^>]*value="([^"]+)"/g)]
      .map(([, value]) => value);

    // WP9b: Assets per page (Miscellaneous) is the one page-size control; it
    // is also the value Save new defaults captures from the installed page.
    expect(filterPageSizes).toEqual(['10', '25', '50', '100', '150', '200', 'all']);
    expect(filterForm).toMatch(/name="pageSize"[^>]*value="all" checked/);
    expect(filterForm).toContain('View All');
    expect(filterForm).toContain('<legend>Assets per page</legend>');
    expect(pageAuthority(all.text).current.pageSize).toBe('all');
    expect(all.text).toContain('href="/asset-viewer?pageSize=all&amp;view=list"');
    expect(all.text).not.toContain('aria-label="Asset Viewer pages"');
    expect(all.text).toContain(
      `href="/projects/${project.id}/assets/${asset.id}?pageSize=all"`,
    );

    const detail = await request(app)
      .get(`/projects/${project.id}/assets/${asset.id}?pageSize=all`)
      .expect(200);
    expect(detail.text).toContain(`href="/projects/${project.id}/assets?pageSize=all"`);

    for (const pageSize of ['150', '200', 'all']) {
      await request(app)
        .post('/asset-viewer/defaults')
        .type('form')
        .send(withDefaultsGeneration({
          view: 'grid', gridStyle: 'uncropped', sort: 'filename', order: 'asc', pageSize,
          extension: 'all', category: 'all', presence: 'all', tag: 'all',
        }))
        .expect(302);
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.assetViewer.pageSize.key).value).toBe(pageSize);
    }

    const bare = await request(app).get('/asset-viewer').expect(302);
    expect(bare.headers.location).toBe('/asset-viewer?pageSize=all');

    const explicitFinite = await request(app).get('/asset-viewer?pageSize=25').expect(200);
    expect(explicitFinite.headers.location).toBeUndefined();
    expect(explicitFinite.text).toMatch(/name="pageSize"[^>]+value="25" checked/);

    const reset = await request(app).get('/asset-viewer?resetFilters=1&view=grid').expect(302);
    expect(reset.headers.location).toBe('/asset-viewer?pageSize=all');
  });

  it('renders effective tags in both views while exposing the reusable tag filter', async () => {
    const project = createProject('Tagged Asset Viewer Project');
    const present = createAsset(project.id, 'present.png');
    const missing = createAsset(project.id, 'missing.png');
    markMissing(project.id);
    assetRepository.restorePresent(project.id, ['present.png']);

    const shared = tagRepository.create({ displayName: 'HTTP Shared Tag', normalizedName: 'http-shared-secret' });
    const presentOnly = tagRepository.create({ displayName: 'HTTP Present Tag', normalizedName: 'http-present-secret' });
    const projectOnly = tagRepository.create({ displayName: 'HTTP Project Only Tag', normalizedName: 'http-project-only-secret' });
    tagRepository.assignToAsset(present.id, shared.id);
    tagRepository.assignToAsset(present.id, presentOnly.id);
    tagRepository.assignToAsset(missing.id, shared.id);
    tagRepository.assignToProject(project.id, projectOnly.id);

    const grid = await request(app).get('/asset-viewer').expect(200);
    expect(grid.text).toContain('<ul class="asset-viewer-grid-card-info-tags" aria-label="Effective tags">');
    expect((grid.text.match(/>HTTP Shared Tag<\/li>/g) || [])).toHaveLength(2);
    expect(grid.text).toContain('HTTP Present Tag');
    expect(grid.text).toContain('Missing at last scan');
    expect(grid.text).toMatch(new RegExp(`name="tag"[^>]+value="${shared.id}"`));
    expect(grid.text).toMatch(new RegExp(`name="tag"[^>]+value="${projectOnly.id}"`));
    expect((grid.text.match(/HTTP Project Only Tag <span class="asset-tag-origin">/g) || [])).toHaveLength(2);
    expect(grid.text).not.toContain('http-shared-secret');
    expect(grid.text).not.toContain('<select id="asset-tag"');

    const list = await request(app).get('/asset-viewer?view=list').expect(200);
    expect(list.text).toContain('<ul class="asset-list asset-list--library" role="list" aria-label="Assets across active projects">');
    expect(list.text).not.toContain('<table class="data-table asset-table">');
    expect((list.text.match(/<article class="asset-list-card"/g) || [])).toHaveLength(2);
    expect((list.text.match(/<ul class="asset-viewer-grid-card-info-tags" aria-label="Effective tags">/g) || [])).toHaveLength(2);
    expect(list.text).toMatch(new RegExp(`name="tag"[^>]+value="${shared.id}"`));
    expect((list.text.match(/<span class="asset-tag-origin">/g) || [])).toHaveLength(2);
    expect((list.text.match(/<span class="asset-tag-origin"><span class="sr-only">Inherited from <\/span>Project<\/span>/g) || [])).toHaveLength(2);
    expect(list.text).not.toContain('http-shared-secret');
    expect(list.text).not.toContain('<select id="asset-tag"');
  });

  it('uses the larger preview derivative for PNG, JPEG, and Krita List previews', async () => {
    const project = createProject('List Preview Sources Project');
    const png = createAsset(project.id, 'renders/hero.png');
    const jpeg = createAsset(project.id, 'references/photo.jpg');
    const krita = createAsset(project.id, 'source/painting.kra');

    const response = await request(app).get('/asset-viewer?view=list').expect(200);
    const cards = response.text.match(/<article class="asset-list-card"[\s\S]*?<\/article>/g) || [];

    expect(cards).toHaveLength(3);
    for (const asset of [png, jpeg, krita]) {
      const card = cards.find((candidate) => candidate.includes(`assets/${asset.id}`));
      expect(card).toBeDefined();
      expect(card).toMatch(new RegExp(`src="/projects/${project.id}/assets/${asset.id}/preview\\?v=`));
      expect(card).not.toContain(`/projects/${project.id}/assets/${asset.id}/thumbnail`);
      expect(card).toContain(`class="asset-list-card-media-link" href="/projects/${project.id}/assets/${asset.id}"`);
      expect(card).toContain(`data-calendar-info-trigger aria-controls="asset-library-list-info-${asset.id}"`);
      expect(card).toContain(`<a class="button button-small button-secondary" href="/projects/${project.id}/assets/${asset.id}">Open asset</a>`);
    }
  });

  it('filters global assets by direct or inherited reusable tag assignments across projects', async () => {
    const alpha = createProject('Tag Filter Alpha');
    const beta = createProject('Tag Filter Beta');
    const shared = tagRepository.create({ displayName: 'Shared Filter Tag', normalizedName: 'shared-filter-secret' });
    const additional = tagRepository.create({ displayName: 'Additional Filter Tag', normalizedName: 'additional-filter-secret' });
    const projectOnly = tagRepository.create({ displayName: 'Project Filter Tag', normalizedName: 'project-filter-secret' });
    const alphaFirst = createAsset(alpha.id, 'alpha-first.png');
    const alphaMultiple = createAsset(alpha.id, 'alpha-multiple.png');
    const betaMissing = createAsset(beta.id, 'beta-missing.png');
    createAsset(beta.id, 'beta-untagged.png');

    tagRepository.assignToAsset(alphaFirst.id, shared.id);
    tagRepository.assignToAsset(alphaMultiple.id, shared.id);
    tagRepository.assignToAsset(alphaMultiple.id, additional.id);
    tagRepository.assignToAsset(betaMissing.id, shared.id);
    tagRepository.assignToProject(alpha.id, projectOnly.id);
    markMissing(beta.id);

    const response = await request(app).get(`/asset-viewer?tag=${shared.id}&view=list`).expect(200);

    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('<ul class="asset-list asset-list--library" role="list" aria-label="Assets across active projects">');
    expect(response.text).not.toContain('<table class="data-table asset-table">');
    expect((response.text.match(/<article class="asset-list-card"/g) || [])).toHaveLength(3);
    expect(response.text).toContain('alpha-first.png');
    expect(response.text).toContain('alpha-multiple.png');
    expect(response.text).toContain('beta-missing.png');
    expect(response.text).not.toContain('beta-untagged.png');
    expect(response.text).toMatch(new RegExp(`name="tag"[^>]+value="${shared.id}" checked`));
    expect((response.text.match(/<span class="asset-tag-origin">/g) || [])).toHaveLength(2);
    expect(response.text).toContain('3 assets found');

    const inheritedResponse = await request(app).get(`/asset-viewer?tag=${projectOnly.id}&view=list`).expect(200);
    expect(inheritedResponse.text).toContain('<ul class="asset-list asset-list--library" role="list" aria-label="Assets across active projects">');
    expect(inheritedResponse.text).not.toContain('<table class="data-table asset-table">');
    expect((inheritedResponse.text.match(/<article class="asset-list-card"/g) || [])).toHaveLength(2);
    expect(inheritedResponse.text).toContain('alpha-first.png');
    expect(inheritedResponse.text).toContain('alpha-multiple.png');
    expect(inheritedResponse.text).not.toContain('beta-missing.png');
    expect(inheritedResponse.text).toContain('2 assets found');
  });

  it('canonicalizes repeated selections and preserves them through pagination and view links', async () => {
    createCategory({ displayName: 'Final', directorySlug: 'test-final', displayOrder: 5 });
    createCategory({ displayName: 'KRZ', directorySlug: 'test-krz', displayOrder: 6 });
    const alpha = createProject('Repeated Filter Alpha');
    const beta = createProject('Repeated Filter Beta');
    const alphaFinal = assignCategory(alpha.id, { displayName: 'Final', directorySlug: 'test-final' });
    const betaKrz = assignCategory(beta.id, { displayName: 'KRZ', directorySlug: 'test-krz' });
    const tagA = tagRepository.create({ displayName: 'Repeated Tag A', normalizedName: 'repeated-tag-a' });
    const tagB = tagRepository.create({ displayName: 'Repeated Tag B', normalizedName: 'repeated-tag-b' });
    tagRepository.assignToProject(alpha.id, tagA.id);
    tagRepository.assignToProject(beta.id, tagB.id);

    for (let index = 1; index <= 6; index++) {
      createAsset(alpha.id, `test-final/alpha-${String(index).padStart(2, '0')}.png`, {
        categoryId: alphaFinal.id,
        extension: 'png',
      });
    }
    for (let index = 1; index <= 5; index++) {
      createAsset(beta.id, `test-krz/beta-${String(index).padStart(2, '0')}.krz`, {
        categoryId: betaKrz.id,
        extension: 'krz',
      });
    }

    const tagValues = [tagA.id, tagB.id].sort((left, right) => left - right);
    const redirect = await request(app).get(
      `/asset-viewer?tag=${tagB.id}&tag=${tagA.id}&tag=${tagB.id}&tag=999999`
      + '&category=test-krz&category=test-final&category=all&category=not-a-valid-category'
      + '&extension=.KRZ&extension=png&extension=png&extension=unknown'
      + '&sort=project&page=2&pageSize=10&view=list',
    ).expect(302);

    const canonicalUrl = `/asset-viewer?category=test-final&category=test-krz&tag=${tagValues[0]}&tag=${tagValues[1]}`
      + '&extension=krz&extension=png&sort=project&page=2&pageSize=10&view=list';
    expect(redirect.headers.location).toBe(canonicalUrl);

    const response = await request(app).get(canonicalUrl).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('11 assets found');
    expect(response.text).toContain('Page 2 of 2');

    const escapedContext = `category=test-final&amp;category=test-krz&amp;tag=${tagValues[0]}&amp;tag=${tagValues[1]}`
      + '&amp;extension=krz&amp;extension=png&amp;sort=project';
    expect(response.text).toContain(`${escapedContext}&amp;pageSize=10&amp;view=list`);
    expect(response.text).toContain(`${escapedContext}&amp;page=2&amp;pageSize=10&amp;view=grid`);
    expect(response.text).toMatch(/name="category"[^>]+value="test-final" checked/);
    expect(response.text).toMatch(/name="category"[^>]+value="test-krz" checked/);
    expect(response.text).toMatch(/name="extension"[^>]+value="krz" checked/);
    expect(response.text).toMatch(/name="extension"[^>]+value="png" checked/);
  });

  it('canonicalizes malformed, nonexistent, and deleted tags once without redirect loops', async () => {
    const invalidValues = ['', '0', '-1', '1.5', '1junk', 'not-a-number', '9007199254740992', '9999'];

    for (const value of invalidValues) {
      const redirect = await request(app)
        .get(`/asset-viewer?tag=${encodeURIComponent(value)}&search=keep`)
        .expect(302);
      expect(redirect.headers.location).toBe('/asset-viewer?search=keep');

      const canonical = await request(app).get(redirect.headers.location).expect(200);
      expect(canonical.headers.location).toBeUndefined();
    }

    const deleted = tagRepository.create({ displayName: 'Deleted Filter Tag', normalizedName: 'deleted-filter-secret' });
    tagRepository.deleteById(deleted.id);
    const redirect = await request(app)
      .get(`/asset-viewer?tag=${deleted.id}&search=keep`)
      .expect(302);

    expect(redirect.headers.location).toBe('/asset-viewer?search=keep');
    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
  });

  it('maps every supported filter to the read-only page query and renders list view', async () => {
    const alpha = createProject('Filtered Alpha');
    const beta = createProject('Filtered Beta');
    createCategory({ displayName: 'Source', directorySlug: 'source' });
    const alphaSource = assignCategory(alpha.id, { displayName: 'Source', directorySlug: 'source' });
    const betaSource = assignCategory(beta.id, { displayName: 'Source', directorySlug: 'source' });
    const selected = createAsset(alpha.id, 'source/shared.png', {
      categoryId: alphaSource.id,
      filename: 'shared.png',
      extension: 'PNG',
    });
    const used = createAsset(beta.id, 'source/shared.png', {
      categoryId: betaSource.id,
      filename: 'shared.png',
      extension: 'PNG',
    });
    createAsset(alpha.id, 'source/other.jpg', { categoryId: alphaSource.id, extension: 'jpg' });
    insertReleaseUsage(beta.id, used.id);

    const query = `/asset-viewer?project=${alpha.id}&category=source&search=shared&extension=.PNG&presence=present&usage=unused&sort=project&order=desc&page=1&pageSize=50&view=list`;
    const redirect = await request(app).get(query).expect(302);
    expect(redirect.headers.location).toBe(
      `/asset-viewer?project=${alpha.id}&category=source&search=shared&extension=png&presence=present&usage=unused&sort=project&order=desc&pageSize=50&view=list`,
    );

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('<ul class="asset-list asset-list--library" role="list" aria-label="Assets across active projects">');
    expect(response.text).not.toContain('<table class="data-table asset-table">');
    expect(response.text).toContain('shared.png');
    expect(response.text).toContain(`href="/projects/${alpha.id}/assets/${selected.id}"`);
    expect(response.text).not.toContain(`href="/projects/${beta.id}/assets/${used.id}"`);
    expect(response.text).toMatch(new RegExp(
      `<input[^>]+name="project" type="checkbox" value="${alpha.id}" checked>`,
    ));
    expect(response.text).toContain('aria-label="Projects filter: Filtered Alpha"');
    expect(response.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="view"[^>]+type="radio"[^>]+value="list" checked>/);
    expect(response.text).not.toContain('id="asset-search"');
    // WP9b: the results Search field shows the current Search.
    expect(response.text).toMatch(/<input id="asset-library-search" name="search" type="search" value="shared"/);
    expect((response.text.match(/<input[^>]+name="search"/g) || [])).toHaveLength(1);
    expect(response.text).toContain('id="asset-project-filter-search"');
    expect(response.text).toContain('data-cc-dropdown-option-list');
    expect(response.text).not.toContain('data-asset-project-filter');
  });

  it('redirects once to valid saved presentation defaults and renders the final URL directly', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    createAsset(createProject('Saved Defaults Project').id, 'saved.png');

    const redirect = await request(app).get('/asset-viewer').expect(302);
    expect(redirect.headers.location).toBe('/asset-viewer?sort=project&order=desc&pageSize=50&view=list');

    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
    expect(canonical.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
    expect(canonical.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(canonical.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
    expect(canonical.text).toMatch(/<input[^>]+name="view"[^>]+type="radio"[^>]+value="list" checked>/);

    const final = await request(app).get(redirect.headers.location).expect(200);
    expect(final.headers.location).toBeUndefined();
  });

  it('does not redirect when saved Asset Viewer preferences are missing or fallback-equivalent', async () => {
    const missing = await request(app).get('/asset-viewer').expect(200);
    expect(missing.headers.location).toBeUndefined();

    writeAssetViewerDefaults({ view: 'grid', sort: 'filename', order: 'asc', pageSize: '25' });
    const fallbackEquivalent = await request(app).get('/asset-viewer').expect(200);
    expect(fallbackEquivalent.headers.location).toBeUndefined();
  });

  it('accepts the CSRF tokens rendered in the NSFW and defaults forms', async () => {
    const csrfAppDataRoot = path.join(tmpDir, 'csrf-app');
    fs.mkdirSync(csrfAppDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(csrfAppDataRoot);
    const csrfApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot: csrfAppDataRoot, authState: { csrfPepper } },
    );
    const agent = request.agent(csrfApp);
    const rendered = await agent.get('/asset-viewer').expect(200);
    const nsfwForm = rendered.text.match(/<form[^>]+action="\/asset-viewer\/nsfw-filter"[\s\S]*?<\/form>/)?.[0] || '';
    // WP9b F2: the explicit Save controller reads its token from this form.
    const defaultsForm = rendered.text.match(/<form id="asset-viewer-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';
    expect(nsfwForm).not.toBe('');
    expect(defaultsForm).not.toBe('');

    const nsfwToken = extractCsrfToken(nsfwForm);
    const defaultsToken = extractCsrfToken(defaultsForm);
    expect(nsfwToken).not.toBe('');
    expect(defaultsToken).not.toBe('');

    await agent
      .post('/asset-viewer/nsfw-filter')
      .type('form')
      .send({ _csrf: nsfwToken, enabled: '1' })
      .expect(302);
    await agent
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({ _csrf: defaultsToken, view: 'list', gridStyle: 'uncropped', sort: 'project', order: 'desc', pageSize: '50', extension: 'all', category: 'all', presence: 'all', tag: 'all' }))
      .expect(302);
  });

  it('redirects normal defaults saves to a known notice and renders it without canonicalizing it away', async () => {
    const save = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({ view: 'list', gridStyle: 'uncropped', sort: 'project', order: 'desc', pageSize: '50', extension: 'all', category: 'all', presence: 'all', tag: 'all' }))
      .expect(302);

    expect(save.headers.location).toBe(
      '/asset-viewer?sort=project&order=desc&pageSize=50&view=list&notice=asset_viewer_defaults_saved',
    );

    const redirected = await request(app).get(save.headers.location).expect(200);
    expect(redirected.headers.location).toBeUndefined();
    expect(redirected.text).toContain('Asset Viewer defaults saved successfully.');
  });

  it('probes dimensions only after canonicalization and only for the rendered grid page', async () => {
    const project = projectRepository.create(projectInput('Dimension Probe Project', {
      projectType: 'images',
    }));
    const assets = Array.from({ length: 11 }, (_, index) => createAsset(
      project.id,
      `source-${String(index + 1).padStart(2, '0')}.png`,
    ));
    const calls = [];
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      assetWorkflowMetadataService: {
        async getImageDimensions(asset) {
          calls.push(asset.id);
          if (asset.id === assets[0].id) throw new Error('Unreadable source');
          return { width: 640, height: 480 };
        },
      },
    });

    const redirect = await request(app).get('/asset-viewer?unknown=discard&pageSize=10').expect(302);
    expect(redirect.headers.location).toBe('/asset-viewer?pageSize=10');
    expect(calls).toEqual([]);

    await request(app).get(redirect.headers.location).expect(200);
    expect(calls).toEqual(assets.slice(0, 10).map((asset) => asset.id));

    await request(app).get('/asset-viewer?pageSize=10&view=list').expect(200);
    expect(calls).toEqual(assets.slice(0, 10).map((asset) => asset.id));
  });

  it('settles dimension failures on Defaults and NSFW validation rerenders', async () => {
    const project = projectRepository.create(projectInput('Dimension Rerender Project', {
      projectType: 'images',
    }));
    createAsset(project.id, 'rerender.png');
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      assetWorkflowMetadataService: {
        async getImageDimensions() {
          throw new Error('Dimension reader failed');
        },
      },
    });

    const defaults = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({
        view: 'grid',
        gridStyle: 'uncropped',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: 'unknown',
        category: 'all',
        presence: 'all',
        tag: 'all',
      }))
      .expect(422);
    expect(defaults.text).toContain('Filters &amp; Defaults');
    expect(defaults.text).toContain('data-asset-library-defaults-field-error="extension"');

    const nsfw = await request(app)
      .post('/asset-viewer/nsfw-filter')
      .type('form')
      .send({ enabled: 'invalid', returnTo: '/asset-viewer' })
      .expect(422);
    expect(nsfw.text).toContain('NSFW filter setting is invalid.');
  });

  it('renders, stores, and canonically applies live Asset Viewer filter defaults', async () => {
    const project = createProject('Live Defaults Project');
    createCategory({ displayName: 'Reference artwork', directorySlug: 'reference-artwork' });
    const category = assignCategory(project.id, {
      displayName: 'Reference artwork',
      directorySlug: 'reference-artwork',
    });
    const asset = createAsset(project.id, 'reference.png', { categoryId: category.id, extension: 'png' });
    const tag = tagRepository.create({ displayName: 'Featured artwork', normalizedName: 'featured-artwork' });
    tagRepository.assignToAsset(asset.id, tag.id);

    const save = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({
        view: 'grid',
        gridStyle: 'uncropped',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: 'png',
        category: 'reference-artwork',
        presence: 'present',
        tag: String(tag.id),
      }))
      .expect(302);

    expect(save.headers.location).toBe(
      `/asset-viewer?category=reference-artwork&tag=${tag.id}&extension=png&presence=present&notice=asset_viewer_defaults_saved`,
    );
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.extension.key).value).toBe('["png"]');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.category.key).value).toBe('["reference-artwork"]');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.presence.key).value).toBe('present');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.tag.key).value).toBe(`["${tag.id}"]`);

    const bare = await request(app).get('/asset-viewer').expect(302);
    expect(bare.headers.location).toBe(
      `/asset-viewer?category=reference-artwork&tag=${tag.id}&extension=png&presence=present`,
    );
    const canonical = await request(app).get(bare.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();

    createAsset(project.id, 'other.jpg', { extension: 'jpg' });
    const explicit = await request(app).get('/asset-viewer?extension=jpg').expect(200);
    expect(explicit.headers.location).toBeUndefined();
    expect(explicit.text).toContain('other.jpg');
    expect(explicit.text).not.toContain('reference.png');

    const explicitNeutral = await request(app).get('/asset-viewer?presence=all').expect(200);
    expect(explicitNeutral.headers.location).toBeUndefined();
    expect(explicitNeutral.text).toMatch(/name="presence"[^>]+value="all" checked/);

    const reset = await request(app).get('/asset-viewer?view=grid').expect(200);
    expect(reset.headers.location).toBeUndefined();
    expect(reset.text).toContain('reference.png');
  });

  it('persists and applies every saved Asset Viewer Extension and Tag value', async () => {
    const project = projectRepository.create({
      ...projectInput('Multiple Defaults Project'),
      projectType: 'images',
    });
    const png = createAsset(project.id, 'first.png', { extension: 'png' });
    const jpg = createAsset(project.id, 'second.jpg', { extension: 'jpg' });
    const firstTag = tagRepository.create({ displayName: 'First tag', normalizedName: 'first-tag' });
    const secondTag = tagRepository.create({ displayName: 'Second tag', normalizedName: 'second-tag' });
    tagRepository.assignToAsset(png.id, firstTag.id);
    tagRepository.assignToAsset(jpg.id, secondTag.id);

    const save = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({
        view: 'grid',
        gridStyle: 'uncropped',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: ['png', 'jpg'],
        category: 'all',
        presence: 'all',
        tag: [String(firstTag.id), String(secondTag.id)],
      }))
      .expect(302);

    const expectedFilters = `tag=${firstTag.id}&tag=${secondTag.id}&extension=jpg&extension=png`;
    expect(save.headers.location).toBe(`/asset-viewer?${expectedFilters}&notice=asset_viewer_defaults_saved`);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS.assetViewer.extension.key).value).toBe('["png","jpg"]');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS.assetViewer.tag.key).value)
      .toBe(`["${firstTag.id}","${secondTag.id}"]`);

    const bare = await request(app).get('/asset-viewer').expect(302);
    expect(bare.headers.location).toBe(`/asset-viewer?${expectedFilters}`);
    const canonical = await request(app).get(bare.headers.location).expect(200);
    expect(canonical.text).toContain('first.png');
    expect(canonical.text).toContain('second.jpg');

    const reopened = await request(app).get('/asset-viewer?defaults=1').expect(200);
    const authority = pageAuthority(reopened.text);
    expect(reopened.text).toMatch(/<dialog id="asset-viewer-filter-dialog"[^>]*data-app-dialog open/);
    expect(sortedValues(authority.defaults.extension)).toEqual(['jpg', 'png']);
    expect(sortedValues(authority.defaults.tag)).toEqual([String(firstTag.id), String(secondTag.id)].sort());
    expect(authority.saved.extension).toEqual({ stored: true, valid: true });
    expect(authority.saved.tag).toEqual({ stored: true, valid: true });
  });

  it('WP2 persists and applies every saved Asset Viewer Category and keeps legacy scalar Categories', async () => {
    const project = createProject('Category Defaults Project');
    for (const [displayName, directorySlug] of [['Sketches', 'sketches'], ['Finals', 'finals'], ['Extras', 'extras']]) {
      createCategory({ displayName, directorySlug });
    }
    const sketches = assignCategory(project.id, { displayName: 'Sketches', directorySlug: 'sketches' });
    const finals = assignCategory(project.id, { displayName: 'Finals', directorySlug: 'finals' });
    const extras = assignCategory(project.id, { displayName: 'Extras', directorySlug: 'extras' });
    createAsset(project.id, 'sketch.png', { categoryId: sketches.id, extension: 'png' });
    createAsset(project.id, 'final.png', { categoryId: finals.id, extension: 'png' });
    createAsset(project.id, 'extra.jpg', { categoryId: extras.id, extension: 'jpg' });
    const categoryKey = PAGE_DEFAULT_DEFINITIONS.assetViewer.category.key;
    const readCategory = () => db.prepare('SELECT value FROM app_meta WHERE key = ?').get(categoryKey)?.value;

    const save = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({
        view: 'grid',
        gridStyle: 'uncropped',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: 'png',
        category: ['sketches', 'finals'],
        presence: 'all',
        tag: 'all',
      }))
      .expect(302);

    // Every Category survives alongside the other saved filters.
    expect(save.headers.location)
      .toBe('/asset-viewer?category=finals&category=sketches&extension=png&notice=asset_viewer_defaults_saved');
    expect(readCategory()).toBe('["sketches","finals"]');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS.assetViewer.extension.key).value).toBe('["png"]');

    const bare = await request(app).get('/asset-viewer').expect(302);
    expect(bare.headers.location).toBe('/asset-viewer?category=finals&category=sketches&extension=png');
    const canonical = await request(app).get(bare.headers.location).expect(200);
    expect(canonical.text).toContain('sketch.png');
    expect(canonical.text).toContain('final.png');
    expect(canonical.text).not.toContain('extra.jpg');

    // An explicit Category query still wins over the saved selection.
    const explicit = await request(app).get('/asset-viewer?category=extras').expect(200);
    expect(explicit.text).toContain('extra.jpg');
    expect(explicit.text).not.toContain('sketch.png');

    const reopened = await request(app).get('/asset-viewer?defaults=1').expect(200);
    expect(sortedValues(pageAuthority(reopened.text).defaults.category)).toEqual(['finals', 'sketches']);

    // A legacy scalar resolves as the one-value selection and is not rewritten.
    writeAssetViewerDefaults({ category: 'extras', extension: 'all' });
    const legacy = await request(app).get('/asset-viewer').expect(302);
    expect(legacy.headers.location).toBe('/asset-viewer?category=extras');
    expect(readCategory()).toBe('extras');

    // Unrestricted: an omitted multi-select saves 'all' and resolves to no filter.
    await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({ view: 'grid', gridStyle: 'uncropped', sort: 'filename', order: 'asc', pageSize: '25', presence: 'all' }))
      .expect(302);
    expect(readCategory()).toBe('all');
    const unrestricted = await request(app).get('/asset-viewer').expect(200);
    expect(unrestricted.text).toContain('sketch.png');
    expect(unrestricted.text).toContain('extra.jpg');
  });

  it('normalizes omitted Asset Viewer multi-select defaults to neutral all', async () => {
    await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({ view: 'grid', gridStyle: 'uncropped', sort: 'filename', order: 'asc', pageSize: '25', category: 'all', presence: 'all' }))
      .expect(302);

    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS.assetViewer.extension.key).value).toBe('all');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS.assetViewer.tag.key).value).toBe('all');
  });

  it('keeps global Extension defaults available while the page is filtered to another project', async () => {
    const alpha = createProject('Global extension Alpha');
    const beta = createProject('Global extension Beta');
    createAsset(alpha.id, 'alpha.png', { extension: 'png' });
    createAsset(beta.id, 'beta.jpg', { extension: 'jpg' });
    writeAssetViewerDefaults({ extension: 'png' });

    const returnTo = `/asset-viewer?project=${beta.id}&defaults=1`;
    const dialog = await request(app).get(returnTo).expect(200);
    const filterForm = dialog.text.match(/<form id="asset-filters"[\s\S]*?<\/form>/)?.[0] || '';
    const authority = pageAuthority(dialog.text);

    // The saved Global value stays known even though the filtered page's
    // Extension choices no longer include it.
    expect(authority.defaults.extension).toEqual(['png']);
    expect(authority.saved.extension).toEqual({ stored: true, valid: true });
    expect(filterForm).toMatch(/name="extension"[^>]+value="jpg"/);
    expect(filterForm).not.toMatch(/name="extension"[^>]+value="png"/);

    await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({
        returnTo,
        view: 'grid',
        gridStyle: 'uncropped',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: 'png',
        category: 'all',
        presence: 'all',
        tag: 'all',
      }))
      .expect(302);

    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.extension.key).value).toBe('["png"]');
  });

  it('rejects invalid dynamic defaults and leaves stale dynamic defaults neutral without rewriting storage', async () => {
    const invalid = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({
        view: 'grid',
        gridStyle: 'uncropped',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: 'retired',
        category: 'retired',
        presence: 'unknown',
        tag: '999',
      }))
      .expect(422);
    expect(invalid.text).toContain('not supported for assetViewer.extension');

    writeAssetViewerDefaults({
      extension: 'retired',
      category: 'retired',
      presence: 'unknown',
      tag: '999',
    });
    const rendered = await request(app).get('/asset-viewer?defaults=1').expect(200);
    const authority = pageAuthority(rendered.text);
    // Stale stored values resolve to the neutral fallbacks, while presence
    // still reports them as stored (and invalid).
    for (const field of ['extension', 'category', 'presence', 'tag']) {
      expect(authority.defaults[field]).toBe('all');
      expect(authority.saved[field]).toEqual({ stored: true, valid: false });
    }
    expect(rendered.text).toMatch(/data-asset-library-defaults-indicator>4 of 9 defaults saved\.<\/p>/);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.extension.key).value).toBe('retired');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.category.key).value).toBe('retired');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.presence.key).value).toBe('unknown');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.assetViewer.tag.key).value).toBe('999');
  });

  it('applies page-local Asset Viewer defaults on a later bare render', async () => {
    await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({ view: 'list', gridStyle: 'uncropped', sort: 'project', order: 'desc', pageSize: '50', extension: 'all', category: 'all', presence: 'all', tag: 'all' }))
      .expect(302);

    const bare = await request(app).get('/asset-viewer').expect(302);
    expect(bare.headers.location).toBe('/asset-viewer?sort=project&order=desc&pageSize=50&view=list');

    const rendered = await request(app).get(bare.headers.location).expect(200);
    expect(rendered.headers.location).toBeUndefined();
    expect(rendered.text).toMatch(/name="sort"[^>]+value="project" checked/);
    expect(rendered.text).toMatch(/name="order"[^>]+value="desc" checked/);
    expect(rendered.text).toMatch(/name="pageSize"[^>]+value="50" checked/);
    expect(rendered.text).toMatch(/<input[^>]+name="view"[^>]+type="radio"[^>]+value="list" checked>/);
  });

  it('renders the saved Grid style on the Asset Viewer grid only, defaulting to Uncropped', async () => {
    const project = createProject('Grid Style Project');
    createAsset(project.id, 'cover.png');
    createAsset(project.id, 'page-two.png');
    const gridStyleOf = (html) => html.match(/<ul class="asset-grid"[^>]*data-grid-style="([^"]*)"/)?.[1];
    const getRendered = async (url) => {
      const response = await request(app).get(url);
      if (response.status !== 302) return response;
      return request(app).get(response.headers.location).expect(200);
    };

    const initial = await request(app).get('/asset-viewer').expect(200);
    expect(gridStyleOf(initial.text)).toBe('uncropped');
    // WP9b: Miscellaneous orders View, Grid style, Assets per page.
    const viewField = initial.text.indexOf('<legend>View</legend>');
    const gridStyleField = initial.text.indexOf('<legend>Grid style</legend>');
    const pageSizeField = initial.text.indexOf('<legend>Assets per page</legend>');
    expect(viewField).toBeGreaterThan(-1);
    expect(gridStyleField).toBeGreaterThan(viewField);
    expect(pageSizeField).toBeGreaterThan(gridStyleField);
    expect(initial.text).toMatch(/id="asset-library-grid-style"[\s\S]*?<option value="uncropped" selected>/);

    const save = await request(app)
      .post('/asset-viewer/defaults')
      .type('form')
      .send(withDefaultsGeneration({ view: 'grid', gridStyle: 'cropped', sort: 'filename', order: 'asc', pageSize: '25', extension: 'all', category: 'all', presence: 'all', tag: 'all' }))
      .expect(302);
    expect(save.headers.location).not.toContain('gridStyle');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS.assetViewer.gridStyle.key)?.value).toBe('cropped');

    const cropped = await request(app).get('/asset-viewer').expect(200);
    expect(gridStyleOf(cropped.text)).toBe('cropped');
    expect(cropped.text).toMatch(/id="asset-library-grid-style"[\s\S]*?<option value="cropped" selected>/);

    const filtered = await getRendered('/asset-viewer?search=cover&pageSize=10&page=1');
    expect(filtered.text).toContain('1 asset found');
    expect(gridStyleOf(filtered.text)).toBe('cropped');
    const gridStyleQuery = await getRendered('/asset-viewer?gridStyle=uncropped');
    expect(gridStyleOf(gridStyleQuery.text)).toBe('cropped');

    const list = await getRendered('/asset-viewer?view=list');
    expect(list.text).not.toContain('data-grid-style');
    expect(list.text).toContain('asset-list-table--library');
  });

  it('ignores arbitrary Asset Viewer notice values during canonicalization and rendering', async () => {
    const redirect = await request(app).get('/asset-viewer?notice=not-a-real-notice').expect(302);

    expect(redirect.headers.location).toBe('/asset-viewer');

    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
    expect(canonical.text).not.toContain('not-a-real-notice');
    expect(canonical.text).not.toContain('Asset Viewer defaults saved successfully.');
  });

  it('ignores invalid stored Asset Viewer values and keeps Project Assets defaults separate', async () => {
    const project = createProject('Default Scope Project');
    createAsset(project.id, 'scope.png');
    writeAssetViewerDefaults({ view: 'board', sort: 'title', order: 'forwards', pageSize: '20' });
    writePageDefault('projectAssets', 'view', 'list');
    writePageDefault('projectAssets', 'sort', 'category');
    writePageDefault('projectAssets', 'order', 'desc');
    writePageDefault('projectAssets', 'pageSize', '100');

    const assetViewer = await request(app).get('/asset-viewer').expect(200);
    expect(assetViewer.headers.location).toBeUndefined();
    expect(assetViewer.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="filename" checked>/);
    expect(assetViewer.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="asc" checked>/);
    expect(assetViewer.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="25" checked>/);
    expect(assetViewer.text).toMatch(/<ul class="asset-grid"/);

    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    writePageDefault('projectAssets', 'view', 'grid');
    writePageDefault('projectAssets', 'sort', 'filename');
    writePageDefault('projectAssets', 'order', 'asc');
    writePageDefault('projectAssets', 'pageSize', '25');

    const projectAssets = await request(app).get(`/projects/${project.id}/assets`).expect(200);
    expect(projectAssets.headers.location).toBeUndefined();
    expect(projectAssets.text).toMatch(/<ul class="asset-grid"/);
  });

  it('lets valid explicit values override saved values while omitted options use saved values', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });

    const explicitSort = await request(app).get('/asset-viewer?sort=size').expect(302);
    expect(explicitSort.headers.location).toBe('/asset-viewer?sort=size&order=desc&pageSize=50&view=list');
    const explicitSortPage = await request(app).get(explicitSort.headers.location).expect(200);
    expect(explicitSortPage.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="size" checked>/);
    expect(explicitSortPage.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(explicitSortPage.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
    expect(explicitSortPage.text).toMatch(/<input[^>]+name="view"[^>]+type="radio"[^>]+value="list" checked>/);

    const explicitControls = await request(app)
      .get('/asset-viewer?sort=size&order=asc&pageSize=10')
      .expect(302);
    expect(explicitControls.headers.location).toBe('/asset-viewer?sort=size&order=asc&pageSize=10&view=list');
    const explicitControlsPage = await request(app).get(explicitControls.headers.location).expect(200);
    expect(explicitControlsPage.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="asc" checked>/);
    expect(explicitControlsPage.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="10" checked>/);

    const explicitView = await request(app).get('/asset-viewer?project=999&view=grid').expect(302);
    expect(explicitView.headers.location).toBe(
      '/asset-viewer?project=999&sort=project&order=desc&pageSize=50&view=grid',
    );
    const explicitViewPage = await request(app).get(explicitView.headers.location).expect(200);
    expect(explicitViewPage.headers.location).toBeUndefined();
    expect(explicitViewPage.text).toMatch(/<input[^>]+name="view"[^>]+type="radio"[^>]+value="grid" checked>/);
    // WP9b: an unavailable Project stays a visible restriction, never All projects.
    expect(explicitViewPage.text).toContain('aria-label="Projects filter: Unavailable project (ID 999)"');
    expect(explicitViewPage.text).toMatch(/<input[^>]+name="project" type="checkbox" value="999" checked data-asset-library-unavailable-project>/);
    expect(explicitViewPage.text).toMatch(/<input id="asset-project-option-select-all" name="project" type="checkbox" value="" data-cc-dropdown-select-all>/);
    expect(explicitViewPage.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
  });

  it('replaces invalid explicit values with fallbacks instead of rescuing them from saved values', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });

    const cases = [
      {
        query: 'view=invalid',
        location: '/asset-viewer?sort=project&order=desc&pageSize=50&view=grid',
      },
      {
        query: 'sort=invalid',
        location: '/asset-viewer?sort=filename&order=desc&pageSize=50&view=list',
      },
      {
        query: 'order=invalid',
        location: '/asset-viewer?sort=project&order=asc&pageSize=50&view=list',
      },
      {
        query: 'pageSize=20',
        location: '/asset-viewer?sort=project&order=desc&pageSize=25&view=list',
      },
    ];

    for (const testCase of cases) {
      const redirect = await request(app).get(`/asset-viewer?${testCase.query}`).expect(302);
      expect(redirect.headers.location).toBe(testCase.location);
      const canonical = await request(app).get(redirect.headers.location).expect(200);
      expect(canonical.headers.location).toBeUndefined();
    }
  });

  it('composes all existing filters with saved presentation defaults', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    const project = createProject('Composed Filters Project');
    createCategory({ displayName: 'Source', directorySlug: 'source' });
    const category = assignCategory(project.id, {
      displayName: 'Source',
      directorySlug: 'source',
    });
    const keep = createAsset(project.id, 'source/keep.PNG', {
      categoryId: category.id,
      filename: 'keep.PNG',
      extension: 'PNG',
    });
    const used = createAsset(project.id, 'source/used.PNG', {
      categoryId: category.id,
      filename: 'used.PNG',
      extension: 'PNG',
    });
    const tag = tagRepository.create({ displayName: 'Saved Default Tag', normalizedName: 'saved-default-secret' });
    tagRepository.assignToAsset(keep.id, tag.id);
    insertReleaseUsage(project.id, used.id);
    markMissing(project.id);
    assetRepository.restorePresent(project.id, ['source/keep.PNG']);

    const redirect = await request(app).get(
      `/asset-viewer?project=${project.id}&category=source&tag=${tag.id}&search=keep&extension=.PNG&presence=present&usage=unused`,
    ).expect(302);
    expect(redirect.headers.location).toBe(
      `/asset-viewer?project=${project.id}&category=source&tag=${tag.id}&search=keep&extension=png&presence=present&usage=unused&sort=project&order=desc&pageSize=50&view=list`,
    );

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('keep.PNG');
    expect(response.text).not.toContain('used.PNG');
    expect(response.text).toMatch(/name="category"[^>]+value="source" checked/);
    expect(response.text).toMatch(new RegExp(`name="tag"[^>]+value="${tag.id}" checked`));
    expect(response.text).toMatch(/<input[^>]+name="presence"[^>]+type="radio"[^>]+value="present" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="usage"[^>]+type="radio"[^>]+value="unused" checked>/);
  });

  it('canonicalizes invalid and unknown query state once while preserving normalized search and extension', async () => {
    const project = createProject('Canonical Project');
    createAsset(project.id, 'A+B.png', { filename: 'A+B.png', extension: 'PNG' });

    const redirect = await request(app)
      .get('/asset-viewer?unknown=discard&tag=123&project=not-a-number&category=Not%20A%20Category&search=%20A%2BB%20&extension=.PNG&presence=invalid&usage=invalid&sort=invalid&order=invalid&page=0&pageSize=20&view=invalid')
      .expect(302);

    expect(redirect.headers.location).toBe('/asset-viewer?search=A%2BB&extension=png');

    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
    expect(canonical.text).toContain('A+B.png');
    expect(canonical.text).not.toContain('discard');
  });

  it('canonicalizes the effective clamped page and preserves presentation context in generated URLs', async () => {
    const project = createProject('Pagination Project');
    for (let index = 1; index <= 11; index++) {
      createAsset(project.id, `asset-${String(index).padStart(2, '0')}.txt`, {
        filename: `asset-${String(index).padStart(2, '0')}.txt`,
        extension: 'txt',
      });
    }

    const redirect = await request(app).get('/asset-viewer?page=99&pageSize=10&view=list').expect(302);
    expect(redirect.headers.location).toBe('/asset-viewer?page=2&pageSize=10&view=list');

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('Page 2 of 2');
    expect(response.text).toContain('href="/asset-viewer?pageSize=10&amp;view=list"');
    expect(response.text).toContain('href="/asset-viewer?page=2&amp;pageSize=10&amp;view=grid"');
  });

  it('canonicalizes clamped pagination together with effective saved defaults in one redirect', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    const project = createProject('Saved Pagination Project');
    for (let index = 1; index <= 51; index++) {
      createAsset(project.id, `saved-${String(index).padStart(2, '0')}.txt`, {
        filename: `saved-${String(index).padStart(2, '0')}.txt`,
        extension: 'txt',
      });
    }

    const redirect = await request(app).get('/asset-viewer?page=99').expect(302);
    expect(redirect.headers.location).toBe(
      '/asset-viewer?sort=project&order=desc&page=2&pageSize=50&view=list',
    );

    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
    expect(canonical.text).toContain('Page 2 of 2');

    const final = await request(app).get(redirect.headers.location).expect(200);
    expect(final.headers.location).toBeUndefined();
  });


  it.each(['grid', 'list'])('WP9a Reset restores fresh defaults, including the saved View, from active %s', async (view) => {
    const project = createProject('Reset defaults');
    createCategory({ displayName: 'Reset artwork', directorySlug: 'reset-artwork' });
    const category = assignCategory(project.id, { displayName: 'Reset artwork', directorySlug: 'reset-artwork' });
    const asset = createAsset(project.id, 'restored.png', { categoryId: category.id });
    createAsset(project.id, 'excluded.jpg');
    const tag = tagRepository.create({ displayName: 'Reset tag', normalizedName: 'reset-tag' });
    tagRepository.assignToAsset(asset.id, tag.id);
    const resetUrl = '/asset-viewer?resetFilters=1&view=' + view;

    // Change saved values after rendering: the link must not snapshot them.
    writeAssetViewerDefaults({ view: view === 'grid' ? 'list' : 'grid', category: 'reset-artwork',
      tag: String(tag.id), extension: 'png', presence: 'present', sort: 'project', order: 'desc', pageSize: '50' });
    const savedView = view === 'grid' ? 'list' : 'grid';
    const expected = '/asset-viewer?category=reset-artwork&tag=' + tag.id
      + '&extension=png&presence=present&sort=project&order=desc&pageSize=50'
      + (savedView === 'list' ? '&view=list' : '');
    for (const suffix of ['', '&project=999&category=all&tag=all&extension=jpg&presence=missing&search=discard&usage=used&sort=size&order=asc&pageSize=10&page=99',
      '&defaults=1&notice=asset_viewer_defaults_saved&dialog=discard&unknown=discard']) {
      const reset = await request(app).get(resetUrl + suffix).expect(302);
      expect(reset.headers['cache-control']).toBe('no-store');
      expect(reset.headers.location).toBe(expected);
      const final = await request(app).get(reset.headers.location).expect(200);
      expect(final.headers.location).toBeUndefined();
      expect(final.text).toContain('restored.png');
      expect(final.text).not.toContain('excluded.jpg');
      expect(final.text).not.toContain('Asset Viewer defaults saved successfully.');
      if (savedView === 'list') {
        // WP9b F2: the page authority (not a native Save snapshot) carries it.
        const authority = JSON.parse(final.text.match(/<script type="application\/json" data-asset-library-defaults-authority>([\s\S]*?)<\/script>/)?.[1] || 'null');
        expect(authority?.current?.view).toBe('list');
        expect(final.text).toContain('asset-list-card');
        expect(final.text).not.toContain('<ul class="asset-grid"');
      } else {
        expect(final.text).toContain('<ul class="asset-grid"');
      }
    }
    const native = await request(app).get(resetUrl).redirects(1).expect(200);
    expect(new URL(native.request.url).pathname + new URL(native.request.url).search).toBe(expected);
    // Back/Forward can revisit either the active state or the stable final URL.
    await request(app).get('/asset-viewer?search=no-match&view=' + view).redirects(1).expect(200);
    await request(app).get(expected).expect(200);
  });

  it.each(['grid', 'list'])('WP3 neutral Reset and ordinary %s navigation remain stable', async (view) => {
    createAsset(createProject('Neutral Reset').id, 'neutral.png');
    const savedView = view === 'grid' ? 'list' : 'grid';
    writeAssetViewerDefaults({ view: savedView, sort: 'filename', order: 'asc', pageSize: '25',
      category: 'all', tag: 'all', extension: 'all', presence: 'all' });
    const reset = await request(app).get('/asset-viewer?resetFilters=1&view=' + view).expect(302);
    // WP9a: the saved View wins over the View the Reset was issued from.
    expect(reset.headers.location).toBe(savedView === 'list' ? '/asset-viewer?view=list' : '/asset-viewer');
    await request(app).get(reset.headers.location).expect(200);
    writeAssetViewerDefaults({ category: 'uncategorized', presence: 'missing' });
    for (const query of ['view=' + view, 'category=all&tag=all&extension=all&presence=all&view=' + view]) {
      const ordinary = await request(app).get('/asset-viewer?' + query).expect(200);
      expect(ordinary.headers.location).toBeUndefined();
      expect(ordinary.text).toContain('neutral.png');
    }
  });

  it.each([
    'resetFilters=&view=grid', 'resetFilters=0&view=grid', 'resetFilters=01&view=grid',
    'resetFilters=1&resetFilters=1&view=grid', 'resetFilters[]=1&view=grid', 'resetFilters[x]=1&view=grid',
    'resetFilters=1&view=', 'resetFilters=1&view=board',
    'resetFilters=1&view=grid&view=grid', 'resetFilters=1&view=grid&view=list',
    'resetFilters=1&view[]=grid', 'resetFilters=1&view[x]=grid',
  ])('WP3 rejects malformed Reset before resolving defaults: %s', async (query) => {
    app.locals.pageDefaultsService.resolve = () => { throw new Error('Defaults must not activate'); };
    const response = await request(app).get('/asset-viewer?' + query).expect(400);
    expect(response.headers.location).toBeUndefined();
  });

  it('resets filter and sort state while preserving the current view', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    const project = createProject('URL Context Project');
    const contextAssets = [];
    for (let index = 1; index <= 51; index++) {
      contextAssets.push(createAsset(project.id, `context-${String(index).padStart(2, '0')}.txt`, {
        filename: `context-${String(index).padStart(2, '0')}.txt`,
        extension: 'txt',
      }));
    }
    const tag = tagRepository.create({ displayName: 'URL Context Tag', normalizedName: 'url-context-secret' });
    for (const asset of contextAssets) tagRepository.assignToAsset(asset.id, tag.id);

    const response = await request(app).get(
      `/asset-viewer?project=${project.id}&tag=${tag.id}&sort=modified&order=desc&page=2&pageSize=50&view=list`,
    ).expect(200);

    expect(response.text).toContain(
      'href="/asset-viewer?project=' + project.id + '&amp;tag=' + tag.id + '&amp;sort=modified&amp;order=desc&amp;page=2&amp;pageSize=50&amp;view=grid"',
    );
    expect(response.text).toContain(
      'href="/asset-viewer?project=' + project.id + '&amp;tag=' + tag.id + '&amp;sort=modified&amp;order=desc&amp;pageSize=50&amp;view=list"',
    );
    expect(response.text).toMatch(new RegExp(
      `<input[^>]+name="project" type="checkbox" value="${project.id}" checked>`,
    ));
    expect(response.text).toContain('aria-label="Projects filter: URL Context Project"');
    expect(response.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="modified" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
  });

  it('does not retain explicit fallback sort, order, or page-size values in reset URLs', async () => {
    const project = createProject('Reset URL Project');
    createAsset(project.id, 'reset-url.png', { filename: 'reset-url.png', extension: 'png' });

    const response = await request(app).get(
      `/asset-viewer?project=${project.id}&category=uncategorized&search=reset&extension=png&presence=present&usage=unused&sort=filename&order=asc&pageSize=25&view=list`,
    ).expect(200);

  });

  it('discards unknown parameters while retaining effective saved presentation values', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });

    const redirect = await request(app).get('/asset-viewer?unknown=discard-me').expect(302);
    expect(redirect.headers.location).toBe('/asset-viewer?sort=project&order=desc&pageSize=50&view=list');
    expect(redirect.headers.location).not.toContain('unknown');

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
  });

  it('distinguishes no active assets from a filtered-empty result', async () => {
    const empty = await request(app).get('/asset-viewer').expect(200);
    expect(empty.text).toContain('No assets across active projects');
    expect(empty.text).not.toContain('No assets match the current filters');

    const project = createProject('Filtered Empty Project');
    createAsset(project.id, 'present.png');

    const filtered = await request(app).get('/asset-viewer?search=does-not-exist').expect(200);
    const reset = filtered.text.match(/<a\b[^>]*data-asset-library-reset[^>]*>Reset<\/a>/)?.[0] || '';
    expect(filtered.text).toContain('No assets match the current filters');
    expect(filtered.text).not.toContain('No assets across active projects');
    expect(reset).toContain('href="/asset-viewer?resetFilters=1"');
  });

  it('leaves the existing project-scoped asset detail route available', async () => {
    const project = createProject('Detail Route Project');
    const asset = createAsset(project.id, 'detail.png');

    const response = await request(app).get(`/projects/${project.id}/assets/${asset.id}`).expect(200);

    expect(response.text).toContain(`Assets — Detail Route Project — ${asset.filename}`);
    expect(response.text).toContain(`href="/projects/${project.id}"`);
  });

  describe('WP8 multi-project and Project Type filtering over HTTP', () => {
    let wp8;

    beforeEach(() => {
      const make = (title, projectType) => projectRepository.create(projectInput(title, { projectType }));
      const alpha = make('WP8 Http Alpha', 'images');
      const beta = make('WP8 Http Beta', 'comic');
      const gamma = make('WP8 Http Gamma', 'animation');
      const archived = make('WP8 Http Archived', 'comic');
      const assets = {};
      for (let index = 1; index <= 6; index += 1) {
        assets[`a${index}`] = createAsset(alpha.id, `a-${String(index).padStart(2, '0')}.png`);
      }
      assets.aJpg = createAsset(alpha.id, 'a-zz.jpg');
      for (let index = 1; index <= 5; index += 1) {
        assets[`b${index}`] = createAsset(beta.id, `b-${String(index).padStart(2, '0')}.png`);
      }
      assets.bCbz = createAsset(beta.id, 'b-zz.cbz');
      assets.g1 = createAsset(gamma.id, 'g-01.png');
      assets.gMp4 = createAsset(gamma.id, 'g-zz.mp4');
      assets.x1 = createAsset(archived.id, 'x-01.png');
      db.prepare(`UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?`)
        .run(archived.id);
      wp8 = { alpha, beta, gamma, archived, assets };
    });

    const renderedAssetIds = (html) => [...html.matchAll(/data-asset-id="(\d+)"/g)].map((match) => Number(match[1]));
    const viewerSequence = (html) => JSON.parse(
      html.match(/<script type="application\/json" data-asset-library-viewer-sequence[^>]*>([\s\S]*?)<\/script>/)[1],
    );
    const ascending = (...values) => [...values].sort((left, right) => left - right);
    const appMetaSnapshot = () => db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();

    it('keeps a single legacy project URL canonical and filtered', async () => {
      const { alpha, assets } = wp8;
      const response = await request(app).get(`/asset-viewer?project=${alpha.id}&pageSize=10`).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.text).toContain('7 assets found');
      expect(renderedAssetIds(response.text)).toEqual([
        assets.a1.id, assets.a2.id, assets.a3.id, assets.a4.id, assets.a5.id, assets.a6.id, assets.aJpg.id,
      ]);
    });

    it('canonicalizes repeated projects once and keeps them through pagination and view links', async () => {
      const { alpha, beta, assets } = wp8;
      const [low, high] = ascending(alpha.id, beta.id);
      const redirect = await request(app)
        .get(`/asset-viewer?project=${high}&project=${low}&project=${high}&project=0&project=x&pageSize=10`)
        .expect(302);
      const canonical = `/asset-viewer?project=${low}&project=${high}&pageSize=10`;
      expect(redirect.headers.location).toBe(canonical);

      const first = await request(app).get(canonical).expect(200);
      expect(first.headers.location).toBeUndefined();
      expect(first.text).toContain('13 assets found');
      expect(first.text).toContain('Page 1 of 2');
      expect(renderedAssetIds(first.text)).toHaveLength(10);
      expect(first.text).toContain(`href="/asset-viewer?project=${low}&amp;project=${high}&amp;page=2&amp;pageSize=10"`);
      expect(first.text).toContain(`/asset-viewer?project=${low}&amp;project=${high}&amp;pageSize=10&amp;view=list`);

      const second = await request(app).get(`/asset-viewer?project=${low}&project=${high}&page=2&pageSize=10`).expect(200);
      expect(second.text).toContain('Page 2 of 2');
      expect(renderedAssetIds(second.text)).toEqual([assets.b4.id, assets.b5.id, assets.bCbz.id]);
      expect(second.text).toContain(`href="/asset-viewer?project=${low}&amp;project=${high}&amp;pageSize=10" rel="prev"`);
      expect([...renderedAssetIds(first.text), ...renderedAssetIds(second.text)].every((id) => (
        ![assets.g1.id, assets.gMp4.id, assets.x1.id].includes(id)
      ))).toBe(true);

      const all = await request(app).get(`/asset-viewer?project=${low}&project=${high}&pageSize=all`).expect(200);
      expect(renderedAssetIds(all.text)).toEqual([...renderedAssetIds(first.text), ...renderedAssetIds(second.text)]);

      // The viewer sequence spans the complete filtered set on every page.
      const sequenceIds = viewerSequence(second.text).map((entry) => entry.id);
      expect(sequenceIds).toEqual(viewerSequence(first.text).map((entry) => entry.id));
      expect(sequenceIds).toHaveLength(12);
      expect(sequenceIds).not.toContain(assets.bCbz.id);
      expect(viewerSequence(first.text).every((entry) => [alpha.id, beta.id].includes(entry.projectId))).toBe(true);
    });

    it('filters by one and several live Project Types', async () => {
      const { assets } = wp8;
      const comic = await request(app).get('/asset-viewer?type=comic').expect(200);
      expect(comic.text).toContain('6 assets found');
      expect(renderedAssetIds(comic.text)).toEqual([
        assets.b1.id, assets.b2.id, assets.b3.id, assets.b4.id, assets.b5.id, assets.bCbz.id,
      ]);

      const redirect = await request(app).get('/asset-viewer?type=comic&type=animation&type=comic').expect(302);
      expect(redirect.headers.location).toBe('/asset-viewer?type=animation&type=comic');
      const several = await request(app).get('/asset-viewer?type=animation&type=comic&pageSize=all').expect(200);
      expect(several.text).toContain('8 assets found');
      expect(renderedAssetIds(several.text)).toEqual([
        assets.b1.id, assets.b2.id, assets.b3.id, assets.b4.id, assets.b5.id, assets.bCbz.id, assets.g1.id, assets.gMp4.id,
      ]);
      expect(several.text).toMatch(/name="extension"[^>]+value="cbz"/);
      expect(several.text).toMatch(/name="extension"[^>]+value="mp4"/);
      expect(several.text).not.toMatch(/name="extension"[^>]+value="jpg"/);
    });

    it('drops unknown Project Types in one canonical redirect', async () => {
      const unknownOnly = await request(app).get('/asset-viewer?type=bogus&type=Images&pageSize=10').expect(302);
      expect(unknownOnly.headers.location).toBe('/asset-viewer?pageSize=10');
      const mixed = await request(app).get('/asset-viewer?type=bogus&type=animation').expect(302);
      expect(mixed.headers.location).toBe('/asset-viewer?type=animation');
      await request(app).get('/asset-viewer?type=animation').expect(200);
    });

    it('ANDs Projects with Project Types and composes with Extension', async () => {
      const { alpha, beta, gamma, assets } = wp8;
      const [p1, p2, p3] = ascending(alpha.id, beta.id, gamma.id);
      const both = await request(app)
        .get(`/asset-viewer?project=${p1}&project=${p2}&project=${p3}&type=animation&type=comic&pageSize=all`)
        .expect(200);
      expect(both.text).toContain('8 assets found');

      const composed = await request(app)
        .get(`/asset-viewer?project=${p1}&project=${p2}&project=${p3}&type=animation&type=comic&extension=png&pageSize=all`)
        .expect(200);
      expect(renderedAssetIds(composed.text)).toEqual([
        assets.b1.id, assets.b2.id, assets.b3.id, assets.b4.id, assets.b5.id, assets.g1.id,
      ]);

      const empty = await request(app).get(`/asset-viewer?project=${alpha.id}&type=comic`).expect(200);
      expect(renderedAssetIds(empty.text)).toEqual([]);
      expect(empty.text).toContain('No assets match the current filters');
      expect(viewerSequence(empty.text)).toEqual([]);
    });

    it('keeps archived and unknown Project IDs restrictive without broadening results', async () => {
      const { alpha, archived, assets } = wp8;
      const ineligible = await request(app).get(`/asset-viewer?project=${archived.id}&project=999999`).expect(200);
      expect(renderedAssetIds(ineligible.text)).toEqual([]);
      expect(ineligible.text).toContain('No assets match the current filters');

      const [low, high] = ascending(alpha.id, archived.id);
      const mixed = await request(app).get(`/asset-viewer?project=${low}&project=${high}&pageSize=all`).expect(200);
      expect(renderedAssetIds(mixed.text)).not.toContain(assets.x1.id);
      expect(renderedAssetIds(mixed.text)).toHaveLength(7);
    });

    it('does not write page defaults for Project or Project Type requests', async () => {
      const { alpha, beta } = wp8;
      const before = appMetaSnapshot();
      const [low, high] = ascending(alpha.id, beta.id);
      await request(app).get(`/asset-viewer?project=${low}&project=${high}&type=comic`).expect(200);
      await request(app).get('/asset-viewer?type=images').expect(200);
      expect(appMetaSnapshot()).toEqual(before);
    });

    it('preserves repeated Project and Type values through Defaults and NSFW return contexts', async () => {
      const { alpha, beta, gamma } = wp8;
      const [low, high] = ascending(alpha.id, beta.id);
      const returnTo = `/asset-viewer?project=${low}&project=${high}&type=animation&type=comic&pageSize=10`;
      const page = await request(app).get(returnTo).expect(200);
      const escapedReturn = returnTo.replace(/&/g, '&amp;');
      expect(page.text).toContain(`name="returnTo" value="${escapedReturn}"`);

      const invalidDefaults = await request(app)
        .post('/asset-viewer/defaults')
        .type('form')
        .send(withDefaultsGeneration({
          returnTo,
          view: 'grid',
          gridStyle: 'uncropped',
          sort: 'not-a-sort',
          order: 'asc',
          pageSize: '25',
          extension: 'all',
          category: 'all',
          presence: 'all',
          tag: 'all',
        }))
        .expect(422);
      expect(invalidDefaults.text).toContain(`name="returnTo" value="${escapedReturn}"`);
      expect(invalidDefaults.text).toContain('6 assets found');
      expect(renderedAssetIds(invalidDefaults.text).length).toBe(6);

      const invalidNsfw = await request(app)
        .post('/asset-viewer/nsfw-filter')
        .type('form')
        .send({ returnTo, enabled: 'maybe' })
        .expect(422);
      expect(invalidNsfw.text).toContain(`name="returnTo" value="${escapedReturn}"`);
      expect(invalidNsfw.text).toContain('6 assets found');

      const nsfw = await request(app)
        .post('/asset-viewer/nsfw-filter')
        .type('form')
        .send({ returnTo, enabled: '1' })
        .expect(302);
      expect(nsfw.headers.location).toBe(returnTo);
      expect(gamma.id).toBeGreaterThan(0);
    });

    it('keeps bare navigation and Reset free of Project and Type filters', async () => {
      const bare = await request(app).get('/asset-viewer').expect(200);
      expect(bare.text).toContain('15 assets found');
      const reset = await request(app).get('/asset-viewer?resetFilters=1&view=grid').expect(302);
      expect(reset.headers.location).toBe('/asset-viewer');
    });
  });

  describe('WP9a Asset Viewer defaults transport', () => {
    const ALL_FALLBACKS = Object.freeze({
      view: 'grid', gridStyle: 'uncropped', sort: 'filename', order: 'asc', pageSize: '25',
      extension: 'all', category: 'all', presence: 'all', tag: 'all',
    });
    const NINE = Object.keys(ALL_FALLBACKS);

    function authorityFrom(html) {
      const json = html.match(/<script type="application\/json" data-asset-library-defaults-authority>([\s\S]*?)<\/script>/)?.[1];
      expect(json).toBeTruthy();
      return JSON.parse(json);
    }

    function appMetaRows() {
      return db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();
    }

    function assetViewerRows() {
      const keys = new Set(NINE.map((field) => PAGE_DEFAULT_DEFINITIONS.assetViewer[field].key));
      return appMetaRows().filter((row) => keys.has(row.key));
    }

    function storedAssetViewer(field) {
      return db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.assetViewer[field].key)?.value;
    }

    function seedLibrary() {
      const alpha = projectRepository.create(projectInput('WP9a Alpha', { projectType: 'images' }));
      const beta = projectRepository.create(projectInput('WP9a Beta', { projectType: 'animation' }));
      createCategory({ displayName: 'WP9a Art', directorySlug: 'wp9a-art' });
      const category = assignCategory(alpha.id, { displayName: 'WP9a Art', directorySlug: 'wp9a-art' });
      const tagged = createAsset(alpha.id, 'tagged.png', { categoryId: category.id });
      createAsset(alpha.id, 'other.jpg');
      createAsset(beta.id, 'beta.png');
      const tag = tagRepository.create({ displayName: 'WP9a Tag', normalizedName: 'wp9a-tag' });
      tagRepository.assignToAsset(tagged.id, tag.id);
      return { alpha, beta, category, tag };
    }

    it('A/B/C: the enhanced Save persists all nine values atomically and never the temporary filters', async () => {
      const { alpha, beta, tag } = seedLibrary();
      const returnTo = `/asset-viewer?project=${alpha.id}&project=${beta.id}&type=animation&type=images&search=tag&usage=unused`;
      const response = await request(app)
        .post('/asset-viewer/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(withDefaultsGeneration(`returnTo=${encodeURIComponent(returnTo)}&view=list&gridStyle=cropped&sort=size&order=desc&pageSize=50`
          + `&extension=png&extension=jpg&category=wp9a-art&presence=present&tag=${tag.id}`
          + `&project=${alpha.id}&type=images&search=tag&usage=unused`))
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.values).toEqual({
        view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '50',
        extension: ['png', 'jpg'], category: ['wp9a-art'], presence: 'present', tag: [String(tag.id)],
      });
      expect(response.body.authority.savedKeys).toEqual(NINE);
      expect(response.body.authority.defaults).toEqual(response.body.values);
      expect(response.body.authority.fallbacks).toEqual(ALL_FALLBACKS);

      expect(assetViewerRows()).toHaveLength(9);
      expect(storedAssetViewer('extension')).toBe('["png","jpg"]');
      expect(storedAssetViewer('tag')).toBe(JSON.stringify([String(tag.id)]));
      // No key for any temporary filter exists anywhere in app_meta.
      expect(appMetaRows().filter((row) => /asset_viewer\.(project|type|search|usage)/.test(row.key))).toEqual([]);
      expect(Object.keys(PAGE_DEFAULT_DEFINITIONS.assetViewer)).toEqual(NINE);
    });

    it('A/N: the native Save redirect keeps repeated Project/Type and other temporary context', async () => {
      const { alpha, beta } = seedLibrary();
      const [low, high] = [alpha.id, beta.id].sort((left, right) => left - right);
      const returnTo = `/asset-viewer?project=${high}&project=${low}&type=images&type=animation&search=tag&usage=unused&page=2`;
      const save = await request(app)
        .post('/asset-viewer/defaults')
        .type('form')
        .send(withDefaultsGeneration({ returnTo, ...ALL_FALLBACKS, view: 'list' }))
        .expect(302);
      expect(save.headers.location).toBe(
        `/asset-viewer?project=${low}&project=${high}&type=animation&type=images&search=tag&usage=unused&view=list`
        + '&notice=asset_viewer_defaults_saved',
      );
      const followed = await request(app).get(save.headers.location).expect(200);
      expect(authorityFrom(followed.text).temporary).toEqual({
        projectIds: [low, high], projectTypes: ['animation', 'images'], search: 'tag', usage: 'unused',
      });
    });

    it('D: an explicitly saved fallback-equal value reports saved from key presence', async () => {
      seedLibrary();
      const before = authorityFrom((await request(app).get('/asset-viewer').expect(200)).text);
      expect(before.savedKeys).toEqual([]);
      expect(before.hasSavedDefaults).toBe(false);
      expect(before.defaults).toEqual(ALL_FALLBACKS);
      expect(before.current).toEqual(ALL_FALLBACKS);

      const saved = await request(app)
        .post('/asset-viewer/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(withDefaultsGeneration({ ...ALL_FALLBACKS }))
        .expect(200);
      expect(saved.body.authority.savedKeys).toEqual(NINE);
      expect(saved.body.authority.saved.view).toEqual({ stored: true, valid: true });
      expect(saved.body.authority.defaults).toEqual(ALL_FALLBACKS);
      expect(saved.body.authority.revision).not.toBe(before.revision);

      const after = authorityFrom((await request(app).get('/asset-viewer').expect(200)).text);
      expect(after.savedKeys).toEqual(NINE);
      expect(after.revision).toBe(saved.body.authority.revision);

      const read = await request(app).get('/asset-viewer/defaults').set('Accept', 'application/json').expect(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.body.authority.savedKeys).toEqual(NINE);
      expect(read.body.authority.revision).toBe(saved.body.authority.revision);
      expect(read.body.authority.current).toBeUndefined();
      expect(assetViewerRows()).toHaveLength(9);

      const typed = await request(app).get('/asset-viewer/defaults').expect(302);
      expect(typed.headers.location).toBe('/asset-viewer?defaults=1');
    });

    it('E: an invalid Save fails as a whole with no partial writes', async () => {
      seedLibrary();
      writeAssetViewerDefaults({ view: 'list' });
      const before = appMetaRows();
      const invalid = await request(app)
        .post('/asset-viewer/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(withDefaultsGeneration({ ...ALL_FALLBACKS, view: 'grid', sort: 'size', tag: '999999' }))
        .expect(422);
      expect(invalid.body.status).toBe('error');
      expect(Object.keys(invalid.body.errors)).toEqual(['tag']);
      expect(appMetaRows()).toEqual(before);
    });

    it('F/G/H/I: Reset filters is GET-only, resolves the stored defaults (including View) and clears temporary filters', async () => {
      const { alpha, beta, tag } = seedLibrary();
      writeAssetViewerDefaults({
        view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '10',
        extension: '["png"]', category: '["wp9a-art"]', presence: 'present', tag: JSON.stringify([String(tag.id)]),
      });
      const before = appMetaRows();
      const reset = await request(app)
        .get(`/asset-viewer?resetFilters=1&view=grid&project=${alpha.id}&project=${beta.id}&type=images&type=animation`
          + '&search=other&usage=used&sort=filename&pageSize=all&page=3&extension=jpg')
        .expect(302);
      expect(reset.headers['cache-control']).toBe('no-store');
      expect(reset.headers.location).toBe(
        `/asset-viewer?category=wp9a-art&tag=${tag.id}&extension=png&presence=present&sort=size&order=desc&pageSize=10&view=list`,
      );
      const installed = await request(app).get(reset.headers.location).expect(200);
      const authority = authorityFrom(installed.text);
      expect(authority.current).toEqual({
        view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '10',
        extension: ['png'], category: ['wp9a-art'], presence: 'present', tag: [String(tag.id)],
      });
      expect(authority.current).toEqual(authority.defaults);
      expect(authority.temporary).toEqual({ projectIds: [], projectTypes: [], search: null, usage: 'all' });
      expect(installed.text).toContain('tagged.png');
      expect(installed.text).not.toContain('beta.png');
      expect(appMetaRows()).toEqual(before);
    });

    it('G: Reset filters restores a saved Grid even from a displayed List page', async () => {
      seedLibrary();
      writeAssetViewerDefaults({ view: 'grid', gridStyle: 'cropped', pageSize: '10' });
      const reset = await request(app).get('/asset-viewer?resetFilters=1&view=list').expect(302);
      expect(reset.headers.location).toBe('/asset-viewer?pageSize=10');
      const installed = await request(app).get(reset.headers.location).expect(200);
      expect(installed.text).toContain('<ul class="asset-grid" data-grid-style="cropped"');
      expect(authorityFrom(installed.text).current.pageSize).toBe('10');
      expect(authorityFrom(installed.text).current.view).toBe('grid');
    });

    it('J/K/L/M/N: Reset defaults deletes only assetViewer keys and refreshes with temporary context', async () => {
      const { alpha, beta } = seedLibrary();
      writeAssetViewerDefaults({ view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '50',
        extension: '["png"]', category: 'all', presence: 'missing', tag: 'all' });
      writePageDefault('projects', 'view', 'list');
      writePageDefault('releases', 'sort', 'title');
      writePageDefault('calendar', 'weekStart', 'sunday');
      writePageDefault('logs', 'pageSize', '100');
      writePageDefault('projectAssets', 'view', 'list');
      app.locals.pageDefaultsService.saveProjectDefault('projectAssets', 'sort', 'size', undefined, { projectId: alpha.id });
      app.locals.nsfwFilterSettingsService.setEnabled(true);
      const assetViewerKeys = new Set(NINE.map((field) => PAGE_DEFAULT_DEFINITIONS.assetViewer[field].key));
      const unrelatedBefore = appMetaRows().filter((row) => !assetViewerKeys.has(row.key));
      const projectRowsBefore = db.prepare('SELECT * FROM project_page_defaults ORDER BY 1, 2, 3').all();
      expect(projectRowsBefore.length).toBeGreaterThan(0);

      const [low, high] = [alpha.id, beta.id].sort((left, right) => left - right);
      const returnTo = `/asset-viewer?project=${high}&project=${low}&type=images&type=animation&search=tag&usage=unused`
        + '&sort=size&order=desc&pageSize=50&view=list&page=2&extension=png';
      const response = await request(app)
        .post('/asset-viewer/defaults/reset')
        .set('Accept', 'application/json')
        .type('form')
        .send(withDefaultsGeneration({ returnTo }))
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.reset).toEqual({
        page: 'assetViewer', scope: 'global', changed: true, deletedOptions: NINE,
      });
      expect(response.body.authority.savedKeys).toEqual([]);
      expect(response.body.authority.defaults).toEqual(ALL_FALLBACKS);
      expect(response.body.authority.fallbacks).toEqual(ALL_FALLBACKS);
      expect(response.body.refreshUrl).toBe(
        `/asset-viewer?project=${low}&project=${high}&type=animation&type=images&search=tag&usage=unused`,
      );
      expect(assetViewerRows()).toEqual([]);
      // WP9a F6: the only other app_meta change is the Asset Viewer mutation
      // generation, which Reset advances and never deletes.
      const generationKey = 'page_defaults_generation.asset_viewer';
      expect(appMetaRows().filter((row) => row.key !== generationKey)).toEqual(unrelatedBefore);
      expect(appMetaRows().find((row) => row.key === generationKey)).toEqual({ key: generationKey, value: '1' });
      expect(response.body.authority.generation).toBe(1);
      expect(db.prepare('SELECT * FROM project_page_defaults ORDER BY 1, 2, 3').all()).toEqual(projectRowsBefore);
      expect(app.locals.nsfwFilterSettingsService.isEnabled()).toBe(true);

      const refreshed = await request(app).get(response.body.refreshUrl).expect(200);
      const authority = authorityFrom(refreshed.text);
      expect(authority.current).toEqual(ALL_FALLBACKS);
      expect(authority.temporary).toEqual({
        projectIds: [low, high], projectTypes: ['animation', 'images'], search: 'tag', usage: 'unused',
      });

      // A repeat is harmless: nothing is left to delete.
      const repeat = await request(app)
        .post('/asset-viewer/defaults/reset')
        .set('Accept', 'application/json')
        .type('form')
        .send(withDefaultsGeneration({ returnTo }))
        .expect(200);
      expect(repeat.body.reset.changed).toBe(false);

      const native = await request(app)
        .post('/asset-viewer/defaults/reset')
        .type('form')
        .send(withDefaultsGeneration({ returnTo }))
        .expect(302);
      expect(native.headers.location).toBe(response.body.refreshUrl);
    });

    it('reports a committed Reset defaults whose follow-up read failed without claiming no change', async () => {
      seedLibrary();
      writeAssetViewerDefaults({ view: 'list' });
      app.locals.pageDefaultsService.describeSavedDefaults = () => { throw new Error('read failed'); };
      const response = await request(app)
        .post('/asset-viewer/defaults/reset')
        .set('Accept', 'application/json')
        .type('form')
        .send(withDefaultsGeneration({ returnTo: '/asset-viewer?search=kept' }))
        .expect(500);
      expect(response.body).toMatchObject({ status: 'error', committed: true, refreshUrl: '/asset-viewer?search=kept' });
      expect(assetViewerRows()).toEqual([]);
    });

    it('O: CSRF rejection performs no Save or Reset defaults mutation', async () => {
      seedLibrary();
      const csrfAppDataRoot = path.join(tmpDir, 'csrf-wp9a');
      fs.mkdirSync(csrfAppDataRoot, { recursive: true });
      const { csrfPepper } = ensureAuthEnablement(csrfAppDataRoot);
      const csrfApp = createApp(
        { appName: 'CreatorCrate', db, projectsRoot },
        { appDataRoot: csrfAppDataRoot, authState: { csrfPepper } },
      );
      const agent = request.agent(csrfApp);
      const rendered = await agent.get('/asset-viewer').expect(200);
      const token = extractCsrfToken(
        rendered.text.match(/<form id="asset-viewer-defaults-form"[\s\S]*?<\/form>/)?.[0] || '',
      );
      expect(token).not.toBe('');
      writeAssetViewerDefaults({ view: 'list' });
      const before = appMetaRows();

      await agent.post('/asset-viewer/defaults').set('Accept', 'application/json').type('form')
        .send(withDefaultsGeneration({ ...ALL_FALLBACKS, sort: 'size' })).expect(403);
      await agent.post('/asset-viewer/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withDefaultsGeneration({ returnTo: '/asset-viewer' })).expect(403);
      await agent.post('/asset-viewer/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withDefaultsGeneration({ _csrf: 'forged', returnTo: '/asset-viewer' })).expect(403);
      expect(appMetaRows()).toEqual(before);

      const accepted = await agent.post('/asset-viewer/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withDefaultsGeneration({ _csrf: token, returnTo: '/asset-viewer' })).expect(200);
      expect(accepted.body.reset.deletedOptions).toEqual(['view']);
      expect(assetViewerRows()).toEqual([]);
    });

    describe('WP9a F6 — server-enforced defaults mutation generation', () => {
      const GENERATION_KEY = 'page_defaults_generation.asset_viewer';

      function storedGeneration() {
        return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(GENERATION_KEY)?.value;
      }

      function nineFor(tag) {
        return {
          view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '50',
          extension: ['png'], category: ['wp9a-art'], presence: 'present', tag: [String(tag.id)],
        };
      }

      // A request body as a controller builds it, captured when the request
      // was SENT. Delivering it later reproduces a request held upstream
      // (before the mutation handler) until the newer request has committed.
      function saveBody(values, generation, operation, returnTo = '/asset-viewer') {
        const body = new URLSearchParams();
        body.append('returnTo', returnTo);
        Object.entries(values).forEach(([field, value]) => {
          (Array.isArray(value) ? value : [value]).forEach((entry) => body.append(field, entry));
        });
        if (generation !== undefined) body.append('defaultsGeneration', String(generation));
        if (operation !== undefined) body.append('defaultsOperation', operation);
        return body.toString();
      }

      function resetBody(generation, operation, returnTo = '/asset-viewer') {
        const body = new URLSearchParams({ returnTo });
        if (generation !== undefined) body.append('defaultsGeneration', String(generation));
        if (operation !== undefined) body.append('defaultsOperation', operation);
        return body.toString();
      }

      function deliverSave(body, target = app) {
        return request(target).post('/asset-viewer/defaults').set('Accept', 'application/json').type('form').send(body);
      }

      function deliverReset(body, target = app) {
        return request(target).post('/asset-viewer/defaults/reset').set('Accept', 'application/json').type('form').send(body);
      }

      async function renderedAuthority() {
        return authorityFrom((await request(app).get('/asset-viewer').redirects(2).expect(200)).text);
      }

      async function readAuthority() {
        return (await request(app).get('/asset-viewer/defaults').set('Accept', 'application/json').expect(200)).body.authority;
      }

      it('exposes one durable integer generation in rendered, read and acknowledged authority', async () => {
        const { tag } = seedLibrary();
        const rendered = await renderedAuthority();
        expect(rendered.generation).toBe(0);
        expect((await readAuthority()).generation).toBe(0);
        expect(storedGeneration()).toBeUndefined();

        const saved = await deliverSave(saveBody(nineFor(tag), 0, 'op-save-1')).expect(200);
        expect(saved.body.operation).toEqual({
          id: 'op-save-1', kind: 'save', result: 'committed', committed: true, expectedGeneration: 0, generation: 1,
        });
        expect(saved.body.authority.generation).toBe(1);
        expect(storedGeneration()).toBe('1');
        expect((await renderedAuthority()).generation).toBe(1);
        expect((await readAuthority()).generation).toBe(1);
        // The generation is protocol metadata, never one of the saved keys.
        expect(saved.body.authority.savedKeys).toEqual(NINE);
        expect(assetViewerRows()).toHaveLength(9);
      });

      it('Reproduction A: an unresolved Save delivered after a reload-and-Reset is rejected as stale', async () => {
        const { tag } = seedLibrary();
        writeAssetViewerDefaults({ view: 'list', sort: 'size' });
        // Controller A renders generation G and sends Save; the request is
        // held upstream and its controller never learns the outcome.
        const generation = (await renderedAuthority()).generation;
        const heldSave = saveBody(nineFor(tag), generation, 'op-a-save');

        // Reload: controller B reads the current authority and resets.
        const reloaded = await renderedAuthority();
        expect(reloaded.generation).toBe(generation);
        const reset = await deliverReset(resetBody(reloaded.generation, 'op-b-reset')).expect(200);
        expect(reset.body.operation).toEqual({
          id: 'op-b-reset', kind: 'resetDefaults', result: 'committed', committed: true,
          expectedGeneration: generation, generation: generation + 1,
        });
        expect(reset.body.authority.generation).toBe(generation + 1);
        expect(reset.body.authority.savedKeys).toEqual([]);
        expect(assetViewerRows()).toEqual([]);

        // The old Save finally reaches the handler.
        const late = await deliverSave(heldSave).expect(409);
        expect(late.body).toMatchObject({ status: 'error', code: 'DEFAULTS_GENERATION_CONFLICT' });
        expect(late.body.operation).toEqual({
          id: 'op-a-save', kind: 'save', result: 'conflict', committed: false,
          expectedGeneration: generation, generation: generation + 1,
        });
        expect(late.body.authority.generation).toBe(generation + 1);
        expect(late.body.authority.savedKeys).toEqual([]);

        // Zero saved keys remain and the old List View is not restored.
        expect(assetViewerRows()).toEqual([]);
        expect(storedGeneration()).toBe(String(generation + 1));
        const after = await renderedAuthority();
        expect(after.savedKeys).toEqual([]);
        expect(after.current.view).toBe('grid');
        expect(after.generation).toBe(generation + 1);
      });

      it('Reproduction B: an unresolved Reset delivered after a reload-and-Save is rejected as stale', async () => {
        const { tag } = seedLibrary();
        const generation = (await renderedAuthority()).generation;
        const heldReset = resetBody(generation, 'op-a-reset');

        const reloaded = await renderedAuthority();
        const save = await deliverSave(saveBody(nineFor(tag), reloaded.generation, 'op-b-save')).expect(200);
        expect(save.body.operation).toMatchObject({
          id: 'op-b-save', result: 'committed', committed: true, generation: generation + 1,
        });
        expect(assetViewerRows()).toHaveLength(9);

        const late = await deliverReset(heldReset).expect(409);
        expect(late.body.operation).toEqual({
          id: 'op-a-reset', kind: 'resetDefaults', result: 'conflict', committed: false,
          expectedGeneration: generation, generation: generation + 1,
        });
        expect(late.body.reset).toBeUndefined();

        // The nine saved values remain and agree with the Save acknowledgement.
        expect(assetViewerRows()).toHaveLength(9);
        const after = await readAuthority();
        expect(after.savedKeys).toEqual(NINE);
        expect(after.defaults).toEqual(save.body.values);
        expect(after.generation).toBe(generation + 1);
      });

      it('reverse arrival: the older request commits first and the newer one gets an explicit conflict', async () => {
        const { tag } = seedLibrary();
        writeAssetViewerDefaults({ view: 'list' });
        const generation = (await readAuthority()).generation;

        // Save A (older) and Reset B (newer) were both based on G; A arrives first.
        const saveA = await deliverSave(saveBody(nineFor(tag), generation, 'op-a')).expect(200);
        expect(saveA.body.operation.generation).toBe(generation + 1);
        const rowsAfterA = assetViewerRows();
        const resetB = await deliverReset(resetBody(generation, 'op-b')).expect(409);
        expect(resetB.body.operation).toMatchObject({ id: 'op-b', result: 'conflict', committed: false });
        expect(resetB.body.status).toBe('error');
        expect(resetB.body.message).toMatch(/changed/i);
        // No partial deletion, and the current authority is returned.
        expect(assetViewerRows()).toEqual(rowsAfterA);
        expect(resetB.body.authority.savedKeys).toEqual(NINE);
        expect(resetB.body.authority.generation).toBe(generation + 1);

        // The other direction: Reset A first, Save B second.
        const current = (await readAuthority()).generation;
        await deliverReset(resetBody(current, 'op-c')).expect(200);
        const saveD = await deliverSave(saveBody(nineFor(tag), current, 'op-d')).expect(409);
        expect(saveD.body.operation).toMatchObject({ id: 'op-d', kind: 'save', result: 'conflict', committed: false });
        expect(assetViewerRows()).toEqual([]);
        // Current authority stays retrievable with GET only.
        const recovered = await readAuthority();
        expect(recovered.generation).toBe(current + 1);
        expect(recovered.savedKeys).toEqual([]);
      });

      it('a no-op Reset still advances the generation, fencing a delayed older Save, and creates no keys', async () => {
        const { tag } = seedLibrary();
        expect(assetViewerRows()).toEqual([]);
        const generation = (await readAuthority()).generation;
        const heldSave = saveBody(nineFor(tag), generation, 'op-old-save');

        const reset = await deliverReset(resetBody(generation, 'op-noop')).expect(200);
        expect(reset.body.reset.changed).toBe(false);
        expect(reset.body.operation).toMatchObject({ result: 'committed', generation: generation + 1 });
        expect(storedGeneration()).toBe(String(generation + 1));
        expect(assetViewerRows()).toEqual([]);

        await deliverSave(heldSave).expect(409);
        expect(assetViewerRows()).toEqual([]);
      });

      it('two concurrent requests with the same expected generation cannot both commit', async () => {
        const { tag } = seedLibrary();
        writeAssetViewerDefaults({ view: 'list' });
        const generation = (await readAuthority()).generation;
        const [save, reset] = await Promise.all([
          deliverSave(saveBody(nineFor(tag), generation, 'op-concurrent-save')),
          deliverReset(resetBody(generation, 'op-concurrent-reset')),
        ]);
        const statuses = [save.status, reset.status].sort();
        expect(statuses).toEqual([200, 409]);
        expect(storedGeneration()).toBe(String(generation + 1));
        if (save.status === 200) {
          expect(assetViewerRows()).toHaveLength(9);
          expect(reset.body.operation.result).toBe('conflict');
        } else {
          expect(assetViewerRows()).toEqual([]);
          expect(save.body.operation.result).toBe('conflict');
        }

        // Two Saves on the same generation: exactly one commits.
        const next = (await readAuthority()).generation;
        const saves = await Promise.all([
          deliverSave(saveBody({ ...nineFor(tag), view: 'grid' }, next, 'op-s1')),
          deliverSave(saveBody({ ...nineFor(tag), view: 'list' }, next, 'op-s2')),
        ]);
        expect(saves.map((response) => response.status).sort()).toEqual([200, 409]);
        const winner = saves.find((response) => response.status === 200);
        expect(storedAssetViewer('view')).toBe(winner.body.values.view);
        expect(storedGeneration()).toBe(String(next + 1));
      });

      it('a rolled-back mutation leaves neither its writes nor an advanced generation', async () => {
        const { tag } = seedLibrary();
        writeAssetViewerDefaults({ view: 'list' });
        const generation = (await readAuthority()).generation;
        const before = appMetaRows();
        const service = app.locals.pageDefaultsService;
        const originalSave = service.saveDefault;
        let calls = 0;
        service.saveDefault = (...args) => {
          calls += 1;
          if (calls === 5) throw new Error('disk full');
          return originalSave(...args);
        };
        const failedSave = await deliverSave(saveBody(nineFor(tag), generation, 'op-rollback')).expect(500);
        service.saveDefault = originalSave;
        expect(failedSave.body.operation).toMatchObject({ id: 'op-rollback', result: 'failed', committed: false });
        expect(appMetaRows()).toEqual(before);

        const originalReset = service.resetGlobalPageDefaults;
        service.resetGlobalPageDefaults = () => { throw new Error('locked'); };
        const failedReset = await deliverReset(resetBody(generation, 'op-reset-rollback')).expect(500);
        service.resetGlobalPageDefaults = originalReset;
        expect(failedReset.body.operation).toMatchObject({ id: 'op-reset-rollback', result: 'failed', committed: false });
        expect(appMetaRows()).toEqual(before);

        // The generation did not move, so the same request may now commit.
        await deliverSave(saveBody(nineFor(tag), generation, 'op-retry')).expect(200);
        expect(storedGeneration()).toBe(String(generation + 1));
      });

      it('rejects a mutation without a usable generation as a conflict, with no write', async () => {
        const { tag } = seedLibrary();
        writeAssetViewerDefaults({ view: 'list' });
        const before = appMetaRows();
        for (const generation of [undefined, '', 'abc', '-1', '1.5']) {
          const body = new URLSearchParams(saveBody(nineFor(tag), undefined, 'op-missing'));
          if (generation !== undefined) body.append('defaultsGeneration', generation);
          const save = await deliverSave(body.toString()).expect(409);
          expect(save.body.operation).toMatchObject({ id: 'op-missing', result: 'conflict', expectedGeneration: null });
          const reset = await deliverReset(resetBody(generation, 'op-missing-reset')).expect(409);
          expect(reset.body.operation).toMatchObject({ result: 'conflict', committed: false });
        }
        // A native (non-JSON) stale Save re-renders with a conflict, never a redirect.
        const native = await request(app).post('/asset-viewer/defaults').type('form')
          .send(saveBody(nineFor(tag), 7, undefined)).expect(409);
        expect(native.text).toContain('changed since this page was loaded');
        const nativeReset = await request(app).post('/asset-viewer/defaults/reset').type('form')
          .send(resetBody(7)).expect(409);
        expect(nativeReset.text).toContain('changed since this page was loaded');
        expect(appMetaRows()).toEqual(before);
      });

      it('echoes only a well-formed operation identity and correlates 422 validation answers', async () => {
        seedLibrary();
        const generation = (await readAuthority()).generation;
        const invalid = await deliverSave(saveBody({ ...ALL_FALLBACKS, tag: '999999' }, generation, 'op-invalid'))
          .expect(422);
        expect(invalid.body.operation).toMatchObject({
          id: 'op-invalid', kind: 'save', result: 'invalid', committed: false, expectedGeneration: generation,
        });
        expect(storedGeneration()).toBeUndefined();
        const malformed = await deliverSave(saveBody(ALL_FALLBACKS, generation, '<script>')).expect(200);
        expect(malformed.body.operation.id).toBeNull();
        expect(malformed.body.operation.committed).toBe(true);
      });

      it('native (no-JavaScript) defaults form carries the rendered generation and advances it', async () => {
        seedLibrary();
        const page = await request(app).get('/asset-viewer').expect(200);
        const form = page.text.match(/<form id="asset-viewer-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';
        // WP9b: the combined dialog is explicit-save and (F2/F3) JavaScript-
        // only: no native generation or snapshot is rendered in any form. The
        // fenced form-encoded route stays; the page authority carries the
        // generation it was prepared from.
        const renderedGeneration = (text) => JSON.parse(
          text.match(/<script type="application\/json" data-asset-library-defaults-authority>([\s\S]*?)<\/script>/)?.[1] || 'null',
        )?.generation;
        expect(form).toContain('data-defaults-explicit-save');
        expect(form).not.toContain('data-asset-viewer-defaults-autosave');
        expect(form).not.toContain('name="defaultsGeneration"');
        expect(renderedGeneration(page.text)).toBe(0);
        const save = await request(app).post('/asset-viewer/defaults').type('form')
          .send(saveBody({ ...ALL_FALLBACKS, view: 'list' }, 0)).expect(302);
        expect(save.headers.location).toContain('notice=asset_viewer_defaults_saved');
        expect(storedGeneration()).toBe('1');
        const rerendered = await request(app).get(save.headers.location).expect(200);
        expect(renderedGeneration(rerendered.text)).toBe(1);
        // A second autosave from the same page must use the advanced generation.
        await request(app).post('/asset-viewer/defaults').type('form')
          .send(saveBody({ ...ALL_FALLBACKS, view: 'grid' }, 0)).expect(409);
        await request(app).post('/asset-viewer/defaults').type('form')
          .send(saveBody({ ...ALL_FALLBACKS, view: 'grid' }, 1)).expect(302);
        expect(storedAssetViewer('view')).toBe('grid');
      });

      it('Reset deletes only the nine keys and keeps the generation; it persists across a restart', async () => {
        const { tag } = seedLibrary();
        await deliverSave(saveBody(nineFor(tag), 0, 'op-1')).expect(200);
        await deliverReset(resetBody(1, 'op-2')).expect(200);
        expect(assetViewerRows()).toEqual([]);
        expect(storedGeneration()).toBe('2');

        closeDatabase(db);
        db = openDatabase(path.join(tmpDir, 'test.db'));
        app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
        expect((await readAuthority()).generation).toBe(2);
        await deliverSave(saveBody(nineFor(tag), 1, 'op-stale-after-restart')).expect(409);
        await deliverSave(saveBody(nineFor(tag), 2, 'op-current-after-restart')).expect(200);
        expect(storedGeneration()).toBe('3');
      });

      describe('WP9a F8 — multi-digit generations', () => {
        // Ten authorized no-op Reset defaults requests, each based on the
        // generation the previous acknowledgement established: 0 → 10.
        async function advanceByNoopResets(count) {
          let generation = (await readAuthority()).generation;
          for (let step = 0; step < count; step += 1) {
            const reset = await deliverReset(resetBody(generation, `op-noop-${generation}`)).expect(200);
            expect(reset.body.reset.changed).toBe(false);
            expect(reset.body.operation).toEqual({
              id: `op-noop-${generation}`, kind: 'resetDefaults', result: 'committed', committed: true,
              expectedGeneration: generation, generation: generation + 1,
            });
            expect(reset.body.authority.generation).toBe(generation + 1);
            expect(storedGeneration()).toBe(String(generation + 1));
            expect(assetViewerRows()).toEqual([]);
            generation = reset.body.operation.generation;
          }
          return generation;
        }

        it('A–D: no-op Resets reach 10, Save at 10, Reset at 11, and 12 survives a reopen', async () => {
          const { tag } = seedLibrary();
          expect((await readAuthority()).generation).toBe(0);
          expect(storedGeneration()).toBeUndefined();

          // A: 0 → 10 through single-digit expected generations.
          expect(await advanceByNoopResets(10)).toBe(10);
          expect(storedGeneration()).toBe('10');
          expect(assetViewerRows()).toEqual([]);
          const authority10 = await readAuthority();
          expect(authority10.generation).toBe(10);
          expect(authority10.savedKeys).toEqual([]);
          expect((await renderedAuthority()).generation).toBe(10);

          // B: Save based on generation 10.
          const save = await deliverSave(saveBody(nineFor(tag), 10, 'op-save-10')).expect(200);
          expect(save.body.operation).toEqual({
            id: 'op-save-10', kind: 'save', result: 'committed', committed: true, expectedGeneration: 10, generation: 11,
          });
          expect(save.body.authority.generation).toBe(11);
          expect(save.body.authority.savedKeys).toEqual(NINE);
          expect(assetViewerRows()).toHaveLength(9);
          expect(storedAssetViewer('view')).toBe('list');
          expect(storedAssetViewer('gridStyle')).toBe('cropped');
          expect(storedAssetViewer('sort')).toBe('size');
          expect(storedAssetViewer('order')).toBe('desc');
          expect(storedAssetViewer('pageSize')).toBe('50');
          expect(storedAssetViewer('presence')).toBe('present');
          expect(storedAssetViewer('extension')).toContain('png');
          expect(storedAssetViewer('category')).toContain('wp9a-art');
          expect(storedAssetViewer('tag')).toContain(String(tag.id));
          expect(storedGeneration()).toBe('11');

          // C: Reset based on generation 11 deletes all nine keys.
          const reset = await deliverReset(resetBody(11, 'op-reset-11')).expect(200);
          expect(reset.body.operation).toEqual({
            id: 'op-reset-11', kind: 'resetDefaults', result: 'committed', committed: true,
            expectedGeneration: 11, generation: 12,
          });
          expect([...reset.body.reset.deletedOptions].sort()).toEqual([...NINE].sort());
          expect(reset.body.authority.savedKeys).toEqual([]);
          expect(assetViewerRows()).toEqual([]);
          expect(storedGeneration()).toBe('12');

          // D: reopen the database; 12 is authoritative and accepted.
          closeDatabase(db);
          db = openDatabase(path.join(tmpDir, 'test.db'));
          app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
          expect(storedGeneration()).toBe('12');
          expect((await readAuthority()).generation).toBe(12);
          expect((await renderedAuthority()).generation).toBe(12);
          const afterReopen = await deliverSave(saveBody(nineFor(tag), 12, 'op-save-12')).expect(200);
          expect(afterReopen.body.operation).toMatchObject({
            result: 'committed', committed: true, expectedGeneration: 12, generation: 13,
          });
          expect(assetViewerRows()).toHaveLength(9);
          expect(storedGeneration()).toBe('13');
        });

        it('E: rejects malformed or missing generations without writing, deleting or advancing', async () => {
          const { tag } = seedLibrary();
          expect(await advanceByNoopResets(10)).toBe(10);
          writeAssetViewerDefaults({ view: 'list', sort: 'size' });
          const before = appMetaRows();
          for (const generation of [undefined, '', '01', '010', '1d', '10d', '-1', '-10', '1.0', '10.0', '1e2', '1e1',
            '10x', '10,11', ' 10', '10 ', '+10', '0x0a']) {
            const label = JSON.stringify(generation);
            const save = await deliverSave(saveBody(nineFor(tag), generation, 'op-bad-save'));
            expect(save.status, label).toBe(409);
            expect(save.body.operation, label).toMatchObject({
              id: 'op-bad-save', kind: 'save', result: 'conflict', committed: false, expectedGeneration: null, generation: 10,
            });
            const reset = await deliverReset(resetBody(generation, 'op-bad-reset'));
            expect(reset.status, label).toBe(409);
            expect(reset.body.operation, label).toMatchObject({
              id: 'op-bad-reset', kind: 'resetDefaults', result: 'conflict', committed: false,
              expectedGeneration: null, generation: 10,
            });
            expect(appMetaRows(), label).toEqual(before);
          }
          // Repeated fields are not one generation.
          const repeated = new URLSearchParams(resetBody(10, 'op-repeated'));
          repeated.append('defaultsGeneration', '10');
          await deliverReset(repeated.toString()).expect(409);
          expect(appMetaRows()).toEqual(before);
          expect(storedGeneration()).toBe('10');
        });

        it('F: an older valid generation is still stale once the generation is above 10', async () => {
          const { tag } = seedLibrary();
          expect(await advanceByNoopResets(12)).toBe(12);
          writeAssetViewerDefaults({ view: 'list' });
          const before = appMetaRows();
          for (const stale of [11, 10, 9, 1, 0]) {
            const save = await deliverSave(saveBody(nineFor(tag), stale, `op-stale-save-${stale}`)).expect(409);
            expect(save.body).toMatchObject({ status: 'error', code: 'DEFAULTS_GENERATION_CONFLICT' });
            expect(save.body.operation).toEqual({
              id: `op-stale-save-${stale}`, kind: 'save', result: 'conflict', committed: false,
              expectedGeneration: stale, generation: 12,
            });
            const reset = await deliverReset(resetBody(stale, `op-stale-reset-${stale}`)).expect(409);
            expect(reset.body.operation).toEqual({
              id: `op-stale-reset-${stale}`, kind: 'resetDefaults', result: 'conflict', committed: false,
              expectedGeneration: stale, generation: 12,
            });
            expect(appMetaRows()).toEqual(before);
          }
          // A future generation is not current either.
          await deliverSave(saveBody(nineFor(tag), 13, 'op-future')).expect(409);
          expect(appMetaRows()).toEqual(before);
          expect(storedGeneration()).toBe('12');
        });

        it('G: legacy native/autosave and explicit JSON transports both use a multi-digit generation', async () => {
          const { tag } = seedLibrary();
          expect(await advanceByNoopResets(10)).toBe(10);

          // Legacy: the rendered page authority carries 10 (WP9b F2/F3: no
          // form renders a generation); a form-encoded Save is accepted.
          const page = await request(app).get('/asset-viewer').expect(200);
          const form = page.text.match(/<form id="asset-viewer-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';
          const renderedGeneration = (text) => JSON.parse(
            text.match(/<script type="application\/json" data-asset-library-defaults-authority>([\s\S]*?)<\/script>/)?.[1] || 'null',
          )?.generation;
          expect(form).toContain('data-defaults-explicit-save');
          expect(form).not.toContain('data-asset-viewer-defaults-autosave');
          expect(form).not.toContain('name="defaultsGeneration"');
          expect(renderedGeneration(page.text)).toBe(10);
          const legacy = await request(app).post('/asset-viewer/defaults').type('form')
            .send(saveBody({ ...ALL_FALLBACKS, view: 'list' }, 10)).expect(302);
          expect(legacy.headers.location).toContain('notice=asset_viewer_defaults_saved');
          expect(storedAssetViewer('view')).toBe('list');
          expect(storedGeneration()).toBe('11');
          const rerendered = await request(app).get(legacy.headers.location).expect(200);
          expect(renderedGeneration(rerendered.text)).toBe(11);
          // The next legacy autosave from the same page sends 11, not the stale 10.
          await request(app).post('/asset-viewer/defaults').type('form')
            .send(saveBody({ ...ALL_FALLBACKS, view: 'grid' }, 10)).expect(409);
          await request(app).post('/asset-viewer/defaults').type('form')
            .send(saveBody({ ...ALL_FALLBACKS, view: 'grid' }, 11)).expect(302);
          expect(storedAssetViewer('view')).toBe('grid');
          expect(storedGeneration()).toBe('12');

          // Explicit: correlated JSON acknowledgements at 12 and 13.
          const save = await deliverSave(saveBody(nineFor(tag), 12, 'op-explicit-save')).expect(200);
          expect(save.body.operation).toEqual({
            id: 'op-explicit-save', kind: 'save', result: 'committed', committed: true,
            expectedGeneration: 12, generation: 13,
          });
          const reset = await deliverReset(resetBody(13, 'op-explicit-reset')).expect(200);
          expect(reset.body.operation).toEqual({
            id: 'op-explicit-reset', kind: 'resetDefaults', result: 'committed', committed: true,
            expectedGeneration: 13, generation: 14,
          });
          expect(assetViewerRows()).toEqual([]);
          expect(storedGeneration()).toBe('14');
        });
      });
    });
  });
});
