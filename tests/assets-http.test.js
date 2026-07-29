import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import slugify from '@sindresorhus/slugify';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset browser HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let previewRoot;
  let assetRepo;

  function createProject(title, status = 'tbd') {
    return request(app)
      .post('/projects')
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .send('priority=normal')
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
    const releaseRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = releaseRes.headers.location.replace('/releases/', '');
    await request(app)
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${assetId}`)
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

  function renderedStyle(html) {
    const match = html.match(/<style>([\s\S]*?)<\/style>/);
    if (!match) throw new Error('Rendered page did not include its stylesheet.');
    return match[1];
  }

  beforeEach(() => {
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
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic rendering ────────────────────────────────────────────────

  it('renders asset browser with project title', async () => {
    const res = await createProject('Browser Title Test');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('Assets — Browser Title Test');
    expect(res2.text).toContain('Scan Now');
    expect(res2.text).toContain('Back to Project');
  });

  it('shows scan-freshness wording explaining data is not live', async () => {
    const res = await createProject('Freshness Wording');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('Asset state reflects the last completed scan');
    expect(res2.text).toContain('files are not checked live');
    expect(res2.text).toContain('Failed or incomplete scans do not update this information');
  });

  it('shows total matching result count', async () => {
    const res = await createProject('Count Test');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Count Test');

    // Create and scan files
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'b.jpg'), 'jpg');
    fs.writeFileSync(path.join(projectDir, 'c.txt'), 'txt');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('3 assets found');
  });

  // ─── Presence filter ──────────────────────────────────────────────

  it('defaults to all-assets view', async () => {
    const res = await createProject('Presence Default');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Presence Default');

    fs.writeFileSync(path.join(projectDir, 'present.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Remove the file to create a missing asset
    fs.rmSync(path.join(projectDir, 'present.png'));

    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Remove one file to make it missing
    fs.rmSync(path.join(projectDir, 'file1.png'));
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    fs.rmSync(path.join(projectDir, 'deleted.png'));
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Create a release and link an asset
    const assets = assetRepo.findByProjectId(id);
    const usedAsset = assets.find((a) => a.filename === 'used.png');
    const unusedAsset = assets.find((a) => a.filename === 'unused.png');

    const releaseRes = await request(app)
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Used+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = releaseRes.headers.location.replace('/releases/', '');

    await request(app)
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${usedAsset.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?usage=used`)
      .expect(200);
    expect(res2.text).toContain('used.png');
    expect(res2.text).not.toContain('unused.png');
    expect(res2.text).toContain('Used by 1 release');
  });

  it('shows unused-only assets', async () => {
    const res = await createProject('Unused Filter');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Unused Filter');

    fs.writeFileSync(path.join(projectDir, 'used.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'unused.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const assets = assetRepo.findByProjectId(id);
    const usedAsset = assets.find((a) => a.filename === 'used.png');

    const releaseRes = await request(app)
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Link+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = releaseRes.headers.location.replace('/releases/', '');

    await request(app)
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${usedAsset.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?usage=unused`)
      .expect(200);
    expect(res2.text).toContain('unused.png');
    expect(res2.text).not.toContain('<code>used.png</code>');
    expect(res2.text).toContain('Not used by a release');
  });

  it('invalid usage filter falls back to all', async () => {
    const res = await createProject('Invalid Usage');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Invalid Usage');

    fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Link one present asset to a release
    let assets = assetRepo.findByProjectId(id);
    const presentUsed = assets.find((a) => a.filename === 'present-used.png');

    const releaseRes = await request(app)
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Combine+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseId = releaseRes.headers.location.replace('/releases/', '');

    await request(app)
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${presentUsed.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Remove missing-used from disk so it becomes missing
    fs.rmSync(path.join(projectDir, 'missing-used.png'));
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Query: present + used
    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const assets = assetRepo.findByProjectId(id);
    const asset = assets[0];

    // Create two releases and link the same asset to both
    for (const title of ['First Release', 'Second Release']) {
      const relRes = await request(app)
        .post('/releases')
        .send(`projectId=${id}`)
        .send(`title=${encodeURIComponent(title)}`)
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseId = relRes.headers.location.replace('/releases/', '');

      await request(app)
        .post(`/releases/${releaseId}/assets`)
        .send(`selectedAssetIds=${asset.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
    }

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('Used by 2 releases');
  });

  it('shows release titles and statuses for used assets', async () => {
    const res = await createProject('Release Titles');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Release Titles');

    fs.writeFileSync(path.join(projectDir, 'shared.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const assets = assetRepo.findByProjectId(id);
    const asset = assets[0];

    const relRes = await request(app)
      .post('/releases')
      .send(`projectId=${id}`)
      .send('title=Status+Check+Release')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseId = relRes.headers.location.replace('/releases/', '');

    await request(app)
      .post(`/releases/${releaseId}/assets`)
      .send(`selectedAssetIds=${asset.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('Present at last scan');
  });

  it('uses "Missing at last scan" wording for missing assets', async () => {
    const res = await createProject('Missing Wording');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Missing Wording');

    fs.writeFileSync(path.join(projectDir, 'gone.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    fs.rmSync(path.join(projectDir, 'gone.png'));
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Remove missing-file to make it missing
    fs.rmSync(path.join(projectDir, 'missing-file.txt'));
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);

    // Locate the present-file row and assert its presence element.
    // Match a single <tr>…</tr> that contains the filename without crossing row boundaries.
    const presentRowRe = /<tr>(?:(?!<\/tr>)[\s\S])*present-file\.txt(?:(?!<\/tr>)[\s\S])*<\/tr>/;
    const presentRow = res2.text.match(presentRowRe);
    expect(presentRow).not.toBeNull();
    expect(presentRow[0]).toContain('<span class="asset-present">Present at last scan</span>');
    expect(presentRow[0]).not.toContain('asset-missing');

    // Locate the missing-file row and assert its presence element
    const missingRowRe = /<tr>(?:(?!<\/tr>)[\s\S])*missing-file\.txt(?:(?!<\/tr>)[\s\S])*<\/tr>/;
    const missingRow = res2.text.match(missingRowRe);
    expect(missingRow).not.toBeNull();
    expect(missingRow[0]).toContain('<span class="asset-missing">Missing at last scan</span>');
    expect(missingRow[0]).not.toContain('asset-present');
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Request page 1 with presence filter
    const res2 = await request(app)
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

  it('renders exact canonical pagination URLs for normalized browser filters', async () => {
    const res = await createProject('Canonical Asset URLs');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Canonical Asset URLs');
    if (!projectDir) throw new Error('projectDir not found for Canonical Asset URLs');

    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(projectDir, `File & ${String(i).padStart(2, '0')}.png`), `content${i}`);
    }
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const encodedSearch = encodeURIComponent('File &');
    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid&search=${encodedSearch}&extension=.PNG&presence=present&usage=unused&page=1&pageSize=10&unknown=strip-me`)
      .expect(200);

    const nextMatch = res2.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const href = nextMatch[1].replace(/&amp;/g, '&');
    expect(href).toBe(`/projects/${id}/assets?view=grid&search=File+%26&extension=png&presence=present&usage=unused&page=2&pageSize=10`);

    const nextUrl = new URL(href, 'http://localhost');
    expect(Array.from(nextUrl.searchParams.keys())).toEqual([
      'view', 'search', 'extension', 'presence', 'usage', 'page', 'pageSize',
    ]);
    expect(nextUrl.searchParams.get('search')).toBe('File &');
    expect(nextUrl.searchParams.get('extension')).toBe('png');
    expect(nextUrl.searchParams.get('page')).toBe('2');
    expect(nextUrl.searchParams.has('unknown')).toBe(false);
    expect(nextUrl.searchParams.has('scan_result')).toBe(false);
    // Grid view renders versioned thumbnail URLs for previewable assets,
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Page 99 is out of range for 5 assets at 25/page; page is clamped to 1.
    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?presence=missing`)
      .expect(200);
    expect(res2.text).toContain('No assets match the current filters');
    expect(res2.text).toContain('Reset Filters');
  });

  it('shows empty state for project with no assets', async () => {
    const res = await createProject('No Assets Project');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('No assets found');
    expect(res2.text).toContain('Scan Now');
  });

  // ─── 404 handling ───────────────────────────────────────────────

  it('returns 404 for missing project', async () => {
    await request(app).get('/projects/99999/assets').expect(404);
  });

  it('returns 404 for invalid project id', async () => {
    await request(app).get('/projects/abc/assets').expect(404);
  });

  it('404 response does not contain stack traces', async () => {
    const res = await request(app).get('/projects/99999/assets').expect(404);
    expect(res.text).not.toContain('at ');
    expect(res.text).not.toContain('Error:');
  });

  // ─── Archived project ───────────────────────────────────────────

  it('archived project assets page remains readable', async () => {
    const res = await createProject('Archivable Project');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Archivable Project');

    fs.writeFileSync(path.join(projectDir, 'archivable.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Archive the project
    await request(app).post(`/projects/${id}/archive`).expect(302);

    // Assets page should still render
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('archivable.png');
    expect(res2.text).toContain('Assets — Archivable Project');
  });

  // ─── Manual scan still works ────────────────────────────────────

  it('manual scan route still works after route change', async () => {
    const res = await createProject('Scan Still Works');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Scan Still Works');

    fs.writeFileSync(path.join(projectDir, 'newfile.png'), 'png');

    const scanRes = await request(app)
      .post(`/projects/${id}/scan`)
      .expect(302);

    expect(scanRes.headers.location).toContain(`/projects/${id}/assets`);
  });

  it('scan shows result on redirect', async () => {
    const res = await createProject('Scan Result');
    const id = res.headers.location.replace('/projects/', '');

    // Scan via the redirect-following approach
    const scanRes = await request(app)
      .post(`/projects/${id}/scan`)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Six-digit value exceeds the \d{1,5} allowlist — must not be rendered.
    const res2 = await request(app)
      .get(`/projects/${id}/assets?scan_result=added=123456`)
      .expect(200);

    expect(res2.text).not.toContain('added=123456');
    expect(res2.text).not.toContain('123456');
  });

  it('spoofed scan_error in query string is not rendered as error', async () => {
    const res = await createProject('Spoof Scan Error');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await request(app)
      .get(`/projects/${id}/assets?scan_error=1`)
      .expect(200);

    // Without an actual scan error, this should not show the error message
    expect(res2.text).not.toContain('Scan failed');
  });

  // ─── Relative path and filename display ────────────────────────

  it('renders asset relative path and filename', async () => {
    const res = await createProject('Path Display');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Path Display');

    // Create a nested file
    fs.mkdirSync(path.join(projectDir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'subdir', 'nested.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('nested.png');
    expect(res2.text).toContain('subdir');
    expect(res2.text).toContain('nested.png'); // filename column
    expect(res2.text).toContain('subdir/nested.png'); // relative path
  });

  // ─── Extension display ──────────────────────────────────────────

  it('renders extension column', async () => {
    const res = await createProject('Extension Display');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Extension Display');

    fs.writeFileSync(path.join(projectDir, 'image.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'doc.txt'), 'txt');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('<code>png</code>');
    expect(res2.text).toContain('<code>txt</code>');
  });

  it('filters rendered assets by case-insensitive search and leading-dot extension', async () => {
    const res = await createProject('Search Extension Filter');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Search Extension Filter');

    fs.writeFileSync(path.join(projectDir, 'Hero-Final.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'hero-source.kra'), 'kra');
    fs.writeFileSync(path.join(projectDir, 'other.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?search=no-match&presence=missing&usage=used`)
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

    const res2 = await request(app)
      .get(`/projects/${id}/assets?presence=missing`)
      .expect(200);

    expect(res2.text).toContain('value="missing" selected');
    expect(res2.text).not.toContain('value="present" selected');
  });

  it('filter form shows correct selected state for usage', async () => {
    const res = await createProject('Usage Filter State');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await request(app)
      .get(`/projects/${id}/assets?usage=unused`)
      .expect(200);

    expect(res2.text).toContain('value="unused" selected');
    expect(res2.text).not.toContain('value="used" selected');
  });

  it('reset link points to assets page without filters', async () => {
    const res = await createProject('Reset Link');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await request(app)
      .get(`/projects/${id}/assets?presence=missing&usage=used`)
      .expect(200);

    expect(res2.text).toContain('href="/projects/' + id + '/assets"');
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
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Use pageSize=10 and presence=present to make pagination visible
    const res2 = await request(app)
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

  // ─── Last seen and missing-since dates ─────────────────────────

  it('shows last_seen_at for present assets', async () => {
    const res = await createProject('Last Seen');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Last Seen');

    fs.writeFileSync(path.join(projectDir, 'stable.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    // last_seen_at should be a date/datetime string
    expect(res2.text).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('shows missing_since for missing assets', async () => {
    const res = await createProject('Missing Since');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Missing Since');

    fs.writeFileSync(path.join(projectDir, 'was-there.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    fs.rmSync(path.join(projectDir, 'was-there.png'));
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?presence=missing`)
      .expect(200);
    expect(res2.text).toMatch(/\d{4}-\d{2}-\d{2}/);
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

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.headers['content-type']).toMatch(/html/);
    expect(res2.text).toContain('<title>hero.png — CreatorCrate</title>');
    expect(res2.text).toContain('<h1>hero.png</h1>');
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

  it('renders exact previous, next, and back URLs across pages', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Cross Page');

    const res = await request(app)
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

    const res = await request(app)
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

    const first = await request(app)
      .get(`/projects/${id}/assets/${assets.alpha.id}?pageSize=1`)
      .expect(200);
    expectNoAnchor(first.text, 'asset-viewer-prev');
    expectAnchorHref(first.text, 'asset-viewer-next', `/projects/${id}/assets/${assets.bravo.id}?page=2&pageSize=1`);

    const last = await request(app)
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

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${heroTwo.id}?view=grid&search=${encodeURIComponent('Hero &')}&extension=.PNG&presence=present&usage=unused&page=99&pageSize=1&junk=1`)
      .expect(200);

    const previousHref = `/projects/${id}/assets/${heroOne.id}?view=grid&search=Hero+%26&extension=png&presence=present&usage=unused&pageSize=1`;
    const backHref = `/projects/${id}/assets?view=grid&search=Hero+%26&extension=png&presence=present&usage=unused&page=2&pageSize=1`;
    expectAnchorHref(res2.text, 'asset-viewer-prev', previousHref);
    expectAnchorHref(res2.text, 'asset-viewer-back', backHref);
    expectNoAnchor(res2.text, 'asset-viewer-next');
    expectQueryKeys(previousHref, ['view', 'search', 'extension', 'presence', 'usage', 'pageSize']);
    expectQueryKeys(backHref, ['view', 'search', 'extension', 'presence', 'usage', 'page', 'pageSize']);
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

    const res2 = await request(app)
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

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('Missing at last scan. Preview and original viewing are unavailable.');
    expect(res2.text).toContain('Preview unavailable for missing assets.');
    expect(res2.text).not.toContain('<img ');
    expect(res2.text).not.toContain('/preview?v=');
    expectNoAnchor(res2.text, 'asset-viewer-original');
  });

  it('renders unsupported assets without preview or original links', async () => {
    const res = await createProject('Viewer Unsupported');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Unsupported');
    if (!projectDir) throw new Error('projectDir not found for Viewer Unsupported');
    const asset = writeIndexedAsset(id, projectDir, 'source.kra', 'krita bytes', {
      extension: 'kra',
      mimeType: 'application/x-krita',
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('Unsupported asset preview. This asset type or recorded MIME cannot be previewed inline.');
    expect(res2.text).toContain('Preview unavailable for unsupported assets.');
    expect(res2.text).not.toContain('<img ');
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

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('Unsupported asset preview. This asset type or recorded MIME cannot be previewed inline.');
    expect(res2.text).not.toContain('<img ');
    expect(res2.text).not.toContain('/preview?v=');
    expectNoAnchor(res2.text, 'asset-viewer-original');
  });

  it('renders asset viewers for archived projects', async () => {
    const res = await createProject('Viewer Archived');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Viewer Archived');
    if (!projectDir) throw new Error('projectDir not found for Viewer Archived');
    const asset = writeIndexedAsset(id, projectDir, 'archived.png', await makePng());

    await request(app).post(`/projects/${id}/archive`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expect(res2.text).toContain('Project: Viewer Archived');
    expect(res2.text).toContain('<h1>archived.png</h1>');
  });

  it('rejects malformed viewer project and asset IDs', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Malformed IDs');

    await request(app).get(`/projects/abc/assets/${assets.alpha.id}`).expect(404);
    await request(app).get(`/projects/0/assets/${assets.alpha.id}`).expect(404);
    await request(app).get(`/projects/${id}/assets/abc`).expect(404);
    await request(app).get(`/projects/${id}/assets/0`).expect(404);
    await request(app).get(`/projects/${id}/assets/1.5`).expect(404);
  });

  it('returns 404 for unknown and cross-project viewer assets', async () => {
    const owner = await setupOrderedImageAssets('Viewer Owner');
    const other = await setupOrderedImageAssets('Viewer Other');

    await request(app).get(`/projects/${owner.id}/assets/999999`).expect(404);
    await request(app).get(`/projects/${other.id}/assets/${owner.assets.alpha.id}`).expect(404);
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

    const res2 = await request(app)
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
          getReleaseCalendar: () => ({}),
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

    const thumbnail = await request(app)
      .get(`/projects/${id}/assets/${asset.id}/thumbnail`)
      .expect(200);
    expect(thumbnail.headers['content-type']).toBe('image/webp');

    const preview = await request(app)
      .get(`/projects/${id}/assets/${asset.id}/preview`)
      .expect(200);
    expect(preview.headers['content-type']).toBe('image/webp');

    const original = await request(app)
      .get(`/projects/${id}/assets/${asset.id}/original`)
      .expect(200);
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.body.equals(png)).toBe(true);

    const viewer = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expect(viewer.headers['content-type']).toMatch(/html/);
    expect(viewer.text).toContain('<h1>media.png</h1>');

    const browser = await request(app)
      .get(`/projects/${id}/assets`)
      .expect(200);
    expect(browser.headers['content-type']).toMatch(/html/);
    expect(browser.text).toContain('Assets — Viewer Route Precedence');
  });

  it('meets the server-rendered accessibility baseline for the viewer', async () => {
    const { id, assets } = await setupOrderedImageAssets('Viewer Accessibility');

    const res = await request(app)
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

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain(`<title>${filename} — CreatorCrate</title>`);
    expect(res2.text).toContain(`<h1>${filename}</h1>`);
    expect(res2.text).toContain(`<code>${relativePath}</code>`);
    expect(res2.text).toContain('<code>application/vnd.example.extremely-long-mime-type</code>');
    expect(res2.text).toContain('Long Viewer Release');
  });

  // ─── Phase 10.3A: Server-rendered asset grid ─────────────────────

  function extractCard(html, assetId) {
    const re = new RegExp(
      `<article class="asset-card" data-asset-id="${assetId}">([\\s\\S]*?)</article>`
    );
    const match = html.match(re);
    return match ? match[0] : null;
  }

  it('grid preserves default list rendering when view is omitted', async () => {
    const res = await createProject('Grid Default List');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Default List');
    fs.writeFileSync(path.join(projectDir, 'alpha.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('<table class="asset-table">');
    expect(res2.text).not.toContain('<ul class="asset-grid">');
  });

  it('renders grid markup when view=grid', async () => {
    const res = await createProject('Grid Renders');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Renders');
    const asset = writeIndexedAsset(id, projectDir, 'alpha.png', await makePng());

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).toContain('<ul class="asset-grid">');
    expect(res2.text).not.toContain('<table class="asset-table">');
    expect(res2.text).toContain(`<article class="asset-card" data-asset-id="${asset.id}">`);
  });

  it('grid card count matches browser rows', async () => {
    const res = await createProject('Grid Count');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Count');
    const png = await makePng();
    writeIndexedAsset(id, projectDir, 'one.png', png);
    writeIndexedAsset(id, projectDir, 'two.png', png);
    writeIndexedAsset(id, projectDir, 'three.png', png);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const cardCount = (res2.text.match(/<article class="asset-card"/g) || []).length;
    expect(cardCount).toBe(3);
  });

  it('renders exact viewer link in grid card', async () => {
    const res = await createProject('Grid Viewer Link');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Viewer Link');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expectAnchorHref(res2.text, 'asset-card-link', `/projects/${id}/assets/${asset.id}`);
  });

  it('renders exact versioned thumbnail URL in grid card', async () => {
    const res = await createProject('Grid Thumbnail URL');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Thumbnail URL');
    const asset = writeIndexedAsset(id, projectDir, 'shot.png', await makePng());
    const revision = buildAssetRevisionToken(asset);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).toContain(
      `src="/projects/${id}/assets/${asset.id}/thumbnail?v=${revision}"`
    );
  });

  it('thumbnail has lazy-loading and async decoding attributes', async () => {
    const res = await createProject('Grid Lazy Attrs');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Lazy Attrs');
    writeIndexedAsset(id, projectDir, 'pic.png', await makePng());

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).toContain('loading="lazy"');
    expect(res2.text).toContain('decoding="async"');
    expect(res2.text).toContain('width="256"');
    expect(res2.text).toContain('height="256"');
  });

  it('renders placeholder for unsupported assets in grid', async () => {
    const res = await createProject('Grid Unsupported');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Unsupported');
    const asset = writeIndexedAsset(id, projectDir, 'source.kra', 'kra bytes', {
      extension: 'kra',
      mimeType: 'application/x-krita',
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);
    expect(card).not.toBeNull();
    expect(card).toContain('asset-card-placeholder');
    expect(card).toContain('Unsupported preview');
    expect(card).not.toContain('<img');
  });

  it('renders placeholder for missing assets in grid', async () => {
    const res = await createProject('Grid Missing');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Missing');
    const asset = writeIndexedAsset(id, projectDir, 'gone.png', await makePng());
    assetRepo.markMissingByProjectIdAndPathNotIn(id, []);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);
    expect(card).not.toBeNull();
    expect(card).toContain('asset-card-placeholder-missing');
    expect(card).toContain('Missing at last scan');
    expect(card).not.toContain('<img');
  });

  it('renders placeholder for invalid source metadata in grid', async () => {
    const res = await createProject('Grid Invalid Meta');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Invalid Meta');
    const asset = writeIndexedAsset(id, projectDir, 'badmeta.png', await makePng(), {
      modifiedAt: 'invalid',
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);
    expect(card).not.toBeNull();
    expect(card).toContain('asset-card-placeholder');
    expect(card).toContain('Preview unavailable');
    expect(card).not.toContain('<img');
  });

  it('does not request media URL for non-previewable grid rows', async () => {
    const res = await createProject('Grid No Media');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid No Media');
    writeIndexedAsset(id, projectDir, 'doc.kra', 'kra', {
      extension: 'kra',
      mimeType: 'application/x-krita',
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).not.toContain('/thumbnail');
    expect(res2.text).not.toContain('/preview');
  });

  it('list-to-grid switch URL preserves filters', async () => {
    const res = await createProject('Grid Switch LG');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Switch LG');
    fs.writeFileSync(path.join(projectDir, 'pic.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?presence=present&pageSize=10`)
      .expect(200);
    const gridHref = anchorHref(res2.text, 'view-switcher-grid');
    expect(gridHref).not.toBeNull();
    const url = new URL(gridHref, 'http://localhost');
    expect(url.searchParams.get('view')).toBe('grid');
    expect(url.searchParams.get('presence')).toBe('present');
    expect(url.searchParams.get('pageSize')).toBe('10');
  });

  it('grid-to-list switch URL omits default view and preserves filters', async () => {
    const res = await createProject('Grid Switch GL');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Switch GL');
    fs.writeFileSync(path.join(projectDir, 'pic.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid&presence=present&pageSize=10`)
      .expect(200);
    const listHref = anchorHref(res2.text, 'view-switcher-list');
    expect(listHref).not.toBeNull();
    const url = new URL(listHref, 'http://localhost');
    expect(url.searchParams.has('view')).toBe(false);
    expect(url.searchParams.get('presence')).toBe('present');
    expect(url.searchParams.get('pageSize')).toBe('10');
  });

  it('view switch preserves search, extension, presence, and usage', async () => {
    const res = await createProject('Grid Filter Preserve');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Filter Preserve');
    fs.writeFileSync(path.join(projectDir, 'hero-one.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'hero-two.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?search=hero&extension=.png&presence=present&usage=unused`)
      .expect(200);
    const gridHref = anchorHref(res2.text, 'view-switcher-grid');
    expect(gridHref).not.toBeNull();
    const url = new URL(gridHref, 'http://localhost');
    expect(url.searchParams.get('view')).toBe('grid');
    expect(url.searchParams.get('search')).toBe('hero');
    expect(url.searchParams.get('extension')).toBe('png');
    expect(url.searchParams.get('presence')).toBe('present');
    expect(url.searchParams.get('usage')).toBe('unused');
  });

  it('view switch preserves pageSize', async () => {
    const res = await createProject('Grid PageSize Preserve');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid PageSize Preserve');
    fs.writeFileSync(path.join(projectDir, 'pic.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?pageSize=50`)
      .expect(200);
    const gridHref = anchorHref(res2.text, 'view-switcher-grid');
    expect(gridHref).not.toBeNull();
    const url = new URL(gridHref, 'http://localhost');
    expect(url.searchParams.get('pageSize')).toBe('50');
  });

  it('grid pagination preserves view=grid', async () => {
    const res = await createProject('Grid Pagination View');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Pagination View');
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(projectDir, `file${String(i).padStart(2, '0')}.png`), `c${i}`);
    }
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid&pageSize=10`)
      .expect(200);
    const nextMatch = res2.text.match(/<a href="([^"]+)" class="pagination-next">Next/);
    expect(nextMatch).not.toBeNull();
    const href = nextMatch[1].replace(/&amp;/g, '&');
    const url = new URL(href, 'http://localhost');
    expect(url.searchParams.get('view')).toBe('grid');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('10');
  });

  it('active view is indicated with aria-current', async () => {
    const res = await createProject('Grid Aria Current');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Aria Current');
    fs.writeFileSync(path.join(projectDir, 'pic.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const gridRes = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(gridRes.text).toContain('aria-current="page">Grid');
    expect(gridRes.text).not.toContain('aria-current="page">List');

    const listRes = await request(app)
      .get(`/projects/${id}/assets`)
      .expect(200);
    expect(listRes.text).toContain('aria-current="page">List');
    expect(listRes.text).not.toContain('aria-current="page">Grid');
  });

  it('Reset Filters link preserves view in grid empty state', async () => {
    const res = await createProject('Grid Reset Filters');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Reset Filters');
    fs.writeFileSync(path.join(projectDir, 'pic.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid&presence=missing`)
      .expect(200);
    expect(res2.text).toContain('No assets match the current filters');
    expect(res2.text).toContain('Reset Filters');
    expect(res2.text).toContain(`href="/projects/${id}/assets?view=grid"`);
  });

  it('filter form Reset button preserves view in grid mode', async () => {
    const res = await createProject('Grid Reset Button');
    const id = res.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Grid Reset Button');
    fs.writeFileSync(path.join(projectDir, 'pic.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid&presence=present`)
      .expect(200);
    expect(res2.text).toContain(`href="/projects/${id}/assets?view=grid"`);
  });

  it('renders grid for archived projects', async () => {
    const res = await createProject('Grid Archived');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Archived');
    writeIndexedAsset(id, projectDir, 'archived.png', await makePng());
    await request(app).post(`/projects/${id}/archive`).expect(302);

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).toContain('<ul class="asset-grid">');
    expect(res2.text).toContain('archived.png');
    expect(res2.text).not.toContain('Scan Now');
  });

  it('grid does not render absolute filesystem paths', async () => {
    const res = await createProject('Grid No Paths');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid No Paths');
    writeIndexedAsset(id, projectDir, 'secret.png', await makePng());

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).not.toMatch(/[A-Z]:\\/);
    expect(res2.text).not.toMatch(/\/home\//);
    expect(res2.text).not.toMatch(/\/Users\//);
    expect(res2.text).not.toContain(tmpDir);
    expect(res2.text).not.toContain(projectsRoot);
  });

  it('grid does not embed original file bytes', async () => {
    const res = await createProject('Grid No Bytes');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid No Bytes');
    const secret = 'GRID_SECRET_BYTES_MUST_NOT_RENDER';
    writeIndexedAsset(id, projectDir, 'data.bin', secret, {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).toContain('data.bin');
    expect(res2.text).not.toContain(secret);
  });

  it('grid semantic list structure wraps each card in li with single anchor', async () => {
    const res = await createProject('Grid Semantic');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Semantic');
    writeIndexedAsset(id, projectDir, 'one.png', await makePng());
    writeIndexedAsset(id, projectDir, 'two.png', await makePng());

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const itemCount = (res2.text.match(/<li class="asset-grid-item">/g) || []).length;
    expect(itemCount).toBe(2);
    expect(res2.text).toContain('<article class="asset-card"');
    // Verify no nested anchors: each article has exactly one <a>
    const cardArticle = res2.text.match(/<article class="asset-card"[\s\S]*?<\/article>/);
    expect(cardArticle).not.toBeNull();
    const anchorCount = (cardArticle[0].match(/<a\b/g) || []).length;
    expect(anchorCount).toBe(1);
  });

  it('grid card shows release usage count as text', async () => {
    const res = await createProject('Grid Usage');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Usage');
    const asset = writeIndexedAsset(id, projectDir, 'used.png', await makePng());
    await createReleaseUsingAsset(id, asset.id, 'Grid Release', 'planned');

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);
    expect(card).not.toBeNull();
    expect(card).toContain('Used by 1 release');
  });

  it('grid card shows formatted size and compact type label', async () => {
    const res = await createProject('Grid Meta Display');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Meta Display');
    const asset = writeIndexedAsset(id, projectDir, 'meta.png', await makePng(), {
      sizeBytes: 1536,
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);
    expect(card).not.toBeNull();
    expect(card).toContain('1.5 KB');
    expect(card).toContain('PNG');
  });

  it('grid card alt text is meaningful', async () => {
    const res = await createProject('Grid Alt Text');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Alt Text');
    const first = writeIndexedAsset(id, projectDir, 'preview.png', await makePng());
    const second = writeIndexedAsset(id, projectDir, 'art & final.png', await makePng());

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(extractCard(res2.text, first.id)).toContain('alt="Preview of preview.png"');
    expect(extractCard(res2.text, second.id)).toContain('alt="Preview of art &amp; final.png"');
    expect(res2.text).not.toContain('alt="Thumbnail preview"');
  });

  it('uses a stable asset identifier when a filename is empty', async () => {
    const res = await createProject('Grid Alt Fallback');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('Grid Alt Fallback');
    const relPath = 'unnamed.png';
    const png = await makePng();
    fs.writeFileSync(path.join(projectDir, relPath), png);
    const asset = assetRepo.upsert(id, relPath, {
      filename: '',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: png.length,
      modifiedAt: '2026-07-28 10:00:00',
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(extractCard(res2.text, asset.id)).toContain(`alt="Preview of Asset ${asset.id}"`);
  });

  // ─── Phase 10.3C: Minimal preview enhancement ───────────────────

  it('includes the static client enhancement module exactly once', async () => {
    const res = await createProject('PhaseC Script');
    const id = res.headers.location.replace('/projects/', '');

    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    const scriptCount = (res2.text.match(/<script type="module" src="\/creatorcrate\.js"><\/script>/g) || []).length;

    expect(scriptCount).toBe(1);
  });

  it('serves the dependency-free static client module', async () => {
    const res = await request(app).get('/creatorcrate.js').expect(200);

    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('enhancePreviewMedia');
  });

  it('renders grid thumbnail loading hooks and pre-rendered failure fallback', async () => {
    const res = await createProject('PhaseC Grid Hooks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC Grid Hooks');
    const asset = writeIndexedAsset(id, projectDir, 'hooked.png', await makePng());

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);

    expect(card).not.toBeNull();
    expect(card).toContain('class="asset-card-media" data-preview-enhancement data-preview-state="loading"');
    expect(card).toContain('data-preview-image');
    expect(card).toContain('class="asset-card-placeholder asset-card-fallback" data-preview-fallback hidden>Preview unavailable</span>');
    expect((card.match(/data-preview-image/g) || []).length).toBe(1);
    expect((card.match(/data-preview-fallback/g) || []).length).toBe(1);
  });

  it('does not add image-loading behavior to no-preview grid cards', async () => {
    const res = await createProject('PhaseC No Preview Hooks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC No Preview Hooks');
    const asset = writeIndexedAsset(id, projectDir, 'source.kra', 'kra bytes', {
      extension: 'kra',
      mimeType: 'application/x-krita',
    });

    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);

    expect(card).not.toBeNull();
    expect(card).toContain('asset-card-placeholder-no-preview');
    expect(card).not.toContain('data-preview-enhancement');
    expect(card).not.toContain('data-preview-image');
    expect(card).not.toContain('data-preview-fallback');
  });

  it('renders viewer preview hooks, fallback, and original link independently', async () => {
    const res = await createProject('PhaseC Viewer Hooks');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseC Viewer Hooks');
    const asset = writeIndexedAsset(id, projectDir, 'viewer.png', await makePng());

    const res2 = await request(app)
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

    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);

    expect(res2.text).toContain('<noscript>');
    expect(res2.text).toContain('JavaScript is disabled. If the preview does not load, use View Original to open the asset.');
    expect(res2.text).toContain('data-preview-fallback hidden>Preview unavailable</p>');
    expect(res2.text).toContain('alt="Preview of viewer-fallback.png"');
    expectAnchorHref(res2.text, 'asset-viewer-original', `/projects/${id}/assets/${asset.id}/original`);
    expect(res2.text).not.toContain('aria-live');
  });

  it('renders reduced-motion coverage for preview image transitions', async () => {
    const res = await createProject('PhaseC Reduced Motion');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);

    expect(res2.text).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.asset-card-thumb[\s\S]*\.asset-preview-image[\s\S]*transition: none !important;/
    );
  });

  // ─── Phase 10.3B: Visual hierarchy and responsive styling ─────────

  it('renders design tokens for surfaces, borders, focus, spacing, radius, shadow, and transition', async () => {
    const res = await createProject('PhaseB Tokens');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('--surface-card');
    expect(res2.text).toContain('--border:');
    expect(res2.text).toContain('--border-strong');
    expect(res2.text).toContain('--focus-ring');
    expect(res2.text).toContain('--space-sm');
    expect(res2.text).toContain('--radius-lg');
    expect(res2.text).toContain('--shadow-md');
    expect(res2.text).toContain('--transition-base');
  });

  it('renders responsive grid CSS with auto-fill minmax', async () => {
    const res = await createProject('PhaseB Grid CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('grid-template-columns: repeat(auto-fill, minmax(');
  });

  it('renders aspect-ratio rule on the thumbnail frame', async () => {
    const res = await createProject('PhaseB Aspect');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toMatch(/\.asset-card-media\s*\{[^}]*aspect-ratio/);
  });

  it('renders object-fit contain for grid thumbnail images', async () => {
    const res = await createProject('PhaseB Thumb Fit');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Thumb Fit');
    writeIndexedAsset(id, projectDir, 'pic.png', await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).toMatch(/\.asset-card-thumb\s*\{[^}]*object-fit:\s*contain/);
  });

  it('renders object-fit contain for viewer preview images', async () => {
    const res = await createProject('PhaseB Viewer Fit');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Viewer Fit');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expect(res2.text).toMatch(/\.asset-preview-image\s*\{[^}]*object-fit:\s*contain/);
  });

  it('makes the native hidden attribute authoritative over preview display rules', async () => {
    const res = await createProject('PhaseB Hidden CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    const hiddenRule = '[hidden] { display: none !important; }';

    expect(res2.text).toContain(hiddenRule);
    expect(res2.text).toMatch(/\.asset-card-thumb\s*\{[^}]*display:\s*block/);
    expect(res2.text).toMatch(/\.asset-preview-image\s*\{[^}]*display:\s*block/);
  });

  it('renders placeholder color classes for missing and unsupported assets', async () => {
    const res = await createProject('PhaseB Placeholder CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('.asset-card-placeholder-missing');
    expect(res2.text).toContain('.asset-card-placeholder-no-preview');
  });

  it('renders active view CSS using aria-current attribute selector', async () => {
    const res = await createProject('PhaseB Active CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('[aria-current="page"]');
  });

  it('renders prefers-reduced-motion media query', async () => {
    const res = await createProject('PhaseB Reduced Motion');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('renders focus-visible and focus-within CSS for asset cards', async () => {
    const res = await createProject('PhaseB Focus CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toMatch(/\.asset-card-link:focus-visible/);
    expect(res2.text).toMatch(/\.asset-card:focus-within/);
  });

  it('renders wider content CSS for asset browser and viewer pages', async () => {
    const res = await createProject('PhaseB Wide CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('body.asset-browser-page main');
    expect(res2.text).toContain('body.asset-viewer-page main');
  });

  it('grid card filename has title attribute with full filename', async () => {
    const res = await createProject('PhaseB Title Attr');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Title Attr');
    const longName = 'a-really-long-filename-that-exceeds-typical-card-width.png';
    const asset = writeIndexedAsset(id, projectDir, longName, await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const card = extractCard(res2.text, asset.id);
    expect(card).not.toBeNull();
    expect(card).toContain(`title="${longName}"`);
  });

  it('grid cards have no inline style attributes', async () => {
    const res = await createProject('PhaseB No Inline');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB No Inline');
    writeIndexedAsset(id, projectDir, 'one.png', await makePng());
    writeIndexedAsset(id, projectDir, 'two.png', await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const cardRegex = /<article class="asset-card"[\s\S]*?<\/article>/g;
    const cards = res2.text.match(cardRegex) || [];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card).not.toContain('style=');
    }
  });

  it('grid cards contain no nested interactive elements beyond the single anchor', async () => {
    const res = await createProject('PhaseB No Nested');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB No Nested');
    writeIndexedAsset(id, projectDir, 'one.png', await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    const cardArticle = res2.text.match(/<article class="asset-card"[\s\S]*?<\/article>/);
    expect(cardArticle).not.toBeNull();
    const card = cardArticle[0];
    expect((card.match(/<a\b/g) || []).length).toBe(1);
    expect(card).not.toContain('<button');
    expect(card).not.toContain('<input');
    expect(card).not.toContain('<select');
    expect(card).not.toContain('<textarea');
  });

  it('asset toolbar wrapper groups view switcher and filter form', async () => {
    const res = await createProject('PhaseB Toolbar');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    const toolbarStart = res2.text.indexOf('class="asset-toolbar"');
    expect(toolbarStart).toBeGreaterThan(-1);
    const switcherPos = res2.text.indexOf('class="view-switcher"', toolbarStart);
    const filtersPos = res2.text.indexOf('class="filters"', toolbarStart);
    expect(switcherPos).toBeGreaterThan(toolbarStart);
    expect(filtersPos).toBeGreaterThan(toolbarStart);
  });

  it('renders pagination focus-visible CSS for keyboard accessibility', async () => {
    const res = await createProject('PhaseB Pagination CSS');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toMatch(/\.pagination-prev:focus-visible/);
    expect(res2.text).toMatch(/\.pagination-next:focus-visible/);
  });

  it('renders body class asset-browser-page on the assets listing', async () => {
    const res = await createProject('PhaseB Body Class');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res2.text).toContain('<body class="asset-browser-page">');
  });

  it('renders body class asset-viewer-page on the asset viewer', async () => {
    const res = await createProject('PhaseB Viewer Body');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Viewer Body');
    const asset = writeIndexedAsset(id, projectDir, 'view.png', await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expect(res2.text).toContain('<body class="asset-viewer-page">');
  });

  it('renders thumbnail media wrapper with asset-card-media class in grid', async () => {
    const res = await createProject('PhaseB Media Wrapper');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Media Wrapper');
    writeIndexedAsset(id, projectDir, 'pic.png', await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets?view=grid`)
      .expect(200);
    expect(res2.text).toContain('class="asset-card-media"');
  });

  it('renders viewer preview frame with contained image and responsive max-height', async () => {
    const res = await createProject('PhaseB Viewer Frame');
    const id = Number(res.headers.location.replace('/projects/', ''));
    const projectDir = getProjectDir('PhaseB Viewer Frame');
    const asset = writeIndexedAsset(id, projectDir, 'hero.png', await makePng());
    const res2 = await request(app)
      .get(`/projects/${id}/assets/${asset.id}`)
      .expect(200);
    expect(res2.text).toMatch(/\.asset-preview-image\s*\{[^}]*max-height/);
    expect(res2.text).toMatch(/\.asset-preview-image\s*\{[^}]*object-fit:\s*contain/);
  });

  it('renders a valid non-recursive success token and no undefined custom properties', async () => {
    const res = await createProject('PhaseB Token Validation');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    const style = renderedStyle(res2.text);
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

  it('renders wrapping and containment rules for viewer and grid intrinsic-width content', async () => {
    const res = await createProject('PhaseB Mobile Containment');
    const id = res.headers.location.replace('/projects/', '');
    const res2 = await request(app).get(`/projects/${id}/assets`).expect(200);
    const style = renderedStyle(res2.text);

    expect(style).toMatch(/\.page-header\s*\{[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.page-header > h1\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    expect(style).not.toMatch(/\.page-header > h1\s*\{[^}]*word-break:\s*break-all/);
    expect(style).toMatch(/\.actions \.button\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
    expect(style).toMatch(/\.asset-viewer-breadcrumb\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-viewer-breadcrumb a\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    expect(style).toMatch(/\.detail-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 8rem\) minmax\(0, 1fr\)[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.detail-list code\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    expect(style).toMatch(/\.asset-preview-frame\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-preview-image\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.asset-release-usage-section,[\s\S]*?\.release-status\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(style).toMatch(/\.asset-grid\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(min\(220px, 100%\), 1fr\)/);
    expect(style).toMatch(/\.asset-grid-item\s*\{[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.asset-card\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/\.asset-card-body\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(style).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.asset-metadata\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});
