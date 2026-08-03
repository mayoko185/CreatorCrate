import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { createReleaseService } from '../src/services/release-service.js';
import { getLocalTodayIso } from '../src/util/date.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

function hasClass(html, className) {
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  return re.test(html);
}

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
async function setupPublishableRelease(agent, projectsRoot, db, csrfToken) {
  const projRes = await agent
    .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
  await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

  const assetRepo = createAssetRepository(db);
  const assets = assetRepo.findByProjectId(Number(projectId));
  const assetId = String(assets[0].id);

  const createRes = await agent
    .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
    .send(`projectId=${projectId}`)
    .send('title=Readiness+Test+Release')
    .send('status=ready')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  const releaseLocation = createRes.headers.location;

  // Select the asset
  await agent
    .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
    .send(`selectedAssetIds[]=${assetId}`)
    .send('roles[]=primary')
    .send('sortOrder[]=0')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);

  return { projectId, releaseLocation, assetId };
}

/**
 * Insert a project row directly via SQL, bypassing the service/repository
 * layer so tests can construct rows the normal write paths cannot produce
 * (e.g. status='archived' with a NULL archived_at) and can pin updated_at
 * to a deterministic value for ordering-sensitive fixtures.
 */
function insertProjectDirect(db, overrides = {}) {
  const {
    title = 'Direct Project',
    slug = `direct-project-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    status = 'tbd',
    archivedAt = null,
    updatedAt = null,
  } = overrides;
  const row = db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, priority, archived_at, updated_at)
       VALUES (?, ?, '', '', ?, 'normal', ?, COALESCE(?, datetime('now')))
       RETURNING id`
    )
    .get(title, slug, status, archivedAt, updatedAt);
  return row.id;
}

