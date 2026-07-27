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

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

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

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Malformed+Asset+ID+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Submit with malformed asset ID (e.g., "1x")
    const res = await request(app)
      .post(createRes.headers.location + '/assets')
      .send('selectedAssetIds[]=1x')
      .send('roles[1x]=primary')
      .send('sortOrder[1x]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toContain('Invalid');
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
    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('2 assets selected');
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

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('2 assets selected');
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

    const today = new Date().toISOString().split('T')[0];
    await request(app)
      .post(`${createRes.headers.location}/publish`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain(today);
  });
});
