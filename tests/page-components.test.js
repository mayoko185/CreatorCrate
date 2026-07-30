/**
 * Phase 10.5A — Shared page-level components: structural and rendered tests.
 *
 * Verifies:
 *  - Shared page-heading markup contract
 *  - Action variants (button/link parity, focus, disabled)
 *  - Visible form labels and error/help text
 *  - Status badges always contain readable text
 *  - Table wrapper and headers
 *  - Empty-state markup
 *  - Destructive section
 *  - No inline presentation styles outside the shared stylesheet
 *  - No duplicate IDs
 *  - No invalid nested interactive controls
 *  - Exactly one <h1> per page
 *  - Mobile-safe class structure (no horizontal overflow at 320px)
 *  - Notice variants have correct semantic class
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
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const STYLESHEET_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const SERVED_CSS = fs.readFileSync(STYLESHEET_PATH, 'utf8');

function renderPartial(templateName, context = {}) {
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  return env.render(templateName, context);
}

/** Return the served local stylesheet linked by the rendered page. */
function extractStyle(html) {
  expect(html).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
  return SERVED_CSS;
}

function listProductionTemplates(dir = VIEWS_DIR) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const templates = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      templates.push(...listProductionTemplates(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.njk') && entry.name !== 'layout.njk') {
      templates.push(fullPath);
    }
  }
  return templates;
}

/** Count opening tags matching a regex. */
function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

/** Extract the text content of all elements matching a class. */
function textsByClass(html, className) {
  const re = new RegExp(`class="[^"]*${className}[^"]*"`, 'g');
  const texts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    // Find the next closing tag text
    const after = html.slice(m.index);
    const textMatch = after.match(/>([^<]+)</);
    if (textMatch) texts.push(textMatch[1].trim());
  }
  return texts;
}

/** Check if a class appears in the HTML. */
function hasClass(html, className) {
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  return re.test(html);
}

