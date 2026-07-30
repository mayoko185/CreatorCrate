/**
 * HTTP-level tests for the Phase 6B dashboard composition.
 *
 * Moved out of workflow-http.test.js to give the dashboard sections a
 * durable, focused test owner. Organizational move only — behavior and
 * assertions are unchanged from their prior home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const STYLESHEET_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const SERVED_CSS = fs.readFileSync(STYLESHEET_PATH, 'utf8');

function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

function hasClass(html, className) {
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  return re.test(html);
}

/** Return the served local stylesheet linked by the rendered page. */
function extractStyle(html) {
  expect(html).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
  return SERVED_CSS;
}

function extractSummaryCards(html) {
  const m = html.match(/<section class="summary-cards"[\s\S]*?<\/section>/);
  return m ? m[0] : '';
}

function getProjectDir(projectsRoot, title, status = 'tbd') {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const statusDir = STATUS_DIR_MAP[status];
  const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
  const matching = entries.filter((e) => e.endsWith(`-${slug}`));
  if (matching.length === 0) return null;
  return path.join(projectsRoot, statusDir, matching[0]);
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

async function createRelease(app, { projectId, title, status = 'idea', plannedDate = null }) {
  const body = [`projectId=${projectId}`, `title=${encodeURIComponent(title)}`, `status=${status}`];
  if (plannedDate) body.push(`plannedDate=${plannedDate}`);
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

describe('Phase 6B HTTP dashboard', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-6b-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const { agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot);
    app.testAgent = agent;
    app.testCsrfToken = csrfToken;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Dashboard: actionable sections ────────────────────────────────

  describe('dashboard actionable sections', () => {
    it('renders the "Releases needing attention" section heading', async () => {
      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).toContain('Missing selected assets (1)');
      expect(res.text).toContain('Has Missing Asset');
      expect(res.text).toContain('1 missing');
    });

    it('shows the "all good" placeholder when no attention is needed', async () => {
      const res = await app.testAgent.get('/').expect(200);
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
      await app.testAgent.post(`/releases/${releaseId}/archive`).send({ _csrf: app.testCsrfToken }).expect(302);

      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).not.toContain('Archived Overdue');
    });
  });

  // ─── Dashboard: upcoming releases grouped by date ─────────────────

  describe('dashboard upcoming releases', () => {
    it('shows the upcoming releases section', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).toContain('Upcoming releases');
    });

    it('shows the empty-state placeholder when no upcoming releases exist', async () => {
      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
      // The default upcoming limit is 10, so we expect at most 10 release
      // links in the upcoming section.
      const upcomingMatches = res.text.match(/href="\/releases\/\d+"[^>]*>U\d+/g) || [];
      expect(upcomingMatches.length).toBeLessThanOrEqual(10);
    });
  });

  // ─── Dashboard: workflow summary ───────────────────────────────────

  describe('dashboard workflow summary', () => {
    it('renders the workflow summary section', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).toContain('Release status');
    });

    it('shows total projects, total assets, and missing assets', async () => {
      await createProject(app, { title: 'Counted' });

      const res = await app.testAgent.get('/').expect(200);
      // Summary cards show Projects and Assets labels with values
      expect(res.text).toContain('Projects');
      expect(res.text).toContain('Assets');
      expect(res.text).toContain('Missing assets');
    });

    it('shows release status counts (idea, planned, drafting, ready, published, cancelled)', async () => {
      const res = await app.testAgent.get('/').expect(200);
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
      const res = await app.testAgent.get('/').expect(200);
      // Project counts are inside a <details> element
      expect(res.text).toContain('<details class="project-counts-details">');
      expect(res.text).toContain('Project counts');
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

      const res = await app.testAgent.get('/').expect(200);
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

      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).not.toContain('Missing selection (');
    });
  });

  // ─── Dashboard visual and structural contracts ─────────────────────
  //
  // Moved from phase-105b-consolidation.test.js — organizational move
  // only. Behavior and assertions are unchanged from their prior home.

  describe('dashboard visual and structural contracts', () => {
    describe('dashboard hierarchy', () => {
      it('has exactly one h1', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(countTags(res.text, 'h1')).toBe(1);
      });

      it('has page-heading-copy with description', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(hasClass(res.text, 'page-heading-copy')).toBe(true);
        expect(hasClass(res.text, 'page-heading-description')).toBe(true);
      });

      it('renders summary cards section', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(hasClass(res.text, 'summary-cards')).toBe(true);
        const cards = extractSummaryCards(res.text);
        expect(cards).toContain('href="/projects"');
        expect(cards).not.toContain('href="/releases"');
        expect(cards).toMatch(/<div class="summary-card">\s*<span class="summary-card-value">0<\/span>\s*<span class="summary-card-label">Assets<\/span>/);
      });

      it('renders concise supporting context on every summary card', async () => {
        const res = await app.testAgent.get('/').expect(200);
        const cards = extractSummaryCards(res.text);
        expect((cards.match(/summary-card-context/g) || []).length).toBe(4);
        expect(cards).toContain('Projects currently tracked');
        expect(cards).toContain('Across all projects');
        expect(cards).toContain('Releases requiring review');
        expect(cards).toContain('Files missing at the last scan');
      });

      it('summary cards have tabular-nums font-variant-numeric in CSS', async () => {
        const res = await app.testAgent.get('/').expect(200);
        const css = extractStyle(res.text);
        expect(css).toContain('.summary-card-value');
        expect(css).toContain('font-variant-numeric: tabular-nums');
      });

      it('renders need-attention link when attention count > 0', async () => {
        // Create a project and release to generate attention data
        await app.testAgent
          .post('/projects')
          .send('title=Attention+Test')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
          .expect(302);

        const res = await app.testAgent.get('/').expect(200);
        // Summary cards always render (with or without attention)
        expect(hasClass(res.text, 'summary-cards')).toBe(true);
      });

      it('renders project counts in a details element', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(res.text).toContain('<details');
        expect(res.text).toContain('Project counts');
      });

      it('recently updated projects use status badges', async () => {
        const projRes = await app.testAgent
          .post('/projects')
          .send('title=Badge+Recent')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(app.testCsrfToken))
          .expect(302);

        const res = await app.testAgent.get('/').expect(200);
        // Status badge appears in recently updated
        expect(res.text).toContain('status-badge');
      });
    });

    describe('summary-card semantics', () => {
      it('summary cards have aria-label on the section', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(res.text).toContain('aria-label="Overview"');
      });

      it('summary-card-value has numeric content', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(res.text).toContain('summary-card-value');
        expect(res.text).toContain('summary-card-label');
      });
    });

    describe('dashboard data composition', () => {
      it('dashboard renders data from the composed view-model', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(res.text).toContain('summary-card-value');
        expect(res.text).toContain('count-card');
        expect(res.text).toContain('Projects currently tracked');
      });
    });

    describe('contextual empty states', () => {
      it('dashboard has a clear no-project state with the shared empty-state contract', async () => {
        const res = await app.testAgent.get('/').expect(200);
        expect(res.text).toContain('No projects are currently tracked');
        expect(res.text).toContain('Create a project to start organizing releases and assets.');
        expect(res.text).toContain('href="/projects/new"');
        expect(res.text).toContain('empty-state');
      });
    });
  });
});
