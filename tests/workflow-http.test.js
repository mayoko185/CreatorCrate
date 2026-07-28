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
import { getLocalTodayIso } from '../src/util/date.js';

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

/**
 * Extract the href of the pagination anchor whose visible text matches
 * the supplied label (e.g. "Next" or "Previous"). Returns null when no
 * pagination anchor with that label is in the page. The regex is
 * intentionally narrow — it must match an <a> element inside the
 * `.pagination` nav, not any random link that happens to contain the
 * word "Next" or "Previous".
 */
function extractPaginationHref(html, label) {
  // The pagination nav is <nav class="pagination" …> <a class="button" href="…">Next</a> </nav>
  // Some templates include an arrow character (→) after the label text.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<nav class="pagination"[^>]*>[\\s\\S]*?<a\\b[^>]*\\bhref="([^"]+)"[^>]*>[^<]*${escaped}[^<]*<\\/a>`,
    'i',
  );
  const m = html.match(re);
  if (!m) return null;
  // Nunjucks HTML-escapes query-string ampersands. Decode them so the
  // URL parser can read the same key/value pairs a browser would.
  return decodeHtmlEntities(m[1]);
}

/**
 * Decode the HTML entities a server-rendered href may carry. Nunjucks'
 * `{{ value }}` HTML-escapes the value, so query strings come out as
  // `?project=5&amp;status=…` rather than `?project=5&status=…`. The
 * URL parser does not understand `&amp;` as a separator, so we have
 * to decode before parsing.
 */
