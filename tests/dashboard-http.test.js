/**
 * HTTP-level tests for the release-first Dashboard rendered from
 * `workflowQueryService.getDashboardData()` through `renderDashboardPage`.
 * Dates are seeded relative to the application-local today.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { getLocalTodayIso } from '../src/util/date.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function extractRegion(html, headingId) {
  const re = new RegExp(`<section\\b[^>]*aria-labelledby="${headingId}"[^>]*>[\\s\\S]*?<\\/section>`);
  return html.match(re)?.[0] || '';
}

function extractById(html, tag, id) {
  return html.match(new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[\\s\\S]*?<\\/${tag}>`))?.[0] || '';
}

function extractNeedsDatePanel(html) {
  const start = html.indexOf('<section class="dashboard-panel dashboard-needs-date"');
  const end = html.indexOf('<div class="dashboard-primary-column">');
  return start >= 0 && end > start ? html.slice(start, end) : '';
}

function extractScheduledPanel(html) {
  const start = html.indexOf('<section class="dashboard-panel dashboard-scheduled"');
  const end = html.indexOf('<section class="dashboard-panel dashboard-recent"');
  return start >= 0 && end > start ? html.slice(start, end) : '';
}

function extractRecentPanel(html) {
  const start = html.indexOf('<section class="dashboard-panel dashboard-recent"');
  const end = html.indexOf('<section class="dashboard-panel dashboard-projects"');
  return start >= 0 && end > start ? html.slice(start, end) : '';
}

function extractProjectsPanel(html) {
  const start = html.indexOf('<section class="dashboard-panel dashboard-projects"');
  return start >= 0 ? html.slice(start, html.indexOf('</section>', html.indexOf('dashboard-projects-footer', start)) + 10) : '';
}

function extractTile(html, tile) {
  return html.match(new RegExp(`<a class="dashboard-tile[^"]*"[^>]*data-dashboard-tile="${tile}">[\\s\\S]*?<\\/a>`))?.[0] || '';
}

function extractAttentionRegion(html) {
  return extractRegion(html, 'dashboard-attention-heading');
}

function visibleText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractNeedsDateItem(html, releaseId) {
  return html.match(new RegExp(`<li class="dashboard-needs-date-item" data-dashboard-needs-date-item data-release-id="${releaseId}">[\\s\\S]*?data-dashboard-schedule-status></div>\\s*</div>\\s*</div>\\s*</li>`))?.[0] || '';
}

function extractReleaseRow(html, releaseId) {
  return html.match(new RegExp(`<li class="dashboard-release-row[^"]*" data-dashboard-release-row data-release-id="${releaseId}">[\\s\\S]*?<\\/li>`))?.[0] || '';
}

function extractProjectRow(html, projectId) {
  return html.match(new RegExp(`<tr class="dashboard-project-row"[^>]*data-project-id="${projectId}"[\\s\\S]*?<\\/tr>`))?.[0] || '';
}

function extractProjectCreateDialog(html) {
  return html.match(/<dialog id="project-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

async function createProject(app, { title, status = 'tbd', projectType = 'images' }) {
  const res = await app.testAgent
    .post('/projects')
    .type('form')
    .send({ title, status, projectType, priority: 'normal', _csrf: app.testCsrfToken })
    .expect(302);
  return Number(res.headers.location.replace('/projects/', ''));
}

function insertRelease(db, projectId, {
  title,
  plannedDate = null,
  plannedTime = null,
  publishedDate = null,
  archivedAt = null,
  createdAt = null,
} = {}) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at)
    VALUES (?, ?, '', '', ?, ?, NULL, ?, ?)
  `).run(projectId, title, plannedDate, plannedTime, publishedDate, archivedAt);
  if (createdAt) db.prepare('UPDATE releases SET created_at = ? WHERE id = ?').run(createdAt, lastInsertRowid);
  return Number(lastInsertRowid);
}

describe('dashboard HTTP composition', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let today;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-'));
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
    today = getLocalTodayIso();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPrimaryImage(projectId, filename = 'cover.png') {
    const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(projectId);
    const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    fs.writeFileSync(path.join(projectDir, filename), 'content');
    app.locals.assetScanner.scanProjectAssets(projectId);
    const asset = app.locals.assetScanner.repository.findByProjectId(projectId)[0];
    app.locals.projectPrimaryImageService.setPrimaryImage(projectId, asset.id);
    return asset;
  }

  function tagProjectNsfw(projectId) {
    const tag = app.locals.tagService.createTag({ name: 'NSFW' });
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, tag.id);
  }

  function addMissingSelectedAsset(projectId, releaseId, filename) {
    const asset = createAssetRepository(db).upsert(projectId, filename, {
      filename, extension: 'txt', mimeType: 'text/plain', sizeBytes: 0, modifiedAt: null,
    });
    db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);
    db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)').run(releaseId, asset.id);
    return asset;
  }

  describe('page header', () => {
    it('renders one h1, the local date, New Release, and the hosted New Project action without retired controls', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const heading = res.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';

      expect(countTags(res.text, 'h1')).toBe(1);
      expect(res.text).toContain('<h1 class="app-section-title">Dashboard</h1>');
      expect(res.text).toContain(`<p class="dashboard-today"><time datetime="${today}">`);
      expect(heading).toContain('<a class="button button-secondary" href="/releases/new">New Release</a>');
      expect(heading).toContain('<a class="button button-primary" href="/projects/new" data-dialog-open="project-create-dialog">New Project</a>');
      for (const retired of [
        'data-dashboard-defaults-link', 'dashboard-defaults-dialog', 'href="/?defaults=1"',
        'id="projects-nsfw-toggle"', 'data-projects-nsfw-filter', 'data-asset-grid-size-controls',
        'data-project-grid-size-controls', 'summary-card', 'data-dashboard-section=',
      ]) {
        expect(res.text).not.toContain(retired);
      }
      expect(res.text).not.toMatch(/<input[^>]*type="search"/);
    });

    it('renders the scheduling recovery status and announcer outside the refreshed Dashboard region', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const sync = res.text.match(/<div class="notice notice--warning dashboard-sync" data-dashboard-sync hidden>[\s\S]*?<\/div>/)?.[0] || '';
      const syncAt = res.text.indexOf('data-dashboard-sync ');
      const regionAt = res.text.indexOf('<div class="dashboard" data-dashboard ');

      expect(sync).toContain('<p data-dashboard-sync-message></p>');
      expect(sync).toContain('<button class="button button-small button-secondary" type="button" data-dashboard-sync-retry>Retry refresh</button>');
      // A plain link, so recovery by reload is a GET even without scripts.
      expect(sync).toContain('<a class="button button-small button-secondary" href="/" data-dashboard-sync-reload>Reload page</a>');
      expect(sync).toContain('data-dashboard-sync-dismiss hidden>Dismiss</button>');
      expect(res.text).toContain('<p class="sr-only" role="status" data-dashboard-announcer></p>');
      expect(syncAt).toBeGreaterThan(res.text.indexOf('<p class="dashboard-today">'));
      expect(syncAt).toBeLessThan(regionAt);
      expect(res.text.indexOf('data-dashboard-announcer')).toBeLessThan(regionAt);
    });

    it('ignores the retired ?defaults=1 dialog entry point', async () => {
      const res = await app.testAgent.get('/?defaults=1').expect(200);
      expect(res.text).not.toContain('dashboard-defaults-dialog');
    });

    it('renders all seven Dashboard regions with Needs a date before Scheduled releases in source order', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const positions = [
        'class="dashboard-attention"',
        'class="dashboard-strip"',
        'id="needs-date"',
        'id="dashboard-scheduled-heading"',
        'id="dashboard-recent-heading"',
        'id="dashboard-projects-heading"',
      ].map((marker) => res.text.indexOf(marker));

      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      for (const id of ['dashboard-attention-heading', 'dashboard-strip-heading', 'dashboard-needs-date-heading',
        'dashboard-scheduled-heading', 'dashboard-recent-heading', 'dashboard-projects-heading']) {
        expect(res.text).toMatch(new RegExp(`<section\\b[^>]*aria-labelledby="${id}"`));
      }
      const ids = [...res.text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
      const dashboardMarkup = res.text.slice(res.text.indexOf('<div class="dashboard" data-dashboard'));
      const styledElements = dashboardMarkup.match(/<[a-z]+\b[^>]*\sstyle="[^"]*"[^>]*>/g) || [];
      expect(styledElements.every((element) => element.includes('project-option-badge'))).toBe(true);
    });
  });

  describe('empty Dashboard', () => {
    it('renders zero tiles and compact one-line empty states', async () => {
      const res = await app.testAgent.get('/').expect(200);

      for (const tile of ['overdue', 'needs-date', 'today', 'next7', 'missing-assets']) {
        expect(extractTile(res.text, tile)).toContain('dashboard-tile--zero');
        expect(extractTile(res.text, tile)).toContain('data-dashboard-tile-count>0</span>');
      }
      expect(extractAttentionRegion(res.text)).not.toContain('dashboard-tile-context');
      expect(extractNeedsDatePanel(res.text)).toContain('<p class="dashboard-empty-line">Every active release has a date.</p>');
      expect(extractScheduledPanel(res.text)).toContain('<p class="dashboard-empty-line">Nothing scheduled.</p>');
      expect(extractRecentPanel(res.text)).toContain('<p class="dashboard-empty-line">Nothing published yet.</p>');
      expect(extractRecentPanel(res.text)).toContain('href="/releases">History');
      expect(extractProjectsPanel(res.text)).toContain('No active projects.');
      expect(extractProjectsPanel(res.text)).toContain('0 of 0 active projects · archived hidden');
      expect(res.text).not.toContain('empty-state-heading');
    });

    it('omits aria-controls from status filter toggles when no projects table is rendered', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const panel = extractProjectsPanel(res.text);

      expect(panel).toContain('data-dashboard-status-filters');
      expect(panel).toContain('data-dashboard-status-filter="all"');
      expect(panel).not.toContain('id="dashboard-projects-table"');
      expect(panel).not.toContain('aria-controls=');
      expect(panel).not.toContain('data-dashboard-projects-filter-empty');
      expect(panel).not.toContain('aria-live=');
    });
  });

  describe('attention tiles', () => {
    it('links all five tiles, emphasizes Needs a date, and shows only each label and count', async () => {
      const projectId = await createProject(app, { title: 'Tile Project', status: 'ready' });
      insertRelease(db, projectId, { title: 'Late One', plannedDate: addDays(today, -3) });
      insertRelease(db, projectId, { title: 'Due Now', plannedDate: today, plannedTime: '18:05' });
      insertRelease(db, projectId, { title: 'This Week', plannedDate: addDays(today, 7) });
      insertRelease(db, projectId, { title: 'Next Week', plannedDate: addDays(today, 8) });
      const undatedId = insertRelease(db, projectId, { title: 'Undated', createdAt: '2020-01-01 12:00:00' });
      addMissingSelectedAsset(projectId, undatedId, 'lost.txt');

      const res = await app.testAgent.get('/').expect(200);

      const expected = [
        ['overdue', '/releases?schedule=overdue', 'Overdue'],
        ['needs-date', '#needs-date', 'Needs a date'],
        ['today', '/releases?schedule=today', 'Due today'],
        ['next7', '/releases?schedule=upcoming', 'Next 7 days'],
        ['missing-assets', '/asset-viewer?presence=missing', 'Missing assets'],
      ];
      for (const [key, href, label] of expected) {
        const tile = extractTile(res.text, key);
        expect(tile).toContain(`href="${href}"`);
        expect(tile).toContain('<span class="dashboard-tile-value" data-dashboard-tile-count>1</span>');
        expect(tile).toContain(`<span class="dashboard-tile-label">${label}</span>`);
        expect(tile).not.toContain('dashboard-tile--zero');
        expect(countTags(tile, 'span')).toBe(2);
        expect(visibleText(tile)).toBe(`1 ${label}`);
      }
      expect(extractTile(res.text, 'needs-date'))
        .toContain('class="dashboard-tile dashboard-tile--needs-date dashboard-tile--emphasis"');

      const attention = extractAttentionRegion(res.text);
      expect(countTags(attention, 'li')).toBe(5);
      expect(attention).not.toContain('dashboard-tile-context');
      expect(attention).not.toContain('Due Now');
    });

    it('renders no release card in the Due today tile while Today rows keep their title cards', async () => {
      const projectId = await createProject(app, { title: 'Tile Card Project' });
      const morningId = insertRelease(db, projectId, { title: 'Morning Drop', plannedDate: today, plannedTime: '09:00' });
      const eveningId = insertRelease(db, projectId, { title: 'Evening Drop', plannedDate: today, plannedTime: '20:00' });

      const res = await app.testAgent.get('/').expect(200);
      const attention = extractAttentionRegion(res.text);

      expect(extractTile(res.text, 'today')).toContain('data-dashboard-tile-count>2</span>');
      expect(attention).not.toContain('data-dashboard-tile-info');
      expect(attention).not.toContain('data-calendar-info-card');
      expect(attention).not.toContain('Morning Drop');
      expect(res.text).not.toContain('dashboard-release-info-today-tile-');

      const scheduled = extractScheduledPanel(res.text);
      for (const [releaseId, title] of [[morningId, 'Morning Drop'], [eveningId, 'Evening Drop']]) {
        const card = extractById(scheduled, 'div', `dashboard-release-info-scheduled-${releaseId}`);
        expect(card).toContain('data-calendar-info-card popover="manual"');
        expect(card).toContain(`aria-label="Details for ${title}"`);
        expect(scheduled).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="dashboard-release-info-scheduled-${releaseId}" aria-expanded="false">${title}</button>`);
      }
    });

    it('excludes archived projects from missing-asset and release counts', async () => {
      const archivedId = await createProject(app, { title: 'Archived Tile Project' });
      const releaseId = insertRelease(db, archivedId, { title: 'Hidden Late', plannedDate: addDays(today, -2) });
      addMissingSelectedAsset(archivedId, releaseId, 'hidden.txt');
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archivedId);

      const res = await app.testAgent.get('/').expect(200);

      expect(extractTile(res.text, 'overdue')).toContain('data-dashboard-tile-count>0</span>');
      expect(extractTile(res.text, 'missing-assets')).toContain('data-dashboard-tile-count>0</span>');
      expect(res.text).not.toContain('Hidden Late');
      expect(res.text).not.toContain('Archived Tile Project');
    });
  });

  describe('two-week strip', () => {
    it('renders fourteen labelled calendar links with today, open days, indicators, and a legend', async () => {
      const projectId = await createProject(app, { title: 'Strip Project' });
      insertRelease(db, projectId, { title: 'Tomorrow Release', plannedDate: addDays(today, 1) });

      const res = await app.testAgent.get('/').expect(200);
      const strip = extractRegion(res.text, 'dashboard-strip-heading');
      const days = strip.match(/<li class="dashboard-strip-day[\s\S]*?<\/li>/g) || [];
      const todayDay = days.find((day) => day.includes(`data-date="${today}"`)) || '';
      const tomorrowDay = days.find((day) => day.includes(`data-date="${addDays(today, 1)}"`)) || '';
      const openDay = days.find((day) => day.includes(`data-date="${addDays(today, 2)}"`)) || '';

      expect(strip).toContain('<ol class="dashboard-strip-days">');
      expect(days).toHaveLength(14);
      expect((strip.match(/aria-current="date"/g) || [])).toHaveLength(1);
      expect(todayDay).toContain('dashboard-strip-day--today');
      expect(todayDay).toContain('aria-current="date"');
      expect(todayDay).toContain(`href="/calendar?month=${today.slice(0, 7)}"`);
      expect(todayDay).toMatch(/aria-label="[A-Z][a-z]+ \d+, today, no releases"/);
      expect(tomorrowDay).toContain('dashboard-strip-dot--scheduled');
      expect(tomorrowDay).toMatch(/aria-label="[A-Z][a-z]+ \d+, 1 scheduled"/);
      expect(tomorrowDay).not.toContain('dashboard-strip-day--open');
      if (openDay) {
        expect(openDay).toContain('dashboard-strip-day--open');
        expect(openDay).toMatch(/aria-label="[A-Z][a-z]+ \d+, open day"/);
      }
      expect(strip).toContain('class="dashboard-strip-legend"');
      for (const label of ['Overdue', 'Scheduled', 'Published', 'Open day']) expect(strip).toContain(label);
      expect(strip).not.toMatch(/Previous|Next week|chevron/i);
    });
  });

  describe('Needs a release date panel', () => {
    it('renders release/project links, readiness, age, quick picks, and the disabled scheduling contract', async () => {
      const projectId = await createProject(app, { title: 'Needs Date Project', status: 'ready' });
      const releaseId = insertRelease(db, projectId, { title: 'Waiting Release', createdAt: '2020-01-01 12:00:00' });
      addMissingSelectedAsset(projectId, releaseId, 'gone.txt');

      const res = await app.testAgent.get('/').expect(200);
      const panel = extractNeedsDatePanel(res.text);
      const item = extractNeedsDateItem(res.text, releaseId);

      expect(panel).toContain('id="needs-date"');
      expect(panel).toContain('1 waiting');
      expect(panel).toContain('Oldest first. Pick an open day, or choose any date.');
      expect(panel).not.toContain('View all');
      expect(item).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="dashboard-release-info-needs-date-${releaseId}" aria-expanded="false">Waiting Release</button>`);
      expect(item).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="dashboard-project-info-needs-date-${releaseId}" aria-expanded="false">Needs Date Project</button>`);
      expect(item).not.toMatch(/<button class="dashboard-title-trigger[^>]*\stitle=/);
      expect(item).toContain(`id="dashboard-release-info-needs-date-${releaseId}"`);
      expect(item).toContain(`id="dashboard-project-info-needs-date-${releaseId}"`);
      expect(item).toContain('1 asset selected');
      expect(item).toContain('dashboard-age dashboard-age--danger');
      expect(item).toContain('dashboard-chip dashboard-chip--danger">1 missing');
      expect(item).toContain('No platforms chosen');
      expect(item).toContain('dashboard-thumb--initials');
      expect(item).toContain('>NP</span>');

      expect(item).toContain(`data-dashboard-schedule
           data-release-id="${releaseId}"
           data-schedule-url="/releases/${releaseId}/schedule"
           data-expected-planned-date=""
           data-expected-planned-time=""`);
      const forms = item.match(/<form\b[\s\S]*?<\/form>/g) || [];
      expect(forms).toHaveLength(2);
      for (const form of forms) {
        expect(form).toContain(`method="post" action="/releases/${releaseId}/schedule"`);
        expect(form).toContain(`name="_csrf" value="${app.testCsrfToken}"`);
        expect(form).toContain('name="expectedPlannedDate" value=""');
        expect(form).toContain('name="expectedPlannedTime" value=""');
        expect(form).toContain('name="plannedTime" value=""');
        expect(form).toMatch(/<fieldset class="dashboard-schedule-fieldset" disabled data-dashboard-schedule-controls/);
      }
      const picks = item.match(/<button[^>]*data-dashboard-schedule-pick[^>]*>/g) || [];
      expect(picks).toHaveLength(3);
      for (const pick of picks) {
        expect(pick).toMatch(/name="plannedDate" value="(\d{4}-\d{2}-\d{2})"/);
        expect(pick).toMatch(/data-planned-date="\d{4}-\d{2}-\d{2}"/);
        expect(pick).toMatch(/aria-label="Schedule for [A-Z][a-z]+day, [A-Z][a-z]+ \d+, \d{4}"/);
        expect(pick.match(/value="([^"]+)"/)[1] > today).toBe(true);
      }
      expect(item).toContain(`<label class="sr-only" for="dashboard-schedule-date-${releaseId}">Release date</label>`);
      expect(item).toContain(`id="dashboard-schedule-date-${releaseId}" type="date" name="plannedDate" required data-dashboard-schedule-date`);
      expect(item).toContain('data-dashboard-schedule-set>Set</button>');
      expect(item).toContain(`id="dashboard-schedule-error-${releaseId}" data-dashboard-schedule-error hidden`);
      // The row shows its confirmation; the page-level announcer speaks it.
      expect(item).toContain('<div class="dashboard-schedule-status" data-dashboard-schedule-status></div>');
      expect(item).not.toContain('role="status"');
    });

    it('caps the list at ten items oldest first and links to all undated releases', async () => {
      const projectId = await createProject(app, { title: 'Many Undated' });
      const ids = Array.from({ length: 12 }, (_, index) => insertRelease(db, projectId, {
        title: `Undated ${String(index + 1).padStart(2, '0')}`,
        createdAt: `2026-01-${String(index + 1).padStart(2, '0')} 12:00:00`,
      }));

      const res = await app.testAgent.get('/').expect(200);
      const panel = extractNeedsDatePanel(res.text);
      const rendered = [...panel.matchAll(/data-dashboard-needs-date-item data-release-id="(\d+)"/g)].map((match) => Number(match[1]));

      expect(rendered).toEqual(ids.slice(0, 10));
      expect(panel).toContain('<ul class="dashboard-needs-date-list" data-dashboard-needs-date-list>');
      expect(panel).toContain('12 waiting');
      expect(panel).toContain('<a class="dashboard-view-all" href="/releases?schedule=unscheduled">View all 12');
    });
  });

  describe('Scheduled releases', () => {
    it('groups rows, formats times with the clock preference, and offers Publish only where it is actionable', async () => {
      const projectId = await createProject(app, { title: 'Schedule Project' });
      const lateId = insertRelease(db, projectId, { title: 'Late Release', plannedDate: addDays(today, -4) });
      const todayId = insertRelease(db, projectId, { title: 'Today Release', plannedDate: today, plannedTime: '13:05' });
      const soonId = insertRelease(db, projectId, { title: 'Soon Release', plannedDate: addDays(today, 2) });
      addMissingSelectedAsset(projectId, soonId, 'soon-missing.txt');

      for (const [preference, time] of [['12h', '1:05 PM'], ['24h', '13:05']]) {
        app.locals.clockFormatSettingsService.setClockFormat(preference);
        const res = await app.testAgent.get('/').expect(200);
        expect(extractReleaseRow(res.text, todayId)).toContain(`<span class="dashboard-date-block-time">${time}</span>`);
      }

      const res = await app.testAgent.get('/').expect(200);
      const panel = extractScheduledPanel(res.text);
      const groups = [...panel.matchAll(/data-dashboard-schedule-group="([^"]+)"/g)].map((match) => match[1]);
      const late = extractReleaseRow(res.text, lateId);
      const soon = extractReleaseRow(res.text, soonId);

      expect(groups).toEqual(['overdue', 'today', 'next7']);
      expect(late).toContain('4 days late');
      expect(late).toContain('Any time');
      expect(late).toContain(`href="/releases/${lateId}/publish" aria-label="Publish Late Release">Publish</a>`);
      expect(extractReleaseRow(res.text, todayId)).toContain(`href="/releases/${todayId}/publish"`);
      expect(soon).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="dashboard-release-info-scheduled-${soonId}" aria-expanded="false">Soon Release</button>`);
      expect(soon).toContain(`href="/releases/${soonId}">Open release</a>`);
      expect(soon).not.toContain('dashboard-release-row-action');
      expect(soon).toContain('1 missing');
      expect(soon).toContain(`href="/projects/${projectId}"`);
      expect(soon).not.toContain('days late');
    });

    it('keeps the true Later total with View all when more than five exist', async () => {
      const projectId = await createProject(app, { title: 'Later Project' });
      for (let index = 0; index < 7; index += 1) {
        insertRelease(db, projectId, { title: `Later ${index}`, plannedDate: addDays(today, 20 + index) });
      }

      const res = await app.testAgent.get('/').expect(200);
      const later = res.text.match(/<section class="dashboard-schedule-group dashboard-schedule-group--later"[\s\S]*?<\/section>/)?.[0] || '';

      expect((later.match(/data-dashboard-release-row/g) || [])).toHaveLength(5);
      expect(later).toContain('<span class="dashboard-schedule-group-count">7</span>');
      expect(later).toContain('<a class="dashboard-view-all" href="/releases?schedule=upcoming">View all 7');
      expect(later).toContain('aria-label="Open Later 0">Open</a>');
    });

    it('shows long titles in full text with the full title in the popover instead of a native tooltip', async () => {
      const projectId = await createProject(app, { title: 'Long Title Project' });
      const longTitle = `Chapter ${'very long words '.repeat(12)}& <finale>`;
      const releaseId = insertRelease(db, projectId, { title: longTitle, plannedDate: addDays(today, 3) });

      const res = await app.testAgent.get('/').expect(200);
      const escaped = longTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const row = extractReleaseRow(res.text, releaseId);
      expect(row).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="dashboard-release-info-scheduled-${releaseId}" aria-expanded="false">${escaped}</button>`);
      expect(row).toContain(`<h3 class="asset-viewer-grid-card-info-heading">${escaped}</h3>`);
      expect(row).toContain(`aria-label="Details for ${escaped}"`);
      expect(res.text).not.toContain('<finale>');
    });
  });

  describe('Recently published', () => {
    it('renders up to four published releases with dates, social outcome, and archived exclusions', async () => {
      const projectId = await createProject(app, { title: 'Published Project' });
      const ids = Array.from({ length: 5 }, (_, index) => insertRelease(db, projectId, {
        title: `Published ${index}`,
        publishedDate: addDays(today, -(index + 1)),
      }));
      insertRelease(db, projectId, { title: 'Archived Published', publishedDate: today, archivedAt: '2026-01-01 00:00:00' });

      const res = await app.testAgent.get('/').expect(200);
      const panel = extractRecentPanel(res.text);
      const rendered = [...panel.matchAll(/<li class="dashboard-recent-item" data-release-id="(\d+)"/g)].map((match) => Number(match[1]));

      expect(rendered).toEqual(ids.slice(0, 4));
      expect(panel).toContain(`<time datetime="${addDays(today, -1)}">`);
      expect(panel).toContain('No social posts');
      expect(panel).not.toContain('Archived Published');
    });
  });

  describe('Projects table', () => {
    it('uses real table semantics, catalogue badges, asset counts, and next-release states', async () => {
      app.locals.projectOptionCatalogueService.addOption('status', { name: 'Editorial Review', color: '#123456' });
      const editorialId = await createProject(app, { title: 'Editorial Project', status: 'editorial-review', projectType: 'comic' });
      const mixedId = await createProject(app, { title: 'Mixed Project', status: 'ready' });
      const lateId = insertRelease(db, mixedId, { title: 'Mixed Late', plannedDate: addDays(today, -2) });
      insertRelease(db, mixedId, { title: 'Mixed Undated' });
      addMissingSelectedAsset(mixedId, lateId, 'mixed.txt');
      const undatedOnlyId = await createProject(app, { title: 'Undated Only', status: 'ready' });
      insertRelease(db, undatedOnlyId, { title: 'Only Undated' });

      const res = await app.testAgent.get('/').expect(200);
      const panel = extractProjectsPanel(res.text);
      const table = extractById(panel, 'table', 'dashboard-projects-table');

      expect(panel).toContain('<div class="dashboard-table-scroll" role="region" aria-labelledby="dashboard-projects-heading" tabindex="0" data-dashboard-projects-table-region>');
      expect(table).toContain('data-complete="true"');
      expect(res.text).toContain('aria-labelledby="dashboard-projects-heading" data-dashboard-projects>');
      expect(panel).toContain('<p class="dashboard-empty-line" data-dashboard-projects-filter-empty hidden>No projects match this status.</p>');
      expect(panel).toContain('<span data-dashboard-projects-count aria-live="polite">3 of 3 active projects');
      expect(table).toContain('<caption class="sr-only">');
      expect([...table.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]))
        .toEqual(['Project', 'Status', 'Type', 'Assets', 'Next release', 'Last published', 'Updated']);
      expect(table).toContain('<th scope="col" aria-sort="descending">Updated</th>');

      const editorial = extractProjectRow(table, editorialId);
      expect(editorial).toContain('data-status="editorial-review"');
      expect(editorial).toContain('style="--project-badge-bg: #123456; --project-badge-tint: 18%; --project-badge-fg: #8495A7">Editorial Review</span>');
      expect(editorial).toContain('project-type-badge');
      expect(editorial).toContain('None planned');

      const mixed = extractProjectRow(table, mixedId);
      expect(mixed).toContain('(1 missing)');
      expect(mixed).toContain(`<a class="dashboard-next-release dashboard-next-release--overdue" href="/releases/${lateId}"`);
      expect(mixed).toContain('Overdue · ');
      expect(mixed).toContain('(+1 no date)');

      expect(extractProjectRow(table, undatedOnlyId)).toContain('dashboard-next-release--undated">No date set</span>');
      expect(extractProjectRow(table, undatedOnlyId)).not.toContain('no date)');
      expect(panel).toContain('3 of 3 active projects · archived hidden');
      expect(panel).toContain('<a class="dashboard-view-all" href="/projects">Open in Projects');
    });

    it('renders disabled status filter toggles for every non-archived catalogue status, including zero counts', async () => {
      app.locals.projectOptionCatalogueService.addOption('status', { name: 'Editorial Review', color: '#123456' });
      await createProject(app, { title: 'Ready Tab Project', status: 'ready' });

      const res = await app.testAgent.get('/').expect(200);
      const tabs = res.text.match(/<div class="dashboard-status-tabs"[\s\S]*?<\/div>/)?.[0] || '';
      const values = [...tabs.matchAll(/data-dashboard-status-filter="([^"]+)"/g)].map((match) => match[1]);
      const catalogue = app.locals.projectOptionCatalogueService.getStatusCatalogue()
        .map(({ value }) => value).filter((value) => value !== 'archived');

      expect(tabs).toContain('role="group" aria-label="Filter projects by status"');
      expect(values).toEqual(['all', ...catalogue]);
      expect(values).toContain('editorial-review');
      expect(values).not.toContain('archived');
      expect(tabs).toMatch(/aria-pressed="true"\s+aria-controls="dashboard-projects-table"\s+data-dashboard-status-filter="all"/);
      expect((tabs.match(/aria-controls="dashboard-projects-table"/g) || [])).toHaveLength(values.length);
      expect(res.text).toContain('id="dashboard-projects-table"');
      expect((tabs.match(/type="button" disabled/g) || [])).toHaveLength(values.length);
      expect(tabs).toMatch(/Editorial Review<\/span>\s*<span class="dashboard-status-tab-count">0<\/span>/);
    });

    it('caps rows at fifty unique projects and links incomplete tabs to the Projects page', async () => {
      for (let index = 0; index < 52; index += 1) {
        const id = await createProject(app, { title: `Bulk ${index}`, status: 'ready' });
        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
          .run(`2026-01-01 00:${String(index).padStart(2, '0')}:00`, id);
        if (index === 0) {
          insertRelease(db, id, { title: 'Bulk Release A', plannedDate: addDays(today, 1) });
          insertRelease(db, id, { title: 'Bulk Release B', plannedDate: addDays(today, 2) });
        }
      }
      const archivedId = await createProject(app, { title: 'Archived Bulk' });
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archivedId);
      const legacyArchivedId = await createProject(app, { title: 'Legacy Archived Bulk' });
      db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(legacyArchivedId);

      const res = await app.testAgent.get('/').expect(200);
      const panel = extractProjectsPanel(res.text);
      const rowIds = [...panel.matchAll(/data-dashboard-project-row data-project-id="(\d+)"/g)].map((match) => match[1]);
      const nav = panel.match(/<nav class="dashboard-status-tabs"[\s\S]*?<\/nav>/)?.[0] || '';

      expect(rowIds).toHaveLength(50);
      expect(new Set(rowIds).size).toBe(50);
      expect(panel).toContain('data-complete="false"');
      expect(panel).toContain('50 of 52 active projects · archived hidden');
      expect(panel).not.toContain('data-dashboard-projects-filter-empty');
      expect(panel).toContain('<span data-dashboard-projects-count>50 of 52');
      expect(panel).not.toContain('Archived Bulk');
      expect(nav).toContain('aria-label="Project status filters"');
      expect(nav).toContain('href="/projects?status=all"');
      expect(nav).toContain('href="/projects?status=ready"');
      expect(nav).toMatch(/<a class="dashboard-status-tab" href="\/projects\?status=all" data-dashboard-status-link="all"><span class="dashboard-status-tab-label">All<\/span>\s*<span class="dashboard-status-tab-count">52<\/span>/);
      expect(nav).toMatch(/Ready<\/span>\s*<span class="dashboard-status-tab-count">52<\/span>/);
      expect(nav).not.toContain('status=archived');
      expect(panel).not.toContain('data-dashboard-status-filter=');
    });
  });

  describe('title popovers', () => {
    it('renders the Calendar release card for release titles with record-valid actions', async () => {
      app.locals.clockFormatSettingsService.setClockFormat('12h');
      const projectId = await createProject(app, { title: 'Popover Project' });
      const plannedId = insertRelease(db, projectId, { title: 'Planned <One>', plannedDate: addDays(today, 2), plannedTime: '18:05' });
      db.prepare('UPDATE releases SET notes = ? WHERE id = ?').run('Remember & check', plannedId);
      const publishedId = insertRelease(db, projectId, { title: 'Shipped One', publishedDate: addDays(today, -1) });

      const res = await app.testAgent.get('/').expect(200);
      const planned = extractReleaseRow(res.text, plannedId);
      const published = extractRecentPanel(res.text);

      expect(planned).toContain('data-dashboard-title-info');
      expect(planned).toContain(`id="dashboard-release-info-scheduled-${plannedId}" class="asset-viewer-grid-card-info calendar-release-info calendar-release-info--glass" data-calendar-info-card popover="manual"`);
      expect(planned).toContain('aria-label="Details for Planned &lt;One&gt;"');
      expect(planned).toContain(`href="/releases/${plannedId}">Open release</a>`);
      expect(planned).toContain(`href="/releases/${plannedId}/edit">Edit release</a>`);
      expect(planned).toContain(`href="/projects/${projectId}">Open project</a>`);
      expect(planned).toContain('<dt>Status</dt><dd>Planned</dd>');
      expect(planned).toContain(`${addDays(today, 2)} 6:05 PM</time>`);
      expect(planned).toContain('<dt>Platforms</dt><dd>None</dd>');
      expect(planned).toContain('<p class="calendar-release-info-notes">Remember &amp; check</p>');

      expect(published).toContain(`id="dashboard-release-info-recent-${publishedId}"`);
      expect(published).toContain('<dt>Status</dt><dd>Published</dd>');
      expect(published).not.toContain(`/releases/${publishedId}/edit`);
    });

    it('renders a project-only card for project titles wherever they appear', async () => {
      app.locals.projectOptionCatalogueService.addOption('status', { name: 'Editorial Review', color: '#123456' });
      const projectId = await createProject(app, { title: 'Card Project', status: 'editorial-review', projectType: 'comic' });
      const releaseId = insertRelease(db, projectId, { title: 'Card Release', plannedDate: addDays(today, 3) });
      addMissingSelectedAsset(projectId, releaseId, 'card.txt');

      const res = await app.testAgent.get('/').expect(200);
      const tableRow = extractProjectRow(res.text, projectId);
      const releaseRow = extractReleaseRow(res.text, releaseId);
      const tableCard = tableRow.match(/<div id="dashboard-project-info-table-\d+"[\s\S]*?<\/dl>/)?.[0] || '';
      const rowCard = releaseRow.match(/<div id="dashboard-project-info-scheduled-\d+"[\s\S]*?<\/dl>/)?.[0] || '';

      expect(tableRow).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="dashboard-project-info-table-${projectId}" aria-expanded="false">Card Project</button>`);
      for (const card of [tableCard, rowCard]) {
        expect(card).toContain('data-calendar-info-card popover="manual"');
        expect(card).toContain(`href="/projects/${projectId}">Open project</a>`);
        expect(card).toContain(`href="/projects/${projectId}/edit">Edit project</a>`);
        expect(card).not.toContain('Open release');
        expect(card).toContain('Editorial Review');
        expect(card).toContain('<dt>Type</dt>');
        expect(card).toContain('<dt>Assets</dt><dd>1 (1 missing)</dd>');
        expect(card).toContain('<dt>Next release</dt>');
      }
      expect(rowCard.replace(/id="[^"]+"/, '')).toBe(tableCard.replace(/id="[^"]+"/, ''));
    });

    it('renders current titles for retained releases outside every capped list, and only on request', async () => {
      const projectId = await createProject(app, { title: 'Retained Project' });
      // Five earlier Later releases push the retained one past the Later cap.
      for (let index = 0; index < 5; index += 1) {
        insertRelease(db, projectId, { title: `Later ${index}`, plannedDate: addDays(today, 30 + index) });
      }
      const retainedId = insertRelease(db, projectId, { title: 'Retained Release', plannedDate: addDays(today, 60) });
      const undatedId = insertRelease(db, projectId, { title: 'Still Undated' });
      const archivedProjectId = await createProject(app, { title: 'Gone Project' });
      const goneId = insertRelease(db, archivedProjectId, { title: 'Gone Release', plannedDate: addDays(today, 5) });
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archivedProjectId);

      const plain = await app.testAgent.get('/').expect(200);
      expect(plain.text).not.toContain('data-dashboard-retained-titles');
      expect(extractReleaseRow(plain.text, retainedId)).toBe('');

      const res = await app.testAgent.get(`/?retain=${retainedId},${goneId},bogus,-3`).expect(200);
      const template = res.text.match(/<template data-dashboard-retained-titles>[\s\S]*?<\/template>/)?.[0] || '';
      expect(extractNeedsDatePanel(res.text)).toContain(template);
      expect(template).toContain(`data-dashboard-retained-release data-release-id="${retainedId}"`);
      expect(template).not.toContain(`data-release-id="${goneId}"`);
      expect(template).toContain(`id="dashboard-release-info-needs-date-${retainedId}"`);
      expect(template).toContain(`<time datetime="${addDays(today, 60)}">${addDays(today, 60)}</time>`);
      expect(template).toContain(`id="dashboard-project-info-needs-date-${retainedId}"`);
      // The project summary comes from the server's own projection, so it
      // matches the Projects table row for the same project.
      const tableCard = extractProjectRow(res.text, projectId).match(/<dl[\s\S]*?<\/dl>/)?.[0] || '';
      const retainedCard = template.match(/<div id="dashboard-project-info-needs-date-\d+"[\s\S]*?<\/dl>/)?.[0].match(/<dl[\s\S]*?<\/dl>/)?.[0] || '';
      expect(retainedCard).toContain('<dt>Next release</dt>');
      expect(retainedCard).toBe(tableCard);
      // Retaining a release changes no other server-owned region.
      expect(extractNeedsDateItem(res.text, undatedId)).toBe(extractNeedsDateItem(plain.text, undatedId));
      expect(extractScheduledPanel(res.text)).toBe(extractScheduledPanel(plain.text));
    });

    it('renders titles for every retained release beyond the Needs-a-date cap while that list stays capped', async () => {
      const projectId = await createProject(app, { title: 'Many Project' });
      const retainedIds = Array.from({ length: 14 }, (_, index) => insertRelease(db, projectId, {
        title: `Scheduled ${index}`,
        plannedDate: addDays(today, 40 + index),
      }));
      const undatedIds = Array.from({ length: 12 }, (_, index) => insertRelease(db, projectId, { title: `Undated ${index}` }));

      const plain = await app.testAgent.get('/').expect(200);
      const retain = [...retainedIds, retainedIds[0], 'bogus', '0', '-3', '1.5', '', '99999999999999999'].join(',');
      const res = await app.testAgent.get(`/?retain=${retain}`).expect(200);
      const template = res.text.match(/<template data-dashboard-retained-titles>[\s\S]*?<\/template>/)?.[0] || '';
      const renderedIds = [...template.matchAll(/data-dashboard-retained-release data-release-id="(\d+)"/g)]
        .map(([, id]) => Number(id));
      expect(renderedIds).toEqual(retainedIds);
      for (const id of retainedIds) {
        expect(template).toContain(`id="dashboard-release-info-needs-date-${id}"`);
        expect(template).toContain(`id="dashboard-project-info-needs-date-${id}"`);
      }
      // Retaining releases neither lifts the undated display cap nor changes
      // the authoritative undated total.
      const collapse = (html) => html.replace(/\s+/g, ' ');
      const panel = extractNeedsDatePanel(res.text).replace(template, '');
      expect(collapse(panel)).toBe(collapse(extractNeedsDatePanel(plain.text)));
      expect(undatedIds.filter((id) => extractNeedsDateItem(res.text, id))).toHaveLength(10);
      expect(panel).toContain('href="/releases?schedule=unscheduled"');
    });
  });

  describe('NSFW thumbnail blur', () => {
    it('blurs NSFW-tagged project thumbnails across regions only while the global filter is enabled', async () => {
      const projectId = await createProject(app, { title: 'Spicy Project' });
      seedPrimaryImage(projectId);
      tagProjectNsfw(projectId);
      const releaseId = insertRelease(db, projectId, { title: 'Spicy Release', plannedDate: addDays(today, 2) });

      app.locals.nsfwFilterSettingsService.setEnabled(true);
      const enabled = await app.testAgent.get('/').expect(200);
      const enabledRow = extractReleaseRow(enabled.text, releaseId);
      const enabledProject = extractProjectRow(enabled.text, projectId);

      expect(enabledRow).toContain('data-preview-image');
      expect(enabledRow).toContain('class="dashboard-thumb-image project-image--nsfw-blurred"');
      expect(enabledProject).toContain('class="dashboard-thumb-image project-image--nsfw-blurred"');
      expect(enabledRow).toContain('class="calendar-release-info-image project-image--nsfw-blurred');
      expect(enabledProject).toContain('class="calendar-release-info-image project-image--nsfw-blurred');
      expect(enabled.text).not.toContain('id="projects-nsfw-toggle"');

      app.locals.nsfwFilterSettingsService.setEnabled(false);
      const disabled = await app.testAgent.get('/').expect(200);
      expect(extractReleaseRow(disabled.text, releaseId)).toContain('class="dashboard-thumb-image"');
      expect(disabled.text).not.toContain('project-image--nsfw-blurred');
    });
  });

  describe('New Project dialog hosting', () => {
    it('renders one closed native New Project dialog with the standalone form defaults', async () => {
      app.locals.pageDefaultsService.saveDefault('new_project', 'status', 'ready');
      app.locals.tagService.createTag({ name: 'Dashboard dialog tag' });

      const [dashboard, standalone] = await Promise.all([
        app.testAgent.get('/').expect(200),
        app.testAgent.get('/projects/new').expect(200),
      ]);
      const dialog = extractProjectCreateDialog(dashboard.text);

      expect((dashboard.text.match(/<dialog id="project-create-dialog"/g) || [])).toHaveLength(1);
      expect(dialog).not.toBe('');
      expect(dialog).not.toMatch(/<dialog\b[^>]*\bopen(?:\s|>|=)/);
      const footer = dialog.match(/<footer class="app-dialog-footer">[\s\S]*?<\/footer>/)?.[0] || '';
      expect(footer).toContain('Create project');
      expect(footer).not.toContain('Cancel');
      expect(dialog).toContain('<form id="project-create-form" method="post" action="/projects"');
      expect(dialog).toContain('data-dialog-form data-dialog-async="false"');
      expect(dialog).toContain('name="returnTo" value="/"');
      expect(dialog).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
      expect(standalone.text).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
      expect(dialog).toContain('Dashboard dialog tag');
    });

    it('re-renders the Dashboard with the open dialog, submitted values, and errors after invalid creation', async () => {
      const res = await app.testAgent
        .post('/projects')
        .type('form')
        .send({ title: '', status: 'ready', projectType: 'images', priority: 'normal', returnTo: '/', notes: 'Keep these notes', _csrf: app.testCsrfToken })
        .expect(422);
      const dialog = extractProjectCreateDialog(res.text);

      expect(countTags(res.text, 'h1')).toBe(1);
      expect(res.text).toContain('<h1 class="app-section-title">Dashboard</h1>');
      expect(res.text).toContain('id="dashboard-projects-heading"');
      expect(dialog).toMatch(/<dialog\b[^>]*\bopen(?:\s|>|=)/);
      expect(dialog).toContain('name="returnTo" value="/"');
      expect(dialog).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
      expect(dialog).toContain('Keep these notes');
      expect(dialog).toMatch(/aria-invalid="true"/);
    });
  });

  describe('retired section configuration', () => {
    const LEGACY_DASHBOARD_DEFAULTS_KEY = 'page_defaults.dashboard';
    const LEGACY_DASHBOARD_DEFAULTS = JSON.stringify({
      version: 1,
      order: ['status:archived', 'recently-updated', 'status:tbd'],
      sections: {
        'recently-updated': { visible: false, itemCount: 1, sort: 'title', order: 'asc' },
        'status:tbd': { visible: false, itemCount: 1, sort: 'created', order: 'asc' },
      },
    });

    function stripCsrf(html) {
      return html.replace(/name="_csrf" value="[^"]*"/g, '').replace(/<meta name="csrf-token" content="[^"]*">/g, '');
    }

    it('no longer serves POST /dashboard/defaults and writes no section configuration', async () => {
      await app.testAgent
        .post('/dashboard/defaults')
        .type('form')
        .send({ _csrf: app.testCsrfToken, orderedSectionIds: 'recently-updated', sections: {} })
        .expect(404);

      expect(app.locals.appMetaRepository.getValue(LEGACY_DASHBOARD_DEFAULTS_KEY)).toBeFalsy();
    });

    it('leaves a stored legacy Dashboard configuration intact and inert', async () => {
      const projectId = await createProject(app, { title: 'Legacy Visible', status: 'tbd' });
      insertRelease(db, projectId, { title: 'Undated Legacy Release' });
      const before = await app.testAgent.get('/').expect(200);

      app.locals.appMetaRepository.setValue(LEGACY_DASHBOARD_DEFAULTS_KEY, LEGACY_DASHBOARD_DEFAULTS);
      const after = await app.testAgent.get('/').expect(200);

      expect(stripCsrf(after.text)).toBe(stripCsrf(before.text));
      expect(extractProjectRow(after.text, projectId)).toContain('Legacy Visible');
      expect(app.locals.appMetaRepository.getValue(LEGACY_DASHBOARD_DEFAULTS_KEY)).toBe(LEGACY_DASHBOARD_DEFAULTS);
    });

    it('starts an app over a database that still stores legacy Dashboard defaults', () => {
      app.locals.appMetaRepository.setValue(LEGACY_DASHBOARD_DEFAULTS_KEY, '{not json');
      const appDataRoot = path.join(tmpDir, 'upgrade-app');
      fs.mkdirSync(appDataRoot, { recursive: true });
      const { csrfPepper } = ensureAuthEnablement(appDataRoot);

      const upgraded = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });

      expect(upgraded.locals).not.toHaveProperty('dashboardDefaultsService');
      expect(app.locals.appMetaRepository.getValue(LEGACY_DASHBOARD_DEFAULTS_KEY)).toBe('{not json');
    });

    it('starts the calendar strip on the saved Calendar week start', async () => {
      for (const [weekStart, weekday] of [['sunday', 0], ['monday', 1]]) {
        app.locals.pageDefaultsService.saveDefault('calendar', 'weekStart', weekStart);
        const res = await app.testAgent.get('/').expect(200);
        const firstDate = res.text.match(/<li class="dashboard-strip-day[^"]*" data-date="(\d{4}-\d{2}-\d{2})">/)?.[1];

        expect(firstDate).toBeTruthy();
        expect(new Date(`${firstDate}T00:00:00Z`).getUTCDay()).toBe(weekday);
      }
    });
  });
});
