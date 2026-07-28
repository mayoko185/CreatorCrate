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
import { createReleaseRepository } from '../src/data/release-repository.js';
import { getLocalTodayIso } from '../src/util/date.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Query release_assets junction table directly for a release.
 * Returns rows with asset_id, role, sort_order.
 */
function getReleaseAssets(db, releaseId) {
  return db.prepare('SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC').all(releaseId);
}

/**
 * Helper: create a project, scan a file into it, create a release, and
 * select the scanned asset. Returns { projectId, releaseLocation, assetId }.
 */
async function setupPublishableRelease(app, projectsRoot, db) {
  const projRes = await request(app)
    .post('/projects')
    .send('title=Readiness+Test+Project')
    .send('status=tbd')
    .send('priority=normal')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  const projectId = projRes.headers.location.replace('/projects/', '');

  const slug = 'readiness-test-project';
  const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
  const matching = entries.filter((e) => e.endsWith(`-${slug}`));
  const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
  fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
  await request(app).post(`/projects/${projectId}/scan`).expect(302);

  const assetRepo = createAssetRepository(db);
  const assets = assetRepo.findByProjectId(Number(projectId));
  const assetId = String(assets[0].id);

  const createRes = await request(app)
    .post('/releases')
    .send(`projectId=${projectId}`)
    .send('title=Readiness+Test+Release')
    .send('status=ready')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  const releaseLocation = createRes.headers.location;

  // Select the asset
  await request(app)
    .post(releaseLocation + '/assets')
    .send(`selectedAssetIds[]=${assetId}`)
    .send('roles[]=primary')
    .send('sortOrder[]=0')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);

  return { projectId, releaseLocation, assetId };
}

