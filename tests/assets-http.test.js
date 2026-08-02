import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  STATUS_DIR_MAP,
  formatProjectDirName,
  buildProjectRelPath,
} from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { AssetActionError } from '../src/services/asset-action-service.js';
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

  function getProjectDir(projectTitle, status = 'tbd') {
    const slug = slugify(projectTitle, { lowercase: true });
    const statusDir = STATUS_DIR_MAP[status];
    const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
    const matching = entries.filter((e) => e.endsWith(`-${slug}`));
    if (matching.length === 0) return null;
    return path.join(projectsRoot, statusDir, matching[0]);
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
    });
  }

  function makeKritaArchive({ merged = null, preview = null } = {}) {
    const entries = [];
    if (preview) entries.push({ name: 'preview.png', data: preview, compression: 'deflate' });
    if (merged) entries.push({ name: 'mergedimage.png', data: merged, compression: 'deflate' });
    return makeZip(entries);
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

  async function createReleaseUsingAsset(projectId, assetId, title = 'Viewer Release', status = 'planned') {
    const releaseRes = await agent
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = releaseRes.headers.location.replace('/releases/', '');
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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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
    expect(res2.text).toContain('Back to Project');
    expect(res2.text).toContain('class="page-heading"');
    expect((res2.text.match(/<h1\b/g) || []).length).toBe(1);
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
      expect(response.text).toMatch(/<a href="\/projects\/\d+\/assets\?category=all"[\s\S]*All Assets/);
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
      expect(response.text).toMatch(/<a href="\/projects\/\d+\/assets\?category=all"[\s\S]*All Assets/);
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
        INSERT INTO projects (title, slug, description, notes, status, priority,
                              planned_date, published_date, patreon_url, archived_at)
        VALUES ('Early Default Project', 'early-default-project', '', '', 'tbd', 'normal', NULL, NULL, NULL, NULL)
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

  describe('non-bare requests block defaults', () => {
    it.each([
      ['explicit All', 'category=all'],
      ['explicit numeric category', 'category=1'],
      ['uncategorized', 'category=uncategorized'],
      ['search', 'search=needle'],
      ['filter', 'presence=present'],
      ['pagination', 'page=2'],
      ['explicit List', 'view=list'],
      ['explicit Grid', 'view=grid'],
      ['notice', 'notice=asset-renamed'],
      ['unknown query', 'unknown=value'],
      ['invalid category', 'category=invalid'],
      ['stale category', 'category=999999'],
    ])('%s does not activate a configured specific default', async (_label, query) => {
      const res = await createProject(`Blocks Default ${query}`);
      const id = Number(res.headers.location.replace('/projects/', ''));
      const [category] = assetCategoryRepo.listProjectCategories(id);
      assetBrowserPreferenceRepo.upsertProjectPreference(id, 'category', category.id);

      const resolveSpy = vi.spyOn(app.locals.assetBrowserPreferenceService, 'resolveEffectiveCategory');
      const response = await agent.get(`/projects/${id}/assets?${query}`).expect(200);

      expect(response.headers.location).toBeUndefined();
      expect(resolveSpy).not.toHaveBeenCalled();
      resolveSpy.mockRestore();
    });
  });

  describe('Assets-page project default removal', () => {
    async function createProjectId(title) {
      const res = await createProject(title);
      return Number(res.headers.location.replace('/projects/', ''));
    }

    it('does not render the preference control or its success notice', async () => {
      const id = await createProjectId('Assets Default Removed');
      const res = await agent
        .get(`/projects/${id}/assets?category=all&notice=project_asset_default_saved`)
        .expect(200);

      expect(res.text).not.toContain('Asset browser default');
      expect(res.text).not.toContain('assets-default-category');
      expect(res.text).not.toContain(`action="/projects/${id}/assets/default-category"`);
      expect(res.text).not.toContain('Project asset default saved.');
      expect(res.text).not.toContain('name="defaultCategory"');
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
      expect(res.text).toMatch(/<option value="all" selected>All categories/);
      resolveSpy.mockRestore();
    });
  });

  it('shows scan-freshness wording explaining data is not live and files are not deleted', async () => {
    const res = await createProject('Freshness Wording');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('Asset presence reflects the last completed scan');
    expect(res2.text).toContain('files are not checked live');
    expect(res2.text).toMatch(/CreatorCrate never deletes\s+files on disk/);
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
    expect(res2.text).toContain('3 assets found');
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

    const releaseRes = await agent
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Used+Asset+Release')
      .send('status=idea')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = releaseRes.headers.location.replace('/releases/', '');

    await agent
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${usedAsset.id}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

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

    const releaseRes = await agent
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Link+Release')
      .send('status=idea')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = releaseRes.headers.location.replace('/releases/', '');

    await agent
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${usedAsset.id}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

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

    const releaseRes = await agent
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Combine+Release')
      .send('status=idea')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseId = releaseRes.headers.location.replace('/releases/', '');

    await agent
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${presentUsed.id}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

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
        .send('status=idea')
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

  it('shows release titles and statuses for used assets', async () => {
    const res = await createProject('Release Titles');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Release Titles');

    fs.writeFileSync(path.join(projectDir, 'shared.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assets = assetRepo.findByProjectId(id);
    const asset = assets[0];

    const relRes = await agent
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Status+Check+Release')
      .send('status=planned')
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

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('Status Check Release');
    expect(res2.text).toContain('planned');
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

    // Locate the present-file row and assert its presence element.
    // Match a single <tr>…</tr> that contains the filename without crossing row boundaries.
    const presentRowRe = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*present-file\.txt(?:(?!<\/tr>)[\s\S])*<\/tr>/;
    const presentRow = res2.text.match(presentRowRe);
    expect(presentRow).not.toBeNull();
    expect(presentRow[0]).toContain('asset-indicator--present');
    expect(presentRow[0]).toContain('aria-label="Present"');
    expect(presentRow[0]).not.toContain('asset-indicator--missing');

    // Locate the missing-file row and assert its presence element
    const missingRowRe = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*missing-file\.txt(?:(?!<\/tr>)[\s\S])*<\/tr>/;
    const missingRow = res2.text.match(missingRowRe);
    expect(missingRow).not.toBeNull();
    expect(missingRow[0]).toContain('asset-indicator--missing');
    expect(missingRow[0]).toContain('aria-label="Missing at last scan"');
    expect(missingRow[0]).not.toContain('asset-indicator--present');
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

    const viewLinks = [...response.text.matchAll(/class="view-switcher-option" href="([^"]+)"/g)]
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

    const rowMatch = response.text.match(/<a class="asset-file-link" href="([^"]+)">alpha<\/a>/);
    expect(rowMatch).not.toBeNull();
    const rowHref = decodeHtmlHref(rowMatch[1]);
    expect(new URL(rowHref, 'http://localhost').searchParams.get('category')).toBe('all');

    const viewer = await agent.get(rowHref).expect(200);
    for (const className of ['asset-viewer-back', 'asset-viewer-next']) {
      const href = anchorHref(viewer.text, className);
      expect(href).not.toBeNull();
      expect(new URL(decodeHtmlHref(href), 'http://localhost').searchParams.get('category')).toBe('all');
    }
    expect(new URL(decodeHtmlHref(anchorHref(viewer.text, 'asset-viewer-next')), 'http://localhost').pathname)
      .toBe(`/projects/${id}/assets/${assets.bravo.id}`);

    const scanForm = response.text.match(/<form method="post" action="\/projects\/\d+\/scan"[^>]*>[\s\S]*?<\/form>/)?.[0];
    expect(scanForm).toContain('<input type="hidden" name="category" value="all">');

    const pageSizeForm = response.text.match(/<form class="page-size-form"[^>]*>[\s\S]*?<\/form>/)?.[0];
    expect(pageSizeForm).toContain('<input type="hidden" name="category" value="all">');

    const categorySelect = response.text.match(/<select id="category" name="category">[\s\S]*?<\/select>/)?.[0];
    expect(categorySelect).toContain('<option value="all" selected>');
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
    // Table rows render versioned thumbnail URLs for previewable assets,
    // but never preview-sized media.
    expect(res2.text).not.toContain('/preview');
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
    expect(res2.text).toContain('5 assets found');
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
    expect(res2.text).toContain('5 assets found');
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
    expect(res2.text).toContain('5 assets found');
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
    expect(res2.text).toContain('5 assets found');
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
    expect(res2.text).toContain('5 assets found');
    expect(res2.text).toContain('file0.png');
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

  it('renders filename as the primary label and nested_path as secondary location, never the full relative_path', async () => {
    const res = await createProject('Path Display');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Path Display');

    // Uncategorized asset under an unknown nested directory.
    fs.mkdirSync(path.join(projectDir, 'unknown', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'unknown', 'deep', 'file.txt'), 'x');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('>file<');
    expect(res2.text).toContain('unknown/deep');
    // The full canonical relative path (dir + filename) must not appear in the row.
    expect(res2.text).not.toContain('unknown/deep/file.txt');
  });

  it('shows "Project root" for an uncategorized asset at the project root', async () => {
    const res = await createProject('Root Location Display');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Root Location Display');

    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'x');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(res2.text).toContain('>notes<');
    expect(res2.text).toContain('Project root');
    expect(res2.text).toContain('Uncategorized');
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
    expect(res2.text).toContain('value="png" selected');
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

    expect(res2.text).toContain('value="missing" selected');
    expect(res2.text).not.toContain('value="present" selected');
  });

  it('filter form shows correct selected state for usage', async () => {
    const res = await createProject('Usage Filter State');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await agent
      .get(`/projects/${id}/assets?usage=unused`)
      .expect(200);

    expect(res2.text).toContain('value="unused" selected');
    expect(res2.text).not.toContain('value="used" selected');
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
    expect(res2.text).not.toContain('value="25" selected');
    // Presence filter form also reflects the active filter
    expect(res2.text).toContain('value="present" selected');

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
    expect(form).toContain('<label for="pageSize">Assets per page:</label>');
    expect(form).toContain('<select id="pageSize" name="pageSize" data-autosubmit>');
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
    expect(submitted.text).toContain('35 assets found');

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
    expect(res2.text).toContain('<title>hero.png — CreatorCrate</title>');
    expect(res2.text).toContain('class="page-heading"');
    expect(res2.text).toContain('<h1 class="app-section-title">Assets — Viewer Previewable — hero.png</h1>');
    expect(res2.text).toContain('Asset preview, metadata, and release usage.');
    expectAnchorHref(res2.text, 'asset-viewer-project', `/projects/${id}`);
    expectAnchorHref(res2.text, 'asset-viewer-back', `/projects/${id}/assets`);
    expect(res2.text).toContain(
      `<img class="asset-preview-image" src="/projects/${id}/assets/${asset.id}/preview?v=${revision}" alt="Preview of hero.png" data-preview-image>`
    );
    expectAnchorHref(res2.text, 'asset-viewer-original', `/projects/${id}/assets/${asset.id}/original`);
    expect(res2.text).toContain('<code>gallery/hero.png</code>');
    expect(res2.text).toContain('<code>png</code>');
    expect(res2.text).toContain('<code>image/png</code>');
    expect(res2.text).toContain(`${png.length} bytes`);
    expect(res2.text).toContain('2026-07-15 10:20:30');
    expect(res2.text).toContain('Present at last scan');
    expect(res2.text).toContain('Used by 1 release');
    expect(res2.text).toContain('Hero Release');
    expect(res2.text).toContain(`/releases/${releaseId}`);
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

    // First row on a descending-filename page 1 of 2 is "Hero Two.png".
    const linkMatch = res2.text.match(/<a class="asset-file-link" href="([^"]+)">Hero Two<\/a>/);
    expect(linkMatch).not.toBeNull();
    const rowHref = decodeHtmlHref(linkMatch[1]);
    const rowUrl = new URL(rowHref, 'http://localhost');

    expect(rowUrl.pathname).toBe(`/projects/${id}/assets/${heroTwo.id}`);
    expect(rowUrl.searchParams.get('category')).toBe(String(category.id));
    expect(rowUrl.searchParams.get('search')).toBe('hero');
    expect(rowUrl.searchParams.get('extension')).toBe('png');
    expect(rowUrl.searchParams.get('presence')).toBe('present');
    expect(rowUrl.searchParams.get('usage')).toBe('unused');
    expect(rowUrl.searchParams.get('order')).toBe('desc');
    expect(rowUrl.searchParams.get('pageSize')).toBe('2');
    expect(rowUrl.searchParams.has('sort')).toBe(false); // 'filename' is the omitted default
    expect(rowUrl.searchParams.get('view')).toBe('list');
    expect(rowUrl.searchParams.has('junk')).toBe(false);

    // Follow the row link into the viewer and confirm Back/Previous/Next
    // preserve the exact same canonical context (not defaults).
    const viewerRes = await agent.get(rowHref).expect(200);
    const expectedQuery = {
      category: String(category.id), search: 'hero', extension: 'png',
      presence: 'present', usage: 'unused', order: 'desc', pageSize: '2', view: 'list',
    };
    expectQueryKeys(rowHref, Object.keys(expectedQuery));

    const backHref = decodeHtmlHref(anchorHref(viewerRes.text, 'asset-viewer-back'));
    const backUrl = new URL(backHref, 'http://localhost');
    for (const [key, value] of Object.entries(expectedQuery)) {
      expect(backUrl.searchParams.get(key)).toBe(value);
    }

    const nextHref = decodeHtmlHref(anchorHref(viewerRes.text, 'asset-viewer-next'));
    const nextUrl = new URL(nextHref, 'http://localhost');
    // Descending filename order: Hero Two -> Hero Three is next.
    expect(nextUrl.pathname).toBe(`/projects/${id}/assets/${heroThree.id}`);
    for (const [key, value] of Object.entries(expectedQuery)) {
      expect(nextUrl.searchParams.get(key)).toBe(value);
    }
  });

  it('uses the clamped page for a browser row viewer link when the requested page is out of range', async () => {
    const res = await createProject('Row Link Clamped Page');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Row Link Clamped Page');
    const asset = writeIndexedAsset(id, projectDir, 'only.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?page=99&view=list`).expect(200);
    const linkMatch = res2.text.match(/<a class="asset-file-link" href="([^"]+)">only<\/a>/);
    expect(linkMatch).not.toBeNull();
    const rowHref = decodeHtmlHref(linkMatch[1]);

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
    expectAnchorHref(res.text, 'asset-viewer-prev', previousHref);
    expectAnchorHref(res.text, 'asset-viewer-back', backHref);
    expectAnchorHref(res.text, 'asset-viewer-next', nextHref);
    expect(anchorText(res.text, 'asset-viewer-prev')).toBe('Previous asset');
    expect(anchorText(res.text, 'asset-viewer-next')).toBe('Next asset');
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
    expectAnchorHref(res.text, 'asset-viewer-prev', previousHref);
    expectAnchorHref(res.text, 'asset-viewer-back', backHref);
    expectAnchorHref(res.text, 'asset-viewer-next', nextHref);
    expectQueryKeys(previousHref, []);
    expectQueryKeys(backHref, []);
    expectQueryKeys(nextHref, []);
  });

  it('omits previous on the first asset and next on the last asset', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Edge Links');

    const first = await agent
      .get(`/projects/${id}/assets/${assets.alpha.id}?pageSize=1`)
      .expect(200);
    expectNoAnchor(first.text, 'asset-viewer-prev');
    expectAnchorHref(first.text, 'asset-viewer-next', `/projects/${id}/assets/${assets.bravo.id}?page=2&pageSize=1`);

    const last = await agent
      .get(`/projects/${id}/assets/${assets.charlie.id}?pageSize=1`)
      .expect(200);
    expectNoAnchor(last.text, 'asset-viewer-next');
    expectAnchorHref(last.text, 'asset-viewer-prev', `/projects/${id}/assets/${assets.bravo.id}?page=2&pageSize=1`);
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
    expectAnchorHref(res2.text, 'asset-viewer-prev', previousHref);
    expectAnchorHref(res2.text, 'asset-viewer-back', backHref);
    expectNoAnchor(res2.text, 'asset-viewer-next');
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
    expectNoAnchor(res2.text, 'asset-viewer-prev');
    expectNoAnchor(res2.text, 'asset-viewer-next');
    expectAnchorHref(res2.text, 'asset-viewer-back', backHref);
    expectQueryKeys(backHref, ['search', 'pageSize']);
  });

  it('renders missing assets without broken preview or original links', async () => {
    const res = await createProject('Viewer Missing');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Missing');
    if (!projectDir) throw new Error('projectDir not found for Viewer Missing');
    const asset = writeIndexedAsset(id, projectDir, 'gone.png', await makePng());
    assetRepo.markMissingByProjectIdAndPathNotIn(id, []);

    const res2 = await agent
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('Missing at last scan. Preview and original viewing are unavailable.');
    expect(res2.text).toContain('Preview unavailable for missing assets.');
    expect(previewSectionHtml(res2.text)).not.toContain('<img ');
    expect(res2.text).not.toContain('/preview?v=');
    expectNoAnchor(res2.text, 'asset-viewer-original');
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

    expect(res2.text).toContain('private/blob.bin');
    expect(res2.text).not.toContain(secret);
    expect(res2.text).not.toContain(tmpDir);
    expect(res2.text).not.toContain(projectsRoot);
    expect(res2.text).not.toMatch(/[A-Z]:\\/);
    expect(res2.text).not.toContain('/Users/');
    expect(res2.text).not.toContain('/home/');
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
          getReleaseReadiness: () => ({}),
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
    expect(anchorText(res.text, 'asset-viewer-prev')).toBe('Previous asset');
    expect(anchorText(res.text, 'asset-viewer-next')).toBe('Next asset');
    expect(res.text).toContain('Present at last scan');
    expect(res.text).toContain('<dl class="detail-list asset-metadata">');
    expect(anchorText(res.text, 'asset-viewer-back')).toBe('Back to Assets');
    // The shell <main> carries tabindex="-1" so the skip link can move focus
    // into the content region (WCAG technique G1). The viewer baseline instead
    // guarantees its own navigation links never reorder focus with tabindex.
    expect(res.text).not.toMatch(/<a\b[^>]*\btabindex=/);

    const projectIndex = res.text.indexOf('asset-viewer-project');
    const backIndex = res.text.indexOf('asset-viewer-back');
    const previousIndex = res.text.indexOf('asset-viewer-prev');
    const nextIndex = res.text.indexOf('asset-viewer-next');
    const originalIndex = res.text.indexOf('asset-viewer-original');
    expect(projectIndex).toBeGreaterThan(-1);
    expect(projectIndex).toBeLessThan(backIndex);
    expect(backIndex).toBeLessThan(previousIndex);
    expect(previousIndex).toBeLessThan(nextIndex);
    expect(nextIndex).toBeLessThan(originalIndex);
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

    expect(res2.text).toContain(`<title>${filename} — CreatorCrate</title>`);
    expect(res2.text).toContain(`<h1 class="app-section-title">Assets — Viewer Long Content — ${filename}</h1>`);
    expect(res2.text).toContain(`<code>${relativePath}</code>`);
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
    expectAnchorHref(res2.text, 'asset-viewer-original', `/projects/${id}/assets/${asset.id}/original`);
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
    expect(res2.text).toContain('JavaScript is disabled. If the preview does not load, use View Original to open the asset.');
    expect(res2.text).toContain('data-preview-fallback hidden>Preview unavailable</p>');
    expect(res2.text).toContain('alt="Preview of viewer-fallback.png"');
    expectAnchorHref(res2.text, 'asset-viewer-original', `/projects/${id}/assets/${asset.id}/original`);
    expect(res2.text).not.toContain('aria-live');
  });

  it('renders thumbnail loading hooks and pre-rendered failure fallback in the browser table', async () => {
    const res = await createProject('PhaseC Table Hooks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC Table Hooks');
    writeIndexedAsset(id, projectDir, 'hooked.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);

    expect(res2.text).toContain('class="asset-thumb" data-preview-enhancement data-preview-state="loading"');
    expect(res2.text).toContain('data-preview-image');
    expect(res2.text).toContain('data-preview-fallback hidden>');
    expect((res2.text.match(/data-preview-image/g) || []).length).toBe(1);
    expect((res2.text.match(/data-preview-fallback/g) || []).length).toBe(1);
  });

  it('does not add image-loading behavior for unsupported binary assets in the browser table', async () => {
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
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.asset-thumb-image[\s\S]*\.asset-preview-image[\s\S]*transition: none !important;/
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

  it('renders object-fit cover for the compact browser thumbnail', async () => {
    const res = await createProject('PhaseB Thumb Fit');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(await readStylesheetSource(res2.text)).toMatch(/\.asset-thumb-image\s*\{[^}]*object-fit:\s*cover/);
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

  it('renders focus-visible CSS for category nav links and asset filenames', async () => {
    const res = await createProject('PhaseB Focus CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const style = await readStylesheetSource(res2.text);
    expect(style).toMatch(/\.asset-browser-nav-list a:focus-visible/);
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

  it('renders the two-column browser shell with a category nav and a content panel', async () => {
    const res = await createProject('PhaseB Layout Shell');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const layoutStart = res2.text.indexOf('class="asset-browser-layout"');
    expect(layoutStart).toBeGreaterThan(-1);
    const navPos = res2.text.indexOf('class="asset-browser-nav"', layoutStart);
    const contentPos = res2.text.indexOf('class="asset-browser-content"', layoutStart);
    expect(navPos).toBeGreaterThan(layoutStart);
    expect(contentPos).toBeGreaterThan(navPos);
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
    expect(style).toMatch(/\.asset-viewer-breadcrumb\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-viewer-breadcrumb a\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    expect(style).toMatch(/\.detail-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 8rem\) minmax\(0, 1fr\)[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.detail-list code\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    expect(style).toMatch(/\.asset-preview-frame\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-preview-image\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.asset-release-usage-section,[\s\S]*?\.release-status\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(style).toMatch(/\.asset-browser-content\s*\{[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.asset-nav-label\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  });

  // ─── Category-aware table markup ────────────────────────────────

  it('renders exactly one semantic table with the expected column headings', async () => {
    const res = await createProject('Table Markup');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Table Markup');
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect((res2.text.match(/<table class="data-table asset-table">/g) || []).length).toBe(1);
    expect((res2.text.match(/<table\b/g) || []).length).toBe(1);
    for (const heading of ['Preview', 'File', 'Category', 'Type', 'Presence', 'Release usage', 'Actions']) {
      expect(res2.text).toContain(`<th scope="col">${heading}</th>`);
    }
  });

  it('keeps the Actions cell a real table cell with a flex wrapper for controls, right-aligned via CSS', async () => {
    const res = await createProject('Actions Cell Markup');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Actions Cell Markup');
    writeIndexedAsset(id, projectDir, 'a.png', await makePng());

    const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    // The <td> itself carries no flex/display override — only the inner
    // <span class="row-actions"> does, so the cell keeps standard table
    // layout while its contents are right-aligned.
    expect(res2.text).toMatch(/<td class="asset-actions-cell">\s*<span class="row-actions">/);
    expect(res2.text).not.toMatch(/<td class="row-actions">/);

    const style = await readStylesheetSource(res2.text);
    expect(style).toMatch(/\.asset-table \.asset-actions-cell\s*\{[^}]*text-align:\s*right/);
    expect(style).toMatch(/\.asset-table thead th:last-child\s*\{[^}]*text-align:\s*right/);
  });

  it('renders accessible List/Grid view controls with the correct selected state', async () => {
    const res = await createProject('View Switcher');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('View Switcher');
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const listRes = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(listRes.text).toContain('class="view-switcher"');
    expect(listRes.text).toMatch(/class="view-switcher-option" href="[^"]*"\s+aria-current="page">List</);
    expect(listRes.text).not.toContain('asset-grid');
    expect(listRes.text).toContain('data-table asset-table');
    expect(listRes.text).toContain('data-tooltip="View asset details"');
    expect(listRes.text).not.toMatch(/class="asset-details-link[^>]*title="/);

    const gridRes = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(gridRes.text).toContain('class="view-switcher"');
    expect(gridRes.text).toMatch(/class="view-switcher-option" href="[^"]*"\s+aria-current="page">Grid</);
    expect(gridRes.text.indexOf('>Grid</a>')).toBeLessThan(gridRes.text.indexOf('>List</a>'));
    expect(gridRes.text).toContain('data-asset-grid-size-controls');
    expect(gridRes.text).toContain('data-grid-size="default"');
    expect(gridRes.text).toContain('aria-pressed="true"');
    expect(gridRes.text).toContain('class="asset-grid"');
    expect(gridRes.text).toContain('class="asset-card"');
    expect(gridRes.text).not.toContain('data-table asset-table');
    expect(listRes.text).not.toContain('data-asset-grid-size-controls');
  });

  it('renders equivalent metadata, actions, and bulk-selection fields for a grid card', async () => {
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
    expect(card).not.toContain('class="asset-card-category"');
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
    expect(card).toMatch(/<div class="asset-card-media" data-preview-enhancement data-preview-state="loading">\s*<a class="asset-card-media-link" href="[^"]+" aria-label="View details for hero\.png">\s*<img class="asset-card-thumb"[^>]*data-preview-image>\s*<\/a>\s*<span class="asset-card-placeholder asset-card-fallback" data-preview-fallback hidden>PNG<\/span>\s*<\/div>/);
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
    expect(list.text).toMatch(/<a class="asset-file-link" href="[^"]*">hero<\/a>/);
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

  it('uses the higher-resolution preview derivative in Grid and the thumbnail derivative in List', async () => {
    const res = await createProject('Grid Preview Derivative');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Preview Derivative');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng(512, 384));

    const grid = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(grid.text).toMatch(new RegExp(`<img class="asset-card-thumb"[^>]*src="/projects/${id}/assets/${asset.id}/preview\\?v=`));
    expect(grid.text).not.toMatch(new RegExp(`<img class="asset-card-thumb"[^>]*src="[^"]+/original`));

    const list = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(list.text).toMatch(new RegExp(`<img class="asset-thumb-image"[^>]*src="/projects/${id}/assets/${asset.id}/thumbnail\\?v=`));
    expect(list.text).not.toMatch(new RegExp(`<img class="asset-thumb-image"[^>]*src="[^"]+/preview`));
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
      const row = list.text.match(new RegExp(`<tr[^>]*>[\\s\\S]*?${asset.filename}[\\s\\S]*?<\\/tr>`))?.[0];
      expect(row).toBeDefined();
      expect(row).toContain('class="asset-thumb asset-media--krita" data-preview-enhancement');
      expect(row).toMatch(new RegExp(`class="asset-thumb-image"[^>]*src="/projects/${id}/assets/${asset.id}/thumbnail\\?v=`));
      expect(row).not.toContain('width="48"');
      expect(row).not.toContain('height="48"');
    }

    for (const asset of [kra, krz]) {
      const viewer = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
      const previewSection = previewSectionHtml(viewer.text);
      expect(previewSection).toContain('class="asset-preview-frame asset-media--krita" data-preview-enhancement');
      expect(previewSection).toContain(`/projects/${id}/assets/${asset.id}/preview?v=`);
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
    writeIndexedAsset(id, projectDir, 'archive.final.png', await makePng());

    const list = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
    expect(list.text).toContain('>archive.final<');
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
    expect(card).toContain('class="asset-card is-selected"');
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

  it('renders category navigation with All, Uncategorized, enabled categories, a disabled section, Missing, and a manage link', async () => {
    const res = await createProject('Category Nav');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Category Nav');

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

    expect(res2.text).toContain('>All Assets<');
    expect(res2.text).toContain('>Uncategorized<');
    expect(res2.text).toContain('Renders');
    expect(res2.text).toContain('Empty Category');
    expect(res2.text).toContain('Disabled Categories');
    expect(res2.text).toContain('Archive');
    expect(res2.text).toContain('(disabled)');
    expect(res2.text).toContain('>Missing Assets<');
    expect(res2.text).toContain(`href="/projects/${id}/asset-categories"`);
    expect(res2.text).toContain('Manage Categories');

    const gridCards = [...res2.text.matchAll(/<article class="asset-card[\s\S]*?<\/article>/g)].map((match) => match[0]).join('\n');
    expect(gridCards).not.toContain('Renders');
    expect(gridCards).not.toContain('Archive');
    expect(gridCards).not.toContain('asset-card-category');

    // Whole-project counts, independent of the current filter/page.
    expect(res2.text).toMatch(/All Assets[\s\S]{0,80}<span class="asset-nav-count">3<\/span>/);
    expect(res2.text).toMatch(/Missing Assets[\s\S]{0,80}<span class="asset-nav-count">1<\/span>/);

    // Currently-selected item is aria-current, and category filter options
    // are scoped to this project only (no leaked category ids from others).
    expect(res2.text).toMatch(/aria-current="page">\s*<span class="asset-nav-label">All Assets/);
  });

  it('category dropdown options are project-scoped and mark disabled categories', async () => {
    const res = await createProject('Category Dropdown Owner');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const other = await createProject('Category Dropdown Other');
    const otherId = Number(other.headers.location.replace('/projects/', ''));

    assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Mine', directorySlug: 'mine', displayOrder: 0, enabled: true,
    });
    assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Mine Disabled', directorySlug: 'mine-disabled', displayOrder: 1, enabled: false,
    });
    assetCategoryRepo.addProjectCategory({
      projectId: otherId, displayName: 'Not Mine', directorySlug: 'not-mine', displayOrder: 0, enabled: true,
    });

    const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
    const selectMatch = res2.text.match(/<select id="category" name="category">[\s\S]*?<\/select>/);
    expect(selectMatch).not.toBeNull();
    const select = selectMatch[0];
    expect(select).toContain('Mine</option>');
    expect(select).toContain('Mine Disabled (disabled)</option>');
    expect(select).not.toContain('Not Mine');
  });

  it('selecting a category filters the table and resets to page 1', async () => {
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

    const res2 = await agent.get(`/projects/${id}/assets?category=${cat.id}&page=2`).expect(200);
    expect(res2.text).toContain('keep.png');
    expect(res2.text).not.toContain('other.png');
    expect(res2.text).toContain('1 asset found');
    expect(inCat.id).toBeGreaterThan(0);
  });

  // ─── Defect fix: category nav aria-current matches exactly one destination ──

  describe('category navigation aria-current exact-destination matching', () => {
    function countAriaCurrent(html) {
      // Scoped to the category navigation region only — the app shell has
      // its own unrelated aria-current="page" markers elsewhere on the page.
      const navMatch = html.match(/<nav class="asset-browser-nav"[^>]*>[\s\S]*?<\/nav>/);
      expect(navMatch).not.toBeNull();
      return (navMatch[0].match(/aria-current="page"/g) || []).length;
    }

    async function setupNavHttpProject(title) {
      const res = await createProject(title);
      const id = Number(res.headers.location.replace('/projects/', ''));
      const category = assetCategoryRepo.addProjectCategory({
        projectId: id, displayName: 'Renders', directorySlug: `renders-${id}`, displayOrder: 0, enabled: true,
      });
      return { id, category };
    }

    it('default context marks only All Assets current', async () => {
      const { id } = await setupNavHttpProject('Aria Default');
      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(countAriaCurrent(res2.text)).toBe(1);
      expect(res2.text).toMatch(/aria-current="page">\s*<span class="asset-nav-label">All Assets/);
    });

    it('a category with default presence marks only that category current', async () => {
      const { id, category } = await setupNavHttpProject('Aria Category');
      const res2 = await agent.get(`/projects/${id}/assets?category=${category.id}`).expect(200);
      expect(countAriaCurrent(res2.text)).toBe(1);
      expect(res2.text).toMatch(/aria-current="page">\s*<span class="asset-nav-label">Renders/);
    });

    it('uncategorized with default presence marks only Uncategorized current', async () => {
      const { id } = await setupNavHttpProject('Aria Uncategorized');
      const res2 = await agent.get(`/projects/${id}/assets?category=uncategorized`).expect(200);
      expect(countAriaCurrent(res2.text)).toBe(1);
      expect(res2.text).toMatch(/aria-current="page">\s*<span class="asset-nav-label">Uncategorized/);
    });

    it('presence=missing with category=all marks only Missing Assets current', async () => {
      const { id } = await setupNavHttpProject('Aria Missing');
      const res2 = await agent.get(`/projects/${id}/assets?presence=missing`).expect(200);
      expect(countAriaCurrent(res2.text)).toBe(1);
      expect(res2.text).toMatch(/aria-current="page">\s*<span class="asset-nav-label">Missing Assets/);
    });

    it('category + presence=missing (composed filter) marks no navigation item current', async () => {
      const { id, category } = await setupNavHttpProject('Aria Composed');
      const res2 = await agent.get(`/projects/${id}/assets?category=${category.id}&presence=missing`).expect(200);
      expect(countAriaCurrent(res2.text)).toBe(0);
    });

    it('category=all + presence=present marks no navigation item current', async () => {
      const { id } = await setupNavHttpProject('Aria All Present');
      const res2 = await agent.get(`/projects/${id}/assets?presence=present`).expect(200);
      expect(countAriaCurrent(res2.text)).toBe(0);
    });

    it('malformed category input normalizes to All and marks only All current', async () => {
      const { id } = await setupNavHttpProject('Aria Malformed');
      const res2 = await agent.get(`/projects/${id}/assets?category=not-a-real-id`).expect(200);
      expect(countAriaCurrent(res2.text)).toBe(1);
      expect(res2.text).toMatch(/aria-current="page">\s*<span class="asset-nav-label">All Assets/);
    });

    it('never renders more than one aria-current="page" across the composed-filter matrix', async () => {
      const { id, category } = await setupNavHttpProject('Aria Matrix');
      const queries = [
        '',
        `?category=${category.id}`,
        '?category=uncategorized',
        '?presence=missing',
        `?category=${category.id}&presence=missing`,
        '?presence=present',
        '?category=999999',
      ];
      for (const query of queries) {
        const res2 = await agent.get(`/projects/${id}/assets${query}`).expect(200);
        expect(countAriaCurrent(res2.text)).toBeLessThanOrEqual(1);
      }
    });
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
    assetRepo.upsert(id, 'exports/web/social/final.png', {
      filename: 'final.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: null, categoryId: exportsCat.id, nestedPath: 'web/social',
    });
    // Category-root asset.
    assetRepo.upsert(id, 'source/artwork.kra', {
      filename: 'artwork.kra', extension: 'kra', mimeType: 'application/x-krita',
      sizeBytes: 10, modifiedAt: null, categoryId: sourceCat.id, nestedPath: '',
    });
    // Uncategorized project-root asset.
    assetRepo.upsert(id, 'notes.txt', {
      filename: 'notes.txt', extension: 'txt', mimeType: 'text/plain',
      sizeBytes: 10, modifiedAt: null,
    });
    // Uncategorized asset under an unknown nested directory.
    assetRepo.upsert(id, 'unknown/deep/file.txt', {
      filename: 'file.txt', extension: 'txt', mimeType: 'text/plain',
      sizeBytes: 10, modifiedAt: null, nestedPath: 'unknown/deep',
    });

    const res2 = await agent.get(`/projects/${id}/assets?pageSize=100&view=list`).expect(200);
    const html = res2.text;

    expect(html).toMatch(/>final<[\s\S]{0,600}web\/social[\s\S]{0,900}Exports/);
    expect(html).toMatch(/>notes<[\s\S]{0,600}Project root[\s\S]{0,900}Uncategorized/);
    expect(html).toMatch(/>file<[\s\S]{0,600}unknown\/deep[\s\S]{0,900}Uncategorized/);

    // A categorized asset sitting at its category root has no useful
    // secondary location beyond the category label — the placeholder
    // dash is gone and the .asset-location element is omitted entirely.
    const artworkRowMatch = html.match(/<tr[^>]*>[\s\S]*?>artwork<[\s\S]*?<\/tr>/);
    expect(artworkRowMatch).not.toBeNull();
    expect(artworkRowMatch[0]).not.toContain('asset-location');
    expect(artworkRowMatch[0]).not.toContain('—');
    expect(artworkRowMatch[0]).toContain('Source');

    // Full canonical relative paths never appear in the primary row.
    expect(html).not.toContain('exports/web/social/final.png');
    expect(html).not.toContain('source/artwork.kra');
    expect(html).not.toContain('unknown/deep/file.txt');
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
    await createReleaseUsingAsset(id, multi.id, 'Release One', 'idea');
    await createReleaseUsingAsset(id, multi.id, 'Release Two', 'idea');

    const res2 = await agent.get(`/projects/${id}/assets?pageSize=100`).expect(200);
    const html = res2.text;

    expect(html).toMatch(/none[\s\S]{0,900}Not used by a release/);
    expect(html).toMatch(new RegExp(`single\\.png[\\s\\S]{0,900}Solo Release[\\s\\S]{0,200}Attachment`));
    expect(html).toContain('<details class="release-usage-details asset-usage-details">');
    expect(html).toContain('aria-label="Used in 2 releases"');
    expect(html).toContain('Release One');
    expect(html).toContain('Release Two');
    expect(html).toContain(`/releases/${relA}`);
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
    expect(res2.text).toMatch(/Old Stuff[\s\S]{0,40}\(disabled\)/);
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

  async function createEmptyRelease(projectId, title = 'Bulk Target', status = 'idea') {
    const res = await agent
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return Number(res.headers.location.replace('/releases/', ''));
  }

  describe('page-local selection markup', () => {
    it('renders an enabled checkbox for present assets and a disabled one for missing assets, each with an accessible filename label', async () => {
      const res = await createProject('Selection Markup');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('Selection Markup');
      const present = writeIndexedAsset(id, projectDir, 'present.png', await makePng());
      const missing = writeIndexedAsset(id, projectDir, 'gone.png', await makePng());
      assetRepo.markMissingByProjectIdAndPathNotIn(id, ['present.png']);

      const res2 = await agent.get(`/projects/${id}/assets?view=list`).expect(200);
      const html = res2.text;

      expect(html).toContain(`<input type="checkbox" form="bulk-select-form" name="selectedAssetIds" value="${present.id}"`);
      expect(html).toContain(`aria-label="Select present.png"`);
      expect(html).toContain('aria-label="gone.png is missing at last scan and cannot be selected"');
      // The missing row's checkbox is disabled and carries no selectable value/name.
      const missingRowMatch = html.match(/<tr class="is-missing">[\s\S]*?<\/tr>/);
      expect(missingRowMatch).not.toBeNull();
      expect(missingRowMatch[0]).toContain('<input type="checkbox" disabled');
      expect(missingRowMatch[0]).not.toContain('name="selectedAssetIds"');
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

      expect(rejected.text).toMatch(new RegExp(`class="asset-card is-selected"\\s+data-asset-id="${asset.id}"`));
      expect(rejected.text).toContain(`name="selectedAssetIds" value="${asset.id}"`);
      expect(rejected.text).toContain('checked');
    });

    it('states that selection is page-local', async () => {
      const res = await createProject('Selection Scope Note');
      const id = res.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('Selection Scope Note');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res2.text).toContain('Selection applies to this page.');
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
      const releaseId = await createReleaseUsingAsset(id, already.id, 'Mixed Release', 'idea');

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

    // Phase: asset actions chunk 4 added rename/move as real routes — see
    // the dedicated 'POST /projects/:projectId/assets/:assetId/rename' and
    // '.../move' describe blocks below for their full behavior. Delete,
    // upload, and replace remain deliberately out of scope.
    it('does not expose a filesystem-mutation route (delete/upload/replace)', async () => {
      const res = await createProject('No Filesystem Actions');
      const id = Number(res.headers.location.replace('/projects/', ''));
      const projectDir = getProjectDir('No Filesystem Actions');
      const asset = writeIndexedAsset(id, projectDir, 'a.png', await makePng());

      for (const path_ of [
        `/projects/${id}/assets/${asset.id}/delete`,
        `/projects/${id}/assets/${asset.id}/replace`,
        `/projects/${id}/assets/upload`,
      ]) {
        await agent.post(path_).type('form').send({ _csrf: csrfToken }).expect(404);
      }
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

    it('explains that disabled categories are still scanned', async () => {
      const res = await createProject('Scan Disabled Category Note');
      const id = res.headers.location.replace('/projects/', '');
      const res2 = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res2.text).toContain('Disabled categories are still scanned');
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
      it('renders a File actions card with distinct Rename and Move subsections, CSRF fields, and no duplicate H1', async () => {
        const { id, asset } = await setupProjectWithAsset('Viewer Forms Mutable');

        const res = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);

        // One card section and card container.
        expect(res.text).toContain('class="asset-actions-section"');
        expect(res.text).toContain('class="asset-actions-card"');
        expect(res.text).toContain('File actions');

        // Distinct subsection headings.
        expect(res.text).toContain('<h3>Rename file</h3>');
        expect(res.text).toContain('<h3>Move file</h3>');

        // Divider between the two groups.
        expect(res.text).toContain('class="asset-actions-divider"');

        // Both forms present and independent.
        expect(res.text).toContain(`action="/projects/${id}/assets/${asset.id}/rename"`);
        expect(res.text).toContain(`action="/projects/${id}/assets/${asset.id}/move"`);

        // No nested forms — verify each form open tag is followed by its own close tag before the next open.
        const formOpenCount = (res.text.match(/<form\b/g) || []).length;
        const formCloseCount = (res.text.match(/<\/form>/g) || []).length;
        expect(formOpenCount).toBe(formCloseCount);

        // No duplicate H1.
        expect((res.text.match(/<h1\b/g) || []).length).toBe(1);

        // Both forms carry their own CSRF hidden input.
        const cardHtml = res.text.slice(res.text.indexOf('class="asset-actions-card"'));
        expect((cardHtml.match(/name="_csrf"/g) || []).length).toBeGreaterThanOrEqual(2);
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

        expect(res.text).toContain('<p class="asset-primary-image-status">Primary image</p>');
        expect(res.text).toContain(`action="/projects/${id}/assets/${asset.id}/primary-image/remove"`);
        expect(res.text).toContain('>Remove primary image</button>');
        expect(res.text).not.toContain('>Set as primary image</button>');
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

        expect(res.text).toContain('Primary image — unavailable until restored');
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

        expect(res.text).toContain('Primary image — unavailable until restored');
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
        expect(mergedSelected.text).toContain('<p class="asset-primary-image-status">Primary image</p>');
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

        expect(res.text).toContain('<p class="asset-primary-image-status">Primary image</p>');
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/primary-image"`);
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/primary-image/remove"`);
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/rename"`);
        expect(res.text).not.toContain(`action="/projects/${id}/assets/${asset.id}/move"`);
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
        expect(firstLocation.searchParams.has('returnUrl')).toBe(false);
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(first.id).id).toBe(first.asset.id);

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
        expect(location.searchParams.has('returnUrl')).toBe(false);
        expect(app.locals.projectPrimaryImageService.getPrimaryImage(id)).toBeUndefined();

        const viewer = await agent.get(removed.headers.location).expect(200);
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
          .send({ filename: 'new.png', category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets/${asset.id}`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('notice')).toBe('asset-renamed');
        expect(fs.existsSync(path.join(projectDir, 'new.png'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'old.png'))).toBe(false);

        const res2 = await agent.get(res.headers.location).expect(200);
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

    // ─── Move POST ───────────────────────────────────────────────────────

    describe('POST /projects/:projectId/assets/:assetId/move', () => {
      it('moves the file to an enabled category successfully', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Move Success Category');
        const category = makeEnabledCategory(id, projectDir, 'renders-move-success');

        const res = await agent
          .post(`/projects/${id}/assets/${asset.id}/move`)
          .send({ destinationCategory: String(category.id), category: 'all', _csrf: csrfToken })
          .type('form')
          .expect(302);

        const location = new URL(res.headers.location, 'http://localhost');
        expect(location.pathname).toBe(`/projects/${id}/assets/${asset.id}`);
        expect(location.searchParams.get('category')).toBe('all');
        expect(location.searchParams.get('notice')).toBe('asset-moved');

        const updated = assetRepo.findById(asset.id);
        expect(updated.category_id).toBe(category.id);
        expect(fs.existsSync(path.join(projectDir, 'renders-move-success', 'a.png'))).toBe(true);
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
        const card = res.text.match(new RegExp(`<article class="asset-card(?: is-selected)?"\\s+data-asset-id="${asset.id}"[^>]*>[\\s\\S]*?<\\/article>`));
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

      it('renders Move selected controls inside the bulk form with enabled categories only', async () => {
        const { id, projectDir, asset } = await setupProjectWithAsset('Bulk Move Form', 'a.png');
        const enabled = makeEnabledCategory(id, projectDir, 'bulk-enabled', 'Bulk Enabled');
        assetCategoryRepo.addProjectCategory({
          projectId: id, displayName: 'Bulk Disabled', directorySlug: 'bulk-disabled', displayOrder: 1, enabled: false,
        });

        for (const query of ['', '?view=grid']) {
          const res = await agent.get(`/projects/${id}/assets${query}`).expect(200);
          const bulk = res.text.match(/<form id="bulk-select-form"[\s\S]*?<\/form>/);
          expect(bulk).not.toBeNull();
          expect(bulk[0]).toContain('>Uncategorized</option>');
          expect(bulk[0]).toContain(`value="${enabled.id}">Bulk Enabled</option>`);
          expect(bulk[0]).not.toContain('Bulk Disabled');
          expect(bulk[0]).toContain('data-bulk-submit');
          expect(bulk[0]).toContain(`formaction="/projects/${id}/assets/move-selected"`);
          expect(bulk[0]).toContain('action="/projects/' + id + '/assets/add-to-release"');
          expect(res.text).toMatch(new RegExp(`<input type="checkbox" form="bulk-select-form"[^>]*name="selectedAssetIds" value="${asset.id}"`));
          expect((res.text.match(/<h1\b/g) || []).length).toBe(1);
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
