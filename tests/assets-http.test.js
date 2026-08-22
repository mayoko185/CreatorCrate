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
import { AssetActionError } from '../src/services/asset-action-service.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { buildBrowserRenderModel } from '../src/routes/project-assets-shared.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { makeZip } from './helpers/zip-fixture.js';
import slugify from '@sindresorhus/slugify';

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

  function anchorText(html, className) {
    const match = anchorMatch(html, className);
    return match ? match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  }

  function assetCardHtml(html, assetId) {
    return html.match(new RegExp(`<article\\b[^>]*data-asset-id="${assetId}"[\\s\\S]*?<\\/article>`))?.[0] || '';
  }

  function assetSelectionControlsHtml(html) {
    const start = html.indexOf('<div class="asset-selection-controls-area">');
    const end = html.indexOf('<div class="asset-selection-controls">', start);
    return start >= 0 && end > start ? html.slice(start, end) : '';
  }

  function assetActionsPanelHtml(html) {
    const start = html.search(/<div class="asset-actions-panel(?: asset-actions-panel--selection-only)?" data-asset-actions-panel>/);
    if (start < 0) return '';
    const panel = html.slice(start);
    const assetListStart = panel.search(/<ul class="asset-(?:grid|list)\b/);
    return assetListStart >= 0 ? panel.slice(0, assetListStart) : panel;
  }

  function projectAssetsDisplayActions(html) {
    return html.match(/<div class="project-filter-actions project-filter-actions--projects">([\s\S]*?)<\/div>/)?.[1] || '';
  }

  function assetListCardHtml(html, assetId) {
    return html.match(new RegExp(`<article\\b(?=[^>]*class="[^"]*\\basset-list-card\\b[^"]*")(?=[^>]*data-asset-id="${assetId}"[^>]*)[^>]*>[\\s\\S]*?<\\/article>`))?.[0] || '';
  }

  function assetListMediaHtml(card) {
    return card.match(/<div class="asset-list-card-media"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
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

  it('renders asset browser with project title', async () => {
    const res = await createProject('Browser Title Test');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('Assets — Browser Title Test');
    expect(res2.text).toContain('Scan Now');
    expect(res2.text).toContain('class="page-heading"');
    const pageHeading = res2.text.match(/<header class="page-heading">([\s\S]*?)<\/header>/)?.[1] || '';
    const headingActions = pageHeading.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    const displayActions = projectAssetsDisplayActions(res2.text);
    expect(pageHeading).toContain(`<a class="button button-secondary page-heading-lead" href="/projects/${id}">Project: Browser Title Test</a>`);
    expect(pageHeading.indexOf('page-heading-lead')).toBeLessThan(pageHeading.indexOf('<div class="page-heading-actions">'));
    expect(headingActions).toContain('Scan Now');
    expect(headingActions).not.toContain('Edit project');
    expect(displayActions).toContain(`href="/projects/${id}/edit"`);
    expect(headingActions).not.toContain('Project: Browser Title Test');
    expect(res2.text).not.toContain('Back to Project');
    expect((res2.text.match(/<h1\b/g) || []).length).toBe(1);
    expect(res2.text).not.toContain('asset-tag-option-all');
    expect(res2.text).toContain('No tags available');
    expect(res2.text).toMatch(/<input id="asset-extension-option-all" name="extension" type="radio" value="" checked>/);
  });

  it('does not expose the obsolete project Watermark discovery route', async () => {
    const res = await createProject('Global Watermark Route Removal');
    const id = res.headers.location.replace('/projects/', '');
    await agent.get(`/projects/${id}/watermarks`).expect(404);
  });

  it('shows missing cleanup controls only for active projects with missing assets', async () => {
    const res = await createProject('Missing Cleanup Controls');
    const id = Number(res.headers.location.replace('/projects/', ''));
    assetRepo.upsert(id, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.markAllMissing(id);

    const active = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(active.text).toContain(`href="/projects/${id}/assets?remove_missing=1"`);
    expect(active.text).toContain('data-dialog-open="remove-missing-assets-dialog"');
    expect(active.text).toContain(`action="/projects/${id}/assets/remove-missing"`);
    expect(active.text).toContain('data-dialog-async="false"');
    expect(active.text).toContain(`name="returnTo" value="/projects/${id}/assets"`);
    expect(projectAssetsDisplayActions(active.text)).toContain(`href="/projects/${id}/edit"`);
    expect(active.text).toContain('Only asset records currently marked missing will be removed.');

    const emptyRes = await createProject('No Missing Cleanup Control');
    const emptyId = Number(emptyRes.headers.location.replace('/projects/', ''));
    const empty = await agent.get(`/projects/${emptyId}/assets`).expect(200);
    expect(empty.text).not.toContain('data-dialog-open="remove-missing-assets-dialog"');
    expect(empty.text).not.toContain(`action="/projects/${emptyId}/assets/remove-missing"`);

    await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
    const archived = await agent.get(`/projects/${id}/assets`).expect(200);
    const archivedHeading = archived.text.match(/<header class="page-heading">([\s\S]*?)<\/header>/)?.[1] || '';
    expect(archivedHeading).toContain(`<a class="button button-secondary page-heading-lead" href="/projects/${id}">Project: Missing Cleanup Controls</a>`);
    expect(archivedHeading).not.toContain('<div class="page-heading-actions">');
    expect(archived.text).not.toContain('Back to Project');
    expect(archived.text).not.toContain('remove-missing-assets-dialog');
    expect(archived.text).not.toContain('Scan Now');
    expect(archived.text).not.toContain(`href="/projects/${id}/edit">Edit project</a>`);
  });

  it('removes eligible missing records within one project and reports protected records', async () => {
    const res = await createProject('Missing Cleanup HTTP');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Missing Cleanup HTTP');
    const present = writeIndexedAsset(id, projectDir, 'present.png', 'present');
    const removable = assetRepo.upsert(id, 'removable.png', {
      filename: 'removable.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    const protectedAsset = assetRepo.upsert(id, 'protected.png', {
      filename: 'protected.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['present.png']);

    const otherRes = await createProject('Other Missing Cleanup HTTP');
    const otherId = Number(otherRes.headers.location.replace('/projects/', ''));
    const otherMissing = assetRepo.upsert(otherId, 'other.png', {
      filename: 'other.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
    });
    assetRepo.markAllMissing(otherId);

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

    expect(assetRepo.findById(removable.id)).toBeUndefined();
    expect(assetRepo.findById(protectedAsset.id)).toBeDefined();
    expect(assetRepo.findById(present.id)).toBeDefined();
    expect(assetRepo.findById(otherMissing.id)).toBeDefined();
    expect(fs.existsSync(path.join(projectDir, 'present.png'))).toBe(true);

    const rendered = await agent.get(response.headers.location).expect(200);
    expect(rendered.text).toContain('Missing asset cleanup complete: removed 1 of 2 missing asset records.');
    expect(rendered.text).toContain('Kept 1 missing asset record protected by published-release rules.');
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

    const style = await readStylesheetSource(response.text);
    const defaultsCardMatch = style.match(/(?:^|})\s*(\.asset-viewer-filters--project-assets[^{]*)\{([^}]*)\}/);
    const defaultsCardRule = defaultsCardMatch?.[2] || '';
    const defaultsLinkMatch = style.match(/(?:^|})\s*(\.asset-viewer-filters--project-assets\s*>\s*\.asset-viewer-defaults-link[^{]*)\{([^}]*)\}/);
    const defaultsLinkRule = defaultsLinkMatch?.[2] || '';
    expect(defaultsCardMatch?.[1]).toMatch(/\.asset-viewer-filters--asset-viewer/);
    expect(defaultsCardRule).toMatch(/padding-inline-end:\s*calc\(var\(--space-lg\) \+ 1\.6rem\)/);
    expect(defaultsCardRule).not.toMatch(/padding-top/);
    const projectFiltersBorderRule = style.match(/(?:^|})\s*\.asset-viewer-filters--project-assets\s*\{([^}]*)\}/)?.[1] || '';
    const categoryActionsCardRule = style.match(/(?:^|})\s*\.asset-actions-panel\s*\{([^}]*)\}/)?.[1] || '';
    expect(projectFiltersBorderRule).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(projectFiltersBorderRule).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(categoryActionsCardRule).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(categoryActionsCardRule).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(defaultsLinkMatch?.[1]).toMatch(/\.asset-viewer-filters--asset-viewer\s*>\s*\.asset-viewer-defaults-link/);
    expect(defaultsLinkRule).toMatch(/position:\s*absolute/);
    expect(defaultsLinkRule).toMatch(/top:\s*var\(--space-sm\)/);
    expect(defaultsLinkRule).toMatch(/right:\s*var\(--space-sm\)/);
    expect(style).toMatch(/\.asset-tooltip\[data-tooltip\]:hover::after[\s\S]*\.asset-tooltip\[data-tooltip\]:focus-visible::after/);
    expect(style).toMatch(/\.asset-tooltip\[data-tooltip\]::after[\s\S]*pointer-events:\s*none/);
  });

  it('renders page-local assigned asset tags in grid and list views without changing asset results', async () => {
    const res = await createProject('Asset Tag Browser Display');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const assets = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((filename) => assetRepo.upsert(id, filename, {
      filename,
      extension: 'txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      modifiedAt: null,
    }));
    const zebra = app.locals.tagService.createTag({ name: 'Zebra Display' });
    const shared = app.locals.tagService.createTag({ name: 'Shared Display' });
    const alpha = app.locals.tagService.createTag({ name: 'Alpha Display' });
    const projectOnly = app.locals.tagService.createTag({ name: 'Project Only Display' });

    app.locals.projectTagService.replaceProjectTags(id, [projectOnly.id]);
    app.locals.assetTagService.replaceAssetTags(assets[1].id, [zebra.id, shared.id, alpha.id]);
    app.locals.assetTagService.replaceAssetTags(assets[2].id, [shared.id]);

    const gridPageOne = await agent
      .get(`/projects/${id}/assets?sort=filename&order=asc&page=1&pageSize=2`)
      .expect(200);
    const untaggedCard = assetCardHtml(gridPageOne.text, assets[0].id);
    const taggedCard = assetCardHtml(gridPageOne.text, assets[1].id);
    const taggedCardTags = assetTagListHtml(taggedCard, 'asset-card-tags');

    expectNoAssetResultsCount(gridPageOne.text);
    expect(gridPageOne.text).toContain('<span class="selected-count" data-selected-count data-selected-total="2">0 of 2 selected</span>');
    expect(untaggedCard).not.toContain('asset-card-tags');
    expect(taggedCardTags.indexOf('Alpha Display')).toBeLessThan(taggedCardTags.indexOf('Shared Display'));
    expect(taggedCardTags.indexOf('Shared Display')).toBeLessThan(taggedCardTags.indexOf('Zebra Display'));
    expect(taggedCardTags).not.toContain('Project Only Display');
    expect(taggedCardTags).not.toContain('normalized_name');
    expect(taggedCardTags).not.toContain(`>${alpha.id}<`);
    expect(taggedCardTags).not.toContain(`>${shared.id}<`);
    expect(taggedCardTags).not.toContain(`>${zebra.id}<`);
    expect(taggedCardTags).not.toContain('href=');

    const listPageOne = await agent
      .get(`/projects/${id}/assets?sort=filename&order=asc&page=1&pageSize=2&view=list`)
      .expect(200);
    const listTaggedCard = assetListCardHtml(listPageOne.text, assets[1].id);
    const listUntaggedCard = assetListCardHtml(listPageOne.text, assets[0].id);
    const listTags = assetTagListHtml(listTaggedCard, 'asset-tag-list');

    expect(listPageOne.text).toContain('<ul class="asset-list asset-list--project" role="list" aria-label="Project assets" data-list-size="large">');
    expect(listPageOne.text).toContain('<article class="asset-list-card asset-list-card--project"');
    expect(listTags.indexOf('Alpha Display')).toBeLessThan(listTags.indexOf('Shared Display'));
    expect(listTags.indexOf('Shared Display')).toBeLessThan(listTags.indexOf('Zebra Display'));
    expect(listUntaggedCard).not.toContain('asset-tag-list');

    const gridPageTwo = await agent
      .get(`/projects/${id}/assets?sort=filename&order=asc&page=2&pageSize=2`)
      .expect(200);
    const sharedCard = assetCardHtml(gridPageTwo.text, assets[2].id);
    const secondUntaggedCard = assetCardHtml(gridPageTwo.text, assets[3].id);

    expect(sharedCard).toContain('Shared Display');
    expect(sharedCard).not.toContain('Alpha Display');
    expect(sharedCard).not.toContain('Zebra Display');
    expect(secondUntaggedCard).not.toContain('asset-card-tags');
    expect((gridPageTwo.text.match(/data-asset-id="\d+"/g) || [])).toHaveLength(2);
    expect(gridPageTwo.text).toContain('name="tag"');
    expect(gridPageTwo.text).not.toContain('sort=tag');
  });

  it('keeps assigned tags visible for missing assets and archived project Assets pages', async () => {
    const res = await createProject('Archived Asset Tag Display');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const asset = assetRepo.upsert(id, 'retained.txt', {
      filename: 'retained.txt',
      extension: 'txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      modifiedAt: null,
    });
    const tag = app.locals.tagService.createTag({ name: 'Retained Asset Tag' });
    app.locals.assetTagService.replaceAssetTags(asset.id, [tag.id]);
    db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(asset.id);

    const missing = await agent.get(`/projects/${id}/assets?presence=missing&view=list`).expect(200);
    expect(assetListCardHtml(missing.text, asset.id)).toContain('Retained Asset Tag');
    expectNoAssetResultsCount(missing.text);

    await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

    const archived = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    expect(assetCardHtml(archived.text, asset.id)).toContain('Retained Asset Tag');
    expect(archived.text).not.toContain('Scan Now');
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
    const filterForm = pageOne.text.match(/<form class="filters asset-viewer-filters asset-viewer-filters--project-assets" method="get" action="\/projects\/\d+\/assets" id="asset-filters">[\s\S]*?<\/form>/)?.[0] || '';
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
    const resetAnchor = multiple.text.match(/<a\b[^>]*data-project-assets-reset[^>]*>/)?.[0] || '';
    const resetHref = resetAnchor.match(/\bhref="([^"]+)"/)?.[1];

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

  // ─── Phase B Chunk 3: bare-page defaults ─────────────────────────────

  describe('bare Assets-page default resolution', () => {
    async function projectIdFor(title) {
      const res = await createProject(title);
      return Number(res.headers.location.replace('/projects/', ''));
    }

    function firstProjectCategory(projectId) {
      const [category] = assetCategoryRepo.listProjectCategories(projectId);
      if (!category) throw new Error(`project ${projectId} has no category`);
      return category;
    }

    async function expectBareAll(title, configure) {
      const id = await projectIdFor(title);
      await configure(id);

      const response = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.text).toMatch(/<input id="asset-category-option-all"[\s\S]*?checked>/);
      return id;
    }

    it('renders All without redirect when the project preference is All', async () => {
      await expectBareAll('Bare Project All', async (id) => {
        assetBrowserPreferenceRepo.upsertProjectPreference(id, 'all', null);
      });
    });

    it('renders All when the project inherits a global All preference', async () => {
      await expectBareAll('Bare Inherit Global All', async (id) => {
        assetBrowserPreferenceRepo.upsertProjectPreference(id, 'inherit', null);
        assetBrowserPreferenceRepo.setGlobalDefault('all');
      });
    });

    it('redirects a valid project-specific default to its numeric category ID', async () => {
      const id = await projectIdFor('Bare Specific Default');
      const category = firstProjectCategory(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);

      const response = await agent.get(`/projects/${id}/assets`).expect(302);
      expect(response.headers.location).toBe(`/projects/${id}/assets?category=${category.id}`);
    });

    it('filters after a project category preference canonicalizes a bare request', async () => {
      const id = await projectIdFor('Bare Specific Default Filter');
      const category = firstProjectCategory(id);
      const projectDir = getProjectDir('Bare Specific Default Filter');
      writeIndexedAsset(id, projectDir, 'preferred.png', 'png', { categoryId: category.id });
      writeIndexedAsset(id, projectDir, 'preferred.jpg', 'jpg', { categoryId: category.id });
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);

      const redirect = await agent.get(`/projects/${id}/assets`).expect(302);
      expect(redirect.headers.location).toBe(`/projects/${id}/assets?category=${category.id}`);

      const filtered = await agent.get(`${redirect.headers.location}&extension=png`).expect(200);
      expect(filtered.text).toContain('preferred.png');
      expect(filtered.text).not.toContain('preferred.jpg');
      expect(filtered.text).not.toContain('data-auto-rename-surface');
    });

    it('redirects an inherited matching global slug to the project category ID', async () => {
      const id = await projectIdFor('Bare Inherited Slug');
      const category = firstProjectCategory(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'inherit', null);
      assetBrowserPreferenceRepo.setGlobalDefault(category.directory_slug);

      const response = await agent.get(`/projects/${id}/assets`).expect(302);
      expect(response.headers.location).toBe(`/projects/${id}/assets?category=${category.id}`);
    });

    it('falls back to All when a stored project category is disabled without clearing storage', async () => {
      const id = await projectIdFor('Bare Disabled Default');
      const category = firstProjectCategory(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);
      assetCategoryRepo.setProjectCategoryEnabled(id, category.id, false);

      const response = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.text).toMatch(/<input id="asset-category-option-all"[\s\S]*?checked>/);
      expect(assetBrowserPreferenceRepo.findProjectPreference(id)).toMatchObject({
        default_category_mode: 'category',
        default_category_id: category.id,
      });
    });

    it('falls back to All when a stored project category is stale without clearing storage', async () => {
      const id = await projectIdFor('Bare Stale Default');
      const category = firstProjectCategory(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);
      db.prepare('DELETE FROM project_asset_categories WHERE project_id = ? AND id = ?').run(id, category.id);

      const response = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(assetBrowserPreferenceRepo.findProjectPreference(id)).toMatchObject({
        default_category_mode: 'category',
        default_category_id: category.id,
      });
    });

    it.each(['missing', 'disabled'])('falls back to All for an inherited %s global slug', async (change) => {
      const id = await projectIdFor(`Bare Global ${change}`);
      const category = firstProjectCategory(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'inherit', null);
      assetBrowserPreferenceRepo.setGlobalDefault(category.directory_slug);
      if (change === 'missing') {
        db.prepare('DELETE FROM project_asset_categories WHERE project_id = ? AND id = ?').run(id, category.id);
      } else {
        assetCategoryRepo.setProjectCategoryEnabled(id, category.id, false);
      }

      const response = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(assetBrowserPreferenceRepo.getGlobalDefault()).toBe(category.directory_slug);
    });

    it('resolves a bare specific default before the full browser query', async () => {
      const project = db.prepare(`
        INSERT INTO projects (title, slug, description, notes, status,
                              planned_date, published_date, patreon_url, archived_at)
        VALUES ('Early Default Project', 'early-default-project', '', '', 'tbd', NULL, NULL, NULL, NULL)
        RETURNING *
      `).get();
      const fullBrowserQuery = vi.fn(() => {
        throw new Error('full browser query should not run for a default redirect');
      });
      const preferenceService = {
        resolveEffectiveCategory: vi.fn(() => ({
          effective: { kind: 'category', category: { id: 77 } },
        })),
      };
      const isolatedAppDataRoot = path.join(tmpDir, 'early-default-app');
      fs.mkdirSync(isolatedAppDataRoot, { recursive: true });
      const isolatedApp = createApp(
        { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
        {
          appDataRoot: isolatedAppDataRoot,
          workflowQueryService: { getProjectAssetBrowser: fullBrowserQuery },
          assetBrowserPreferenceService: preferenceService,
        }
      );

      const response = await request(isolatedApp).get(`/projects/${project.id}/assets`).expect(302);
      expect(response.headers.location).toBe(`/projects/${project.id}/assets?category=77`);
      expect(preferenceService.resolveEffectiveCategory).toHaveBeenCalledWith(project.id);
      expect(fullBrowserQuery).not.toHaveBeenCalled();
    });
  });

  describe('saved Project Assets presentation defaults', () => {
    it('saves page-local defaults and applies them on a later bare render', async () => {
      const res = await createProject('Project Assets Defaults Save');
      const id = Number(res.headers.location.replace('/projects/', ''));

      const save = await agent
        .post(`/projects/${id}/assets/defaults`)
        .type('form')
        .send({
          view: 'list',
          gridSize: 'large',
          listSize: 'compact',
          sort: 'category',
          order: 'desc',
          pageSize: '50',
          extension: 'all',
          tag: 'all',
          returnTo: `/projects/${id}/assets`,
          _csrf: csrfToken,
        })
        .expect(302);

      expect(save.headers.location).toBe(
        `/projects/${id}/assets?view=list&sort=category&order=desc&pageSize=50&notice=project_assets_defaults_saved`,
      );
      expect(save.headers.location).not.toContain('gridSize');
      expect(save.headers.location).not.toContain('listSize');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key).value).toBe('list');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.gridSize.key).value).toBe('large');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.listSize.key).value).toBe('compact');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key).value).toBe('category');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.order.key).value).toBe('desc');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.pageSize.key).value).toBe('50');

      const bare = await agent.get(`/projects/${id}/assets`).expect(302);
      expect(bare.headers.location).toBe(
        `/projects/${id}/assets?sort=category&order=desc&pageSize=50&view=list`,
      );

      const rendered = await agent.get(bare.headers.location).expect(200);
      expect(rendered.headers.location).toBeUndefined();
      expect(rendered.text).toContain('name="view" value="list"');
      expect(rendered.text).toContain('name="pageSize" value="50"');
      expect(rendered.text).toMatch(/name="sort"[^>]+value="category"[^>]+checked/);
      expect(rendered.text).toMatch(/name="order"[^>]+value="desc"[^>]+checked/);
    });

    it('resolves Project Assets presentation and dialog defaults per project while inheriting Global values', async () => {
      const first = await createProject('Scoped Project Assets First');
      const firstId = Number(first.headers.location.replace('/projects/', ''));
      const second = await createProject('Scoped Project Assets Second');
      const secondId = Number(second.headers.location.replace('/projects/', ''));
      saveAssetDefault('view', 'grid');
      saveAssetDefault('gridSize', 'large');
      saveAssetDefault('listSize', 'compact');
      saveAssetDefault('sort', 'modified');
      saveAssetDefault('order', 'desc');
      saveAssetDefault('pageSize', '50');
      saveProjectAssetDefault(firstId, 'view', 'list');
      saveProjectAssetDefault(firstId, 'sort', 'size');
      saveProjectAssetDefault(firstId, 'gridSize', 'compact');

      const firstBare = await agent.get(`/projects/${firstId}/assets`).expect(302);
      expect(firstBare.headers.location).toBe(
        `/projects/${firstId}/assets?sort=size&order=desc&pageSize=50&view=list`,
      );
      const secondBare = await agent.get(`/projects/${secondId}/assets`).expect(302);
      expect(secondBare.headers.location).toBe(
        `/projects/${secondId}/assets?sort=modified&order=desc&pageSize=50`,
      );

      const rendered = await agent.get(`/projects/${firstId}/assets?defaults=1`).expect(200);
      expect(rendered.text).toContain('data-project-assets-grid-size-default="compact"');
      expect(rendered.text).toContain('data-project-assets-list-size-default="compact"');
      const defaultsDialog = rendered.text.match(/<dialog id="project-assets-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(defaultsDialog).toMatch(/name="view"[\s\S]*?value="list" selected/);
      expect(defaultsDialog).toMatch(/name="sort"[\s\S]*?value="size" selected/);
      expect(defaultsDialog).toMatch(/name="order"[\s\S]*?value="desc" selected/);
      expect(defaultsDialog).toMatch(/name="pageSize"[\s\S]*?value="50" selected/);
    });

    it('renders the Project Assets defaults scope control with safe selected-state binding', async () => {
      const project = await createProject('Project Assets Defaults Scope Control');
      const id = Number(project.headers.location.replace('/projects/', ''));
      const values = {
        view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all', returnTo: `/projects/${id}/assets`, _csrf: csrfToken,
      };
      const readDefaultsDialog = (html) => (
        html.match(/<dialog id="project-assets-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || ''
      );
      const checkedScope = (dialog, value) => new RegExp(
        `<input[^>]*name="scope"[^>]*value="${value}"[^>]*checked`,
      ).test(dialog);

      const globalResponse = await agent.get(`/projects/${id}/assets?defaults=1`).expect(200);
      const globalDialog = readDefaultsDialog(globalResponse.text);
      const scopeStart = globalDialog.indexOf('data-project-assets-defaults-scope');
      const gridStart = globalDialog.indexOf('<div class="page-defaults-grid">');
      const statusStart = globalDialog.indexOf('<div class="app-dialog-status"');
      const footerStart = globalDialog.indexOf('<footer class="app-dialog-footer">');

      expect(scopeStart).toBeGreaterThan(globalDialog.indexOf('name="returnTo"'));
      expect(scopeStart).toBeLessThan(gridStart);
      expect(globalDialog.slice(scopeStart, gridStart)).toContain('<legend class="sr-only">Defaults scope</legend>');
      expect(globalDialog.slice(scopeStart, gridStart)).toContain('>Global</label>');
      expect(globalDialog.slice(scopeStart, gridStart)).toContain('>Project only</label>');
      expect(globalDialog.slice(scopeStart, gridStart).indexOf('>Global</label>'))
        .toBeLessThan(globalDialog.slice(scopeStart, gridStart).indexOf('>Project only</label>'));
      expect((globalDialog.match(/name="scope"/g) || [])).toHaveLength(2);
      expect(globalDialog).toMatch(/<input[^>]*name="scope"[^>]*value="global"/);
      expect(globalDialog).toMatch(/<input[^>]*name="scope"[^>]*value="project"/);
      expect(checkedScope(globalDialog, 'global')).toBe(true);
      expect(checkedScope(globalDialog, 'project')).toBe(false);
      expect((globalDialog.match(/name="scope"[^>]*checked/g) || []).length
        + (globalDialog.match(/checked[^>]*name="scope"/g) || []).length).toBe(1);
      expect(globalDialog.slice(gridStart, statusStart)).not.toContain('data-project-assets-defaults-scope');
      expect(statusStart).toBeGreaterThan(gridStart);
      expect(footerStart).toBeGreaterThan(statusStart);

      saveProjectAssetDefault(id, 'view', 'list');
      const projectResponse = await agent.get(`/projects/${id}/assets?defaults=1`).expect(200);
      const projectDialog = readDefaultsDialog(projectResponse.text);
      expect(checkedScope(projectDialog, 'global')).toBe(false);
      expect(checkedScope(projectDialog, 'project')).toBe(true);

      const validScopeFailure = await agent.post(`/projects/${id}/assets/defaults`).type('form').send({
        ...values, scope: 'project', loadedScope: 'project', listSize: 'default',
      }).expect(422);
      expect(checkedScope(readDefaultsDialog(validScopeFailure.text), 'project')).toBe(true);

      const invalidScopeFailure = await agent.post(`/projects/${id}/assets/defaults`).type('form').send({
        ...values, scope: 'invalid',
      }).expect(422);
      const invalidScopeDialog = readDefaultsDialog(invalidScopeFailure.text);
      expect(invalidScopeDialog).toContain('Choose either Global or Project-only defaults.');
      expect(checkedScope(invalidScopeDialog, 'global')).toBe(true);
      expect(checkedScope(invalidScopeDialog, 'project')).toBe(false);

      const projectsDefaults = await agent.get('/projects?defaults=1').expect(200);
      const assetViewerDefaults = await agent.get('/assets?defaults=1').expect(200);
      expect(projectsDefaults.text).not.toContain('data-project-assets-defaults-scope');
      expect(assetViewerDefaults.text).not.toContain('data-project-assets-defaults-scope');
    });

    it('serializes only the two resolved eight-value scope sets and aligns loadedScope', async () => {
      const project = await createProject('Project Assets Defaults Scope Data');
      const id = Number(project.headers.location.replace('/projects/', ''));
      const globalValues = {
        view: 'grid', gridSize: 'large', listSize: 'compact', sort: 'modified', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all',
      };
      for (const [option, value] of Object.entries(globalValues)) saveAssetDefault(option, value);

      const readPayload = (html) => JSON.parse(
        html.match(/<script type="application\/json" data-project-assets-default-values>([\s\S]*?)<\/script>/)?.[1] || '{}',
      );
      const globalResponse = await agent.get(`/projects/${id}/assets?defaults=1`).expect(200);
      const globalPayload = readPayload(globalResponse.text);
      expect(globalResponse.text).toContain('name="loadedScope" value="global"');
      expect(Object.keys(globalPayload)).toEqual(['global', 'project']);
      expect(Object.keys(globalPayload.global)).toEqual(Object.keys(globalValues));
      expect(Object.keys(globalPayload.project)).toEqual(Object.keys(globalValues));
      expect(globalPayload.global).toEqual(globalValues);
      expect(globalPayload.project).toEqual(globalValues);
      expect(JSON.stringify(globalPayload)).not.toContain('Grid size');
      expect(JSON.stringify(globalPayload)).not.toContain('All extensions');

      saveProjectAssetDefault(id, 'view', 'list');
      saveProjectAssetDefault(id, 'extension', 'stale-extension');
      const projectResponse = await agent.get(`/projects/${id}/assets?defaults=1`).expect(200);
      const projectPayload = readPayload(projectResponse.text);
      expect(projectResponse.text).toContain('name="loadedScope" value="project"');
      expect(projectPayload.global).toEqual(globalValues);
      expect(projectPayload.project).toEqual({ ...globalValues, view: 'list' });
    });

    it('guards loaded scope changes before validation or writes for HTML, JSON, active, and archived submissions', async () => {
      const values = {
        view: 'list', gridSize: 'compact', listSize: 'compact', sort: 'size', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all',
      };
      const project = await createProject('Project Assets Loaded Scope Guard');
      const id = Number(project.headers.location.replace('/projects/', ''));
      saveAssetDefault('view', 'grid');
      saveProjectAssetDefault(id, 'view', 'list');
      const globalBefore = app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets');
      const projectBefore = app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets');

      const globalMismatch = await agent.post(`/projects/${id}/assets/defaults`).type('form').send({
        ...values, scope: 'global', loadedScope: 'project', returnTo: `/projects/${id}/assets`, _csrf: csrfToken,
      }).expect(422);
      expect(globalMismatch.text).toContain('The selected defaults scope does not match the loaded values.');
      expect(globalMismatch.text).toContain('name="loadedScope" value="global"');
      expect(globalMismatch.text).toMatch(/name="view"[\s\S]*?value="list" selected/);
      expect(globalMismatch.text).toMatch(/name="scope"[^>]*value="global"[^>]*aria-describedby="project-assets-defaults-scope-error"/);
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets')).toEqual(globalBefore);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual(projectBefore);

      const projectMismatch = await agent.post(`/projects/${id}/assets/defaults`).set('Accept', 'application/json').type('form').send({
        ...values, scope: 'project', loadedScope: 'global', _csrf: csrfToken,
      }).expect(422);
      expect(projectMismatch.body.errors.scope).toContain('does not match');
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets')).toEqual(globalBefore);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual(projectBefore);

      const invalidMarker = await agent.post(`/projects/${id}/assets/defaults`).set('Accept', 'application/json').type('form').send({
        ...values, scope: 'global', loadedScope: 'other', _csrf: csrfToken,
      }).expect(422);
      expect(invalidMarker.body.errors.scope).toContain('loaded defaults scope is invalid');
      await agent.post(`/projects/${id}/assets/defaults`).set('Accept', 'application/json').type('form').send({
        ...values, scope: 'project', _csrf: csrfToken,
      }).expect(422);
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets')).toEqual(globalBefore);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual(projectBefore);

      await agent.post(`/projects/${id}/assets/defaults`).type('form').send({
        ...values, scope: 'project', loadedScope: 'project', returnTo: `/projects/${id}/assets`, _csrf: csrfToken,
      }).expect(302);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual(values);
      await agent.post(`/projects/${id}/assets/defaults`).type('form').send({
        ...values, scope: 'global', loadedScope: 'global', returnTo: `/projects/${id}/assets`, _csrf: csrfToken,
      }).expect(302);
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets')).toEqual(values);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual({});

      const archived = await createProject('Archived Project Assets Loaded Scope Guard');
      const archivedId = Number(archived.headers.location.replace('/projects/', ''));
      saveProjectAssetDefault(archivedId, 'view', 'grid');
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archivedId);
      const archivedBefore = app.locals.projectPageDefaultRepository.getPageOptions(archivedId, 'projectAssets');
      await agent.post(`/projects/${archivedId}/assets/defaults`).type('form').send({
        ...values, scope: 'project', loadedScope: 'global', returnTo: `/projects/${archivedId}/assets`, _csrf: csrfToken,
      }).expect(422);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(archivedId, 'projectAssets')).toEqual(archivedBefore);
    });

    it('exposes scoped Global, Project, and effective defaults in the Project Assets render model', async () => {
      const project = await createProject('Scoped Project Assets Render Model');
      const id = Number(project.headers.location.replace('/projects/', ''));
      const globalTag = app.locals.tagService.createTag({ name: 'Render global tag' });
      const projectTag = app.locals.tagService.createTag({ name: 'Render project tag' });
      saveAssetDefault('view', 'grid');
      writeStoredAssetDefault('extension', 'jpg');
      writeStoredAssetDefault('tag', String(globalTag.id));
      saveProjectAssetDefault(id, 'view', 'list');
      saveProjectAssetDefault(id, 'extension', 'png');
      saveProjectAssetDefault(id, 'tag', String(projectTag.id));

      const model = buildBrowserRenderModel(
        { id, project_dir: null },
        {
          assets: [], total: 0, page: 1, pageSize: 25, pageCount: 1, filters: {},
          extensionChoices: [], tagOptions: [], categoryNavigation: { enabled: [], disabled: [] },
          emptyState: null, isArchived: false, releaseTargets: [], searchMaxLength: 100,
        },
        app.locals.pageDefaultsService,
        null,
        {
          getProjectAssetsDefaultExtensions: () => ['jpg', 'png'],
          getProjectTagFilterOptions: () => [
            { value: String(globalTag.id), displayName: 'Render global tag' },
            { value: String(projectTag.id), displayName: 'Render project tag' },
          ],
        },
      );

      expect(model.projectAssetsDefaultsScope).toBe('project');
      expect(model.projectAssetsDefaultsSelectedScope).toBe('project');
      expect(model.projectAssetsDefaultsLoadedScope).toBe('project');
      expect(model.projectAssetsGlobalDefaults).toMatchObject({ view: 'grid', extension: 'jpg', tag: String(globalTag.id) });
      expect(model.projectAssetsProjectDefaults).toMatchObject({ view: 'list', extension: 'png', tag: String(projectTag.id) });
      expect(model.projectAssetsEffectiveDefaults).toEqual(model.projectAssetsProjectDefaults);
      expect(JSON.parse(model.projectAssetsDefaultValuesJson)).toEqual({
        global: model.projectAssetsGlobalDefaults,
        project: model.projectAssetsProjectDefaults,
      });
    });

    it('applies project filter rows on bare requests while explicit and neutral requests stay authoritative', async () => {
      const project = await createProject('Scoped Project Assets Filters');
      const id = Number(project.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Scoped Project Assets Filters');
      writeIndexedAsset(id, projectDir, 'default.jpg', 'jpg');
      writeIndexedAsset(id, projectDir, 'override.png', 'png');
      const globalTag = app.locals.tagService.createTag({ name: 'Scoped global tag' });
      const projectTag = app.locals.tagService.createTag({ name: 'Scoped project tag' });
      writeStoredAssetDefault('extension', 'jpg');
      writeStoredAssetDefault('tag', String(globalTag.id));
      saveProjectAssetDefault(id, 'extension', 'png');
      saveProjectAssetDefault(id, 'tag', String(projectTag.id));

      const bare = await agent.get(`/projects/${id}/assets`).expect(302);
      expect(bare.headers.location).toBe(`/projects/${id}/assets?tag=${projectTag.id}&extension=png`);
      await agent.get(`/projects/${id}/assets?extension=all&tag=all`).expect(200);
      await agent.get(`/projects/${id}/assets?category=all`).expect(200);

      saveProjectAssetDefault(id, 'extension', 'stale-project-extension');
      saveProjectAssetDefault(id, 'tag', '999999');
      const inherited = await agent.get(`/projects/${id}/assets`).expect(302);
      expect(inherited.headers.location).toBe(`/projects/${id}/assets?tag=${globalTag.id}&extension=jpg`);
      expect(app.locals.projectPageDefaultRepository.getOption(id, 'projectAssets', 'extension'))
        .toBe('stale-project-extension');
      expect(app.locals.projectPageDefaultRepository.getOption(id, 'projectAssets', 'tag')).toBe('999999');

      writeStoredAssetDefault('extension', 'stale-global-extension');
      writeStoredAssetDefault('tag', '999998');
      await agent.get(`/projects/${id}/assets`).expect(200);
      expect(app.locals.projectPageDefaultRepository.getOption(id, 'projectAssets', 'extension'))
        .toBe('stale-project-extension');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.extension.key).value).toBe('stale-global-extension');
    });

    it('uses project defaults for archived pages and makes a missing scope save Global', async () => {
      const archived = await createProject('Scoped Archived Project Assets');
      const archivedId = Number(archived.headers.location.replace('/projects/', ''));
      saveProjectAssetDefault(archivedId, 'view', 'list');
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archivedId);
      const archivedBare = await agent.get(`/projects/${archivedId}/assets`).expect(302);
      expect(archivedBare.headers.location).toBe(`/projects/${archivedId}/assets?view=list`);

      const archivedValues = {
        view: 'list', gridSize: 'compact', listSize: 'compact', sort: 'size', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all',
      };
      await agent.post(`/projects/${archivedId}/assets/defaults`).type('form').send({
        ...archivedValues, scope: 'project', loadedScope: 'project', returnTo: `/projects/${archivedId}/assets`, _csrf: csrfToken,
      }).expect(302);
      expect(app.locals.pageDefaultsService.getPageDefaultScope('projectAssets', { projectId: archivedId })).toBe('project');
      await agent.post(`/projects/${archivedId}/assets/defaults`).type('form').send({
        ...archivedValues, scope: 'global', returnTo: `/projects/${archivedId}/assets`, _csrf: csrfToken,
      }).expect(302);
      expect(app.locals.pageDefaultsService.getPageDefaultScope('projectAssets', { projectId: archivedId })).toBe('global');

      const active = await createProject('Scoped Project Assets Global POST');
      const activeId = Number(active.headers.location.replace('/projects/', ''));
      saveProjectAssetDefault(activeId, 'view', 'list');
      await agent.post(`/projects/${activeId}/assets/defaults`).type('form').send({
        view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc',
        pageSize: '25', extension: 'all', tag: 'all', returnTo: `/projects/${activeId}/assets`,
        _csrf: csrfToken,
      }).expect(302);
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key).value).toBe('grid');
      expect(app.locals.projectPageDefaultRepository.getOption(activeId, 'projectAssets', 'view')).toBeUndefined();
      expect(app.locals.pageDefaultsService.getPageDefaultScope('projectAssets', { projectId: activeId })).toBe('global');
    });

    it('uses global Extension and Tag catalogues without broadening the project filters', async () => {
      const source = await createProject('Global Project Assets Default Source');
      const sourceId = Number(source.headers.location.replace('/projects/', ''));
      const target = await createProject('Global Project Assets Default Target');
      const targetId = Number(target.headers.location.replace('/projects/', ''));
      writeIndexedAsset(sourceId, getProjectDir('Global Project Assets Default Source'), 'source.jpg', 'jpg');
      writeIndexedAsset(targetId, getProjectDir('Global Project Assets Default Target'), 'target.png', 'png');
      const tag = app.locals.tagService.createTag({ name: 'Global default tag' });
      const values = {
        view: 'grid',
        gridSize: 'default',
        listSize: 'large',
        sort: 'filename',
        order: 'asc',
        pageSize: '25',
        extension: 'jpg',
        tag: String(tag.id),
        _csrf: csrfToken,
      };

      const saved = await agent
        .post('/projects/' + sourceId + '/assets/defaults')
        .type('form')
        .send({ ...values, returnTo: '/projects/' + sourceId + '/assets' })
        .expect(302);

      const savedUrl = new URL(saved.headers.location, 'http://localhost');
      expect(savedUrl.searchParams.get('tag')).toBe(String(tag.id));
      expect(savedUrl.searchParams.get('extension')).toBe('jpg');
      await agent.get(saved.headers.location).expect(200);

      const rendered = await agent.get('/projects/' + targetId + '/assets?defaults=1').expect(200);
      const defaultsDialog = rendered.text.match(/<dialog id="project-assets-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(defaultsDialog).toContain('<option value="jpg" selected>.jpg</option>');
      expect(defaultsDialog).toContain('<option value="' + tag.id + '" selected>Global default tag</option>');
      expect(defaultsDialog).toContain('value="jpg"');
      expect(defaultsDialog).toContain('>.jpg</span>');
      expect(defaultsDialog).toContain('>Global default tag</span>');

      const projectExtensionFilter = assetExtensionFilterHtml(rendered.text);
      expect(projectExtensionFilter).toContain('>.png</span>');
      expect(projectExtensionFilter).not.toContain('>.jpg</span>');

      const bare = await agent.get('/projects/' + targetId + '/assets').expect(302);
      expect(bare.headers.location).toBe(
        '/projects/' + targetId + '/assets?tag=' + tag.id + '&extension=jpg',
      );

      const canonical = await agent.get(bare.headers.location).expect(200);
      expect(canonical.headers.location).toBeUndefined();
      const selectedExtensionFilter = assetExtensionFilterHtml(canonical.text);
      expectCheckedAssetFilter(selectedExtensionFilter, 'extension', 'jpg');
      expect(selectedExtensionFilter).toContain('>.png</span>');
      expect(selectedExtensionFilter).toContain('>.jpg</span>');
      expect(assetTagFilterHtml(canonical.text)).toMatch(
        new RegExp('name="tag"[^>]+type="checkbox"[^>]+value="' + tag.id + '"[^>]*checked'),
      );

      const resetAnchor = canonical.text.match(/<a\b[^>]*data-project-assets-reset[^>]*>/)?.[0] || '';
      const resetHref = resetAnchor.match(/\bhref="([^"]+)"/)?.[1];
      expect(decodeHtmlHref(resetHref)).toBe('/projects/' + targetId + '/assets?category=all');
      const reset = await agent.get(decodeHtmlHref(resetHref)).expect(200);
      expect(reset.headers.location).toBeUndefined();
      expect(assetExtensionFilterHtml(reset.text)).not.toContain('>.jpg</span>');

      await agent
        .post('/projects/' + targetId + '/assets/defaults')
        .type('form')
        .send({ ...values, returnTo: '/projects/' + targetId + '/assets' })
        .expect(302);

      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.extension.key).value).toBe('jpg');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.tag.key).value).toBe(String(tag.id));
    });

    it('keeps explicit filter values authoritative and leaves stale global filters in storage', async () => {
      const source = await createProject('Project Assets Explicit Source');
      const sourceId = Number(source.headers.location.replace('/projects/', ''));
      const target = await createProject('Project Assets Explicit Target');
      const targetId = Number(target.headers.location.replace('/projects/', ''));
      writeIndexedAsset(sourceId, getProjectDir('Project Assets Explicit Source'), 'source.jpg', 'jpg');
      writeIndexedAsset(targetId, getProjectDir('Project Assets Explicit Target'), 'target.png', 'png');
      const savedTag = app.locals.tagService.createTag({ name: 'Saved filter tag' });
      const explicitTag = app.locals.tagService.createTag({ name: 'Explicit filter tag' });
      writeStoredAssetDefault('extension', 'jpg');
      writeStoredAssetDefault('tag', String(savedTag.id));

      const explicit = await agent
        .get('/projects/' + targetId + '/assets?extension=png&tag=' + explicitTag.id)
        .expect(200);
      expect(explicit.headers.location).toBeUndefined();
      expectCheckedAssetFilter(assetExtensionFilterHtml(explicit.text), 'extension', 'png');
      expect(assetExtensionFilterHtml(explicit.text)).not.toContain('>.jpg</span>');
      expect(assetTagFilterHtml(explicit.text)).toMatch(
        new RegExp('name="tag"[^>]+type="checkbox"[^>]+value="' + explicitTag.id + '"[^>]*checked'),
      );

      const explicitNeutral = await agent
        .get('/projects/' + targetId + '/assets?extension=all&tag=all')
        .expect(200);
      expect(explicitNeutral.headers.location).toBeUndefined();
      expect(assetExtensionFilterHtml(explicitNeutral.text)).not.toContain('>.jpg</span>');

      writeStoredAssetDefault('extension', 'deleted-extension');
      writeStoredAssetDefault('tag', '999999');
      const stale = await agent.get('/projects/' + targetId + '/assets').expect(200);
      expect(stale.headers.location).toBeUndefined();
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.extension.key).value).toBe('deleted-extension');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets.tag.key).value).toBe('999999');
    });

    it('saves complete Project-only defaults without touching Global values or another project', async () => {
      const first = await createProject('Scoped Save Project A');
      const firstId = Number(first.headers.location.replace('/projects/', ''));
      const second = await createProject('Scoped Save Project B');
      const secondId = Number(second.headers.location.replace('/projects/', ''));
      const globalValues = {
        view: 'grid', gridSize: 'large', listSize: 'large', sort: 'filename', order: 'asc',
        pageSize: '25', extension: 'all', tag: 'all',
      };
      const projectValues = {
        view: 'list', gridSize: 'compact', listSize: 'compact', sort: 'modified', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all',
      };
      for (const [option, value] of Object.entries(globalValues)) saveAssetDefault(option, value);
      saveProjectAssetDefault(secondId, 'view', 'list');

      const save = await agent.post(`/projects/${firstId}/assets/defaults`).type('form').send({
        ...projectValues,
        scope: 'project',
        loadedScope: 'project',
        returnTo: `/projects/${firstId}/assets`,
        _csrf: csrfToken,
      }).expect(302);

      expect(app.locals.projectPageDefaultRepository.getPageOptions(firstId, 'projectAssets')).toEqual(projectValues);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(secondId, 'projectAssets')).toEqual({ view: 'list' });
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets')).toEqual(globalValues);
      expect(app.locals.pageDefaultsService.getPageDefaultScope('projectAssets', { projectId: firstId })).toBe('project');
      const converged = await agent.get(save.headers.location).expect(200);
      expect(converged.headers.location).toBeUndefined();
    });

    it('applies Project-only persistence for enhanced JSON submissions', async () => {
      const project = await createProject('Scoped JSON Save');
      const id = Number(project.headers.location.replace('/projects/', ''));
      const values = {
        view: 'list', gridSize: 'compact', listSize: 'compact', sort: 'modified', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all',
      };

      const response = await agent.post(`/projects/${id}/assets/defaults`).set('Accept', 'application/json').type('form').send({
        ...values, scope: 'project', loadedScope: 'project', _csrf: csrfToken,
      }).expect(200);

      expect(response.body).toMatchObject({ status: 'success', values });
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual(values);
      expect(app.locals.pageDefaultsService.getPageDefaultScope('projectAssets', { projectId: id })).toBe('project');
    });

    it('saves Global defaults and clears only the current project scope', async () => {
      const first = await createProject('Scoped Global Save Project A');
      const firstId = Number(first.headers.location.replace('/projects/', ''));
      const second = await createProject('Scoped Global Save Project B');
      const secondId = Number(second.headers.location.replace('/projects/', ''));
      const values = {
        view: 'list', gridSize: 'compact', listSize: 'compact', sort: 'size', order: 'desc',
        pageSize: '100', extension: 'all', tag: 'all',
      };
      saveProjectAssetDefault(firstId, 'view', 'grid');
      saveProjectAssetDefault(secondId, 'view', 'list');

      const save = await agent.post(`/projects/${firstId}/assets/defaults`).type('form').send({
        ...values,
        scope: 'global',
        returnTo: `/projects/${firstId}/assets`,
        _csrf: csrfToken,
      }).expect(302);

      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets')).toEqual(values);
      expect(app.locals.projectPageDefaultRepository.getPageOptions(firstId, 'projectAssets')).toEqual({});
      expect(app.locals.projectPageDefaultRepository.getPageOptions(secondId, 'projectAssets')).toEqual({ view: 'list' });
      expect(app.locals.pageDefaultsService.resolvePageDefaults(
        'projectAssets', {}, {}, { projectId: firstId },
      )).toEqual(values);
      expect(app.locals.pageDefaultsService.getPageDefaultScope('projectAssets', { projectId: firstId })).toBe('global');
      const converged = await agent.get(save.headers.location).expect(200);
      expect(converged.headers.location).toBeUndefined();
    });

    it('rejects an invalid scope before either persistence branch writes', async () => {
      const project = await createProject('Scoped Invalid Scope');
      const id = Number(project.headers.location.replace('/projects/', ''));
      saveAssetDefault('view', 'grid');
      saveProjectAssetDefault(id, 'view', 'list');

      const response = await agent.post(`/projects/${id}/assets/defaults`).set('Accept', 'application/json').type('form').send({
        view: 'list', gridSize: 'compact', listSize: 'compact', sort: 'size', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all', scope: 'other',
        returnTo: `/projects/${id}/assets`, _csrf: csrfToken,
      }).expect(422);

      expect(response.body.errors.scope).toContain('Global');
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets').view).toBe('grid');
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual({ view: 'list' });
    });

    it('rolls back Global writes and the current-project clear when clearing fails', async () => {
      const project = await createProject('Scoped Global Rollback');
      const id = Number(project.headers.location.replace('/projects/', ''));
      saveAssetDefault('view', 'grid');
      saveProjectAssetDefault(id, 'view', 'list');
      const service = app.locals.pageDefaultsService;
      const clearProjectPageDefaults = service.clearProjectPageDefaults;
      const clearSpy = vi.spyOn(service, 'clearProjectPageDefaults').mockImplementation((...args) => {
        clearProjectPageDefaults(...args);
        throw new Error('simulated project default clear failure');
      });

      await agent.post(`/projects/${id}/assets/defaults`).set('Accept', 'application/json').type('form').send({
        view: 'list', gridSize: 'compact', listSize: 'compact', sort: 'size', order: 'desc',
        pageSize: '50', extension: 'all', tag: 'all', scope: 'global',
        returnTo: `/projects/${id}/assets`, _csrf: csrfToken,
      }).expect(500);

      clearSpy.mockRestore();
      expect(app.locals.pageDefaultsService.resolveGlobalPageDefaults('projectAssets').view).toBe('grid');
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual({ view: 'list' });
    });

    it.each([
      ['gridSize', 'invalid-grid-size'],
      ['listSize', 'default'],
      ['extension', 'invalid-extension'],
      ['tag', '999999'],
    ])('rejects invalid Project Assets %s values without saving', async (option, invalidValue) => {
      const res = await createProject(`Project Assets Invalid ${option}`);
      const id = Number(res.headers.location.replace('/projects/', ''));
      const values = {
        view: 'list',
        gridSize: 'large',
        listSize: 'compact',
        sort: 'category',
        order: 'desc',
        pageSize: '50',
        extension: 'all',
        tag: 'all',
        scope: 'project',
        loadedScope: 'project',
        [option]: invalidValue,
        returnTo: `/projects/${id}/assets`,
        _csrf: csrfToken,
      };

      const response = await agent
        .post(`/projects/${id}/assets/defaults`)
        .set('Accept', 'application/json')
        .type('form')
        .send(values)
        .expect(422);

      expect(response.body.status).toBe('error');
      expect(response.body.errors[option]).toContain(invalidValue);
      expect(response.body.values[option]).toBe(invalidValue);
      expect(app.locals.pageDefaultsService.resolve('projectAssets', option)).toBe(
        option === 'gridSize' ? 'default' : (option === 'listSize' ? 'large' : 'all'),
      );
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.projectAssets[option].key)).toBeUndefined();
      expect(app.locals.projectPageDefaultRepository.getPageOptions(id, 'projectAssets')).toEqual({});
    });

    it('combines saved category and all four saved presentation defaults in one canonical redirect', async () => {
      const res = await createProject('Saved Assets Defaults Combined');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const [category] = assetCategoryRepo.listProjectCategories(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);
      saveAssetDefault('view', 'list');
      saveAssetDefault('sort', 'category');
      saveAssetDefault('order', 'desc');
      saveAssetDefault('pageSize', '50');

      const redirect = await agent.get(`/projects/${id}/assets`).expect(302);

      expect(redirect.headers.location)
        .toBe(`/projects/${id}/assets?category=${category.id}&sort=category&order=desc&pageSize=50&view=list`);
      expect(redirect.headers.location).not.toContain('category=' + category.id + '&category=');

      const canonical = await agent.get(redirect.headers.location).expect(200);
      expect(canonical.headers.location).toBeUndefined();
      expect(canonical.text).toContain('Assets — Saved Assets Defaults Combined');
    });

    it('preserves the existing bare behavior when saved presentation values are absent', async () => {
      const res = await createProject('Saved Assets Defaults Absent');
      const id = Number(res.headers.location.replace('/projects/', ''));

      const response = await agent.get(`/projects/${id}/assets`).expect(200);

      expect(response.headers.location).toBeUndefined();
      expect(response.text).toContain('Grid');
      expectCheckedAssetFilter(response.text, 'sort', 'filename');
      expectCheckedAssetFilter(response.text, 'order', 'asc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="25">');
    });

    it('does not redirect when saved values equal application fallbacks', async () => {
      saveAssetDefault('view', 'grid');
      saveAssetDefault('sort', 'filename');
      saveAssetDefault('order', 'asc');
      saveAssetDefault('pageSize', '25');

      const res = await createProject('Saved Assets Defaults Fallbacks');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const response = await agent.get(`/projects/${id}/assets`).expect(200);

      expect(response.headers.location).toBeUndefined();
      expectCheckedAssetFilter(response.text, 'sort', 'filename');
      expectCheckedAssetFilter(response.text, 'order', 'asc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="25">');
    });

    it('uses application fallbacks for invalid stored values without redirecting or rewriting storage', async () => {
      writeStoredAssetDefault('view', 'board');
      writeStoredAssetDefault('sort', 'published');
      writeStoredAssetDefault('order', 'forwards');
      writeStoredAssetDefault('pageSize', '20');

      const res = await createProject('Saved Assets Defaults Invalid Storage');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const response = await agent.get(`/projects/${id}/assets`).expect(200);

      expect(response.headers.location).toBeUndefined();
      expectCheckedAssetFilter(response.text, 'sort', 'filename');
      expectCheckedAssetFilter(response.text, 'order', 'asc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="25">');
      expect(response.text).toContain('href="/projects/' + id + '/assets?view=list"');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key).value)
        .toBe('board');
    });

    it('gives valid explicit values precedence and keeps omitted values on saved defaults', async () => {
      saveAssetDefault('view', 'list');
      saveAssetDefault('sort', 'category');
      saveAssetDefault('order', 'desc');
      saveAssetDefault('pageSize', '50');

      const res = await createProject('Saved Assets Defaults Explicit');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const response = await agent
        .get(`/projects/${id}/assets?view=grid&sort=filename&order=asc&pageSize=10&search=hero`)
        .expect(200);

      expect(response.headers.location).toBeUndefined();
      expect(response.text).toContain('value="hero"');
      expectCheckedAssetFilter(response.text, 'sort', 'filename');
      expectCheckedAssetFilter(response.text, 'order', 'asc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="10">');
      expect(response.text).not.toContain('<div class="asset-auto-rename-surface"');
    });

    it('uses saved presentation defaults when filters are explicit but presentation options are omitted', async () => {
      saveAssetDefault('view', 'list');
      saveAssetDefault('sort', 'category');
      saveAssetDefault('order', 'desc');
      saveAssetDefault('pageSize', '50');

      const res = await createProject('Saved Assets Defaults Omitted With Filters');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const response = await agent
        .get(`/projects/${id}/assets?search=hero&presence=present&usage=unused`)
        .expect(200);

      expect(response.headers.location).toBeUndefined();
      expect(response.text).toContain('value="hero"');
      expectCheckedAssetFilter(response.text, 'sort', 'category');
      expectCheckedAssetFilter(response.text, 'order', 'desc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="50">');
      expect(response.text).toContain('<input type="hidden" name="view" value="list">');
    });

    it('uses current route fallbacks for explicitly invalid values instead of saved values', async () => {
      saveAssetDefault('view', 'list');
      saveAssetDefault('sort', 'category');
      saveAssetDefault('order', 'desc');
      saveAssetDefault('pageSize', '50');

      const res = await createProject('Saved Assets Defaults Invalid Query');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const response = await agent
        .get(`/projects/${id}/assets?view=board&sort=published&order=forwards&pageSize=twenty`)
        .expect(200);

      expect(response.headers.location).toBeUndefined();
      expectCheckedAssetFilter(response.text, 'sort', 'filename');
      expectCheckedAssetFilter(response.text, 'order', 'asc');
      expect(response.text).toContain('<input type="hidden" name="pageSize" value="25">');
      expect(response.text).toContain('<input type="hidden" name="view" value="grid">');
      expect(response.text).not.toContain('sort=published');
      expect(response.text).not.toContain('order=forwards');
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

  // ─── Presence filter ──────────────────────────────────────────────

  it('defaults to all-assets view', async () => {
    const res = await createProject('Presence Default');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Presence Default');

    fs.writeFileSync(path.join(projectDir, 'present.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Remove the file to create a missing asset
    fs.rmSync(path.join(projectDir, 'present.png'));

    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    // Both present and missing assets are shown in "all" view
    expect(res2.text).toContain('present.png');
    expect(res2.text).toContain('Missing at last scan');
  });

  it('shows present-only assets', async () => {
    const res = await createProject('Present Filter');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Present Filter');

    fs.writeFileSync(path.join(projectDir, 'file1.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'file2.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Remove one file to make it missing
    fs.rmSync(path.join(projectDir, 'file1.png'));
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?presence=present`)
      .expect(200);
    expect(res2.text).toContain('file2.png');
    expect(res2.text).not.toContain('file1.png');
    expect(res2.text).toContain('Present at last scan');
    expect(res2.text).not.toContain('file1.png');
  });

  it('shows missing-only assets', async () => {
    const res = await createProject('Missing Filter');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Missing Filter');

    fs.writeFileSync(path.join(projectDir, 'kept.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'deleted.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    fs.rmSync(path.join(projectDir, 'deleted.png'));
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?presence=missing`)
      .expect(200);
    expect(res2.text).toContain('deleted.png');
    expect(res2.text).not.toContain('kept.png');
    expect(res2.text).toContain('Missing at last scan');
  });

  it('invalid presence filter falls back to all', async () => {
    const res = await createProject('Invalid Presence');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Invalid Presence');

    fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?presence=junk`)
      .expect(200);
    expect(res2.text).toContain('asset.png');
  });

  // ─── Usage filter ─────────────────────────────────────────────────

  it('shows used-only assets', async () => {
    const res = await createProject('Used Filter');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Used Filter');

    fs.writeFileSync(path.join(projectDir, 'used.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'unused.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Create a release and link an asset
    const assets = assetRepo.findByProjectId(id);
    const usedAsset = assets.find((a) => a.filename === 'used.png');
    const unusedAsset = assets.find((a) => a.filename === 'unused.png');

    const releaseId = await createReleaseUsingAsset(id, usedAsset.id, 'Used Asset Release', 'tbd');

    const res2 = await agent
      .get(`/projects/${id}/assets?usage=used`)
      .expect(200);
    expect(res2.text).toContain('used.png');
    expect(res2.text).not.toContain('unused.png');
    expect(res2.text).toContain('Used Asset Release');
    expect(res2.text).toContain('Attachment');
  });

  it('shows unused-only assets', async () => {
    const res = await createProject('Unused Filter');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Unused Filter');

    fs.writeFileSync(path.join(projectDir, 'used.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'unused.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assets = assetRepo.findByProjectId(id);
    const usedAsset = assets.find((a) => a.filename === 'used.png');

    const releaseId = await createReleaseUsingAsset(id, usedAsset.id, 'Link Release', 'tbd');

    const res2 = await agent
      .get(`/projects/${id}/assets?usage=unused`)
      .expect(200);
    expect(res2.text).toContain('unused.png');
    expect(res2.text).not.toContain('>used.png<');
    expect(res2.text).toContain('Not used by a release');
  });

  it('invalid usage filter falls back to all', async () => {
    const res = await createProject('Invalid Usage');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Invalid Usage');

    fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?usage=badrubbish`)
      .expect(200);
    expect(res2.text).toContain('asset.png');
  });

  // ─── Combined filters ─────────────────────────────────────────────

  it('combines presence and usage filters', async () => {
    const res = await createProject('Combined Filters');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Combined Filters');

    fs.writeFileSync(path.join(projectDir, 'present-used.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'present-unused.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'missing-used.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'missing-unused.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Link one present asset to a release
    let assets = assetRepo.findByProjectId(id);
    const presentUsed = assets.find((a) => a.filename === 'present-used.png');

    const releaseId = await createReleaseUsingAsset(id, presentUsed.id, 'Combine Release', 'tbd');

    // Remove missing-used from disk so it becomes missing
    fs.rmSync(path.join(projectDir, 'missing-used.png'));
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Query: present + used
    const res2 = await agent
      .get(`/projects/${id}/assets?presence=present&usage=used`)
      .expect(200);
    expect(res2.text).toContain('present-used.png');
    expect(res2.text).not.toContain('present-unused.png');
    expect(res2.text).not.toContain('missing-used.png');
    expect(res2.text).not.toContain('missing-unused.png');
  });

  // ─── Release usage details ────────────────────────────────────────

  it('shows release usage count per asset', async () => {
    const res = await createProject('Usage Count');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Usage Count');

    fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assets = assetRepo.findByProjectId(id);
    const asset = assets[0];

    // Create two releases and link the same asset to both
    for (const title of ['First Release', 'Second Release']) {
      const relRes = await agent
        .post('/releases')
        .send(`projectId=${id}`)
        .send(`title=${encodeURIComponent(title)}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseId = relRes.headers.location.replace('/releases/', '');

      await agent
        .post(`/releases/${releaseId}/assets`)
        .send(`selectedAssetIds=${asset.id}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
    }

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('aria-label="Used in 2 releases"');
  });

  it('shows release titles for used assets', async () => {
    const res = await createProject('Release Titles');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Release Titles');

    fs.writeFileSync(path.join(projectDir, 'shared.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assets = assetRepo.findByProjectId(id);
    const asset = assets[0];

    const releaseId = await createReleaseUsingAsset(id, asset.id, 'Status Check Release', 'planned');

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('Status Check Release');
    // Check the release detail link exists (not the asset-selection page)
    expect(res2.text).toContain(`/releases/${releaseId}"`);
    expect(res2.text).not.toContain(`/releases/${releaseId}/assets`);
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
    expect(missingCard).toContain('asset-indicator--missing');
    expect(missingCard).toContain('aria-label="Missing at last scan"');
    expect(missingCard).not.toContain('asset-indicator--present');
  });

  // ─── Pagination ──────────────────────────────────────────────────

  it('renders pagination links that preserve filter state', async () => {
    const res = await createProject('Pagination Filters');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Pagination Filters');
    if (!projectDir) throw new Error('projectDir not found for Pagination Filters');

    // Create enough assets to guarantee pagination (pageSize=25, need 26+)
    for (let i = 0; i < 35; i++) {
      fs.writeFileSync(path.join(projectDir, `file${String(i).padStart(2, '0')}.png`), `content${i}`);
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Request page 1 with presence filter
    const res2 = await agent
      .get(`/projects/${id}/assets?presence=present&page=1`)
      .expect(200);

    // Extract the "Next" link
    const nextMatch = res2.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    // Unescape HTML entities (&amp; → &) before URL parsing
    const href = nextMatch[1].replace(/&amp;/g, '&');
    const nextUrl = new URL(href, 'http://localhost');
    expect(nextUrl.pathname).toBe(`/projects/${id}/assets`);
    expect(nextUrl.searchParams.get('presence')).toBe('present');
    expect(nextUrl.searchParams.get('page')).toBe('2');
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

    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(projectDir, `File & ${String(i).padStart(2, '0')}.png`), `content${i}`);
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const encodedSearch = encodeURIComponent('File &');
    const res2 = await agent
      .get(`/projects/${id}/assets?search=${encodedSearch}&extension=.PNG&presence=present&usage=unused&page=1&pageSize=10&view=list&unknown=strip-me`)
      .expect(200);

    const nextMatch = res2.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const href = nextMatch[1].replace(/&amp;/g, '&');
    expect(href).toBe(`/projects/${id}/assets?search=File+%26&extension=png&presence=present&usage=unused&page=2&pageSize=10&view=list`);

    const nextUrl = new URL(href, 'http://localhost');
    expect(Array.from(nextUrl.searchParams.keys())).toEqual([
      'search', 'extension', 'presence', 'usage', 'page', 'pageSize', 'view',
    ]);
    expect(nextUrl.searchParams.get('search')).toBe('File &');
    expect(nextUrl.searchParams.get('extension')).toBe('png');
    expect(nextUrl.searchParams.get('page')).toBe('2');
    expect(nextUrl.searchParams.get('view')).toBe('list');
    expect(nextUrl.searchParams.has('unknown')).toBe(false);
    expect(nextUrl.searchParams.has('scan_result')).toBe(false);
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

  it('malformed page falls back to page 1', async () => {
    const res = await createProject('Malformed Page');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Malformed Page');
    if (!projectDir) throw new Error('projectDir not found for Malformed Page');

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(projectDir, `file${i}.png`), 'png');
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?page=garbage`)
      .expect(200);
    // page falls back to 1; with 5 assets at 25/page pageCount=1 so no nav renders.
    expectNoAssetResultsCount(res2.text);
    expect(res2.text).toContain('file0.png');
  });

  it('negative page falls back to page 1', async () => {
    const res = await createProject('Negative Page');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Negative Page');
    if (!projectDir) throw new Error('projectDir not found for Negative Page');

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(projectDir, `file${i}.png`), 'png');
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?page=-5`)
      .expect(200);
    // With 5 assets at 25/page, pageCount=1 so no pagination nav renders.
    // Verify the request succeeded (page clamped to 1) and all 5 assets appear.
    expectNoAssetResultsCount(res2.text);
    expect(res2.text).toContain('file0.png');
  });

  it('out-of-range page falls back to last valid page', async () => {
    const res = await createProject('Out of Range Page');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Out of Range Page');
    if (!projectDir) throw new Error('projectDir not found for Out of Range Page');

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(projectDir, `file${i}.png`), 'png');
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Page 99 is out of range for 5 assets at 25/page; page is clamped to 1.
    const res2 = await agent
      .get(`/projects/${id}/assets?page=99`)
      .expect(200);
    expectNoAssetResultsCount(res2.text);
    expect(res2.text).toContain('file0.png');
  });

  it('malformed pageSize falls back to default 25', async () => {
    const res = await createProject('Malformed PageSize');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Malformed PageSize');
    if (!projectDir) throw new Error('projectDir not found for Malformed PageSize');

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(projectDir, `file${i}.png`), 'png');
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?pageSize=junk`)
      .expect(200);
    // pageSize clamps to default 25; 5 assets render without pagination nav.
    expectNoAssetResultsCount(res2.text);
    expect(res2.text).toContain('file0.png');
  });

  it('out-of-range pageSize is capped at 100', async () => {
    const res = await createProject('Large PageSize');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Large PageSize');
    if (!projectDir) throw new Error('projectDir not found for Large PageSize');

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(projectDir, `file${i}.png`), 'png');
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?pageSize=500`)
      .expect(200);
    // pageSize clamps to 100; 5 assets render without error.
    expectNoAssetResultsCount(res2.text);
    expect(res2.text).toContain('file0.png');
  });

  // ─── Slideshow sequence ────────────────────────────────────────────────

  it('project assets: slideshow sequence includes all previewable assets regardless of visible page', async () => {
    const res = await createProject('Slideshow Beyond Page');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Beyond Page');
    const png = await makePng();

    for (let i = 1; i <= 4; i++) {
      writeIndexedAsset(id, projectDir, `img${i}.png`, png);
    }

    const page1 = await agent.get(`/projects/${id}/assets?page=1&pageSize=2`).expect(200);
    const seq1 = extractSlideshowSequence(page1.text);

    expect(page1.text).toMatch(/data-asset-id="\d+"/);
    const visibleIds = [...page1.text.matchAll(/data-asset-id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(visibleIds).toHaveLength(2);
    expect(seq1.length).toBe(4);

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

    writeIndexedAsset(id, projectDir, 'alpha.png', png);
    writeIndexedAsset(id, projectDir, 'bravo.jpg', Buffer.from('notrealpng'), { extension: 'jpg', mimeType: 'image/jpeg' });
    writeIndexedAsset(id, projectDir, 'charlie.png', png);

    const filteredRes = await agent.get(`/projects/${id}/assets?extension=png`).expect(200);
    const seq = extractSlideshowSequence(filteredRes.text);
    const filenames = seq.map((e) => e.filename);
    expect(filenames.every((f) => f.endsWith('.png'))).toBe(true);
    expect(filenames).not.toContain('bravo.jpg');
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

  it('project assets: slideshow sequence uses preview derivative URLs, not originals or thumbnails', async () => {
    const res = await createProject('Slideshow Derivative URL');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Derivative URL');
    const png = await makePng();

    writeIndexedAsset(id, projectDir, 'img.png', png);

    const pageRes = await agent.get(`/projects/${id}/assets`).expect(200);
    const seq = extractSlideshowSequence(pageRes.text);
    expect(seq.length).toBeGreaterThan(0);
    for (const entry of seq) {
      expect(entry.previewUrl).toContain('/preview?');
      expect(entry.previewUrl).not.toContain('/original');
      expect(entry.previewUrl).not.toContain('/thumbnail?');
      expect(entry.originalUrl).toContain('/original');
      expect(entry.thumbnailUrl).toBeUndefined();
    }
  });

  it('project assets: originalUrl is exposed only for supported image assets', async () => {
    const res = await createProject('Slideshow Original Eligibility');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Original Eligibility');
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
    expect(kritaEntry).toBeDefined();
    expect(kritaEntry.originalUrl).toBeUndefined();
    expect(kritaEntry.previewUrl).toContain('/preview?');

    const globalRes = await agent.get('/assets?view=list').expect(200);
    const globalImageEntry = extractSlideshowSequence(globalRes.text).find((entry) => entry.id === image.id);
    expect(globalImageEntry).toMatchObject({
      previewUrl: expect.stringContaining('/preview?'),
      originalUrl: `/projects/${id}/assets/${image.id}/original`,
    });
  });

  it('project assets: slideshow sequence excludes missing and unsupported assets', async () => {
    const res = await createProject('Slideshow Exclude Non-Displayable');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Slideshow Exclude Non-Displayable');
    const png = await makePng();

    const good = writeIndexedAsset(id, projectDir, 'good.png', png);
    writeIndexedAsset(id, projectDir, 'bad.bin', Buffer.from('binary'), { extension: 'bin', mimeType: 'application/octet-stream' });
    assetRepo.upsert(id, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: '2026-01-01 00:00:00',
    });
    db.prepare('UPDATE assets SET is_present = 0 WHERE project_id = ? AND filename = ?').run(id, 'missing.png');

    const pageRes = await agent.get(`/projects/${id}/assets?presence=all`).expect(200);
    const seq = extractSlideshowSequence(pageRes.text);
    const ids = seq.map((e) => e.id);
    expect(ids).toContain(good.id);
    expect(seq.every((e) => e.previewUrl && e.previewUrl.includes('/preview?'))).toBe(true);
    expect(ids).not.toContain(expect.stringContaining('missing'));
    for (const entry of seq) {
      expect(entry.previewUrl).toBeTruthy();
    }
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

  it('shows empty state for project with no assets, with no separate no-op Scan Now action', async () => {
    const res = await createProject('No Assets Project');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('No assets found');
    // The empty-state partial's action div must not exist for the
    // no-assets case — the only "Scan Now" control on the page is the
    // POST form already rendered in the heading.
    expect(res2.text).not.toMatch(/<div class="empty-state-actions">/);
  });

  // ─── Defect fix: no no-op "Scan Now" GET anchor in the empty state ─────

  describe('Scan Now is never a no-op GET link', () => {
    // Project titles deliberately avoid the substring "Scan Now" — it
    // renders verbatim in the page <h1>, which would otherwise pollute the
    // "exactly one Scan Now" / "no Scan Now" assertions below.
    it('an empty browser contains no "Scan Now" anchor targeting the GET browser route', async () => {
      const res = await createProject('Scan Ctrl No Anchor');
      const id = res.headers.location.replace('/projects/', '');

      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res2.text).not.toMatch(/<a[^>]*href="\/projects\/\d+\/assets"[^>]*>\s*Scan Now\s*<\/a>/);
    });

    it('every rendered "Scan Now" control is inside a POST form targeting /projects/:id/scan with CSRF and normalized context', async () => {
      const res = await createProject('Scan Ctrl Form Shape');
      const id = res.headers.location.replace('/projects/', '');

      const res2 = await agent.get(`/projects/${id}/assets?category=all&search=hero&presence=present&sort=size&order=desc&pageSize=50`).expect(200);
      const html = res2.text;

      // Exactly one "Scan Now" label on the page.
      const scanNowCount = (html.match(/Scan Now/g) || []).length;
      expect(scanNowCount).toBe(1);

      const formMatch = html.match(/<form method="post" action="\/projects\/\d+\/scan"[^>]*>[\s\S]*?<\/form>/);
      expect(formMatch).not.toBeNull();
      const form = formMatch[0];
      expect(form).toContain('Scan Now');
      expect(form).toContain('<input type="hidden" name="_csrf" value="');
      expect(form).toContain('<input type="hidden" name="search" value="hero">');
      expect(form).toContain('<input type="hidden" name="presence" value="present">');
      expect(form).toContain('<input type="hidden" name="sort" value="size">');
      expect(form).toContain('<input type="hidden" name="order" value="desc">');
      expect(form).toContain('<input type="hidden" name="pageSize" value="50">');
    });

    it('archived projects render no Scan Now control at all', async () => {
      const res = await createProject('Scan Ctrl Archived');
      const id = Number(res.headers.location.replace('/projects/', ''));
      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res2.text).not.toContain('Scan Now');
    });

    it('the scan route still redirects and shows Added/Updated/Missing/Total result notices unchanged', async () => {
      const res = await createProject('Scan Ctrl Behavior Unchanged');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Scan Ctrl Behavior Unchanged');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');

      const res2 = await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const res3 = await agent.get(res2.headers.location).expect(200);
      expect(res3.text).toContain('Added: 1');
      expect(res3.text).toContain('Updated: 0');
      expect(res3.text).toContain('Missing: 0');
      expect(res3.text).toContain('1 total assets');
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

  // ─── Manual scan still works ────────────────────────────────────

  it('manual scan route still works after route change', async () => {
    const res = await createProject('Scan Still Works');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Scan Still Works');

    fs.writeFileSync(path.join(projectDir, 'newfile.png'), 'png');

    const scanRes = await agent
      .post(`/projects/${id}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    expect(scanRes.headers.location).toContain(`/projects/${id}/assets`);
  });

  it('scan shows result on redirect', async () => {
    const res = await createProject('Scan Result');
    const id = res.headers.location.replace('/projects/', '');

    // Scan via the redirect-following approach
    const scanRes = await agent
      .post(`/projects/${id}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .redirects(1)
      .expect(200);

    expect(scanRes.text).toContain('Scan complete');
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

  it('filters rendered assets by case-insensitive search and leading-dot extension', async () => {
    const res = await createProject('Search Extension Filter');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Search Extension Filter');

    fs.writeFileSync(path.join(projectDir, 'Hero-Final.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'hero-source.kra'), 'kra');
    fs.writeFileSync(path.join(projectDir, 'other.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?search=hero&extension=.PNG`)
      .expect(200);

    expect(res2.text).toContain('Hero-Final.png');
    expect(res2.text).not.toContain('hero-source.kra');
    expect(res2.text).not.toContain('other.png');
    expect(res2.text).toContain('value="hero"');
    const extensionFilter = assetExtensionFilterHtml(res2.text);
    expect(extensionFilter).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(extensionFilter).toContain('asset-filter-multiselect--sized');
    expect(extensionFilter).toContain('class="asset-filter-multiselect-summary-current">.png</span>');
    expect(extensionFilter).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
    expect(extensionFilter).toMatch(/<label for="[^"]+">\s*<input[^>]+name="extension"[^>]+value="png"[^>]*checked/);
    expect(extensionFilter).toContain('>All extensions</span>');
    expect(extensionFilter).toContain('>.png</span>');
    expect(extensionFilter).toContain('>.kra</span>');
    expect(extensionFilter).not.toMatch(/<select[^>]+(?:id="extension"|name="extension")/);
  });

  it('keeps extension choices stable when another filter returns no rows', async () => {
    const res = await createProject('Stable Extension Menu');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Stable Extension Menu');

    fs.writeFileSync(path.join(projectDir, 'image.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'source.kra'), 'kra');
    fs.writeFileSync(path.join(projectDir, 'photo.jpg'), 'jpg');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent
      .get(`/projects/${id}/assets?search=no-match&usage=used`)
      .expect(200);

    expect(res2.text).toContain('No assets match the current filters');
    expect(res2.text).toContain('value="jpg"');
    expect(res2.text).toContain('value="kra"');
    expect(res2.text).toContain('value="png"');
  });

  // ─── Filter form interactions ───────────────────────────────────

  it('filter form shows correct selected state for presence', async () => {
    const res = await createProject('Filter State');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent
      .get(`/projects/${id}/assets?presence=missing`)
      .expect(200);

    const filter = assetFilterHtml(res2.text, 'asset-presence-filter-options');
    expect(filter).toContain('aria-label="Show filter: Missing at last scan"');
    expectCheckedAssetFilter(filter, 'presence', 'missing');
    expect(filter).not.toMatch(/name="presence"[^>]*value="present"[^>]*checked/);
  });

  it('filter form shows correct selected state for usage', async () => {
    const res = await createProject('Usage Filter State');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent
      .get(`/projects/${id}/assets?usage=unused`)
      .expect(200);

    const filter = assetFilterHtml(res2.text, 'asset-usage-filter-options');
    expect(filter).toContain('aria-label="Usage filter: Not used by a release"');
    expectCheckedAssetFilter(filter, 'usage', 'unused');
    expect(filter).not.toMatch(/name="usage"[^>]*value="used"[^>]*checked/);
  });

  it('reset link points to assets page without filters', async () => {
    const res = await createProject('Reset Link');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent
      .get(`/projects/${id}/assets?presence=missing&usage=used`)
      .expect(200);

    expect(res2.text).toContain('href="/projects/' + id + '/assets?category=all"');
  });

  // ─── PageSize form preserves filters ───────────────────────────

  it('pageSize select preserves active filters and pagination link preserves pageSize', async () => {
    const res = await createProject('PageSize Preserve');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('PageSize Preserve');
    if (!projectDir) throw new Error('projectDir not found for PageSize Preserve');

    // Create enough assets to render pagination controls (need >25 with filter applied)
    for (let i = 0; i < 35; i++) {
      fs.writeFileSync(path.join(projectDir, `file${String(i).padStart(2, '0')}.png`), `c${i}`);
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Use pageSize=10 and presence=present to make pagination visible
    const res2 = await agent
      .get(`/projects/${id}/assets?presence=present&pageSize=10`)
      .expect(200);

    // The page size select shows the correct selected state
    expect(res2.text).toContain('value="10" selected');
    const pageSizeForm = res2.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0] || '';
    expect(pageSizeForm).not.toContain('value="25" selected');
    // Presence filter form also reflects the active filter
    expectCheckedAssetFilter(res2.text, 'presence', 'present');

    // A "Next" pagination link exists and preserves both pageSize and presence
    const nextMatch = res2.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const href = nextMatch[1].replace(/&amp;/g, '&');
    const nextUrl = new URL(href, 'http://localhost');
    expect(nextUrl.pathname).toBe(`/projects/${id}/assets`);
    expect(nextUrl.searchParams.get('presence')).toBe('present');
    expect(nextUrl.searchParams.get('pageSize')).toBe('10');
    expect(nextUrl.searchParams.get('page')).toBe('2');

    // The page size form includes hidden inputs to preserve active filters
    expect(res2.text).toContain('<input type="hidden" name="presence" value="present">');
  });

  it('pageSize form has a no-JavaScript GET submit that preserves normalized filters', async () => {
    const res = await createProject('No JS Page Size');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('No JS Page Size');
    if (!projectDir) throw new Error('projectDir not found for No JS Page Size');

    for (let i = 0; i < 35; i++) {
      fs.writeFileSync(path.join(projectDir, `Filtered & ${String(i).padStart(2, '0')}.png`), `c${i}`);
    }
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const initial = await agent
      .get(`/projects/${id}/assets?search=${encodeURIComponent('Filtered &')}&extension=.PNG&presence=present&usage=unused&page=2&pageSize=10&junk=drop`)
      .expect(200);

    const formMatch = initial.text.match(/<form class="page-size-form" method="get" action="\/projects\/\d+\/assets">[\s\S]*?<\/form>/);
    expect(formMatch).not.toBeNull();
    const form = formMatch[0];
    // CSP hardening removed the inline onchange handler — the local
    // creatorcrate.js script wires up autosubmit via data-autosubmit,
    // while the server-rendered "Apply" button keeps the form fully
    // functional as a plain GET submit with JavaScript disabled.
    expect(form).toContain('<legend>Assets per page</legend>');
    expect(form).toContain('<select id="pageSize" name="pageSize" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Assets per page" data-autosubmit>');
    expect(form).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(form).not.toContain('onchange=');
    expect(form).toContain('<button class="button button-small" type="submit">Apply</button>');
    expect(initial.text).toContain('<script type="module" src="/creatorcrate.js"></script>');
    expect(form).not.toContain('name="view"');
    expect(form).toContain('<input type="hidden" name="search" value="Filtered &amp;">');
    expect(form).toContain('<input type="hidden" name="extension" value="png">');
    expect(form).toContain('<input type="hidden" name="presence" value="present">');
    expect(form).toContain('<input type="hidden" name="usage" value="unused">');
    expect(form).not.toContain('name="page"');
    expect(form).not.toContain('junk');

    const submittedHref = `/projects/${id}/assets?search=Filtered+%26&extension=png&presence=present&usage=unused&pageSize=25`;
    const submitted = await agent.get(submittedHref).expect(200);
    expect(submitted.text).toContain('value="25" selected');
    expectNoAssetResultsCount(submitted.text);

    const submittedUrl = new URL(submittedHref, 'http://localhost');
    expect(submittedUrl.pathname).toBe(`/projects/${id}/assets`);
    expect(Array.from(submittedUrl.searchParams.keys())).toEqual([
      'search', 'extension', 'presence', 'usage', 'pageSize',
    ]);
    expect(submittedUrl.searchParams.get('search')).toBe('Filtered &');
    expect(submittedUrl.searchParams.get('extension')).toBe('png');
    expect(submittedUrl.searchParams.get('pageSize')).toBe('25');
    expect(submittedUrl.searchParams.has('page')).toBe(false);
    expect(submittedUrl.searchParams.has('view')).toBe(false);
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
    expect(defaultsDialog.indexOf('<footer class="app-dialog-footer">')).toBeGreaterThan(statusIndex);
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
        options: [['10', '10 assets'], ['25', '25 assets'], ['50', '50 assets'], ['100', '100 assets']],
      },
      {
        name: 'extension',
        label: 'Extension',
        id: 'projectAssets-default-extension',
        selected: 'all',
        options: [['all', 'All extensions']],
      },
      {
        name: 'tag',
        label: 'Tag',
        id: 'projectAssets-default-tag',
        selected: 'all',
        options: [['all', 'All tags']],
      },
    ];
    for (const field of defaultFields) {
      expect(defaultsGrid).toMatch(new RegExp(`<select[^>]*name="${field.name}"[^>]*data-cc-dropdown-native-select`));
      expect(defaultsGrid).toContain(`data-dialog-field="${field.name}"`);
      expect(defaultsGrid).toContain(`<legend>${field.label}</legend>`);
      const nativeSelect = defaultsGrid.match(new RegExp(`<select id="${field.id}"[\\s\\S]*?<\\/select>`))?.[0] || '';
      expect(nativeSelect).not.toBe('');
      for (const [value, label] of field.options) {
        expect(nativeSelect).toContain(`<option value="${value}"${value === field.selected ? ' selected' : ''}>${label}</option>`);
      }
      expect(defaultsGrid).toMatch(new RegExp(
        `id="${field.id}-dropdown"[^>]*data-cc-dropdown data-cc-dropdown-mode="single"`,
      ));
      expect(defaultsGrid).toMatch(new RegExp(
        `<input[^>]*type="radio" value="${field.selected}"[^>]*checked`,
      ));
      expect(defaultsGrid).not.toMatch(new RegExp(`<input[^>]*name="${field.name}"`));
      expect((defaultsGrid.match(new RegExp(`name="${field.name}"`, 'g')) || [])).toHaveLength(1);
    }
    for (let index = 1; index < defaultFields.length; index += 1) {
      expect(defaultsGrid.indexOf(`data-dialog-field="${defaultFields[index - 1].name}"`))
        .toBeLessThan(defaultsGrid.indexOf(`data-dialog-field="${defaultFields[index].name}"`));
    }
    expect((defaultsGrid.match(/data-cc-dropdown data-cc-dropdown-mode="single"/g) || [])).toHaveLength(8);
    const defaultsFooter = defaultsDialog.match(/<footer class="app-dialog-footer">[\s\S]*?<\/footer>/)?.[0] || '';
    expect((defaultsFooter.match(/<button\b[^>]*type="submit"/g) || [])).toHaveLength(1);
    expect(defaultsFooter).toContain('data-dialog-submit');
    expect(defaultsFooter).toContain('>Save defaults</button>');
    expect(defaultsFooter).not.toContain('>Cancel</button>');

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
    expect(invalidListSize).not.toContain('data-dialog-submitted-value');
    expect(invalidListSize).not.toContain('value="default"');

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

    const resetAnchor = response.text.match(/<a\b[^>]*data-project-assets-reset[^>]*>/)?.[0] || '';
    const resetHref = resetAnchor.match(/\bhref="([^"]+)"/)?.[1];
    expect(resetHref).toBeDefined();
    const resetUrl = new URL(decodeHtmlHref(resetHref), 'http://localhost');
    expect(resetUrl.searchParams.get('category')).toBe('all');
    expect(resetUrl.searchParams.get('sort')).toBe('filename');
    expect(resetUrl.searchParams.get('order')).toBe('asc');
    expect(resetUrl.searchParams.get('pageSize')).toBe('25');
    expect(resetUrl.searchParams.get('view')).toBe('list');
    expect(resetUrl.searchParams.has('search')).toBe(false);
    expect(resetUrl.searchParams.has('extension')).toBe(false);
    expect(resetUrl.searchParams.has('presence')).toBe(false);
    expect(resetUrl.searchParams.has('usage')).toBe(false);
  });

  // ─── Last seen and missing-since dates (viewer page) ───────────

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

  it('renders a successful previewable asset viewer with exact preview, back, and original links', async () => {
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
    expect(res2.text).toContain('<title>CreatorCrate — Assets — Viewer Previewable — hero.png</title>');
    expect(res2.text).toContain('class="page-heading"');
    expect(res2.text).toContain('<h1 class="app-section-title">Assets — Viewer Previewable — hero.png</h1>');
    expectAnchorHref(res2.text, 'asset-viewer-project', `/projects/${id}`);
    expectAnchorHref(res2.text, 'asset-viewer-back', `/projects/${id}/assets`);
    expect(res2.text).toContain(
      `<img class="asset-preview-image" src="/projects/${id}/assets/${asset.id}/preview?v=${revision}" alt="Preview of hero.png" data-preview-image>`
    );
    const originalHref = `/projects/${id}/assets/${asset.id}/original`;
    expectNoAnchor(res2.text, 'asset-viewer-original');
    expectAnchorHref(res2.text, 'asset-preview-link', originalHref);
    const previewLink = anchorMatch(res2.text, 'asset-preview-link');
    expect(previewLink).not.toBeNull();
    expect(previewLink[2]).toContain('class="asset-preview-image"');
    expect(previewLink[2]).toContain('data-preview-image');
    expect(previewLink[2]).not.toContain('asset-preview-fallback');
    expect(res2.text).toMatch(
      /<a\b[^>]*class="[^"]*\basset-preview-link\b[^"]*"[^>]*aria-label="View original hero\.png"/
    );
    expect(res2.text).toContain('<dt>Filename</dt>\n        <dd><code>hero.png</code></dd>');
    expect(res2.text).toContain(`<dt>Location</dt>\n        <dd>/${slugify('Viewer Previewable', { lowercase: true })}/</dd>`);
    expect(res2.text).toContain('<code>png</code>');
    expect(res2.text).toContain('<code>image/png</code>');
    expect(res2.text).toContain(`${png.length} bytes`);
    expect(res2.text).toContain('2026-07-15 10:20:30');
    expect(res2.text).toContain('Present at last scan');
    expect(res2.text).toContain('Used by 1 release');
    expect(res2.text).toContain('Hero Release');
    expect(res2.text).toContain(`<a href="/releases/${releaseId}">Hero Release</a>`);
    expect(res2.text).toContain('<span class="release-role">Attachment</span>');
    expect(res2.text).not.toContain('()');
  });

  // ─── Defect fix: browser row links carry normalized/clamped context ────

  it('a browser row viewer link carries the full normalized context, strips unknown fields, and the viewer preserves it across Back/Previous/Next', async () => {
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
    expect(anchorText(res.text, 'asset-preview-nav--previous')).toBe('');
    expect(anchorText(res.text, 'asset-preview-nav--next')).toBe('');
    expect(res.text).toMatch(/class="asset-preview-nav asset-preview-nav--previous"[^>]*rel="prev"[^>]*aria-label="Previous asset"/);
    expect(res.text).toMatch(/class="asset-preview-nav asset-preview-nav--next"[^>]*rel="next"[^>]*aria-label="Next asset"/);
    expect(anchorMatch(res.text, 'asset-preview-nav--previous')?.[2]).toMatch(/<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
    expect(anchorMatch(res.text, 'asset-preview-nav--next')?.[2]).toMatch(/<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
    const headingActions = res.text.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    expect(headingActions).not.toContain('asset-preview-nav--previous');
    expect(headingActions).not.toContain('asset-preview-nav--next');
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
    expect(res2.text).toContain('class="asset-preview-viewer"');
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
    expect(res2.text).toContain('Project: Viewer Archived');
    expect(res2.text).toContain('<h1 class="app-section-title">Assets — Viewer Archived — archived.png</h1>');
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

    expect(res2.text).toContain('<dt>Filename</dt>\n        <dd><code>blob.bin</code></dd>');
    expect(res2.text).toContain(`<dt>Location</dt>\n        <dd>/${slugify('Viewer No Leaks', { lowercase: true })}/</dd>`);
    expect(res2.text).not.toContain(secret);
    expect(res2.text).not.toContain(tmpDir);
    expect(res2.text).not.toContain(projectsRoot);
    expect(res2.text).not.toMatch(/[A-Z]:\\/);
    expect(res2.text).not.toContain('/Users/');
    expect(res2.text).not.toContain('/home/');
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

    it('renders Open locally when project directory and relative path exist', async () => {
      const res = await createProject('Viewer Open Locally');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Viewer Open Locally');
      if (!projectDir) throw new Error('projectDir not found for Viewer Open Locally');
      const asset = writeIndexedAsset(id, projectDir, 'gallery/hero.png', await makePng());
      configureWindowsRoot();

      const res2 = await agent
        .get(`/projects/${id}/assets/${asset.id}`)
        .expect(200);

      expect(anchorText(res2.text, 'asset-viewer-open-locally')).toBe('');
      expect(anchorMatch(res2.text, 'asset-viewer-open-locally')?.[0]).toMatch(
        /aria-label="Open locally"[^>]*data-tooltip="Open locally"/
      );
      expect(anchorMatch(res2.text, 'asset-viewer-open-locally')?.[2]).toMatch(
        /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/
      );
      const actionToolbar = res2.text.match(/<nav class="project-detail-action-toolbar asset-viewer-action-toolbar" aria-label="Asset actions">([\s\S]*?)<\/nav>/)?.[1] || '';
      const headingActions = res2.text.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
      expect(actionToolbar).toContain('asset-viewer-open-locally');
      expect(headingActions).not.toContain('asset-viewer-open-locally');
    });

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
    });

    it('does not expose the container projects root in the viewer action', async () => {
      const res = await createProject('Viewer Open Locally No Root Leak');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Viewer Open Locally No Root Leak');
      if (!projectDir) throw new Error('projectDir not found for Viewer Open Locally No Root Leak');
      const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());
      configureWindowsRoot();

      const res2 = await agent
        .get(`/projects/${id}/assets/${asset.id}`)
        .expect(200);

      const href = anchorHref(res2.text, 'asset-viewer-open-locally');
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
      expect(res2.text).not.toContain('creatorcrate-open://');
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
      expect(res2.text).not.toContain('creatorcrate-open://');
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
      expect(res2.text).not.toContain('creatorcrate-open://');
    });
  });

  // ─── Project Assets display actions ────────────────────────────────
  //
  // The display controls render project-level icon actions immediately before
  // Project Assets defaults. Open locally keeps the category-aware URI from
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

    it('renders active-project edit and open-locally actions immediately before Project Assets defaults', async () => {
      const { id, projectDir } = await createAssetsProject('Assets Open Locally');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();

      const res = await agent
        .get(`/projects/${id}/assets`)
        .expect(200);

      const actions = projectAssetsDisplayActions(res.text);
      const headingActions = extractPageHeadingActions(res.text);
      const editIndex = actions.indexOf('aria-label="Edit project"');
      const openLocallyIndex = actions.indexOf('aria-label="Open locally"');
      const defaultsIndex = actions.indexOf('aria-label="Project Assets defaults"');

      expect(actions).toContain(`href="/projects/${id}/edit"`);
      expect(actions).toContain('creatorcrate-open://');
      expect(actions).toContain(
        `href="creatorcrate-open://open?v=2&amp;path=${encodeURIComponent(`D:\\example\\${row.project_dir}`)}&amp;select=0"`
      );
      expect(editIndex).toBeGreaterThanOrEqual(0);
      expect(openLocallyIndex).toBeGreaterThan(editIndex);
      expect(defaultsIndex).toBeGreaterThan(openLocallyIndex);
      expect(headingActions).not.toContain('Edit project');
      expect(headingActions).not.toContain('Open locally');
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
    expect(browser.text).toContain('Assets — Viewer Route Precedence');
  });

  it('meets the server-rendered accessibility baseline for the viewer', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Accessibility');

    const res = await agent
      .get(`/projects/${id}/assets/${assets.bravo.id}?pageSize=1`)
      .expect(200);

    expect((res.text.match(/<h1\b/g) || []).length).toBe(1);
    expect(res.text).toContain('alt="Preview of bravo.png"');
    expect(anchorText(res.text, 'asset-preview-nav--previous')).toBe('');
    expect(anchorText(res.text, 'asset-preview-nav--next')).toBe('');
    expect(res.text).toContain('Present at last scan');
    expect(res.text).toContain('<dl class="detail-list asset-metadata asset-metadata--summary">');
    for (const label of [
      'Filename',
      'Location',
      'Category',
      'Extension',
      'Recorded MIME type',
      'Size',
      'Recorded modified time',
      'Presence',
      'Last seen',
      'Missing since'
    ]) {
      expect(res.text).toContain(`<dt>${label}</dt>`);
    }
    expect(anchorText(res.text, 'asset-viewer-back')).toBe('Back to Assets');
    // The shell <main> carries tabindex="-1" so the skip link can move focus
    // into the content region (WCAG technique G1). The viewer baseline instead
    // guarantees its own navigation links never reorder focus with tabindex.
    expect(res.text).not.toMatch(/<a\b[^>]*\btabindex=/);

    const pageHeading = res.text.match(/<header class="page-heading">([\s\S]*?)<\/header>/)?.[1] || '';
    const headingActions = pageHeading.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    expect(headingActions).not.toBe('');
    expect(anchorText(pageHeading, 'asset-viewer-project')).toBe('Project: Viewer Accessibility');
    expect(anchorText(headingActions, 'asset-viewer-back')).toBe('Back to Assets');
    expect(anchorHref(pageHeading, 'asset-viewer-project')).toBe(`/projects/${id}`);
    expect(anchorHref(headingActions, 'asset-viewer-back')).toBe(`/projects/${id}/assets?page=2&pageSize=1`);
    expect(pageHeading).toMatch(new RegExp(`<a class="button button-secondary page-heading-lead asset-viewer-project" href="/projects/${id}">Project: Viewer Accessibility</a>`));
    expect(pageHeading.indexOf('asset-viewer-project')).toBeLessThan(pageHeading.indexOf('<div class="page-heading-actions">'));
    expect(headingActions).not.toContain('asset-viewer-project');
    expect(pageHeading).not.toContain('status-badge');
    expect(res.text).toMatch(/<section class="settings-section asset-viewer-section asset-metadata-section"[\s\S]*?Present at last scan/);

    expect(headingActions).not.toContain('asset-preview-nav--previous');
    expect(headingActions).not.toContain('asset-preview-nav--next');
    expectNoAnchor(res.text, 'asset-viewer-original');
    expect(headingActions).not.toContain('asset-viewer-manage-tags');
    expect(headingActions).not.toContain('asset-viewer-edit');
    expect(headingActions).not.toContain('asset-viewer-open-locally');

    const actionToolbar = res.text.match(/<nav class="project-detail-action-toolbar asset-viewer-action-toolbar" aria-label="Asset actions">([\s\S]*?)<\/nav>/)?.[1] || '';
    expect(actionToolbar).not.toBe('');
    expect(res.text.indexOf('<nav class="project-detail-action-toolbar asset-viewer-action-toolbar"')).toBeGreaterThan(
      res.text.indexOf('</header>')
    );
    const editHref = anchorHref(actionToolbar, 'asset-viewer-edit');
    const editUrl = new URL(editHref, 'http://localhost');
    expect(editUrl.pathname).toBe(`/projects/${id}/assets/${assets.bravo.id}`);
    expect(editUrl.searchParams.get('pageSize')).toBe('1');
    expect(editUrl.searchParams.get('edit')).toBe('1');
    expect(anchorText(actionToolbar, 'asset-viewer-edit')).toBe('');
    expect(anchorMatch(actionToolbar, 'asset-viewer-edit')?.[0]).toMatch(
      /aria-label="Edit asset"[^>]*data-dialog-open="asset-edit-dialog"[^>]*data-tooltip="Edit asset"/
    );
    expect(anchorMatch(actionToolbar, 'asset-viewer-edit')?.[2]).toMatch(
      /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/
    );
    expect(res.text.indexOf('asset-preview-nav--previous')).toBeGreaterThan(res.text.indexOf('asset-preview-viewer'));
    expect(res.text.indexOf('asset-preview-nav--next')).toBeGreaterThan(res.text.indexOf('asset-preview-viewer'));
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

    const metadata = async (asset) => {
      const page = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
      return page.text.match(/<section class="settings-section asset-viewer-section asset-metadata-section"[\s\S]*?<\/section>/)?.[0] || '';
    };

    expect(await metadata(categorized)).toContain(`<dt>Location</dt>\n        <dd>/${project.slug}/persisted-final/</dd>`);
    expect(await metadata(disabled)).toContain(`<dt>Location</dt>\n        <dd>/${project.slug}/persisted-disabled/</dd>`);
    expect(await metadata(missing)).toContain(`<dt>Location</dt>\n        <dd>/${project.slug}/persisted-final/</dd>`);
    expect(await metadata(root)).toContain(`<dt>Location</dt>\n        <dd>/${project.slug}/</dd>`);
  });

  it('renders long viewer filenames, paths, MIME types, and release usage without truncation', async () => {
    const res = await createProject('Viewer Long Content');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Long Content');
    if (!projectDir) throw new Error('projectDir not found for Viewer Long Content');
    const filename = 'this-is-a-very-long-viewer-filename-that-must-wrap-without-expanding-the-viewport.txt';
    const relativePath = `deeply/nested/source/${filename}`;
    const asset = writeIndexedAsset(id, projectDir, relativePath, 'long content', {
      mimeType: 'application/vnd.example.extremely-long-mime-type',
    });
    await createReleaseUsingAsset(id, asset.id, 'Long Viewer Release');

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain(`<title>CreatorCrate — Assets — Viewer Long Content — ${filename}</title>`);
    expect(res2.text).toContain(`<h1 class="app-section-title">Assets — Viewer Long Content — ${filename}</h1>`);
    expect(res2.text).not.toContain('Canonical relative path');
    expect(res2.text).toContain(`<dd>/${slugify('Viewer Long Content', { lowercase: true })}/</dd>`);
    expect(res2.text).toContain('<code>application/vnd.example.extremely-long-mime-type</code>');
    expect(res2.text).toContain('Long Viewer Release');
  });

  // ─── Phase 15.2: category-aware compact file browser ────────────────

  it('includes the static client enhancement module exactly once', async () => {
    const res = await createProject('PhaseC Script');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const scriptCount = (res2.text.match(/<script type="module" src="\/creatorcrate\.js"><\/script>/g) || []).length;

    expect(scriptCount).toBe(1);
  });

  it('serves the dependency-free static client module', async () => {
    const res = await agent.get('/creatorcrate.js').expect(200);

    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('enhancePreviewMedia');
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

  it('renders prefers-reduced-motion media query', async () => {
    const res = await createProject('PhaseB Reduced Motion');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(await readStylesheetSource(res2.text)).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('renders focus-visible CSS for category disclosure controls and asset filenames', async () => {
    const res = await createProject('PhaseB Focus CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);
    expect(style).toMatch(/\.asset-filter-multiselect summary:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    expect(style).toMatch(/\.button:focus-visible/);
    expect(style).toMatch(/\.asset-file-link:focus-visible/);
  });

  it('inherits the shared page-width frame instead of a page-specific override', async () => {
    const res = await createProject('PhaseB Wide CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);
    // Phase 14: asset pages no longer define their own outer-width
    // override — they inherit --page-width via .app-main main like every
    // other authenticated page.
    expect(style).not.toContain('body.asset-browser-page main');
    expect(style).not.toContain('body.asset-viewer-page main');
    expect(style).toMatch(/\.app-main main\s*\{[^}]*max-width:\s*var\(--page-width\)/);
  });

  it('renders a full-width browser shell without a category sidebar', async () => {
    const res = await createProject('PhaseB Layout Shell');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const layoutStart = res2.text.indexOf('class="asset-browser-layout"');
    expect(layoutStart).toBeGreaterThan(-1);
    const navPos = res2.text.indexOf('class="asset-browser-nav"', layoutStart);
    const contentPos = res2.text.indexOf('class="asset-browser-content"', layoutStart);
    expect(navPos).toBe(-1);
    expect(contentPos).toBeGreaterThan(layoutStart);
    expect(await readStylesheetSource(res2.text)).toMatch(
      /\.asset-browser-layout\s*\{[^}]*display:\s*block/,
    );
  });

  it('renders pagination focus-visible CSS for keyboard accessibility', async () => {
    const res = await createProject('PhaseB Pagination CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);
    expect(style).toMatch(/\.pagination-prev:focus-visible/);
    expect(style).toMatch(/\.pagination-next:focus-visible/);
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

  it('renders a valid non-recursive success token and no undefined custom properties', async () => {
    const res = await createProject('PhaseB Token Validation');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);
    const declared = new Set(
      [...style.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1])
    );
    const used = [...style.matchAll(/var\(--([A-Za-z0-9_-]+)/g)].map((match) => match[1]);

    expect(style).toMatch(/--success\s*:\s*#[0-9a-f]{6}\s*;/i);
    expect(style).not.toMatch(/--success\s*:\s*var\(--success\)/);
    for (const token of used) {
      expect(declared.has(token)).toBe(true);
    }
  });

  it('serves /creatorcrate.css with the shared .asset-filename/.asset-date/.asset-file-link declarations and intrinsic-ratio grid rules', async () => {
    // This asserts the actual HTTP-served stylesheet — not the source file
    // on disk — so it can catch a misconfigured static route, wrong served
    // file, or stale response that a source-file read would miss.
    const res = await agent.get('/creatorcrate.css').expect(200);

    expect(res.headers['content-type']).toMatch(/text\/css/);
    const style = res.text;

    // .asset-filename: plain <td> class shared with releases/assets.njk,
    // detail.njk, and publish.njk — must keep its emphasized (bold) weight.
    expect(style).toMatch(/\.asset-filename\s*\{[^}]*font-weight:\s*600[^}]*\}/);

    // .asset-date: shared with releases/publish.njk — must keep its muted,
    // compact (smaller) presentation.
    expect(style).toMatch(/\.asset-date\s*\{[^}]*color:\s*var\(--muted\)[^}]*font-size:\s*0\.8rem[^}]*\}/);

    // .asset-file-link: the project asset browser's own filename-link style
    // (distinct from .asset-filename) must still be served.
    expect(style).toMatch(/\.asset-file-link\s*\{[^}]*font-weight:\s*600[^}]*\}/);

    // The restored grid view uses a responsive, intrinsic-ratio card grid —
    // no square aspect-ratio, no fixed-frame object-fit:contain cropping.
    expect(style).toMatch(/\.asset-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/);
    expect(style).toMatch(/\.asset-card\s*\{/);
    expect(style).toMatch(/\.asset-card-thumb\s*\{[^}]*display:\s*block[^}]*width:\s*100%[^}]*height:\s*auto[^}]*\}/);
    expect(style).not.toMatch(/\.asset-card-thumb\s*\{[^}]*aspect-ratio:\s*1/);
    expect(style).not.toMatch(/\.asset-card[^{]*\{[^}]*object-fit:\s*contain/);
  });

  it('serves project Grid information-card rules without changing shared Grid geometry', async () => {
    const res = await agent.get('/creatorcrate.css').expect(200);
    const style = res.text;

    expect(style).toMatch(/\.asset-card--project\s+\.asset-card-primary-metadata\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-areas:[^}]*category type[^}]*size modified/);
    expect(style).toMatch(/\.asset-card--project\s+\.asset-card-fact--category\s*\{[^}]*grid-area:\s*category/);
    expect(style).toMatch(/\.asset-card--project\s+\.asset-card-associations-region\s*\{[^}]*display:\s*grid[^}]*padding:\s*var\(--space-md\)[^}]*border:\s*1px solid var\(--border\)/);
    expect(style).toMatch(/\.asset-card--project\s+\.asset-card-associations\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*0\.85fr\)\s+minmax\(0,\s*1\.15fr\)/);
    expect(style).toMatch(/\.asset-grid\[data-grid-size="compact"\]\s+\.asset-card--project\s+\.asset-card-primary-metadata\s*\{[^}]*gap:\s*var\(--space-xs\)\s+var\(--space-sm\)[^}]*padding:\s*var\(--space-sm\)/);
    expect(style).toMatch(/\.asset-grid\[data-grid-size="large"\]\s+\.asset-card--project\s+\.asset-card-body\s*\{[^}]*gap:\s*var\(--space-lg\)[^}]*padding:\s*var\(--space-lg\)/);
    expect(style).not.toMatch(/\.asset-card--project\s+\.asset-card-media\s*\{/);
  });

  it('renders wrapping and containment rules for viewer and browser intrinsic-width content', async () => {
    const res = await createProject('PhaseB Mobile Containment');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);

    expect(style).toMatch(/\.page-heading\s*\{[^}]*min-width:\s*0/);
    // Phase 14: the long-title-safe element is now .app-section-title (the
    // compact header's sole h1) — it truncates with an ellipsis rather than
    // wrapping, since it lives in a fixed-height header bar.
    expect(style).toMatch(/\.app-section-title\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
    expect(style).toMatch(/\.page-heading-actions\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.page-heading\s*>\s*\.page-heading-lead,[\s\S]*?\.page-heading-actions\s*>\s*\.asset-viewer-back\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word[^}]*white-space:\s*normal/);
    expect(style).toMatch(/\.detail-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 8rem\) minmax\(0, 1fr\)[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.detail-list code\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    expect(style).toMatch(/\.asset-preview-frame\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-preview-image\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.asset-viewer-section,[\s\S]*?\.release-status\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(style).toMatch(/\.asset-browser-content\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/);
  });

  it('serves project list-card modifiers with compact natural media and untouched large media', async () => {
    const res = await agent.get('/creatorcrate.css').expect(200);
    const style = res.text;

    expect(style).toMatch(/\.asset-list--project\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-list-card--project\s*\{[^}]*position:\s*relative/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-top\s*\{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-top\s+\.asset-selection-control\s*\{[^}]*pointer-events:\s*auto/);
    expect(style).not.toMatch(/\.asset-list-card--project\s+\.asset-list-card-media(?:-fallback|-placeholder)?\s*\{/);
    expect(style).not.toMatch(/\.asset-list-card--project\s+\.asset-list-card-actions\s*\{/);
    expect(style).not.toMatch(/\.asset-list-card--project\s+\.asset-list-card-rename-form\s*\{/);
    expect(style).toMatch(/\.asset-viewer-grid-size-controls\s*\{[^}]*flex:\s*0 1 11rem[^}]*min-width:\s*min\(100%,\s*11rem\)[^}]*max-width:\s*11rem/);
    expect(style).toMatch(/\.asset-viewer-grid-size-controls\.asset-list-size-controls\s*\{[^}]*flex-basis:\s*8rem[^}]*min-width:\s*min\(100%,\s*8rem\)[^}]*max-width:\s*8rem/);
    expect(style).toMatch(/\.asset-list-card\s*\{[^}]*grid-template-columns:\s*clamp\(7rem,\s*20%,\s*15rem\)\s+minmax\(0,\s*1fr\)/);
    expect(style).toMatch(/\.asset-list-card-media\s*\{[^}]*align-self:\s*stretch[^}]*min-height:\s*10rem[^}]*border:\s*1px solid var\(--border\)[^}]*border-radius:\s*var\(--radius-md\)/);
    expect(style).toMatch(/\.asset-list-card-media-image\s*\{[^}]*object-fit:\s*contain/);
    expect(style).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]*?\.asset-list-card--project\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card\s*\{[^}]*grid-template-columns:\s*clamp\(4rem,\s*7%,\s*5rem\)\s+minmax\(0,\s*1fr\)[^}]*gap:\s*var\(--space-sm\)[^}]*padding:\s*var\(--space-xs\)/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-media\s*\{[^}]*width:\s*100%[^}]*max-width:\s*5rem[^}]*height:\s*auto[^}]*min-height:\s*0/);
    expect(style).not.toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-media\s*\{[^}]*align-self:/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-media\s*\{[^}]*margin-block-start:\s*calc\(var\(--space-2xl\)\s*\+\s*var\(--space-sm\)\)/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-media-link\s*\{[^}]*display:\s*block[^}]*width:\s*100%[^}]*height:\s*auto/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-media-image\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*height:\s*auto[^}]*object-fit:\s*initial/);
    expect(style).not.toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-media\s*\{[^}]*height:\s*5rem/);
    expect(style).not.toMatch(/\.asset-list--project\[data-list-size="large"\]\s+\.asset-list-card-media\s*\{/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-body\s*\{[^}]*gap:\s*var\(--space-xs\)/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-primary-metadata\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-areas:[^}]*category type[^}]*size modified/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-primary-metadata\s+\.asset-list-card-meta--category\s*\{[^}]*grid-area:\s*category/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-primary-metadata\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-areas:\s*"category type size modified"[^}]*gap:\s*var\(--space-xs\)\s+var\(--space-sm\)[^}]*padding:\s*var\(--space-sm\)/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-body\s*\{[^}]*display:\s*grid[^}]*grid-template-areas:[^}]*identity[^}]*metadata[^}]*associations/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-associations-region\s*\{[^}]*display:\s*grid[^}]*padding:\s*var\(--space-md\)[^}]*border:\s*1px solid var\(--border\)/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-associations\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*0\.85fr\)\s+minmax\(0,\s*1\.15fr\)/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*0\.95fr\)\s+minmax\(0,\s*1\.05fr\)[^}]*grid-template-areas:[^}]*identity identity[^}]*metadata associations/);
    const compactListStyles = style.slice(
      style.indexOf('.asset-list--project[data-list-size="compact"]'),
      style.indexOf('Pagination', style.indexOf('.asset-list--project[data-list-size="compact"]'))
    );
    expect(compactListStyles).not.toMatch(/display:\s*none/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-header\s*\{[^}]*column-gap:\s*var\(--space-md\)/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-status\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*align-items:\s*center[^}]*max-width:\s*100%[^}]*flex-wrap:\s*nowrap/);
    expect(style).toMatch(/\.asset-list-card-title-actions\s*\{[^}]*display:\s*flex[^}]*flex:\s*0\s+0\s+auto[^}]*align-items:\s*center[^}]*gap:\s*var\(--space-xs\)/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-card-title-row\s*\{[^}]*align-items:\s*center/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-title-control-row\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*gap:\s*var\(--space-md\)[^}]*width:\s*100%/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-card-title-row\s+\.asset-rename-trigger\s*\{[^}]*height:\s*1\.75rem[^}]*min-height:\s*1\.75rem[^}]*line-height:\s*1/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-status\s+\.asset-indicator,[\s\S]*?\.asset-list-card--project\s+\.asset-list-card-status\s+\.asset-details-link\s*\{[^}]*flex:\s*0\s+0\s+1\.75rem[^}]*width:\s*1\.75rem[^}]*height:\s*1\.75rem[^}]*min-height:\s*1\.75rem[^}]*line-height:\s*1/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-status\s*>\s*\.asset-list-card-presence,[\s\S]*?\.asset-list-card--project\s+\.asset-list-card-status\s*>\s*\.asset-list-card-release-usage\s*\{[^}]*display:\s*flex[^}]*flex:\s*0\s+0\s+1\.75rem[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*width:\s*1\.75rem[^}]*height:\s*1\.75rem[^}]*min-height:\s*1\.75rem[^}]*line-height:\s*1/);
    expect(style).not.toMatch(/\.asset-list-card--project\s+\.asset-list-card-identity\s*\{[^}]*padding-inline-end:/);
    // Compact may explicitly use zero top padding; protect the responsive
    // region order and alignment instead of that implementation detail.
    expect(style).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]*?\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*grid-template-areas:\s*"identity"\s*"metadata"\s*"associations"/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-card-title-row\s+\.asset-list-card-title\s*\{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.asset-list--project\[data-list-size="compact"\]\s+\.asset-list-card-header\s*\{[^}]*row-gap:\s*var\(--space-sm\)[^}]*column-gap:\s*var\(--space-md\)/);
    expect(style).toMatch(/\.asset-list-card--project\s+\.asset-list-card-top\s*\{[^}]*justify-content:\s*space-between[^}]*pointer-events:\s*none/);
    expect(style).not.toContain('asset-list-card-top-status');
  });

  // ─── Project list-card markup ───────────────────────────────────

  it('renders project list cards instead of the old data table', async () => {
    const res = await createProject('Project List Card Markup');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Project List Card Markup');
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('<ul class="asset-list asset-list--project" role="list" aria-label="Project assets" data-list-size="large">');
    expect(res2.text).toContain('<li class="asset-list-item">');
    expect(res2.text).toContain('<article class="asset-list-card asset-list-card--project"');
    expect(res2.text).not.toContain('data-table asset-table');
    expect(res2.text).not.toContain('<table');
    for (const label of ['Category', 'Type', 'Size', 'Modified', 'Tags']) {
      expect(res2.text).toContain(`>${label}<`);
    }
    expect(res2.text).not.toContain('asset-list-card-association--releases');
  });

  it('keeps project list-card information in identity, metadata, and associations regions', async () => {
    const res = await createProject('Project List Card Hierarchy');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Project List Card Hierarchy');
    const asset = writeIndexedAsset(id, projectDir, 'renders/hero.png', await makePng());
    await createReleaseUsingAsset(id, asset.id, 'Hierarchy Release');

    const response = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const card = assetListCardHtml(response.text, asset.id);
    const identity = card.match(/<div class="asset-list-card-header asset-list-card-identity">([\s\S]*?)<\/div>\s*<dl class="asset-list-card-metadata asset-list-card-primary-metadata">/)?.[1] || '';
    const metadata = card.match(/<dl class="asset-list-card-metadata asset-list-card-primary-metadata">([\s\S]*?)<\/dl>/)?.[1] || '';
    const associationsStartMarker = '<section class="asset-list-card-associations-region" aria-label="Asset associations">';
    const associationsStart = card.indexOf(associationsStartMarker);
    const associationsEnd = card.lastIndexOf('</section>');
    const associations = associationsStart >= 0 && associationsEnd > associationsStart
      ? card.slice(associationsStart, associationsEnd + '</section>'.length)
      : '';
    const titleRow = card.match(/<div class="asset-card-title-row" data-asset-title-row>([\s\S]*?)<\/div>/)?.[1] || '';

    expect(identity).toContain('asset-list-card-title');
    expect(identity).toContain('data-asset-containing-location');
    expect(identity.indexOf('asset-list-card-title')).toBeLessThan(identity.indexOf('data-asset-containing-location'));
    for (const label of ['Category', 'Type', 'Size', 'Modified']) {
      expect((metadata.match(new RegExp(`<dt>${label}</dt>`, 'g')) || [])).toHaveLength(1);
    }
    expect(associations).toContain('asset-list-card-association--releases');
    expect(associations).toContain('asset-list-card-association--tags');
    expect(associations).toContain('asset-list-card-associations-heading');
    expect(associations.indexOf('asset-list-card-association--releases')).toBeLessThan(associations.indexOf('asset-list-card-association--tags'));
    expect(titleRow).toContain('asset-list-card-title');
    expect(titleRow).toContain('data-asset-rename-trigger');
    expect(titleRow).not.toContain('asset-file-link');
    expect(titleRow).toContain('>Rename</a>');
    expect(card.match(/<div class="asset-list-card-top">([\s\S]*?)<\/div>\s*<div class="asset-list-card-media/)?.[1] || '')
      .not.toContain('data-asset-rename-trigger');
    expect(card).not.toContain('data-asset-card-navigation');
    expect(card).not.toContain('data-asset-card-link');
    expect(card).toContain('class="asset-card-rename-editor" data-asset-rename-editor hidden inert>');
    expect(card).not.toContain('row-rename-form');
    expect(card).not.toContain('asset-list-card-rename-form');
    expect(card).not.toContain('asset-list-card-actions');
    expect(card.indexOf('asset-list-card-primary-metadata')).toBeLessThan(card.indexOf('asset-list-card-associations-region'));
  });

  it('opts complete-category table thumbnails into the single-asset slideshow', async () => {
    const res = await createProject('Project Complete Table Preview');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Project Complete Table Preview');
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    const content = await makePng();
    const relativePath = 'renders/table.png';
    const target = path.join(projectDir, 'renders', 'table.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const asset = assetRepo.upsert(id, relativePath, {
      filename: 'table.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: content.length, modifiedAt: '2026-07-28 10:00:00',
      categoryId: category.id, nestedPath: '',
    });

    const response = await agent.get(`/projects/${id}/assets?category=${category.id}&view=list`).expect(200);
    const card = assetListCardHtml(response.text, asset.id);

    expect(response.text).toContain('<ul class="asset-list asset-list--project" role="list" aria-label="Project assets" data-list-size="large">');
    expect(card).not.toBe('');
    expect(card).toContain(`data-project-assets-preview-id="${asset.id}"`);
    expect(card).toMatch(new RegExp(`<a\\b[^>]*class="asset-details-link[^\"]*"[^>]*href="/projects/${id}/assets/${asset.id}[^\"]*"[^>]*data-tooltip="View asset details"`));
  });

  it('uses the global Asset Viewer list preview structure and dimensions in the project list', async () => {
    const res = await createProject('Project List Preview Parity');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Project List Preview Parity');
    const asset = writeIndexedAsset(id, projectDir, 'preview.png', await makePng(512, 384));

    const projectList = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const globalList = await agent.get('/assets?view=list').expect(200);
    const projectMedia = assetListMediaHtml(assetListCardHtml(projectList.text, asset.id));
    const globalMedia = assetListMediaHtml(assetListCardHtml(globalList.text, asset.id));
    const projectPreviewPattern = /<div class="asset-list-card-media" data-preview-enhancement data-preview-state="loading">\s*<a class="asset-list-card-media-link" href="[^"]+" aria-label="[^"]+" data-project-assets-preview-id="\d+">\s*<img class="asset-list-card-media-image"\s+src="[^"]+"\s+alt=""\s+loading="lazy"\s+decoding="async"\s+data-preview-image>\s*<\/a>\s*<span class="asset-list-card-media-fallback" data-preview-fallback hidden>[^<]*<\/span>\s*<\/div>/;

    expect(projectMedia).toMatch(projectPreviewPattern);
    expect(globalMedia).toMatch(projectPreviewPattern);
    expect(projectMedia).not.toContain('asset-thumb');
    const projectPreviewSrc = projectMedia.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1] || '';
    const globalPreviewSrc = globalMedia.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1] || '';
    expect(projectPreviewSrc).toBe(globalPreviewSrc);
    expect(projectPreviewSrc).toMatch(new RegExp(`/projects/${id}/assets/${asset.id}/preview\\?v=[^"&]+$`));
    expect(projectPreviewSrc).not.toContain(`/projects/${id}/assets/${asset.id}/thumbnail`);
    expect(assetListCardHtml(projectList.text, asset.id)).toContain('data-asset-selectable-card');
    expect(assetListCardHtml(projectList.text, asset.id)).toContain('aria-selected="false"');
    expect(projectList.text).toContain('asset-selection-control');
    expect(projectList.text).toContain('data-asset-rename-trigger');
    expect(projectList.text).not.toContain('asset-list-card-rename-form');

    const style = await readStylesheetSource(projectList.text);
    expect(style).toMatch(/\.asset-list-card\s*\{[^}]*grid-template-columns:\s*clamp\(7rem,\s*20%,\s*15rem\)\s+minmax\(0,\s*1fr\)/);
    expect(style).toMatch(/\.asset-list-card-media\s*\{[^}]*align-self:\s*stretch[^}]*min-height:\s*10rem/);
    expect(style).toMatch(/\.asset-list-card-media-image\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*object-fit:\s*contain/);
    expect(style).toMatch(/\.asset-list-card--project\.is-selected\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*box-shadow:/);
    expect(style).not.toMatch(/\.asset-list-card--project\s+\.asset-list-card-media(?:-fallback|-placeholder)?\s*\{/);
  });

  it('keeps project list-card details and rename controls independently usable', async () => {
    const res = await createProject('Project List Card Actions');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Project List Card Actions');
    const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?view=list&search=a`).expect(200);
    const card = assetListCardHtml(res2.text, asset.id);
    expect(card).not.toBe('');
    const top = card.match(/<div class="asset-list-card-top">([\s\S]*?)<\/div>\s*<div class="asset-list-card-media/)?.[1] || '';
    const header = card.match(/<div class="asset-list-card-header asset-list-card-identity">([\s\S]*?)<\/div>\s*<dl class="asset-list-card-metadata/)?.[1] || '';
    expect(top).not.toContain('asset-list-card-status');
    expect(header).toMatch(/asset-list-card-title-control-row[\s\S]*asset-card-title-row[\s\S]*asset-list-card-title-actions[\s\S]*asset-list-card-status/);
    expect(header).toMatch(/asset-list-card-title-actions[\s\S]*data-asset-rename-trigger[\s\S]*asset-list-card-status[\s\S]*asset-indicator--present[\s\S]*class="asset-details-link asset-tooltip asset-tooltip--right"[\s\S]*data-tooltip="View asset details"/);
    expect(card).toContain('name="_csrf"');
    expect(card).toContain('name="origin" value="assets"');
    expect(card).toContain('class="asset-card-rename-input"');
    expect(card).toContain('data-asset-rename-input');
    expect(card).toContain('data-asset-rename-confirm');
    expect(card).toContain('data-asset-rename-cancel');
    expect(card).not.toContain('data-asset-card-navigation');
    expect(card).not.toContain('data-asset-card-link');
    expect(card).not.toContain('row-rename-input');
    expect(card).not.toContain('asset-list-card-actions');
    const titleRow = card.match(/<div class="asset-card-title-row" data-asset-title-row>([\s\S]*?)<\/div>/)?.[1] || '';
    expect(titleRow).toContain('asset-list-card-title');
    expect(titleRow).toContain('data-asset-rename-trigger');
    const hiddenRenameEditor = card.match(/<form method="post" action="\/projects\/\d+\/assets\/\d+\/rename"\s+class="asset-card-rename-editor" data-asset-rename-editor hidden inert>[\s\S]*?<\/form>/)?.[0] || '';
    expect(hiddenRenameEditor).not.toBe('');
    expect(hiddenRenameEditor).toMatch(/<input type="hidden" name="_csrf"[^>]*\bdisabled\b/);
    expect(hiddenRenameEditor).toMatch(/<input type="text"[^>]*class="asset-card-rename-input"[^>]*\bdisabled\b/);
    expect(hiddenRenameEditor).toMatch(/<button[^>]*data-asset-rename-confirm[^>]*\bdisabled\b/);
    expect(hiddenRenameEditor).toMatch(/<button[^>]*data-asset-rename-cancel[^>]*\bdisabled\b/);
  });

  it('renders accessible List/Grid view controls with the correct selected state', async () => {
    const res = await createProject('View Switcher');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('View Switcher');
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const listRes = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(listRes.text).toContain('class="view-switcher"');
    expect(listRes.text).toMatch(/class="[^"]*view-switcher-option[^"]*" href="[^"]*"[\s\S]*?aria-current="page"[\s\S]*?aria-label="List view"/);
    expect(listRes.text).not.toContain('class="asset-grid"');
    expect(listRes.text).toContain('asset-list asset-list--project');
    expect(listRes.text).toContain('asset-list-card asset-list-card--project');
    expect(listRes.text).not.toContain('data-table asset-table');
    expect(listRes.text).toContain('data-asset-list-size-controls');
    expect(listRes.text).toContain('asset-list-size-controls');
    expect((listRes.text.match(/<input[^>]+data-grid-size-slider[^>]+type="range"/g) || [])).toHaveLength(1);
    expect(listRes.text).toMatch(/<input[^>]+data-grid-size-slider[^>]+min="1"[^>]+max="2"[^>]+step="1"[^>]+aria-label="List size"/);
    expect(listRes.text).toMatch(/data-grid-size-option-label="compact"[^>]*>Compact/);
    expect(listRes.text).toMatch(/data-grid-size-option-label="large"[^>]*>Large/);
    expect(listRes.text).not.toMatch(/data-grid-size-option-label="default"/);
    expect(listRes.text).toContain('data-tooltip="View asset details"');
    expect(listRes.text).not.toMatch(/class="asset-details-link[^>]*title="/);

    const gridRes = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(gridRes.text).toContain('class="view-switcher"');
    expect(gridRes.text).toMatch(/class="[^"]*view-switcher-option[^"]*" href="[^"]*"[\s\S]*?aria-current="page"[\s\S]*?aria-label="Grid view"/);
    expect(gridRes.text.indexOf('aria-label="Grid view"')).toBeLessThan(gridRes.text.indexOf('aria-label="List view"'));
    expect(gridRes.text).toContain('class="asset-viewer-display-controls"');
    expect(gridRes.text).toContain('data-asset-grid-size-controls');
    expect((gridRes.text.match(/<input[^>]+data-grid-size-slider[^>]+type="range"/g) || [])).toHaveLength(1);
    expect(gridRes.text).toMatch(/<input[^>]+data-grid-size-slider[^>]+min="1"[^>]+max="3"[^>]+step="1"[^>]+aria-label="Grid size"/);
    expect(gridRes.text).toContain('aria-valuenow="2" aria-valuetext="Default"');
    expect(gridRes.text).toMatch(/data-grid-size-option-label="compact"[^>]*>Compact/);
    expect(gridRes.text).toMatch(/class="[^"]*is-active[^"]*"[^>]*data-grid-size-option-label="default"[^>]*>Default/);
    expect(gridRes.text).toMatch(/data-grid-size-option-label="large"[^>]*>Large/);
    expect(gridRes.text).not.toContain('asset-list-size-controls');
    expect(gridRes.text).not.toContain('data-grid-size-current');
    expect(gridRes.text).not.toMatch(/<button[^>]+data-grid-size="(?:compact|default|large)"/);
    expect(gridRes.text).toContain('class="asset-grid"');
    expect(gridRes.text).toMatch(/<article class="asset-card(?: asset-card--project)?"/);
    expect(gridRes.text).not.toContain('data-table asset-table');
    expect(gridRes.text).not.toContain('asset-list--project');
    expect(listRes.text).not.toContain('data-asset-grid-size-controls');

    const globalListRes = await agent.get('/assets?view=list').expect(200);
    expect(globalListRes.text).toContain('<ul class="asset-list" role="list" aria-label="Assets across active projects">');
    expect(globalListRes.text).toContain('<article class="asset-list-card"');
    expect(globalListRes.text).not.toContain('asset-list--project');
    expect(globalListRes.text).not.toContain('asset-list-card--project');
  });

  it('renders project Grid identity, grouped metadata, actions, and bulk-selection fields', async () => {
    const res = await createProject('Grid Card Parity');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Card Parity');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    const html = res2.text;
    const cardMatch = html.match(/<article class="asset-card[\s\S]*?<\/article>/);
    expect(cardMatch).not.toBeNull();
    const card = cardMatch[0];

    expect(html).toContain(`data-asset-id="${asset.id}"`);
    expect((card.match(/<input type="checkbox"/g) || []).length).toBe(1);
    expect((card.match(/class="asset-selection-control"/g) || []).length).toBe(1);
    expect(card.indexOf('class="asset-selection-control"')).toBeLessThan(card.indexOf('asset-indicator'));
    expect(card).toContain(`name="selectedAssetIds" value="${asset.id}"`);
    expect(card).toContain('form="bulk-select-form"');
    expect(html).toContain(`aria-label="Select hero.png"`);
    expect(card).toMatch(/<span class="asset-card-title-text">hero<\/span>/);
    expect(card).not.toContain('asset-card-filename');
    expect(card).not.toMatch(/<a[^>]*>hero<\/a>/);
    expect(html).toContain('class="asset-card-media-link"');
    expect(html).toContain('class="asset-details-link asset-tooltip asset-tooltip--right"');
    expect(html).toContain('aria-label="View details for hero.png"');
    expect(html).toContain('asset-indicator--present');
    expect(html).toContain('aria-label="Present" data-tooltip="Present">P</span>');
    expect(card).toContain('role="option" aria-selected="false" data-asset-selectable-card tabindex="0"');
    expect(card).toContain('aria-selected="false"');
    expect(card).not.toContain('asset-card-selection-badge');
    expect(card).not.toContain('title="');
    expect(card).toContain('<div class="asset-card-identity">');
    expect(card).toContain('<dl class="asset-card-primary-metadata" aria-label="Primary metadata">');
    const metadata = card.match(/<dl class="asset-card-primary-metadata"[\s\S]*?<\/dl>/)?.[0] || '';
    for (const label of ['Category', 'Type', 'Size', 'Modified']) {
      expect((metadata.match(new RegExp(`<dt>${label}</dt>`, 'g')) || [])).toHaveLength(1);
    }
    expect(metadata).toContain('Uncategorized');
    expect(card.indexOf('asset-card-title-text')).toBeLessThan(card.indexOf('asset-card-primary-metadata'));
    expect(card).toContain('<section class="asset-card-associations-region" aria-label="Asset associations">');
    expect(card).toContain('<h3 class="asset-card-associations-heading">Associations</h3>');
    expect(card).toContain('asset-card-association--tags');
    expect(card).toContain('>Tags<');
    expect(card).toContain('None assigned');
    expect(card).not.toContain('asset-card-association--releases');
    expect(card).toContain('data-tooltip="View asset details"');
    expect(card).toContain('data-asset-rename-trigger');
    expect(card).toContain('data-asset-rename-editor');
    expect(card).toContain('href="/projects/');
    expect(card).toMatch(/class="asset-card-rename-editor" data-asset-rename-editor hidden inert>/);
    expect(card).toMatch(/class="asset-card-rename-input"[^>]*\bdisabled\b/);
    expect(card).not.toContain('<summary');
    expect(card).not.toContain('<details');
    expect(card).toContain('data-asset-rename-input');
    expect(card).toContain('value="hero"');
    expect(card).not.toContain('value="hero.png"');
    expect(card).toContain('data-asset-rename-confirm');
    expect(card).toContain('data-asset-rename-cancel');
    expect(card).toContain('name="origin" value="assets"');
    expect(card).toContain(`data-project-assets-preview-id="${asset.id}"`);
    expect(card).toMatch(/<div class="asset-card-media" data-preview-enhancement data-preview-state="loading">\s*<a class="asset-card-media-link" href="[^"]+" aria-label="View details for hero\.png" data-project-assets-preview-id="\d+">\s*<img class="asset-card-thumb"[^>]*data-preview-image>\s*<\/a>\s*<span class="asset-card-placeholder asset-card-fallback" data-preview-fallback hidden>PNG<\/span>\s*<\/div>/);
    expect(card).not.toMatch(/<a class="asset-card-media-link"[^>]*>\s*<div class="asset-card-media"/);

    const style = await readStylesheetSource(html);
    const assetCardRule = style.match(/\.asset-card\s*\{([^}]*)\}/)?.[1] || '';
    const assetCardMediaRule = style.match(/\.asset-card-media\s*\{([^}]*)\}/)?.[1] || '';
    expect(assetCardRule).not.toMatch(/overflow\s*:\s*hidden/);
    expect(assetCardMediaRule).toMatch(/overflow\s*:\s*hidden/);
    expect(assetCardMediaRule).toMatch(/border-radius\s*:\s*0\s+0\s+var\(--radius-lg\)\s+var\(--radius-lg\)/);
    expect(style).toMatch(/\.asset-indicator\s*\{[^}]*width:\s*1\.5rem[^}]*height:\s*1\.5rem[^}]*border-radius:\s*var\(--radius-sm\)/);
    expect(style).toMatch(/\.asset-selection-control\s*\{[^}]*width:\s*1\.75rem[^}]*height:\s*1\.75rem[^}]*border-radius:\s*var\(--radius-md\)/);
    expect(style).toMatch(/\.asset-card-top \.asset-details-link\s*\{[^}]*margin-left:\s*auto/);
    expect(style).toMatch(/\.asset-card:has\(\.asset-select-checkbox:checked\)/);
    expect(style).toMatch(/\.asset-tooltip\[data-tooltip\]:hover::after[\s\S]*\.asset-tooltip\[data-tooltip\]:focus-visible::after/);
    expect(style).toMatch(/\.asset-tooltip--left\[data-tooltip\]::after/);
    expect(style).toMatch(/\.asset-tooltip--right\[data-tooltip\]::after/);
    expect(card).toMatch(/asset-tooltip--left[\s\S]*asset-tooltip--right/);
    expect(card.indexOf('asset-tooltip--right')).toBeLessThan(card.indexOf('asset-card-media'));

    const list = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const listCard = assetListCardHtml(list.text, asset.id);
    expect(listCard).toMatch(/<div class="asset-card-title-row" data-asset-title-row>\s*<h2 class="asset-list-card-title">\s*hero\s*<\/h2>[\s\S]*data-asset-rename-trigger/);
    expect(listCard).not.toMatch(/<h2 class="asset-list-card-title">\s*<a class="asset-file-link"/);
    expect(assetListCardHtml(list.text, asset.id)).toContain(`data-project-assets-preview-id="${asset.id}"`);
  });

  it('renders categorized and uncategorized labels inside project Grid metadata', async () => {
    const res = await createProject('Grid Card Category Metadata');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Card Category Metadata');
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    const uncategorized = writeIndexedAsset(id, projectDir, 'root.png', await makePng());
    const categorizedPath = path.join(projectDir, 'renders', 'final.png');
    const categorizedContent = await makePng();
    fs.mkdirSync(path.dirname(categorizedPath), { recursive: true });
    fs.writeFileSync(categorizedPath, categorizedContent);
    const categorized = assetRepo.upsert(id, 'renders/final.png', {
      filename: 'final.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: categorizedContent.length, modifiedAt: '2026-07-28 10:00:00',
      categoryId: category.id, nestedPath: '',
    });

    const res2 = await agent.get(`/projects/${id}/assets?view=grid&pageSize=100`).expect(200);
    const categorizedCard = assetCardHtml(res2.text, categorized.id);
    const uncategorizedCard = assetCardHtml(res2.text, uncategorized.id);

    expect(categorizedCard).toMatch(/<span class="asset-card-title-text">final<\/span>/);
    expect(categorizedCard).toMatch(/<div class="asset-card-fact asset-card-fact--category">[\s\S]*?<dt>Category<\/dt>[\s\S]*?<dd>[\s\S]*?Renders[\s\S]*?<\/dd>/);
    expect(categorizedCard.indexOf('asset-card-title-text')).toBeLessThan(categorizedCard.indexOf('asset-card-primary-metadata'));
    expect((categorizedCard.match(/<dt>Category<\/dt>/g) || [])).toHaveLength(1);
    expect(categorizedCard).not.toMatch(/<a[^>]*>final<\/a>/);
    expect(categorizedCard).toContain(`class="asset-details-link asset-tooltip asset-tooltip--right" href="/projects/${id}/assets/${categorized.id}`);
    expect(categorizedCard).toContain(`class="asset-card-media-link" href="/projects/${id}/assets/${categorized.id}`);

    expect(uncategorizedCard).toMatch(/<div class="asset-card-fact asset-card-fact--category">[\s\S]*?<dt>Category<\/dt>[\s\S]*?<dd>[\s\S]*?Uncategorized[\s\S]*?<\/dd>/);
    expect(uncategorizedCard).toContain(`class="asset-details-link asset-tooltip asset-tooltip--right" href="/projects/${id}/assets/${uncategorized.id}`);
  });

  it('groups Grid release membership and tags in Associations without an empty Releases row', async () => {
    const res = await createProject('Grid Associations');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Associations');
    const used = writeIndexedAsset(id, projectDir, 'used.png', await makePng());
    const unused = writeIndexedAsset(id, projectDir, 'unused.png', await makePng());
    const tag = app.locals.tagService.createTag({ name: 'Grid Association Tag' });
    app.locals.assetTagService.replaceAssetTags(used.id, [tag.id]);
    await createReleaseUsingAsset(id, used.id, 'Grid Release One');
    await createReleaseUsingAsset(id, used.id, 'Grid Release Two');

    const response = await agent.get(`/projects/${id}/assets?view=grid&pageSize=100`).expect(200);
    const usedCard = assetCardHtml(response.text, used.id);
    const unusedCard = assetCardHtml(response.text, unused.id);
    const metadata = usedCard.match(/<dl class="asset-card-primary-metadata"[\s\S]*?<\/dl>/)?.[0] || '';

    expect(metadata).toContain('<dt>Category</dt>');
    expect(metadata).toContain('<dt>Type</dt>');
    expect(metadata).toContain('<dt>Size</dt>');
    expect(metadata).toContain('<dt>Modified</dt>');
    expect(usedCard).toContain('<h3 class="asset-card-associations-heading">Associations</h3>');
    expect(usedCard).toContain('asset-card-association--releases');
    expect(usedCard).toContain('asset-card-association--tags');
    expect(usedCard).toContain('>Grid Release One</a>');
    expect(usedCard).toContain('>Grid Release Two</a>');
    expect(usedCard).toContain('>Grid Association Tag</li>');
    expect(usedCard).toContain('data-asset-release-membership');
    expect(usedCard.indexOf('asset-card-primary-metadata')).toBeLessThan(usedCard.indexOf('asset-card-associations-region'));
    expect(unusedCard).not.toContain('asset-card-association--releases');
    expect(unusedCard).toContain('asset-card-association--tags');
  });

  it('keeps missing and unavailable grid media placeholders outside the details link', async () => {
    const res = await createProject('Grid Media Placeholders');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Media Placeholders');
    const missing = writeIndexedAsset(id, projectDir, 'missing.png', await makePng());
    writeIndexedAsset(id, projectDir, 'source.bin', Buffer.from('binary'), {
      extension: 'bin', mimeType: 'application/octet-stream',
    });
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
    fs.rmSync(path.join(projectDir, 'missing.png'));
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    const cards = [...res2.text.matchAll(/<article class="asset-card[\s\S]*?<\/article>/g)].map((match) => match[0]);
    const missingCard = cards.find((card) => card.includes(`data-asset-id="${missing.id}"`));
    const unsupportedCard = cards.find((card) => card.includes('>source<'));

    expect(missingCard).toBeDefined();
    expect(missingCard).toMatch(/<div class="asset-card-media">\s*<span class="asset-card-placeholder asset-card-placeholder-missing">Missing at last scan<\/span>\s*<\/div>/);
    expect(missingCard).not.toContain('asset-card-media-link');
    expect(unsupportedCard).toBeDefined();
    expect(unsupportedCard).toMatch(/<div class="asset-card-media">\s*<span class="asset-card-placeholder">BIN — preview not supported<\/span>\s*<\/div>/);
    expect(unsupportedCard).not.toContain('asset-card-media-link');
  });

  it('uses the higher-resolution preview derivative in both Grid and project List', async () => {
    const res = await createProject('Grid Preview Derivative');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Preview Derivative');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng(512, 384));

    const grid = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(grid.text).toMatch(new RegExp(`<img class="asset-card-thumb"[^>]*src="/projects/${id}/assets/${asset.id}/preview\\?v=`));
    expect(grid.text).not.toMatch(new RegExp(`<img class="asset-card-thumb"[^>]*src="[^"]+/original`));

    const list = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(list.text).toMatch(new RegExp(`<img class="[^"]*\\basset-list-card-media-image\\b[^"]*"[^>]*src="/projects/${id}/assets/${asset.id}/preview\\?v=`));
    expect(list.text).not.toMatch(new RegExp(`<img class="[^"]*\\basset-list-card-media-image\\b[^"]*"[^>]*src="[^"]+/thumbnail`));
  });

  it('renders valid KRA and KRZ previews in Grid, List, and the viewer without original links', async () => {
    const res = await createProject('Krita Asset Presentation');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Krita Asset Presentation');
    const merged = await makePng(2000, 1000);
    const preview = await makePng(320, 180);
    const kra = writeIndexedAsset(id, projectDir, 'scene.kra', makeKritaArchive({ merged, preview }));
    const krz = writeIndexedAsset(id, projectDir, 'scene.krz', makeKritaArchive({ preview }));

    const grid = await agent.get(`/projects/${id}/assets?pageSize=100`).expect(200);
    for (const asset of [kra, krz]) {
      const card = grid.text.match(new RegExp(`<article class="asset-card[\\s\\S]*?data-asset-id="${asset.id}"[\\s\\S]*?<\\/article>`))?.[0];
      expect(card).toBeDefined();
      expect(card).toContain('class="asset-card-media asset-media--krita" data-preview-enhancement');
      expect(card).toMatch(new RegExp(`class="asset-card-thumb"[^>]*src="/projects/${id}/assets/${asset.id}/preview\\?v=`));
      expect(card).toContain(`/projects/${id}/assets/${asset.id}`);
    }

    const list = await agent.get(`/projects/${id}/assets?view=list&pageSize=100`).expect(200);
    for (const asset of [kra, krz]) {
      const card = assetListCardHtml(list.text, asset.id);
      expect(card).not.toBe('');
      expect(card).toContain('class="asset-list-card-media" data-preview-enhancement');
      expect(card).toMatch(new RegExp(`class="[^"]*\\basset-list-card-media-image\\b[^"]*"[^>]*src="/projects/${id}/assets/${asset.id}/preview\\?v=`));
      expect(card).not.toContain('width="48"');
      expect(card).not.toContain('height="48"');
    }

    for (const asset of [kra, krz]) {
      const viewer = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
      const previewSection = previewSectionHtml(viewer.text);
      expect(previewSection).toContain('class="asset-preview-frame asset-media--krita" data-preview-enhancement');
      expect(previewSection).toContain(`/projects/${id}/assets/${asset.id}/preview?v=`);
      expect(previewSection).toContain('data-preview-image');
      expectNoAnchor(previewSection, 'asset-preview-link');
      expectNoAnchor(viewer.text, 'asset-viewer-original');
    }
  });

  it('keeps classified Krita preview markup when extraction later fails, for the existing runtime fallback', async () => {
    const res = await createProject('Krita Runtime Fallback');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Krita Runtime Fallback');
    const asset = writeIndexedAsset(id, projectDir, 'broken.kra', Buffer.from('not a zip'), {
      extension: 'kra', mimeType: 'application/x-krita',
    });

    const viewer = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
    const previewSection = previewSectionHtml(viewer.text);
    expect(previewSection).toContain('data-preview-enhancement data-preview-state="loading"');
    expect(previewSection).toContain('data-preview-image');
    expect(previewSection).toContain('data-preview-fallback hidden');
    expect(previewSection).toContain(`/projects/${id}/assets/${asset.id}/preview?v=`);

    const failed = await agent.get(`/projects/${id}/assets/${asset.id}/preview`).expect(503);
    expect(failed.text).toBe('Preview unavailable');
  });

  it('submits only the basename in the List rename form while displaying the extension suffix', async () => {
    const res = await createProject('Display Filename Form');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Display Filename Form');
    const asset = writeIndexedAsset(id, projectDir, 'archive.final.png', await makePng());

    const list = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    const card = assetListCardHtml(list.text, asset.id);
    const title = card.match(/<h2 class="asset-list-card-title">([\s\S]*?)<\/h2>/)?.[1] || '';
    expect(card).not.toBe('');
    expect(title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).toBe('archive.final');
    expect(title).not.toMatch(/<a\b/);
    expect(anchorHref(card, 'asset-details-link')).not.toBeNull();
    expect(list.text).toContain('value="archive.final"');
    expect(list.text).toContain('class="asset-rename-extension" aria-hidden="true">.png</span>');
    expect(list.text).toContain('>PNG<');
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

  it('reopens the grid Rename editor with the submitted basename after a controlled failure', async () => {
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
    expect(card).toContain('data-asset-title-row hidden');
    expect(card).toContain('data-asset-rename-editor');
    expect(card).toMatch(/class="asset-card-rename-editor" data-asset-rename-editor>/);
    expect(card).not.toContain('<summary');
    expect(card).not.toContain('<details');
    expect(card).toContain('value="bad/name"');
    expect(card).toContain('aria-label="New basename for scene.v2.kra"');
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

  it('disables selection for a missing asset in grid view', async () => {
    const res = await createProject('Grid Missing Selection');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Missing Selection');
    if (!projectDir) throw new Error('projectDir not found for Grid Missing Selection');
    const filePath = path.join(projectDir, 'gone.png');
    fs.writeFileSync(filePath, 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
    fs.rmSync(filePath);
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    expect(res2.text).toMatch(/<input type="checkbox" id="asset-card-select-\d+" disabled aria-label="gone\.png is missing at last scan and cannot be selected">/);
    expect(res2.text).toContain('Missing at last scan');
  });

  it('wraps long filenames safely in grid cards', async () => {
    const res = await createProject('Grid Long Filename');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Long Filename');
    const filename = 'this-is-a-very-long-grid-card-filename-that-must-wrap-without-expanding-the-layout.png';
    writeIndexedAsset(id, projectDir, filename, await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
    expect(res2.text).toContain(filename);

    const style = await readStylesheetSource(res2.text);
    expect(style).toMatch(/\.asset-card-title-text\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
  });

  it('renders a full-row native category picker with counts before Search and places Manage Categories after Clear selection', async () => {
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
    const filterFormStart = res2.text.indexOf('<form class="filters asset-viewer-filters asset-viewer-filters--project-assets"');
    expect(displayControlsStart).toBeGreaterThanOrEqual(0);
    expect(filterActionsStart).toBeGreaterThan(displayControlsStart);
    expect(filterFormStart).toBeGreaterThan(filterActionsStart);

    const filterActions = res2.text.slice(filterActionsStart, filterFormStart);
    expect(filterActions).toContain('data-slideshow-trigger');
    expect(filterActions).toContain('data-project-assets-reset');
    expect(res2.text).toContain('<noscript>');
    expect(res2.text).toContain('<button class="button button-primary" type="submit" form="asset-filters">Filter</button>');

    const defaultsLink = res2.text.match(/<a class="[^"]*\basset-viewer-defaults-link\b[^"]*"[\s\S]*?<\/a>/)?.[0];
    expect(defaultsLink).toBeDefined();
    expect(defaultsLink).toContain('asset-tooltip');
    expect(defaultsLink).toContain('asset-tooltip--left');
    expect(defaultsLink).toContain(`href="/projects/${id}/assets?defaults=1"`);
    expect(defaultsLink).toContain('aria-label="Project Assets defaults"');
    expect(defaultsLink).toContain('data-tooltip="Project Assets defaults"');
    expect(defaultsLink).not.toContain('title=');
    expect(defaultsLink).toContain('aria-hidden="true"');

    const filterForm = res2.text.match(/<form class="filters asset-viewer-filters asset-viewer-filters--project-assets" method="get" action="\/projects\/\d+\/assets" id="asset-filters">[\s\S]*?<\/form>/)?.[0];
    expect(filterForm).toBeDefined();
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
    expect(filterForm).toContain('id="asset-filters"');
    expect((filterForm.match(/data-cc-dropdown data-cc-dropdown-mode="(?:single|multiple)"/g) || [])).toHaveLength(7);
    expect(filterForm).not.toContain('data-asset-viewer-filter-disclosure');
    expect(filterForm).not.toContain('data-asset-action-select');
    expect(filterForm).not.toContain('>Filter</button>');
    expect(filterForm).not.toMatch(/<a class="button button-secondary" href="[^"]+">Reset<\/a>/);
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
    expect(selectionControls).toMatch(
      /data-clear-selection>Clear selection<\/button>\s*<a class="button button-small button-secondary" href="[^"]*manage_categories=1"\s+data-dialog-open="project-asset-category-management-dialog">Manage Categories<\/a>/
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
    const defaultsCardMatch = style.match(/(?:^|})\s*(\.asset-viewer-filters--project-assets[^{]*)\{([^}]*)\}/);
    const defaultsCardRule = defaultsCardMatch?.[2] || '';
    expect(defaultsCardMatch?.[1]).toMatch(/\.asset-viewer-filters--asset-viewer/);
    expect(defaultsCardRule).toMatch(/padding-inline-end:\s*calc\(var\(--space-lg\) \+ 1\.6rem\)/);
    expect(defaultsCardRule).not.toMatch(/padding-top/);
    const defaultsLinkMatch = style.match(/(?:^|})\s*(\.asset-viewer-filters--project-assets\s*>\s*\.asset-viewer-defaults-link[^{]*)\{([^}]*)\}/);
    const defaultsLinkRule = defaultsLinkMatch?.[2] || '';
    expect(defaultsLinkMatch?.[1]).toMatch(/\.asset-viewer-filters--asset-viewer\s*>\s*\.asset-viewer-defaults-link/);
    expect(defaultsLinkRule).toMatch(/position:\s*absolute/);
    expect(defaultsLinkRule).toMatch(/top:\s*var\(--space-sm\)/);
    expect(defaultsLinkRule).toMatch(/right:\s*var\(--space-sm\)/);
    expect(style).toMatch(/@media\s*\(max-width:\s*540px\)[\s\S]*?\.asset-filter-multiselect-field\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/);

    const gridCards = [...res2.text.matchAll(/<article class="asset-card asset-card--project[\s\S]*?<\/article>/g)]
      .map((match) => match[0]);
    expect(gridCards).toHaveLength(3);
    for (const card of gridCards) {
      const metadata = card.match(/<dl class="asset-card-primary-metadata" aria-label="Primary metadata">[\s\S]*?<\/dl>/)?.[0] || '';
      expect(metadata).not.toBe('');
      for (const label of ['Category', 'Type', 'Size', 'Modified']) {
        expect((metadata.match(new RegExp(`<dt>${label}</dt>`, 'g')) || [])).toHaveLength(1);
      }
    }
    for (const category of ['Uncategorized', 'Renders', 'Archive']) {
      const card = gridCards.find((candidate) => candidate.includes(category));
      expect(card).toBeDefined();
      const metadata = card.match(/<dl class="asset-card-primary-metadata" aria-label="Primary metadata">[\s\S]*?<\/dl>/)?.[0] || '';
      expect(metadata).toContain(category);
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

  it('selecting a concrete category renders its complete membership and ignores pagination', async () => {
    const res = await createProject('Category Filter Reset');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const cat = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    const inCat = assetRepo.upsert(id, 'renders/keep.png', {
      filename: 'keep.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: cat.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'other.png', {
      filename: 'other.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null,
    });

    const res2 = await agent.get(`/projects/${id}/assets?category=${cat.id}&page=2&pageSize=1`).expect(200);
    expect(res2.text).toContain('keep.png');
      expect(res2.text).not.toContain('other.png');
      expect(res2.text).not.toMatch(/<p class="results-meta">[\s\S]*?complete Renders category[\s\S]*?<\/p>/);
      expect(res2.text).toContain('data-auto-rename-surface');
    expect(res2.text).toMatch(/<li\b[^>]*data-auto-rename-asset[^>]*data-auto-rename-asset-id="/);
    expect(res2.text).toMatch(/<article\b[^>]*class="asset-card asset-card--project"/);
    expect(res2.text).not.toContain('data-auto-rename-drag-handle');
    expect(res2.text).toMatch(/<li\b[^>]*data-auto-rename-asset[^>]*draggable="true"[^>]*tabindex="0"/);
    expect(res2.text).toMatch(/data-auto-rename-submit[^>]*disabled/);
    expect(res2.text).toContain('data-asset-actions-panel');
      expect((res2.text.match(/data-asset-actions-panel/g) || []).length).toBe(1);
      expect(res2.text).toContain('Category actions');
      expect(res2.text).not.toMatch(/<span class="asset-actions-label">Category order<\/span>/);
      expect(res2.text).toContain('Drag assets to change their filename order');
      expect(res2.text).not.toMatch(/<span class="asset-actions-selection-label">Selected assets<\/span>/);
      const selectionControlsOnly = assetSelectionControlsHtml(res2.text);
      expect(selectionControlsOnly).not.toContain('Selected assets');
      expect(res2.text).not.toMatch(/<h2\b[^>]*>Renders assets<\/h2>/);
      expect(res2.text).toMatch(/<section class="asset-auto-rename-surface" data-auto-rename-surface data-auto-rename-view="grid"\s+aria-label="Renders assets">/);
      const completeActionPanelStart = res2.text.indexOf('<div class="asset-actions-panel" data-asset-actions-panel>');
      const completeAssetListStart = res2.text.indexOf('<ul class="asset-grid"', completeActionPanelStart);
      const completeActionPanel = res2.text.slice(completeActionPanelStart, completeAssetListStart);
      expect(completeActionPanel).toMatch(/<div class="asset-actions-category-copy">\s*<span class="asset-actions-label">Category actions<\/span>\s*<span class="asset-actions-helper">Drag assets to change their filename order<\/span>\s*<\/div>/);
      expect((completeActionPanel.match(/<span class="asset-actions-label">Category actions<\/span>/g) || [])).toHaveLength(1);
      const categoryHeaderStart = completeActionPanel.indexOf('<div class="asset-actions-category-copy">');
      const releaseActionsHeadingStart = completeActionPanel.indexOf('<h3 class="asset-action-group-heading">Release</h3>');
      const categoryFileActionsHeadingStart = completeActionPanel.indexOf('<h3 class="asset-action-group-heading">File</h3>');
      expect(categoryHeaderStart).toBeGreaterThan(-1);
      expect(categoryHeaderStart).toBeLessThan(releaseActionsHeadingStart);
      expect(categoryHeaderStart).toBeLessThan(categoryFileActionsHeadingStart);
      expect(completeActionPanel).not.toContain('asset-selection-header');
      expect(completeActionPanel).toContain('data-selected-count');
      expect(completeActionPanel).toContain('data-select-all');
      expect(completeActionPanel).toContain('data-clear-selection');
      expect((completeActionPanel.match(/<section class="asset-action-group">[\s\S]*?<\/section>/g) || [])).toHaveLength(2);
    expect(completeActionPanel).toContain('<h3 class="asset-action-group-heading">Release</h3>');
    expect(completeActionPanel).toContain('<h3 class="asset-action-group-heading">File</h3>');
      expect(completeActionPanel).toMatch(/<select id="releaseId-action-native" name="releaseId" class="cc-dropdown-native-select" data-cc-dropdown-native-select[\s\S]*?data-release-select>/);
      expect(completeActionPanel).toMatch(/<select id="destinationCategory-action-native" name="destinationCategory" class="cc-dropdown-native-select" data-cc-dropdown-native-select/);
      expect((completeActionPanel.match(/data-cc-dropdown data-cc-dropdown-mode="single"/g) || [])).toHaveLength(2);
      expect(completeActionPanel).toMatch(/<details class="asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown" id="releaseId-action"[\s\S]*?data-cc-dropdown-mode="single"[\s\S]*?hidden>/);
      expect(completeActionPanel).toContain('data-cc-dropdown-summary-current');
      expect(completeActionPanel).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Release options"');
      expect(completeActionPanel).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Destination category options"');
      expect(completeActionPanel).not.toContain('data-asset-action-select');
      expect(completeActionPanel).not.toMatch(/<details[^>]*>\s*<summary[^>]*>\s*Release/);
      expect(completeActionPanel).not.toMatch(/<details[^>]*>\s*<summary[^>]*>\s*File/);
      expect(completeActionPanel).toContain('data-release-select');
      expect(completeActionPanel).toContain('name="destinationCategory"');
      expect(completeActionPanel).toContain(`formaction="/projects/${id}/assets/create-release"`);
      expect(completeActionPanel).toContain(`formaction="/projects/${id}/assets/move-selected"`);
      expect(completeActionPanel).toMatch(/<button[^>]*form="bulk-select-form"[^>]*data-select-all[^>]*>Select all visible<\/button>/);
      expect(completeActionPanel).toMatch(/<button[^>]*form="bulk-select-form"[^>]*data-clear-selection[^>]*>Clear selection<\/button>/);
      expect(completeActionPanel).toContain('data-auto-rename-form');
      expect(completeActionPanel).toContain('data-auto-rename-submit');
      expect(completeActionPanel).toContain(`name="categoryId" value="${cat.id}"`);
      expect(completeActionPanel).toContain('name="orderedAssetIds"');
      expect(completeActionPanel).toContain('name="selectedAssetIds" value="[]"');
      expect(completeActionPanel).toContain('data-asset-selection-form');
      expect(completeActionPanel).toMatch(/<button type="submit" class="button button-primary button-small"[^>]*data-auto-rename-submit[^>]*>Auto Rename<\/button>/);
      expect(completeActionPanel).toMatch(/<button type="button" class="button button-small"[^>]*data-select-all[^>]*>Select all visible<\/button>/);
      expect(completeActionPanel).toMatch(/<button type="button" class="button button-small button-secondary"[^>]*data-clear-selection[^>]*>Clear selection<\/button>/);
      const completeSelectionControls = assetSelectionControlsHtml(completeActionPanel);
      expect(completeSelectionControls).not.toBe('');
      const topControlOrder = [
        'data-auto-rename-submit',
        'data-select-all',
        'data-clear-selection',
        'data-dialog-open="project-asset-category-management-dialog"',
        'class="selected-count-row"',
      ].map((marker) => completeSelectionControls.indexOf(marker));
      expect(topControlOrder.every((position) => position >= 0)).toBe(true);
      expect(topControlOrder[0]).toBeLessThan(topControlOrder[1]);
      expect(topControlOrder[1]).toBeLessThan(topControlOrder[2]);
      expect(topControlOrder[2]).toBeLessThan(topControlOrder[3]);
      expect(topControlOrder[3]).toBeLessThan(topControlOrder[4]);
      expect(completeSelectionControls).toMatch(
        /data-clear-selection>Clear selection<\/button>\s*<a class="button button-small button-secondary" href="[^"]*manage_categories=1"\s+data-dialog-open="project-asset-category-management-dialog">Manage Categories<\/a>/
      );
      expect(res2.text).not.toContain('Selection applies to this page');

      const ordinaryResponse = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
      const ordinaryActionPanel = assetActionsPanelHtml(ordinaryResponse.text);
      expect(ordinaryActionPanel).toContain('<div class="asset-actions-panel asset-actions-panel--selection-only" data-asset-actions-panel>');
      expect(ordinaryActionPanel).toContain('<span class="asset-actions-label">Category actions</span>');
      expect((ordinaryActionPanel.match(/<span class="asset-actions-label">Category actions<\/span>/g) || [])).toHaveLength(1);
      expect(ordinaryActionPanel).toContain('Drag assets to change their filename order');
      expect(ordinaryActionPanel).toContain('<h3 class="asset-action-group-heading">Release</h3>');
      expect(ordinaryActionPanel).toContain('<h3 class="asset-action-group-heading">File</h3>');
      const ordinarySelectionControls = assetSelectionControlsHtml(ordinaryActionPanel);
      expect(ordinarySelectionControls).toMatch(
        /data-clear-selection>Clear selection<\/button>\s*<a class="button button-small button-secondary" href="[^"]*manage_categories=1"\s+data-dialog-open="project-asset-category-management-dialog">Manage Categories<\/a>/
      );
    expect(res2.text).toContain('<form class="filters asset-viewer-filters asset-viewer-filters--project-assets" method="get" action="/projects/' + id + '/assets" id="asset-filters">');
    expect(res2.text).toContain('id="search" name="search"');
    expect(res2.text).toMatch(new RegExp(`<input id="asset-category-option-${cat.id}"[^>]*value="${cat.id}"[\\s\\S]*?checked>`));
    expectCheckedAssetFilter(res2.text, 'sort', 'filename');
    expectCheckedAssetFilter(res2.text, 'order', 'asc');
    expect(res2.text).not.toContain('auto-rename-assets-toolbar');
    expect(res2.text).not.toContain('bulk-toolbar');
    expect(res2.text).not.toContain('Move Up');
    expect(res2.text).not.toContain('Move Down');
    expect(res2.text).not.toContain('pagination-info');

    const listResponse = await agent.get(`/projects/${id}/assets?category=${cat.id}&view=list`).expect(200);
    const listCard = assetListCardHtml(listResponse.text, inCat.id);
    expect(listResponse.text).toContain('<ul class="asset-list asset-list--project" role="list" aria-label="Project assets" data-list-size="large">');
    expect(listCard).toMatch(new RegExp(`<article class="asset-list-card asset-list-card--project" data-asset-id="${inCat.id}" data-asset-selectable-card aria-selected="false">`));
    expect(listResponse.text).not.toContain('<table class="data-table asset-table">');
    expect(listResponse.text).not.toContain('asset-auto-rename-order-cell');
    expect(listCard).toContain(`name="selectedAssetIds" value="${inCat.id}"`);
    expect(listCard).toContain(`action="/projects/${id}/assets/${inCat.id}/rename"`);
    expect(listCard).toContain('class="asset-card-rename-editor" data-asset-rename-editor');
    expect(listCard).toContain('data-asset-rename-trigger');
    expect(listCard).not.toContain('row-rename-form');
    expect(listCard).not.toContain('asset-list-card-actions');
    expect(listResponse.text).toMatch(new RegExp(`<li\\b[^>]*data-auto-rename-asset[^>]*data-auto-rename-asset-id="${inCat.id}"[\\s\\S]*?data-auto-rename-initial-index="0"[\\s\\S]*?draggable="true"[\\s\\S]*?tabindex="0"[\\s\\S]*?aria-posinset="1"[\\s\\S]*?aria-setsize="1"`));
    expect(listCard).toContain('data-auto-rename-order-indicator');
    expect(listResponse.text).not.toContain('data-auto-rename-drag-handle');
    expect(listResponse.text).not.toContain('Move Up');
    expect(listResponse.text).not.toContain('Move Down');
    expect(inCat.id).toBeGreaterThan(0);
  });

  it('places the selected count beneath one shared selection-controls contract on both asset surfaces', async () => {
    const res = await createProject('Selected Count Placement Contract');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    assetRepo.upsert(id, 'renders/category.png', {
      filename: 'category.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: category.id, nestedPath: '',
    });
    assetRepo.upsert(id, 'root.png', {
      filename: 'root.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null,
    });

    const surfaces = [
      { response: await agent.get(`/projects/${id}/assets`).expect(200), autoRename: false },
      { response: await agent.get(`/projects/${id}/assets?category=${category.id}`).expect(200), autoRename: true },
    ];

    for (const { response, autoRename } of surfaces) {
      const controls = assetSelectionControlsHtml(response.text);
      expect(controls).not.toContain('Selected assets');
      expect(controls).not.toBe('');
      expect((controls.match(/class="asset-selection-controls-area"/g) || [])).toHaveLength(1);
      expect((controls.match(/class="asset-selection-buttons-row"/g) || [])).toHaveLength(1);
      expect((controls.match(/class="selected-count-row"/g) || [])).toHaveLength(1);
      expect(controls).toContain('data-selected-count');
      expect(controls).toContain('data-selected-total=');

      const buttonsRow = controls.indexOf('class="asset-selection-buttons-row"');
      const selectAll = controls.indexOf('data-select-all');
      const clear = controls.indexOf('data-clear-selection');
      const countRow = controls.indexOf('class="selected-count-row"');
      expect(selectAll).toBeGreaterThan(buttonsRow);
      expect(clear).toBeGreaterThan(selectAll);
      expect(countRow).toBeGreaterThan(clear);
      expect(controls.indexOf('class="selected-count"')).toBeGreaterThan(countRow);
      if (autoRename) expect(controls.indexOf('data-auto-rename-submit')).toBeGreaterThan(buttonsRow);
      else expect(controls).not.toContain('data-auto-rename-submit');
    }

    const style = await readStylesheetSource(surfaces[0].response.text);
    const controlsAreaRule = style.match(/(?:^|})\s*\.asset-selection-controls-area\s*\{([^}]*)\}/)?.[1] || '';
    const buttonsRowRule = style.match(/(?:^|})\s*\.asset-selection-buttons-row\s*\{([^}]*)\}/)?.[1] || '';
    const countRowRule = style.match(/(?:^|})\s*\.selected-count-row\s*\{([^}]*)\}/)?.[1] || '';
    const selectionOnlyRule = style.match(/(?:^|})\s*\.asset-actions-panel--selection-only\s+\.asset-actions-controls\s*\{([^}]*)\}/)?.[1] || '';
    expect(controlsAreaRule).toMatch(/align-items:\s*flex-end/);
    expect(buttonsRowRule).toMatch(/justify-content:\s*flex-end/);
    expect(countRowRule).toMatch(/align-self:\s*flex-end/);
    expect(countRowRule).toMatch(/text-align:\s*right/);
    expect(selectionOnlyRule).toMatch(/margin-inline-start:\s*auto/);
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
    expect(actionPanel).toContain('<div class="asset-actions-panel asset-actions-panel--selection-only" data-asset-actions-panel>');
    expect(actionPanel).toContain('<span class="asset-actions-label">Category actions</span>');
    expect((actionPanel.match(/<span class="asset-actions-label">Category actions<\/span>/g) || [])).toHaveLength(1);
    expect(actionPanel).toContain('Drag assets to change their filename order');
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
    expect(modifiedActionPanel).toContain('<div class="asset-actions-panel asset-actions-panel--selection-only" data-asset-actions-panel>');
    expect(modifiedActionPanel).toContain('<span class="asset-actions-label">Category actions</span>');
    expect((modifiedActionPanel.match(/<span class="asset-actions-label">Category actions<\/span>/g) || [])).toHaveLength(1);
    expect(modifiedActionPanel).toContain('Drag assets to change their filename order');
    expect(modifiedActionPanel).toContain('<h3 class="asset-action-group-heading">Release</h3>');
    expect(modifiedActionPanel).toContain('<h3 class="asset-action-group-heading">File</h3>');

    const disabledResponse = await agent
      .get(`/projects/${id}/assets?category=${disabledCategory.id}`)
      .expect(200);
    const disabledActionPanel = assetActionsPanelHtml(disabledResponse.text);
    expect(disabledActionPanel).toContain('<div class="asset-actions-panel asset-actions-panel--selection-only" data-asset-actions-panel>');
    expect(disabledActionPanel).toContain('<span class="asset-actions-label">Category actions</span>');
    expect((disabledActionPanel.match(/<span class="asset-actions-label">Category actions<\/span>/g) || [])).toHaveLength(1);
    expect(disabledActionPanel).toContain('Drag assets to change their filename order');

    for (const categoryQuery of ['category=all', 'category=uncategorized']) {
      const ordinaryResponse = await agent.get(`/projects/${id}/assets?${categoryQuery}`).expect(200);
      const ordinaryActionPanel = assetActionsPanelHtml(ordinaryResponse.text);
      expect(ordinaryActionPanel).toContain('<div class="asset-actions-panel asset-actions-panel--selection-only" data-asset-actions-panel>');
      expect(ordinaryActionPanel).toContain('<span class="asset-actions-label">Category actions</span>');
      expect((ordinaryActionPanel.match(/<span class="asset-actions-label">Category actions<\/span>/g) || [])).toHaveLength(1);
      expect(ordinaryActionPanel).toContain('Drag assets to change their filename order');
    }
  });

  // ─── Filename / location / category presentation ────────────────

  it('shows the four required filename+location+category presentations', async () => {
    const res = await createProject('Location Contract');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const exportsCat = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Exports', directorySlug: 'my-exports', displayOrder: 0, enabled: true,
    });
    const sourceCat = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Source', directorySlug: 'my-source', displayOrder: 1, enabled: true,
    });

    // Categorized nested asset.
    const final = assetRepo.upsert(id, 'exports/web/social/final.png', {
      filename: 'final.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: exportsCat.id, nestedPath: 'web/social',
    });
    // Category-root asset.
    const artwork = assetRepo.upsert(id, 'source/artwork.kra', {
      filename: 'artwork.kra', extension: 'kra', mimeType: 'application/x-krita',
      sizeBytes: 10, modifiedAt: null, categoryId: sourceCat.id, nestedPath: '',
    });
    // Uncategorized project-root asset.
    const notes = assetRepo.upsert(id, 'notes.txt', {
      filename: 'notes.txt', extension: 'txt', mimeType: 'text/plain',
      sizeBytes: 10, modifiedAt: null,
    });
    // Uncategorized asset under an unknown nested directory.
    const unknown = assetRepo.upsert(id, 'unknown/deep/file.txt', {
      filename: 'file.txt', extension: 'txt', mimeType: 'text/plain',
      sizeBytes: 10, modifiedAt: null, nestedPath: 'unknown/deep',
    });

    const res2 = await agent.get(`/projects/${id}/assets?pageSize=100&view=list`).expect(200);
    const html = res2.text;

    const finalCard = assetListCardHtml(html, final.id);
    const notesCard = assetListCardHtml(html, notes.id);
    const unknownCard = assetListCardHtml(html, unknown.id);
    const expectListPresentation = (card, filename, location, category) => {
      expect(card).not.toBe('');
      const title = card.match(/<h2 class="asset-list-card-title">([\s\S]*?)<\/h2>/)?.[1] || '';
      expect(title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).toBe(filename);
      expect(title).not.toMatch(/<a\b/);
      expect(anchorHref(card, 'asset-details-link')).not.toBeNull();
      expect(card).toContain(location);
      expect(card).toContain(category);

      const filenameIndex = card.indexOf('<h2 class="asset-list-card-title">');
      const locationIndex = card.indexOf('data-asset-containing-location');
      const categoryIndex = card.indexOf('asset-list-card-meta--category');
      expect(filenameIndex).toBeGreaterThanOrEqual(0);
      expect(locationIndex).toBeGreaterThanOrEqual(0);
      expect(categoryIndex).toBeGreaterThanOrEqual(0);
      expect(filenameIndex).toBeLessThan(locationIndex);
      expect(locationIndex).toBeLessThan(categoryIndex);
    };

    expectListPresentation(finalCard, 'final', 'web/social', 'Exports');
    expectListPresentation(notesCard, 'notes', 'Project root', 'Uncategorized');
    expectListPresentation(unknownCard, 'file', 'unknown/deep', 'Uncategorized');

    // A categorized asset sitting at its category root has no useful
    // secondary location beyond the category label — the placeholder
    // dash is gone and the .asset-location element is omitted entirely.
    const artworkCard = assetListCardHtml(html, artwork.id);
    expect(artworkCard).not.toBe('');
    expect(artworkCard).not.toContain('asset-location');
    expect(artworkCard).toContain('Source');

    expect(html).toContain('aria-label="Select exports/web/social/final.png"');
    expect(html).toContain('aria-label="Select source/artwork.kra"');
    expect(html).toContain('aria-label="Select unknown/deep/file.txt"');
  });

  // ─── Presence ─────────────────────────────────────────────────────

  it('present rows say exactly "Present" and missing rows say "Missing at last scan", with no media URL for missing rows', async () => {
    const res = await createProject('Presence Text');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Presence Text');
    writeIndexedAsset(id, projectDir, 'present.png', await makePng());
    const missing = writeIndexedAsset(id, projectDir, 'missing.png', await makePng());
    assetRepo.markMissingByProjectIdAndPathNotIn(id, ['present.png']);

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('aria-label="Present"');
    expect(res2.text).toContain('aria-label="Missing at last scan"');
    expect(res2.text).not.toContain(`/projects/${id}/assets/${missing.id}/thumbnail`);
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

  it('renders zero, one (with role), and multiple (with details) release usage summaries', async () => {
    const res = await createProject('Release Summaries');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Release Summaries');
    const none = writeIndexedAsset(id, projectDir, 'none.png', await makePng());
    const single = writeIndexedAsset(id, projectDir, 'single.png', await makePng());
    const multi = writeIndexedAsset(id, projectDir, 'multi.png', await makePng());

    const relA = await createReleaseUsingAsset(id, single.id, 'Solo Release', 'planned');
    await createReleaseUsingAsset(id, multi.id, 'Release One', 'tbd');
    await createReleaseUsingAsset(id, multi.id, 'Release Two', 'tbd');

    const res2 = await agent.get(`/projects/${id}/assets?pageSize=100&view=list`).expect(200);
    const html = res2.text;
    const noneCard = assetListCardHtml(html, none.id);
    const singleCard = assetListCardHtml(html, single.id);
    const multiCard = assetListCardHtml(html, multi.id);

    expect(noneCard).not.toBe('');
    expect(singleCard).not.toBe('');
    expect(multiCard).not.toBe('');
    expect(html).toMatch(/none[\s\S]{0,900}Not used by a release/);
    expect(html).toMatch(new RegExp(`single\\.png[\\s\\S]{0,900}Solo Release[\\s\\S]{0,200}Attachment`));
    expect(multiCard).toContain('<details class="release-usage-details asset-usage-details asset-list-card-release-membership"');
    expect(html).toContain('aria-label="Used in 2 releases"');
    expect(html).toContain('Release One');
    expect(html).toContain('Release Two');
    expect(html).toContain(`/releases/${relA}`);
    expect(html).toContain('aria-label="Used in release Solo Release (Attachment)"');
    expect(html).not.toContain('()');
    expect(multiCard).toMatch(/<div class="asset-list-card-header asset-list-card-identity"[\s\S]*?asset-list-card-status[\s\S]*?asset-indicator--present[\s\S]*?asset-list-card-release-usage[\s\S]*?asset-indicator--used[\s\S]*?asset-details-link asset-tooltip asset-tooltip--right/);
    expect(singleCard).toContain('class="asset-list-card-release-link"');
    expect(singleCard).toContain('>Solo Release</a>');
    expect(multiCard).toContain('data-asset-release-membership');
    expect(multiCard).toContain('class="asset-list-card-release-link"');
    expect(multiCard).toContain('>Release One</a>');
    expect(multiCard).toContain('>Release Two</a>');
    expect(noneCard).not.toContain('asset-list-card-association--releases');
    expect(none.id).toBeGreaterThan(0);
  });

  // ─── Accessibility ───────────────────────────────────────────────

  it('conveys disabled categories with visible text, not color alone', async () => {
    const res = await createProject('Disabled Text Only');
    const id = Number(res.headers.location.replace('/projects/', ''));
    assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Old Stuff', directorySlug: 'old-stuff', displayOrder: 0, enabled: false,
    });

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('>Old Stuff (0) <em class="asset-category-disabled-marker">(disabled)</em></span>');
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
    it('renders an enabled checkbox for present assets and a disabled one for missing assets, each with a relative-path label', async () => {
      const res = await createProject('Selection Markup');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Selection Markup');
      const present = writeIndexedAsset(id, projectDir, 'nested/present.png', await makePng());
      const missing = writeIndexedAsset(id, projectDir, 'gone.png', await makePng());
      assetRepo.markMissingByProjectIdAndPathNotIn(id, ['nested/present.png']);

      const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
      const html = res2.text;

      expect(html).toContain(`<input type="checkbox" form="bulk-select-form" id="asset-list-card-select-${present.id}" name="selectedAssetIds" value="${present.id}"`);
      expect(html).toContain('aria-label="Select nested/present.png"');
      expect(html).toContain('aria-label="gone.png is missing at last scan and cannot be selected"');
      const presentCard = assetListCardHtml(html, present.id);
      expect(presentCard).toContain('data-asset-selectable-card');
      expect(presentCard).toContain('aria-selected="false"');
      // The missing card's checkbox is disabled and carries no selectable value/name.
      const missingCard = assetListCardHtml(html, missing.id);
      expect(missingCard).not.toBe('');
      expect(missingCard).toContain('<input type="checkbox" id="asset-list-card-select-');
      expect(missingCard).toContain('disabled');
      expect(missingCard).not.toContain('name="selectedAssetIds"');
      expect(missingCard).not.toContain('data-asset-selectable-card');
      expect(missing.id).toBeGreaterThan(0);
    });

    it('renders selected grid state from server-submitted checkbox values', async () => {
      const res = await createProject('Selection Selected State');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Selection Selected State');
      const asset = writeIndexedAsset(id, projectDir, 'selected.png', await makePng());

      const rejected = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ selectedAssetIds: String(asset.id), _csrf: csrfToken })
        .expect(422);

      expect(rejected.text).toMatch(new RegExp(`class="asset-card asset-card--project is-selected"\\s+data-asset-id="${asset.id}"`));
      expect(rejected.text).toContain(`name="selectedAssetIds" value="${asset.id}"`);
      expect(rejected.text).toContain('checked');
    });

    it('renders selected project list-card state from server-submitted checkbox values', async () => {
      const res = await createProject('List Selected State');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('List Selected State');
      const asset = writeIndexedAsset(id, projectDir, 'selected.png', await makePng());

      const rejected = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ selectedAssetIds: String(asset.id), view: 'list', _csrf: csrfToken })
        .expect(422);

      const card = assetListCardHtml(rejected.text, asset.id);
      expect(card).toMatch(new RegExp(`class="asset-list-card asset-list-card--project is-selected" data-asset-id="${asset.id}" data-asset-selectable-card aria-selected="true"`));
      expect(card).toContain('class="asset-selection-control is-selected"');
      expect(card).toMatch(/<input type="checkbox"[^>]*checked>/);
    });

    it('omits the removed selection-scope text', async () => {
      const res = await createProject('Selection Scope Text Removed');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Selection Scope Text Removed');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res2.text).not.toContain('Selection applies to this page.');
    });

    it('the bulk form posts to add-to-release, uses POST, and carries a CSRF token', async () => {
      const res = await createProject('Bulk Form Shape');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Bulk Form Shape');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      const formMatch = res2.text.match(/<form id="bulk-select-form" method="post" action="\/projects\/\d+\/assets\/add-to-release"[^>]*>[\s\S]*?<input type="hidden" name="_csrf" value="[^"]+">/);
      expect(formMatch).not.toBeNull();
      expect(formMatch[0]).toContain(`action="/projects/${id}/assets/add-to-release"`);
    });

    it('groups selected-asset actions with Copy and Delete in File', async () => {
      const res = await createProject('Grouped Selected Actions');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Grouped Selected Actions');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      for (const view of ['list', 'grid']) {
        const res2 = await agent.get(`/projects/${id}/assets?view=${view}`).expect(200);
        const form = res2.text.match(/<form id="bulk-select-form"[\s\S]*?<\/form>/)?.[0];
        expect(form).toBeDefined();
        expect(form).not.toContain('asset-selection-header');
        const selectionControls = assetSelectionControlsHtml(res2.text);
        expect(selectionControls).not.toBe('');
        expect(selectionControls).toContain('data-selected-count');
        expect(selectionControls).not.toMatch(/<span class="asset-actions-selection-label">Selected assets<\/span>/);
        expect(selectionControls).toContain('role="group" aria-label="Selection controls"');
        expect(selectionControls.indexOf('data-select-all')).toBeLessThan(selectionControls.indexOf('data-clear-selection'));
        expect(selectionControls.indexOf('data-clear-selection')).toBeLessThan(selectionControls.indexOf('class="selected-count-row"'));
        expect(res2.text.indexOf('class="asset-selection-controls-area"')).toBeLessThan(res2.text.indexOf('class="asset-selection-controls"'));
        expect((form.match(/class="asset-action-group"/g) || []).length).toBe(2);
        expect(form).toMatch(/<h3 class="asset-action-group-heading">Release<\/h3>/);
        expect(form).toMatch(/<h3 class="asset-action-group-heading">File<\/h3>/);
        expect(form).toMatch(/<select id="releaseId-action-native" name="releaseId" class="cc-dropdown-native-select" data-cc-dropdown-native-select[\s\S]*?data-release-select>/);
        expect(form).toMatch(/<select id="destinationCategory-action-native" name="destinationCategory" class="cc-dropdown-native-select" data-cc-dropdown-native-select/);
        expect((form.match(/data-cc-dropdown data-cc-dropdown-mode="single"/g) || [])).toHaveLength(2);
        expect(form).toMatch(/<details class="asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown" id="releaseId-action"[\s\S]*?data-cc-dropdown-mode="single"[\s\S]*?hidden>/);
        expect(form).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Release options"');
        expect(form).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Destination category options"');
        expect(form).not.toContain('data-asset-action-select');
        expect(form).toContain('data-release-select');
        expect(form).toContain('name="destinationCategory"');
        expect(form).toContain(`formaction="/projects/${id}/assets/move-selected"`);
        expect(form).toMatch(new RegExp(`formaction="/projects/${id}/assets/move-selected"[^>]*>Move<\\/button>`));
        expect(form).toMatch(new RegExp(`formaction="/projects/${id}/assets/copy-selected">Copy<\\/button>`));

        const actionGroups = form.match(/<section class="asset-action-group">[\s\S]*?<\/section>/g) || [];
        const releaseActions = actionGroups.find((group) => group.includes('>Release</h3>'));
        const categoryFileActions = actionGroups.find((group) => group.includes('>File</h3>'));
        expect(actionGroups).toHaveLength(2);
        expect(releaseActions).toBeDefined();
        expect(categoryFileActions).toBeDefined();
        expect(releaseActions).not.toMatch(/<details[^>]*>\s*<summary[^>]*>\s*Release/);
        expect(categoryFileActions).not.toMatch(/<details[^>]*>\s*<summary[^>]*>\s*File/);
        expect(releaseActions).not.toContain('data-asset-viewer-filter-disclosure');
        expect(categoryFileActions).not.toContain('data-asset-viewer-filter-disclosure');
        expect(releaseActions).toMatch(/<select id="releaseId-action-native" name="releaseId" class="cc-dropdown-native-select" data-cc-dropdown-native-select[\s\S]*?data-release-select>/);
        expect(categoryFileActions).toMatch(/<select id="destinationCategory-action-native" name="destinationCategory" class="cc-dropdown-native-select" data-cc-dropdown-native-select/);
        expect(releaseActions).toMatch(/<option value=""[^>]*>Select a release…<\/option>/);
        expect(categoryFileActions).toContain('value="uncategorized"');
        expect(releaseActions).toMatch(/<button[^>]*data-bulk-submit[^>]*>Add<\/button>/);
        expect(releaseActions).toMatch(new RegExp(`formaction="/projects/${id}/assets/create-release">New<\\/button>`));
        expect(categoryFileActions).toMatch(new RegExp(`formaction="/projects/${id}/assets/delete-selected"[\\s\\S]*>Delete<\\/button>`));
        expect(categoryFileActions).not.toContain('data-release-select');
        expect(releaseActions).not.toMatch(/<button[^>]*data-bulk-submit[^>]*>Add selected to release<\/button>/);
        expect(categoryFileActions).not.toMatch(/formaction="[^"]*\/move-selected"[^>]*>Move selected<\/button>/);
        expect(categoryFileActions).not.toMatch(/formaction="[^"]*\/copy-selected"[^>]*>Copy selected<\/button>/);
        expect(categoryFileActions).not.toMatch(/formaction="[^"]*\/delete-selected"[^>]*>Delete selected<\/button>/);

        const style = await readStylesheetSource(res2.text);
        expect(style).toMatch(/\.asset-action-groups\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
        expect(style).toMatch(/\.asset-action-group-controls\s*\{[^}]*flex-wrap:\s*wrap/);
        expect(style).toMatch(/\.asset-action-groups\s*\{[^}]*grid-template-columns:\s*1fr/);
        expect(style).not.toContain('asset-action-disclosure');
        const actionGroupRule = style.match(/(?:^|})\s*\.asset-action-group\s*\{([^}]*)\}/)?.[1] || '';
        expect(actionGroupRule).toMatch(/border:\s*1px solid var\(--border-strong\)/);
        expect(actionGroupRule).toMatch(/border-radius:\s*var\(--radius-md\)/);
        expect(actionGroupRule).toMatch(/background:\s*var\(--surface-card\)/);
        const sharedTriggerRule = style.match(/(?:^|})\s*\.asset-filter-multiselect summary\s*\{([^}]*)\}/)?.[1] || '';
        expect(sharedTriggerRule).toMatch(/min-height:\s*2\.5rem/);
        expect(sharedTriggerRule).toMatch(/padding:\s*var\(--space-sm\)/);
        expect(sharedTriggerRule).toMatch(/border:\s*1px solid var\(--border\)/);
        expect(sharedTriggerRule).toMatch(/border-radius:\s*0\.375rem/);
        expect(sharedTriggerRule).toMatch(/background:\s*var\(--bg\)/);
        expect(sharedTriggerRule).toMatch(/color:\s*var\(--text\)/);
        expect(sharedTriggerRule).toMatch(/font-size:\s*1rem/);
        expect(sharedTriggerRule).toMatch(/font-weight:\s*400/);
        expect(sharedTriggerRule).toMatch(/line-height:\s*1\.6/);
        expect(style).not.toMatch(/\.asset-action-select\s*\{/);
        expect(style).not.toContain('asset-action-select');
        expect(style).toMatch(/\.asset-filter-multiselect summary::after\s*\{[\s\S]*?color:\s*var\(--muted\)[\s\S]*?content:\s*'▾'/);
        expect(style).toMatch(/\.asset-filter-multiselect summary:hover\s*\{[\s\S]*?border-color:\s*var\(--border-strong\)[\s\S]*?background:\s*var\(--surface-hover\)/);
        expect(style).toMatch(/\.asset-filter-multiselect summary:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);

        const extensionFilter = assetExtensionFilterHtml(res2.text);
        expect(extensionFilter).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
        expect(extensionFilter).toContain('aria-controls="asset-extension-filter-options"');
        expect(extensionFilter).toContain('class="asset-filter-multiselect-panel"');
      }
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
      expect(res2.text).toContain(`value="${asset.id}"`);
      expect(res2.text).toContain('checked');
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

    it('controlled rejection when the submitted release belongs to another project', async () => {
      const res = await createProject('Bulk Cross Project Release');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Cross Project Release');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());

      const otherRes = await createProject('Bulk Cross Project Release Other');
      const otherId = Number(otherRes.headers.location.replace('/projects/', ''));
      const otherReleaseId = await createEmptyRelease(otherId, 'Foreign Release');

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(otherReleaseId), selectedAssetIds: String(asset.id), _csrf: csrfToken })
        .expect(404);

      expect(res2.text).not.toMatch(/at .*:\d+:\d+/); // no stack trace
      expect(res2.text).not.toContain('SELECT');
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

    it('controlled rejection for a published release', async () => {
      const res = await createProject('Bulk Published Release');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Bulk Published Release');
      const primaryAsset = writeIndexedAsset(id, projectDir, 'primary.png', await makePng());
      const releaseId = await createReleaseUsingAsset(id, primaryAsset.id, 'To Publish', 'ready');
      await agent.post(`/releases/${releaseId}/publish`).send('publishedDate=2026-01-01').send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const extra = writeIndexedAsset(id, projectDir, 'extra.png', await makePng());

      const res2 = await agent
        .post(`/projects/${id}/assets/add-to-release`)
        .type('form')
        .send({ releaseId: String(releaseId), selectedAssetIds: String(extra.id), _csrf: csrfToken })
        .expect(422);

      expect(res2.text).toContain('published');
    });

    it('returns 404 for an invalid project ID', async () => {
      await agent
        .post('/projects/abc/assets/add-to-release')
        .type('form')
        .send({ releaseId: '1', selectedAssetIds: '1', _csrf: csrfToken })
        .expect(404);
    });

    // Phase: asset actions chunk 4 added rename/move/delete as real routes —
    // see the dedicated describe blocks below for their full behavior. Upload
    // and replace remain deliberately out of scope.
    it('keeps unsupported upload and replace mutation routes unavailable', async () => {
      const res = await createProject('No Filesystem Actions');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('No Filesystem Actions');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());

      for (const path_ of [
        `/projects/${id}/assets/${asset.id}/replace`,
        `/projects/${id}/assets/upload`,
      ]) {
        await agent.post(path_).type('form').send({ _csrf: csrfToken }).expect(404);
      }
    });
  });

  describe('POST /projects/:id/assets/create-release', () => {
    it('opens the normal Create Release form with the project and selected assets', async () => {
      const res = await createProject('Create Release From Assets');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Create Release From Assets');
      const first = writeIndexedAsset(id, projectDir, 'first.png', await makePng());
      const second = writeIndexedAsset(id, projectDir, 'second.png', await makePng());

      const opened = await agent
        .post(`/projects/${id}/assets/create-release`)
        .type('form')
        .send({
          selectedAssetIds: [String(second.id), String(first.id)],
          _csrf: csrfToken,
        })
        .expect(200);

      expect(opened.text).toContain('Releases — Create Release');
      expect(opened.text).toContain('<form id="release-form" method="post" action="/releases" class="project-form" novalidate>');
      expect(opened.text).toMatch(new RegExp(`name="projectId"[^>]+value="${id}" checked`));
      expect(opened.text).toContain('<input type="text" id="title" name="title" value=""');
      expect(opened.text).toContain('<textarea id="notes" name="notes" rows="6" maxlength="10000"></textarea>');

      const hiddenSelectedAssetIds = opened.text.match(
        /<input type="hidden" name="selectedAssetIds" value="\d+">/g,
      ) || [];
      expect(hiddenSelectedAssetIds).toEqual([
        `<input type="hidden" name="selectedAssetIds" value="${second.id}">`,
        `<input type="hidden" name="selectedAssetIds" value="${first.id}">`,
      ]);

      const releaseService = createReleaseService({ db });
      expect(releaseService.listReleases(id, { includeArchived: true })).toEqual([]);
    });

    it('preserves selected IDs through validation rerender and attaches them on successful create', async () => {
      const res = await createProject('Create Release Form Rerender');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Create Release Form Rerender');
      const first = writeIndexedAsset(id, projectDir, 'first.png', await makePng());
      const second = writeIndexedAsset(id, projectDir, 'second.png', await makePng());

      const invalid = await agent
        .post('/releases')
        .type('form')
        .send(`projectId=${id}`)
        .send('title=')
        .send('notes=Keep+these+notes')
        .send(`selectedAssetIds=${second.id}`)
        .send(`selectedAssetIds=${first.id}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(invalid.text).toContain('Keep these notes');
      expect((invalid.text.match(/<input type="hidden" name="selectedAssetIds" value="\d+">/g) || [])).toEqual([
        `<input type="hidden" name="selectedAssetIds" value="${second.id}">`,
        `<input type="hidden" name="selectedAssetIds" value="${first.id}">`,
      ]);
      expect(createReleaseService({ db }).listReleases(id, { includeArchived: true })).toEqual([]);

      const created = await agent
        .post('/releases')
        .type('form')
        .send(`projectId=${id}`)
        .send('title=Release With Selected Attachments')
        .send(`selectedAssetIds=${second.id}`)
        .send(`selectedAssetIds=${first.id}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const releaseId = Number(created.headers.location.split('/')[2]);

      expect(created.headers.location).toBe(`/releases/${releaseId}/assets`);
      expect(createReleaseService({ db }).listReleaseAssets(releaseId).map((asset) => ({
        asset_id: asset.asset_id,
        role: asset.role,
        sort_order: asset.sort_order,
      }))).toEqual([
        { asset_id: second.id, role: 'attachment', sort_order: 0 },
        { asset_id: first.id, role: 'attachment', sort_order: 1 },
      ]);
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

    it('rejects malformed and cross-project selections without creating a release', async () => {
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
      it('sets and replaces the selection, preserves normalized context, and ignores returnUrl', async () => {
        const first = await setupProjectWithAsset('Primary Set Success', 'first.png');
        const second = writeIndexedAsset(first.id, first.projectDir, 'second.png', await makePng());

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
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(first.id).id).toBe(first.asset.id);

        const firstViewer = await agent.get(setFirst.headers.location).expect(200);
        expect(firstViewer.text).toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
        expect(firstViewer.text).toContain('Currently set as the primary image.');
        expect(firstViewer.text).toContain('>Remove primary image</button>');

        await agent
          .post(`/projects/${first.id}/assets/${second.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(first.id).id).toBe(second.id);
      });

      it('rejects cross-project, missing, unsupported, and archived selections with controlled statuses', async () => {
        const owner = await setupProjectWithAsset('Primary Set Owner', 'owner.png');
        const other = await setupProjectWithAsset('Primary Set Other', 'other.png');

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
        expect(unsupportedRes.text).toContain('This asset type cannot be selected as the primary image.');

        const archived = await setupProjectWithAsset('Primary Set Archived', 'archived.png');
        await agent.post(`/projects/${archived.id}/archive`).send({ _csrf: csrfToken }).type('form').expect(302);
        const archivedRes = await agent
          .post(`/projects/${archived.id}/assets/${archived.asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(409);
        expect(archivedRes.text).toContain('This project is archived and read-only.');
      });

      it('reopens the rendered Edit Asset dialog after a controlled primary-image failure', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Set Edit Dialog Failure', 'source.kra');

        const failure = await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(422);

        const dialogStart = failure.text.indexOf('<dialog id="asset-edit-dialog"');
        const dialogEnd = failure.text.indexOf('</dialog>', dialogStart) + '</dialog>'.length;
        const dialogHtml = failure.text.slice(dialogStart, dialogEnd);
        expect(dialogHtml).toContain(' open');
        expect(dialogHtml).toContain('This asset type cannot be selected as the primary image.');

        // D1 regression: the controlled-failure error must render exactly
        // once, and only inside the open Edit Asset dialog.
        const occurrences = failure.text.split('This asset type cannot be selected as the primary image.').length - 1;
        expect(occurrences).toBe(1);
        const outsideDialog = failure.text.slice(0, dialogStart) + failure.text.slice(dialogEnd);
        expect(outsideDialog).not.toContain('This asset type cannot be selected as the primary image.');
      });

      it('rejects a missing CSRF token before changing the selection', async () => {
        const { id, asset } = await setupProjectWithAsset('Primary Set CSRF', 'csrf.png');

        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({})
          .expect(403);
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

        const viewer = await agent.get(removed.headers.location).expect(200);
        expect(viewer.text).toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
        expect(viewer.text).toContain('The primary image was removed.');
        expect(viewer.text).toContain('>Set as primary image</button>');
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

      it('removes a selected asset after it becomes missing', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Primary Remove Missing', 'missing.png');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        fs.rmSync(path.join(projectDir, 'missing.png'));
        await agent.post(`/projects/${id}/scan`).send({ _csrf: csrfToken }).type('form').expect(302);

        await agent
          .post(`/projects/${id}/assets/${asset.id}/primary-image/remove`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(302);
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(id)).toBeUndefined();
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

    // ─── Rename POST ─────────────────────────────────────────────────────

    describe('POST /projects/:projectId/assets/:assetId/rename', () => {
      it('renames the file successfully, redirects to the viewer for the same asset ID, and shows a success notice', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Rename Success', 'old.png');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({
            filename: 'new.png', origin: 'viewer', category: 'all', sort: 'modified', order: 'desc', view: 'list', _csrf: csrfToken,
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
        expect(fs.existsSync(path.join(projectDir, 'new.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'old.png'))).toBe(false);

        const res2 = await agent.get(res.headers.location).expect(200);
        expect(res2.text).toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
        expect(res2.text).toContain('The file was renamed.');
        expect(res2.text).toContain('value="new.png"');
      });

      it('preserves supported browser context and strips unknown fields on the redirect', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename Context', 'old.png');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', category: 'all', sort: 'modified', order: 'desc', junkField: 'strip-me', _csrf: csrfToken })
          .type('form')
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('sort')).toBe('modified');
        expect(location.searchParams.get('order')).toBe('desc');
        expect(location.searchParams.has('junkField')).toBe(false);
      });

      it('rejects an invalid filename with 422 and preserves the submitted value', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename Invalid', 'old.png');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: '..', category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(422);

        expect(res.text).toContain('Enter a valid filename.');
        expect(res.text).toContain('value=".."');
        expect(res.text).toContain('<input type="hidden" name="category" value="all">');
      });

      it('rejects filenames with Win32-forbidden characters with 422', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename Win32 Forbidden', 'old.png');

        for (const badName of ['foo<bar.png', 'foo>bar.png', 'foo:bar.png', 'foo|bar.png', 'foo?bar.png', 'foo*bar.png']) {
          const res = await agent
            .post(`/projects/${id}/assets/${asset.id}/rename`)
            .send({ filename: badName, _csrf: csrfToken })
            .type('form')
            .expect(422);
          expect(res.text).toContain('Enter a valid filename.');
        }
      });

      it('returns 409 on a destination conflict', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Rename Conflict', 'old.png');
        writeIndexedAsset(id, projectDir, 'taken.png', await makePng());

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'taken.png', _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('Destination already exists.');
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

      it('malformed project and asset IDs preserve existing not-found behavior', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename Malformed IDs', 'old.png');
        await agent.post(`/projects/abc/assets/${asset.id}/rename`).send({ filename: 'x.png', _csrf: csrfToken }).type('form').expect(404);
        await agent.post(`/projects/${id}/assets/abc/rename`).send({ filename: 'x.png', _csrf: csrfToken }).type('form').expect(404);
      });

      it('rejects a request with no CSRF token', async () => {
        const { id, asset } = await setupProjectWithAsset('Rename No CSRF', 'old.png');
        await agent.post(`/projects/${id}/assets/${asset.id}/rename`).send({ filename: 'new.png' }).type('form').expect(403);
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
      it('delegates one viewed asset to deleteAssets and redirects with normalized viewer context', async () => {
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
            category: 'all', search: 'a', extension: '.PNG', presence: 'present', usage: 'unused', edit: '1',
            sort: 'size', order: 'desc', page: '2', pageSize: '50', view: 'list',
            unknown: 'strip-me', _csrf: deleteCsrf,
          })
          .expect(302);

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
        expect(location.searchParams.has('edit')).toBe(false);
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

      it('keeps malformed IDs at 404 and renders a safe precheck error for a missing file', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Delete Missing', 'missing.png');

        await agent
          .post(`/projects/invalid/assets/${asset.id}/delete`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(404);
        await agent
          .post(`/projects/${id}/assets/invalid/delete`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(404);

        fs.rmSync(path.join(projectDir, 'missing.png'));
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

      it.each(['', '0', '-1', '5.5', '5abc', '007', 'renders', 'null', 'undefined'])(
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
      });

      it('returns a controlled 409 when the destination category directory is missing', async () => {
        const { id, asset } = await setupProjectWithAsset('Move Missing Directory');
        // Category row without ever creating its real directory on disk.
        const category = assetCategoryRepo.addProjectCategory({
          projectId: id, displayName: 'Ghost', directorySlug: 'ghost-dir', displayOrder: 0, enabled: true,
        });

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id), _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain('The destination directory is unavailable.');
      });

      it('preserves the submitted destination selection after a controlled failure', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move Preserve Selection');
        const category = assetCategoryRepo.addProjectCategory({
          projectId: id, displayName: 'Ghost', directorySlug: 'ghost-preserve', displayOrder: 0, enabled: true,
        });

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id), _csrf: csrfToken })
          .type('form')
          .expect(409);
        expect(res.text).toContain(`value="${category.id}" selected`);
        expect(res.text).toContain('<input type="hidden" name="category" value="all">');
      });

      it('preserves supported browser context and strips unknown fields on the redirect', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move Context');
        const category = makeEnabledCategory(id, projectDir, 'renders-move-context');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id), category: 'all', presence: 'present', junkField: 'strip-me', _csrf: csrfToken })
          .type('form')
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('presence')).toBe('present');
        expect(location.searchParams.has('junkField')).toBe(false);
      });

      it('rejects a request with no CSRF token', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move No CSRF');
        const category = makeEnabledCategory(id, projectDir, 'renders-move-nocsrf');
        await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id) })
          .type('form')
          .expect(403);
      });
    });

    // ─── Security / error behavior ───────────────────────────────────────

    describe('security and error behavior', () => {
      it('never renders raw filesystem paths, errno codes, or SQL messages in a controlled failure', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Security No Leak', 'ghost.png');
        fs.rmSync(path.join(projectDir, 'ghost.png'));

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/rename`)
          .send({ filename: 'new.png', _csrf: csrfToken })
          .type('form')
          .expect(409);

        expect(res.text).not.toMatch(/[A-Z]:\\/);
        expect(res.text).not.toMatch(/\/home\//);
        expect(res.text).not.toContain(tmpDir);
        expect(res.text).not.toContain('ENOENT');
        expect(res.text).not.toContain('SQLITE');
      });

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

      it('renders an eligible grid Rename form and keeps form ownership valid', async () => {
        const { id, asset } = await setupProjectWithAsset('Main Grid Rename', 'hero.png');

        const res = await agent.get(`/projects/${id}/assets?view=grid`).expect(200);
        const card = res.text.match(new RegExp(`<article class="asset-card(?: asset-card--project)?(?: is-selected)?"\\s+data-asset-id="${asset.id}"[^>]*>[\\s\\S]*?<\\/article>`));
        expect(card).not.toBeNull();
        expect(card[0]).toContain(`action="/projects/${id}/assets/${asset.id}/rename"`);
        expect(card[0]).toContain('class="asset-card-rename-editor"');
        expect(card[0]).toContain('name="origin" value="assets"');
        expect(card[0]).toContain('value="hero"');
        expect(card[0]).toContain('class="asset-rename-extension" aria-hidden="true">.png</span>');
        const editor = card[0].match(/<form[^>]*class="asset-card-rename-editor"[\s\S]*?<\/form>/)?.[0];
        expect(editor).not.toBeUndefined();
        expect(editor).toMatch(/<form[^>]*\bhidden\b[^>]*\binert\b/);
        expect(editor).toMatch(/<input type="hidden" name="_csrf"[^>]*\bdisabled\b/);
        expect(editor).toMatch(/<input type="text"[^>]*class="asset-card-rename-input"[^>]*\bdisabled\b/);
        expect(editor).toMatch(/<button[^>]*data-asset-rename-confirm[^>]*\bdisabled\b/);
        expect(editor).toMatch(/<button[^>]*data-asset-rename-cancel[^>]*\bdisabled\b/);
        expect((card[0].match(/<form\b/g) || []).length).toBe((card[0].match(/<\/form>/g) || []).length);
        expect((res.text.match(/<h1\b/g) || []).length).toBe(1);

        const bulkStart = res.text.indexOf('<form id="bulk-select-form"');
        const gridStart = res.text.search(/<ul class="asset-grid"[^>]*>/);
        expect(bulkStart).toBeGreaterThanOrEqual(0);
        expect(res.text.indexOf('</form>', bulkStart)).toBeLessThan(gridStart);
        expect(res.text).toMatch(/<input type="checkbox" form="bulk-select-form"[^>]*name="selectedAssetIds"/);
        expect(res.text).toContain('formaction="/projects/' + id + '/assets/move-selected"');
      });

      it('opens only the affected grid Rename editor after a controlled validation failure', async () => {
        const { id, assets } = await setupOrderedImageAssets('Main Grid Rename Failure');
        const res = await agent
          .post(`/projects/${id}/assets/${assets.alpha.id}/rename`)
          .type('form')
          .send({ filename: 'bad/name', origin: 'assets', category: 'all', view: 'grid', _csrf: csrfToken })
          .expect(422);

        const activeEditor = res.text.match(new RegExp(`<form method="post" action="/projects/${id}/assets/${assets.alpha.id}/rename"[\\s\\S]*?<\\/form>`))?.[0];
        expect(activeEditor).not.toBeUndefined();
        expect(activeEditor).not.toMatch(/<form[^>]*\bhidden\b/);
        expect(activeEditor).not.toMatch(/<form[^>]*\binert\b/);
        expect(activeEditor).not.toMatch(/class="asset-card-rename-input"[^>]*\bdisabled\b/);
        expect(activeEditor).toContain('value="bad/name"');

        const inactiveEditors = [...res.text.matchAll(/<form method="post" action="\/projects\/\d+\/assets\/\d+\/rename"[\s\S]*?<\/form>/g)]
          .map(([form]) => form)
          .filter((form) => !form.includes(`/assets/${assets.alpha.id}/rename`));
        expect(inactiveEditors.length).toBeGreaterThan(0);
        for (const editor of inactiveEditors) {
          expect(editor).toMatch(/<form[^>]*\bhidden\b[^>]*\binert\b/);
          expect(editor).toMatch(/<input type="text"[^>]*class="asset-card-rename-input"[^>]*\bdisabled\b/);
          expect(editor).toMatch(/<button[^>]*data-asset-rename-confirm[^>]*\bdisabled\b/);
          expect(editor).toMatch(/<button[^>]*data-asset-rename-cancel[^>]*\bdisabled\b/);
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
        expect(invalidRes.text).toContain('Enter a valid filename.');
        expect(invalidRes.text).toContain('value="bad/name"');
        expect(invalidRes.text).toContain('<input type="hidden" name="category" value="all">');
          expect(invalidRes.text).toContain('class="asset-card-rename-editor"');
        expect(invalidRes.text).not.toContain('asset-preview-section');

        const conflict = await setupProjectWithAsset('Main Rename Conflict', 'old.png');
        writeIndexedAsset(conflict.id, conflict.projectDir, 'taken.png', await makePng());
        const conflictRes = await agent
          .post(`/projects/${conflict.id}/assets/${conflict.asset.id}/rename`)
          .type('form')
          .send({ filename: 'taken', origin: 'assets', _csrf: csrfToken })
          .expect(409);
        expect(conflictRes.text).toContain('Destination already exists.');
        expect(conflictRes.text).toContain(`action="/projects/${conflict.id}/assets/${conflict.asset.id}/rename"`);
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

      it('renders Move, Copy, and Delete controls inside the bulk form with enabled categories only', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Move Form', 'a.png');
        const enabled = makeEnabledCategory(id, projectDir, 'bulk-enabled', 'Bulk Enabled');
        const categoryAsset = writeIndexedAsset(id, projectDir, 'bulk-enabled/category-file.png', await makePng());
        assetRepo.upsert(id, 'bulk-enabled/category-file.png', {
          filename: categoryAsset.filename,
          extension: categoryAsset.extension,
          mimeType: categoryAsset.mime_type,
          sizeBytes: categoryAsset.size_bytes,
          modifiedAt: categoryAsset.modified_at,
          categoryId: enabled.id,
          nestedPath: '',
        });
        assetCategoryRepo.addProjectCategory({
          projectId: id, displayName: 'Bulk Disabled', directorySlug: 'bulk-disabled', displayOrder: 1, enabled: false,
        });

        for (const query of ['', '?view=grid', `?category=${enabled.id}`]) {
          const res = await agent.get(`/projects/${id}/assets${query}`).expect(200);
          const bulk = res.text.match(/<form id="bulk-select-form"[\s\S]*?<\/form>/);
          expect(bulk).not.toBeNull();
          expect(bulk[0]).toContain('>Uncategorized</option>');
          expect(bulk[0]).toContain(`value="${enabled.id}">Bulk Enabled</option>`);
          expect(bulk[0]).not.toContain('Bulk Disabled');
          expect(bulk[0]).toContain('data-bulk-submit');
          expect(bulk[0]).toContain(`formaction="/projects/${id}/assets/move-selected"`);
          expect(bulk[0]).toMatch(new RegExp(`formaction="/projects/${id}/assets/move-selected"[^>]*>Move<\\/button>`));
          expect(bulk[0]).toMatch(new RegExp(`formaction="/projects/${id}/assets/copy-selected">Copy<\\/button>`));
          expect(bulk[0]).toMatch(new RegExp(`formaction="/projects/${id}/assets/delete-selected"[^>]*>Delete<\\/button>`));
          expect(bulk[0]).not.toMatch(new RegExp(`formaction="/projects/${id}/assets/move-selected"[^>]*>Move selected<\\/button>`));
          expect(bulk[0]).not.toMatch(new RegExp(`formaction="/projects/${id}/assets/copy-selected">Copy selected<\\/button>`));
          expect(bulk[0]).not.toMatch(new RegExp(`formaction="/projects/${id}/assets/delete-selected"[^>]*>Delete selected<\\/button>`));
          expect(bulk[0]).toContain('data-confirm="The selected files will be permanently deleted from disk and cannot be restored through CreatorCrate. Continue?"');
          expect(bulk[0]).toContain('action="/projects/' + id + '/assets/add-to-release"');
          expect(bulk[0]).toMatch(/<button[^>]*data-bulk-submit[^>]*>Add<\/button>/);
          expect(bulk[0]).not.toMatch(/<button[^>]*data-bulk-submit[^>]*>Add selected to release<\/button>/);
          expect(bulk[0]).toMatch(new RegExp(`formaction="/projects/${id}/assets/create-release">New<\\/button>`));
          expect(bulk[0]).not.toMatch(new RegExp(`formaction="/projects/${id}/assets/create-release">Create release with selected<\\/button>`));
          const expectedAssetId = query.includes(`category=${enabled.id}`) ? categoryAsset.id : asset.id;
          expect(res.text).toMatch(new RegExp(`<input type="checkbox" form="bulk-select-form"[^>]*name="selectedAssetIds" value="${expectedAssetId}"`));
          expect((res.text.match(/<h1\b/g) || []).length).toBe(1);
      }
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
        const { id, asset } = await setupProjectWithAsset('Bulk Delete Published', 'a.png');
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
        const selectedCheckbox = res.text.match(new RegExp(`<input type="checkbox"[^>]*name="selectedAssetIds" value="${asset.id}"[^>]*>`))?.[0];
        expect(selectedCheckbox).toContain('checked');
      });

      it('copies multiple selected assets, preserves originals and rows, and redirects with full browser context', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Copy Success', 'a.png');
        const second = writeIndexedAsset(id, projectDir, 'b.png', await makePng());
        const category = makeEnabledCategory(id, projectDir, 'copy-target', 'Copy Target');

        const res = await agent.post(`/projects/${id}/assets/copy-selected`).type('form')
          .send({
            selectedAssetIds: [String(asset.id), String(second.id)],
            destinationCategory: String(category.id), category: 'all', search: 'a', extension: '.png',
            presence: 'present', usage: 'unused', sort: 'size', order: 'desc', page: '2', pageSize: '50',
            view: 'list', unknown: 'strip-me', _csrf: csrfToken,
          }).expect(302);

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
        expect(location.searchParams.get('assets_copied')).toBe('2');
        expect(location.searchParams.has('unknown')).toBe(false);

        expect(fs.existsSync(path.join(projectDir, 'a.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'b.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'copy-target', 'a.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'copy-target', 'b.png'))).toBe(true);

        expect(assetRepo.findById(asset.id).relative_path).toBe('a.png');
        expect(assetRepo.findById(second.id).relative_path).toBe('b.png');
        expect(assetRepo.findByProjectIdAndPath(id, 'copy-target/a.png')).toMatchObject({ category_id: category.id });
        expect(assetRepo.findByProjectIdAndPath(id, 'copy-target/b.png')).toMatchObject({ category_id: category.id });
        expect((await agent.get(res.headers.location).expect(200)).text).toContain('Copied 2 assets.');
      });

      it('rejects a copy collision without overwriting or partially copying the batch', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Copy Collision', 'a.png');
        const second = writeIndexedAsset(id, projectDir, 'b.png', await makePng());
        const category = makeEnabledCategory(id, projectDir, 'copy-target', 'Copy Target');
        fs.writeFileSync(path.join(projectDir, 'copy-target', 'a.png'), 'existing');

        const res = await agent.post(`/projects/${id}/assets/copy-selected`).type('form')
          .send({
            selectedAssetIds: [String(asset.id), String(second.id)],
            destinationCategory: String(category.id), _csrf: csrfToken,
          }).expect(409);

        expect(res.text).toContain('Destination already exists for one or more selected assets.');
        expect(fs.readFileSync(path.join(projectDir, 'copy-target', 'a.png'), 'utf8')).toBe('existing');
        expect(fs.existsSync(path.join(projectDir, 'copy-target', 'b.png'))).toBe(false);
        expect(fs.existsSync(path.join(projectDir, 'a.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'b.png'))).toBe(true);
        expect(assetRepo.findByProjectIdAndPath(id, 'copy-target/a.png')).toBeUndefined();
        expect(assetRepo.findByProjectIdAndPath(id, 'copy-target/b.png')).toBeUndefined();
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
        const selectedCheckbox = res.text.match(new RegExp(`<input type="checkbox"[^>]*name="selectedAssetIds" value="${asset.id}"[^>]*>`))?.[0];
        expect(selectedCheckbox).toContain('checked');
        expect(res.text).toContain('<span class="selected-count" data-selected-count data-selected-total="1">0 of 1 selected</span>');
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

      it("rejects Copy selected for archived projects with that project's presentation defaults", async () => {
        const { id, asset, projectDir } = await setupProjectWithAsset('Bulk Copy Archived', 'a.png');
        for (const [option, value] of Object.entries({
          view: 'grid', sort: 'filename', order: 'asc', pageSize: '25',
        })) {
          saveAssetDefault(option, value);
        }
        for (const [option, value] of Object.entries({
          view: 'list', sort: 'modified', order: 'desc', pageSize: '50',
        })) {
          saveProjectAssetDefault(id, option, value);
        }
        await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
        // Archiving is a database transition only — the flat project
        // directory is preserved in place.
        const archivedProjectDir = projectDir;

        const res = await agent.post(`/projects/${id}/assets/copy-selected`).type('form')
          .send({ selectedAssetIds: String(asset.id), destinationCategory: 'uncategorized', _csrf: csrfToken })
          .expect(409);

        expect(res.text).toContain('This project is archived and read-only.');
        expect(res.text).toContain('<ul class="asset-list asset-list--project"');
        expectCheckedAssetFilter(res.text, 'sort', 'modified');
        expectCheckedAssetFilter(res.text, 'order', 'desc');
        expect(res.text).toContain('<option value="50" selected>50 assets</option>');
        expect(fs.existsSync(path.join(archivedProjectDir, 'a.png'))).toBe(true);
        expect(assetRepo.findByProjectIdAndPath(id, 'a.png')).toBeDefined();
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

      it('moves selected assets with normalized full context and reports the moved count', async () => {
        const { id, projectDir } = await setupProjectWithAsset('Bulk Move Success', 'a.png');
        const second = writeIndexedAsset(id, projectDir, 'b.png', await makePng());
        const category = makeEnabledCategory(id, projectDir, 'bulk-target', 'Bulk Target');
        const res = await agent.post(`/projects/${id}/assets/move-selected`).type('form')
          .send({
            selectedAssetIds: [String(assetRepo.findByProjectId(id).find((a) => a.filename === 'a.png').id), String(second.id)],
            destinationCategory: String(category.id), category: 'all', search: 'a', extension: '.png', presence: 'present',
            usage: 'unused', sort: 'size', order: 'desc', page: '1', pageSize: '50', view: 'grid', unknown: 'strip-me',
            path: '../../outside', destinationPath: '/etc/passwd', _csrf: csrfToken,
          }).expect(302);

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
        expect(fs.existsSync(path.join(projectDir, 'bulk-target', 'a.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'bulk-target', 'b.png'))).toBe(true);
        expect((await agent.get(res.headers.location).expect(200)).text).toContain('Moved 2 assets.');
      });

      it('preserves explicit fallback presentation values and filters through scoped action redirects', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Scoped Redirect Preservation', 'a.png');
        const category = makeEnabledCategory(id, projectDir, 'scoped-target', 'Scoped Target');
        const tag = app.locals.tagService.createTag({ name: 'Scoped redirect tag' });
        app.locals.assetTagService.replaceAssetTags(asset.id, [tag.id]);

        for (const [option, value] of Object.entries({
          view: 'grid', sort: 'filename', order: 'asc', pageSize: '25',
        })) {
          saveAssetDefault(option, value);
        }
        for (const [option, value] of Object.entries({
          view: 'list', sort: 'modified', order: 'desc', pageSize: '50',
        })) {
          saveProjectAssetDefault(id, option, value);
        }

        const res = await agent.post(`/projects/${id}/assets/move-selected`).type('form')
          .send({
            selectedAssetIds: String(asset.id), destinationCategory: String(category.id), category: 'all',
            extension: 'png', tag: String(tag.id), sort: 'filename', order: 'asc',
            pageSize: '25', view: 'grid', _csrf: csrfToken,
          }).expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.searchParams.get('extension')).toBe('png');
        expect(location.searchParams.get('tag')).toBe(String(tag.id));
        expect(location.searchParams.get('view')).toBe('grid');
        expect(location.searchParams.get('sort')).toBe('filename');
        expect(location.searchParams.get('order')).toBe('asc');
        expect(location.searchParams.get('pageSize')).toBe('25');
        expect((await agent.get(res.headers.location).expect(200)).headers.location).toBeUndefined();
      });

      it('omits values matching Project-only defaults without changing Global-project redirects', async () => {
        const scoped = await setupProjectWithAsset('Scoped Redirect Omission', 'scoped.png');
        const global = await setupProjectWithAsset('Global Redirect Isolation', 'global.png');
        const scopedCategory = makeEnabledCategory(scoped.id, scoped.projectDir, 'scoped-target', 'Scoped Target');
        const globalCategory = makeEnabledCategory(global.id, global.projectDir, 'global-target', 'Global Target');

        for (const [option, value] of Object.entries({
          view: 'list', sort: 'modified', order: 'desc', pageSize: '50',
        })) {
          saveAssetDefault(option, value);
        }
        for (const [option, value] of Object.entries({
          view: 'grid', sort: 'filename', order: 'asc', pageSize: '25',
        })) {
          saveProjectAssetDefault(scoped.id, option, value);
        }

        const explicitFallback = {
          category: 'all', sort: 'filename', order: 'asc', pageSize: '25', view: 'grid', _csrf: csrfToken,
        };
        const scopedRedirect = await agent.post(`/projects/${scoped.id}/assets/move-selected`).type('form')
          .send({
            ...explicitFallback,
            selectedAssetIds: String(scoped.asset.id), destinationCategory: String(scopedCategory.id),
          }).expect(302);
        const scopedLocation = new URL(scopedRedirect.headers.location, 'http://localhost');
        for (const key of ['view', 'sort', 'order', 'pageSize']) {
          expect(scopedLocation.searchParams.has(key)).toBe(false);
        }

        const globalRedirect = await agent.post(`/projects/${global.id}/assets/move-selected`).type('form')
          .send({
            ...explicitFallback,
            selectedAssetIds: String(global.asset.id), destinationCategory: String(globalCategory.id),
          }).expect(302);
        const globalLocation = new URL(globalRedirect.headers.location, 'http://localhost');
        expect(globalLocation.searchParams.get('view')).toBe('grid');
        expect(globalLocation.searchParams.get('sort')).toBe('filename');
        expect(globalLocation.searchParams.get('order')).toBe('asc');
        expect(globalLocation.searchParams.get('pageSize')).toBe('25');
      });

      it('returns 409 for database and filesystem destination conflicts without mutation', async () => {
        const databaseConflict = await setupProjectWithAsset('Bulk DB Conflict', 'a.png');
        const dbCategory = makeEnabledCategory(databaseConflict.id, databaseConflict.projectDir, 'db-target', 'DB Target');
        assetRepo.upsert(databaseConflict.id, 'db-target/a.png', {
          filename: 'a.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
          categoryId: dbCategory.id, nestedPath: '',
        });
        const dbRes = await agent.post(`/projects/${databaseConflict.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: String(databaseConflict.asset.id), destinationCategory: String(dbCategory.id), _csrf: csrfToken }).expect(409);
        expect(dbRes.text).toContain('Destination already exists for one or more selected assets.');
        expect(fs.existsSync(path.join(databaseConflict.projectDir, 'a.png'))).toBe(true);

        const filesystemConflict = await setupProjectWithAsset('Bulk FS Conflict', 'a.png');
        const fsCategory = makeEnabledCategory(filesystemConflict.id, filesystemConflict.projectDir, 'fs-target', 'FS Target');
        fs.writeFileSync(path.join(filesystemConflict.projectDir, 'fs-target', 'a.png'), 'existing');
        const fsRes = await agent.post(`/projects/${filesystemConflict.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: String(filesystemConflict.asset.id), destinationCategory: String(fsCategory.id), _csrf: csrfToken }).expect(409);
        expect(fsRes.text).toContain('Destination already exists for one or more selected assets.');
        expect(fs.readFileSync(path.join(filesystemConflict.projectDir, 'fs-target', 'a.png'), 'utf8')).toBe('existing');
        expect(fs.existsSync(path.join(filesystemConflict.projectDir, 'a.png'))).toBe(true);
      });

      it('returns 409 for intra-batch destination conflicts and controls same-location rejection', async () => {
        const batch = await setupProjectWithAsset('Bulk Duplicate Destination', 'source-a/same.png');
        const sourceA = assetCategoryRepo.addProjectCategory({ projectId: batch.id, displayName: 'Source A', directorySlug: 'source-a', displayOrder: 0, enabled: true });
        const sourceB = assetCategoryRepo.addProjectCategory({ projectId: batch.id, displayName: 'Source B', directorySlug: 'source-b', displayOrder: 1, enabled: true });
        const target = makeEnabledCategory(batch.id, batch.projectDir, 'same-target', 'Same Target');
        const first = writeIndexedAsset(batch.id, batch.projectDir, 'source-a/same.png', await makePng(), { categoryId: sourceA.id });
        const second = writeIndexedAsset(batch.id, batch.projectDir, 'source-b/same.png', await makePng(), { categoryId: sourceB.id });
        const duplicate = await agent.post(`/projects/${batch.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: [String(first.id), String(second.id)], destinationCategory: String(target.id), _csrf: csrfToken }).expect(409);
        expect(duplicate.text).toContain('Two or more selected assets have the same filename');
        expect(fs.existsSync(path.join(batch.projectDir, 'source-a', 'same.png'))).toBe(true);
        expect(fs.existsSync(path.join(batch.projectDir, 'source-b', 'same.png'))).toBe(true);

        const same = await setupProjectWithAsset('Bulk Same Location', 'same-target/same.png');
        const sameCategory = assetCategoryRepo.addProjectCategory({ projectId: same.id, displayName: 'Same', directorySlug: 'same-target', displayOrder: 0, enabled: true });
        const sameAsset = writeIndexedAsset(same.id, same.projectDir, 'same-target/same.png', await makePng(), { categoryId: sameCategory.id });
        const sameRes = await agent.post(`/projects/${same.id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: String(sameAsset.id), destinationCategory: String(sameCategory.id), _csrf: csrfToken }).expect(422);
        expect(sameRes.text).toContain('One or more selected assets cannot be moved to that destination.');
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
        expect(partialRes.text).toContain(`value="${partial.asset.id}"`);
        expect(partialRes.text).toContain('checked');
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

      it('enforces CSRF on Move selected', async () => {
        const { id, asset } = await setupProjectWithAsset('Bulk Move CSRF', 'a.png');
        await agent.post(`/projects/${id}/assets/move-selected`).type('form')
          .send({ selectedAssetIds: String(asset.id), destinationCategory: 'uncategorized' }).expect(403);
      });
    });
  });
});
