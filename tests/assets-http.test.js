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
import slugify from '@sindresorhus/slugify';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset browser HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-browser-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    assetRepo = createAssetRepository(db);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
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
    expect(res2.text).toContain('Clear filters');
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
});
