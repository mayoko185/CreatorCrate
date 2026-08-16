/**
 * HTTP-level tests for Phase 6B dashboard composition and project workspace.
 *
 * These tests are designed to fail if the route starts calling repositories
 * directly or stops using the workflow query service. They also assert the
 * safe empty state of the new dashboard sections.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import nunjucks from 'nunjucks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { formatProjectDirName } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { getLocalTodayIso } from '../src/util/date.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));

function renderTemplate(templateName, context = {}) {
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  return env.render(templateName, context);
}

function getProjectDir(projectsRoot, projectId, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(projectsRoot, formatProjectDirName(Number(projectId), slug));
}

async function createProject(app, { title, status = 'tbd' }) {
  const res = await app.testAgent
    .post('/projects')
    .send(`title=${encodeURIComponent(title)}`)
    .send(`status=${status}`)
    .send('priority=normal')
    .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  return res.headers.location.replace('/projects/', '');
}

async function createRelease(app, {
  projectId,
  title,
  status: projectStatus = null,
  plannedDate = null,
  plannedTime = null,
}) {
  if (projectStatus !== null) {
    app.testDb.prepare('UPDATE projects SET status = ? WHERE id = ?').run(projectStatus, projectId);
  }
  const body = [`projectId=${projectId}`, `title=${encodeURIComponent(title)}`];
  if (plannedDate) body.push(`plannedDate=${plannedDate}`);
  if (plannedTime) body.push(`plannedTime=${plannedTime}`);
  body.push('_csrf=' + encodeURIComponent(app.testCsrfToken));
  const res = await app.testAgent
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
  // `?project=5&amp;search=…` rather than `?project=5&search=…`. The
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

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-6b-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.testDb = db;
    const { agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot);
    app.testAgent = agent;
    app.testCsrfToken = csrfToken;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Project workspace ─────────────────────────────────────────────

  describe('project workspace', () => {
    it('renders the workflow actions block with a "Create release" link', async () => {
      const projectId = await createProject(app, { title: 'Workspace Actions Project' });
      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('Create release');
      // The link should be scoped to this project
      expect(res.text).toContain(`/releases/new?projectId=${projectId}`);
    });

    it('renders the release summary section heading', async () => {
      const projectId = await createProject(app, { title: 'Release Summary Project' });
      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('Releases');
      expect(res.text).toContain(`/releases/new?projectId=${projectId}`);
    });

    it('shows active and recent release lists', async () => {
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
      // Select an asset for the publication fixture
      attachPresentAssetToRelease(db, Number(projectId), Number(oldReleaseId));
      await app.testAgent
        .post(`/releases/${oldReleaseId}/publish`)
        .send('publishedDate=2024-01-01')
        .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      expect(res.text).toContain('Active Release');
      expect(res.text).toContain('Old Release');
    });

    it('shows asset health counts', async () => {
      const projectId = await createProject(app, { title: 'Health Project' });
      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      // Asset health is surfaced as count cards in the detail hero.
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

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      // Counts should reflect 1 present and 1 missing (count-card markup)
      expect(res.text).toContain('<span class="count">1</span>');
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

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
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
      // Select an asset for the publication fixture
      attachPresentAssetToRelease(db, Number(projectId), Number(releaseId));
      await app.testAgent
        .post(`/releases/${releaseId}/publish`)
        .send('publishedDate=2020-01-15')
        .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);
      // After the project is archived, release mutation routes reject the
      // call (the parent project is immutable). The historical release
      // information must still be available through the project workspace.

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      // Project archived notice is shown
      expect(res.text).toContain('Archived');
      // Historical release still shows in recent
      expect(res.text).toContain('Historical Release');
      // Publication metadata remains visible in the historical release row.
      expect(res.text).toContain('2020-01-15');
    });

    it('shows safe empty states for a project with no releases or assets', async () => {
      const projectId = await createProject(app, { title: 'Bare Project' });
      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      // Phase 2C: empty release-record state is optional/secondary copy, not
      // "no releases yet" language implying the project is incomplete.
      expect(res.text).toContain('No release records for this project.');
      expect(res.text).not.toContain('No releases yet');
    });

    it('archived project does not show the "Create release" action', async () => {
      const projectId = await createProject(app, { title: 'No Create Action Project' });
      // Archive the project via the documented action.
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      // The Create release link targets /releases/new?projectId=…
      expect(res.text).not.toContain(`/releases/new?projectId=${projectId}`);
      expect(res.text).not.toMatch(/<a[^>]*>\s*Create release\s*<\/a>/);
      // "View Assets" is still offered (read-only browsing is fine).
      expect(res.text).toContain(`href="/projects/${projectId}/assets"`);
    });

    it('active project keeps the "Create release" action', async () => {
      const projectId = await createProject(app, { title: 'Keep Create Action Project' });
      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
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
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      // No Edit link targeting this project's edit form.
      expect(res.text).not.toContain(`href="/projects/${projectId}/edit"`);
      expect(res.text).not.toMatch(/<a[^>]*href="\/projects\/\d+\/edit"[^>]*>\s*Edit\s*<\/a>/);
    });

    it('archived project does not show the Archive action', async () => {
      const projectId = await createProject(app, { title: 'Archived No Archive Button' });
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
      // No archive form/button targeting this project.
      expect(res.text).not.toContain(`action="/projects/${projectId}/archive"`);
      expect(res.text).not.toMatch(/<button[^>]*>\s*Archive project\s*<\/button>/);
    });

    it('active project shows the Edit dialog trigger with destructive controls inside the dialog', async () => {
      const projectId = await createProject(app, { title: 'Active Has Both Controls' });
      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);

      expect(res.text).toContain(`href="/projects/${projectId}/edit"`);
      expect(res.text).toContain('data-dialog-open="project-edit-dialog"');
      // The icon-only workspace edit action retains its accessible label.
      expect(res.text).toMatch(/<a[^>]*aria-label="Edit project"[^>]*>/);

      const edit = await app.testAgent.get(`/projects/${projectId}?edit=1`).expect(200);
      const dialog = edit.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).not.toBe('');
      expect(dialog).toContain(`action="/projects/${projectId}/archive"`);
      expect(dialog).toContain(`action="/projects/${projectId}/delete"`);
      expect(dialog).toContain('data-confirm="Delete this project permanently? This cannot be undone."');
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
      // Select an asset for the publication fixture
      attachPresentAssetToRelease(db, Number(projectId), Number(releaseId));
      await app.testAgent
        .post(`/releases/${releaseId}/publish`)
        .send('publishedDate=2020-01-15')
        .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get(`/projects/${projectId}`).expect(200);
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

  // ─── 404 safety ────────────────────────────────────────────────────

  describe('safe 404 behavior', () => {
    it('returns 404 for a missing project detail', async () => {
      const res = await app.testAgent.get('/projects/9999').expect(404);
      expect(res.text).toContain('Not found');
    });

    it('returns 404 for a malformed project id', async () => {
      await app.testAgent.get('/projects/abc').expect(404);
    });

    it('returns 404 for an unknown route', async () => {
      const res = await app.testAgent.get('/not-a-real-route').expect(404);
      expect(res.text).not.toContain('at ');
    });
  });

  // ─── Existing project routes remain working ────────────────────────

  describe('existing project routes remain working', () => {
    it('project list still renders', async () => {
      const res = await app.testAgent.get('/projects').expect(200);
      expect(res.text).toContain('Projects');
    });

    it('project edit route redirects to the initially open detail dialog', async () => {
      const projectId = await createProject(app, { title: 'Still Works Project' });
      const res = await app.testAgent.get(`/projects/${projectId}/edit`).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}?edit=1`);
    });

    it('asset listing still works from project detail', async () => {
      const projectId = await createProject(app, { title: 'Asset List Project' });
      const res = await app.testAgent.get(`/projects/${projectId}/assets`).expect(200);
      expect(res.text).toContain('Assets');
    });
  });

  // ─── Service wiring ────────────────────────────────────────────────

  describe('service wiring', () => {
    it('releases list still renders (regression check)', async () => {
      const res = await app.testAgent.get('/release-management').expect(200);
      expect(res.text).toContain('Releases');
    });
  });

  // ─── Phase 6C: Release Planning Views ─────────────────────────────────────

  describe('release list — default view', () => {
    it('renders the release list with view-switcher buttons', async () => {
      // Phase 10.5C: view switcher uses shared view-switcher-option pattern
      // with aria-current="page" for the active view instead of span/button.
      const res = await app.testAgent.get('/release-management').expect(200);
      // The view-switcher wrapper must exist as a nav.
      expect(res.text).toMatch(/<nav class="view-switcher"/);
      // The List label is the active view (aria-current="page"), no dead active class.
      expect(res.text).toMatch(/class="view-switcher-option"[^>]*aria-current="page"[^>]*>List<\/a>/);
      // The Board label is a link to the board view.
      expect(res.text).toMatch(/<a class="view-switcher-option" href="\/release-management\?view=board">Board<\/a>/);
      // The Calendar label is a link to the calendar view.
      expect(res.text).toMatch(/<a class="view-switcher-option" href="\/calendar[^"]*">Calendar<\/a>/);
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

      const res = await app.testAgent.get('/release-management').expect(200);
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

      const res = await app.testAgent.get('/release-management').expect(200);
      expect(res.text).toContain('Missing Release');
      expect(res.text).toContain('⚠');
    });

    it('filters by project', async () => {
      const p1 = await createProject(app, { title: 'P1' });
      const p2 = await createProject(app, { title: 'P2' });
      await createRelease(app, { projectId: p1, title: 'R1', status: 'tbd' });
      await createRelease(app, { projectId: p2, title: 'R2', status: 'tbd' });

      const res = await app.testAgent.get(`/release-management?project=${p1}`).expect(200);
      expect(res.text).toContain('R1');
      expect(res.text).not.toContain('R2');
    });

    it('ignores an obsolete release-status query without mapping it to project status', async () => {
      const tbdProjectId = await createProject(app, { title: 'Status Filter TBD Project', status: 'tbd' });
      const plannedProjectId = await createProject(app, { title: 'Status Filter Planned Project', status: 'planned' });
      await createRelease(app, { projectId: tbdProjectId, title: 'Idea R', status: 'tbd' });
      await createRelease(app, { projectId: plannedProjectId, title: 'Planned R', status: 'planned' });

      const res = await app.testAgent.get('/release-management?status=tbd').expect(200);
      expect(res.text).toContain('Idea R');
      expect(res.text).toContain('Planned R');
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

      const res = await app.testAgent.get('/release-management?schedule=overdue').expect(200);
      expect(res.text).toContain('Overdue');
      expect(res.text).not.toContain('Future');
    });

    it('filters by schedule: unscheduled', async () => {
      const projectId = await createProject(app, { title: 'Unscheduled Project' });
      await createRelease(app, {
        projectId,
        title: 'No Date',
        status: 'in-progress',
        plannedDate: null,
      });

      const res = await app.testAgent.get('/release-management?schedule=unscheduled').expect(200);
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

      const res = await app.testAgent.get('/release-management?schedule=today').expect(200);

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

      const res = await app.testAgent.get('/release-management?schedule=upcoming').expect(200);

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

      const res = await app.testAgent.get('/release-management?schedule=overdue').expect(200);

      expect(findReleaseRow(res.text, 'Yesterday TZ Release')).not.toBeNull();
      expect(findReleaseRow(res.text, 'Today TZ Release')).toBeNull();
      expect(findReleaseRow(res.text, 'Tomorrow TZ Release')).toBeNull();
    });

    it('invalid status falls back gracefully', async () => {
      const res = await app.testAgent.get('/release-management?status=invalid').expect(200);
      expect(res.text).toContain('Releases');
    });

    it('archived releases show archived-row class and archived status badge', async () => {
      const projectId = await createProject(app, { title: 'Archive Badge Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Archive-Badge-Markup',
        status: 'tbd',
      });
      await app.testAgent.post(`/releases/${releaseId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      // Use includeArchived=1 so the row is actually rendered.
      const res = await app.testAgent.get('/release-management?includeArchived=1').expect(200);
      const row = findReleaseRow(res.text, 'ZZZ-Archive-Badge-Markup');
      // The <tr> must carry the archived-row class — the row-level marker
      // the CSS uses to dim the row.
      expect(row).not.toBeNull();
      expect(row).toMatch(/class="archived-row"/);
      // Phase 10.5C: archived releases now use the shared status-badge partial
      // with status-badge--archived variant instead of a separate archived-badge.
      expect(row).toMatch(/<span class="status-badge status-badge--archived">Archived<\/span>/);
    });

    it('excludes archived parent releases from active schedule views', async () => {
      const projectId = await createProject(app, { title: 'Archived Parent Releases' });
      await createRelease(app, {
        projectId,
        title: 'Should Be Hidden',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get('/release-management?schedule=overdue').expect(200);
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
        status: 'tbd',
      });
      const archivedId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Archived-List-Archive-Test',
        status: 'tbd',
      });
      await app.testAgent.post(`/releases/${archivedId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      // Control: without includeArchived, the archived row's <tr> must NOT
      // be in the page. We check the row-level markup (class="archived-row")
      // so the assertion cannot be satisfied by an unrelated "Archived"
      // string elsewhere on the page.
      const resWithout = await app.testAgent.get('/release-management').expect(200);
      expect(findReleaseRow(resWithout.text, 'ZZZ-Archived-List-Archive-Test')).toBeNull();
      // Sanity: the active row's <tr> IS present.
      expect(findReleaseRow(resWithout.text, 'ZZZ-Active-List-Archive-Test')).not.toBeNull();

      // With includeArchived=1, the archived row's <tr> AND the
      // archived-badge span must be present in the rendered page.
      const resWith = await app.testAgent.get('/release-management?includeArchived=1').expect(200);
      const archivedRow = findReleaseRow(resWith.text, 'ZZZ-Archived-List-Archive-Test');
      expect(archivedRow).not.toBeNull();
      // The row must carry the archived-row class — a row-level marker
      // and the one the CSS uses to dim archived rows. Without this
      // assertion, the test could be passed by a row that contained the
      // title but was not actually styled as archived.
      expect(archivedRow).toMatch(/class="archived-row"/);
      // Phase 10.5C: archived releases now use the shared status-badge
      // partial instead of a separate archived-badge span.
      expect(archivedRow).toMatch(/<span class="status-badge status-badge--archived">Archived<\/span>/);
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
        status: 'tbd',
      });
      await app.testAgent.post(`/releases/${archivedId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      // Control: without includeArchived, the card must not be rendered.
      // The board template emits <div class="board-card ..."> per card.
      const resWithout = await app.testAgent.get('/release-management?view=board').expect(200);
      expect(resWithout.text).not.toContain('ZZZ-Board-Archived-Card-Test');
      // Negative control: the rendered page must not carry a board-card
      // with the archived modifier class for this title.
      expect(resWithout.text).not.toMatch(/<div class="board-card archived">[\s\S]*?ZZZ-Board-Archived-Card-Test/);

      // With includeArchived=1, the card must be rendered AND must carry
      // the `archived` modifier class — proving the visual badge is in
      // place, not just the title text.
      const resWith = await app.testAgent.get('/release-management?view=board&includeArchived=1').expect(200);
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
      await app.testAgent.post(`/releases/${archivedId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      // Even with includeArchived=1, schedule=overdue should NOT show archived releases.
      const res = await app.testAgent.get('/release-management?schedule=overdue&includeArchived=1').expect(200);
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
      await app.testAgent.post(`/projects/${archivedProjectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      // Verify archived-parent release is NOT in overdue filter even with includeArchived=1.
      const res = await app.testAgent.get('/release-management?schedule=overdue&includeArchived=1').expect(200);
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
        await createRelease(app, { projectId, title: `Page Release ${i}`, status: 'tbd' });
      }

      const res = await app.testAgent.get('/release-management').expect(200);
      // The pagination nav renders a `Page N of M` span.
      expect(res.text).toContain('Page 1 of 2');
      // Anchor for Next must exist on page 1.
      const nextHref = extractPaginationHref(res.text, 'Next');
      expect(nextHref).toMatch(/^\/release-management\?/);
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/release-management');
      expect(nextUrl.searchParams.get('page')).toBe('2');
    });

    it('Next link: pathname and every supported query parameter', async () => {
      const projectId = await createProject(app, { title: 'Pagination Preserve Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Preserve Release ${i}`, status: 'tbd' });
      }

      const baseUrl = `/release-management?project=${projectId}&includeArchived=1&pageSize=10`;
      const res = await app.testAgent.get(baseUrl).expect(200);

      // Extract ONLY the Next anchor's href — not any href that happens
      // to share a query string fragment.
      const nextHref = extractPaginationHref(res.text, 'Next');
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/release-management');
      // Every preserved parameter MUST be on the same URL.
      expect(nextUrl.searchParams.get('project')).toBe(String(projectId));
      expect(nextUrl.searchParams.has('status')).toBe(false);
      expect(nextUrl.searchParams.get('includeArchived')).toBe('1');
      expect(nextUrl.searchParams.get('pageSize')).toBe('10');
      expect(nextUrl.searchParams.get('page')).toBe('2');
    });

    it('Previous link on page 2: pathname and every supported query parameter', async () => {
      const projectId = await createProject(app, { title: 'Pagination Prev Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Prev Release ${i}`, status: 'tbd' });
      }

      const baseUrl = `/release-management?project=${projectId}&includeArchived=1&pageSize=10&page=2`;
      const res = await app.testAgent.get(baseUrl).expect(200);

      const prevHref = extractPaginationHref(res.text, 'Previous');
      const prevUrl = new URL(prevHref, 'http://localhost');
      expect(prevUrl.pathname).toBe('/release-management');
      expect(prevUrl.searchParams.get('project')).toBe(String(projectId));
      expect(prevUrl.searchParams.has('status')).toBe(false);
      expect(prevUrl.searchParams.get('includeArchived')).toBe('1');
      expect(prevUrl.searchParams.get('pageSize')).toBe('10');
      // Page=1 is the default so it's omitted from generated URLs
      expect(prevUrl.searchParams.get('page')).toBeNull();
    });

    it('pagination URLs preserve view, project, schedule, includeArchived, pageSize on a single URL', async () => {
      const projectId = await createProject(app, { title: 'Full Filter Preserve Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Full Release ${i}`, status: 'planned', plannedDate: '2099-01-01' });
      }

      const baseUrl = `/release-management?view=list&project=${projectId}&schedule=upcoming&includeArchived=1&pageSize=5`;
      const res = await app.testAgent.get(baseUrl).expect(200);

      const nextHref = extractPaginationHref(res.text, 'Next');
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/release-management');
      // All supported parameters must be on the SAME URL.
      expect(nextUrl.searchParams.get('view')).toBe('list');
      expect(nextUrl.searchParams.get('project')).toBe(String(projectId));
      expect(nextUrl.searchParams.has('status')).toBe(false);
      expect(nextUrl.searchParams.get('schedule')).toBe('upcoming');
      expect(nextUrl.searchParams.get('includeArchived')).toBe('1');
      expect(nextUrl.searchParams.get('pageSize')).toBe('5');
      expect(nextUrl.searchParams.get('page')).toBe('2');
    });

    it('board view does not render pagination links (no Next/Previous anchors)', async () => {
      const projectId = await createProject(app, { title: 'Board Pagination Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Board Page Release ${i}`, status: 'tbd' });
      }

      const res = await app.testAgent.get(`/release-management?view=board&project=${projectId}`).expect(200);
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
      // Phase 10.5C: the view switcher uses shared view-switcher-option links.
      // Both active and inactive items are <a> elements; the active one
      // carries aria-current="page" (no separate active class).
      const anchorRe = new RegExp(`<a\\b[^>]*\\bhref="([^"]+)"[^>]*>${label}<\\/a>`, 'i');
      const m = html.match(anchorRe);
      if (!m) return null;
      return decodeHtmlEntities(m[1]);
    }

    it('list view: List is marked active, Board is a link', async () => {
      const res = await app.testAgent.get('/release-management').expect(200);
      // Active view: view-switcher-option with aria-current="page"
      expect(res.text).toMatch(/class="view-switcher-option"[^>]*aria-current="page"[^>]*>List<\/a>/);
      // No dead active class remains
      expect(res.text).not.toContain('view-switcher-option--active');
      // Switch anchor must exist as an <a> — not a span.
      const boardHref = extractViewSwitchHref(res.text, 'Board');
      expect(boardHref).not.toBeNull();
      const boardUrl = new URL(boardHref, 'http://localhost');
      expect(boardUrl.pathname).toBe('/release-management');
      expect(boardUrl.searchParams.get('view')).toBe('board');
    });

    it('board view: Board is marked active, List is a link', async () => {
      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      // Active view: view-switcher-option with aria-current="page"
      expect(res.text).toMatch(/class="view-switcher-option"[^>]*aria-current="page"[^>]*>Board<\/a>/);
      expect(res.text).not.toContain('view-switcher-option--active');
      const listHref = extractViewSwitchHref(res.text, 'List');
      expect(listHref).not.toBeNull();
      const listUrl = new URL(listHref, 'http://localhost');
      expect(listUrl.pathname).toBe('/release-management');
      expect(listUrl.searchParams.get('view')).toBe('list');
    });

    it('view switch (list → board) preserves all supported query params on a single URL', async () => {
      const res = await app.testAgent.get('/release-management?project=5&schedule=upcoming&includeArchived=1&pageSize=5').expect(200);
      const boardHref = extractViewSwitchHref(res.text, 'Board');
      expect(boardHref).not.toBeNull();
      const boardUrl = new URL(boardHref, 'http://localhost');
      expect(boardUrl.pathname).toBe('/release-management');
      // Every parameter on the same URL.
      expect(boardUrl.searchParams.get('view')).toBe('board');
      expect(boardUrl.searchParams.get('project')).toBe('5');
      expect(boardUrl.searchParams.has('status')).toBe(false);
      expect(boardUrl.searchParams.get('schedule')).toBe('upcoming');
      expect(boardUrl.searchParams.get('includeArchived')).toBe('1');
      expect(boardUrl.searchParams.get('pageSize')).toBe('5');
    });

    it('view switch (board → list) preserves all supported query params on a single URL', async () => {
      const res = await app.testAgent.get('/release-management?view=board&project=7&schedule=today&includeArchived=1&pageSize=10').expect(200);
      const listHref = extractViewSwitchHref(res.text, 'List');
      expect(listHref).not.toBeNull();
      const listUrl = new URL(listHref, 'http://localhost');
      expect(listUrl.pathname).toBe('/release-management');
      expect(listUrl.searchParams.get('view')).toBe('list');
      expect(listUrl.searchParams.get('project')).toBe('7');
      expect(listUrl.searchParams.has('status')).toBe(false);
      expect(listUrl.searchParams.get('schedule')).toBe('today');
      expect(listUrl.searchParams.get('includeArchived')).toBe('1');
      expect(listUrl.searchParams.get('pageSize')).toBe('10');
    });

    it('view switch clears page state when switching between list and board', async () => {
      // Intended behavior: view switch clears the `page` parameter because
      // pagination is view-specific — list and board have different page counts.
      const projectId = await createProject(app, { title: 'View Switch Page Project' });
      for (let i = 0; i < 60; i++) {
        await createRelease(app, { projectId, title: `ViewSwitch Release ${i}`, status: 'tbd' });
      }

      // Page 2 in list view → switch to board → page must be cleared.
      const listRes = await app.testAgent
        .get(`/release-management?view=list&project=${projectId}&pageSize=10&page=2`)
        .expect(200);
      const boardHref = extractViewSwitchHref(listRes.text, 'Board');
      const boardUrl = new URL(boardHref, 'http://localhost');
      expect(boardUrl.searchParams.get('view')).toBe('board');
      expect(boardUrl.searchParams.get('page')).toBeNull();
      // Also confirm the new list anchor (back to list) has no page.
      const boardRes = await app.testAgent
        .get(`/release-management?view=board&project=${projectId}&pageSize=10&page=2`)
        .expect(200);
      const listHref = extractViewSwitchHref(boardRes.text, 'List');
      const listUrl = new URL(listHref, 'http://localhost');
      expect(listUrl.searchParams.get('view')).toBe('list');
      expect(listUrl.searchParams.get('page')).toBeNull();
    });
  });

  describe('release list — strict numeric validation', () => {
    it('invalid project id uses safe default (null) — returns releases from both projects', async () => {
      const p1 = await createProject(app, { title: 'HTTP Malformed Alpha' });
      const p2 = await createProject(app, { title: 'HTTP Malformed Beta' });
      await createRelease(app, { projectId: p1, title: 'Alpha-HTTP-Malformed-Release', status: 'tbd' });
      await createRelease(app, { projectId: p2, title: 'Beta-HTTP-Malformed-Release', status: 'tbd' });

      const res = await app.testAgent.get('/release-management?project=1junk').expect(200);
      // project filter is null → both projects' releases are returned.
      expect(res.text).toContain('Alpha-HTTP-Malformed-Release');
      expect(res.text).toContain('Beta-HTTP-Malformed-Release');
    });

    it('invalid page uses safe default (1) and renders correctly', async () => {
      const projectId = await createProject(app, { title: 'Page Default Project' });
      await createRelease(app, { projectId, title: 'Valid Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=1junk').expect(200);
      // Should render with page 1 (the only page)
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Valid Release');
    });

    it('invalid pageSize uses safe default (25) — renders exactly 25 releases per page', async () => {
      const projectId = await createProject(app, { title: 'PageSize Default Project' });
      for (let i = 0; i < 30; i++) {
        await createRelease(app, { projectId, title: `Size Default ${i}`, status: 'tbd' });
      }
      const res = await app.testAgent.get('/release-management?pageSize=1junk').expect(200);
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
        await createRelease(app, { projectId, title: `Large Release ${i}`, status: 'tbd' });
      }

      const res = await app.testAgent.get('/release-management?pageSize=200').expect(200);
      // pageSize should be capped at 100, so page 1 shows newest releases first (by updated DESC)
      // With 150 releases and pageSize=100, page 1 shows releases 50-149 (newest first)
      expect(res.text).toContain('Large Release 149');
    });

    it('rejects non-integer page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'NonInteger Page Project' });
      await createRelease(app, { projectId, title: 'NonInt Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=2.5').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('NonInt Release');
    });

    it('rejects negative page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Negative Page Project' });
      await createRelease(app, { projectId, title: 'Neg Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=-1').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Neg Release');
    });

    it('rejects zero page value and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Zero Page Project' });
      await createRelease(app, { projectId, title: 'Zero Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=0').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Zero Release');
    });

    it('rejects scientific notation page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Sci Notation Page Project' });
      await createRelease(app, { projectId, title: 'Sci Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=1e2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Sci Release');
    });

    it('rejects leading plus page values and uses safe default', async () => {
      const projectId = await createProject(app, { title: 'Plus Page Project' });
      await createRelease(app, { projectId, title: 'Plus Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=+2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Plus Release');
    });

    it('rejects URL-decoded "+2" page with pageSize=1 and falls back to page 1', async () => {
      // Required regression: a URL query string of `page=+2&pageSize=1`
      // URL-decodes to page=" 2" (leading space) and pageSize="1". The
      // strict validator must reject the leading-space page, so the route
      // uses the default page=1. The pageSize=1 is valid and respected.
      const projectId = await createProject(app, { title: 'Url Decoded Plus Project' });
      await createRelease(app, { projectId, title: 'First', status: 'tbd' });
      await createRelease(app, { projectId, title: 'Second', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=+2&pageSize=1').expect(200);
      expect(res.text).toContain('Page 1');
    });

    it('rejects leading-whitespace page values', async () => {
      const projectId = await createProject(app, { title: 'Leading Space Project' });
      await createRelease(app, { projectId, title: 'Leading Space Release', status: 'tbd' });
      // Express URL-decodes "%20" to a literal space; test via percent-encoded form.
      const res = await app.testAgent.get('/release-management?page=%202').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Leading Space Release');
    });

    it('rejects trailing-whitespace page values', async () => {
      const projectId = await createProject(app, { title: 'Trailing Space Project' });
      await createRelease(app, { projectId, title: 'Trailing Space Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=2%20').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Trailing Space Release');
    });

    it('rejects "1junk" page values', async () => {
      const projectId = await createProject(app, { title: '1Junk Page Project' });
      await createRelease(app, { projectId, title: '1Junk Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=1junk').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('1Junk Release');
    });

    it('rejects "2.5" page values', async () => {
      const projectId = await createProject(app, { title: '2.5 Page Project' });
      await createRelease(app, { projectId, title: '2.5 Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=2.5').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('2.5 Release');
    });

    it('rejects "1e2" page values', async () => {
      const projectId = await createProject(app, { title: '1e2 Page Project' });
      await createRelease(app, { projectId, title: '1e2 Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=1e2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('1e2 Release');
    });

    it('rejects "-2" page values', async () => {
      const projectId = await createProject(app, { title: 'Neg2 Page Project' });
      await createRelease(app, { projectId, title: 'Neg2 Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=-2').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Neg2 Release');
    });

    it('rejects "0" page values', async () => {
      const projectId = await createProject(app, { title: 'Zero Page Project 2' });
      await createRelease(app, { projectId, title: 'Zero Page Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=0').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Zero Page Release');
    });

    it('rejects blank page values', async () => {
      const projectId = await createProject(app, { title: 'Blank Page Project' });
      await createRelease(app, { projectId, title: 'Blank Release', status: 'tbd' });
      const res = await app.testAgent.get('/release-management?page=').expect(200);
      expect(res.text).toContain('Page 1');
      expect(res.text).toContain('Blank Release');
    });
  });

  describe('release list — board view', () => {
    it('renders board view with the five workflow and publication column headers', async () => {
      // The previous test asserted `toContain('Idea')` etc. — those
      // words also appear in the Status filter <option> labels, so the
      // assertion could pass without ever rendering a board column. The
      // new test pins the exact column-header markup: each column header
      // contains a status badge with the status label text.
      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      const headers = res.text.match(/<h3 class="board-column-header">[\s\S]*?<\/h3>/g) || [];
      const labels = headers.map((header) => header.match(/<span class="status-badge[^>]*>([^<]+)<\/span>/)?.[1]);
      expect(labels).toEqual(['Tbd', 'Planned', 'In Progress', 'Ready', 'Published']);
      expect(res.text).not.toContain('Cancelled');
    });

    it('renders all five columns each with its own count badge', async () => {
      // The previous test used `toMatch(/Idea.*\()/)` which is satisfied
      // by any "Idea" followed by an opening paren anywhere in the page.
      // The new test pins each column header to its own count badge
      // <span class="count">(N)</span> — proving the column is real.
      // Phase 10.5C: column headers use shared status-badge partial
      // instead of inline status-X color classes.
      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      const headers = res.text.match(/<h3 class="board-column-header">[\s\S]*?<\/h3>/g) || [];
      expect(headers).toHaveLength(5);
      for (const header of headers) {
        expect(header).toMatch(/<span class="count">\(\d+\)<\/span>/);
      }
      expect(res.text).not.toContain('Cancelled');
    });

    it('renders releases in board columns inside board-card markup', async () => {
      // The previous test only checked `toContain('Board Idea')` — that
      // passes even if the title leaked into a sidebar or filter input.
      // The new test pins the card markup: each card is
      // <div class="board-card …">…<a href="/releases/{id}">Title</a>…</div>.
      const projectId = await createProject(app, { title: 'Board Render Project' });
      await createRelease(app, { projectId, title: 'ZZZ-Board-Idea-Card-Test', status: 'tbd' });
      await createRelease(app, { projectId, title: 'ZZZ-Board-Planned-Card-Test', status: 'planned' });

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      // Each card must wrap the title in a .board-card div.
      expect(res.text).toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Idea-Card-Test[\s\S]*?<\/div>/,
      );
      expect(res.text).toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Planned-Card-Test[\s\S]*?<\/div>/,
      );
    });

    it('groups published releases by published_date instead of project status', async () => {
      const projectId = await createProject(app, { title: 'Board Published Project', status: 'ready' });
      const publishedId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Board-Published-By-Date',
        status: 'ready',
      });
      const activeId = await createRelease(app, {
        projectId,
        title: 'ZZZ-Board-Ready-By-Project',
        status: 'ready',
      });
      db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(Number(publishedId));

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      const headers = [...res.text.matchAll(/<h3 class="board-column-header">[\s\S]*?<\/h3>/g)];
      const columnBody = (label) => {
        const index = headers.findIndex((match) => match[0].includes(`>${label}</span>`));
        expect(index).toBeGreaterThanOrEqual(0);
        const start = headers[index].index;
        const end = headers[index + 1]?.index ?? res.text.length;
        return res.text.slice(start, end);
      };

      const publishedColumn = columnBody('Published');
      const readyColumn = columnBody('Ready');
      expect(publishedColumn).toContain(`href="/releases/${publishedId}"`);
      expect(publishedColumn).not.toContain(`href="/releases/${activeId}"`);
      expect(readyColumn).toContain(`href="/releases/${activeId}"`);
      expect(readyColumn).not.toContain(`href="/releases/${publishedId}"`);
    });

    it('board shows project title on cards (in .card-project)', async () => {
      // The previous test checked `toContain('Board Title Project')` —
      // that could be matched by an unrelated text occurrence. Pin the
      // markup to the .card-project element.
      const projectId = await createProject(app, { title: 'ZZZ-Board-Title-Project' });
      await createRelease(app, { projectId, title: 'Card Release', status: 'tbd' });

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
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
        status: 'tbd',
        plannedDate: '2025-06-15',
      });

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
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
        status: 'tbd',
      });
      attachPresentAssetToRelease(db, Number(projectId), Number(releaseId), { name: 'asset.txt' });

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
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
        status: 'tbd',
      });
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.upsert(Number(projectId), 'gone.txt', {
        filename: 'gone.txt', extension: 'txt', mimeType: 'text/plain', sizeBytes: 0, modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);
      db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)`).run(Number(releaseId), asset.id);

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      // Card with the missing release must contain the missing-indicator.
      expect(res.text).toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Missing-Card-Release[\s\S]*?<span class="missing-indicator"[^>]*>⚠\s*1<\/span>[\s\S]*?<\/div>/,
      );
    });

    it('board renders shared empty states for columns with no releases', async () => {
      // The previous test checked `toContain('No releases')` — that
      // string also appears in the list view's empty placeholder. Pin
      // the empty placeholder to the shared empty-state markup emitted
      // by each board column.
      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      const boardEmptyMatches = res.text.match(/<div class="empty-state">\s*<h4 class="empty-state-heading">No releases<\/h4>\s*<\/div>/g) || [];
      // Five columns × one "No releases" each = 5.
      expect(boardEmptyMatches.length).toBe(5);
    });

    it('board is read-only (no mutation controls)', async () => {
      const projectId = await createProject(app, { title: 'Board Read-Only Project' });
      await createRelease(app, { projectId, title: 'Read-Only Release', status: 'tbd' });

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      expect(res.text).not.toContain('action="/releases/');
      expect(res.text).not.toContain('method="post"');
    });

    it('board respects project filter (row-level)', async () => {
      // The previous test used `toContain('R1')` and `not.toContain('R2')`
      // — a generic letter+number match. Pin each release to its own
      // board-card element.
      const p1 = await createProject(app, { title: 'BP1 Filter' });
      const p2 = await createProject(app, { title: 'BP2 Filter' });
      await createRelease(app, { projectId: p1, title: 'ZZZ-P1-Card', status: 'tbd' });
      await createRelease(app, { projectId: p2, title: 'ZZZ-P2-Card', status: 'tbd' });

      const res = await app.testAgent.get(`/release-management?view=board&project=${p1}`).expect(200);
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
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get('/release-management?view=board').expect(200);
      expect(res.text).not.toMatch(
        /<div class="board-card"[^>]*>[\s\S]*?ZZZ-Board-Hidden-Archived-Parent[\s\S]*?<\/div>/,
      );
    });
  });

  describe('release calendar', () => {
    it('renders the calendar page with the calendar header structure', async () => {
      // A real assertion: the page must render the calendar nav (with
      // month header) AND the table of weekday headers. The previous
      // test only matched the "Calendar" page heading, which
      // would also be true on an error page that happens to render the
      // layout.
      const res = await app.testAgent.get('/calendar').expect(200);
      expect(res.text).toMatch(/<h1 class="app-section-title">Calendar<\/h1>/);
      // Calendar nav structure: a <div class="calendar-nav"> with the
      // month <h2> and prev/next buttons.
      expect(res.text).toMatch(/<div class="calendar-nav"[^>]*>[\s\S]*?<h2>\d{4}-\d{2}<\/h2>/);
      // Calendar grid structure: weekday header row (a real CSS Grid div
      // layout, not a <table> — see Phase 13.3 rewrite).
      expect(res.text).toMatch(/<div class="calendar-th"[^>]*>Mon<\/div>[\s\S]*?<div class="calendar-th"[^>]*>Sun<\/div>/);
    });

    it('renders navigation anchors (not just text)', async () => {
      // The previous test only checked `toContain('Previous')` and
      // `toContain('Next')`, which any unrelated link or label would
      // satisfy. The new test extracts the actual nav anchors.
      const res = await app.testAgent.get('/calendar').expect(200);
      // Prev/next anchors must exist as <a> elements, not as plain text.
      expect(extractCalendarNavHref(res.text, '← Previous')).not.toBeNull();
      expect(extractCalendarNavHref(res.text, 'Next →')).not.toBeNull();
    });

    it('uses explicit month from query (calendar header h2)', async () => {
      // Pin the rendered month to the exact query value via the <h2>
      // element, not the loose `toContain` that the previous test used.
      const res = await app.testAgent.get('/calendar?month=2025-06').expect(200);
      expect(extractCalendarHeaderMonth(res.text)).toBe('2025-06');
    });

    it('renders release entries on calendar days with status badge and time', async () => {
      const projectId = await createProject(app, { title: 'ZZZ-June-15-Calendar-Project', status: 'planned' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'ZZZ-June-15-Calendar-Release',
        plannedDate: '2025-06-15',
        plannedTime: '09:15',
      });

      const res = await app.testAgent.get('/calendar?month=2025-06').expect(200);
      expect(res.text).toMatch(/<div class="calendar-release"[^>]*>[\s\S]*?ZZZ-June-15-Calendar-Release[\s\S]*?<\/div>/);
      expect(res.text).toContain(`href="/releases/${releaseId}/edit"`);
      expect(res.text).toContain('09:15');
      expect(res.text).toMatch(/<span class="status-badge status-badge--neutral">Planned<\/span>/);
    });

    it('shows empty days without releases (calendar grid has 30 day cells for June)', async () => {
      const res = await app.testAgent.get('/calendar?month=2025-06').expect(200);
      // The grid emits one <div class="calendar-day" role="cell">…</div>
      // per day plus leading and trailing empty cells (with the additional
      // "empty-day" modifier) to fill the week. The previous test
      // only checked `toContain('15')`, which could be satisfied by
      // any digit string in the page.
      const allCellMatches = res.text.match(/<div class="calendar-day[^"]*" role="cell">/g) || [];
      // Padding cells carry the previous/next month's dimmed day number
      // (Phase 13.3) rather than being blank, so they now also carry the
      // "out-of-month" modifier.
      const emptyDayPadding = res.text.match(/<div class="calendar-day empty-day out-of-month" role="cell">/g) || [];
      const actualDayCells = allCellMatches.length - emptyDayPadding.length;
      // June has 30 days. The padding cells fill the week grid.
      expect(actualDayCells).toBe(30);
      // No release cards in any cell — the day is "empty".
      expect(res.text).not.toMatch(/<div class="calendar-release"/);
    });

    it('empty-state branch shows release-focused wording linking to /releases/new', () => {
      // getReleaseCalendar always returns one entry per calendar day (even
      // when every day is entry-less), so `days.length > 0` never goes
      // false through the live HTTP route — the empty-state branch only
      // renders when `days` itself is empty. Render the template directly
      // with that condition to verify the copy without inventing new
      // reachability behavior (out of scope for this correction).
      const html = renderTemplate('releases/calendar.njk', {
        appName: 'CreatorCrate',
        month: '2099-01',
        days: [],
        firstDayWeekday: 0,
        prevMonthDaysCount: 31,
        prevMonth: '2098-12',
        nextMonth: '2099-02',
        today: '2025-06-15',
        isCurrentMonth: false,
        query: {},
        pageUrl: () => '/calendar',
      });

      expect(html).toContain('No releases scheduled for 2099-01');
      expect(html).toContain('There are no releases scheduled for this month.');
      expect(html).toMatch(/href="\/releases\/new"[^>]*>New Release<\/a>/);

      expect(html).not.toContain('No projects scheduled');
      expect(html).not.toContain('There are no projects scheduled for this month.');
      expect(html).not.toMatch(/href="\/projects\/new"[^>]*>New Project<\/a>/);
    });

    it('does not show asset fields on calendar entries', async () => {
      const projectId = await createProject(app, { title: 'Calendar Asset Fields Project' });
      await createRelease(app, {
        projectId,
        title: 'Calendar Asset Fields Release',
        plannedDate: '2025-06-15',
      });

      const res = await app.testAgent.get('/calendar?month=2025-06').expect(200);
      expect(res.text).toContain('Calendar Asset Fields Release');
      expect(res.text).not.toContain('missing-indicator');
    });

    it('links release entries to the canonical release edit page', async () => {
      const projectId = await createProject(app, { title: 'Calendar Link Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Calendar Link Release',
        plannedDate: '2025-06-15',
      });

      const res = await app.testAgent.get('/calendar?month=2025-06').expect(200);
      expect(res.text).toMatch(new RegExp(`href="/releases/${releaseId}/edit">Calendar Link Release</a>`));
    });

    // ─── Exact-fallback assertions for invalid months ──────────────────
    //
    // The HTTP route does not accept a `today` option, so the test must
    // ground the expected fallback month in the application's local
    // "today" (the same value the service uses to compute the fallback).
    // The previous test only checked the page heading ("Calendar")
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
      const res = await app.testAgent
        .get(`/calendar?month=${encodeURIComponent(bad)}`)
        .expect(200);

      // The header <h2> must show the EXACT fallback month — not just
      // any YYYY-MM that happens to satisfy the format regex.
      expect(extractCalendarHeaderMonth(res.text)).toBe(expectedMonth);

      // The Previous nav link's href must point at exactly expectedPrev.
      const prevHref = extractCalendarNavHref(res.text, '← Previous');
      expect(prevHref).not.toBeNull();
      const prevUrl = new URL(prevHref, 'http://localhost');
      expect(prevUrl.pathname).toBe('/calendar');
      expect(prevUrl.searchParams.get('month')).toBe(expectedPrev);

      // The Next nav link's href must point at exactly expectedNext.
      const nextHref = extractCalendarNavHref(res.text, 'Next →');
      expect(nextHref).not.toBeNull();
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/calendar');
      expect(nextUrl.searchParams.get('month')).toBe(expectedNext);
    });

    it('calendar nav strips all list/board filters, page state, and unknown params', async () => {
      const noisyQuery = 'month=2025-06&unsupported=publishable&status=ready&project=1&schedule=overdue&page=3&pageSize=10&sort=title&order=asc&includeArchived=1&junk=x';
      const res = await app.testAgent.get(`/calendar?${noisyQuery}`).expect(200);

      const prevHref = extractCalendarNavHref(res.text, '← Previous');
      const nextHref = extractCalendarNavHref(res.text, 'Next →');
      expect(prevHref).not.toBeNull();
      expect(nextHref).not.toBeNull();

      const prevUrl = new URL(prevHref, 'http://localhost');
      const nextUrl = new URL(nextHref, 'http://localhost');

      // Previous link: pathname, exactly one key (month), exact value
      expect(prevUrl.pathname).toBe('/calendar');
      expect([...prevUrl.searchParams.keys()]).toEqual(['month']);
      expect(prevUrl.searchParams.get('month')).toBe('2025-05');

      // Next link: pathname, exactly one key (month), exact value
      expect(nextUrl.pathname).toBe('/calendar');
      expect([...nextUrl.searchParams.keys()]).toEqual(['month']);
      expect(nextUrl.searchParams.get('month')).toBe('2025-07');
    });

    it('calendar excludes archived releases', async () => {
      const projectId = await createProject(app, { title: 'Calendar Archive Project' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Hidden From Calendar',
        plannedDate: '2025-06-15',
      });

      const before = await app.testAgent.get('/calendar?month=2025-06').expect(200);
      expect(before.text).toContain('Hidden From Calendar');

      await app.testAgent.post(`/releases/${releaseId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get('/calendar?month=2025-06').expect(200);
      expect(res.text).not.toContain('Hidden From Calendar');
    });

    it('has navigation links to list and board', async () => {
      const res = await app.testAgent.get('/calendar').expect(200);
      expect(res.text).toContain('href="/release-management"');
      expect(res.text).toContain('href="/release-management?view=board"');
    });

    // ─── Calendar navigation year boundaries ───────────────────────────
    //
    // At the lower year boundary (1000-01), the previous link would step
    // to the unsupported "999-12" — the template must NOT render an anchor
    // for that. At the upper boundary (9999-12), the next link would step
    // to the unsupported "10000-01" — also forbidden. For in-range months,
    // both links remain.

    it('lower boundary (1000-01) has no Previous anchor (only a disabled span)', async () => {
      const res = await app.testAgent.get('/calendar?month=1000-01').expect(200);
      // The rendered header must show exactly 1000-01.
      expect(extractCalendarHeaderMonth(res.text)).toBe('1000-01');
      // No anchor for the previous month (which would be 0999-12). Use
      // the strict anchor extractor — must return null.
      expect(extractCalendarNavHref(res.text, '← Previous')).toBeNull();
      // The disabled span is still present to keep the layout stable.
      expect(res.text).toMatch(/<span class="button" aria-disabled="true">← Previous<\/span>/);
      // The Next anchor IS present (1000-02) and points to the right URL.
      const nextHref = extractCalendarNavHref(res.text, 'Next →');
      expect(nextHref).not.toBeNull();
      const nextUrl = new URL(nextHref, 'http://localhost');
      expect(nextUrl.pathname).toBe('/calendar');
      expect(nextUrl.searchParams.get('month')).toBe('1000-02');
    });

    it('upper boundary (9999-12) has no Next anchor (only a disabled span)', async () => {
      const res = await app.testAgent.get('/calendar?month=9999-12').expect(200);
      expect(extractCalendarHeaderMonth(res.text)).toBe('9999-12');
      // No anchor for the next month (which would be 10000-01).
      expect(extractCalendarNavHref(res.text, 'Next →')).toBeNull();
      // The disabled span is still present.
      expect(res.text).toMatch(/<span class="button" aria-disabled="true">Next →<\/span>/);
      // The Previous anchor IS present (9999-11).
      const prevHref = extractCalendarNavHref(res.text, '← Previous');
      expect(prevHref).not.toBeNull();
      const prevUrl = new URL(prevHref, 'http://localhost');
      expect(prevUrl.pathname).toBe('/calendar');
      expect(prevUrl.searchParams.get('month')).toBe('9999-11');
    });

    it('in-range months retain both Previous and Next links with exact month= values', async () => {
      const res = await app.testAgent.get('/calendar?month=2025-06').expect(200);
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
      const lowRes = await app.testAgent.get('/calendar?month=1000-02').expect(200);
      expect(extractCalendarHeaderMonth(lowRes.text)).toBe('1000-02');
      const lowPrev = new URL(extractCalendarNavHref(lowRes.text, '← Previous'), 'http://localhost');
      const lowNext = new URL(extractCalendarNavHref(lowRes.text, 'Next →'), 'http://localhost');
      expect(lowPrev.searchParams.get('month')).toBe('1000-01');
      expect(lowNext.searchParams.get('month')).toBe('1000-03');

      // 9999-11 — just below the upper boundary.
      const highRes = await app.testAgent.get('/calendar?month=9999-11').expect(200);
      expect(extractCalendarHeaderMonth(highRes.text)).toBe('9999-11');
      const highPrev = new URL(extractCalendarNavHref(highRes.text, '← Previous'), 'http://localhost');
      const highNext = new URL(extractCalendarNavHref(highRes.text, 'Next →'), 'http://localhost');
      expect(highPrev.searchParams.get('month')).toBe('9999-10');
      expect(highNext.searchParams.get('month')).toBe('9999-12');
    });
  });

  // ─── Phase 2D: /releases/calendar compatibility redirect ──────────────────

  describe('/releases/calendar compatibility redirect', () => {
    it('redirects to /calendar', async () => {
      const res = await app.testAgent.get('/releases/calendar');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/calendar');
    });

    it('preserves the month query parameter', async () => {
      const res = await app.testAgent.get('/releases/calendar?month=2025-06');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/calendar?month=2025-06');
    });

    it('preserves additional/unknown query parameters', async () => {
      const res = await app.testAgent.get('/releases/calendar?month=2025-06&foo=bar');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/calendar?month=2025-06&foo=bar');
    });

    it('does not loop — the redirect target renders 200 directly', async () => {
      const redirectRes = await app.testAgent.get('/releases/calendar?month=2025-06');
      const target = redirectRes.headers.location;
      const finalRes = await app.testAgent.get(target).expect(200);
      expect(finalRes.text).toMatch(/<h1 class="app-section-title">Calendar<\/h1>/);
    });

    it('POST is not supported (falls through to the 404 handler)', async () => {
      await app.testAgent.post('/releases/calendar').send({ _csrf: app.testCsrfToken }).expect(404);
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

      const res = await app.testAgent.get(`/releases/${releaseId}`).expect(200);
      expect(res.text).toContain('Detail Regression Release');
    });

    it('release create form still renders', async () => {
      const projectId = await createProject(app, { title: 'Create Regression' });
      const res = await app.testAgent.get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(res.text).toContain('Create');
    });

    it('release edit form still renders', async () => {
      const projectId = await createProject(app, { title: 'Edit Regression' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Edit Regression Release',
        status: 'tbd',
      });

      const res = await app.testAgent.get(`/releases/${releaseId}/edit`).expect(200);
      expect(res.text).toContain('Edit');
    });

    it('release mutation still works (archive)', async () => {
      const projectId = await createProject(app, { title: 'Mutation Regression' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Mutation Regression Release',
        status: 'tbd',
      });

      await app.testAgent.post(`/releases/${releaseId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get(`/releases/${releaseId}`).expect(200);
      expect(res.text).toContain('Archived');
    });

    it('archived project mutations are rejected — release archive returns 422 and archived_at stays NULL', async () => {
      // 1. Create a project and a mutable release; retain its ID.
      const projectId = await createProject(app, { title: 'Archived Mutation Reject' });
      const releaseId = await createRelease(app, {
        projectId,
        title: 'Should Not Archive',
        status: 'tbd',
      });

      // 2. Archive the parent project.
      await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      // 3. POST the release archive endpoint — must be rejected.
      await app.testAgent
        .post(`/releases/${releaseId}/archive`)
        .send({ _csrf: app.testCsrfToken })
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
      const projectDir = getProjectDir(projectsRoot, projectId, title);
      expect(projectDir).not.toBeNull();
      fs.writeFileSync(path.join(projectDir, 'asset.txt'), 'content');
      return projectId;
    }

    /**
     * Create a release and link an asset to it.
     */
    async function createReleaseWithLinkedAsset(projectId, title) {
      const releaseId = await createRelease(app, { projectId, title, status: 'tbd' });
      // Scan to create the asset record
      await app.testAgent.post(`/projects/${projectId}/scan`).send({ _csrf: app.testCsrfToken }).expect(302);
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(projectId);
      expect(assets.length).toBeGreaterThan(0);
      const asset = assets[0];
      // Link via POST
      await app.testAgent
        .post(`/releases/${releaseId}/assets`)
        .send(`selectedAssetIds=${asset.id}`)
        .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { releaseId, assetId: asset.id };
    }

    // ─── Fix 1: Block scanning for archived projects ─────────────────

    describe('block scanning for archived projects', () => {
      it('archived project asset page contains no scan form or submit button', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Scan Hide' });
        // Archive the project
        await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

        const res = await app.testAgent.get(`/projects/${projectId}/assets`).expect(200);
        // The scan form must not be rendered — assert the form markup is absent
        expect(res.text).not.toContain(`action="/projects/${projectId}/scan"`);
        expect(res.text).not.toMatch(/<button[^>]*>\s*Scan Now\s*<\/button>/);
        // The empty-state "Scan Now" text (inside a <strong>) must not be confused
        // with the button — the button is absent, but the placeholder text may still
        // contain "Scan Now" for non-archived projects. For archived projects the
        // placeholder says "This archived project has no assets on record."
        // No "Scan Now" action should appear for archived projects
        expect(res.text).not.toContain('>Scan Now<');
      });

      it('active project contains the actual scan form and submit button', async () => {
        const projectId = await createProjectWithFile({ title: 'Active Scan Show' });

        const res = await app.testAgent.get(`/projects/${projectId}/assets`).expect(200);
        // Assert the form element with the correct action
        expect(res.text).toContain(`<form method="post" action="/projects/${projectId}/scan" class="inline-form">`);
        // Assert the submit button inside the form
        expect(res.text).toMatch(/<button class="button button-primary" type="submit">Scan Now<\/button>/);
        // Scanning is POST-only; the empty state intentionally has no GET link.
        expect(res.text).not.toContain('Scan Now</a>');
      });

      it('POST scan for archived project is rejected', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Scan Reject' });
        // Archive the project
        await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

        await app.testAgent
          .post(`/projects/${projectId}/scan`)
          .send({ _csrf: app.testCsrfToken })
          .expect(302)
          .expect('Location', `/projects/${projectId}/assets?category=all&scan_error=archived`);
      });

      it('archived scan rejection causes no asset changes (full row snapshot)', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Scan Snapshot' });
        const projectDir = getProjectDir(projectsRoot, projectId, 'Archived Scan Snapshot');
        expect(projectDir).not.toBeNull();

        // Establish baseline: scan the initial file
        await app.testAgent.post(`/projects/${projectId}/scan`).send({ _csrf: app.testCsrfToken }).expect(302);

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
        await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

        // Attempt scan — must be rejected
        await app.testAgent
          .post(`/projects/${projectId}/scan`)
          .send({ _csrf: app.testCsrfToken })
          .expect(302)
          .expect('Location', `/projects/${projectId}/assets?category=all&scan_error=archived`);

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

        const res = await app.testAgent.get(`/projects/${projectId}/assets`).expect(200);
        // The usage link should point to the release detail, not the asset-selection page
        const expectedHref = `/releases/${releaseId}`;
        expect(res.text).toContain(`href="${expectedHref}"`);
        expect(res.text).not.toContain(`href="${expectedHref}/assets"`);
      });
    });

    // ─── Fix 4: Archived release asset-selection UI read-only ─────────

    describe('archived release asset-selection UI read-only', () => {
      it('archived release under active project has no checkboxes and no Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Release UI' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived UI Release');

        // Archive the release
        await app.testAgent.post(`/releases/${releaseId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

        const res = await app.testAgent.get(`/releases/${releaseId}/assets`).expect(200);
        // No bulk-selection checkboxes (form is structurally omitted for read-only)
        expect(res.text).not.toContain('type="checkbox"');
        // No role selects from the legacy form
        expect(res.text).not.toContain('class="asset-role"');
        // No sort-order inputs from the legacy form
        expect(res.text).not.toContain('class="asset-sort-order"');
        // Should show the archived notice
        expect(res.text).toContain('This release is archived');
        // Save Selection must be absent
        expect(res.text).not.toContain('Save Selection');
      });

      it('archived release under active project has no Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived No Save' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived No Save Release');

        // Archive the release
        await app.testAgent.post(`/releases/${releaseId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

        const res = await app.testAgent.get(`/releases/${releaseId}/assets`).expect(200);
        expect(res.text).not.toContain('Save Selection');
      });

      it('active release under active project has enabled checkboxes and Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Active Release Editable' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Active Editable Release');

        const res = await app.testAgent.get(`/releases/${releaseId}/assets`).expect(200);
        // Checkboxes present and not disabled
        expect(res.text).toContain('type="checkbox"');
        expect(res.text).not.toMatch(/type="checkbox"[^>]*disabled/);
        // Save Selection button present and enabled
        expect(res.text).toContain('Save Selection');
        expect(res.text).toMatch(/<button class="button button-primary" type="submit">Save Selection<\/button>/);
      });

      it('archived parent project has no checkboxes and no Save Selection', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived Parent UI' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived Parent Release');

        // Archive the PARENT project (not the release)
        await app.testAgent.post(`/projects/${projectId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

        const res = await app.testAgent.get(`/releases/${releaseId}/assets`).expect(200);
        // No bulk-selection checkboxes (form is structurally omitted for read-only)
        expect(res.text).not.toContain('type="checkbox"');
        // Should show the parent-archived notice
        expect(res.text).toContain('parent project is archived');
        // Save Selection must be absent
        expect(res.text).not.toContain('Save Selection');
      });

      it('direct POST for archived release remains rejected', async () => {
        const projectId = await createProjectWithFile({ title: 'Archived POST Reject' });
        const { releaseId } = await createReleaseWithLinkedAsset(projectId, 'Archived POST Reject Release');

        // Archive the release
        await app.testAgent.post(`/releases/${releaseId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

        // Attempt to POST asset selection
        await app.testAgent
          .post(`/releases/${releaseId}/assets`)
          .send('selectedAssetIds=99999')
          .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);
      });
    });

    // ─── Fix 5: Asset-browser pagination whitelist ────────────────────

    describe('asset-browser pagination whitelist', () => {
      it('pagination URLs contain only canonical browser params — no junk or defaults', async () => {
        // Create enough assets for multiple pages
        const projectId = await createProjectWithFile({ title: 'Pagination Whitelist' });
        const projectDir = getProjectDir(projectsRoot, projectId, 'Pagination Whitelist');
        for (let i = 0; i < 15; i++) {
          fs.writeFileSync(path.join(projectDir, `page_${i}.txt`), 'content');
        }
        await app.testAgent.post(`/projects/${projectId}/scan`).send({ _csrf: app.testCsrfToken }).expect(302);

        // Request with valid filters plus junk=x
        const res = await app.testAgent
          .get(`/projects/${projectId}/assets?presence=present&usage=all&pageSize=10&junk=x`)
          .expect(200);

        // Extract the Next link
        const nextHref = extractPaginationHref(res.text, 'Next');
        expect(nextHref).not.toBeNull();
        const nextUrl = new URL(nextHref, 'http://localhost');

        // Pathname must be correct
        expect(nextUrl.pathname).toBe(`/projects/${projectId}/assets`);

        // Only non-default canonical params must be present.
        expect(nextUrl.searchParams.get('presence')).toBe('present');
        expect(nextUrl.searchParams.has('usage')).toBe(false);
        expect(nextUrl.searchParams.get('pageSize')).toBe('10');
        expect(nextUrl.searchParams.get('page')).toBe('2');

        // Exactly 3 search params — default usage=all and junk are both omitted.
        expect(nextUrl.searchParams.size).toBe(3);
        expect(nextUrl.searchParams.has('junk')).toBe(false);
      });
    });
  });

});
