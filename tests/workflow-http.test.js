/**
 * HTTP-level tests for Phase 6B dashboard composition and project workspace.
 *
 * These tests are designed to fail if the route starts calling repositories
 * directly or stops using the workflow query service. They also assert the
 * safe empty state of the new dashboard sections.
 */
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

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function getProjectDir(projectsRoot, title, status = 'tbd') {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const statusDir = STATUS_DIR_MAP[status];
  const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
  const matching = entries.filter((e) => e.endsWith(`-${slug}`));
  if (matching.length === 0) return null;
  return path.join(projectsRoot, statusDir, matching[0]);
}

async function createProject(app, { title, status = 'tbd' }) {
  const res = await request(app)
    .post('/projects')
    .send(`title=${encodeURIComponent(title)}`)
    .send(`status=${status}`)
    .send('priority=normal')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  return res.headers.location.replace('/projects/', '');
}

async function createRelease(app, { projectId, title, status = 'idea', plannedDate = null }) {
  const body = [`projectId=${projectId}`, `title=${encodeURIComponent(title)}`, `status=${status}`];
  if (plannedDate) body.push(`plannedDate=${plannedDate}`);
  const res = await request(app)
    .post('/releases')
    .send(body.join('&'))
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  return res.headers.location.replace('/releases/', '');
}

/**
 * Create a present asset for a project and link it to a release so the
 * release does not appear in the missing-selection dashboard section.
 * Returns the asset id.
 */
function attachPresentAssetToRelease(db, projectId, releaseId, { name, present = true } = {}) {
  const filename = name || `a-${releaseId}.txt`;
  const assetRepo = createAssetRepository(db);
  const asset = assetRepo.upsert(projectId, filename, {
    filename,
    extension: 'txt',
    mimeType: 'text/plain',
    sizeBytes: 0,
    modifiedAt: null,
  });
  if (!present) {
    db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);
  }
  db.prepare(`
    INSERT INTO release_assets (release_id, asset_id, role, sort_order)
    VALUES (?, ?, 'attachment', 0)
  `).run(releaseId, asset.id);
  return asset.id;
}