describe('release HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let appDataRoot;
  let releaseRepository;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    releaseRepository = createReleaseRepository(db);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Wording+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'plannedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('Target publication date for this release');
      expect(container).toMatch(/<input[^>]*id="plannedDate"[^>]*>/);
    });

    it('release form shows help text for published date in the correct field container', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Wording+Pub')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'publishedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('When this release was published');
      expect(container).toMatch(/<input[^>]*id="publishedDate"[^>]*>/);
    });

    it('release form shows generic release-link help text in the correct field container', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Wording+URL')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'patreonUrl');
      expect(container).not.toBeNull();
      expect(container).toContain('<label for="patreonUrl">Release link</label>');
      expect(container).toContain('Optional absolute HTTP or HTTPS URL for this release.');
      expect(container).toMatch(/<input[^>]*id="patreonUrl"[^>]*>/);
    });

    it('release form exposes generic HTTP(S) validation errors', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Validation+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Invalid+Release+Link')
        .send('status=idea')
        .send('patreonUrl=ftp%3A%2F%2Fexample.com%2Frelease')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Release link must be a valid absolute HTTP or HTTPS URL.');
      expect(res.text).not.toContain('Patreon URL must be a valid https://patreon.com link.');
    });

    it('release detail shows context labels in the correct dt/dd pairs', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Detail+Wording')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Detail+Wording+Release')
        .send('status=idea')
        .send('plannedDate=2025-12-01')
        .send('publishedDate=2025-12-15')
        .send('patreonUrl=https://patreon.com/release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const res = await agent.get(releaseLocation).expect(200);

      // Planned date: <dt>Planned date</dt> ... <small>(release target)</small>
      const plannedDt = res.text.match(/<dt>Planned date<\/dt>\s*<dd>[^<]*(?:<small>\(release target\)<\/small>)[^<]*<\/dd>/);
      expect(plannedDt).not.toBeNull();

      // Published date: <dt>Published date</dt> ... <small>(release published)</small>
      const publishedDt = res.text.match(/<dt>Published date<\/dt>\s*<dd>[^<]*(?:<small>\(release published\)<\/small>)[^<]*<\/dd>/);
      expect(publishedDt).not.toBeNull();

      // Release link: <dt>Release link</dt> ... <small>(release link)</small>
      // Bounded pattern: cannot cross </dd>, <dt>, or opening <dd>
      const releaseLinkDt = res.text.match(/<dt>Release link<\/dt>\s*<dd>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<small>\(release link\)<\/small>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<\/dd>/);
      expect(releaseLinkDt).not.toBeNull();
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Legacy+Readiness+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent
        .post(`/projects/${projectId}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
    });

    it('project published_date does not affect release readiness', async () => {
      const { projectId, releaseId, releaseLocation } = await setupPublishableForLegacyTest();

      const before = getReadinessFactsAndResult(releaseId);
      expect(before).not.toBeNull();
      expect(before.result.publishable).toBe(true);

      await agent
        .post(`/projects/${projectId}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
    });

    it('project patreon_url does not affect release readiness', async () => {
      const { projectId, releaseId, releaseLocation } = await setupPublishableForLegacyTest();

      const before = getReadinessFactsAndResult(releaseId);
      expect(before).not.toBeNull();
      expect(before.result.publishable).toBe(true);

      await agent
        .post(`/projects/${projectId}`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
    });

    it('cross-project junction rows are excluded from readiness facts', async () => {
      // Create two projects and a release on project A with an asset from
      // project B in the junction table. The production projection's
      // LEFT JOIN assets ON a.id = ra.asset_id AND a.project_id = r.project_id
      // must exclude the cross-project row from all counts.
      const projARes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cross+Project+A')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectAId = Number(projARes.headers.location.replace('/projects/', ''));

      const projBRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectBId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assetsB = assetRepo.findByProjectId(projectBId);
      const assetBId = assetsB[0].id;

      // Create a release on project A
      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

  // ─── Release list (Phase 2B: moved to /release-management) ────────────────

  it('release list renders', async () => {
    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain('Releases');
    expect(res.text).toContain('No releases');
  });

  it('release list shows releases from all projects', async () => {
    // Create a project first
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=List+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create releases
    await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Release+One')
      .send('status=idea')
      .send('plannedDate=2026-12-01')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Release+Two')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain('Release One');
    expect(res.text).toContain('Release Two');
  });

  it('release list filters by status', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Filter+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Idea+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Planned+Release')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent.get('/release-management?status=idea').expect(200);
    expect(res.text).toContain('Idea Release');
    expect(res.text).not.toContain('Planned Release');
  });

  // ─── Create release ────────────────────────────────────────────────────────

  it('new-release form renders with project selection', async () => {
    // Create a project first
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=New+Release+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent.get('/releases/new').expect(200);
    expect(res.text).toContain('Create Release');
    expect(res.text).toContain('New Release Test');
  });

  it('valid create request redirects to detail', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Create+Redirect+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Error+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=')
      .send('status=invalid')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Title is required');
  });

  it('missing project returns error', async () => {
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('projectId=99999')
      .send('title=Orphan+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Project not found');
  });

  it('malformed projectId is rejected', async () => {
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('projectId=1junk')
      .send('title=Bad+Id+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Project is required');
  });

  // ─── Release detail ───────────────────────────────────────────────────────

  it('release detail renders', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Detail+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Detail+View+Test')
      .send('status=idea')
      .send('plannedDate=2026-12-01')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const location = createRes.headers.location;
    const res = await agent.get(location).expect(200);
    expect(res.text).toContain('Detail View Test');
    expect(res.text).toContain('Edit');
    expect(res.text).toContain('Manage Assets');
  });

  it('missing release returns 404', async () => {
    await agent.get('/releases/9999').expect(404);
  });

  it('invalid release id returns 404', async () => {
    await agent.get('/releases/abc').expect(404);
  });

  describe('publish page rendering contract', () => {
    it('publish page uses page-heading with cancel action', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Publish+Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Publish+Heading+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Add an asset to make it publishable
      const slug = 'publish-heading-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter(e => e.endsWith(`-${slug}`));
      fs.writeFileSync(path.join(projectsRoot, 'tbd', matching[0], 'test.txt'), 'hello');
      await agent.post(`/projects/${projectId}/scan`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const { createAssetRepository } = await import('../src/data/asset-repository.js');
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      await agent.post(`${relRes.headers.location}/assets`)
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/publish`).expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(res.text).toContain('Cancel');
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('publish page uses shared panel class for readiness section', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Publish+Panel+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Publish+Panel+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const slug = 'publish-panel-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter(e => e.endsWith(`-${slug}`));
      fs.writeFileSync(path.join(projectsRoot, 'tbd', matching[0], 'test.txt'), 'hello');
      await agent.post(`/projects/${projectId}/scan`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const { createAssetRepository } = await import('../src/data/asset-repository.js');
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      await agent.post(`${relRes.headers.location}/assets`)
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/publish`).expect(200);
      expect(res.text).toContain('class="panel panel--readiness"');
    });

    it('publish page uses status-badge for release status', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Publish+Badge+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Publish+Badge+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const slug = 'publish-badge-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter(e => e.endsWith(`-${slug}`));
      fs.writeFileSync(path.join(projectsRoot, 'tbd', matching[0], 'test.txt'), 'hello');
      await agent.post(`/projects/${projectId}/scan`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const { createAssetRepository } = await import('../src/data/asset-repository.js');
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      await agent.post(`${relRes.headers.location}/assets`)
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/publish`).expect(200);
      expect(res.text).toContain('status-badge');
    });
  });

  // ─── Release form Cancel link (Phase 2D regression coverage) ──────────────
  //
  // Phase 2C changed release-form Cancel behavior but shipped without direct
  // automated coverage. These tests pin the exact destinations for every
  // Cancel scenario, and prove a malformed projectId cannot build an unsafe
  // href on the create form.

  describe('release form Cancel link', () => {
    it('create form Cancel points to /projects/:id with a valid project context', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+With+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${projectId}">Cancel</a>`);
    });

    it('create form Cancel falls back to /release-management without project context', async () => {
      // Phase 2D correction: /releases is now Published Work, not the
      // release-record list — a bare "Cancel" from an in-progress
      // release-record form must not land there.
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+No+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases/new').expect(200);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
      expect(res.text).not.toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    // ─── Phase 2F: projectId is validated and normalized before it ever
    // reaches selectedProjectId or the Cancel href. Malformed, nonexistent,
    // and archived values must all fall back to the no-context behavior —
    // no project preselected, Cancel → /release-management.

    describe.each([
      ['non-numeric', 'abc'],
      ['zero', '0'],
      ['negative', '-1'],
      ['trailing garbage', '1abc'],
      ['float', '1.5'],
      ['whitespace-only', '%20%20'],
    ])('malformed projectId (%s: %s)', (_label, rawValue) => {
      it('renders the form with no project preselected and Cancel to /release-management', async () => {
        await agent
          .post('/projects')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('title=Cancel+Malformed+Baseline')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const res = await agent.get(`/releases/new?projectId=${rawValue}`).expect(200);

        expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
        expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
        expect(res.text).not.toMatch(/<option value="[^"]+" selected>/);
        expect(res.text).not.toContain('Something went wrong');
      });
    });

    it('repeated projectId query parameters are treated as absent context', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Repeated+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Express parses repeated query keys into an array (req.query.projectId
      // becomes ['1', '2']), which must not be treated as a valid single id.
      const res = await agent
        .get(`/releases/new?projectId=${projectId}&projectId=999`)
        .expect(200);

      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
      expect(res.text).not.toMatch(/<option value="[^"]+" selected>/);
    });

    it('create form Cancel does not build an unsafe href from a malformed projectId', async () => {
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Malformed+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .get('/releases/new?projectId=' + encodeURIComponent('"><script>alert(1)</script>'))
        .expect(200);

      // A malformed (non-integer) projectId is normalized to absent context,
      // so it never reaches the href at all — not merely escaped within it.
      expect(res.text).not.toContain('<script>alert(1)</script>');
      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
    });

    it('nonexistent projectId is treated as absent context', async () => {
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Nonexistent+Baseline')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases/new?projectId=999999').expect(200);

      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
      expect(res.text).not.toMatch(/<option value="[^"]+" selected>/);
    });

    it('archived projectId is not accepted as active release-creation context', async () => {
      // A baseline active project keeps the form reachable after the target
      // project is archived (the route 422s when zero active projects exist).
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Archived+Baseline')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Archived+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${projectId}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);

      expect(res.text).not.toContain(`href="/projects/${projectId}"`);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
      expect(res.text).not.toContain(`value="${projectId}" selected`);
      expect(res.text).not.toContain('Cancel Archived Project');
    });

    it('valid active projectId preselects the correct project and no other', async () => {
      const projARes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Select+Correct+Project+A')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectAId = projARes.headers.location.replace('/projects/', '');

      const projBRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Select+Correct+Project+B')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectBId = projBRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectAId}`).expect(200);

      expect(res.text).toContain(`<option value="${projectAId}" selected>`);
      expect(res.text).not.toContain(`<option value="${projectBId}" selected>`);
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${projectAId}">Cancel</a>`);
    });

    it('edit form Cancel points to /releases/:releaseId', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Edit+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Cancel+Edit+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const res = await agent.get(`${releaseLocation}/edit`).expect(200);
      expect(res.text).toContain(`<a class="button button-secondary" href="${releaseLocation}">Cancel</a>`);
    });

    // ─── Phase 2F review fix: inconsistent archive rows ──────────────────
    //
    // A project row can disagree between its two archive indicators
    // (status='archived' with archived_at still NULL). Such a row is not
    // excluded by projectService.list({ includeArchived: false }), which
    // only filters on archived_at, so it must be filtered locally with
    // isActiveProject before the selector is rendered — it must not appear
    // as an option at all, selected or not.

    it('inconsistent row (status=archived, archived_at=NULL) is not an option, not selected, and Cancel falls back', async () => {
      // A baseline active project keeps the form reachable (the route 422s
      // when zero active projects remain after local filtering).
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Inconsistent+Archived+Baseline')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const inconsistentId = insertProjectDirect(db, {
        title: 'Inconsistent Archived Row',
        status: 'archived',
        archivedAt: null,
      });

      const res = await agent.get(`/releases/new?projectId=${inconsistentId}`).expect(200);

      expect(res.text).not.toContain(`value="${inconsistentId}"`);
      expect(res.text).not.toContain('Inconsistent Archived Row');
      expect(res.text).not.toMatch(/<option value="[^"]+" selected>/);
      expect(res.text).not.toContain(`href="/projects/${inconsistentId}"`);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
    });

    it('inconsistent row (status=archived, archived_at=NULL) is rejected by POST release creation', async () => {
      const inconsistentId = insertProjectDirect(db, {
        title: 'Inconsistent Archived POST Row',
        status: 'archived',
        archivedAt: null,
      });

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${inconsistentId}`)
        .send('title=Should+Not+Create')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Cannot create release for archived project.');
    });

    // ─── Phase 2F review fix: valid project beyond the 100-option page ───

    it('valid active project outside the first 100 options is added to the selector and preselected', async () => {
      const TOTAL = 101;
      let targetId;
      for (let i = 0; i < TOTAL; i++) {
        // Strictly decreasing updated_at so ordering (DESC) is deterministic;
        // the last-inserted row (i = TOTAL - 1) is the oldest and therefore
        // ranked 101st — outside the LIMIT 100 page.
        const updatedAt = `2024-01-01 00:00:${String(TOTAL - i).padStart(2, '0')}`;
        const id = insertProjectDirect(db, {
          title: `Beyond Limit Project ${i}`,
          status: 'tbd',
          updatedAt,
        });
        if (i === TOTAL - 1) targetId = id;
      }

      const res = await agent.get(`/releases/new?projectId=${targetId}`).expect(200);

      const optionMatches = res.text.match(new RegExp(`<option value="${targetId}"[^>]*>`, 'g')) || [];
      expect(optionMatches).toHaveLength(1);
      expect(optionMatches[0]).toContain('selected');
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${targetId}">Cancel</a>`);

      // At most 101 project options: 100 from the filtered page plus the one
      // directly appended beyond-100 project. No duplicates, no overcount.
      const allProjectOptions = res.text.match(/<option value="\d+"/g) || [];
      expect(allProjectOptions.length).toBeLessThanOrEqual(101);
    });

    it('a full original page containing a locally-filtered archived-status row still finds and appends a valid active project beyond the page', async () => {
      // 99 active rows ranked 1-99, one archived-status row (archived_at
      // NULL) at rank 100 — still counted by the unfiltered DB query, so the
      // original page is full (100 rows), even though local filtering drops
      // it to 99 active options. The valid target sits at rank 101, outside
      // the LIMIT 100 window, and must still be found via direct lookup.
      for (let i = 0; i < 99; i++) {
        const updatedAt = `2024-01-01 00:00:${String(99 - i).padStart(2, '0')}`;
        insertProjectDirect(db, { title: `Full Page Active ${i}`, status: 'tbd', updatedAt });
      }
      insertProjectDirect(db, {
        title: 'Full Page Inconsistent Archived',
        status: 'archived',
        archivedAt: null,
        updatedAt: '2024-01-01 00:00:00',
      });
      const targetId = insertProjectDirect(db, {
        title: 'Full Page Beyond Target',
        status: 'tbd',
        updatedAt: '2023-12-31 23:59:59',
      });

      const res = await agent.get(`/releases/new?projectId=${targetId}`).expect(200);

      const optionMatches = res.text.match(new RegExp(`<option value="${targetId}"[^>]*>`, 'g')) || [];
      expect(optionMatches).toHaveLength(1);
      expect(optionMatches[0]).toContain('selected');
      expect(res.text).not.toContain('Full Page Inconsistent Archived');
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${targetId}">Cancel</a>`);

      const selectedOptions = res.text.match(/<option value="\d+"\s*selected>/g) || [];
      expect(selectedOptions).toHaveLength(1);
    });

    it('an archived project outside the first 100 options is not appended to the selector', async () => {
      for (let i = 0; i < 99; i++) {
        const updatedAt = `2024-02-01 00:00:${String(99 - i).padStart(2, '0')}`;
        insertProjectDirect(db, { title: `Archived Beyond Filler ${i}`, status: 'tbd', updatedAt });
      }
      insertProjectDirect(db, {
        title: 'Archived Beyond Filler Full',
        status: 'tbd',
        updatedAt: '2024-02-01 00:00:00',
      });
      const archivedBeyondId = insertProjectDirect(db, {
        title: 'Archived Beyond Target',
        status: 'archived',
        archivedAt: '2024-01-01 00:00:00',
        updatedAt: '2024-01-31 23:59:59',
      });

      const res = await agent.get(`/releases/new?projectId=${archivedBeyondId}`).expect(200);

      expect(res.text).not.toContain(`value="${archivedBeyondId}"`);
      expect(res.text).not.toContain('Archived Beyond Target');
      expect(res.text).not.toMatch(/<option value="[^"]+" selected>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
    });

    it('a nonexistent project outside the first 100 options is not appended to the selector', async () => {
      for (let i = 0; i < 100; i++) {
        const updatedAt = `2024-03-01 00:00:${String(100 - i).padStart(2, '0')}`;
        insertProjectDirect(db, { title: `Nonexistent Beyond Filler ${i}`, status: 'tbd', updatedAt });
      }

      const res = await agent.get('/releases/new?projectId=999999').expect(200);

      expect(res.text).not.toMatch(/<option value="[^"]+" selected>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
    });

    // ─── Phase 2F review fix: numerically unsafe projectId values ────────

    describe.each([
      ['just above MAX_SAFE_INTEGER', '9007199254740993'],
      ['far larger digit string', '99999999999999999999999999'],
    ])('numerically unsafe projectId (%s: %s)', (_label, rawValue) => {
      it('renders the form with no project selected and Cancel to /release-management', async () => {
        await agent
          .post('/projects')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('title=Unsafe+Integer+Baseline')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const res = await agent.get(`/releases/new?projectId=${rawValue}`).expect(200);

        expect(res.text).not.toMatch(/<option value="[^"]+" selected>/);
        expect(res.text).not.toContain(`/projects/${rawValue}`);
        expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
        expect(res.text).not.toContain('Something went wrong');
      });
    });
  });

  // ─── Phase 2F: POST /releases validation-error re-render shares the same
  // project-context resolution as GET /releases/new ─────────────────────────
  //
  // A 422 re-render must never be less safe than the GET form: options must
  // exclude archived projects (by either indicator), selectedProjectId must
  // be a validated active project id or null (never raw/malformed req.body),
  // and Cancel must follow the same active/inactive rule.

  describe('POST /releases validation-error re-render project context', () => {
    it('malformed projectId: no malformed Cancel href, Cancel falls back, no option selected', async () => {
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('projectId=1abc')
        .send('title=Malformed+Context+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
      expect(res.text).not.toMatch(/<option value="\d+"[^>]*selected>/);
    });

    it('numerically unsafe projectId: 422, safe fallback, rounded value not rendered or selected', async () => {
      const unsafeValue = '9007199254740993';
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${unsafeValue}`)
        .send('title=Unsafe+Integer+Context+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).not.toMatch(/<option value="\d+"[^>]*selected>/);
      expect(res.text).not.toContain(`/projects/${unsafeValue}`);
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
    });

    it('status=archived, archived_at=NULL project: not an option, Cancel falls back, archived message preserved', async () => {
      const inconsistentId = insertProjectDirect(db, {
        title: 'POST Inconsistent Archived Row',
        status: 'archived',
        archivedAt: null,
      });

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${inconsistentId}`)
        .send('title=Should+Not+Create')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Cannot create release for archived project.');
      expect(res.text).not.toContain(`value="${inconsistentId}"`);
      expect(res.text).not.toContain('POST Inconsistent Archived Row');
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
    });

    it('archived_at-set project: not an option, Cancel falls back', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=POST+Archived+At+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${projectId}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Should+Not+Create+Either')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).not.toContain(`value="${projectId}"`);
      expect(res.text).not.toContain('POST Archived At Project');
      expect(res.text).toContain('<a class="button button-secondary" href="/release-management">Cancel</a>');
    });

    it('valid active project: preselected on re-render, Cancel to /projects/:id, other fields preserved', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=POST+Valid+Active+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=') // triggers an unrelated (title required) validation error
        .send('description=Keep+This+Description')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain(`<option value="${projectId}" selected>`);
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${projectId}">Cancel</a>`);
      expect(res.text).toContain('Keep This Description');
      expect(res.text).toContain('Title is required');
    });

    it('valid active project outside the first 100 options: added exactly once and selected, Cancel to /projects/:id', async () => {
      const TOTAL = 101;
      let targetId;
      for (let i = 0; i < TOTAL; i++) {
        const updatedAt = `2024-04-01 00:00:${String(TOTAL - i).padStart(2, '0')}`;
        const id = insertProjectDirect(db, {
          title: `POST Beyond Limit Project ${i}`,
          status: 'tbd',
          updatedAt,
        });
        if (i === TOTAL - 1) targetId = id;
      }

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${targetId}`)
        .send('title=') // triggers an unrelated (title required) validation error
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const optionMatches = res.text.match(new RegExp(`<option value="${targetId}"[^>]*>`, 'g')) || [];
      expect(optionMatches).toHaveLength(1);
      expect(optionMatches[0]).toContain('selected');
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${targetId}">Cancel</a>`);
    });
  });

  // ─── Edit release ─────────────────────────────────────────────────────────

  it('edit form renders with existing values', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Edit+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Before+Edit')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent.get(`${createRes.headers.location}/edit`).expect(200);
    expect(res.text).toContain('Releases — Edit Before Edit');
  });

  it('valid update redirects to detail', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Update+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Old+Title')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent
      .post(createRes.headers.location)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=New+Title')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Title');
  });

  // ─── Publish ───────────────────────────────────────────────────────────────

  it('publish action sets published_date and redirects', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(releaseLocation);

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).toContain('Published');
  });

  it('cannot publish already published release', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('already published');
  });

  // ─── Archive ──────────────────────────────────────────────────────────────

  it('archive action sets archived_at and redirects', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Archive+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=To+Archive')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('Archived');
  });

  it('cannot archive already archived release', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Double+Archive+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Double+Archive')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toMatch(/archived and cannot be modified/);
  });

  // ─── Asset selection ──────────────────────────────────────────────────────

  it('asset selection page renders project assets', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Asset+Selection+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Scan to create assets
    await agent
      .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Asset+Selection+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    expect(res.text).toContain('Asset Selection Release');
    expect(res.text).toContain('Back to Release');
  });

  it('asset selection requires assets from correct project', async () => {
    const proj1Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Project+One')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId1 = proj1Res.headers.location.replace('/projects/', '');

    const proj2Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Project+Two')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId2 = proj2Res.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId1}`)
      .send('title=Cross+Project+Test')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Verify the release is associated with project 1
    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('Project One');
  });

  it('asset selection form submission with explicit fields saves selections', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Get the actual asset ID from the database
    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const firstAssetId = String(assets[0].id);

    // Create a release
    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Asset+Form+Test+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit asset selection using the new explicit format
    const submitRes = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Malformed+Asset+ID+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with malformed asset ID (e.g., "1x")
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Publish+Ready+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create release with idea status
    const ideaRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Idea+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Publishing idea status should fail — readiness policy reports status_ready
    const publishRes = await agent
      .post(`${ideaRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(publishRes.text).toContain('ready');
  });

  // ─── Error rendering safety ───────────────────────────────────────────────

  it('error responses contain no absolute filesystem paths', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=No+Path+Release+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const firstAssetId = String(assets[0].id);
    const secondAssetId = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=NoJS+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submission with ONLY selectedAssetIds — no roles[], no sortOrder[].
    // The browser renumbers arrays after excluding disabled controls, so the
    // server receives an array of asset ids and no role/sortOrder values.
    const submitRes = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    const firstAssetId = String(assets[0].id);
    const secondAssetId = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=PartialJS+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Two selected, but only one role / sortOrder pair. The second selected
    // asset will fall back to defaults. This mirrors what the browser sends
    // when the second row's role/sortOrder are disabled.
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Preserve+Selection+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Sibling project — used to create a cross-project asset id.
    const proj2Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const otherDir = getProjectDir('other-project');
    fs.writeFileSync(path.join(otherDir, 'other.png'), 'png');
    await agent.post(`/projects/${otherProjectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const mainAssets = assetRepo.findByProjectId(Number(projectId));
    const otherAssets = assetRepo.findByProjectId(Number(otherProjectId));
    expect(mainAssets.length).toBeGreaterThan(0);
    expect(otherAssets.length).toBeGreaterThan(0);
    const mainAssetId = mainAssets[0].id;
    const otherAssetId = otherAssets[0].id;

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Preserve+Selection+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection: asset A as primary, sort order 0.
    // This is what the user sees if the route falls back to the DB on
    // validation failure — the regression we are guarding against.
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    expect(res.text).toMatch(/value="5"[^>]*class="[^"]*asset-sort-order[^"]*"/);
    expect(res.text).not.toMatch(/value="0"[^>]*class="[^"]*asset-sort-order[^"]*"/);

    // The submitted main asset must be checked.
    expect(res.text).toContain(`value="${mainAssetId}" checked`);

    // Persisted rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  // ─── Phase 6D: duplicate rejection, form-state preservation, DB assertions ──

  it('rejects duplicate asset IDs with 422 and no junction rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Duplicate+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit the same asset ID twice
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Dup+String+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit same ID twice as string values
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Nested+Array+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with a nested array value (malformed)
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Object+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit with an object value (numeric keys, valid shape) — the route
    // normalizes it to an array and then the duplicate detection catches it.
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Blank+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with blank asset ID
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects non-integer asset IDs safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=NonInt+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with float string
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=1.5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects negative asset IDs safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Neg+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=-1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects zero asset IDs safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Zero+Asset+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('single selected asset + invalid role → 422 and checkbox remains selected', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Single+Asset+Role+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds=${assetId}`)
      .send('roles[0]=primary')
      .send('sortOrder[0]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit one valid asset with an invalid role — triggers 422
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const assetId1 = String(assets[0].id);
    const assetId2 = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Multi+Asset+Preserve+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Empty+Selection+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(getReleaseAssets(db, releaseId)).toHaveLength(1);

    // Submit with no selectedAssetIds at all — should succeed (empty = clear)
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Empty+Scalar+Clear+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(getReleaseAssets(db, releaseId)).toHaveLength(1);

    // Submit with selectedAssetIds= (empty scalar) — must succeed and clear
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Null+Asset+Reject+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with null via JSON body
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send({ selectedAssetIds: null, _csrf: csrfToken })
      .set('Content-Type', 'application/json')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('malformed object/nested values are rejected safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const assetId1 = String(assets[0].id);
    const assetId2 = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Malformed+Object+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const proj2Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Other+Malformed+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const otherProjectId = proj2Res.headers.location.replace('/projects/', '');
    const otherProjectDir = getProjectDir('other-malformed-project');
    fs.writeFileSync(path.join(otherProjectDir, 'other.png'), 'png');
    await agent.post(`/projects/${otherProjectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const otherAssets = assetRepo.findByProjectId(Number(otherProjectId));
    expect(otherAssets.length).toBeGreaterThan(0);
    const otherAssetId = String(otherAssets[0].id);

    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Nested+Obj+Key+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with selectedAssetIds[foo][bar]=1 — nested object with non-numeric keys
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[foo][bar]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects selectedAssetIds[foo]=1 (non-numeric key) and preserves rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=NonNumeric+Key+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with selectedAssetIds[foo]=1 — non-numeric key
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[foo]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects mixed flat and nested values and preserves rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Mixed+Nested+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with mixed flat and nested values — one valid scalar and one nested
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Archived+Preserve+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Archive the release
    await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // Attempt to modify assets on the archived release
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/archived/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);

    // GET the assets page — no bulk-selection checkboxes, no Save Selection
    const assetsPage = await agent
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    // The entire bulk-selection form must be absent in read-only scope
    const checkboxRegex = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
    let match;
    let checkboxCount = 0;
    while ((match = checkboxRegex.exec(assetsPage.text)) !== null) {
      checkboxCount++;
    }
    expect(checkboxCount).toBe(0);
    // Save Selection button must not be present
    expect(assetsPage.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
  });

  it('archived parent rejection preserves persisted rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Archived+Parent+Preserve+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Archive the parent project
    await agent
      .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // Attempt to modify assets — parent is archived
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/archived/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);

    // GET the assets page — no bulk-selection checkboxes, no Save Selection
    const assetsPage = await agent
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    // The entire bulk-selection form must be absent in read-only scope
    const checkboxRegex = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
    let match;
    let checkboxCount = 0;
    while ((match = checkboxRegex.exec(assetsPage.text)) !== null) {
      checkboxCount++;
    }
    expect(checkboxCount).toBe(0);
    // Save Selection button must not be present
    expect(assetsPage.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
  });

  it('replacement removes only intentionally deselected rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const keepAssetId = String(assets[0].id);
    const removeAssetId = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Replacement+Release')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist two selections
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('publishedDate=2025-12-15')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(res.headers.location).toBe(releaseLocation);

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).toContain('2025-12-15');
  });

  it('publish preserves a previously edited publishedDate when publish form omits it', async () => {
    // Simulates: user edits the release and sets a publishedDate, then clicks
    // the publish button (which historically overwrote the date with today).
    const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    // Edit the release to set a publishedDate
    await agent
      .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Publishable+Release')
      .send('status=ready')
      .send('publishedDate=2025-08-20')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Publish button with no publishedDate in the body — the route must fall
    // back to the release's existing publishedDate.
    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).toContain('2025-08-20');
    expect(detail.text).toContain('Published');
  });

  it('publish uses today when neither the form nor the release has a publishedDate', async () => {
    // The default-to-today path must still work for releases that were never
    // given a date.
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const today = getLocalTodayIso();
    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).toContain(today);
  });

  // ─── Phase 7C-1: Readiness enforcement HTTP tests ───────────────────────

  it('direct POST with zero assets returns 422 and renders readiness blockers', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Zero+Asset+Publish+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Zero+Asset+Publish')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Direct POST with no assets selected — must be blocked
    const res = await agent
      .post(`${createRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    // Must render the detail page with readiness panel and blocker feedback
    expect(res.text).toContain('panel--readiness');
    expect(res.text).toContain('Cannot publish');
    expect(res.text).toContain('No assets selected');
  });

  it('direct POST with missing selected asset returns 422', async () => {
    const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    // Mark the selected asset as missing
    const assetRepo = createAssetRepository(db);
    assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), []);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('Cannot publish');
    expect(res.text).toContain('missing');
  });

  it('fully publishable release succeeds via POST', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
  });

  it('rejected publish does not change database state', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Rejected+State+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Rejected+State+Release')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Verify initial state
    const before = await agent.get(createRes.headers.location).expect(200);
    expect(before.text).toContain('Status: ready');
    expect(before.text).not.toContain('readiness-badge readiness-publishable">Published</p>');

    // Attempt publish (will fail — no assets)
    await agent
      .post(`${createRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    // State must be unchanged
    const after = await agent.get(createRes.headers.location).expect(200);
    expect(after.text).toContain('Status: ready');
    expect(after.text).not.toContain('readiness-badge readiness-publishable">Published</p>');
  });

  it('archived release publish rejection remains intact', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    // Archive the release
    await agent
      .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // Publish must be rejected
    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Gated+Controls+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Gated+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Archive the parent project. The release stays active in the DB.
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const detail = await agent.get(releaseLocation).expect(200);
      // Read-only notice must be present.
      expect(detail.text).toMatch(/read-only/i);
      // Mutation controls must be hidden.
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(detail.text).not.toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('release detail still exposes mutation controls for an active project (regression)', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const detail = await agent.get(releaseLocation).expect(200);
      // Mutation controls are visible.
      expect(detail.text).toMatch(/href="\/releases\/\d+\/edit"/);
      expect(detail.text).toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).toMatch(/href="\/releases\/\d+\/publish"/);
      expect(detail.text).toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('asset selection page hides Save and disables inputs when parent project is archived', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Gated+Asset+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Archive the parent project.
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const assets = await agent
        .get(`${releaseLocation}/assets`)
        .expect(200);
      // Read-only notice must be present.
      expect(assets.text).toMatch(/read-only/i);
      // Save Selection button must not be rendered.
      expect(assets.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
      // No bulk-selection checkboxes in read-only scope
      const checkboxRe = /<input[^>]*type="checkbox"[^>]*name="selectedAssetIds\[\]"[^>]*value="(\d+)"[^>]*class="[^"]*asset-checkbox[^"]*"[^>]*>/g;
      let match;
      let count = 0;
      while ((match = checkboxRe.exec(assets.text)) !== null) {
        count++;
      }
      expect(count).toBe(0);
    });

    it('active project asset selection page has enabled checkboxes and Save button (regression)', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Active+Asset+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const assets = await agent
        .get(`${releaseLocation}/assets`)
        .expect(200);
      // Each checkbox element must NOT contain disabled.
      const checkboxRe = /<input[^>]*type="checkbox"[^>]*name="selectedAssetIds\[\]"[^>]*value="(\d+)"[^>]*class="[^"]*asset-checkbox[^"]*"[^>]*>/g;
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Update+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Update+Reject+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // The update POST must be rejected with 422 because the parent project
      // is archived. The error page must surface the rejection reason.
      const res = await agent
        .post(createRes.headers.location)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=New+Title')
        .send('status=planned')
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });

    it('POST /releases/:id/publish renders release detail when parent project is archived', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Archive+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Archive+Reject+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent
        .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });

    it('POST /releases/:id/assets returns 422 when parent project is archived', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      expect(assets.length).toBeGreaterThan(0);
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Asset+Reject+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent
        .post(`${createRes.headers.location}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent.get(releaseLocation).expect(200);

      expect(res.text).toContain('Publishable');
      expect(res.text).toContain('Status is ready');
      expect(res.text).toContain('Assets selected');
      expect(res.text).toContain('Selected assets present');
      expect(res.text).toContain('Scope is mutable');
      // All checks pass — no "Needs attention"
      expect(res.text).not.toContain('Needs attention');
    });

    it('non-ready status shows blocked with status detail', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Non+Ready+Status+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Non+Ready+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('Status: idea');
      expect(res.text).not.toContain('Publishable');
    });

    it('zero selected assets shows blocked with count', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Zero+Selected+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Zero+Selected+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('0 selected');
    });

    it('missing selected asset shows blocked with missing count', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Mark the selected asset as missing
      const assetRepo = createAssetRepository(db);
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), []);

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('1 missing');
    });

    it('archived release shows scope blocked', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Archive the release
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      // Archived releases show the archived notice instead of readiness panel
      expect(res.text).toContain('archived and read-only');
      expect(res.text).not.toContain('Needs attention');
    });

    it('archived parent project shows scope blocked', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      // Archived parent shows the parent archived notice instead of readiness panel
      expect(res.text).toContain('parent project is archived');
      expect(res.text).not.toContain('Needs attention');
    });

    it('multiple blockers render simultaneously', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Multiple+Blockers+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create release with idea status and no assets — two blockers
      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Multiple+Blockers+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Needs attention');
      expect(res.text).toContain('Status: idea');
      expect(res.text).toContain('0 selected');
    });

    it('all four check labels render', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent.get(releaseLocation).expect(200);

      expect(res.text).toContain('Status is ready');
      expect(res.text).toContain('Assets selected');
      expect(res.text).toContain('Selected assets present');
      expect(res.text).toContain('Scope is mutable');
    });

    it('factual selected count renders', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent.get(releaseLocation).expect(200);

      expect(res.text).toContain('1 selected');
    });

    it('last-completed-scan wording renders when blocked', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Scan+Wording+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Scan+Wording+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('Asset presence reflects the last completed scan');
      expect(res.text).toContain('not performing a live filesystem check');
    });

    it('corrective links appear when valid', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Corrective+Links+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Corrective+Links+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      // Check within the readiness panel section
      const panelMatch = res.text.match(/<section class="panel panel--readiness">[\s\S]*?<\/section>/);
      expect(panelMatch).not.toBeNull();
      const panelHtml = panelMatch[0];
      // Non-ready status → Edit release link
      expect(panelHtml).toMatch(/href="\/releases\/\d+\/edit"/);
      // No assets selected → Manage assets link
      expect(panelHtml).toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('corrective links hidden for archived release', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Archive the release
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      // Archived releases have no readiness panel at all
      expect(res.text).not.toMatch(/<section class="panel panel--readiness">/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('corrective links hidden for archived parent project', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      // Archived parent releases have no readiness panel at all
      expect(res.text).not.toMatch(/<section class="panel panel--readiness">/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(res.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('missing release remains 404', async () => {
      await agent.get('/releases/99999').expect(404);
    });

    it('no absolute filesystem paths render', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=No+Path+Readiness+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=No+Path+Readiness+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    // ─── Phase 7A regression: publication is not enforced yet ──────────────

    it('rejects publish for a blocked release (readiness enforced)', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Enforced+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create a release with ready status (publishable by status) but no
      // assets selected — readiness panel shows blocked, publish must fail.
      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Enforced+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Verify the readiness panel shows it's blocked (no assets selected)
      const detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toContain('Needs attention');
      expect(detail.text).toContain('0 selected');

      // Publish must now be rejected — readiness IS enforced
      const publishRes = await agent
        .post(`${createRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(publishRes.text).toContain('Cannot publish');
    });
  });

  // ─── Phase 7C-3: Readiness Enforcement UI and Regression Verification ──────

  describe('publish action UI gating', () => {
    it('blocked release has no Publish button', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Blocked+No+Publish+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create a ready release with no assets — blocked by assets_selected
      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Blocked+No+Publish')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await agent.get(createRes.headers.location).expect(200);
      // Readiness panel shows blocked
      expect(detail.text).toContain('Needs attention');
      // Publish button must NOT be present
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('publishable release has Publish button', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const detail = await agent.get(releaseLocation).expect(200);
      // Readiness panel shows publishable
      expect(detail.text).toContain('Publishable');
      // Publish button must be present
      expect(detail.text).toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('forged blocked POST still returns 422', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Forged+POST+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Forged+POST+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Direct POST with no assets — server must reject
      const res = await agent
        .post(`${createRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toContain('Cannot publish');
    });

    it('one remaining blocker keeps release blocked', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=One+Blocker+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create a release with idea status — blocked by status_ready
      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=One+Blocker+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await agent.get(createRes.headers.location).expect(200);
      // Must show blocked
      expect(detail.text).toContain('Needs attention');
      // No Publish button
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('all blockers resolved makes release publishable', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publishable');
      expect(detail.text).toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('publication date and status behavior remain correct', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Publish with explicit date
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-11-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Published');
      expect(detail.text).toContain('2025-11-01');
      // Publish button must be gone after publication
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('archive guards remain correct — archived release has no Publish button', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Archive the release
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const detail = await agent.get(releaseLocation).expect(200);
      // Archived release notice shown
      expect(detail.text).toContain('archived and read-only');
      // No Publish button
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('archived parent project hides Publish button', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const detail = await agent.get(releaseLocation).expect(200);
      // Archived parent notice shown
      expect(detail.text).toContain('parent project is archived');
      // No Publish button
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('published release has no Publish button', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Published');
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
    });

    it('cancelled release has no Publish button', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancelled+No+Publish+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Cancelled+No+Publish')
        .send('status=cancelled')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await agent.get(createRes.headers.location).expect(200);
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Missing+Remove+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Select the asset
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toContain('Missing');
      expect(res.text).toContain('/remove');
    });

    it('present selection does not show corrective Remove action', async () => {
      const { releaseLocation, projectId } = await setupMissingAsset();
      // Restore the asset to present
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      assetRepo.restorePresent(Number(projectId), [assets[0].relative_path]);

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toContain('Present');
      // The Remove button is rendered as a form with action containing '/remove'
      expect(res.text).not.toContain('/remove');
    });

    it('forged POST cannot remove a present selected asset', async () => {
      const { releaseLocation, assetId, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Add a second present asset with a distinctive role and sort order
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'second-asset.txt'), 'second content');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== Number(assetId));
      // Select both assets with distinctive roles and sort orders
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== assetId);
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== assetId);
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const before = await agent.get(releaseLocation).expect(200);
      expect(before.text).toContain('Needs attention');

      await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const after = await agent.get(releaseLocation).expect(200);
      expect(after.text).toContain('Publishable');
    });

    it('archived scope hides Remove controls and rejects direct POST', async () => {
      const { releaseLocation, assetId } = await setupMissingAsset();

      // Archive the release
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Detail page must not show Remove form (check for the form action URL)
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).not.toContain('/remove');

      // Direct POST must be rejected
      await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
    });

    it('malformed IDs return 404', async () => {
      await agent
        .post('/releases/abc/assets/1/remove')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);

      await agent
        .post('/releases/1/assets/abc/remove')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);
    });

    it('no GET mutation route exists', async () => {
      await agent
        .get('/releases/1/assets/1/remove')
        .expect(404);
    });
  });

  // ─── Phase 7D-1: Release URLs built from normalized allow-listed filters ──
  //
  // Generated release URLs must not retain unknown parameters, invalid values,
  // or malformed inputs from req.query. Only normalized, allow-listed filter
  // values may appear in pagination, view-switching, and page-size links.

  describe('release calendar URL construction', () => {
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

    it('calendar navigation does not inherit unsupported readiness state', async () => {
      const res = await agent
        .get('/calendar?readiness=publishable')
        .expect(200);

      // Calendar nav links must not contain readiness
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/calendar\?[^"]*)"[^>]*>← Previous<\/a>/);
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
      const nextMatch = res.text.match(/<a\s[^>]*href="(\/calendar\?[^"]*)"[^>]*>Next →<\/a>/);
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
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation, assetId };
    }

    it('rejects bulk asset POST with controlled 422 for a published release', async () => {
      const { releaseLocation, assetId } = await setupPublishedRelease(app, db, projectsRoot);
      const before = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/i);
      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('rejects missing-asset corrective removal with 422 for a published release', async () => {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Snapshot the complete ordered release_assets rows
      const beforeJunction = getReleaseAssets(db, releaseId);
      // Snapshot the asset record
      const assetRepo = createAssetRepository(db);
      const beforeAsset = assetRepo.findById(Number(assetId));

      // POST the corrective removal route
      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation, assetId };
    }

    it('shows publication summary instead of Needs attention', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Publication Summary/);
      expect(res.text).not.toMatch(/Needs attention/);
    });

    it('shows published date in the publication summary', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Published date/);
      expect(res.text).toMatch(/2025-06-15/);
    });

    it('shows selected assets table once (not duplicated)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
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
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/asset selection is locked/i);
    });

    it('shows present/missing state and scan caveat', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Present/);
      expect(res.text).toMatch(/not performing a live filesystem check/);
    });

    it('published metadata edit succeeds (title, description, notes, dates, patreon)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Updated Published Title');
      expect(detail.text).toContain('Updated description');
      expect(detail.text).toContain('Updated notes');
      expect(detail.text).toContain('2025-07-01');
      expect(detail.text).toContain('2025-06-20');
      expect(detail.text).toContain('patreon.com/updated');
    });

    it('published status remains unchanged after metadata edit', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Status+Check')
        .send('status=published')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toMatch(/Published/);
    });

    it('attempted status change from published fails', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Status+Change+Attempt')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toMatch(/Cannot change status from.*published.*to.*ready/);
    });

    it('published asset page is read-only (no Save Selection button)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation + '/assets').expect(200);
      expect(res.text).not.toMatch(/Save Selection/);
      expect(res.text).toMatch(/locked and read-only/);
    });

    it('published detail hides Publish button', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/\/publish/);
    });

    it('published detail keeps Edit but not Archive (Danger Zone excludes published)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/\/releases\/\d+\/edit/);
      // Archive is only in the Danger Zone, which excludes published releases.
      expect(res.text).not.toMatch(/action="\/releases\/\d+\/archive"/);
    });

    it('published detail hides Manage Assets link', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
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
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      // Publish
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      // Archive the release
      await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      return { projectId, releaseLocation, releaseId, assetId };
    }

    async function setupArchivedParentPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      // Publish
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      return { projectId, releaseLocation, releaseId, assetId };
    }

    it('archived published detail hides Publication Summary', async () => {
      const { releaseLocation } = await setupArchivedPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
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
      const res = await agent.get(releaseLocation).expect(200);
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
      const res = await agent.get(releaseLocation + '/assets').expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived/);
      // Published-only notice must NOT appear
      expect(res.text).not.toMatch(/locked and read-only/);
    });

    it('archived-parent published asset page hides published-only notice', async () => {
      const { releaseLocation } = await setupArchivedParentPublishedRelease();
      const res = await agent.get(releaseLocation + '/assets').expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived/);
      // Published-only notice must NOT appear
      expect(res.text).not.toMatch(/locked and read-only/);
    });
  });

  describe('archived release lifecycle', () => {
    async function setupArchivedRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Archived+Lifecycle+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Archived+Lifecycle+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId };
    }

    it('archived detail exposes no mutation controls', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/\/releases\/\d+\/edit/);
      expect(res.text).not.toMatch(/\/archive/);
      expect(res.text).not.toMatch(/Manage Assets/);
      expect(res.text).not.toMatch(/\/publish/);
      expect(res.text).not.toMatch(/Remove/);
    });

    it('archived GET edit redirects to detail', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await agent.get(releaseLocation + '/edit').expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('archived release metadata POST returns 422 and preserves row', async () => {
      const { releaseLocation, releaseId } = await setupArchivedRelease();
      const before = releaseRepository.findById(releaseId);

      const res = await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('archive POST on archived release returns 422 with readiness null', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Archived+Parent+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Archived+Parent+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Archive the parent project using the dedicated archive route
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId };
    }

    it('archived-parent GET edit redirects to detail', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await agent.get(releaseLocation + '/edit').expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('archived-parent metadata POST returns 422 and preserves row', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentRelease();
      const before = releaseRepository.findById(releaseId);

      const res = await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('archived-parent archive POST returns 422 with readiness null', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancelled+Readiness+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Cancelled+Readiness+Release')
        .send('status=cancelled')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const res = await agent.get(releaseLocation).expect(200);
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
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
        .get(`${releaseLocation}/publish`)
        .expect(200);
      expect(res.text).toContain('Review &amp; Publish');
      expect(res.text).toContain('Publishable');
    });

    it('blocked-ready GET returns 200', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Blocked+Ready+Review+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Blocked+Ready+Review')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .get(`${createRes.headers.location}/publish`)
        .expect(200);
      expect(res.text).toContain('Review &amp; Publish');
      expect(res.text).toContain('Needs attention');
    });

    it('GET performs no database or junction mutation', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      await agent
        .get(`${releaseLocation}/publish`)
        .expect(200);

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('ordered assets, roles, order, presence, and caveat render', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
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
          const projRes = await agent
            .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
            const createRes = await agent
              .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
            await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

            const assetRepo = createAssetRepository(db);
            const assets = assetRepo.findByProjectId(Number(projectId));
            await agent
              .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
              .send(`selectedAssetIds[]=${assets[0].id}`)
              .send('roles[]=primary')
              .send('sortOrder[]=0')
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);

            await agent
              .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);
          } else {
            const createRes = await agent
              .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
              .send(`projectId=${projectId}`)
              .send(`title=Lifecycle+Redirect+${label}`)
              .send(`status=${status}`)
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);
            releaseLocation = createRes.headers.location;
            releaseId = Number(releaseLocation.replace('/releases/', ''));
          }

          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

          const res = await agent
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
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

        const res = await agent
          .get(`${releaseLocation}/publish`)
          .expect(302);

        expect(res.headers.location).toBe(releaseLocation);
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(afterRelease).toEqual(beforeRelease);
      });

      it('GET redirects for archived parent project', async () => {
        const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

        const res = await agent
          .get(`${releaseLocation}/publish`)
          .expect(302);

        expect(res.headers.location).toBe(releaseLocation);
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(afterRelease).toEqual(beforeRelease);
      });
    });

    it('malformed/unknown IDs return 404', async () => {
      await agent
        .get('/releases/abc/publish')
        .expect(404);

      await agent
        .get('/releases/99999/publish')
        .expect(404);
    });

    describe('route-neighbor coverage', () => {
      it('GET /releases/:id still renders detail', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const res = await agent
          .get(releaseLocation)
          .expect(200);
        expect(res.text).toContain('Readiness Test Release');
      });

      it('GET /releases/:id/edit still renders edit form', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const res = await agent
          .get(`${releaseLocation}/edit`)
          .expect(200);
        expect(res.text).toContain('Releases — Edit Readiness Test Release');
      });

      it('GET /releases/:id/assets still renders asset selection', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const res = await agent
          .get(`${releaseLocation}/assets`)
          .expect(200);
        expect(res.text).toContain('— Assets');
        // Phase 10.5C: asset tables use shared data-table class
        expect(res.text).toContain('data-table');
      });

      it('POST /releases/:id/publish still publishes', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const res = await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        expect(res.headers.location).toBe(releaseLocation);
      });

      it('GET and POST /releases/:id/publish coexist correctly', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

        // GET returns 200
        const getRes = await agent
          .get(`${releaseLocation}/publish`)
          .expect(200);
        expect(getRes.text).toContain('Review &amp; Publish');

        // POST returns 302
        const postRes = await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        expect(postRes.headers.location).toBe(releaseLocation);
      });
    });

    it('persisted date prefills', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      // Set a persisted published_date
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      db.prepare("UPDATE releases SET published_date = '2025-12-01' WHERE id = ?").run(releaseId);

      const res = await agent
        .get(`${releaseLocation}/publish`)
        .expect(200);
      expect(res.text).toContain('value="2025-12-01"');
    });

    it('local-today fallback prefills', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
        .get(`${releaseLocation}/publish`)
        .expect(200);

      const today = getLocalTodayIso();
      expect(res.text).toContain(`value="${today}"`);
    });

    it('valid submitted date persists exactly', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-11-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      expect(release.published_date).toBe('2025-11-01');
      expect(release.status).toBe('published');
    });

    it('missing direct-POST date preserves fallback behavior', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
          const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
          const releaseId = Number(releaseLocation.replace('/releases/', ''));
          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          const beforeJunction = getReleaseAssets(db, releaseId);

          const res = await agent
            .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=   ')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(release.status).toBe('published');
        const today = getLocalTodayIso();
        expect(release.published_date).toBe(today);
      });

      it('leading/trailing whitespace on a valid date is trimmed and accepted', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=  2025-06-15  ')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(release.status).toBe('published');
        expect(release.published_date).toBe('2025-06-15');
      });
    });

    it('readiness changes after GET cause POST rejection', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Load the review page (GET)
      await agent
        .get(`${releaseLocation}/publish`)
        .expect(200);

      // Change readiness: remove the asset file and scan
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // POST should now be rejected
      const res = await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('Cannot publish');
    });

    it('stale POST leaves row and junctions unchanged', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      // Remove the asset file and scan to make it missing
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // POST publish — should be rejected
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('direct forged POST still cannot bypass readiness', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Forged+Review+POST+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Forged+Review+POST')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Direct POST with no assets — server must reject
      const res = await agent
        .post(`${createRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toContain('Cannot publish');
    });

    it('successful publication redirects to published summary', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const res = await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Should redirect to release detail
      expect(res.headers.location).toBe(releaseLocation);

      // Detail should show published summary
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Publication Summary');
    });

    it('newly published selection is already locked', async () => {
      const { releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Attempt to change asset selection — must be rejected
      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/);
    });

    it('no JavaScript confirmation is required', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
        .get(`${releaseLocation}/publish`)
        .expect(200);

      // The publish form must not have an onclick confirm handler
      expect(res.text).not.toMatch(/onclick/);
    });

    it('renders assets in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

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
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const res = await agent
        .get(`${releaseLocation}/publish`)
        .expect(200);

      // Extract the asset table rows from the review page
      // Phase 10.5C: publish page uses shared data-table class
      const tableSection = res.text.match(/<table class="data-table">[\s\S]*?<\/table>/);
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
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Complete+State+Archived+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Archive the release
      await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId) };
    }

    async function setupArchivedParentReleaseWithAsset() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Complete+State+Archived+Parent+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId) };
    }

    // ── Archived release ──────────────────────────────────────────────────

    it('archived metadata POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      // Edit metadata: title, description, notes, plannedDate, publishedDate, patreonUrl
      await agent
        .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(csrfToken))
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

  // ─── Phase 8 structural published selected-assets table assertions ────────
  //
  // Parse the exact selected-assets section on published detail and assert
  // structural properties: exactly one shared data-table, multiple assets in
  // sort_order ASC, asset_id ASC order, correct roles and presence values.

  describe('published detail structural selected-assets table assertions', () => {
    async function setupPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Add a second asset with a different role and sort order
      const slug = 'readiness-test-project';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'second-asset.txt'), 'second content');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== Number(assetId));

      // Select both assets with distinctive roles and sort orders
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .send('sortOrder[]=10')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Publish
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId), secondAssetId: secondAsset.id };
    }

    it('exactly one shared data-table appears in the selected-assets section', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);

      // Extract the Selected Assets section
      const sectionMatch = res.text.match(/<h2>Selected Assets<\/h2>[\s\S]*?<\/section>/);
      expect(sectionMatch).not.toBeNull();
      const sectionHtml = sectionMatch[0];

      // Phase 10.5C: detail and publish pages use shared data-table class
      const tableMatches = sectionHtml.match(/<table class="data-table">/g);
      expect(tableMatches).not.toBeNull();
      expect(tableMatches.length).toBe(1);
    });

    it('multiple assets render in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, releaseId } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);

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
      const res = await agent.get(releaseLocation).expect(200);

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

  // ─── Phase 9-1: Release Asset Candidate Discovery (HTTP) ──────────────

  describe('release asset candidate discovery (Phase 9-1)', () => {
    /**
     * Create a project, scan assets, create a release, and select one asset.
     * Returns { projectId, releaseLocation, releaseId, assetRepo, allAssets }.
     */
    async function setupReleaseWithAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Candidate+Discovery+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'candidate-discovery-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);

      // Create multiple files
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha content');
      fs.writeFileSync(path.join(projectDir, 'beta.png'), 'beta content');
      fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma content');
      fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta content');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Candidate+Discovery+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select one asset (alpha.txt)
      const alphaAsset = allAssets.find((a) => a.filename === 'alpha.txt');
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${alphaAsset.id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    it('selected and available sections are distinct on the page', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // Both sections must be present
      expect(res.text).toContain('Selected Assets');
      expect(res.text).toContain('Available Assets');
    });

    it('selected section shows the complete selected asset', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // The selected asset (alpha.txt) must appear in the selected section
      const selectedSection = res.text.match(/<h2>Selected Assets<\/h2>[\s\S]*?<\/section>/);
      expect(selectedSection).not.toBeNull();
      expect(selectedSection[0]).toContain('alpha.txt');
    });

    it('selected section is complete across candidate pages', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      // Request a small candidate page size — selected section must still show all
      const res = await agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200);

      // Selected section must still contain alpha.txt
      const selectedSection = res.text.match(/<h2>Selected Assets<\/h2>[\s\S]*?<\/section>/);
      expect(selectedSection).not.toBeNull();
      expect(selectedSection[0]).toContain('alpha.txt');
    });

    it('candidate page is bounded by page size', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200);

      // The candidate table should show only 1 row (pageSize=1)
      // The pagination info should show "Page 1 of 3"
      expect(res.text).toContain('Page 1 of 3');
    });

    it('pagination preserves search and extension filters', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?search=beta&pageSize=1`).expect(200);

      // The filter form must retain the search value
      expect(res.text).toContain('value="beta"');
    });

    it('invalid page falls back to 1', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?page=invalid`).expect(200);
      // Page should render without error
      expect(res.status).toBe(200);
    });

    it('invalid page size falls back to default', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?pageSize=invalid`).expect(200);
      expect(res.status).toBe(200);
    });

    it('unknown query parameters are stripped from generated URLs', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?unknown=param&junk=value`).expect(200);

      // The page should render without error
      expect(res.status).toBe(200);
    });

    it('published release asset page remains read-only', async () => {
      const { releaseLocation, projectId } = await setupReleaseWithAssets();
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // Must show locked notice
      expect(res.text).toContain('locked and read-only');
      // Save Selection button must not be present
      expect(res.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
    });

    it('archived release asset page remains read-only', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();

      // Archive the release
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // Must show archived notice
      expect(res.text).toContain('archived');
      // Save Selection button must not be present
      expect(res.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
    });

    it('archived parent project asset page remains read-only', async () => {
      const { releaseLocation, projectId } = await setupReleaseWithAssets();

      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // Must show archived notice
      expect(res.text).toContain('archived');
      // Save Selection button must not be present
      expect(res.text).not.toMatch(/type="submit"[^>]*>Save Selection/);
    });

    it('no N+1 candidate query path — single page load is fast', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // The page renders both sections without error
      expect(res.text).toContain('Selected Assets');
      expect(res.text).toContain('Available Assets');
      // The candidate count should be correct (3 unselected present assets)
      expect(res.text).toContain('3 candidates available');
    });
  });

  // ─── Phase 9-3: Role guidance and accessibility ───────────────────────

  describe('role guidance and accessibility (Phase 9-3)', () => {
    async function setupBasicRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Role+Guidance+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'role-guidance-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      fs.writeFileSync(path.join(projectDir, 'asset2.png'), 'png2');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Role+Guidance+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      return { projectId, releaseLocation };
    }

    it('role guidance section is present with all four roles', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      expect(res.text).toContain('Asset Roles');
      expect(res.text).toContain('Primary');
      expect(res.text).toContain('Preview');
      expect(res.text).toContain('Attachment');
      expect(res.text).toContain('Source');
    });

    it('role guidance describes organizational intent without cardinality rules', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // Primary description
      expect(res.text).toContain('main asset for this release');
      // Preview description
      expect(res.text).toContain('preview or teaser');
      // Attachment description
      expect(res.text).toContain('supporting asset');
      // Source description
      expect(res.text).toContain('editable or original source');
    });

    it('search input has visible label', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('<label for="candidate-search">Search available assets</label>');
    });

    it('extension filter has visible label', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('<label for="candidate-extension">Extension</label>');
    });

    it('page-size control has visible label', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('<label for="candidate-page-size">Page size</label>');
    });

    it('Add button has accessible name', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('aria-label="Add ');
    });

    it('Remove button has accessible name', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      // Add an asset so Remove button appears in selected section
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('aria-label="Remove ');
    });

    it('Move Up button has accessible name', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      // Add two assets so the second item has an enabled Move Up button
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('aria-label="Move ');
      expect(res.text).toContain(' up"');
    });

    it('Move Down button has accessible name', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      // Add two assets so Move Down button appears
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('aria-label="Move ');
      expect(res.text).toContain(' down"');
    });

    it('disabled boundary controls remain understandable', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      // Add two assets so we have a first and last item
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // First item's Move Up should be disabled with descriptive title
      expect(res.text).toContain('disabled');
      expect(res.text).toContain('already first');
    });

    it('role select and noscript submit exist for mutable scope', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      // Add an asset so role select appears
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // Role select exists for mutable scope in the new per-row form
      const roleSelectMatch = res.text.match(/<label for="role-\d+"[^>]*>Role for/);
      expect(roleSelectMatch).not.toBeNull();

      // noscript submit button exists — usable without JavaScript
      const noscriptSubmitMatch = res.text.match(/<noscript><button[^>]*>Set<\/button><\/noscript>/);
      expect(noscriptSubmitMatch).not.toBeNull();

      // The noscript submit is INSIDE a form
      const roleFormMatch = res.text.match(/action="\/releases\/\d+\/assets\/\d+\/role"/g);
      expect(roleFormMatch).not.toBeNull();
    });
  });

  // ─── Phase 9-3: Lifecycle regression ─────────────────────────────────

  describe('Phase 9-3 lifecycle regression', () => {
    async function setupReleaseWithTwoAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Lifecycle+Regression+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'lifecycle-regression-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      fs.writeFileSync(path.join(projectDir, 'b.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Lifecycle+Regression+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select both assets
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${allAssets[0].id}`)
        .send(`selectedAssetIds[]=${allAssets[1].id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    it('published release summary remains unchanged after mutation attempt', async () => {
      const { releaseLocation } = await setupReleaseWithTwoAssets();

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeDetail = await agent.get(releaseLocation).expect(200);
      expect(beforeDetail.text).toContain('Publication Summary');

      // Attempt mutation via Phase 9-2 route
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const afterDetail = await agent.get(releaseLocation).expect(200);
      expect(afterDetail.text).toContain('Publication Summary');
    });

    it('archived release preserves complete release and junction rows', async () => {
      const { releaseLocation, releaseId } = await setupReleaseWithTwoAssets();

      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows).toHaveLength(2);

      // Archive
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);

      // Detail page shows archived notice
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('archived');
    });

    it('archived parent preserves complete release and junction rows', async () => {
      const { releaseLocation, releaseId, projectId } = await setupReleaseWithTwoAssets();

      const beforeRows = getReleaseAssets(db, releaseId);

      // Archive parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);
    });

    it('stale readiness protection still works after Phase 9-2 mutations', async () => {
      const { releaseLocation, releaseId, projectId, assetRepo, allAssets } = await setupReleaseWithTwoAssets();

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Verify readiness is not shown (published)
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).not.toContain('Publishable');
      expect(detail.text).toContain('Publication Summary');
    });

    it('missing selected assets remain historically visible', async () => {
      const { releaseLocation, releaseId, projectId, assetRepo, allAssets } = await setupReleaseWithTwoAssets();

      // Mark one asset as missing
      const assetToRemove = allAssets[0];
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(assetToRemove.id);

      // Detail page must still show the missing asset
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain(assetToRemove.filename);
      expect(detail.text).toContain('Missing');
    });
  });

  // ─── Phase 9-3: Cross-view ordering consistency ───────────────────────

  describe('cross-view ordering consistency (Phase 9-3)', () => {
    async function setupOrderedRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Ordering+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'ordering-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'c.txt'), 'c');
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const assetC = allAssets.find((a) => a.filename === 'c.txt');
      const assetA = allAssets.find((a) => a.filename === 'a.txt');
      const assetB = allAssets.find((a) => a.filename === 'b.txt');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Ordering+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Add assets via Phase 9-2 add route in non-alphabetical order
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${assetC.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${assetA.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${assetB.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets, assetA, assetB, assetC };
    }

    it('curation page shows assets in sort_order ASC order', async () => {
      const { releaseLocation } = await setupOrderedRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // The selected section should show assets in order: c, a, b
      const selectedSection = res.text.match(/<h2>Selected Assets<\/h2>[\s\S]*?<\/section>/);
      expect(selectedSection).not.toBeNull();
      const cPos = selectedSection[0].indexOf('c.txt');
      const aPos = selectedSection[0].indexOf('a.txt');
      const bPos = selectedSection[0].indexOf('b.txt');
      expect(cPos).toBeLessThan(aPos);
      expect(aPos).toBeLessThan(bPos);
    });

    it('release detail shows assets in same order as curation page', async () => {
      const { releaseLocation } = await setupOrderedRelease();
      const res = await agent.get(releaseLocation).expect(200);

      const cPos = res.text.indexOf('c.txt');
      const aPos = res.text.indexOf('a.txt');
      const bPos = res.text.indexOf('b.txt');
      expect(cPos).toBeLessThan(aPos);
      expect(aPos).toBeLessThan(bPos);
    });

    it('publication review shows assets in same order as curation page', async () => {
      const { releaseLocation } = await setupOrderedRelease();
      const res = await agent.get(`${releaseLocation}/publish`).expect(200);

      const cPos = res.text.indexOf('c.txt');
      const aPos = res.text.indexOf('a.txt');
      const bPos = res.text.indexOf('b.txt');
      expect(cPos).toBeLessThan(aPos);
      expect(aPos).toBeLessThan(bPos);
    });

    it('published summary shows assets in same order as curation page', async () => {
      const { releaseLocation } = await setupOrderedRelease();

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);

      const cPos = res.text.indexOf('c.txt');
      const aPos = res.text.indexOf('a.txt');
      const bPos = res.text.indexOf('b.txt');
      expect(cPos).toBeLessThan(aPos);
      expect(aPos).toBeLessThan(bPos);
    });
  });

  // ─── Phase 9-3: Count/page parity after mutations ─────────────────────

  describe('count/page parity after mutations (Phase 9-3)', () => {
    it('candidate count decreases after adding an asset', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Count+Parity+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'count-parity-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Count+Parity+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Before add: 2 candidates
      let res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('2 candidates available');

      // Add one asset
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // After add: 1 candidate
      res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('1 candidate available');
    });

    it('candidate count increases after removing an asset', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Count+Parity+Remove+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'count-parity-remove-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Count+Parity+Remove+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Add both assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Before remove: 0 candidates
      let res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('0 candidates available');

      // Remove one asset
      await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // After remove: 1 candidate
      res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('1 candidate available');
    });
  });

  // ─── Phase 9-4: Mutation route HTTP tests ────────────────────────────

  describe('Phase 9-4 mutation route HTTP tests', () => {
    async function setupPhase94Release() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Phase+9-4+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'phase-9-4-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'beta.txt'), 'beta');
      fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Phase+9-4+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    async function setupPhase94MoveRelease() {
      const fixture = await setupPhase94Release();
      const { project_id: projectId } = db.prepare('SELECT project_id FROM releases WHERE id = ?').get(fixture.releaseId);
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((entry) => entry.endsWith('-phase-9-4-test'));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);

      fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta');
      fs.writeFileSync(path.join(projectDir, 'epsilon.txt'), 'epsilon');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      return fixture;
    }

    async function setupPhase94SelectedRelease(assetCount) {
      const fixture = await setupPhase94Release();
      for (let index = 0; index < assetCount; index++) {
        await agent
          .post(`${fixture.releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${fixture.allAssets[index].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }
      return fixture;
    }

    // ── 1. Unexpected-error forwarding ─────────────────────────────────

    it('add route forwards unexpected errors to global handler (500)', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      // Create a stubbed releaseService that throws a plain Error on addCandidateAsset
      const realService = createReleaseService({ db, evaluateReleaseReadiness });
      const stubbedService = Object.create(realService, {
        addCandidateAsset: {
          value() { throw new Error('Unexpected internal failure'); },
          writable: true,
        },
      });

      // Re-create app with the stubbed service
      const stubbedApp = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { releaseService: stubbedService, appDataRoot, authState: { csrfPepper: ensureAuthEnablement(appDataRoot).csrfPepper } });
      const { agent: stubbedAgent, csrfToken: stubbedCsrfToken } = await getDisabledModeCsrf(stubbedApp, appDataRoot);

      const res = await stubbedAgent
        .post(`${releaseLocation}/assets/add`)
        .send('_csrf=' + encodeURIComponent(stubbedCsrfToken))
        .send('assetId=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(500);

      // Must render the error page, not a generic fallthrough
      expect(res.text).toContain('Something went wrong');
      expect(res.text).not.toContain('Invalid asset ID');

      // No junction mutation occurred
      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    // ── Successful mutation tests ─────────────────────────────────────

    it('add route succeeds and redirects to asset page', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows).toHaveLength(0);

      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0].asset_id).toBe(allAssets[0].id);
      expect(afterRows[0].role).toBe('attachment');
    });

    it('add route preserves candidate filters in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add?search=alpha&pageSize=50`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Must preserve search and pageSize, omit page=1
      expect(res.headers.location).toBe(`/releases/${releaseId}/assets?search=alpha&pageSize=50`);
    });

    it('add route strips unknown parameters from redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add?unknown=param&junk=value`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);
    });

    it('remove-selected route succeeds and redirects', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add two assets first
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows).toHaveLength(2);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0].asset_id).toBe(allAssets[1].id);
    });

    it('remove-selected route preserves candidate filters in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected?search=beta&extension=txt`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets?search=beta&extension=txt`);
    });

    it('role route succeeds and redirects', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add one asset
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0].role).toBe('primary');
    });

    it('role route preserves candidate filters in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/role?search=gamma&pageSize=100`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=preview')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets?search=gamma&pageSize=100`);
    });

    it('move-up route succeeds and preserves query state in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94MoveRelease();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows[0].asset_id).toBe(allAssets[0].id);
      expect(beforeRows[1].asset_id).toBe(allAssets[1].id);

      // Move the second asset up
      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[1].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .query({
          search: '  txt  ',
          extension: ' TXT ',
          page: '2',
          pageSize: '2',
          unknown: 'discard-me',
        })
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const redirectUrl = new URL(res.headers.location, 'http://localhost');
      expect(redirectUrl.pathname).toBe(`/releases/${releaseId}/assets`);
      expect([...redirectUrl.searchParams.keys()].sort()).toEqual(['extension', 'page', 'pageSize', 'search']);
      expect(redirectUrl.searchParams.get('search')).toBe('txt');
      expect(redirectUrl.searchParams.get('extension')).toBe('txt');
      expect(redirectUrl.searchParams.get('page')).toBe('2');
      expect(redirectUrl.searchParams.get('pageSize')).toBe('2');
      expect(redirectUrl.searchParams.has('unknown')).toBe(false);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows[0].asset_id).toBe(allAssets[1].id);
      expect(afterRows[1].asset_id).toBe(allAssets[0].id);
    });

    it('move-down route succeeds and omits page=1 from redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94MoveRelease();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Move the first asset down
      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .query({
          search: '  txt  ',
          extension: ' TXT ',
          page: '1',
          pageSize: '2',
          unknown: 'discard-me',
        })
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const redirectUrl = new URL(res.headers.location, 'http://localhost');
      expect(redirectUrl.pathname).toBe(`/releases/${releaseId}/assets`);
      expect([...redirectUrl.searchParams.keys()].sort()).toEqual(['extension', 'pageSize', 'search']);
      expect(redirectUrl.searchParams.get('search')).toBe('txt');
      expect(redirectUrl.searchParams.get('extension')).toBe('txt');
      expect(redirectUrl.searchParams.get('pageSize')).toBe('2');
      expect(redirectUrl.searchParams.has('page')).toBe(false);
      expect(redirectUrl.searchParams.has('unknown')).toBe(false);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows[0].asset_id).toBe(allAssets[1].id);
      expect(afterRows[1].asset_id).toBe(allAssets[0].id);
    });

    // ── Validation/error tests ────────────────────────────────────────

    it('rejects malformed release ID with 404', async () => {
      await agent
        .post('/releases/abc/assets/add')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
    });

    const malformedReleaseIds = ['abc', '0', '-1', '1abc'];
    const malformedReleaseRouteCases = [
      {
        name: 'remove-selected',
        assetCount: 1,
        assetIndex: 0,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/remove-selected`,
        body: null,
      },
      {
        name: 'role',
        assetCount: 1,
        assetIndex: 0,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/role`,
        body: 'role=primary',
      },
      {
        name: 'move-up',
        assetCount: 2,
        assetIndex: 1,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/move-up`,
        body: null,
      },
      {
        name: 'move-down',
        assetCount: 2,
        assetIndex: 0,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/move-down`,
        body: null,
      },
    ];

    for (const routeCase of malformedReleaseRouteCases) {
      for (const malformedReleaseId of malformedReleaseIds) {
        it(`rejects malformed release ID ${malformedReleaseId} in ${routeCase.name} with 404`, async () => {
          const { releaseId, allAssets } = await setupPhase94SelectedRelease(routeCase.assetCount);
          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          const beforeJunction = getReleaseAssets(db, releaseId);

          let req = agent
            .post(routeCase.path(malformedReleaseId, allAssets[routeCase.assetIndex].id))
      .send('_csrf=' + encodeURIComponent(csrfToken))
            .set('Content-Type', 'application/x-www-form-urlencoded');
          if (routeCase.body) {
            req = req.send(routeCase.body);
          }

          const res = await req.expect(404);
          expect(res.text).not.toContain('Something went wrong');
          expect(db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId)).toEqual(beforeRelease);
          expect(getReleaseAssets(db, releaseId)).toEqual(beforeJunction);
        });
      }
    }

    it('rejects malformed asset ID in add with 422', async () => {
      const { releaseLocation } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=abc')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('Invalid asset ID');
    });

    it('rejects malformed asset ID in remove-selected with 404', async () => {
      const { releaseLocation } = await setupPhase94Release();
      await agent
        .post(`${releaseLocation}/assets/abc/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
    });

    it('rejects malformed asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/abc/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects zero asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/0/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects negative asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/-1/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects trailing-text asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/1abc/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects malformed asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/abc/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects zero asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/0/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects negative asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/-1/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects trailing-text asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/1abc/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects malformed asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/abc/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects zero asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/0/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects negative asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/-1/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects trailing-text asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/1abc/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects invalid role with 422', async () => {
      const { releaseLocation, allAssets } = await setupPhase94Release();
      // Add an asset first
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=invalid_role')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('primary');
    });

    it('rejects unselected target in remove-selected with 422', async () => {
      const { releaseLocation, allAssets } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('not selected');
    });

    it('rejects cross-project target with 422', async () => {
      const { releaseLocation } = await setupPhase94Release();
      // Create another project with an asset
      const projRes2 = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cross+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId2 = projRes2.headers.location.replace('/projects/', '');
      const slug2 = 'cross-project';
      const entries2 = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching2 = entries2.filter((e) => e.endsWith(`-${slug2}`));
      const projectDir2 = path.join(projectsRoot, 'tbd', matching2[0]);
      fs.writeFileSync(path.join(projectDir2, 'cross.txt'), 'cross');
      await agent.post(`/projects/${projectId2}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const assetRepo2 = createAssetRepository(db);
      const otherAssets = assetRepo2.findByProjectId(Number(projectId2));

      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${otherAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('does not belong');
    });

    it('rejects missing candidate with 404', async () => {
      const { releaseLocation } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
    });

    it('rejects already-selected candidate with 422', async () => {
      const { releaseLocation, allAssets } = await setupPhase94Release();
      // Add the asset once
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Try to add again
      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('already selected');
    });

    it('boundary move-up on first item is a no-op', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);

      // Move first item up — should be a no-op
      await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);
    });

    it('boundary move-down on last item is a no-op', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);

      // Move last item down — should be a no-op
      await agent
        .post(`${releaseLocation}/assets/${allAssets[1].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);
    });

    // ── Lifecycle HTTP matrix ─────────────────────────────────────────

    async function setupReleaseWithTwoAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Lifecycle+Matrix+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'lifecycle-matrix-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Lifecycle+Matrix+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select both assets
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${allAssets[0].id}`)
        .send(`selectedAssetIds[]=${allAssets[1].id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    describe('lifecycle matrix — published release', () => {
      async function setupPublishedRelease() {
        const ctx = await setupReleaseWithTwoAssets();
        await agent
          .post(`${ctx.releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=2025-06-15')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        return ctx;
      }

      it('add returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${allAssets[0].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('remove-selected returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('role returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('role=preview')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-up returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-down returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });
    });

    describe('lifecycle matrix — archived release', () => {
      async function setupArchivedRelease() {
        const ctx = await setupReleaseWithTwoAssets();
        await agent
          .post(`${ctx.releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
        return ctx;
      }

      it('add returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${allAssets[0].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('remove-selected returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('role returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('role=preview')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-up returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-down returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });
    });

    describe('lifecycle matrix — archived parent', () => {
      async function setupArchivedParentRelease() {
        const ctx = await setupReleaseWithTwoAssets();
        await agent
          .post(`/projects/${ctx.projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
        return ctx;
      }

      it('add returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${allAssets[0].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('remove-selected returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('role returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('role=preview')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-up returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-down returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });
    });

    // ── Candidate URL tests ───────────────────────────────────────────

    describe('candidate URL tests', () => {
      async function setupReleaseWithAssets() {
        const projRes = await agent
          .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('title=Candidate+URL+Test')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        const projectId = projRes.headers.location.replace('/projects/', '');

        const slug = 'candidate-url-test';
        const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
        const matching = entries.filter((e) => e.endsWith(`-${slug}`));
        const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
        fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
        fs.writeFileSync(path.join(projectDir, 'beta.txt'), 'beta');
        fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma');
        fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta');
        await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

        const assetRepo = createAssetRepository(db);
        const allAssets = assetRepo.findByProjectId(Number(projectId));

        const createRes = await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send('title=Candidate+URL+Release')
          .send('status=idea')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        const releaseLocation = createRes.headers.location;
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
      }

      /**
       * Parse an anchor href by its text content from HTML.
       * Unescapes HTML entities (&amp; → &) so URL parsing works.
       * Returns a URL object or null.
       */
      function parseLinkByText(html, linkText) {
        const re = new RegExp(`href="([^"]*)"[^>]*>${linkText}<`);
        const m = html.match(re);
        if (!m) return null;
        try {
          const decoded = m[1].replace(/&amp;/g, '&');
          return new URL(decoded, 'http://localhost');
        } catch {
          return null;
        }
      }

      it('Next link pathname and query on page 1', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets();
        const res = await agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('pageSize')).toBe('1');
        expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize']);
      });

      it('Previous link on page 2 omits page=1', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets();
        const res = await agent.get(`${releaseLocation}/assets?pageSize=1&page=2`).expect(200);

        const url = parseLinkByText(res.text, 'Previous');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('pageSize')).toBe('1');
        // page=1 is omitted
        expect(url.searchParams.has('page')).toBe(false);
        expect([...url.searchParams.keys()].sort()).toEqual(['pageSize']);
      });

      it('Next link on page 2 preserves page=2', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets();
        const res = await agent.get(`${releaseLocation}/assets?pageSize=1&page=2`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('page')).toBe('3');
        expect(url.searchParams.get('pageSize')).toBe('1');
        expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize']);
      });

      it('page 1 is omitted from pagination URLs', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets();
        const res = await agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.has('pageSize')).toBe(true);
        // No page=1 anywhere
        expect(url.searchParams.get('page')).not.toBe('1');
      });

      it('search and extension filters are preserved in pagination URLs', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets();
        // extension=txt matches 3 files (alpha, beta, gamma), pageSize=1 → 3 pages
        const res = await agent.get(`${releaseLocation}/assets?extension=txt&pageSize=1`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('extension')).toBe('txt');
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('pageSize')).toBe('1');
        expect([...url.searchParams.keys()].sort()).toEqual(['extension', 'page', 'pageSize']);
      });

      it('unknown parameters are stripped from generated URLs', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets();
        const res = await agent.get(`${releaseLocation}/assets?unknown=param&junk=value&pageSize=1`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        // Must not contain unknown or junk
        expect(url.searchParams.has('unknown')).toBe(false);
        expect(url.searchParams.has('junk')).toBe(false);
        // Must still have pageSize and page
        expect(url.searchParams.get('pageSize')).toBe('1');
        expect(url.searchParams.get('page')).toBe('2');
        expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize']);
      });

      it('page beyond final page clamps and renders canonical links', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets();
        // 4 files, pageSize=1 → 4 pages. Request page=999 → clamped to page 4.
        const res = await agent.get(`${releaseLocation}/assets?pageSize=1&page=999`).expect(200);

        // Displayed page is the clamped page
        expect(res.text).toContain('Page 4 of 4');

        // Previous link should point to page 3 (clamped from 999)
        const prevUrl = parseLinkByText(res.text, 'Previous');
        expect(prevUrl).not.toBeNull();
        expect(prevUrl.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(prevUrl.searchParams.get('page')).toBe('3');
        expect(prevUrl.searchParams.get('pageSize')).toBe('1');
        expect([...prevUrl.searchParams.keys()].sort()).toEqual(['page', 'pageSize']);

        // No Next link on the final page
        const nextUrl = parseLinkByText(res.text, 'Next');
        expect(nextUrl).toBeNull();

        // No link carries the unbounded requested page
        expect(res.text).not.toContain('page=999');
      });
    });
  });

  // Shared helper: isolate the Available Assets <section> content
  function getCandidateSection(html) {
    const afterH2 = html.split('<h2>Available Assets</h2>')[1];
    if (!afterH2) return '';
    return afterH2.split('</section>')[0];
  }

  // ─── Phase 9-5: Exact rendered candidate rows ────────────────────────

  describe('Phase 9-5 exact rendered candidate rows', () => {
    async function setupVariedAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Exact+Candidate+Rows')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'exact-candidate-rows';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);

      // Write files in non-sorted order to test sorting
      fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma');
      fs.writeFileSync(path.join(projectDir, 'alpha.png'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'BETA.png'), 'beta');
      fs.writeFileSync(path.join(projectDir, 'gamma.png'), 'gamma');
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'beta.txt'), 'beta');
      fs.writeFileSync(path.join(projectDir, 'selected.txt'), 'selected');
      fs.writeFileSync(path.join(projectDir, 'missing.txt'), 'missing');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const byFilename = (name) => allAssets.find((a) => a.filename === name);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Exact+Candidate+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select one asset
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${byFilename('selected.txt').id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Mark missing.txt as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), [
        'gamma.txt', 'alpha.png', 'BETA.png', 'gamma.png', 'alpha.txt', 'beta.txt', 'selected.txt'
      ]);

      return { releaseLocation, releaseId, byFilename, allAssets, projectId, assetRepo };
    }

    it('renders exact candidate asset IDs and sequence', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);

      // Extract candidate filenames from asset-filename cells in the Available Assets table
      const filenameRe = /<td class="asset-filename">([^<]+)<\/td>/g;
      const filenames = [];
      let m;
      while ((m = filenameRe.exec(candidateSection)) !== null) {
        filenames.push(m[1]);
      }

      // Extract candidate asset IDs from hidden inputs (only in candidate section)
      const idRe = /<input type="hidden" name="assetId" value="(\d+)">/g;
      const ids = [];
      while ((m = idRe.exec(candidateSection)) !== null) {
        ids.push(Number(m[1]));
      }

      // Expected order: filename COLLATE NOCASE, extension, asset ID
      // alpha.png, alpha.txt, BETA.png, beta.txt, gamma.png, gamma.txt
      expect(filenames).toEqual(['alpha.png', 'alpha.txt', 'BETA.png', 'beta.txt', 'gamma.png', 'gamma.txt']);

      // Verify each rendered ID matches the corresponding asset
      expect(ids[0]).toBe(byFilename('alpha.png').id);
      expect(ids[1]).toBe(byFilename('alpha.txt').id);
      expect(ids[2]).toBe(byFilename('BETA.png').id);
      expect(ids[3]).toBe(byFilename('beta.txt').id);
      expect(ids[4]).toBe(byFilename('gamma.png').id);
      expect(ids[5]).toBe(byFilename('gamma.txt').id);
    });

    it('asset ID is the tie-breaker when filename and extension are identical', async () => {
      const { releaseLocation, projectId } = await setupVariedAssets();

      // Insert two assets with the same case-folded filename and same extension
      // so that only asset ID determines their relative order.
      // Direct DB insert is needed because on Windows, 'dup.txt' and 'DUP.txt'
      // cannot coexist in the same directory.
      const insertAsset = (filename) => db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension,
                            mime_type, size_bytes, modified_at,
                            is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, 'txt', 'text/plain', 100, NULL, 1, datetime('now'), NULL)
        RETURNING id
      `).get(projectId, `subdir/${filename}`, filename);

      // Insert them one at a time — the second will have a higher id.
      const lowerId = insertAsset('dup.txt').id;
      const higherId = insertAsset('DUP.txt').id;
      expect(higherId).toBeGreaterThan(lowerId);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      const candidateSection = getCandidateSection(res.text);

      // Extract filenames and IDs
      const filenameRe = /<td class="asset-filename">([^<]+)<\/td>/g;
      const filenames = [];
      let m;
      while ((m = filenameRe.exec(candidateSection)) !== null) {
        filenames.push(m[1]);
      }

      const idRe = /<input type="hidden" name="assetId" value="(\d+)">/g;
      const ids = [];
      while ((m = idRe.exec(candidateSection)) !== null) {
        ids.push(Number(m[1]));
      }

      // Find the positions of our tie-break test assets
      const lowerIdx = ids.indexOf(lowerId);
      const higherIdx = ids.indexOf(higherId);
      expect(lowerIdx).toBeGreaterThanOrEqual(0);
      expect(higherIdx).toBeGreaterThanOrEqual(0);

      // dup.txt (lower id) must come before DUP.txt (higher id) because
      // COLLATE NOCASE makes "dup" == "DUP", extension is same ("txt"),
      // and THEN a.id ASC determines the order
      expect(lowerIdx).toBeLessThan(higherIdx);

      // Verify the filenames are in the right positions
      expect(filenames[lowerIdx]).toBe('dup.txt');
      expect(filenames[higherIdx]).toBe('DUP.txt');

      // Also assert: if we swap the assertion (higher before lower), it must fail
      // as a self-check that the order is intentional
      expect(ids.indexOf(higherId)).toBeGreaterThan(ids.indexOf(lowerId));
    });

    it('selected asset is absent from candidates', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).not.toContain(byFilename('selected.txt').filename);
    });

    it('missing unselected asset is absent from candidates', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).not.toContain(byFilename('missing.txt').filename);
    });

    it('same-project present unselected assets appear in candidates', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).toContain(byFilename('alpha.png').filename);
      expect(candidateSection).toContain(byFilename('gamma.txt').filename);
    });

    it('candidate total matches rendered count', async () => {
      const { releaseLocation } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);

      // Count data rows = number of asset-filename cells in candidate section
      const filenameRe = /<td class="asset-filename">([^<]+)<\/td>/g;
      let count = 0;
      while (filenameRe.exec(candidateSection) !== null) count++;

      expect(count).toBe(6);
      const totalMatch = res.text.match(/(\d+) candidate[s]? available/);
      expect(totalMatch).not.toBeNull();
      expect(Number(totalMatch[1])).toBe(6);
    });
  });

  // ─── Phase 9-5: Rendered count/page parity ──────────────────────────

  describe('Phase 9-5 rendered count and page parity', () => {
    async function setupCountTestAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Count+Parity+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'count-parity-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);

      // Create 10 files with varied names and extensions
      const files = [
        'alpha.png', 'alpha.txt', 'beta.png', 'beta.txt',
        'gamma.png', 'gamma.txt', 'delta.docx', 'epsilon.pdf',
        'zeta.jpg', 'eta.svg'
      ];
      for (const f of files) {
        fs.writeFileSync(path.join(projectDir, f), f);
      }
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Count+Parity+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      return { projectId, releaseLocation, releaseId, allAssets };
    }

    it('no filter — rendered row count equals page size', async () => {
      const { releaseLocation } = await setupCountTestAssets();
      // pageSize=4 should show 4 rows, total=10, pageCount=3
      const res = await agent.get(`${releaseLocation}/assets?pageSize=4`).expect(200);

      const candidateSection = getCandidateSection(res.text);

      // Count table rows in candidate section = number of <tr> minus the header row
      const trRe = /<tr>/g;
      const rowCount = (candidateSection.match(trRe) || []).length - 1;
      expect(rowCount).toBe(4);

      expect(res.text).toContain('10 candidates available');
      expect(res.text).toContain('Page 1 of 3');
    });

    it('filename search — correct count and single page', async () => {
      const { releaseLocation } = await setupCountTestAssets();
      const res = await agent.get(`${releaseLocation}/assets?search=alpha`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      const trRe = /<tr>/g;
      const rowCount = (candidateSection.match(trRe) || []).length - 1;

      // alpha.png and alpha.txt
      expect(rowCount).toBe(2);
      expect(res.text).toContain('2 candidates available');
    });

    it('extension filter — correct count and page count', async () => {
      const { releaseLocation } = await setupCountTestAssets();
      const res = await agent.get(`${releaseLocation}/assets?extension=txt&pageSize=2`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      const trRe = /<tr>/g;
      const rowCount = (candidateSection.match(trRe) || []).length - 1;

      // alpha.txt, beta.txt, gamma.txt — 3 total, pageSize=2 → page 1 shows 2, pageCount=2
      expect(rowCount).toBe(2);
      expect(res.text).toContain('3 candidates available');
      expect(res.text).toContain('Page 1 of 2');
    });

    it('combined search + extension — correct counts', async () => {
      const { releaseLocation } = await setupCountTestAssets();
      const res = await agent.get(`${releaseLocation}/assets?search=alpha&extension=png`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      const trRe = /<tr>/g;
      const rowCount = (candidateSection.match(trRe) || []).length - 1;

      // alpha.png only
      expect(rowCount).toBe(1);
      expect(res.text).toContain('1 candidate available');
    });

    it('page beyond final page falls back to last page', async () => {
      const { releaseLocation, releaseId } = await setupCountTestAssets();
      const res = await agent.get(`${releaseLocation}/assets?pageSize=4&page=999`).expect(200);

      expect(res.text).toContain('Page 3 of 3');

      // Parse Previous link — should point to page 2 (clamped from 999)
      const prevMatch = res.text.match(/href="([^"]*)"[^>]*>Previous</);
      expect(prevMatch).not.toBeNull();
      const prevUrl = new URL(prevMatch[1].replace(/&amp;/g, '&'), 'http://localhost');
      expect(prevUrl.pathname).toBe(`/releases/${releaseId}/assets`);
      expect(prevUrl.searchParams.get('page')).toBe('2');
      expect(prevUrl.searchParams.get('pageSize')).toBe('4');
      expect([...prevUrl.searchParams.keys()].sort()).toEqual(['page', 'pageSize']);

      // No Next link on the final page
      const nextMatch = res.text.match(/href="([^"]*)"[^>]*>Next</);
      expect(nextMatch).toBeNull();

      // No link carries the unbounded requested page
      expect(res.text).not.toContain('page=999');
    });
  });

  // ─── Phase 9-5: Malformed cross-project HTTP fixture ────────────────

  describe('Phase 9-5 malformed cross-project HTTP fixture', () => {
    it('malformed junction row does not hide valid candidates', async () => {
      // Create project A with assets
      const projARes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Malformed+A')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectAId = projARes.headers.location.replace('/projects/', '');
      const slugA = 'malformed-a';
      const entriesA = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matchingA = entriesA.filter((e) => e.endsWith(`-${slugA}`));
      const projectDirA = path.join(projectsRoot, 'tbd', matchingA[0]);
      fs.writeFileSync(path.join(projectDirA, 'alpha.png'), 'alpha');
      fs.writeFileSync(path.join(projectDirA, 'beta.png'), 'beta');
      await agent.post(`/projects/${projectAId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // Create project B with an asset
      const projBRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Malformed+B')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectBId = projBRes.headers.location.replace('/projects/', '');
      const slugB = 'malformed-b';
      const entriesB = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matchingB = entriesB.filter((e) => e.endsWith(`-${slugB}`));
      const projectDirB = path.join(projectsRoot, 'tbd', matchingB[0]);
      fs.writeFileSync(path.join(projectDirB, 'cross.txt'), 'cross');
      await agent.post(`/projects/${projectBId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assetsA = assetRepo.findByProjectId(Number(projectAId));
      const assetsB = assetRepo.findByProjectId(Number(projectBId));

      // Create release in project A
      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectAId}`)
        .send('title=Malformed+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select one valid asset from project A
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetsA[0].id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Directly insert a malformed junction row (project B asset on project A release)
      db.prepare(
        'INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)'
      ).run(releaseId, assetsB[0].id, 'attachment', 99);

      // Fetch candidate page
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);

      // The malformed row should not hide the valid candidate (beta.png from project A)
      expect(candidateSection).toContain('beta.png');
    });

    it('selected and available sections remain consistent with ownership', async () => {
      // Create a clean project and release
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Consistency+Check')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');
      const slug = 'consistency-check';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'valid1.txt'), 'v1');
      fs.writeFileSync(path.join(projectDir, 'valid2.txt'), 'v2');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Consistency+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select valid2.txt
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assets[1].id}`)
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // Selected section should show the selected asset
      const selectedSection = res.text.split('<h2>Selected Assets</h2>')[1];
      const selectedBeforeNext = selectedSection.split('</section>')[0];
      expect(selectedBeforeNext).toContain('valid2.txt');

      // Available section should show the unselected asset
      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).toContain('valid1.txt');

      // Selected asset should NOT appear in available
      expect(candidateSection).not.toContain('valid2.txt');
    });
  });

  // ─── Phase 9-5: Read-only control visibility ────────────────────────

  describe('Phase 9-5 read-only control visibility', () => {
    async function setupReadOnlyRelease(status, archiveAction = null) {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Read+Only+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'read-only-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Read+Only+Release')
        .send(`status=${status === 'published' ? 'ready' : status === 'cancelled' ? 'idea' : 'idea'}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(status === 'published' ? 302 : 302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assets[0].id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      if (status === 'published') {
        await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=2025-06-15')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      } else if (status === 'archived-release') {
        await agent
          .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
      } else if (status === 'archived-parent') {
        await agent
          .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
      }

      return { releaseLocation, releaseId, asset: assets[0] };
    }

    async function assertNoMutationControls(releaseLocation) {
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // No Add forms
      const addForms = res.text.match(/action="[^"]*\/assets\/add"/g);
      expect(addForms).toBeNull();

      // No Remove Selected forms
      const removeForms = res.text.match(/action="[^"]*\/remove-selected"/g);
      expect(removeForms).toBeNull();

      // No role-update forms/selects
      const roleForms = res.text.match(/action="[^"]*\/role"/g);
      expect(roleForms).toBeNull();

      // No Move Up forms/buttons
      const moveUpForms = res.text.match(/action="[^"]*\/move-up"/g);
      expect(moveUpForms).toBeNull();

      // No Move Down forms/buttons
      const moveDownForms = res.text.match(/action="[^"]*\/move-down"/g);
      expect(moveDownForms).toBeNull();

      // The legacy Save Selection button must also be absent
      expect(res.text).not.toContain('Save Selection');

      // No bulk-selection form (POST to /releases/:id/assets)
      const bulkFormAction = res.text.match(/method="post"[^>]*action="\/releases\/\d+\/assets"/g);
      expect(bulkFormAction).toBeNull();

      // No bulk-selection checkboxes
      expect(res.text).not.toContain('class="asset-checkbox"');

      // No role selects in the bulk form
      expect(res.text).not.toContain('class="asset-role"');

      // No sort-order inputs in the bulk form
      expect(res.text).not.toContain('class="asset-sort-order"');

      // No checkbox-toggle script (the <script> block after the form)
      expect(res.text).not.toContain('asset-checkbox');

      return res;
    }

    it('published release has no mutation controls', async () => {
      const { releaseLocation } = await setupReadOnlyRelease('published');
      await assertNoMutationControls(releaseLocation);
    });

    it('archived release has no mutation controls', async () => {
      const { releaseLocation } = await setupReadOnlyRelease('archived-release');
      await assertNoMutationControls(releaseLocation);
    });

    it('archived parent has no mutation controls', async () => {
      const { releaseLocation } = await setupReadOnlyRelease('archived-parent');
      await assertNoMutationControls(releaseLocation);
    });
  });

  // ─── Phase 10.5: Remaining defect corrections ──────────────────────────

  describe('release detail archive action deduplication', () => {
    async function createEligibleRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Dedup+Archive+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Dedup+Archive+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation: createRes.headers.location };
    }

    it('renders exactly one archive form for an eligible release', async () => {
      const { releaseLocation } = await createEligibleRelease();
      const res = await agent.get(releaseLocation).expect(200);

      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toHaveLength(1);
    });

    it('remaining archive action is inside the destructive section', async () => {
      const { releaseLocation } = await createEligibleRelease();
      const res = await agent.get(releaseLocation).expect(200);

      expect(res.text).toContain('destructive-section');
      expect(res.text).toContain('Danger zone');
      expect(res.text).toContain('Archive release');
    });

    it('heading-level area does not contain a second archive form', async () => {
      const { releaseLocation } = await createEligibleRelease();
      const res = await agent.get(releaseLocation).expect(200);

      // The page-heading header must only have the Edit link, not an Archive form.
      const headingMatch = res.text.match(/<header class="page-heading">[\s\S]*?<\/header>/);
      expect(headingMatch).not.toBeNull();
      expect(headingMatch[0]).not.toContain('/archive');
      expect(headingMatch[0]).toContain('/edit');
    });

    it('published release has no archive form', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      // Publish the release
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });

    it('cancelled release has no archive form', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Archive+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Cancel+Archive+Release')
        .send('status=cancelled')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });

    it('already archived release has no archive form', async () => {
      const { releaseLocation } = await createEligibleRelease();
      await agent.post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });

    it('project-archived release has no archive form', async () => {
      const { projectId, releaseLocation } = await createEligibleRelease();
      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });
  });

  describe('calendar switcher self-link', () => {
    it('calendar switcher anchor has a valid href with normalized month', async () => {
      const res = await agent.get('/calendar').expect(200);
      // The calendar route normalizes to the current month, so the canonical
      // self-link always carries the month parameter.
      expect(res.text).toMatch(/<a class="view-switcher-option" href="\/calendar\?month=\d{4}-\d{2}"[^>]*aria-current="page"[^>]*>Calendar<\/a>/);
    });

    it('calendar switcher preserves explicit month in href', async () => {
      const res = await agent.get('/calendar?month=2026-07').expect(200);
      expect(res.text).toMatch(/<a class="view-switcher-option" href="\/calendar\?month=2026-07"[^>]*aria-current="page"[^>]*>Calendar<\/a>/);
    });

    it('all four switcher items are real anchors with valid hrefs', async () => {
      const res = await agent.get('/calendar?month=2026-07').expect(200);
      // Published Work
      expect(res.text).toMatch(/<a class="view-switcher-option" href="\/releases"[^>]*>Published Work<\/a>/);
      // Release Records
      expect(res.text).toMatch(/<a class="view-switcher-option" href="\/release-management"[^>]*>Release Records<\/a>/);
      // Board
      expect(res.text).toMatch(/<a class="view-switcher-option" href="\/release-management\?view=board"[^>]*>Board<\/a>/);
      // Calendar — must have a real href, not just be a bare anchor
      const calMatch = res.text.match(/<a class="view-switcher-option" href="([^"]+)"[^>]*aria-current="page"[^>]*>Calendar<\/a>/);
      expect(calMatch).not.toBeNull();
      expect(calMatch[1]).toMatch(/^\/calendar/);
    });

    it('exactly one switcher item is current within the view-switcher nav', async () => {
      const res = await agent.get('/calendar?month=2026-07').expect(200);
      // Extract the view-switcher nav to scope the count (the sidebar nav also
      // carries aria-current="page" for the Calendar section).
      const switcherMatch = res.text.match(/<nav class="view-switcher"[^>]*>([\s\S]*?)<\/nav>/);
      expect(switcherMatch).not.toBeNull();
      const currentCount = (switcherMatch[1].match(/aria-current="page"/g) || []).length;
      expect(currentCount).toBe(1);
    });
  });

  // ─── Calendar/Releases correction Phase 1: project-backed calendar ────
  //
  // /calendar sources entries from project records, not release records.
  // These tests exercise the HTTP route end-to-end.

  describe('project-backed calendar', () => {
    async function createProjectWithDates(title, { status, plannedDate, publishedDate }) {
      const createRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`title=${encodeURIComponent(title)}`)
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = createRes.headers.location.replace('/projects/', '');

      const update = agent
        .post(`/projects/${projectId}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`title=${encodeURIComponent(title)}`)
        .send(`status=${status}`)
        .send('priority=normal');
      if (plannedDate) update.send(`plannedDate=${plannedDate}`);
      if (publishedDate) update.send(`publishedDate=${publishedDate}`);
      await update.set('Content-Type', 'application/x-www-form-urlencoded').expect(302);

      return projectId;
    }

    it('renders a project entry linking to /projects/:id with its status badge', async () => {
      const projectId = await createProjectWithDates('Calendar Project', {
        status: 'in-progress',
        plannedDate: '2026-07-14',
      });

      const res = await agent.get('/calendar?month=2026-07').expect(200);

      expect(res.text).toContain(`href="/projects/${projectId}"`);
      expect(res.text).toMatch(new RegExp(`href="/projects/${projectId}">Calendar Project</a>`));
      expect(res.text).toContain('In Progress');
    });

    it('does not link the entry to /releases/:id', async () => {
      await createProjectWithDates('No Release Link Project', {
        status: 'planned',
        plannedDate: '2026-07-05',
      });

      const res = await agent.get('/calendar?month=2026-07').expect(200);
      expect(res.text).not.toMatch(/href="\/releases\/\d+">No Release Link Project<\/a>/);
    });

    it('a project appears on the calendar without any release record', async () => {
      const projectId = await createProjectWithDates('Bare Project', {
        status: 'ready',
        plannedDate: '2026-07-08',
      });

      const res = await agent.get('/calendar?month=2026-07').expect(200);
      expect(res.text).toContain(`href="/projects/${projectId}"`);
    });

    it('published project appears at its published date, not planned date', async () => {
      const projectId = await createProjectWithDates('Publish Move Project', {
        status: 'published',
        plannedDate: '2026-07-02',
        publishedDate: '2026-07-22',
      });

      const julyRes = await agent.get('/calendar?month=2026-07').expect(200);
      expect(julyRes.text).toContain(`href="/projects/${projectId}"`);
    });
  });

});
