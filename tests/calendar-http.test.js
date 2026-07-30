/**
 * Release calendar — HTTP/rendered-page contracts.
 *
 * Verifies:
 *  - GET /calendar page heading and view switcher
 *  - List/board view switching links
 *  - Bounded responsive calendar container
 *  - Release status badges within calendar cells
 *  - Empty-month grid rendering
 *  - Calendar-specific accessibility
 *  - Server-rendered navigation that works without JavaScript
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

describe('release calendar HTTP', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-calendar-'));
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

  describe('calendar presentation', () => {
    it('calendar uses page-heading with view switcher', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(hasClass(res.text, 'page-heading-copy')).toBe(true);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('calendar has view-switcher links back to list and board', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(res.text).toContain('view-switcher-option');
      expect(res.text).toMatch(/href="\/release-management"/);
      expect(res.text).toMatch(/href="\/release-management\?view=board"/);
    });

    it('calendar renders a named bounded scroll container for narrow screens', async () => {
      const res = await agent.get('/calendar').expect(200);
      const css = extractStyle(res.text);
      expect(res.text).toContain('<div class="calendar-scroll" tabindex="0" aria-label="Calendar grid">');
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

      // Calendar entries are project records — schedule the project itself
      // rather than creating a release record.
      await agent.post(`/projects/${projectId}`)
        .send('title=Calendar+Badge+Test')
        .send('status=planned')
        .send('priority=normal')
        .send('plannedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/calendar?month=2025-06').expect(200);
      expect(res.text).toContain('status-badge');
    });

    it('calendar with no releases in the month still renders the navigable grid with empty day cells', async () => {
      // The calendar grid always renders (so Previous/Next navigation stays
      // available even for months with zero releases) — days without
      // releases are marked individually via the "empty" day-cell class
      // rather than swapping the whole page for the shared empty-state
      // partial, which would strand the user without month navigation.
      const res = await agent.get('/calendar?month=2099-01').expect(200);
      expect(res.text).toContain('<div class="calendar-table" role="table">');
      expect(res.text).toMatch(/<div class="calendar-day empty" role="cell">/);
      expect(res.text).not.toContain('<div class="calendar-release');
    });
  });

  describe('calendar accessibility', () => {
    it('release calendar has exactly one h1', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('calendar navigation has aria-label', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(res.text).toContain('aria-label="Calendar navigation"');
    });
  });

  describe('calendar no-JavaScript behavior', () => {
    it('release calendar navigation links work without JavaScript', async () => {
      const res = await agent.get('/calendar').expect(200);
      // Previous/Next are real <a> links
      expect(res.text).toMatch(/<a class="button" href="[^"]*">/);
    });
  });
});