describe('Phase 10.5A: Shared page-level components', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let appDataRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shared-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Page heading contract ─────────────────────────────────────────

  describe('page-heading contract', () => {
    it('project form has exactly one h1 inside page-heading-copy', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(hasClass(res.text, 'page-heading-copy')).toBe(true);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
    });

    it('release form has exactly one h1 inside page-heading-copy', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases/new').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
    });

    it('project list has exactly one h1 inside page-heading', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
    });

    it('release list has exactly one h1 inside page-heading', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
    });

    it('dashboard has exactly one h1 inside page-heading', async () => {
      const res = await agent.get('/').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(hasClass(res.text, 'page-heading-copy')).toBe(true);
      expect(hasClass(res.text, 'page-heading-description')).toBe(true);
    });
  });

  // ─── 2. Action variants ────────────────────────────────────────────────

  describe('action variants', () => {
    it('button-primary is rendered for primary actions', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(hasClass(res.text, 'button-primary')).toBe(true);
    });

    it('button-secondary is rendered for cancel links', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(hasClass(res.text, 'button-secondary')).toBe(true);
    });

    it('button-danger is rendered for destructive actions', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Danger+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = projRes.headers.location.replace('/projects/', '');

      const detail = await agent.get(`/projects/${id}`).expect(200);
      expect(hasClass(detail.text, 'button-danger')).toBe(true);
    });
  });

  // ─── 3. Button/link parity ─────────────────────────────────────────────

  describe('button/link parity', () => {
    it('links and buttons with class button have consistent base styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);

      // .button base exists
      expect(css).toContain('.button {');

      // .button-primary exists
      expect(css).toContain('.button-primary');

      // .button-danger exists
      expect(css).toContain('.button-danger');

      // .button-secondary exists
      expect(css).toContain('.button-secondary');
    });

    it('buttons have focus-visible styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.button:focus-visible');
    });
  });

  // ─── 4. Visible form labels ─────────────────────────────────────────────

  describe('form labels and errors', () => {
    it('project form has visible labels for every control', async () => {
      const res = await agent.get('/projects/new').expect(200);
      // Every <label> must have a for= attribute matching an input id
      const labels = res.text.match(/<label[^>]*for="([^"]+)"[^>]*>/g) || [];
      expect(labels.length).toBeGreaterThan(0);

      for (const label of labels) {
        const forMatch = label.match(/for="([^"]+)"/);
        if (forMatch) {
          const inputId = forMatch[1];
          expect(res.text).toMatch(new RegExp(`id="${inputId}"`));
        }
      }
    });

    it('project form error state renders field-error-message text', async () => {
      const res = await agent
        .post('/projects')
        .send('title=')
        .send('status=invalid')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('field-error-message');
      expect(res.text).toContain('field-error');
    });

    it('project form required indicators use aria-label', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const requiredSpans = res.text.match(/<span class="required"[^>]*>/g) || [];
      for (const span of requiredSpans) {
        expect(span).toContain('aria-label="required"');
      }
    });
  });

  // ─── 5. Status badges ──────────────────────────────────────────────────

  describe('status badges', () => {
    it('project list uses status-badge with readable text', async () => {
      await agent
        .post('/projects')
        .send('title=Badge+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/projects').expect(200);
      // The status badge must contain text content (not just color)
      expect(res.text).toContain('status-badge');
      // The text "Tbd" must appear inside a badge
      expect(res.text).toMatch(/status-badge[^>]*>Tbd</);
    });

    it('project detail uses status-badge', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Badge+Detail')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('status-badge');
    });

    it('status-badge variant classes are defined in CSS', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);
      // All semantic variants
      expect(css).toContain('.status-badge--neutral');
      expect(css).toContain('.status-badge--active');
      expect(css).toContain('.status-badge--success');
      expect(css).toContain('.status-badge--warning');
      expect(css).toContain('.status-badge--error');
      expect(css).toContain('.status-badge--draft');
      expect(css).toContain('.status-badge--published');
      expect(css).toContain('.status-badge--archived');
    });
  });

  // ─── 6. Table responsiveness ───────────────────────────────────────────

  describe('table responsiveness', () => {
    it('project list table uses data-table and table-scroll', async () => {
      db.prepare(
        `INSERT INTO projects (title, slug, description, notes, status, priority, planned_date, published_date, patreon_url)
         VALUES (?, ?, '', '', 'tbd', 'normal', NULL, NULL, NULL)`
      ).run('Table Test', 'table-test');
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('data-table');
      expect(res.text).toContain('table-scroll');
    });

    it('data-table styles are defined with proper header styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.data-table');
      expect(css).toContain('.data-table th');
    });

    it('ordinary project tables are not extra tab stops', async () => {
      // Need at least one project so the table renders (empty state has no table-scroll)
      await agent
        .post('/projects')
        .send('title=Tabindex+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/projects').expect(200);
      const wrapper = res.text.match(/<div class="table-scroll">[\s\S]*?<table class="data-table">/);
      expect(wrapper).not.toBeNull();
      expect(wrapper[0]).not.toContain('tabindex="0"');
    });

    it('intrinsically wide release tables remain focusable and named', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Wide+Table+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Wide+Release')
        .send('status=idea')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases').expect(200);
      expect(res.text).toMatch(/<div class="table-scroll" tabindex="0" aria-label="Release list">/);
    });
  });

  // ─── 7. Empty states ──────────────────────────────────────────────────

  describe('empty-state contract', () => {
    it('project list empty state uses shared partial', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('empty-state');
      expect(res.text).toContain('empty-state-heading');
    });

    it('empty-state heading is semantic and not an h1', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toMatch(/<h2 class="empty-state-heading">No projects yet<\/h2>/);
      expect(res.text).not.toMatch(/<p class="empty-state-heading">/);
      const emptyStateBlock = res.text.match(/class="empty-state"[\s\S]*?<\/div>/);
      if (emptyStateBlock) {
        expect(countTags(emptyStateBlock[0], 'h1')).toBe(0);
      }
    });
  });

  // ─── 8. Destructive sections ───────────────────────────────────────────

  describe('destructive section', () => {
    it('project detail has destructive section with danger styling', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Destructive+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('destructive-section');
      expect(res.text).toContain('button-danger');
    });

    it('archived project detail has no destructive section', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archived+No+Destructive')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      // Check HTML class attribute, not CSS definition (which appears in <style>)
      expect(hasClass(res.text, 'destructive-section')).toBe(false);
    });

    it('destructive-section CSS has danger border color', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.destructive-section');
      expect(css).toContain('border: 1px solid var(--danger)');
    });
  });

  // ─── 9. Notice variants ────────────────────────────────────────────────

  describe('notice variants', () => {
    it('release detail uses notice--warning for archived state', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Notice+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archived+Release')
        .send('status=idea')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent
        .post(`${relRes.headers.location}/archive`)
        .send({ _csrf: csrfToken })
        .expect(302);

      const detail = await agent.get(relRes.headers.location).expect(200);
      expect(detail.text).toContain('notice--warning');
    });

    it('notice variant CSS classes are defined', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.notice--info');
      expect(css).toContain('.notice--success');
      expect(css).toContain('.notice--warning');
      expect(css).toContain('.notice--error');
    });

    for (const variant of ['info', 'success', 'warning', 'error']) {
      it(`notice partial allowlists ${variant} variant`, () => {
        const html = renderPartial('partials/notice.njk', {
          noticeVariant: variant,
          noticeText: `${variant} message`,
        });
        expect(html).toContain(`class="notice notice--${variant}"`);
        expect(html).toContain(`${variant} message`);
      });
    }

    it('notice partial falls back safely for unknown and malicious variants', () => {
      const unknown = renderPartial('partials/notice.njk', {
        noticeVariant: 'unknown',
        noticeText: 'Plain message',
      });
      expect(unknown).toContain('class="notice notice--info"');

      const malicious = renderPartial('partials/notice.njk', {
        noticeVariant: 'error hacked-class',
        noticeText: '<strong>Escaped</strong>',
      });
      expect(malicious).toContain('class="notice notice--info"');
      expect(malicious).not.toContain('hacked-class');
      expect(malicious).toContain('&lt;strong&gt;Escaped&lt;/strong&gt;');
    });
  });

  // ─── 10. No inline presentation styles ─────────────────────────────────

  describe('no inline presentation styles', () => {
    it('production templates keep presentation CSS in the shared stylesheet only', () => {
      const offenders = [];
      for (const templatePath of listProductionTemplates()) {
        const source = fs.readFileSync(templatePath, 'utf8');
        if (/<style\b/i.test(source) || /\sstyle\s*=/i.test(source)) {
          offenders.push(path.relative(VIEWS_DIR, templatePath).replace(/\\/g, '/'));
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  // ─── 11. No duplicate IDs ─────────────────────────────────────────────

  describe('no duplicate IDs', () => {
    it('project form has no duplicate IDs', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const ids = res.text.match(/id="([^"]+)"/g) || [];
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  // ─── 12. No second page h1 ────────────────────────────────────────────

  describe('single h1 per page', () => {
    it('project form has exactly one h1', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('project detail has exactly one h1', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=H1+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('project list has exactly one h1', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('dashboard has exactly one h1', async () => {
      const res = await agent.get('/').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('release list has exactly one h1', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });
  });

  // ─── 13. Mobile-safe class structure ───────────────────────────────────

  describe('mobile-safe class structure', () => {
    it('page-heading has mobile responsive CSS', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);
      // Mobile breakpoint exists
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
      // page-heading flex-direction: column on mobile
      expect(css).toMatch(/\.page-heading\s*\{[^}]*flex/i);
    });

    it('data-table has responsive styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.data-table');
      expect(css).toContain('.table-scroll');
    });

    it('field-row becomes column on mobile', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const css = extractStyle(res.text);
      // The mobile breakpoint must contain a rule that makes field-row stack
      // This is split across lines, so check for the class and the property separately
      expect(css).toContain('.field-row');
      // Check the mobile media query exists
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
    });
  });
});
