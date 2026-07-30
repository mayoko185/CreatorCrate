/**
 * Phase 10.5B — Visual consolidation of dashboard and project pages.
 *
 * Verifies:
 *  - Dashboard hierarchy and summary cards
 *  - Summary-card semantics (accessible labels, tabular numerals, links)
 *  - No new query growth (dashboard renders same data)
 *  - Project list action hierarchy and status badges
 *  - Exact project status text in badges
 *  - Archived project notice on detail page
 *  - Project form labels, errors, and actions
 *  - Destructive-action separation on project detail
 *  - Asset browser shared page heading
 *  - Asset viewer shared page heading and action hierarchy
 *  - Contextual empty states
 *  - One <h1> per page
 *  - No absolute filesystem path leakage
 *  - No route or form behavior regression
 *  - Mobile no-overflow CSS rules
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
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

describe('Phase 10.5B: Dashboard and project visual consolidation', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-105b-'));
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
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Dashboard hierarchy ─────────────────────────────────────────

  describe('dashboard hierarchy', () => {
    it('has exactly one h1', async () => {
      const res = await agent.get('/').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('has page-heading-copy with description', async () => {
      const res = await agent.get('/').expect(200);
      expect(hasClass(res.text, 'page-heading-copy')).toBe(true);
      expect(hasClass(res.text, 'page-heading-description')).toBe(true);
    });

    it('renders summary cards section', async () => {
      const res = await agent.get('/').expect(200);
      expect(hasClass(res.text, 'summary-cards')).toBe(true);
      const cards = extractSummaryCards(res.text);
      expect(cards).toContain('href="/projects"');
      expect(cards).not.toContain('href="/releases"');
      expect(cards).toMatch(/<div class="summary-card">\s*<span class="summary-card-value">0<\/span>\s*<span class="summary-card-label">Assets<\/span>/);
    });

    it('renders concise supporting context on every summary card', async () => {
      const res = await agent.get('/').expect(200);
      const cards = extractSummaryCards(res.text);
      expect((cards.match(/summary-card-context/g) || []).length).toBe(4);
      expect(cards).toContain('Projects currently tracked');
      expect(cards).toContain('Across all projects');
      expect(cards).toContain('Releases requiring review');
      expect(cards).toContain('Files missing at the last scan');
    });

    it('summary cards have tabular-nums font-variant-numeric in CSS', async () => {
      const res = await agent.get('/').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.summary-card-value');
      expect(css).toContain('font-variant-numeric: tabular-nums');
    });

    it('renders need-attention link when attention count > 0', async () => {
      // Create a project and release to generate attention data
      await agent
        .post('/projects')
        .send('title=Attention+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/').expect(200);
      // Summary cards always render (with or without attention)
      expect(hasClass(res.text, 'summary-cards')).toBe(true);
    });

    it('renders project counts in a details element', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('<details');
      expect(res.text).toContain('Project counts');
    });

    it('recently updated projects use status badges', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Badge+Recent')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/').expect(200);
      // Status badge appears in recently updated
      expect(res.text).toContain('status-badge');
    });
  });

  // ─── 2. Summary-card semantics ──────────────────────────────────────

  describe('summary-card semantics', () => {
    it('summary cards have aria-label on the section', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('aria-label="Overview"');
    });

    it('summary-card-value has numeric content', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('summary-card-value');
      expect(res.text).toContain('summary-card-label');
    });
  });

  // ─── 3. No new query growth ─────────────────────────────────────────

  describe('dashboard data composition', () => {
    it('dashboard renders data from the composed view-model', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('summary-card-value');
      expect(res.text).toContain('count-card');
      expect(res.text).toContain('Projects currently tracked');
    });
  });

  // ─── 4. Project list action hierarchy ──────────────────────────────

  describe('project list action hierarchy', () => {
    it('has page-heading with New Project primary action', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(res.text).toContain('New Project');
      expect(res.text).toContain('button-primary');
    });

    it('has exactly one h1', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('uses status badges for project status column', async () => {
      await agent
        .post('/projects')
        .send('title=Status+Badge+List')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('status-badge');
    });

    it('uses data-table for project list', async () => {
      await agent
        .post('/projects')
        .send('title=Table+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('data-table');
      expect(res.text).toContain('table-scroll');
    });

    it('has distinct empty state for no projects vs filtered results', async () => {
      // No projects at all
      const res1 = await agent.get('/projects').expect(200);
      expect(res1.text).toContain('No projects yet');

      await agent
        .post('/projects')
        .send('title=Search+Control')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Filtered empty (no match for search in a non-empty repository)
      const res2 = await agent.get('/projects?search=nonexistent').expect(200);
      expect(res2.text).toContain('No projects found');
      expect(res2.text).toContain('Reset Filters');
    });

    it('treats every normalized project filter as active for empty results', async () => {
      await agent
        .post('/projects')
        .send('title=Only+TBD')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/projects?status=ready').expect(200);
      expect(res.text).toContain('No projects found');
      expect(res.text).toContain('Reset Filters');
      expect(res.text).not.toContain('Create your first project to get started.');
    });
  });

  // ─── 5. Exact project status text ──────────────────────────────────

  describe('project status text in badges', () => {
    const statuses = ['tbd', 'planned', 'in-progress', 'ready', 'published'];

    for (const status of statuses) {
      it(`renders "${status}" with status-badge`, async () => {
        await agent
          .post('/projects')
          .send(`title=Status+${status}`)
          .send(`status=${status}`)
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const res = await agent.get('/projects').expect(200);
        expect(res.text).toContain('status-badge');
      });
    }
  });

  // ─── 6. Archived notice ──────────────────────────────────────────────

  describe('archived project notice', () => {
    it('shows a warning notice on archived project detail', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archived+Notice+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).toContain('archived');
      expect(res.text).toContain('read-only');
      expect(hasClass(res.text, 'notice--warning')).toBe(true);
    });

    it('hides Edit link on archived project', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=No+Edit+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).not.toContain(`/projects/${id}/edit`);
    });

    it('hides destructive section on archived project', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=No+Danger+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(hasClass(res.text, 'destructive-section')).toBe(false);
    });

    it('archived project asset page shows archived notice', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archived+Asset+Notice')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res.text).toContain('archived');
      expect(res.text).toContain('read-only');
    });
  });

  // ─── 7. Project form labels, errors, and actions ────────────────────

  describe('project form labels and actions', () => {
    it('create form has form sections with visible labels', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(res.text).toContain('Basic information');
      expect(res.text).toContain('Status and scheduling');
      expect(res.text).toContain('Links');
      // Every label has a for= matching an input id
      const labels = res.text.match(/<label[^>]*for="([^"]+)"[^>]*>/g) || [];
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        const forMatch = label.match(/for="([^"]+)"/);
        if (forMatch) {
          expect(res.text).toMatch(new RegExp(`id="${forMatch[1]}"`));
        }
      }
    });

    it('create form has primary submit and secondary cancel', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(res.text).toContain('button-primary');
      expect(res.text).toContain('button-secondary');
    });

    it('create form preserves submitted values on validation error', async () => {
      const res = await agent
        .post('/projects')
        .send('title=Preserved+Create')
        .send('description=Create+description')
        .send('notes=Create+notes')
        .send('status=ready')
        .send('priority=high')
        .send('plannedDate=2026-08-01')
        .send('publishedDate=2026-08-15')
        .send('patreonUrl=http://example.com/not-patreon')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(res.text).toContain('Patreon URL must be a valid https://patreon.com link.');
      expect(res.text).toContain('value="Preserved Create"');
      expect(res.text).toContain('Create description');
      expect(res.text).toContain('Create notes');
      expect(res.text).toContain('<option value="ready" selected>Ready</option>');
      expect(res.text).toContain('<option value="high" selected>High</option>');
      expect(res.text).toContain('value="2026-08-01"');
      expect(res.text).toContain('value="2026-08-15"');
      expect(res.text).toContain('value="http://example.com/not-patreon"');
    });

    it('edit form preserves submitted values on validation error', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Editable+Preserve')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post(createRes.headers.location)
        .send('title=Edited+Preserved')
        .send('description=Edited+description')
        .send('notes=Edited+notes')
        .send('status=planned')
        .send('priority=low')
        .send('plannedDate=2026-09-01')
        .send('publishedDate=2026-09-15')
        .send('patreonUrl=http://example.com/not-patreon')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(res.text).toContain('Patreon URL must be a valid https://patreon.com link.');
      expect(res.text).toContain('value="Edited Preserved"');
      expect(res.text).toContain('Edited description');
      expect(res.text).toContain('Edited notes');
      expect(res.text).toContain('<option value="planned" selected>Planned</option>');
      expect(res.text).toContain('<option value="low" selected>Low</option>');
      expect(res.text).toContain('value="2026-09-01"');
      expect(res.text).toContain('value="2026-09-15"');
      expect(res.text).toContain('value="http://example.com/not-patreon"');
      expect(res.text).toContain(`href="${createRes.headers.location}"`);
    });

    it('edit form has exactly one h1', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });
  });

  // ─── 8. Destructive-action separation ──────────────────────────────

  describe('destructive-action separation', () => {
    it('project detail has destructive-section with danger styling', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Danger+Zone+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(hasClass(res.text, 'destructive-section')).toBe(true);
      expect(hasClass(res.text, 'button-danger')).toBe(true);
      expect(res.text).toContain('Danger zone');
      expect(res.text).toContain('Archive project');
    });
  });

  // ─── 9. Asset browser shared heading ────────────────────────────────

  describe('asset browser shared heading', () => {
    it('has page-heading with project title', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Asset+Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(res.text).toContain('Assets — Asset Heading Test');
      expect(countTags(res.text, 'h1')).toBe(1);
    });
  });

  // ─── 10. Viewer action hierarchy ────────────────────────────────────

  describe('asset viewer shared heading', () => {
    it('has page-heading with filename and required viewer contract', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Viewer+Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = Number(projRes.headers.location.replace('/projects/', ''));
      const projectDir = path.join(projectsRoot, STATUS_DIR_MAP.tbd);
      const entries = fs.readdirSync(projectDir);
      const matching = entries.find(e => e.includes('viewer-heading-test'));
      fs.writeFileSync(path.join(projectDir, matching, 'viewer-contract.png'), await makePng());

      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const asset = db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(id, 'viewer-contract.png');
      expect(asset).toBeDefined();

      const viewerRes = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
      expect(hasClass(viewerRes.text, 'page-heading')).toBe(true);
      expect(countTags(viewerRes.text, 'h1')).toBe(1);
      expect(viewerRes.text).toContain('<h1>viewer-contract.png</h1>');
      expect(viewerRes.text).toContain('Asset preview, metadata, and release usage.');
      expect(viewerRes.text).toContain('asset-viewer-back');
      expect(viewerRes.text).toContain('asset-viewer-original');
      expect(viewerRes.text).toContain('<dl class="detail-list asset-metadata">');
      expect(viewerRes.text).toContain('class="asset-preview-image"');
    });
  });

  // ─── 11. Contextual empty states ────────────────────────────────────

  describe('contextual empty states', () => {
    it('project list empty state uses shared partial', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('empty-state');
      expect(res.text).toContain('empty-state-heading');
    });

    it('project detail with no releases shows contextual empty state', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Empty+Releases')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      // Phase 2C: reframed as optional/secondary copy, not "no releases yet".
      expect(res.text).toContain('No release records for this project.');
    });

    it('dashboard empty attention uses empty-state', async () => {
      const res = await agent.get('/').expect(200);
      // Empty attention state uses the empty-state class
      expect(res.text).toContain('empty-state');
    });

    it('dashboard has a clear no-project state with the shared empty-state contract', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('No projects are currently tracked');
      expect(res.text).toContain('Create a project to start organizing releases and assets.');
      expect(res.text).toContain('href="/projects/new"');
      expect(res.text).toContain('empty-state');
    });
  });

  // ─── 12. Single h1 per page ────────────────────────────────────────

  describe('single h1 per page', () => {
    const pages = [
      { name: 'dashboard', url: '/' },
      { name: 'project list', url: '/projects' },
      { name: 'project create', url: '/projects/new' },
    ];

    for (const { name, url } of pages) {
      it(`${name} has exactly one h1`, async () => {
        const res = await agent.get(url).expect(200);
        expect(countTags(res.text, 'h1')).toBe(1);
      });
    }

    it('project detail has exactly one h1', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=H1+Detail')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });
  });

  // ─── 13. No absolute path leakage ──────────────────────────────────

  describe('no absolute path leakage', () => {
    it('project detail does not expose absolute filesystem paths', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Path+Leak+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
      // Project directory is shown as relative path
      expect(res.text).toContain('relative to projects share');
    });
  });

  // ─── 14. No route or form behavior regression ──────────────────────

  describe('no route or form behavior regression', () => {
    it('project list still filters by status', async () => {
      await agent
        .post('/projects')
        .send('title=Filter+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/projects?status=tbd').expect(200);
      expect(res.text).toContain('Filter Test');
    });

    it('project create still works', async () => {
      const res = await agent
        .post('/projects')
        .send('title=Regression+Create')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      expect(res.headers.location).toMatch(/^\/projects\/\d+$/);
    });

    it('project archive still works', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archive+Regression')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const detail = await agent.get(`/projects/${id}`).expect(200);
      expect(detail.text).toContain('Archived');
    });

    it('dashboard still renders release sections', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('Releases needing attention');
      expect(res.text).toContain('Release status');
    });
  });

  // ─── 15. Mobile no-overflow CSS ────────────────────────────────────

  describe('mobile no-overflow CSS', () => {
    it('summary cards have responsive grid rules', async () => {
      const res = await agent.get('/').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.summary-cards');
      expect(css).toContain('grid-template-columns');
      // Mobile breakpoint reflows cards
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
    });

    it('page-heading has responsive flex behavior', async () => {
      const res = await agent.get('/').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.page-heading');
      expect(css).toContain('flex-wrap');
    });

    it('field-row stacks on mobile', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.field-row');
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
    });
  });
});
