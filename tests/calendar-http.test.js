/**
 * Release calendar — HTTP/rendered-page contracts.
 *
 * Verifies:
 *  - GET /calendar page heading and view switcher
 *  - List/board view switching links
 *  - Bounded responsive calendar container
 *  - Project status badges within calendar cells
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

function insertProject(db, title, { archivedAt = null, status = 'tbd' } = {}) {
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return db.prepare(`
    INSERT INTO projects (title, slug, description, notes, status, archived_at)
    VALUES (?, ?, '', '', ?, ?)
    RETURNING id
  `).get(title, slug, status, archivedAt);
}

function insertRelease(db, {
  projectId,
  title,
  notes = '',
  plannedDate = null,
  plannedTime = null,
  archivedAt = null,
}) {
  return db.prepare(`
    INSERT INTO releases (project_id, title, description, notes,
                          planned_date, planned_time, archived_at)
    VALUES (?, ?, '', ?, ?, ?, ?)
    RETURNING id
  `).get(projectId, title, notes, plannedDate, plannedTime, archivedAt);
}

function addReleasePreview(db, app, { projectId, releaseId, filename = 'calendar-preview.png' }) {
  const asset = app.locals.assetScanner.repository.upsert(projectId, filename, {
    filename,
    extension: 'png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    modifiedAt: '2026-08-04 12:00:00',
  });
  db.prepare(`
    INSERT INTO release_assets (release_id, asset_id, role, sort_order)
    VALUES (?, ?, 'preview', 0)
  `).run(releaseId, asset.id);
  return asset;
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

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-calendar-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('calendar presentation', () => {
    it('calendar uses page-heading with view switcher', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
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
      expect(res.text).toContain('<div class="calendar-scroll" tabindex="0" aria-label="Release calendar grid">');
      expect(res.text).toContain('<div class="calendar-table" role="table">');
      expect(css).toContain('.calendar-scroll');
      expect(css).toContain('overflow-x');
      expect(css).toContain('max-width: 100%');
    });

    it('calendar uses the project status in the status-badge partial', async () => {
      const project = insertProject(db, 'Calendar Badge Project', { status: 'ready' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Calendar Badge Release',
        plannedDate: '2025-06-15',
      });

      const res = await agent.get('/calendar?month=2025-06').expect(200);
      expect((res.text.match(/<span class="status-badge status-badge--active">Ready<\/span>/g) || [])).toHaveLength(2);
    });

    it('renders scheduled releases with time and canonical release edit links', async () => {
      const project = insertProject(db, 'Calendar Release Project');
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Calendar Release Entry',
        plannedDate: '2025-06-15',
        plannedTime: '09:30',
      });

      const res = await agent.get('/calendar?month=2025-06').expect(200);

      expect(res.text).toMatch(new RegExp(`href="/releases/${release.id}/edit">Calendar Release Entry</a>`));
      expect(res.text).toContain('<time class="calendar-release-time" datetime="2025-06-15T09:30">09:30</time>');
      expect(res.text).not.toContain(`/projects/${project.id}">Calendar Release Entry</a>`);
    });

    it('renders a selected release preview near the title in both calendar presentations', async () => {
      const project = insertProject(db, 'Calendar Preview Project');
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Calendar Preview Release',
        plannedDate: '2025-06-15',
      });
      const asset = addReleasePreview(db, app, { projectId: project.id, releaseId: release.id });

      const res = await agent.get('/calendar?month=2025-06').expect(200);
      const previewTags = res.text.match(/<img class="calendar-release-preview"[^>]*>/g) || [];
      const editLinks = res.text.match(new RegExp(`href="/releases/${release.id}/edit">Calendar Preview Release</a>`, 'g')) || [];

      expect(previewTags).toHaveLength(2);
      expect(previewTags.every((tag) => tag.includes(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=`))).toBe(true);
      expect(previewTags.every((tag) => tag.includes('alt="Preview of Calendar Preview Release"'))).toBe(true);
      expect(editLinks).toHaveLength(2);
    });

    it('renders project and release hierarchy plus escaped notes in both calendar presentations', async () => {
      const project = insertProject(db, 'Calendar Hierarchy Project');
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Calendar Hierarchy Release',
        notes: 'Release <notes> & details\nSecond line',
        plannedDate: '2025-06-15',
      });
      addReleasePreview(db, app, { projectId: project.id, releaseId: release.id });

      const res = await agent.get('/calendar?month=2025-06').expect(200);
      const collapsedHierarchy = res.text.match(
        new RegExp(
          `<span class="calendar-release-project">Calendar Hierarchy Project</span>\\s*<a href="/releases/${release.id}/edit">Calendar Hierarchy Release</a>`,
          'g',
        ),
      ) || [];

      expect(collapsedHierarchy).toHaveLength(2);
      expect(res.text).not.toContain('calendar-release-preview-project');
      expect(res.text).not.toContain('calendar-release-preview-title');
      expect((res.text.match(/<span class="calendar-release-preview-notes">Release &lt;notes&gt; &amp; details\nSecond line<\/span>/g) || [])).toHaveLength(2);
      expect(res.text).not.toContain('<notes>');
    });

    it('omits the notes area when release notes are empty', async () => {
      const project = insertProject(db, 'Calendar Empty Notes Project');
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Calendar Empty Notes Release',
        plannedDate: '2025-06-15',
      });
      addReleasePreview(db, app, { projectId: project.id, releaseId: release.id });

      const res = await agent.get('/calendar?month=2025-06').expect(200);

      expect(res.text).not.toContain('calendar-release-preview-notes');
      expect(res.text).toContain(`/releases/${release.id}/edit">Calendar Empty Notes Release</a>`);
    });

    it('does not render preview markup or an empty preview container when preview_url is absent', async () => {
      const project = insertProject(db, 'Calendar No Preview Project');
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Calendar No Preview Release',
        plannedDate: '2025-06-15',
      });

      const res = await agent.get('/calendar?month=2025-06').expect(200);

      expect(res.text).not.toContain('calendar-release-preview');
      expect(res.text).not.toContain('<img class="calendar-release-preview"');
      expect(res.text).toContain(`/releases/${release.id}/edit">Calendar No Preview Release</a>`);
    });

    it('reveals previews with hover or keyboard focus without capturing pointer input', async () => {
      const res = await agent.get('/calendar').expect(200);
      const css = extractStyle(res.text);

      expect(css).toMatch(/\.calendar-release-trigger:hover\s*>\s*\.calendar-release-preview/);
      expect(css).toMatch(/\.calendar-release-trigger\s*>\s*a:focus-visible\s*~\s*\.calendar-release-preview/);
      expect(css).toMatch(/\.calendar-release-trigger:hover\s*>\s*\.calendar-release-preview-details/);
      expect(css).toMatch(/\.calendar-release-trigger\s*>\s*a:focus-visible\s*~\s*\.calendar-release-preview-details/);
      expect(css).toMatch(/\.calendar-release-preview\s*\{[^}]*pointer-events:\s*none/);
      expect(css).toMatch(/\.calendar-release-preview-notes\s*\{[^}]*white-space:\s*pre-wrap/);
      expect(css).toMatch(/\.calendar-release-trigger:hover\s*>\s*\.calendar-release-preview,\s*\.calendar-release-trigger\s*>\s*a:focus-visible\s*~\s*\.calendar-release-preview\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible/);
      expect(css).toMatch(/\.calendar-release-trigger:hover\s*>\s*\.calendar-release-preview-details,\s*\.calendar-release-trigger\s*>\s*a:focus-visible\s*~\s*\.calendar-release-preview-details\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible/);
    });

    it('renders multiple releases independently and excludes archived or unscheduled releases', async () => {
      const readyProject = insertProject(db, 'Calendar Ready Project', { status: 'ready' });
      const plannedProject = insertProject(db, 'Calendar Planned Project', { status: 'planned' });
      const first = insertRelease(db, {
        projectId: readyProject.id,
        title: 'First Calendar Release',
        plannedDate: '2025-06-15',
      });
      const second = insertRelease(db, {
        projectId: plannedProject.id,
        title: 'Second Calendar Release',
        plannedDate: '2025-06-15',
      });
      insertRelease(db, {
        projectId: readyProject.id,
        title: 'Archived Calendar Release',
        plannedDate: '2025-06-15',
        archivedAt: '2025-06-01 00:00:00',
      });
      insertRelease(db, {
        projectId: readyProject.id,
        title: 'Unscheduled Calendar Release',
      });

      const res = await agent.get('/calendar?month=2025-06').expect(200);

      expect(res.text).toContain(`/releases/${first.id}/edit">First Calendar Release</a>`);
      expect(res.text).toContain(`/releases/${second.id}/edit">Second Calendar Release</a>`);
      expect(res.text).toContain('Ready');
      expect(res.text).toContain('Planned');
      expect(res.text).not.toContain('Archived Calendar Release');
      expect(res.text).not.toContain('Unscheduled Calendar Release');
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

    it('keeps the legacy release-calendar URL redirecting with its query string', async () => {
      const res = await agent
        .get('/releases/calendar?month=2025-06&source=legacy')
        .expect(302);

      expect(res.headers.location).toBe('/calendar?month=2025-06&source=legacy');
    });
  });
});
