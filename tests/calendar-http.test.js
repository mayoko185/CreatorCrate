import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { calendarResetFiltersDestination } from '../src/static/client/calendar-filters-defaults.js';
import { getLocalTodayIso } from '../src/util/date.js';

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

function infoCard(html, surface, releaseId) {
  const start = html.indexOf(`id="calendar-info-${surface}-${releaseId}"`);
  if (start < 0) return '';
  return html.slice(start, html.indexOf('</dl>', start));
}

function authorityOf(html) {
  const json = html.match(/<script type="application\/json" data-calendar-defaults-authority>([\s\S]*?)<\/script>/)?.[1];
  return json ? JSON.parse(json) : null;
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
    expect(navigation).toMatch(/<a id="calendar-today"[^>]*aria-label="Today"[^>]*><svg[\s\S]*?<rect x="3" y="5" width="18" height="16" rx="2"\/>[\s\S]*?<\/svg><span class="calendar-nav-label">Today<\/span><\/a>/);
    const picker = html.match(/<dialog id="calendar-month-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(picker).toContain('>Choose month</h2>');
    expect(picker).toContain('name="pickerMonth"');
    expect(picker).toContain('name="pickerYear" type="number" min="1000" max="9999"');
    expect(picker).not.toContain('class="app-dialog-footer"');
    expect(picker).toContain('data-dialog-close aria-label="Close Choose month"');
    expect(picker).toContain('class="field app-dialog-field calendar-month-year"');
    expect(html).toContain('data-calendar-live-region');
    expect(html).toContain('data-calendar-live-status');
    expect(html).toContain('data-calendar-navigation');
    // WP14b: one combined Filters & Defaults dialog; the legacy autosave
    // Defaults dialog and its entry are retired.
    expect(html).toContain('data-calendar-filters-reset');
    expect(html).not.toContain('data-calendar-defaults-fetch-save');
    expect(html).toContain('data-defaults-explicit-save');
    expect(html).toContain('aria-label="Calendar navigation"');
    expect(html).toContain('data-dialog-open="calendar-filter-dialog"');
    expect(html).not.toContain('calendar-defaults-dialog');
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
    // WP14b: Desktop view is a visible control of the combined dialog's GET
    // form; Reset filters keeps only the month (the saved View applies).
    expect(html).toMatch(/<input id="calendar-view-option-2" name="view" type="radio" value="list" checked>/);
    expect(html).toMatch(/<form class="calendar-filter-reset filters-defaults-reset-form" method="get" action="\/calendar">\s*<input type="hidden" name="month" value="2025-06">/);
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
    expect(current).toMatch(/<span[^>]*aria-label="Today" aria-disabled="true" aria-current="page"[^>]*><svg[\s\S]*?<rect x="3" y="5" width="18" height="16" rx="2"\/>[\s\S]*?<\/svg><span class="calendar-nav-label">Today<\/span><\/span>/);
    expect(current).not.toContain('id="calendar-today"');
  });

  it('R6: renders the server-resolved current month for a monthless, invalid or explicit Calendar', async () => {
    const regionOf = (html) => html.match(/data-calendar-live-region data-calendar-month="([^"]*)" data-calendar-current-month="([^"]*)"/);
    const before = getLocalTodayIso().slice(0, 7);
    const pages = await Promise.all(['/calendar', '/calendar?month=2031-13', '/calendar?month=2025-06']
      .map(async (url) => regionOf((await agent.get(url).expect(200)).text)));
    const after = getLocalTodayIso().slice(0, 7);
    // The application-local month, read on both sides of the requests.
    const current = pages[0][2];
    expect([before, after]).toContain(current);
    expect(current).toMatch(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/);
    // Monthless (Today) and invalid months resolve to it; an explicit month
    // keeps its own month and still reports the current one.
    expect(pages[0][1]).toBe(current);
    expect(pages[1].slice(1)).toEqual([current, current]);
    expect(pages[2].slice(1)).toEqual(['2025-06', current]);
  });

  it('places the view toggle, navigation and Filters/Calendar defaults in one Calendar header controls row', async () => {
    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    const nav = html.match(/<div class="calendar-nav" aria-label="Calendar navigation">([\s\S]*?)<\/div>\s*<p class="results-meta">/)?.[1] || '';
    const toolbar = nav.match(/<div class="calendar-nav-actions project-filter-actions project-filter-actions--projects">([\s\S]*?)<\/div>/)?.[1] || '';
    const controls = [...toolbar.matchAll(/<a class="([^"]+)"\s+href="([^"]+)" aria-label="([^"]+)"\s+data-dialog-open="([^"]+)" data-tooltip="([^"]+)">([\s\S]*?)<\/a>/g)];

    const viewIndex = nav.indexOf('class="calendar-view-switcher"');
    const headingIndex = nav.indexOf('data-calendar-month-heading');
    const navIndex = nav.indexOf('class="calendar-nav-right"');
    const actionsIndex = nav.indexOf('class="calendar-nav-actions');
    expect(viewIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeGreaterThan(viewIndex);
    expect(navIndex).toBeGreaterThan(headingIndex);
    expect(actionsIndex).toBeGreaterThan(navIndex);
    expect(nav).toMatch(/<a id="calendar-today"[^>]*aria-label="Today"[^>]*><svg[\s\S]*?<rect x="3" y="5" width="18" height="16" rx="2"\/>[\s\S]*?<\/svg><span class="calendar-nav-label">Today<\/span><\/a>/);
    // WP14b: one Filters & Defaults entry replaces the separate Filters and
    // Calendar defaults entries, in the Filters button's place.
    expect(html.match(/data-dialog-open="calendar-filter-dialog"/g)).toHaveLength(1);
    expect(html).not.toContain('data-dialog-open="calendar-defaults-dialog"');
    expect(controls).toHaveLength(1);
    expect(controls.map(([, classes]) => classes)).toEqual([
      'button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left',
    ]);
    expect(controls.map(([, , href, label, dialog, tooltip]) => ({ href, label, dialog, tooltip }))).toEqual([
      { href: '#calendar-filter-dialog', label: 'Filters &amp; Defaults', dialog: 'calendar-filter-dialog', tooltip: 'Filters &amp; Defaults' },
    ]);
    expect(controls[0][6]).toContain('<path d="M3 5h18l-7 8v5l-4 2v-7z"/>');
    expect(html).not.toContain('asset-viewer-display-controls');
    expect(html.indexOf('<dialog id="calendar-filter-dialog"')).toBeGreaterThan(html.indexOf('<p class="results-meta">'));
    expect(html).not.toContain('Page Defaults');
    expect(html).not.toContain('class="page-heading-actions"');
    expect(html.match(/<dialog id="calendar-filter-dialog"/g)).toHaveLength(1);
    expect(html).not.toContain('<dialog id="calendar-defaults-dialog"');
    const dialog = html.match(/<dialog id="calendar-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(dialog).toContain('<h2 id="calendar-filter-dialog-title">Filters &amp; Defaults</h2>');
    expect(dialog).toContain('<p class="app-dialog-subtitle">Calendar</p>');
    expect(dialog).toContain('data-dialog-close aria-label="Close Filters &amp; Defaults"');
  });

  describe('WP14b combined Filters & Defaults dialog', () => {
    const dialogOf = (html) => html.match(/<dialog id="calendar-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    it('renders exactly the Filters and Miscellaneous sections with the approved fields in order (A, B)', async () => {
      const html = (await agent.get('/calendar?month=2025-06&status=planned&weekStart=sunday&view=list').expect(200)).text;
      const dialog = dialogOf(html);
      expect(dialog).toMatch(/class="app-dialog app-dialog--utility app-dialog--filters-defaults calendar-filters-defaults"/);
      expect(dialog).not.toMatch(/<dialog[^>]*\sopen/);
      expect([...dialog.matchAll(/<section class="filters-defaults-section"[^>]*>\s*<h3[^>]*>([^<]+)<\/h3>/g)].map(([, heading]) => heading))
        .toEqual(['Filters', 'Miscellaneous']);
      const sections = [...dialog.matchAll(/<section class="filters-defaults-section"[\s\S]*?<\/section>/g)].map(([section]) => section);
      const legends = (section) => [...section.matchAll(/<fieldset class="[^"]+"[^>]*>\s*<legend[^>]*>([^<]+)/g)].map(([, label]) => label);
      expect(legends(sections[0])).toEqual(['Projects', 'Project Types', 'Release status']);
      expect(legends(sections[1])).toEqual(['Desktop view', 'Week starts']);
      for (const forbidden of ['Sort by', 'Sort order', 'Page size', 'Grid style', 'Grid size', 'List size', 'Project-only', 'type="search" name=']) {
        expect(dialog).not.toContain(forbidden);
      }
      expect(dialog).not.toContain('Apply filters');
      expect(dialog).not.toMatch(/>(Cancel|Apply|Done|Close)<\/button>/);
      // Both sections belong to the one GET form; the defaults form is separate (no nesting).
      const filterForm = dialog.match(/<form id="calendar-filters"[\s\S]*?<\/form>/)?.[0] || '';
      expect(filterForm).toMatch(/^<form id="calendar-filters" class="filters-defaults-filters" method="get" action="\/calendar" data-calendar-filters>/);
      expect(filterForm).toContain('<input type="hidden" name="month" value="2025-06">');
      expect(filterForm.match(/<section class="filters-defaults-section"/g)).toHaveLength(2);
      expect(filterForm).toMatch(/name="status" type="radio" value="planned" checked/);
      expect(filterForm).toMatch(/name="view" type="radio" value="list" checked/);
      expect(filterForm).toMatch(/name="weekStart" type="radio" value="sunday" checked/);
      expect(filterForm).toMatch(/<span>Calendar<\/span>[\s\S]*<span>List<\/span>/);
      expect(filterForm).toMatch(/<span>All releases<\/span>[\s\S]*<span>Planned<\/span>[\s\S]*<span>Published<\/span>/);
      expect(filterForm).toMatch(/<span>Monday<\/span>[\s\S]*<span>Sunday<\/span>/);
      expect(filterForm).not.toContain('data-calendar-carried-filter');
    });

    it('renders the footer in Save, Reset defaults, Reset filters order with the shared styling hooks (C)', async () => {
      const html = (await agent.get('/calendar?month=2025-06&project=7').expect(200)).text;
      const dialog = dialogOf(html);
      const footer = dialog.match(/<footer class="app-dialog-footer filters-defaults-footer">([\s\S]*?)<\/footer>/)?.[1] || '';
      const buttons = [...footer.matchAll(/<button class="([^"]+)" type="(button|submit)"([^>]*)>([^<]+)<\/button>/g)]
        .map(([, classes, type, attributes, label]) => ({ classes, type, attributes: attributes.trim(), label }));
      expect(buttons).toEqual([
        { classes: 'button button-secondary', type: 'button', attributes: 'disabled data-calendar-defaults-save', label: 'Save new defaults' },
        { classes: 'button button-secondary', type: 'button', attributes: 'disabled data-calendar-defaults-reset', label: 'Reset defaults' },
        { classes: 'button button-primary', type: 'submit', attributes: 'data-calendar-filters-reset', label: 'Reset filters' },
      ]);
      // Reset filters is a GET to /calendar keeping only the displayed month.
      expect(footer).toMatch(/<form class="calendar-filter-reset filters-defaults-reset-form" method="get" action="\/calendar">\s*<input type="hidden" name="month" value="2025-06">\s*<button/);
      expect(footer).not.toContain('name="project"');
      // The explicit-save form: method="dialog", the opt-in marker, no saveable fields, no legacy autosave.
      const defaultsForm = dialog.match(/<form id="calendar-filters-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(defaultsForm).toMatch(/^<form id="calendar-filters-defaults-form" method="dialog" class="filters-defaults-defaults-form"\s+data-dialog-form data-dialog-async="false" data-defaults-explicit-save novalidate>/);
      expect(defaultsForm).not.toMatch(/name="(view|status|weekStart|calendarView|calendarStatus|calendarWeekStart|project|type)"/);
      expect(defaultsForm).toContain('data-calendar-defaults-indicator');
      expect(defaultsForm).toContain('data-settings-fetch-save-status');
      expect(defaultsForm).toMatch(/<div class="filters-defaults-recovery" data-calendar-defaults-recovery hidden>/);
      expect(defaultsForm).toContain('data-calendar-defaults-retry hidden>Retry</button>');
      expect(defaultsForm).toContain('data-calendar-defaults-check hidden>Check again</button>');
      expect(html).not.toContain('data-calendar-defaults-fetch-save');
      expect(html).not.toContain('action="/settings/defaults"');
      expect(html).not.toContain('data-autosubmit="fetch"');
    });

    it('renders searchable Projects and Project Types multi-selects with Select all and repeated values (F, G)', async () => {
      const alpha = project(db, 'Alpha multi');
      const bravo = project(db, 'Bravo multi');
      const archived = project(db, 'Zulu archived multi');
      db.prepare("UPDATE projects SET archived_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(archived.id);
      const html = (await agent.get(`/calendar?month=2025-06&project=${bravo.id}&project=${alpha.id}&type=comic`).expect(200)).text;
      const dialog = dialogOf(html);
      const projects = dialog.match(/<fieldset[^>]*data-calendar-project-filter[\s\S]*?<\/fieldset>/)?.[0] || '';
      expect(projects).toContain('data-cc-dropdown-mode="multiple"');
      expect(projects).toContain('data-cc-dropdown-searchable');
      expect(projects).toContain('id="calendar-project-filter-search"');
      expect(projects).toMatch(/name="project" type="checkbox" value=""[^>]*>[\s\S]*?<span>Select all<\/span>/);
      expect(projects).not.toMatch(/name="project" type="checkbox" value=""[^>]*checked/);
      expect(projects).toMatch(new RegExp(`name="project" type="checkbox" value="${alpha.id}" checked`));
      expect(projects).toMatch(new RegExp(`name="project" type="checkbox" value="${bravo.id}" checked`));
      // Archived Projects stay eligible options, marked beside the title.
      expect(projects).toMatch(new RegExp(`name="project" type="checkbox" value="${archived.id}" data-calendar-archived-project>[\\s\\S]*?<span>Zulu archived multi <em>Archived</em></span>`));
      expect(projects).toContain('2 projects selected');
      const types = dialog.match(/<fieldset[^>]*data-calendar-type-filter[\s\S]*?<\/fieldset>/)?.[0] || '';
      expect(types).toContain('data-cc-dropdown-searchable');
      expect(types).toMatch(/name="type" type="checkbox" value="comic" checked/);
      expect(types).toMatch(/name="type" type="checkbox" value=""[^>]*>[\s\S]*?<span>Select all<\/span>/);
      // No conflicting hidden Project/Type inputs anywhere in the dialog.
      expect(dialog).not.toMatch(/<input type="hidden" name="(project|type)"/);

      const unrestricted = dialogOf((await agent.get('/calendar?month=2025-06').expect(200)).text);
      expect(unrestricted).toMatch(/name="project" type="checkbox" value=""[^>]*checked/);
      expect(unrestricted).toMatch(/name="type" type="checkbox" value=""[^>]*checked/);
      expect(unrestricted).toContain('All projects');
      expect(unrestricted).toContain('All types');
    });

    it('opens the combined dialog for the non-JSON defaults address', async () => {
      const response = await agent.get('/calendar/defaults').expect(302);
      expect(response.headers.location).toBe('/calendar?defaults=1');
      const html = (await agent.get('/calendar?defaults=1').expect(200)).text;
      expect(dialogOf(html)).toMatch(/^<dialog id="calendar-filter-dialog"[^>]*\sdata-app-dialog open/);
    });
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

  it('offers editing only for unpublished releases in active projects and preserves Calendar state', async () => {
    const active = project(db, 'Editable project');
    const archived = project(db, 'Archived project');
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(archived.id);
    const editable = release(db, active.id, 'Editable release');
    const published = release(db, active.id, 'Published release', { publishedDate: '2025-06-15' });
    const readOnly = release(db, archived.id, 'Archived parent release');
    const archivedByDate = project(db, 'Archived by date');
    db.prepare("UPDATE projects SET archived_at = '2025-06-01 00:00:00' WHERE id = ?").run(archivedByDate.id);
    const datedReadOnly = release(db, archivedByDate.id, 'Dated archived parent release');
    const returnTo = `/calendar?month=2025-06&status=all&weekStart=sunday&view=list&project=${active.id}`;
    const filtered = (await agent.get(returnTo).expect(200)).text;
    // The canonical Release Detail deep link, without Calendar return context.
    const expectedUrl = `/releases/${editable.id}?edit=1`;

    for (const surface of ['grid', 'agenda']) {
      const card = infoCard(filtered, surface, editable.id);
      expect(card).not.toContain('returnTo');
      expect(card).toContain(`href="${expectedUrl}" data-release-edit-id="${editable.id}">Edit release</a>`);
      expect([...card.matchAll(/>(Open release|Edit release|Open project)<\/a>/g)].map((match) => match[1]))
        .toEqual(['Open release', 'Edit release', 'Open project']);
      expect(infoCard(filtered, surface, published.id)).not.toContain('Edit release');
    }

    const all = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    for (const surface of ['grid', 'agenda']) {
      expect(infoCard(all, surface, readOnly.id)).not.toContain('Edit release');
      expect(infoCard(all, surface, datedReadOnly.id)).not.toContain('Edit release');
    }
  });

  it('hosts one shared async Edit Release dialog outside the live region', async () => {
    const active = project(db, 'Dialog host project');
    release(db, active.id, 'Dialog host release');
    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    const region = html.indexOf('data-calendar-live-region');
    const dialogs = html.match(/<dialog id="release-edit-dialog"/g) || [];
    expect(dialogs).toHaveLength(1);
    const dialog = html.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)[0];
    expect(dialog).not.toMatch(/<dialog id="release-edit-dialog"[^>]*open/);
    expect(dialog).toContain('data-dialog-async="true"');
    expect(dialog).not.toContain('data-release-edit-deep-link');
    expect(dialog).not.toContain('data-dialog-return-location');
    expect(dialog).toContain('id="release-edit-field-title"');
    expect(dialog).toContain('id="release-edit-field-platforms"');
    expect(dialog).toContain('name="selectedPlatformsPresent" value="1"');
    expect(dialog).toContain('data-release-edit-action="archive"');
    expect(html.match(/<dialog id="release-signatures-dialog"/g) || []).toHaveLength(1);
    expect(html.indexOf('data-dialog-feedback')).toBeLessThan(region);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('shows only saved selected platforms in supported order on grid and agenda', async () => {
    const parent = project(db, 'Platforms project');
    const none = release(db, parent.id, 'No platforms');
    const one = release(db, parent.id, 'One platform');
    const several = release(db, parent.id, 'Several platforms');
    const repository = app.locals.socialPrepRepository;
    app.locals.socialPrepSettingsService.setPlatforms(['x']);
    repository.replaceSelectedPlatforms(one.id, ['x']);
    repository.replaceSelectedPlatforms(several.id, ['bluesky', 'patreon', 'x']);
    repository.replaceSelectedPlatforms(several.id, ['bluesky', 'patreon']);

    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    for (const surface of ['grid', 'agenda']) {
      expect(infoCard(html, surface, none.id)).toContain('<dt>Platforms</dt><dd>None</dd>');
      expect(infoCard(html, surface, one.id)).toContain('<dt>Platforms</dt><dd>X</dd>');
      const card = infoCard(html, surface, several.id);
      expect(card).toContain('<dt>Platforms</dt><dd>Patreon, Bluesky</dd>');
      expect(card).not.toContain('<dt>Platforms</dt><dd>Patreon, X, Bluesky</dd>');
      expect(card).toMatch(/<dt>Planned<\/dt>[\s\S]*?<\/div>\s*<div class="asset-viewer-grid-card-info-row"><dt>Platforms<\/dt>/);
    }
  });

  it('formats scheduled time in both Calendar views and details while retaining canonical datetime values', async () => {
    const parent = project(db, 'Clock project');
    release(db, parent.id, 'Timed event', { plannedTime: '13:05' });
    release(db, parent.id, 'Untimed event');

    for (const [preference, visible] of [['12h', '1:05 PM'], ['24h', '13:05']]) {
      app.locals.clockFormatSettingsService.setClockFormat(preference);
      const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
      expect((html.match(new RegExp(`class="calendar-release-time" datetime="2025-06-15T13:05">${visible}</time>`, 'g')) || [])).toHaveLength(2);
      expect((html.match(new RegExp(`datetime="2025-06-15T13:05">2025-06-15 ${visible}</time>`, 'g')) || [])).toHaveLength(2);
      expect((html.match(/class="calendar-release-time"/g) || [])).toHaveLength(2);
      expect((html.match(/datetime="2025-06-15">2025-06-15<\/time>/g) || [])).toHaveLength(2);
    }
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
    for (const name of ['status', 'project', 'type', 'view', 'weekStart']) {
      expect(html).toContain(`name="${name}"`);
    }
    // WP14b: the legacy autosave field names are gone with their form.
    for (const name of ['calendarView', 'calendarStatus', 'calendarWeekStart']) {
      expect(html).not.toContain(`name="${name}"`);
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

  describe('WP13 multi-Project and Project Type filtering', () => {
    let fixture;

    function typedProject(title, projectType, { archived = false } = {}) {
      const slug = `wp13-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const row = db.prepare(`INSERT INTO projects (title, slug, description, notes, status, project_type)
        VALUES (?, ?, '', '', 'tbd', ?) RETURNING id`).get(title, slug, projectType);
      if (archived) {
        db.prepare("UPDATE projects SET status = 'archived', archived_at = '2025-05-01 00:00:00' WHERE id = ?").run(row.id);
      }
      return row.id;
    }

    function datedRelease(projectId, title, { planned = null, time = null, published = null } = {}) {
      return db.prepare(`INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, published_date)
        VALUES (?, ?, '', '', ?, ?, ?) RETURNING id`).get(projectId, title, planned, time, published).id;
    }

    // Release IDs rendered on the grid surface, in document order.
    const gridIds = (html) => [...html.matchAll(/id="calendar-info-grid-(\d+)"/g)].map((match) => Number(match[1]));
    const count = (html) => Number(html.match(/<p class="results-meta">(\d+) matching release/)?.[1]);
    const filterForm = (html) => html.match(/<form id="calendar-filters"[\s\S]*?<\/form>/)?.[0] || '';
    // Resolved Project and Type selections submit checked options in catalogue
    // order, with no duplicate hidden values.
    const carried = (html) => {
      const form = filterForm(html);
      expect(form).not.toMatch(/<input type="hidden" name="(project|type)"/);
      return [...form.matchAll(/name="(project|type)" type="checkbox" value="([^"]+)"[^>]*\schecked/g)]
        .map((match) => `${match[1]}=${match[2]}`);
    };

    beforeEach(() => {
      const comic = typedProject('WP13 Comic', 'comic');
      const comicTwo = typedProject('WP13 Comic Two', 'comic');
      const animation = typedProject('WP13 Animation Archived', 'animation', { archived: true });
      const images = typedProject('WP13 Images', 'images');
      fixture = {
        projects: { comic, comicTwo, animation, images },
        releases: {
          comicPlanned: datedRelease(comic, 'Comic planned', { planned: '2025-06-10', time: '10:00' }),
          comicTwoPlanned: datedRelease(comicTwo, 'Comic two planned', { planned: '2025-06-10', time: '09:00' }),
          comicPublishedIn: datedRelease(comic, 'Comic published in', { planned: '2025-07-03', published: '2025-06-30' }),
          comicPublishedOut: datedRelease(comic, 'Comic published out', { planned: '2025-06-28', published: '2025-07-01' }),
          animationParent: datedRelease(animation, 'Animation archived parent', { planned: '2025-06-10', time: '11:00' }),
          images: datedRelease(images, 'Images planned', { planned: '2025-06-11' }),
        },
      };
    });

    it('filters actual entries for one and two Projects, in any order and with duplicates (A-D)', async () => {
      const { projects: p, releases: r } = fixture;
      const one = (await agent.get(`/calendar?month=2025-06&project=${p.comicTwo}`).expect(200)).text;
      expect(gridIds(one)).toEqual([r.comicTwoPlanned]);
      expect(carried(one)).toEqual([`project=${p.comicTwo}`]);
      expect(filterForm(one)).toContain(`name="project" type="checkbox" value="${p.comicTwo}" checked`);

      const urls = [
        `/calendar?month=2025-06&project=${p.comic}&project=${p.comicTwo}`,
        `/calendar?month=2025-06&project=${p.comicTwo}&project=${p.comic}&project=${p.comicTwo}`,
      ];
      for (const url of urls) {
        const html = (await agent.get(url).expect(200)).text;
        expect(gridIds(html)).toEqual([r.comicTwoPlanned, r.comicPlanned, r.comicPublishedIn]);
        expect(count(html)).toBe(3);
        // Option-source (title) order: WP13 Comic, then WP13 Comic Two.
        expect(carried(html)).toEqual([`project=${p.comic}`, `project=${p.comicTwo}`]);
        expect(html).toContain('2 projects selected');
        // Select all is unchecked, so the checked IDs are the only `project`
        // values the form submits.
        expect(filterForm(html)).not.toMatch(/name="project" type="checkbox" value=""[^>]*\schecked/);
      }
    });

    it('keeps unknown Project IDs restrictive in Grid and List while rejecting malformed values', async () => {
      const { projects: p, releases: r } = fixture;
      const base = '/calendar?month=2025-06';
      const hiddenIds = (html) => [...filterForm(html).matchAll(/type="hidden" name="project" value="(\d+)" data-calendar-intended-carrier data-cc-dropdown-carried-value/g)]
        .map((match) => match[1]);
      const agendaIds = (html) => [...html.matchAll(/id="calendar-info-agenda-(\d+)"/g)]
        .map((match) => Number(match[1]));
      const unknown = '900000';
      expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(unknown)).toBeUndefined();

      for (const view of ['grid', 'list']) {
        const request = (selection) => agent.get(`${base}&view=${view}&${selection}`).expect(200);
        const single = (await request(`project=${unknown}`)).text;
        expect(count(single)).toBe(0);
        expect(gridIds(single)).toEqual([]);
        expect(agendaIds(single)).toEqual([]);
        expect(hiddenIds(single)).toEqual([unknown]);
        expect(filterForm(single)).toContain('aria-label="Projects filter: 1 project selected"');
        expect(filterForm(single)).not.toMatch(/name="project" type="checkbox" value=""[^>]*\schecked/);
        for (const month of ['2025-05', '2025-07']) {
          expect(single).toContain(`href="/calendar?month=${month}&amp;view=${view}&amp;project=${unknown}"`);
        }
        expect(single).toContain(`href="/calendar?view=${view}&amp;project=${unknown}"`);
        expect(authorityOf(single).resetFiltersUrl).toBe(base);

        const mixed = (await request(
          `project=${unknown}&project=abc&project=&project=01&project=9007199254740992&project=${p.animation}&type=animation&type=bogus&status=planned`,
        )).text;
        expect(hiddenIds(mixed)).toEqual([unknown]);
        expect(filterForm(mixed)).toContain('aria-label="Projects filter: 2 projects selected"');
        expect(count(mixed)).toBe(1);
        expect(gridIds(mixed)).toEqual([r.animationParent]);
        expect(agendaIds(mixed)).toEqual([r.animationParent]);
        expect(filterForm(mixed)).toContain(`name="project" type="checkbox" value="${p.animation}" checked`);
        expect(authorityOf(mixed).currentUrl).toBe(
          `${base}&status=planned&view=${view}&project=${p.animation}&project=${unknown}&type=animation`,
        );

        const multiple = (await request(`project=900001&project=${unknown}&project=900001`)).text;
        expect(hiddenIds(multiple)).toEqual([unknown, '900001']);
        expect(count(multiple)).toBe(0);
        expect(gridIds(multiple)).toEqual([]);
        expect(agendaIds(multiple)).toEqual([]);
      }

      const malformed = (await agent.get(`${base}&project=abc&project=01&project=0&project=-1&project=9007199254740992`).expect(200)).text;
      expect(count(malformed)).toBe(5);
      expect(hiddenIds(malformed)).toEqual([]);
    });

    it('filters by one, several and stale Types against the live catalogue (G, H, I)', async () => {
      const { releases: r } = fixture;
      const comic = (await agent.get('/calendar?month=2025-06&type=comic').expect(200)).text;
      expect(gridIds(comic)).toEqual([r.comicTwoPlanned, r.comicPlanned, r.comicPublishedIn]);
      expect(carried(comic)).toEqual(['type=comic']);
      const two = (await agent.get('/calendar?month=2025-06&type=comic&type=animation&type=comic&type=bogus').expect(200)).text;
      expect(gridIds(two)).toEqual([r.comicTwoPlanned, r.comicPlanned, r.animationParent, r.comicPublishedIn]);
      expect([...carried(two)].sort()).toEqual(['type=animation', 'type=comic']);
      const stale = (await agent.get('/calendar?month=2025-06&type=bogus').expect(200)).text;
      expect(count(stale)).toBe(5);
      expect(carried(stale)).toEqual([]);
    });

    it('ANDs Projects, Types and release status, with range/count agreement (J, K, L, S)', async () => {
      const { projects: p, releases: r } = fixture;
      const both = (await agent.get(`/calendar?month=2025-06&project=${p.comic}&project=${p.images}&type=comic`).expect(200)).text;
      expect(gridIds(both)).toEqual([r.comicPlanned, r.comicPublishedIn]);
      expect(count(both)).toBe(2);
      const planned = (await agent.get(`/calendar?month=2025-06&status=planned&project=${p.comic}&project=${p.images}&type=comic`).expect(200)).text;
      expect(gridIds(planned)).toEqual([r.comicPlanned]);
      const published = (await agent.get(`/calendar?month=2025-06&status=published&project=${p.comic}&project=${p.images}&type=comic`).expect(200)).text;
      expect(gridIds(published)).toEqual([r.comicPublishedIn]);
      const none = (await agent.get(`/calendar?month=2025-06&project=${p.images}&type=comic`).expect(200)).text;
      expect(gridIds(none)).toEqual([]);
      expect(none).toContain('No releases match these filters.');
      expect(none).toContain('class="calendar-table" role="table"');
    });

    it('keeps publication precedence and month boundaries under a Type filter (M, N)', async () => {
      const { releases: r } = fixture;
      const june = (await agent.get('/calendar?month=2025-06&type=comic').expect(200)).text;
      const agendaDay = (date) => june.split('<li class="agenda-day').slice(1).find((chunk) => chunk.includes(date)) || '';
      expect(agendaDay('2025-06-30')).toContain(`aria-controls="calendar-info-agenda-${r.comicPublishedIn}"`);
      expect(agendaDay('2025-06-10')).not.toContain(`aria-controls="calendar-info-agenda-${r.comicPublishedIn}"`);
      expect(gridIds(june)).not.toContain(r.comicPublishedOut);
      const july = (await agent.get('/calendar?month=2025-07&type=comic').expect(200)).text;
      expect(gridIds(july)).toEqual([r.comicPublishedOut]);
    });

    it('preserves repeated values in previous, next, Today, View and month-picker context (O, P, Q, R)', async () => {
      const { projects: p } = fixture;
      const [low, high] = [p.comic, p.images].sort((left, right) => left - right);
      const html = (await agent.get(
        `/calendar?month=2025-06&weekStart=sunday&view=list&project=${high}&project=${low}&type=comic&type=images`,
      ).expect(200)).text;
      const context = `weekStart=sunday&amp;view=list&amp;project=${low}&amp;project=${high}&amp;type=comic&amp;type=images`;
      expect(html).toContain(`id="calendar-previous" class="button button-secondary project-filter-control calendar-nav-control asset-tooltip" href="/calendar?month=2025-05&amp;${context}"`);
      expect(html).toContain(`id="calendar-next" class="button button-secondary project-filter-control calendar-nav-control asset-tooltip" href="/calendar?month=2025-07&amp;${context}"`);
      expect(html).toContain(`id="calendar-today" class="button button-primary project-filter-control calendar-nav-control asset-tooltip" href="/calendar?${context}"`);
      expect(html).toMatch(/role="columnheader">Sun<\/div>[\s\S]*?role="columnheader">Mon<\/div>/);
      // The month picker submits #calendar-filters: month, View and both
      // repeated selections travel with it.
      const form = filterForm(html);
      expect(form).toContain('<input type="hidden" name="month" value="2025-06">');
      expect(form).toMatch(/name="view" type="radio" value="list" checked/);
      expect(form).toMatch(/name="weekStart" type="radio" value="sunday" checked/);
      expect(carried(html).filter((entry) => entry.startsWith('project=')).sort())
        .toEqual([`project=${low}`, `project=${high}`].sort());
      expect(carried(html).filter((entry) => entry.startsWith('type=')).sort()).toEqual(['type=comic', 'type=images']);
      // WP14b Reset filters (GET) keeps only the month; it clears Projects/Types.
      expect(html).toMatch(/<form class="calendar-filter-reset filters-defaults-reset-form" method="get" action="\/calendar">\s*<input type="hidden" name="month" value="2025-06">/);
    });

    it('keeps archived-parent and published entries non-editable under a selection (T, U)', async () => {
      const { projects: p, releases: r } = fixture;
      const html = (await agent.get(
        `/calendar?month=2025-06&project=${p.animation}&project=${p.comic}&type=animation&type=comic`,
      ).expect(200)).text;
      expect(gridIds(html)).toEqual([r.comicPlanned, r.animationParent, r.comicPublishedIn]);
      for (const surface of ['grid', 'agenda']) {
        expect(infoCard(html, surface, r.comicPlanned))
          .toContain(`href="/releases/${r.comicPlanned}?edit=1" data-release-edit-id="${r.comicPlanned}">Edit release</a>`);
        expect(infoCard(html, surface, r.comicPlanned)).not.toContain('returnTo');
        expect(infoCard(html, surface, r.animationParent)).not.toContain('Edit release');
        expect(infoCard(html, surface, r.comicPublishedIn)).not.toContain('Edit release');
        expect(infoCard(html, surface, r.animationParent)).toContain(`href="/releases/${r.animationParent}">Open release</a>`);
      }
    });

    it('leaves saved Calendar defaults untouched by Project and Type selections', async () => {
      const { projects: p } = fixture;
      await agent.get(`/calendar?month=2025-06&project=${p.comic}&project=${p.images}&type=comic`).expect(200);
      const saved = db.prepare("SELECT key FROM app_meta WHERE key LIKE 'page_defaults.calendar.%'").all();
      expect(saved).toEqual([]);
    });
  });
});

// WP14a: the Calendar explicit Save / Reset defaults transport. Calendar has
// exactly three Global saveable defaults (View, Release status, Week start);
// the displayed month, Projects and Project Types are temporary.
describe('Calendar explicit defaults transport (WP14a)', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;
  const KEYS = Object.freeze({
    view: 'page_defaults.calendar.view',
    status: 'page_defaults.calendar.status',
    weekStart: 'page_defaults.calendar.week_start',
  });
  const meta = (key) => db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(key);
  const allMeta = () => Object.fromEntries(db.prepare('SELECT key, value FROM app_meta ORDER BY key').all()
    .map(({ key, value }) => [key, value]));
  const service = () => app.locals.pageDefaultsService;
  const postSave = (body, { json = true } = {}) => {
    const request = agent.post('/calendar/defaults').type('form');
    if (json) request.set('Accept', 'application/json');
    return request.send({ _csrf: csrfToken, ...body });
  };
  const postReset = (body, { json = true } = {}) => {
    const request = agent.post('/calendar/defaults/reset').type('form');
    if (json) request.set('Accept', 'application/json');
    return request.send({ _csrf: csrfToken, ...body });
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-calendar-defaults-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, migrationsDir);
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

  it('renders the authoritative values, saved-key presence, fallbacks and generation of the page (A, B)', async () => {
    service().saveDefault('calendar', 'status', 'all');
    service().saveDefault('calendar', 'weekStart', 'sunday');
    const first = project(db, 'Authority A');
    const second = project(db, 'Authority B');
    const html = (await agent
      .get(`/calendar?month=2025-06&view=list&project=${second.id}&project=${first.id}&type=comic`)
      .expect(200)).text;
    const authority = authorityOf(html);
    expect(authority).toMatchObject({
      page: 'calendar',
      fields: ['view', 'status', 'weekStart'],
      multiFields: [],
      fallbacks: { view: 'grid', status: 'all', weekStart: 'monday' },
      defaults: { view: 'grid', status: 'all', weekStart: 'sunday' },
      // A saved fallback-equal value (status 'all') is still saved.
      saved: {
        view: { stored: false, valid: false },
        status: { stored: true, valid: true },
        weekStart: { stored: true, valid: true },
      },
      savedKeys: ['status', 'weekStart'],
      hasSavedDefaults: true,
      generation: 0,
      // The effective presentation actually shown: the explicit View wins.
      current: { view: 'list', status: 'all', weekStart: 'sunday' },
      currentUrl: `/calendar?month=2025-06&view=list&project=${first.id}&project=${second.id}&type=comic`,
      month: '2025-06',
      resetFiltersUrl: '/calendar?month=2025-06',
    });
    expect(typeof authority.revision).toBe('string');
    // The authority travels inside the live region.
    const region = html.slice(html.indexOf('data-calendar-live-region'));
    expect(region).toContain('data-calendar-defaults-authority');

    const json = await agent.get('/calendar/defaults').set('Accept', 'application/json').expect(200);
    expect(json.headers['cache-control']).toBe('no-store');
    expect(json.body).toMatchObject({
      status: 'success',
      authority: { page: 'calendar', savedKeys: ['status', 'weekStart'], generation: 0, revision: authority.revision },
    });
    expect(json.body.authority).not.toHaveProperty('current');
    const typed = await agent.get('/calendar/defaults').set('Accept', 'text/html').expect(302);
    expect(typed.headers.location).toBe('/calendar?defaults=1');
  });

  it('saves exactly the three keys in one fenced transaction, fallback values included (C, D, R, S)', async () => {
    service().saveDefault('releases', 'sort', 'title');
    service().saveDefault('projects', 'sort', 'title');
    const owner = project(db, 'Save context');
    const before = allMeta();
    const response = await postSave({
      view: 'grid', status: 'all', weekStart: 'monday',
      defaultsGeneration: '0', defaultsOperation: 'op-save-1',
      returnTo: `/calendar?month=2025-06&view=list&project=${owner.id}&type=comic&type=animation`,
      // Temporary context is never saveable, even when sent.
      month: '2025-06', project: String(owner.id), type: 'comic',
    }).expect(200);
    expect(response.body).toMatchObject({
      status: 'success',
      values: { view: 'grid', status: 'all', weekStart: 'monday' },
      operation: { id: 'op-save-1', kind: 'save', result: 'committed', committed: true, expectedGeneration: 0, generation: 1 },
      authority: {
        page: 'calendar', generation: 1, savedKeys: ['view', 'status', 'weekStart'],
        defaults: { view: 'grid', status: 'all', weekStart: 'monday' },
      },
    });
    expect(Object.keys(response.body.values)).toEqual(['view', 'status', 'weekStart']);
    expect([meta(KEYS.view), meta(KEYS.status), meta(KEYS.weekStart)]).toEqual(['grid', 'all', 'monday']);
    const after = allMeta();
    const changed = Object.keys(after).filter((key) => after[key] !== before[key]).sort();
    expect(changed).toEqual([KEYS.status, KEYS.view, KEYS.weekStart, 'page_defaults_generation.calendar'].sort());
    expect(service().resolve('releases', 'sort')).toBe('title');
    expect(service().getMutationGeneration('releases')).toBe(0);

    // The native fallback redirects to the same month and temporary filters
    // (View/status/week start then resolve from the saved defaults).
    const native = await postSave({
      view: 'list', status: 'planned', weekStart: 'sunday', defaultsGeneration: '1',
      returnTo: `/calendar?month=2025-06&status=published&project=${owner.id}&project=999999&type=comic&type=animation`,
    }, { json: false }).expect(302);
    expect(native.headers.location)
      .toBe(`/calendar?month=2025-06&project=${owner.id}&project=999999&type=animation&type=comic&notice=calendar_defaults_saved`);
    const rendered = await agent.get(native.headers.location).expect(200);
    expect(rendered.text).toContain('Calendar defaults saved successfully.');
    expect(rendered.text).toContain('class="calendar-view-list" data-calendar-live-region');
    expect(authorityOf(rendered.text)).toMatchObject({
      current: { view: 'list', status: 'planned', weekStart: 'sunday' }, month: '2025-06', generation: 2,
    });
  });

  it('rejects invalid values with no partial write and rolls back a failed transaction (E)', async () => {
    await postSave({ view: 'list', status: 'planned', weekStart: 'sunday', defaultsGeneration: '0' }).expect(200);
    const invalid = await postSave({
      view: 'grid', status: 'bogus', weekStart: 'monday', defaultsGeneration: '1', defaultsOperation: 'op-invalid',
    }).expect(422);
    expect(invalid.body).toMatchObject({
      status: 'error',
      errors: { status: expect.any(String) },
      operation: { id: 'op-invalid', kind: 'save', result: 'invalid', committed: false },
    });
    expect([meta(KEYS.view), meta(KEYS.status), meta(KEYS.weekStart)]).toEqual(['list', 'planned', 'sunday']);
    expect(service().getMutationGeneration('calendar')).toBe(1);

    const nativeInvalid = await postSave({
      view: 'nope', status: 'all', weekStart: 'monday', defaultsGeneration: '1', returnTo: '/calendar?month=2025-03',
    }, { json: false }).expect(422);
    expect(nativeInvalid.text).toContain('data-calendar-month="2025-03"');
    expect(nativeInvalid.text).toContain('Calendar defaults were not saved.');

    // A failure after the first write rolls back every key and the generation.
    const original = service().saveDefault;
    service().saveDefault = (page, option, value, catalogue) => {
      if (page === 'calendar' && option === 'weekStart') throw new Error('forced write failure');
      return original(page, option, value, catalogue);
    };
    try {
      const failed = await postSave({
        view: 'grid', status: 'all', weekStart: 'monday', defaultsGeneration: '1', defaultsOperation: 'op-failed',
      }).expect(500);
      expect(failed.body).toMatchObject({
        status: 'error', operation: { id: 'op-failed', result: 'failed', committed: false },
      });
    } finally {
      service().saveDefault = original;
    }
    expect([meta(KEYS.view), meta(KEYS.status), meta(KEYS.weekStart)]).toEqual(['list', 'planned', 'sunday']);
    expect(service().getMutationGeneration('calendar')).toBe(1);
  });

  it('enforces CSRF on Save and Reset defaults (F)', async () => {
    await agent.post('/calendar/defaults').type('form')
      .send({ view: 'list', status: 'all', weekStart: 'monday', defaultsGeneration: '0' }).expect(403);
    await agent.post('/calendar/defaults/reset').type('form').send({ defaultsGeneration: '0' }).expect(403);
    expect(meta(KEYS.view)).toBeUndefined();
    expect(service().getMutationGeneration('calendar')).toBe(0);
  });

  it('rejects a missing, malformed or stale generation with a correlated 409 and writes nothing (G, H)', async () => {
    const missing = await postSave({ view: 'list', status: 'all', weekStart: 'monday', defaultsOperation: 'op-missing' })
      .expect(409);
    expect(missing.body).toMatchObject({
      status: 'error',
      code: 'DEFAULTS_GENERATION_CONFLICT',
      operation: { id: 'op-missing', kind: 'save', result: 'conflict', committed: false, expectedGeneration: null, generation: 0 },
      authority: { page: 'calendar', generation: 0, savedKeys: [] },
    });
    await postSave({ view: 'list', status: 'all', weekStart: 'monday', defaultsGeneration: '-1' }).expect(409);
    expect(meta(KEYS.view)).toBeUndefined();

    await postSave({ view: 'list', status: 'planned', weekStart: 'sunday', defaultsGeneration: '0' }).expect(200);
    const stale = await postSave({
      view: 'grid', status: 'all', weekStart: 'monday', defaultsGeneration: '0', defaultsOperation: 'op-stale',
    }).expect(409);
    expect(stale.body.operation).toMatchObject({ id: 'op-stale', result: 'conflict', expectedGeneration: 0, generation: 1 });
    expect([meta(KEYS.view), meta(KEYS.status), meta(KEYS.weekStart)]).toEqual(['list', 'planned', 'sunday']);

    const native = await postSave({
      view: 'grid', status: 'all', weekStart: 'monday', defaultsGeneration: '0', returnTo: '/calendar?month=2025-02',
    }, { json: false }).expect(409);
    expect(native.text).toContain('Calendar defaults changed since this page was loaded.');
    expect(native.text).toContain('data-calendar-month="2025-02"');
    expect(meta(KEYS.view)).toBe('list');
  });

  it('correlates every answer with its own operation and never replays a repeated Save (I, J)', async () => {
    const body = { view: 'list', status: 'published', weekStart: 'sunday', defaultsGeneration: '0' };
    const first = await postSave({ ...body, defaultsOperation: 'op-a' }).expect(200);
    expect(first.body.operation).toMatchObject({ id: 'op-a', result: 'committed', generation: 1 });
    // Two requests prepared from the same generation: only one can commit.
    const second = await postSave({ ...body, view: 'grid', defaultsOperation: 'op-b' }).expect(409);
    expect(second.body.operation).toMatchObject({ id: 'op-b', result: 'conflict', committed: false, generation: 1 });
    // A duplicate delivery of the committed request is rejected, not replayed.
    const duplicate = await postSave({ ...body, defaultsOperation: 'op-a' }).expect(409);
    expect(duplicate.body.operation).toMatchObject({ id: 'op-a', result: 'conflict', committed: false });
    expect(service().getMutationGeneration('calendar')).toBe(1);
    expect(meta(KEYS.view)).toBe('list');
    // A malformed identity is never echoed as another request's.
    const malformed = await postSave({ ...body, defaultsGeneration: '1', defaultsOperation: 'bad id!' }).expect(200);
    expect(malformed.body.operation.id).toBeNull();
  });

  it('Reset defaults deletes only the Calendar keys and keeps the month and temporary filters (K, L, R, S, U)', async () => {
    const first = project(db, 'Reset A');
    const second = project(db, 'Reset B');
    service().saveDefault('calendar', 'view', 'list');
    service().saveDefault('calendar', 'status', 'planned');
    service().saveDefault('calendar', 'weekStart', 'sunday');
    service().saveDefault('releases', 'sort', 'title');
    service().saveDefault('projects', 'sort', 'title');
    service().saveDefault('assetViewer', 'sort', 'size');
    service().saveDefault('projectAssets', 'sort', 'modified');
    service().saveDefault('logs', 'pageSize', '25');
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('display.clock_format', '24h')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    const before = allMeta();

    const reset = await postReset({
      defaultsGeneration: '0', defaultsOperation: 'op-reset-1',
      returnTo: `/calendar?month=2025-06&status=published&weekStart=monday&view=grid&project=${second.id}&project=${first.id}&project=999999&type=comic&type=bogus`,
    }).expect(200);
    expect(reset.body).toMatchObject({
      status: 'success',
      operation: { id: 'op-reset-1', kind: 'resetDefaults', result: 'committed', committed: true, expectedGeneration: 0, generation: 1 },
      reset: { page: 'calendar', scope: 'global', changed: true, deletedOptions: ['view', 'status', 'weekStart'] },
      refreshUrl: `/calendar?month=2025-06&project=${first.id}&project=${second.id}&project=999999&type=comic`,
      authority: {
        page: 'calendar', generation: 1, savedKeys: [], defaults: { view: 'grid', status: 'all', weekStart: 'monday' },
      },
    });
    const after = allMeta();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key]).sort();
    expect(changed).toEqual([KEYS.status, KEYS.view, KEYS.weekStart, 'page_defaults_generation.calendar'].sort());
    expect(after['display.clock_format']).toBe('24h');

    // The refresh applies the fallbacks to the actual presentation.
    const refreshed = await agent.get(reset.body.refreshUrl).expect(200);
    expect(refreshed.text).toContain('class="calendar-view-grid" data-calendar-live-region');
    expect(authorityOf(refreshed.text)).toMatchObject({
      current: { view: 'grid', status: 'all', weekStart: 'monday' }, month: '2025-06', savedKeys: [],
    });

    // A no-op Reset still advances the generation; a stale one deletes nothing.
    const noop = await postReset({ defaultsGeneration: '1', defaultsOperation: 'op-reset-2' }).expect(200);
    expect(noop.body).toMatchObject({ reset: { changed: false }, refreshUrl: '/calendar', operation: { generation: 2 } });
    service().saveDefault('calendar', 'view', 'list');
    const stale = await postReset({ defaultsGeneration: '1', defaultsOperation: 'op-reset-stale' }).expect(409);
    expect(stale.body.operation).toMatchObject({ kind: 'resetDefaults', result: 'conflict', generation: 2 });
    expect(meta(KEYS.view)).toBe('list');

    // Native Reset redirects to the same context; a foreign returnTo is ignored.
    const native = await postReset({ defaultsGeneration: '2', returnTo: '/calendar?month=2024-12&type=comic' }, { json: false })
      .expect(302);
    expect(native.headers.location).toBe('/calendar?month=2024-12&type=comic');
    const foreign = await postReset({ defaultsGeneration: '3', returnTo: 'https://evil.example/calendar?month=2024-01' }).expect(200);
    expect(foreign.body.refreshUrl).toBe('/calendar');
  });

  it('reports a confirmed Save or Reset whose follow-up read failed as committed, never as not saved (M, N, O)', async () => {
    const original = service().describeSavedDefaults;
    service().describeSavedDefaults = () => { throw new Error('read failed'); };
    let save;
    let reset;
    try {
      save = await postSave({
        view: 'list', status: 'planned', weekStart: 'sunday', defaultsGeneration: '0', defaultsOperation: 'op-m',
      }).expect(200);
      reset = await postReset({
        defaultsGeneration: '1', defaultsOperation: 'op-n', returnTo: '/calendar?month=2025-06&type=comic',
      }).expect(500);
    } finally {
      service().describeSavedDefaults = original;
    }
    expect(save.body).toMatchObject({
      status: 'success', authorityUnavailable: true,
      operation: { id: 'op-m', result: 'committed', committed: true, generation: 1 },
    });
    expect(save.body).not.toHaveProperty('authority');
    expect(reset.body).toMatchObject({
      status: 'error', committed: true, refreshUrl: '/calendar?month=2025-06&type=comic',
      operation: { id: 'op-n', kind: 'resetDefaults', result: 'committed', committed: true, generation: 2 },
    });
    expect(meta(KEYS.view)).toBeUndefined();
    // Reconciliation of an uncertain outcome is a GET-only read of the
    // authority: the generation proves the write moved past the request.
    const check = await agent.get('/calendar/defaults').set('Accept', 'application/json').expect(200);
    expect(check.body.authority).toMatchObject({ generation: 2, savedKeys: [] });
    expect(service().getMutationGeneration('calendar')).toBe(2);
  });

  it('keeps legacy /settings/defaults Calendar writes working and fences them (P, Q)', async () => {
    await agent.post('/settings/defaults').type('form').send({
      calendarView: 'list', calendarStatus: 'published', calendarWeekStart: 'sunday', _csrf: csrfToken,
    }).expect(302);
    expect([meta(KEYS.view), meta(KEYS.status), meta(KEYS.weekStart)]).toEqual(['list', 'published', 'sunday']);
    const html = (await agent.get('/calendar?month=2025-06').expect(200)).text;
    expect(authorityOf(html)).toMatchObject({ generation: 1, savedKeys: ['view', 'status', 'weekStart'] });
    // WP14b: the Calendar page no longer renders a /settings/defaults writer;
    // the Settings route itself stays compatible (above) and fenced (below).
    expect(html).not.toContain('calendar-defaults-form');
    expect(html).not.toContain('action="/settings/defaults"');
    await postSave({ view: 'grid', status: 'all', weekStart: 'monday', defaultsGeneration: '0' }).expect(409);
    expect(meta(KEYS.view)).toBe('list');
    await postSave({ view: 'grid', status: 'all', weekStart: 'monday', defaultsGeneration: '1' }).expect(200);
    expect(meta(KEYS.view)).toBe('grid');
  });

  it('exposes a GET-only Reset filters destination that keeps the month and applies the saved defaults (T, U, V)', async () => {
    const owner = project(db, 'Filter owner');
    service().saveDefault('calendar', 'view', 'list');
    service().saveDefault('calendar', 'status', 'published');
    const before = allMeta();
    const html = (await agent
      .get(`/calendar?month=2025-04&view=grid&status=planned&weekStart=sunday&project=${owner.id}&type=comic`)
      .expect(200)).text;
    const authority = authorityOf(html);
    expect(authority.current).toEqual({ view: 'grid', status: 'planned', weekStart: 'sunday' });
    expect(authority.resetFiltersUrl).toBe('/calendar?month=2025-04');
    // WP14b: the footer Reset filters is that destination as a native GET
    // form (bare /calendar plus the month), never the explicit View.
    expect(html).toMatch(/<form class="calendar-filter-reset filters-defaults-reset-form" method="get" action="\/calendar">\s*<input type="hidden" name="month" value="2025-04">\s*<button class="button button-primary" type="submit" data-calendar-filters-reset>Reset filters<\/button>/);

    const restored = await agent.get(authority.resetFiltersUrl).expect(200);
    expect(restored.text).toContain('class="calendar-view-list" data-calendar-live-region');
    expect(restored.text).toContain('data-calendar-month="2025-04"');
    expect(authorityOf(restored.text)).toMatchObject({
      current: { view: 'list', status: 'published', weekStart: 'monday' },
      currentUrl: '/calendar?month=2025-04',
      month: '2025-04',
    });
    // No GET (render, authority read, Reset filters, month navigation) writes.
    await agent.get('/calendar/defaults').set('Accept', 'application/json').expect(200);
    await agent.get('/calendar?month=2025-05&project=1&type=comic').expect(200);
    expect(allMeta()).toEqual(before);
  });

  it('C4: without a page authority, the client Reset filters fallback is the route\'s own month-only destination', async () => {
    const owner = project(db, 'Fallback owner');
    service().saveDefault('calendar', 'view', 'list');
    service().saveDefault('calendar', 'weekStart', 'sunday');
    const before = allMeta();
    const filtered = `/calendar?month=2025-04&view=grid&status=planned&weekStart=monday&project=${owner.id}&type=comic`;
    const withAuthority = authorityOf((await agent.get(filtered).expect(200)).text);

    // The authority read fails on the server: the page fails closed (no
    // authority script) but still renders the displayed month.
    const original = service().getMutationGeneration;
    service().getMutationGeneration = () => { throw new Error('read failed'); };
    let html;
    try {
      html = (await agent.get(filtered).expect(200)).text;
    } finally {
      service().getMutationGeneration = original;
    }
    expect(html).not.toContain('data-calendar-defaults-authority');
    const month = html.match(/data-calendar-live-region data-calendar-month="([^"]*)"/)?.[1];
    expect(month).toBe('2025-04');
    expect(html).toMatch(/<form class="calendar-filter-reset filters-defaults-reset-form" method="get" action="\/calendar">\s*<input type="hidden" name="month" value="2025-04">/);

    const destination = calendarResetFiltersDestination({
      querySelector: (selector) => (selector === '[data-calendar-live-region]'
        ? { getAttribute: (name) => (name === 'data-calendar-month' ? month : null) }
        : null),
    });
    expect(destination).toBe(withAuthority.resetFiltersUrl);
    const restored = (await agent.get(destination).expect(200)).text;
    expect(restored).toContain('class="calendar-view-list" data-calendar-live-region data-calendar-month="2025-04"');
    expect(authorityOf(restored)).toMatchObject({
      current: { view: 'list', status: 'all', weekStart: 'sunday' },
      currentUrl: '/calendar?month=2025-04',
    });
    expect(allMeta()).toEqual(before);
  });
});
