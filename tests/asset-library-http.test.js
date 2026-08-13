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
import { createTagRepository } from '../src/data/tag-repository.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';

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

    expect(response.text).toMatch(/<input id="asset-project-option-\d+" name="project" type="radio" value="\d+">/);
    expect(response.text).toMatch(/<label for="(asset-project-option-\d+)">\s*<input id="\1" name="project" type="radio" value="\d+">\s*<span>Alpha Project<\/span>\s*<\/label>/);
    expect(response.text).toMatch(/<label for="(asset-project-option-\d+)">\s*<input id="\1" name="project" type="radio" value="\d+">\s*<span>Beta Project<\/span>\s*<\/label>/);
    expect(response.text).toMatch(/<input id="asset-project-option-all" name="project" type="radio" value="" checked>/);
    expect(response.text).toContain('aria-label="Project filter: All projects"');
    expect(response.text).toMatch(/name="category"[^>]+value="source"/);
    expect(response.text).toMatch(/name="category"[^>]+value="alternate-references"/);
    expect(response.text).not.toContain('value="hidden"');
    expect(response.text).toMatch(/name="extension"[^>]+value="bin"/);
    expect(response.text).toMatch(/name="extension"[^>]+value="png"/);
    expect(response.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="asc" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="10">/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="25" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50">/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="100">/);
    expect(response.text).toContain('aria-label="Presence filter: All assets"');
    expect(response.text).toContain('aria-label="Release usage filter: All assets"');
    expect(response.text).toContain('aria-label="Sort by filter: Filename"');
    expect(response.text).toContain('aria-label="Sort order filter: Ascending"');
    expect(response.text).toContain('aria-label="Page size filter: 25"');
    expect(response.text).toContain('aria-label="Category filter: Any category"');
    expect(response.text).toContain('aria-label="Tag filter: Any tag"');
    expect(response.text).toContain('aria-label="Extension filter: Any extension"');
    expect(response.text).toContain('No tags available');
    expect(response.text).not.toContain('<select id="asset-tag"');
    expect(response.text).not.toMatch(/<form[^>]+method="post"/i);
    expect(response.text).not.toMatch(/Scan Now|Rename|Move file|Add selected|Set as primary|selectedAssetIds/i);

    await request(app).post('/assets').expect(404);
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

    const grid = await request(app).get('/assets').expect(200);
    expect(grid.text).toContain('<ul class="asset-viewer-grid-card-info-tags" aria-label="Effective tags">');
    expect((grid.text.match(/>HTTP Shared Tag<\/li>/g) || [])).toHaveLength(2);
    expect(grid.text).toContain('HTTP Present Tag');
    expect(grid.text).toContain('Missing at last scan');
    expect(grid.text).toMatch(new RegExp(`name="tag"[^>]+value="${shared.id}"`));
    expect(grid.text).toMatch(new RegExp(`name="tag"[^>]+value="${projectOnly.id}"`));
    expect((grid.text.match(/HTTP Project Only Tag <span class="asset-tag-origin">/g) || [])).toHaveLength(2);
    expect(grid.text).not.toContain('http-shared-secret');
    expect(grid.text).not.toContain('<select id="asset-tag"');

    const list = await request(app).get('/assets?view=list').expect(200);
    expect(list.text).toContain('<ul class="asset-list" role="list" aria-label="Assets across active projects">');
    expect(list.text).not.toContain('<table class="data-table asset-table">');
    expect((list.text.match(/<article class="asset-list-card"/g) || [])).toHaveLength(2);
    expect(list.text).toContain('<ul class="asset-list-card-tags" aria-label="Effective tags">');
    expect(list.text).toMatch(new RegExp(`name="tag"[^>]+value="${shared.id}"`));
    expect((list.text.match(/<span class="asset-tag-origin">/g) || [])).toHaveLength(2);
    expect((list.text.match(/<span class="asset-tag-origin"><span class="sr-only">Inherited from <\/span>Project<\/span>/g) || [])).toHaveLength(2);
    expect(list.text).not.toContain('http-shared-secret');
    expect(list.text).not.toContain('<select id="asset-tag"');
  });

  it('renders List view cards with metadata, detail links, release titles, effective tag origins, and no grid controls', async () => {
    const project = createProject('List Card Project');
    const category = assignCategory(project.id, {
      displayName: 'Renders',
      directorySlug: 'renders',
    });
    const released = createAsset(project.id, 'renders/hero.png', { categoryId: category.id });
    const unreleased = createAsset(project.id, 'notes/readme.txt');
    const direct = tagRepository.create({ displayName: 'Direct List Tag', normalizedName: 'direct-list-secret' });
    const inherited = tagRepository.create({ displayName: 'Inherited List Tag', normalizedName: 'inherited-list-secret' });
    tagRepository.assignToAsset(released.id, direct.id);
    tagRepository.assignToProject(project.id, inherited.id);

    const release = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes,
                            planned_date, published_date, patreon_url, archived_at)
      VALUES (?, ?, '', '', NULL, NULL, NULL, NULL)
      RETURNING id
    `).get(project.id, 'List Viewer Release');
    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'attachment', 0)
    `).run(release.id, released.id);

    const response = await request(app).get('/assets?view=list').expect(200);

    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('<ul class="asset-list" role="list" aria-label="Assets across active projects">');
    expect(response.text).not.toContain('<table class="data-table asset-table">');
    expect((response.text.match(/<article class="asset-list-card"/g) || [])).toHaveLength(2);
    expect(response.text).toContain(`class="asset-list-card-media-link" href="/projects/${project.id}/assets/${released.id}"`);
    expect(response.text).toMatch(new RegExp(`class="asset-list-card-media-image"[^>]*src="/projects/${project.id}/assets/${released.id}/preview\\?v=`));
    expect(response.text).not.toContain(`/projects/${project.id}/assets/${released.id}/thumbnail`);
    expect(response.text).toContain('alt=""');
    expect(response.text).toContain(`class="asset-file-link" href="/projects/${project.id}/assets/${released.id}"`);
    expect(response.text).toContain('hero.png');
    expect(response.text).toMatch(/data-asset-containing-location[\s\S]*?renders[\s\S]*?<\/span>/);
    expect(response.text).not.toContain('renders/hero.png');
    expect(response.text).toContain('Renders');
    expect(response.text).toContain('List Card Project');
    expect(response.text).toContain(`href="/releases/${release.id}">List Viewer Release</a>`);
    expect(response.text).toContain('<h3 class="asset-list-card-association-label">Effective tags</h3>');
    expect(response.text).toContain('<h3 class="asset-list-card-association-label">Releases</h3>');
    expect(response.text).toContain('Not in any release');
    expect(response.text).toContain('Direct List Tag');
    expect(response.text).toContain('Inherited List Tag');
    expect(response.text).toContain('<span class="asset-tag-origin"><span class="sr-only">Inherited from </span>Project</span>');
    expect(response.text).not.toContain('data-asset-grid-size-controls');
  });

  it('uses the larger preview derivative for PNG, JPEG, and Krita List previews', async () => {
    const project = createProject('List Preview Sources Project');
    const png = createAsset(project.id, 'renders/hero.png');
    const jpeg = createAsset(project.id, 'references/photo.jpg');
    const krita = createAsset(project.id, 'source/painting.kra');

    const response = await request(app).get('/assets?view=list').expect(200);
    const cards = response.text.match(/<article class="asset-list-card"[\s\S]*?<\/article>/g) || [];

    expect(cards).toHaveLength(3);
    for (const asset of [png, jpeg, krita]) {
      const card = cards.find((candidate) => candidate.includes(`assets/${asset.id}`));
      expect(card).toBeDefined();
      expect(card).toMatch(new RegExp(`src="/projects/${project.id}/assets/${asset.id}/preview\\?v=`));
      expect(card).not.toContain(`/projects/${project.id}/assets/${asset.id}/thumbnail`);
      expect(card).toContain(`class="asset-list-card-media-link" href="/projects/${project.id}/assets/${asset.id}"`);
      expect(card).toContain(`class="asset-file-link" href="/projects/${project.id}/assets/${asset.id}"`);
    }
  });

  it('renders exact three-region Grid cards with retained indicators, hover metadata, and no legacy actions', async () => {
    const project = createProject('Grid Card Project');
    const category = assignCategory(project.id, {
      displayName: 'Renders',
      directorySlug: 'renders',
    });
    const released = createAsset(project.id, 'renders/hero.png', { categoryId: category.id });
    const unreleased = createAsset(project.id, 'notes/readme.txt');
    const direct = tagRepository.create({ displayName: 'Direct Grid Tag', normalizedName: 'direct-grid-secret' });
    const inherited = tagRepository.create({ displayName: 'Inherited Grid Tag', normalizedName: 'inherited-grid-secret' });
    tagRepository.assignToAsset(released.id, direct.id);
    tagRepository.assignToProject(project.id, inherited.id);

    const zetaRelease = insertRelease(project.id, 'Zeta Grid Release', released.id);
    const alphaRelease = insertRelease(project.id, 'Alpha Grid Release', released.id);

    const response = await request(app).get('/assets').expect(200);
    const cards = response.text.match(/<article class="asset-card asset-viewer-grid-card"[\s\S]*?<\/article>/g) || [];
    const releasedCard = cards.find((card) => card.includes('hero.png'));
    const unreleasedCard = cards.find((card) => card.includes('readme.txt'));
    const topRow = releasedCard?.match(/<div class="asset-card-top asset-viewer-grid-card-top">[\s\S]*?<\/div>/)?.[0];
    const titleArea = releasedCard?.match(/<div class="asset-card-body asset-viewer-grid-card-title-area">[\s\S]*?<\/div>\s*<\/article>/)?.[0];

    expect(response.text).toContain('<ul class="asset-grid" role="list" aria-label="Assets across active projects">');
    expect(response.text).toContain('data-asset-grid-size-controls');
    expect((response.text.match(/<input[^>]+data-grid-size-slider[^>]+type="range"/g) || [])).toHaveLength(1);
    expect(response.text).toMatch(/<input[^>]+data-grid-size-slider[^>]+type="range"[^>]+min="1"[^>]+max="3"[^>]+step="1"/);
    const optionLabels = [...response.text.matchAll(/data-grid-size-option-label="(compact|default|large)"[^>]*>([^<]+)</g)];
    expect(optionLabels.map(([, value]) => value)).toEqual(['compact', 'default', 'large']);
    expect(optionLabels.map(([, , label]) => label)).toEqual(['Compact', 'Default', 'Large']);
    expect(response.text).toMatch(/is-active[^>]*data-grid-size-option-label="default"[^>]*>Default</);
    expect(response.text).not.toMatch(/<button[^>]+data-grid-size="(?:compact|default|large)"/);
    expect(cards).toHaveLength(2);
    expect(releasedCard).toBeDefined();
    expect(unreleasedCard).toBeDefined();
    expect(topRow).toBeDefined();
    expect((topRow?.match(/class="asset-indicator\b/g) || [])).toHaveLength(2);
    expect(topRow).toContain('asset-indicator--present');
    expect(topRow).toContain('asset-indicator--used');
    expect(topRow).not.toContain('asset-details-link');
    expect(topRow).not.toContain('asset-select-checkbox');
    expect(releasedCard).toContain(`class="asset-card-media-link asset-viewer-grid-card-preview-link" href="/projects/${project.id}/assets/${released.id}"`);
    expect(releasedCard).toContain('aria-label="View preview of hero.png"');
    expect(releasedCard).toContain('alt=""');
    expect(releasedCard).toContain(`class="asset-file-link" href="/projects/${project.id}/assets/${released.id}"`);
    expect(releasedCard).toContain('>hero.png</a>');
    expect(releasedCard).toContain('data-asset-viewer-preview');
    expect(releasedCard).toContain('data-asset-info-card');
    expect(releasedCard).toContain('renders/hero.png');
    expect(titleArea).toBeDefined();
    expect(titleArea).toContain('>Grid Card Project</a>');
    expect(titleArea).toContain('Alpha Grid Release');
    expect(titleArea).toContain('Zeta Grid Release');
    expect(titleArea).not.toContain('renders/hero.png');
    expect(titleArea).not.toContain('Renders');
    expect(titleArea).not.toContain('100 bytes');
    expect(titleArea).not.toContain('Effective tags');
    expect(titleArea).not.toContain('View asset details');
    for (const field of ['Location', 'Category', 'Extension', 'Size', 'Modified', 'Presence', 'Release usage']) {
      expect((releasedCard.match(new RegExp(`<dt>${field}</dt>`, 'g')) || [])).toHaveLength(1);
    }
    expect(releasedCard).toMatch(/<dt>Category<\/dt>[\s\S]*?Renders[\s\S]*?<\/dd>/);
    expect(releasedCard).toContain('Direct Grid Tag');
    expect(releasedCard).toContain('Inherited Grid Tag <span class="asset-tag-origin"><span class="sr-only">Inherited from </span>Project</span>');
    expect(releasedCard).toContain(`href="/releases/${alphaRelease.id}">Alpha Grid Release</a>`);
    expect(releasedCard).toContain(`href="/releases/${zetaRelease.id}">Zeta Grid Release</a>`);
    expect(releasedCard.indexOf('Alpha Grid Release')).toBeLessThan(releasedCard.indexOf('Zeta Grid Release'));
    expect(unreleasedCard).toContain('Not in any release');
    expect(releasedCard).toContain('Used in 2 releases');
    expect(response.text).toContain('Not used by a release');
    expect(response.text).not.toContain('asset-details-link');
    expect(response.text).not.toMatch(/Rename|Move file|selectedAssetIds|asset-select-checkbox/);
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

    const response = await request(app).get(`/assets?tag=${shared.id}&view=list`).expect(200);

    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('<ul class="asset-list" role="list" aria-label="Assets across active projects">');
    expect(response.text).not.toContain('<table class="data-table asset-table">');
    expect((response.text.match(/<article class="asset-list-card"/g) || [])).toHaveLength(3);
    expect(response.text).toContain('alpha-first.png');
    expect(response.text).toContain('alpha-multiple.png');
    expect(response.text).toContain('beta-missing.png');
    expect(response.text).not.toContain('beta-untagged.png');
    expect(response.text).toMatch(new RegExp(`name="tag"[^>]+value="${shared.id}" checked`));
    expect((response.text.match(/<span class="asset-tag-origin">/g) || [])).toHaveLength(2);
    expect(response.text).toContain('3 assets found');

    const inheritedResponse = await request(app).get(`/assets?tag=${projectOnly.id}&view=list`).expect(200);
    expect(inheritedResponse.text).toContain('<ul class="asset-list" role="list" aria-label="Assets across active projects">');
    expect(inheritedResponse.text).not.toContain('<table class="data-table asset-table">');
    expect((inheritedResponse.text.match(/<article class="asset-list-card"/g) || [])).toHaveLength(2);
    expect(inheritedResponse.text).toContain('alpha-first.png');
    expect(inheritedResponse.text).toContain('alpha-multiple.png');
    expect(inheritedResponse.text).not.toContain('beta-missing.png');
    expect(inheritedResponse.text).toContain('2 assets found');
  });

  it('canonicalizes repeated selections and preserves them through pagination and view links', async () => {
    createCategory({ displayName: 'Final', directorySlug: 'final', displayOrder: 1 });
    createCategory({ displayName: 'KRZ', directorySlug: 'krz', displayOrder: 2 });
    const alpha = createProject('Repeated Filter Alpha');
    const beta = createProject('Repeated Filter Beta');
    const alphaFinal = assignCategory(alpha.id, { displayName: 'Final', directorySlug: 'final' });
    const betaKrz = assignCategory(beta.id, { displayName: 'KRZ', directorySlug: 'krz' });
    const tagA = tagRepository.create({ displayName: 'Repeated Tag A', normalizedName: 'repeated-tag-a' });
    const tagB = tagRepository.create({ displayName: 'Repeated Tag B', normalizedName: 'repeated-tag-b' });
    tagRepository.assignToProject(alpha.id, tagA.id);
    tagRepository.assignToProject(beta.id, tagB.id);

    for (let index = 1; index <= 6; index++) {
      createAsset(alpha.id, `final/alpha-${String(index).padStart(2, '0')}.png`, {
        categoryId: alphaFinal.id,
        extension: 'png',
      });
    }
    for (let index = 1; index <= 5; index++) {
      createAsset(beta.id, `krz/beta-${String(index).padStart(2, '0')}.krz`, {
        categoryId: betaKrz.id,
        extension: 'krz',
      });
    }

    const tagValues = [tagA.id, tagB.id].sort((left, right) => left - right);
    const redirect = await request(app).get(
      `/assets?tag=${tagB.id}&tag=${tagA.id}&tag=${tagB.id}&tag=999999`
      + '&category=krz&category=final&category=all&category=not-a-valid-category'
      + '&extension=.KRZ&extension=png&extension=png&extension=unknown'
      + '&sort=project&page=2&pageSize=10&view=list',
    ).expect(302);

    const canonicalUrl = `/assets?category=final&category=krz&tag=${tagValues[0]}&tag=${tagValues[1]}`
      + '&extension=krz&extension=png&sort=project&page=2&pageSize=10&view=list';
    expect(redirect.headers.location).toBe(canonicalUrl);

    const response = await request(app).get(canonicalUrl).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('11 assets found');
    expect(response.text).toContain('Page 2 of 2');

    const escapedContext = `category=final&amp;category=krz&amp;tag=${tagValues[0]}&amp;tag=${tagValues[1]}`
      + '&amp;extension=krz&amp;extension=png&amp;sort=project';
    expect(response.text).toContain(`${escapedContext}&amp;pageSize=10&amp;view=list`);
    expect(response.text).toContain(`${escapedContext}&amp;page=2&amp;pageSize=10&amp;view=grid`);
    expect(response.text).toMatch(/name="category"[^>]+value="final" checked/);
    expect(response.text).toMatch(/name="category"[^>]+value="krz" checked/);
    expect(response.text).toMatch(/name="extension"[^>]+value="krz" checked/);
    expect(response.text).toMatch(/name="extension"[^>]+value="png" checked/);
  });

  it('canonicalizes malformed, nonexistent, and deleted tags once without redirect loops', async () => {
    const invalidValues = ['', '0', '-1', '1.5', '1junk', 'not-a-number', '9007199254740992', '9999'];

    for (const value of invalidValues) {
      const redirect = await request(app)
        .get(`/assets?tag=${encodeURIComponent(value)}&search=keep`)
        .expect(302);
      expect(redirect.headers.location).toBe('/assets?search=keep');

      const canonical = await request(app).get(redirect.headers.location).expect(200);
      expect(canonical.headers.location).toBeUndefined();
    }

    const deleted = tagRepository.create({ displayName: 'Deleted Filter Tag', normalizedName: 'deleted-filter-secret' });
    tagRepository.deleteById(deleted.id);
    const redirect = await request(app)
      .get(`/assets?tag=${deleted.id}&search=keep`)
      .expect(302);

    expect(redirect.headers.location).toBe('/assets?search=keep');
    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
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
    expect(response.text).toContain('<ul class="asset-list" role="list" aria-label="Assets across active projects">');
    expect(response.text).not.toContain('<table class="data-table asset-table">');
    expect(response.text).toContain('shared.png');
    expect(response.text).toContain(`href="/projects/${alpha.id}/assets/${selected.id}"`);
    expect(response.text).not.toContain(`href="/projects/${beta.id}/assets/${used.id}"`);
    expect(response.text).toMatch(new RegExp(
      `<input id="asset-project-option-${alpha.id}" name="project" type="radio" value="${alpha.id}" checked>`,
    ));
    expect(response.text).toContain('aria-label="Project filter: Filtered Alpha"');
    expect(response.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
    expect(response.text).toContain('<input type="hidden" name="view" value="list">');
    expect(response.text).not.toContain('id="asset-search"');
    expect(response.text).not.toMatch(/<input[^>]+name="search"/);
    expect(response.text).toContain('id="asset-project-filter-search"');
  });

  it('redirects once to valid saved presentation defaults and renders the final URL directly', async () => {
    writeAssetViewerDefaults({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' });
    createAsset(createProject('Saved Defaults Project').id, 'saved.png');

    const redirect = await request(app).get('/assets').expect(302);
    expect(redirect.headers.location).toBe('/assets?sort=project&order=desc&pageSize=50&view=list');

    const canonical = await request(app).get(redirect.headers.location).expect(200);
    expect(canonical.headers.location).toBeUndefined();
    expect(canonical.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
    expect(canonical.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(canonical.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
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

  it('redirects normal defaults saves to a known notice and renders it without canonicalizing it away', async () => {
    const save = await request(app)
      .post('/assets/defaults')
      .type('form')
      .send({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' })
      .expect(302);

    expect(save.headers.location).toBe(
      '/assets?view=list&sort=project&order=desc&pageSize=50&notice=asset_viewer_defaults_saved',
    );

    const redirected = await request(app).get(save.headers.location).expect(200);
    expect(redirected.headers.location).toBeUndefined();
    expect(redirected.text).toContain('Asset Viewer defaults saved successfully.');
  });

  it('applies page-local Asset Viewer defaults on a later bare render', async () => {
    await request(app)
      .post('/assets/defaults')
      .type('form')
      .send({ view: 'list', sort: 'project', order: 'desc', pageSize: '50' })
      .expect(302);

    const bare = await request(app).get('/assets').expect(302);
    expect(bare.headers.location).toBe('/assets?sort=project&order=desc&pageSize=50&view=list');

    const rendered = await request(app).get(bare.headers.location).expect(200);
    expect(rendered.headers.location).toBeUndefined();
    expect(rendered.text).toMatch(/name="sort"[^>]+value="project" checked/);
    expect(rendered.text).toMatch(/name="order"[^>]+value="desc" checked/);
    expect(rendered.text).toMatch(/name="pageSize"[^>]+value="50" checked/);
    expect(rendered.text).toContain('<input type="hidden" name="view" value="list">');
  });

  it('ignores arbitrary Asset Viewer notice values during canonicalization and rendering', async () => {
    const redirect = await request(app).get('/assets?notice=not-a-real-notice').expect(302);

    expect(redirect.headers.location).toBe('/assets');

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

    const assetViewer = await request(app).get('/assets').expect(200);
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

    const explicitSort = await request(app).get('/assets?sort=size').expect(302);
    expect(explicitSort.headers.location).toBe('/assets?sort=size&order=desc&pageSize=50&view=list');
    const explicitSortPage = await request(app).get(explicitSort.headers.location).expect(200);
    expect(explicitSortPage.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="size" checked>/);
    expect(explicitSortPage.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(explicitSortPage.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
    expect(explicitSortPage.text).toContain('<input type="hidden" name="view" value="list">');

    const explicitControls = await request(app)
      .get('/assets?sort=size&order=asc&pageSize=10')
      .expect(302);
    expect(explicitControls.headers.location).toBe('/assets?sort=size&order=asc&pageSize=10&view=list');
    const explicitControlsPage = await request(app).get(explicitControls.headers.location).expect(200);
    expect(explicitControlsPage.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="asc" checked>/);
    expect(explicitControlsPage.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="10" checked>/);

    const explicitView = await request(app).get('/assets?project=999&view=grid').expect(302);
    expect(explicitView.headers.location).toBe(
      '/assets?project=999&sort=project&order=desc&pageSize=50&view=grid',
    );
    const explicitViewPage = await request(app).get(explicitView.headers.location).expect(200);
    expect(explicitViewPage.headers.location).toBeUndefined();
    expect(explicitViewPage.text).toContain('<input type="hidden" name="view" value="grid">');
    expect(explicitViewPage.text).toContain('aria-label="Project filter: All projects"');
    expect(explicitViewPage.text).toMatch(/<input id="asset-project-option-all" name="project" type="radio" value="" checked>/);
    expect(explicitViewPage.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
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
    const tag = tagRepository.create({ displayName: 'Saved Default Tag', normalizedName: 'saved-default-secret' });
    tagRepository.assignToAsset(keep.id, tag.id);
    insertReleaseUsage(project.id, used.id);
    markMissing(project.id);
    assetRepository.restorePresent(project.id, ['source/keep.PNG']);

    const redirect = await request(app).get(
      `/assets?project=${project.id}&category=source&tag=${tag.id}&search=keep&extension=.PNG&presence=present&usage=unused`,
    ).expect(302);
    expect(redirect.headers.location).toBe(
      `/assets?project=${project.id}&category=source&tag=${tag.id}&search=keep&extension=png&presence=present&usage=unused&sort=project&order=desc&pageSize=50&view=list`,
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
      .get('/assets?unknown=discard&tag=123&project=not-a-number&category=Not%20A%20Category&search=%20A%2BB%20&extension=.PNG&presence=invalid&usage=invalid&sort=invalid&order=invalid&page=0&pageSize=20&view=invalid')
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
    expect(response.text).toMatch(/<noscript><button class="button" type="submit">Filter<\/button><\/noscript>/);
    expect(response.text).toMatch(/<a\b(?=[^>]*href="\/assets\?pageSize=10&amp;view=list")(?=[^>]*data-asset-library-reset)(?=[^>]*aria-label="Reset filters")[^>]*>[\s\S]*?<span class="sr-only">Reset<\/span><\/a>/);
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
      `/assets?project=${project.id}&tag=${tag.id}&sort=project&order=desc&page=2&pageSize=50&view=list`,
    ).expect(200);

    expect(response.text).toContain(
      'href="/assets?project=' + project.id + '&amp;tag=' + tag.id + '&amp;sort=project&amp;order=desc&amp;page=2&amp;pageSize=50&amp;view=grid"',
    );
    expect(response.text).toContain(
      'href="/assets?project=' + project.id + '&amp;tag=' + tag.id + '&amp;sort=project&amp;order=desc&amp;pageSize=50&amp;view=list"',
    );
    expect(response.text).toMatch(new RegExp(
      `<input id="asset-project-option-${project.id}" name="project" type="radio" value="${project.id}" checked>`,
    ));
    expect(response.text).toContain('aria-label="Project filter: URL Context Project"');
    expect(response.text).toMatch(/<a\b(?=[^>]*href="\/assets\?sort=project&amp;order=desc&amp;pageSize=50&amp;view=list")(?=[^>]*data-asset-library-reset)(?=[^>]*aria-label="Reset filters")[^>]*>[\s\S]*?<span class="sr-only">Reset<\/span><\/a>/);
    expect(response.text).toMatch(/<input[^>]+name="sort"[^>]+type="radio"[^>]+value="project" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="order"[^>]+type="radio"[^>]+value="desc" checked>/);
    expect(response.text).toMatch(/<input[^>]+name="pageSize"[^>]+type="radio"[^>]+value="50" checked>/);
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
    expect(filtered.text).toMatch(/<a\b(?=[^>]*data-asset-library-reset)(?=[^>]*aria-label="Reset filters")[^>]*>[\s\S]*?<span class="sr-only">Reset<\/span><\/a>/);
  });

  it('leaves the existing project-scoped asset detail route available', async () => {
    const project = createProject('Detail Route Project');
    const asset = createAsset(project.id, 'detail.png');

    const response = await request(app).get(`/projects/${project.id}/assets/${asset.id}`).expect(200);

    expect(response.text).toContain(`Assets — Detail Route Project — ${asset.filename}`);
    expect(response.text).toContain(`href="/projects/${project.id}"`);
  });
});
