/**
 * HTTP-level tests for the dashboard composition.
 *
 * The dashboard renders configurable retained project sections composed by
 * `workflowQueryService.getDashboardData()` through the established
 * `partials/project-card.njk` + `.project-grid` pattern.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const STYLESHEET_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const SERVED_CSS = fs.readFileSync(STYLESHEET_PATH, 'utf8');
const DASHBOARD_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/index.njk', import.meta.url));
const DASHBOARD_TEMPLATE = fs.readFileSync(DASHBOARD_TEMPLATE_PATH, 'utf8');

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

function extractSection(html, className) {
  const sectionIds = {
    'recent-projects': 'recently-updated',
  };
  const sectionId = sectionIds[className] || className;
  const re = new RegExp(`<section\\b[^>]*data-dashboard-section="${sectionId}"[^>]*>[\\s\\S]*?<\\/section>`);
  const m = html.match(re);
  return m ? m[0] : '';
}

function extractDashboardDefaultsDialog(html) {
  return html.match(/<dialog id="dashboard-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

function extractProjectCreateDialog(html) {
  return html.match(/<dialog id="project-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

function extractProjectCard(html, projectId) {
  const cards = html.match(/<article\b[^>]*data-project-card[^>]*>[\s\S]*?<\/article>/g) || [];
  return cards.find((card) => card.includes(`data-project-card-link href="/projects/${projectId}"`)) || '';
}

async function createProject(app, { title, status = 'tbd', projectType = 'images' }) {
  const parts = [
    `title=${encodeURIComponent(title)}`,
    `status=${status}`,
    `projectType=${projectType}`,
    'priority=normal',
  ];
  parts.push('_csrf=' + encodeURIComponent(app.testCsrfToken));

  const res = await app.testAgent
    .post('/projects')
    .send(parts.join('&'))
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  return res.headers.location.replace('/projects/', '');
}

function setDashboardSectionVisibility(app, sectionId, visible) {
  const defaultsService = app.locals.dashboardDefaultsService;
  const defaults = defaultsService.getDefaults();
  defaultsService.saveDefaults({
    ...defaults,
    sections: {
      ...defaults.sections,
      [sectionId]: { ...defaults.sections[sectionId], visible },
    },
  });
}

function buildDashboardDefaultsForm(app, {
  order = app.locals.dashboardDefaultsService.getDefaults().order,
  sections = {},
} = {}) {
  const defaults = app.locals.dashboardDefaultsService.getDefaults();
  return {
    _csrf: app.testCsrfToken,
    orderedSectionIds: order.join(','),
    sections: Object.fromEntries(Object.keys(defaults.sections).map((sectionId) => {
      const section = { ...defaults.sections[sectionId], ...sections[sectionId] };
      return [sectionId, {
        visible: section.visible ? ['0', '1'] : '0',
        itemCount: String(section.itemCount),
        sort: section.sort,
        order: section.order,
      }];
    })),
  };
}

describe('dashboard HTTP composition', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;

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
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Summary cards ──────────────────────────────────────────────────

  describe('dashboard summary cards', () => {
    it('renders exactly the four established summary-card concepts', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const cards = extractSummaryCards(res.text);
      const cardCount = (cards.match(/class="summary-card( summary-card--[\w-]+)?"/g) || []).length;
      expect(cardCount).toBe(4);
      expect(cards).toContain('Projects');
      expect(cards).toContain('Assets');
      expect(cards).toContain('Releases');
      expect(cards).toContain('Missing assets');
    });

    it('does not render a Needs attention card or section', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).not.toContain('Need attention');
      expect(res.text).not.toContain('needs-attention');
      expect(res.text).not.toContain('summary-card--attention');
    });

    it('Projects summary card links to /projects', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const cards = extractSummaryCards(res.text);
      expect(cards).toContain('href="/projects"');
    });

    it('Assets summary card links to the canonical assetsUrl (/asset-viewer)', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const cards = extractSummaryCards(res.text);
      expect(cards).toMatch(/<a class="summary-card" href="\/asset-viewer">/);
    });

    it('renders the total Releases card with the canonical /releases destination', async () => {
      const projectId = await createProject(app, { title: 'Release Summary Project' });
      db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date)
        VALUES (?, ?, '', '', NULL, NULL, NULL, NULL)
      `).run(Number(projectId), 'Active Release');
      db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at)
        VALUES (?, ?, '', '', NULL, NULL, NULL, NULL, '2026-01-01 00:00:00')
      `).run(Number(projectId), 'Archived Release');

      const res = await app.testAgent.get('/').expect(200);
      const releaseCard = extractSummaryCards(res.text).match(
        /<a class="summary-card" href="\/releases">[\s\S]*?<\/a>/,
      )?.[0] || '';

      expect(releaseCard).toContain('<span class="summary-card-value">2</span>');
      expect(releaseCard).toContain('<span class="summary-card-label">Releases</span>');
      expect(releaseCard).toContain('Including archived releases');
    });

    it('Missing assets summary card links to the canonical missingAssetsUrl (/asset-viewer?presence=missing)', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const cards = extractSummaryCards(res.text);
      expect(cards).toContain('href="/asset-viewer?presence=missing"');
    });

    it('renders the missing-assets count and link without the removed release-reference field', async () => {
      const projectId = await createProject(app, { title: 'Missing Asset Summary Project' });
      const asset = createAssetRepository(db).upsert(Number(projectId), 'missing.txt', {
        filename: 'missing.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);

      const res = await app.testAgent.get('/').expect(200);
      const missingCard = extractSummaryCards(res.text).match(
        /<a class="summary-card summary-card--warning" href="\/asset-viewer\?presence=missing">[\s\S]*?<\/a>/,
      )?.[0] || '';

      expect(missingCard).toContain('<span class="summary-card-value">1</span>');
      expect(missingCard).toContain('href="/asset-viewer?presence=missing"');
      expect(DASHBOARD_TEMPLATE).not.toContain('referencedByReleases');
    });

    it('renders concise supporting context on every summary card', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const cards = extractSummaryCards(res.text);
      expect((cards.match(/summary-card-context/g) || []).length).toBe(4);
      expect(cards).toContain('Projects currently tracked');
      expect(cards).toContain('Across all projects');
      expect(cards).toContain('Including archived releases');
      expect(cards).toContain('Files missing at the last scan');
    });

    it('uses the established summary-card structure for all four cards', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const cards = extractSummaryCards(res.text).match(
        /<a class="summary-card(?: summary-card--[\w-]+)?" href="[^"]+">[\s\S]*?<\/a>/g,
      ) || [];

      expect(cards).toHaveLength(4);
      for (const card of cards) {
        expect(card).toContain('summary-card-value');
        expect(card).toContain('summary-card-label');
        expect(card).toContain('summary-card-context');
      }
    });

    it('removes redundant View All Projects and View All Releases actions', async () => {
      const res = await app.testAgent.get('/').expect(200);

      expect(res.text).not.toMatch(/View all projects/i);
      expect(res.text).not.toMatch(/View all releases/i);
    });

    it('summary cards have aria-label on the section', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).toContain('aria-label="Overview"');
    });

    it('summary-card-value has numeric content', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).toContain('summary-card-value');
      expect(res.text).toContain('summary-card-label');
    });

    it('summary cards have tabular-nums font-variant-numeric in CSS', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.summary-card-value');
      expect(css).toContain('font-variant-numeric: tabular-nums');
    });

    it('summary cards have responsive grid rules', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const css = extractStyle(res.text);
      expect(css).toContain('.summary-cards');
      expect(css).toContain('grid-template-columns');
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
    });
  });

  describe('dashboard project controls', () => {
    it('renders the established NSFW toggle contract for both persisted states and returns to the Dashboard', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const nsfwForm = res.text.match(/<form method="post" action="\/projects\/nsfw-filter" class="inline-form" data-projects-nsfw-filter>[\s\S]*?<\/form>/)?.[0] || '';

      expect(nsfwForm).toContain('name="enabled" value="1"');
      expect(nsfwForm).toContain('name="returnTo" value="/"');
      expect(nsfwForm).toContain('id="projects-nsfw-toggle"');
      expect(nsfwForm).toContain('data-projects-nsfw-toggle');
      expect(nsfwForm).toContain('aria-pressed="false"');
      expect(nsfwForm).toContain('aria-label="Enable NSFW filter"');
      expect(nsfwForm).toContain('data-tooltip="Enable NSFW filter"');
      expect(DASHBOARD_TEMPLATE).not.toContain('creatorcrate-dashboard');

      await app.testAgent
        .post('/projects/nsfw-filter')
        .type('form')
        .send({ _csrf: app.testCsrfToken, enabled: '1', returnTo: '/' })
        .expect('Location', '/')
        .expect(302);

      expect(db.prepare("SELECT value FROM app_meta WHERE key = 'nsfw_filter.enabled'").pluck().get()).toBe('1');

      const enabledDashboard = await app.testAgent.get('/').expect(200);
      const enabledNsfwForm = enabledDashboard.text.match(/<form method="post" action="\/projects\/nsfw-filter" class="inline-form" data-projects-nsfw-filter>[\s\S]*?<\/form>/)?.[0] || '';

      expect(enabledNsfwForm).toContain('name="enabled" value="0"');
      expect(enabledNsfwForm).toContain('aria-pressed="true"');
      expect(enabledNsfwForm).toContain('aria-label="Disable NSFW filter"');
      expect(enabledNsfwForm).toContain('data-tooltip="Disable NSFW filter"');
    });

    it('reuses one established project-grid size control for Dashboard project sections', async () => {
      await createProject(app, { title: 'Recent Size Project', status: 'ready' });
      await createProject(app, { title: 'Planned Size Project', status: 'planned' });

      const res = await app.testAgent.get('/').expect(200);
      const controls = res.text;

      expect((controls.match(/data-project-grid-size-controls/g) || [])).toHaveLength(1);
      expect((controls.match(/data-asset-grid-size-controls/g) || [])).toHaveLength(1);
      expect(controls).toContain('data-asset-grid-size-controls');
      expect(controls).toContain('data-grid-size-labels-interactive');
      expect(controls).toContain('data-grid-size-slider');
      expect(controls).toContain('min="1" max="3" step="1" value="2"');
      expect(controls).toContain('data-grid-size-option-label="compact"');
      expect(controls).toContain('data-grid-size-option-label="default"');
      expect(controls).toContain('data-grid-size-option-label="large"');
      expect(DASHBOARD_TEMPLATE).not.toContain('creatorcrate-dashboard-grid-size');

      for (const sectionName of ['recent-projects', 'status:planned']) {
        expect(extractSection(res.text, sectionName)).toContain('<ul class="project-grid">');
      }
    });
  });


  describe('dashboard defaults dialog markup', () => {
    it('renders the established Defaults control and keeps the dialog available but closed by default', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const dialog = extractDashboardDefaultsDialog(res.text);

      expect(res.text).toContain('href="/?defaults=1" aria-label="Dashboard defaults"');
      expect(res.text).toContain('data-dialog-open="dashboard-defaults-dialog"');
      expect(res.text).toContain('data-dashboard-defaults-link');
      expect(dialog).toContain('class="app-dialog" data-app-dialog');
      expect(dialog).not.toContain('data-app-dialog open');
      expect(res.text).toContain('id="projects-nsfw-toggle"');
      expect(res.text).toContain('data-asset-grid-size-controls');
    });

    it('opens from ?defaults=1 and renders every normalized section in saved order', async () => {
      const defaults = app.locals.dashboardDefaultsService.getDefaults();
      defaults.order = [...defaults.order].reverse();
      defaults.sections['recently-updated'] = { ...defaults.sections['recently-updated'], visible: false, itemCount: 3 };
      defaults.sections['status:ready'] = { ...defaults.sections['status:ready'], itemCount: 17 };
      app.locals.dashboardDefaultsService.saveDefaults(defaults);

      const res = await app.testAgent.get('/?defaults=1').expect(200);
      const dialog = extractDashboardDefaultsDialog(res.text);
      const renderedIds = Array.from(dialog.matchAll(/data-dashboard-section-id="([^"]+)"/g), ([, id]) => id);
      const sortDialog = res.text.match(/<dialog id="dashboard-defaults-sort-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(dialog).toContain('class="app-dialog" data-app-dialog open');
      expect(dialog).toContain('method="post" action="/dashboard/defaults"');
      expect(dialog).toContain('data-dialog-form data-dashboard-defaults-reorder-form');
      expect(renderedIds).toEqual(defaults.order);
      expect(dialog).toContain('name="orderedSectionIds" data-dashboard-defaults-order-input value="' + defaults.order.join(',') + '"');
      expect(renderedIds).toHaveLength(7);
      expect(dialog).not.toContain('data-dashboard-section-id="projects"');
      expect(dialog).not.toContain('data-dashboard-section-id="assets"');
      expect(dialog).not.toContain('data-dashboard-section-id="missing-assets"');
      expect(dialog).not.toContain('data-dashboard-section-id="releases"');

      for (const sectionId of defaults.order) {
        const section = app.locals.dashboardDefaultsService.getDefaults().sections[sectionId];
        const id = 'dashboard-defaults-section-' + sectionId;
        const checkbox = dialog.match(new RegExp('<input\\s+type="checkbox"\\s+id="' + id + '-visible"[^>]*>'))?.[0] || '';

        expect(dialog).toContain('data-dashboard-defaults-reorder-item');
        expect(dialog).toContain('data-dashboard-section-id="' + sectionId + '"');
        expect(dialog).toContain('class="notes-reorder-row dashboard-defaults-section"');
        expect(dialog).toContain('data-dashboard-defaults-reorder-handle');
        expect(dialog).toContain('name="sections[' + sectionId + '][visible]" value="0"');
        expect(checkbox).toContain('name="sections[' + sectionId + '][visible]"');
        expect(checkbox.includes('checked')).toBe(section.visible);
        expect(dialog).toContain('id="' + id + '-item-count" type="number" name="sections[' + sectionId + '][itemCount]" value="' + section.itemCount + '"');
        expect(dialog).toContain('name="sections[' + sectionId + '][sort]" value="' + section.sort + '" data-dashboard-defaults-sort-input');
        expect(dialog).toContain('name="sections[' + sectionId + '][order]" value="' + section.order + '" data-dashboard-defaults-section-order-input');
        expect(dialog).toContain('data-dashboard-defaults-sort-options-trigger data-dialog-open="dashboard-defaults-sort-dialog"');
      }

      expect(dialog).toContain('class="notes-reorder-list dashboard-defaults-section-list"');
      expect(dialog).toContain('class="settings-section dashboard-defaults-settings-section"');
      expect(dialog).toContain('class="dashboard-defaults-section-content"');
      expect(dialog).not.toContain('data-dashboard-defaults-order-position');
      expect(dialog).not.toContain('<span class="field-label">Show section</span>');
      expect(dialog.match(/<span class="sr-only">Show [^<]+<\/span>/g)).toHaveLength(7);
      expect(dialog.match(/<label class="sr-only" for="dashboard-defaults-section-[^"]+-item-count">Items to show for [^<]+<\/label>/g)).toHaveLength(7);
      expect(dialog).toContain('min="1" max="25" step="1"');
      expect(dialog).toContain('Drag a handle to move a section, or focus a handle and use Arrow Up, Arrow Down, Home, or End. Select Save defaults to keep the new order.');
      expect(dialog).not.toMatch(/<button[^>]+(?:aria-label|title)="[^"]*\b(?:Up|Down)\b/i);
      expect(dialog).not.toContain('>Cancel</button>');
      expect(dialog).toContain('>Save defaults</button>');
      expect((dialog.match(/aria-label="Sort options for [^"]+"/g) || [])).toHaveLength(7);
      expect((res.text.match(/id="dashboard-defaults-sort-dialog"/g) || [])).toHaveLength(1);
      expect(sortDialog).toContain('Sort by');
      expect(sortDialog).not.toContain('value="published"');
      expect(sortDialog).not.toContain('value="planned"');
      expect(sortDialog).toContain('data-dashboard-defaults-sort-apply');
    });

    it('keeps the shared dialog body as the Dashboard Defaults scroll owner', async () => {
      const res = await app.testAgent.get('/?defaults=1').expect(200);
      const dialog = extractDashboardDefaultsDialog(res.text);

      expect(dialog).toContain('class="app-dialog-body"');
      expect(dialog).toContain('class="settings-section dashboard-defaults-settings-section"');
      expect(SERVED_CSS).toMatch(/#dashboard-defaults-dialog \.app-dialog-form \{\r?\n        flex: 1 1 auto;\r?\n        min-height: 0;\r?\n        overflow: hidden;\r?\n      \}/);
      expect(SERVED_CSS).toMatch(/#dashboard-defaults-dialog \.app-dialog-body \{\r?\n        flex: 1 1 auto;\r?\n        min-height: 0;\r?\n      \}/);
      expect(SERVED_CSS).toMatch(/#dashboard-defaults-dialog \.dashboard-defaults-settings-section \{\r?\n        flex: 0 0 auto;\r?\n        gap: var\(--space-md\);\r?\n        margin-bottom: 0;\r?\n        padding-bottom: var\(--space-md\);\r?\n        overflow: visible;\r?\n      \}/);
      expect(SERVED_CSS).toContain('grid-template-columns: minmax(0, 1fr) auto auto minmax(7rem, 7.5rem);');
    });
  });

  describe('dashboard defaults save endpoint', () => {
    it('accepts a current custom status and rejects the same submitted section after catalogue deletion', async () => {
      const catalogue = app.locals.projectOptionCatalogueService;
      catalogue.addOption('status', { name: 'Quality Review', color: '#123456' });
      const currentForm = buildDashboardDefaultsForm(app);

      await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(currentForm)
        .expect(200);
      expect(app.locals.dashboardDefaultsService.getDefaults().sections)
        .toHaveProperty('status:quality-review');

      catalogue.deleteOption('status', 'quality-review');
      expect(app.locals.dashboardDefaultsService.getDefaults().sections)
        .not.toHaveProperty('status:quality-review');
      const rejected = await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(currentForm)
        .expect(422);

      expect(rejected.body.errors.order).toMatch(/unsupported section/i);
      expect(app.locals.dashboardDefaultsService.getDefaults().sections)
        .not.toHaveProperty('status:quality-review');
    });

    it('saves a complete custom configuration through the native form and redirects to the Dashboard notice destination', async () => {
      const defaults = app.locals.dashboardDefaultsService.getDefaults();
      const order = [...defaults.order].reverse();
      const sections = Object.fromEntries(order.map((sectionId, index) => [sectionId, {
        visible: sectionId !== 'status:archived',
        itemCount: index + 1,
      }]));

      await app.testAgent
        .post('/dashboard/defaults')
        .type('form')
        .send(buildDashboardDefaultsForm(app, { order, sections }))
        .expect('Location', '/?notice=dashboard_defaults_saved')
        .expect(302);

      expect(app.locals.dashboardDefaultsService.getDefaults()).toMatchObject({
        version: 1,
        order,
        sections,
      });
    });

    it('returns the established JSON success shape and persists independent counts and hidden states', async () => {
      const defaults = app.locals.dashboardDefaultsService.getDefaults();
      const order = [...defaults.order.slice(3), ...defaults.order.slice(0, 3)];
      const sections = Object.fromEntries(order.map((sectionId, index) => [sectionId, {
        visible: sectionId !== 'status:completed',
        itemCount: 25 - index,
      }]));

      const res = await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(buildDashboardDefaultsForm(app, { order, sections }))
        .expect(200);

      expect(res.body).toEqual({
        status: 'success',
        message: 'Dashboard defaults saved successfully.',
        values: {},
      });
      expect(app.locals.dashboardDefaultsService.getDefaults()).toMatchObject({ version: 1, order, sections });
    });

    it.each([
      ['duplicate section', (order) => [order[0], order[0], ...order.slice(2)]],
      ['missing section', (order) => order.slice(1)],
      ['unknown section', (order) => [...order.slice(0, -1), 'projects']],
    ])('rejects a %s order without changing saved defaults', async (_label, changeOrder) => {
      const previous = app.locals.dashboardDefaultsService.getDefaults();
      const res = await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(buildDashboardDefaultsForm(app, { order: changeOrder(previous.order) }))
        .expect(422);

      expect(res.body.status).toBe('error');
      expect(res.body.errors.order).toBeTruthy();
      expect(app.locals.dashboardDefaultsService.getDefaults()).toEqual(previous);
    });

    it('persists valid per-section sort and order values', async () => {
      const form = buildDashboardDefaultsForm(app, {
        sections: {
          'recently-updated': { sort: 'title', order: 'desc' },
          'status:ready': { sort: 'created', order: 'asc' },
        },
      });

      await app.testAgent
        .post('/dashboard/defaults')
        .type('form')
        .send(form)
        .expect(302);

      const saved = app.locals.dashboardDefaultsService.getDefaults();
      expect(saved.sections['recently-updated']).toMatchObject({ sort: 'title', order: 'desc' });
      expect(saved.sections['status:ready']).toMatchObject({ sort: 'created', order: 'asc' });
    });

    it.each([
      ['sort', 'unexpected'],
      ['order', 'sideways'],
    ])('rejects an unsupported section %s without changing saved defaults', async (field, value) => {
      const previous = app.locals.dashboardDefaultsService.getDefaults();
      const form = buildDashboardDefaultsForm(app);
      form.sections['recently-updated'][field] = value;

      const res = await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(form)
        .expect(422);

      expect(res.body.errors[`sections[recently-updated][${field}]`]).toBeTruthy();
      expect(app.locals.dashboardDefaultsService.getDefaults()).toEqual(previous);
    });

    it.each([
      ['zero', '0'],
      ['above maximum', '26'],
      ['non-integer', '1.5'],
      ['non-numeric', 'many'],
      ['missing', undefined],
    ])('rejects a %s item count without changing saved defaults', async (_label, itemCount) => {
      const previous = app.locals.dashboardDefaultsService.getDefaults();
      const form = buildDashboardDefaultsForm(app);
      if (itemCount === undefined) delete form.sections['recently-updated'].itemCount;
      else form.sections['recently-updated'].itemCount = itemCount;

      const res = await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(form)
        .expect(422);

      expect(res.body.errors['sections[recently-updated][itemCount]']).toBeTruthy();
      expect(app.locals.dashboardDefaultsService.getDefaults()).toEqual(previous);
    });

    it('returns independent field-name errors for multiple invalid counts, including status sections', async () => {
      const previous = app.locals.dashboardDefaultsService.getDefaults();
      const form = buildDashboardDefaultsForm(app);
      form.sections['recently-updated'].itemCount = '0';
      form.sections['status:ready'].itemCount = 'many';

      const res = await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(form)
        .expect(422);

      expect(res.body).toMatchObject({
        status: 'error',
        errors: {
          'sections[recently-updated][itemCount]': 'Items to show must be between 1 and 25.',
          'sections[status:ready][itemCount]': 'Items to show must be an integer.',
        },
        values: {
          orderedSectionIds: form.orderedSectionIds,
          sections: {
            'recently-updated': { visible: true, itemCount: '0' },
            'status:ready': { visible: true, itemCount: 'many' },
          },
        },
      });
      expect(Object.values(res.body.errors).every((error) => typeof error === 'string')).toBe(true);
      expect(app.locals.dashboardDefaultsService.getDefaults()).toEqual(previous);
    });

    it('parses the hidden-plus-checkbox visibility contract into explicit booleans', async () => {
      const form = buildDashboardDefaultsForm(app);
      form.sections['recently-updated'].visible = ['0', '1'];
      form.sections['status:archived'].visible = '0';

      await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(form)
        .expect(200);

      const saved = app.locals.dashboardDefaultsService.getDefaults();
      expect(saved.sections['recently-updated'].visible).toBe(true);
      expect(saved.sections['status:archived'].visible).toBe(false);
    });

    it('rejects summary-card tampering without persisting an unknown Dashboard section', async () => {
      const previous = app.locals.dashboardDefaultsService.getDefaults();
      const form = buildDashboardDefaultsForm(app, {
        order: [...previous.order.slice(0, -1), 'projects'],
      });
      form.sections.projects = { visible: ['0', '1'], itemCount: '8' };

      const res = await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(form)
        .expect(422);

      expect(res.body.errors.order).toBeTruthy();
      expect(app.locals.dashboardDefaultsService.getDefaults()).toEqual(previous);
    });

    it('keeps the app-level CSRF protection on the save endpoint', async () => {
      const form = buildDashboardDefaultsForm(app);
      delete form._csrf;

      await app.testAgent
        .post('/dashboard/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(form)
        .expect(403);
    });

    it('re-renders the open dialog with submitted count errors for native invalid posts', async () => {
      const form = buildDashboardDefaultsForm(app, {
        order: [...app.locals.dashboardDefaultsService.getDefaults().order].reverse(),
      });
      form.sections['recently-updated'].itemCount = '0';

      const res = await app.testAgent
        .post('/dashboard/defaults')
        .type('form')
        .send(form)
        .expect(422);
      const dialog = extractDashboardDefaultsDialog(res.text);

      expect(dialog).toContain('class="app-dialog" data-app-dialog open');
      expect(dialog).toContain('Dashboard defaults could not be saved. Fix the invalid fields and try again.');
      expect(dialog).toContain('Items to show must be between 1 and 25.');
      expect(dialog).toContain('value="0"');
      expect(Array.from(dialog.matchAll(/data-dashboard-section-id="([^"]+)"/g), ([, id]) => id)).toEqual(form.orderedSectionIds.split(','));
    });

    it('re-renders static and status visibility errors with switch-level ARIA feedback without persisting', async () => {
      const previous = app.locals.dashboardDefaultsService.getDefaults();
      const form = buildDashboardDefaultsForm(app);
      form.sections['recently-updated'].visible = 'invalid';
      form.sections['status:ready'].visible = 'invalid';

      const res = await app.testAgent
        .post('/dashboard/defaults')
        .type('form')
        .send(form)
        .expect(422);
      const dialog = extractDashboardDefaultsDialog(res.text);

      expect(dialog).toContain('class="app-dialog" data-app-dialog open');
      expect(dialog).toContain('data-dialog-field="sections[recently-updated][visible]"');
      expect(dialog).toContain('data-dialog-field="sections[status:ready][visible]"');
      expect(dialog).toContain('id="dashboard-defaults-section-recently-updated-visible"');
      expect(dialog).toContain('id="dashboard-defaults-section-status:ready-visible"');
      expect(dialog).toContain('aria-describedby="dashboard-defaults-section-recently-updated-visible-error"');
      expect(dialog).toContain('aria-describedby="dashboard-defaults-section-status:ready-visible-error"');
      expect(dialog).toContain('Show section must be explicitly enabled or disabled.');
      expect(dialog).toMatch(/id="dashboard-defaults-section-recently-updated-visible"[\s\S]*?aria-invalid="true">/);
      expect(dialog).toMatch(/id="dashboard-defaults-section-status:ready-visible"[\s\S]*?aria-invalid="true">/);
      expect(dialog).not.toMatch(/id="dashboard-defaults-section-recently-updated-visible"[^>]*\schecked/);
      expect(dialog).not.toMatch(/id="dashboard-defaults-section-status:ready-visible"[^>]*\schecked/);
      expect(dialog).toContain(`value="${previous.sections['status:planned'].itemCount}"`);
      expect(Array.from(dialog.matchAll(/data-dashboard-section-id="([^"]+)"/g), ([, id]) => id)).toEqual(form.orderedSectionIds.split(','));
      expect(app.locals.dashboardDefaultsService.getDefaults()).toEqual(previous);
    });
  });

  describe('dashboard static section visibility', () => {
    it('omits the Recently updated projects section and empty state when recently-updated is hidden', async () => {
      setDashboardSectionVisibility(app, 'recently-updated', false);

      const res = await app.testAgent.get('/').expect(200);

      expect(extractSection(res.text, 'recent-projects')).toBe('');
      expect(res.text).not.toContain('<h2>Recently updated projects</h2>');
      expect(res.text).not.toContain('No projects are currently tracked');
    });

    it('keeps a visible but empty retained section and its established empty state', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const section = extractSection(res.text, 'recent-projects');

      expect(section).toContain('<h2>Recently updated projects</h2>');
      expect(section).toContain('empty-state');
      expect(section).toContain('No projects are currently tracked');
    });
  });
  describe('dashboard configurable section rendering', () => {
    it('observes a custom status live for heading metadata, queries, counts, and shared Project cards', async () => {
      app.locals.projectOptionCatalogueService.addOption('status', {
        name: 'Editorial Review',
        color: '#123456',
      });
      const projectId = await createProject(app, {
        title: 'Editorial Project',
        status: 'editorial-review',
      });

      const dashboard = (await app.testAgent.get('/?defaults=1').expect(200)).text;
      const section = extractSection(dashboard, 'status:editorial-review');
      const card = extractProjectCard(section, projectId);

      expect(section).toContain('<h2>Editorial Review</h2>');
      expect(section).toContain('Editorial Project');
      expect(card).toContain('>Editorial Review</span>');
      expect(card).toContain('style="--project-badge-bg: #123456; --project-badge-tint: 18%; --project-badge-fg: #8495A7"');
      expect(extractSummaryCards(dashboard)).toContain('<span class="summary-card-value">1</span>');
      expect(extractDashboardDefaultsDialog(dashboard)).toContain('data-dashboard-section-id="status:editorial-review"');
    });

    it('renders every visible static and status section in saved order with service-provided limits', async () => {
      const defaults = app.locals.dashboardDefaultsService.getDefaults();
      defaults.order = [
        'status:ready',
        'status:archived',
        'recently-updated',
        'status:tbd',
        'status:planned',
        'status:in-progress',
        'status:completed',
      ];
      defaults.sections['status:ready'].itemCount = 1;
      defaults.sections['status:tbd'].itemCount = 2;
      app.locals.dashboardDefaultsService.saveDefaults(defaults);

      await createProject(app, { title: 'Ready First', status: 'ready' });
      await createProject(app, { title: 'Ready Second', status: 'ready' });
      await createProject(app, { title: 'TBD First', status: 'tbd' });
      await createProject(app, { title: 'TBD Second', status: 'tbd' });
      await createProject(app, { title: 'Planned Status Project', status: 'planned' });
      await createProject(app, { title: 'In Progress Status Project', status: 'in-progress' });
      await createProject(app, { title: 'Completed Status Project', status: 'completed' });
      const archivedProjectId = await createProject(app, { title: 'Archived Status Project', status: 'completed' });
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archived', Number(archivedProjectId));

      const dashboard = (await app.testAgent.get('/').expect(200)).text;
      const expectedHeadings = [
        'Ready',
        'Archived',
        'Recently updated projects',
        'Tbd',
        'Planned',
        'In Progress',
        'Completed',
      ];

      const headingPositions = expectedHeadings.map((heading) => dashboard.indexOf(`<h2>${heading}</h2>`));
      expect(headingPositions.every((position) => position >= 0)).toBe(true);
      expect(headingPositions).toEqual([...headingPositions].sort((left, right) => left - right));

      for (const [sectionId, title] of [
        ['status:tbd', 'TBD First'],
        ['status:planned', 'Planned Status Project'],
        ['status:in-progress', 'In Progress Status Project'],
        ['status:completed', 'Completed Status Project'],
        ['status:archived', 'Archived Status Project'],
      ]) {
        expect(extractSection(dashboard, sectionId)).toContain(title);
      }

      const archivedSection = extractSection(dashboard, 'status:archived');
      expect(archivedSection).toContain('<span class="status-badge status-badge--archived">Archived</span>');
      expect(extractSection(dashboard, 'recent-projects')).not.toContain('Archived Status Project');
      expect(app.locals.projectOptionCatalogueService.getStatusCatalogue().map(({ value }) => value))
        .not.toContain('archived');

      const readySection = extractSection(dashboard, 'status:ready');
      expect(readySection).toMatch(/Ready (First|Second)/);
      expect((readySection.match(/<article\b[^>]*\bdata-project-card(?:\s|=|>)[^>]*>/g) || [])).toHaveLength(1);
      expect((extractSection(dashboard, 'status:tbd').match(/<article\b[^>]*\bdata-project-card(?:\s|=|>)[^>]*>/g) || [])).toHaveLength(2);
      expect(readySection).toMatch(/<h3 class="project-grid-card-title">[\s\S]*?<\/h3>/);
      expect(extractSummaryCards(dashboard)).toContain('summary-card-value');
      expect(dashboard).toContain('data-dashboard-defaults-link');
      expect(dashboard).toContain('id="projects-nsfw-toggle"');
      expect(dashboard).toContain('data-asset-grid-size-controls');
    });

    it('omits hidden static and status sections while keeping a visible empty status section', async () => {
      setDashboardSectionVisibility(app, 'status:planned', false);

      const dashboard = (await app.testAgent.get('/').expect(200)).text;

      expect(extractSection(dashboard, 'status:planned')).toBe('');
      expect(dashboard).not.toContain('<h2>Planned</h2>');
      expect(extractSection(dashboard, 'status:ready')).toContain('<h2>Ready</h2>');
      expect(extractSection(dashboard, 'status:ready')).toContain('empty-state');
      expect(extractSection(dashboard, 'status:ready')).toContain('No ready projects');
      expect(extractSection(dashboard, 'status:ready')).not.toContain('href="/projects/new"');
    });

    it('uses the one generic Dashboard section loop without legacy static blocks', () => {
      expect(DASHBOARD_TEMPLATE).toContain('{% for section in dashboardSections %}');
      expect(DASHBOARD_TEMPLATE).not.toContain('overdue-projects');
      expect(DASHBOARD_TEMPLATE).not.toContain('upcoming-releases');
      expect(DASHBOARD_TEMPLATE).not.toContain('recent-projects');
    });
  });

  // ─── Recently updated projects ──────────────────────────────────────

  describe('dashboard recently updated projects section', () => {
    it('renders recently updated projects through shared cards with Status and Project Type badges, no Priority', async () => {
      const projectId = await createProject(app, { title: 'Recent Card Project', status: 'ready', projectType: 'comic' });

      const res = await app.testAgent.get('/').expect(200);
      const section = extractSection(res.text, 'recent-projects');
      const card = extractProjectCard(section, projectId);
      expect(section).toContain('<ul class="project-grid">');
      expect(card).toMatch(/<article class="project-card project-card--grid project-grid-card" data-project-card>/);
      expect(card).toContain('Recent Card Project');
      expect(card).toContain('project-status-badge');
      expect(card).toContain('>Ready</span>');
      expect(card.match(/project-option-badge project-type-badge/g) || []).toHaveLength(2);
      expect(card).toContain('style="--project-badge-bg: #34D399; --project-badge-tint: 18%; --project-badge-fg: #34D399"');
      expect(card).toContain('style="--project-badge-bg: #A78BFA; --project-badge-tint: 18%; --project-badge-fg: #B299FB"');
      expect(card).not.toMatch(/\bpriority\b/i);
    });

    it('shows the established empty-state contract when no projects are tracked', async () => {
      const res = await app.testAgent.get('/').expect(200);
      const section = extractSection(res.text, 'recent-projects');
      expect(section).toContain('empty-state');
      expect(section).toContain('No projects are currently tracked');
      expect(section).toContain('Create a project to start organizing releases and assets.');
      expect(section).toContain('href="/projects/new"');
    });
  });

  describe('dashboard project-card heading hierarchy', () => {
    it('renders section headings as h2 and grid-card titles as h3 without changing the default Projects card title', async () => {
      const recentId = await createProject(app, { title: 'Recent Heading Project', status: 'ready' });

      const dashboard = (await app.testAgent.get('/').expect(200)).text;
      const sections = [
        ['recent-projects', 'Recently updated projects', recentId],
        ['status:ready', 'Ready', recentId],
      ];

      for (const [className, heading, projectId] of sections) {
        const section = extractSection(dashboard, className);
        expect(section).toContain(`<h2>${heading}</h2>`);
        expect(extractProjectCard(section, projectId)).toMatch(/<h3 class="project-grid-card-title">[\s\S]*?<\/h3>/);
        expect(section).not.toMatch(/<h2 class="project-grid-card-title">/);
      }

      const projects = (await app.testAgent.get('/projects').expect(200)).text;
      expect(extractProjectCard(projects, recentId)).toMatch(/<h2 class="project-grid-card-title">[\s\S]*?<\/h2>/);
    });
  });

  // ─── Removed sections ───────────────────────────────────────────────

  describe('removed dashboard sections', () => {
    it('normalizes stale Project-date Dashboard defaults without losing retained preferences', async () => {
      createAppMetaRepository(db).setValue('page_defaults.dashboard', JSON.stringify({
        version: 1,
        order: ['status:ready', 'overdue', 'upcoming', 'recently-updated'],
        sections: {
          overdue: { visible: true, itemCount: 3, sort: 'planned', order: 'asc' },
          upcoming: { visible: true, itemCount: 4, sort: 'planned', order: 'asc' },
          'status:ready': { visible: false, itemCount: 12, sort: 'title', order: 'asc' },
          'recently-updated': { visible: true, itemCount: 6, sort: 'published', order: 'asc' },
        },
      }));

      const res = await app.testAgent.get('/?defaults=1').expect(200);
      const defaults = app.locals.dashboardDefaultsService.getDefaults();
      const dialog = extractDashboardDefaultsDialog(res.text);

      expect(defaults.order.slice(0, 2)).toEqual(['status:ready', 'recently-updated']);
      expect(defaults.sections).not.toHaveProperty('overdue');
      expect(defaults.sections).not.toHaveProperty('upcoming');
      expect(defaults.sections['status:ready']).toEqual({
        visible: false, itemCount: 12, sort: 'title', order: 'asc',
      });
      expect(defaults.sections['recently-updated']).toEqual({
        visible: true, itemCount: 6, sort: 'updated', order: 'asc',
      });
      expect(res.text).not.toContain('data-dashboard-section="overdue"');
      expect(res.text).not.toContain('data-dashboard-section="upcoming"');
      expect(dialog).not.toContain('data-dashboard-section-id="overdue"');
      expect(dialog).not.toContain('data-dashboard-section-id="upcoming"');
      expect(dialog).not.toContain('data-dashboard-section-id="releases"');
    });

    it('does not render the Releases needing attention section', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).not.toContain('Releases needing attention');
      expect(res.text).not.toContain('id="needs-attention"');
    });

    it('does not render the Missing selection section', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).not.toContain('Missing selection');
      expect(res.text).not.toContain('attention-selection');
    });

    it('does not render the Workflow summary section or its project-counts details', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).not.toContain('Workflow summary');
      expect(res.text).not.toContain('project-counts-details');
      expect(res.text).not.toContain('count-grid');
    });

    it('does not render any old release-list or attention-group markup', async () => {
      await createProject(app, { title: 'No Old Markup Project', status: 'planned' });

      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).not.toContain('release-list');
      expect(res.text).not.toContain('attention-group');
    });
  });

  // ─── Dashboard visual and structural contracts ─────────────────────
  //
  // Unrelated to the redesign — kept as-is where they still apply.

  describe('dashboard visual and structural contracts', () => {
    it('has exactly one h1', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('has a page-heading carrying navigation actions, not a description', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(hasClass(res.text, 'page-heading-description')).toBe(false);
    });

    it('renders summary cards section', async () => {
      const res = await app.testAgent.get('/').expect(200);
      expect(hasClass(res.text, 'summary-cards')).toBe(true);
    });

    it('dashboard renders data from the composed view-model', async () => {
      await createProject(app, { title: 'Composed Model Project', status: 'ready' });

      const res = await app.testAgent.get('/').expect(200);
      expect(res.text).toContain('summary-card-value');
      expect(res.text).toContain('project-grid');
      expect(res.text).toContain('Projects currently tracked');
    });

    it('renders one closed native New Project dialog with the standalone form defaults', async () => {
      app.locals.pageDefaultsService.saveDefault('new_project', 'status', 'ready');
      app.locals.tagService.createTag({ name: 'Dashboard dialog tag' });

      const [dashboard, standalone] = await Promise.all([
        app.testAgent.get('/').expect(200),
        app.testAgent.get('/projects/new').expect(200),
      ]);
      const dialog = extractProjectCreateDialog(dashboard.text);
      const ids = [...dashboard.text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      const newProjectOpeners = dashboard.text.match(/<a class="button button-primary" href="\/projects\/new" data-dialog-open="project-create-dialog">New Project<\/a>/g) || [];

      expect((dashboard.text.match(/<dialog id="project-create-dialog"/g) || [])).toHaveLength(1);
      expect(newProjectOpeners).toHaveLength(2);
      expect(extractSection(dashboard.text, 'recent-projects')).toContain('<a class="button button-primary" href="/projects/new" data-dialog-open="project-create-dialog">New Project</a>');
      expect(dialog).not.toBe('');
      expect(dialog).not.toMatch(/<dialog\b[^>]*\bopen(?:\s|>|=)/);
      const footer = dialog.match(/<footer class="app-dialog-footer">[\s\S]*?<\/footer>/)?.[0] || '';
      expect(footer).toContain('Create project');
      expect(footer).not.toContain('Cancel');
      expect((footer.match(/<button\b/g) || [])).toHaveLength(1);
      expect(dialog).toContain('<form id="project-create-form" method="post" action="/projects"');
      expect(dialog).toContain('data-dialog-form data-dialog-async="false"');
      expect(dialog).toContain('name="returnTo" value="/"');
      expect(dialog).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
      expect(standalone.text).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
      expect(dialog).toContain('Dashboard dialog tag');
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
