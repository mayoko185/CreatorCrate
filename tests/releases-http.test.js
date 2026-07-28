import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { getLocalTodayIso } from '../src/util/date.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Query release_assets junction table directly for a release.
 * Returns rows with asset_id, role, sort_order.
 */
function getReleaseAssets(db, releaseId) {
  return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC').all(releaseId);
}

describe('release HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Release list ─────────────────────────────────────────────────────────

  it('release list renders', async () => {
    const res = await request(app).get('/releases').expect(200);
    expect(res.text).toContain('Releases');
    expect(res.text).toContain('No releases');
  });

  it('release list shows releases from all projects', async () => {
    // Create a project first
    const projRes = await request(app)
      .post('/projects')
      .send('title=List+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create releases
    await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Release+One')
      .send('status=idea')
      .send('plannedDate=2026-12-01')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Release+Two')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app).get('/releases').expect(200);
    expect(res.text).toContain('Release One');
    expect(res.text).toContain('Release Two');
  });

  it('release list filters by status', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Filter+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Idea+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Planned+Release')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app).get('/releases?status=idea').expect(200);
    expect(res.text).toContain('Idea Release');
    expect(res.text).not.toContain('Planned Release');
  });

  // ─── Create release ────────────────────────────────────────────────────────

  it('new-release form renders with project selection', async () => {
    // Create a project first
    const projRes = await request(app)
      .post('/projects')
      .send('title=New+Release+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app).get('/releases/new').expect(200);
    expect(res.text).toContain('Create Release');
    expect(res.text).toContain('New Release Test');
  });

  it('valid create request redirects to detail', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Create+Redirect+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Test+Release')
      .send('description=A+test+release')
      .send('status=idea')
      .send('plannedDate=2026-12-01')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toMatch(/^\/releases\/\d+$/);
  });

  it('invalid create request rerenders with values and errors', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Error+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=')
      .send('status=invalid')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Title is required');
  });

  it('missing project returns error', async () => {
    const res = await request(app)
      .post('/releases')
      .send('projectId=99999')
      .send('title=Orphan+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Project not found');
  });

  it('malformed projectId is rejected', async () => {
    const res = await request(app)
      .post('/releases')
      .send('projectId=1junk')
      .send('title=Bad+Id+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Project is required');
  });

  // ─── Release detail ───────────────────────────────────────────────────────

  it('release detail renders', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Detail+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Detail+View+Test')
      .send('status=idea')
      .send('plannedDate=2026-12-01')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const location = createRes.headers.location;
    const res = await request(app).get(location).expect(200);
    expect(res.text).toContain('Detail View Test');
    expect(res.text).toContain('Edit');
    expect(res.text).toContain('Manage Assets');
  });

  it('missing release returns 404', async () => {
    await request(app).get('/releases/9999').expect(404);
  });

  it('invalid release id returns 404', async () => {
    await request(app).get('/releases/abc').expect(404);
  });

  // ─── Edit release ─────────────────────────────────────────────────────────

  it('edit form renders with existing values', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Edit+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Before+Edit')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app).get(`${createRes.headers.location}/edit`).expect(200);
    expect(res.text).toContain('Edit Release');
    expect(res.text).toContain('Before Edit');
  });

  it('valid update redirects to detail', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Update+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Old+Title')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app)
      .post(createRes.headers.location)
      .send('title=New+Title')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Title');
  });

  // ─── Publish ───────────────────────────────────────────────────────────────

  it('publish action sets published_date and redirects', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Publish+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=To+Publish')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app)
      .post(`${createRes.headers.location}/publish`)
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('Published');
  });

  it('cannot publish already published release', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Already+Published+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Already+Published')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await request(app)
      .post(`${createRes.headers.location}/publish`)
      .expect(302);

    const res = await request(app)
      .post(`${createRes.headers.location}/publish`)
      .expect(422);
    expect(res.text).toContain('already published');
  });

  // ─── Archive ──────────────────────────────────────────────────────────────

  it('archive action sets archived_at and redirects', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Archive+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=To+Archive')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app)
      .post(`${createRes.headers.location}/archive`)
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('Archived');
  });

  it('cannot archive already archived release', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Double+Archive+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Double+Archive')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await request(app)
      .post(`${createRes.headers.location}/archive`)
      .expect(302);

    const res = await request(app)
      .post(`${createRes.headers.location}/archive`)
      .expect(422);
    expect(res.text).toContain('already archived');
  });

  // ─── Asset selection ──────────────────────────────────────────────────────

  it('asset selection page renders project assets', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Asset+Selection+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Scan to create assets
    await request(app)
      .post(`/projects/${projectId}/scan`)
      .expect(302);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Asset+Selection+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app)
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    expect(res.text).toContain('Asset Selection Release');
    expect(res.text).toContain('Back to Release');
  });

  it('asset selection requires assets from correct project', async () => {
    const proj1Res = await request(app)
      .post('/projects')
      .send('title=Project+One')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId1 = proj1Res.headers.location.replace('/projects/', '');

    const proj2Res = await request(app)
      .post('/projects')
      .send('title=Project+Two')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId2 = proj2Res.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId1}`)
      .send('title=Cross+Project+Test')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Verify the release is associated with project 1
    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('Project One');
  });

  it('asset selection form submission with explicit fields saves selections', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Asset+Form+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create a file and scan
    const getProjectDir = () => {
      const slug = 'asset-form-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };

    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'file1.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'file2.txt'), 'txt');

    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    // Get the actual asset ID from the database
    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const firstAssetId = String(assets[0].id);

    // Create a release
    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Asset+Form+Test+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit asset selection using the new explicit format
    const submitRes = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${firstAssetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Verify redirect back to assets page
    expect(submitRes.headers.location).toContain('/assets');

    // Verify exact junction-table rows
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ asset_id: Number(firstAssetId), role: 'primary', sort_order: 0 });
  });

  it('rejects malformed asset IDs with 422', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Malformed+Asset+ID+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'malformed-asset-id-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'mid.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Malformed+Asset+ID+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with malformed asset ID (e.g., "1x")
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[]=1x')
      .send('roles[1x]=primary')
      .send('sortOrder[1x]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toContain('Invalid');

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('publish only works for ready status releases', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Publish+Ready+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create release with idea status
    const ideaRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Idea+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Publishing idea status should fail
    const publishRes = await request(app)
      .post(`${ideaRes.headers.location}/publish`)
      .expect(422);
    expect(publishRes.text).toContain('ready');
  });

  // ─── Error rendering safety ───────────────────────────────────────────────

  it('error responses contain no absolute filesystem paths', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=No+Path+Release+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=No+Path+Release')
      .send('status=invalid')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).not.toMatch(/[A-Z]:\\/);
  });

  // ─── Phase 5 release-readiness: regression coverage ────────────────────────

  it('asset selection form accepts a no-JS submission (only selectedAssetIds sent)', async () => {
    // Simulates a browser submission without JavaScript: the role and sortOrder
    // fields are disabled for newly-checked rows, so the browser never sends
    // them. The server must accept this and apply sensible defaults rather
    // than rejecting the submission.
    const projRes = await request(app)
      .post('/projects')
      .send('title=NoJS+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create a file and scan
    const getProjectDir = () => {
      const slug = 'no-js-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };

    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'b.txt'), 'txt');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const firstAssetId = String(assets[0].id);
    const secondAssetId = String(assets[1].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=NoJS+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submission with ONLY selectedAssetIds — no roles[], no sortOrder[].
    // The browser renumbers arrays after excluding disabled controls, so the
    // server receives an array of asset ids and no role/sortOrder values.
    const submitRes = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${firstAssetId}`)
      .send(`selectedAssetIds[]=${secondAssetId}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(submitRes.headers.location).toContain('/assets');

    // Both assets should be selected with the default role (attachment) and
    // default sort order (0). The route must not have thrown.
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('attachment');
    expect(rows[0].sort_order).toBe(0);
    expect(rows[1].role).toBe('attachment');
    expect(rows[1].sort_order).toBe(0);
  });

  it('asset selection form accepts a partial-JS submission (selectedAssetIds plus one role)', async () => {
    // Realistic case: a user enables JS for some rows but not others. The
    // browser renumbers arrays after excluding disabled controls. The server
    // must still accept the submission.
    const projRes = await request(app)
      .post('/projects')
      .send('title=PartialJS+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'partial-js-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'one.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'two.txt'), 'txt');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    const firstAssetId = String(assets[0].id);
    const secondAssetId = String(assets[1].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=PartialJS+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Two selected, but only one role / sortOrder pair. The second selected
    // asset will fall back to defaults. This mirrors what the browser sends
    // when the second row's role/sortOrder are disabled.
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${firstAssetId}`)
      .send(`selectedAssetIds[]=${secondAssetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=7')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(2);
    // Ordered by sort_order ASC, asset_id ASC — second asset has sort_order 0 so it comes first
    expect(rows[0]).toEqual({ asset_id: Number(secondAssetId), role: 'attachment', sort_order: 0 });
    expect(rows[1]).toEqual({ asset_id: Number(firstAssetId), role: 'primary', sort_order: 7 });
  });

  it('asset validation failure preserves submitted selections in the re-rendered form', async () => {
    // The 422 response must re-render the assets form with the SUBMITTED
    // selections (asset ids + roles + sort orders) so the user does not lose
    // their input — it must NOT load the persisted selections from the DB.
    //
    // We trigger a 422 by submitting a cross-project asset. To make the
    // preservation visible, the release already has a PERSISTED selection
    // (asset A as primary) and the user submits a DIFFERENT selection
    // (asset A as preview, plus a cross-project asset). The 422 must render
    // the form with "preview" selected, NOT "primary" — proving the form
    // reflects the submission, not the persisted state.
    const projRes = await request(app)
      .post('/projects')
      .send('title=Preserve+Selection+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Sibling project — used to create a cross-project asset id.
    const proj2Res = await request(app)
      .post('/projects')
      .send('title=Other+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const otherProjectId = proj2Res.headers.location.replace('/projects/', '');

    const getProjectDir = (slug) => {
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const mainDir = getProjectDir('preserve-selection-test');
    fs.writeFileSync(path.join(mainDir, 'main.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const otherDir = getProjectDir('other-project');
    fs.writeFileSync(path.join(otherDir, 'other.png'), 'png');
    await request(app).post(`/projects/${otherProjectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const mainAssets = assetRepo.findByProjectId(Number(projectId));
    const otherAssets = assetRepo.findByProjectId(Number(otherProjectId));
    expect(mainAssets.length).toBeGreaterThan(0);
    expect(otherAssets.length).toBeGreaterThan(0);
    const mainAssetId = mainAssets[0].id;
    const otherAssetId = otherAssets[0].id;

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Preserve+Selection+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection: asset A as primary, sort order 0.
    // This is what the user sees if the route falls back to the DB on
    // validation failure — the regression we are guarding against.
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${mainAssetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]).toEqual({ asset_id: mainAssetId, role: 'primary', sort_order: 0 });

    // Now submit a DIFFERENT selection: change the role to "preview" and
    // add a cross-project asset. This must produce a 422 from the service.
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${mainAssetId}`)
      .send(`selectedAssetIds[]=${otherAssetId}`)
      .send('roles[]=preview')
      .send('roles[]=attachment')
      .send('sortOrder[]=5')
      .send('sortOrder[]=9')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // Validation error must be present
    expect(res.text).toMatch(/does not belong to the release/i);

    // The re-rendered form must reflect the SUBMITTED role ("preview"), not
    // the PERSISTED role ("primary"). This is the regression assertion.
    expect(res.text).toMatch(/<option value="preview" selected/);
    expect(res.text).not.toMatch(/<option value="primary" selected/);

    // The submitted sort order (5) must be present, and the persisted one
    // (0) must not — the input for asset A must show the new value.
    expect(res.text).toMatch(/value="5"[^>]*class="asset-sort-order"/);
    expect(res.text).not.toMatch(/value="0"[^>]*class="asset-sort-order"/);

    // The submitted main asset must be checked.
    expect(res.text).toContain(`value="${mainAssetId}" checked`);

    // Persisted rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  // ─── Phase 6D: duplicate rejection, form-state preservation, DB assertions ──

  it('rejects duplicate asset IDs with 422 and no junction rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Duplicate+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'duplicate-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'dup.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Duplicate+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit the same asset ID twice
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('roles[]=attachment')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/duplicate/i);

    // No junction rows must remain after rejection
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('rejects duplicate string IDs with 422', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Dup+String+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'dup-string-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'dupstr.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Dup+String+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit same ID twice as string values
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send(`selectedAssetIds[]=${assetId}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/duplicate/i);

    // No junction rows were written
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('rejects nested array selectedAssetIds safely', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Nested+Array+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'nested-array-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'nested.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Nested+Array+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with a nested array value (malformed)
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      // Express extended parsing: selectedAssetIds[0][]=1 produces nested array
      .send('selectedAssetIds[0][]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects object selectedAssetIds safely', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Object+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'object-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'obj.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Object+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit with an object value (numeric keys, valid shape) — the route
    // normalizes it to an array and then the duplicate detection catches it.
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[0]=${assetId}`)
      .send(`selectedAssetIds[1]=${assetId}`)
      .send('roles[0]=primary')
      .send('roles[1]=attachment')
      .send('sortOrder[0]=0')
      .send('sortOrder[1]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/duplicate/i);

    // No junction rows were written
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('rejects blank selectedAssetIds safely', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Blank+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'blank-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'blank.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Blank+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with blank asset ID
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[]=')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects non-integer asset IDs safely', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=NonInt+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'non-int-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'ni.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=NonInt+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with float string
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[]=1.5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects negative asset IDs safely', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Neg+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'neg-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'neg.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Neg+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[]=-1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects zero asset IDs safely', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Zero+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'zero-asset-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'zero.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Zero+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('single selected asset + invalid role → 422 and checkbox remains selected', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Single+Asset+Role+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'single-asset-role-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'single.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Single+Asset+Role+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds=${assetId}`)
      .send('roles[0]=primary')
      .send('sortOrder[0]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit one valid asset with an invalid role — triggers 422
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds=${assetId}`)
      .send('roles[0]=invalid-role')
      .send('sortOrder[0]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // The checkbox for the submitted asset must remain checked
    expect(res.text).toContain(`value="${assetId}" checked`);

    // Persisted rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('multiple selected assets + one validation error → all valid selections remain checked', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Multi+Asset+Preserve+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'multi-asset-preserve-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'b.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const assetId1 = String(assets[0].id);
    const assetId2 = String(assets[1].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Multi+Asset+Preserve+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId1}`)
      .send(`selectedAssetIds[]=${assetId2}`)
      .send('roles[]=primary')
      .send('roles[]=attachment')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(2);

    // Submit two valid assets with an invalid role on the second — triggers 422
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId1}`)
      .send(`selectedAssetIds[]=${assetId2}`)
      .send('roles[]=primary')
      .send('roles[]=invalid-role')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // Both submitted checkboxes must remain checked
    expect(res.text).toContain(`value="${assetId1}" checked`);
    expect(res.text).toContain(`value="${assetId2}" checked`);

    // Persisted rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('intentional clear (no selectedAssetIds) succeeds and removes all rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Empty+Selection+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'empty-selection-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'clear.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Empty+Selection+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(getReleaseAssets(db, releaseId)).toHaveLength(1);

    // Submit with no selectedAssetIds at all — should succeed (empty = clear)
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(res.headers.location).toContain('/assets');

    // All junction rows must be removed
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('empty scalar selectedAssetIds= clears all selections', async () => {
    // Regression: selectedAssetIds= as an empty scalar string must be treated
    // as an intentional clear, not a malformed submission.
    const projRes = await request(app)
      .post('/projects')
      .send('title=Empty+Scalar+Clear+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'empty-scalar-clear-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'esc.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Empty+Scalar+Clear+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(getReleaseAssets(db, releaseId)).toHaveLength(1);

    // Submit with selectedAssetIds= (empty scalar) — must succeed and clear
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds=')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(res.headers.location).toContain('/assets');

    // All junction rows must be removed
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('rejects null selectedAssetIds with 422 and preserves rows', async () => {
    // Regression: null must be treated as malformed, not as an intentional clear.
    const projRes = await request(app)
      .post('/projects')
      .send('title=Null+Asset+Reject+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'null-asset-reject-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'null.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Null+Asset+Reject+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with null via JSON body
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send({ selectedAssetIds: null })
      .set('Content-Type', 'application/json')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('malformed object/nested values are rejected safely', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Malformed+Object+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = (slug) => {
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir('malformed-object-test');
    fs.writeFileSync(path.join(projectDir, 'm1.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'm2.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const assetId1 = String(assets[0].id);
    const assetId2 = String(assets[1].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Malformed+Object+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId1}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].asset_id).toBe(Number(assetId1));

    // Submit with selectedAssetIds as an object with numeric keys (extended
    // parsing quirk: selectedAssetIds[0]=1 → { '0': '1' }). The route
    // normalizes this to an array via normalizeSelectedAssetIds.
    // Use a cross-project asset to trigger a validation error (422).
    const proj2Res = await request(app)
      .post('/projects')
      .send('title=Other+Malformed+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const otherProjectId = proj2Res.headers.location.replace('/projects/', '');
    const otherProjectDir = getProjectDir('other-malformed-project');
    fs.writeFileSync(path.join(otherProjectDir, 'other.png'), 'png');
    await request(app).post(`/projects/${otherProjectId}/scan`).expect(302);

    const otherAssets = assetRepo.findByProjectId(Number(otherProjectId));
    expect(otherAssets.length).toBeGreaterThan(0);
    const otherAssetId = String(otherAssets[0].id);

    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[0]=${assetId1}`)
      .send(`selectedAssetIds[1]=${otherAssetId}`)
      .send('roles[0]=primary')
      .send('roles[1]=attachment')
      .send('sortOrder[0]=0')
      .send('sortOrder[1]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // The object shape is normalized to an array, then the cross-project
    // asset triggers a validation error. The key point is 422, not 500.
    expect(res.text).toMatch(/does not belong/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects selectedAssetIds[foo][bar]=1 (nested object with non-numeric keys) and preserves rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Nested+Obj+Key+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'nested-obj-key-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'nok.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Nested+Obj+Key+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with selectedAssetIds[foo][bar]=1 — nested object with non-numeric keys
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[foo][bar]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects selectedAssetIds[foo]=1 (non-numeric key) and preserves rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=NonNumeric+Key+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'non-numeric-key-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'nnk.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=NonNumeric+Key+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with selectedAssetIds[foo]=1 — non-numeric key
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[foo]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects mixed flat and nested values and preserves rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Mixed+Nested+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'mixed-nested-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'mn.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Mixed+Nested+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with mixed flat and nested values — one valid scalar and one nested
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('selectedAssetIds[0][]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('archived release rejection preserves persisted rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Archived+Preserve+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'archived-preserve-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'ap.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Archived+Preserve+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Archive the release
    await request(app)
      .post(`${createRes.headers.location}/archive`)
      .expect(302);

    // Attempt to modify assets on the archived release
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/archived/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);

    // GET the assets page — checkboxes must be disabled, no Save Selection
    const assetsPage = await request(app)
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    // Extract exact checkbox elements — each must contain disabled
    const checkboxRegex = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
    let match;
    let checkboxCount = 0;
    while ((match = checkboxRegex.exec(assetsPage.text)) !== null) {
      checkboxCount++;
      expect(match[0]).toContain('disabled');
    }
    expect(checkboxCount).toBeGreaterThan(0);
    // Save Selection button must not be present
    expect(assetsPage.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
  });

  it('archived parent rejection preserves persisted rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Archived+Parent+Preserve')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'archived-parent-preserve';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'app.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Archived+Parent+Preserve+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Archive the parent project
    await request(app)
      .post(`/projects/${projectId}/archive`)
      .expect(302);

    // Attempt to modify assets — parent is archived
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/archived/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);

    // GET the assets page — checkboxes must be disabled, no Save Selection
    const assetsPage = await request(app)
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    // Extract exact checkbox elements — each must contain disabled
    const checkboxRegex = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
    let match;
    let checkboxCount = 0;
    while ((match = checkboxRegex.exec(assetsPage.text)) !== null) {
      checkboxCount++;
      expect(match[0]).toContain('disabled');
    }
    expect(checkboxCount).toBeGreaterThan(0);
    // Save Selection button must not be present
    expect(assetsPage.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
  });

  it('replacement removes only intentionally deselected rows', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Replacement+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const getProjectDir = () => {
      const slug = 'replacement-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      return path.join(projectsRoot, 'tbd', matching[0]);
    };
    const projectDir = getProjectDir();
    fs.writeFileSync(path.join(projectDir, 'keep.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'remove.png'), 'png');
    await request(app).post(`/projects/${projectId}/scan`).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const keepAssetId = String(assets[0].id);
    const removeAssetId = String(assets[1].id);

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Replacement+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist two selections
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${keepAssetId}`)
      .send(`selectedAssetIds[]=${removeAssetId}`)
      .send('roles[]=primary')
      .send('roles[]=attachment')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(2);

    // Submit with only the first asset — the second should be removed
    await request(app)
      .post(createRes.headers.location + '/assets')
      .send(`selectedAssetIds[]=${keepAssetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]).toEqual({ asset_id: Number(keepAssetId), role: 'preview', sort_order: 5 });
  });

  it('publish preserves an explicit publishedDate submitted with the publish form', async () => {
    // Simulates the detail page's publish button sending a hidden
    // publishedDate field — the route must honor it.
    const projRes = await request(app)
      .post('/projects')
      .send('title=Publish+Date+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Publish+Date+Release')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await request(app)
      .post(`${createRes.headers.location}/publish`)
      .send('publishedDate=2025-12-15')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('2025-12-15');
  });

  it('publish preserves a previously edited publishedDate when publish form omits it', async () => {
    // Simulates: user edits the release and sets a publishedDate, then clicks
    // the publish button (which historically overwrote the date with today).
    const projRes = await request(app)
      .post('/projects')
      .send('title=Edited+Date+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Edited+Date+Release')
      .send('status=ready')
      .send('publishedDate=2025-08-20')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Publish button with no publishedDate in the body — the route must fall
    // back to the release's existing publishedDate.
    await request(app)
      .post(`${createRes.headers.location}/publish`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('2025-08-20');
    expect(detail.text).toContain('Published');
  });

  it('publish uses today when neither the form nor the release has a publishedDate', async () => {
    // The default-to-today path must still work for releases that were never
    // given a date.
    const projRes = await request(app)
      .post('/projects')
      .send('title=Today+Date+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Today+Date+Release')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const today = getLocalTodayIso();
    await request(app)
      .post(`${createRes.headers.location}/publish`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain(today);
  });

  // ─── Phase 6B regression: archived parent gates release mutation controls ──
  //
  // When the parent project is archived the release detail and assets pages
  // must hide the Edit, Archive, Publish, and Manage Assets affordances.
  // The release stays visible (read-only workspace) and the route layer
  // additionally rejects POSTs to the mutation endpoints. The combination
  // prevents users from triggering operations that the service would reject.

  describe('archived parent project gates release mutation controls', () => {
    it('release detail hides Edit, Archive, Publish, and Manage Assets when parent project is archived', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Gated+Controls+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Gated+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Archive the parent project. The release stays active in the DB.
      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);

      const detail = await request(app).get(releaseLocation).expect(200);
      // Read-only notice must be present.
      expect(detail.text).toMatch(/read-only/i);
      // Mutation controls must be hidden.
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(detail.text).not.toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).not.toMatch(/action="\/releases\/\d+\/publish"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('release detail still exposes mutation controls for an active project (regression)', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Active+Controls+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Active+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const detail = await request(app).get(releaseLocation).expect(200);
      // Mutation controls are visible.
      expect(detail.text).toMatch(/href="\/releases\/\d+\/edit"/);
      expect(detail.text).toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).toMatch(/action="\/releases\/\d+\/publish"/);
      expect(detail.text).toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('asset selection page hides Save and disables inputs when parent project is archived', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Gated+Assets+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const getProjectDir = () => {
        const slug = 'gated-assets-project';
        const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
        const matching = entries.filter((e) => e.endsWith(`-${slug}`));
        return path.join(projectsRoot, 'tbd', matching[0]);
      };
      const projectDir = getProjectDir();
      fs.writeFileSync(path.join(projectDir, 'gated.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Gated+Asset+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Archive the parent project.
      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);

      const assets = await request(app)
        .get(`${releaseLocation}/assets`)
        .expect(200);
      // Read-only notice must be present.
      expect(assets.text).toMatch(/read-only/i);
      // Save Selection button must not be rendered.
      expect(assets.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
      // Each checkbox element must contain disabled.
      const checkboxRe = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
      let match;
      let count = 0;
      while ((match = checkboxRe.exec(assets.text)) !== null) {
        count++;
        expect(match[0]).toContain('disabled');
      }
      expect(count).toBeGreaterThan(0);
    });

    it('active project asset selection page has enabled checkboxes and Save button (regression)', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Active+Assets+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const getProjectDir = () => {
        const slug = 'active-assets-project';
        const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
        const matching = entries.filter((e) => e.endsWith(`-${slug}`));
        return path.join(projectsRoot, 'tbd', matching[0]);
      };
      const projectDir = getProjectDir();
      fs.writeFileSync(path.join(projectDir, 'active.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Active+Asset+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const assets = await request(app)
        .get(`${releaseLocation}/assets`)
        .expect(200);
      // Each checkbox element must NOT contain disabled.
      const checkboxRe = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
      let match;
      let count = 0;
      while ((match = checkboxRe.exec(assets.text)) !== null) {
        count++;
        expect(match[0]).not.toContain('disabled');
      }
      expect(count).toBeGreaterThan(0);
      // Save Selection button must exist and not be disabled.
      const saveMatch = assets.text.match(/<button[^>]*type="submit"[^>]*>Save Selection<\/button>/);
      expect(saveMatch).not.toBeNull();
      expect(saveMatch[0]).not.toContain('disabled');
    });

    it('POST /releases/:id update returns 422 when parent project is archived', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Update+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Update+Reject+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      // The update POST must be rejected with 422 because the parent project
      // is archived. The error page must surface the rejection reason.
      const res = await request(app)
        .post(createRes.headers.location)
        .send('title=New+Title')
        .send('status=planned')
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });

    it('POST /releases/:id/publish returns 422 when parent project is archived', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Publish+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Publish+Reject+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app)
        .post(`${createRes.headers.location}/publish`)
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });

    it('POST /releases/:id/archive returns 422 when parent project is archived', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Archive+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archive+Reject+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app)
        .post(`${createRes.headers.location}/archive`)
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });

    it('POST /releases/:id/assets returns 422 when parent project is archived', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Asset+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const getProjectDir = () => {
        const slug = 'asset-reject-archived';
        const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
        const matching = entries.filter((e) => e.endsWith(`-${slug}`));
        return path.join(projectsRoot, 'tbd', matching[0]);
      };
      const projectDir = getProjectDir();
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      expect(assets.length).toBeGreaterThan(0);
      const assetId = String(assets[0].id);

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Asset+Reject+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app)
        .post(`${createRes.headers.location}/assets`)
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });
  });
});
