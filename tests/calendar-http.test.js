import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const css = fs.readFileSync(fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)), 'utf8');

function project(db, title) {
  const slug = `calendar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return db.prepare(`INSERT INTO projects (title, slug, description, notes, status, project_type)
    VALUES (?, ?, '', '', 'tbd', 'images') RETURNING id`).get(title, slug);
}

function release(db, projectId, title, { notes = '', plannedTime = null, publishedDate = null } = {}) {
  return db.prepare(`INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, published_date)
    VALUES (?, ?, '', ?, '2025-06-15', ?, ?) RETURNING id`).get(projectId, title, notes, plannedTime, publishedDate);
}

describe('Calendar presentation', () => {
  let db;
  let app;
  let tmpDir;
  let agent;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-calendar-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, migrationsDir);
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

  it('renders the readable month, controls, grid, agenda and shared Calendar/List toggle', async () => {
    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    expect(html).toMatch(/<h2 tabindex="-1" data-calendar-month-heading>\s*<button[^>]*data-dialog-open="calendar-month-dialog"[^>]*aria-haspopup="dialog"[^>]*aria-controls="calendar-month-dialog"[^>]*>June 2025<\/button>/);
    expect(html).toContain('data-calendar-month="2025-06"');
    const navigation = html.match(/<div class="calendar-nav-right">([\s\S]*?)<\/div>/)?.[1] || '';
    expect([...navigation.matchAll(/aria-label="(Previous month|Today|Next month)"/g)].map((match) => match[1]))
      .toEqual(['Previous month', 'Today', 'Next month']);
    expect(navigation).toContain('data-tooltip="Previous month"');
    expect(navigation).toContain('data-tooltip="Today"');
    expect(navigation).toContain('data-tooltip="Next month"');
    expect(navigation).toContain('<path d="M15 18l-6-6 6-6"/>');
    expect(navigation).toContain('<rect x="3" y="5" width="18" height="16" rx="2"/>');
    expect(navigation).toContain('<path d="M9 18l6-6-6-6"/>');
    const picker = html.match(/<dialog id="calendar-month-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(picker).toContain('>Choose month</h2>');
    expect(picker).toContain('name="pickerMonth"');
    expect(picker).toContain('name="pickerYear" type="number" min="1000" max="9999"');
    expect(picker).not.toContain('class="app-dialog-footer"');
    expect(picker).toContain('data-dialog-close aria-label="Close Choose month"');
    expect(picker).toContain('class="field app-dialog-field calendar-month-year"');
    expect(css).toMatch(/\.calendar-month-year \.cc-number-stepper\s*\{\s*min-height:\s*2\.5rem/);
    expect(html).toContain('data-calendar-live-region');
    expect(html).toContain('data-calendar-live-status');
    expect(html).toContain('data-calendar-navigation');
    expect(html).toContain('data-calendar-reset');
    expect(html).toContain('data-calendar-defaults-fetch-save');
    expect(html).toContain('aria-label="Calendar navigation"');
    expect(html).toContain('data-dialog-open="calendar-filter-dialog"');
    expect(html).toContain('data-dialog-open="calendar-defaults-dialog"');
    expect(html).toContain('class="calendar-view-grid" data-calendar-live-region');
    expect(html).toContain('<nav class="view-switcher" aria-label="Calendar display">');
    expect(html).toMatch(/class="view-switcher-option view-switcher-option--icon asset-tooltip asset-tooltip--right"[^>]*aria-current="page"[^>]*aria-label="Calendar view" data-tooltip="Calendar view"/);
    expect(html).toMatch(/href="\/calendar\?month=2025-06&amp;view=list"[^>]*aria-label="List view" data-tooltip="List view"/);
    expect(html).toContain('data-tooltip="Calendar view"><svg');
    expect(html).toContain('class="calendar-table" role="table"');
    expect(html).toContain('class="calendar-agenda"');
  });

  it('uses the existing agenda for desktop List and retains the mobile empty-day behavior', async () => {
    const parent = project(db, 'Agenda project');
    release(db, parent.id, 'Agenda release');
    const html = (await agent.get('/calendar?month=2025-06&view=list&status=planned').expect(200)).text;
    expect(html).toContain('class="calendar-view-list" data-calendar-live-region');
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="List view"/);
    expect(html).toContain('class="calendar-table" role="table"');
    expect(html).toContain('class="calendar-agenda"');
    expect(html).toContain('agenda-day-empty');
    expect(html).toContain('name="view" value="list"');
    expect(html).toContain('action="/calendar?month=2025-06&amp;view=list"');
    expect(html).toContain('href="/calendar?month=2025-05&amp;status=planned&amp;view=list"');
    expect(css).toMatch(/\.calendar-view-list \.calendar-scroll\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.calendar-view-list \.calendar-agenda\s*\{\s*display:\s*flex/);
    expect(css).toMatch(/\.calendar-view-list \.agenda-day-empty\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.calendar-view-switcher\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.calendar-view-list \.agenda-day-empty\s*\{\s*display:\s*block/);
  });

  it('keeps boundary navigation disabled while retaining the current Today state', async () => {
    const first = (await agent.get('/calendar?month=1000-01').expect(200)).text;
    const last = (await agent.get('/calendar?month=9999-12').expect(200)).text;
    expect(first).toMatch(/<span[^>]*aria-label="Previous month" aria-disabled="true"[^>]*>/);
    expect(first).not.toContain('id="calendar-previous"');
    expect(last).toMatch(/<span[^>]*aria-label="Next month" aria-disabled="true"[^>]*>/);
    expect(last).not.toContain('id="calendar-next"');
    const current = (await agent.get('/calendar').expect(200)).text;
    expect(current).toMatch(/<span[^>]*aria-label="Today" aria-disabled="true" aria-current="page"[^>]*>/);
    expect(current).not.toContain('id="calendar-today"');
  });

  it('uses the shared toolbar controls and styled tooltips for both dialogs', async () => {
    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    const toolbar = html.match(/<div class="asset-viewer-display-controls">\s*<div class="project-filter-actions project-filter-actions--projects">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] || '';
    const controls = [...toolbar.matchAll(/<a class="([^"]+)"\s+href="([^"]+)" aria-label="([^"]+)"\s+data-dialog-open="([^"]+)" data-tooltip="([^"]+)">([\s\S]*?)<\/a>/g)];

    expect(controls).toHaveLength(2);
    expect(controls.map(([, classes]) => classes)).toEqual([
      'button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left',
      'button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left',
    ]);
    expect(controls.map(([, , href, label, dialog, tooltip]) => ({ href, label, dialog, tooltip }))).toEqual([
      { href: '#calendar-filter-dialog', label: 'Filters', dialog: 'calendar-filter-dialog', tooltip: 'Filters' },
      { href: '/calendar?defaults=1', label: 'Page Defaults', dialog: 'calendar-defaults-dialog', tooltip: 'Page Defaults' },
    ]);
    expect(controls[0][6]).toContain('<path d="M3 5h18l-7 8v5l-4 2v-7z"/>');
    expect(controls[1][6]).toContain('<circle cx="12" cy="12" r="3"/>');
    expect(html.indexOf('asset-viewer-display-controls')).toBeLessThan(html.indexOf('data-calendar-live-region'));
    expect(html).not.toContain('class="page-heading-actions"');
    expect(html).toContain('<dialog id="calendar-filter-dialog"');
    expect(html).toContain('<dialog id="calendar-defaults-dialog"');
  });

  it('uses the shared filter and autosaving defaults dialog structures', async () => {
    const html = (await agent.get('/calendar?month=2025-06&project=7&status=planned&weekStart=sunday').expect(200)).text;
    const filters = html.match(/<dialog id="calendar-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    const defaults = html.match(/<dialog id="calendar-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    expect(filters).toContain('<form id="calendar-filters" class="app-dialog-form project-form"');
    expect(filters).toMatch(/<div class="app-dialog-body">\s*<div class="page-defaults-grid">/);
    const filterFields = [...filters.matchAll(/<fieldset class="([^"]+)"[^>]*>\s*<legend[^>]*>([^<]+)/g)];
    expect(filterFields.map(([, , label]) => label)).toEqual(['Project', 'Release status', 'Week starts']);
    expect(filterFields[0][1].split(' ')).toContain('projects-filter-field--project');
    expect(filters).toContain('class="field asset-filter-multiselect-field app-dialog-field asset-viewer-filter-field');
    expect(filters).toContain('asset-viewer-project-filter projects-filter-field--project');
    expect(filters).toContain('data-cc-dropdown-searchable');
    expect(filters).toContain('data-cc-dropdown-search');
    expect(filters).toContain('<form class="projects-filter-reset" method="get" action="/calendar?month=2025-06">');
    expect(filters).toContain('data-calendar-reset>Reset filters</button>');
    expect(filters).not.toContain('Apply filters');

    expect(defaults).toMatch(/<div class="app-dialog-error" data-dialog-error role="alert" hidden>/);
    expect(defaults).toMatch(/<div class="app-dialog-body">\s*<div class="page-defaults-grid">/);
    expect(defaults).toContain('data-dialog-field="status"');
    expect(defaults).toContain('data-dialog-field="weekStart"');
    expect(defaults.match(/data-autosubmit="fetch"/g)).toHaveLength(3);
    expect(defaults).toContain('data-dialog-field="view"');
    expect(defaults).toContain('name="calendarView"');
    expect(defaults).toContain('Desktop view');
    expect(defaults).toMatch(/<select[^>]*name="calendarStatus"[^>]*data-autosubmit="fetch"/);
    const statusOptions = defaults.match(/<select[^>]*name="calendarStatus"[^>]*>[\s\S]*?<\/select>/)?.[0] || '';
    expect(statusOptions).toMatch(/<option value="all"(?: selected)?>All releases<\/option>/);
    expect(defaults).toMatch(/<input id="calendar-default-status-option-1"[^>]*value="all"[^>]*>[\s\S]*?<span>All releases<\/span>/);
    expect(defaults).toMatch(/<select[^>]*name="calendarWeekStart"[^>]*data-autosubmit="fetch"/);
    expect(defaults).toContain('class="app-dialog-status" data-settings-fetch-save-status role="status" aria-live="polite" aria-atomic="true"');
    expect(defaults).not.toContain('Save defaults');
  });

  it('renders compact events and distinct top-layer details with escaped notes', async () => {
    const parent = project(db, 'Project Title');
    const item = release(db, parent.id, 'Release <Title>', { notes: 'Note <private> & more', plannedTime: '09:30' });
    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    expect((html.match(/class="calendar-release-title">Release &lt;Title&gt;<\/span>/g) || [])).toHaveLength(2);
    expect((html.match(/class="calendar-release-status">Planned<\/span>/g) || [])).toHaveLength(2);
    expect((html.match(/class="calendar-release-time" datetime="2025-06-15T09:30">09:30<\/time>/g) || [])).toHaveLength(2);
    for (const surface of ['grid', 'agenda']) {
      const id = `calendar-info-${surface}-${item.id}`;
      expect((html.match(new RegExp(`id="${id}"`, 'g')) || [])).toHaveLength(1);
      expect(html).toContain(`aria-controls="${id}"`);
    }
    expect((html.match(/data-calendar-info-card popover="manual"/g) || [])).toHaveLength(2);
    expect((html.match(/class="asset-viewer-grid-card-info calendar-release-info calendar-release-info--glass"/g) || [])).toHaveLength(2);
    expect((html.match(/class="calendar-release-info-layout"/g) || [])).toHaveLength(2);
    expect((html.match(/class="calendar-release-info-content"/g) || [])).toHaveLength(2);
    expect((html.match(/class="asset-viewer-grid-card-info-heading"/g) || [])).toHaveLength(2);
    expect((html.match(/class="asset-viewer-grid-card-info-list"/g) || [])).toHaveLength(2);
    expect(html).toContain('class="asset-viewer-grid-card-info-row"');
    expect(html).not.toContain('data-calendar-info-close');
    expect((html.match(/class="calendar-release-info-notes">Note &lt;private&gt; &amp; more<\/p>/g) || [])).toHaveLength(2);
    expect((html.match(new RegExp(`class="button button-small button-secondary" href="/releases/${item.id}">Open release</a>`, 'g')) || [])).toHaveLength(2);
    expect((html.match(new RegExp(`class="button button-small button-secondary" href="/projects/${parent.id}">Open project</a>`, 'g')) || [])).toHaveLength(2);
    expect(html.indexOf('>Open release</a>')).toBeLessThan(html.indexOf('class="asset-viewer-grid-card-info-heading"'));
    expect(html.indexOf('>Open project</a>')).toBeLessThan(html.indexOf('class="asset-viewer-grid-card-info-heading"'));
    expect(html).toContain('class="asset-viewer-grid-card-info-section-label">Notes</span>');
    expect(html).toContain(`href="/projects/${parent.id}">Project Title</a>`);
    expect(html).not.toContain('calendar-release-info--with-media');
    expect(html).not.toContain('class="calendar-release-info-media"');
    expect(html).not.toContain('calendar-release-project');
    expect(html).not.toContain('calendar-release-preview');
  });

  it('uses only the selected project primary image in details', async () => {
    const parent = project(db, 'Image Project');
    const item = release(db, parent.id, 'Image Release');
    const addAsset = (filename) => app.locals.assetScanner.repository.upsert(parent.id, filename, {
      filename, extension: 'png', mimeType: 'image/png', sizeBytes: 2048,
      modifiedAt: '2026-08-04 12:00:00',
    });
    const releaseAsset = addAsset('release-only.png');
    db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'preview', 0)`).run(item.id, releaseAsset.id);
    let html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    expect(html).not.toContain('calendar-release-info-image');
    expect(html).not.toContain('calendar-release-info--with-media');
    expect(html).not.toContain('class="calendar-release-info-media"');

    const primaryAsset = addAsset('project-primary.png');
    app.locals.projectPrimaryImageService.setPrimaryImage(parent.id, primaryAsset.id);
    html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    const images = html.match(/<img class="calendar-release-info-image[^>]+>/g) || [];
    expect(images).toHaveLength(2);
    expect((html.match(/class="asset-viewer-grid-card-info calendar-release-info calendar-release-info--glass calendar-release-info--with-media"/g) || [])).toHaveLength(2);
    expect((html.match(/class="calendar-release-info-media"/g) || [])).toHaveLength(2);
    expect((html.match(/class="calendar-release-info-layout"/g) || [])).toHaveLength(2);
    expect(images.every((tag) => tag.includes(`/projects/${parent.id}/assets/${primaryAsset.id}/preview?v=`))).toBe(true);
    expect(images.some((tag) => tag.includes(`/assets/${releaseAsset.id}/`))).toBe(false);
    expect(html).not.toContain('preview_url');
  });

  it('applies the established NSFW blur to a tagged project primary image', async () => {
    const parent = project(db, 'Sensitive project');
    release(db, parent.id, 'Sensitive release');
    const asset = app.locals.assetScanner.repository.upsert(parent.id, 'cover.png', {
      filename: 'cover.png', extension: 'png', mimeType: 'image/png', sizeBytes: 2048,
      modifiedAt: '2026-08-04 12:00:00',
    });
    app.locals.projectPrimaryImageService.setPrimaryImage(parent.id, asset.id);
    const tag = app.locals.tagService.createTag({ name: 'NSFW' });
    app.locals.projectTagService.replaceProjectTags(parent.id, [tag.id]);
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    expect((html.match(/class="calendar-release-info-image project-image--nsfw-blurred"/g) || [])).toHaveLength(2);
  });

  it('renders filtered state, Sunday order, defaults and a month-preserving reset', async () => {
    const parent = project(db, 'Project option');
    release(db, parent.id, 'Published event', { publishedDate: '2025-06-16' });
    const html = (await agent.get(`/calendar?month=2025-06&status=published&project=${parent.id}&weekStart=sunday`).expect(200)).text;
    expect(html).toMatch(/role="columnheader">Sun<\/div>[\s\S]*?role="columnheader">Mon<\/div>/);
    expect(html).toContain('class="calendar-release-status">Published</span>');
    for (const name of ['status', 'project', 'weekStart', 'calendarStatus', 'calendarWeekStart']) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain(`value="${parent.id}"`);
    expect(html).toContain('month=2025-06');
  });

  it('keeps the grid and agenda in a filtered empty month', async () => {
    const html = (await agent.get('/calendar?month=2099-01&status=planned').expect(200)).text;
    expect(html).toContain('No releases match these filters.');
    expect(html).toContain('class="calendar-table" role="table"');
    expect(html).toContain('class="calendar-agenda"');
  });

  it('removes inline expansion and bounds the top-layer card', () => {
    expect(css).not.toContain('.calendar-release-preview');
    expect(css).not.toMatch(/\.calendar-release-trigger:hover\s*>/);
    expect(css).toMatch(/\.asset-viewer-grid-card-info\s*\{[^}]*position:\s*fixed;[^}]*backdrop-filter:/);
    expect(css).toMatch(/\.calendar-release-info--glass\s*\{[^}]*background:/);
    expect(css).not.toMatch(/\.calendar-release-info\s*\{/);
  });

  it('preserves the compatibility redirect', async () => {
    const response = await agent.get('/releases/calendar?month=2025-06&source=legacy').expect(302);
    expect(response.headers.location).toBe('/calendar?month=2025-06&source=legacy');
  });
});