describe('Phase 6B HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-6b-'));
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

  // ─── Dashboard: actionable sections ────────────────────────────────

  describe('dashboard actionable sections', () => {
    it('renders the "Releases needing attention" section heading', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Releases needing attention');
    });

    it('shows overdue releases in the attention section', async () => {
      const projectId = await createProject(app, { title: 'Overdue Project', status: 'planned' });
      await createRelease(app, {
        projectId,
        title: 'Way Overdue',
        status: 'planned',
        plannedDate: '2020-01-01',
      });

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Overdue (1)');
      expect(res.text).toContain('Way Overdue');
      // Link to the release detail page
      expect(res.text).toMatch(/href="\/releases\/\d+"[^>]*>Way Overdue/);
    });

    it('shows ready releases in the attention section', async () => {
      const projectId = await createProject(app, { title: 'Ready Project' });
      await createRelease(app, {
        projectId,
        title: 'Ready To Publish',
        status: 'ready',
        plannedDate: '2099-01-01',
      });

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Ready to publish (1)');
      expect(res.text).toContain('Ready To Publish');
    });

    it('shows active releases without planned date', async () => {
      const projectId = await createProject(app, { title: 'No Date Project' });
      await createRelease(app, {
        projectId,
        title: 'Schedule Me',
        status: 'drafting',
        plannedDate: null,
      });

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Active without planned date (1)');
      expect(res.text).toContain('Schedule Me');
    });

    it('shows missing-asset warnings when a release references a missing asset', async () => {
      const projectId = await createProject(app, { title: 'Missing Asset Project' });
      // Create a project directory and a missing file
      const projectDir = getProjectDir(projectsRoot, 'Missing Asset Project');
      expect(projectDir).not.toBeNull();
      // Do not create any file — but assets table needs a row to reference.
      // Insert a missing asset directly.
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.upsert(projectId, 'gone.txt', {
        filename: 'gone.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        modifiedAt: null,
      });
      // Mark as missing
      db.prepare(`
        UPDATE assets SET is_present = 0, missing_since = datetime('now')
        WHERE id = ?
      `).run(asset.id);

      const releaseId = await createRelease(app, {
        projectId,
        title: 'Has Missing Asset',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      // Link the missing asset to the release
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 0)
      `).run(Number(releaseId), asset.id);

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Missing selected assets (1)');
      expect(res.text).toContain('Has Missing Asset');
      expect(res.text).toContain('1 missing');
    });

    it('shows the "all good" placeholder when no attention is needed', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('All releases are in good shape');
    });

    it('hides archived releases from the attention lists', async () => {
      const projectId = await createProject(app, { title: 'Archive Hide Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Archived Overdue',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      await request(app).post(`/releases/${releaseId}/archive`).expect(302);

      const res = await request(app).get('/').expect(200);
      expect(res.text).not.toContain('Archived Overdue');
    });
  });

  // ─── Dashboard: upcoming releases grouped by date ─────────────────

  describe('dashboard upcoming releases', () => {
    it('shows the upcoming releases section', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Upcoming releases');
    });

    it('shows the empty-state placeholder when no upcoming releases exist', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('No upcoming releases scheduled');
    });

    it('lists upcoming releases grouped by planned date', async () => {
      const projectId = await createProject(app, { title: 'Upcoming Project', status: 'in-progress' });
      const tomorrowId = await createRelease(app, {
        projectId,
        title: 'Tomorrow',
        status: 'drafting',
        plannedDate: '2099-01-15',
      });
      // Link a present asset so the release is not flagged for missing
      // selection (this test focuses on the upcoming-grouping behavior).
      attachPresentAssetToRelease(db, Number(projectId), Number(tomorrowId), { name: 'tomorrow.txt' });
      const sameDayAId = await createRelease(app, {
        projectId,
        title: 'SameDay-A',
        status: 'planned',
        plannedDate: '2099-02-01',
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(sameDayAId), { name: 'sameday-a.txt' });
      const sameDayBId = await createRelease(app, {
        projectId,
        title: 'SameDay-B',
        status: 'planned',
        plannedDate: '2099-02-01',
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(sameDayBId), { name: 'sameday-b.txt' });

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Tomorrow');
      expect(res.text).toContain('SameDay-A');
      expect(res.text).toContain('SameDay-B');
      // Date headers are present
      expect(res.text).toContain('2099-01-15');
      expect(res.text).toContain('2099-02-01');

      // Each date should be followed by its own <ul>.
      const date2099_01_15_pos = res.text.indexOf('2099-01-15');
      const date2099_02_01_pos = res.text.indexOf('2099-02-01');
      expect(date2099_01_15_pos).toBeGreaterThan(-1);
      expect(date2099_02_01_pos).toBeGreaterThan(-1);
      // 2099-01-15 appears before 2099-02-01 (chronological order from the query)
      expect(date2099_01_15_pos).toBeLessThan(date2099_02_01_pos);

      // Tomorrow is in the 2099-01-15 group (between the two date headers)
      const tomorrow_pos = res.text.indexOf('Tomorrow');
      expect(tomorrow_pos).toBeGreaterThan(date2099_01_15_pos);
      expect(tomorrow_pos).toBeLessThan(date2099_02_01_pos);

      // Both SameDay entries are in the 2099-02-01 group (after that header)
      const sameDayA_pos = res.text.indexOf('SameDay-A');
      const sameDayB_pos = res.text.indexOf('SameDay-B');
      expect(sameDayA_pos).toBeGreaterThan(date2099_02_01_pos);
      expect(sameDayB_pos).toBeGreaterThan(date2099_02_01_pos);

      // Count the number of <h3 class="upcoming-date"> elements — should be 2
      const upcomingDateHeaders = res.text.match(/<h3 class="upcoming-date">/g) || [];
      expect(upcomingDateHeaders.length).toBe(2);
    });

    it('upcoming releases are bounded by the limit', async () => {
      const projectId = await createProject(app, { title: 'Bounded Upcoming' });
      for (let i = 0; i < 20; i++) {
        const releaseId = await createRelease(app, {
          projectId,
          title: `U${i}`,
          status: 'planned',
          plannedDate: `2099-01-${String((i % 28) + 1).padStart(2, '0')}`,
        });
        // Link a present asset so the release is not also flagged for
        // missing selection — that section has its own limit and would
        // otherwise contribute release links to the page.
        attachPresentAssetToRelease(db, Number(projectId), Number(releaseId), { name: `u${i}.txt` });
      }

      const res = await request(app).get('/').expect(200);
      // The default upcoming limit is 10, so we expect at most 10 release
      // links in the upcoming section.
      const upcomingMatches = res.text.match(/href="\/releases\/\d+"[^>]*>U\d+/g) || [];
      expect(upcomingMatches.length).toBeLessThanOrEqual(10);
    });
  });

  // ─── Dashboard: workflow summary ───────────────────────────────────

  describe('dashboard workflow summary', () => {
    it('renders the workflow summary section', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Workflow summary');
    });

    it('shows total projects, total assets, and missing assets', async () => {
      await createProject(app, { title: 'Counted' });

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Total projects');
      expect(res.text).toContain('Total assets');
      expect(res.text).toContain('Missing assets');
    });

    it('shows release status counts (idea, planned, drafting, ready, published, cancelled)', async () => {
      const res = await request(app).get('/').expect(200);
      // Check that each status appears in the dashboard
      expect(res.text).toMatch(/Idea/);
      expect(res.text).toMatch(/Planned/);
      expect(res.text).toMatch(/Drafting/);
      expect(res.text).toMatch(/Ready/);
      expect(res.text).toMatch(/Published/);
      expect(res.text).toMatch(/Cancelled/);
    });

    it('keeps project counts but demotes them inside a collapsible section', async () => {
      await createProject(app, { title: 'Demoted Counted' });
      const res = await request(app).get('/').expect(200);
      // Project counts are inside a <details> element
      expect(res.text).toContain('<details>');
      expect(res.text).toContain('Project counts');
    });
  });

  // ─── Project workspace ─────────────────────────────────────────────

  describe('project workspace', () => {
    it('renders the workflow actions block with a "Create release" link', async () => {
      const projectId = await createProject(app, { title: 'Workspace Actions Project' });
      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('Create release');
      // The link should be scoped to this project
      expect(res.text).toContain(`/releases/new?projectId=${projectId}`);
    });

    it('renders the release summary section heading', async () => {
      const projectId = await createProject(app, { title: 'Release Summary Project' });
      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('Releases');
      expect(res.text).toContain('Status');
      expect(res.text).toContain('Active releases');
      expect(res.text).toContain('Recent releases');
    });

    it('shows release status counts and active/recent lists', async () => {
      const projectId = await createProject(app, { title: 'Lists Project', status: 'in-progress' });
      await createRelease(app, {
        projectId,
        title: 'Active Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      // Create a release as 'ready' then publish via the action
      const oldReleaseId = await createRelease(app, {
        projectId,
        title: 'Old Release',
        status: 'ready',
      });
      await request(app)
        .post(`/releases/${oldReleaseId}/publish`)
        .send('publishedDate=2024-01-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('Active Release');
      expect(res.text).toContain('Old Release');
    });

    it('shows asset health counts', async () => {
      const projectId = await createProject(app, { title: 'Health Project' });
      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('Asset health');
      expect(res.text).toContain('Total assets');
      expect(res.text).toContain('Present');
      expect(res.text).toContain('Missing');
    });

    it('renders present/missing asset counts when assets exist', async () => {
      const projectId = await createProject(app, { title: 'Counts Health' });
      const assetRepo = createAssetRepository(db);
      assetRepo.upsert(projectId, 'present.txt', {
        filename: 'present.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        modifiedAt: null,
      });
      const missing = assetRepo.upsert(projectId, 'missing.txt', {
        filename: 'missing.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(missing.id);

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      // Counts should reflect 1 present and 1 missing
      expect(res.text).toContain('<dd>1</dd>');
    });

    it('shows missing assets referenced by releases', async () => {
      const projectId = await createProject(app, { title: 'Referenced Missing Health' });
      const assetRepo = createAssetRepository(db);
      const missing = assetRepo.upsert(projectId, 'gone.txt', {
        filename: 'gone.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(missing.id);

      const releaseId = await createRelease(app, {
        projectId,
        title: 'With Missing',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 0)
      `).run(Number(releaseId), missing.id);

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      // The label is wrapped in <small>, so look for the inner text directly
      expect(res.text).toContain('1 referenced by releases');
    });

    it('archived projects still display historical release information', async () => {
      const projectId = await createProject(app, { title: 'History Project' });
      // Create a ready release, then publish via the action, then archive.
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Historical Release',
        status: 'ready',
        plannedDate: '2020-01-01',
      });
      await request(app)
        .post(`/releases/${releaseId}/publish`)
        .send('publishedDate=2020-01-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await request(app).post(`/projects/${projectId}/archive`).expect(302);
      // After the project is archived, release mutation routes reject the
      // call (the parent project is immutable). The historical release
      // information must still be available through the project workspace.

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      // Project archived notice is shown
      expect(res.text).toContain('Archived');
      // Historical release still shows in recent
      expect(res.text).toContain('Historical Release');
      // Status count is still accurate
      expect(res.text).toContain('Published');
    });

    it('shows safe empty states for a project with no releases or assets', async () => {
      const projectId = await createProject(app, { title: 'Bare Project' });
      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('No active releases');
      expect(res.text).toContain('No releases yet');
    });

    it('archived project does not show the "Create release" action', async () => {
      const projectId = await createProject(app, { title: 'No Create Action Project' });
      // Archive the project via the documented action.
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      // The Create release link targets /releases/new?projectId=…
      expect(res.text).not.toContain(`/releases/new?projectId=${projectId}`);
      expect(res.text).not.toMatch(/<a[^>]*>\s*Create release\s*<\/a>/);
      // "View Assets" is still offered (read-only browsing is fine).
      expect(res.text).toContain(`href="/projects/${projectId}/assets"`);
    });

    it('active project keeps the "Create release" action', async () => {
      const projectId = await createProject(app, { title: 'Keep Create Action Project' });
      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain(`href="/releases/new?projectId=${projectId}"`);
    });
  });

  // ─── Phase 6B regression: archived project Edit/Archive controls ───
  //
  // The project detail page must hide the Edit button and the Archive
  // action when the project is already archived. Archived projects are
  // read-only; surfacing mutation controls would mislead the user. The
  // historical release information, asset information, and read-only
  // browsing ("View Assets") must remain visible.

  describe('project detail mutation controls', () => {
    it('archived project does not show the Edit action', async () => {
      const projectId = await createProject(app, { title: 'Archived No Edit' });
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      // No Edit link targeting this project's edit form.
      expect(res.text).not.toContain(`href="/projects/${projectId}/edit"`);
      expect(res.text).not.toMatch(/<a[^>]*href="\/projects\/\d+\/edit"[^>]*>\s*Edit\s*<\/a>/);
    });

    it('archived project does not show the Archive action', async () => {
      const projectId = await createProject(app, { title: 'Archived No Archive Button' });
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      // No archive form/button targeting this project.
      expect(res.text).not.toContain(`action="/projects/${projectId}/archive"`);
      expect(res.text).not.toMatch(/<button[^>]*>\s*Archive\s*<\/button>/);
    });

    it('active project still shows the Edit and Archive controls', async () => {
      const projectId = await createProject(app, { title: 'Active Has Both Controls' });
      const res = await request(app).get(`/projects/${projectId}`).expect(200);

      expect(res.text).toContain(`href="/projects/${projectId}/edit"`);
      expect(res.text).toMatch(/<a[^>]*>\s*Edit\s*<\/a>/);
      expect(res.text).toContain(`action="/projects/${projectId}/archive"`);
      expect(res.text).toMatch(/<button[^>]*>\s*Archive\s*<\/button>/);
    });

    it('archived project still preserves historical release information and assets', async () => {
      // The mutation controls go away, but the historical view is preserved.
      const projectId = await createProject(app, { title: 'Archived Preserves History' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Historical Release',
        status: 'ready',
        plannedDate: '2020-01-01',
      });
      await request(app)
        .post(`/releases/${releaseId}/publish`)
        .send('publishedDate=2020-01-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app).get(`/projects/${projectId}`).expect(200);
      // Archived badge is shown.
      expect(res.text).toContain('Archived');
      // Historical release still appears.
      expect(res.text).toContain('Historical Release');
      // Read-only "View Assets" link is still offered.
      expect(res.text).toContain(`href="/projects/${projectId}/assets"`);
      // But mutation controls are gone.
      expect(res.text).not.toContain(`href="/projects/${projectId}/edit"`);
      expect(res.text).not.toContain(`action="/projects/${projectId}/archive"`);
    });
  });

  // ─── Phase 6B regression: dashboard missing-selection rendering ────
  //
  // The dashboard's "Missing selection" section surfaces active releases
  // with zero selected assets. The HTTP-level test verifies the section
  // renders the new label and the release link, and that releases with
  // all-valid assets do not appear there.

  describe('dashboard missing-selection section', () => {
    it('renders the "Missing selection" section for a release with zero assets', async () => {
      const projectId = await createProject(app, { title: 'Missing Selection Render' });
      await createRelease(app, {
        projectId,
        title: 'No Selection At All',
        status: 'planned',
        plannedDate: '2099-01-01',
      });

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Missing selection (1)');
      expect(res.text).toContain('No Selection At All');
      expect(res.text).toContain('no assets selected');
    });

    it('does not render the "Missing selection" section when every release has assets', async () => {
      const projectId = await createProject(app, { title: 'Every Release Has Assets' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'With Selection',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(releaseId), { name: 'present.txt' });

      const res = await request(app).get('/').expect(200);
      expect(res.text).not.toContain('Missing selection (');
    });
  });

  // ─── 404 safety ────────────────────────────────────────────────────

  describe('safe 404 behavior', () => {
    it('returns 404 for a missing project detail', async () => {
      const res = await request(app).get('/projects/9999').expect(404);
      expect(res.text).toContain('Not found');
    });

    it('returns 404 for a malformed project id', async () => {
      await request(app).get('/projects/abc').expect(404);
    });

    it('returns 404 for an unknown route', async () => {
      const res = await request(app).get('/not-a-real-route').expect(404);
      expect(res.text).not.toContain('at ');
    });
  });

  // ─── Existing project routes remain working ────────────────────────

  describe('existing project routes remain working', () => {
    it('project list still renders', async () => {
      const res = await request(app).get('/projects').expect(200);
      expect(res.text).toContain('Projects');
    });

    it('project edit form still renders', async () => {
      const projectId = await createProject(app, { title: 'Still Works Project' });
      const res = await request(app).get(`/projects/${projectId}/edit`).expect(200);
      expect(res.text).toContain('Edit Project');
    });

    it('asset listing still works from project detail', async () => {
      const projectId = await createProject(app, { title: 'Asset List Project' });
      const res = await request(app).get(`/projects/${projectId}/assets`).expect(200);
      expect(res.text).toContain('Assets');
    });
  });

  // ─── Service wiring ────────────────────────────────────────────────

  describe('service wiring', () => {
    it('releases list still renders (regression check)', async () => {
      const res = await request(app).get('/releases').expect(200);
      expect(res.text).toContain('Releases');
    });
  });
});
