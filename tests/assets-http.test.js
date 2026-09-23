import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import { createReleaseService } from '../src/services/release-service.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { AssetActionError, UNCATEGORIZED } from '../src/services/asset-action-service.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { makeZip } from './helpers/zip-fixture.js';
import slugify from '@sindresorhus/slugify';
import { createPngChunk } from '../src/services/workflow-prompt-editor.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset browser HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let previewRoot;
  let assetRepo;
  let assetCategoryRepo;
  let assetBrowserPreferenceRepo;
  let agent;
  let csrfToken;

  function createProject(title, status = 'tbd') {
    return agent
      .post('/projects')
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .send('priority=normal')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
  }

  /**
   * Resolve the flat project directory by scanning PROJECTS_ROOT for the
   * slug suffix. Status never participates: the project directory is a
   * direct child of PROJECTS_ROOT.
   */
  function getProjectDir(projectTitle) {
    const slug = slugify(projectTitle, { lowercase: true });
    const entries = fs.readdirSync(projectsRoot);
    const matching = entries.filter((e) => e.endsWith(`-${slug}`));
    if (matching.length === 0) return null;
    return path.join(projectsRoot, matching[0]);
  }

  async function makePng(width = 64, height = 64) {
    const sharp = (await import('sharp')).default;
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 80, g: 120, b: 200 },
      },
    }).png().toBuffer();
  }

  function textChunk(key, value) {
    return createPngChunk('tEXt', Buffer.concat([
      Buffer.from(key, 'latin1'),
      Buffer.from([0]),
      Buffer.from(value, 'latin1'),
    ]));
  }

  function uncompressedITextChunk(key, value) {
    return createPngChunk('iTXt', Buffer.concat([
      Buffer.from(key, 'ascii'),
      Buffer.from([0, 0, 0, 0, 0]),
      Buffer.from(value, 'utf8'),
    ]));
  }

  async function makePngWithMetadata(chunks) {
    const png = await makePng();
    return Buffer.concat([png.subarray(0, -12), ...chunks, png.subarray(-12)]);
  }

  function a1111ParametersMetadata() {
    return [
      'cinematic portrait <lora:portrait-style:0.8>',
      'Negative prompt: lowres, blurry',
      'Steps: 30, Sampler: Euler a, CFG scale: 4.0, Seed: 944442803, Size: 832x1248, Model: portrait.safetensors',
    ].join('\n');
  }

  function defaultMime(extension) {
    return ({
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      kra: 'application/x-krita',
      krz: 'application/x-krita',
      bin: 'application/octet-stream',
    })[extension] || 'application/octet-stream';
  }

  function writeIndexedAsset(projectId, projectDir, relPath, content, options = {}) {
    const normalizedRelPath = relPath.replace(/\\/g, '/');
    const filename = options.filename || path.basename(normalizedRelPath);
    const extension = options.extension || filename.split('.').pop().toLowerCase();
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const target = path.join(projectDir, ...normalizedRelPath.split('/'));

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);

    return assetRepo.upsert(Number(projectId), normalizedRelPath, {
      filename,
      extension,
      mimeType: options.mimeType ?? defaultMime(extension),
      sizeBytes: options.sizeBytes ?? buffer.length,
      modifiedAt: options.modifiedAt ?? '2026-07-28 10:00:00',
      categoryId: options.categoryId,
    });
  }

  function makeKritaArchive({ merged = null, preview = null } = {}) {
    const entries = [];
    if (preview) entries.push({ name: 'preview.png', data: preview, compression: 'deflate' });
    if (merged) entries.push({ name: 'mergedimage.png', data: merged, compression: 'deflate' });
    return makeZip(entries);
  }

  function saveAssetDefault(option, value) {
    return app.locals.pageDefaultsService.saveDefault('projectAssets', option, value);
  }

  function writeStoredAssetDefault(option, value) {
    const key = PAGE_DEFAULT_DEFINITIONS.projectAssets[option].key;
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  function saveProjectAssetDefault(projectId, option, value) {
    // These fixtures model an actively selected Project scope, not dormant rows.
    app.locals.projectPageDefaultRepository.setPageScope(projectId, 'projectAssets', 'project');
    return app.locals.projectPageDefaultRepository.setOption(projectId, 'projectAssets', option, value);
  }

  async function setupOrderedImageAssets(projectTitle) {
    const res = await createProject(projectTitle);
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir(projectTitle);
    if (!projectDir) throw new Error(`projectDir not found for ${projectTitle}`);
    const png = await makePng();
    return {
      id,
      projectDir,
      assets: {
        alpha: writeIndexedAsset(id, projectDir, 'alpha.png', png),
        bravo: writeIndexedAsset(id, projectDir, 'bravo.png', png),
        charlie: writeIndexedAsset(id, projectDir, 'charlie.png', png),
      },
    };
  }

  async function createReleaseUsingAsset(projectId, assetId, title = 'Viewer Release', projectStatus = 'planned') {
    const releaseRes = await agent
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = releaseRes.headers.location.replace('/releases/', '');
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(projectStatus, projectId);
    await agent
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${assetId}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return releaseId;
  }

  function decodeHtmlHref(value) {
    return value.replace(/&amp;/g, '&');
  }

  function anchorMatch(html, className) {
    const re = new RegExp(`<a\\b(?=[^>]*class="[^"]*\\b${className}\\b[^"]*")[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>`);
    return html.match(re);
  }

  function anchorHref(html, className) {
    const match = anchorMatch(html, className);
    return match ? decodeHtmlHref(match[1]) : null;
  }

  function expectProjectReturnLead(html, { href, title, extraClass = '' }) {
    const heading = html.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';
    const classSuffix = extraClass ? ` ${extraClass}` : '';
    const label = `Back to main project page: ${title}`;
    const lead = heading.match(new RegExp(
      `<a class="button button-secondary page-heading-lead page-heading-lead--icon asset-tooltip asset-tooltip--left${classSuffix}" href="${href}" aria-label="${label}" data-tooltip="${label}">([\\s\\S]*?)<\\/a>`
    ));

    expect(lead).not.toBeNull();
    expect(lead[0]).not.toContain('title=');
    expect(lead[1]).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    expect(lead[1]).toContain('<path d="M3 7l9-4 9 4-9 4-9-4z"/>');
    expect(lead[1]).toContain('<path d="M3 7v10l9 4 9-4V7"/>');
    expect(lead[1].replace(/<[^>]+>/g, '').trim()).toBe('');
    expect(heading).not.toContain(`Project: ${title}`);
  }

  function assetCardHtml(html, assetId) {
    return html.match(new RegExp(`<article\\b[^>]*data-asset-id="${assetId}"[\\s\\S]*?<\\/article>`))?.[0] || '';
  }

  function assetSelectionControlsHtml(html) {
    return html.match(/<div class="asset-selection-controls-area">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] || '';
  }

  function assetActionsPanelHtml(html) {
    const start = html.search(/<section class="project-detail-section asset-actions-panel(?: asset-actions-panel--selection-only)?" data-asset-actions-panel/);
    if (start < 0) return '';
    const panel = html.slice(start);
    const assetListStart = panel.search(/<ul class="asset-(?:grid|list)\b/);
    return assetListStart >= 0 ? panel.slice(0, assetListStart) : panel;
  }

  function expectProjectActionsSection(html, { selectionOnly = false } = {}) {
    const modifier = selectionOnly ? ' asset-actions-panel--selection-only' : '';
    expect(html).toMatch(new RegExp(
      `<section class="project-detail-section asset-actions-panel${modifier}" data-asset-actions-panel aria-labelledby="project-actions-heading">\\s*`
      + '<h2 id="project-actions-heading">Project actions<\\/h2>\\s*'
      + '<div class="project-detail-section-body">',
    ));
    expect(html).not.toContain('class="app-section-title"');
    expect(html).not.toMatch(/<h2[^>]*(?:class|style)=[^>]*>Project actions<\/h2>/);
    const bodyStart = html.indexOf('<div class="project-detail-section-body">');
    const formStart = html.indexOf('<form id="bulk-select-form"', bodyStart);
    const utilityStart = html.indexOf('<div class="asset-actions-category-row">', bodyStart);
    expect(formStart).toBeGreaterThan(bodyStart);
    expect(utilityStart).toBeGreaterThan(formStart);
  }

  function projectAssetsDisplayActions(html) {
    return html.match(/<div class="project-filter-actions project-filter-actions--projects">([\s\S]*?)<\/div>/)?.[1] || '';
  }

  function assetListCardHtml(html, assetId) {
    return html.match(new RegExp(`<article\\b(?=[^>]*class="[^"]*\\basset-list-card\\b[^"]*")(?=[^>]*data-asset-id="${assetId}"[^>]*)[^>]*>[\\s\\S]*?<\\/article>`))?.[0] || '';
  }

  function checkedBulkSelectionIds(html) {
    return [...html.matchAll(
      /<input\b(?=[^>]*\bform="bulk-select-form")(?=[^>]*\bname="selectedAssetIds")(?=[^>]*\bchecked)[^>]*\bvalue="(\d+)"[^>]*>/g,
    )].map((match) => match[1]);
  }

  function assetTagListHtml(html, className) {
    return html.match(new RegExp(`<ul class="[^"]*\\b${className}\\b[^"]*"[\\s\\S]*?<\\/ul>`))?.[0] || '';
  }

  function assetTagFilterHtml(html) {
    return (html.match(/<details class="asset-filter-multiselect[^>]*>[\s\S]*?<\/details>/g) || [])
      .find((candidate) => candidate.includes('aria-controls="asset-tag-filter-options"')) || '';
  }

  function assetExtensionFilterHtml(html) {
    return (html.match(/<details class="asset-filter-multiselect[^>]*>[\s\S]*?<\/details>/g) || [])
      .find((candidate) => candidate.includes('aria-controls="asset-extension-filter-options"')) || '';
  }

  function assetFilterHtml(html, optionsId) {
    return (html.match(/<details class="asset-filter-multiselect[^>]*>[\s\S]*?<\/details>/g) || [])
      .find((candidate) => candidate.includes(`aria-controls="${optionsId}"`)) || '';
  }

  function expectCheckedAssetFilter(html, name, value) {
    expect(html).toMatch(new RegExp(`<input[^>]*name="${name}"[^>]*type="radio"[^>]*value="${value}"[^>]*checked`));
  }

  function expectNoAssetResultsCount(html) {
    expect(html).not.toMatch(/\b\d+ assets? found\b/);
  }

  function expectAnchorHref(html, className, expected) {
    expect(anchorHref(html, className)).toBe(expected);
  }

  function expectNoAnchor(html, className) {
    expect(anchorMatch(html, className)).toBeNull();
  }

  function expectQueryKeys(href, keys) {
    const url = new URL(href, 'http://localhost');
    expect(Array.from(url.searchParams.keys())).toEqual(keys);
  }

  // Scopes preview-image assertions to the asset preview section only. The
  // app shell now renders a logo <img> in the sidebar on every page, so
  // asserting no '<img ' anywhere in the response would false-positive on
  // that unrelated chrome rather than the asset preview itself.
  function previewSectionHtml(html) {
    const match = html.match(/<section class="asset-preview-section"[^>]*>[\s\S]*?<\/section>/);
    if (!match) throw new Error('Rendered page did not include an asset-preview-section.');
    return match[0];
  }

  function extractSlideshowSequence(html) {
    const match = html.match(/<script[^>]*data-slideshow-sequence[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Rendered page did not include a data-slideshow-sequence element.');
    return JSON.parse(match[1]);
  }

  // Phase 12 CSP hardening moved styling out of an inline <style> block and
  // into an external stylesheet (linked via <link rel="stylesheet">) so no
  // 'unsafe-inline' style-src is required. This fetches the actually-served
  // stylesheet through the HTTP test agent — not the source file on disk —
  // so these assertions fail if /creatorcrate.css stops being served
  // correctly (wrong route, stale response, misconfigured static
  // middleware), not just if the source file changes.
  async function readStylesheetSource(html) {
    if (!html.includes('<link rel="stylesheet" href="/creatorcrate.css">')) {
      throw new Error('Rendered page did not include its stylesheet.');
    }
    const res = await agent.get('/creatorcrate.css').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    return res.text;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-browser-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    assetRepo = createAssetRepository(db);
    assetCategoryRepo = createAssetCategoryRepository(db);
    assetBrowserPreferenceRepo = createAssetBrowserPreferenceRepository(db);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic rendering ────────────────────────────────────────────────

  it('renders a Project Assets page with project and asset identity', async () => {
    const res = await createProject('Browser Title Test');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Browser Title Test');
    const asset = writeIndexedAsset(id, projectDir, 'project-asset.png', 'project asset');
    const other = await createProject('Other Browser Project');
    const otherId = Number(other.headers.location.replace('/projects/', ''));
    writeIndexedAsset(otherId, getProjectDir('Other Browser Project'), 'other-project-asset.png', 'other asset');

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const renderedAsset = assetCardHtml(res2.text, asset.id);

    expect(res2.text).toContain('Assets — Browser Title Test');
    expectProjectReturnLead(res2.text, { href: `/projects/${id}`, title: 'Browser Title Test' });
    expect(res2.text).toContain(`action="/projects/${id}/scan"`);
    expect(renderedAsset).toContain('project-asset.png');
    expect(res2.text).not.toContain('other-project-asset.png');
  });

  it('renders grid image dimensions without reading them for an ordinary list request', async () => {
    const created = await createProject('WP7 Dimension Enrichment Boundary');
    const id = Number(created.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('WP7 Dimension Enrichment Boundary');
    const present = writeIndexedAsset(id, projectDir, 'present.png', await makePng(96, 64));
    const missing = writeIndexedAsset(id, projectDir, 'missing.png', await makePng(32, 24));
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['present.png']);

    const getImageDimensions = vi.fn(async () => ({ width: 96, height: 64 }));
    const appDataRoot = path.join(tmpDir, 'wp7-dimension-boundary-app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const directApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      {
        appDataRoot,
        authState: { csrfPepper },
        assetWorkflowMetadataService: { getImageDimensions },
      },
    );
    const { agent: directAgent } = await getDisabledModeCsrf(directApp, appDataRoot);

    const grid = await directAgent
      .get(`/projects/${id}/assets?category=all&view=grid`)
      .expect(200);
    expect(getImageDimensions).toHaveBeenCalledTimes(1);
    expect(getImageDimensions).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: present.id, relative_path: present.relative_path }),
      expect.objectContaining({ id, project_dir: path.basename(projectDir) }),
    );
    expect(assetCardHtml(grid.text, present.id)).toContain('96 × 64');

    const listAll = await directAgent
      .get(`/projects/${id}/assets?category=all&view=list&pageSize=all`)
      .expect(200);
    expect(getImageDimensions).toHaveBeenCalledTimes(1);
    expect(assetListCardHtml(listAll.text, present.id)).not.toContain('96 × 64');
    expect(assetListCardHtml(listAll.text, missing.id)).toContain('Missing at last scan');
  });

  it('keeps non-dimension enrichment on every ordinary list action error rerender', async () => {
    const projectResponse = await createProject('Direct Rerender Enrichment');
    const id = Number(projectResponse.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Direct Rerender Enrichment');
    const asset = writeIndexedAsset(id, projectDir, 'ready.png', await makePng(80, 60));
    const inheritedTag = app.locals.tagService.createTag({ name: 'Inherited information tag' });
    const directTag = app.locals.tagService.createTag({ name: 'Direct information tag' });
    app.locals.projectTagService.replaceProjectTags(id, [inheritedTag.id]);
    app.locals.assetTagService.replaceAssetTags(asset.id, [directTag.id]);
    const releaseId = await createEmptyRelease(id, 'Direct Rerender Release');

    const getImageDimensions = vi.fn(async () => ({ width: 80, height: 60 }));
    const appDataRoot = path.join(tmpDir, 'direct-rerender-app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const directApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      {
        appDataRoot,
        authState: { csrfPepper },
        assetWorkflowMetadataService: { getImageDimensions },
      },
    );
    const { agent: directAgent, csrfToken: directCsrf } = await getDisabledModeCsrf(
      directApp,
      appDataRoot,
    );

    const renderedModels = [];
    const originalRender = directApp.response.render;
    const renderSpy = vi.spyOn(directApp.response, 'render').mockImplementation(function render(view, options, callback) {
      if (view === 'projects/assets.njk') renderedModels.push(options);
      return originalRender.call(this, view, options, callback);
    });

    try {
      await directAgent.post(`/projects/${id}/assets/add-to-release`).type('form').send({
        releaseId: String(releaseId), category: 'all', view: 'list', _csrf: directCsrf,
      }).expect(422);
      await directAgent.post(`/projects/${id}/assets/create-release`).type('form').send({
        category: 'all', view: 'list', _csrf: directCsrf,
      }).expect(422);
      await directAgent.post(`/projects/${id}/assets/move-selected`).type('form').send({
        category: 'all', view: 'list', destinationCategory: 'uncategorized', _csrf: directCsrf,
      }).expect(422);
      await directAgent.post(`/projects/${id}/assets/copy-selected`).type('form').send({
        category: 'all', view: 'list', destinationCategory: 'uncategorized', _csrf: directCsrf,
      }).expect(422);
      await directAgent.post(`/projects/${id}/assets/delete-selected`).type('form').send({
        category: 'all', view: 'list', _csrf: directCsrf,
      }).expect(422);
      await directAgent.post(`/projects/${id}/assets/auto-rename/preview`).type('form').send({
        category: 'all', view: 'list', categoryId: 'invalid', _csrf: directCsrf,
      }).expect(422);
      await directAgent.post(`/projects/${id}/assets/${asset.id}/rename`).type('form').send({
        filename: 'bad/name', origin: 'assets', category: 'all', view: 'list', _csrf: directCsrf,
      }).expect(422);
    } finally {
      renderSpy.mockRestore();
    }

    expect(renderedModels).toHaveLength(7);
    expect(getImageDimensions).not.toHaveBeenCalled();
    expect(renderedModels.map((model) => Boolean(
      model.bulkError
      || model.bulkMoveError
      || model.copyError
      || model.deleteError
      || model.autoRenameError
      || model.renameFailure
    ))).toEqual([true, true, true, true, true, true, true]);
    for (const model of renderedModels) {
      expect(model.filters.category).toBe('all');
      expect(model.filters.view).toBe('list');
      expect(model.assets).toHaveLength(1);
      expect(model.assets[0]).toMatchObject({
        id: asset.id,
        tags: [{ displayName: 'Direct information tag' }],
        effectiveTags: [
          { displayName: 'Direct information tag', origin: 'direct' },
          { displayName: 'Inherited information tag', origin: 'inherited' },
        ],
      });
      expect(model.assets[0]).not.toHaveProperty('formattedDimensions');
    }
  });

  it('forwards an Auto Rename render-model failure after enrichment exactly once', async () => {
    const projectResponse = await createProject('Auto Rename Render Failure');
    const id = Number(projectResponse.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Auto Rename Render Failure');
    const asset = writeIndexedAsset(id, projectDir, 'ready.png', await makePng(80, 60));
    const [category] = assetCategoryRepo.listProjectCategories(id);
    const postEnrichmentFailure = new Error('post-enrichment extension catalogue failure');
    const enrichProjectAssetInformationAssets = vi.fn(async (_project, assets) => assets);
    const getProjectAssetsDefaultExtensions = vi.fn(() => {
      expect(enrichProjectAssetInformationAssets).toHaveBeenCalledTimes(1);
      throw postEnrichmentFailure;
    });
    const workflowQueryService = {
      getProjectAutoRenameCategory: vi.fn(() => null),
      getProjectAssetBrowser: vi.fn(() => ({
        assets: [asset],
        total: 1,
        page: 1,
        pageSize: 25,
        pageCount: 1,
        filters: {
          category: 'all',
          tag: null,
          search: null,
          extension: null,
          presence: 'all',
          usage: 'all',
          sort: 'filename',
          order: 'asc',
          view: 'grid',
        },
        extensionChoices: ['png'],
        tagOptions: [],
        categoryNavigation: {
          totalCount: 1,
          missingCount: 0,
          uncategorizedCount: 0,
          enabled: [{
            id: category.id,
            displayName: category.display_name,
            directorySlug: category.directory_slug,
            assetCount: 1,
          }],
          disabled: [],
        },
        emptyState: null,
        isArchived: false,
        releaseTargets: [],
        searchMaxLength: 100,
      })),
      enrichProjectAssetInformationAssets,
      getProjectAssetsDefaultExtensions,
      getProjectTagFilterOptions: vi.fn(() => []),
    };
    const errorSpy = vi.fn();
    const applicationLogger = {
      error: errorSpy,
      info: vi.fn(),
      warn: vi.fn(),
      rebindRepository: vi.fn(),
      prune: vi.fn(),
    };
    const appDataRoot = path.join(tmpDir, 'auto-rename-render-failure-app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const failingApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      {
        appDataRoot,
        authState: { csrfPepper },
        workflowQueryService,
        applicationLogger,
      },
    );
    const { agent: failingAgent, csrfToken: failingCsrf } = await getDisabledModeCsrf(
      failingApp,
      appDataRoot,
    );
    const renderedViews = [];
    const originalRender = failingApp.response.render;
    const renderSpy = vi.spyOn(failingApp.response, 'render').mockImplementation(function render(view, options, callback) {
      renderedViews.push(view);
      return originalRender.call(this, view, options, callback);
    });

    try {
      const response = await failingAgent
        .post(`/projects/${id}/assets/auto-rename/preview`)
        .type('form')
        .send({ category: 'all', categoryId: 'invalid', _csrf: failingCsrf })
        .expect(500);

      expect(response.text).toContain('Something went wrong.');
      expect(enrichProjectAssetInformationAssets).toHaveBeenCalledTimes(1);
      expect(getProjectAssetsDefaultExtensions).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({
        event: 'runtime.http.unhandled_error',
        error: postEnrichmentFailure,
      }));
      expect(renderedViews).toEqual(['error.njk']);
    } finally {
      renderSpy.mockRestore();
    }
  });

  it('renders the missing cleanup affordance only for an active project with missing assets', async () => {
    const res = await createProject('Missing Cleanup Controls');
    const id = Number(res.headers.location.replace('/projects/', ''));
    assetRepo.upsert(id, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.markAllMissing(id);

    const active = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(active.text).toContain(`href="/projects/${id}/assets?remove_missing=1"`);
    expect(active.text).toContain(`action="/projects/${id}/assets/remove-missing"`);
    expect(active.text).toContain(`name="returnTo" value="/projects/${id}/assets"`);

    const emptyRes = await createProject('No Missing Cleanup Control');
    const emptyId = Number(emptyRes.headers.location.replace('/projects/', ''));
    const empty = await agent.get(`/projects/${emptyId}/assets`).expect(200);
    expect(empty.text).not.toContain('data-dialog-open="remove-missing-assets-dialog"');
    expect(empty.text).not.toContain(`action="/projects/${emptyId}/assets/remove-missing"`);

    await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
    const archived = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(archived.text).not.toContain('data-dialog-open="remove-missing-assets-dialog"');
    expect(archived.text).not.toContain('<dialog id="remove-missing-assets-dialog"');
    expect(archived.text).not.toContain(`action="/projects/${id}/assets/remove-missing"`);
  });

  it('removes eligible missing records within one project and reports protected records', async () => {
    const res = await createProject('Missing Cleanup HTTP');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Missing Cleanup HTTP');
    writeIndexedAsset(id, projectDir, 'present.png', 'present');
    assetRepo.upsert(id, 'removable.png', {
      filename: 'removable.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    const protectedAsset = assetRepo.upsert(id, 'protected.png', {
      filename: 'protected.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['present.png']);

    const releaseId = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
      VALUES (?, 'Published Missing Cleanup Release', '', '', NULL, '2026-08-05', NULL)
      RETURNING id
    `).get(id).id;
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, protectedAsset.id, 'attachment', 0);

    const response = await agent.post(`/projects/${id}/assets/remove-missing`).type('form').send({
      _csrf: csrfToken,
      returnTo: `/projects/${id}/assets?search=missing&view=list&unknown=strip-me`,
    }).expect(302);
    const location = new URL(response.headers.location, 'http://localhost');

    expect(location.pathname).toBe(`/projects/${id}/assets`);
    expect(location.searchParams.get('search')).toBe('missing');
    expect(location.searchParams.get('view')).toBe('list');
    expect(location.searchParams.get('missing_cleanup')).toBe('ok');
    expect(location.searchParams.get('missing_removed')).toBe('1');
    expect(location.searchParams.get('missing_protected')).toBe('1');
    expect(location.searchParams.get('missing_candidates')).toBe('2');
    expect(location.searchParams.has('unknown')).toBe(false);

    const rendered = await agent.get(response.headers.location).expect(200);
    expect(rendered.text).toContain('Missing asset cleanup complete: removed 1 of 2 missing asset records.');
    expect(rendered.text).toContain('Kept 1 missing asset record protected by published-release rules.');
  });

  it('logs successful missing-asset cleanup with safe aggregate context only', async () => {
    const res = await createProject('Missing Cleanup Activity Log');
    const id = Number(res.headers.location.replace('/projects/', ''));
    assetRepo.upsert(id, 'private-source.png', {
      filename: 'private-source.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.markAllMissing(id);
    app.locals.applicationLogRepository.clear();

    await agent.post(`/projects/${id}/assets/remove-missing`).type('form').send({
      _csrf: csrfToken,
      returnTo: `/projects/${id}/assets`,
    }).expect(302);

    const [record] = app.locals.applicationLogRepository.findPage({ kind: 'activity' });
    expect(record).toMatchObject({
      event: 'project.missing_assets.removed',
      level: 'info',
      kind: 'activity',
      subsystem: 'projects',
      project_id: id,
    });
    expect(record.context_json).toBe(JSON.stringify({
      removedCount: 1,
      protectedCount: 0,
      missingCandidateCount: 1,
    }));
    expect(record.context_json).not.toContain('private-source.png');
    expect(record.context_json).not.toContain(projectsRoot);
  });

  it('logs one safe aggregate activity for one manual project scan', async () => {
    const res = await createProject('Manual Scan Activity Log');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Manual Scan Activity Log');
    fs.writeFileSync(path.join(projectDir, 'private-source.png'), 'png');
    app.locals.applicationLogRepository.clear();

    await agent.post(`/projects/${id}/scan`).type('form').send({
      _csrf: csrfToken,
    }).expect(302);

    expect(app.locals.applicationLogRepository.count({ kind: 'activity' })).toBe(1);
    const [record] = app.locals.applicationLogRepository.findPage({ kind: 'activity' });
    expect(record).toMatchObject({
      event: 'project.scan.completed',
      level: 'info',
      kind: 'activity',
      subsystem: 'projects',
      project_id: id,
    });
    expect(record.context_json).toBe(JSON.stringify({
      discoveredCount: 1,
      addedCount: 1,
      updatedCount: 0,
      missingCount: 0,
    }));
    expect(record.context_json).not.toContain('private-source.png');
    expect(record.context_json).not.toContain(projectsRoot);
  });

  it('persists one primary-image activity per committed mutation through the real app logger', async () => {
    const res = await createProject('Primary Image Activity Log');
    const projectId = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Primary Image Activity Log');
    const asset = writeIndexedAsset(projectId, projectDir, 'primary.png', await makePng());

    app.locals.applicationLogRepository.clear();

    await agent.post(`/projects/${projectId}/assets/${asset.id}/primary-image`).type('form').send({
      _csrf: csrfToken,
    }).expect(302);

    let changed = db.prepare(`
      SELECT level, kind, subsystem, event, project_id, context_json
      FROM application_logs
      WHERE event = 'asset.primary_image.changed'
    `).all();
    expect(changed).toEqual([{
      level: 'info',
      kind: 'activity',
      subsystem: 'assets',
      event: 'asset.primary_image.changed',
      project_id: projectId,
      context_json: JSON.stringify({ primaryImageSet: true }),
    }]);

    await agent.post(`/projects/${projectId}/assets/${asset.id}/primary-image`).type('form').send({
      _csrf: csrfToken,
    }).expect(302);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM application_logs
      WHERE event = 'asset.primary_image.changed'
    `).get().count).toBe(1);

    await agent.post(`/projects/${projectId}/assets/${asset.id}/primary-image/remove`).type('form').send({
      _csrf: csrfToken,
    }).expect(302);

    let cleared = db.prepare(`
      SELECT level, kind, subsystem, event, project_id, context_json
      FROM application_logs
      WHERE event = 'asset.primary_image.cleared'
    `).all();
    expect(cleared).toEqual([{
      level: 'info',
      kind: 'activity',
      subsystem: 'assets',
      event: 'asset.primary_image.cleared',
      project_id: projectId,
      context_json: JSON.stringify({ primaryImageSet: false }),
    }]);

    await agent.post(`/projects/${projectId}/assets/${asset.id}/primary-image/remove`).type('form').send({
      _csrf: csrfToken,
    }).expect(409);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM application_logs
      WHERE event = 'asset.primary_image.cleared'
    `).get().count).toBe(1);
  });

  it('rejects missing cleanup without CSRF, for unknown or archived projects, and on GET', async () => {
    const res = await createProject('Missing Cleanup Validation');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const asset = assetRepo.upsert(id, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.markAllMissing(id);

    await agent.post(`/projects/${id}/assets/remove-missing`).type('form').send({}).expect(403);
    expect(assetRepo.findById(asset.id)).toBeDefined();
    await agent.get(`/projects/${id}/assets/remove-missing`).expect(404);
    await agent.post('/projects/999999/assets/remove-missing').type('form')
      .send({ _csrf: csrfToken }).expect(404);

    await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
    const archived = await agent.post(`/projects/${id}/assets/remove-missing`).type('form')
      .send({ _csrf: csrfToken }).expect(409);
    expect(archived.text).toContain('This project is archived and read-only.');
    expect(assetRepo.findById(asset.id)).toBeDefined();
  });

  it('renders Project Assets defaults as a corner utility with a custom tooltip', async () => {
    const res = await createProject('Defaults Presentation Test');
    const id = res.headers.location.replace('/projects/', '');
    const response = await agent.get(`/projects/${id}/assets`).expect(200);
    const defaultsLink = response.text.match(/<a class="[^"]*\basset-viewer-defaults-link\b[^"]*"[\s\S]*?<\/a>/)?.[0];

    expect(defaultsLink).toBeDefined();
    expect(defaultsLink).toContain(`href="/projects/${id}/assets?defaults=1"`);
    expect(defaultsLink).toContain('aria-label="Project Assets defaults"');
    expect(defaultsLink).toContain('asset-tooltip');
    expect(defaultsLink).toContain('asset-tooltip--left');
    expect(defaultsLink).toContain('data-tooltip="Project Assets defaults"');
    expect(defaultsLink).not.toContain('title=');

  });

  it('renders assigned tags with the correct Project Asset in list view', async () => {
    const res = await createProject('Asset Tag Browser Display');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const [untagged, tagged] = ['untagged.txt', 'tagged.txt'].map((filename) => assetRepo.upsert(id, filename, {
      filename,
      extension: 'txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      modifiedAt: null,
    }));
    const firstTag = app.locals.tagService.createTag({ name: 'Assigned <Alpha>' });
    const secondTag = app.locals.tagService.createTag({ name: 'Assigned Zebra' });
    app.locals.assetTagService.replaceAssetTags(tagged.id, [secondTag.id, firstTag.id]);

    const page = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const taggedCard = assetListCardHtml(page.text, tagged.id);
    const untaggedCard = assetListCardHtml(page.text, untagged.id);

    expect(assetTagListHtml(taggedCard, 'asset-tag-list')).toContain('Assigned &lt;Alpha&gt;');
    expect(assetTagListHtml(taggedCard, 'asset-tag-list')).toContain('Assigned Zebra');
    expect(taggedCard).not.toContain('Assigned <Alpha>');
    expect(untaggedCard).not.toContain('Assigned &lt;Alpha&gt;');
    expect(untaggedCard).not.toContain('Assigned Zebra');
  });

  it('filters project assets by one reusable tag, preserves uniqueness and pagination, and renders catalog options', async () => {
    const res = await createProject('Asset Tag Filter');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const assets = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((filename) => assetRepo.upsert(id, filename, {
      filename,
      extension: 'txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      modifiedAt: null,
    }));
    const zebra = app.locals.tagService.createTag({ name: 'Zebra Filter' });
    const shared = app.locals.tagService.createTag({ name: 'Shared Filter' });
    const alpha = app.locals.tagService.createTag({ name: 'Alpha Filter' });
    const projectOnly = app.locals.tagService.createTag({ name: 'Project Only Filter' });

    app.locals.projectTagService.replaceProjectTags(id, [projectOnly.id]);
    app.locals.assetTagService.replaceAssetTags(assets[0].id, [projectOnly.id]);
    app.locals.assetTagService.replaceAssetTags(assets[1].id, [shared.id, zebra.id, alpha.id]);
    app.locals.assetTagService.replaceAssetTags(assets[2].id, [shared.id]);
    app.locals.assetTagService.replaceAssetTags(assets[3].id, [shared.id]);

    const defaultPage = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const defaultFilter = assetTagFilterHtml(defaultPage.text);
    expect(defaultFilter).toContain('data-cc-dropdown data-cc-dropdown-mode="multiple"');
    expect(defaultFilter).toContain('aria-label="Tag filter: All tags"');
    expect(defaultFilter).not.toMatch(/name="tag"[^>]*checked/);
    expect((defaultPage.text.match(/<li class="asset-list-item/g) || [])).toHaveLength(4);

    const pageOne = await agent
      .get(`/projects/${id}/assets?tag=${shared.id}&sort=filename&order=asc&page=1&pageSize=2&view=list`)
      .expect(200);
    const filter = assetTagFilterHtml(pageOne.text);
    const nextMatch = pageOne.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const nextUrl = new URL(decodeHtmlHref(nextMatch[1]), 'http://localhost');
    const pageSizeForm = pageOne.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0] || '';

    expectNoAssetResultsCount(pageOne.text);
    expect((pageOne.text.match(/<li class="asset-list-item/g) || [])).toHaveLength(2);
    expect(pageOne.text).toContain('b.txt');
    expect(pageOne.text).toContain('c.txt');
    expect(pageOne.text).not.toContain('a.txt');
    expect(pageOne.text).not.toContain('d.txt');
    expect(filter).toContain('asset-filter-multiselect--sized');
    expect(filter).toContain('class="asset-filter-multiselect-summary-current"');
    expect(filter).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
    expect(filter).toContain('aria-label="Tag filter: Shared Filter"');
    expect(filter).toContain('role="group" aria-label="Tag options"');
    expect(filter).not.toContain('type="radio"');
    expect(filter).toMatch(new RegExp(`<label for="[^"]+">\\s*<input[^>]+name="tag"[^>]+type="checkbox"[^>]+value="${shared.id}"[^>]*checked`));
    expect(filter).toMatch(/<label for="[^"]+">\s*<input[^>]+name="tag"/);
    expect(filter).toContain('All tags');
    expect(filter).toContain('Alpha Filter');
    expect(filter).toContain('Project Only Filter');
    expect(filter).toContain('Shared Filter');
    expect(filter).toContain('Zebra Filter');
    const tagOptions = filter.slice(filter.indexOf('id="asset-tag-filter-options"'));
    expect(tagOptions.indexOf('Alpha Filter')).toBeLessThan(tagOptions.indexOf('Project Only Filter'));
    expect(tagOptions.indexOf('Project Only Filter')).toBeLessThan(tagOptions.indexOf('Shared Filter'));
    expect(tagOptions.indexOf('Shared Filter')).toBeLessThan(tagOptions.indexOf('Zebra Filter'));
    expect(filter).not.toContain('normalized_name');
    expect(pageSizeForm).toContain(`<input type="hidden" name="tag" value="${shared.id}">`);
    const filterForm = pageOne.text.match(/<form id="asset-filters" class="app-dialog-form project-form" method="get" action="\/projects\/\d+\/assets">[\s\S]*?<\/form>/)?.[0] || '';
    expect(filterForm).toContain('<input type="hidden" name="view" value="list">');
    expect(filterForm).not.toContain('name="page"');
    const ids = [...pageOne.text.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const duplicateContexts = duplicateIds.map((id) => ({
      id,
      matches: [...pageOne.text.matchAll(new RegExp(`.{0,80}id="${id}".{0,80}`, 'g'))].map((match) => match[0]),
    }));
    expect(duplicateContexts).toEqual([]);
    expect(nextUrl.searchParams.get('tag')).toBe(String(shared.id));
    expect(nextUrl.searchParams.get('page')).toBe('2');
    expect(nextUrl.searchParams.get('pageSize')).toBe('2');

    const gridHref = pageOne.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[\s\S]*?aria-label="Grid view"/)?.[1];
    expect(gridHref).toBeDefined();
    expect(new URL(decodeHtmlHref(gridHref), 'http://localhost').searchParams.get('tag'))
      .toBe(String(shared.id));

    const pageTwo = await agent.get(nextUrl.pathname + nextUrl.search).expect(200);
    expect(assetListCardHtml(pageTwo.text, assets[3].id)).toContain('d.txt');
    expect(pageTwo.text).not.toContain('a.txt');

    const multiple = await agent
      .get(`/projects/${id}/assets?tag=${shared.id}&tag=${zebra.id}&sort=filename&order=asc&page=1&pageSize=2&view=list`)
      .expect(200);
    const multipleFilter = assetTagFilterHtml(multiple.text);
    const multipleNextMatch = multiple.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    const multipleNextUrl = new URL(decodeHtmlHref(multipleNextMatch[1]), 'http://localhost');
    const multiplePageSizeForm = multiple.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0] || '';
    const resetForm = multiple.text.match(/<form class="projects-filter-reset"[^>]*>/)?.[0] || '';
    const resetHref = resetForm.match(/\baction="([^"]+)"/)?.[1];

    expect((multiple.text.match(/<li class="asset-list-item/g) || [])).toHaveLength(2);
    expect(multiple.text).toContain('b.txt');
    expect(multiple.text).toContain('c.txt');
    expect(multiple.text).not.toContain('a.txt');
    expect(multipleFilter).toContain('aria-label="Tag filter: 2 tags selected"');
    expect(multipleFilter).toContain('role="group" aria-label="Tag options"');
    expect(multipleFilter).not.toContain('asset-tag-option-all');
    expect(multipleFilter).not.toContain('type="radio"');
    for (const tagId of [shared.id, zebra.id]) {
      expect(multipleFilter).toMatch(new RegExp(`name="tag"[^>]+type="checkbox"[^>]+value="${tagId}"[^>]*checked`));
    }
    expect(multipleFilter).toMatch(new RegExp(`name="tag"[^>]+type="checkbox"[^>]+value="${alpha.id}"(?![^>]*checked)`));
    expect(multiplePageSizeForm.match(/<input type="hidden" name="tag"/g) || []).toHaveLength(2);
    expect(resetHref).toBeDefined();
    expect(new URL(decodeHtmlHref(resetHref), 'http://localhost').searchParams.has('tag')).toBe(false);
    expect(multipleNextUrl.searchParams.getAll('tag').sort()).toEqual(
      [String(shared.id), String(zebra.id)].sort(),
    );
    expect(new URL(
      decodeHtmlHref(multiple.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[\s\S]*?aria-label="Grid view"/)?.[1]),
      'http://localhost',
    ).searchParams.getAll('tag').sort()).toEqual(
      [String(shared.id), String(zebra.id)].sort(),
    );
  });

  it('composes tag, search, extension, presence, and release-usage filters', async () => {
    const res = await createProject('Composed Asset Tag Filter');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Composed Asset Tag Filter');
    const matching = writeIndexedAsset(id, projectDir, 'Hero-Final.png', 'png', {
      extension: 'png', mimeType: 'image/png',
    });
    const wrongExtension = writeIndexedAsset(id, projectDir, 'Hero-Final.jpg', 'jpg', {
      extension: 'jpg', mimeType: 'image/jpeg',
    });
    const missing = assetRepo.upsert(id, 'Hero-Missing.png', {
      filename: 'Hero-Missing.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    const tag = app.locals.tagService.createTag({ name: 'Composed Asset Tag' });
    app.locals.assetTagService.replaceAssetTags(matching.id, [tag.id]);
    app.locals.assetTagService.replaceAssetTags(wrongExtension.id, [tag.id]);
    app.locals.assetTagService.replaceAssetTags(missing.id, [tag.id]);
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['Hero-Final.png', 'Hero-Final.jpg']);
    const releaseId = Number(db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
      VALUES (?, 'Used Asset Release', '', '', NULL, NULL, NULL)
      RETURNING id
    `).get(id).id);
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, matching.id, 'attachment', 0);

    const response = await agent
      .get(`/projects/${id}/assets?tag=${tag.id}&search=hero&extension=.PNG&presence=present&usage=used`)
      .expect(200);

    expectNoAssetResultsCount(response.text);
    expect(response.text).toContain('Hero-Final');
    expect(response.text).not.toContain('Hero-Missing');
    expect(response.text).not.toContain('Hero-Final.jpg');
    expect(response.text).toContain('Used Asset Release');
  });

  it('uses ordinary filtered results for concrete-category extension, presence, and usage controls', async () => {
    const res = await createProject('Concrete Category Filter Controls');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Concrete Category Filter Controls');
    const [category] = assetCategoryRepo.listProjectCategories(id);
    if (!category) throw new Error('project has no category');

    writeIndexedAsset(id, projectDir, 'matching.png', 'matching', { categoryId: category.id });
    writeIndexedAsset(id, projectDir, 'wrong.jpg', 'wrong', { categoryId: category.id });
    const missingPng = writeIndexedAsset(id, projectDir, 'missing.png', 'missing', { categoryId: category.id });
    writeIndexedAsset(id, projectDir, 'unused.png', 'unused', { categoryId: category.id });
    const usedPng = writeIndexedAsset(id, projectDir, 'used.png', 'used', { categoryId: category.id });
    db.prepare("UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?").run(missingPng.id);
    await createReleaseUsingAsset(id, usedPng.id, 'Concrete Category Used Asset');

    const extension = await agent
      .get(`/projects/${id}/assets?category=${category.id}&extension=png`)
      .expect(200);
    expect(extension.text).toContain('matching.png');
    expect(extension.text).toContain('missing.png');
    expect(extension.text).toContain('unused.png');
    expect(extension.text).toContain('used.png');
    expect(extension.text).not.toContain('wrong.jpg');
    expect(assetExtensionFilterHtml(extension.text)).toContain('aria-label="Extension filter: .png"');
    expect(extension.text).not.toContain('data-auto-rename-surface');

    const present = await agent
      .get(`/projects/${id}/assets?category=${category.id}&presence=present`)
      .expect(200);
    expect(present.text).toContain('matching.png');
    expect(present.text).not.toContain('missing.png');
    expect(present.text).toContain('Present at last scan');

    const used = await agent
      .get(`/projects/${id}/assets?category=${category.id}&usage=used`)
      .expect(200);
    expect(used.text).toContain('used.png');
    expect(used.text).not.toContain('matching.png');
    expect(used.text).not.toContain('unused.png');
    expect(used.text).toContain('Used by a release');

    const completeCategory = await agent
      .get(`/projects/${id}/assets?category=${category.id}`)
      .expect(200);
    expect(completeCategory.text).toContain('data-auto-rename-surface');
    expect(completeCategory.text).toContain('wrong.jpg');
  });

  it('canonicalizes empty, malformed, nonexistent, and deleted tag values without selecting another tag', async () => {
    const res = await createProject('Invalid Asset Tag Values');
    const id = Number(res.headers.location.replace('/projects/', ''));
    assetRepo.upsert(id, 'tagged.txt', {
      filename: 'tagged.txt', extension: 'txt', mimeType: 'text/plain', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.upsert(id, 'untagged.txt', {
      filename: 'untagged.txt', extension: 'txt', mimeType: 'text/plain', sizeBytes: 10, modifiedAt: null,
    });
    const tag = app.locals.tagService.createTag({ name: 'Existing Asset Tag' });
    const taggedAsset = assetRepo.findByProjectIdAndPath(id, 'tagged.txt');
    app.locals.assetTagService.replaceAssetTags(taggedAsset.id, [tag.id]);

    for (const rawTag of ['', '0', '-1', '1.5', '1junk', '999999']) {
      const response = await agent
        .get(`/projects/${id}/assets?tag=${encodeURIComponent(rawTag)}&search=tagged&view=list`)
        .expect(200);
      const filter = assetTagFilterHtml(response.text);
      expectNoAssetResultsCount(response.text);
      expect(filter).toContain('aria-label="Tag filter: All tags"');
      expect(filter).not.toMatch(/name="tag"[^>]*checked/);
    }

    app.locals.tagService.deleteTag(tag.id);
    const deleted = await agent
      .get(`/projects/${id}/assets?tag=${tag.id}&search=tagged&view=list`)
      .expect(200);
    const deletedFilter = assetTagFilterHtml(deleted.text);
    const gridHref = deleted.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[\s\S]*?aria-label="Grid view"/)?.[1];

    expectNoAssetResultsCount(deleted.text);
    expect(deletedFilter).not.toContain(`value="${tag.id}"`);
    expect(new URL(decodeHtmlHref(gridHref), 'http://localhost').searchParams.has('tag')).toBe(false);
  });

  it('preserves a valid tag through saved presentation controls and browser action redirects', async () => {
    saveAssetDefault('view', 'list');
    saveAssetDefault('sort', 'size');
    saveAssetDefault('order', 'desc');
    saveAssetDefault('pageSize', '50');

    const res = await createProject('Asset Tag Action Context');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Asset Tag Action Context');
    const asset = writeIndexedAsset(id, projectDir, 'old.png', 'png', {
      extension: 'png', mimeType: 'image/png',
    });
    const tag = app.locals.tagService.createTag({ name: 'Action Context Tag' });
    app.locals.assetTagService.replaceAssetTags(asset.id, [tag.id]);

    const page = await agent.get(`/projects/${id}/assets?tag=${tag.id}&search=old`).expect(200);
    expectCheckedAssetFilter(page.text, 'sort', 'size');
    expectCheckedAssetFilter(page.text, 'order', 'desc');
    expect(page.text).toContain('<input type="hidden" name="pageSize" value="50">');
    expect(page.text).toContain('<input type="hidden" name="view" value="list">');
    expect(assetTagFilterHtml(page.text)).toMatch(new RegExp(`name="tag"[^>]+type="checkbox"[^>]+value="${tag.id}"[^>]*checked`));

    const scan = await agent
      .post(`/projects/${id}/scan`)
      .type('form')
      .send({ tag: String(tag.id), search: 'old', _csrf: csrfToken })
      .expect(302);
    const scanUrl = new URL(scan.headers.location, 'http://localhost');
    expect(scanUrl.searchParams.get('tag')).toBe(String(tag.id));
    expect(scanUrl.searchParams.get('search')).toBe('old');

    const renamed = await agent
      .post(`/projects/${id}/assets/${asset.id}/rename`)
      .type('form')
      .send({ filename: 'new', origin: 'assets', tag: String(tag.id), search: 'old', _csrf: csrfToken })
      .expect(302);
    const renameUrl = new URL(renamed.headers.location, 'http://localhost');
    expect(renameUrl.pathname).toBe(`/projects/${id}/assets`);
    expect(renameUrl.searchParams.get('tag')).toBe(String(tag.id));
    expect(renameUrl.searchParams.get('search')).toBe('old');
  });

  describe('WP2 Reset intent', () => {
    it.each(['grid', 'list'])('restores request-time scoped defaults while preserving %s', async (view) => {
      const title = `WP2 ${view}`;
      const created = await createProject(title);
      const id = Number(created.headers.location.replace('/projects/', ''));
      const otherView = view === 'grid' ? 'list' : 'grid';
      const tag = app.locals.tagService.createTag({ name: 'WP2 tag' });
      writeIndexedAsset(id, getProjectDir(title), 'chosen.png', 'png');
      writeStoredAssetDefault('view', otherView);
      const rendered = await agent.get(`/projects/${id}/assets?view=${view}&search=nomatch&sort=modified&order=asc&pageSize=100&page=3`).expect(200);
      const filteredEmptyReset = rendered.text.match(/<a\b[^>]*>\s*Reset Filters\s*<\/a>/)?.[0];
      expect(filteredEmptyReset).toBeDefined();
      const filteredEmptyResetHref = filteredEmptyReset.match(/\bhref="([^"]+)"/)?.[1];
      expect(decodeHtmlHref(filteredEmptyResetHref)).toBe(`/projects/${id}/assets?resetFilters=1&view=${view}`);
      expect(filteredEmptyReset).toContain('data-project-assets-reset');
      const links = [...rendered.text.matchAll(/(?:href|action)="([^"]+)"/g)]
        .map((match) => decodeHtmlHref(match[1])).filter((href) => href.includes('resetFilters='));
      expect(links).toEqual(Array(2).fill(`/projects/${id}/assets?resetFilters=1&view=${view}`));
      // Change defaults after rendering: the old link must not carry saved state.
      writeStoredAssetDefault('sort', 'size');
      writeStoredAssetDefault('order', 'desc');
      writeStoredAssetDefault('pageSize', '50');
      writeStoredAssetDefault('extension', 'png');
      writeStoredAssetDefault('tag', String(tag.id));
      for (const projectOverride of [false, true]) {
        if (projectOverride) {
          app.locals.pageDefaultsService.saveProjectDefault('projectAssets', 'sort', 'modified', undefined, { projectId: id });
          app.locals.pageDefaultsService.saveProjectDefault('projectAssets', 'pageSize', '10', undefined, { projectId: id });
          app.locals.pageDefaultsService.setPageDefaultScope('projectAssets', 'project', { projectId: id });
        }
        const reset = await agent.get(links[0] + '&search=discard&category=bad&tag=all&extension=jpg&sort=filename&order=asc&pageSize=25&page=9&notice=asset-renamed&defaults=1&manage_categories=1&inheritedFilterDefaults=bogus').expect(302);
        expect(reset.headers['cache-control']).toBe('no-store');
        const url = new URL(reset.headers.location, 'http://localhost');
        expect(url.searchParams.get('sort')).toBe(projectOverride ? 'modified' : 'size');
        expect(url.searchParams.get('order')).toBe('desc');
        expect(url.searchParams.get('pageSize')).toBe(projectOverride ? '10' : '50');
        expect(url.searchParams.get('view') || 'grid').toBe(view);
        expect(url.searchParams.getAll('tag')).toEqual([String(tag.id)]);
        expect(url.searchParams.getAll('extension')).toEqual(['png']);
        expect(url.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');
        for (const key of ['resetFilters', 'search', 'page', 'notice', 'defaults', 'manage_categories']) expect(url.searchParams.has(key)).toBe(false);
        const canonical = await agent.get(reset.headers.location).expect(200);
        expect(canonical.headers.location).toBeUndefined();
        expect(canonical.text).toContain(`resetFilters=1&amp;view=${view}`);
      }
      // Ordinary explicit view and explicit All must not activate saved filters/category.
      for (const query of ['view=grid', 'view=list', 'category=all&tag=all&extension=all']) {
        const ordinary = await agent.get(`/projects/${id}/assets?${query}`).expect(200);
        expect(ordinary.headers.location).toBeUndefined();
        expect(ordinary.text).not.toContain('name="inheritedFilterDefaults"');
      }
    });

    it.each(['project', 'global'])('restores %s category preference with suspended provenance and complete-category behavior', async (scope) => {
      const title = 'WP2 category';
      const created = await createProject(title);
      const id = Number(created.headers.location.replace('/projects/', ''));
      const [category] = assetCategoryRepo.listProjectCategories(id);
      for (let i = 0; i < 12; i += 1) {
        writeIndexedAsset(id, getProjectDir(title), `asset-${String(i).padStart(2, '0')}.png`, 'png', { categoryId: category.id });
      }
      const tag = app.locals.tagService.createTag({ name: 'WP2 category tag' });
      writeStoredAssetDefault('tag', String(tag.id));
      writeStoredAssetDefault('extension', 'png');
      writeStoredAssetDefault('pageSize', '10');
      writeStoredAssetDefault('view', 'list');
      if (scope === 'project') assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);
      else {
        assetBrowserPreferenceRepo.upsertProjectPreference(id, 'inherit', null);
        assetBrowserPreferenceRepo.setGlobalDefault(category.directory_slug);
      }
      const reset = await agent.get(`/projects/${id}/assets?resetFilters=1&view=grid&category=all&tag=all&inheritedFilterDefaults=extension&page=8`).expect(302);
      const url = new URL(reset.headers.location, 'http://localhost');
      expect(url.searchParams.get('category')).toBe(String(category.id));
      expect(url.searchParams.get('view')).toBe('grid');
      expect(url.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');
      expect(url.searchParams.has('tag')).toBe(false);
      expect(url.searchParams.has('extension')).toBe(false);
      expect(url.searchParams.has('resetFilters')).toBe(false);
      const canonical = await agent.get(reset.headers.location).expect(200);
      expect(canonical.text).toContain('data-auto-rename-surface');
      expect(canonical.text.match(/data-auto-rename-asset\s/g)).toHaveLength(12);
      expect(canonical.text).not.toContain('class="pagination-next"');
      expect(canonical.text.indexOf('asset-00.png')).toBeLessThan(canonical.text.indexOf('asset-11.png'));
      const ordinary = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
      expect(ordinary.headers.location).toBeUndefined();
      const all = await agent.get(`/projects/${id}/assets?category=all&tag=all`).expect(200);
      expect(all.text).not.toContain('data-auto-rename-surface');
      const restored = await agent.get(`/projects/${id}/assets?category=all&inheritedFilterDefaults=tag%2Cextension`).expect(200);
      expect(restored.text).toContain('name="inheritedFilterDefaults" value="tag,extension"');
    });

    it.each(['grid', 'list'])('canonicalizes fallback-only Reset without a loop (%s)', async (view) => {
      const created = await createProject('WP2 fallback');
      const id = created.headers.location.replace('/projects/', '');
      const reset = await agent.get(`/projects/${id}/assets?resetFilters=1&view=${view}`).expect(302);
      expect(reset.headers.location).not.toContain('resetFilters');
      await agent.get(reset.headers.location).expect(200);
    });

    it.each([
      'resetFilters=', 'resetFilters=0', 'resetFilters=1&resetFilters=1',
      'resetFilters[]=1', 'resetFilters[x]=1', 'resetFilters=1&resetFilters[]=1',
      'resetFilters=1', 'resetFilters=1&view=', 'resetFilters=1&view=other',
      'resetFilters=1&view=grid&view=list', 'resetFilters=1&view[]=grid',
      'resetFilters=1&view[x]=grid', 'resetFilters=1&view=grid&view[]=list',
    ])('rejects malformed Reset before resolving defaults: %s', async (query) => {
      const created = await createProject('WP2 validation');
      const id = created.headers.location.replace('/projects/', '');
      const resolve = vi.spyOn(app.locals.assetBrowserPreferenceService, 'resolveEffectiveCategory');
      await agent.get(`/projects/${id}/assets?${query}`).expect(400);
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  // ─── J09B: server-rendered Project Assets defaults ────────────────────
  describe('Project Assets default resolution', () => {
    it('redirects a bare request to the active Project-scope presentation and filter defaults', async () => {
      const title = 'Bare Project Defaults';
      const project = await createProject(title);
      const id = Number(project.headers.location.replace('/projects/', ''));
      const tag = app.locals.tagService.createTag({ name: 'Bare Project Defaults tag' });
      const projectDir = getProjectDir(title);
      const matching = writeIndexedAsset(id, projectDir, 'matching.png', 'png');
      writeIndexedAsset(id, projectDir, 'other.jpg', 'jpg');
      app.locals.assetTagService.replaceAssetTags(matching.id, [tag.id]);

      for (const [option, value] of Object.entries({
        view: 'list',
        gridSize: 'large',
        listSize: 'compact',
        sort: 'modified',
        order: 'desc',
        pageSize: '50',
        extension: 'png',
        tag: String(tag.id),
      })) saveProjectAssetDefault(id, option, value);

      const redirected = await agent.get('/projects/' + id + '/assets').expect(302);
      const url = new URL(redirected.headers.location, 'http://localhost');
      expect(url.searchParams.getAll('tag')).toEqual([String(tag.id)]);
      expect(url.searchParams.getAll('extension')).toEqual(['png']);
      expect(url.searchParams.get('sort')).toBe('modified');
      expect(url.searchParams.get('order')).toBe('desc');
      expect(url.searchParams.get('pageSize')).toBe('50');
      expect(url.searchParams.get('view')).toBe('list');
      expect(url.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');

      const rendered = await agent.get(redirected.headers.location).expect(200);
      expect(rendered.text).toContain('asset-list');
      expect(rendered.text).toContain('data-project-assets-grid-size-default="large"');
      expect(rendered.text).toContain('data-project-assets-list-size-default="compact"');
      expect(rendered.text).toContain(matching.filename);
      expect(rendered.text).not.toContain('other.jpg');

      const [category] = assetCategoryRepo.listProjectCategories(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);
      const categoryRedirect = await agent.get('/projects/' + id + '/assets').expect(302);
      const categoryUrl = new URL(categoryRedirect.headers.location, 'http://localhost');
      expect(categoryUrl.searchParams.get('category')).toBe(String(category.id));
      expect(categoryUrl.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');
    });

    it('uses the active Project scope without leaking its values to another project', async () => {
      const first = await createProject('Project Scope Defaults');
      const firstId = Number(first.headers.location.replace('/projects/', ''));
      const second = await createProject('Global Scope Defaults');
      const secondId = Number(second.headers.location.replace('/projects/', ''));

      saveAssetDefault('view', 'grid');
      saveAssetDefault('sort', 'size');
      saveAssetDefault('order', 'desc');
      saveAssetDefault('pageSize', '100');
      saveProjectAssetDefault(firstId, 'view', 'list');
      saveProjectAssetDefault(firstId, 'sort', 'modified');
      saveProjectAssetDefault(firstId, 'pageSize', '50');

      const firstRedirect = await agent.get('/projects/' + firstId + '/assets').expect(302);
      const firstUrl = new URL(firstRedirect.headers.location, 'http://localhost');
      expect(firstUrl.searchParams.get('view')).toBe('list');
      expect(firstUrl.searchParams.get('sort')).toBe('modified');
      expect(firstUrl.searchParams.get('pageSize')).toBe('50');

      const secondRedirect = await agent.get('/projects/' + secondId + '/assets').expect(302);
      const secondUrl = new URL(secondRedirect.headers.location, 'http://localhost');
      expect(secondUrl.searchParams.get('view')).toBeNull();
      expect(secondUrl.searchParams.get('sort')).toBe('size');
      expect(secondUrl.searchParams.get('pageSize')).toBe('100');
    });

    it('keeps explicit presentation query values authoritative over saved defaults', async () => {
      const project = await createProject('Explicit Project Assets Defaults');
      const id = Number(project.headers.location.replace('/projects/', ''));
      for (const [option, value] of Object.entries({
        view: 'list',
        sort: 'category',
        order: 'desc',
        pageSize: '50',
      })) saveProjectAssetDefault(id, option, value);

      const response = await agent
        .get('/projects/' + id + '/assets?view=grid&sort=filename&order=asc&pageSize=10&search=hero')
        .expect(200);

      expect(response.headers.location).toBeUndefined();
      expect(response.text).toContain('asset-grid');
      expect(response.text).toContain('value="hero"');
      expectCheckedAssetFilter(response.text, 'sort', 'filename');
      expectCheckedAssetFilter(response.text, 'order', 'asc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="10">');
    });

    it('falls back safely when persisted presentation and category defaults become invalid', async () => {
      const project = await createProject('Stale Project Assets Defaults');
      const id = Number(project.headers.location.replace('/projects/', ''));
      const [category] = assetCategoryRepo.listProjectCategories(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);
      assetCategoryRepo.setProjectCategoryEnabled(id, category.id, false);
      writeStoredAssetDefault('view', 'board');
      writeStoredAssetDefault('sort', 'published');
      writeStoredAssetDefault('order', 'forwards');
      writeStoredAssetDefault('pageSize', '20');

      const response = await agent.get('/projects/' + id + '/assets').expect(200);

      expect(response.headers.location).toBeUndefined();
      expect(response.text).toMatch(/<input id="asset-category-option-all"[\s\S]*?checked>/);
      expect(response.text).toContain('asset-grid');
      expectCheckedAssetFilter(response.text, 'sort', 'filename');
      expectCheckedAssetFilter(response.text, 'order', 'asc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="25">');
      expect(assetBrowserPreferenceRepo.findProjectPreference(id)).toMatchObject({
        default_category_mode: 'category',
        default_category_id: category.id,
      });
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key).value).toBe('board');
    });

    it('resolves active Project defaults on an archived page without testing mutations', async () => {
      const project = await createProject('Archived Project Assets Defaults');
      const id = Number(project.headers.location.replace('/projects/', ''));
      saveProjectAssetDefault(id, 'view', 'list');
      saveProjectAssetDefault(id, 'sort', 'modified');
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(id);

      const redirected = await agent.get('/projects/' + id + '/assets').expect(302);
      const url = new URL(redirected.headers.location, 'http://localhost');
      expect(url.searchParams.get('view')).toBe('list');
      expect(url.searchParams.get('sort')).toBe('modified');
    });

    it('resets to scoped defaults while retaining only the request-time View', async () => {
      const project = await createProject('Reset Scoped Project Assets Defaults');
      const id = Number(project.headers.location.replace('/projects/', ''));
      const tag = app.locals.tagService.createTag({ name: 'Reset scoped default tag' });
      writeIndexedAsset(id, getProjectDir('Reset Scoped Project Assets Defaults'), 'available.png', 'png');
      for (const [option, value] of Object.entries({
        view: 'list',
        sort: 'size',
        order: 'desc',
        pageSize: '50',
        extension: 'png',
        tag: String(tag.id),
      })) saveProjectAssetDefault(id, option, value);

      const reset = await agent.get(
        '/projects/' + id + '/assets?resetFilters=1&view=grid&search=discard&sort=filename&order=asc&pageSize=10&page=4',
      ).expect(302);
      const url = new URL(reset.headers.location, 'http://localhost');

      expect(url.searchParams.get('view')).toBe('grid');
      expect(url.searchParams.get('sort')).toBe('size');
      expect(url.searchParams.get('order')).toBe('desc');
      expect(url.searchParams.get('pageSize')).toBe('50');
      expect(url.searchParams.getAll('tag')).toEqual([String(tag.id)]);
      expect(url.searchParams.getAll('extension')).toEqual(['png']);
      expect(url.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');
      for (const key of ['resetFilters', 'search', 'page']) expect(url.searchParams.has(key)).toBe(false);
    });

    it('rejects a stale scope submission before changing either default scope', async () => {
      const project = await createProject('Stale Project Assets Scope');
      const id = Number(project.headers.location.replace('/projects/', ''));
      saveAssetDefault('view', 'grid');
      saveProjectAssetDefault(id, 'view', 'list');

      const rejected = await agent.post('/projects/' + id + '/assets/defaults').type('form').send({
        view: 'list',
        gridSize: 'large',
        listSize: 'compact',
        sort: 'modified',
        order: 'desc',
        pageSize: '50',
        extension: 'all',
        tag: 'all',
        scope: 'global',
        loadedScope: 'project',
        returnTo: '/projects/' + id + '/assets',
        _csrf: csrfToken,
      }).expect(422);

      expect(rejected.text).toContain('does not match the loaded values');
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets').view).toBe('grid');
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual({ view: 'list' });
    });

    it('persists a Project-scope submission and renders the scope payload consumed by J05', async () => {
      const project = await createProject('Project Assets Defaults HTTP Boundary');
      const id = Number(project.headers.location.replace('/projects/', ''));
      saveAssetDefault('view', 'grid');
      saveAssetDefault('sort', 'filename');

      const saved = await agent.post('/projects/' + id + '/assets/defaults').type('form').send({
        view: 'list',
        gridSize: 'large',
        listSize: 'compact',
        sort: 'modified',
        order: 'desc',
        pageSize: '50',
        extension: 'all',
        tag: 'all',
        scope: 'project',
        loadedScope: 'project',
        returnTo: '/projects/' + id + '/assets',
        _csrf: csrfToken,
      }).expect(302);
      expect(saved.headers.location).toContain('/projects/' + id + '/assets?');
      expect(app.locals.pageDefaultsService.getPageDefaultScope('projectAssets', { projectId: id })).toBe('project');

      const rendered = await agent.get('/projects/' + id + '/assets?defaults=1').expect(200);
      const dialog = rendered.text.match(/<dialog id="project-assets-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      const values = JSON.parse(
        dialog.match(/<script type="application\/json" data-project-assets-default-values>([\s\S]*?)<\/script>/)?.[1] || '{}',
      );
      expect(dialog).toMatch(/name="scope"[^>]*value="project"[^>]*checked/);
      expect(dialog).toContain('name="loadedScope" value="project"');
      expect(values.global).toMatchObject({ view: 'grid', sort: 'filename' });
      expect(values.project).toMatchObject({
        view: 'list',
        gridSize: 'large',
        listSize: 'compact',
        sort: 'modified',
        order: 'desc',
        pageSize: '50',
      });
    });
  });


  describe('non-bare requests and effective category surfaces', () => {
    it.each(['category=all', 'category=uncategorized', 'category=invalid'])
      ('keeps explicit unsupported category context ordinary and does not resolve the stored default: %s', async (query) => {
        const res = await createProject(`Unsupported Default ${query}`);
        const id = Number(res.headers.location.replace('/projects/', ''));
        const [category] = assetCategoryRepo.listProjectCategories(id);
        assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);

        const resolveSpy = vi.spyOn(app.locals.assetBrowserPreferenceService, 'resolveEffectiveCategory');
        const response = await agent.get(`/projects/${id}/assets?${query}`).expect(200);

        expect(response.headers.location).toBeUndefined();
        expect(resolveSpy).not.toHaveBeenCalled();
        expect(response.text).not.toContain('data-auto-rename-surface');
        resolveSpy.mockRestore();
      });

    it('uses the concrete default for a non-category query and strips incomplete filters from the ordering surface', async () => {
      const res = await createProject('Non-Bare Concrete Default');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const [category] = assetCategoryRepo.listProjectCategories(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);
      assetRepo.upsert(id, 'default/a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1,
        modifiedAt: null, categoryId: category.id, nestedPath: 'default',
      });

      const response = await agent.get(`/projects/${id}/assets?search=no-match&page=9&pageSize=1&view=list`).expect(200);
      expect(response.text).toContain('data-auto-rename-surface');
      expect(response.text).toContain('name="view" value="list"');
      expect(response.text).toContain('id="search" name="search"');
      expect(response.text).not.toContain('pagination-info');
    });
  });

  describe('Assets-page project default removal', () => {
    async function createProjectId(title) {
      const res = await createProject(title);
      return Number(res.headers.location.replace('/projects/', ''));
    }

    it('renders the project preference control inside the category-management dialog', async () => {
      const id = await createProjectId('Assets Default Removed');
      const res = await agent
        .get(`/projects/${id}/assets?category=all&notice=project_asset_default_saved`)
        .expect(200);

      expect(res.text).toContain('Asset browser default');
      expect(res.text).toContain('project-asset-categories-default-category');
      expect(res.text).not.toContain(`action="/projects/${id}/assets/default-category"`);
      expect(res.text).not.toContain('Project asset default saved.');
      expect(res.text).toContain('name="defaultCategory"');
    });

    it('returns normal not-found behavior for the removed preference endpoint', async () => {
      const id = await createProjectId('Assets Default Endpoint Removed');
      const res = await agent.post(`/projects/${id}/assets/default-category`).type('form')
        .send({ defaultCategory: 'all', _csrf: csrfToken })
        .expect(404);

      expect(res.text).toContain('Not found');
      expect(res.text).not.toContain('Something went wrong.');
      expect(res.text).not.toContain('assetBrowserPreferenceService');
    });

    it('explicit All overrides a configured specific default without invoking bare resolution', async () => {
      const id = await createProjectId('Assets Explicit All Override');
      const [category] = assetCategoryRepo.listProjectCategories(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);

      const resolveSpy = vi.spyOn(app.locals.assetBrowserPreferenceService, 'resolveEffectiveCategory');
      const res = await agent.get(`/projects/${id}/assets?category=all`).expect(200);

      expect(res.headers.location).toBeUndefined();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(res.text).toMatch(/<input id="asset-category-option-all"[\s\S]*?checked>/);
      resolveSpy.mockRestore();
    });
  });

  it('omits the removed scan-freshness disclaimer', async () => {
    const res = await createProject('Freshness Disclaimer Removed');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).not.toContain('scan-freshness');
    expect(res2.text).not.toContain('Asset presence reflects the last completed scan');
    expect(res2.text).not.toContain('Disabled categories are still scanned');
  });

  it('shows total matching result count', async () => {
    const res = await createProject('Count Test');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Count Test');

    // Create and scan files
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'b.jpg'), 'jpg');
    fs.writeFileSync(path.join(projectDir, 'c.txt'), 'txt');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expectNoAssetResultsCount(res2.text);
  });

  // ─── Presence and usage query boundary ─────────────────────────────

  it.each([
    ['presence', 'present', 'present'],
    ['presence', 'missing', 'missing'],
    ['presence', 'invalid', 'all'],
    ['usage', 'used', 'used'],
    ['usage', 'unused', 'unused'],
    ['usage', 'invalid', 'all'],
  ])('renders the normalized %s=%s selected state (%s)', async (key, value, selected) => {
    const res = await createProject(`Asset ${key} ${value}`);
    const id = res.headers.location.replace('/projects/', '');
    const optionsId = key === 'presence' ? 'asset-presence-filter-options' : 'asset-usage-filter-options';

    const page = await agent.get(`/projects/${id}/assets?${key}=${value}`).expect(200);
    const filter = assetFilterHtml(page.text, optionsId);
    expectCheckedAssetFilter(filter, key, selected);
  });

  // ─── Present/missing wording ─────────────────────────────────────

  it('uses "Present at last scan" wording for present assets', async () => {
    const res = await createProject('Present Wording');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Present Wording');

    fs.writeFileSync(path.join(projectDir, 'still-here.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('Present at last scan');
  });

  it('uses "Missing at last scan" wording for missing assets', async () => {
    const res = await createProject('Missing Wording');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Missing Wording');

    fs.writeFileSync(path.join(projectDir, 'gone.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    fs.rmSync(path.join(projectDir, 'gone.png'));
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?presence=missing`)
      .expect(200);
    expect(res2.text).toContain('Missing at last scan');
  });

  it('locates presence-state element within a specific asset row by filename', async () => {
    const res = await createProject('Row Presence');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Row Presence');

    // Create two files: one present, one that will become missing
    fs.writeFileSync(path.join(projectDir, 'present-file.txt'), 'present');
    fs.writeFileSync(path.join(projectDir, 'missing-file.txt'), 'missing');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Remove missing-file to make it missing
    fs.rmSync(path.join(projectDir, 'missing-file.txt'));
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);

    const projectAssets = assetRepo.findByProjectId(id);
    const presentAsset = projectAssets.find((asset) => asset.filename === 'present-file.txt');
    const missingAsset = projectAssets.find((asset) => asset.filename === 'missing-file.txt');
    const presentCard = assetListCardHtml(res2.text, presentAsset.id);
    const missingCard = assetListCardHtml(res2.text, missingAsset.id);

    expect(presentCard).toContain('asset-indicator--present');
    expect(presentCard).toContain('aria-label="Present"');
    expect(presentCard).not.toContain('asset-indicator--missing');
    expect(presentCard).toContain(`class="asset-details-link asset-details-link--present asset-tooltip asset-tooltip--right" href="/projects/${id}/assets/${presentAsset.id}?view=list"`);
    expect(presentCard).toContain('aria-label="Asset details | File present" data-tooltip="Asset details | File present"');
    expect(missingCard).toContain('asset-indicator--missing');
    expect(missingCard).toContain('aria-label="Missing at last scan"');
    expect(missingCard).not.toContain('asset-indicator--present');
    expect(missingCard).toContain(`class="asset-details-link asset-details-link--missing asset-tooltip asset-tooltip--right" href="/projects/${id}/assets/${missingAsset.id}?view=list"`);
    expect(missingCard).toContain('aria-label="Asset details | File missing!" data-tooltip="Asset details | File missing!"');
  });

  // ─── Pagination ──────────────────────────────────────────────────

  it('preserves inherited filter provenance through Project Assets pagination and view navigation', async () => {
    const res = await createProject('Inherited Filter Navigation');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Inherited Filter Navigation');
    if (!projectDir) throw new Error('projectDir not found for Inherited Filter Navigation');

    for (let i = 0; i < 35; i++) {
      fs.writeFileSync(path.join(projectDir, `default-${String(i).padStart(2, '0')}.png`), `content${i}`);
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const response = await agent
      .get(`/projects/${id}/assets?extension=png&inheritedFilterDefaults=extension&page=1`)
      .expect(200);

    const nextHref = response.text.match(/<a href="([^"]+)" class="pagination-next">Next/)?.[1];
    expect(nextHref).toBeDefined();
    const nextUrl = new URL(decodeHtmlHref(nextHref), 'http://localhost');
    expect(nextUrl.searchParams.get('extension')).toBe('png');
    expect(nextUrl.searchParams.get('inheritedFilterDefaults')).toBe('extension');

    const gridHref = response.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[\s\S]*?aria-label="Grid view"/)?.[1];
    expect(gridHref).toBeDefined();
    const gridUrl = new URL(decodeHtmlHref(gridHref), 'http://localhost');
    expect(gridUrl.searchParams.get('extension')).toBe('png');
    expect(gridUrl.searchParams.get('inheritedFilterDefaults')).toBe('extension');
  });

  it('preserves inherited filter provenance through action redirects and validation re-renders', async () => {
    const res = await createProject('Inherited Filter Action Context');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Inherited Filter Action Context');
    if (!projectDir) throw new Error('projectDir not found for Inherited Filter Action Context');
    fs.writeFileSync(path.join(projectDir, 'default.png'), 'content');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
    const returnTo = `/projects/${id}/assets?extension=png&inheritedFilterDefaults=extension`;

    const action = await agent.post(`/projects/${id}/assets/remove-missing`).type('form').send({
      returnTo,
      _csrf: csrfToken,
    }).expect(302);
    const actionUrl = new URL(action.headers.location, 'http://localhost');
    expect(actionUrl.searchParams.get('extension')).toBe('png');
    expect(actionUrl.searchParams.get('inheritedFilterDefaults')).toBe('extension');

    const validation = await agent.post(`/projects/${id}/assets/move-selected`).type('form').send({
      extension: 'png',
      inheritedFilterDefaults: 'extension',
      destinationCategory: 'uncategorized',
      _csrf: csrfToken,
    }).expect(422);
    expect(validation.text).toContain('name="inheritedFilterDefaults" value="extension"');
  });

  it('preserves explicit All through browser links, forms, viewer navigation, and pagination', async () => {
    const { id, assets } = await setupOrderedImageAssets('Explicit All Context');
    const response = await agent
      .get(`/projects/${id}/assets?category=all&pageSize=1&view=list`)
      .expect(200);

    const viewLinks = [...response.text.matchAll(/class="[^"]*view-switcher-option[^"]*" href="([^"]+)"/g)]
      .map((match) => new URL(decodeHtmlHref(match[1]), 'http://localhost'));
    expect(viewLinks).toHaveLength(2);
    for (const url of viewLinks) {
      expect(url.searchParams.get('category')).toBe('all');
    }

    const nextMatch = response.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const nextUrl = new URL(decodeHtmlHref(nextMatch[1]), 'http://localhost');
    expect(nextUrl.searchParams.get('category')).toBe('all');
    expect(nextUrl.searchParams.get('page')).toBe('2');

    const rowHref = anchorHref(response.text, 'asset-details-link');
    expect(rowHref).not.toBeNull();
    expect(new URL(rowHref, 'http://localhost').searchParams.get('category')).toBe('all');

    const viewer = await agent.get(rowHref).expect(200);
    for (const className of ['asset-viewer-back', 'asset-preview-nav--next']) {
      const href = anchorHref(viewer.text, className);
      expect(href).not.toBeNull();
      expect(new URL(decodeHtmlHref(href), 'http://localhost').searchParams.get('category')).toBe('all');
    }
    expect(new URL(decodeHtmlHref(anchorHref(viewer.text, 'asset-preview-nav--next')), 'http://localhost').pathname)
      .toBe(`/projects/${id}/assets/${assets.bravo.id}`);

    const scanForm = response.text.match(/<form method="post" action="\/projects\/\d+\/scan"[^>]*>[\s\S]*?<\/form>/)?.[0];
    expect(scanForm).toContain('<input type="hidden" name="category" value="all">');

    const pageSizeForm = response.text.match(/<form class="page-size-form"[^>]*>[\s\S]*?<\/form>/)?.[0];
    expect(pageSizeForm).toContain('<input type="hidden" name="category" value="all">');

    expect(response.text).toMatch(/<input id="asset-category-option-all"[\s\S]*?checked>/);
  });

  it('renders exact canonical pagination URLs for normalized browser filters', async () => {
    const res = await createProject('Canonical Asset URLs');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Canonical Asset URLs');
    if (!projectDir) throw new Error('projectDir not found for Canonical Asset URLs');
    const [category] = assetCategoryRepo.listProjectCategories(id);
    if (!category) throw new Error('project category not found for Canonical Asset URLs');
    const firstTag = app.locals.tagService.createTag({ name: 'Canonical first tag' });
    const secondTag = app.locals.tagService.createTag({ name: 'Canonical second tag' });

    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(
        path.join(projectDir, category.directory_slug, `File & ${String(i).padStart(2, '0')}.png`),
        `content${i}`,
      );
    }
    for (let i = 10; i < 12; i++) {
      fs.writeFileSync(
        path.join(projectDir, category.directory_slug, `File & ${String(i).padStart(2, '0')}.txt`),
        `content${i}`,
      );
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
    for (const asset of assetRepo.findByProjectId(id)) {
      app.locals.assetTagService.replaceAssetTags(asset.id, [firstTag.id, secondTag.id]);
    }

    const encodedSearch = encodeURIComponent('File &');
    const res2 = await agent
      .get(`/projects/${id}/assets?category=${category.id}&tag=${firstTag.id}&tag=${secondTag.id}&search=${encodedSearch}&extension=.PNG&extension=.txt&presence=present&usage=unused&sort=category&order=desc&page=1&pageSize=10&view=list&unknown=strip-me`)
      .expect(200);

    const nextMatch = res2.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const href = nextMatch[1].replace(/&amp;/g, '&');
    expect(href).toBe(`/projects/${id}/assets?category=${category.id}&tag=${firstTag.id}&tag=${secondTag.id}&search=File+%26&extension=png&extension=txt&presence=present&usage=unused&sort=category&order=desc&page=2&pageSize=10&view=list`);

    const nextUrl = new URL(href, 'http://localhost');
    expect(Array.from(nextUrl.searchParams.keys())).toEqual([
      'category', 'tag', 'tag', 'search', 'extension', 'extension', 'presence', 'usage', 'sort', 'order', 'page', 'pageSize', 'view',
    ]);
    expect(nextUrl.searchParams.get('category')).toBe(String(category.id));
    expect(nextUrl.searchParams.getAll('tag')).toEqual([String(firstTag.id), String(secondTag.id)]);
    expect(nextUrl.searchParams.get('search')).toBe('File &');
    expect(nextUrl.searchParams.getAll('extension')).toEqual(['png', 'txt']);
    expect(nextUrl.searchParams.get('presence')).toBe('present');
    expect(nextUrl.searchParams.get('usage')).toBe('unused');
    expect(nextUrl.searchParams.get('sort')).toBe('category');
    expect(nextUrl.searchParams.get('order')).toBe('desc');
    expect(nextUrl.searchParams.get('page')).toBe('2');
    expect(nextUrl.searchParams.get('pageSize')).toBe('10');
    expect(nextUrl.searchParams.get('view')).toBe('list');
    expect(nextUrl.searchParams.has('unknown')).toBe(false);
    expect(nextUrl.searchParams.has('scan_result')).toBe(false);
    expectCheckedAssetFilter(res2.text, 'category', String(category.id));
    expectCheckedAssetFilter(res2.text, 'presence', 'present');
    expectCheckedAssetFilter(res2.text, 'usage', 'unused');
    expectCheckedAssetFilter(res2.text, 'sort', 'category');
    expectCheckedAssetFilter(res2.text, 'order', 'desc');
    for (const tagId of [firstTag.id, secondTag.id]) {
      expect(assetTagFilterHtml(res2.text)).toMatch(new RegExp(`name="tag"[^>]+value="${tagId}"[^>]*checked`));
    }
    for (const extension of ['png', 'txt']) {
      expect(assetExtensionFilterHtml(res2.text)).toMatch(new RegExp(`name="extension"[^>]+value="${extension}"[^>]*checked`));
    }
    // Project list cards render the established versioned preview derivative.
    // The bulk toolbar also has a legitimate /auto-rename/preview POST action,
    // so scope these assertions to image src attributes.
    expect(res2.text).toMatch(/<img\b[^>]*src="[^"]+\/preview\?v=[^"&]+/);
    expect(res2.text).not.toMatch(/<img\b[^>]*src="[^"]+\/thumbnail(?:\?|"|&)/);
  });

  it('invalid view normalization strips view from canonical pagination URLs', async () => {
    const res = await createProject('Invalid View URL');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Invalid View URL');
    if (!projectDir) throw new Error('projectDir not found for Invalid View URL');

    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(projectDir, `file${String(i).padStart(2, '0')}.png`), `content${i}`);
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?view=table&pageSize=10&junk=1`)
      .expect(200);

    const nextMatch = res2.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const href = nextMatch[1].replace(/&amp;/g, '&');
    expect(href).toBe(`/projects/${id}/assets?page=2&pageSize=10`);
  });

  // ─── Slideshow sequence ────────────────────────────────────────────────

  it('project assets: slideshow sequence includes all previewable assets regardless of visible page', async () => {
    const res = await createProject('Slideshow Beyond Page');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Beyond Page');
    const png = await makePng();

    const assets = Array.from({ length: 4 }, (_, index) => writeIndexedAsset(
      id,
      projectDir,
      `img${index + 1}.png`,
      png,
    ));

    const page1 = await agent.get(`/projects/${id}/assets?page=1&pageSize=2`).expect(200);
    const seq1 = extractSlideshowSequence(page1.text);

    expect(page1.text).toMatch(/data-asset-id="\d+"/);
    const visibleIds = [...page1.text.matchAll(/data-asset-id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(visibleIds).toHaveLength(2);
    expect(seq1.map((entry) => entry.id)).toEqual(assets.map((asset) => asset.id));

    const page2 = await agent.get(`/projects/${id}/assets?page=2&pageSize=2`).expect(200);
    const seq2 = extractSlideshowSequence(page2.text);
    expect(seq2.length).toBe(4);
    expect(seq1.map((e) => e.id)).toEqual(seq2.map((e) => e.id));
  });

  it('project assets: slideshow sequence honors active filters', async () => {
    const res = await createProject('Slideshow Filter Honor');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Filter Honor');
    const png = await makePng();

    const alpha = writeIndexedAsset(id, projectDir, 'alpha.png', png);
    const bravo = writeIndexedAsset(id, projectDir, 'bravo.jpg', Buffer.from('notrealpng'), { extension: 'jpg', mimeType: 'image/jpeg' });
    const charlie = writeIndexedAsset(id, projectDir, 'charlie.png', png);

    const filteredRes = await agent.get(`/projects/${id}/assets?extension=png`).expect(200);
    const seq = extractSlideshowSequence(filteredRes.text);
    const sequenceIds = seq.map((entry) => entry.id);
    expect(sequenceIds).toEqual([alpha.id, charlie.id]);
    expect(sequenceIds).not.toContain(bravo.id);
  });

  it('project assets: slideshow sequence ordering matches canonical page ordering', async () => {
    const res = await createProject('Slideshow Order Match');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Order Match');
    const png = await makePng();

    writeIndexedAsset(id, projectDir, 'zeta.png', png);
    writeIndexedAsset(id, projectDir, 'alpha.png', png);
    writeIndexedAsset(id, projectDir, 'mu.png', png);

    const res2 = await agent.get(`/projects/${id}/assets?sort=filename&order=asc`).expect(200);
    const seq = extractSlideshowSequence(res2.text);
    const filenames = seq.map((e) => e.filename);
    expect(filenames).toEqual([...filenames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  });

  it('project assets: slideshow sequence exposes derivative previews and image-only originals', async () => {
    const res = await createProject('Slideshow Preview and Original URLs');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Preview and Original URLs');
    const png = await makePng();

    const image = writeIndexedAsset(id, projectDir, 'image.png', png);
    const krita = writeIndexedAsset(
      id,
      projectDir,
      'design.kra',
      Buffer.from('not a real archive'),
      { extension: 'kra', mimeType: 'application/x-krita' },
    );

    const pageRes = await agent.get(`/projects/${id}/assets`).expect(200);
    const seq = extractSlideshowSequence(pageRes.text);
    const imageEntry = seq.find((entry) => entry.id === image.id);
    const kritaEntry = seq.find((entry) => entry.id === krita.id);

    expect(imageEntry).toMatchObject({
      previewUrl: expect.stringContaining('/preview?'),
      originalUrl: `/projects/${id}/assets/${image.id}/original`,
    });
    expect(imageEntry.previewUrl).not.toContain('/original');
    expect(imageEntry.previewUrl).not.toContain('/thumbnail?');
    expect(imageEntry.thumbnailUrl).toBeUndefined();
    expect(kritaEntry).toBeDefined();
    expect(kritaEntry.originalUrl).toBeUndefined();
    expect(kritaEntry.previewUrl).toContain('/preview?');
  });

  it('project assets: slideshow sequence excludes missing and unsupported assets', async () => {
    const res = await createProject('Slideshow Exclude Non-Displayable');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Exclude Non-Displayable');
    const png = await makePng();

    const good = writeIndexedAsset(id, projectDir, 'good.png', png);
    const unsupported = writeIndexedAsset(id, projectDir, 'bad.bin', Buffer.from('binary'), { extension: 'bin', mimeType: 'application/octet-stream' });
    const mismatch = writeIndexedAsset(id, projectDir, 'mismatch.png', png, { extension: 'png', mimeType: 'image/jpeg' });
    const missing = assetRepo.upsert(id, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: '2026-01-01 00:00:00',
    });
    db.prepare('UPDATE assets SET is_present = 0 WHERE project_id = ? AND filename = ?').run(id, 'missing.png');

    const pageRes = await agent.get(`/projects/${id}/assets?presence=all`).expect(200);
    const seq = extractSlideshowSequence(pageRes.text);
    expect(seq.map((entry) => entry.id)).toEqual([good.id]);
    expect(seq.map((entry) => entry.id)).not.toContain(unsupported.id);
    expect(assetRepo.findByProjectId(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mismatch.id, is_present: 1 }),
    ]));
    expect(seq.map((entry) => entry.id)).not.toContain(mismatch.id);
    expect(seq.map((entry) => entry.id)).not.toContain(missing.id);
  });

  it('project assets: normal visible pagination is unchanged by slideshow sequence', async () => {
    const res = await createProject('Slideshow Pagination Unchanged');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Pagination Unchanged');
    const png = await makePng();

    for (let i = 1; i <= 3; i++) {
      writeIndexedAsset(id, projectDir, `asset${i}.png`, png);
    }

    const page1 = await agent.get(`/projects/${id}/assets?page=1&pageSize=2`).expect(200);
    const visibleCount = [...page1.text.matchAll(/data-asset-id="\d+"/g)].length;
    expect(visibleCount).toBe(2);
    expect(page1.text).toContain('data-slideshow-sequence');
  });

  // ─── Empty states ────────────────────────────────────────────────

  it('shows filtered empty state when no assets match filters', async () => {
    const res = await createProject('Empty Filtered');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Empty Filtered');

    fs.writeFileSync(path.join(projectDir, 'present.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?presence=missing`)
      .expect(200);
    // Missing filter with zero missing assets gets its own distinct message,
    // not the generic filtered-empty message.
    expect(res2.text).toContain('No missing assets');
    expect(res2.text).toContain('Reset Filters');
  });

  it('shows the generic filtered-empty state for a non-missing filter with no matches', async () => {
    const res = await createProject('Empty Filtered Generic');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Empty Filtered Generic');

    fs.writeFileSync(path.join(projectDir, 'present.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?search=nomatch`)
      .expect(200);
    expect(res2.text).toContain('No assets match the current filters');
    expect(res2.text).toContain('Reset Filters');
  });

  it('shows empty state for project with no assets, with no separate no-op manual scan action', async () => {
    const res = await createProject('No Assets Project');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('No assets found');
    expect(res2.text).not.toContain('data-selected-count');
    // The empty-state partial's action div must not exist for the
    // no-assets case — the only manual scan control on the page is the
    // POST form already rendered in the heading.
    expect(res2.text).not.toMatch(/<div class="empty-state-actions">/);
  });

  // ─── Defect fix: no no-op manual scan GET anchor in the empty state ─────

  describe('manual scan is never a no-op GET link', () => {
    it('renders one POST scan form with CSRF and normalized browser context, never a GET scan link', async () => {
      const res = await createProject('Scan Ctrl Form Shape');
      const id = res.headers.location.replace('/projects/', '');

      const res2 = await agent.get(`/projects/${id}/assets?category=all&search=hero&presence=present&sort=size&order=desc&pageSize=50`).expect(200);
      const html = res2.text;

      const scanNowButtons = html.match(/<button\b(?=[^>]*aria-label="Manually scan project files")[^>]*>[\s\S]*?<\/button>/g) || [];
      expect(scanNowButtons).toHaveLength(1);

      const formMatch = html.match(new RegExp(`<form\\b[^>]*\\baction="/projects/${id}/scan"[^>]*>[\\s\\S]*?<\\/form>`));
      expect(formMatch).not.toBeNull();
      const form = formMatch[0];
      expect(form.match(/\bmethod="([^"]+)"/)?.[1].toLowerCase()).toBe('post');
      expect(form).toContain('Manually scan project files');
      const csrfInput = form.match(/<input\b(?=[^>]*\bname="_csrf")(?=[^>]*\bvalue="([^"]*)")[^>]*>/);
      expect(csrfInput).not.toBeNull();
      expect(csrfInput[1]).toBe(csrfToken);
      expect(csrfInput[1]).not.toBe('');
      expect(form).toContain('<input type="hidden" name="search" value="hero">');
      expect(form).toContain('<input type="hidden" name="presence" value="present">');
      expect(form).toContain('<input type="hidden" name="sort" value="size">');
      expect(form).toContain('<input type="hidden" name="order" value="desc">');
      expect(form).toContain('<input type="hidden" name="pageSize" value="50">');

      const anchorAccessibleNames = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, content]) => (
        attributes.match(/\baria-label="([^"]*)"/)?.[1]
        || content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      ));
      expect(anchorAccessibleNames).not.toContain('Scan');
      expect(anchorAccessibleNames).not.toContain('Manually scan project files');
    });

    it('rejects a manual scan for a legacy status-only archived project without indexing files', async () => {
      const res = await createProject('Legacy Status Only Scan');
      const id = Number(res.headers.location.replace('/projects/', ''));
      fs.writeFileSync(path.join(getProjectDir('Legacy Status Only Scan'), 'must-not-scan.png'), 'png');
      db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(id);

      const scan = await agent
        .post(`/projects/${id}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      expect(scan.headers.location).toContain('scan_error=archived');
      expect(assetRepo.findByProjectId(id)).toEqual([]);
    });

    it('invokes the project scanner once, preserves canonical context, and renders its semantic summary', async () => {
      const res = await createProject('Scan Ctrl Behavior Unchanged');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Scan Ctrl Behavior Unchanged');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      const scanProjectAssets = vi.spyOn(app.locals.assetScanner, 'scanProjectAssets');

      const res2 = await agent.post(`/projects/${id}/scan`).type('form').send({
        _csrf: csrfToken,
        search: 'a',
        view: 'list',
      }).expect(302);
      expect(scanProjectAssets).toHaveBeenCalledOnce();
      expect(scanProjectAssets).toHaveBeenCalledWith(id);
      const redirectUrl = new URL(res2.headers.location, 'http://localhost');
      expect(redirectUrl.pathname).toBe(`/projects/${id}/assets`);
      expect(redirectUrl.searchParams.get('search')).toBe('a');
      expect(redirectUrl.searchParams.get('view')).toBe('list');
      expect(redirectUrl.searchParams.get('scan_result')).toBe('ok');
      expect(redirectUrl.searchParams.get('added')).toBe('1');
      expect(redirectUrl.searchParams.get('updated')).toBe('0');
      expect(redirectUrl.searchParams.get('missing')).toBe('0');
      expect(redirectUrl.searchParams.get('total')).toBe('1');
      const res3 = await agent.get(res2.headers.location).expect(200);
      expect(res3.text).toContain('Added: 1');
      expect(res3.text).toContain('Updated: 0');
      expect(res3.text).toContain('Missing: 0');
      expect(res3.text).toContain('1 total assets');
    });

    it('rejects missing CSRF and invalid project targets before scanning', async () => {
      const res = await createProject('Scan Route Safety');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const scanProjectAssets = vi.spyOn(app.locals.assetScanner, 'scanProjectAssets');

      await agent.post(`/projects/${id}/scan`).expect(403);
      await agent.post('/projects/not-an-id/scan').send('_csrf=' + encodeURIComponent(csrfToken)).expect(404);
      await agent.post('/projects/999999/scan').send('_csrf=' + encodeURIComponent(csrfToken)).expect(404);

      expect(scanProjectAssets).not.toHaveBeenCalled();
    });

    it('redirects scanner failures to a safe contextual notice without leaking the error', async () => {
      const res = await createProject('Scan Failure Notice');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const privateFailure = `cannot read ${projectsRoot}\\private-source.png`;
      vi.spyOn(app.locals.assetScanner, 'scanProjectAssets').mockImplementation(() => {
        throw new Error(privateFailure);
      });

      const failed = await agent.post(`/projects/${id}/scan`).type('form').send({
        _csrf: csrfToken,
        search: 'private',
      }).expect(302);
      const redirectUrl = new URL(failed.headers.location, 'http://localhost');
      expect(redirectUrl.pathname).toBe(`/projects/${id}/assets`);
      expect(redirectUrl.searchParams.get('search')).toBe('private');
      expect(redirectUrl.searchParams.get('scan_error')).toBe('filesystem');
      expect(redirectUrl.searchParams.has('scan_result')).toBe(false);

      const rendered = await agent.get(failed.headers.location).expect(200);
      expect(rendered.text).toContain('Scan failed. The project directory may be missing or inaccessible.');
      expect(rendered.text).not.toContain('Scan complete');
      expect(rendered.text).not.toContain(privateFailure);
      expect(rendered.text).not.toContain(projectsRoot);
    });
  });

  // ─── 404 handling ───────────────────────────────────────────────

  it('returns 404 for missing project', async () => {
    await agent.get('/projects/99999/assets').expect(404);
  });

  it('returns 404 for invalid project id', async () => {
    await agent.get('/projects/abc/assets').expect(404);
  });

  it('404 response does not contain stack traces', async () => {
    const res = await agent.get('/projects/99999/assets').expect(404);
    expect(res.text).not.toContain('at ');
    expect(res.text).not.toContain('Error:');
  });

  // ─── Archived project ───────────────────────────────────────────

  it('archived project assets page remains readable', async () => {
    const res = await createProject('Archivable Project');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Archivable Project');

    fs.writeFileSync(path.join(projectDir, 'archivable.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Archive the project
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Assets page should still render
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('archivable.png');
    expect(res2.text).toContain('Assets — Archivable Project');
    expect(res2.text).toContain('archived');
    expect(res2.text).toContain('read-only');
  });

  // ─── Security / safety ─────────────────────────────────────────

  it('does not render absolute filesystem paths', async () => {
    const res = await createProject('No Path Leak');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('No Path Leak');

    fs.writeFileSync(path.join(projectDir, 'secret.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).not.toMatch(/[A-Z]:\\/);
    expect(res2.text).not.toMatch(/\/home\//);
    expect(res2.text).not.toMatch(/\/Users\//);
    // Only relative paths should appear
    expect(res2.text).toContain('secret.png');
  });

  it('spoofed scan_result in query string is not rendered', async () => {
    const res = await createProject('Spoof Scan Result');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Spoof Scan Result');

    fs.writeFileSync(path.join(projectDir, 'legit.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Six-digit value exceeds the \d{1,5} allowlist — must not be rendered.
    const res2 = await agent
      .get(`/projects/${id}/assets?scan_result=added=123456`)
      .expect(200);

    expect(res2.text).not.toContain('added=123456');
    expect(res2.text).not.toContain('123456');
  });

  it('spoofed scan_error in query string is not rendered as error', async () => {
    const res = await createProject('Spoof Scan Error');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent
      .get(`/projects/${id}/assets?scan_error=1`)
      .expect(200);

    // Without an actual scan error, this should not show the error message
    expect(res2.text).not.toContain('Scan failed');
  });

  // ─── Relative path and filename display ────────────────────────

  it('renders filename as the primary label and nested_path as secondary location while labeling selection by relative_path', async () => {
    const res = await createProject('Path Display');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Path Display');

    // Uncategorized asset under an unknown nested directory.
    fs.mkdirSync(path.join(projectDir, 'unknown', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'unknown', 'deep', 'file.txt'), 'x');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const asset = assetRepo.findByProjectIdAndPath(id, 'unknown/deep/file.txt');
    const card = assetListCardHtml(res2.text, asset.id);
    const title = card.match(/<h2 class="asset-list-card-title">([\s\S]*?)<\/h2>/)?.[1] || '';
    expect(card).not.toBe('');
    expect(title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).toBe('file');
    expect(title).not.toMatch(/<a\b/);
    expect(anchorHref(card, 'asset-details-link')).not.toBeNull();
    expect(card).toContain('unknown/deep');
    expect(res2.text).toContain('aria-label="Select unknown/deep/file.txt"');
  });

  it('shows "Project root" for an uncategorized asset at the project root', async () => {
    const res = await createProject('Root Location Display');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Root Location Display');

    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'x');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const asset = assetRepo.findByProjectIdAndPath(id, 'notes.txt');
    const card = assetListCardHtml(res2.text, asset.id);
    const title = card.match(/<h2 class="asset-list-card-title">([\s\S]*?)<\/h2>/)?.[1] || '';
    expect(card).not.toBe('');
    expect(title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).toBe('notes');
    expect(title).not.toMatch(/<a\b/);
    expect(anchorHref(card, 'asset-details-link')).not.toBeNull();
    expect(card).toContain('Project root');
    expect(card).toContain('Uncategorized');
  });

  // ─── Extension display ──────────────────────────────────────────

  it('renders a compact type label for each asset', async () => {
    const res = await createProject('Extension Display');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Extension Display');

    fs.writeFileSync(path.join(projectDir, 'image.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'doc.txt'), 'txt');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('PNG');
    expect(res2.text).toContain('TXT');
  });

  it('keeps View All as a Project Assets server query and preserves it into view navigation', async () => {
    const res = await createProject('WP4 Project Assets Page Sizes');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('WP4 Project Assets Page Sizes');
    const asset = writeIndexedAsset(id, projectDir, 'only.png', 'png');

    const all = await agent.get(`/projects/${id}/assets?pageSize=all`).expect(200);
    const allForm = all.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0] || '';
    const noScriptFallback = allForm.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] || '';
    expect(allForm).toContain(`<form class="page-size-form" method="get" action="/projects/${id}/assets">`);
    expect(allForm).toContain('<option value="all" selected>View All</option>');
    expect(noScriptFallback).toMatch(/<button\b(?=[^>]*\btype="submit")[^>]*>\s*Apply\s*<\/button>/);
    expect(all.text).toContain(`/projects/${id}/assets/${asset.id}?pageSize=all`);

    const listHref = all.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[\s\S]*?aria-label="List view"/)?.[1];
    expect(new URL(decodeHtmlHref(listHref), 'http://localhost').searchParams.get('pageSize')).toBe('all');
  });

  it('re-renders valid Project Assets multi selections when one member is invalid', async () => {
    const project = await createProject('Project Assets Defaults Multi Validation');
    const id = Number(project.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Project Assets Defaults Multi Validation');
    writeIndexedAsset(id, projectDir, 'available.jpg', 'jpg');
    writeIndexedAsset(id, projectDir, 'available.png', 'png');
    const firstTag = app.locals.tagService.createTag({ name: 'Project Assets defaults first tag' });
    const secondTag = app.locals.tagService.createTag({ name: 'Project Assets defaults second tag' });

    const response = await agent.post(`/projects/${id}/assets/defaults`).type('form').send({
      view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25',
      extension: ['jpg', 'unsupported'], tag: [String(firstTag.id), String(secondTag.id)],
      returnTo: `/projects/${id}/assets`, _csrf: csrfToken,
    }).expect(422);

    const dialog = response.text.match(/<dialog id="project-assets-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    const extensionSelect = dialog.match(/<select id="projectAssets-default-extension"[\s\S]*?<\/select>/)?.[0] || '';
    const tagSelect = dialog.match(/<select id="projectAssets-default-tag"[\s\S]*?<\/select>/)?.[0] || '';

    expect(extensionSelect).toContain(' multiple');
    expect(extensionSelect).toContain('<option value="jpg" selected>.jpg</option>');
    expect(extensionSelect).not.toContain('value="unsupported"');
    expect(tagSelect).toContain(`<option value="${firstTag.id}" selected>Project Assets defaults first tag</option>`);
    expect(tagSelect).toContain(`<option value="${secondTag.id}" selected>Project Assets defaults second tag</option>`);
    expect(dialog).toContain('id="projectAssets-default-extension-error"');
  });

  it('renders every Project Assets choice selector through the shared dropdown component', async () => {
    const res = await createProject('Project Assets Dropdown Audit');
    const id = res.headers.location.replace('/projects/', '');
    saveAssetDefault('view', 'list');
    saveAssetDefault('gridSize', 'large');
    saveAssetDefault('listSize', 'compact');
    saveAssetDefault('sort', 'category');
    saveAssetDefault('order', 'desc');
    saveAssetDefault('pageSize', '25');
    for (let index = 0; index < 26; index += 1) {
      assetRepo.upsert(Number(id), `asset-${index}.png`, {
        filename: `asset-${index}.png`,
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 1,
        modifiedAt: null,
      });
    }
    const response = await agent.get(`/projects/${id}/assets?defaults=1`).expect(200);

    expect(response.text).toContain('data-project-assets-grid-size-default="large"');
    expect(response.text).toContain('data-project-assets-list-size-default="compact"');
    const selectTags = [...response.text.matchAll(/<select\b[^>]*>/g)].map(([tag]) => tag);
    expect(selectTags.length).toBeGreaterThan(0);
    expect(selectTags.every((tag) => tag.includes('data-cc-dropdown-native-select'))).toBe(true);

    const pageSizeForm = response.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0] || '';
    expect(pageSizeForm).toContain('id="pageSize" name="pageSize"');
    expect(pageSizeForm).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(pageSizeForm).toContain('data-cc-dropdown-dispatch-native-change');
    expect(pageSizeForm).toContain('value="10"');
    expect(pageSizeForm).toContain('value="25" selected');
    expect(pageSizeForm).toContain('value="50"');
    expect(pageSizeForm).toContain('value="100"');
    expect(pageSizeForm).toContain('value="150"');
    expect(pageSizeForm).toContain('value="200"');
    expect(pageSizeForm).toContain('value="all"');
    expect(pageSizeForm).toContain('>View All</option>');

    const defaultsDialog = response.text.match(/<dialog id="project-assets-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(defaultsDialog).toContain('data-app-dialog');
    const defaultsGridMatch = defaultsDialog.match(
      /<div class="page-defaults-grid">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="app-dialog-status"/,
    );
    expect(defaultsGridMatch).not.toBeNull();
    const defaultsGrid = defaultsGridMatch?.[1] || '';
    const gridStart = defaultsGridMatch?.index ?? -1;
    const statusIndex = defaultsDialog.indexOf('<div class="app-dialog-status"', gridStart);
    expect((defaultsGrid.match(/data-dialog-field="/g) || [])).toHaveLength(8);
    expect(defaultsDialog.indexOf('data-dialog-error')).toBeLessThan(gridStart);
    expect(defaultsDialog.indexOf('name="_csrf"')).toBeLessThan(gridStart);
    expect(statusIndex).toBeGreaterThan(gridStart);
    expect(defaultsDialog.indexOf('<footer class="app-dialog-footer">')).toBe(-1);
    expect(defaultsGrid).not.toContain('data-dialog-error');
    expect(defaultsGrid).not.toContain('data-dialog-status');
    expect(defaultsGrid).not.toContain('app-dialog-footer');
    expect(defaultsGrid).not.toContain('name="_csrf"');
    const defaultFields = [
      {
        name: 'view',
        label: 'View',
        id: 'projectAssets-default-view',
        selected: 'list',
        options: [['grid', 'Grid'], ['list', 'List']],
      },
      {
        name: 'gridSize',
        label: 'Grid size',
        id: 'projectAssets-default-gridSize',
        selected: 'large',
        options: [['compact', 'Compact'], ['default', 'Default'], ['large', 'Large']],
      },
      {
        name: 'listSize',
        label: 'List size',
        id: 'projectAssets-default-listSize',
        selected: 'compact',
        options: [['compact', 'Compact'], ['large', 'Large']],
      },
      {
        name: 'sort',
        label: 'Sort',
        id: 'projectAssets-default-sort',
        selected: 'category',
        options: [
          ['filename', 'Filename'],
          ['modified', 'Modified date'],
          ['size', 'File size'],
          ['category', 'Category &amp; location'],
        ],
      },
      {
        name: 'order',
        label: 'Order',
        id: 'projectAssets-default-order',
        selected: 'desc',
        options: [['asc', 'Ascending'], ['desc', 'Descending']],
      },
      {
        name: 'pageSize',
        label: 'Page Size',
        id: 'projectAssets-default-pageSize',
        selected: '25',
        options: [
          ['10', '10 assets'],
          ['25', '25 assets'],
          ['50', '50 assets'],
          ['100', '100 assets'],
          ['150', '150 assets'],
          ['200', '200 assets'],
          ['all', 'View All'],
        ],
      },
      {
        name: 'extension',
        label: 'Extension',
        id: 'projectAssets-default-extension',
        multi: true,
        selectedValues: [],
        options: [['png', '.png']],
      },
      {
        name: 'tag',
        label: 'Tag',
        id: 'projectAssets-default-tag',
        multi: true,
        selectedValues: [],
        options: [],
      },
    ];
    for (const field of defaultFields) {
      expect(defaultsGrid).toMatch(new RegExp(`<select[^>]*name="${field.name}"[^>]*data-cc-dropdown-native-select`));
      expect(defaultsGrid).toContain(`data-dialog-field="${field.name}"`);
      expect(defaultsGrid).toContain(`<legend>${field.label}</legend>`);
      const nativeSelect = defaultsGrid.match(new RegExp(`<select id="${field.id}"[\\s\\S]*?<\\/select>`))?.[0] || '';
      expect(nativeSelect).not.toBe('');
      for (const [value, label] of field.options) {
        const selected = field.multi
          ? field.selectedValues.includes(value)
          : value === field.selected;
        expect(nativeSelect).toContain(`<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`);
      }
      expect(defaultsGrid).not.toMatch(new RegExp(`<input[^>]*name="${field.name}"`));
      expect((defaultsGrid.match(new RegExp(`name="${field.name}"`, 'g')) || []).length).toBe(1);

      if (field.multi) {
        expect(nativeSelect).toContain(' multiple');
        expect(nativeSelect).not.toContain('value="all"');
        expect(nativeSelect).not.toMatch(/<option[^>]*\sselected(?:[\s>])/);
        expect(defaultsGrid).toMatch(new RegExp(
          `id="${field.id}-dropdown"[^>]*data-cc-dropdown data-cc-dropdown-mode="multiple"`,
        ));
        continue;
      }

      expect(defaultsGrid).toMatch(new RegExp(
        `id="${field.id}-dropdown"[^>]*data-cc-dropdown data-cc-dropdown-mode="single"`,
      ));
      expect(defaultsGrid).toMatch(new RegExp(
        `<input[^>]*type="radio" value="${field.selected}"[^>]*checked`,
      ));
    }
    for (let index = 1; index < defaultFields.length; index += 1) {
      expect(defaultsGrid.indexOf(`data-dialog-field="${defaultFields[index - 1].name}"`))
        .toBeLessThan(defaultsGrid.indexOf(`data-dialog-field="${defaultFields[index].name}"`));
    }
    expect((defaultsGrid.match(/data-cc-dropdown data-cc-dropdown-mode="single"/g) || [])).toHaveLength(6);
    expect((defaultsGrid.match(/data-cc-dropdown data-cc-dropdown-mode="multiple"/g) || [])).toHaveLength(2);
    const defaultsFooter = defaultsDialog.match(/<footer class="app-dialog-footer">[\s\S]*?<\/footer>/)?.[0] || '';
    expect(defaultsFooter).toBe('');
    expect(defaultsDialog).not.toContain('>Save defaults</button>');
    expect(defaultsDialog).toContain('data-dialog-async="false"');
    expect(defaultsDialog).toContain('data-project-assets-defaults-autosave');
    expect((defaultsGrid.match(/data-autosubmit="fetch"/g) || [])).toHaveLength(8);
    expect(defaultsDialog).toContain('data-settings-fetch-save-status');

    const invalidDefaults = await agent
      .post(`/projects/${id}/assets/defaults`)
      .type('form')
      .send({
        view: 'list',
        gridSize: 'large',
        listSize: 'default',
        sort: 'category',
        order: 'desc',
        pageSize: '25',
        extension: 'all',
        tag: 'all',
        returnTo: `/projects/${id}/assets`,
        _csrf: csrfToken,
      })
      .expect(422);
    const invalidListSize = invalidDefaults.text.match(
      /<select id="projectAssets-default-listSize"[\s\S]*?<\/select>/,
    )?.[0] || '';
    const invalidDefaultsDialog = invalidDefaults.text.match(
      /<dialog id="project-assets-defaults-dialog"[\s\S]*?<\/dialog>/,
    )?.[0] || '';
    expect(invalidListSize).not.toContain('data-dialog-submitted-value');
    expect(invalidListSize).not.toContain('value="default"');
    expect((invalidDefaultsDialog.match(/data-autosubmit="fetch"/g) || [])).toHaveLength(8);
    expect(invalidDefaultsDialog).not.toContain('>Save defaults</button>');

    const speedSelect = response.text.match(/<select[^>]*data-slideshow-speed[^>]*>/)?.[0] || '';
    expect(speedSelect).toContain('data-cc-dropdown-native-select');
    expect(speedSelect).toContain('disabled');
    expect(response.text).toContain('id="slideshow-speed-dropdown" data-cc-dropdown');
    expect(response.text).toContain('<option value="2000">2 s</option>');
    expect(response.text).toContain('value="4000" selected');
    expect(response.text).toContain('<option value="6000">6 s</option>');
  });

  it('round-trips saved presentation values through filters, pagination, page size, view, and clear-filter links', async () => {
    saveAssetDefault('view', 'list');
    saveAssetDefault('sort', 'category');
    saveAssetDefault('order', 'desc');
    saveAssetDefault('pageSize', '50');

    const res = await createProject('Saved Assets Control Context');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Saved Assets Control Context');
    if (!projectDir) throw new Error('projectDir not found for Saved Assets Control Context');

    for (let i = 0; i < 35; i++) {
      fs.writeFileSync(path.join(projectDir, `filtered-${String(i).padStart(2, '0')}.png`), `c${i}`);
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const response = await agent
      .get(`/projects/${id}/assets?search=filtered&extension=.PNG&presence=present&usage=unused&pageSize=10`)
      .expect(200);

    expect(response.text).toContain('<ul class="asset-list asset-list--project" role="list" aria-label="Project assets" data-list-size="large">');
    expectCheckedAssetFilter(response.text, 'sort', 'category');
    expectCheckedAssetFilter(response.text, 'order', 'desc');
    expect(response.text).toContain('value="10" selected');
    expect(response.text).toContain('<input type="hidden" name="pageSize" value="10">');
    expect(response.text).toContain('<input type="hidden" name="view" value="list">');

    const nextMatch = response.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const nextUrl = new URL(decodeHtmlHref(nextMatch[1]), 'http://localhost');
    expect(nextUrl.searchParams.get('search')).toBe('filtered');
    expect(nextUrl.searchParams.get('extension')).toBe('png');
    expect(nextUrl.searchParams.get('presence')).toBe('present');
    expect(nextUrl.searchParams.get('usage')).toBe('unused');
    expect(nextUrl.searchParams.get('sort')).toBe('category');
    expect(nextUrl.searchParams.get('order')).toBe('desc');
    expect(nextUrl.searchParams.get('page')).toBe('2');
    expect(nextUrl.searchParams.get('pageSize')).toBe('10');
    expect(nextUrl.searchParams.get('view')).toBe('list');

    const pageSizeForm = response.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0];
    expect(pageSizeForm).toBeDefined();
    expect(pageSizeForm).toContain('<input type="hidden" name="sort" value="category">');
    expect(pageSizeForm).toContain('<input type="hidden" name="order" value="desc">');
    expect(pageSizeForm).toContain('<input type="hidden" name="view" value="list">');

    const gridHref = response.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[\s\S]*?aria-label="Grid view"/)?.[1];
    expect(gridHref).toBeDefined();
    const gridUrl = new URL(decodeHtmlHref(gridHref), 'http://localhost');
    expect(gridUrl.searchParams.get('view')).toBe('grid');
    expect(gridUrl.searchParams.get('sort')).toBe('category');
    expect(gridUrl.searchParams.get('order')).toBe('desc');
    expect(gridUrl.searchParams.get('pageSize')).toBe('10');

    const resetForm = response.text.match(/<form class="projects-filter-reset"[^>]*>/)?.[0] || '';
    const resetHref = resetForm.match(/\baction="([^"]+)"/)?.[1];
    expect(resetHref).toBeDefined();
    const resetUrl = new URL(decodeHtmlHref(resetHref), 'http://localhost');
    expect([...resetUrl.searchParams]).toEqual([['resetFilters', '1'], ['view', 'list']]);
    expect(resetUrl.searchParams.get('view')).toBe('list');
    expect(resetUrl.searchParams.has('search')).toBe(false);
    expect(resetUrl.searchParams.has('extension')).toBe(false);
    expect(resetUrl.searchParams.has('presence')).toBe(false);
    expect(resetUrl.searchParams.has('usage')).toBe(false);
  });

  // ─── Last seen and missing-since dates (viewer page) ───────────

  it('renders asset clocks from the request preference while retaining stored timestamps', async () => {
    const created = await createProject('Clock Display Assets');
    const id = Number(created.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Clock Display Assets');
    const modifiedAt = '2026-08-01T13:05:42.000Z';
    const asset = writeIndexedAsset(id, projectDir, 'clock.png', 'png', { modifiedAt });
    const legacyAsset = writeIndexedAsset(id, projectDir, 'legacy.png', 'png', {
      modifiedAt: '2026-08-02 13:05:42',
    });
    db.prepare('UPDATE assets SET last_seen_at = ?, missing_since = ? WHERE id = ?')
      .run('2026-08-01 13:05:42', '2026-08-01 13:05:42', asset.id);
    app.locals.clockFormatSettingsService.setClockFormat('12h');

    const library = await agent.get('/asset-viewer?view=list').redirects(2).expect(200);
    const projectAssets = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const viewer = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
    expect(library.text).toContain('2026-08-01T1:05:42.000 PM Z');
    expect(library.text).toContain('2026-08-02 1:05:42 PM');
    expect(projectAssets.text).toContain('2026-08-01T1:05:42.000 PM Z');
    expect(projectAssets.text).toContain('2026-08-02 1:05:42 PM');
    expect(viewer.text).toContain('<dt>Last seen</dt>');
    expect(viewer.text).toMatch(/<dt>Last seen<\/dt>\s*<dd>2026-08-01 1:05:42 PM<\/dd>/);
    expect(viewer.text).toMatch(/<dt>Missing since<\/dt>\s*<dd>2026-08-01 1:05:42 PM<\/dd>/);
    expect(viewer.text).toContain('2026-08-01T1:05:42.000 PM Z');
    expect(assetRepo.findById(asset.id)).toMatchObject({
      modified_at: modifiedAt,
      last_seen_at: '2026-08-01 13:05:42',
      missing_since: '2026-08-01 13:05:42',
    });
    expect(assetRepo.findById(legacyAsset.id).modified_at).toBe('2026-08-02 13:05:42');
  });

  it('shows last_seen_at for present assets on the viewer page', async () => {
    const res = await createProject('Last Seen');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Last Seen');

    fs.writeFileSync(path.join(projectDir, 'stable.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const asset = assetRepo.findByProjectId(id)[0];
    const res2 = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
    expect(res2.text).toContain('<dt>Last seen</dt>');
    expect(res2.text).toMatch(/<dt>Last seen<\/dt>\s*<dd>[^<]*\d{4}-\d{2}-\d{2}/);
  });

  it('shows missing_since for missing assets on the viewer page', async () => {
    const res = await createProject('Missing Since');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Missing Since');

    fs.writeFileSync(path.join(projectDir, 'was-there.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    fs.rmSync(path.join(projectDir, 'was-there.png'));
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const asset = assetRepo.findByProjectId(id)[0];
    const res2 = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
    expect(res2.text).toContain('<dt>Missing since</dt>');
    expect(res2.text).toMatch(/<dt>Missing since<\/dt>\s*<dd>[^<]*\d{4}-\d{2}-\d{2}/);
  });

  // ─── Phase 10.2C: Server-rendered asset viewer ───────────────────

  it('renders a successful previewable asset viewer with exact preview, back, and original URLs', async () => {
    const res = await createProject('Viewer Previewable');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Previewable');
    if (!projectDir) throw new Error('projectDir not found for Viewer Previewable');

    const png = await makePng(120, 90);
    const asset = writeIndexedAsset(id, projectDir, 'gallery/hero.png', png, {
      modifiedAt: '2026-07-15 10:20:30',
    });
    const releaseId = await createReleaseUsingAsset(id, asset.id, 'Hero Release', 'planned');
    const revision = buildAssetRevisionToken(asset);

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.headers['content-type']).toMatch(/html/);
    expectAnchorHref(res2.text, 'asset-viewer-project', `/projects/${id}`);
    expectAnchorHref(res2.text, 'asset-viewer-back', `/projects/${id}/assets`);
    const preview = previewSectionHtml(res2.text);
    expect(preview).toContain(`src="/projects/${id}/assets/${asset.id}/preview?v=${revision}"`);
    const originalHref = `/projects/${id}/assets/${asset.id}/original`;
    expectNoAnchor(res2.text, 'asset-viewer-original');
    expectAnchorHref(preview, 'asset-preview-link', originalHref);
    expect(res2.text).toMatch(/<dt>Filename<\/dt>\s*<dd><code>hero\.png<\/code><\/dd>/);
    expect(res2.text).toMatch(new RegExp(`<dt>Location</dt>\\s*<dd>/${slugify('Viewer Previewable', { lowercase: true })}/</dd>`));
    expect(res2.text).toContain('<code>png</code>');
    expect(res2.text).toContain('<code>image/png</code>');
    expect(res2.text).toMatch(/<dt>Width<\/dt>\s*<dd>120<\/dd>/);
    expect(res2.text).toMatch(/<dt>Height<\/dt>\s*<dd>90<\/dd>/);
    expect(res2.text).toContain(`${png.length} bytes`);
    expect(res2.text).toContain('2026-07-15 10:20:30');
    expect(res2.text).toContain('Present at last scan');
    expect(res2.text).toContain('Used by 1 release');
    expect(res2.text).toContain('Hero Release');
    expect(res2.text).toContain(`<a href="/releases/${releaseId}">Hero Release</a>`);
    expect(res2.text).not.toContain('()');
  });

  // ─── Defect fix: browser row links carry normalized/clamped context ────

  it('a browser row viewer link carries normalized context, strips unknown fields, and the viewer preserves it on Back', async () => {
    const res = await createProject('Row Link Context');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders-rowlink', displayOrder: 0, enabled: true,
    });
    assetRepo.upsert(id, 'renders/Hero One.png', {
      filename: 'Hero One.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });
    const heroTwo = assetRepo.upsert(id, 'renders/Hero Two.png', {
      filename: 'Hero Two.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });
    const heroThree = assetRepo.upsert(id, 'renders/Hero Three.png', {
      filename: 'Hero Three.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });

    const res2 = await agent
      .get(`/projects/${id}/assets?category=${category.id}&search=hero&extension=.PNG&presence=present&usage=unused&sort=filename&order=desc&pageSize=2&view=list&junk=strip-me`)
      .expect(200);

    // Non-default search/order values use the ordinary browser surface and
    // retain the normalized filter context on the card viewer target.
    const rowCard = assetListCardHtml(res2.text, heroTwo.id);
    const rowHref = anchorHref(rowCard, 'asset-details-link');
    expect(rowHref).not.toBeNull();
    const rowUrl = new URL(rowHref, 'http://localhost');

    expect(rowUrl.pathname).toBe(`/projects/${id}/assets/${heroTwo.id}`);
    expect(rowUrl.searchParams.get('category')).toBe(String(category.id));
    expect(rowUrl.searchParams.get('search')).toBe('hero');
    expect(rowUrl.searchParams.get('extension')).toBe('png');
    expect(rowUrl.searchParams.get('presence')).toBe('present');
    expect(rowUrl.searchParams.get('usage')).toBe('unused');
    expect(rowUrl.searchParams.get('order')).toBe('desc');
    expect(rowUrl.searchParams.get('pageSize')).toBe('2');
    expect(rowUrl.searchParams.has('sort')).toBe(false);
    expect(rowUrl.searchParams.get('view')).toBe('list');
    expect(rowUrl.searchParams.has('junk')).toBe(false);

    // Follow the card target into the viewer and confirm the full safe context is
    // preserved.
    const viewerRes = await agent.get(rowHref).expect(200);
    const expectedQuery = {
      category: String(category.id),
      search: 'hero',
      extension: 'png',
      presence: 'present',
      usage: 'unused',
      order: 'desc',
      pageSize: '2',
      view: 'list',
    };
    expectQueryKeys(rowHref, Object.keys(expectedQuery));

    const backHref = decodeHtmlHref(anchorHref(viewerRes.text, 'asset-viewer-back'));
    const backUrl = new URL(backHref, 'http://localhost');
    for (const [key, value] of Object.entries(expectedQuery)) {
      expect(backUrl.searchParams.get(key)).toBe(value);
    }

    expect(heroThree.id).toBeGreaterThan(heroTwo.id);
  });

  it('uses the clamped page for a browser row viewer link when the requested page is out of range', async () => {
    const res = await createProject('Row Link Clamped Page');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Row Link Clamped Page');
    const asset = writeIndexedAsset(id, projectDir, 'only.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?page=99&view=list`).expect(200);
    const rowHref = anchorHref(res2.text, 'asset-details-link');
    expect(rowHref).not.toBeNull();

    // Only one asset -> pageCount 1 -> clamped to page 1 -> 'page' is the
    // omitted default, never the out-of-range requested value.
    expect(rowHref).toBe(`/projects/${id}/assets/${asset.id}?view=list`);
  });

  it('renders exact previous, next, and back URLs across pages', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Cross Page');

    const res = await agent
      .get(`/projects/${id}/assets/${assets.bravo.id}?pageSize=1`)
      .expect(200);

    const previousHref = `/projects/${id}/assets/${assets.alpha.id}?pageSize=1`;
    const backHref = `/projects/${id}/assets?page=2&pageSize=1`;
    const nextHref = `/projects/${id}/assets/${assets.charlie.id}?page=3&pageSize=1`;
    expectAnchorHref(res.text, 'asset-preview-nav--previous', previousHref);
    expectAnchorHref(res.text, 'asset-viewer-back', backHref);
    expectAnchorHref(res.text, 'asset-preview-nav--next', nextHref);
    expectQueryKeys(previousHref, ['pageSize']);
    expectQueryKeys(backHref, ['page', 'pageSize']);
    expectQueryKeys(nextHref, ['page', 'pageSize']);
  });

  it('renders canonical navigation for a direct deep link without page', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Direct Link');

    const res = await agent
      .get(`/projects/${id}/assets/${assets.bravo.id}`)
      .expect(200);

    const previousHref = `/projects/${id}/assets/${assets.alpha.id}`;
    const backHref = `/projects/${id}/assets`;
    const nextHref = `/projects/${id}/assets/${assets.charlie.id}`;
    expectAnchorHref(res.text, 'asset-preview-nav--previous', previousHref);
    expectAnchorHref(res.text, 'asset-viewer-back', backHref);
    expectAnchorHref(res.text, 'asset-preview-nav--next', nextHref);
    expectQueryKeys(previousHref, []);
    expectQueryKeys(backHref, []);
    expectQueryKeys(nextHref, []);
  });

  it('omits previous on the first asset and next on the last asset', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Edge Links');

    const first = await agent
      .get(`/projects/${id}/assets/${assets.alpha.id}?pageSize=1`)
      .expect(200);
    expectNoAnchor(first.text, 'asset-preview-nav--previous');
    expectAnchorHref(first.text, 'asset-preview-nav--next', `/projects/${id}/assets/${assets.bravo.id}?page=2&pageSize=1`);

    const last = await agent
      .get(`/projects/${id}/assets/${assets.charlie.id}?pageSize=1`)
      .expect(200);
    expectNoAnchor(last.text, 'asset-preview-nav--next');
    expectAnchorHref(last.text, 'asset-preview-nav--previous', `/projects/${id}/assets/${assets.bravo.id}?page=2&pageSize=1`);
  });

  it('preserves normalized filters and ignores an incorrect supplied page in viewer links', async () => {
    const res = await createProject('Viewer Filter Preserve');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Filter Preserve');
    if (!projectDir) throw new Error('projectDir not found for Viewer Filter Preserve');
    const png = await makePng();
    const heroOne = writeIndexedAsset(id, projectDir, 'Hero & One.png', png);
    const heroTwo = writeIndexedAsset(id, projectDir, 'Hero & Two.png', png);
    writeIndexedAsset(id, projectDir, 'Other.jpg', png, { extension: 'jpg', mimeType: 'image/jpeg' });

    const res2 = await agent
      .get(`/projects/${id}/assets/${heroTwo.id}?view=grid&search=${encodeURIComponent('Hero &')}&extension=.PNG&presence=present&usage=unused&page=99&pageSize=1&junk=1`)
      .expect(200);

    // Grid is the canonical default, so it is omitted from generated viewer
    // navigation URLs while the other normalized filters are preserved.
    const previousHref = `/projects/${id}/assets/${heroOne.id}?search=Hero+%26&extension=png&presence=present&usage=unused&pageSize=1`;
    const backHref = `/projects/${id}/assets?search=Hero+%26&extension=png&presence=present&usage=unused&page=2&pageSize=1`;
    expectAnchorHref(res2.text, 'asset-preview-nav--previous', previousHref);
    expectAnchorHref(res2.text, 'asset-viewer-back', backHref);
    expectNoAnchor(res2.text, 'asset-preview-nav--next');
    expectQueryKeys(previousHref, ['search', 'extension', 'presence', 'usage', 'pageSize']);
    expectQueryKeys(backHref, ['search', 'extension', 'presence', 'usage', 'page', 'pageSize']);
    expect(res2.text).not.toContain('junk=1');
  });

  it('renders a filtered-out current asset without previous or next links', async () => {
    const res = await createProject('Viewer Filtered Out');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Filtered Out');
    if (!projectDir) throw new Error('projectDir not found for Viewer Filtered Out');
    const png = await makePng();
    writeIndexedAsset(id, projectDir, 'Hero & One.png', png);
    const other = writeIndexedAsset(id, projectDir, 'Other.jpg', png, { extension: 'jpg', mimeType: 'image/jpeg' });

    const res2 = await agent
      .get(`/projects/${id}/assets/${other.id}?search=${encodeURIComponent('Hero &')}&page=3&pageSize=1`)
      .expect(200);

    const backHref = `/projects/${id}/assets?search=Hero+%26&pageSize=1`;
    expect(res2.text).toContain('This asset is outside the current asset-browser filters');
    expectNoAnchor(res2.text, 'asset-preview-nav--previous');
    expectNoAnchor(res2.text, 'asset-preview-nav--next');
    expectAnchorHref(res2.text, 'asset-viewer-back', backHref);
    expectQueryKeys(backHref, ['search', 'pageSize']);
  });

  it('renders missing assets without broken preview or original links', async () => {
    const res = await createProject('Viewer Missing');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Missing');
    if (!projectDir) throw new Error('projectDir not found for Viewer Missing');
    const asset = writeIndexedAsset(id, projectDir, 'gone.png', await makePng());
    const nextAsset = writeIndexedAsset(id, projectDir, 'next.png', await makePng());
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['next.png']);

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('Missing at last scan. Preview and original viewing are unavailable.');
    expect(res2.text).toContain('Preview unavailable for missing assets.');
    expect(previewSectionHtml(res2.text)).not.toContain('<img ');
    expect(res2.text).not.toContain('/preview?v=');
    expectNoAnchor(res2.text, 'asset-viewer-original');
    expectAnchorHref(res2.text, 'asset-preview-nav--next', `/projects/${id}/assets/${nextAsset.id}`);
  });

  it('renders MIME-mismatched Krita assets without preview or original links', async () => {
    const res = await createProject('Viewer Unsupported');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Unsupported');
    if (!projectDir) throw new Error('projectDir not found for Viewer Unsupported');
    const asset = writeIndexedAsset(id, projectDir, 'source.kra', 'krita bytes', {
      extension: 'kra',
      mimeType: 'image/png',
    });

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('Unsupported asset preview. This asset type or recorded MIME cannot be previewed inline.');
    expect(res2.text).toContain('Preview unavailable for unsupported assets.');
    expect(previewSectionHtml(res2.text)).not.toContain('<img ');
    expect(res2.text).not.toContain('/preview?v=');
    expectNoAnchor(res2.text, 'asset-viewer-original');
  });

  it('renders MIME mismatches without preview or original links', async () => {
    const res = await createProject('Viewer MIME Mismatch');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer MIME Mismatch');
    if (!projectDir) throw new Error('projectDir not found for Viewer MIME Mismatch');
    const asset = writeIndexedAsset(id, projectDir, 'mismatch.png', await makePng(), {
      mimeType: 'image/jpeg',
    });

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('Unsupported asset preview. This asset type or recorded MIME cannot be previewed inline.');
    expect(previewSectionHtml(res2.text)).not.toContain('<img ');
    expect(res2.text).not.toContain('/preview?v=');
    expectNoAnchor(res2.text, 'asset-viewer-original');
  });

  it('renders asset viewers for archived projects', async () => {
    const res = await createProject('Viewer Archived');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Archived');
    if (!projectDir) throw new Error('projectDir not found for Viewer Archived');
    const asset = writeIndexedAsset(id, projectDir, 'archived.png', await makePng());

    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expectAnchorHref(res2.text, 'asset-viewer-project', `/projects/${id}`);
    expectAnchorHref(res2.text, 'asset-viewer-back', `/projects/${id}/assets`);
    expectNoAnchor(res2.text, 'asset-viewer-edit');
  });

  it('rejects malformed viewer project and asset IDs', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Malformed IDs');

    await agent.get(`/projects/abc/assets/${assets.alpha.id}`).expect(404);
    await agent.get(`/projects/0/assets/${assets.alpha.id}`).expect(404);
    await agent.get(`/projects/${id}/assets/abc`).expect(404);
    await agent.get(`/projects/${id}/assets/0`).expect(404);
    await agent.get(`/projects/${id}/assets/1.5`).expect(404);
  });

  it('returns 404 for unknown and cross-project viewer assets', async () => {
    const owner = await setupOrderedImageAssets('Viewer Owner');
    const other = await setupOrderedImageAssets('Viewer Other');

    await agent.get(`/projects/${owner.id}/assets/999999`).expect(404);
    await agent.get(`/projects/${other.id}/assets/${owner.assets.alpha.id}`).expect(404);
  });

  it('does not render absolute paths or original bytes in viewer HTML', async () => {
    const res = await createProject('Viewer No Leaks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer No Leaks');
    if (!projectDir) throw new Error('projectDir not found for Viewer No Leaks');
    const secret = 'SECRET_ORIGINAL_BYTES_SHOULD_NOT_RENDER';
    const asset = writeIndexedAsset(id, projectDir, 'private/blob.bin', secret, {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toMatch(/<dt>Filename<\/dt>\s*<dd><code>blob\.bin<\/code><\/dd>/);
    expect(res2.text).toMatch(new RegExp(`<dt>Location</dt>\\s*<dd>/${slugify('Viewer No Leaks', { lowercase: true })}/</dd>`));
    expect(res2.text).not.toContain(secret);
    expect(res2.text).not.toContain(tmpDir);
    expect(res2.text).not.toContain(projectsRoot);
    expect(res2.text).not.toMatch(/[A-Z]:\\/);
    expect(res2.text).not.toContain('/Users/');
    expect(res2.text).not.toContain('/home/');

    const unsafe = assetRepo.upsert(id, 'private/unsafe<&>.bin', {
      filename: 'unsafe<&>.bin', extension: 'bin', mimeType: 'application/octet-stream', sizeBytes: 10, modifiedAt: null,
    });
    const unsafePage = await agent.get(`/projects/${id}/assets/${unsafe.id}`).expect(200);
    expect(unsafePage.text).toContain('<code>unsafe&lt;&amp;&gt;.bin</code>');
    expect(unsafePage.text).not.toContain('<code>unsafe<&>.bin</code>');
  });

  // ─── Open locally action on the asset viewer ─────────────────────────
  //
  // The viewer renders a custom-protocol link built from the shared URI
  // builder. The href is Nunjucks-escaped (autoescape), so ampersands appear
  // as &amp; in the markup; browsers decode them when following the link.
  // The action must never leak the container root or an absolute path.

  describe('open locally action on the asset viewer', () => {
    function configureWindowsRoot() {
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('open_locally.windows_projects_path', 'D:\\example');
    }

    it('uses the creatorcrate-open scheme with the encoded absolute path and select=1', async () => {
      const res = await createProject('Viewer Open Locally Href');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Viewer Open Locally Href');
      if (!projectDir) throw new Error('projectDir not found for Viewer Open Locally Href');
      const asset = writeIndexedAsset(id, projectDir, 'gallery/hero.png', await makePng());
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();

      const res2 = await agent
        .get(`/projects/${id}/assets/${asset.id}`)
        .expect(200);

      const href = anchorHref(res2.text, 'asset-viewer-open-locally');
      expect(href).toMatch(/^creatorcrate-open:\/\/open\?v=2/);
      expect(href).toContain(`path=${encodeURIComponent(`D:\\example\\${row.project_dir}\\gallery/hero.png`)}`);
      expect(href).toContain('select=1');
      expect(href).not.toContain('mapping=');
      expect(href).not.toContain('/data/projects');
      expect(href).not.toContain(projectsRoot);
      expect(href).not.toMatch(/[A-Z]:\\/);
    });

    it('omits the action when no windows root is configured', async () => {
      const res = await createProject('Viewer Open Locally No Root Configured');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Viewer Open Locally No Root Configured');
      if (!projectDir) throw new Error('projectDir not found for Viewer Open Locally No Root Configured');
      const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());

      const res2 = await agent
        .get(`/projects/${id}/assets/${asset.id}`)
        .expect(200);

      expectNoAnchor(res2.text, 'asset-viewer-open-locally');
    });

    it('omits the action when the project directory is missing', async () => {
      const res = await createProject('Viewer Open Locally Missing Dir');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Viewer Open Locally Missing Dir');
      if (!projectDir) throw new Error('projectDir not found for Viewer Open Locally Missing Dir');
      const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(id);
      configureWindowsRoot();

      const res2 = await agent
        .get(`/projects/${id}/assets/${asset.id}`)
        .expect(200);

      expectNoAnchor(res2.text, 'asset-viewer-open-locally');
    });

    it('omits the action when the asset relative path is invalid', async () => {
      const res = await createProject('Viewer Open Locally Invalid Path');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Viewer Open Locally Invalid Path');
      if (!projectDir) throw new Error('projectDir not found for Viewer Open Locally Invalid Path');
      const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());
      db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?').run('../escape.png', asset.id);
      configureWindowsRoot();

      const res2 = await agent
        .get(`/projects/${id}/assets/${asset.id}`)
        .expect(200);

      expectNoAnchor(res2.text, 'asset-viewer-open-locally');
    });
  });

  // ─── Project Assets display actions ────────────────────────────────
  //
  // The display controls render Filter immediately before Project Assets
  // defaults, followed by Open locally. Open locally keeps the category-aware URI from
  // the assets page model; its href is Nunjucks-escaped (autoescape), so
  // ampersands appear as &amp; in the markup. The action must never leak the
  // container root or an absolute path.

  describe('Project Assets display actions', () => {
    function configureWindowsRoot() {
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('open_locally.windows_projects_path', 'D:\\example');
    }

    function extractPageHeadingActions(html) {
      return html.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    }

    async function createAssetsProject(title) {
      const res = await createProject(title);
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir(title);
      if (!projectDir) throw new Error(`projectDir not found for ${title}`);
      return { id, projectDir };
    }

    it('orders accessible heading actions and keeps display Filter, defaults, Open locally, and NSFW adjacent', async () => {
      const { id, projectDir } = await createAssetsProject('Assets Open Locally');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();
      const missingPath = path.join(projectDir, 'missing-heading-action.png');
      fs.writeFileSync(missingPath, await makePng());
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      fs.rmSync(missingPath);
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent
        .get(`/projects/${id}/assets`)
        .expect(200);

      const actions = projectAssetsDisplayActions(res.text);
      const headingActions = extractPageHeadingActions(res.text);
      const openLocallyIndex = actions.indexOf('aria-label="Open locally"');
      const filterIndex = actions.indexOf('aria-label="Filter assets"');
      const defaultsIndex = actions.indexOf('aria-label="Project Assets defaults"');
      const nsfwIndex = actions.indexOf('id="project-assets-nsfw-toggle"');
      const scanIndex = headingActions.indexOf('aria-label="Manually scan project files"');
      const removeMissingIndex = headingActions.indexOf('aria-label="Remove missing assets"');
      const editIndex = headingActions.indexOf('aria-label="Edit project"');

      expect(headingActions).toContain(`href="/projects/${id}/edit"`);
      expect(actions).toContain('creatorcrate-open://');
      expect(actions).toContain(
        `href="creatorcrate-open://open?v=2&amp;path=${encodeURIComponent(`D:\\example\\${row.project_dir}`)}&amp;select=0"`
      );
      expect(filterIndex).toBeGreaterThanOrEqual(0);
      expect(defaultsIndex).toBeGreaterThan(filterIndex);
      expect(openLocallyIndex).toBeGreaterThan(defaultsIndex);
      expect(nsfwIndex).toBeGreaterThan(openLocallyIndex);
      expect(actions).toMatch(/aria-label="Filter assets"[\s\S]*?<\/a>\s*<a class="asset-viewer-defaults-link/);
      expect(actions).toMatch(/aria-label="Project Assets defaults"[\s\S]*?<\/a>\s*<a class="button button-small button-secondary project-filter-control[^"]*"\s*href="creatorcrate-open:/);
      expect(scanIndex).toBeGreaterThanOrEqual(0);
      expect(removeMissingIndex).toBeGreaterThan(scanIndex);
      expect(editIndex).toBeGreaterThan(removeMissingIndex);
      const scanForm = headingActions.match(new RegExp(`<form method="post" action="/projects/${id}/scan" class="inline-form">[\\s\\S]*?<\\/form>`))?.[0] || '';
      expect(scanForm).toContain('name="_csrf"');
      expect(scanForm).toContain('type="submit" aria-label="Manually scan project files" data-tooltip="Manually scan project files"');
      expect(scanForm).toContain('<path d="M4 10a8 8 0 1 1 2.3 5.7"/>');
      expect(scanForm.replace(/<[^>]+>/g, '').trim()).toBe('');
      const removeMissingAction = headingActions.match(/<a\b(?=[^>]*aria-label="Remove missing assets")[^>]*>[\s\S]*?<\/a>/)?.[0] || '';
      expect(removeMissingAction).toContain(`href="/projects/${id}/assets?remove_missing=1"`);
      expect(removeMissingAction).toContain('data-dialog-open="remove-missing-assets-dialog"');
      expect(removeMissingAction).toContain('data-tooltip="Remove missing assets"');
      expect(removeMissingAction).toContain('button-danger');
      expect(removeMissingAction).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
      expect(removeMissingAction).toContain('<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>');
      expect(removeMissingAction.replace(/<[^>]+>/g, '').trim()).toBe('');
      const removeMissingDialog = res.text.match(/<dialog id="remove-missing-assets-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(removeMissingDialog).toContain(`<form id="remove-missing-assets-form" method="post" action="/projects/${id}/assets/remove-missing"`);
      expect(removeMissingDialog).toContain(`<input type="hidden" name="_csrf" value="${csrfToken}">`);
      expect(removeMissingDialog).toContain(`<input type="hidden" name="returnTo" value="/projects/${id}/assets">`);
      expect(removeMissingDialog).toContain('<button class="button button-danger" type="submit" data-dialog-submit>Remove missing assets</button>');
      expect(headingActions).not.toContain('Open locally');
      const style = await readStylesheetSource(res.text);
      const headingGroupRule = style.match(/(?:^|})\s*\.page-heading:has\(\.project-assets-heading-action\) \.page-heading-actions\s*\{([^}]*)\}/)?.[1] || '';
      expect(headingGroupRule).toMatch(/justify-content:\s*flex-end/);
      expect(headingGroupRule).toMatch(/gap:\s*var\(--space-sm\)/);
      expect(projectDir).toBeTruthy();
    });

    it('uses project-folder semantics with select=0 and never an asset path', async () => {
      const { id } = await createAssetsProject('Assets Open Locally Href');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();

      const res = await agent
        .get(`/projects/${id}/assets`)
        .expect(200);

      const actions = projectAssetsDisplayActions(res.text);
      const href = actions.match(/href="(creatorcrate-open:[^"]+)"/)?.[1] || '';

      expect(href).toMatch(/^creatorcrate-open:\/\/open\?v=2/);
      expect(href).toContain(`path=${encodeURIComponent(`D:\\example\\${row.project_dir}`)}`);
      expect(href).toContain('select=0');
      expect(href).not.toContain('select=1');
      expect(href).not.toContain('mapping=');
      expect(href).not.toContain('/data/projects');
      expect(href).not.toContain(projectsRoot);
    });

    it('targets the category folder with select=0 when filtered to one category', async () => {
      const { id } = await createAssetsProject('Assets Open Locally Category');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      const category = assetCategoryRepo.listProjectCategories(id)[0];
      if (!category) throw new Error('project has no category');
      configureWindowsRoot();

      const res = await agent
        .get(`/projects/${id}/assets?category=${category.id}`)
        .expect(200);

      const href = projectAssetsDisplayActions(res.text).match(/href="(creatorcrate-open:[^"]+)"/)?.[1] || '';
      expect(href).toContain(
        `path=${encodeURIComponent(`D:\\example\\${row.project_dir}\\${category.directory_slug}`)}`
      );
      expect(href).toContain('select=0');
      expect(href).not.toContain('select=1');
    });

    it('targets the project folder (not a category) when the filter is All', async () => {
      const { id } = await createAssetsProject('Assets Open Locally All');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();

      const res = await agent
        .get(`/projects/${id}/assets?category=all`)
        .expect(200);

      const href = projectAssetsDisplayActions(res.text).match(/href="(creatorcrate-open:[^"]+)"/)?.[1] || '';
      expect(href).toContain(`path=${encodeURIComponent(`D:\\example\\${row.project_dir}`)}&amp;select=0`);
    });

    it('omits Open locally when no windows root is configured', async () => {
      const { id } = await createAssetsProject('Assets Open Locally No Root');

      const res = await agent
        .get(`/projects/${id}/assets`)
        .expect(200);

      expect(projectAssetsDisplayActions(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });

    it('omits Open locally when project_dir is missing', async () => {
      const { id } = await createAssetsProject('Assets Open Locally Missing Dir');
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(id);
      configureWindowsRoot();

      const res = await agent
        .get(`/projects/${id}/assets`)
        .expect(200);

      expect(projectAssetsDisplayActions(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });

    it('omits Open locally when project_dir is invalid', async () => {
      const { id } = await createAssetsProject('Assets Open Locally Invalid Dir');
      db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run('../escape', id);
      configureWindowsRoot();

      const res = await agent
        .get(`/projects/${id}/assets`)
        .expect(200);

      expect(projectAssetsDisplayActions(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });

    it('keeps Open locally but omits Edit project for archived projects', async () => {
      const { id } = await createAssetsProject('Archived Assets Open Locally');
      configureWindowsRoot();
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(id);

      const res = await agent
        .get(`/projects/${id}/assets`)
        .expect(200);

      const actions = projectAssetsDisplayActions(res.text);
      expect(actions).not.toContain('aria-label="Edit project"');
      expect(actions).toContain('aria-label="Open locally"');
      expect(extractPageHeadingActions(res.text)).not.toContain('Open locally');
    });
  });

  it('forwards unexpected viewer service errors to the global 500 handler', async () => {
    const throwingApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      {
        workflowQueryService: {
          getDashboardData: () => ({}),
          getProjectWorkspace: () => null,
          getProjectAssetBrowser: () => null,
          getProjectAssetViewer: () => { throw new Error('viewer service exploded'); },
          getReleaseList: () => ({}),
          getReleaseBoard: () => ({}),
        },
      }
    );

    const res = await request(throwingApp)
      .get('/projects/1/assets/1')
      .expect(500);

    expect(res.text).toContain('Something went wrong.');
    expect(res.text).not.toContain('viewer service exploded');
  });

  it('keeps media, viewer, and asset-browser route precedence distinct', async () => {
    const res = await createProject('Viewer Route Precedence');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Route Precedence');
    if (!projectDir) throw new Error('projectDir not found for Viewer Route Precedence');
    const png = await makePng(96, 64);
    const asset = writeIndexedAsset(id, projectDir, 'media.png', png);

    const thumbnail = await agent
      .get(`/projects/${id}/assets/${asset.id}/thumbnail`)
      .expect(200);
    expect(thumbnail.headers['content-type']).toBe('image/webp');

    const preview = await agent
      .get(`/projects/${id}/assets/${asset.id}/preview`)
      .expect(200);
    expect(preview.headers['content-type']).toBe('image/webp');

    const original = await agent
      .get(`/projects/${id}/assets/${asset.id}/original`)
      .expect(200);
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.body.equals(png)).toBe(true);

    const viewer = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expect(viewer.headers['content-type']).toMatch(/html/);
    expect(viewer.text).toContain('<h1 class="app-section-title">Assets — Viewer Route Precedence — media.png</h1>');

    const browser = await agent
      .get(`/projects/${id}/assets`)
      .expect(200);
    expect(browser.headers['content-type']).toMatch(/html/);
  });

  it('renders the mutable edit action with the current viewer context', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Accessibility');

    const res = await agent
      .get(`/projects/${id}/assets/${assets.bravo.id}?pageSize=1`)
      .expect(200);

    const editHref = anchorHref(res.text, 'asset-viewer-edit');
    const editUrl = new URL(editHref, 'http://localhost');
    expect(editUrl.pathname).toBe(`/projects/${id}/assets/${assets.bravo.id}`);
    expect(editUrl.searchParams.get('pageSize')).toBe('1');
    expect(editUrl.searchParams.get('edit')).toBe('1');
    expect(anchorMatch(res.text, 'asset-viewer-edit')?.[0]).toContain('data-dialog-open="asset-edit-dialog"');
  });

  it('renders viewer Metadata locations from persisted project and category directory slugs', async () => {
    const res = await createProject('Viewer Metadata Location');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Metadata Location');
    if (!projectDir) throw new Error('projectDir not found for Viewer Metadata Location');
    const project = db.prepare('SELECT slug FROM projects WHERE id = ?').get(id);
    const enabledCategory = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Final renders', directorySlug: 'persisted-final', displayOrder: 0, enabled: true,
    });
    const disabledCategory = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Legacy archive', directorySlug: 'persisted-disabled', displayOrder: 1, enabled: false,
    });
    const categorized = writeIndexedAsset(id, projectDir, 'deep/render.png', 'render');
    const disabled = writeIndexedAsset(id, projectDir, 'legacy.png', 'legacy');
    const missing = assetRepo.upsert(id, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    const root = writeIndexedAsset(id, projectDir, 'root.png', 'root');
    db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(enabledCategory.id, categorized.id);
    db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(disabledCategory.id, disabled.id);
    db.prepare('UPDATE assets SET category_id = ?, is_present = 0 WHERE id = ?').run(enabledCategory.id, missing.id);

    const pageFor = async (asset) => {
      const page = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
      return page.text;
    };

    const categorizedPage = await pageFor(categorized);
    const disabledPage = await pageFor(disabled);
    const missingPage = await pageFor(missing);
    const rootPage = await pageFor(root);
    expect(categorizedPage).toMatch(new RegExp(`<dt>Location</dt>\\s*<dd>/${project.slug}/persisted-final/</dd>`));
    expect(categorizedPage).toMatch(/<dt>Category<\/dt>\s*<dd>\s*Final renders/);
    expect(disabledPage).toMatch(new RegExp(`<dt>Location</dt>\\s*<dd>/${project.slug}/persisted-disabled/</dd>`));
    expect(disabledPage).toMatch(/<dt>Category<\/dt>\s*<dd>\s*Legacy archive/);
    expect(missingPage).toMatch(new RegExp(`<dt>Location</dt>\\s*<dd>/${project.slug}/persisted-final/</dd>`));
    expect(rootPage).toMatch(new RegExp(`<dt>Location</dt>\\s*<dd>/${project.slug}/</dd>`));
  });


  it('renders ComfyUI workflow inspection states and escapes workflow data', async () => {
    const projectResponse = await createProject('Viewer Workflow Inspection');
    const projectId = Number(projectResponse.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Workflow Inspection');
    if (!projectDir) throw new Error('projectDir not found for Viewer Workflow Inspection');
    const detected = writeIndexedAsset(projectId, projectDir, 'detected.png', await makePng());
    const none = writeIndexedAsset(projectId, projectDir, 'plain.txt', 'plain asset');
    const failure = writeIndexedAsset(projectId, projectDir, 'failure.png', await makePng());
    const workflowApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      {
        assetWorkflowMetadataService: {
          getWorkflowMetadata(assetId) {
            if (assetId === detected.id) {
              return {
                metadataKey: 'workflow',
                workflow: {
                  prompt: '<script>alert(1)</script>',
                  lora: '<lora:Mayoko\\max\\model.safetensors:0.8>',
                  modelPath: 'C:\\models\\style.safetensors',
                  seed: 42,
                  enabled: true,
                  optional: null,
                },
              };
            }
            if (assetId === failure.id) throw new Error('storage inspection secret');
            return null;
          },
        },
      }
    );
    const workflowAgent = request(workflowApp);

    const detectedPage = await workflowAgent.get(`/projects/${projectId}/assets/${detected.id}`).expect(200);
    expect(detectedPage.text).toContain('>ComfyUI Workflow</h4>');
    expect(detectedPage.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(detectedPage.text).not.toContain('<script>alert(1)</script>');
    expect(detectedPage.text).toContain('&quot;&lt;lora:Mayoko&#92;max&#92;model.safetensors:0.8&gt;&quot;');
    expect(detectedPage.text).toContain('&quot;C:&#92;models&#92;style.safetensors&quot;');

    const nonePage = await workflowAgent.get(`/projects/${projectId}/assets/${none.id}`).expect(200);
    expect(nonePage.text).toContain('No ComfyUI workflow was detected for this asset.');

    const failurePage = await workflowAgent.get(`/projects/${projectId}/assets/${failure.id}`).expect(200);
    expect(failurePage.text).toContain('ComfyUI workflow metadata could not be inspected.');
    expect(failurePage.text).not.toContain('No ComfyUI workflow was detected for this asset.');
    expect(failurePage.text).not.toContain('storage inspection secret');
  });

  it('renders validated A1111 parameters metadata through the asset viewer and preserves native precedence', async () => {
    const projectResponse = await createProject('Viewer A1111 Parameters');
    const projectId = Number(projectResponse.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer A1111 Parameters');
    if (!projectDir) throw new Error('projectDir not found for Viewer A1111 Parameters');
    const parameters = a1111ParametersMetadata();
    const a1111 = writeIndexedAsset(projectId, projectDir, 'a1111-parameters.png', await makePngWithMetadata([
      uncompressedITextChunk('parameters', parameters),
    ]));
    const native = writeIndexedAsset(projectId, projectDir, 'native-wins.png', await makePngWithMetadata([
      textChunk('workflow', JSON.stringify({
        '1': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0], seed: 7 } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'native positive workflow wins' } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'native negative workflow wins' } },
      })),
      uncompressedITextChunk('parameters', parameters),
    ]));
    const noWorkflow = writeIndexedAsset(projectId, projectDir, 'no-workflow.png', await makePng());

    const a1111Page = await agent.get(`/projects/${projectId}/assets/${a1111.id}`).expect(200);
    expect(a1111Page.text).toContain('>ComfyUI Workflow</h4>');
    expect(a1111Page.text).not.toContain('No ComfyUI workflow was detected for this asset.');
    expect(a1111Page.text).toContain('&quot;positive_prompt&quot;');
    expect(a1111Page.text).toContain('&quot;seed&quot;');
    expect(a1111Page.text).toContain('cinematic portrait');
    expect(a1111Page.text).toContain('&lt;lora:portrait-style:0.8&gt;');
    expect(a1111Page.text).not.toContain('<lora:portrait-style:0.8>');
    expect(a1111Page.text).toContain('944442803');

    const nativePage = await agent.get(`/projects/${projectId}/assets/${native.id}`).expect(200);
    expect(nativePage.text).toContain('native positive workflow wins');
    expect(nativePage.text).not.toContain('cinematic portrait');
    expect(nativePage.text).not.toContain('&quot;source&quot;');

    const noWorkflowPage = await agent.get(`/projects/${projectId}/assets/${noWorkflow.id}`).expect(200);
    expect(noWorkflowPage.text).toContain('No ComfyUI workflow was detected for this asset.');
  });

  // ─── Phase 15.2: category-aware compact file browser ────────────────

  it('renders and serves the static client entry point', async () => {
    const res = await createProject('PhaseC Script');
    const id = res.headers.location.replace('/projects/', '');

    const page = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const script = await agent.get('/creatorcrate.js').expect(200);

    expect(page.text).toContain('<script type="module" src="/creatorcrate.js"></script>');
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.text.length).toBeGreaterThan(0);
  });

  it('renders viewer preview hooks, fallback, and original link independently', async () => {
    const res = await createProject('PhaseC Viewer Hooks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC Viewer Hooks');
    const asset = writeIndexedAsset(id, projectDir, 'viewer.png', await makePng());

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('class="asset-preview-frame" data-preview-enhancement data-preview-state="loading"');
    expect(res2.text).toContain('data-preview-image');
    expect(res2.text).toContain('class="asset-preview-placeholder asset-preview-fallback" data-preview-fallback hidden>Preview unavailable</p>');
    expectNoAnchor(res2.text, 'asset-viewer-original');
    expectAnchorHref(res2.text, 'asset-preview-link', `/projects/${id}/assets/${asset.id}/original`);
  });

  it('renders a no-JavaScript viewer fallback without replacing the preview or original link', async () => {
    const res = await createProject('PhaseC Viewer No JavaScript');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC Viewer No JavaScript');
    const asset = writeIndexedAsset(id, projectDir, 'viewer-fallback.png', await makePng());

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('<noscript>');
    expect(res2.text).toContain('JavaScript is disabled. Select the preview image to open the asset.');
    expect(res2.text).toContain('data-preview-fallback hidden>Preview unavailable</p>');
    expect(res2.text).toContain('alt="Preview of viewer-fallback.png"');
    expectNoAnchor(res2.text, 'asset-viewer-original');
    expectAnchorHref(res2.text, 'asset-preview-link', `/projects/${id}/assets/${asset.id}/original`);
    const dialogStart = res2.text.indexOf('<dialog id="asset-edit-dialog"');
    const dialogEnd = res2.text.indexOf('</dialog>', dialogStart) + '</dialog>'.length;
    const dialogHtml = res2.text.slice(dialogStart, dialogEnd);
    const outsideDialog = res2.text.slice(0, dialogStart) + res2.text.slice(dialogEnd);
    expect(dialogStart).toBeGreaterThan(-1);
    expect(dialogHtml).toContain(
      'class="app-dialog-status" data-dialog-status role="status" aria-live="polite"'
    );
    expect((res2.text.match(/aria-live="polite"/g) || [])).toHaveLength(1);
    expect(outsideDialog).not.toContain('aria-live');
  });

  it('renders shared list-card loading hooks and pre-rendered failure fallback in project list cards', async () => {
    const res = await createProject('PhaseC Table Hooks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC Table Hooks');
    writeIndexedAsset(id, projectDir, 'hooked.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);

    expect(res2.text).toContain('class="asset-list-card-media" data-preview-enhancement data-preview-state="loading"');
    expect(res2.text).toContain('data-preview-image');
    expect(res2.text).toContain('data-preview-fallback hidden>');
    expect((res2.text.match(/data-preview-image/g) || []).length).toBe(1);
    expect((res2.text.match(/data-preview-fallback/g) || []).length).toBe(1);
  });

  it('does not add image-loading behavior for unsupported binary assets in project list cards', async () => {
    const res = await createProject('PhaseC No Preview Hooks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC No Preview Hooks');
    writeIndexedAsset(id, projectDir, 'source.bin', 'binary bytes', {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);

    expect(res2.text).not.toContain('data-preview-enhancement');
    expect(res2.text).not.toContain('data-preview-image');
    expect(res2.text).not.toContain('data-preview-fallback');
    expect(res2.text).toContain('BIN');
  });

  it('renders reduced-motion coverage for preview image transitions', async () => {
    const res = await createProject('PhaseC Reduced Motion');
    const id = res.headers.location.replace('/projects/', '');
       const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);

    expect(await readStylesheetSource(res2.text)).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.asset-list-card-media-image[\s\S]*\.asset-preview-image[\s\S]*transition: none !important;/
    );
  });

  // ─── Visual hierarchy and responsive styling ──────────────────────

  it('renders design tokens for surfaces, borders, focus, spacing, radius, shadow, and transition', async () => {
    const res = await createProject('PhaseB Tokens');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);
    expect(style).toContain('--surface-card');
    expect(style).toContain('--border:');
    expect(style).toContain('--border-strong');
    expect(style).toContain('--focus-ring');
    expect(style).toContain('--space-sm');
    expect(style).toContain('--radius-lg');
    expect(style).toContain('--shadow-md');
    expect(style).toContain('--transition-base');
  });

  it('serves resolved Settings control-height and muted-text CSS tokens', async () => {
    const res = await createProject('Settings CSS Tokens');
    const id = res.headers.location.replace('/projects/', '');
    const style = await readStylesheetSource((await agent.get(`/projects/${id}/assets`).expect(200)).text);
    const canonicalizeSelector = (selector) => {
      let canonical = '';
      let pendingWhitespace = false;
      let squareBracketDepth = 0;
      let parenthesisDepth = 0;
      let quote = '';
      const appendPendingWhitespace = () => {
        if (pendingWhitespace && canonical && !/[>+~]$/.test(canonical)) {
          canonical += ' ';
        }
        pendingWhitespace = false;
      };

      for (let index = 0; index < selector.length; index += 1) {
        const character = selector[index];
        if (quote) {
          canonical += character;
          if (character === '\\') {
            canonical += selector[index + 1] || '';
            index += 1;
          } else if (character === quote) {
            quote = '';
          }
          continue;
        }
        if (character === '"' || character === "'") {
          if (!squareBracketDepth && !parenthesisDepth) appendPendingWhitespace();
          quote = character;
          canonical += character;
          continue;
        }
        if (character === '[') {
          if (!squareBracketDepth && !parenthesisDepth) appendPendingWhitespace();
          squareBracketDepth += 1;
          canonical += character;
          continue;
        }
        if (character === ']') {
          squareBracketDepth = Math.max(0, squareBracketDepth - 1);
          canonical += character;
          continue;
        }
        if (character === '(' && !squareBracketDepth) {
          if (!parenthesisDepth) appendPendingWhitespace();
          parenthesisDepth += 1;
          canonical += character;
          continue;
        }
        if (character === ')' && !squareBracketDepth) {
          parenthesisDepth = Math.max(0, parenthesisDepth - 1);
          canonical += character;
          continue;
        }
        if (!squareBracketDepth && !parenthesisDepth && /\s/.test(character)) {
          pendingWhitespace = true;
          continue;
        }
        if (!squareBracketDepth && !parenthesisDepth && /[>+~]/.test(character)) {
          canonical = canonical.trimEnd();
          canonical += character;
          pendingWhitespace = false;
          continue;
        }
        appendPendingWhitespace();
        canonical += character;
      }

      return canonical.trim();
    };
    const extractRule = (selector) => {
      const canonicalSelector = canonicalizeSelector(selector);
      const rule = Array.from(style.matchAll(/([^{}]+)\{([^{}]*)\}/g))
        .find(([, selectorList]) => selectorList
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split(',')
          .some((candidate) => canonicalizeSelector(candidate) === canonicalSelector));
      expect(rule, `missing CSS rule for ${selector}`).toBeDefined();
      return {
        selectors: (rule?.[1] || '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split(',')
          .map((candidate) => canonicalizeSelector(candidate)),
        declarations: rule?.[2] || '',
      };
    };

    expect(style).toMatch(/:root\s*\{[^}]*--control-height:\s*2\.5rem\s*;/);
    const projectOptionControlRule = extractRule('.project-option-add-row .project-option-color-control');
    expect(projectOptionControlRule.selectors).toContain('.project-option-add-row>.button');
    expect(projectOptionControlRule.declarations).toMatch(/min-height:\s*var\(--control-height\)\s*;/);

    expect(style).not.toContain('var(--text-muted)');
    const nsfwAndCategoryHelpRule = extractRule('.settings-nsfw-filter-content .help-text');
    expect(nsfwAndCategoryHelpRule.selectors).toEqual(expect.arrayContaining([
      '.settings-asset-categories-content .asset-browser-default-description',
      '.settings-asset-categories-content .category-management-section-note',
    ]));
    expect(nsfwAndCategoryHelpRule.declarations).toMatch(/color:\s*var\(--muted\)\s*;/);

    const openLocallyHelpRule = extractRule('.settings-open-locally-content .settings-open-locally-section-body .help-text');
    expect(openLocallyHelpRule.declarations).toMatch(/color:\s*var\(--muted\)\s*;/);
  });

  it('renders object-fit contain for shared project list-card media', async () => {
    const res = await createProject('PhaseB Shared List Media Fit');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(await readStylesheetSource(res2.text)).toMatch(/\.asset-list-card-media-image\s*\{[^}]*object-fit:\s*contain/);
  });

  it('renders object-fit contain for viewer preview images', async () => {
    const res = await createProject('PhaseB Viewer Fit');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Viewer Fit');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());
    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expect(await readStylesheetSource(res2.text)).toMatch(/\.asset-preview-image\s*\{[^}]*object-fit:\s*contain/);
  });

  it('scopes intrinsic, centered, non-cover sizing to Krita media only', async () => {
    const res = await createProject('PhaseG2 Krita CSS');
    const id = res.headers.location.replace('/projects/', '');
    const browser = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(browser.text);

    expect(style).toMatch(/\.asset-media--krita\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center/);
    expect(style).toMatch(/\.asset-media--krita \.asset-thumb-image,[\s\S]*?\.asset-media--krita \.asset-preview-image\s*\{[^}]*width:\s*auto[^}]*max-width:\s*100%[^}]*height:\s*auto/);
    expect(style).toMatch(/\.asset-media--krita \.asset-thumb-image\s*\{[^}]*max-height:\s*100%/);
    expect(style).toMatch(/\.asset-media--krita \.asset-thumb-image\s*\{[^}]*object-fit:\s*contain/);

    const scopedRules = [...style.matchAll(/\.asset-media--krita[^{}]*\{[^}]*\}/g)]
      .map((match) => match[0])
      .join('\n');
    expect(scopedRules).not.toMatch(/object-fit:\s*cover/);
    expect(scopedRules).not.toMatch(/(?:^|[;\s])width:\s*100%/);
  });

  it('makes the native hidden attribute authoritative over preview display rules', async () => {
    const res = await createProject('PhaseB Hidden CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);
    const hiddenRule = '[hidden] { display: none !important; }';

    expect(style).toContain(hiddenRule);
    expect(style).toMatch(/\.asset-thumb-image\s*\{[^}]*display:\s*block/);
    expect(style).toMatch(/\.asset-preview-image\s*\{[^}]*display:\s*block/);
  });

  it('renders active-nav CSS using aria-current attribute selector', async () => {
    const res = await createProject('PhaseB Active CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(await readStylesheetSource(res2.text)).toContain('[aria-current="page"]');
  });

  it('serves functional accessibility and list-card interaction CSS', async () => {
    const res = await agent.get('/creatorcrate.css').expect(200);
    const style = res.text;

    expect(res.headers['content-type']).toMatch(/text\/css/);
    expect(style).toMatch(/\.sr-only\s*\{[^}]*position:\s*absolute[^}]*width:\s*1px[^}]*height:\s*1px[^}]*overflow:\s*hidden/);
    expect(style).toMatch(/\.pagination-prev:focus-visible,\s*\.pagination-next:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-top\s*\{[^}]*pointer-events:\s*none/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-top\s+\.asset-selection-control\s*\{[^}]*pointer-events:\s*auto/);
  });

  it('renders viewer preview frame with contained image and responsive max-height', async () => {
    const res = await createProject('PhaseB Viewer Frame');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Viewer Frame');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());
    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    const style = await readStylesheetSource(res2.text);
    expect(style).not.toMatch(/\.asset-preview-frame\s*\{[^}]*border\s*:/);
    expect(style).toMatch(/\.asset-preview-viewer\s*\{[^}]*position:\s*relative[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-preview-nav--previous\s*\{[^}]*left:\s*var\(--space-lg\)/);
    expect(style).toMatch(/\.asset-preview-nav--next\s*\{[^}]*right:\s*var\(--space-lg\)/);
    expect(style).toMatch(/\.asset-preview-nav\s*\{[^}]*z-index:\s*2[^}]*background:\s*rgba\(13 15 19 \/ 0\.72\)/);
    expect(style).toMatch(/\.asset-preview-nav:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    expect(style).toMatch(/@media \(max-width:\s*540px\)[\s\S]*?\.asset-preview-nav--previous\s*\{[^}]*left:\s*var\(--space-sm\)/);
    expect(style).toMatch(/\.asset-preview-link\s*\{[^}]*display:\s*block[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-preview-link:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)[^}]*outline-offset:\s*3px/);
    expect(style).toMatch(/\.asset-preview-image\s*\{[^}]*max-height/);
    expect(style).toMatch(/\.asset-preview-image\s*\{[^}]*object-fit:\s*contain/);
  });

  // ─── Project list-card markup ───────────────────────────────────

  it('renders Project List selection, rename, preview, and association contracts', async () => {
    const res = await createProject('Project List Contracts');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Project List Contracts');
    const asset = writeIndexedAsset(id, projectDir, 'renders/archive.final.png', await makePng());
    const tag = app.locals.tagService.createTag({ name: 'Project List Tag' });
    app.locals.assetTagService.replaceAssetTags(asset.id, [tag.id]);
    const releaseId = await createReleaseUsingAsset(id, asset.id, 'Project List Release');

    const response = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const card = assetListCardHtml(response.text, asset.id);
    expect(card).not.toBe('');
    expect(response.text).toContain('<ul class="asset-list asset-list--project" role="list" aria-label="Project assets"');
    expect(card).toContain(`data-project-assets-preview-id="${asset.id}"`);
    expect(card).toContain(`class="asset-details-link asset-details-link--present asset-tooltip asset-tooltip--right" href="/projects/${id}/assets/${asset.id}?view=list"`);
    expect(card).toContain(`name="selectedAssetIds" value="${asset.id}"`);
    expect(card).toContain('form="bulk-select-form"');
    expect(card).toContain('aria-label="Select renders/archive.final.png"');

    const renameTrigger = card.match(/<a\b(?=[^>]*data-asset-rename-trigger)[^>]*>/)?.[0] || '';
    expect(renameTrigger).toContain(`href="/projects/${id}/assets/${asset.id}?view=list"`);
    expect(renameTrigger).toContain('aria-label="Rename archive.final.png"');
    const renameEditor = card.match(/<form method="post" action="\/projects\/\d+\/assets\/\d+\/rename"\s+class="asset-card-rename-editor" data-asset-rename-editor hidden inert>[\s\S]*?<\/form>/)?.[0] || '';
    expect(renameEditor).not.toBe('');
    expect(renameEditor).toContain(`action="/projects/${id}/assets/${asset.id}/rename"`);
    expect(renameEditor).toContain('name="origin" value="assets"');
    expect(renameEditor).toContain('value="archive.final"');
    expect(renameEditor).toContain('class="asset-rename-extension" aria-hidden="true">.png</span>');
    expect(renameEditor).toMatch(/<input type="hidden" name="_csrf"[^>]*\bdisabled\b/);
    expect(renameEditor).toMatch(/<input type="text"[^>]*data-asset-rename-input[^>]*\bdisabled\b/);
    expect(renameEditor).toMatch(/<button[^>]*data-asset-rename-confirm[^>]*\bdisabled\b/);
    expect(renameEditor).toMatch(/<button[^>]*data-asset-rename-cancel[^>]*\bdisabled\b/);

    expect(card).toContain(`href="/releases/${releaseId}"`);
    expect(card).toContain('Project List Release');
    expect(card).toContain('Project List Tag');
  });
  it('renders Project Grid selection, navigation, preview, and information hooks', async () => {
    const res = await createProject('Project Grid Contracts');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Project Grid Contracts');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());

    const response = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    const card = assetCardHtml(response.text, asset.id);
    expect(card).not.toBe('');
    expect(card).toContain('role="option" aria-selected="false" data-asset-selectable-card tabindex="0"');

    const checkbox = card.match(/<input type="checkbox"[^>]*class="asset-select-checkbox"[^>]*>/)?.[0] || '';
    expect(checkbox).toContain('form="bulk-select-form"');
    expect(checkbox).toContain('name="selectedAssetIds"');
    expect(checkbox).toContain(`value="${asset.id}"`);
    expect(checkbox).toContain('aria-label="Select hero.png"');

    expect(card).toContain(`class="asset-details-link asset-details-link--present asset-tooltip asset-tooltip--right" href="/projects/${id}/assets/${asset.id}?category=all"`);
    expect(card).toContain('aria-label="Asset details | File present"');
    expect(card).toContain(`class="asset-card-media-link" href="/projects/${id}/assets/${asset.id}?category=all"`);
    expect(card).toContain(`data-project-assets-preview-id="${asset.id}"`);
    expect(card).toContain('data-asset-viewer-preview');
    expect(card).toContain('data-asset-info-card popover="manual"');
    expect(card).not.toContain('<dt>Project</dt>');
    expect(card).not.toContain('data-asset-rename-trigger');
    expect(card).not.toContain('data-asset-rename-editor');
  });
  it('renders a missing Project asset without selectable or media-navigation actions', async () => {
    const res = await createProject('Grid Missing State');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Missing State');
    writeIndexedAsset(id, projectDir, 'present.png', await makePng());
    const missing = writeIndexedAsset(id, projectDir, 'missing.png', await makePng());
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['present.png']);

    const response = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    const card = assetCardHtml(response.text, missing.id);
    expect(card).not.toBe('');

    const checkbox = card.match(/<input type="checkbox"[^>]*>/)?.[0] || '';
    expect(checkbox).toContain('disabled');
    expect(checkbox).toContain('aria-label="missing.png is missing at last scan and cannot be selected"');
    expect(checkbox).not.toContain('name="selectedAssetIds"');
    expect(checkbox).not.toContain('form="bulk-select-form"');

    expect(card).toContain(`class="asset-details-link asset-details-link--missing asset-tooltip asset-tooltip--right" href="/projects/${id}/assets/${missing.id}?category=all"`);
    expect(card).toContain('aria-label="Asset details | File missing!"');
    expect(card).toContain('Missing at last scan');
    expect(card).not.toContain('asset-card-media-link');
    expect(card).not.toContain(`/projects/${id}/assets/${missing.id}/preview`);
    expect(card).not.toContain(`/projects/${id}/assets/${missing.id}/thumbnail`);
  });
  it('preserves the current extension for browser-origin basename renames', async () => {
    const res = await createProject('Browser Basename Rename');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Browser Basename Rename');
    const asset = writeIndexedAsset(id, projectDir, 'archive.final.png', await makePng());

    const rename = await agent
      .post(`/projects/${id}/assets/${asset.id}/rename`)
      .send({ filename: 'renamed', origin: 'assets', view: 'list', _csrf: csrfToken })
      .type('form')
      .expect(302);

    const location = new URL(rename.headers.location, 'http://localhost');
    expect(location.pathname).toBe(`/projects/${id}/assets`);
    expect(location.searchParams.get('view')).toBe('list');
    expect(fs.existsSync(path.join(projectDir, 'renamed.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'archive.final.png'))).toBe(false);
  });

  it('does not restore the removed grid Rename editor after a controlled failure', async () => {
    const res = await createProject('Grid Rename Failure');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Rename Failure');
    const asset = writeIndexedAsset(id, projectDir, 'scene.v2.kra', Buffer.from('kra'), {
      extension: 'kra', mimeType: 'application/x-krita',
    });

    const failed = await agent
      .post(`/projects/${id}/assets/${asset.id}/rename`)
      .send({ filename: 'bad/name', origin: 'assets', view: 'grid', _csrf: csrfToken })
      .type('form')
      .expect(422);

    const card = failed.text.match(/<article class="asset-card[\s\S]*?<\/article>/)?.[0];
    expect(card).toBeDefined();
    expect(card).toContain('data-asset-viewer-preview');
    expect(card).toContain('data-asset-info-card popover="manual"');
    expect(card).not.toContain('class="asset-card-body');
    expect(card).not.toContain('data-asset-rename-trigger');
    expect(card).not.toContain('data-asset-rename-editor');
    expect(fs.existsSync(path.join(projectDir, 'scene.v2.kra'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'bad', 'name.kra'))).toBe(false);
  });

  it('reopens the list Rename editor in the shared title area after a controlled failure', async () => {
    const res = await createProject('List Rename Failure');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('List Rename Failure');
    const asset = writeIndexedAsset(id, projectDir, 'scene.v2.kra', Buffer.from('kra'), {
      extension: 'kra', mimeType: 'application/x-krita',
    });

    const failed = await agent
      .post(`/projects/${id}/assets/${asset.id}/rename`)
      .send({ filename: 'bad/name', origin: 'assets', view: 'list', _csrf: csrfToken })
      .type('form')
      .expect(422);

    const card = assetListCardHtml(failed.text, asset.id);
    expect(card).toBeDefined();
    expect(card).toContain('data-asset-title-row hidden');
    expect(card).toContain('data-asset-rename-trigger');
    expect(card).toMatch(/class="asset-card-rename-editor" data-asset-rename-editor>/);
    expect(card).not.toMatch(/class="asset-card-rename-editor"[^>]*\bhidden\b/);
    expect(card).not.toMatch(/class="asset-card-rename-editor"[^>]*\binert\b/);
    expect(card).not.toMatch(/class="asset-card-rename-input"[^>]*\bdisabled\b/);
    expect(card).toContain('value="bad/name"');
    expect(card).toContain('aria-label="New basename for scene.v2.kra"');
    expect(card).not.toContain('row-rename-form');
    expect(card).not.toContain('asset-list-card-actions');
    expect(fs.existsSync(path.join(projectDir, 'scene.v2.kra'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'bad', 'name.kra'))).toBe(false);
  });

  it('renames from the grid with basename-only input and returns to canonical grid context', async () => {
    const res = await createProject('Grid Rename Success');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Rename Success');
    const asset = writeIndexedAsset(id, projectDir, 'scene.v2.kra', Buffer.from('kra'), {
      extension: 'kra', mimeType: 'application/x-krita',
    });

    const renamed = await agent
      .post(`/projects/${id}/assets/${asset.id}/rename`)
      .send({ filename: 'final-scene', origin: 'assets', view: 'grid', page: '1', pageSize: '25', _csrf: csrfToken })
      .type('form')
      .expect(302);

    const location = new URL(renamed.headers.location, 'http://localhost');
    expect(location.pathname).toBe(`/projects/${id}/assets`);
    expect(location.searchParams.get('notice')).toBe('asset-renamed');
    expect(location.searchParams.has('view')).toBe(false);
    expect(location.searchParams.has('filename')).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'final-scene.kra'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'scene.v2.kra'))).toBe(false);
  });

  it('renders a checked grid checkbox with selected class and aria-selected after a bulk validation failure', async () => {
    const res = await createProject('Grid Selected State');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Selected State');
    const asset = writeIndexedAsset(id, projectDir, 'selected.png', await makePng());

    const failed = await agent
      .post(`/projects/${id}/assets/move-selected`)
      .send({ selectedAssetIds: String(asset.id), destinationCategory: 'not-valid', view: 'grid', _csrf: csrfToken })
      .type('form')
      .expect(422);

    const card = failed.text.match(/<article class="asset-card[\s\S]*?<\/article>/)?.[0];
    expect(card).toBeDefined();
    expect(card).toContain('class="asset-card asset-card--project is-selected"');
    expect(card).toContain('aria-selected="true"');
    expect(card).toContain('class="asset-selection-control is-selected"');
    expect(card).toMatch(/<input type="checkbox"[^>]*checked>/);
  });

  it('renders Project Assets filters in a persistent dialog with Reset and keeps category controls intact', async () => {
    const res = await createProject('Category Disclosure');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Category Disclosure');

    const enabledCat = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    const disabledCat = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Archive', directorySlug: 'archive', displayOrder: 1, enabled: false,
    });
    // A second enabled category with zero assets must still be visible.
    assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Empty Category', directorySlug: 'empty-category', displayOrder: 2, enabled: true,
    });

    writeIndexedAsset(id, projectDir, 'root.png', await makePng());
    assetRepo.upsert(id, 'renders/final.png', {
      filename: 'final.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: enabledCat.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'archive/old.png', {
      filename: 'old.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: disabledCat.id, nestedPath: '',
    });
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['root.png', 'renders/final.png']);

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);

    const pageHeadingActions = res2.text.match(/<div class="page-heading-actions">[\s\S]*?<\/div>/)?.[0];
    expect(pageHeadingActions).toBeDefined();
    expect(pageHeadingActions).not.toContain('Manage Categories');

    const displayControlsStart = res2.text.indexOf('<div class="asset-viewer-display-controls">');
    const filterActionsStart = res2.text.indexOf('<div class="project-filter-actions project-filter-actions--projects">');
    const liveRegionStart = res2.text.indexOf('<div data-project-assets-live-region');
    const filterDialogStart = res2.text.indexOf('<dialog id="project-assets-filter-dialog"');
    const filterFormStart = res2.text.indexOf('<form id="asset-filters"');
    expect(displayControlsStart).toBeGreaterThanOrEqual(0);
    expect(filterActionsStart).toBeGreaterThan(displayControlsStart);
    expect(filterDialogStart).toBeGreaterThan(liveRegionStart);
    expect(filterFormStart).toBeGreaterThan(filterDialogStart);

    const filterActions = res2.text.match(/<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>/)?.[0] || '';
    expect(filterActions).toContain('href="#project-assets-filter-dialog"');
    expect(filterActions).toContain('data-dialog-open="project-assets-filter-dialog"');
    expect(filterActions).toContain('aria-label="Filter assets"');
    expect(filterActions).toContain('data-slideshow-trigger');
    expect(filterActions).not.toContain('data-project-assets-reset');

    const defaultsLink = res2.text.match(/<a class="[^"]*\basset-viewer-defaults-link\b[^"]*"[\s\S]*?<\/a>/)?.[0];
    expect(defaultsLink).toBeDefined();
    expect(defaultsLink).toContain('asset-tooltip');
    expect(defaultsLink).toContain('asset-tooltip--left');
    expect(defaultsLink).toContain(`href="/projects/${id}/assets?defaults=1"`);
    expect(defaultsLink).toContain('aria-label="Project Assets defaults"');
    expect(defaultsLink).toContain('data-tooltip="Project Assets defaults"');
    expect(defaultsLink).not.toContain('title=');
    expect(defaultsLink).toContain('aria-hidden="true"');

    const filterDialog = res2.text.match(/<dialog id="project-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0];
    expect(filterDialog).toBeDefined();
    expect(filterDialog).toContain('<h2 id="project-assets-filter-dialog-title">Filter</h2>');
    const filterForm = filterDialog.match(/<form id="asset-filters" class="app-dialog-form project-form" method="get" action="\/projects\/\d+\/assets">[\s\S]*?<\/form>/)?.[0];
    expect(filterForm).toBeDefined();
    expect(res2.text.slice(liveRegionStart, filterDialogStart)).not.toContain('id="asset-filters"');
    expect((res2.text.match(/id="project-assets-filter-dialog"/g) || [])).toHaveLength(1);
    expect((res2.text.match(/id="asset-filters"/g) || [])).toHaveLength(1);
    expect((res2.text.match(/id="search"/g) || [])).toHaveLength(1);
    const resetForm = filterDialog.match(/<form class="projects-filter-reset" method="get" action="[^"]+">[\s\S]*?<\/form>/)?.[0];
    expect(resetForm).toBeDefined();
    expect(resetForm).toContain(`action="/projects/${id}/assets?resetFilters=1&amp;view=grid"`);
    expect(resetForm).toContain('<button class="button" type="submit" data-project-assets-reset>Reset filters</button>');
    const categoryPosition = filterForm.indexOf('data-asset-category-filter');
    const searchPosition = filterForm.indexOf('<label for="search">Search</label>');
    expect(categoryPosition).toBeGreaterThanOrEqual(0);
    expect(searchPosition).toBeGreaterThanOrEqual(0);
    expect(categoryPosition).toBeLessThan(searchPosition);
    expect(filterForm).toContain('id="search" name="search" type="search"');
    expect(filterForm).toContain('name="category"');
    expect(filterForm).toContain('value="all"');
    expect(filterForm).toContain('value="uncategorized"');
    expect(filterForm).toContain('No tags available');
    expect(filterForm).toContain('name="extension"');
    expect(filterForm).toContain('name="presence"');
    expect(filterForm).toContain('name="usage"');
    expect(filterForm).toContain('name="sort"');
    expect(filterForm).toContain('value="filename"');
    expect(filterForm).toContain('value="modified"');
    expect(filterForm).toContain('value="size"');
    expect(filterForm).toContain('value="category"');
    expect(filterForm).toContain('name="order"');
    expect(filterForm).toContain('value="asc"');
    expect(filterForm).toContain('value="desc"');
    expect((filterForm.match(/data-cc-dropdown data-cc-dropdown-mode="(?:single|multiple)"/g) || [])).toHaveLength(7);
    expect(filterForm).not.toContain('data-asset-viewer-filter-disclosure');
    expect(filterForm).not.toContain('data-asset-action-select');
    expect(filterForm).not.toContain('>Filter</button>');
    expect(filterForm).not.toContain('data-project-assets-reset');
    expect(filterForm).not.toMatch(/<select[^>]+name="(?:presence|usage|sort|order)"/);

    const convertedFilterControls = [
      {
        label: 'Show', optionsId: 'asset-presence-filter-options', name: 'presence', summary: 'All assets',
        options: [['all', 'All assets'], ['present', 'Present at last scan'], ['missing', 'Missing at last scan']],
      },
      {
        label: 'Usage', optionsId: 'asset-usage-filter-options', name: 'usage', summary: 'All assets',
        options: [['all', 'All assets'], ['used', 'Used by a release'], ['unused', 'Not used by a release']],
      },
      {
        label: 'Sort by', optionsId: 'asset-sort-filter-options', name: 'sort', summary: 'Filename',
        options: [['filename', 'Filename'], ['modified', 'Modified date'], ['size', 'File size'], ['category', 'Category &amp; location']],
      },
      {
        label: 'Order', optionsId: 'asset-order-filter-options', name: 'order', summary: 'Ascending',
        options: [['asc', 'Ascending'], ['desc', 'Descending']],
      },
    ];
    for (const { label, optionsId, name, summary, options } of convertedFilterControls) {
      const control = assetFilterHtml(res2.text, optionsId);
      expect(control).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
      expect(control).toContain(`aria-controls="${optionsId}"`);
      expect(control).toContain('aria-expanded="false"');
      expect(control).toContain(`aria-label="${label} filter: ${summary}"`);
      expect(control).toContain(`id="${optionsId}" class="asset-filter-multiselect-panel" role="radiogroup" aria-label="${label} options"`);
      expect(control).toContain('class="asset-filter-multiselect-summary-current"');
      expect(control).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
      expectCheckedAssetFilter(control, name, options[0][0]);
      for (const [value, visibleLabel] of options) {
        expect(control).toMatch(new RegExp(`<label for="[^"]+">\\s*<input[^>]*name="${name}"[^>]*type="radio"[^>]*value="${value}"`));
        expect(control).toContain(`<span>${visibleLabel}</span>`);
      }
    }

    const categoryFieldset = res2.text.match(/<fieldset class="field [^"]*asset-viewer-filter-field[^"]*asset-project-category-filter[^"]*"[\s\S]*?<\/fieldset>/)?.[0];
    expect(categoryFieldset).toBeDefined();
    expect(categoryFieldset).not.toContain('Manage Categories');

    expect(res2.text).toContain('data-asset-category-filter');
    expect(res2.text).toMatch(/<input id="asset-category-option-all"[^>]*value="all"[\s\S]*?checked>/);
    expect(res2.text).toContain('aria-label="Category filter: All categories (3)"');
    expect(res2.text).toContain('>All categories (3)</span>');
    expect(res2.text).toContain('>Uncategorized (1)</span>');
    expect(res2.text).toContain('>Renders (1)</span>');
    expect(res2.text).toContain('>Empty Category (0)</span>');
    expect(res2.text).toContain('>Archive (1) <em class="asset-category-disabled-marker">(disabled)</em></span>');
    expect(res2.text).toContain('>Missing (1)</span>');

    const categoryOptions = categoryFieldset.match(/<div class="asset-filter-multiselect-option">[\s\S]*?<\/div>/g) || [];
    expect(categoryOptions.length).toBeGreaterThan(4);
    for (const option of categoryOptions) {
      const input = option.match(/<input id="([^"]+)"[^>]*name="category"[^>]*value="([^"]+)"/);
      const label = option.match(/<label for="([^"]+)">[\s\S]*?<\/label>/);
      expect(input).not.toBeNull();
      expect(label).not.toBeNull();
      expect(label[1]).toBe(input[1]);
      expect(option).toMatch(new RegExp(`<label for="${input[1]}">\\s*<input`));
      expect(input[2]).not.toContain('(');
    }
    expect(res2.text).not.toContain(`href="/projects/${id}/asset-categories"`);
    const selectionControls = assetSelectionControlsHtml(assetActionsPanelHtml(res2.text));
    expect(selectionControls.indexOf('data-clear-selection')).toBeLessThan(
      selectionControls.indexOf('data-dialog-open="project-asset-category-management-dialog"'),
    );
    expect(res2.text).toContain('id="project-asset-category-management-dialog"');
    expect(res2.text).toContain('data-category-reorder-list');
    expect(res2.text).toContain('action="/projects/' + id + '/asset-categories/reorder"');
    expect(res2.text).toContain('action="/projects/' + id + '/asset-categories"');
    expect(res2.text).not.toContain('class="asset-browser-nav"');

    const opened = await agent.get(`/projects/${id}/assets?manage_categories=1`).expect(200);
    expect(opened.text).toMatch(/<dialog id="project-asset-category-management-dialog"[^>]* data-app-dialog open/);
    expect(opened.text).toContain('Manage Categories');

    const style = await readStylesheetSource(res2.text);
    expect(categoryFieldset).toContain('asset-filter-multiselect-field');
    expect(categoryFieldset).toContain('asset-filter-multiselect--sized');
    expect(categoryFieldset).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
    const categorySummaryWidthRule = style.match(/(?:^|})\s*\.asset-filter-multiselect--sized \.asset-filter-multiselect-summary-width\s*\{([^}]*)\}/)?.[1] || '';
    expect(categorySummaryWidthRule).toMatch(/max-height:\s*0/);
    expect(categorySummaryWidthRule).toMatch(/overflow:\s*hidden/);
    expect(categorySummaryWidthRule).toMatch(/visibility:\s*hidden/);
    const categorySummaryRule = style.match(/(?:^|})\s*\.asset-filter-multiselect summary\s*\{([^}]*)\}/)?.[1] || '';
    expect(categorySummaryRule).toMatch(/min-height:\s*2\.5rem/);
    const searchHeightRule = style.match(/(?:^|})\s*#asset-filters \.field input\[type="search"\]\s*\{([^}]*)\}/)?.[1] || '';
    expect(searchHeightRule).toMatch(/height:\s*2\.5rem/);
    expect(style).toMatch(/@media\s*\(max-width:\s*540px\)[\s\S]*?\.asset-filter-multiselect-field\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/);

    const gridCards = [...res2.text.matchAll(/<article class="asset-card asset-card--project[\s\S]*?<\/article>/g)]
      .map((match) => match[0]);
    expect(gridCards).toHaveLength(3);
    for (const card of gridCards) {
      expect(card).not.toContain('class="asset-card-body');
      expect(card).toContain('class="asset-card-top"');
      expect(card).toContain('class="asset-selection-control');
      expect(card).toContain('data-asset-info-card popover="manual"');
    }

    expect(res2.text).toContain('id="asset-category-filter-options"');

    const missing = await agent.get(`/projects/${id}/assets?presence=missing`).expect(200);
    expect(missing.text).toContain('aria-label="Category filter: Missing (1)"');
    expect(missing.text).toMatch(/<input id="asset-category-option-missing"[^>]*value="all"[\s\S]*?checked>/);
    expect(missing.text).toContain('>Missing (1)</span>');
    expectCheckedAssetFilter(missing.text, 'presence', 'missing');

    const enabled = await agent.get(`/projects/${id}/assets?category=${enabledCat.id}`).expect(200);
    expect(enabled.text).toContain('aria-label="Category filter: Renders (1)"');
    expect(enabled.text).toContain('>Renders (1)</span>');

    const disabled = await agent.get(`/projects/${id}/assets?category=${disabledCat.id}`).expect(200);
    expect(disabled.text).toContain('aria-label="Category filter: Archive (1) (disabled)"');
    expect(disabled.text).toContain('>Archive (1) <em class="asset-category-disabled-marker">(disabled)</em></span>');
  });

  it('category disclosure options are project-scoped and mark disabled categories', async () => {
    const res = await createProject('Category Dropdown Owner');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const other = await createProject('Category Dropdown Other');
    const otherId = Number(other.headers.location.replace('/projects/', ''));

    const mine = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Mine', directorySlug: 'mine', displayOrder: 0, enabled: true,
    });
    const mineDisabled = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Mine Disabled', directorySlug: 'mine-disabled', displayOrder: 1, enabled: false,
    });
    assetCategoryRepo.addProjectCategory({
      projectId: otherId, displayName: 'Not Mine', directorySlug: 'not-mine', displayOrder: 0, enabled: true,
    });

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain(`id="asset-category-option-${mine.id}" name="category" type="radio" value="${mine.id}"`);
    expect(res2.text).toContain(`id="asset-category-option-${mineDisabled.id}" name="category" type="radio" value="${mineDisabled.id}"`);
    expect(res2.text).toContain('>Mine (0)</span>');
    expect(res2.text).toContain('>Mine Disabled (0) <em class="asset-category-disabled-marker">(disabled)</em></span>');
    expect(res2.text).not.toContain('Not Mine');
  });

  it('renders complete category membership and Auto Rename server contracts', async () => {
    const res = await createProject('Complete Category Contracts');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    const inCategory = assetRepo.upsert(id, 'renders/keep.png', {
      filename: 'keep.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'other.png', {
      filename: 'other.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null,
    });

    const grid = await agent
      .get(`/projects/${id}/assets?category=${category.id}&page=2&pageSize=all`)
      .expect(200);
    expect(grid.text).toContain('keep.png');
    expect(grid.text).not.toContain('other.png');
    expect(grid.text).not.toContain('class="page-size-form"');
    expect(grid.text).not.toContain('class="pagination"');
    expect(grid.text).toContain(`<section class="asset-auto-rename-surface" data-auto-rename-surface data-auto-rename-view="grid"`);
    expect(grid.text).toContain('aria-label="Renders assets"');

    const gridItem = grid.text.match(new RegExp(`<li\\b(?=[^>]*data-auto-rename-asset)(?=[^>]*data-auto-rename-asset-id="${inCategory.id}")[^>]*>`))?.[0] || '';
    expect(gridItem).toContain('data-auto-rename-initial-index="0"');
    expect(gridItem).toContain('draggable="true"');
    expect(gridItem).toContain('tabindex="0"');
    expect(gridItem).toContain('aria-posinset="1"');
    expect(gridItem).toContain('aria-setsize="1"');
    expect(gridItem).toContain('aria-label="Reorder keep.png"');

    const actionPanel = assetActionsPanelHtml(grid.text);
    expectProjectActionsSection(actionPanel);
    expect(actionPanel).toContain(`formaction="/projects/${id}/assets/create-release"`);
    expect(actionPanel).toContain(`formaction="/projects/${id}/assets/move-selected"`);
    expect(actionPanel).toContain('data-asset-selection-form');
    expect(actionPanel).toContain('data-auto-rename-form');
    expect(actionPanel).toContain(`action="/projects/${id}/assets/auto-rename/preview"`);
    expect(actionPanel).toContain(`name="categoryId" value="${category.id}"`);
    expect(actionPanel).toContain(`name="orderedAssetIds" value="[${inCategory.id}]"`);
    expect(actionPanel).toContain('name="selectedAssetIds" value="[]"');
    const autoRenameButton = actionPanel.match(/<button\b(?=[^>]*data-auto-rename-submit)[^>]*>/)?.[0] || '';
    expect(autoRenameButton).toContain('type="submit"');
    expect(autoRenameButton).toContain('form="auto-rename-assets-form"');
    expect(autoRenameButton).toContain('aria-label="Auto Rename"');
    expect(autoRenameButton).toContain('data-tooltip="Auto Rename"');
    expect(autoRenameButton).toContain('disabled');
    expect(autoRenameButton).toContain('aria-disabled="true"');

    const manageCategories = actionPanel.match(/<a\b(?=[^>]*data-dialog-open="project-asset-category-management-dialog")[^>]*>/)?.[0] || '';
    expect(manageCategories).toContain(`href="/projects/${id}/assets?category=${category.id}&amp;manage_categories=1"`);
    expect(manageCategories).toContain('aria-label="Manage Categories"');

    const list = await agent
      .get(`/projects/${id}/assets?category=${category.id}&view=list`)
      .expect(200);
    expect(list.text).toContain('data-auto-rename-surface data-auto-rename-view="list"');
    const listItem = list.text.match(new RegExp(`<li\\b(?=[^>]*data-auto-rename-asset)(?=[^>]*data-auto-rename-asset-id="${inCategory.id}")[^>]*>`))?.[0] || '';
    expect(listItem).toContain('draggable="true"');
    expect(listItem).toContain('aria-label="Reorder keep.png"');
    const listCard = assetListCardHtml(list.text, inCategory.id);
    expect(listCard).toContain(`name="selectedAssetIds" value="${inCategory.id}"`);
    expect(listCard).toContain('form="bulk-select-form"');
    expect(listCard).toContain(`action="/projects/${id}/assets/${inCategory.id}/rename"`);
    expect(listCard).toContain('data-asset-rename-trigger');

    const ordinary = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const ordinaryActionPanel = assetActionsPanelHtml(ordinary.text);
    expectProjectActionsSection(ordinaryActionPanel, { selectionOnly: true });
    expect(ordinary.text).not.toContain('data-auto-rename-surface');
    expect(ordinaryActionPanel).toContain('aria-label="Auto Rename"');
    expect(ordinaryActionPanel).not.toContain('data-auto-rename-submit');
  });
  it('serves the Auto Rename drag, marker, surface, and disabled-action CSS contracts', async () => {
    const created = await createProject('Auto Rename CSS Contract');
    const id = Number(created.headers.location.replace('/projects/', ''));
    const page = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(page.text);
    const ruleFor = (selector) => {
      const rule = Array.from(style.matchAll(/([^{}]+)\{([^{}]*)\}/g))
        .find(([, selectorList]) => selectorList
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split(',')
          .some((candidate) => candidate.trim() === selector));
      expect(rule, `missing CSS rule for ${selector}`).toBeDefined();
      return rule?.[2] || '';
    };

    const draggingRule = ruleFor('.asset-auto-rename-surface [data-auto-rename-asset].auto-rename-asset--dragging');
    expect(draggingRule).toMatch(/(?:^|;)\s*opacity:\s*0\.68\s*;/);
    expect(draggingRule).toMatch(/(?:^|;)\s*outline:\s*2px solid var\(--accent\)\s*;/);

    const markerRule = ruleFor('.auto-rename-order-marker');
    expect(markerRule).toMatch(/(?:^|;)\s*position:\s*absolute\s*;/);
    expect(markerRule).toMatch(/(?:^|;)\s*display:\s*none\s*;/);
    expect(markerRule).toMatch(/(?:^|;)\s*pointer-events:\s*none\s*;/);
    expect(ruleFor('.auto-rename-order-marker--visible')).toMatch(/(?:^|;)\s*display:\s*block\s*;/);
    expect(ruleFor('.asset-auto-rename-surface[data-auto-rename-view="grid"] .auto-rename-order-marker'))
      .toMatch(/(?:^|;)\s*width:\s*3px\s*;/);
    expect(ruleFor('.asset-auto-rename-surface[data-auto-rename-view="list"] .auto-rename-order-marker'))
      .toMatch(/(?:^|;)\s*height:\s*3px\s*;/);

    expect(ruleFor('.asset-auto-rename-surface')).toMatch(/(?:^|;)\s*overflow:\s*visible\s*;/);
    const disabledActionRule = ruleFor('.asset-actions-panel .button:disabled');
    expect(disabledActionRule).toMatch(/(?:^|;)\s*opacity:\s*0\.6\s*;/);
    expect(disabledActionRule).toMatch(/(?:^|;)\s*text-decoration:\s*none\s*;/);
  });

  it('renders the active category label from canonical filters and enabled or disabled navigation entries', async () => {
    const res = await createProject('Active Category Metadata');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const enabled = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Finished Renders', directorySlug: 'finished-renders', displayOrder: 0, enabled: true,
    });
    const disabled = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Legacy Sources', directorySlug: 'legacy-sources', displayOrder: 1, enabled: false,
    });
    assetRepo.upsert(id, 'root.png', {
      filename: 'root.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.upsert(id, 'finished-renders/final.png', {
      filename: 'final.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null, categoryId: enabled.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'legacy-sources/old.png', {
      filename: 'old.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null, categoryId: disabled.id, nestedPath: '',
    });

    const cases = [
      ['', 'Category: All'],
      ['?category=uncategorized', 'Category: Uncategorized'],
      [`?category=${enabled.id}`, 'Category: Finished Renders'],
      [`?category=${disabled.id}`, 'Category: Legacy Sources'],
    ];
    for (const [query, expected] of cases) {
      const response = await agent.get(`/projects/${id}/assets${query}`).expect(200);
      const metadata = response.text.match(/<div class="asset-results-metadata">[\s\S]*?<\/div>/)?.[0] || '';
      expect(metadata).toContain(`class="results-meta asset-results-category">${expected}</p>`);
      expect((metadata.match(/data-selected-count/g) || [])).toHaveLength(1);
    }
  });

  it('uses ordinary filtered results for non-default search and sorting on a numeric category view', async () => {
    const res = await createProject('Category Ordinary Controls');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    const disabledCategory = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Disabled', directorySlug: 'disabled', displayOrder: 1, enabled: false,
    });
    assetRepo.upsert(id, 'renders/larger-match.png', {
      filename: 'larger-match.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 20, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'renders/smaller-match.png', {
      filename: 'smaller-match.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'renders/other.png', {
      filename: 'other.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 30, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'root.png', {
      filename: 'root.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 5, modifiedAt: null, nestedPath: '',
    });
    assetRepo.upsert(id, 'disabled/disabled.png', {
      filename: 'disabled.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 5, modifiedAt: null, categoryId: disabledCategory.id, nestedPath: '',
    });

    const response = await agent
      .get(`/projects/${id}/assets?category=${category.id}&search=match&sort=size&order=desc&pageSize=1&view=list`)
      .expect(200);

    expect(response.text).not.toContain('data-auto-rename-surface');
    expect(response.text).toContain('value="match"');
    expectCheckedAssetFilter(response.text, 'sort', 'size');
    expectCheckedAssetFilter(response.text, 'order', 'desc');
    expect(assetFilterHtml(response.text, 'asset-sort-filter-options')).toContain('aria-label="Sort by filter: File size"');
    expect(assetFilterHtml(response.text, 'asset-order-filter-options')).toContain('aria-label="Order filter: Descending"');
    expect(response.text).toContain('larger-match');
    expect(response.text).not.toContain('other');
    expect(response.text).not.toContain('smaller-match');

    const actionPanel = assetActionsPanelHtml(response.text);
    expectProjectActionsSection(actionPanel, { selectionOnly: true });
    expect((actionPanel.match(/<h2 id="project-actions-heading">Project actions<\/h2>/g) || [])).toHaveLength(1);
    expect(actionPanel).not.toContain('Drag assets to change their filename order');
    expect(actionPanel).toContain('<h3 class="asset-action-group-heading">Release</h3>');
    expect(actionPanel).toContain('<h3 class="asset-action-group-heading">File</h3>');

    const nextMatch = response.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const nextUrl = new URL(decodeHtmlHref(nextMatch[1]), 'http://localhost');
    expect(nextUrl.searchParams.get('category')).toBe(String(category.id));
    expect(nextUrl.searchParams.get('search')).toBe('match');
    expect(nextUrl.searchParams.get('sort')).toBe('size');
    expect(nextUrl.searchParams.get('order')).toBe('desc');
    expect(nextUrl.searchParams.get('page')).toBe('2');
    expect(nextUrl.searchParams.get('pageSize')).toBe('1');
    expect(nextUrl.searchParams.get('view')).toBe('list');

    const pageSizeForm = response.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0];
    expect(pageSizeForm).toContain(`<input type="hidden" name="category" value="${category.id}">`);
    expect(pageSizeForm).toContain('<input type="hidden" name="search" value="match">');

    const modifiedResponse = await agent
      .get(`/projects/${id}/assets?category=${category.id}&sort=modified`)
      .expect(200);
    const modifiedActionPanel = assetActionsPanelHtml(modifiedResponse.text);
    expectProjectActionsSection(modifiedActionPanel, { selectionOnly: true });
    expect((modifiedActionPanel.match(/<h2 id="project-actions-heading">Project actions<\/h2>/g) || [])).toHaveLength(1);
    expect(modifiedActionPanel).not.toContain('Drag assets to change their filename order');
    expect(modifiedActionPanel).toContain('<h3 class="asset-action-group-heading">Release</h3>');
    expect(modifiedActionPanel).toContain('<h3 class="asset-action-group-heading">File</h3>');

    const disabledResponse = await agent
      .get(`/projects/${id}/assets?category=${disabledCategory.id}`)
      .expect(200);
    const disabledActionPanel = assetActionsPanelHtml(disabledResponse.text);
    expectProjectActionsSection(disabledActionPanel, { selectionOnly: true });
    expect((disabledActionPanel.match(/<h2 id="project-actions-heading">Project actions<\/h2>/g) || [])).toHaveLength(1);
    expect(disabledActionPanel).not.toContain('Drag assets to change their filename order');

    for (const categoryQuery of ['category=all', 'category=uncategorized']) {
      const ordinaryResponse = await agent.get(`/projects/${id}/assets?${categoryQuery}`).expect(200);
      const ordinaryActionPanel = assetActionsPanelHtml(ordinaryResponse.text);
      expectProjectActionsSection(ordinaryActionPanel, { selectionOnly: true });
      expect((ordinaryActionPanel.match(/<h2 id="project-actions-heading">Project actions<\/h2>/g) || [])).toHaveLength(1);
      expect(ordinaryActionPanel).not.toContain('Drag assets to change their filename order');
    }
  });

  // ─── Filename / location / category presentation ────────────────

  it('renders Project List filename, location, category, and selection labels', async () => {
    const res = await createProject('Project List Identity');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const exportsCategory = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Exports', directorySlug: 'my-exports', displayOrder: 0, enabled: true,
    });
    const sourceCategory = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Source', directorySlug: 'my-source', displayOrder: 1, enabled: true,
    });
    const final = assetRepo.upsert(id, 'exports/web/social/final.png', {
      filename: 'final.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: exportsCategory.id, nestedPath: 'web/social',
    });
    const artwork = assetRepo.upsert(id, 'source/artwork.kra', {
      filename: 'artwork.kra', extension: 'kra', mimeType: 'application/x-krita',
      sizeBytes: 10, modifiedAt: null, categoryId: sourceCategory.id, nestedPath: '',
    });
    const notes = assetRepo.upsert(id, 'notes.txt', {
      filename: 'notes.txt', extension: 'txt', mimeType: 'text/plain',
      sizeBytes: 10, modifiedAt: null,
    });
    const unknown = assetRepo.upsert(id, 'unknown/deep/file.txt', {
      filename: 'file.txt', extension: 'txt', mimeType: 'text/plain',
      sizeBytes: 10, modifiedAt: null, nestedPath: 'unknown/deep',
    });

    const response = await agent.get(`/projects/${id}/assets?pageSize=100&view=list`).expect(200);
    const assertIdentity = (asset, basename, location, category, selectionLabel) => {
      const card = assetListCardHtml(response.text, asset.id);
      expect(card).not.toBe('');
      const title = card.match(/<h2 class="asset-list-card-title">([\s\S]*?)<\/h2>/)?.[1] || '';
      expect(title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).toBe(basename);
      expect(anchorHref(card, 'asset-details-link')).not.toBeNull();
      if (location) expect(card).toContain(location);
      else expect(card).not.toContain('data-asset-containing-location');
      expect(card).toContain(category);
      expect(card).toContain(`aria-label="Select ${selectionLabel}"`);
    };

    assertIdentity(final, 'final', 'web/social', 'Exports', 'exports/web/social/final.png');
    assertIdentity(artwork, 'artwork', null, 'Source', 'source/artwork.kra');
    assertIdentity(notes, 'notes', 'Project root', 'Uncategorized', 'notes.txt');
    assertIdentity(unknown, 'file', 'unknown/deep', 'Uncategorized', 'unknown/deep/file.txt');
  });
  it('shows a distinct empty state for the missing filter when nothing is missing', async () => {
    const res = await createProject('Missing Filter Empty');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Missing Filter Empty');
    fs.writeFileSync(path.join(projectDir, 'present.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?presence=missing`).expect(200);
    expect(res2.text).toContain('No missing assets');
    expect(res2.text).not.toContain('No assets match the current filters');
  });

  // ─── Release usage summaries ────────────────────────────────────

  it('renders accessible Project List release usage links and summaries', async () => {
    const res = await createProject('Release Summaries');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Release Summaries');
    const none = writeIndexedAsset(id, projectDir, 'none.png', await makePng());
    const single = writeIndexedAsset(id, projectDir, 'single.png', await makePng());
    const multi = writeIndexedAsset(id, projectDir, 'multi.png', await makePng());

    const singleReleaseId = await createReleaseUsingAsset(id, single.id, 'Solo Release', 'planned');
    const firstMultiReleaseId = await createReleaseUsingAsset(id, multi.id, 'Release One', 'tbd');
    const secondMultiReleaseId = await createReleaseUsingAsset(id, multi.id, 'Release Two', 'tbd');

    const response = await agent.get(`/projects/${id}/assets?pageSize=100&view=list`).expect(200);
    const noneCard = assetListCardHtml(response.text, none.id);
    const singleCard = assetListCardHtml(response.text, single.id);
    const multiCard = assetListCardHtml(response.text, multi.id);

    expect(noneCard).toContain('aria-label="Not used by a release"');
    expect(noneCard).not.toContain('asset-list-card-association--releases');

    expect(singleCard).toContain(`href="/releases/${singleReleaseId}"`);
    expect(singleCard).toContain('>Solo Release</a>');
    expect(singleCard).toContain('aria-label="Used in release Solo Release (Attachment)"');

    expect(multiCard).toContain('data-asset-release-membership');
    expect(multiCard).toContain('aria-label="Used in 2 releases"');
    expect(multiCard).toContain(`href="/releases/${firstMultiReleaseId}"`);
    expect(multiCard).toContain(`href="/releases/${secondMultiReleaseId}"`);
    expect(multiCard).toContain('>Release One</a>');
    expect(multiCard).toContain('>Release Two</a>');
  });

  it('keeps rendered release usage scoped to the asset and its project', async () => {
    const res = await createProject('Scoped Release Usage');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const asset = writeIndexedAsset(id, getProjectDir('Scoped Release Usage'), 'owned.png', await makePng());
    const ownReleaseId = await createReleaseUsingAsset(id, asset.id, 'Owned Release');

    const other = await createProject('Foreign Release Usage');
    const foreignReleaseId = await createEmptyRelease(
      Number(other.headers.location.replace('/projects/', '')),
      'Foreign Release',
    );
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(foreignReleaseId, asset.id, 'attachment', 0);

    const response = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const card = assetListCardHtml(response.text, asset.id);

    expect(card).toContain(`href="/releases/${ownReleaseId}"`);
    expect(card).toContain('Owned Release');
    expect(card).not.toContain(`href="/releases/${foreignReleaseId}"`);
    expect(card).not.toContain('Foreign Release');
  });

  it('renders an empty alt attribute on thumbnails since the adjacent filename already identifies the row', async () => {
    const res = await createProject('Empty Alt Thumb');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Empty Alt Thumb');
    writeIndexedAsset(id, projectDir, 'identified.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('alt=""');
  });

  // ─── Phase 3 chunk 3: page-local selection + bulk release association ───

  async function createEmptyRelease(projectId, title = 'Bulk Target') {
    const res = await agent
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseId = Number(res.headers.location.replace('/releases/', ''));
    return releaseId;
  }

  describe('page-local selection markup', () => {
    it('renders the shared bulk handoff form and its current-page selection hooks', async () => {
      const res = await createProject('Grouped Selected Actions');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Grouped Selected Actions');
      const first = writeIndexedAsset(id, projectDir, 'first.png', await makePng());
      const second = writeIndexedAsset(id, projectDir, 'second.png', await makePng());

      const response = await agent
        .get(`/projects/${id}/assets?view=list&search=first&pageSize=50`)
        .expect(200);
      const form = response.text.match(/<form id="bulk-select-form"[\s\S]*?<\/form>/)?.[0] || '';
      const controls = assetSelectionControlsHtml(response.text);

      expect(form).toMatch(new RegExp(`<form id="bulk-select-form" method="post" action="/projects/${id}/assets/add-to-release"`));
      expect(form).toMatch(/<input type="hidden" name="_csrf" value="[^"]+">/);
      expect(form).toContain('name="returnTo" value=""');
      expect(form).toContain('name="search" value="first"');
      expect(form).toContain('name="pageSize" value="50"');
      expect(form).toContain('name="view" value="list"');
      expect(form).toContain(`formaction="/projects/${id}/assets/create-release"`);
      expect(form).toContain(`formaction="/projects/${id}/assets/move-selected"`);
      expect(form).toContain(`formaction="/projects/${id}/assets/copy-selected"`);
      expect(form).toContain(`formaction="/projects/${id}/assets/delete-selected"`);
      expect(controls).toContain('role="group" aria-label="Selection controls"');
      expect(controls).toContain('form="bulk-select-form"');
      expect(controls).toContain('data-select-all');
      expect(controls).toContain('aria-label="Select all visible"');
      expect(controls).toContain('data-clear-selection');
      expect(controls).toContain('aria-label="Clear selection"');
      expect(response.text).toContain(`name="selectedAssetIds" value="${first.id}"`);
      expect(response.text).not.toContain(`name="selectedAssetIds" value="${second.id}"`);
      expect(response.text).toContain('data-selected-count data-selected-total="1"');
    });

    it('renders only this project\'s eligible releases as add-to-release targets', async () => {
      const res = await createProject('Scoped Release Targets');
      const id = Number(res.headers.location.replace('/projects/', ''));
      writeIndexedAsset(id, getProjectDir('Scoped Release Targets'), 'available.png', await makePng());
      const eligibleId = await createEmptyRelease(id, 'Eligible <Target>');
      const archivedId = await createEmptyRelease(id, 'Archived Target');
      const publishedId = await createEmptyRelease(id, 'Published Target');
      db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(archivedId);
      db.prepare("UPDATE releases SET published_date = '2026-09-21' WHERE id = ?").run(publishedId);

      const other = await createProject('Foreign Release Targets');
      const foreignId = await createEmptyRelease(
        Number(other.headers.location.replace('/projects/', '')),
        'Foreign Target',
      );

      const response = await agent.get(`/projects/${id}/assets`).expect(200);
      const select = response.text.match(/<select id="releaseId-action-native"[^>]*>[\s\S]*?<\/select>/)?.[0] || '';

      expect(select).toContain(`value="${eligibleId}"`);
      expect(select).toContain('Eligible &lt;Target&gt;');
      expect(select).not.toContain('Eligible <Target>');
      expect(select).not.toContain(`value="${archivedId}"`);
      expect(select).not.toContain(`value="${publishedId}"`);
      expect(select).not.toContain(`value="${foreignId}"`);
      expect(select).not.toContain('Foreign Target');
    });

    it('archived projects render no selection controls and no bulk mutation form', async () => {
      const res = await createProject('Selection Archived');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Selection Archived');
      writeIndexedAsset(id, projectDir, 'a.png', await makePng());
      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res2.text).not.toContain('name="selectedAssetIds"');
      expect(res2.text).not.toContain('add-to-release');
      expect(res2.text).not.toContain('data-select-all');
      expect(res2.text).not.toContain('data-release-select');
      expect(res2.text).not.toContain('data-selected-count');
    });
  });

  describe('POST /projects/:id/assets/add-to-release', () => {
    it('rejects a request with a missing or invalid CSRF token', async () => {
      const res = await createProject('Bulk CSRF');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk CSRF');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());
      const releaseId = await createEmptyRelease(id);

      await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(releaseId), selectedAssetIds: String(asset.id), _csrf: 'not-a-real-token' })
        .expect(403);
    });

    it('works with a plain no-JavaScript form submission and redirects to the same normalized browser context', async () => {
      const res = await createProject('Bulk No JS');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk No JS');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());
      const releaseId = await createEmptyRelease(id);
      const unintendedReleaseId = await createEmptyRelease(id, 'Bulk No JS Unintended');

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({
           releaseId: String(releaseId),
           selectedAssetIds: String(asset.id),
           category: 'all',
           presence: 'present',
          sort: 'size',
          page: '1',
          _csrf: csrfToken,
        })
        .expect(302);

       const redirect = new URL(res2.headers.location, 'http://localhost');
       expect(redirect.pathname).toBe(`/projects/${id}/assets`);
       expect(redirect.searchParams.get('category')).toBe('all');
      expect(redirect.searchParams.get('presence')).toBe('present');
      expect(redirect.searchParams.get('sort')).toBe('size');
      expect(redirect.searchParams.get('bulk_added')).toBe('1');
      expect(redirect.searchParams.get('bulk_already')).toBe('0');
      expect(redirect.searchParams.has('view')).toBe(false);

      const releaseService = createReleaseService({ db });
      expect(releaseService.listReleaseAssets(releaseId).map((row) => row.asset_id)).toEqual([asset.id]);
      expect(releaseService.listReleaseAssets(unintendedReleaseId)).toEqual([]);

      const res3 = await agent.get(res2.headers.location).expect(200);
      expect(res3.text).toContain('Added 1 asset to the release.');
    });

    it('reports added and already-associated counts, and skips already-associated assets safely', async () => {
      const res = await createProject('Bulk Mixed');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Mixed');
      const already = writeIndexedAsset(id, projectDir, 'already.png', await makePng());
      const fresh = writeIndexedAsset(id, projectDir, 'fresh.png', await makePng());
      const releaseId = await createReleaseUsingAsset(id, already.id, 'Mixed Release', 'tbd');

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({
          releaseId: String(releaseId),
          selectedAssetIds: [String(already.id), String(fresh.id)],
          _csrf: csrfToken,
        })
        .expect(302);

      const res3 = await agent.get(res2.headers.location).expect(200);
      expect(res3.text).toContain('Added 1 asset to the release.');
      expect(res3.text).toContain('1 were already associated and were skipped.');
    });

    it('controlled rejection when no assets are selected, preserving the chosen release', async () => {
      const res = await createProject('Bulk Empty Selection');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Empty Selection');
      writeIndexedAsset(id, projectDir, 'a.png', await makePng());
      const releaseId = await createEmptyRelease(id, 'Empty Selection Target');

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(releaseId), category: 'all', _csrf: csrfToken })
        .expect(422);

       expect(res2.text).toContain('At least one asset must be selected.');
       expect(res2.text).toContain(`value="${releaseId}" selected`);
       expect(res2.text).toContain('<input type="hidden" name="category" value="all">');
    });

    it('controlled rejection for malformed asset IDs, preserving the submitted selection', async () => {
      const res = await createProject('Bulk Malformed Ids');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Malformed Ids');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());
      writeIndexedAsset(id, projectDir, 'unselected.png', await makePng());
      const releaseId = await createEmptyRelease(id, 'Malformed Target');

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({
          releaseId: String(releaseId),
          selectedAssetIds: [String(asset.id), 'not-a-number'],
          _csrf: csrfToken,
        })
        .expect(422);

      expect(res2.text).toContain('Asset IDs must be positive integers.');
      expect(checkedBulkSelectionIds(res2.text)).toEqual([String(asset.id)]);
    });

    it('controlled rejection for duplicate asset IDs', async () => {
      const res = await createProject('Bulk Duplicate Ids');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Duplicate Ids');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());
      const releaseId = await createEmptyRelease(id, 'Duplicate Target');

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({
          releaseId: String(releaseId),
          selectedAssetIds: [String(asset.id), String(asset.id)],
          _csrf: csrfToken,
        })
        .expect(422);

      expect(res2.text).toContain('Duplicate asset IDs are not allowed.');
    });

    it('rejects missing, unknown, and foreign release targets without leaking project scope', async () => {
      const res = await createProject('Bulk Cross Project Release');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Cross Project Release');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());

      const missing = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ selectedAssetIds: String(asset.id), _csrf: csrfToken })
        .expect(422);
      expect(missing.text).toContain('releaseId must be a positive integer.');

      const unknown = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: '999999', selectedAssetIds: String(asset.id), _csrf: csrfToken })
        .expect(404);

      const otherRes = await createProject('Bulk Cross Project Release Other');
      const otherId = Number(otherRes.headers.location.replace('/projects/', ''));
      const otherReleaseId = await createEmptyRelease(otherId, 'Foreign Release');

      const foreign = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(otherReleaseId), selectedAssetIds: String(asset.id), _csrf: csrfToken })
        .expect(404);

      for (const response of [unknown, foreign]) {
        expect(response.text).not.toMatch(/at .*:\d+:\d+/);
        expect(response.text).not.toContain('SELECT');
      }
    });

    it('controlled rejection when a submitted asset belongs to another project', async () => {
      const res = await createProject('Bulk Cross Project Asset');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const releaseId = await createEmptyRelease(id, 'Cross Asset Target');

      const otherRes = await createProject('Bulk Cross Project Asset Other');
      const otherId = Number(otherRes.headers.location.replace('/projects/', ''));
      const otherProjectDir = getProjectDir('Bulk Cross Project Asset Other');
      const foreignAsset = writeIndexedAsset(otherId, otherProjectDir, 'theirs.png', await makePng());

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(releaseId), selectedAssetIds: String(foreignAsset.id), _csrf: csrfToken })
        .expect(422);

      // Apostrophe is HTML-escaped by the autoescaping template engine.
      expect(res2.text).toContain('does not belong to the release');
    });

    it('controlled rejection when a selected asset is missing', async () => {
      const res = await createProject('Bulk Missing Asset');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Missing Asset');
      const gone = writeIndexedAsset(id, projectDir, 'gone.png', await makePng());
      assetRepo.markMissingByProjectIdAndPathNotIn(id, []);
      const releaseId = await createEmptyRelease(id, 'Missing Asset Target');

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(releaseId), selectedAssetIds: String(gone.id), _csrf: csrfToken })
        .expect(422);

      expect(res2.text).toContain('is currently missing and cannot be added');
    });

    it('controlled rejection when the project is archived, even if the form is submitted directly', async () => {
      const res = await createProject('Bulk Archived Project');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Archived Project');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());
      const releaseId = await createEmptyRelease(id, 'Pre Archive Target');
      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(releaseId), selectedAssetIds: String(asset.id), _csrf: csrfToken })
        .expect(422);

      expect(res2.text).toContain('archived');
    });

    it('rechecks archived and published release eligibility at POST time', async () => {
      const res = await createProject('Bulk Published Release');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Published Release');
      const primaryAsset = writeIndexedAsset(id, projectDir, 'primary.png', await makePng());
      const staleArchivedReleaseId = await createEmptyRelease(id, 'Stale archived target');
      db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(staleArchivedReleaseId);
      const extra = writeIndexedAsset(id, projectDir, 'extra.png', await makePng());

      const archived = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(staleArchivedReleaseId), selectedAssetIds: String(extra.id), _csrf: csrfToken })
        .expect(422);
      expect(archived.text).toContain('archived');

      const releaseId = await createReleaseUsingAsset(id, primaryAsset.id, 'To Publish', 'ready');
      await agent.post(`/releases/${releaseId}/publish`).send('publishedDate=2026-01-01').send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const published = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(releaseId), selectedAssetIds: String(extra.id), _csrf: csrfToken })
        .expect(422);

      expect(published.text).toContain('published');
    });

    it('returns 404 for an invalid project ID', async () => {
      await agent
        .post('/projects/abc/assets/add-to-release')
        .type('form')
        .send({ releaseId: '1', selectedAssetIds: '1', _csrf: csrfToken })
        .expect(404);
    });

  });

  describe('POST /projects/:id/assets/create-release', () => {
    it('hands a validated exact selection to the canonical Releases host with a 307 redirect', async () => {
      const res = await createProject('Create Release From Assets');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Create Release From Assets');
      const first = writeIndexedAsset(id, projectDir, 'first.png', await makePng());
      const second = writeIndexedAsset(id, projectDir, 'second.png', await makePng());
      const returnTo = `/projects/${id}/assets?view=list&search=cover&page=3#asset-${second.id}`;

      const handoff = await agent
        .post(`/projects/${id}/assets/create-release`)
        .type('form')
        .send({
          selectedAssetIds: [String(second.id), String(first.id)],
          returnTo,
          _csrf: csrfToken,
        })
        .expect(307);

      expect(handoff.headers.location).toBe(`/releases?new=assets&projectId=${id}`);
    });

    it('re-renders with 422 for an empty selection and creates no release', async () => {
      const res = await createProject('Create Release Empty Selection');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Create Release Empty Selection');
      writeIndexedAsset(id, projectDir, 'available.png', await makePng());

      const rejected = await agent
        .post(`/projects/${id}/assets/create-release`)
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(422);

      expect(rejected.text).toContain('At least one asset must be selected.');
      expect(rejected.text).toContain(`action="/projects/${id}/assets/add-to-release"`);
      expect(rejected.text).not.toContain('Releases — Create Release');
      const releaseService = createReleaseService({ db });
      expect(releaseService.listReleases(id, { includeArchived: true })).toEqual([]);
    });

    it('rejects malformed, missing, and cross-project selections without creating a release', async () => {
      const res = await createProject('Create Release Invalid Selection');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Create Release Invalid Selection');
      const ownAsset = writeIndexedAsset(id, projectDir, 'own.png', await makePng());

      const invalid = await agent
        .post(`/projects/${id}/assets/create-release`)
        .type('form')
        .send({ selectedAssetIds: [String(ownAsset.id), 'not-an-id'], _csrf: csrfToken })
        .expect(422);
      expect(invalid.text).toContain('Asset IDs must be positive integers.');
      expect(invalid.text).toContain(`action="/projects/${id}/assets/add-to-release"`);
      expect(invalid.text).not.toContain('Releases — Create Release');

      const missingAsset = writeIndexedAsset(id, projectDir, 'missing.png', await makePng());
      db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(missingAsset.id);
      const missing = await agent
        .post(`/projects/${id}/assets/create-release`)
        .type('form')
        .send({ selectedAssetIds: String(missingAsset.id), _csrf: csrfToken })
        .expect(422);
      expect(missing.text).toContain('currently missing and cannot be selected');
      expect(missing.text).toContain(`action="/projects/${id}/assets/add-to-release"`);
      expect(missing.text).not.toContain('Releases — Create Release');

      const otherRes = await createProject('Create Release Foreign Project');
      const otherId = Number(otherRes.headers.location.replace('/projects/', ''));
      const otherProjectDir = getProjectDir('Create Release Foreign Project');
      const foreignAsset = writeIndexedAsset(otherId, otherProjectDir, 'foreign.png', await makePng());

      const crossProject = await agent
        .post(`/projects/${id}/assets/create-release`)
        .type('form')
        .send({ selectedAssetIds: String(foreignAsset.id), _csrf: csrfToken })
        .expect(422);
      expect(crossProject.text).toContain('does not belong to the specified project.');
      expect(crossProject.text).toContain(`action="/projects/${id}/assets/add-to-release"`);
      expect(crossProject.text).not.toContain('Releases — Create Release');

      const releaseService = createReleaseService({ db });
      expect(releaseService.listReleases(id, { includeArchived: true })).toEqual([]);
    });

    it('re-renders with the service validation status for an archived project', async () => {
      const res = await createProject('Create Release Archived Project');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Create Release Archived Project');
      const asset = writeIndexedAsset(id, projectDir, 'archived.png', await makePng());
      await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

      const rejected = await agent
        .post(`/projects/${id}/assets/create-release`)
        .type('form')
        .send({ selectedAssetIds: String(asset.id), _csrf: csrfToken })
        .expect(422);

      expect(rejected.text).toContain('Cannot create release for archived project.');
      const releaseService = createReleaseService({ db });
      expect(releaseService.listReleases(id, { includeArchived: true })).toEqual([]);
    });
  });

  describe('manual scan context preservation and result notices', () => {
    it('scan form carries normalized browser context as hidden fields', async () => {
      const res = await createProject('Scan Context Form');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Scan Context Form');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent.get(`/projects/${id}/assets?search=hero&presence=present&sort=size&order=desc&pageSize=50`).expect(200);
      const formMatch = res2.text.match(/<form method="post" action="\/projects\/\d+\/scan"[^>]*>[\s\S]*?<\/form>/);
      expect(formMatch).not.toBeNull();
      const form = formMatch[0];
      expect(form).toContain('<input type="hidden" name="category" value="all">');
      expect(form).toContain('<input type="hidden" name="search" value="hero">');
      expect(form).toContain('<input type="hidden" name="presence" value="present">');
      expect(form).toContain('<input type="hidden" name="sort" value="size">');
      expect(form).toContain('<input type="hidden" name="order" value="desc">');
      expect(form).toContain('<input type="hidden" name="pageSize" value="50">');
    });

    it('a successful scan redirects preserving category/search/extension/presence/usage/sort/order/page/pageSize and strips unknown fields', async () => {
      const res = await createProject('Scan Preserve Context');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Scan Preserve Context');
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(projectDir, `f${i}.png`), `c${i}`);
      }
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent
        .post(`/projects/${id}/scan`)
        .type('form')
        .send({
          category: 'all', search: 'f1', extension: '.png', presence: 'present', usage: 'unused',
          sort: 'size', order: 'desc', page: '1', pageSize: '10',
          junk: 'strip-me', _csrf: csrfToken,
        })
        .expect(302);

      const redirect = new URL(res2.headers.location, 'http://localhost');
      expect(redirect.pathname).toBe(`/projects/${id}/assets`);
      expect(redirect.searchParams.get('category')).toBe('all');
      expect(redirect.searchParams.get('search')).toBe('f1');
      expect(redirect.searchParams.get('extension')).toBe('png');
      expect(redirect.searchParams.get('presence')).toBe('present');
      expect(redirect.searchParams.get('usage')).toBe('unused');
      expect(redirect.searchParams.get('sort')).toBe('size');
      expect(redirect.searchParams.get('order')).toBe('desc');
      expect(redirect.searchParams.get('pageSize')).toBe('10');
      expect(redirect.searchParams.has('junk')).toBe(false);
      expect(redirect.searchParams.has('view')).toBe(false);
    });

    it('an invalid submitted category normalizes to All rather than erroring or leaking existence', async () => {
      const res = await createProject('Scan Invalid Category');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Scan Invalid Category');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');

      const res2 = await agent
        .post(`/projects/${id}/scan`)
        .type('form')
        .send({ category: '999999', _csrf: csrfToken })
        .expect(302);

      const redirect = new URL(res2.headers.location, 'http://localhost');
      expect(redirect.searchParams.get('category')).toBe('all');
    });

    it('displays Added/Updated/Missing/Total labels, with the scanner\'s "removed" shown as "Missing"', async () => {
      const res = await createProject('Scan Result Labels');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Scan Result Labels');
      fs.writeFileSync(path.join(projectDir, 'keep.png'), 'png');
      fs.writeFileSync(path.join(projectDir, 'gone.png'), 'png');
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      fs.rmSync(path.join(projectDir, 'gone.png'));
      fs.writeFileSync(path.join(projectDir, 'new.png'), 'png');
      const res2 = await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res3 = await agent.get(res2.headers.location).expect(200);
      expect(res3.text).toContain('Added: 1');
      expect(res3.text).toContain('Updated: 0');
      expect(res3.text).toContain('Missing: 1');
      expect(res3.text).toContain('3 total assets');
      expect(res3.text).not.toContain('removed=');
    });

    it('does not render the removed scan disclaimer after scanning', async () => {
      const res = await createProject('Scan Disclaimer Removed');
      const id = res.headers.location.replace('/projects/', '');
      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res2.text).not.toContain('scan-freshness');
      expect(res2.text).not.toContain('Disabled categories are still scanned');
    });

    it('does not accept an arbitrary return URL — the redirect is always the canonical browser path for this project', async () => {
      const res = await createProject('Scan No Arbitrary Redirect');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Scan No Arbitrary Redirect');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');

      const res2 = await agent
        .post(`/projects/${id}/scan`)
        .type('form')
        .send({ returnUrl: 'https://evil.example/steal', redirect: '/settings', next: '//evil.example', _csrf: csrfToken })
        .expect(302);

      const redirect = new URL(res2.headers.location, 'http://localhost');
      expect(redirect.hostname).toBe('localhost');
      expect(redirect.pathname).toBe(`/projects/${id}/assets`);
    });

    it('scan failure is safe and does not partially update the database', async () => {
      const res = await createProject('Scan Failure Safety');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Scan Failure Safety');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const before = assetRepo.findByProjectId(id).length;

      // Remove the project directory to force a filesystem scan error.
      fs.rmSync(projectDir, { recursive: true, force: true });

      const res2 = await agent.post(`/projects/${id}/scan`).send({ category: 'all', _csrf: csrfToken }).type('form').expect(302);
      const redirect = new URL(res2.headers.location, 'http://localhost');
      expect(redirect.searchParams.get('scan_error')).toBe('filesystem');
      expect(redirect.searchParams.get('category')).toBe('all');

      const after = assetRepo.findByProjectId(id).length;
      expect(after).toBe(before);

      const res3 = await agent.get(res2.headers.location).expect(200);
      expect(res3.text).not.toMatch(/[A-Z]:\\/);
      expect(res3.text).not.toMatch(/\/home\//);
      expect(res3.text).not.toContain(tmpDir);
    });
  });

  // ─── Phase: asset actions chunk 4 — rename/move HTTP integration ───────

  describe('asset viewer rename/move', () => {
    function buildStubActionApp(actionServiceStub) {
      const appDataRootLocal = path.join(tmpDir, 'app');
      const { csrfPepper } = ensureAuthEnablement(appDataRootLocal);
      return createApp(
        { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
        { appDataRoot: appDataRootLocal, authState: { csrfPepper }, assetActionService: actionServiceStub }
      );
    }

    async function setupProjectWithAsset(title, relPath = 'a.png') {
      const res = await createProject(title);
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir(title);
      const asset = writeIndexedAsset(id, projectDir, relPath, await makePng());
      return { id, projectDir, asset };
    }

    async function setupProjectWithKrita(title, extension, entries) {
      const res = await createProject(title);
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir(title);
      const asset = writeIndexedAsset(
        id,
        projectDir,
        `source.${extension}`,
        makeKritaArchive(entries),
      );
      return { id, projectDir, asset };
    }

    function makeEnabledCategory(projectId, projectDir, slug, displayName = 'Renders') {
      const category = assetCategoryRepo.addProjectCategory({
        projectId, displayName, directorySlug: slug, displayOrder: 0, enabled: true,
      });
      fs.mkdirSync(path.join(projectDir, slug), { recursive: true });
      return category;
    }

    // ─── Viewer rendering ──────────────────────────────────────────────

    describe('viewer rendering', () => {
      it('renders the server-rendered Edit Asset dialog with sibling Primary image and File action forms', async () => {
        const { id, asset } = await setupProjectWithAsset('Viewer Forms Mutable');
        const selectedTag = app.locals.tagService.createTag({ name: 'Alpha dialog tag' });
        const secondSelectedTag = app.locals.tagService.createTag({ name: 'Beta dialog tag' });
        const availableTag = app.locals.tagService.createTag({ name: 'Available dialog tag' });
        app.locals.assetTagService.replaceAssetTags(asset.id, [selectedTag.id, secondSelectedTag.id]);

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
        const dialogStart = res.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialogEnd = res.text.indexOf('</dialog>', dialogStart);
        const dialogHtml = res.text.slice(dialogStart, dialogEnd + '</dialog>'.length);
        const pageHtml = res.text.slice(0, dialogStart) + res.text.slice(dialogEnd + '</dialog>'.length);

        expect(dialogStart).toBeGreaterThan(-1);
        expect(dialogHtml).not.toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
        expect(dialogHtml).toContain('class="app-dialog-body asset-edit-dialog-body"');
        expect(dialogHtml).toContain('class="app-dialog-status" data-dialog-status role="status" aria-live="polite"');
        expect((dialogHtml.match(/<h3[^>]*>Primary image<\/h3>/g) || []).length).toBe(1);
        const primaryImageSectionStart = dialogHtml.indexOf('class="settings-section asset-edit-dialog-section asset-primary-image-section"');
        const primaryImageSectionEnd = dialogHtml.indexOf('</section>', primaryImageSectionStart);
        const primaryImageSection = dialogHtml.slice(primaryImageSectionStart, primaryImageSectionEnd + '</section>'.length);
        expect(primaryImageSection).toContain('class="asset-edit-dialog-section-body asset-primary-image-section-body"');
        expect(primaryImageSection).not.toContain('asset-action-group');
        expect(primaryImageSection).toContain('Choose the image used to represent this project.');
        expect(dialogHtml).toContain('<h3 id="asset-actions-heading">File actions</h3>');
        expect(dialogHtml).toContain('<h3 id="asset-tags-edit-heading">Tags</h3>');
        expect(dialogHtml).toContain(`id="asset-edit-form" method="post" action="/projects/${id}/assets/${asset.id}/tags"`);
        expect(dialogHtml).toContain('data-dialog-form data-dialog-async="false"');
        expect(dialogHtml).toContain('name="tagIds[]"');
        expect(dialogHtml).toContain(`value="${selectedTag.id}" checked`);
        expect(dialogHtml).toContain(`value="${secondSelectedTag.id}" checked`);
        expect(dialogHtml).toContain(`value="${availableTag.id}"`);
        expect(dialogHtml).toContain('aria-label="Tags: 2 tags selected"');
        expect(dialogHtml).not.toContain('Save tags');
        expect(dialogHtml).not.toMatch(/<button[^>]*\bform="asset-edit-form"/);
        expect(dialogHtml).not.toContain('data-dialog-submit');
        expect(dialogHtml).not.toContain('app-dialog-footer');
        expect(dialogHtml).toContain('id="asset-edit-form"');
        expect(dialogHtml).toContain('data-autosubmit="submit"');
        expect(dialogHtml).toContain('<summary>Rename file</summary>');
        expect(dialogHtml).toContain('<summary>Move file</summary>');
        expect(dialogHtml).toContain('<summary>Delete asset</summary>');
        expect(dialogHtml).toContain('notes-workspace-disclosure--delete');

        expect(dialogHtml).toContain(`action="/projects/${id}/assets/${asset.id}/primary-image"`);
        expect(dialogHtml).toContain(`action="/projects/${id}/assets/${asset.id}/rename"`);
        expect(dialogHtml).toContain(`action="/projects/${id}/assets/${asset.id}/move"`);
        expect(dialogHtml).toContain(`action="/projects/${id}/assets/${asset.id}/delete"`);
        expect(dialogHtml).toContain('data-confirm="The file will be permanently deleted from disk and cannot be restored through CreatorCrate. Continue?"');
        expect((dialogHtml.match(/name="_csrf"/g) || []).length).toBe(5);
        expect((dialogHtml.match(/<form\b/g) || []).length).toBe(5);
        expect((dialogHtml.match(/<\/form>/g) || []).length).toBe(5);
        const tagFormStart = dialogHtml.indexOf('id="asset-edit-form"');
        const tagFormEnd = dialogHtml.indexOf('</form>', tagFormStart);
        expect(dialogHtml.slice(tagFormStart, tagFormEnd)).not.toContain('<form');

        expect(pageHtml).not.toContain('Primary image');
        expect(pageHtml).not.toContain('File actions');
        expect(pageHtml).not.toContain(`action="/projects/${id}/assets/${asset.id}/rename"`);
        expect(pageHtml).not.toContain('name="tagIds[]"');
        const viewerTags = pageHtml.match(/<section class="[^"]*\basset-tags-section\b[^"]*"[\s\S]*?<\/section>/)?.[0] || '';
        expect(viewerTags).toContain('<ul class="tag-chip-list">');
        expect(viewerTags).toContain('<li class="tag-chip">Alpha dialog tag</li>');
        expect(viewerTags).toContain('<li class="tag-chip">Beta dialog tag</li>');
        expect(viewerTags.indexOf('Alpha dialog tag')).toBeLessThan(viewerTags.indexOf('Beta dialog tag'));
        expect(viewerTags).not.toMatch(/<ul>\s*<li>/);
        expect(pageHtml).toContain('Metadata');
        expect(pageHtml).toContain('Tags');
        expect(pageHtml).toContain('Release usage');
        expect((res.text.match(/<h1\b/g) || []).length).toBe(1);
      });

      it('keeps the Viewer Tags empty state when no tags are assigned', async () => {
        const { id, asset } = await setupProjectWithAsset('Viewer Tags Empty');
        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
        const dialogStart = res.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialogEnd = res.text.indexOf('</dialog>', dialogStart);
        const pageHtml = res.text.slice(0, dialogStart) + res.text.slice(dialogEnd + '</dialog>'.length);
        const viewerTags = pageHtml.match(/<section class="[^"]*\basset-tags-section\b[^"]*"[\s\S]*?<\/section>/)?.[0] || '';

        expect(viewerTags).toContain('No tags assigned to this asset.');
        expect(viewerTags).not.toContain('tag-chip-list');
        expect(viewerTags).not.toContain('class="tag-chip"');
      });

      it('supplies and renders Edit Asset dialog state without contaminating viewer navigation context', async () => {
        const { id, assets } = await setupOrderedImageAssets('Viewer Edit Dialog Model');
        const selectedTag = app.locals.tagService.createTag({ name: 'Viewer model selected tag' });
        const availableTag = app.locals.tagService.createTag({ name: 'Viewer model available tag' });
        app.locals.assetTagService.replaceAssetTags(assets.bravo.id, [selectedTag.id]);
        const renderSpy = vi.spyOn(app, 'render');
        const viewerUrl = `/projects/${id}/assets/${assets.bravo.id}?category=all&sort=modified&order=desc&view=list`;

        try {
          const normalResponse = await agent.get(viewerUrl).expect(200);
          const normalModel = renderSpy.mock.calls.find(([view]) => view === 'projects/asset-viewer.njk')?.[1];
          expect(normalModel.assetEditDialogOpen).toBe(false);
          expect(normalModel.selectedAssetTagIds).toEqual([String(selectedTag.id)]);
          expect(normalModel.assetTagOptions).toEqual(expect.arrayContaining([
            { value: String(selectedTag.id), label: 'Viewer model selected tag' },
            { value: String(availableTag.id), label: 'Viewer model available tag' },
          ]));
          const normalDialogTag = normalResponse.text.slice(
            normalResponse.text.indexOf('<dialog id="asset-edit-dialog"'),
            normalResponse.text.indexOf('>', normalResponse.text.indexOf('<dialog id="asset-edit-dialog"')) + 1,
          );
          expect(normalDialogTag).not.toContain(' open');

          renderSpy.mockClear();
          const editResponse = await agent.get(`${viewerUrl}&edit=1`).expect(200);
          const editModel = renderSpy.mock.calls.find(([view]) => view === 'projects/asset-viewer.njk')?.[1];
          expect(editModel.assetEditDialogOpen).toBe(true);
          expect(editModel.contextFields).not.toContain('edit');
          const editDialogTag = editResponse.text.slice(
            editResponse.text.indexOf('<dialog id="asset-edit-dialog"'),
            editResponse.text.indexOf('>', editResponse.text.indexOf('<dialog id="asset-edit-dialog"')) + 1,
          );
          expect(editDialogTag).toContain(' open');

          const editUrl = new URL(editModel.assetEditDialogUrl, 'http://localhost');
          expect(editUrl.pathname).toBe(`/projects/${id}/assets/${assets.bravo.id}`);
          expect(editUrl.searchParams.get('category')).toBe('all');
          expect(editUrl.searchParams.get('sort')).toBe('modified');
          expect(editUrl.searchParams.get('order')).toBe('desc');
          expect(editUrl.searchParams.get('view')).toBe('list');
          expect(editUrl.searchParams.get('edit')).toBe('1');

          for (const link of [editModel.backToAssetsLink, editModel.previousAssetLink, editModel.nextAssetLink]) {
            expect(link?.href).not.toContain('edit=1');
          }
        } finally {
          renderSpy.mockRestore();
        }
      });

      it('opens the rendered Edit Asset dialog after a controlled viewer action failure', async () => {
        const { id, asset } = await setupProjectWithAsset('Viewer Edit Dialog Failure', 'original.png');

        const failure = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: '..', category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(422);

        const dialogStart = failure.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialogHtml = failure.text.slice(dialogStart, failure.text.indexOf('</dialog>', dialogStart) + '</dialog>'.length);
        expect(dialogHtml).toContain(' open');
        expect(dialogHtml).toContain('Enter a valid filename.');
        expect(dialogHtml).toContain('value=".."');
      });

      it('the rename input contains the current filename', async () => {
        const { id, asset } = await setupProjectWithAsset('Viewer Rename Prefill', 'original-name.png');
        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
        expect(res.text).toContain('value="original-name.png"');
      });

      it('the move select contains Uncategorized and enabled project categories, but not disabled ones', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Viewer Move Select');
        makeEnabledCategory(id, projectDir, 'renders-enabled', 'Renders Enabled');
        assetCategoryRepo.addProjectCategory({
          projectId: id, displayName: 'Archive Disabled', directorySlug: 'archive-disabled', displayOrder: 1, enabled: false,
        });

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
        expect(res.text).toContain('<option value="uncategorized"');
        expect(res.text).toContain('>Uncategorized</option>');
        expect(res.text).toContain('Renders Enabled');
        expect(res.text).not.toContain('Archive Disabled');
      });

      it('hides the rename/move forms for an archived project', async () => {
        const { id, asset } = await setupProjectWithAsset('Viewer Forms Archived');
        await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
        expect(res.text).not.toContain('class="asset-actions-section"');
        const dialogStart = res.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialogHtml = res.text.slice(dialogStart, res.text.indexOf('</dialog>', dialogStart) + '</dialog>'.length);
        expect(dialogHtml).not.toContain('id="asset-edit-form"');
        expect(dialogHtml).not.toContain('name="tagIds[]"');
      });

      it('hides the rename/move forms for a missing asset', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Viewer Forms Missing', 'gone.png');
        fs.rmSync(path.join(projectDir, 'gone.png'));
        await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
        expect(res.text).not.toContain('class="asset-actions-section"');
      });
    });

    // ─── Primary image viewer state ─────────────────────────────────────
    describe('primary image viewer state', () => {
      it('renders Set as primary image for an eligible present image', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Viewer Eligible', 'eligible.png');

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);

        expect(res.text).toContain(`action="/projects/${id}/assets/${asset.id}/primary-image"`);
        expect(res.text).toContain('>Set as primary image</button>');
        expect(res.text).not.toContain('>Remove primary image</button>');
      });

      it('renders the current available primary state and Remove action', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Viewer Selected', 'selected.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);

        expect(res.text).toContain('<p class="asset-primary-image-status">Currently set as the primary image.</p>');
        expect(res.text).toContain(`action="/projects/${id}/assets/${asset.id}/primary-image/remove"`);
        expect(res.text).toContain('>Remove primary image</button>');
        expect(res.text).not.toContain('>Set as primary image</button>');

        const sectionStart = res.text.indexOf('class="settings-section asset-edit-dialog-section asset-primary-image-section"');
        const sectionEnd = res.text.indexOf('</section>', sectionStart);
        const section = res.text.slice(sectionStart, sectionEnd + '</section>'.length);
        expect((section.match(/<h3[^>]*>Primary image<\/h3>/g) || []).length).toBe(1);
        expect((section.match(/>Primary image</g) || []).length).toBe(1);
      });

      it('retains a missing selected asset and renders its unavailable state with Remove', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Primary Viewer Missing', 'missing.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);

        fs.rmSync(path.join(projectDir, 'missing.png'));
        await agent.post(`/projects/${id}/scan`).send({ _csrf: csrfToken }).type('form').expect(302);

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);

        expect(res.text).toContain('Currently set as the primary image — unavailable until restored.');
        expect(res.text).toContain(`action="/projects/${id}/assets/${asset.id}/primary-image/remove"`);
        expect(res.text).toContain('>Remove primary image</button>');
        expect(res.text).not.toContain('>Set as primary image</button>');
      });

      it('retains a selected asset that becomes unsupported and keeps Remove available', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Viewer Reclassified', 'reclassified.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        db.prepare(
          'UPDATE assets SET extension = ?, mime_type = ? WHERE id = ?'
        ).run('kra', 'application/x-krita', asset.id);

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);

        expect(res.text).toContain('Currently set as the primary image — unavailable until restored.');
        expect(res.text).toContain(`action="/projects/${id}/assets/${asset.id}/primary-image/remove"`);
        expect(res.text).not.toContain('>Set as primary image</button>');
      });

      it('renders no Set action for unsupported or missing non-primary assets', async () => {
        const unsupported = await setupProjectWithAsset('Primary Viewer Unsupported', 'source.kra');
        const unsupportedRes = await agent.get(`/projects/${unsupported.id}/assets/${unsupported.asset.id}`).expect(200);
        expect(unsupportedRes.text).not.toContain('>Set as primary image</button>');

        const missing = await setupProjectWithAsset('Primary Viewer Ineligible Missing', 'gone.png');
        fs.rmSync(path.join(missing.projectDir, 'gone.png'));
        await agent.post(`/projects/${missing.id}/scan`).send({ _csrf: csrfToken }).type('form').expect(302);
        const missingRes = await agent.get(`/projects/${missing.id}/assets/${missing.asset.id}`).expect(200);
        expect(missingRes.text).not.toContain('>Set as primary image</button>');
      });

      it('shows Set and accepts POST only for a merged KRA, not preview-only KRA or KRZ', async () => {
        const merged = await setupProjectWithKrita(
          'Primary Viewer Merged KRA',
          'kra',
          { merged: Buffer.from('merged-preview') },
        );
        const mergedViewer = await agent.get(`/projects/${merged.id}/assets/${merged.asset.id}`).expect(200);
        expect(mergedViewer.text).toContain('>Set as primary image</button>');

        await agent
          .post(`/projects/${merged.id}/assets/${merged.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        const mergedSelected = await agent.get(`/projects/${merged.id}/assets/${merged.asset.id}`).expect(200);
        expect(mergedSelected.text).toContain('<p class="asset-primary-image-status">Currently set as the primary image.</p>');
        expect(mergedSelected.text).toContain('>Remove primary image</button>');

        const previewOnly = await setupProjectWithKrita(
          'Primary Viewer Preview Only KRA',
          'kra',
          { preview: Buffer.from('thumbnail-preview') },
        );
        const previewOnlyViewer = await agent.get(`/projects/${previewOnly.id}/assets/${previewOnly.asset.id}`).expect(200);
        expect(previewOnlyViewer.text).not.toContain('>Set as primary image</button>');
        const previewOnlyPost = await agent
          .post(`/projects/${previewOnly.id}/assets/${previewOnly.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(422);
        expect(previewOnlyPost.text).toContain('This asset type cannot be selected as the primary image.');
        expect(previewOnlyPost.text).not.toContain('preview.png');
        expect(previewOnlyPost.text).not.toContain(tmpDir);

        const krz = await setupProjectWithKrita(
          'Primary Viewer KRZ',
          'krz',
          { preview: Buffer.from('thumbnail-preview') },
        );
        const krzViewer = await agent.get(`/projects/${krz.id}/assets/${krz.asset.id}`).expect(200);
        expect(krzViewer.text).not.toContain('>Set as primary image</button>');
        await agent
          .post(`/projects/${krz.id}/assets/${krz.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(422);
      });

      it('renders archived primary state without any primary-image mutation form', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Viewer Archived', 'archived.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        await agent.post(`/projects/${id}/archive`).send({ _csrf: csrfToken }).type('form').expect(302);

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);

        expect(res.text).toContain('<p class="asset-primary-image-status">Currently set as the primary image.</p>');
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/primary-image"`);
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/primary-image/remove"`);
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/rename"`);
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/move"`);
      });

      it('keeps archived eligible assets Book-primary eligible without changing project-primary eligibility', async () => {
        const archived = await setupProjectWithKrita(
          'Archived Book Primary Eligibility',
          'kra',
          { merged: Buffer.from('merged-preview') },
        );
        const unsupported = await setupProjectWithAsset('Book Primary Unsupported', 'source.kra');
        const missing = await setupProjectWithAsset('Book Primary Missing', 'gone.png');
        fs.rmSync(path.join(missing.projectDir, 'gone.png'));
        await agent.post(`/projects/${missing.id}/scan`).send({ _csrf: csrfToken }).type('form').expect(302);
        await agent.post(`/projects/${archived.id}/archive`).send({ _csrf: csrfToken }).type('form').expect(302);

        const originalRender = app.response.render;
        const viewerLocalsByAssetId = new Map();
        app.response.render = function captureAssetViewerRender(view, locals, ...args) {
          if (view === 'projects/asset-viewer.njk') viewerLocalsByAssetId.set(locals.asset.id, locals);
          return originalRender.call(this, view, locals, ...args);
        };
        try {
          await agent.get(`/projects/${archived.id}/assets/${archived.asset.id}`).expect(200);
          await agent.get(`/projects/${unsupported.id}/assets/${unsupported.asset.id}`).expect(200);
          await agent.get(`/projects/${missing.id}/assets/${missing.asset.id}`).expect(200);
        } finally {
          app.response.render = originalRender;
        }

        expect(viewerLocalsByAssetId.get(archived.asset.id).canSetAsBookPrimaryImage).toBe(true);
        expect(viewerLocalsByAssetId.get(archived.asset.id).canSetAsPrimaryImage).toBe(false);
        expect(viewerLocalsByAssetId.get(unsupported.asset.id).canSetAsBookPrimaryImage).toBe(false);
        expect(viewerLocalsByAssetId.get(missing.asset.id).canSetAsBookPrimaryImage).toBe(false);
      });

      it('keeps a present merged .kra Primary-image eligible across every controlled-rerender origin (D2 regression)', async () => {
        const merged = await setupProjectWithKrita('D2 Merged KRA Rerender', 'kra', { merged: Buffer.from('merged-preview') });

        const getRes = await agent.get(`/projects/${merged.id}/assets/${merged.asset.id}`).expect(200);
        expect(getRes.text).toContain('>Set as primary image</button>');

        // General viewer-action origin (handleAssetActionFailure): renaming
        // to the asset's current filename triggers a controlled 409.
        const renameFailure = await agent
          .post(`/projects/${merged.id}/assets/${merged.asset.id}/rename`)
          .type('form')
          .send({ filename: merged.asset.filename, origin: 'viewer', _csrf: csrfToken })
          .expect(409);
        expect(renameFailure.text).toContain('>Set as primary image</button>');

        // Tag-origin (buildAssetViewerTagFailureRenderModel): an invalid tag
        // selection submitted from the Edit Asset dialog triggers a
        // controlled 422.
        const tagFailure = await agent
          .post(`/projects/${merged.id}/assets/${merged.asset.id}/tags`)
          .type('form')
          .send({ origin: 'asset-edit', tagIds: { bad: 'not-an-id' }, _csrf: csrfToken })
          .expect(422);
        expect(tagFailure.text).toContain('>Set as primary image</button>');

        // Primary-image origin (handlePrimaryImageFailure): set the merged
        // KRA as primary, then race a stale clear against a different asset.
        await agent
          .post(`/projects/${merged.id}/assets/${merged.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        const other = writeIndexedAsset(merged.id, merged.projectDir, 'other.png', await makePng());
        await app.locals.projectPrimaryImageService.setPrimaryImage(merged.id, other.id);
        const primaryImageFailure = await agent
          .post(`/projects/${merged.id}/assets/${merged.asset.id}/primary-image/remove`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(409);
        expect(primaryImageFailure.text).toContain('The primary image changed before it could be removed.');
        expect(primaryImageFailure.text).toContain('>Set as primary image</button>');
      });
    });

    // ─── Primary image Set POST ─────────────────────────────────────────
    describe('POST /projects/:projectId/assets/:assetId/primary-image', () => {
      it('sets the requested asset, forwards its IDs, and redirects with canonical viewer context', async () => {
        const first = await setupProjectWithAsset('Primary Set Success', 'first.png');
        const setPrimaryImage = vi.spyOn(app.locals.projectPrimaryImageService, 'setPrimaryImage');

        try {
          const setFirst = await agent
            .post(`/projects/${first.id}/assets/${first.asset.id}/primary-image`)
            .type('form')
            .send({
              category: 'all',
              search: 'first',
              extension: '.PNG',
              presence: 'present',
              usage: 'unused',
              sort: 'modified',
              order: 'desc',
              page: '1',
              pageSize: '10',
              view: 'list',
              returnUrl: 'https://attacker.invalid/elsewhere',
              _csrf: csrfToken,
            })
            .expect(302);

          const firstLocation = new URL(setFirst.headers.location, 'http://localhost');
          expect(firstLocation.pathname).toBe(`/projects/${first.id}/assets/${first.asset.id}`);
          expect(firstLocation.searchParams.get('category')).toBe('all');
          expect(firstLocation.searchParams.get('search')).toBe('first');
          expect(firstLocation.searchParams.get('extension')).toBe('png');
          expect(firstLocation.searchParams.get('presence')).toBe('present');
          expect(firstLocation.searchParams.get('usage')).toBe('unused');
          expect(firstLocation.searchParams.get('sort')).toBe('modified');
          expect(firstLocation.searchParams.get('order')).toBe('desc');
          expect(firstLocation.searchParams.get('pageSize')).toBe('10');
          expect(firstLocation.searchParams.get('view')).toBe('list');
          expect(firstLocation.searchParams.get('notice')).toBe('primary-image-set');
          expect(firstLocation.searchParams.get('edit')).toBe('1');
          expect(firstLocation.searchParams.has('returnUrl')).toBe(false);
          expect(setPrimaryImage).toHaveBeenCalledExactlyOnceWith(first.id, first.asset.id);
          expect(app.locals.projectPrimaryImageService.getPrimaryImage(first.id).id).toBe(first.asset.id);
        } finally {
          setPrimaryImage.mockRestore();
        }
      });

      it('rejects malformed, unknown, cross-project, missing, unsupported, and archived selections with controlled statuses', async () => {
        const owner = await setupProjectWithAsset('Primary Set Owner', 'owner.png');
        const other = await setupProjectWithAsset('Primary Set Other', 'other.png');

        const setPrimaryImage = vi.spyOn(app.locals.projectPrimaryImageService, 'setPrimaryImage');
        try {
          for (const route of [
          `/projects/not-an-id/assets/${owner.asset.id}/primary-image`,
          `/projects/${owner.id}/assets/not-an-id/primary-image`,
          ]) {
            await agent.post(route).type('form').send({ _csrf: csrfToken }).expect(404);
            expect(setPrimaryImage).not.toHaveBeenCalled();
          }
        } finally {
          setPrimaryImage.mockRestore();
        }
        for (const route of [
          `/projects/999999/assets/${owner.asset.id}/primary-image`,
          `/projects/${owner.id}/assets/999999/primary-image`,
        ]) await agent.post(route).type('form').send({ _csrf: csrfToken }).expect(404);
        await agent
          .post(`/projects/${owner.id}/assets/${other.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(404);

        const missing = await setupProjectWithAsset('Primary Set Missing', 'missing.png');
        fs.rmSync(path.join(missing.projectDir, 'missing.png'));
        await agent.post(`/projects/${missing.id}/scan`).send({ _csrf: csrfToken }).type('form').expect(302);
        const missingRes = await agent
          .post(`/projects/${missing.id}/assets/${missing.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(409);
        expect(missingRes.text).toContain('cannot be selected as the primary image');
        expect(missingRes.text).not.toContain('Asset ' + missing.asset.id);

        const unsupported = await setupProjectWithAsset('Primary Set Unsupported', 'source.kra');
        const unsupportedRes = await agent
          .post(`/projects/${unsupported.id}/assets/${unsupported.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(422);
        const dialogStart = unsupportedRes.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialogEnd = unsupportedRes.text.indexOf('</dialog>', dialogStart) + '</dialog>'.length;
        const dialogHtml = unsupportedRes.text.slice(dialogStart, dialogEnd);
        expect(dialogHtml).toContain(' open');
        expect(dialogHtml).toContain('This asset type cannot be selected as the primary image.');

        const archived = await setupProjectWithAsset('Primary Set Archived', 'archived.png');
        await agent.post(`/projects/${archived.id}/archive`).send({ _csrf: csrfToken }).type('form').expect(302);
        const archivedRes = await agent
          .post(`/projects/${archived.id}/assets/${archived.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(409);
        expect(archivedRes.text).toContain('This project is archived and read-only.');
      });

      it('rejects an invalid non-empty CSRF token before changing the selection', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Set CSRF', 'csrf.png');
        const setPrimaryImage = vi.spyOn(app.locals.projectPrimaryImageService, 'setPrimaryImage');

        try {
          await agent
            .post(`/projects/${id}/assets/${asset.id}/primary-image`)
            .type('form')
            .send({ _csrf: 'deliberately-invalid-csrf-token' })
            .expect(403);
          expect(setPrimaryImage).not.toHaveBeenCalled();
        } finally {
          setPrimaryImage.mockRestore();
        }
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(id)).toBeUndefined();
      });

      it('hides unexpected primary-image failures behind the generic 500 page', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Set Unexpected', 'unexpected.png');
        app.locals.projectPrimaryImageService.setPrimaryImage = () => {
          throw new Error('primary image database secret');
        };

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(500);

        expect(res.text).toContain('Something went wrong.');
        expect(res.text).not.toContain('primary image database secret');
      });
    });

    // ─── Primary image Remove POST ──────────────────────────────────────
    describe('POST /projects/:projectId/assets/:assetId/primary-image/remove', () => {
      it('clears the current selection with a canonical context-preserving redirect and notice', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Remove Success', 'selected.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);

        const removed = await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image/remove`)
          .type('form')
          .send({ category: 'all', sort: 'modified', order: 'desc', returnUrl: '/unsafe', _csrf: csrfToken })
          .expect(302);

        const location = new URL(removed.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets/${asset.id}`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('sort')).toBe('modified');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.get('notice')).toBe('primary-image-removed');
        expect(location.searchParams.get('edit')).toBe('1');
        expect(location.searchParams.has('returnUrl')).toBe(false);
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(id)).toBeUndefined();

      });

      it('returns a controlled conflict for stale removal and preserves the newer selection', async () => {
        const first = await setupProjectWithAsset('Primary Remove Stale', 'first.png');
        const second = writeIndexedAsset(first.id, first.projectDir, 'second.png', await makePng());
        await agent
          .post(`/projects/${first.id}/assets/${first.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        await agent
          .post(`/projects/${first.id}/assets/${second.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);

        const stale = await agent
          .post(`/projects/${first.id}/assets/${first.asset.id}/primary-image/remove`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(409);

        expect(stale.text).toContain('The primary image changed before it could be removed.');
        expect(stale.text).not.toContain('no longer matches asset ' + first.asset.id);
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(first.id).id).toBe(second.id);
      });

      it('rejects removal from an archived project and preserves the selection', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Remove Archived', 'archived.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        await agent.post(`/projects/${id}/archive`).send({ _csrf: csrfToken }).type('form').expect(302);

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image/remove`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(409);

        expect(res.text).toContain('This project is archived and read-only.');
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(id).id).toBe(asset.id);
      });

      it('rejects removal without CSRF', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Remove CSRF', 'csrf.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);

        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image/remove`)
          .type('form')
          .send({})
          .expect(403);
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(id).id).toBe(asset.id);
      });
    });

    // ─── Book primary image POST ─────────────────────────────────────────
    describe('book primary image actions', () => {
      it('sets the requested book selection, forwards exact IDs, and redirects to the viewer', async () => {
        const first = await setupProjectWithAsset('Book Primary Set', 'first.png');
        const firstBook = app.locals.bookService.createBook({ title: 'First book' });
        const setPrimaryImage = vi.spyOn(app.locals.bookPrimaryImageService, 'setPrimaryImage');

        try {
          const setFirst = await agent
            .post(`/projects/${first.id}/assets/${first.asset.id}/book-primary-image`)
            .type('form')
            .send({ bookId: String(firstBook.id), _csrf: csrfToken })
            .expect(302);
          const firstLocation = new URL(setFirst.headers.location, 'http://localhost');
          expect(firstLocation.pathname).toBe(`/projects/${first.id}/assets/${first.asset.id}`);
          expect(firstLocation.searchParams.get('notice')).toBe('book-primary-image-set');
          expect(firstLocation.searchParams.get('edit')).toBe('1');
          expect(setPrimaryImage).toHaveBeenCalledExactlyOnceWith(firstBook.id, first.asset.id);
          expect(app.locals.bookPrimaryImageService.getPrimaryImage(firstBook.id).id).toBe(first.asset.id);
        } finally {
          setPrimaryImage.mockRestore();
        }
      });

      it('removes only the matching book primary image and preserves a newer selection', async () => {
        const first = await setupProjectWithAsset('Book Primary Remove', 'first.png');
        const second = writeIndexedAsset(first.id, first.projectDir, 'second.png', await makePng());
        const book = app.locals.bookService.createBook({ title: 'Remove book' });
        await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, first.asset.id);

        const removed = await agent
          .post(`/projects/${first.id}/assets/${first.asset.id}/book-primary-image/remove`)
          .type('form')
          .send({ bookId: String(book.id), _csrf: csrfToken })
          .expect(302);
        const location = new URL(removed.headers.location, 'http://localhost');
        expect(location.searchParams.get('notice')).toBe('book-primary-image-removed');
        expect(location.searchParams.get('edit')).toBe('1');
        expect(app.locals.bookPrimaryImageService.getPrimaryImage(book.id)).toBeUndefined();

        await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, second.id);
        const stale = await agent
          .post(`/projects/${first.id}/assets/${first.asset.id}/book-primary-image/remove`)
          .type('form')
          .send({ bookId: String(book.id), _csrf: csrfToken })
          .expect(409);
        expect(stale.text).toContain('The book primary image changed before it could be removed.');
        expect(app.locals.bookPrimaryImageService.getPrimaryImage(book.id).id).toBe(second.id);
      });

      it('rejects Book-primary removal with an invalid non-empty CSRF token before clearing the selection', async () => {
        const { id, asset } = await setupProjectWithAsset('Book Primary Remove CSRF', 'csrf.png');
        const book = app.locals.bookService.createBook({ title: 'CSRF-protected removal' });
        await app.locals.bookPrimaryImageService.setPrimaryImage(book.id, asset.id);
        const clearPrimaryImage = vi.spyOn(app.locals.bookPrimaryImageService, 'clearPrimaryImage');

        try {
          await agent
            .post(`/projects/${id}/assets/${asset.id}/book-primary-image/remove`)
            .type('form')
            .send({ bookId: String(book.id), _csrf: 'deliberately-invalid-csrf-token' })
            .expect(403);
          expect(clearPrimaryImage).not.toHaveBeenCalled();
        } finally {
          clearPrimaryImage.mockRestore();
        }
        expect(app.locals.bookPrimaryImageService.getPrimaryImage(book.id).id).toBe(asset.id);
      });

      it('handles invalid books, ineligible assets, wrong project URLs, and CSRF without writing', async () => {
        const owner = await setupProjectWithAsset('Book Primary Owner', 'owner.png');
        const other = await setupProjectWithAsset('Book Primary Other', 'other.png');
        const book = app.locals.bookService.createBook({ title: 'Protected book' });

        const setPrimaryImage = vi.spyOn(app.locals.bookPrimaryImageService, 'setPrimaryImage');
        let invalid;
        try {
          invalid = await agent
            .post(`/projects/${owner.id}/assets/${owner.asset.id}/book-primary-image`)
            .type('form')
            .send({ bookId: 'not-an-id', _csrf: csrfToken })
            .expect(422);
          expect(setPrimaryImage).not.toHaveBeenCalled();
        } finally {
          setPrimaryImage.mockRestore();
        }
        const dialogStart = invalid.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialogEnd = invalid.text.indexOf('</dialog>', dialogStart) + '</dialog>'.length;
        const dialogHtml = invalid.text.slice(dialogStart, dialogEnd);
        expect(dialogHtml).toContain(' open');
        expect(dialogHtml).toContain('Choose a valid book.');
        expect(app.locals.bookPrimaryImageService.getPrimaryImage(book.id)).toBeUndefined();

        await agent
          .post(`/projects/${owner.id}/assets/${owner.asset.id}/book-primary-image`)
          .type('form')
          .send({ bookId: '999999', _csrf: csrfToken })
          .expect(404);
        expect(app.locals.bookPrimaryImageService.getPrimaryImage(book.id)).toBeUndefined();

        await agent
          .post(`/projects/${owner.id}/assets/${other.asset.id}/book-primary-image`)
          .type('form')
          .send({ bookId: String(book.id), _csrf: csrfToken })
          .expect(404);
        expect(app.locals.bookPrimaryImageService.getPrimaryImage(book.id)).toBeUndefined();

        await agent
          .post(`/projects/${owner.id}/assets/${owner.asset.id}/book-primary-image`)
          .type('form')
          .send({ bookId: String(book.id) })
          .expect(403);
        expect(app.locals.bookPrimaryImageService.getPrimaryImage(book.id)).toBeUndefined();

      });
    });

    // ─── Rename POST ─────────────────────────────────────────────────────

    describe('POST /projects/:projectId/assets/:assetId/rename', () => {
      it('renames the file successfully, redirects to the viewer for the same asset ID, and shows a success notice', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Rename Success', 'old.png');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({
            filename: 'new.png', origin: 'viewer', category: 'all', sort: 'modified', order: 'desc', view: 'list',
            junkField: 'strip-me', _csrf: csrfToken,
          })
          .type('form')
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets/${asset.id}`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('sort')).toBe('modified');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.get('view')).toBe('list');
        expect(location.searchParams.get('notice')).toBe('asset-renamed');
        expect(location.searchParams.get('edit')).toBe('1');
        expect(location.searchParams.has('junkField')).toBe(false);
        expect(fs.existsSync(path.join(projectDir, 'new.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'old.png'))).toBe(false);
      });

      it('rejects an invalid filename with 422 and preserves the submitted value', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Rename Invalid', 'old.png');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: '..', category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(422);

        const dialogStart = res.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialog = res.text.slice(dialogStart, res.text.indexOf('</dialog>', dialogStart));
        expect(dialog).toContain('Enter a valid filename.');
        expect(dialog).toContain('value=".."');
        expect(res.text).toContain('<input type="hidden" name="category" value="all">');
        expect(fs.existsSync(path.join(projectDir, 'old.png'))).toBe(true);
      });

      it('returns 409 on a destination conflict', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Rename Conflict', 'old.png');
        writeIndexedAsset(id, projectDir, 'taken.png', await makePng());

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'taken.png', _csrf: csrfToken })
          .type('form')
          .expect(409);
        const dialogStart = res.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialog = res.text.slice(dialogStart, res.text.indexOf('</dialog>', dialogStart));
        expect(dialog).toContain('Destination already exists.');
        expect(dialog).toContain('value="taken.png"');
        expect(fs.existsSync(path.join(projectDir, 'old.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'taken.png'))).toBe(true);
      });

      it('returns 409 for an unchanged filename', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename Unchanged', 'same.png');
        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'same.png', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('That filename is unchanged.');
      });

      it('returns 409 for a case-only rename', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename Case Only', 'same.png');
        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'SAME.png', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('Case-only renames are not supported.');
      });

      it('returns a controlled 409 when the source file is missing from disk', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Rename Source Missing', 'ghost.png');
        fs.rmSync(path.join(projectDir, 'ghost.png'));

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('The source file is missing from disk.');
        expect(res.text).not.toMatch(/[A-Z]:\\/);
        expect(res.text).not.toMatch(/\/home\//);
        expect(res.text).not.toContain(tmpDir);
        expect(res.text).not.toContain('ENOENT');
        expect(res.text).not.toContain('SQLITE');
      });

      it('returns a controlled conflict for an archived project', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename Archived', 'old.png');
        await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('This project is archived and read-only.');
      });

      it('keeps malformed, unknown, and cross-project Rename identities not found', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Rename Identity Owner', 'old.png');
        const foreign = await setupProjectWithAsset('Rename Identity Foreign', 'foreign.png');
        await agent.post(`/projects/abc/assets/${asset.id}/rename`).send({ filename: 'x.png', _csrf: csrfToken }).type('form').expect(404);
        await agent.post(`/projects/${id}/assets/abc/rename`).send({ filename: 'x.png', _csrf: csrfToken }).type('form').expect(404);
        await agent.post(`/projects/999999/assets/${asset.id}/rename`).send({ filename: 'x.png', _csrf: csrfToken }).type('form').expect(404);
        await agent.post(`/projects/${id}/assets/999999/rename`).send({ filename: 'x.png', _csrf: csrfToken }).type('form').expect(404);
        await agent.post(`/projects/${id}/assets/${foreign.asset.id}/rename`).send({ filename: 'x.png', _csrf: csrfToken }).type('form').expect(404);
        expect(fs.existsSync(path.join(projectDir, 'old.png'))).toBe(true);
        expect(fs.existsSync(path.join(foreign.projectDir, 'foreign.png'))).toBe(true);
      });

      it('rejects missing and invalid CSRF tokens', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename No CSRF', 'old.png');
        await agent.post(`/projects/${id}/assets/${asset.id}/rename`).send({ filename: 'new.png' }).type('form').expect(403);
        await agent.post(`/projects/${id}/assets/${asset.id}/rename`).send({ filename: 'new.png', _csrf: 'invalid-token' }).type('form').expect(403);
      });

      it('returns a controlled 409 when the project operation coordinator is busy', async () => {
        const stub = {
          renameAsset: () => { throw new AssetActionError('busy', { code: 'PROJECT_BUSY' }); },
          moveAsset: () => { throw new AssetActionError('busy', { code: 'PROJECT_BUSY' }); },
        };
        const stubApp = buildStubActionApp(stub);
        const { agent: stubAgent, csrfToken: stubCsrf } = await getDisabledModeCsrf(stubApp, path.join(tmpDir, 'app'));
        const { id, asset } = await setupProjectWithAsset('Rename Busy', 'old.png');

        const res = await stubAgent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', _csrf: stubCsrf })
          .type('form')
          .expect(409);
        expect(res.text).toContain('Another project operation is already in progress. Try again.');
      });

      it('returns an operational status with the recovery-required message for RECOVERY_REQUIRED', async () => {
        const stub = {
          renameAsset: () => { throw new AssetActionError('recovery', { code: 'RECOVERY_REQUIRED' }); },
          moveAsset: () => { throw new AssetActionError('recovery', { code: 'RECOVERY_REQUIRED' }); },
        };
        const stubApp = buildStubActionApp(stub);
        const { agent: stubAgent, csrfToken: stubCsrf } = await getDisabledModeCsrf(stubApp, path.join(tmpDir, 'app'));
        const { id, asset } = await setupProjectWithAsset('Rename Recovery', 'old.png');

        const res = await stubAgent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', _csrf: stubCsrf })
          .type('form')
          .expect(500);
        expect(res.text).toContain('The file was moved on disk, but CreatorCrate could not finish updating its records.');
      });

      it('forwards an unexpected (non-AssetActionError) failure to the existing error middleware', async () => {
        const stub = {
          renameAsset: () => { throw new Error('unexpected boom'); },
          moveAsset: () => { throw new Error('unexpected boom'); },
        };
        const stubApp = buildStubActionApp(stub);
        const { agent: stubAgent, csrfToken: stubCsrf } = await getDisabledModeCsrf(stubApp, path.join(tmpDir, 'app'));
        const { id, asset } = await setupProjectWithAsset('Rename Unexpected', 'old.png');

        const res = await stubAgent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', _csrf: stubCsrf })
          .type('form')
          .expect(500);
        expect(res.text).toContain('Something went wrong.');
        expect(res.text).not.toContain('unexpected boom');
      });
    });

    // ─── Delete POST ──────────────────────────────────────────────────────

    describe('POST /projects/:projectId/assets/:assetId/delete', () => {
      it('delegates one viewed asset to deleteAssets and redirects with the deletion result', async () => {
        const { id, asset } = await setupProjectWithAsset('Delete Success', 'a.png');
        const deleteAssets = vi.fn(() => ({ deletedCount: 1, requestedCount: 1, deletedAssetIds: [asset.id] }));
        const stubApp = buildStubActionApp({ deleteAssets });
        const { agent: deleteAgent, csrfToken: deleteCsrf } = await getDisabledModeCsrf(
          stubApp,
          path.join(tmpDir, 'app'),
        );

        const res = await deleteAgent
          .post(`/projects/${id}/assets/${asset.id}/delete`)
          .type('form')
          .send({
            category: 'all', unknown: 'strip-me', _csrf: deleteCsrf,
          })
          .expect(302);

        expect(deleteAssets).toHaveBeenCalledTimes(1);
        expect(deleteAssets).toHaveBeenCalledWith(id, [asset.id]);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('assets_deleted')).toBe('1');
        expect(location.searchParams.has('unknown')).toBe(false);
      });

      it('blocks published-release deletion with a safe viewer error', async () => {
        const { id, asset } = await setupProjectWithAsset('Delete Published', 'published.png');
        const deleteAssets = vi.fn(() => {
          throw new AssetActionError(
            'Assets associated with a published release cannot be deleted: 7. Internal path C:\\secret.',
            { code: 'DELETE_PUBLISHED_RELEASE_ASSET' },
          );
        });
        const stubApp = buildStubActionApp({ deleteAssets });
        const { agent: deleteAgent, csrfToken: deleteCsrf } = await getDisabledModeCsrf(
          stubApp,
          path.join(tmpDir, 'app'),
        );

        const res = await deleteAgent
          .post(`/projects/${id}/assets/${asset.id}/delete`)
          .type('form')
          .send({ category: 'all', search: 'published', _csrf: deleteCsrf })
          .expect(409);

        expect(deleteAssets).toHaveBeenCalledWith(id, [asset.id]);
        expect(res.text).toContain('This asset is associated with a published release and cannot be permanently deleted.');
        expect(res.text).not.toContain('Internal path');
        expect(res.text).not.toContain('C:\\secret');
      });

      it('keeps malformed, unknown, and cross-project Viewer action IDs at 404 and renders a safe Delete precheck error', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Delete Missing', 'missing.png');
        const foreign = await setupProjectWithAsset('Viewer Action Foreign', 'foreign.png');

        for (const [action, body] of [
          ['move', { destinationCategory: 'uncategorized' }],
          ['delete', {}],
        ]) {
          await agent
            .post(`/projects/invalid/assets/${asset.id}/${action}`)
            .type('form')
            .send({ ...body, _csrf: csrfToken })
            .expect(404);
          await agent
            .post(`/projects/${id}/assets/invalid/${action}`)
            .type('form')
            .send({ ...body, _csrf: csrfToken })
            .expect(404);
          await agent
            .post(`/projects/${id}/assets/999999/${action}`)
            .type('form')
            .send({ ...body, _csrf: csrfToken })
            .expect(404);
          await agent
            .post(`/projects/${id}/assets/${foreign.asset.id}/${action}`)
            .type('form')
            .send({ ...body, _csrf: csrfToken })
            .expect(404);
        }

        const category = makeEnabledCategory(id, projectDir, 'move-missing-source');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .type('form')
          .send({ destinationCategory: String(category.id), _csrf: csrfToken })
          .expect(302);
        fs.rmSync(path.join(projectDir, 'move-missing-source', 'missing.png'));
        const move = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .type('form')
          .send({ destinationCategory: 'uncategorized', _csrf: csrfToken })
          .expect(409);
        expect(move.text).toContain('The source file is missing from disk.');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/delete`)
          .type('form')
          .send({ category: 'all', _csrf: csrfToken })
          .expect(422);

        expect(res.text).toContain('This asset cannot be deleted because it is missing or inaccessible.');
        expect(res.text).not.toContain('Source file does not exist.');
        expect(assetRepo.findById(asset.id)).toBeDefined();
      });
    });

    // ─── Move POST ───────────────────────────────────────────────────────

    describe('POST /projects/:projectId/assets/:assetId/move', () => {
      it('moves the file to an enabled category, preserves Viewer context, and reopens Edit Asset', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move Success Category');
        const category = makeEnabledCategory(id, projectDir, 'renders-move-success');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({
            destinationCategory: String(category.id), category: 'all', sort: 'modified', order: 'desc', view: 'list', _csrf: csrfToken,
          })
          .type('form')
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets/${asset.id}`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('sort')).toBe('modified');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.get('view')).toBe('list');
        expect(location.searchParams.get('notice')).toBe('asset-moved');
        expect(location.searchParams.get('edit')).toBe('1');

        const updated = assetRepo.findById(asset.id);
        expect(updated.category_id).toBe(category.id);
        expect(fs.existsSync(path.join(projectDir, 'renders-move-success', 'a.png'))).toBe(true);

        const viewer = await agent.get(res.headers.location).expect(200);
        expect(viewer.text).toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
        expect(viewer.text).toMatch(/<dt>Category<\/dt>\s*<dd>\s*Renders\s*<\/dd>/);
      });

      it('moves the file to Uncategorized successfully', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move Success Uncategorized');
        const category = makeEnabledCategory(id, projectDir, 'renders-move-uncat');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id), category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(302);

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: 'uncategorized', category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('notice')).toBe('asset-moved');
        const updated = assetRepo.findById(asset.id);
        expect(updated.category_id).toBeNull();
        expect(fs.existsSync(path.join(projectDir, 'a.png'))).toBe(true);
      });

      it.each([undefined, '', '0', '5.5', '007'])(
        'rejects a malformed destinationCategory value %j with 422 before calling the service',
        async (value) => {
          const stub = { renameAsset: () => { throw new Error('should not be called'); }, moveAsset: () => { throw new Error('should not be called'); } };
          const stubApp = buildStubActionApp(stub);
          const { agent: stubAgent, csrfToken: stubCsrf } = await getDisabledModeCsrf(stubApp, path.join(tmpDir, 'app'));
          const { id, asset } = await setupProjectWithAsset(`Move Malformed ${JSON.stringify(value)}`);

          const res = await stubAgent
            .post(`/projects/${id}/assets/${asset.id}/move`)
            .send({ destinationCategory: value, _csrf: stubCsrf })
            .type('form')
            .expect(422);
          expect(res.text).toContain('Choose a valid destination.');
        }
      );

      it('returns a controlled 409 for a disabled category', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move Disabled Category');
        const category = assetCategoryRepo.addProjectCategory({
          projectId: id, displayName: 'Disabled', directorySlug: 'disabled-cat', displayOrder: 0, enabled: false,
        });
        fs.mkdirSync(path.join(projectDir, 'disabled-cat'), { recursive: true });

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id), category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('The selected category is disabled or unavailable.');
      });

      it('does not leak existence of a cross-project or nonexistent category', async () => {
        const { id: id1, asset } = await setupProjectWithAsset('Move Cross Project A');
        const otherRes = await createProject('Move Cross Project B');
        const otherId = Number(otherRes.headers.location.replace('/projects/', ''));
        const otherProjectDir = getProjectDir('Move Cross Project B');
        const otherCategory = makeEnabledCategory(otherId, otherProjectDir, 'other-cat');

        const crossRes = await agent
          .post(`/projects/${id1}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(otherCategory.id), _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(crossRes.text).toContain('The selected category is not available for this project.');

        const nonexistentRes = await agent
          .post(`/projects/${id1}/assets/${asset.id}/move`)
          .send({ destinationCategory: '999999', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(nonexistentRes.text).toContain('The selected category is not available for this project.');
        // Identical message for both — cross-project existence is never distinguishable.
        expect(crossRes.text.includes('The selected category is not available for this project.')).toBe(
          nonexistentRes.text.includes('The selected category is not available for this project.')
        );
      });

      it('returns a controlled 409 on a destination conflict', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move Conflict', 'a.png');
        const category = makeEnabledCategory(id, projectDir, 'renders-move-conflict');
        writeIndexedAsset(id, projectDir, 'renders-move-conflict/a.png', await makePng());

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id), _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('Destination already exists.');
        const form = res.text.match(/<form[^>]*class="asset-action-form asset-move-form"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
        expect(form).toContain(`value="${category.id}" selected`);
        expect(form).toContain('<input type="hidden" name="_csrf"');
      });

      it('rejects unprotected single-asset Move and Delete requests', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move No CSRF');
        const category = makeEnabledCategory(id, projectDir, 'renders-move-nocsrf');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id) })
          .type('form')
          .expect(403);
        await agent
          .post(`/projects/${id}/assets/${asset.id}/delete`)
          .type('form')
          .send({})
          .expect(403);
      });

      it('rejects direct Viewer Move and Delete requests for archived projects without mutation', async () => {
        for (const [action, body] of [
          ['move', { destinationCategory: 'uncategorized' }],
          ['delete', {}],
        ]) {
          const { id, projectDir, asset } = await setupProjectWithAsset(`Viewer Archived ${action}`, 'a.png');
          await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

          const response = await agent.post(`/projects/${id}/assets/${asset.id}/${action}`).type('form')
            .send({ ...body, _csrf: csrfToken })
            .expect(409);

          expect(response.text).toContain('This project is archived and read-only.');
          expect(fs.existsSync(path.join(projectDir, 'a.png'))).toBe(true);
          expect(assetRepo.findById(asset.id)).toBeDefined();
        }
      });

      it('maps a busy Move service failure to a safe Viewer error', async () => {
        const { id, asset } = await setupProjectWithAsset('Move Busy');
        const moveAsset = vi.fn(() => {
          throw new AssetActionError('busy details C:\\secret', { code: 'PROJECT_BUSY' });
        });
        const stubApp = buildStubActionApp({ moveAsset });
        const { agent: stubAgent, csrfToken: stubCsrf } = await getDisabledModeCsrf(stubApp, path.join(tmpDir, 'app'));

        const res = await stubAgent.post(`/projects/${id}/assets/${asset.id}/move`).type('form')
          .send({ destinationCategory: 'uncategorized', _csrf: stubCsrf })
          .expect(409);

        expect(moveAsset).toHaveBeenCalledWith(id, asset.id, UNCATEGORIZED);
        expect(res.text).toContain('Another project operation is already in progress. Try again.');
        expect(res.text).not.toContain('busy details');
        expect(res.text).not.toContain('C:\\secret');
      });

      it.each([
        ['move', { destinationCategory: 'uncategorized' }, 'moveAsset'],
        ['delete', {}, 'deleteAssets'],
      ])('hides unexpected single-asset %s failures behind the generic error page', async (action, body, method) => {
        const { id, asset } = await setupProjectWithAsset(`Unexpected ${action}`);
        const actionServiceStub = {
          [method]: () => { throw new Error('unexpected internal path C:\\secret'); },
        };
        const stubApp = buildStubActionApp(actionServiceStub);
        const { agent: stubAgent, csrfToken: stubCsrf } = await getDisabledModeCsrf(stubApp, path.join(tmpDir, 'app'));

        const res = await stubAgent.post(`/projects/${id}/assets/${asset.id}/${action}`).type('form')
          .send({ ...body, _csrf: stubCsrf })
          .expect(500);

        expect(res.text).toContain('Something went wrong.');
        expect(res.text).not.toContain('unexpected internal path');
        expect(res.text).not.toContain('C:\\secret');
      });
    });

    // ─── Security / error behavior ───────────────────────────────────────

    describe('security and error behavior', () => {
      it('ignores unknown form fields when resolving the rename destination', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Security Unknown Fields', 'old.png');

        await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({
            filename: 'new.png',
            relativePath: '../../outside.png',
            path: '/etc/passwd',
            _csrf: csrfToken,
          })
          .type('form')
          .expect(302);

        expect(fs.existsSync(path.join(projectDir, 'new.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, '..', '..', 'outside.png'))).toBe(false);
      });

      it('a direct POST cannot bypass the missing-asset capability rule even without visiting the viewer first', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Security Missing Bypass', 'ghost.png');
        fs.rmSync(path.join(projectDir, 'ghost.png'));
        await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('This asset is missing from the last scan and cannot be renamed or moved.');
      });
    });

    // ─── Main browser action integration ─────────────────────────────────
    describe('main assets-page rename and move-selected', () => {
      it('renders an eligible list Rename form with the basename and complete canonical context', async () => {
        const { id, asset } = await setupProjectWithAsset('Main List Rename', 'old.png');

        const res = await agent
          .get(`/projects/${id}/assets?search=old&extension=.png&presence=present&usage=unused&sort=size&order=desc&page=1&pageSize=50&view=list&unknown=strip-me`)
          .expect(200);
        const match = res.text.match(new RegExp(`<form method="post" action="/projects/${id}/assets/${asset.id}/rename"[\\s\\S]*?<\\/form>`));

        expect(match).not.toBeNull();
        const form = match[0];
        expect(form).toContain('name="origin" value="assets"');
        expect(form).toContain('name="category" value="all"');
        expect(form).toContain('name="search" value="old"');
        expect(form).toContain('name="extension" value="png"');
        expect(form).toContain('name="presence" value="present"');
        expect(form).toContain('name="usage" value="unused"');
        expect(form).toContain('name="sort" value="size"');
        expect(form).toContain('name="order" value="desc"');
        expect(form).toContain('name="page" value="1"');
        expect(form).toContain('name="pageSize" value="50"');
        expect(form).toContain('name="view" value="list"');
        expect(form).toContain('value="old"');
        expect(form).toContain('class="asset-rename-extension" aria-hidden="true">.png</span>');
        expect(form).not.toContain('unknown');
      });

      it('omits grid Rename while keeping bulk-selection form ownership valid', async () => {
        const { id, asset } = await setupProjectWithAsset('Main Grid Rename', 'hero.png');

        const res = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
        const card = res.text.match(new RegExp(`<article class="asset-card(?: asset-card--project)?(?: is-selected)?"\\s+data-asset-id="${asset.id}"[^>]*>[\\s\\S]*?<\\/article>`));
        expect(card).not.toBeNull();
        expect(card[0]).toContain('data-asset-viewer-preview');
        expect(card[0]).toContain('data-asset-info-card popover="manual"');
        expect(card[0]).not.toContain('class="asset-card-body');
        expect(card[0]).not.toContain('data-asset-rename-trigger');
        expect(card[0]).not.toContain('data-asset-rename-editor');
        expect((card[0].match(/<form\b/g) || []).length).toBe((card[0].match(/<\/form>/g) || []).length);
        expect((res.text.match(/<h1\b/g) || []).length).toBe(1);

        const bulkStart = res.text.indexOf('<form id="bulk-select-form"');
        const gridStart = res.text.search(/<ul class="asset-grid"[^>]*>/);
        expect(bulkStart).toBeGreaterThanOrEqual(0);
        expect(res.text.indexOf('</form>', bulkStart)).toBeLessThan(gridStart);
        expect(res.text).toMatch(/<input type="checkbox" form="bulk-select-form"[^>]*name="selectedAssetIds"/);
        expect(res.text).toContain('formaction="/projects/' + id + '/assets/move-selected"');
      });

      it('keeps grid Rename absent after a controlled validation failure', async () => {
        const { id, assets } = await setupOrderedImageAssets('Main Grid Rename Failure');
        const res = await agent
          .post(`/projects/${id}/assets/${assets.alpha.id}/rename`)
          .type('form')
          .send({ filename: 'bad/name', origin: 'assets', category: 'all', view: 'grid', _csrf: csrfToken })
          .expect(422);

        const cards = [...res.text.matchAll(/<article class="asset-card[\s\S]*?<\/article>/g)].map(([card]) => card);
        expect(cards.length).toBeGreaterThan(1);
        for (const card of cards) {
          expect(card).toContain('data-asset-info-card popover="manual"');
          expect(card).not.toContain('class="asset-card-body');
          expect(card).not.toContain('data-asset-rename-trigger');
          expect(card).not.toContain('data-asset-rename-editor');
        }
      });

      it('hides main-page Rename for missing assets and archived projects', async () => {
        const missing = await setupProjectWithAsset('Main Missing Rename', 'gone.png');
        assetRepo.markMissingByProjectIdAndPathNotIn(missing.id, []);
        const missingRes = await agent.get(`/projects/${missing.id}/assets?view=grid`).expect(200);
        expect(missingRes.text).not.toContain(`/projects/${missing.id}/assets/${missing.asset.id}/rename`);

        const archived = await setupProjectWithAsset('Main Archived Rename', 'archived.png');
        await agent.post(`/projects/${archived.id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
        const archivedRes = await agent.get(`/projects/${archived.id}/assets`).expect(200);
        expect(archivedRes.text).not.toContain(`/projects/${archived.id}/assets/${archived.asset.id}/rename`);
        expect(archivedRes.text).not.toContain('id="bulk-select-form"');
      });

      it('renames from the main page back to the browser with normalized full context and a fixed notice', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Main Rename Success', 'old.png');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .type('form')
          .send({
            filename: 'new', origin: 'assets', category: 'all', search: 'new', extension: '.png',
            presence: 'present', usage: 'unused', sort: 'size', order: 'desc', page: '1', pageSize: '50',
            view: 'grid', unknown: 'strip-me', _csrf: csrfToken,
          })
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets`);
        expect(location.searchParams.get('search')).toBe('new');
        expect(location.searchParams.get('extension')).toBe('png');
        expect(location.searchParams.get('presence')).toBe('present');
        expect(location.searchParams.get('usage')).toBe('unused');
        expect(location.searchParams.get('sort')).toBe('size');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.get('pageSize')).toBe('50');
        expect(location.searchParams.has('view')).toBe(false);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.has('page')).toBe(false);
        expect(location.searchParams.has('unknown')).toBe(false);
        expect(fs.existsSync(path.join(projectDir, 'new.png'))).toBe(true);

        const browser = await agent.get(res.headers.location).expect(200);
        expect(browser.text).toContain('The file was renamed.');
        expect(browser.text).not.toContain('asset-preview-section');
      });

      it('preserves saved presentation values when an Assets-origin action submits omitted context fields', async () => {
        saveAssetDefault('view', 'list');
        saveAssetDefault('sort', 'category');
        saveAssetDefault('order', 'desc');
        saveAssetDefault('pageSize', '50');

        const { id, asset } = await setupProjectWithAsset('Main Rename Saved Context', 'old.png');
        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .type('form')
          .send({
            filename: 'new', origin: 'assets', category: 'all', search: 'old', extension: '.png',
            presence: 'present', usage: 'unused', _csrf: csrfToken,
          })
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets`);
        expect(location.searchParams.get('sort')).toBe('category');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.get('pageSize')).toBe('50');
        expect(location.searchParams.get('view')).toBe('list');
        expect(location.searchParams.get('notice')).toBe('asset-renamed');
      });

      it('keeps viewer-origin Rename on the viewer route', async () => {
        const { id, asset } = await setupProjectWithAsset('Explicit Viewer Origin', 'old.png');
        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .type('form')
          .send({ filename: 'new.png', origin: 'viewer', _csrf: csrfToken })
          .expect(302);
        expect(new URL(res.headers.location, 'http://localhost').pathname).toBe(`/projects/${id}/assets/${asset.id}`);
      });

      it('rejects an explicit non-whitelisted Rename origin without redirecting to it', async () => {
        const { id, asset } = await setupProjectWithAsset('Invalid Rename Origin', 'old.png');
        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .type('form')
          .send({ filename: 'new.png', origin: 'https://evil.example/return', _csrf: csrfToken })
          .expect(422);
        expect(res.text).toContain('The requested action origin is not supported.');
        expect(res.text).not.toContain('https://evil.example/return');
        expect(fs.existsSync(path.join(getProjectDir('Invalid Rename Origin'), 'old.png'))).toBe(true);
      });

      it('renders assets-origin invalid filename and destination conflict on the browser without the viewer', async () => {
        const invalid = await setupProjectWithAsset('Main Rename Invalid', 'old.png');
        const invalidRes = await agent
          .post(`/projects/${invalid.id}/assets/${invalid.asset.id}/rename`)
          .type('form')
          .send({ filename: 'bad/name', origin: 'assets', category: 'all', search: 'old', view: 'grid', _csrf: csrfToken })
          .expect(422);
        expect(invalidRes.text).toContain('<input type="hidden" name="category" value="all">');
        expect(invalidRes.text).toContain('data-asset-info-card popover="manual"');
        expect(invalidRes.text).not.toContain('class="asset-card-body');
        expect(invalidRes.text).not.toContain('data-asset-rename-editor');
        expect(invalidRes.text).not.toContain('asset-preview-section');

        const conflict = await setupProjectWithAsset('Main Rename Conflict', 'old.png');
        writeIndexedAsset(conflict.id, conflict.projectDir, 'taken.png', await makePng());
        const conflictRes = await agent
          .post(`/projects/${conflict.id}/assets/${conflict.asset.id}/rename`)
          .type('form')
          .send({ filename: 'taken', origin: 'assets', _csrf: csrfToken })
          .expect(409);
        expect(conflictRes.text).toContain('data-asset-info-card popover="manual"');
        expect(conflictRes.text).not.toContain('class="asset-card-body');
        expect(conflictRes.text).not.toContain('data-asset-rename-editor');
        expect(conflictRes.text).not.toContain('asset-preview-section');
        expect(conflictRes.text).not.toMatch(/[A-Z]:\\/);
        expect(conflictRes.text).not.toContain('ENOENT');
        expect(conflictRes.text).not.toContain('SQLITE');
      });

      it('enforces CSRF on main-page Rename', async () => {
        const { id, asset } = await setupProjectWithAsset('Main Rename CSRF', 'old.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .type('form')
          .send({ filename: 'new.png', origin: 'assets' })
          .expect(403);
      });

      it('rejects empty Delete selected submissions with browser and form context preserved', async () => {
        const { id, projectDir } = await setupProjectWithAsset('Bulk Delete Empty', 'a.png');
        writeIndexedAsset(id, projectDir, 'b-a.png', await makePng());
        const deleteAssets = vi.fn();
        const deleteApp = buildStubActionApp({ deleteAssets });
        const { agent: deleteAgent, csrfToken: deleteCsrf } = await getDisabledModeCsrf(
          deleteApp,
          path.join(tmpDir, 'app'),
        );

        const res = await deleteAgent.post(`/projects/${id}/assets/delete-selected`).type('form')
          .send({
            category: 'all', search: 'a', extension: '.png', presence: 'present', usage: 'unused',
            sort: 'size', order: 'desc', page: '2', pageSize: '1', view: 'list',
            releaseId: 'submitted-release', destinationCategory: 'uncategorized', _csrf: deleteCsrf,
          }).expect(422);

        expect(res.text).toContain('Select at least one asset to delete.');
        expect(deleteAssets).not.toHaveBeenCalled();
        expect(res.text).toContain('<input type="hidden" name="category" value="all">');
        expect(res.text).toContain('<input type="hidden" name="search" value="a">');
        expect(res.text).toContain('<input type="hidden" name="extension" value="png">');
        expect(res.text).toContain('<input type="hidden" name="presence" value="present">');
        expect(res.text).toContain('<input type="hidden" name="usage" value="unused">');
        expect(res.text).toContain('<input type="hidden" name="sort" value="size">');
        expect(res.text).toContain('<input type="hidden" name="order" value="desc">');
        expect(res.text).toContain('<input type="hidden" name="page" value="2">');
        expect(res.text).toContain('<input type="hidden" name="pageSize" value="1">');
        expect(res.text).toContain('<input type="hidden" name="view" value="list">');
        expect(res.text).toContain('value="uncategorized" selected');
      });

      it('calls deleteAssets and redirects with normalized browser context', async () => {
        const { id, asset } = await setupProjectWithAsset('Bulk Delete Success', 'a.png');
        const deleteAssets = vi.fn(() => ({ deletedCount: 1 }));
        const deleteApp = buildStubActionApp({ deleteAssets });
        const { agent: deleteAgent, csrfToken: deleteCsrf } = await getDisabledModeCsrf(
          deleteApp,
          path.join(tmpDir, 'app'),
        );

        const res = await deleteAgent.post(`/projects/${id}/assets/delete-selected`).type('form')
          .send({
            selectedAssetIds: String(asset.id), category: 'all', search: 'a', extension: '.png',
            presence: 'present', usage: 'unused', sort: 'size', order: 'desc', page: '2',
            pageSize: '50', view: 'list', unknown: 'strip-me', releaseId: 'ignored',
            destinationCategory: 'uncategorized', _csrf: deleteCsrf,
          }).expect(302);

        expect(deleteAssets).toHaveBeenCalledTimes(1);
        expect(deleteAssets).toHaveBeenCalledWith(id, [asset.id]);
        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('search')).toBe('a');
        expect(location.searchParams.get('extension')).toBe('png');
        expect(location.searchParams.get('presence')).toBe('present');
        expect(location.searchParams.get('usage')).toBe('unused');
        expect(location.searchParams.get('sort')).toBe('size');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.get('page')).toBe('2');
        expect(location.searchParams.get('pageSize')).toBe('50');
        expect(location.searchParams.get('view')).toBe('list');
        expect(location.searchParams.get('assets_deleted')).toBe('1');
        expect(location.searchParams.has('unknown')).toBe(false);
        expect(location.searchParams.has('releaseId')).toBe(false);
        expect(location.searchParams.has('destinationCategory')).toBe(false);
        expect((await deleteAgent.get(res.headers.location).expect(200)).text).toContain('Deleted 1 asset.');
      });

      it('surfaces the published-release deletion error safely and preserves selection context', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Delete Published', 'a.png');
        writeIndexedAsset(id, projectDir, 'unselected.png', await makePng());
        const deleteAssets = vi.fn(() => {
          throw new AssetActionError(
            'Assets associated with a published release cannot be deleted: 7. Internal path C:\\secret.',
            { code: 'DELETE_PUBLISHED_RELEASE_ASSET' },
          );
        });
        const deleteApp = buildStubActionApp({ deleteAssets });
        const { agent: deleteAgent, csrfToken: deleteCsrf } = await getDisabledModeCsrf(
          deleteApp,
          path.join(tmpDir, 'app'),
        );

        const res = await deleteAgent.post(`/projects/${id}/assets/delete-selected`).type('form')
          .send({
            selectedAssetIds: String(asset.id), category: 'all', search: 'a', sort: 'filename',
            order: 'asc', page: '1', pageSize: '25', view: 'grid', _csrf: deleteCsrf,
          }).expect(409);

        expect(res.text).toContain('One or more selected assets are associated with a published release and cannot be deleted.');
        expect(res.text).not.toContain('Internal path');
        expect(res.text).not.toContain('C:\\secret');
        expect(checkedBulkSelectionIds(res.text)).toEqual([String(asset.id)]);
      });

      it('passes exact selected IDs and destination to Copy before redirecting with its result', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Copy Success', 'a.png');
        const second = writeIndexedAsset(id, projectDir, 'b.png', await makePng());
        const category = makeEnabledCategory(id, projectDir, 'copy-target', 'Copy Target');
        const copyAssets = vi.fn(() => ({ copiedCount: 2 }));
        const copyApp = buildStubActionApp({ copyAssets });
        const { agent: copyAgent, csrfToken: copyCsrf } = await getDisabledModeCsrf(
          copyApp,
          path.join(tmpDir, 'app'),
        );

        const res = await copyAgent.post(`/projects/${id}/assets/copy-selected`).type('form')
          .send({
            selectedAssetIds: [String(asset.id), String(second.id)],
            destinationCategory: String(category.id), category: 'all', search: 'a', extension: '.png',
            presence: 'present', usage: 'unused', sort: 'size', order: 'desc', page: '2', pageSize: '50',
            view: 'list', unknown: 'strip-me', _csrf: copyCsrf,
          }).expect(302);

        expect(copyAssets).toHaveBeenCalledTimes(1);
        expect(copyAssets).toHaveBeenCalledWith(id, [asset.id, second.id], category.id);
        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets`);
        expect(location.searchParams.get('assets_copied')).toBe('2');
        expect(location.searchParams.has('unknown')).toBe(false);
        expect((await copyAgent.get(res.headers.location).expect(200)).text).toContain('Copied 2 assets.');
      });

      it('rejects empty selection and missing or invalid destination categories', async () => {
        const { id, asset } = await setupProjectWithAsset('Bulk Copy Validation', 'a.png');

        const empty = await agent.post(`/projects/${id}/assets/copy-selected`).type('form')
          .send({ _csrf: csrfToken }).expect(422);
        expect(empty.text).toContain('Select at least one asset to copy.');

        for (const destinationCategory of [undefined, 'not-a-category']) {
          const body = { selectedAssetIds: String(asset.id), _csrf: csrfToken };
          if (destinationCategory !== undefined) body.destinationCategory = destinationCategory;
          const res = await agent.post(`/projects/${id}/assets/copy-selected`).type('form')
            .send(body).expect(422);
          expect(res.text).toContain('Choose a valid destination category.');
        }
      });

      it('preserves selected assets and browser context on copy validation failure', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Copy Context Failure', 'a.png');
        writeIndexedAsset(id, projectDir, 'z.png', await makePng());
        const res = await agent.post(`/projects/${id}/assets/copy-selected`).type('form')
          .send({
            selectedAssetIds: String(asset.id), category: 'all', search: 'png', extension: '.png',
            presence: 'present', usage: 'unused', sort: 'filename', order: 'desc', page: '2', pageSize: '1',
            view: 'list', _csrf: csrfToken,
        }).expect(422);

        expect(res.text).toContain('Choose a valid destination category.');
        expect(checkedBulkSelectionIds(res.text)).toEqual([String(asset.id)]);
        expect(res.text).toContain('<input type="hidden" name="category" value="all">');
        expect(res.text).toContain('<input type="hidden" name="search" value="png">');
        expect(res.text).toContain('<input type="hidden" name="extension" value="png">');
        expect(res.text).toContain('<input type="hidden" name="presence" value="present">');
        expect(res.text).toContain('<input type="hidden" name="usage" value="unused">');
        expect(res.text).toContain('<input type="hidden" name="sort" value="filename">');
        expect(res.text).toContain('<input type="hidden" name="order" value="desc">');
        expect(res.text).toContain('<input type="hidden" name="page" value="2">');
        expect(res.text).toContain('<input type="hidden" name="pageSize" value="1">');
        expect(res.text).toContain('<input type="hidden" name="view" value="list">');
      });

      it('rejects Copy selected for an archived project without mutation', async () => {
        const { id, asset, projectDir } = await setupProjectWithAsset('Bulk Copy Archived', 'a.png');
        await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

        const res = await agent.post(`/projects/${id}/assets/copy-selected`).type('form')
          .send({ selectedAssetIds: String(asset.id), destinationCategory: 'uncategorized', _csrf: csrfToken })
          .expect(409);

        expect(res.text).toContain('This project is archived and read-only.');
        expect(fs.existsSync(path.join(projectDir, 'a.png'))).toBe(true);
        expect(assetRepo.findByProjectIdAndPath(id, 'a.png')).toBeDefined();
      });

      it('rejects direct Move and Delete submissions for archived projects without mutation', async () => {
        for (const [operation, body] of [
          ['move-selected', { destinationCategory: 'uncategorized' }],
          ['delete-selected', {}],
        ]) {
          const { id, projectDir, asset } = await setupProjectWithAsset(`Bulk Archived ${operation}`, 'a.png');
          await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

          const response = await agent.post(`/projects/${id}/assets/${operation}`).type('form')
            .send({ ...body, selectedAssetIds: String(asset.id), _csrf: csrfToken })
            .expect(409);

          expect(response.text).toContain('This project is archived and read-only.');
          expect(fs.existsSync(path.join(projectDir, 'a.png'))).toBe(true);
          expect(assetRepo.findById(asset.id)).toBeDefined();
        }
      });

      it('rejects empty, malformed, duplicate, cross-project, and unknown selections before mutation', async () => {
        const own = await setupProjectWithAsset('Bulk Invalid Selection', 'own.png');
        const foreign = await setupProjectWithAsset('Bulk Foreign Selection', 'foreign.png');

        await agent.post(`/projects/${own.id}/assets/move-selected`).type('form')
          .send({ destinationCategory: 'uncategorized', _csrf: csrfToken }).expect(422);
        for (const selectedAssetIds of [['0'], ['-1'], ['5.5'], ['5abc']]) {
          const res = await agent.post(`/projects/${own.id}/assets/move-selected`).type('form')
            .send({ selectedAssetIds, destinationCategory: 'uncategorized', _csrf: csrfToken }).expect(422);
          expect(res.text).toContain('Invalid asset selection.');
        }

        const duplicate = await agent.post(`/projects/${own.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: [String(own.asset.id), String(own.asset.id)], destinationCategory: 'uncategorized', _csrf: csrfToken }).expect(422);
        expect(duplicate.text).toContain('One or more selected assets cannot be moved to that destination.');
        expect(fs.existsSync(path.join(own.projectDir, 'own.png'))).toBe(true);

        const cross = await agent.post(`/projects/${own.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: String(foreign.asset.id), destinationCategory: 'uncategorized', _csrf: csrfToken }).expect(422);
        expect(cross.text).toContain('One or more selected assets cannot be moved to that destination.');
        const unknown = await agent.post(`/projects/${own.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: '999999', destinationCategory: 'uncategorized', _csrf: csrfToken }).expect(422);
        expect(unknown.text).toContain('One or more selected assets cannot be moved to that destination.');
      });

      it('rejects an invalid destination before invoking the batch service', async () => {
        const { id, asset } = await setupProjectWithAsset('Bulk Invalid Destination', 'a.png');
        const stubApp = buildStubActionApp({ moveAssets: () => { throw new Error('service should not run'); } });
        const { agent: stubAgent, csrfToken: stubCsrf } = await getDisabledModeCsrf(stubApp, path.join(tmpDir, 'app'));
        const res = await stubAgent.post(`/projects/${id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: String(asset.id), destinationCategory: 'not-a-category', _csrf: stubCsrf }).expect(422);
        expect(res.text).toContain('Choose a valid destination.');
        expect(res.text).not.toContain('service should not run');
      });

      it('passes exact selected IDs and destination to Move before redirecting with its result', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Move Success', 'a.png');
        const second = writeIndexedAsset(id, projectDir, 'b.png', await makePng());
        const category = makeEnabledCategory(id, projectDir, 'bulk-target', 'Bulk Target');
        const moveAssets = vi.fn(() => ({ movedCount: 2 }));
        const moveApp = buildStubActionApp({ moveAssets });
        const { agent: moveAgent, csrfToken: moveCsrf } = await getDisabledModeCsrf(
          moveApp,
          path.join(tmpDir, 'app'),
        );
        const res = await moveAgent.post(`/projects/${id}/assets/move-selected`).type('form')
          .send({
            selectedAssetIds: [String(asset.id), String(second.id)],
            destinationCategory: String(category.id), category: 'all', search: 'a', extension: '.png', presence: 'present',
            usage: 'unused', sort: 'size', order: 'desc', page: '1', pageSize: '50', view: 'grid', unknown: 'strip-me',
            path: '../../outside', destinationPath: '/etc/passwd', _csrf: moveCsrf,
          }).expect(302);

        expect(moveAssets).toHaveBeenCalledTimes(1);
        expect(moveAssets).toHaveBeenCalledWith(id, [asset.id, second.id], category.id);
        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('search')).toBe('a');
        expect(location.searchParams.get('extension')).toBe('png');
        expect(location.searchParams.get('presence')).toBe('present');
        expect(location.searchParams.get('usage')).toBe('unused');
        expect(location.searchParams.get('sort')).toBe('size');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.get('pageSize')).toBe('50');
        expect(location.searchParams.has('view')).toBe(false);
        expect(location.searchParams.get('assets_moved')).toBe('2');
        expect(location.searchParams.has('unknown')).toBe(false);
        expect(location.searchParams.has('path')).toBe(false);
        expect((await moveAgent.get(res.headers.location).expect(200)).text).toContain('Moved 2 assets.');
      });

      it('preserves selection and renders safe partial/recovery failure messages', async () => {
        const partialStub = {
          moveAssets: () => {
            const err = new AssetActionError('partial details', { code: 'BATCH_PARTIAL_FAILURE' });
            err.batchContext = { movedCount: 1, requestedCount: 2 };
            throw err;
          },
        };
        const partialApp = buildStubActionApp(partialStub);
        const { agent: partialAgent, csrfToken: partialCsrf } = await getDisabledModeCsrf(partialApp, path.join(tmpDir, 'app'));
        const partial = await setupProjectWithAsset('Bulk Partial Failure', 'a.png');
        const partialRes = await partialAgent.post(`/projects/${partial.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: [String(partial.asset.id), '2'], destinationCategory: 'uncategorized', category: 'all', _csrf: partialCsrf }).expect(500);
        expect(partialRes.text).toContain('Moved 1 of 2 assets before a failure occurred.');
        expect(checkedBulkSelectionIds(partialRes.text)).toEqual([String(partial.asset.id)]);
        expect(partialRes.text).toContain('<input type="hidden" name="category" value="all">');
        expect(partialRes.text).not.toContain('partial details');
        expect(partialRes.text).not.toContain('SQLITE');

        const recoveryStub = {
          moveAssets: () => {
            const err = new AssetActionError('recovery details', { code: 'BATCH_RECOVERY_REQUIRED' });
            err.batchContext = { movedCount: 1, requestedCount: 2 };
            throw err;
          },
        };
        const recoveryApp = buildStubActionApp(recoveryStub);
        const { agent: recoveryAgent, csrfToken: recoveryCsrf } = await getDisabledModeCsrf(recoveryApp, path.join(tmpDir, 'app'));
        const recovery = await setupProjectWithAsset('Bulk Recovery Failure', 'a.png');
        const recoveryRes = await recoveryAgent.post(`/projects/${recovery.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: [String(recovery.asset.id), '2'], destinationCategory: 'uncategorized', category: 'all', _csrf: recoveryCsrf }).expect(500);
        expect(recoveryRes.text).toContain('Inspect the project folder before scanning.');
        expect(recoveryRes.text).toContain('<input type="hidden" name="category" value="all">');
        expect(recoveryRes.text).not.toContain('recovery details');
      });

    });
  });

  it('omits the retired Project Assets grid Details behavior while preserving the body opt-out', async () => {
    const { id } = await setupOrderedImageAssets('Grid card details');

    const grid = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    expect(grid.text).not.toContain('data-project-assets-grid-details-default');
    const filters = grid.text.match(/<form[^>]*id="asset-filters"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
    expect(filters).not.toContain('data-asset-grid-details-toggle');
    expect(filters).not.toContain('id="asset-grid-details-toggle"');
    expect(filters).not.toContain('class="asset-grid-details-control"');
    expect(grid.text).not.toContain('class="asset-card-body');
    expect(grid.text).not.toContain('data-asset-rename-trigger');
    expect(grid.text).toContain('data-asset-info-card popover="manual"');
    expect(grid.text).toContain('class="asset-card-top"');
    expect(grid.text).toContain('class="asset-select-checkbox"');
    const stylesheet = fs.readFileSync(path.join(process.cwd(), 'src', 'static', 'creatorcrate.css'), 'utf8');
    expect(stylesheet).not.toContain('[data-grid-details="hidden"]');

    const list = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(list.text).not.toContain('data-project-assets-grid-details-default');
    expect(list.text).not.toContain('data-asset-grid-details-toggle');
  });
});
