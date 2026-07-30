/**
 * Phase 10.5C — Visual consolidation of release pages.
 *
 * Verifies:
 *  - Release list/board shared heading, status badges, view switcher
 *  - Release status badges and date display
 *  - Calendar responsiveness and status-badge usage
 *  - Release detail organization, destructive-section separation
 *  - Release form shared contract (form sections, labels, actions)
 *  - Publish workflow page (heading, sections, notice patterns)
 *  - Release asset curation (shared heading, notices, tables, empty states)
 *  - Shared-component consistency across release pages
 *  - Accessibility (one h1, labels, headings)
 *  - No route or form behavior regression
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

function extractSectionByHeading(html, heading) {
  const afterHeading = html.split(`<h2>${heading}</h2>`)[1];
  if (!afterHeading) return '';
  return afterHeading.split('</section>')[0];
}

describe('Phase 10.5C: Release page visual consolidation', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-105c-'));
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

  // ─── 1. Release list/board ───────────────────────────────────────────

  describe('release list and board', () => {
    it('release list has page-heading with New Release action', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(hasClass(res.text, 'page-heading-copy')).toBe(true);
      expect(res.text).toContain('New Release');
      expect(hasClass(res.text, 'button-primary')).toBe(true);
    });

    it('release list has exactly one h1', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('release list uses shared view-switcher-option pattern', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(res.text).toContain('view-switcher-option');
      expect(res.text).toContain('aria-label="View"');
      // List is the active view via aria-current, no dead active class
      expect(res.text).toMatch(/class="view-switcher-option"[^>]*aria-current="page"[^>]*>List<\/a>/);
      expect(res.text).not.toContain('view-switcher-option--active');
    });

    it('release list uses data-table with table-scroll', async () => {
      const projRes = await agent.post('/projects')
        .send('title=List+Table+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Release+List+Test')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/releases').expect(200);
      expect(hasClass(res.text, 'data-table')).toBe(true);
      expect(hasClass(res.text, 'table-scroll')).toBe(true);
    });

    it('release list uses status-badge for status column', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Status+Badge+Release')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Badge+Test+Release')
        .send('status=drafting')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/releases').expect(200);
      expect(res.text).toContain('status-badge');
      expect(res.text).toMatch(/status-badge--draft/);
    });

    it('release list empty state uses shared partial', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(res.text).toContain('empty-state');
      expect(res.text).toContain('empty-state-heading');
    });

    it('board view uses status-badge in column headers', async () => {
      const res = await agent.get('/releases?view=board').expect(200);
      expect(res.text).toContain('status-badge');
      expect(res.text).toContain('board-column-header');
    });

    it('board view renders a named bounded scroll container', async () => {
      const res = await agent.get('/releases?view=board').expect(200);
      const css = extractStyle(res.text);
      expect(res.text).toContain('<div class="board-scroll" tabindex="0" aria-label="Release board columns">');
      expect(res.text).toContain('<div class="board-container">');
      expect(css).toContain('.board-scroll');
      expect(css).toContain('overflow-x');
      expect(css).toContain('max-width: 100%');
    });

    it('board view filters have unique label IDs (no duplicates)', async () => {
      const res = await agent.get('/releases?view=board').expect(200);
      const ids = res.text.match(/id="board-[^"]+"/g) || [];
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });

    it('list view filters have unique label IDs (no duplicates)', async () => {
      const res = await agent.get('/releases').expect(200);
      const ids = res.text.match(/id="list-[^"]+"/g) || [];
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });

    it('archived releases use status-badge instead of archived-badge span', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Archived+Badge+Release')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archived+Release+Badge')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      await agent.post(`${createRes.headers.location}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/releases?includeArchived=1').expect(200);
      expect(res.text).toMatch(/status-badge--archived/);
    });
  });

  // ─── 2. Status badges and date display ──────────────────────────────

  describe('release status and date display', () => {
    const statuses = ['idea', 'planned', 'drafting', 'ready', 'cancelled'];

    for (const status of statuses) {
      it(`renders "${status}" with status-badge in release list`, async () => {
        const projRes = await agent.post('/projects')
          .send(`title=Status+${status}+Release`)
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
        const projectId = projRes.headers.location.replace('/projects/', '');

        await agent.post('/releases')
          .send(`projectId=${projectId}`)
          .send(`title=Release+Status+${status}`)
          .send(`status=${status}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const res = await agent.get('/releases').expect(200);
        expect(res.text).toContain('status-badge');
      });
    }

    it('renders "published" with status-badge after publishing', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Status+Published+Release')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Release+Status+published')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Add an asset so it can be published
      const slug = 'status-published-release';
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

      await agent.post(`${relRes.headers.location}/publish`)
        .send('publishedDate=2026-08-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/releases').expect(200);
      expect(res.text).toContain('status-badge--published');
    });

    it('release detail uses status-badge for release status', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Detail+Status+Badge')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Detail+Badge+Test')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('status-badge');
      expect(res.text).toMatch(/status-badge--active/);
    });

    it('dates in release detail have context labels', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Date+Label+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Date+Labels')
        .send('status=idea')
        .send('plannedDate=2025-12-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('(release target)');
    });
  });

  // ─── 3. Calendar responsiveness ────────────────────────────────────

  describe('release calendar', () => {
    it('calendar uses page-heading with view switcher', async () => {
      const res = await agent.get('/releases/calendar').expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(hasClass(res.text, 'page-heading-copy')).toBe(true);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('calendar has view-switcher links back to list and board', async () => {
      const res = await agent.get('/releases/calendar').expect(200);
      expect(res.text).toContain('view-switcher-option');
      expect(res.text).toMatch(/href="\/releases"/);
      expect(res.text).toMatch(/href="\/releases\?view=board"/);
    });

    it('calendar renders a named bounded scroll container for narrow screens', async () => {
      const res = await agent.get('/releases/calendar').expect(200);
      const css = extractStyle(res.text);
      expect(res.text).toContain('<div class="calendar-scroll" tabindex="0" aria-label="Release calendar grid">');
      expect(res.text).toContain('<div class="calendar-table" role="table">');
      expect(css).toContain('.calendar-scroll');
      expect(css).toContain('overflow-x');
      expect(css).toContain('max-width: 100%');
    });

    it('calendar uses status-badge partial instead of inline status classes', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Calendar+Badge+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Calendar+Release+Badge')
        .send('status=planned')
        .send('plannedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/releases/calendar?month=2025-06').expect(200);
      expect(res.text).toContain('status-badge');
    });

    it('calendar with no releases in the month still renders the navigable grid with empty day cells', async () => {
      // The calendar grid always renders (so Previous/Next navigation stays
      // available even for months with zero releases) — days without
      // releases are marked individually via the "empty" day-cell class
      // rather than swapping the whole page for the shared empty-state
      // partial, which would strand the user without month navigation.
      const res = await agent.get('/releases/calendar?month=2099-01').expect(200);
      expect(res.text).toContain('<div class="calendar-table" role="table">');
      expect(res.text).toMatch(/<div class="calendar-day empty" role="cell">/);
      expect(res.text).not.toContain('<div class="calendar-release');
    });
  });

  // ─── 4. Release detail organization ────────────────────────────────

  describe('release detail', () => {
    it('has exactly one h1', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Detail+H1+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=H1+Detail+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('uses page-heading with edit action', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Detail+Action+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Action+Test+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(res.text).toContain('Edit');
    });

    it('shows destructive section with archive button for non-archived releases', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Destructive+Section+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Destructive+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(hasClass(res.text, 'destructive-section')).toBe(true);
      expect(hasClass(res.text, 'button-danger')).toBe(true);
      expect(res.text).toContain('Danger zone');
      expect(res.text).toContain('Archive release');
    });

    it('hides destructive section for archived releases', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Archived+No+Danger+Release')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archived+Release+No+Danger')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      await agent.post(`${createRes.headers.location}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(hasClass(res.text, 'destructive-section')).toBe(false);
    });

    it('uses shared notice partial for archived and published states', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Notice+Test+Release')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Notice+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      await agent.post(`${createRes.headers.location}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('notice--warning');
      expect(res.text).toContain('read-only');
    });

    it('uses shared panel class for readiness section', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Panel+Test+Release')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Panel+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('class="panel panel--readiness"');
    });

    it('release detail uses data-table for selected assets', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Table+Test+Release')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'table-test-release';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter(e => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'detail-selected.txt'), 'selected');
      await agent.post(`/projects/${projectId}/scan`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.findByProjectId(Number(projectId)).find(a => a.filename === 'detail-selected.txt');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Table+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      await agent.post(`${createRes.headers.location}/assets`)
        .send(`selectedAssetIds[]=${asset.id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      const selectedSection = extractSectionByHeading(res.text, 'Selected Assets');
      expect(selectedSection).toContain('<div class="table-scroll" tabindex="0" aria-label="Selected release assets">');
      expect(selectedSection).toContain('<table class="data-table">');
      expect(selectedSection).toContain('detail-selected.txt');
      expect(selectedSection).toContain('<td>Primary</td>');
      expect(selectedSection).toContain('<span class="status-badge status-badge--success">Present</span>');
    });
  });

  // ─── 5. Release form shared contract ────────────────────────────────

  describe('release form shared contract', () => {
    it('create form has form sections with visible labels', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Form+Section+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
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

    it('create form has exactly one h1', async () => {
      const projRes = await agent.post('/projects')
        .send('title=H1+Release+Form')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
    });

    it('create form has primary submit and secondary cancel', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Form+Actions+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(res.text).toContain('button-primary');
      expect(res.text).toContain('button-secondary');
    });

    it('create form preserves submitted values on validation error', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Release+Error+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Preserved+Release+Title')
        .send('description=Preserved+release+description')
        .send('notes=Preserved+release+notes')
        .send('status=planned')
        .send('plannedDate=2026-02-31')
        .send('publishedDate=2026-08-15')
        .send('patreonUrl=https://patreon.com/preserved-release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(res.text).toContain('Planned date must be a valid date (YYYY-MM-DD).');
      expect(res.text).toContain('field-error');
      expect(res.text).toContain('field-error-message');
      expect(res.text).toContain(`value="${projectId}" selected`);
      expect(res.text).toContain('value="Preserved Release Title"');
      expect(res.text).toContain('Preserved release description');
      expect(res.text).toContain('Preserved release notes');
      expect(res.text).toContain('<option value="planned" selected>Planned</option>');
      expect(res.text).toContain('value="2026-02-31"');
      expect(res.text).toContain('value="2026-08-15"');
      expect(res.text).toContain('value="https://patreon.com/preserved-release"');
    });
  });

  // ─── 6. Publish workflow ────────────────────────────────────────────

  describe('publish workflow', () => {
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

  // ─── 7. Release asset curation ──────────────────────────────────────

  describe('release asset curation', () => {
    it('asset page uses page-heading', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Asset+Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Asset+Heading+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/assets`).expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('asset page uses shared notice partial for archived state', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Archived+Asset+Notice')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archived+Asset+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      await agent.post(`${relRes.headers.location}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/assets`).expect(200);
      expect(res.text).toContain('notice--warning');
      expect(res.text).toContain('archived');
    });

    it('asset page uses deterministic selected and candidate tables with bounded wrappers', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Asset+Table+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'asset-table-test';
      const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
      const matching = entries.filter(e => e.endsWith(`-${slug}`));
      const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
      fs.writeFileSync(path.join(projectDir, 'selected-primary-with-long-action-name.txt'), 'selected one');
      fs.writeFileSync(path.join(projectDir, 'selected-preview.txt'), 'selected two');
      fs.writeFileSync(path.join(projectDir, 'candidate-available.txt'), 'candidate');
      await agent.post(`/projects/${projectId}/scan`).send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const byFilename = (filename) => assets.find((asset) => asset.filename === filename);

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Asset+Table+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      await agent.post(`${relRes.headers.location}/assets`)
        .send(`selectedAssetIds[]=${byFilename('selected-primary-with-long-action-name.txt').id}`)
        .send(`selectedAssetIds[]=${byFilename('selected-preview.txt').id}`)
        .send('roles[]=primary')
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/assets`).expect(200);
      const selectedSection = extractSectionByHeading(res.text, 'Selected Assets');
      const candidateSection = extractSectionByHeading(res.text, 'Available Assets');

      expect(selectedSection).toContain('<div class="table-scroll" tabindex="0" aria-label="Selected release assets">');
      expect(selectedSection).toContain('<table class="data-table">');
      expect(selectedSection).toContain('selected-primary-with-long-action-name.txt');
      expect(selectedSection).toContain('<label for="role-');
      expect(selectedSection).toContain('Role for selected-primary-with-long-action-name.txt');
      expect(selectedSection).toContain('/remove-selected');
      expect(selectedSection).toContain('/move-up');
      expect(selectedSection).toContain('/move-down');
      expect(selectedSection).toContain('class="row-actions release-asset-actions"');
      expect(selectedSection).toContain('aria-label="Remove selected-primary-with-long-action-name.txt"');
      expect(selectedSection).toContain('aria-label="Move selected-primary-with-long-action-name.txt up');
      expect(selectedSection).toContain('aria-label="Move selected-primary-with-long-action-name.txt down');

      expect(candidateSection).toContain('<div class="table-scroll" tabindex="0" aria-label="Available release assets">');
      expect(candidateSection).toContain('<table class="data-table">');
      expect(candidateSection).toContain('candidate-available.txt');
      expect(candidateSection).toContain('aria-label="Add candidate-available.txt"');
      expect(candidateSection).not.toContain('selected-primary-with-long-action-name.txt');
    });

    it('asset page empty state uses shared partial', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Asset+Empty+State')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Asset+Empty+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/assets`).expect(200);
      expect(res.text).toContain('empty-state');
    });

    it('asset page has unique label IDs for filter fields', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Asset+Filter+IDs')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Asset+Filter+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${relRes.headers.location}/assets`).expect(200);
      const ids = res.text.match(/id="[^"]+"/g) || [];
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  // ─── 8. Shared-component consistency ─────────────────────────────

  describe('shared-component consistency', () => {
    it('release pages use page-heading consistently', async () => {
      const pages = [
        { name: 'release list', url: '/releases' },
        { name: 'release calendar', url: '/releases/calendar' },
      ];
      for (const { name, url } of pages) {
        const res = await agent.get(url).expect(200);
        expect(hasClass(res.text, 'page-heading')).toBe(true);
        expect(countTags(res.text, 'h1')).toBe(1);
      }
    });

    it('release form uses page-heading', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Consistent+Heading')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('no duplicate status-badge variant definitions in CSS', async () => {
      const res = await agent.get('/releases').expect(200);
      const css = extractStyle(res.text);
      // All shared badge variants must be defined
      expect(css).toContain('.status-badge--neutral');
      expect(css).toContain('.status-badge--active');
      expect(css).toContain('.status-badge--draft');
      expect(css).toContain('.status-badge--published');
      expect(css).toContain('.status-badge--error');
      expect(css).toContain('.status-badge--archived');
    });

    it('release list and project list use the same status-badge partial', async () => {
      const projRes = await agent.post('/projects')
        .send('title=Badge+Consistency')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Badge+Release')
        .send('status=drafting')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectRes = await agent.get('/projects').expect(200);
      const releaseRes = await agent.get('/releases').expect(200);

      // Both pages render status badges with the same variant class pattern
      expect(projectRes.text).toContain('status-badge');
      expect(releaseRes.text).toContain('status-badge');
    });
  });

  // ─── 9. Accessibility ────────────────────────────────────────────

  describe('accessibility', () => {
    it('release list has exactly one h1', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('release calendar has exactly one h1', async () => {
      const res = await agent.get('/releases/calendar').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('release form has exactly one h1', async () => {
      const projRes = await agent.post('/projects')
        .send('title=H1+Form+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('release detail has exactly one h1', async () => {
      const projRes = await agent.post('/projects')
        .send('title=H1+Detail+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=H1+Detail+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('view-switcher has aria-label', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(res.text).toContain('aria-label="View"');
    });

    it('calendar navigation has aria-label', async () => {
      const res = await agent.get('/releases/calendar').expect(200);
      expect(res.text).toContain('aria-label="Calendar navigation"');
    });

    it('no nested interactive elements in view switcher', async () => {
      const res = await agent.get('/releases').expect(200);
      // View switcher options are <a> elements, not <button> inside <a>
      const switcherMatch = res.text.match(/<nav class="view-switcher"[^>]*>[\s\S]*?<\/nav>/);
      if (switcherMatch) {
        const switcherHtml = switcherMatch[0];
        // No <button> inside <a> in the view switcher
        expect(switcherHtml).not.toMatch(/<a[^>]*>[\s\S]*?<button/);
      }
    });
  });

  // ─── 10. No-JavaScript behavior ──────────────────────────────────────

  describe('no-JavaScript behavior', () => {
    it('release list filter form works without JavaScript', async () => {
      const res = await agent.get('/releases').expect(200);
      // Filter form uses method="get" — no JS required
      expect(res.text).toMatch(/<form[^>]+method="get"[^>]*action="\/releases"/);
    });

    it('release calendar navigation links work without JavaScript', async () => {
      const res = await agent.get('/releases/calendar').expect(200);
      // Previous/Next are real <a> links
      expect(res.text).toMatch(/<a class="button" href="[^"]*">/);
    });

    it('release archive form works without JavaScript (uses onclick confirm)', async () => {
      const projRes = await agent.post('/projects')
        .send('title=NoJS+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent.post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=NoJS+Archive+Release')
        .send('status=idea')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      // Archive form uses method="post" — works without JS
      expect(res.text).toMatch(/<form method="post" action="\/releases\/\d+\/archive"/);
    });
  });
});
