import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title, overrides = {}) {
  return {
    title,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: '',
    notes: '',
    status: 'tbd',
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-library-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const directory of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, directory), { recursive: true });
    }

    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
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

  function writeAssetViewerDefaults(values) {
    for (const [option, value] of Object.entries(values)) {
      writePageDefault('assetViewer', option, value);
    }
  }

  function insertReleaseUsage(projectId, assetId) {
    const release = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, status,
                            planned_date, published_date, patreon_url, archived_at)
      VALUES (?, ?, '', '', 'planned', NULL, NULL, NULL, NULL)
      RETURNING id
    `).get(projectId, 'Used Asset Release');
    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'attachment', 0)
    `).run(release.id, assetId);
  }

  it('renders active-project assets, complete options, safe previews, and no mutation actions', async () => {
    createCategory({ displayName: 'Alternate References', directorySlug: 'alternate-references', displayOrder: 1 });
    createCategory({ displayName: 'Hidden', directorySlug: 'hidden', displayOrder: 2, enabled: false });

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

    const response = await request(app).get('/assets').expect(200);

    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('<title>CreatorCrate — Asset Viewer</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Asset Viewer</h1>');
    expect(response.text).toContain(
      '<a href="/assets" class="app-nav-link" data-nav-key="assets" aria-current="page">',
    );
    expect(response.text).toContain(
      '<a href="/assets" class="mobile-nav-link" data-nav-key="assets" aria-current="page">',
    );
    expect(response.text).toContain('Alpha Project');
    expect(response.text).toContain('Beta Project');
    expect(response.text).not.toContain('Archived Project');
    expect(response.text).not.toContain('hidden.png');
    expect(response.text).toContain(`href="/projects/${alpha.id}/assets/${alphaAsset.id}"`);
    expect(response.text).toContain(`href="/projects/${beta.id}/assets/${betaAsset.id}"`);
    expect(response.text).toContain(`href="/projects/${alpha.id}"`);
    expect(response.text).toContain(`src="/projects/${alpha.id}/assets/${alphaAsset.id}/preview?v=`);
    expect(response.text).not.toContain(`/projects/${beta.id}/assets/${unsupported.id}/preview`);
    expect(response.text).not.toContain(`/projects/${beta.id}/assets/${missing.id}/preview`);

    expect(response.text).toMatch(/<option value="\d+">Alpha Project<\/option>/);
    expect(response.text).toMatch(/<option value="\d+">Beta Project<\/option>/);
    expect(response.text).toContain('<option value="source">Source</option>');
    expect(response.text).toContain('<option value="alternate-references">Alternate References</option>');
    expect(response.text).not.toContain('value="hidden"');
    expect(response.text).toContain('<option value="bin">.bin</option>');
    expect(response.text).toContain('<option value="png">.png</option>');
    expect(response.text).toContain('<option value="asc" selected>Ascending</option>');
    expect(response.text).toContain('<option value="10">10</option>');
    expect(response.text).toContain('<option value="25" selected>25</option>');
    expect(response.text).toContain('<option value="50">50</option>');
    expect(response.text).toContain('<option value="100">100</option>');
    expect(response.text).not.toMatch(/<form[^>]+method="post"/i);
    expect(response.text).not.toMatch(/Scan Now|Rename|Move file|Add selected|Set as primary|selectedAssetIds/i);

    await request(app).post('/assets').expect(404);
  });

  it('maps every supported filter to the read-only page query and renders list view', async () => {
    const alpha = createProject('Filtered Alpha');
    const beta = createProject('Filtered Beta');
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

    const query = `/assets?project=${alpha.id}&category=source&search=shared&extension=.PNG&presence=present&usage=unused&sort=project&order=desc&page=1&pageSize=50&view=list`;
    const redirect = await request(app).get(query).expect(302);
    expect(redirect.headers.location).toBe(
      `/assets?project=${alpha.id}&category=source&search=shared&extension=png&presence=present&usage=unused&sort=project&order=desc&pageSize=50&view=list`,
    );

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('<table class="data-table asset-table">');
    expect(response.text).toContain('shared.png');
    expect(response.text).toContain(`href="/projects/${alpha.id}/assets/${selected.id}"`);
    expect(response.text).not.toContain(`href="/projects/${beta.id}/assets/${used.id}"`);
    expect(response.text).toContain('<option value="project" selected>Project</option>');
    expect(response.text).toContain('<option value="desc" selected>Descending</option>');
    expect(response.text).toContain('<option value="50" selected>50</option>');
    expect(response.text).toContain('<input type="hidden" name="view" value="list">');
  });

  it('redirects once to valid saved presentation defaults and renders the final URL directly', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    createAsset(createProject('Saved Defaults Project').id, 'saved.png');

    const redirect = await request(app).get('/assets').expect(302);
    expect(redirect.headers.location).toBe('/assets?sort=project&order=desc&pageSize=50&view=list');

    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
    expect(canonical.text).toContain('<option value="project" selected>Project</option>');
    expect(canonical.text).toContain('<option value="desc" selected>Descending</option>');
    expect(canonical.text).toContain('<option value="50" selected>50</option>');
    expect(canonical.text).toContain('<input type="hidden" name="view" value="list">');

    const final = await request(app).get(redirect.headers.location).expect(200);
    expect(final.headers.location).toBeUndefined();
  });

  it('does not redirect when saved Asset Viewer preferences are missing or fallback-equivalent', async () => {
    const missing = await request(app).get('/assets').expect(200);
    expect(missing.headers.location).toBeUndefined();

    writeAssetViewerDefaults({ view: 'grid', sort: 'filename', order: 'asc', pageSize: '25' });
    const fallbackEquivalent = await request(app).get('/assets').expect(200);
    expect(fallbackEquivalent.headers.location).toBeUndefined();
  });

  it('ignores invalid stored Asset Viewer values and keeps Project Assets defaults separate', async () => {
    const project = createProject('Default Scope Project');
    createAsset(project.id, 'scope.png');
    writeAssetViewerDefaults({ view: 'board', sort: 'title', order: 'forwards', pageSize: '20' });
    writePageDefault('projectAssets', 'view', 'list');
    writePageDefault('projectAssets', 'sort', 'category');
    writePageDefault('projectAssets', 'order', 'desc');
    writePageDefault('projectAssets', 'pageSize', '100');

    const assetViewer = await request(app).get('/assets').expect(200);
    expect(assetViewer.headers.location).toBeUndefined();
    expect(assetViewer.text).toContain('<option value="filename" selected>Filename</option>');
    expect(assetViewer.text).toContain('<option value="asc" selected>Ascending</option>');
    expect(assetViewer.text).toContain('<option value="25" selected>25</option>');
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

    const explicitSort = await request(app).get('/assets?sort=size').expect(302);
    expect(explicitSort.headers.location).toBe('/assets?sort=size&order=desc&pageSize=50&view=list');
    const explicitSortPage = await request(app).get(explicitSort.headers.location).expect(200);
    expect(explicitSortPage.text).toContain('<option value="size" selected>Size</option>');
    expect(explicitSortPage.text).toContain('<option value="desc" selected>Descending</option>');
    expect(explicitSortPage.text).toContain('<option value="50" selected>50</option>');
    expect(explicitSortPage.text).toContain('<input type="hidden" name="view" value="list">');

    const explicitControls = await request(app)
      .get('/assets?sort=size&order=asc&pageSize=10')
      .expect(302);
    expect(explicitControls.headers.location).toBe('/assets?sort=size&order=asc&pageSize=10&view=list');
    const explicitControlsPage = await request(app).get(explicitControls.headers.location).expect(200);
    expect(explicitControlsPage.text).toContain('<option value="asc" selected>Ascending</option>');
    expect(explicitControlsPage.text).toContain('<option value="10" selected>10</option>');

    const explicitView = await request(app).get('/assets?project=999&view=grid').expect(302);
    expect(explicitView.headers.location).toBe(
      '/assets?project=999&sort=project&order=desc&pageSize=50&view=grid',
    );
    const explicitViewPage = await request(app).get(explicitView.headers.location).expect(200);
    expect(explicitViewPage.headers.location).toBeUndefined();
    expect(explicitViewPage.text).toContain('<input type="hidden" name="view" value="grid">');
    expect(explicitViewPage.text).toContain('<option value="project" selected>Project</option>');
  });

  it('replaces invalid explicit values with fallbacks instead of rescuing them from saved values', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });

    const cases = [
      {
        query: 'view=invalid',
        location: '/assets?sort=project&order=desc&pageSize=50&view=grid',
      },
      {
        query: 'sort=invalid',
        location: '/assets?sort=filename&order=desc&pageSize=50&view=list',
      },
      {
        query: 'order=invalid',
        location: '/assets?sort=project&order=asc&pageSize=50&view=list',
      },
      {
        query: 'pageSize=20',
        location: '/assets?sort=project&order=desc&pageSize=25&view=list',
      },
    ];

    for (const testCase of cases) {
      const redirect = await request(app).get(`/assets?${testCase.query}`).expect(302);
      expect(redirect.headers.location).toBe(testCase.location);
      const canonical = await request(app).get(redirect.headers.location).expect(200);
      expect(canonical.headers.location).toBeUndefined();
    }
  });

  it('composes all existing filters with saved presentation defaults', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    const project = createProject('Composed Filters Project');
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
    insertReleaseUsage(project.id, used.id);
    markMissing(project.id);
    assetRepository.restorePresent(project.id, ['source/keep.PNG']);

    const redirect = await request(app).get(
      `/assets?project=${project.id}&category=source&search=keep&extension=.PNG&presence=present&usage=unused`,
    ).expect(302);
    expect(redirect.headers.location).toBe(
      `/assets?project=${project.id}&category=source&search=keep&extension=png&presence=present&usage=unused&sort=project&order=desc&pageSize=50&view=list`,
    );

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('keep.PNG');
    expect(response.text).not.toContain('used.PNG');
    expect(response.text).toContain('<option value="source" selected>Source</option>');
    expect(response.text).toContain('<option value="present" selected>Present</option>');
    expect(response.text).toContain('<option value="unused" selected>Not used in releases</option>');
  });

  it('canonicalizes invalid and unknown query state once while preserving normalized search and extension', async () => {
    const project = createProject('Canonical Project');
    createAsset(project.id, 'A+B.png', { filename: 'A+B.png', extension: 'PNG' });

    const redirect = await request(app)
      .get('/assets?unknown=discard&project=not-a-number&category=Not%20A%20Category&search=%20A%2BB%20&extension=.PNG&presence=invalid&usage=invalid&sort=invalid&order=invalid&page=0&pageSize=20&view=invalid')
      .expect(302);

    expect(redirect.headers.location).toBe('/assets?search=A%2BB&extension=png');

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

    const redirect = await request(app).get('/assets?page=99&pageSize=10&view=list').expect(302);
    expect(redirect.headers.location).toBe('/assets?page=2&pageSize=10&view=list');

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('Page 2 of 2');
    expect(response.text).toContain('href="/assets?pageSize=10&amp;view=list"');
    expect(response.text).toContain('href="/assets?page=2&amp;pageSize=10&amp;view=grid"');
    expect(response.text).toContain('href="/assets?pageSize=10&amp;view=list">Clear filters</a>');
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

    const redirect = await request(app).get('/assets?page=99').expect(302);
    expect(redirect.headers.location).toBe(
      '/assets?sort=project&order=desc&page=2&pageSize=50&view=list',
    );

    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
    expect(canonical.text).toContain('Page 2 of 2');

    const final = await request(app).get(redirect.headers.location).expect(200);
    expect(final.headers.location).toBeUndefined();
  });

  it('preserves effective presentation values through view, pagination, and clear-filter URLs', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    const project = createProject('URL Context Project');
    for (let index = 1; index <= 51; index++) {
      createAsset(project.id, `context-${String(index).padStart(2, '0')}.txt`, {
        filename: `context-${String(index).padStart(2, '0')}.txt`,
        extension: 'txt',
      });
    }

    const response = await request(app).get(
      `/assets?project=${project.id}&sort=project&order=desc&page=2&pageSize=50&view=list`,
    ).expect(200);

    expect(response.text).toContain(
      'href="/assets?project=' + project.id + '&amp;sort=project&amp;order=desc&amp;page=2&amp;pageSize=50&amp;view=grid"',
    );
    expect(response.text).toContain(
      'href="/assets?project=' + project.id + '&amp;sort=project&amp;order=desc&amp;pageSize=50&amp;view=list"',
    );
    expect(response.text).toContain(
      'href="/assets?sort=project&amp;order=desc&amp;pageSize=50&amp;view=list">Clear filters</a>',
    );
    expect(response.text).toContain('<option value="project" selected>Project</option>');
    expect(response.text).toContain('<option value="desc" selected>Descending</option>');
    expect(response.text).toContain('<option value="50" selected>50</option>');
  });

  it('discards unknown parameters while retaining effective saved presentation values', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });

    const redirect = await request(app).get('/assets?unknown=discard-me').expect(302);
    expect(redirect.headers.location).toBe('/assets?sort=project&order=desc&pageSize=50&view=list');
    expect(redirect.headers.location).not.toContain('unknown');

    const response = await request(app).get(redirect.headers.location).expect(200);
    expect(response.headers.location).toBeUndefined();
  });

  it('distinguishes no active assets from a filtered-empty result', async () => {
    const empty = await request(app).get('/assets').expect(200);
    expect(empty.text).toContain('No assets across active projects');
    expect(empty.text).not.toContain('No assets match the current filters');

    const project = createProject('Filtered Empty Project');
    createAsset(project.id, 'present.png');

    const filtered = await request(app).get('/assets?search=does-not-exist').expect(200);
    expect(filtered.text).toContain('No assets match the current filters');
    expect(filtered.text).not.toContain('No assets across active projects');
    expect(filtered.text).toContain('>Clear filters</a>');
  });

  it('leaves the existing project-scoped asset detail route available', async () => {
    const project = createProject('Detail Route Project');
    const asset = createAsset(project.id, 'detail.png');

    const response = await request(app).get(`/projects/${project.id}/assets/${asset.id}`).expect(200);

    expect(response.text).toContain(`Assets — Detail Route Project — ${asset.filename}`);
    expect(response.text).toContain(`href="/projects/${project.id}"`);
  });
});