describe('release HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let releaseRepository;

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
    releaseRepository = createReleaseRepository(db);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Phase 7D-3: Release planning field wording ──────────────────────
  //
  // Release planning fields (planned_date, published_date, patreon_url)
  // describe an individual publication event. Help text must clarify this
  // distinction from project-level planning fields.

  describe('release form planning field wording', () => {
    /**
     * Extract the HTML of the .field container that contains an input with the
     * given id. Returns null if not found.
     */
    function getFieldContainer(html, inputId) {
      const inputRe = new RegExp(`<input[^>]*id="${inputId}"[^>]*>`);
      const inputMatch = inputRe.exec(html);
      if (!inputMatch) return null;
      const inputPos = inputMatch.index;
      const beforeInput = html.slice(0, inputPos);
      const fieldStart = beforeInput.lastIndexOf('<div class="field');
      if (fieldStart === -1) return null;
      const fromField = html.slice(fieldStart);
      let depth = 0;
      let endPos = 0;
      for (let i = 0; i < fromField.length; i++) {
        if (fromField.slice(i, i + 4) === '<div') { depth++; i += 3; }
        else if (fromField.slice(i, i + 5) === '</div') { depth--; i += 4; }
        if (depth === 0) { endPos = i + 6; break; }
      }
      return fromField.slice(0, endPos);
    }

    it('release form shows help text for planned date in the correct field container', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Release+Wording+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await request(app).get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'plannedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('Target publication date for this release');
      expect(container).toMatch(/<input[^>]*id="plannedDate"[^>]*>/);
    });

    it('release form shows help text for published date in the correct field container', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Release+Wording+Pub')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await request(app).get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'publishedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('When this release was published');
      expect(container).toMatch(/<input[^>]*id="publishedDate"[^>]*>/);
    });

    it('release form shows help text for Patreon URL in the correct field container', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Release+Wording+URL')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await request(app).get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'patreonUrl');
      expect(container).not.toBeNull();
      expect(container).toContain('Link to this release on Patreon');
      expect(container).toMatch(/<input[^>]*id="patreonUrl"[^>]*>/);
    });

    it('release detail shows context labels in the correct dt/dd pairs', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Release+Detail+Wording')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Detail+Wording+Release')
        .send('status=idea')
        .send('plannedDate=2025-12-01')
        .send('publishedDate=2025-12-15')
        .send('patreonUrl=https://patreon.com/release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const res = await request(app).get(releaseLocation).expect(200);

      // Planned date: <dt>Planned date</dt> ... <small>(release target)</small>
      const plannedDt = res.text.match(/<dt>Planned date<\/dt>\s*<dd>[^<]*(?:<small>\(release target\)<\/small>)[^<]*<\/dd>/);
      expect(plannedDt).not.toBeNull();

      // Published date: <dt>Published date</dt> ... <small>(release published)</small>
      const publishedDt = res.text.match(/<dt>Published date<\/dt>\s*<dd>[^<]*(?:<small>\(release published\)<\/small>)[^<]*<\/dd>/);
      expect(publishedDt).not.toBeNull();

      // Patreon URL: <dt>Patreon URL</dt> ... <small>(release link)</small>
      // Bounded pattern: cannot cross </dd>, <dt>, or opening <dd>
      const patreonDt = res.text.match(/<dt>Patreon URL<\/dt>\s*<dd>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<small>\(release link\)<\/small>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<\/dd>/);
      expect(patreonDt).not.toBeNull();
    });
  });

  // ─── Phase 7D-3: No readiness impact from legacy project planning values
  //
  // Project-level planning fields (planned_date, published_date, patreon_url)
  // must not affect release readiness evaluation. Readiness is determined
  // solely by release-level fields and asset selection.

  describe('legacy project planning values do not affect readiness', () => {
    /**
     * Create a project and a publishable release (with assets selected).
     * Returns { projectId, releaseId, releaseLocation, assetId }.
     */
    async function setupPublishableForLegacyTest() {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Legacy+Readiness+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'legacy-readiness-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Legacy+Readiness+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId: Number(projectId), releaseId, releaseLocation, assetId: Number(assetId) };
    }

    /**
     * Load readiness facts through the production repository projection and
     * evaluate the policy. Returns { facts, result }.
     */
    function getReadinessFactsAndResult(releaseId) {
      const facts = releaseRepository.findReadinessFactsById(releaseId);
      if (!facts) return null;
      const result = evaluateReleaseReadiness(facts);
      return { facts, result };
    }

    it('project planned_date does not affect release readiness', async () => {
      const { projectId, releaseId, releaseLocation } = await setupPublishableForLegacyTest();

      // Capture readiness facts and policy result before setting the field
      const before = getReadinessFactsAndResult(releaseId);
      expect(before).not.toBeNull();
      expect(before.result.publishable).toBe(true);

      // Set the project planned_date
      await request(app)
        .post(`/projects/${projectId}`)
        .send('title=Legacy+Readiness+Project')
        .send('status=tbd')
        .send('priority=normal')
        .send('plannedDate=2020-01-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Reload readiness facts and re-evaluate
      const after = getReadinessFactsAndResult(releaseId);
      expect(after).not.toBeNull();

      // Assert exact equality — no change to readiness
      expect(after.result.publishable).toBe(before.result.publishable);
      expect(after.result.checks).toEqual(before.result.checks);
      expect(after.result.facts).toEqual(before.result.facts);

      // HTTP assertion: release detail remains correct
      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
    });

    it('project published_date does not affect release readiness', async () => {
      const { projectId, releaseId, releaseLocation } = await setupPublishableForLegacyTest();

      const before = getReadinessFactsAndResult(releaseId);
      expect(before).not.toBeNull();
      expect(before.result.publishable).toBe(true);

      await request(app)
        .post(`/projects/${projectId}`)
        .send('title=Legacy+Readiness+Project')
        .send('status=tbd')
        .send('priority=normal')
        .send('publishedDate=2020-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const after = getReadinessFactsAndResult(releaseId);
      expect(after).not.toBeNull();

      expect(after.result.publishable).toBe(before.result.publishable);
      expect(after.result.checks).toEqual(before.result.checks);
      expect(after.result.facts).toEqual(before.result.facts);

      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
    });

    it('project patreon_url does not affect release readiness', async () => {
      const { projectId, releaseId, releaseLocation } = await setupPublishableForLegacyTest();

      const before = getReadinessFactsAndResult(releaseId);
      expect(before).not.toBeNull();
      expect(before.result.publishable).toBe(true);

      await request(app)
        .post(`/projects/${projectId}`)
        .send('title=Legacy+Readiness+Project')
        .send('status=tbd')
        .send('priority=normal')
        .send('patreonUrl=https://patreon.com/creator')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const after = getReadinessFactsAndResult(releaseId);
      expect(after).not.toBeNull();

      expect(after.result.publishable).toBe(before.result.publishable);
      expect(after.result.checks).toEqual(before.result.checks);
      expect(after.result.facts).toEqual(before.result.facts);

      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
    });

    it('cross-project junction rows are excluded from readiness facts', async () => {
      // Create two projects and a release on project A with an asset from
      // project B in the junction table. The production projection's
      // LEFT JOIN assets ON a.id = ra.asset_id AND a.project_id = r.project_id
      // must exclude the cross-project row from all counts.
      const projARes = await request(app)
        .post('/projects')
        .send('title=Cross+Project+A')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectAId = Number(projARes.headers.location.replace('/projects/', ''));

      const projBRes = await request(app)
        .post('/projects')
        .send('title=Cross+Project+B')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectBId = Number(projBRes.headers.location.replace('/projects/', ''));

      // Scan an asset into project B
      const slugB = 'cross-project-b';
      const entriesB = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matchingB = entriesB.filter((e) => e.endsWith(`-${slugB}`));
      const projectBDir = path.join(projectsRoot, 'tbd', matchingB[0]);
      fs.writeFileSync(path.join(projectBDir, 'asset-b.png'), 'png');
      await request(app).post(`/projects/${projectBId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const assetsB = assetRepo.findByProjectId(projectBId);
      const assetBId = assetsB[0].id;

      // Create a release on project A
      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectAId}`)
        .send('title=Cross+Project+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Insert a malformed cross-project junction row directly
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(releaseId, assetBId, 'primary', 0);

      // Load facts through the production repository projection
      const facts = releaseRepository.findReadinessFactsById(releaseId);
      expect(facts).not.toBeNull();

      // The cross-project asset must be excluded from every count
      expect(facts.selected_asset_count).toBe(0);
      expect(facts.present_selected_asset_count).toBe(0);
      expect(facts.missing_selected_asset_count).toBe(0);
      expect(facts.primary_role_count).toBe(0);
      expect(facts.preview_role_count).toBe(0);
      expect(facts.attachment_role_count).toBe(0);
      expect(facts.source_role_count).toBe(0);

      // The policy must see zero selected assets → not publishable
      const result = evaluateReleaseReadiness(facts);
      expect(result.publishable).toBe(false);
      expect(result.checks.find((c) => c.key === 'assets_selected').passed).toBe(false);
    });
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
    const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

    const res = await request(app)
      .post(`${releaseLocation}/publish`)
      .expect(302);
    expect(res.headers.location).toBe(releaseLocation);

    const detail = await request(app).get(releaseLocation).expect(200);
    expect(detail.text).toContain('Published');
  });

  it('cannot publish already published release', async () => {
    const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

    await request(app)
      .post(`${releaseLocation}/publish`)
      .expect(302);

    const res = await request(app)
      .post(`${releaseLocation}/publish`)
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
    expect(res.text).toMatch(/archived and cannot be modified/);
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
    expect(rows[0]).toMatchObject({ asset_id: Number(firstAssetId), role: 'primary', sort_order: 0 });
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

    // Publishing idea status should fail — readiness policy reports status_ready
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
    expect(rows[0]).toMatchObject({ asset_id: Number(secondAssetId), role: 'attachment', sort_order: 0 });
    expect(rows[1]).toMatchObject({ asset_id: Number(firstAssetId), role: 'primary', sort_order: 7 });
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
    expect(beforeRows[0]).toMatchObject({ asset_id: mainAssetId, role: 'primary', sort_order: 0 });

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
    expect(afterRows[0]).toMatchObject({ asset_id: Number(keepAssetId), role: 'preview', sort_order: 5 });
  });

  it('publish preserves an explicit publishedDate submitted with the publish form', async () => {
    // Simulates the detail page's publish button sending a hidden
    // publishedDate field — the route must honor it.
    const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

    const res = await request(app)
      .post(`${releaseLocation}/publish`)
      .send('publishedDate=2025-12-15')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(res.headers.location).toBe(releaseLocation);

    const detail = await request(app).get(releaseLocation).expect(200);
    expect(detail.text).toContain('2025-12-15');
  });

  it('publish preserves a previously edited publishedDate when publish form omits it', async () => {
    // Simulates: user edits the release and sets a publishedDate, then clicks
    // the publish button (which historically overwrote the date with today).
    const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);

    // Edit the release to set a publishedDate
    await request(app)
      .post(releaseLocation)
      .send('title=Publishable+Release')
      .send('status=ready')
      .send('publishedDate=2025-08-20')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Publish button with no publishedDate in the body — the route must fall
    // back to the release's existing publishedDate.
    await request(app)
      .post(`${releaseLocation}/publish`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await request(app).get(releaseLocation).expect(200);
    expect(detail.text).toContain('2025-08-20');
    expect(detail.text).toContain('Published');
  });

  it('publish uses today when neither the form nor the release has a publishedDate', async () => {
    // The default-to-today path must still work for releases that were never
    // given a date.
    const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

    const today = getLocalTodayIso();
    await request(app)
      .post(`${releaseLocation}/publish`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await request(app).get(releaseLocation).expect(200);
    expect(detail.text).toContain(today);
  });

  // ─── Phase 7C-1: Readiness enforcement HTTP tests ───────────────────────

  it('direct POST with zero assets returns 422 and renders readiness blockers', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Zero+Asset+Publish+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Zero+Asset+Publish')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Direct POST with no assets selected — must be blocked
    const res = await request(app)
      .post(`${createRes.headers.location}/publish`)
      .expect(422);

    // Must render the detail page with readiness panel and blocker feedback
    expect(res.text).toContain('readiness-panel');
    expect(res.text).toContain('Cannot publish');
    expect(res.text).toContain('No assets selected');
  });

  it('direct POST with missing selected asset returns 422', async () => {
    const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);

    // Mark the selected asset as missing
    const assetRepo = createAssetRepository(db);
    assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), []);

    const res = await request(app)
      .post(`${releaseLocation}/publish`)
      .expect(422);

    expect(res.text).toContain('Cannot publish');
    expect(res.text).toContain('missing');
  });

  it('fully publishable release succeeds via POST', async () => {
    const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

    await request(app)
      .post(`${releaseLocation}/publish`)
      .expect(302);
  });

  it('rejected publish does not change database state', async () => {
    const projRes = await request(app)
      .post('/projects')
      .send('title=Rejected+State+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await request(app)
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=Rejected+State+Release')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Verify initial state
    const before = await request(app).get(createRes.headers.location).expect(200);
    expect(before.text).toContain('Status: ready');
    expect(before.text).not.toContain('Published');

    // Attempt publish (will fail — no assets)
    await request(app)
      .post(`${createRes.headers.location}/publish`)
      .expect(422);

    // State must be unchanged
    const after = await request(app).get(createRes.headers.location).expect(200);
    expect(after.text).toContain('Status: ready');
    expect(after.text).not.toContain('Published');
  });

  it('archived release publish rejection remains intact', async () => {
    const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

    // Archive the release
    await request(app)
      .post(`${releaseLocation}/archive`)
      .expect(302);

    // Publish must be rejected
    const res = await request(app)
      .post(`${releaseLocation}/publish`)
      .expect(422);
    expect(res.text).toMatch(/archived/i);
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
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('release detail still exposes mutation controls for an active project (regression)', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      const detail = await request(app).get(releaseLocation).expect(200);
      // Mutation controls are visible.
      expect(detail.text).toMatch(/href="\/releases\/\d+\/edit"/);
      expect(detail.text).toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).toMatch(/href="\/releases\/\d+\/publish"/);
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

    it('POST /releases/:id/publish renders release detail when parent project is archived', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app)
        .post(`${releaseLocation}/publish`)
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toContain('Readiness Test Release');
      expect(res.text).toContain('Readiness Test Project');
      expect(res.text).toContain('asset.png');
      // Archived parent renders read-only detail — no readiness panel, no error-box
      expect(res.text).not.toContain('class="readiness-panel"');
      expect(res.text).not.toContain('class="error-box"');
      expect(res.text).toContain('parent project is archived');
      expect(res.text).toMatch(/Project \d+ is archived and cannot be modified\./);
      expect(db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId)).toEqual(beforeRelease);
      expect(getReleaseAssets(db, releaseId)).toMatchObject([
        { asset_id: Number(assetId), role: 'primary', sort_order: 0 },
      ]);
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

  // ─── Phase 7B-1: Release Detail Readiness Panel ──────────────────────────

  describe('release detail readiness panel', () => {
    it('fully publishable release shows Publishable and all checks pass', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const res = await request(app).get(releaseLocation).expect(200);

      expect(res.text).toContain('Publishable');
      expect(res.text).toContain('Status is ready');
      expect(res.text).toContain('Assets selected');
      expect(res.text).toContain('Selected assets present');
      expect(res.text).toContain('Scope is mutable');
      // All checks pass — no "Needs attention"
      expect(res.text).not.toContain('Needs attention');
    });

    it('non-ready status shows blocked with status detail', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Non+Ready+Status+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Non+Ready+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app).get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('Status: idea');
      expect(res.text).not.toContain('Publishable');
    });

    it('zero selected assets shows blocked with count', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Zero+Selected+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Zero+Selected+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app).get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('0 selected');
    });

    it('missing selected asset shows blocked with missing count', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(app, projectsRoot, db);

      // Mark the selected asset as missing
      const assetRepo = createAssetRepository(db);
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), []);

      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('1 missing');
    });

    it('archived release shows scope blocked', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      // Archive the release
      await request(app)
        .post(`${releaseLocation}/archive`)
        .expect(302);

      const res = await request(app).get(releaseLocation).expect(200);
      // Archived releases show the archived notice instead of readiness panel
      expect(res.text).toContain('archived and read-only');
      expect(res.text).not.toContain('Needs attention');
    });

    it('archived parent project shows scope blocked', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);

      // Archive the parent project
      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);

      const res = await request(app).get(releaseLocation).expect(200);
      // Archived parent shows the parent archived notice instead of readiness panel
      expect(res.text).toContain('parent project is archived');
      expect(res.text).not.toContain('Needs attention');
    });

    it('multiple blockers render simultaneously', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Multiple+Blockers+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create release with idea status and no assets — two blockers
      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Multiple+Blockers+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app).get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('Status: idea');
      expect(res.text).toContain('0 selected');
    });

    it('all four check labels render', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const res = await request(app).get(releaseLocation).expect(200);

      expect(res.text).toContain('Status is ready');
      expect(res.text).toContain('Assets selected');
      expect(res.text).toContain('Selected assets present');
      expect(res.text).toContain('Scope is mutable');
    });

    it('factual selected count renders', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const res = await request(app).get(releaseLocation).expect(200);

      expect(res.text).toContain('1 selected');
    });

    it('last-completed-scan wording renders when blocked', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Scan+Wording+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Scan+Wording+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app).get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Asset presence reflects the last completed scan');
      expect(res.text).toContain('not performing a live filesystem check');
    });

    it('corrective links appear when valid', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Corrective+Links+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Corrective+Links+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app).get(createRes.headers.location).expect(200);
      // Check within the readiness panel section
      const panelMatch = res.text.match(/<section class="readiness-panel">[\s\S]*?<\/section>/);
      expect(panelMatch).not.toBeNull();
      const panelHtml = panelMatch[0];
      // Non-ready status → Edit release link
      expect(panelHtml).toMatch(/href="\/releases\/\d+\/edit"/);
      // No assets selected → Manage assets link
      expect(panelHtml).toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('corrective links hidden for archived release', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      // Archive the release
      await request(app)
        .post(`${releaseLocation}/archive`)
        .expect(302);

      const res = await request(app).get(releaseLocation).expect(200);
      // Archived releases have no readiness panel at all
      expect(res.text).not.toMatch(/<section class="readiness-panel">/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('corrective links hidden for archived parent project', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);

      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);

      const res = await request(app).get(releaseLocation).expect(200);
      // Archived parent releases have no readiness panel at all
      expect(res.text).not.toMatch(/<section class="readiness-panel">/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('missing release remains 404', async () => {
      await request(app).get('/releases/99999').expect(404);
    });

    it('no absolute filesystem paths render', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=No+Path+Readiness+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=No+Path+Readiness+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app).get(createRes.headers.location).expect(200);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    // ─── Phase 7A regression: publication is not enforced yet ──────────────

    it('rejects publish for a blocked release (readiness enforced)', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Enforced+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create a release with ready status (publishable by status) but no
      // assets selected — readiness panel shows blocked, publish must fail.
      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Enforced+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Verify the readiness panel shows it's blocked (no assets selected)
      const detail = await request(app).get(createRes.headers.location).expect(200);
      expect(detail.text).toContain('Needs attention');
      expect(detail.text).toContain('0 selected');

      // Publish must now be rejected — readiness IS enforced
      const publishRes = await request(app)
        .post(`${createRes.headers.location}/publish`)
        .expect(422);
      expect(publishRes.text).toContain('Cannot publish');
    });
  });

  // ─── Phase 7C-3: Readiness Enforcement UI and Regression Verification ──────

  describe('publish action UI gating', () => {
    it('blocked release has no Publish button', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Blocked+No+Publish+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create a ready release with no assets — blocked by assets_selected
      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Blocked+No+Publish')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await request(app).get(createRes.headers.location).expect(200);
      // Readiness panel shows blocked
      expect(detail.text).toContain('Needs attention');
      // Publish button must NOT be present
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('publishable release has Publish button', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      const detail = await request(app).get(releaseLocation).expect(200);
      // Readiness panel shows publishable
      expect(detail.text).toContain('Publishable');
      // Publish button must be present
      expect(detail.text).toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('forged blocked POST still returns 422', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Forged+POST+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Forged+POST+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Direct POST with no assets — server must reject
      const res = await request(app)
        .post(`${createRes.headers.location}/publish`)
        .expect(422);
      expect(res.text).toContain('Cannot publish');
    });

    it('one remaining blocker keeps release blocked', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=One+Blocker+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create a release with idea status — blocked by status_ready
      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=One+Blocker+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await request(app).get(createRes.headers.location).expect(200);
      // Must show blocked
      expect(detail.text).toContain('Needs attention');
      // No Publish button
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('all blockers resolved makes release publishable', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
      expect(detail.text).toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('publication date and status behavior remain correct', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      // Publish with explicit date
      await request(app)
        .post(`${releaseLocation}/publish`)
        .send('publishedDate=2025-11-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Published');
      expect(detail.text).toContain('2025-11-01');
      // Publish button must be gone after publication
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('archive guards remain correct — archived release has no Publish button', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      // Archive the release
      await request(app)
        .post(`${releaseLocation}/archive`)
        .expect(302);

      const detail = await request(app).get(releaseLocation).expect(200);
      // Archived release notice shown
      expect(detail.text).toContain('archived and read-only');
      // No Publish button
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('archived parent project hides Publish button', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);

      // Archive the parent project
      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);

      const detail = await request(app).get(releaseLocation).expect(200);
      // Archived parent notice shown
      expect(detail.text).toContain('parent project is archived');
      // No Publish button
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('published release has no Publish button', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      await request(app)
        .post(`${releaseLocation}/publish`)
        .expect(302);

      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Published');
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('cancelled release has no Publish button', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Cancelled+No+Publish+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Cancelled+No+Publish')
        .send('status=cancelled')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await request(app).get(createRes.headers.location).expect(200);
      // Readiness panel shows blocked (status_ready fails)
      expect(detail.text).toContain('Needs attention');
      // No Publish button
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });
  });

  // ─── Phase 7C-2: Explicit Missing Asset Selection Removal ─────────────────

  describe('missing asset removal', () => {
    /**
     * Helper: create a project, scan a file, create a release, select the asset,
     * then mark it missing. Returns { releaseLocation, assetId, assetRepo }.
     */
    async function setupMissingAsset() {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Missing+Remove+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'missing-remove-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Missing+Remove+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Select the asset
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Mark the asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), []);

      return { releaseLocation, assetId: Number(assetId), projectId: Number(projectId), assetRepo };
    }

    it('missing selection shows Remove action on detail page', async () => {
      const { releaseLocation } = await setupMissingAsset();

      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toContain('Missing');
      expect(res.text).toContain('/remove');
    });

    it('present selection does not show corrective Remove action', async () => {
      const { releaseLocation, projectId } = await setupMissingAsset();
      // Restore the asset to present
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      assetRepo.restorePresent(Number(projectId), [assets[0].relative_path]);

      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toContain('Present');
      // The Remove button is rendered as a form with action containing '/remove'
      expect(res.text).not.toContain('/remove');
    });

    it('forged POST cannot remove a present selected asset', async () => {
      const { releaseLocation, assetId, projectId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Add a second present asset with a distinctive role and sort order
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'second-asset.txt'), 'second content');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== Number(assetId));
      // Select both assets with distinctive roles and sort orders
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .send('sortOrder[]=10')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Snapshot: complete ordered junction rows
      const beforeJunction = getReleaseAssets(db, releaseId);
      // Snapshot: complete asset rows for both assets
      const beforeAsset1 = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(assetId));
      const beforeAsset2 = db.prepare('SELECT * FROM assets WHERE id = ?').get(secondAsset.id);
      // Snapshot: filesystem state for both files
      const file1Path = path.join(projectDir, 'asset.png');
      const file2Path = path.join(projectDir, 'second-asset.txt');
      const beforeFile1Exists = fs.existsSync(file1Path);
      const beforeFile2Exists = fs.existsSync(file2Path);
      const beforeFile1Content = beforeFile1Exists ? fs.readFileSync(file1Path, 'utf-8') : null;
      const beforeFile2Content = beforeFile2Exists ? fs.readFileSync(file2Path, 'utf-8') : null;
      const beforeFile1Size = beforeFile1Exists ? fs.statSync(file1Path).size : null;
      const beforeFile2Size = beforeFile2Exists ? fs.statSync(file2Path).size : null;

      // Attempt to remove the first (present) asset
      await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .expect(422);

      // Assert: junction rows are unchanged
      expect(getReleaseAssets(db, releaseId)).toEqual(beforeJunction);
      // Assert: both asset rows are unchanged
      expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(assetId))).toEqual(beforeAsset1);
      expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(secondAsset.id)).toEqual(beforeAsset2);
      // Assert: both files still exist
      expect(fs.existsSync(file1Path)).toBe(true);
      expect(fs.existsSync(file2Path)).toBe(true);
      // Assert: file contents are unchanged
      expect(fs.readFileSync(file1Path, 'utf-8')).toBe(beforeFile1Content);
      expect(fs.readFileSync(file2Path, 'utf-8')).toBe(beforeFile2Content);
      // Assert: file sizes are unchanged
      expect(fs.statSync(file1Path).size).toBe(beforeFile1Size);
      expect(fs.statSync(file2Path).size).toBe(beforeFile2Size);
      // Assert: no other selection was removed or altered (junction length unchanged)
      expect(getReleaseAssets(db, releaseId)).toHaveLength(2);
    });

    it('POST removes exactly one junction-table row', async () => {
      const { releaseLocation, assetId, projectId } = await setupMissingAsset();

      // Add a second present asset to verify only the missing one is removed
      const slug = 'missing-remove-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'second.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== assetId);
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Mark the first asset as missing again
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), ['second.png']);

      const beforeRows = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));
      expect(beforeRows).toHaveLength(2);

      await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .expect(302);

      const afterRows = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0]).toMatchObject({ asset_id: secondAsset.id, role: 'attachment', sort_order: 1 });
    });

    it('readiness changes from blocked to publishable when last missing asset is removed', async () => {
      const { releaseLocation, assetId, projectId } = await setupMissingAsset();

      // Add a second present asset so removing the missing one leaves a selection
      const slug = 'missing-remove-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'second.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== assetId);
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Mark the first asset as missing again
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), ['second.png']);

      // Verify readiness shows blocked
      const before = await request(app).get(releaseLocation).expect(200);
      expect(before.text).toContain('Needs attention');

      await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .expect(302);

      const after = await request(app).get(releaseLocation).expect(200);
      expect(after.text).toContain('Publishable');
    });

    it('archived scope hides Remove controls and rejects direct POST', async () => {
      const { releaseLocation, assetId } = await setupMissingAsset();

      // Archive the release
      await request(app)
        .post(`${releaseLocation}/archive`)
        .expect(302);

      // Detail page must not show Remove form (check for the form action URL)
      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).not.toContain('/remove');

      // Direct POST must be rejected
      await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .expect(422);
    });

    it('malformed IDs return 404', async () => {
      await request(app)
        .post('/releases/abc/assets/1/remove')
        .expect(404);

      await request(app)
        .post('/releases/1/assets/abc/remove')
        .expect(404);
    });

    it('no GET mutation route exists', async () => {
      await request(app)
        .get('/releases/1/assets/1/remove')
        .expect(404);
    });
  });

  // ─── Phase 7D-1: Release URLs built from normalized allow-listed filters ──
  //
  // Generated release URLs must not retain unknown parameters, invalid values,
  // or malformed inputs from req.query. Only normalized, allow-listed filter
  // values may appear in pagination, view-switching, and page-size links.

  describe('release URL construction from normalized filters', () => {
    /**
     * Parse query parameters from a URL string (handles HTML-escaped &amp;).
     */
    function parseQuery(url) {
      const qIdx = url.indexOf('?');
      if (qIdx === -1) return {};
      // Unescape HTML entities before parsing
      const search = url.slice(qIdx + 1).replace(/&amp;/g, '&');
      const params = new URLSearchParams(search);
      const obj = {};
      for (const [k, v] of params) {
        obj[k] = v;
      }
      return obj;
    }

    it('unknown query parameters are stripped from generated links', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=URL+Strip+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=URL+Strip+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app)
        .get('/releases?view=list&junk=x&status=bogus&project=1junk&pageSize=bad')
        .expect(200);

      // Locate the "Board" link (view switcher) and parse its URL
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      // Valid normalized filters are preserved
      expect(boardQuery.view).toBe('board');
      // Invalid and unknown parameters are absent
      expect(boardQuery.junk).toBeUndefined();
      expect(boardQuery.status).toBeUndefined();
      expect(boardQuery.project).toBeUndefined();
      expect(boardQuery.pageSize).toBeUndefined();
    });

    it('invalid status is not preserved in pagination links', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=URL+Status+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create enough releases to trigger pagination
      for (let i = 0; i < 30; i++) {
        await request(app)
          .post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=URL+Status+Release+${i}`)
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await request(app)
        .get('/releases?status=bogus&page=2')
        .expect(200);

      // Locate the "Previous" pagination link
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      // Invalid status must not appear
      expect(prevQuery.status).toBeUndefined();
      // Page=1 is the default so it's omitted from generated URLs
      expect(prevQuery.page).toBeUndefined();
    });

    it('invalid project ID is not preserved in list-to-board switch', async () => {
      const res = await request(app)
        .get('/releases?project=1junk&view=list')
        .expect(200);

      const boardMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      // Invalid project must not appear
      expect(boardQuery.project).toBeUndefined();
      // View must be board
      expect(boardQuery.view).toBe('board');
    });

    it('invalid pageSize is not preserved in generated links', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=URL+PageSize+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await request(app)
          .post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=URL+PageSize+Release+${i}`)
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await request(app)
        .get('/releases?pageSize=bad&page=2')
        .expect(200);

      // Pagination link must not contain the invalid pageSize
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.pageSize).toBeUndefined();
      // Page=1 is the default so it's omitted from generated URLs
      expect(prevQuery.page).toBeUndefined();
    });

    it('valid filters are preserved through list/board switching', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=URL+Preserve+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=URL+Preserve+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app)
        .get('/releases?status=idea&view=list')
        .expect(200);

      // Board link must preserve the status filter
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.status).toBe('idea');
      expect(boardQuery.view).toBe('board');
    });

    it('default readiness=all is omitted from generated links', async () => {
      const res = await request(app)
        .get('/releases?readiness=all')
        .expect(200);

      // Board link must not contain readiness=all
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.readiness).toBeUndefined();
    });

    it('valid readiness filter is preserved in generated links', async () => {
      const res = await request(app)
        .get('/releases?readiness=publishable')
        .expect(200);

      const boardMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.readiness).toBe('publishable');
    });

    it('invalid readiness is not preserved in generated links', async () => {
      const res = await request(app)
        .get('/releases?readiness=bogus')
        .expect(200);

      const boardMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.readiness).toBeUndefined();
    });

    // ─── Phase 7D-4: Canonical page state in generated URLs ──────────────

    it('page=2 Previous link omits page and retains pageSize', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Page+Canon+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await request(app)
          .post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=Page+Canon+Release+${i}`)
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await request(app)
        .get('/releases?pageSize=10&page=2')
        .expect(200);

      // Previous URL must omit page (page=1 is the default)
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.page).toBeUndefined();
      // pageSize=10 must be retained
      expect(prevQuery.pageSize).toBe('10');
    });

    it('list page 2 → Board link has no page', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Page+Board+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await request(app)
          .post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=Page+Board+Release+${i}`)
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await request(app)
        .get('/releases?page=2')
        .expect(200);

      // Board link must not contain page
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.page).toBeUndefined();
      expect(boardQuery.view).toBe('board');
    });

    it('Board → List link has no stale page', async () => {
      const res = await request(app)
        .get('/releases?view=board')
        .expect(200);

      // List link must not contain page
      const listMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>List<\/a>/);
      expect(listMatch).not.toBeNull();
      const listQuery = parseQuery(listMatch[1]);
      expect(listQuery.page).toBeUndefined();
      expect(listQuery.view).toBe('list');
    });

    it('list page 3 → Previous link contains page=2', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Page+Prev+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 60; i++) {
        await request(app)
          .post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=Page+Prev+Release+${i}`)
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await request(app)
        .get('/releases?page=3')
        .expect(200);

      const prevMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.page).toBe('2');
    });

    it('Next-page URL contains the correct page number', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Page+Next+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await request(app)
          .post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=Page+Next+Release+${i}`)
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await request(app)
        .get('/releases')
        .expect(200);

      const nextMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Next<\/a>/);
      expect(nextMatch).not.toBeNull();
      const nextQuery = parseQuery(nextMatch[1]);
      expect(nextQuery.page).toBe('2');
    });

    it('valid filters remain preserved while page is canonicalized', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Page+Filter+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await request(app)
          .post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=Page+Filter+Release+${i}`)
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await request(app)
        .get('/releases?status=idea&page=2')
        .expect(200);

      // Previous link must retain status=idea and omit page
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.status).toBe('idea');
      expect(prevQuery.page).toBeUndefined();
    });

    it('calendar navigation does not inherit unsupported readiness state', async () => {
      const res = await request(app)
        .get('/releases/calendar?readiness=publishable')
        .expect(200);

      // Calendar nav links must not contain readiness
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/releases\/calendar\?[^"]*)"[^>]*>← Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.readiness).toBeUndefined();
      // Calendar nav must not contain list/board filters
      expect(prevQuery.view).toBeUndefined();
      expect(prevQuery.status).toBeUndefined();
      expect(prevQuery.project).toBeUndefined();
      expect(prevQuery.schedule).toBeUndefined();
      expect(prevQuery.includeArchived).toBeUndefined();
      expect(prevQuery.sort).toBeUndefined();
      expect(prevQuery.order).toBeUndefined();
      expect(prevQuery.pageSize).toBeUndefined();
      expect(prevQuery.readiness).toBeUndefined();
      // Calendar nav must not contain page state
      expect(prevQuery.page).toBeUndefined();
      // Only month should be present
      expect(prevQuery.month).toBeDefined();
      expect(Object.keys(prevQuery).length).toBe(1);

      // Next link must have the same properties
      const nextMatch = res.text.match(/<a\s[^>]*href="(\/releases\/calendar\?[^"]*)"[^>]*>Next →<\/a>/);
      expect(nextMatch).not.toBeNull();
      const nextQuery = parseQuery(nextMatch[1]);
      expect(nextQuery.readiness).toBeUndefined();
      expect(nextQuery.view).toBeUndefined();
      expect(nextQuery.status).toBeUndefined();
      expect(nextQuery.project).toBeUndefined();
      expect(nextQuery.schedule).toBeUndefined();
      expect(nextQuery.includeArchived).toBeUndefined();
      expect(nextQuery.sort).toBeUndefined();
      expect(nextQuery.order).toBeUndefined();
      expect(nextQuery.pageSize).toBeUndefined();
      expect(nextQuery.page).toBeUndefined();
      expect(nextQuery.month).toBeDefined();
      expect(Object.keys(nextQuery).length).toBe(1);
    });
  });

  // ─── Phase 8-1: Published release asset-selection lock (HTTP) ──────
  //
  // Forged direct POSTs to the asset-selection and removal routes must
  // return controlled 422 and leave the junction rows unchanged.

  describe('published release HTTP asset-selection lock', () => {
    async function setupPublishedRelease(app, db, projectsRoot) {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      // Publish the release
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation, assetId };
    }

    it('rejects bulk asset POST with controlled 422 for a published release', async () => {
      const { releaseLocation, assetId } = await setupPublishedRelease(app, db, projectsRoot);
      const before = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));

      const res = await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/i);
      const after = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));
      expect(after).toEqual(before);
    });

    it('rejects single removal POST with controlled 422 for a published release', async () => {
      const { releaseLocation, assetId } = await setupPublishedRelease(app, db, projectsRoot);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const before = getReleaseAssets(db, releaseId);

      const res = await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/i);
      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('rejects missing-asset corrective removal with 422 for a published release', async () => {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Delete the asset file from disk
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));

      // Run the real project scan so the asset becomes is_present = 0
      await request(app)
        .post(`/projects/${projectId}/scan`)
        .expect(302);

      // Snapshot the complete ordered release_assets rows
      const beforeJunction = getReleaseAssets(db, releaseId);
      // Snapshot the asset record
      const assetRepo = createAssetRepository(db);
      const beforeAsset = assetRepo.findById(Number(assetId));

      // POST the corrective removal route
      const res = await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      // Assert: ReleasePublishedError or its controlled message renders
      expect(res.text).toMatch(/locked/i);

      // Assert: the selected missing asset remains selected
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterJunction).toEqual(beforeJunction);

      // Assert: asset presence remains missing
      const afterAsset = assetRepo.findById(Number(assetId));
      expect(afterAsset.is_present).toBe(0);

      // Assert: no asset record is deleted
      expect(afterAsset).toEqual(beforeAsset);
    });
  });

  // ─── Phase 8-1: Scan regression — published release asset metadata ──
  //
  // A later scan may update assets.is_present or other live asset metadata
  // without changing release_id, asset_id, role, or sort_order in the
  // release_assets junction table.

  describe('published release scan regression', () => {
    it('scan updates asset presence without changing junction rows for a published release', async () => {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Snapshot junction rows before scan
      const beforeJunction = getReleaseAssets(db, releaseId);

      // Remove the asset file from disk to trigger a scan change
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));

      // Scan — should succeed and detect the removal
      await request(app)
        .post(`/projects/${projectId}/scan`)
        .expect(302);

      // Junction rows must be exactly unchanged
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterJunction).toEqual(beforeJunction);

      // Asset presence must have been updated by the scan
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.findById(Number(assetId));
      expect(asset.is_present).toBe(0);
    });
  });

  // ─── Phase 8-2: Published and Archived Release Lifecycle Presentation ──
  //
  // Published releases show a publication summary, locked-selection wording,
  // and no asset mutation controls. Archived releases (or releases in archived
  // projects) are read-only: edit redirects, POST returns 422, and mutation
  // controls are hidden.

  describe('published release detail presentation', () => {
    async function setupPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation, assetId };
    }

    it('shows publication summary instead of Needs attention', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Publication Summary/);
      expect(res.text).not.toMatch(/Needs attention/);
    });

    it('shows published date in the publication summary', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Published date/);
      expect(res.text).toMatch(/2025-06-15/);
    });

    it('shows selected assets table once (not duplicated)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      // Count occurrences of "Selected Assets" heading
      const matches = res.text.match(/Selected Assets/g);
      expect(matches).not.toBeNull();
      expect(matches.length).toBe(1);
    });

    it('shows selected assets in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, projectId } = await setupPublishedRelease();
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const rows = getReleaseAssets(db, releaseId);
      // Verify the database order
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].sort_order === rows[i - 1].sort_order) {
          expect(rows[i].asset_id).toBeGreaterThan(rows[i - 1].asset_id);
        } else {
          expect(rows[i].sort_order).toBeGreaterThanOrEqual(rows[i - 1].sort_order);
        }
      }
    });

    it('shows locked-selection wording', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toMatch(/asset selection is locked/i);
    });

    it('shows present/missing state and scan caveat', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Present/);
      expect(res.text).toMatch(/not performing a live filesystem check/);
    });

    it('published metadata edit succeeds (title, description, notes, dates, patreon)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app)
        .post(releaseLocation)
        .send('title=Updated+Published+Title')
        .send('description=Updated+description')
        .send('notes=Updated+notes')
        .send('status=published')
        .send('plannedDate=2025-07-01')
        .send('publishedDate=2025-06-20')
        .send('patreonUrl=https://patreon.com/updated')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(res.headers.location).toBe(releaseLocation);

      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Updated Published Title');
      expect(detail.text).toContain('Updated description');
      expect(detail.text).toContain('Updated notes');
      expect(detail.text).toContain('2025-07-01');
      expect(detail.text).toContain('2025-06-20');
      expect(detail.text).toContain('patreon.com/updated');
    });

    it('published status remains unchanged after metadata edit', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      await request(app)
        .post(releaseLocation)
        .send('title=Status+Check')
        .send('status=published')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toMatch(/Published/);
    });

    it('attempted status change from published fails', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app)
        .post(releaseLocation)
        .send('title=Status+Change+Attempt')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toMatch(/Cannot change status from.*published.*to.*ready/);
    });

    it('published asset page is read-only (no Save Selection button)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation + '/assets').expect(200);
      expect(res.text).not.toMatch(/Save Selection/);
      expect(res.text).toMatch(/locked and read-only/);
    });

    it('published detail hides Publish button', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/\/publish/);
    });

    it('published detail keeps Edit and Archive buttons', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).toMatch(/\/releases\/\d+\/edit/);
      expect(res.text).toMatch(/\/archive/);
    });

    it('published detail hides Manage Assets link', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/Manage Assets/);
    });
  });

  // ─── Phase 8 archived published detail hides published-only notices ──
  //
  // When a published release is archived (or its parent is archived), the
  // archived scope takes precedence. Published-only notices, Publication
  // Summary, and "asset selection locked" wording must not appear.

  describe('archived published release detail hides published-only notices', () => {
    async function setupArchivedPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      // Publish
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      // Archive the release
      await request(app)
        .post(releaseLocation + '/archive')
        .expect(302);
      return { projectId, releaseLocation, releaseId, assetId };
    }

    async function setupArchivedParentPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      // Publish
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      // Archive the parent project
      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);
      return { projectId, releaseLocation, releaseId, assetId };
    }

    it('archived published detail hides Publication Summary', async () => {
      const { releaseLocation } = await setupArchivedPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived and read-only/);
      // Published-only notices must NOT appear
      expect(res.text).not.toMatch(/Publication Summary/);
      expect(res.text).not.toMatch(/asset selection is locked/);
      expect(res.text).not.toMatch(/Needs attention/);
      // Historical status/date preserved
      expect(res.text).toMatch(/published/);
      expect(res.text).toMatch(/2025-06-15/);
    });

    it('archived-parent published detail hides Publication Summary', async () => {
      const { releaseLocation } = await setupArchivedParentPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/parent project is archived/);
      // Published-only notices must NOT appear
      expect(res.text).not.toMatch(/Publication Summary/);
      expect(res.text).not.toMatch(/asset selection is locked/);
      expect(res.text).not.toMatch(/Needs attention/);
      // Historical status/date preserved
      expect(res.text).toMatch(/published/);
      expect(res.text).toMatch(/2025-06-15/);
    });

    it('archived published asset page hides published-only notice', async () => {
      const { releaseLocation } = await setupArchivedPublishedRelease();
      const res = await request(app).get(releaseLocation + '/assets').expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived/);
      // Published-only notice must NOT appear
      expect(res.text).not.toMatch(/locked and read-only/);
    });

    it('archived-parent published asset page hides published-only notice', async () => {
      const { releaseLocation } = await setupArchivedParentPublishedRelease();
      const res = await request(app).get(releaseLocation + '/assets').expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived/);
      // Published-only notice must NOT appear
      expect(res.text).not.toMatch(/locked and read-only/);
    });
  });

  describe('archived release lifecycle', () => {
    async function setupArchivedRelease() {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Archived+Lifecycle+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archived+Lifecycle+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await request(app)
        .post(releaseLocation + '/archive')
        .expect(302);

      return { projectId, releaseLocation, releaseId };
    }

    it('archived detail exposes no mutation controls', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await request(app).get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/\/releases\/\d+\/edit/);
      expect(res.text).not.toMatch(/\/archive/);
      expect(res.text).not.toMatch(/Manage Assets/);
      expect(res.text).not.toMatch(/\/publish/);
      expect(res.text).not.toMatch(/Remove/);
    });

    it('archived GET edit redirects to detail', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await request(app).get(releaseLocation + '/edit').expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('archived release metadata POST returns 422 and preserves row', async () => {
      const { releaseLocation, releaseId } = await setupArchivedRelease();
      const before = releaseRepository.findById(releaseId);

      const res = await request(app)
        .post(releaseLocation)
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      const after = releaseRepository.findById(releaseId);
      expect(after.title).toBe(before.title);
    });

    it('archived asset POST preserves junction rows', async () => {
      const { releaseLocation, releaseId } = await setupArchivedRelease();
      const before = getReleaseAssets(db, releaseId);

      const res = await request(app)
        .post(releaseLocation + '/assets')
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('archive POST on archived release returns 422 with readiness null', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await request(app)
        .post(releaseLocation + '/archive')
        .expect(422);
      expect(res.text).toMatch(/archived and cannot be modified/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication Summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });

    it('publish POST on archived release returns 422 with readiness null', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await request(app)
        .post(releaseLocation + '/publish')
        .expect(422);
      expect(res.text).toMatch(/archived/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication Summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });
  });

  describe('archived-parent release lifecycle', () => {
    async function setupArchivedParentRelease() {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Archived+Parent+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archived+Parent+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Archive the parent project using the dedicated archive route
      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);

      return { projectId, releaseLocation, releaseId };
    }

    it('archived-parent GET edit redirects to detail', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await request(app).get(releaseLocation + '/edit').expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('archived-parent metadata POST returns 422 and preserves row', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentRelease();
      const before = releaseRepository.findById(releaseId);

      const res = await request(app)
        .post(releaseLocation)
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      const after = releaseRepository.findById(releaseId);
      expect(after.title).toBe(before.title);
    });

    it('archived-parent asset POST preserves junction rows', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentRelease();
      const before = getReleaseAssets(db, releaseId);

      const res = await request(app)
        .post(releaseLocation + '/assets')
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('archived-parent archive POST returns 422 with readiness null', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await request(app)
        .post(releaseLocation + '/archive')
        .expect(422);
      expect(res.text).toMatch(/archived/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication Summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });

    it('archived-parent publish POST returns 422 with readiness null', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await request(app)
        .post(releaseLocation + '/publish')
        .expect(422);
      expect(res.text).toMatch(/archived/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication Summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });
  });

  describe('cancelled release behavior remains unchanged', () => {
    it('cancelled release detail still shows readiness', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Cancelled+Readiness+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Cancelled+Readiness+Release')
        .send('status=cancelled')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const res = await request(app).get(releaseLocation).expect(200);
      // Cancelled releases still show readiness panel (not published summary)
      expect(res.text).toMatch(/Readiness/);
      expect(res.text).not.toMatch(/Publication Summary/);
    });
  });

  // ─── Phase 8-3: Publication Review and Finalization Submission ──────────
  //
  // The direct Publish action is replaced with a server-rendered review flow.
  // GET /releases/:id/publish renders the review page; POST performs the
  // authoritative publish. The service remains the single source of truth.

  describe('publication review page (Phase 8-3)', () => {
    it('publishable ready GET returns 200', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const res = await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);
      expect(res.text).toContain('Review &amp; Publish');
      expect(res.text).toContain('Publishable');
    });

    it('blocked-ready GET returns 200', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Blocked+Ready+Review+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Blocked+Ready+Review')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app)
        .get(`${createRes.headers.location}/publish`)
        .expect(200);
      expect(res.text).toContain('Review &amp; Publish');
      expect(res.text).toContain('Needs attention');
    });

    it('GET performs no database or junction mutation', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('ordered assets, roles, order, presence, and caveat render', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const res = await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);

      // Role renders
      expect(res.text).toContain('Primary');
      // Numeric order renders
      expect(res.text).toContain('0');
      // Presence renders
      expect(res.text).toContain('Present');
      // Caveat renders
      expect(res.text).toContain('not performing a live filesystem check');
    });

    describe('lifecycle eligibility redirects', () => {
      const NON_READY_STATUSES = [
        { status: 'idea', label: 'idea' },
        { status: 'planned', label: 'planned' },
        { status: 'drafting', label: 'drafting' },
        { status: 'published', label: 'published' },
        { status: 'cancelled', label: 'cancelled' },
      ];

      for (const { status, label } of NON_READY_STATUSES) {
        it(`GET redirects for ${label} status`, async () => {
          const projRes = await request(app)
            .post('/projects')
            .send('title=Lifecycle+Redirect+Test')
            .send('status=tbd')
            .send('priority=normal')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(302);
          const projectId = projRes.headers.location.replace('/projects/', '');

          let releaseLocation;
          let releaseId;

          if (status === 'published') {
            // published can only be reached via publishRelease, not direct create
            const createRes = await request(app)
              .post('/releases')
              .send(`projectId=${projectId}`)
              .send('title=Lifecycle+Redirect+published')
              .send('status=ready')
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);
            releaseLocation = createRes.headers.location;
            releaseId = Number(releaseLocation.replace('/releases/', ''));

            // Need a publishable release: create asset, select it, then publish
            const slug = 'lifecycle-redirect-test';
            const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
            const matching = entries.filter((e) => e.endsWith(`-${slug}`));
            const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
            fs.writeFileSync(path.join(projectDir, 'pub-asset.txt'), 'content');
            await request(app).post(`/projects/${projectId}/scan`).expect(302);

            const assetRepo = createAssetRepository(db);
            const assets = assetRepo.findByProjectId(Number(projectId));
            await request(app)
              .post(releaseLocation + '/assets')
              .send(`selectedAssetIds[]=${assets[0].id}`)
              .send('roles[]=primary')
              .send('sortOrder[]=0')
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);

            await request(app)
              .post(`${releaseLocation}/publish`)
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);
          } else {
            const createRes = await request(app)
              .post('/releases')
              .send(`projectId=${projectId}`)
              .send(`title=Lifecycle+Redirect+${label}`)
              .send(`status=${status}`)
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);
            releaseLocation = createRes.headers.location;
            releaseId = Number(releaseLocation.replace('/releases/', ''));
          }

          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

          const res = await request(app)
            .get(`${releaseLocation}/publish`)
            .expect(302);

          // Exact Location header
          expect(res.headers.location).toBe(releaseLocation);
          // No mutation
          const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          expect(afterRelease).toEqual(beforeRelease);
        });
      }

      it('GET redirects for archived release', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await request(app)
          .post(`${releaseLocation}/archive`)
          .expect(302);

        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

        const res = await request(app)
          .get(`${releaseLocation}/publish`)
          .expect(302);

        expect(res.headers.location).toBe(releaseLocation);
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(afterRelease).toEqual(beforeRelease);
      });

      it('GET redirects for archived parent project', async () => {
        const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await request(app)
          .post(`/projects/${projectId}/archive`)
          .expect(302);

        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

        const res = await request(app)
          .get(`${releaseLocation}/publish`)
          .expect(302);

        expect(res.headers.location).toBe(releaseLocation);
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(afterRelease).toEqual(beforeRelease);
      });
    });

    it('malformed/unknown IDs return 404', async () => {
      await request(app)
        .get('/releases/abc/publish')
        .expect(404);

      await request(app)
        .get('/releases/99999/publish')
        .expect(404);
    });

    describe('route-neighbor coverage', () => {
      it('GET /releases/:id still renders detail', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
        const res = await request(app)
          .get(releaseLocation)
          .expect(200);
        expect(res.text).toContain('Readiness Test Release');
      });

      it('GET /releases/:id/edit still renders edit form', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
        const res = await request(app)
          .get(`${releaseLocation}/edit`)
          .expect(200);
        expect(res.text).toContain('Edit Release');
      });

      it('GET /releases/:id/assets still renders asset selection', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
        const res = await request(app)
          .get(`${releaseLocation}/assets`)
          .expect(200);
        expect(res.text).toContain('Assets —');
        expect(res.text).toContain('asset-table');
      });

      it('POST /releases/:id/publish still publishes', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
        const res = await request(app)
          .post(`${releaseLocation}/publish`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        expect(res.headers.location).toBe(releaseLocation);
      });

      it('GET and POST /releases/:id/publish coexist correctly', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

        // GET returns 200
        const getRes = await request(app)
          .get(`${releaseLocation}/publish`)
          .expect(200);
        expect(getRes.text).toContain('Review &amp; Publish');

        // POST returns 302
        const postRes = await request(app)
          .post(`${releaseLocation}/publish`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        expect(postRes.headers.location).toBe(releaseLocation);
      });
    });

    it('persisted date prefills', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      // Set a persisted published_date
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      db.prepare("UPDATE releases SET published_date = '2025-12-01' WHERE id = ?").run(releaseId);

      const res = await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);
      expect(res.text).toContain('value="2025-12-01"');
    });

    it('local-today fallback prefills', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const res = await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);

      const today = getLocalTodayIso();
      expect(res.text).toContain(`value="${today}"`);
    });

    it('valid submitted date persists exactly', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await request(app)
        .post(`${releaseLocation}/publish`)
        .send('publishedDate=2025-11-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      expect(release.published_date).toBe('2025-11-01');
      expect(release.status).toBe('published');
    });

    it('missing direct-POST date preserves fallback behavior', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await request(app)
        .post(`${releaseLocation}/publish`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      expect(release.status).toBe('published');
      const today = getLocalTodayIso();
      expect(release.published_date).toBe(today);
    });

    describe('invalid published-date input', () => {
      const INVALID_DATES = [
        { label: 'impossible calendar date', value: '2025-02-30' },
        { label: 'non-date string', value: 'not-a-date' },
      ];

      for (const { label, value } of INVALID_DATES) {
        it(`returns 422 for ${label}: "${value}"`, async () => {
          const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
          const releaseId = Number(releaseLocation.replace('/releases/', ''));
          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          const beforeJunction = getReleaseAssets(db, releaseId);

          const res = await request(app)
            .post(`${releaseLocation}/publish`)
            .send(`publishedDate=${value}`)
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(422);

          // Exact submitted value preserved in the form
          expect(res.text).toContain(`value="${value}"`);
          // Field-specific error renders
          expect(res.text).toContain('Published date must be a valid date');
          // Complete release row unchanged
          const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          expect(afterRelease).toEqual(beforeRelease);
          // Complete junction rows unchanged
          const afterJunction = getReleaseAssets(db, releaseId);
          expect(afterJunction).toEqual(beforeJunction);
        });
      }

      it('whitespace-only input is treated as no date (falls through to today)', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await request(app)
          .post(`${releaseLocation}/publish`)
          .send('publishedDate=   ')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(release.status).toBe('published');
        const today = getLocalTodayIso();
        expect(release.published_date).toBe(today);
      });

      it('leading/trailing whitespace on a valid date is trimmed and accepted', async () => {
        const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await request(app)
          .post(`${releaseLocation}/publish`)
          .send('publishedDate=  2025-06-15  ')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(release.status).toBe('published');
        expect(release.published_date).toBe('2025-06-15');
      });
    });

    it('readiness changes after GET cause POST rejection', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);

      // Load the review page (GET)
      await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);

      // Change readiness: remove the asset file and scan
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));
      await request(app)
        .post(`/projects/${projectId}/scan`)
        .expect(302);

      // POST should now be rejected
      const res = await request(app)
        .post(`${releaseLocation}/publish`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('Cannot publish');
    });

    it('stale POST leaves row and junctions unchanged', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      // Remove the asset file and scan to make it missing
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));
      await request(app)
        .post(`/projects/${projectId}/scan`)
        .expect(302);

      // POST publish — should be rejected
      await request(app)
        .post(`${releaseLocation}/publish`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('direct forged POST still cannot bypass readiness', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Forged+Review+POST+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Forged+Review+POST')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Direct POST with no assets — server must reject
      const res = await request(app)
        .post(`${createRes.headers.location}/publish`)
        .expect(422);
      expect(res.text).toContain('Cannot publish');
    });

    it('successful publication redirects to published summary', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);

      const res = await request(app)
        .post(`${releaseLocation}/publish`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Should redirect to release detail
      expect(res.headers.location).toBe(releaseLocation);

      // Detail should show published summary
      const detail = await request(app).get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publication Summary');
    });

    it('newly published selection is already locked', async () => {
      const { releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish
      await request(app)
        .post(`${releaseLocation}/publish`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Attempt to change asset selection — must be rejected
      const res = await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/);
    });

    it('no JavaScript confirmation is required', async () => {
      const { releaseLocation } = await setupPublishableRelease(app, projectsRoot, db);
      const res = await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);

      // The publish form must not have an onclick confirm handler
      expect(res.text).not.toMatch(/onclick/);
    });

    it('renders assets in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const assetRepo = createAssetRepository(db);

      // Create additional assets with deliberately unordered insertion
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);

      // Write distinct files
      fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta');
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'charlie.txt'), 'charlie');
      fs.writeFileSync(path.join(projectDir, 'bravo.txt'), 'bravo');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const assetMap = {};
      for (const a of allAssets) {
        assetMap[a.filename] = a;
      }

      // Deliberately unordered insertion with distinct sort_order and roles
      // Expected order: sort_order ASC, asset_id ASC
      // sort_order 0: alpha (asset_id lower) then bravo (asset_id higher) — tie
      // sort_order 1: charlie
      // sort_order 5: delta
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetMap['delta.txt'].id}`)
        .send(`selectedAssetIds[]=${assetMap['bravo.txt'].id}`)
        .send(`selectedAssetIds[]=${assetMap['alpha.txt'].id}`)
        .send(`selectedAssetIds[]=${assetMap['charlie.txt'].id}`)
        .send('roles[]=source')
        .send('roles[]=preview')
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=5')
        .send('sortOrder[]=0')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Fetch the review page
      const res = await request(app)
        .get(`${releaseLocation}/publish`)
        .expect(200);

      // Extract the asset table rows from the review page
      const tableSection = res.text.match(/<table class="asset-table">[\s\S]*?<\/table>/);
      expect(tableSection).not.toBeNull();
      const tableHtml = tableSection[0];

      // Parse rows from tbody
      const tbodyMatch = tableHtml.match(/<tbody>[\s\S]*?<\/tbody>/);
      expect(tbodyMatch).not.toBeNull();
      const rowRegex = /<tr>[\s\S]*?<\/tr>/g;
      const htmlRows = tbodyMatch[0].match(rowRegex);
      expect(htmlRows).not.toBeNull();

      // Expected order from DB: sort_order ASC, asset_id ASC
      const dbRows = db.prepare(
        `SELECT ra.sort_order, ra.asset_id, a.filename, ra.role
         FROM release_assets ra
         JOIN assets a ON a.id = ra.asset_id
         WHERE ra.release_id = ?
         ORDER BY ra.sort_order ASC, ra.asset_id ASC`
      ).all(releaseId);

      expect(htmlRows.length).toBe(dbRows.length);

      for (let i = 0; i < htmlRows.length; i++) {
        const rowHtml = htmlRows[i];
        const dbRow = dbRows[i];

        // Assert filename
        const filenameMatch = rowHtml.match(/<td class="asset-filename">([^<]+)<\/td>/);
        expect(filenameMatch).not.toBeNull();
        expect(filenameMatch[1]).toBe(dbRow.filename);

        // Assert role
        const roleMatch = rowHtml.match(/<td class="asset-filename">[^<]*<\/td>\s*<td>([^<]+)<\/td>/);
        expect(roleMatch).not.toBeNull();
        expect(roleMatch[1].toLowerCase().trim()).toBe(dbRow.role);

        // Assert sort order is visible
        expect(rowHtml).toContain(String(dbRow.sort_order));

        // Assert presence state
        expect(rowHtml).toContain('Present');
      }
    });
  });

  // ─── Phase 8 archived-lifecycle complete state tests ──────────────────────
  //
  // Every rejected POST must leave the complete release row and junction rows
  // unchanged. Release snapshots include all columns; junction snapshots
  // include release_id, asset_id, role, sort_order, created_at.

  describe('archived-lifecycle complete state preservation', () => {
    /**
     * Snapshot the complete release row (all columns).
     */
    function snapshotRelease(releaseId) {
      return db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
    }

    /**
     * Snapshot the complete junction rows (all columns, deterministic order).
     */
    function snapshotJunction(releaseId) {
      return db.prepare(
        'SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC'
      ).all(releaseId);
    }

    async function setupArchivedReleaseWithAsset() {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Complete+State+Archived+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'complete-state-archived-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Complete+State+Archived+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Archive the release
      await request(app)
        .post(releaseLocation + '/archive')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId) };
    }

    async function setupArchivedParentReleaseWithAsset() {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Complete+State+Archived+Parent')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'complete-state-archived-parent';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await request(app)
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Complete+State+Archived+Parent+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Archive the parent project
      await request(app)
        .post(`/projects/${projectId}/archive`)
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId) };
    }

    // ── Archived release ──────────────────────────────────────────────────

    it('archived metadata POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation)
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent metadata POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation)
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived asset POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation + '/assets')
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent asset POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation + '/assets')
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived archive POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation + '/archive')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived and cannot be modified/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent archive POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation + '/archive')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived publish POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation + '/publish')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent publish POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(releaseLocation + '/publish')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived corrective removal POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId, assetId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent corrective removal POST preserves complete state and shows archived notice', async () => {
      const { releaseLocation, releaseId, assetId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      // Snapshot the complete asset row
      const assetRepo = createAssetRepository(db);
      const beforeAsset = assetRepo.findById(assetId);

      const res = await request(app)
        .post(`${releaseLocation}/assets/${assetId}/remove`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      // Archived-parent notice appears
      expect(res.text).toMatch(/parent project is archived/);
      // No Remove form
      expect(res.text).not.toMatch(/Remove/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication Summary/);
      // Complete state unchanged
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
      const afterAsset = assetRepo.findById(assetId);
      expect(afterAsset).toEqual(beforeAsset);
    });

    // ── Successful published metadata edit ───────────────────────────────

    it('published metadata edit changes only intended fields and preserves status and junction rows', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      // Edit metadata: title, description, notes, plannedDate, publishedDate, patreonUrl
      await request(app)
        .post(releaseLocation)
        .send('title=Updated+Published+Title')
        .send('description=Updated+description')
        .send('notes=Updated+notes')
        .send('status=published')
        .send('plannedDate=2025-07-01')
        .send('publishedDate=2025-06-20')
        .send('patreonUrl=https://patreon.com/updated')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const afterRelease = snapshotRelease(releaseId);
      const afterJunction = snapshotJunction(releaseId);

      // Status must remain published
      expect(afterRelease.status).toBe('published');

      // Metadata fields changed
      expect(afterRelease.title).toBe('Updated Published Title');
      expect(afterRelease.description).toBe('Updated description');
      expect(afterRelease.notes).toBe('Updated notes');
      expect(afterRelease.planned_date).toBe('2025-07-01');
      expect(afterRelease.published_date).toBe('2025-06-20');
      expect(afterRelease.patreon_url).toBe('https://patreon.com/updated');

      // Junction rows must be exactly unchanged
      expect(afterJunction).toEqual(beforeJunction);

      // Non-mutable fields must be preserved
      expect(afterRelease.id).toBe(beforeRelease.id);
      expect(afterRelease.project_id).toBe(beforeRelease.project_id);
      expect(afterRelease.created_at).toBe(beforeRelease.created_at);
    });
  });

  // ─── Phase 8 structural published asset-table assertions ──────────────────
  //
  // Parse the exact selected-assets section on published detail and assert
  // structural properties: exactly one table.asset-table, multiple assets in
  // sort_order ASC, asset_id ASC order, correct roles and presence values.

  describe('published detail structural asset-table assertions', () => {
    async function setupPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(app, projectsRoot, db);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Add a second asset with a different role and sort order
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'second-asset.txt'), 'second content');
      await request(app).post(`/projects/${projectId}/scan`).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== Number(assetId));

      // Select both assets with distinctive roles and sort orders
      await request(app)
        .post(releaseLocation + '/assets')
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .send('sortOrder[]=10')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Publish
      await request(app)
        .post(releaseLocation + '/publish')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId), secondAssetId: secondAsset.id };
    }

    it('exactly one table.asset-table appears in the selected-assets section', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);

      // Extract the Selected Assets section
      const sectionMatch = res.text.match(/<h2>Selected Assets<\/h2>[\s\S]*?<\/section>/);
      expect(sectionMatch).not.toBeNull();
      const sectionHtml = sectionMatch[0];

      // Count table.asset-table occurrences within that section
      const tableMatches = sectionHtml.match(/<table class="asset-table">/g);
      expect(tableMatches).not.toBeNull();
      expect(tableMatches.length).toBe(1);
    });

    it('multiple assets render in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, releaseId } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);

      // Extract the Selected Assets section
      const sectionMatch = res.text.match(/<h2>Selected Assets<\/h2>[\s\S]*?<\/section>/);
      expect(sectionMatch).not.toBeNull();
      const sectionHtml = sectionMatch[0];

      // Extract asset rows in order from the table body
      const rowRegex = /<tr>[\s\S]*?<td class="asset-filename">([^<]+)<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td class="asset-path">[\s\S]*?<\/td>[\s\S]*?<td>[\s\S]*?(Present|Missing)[\s\S]*?<\/td>[\s\S]*?<\/tr>/g;
      const rows = [];
      let rowMatch;
      while ((rowMatch = rowRegex.exec(sectionHtml)) !== null) {
        rows.push({ filename: rowMatch[1], role: rowMatch[2], presence: rowMatch[3] });
      }

      // Verify the order matches the database order
      const dbRows = db.prepare(
        'SELECT ra.sort_order, ra.asset_id, a.filename, ra.role FROM release_assets ra JOIN assets a ON a.id = ra.asset_id WHERE ra.release_id = ? ORDER BY ra.sort_order ASC, ra.asset_id ASC'
      ).all(releaseId);

      expect(rows.length).toBe(dbRows.length);
      for (let i = 0; i < rows.length; i++) {
        expect(rows[i].filename).toBe(dbRows[i].filename);
        expect(rows[i].role.toLowerCase()).toBe(dbRows[i].role);
      }
    });

    it('roles and presence values correspond to the correct rows', async () => {
      const { releaseLocation, releaseId, assetId, secondAssetId } = await setupPublishedRelease();
      const res = await request(app).get(releaseLocation).expect(200);

      // Extract the Selected Assets section
      const sectionMatch = res.text.match(/<h2>Selected Assets<\/h2>[\s\S]*?<\/section>/);
      expect(sectionMatch).not.toBeNull();
      const sectionHtml = sectionMatch[0];

      // Get the database rows for reference
      const dbRows = db.prepare(
        'SELECT ra.asset_id, a.filename, ra.role, ra.sort_order FROM release_assets ra JOIN assets a ON a.id = ra.asset_id WHERE ra.release_id = ? ORDER BY ra.sort_order ASC, ra.asset_id ASC'
      ).all(releaseId);

      // Extract individual table rows from the tbody
      const tbodyMatch = sectionHtml.match(/<tbody>[\s\S]*?<\/tbody>/);
      expect(tbodyMatch).not.toBeNull();
      const rowRegex = /<tr>[\s\S]*?<\/tr>/g;
      const htmlRows = tbodyMatch[0].match(rowRegex);
      expect(htmlRows).not.toBeNull();
      expect(htmlRows.length).toBe(dbRows.length);

      for (let i = 0; i < htmlRows.length; i++) {
        const rowHtml = htmlRows[i];
        const dbRow = dbRows[i];

        // Extract filename
        const filenameMatch = rowHtml.match(/<td class="asset-filename">([^<]+)<\/td>/);
        expect(filenameMatch).not.toBeNull();
        expect(filenameMatch[1]).toBe(dbRow.filename);

        // Extract role — it's the first <td> after the filename that contains text
        const roleMatch = rowHtml.match(/<td class="asset-filename">[^<]*<\/td>\s*<td>([^<]+)<\/td>/);
        expect(roleMatch).not.toBeNull();
        expect(roleMatch[1].toLowerCase().trim()).toBe(dbRow.role);

        // Extract presence — it's the <td> after the path <td>
        const presenceMatch = rowHtml.match(/<td class="asset-path">[\s\S]*?<\/td>\s*<td>[\s\S]*?(Present|Missing)[\s\S]*?<\/td>/);
        expect(presenceMatch).not.toBeNull();
        expect(presenceMatch[1]).toMatch(/Present|Missing/);
      }
    });
  });
});