function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
      // Without assets, this release is blocked — appears in "Ready but blocked"
      expect(res.text).toContain('Ready but blocked (1)');
      expect(res.text).toContain('Ready To Publish');
      expect(res.text).toContain('no assets selected');
    });

    it('shows ready-to-publish releases with present assets', async () => {
      const projectId = await createProject(app, { title: 'Ready Publish Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Publishable Release',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      // Use the existing helper to create a present asset and link it
      attachPresentAssetToRelease(db, projectId, Number(releaseId), { name: 'asset.txt', present: true });

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Ready to publish (1)');
      expect(res.text).toContain('Publishable Release');
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

  // ─── Phase 6C: Release Planning Views ─────────────────────────────────────

  describe('release list — default view', () => {
    it('renders the release list with view-switcher buttons', async () => {
      // The previous test asserted `toContain('Releases')` (the page
      // heading) plus `toContain('List')`/`'Board'`/`'Calendar'`. Those
      // strings also appear in the Status filter option labels
      // ('Cancelled', 'Ready', etc.) and in the layout navigation, so
      // the test could pass without the view switcher being rendered.
      // The new test pins the view-switcher markup: a <div
      // class="view-switcher"> containing the three button anchors.
      const res = await request(app).get('/releases').expect(200);
      // The view-switcher wrapper must exist.
      expect(res.text).toMatch(/<div class="view-switcher">/);
      // The List label is the active view (a span, not a link).
      expect(res.text).toMatch(/<div class="view-switcher">[\s\S]*?<span class="button button-primary">List<\/span>[\s\S]*?<\/div>/);
      // The Board label IS a link to the board view.
      expect(res.text).toMatch(
        /<div class="view-switcher">[\s\S]*?<a class="button" href="\/releases\?view=board">Board<\/a>[\s\S]*?<\/div>/,
      );
      // The Calendar label is a link to the calendar view.
      expect(res.text).toMatch(
        /<div class="view-switcher">[\s\S]*?<a class="button" href="\/releases\/calendar[^"]*">Calendar<\/a>[\s\S]*?<\/div>/,
      );
    });

    it('renders releases with project title and asset counts', async () => {
      const projectId = await createProject(app, { title: 'List Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Test Release',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      const assetId = attachPresentAssetToRelease(db, Number(projectId), Number(releaseId), { name: 'test.txt' });

      const res = await request(app).get('/releases').expect(200);
      expect(res.text).toContain('Test Release');
      expect(res.text).toContain('List Project');
      expect(res.text).toMatch(/1 asset/);
    });

    it('shows missing asset warning when present', async () => {
      const projectId = await createProject(app, { title: 'Missing List Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Missing Release',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      // Create a missing asset
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.upsert(Number(projectId), 'gone.txt', {
        filename: 'gone.txt', extension: 'txt', mimeType: 'text/plain', sizeBytes: 0, modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);
      db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)`).run(Number(releaseId), asset.id);

      const res = await request(app).get('/releases').expect(200);
      expect(res.text).toContain('Missing Release');
      expect(res.text).toContain('⚠');
    });

    it('filters by project', async () => {
      const p1 = await createProject(app, { title: 'P1' });
      const p2 = await createProject(app, { title: 'P2' });
      await createRelease(app, { projectId: p1, title: 'R1', status: 'idea' });
      await createRelease(app, { projectId: p2, title: 'R2', status: 'idea' });

      const res = await request(app).get(`/releases?project=${p1}`).expect(200);
      expect(res.text).toContain('R1');
      expect(res.text).not.toContain('R2');
    });

    it('filters by status', async () => {
      const projectId = await createProject(app, { title: 'Status Filter Project' });
      await createRelease(app, { projectId, title: 'Idea R', status: 'idea' });
      await createRelease(app, { projectId, title: 'Planned R', status: 'planned' });

      const res = await request(app).get('/releases?status=idea').expect(200);
      expect(res.text).toContain('Idea R');
      expect(res.text).not.toContain('Planned R');
    });

    it('filters by schedule: overdue', async () => {
      const projectId = await createProject(app, { title: 'Overdue Filter Project' });
      await createRelease(app, {
        projectId,
        title: 'Overdue',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      await createRelease(app, {
        projectId,
        title: 'Future',
        status: 'planned',
        plannedDate: '2099-01-01',
      });

      const res = await request(app).get('/releases?schedule=overdue').expect(200);
      expect(res.text).toContain('Overdue');
      expect(res.text).not.toContain('Future');
    });

    it('filters by schedule: unscheduled', async () => {
      const projectId = await createProject(app, { title: 'Unscheduled Project' });
      await createRelease(app, {
        projectId,
        title: 'No Date',
        status: 'drafting',
        plannedDate: null,
      });

      const res = await request(app).get('/releases?schedule=unscheduled').expect(200);
      expect(res.text).toContain('No Date');
    });

    // ─── Timezone-safe schedule filters ──────────────────────────────
    //
    // The HTTP layer cannot be tested by injecting a `today` option into the
    // route (the route does not accept it), so the test must use a date
    // that is stable across UTC and local timezones. The Phase 6B helper
    // `getLocalTodayIso()` always returns the local YYYY-MM-DD, and we
    // build yesterday/today/tomorrow from THAT boundary so the test
    // cannot be confused by a UTC/local disagreement near midnight.
    //
    // Each test creates a release for each of yesterday/today/tomorrow,
    // and asserts the schedule filter narrows the row set to exactly the
    // expected dates. It also asserts the OTHER days' titles are not
    // present in the rendered list rows, not just absent from the page.
    //
    // Previous versions of these tests only matched static page text or
    // relied on `new Date().toISOString()` (which is UTC). The UTC bug
    // would silently misclassify releases near midnight in any timezone
    // west of UTC. The helper here is local-time, period.

    function isoDaysAround(today, delta) {
      const [y, m, d] = today.split('-').map(Number);
      const date = new Date(y, m - 1, d + delta);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }

    /**
     * Return the first release row whose <a href="/releases/ID"> contains
     * the supplied title text. Returns null when no row matches. This is
     * the row-level assertion the spec demands — matching the title in a
     * table row, not in any other part of the page (sidebar, options,
     * placeholders, etc).
     */
    function findReleaseRow(html, title) {
      // Each release row is <tr ...> <td><a href="/releases/{id}">Title</a> ...
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rowRe = new RegExp(
        `<tr[^>]*>[\\s\\S]*?<a href="/releases/\\d+">${escaped}</a>[\\s\\S]*?</tr>`,
        'i',
      );
      const m = html.match(rowRe);
      return m ? m[0] : null;
    }

    it('today filter: row-level — includes only the today release, excludes yesterday and tomorrow', async () => {
      const today = getLocalTodayIso();
      const yesterday = isoDaysAround(today, -1);
      const tomorrow = isoDaysAround(today, +1);

      const projectId = await createProject(app, { title: 'Today Filter Project TZ' });
      const todayId = await createRelease(app, {
        projectId,
        title: 'Today TZ Release',
        status: 'planned',
        plannedDate: today,
      });
      const yesterdayId = await createRelease(app, {
        projectId,
        title: 'Yesterday TZ Release',
        status: 'planned',
        plannedDate: yesterday,
      });
      const tomorrowId = await createRelease(app, {
        projectId,
        title: 'Tomorrow TZ Release',
        status: 'planned',
        plannedDate: tomorrow,
      });
      // Link present assets so the release does not also surface in the
      // missing-selection dashboard section. That would not affect this
      // test's assertions, but keeps the test focused.
      attachPresentAssetToRelease(db, Number(projectId), Number(todayId), { name: 'today-tz.txt' });
      attachPresentAssetToRelease(db, Number(projectId), Number(yesterdayId), { name: 'yesterday-tz.txt' });
      attachPresentAssetToRelease(db, Number(projectId), Number(tomorrowId), { name: 'tomorrow-tz.txt' });

      const res = await request(app).get('/releases?schedule=today').expect(200);

      // Row-level assertions — the today release's <tr> exists.
      const todayRow = findReleaseRow(res.text, 'Today TZ Release');
      expect(todayRow).not.toBeNull();
      // Yesterday/tomorrow rows must be absent from the table body. We
      // assert via the row-level regex (not just plain text) so the
      // negative assertion cannot be confused by an option label, page
      // heading, or any other unrelated text.
      expect(findReleaseRow(res.text, 'Yesterday TZ Release')).toBeNull();
      expect(findReleaseRow(res.text, 'Tomorrow TZ Release')).toBeNull();
    });

    it('upcoming filter: row-level — includes only the future release, excludes today and overdue', async () => {
      const today = getLocalTodayIso();
      const yesterday = isoDaysAround(today, -1);
      const tomorrow = isoDaysAround(today, +1);

      const projectId = await createProject(app, { title: 'Upcoming Filter Project TZ' });
      const todayId = await createRelease(app, {
        projectId,
        title: 'Today TZ Release',
        status: 'planned',
        plannedDate: today,
      });
      const yesterdayId = await createRelease(app, {
        projectId,
        title: 'Yesterday TZ Release',
        status: 'planned',
        plannedDate: yesterday,
      });
      const tomorrowId = await createRelease(app, {
        projectId,
        title: 'Tomorrow TZ Release',
        status: 'planned',
        plannedDate: tomorrow,
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(todayId), { name: 'today-tz-u.txt' });
      attachPresentAssetToRelease(db, Number(projectId), Number(yesterdayId), { name: 'yesterday-tz-u.txt' });
      attachPresentAssetToRelease(db, Number(projectId), Number(tomorrowId), { name: 'tomorrow-tz-u.txt' });

      const res = await request(app).get('/releases?schedule=upcoming').expect(200);

      expect(findReleaseRow(res.text, 'Tomorrow TZ Release')).not.toBeNull();
      expect(findReleaseRow(res.text, 'Today TZ Release')).toBeNull();
      expect(findReleaseRow(res.text, 'Yesterday TZ Release')).toBeNull();
    });

    it('overdue filter: row-level — includes only the past release, excludes today and future', async () => {
      const today = getLocalTodayIso();
      const yesterday = isoDaysAround(today, -1);
      const tomorrow = isoDaysAround(today, +1);

      const projectId = await createProject(app, { title: 'Overdue Filter Project TZ' });
      const todayId = await createRelease(app, {
        projectId,
        title: 'Today TZ Release',
        status: 'planned',
        plannedDate: today,
      });
      const yesterdayId = await createRelease(app, {
        projectId,
        title: 'Yesterday TZ Release',
        status: 'planned',
        plannedDate: yesterday,
      });
      const tomorrowId = await createRelease(app, {
        projectId,
        title: 'Tomorrow TZ Release',
        status: 'planned',
        plannedDate: tomorrow,
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(todayId), { name: 'today-tz-o.txt' });
      attachPresentAssetToRelease(db, Number(projectId), Number(yesterdayId), { name: 'yesterday-tz-o.txt' });
      attachPresentAssetToRelease(db, Number(projectId), Number(tomorrowId), { name: 'tomorrow-tz-o.txt' });

      const res = await request(app).get('/releases?schedule=overdue').expect(200);

      expect(findReleaseRow(res.text, 'Yesterday TZ Release')).not.toBeNull();
      expect(findReleaseRow(res.text, 'Today TZ Release')).toBeNull();
      expect(findReleaseRow(res.text, 'Tomorrow TZ Release')).toBeNull();
    });

    it('invalid status falls back gracefully', async () => {
      const res = await request(app).get('/releases?status=invalid').expect(200);
      expect(res.text).toContain('Releases');
    });

    it('archived releases show archived-row class and archived-badge markup', async () => {
      const projectId = await createProject(app, { title: 'Archive Badge Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Archive-Badge-Markup',
        status: 'idea',
      });
      await request(app).post(`/releases/${releaseId}/archive`).expect(302);

      // Use includeArchived=1 so the row is actually rendered.
      const res = await request(app).get('/releases?includeArchived=1').expect(200);
      const row = findReleaseRow(res.text, 'ZZZ-Archive-Badge-Markup');
      // The <tr> must carry the archived-row class — the row-level marker
      // the CSS uses to dim the row.
      expect(row).not.toBeNull();
      expect(row).toMatch(/class="archived-row"/);
      // The archived-badge <span> is the second row-level marker the
      // template emits inside the same <tr>. Both must be present for
      // the row to qualify as a "shown with badge" row.
      expect(row).toMatch(/<span class="archived-badge">Archived<\/span>/);
    });

    it('excludes archived parent releases from active schedule views', async () => {
      const projectId = await createProject(app, { title: 'Archived Parent Releases' });
      await createRelease(app, {
        projectId,
        title: 'Should Be Hidden',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app).get('/releases?schedule=overdue').expect(200);
      // Row-level negative: no <tr> for this release must exist.
      expect(findReleaseRow(res.text, 'Should Be Hidden')).toBeNull();
    });

    it('archived releases appear only when includeArchived=1 (list view)', async () => {
      // Distinctive title is intentional so the test cannot pass by
      // matching any unrelated "Archived" text that happens to live in
      // the page (badge, navigation, etc).
      const projectId = await createProject(app, { title: 'Archive Filter Project' });
      const activeId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Active-List-Archive-Test',
        status: 'idea',
      });
      const archivedId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Archived-List-Archive-Test',
        status: 'idea',
      });
      await request(app).post(`/releases/${archivedId}/archive`).expect(302);

      // Control: without includeArchived, the archived row's <tr> must NOT
      // be in the page. We check the row-level markup (class="archived-row")
      // so the assertion cannot be satisfied by an unrelated "Archived"
      // string elsewhere on the page.
      const resWithout = await request(app).get('/releases').expect(200);
      expect(findReleaseRow(resWithout.text, 'ZZZ-Archived-List-Archive-Test')).toBeNull();
      // Sanity: the active row's <tr> IS present.
      expect(findReleaseRow(resWithout.text, 'ZZZ-Active-List-Archive-Test')).not.toBeNull();

      // With includeArchived=1, the archived row's <tr> AND the
      // archived-badge span must be present in the rendered page.
      const resWith = await request(app).get('/releases?includeArchived=1').expect(200);
      const archivedRow = findReleaseRow(resWith.text, 'ZZZ-Archived-List-Archive-Test');
      expect(archivedRow).not.toBeNull();
      // The row must carry the archived-row class — a row-level marker
      // and the one the CSS uses to dim archived rows. Without this
      // assertion, the test could be passed by a row that contained the
      // title but was not actually styled as archived.
      expect(archivedRow).toMatch(/class="archived-row"/);
      // The archived-badge span is the second row-level marker the
      // template emits for archived releases. It must be inside the same
      // <tr> as the title.
      expect(archivedRow).toMatch(/<span class="archived-badge">Archived<\/span>/);
      // The active row must also be present (regression — the filter
      // must not exclude non-archived rows).
      expect(findReleaseRow(resWith.text, 'ZZZ-Active-List-Archive-Test')).not.toBeNull();
    });

    it('archived releases appear in board view only when includeArchived=1', async () => {
      // Distinctive title — same rationale as the list-view test.
      const projectId = await createProject(app, { title: 'Board Archive Filter Project' });
      const archivedId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Board-Archived-Card-Test',
        status: 'idea',
      });
      await request(app).post(`/releases/${archivedId}/archive`).expect(302);

      // Control: without includeArchived, the card must not be rendered.
      // The board template emits <div class="board-card ..."> per card.
      const resWithout = await request(app).get('/releases?view=board').expect(200);
      expect(resWithout.text).not.toContain('ZZZ-Board-Archived-Card-Test');
      // Negative control: the rendered page must not carry a board-card
      // with the archived modifier class for this title.
      expect(resWithout.text).not.toMatch(/<div class="board-card archived">[\s\S]*?ZZZ-Board-Archived-Card-Test/);

      // With includeArchived=1, the card must be rendered AND must carry
      // the `archived` modifier class — proving the visual badge is in
      // place, not just the title text.
      const resWith = await request(app).get('/releases?view=board&includeArchived=1').expect(200);
      expect(resWith.text).toContain('ZZZ-Board-Archived-Card-Test');
      expect(resWith.text).toMatch(/<div class="board-card archived">[\s\S]*?ZZZ-Board-Archived-Card-Test/);
    });

    it('schedule filter excludes archived releases even when includeArchived=1', async () => {
      const projectId = await createProject(app, { title: 'Schedule Archive Project' });
      const activeId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Active-Schedule-Archive',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      const archivedId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Archived-Schedule-Archive',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      await request(app).post(`/releases/${archivedId}/archive`).expect(302);

      // Even with includeArchived=1, schedule=overdue should NOT show archived releases.
      const res = await request(app).get('/releases?schedule=overdue&includeArchived=1').expect(200);
      expect(findReleaseRow(res.text, 'ZZZ-Active-Schedule-Archive')).not.toBeNull();
      expect(findReleaseRow(res.text, 'ZZZ-Archived-Schedule-Archive')).toBeNull();
    });

    it('schedule filter excludes archived parent releases even when includeArchived=1', async () => {
      // Active release under active parent — should appear in overdue filter
      const activeProjectId = await createProject(app, { title: 'Active Parent Project' });
      await createRelease(app, {
        projectId: activeProjectId,
        title: 'ZZZ-Active-Under-Active-Parent',
        status: 'planned',
        plannedDate: '2020-01-01',
      });

      // Same-date release under ARCHIVED parent — should NOT appear even with includeArchived=1
      const archivedProjectId = await createProject(app, { title: 'Archived Parent Project' });
      await createRelease(app, {
        projectId: archivedProjectId,
        title: 'ZZZ-Hidden-Under-Archived-Parent',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      await request(app).post(`/projects/${archivedProjectId}/archive`).expect(302);

      // Verify archived-parent release is NOT in overdue filter even with includeArchived=1.
      const res = await request(app).get('/releases?schedule=overdue&includeArchived=1').expect(200);
      expect(findReleaseRow(res.text, 'ZZZ-Active-Under-Active-Parent')).not.toBeNull();
      expect(findReleaseRow(res.text, 'ZZZ-Hidden-Under-Archived-Parent')).toBeNull();
    });

  });

  describe('release list — pagination', () => {
    // ─── URL.parse-based pagination link assertions ─────────────────────
    //
    // Previous versions of these tests used `text.match(/href="..."/)`
    // which could pass by finding the same query parameter on any link
    // in the page (e.g. a filter form field, a sidebar link). The new
    // tests:
    //
    //   1. Render the page and locate the *specific* Next/Previous anchor.
    //   2. Parse the href with `new URL` against a base of '/releases'.
    //   3. Assert the pathname and every expected query parameter on
    //      that same URL instance — so the test cannot pass by finding
    //      parameters across multiple unrelated links.
    //
    // The tests also assert the page state (page/pageCount) directly so
    // the link's `page` value is grounded in what the route actually
    // computed.

    it('pagination forces multiple pages when enough releases exist', async () => {
      const projectId = await createProject(app, { title: 'Pagination Force Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Page Release ${i}`, status: 'idea' });
      }

      const res = await request(app).get('/releases').expect(200);
      // The pagination nav renders a `Page N of M` span.
      expect(res.text).toContain('Page 1 of 2');
      // Anchor for Next must exist on page 1.
      const nextHref = extractPaginationHref(res.text, 'Next');
      expect(nextHref).toMatch(/^\/releases\?/);
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/releases');
      expect(nextUrl.searchParams.get('page')).toBe('2');
    });

    it('Next link: pathname and every preserved query parameter', async () => {
      const projectId = await createProject(app, { title: 'Pagination Preserve Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Preserve Release ${i}`, status: 'idea' });
      }

      const baseUrl = `/releases?project=${projectId}&status=idea&includeArchived=1&pageSize=10`;
      const res = await request(app).get(baseUrl).expect(200);

      // Extract ONLY the Next anchor's href — not any href that happens
      // to share a query string fragment.
      const nextHref = extractPaginationHref(res.text, 'Next');
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/releases');
      // Every preserved parameter MUST be on the same URL.
      expect(nextUrl.searchParams.get('project')).toBe(String(projectId));
      expect(nextUrl.searchParams.get('status')).toBe('idea');
      expect(nextUrl.searchParams.get('includeArchived')).toBe('1');
      expect(nextUrl.searchParams.get('pageSize')).toBe('10');
      expect(nextUrl.searchParams.get('page')).toBe('2');
    });

    it('Previous link on page 2: pathname and every preserved query parameter', async () => {
      const projectId = await createProject(app, { title: 'Pagination Prev Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Prev Release ${i}`, status: 'idea' });
      }

      const baseUrl = `/releases?project=${projectId}&status=idea&includeArchived=1&pageSize=10&page=2`;
      const res = await request(app).get(baseUrl).expect(200);

      const prevHref = extractPaginationHref(res.text, 'Previous');
      const prevUrl = new URL(prevHref, 'http://localhost');
      expect(prevUrl.pathname).toBe('/releases');
      expect(prevUrl.searchParams.get('project')).toBe(String(projectId));
      expect(prevUrl.searchParams.get('status')).toBe('idea');
      expect(prevUrl.searchParams.get('includeArchived')).toBe('1');
      expect(prevUrl.searchParams.get('pageSize')).toBe('10');
      expect(prevUrl.searchParams.get('page')).toBe('1');
    });

    it('pagination URLs preserve view, project, status, schedule, includeArchived, pageSize on a single URL', async () => {
      const projectId = await createProject(app, { title: 'Full Filter Preserve Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Full Release ${i}`, status: 'planned', plannedDate: '2099-01-01' });
      }

      const baseUrl = `/releases?view=list&project=${projectId}&status=planned&schedule=upcoming&includeArchived=1&pageSize=5`;
      const res = await request(app).get(baseUrl).expect(200);

      const nextHref = extractPaginationHref(res.text, 'Next');
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/releases');
      // All six parameters must be on the SAME URL.
      expect(nextUrl.searchParams.get('view')).toBe('list');
      expect(nextUrl.searchParams.get('project')).toBe(String(projectId));
      expect(nextUrl.searchParams.get('status')).toBe('planned');
      expect(nextUrl.searchParams.get('schedule')).toBe('upcoming');
      expect(nextUrl.searchParams.get('includeArchived')).toBe('1');
      expect(nextUrl.searchParams.get('pageSize')).toBe('5');
      expect(nextUrl.searchParams.get('page')).toBe('2');
    });

    it('board view does not render pagination links (no Next/Previous anchors)', async () => {
      const projectId = await createProject(app, { title: 'Board Pagination Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Board Page Release ${i}`, status: 'idea' });
      }

      const res = await request(app).get(`/releases?view=board&project=${projectId}`).expect(200);
      // No pagination anchors in board view — assertion must use the
      // specific anchor matcher, not page text.
      expect(extractPaginationHref(res.text, 'Next')).toBeNull();
      expect(extractPaginationHref(res.text, 'Previous')).toBeNull();
    });
  });

  describe('release list — view switcher active state', () => {
    // ─── View switcher link assertions ────────────────────────────────
    //
    // The view switcher is two anchors: a Board link (when in list view)
    // and a List link (when in board view). The active view renders as
    // a <span>, not an anchor.
    //
    // We extract the *exact* anchor and parse it with `new URL` so the
    // assertions check the same URL instance for every preserved
    // parameter.

    /**
     * Extract the href of the Board or List view-switcher anchor. We
     * find the anchor by its visible text, then walk back to the
     * enclosing <a … href="…">…</a> element.
     */
    function extractViewSwitchHref(html, label) {
      // The template emits the view-switcher as the FIRST <a class="button">
      // containing the label — but in list view, only the Board anchor is
      // rendered (List is a span). The label itself is wrapped in a
      // button class.
      const anchorRe = new RegExp(`<a\\b[^>]*\\bhref="([^"]+)"[^>]*>${label}<\\/a>`, 'i');
      const m = html.match(anchorRe);
      if (!m) return null;
      return decodeHtmlEntities(m[1]);
    }

    it('list view: List is a span (not a link), Board is a link', async () => {
      const res = await request(app).get('/releases').expect(200);
      // Active view: a span with button-primary, NOT an anchor.
      expect(res.text).toMatch(/<span class="button button-primary">List<\/span>/);
      // Switch anchor must exist as an <a> — not a span.
      const boardHref = extractViewSwitchHref(res.text, 'Board');
      expect(boardHref).not.toBeNull();
      const boardUrl = new URL(boardHref, 'http://localhost');
      expect(boardUrl.pathname).toBe('/releases');
      expect(boardUrl.searchParams.get('view')).toBe('board');
    });

    it('board view: Board is a span (not a link), List is a link', async () => {
      const res = await request(app).get('/releases?view=board').expect(200);
      expect(res.text).toMatch(/<span class="button button-primary">Board<\/span>/);
      const listHref = extractViewSwitchHref(res.text, 'List');
      expect(listHref).not.toBeNull();
      const listUrl = new URL(listHref, 'http://localhost');
      expect(listUrl.pathname).toBe('/releases');
      expect(listUrl.searchParams.get('view')).toBe('list');
    });

    it('view switch (list → board) preserves all query params on a single URL', async () => {
      const res = await request(app).get('/releases?project=5&status=planned&schedule=upcoming&includeArchived=1&pageSize=5').expect(200);
      const boardHref = extractViewSwitchHref(res.text, 'Board');
      expect(boardHref).not.toBeNull();
      const boardUrl = new URL(boardHref, 'http://localhost');
      expect(boardUrl.pathname).toBe('/releases');
      // Every parameter on the same URL.
      expect(boardUrl.searchParams.get('view')).toBe('board');
      expect(boardUrl.searchParams.get('project')).toBe('5');
      expect(boardUrl.searchParams.get('status')).toBe('planned');
      expect(boardUrl.searchParams.get('schedule')).toBe('upcoming');
      expect(boardUrl.searchParams.get('includeArchived')).toBe('1');
      expect(boardUrl.searchParams.get('pageSize')).toBe('5');
    });

    it('view switch (board → list) preserves all query params on a single URL', async () => {
      const res = await request(app).get('/releases?view=board&project=7&status=idea&schedule=today&includeArchived=1&pageSize=10').expect(200);
      const listHref = extractViewSwitchHref(res.text, 'List');
      expect(listHref).not.toBeNull();
      const listUrl = new URL(listHref, 'http://localhost');
      expect(listUrl.pathname).toBe('/releases');
      expect(listUrl.searchParams.get('view')).toBe('list');
      expect(listUrl.searchParams.get('project')).toBe('7');
      expect(listUrl.searchParams.get('status')).toBe('idea');
      expect(listUrl.searchParams.get('schedule')).toBe('today');
      expect(listUrl.searchParams.get('includeArchived')).toBe('1');
      expect(listUrl.searchParams.get('pageSize')).toBe('10');
    });

    it('view switch handles `page` param according to the intended behavior', async () => {
      // Intended behavior: view switch preserves the `page` parameter
      // (buildPageUrl clones the existing query and overrides only the
      // keys in overrides). The test pins this behavior so a future
      // refactor cannot accidentally carry a stale page number into the
      // wrong view.
      const projectId = await createProject(app, { title: 'View Switch Page Project' });
      for (let i = 0; i < 60; i++) {
        await createRelease(app, { projectId, title: `ViewSwitch Release ${i}`, status: 'idea' });
      }

      // Page 2 in list view → switch to board → page=2 must be preserved.
      const listRes = await request(app)
        .get(`/releases?view=list&project=${projectId}&status=idea&pageSize=10&page=2`)
        .expect(200);
      const boardHref = extractViewSwitchHref(listRes.text, 'Board');
      const boardUrl = new URL(boardHref, 'http://localhost');
      expect(boardUrl.searchParams.get('view')).toBe('board');
      expect(boardUrl.searchParams.get('page')).toBe('2');
      // Also confirm the new list anchor (back to list) preserves page=2.
      // (In the rendered list view, the List label is a span — not a
      // switch anchor. To check the inverse, render board view and
      // verify the List anchor carries page=2 too.)
      const boardRes = await request(app)
        .get(`/releases?view=board&project=${projectId}&status=idea&pageSize=10&page=2`)
        .expect(200);
      const listHref = extractViewSwitchHref(boardRes.text, 'List');
      const listUrl = new URL(listHref, 'http://localhost');
      expect(listUrl.searchParams.get('view')).toBe('list');
      expect(listUrl.searchParams.get('page')).toBe('2');
    });
  });

  describe('release list — strict numeric validation', () => {
    it('invalid project id uses safe default (null) — returns releases from both projects', async () => {
      const p1 = await createProject(app, { title: 'HTTP Malformed Alpha' });
      const p2 = await createProject(app, { title: 'HTTP Malformed Beta' });
      await createRelease(app, { projectId: p1, title: 'Alpha-HTTP-Malformed-Release', status: 'idea' });
      await createRelease(app, { projectId: p2, title: 'Beta-HTTP-Malformed-Release', status: 'idea' });

      const res = await request(app).get('/releases?project=1junk').expect(200);
      // project filter is null → both projects' releases are returned.
      expect(res.text).toContain('Alpha-HTTP-Malformed-Release');
      expect(res.text).toContain('Beta-HTTP-Malformed-Release');
    });

    it('invalid page uses safe default (1) and renders correctly', async () => {
      const projectId = await createProject(app, { title: 'Page Default Project' });
      await createRelease(app, { projectId, title: 'Valid Release', status: 'idea' });
      const res = await request(app).get('/releases?page=1junk').expect(200);
      // Should render with page 1 (the only page)
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Valid Release');
    });

    it('invalid pageSize uses safe default (25) — renders exactly 25 releases per page', async () => {
      const projectId = await createProject(app, { title: 'PageSize Default Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Size Default ${i}`, status: 'idea' });
      }
      const res = await request(app).get('/releases?pageSize=1junk').expect(200);
      // pageSize falls back to the default of 25. With 30 releases, page 1
      // shows 25 releases (newest-first by updated DESC), page 2 shows 5.
      expect(res.text).toContain('Page 1');
      // Assert exactly 25 release rows — the default pageSize is used.
      const rowMatches = res.text.match(/<a href="\/releases\/\d+">Size Default \d+<\/a>/g) || [];
      expect(rowMatches.length).toBe(25);
    });

    it('pageSize over max is capped at 100', async () => {
      const projectId = await createProject(app, { title: 'Large PageSize Project' });
      for (let i = 0; i < 150; i++) {
        await createRelease(app, { projectId, title: `Large Release ${i}`, status: 'idea' });
      }

      const res = await request(app).get('/releases?pageSize=200').expect(200);
      // pageSize should be capped at 100, so page 1 shows newest releases first (by updated DESC)
      // With 150 releases and pageSize=100, page 1 shows releases 50-149 (newest first)
      expect(res.text).toContain('Large Release 149');
    });

    it('rejects non-integer page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'NonInteger Page Project' });
      await createRelease(app, { projectId, title: 'NonInt Release', status: 'idea' });
      const res = await request(app).get('/releases?page=2.5').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('NonInt Release');
    });

    it('rejects negative page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Negative Page Project' });
      await createRelease(app, { projectId, title: 'Neg Release', status: 'idea' });
      const res = await request(app).get('/releases?page=-1').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Neg Release');
    });

    it('rejects zero page value and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Zero Page Project' });
      await createRelease(app, { projectId, title: 'Zero Release', status: 'idea' });
      const res = await request(app).get('/releases?page=0').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Zero Release');
    });

    it('rejects scientific notation page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Sci Notation Page Project' });
      await createRelease(app, { projectId, title: 'Sci Release', status: 'idea' });
      const res = await request(app).get('/releases?page=1e2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Sci Release');
    });

    it('rejects leading plus page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Plus Page Project' });
      await createRelease(app, { projectId, title: 'Plus Release', status: 'idea' });
      const res = await request(app).get('/releases?page=+2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Plus Release');
    });

    it('rejects URL-decoded "+2" page with pageSize=1 and falls back to page 1', async () => {
      // Required regression: a URL query string of `page=+2&pageSize=1`
      // URL-decodes to page=" 2" (leading space) and pageSize="1". The
      // strict validator must reject the leading-space page, so the route
      // uses the default page=1. The pageSize=1 is valid and respected.
      const projectId = await createProject(app, { title: 'Url Decoded Plus Project' });
      await createRelease(app, { projectId, title: 'First', status: 'idea' });
      await createRelease(app, { projectId, title: 'Second', status: 'idea' });
      const res = await request(app).get('/releases?page=+2&pageSize=1').expect(200);
      expect(res.text).toContain('Page 1');
    });

    it('rejects leading-whitespace page values', async () => {
      const projectId = await createProject(app, { title: 'Leading Space Project' });
      await createRelease(app, { projectId, title: 'Leading Space Release', status: 'idea' });
      // Express URL-decodes "%20" to a literal space; test via percent-encoded form.
      const res = await request(app).get('/releases?page=%202').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Leading Space Release');
    });

    it('rejects trailing-whitespace page values', async () => {
      const projectId = await createProject(app, { title: 'Trailing Space Project' });
      await createRelease(app, { projectId, title: 'Trailing Space Release', status: 'idea' });
      const res = await request(app).get('/releases?page=2%20').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Trailing Space Release');
    });

    it('rejects "1junk" page values', async () => {
      const projectId = await createProject(app, { title: '1Junk Page Project' });
      await createRelease(app, { projectId, title: '1Junk Release', status: 'idea' });
      const res = await request(app).get('/releases?page=1junk').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('1Junk Release');
    });

    it('rejects "2.5" page values', async () => {
      const projectId = await createProject(app, { title: '2.5 Page Project' });
      await createRelease(app, { projectId, title: '2.5 Release', status: 'idea' });
      const res = await request(app).get('/releases?page=2.5').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('2.5 Release');
    });

    it('rejects "1e2" page values', async () => {
      const projectId = await createProject(app, { title: '1e2 Page Project' });
      await createRelease(app, { projectId, title: '1e2 Release', status: 'idea' });
      const res = await request(app).get('/releases?page=1e2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('1e2 Release');
    });

    it('rejects "-2" page values', async () => {
      const projectId = await createProject(app, { title: 'Neg2 Page Project' });
      await createRelease(app, { projectId, title: 'Neg2 Release', status: 'idea' });
      const res = await request(app).get('/releases?page=-2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Neg2 Release');
    });

    it('rejects "0" page values', async () => {
      const projectId = await createProject(app, { title: 'Zero Page Project 2' });
      await createRelease(app, { projectId, title: 'Zero Page Release', status: 'idea' });
      const res = await request(app).get('/releases?page=0').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Zero Page Release');
    });

    it('rejects blank page values', async () => {
      const projectId = await createProject(app, { title: 'Blank Page Project' });
      await createRelease(app, { projectId, title: 'Blank Release', status: 'idea' });
      const res = await request(app).get('/releases?page=').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Blank Release');
    });
  });

  describe('release list — board view', () => {
    it('renders board view with all six status column headers', async () => {
      // The previous test asserted `toContain('Idea')` etc. — those
      // words also appear in the Status filter <option> labels, so the
      // assertion could pass without ever rendering a board column. The
      // new test pins the exact column-header markup emitted by the
      // board template: each column is rendered as
      // <h3 class="board-column-header status-{status}">…</h3>.
      const res = await request(app).get('/releases?view=board').expect(200);
      const columns = ['idea', 'planned', 'drafting', 'ready', 'published', 'cancelled'];
      for (const status of columns) {
        expect(res.text).toMatch(
          new RegExp(`<h3 class="board-column-header status-${status}">`),
        );
      }
    });

    it('renders all six columns each with its own count badge', async () => {
      // The previous test used `toMatch(/Idea.*\()/)` which is satisfied
      // by any "Idea" followed by an opening paren anywhere in the page.
      // The new test pins each column header to its own count badge
      // <span class="count">(N)</span> — proving the column is real.
      const res = await request(app).get('/releases?view=board').expect(200);
      const columns = ['idea', 'planned', 'drafting', 'ready', 'published', 'cancelled'];
      for (const status of columns) {
        expect(res.text).toMatch(
          new RegExp(
            `<h3 class="board-column-header status-${status}">[\\s\\S]*?<span class="count">\\(\\d+\\)</span>`,
          ),
        );
      }
    });

    it('renders releases in board columns inside board-card markup', async () => {
      // The previous test only checked `toContain('Board Idea')` — that
      // passes even if the title leaked into a sidebar or filter input.
      // The new test pins the card markup: each card is
      // <div class="board-card …">…<a href="/releases/{id}">Title</a>…</div>.
      const projectId = await createProject(app, { title: 'Board Render Project' });
      await createRelease(app, { projectId, title: 'ZZZ-Board-Idea-Card-Test', status: 'idea' });
      await createRelease(app, { projectId, title: 'ZZZ-Board-Planned-Card-Test', status: 'planned' });

      const res = await request(app).get('/releases?view=board').expect(200);
      // Each card must wrap the title in a .board-card div.
      expect(res.text).toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Idea-Card-Test[\s\S]*?<\/div>/,
      );
      expect(res.text).toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Planned-Card-Test[\s\S]*?<\/div>/,
      );
    });

    it('board shows project title on cards (in .card-project)', async () => {
      // The previous test checked `toContain('Board Title Project')` —
      // that could be matched by an unrelated text occurrence. Pin the
      // markup to the .card-project element.
      const projectId = await createProject(app, { title: 'ZZZ-Board-Title-Project' });
      await createRelease(app, { projectId, title: 'Card Release', status: 'idea' });

      const res = await request(app).get('/releases?view=board').expect(200);
      expect(res.text).toMatch(
        /<div class="card-project">ZZZ-Board-Title-Project<\/div>/,
      );
    });

    it('board shows planned date on cards (in .card-date)', async () => {
      // The previous test checked `toContain('2025-06-15')` — a generic
      // date pattern that could be matched anywhere on the page (e.g.
      // the calendar nav, an unrelated attribute). Pin the date to the
      // .card-date element emitted by the card.
      const projectId = await createProject(app, { title: 'Board Date Project' });
      await createRelease(app, {
        projectId,
        title: 'ZZZ-Board-Dated-Release',
        status: 'idea',
        plannedDate: '2025-06-15',
      });

      const res = await request(app).get('/releases?view=board').expect(200);
      expect(res.text).toMatch(
        /<span class="card-date">2025-06-15<\/span>/,
      );
    });

    it('board shows asset count (in .card-assets)', async () => {
      // The previous test checked `toContain('1 asset')` — a generic
      // string also matched by a "0 assets" / "2 assets" elsewhere. Pin
      // the asset count to the .card-assets element with the exact
      // expected number.
      const projectId = await createProject(app, { title: 'Board Asset Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Board-Asset-Count-Release',
        status: 'idea',
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(releaseId), { name: 'asset.txt' });

      const res = await request(app).get('/releases?view=board').expect(200);
      expect(res.text).toMatch(
        /<span class="card-assets">\s*1 asset\s*<\/span>/,
      );
    });

    it('board shows missing asset warning (in .missing-indicator)', async () => {
      // The previous test checked `toContain('⚠')` — a single character
      // that could match any unrelated warning icon. Pin the
      // .missing-indicator element to the missing release's card.
      const projectId = await createProject(app, { title: 'Board Missing Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Board-Missing-Card-Release',
        status: 'idea',
      });
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.upsert(Number(projectId), 'gone.txt', {
        filename: 'gone.txt', extension: 'txt', mimeType: 'text/plain', sizeBytes: 0, modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);
      db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)`).run(Number(releaseId), asset.id);

      const res = await request(app).get('/releases?view=board').expect(200);
      // Card with the missing release must contain the missing-indicator.
      expect(res.text).toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Missing-Card-Release[\s\S]*?<span class="missing-indicator"[^>]*>⚠\s*1<\/span>[\s\S]*?<\/div>/,
      );
    });

    it('board renders empty states (in .board-empty) for columns with no releases', async () => {
      // The previous test checked `toContain('No releases')` — that
      // string also appears in the list view's empty placeholder. Pin
      // the empty placeholder to the .board-empty element emitted only
      // by the board template.
      const res = await request(app).get('/releases?view=board').expect(200);
      const boardEmptyMatches = res.text.match(/<p class="board-empty">No releases<\/p>/g) || [];
      // Six columns × one "No releases" each = 6.
      expect(boardEmptyMatches.length).toBe(6);
    });

    it('board is read-only (no mutation controls)', async () => {
      const projectId = await createProject(app, { title: 'Board Read-Only Project' });
      await createRelease(app, { projectId, title: 'Read-Only Release', status: 'idea' });

      const res = await request(app).get('/releases?view=board').expect(200);
      expect(res.text).not.toContain('action="/releases/');
      expect(res.text).not.toContain('method="post"');
    });

    it('board respects project filter (row-level)', async () => {
      // The previous test used `toContain('R1')` and `not.toContain('R2')`
      // — a generic letter+number match. Pin each release to its own
      // board-card element.
      const p1 = await createProject(app, { title: 'BP1 Filter' });
      const p2 = await createProject(app, { title: 'BP2 Filter' });
      await createRelease(app, { projectId: p1, title: 'ZZZ-P1-Card', status: 'idea' });
      await createRelease(app, { projectId: p2, title: 'ZZZ-P2-Card', status: 'idea' });

      const res = await request(app).get(`/releases?view=board&project=${p1}`).expect(200);
      expect(res.text).toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-P1-Card[\s\S]*?<\/div>/,
      );
      expect(res.text).not.toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-P2-Card[\s\S]*?<\/div>/,
      );
    });

    it('board excludes archived parent releases (row-level)', async () => {
      // The previous test used `not.toContain('Hidden From Board')` —
      // a generic string match. Pin the negative assertion to the
      // board-card element.
      const projectId = await createProject(app, { title: 'Board Archived Parent' });
      await createRelease(app, {
        projectId,
        title: 'ZZZ-Board-Hidden-Archived-Parent',
        status: 'planned',
        plannedDate: '2025-06-20',
      });
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app).get('/releases?view=board').expect(200);
      expect(res.text).not.toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Hidden-Archived-Parent[\s\S]*?<\/div>/,
      );
    });
  });

  describe('release calendar', () => {
    it('renders the calendar page with the calendar header structure', async () => {
      // A real assertion: the page must render the calendar nav (with
      // month header) AND the table of weekday headers. The previous
      // test only matched the "Release Calendar" page heading, which
      // would also be true on an error page that happens to render the
      // layout.
      const res = await request(app).get('/releases/calendar').expect(200);
      expect(res.text).toContain('Release Calendar');
      // Calendar nav structure: a <div class="calendar-nav"> with the
      // month <h2> and prev/next buttons.
      expect(res.text).toMatch(/<div class="calendar-nav"[^>]*>[\s\S]*?<h2>\d{4}-\d{2}<\/h2>/);
      // Calendar table structure: weekday header row.
      expect(res.text).toMatch(/<th>Mon<\/th>[\s\S]*?<th>Sun<\/th>/);
    });

    it('renders navigation anchors (not just text)', async () => {
      // The previous test only checked `toContain('Previous')` and
      // `toContain('Next')`, which any unrelated link or label would
      // satisfy. The new test extracts the actual nav anchors.
      const res = await request(app).get('/releases/calendar').expect(200);
      // Prev/next anchors must exist as <a> elements, not as plain text.
      expect(extractCalendarNavHref(res.text, '← Previous')).not.toBeNull();
      expect(extractCalendarNavHref(res.text, 'Next →')).not.toBeNull();
    });

    it('uses explicit month from query (calendar header h2)', async () => {
      // Pin the rendered month to the exact query value via the <h2>
      // element, not the loose `toContain` that the previous test used.
      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      expect(extractCalendarHeaderMonth(res.text)).toBe('2025-06');
    });

    it('renders releases on calendar days with status badge', async () => {
      const projectId = await createProject(app, { title: 'Calendar Project' });
      await createRelease(app, {
        projectId,
        title: 'ZZZ-June-15-Calendar-Release',
        status: 'planned',
        plannedDate: '2025-06-15',
      });

      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      // The release title must be rendered inside the calendar grid
      // (in a .calendar-release div, not in any other location).
      expect(res.text).toMatch(/<div class="calendar-release"[^>]*>[\s\S]*?ZZZ-June-15-Calendar-Release[\s\S]*?<\/div>/);
      // The status badge must carry the .status-planned class (the
      // status styling the CSS uses) — not the bare word "planned"
      // which would also match the schedule filter option label.
      expect(res.text).toMatch(/<span class="release-status status-planned">planned<\/span>/);
      // The project title must be visible inside the same card.
      expect(res.text).toMatch(/<span class="release-project">Calendar Project<\/span>/);
    });

    it('shows empty days without releases (calendar grid has 30 day cells for June)', async () => {
      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      // The grid emits one <td class="calendar-day">…</td> per day
      // plus leading and trailing empty cells (with the additional
      // "empty-day" modifier) to fill the week. The previous test
      // only checked `toContain('15')`, which could be satisfied by
      // any digit string in the page.
      const allCellMatches = res.text.match(/<td class="calendar-day[^"]*">/g) || [];
      const emptyDayPadding = res.text.match(/<td class="calendar-day empty-day">/g) || [];
      const actualDayCells = allCellMatches.length - emptyDayPadding.length;
      // June has 30 days. The padding cells fill the week grid.
      expect(actualDayCells).toBe(30);
      // No release cards in any cell — the day is "empty".
      expect(res.text).not.toMatch(/<div class="calendar-release"/);
    });

    it('shows missing asset warning on calendar', async () => {
      const projectId = await createProject(app, { title: 'Calendar Missing Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Missing Calendar Release',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.upsert(Number(projectId), 'gone.txt', {
        filename: 'gone.txt', extension: 'txt', mimeType: 'text/plain', sizeBytes: 0, modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);
      db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)`).run(Number(releaseId), asset.id);

      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      expect(res.text).toContain('Missing Calendar Release');
      expect(res.text).toContain('⚠');
    });

    it('links releases to detail page', async () => {
      const projectId = await createProject(app, { title: 'Calendar Link Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Linked Release',
        status: 'planned',
        plannedDate: '2025-06-15',
      });

      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      expect(res.text).toMatch(new RegExp(`href="/releases/${releaseId}"`));
    });

    // ─── Exact-fallback assertions for invalid months ──────────────────
    //
    // The HTTP route does not accept a `today` option, so the test must
    // ground the expected fallback month in the application's local
    // "today" (the same value the service uses to compute the fallback).
    // The previous test only checked the page heading ("Release Calendar")
    // — that passes even on a 500 rendering the error page. These tests
    // pin the exact fallback month, the exact prev/next navigation
    // values, and assert the rendered page uses the fallback month as
    // the calendar header.

    function expectedLocalMonth() {
      // The fallback month is the YYYY-MM derived from the application's
      // local "today". getLocalTodayIso() always uses local year/month/day
      // so the result is stable regardless of OS timezone.
      return getLocalTodayIso().slice(0, 7);
    }

    function expectedPrevOfCurrent() {
      const m = expectedLocalMonth();
      const [y, mo] = m.split('-').map(Number);
      if (mo === 1) return `${y - 1}-12`;
      return `${y}-${String(mo - 1).padStart(2, '0')}`;
    }

    function expectedNextOfCurrent() {
      const m = expectedLocalMonth();
      const [y, mo] = m.split('-').map(Number);
      if (mo === 12) return `${y + 1}-01`;
      return `${y}-${String(mo + 1).padStart(2, '0')}`;
    }

    /**
     * Extract the calendar nav <h2> month value. The template emits
     * <h2>{{ month }}</h2> inside .calendar-nav. We use a narrow
     * regex to avoid catching the same YYYY-MM string in a link
     * href or in another heading.
     */
    function extractCalendarHeaderMonth(html) {
      const m = html.match(/<h2>(\d{4}-\d{2})<\/h2>/);
      return m ? m[1] : null;
    }

    /**
     * Extract the prev/next month navigation hrefs. The template
     * wraps them in <div class="calendar-nav"> … <a …>← Previous</a>
     * … <a …>Next →</a> … </div>. We extract the href of each anchor
     * to assert the exact month= value on the same URL.
     */
    function extractCalendarNavHref(html, label) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `<div class="calendar-nav"[^>]*>[\\s\\S]*?<a\\b[^>]*\\bhref="([^"]+)"[^>]*>${escaped}<\\/a>`,
        'i',
      );
      const m = html.match(re);
      if (!m) return null;
      return decodeHtmlEntities(m[1]);
    }

    it.each([
      ['0001-01'],
      ['0999-12'],
      ['10000-01'],
      ['2025-00'],
      ['2025-13'],
      ['invalid'],
      [''],
    ])('invalid month %s falls back to the exact current local month with exact prev/next nav', async (bad) => {
      const expectedMonth = expectedLocalMonth();
      const expectedPrev = expectedPrevOfCurrent();
      const expectedNext = expectedNextOfCurrent();

      // The HTTP query is encoded — Express decodes it before reaching
      // the service. We pass the literal bad value, URL-encoded if it
      // contains special characters.
      const res = await request(app)
        .get(`/releases/calendar?month=${encodeURIComponent(bad)}`)
        .expect(200);

      // The header <h2> must show the EXACT fallback month — not just
      // any YYYY-MM that happens to satisfy the format regex.
      expect(extractCalendarHeaderMonth(res.text)).toBe(expectedMonth);

      // The Previous nav link's href must point at exactly expectedPrev.
      const prevHref = extractCalendarNavHref(res.text, '← Previous');
      expect(prevHref).not.toBeNull();
      const prevUrl = new URL(prevHref, 'http://localhost');
      expect(prevUrl.pathname).toBe('/releases/calendar');
      expect(prevUrl.searchParams.get('month')).toBe(expectedPrev);

      // The Next nav link's href must point at exactly expectedNext.
      const nextHref = extractCalendarNavHref(res.text, 'Next →');
      expect(nextHref).not.toBeNull();
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/releases/calendar');
      expect(nextUrl.searchParams.get('month')).toBe(expectedNext);
    });

    it('previous month link is present', async () => {
      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      expect(res.text).toContain('2025-05');
    });

    it('next month link is present', async () => {
      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      expect(res.text).toContain('2025-07');
    });

    it('calendar excludes archived parent releases', async () => {
      const projectId = await createProject(app, { title: 'Calendar Archived Parent' });
      await createRelease(app, {
        projectId,
        title: 'Hidden From Calendar',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      expect(res.text).not.toContain('Hidden From Calendar');
    });

    it('has navigation links to list and board', async () => {
      const res = await request(app).get('/releases/calendar').expect(200);
      expect(res.text).toContain('href="/releases"');
      expect(res.text).toContain('href="/releases?view=board"');
    });

    // ─── Calendar navigation year boundaries ───────────────────────────
    //
    // At the lower year boundary (1000-01), the previous link would step
    // to the unsupported "999-12" — the template must NOT render an anchor
    // for that. At the upper boundary (9999-12), the next link would step
    // to the unsupported "10000-01" — also forbidden. For in-range months,
    // both links remain.

    it('lower boundary (1000-01) has no Previous anchor (only a disabled span)', async () => {
      const res = await request(app).get('/releases/calendar?month=1000-01').expect(200);
      // The rendered header must show exactly 1000-01.
      expect(extractCalendarHeaderMonth(res.text)).toBe('1000-01');
      // No anchor for the previous month (which would be 0999-12). Use
      // the strict anchor extractor — must return null.
      expect(extractCalendarNavHref(res.text, '← Previous')).toBeNull();
      // The disabled span is still present to keep the layout stable.
      expect(res.text).toMatch(/<span class="button button-disabled"[^>]*>← Previous<\/span>/);
      // The Next anchor IS present (1000-02) and points to the right URL.
      const nextHref = extractCalendarNavHref(res.text, 'Next →');
      expect(nextHref).not.toBeNull();
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/releases/calendar');
      expect(nextUrl.searchParams.get('month')).toBe('1000-02');
    });

    it('upper boundary (9999-12) has no Next anchor (only a disabled span)', async () => {
      const res = await request(app).get('/releases/calendar?month=9999-12').expect(200);
      expect(extractCalendarHeaderMonth(res.text)).toBe('9999-12');
      // No anchor for the next month (which would be 10000-01).
      expect(extractCalendarNavHref(res.text, 'Next →')).toBeNull();
      // The disabled span is still present.
      expect(res.text).toMatch(/<span class="button button-disabled"[^>]*>Next →<\/span>/);
      // The Previous anchor IS present (9999-11).
      const prevHref = extractCalendarNavHref(res.text, '← Previous');
      expect(prevHref).not.toBeNull();
      const prevUrl = new URL(prevHref, 'http://localhost');
      expect(prevUrl.pathname).toBe('/releases/calendar');
      expect(prevUrl.searchParams.get('month')).toBe('9999-11');
    });

    it('in-range months retain both Previous and Next links with exact month= values', async () => {
      const res = await request(app).get('/releases/calendar?month=2025-06').expect(200);
      expect(extractCalendarHeaderMonth(res.text)).toBe('2025-06');
      const prevHref = extractCalendarNavHref(res.text, '← Previous');
      const nextHref = extractCalendarNavHref(res.text, 'Next →');
      expect(prevHref).not.toBeNull();
      expect(nextHref).not.toBeNull();
      const prevUrl = new URL(prevHref, 'http://localhost');
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(prevUrl.searchParams.get('month')).toBe('2025-05');
      expect(nextUrl.searchParams.get('month')).toBe('2025-07');
    });

    it('in-range boundary months (1000-02, 9999-11) keep both links with exact values', async () => {
      // 1000-02 — just above the lower boundary. Previous must point to
      // 1000-01 (still in range), Next must point to 1000-03.
      const lowRes = await request(app).get('/releases/calendar?month=1000-02').expect(200);
      expect(extractCalendarHeaderMonth(lowRes.text)).toBe('1000-02');
      const lowPrev = new URL(extractCalendarNavHref(lowRes.text, '← Previous'), 'http://localhost');
      const lowNext = new URL(extractCalendarNavHref(lowRes.text, 'Next →'), 'http://localhost');
      expect(lowPrev.searchParams.get('month')).toBe('1000-01');
      expect(lowNext.searchParams.get('month')).toBe('1000-03');

      // 9999-11 — just below the upper boundary.
      const highRes = await request(app).get('/releases/calendar?month=9999-11').expect(200);
      expect(extractCalendarHeaderMonth(highRes.text)).toBe('9999-11');
      const highPrev = new URL(extractCalendarNavHref(highRes.text, '← Previous'), 'http://localhost');
      const highNext = new URL(extractCalendarNavHref(highRes.text, 'Next →'), 'http://localhost');
      expect(highPrev.searchParams.get('month')).toBe('9999-10');
      expect(highNext.searchParams.get('month')).toBe('9999-12');
    });
  });

  // ─── Phase 6C: Existing routes regression ─────────────────────────────────

  describe('existing release routes remain working', () => {
    it('release detail still renders', async () => {
      const projectId = await createProject(app, { title: 'Detail Regression' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Detail Regression Release',
        status: 'planned',
      });

      const res = await request(app).get(`/releases/${releaseId}`).expect(200);
      expect(res.text).toContain('Detail Regression Release');
    });

    it('release create form still renders', async () => {
      const projectId = await createProject(app, { title: 'Create Regression' });
      const res = await request(app).get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(res.text).toContain('Create');
    });

    it('release edit form still renders', async () => {
      const projectId = await createProject(app, { title: 'Edit Regression' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Edit Regression Release',
        status: 'idea',
      });

      const res = await request(app).get(`/releases/${releaseId}/edit`).expect(200);
      expect(res.text).toContain('Edit');
    });

    it('release mutation still works (archive)', async () => {
      const projectId = await createProject(app, { title: 'Mutation Regression' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Mutation Regression Release',
        status: 'idea',
      });

      await request(app).post(`/releases/${releaseId}/archive`).expect(302);

      const res = await request(app).get(`/releases/${releaseId}`).expect(200);
      expect(res.text).toContain('Archived');
    });

    it('archived project mutations are rejected — release archive returns 422 and archived_at stays NULL', async () => {
      // 1. Create a project and a mutable release; retain its ID.
      const projectId = await createProject(app, { title: 'Archived Mutation Reject' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Should Not Archive',
        status: 'idea',
      });

      // 2. Archive the parent project.
      await request(app).post(`/projects/${projectId}/archive`).expect(302);

      // 3. POST the release archive endpoint — must be rejected.
      await request(app)
        .post(`/releases/${releaseId}/archive`)
        .expect(422);

      // 4. Query the database — archived_at must still be NULL.
      const row = db.prepare('SELECT archived_at FROM releases WHERE id = ?').get(releaseId);
      expect(row.archived_at).toBeNull();
    });
  });

  // ─── Phase 6D: Archive-policy and usage-link defects ─────────────────────

  describe('Phase 6D archive-policy and usage-link defects', () => {
    /**
     * Create a project directory with a file so scanning produces assets.
     */
    async function createProjectWithFile({ title, status = 'tbd' }) {
      const projectId = await createProject(app, { title, status });
      const projectDir = getProjectDir(projectsRoot, title, status);
      expect(projectDir).not.toBeNull();
      fs.writeFileSync(path.join(projectDir, 'asset.txt'), 'content');
      return projectId;
    }

    /**
     * Create a release and link an asset to it.
     */
    async function createReleaseWithLinkedAsset(projectId, title) {
      const releaseId = await createRelease(app, { projectId, title, status: 'idea' });
      // Scan to create the asset record
      await request(app).post(`/projects/${projectId}/scan`).expect(302);
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(projectId);
      expect(assets.length).toBeGreaterThan(0);
      const asset = assets[0];
      // Link via POST
      await request(app)
        .post(`/releases/${releaseId}/assets`)
        .send(`selectedAssetIds=${asset.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { releaseId, assetId: asset.id };
    }

    // ─── Fix 1: Block scanning for archived projects ─────────────────

    describe('block scanning for archived projects', () => {
      it('archived project asset page contains no scan form or submit button', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Scan Hide' });
        // Archive the project
        await request(app).post(`/projects/${projectId}/archive`).expect(302);

        const res = await request(app).get(`/projects/${projectId}/assets`).expect(200);
        // The scan form must not be rendered — assert the form markup is absent
        expect(res.text).not.toContain(`action="/projects/${projectId}/scan"`);
        expect(res.text).not.toMatch(/<button[^>]*>\s*Scan Now\s*<\/button>/);
        // The empty-state "Scan Now" text (inside a <strong>) must not be confused
        // with the button — the button is absent, but the placeholder text may still
        // contain "Scan Now" for non-archived projects. For archived projects the
        // placeholder says "No assets found for this archived project."
        expect(res.text).not.toContain('Click <strong>Scan Now</strong>');
      });

      it('active project contains the actual scan form and submit button', async () => {
        const projectId = await createProjectWithFile({ title: 'Active Scan Show' });

        const res = await request(app).get(`/projects/${projectId}/assets`).expect(200);
        // Assert the form element with the correct action
        expect(res.text).toContain(`<form method="post" action="/projects/${projectId}/scan" class="inline-form">`);
        // Assert the submit button inside the form
        expect(res.text).toMatch(/<button class="button button-primary" type="submit">Scan Now<\/button>/);
        // The empty-state placeholder also contains "Scan Now" — ensure the button
        // assertion is about the form button, not the placeholder text
        expect(res.text).toContain('Click <strong>Scan Now</strong>');
      });

      it('POST scan for archived project is rejected', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Scan Reject' });
        // Archive the project
        await request(app).post(`/projects/${projectId}/archive`).expect(302);

        await request(app)
          .post(`/projects/${projectId}/scan`)
          .expect(302)
          .expect('Location', `/projects/${projectId}/assets?scan_error=archived`);
      });

      it('archived scan rejection causes no asset changes (full row snapshot)', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Scan Snapshot' });
        const projectDir = getProjectDir(projectsRoot, 'Archived Scan Snapshot');
        expect(projectDir).not.toBeNull();

        // Establish baseline: scan the initial file
        await request(app).post(`/projects/${projectId}/scan`).expect(302);

        // Create filesystem conditions that would cause each scanner action:
        //   1. Insert — a new file on disk not yet in the DB
        //   2. Update — an existing file with changed content (different size)
        //   3. Mark missing — a file in the DB that no longer exists on disk
        const assetRepo = createAssetRepository(db);

        // Add a second file (would trigger insert on scan)
        fs.writeFileSync(path.join(projectDir, 'new-file.txt'), 'new content');

        // Modify the original file (would trigger update on scan — different size)
        fs.writeFileSync(path.join(projectDir, 'asset.txt'), 'modified content that is longer');

        // Snapshot complete asset rows before archiving
        const beforeRows = db.prepare(`
          SELECT id, project_id, relative_path, filename, extension, mime_type,
                 size_bytes, modified_at, is_present, last_seen_at, missing_since,
                 created_at, updated_at
          FROM assets
          WHERE project_id = ?
          ORDER BY id
        `).all(projectId);
        expect(beforeRows.length).toBeGreaterThanOrEqual(1);

        // Archive the project
        await request(app).post(`/projects/${projectId}/archive`).expect(302);

        // Attempt scan — must be rejected
        await request(app)
          .post(`/projects/${projectId}/scan`)
          .expect(302)
          .expect('Location', `/projects/${projectId}/assets?scan_error=archived`);

        // Snapshot asset rows after the rejected scan
        const afterRows = db.prepare(`
          SELECT id, project_id, relative_path, filename, extension, mime_type,
                 size_bytes, modified_at, is_present, last_seen_at, missing_since,
                 created_at, updated_at
          FROM assets
          WHERE project_id = ?
          ORDER BY id
        `).all(projectId);

        // Complete rows must deep-equal — no insert, no update, no missing marking
        expect(afterRows).toEqual(beforeRows);

        // Explicit count assertions for clarity
        expect(afterRows.length).toBe(beforeRows.length);
        expect(afterRows.length).toBeGreaterThanOrEqual(1);

        // Every row's metadata must be identical
        for (let i = 0; i < beforeRows.length; i++) {
          expect(afterRows[i].is_present).toBe(beforeRows[i].is_present);
          expect(afterRows[i].size_bytes).toBe(beforeRows[i].size_bytes);
          expect(afterRows[i].last_seen_at).toBe(beforeRows[i].last_seen_at);
          expect(afterRows[i].missing_since).toBe(beforeRows[i].missing_since);
          expect(afterRows[i].updated_at).toBe(beforeRows[i].updated_at);
        }
      });
    });

    // ─── Fix 3: Link usage details to read-only release detail ────────

    describe('usage links point to release detail', () => {
      it('usage link URL is /releases/:id not /releases/:id/assets', async () => {
        const projectId = await createProjectWithFile({ title: 'Usage Link Test' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Usage Link Release');

        const res = await request(app).get(`/projects/${projectId}/assets`).expect(200);
        // The usage link should point to the release detail, not the asset-selection page
        const expectedHref = `/releases/${releaseId}`;
        expect(res.text).toContain(`href="${expectedHref}"`);
        expect(res.text).not.toContain(`href="${expectedHref}/assets"`);
      });
    });

    // ─── Fix 4: Archived release asset-selection UI read-only ─────────

    describe('archived release asset-selection UI read-only', () => {
      it('archived release under active project has disabled checkboxes and no Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Release UI' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived UI Release');

        // Archive the release
        await request(app).post(`/releases/${releaseId}/archive`).expect(302);

        const res = await request(app).get(`/releases/${releaseId}/assets`).expect(200);
        // Checkboxes must be disabled
        expect(res.text).toContain('type="checkbox"');
        expect(res.text).toContain('disabled');
        // Role selects must be disabled
        expect(res.text).toContain('disabled class="asset-role"');
        // Sort order inputs must be disabled
        expect(res.text).toContain('disabled class="asset-sort-order"');
        // Should show the archived notice
        expect(res.text).toContain('This release is archived');
        // Save Selection must be absent
        expect(res.text).not.toContain('Save Selection');
      });

      it('archived release under active project has no Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived No Save' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived No Save Release');

        // Archive the release
        await request(app).post(`/releases/${releaseId}/archive`).expect(302);

        const res = await request(app).get(`/releases/${releaseId}/assets`).expect(200);
        expect(res.text).not.toContain('Save Selection');
      });

      it('active release under active project has enabled checkboxes and Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Active Release Editable' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Active Editable Release');

        const res = await request(app).get(`/releases/${releaseId}/assets`).expect(200);
        // Checkboxes present and not disabled
        expect(res.text).toContain('type="checkbox"');
        expect(res.text).not.toMatch(/type="checkbox"[^>]*disabled/);
        // Save Selection button present and enabled
        expect(res.text).toContain('Save Selection');
        expect(res.text).toMatch(/<button class="button button-primary" type="submit">Save Selection<\/button>/);
      });

      it('archived parent project has disabled checkboxes and no Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Parent UI' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived Parent Release');

        // Archive the PARENT project (not the release)
        await request(app).post(`/projects/${projectId}/archive`).expect(302);

        const res = await request(app).get(`/releases/${releaseId}/assets`).expect(200);
        // Checkboxes must be disabled
        expect(res.text).toContain('type="checkbox"');
        expect(res.text).toContain('disabled');
        // Should show the parent-archived notice
        expect(res.text).toContain('parent project is archived');
        // Save Selection must be absent
        expect(res.text).not.toContain('Save Selection');
      });

      it('direct POST for archived release remains rejected', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived POST Reject' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived POST Reject Release');

        // Archive the release
        await request(app).post(`/releases/${releaseId}/archive`).expect(302);

        // Attempt to POST asset selection
        await request(app)
          .post(`/releases/${releaseId}/assets`)
          .send('selectedAssetIds=99999')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);
      });
    });

    // ─── Fix 5: Asset-browser pagination whitelist ────────────────────

    describe('asset-browser pagination whitelist', () => {
      it('pagination URLs contain only presence, usage, pageSize, page — no junk', async () => {
        // Create enough assets for multiple pages
        const projectId = await createProjectWithFile({ title: 'Pagination Whitelist' });
        const projectDir = getProjectDir(projectsRoot, 'Pagination Whitelist');
        for (let i = 0; i < 15; i++) {
          fs.writeFileSync(path.join(projectDir, `page_${i}.txt`), 'content');
        }
        await request(app).post(`/projects/${projectId}/scan`).expect(302);

        // Request with valid filters plus junk=x
        const res = await request(app)
          .get(`/projects/${projectId}/assets?presence=present&usage=all&pageSize=10&junk=x`)
          .expect(200);

        // Extract the Next link
        const nextHref = extractPaginationHref(res.text, 'Next');
        expect(nextHref).not.toBeNull();
        const nextUrl = new URL(nextHref, 'http://localhost');

        // Pathname must be correct
        expect(nextUrl.pathname).toBe(`/projects/${projectId}/assets`);

        // Only the four allowed params must be present
        expect(nextUrl.searchParams.get('presence')).toBe('present');
        expect(nextUrl.searchParams.get('usage')).toBe('all');
        expect(nextUrl.searchParams.get('pageSize')).toBe('10');
        expect(nextUrl.searchParams.get('page')).toBe('2');

        // Exactly 4 search params — no junk
        expect(nextUrl.searchParams.size).toBe(4);
        expect(nextUrl.searchParams.has('junk')).toBe(false);
      });
    });
  });

  // ─── Phase 7B: Readiness disclaimer rendering ──────────────────────────

  describe('readiness disclaimer rendering', () => {
    it('renders the scan-state disclaimer for a publishable release', async () => {
      const projectId = await createProject(app, { title: 'Disclaimer Publishable' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Publishable Release',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(releaseId), { name: 'asset.txt', present: true });

      const res = await request(app).get(`/releases/${releaseId}`).expect(200);
      // The readiness panel must contain the scan-state wording
      const panelMatch = res.text.match(/<section class="readiness-panel">[\s\S]*?<\/section>/);
      expect(panelMatch).not.toBeNull();
      expect(panelMatch[0]).toContain('Asset presence reflects the last completed scan');
      expect(panelMatch[0]).toContain('not performing a live filesystem check');
    });

    it('renders the scan-state disclaimer for a blocked release', async () => {
      const projectId = await createProject(app, { title: 'Disclaimer Blocked' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Blocked Release',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      // No assets — blocked by assets_selected

      const res = await request(app).get(`/releases/${releaseId}`).expect(200);
      const panelMatch = res.text.match(/<section class="readiness-panel">[\s\S]*?<\/section>/);
      expect(panelMatch).not.toBeNull();
      expect(panelMatch[0]).toContain('Asset presence reflects the last completed scan');
      expect(panelMatch[0]).toContain('not performing a live filesystem check');
    });
  });
});
