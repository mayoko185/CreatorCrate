import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { MANIFEST_FILENAME, readManifestSync } from '../src/storage/manifest.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import {
  formatProjectDirName,
  resolveProjectDir,
} from '../src/storage/project-storage.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { makeZip } from './helpers/zip-fixture.js';

vi.mock('../src/services/social-prep-tokens.js', async (importOriginal) => {
  const original = await importOriginal();
  return Object.fromEntries(Object.entries(original).map(([key, value]) => [
    key, typeof value === 'function' ? vi.fn(value) : value,
  ]));
});

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PROJECTS_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/projects/index.njk', import.meta.url));
const LEGACY_NEW_PROJECT_PRIORITY_KEY = 'page_defaults.new_project.priority';

function extractProjectCard(html, projectId) {
  const cards = html.match(/<article\b[^>]*data-project-card[^>]*>[\s\S]*?<\/article>/g) || [];
  return cards.find((card) => card.includes(`data-project-card-link href="/projects/${projectId}"`)) || '';
}

async function fetchProjectCss(agentApp) {
  const res = await request(agentApp).get('/creatorcrate.css').expect(200);
  expect(res.headers['content-type']).toMatch(/text\/css/);
  return res.text;
}

function extractProjectCards(html) {
  return html.match(/<article\b[^>]*data-project-card[^>]*>[\s\S]*?<\/article>/g) || [];
}

function extractProjectReleaseItem(card, releaseId) {
  return card.match(/<li class="project-grid-card-info-release">[\s\S]*?<\/li>/g)?.find((item) => (
    item.includes(`href="/releases/${releaseId}"`)
  )) || '';
}

function extractPageHeadingActions(html) {
  return html.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
}

function extractProjectDetailActionToolbar(html) {
  return html.match(/<nav class="project-detail-action-toolbar"[^>]*>[\s\S]*?<\/nav>/)?.[0] || '';
}

function extractProjectTags(card) {
  return card.match(/<div class="project-grid-card-info-section">([\s\S]*?)<\/div>/)?.[0] || '';
}

function extractTagFilter(html) {
  return html.match(/<fieldset class="field[^"]*asset-viewer-filter-field[^"]*">\s*<legend>Tag<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function extractStatusFilter(html) {
  return html.match(/<fieldset class="field[^"]*asset-viewer-filter-field[^"]*">\s*<legend>Status<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function extractProjectTypeFilter(html) {
  return html.match(/<fieldset class="field[^\"]*asset-viewer-filter-field[^\"]*">\s*<legend>Project Type<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function extractSortFilter(html) {
  return html.match(/<fieldset class="field[^"]*asset-viewer-filter-field[^"]*">\s*<legend>Sort<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function extractOrderFilter(html) {
  return html.match(/<fieldset class="field[^"]*asset-viewer-filter-field[^"]*">\s*<legend>Sort order<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function formatProjectSortLabel(value) {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function expectProjectSortOrderSelection(html, sort, order) {
  const sortFilter = extractSortFilter(html);
  const orderFilter = extractOrderFilter(html);
  const orderLabel = order === 'asc' ? 'Asc' : 'Desc';

  expect(sortFilter).not.toBe('');
  expect(orderFilter).not.toBe('');
  expect(sortFilter).toMatch(new RegExp(`name="sort"[^>]*value="${sort}"[^>]*checked`));
  expect(sortFilter).toContain(`data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">${formatProjectSortLabel(sort)}</span>`);
  expect(orderFilter).toMatch(new RegExp(`name="order"[^>]*value="${order}"[^>]*checked`));
  expect(orderFilter).toContain(`data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">${orderLabel}</span>`);
}

function extractProjectFormStatusField(html) {
  return html.match(/<fieldset class="field asset-filter-multiselect-field[^"]*">\s*<legend>Status[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function extractProjectFormTagsField(html) {
  return html.match(/<fieldset class="field[^"]*">\s*<legend>Tags<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function extractProjectCreateDialog(html) {
  return html.match(/<dialog id="project-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

const VOID_HTML_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function extractHtmlElement(html, start) {
  const openingTag = html.slice(start).match(/^<([a-z][\w:-]*)\b[^>]*>/i);
  if (!openingTag) return '';

  const tokens = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  tokens.lastIndex = start + openingTag[0].length;
  let depth = 1;
  let token;
  while ((token = tokens.exec(html))) {
    const tagName = token[1].toLowerCase();
    if (token[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return html.slice(start, tokens.lastIndex);
    } else if (!VOID_HTML_ELEMENTS.has(tagName) && !/\/\s*>$/.test(token[0])) {
      depth += 1;
    }
  }

  return '';
}

function extractProjectFormRow(html, rowClass) {
  const start = html.indexOf(`<div class="field-row ${rowClass}">`);
  return start >= 0 ? extractHtmlElement(html, start) : '';
}

function extractProjectSettingsSection(html, heading) {
  const match = html.match(new RegExp(`<(?:div|section) class="[^\"]*\\bsettings-section\\b[^\"]*">\\s*<h3(?:\\s+[^>]*)?>${heading}</h3>`));
  return match ? extractHtmlElement(html, match.index) : '';
}

function extractProjectDetailSection(html, className) {
  const opening = html.match(new RegExp(`<section class="[^"]*\\b${className}\\b[^"]*">`));
  return opening ? extractHtmlElement(html, opening.index) : '';
}

function extractDirectHtmlChildren(html) {
  const openingEnd = html.indexOf('>') + 1;
  const tokens = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  tokens.lastIndex = openingEnd;
  const children = [];
  let depth = 0;
  let childStart = -1;
  let token;

  while ((token = tokens.exec(html))) {
    const tagName = token[1].toLowerCase();
    if (token[0].startsWith('</')) {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0) {
        children.push(html.slice(childStart, tokens.lastIndex));
        childStart = -1;
      }
    } else if (VOID_HTML_ELEMENTS.has(tagName) || /\/\s*>$/.test(token[0])) {
      if (depth === 0) children.push(token[0]);
    } else {
      if (depth === 0) childStart = token.index;
      depth += 1;
    }
  }

  return children;
}

function expectProjectFormStructure(html, { statusError = false, tagError = false } = {}) {
  const statusSection = extractProjectSettingsSection(html, 'Status');
  expect(statusSection).not.toBe('');

  const statusRow = extractProjectFormRow(statusSection, 'status-row');
  expect(statusRow).not.toBe('');

  const statusChildren = extractDirectHtmlChildren(statusRow);
  expect(statusChildren).toHaveLength(3);
  expect(statusChildren.every((child) => child.startsWith('<div '))).toBe(true);

  const statusItem = statusChildren.find((child) => child.includes('project-status-form-trigger')) || '';
  const projectTypeItem = statusChildren.find((child) => child.includes('project-type-form-trigger')) || '';
  const tagsItem = statusChildren.find((child) => child.includes('project-tags-form-trigger')) || '';

  expect(statusItem).not.toBe('');
  expect(projectTypeItem).not.toBe('');
  expect(tagsItem).not.toBe('');
  expect(statusItem).toMatch(/^<div class="field status-field">/);
  expect(projectTypeItem).toMatch(/^<div class="field status-field">/);
  expect(tagsItem).toMatch(/^<div class="field status-field">/);
  expect(statusItem).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
  expect(projectTypeItem).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
  expect(projectTypeItem).toContain('id="project-type-form-trigger" aria-controls="project-type-form-options"');
  expect(projectTypeItem).toContain('name="projectType"');
  expect(projectTypeItem).toContain('role="radiogroup" aria-label="Project type options"');
  expect(tagsItem).toContain('data-cc-dropdown data-cc-dropdown-mode="multiple"');
  expect(tagsItem).toContain('<span class="help-text">Add new tags in <a href="/settings/tags">Settings › Tags</a>.</span>');
  expect(statusChildren.indexOf(statusItem)).toBeLessThan(statusChildren.indexOf(tagsItem));
  expect(statusChildren.indexOf(statusItem)).toBeLessThan(statusChildren.indexOf(projectTypeItem));
  expect(statusChildren.indexOf(projectTypeItem)).toBeLessThan(statusChildren.indexOf(tagsItem));
  expect(html).not.toContain('>Scheduling</h3>');
  expect(html).not.toMatch(/\b(?:id|name)="(?:plannedDate|publishedDate)"/);

  expect(statusItem.includes('id="status-error"')).toBe(statusError);
  expect(tagsItem.includes('id="tagIds-error"')).toBe(tagError);
}

function expectProjectFormStatusDisclosure(html, selectedStatus) {
  const field = extractProjectFormStatusField(html);
  expect(field).not.toBe('');
  expect(field).toContain('asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown');
  expect(field).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
  expect(field).not.toContain('data-asset-viewer-filter-disclosure');
  expect(field).not.toContain('data-asset-viewer-filter-single-select');
  expect(field).not.toContain('data-asset-viewer-filter-multi-select');
  expect(field).toContain('id="project-status-form-trigger" aria-controls="project-status-form-options"');
  expect(field).toContain('data-cc-dropdown-summary class="asset-filter-multiselect-summary"');
  expect(field).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
  expect(field).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Status options"');
  expect(field).not.toContain('<select');

  const radios = field.match(/<input[^>]*name="status"[^>]*type="radio"[^>]*>/g) || [];
  expect(radios).toHaveLength(5);
  expect(radios.every((radio) => /\brequired\b/.test(radio))).toBe(true);

  const checked = field.match(/<input[^>]*name="status"[^>]*checked[^>]*>/g) || [];
  expect(checked).toHaveLength(selectedStatus ? 1 : 0);

  if (selectedStatus) {
    const label = selectedStatus.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
    expect(field).toMatch(new RegExp(`name="status"[^>]*value="${selectedStatus}"[^>]*checked`));
    expect(field).toContain(`data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">${label}</span>`);
    expect(field).toContain(`aria-label="Status: ${label}"`);
  }

  return field;
}

function expectProjectFormSectionCards(html) {
  const cards = html.match(/<(?:div|section) class="[^"]*\bsettings-section\b[^"]*">\s*<h3(?:\s+[^>]*)?>[^<]+<\/h3>/g) || [];
  expect(cards).toHaveLength(3);
  expect(html).toMatch(/<section class="settings-section project-form-section">\s*<h3>Basic information<\/h3>/);
  expect(html).toMatch(/<section class="settings-section status-section project-form-section">\s*<h3>Status<\/h3>/);
  expect(html).toMatch(/<section class="settings-section project-form-section">\s*<h3>Links<\/h3>/);
  expect(html).not.toContain('>Scheduling</h3>');
  expect(html).not.toMatch(/\b(?:id|name)="(?:plannedDate|publishedDate)"/);
  const basic = extractProjectSettingsSection(html, 'Basic information');
  expect(basic).toMatch(/<textarea id="description"[^>]*rows="6"/);
  expect(basic).toMatch(/<textarea id="notes"[^>]*rows="4"/);
  expect(html).not.toContain('class="form-section"');
}

function extractProjectFilter(html) {
  return html.match(/<fieldset class="[^"]*asset-viewer-project-filter[^"]*">\s*<legend>Project<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function extractReleaseList(html) {
  return html.match(/<ul class="release-list">([\s\S]*?)<\/ul>/)?.[1] || '';
}

function extractReleaseItem(releaseList, releaseId) {
  return releaseList.match(/<li>[\s\S]*?<\/li>/g)?.find((item) => (
    item.includes(`href="/releases/${releaseId}"`)
  )) || '';
}

async function capturePreparedSql(db, execute) {
  const originalPrepare = db.prepare;
  const statements = [];
  db.prepare = function prepare(sql, ...args) {
    statements.push(String(sql));
    return originalPrepare.call(this, sql, ...args);
  };
  try {
    await execute();
  } finally {
    db.prepare = originalPrepare;
  }
  return statements;
}

function projectListBaseSql(statements) {
  return statements.filter((sql) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return normalized.startsWith('SELECT COUNT(*) AS c FROM projects')
      || normalized.startsWith('SELECT id, title, slug, description, notes, status, project_type, patreon_url, created_at, updated_at, archived_at, project_dir FROM projects');
  });
}

describe('project HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let previewRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject({ title, status = 'tbd', projectType, plannedDate, publishedDate }) {
    const fields = new URLSearchParams({
      title,
      status,
      _csrf: csrfToken,
    });
    if (projectType) fields.set('projectType', projectType);
    if (plannedDate) fields.set('plannedDate', plannedDate);
    if (publishedDate) fields.set('publishedDate', publishedDate);

    const res = await agent
      .post('/projects')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(fields.toString())
      .expect(302);
    return Number(res.headers.location.replace('/projects/', ''));
  }

  function saveProjectDefault(option, value) {
    return app.locals.pageDefaultsService.saveDefault('projects', option, value);
  }

  function writeStoredProjectDefault(option, value) {
    const key = PAGE_DEFAULT_DEFINITIONS.projects[option].key;
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  function saveNewProjectDefault(option, value) {
    return app.locals.pageDefaultsService.saveDefault('new_project', option, value);
  }

  function writeStoredNewProjectDefault(option, value) {
    const key = PAGE_DEFAULT_DEFINITIONS.new_project[option].key;
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  function writeLegacyNewProjectPriority(value) {
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(LEGACY_NEW_PROJECT_PRIORITY_KEY, value);
  }

  function seedPrimaryImage(projectId, filename = 'cover.png') {
    const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(projectId);
    const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    fs.writeFileSync(path.join(projectDir, filename), 'content');
    app.locals.assetScanner.scanProjectAssets(projectId);
    const asset = app.locals.assetScanner.repository.findByProjectId(projectId)[0];
    app.locals.projectPrimaryImageService.setPrimaryImage(projectId, asset.id);
    return asset;
  }

  async function seedMergedKra(projectId) {
    const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(projectId);
    const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    fs.writeFileSync(path.join(projectDir, 'cover.kra'), makeZip([
      { name: 'mergedimage.png', data: Buffer.from('merged-preview') },
    ]));
    app.locals.assetScanner.scanProjectAssets(projectId);
    const asset = app.locals.assetScanner.repository.findByProjectId(projectId)[0];
    await app.locals.projectPrimaryImageService.setPrimaryImage(projectId, asset.id);
    return asset;
  }

  it('dashboard renders the four summary concepts and a new project action', async () => {
    const res = await agent.get('/').expect(200);
    expect(res.text).toContain('CreatorCrate');
    expect(res.text).toContain('New Project');
    expect(res.text).toContain('<span class="summary-card-label">Projects</span>');
    expect(res.text).toContain('<span class="summary-card-label">Assets</span>');
    expect(res.text).toContain('<span class="summary-card-label">Missing assets</span>');
    expect(res.text).toContain('<span class="summary-card-label">Releases</span>');
    expect(res.text).not.toContain('TBD');
    expect(res.text).not.toContain('View All Projects');
    expect(res.text).not.toContain('View All Releases');
  });

  it('renders the Projects listing with the expected project card only', async () => {
    const expectedId = await createProject({ title: 'Expected listing project' });
    await createProject({ title: 'Other listing project' });

    const res = await agent.get('/projects').expect(200);
    const expectedCard = extractProjectCard(res.text, expectedId);

    expect(expectedCard).toContain(`href="/projects/${expectedId}"`);
    expect(expectedCard).toContain('Expected listing project');
    expect(expectedCard).not.toContain('Other listing project');
  });

  it('renders Projects Filter and Defaults with Reset inside Filter', async () => {
    const projectTag = app.locals.tagService.createTag({ name: 'Projects Defaults Tag' });
    const response = await agent.get('/projects').expect(200);
    const filterActions = response.text.match(/<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?<\/div>/)?.[0] || '';
    const filterLink = filterActions.match(/<a class="[^"]*\bproject-filter-control\b[^"]*"[\s\S]*?data-dialog-open="projects-filter-dialog"[\s\S]*?<\/a>/)?.[0];
    const defaultsLink = filterActions.match(/<a class="[^"]*\basset-viewer-defaults-link\b[^"]*"[\s\S]*?<\/a>/)?.[0];

    expect(filterLink).toBeDefined();
    expect(defaultsLink).toBeDefined();
    expect(filterActions.indexOf('data-dialog-open="projects-filter-dialog"')).toBeLessThan(filterActions.indexOf('asset-viewer-defaults-link'));
    expect(defaultsLink).toContain('class="asset-viewer-defaults-link button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left"');
    expect(defaultsLink).toContain('href="/projects?defaults=1"');
    expect(defaultsLink).toContain('data-dialog-open="projects-defaults-dialog"');
    expect(defaultsLink).not.toContain('/settings/defaults#defaults-projects');
    expect(defaultsLink).toContain('aria-label="Projects defaults"');
    expect(defaultsLink).toContain('data-tooltip="Projects defaults"');
    expect(defaultsLink).not.toContain('title=');
    expect(defaultsLink).toContain('<svg');
    expect(filterActions).not.toContain('aria-label="Reset filters"');
    expect(filterActions).not.toContain('data-projects-reset');
    expect(filterActions).not.toContain('title=');

    expect((response.text.match(/<form id="project-filters"/g) || [])).toHaveLength(1);
    const filterDialog = response.text.match(/<dialog id="projects-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(filterDialog).toContain('<div class="page-defaults-grid">');
    expect(filterDialog).toContain('projects-filter-field--project');
    expect((filterDialog.match(/class="field asset-filter-multiselect-field[^\"]*app-dialog-field/g) || [])).toHaveLength(6);
    expect(filterDialog).not.toMatch(/<button[^>]*>\s*(?:Save|Cancel)/);
    expect(filterDialog).toContain('<form class="projects-filter-reset" method="get" action="/projects">');
    expect(filterDialog).toContain('<button class="button" type="submit" data-projects-reset>Reset filters</button>');
    expect((response.text.match(/>Reset filters<\/button>/g) || [])).toHaveLength(1);
    expect(filterDialog.match(/data-dialog-close/g)).toHaveLength(1);
    expect(filterDialog).toContain('aria-label="Close Filter"');
    const liveRegionStart = response.text.indexOf('<div data-projects-live-region>');
    const liveRegion = liveRegionStart >= 0 ? extractHtmlElement(response.text, liveRegionStart) : '';
    expect(liveRegion).not.toContain('id="project-filters"');
    expect(liveRegion).not.toContain('data-projects-reset');
    expect(response.text.indexOf('<form id="project-filters"')).toBeGreaterThan(liveRegionStart + liveRegion.length - 1);

    expect((response.text.match(/<dialog id="projects-defaults-dialog"/g) || [])).toHaveLength(1);
    expect(response.text).toContain('<form id="projects-defaults-form" method="post" action="/projects/defaults"');
    expect(response.text).toContain('name="_csrf"');

    const defaultsDialog = response.text.match(/<dialog id="projects-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(defaultsDialog).toContain('Choose the default filters and view used when you open Projects.');
    expect(defaultsDialog).not.toContain('Choose the presentation used when Projects opens without explicit view options.');
    expect(defaultsDialog).not.toMatch(/<button[^>]*>\s*Cancel\s*<\/button>/);
    expect(defaultsDialog.match(/data-dialog-close/g)).toHaveLength(1);
    expect(defaultsDialog).toContain('aria-label="Close Projects defaults"');
    expect(defaultsDialog).toContain('data-dialog-async="false" data-projects-defaults-autosave');
    expect(defaultsDialog).not.toContain('data-dialog-submit');
    expect(defaultsDialog).not.toContain('Save defaults');
    expect(defaultsDialog).not.toContain('<footer class="app-dialog-footer">');
    const defaultsGridStart = defaultsDialog.indexOf('<div class="page-defaults-grid">');
    const defaultsGrid = defaultsGridStart >= 0 ? extractHtmlElement(defaultsDialog, defaultsGridStart) : '';

    expect(defaultsGrid).toContain('<div class="page-defaults-grid">');
    expect((defaultsGrid.match(/class="field app-dialog-field/g) || [])).toHaveLength(6);
    expect((defaultsGrid.match(/data-cc-dropdown data-cc-dropdown-mode="single"/g) || [])).toHaveLength(6);
    expect(defaultsGrid).not.toContain('app-dialog-error');
    expect(defaultsGrid).not.toContain('app-dialog-status');
    expect(defaultsGrid).not.toContain('app-dialog-footer');
    expect(defaultsDialog.indexOf('app-dialog-error')).toBeLessThan(defaultsGridStart);
    expect(defaultsDialog.indexOf('app-dialog-status')).toBeGreaterThan(defaultsGridStart + defaultsGrid.length);
    expect(defaultsDialog).toContain('data-settings-fetch-save-status');
    expect(defaultsDialog).toContain('role="status" aria-live="polite" aria-atomic="true"');

    const css = await fetchProjectCss(app);
    expect(css).toMatch(/#projects-filter-dialog\s+\.projects-filter-reset,\s*#project-assets-filter-dialog\s+\.projects-filter-reset\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*center;[^}]*margin:\s*var\(--space-lg\);/);

    for (const field of [
      { name: 'view', label: 'View', id: 'projects-default-view', values: ['grid', 'list'], selected: 'grid', summary: 'Grid' },
      {
        name: 'sort',
        label: 'Sort',
        id: 'projects-default-sort',
        values: ['updated', 'created', 'title'],
        selected: 'created',
        summary: 'Recently created',
      },
      { name: 'order', label: 'Order', id: 'projects-default-order', values: ['asc', 'desc'], selected: 'desc', summary: 'Descending' },
      {
        name: 'status',
        label: 'Status',
        id: 'projects-default-status',
        values: ['all', 'tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived'],
        selected: 'all',
        summary: 'All active',
      },
      {
        name: 'projectType',
        label: 'Project Type',
        id: 'projects-default-projectType',
        values: ['all', 'images', 'comic', 'animation', 'wallpaper'],
        selected: 'all',
        summary: 'All types',
      },
      {
        name: 'tag',
        label: 'Tag',
        id: 'projects-default-tag',
        values: ['all', String(projectTag.id)],
        selected: 'all',
        summary: 'All tags',
      },
    ]) {
      expect(defaultsGrid).toContain(`data-dialog-field="${field.name}"`);
      expect(defaultsGrid).toContain(`<legend>${field.label}</legend>`);
      const nativeSelect = defaultsGrid.match(new RegExp(`<select id="${field.id}"[\\s\\S]*?<\\/select>`))?.[0] || '';
      expect(nativeSelect).not.toBe('');
      for (const value of field.values) expect(nativeSelect).toContain(`value="${value}"`);
      expect(nativeSelect).toMatch(new RegExp(`value="${field.selected}" selected`));
      expect(defaultsDialog).toMatch(new RegExp(
        `<select id="${field.id}" name="${field.name}"[^>]*data-cc-dropdown-native-select`,
      ));
      expect(defaultsDialog).toMatch(new RegExp(
        `<select[^>]*id="${field.id}"[^>]*required[^>]*data-autosubmit="fetch"`,
      ));
      expect(defaultsDialog).toMatch(new RegExp(
        `id="${field.id}-dropdown"[^>]*data-cc-dropdown data-cc-dropdown-mode="single"[^>]*data-cc-dropdown-dispatch-native-change`,
      ));
      expect(defaultsDialog).toContain(`class="asset-filter-multiselect-summary-current">${field.summary}</span>`);
      expect(defaultsDialog).toMatch(new RegExp(
        `<input[^>]*type="radio" value="${field.selected}"[^>]*checked`,
      ));
      expect(defaultsDialog).not.toMatch(new RegExp(`<input[^>]*name="${field.name}"`));
      expect((defaultsDialog.match(new RegExp(`name="${field.name}"`, 'g')) || [])).toHaveLength(1);
    }
    const tagDefaultsSelect = defaultsGrid.match(/<select id="projects-default-tag"[\s\S]*?<\/select>/)?.[0] || '';
    expect(tagDefaultsSelect).toContain(`<option value="${projectTag.id}">Projects Defaults Tag</option>`);
    expect(tagDefaultsSelect).not.toContain(`>${projectTag.id}</option>`);
    expect(defaultsDialog).not.toContain('field-error');
    expect(defaultsDialog).not.toMatch(/<select[^>]*aria-describedby/);
    expect(defaultsDialog).not.toContain('aria-invalid');
    expect(defaultsDialog).not.toContain('data-dialog-submitted-value');
    expect(defaultsDialog.indexOf('data-dialog-field="view"')).toBeLessThan(defaultsDialog.indexOf('data-dialog-field="sort"'));
    expect(defaultsDialog.indexOf('data-dialog-field="sort"')).toBeLessThan(defaultsDialog.indexOf('data-dialog-field="order"'));
    expect(defaultsDialog.indexOf('data-dialog-field="order"')).toBeLessThan(defaultsDialog.indexOf('data-dialog-field="status"'));
    expect(defaultsDialog.indexOf('data-dialog-field="status"')).toBeLessThan(defaultsDialog.indexOf('data-dialog-field="projectType"'));
    expect(defaultsDialog.indexOf('data-dialog-field="projectType"')).toBeLessThan(defaultsDialog.indexOf('data-dialog-field="tag"'));
  });

  it('renders the persisted enabled NSFW state in the Projects control', async () => {
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const response = await agent.get('/projects').expect(200);
    const nsfwForm = response.text.match(/<form method="post" action="\/projects\/nsfw-filter"[\s\S]*?<\/form>/)?.[0] || '';

    expect(nsfwForm).toContain('name="enabled" value="0"');
    expect(nsfwForm).toContain('aria-pressed="true"');
    expect(nsfwForm).toContain('aria-label="Disable NSFW filter"');
  });

  it('protects the Projects NSFW mutation and returns its enhanced contracts', async () => {
    await agent
      .post('/projects/nsfw-filter')
      .set('Accept', 'application/json')
      .type('form')
      .send({ enabled: '1' })
      .expect(403);

    const invalid = await agent
      .post('/projects/nsfw-filter')
      .set('Accept', 'application/json')
      .type('form')
      .send({ enabled: 'invalid', _csrf: csrfToken })
      .expect(422);
    expect(invalid.body).toEqual({
      status: 'error',
      errors: { enabled: 'Enabled value must be 0, 1, on, off, true, or false.' },
      message: 'NSFW filter setting is invalid.',
    });

    const enabled = await agent
      .post('/projects/nsfw-filter')
      .set('Accept', 'application/json')
      .type('form')
      .send({ enabled: '1', _csrf: csrfToken })
      .expect(200);

    expect(enabled.body).toEqual({
      status: 'success',
      enabled: true,
      message: 'NSFW filter enabled.',
    });
    expect((await agent.get('/projects')).text).toContain('aria-pressed="true"');
  });

  it('preserves a valid Projects NSFW return URL query', async () => {
    const returnTo = '/projects?search=needle&status=ready&tag=2&tag=3&view=list&page=2';
    const response = await agent
      .post('/projects/nsfw-filter')
      .type('form')
      .send({ enabled: '1', returnTo, _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe(returnTo);
    expect(app.locals.nsfwFilterSettingsService.isEnabled()).toBe(true);
  });

  it('falls back to /projects for an unsafe NSFW return URL', async () => {
    const response = await agent
      .post('/projects/nsfw-filter')
      .type('form')
      .send({ enabled: '1', returnTo: 'https://example.com', _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe('/projects');
  });

  it('loads persisted Projects defaults in the dialog rather than active query values', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const response = await agent.get('/projects?view=grid&sort=updated&order=desc&defaults=1').expect(200);
    const dialog = response.text.match(/<dialog id="projects-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    expect(dialog).toContain('<form id="projects-defaults-form" method="post" action="/projects/defaults"');
    expect(dialog).toContain('name="_csrf"');
    expect(dialog).toContain('data-projects-defaults-autosave');
    expect(dialog).toMatch(/name="view"[^>]*>[\s\S]*?value="list" selected/);
    expect(dialog).toMatch(/name="sort"[^>]*>[\s\S]*?value="title" selected/);
    expect(dialog).toMatch(/name="order"[^>]*>[\s\S]*?value="asc" selected/);
    expect(dialog).toMatch(/name="status"[^>]*>[\s\S]*?value="all" selected/);
    expect(dialog).toMatch(/name="projectType"[^>]*>[\s\S]*?value="all" selected/);
    expect(dialog).toMatch(/name="tag"[^>]*>[\s\S]*?value="all" selected/);
  });

  it('persists valid Projects defaults through the enhanced JSON contract', async () => {
    const response = await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({
        view: 'list',
        sort: 'updated',
        order: 'asc',
        status: 'archived',
        projectType: 'comic',
        tag: 'all',
        _csrf: csrfToken,
      })
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.values).toMatchObject({
      view: 'list',
      sort: 'updated',
      order: 'asc',
      status: 'archived',
      projectType: 'comic',
      tag: 'all',
    });
  });

  it('rejects unsupported Projects defaults through the enhanced JSON contract', async () => {
    const response = await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({
        view: 'list',
        sort: 'not-valid',
        order: 'asc',
        status: 'all',
        projectType: 'all',
        tag: 'all',
        _csrf: csrfToken,
      })
      .expect(422);

    expect(response.body.errors.sort).toContain('not-valid');
    expect(response.body.status).toBe('error');
  });

  it('keeps the normal Projects defaults POST fallback and rejects missing CSRF', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Redirect Projects Default Tag' });
    const fallback = await agent
      .post('/projects/defaults')
      .type('form')
      .send({
        view: 'list',
        sort: 'title',
        order: 'asc',
        status: 'ready',
        projectType: 'comic',
        tag: String(tag.id),
        _csrf: csrfToken,
      })
      .expect(302);
    expect(fallback.headers.location).toBe(
      `/projects?status=ready&type=comic&tag=${tag.id}&sort=title&order=asc&view=list&notice=projects_defaults_saved`,
    );

    await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({
        view: 'grid',
        sort: 'created',
        order: 'desc',
        status: 'all',
        projectType: 'all',
        tag: 'all',
      })
      .expect(403);

    await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({
        view: 'grid',
        sort: 'created',
        order: 'desc',
        status: 'all',
        projectType: 'all',
        tag: 'all',
        _csrf: 'invalid-token',
      })
      .expect(403);
  });

  it('renders status and tag standard multiselects with checked values', async () => {
    const firstTag = app.locals.tagService.createTag({ name: 'First Project Filter Tag' });
    const secondTag = app.locals.tagService.createTag({ name: 'Second Project Filter Tag' });

    const res = await agent
      .get(`/projects?status=planned&status=ready&tag=${secondTag.id}&tag=${firstTag.id}`)
      .expect(200);

    expect(res.text).toContain('<form id="project-filters" class="app-dialog-form project-form" method="get" action="/projects">');
    const filterActions = res.text.match(/<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?<\/div>/)?.[0] || '';
    expect(filterActions).not.toContain('<button class="button" type="submit" form="project-filters">Filter</button>');
    expect(res.text).toContain('<noscript><button class="button" type="submit" form="project-filters">Filter</button></noscript>');
    expect(res.text).not.toContain('id="project-search"');
    expect(res.text).not.toContain('data-projects-search');
    expect(res.text.indexOf('<div data-projects-live-region>')).toBeLessThan(res.text.indexOf('<form id="project-filters"'));
    expect(filterActions).not.toContain('data-projects-reset');
    const filterDialog = res.text.match(/<dialog id="projects-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(filterDialog).toContain('<form class="projects-filter-reset" method="get" action="/projects">');
    expect(filterDialog).toContain('<button class="button" type="submit" data-projects-reset>Reset filters</button>');
    expect((res.text.match(/data-asset-viewer-filter-disclosure/g) || [])).toHaveLength(0);

    const statusFilter = extractStatusFilter(res.text);
    const projectTypeFilter = extractProjectTypeFilter(res.text);
    const tagFilter = extractTagFilter(res.text);
    for (const [filter, inputName, mode] of [[statusFilter, 'status', 'multiple'], [projectTypeFilter, 'type', 'multiple'], [tagFilter, 'tag', 'multiple']]) {
      expect(filter).toContain(`data-cc-dropdown data-cc-dropdown-mode="${mode}"`);
      expect(filter).not.toContain('data-asset-viewer-filter-disclosure');
      expect(filter).not.toContain('data-asset-viewer-filter-single-select');
      expect(filter).not.toContain('data-asset-viewer-filter-multi-select');
      expect(filter).toContain('asset-filter-multiselect--sized');
      expect(filter).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current"');
      expect(filter).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
      expect(filter).toMatch(new RegExp(`<label for="[^"]+">\\s*<input[^>]+name="${inputName}"`));
    }
    expect(statusFilter).toContain('aria-label="Status filter: 2 statuses selected"');
    expect(statusFilter).toMatch(/name="status"[^>]+value="planned" checked/);
    expect(statusFilter).toMatch(/name="status"[^>]+value="ready" checked/);
    expect((statusFilter.match(/name="status"/g) || [])).toHaveLength(6);
    expect(projectTypeFilter).toContain('aria-label="Project Type filter: All types"');
    for (const [value, label] of [['images', 'Images'], ['comic', 'Comic'], ['animation', 'Animation'], ['wallpaper', 'Wallpaper']]) {
      expect(projectTypeFilter).toMatch(new RegExp(`name="type"[^>]+value="${value}"`));
      expect(projectTypeFilter).toContain(`<span>${label}</span>`);
    }
    expect(tagFilter).toContain('aria-label="Tag filter: 2 tags selected"');
    expect(tagFilter).toMatch(new RegExp(`name="tag"[^>]+value="${firstTag.id}" checked`));
    expect(tagFilter).toMatch(new RegExp(`name="tag"[^>]+value="${secondTag.id}" checked`));
    expect((tagFilter.match(/name="tag"/g) || [])).toHaveLength(2);
    expect(statusFilter).not.toMatch(/<select[^>]+(?:id="status"|name="status")/);
    expect(tagFilter).not.toMatch(/<select[^>]+(?:id="tag"|name="tag")/);

    const projectFilter = extractProjectFilter(res.text);
    expect(projectFilter).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(projectFilter).toContain('data-cc-dropdown-searchable');
    expect(projectFilter).toContain('data-cc-dropdown-type="searchable-single"');
    expect(projectFilter).not.toContain('data-asset-project-filter');
    expect(projectFilter).not.toContain('data-asset-viewer-filter-disclosure');
    expect(projectFilter).toContain('asset-viewer-project-filter');
    expect(projectFilter).toContain('asset-filter-multiselect--sized');
    expect(projectFilter).toContain('asset-project-filter-panel');
    expect(projectFilter).toContain('id="project-project-filter-trigger" aria-controls="project-project-filter-options"');
    expect(projectFilter).toContain('<label class="asset-project-filter-search-label" for="project-project-filter-search">Search projects</label>');
    expect(projectFilter).toContain('id="project-project-filter-search"');
    expect(projectFilter).toMatch(/<input id="project-project-filter-search" class="asset-project-filter-search" type="search"[^>]*data-cc-dropdown-search/);
    expect(projectFilter).toContain('data-cc-dropdown-search');
    expect(projectFilter).not.toMatch(/id="project-project-filter-search"[^>]*\bname=/);
    expect(projectFilter).toContain('id="project-project-filter-option-list" class="asset-project-filter-option-list" data-cc-dropdown-option-list');
    expect(projectFilter).toContain('data-cc-dropdown-no-results');
    expect(projectFilter).toContain('aria-label="Project filter: All projects"');
    expect(projectFilter).toContain('name="project"');
    expect(projectFilter).toMatch(/name="project"[^>]*value=""[^>]*checked/);
    expect(projectFilter).not.toMatch(/name="project"[^>]+value="[0-9]+"[^>]*checked/);
  });

  it('renders Sort and Sort order as separate standard single-select radio dropdowns', async () => {
    const res = await agent.get('/projects?sort=title&order=asc').expect(200);
    const sortFilter = extractSortFilter(res.text);
    const orderFilter = extractOrderFilter(res.text);

    expectProjectSortOrderSelection(res.text, 'title', 'asc');
    expect(sortFilter).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(sortFilter).not.toContain('data-asset-viewer-filter-disclosure');
    expect(sortFilter).not.toContain('data-asset-viewer-filter-single-select');
    expect(sortFilter).toContain('aria-controls="project-sort-filter-options"');
    expect(sortFilter).toContain('aria-label="Sort filter: Title"');
    expect(sortFilter).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current"');
    expect(sortFilter).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
    expect(sortFilter).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Sort options"');

    const sortRadios = sortFilter.match(/<input[^>]*name="sort"[^>]*type="radio"[^>]*>/g) || [];
    expect(sortRadios).toHaveLength(3);
    for (const value of ['updated', 'created', 'title']) {
      expect(sortFilter).toMatch(new RegExp(`name="sort"[^>]*value="${value}"`));
    }

    const css = (await agent.get('/creatorcrate.css').expect(200)).text;
    expect(css).toMatch(/#projects-defaults-form\s*>\s*\.projects-defaults-save-status:empty\s*\{[^}]*display:\s*none;/);
    expect(css).toMatch(/#projects-defaults-form\s*>\s*\.app-dialog-body\s*\{[^}]*margin-bottom:\s*var\(--space-lg\);/);
    expect(sortFilter).not.toMatch(/name="sort"[^>]*value="(?:published|planned)"/);
    expect((sortFilter.match(/name="sort"/g) || [])).toHaveLength(3);
    expect(sortFilter).not.toContain('<select');

    expect(orderFilter).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(orderFilter).not.toContain('data-asset-viewer-filter-disclosure');
    expect(orderFilter).not.toContain('data-asset-viewer-filter-single-select');
    expect(orderFilter).toContain('aria-controls="project-order-filter-options"');
    expect(orderFilter).toContain('aria-label="Sort order filter: Asc"');
    expect(orderFilter).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current"');
    expect(orderFilter).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
    expect(orderFilter).toContain('class="asset-filter-multiselect-panel" role="radiogroup" aria-label="Sort order options"');
    expect(orderFilter).toContain('<span>Desc</span>');
    expect(orderFilter).toContain('<span>Asc</span>');

    const orderRadios = orderFilter.match(/<input[^>]*name="order"[^>]*type="radio"[^>]*>/g) || [];
    expect(orderRadios).toHaveLength(2);
    expect(orderFilter).toMatch(/name="order"[^>]*value="desc"/);
    expect(orderFilter).toMatch(/name="order"[^>]*value="asc"/);
    expect((orderFilter.match(/name="order"/g) || [])).toHaveLength(2);
    expect(orderFilter).not.toContain('<select');
    const liveRegion = res.text.match(/<div data-projects-live-region>[\s\S]*?<\/div>\s*<noscript>/)?.[0] || '';
    expect(liveRegion).not.toMatch(/<select[^>]+(?:id="sort"|id="order"|name="sort"|name="order")/);
  });

  it.each([false, true])('Projects Reset restores current defaults (changed after rendering: %s)', async (changeDefaults) => {
    const originalTag = app.locals.tagService.createTag({ name: 'Original Reset Default' });
    const currentTag = app.locals.tagService.createTag({ name: 'Current Reset Default' });
    await createProject({ title: 'Reset Existing Project', status: 'planned' });
    saveProjectDefault('status', 'ready');
    saveProjectDefault('projectType', 'comic');
    writeStoredProjectDefault('tag', String(originalTag.id));
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const selected = await agent
      .get('/projects?search=no-match&status=planned&type=wallpaper&view=grid&sort=created&order=desc&page=2')
      .expect(200);
    const filterDialog = selected.text.match(/<dialog id="projects-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    const resetControls = [...selected.text.matchAll(/<(?:a|button)\b[^>]*data-projects-reset[^>]*>[\s\S]*?<\/(?:a|button)>/g)];
    expect(resetControls).toHaveLength(1);
    expect(filterDialog).toContain(resetControls[0][0]);
    expect(resetControls[0][0]).toContain('>Reset filters</button>');
    expect(filterDialog).toContain('<form class="projects-filter-reset" method="get" action="/projects">');
    expect(selected.text).toContain('<h2 class="empty-state-heading">No projects found</h2>');
    expect(selected.text).toContain('<p>No projects match the current filters.</p>');
    expect(selected.text).not.toContain('>Reset</a>');
    const resetPaths = ['/projects'];

    if (changeDefaults) {
      saveProjectDefault('status', 'planned');
      saveProjectDefault('projectType', 'wallpaper');
      writeStoredProjectDefault('tag', String(currentTag.id));
      saveProjectDefault('view', 'grid');
      saveProjectDefault('sort', 'updated');
      saveProjectDefault('order', 'desc');
    }
    const status = changeDefaults ? 'planned' : 'ready';
    const type = changeDefaults ? 'wallpaper' : 'comic';
    const tag = changeDefaults ? currentTag : originalTag;
    const sort = changeDefaults ? 'updated' : 'title';
    const order = changeDefaults ? 'desc' : 'asc';
    const canonical = `/projects?status=${status}&type=${type}&tag=${tag.id}&sort=${sort}`
      + (changeDefaults ? '' : '&order=asc&view=list');

    for (const resetPath of resetPaths) {
      const redirect = await agent.get(resetPath).expect(302);
      expect(redirect.headers.location).toBe(canonical);
      const restored = await agent.get(redirect.headers.location).expect(200);
      expect(restored.headers.location).toBeUndefined();
      expect(extractStatusFilter(restored.text)).toMatch(new RegExp(`name="status"[^>]+value="${status}" checked`));
      expect(extractProjectTypeFilter(restored.text)).toMatch(new RegExp(`name="type"[^>]+value="${type}" checked`));
      expect(extractTagFilter(restored.text)).toMatch(new RegExp(`name="tag"[^>]+value="${tag.id}" checked`));
      expectProjectSortOrderSelection(restored.text, sort, order);
      expect(extractProjectFilter(restored.text)).toContain('aria-label="Project filter: All projects"');
    }
  });

  it('explicit All selections remain neutral without reapplying saved filter defaults', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Reset Filter Tag' });
    const projectId = await createProject({ title: 'Reset Filter Project', status: 'planned' });
    saveProjectDefault('status', 'ready');
    saveProjectDefault('projectType', 'comic');
    writeStoredProjectDefault('tag', String(tag.id));
    const selected = await agent
      .get(`/projects?status=planned&status=ready&type=wallpaper&tag=${tag.id}&project=${projectId}`)
      .expect(200);

    const selectedFilterActions = selected.text.match(/<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?<\/div>/)?.[0] || '';
    const selectedFilterDialog = selected.text.match(/<dialog id="projects-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(selectedFilterActions).not.toContain('data-projects-reset');
    expect(selectedFilterDialog).toContain('<form class="projects-filter-reset" method="get" action="/projects">');
    expect(selectedFilterDialog).toContain('<button class="button" type="submit" data-projects-reset>Reset filters</button>');
    expect(selected.text).not.toContain('Reset Filters');
    expect(extractProjectFilter(selected.text)).toContain(`value="${projectId}" checked`);

    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');
    const clearedRedirect = await agent.get('/projects?status=all&type=all&tag=all').expect(302);
    expect(clearedRedirect.headers.location).toBe('/projects?status=all&type=all&tag=all&sort=title&order=asc&view=list');
    const cleared = await agent.get(clearedRedirect.headers.location).expect(200);
    expect(extractStatusFilter(cleared.text)).toContain('aria-label="Status filter: All active"');
    expect(extractStatusFilter(cleared.text)).not.toMatch(/name="status"[^>]+checked/);
    expect(extractProjectTypeFilter(cleared.text)).toContain('aria-label="Project Type filter: All types"');
    expect(extractProjectTypeFilter(cleared.text)).not.toMatch(/name="type"[^>]+checked/);
    expect(extractTagFilter(cleared.text)).toContain('aria-label="Tag filter: All tags"');
    expect(extractTagFilter(cleared.text)).not.toMatch(/name="tag"[^>]+checked/);
    expect(extractProjectFilter(cleared.text)).toContain('aria-label="Project filter: All projects"');
    expect(extractProjectFilter(cleared.text)).not.toMatch(/name="project"[^>]+value="[0-9]+"[^>]*checked/);
  });

  it('renders Asset Viewer-style display controls and grid-size hooks only in Projects Grid view', async () => {
    await createProject({ title: 'Grid Controls Project' });
    const grid = await agent.get('/projects?view=grid').expect(200);
    expect(grid.text).toMatch(
      /<div class="asset-viewer-display-controls" data-project-grid-size-controls>\s*<nav class="view-switcher" aria-label="Project display">[\s\S]*?<\/nav>\s*<div class="asset-grid-size-controls asset-viewer-grid-size-controls" data-asset-grid-size-controls/
    );
    expect(grid.text).toContain('<ul class="project-grid">');
    expect(grid.text).toContain('data-grid-size-slider');
    expect(grid.text).toContain('data-grid-size-option-label="compact"');

    const gridLink = grid.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[^>]*aria-label="Grid view"[^>]*>\s*<svg/);
    const listLink = grid.text.match(/<a class="[^"]*view-switcher-option[^"]*" href="([^"]+)"[^>]*aria-label="List view"[^>]*>\s*<svg/);
    expect(gridLink?.[1]).toBe('/projects');
    expect(listLink?.[1]).toBe('/projects?view=list');
    expect(grid.text).not.toContain('>Grid</a>');
    expect(grid.text).not.toContain('>List</a>');
    expect(grid.text).toContain('aria-label="Grid view"');
    expect(grid.text).toContain('aria-label="List view"');
    expect(grid.text).toContain('aria-current="page"');
    expect(grid.text).toContain('data-grid-size-labels-interactive');
    expect(grid.text).toMatch(/<button class="asset-grid-size-option-label" type="button" data-grid-size-option-label="compact"/);
    expect(grid.text).toMatch(/<button class="asset-grid-size-option-label is-active" type="button" data-grid-size-option-label="default"/);
    expect(grid.text).toMatch(/<button class="asset-grid-size-option-label" type="button" data-grid-size-option-label="large"/);

    const list = await agent.get('/projects?view=list').expect(200);
    expect(list.text).toMatch(
      /<div class="asset-viewer-display-controls">\s*<nav class="view-switcher" aria-label="Project display">[\s\S]*?<\/nav>/
    );
    expect(list.text).not.toContain('data-asset-grid-size-controls');
    expect(list.text).not.toContain('data-grid-size-slider');
    expect(list.text).not.toContain('>Grid</a>');
    expect(list.text).not.toContain('>List</a>');
    expect(list.text).toMatch(/<a class="[^"]*view-switcher-option[^"]*" href="[^"]+"[^>]*aria-current="page"[^>]*aria-label="List view"/);
    expect(list.text).not.toMatch(/<a class="[^"]*view-switcher-option[^"]*" href="[^"]+"[^>]*aria-current="page"[^>]*aria-label="Grid view"/);
  });

  it('redirects a bare request to valid saved Projects defaults', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Bare Projects Default Tag' });
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');
    saveProjectDefault('status', 'ready');
    saveProjectDefault('projectType', 'comic');
    writeStoredProjectDefault('tag', String(tag.id));

    const redirect = await agent.get('/projects').expect(302);
    expect(redirect.headers.location).toBe(
      `/projects?status=ready&type=comic&tag=${tag.id}&sort=title&order=asc&view=list`,
    );

    const rendered = await agent.get(redirect.headers.location).expect(200);
    expect(rendered.text).toContain('<input type="hidden" name="view" value="list">');
    expectProjectSortOrderSelection(rendered.text, 'title', 'asc');
    expect(extractStatusFilter(rendered.text)).toContain('aria-label="Status filter: Ready"');
    expect(extractProjectTypeFilter(rendered.text)).toContain('aria-label="Project Type filter: Comic"');
    expect(extractTagFilter(rendered.text)).toContain('aria-label="Tag filter: Bare Projects Default Tag"');
  });

  it('uses application fallbacks for invalid stored Projects defaults', async () => {
    writeStoredProjectDefault('sort', 'bogus');

    const res = await agent.get('/projects').expect(200);
    expectProjectSortOrderSelection(res.text, 'created', 'desc');
    expect(res.headers.location).toBeUndefined();
  });

  it.each(['published', 'planned'])(
    'uses the canonical Projects fallback for obsolete explicit %s sorting',
    async (obsoleteSort) => {
      saveProjectDefault('sort', 'title');

      const res = await agent.get(`/projects?sort=${obsoleteSort}`).expect(200);

      expectProjectSortOrderSelection(res.text, 'created', 'desc');
      expect(extractSortFilter(res.text)).not.toMatch(/value="(?:published|planned)"/);
      expect(res.text).not.toContain(`sort=${obsoleteSort}`);
    },
  );

  it('gives valid explicit values precedence while resolving omitted options from saved defaults', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const res = await agent.get('/projects?view=grid&sort=updated').expect(200);
    expect(res.text).not.toContain('<ul class="project-list">');
    expectProjectSortOrderSelection(res.text, 'updated', 'asc');
    expect(res.text).toContain('<input type="hidden" name="view" value="grid">');
    expect(res.text).toContain('href="/projects?sort=updated&amp;order=asc&amp;view=grid"');
  });

  it('keeps explicit Projects filter query precedence without injecting omitted saved defaults', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Explicit Projects Default Tag' });
    saveProjectDefault('status', 'ready');
    saveProjectDefault('projectType', 'comic');
    writeStoredProjectDefault('tag', String(tag.id));

    const explicitStatus = await agent.get('/projects?status=planned').expect(200);
    expect(extractStatusFilter(explicitStatus.text)).toContain('aria-label="Status filter: Planned"');
    expect(extractProjectTypeFilter(explicitStatus.text)).toContain('aria-label="Project Type filter: All types"');
    expect(extractTagFilter(explicitStatus.text)).toContain('aria-label="Tag filter: All tags"');

    const explicitType = await agent.get('/projects?type=wallpaper').expect(200);
    expect(extractStatusFilter(explicitType.text)).toContain('aria-label="Status filter: All active"');
    expect(extractProjectTypeFilter(explicitType.text)).toContain('aria-label="Project Type filter: Wallpaper"');
    expect(extractTagFilter(explicitType.text)).toContain('aria-label="Tag filter: All tags"');

    const explicitTag = await agent.get(`/projects?tag=${tag.id}`).expect(200);
    expect(extractStatusFilter(explicitTag.text)).toContain('aria-label="Status filter: All active"');
    expect(extractProjectTypeFilter(explicitTag.text)).toContain('aria-label="Project Type filter: All types"');
    expect(extractTagFilter(explicitTag.text)).toContain('aria-label="Tag filter: Explicit Projects Default Tag"');

    const explicitView = await agent.get('/projects?view=list').expect(200);
    expect(extractStatusFilter(explicitView.text)).toContain('aria-label="Status filter: All active"');
    expect(extractProjectTypeFilter(explicitView.text)).toContain('aria-label="Project Type filter: All types"');
    expect(extractTagFilter(explicitView.text)).toContain('aria-label="Tag filter: All tags"');
  });

  it('keeps invalid explicit presentation values on application fallbacks instead of saved values', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const res = await agent.get('/projects?view=invalid&sort=invalid&order=invalid').expect(200);
    expect(res.text).toContain('<input type="hidden" name="view" value="grid">');
    expectProjectSortOrderSelection(res.text, 'created', 'desc');
    expect(res.text).not.toContain('sort=invalid');
    expect(res.text).not.toContain('order=invalid');
    expect(res.text).not.toContain('view=invalid');
  });

  it('does not redirect when saved values equal the application fallbacks', async () => {
    saveProjectDefault('view', 'grid');
    saveProjectDefault('sort', 'created');
    saveProjectDefault('order', 'desc');

    const res = await agent.get('/projects').expect(200);
    expect(res.headers.location).toBeUndefined();
    expectProjectSortOrderSelection(res.text, 'created', 'desc');
  });

  it('renders one semantic project card per row with primary-image states and retained metadata', async () => {
    const availableId = await createProject({
      title: 'Available Primary Image',
      status: 'ready',
    });
    const noneId = await createProject({
      title: 'No Image Missing Dates',
      status: 'tbd',
    });
    const unavailableId = await createProject({
      title: 'Unavailable Primary Image',
      status: 'planned',
    });

    seedPrimaryImage(availableId);
    const unavailableAsset = seedPrimaryImage(unavailableId, 'unavailable.png');
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(unavailableAsset.id);

    const res = await agent.get('/projects').expect(200);
    const availableCard = extractProjectCard(res.text, availableId);
    const noneCard = extractProjectCard(res.text, noneId);
    const unavailableCard = extractProjectCard(res.text, unavailableId);
    const projectsTemplate = fs.readFileSync(PROJECTS_TEMPLATE_PATH, 'utf8');

    expect(res.text).toContain('<ul class="project-grid">');
    expect(res.text).not.toContain('<table class="data-table">');
    expect(extractProjectCards(res.text)).toHaveLength(3);
    expect(res.text.match(/<li class="project-grid-item">/g)).toHaveLength(3);
    expect(res.text.match(/<article class="project-card[^"]*" data-project-card>/g)).toHaveLength(3);
    expect(projectsTemplate).toContain('{{ projectCard.render(project, view) }}');
    expect(projectsTemplate).not.toContain('{% call projectCard.render(project, view) %}');
    expect(projectsTemplate).not.toContain('<dl class="project-card-metadata">');
    expect(projectsTemplate).not.toContain('project-card-meta--tags');
    expect(res.text).not.toContain('project-card-meta--tags');

    expect(availableCard).toContain(`data-project-card-link href="/projects/${availableId}"`);
    expect(availableCard).toMatch(
      /<img class="project-card-media-image" data-preview-image src="\/projects\/\d+\/assets\/\d+\/preview\?v=[0-9a-f]+" alt="Preview of cover\.png" loading="lazy" decoding="async">/
    );
    expect(availableCard).toContain('data-preview-enhancement');
    expect(availableCard).toContain('data-preview-fallback');
    expect(availableCard).toContain(`class="project-card project-card--grid project-grid-card" data-project-card`);
    expect(availableCard).toContain(`class="project-grid-card-preview-link" data-project-card-link href="/projects/${availableId}"`);
    expect(availableCard).not.toContain('project-list-card');
    expect(availableCard).not.toContain('/original');
    expect(availableCard).not.toContain('/thumbnail');
    expect(availableCard).not.toContain('project-grid-card-top');
    expect(availableCard).toMatch(
      /<div class="project-grid-card-status" aria-label="Project badges">\s*<span class="status-badge project-option-badge project-status-badge status-badge--active" style="--project-badge-bg: #34D399; --project-badge-tint: 18%; --project-badge-fg: #34D399">Ready<\/span>\s*<span class="status-badge project-option-badge project-type-badge" style="--project-badge-bg: #22D3EE; --project-badge-tint: 18%; --project-badge-fg: #22D3EE">Images<\/span>\s*<\/div>\s*<div class="project-grid-card-preview[\s\S]*?<a class="project-grid-card-preview-link"/
    );
    expect(availableCard).not.toContain('project-grid-card-priority');
    expect(availableCard).not.toMatch(/Priority:\s*High/);
    expect(availableCard).not.toMatch(/<dt>Priority<\/dt>/);
    expect(availableCard).toMatch(
      /<div class="project-grid-card-preview[\s\S]*?<div class="project-grid-card-info" data-project-info-card popover="manual" role="group" aria-label="Project information">[\s\S]*?<h3 class="project-grid-card-info-heading">Available Primary Image<\/h3>[\s\S]*?<dt>Status<\/dt>/
    );
    expect(availableCard).toContain('data-project-grid-preview');
    expect(availableCard).toContain('<dl class="project-grid-card-info-list">');
    expect(availableCard).toMatch(
      /<dt>Type<\/dt>\s*<dd>[\s\S]*?<span class="status-badge project-option-badge project-type-badge" style="--project-badge-bg: #22D3EE; --project-badge-tint: 18%; --project-badge-fg: #22D3EE">Images<\/span>[\s\S]*?<\/dd>/
    );
    expect((availableCard.match(/class="project-grid-card-info-row"/g) || [])).toHaveLength(5);
    expect(availableCard).toContain('<div class="project-grid-card-info-section">');
    expect(availableCard).toContain('<span class="project-grid-card-info-section-label">Tags</span>');
    expect(availableCard).toContain('class="project-grid-card-info-empty">No tags assigned</span>');
    expect(availableCard).not.toContain('project-grid-card-title-area');
    expect(availableCard).not.toContain('project-grid-card-title');

    expect(noneCard).toContain('data-primary-image-state="none"');
    expect(noneCard).toContain('No image');
    expect(noneCard).not.toContain('<img');

    expect(unavailableCard).toContain('data-primary-image-state="unavailable"');
    expect(unavailableCard).toContain('Image unavailable');
    expect(unavailableCard).not.toContain('<img');

    const availableRow = db.prepare('SELECT updated_at FROM projects WHERE id = ?').get(availableId);
    expect(availableCard).toMatch(/<dt>Status<\/dt>\s*<dd>[\s\S]*Ready[\s\S]*<\/dd>/);
    expect(availableCard).toContain('<dt>Total assets</dt>');
    expect(availableCard).toMatch(/<dt>Total assets<\/dt>\s*<dd>1<\/dd>/);
    expect(availableCard.indexOf('<dt>Created</dt>')).toBeLessThan(availableCard.indexOf('<dt>Updated</dt>'));
    expect(availableCard).toContain(availableRow.updated_at);
    expect(noneCard).toContain('class="project-grid-card-info-empty">No release records</span>');
    expect(availableCard).not.toMatch(/<dt>(?:Planned|Published)<\/dt>/);
    expect(noneCard).not.toMatch(/<dt>(?:Planned|Published)<\/dt>/);

    const list = await agent.get('/projects?view=list').expect(200);
    const availableListCard = extractProjectCard(list.text, availableId);
    const noneListCard = extractProjectCard(list.text, noneId);
    const unavailableListCard = extractProjectCard(list.text, unavailableId);
    expect(list.text).toContain('<ul class="project-list">');
    expect(list.text).not.toContain('<ul class="project-grid">');
    expect(availableListCard).toContain('class="project-card project-card--list project-list-card" data-project-card');
    expect(availableListCard).not.toContain('project-grid-card');
    expect(availableListCard).not.toContain('data-project-info-card');
    expect(availableListCard).not.toContain('data-project-grid-preview');
    expect(availableListCard).not.toContain('project-grid-card-info-list');
    expect(availableListCard).toContain('class="project-list-card-media project-card-media project-card-media--image"');
    expect(availableListCard).toContain(`class="project-list-card-media-link" href="/projects/${availableId}"`);
    expect(availableListCard).toMatch(
      /<img class="project-list-card-media-image project-card-media-image project-card-media-image--list" data-preview-image src="\/projects\/\d+\/assets\/\d+\/thumbnail\?v=[0-9a-f]+"/
    );
    expect(availableListCard).not.toContain('/preview');
    expect(availableListCard).not.toContain('/original');
    expect(availableListCard).toContain('class="project-list-card-header"');
    expect(availableListCard).toMatch(
      /<h2 class="project-list-card-title project-card-title">\s*<a class="project-list-card-link project-card-link"[^>]*>Available Primary Image<\/a>/
    );
    expect(availableListCard).toContain('class="project-list-card-status"');
    expect(availableListCard).toContain('>Ready</span>');
    expect(availableListCard).not.toContain('project-list-card-priority');
    expect(availableListCard).toContain('<dl class="project-list-card-metadata">');
    expect(availableListCard).not.toContain('project-card-meta--tags');
    expect(availableListCard).toContain('<dt>Status</dt>');
    expect(availableListCard).not.toMatch(/<dt>Priority<\/dt>/);
    expect(availableListCard).toContain('<dt>Updated</dt>');
    expect(availableListCard).not.toMatch(/<dt>(?:Planned|Published)<\/dt>/);
    expect(availableListCard).toContain('class="project-list-card-associations"');
    expect(availableListCard).toContain('class="project-list-card-association project-list-card-association--tags"');
    expect(noneListCard).not.toContain('<img');
    expect(noneListCard).toContain('class="project-list-card-media project-card-media project-card-media--fallback" data-primary-image-state="none"');
    expect(noneListCard).toContain('data-primary-image-state="none"');
    expect(noneListCard).toContain(`class="project-list-card-media-link project-list-card-media-link--fallback" href="/projects/${noneId}"`);
    expect(unavailableListCard).not.toContain('<img');
    expect(unavailableListCard).toContain('class="project-list-card-media project-card-media project-card-media--fallback" data-primary-image-state="unavailable"');
    expect(unavailableListCard).toContain('data-primary-image-state="unavailable"');
    expect(unavailableListCard).toContain(`class="project-list-card-media-link project-list-card-media-link--fallback" href="/projects/${unavailableId}"`);
    expect(noneListCard).not.toMatch(/<dt>(?:Planned|Published)<\/dt>/);
  });

  it('renders recent Release details and the publication-date fallback in grid Project information', async () => {
    const projectId = await createProject({ title: 'Release Popup Project', status: 'ready' });
    const insertRelease = db.prepare(`
      INSERT INTO releases (
        project_id, title, planned_date, planned_time, published_date, archived_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const publishedId = insertRelease.get(
      projectId,
      'Published Popup Release',
      '2026-10-01',
      '09:30',
      '2026-10-03',
      null,
      '2026-10-04 10:00:00',
    ).id;
    const plannedId = insertRelease.get(
      projectId,
      'Planned Popup Release',
      '2026-11-05',
      '14:45',
      null,
      null,
      '2026-10-04 09:00:00',
    ).id;
    const undatedId = insertRelease.get(
      projectId,
      'Undated Popup Release',
      null,
      null,
      null,
      null,
      '2026-10-04 08:00:00',
    ).id;
    const archivedId = insertRelease.get(
      projectId,
      'Archived Popup Release',
      '2026-12-01',
      null,
      null,
      '2026-10-04 07:00:00',
      '2026-10-04 07:00:00',
    ).id;

    const response = await agent.get('/projects').expect(200);
    const card = extractProjectCard(response.text, projectId);
    const published = extractProjectReleaseItem(card, publishedId);
    const planned = extractProjectReleaseItem(card, plannedId);
    const undated = extractProjectReleaseItem(card, undatedId);
    const archived = extractProjectReleaseItem(card, archivedId);

    expect(card).toContain('<span class="project-grid-card-info-section-label">Releases</span>');
    expect(published).toContain(`href="/releases/${publishedId}">Published Popup Release</a>`);
    expect(published).toContain('published 2026-10-03');
    expect(published).not.toContain('planned 2026-10-01');
    expect(published).toContain('updated 2026-10-04 10:00:00');
    expect(planned).toContain(`href="/releases/${plannedId}">Planned Popup Release</a>`);
    expect(planned).toContain('planned 2026-11-05 14:45');
    expect(planned).toContain('updated 2026-10-04 09:00:00');
    expect(undated).toContain(`href="/releases/${undatedId}">Undated Popup Release</a>`);
    expect(undated).toMatch(/>\s*—\s*· updated 2026-10-04 08:00:00/);
    expect(archived).toContain(`href="/releases/${archivedId}">Archived Popup Release</a>`);
    expect(archived).toContain('<span class="status-badge status-badge--archived">Archived</span>');
    expect(card).not.toContain('release-thumbnail');
    expect(card).not.toContain('social-preparation');
  });

  it('passes the NSFW setting to sensitive primary images on Projects list and detail surfaces', async () => {
    const nsfwTag = app.locals.tagService.createTag({ name: 'NSFW' });
    const nsfwProjectId = await createProject({ title: 'NSFW Project', status: 'ready' });
    const safeProjectId = await createProject({ title: 'Safe Project', status: 'ready' });
    seedPrimaryImage(nsfwProjectId);
    seedPrimaryImage(safeProjectId, 'safe.png');
    app.locals.projectTagService.replaceProjectTags(nsfwProjectId, [nsfwTag.id]);
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const grid = await agent.get('/projects').expect(200);
    const nsfwGridCard = extractProjectCard(grid.text, nsfwProjectId);
    const safeGridCard = extractProjectCard(grid.text, safeProjectId);
    expect(nsfwGridCard).toMatch(/<img(?=[^>]*class="[^"]*\bproject-image--nsfw-blurred\b)(?=[^>]*data-preview-image)[^>]*>/);
    expect(safeGridCard).not.toContain('project-image--nsfw-blurred');

    const list = await agent.get('/projects?view=list').expect(200);
    const nsfwListCard = extractProjectCard(list.text, nsfwProjectId);
    expect(nsfwListCard).toMatch(/<img(?=[^>]*class="[^"]*\bproject-image--nsfw-blurred\b)(?=[^>]*data-preview-image)[^>]*>/);

    const detail = await agent.get(`/projects/${nsfwProjectId}`).expect(200);
    const detailMedia = detail.text.match(/<div\b[^>]*class="[^"]*\bproject-detail-media\b[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
    const detailInfo = extractProjectDetailSection(detail.text, 'project-detail-info');
    expect(detailMedia).toMatch(/<img(?=[^>]*class="[^"]*\bproject-detail-media-image\b)(?=[^>]*class="[^"]*\bproject-image--nsfw-blurred\b)(?=[^>]*data-preview-image)[^>]*>/);
    expect(detailMedia).toContain('alt="Preview of cover.png"');
    expect(detailInfo).toMatch(/<section\b[^>]*class="[^"]*\bproject-detail-info\b[^"]*"/);
    expect(detailInfo).not.toContain('project-image--nsfw-blurred');

    app.locals.nsfwFilterSettingsService.setEnabled(false);

    const disabledDetail = await agent.get(`/projects/${nsfwProjectId}`).expect(200);
    const disabledDetailMedia = disabledDetail.text.match(/<div\b[^>]*class="[^"]*\bproject-detail-media\b[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
    expect(disabledDetailMedia).toMatch(/<img(?=[^>]*class="[^"]*\bproject-detail-media-image\b)(?=[^>]*data-preview-image)[^>]*>/);
    expect(disabledDetailMedia).not.toContain('project-image--nsfw-blurred');
  });

  it('recognizes a differently cased NSFW project tag for blur decisions', async () => {
    const equivalentTag = app.locals.tagService.createTag({ name: 'nSfW' });
    const projectId = await createProject({ title: 'Equivalent NSFW Project', status: 'ready' });
    seedPrimaryImage(projectId);
    app.locals.projectTagService.replaceProjectTags(projectId, [equivalentTag.id]);
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const grid = await agent.get('/projects').expect(200);
    expect(extractProjectCard(grid.text, projectId)).toMatch(
      /<img class="[^"]*project-image--nsfw-blurred[^"]*" data-preview-image/,
    );

  });

  it('serves scoped responsive project-card presentation contracts', async () => {
    const projectId = await createProject({ title: 'Responsive Badge Layout', status: 'ready' });
    const page = await agent.get('/projects').expect(200);
    const css = (await agent.get('/creatorcrate.css').expect(200)).text;
    const gridBadgeRow = extractProjectCard(page.text, projectId).match(/<div class="project-grid-card-status"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';

    expect(page.text).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
    expect(gridBadgeRow).toMatch(/project-status-badge[\s\S]*project-type-badge/);
    expect(css).toMatch(/\.project-grid\s*\{[\s\S]*?--project-card-min:\s*15rem;[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*var\(--project-card-min\)\),\s*1fr\)\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*540px\)[\s\S]*?\.project-grid\s*\{[\s\S]*?--project-card-min:\s*9rem;[\s\S]*?gap:\s*var\(--space-md\)/);
    expect(css).toMatch(/\.project-list\s*>\s*li:not\(\.project-list-item\)\s*\{[^}]*padding:\s*0\.75rem 0;[^}]*border-bottom:\s*1px solid var\(--border\);/);
    expect(css).not.toMatch(/\.project-list\s+li\s*\{[^}]*border-bottom:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*540px\)[\s\S]*?\.project-list\s*>\s*li:not\(\.project-list-item\)\s*\{[^}]*padding:\s*var\(--space-sm\) 0;/);
    expect(css).toMatch(/\.project-card-media-image\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/);
    expect(css).not.toMatch(/\.project-card[^{}]*\{[^}]*aspect-ratio\s*:/);
    expect(css).not.toMatch(/\.project-card[^{}]*\{[^}]*object-fit\s*:\s*cover/);
    expect(css).toMatch(/\.project-card-link\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.project-card \.project-card-link,\s*\.project-card \.project-card-link:visited\s*\{[^}]*color:\s*#fff;/);
    expect(css).not.toMatch(/\.project-card--archived \.project-card-link\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(css).toMatch(/\.project-card-meta dd\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/@media\s*\(max-width:\s*540px\)\s*\{[\s\S]*?\.project-card-meta\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.project-card:focus-within\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)[\s\S]*?transform:\s*scale\(1\.01\)/);
    const gridMediaRule = css.match(/\.project-card--grid \.project-card-media\s*\{[^}]*\}/)?.[0] || '';
    const gridPreviewRule = css.match(/\.project-grid-card-preview\s*\{[^}]*\}/)?.[0] || '';
    const gridStatusRule = css.match(/\.project-grid-card-status\s*\{[^}]*\}/)?.[0] || '';
    const gridTypeBadgeRule = css.match(/\.project-grid-card-status\s*>\s*\.project-type-badge\s*\{[^}]*\}/)?.[0] || '';
    const gridPreviewRadiiRule = css.match(/\.project-grid-card-preview-link,\s*\.project-grid-card-preview \.project-card-media-image,\s*\.project-grid-card-preview \.project-card-media-fallback\s*\{[^}]*\}/)?.[0] || '';
    const listCardRule = css.match(/\.project-list-card\s*\{[^}]*\}/)?.[0] || '';
    const listMediaRule = css.match(/\.project-list-card-media\s*\{[^}]*\}/)?.[0] || '';

    expect(gridMediaRule).toMatch(/margin:\s*var\(--space-sm\) 0 0;/);
    expect(gridMediaRule).toMatch(/border-bottom:\s*0;/);
    expect(gridMediaRule).toMatch(/border-radius:\s*var\(--radius-md\) var\(--radius-md\) var\(--radius-lg\) var\(--radius-lg\);/);
    expect(css).not.toMatch(/\.project-card--grid \.project-card-media\s*\{[^}]*margin:\s*var\(--space-sm\) var\(--space-sm\) 0;/);
    expect(css).toMatch(/\.project-grid-card\s*\{[\s\S]*?position:\s*relative;[\s\S]*?overflow:\s*visible/);
    expect(css).toMatch(/\.project-grid-card:hover,[\s\S]*?\.project-grid-card:focus-within\s*\{[\s\S]*?z-index:\s*60/);
    expect(css).not.toMatch(/\.project-grid-card-top\s*\{/);
    expect(gridStatusRule).toMatch(/display:\s*flex;/);
    expect(gridStatusRule).toMatch(/flex-wrap:\s*wrap;/);
    expect(gridStatusRule).toMatch(/justify-content:\s*space-between;/);
    expect(gridStatusRule).toMatch(/align-items:\s*flex-start;/);
    expect(gridStatusRule).toMatch(/padding:\s*var\(--space-sm\)\s+var\(--space-sm\)\s+0;/);
    expect(gridTypeBadgeRule).toMatch(/margin-inline-start:\s*auto;/);
    expect(css).not.toMatch(/\.project-grid-card-status\s*>\s*\.project-status-badge\s*\{[^}]*margin-inline-start:\s*auto;/);
    expect(css).not.toMatch(/\.project-list-card-status[^}]*margin-inline-start:\s*auto;/);
    expect(css).not.toMatch(/\.project-grid-card-status\s*\{[^}]*position:\s*absolute;/);
    expect(css).not.toMatch(/\.project-grid-card-priority\s*\{/);
    expect(css).not.toMatch(/\.project-list-card-priority\s*\{/);
    expect(css).not.toMatch(/\.project-detail-priority\s*\{/);
    expect(gridPreviewRule).toMatch(/position:\s*relative;/);
    expect(gridPreviewRule).toMatch(/overflow:\s*visible;/);
    expect(gridPreviewRule).not.toMatch(/overflow:\s*hidden;/);
    expect(css).toMatch(/\.project-grid-card-preview\s*\{[\s\S]*?--project-info-top:\s*0px;[\s\S]*?--project-info-left:\s*0px/);
    expect(gridPreviewRadiiRule).toMatch(/border-top-left-radius:\s*var\(--radius-md\);/);
    expect(gridPreviewRadiiRule).toMatch(/border-top-right-radius:\s*var\(--radius-md\);/);
    expect(gridPreviewRadiiRule).toMatch(/border-bottom-left-radius:\s*var\(--radius-lg\);/);
    expect(gridPreviewRadiiRule).toMatch(/border-bottom-right-radius:\s*var\(--radius-lg\);/);
    expect(css).toMatch(/\.project-grid-card-info\s*\{[\s\S]*?display:\s*none[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*auto/);
    expect(css).toMatch(/\.project-grid-card-info\s*\{[\s\S]*?width:\s*min\(24rem,\s*calc\(100vw\s*-\s*2rem\)\)[\s\S]*?max-height:\s*calc\(100vh\s*-\s*1rem\)[\s\S]*?margin:\s*0[\s\S]*?overflow:\s*auto[\s\S]*?padding:\s*var\(--space-md\)[\s\S]*?border:\s*1px solid var\(--border-strong\)[\s\S]*?border-radius:\s*var\(--radius-md\)[\s\S]*?background:\s*color-mix\([\s\S]*?backdrop-filter:\s*blur\(10px\)[\s\S]*?box-shadow:\s*var\(--shadow-lg\)[\s\S]*?opacity:\s*0[\s\S]*?visibility:\s*hidden[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.project-grid-card-info\[data-positioned="true"\]\s*\{[\s\S]*?top:\s*var\(--project-info-top, 0\)[\s\S]*?left:\s*var\(--project-info-left, 0\)/);
    expect(css).not.toMatch(/\.project-grid-card:hover \.project-grid-card-info|\.project-grid-card:focus-within \.project-grid-card-info/);
    expect(css).toMatch(/\.project-grid-card-info\[data-info-card-open="true"\]\s*\{[\s\S]*?display:\s*block/);
    expect(css).toMatch(/\.project-grid-card-info-row\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*minmax\(5\.5rem,\s*auto\)\s+minmax\(0,\s*1fr\)[\s\S]*?gap:\s*var\(--space-sm\)/);
    expect(css).toMatch(/\.project-grid-card-info-row dt,[\s\S]*?\.project-grid-card-info-section-label\s*\{[\s\S]*?font-size:\s*0\.6875rem[\s\S]*?text-transform:\s*uppercase/);
    expect(css).toMatch(/\.project-grid-card-info-section\s*\{[\s\S]*?margin-top:\s*var\(--space-sm\)[\s\S]*?padding-top:\s*var\(--space-sm\)[\s\S]*?border-top:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/\.project-grid-card-info-tags\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-wrap:\s*wrap[\s\S]*?gap:\s*var\(--space-xs\)/);
    expect(css).toMatch(/\.project-grid-card-info-tags li\s*\{[\s\S]*?padding:\s*0\.2rem 0\.45rem[\s\S]*?border-radius:\s*var\(--radius-sm\)[\s\S]*?background:\s*var\(--surface\)[\s\S]*?font-size:\s*0\.75rem/);
    expect(css).toMatch(/\.project-grid-card-info-releases\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--space-xs\);[^}]*list-style:\s*none;/);
    expect(css).toMatch(/\.project-grid-card-info-release-heading a\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/);
    expect(css).not.toMatch(/\.project-grid-card-title(?:-area)?(?:\s|\.|\{)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*540px\)[\s\S]*?\.project-grid-card-info-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(5rem,\s*auto\)\s+minmax\(0,\s*1fr\)[\s\S]*?gap:\s*var\(--space-xs\)/);
    expect(css).not.toMatch(/\.project-card--grid \.project-card-details\s*\{[\s\S]*?display:/);
    expect(css).toMatch(/\.project-list-card\s*\{[\s\S]*?grid-template-columns:\s*clamp\(7rem,\s*20%,\s*15rem\)\s+minmax\(0,\s*1fr\)/);
    expect(listCardRule).toMatch(/gap:\s*var\(--space-md\);/);
    expect(listCardRule).toMatch(/padding:\s*var\(--space-sm\);/);
    expect(listMediaRule).toMatch(/margin:\s*0;/);
    expect(listMediaRule).toMatch(/border-radius:\s*var\(--radius-md\);/);
    expect(css).toMatch(/\.project-list-card-media\s*\{[\s\S]*?min-height:\s*10rem/);
    expect(css).toMatch(/\.project-list-card-media-image\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*contain/);
    expect(css).toMatch(/\.project-list-card \.project-list-card-media-link\s*\{[^}]*color:\s*inherit;[^}]*font-weight:\s*normal;/);
    expect(css).toMatch(/\.project-list-card \.project-list-card-media-fallback,\s*\.project-list-card \.project-list-card-media-placeholder\s*\{[^}]*color:\s*var\(--muted\);[^}]*font-weight:\s*normal;/);
    expect(css).toMatch(/\.project-list-card \.project-list-card-media-link--fallback,\s*\.project-list-card \.project-list-card-media-link--fallback:visited\s*\{[^}]*color:\s*var\(--muted\);[^}]*font-weight:\s*normal;/);
    expect(css).toMatch(/\.project-list-card-metadata\s*\{[\s\S]*?display:\s*flex/);
    expect(css).toMatch(/\.project-list-card-associations\s*\{[\s\S]*?display:\s*flex/);
    expect(css).toMatch(/@media\s*\(max-width:\s*540px\)[\s\S]*?\.project-list-card-media\s*\{[\s\S]*?height:\s*9rem;[\s\S]*?min-height:\s*9rem/);
    expect(css).not.toMatch(/\.project-card--list \.project-card-media-image\s*\{/);
    expect(css).not.toMatch(/\.project-card--list \.project-card-media\s*\{/);
  });



  it('passes Tag and Search query state to the rendered listing', async () => {
    const tag = app.locals.tagService.createTag({ name: 'HTTP filter tag' });
    const matchingId = await createProject({ title: 'HTTP query match' });
    await createProject({ title: 'HTTP query other' });
    app.locals.projectTagService.replaceProjectTags(matchingId, [tag.id]);

    const response = await agent.get(`/projects?search=query&tag=${tag.id}`).expect(200);
    const matchingCard = extractProjectCard(response.text, matchingId);

    expect(matchingCard).toContain('HTTP query match');
    expect(extractProjectCards(response.text).join('')).not.toContain('HTTP query other');
    expect(extractTagFilter(response.text)).toContain(`value="${tag.id}" checked`);
  });

  it('normalizes empty, malformed, nonexistent, and deleted tag values to the unfiltered state', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Safe Filter Tag' });
    const taggedId = await createProject({ title: 'Safe Tagged Project', status: 'planned' });
    await createProject({ title: 'Safe Untagged Project', status: 'planned' });
    app.locals.projectTagService.replaceProjectTags(taggedId, [tag.id]);

    for (const rawTag of ['', '0', '-1', 'not-a-tag', '1.5', '999999']) {
      const response = await agent
        .get(`/projects?tag=${encodeURIComponent(rawTag)}&view=list`)
        .expect(200);

      expect(response.text).toContain('Safe Tagged Project');
      expect(response.text).toContain('Safe Untagged Project');
      expect(extractTagFilter(response.text)).toContain('aria-label="Tag filter: All tags"');
      expect(extractTagFilter(response.text)).not.toContain(`value="${tag.id}" checked`);
    }

    app.locals.tagService.deleteTag(tag.id);
    const deleted = await agent
      .get(`/projects?tag=${tag.id}&status=planned&view=list`)
      .expect(200);

    expect(deleted.text).toContain('Safe Tagged Project');
    expect(deleted.text).toContain('Safe Untagged Project');
    expect(extractTagFilter(deleted.text)).not.toContain(`value="${tag.id}"`);
    expect(deleted.text).toContain('href="/projects?status=planned&amp;view=list"');
  });


  it('passes the Project filter to the rendered listing', async () => {
    const selectedId = await createProject({ title: 'Selected HTTP project' });
    await createProject({ title: 'Unselected HTTP project' });

    const response = await agent.get(`/projects?project=${selectedId}`).expect(200);

    expect(extractProjectCard(response.text, selectedId)).toContain('Selected HTTP project');
    expect(extractProjectCards(response.text).join('')).not.toContain('Unselected HTTP project');
    expect(extractProjectFilter(response.text)).toContain(`value="${selectedId}" checked`);
  });

  it('preserves the selected project id through generated view links', async () => {
    const targetId = await createProject({ title: 'Project Link Alpha', status: 'planned' });
    await createProject({ title: 'Project Link Beta', status: 'planned' });
    for (let i = 0; i < 26; i += 1) {
      await createProject({ title: `Project Link Page ${String(i).padStart(2, '0')}`, status: 'planned' });
    }

    const res = await agent.get(`/projects?project=${targetId}&sort=title&order=asc`).expect(200);

    expect(res.text).toContain('1 project found');
    expect(res.text).toContain('Project Link Alpha');
    expect(res.text).toContain(`href="/projects?project=${targetId}&amp;sort=title&amp;order=asc&amp;view=list"`);
    expect(res.text).toContain(`href="/projects?project=${targetId}&amp;sort=title&amp;order=asc"`);
    expect(extractProjectCards(res.text).join('')).not.toContain('Project Link Beta');
    expect(res.text).not.toContain('Page 1 of');
  });

  it('normalizes empty, malformed, and unsupported project query values to no filter', async () => {
    const firstId = await createProject({ title: 'Project Normalize Alpha', status: 'planned' });
    const secondId = await createProject({ title: 'Project Normalize Beta', status: 'planned' });

    for (const rawProject of ['', '0', '-1', 'not-an-id', '1.5', '1e2']) {
      const response = await agent
        .get(`/projects?project=${encodeURIComponent(rawProject)}&sort=title&order=asc`)
        .expect(200);

      expect(response.text).toContain('2 projects found');
      expect(response.text).toContain('Project Normalize Alpha');
      expect(response.text).toContain('Project Normalize Beta');
      expect(response.text).not.toContain('No projects found');
    }

    const missing = await agent.get(`/projects?project=${999999}&sort=title&order=asc`).expect(200);
    expect(missing.text).toContain('No projects found');
    expect(missing.text).toContain('0 projects found');
    expect(extractProjectCards(missing.text).join('')).not.toContain('Project Normalize Alpha');
    expect(extractProjectCards(missing.text).join('')).not.toContain('Project Normalize Beta');
    expect(missing.text).toContain('href="/projects"');
    const missingProjectFilter = extractProjectFilter(missing.text);
    expect(missingProjectFilter).toMatch(/id="project-project-option-all"[^>]*checked/);
    expect(missingProjectFilter).toContain(
      'data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">All projects</span>',
    );
    expect(missingProjectFilter).toContain('aria-label="Project filter: All projects"');
    expect(missingProjectFilter).toContain('title="All projects"');
    expect((missingProjectFilter.match(/<input[^>]*name="project"[^>]*checked[^>]*>/g) || [])).toHaveLength(1);
    expect(missingProjectFilter).not.toMatch(/name="project"[^>]*value="999999"[^>]*checked/);
  });

  it('renders a selected merged KRA with intrinsic grid presentation and derivative URLs', async () => {
    const projectId = await createProject({ title: 'Merged KRA Project', status: 'ready' });
    const asset = await seedMergedKra(projectId);

    const grid = await agent.get('/projects').expect(200);
    const gridCard = extractProjectCard(grid.text, projectId);
    expect(gridCard).toContain('project-card-media--krita');
    expect(gridCard).toContain(`src="/projects/${projectId}/assets/${asset.id}/preview?v=`);
    expect(gridCard).not.toContain('/original');

    const list = await agent.get('/projects?view=list').expect(200);
    const listCard = extractProjectCard(list.text, projectId);
    expect(listCard).toContain('project-card-media--krita');
    expect(listCard).toContain(`src="/projects/${projectId}/assets/${asset.id}/thumbnail?v=`);
    expect(listCard).not.toContain('/original');
  });

  it('renders explicit Sort and Order query state', async () => {
    const olderCreatedId = await createProject({ title: 'Older Created Project' });
    const newerCreatedId = await createProject({ title: 'Newer Created Project' });
    db.prepare("UPDATE projects SET created_at = '2026-01-01 00:00:00', updated_at = '2026-03-01 00:00:00' WHERE id = ?")
      .run(olderCreatedId);
    db.prepare("UPDATE projects SET created_at = '2026-02-01 00:00:00', updated_at = '2026-01-01 00:00:00' WHERE id = ?")
      .run(newerCreatedId);

    const updated = await agent.get('/projects?sort=updated&order=asc').expect(200);
    expectProjectSortOrderSelection(updated.text, 'updated', 'asc');
    expect(updated.text.indexOf(`data-project-card-link href="/projects/${newerCreatedId}"`))
      .toBeLessThan(updated.text.indexOf(`data-project-card-link href="/projects/${olderCreatedId}"`));
  });

  it('normalizes project view state and preserves allowed query values', async () => {
    const tag = app.locals.tagService.createTag({ name: 'View State Tag' });
    for (let i = 0; i < 26; i += 1) {
      const projectId = await createProject({ title: `View State ${String(i).padStart(2, '0')}`, status: 'planned' });
      app.locals.projectTagService.replaceProjectTags(projectId, [tag.id]);
    }

    const list = await agent.get(`/projects?status=planned&tag=${tag.id}&sort=title&order=asc&view=list&unknown=discarded`).expect(200);
    expect(list.text).toContain('<ul class="project-list">');
      expect(list.text).toContain('name="view" value="list"');
      expect(list.text).toContain(`href="/projects?status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc"`);
      expect(list.text).toContain(`href="/projects?status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list"`);
      expect(list.text).toContain(`href="/projects?status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=2"`);
      expect(list.text).not.toContain('unknown=discarded');

    const invalid = await agent.get('/projects?view=invalid&unknown=discarded').expect(200);
    expect(invalid.text).toContain('<ul class="project-grid">');
    expect(invalid.text).not.toContain('view=invalid');
    expect(invalid.text).not.toContain('unknown=discarded');
    expect(invalid.text).toContain('href="/projects?view=list"');
    expect(invalid.text).toContain('href="/projects"');
  });

  it('normalizes an invalid page while retaining the canonical page boundary', async () => {
    for (let i = 0; i < 26; i += 1) {
      await createProject({ title: `Page boundary ${String(i).padStart(2, '0')}` });
    }

    const invalid = await agent.get('/projects?page=not-a-page&sort=title&order=asc').expect(200);

    expect(invalid.text).toContain('Page 1 of 2');
    expect(invalid.text).not.toContain('page=not-a-page');
    expect(invalid.text).toContain('href="/projects?sort=title&amp;order=asc&amp;page=2"');
  });


  it('preserves repeated Status, Project Type, and Tag selections through canonical pagination and view links', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const firstTag = app.locals.tagService.createTag({ name: 'Repeated First Tag' });
    const secondTag = app.locals.tagService.createTag({ name: 'Repeated Second Tag' });
    for (let i = 0; i < 26; i += 1) {
      const projectId = await createProject({
        title: `Repeated State ${String(i).padStart(2, '0')}`,
        status: i % 2 === 0 ? 'planned' : 'ready',
        projectType: i % 2 === 0 ? 'images' : 'comic',
      });
      app.locals.projectTagService.replaceProjectTags(projectId, [firstTag.id, secondTag.id]);
    }

    const redirect = await agent
      .get(`/projects?search=Repeated&status=ready&status=planned&type=comic&type=images&tag=${secondTag.id}&tag=${firstTag.id}&page=2`)
      .expect(302);
    const canonical = `/projects?search=Repeated&status=planned&status=ready&type=images&type=comic&tag=${firstTag.id}&tag=${secondTag.id}&sort=title&order=asc&view=list&page=2`;
    expect(redirect.headers.location).toBe(canonical);

    const pageTwo = await agent.get(canonical).expect(200);
    expect(pageTwo.text).toContain('26 projects found');
    expect(pageTwo.text).toContain('name="view" value="list"');
    expect(pageTwo.text).toContain(
      `href="/projects?search=Repeated&amp;status=planned&amp;status=ready&amp;type=images&amp;type=comic&amp;tag=${firstTag.id}&amp;tag=${secondTag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=1"`
    );
    expect(pageTwo.text).toContain(
      `href="/projects?search=Repeated&amp;status=planned&amp;status=ready&amp;type=images&amp;type=comic&amp;tag=${firstTag.id}&amp;tag=${secondTag.id}&amp;sort=title&amp;order=asc&amp;view=grid&amp;page=2"`
    );
    expect(extractStatusFilter(pageTwo.text)).toContain('aria-label="Status filter: 2 statuses selected"');
    expect(extractProjectTypeFilter(pageTwo.text)).toContain('aria-label="Project Type filter: 2 types selected"');
    expect(extractTagFilter(pageTwo.text)).toContain('aria-label="Tag filter: 2 tags selected"');
    expect((extractStatusFilter(pageTwo.text).match(/name="status"[^>]+checked/g) || [])).toHaveLength(2);
    expect((extractTagFilter(pageTwo.text).match(/name="tag"[^>]+checked/g) || [])).toHaveLength(2);
  });


  it('new-project form renders with available tags and no selected tags', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Form Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Form Beta' });

    const res = await agent.get('/projects/new').expect(200);
    const form = res.text.match(/<form id="project-form"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';

    expect(form).toContain('method="post"');
    expect(form).toContain('action="/projects"');
    expect(form).toMatch(/<input[^>]*type="hidden"[^>]*name="_csrf"[^>]*value="[^"]+"/);
    expect(form).toMatch(/<label for="title">Title[\s\S]*?<input[^>]*name="title"[^>]*\brequired\b/);
    expect(form).toMatch(/<label for="description">Description[\s\S]*?<textarea[^>]*name="description"/);
    expect(form).toMatch(/<label for="notes">Notes[\s\S]*?<textarea[^>]*name="notes"/);
    expect(form).toMatch(/<label for="patreonUrl">Project link[\s\S]*?<input[^>]*name="patreonUrl"/);

    const statusField = extractProjectFormStatusField(form);
    expect(statusField).toMatch(/name="status"[^>]*value="tbd"[^>]*checked/);
    expect(statusField).toContain('aria-label="Status: Tbd"');

    const projectTypeField = form.match(/<fieldset class="field asset-filter-multiselect-field[^"]*">\s*<legend>Project type[\s\S]*?<\/fieldset>/)?.[0] || '';
    expect(projectTypeField).toMatch(/name="projectType"[^>]*value="images"[^>]*checked/);
    for (const type of ['images', 'comic', 'animation', 'wallpaper']) {
      expect(projectTypeField).toMatch(new RegExp(`name="projectType"[^>]*value="${type}"`));
    }

    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).not.toBe('');
    expect(tagsField).toMatch(/id="project-tags-form-trigger"\s+aria-controls="project-tags-form-options"/);
    expect(tagsField).toContain('aria-label="Tags: No tags selected"');
    expect(tagsField).toContain('role="group" aria-label="Tag options"');
    expect(tagsField).toMatch(new RegExp(`name="tagIds\\[\\]"[^>]*value="${alpha.id}"[^>]*>[\\s\\S]*?Form Alpha`));
    expect(tagsField).toMatch(new RegExp(`name="tagIds\\[\\]"[^>]*value="${beta.id}"[^>]*>[\\s\\S]*?Form Beta`));
    expect((tagsField.match(/name="tagIds\[\]"[^>]*checked/g) || [])).toHaveLength(0);
  });

  it('new-project form renders an empty tag catalog with a Settings link', async () => {
    const res = await agent.get('/projects/new').expect(200);
    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).not.toBe('');
    expect(tagsField).toMatch(/No tags available\.\s*<a href="\/settings\/tags">Add tags in Settings<\/a>/);
    expect(tagsField).toContain('aria-label="Tags: No tags selected"');
    expect(tagsField).not.toMatch(/<input[^>]*name="tagIds\[\]"/);
  });

  it('new-project form seeds the valid saved New Project status default', async () => {
    saveNewProjectDefault('status', 'ready');

    const res = await agent.get('/projects/new').expect(200);

    expect(extractProjectFormStatusField(res.text)).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
  });

  it('renders one closed native New Project dialog with host returnTo and standalone defaults', async () => {
    saveNewProjectDefault('status', 'ready');
    app.locals.tagService.createTag({ name: 'Projects dialog tag' });

    const [projects, standalone] = await Promise.all([
      agent.get('/projects').expect(200),
      agent.get('/projects/new').expect(200),
    ]);
    const dialog = projects.text.match(/<dialog id="project-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    const ids = [...projects.text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const headingActions = extractPageHeadingActions(projects.text);
    const headingNewProject = headingActions.match(/<a\b[^>]*href="\/projects\/new"[^>]*>[\s\S]*?<\/a>/)?.[0] || '';
    const headingNewProjectContent = headingNewProject.match(/>([\s\S]*)<\/a>/)?.[1] || '';
    const emptyState = projects.text.match(/<div class="empty-state">[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';

    expect((projects.text.match(/<dialog id="project-create-dialog"/g) || [])).toHaveLength(1);
    expect(headingNewProject).toContain('class="button button-small button-primary project-detail-action project-assets-heading-action asset-tooltip asset-tooltip--left"');
    expect(headingNewProject).toContain('href="/projects/new"');
    expect(headingNewProject).toContain('data-dialog-open="project-create-dialog"');
    expect(headingNewProject).toContain('data-dialog-invocation');
    expect(headingNewProject).toContain('aria-label="New Project"');
    expect(headingNewProject).toContain('data-tooltip="New Project"');
    expect(headingNewProjectContent).toContain('<svg');
    expect(headingNewProjectContent).toContain('<path d="M12 5v14M5 12h14"/>');
    expect(headingNewProjectContent).not.toContain('New Project');
    expect(emptyState).toContain('<a class="button button-primary" href="/projects/new" data-dialog-open="project-create-dialog" data-dialog-invocation>New Project</a>');
    expect(dialog).not.toBe('');
    expect(dialog).not.toMatch(/<dialog\b[^>]*\bopen(?:\s|>|=)/);
    expect(dialog).toContain('<form id="project-create-form" method="post" action="/projects"');
    expect(dialog).toContain('data-dialog-form data-dialog-async="false"');
    expect(dialog).toContain('name="returnTo" value="/projects"');
    expect(dialog).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
    expect(standalone.text).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
    expect(dialog).toContain('Projects dialog tag');
    expect(new Set(ids).size).toBe(ids.length);
    expectProjectFormStructure(dialog);
    expectProjectFormStructure(standalone.text);
  });

  it('does not render a filtered-empty-state Reset action', async () => {
    await createProject({ title: 'Existing Project' });

    const res = await agent.get('/projects?search=no-match').expect(200);

    const emptyState = res.text.match(/<div class="empty-state">[\s\S]*?<\/div>/)?.[0] || '';
    expect(emptyState).toContain('<h2 class="empty-state-heading">No projects found</h2>');
    expect(emptyState).toContain('<p>No projects match the current filters.</p>');
    expect(emptyState).not.toContain('<a');
    expect(emptyState).not.toContain('data-projects-reset');
  });

  it('new-project form uses the tbd fallback when no status default is saved', async () => {
    const res = await agent.get('/projects/new').expect(200);

    expect(extractProjectFormStatusField(res.text)).toMatch(/name="status"[^>]*value="tbd"[^>]*checked/);
  });

  it('edit dialog shows the stored project status even when the New Project default differs', async () => {
    saveNewProjectDefault('status', 'ready');
    const id = await createProject({ title: 'Editable', status: 'in-progress' });

    const res = await agent.get(`/projects/${id}?edit=1`).expect(200);

    expectProjectFormStatusDisclosure(res.text, 'in-progress');
    expect(res.text).not.toContain('id="priority"');
  });

  it.each([undefined, 'invalid-token'])('rejects create without a valid CSRF token (%s) without mutation', async (token) => {
    const beforeCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    const fields = new URLSearchParams({ title: 'CSRF rejected project', status: 'tbd' });
    if (token !== undefined) fields.set('_csrf', token);

    await agent
      .post('/projects')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(fields.toString())
      .expect(403);

    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(beforeCount);
  });

  it('creates the submitted project and tags with a detail PRG', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Create Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Create Beta' });

    const res = await agent
      .post('/projects')
      .send('title=Submitted+Project')
      .send('description=Submitted+description')
      .send('notes=Submitted+notes')
      .send('status=planned')
      .send('projectType=comic')
      .send('patreonUrl=https%3A%2F%2Fexample.com%2Fproject')
      .send(`tagIds[]=${alpha.id}`)
      .send(`tagIds[]=${beta.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(res.headers.location.replace('/projects/', ''));
    expect(res.headers.location).toBe(`/projects/${id}`);
    expect(db.prepare(`
      SELECT title, description, notes, status, project_type, patreon_url
      FROM projects WHERE id = ?
    `).get(id)).toEqual({
      title: 'Submitted Project',
      description: 'Submitted description',
      notes: 'Submitted notes',
      status: 'planned',
      project_type: 'comic',
      patreon_url: 'https://example.com/project',
    });
    const assigned = app.locals.projectTagService.listProjectTags(id).map((tag) => tag.id);
    expect(assigned).toEqual([alpha.id, beta.id]);
  });

  it('rejects a malformed submitted tag ID before creating a project', async () => {
    const create = vi.spyOn(app.locals.projectService, 'create');
    const beforeCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;

    try {
      const res = await agent
        .post('/projects')
        .send('title=Malformed+Tag+Create')
        .send('status=tbd')
        .send('tagIds[]=not-a-tag-id')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(create).not.toHaveBeenCalled();
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(beforeCount);

      const form = res.text.match(/<form id="project-form"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
      const tagsField = extractProjectFormTagsField(form);
      expect(form).toMatch(/<input[^>]*name="title"[^>]*value="Malformed Tag Create"/);
      expect(form).toMatch(/<span[^>]*id="tagIds-error"[^>]*>Tag selections must contain canonical positive integer IDs\.<\/span>/);
      expect(tagsField).toMatch(/<summary[^>]*aria-describedby="tagIds-error"[^>]*aria-invalid="true"/);
    } finally {
      create.mockRestore();
    }
  });

  it('create with a stale deleted tag returns 422 without creating the project', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Stale Create Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Stale Create Beta' });

    app.locals.tagService.deleteTag(alpha.id);

    const beforeCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    const res = await agent
      .post('/projects')
      .send('title=Stale+Tag+Create')
      .send('status=tbd')
      .send(`tagIds[]=${alpha.id}`)
      .send(`tagIds[]=${beta.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    const afterCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    expect(afterCount).toBe(beforeCount);
    expect(res.text).toContain('One or more selected tags no longer exists. Refresh and try again.');

    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).toMatch(new RegExp(`value="${beta.id}"[^>]*checked`));
    expect(tagsField).toContain('Stale Create Beta');
    expect(tagsField).toContain('aria-describedby="tagIds-error"');
  });

  it('atomically rejects a tag deleted after pre-validation without leaving a project', async () => {
    const staleTag = app.locals.tagService.createTag({ name: 'Race Create Stale' });
    const retainedTag = app.locals.tagService.createTag({ name: 'Race Create Retained' });
    const beforeCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    const expectedId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM projects').get().id;
    const expectedRoot = path.join(projectsRoot, formatProjectDirName(expectedId, 'race-create-project'));
    const listTags = vi.spyOn(app.locals.tagService, 'listTags');
    const deleteTag = vi.spyOn(app.locals.tagService, 'deleteTag');
    const originalCreate = app.locals.projectService.create.bind(app.locals.projectService);
    const create = vi.spyOn(app.locals.projectService, 'create');

    create.mockImplementation((input, options) => {
      app.locals.tagService.deleteTag(staleTag.id);
      return originalCreate.call(app.locals.projectService, input, options);
    });

    try {
      const res = await agent
        .post('/projects')
        .send('title=Race+Create+Project')
        .send('status=tbd')
        .send(`tagIds[]=${staleTag.id}`)
        .send(`tagIds[]=${retainedTag.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(create).toHaveBeenCalledTimes(1);
      expect(listTags.mock.results[0].value).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: staleTag.id }),
      ]));
      expect(listTags.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
      expect(deleteTag.mock.invocationCallOrder[0]).toBeGreaterThan(create.mock.invocationCallOrder[0]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(beforeCount);
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_tags').get().count).toBe(0);
      expect(fs.existsSync(expectedRoot)).toBe(false);
      expect(fs.existsSync(path.join(expectedRoot, MANIFEST_FILENAME))).toBe(false);
      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('One or more selected tags no longer exists. Refresh and try again.');

      const form = res.text.match(/<form id="project-form"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
      const tagsField = extractProjectFormTagsField(form);
      expect(form).toMatch(/<input[^>]*name="title"[^>]*value="Race Create Project"/);
      expect(tagsField).toMatch(new RegExp(`value="${retainedTag.id}"[^>]*checked`));
      expect(tagsField).toContain('aria-describedby="tagIds-error"');
      expect(tagsField).toContain('aria-invalid="true"');
    } finally {
      create.mockRestore();
      deleteTag.mockRestore();
      listTags.mockRestore();
    }
  });

  it('rerenders a rejected create with its submitted field values, tags, and semantic errors', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Retry tag' });
    const beforeCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    const res = await agent
      .post('/projects')
      .send('title=Retry+title')
      .send('description=Retry+description')
      .send('notes=Retry+notes')
      .send('status=ready')
      .send('projectType=animation')
      .send('patreonUrl=example.com/not-patreon')
      .send(`tagIds[]=${tag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    const form = res.text.match(/<form id="project-form"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
    const tagsField = extractProjectFormTagsField(form);
    expect(form).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    expect(form).toMatch(/<input[^>]*name="title"[^>]*value="Retry title"/);
    expect(form).toMatch(/<textarea[^>]*name="description"[^>]*>Retry description<\/textarea>/);
    expect(form).toMatch(/<textarea[^>]*name="notes"[^>]*>Retry notes<\/textarea>/);
    expect(form).toMatch(/name="status"[^>]*value="ready"[^>]*checked/);
    expect(form).toMatch(/name="projectType"[^>]*value="animation"[^>]*checked/);
    expect(form).toMatch(/<input[^>]*name="patreonUrl"[^>]*value="example.com\/not-patreon"/);
    expect(tagsField).toMatch(new RegExp(`name="tagIds\\[\\]"[^>]*value="${tag.id}"[^>]*checked`));
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(beforeCount);
  });

  it('rerenders a rejected invocation in its validated Projects dialog', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Projects retry tag' });
    const returnTo = '/projects?search=needle&status=planned&sort=title&order=asc&view=list&page=3#projects-list';

    const res = await agent
      .post('/projects')
      .send('title=Projects+Preserves')
      .send('status=planned')
      .send('patreonUrl=not-a-url')
      .send(`tagIds[]=${tag.id}`)
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    const dialog = extractProjectCreateDialog(res.text);
    expect(dialog).toMatch(/<dialog id="project-create-dialog"[^>]*\bopen\b/);
    expect(dialog).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    expect(dialog).toMatch(/<input[^>]*name="title"[^>]*value="Projects Preserves"/);
    expect(dialog).toContain('name="returnTo" value="/projects?search=needle&amp;status=planned&amp;sort=title&amp;order=asc&amp;view=list&amp;page=3#projects-list" data-dialog-return-location');
    expect(dialog).toMatch(new RegExp(`name="tagIds\\[\\]"[^>]*value="${tag.id}"[^>]*checked`));
  });

  it('does not trust an external create returnTo on validation failure', async () => {
    const returnTo = 'https://evil.example/projects';
    const res = await agent
      .post('/projects')
      .send('title=Invalid+Host')
      .send('status=tbd')
      .send('patreonUrl=not-a-url')
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('<form id="project-form"');
    expect(res.text).not.toContain('id="project-create-dialog"');
    expect(res.text).not.toContain(`name="returnTo" value="${returnTo}"`);
  });

  it('rejects an invalid submitted Project Type without creation', async () => {
    const beforeCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    const res = await agent
      .post('/projects')
      .send('title=Invalid+Type')
      .send('status=tbd')
      .send('projectType=not-a-project-type')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    const form = res.text.match(/<form id="project-form"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
    expect(form).toContain('Project type must be one of: images, comic, animation, wallpaper.');
    expect(form).toContain('id="projectType-error"');
    expect(form).toMatch(/name="projectType"[^>]*aria-describedby="projectType-error"[^>]*aria-invalid="true"/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(beforeCount);
  });

  it('renders an unexpected creation failure safely without a false success', async () => {
    vi.spyOn(app.locals.projectService, 'create').mockImplementation(() => {
      throw new Error('internal filesystem detail');
    });

    const res = await agent
      .post('/projects')
      .send('title=Failure+Project')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(500);

    expect(res.text).toContain('Project creation failed. Please try again.');
    expect(res.text).not.toContain('internal filesystem detail');
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(0);
  });

  it('active project detail removes Manage tags and opens project editing from the compact toolbar', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Detail+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const location = createRes.headers.location;
    const res = await agent.get(location).expect(200);
    const headingActions = extractPageHeadingActions(res.text);
    const toolbar = extractProjectDetailActionToolbar(res.text);
    const metaStart = res.text.indexOf('<div class="project-detail-meta">');
    const meta = metaStart >= 0 ? extractHtmlElement(res.text, metaStart) : '';
    const summaryStart = res.text.indexOf('<div class="project-detail-summary">');
    const summary = summaryStart >= 0 ? extractHtmlElement(res.text, summaryStart) : '';
    const healthStart = res.text.indexOf('<section class="project-detail-health">');
    const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    expect(res.text).toContain('Detail Project');
    expect(headingActions).toBe('');
    expect(res.text).not.toContain('Manage tags');
    expect(res.text).not.toContain(`href="${location}/tags"`);
    // Asset Categories is reached from the assets page, not the detail header.
    expect(res.text).not.toContain(`href="${location}/asset-categories"`);
    expect(toolbar).toContain('<nav class="project-detail-action-toolbar" aria-label="Project actions">');
    expect(toolbar).toContain(`href="${location}/edit"`);
    expect(toolbar).toContain('data-dialog-open="project-edit-dialog"');
    expect(toolbar).toContain('aria-label="Edit project"');
    expect(toolbar).toContain(`href="${location}/assets"`);
    expect(toolbar).toContain('aria-label="View Assets"');
    expect(toolbar).not.toContain('aria-label="Open locally"');
    expect((toolbar.match(/<a\b/g) || [])).toHaveLength(2);
    expect(dialog).not.toBe('');
    expect(dialog).toContain('<dialog id="project-edit-dialog" class="app-dialog project-form-dialog"');
    expect(dialog).toContain('<h2 id="project-edit-dialog-title">Edit Project</h2>');
    expect(dialog).toContain('Edit project details, status, and links.');
    expect(dialog).not.toContain('Update project metadata and planning fields.');
    expect(dialog).toContain(`<form id="project-edit-form" method="post" action="${location}" class="app-dialog-form project-form project-edit-dialog-form"`);
    expect(dialog).toContain('project-edit-dialog-form');
    expect(dialog).toContain('data-dialog-form data-dialog-async="false"');
    const dialogHeader = dialog.match(/<header class="app-dialog-header">[\s\S]*?<\/header>/)?.[0] || '';
    const dialogClose = dialogHeader.match(/<button\b[\s\S]*?<\/button>/)?.[0] || '';
    expect(dialogClose).toMatch(/class="app-dialog-close[^"]*" type="button"/);
    expect(dialogClose).toContain('data-dialog-close');
    expect(dialogClose).not.toMatch(/\sform=/);
    expect(dialogClose).not.toContain('formmethod="dialog"');
    expect(dialogClose).not.toContain('type="submit"');
    const projectEditSubmitters = dialog.match(/<button\b(?=[^>]*\btype="submit")(?=[^>]*\bform="project-edit-form")[^>]*>[\s\S]*?<\/button>/g) || [];
    expect(projectEditSubmitters).toHaveLength(1);
    expect(projectEditSubmitters[0]).toContain('data-dialog-submit>Save changes</button>');
    expect(dialog).toContain('class="app-dialog-body project-edit-dialog-body"');
    expect(dialog).toContain('class="app-dialog-footer"');
    expect(dialog.indexOf('app-dialog-body project-edit-dialog-body')).toBeLessThan(dialog.indexOf('app-dialog-footer'));
    expect(dialog).toContain('Basic information');
    expect(dialog).toContain('>Status</h3>');
    expect(dialog).not.toContain('>Scheduling</h3>');
    expect(dialog).toContain('Links');
    const basicInformation = extractProjectSettingsSection(dialog, 'Basic information');
    expect(basicInformation).not.toBe('');
    expect(basicInformation).toContain('<label for="title">Title');
    expect(basicInformation).toContain('name="title"');
    expect(basicInformation).toContain('name="description"');
    expect(basicInformation).toContain('name="notes"');
    expect(basicInformation).toMatch(/<textarea id="description"[^>]*rows="6"/);
    expect(basicInformation).toMatch(/<textarea id="notes"[^>]*rows="4"/);
    const status = extractProjectSettingsSection(dialog, 'Status');
    expect(status).not.toBe('');
    expect(status).toContain('name="status"');
    expect(status).toContain('id="project-tags-form"');
    expectProjectFormStructure(dialog);
    const links = extractProjectSettingsSection(dialog, 'Links');
    expect(links).not.toBe('');
    expect(links).toContain('id="patreonUrl"');
    expect(links).toContain('name="patreonUrl"');
    expect(links).toContain('Optional absolute HTTP or HTTPS URL for this project.');
    expect(dialog).not.toContain('data-dialog-close>Cancel</button>');
    expect(dialog).not.toMatch(/<button[^>]*>\s*Cancel\s*<\/button>/);
    expect(dialog).toContain('data-dialog-submit>Save changes</button>');
    expect(dialog).not.toContain('>View assets</a>');
    expect(dialog).toContain(`<form method="post" action="${location}/archive">`);
    expect(dialog).toContain('Archive keeps this project and its data, but makes it archived and read-only.');
    const archiveForm = dialog.match(new RegExp(`<form method="post" action="${location}/archive">[\\s\\S]*?</form>`))?.[0] || '';
    const deleteForm = dialog.match(new RegExp(`<form method="post" action="${location}/delete">[\\s\\S]*?</form>`))?.[0] || '';
    expect(archiveForm).toContain('data-confirm="Archive this project? This cannot be undone."');
    expect(archiveForm).not.toContain('data-confirm-dialog');
    expect(dialog).toContain('Permanently delete this project and its owned data. This cannot be undone.');
    expect(deleteForm).toContain('data-confirm="Delete this project permanently? This cannot be undone."');
    expect(deleteForm).toContain('data-confirm-dialog');
    expect(deleteForm).toContain('data-confirm-dialog-title="Delete project"');
    expect(deleteForm).toContain('data-confirm-dialog-confirm-label="Delete project"');
    expect(deleteForm).toContain(`name="_csrf" value="${csrfToken}"`);
    expect(dialog).not.toContain('inline-confirmation');
    expect(meta.indexOf('status-badge')).toBeGreaterThanOrEqual(0);
    expect(meta.indexOf('project-detail-action-toolbar')).toBeGreaterThan(meta.indexOf('status-badge'));
    expect(summary).toMatch(/<div class="project-detail-meta">[\s\S]*?<\/div>\s*<section class="project-detail-health">\s*<div class="count-grid">/);
    expect(healthStart).toBeGreaterThan(metaStart);
    const health = extractProjectDetailSection(res.text, 'project-detail-health');
    expect(health).toContain('<section class="project-detail-health">');
    const countGridStart = health.indexOf('<div class="count-grid">');
    const countGrid = countGridStart >= 0 ? extractHtmlElement(health, countGridStart) : '';
    const countCards = extractDirectHtmlChildren(countGrid).filter((child) => child.includes('class="count-card"'));
    expect(countCards).toHaveLength(3);
    expect(countCards[0]).toContain('<span class="count">0</span> Total assets');
    expect(countCards[1]).toContain('<span class="count">0</span> Present');
    expect(countCards[2]).toContain('<span class="count">0</span> Missing');
    expect(meta).not.toContain('project-detail-health');
    expect(summary.indexOf('project-detail-action-toolbar')).toBeGreaterThanOrEqual(0);
    expect(summary.indexOf('project-detail-action-toolbar')).toBeLessThan(summary.indexOf('project-detail-health'));
    const css = await fetchProjectCss(app);
    const projectFormDialogWidthRule = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      .map(([, selectors, declarations]) => ({
        selectors: selectors.trim().split(',').map((selector) => selector.trim()),
        declarations,
      }))
      .find((rule) => rule.selectors.includes('#project-edit-dialog'));
    expect(projectFormDialogWidthRule).toBeDefined();
    expect(projectFormDialogWidthRule.selectors).toEqual(expect.arrayContaining([
      '#project-edit-dialog',
      '#project-create-dialog',
    ]));
    expect(projectFormDialogWidthRule.declarations).toContain('width: min(51rem, calc(100vw - 2rem));');
    expect(projectFormDialogWidthRule.declarations).toContain('max-width: calc(100vw - 2rem);');
    expect(css).toMatch(/#project-asset-category-management-dialog\s*\{[^}]*width:\s*min\(68rem,\s*calc\(100vw - 2rem\)\)/);
    expect(css).toMatch(/\.project-detail-meta\s*\{[^}]*justify-content:\s*space-between/);
    expect(css).toMatch(/\.project-detail-action-toolbar\s*\{[^}]*margin-left:\s*auto/);
    expect(css).toMatch(/\.project-detail-action\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*min-block-size:\s*2\.25rem[^}]*min-inline-size:\s*2\.25rem[^}]*padding:\s*var\(--space-sm\)/);
    expect(css).toMatch(/\.project-detail-action svg\s*\{[^}]*width:\s*1\.25rem[^}]*height:\s*1\.25rem/);
    const projectEditBodyRule = css.match(/\.project-form-dialog \.app-dialog-body > \*\s*\{[^}]*\}/)?.[0] || '';
    expect(projectEditBodyRule).toContain('flex-shrink: 0');
    const projectEditPanelRule = css.match(/\.project-form-dialog \.project-edit-dialog-section\s*\{[^}]*\}/)?.[0] || '';
    expect(projectEditPanelRule).toContain('background: var(--surface)');
    expect(projectEditPanelRule).toContain('border: 1px solid var(--border)');
    expect(projectEditPanelRule).toContain('border-radius: var(--radius-lg)');
    expect(projectEditPanelRule).toContain('overflow: visible');
    expect(css).toContain('.project-form-dialog .project-edit-dialog-section > h3');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.project-form-dialog \.status-row,[\s\S]*\.project-form-dialog \.scheduling-row[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    const healthRule = css.match(/\.project-detail-health\s*\{[^}]*\}/)?.[0] || '';
    expect(healthRule).toContain('margin-top: var(--space-xs)');
    expect(healthRule).not.toContain('padding:');
    expect(healthRule).not.toContain('background:');
    expect(healthRule).not.toContain('border:');
    expect(healthRule).not.toContain('border-radius:');
    const countGridRule = css.match(/\.count-grid\s*\{[^}]*\}/)?.[0] || '';
    expect(countGridRule).toContain('display: grid');
    expect(countGridRule).toContain('grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr))');
    expect(countGridRule).toContain('gap: 0.75rem');
    const countCardRule = css.match(/\.project-detail-health\s+\.count-card\s*\{[^}]*\}/)?.[0] || '';
    expect(countCardRule).toContain('padding: var(--space-sm) var(--space-md)');
    expect(countCardRule).toContain('background: var(--surface)');
    expect(countCardRule).toContain('border: 1px solid var(--border)');
    expect(countCardRule).toContain('border-radius: var(--radius-md)');
    expect(countCardRule).toContain('text-align: center');
    expect(countCardRule).toContain('color: var(--muted)');
    expect(countCardRule).toContain('font-size: 0.875rem');
    const countNumberRule = css.match(/\.project-detail-health\s+\.count\s*\{[^}]*\}/)?.[0] || '';
    expect(countNumberRule).toContain('font-size: 1.25rem');
    expect(res.text).not.toMatch(
      new RegExp(`<section class="workflow-actions">\\s*<a[^>]+href="${location}/assets"`),
    );
  });

  it('edit dialog renders from the normal project detail page', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Edit Current Tag' });
    const createRes = await agent
      .post('/projects')
      .send('title=Editable+Project')
      .send('description=Current+description')
      .send('notes=Current+notes')
      .send('status=tbd')
      .send('projectType=comic')
      .send('patreonUrl=https://example.com/current-project')
      .send(`tagIds[]=${tag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent.get(`${createRes.headers.location}?edit=1`).expect(200);
    const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    expect(dialog).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
    expect(dialog).toContain(`<form id="project-edit-form" method="post" action="${createRes.headers.location}"`);
    expect(dialog).toContain(`name="_csrf" value="${csrfToken}"`);
    expect(dialog).toMatch(/name="title"[^>]*value="Editable Project"/);
    expect(dialog).toMatch(/<textarea id="description"[^>]*>Current description<\/textarea>/);
    expect(dialog).toMatch(/<textarea id="notes"[^>]*>Current notes<\/textarea>/);
    expectProjectFormStatusDisclosure(dialog, 'tbd');
    expect(dialog).toMatch(/name="projectType"[^>]*value="comic"[^>]*checked/);
    expect(dialog).toMatch(new RegExp(`name="tagIds\\[\\]"[^>]*value="${tag.id}"[^>]*checked`));
  });

  it('carries a validated Project Assets invocation through the edit host', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Invoked+Project+Edit')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');
    const returnTo = `/projects/${id}/assets?view=list&page=3#asset-42`;

    const entry = await agent
      .get(`/projects/${id}/edit?returnTo=${encodeURIComponent(returnTo)}`)
      .expect(302);
    const hosted = new URL(entry.headers.location, 'http://creatorcrate.local');
    expect(hosted.pathname).toBe(`/projects/${id}`);
    expect(hosted.searchParams.get('edit')).toBe('1');
    expect(hosted.searchParams.get('returnTo')).toBe(returnTo);

    const res = await agent.get(entry.headers.location).expect(200);
    expect(res.text).toContain(`name="returnTo" value="/projects/${id}/assets?view=list&amp;page=3#asset-42" data-dialog-return-location`);
  });

  it('returns a successful invoked edit to the exact Project Assets location', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Invoked+Edit+Success')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');
    const returnTo = `/projects/${id}/assets?view=list&page=3#asset-42`;

    const res = await agent
      .post(`/projects/${id}`)
      .type('form')
      .send({ title: 'Invoked Edit Saved', status: 'planned', returnTo, _csrf: csrfToken })
      .expect(302);

    expect(res.headers.location).toBe(returnTo);
    expect(app.locals.projectService.findById(Number(id)).title).toBe('Invoked Edit Saved');
  });

  it('retains submitted values and invocation metadata after an edit error rerender', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Invoked+Edit+Error')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');
    const returnTo = `/projects/${id}/assets?view=list&page=3#asset-42`;
    const update = vi.spyOn(app.locals.projectService, 'update')
      .mockImplementationOnce(() => { throw new Error('simulated update failure'); });

    let res;
    try {
      res = await agent
        .post(`/projects/${id}`)
        .type('form')
        .send({ title: 'Still Submitted After Error', status: 'planned', returnTo, _csrf: csrfToken })
        .expect(500);
    } finally {
      update.mockRestore();
    }

    expect(res.text).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
    expect(res.text).toContain('value="Still Submitted After Error"');
    expect(res.text).toContain('Project update failed. Please try again.');
    expect(res.text).toContain(`name="returnTo" value="/projects/${id}/assets?view=list&amp;page=3#asset-42" data-dialog-return-location`);
  });

  it('does not follow external or wrong-Project edit return destinations', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Safe+Edit+Return')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const otherRes = await agent
      .post('/projects')
      .send('title=Other+Edit+Return')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');
    const otherId = otherRes.headers.location.replace('/projects/', '');
    const invalidDestinations = [
      'https://example.com/projects/1/assets',
      `/projects/${otherId}/assets?view=list`,
    ];

    for (const [index, returnTo] of invalidDestinations.entries()) {
      const entry = await agent
        .get(`/projects/${id}/edit?returnTo=${encodeURIComponent(returnTo)}`)
        .expect(302);
      expect(entry.headers.location).toBe(`/projects/${id}?edit=1`);

      const update = await agent
        .post(`/projects/${id}`)
        .type('form')
        .send({ title: `Safe Edit Return ${index}`, status: 'tbd', returnTo, _csrf: csrfToken })
        .expect(302);
      expect(update.headers.location).toBe(`/projects/${id}`);
    }
  });

  it('edit dialog contains the former Edit-page actions without nesting action forms', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Project+Actions')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');

    const res = await agent.get(`/projects/${id}?edit=1`).expect(200);
    const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    expect(dialog).not.toBe('');
    expect(dialog).not.toContain('>View assets</a>');
    expect(dialog).toContain(`<form method="post" action="/projects/${id}/archive">`);
    expect(dialog).toContain(`<form method="post" action="/projects/${id}/delete">`);
    expect(dialog).toMatch(/<form id="project-edit-form"[\s\S]*?<\/form>[\s\S]*?<form method="post" action="\/projects\/\d+\/archive">/);
    expect(dialog).toContain('Archive project');
    expect(dialog).toContain('Delete project');
  });

  it('updates all current submitted fields and redirects to detail', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Old+Name')
      .send('description=Old+description')
      .send('notes=Old+notes')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const res = await agent
      .post(createRes.headers.location)
      .send('title=New+Name')
      .send('description=Updated+description')
      .send('notes=Updated+notes')
      .send('status=planned')
      .send('projectType=comic')
      .send('patreonUrl=https://example.com/updated-project')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    expect(app.locals.projectService.findById(Number(createRes.headers.location.replace('/projects/', ''))))
      .toEqual(expect.objectContaining({
        title: 'New Name',
        description: 'Updated description',
        notes: 'Updated notes',
        status: 'planned',
        project_type: 'comic',
        patreon_url: 'https://example.com/updated-project',
      }));
  });

  it.each([undefined, 'invalid-token'])('rejects update without a valid CSRF token (%s) without mutation', async (token) => {
    const tag = app.locals.tagService.createTag({ name: 'CSRF Update Tag' });
    const createRes = await agent
      .post('/projects')
      .send('title=CSRF+Update+Project')
      .send('description=Original+description')
      .send('notes=Original+notes')
      .send('status=tbd')
      .send(`tagIds[]=${tag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    const before = db.prepare(
      'SELECT title, description, notes, status, project_type, patreon_url FROM projects WHERE id = ?',
    ).get(id);
    const update = vi.spyOn(app.locals.projectService, 'update');
    const fields = new URLSearchParams({
      title: 'CSRF mutation attempt',
      description: 'Changed description',
      notes: 'Changed notes',
      status: 'planned',
      projectType: 'comic',
      patreonUrl: 'https://example.com/csrf-attempt',
    });
    if (token !== undefined) fields.set('_csrf', token);

    try {
      await agent
        .post(createRes.headers.location)
        .type('form')
        .send(fields.toString())
        .expect(403);

      expect(update).not.toHaveBeenCalled();
      expect(db.prepare(
        'SELECT title, description, notes, status, project_type, patreon_url FROM projects WHERE id = ?',
      ).get(id)).toEqual(before);
      expect(app.locals.projectTagService.listProjectTags(id).map((assigned) => assigned.id)).toEqual([tag.id]);
    } finally {
      update.mockRestore();
    }
  });

  it('rejects a malformed project update ID before calling the service or mutating state', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Malformed Project ID Tag' });
    const createRes = await agent
      .post('/projects')
      .send('title=Malformed+Project+ID')
      .send('status=tbd')
      .send(`tagIds[]=${tag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    const before = app.locals.projectService.findById(id);
    const update = vi.spyOn(app.locals.projectService, 'update');

    try {
      await agent
        .post('/projects/01')
        .type('form')
        .send({ title: 'Malformed ID mutation attempt', status: 'planned', _csrf: csrfToken })
        .expect(404);

      expect(update).not.toHaveBeenCalled();
      expect(app.locals.projectService.findById(id)).toEqual(before);
      expect(app.locals.projectTagService.listProjectTags(id).map((assigned) => assigned.id)).toEqual([tag.id]);
    } finally {
      update.mockRestore();
    }
  });

  it('returns 404 for an unknown project update without mutating an existing project', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Unknown Project ID Tag' });
    const createRes = await agent
      .post('/projects')
      .send('title=Known+Project')
      .send('status=tbd')
      .send(`tagIds[]=${tag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    const before = app.locals.projectService.findById(id);

    await agent
      .post('/projects/999999')
      .type('form')
      .send({ title: 'Unknown ID mutation attempt', status: 'planned', _csrf: csrfToken })
      .expect(404);

    expect(app.locals.projectService.findById(id)).toEqual(before);
    expect(app.locals.projectTagService.listProjectTags(id).map((assigned) => assigned.id)).toEqual([tag.id]);
  });

  it('edit replaces existing tag assignments with the submitted set', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Edit Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Edit Beta' });
    const gamma = app.locals.tagService.createTag({ name: 'Edit Gamma' });
    const createRes = await agent
      .post('/projects')
      .send('title=Tag+Edit')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    app.locals.projectTagService.replaceProjectTags(id, [alpha.id, beta.id]);
    const routeLevelReplace = vi.spyOn(app.locals.projectTagService, 'replaceProjectTags');

    try {
      await agent
        .post(createRes.headers.location)
        .send('title=Tag+Edit')
        .send('status=tbd')
        .send(`tagIds[]=${beta.id}`)
        .send(`tagIds[]=${gamma.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      expect(routeLevelReplace).not.toHaveBeenCalled();
      const assigned = app.locals.projectTagService.listProjectTags(id).map((tag) => tag.id);
      expect(assigned).toHaveLength(2);
      expect(assigned).not.toContain(alpha.id);
      expect(assigned).toContain(beta.id);
      expect(assigned).toContain(gamma.id);
    } finally {
      routeLevelReplace.mockRestore();
    }
  });

  it('edit with no tags clears existing assignments', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Edit Clear' });
    const createRes = await agent
      .post('/projects')
      .send('title=Tag+Clear')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    app.locals.projectTagService.replaceProjectTags(id, [alpha.id]);

    await agent
      .post(createRes.headers.location)
      .send('title=Tag+Clear')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const assigned = app.locals.projectTagService.listProjectTags(id);
    expect(assigned).toHaveLength(0);
  });

  it('rejects malformed edit tag IDs before calling the update service or mutating project state', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Malformed Edit Tag' });
    const createRes = await agent
      .post('/projects')
      .send('title=Malformed+Tag+Edit')
      .send('status=tbd')
      .send(`tagIds[]=${tag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    const update = vi.spyOn(app.locals.projectService, 'update');

    try {
      const res = await agent
        .post(createRes.headers.location)
        .send('title=Submitted+Malformed+Edit')
        .send('status=planned')
        .send('description=Submitted+malformed+description')
        .send('tagIds[]=01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(update).not.toHaveBeenCalled();
      expect(res.headers.location).toBeUndefined();

      const project = db.prepare('SELECT title, description, status FROM projects WHERE id = ?').get(id);
      expect(project).toEqual({
        title: 'Malformed Tag Edit',
        description: '',
        status: 'tbd',
      });
      expect(app.locals.projectTagService.listProjectTags(id).map((assigned) => assigned.id))
        .toEqual([tag.id]);

      const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
      expect(dialog).toMatch(/name="title"[^>]*value="Submitted Malformed Edit"/);
      expect(dialog).toMatch(/<textarea id="description"[^>]*>Submitted malformed description<\/textarea>/);
      expectProjectFormStatusDisclosure(dialog, 'planned');
      const tagsField = extractProjectFormTagsField(dialog);
      expect(dialog).toContain('Tag selections must contain canonical positive integer IDs.');
      expect(dialog).toContain('id="tagIds-error"');
      expect(tagsField).toContain('aria-describedby="tagIds-error"');
      expectProjectFormStructure(dialog, { tagError: true });
    } finally {
      update.mockRestore();
    }
  });

  it('rolls back project fields and tags when a tag is deleted after edit pre-validation', async () => {
    const originalTag = app.locals.tagService.createTag({ name: 'Race Edit Original' });
    const staleTag = app.locals.tagService.createTag({ name: 'Race Edit Stale' });
    const retainedTag = app.locals.tagService.createTag({ name: 'Race Edit Retained' });
    const createRes = await agent
      .post('/projects')
      .send('title=Race+Tag+Edit')
      .send('status=tbd')
      .send(`tagIds[]=${originalTag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    const listTags = vi.spyOn(app.locals.tagService, 'listTags');
    const deleteTag = vi.spyOn(app.locals.tagService, 'deleteTag');
    const originalUpdate = app.locals.projectService.update.bind(app.locals.projectService);
    const update = vi.spyOn(app.locals.projectService, 'update');

    update.mockImplementation((projectId, input, options) => {
      app.locals.tagService.deleteTag(staleTag.id);
      return originalUpdate(projectId, input, options);
    });

    try {
      const res = await agent
        .post(createRes.headers.location)
        .send('title=Race+Tag+Edit')
        .send('status=planned')
        .send('projectType=comic')
        .send(`tagIds[]=${staleTag.id}`)
        .send(`tagIds[]=${retainedTag.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      expect(update).toHaveBeenCalledTimes(1);
      expect(listTags.mock.results[0].value).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: staleTag.id }),
      ]));
      expect(listTags.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
      expect(deleteTag.mock.invocationCallOrder[0]).toBeGreaterThan(update.mock.invocationCallOrder[0]);
      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('One or more selected tags no longer exists. Refresh and try again.');

      const project = db.prepare('SELECT title, status, project_type FROM projects WHERE id = ?').get(id);
      expect(project).toEqual({
        title: 'Race Tag Edit',
        status: 'tbd',
        project_type: 'images',
      });
      expect(app.locals.projectTagService.listProjectTags(id).map((assigned) => assigned.id))
        .toEqual([originalTag.id]);

      const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
      expectProjectFormStatusDisclosure(dialog, 'planned');
      const tagsField = extractProjectFormTagsField(dialog);
      expect(tagsField).toMatch(new RegExp(`value="${retainedTag.id}"[^>]*checked`));
      expect(dialog).toContain('id="tagIds-error"');
      expect(tagsField).toContain('aria-describedby="tagIds-error"');
      expectProjectFormStructure(dialog, { tagError: true });
    } finally {
      update.mockRestore();
      deleteTag.mockRestore();
      listTags.mockRestore();
    }
  });

  it('edit with a stale deleted tag returns 422 without mutating the project or its tags', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Stale Edit Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Stale Edit Beta' });
    const gamma = app.locals.tagService.createTag({ name: 'Stale Edit Gamma' });

    const createRes = await agent
      .post('/projects')
      .send('title=Stale+Tag+Edit')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    app.locals.projectTagService.replaceProjectTags(id, [alpha.id, beta.id]);

    app.locals.tagService.deleteTag(alpha.id);

    const res = await agent
      .post(createRes.headers.location)
      .send('title=Stale+Tag+Edit+Modified')
      .send('status=planned')
      .send(`tagIds[]=${alpha.id}`)
      .send(`tagIds[]=${gamma.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('One or more selected tags no longer exists. Refresh and try again.');

    const project = db.prepare('SELECT title, status FROM projects WHERE id = ?').get(id);
    expect(project.title).toBe('Stale Tag Edit');
    expect(project.status).toBe('tbd');
    expect(res.text).not.toMatch(/\b(?:id|name)="(?:plannedDate|publishedDate)"/);

    const rawAssigned = db.prepare('SELECT tag_id FROM project_tags WHERE project_id = ? ORDER BY tag_id').all(id).map((row) => row.tag_id);
    expect(rawAssigned).toEqual([beta.id]);

    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).toMatch(new RegExp(`value="${gamma.id}"[^>]*checked`));
    expect(tagsField).toContain('Stale Edit Gamma');
    expect(tagsField).toContain('2 tags selected');
    expect(tagsField).toContain('field-error');
    expect(tagsField).toMatch(/<input[^>]*name="tagIds\[\]"[^>]*aria-describedby="tagIds-error"[^>]*aria-invalid="true"/);
    expect(tagsField).toMatch(/<summary[^>]*aria-describedby="tagIds-error"[^>]*aria-invalid="true"/);
    expect(res.text).toContain('class="field-error-message" id="tagIds-error"');
  });

  it.each([
    ['status', { status: 'archived', projectType: 'images' }, 'status-error'],
    ['Project Type', { status: 'tbd', projectType: 'not-a-project-type' }, 'projectType-error'],
  ])('rejects an invalid update %s without mutation', async (_field, invalidValues, errorId) => {
    const createRes = await agent
      .post('/projects')
      .send('title=Update+Archive')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    const before = app.locals.projectService.findById(id);
    const res = await agent
      .post(createRes.headers.location)
      .type('form')
      .send({
        title: 'Rejected update mutation attempt',
        description: 'Rejected description',
        notes: 'Rejected notes',
        ...invalidValues,
        _csrf: csrfToken,
      })
      .expect(422);

    const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(dialog).toContain(`id="${errorId}"`);
    expect(app.locals.projectService.findById(id)).toEqual(before);
  });

  it('rerenders a blank title with scoped submitted values and no mutation', async () => {
    const persistedTag = app.locals.tagService.createTag({ name: 'Persisted Edit Tag' });
    const submittedTag = app.locals.tagService.createTag({ name: 'Submitted Edit Tag' });
    const createRes = await agent
      .post('/projects')
      .send('title=Persisted+Edit+Values')
      .send('description=Persisted+description')
      .send('notes=Persisted+notes')
      .send('status=tbd')
      .send('patreonUrl=https://example.com/initial')
      .send(`tagIds[]=${persistedTag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    const before = app.locals.projectService.findById(id);

    const res = await agent
      .post(createRes.headers.location)
      .send('title=')
      .send('description=Submitted+description')
      .send('notes=Submitted+notes')
      .send('status=in-progress')
      .send('projectType=comic')
      .send('patreonUrl=https://example.com/submitted')
      .send(`tagIds[]=${submittedTag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(dialog).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
    expect(dialog).toMatch(/<form id="project-edit-form"/);
    expect(dialog).toContain('Title is required.');
    expect(dialog).toContain('id="title-error"');
    expect(dialog).toMatch(/name="title"[^>]*value=""[^>]*aria-describedby="title-error"[^>]*aria-invalid="true"/);
    expect(dialog).toMatch(/<textarea id="description"[^>]*>Submitted description<\/textarea>/);
    expect(dialog).toMatch(/<textarea id="notes"[^>]*>Submitted notes<\/textarea>/);
    expectProjectFormStatusDisclosure(dialog, 'in-progress');
    expect(dialog).toMatch(/name="projectType"[^>]*value="comic"[^>]*checked/);
    expect(dialog).toContain('value="https://example.com/submitted"');

    const tagsField = extractProjectFormTagsField(dialog);
    expect(tagsField).toMatch(new RegExp(`value="${submittedTag.id}"[^>]*checked`));
    expect(tagsField).not.toMatch(new RegExp(`value="${persistedTag.id}"[^>]*checked`));
    expect(app.locals.projectService.findById(id)).toEqual(before);
    expect(app.locals.projectTagService.listProjectTags(id).map((assigned) => assigned.id)).toEqual([persistedTag.id]);
  });

  it('invalid edit submission preserves selected tag IDs in the form model', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Preserve Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Preserve Beta' });
    const createRes = await agent
      .post('/projects')
      .send('title=Preserve+Tags')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(createRes.headers.location)
      .send('title=Preserve+Tags')
      .send('status=tbd')
      .send('patreonUrl=not-a-url')
      .send(`tagIds[]=${alpha.id}`)
      .send(`tagIds[]=${beta.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).toMatch(new RegExp(`value="${alpha.id}"[^\u003e]*checked`));
    expect(tagsField).toMatch(new RegExp(`value="${beta.id}"[^\u003e]*checked`));
    expect(tagsField).toContain('2 tags selected');
  });

  it.each(['/projects/9999', '/projects/abc'])('returns 404 for an unavailable project detail route (%s)', async (url) => {
    await agent.get(url).expect(404);
  });

  it('archives the requested project, hands it to the service, and redirects to the archived list', async () => {
    const id = await createProject({ title: 'Archive Route Project' });
    const archive = vi.spyOn(app.locals.projectService, 'archive');

    try {
      const res = await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(archive).toHaveBeenCalledWith(id);
      expect(res.headers.location).toBe('/projects');
      expect(db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(id))
        .toMatchObject({ status: 'archived' });

      const archivedList = await agent.get('/projects?status=archived').expect(200);
      expect(extractProjectCard(archivedList.text, id)).toContain('Archive Route Project');
    } finally {
      archive.mockRestore();
    }
  });

  it('keeps an already archived project archived and returns a safe failure', async () => {
    const id = await createProject({ title: 'Already Archived Route Project' });
    await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

    const res = await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(500);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('Something went wrong.');
    expect(res.text).not.toContain('already archived');
    expect(db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(id))
      .toMatchObject({ status: 'archived' });
  });

  it.each([
    ['archive', 'archive', undefined],
    ['archive', 'archive', 'invalid-token'],
    ['delete', 'deleteProject', undefined],
    ['delete', 'deleteProject', 'invalid-token'],
  ])('rejects %s without a valid CSRF token (%s) before service handoff', async (action, serviceMethod, token) => {
    const id = await createProject({ title: `CSRF ${action} project ${token || 'missing'}` });
    const service = vi.spyOn(app.locals.projectService, serviceMethod);
    let request = agent.post(`/projects/${id}/${action}`).type('form');
    if (token !== undefined) request = request.send({ _csrf: token });

    try {
      await request.expect(403);
      expect(service).not.toHaveBeenCalled();
      expect(db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(id))
        .toMatchObject({ status: 'tbd', archived_at: null });
    } finally {
      service.mockRestore();
    }
  });

  it.each([
    ['archive', 'archive'],
    ['delete', 'deleteProject'],
  ])('rejects a malformed project ID on %s before service handoff', async (action, serviceMethod) => {
    const service = vi.spyOn(app.locals.projectService, serviceMethod);

    try {
      await agent.post(`/projects/not-a-project/${action}`).type('form').send({ _csrf: csrfToken }).expect(404);
      expect(service).not.toHaveBeenCalled();
    } finally {
      service.mockRestore();
    }
  });

  it.each([
    ['archive', 'archive'],
    ['delete', 'deleteProject'],
  ])('returns 404 for an unknown project on %s after lookup handoff', async (action, serviceMethod) => {
    const service = vi.spyOn(app.locals.projectService, serviceMethod);

    try {
      await agent.post(`/projects/999999/${action}`).type('form').send({ _csrf: csrfToken }).expect(404);
      expect(service).toHaveBeenCalledWith(999999);
    } finally {
      service.mockRestore();
    }
  });

  it.each([
    ['archive', 'archive'],
    ['delete', 'deleteProject'],
  ])('returns a safe failure without mutation when %s throws', async (action, serviceMethod) => {
    const id = await createProject({ title: `Failed ${action} route` });
    const service = vi.spyOn(app.locals.projectService, serviceMethod).mockImplementationOnce(() => {
      throw new Error('C:\\private\\destructive-operation-detail');
    });

    try {
      const res = await agent.post(`/projects/${id}/${action}`).type('form').send({ _csrf: csrfToken }).expect(500);
      expect(service).toHaveBeenCalledWith(id);
      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('Something went wrong.');
      expect(res.text).not.toContain('private\\destructive-operation-detail');
      expect(db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(id))
        .toMatchObject({ status: 'tbd', archived_at: null });
    } finally {
      service.mockRestore();
    }
  });

  it('deletes an active project through the requested service handoff and PRG', async () => {
    const id = await createProject({ title: 'Delete Active Route Project' });
    const deleteProject = vi.spyOn(app.locals.projectService, 'deleteProject');

    try {
      const res = await agent.post(`/projects/${id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(deleteProject).toHaveBeenCalledWith(id);
      expect(res.headers.location).toBe('/projects');
      await agent.get(`/projects/${id}`).expect(404);
    } finally {
      deleteProject.mockRestore();
    }
  });

  it('allows direct deletion of an archived project', async () => {
    const id = await createProject({ title: 'Delete Archived Route Project' });
    await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

    const res = await agent.post(`/projects/${id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
    expect(res.headers.location).toBe('/projects');
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(id)).toBeUndefined();
  });

  it('rejects a direct update to an archived project without allowing the service to mutate it', async () => {
    const id = await createProject({ title: 'Archived Direct Update Project' });
    await agent.post(`/projects/${id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
    const before = db.prepare('SELECT title, status, archived_at FROM projects WHERE id = ?').get(id);
    const update = vi.spyOn(app.locals.projectService, 'update');

    try {
      await agent
        .post(`/projects/${id}`)
        .type('form')
        .send({ title: 'Attempted archived update', status: 'tbd', projectType: 'images', _csrf: csrfToken })
        .expect(422);

      expect(update).toHaveBeenCalledWith(id, expect.objectContaining({ title: 'Attempted archived update' }), expect.any(Object));
      expect(db.prepare('SELECT title, status, archived_at FROM projects WHERE id = ?').get(id)).toEqual(before);
    } finally {
      update.mockRestore();
    }
  });








  it('unknown routes still return safe 404', async () => {
    const res = await agent.get('/not-a-real-route').expect(404);
    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('at ');
  });

  // ─── Filesystem creation flow ────────────────────────────────────────

  describe('HTTP filesystem creation', () => {
    it('creates a persisted Project root and manifest through POST /projects', async () => {
      const res = await agent
        .post('/projects')
        .send('title=HTTP+FS+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const [, projectId] = res.headers.location.match(/^\/projects\/(\d+)$/) || [];
      expect(projectId).toBeDefined();
      const project = db.prepare('SELECT id, title, project_dir FROM projects WHERE id = ?')
        .get(Number(projectId));
      expect(project).toEqual({
        id: Number(projectId),
        title: 'HTTP FS Test',
        project_dir: formatProjectDirName(Number(projectId), 'http-fs-test'),
      });

      const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.statSync(projectDir).isDirectory()).toBe(true);
      const manifest = readManifestSync(projectDir);
      expect(manifest).toMatchObject({ id: project.id, title: project.title });
    });

    it('maps a manifest-stage failure safely and leaves no durable Project state', async () => {
      const originalRenameSync = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (path.basename(destination) === MANIFEST_FILENAME) {
          throw new Error(`private filesystem detail: ${projectsRoot}`);
        }
        return originalRenameSync(source, destination);
      });

      let res;
      try {
        res = await agent
          .post('/projects')
          .send('title=HTTP+FS+Rollback')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(500);
      } finally {
        renameSpy.mockRestore();
      }

      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('Project creation failed. Please try again.');
      expect(res.text).not.toContain(projectsRoot);
      expect(res.text).not.toContain('private filesystem detail');
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_categories').get().count).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_browser_preferences').get().count).toBe(0);
      expect(fs.readdirSync(projectsRoot).filter((entry) => entry.endsWith('-http-fs-rollback')))
        .toEqual([]);
    });
  });

  // ─── Filesystem update flow ────────────────────────────────────────

  describe('HTTP filesystem update', () => {
    it('moves the Project root and refreshes its manifest through POST /projects/:id', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Old+HTTP+Filesystem+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const id = Number(location.replace('/projects/', ''));
      const before = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      const oldDir = resolveProjectDir(projectsRoot, before.project_dir);
      const marker = path.join(oldDir, 'route-marker.txt');
      fs.writeFileSync(marker, 'survived');

      const res = await agent
        .post(location)
        .send('title=Renamed+HTTP+Filesystem+Project')
        .send('description=Updated+through+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      expect(res.headers.location).toBe(location);

      const after = db.prepare('SELECT id, title, description, project_dir FROM projects WHERE id = ?').get(id);
      const newDir = resolveProjectDir(projectsRoot, after.project_dir);
      expect(after).toMatchObject({
        id,
        title: 'Renamed HTTP Filesystem Project',
        description: 'Updated through HTTP',
        project_dir: formatProjectDirName(id, 'renamed-http-filesystem-project'),
      });
      expect(fs.existsSync(oldDir)).toBe(false);
      expect(fs.existsSync(newDir)).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'route-marker.txt'), 'utf8')).toBe('survived');
      expect(readManifestSync(newDir)).toMatchObject({
        id,
        title: after.title,
        description: after.description,
      });
    });

    it('compensates a manifest-stage failure and renders a safe update error', async () => {
      const originalTag = app.locals.tagService.createTag({ name: 'HTTP rollback original tag' });
      const replacementTag = app.locals.tagService.createTag({ name: 'HTTP rollback replacement tag' });
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Filesystem+Rollback')
        .send('status=tbd')
        .send('priority=normal')
        .send(`tagIds[]=${originalTag.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const id = Number(location.replace('/projects/', ''));
      const before = db.prepare('SELECT title, description, status, project_dir FROM projects WHERE id = ?').get(id);
      const originalDir = resolveProjectDir(projectsRoot, before.project_dir);
      const attemptedDir = resolveProjectDir(
        projectsRoot,
        formatProjectDirName(id, 'renamed-http-filesystem-rollback'),
      );
      const marker = path.join(originalDir, 'rollback-marker.txt');
      fs.writeFileSync(marker, 'original content');

      const originalRenameSync = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (path.basename(destination) === MANIFEST_FILENAME) {
          throw new Error(`private filesystem detail: ${projectsRoot}`);
        }
        return originalRenameSync(source, destination);
      });

      let res;
      try {
        res = await agent
          .post(location)
          .send('title=Renamed+HTTP+Filesystem+Rollback')
          .send('description=Must+roll+back')
          .send('status=ready')
          .send('priority=normal')
          .send(`tagIds[]=${replacementTag.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(500);
      } finally {
        renameSpy.mockRestore();
      }

      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('Project update failed. Please try again.');
      expect(res.text).not.toContain(projectsRoot);
      expect(res.text).not.toContain('private filesystem detail');
      expect(db.prepare('SELECT title, description, status, project_dir FROM projects WHERE id = ?').get(id))
        .toEqual(before);
      expect(db.prepare('SELECT tag_id FROM project_tags WHERE project_id = ? ORDER BY tag_id').all(id))
        .toEqual([{ tag_id: originalTag.id }]);
      expect(fs.existsSync(originalDir)).toBe(true);
      expect(fs.readFileSync(marker, 'utf8')).toBe('original content');
      expect(fs.existsSync(attemptedDir)).toBe(false);
    });
  });

  // ─── Filesystem deletion flow ───────────────────────────────────────

  describe('HTTP filesystem deletion', () => {
    it('removes the real project root and preserves unrelated filesystem data through POST /delete', async () => {
      const id = await createProject({ title: 'HTTP Filesystem Delete' });
      const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
      const unrelatedDir = path.join(projectsRoot, 'unrelated-project-data');
      const unrelatedMarker = path.join(unrelatedDir, 'marker.txt');
      fs.writeFileSync(path.join(projectDir, 'owned-marker.txt'), 'owned');
      fs.mkdirSync(unrelatedDir);
      fs.writeFileSync(unrelatedMarker, 'unrelated');

      const res = await agent
        .post(`/projects/${id}/delete`)
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(302);

      expect(res.headers.location).toBe('/projects');
      expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(id)).toBeUndefined();
      expect(fs.existsSync(projectDir)).toBe(false);
      expect(fs.readFileSync(unrelatedMarker, 'utf8')).toBe('unrelated');
      await agent.get(`/projects/${id}`).expect(404);
    });

    it('reports a safe recovery error after staged deletion cleanup fails', async () => {
      const id = await createProject({ title: 'HTTP Delete Cleanup Failure' });
      const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
      const originalRmSync = fs.rmSync;
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        if (String(target).includes('.cc-quarantine-')) {
          throw new Error(`private filesystem detail: ${projectsRoot}`);
        }
        return originalRmSync(target, options);
      });

      let res;
      try {
        res = await agent
          .post(`/projects/${id}/delete`)
          .type('form')
          .send({ _csrf: csrfToken })
          .expect(500);
      } finally {
        rmSpy.mockRestore();
      }

      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('Something went wrong.');
      expect(res.text).not.toContain(projectsRoot);
      expect(res.text).not.toContain('private filesystem detail');
      expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(id)).toBeUndefined();
      expect(fs.existsSync(projectDir)).toBe(false);
      const quarantine = fs.readdirSync(projectsRoot)
        .filter((entry) => entry.startsWith('.cc-quarantine-'));
      expect(quarantine).toHaveLength(1);
      expect(fs.existsSync(path.join(projectsRoot, quarantine[0], 'project.json'))).toBe(true);
    });
  });

  describe('project link and detail rendering', () => {
    /**
     * Extract the HTML of the .field container that contains an input with the
     * given id. Returns null if not found.
     */
    function getFieldContainer(html, inputId) {
      // Find the input with the given id, then walk backward to find the .field ancestor
      const inputRe = new RegExp(`<input[^>]*id="${inputId}"[^>]*>`);
      const inputMatch = inputRe.exec(html);
      if (!inputMatch) return null;
      const inputPos = inputMatch.index;
      // Walk backward from the input to find the opening <div class="field ...">
      const beforeInput = html.slice(0, inputPos);
      const fieldStart = beforeInput.lastIndexOf('<div class="field');
      if (fieldStart === -1) return null;
      // Find the matching closing </div> — count nesting
      const fromField = html.slice(fieldStart);
      let depth = 0;
      let endPos = 0;
      for (let i = 0; i < fromField.length; i++) {
        if (fromField.slice(i, i + 4) === '<div') { depth++; i += 3; }
        else if (fromField.slice(i, i + 5) === '</div') { depth--; i += 4; }
        if (depth === 0) { endPos = i + 6; break; }
      }
      return fromField.slice(0, endPos);
    }

    it('project form shows generic project-link help text in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'patreonUrl');
      expect(container).not.toBeNull();
      expect(container).toContain('<label for="patreonUrl">Project link</label>');
      expect(container).toContain('Optional absolute HTTP or HTTPS URL for this project.');
      expect(container).toMatch(/<input[^>]*id="patreonUrl"[^>]*>/);
    });

    it('active project detail renders the intended project, external link, and resolved primary image', async () => {
      await createProject({ title: 'Other Detail Project' });
      const createRes = await agent
        .post('/projects')
        .send('title=Detail+Integration')
        .send('status=tbd')
        .send('priority=normal')
        .send('description=Project+description')
        .send('patreonUrl=https://patreon.com/test')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const asset = seedPrimaryImage(Number(id));

      const res = await agent.get(`/projects/${id}`).expect(200);
      const details = extractProjectDetailSection(res.text, 'project-detail-info');
      const hero = extractProjectDetailSection(res.text, 'project-detail-hero');

      expect(res.text).toContain('<h1 class="app-section-title">Projects — Detail Integration</h1>');
      expect(res.text).not.toContain('Projects — Other Detail Project</h1>');
      expect(details).toContain('<dd class="description">Project description</dd>');
      expect(details).toMatch(/<a\b[^>]*href="https:\/\/patreon\.com\/test"[^>]*target="_blank"[^>]*rel="noopener"[^>]*>Project link<\/a>/);
      expect(hero).toContain('data-preview-image');
      expect(hero).toContain(`src="/projects/${id}/assets/${asset.id}/preview?v=${buildAssetRevisionToken(asset)}"`);
      expect(hero).toContain('alt="Preview of cover.png"');
    });

    it('active project detail renders optional-field and primary-image absence states', async () => {
      const id = await createProject({ title: 'Optional Detail Fields Empty' });

      const res = await agent.get(`/projects/${id}`).expect(200);
      const details = extractProjectDetailSection(res.text, 'project-detail-info');
      const hero = extractProjectDetailSection(res.text, 'project-detail-hero');

      expect(details).toMatch(/<dt>Description<\/dt>\s*<dd class="description">—<\/dd>/);
      expect(details).not.toContain('project-detail-link');
      expect(hero).toContain('data-primary-image-state="none"');
      expect(hero).toContain(`href="/projects/${id}/assets"`);
    });

    it('project detail keeps associated Release planned and published dates visible', async () => {
      const id = await createProject({ title: 'Release Scheduling Boundary' });
      db.prepare("INSERT INTO releases (project_id, title, planned_date) VALUES (?, 'Planned Release', '2026-11-10')")
        .run(id);
      db.prepare("INSERT INTO releases (project_id, title, published_date) VALUES (?, 'Published Release', '2026-11-20')")
        .run(id);

      const res = await agent.get(`/projects/${id}`).expect(200);
      const releases = extractProjectDetailSection(res.text, 'project-detail-releases');

      expect(releases).toMatch(/Planned Release[\s\S]*?· planned 2026-11-10/);
      expect(releases).toMatch(/Published Release[\s\S]*?· published 2026-11-20/);
    });

  });

  it('accepts live custom Status and Type filters and drops deleted or unknown values', async () => {
    const status = app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Awaiting Review',
      color: '#123456',
    });
    const projectType = app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Interactive Story',
      color: '#654321',
    });
    const deletedStatus = app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Temporary Filter',
      color: '#ABCDEF',
    });
    app.locals.projectOptionCatalogueService.deleteOption('status', deletedStatus.value);
    app.locals.projectOptionCatalogueService.reorderOptions('status', [
      status.value, 'tbd', 'planned', 'in-progress', 'ready', 'completed',
    ]);
    app.locals.projectOptionCatalogueService.reorderOptions('projectType', [
      projectType.value, 'images', 'comic', 'animation', 'wallpaper',
    ]);

    const customId = await createProject({
      title: 'Custom Catalogue Project',
      status: status.value,
      projectType: projectType.value,
    });
    const ordinaryId = await createProject({ title: 'Ordinary Catalogue Project' });

    const filtered = await agent.get(
      `/projects?status=${status.value}&type=${projectType.value}&sort=title&order=asc&search=Catalogue`,
    ).expect(200);
    expect(filtered.text).toContain(`data-project-card-link href="/projects/${customId}"`);
    expect(filtered.text).not.toContain(`data-project-card-link href="/projects/${ordinaryId}"`);
    const statusFilter = extractStatusFilter(filtered.text);
    const projectTypeFilter = extractProjectTypeFilter(filtered.text);
    expect(statusFilter).toContain('Awaiting Review');
    expect(statusFilter.indexOf(`value="${status.value}"`)).toBeLessThan(statusFilter.indexOf('value="tbd"'));
    expect(statusFilter.indexOf('value="completed"')).toBeLessThan(statusFilter.indexOf('value="archived"'));
    expect(statusFilter).toContain('Archived');
    expect(app.locals.projectOptionCatalogueService.getStatusCatalogue().map(({ value }) => value))
      .not.toContain('archived');
    expect(projectTypeFilter).toContain('Interactive Story');
    expect(projectTypeFilter.indexOf(`value="${projectType.value}"`)).toBeLessThan(projectTypeFilter.indexOf('value="images"'));

    const all = await agent.get('/projects?sort=title&order=asc').expect(200);
    expect(extractStatusFilter(all.text)).toContain('All active');
    expect(extractProjectTypeFilter(all.text)).toContain('All types');

    const stale = await agent.get(
      `/projects?status=${deletedStatus.value}&type=unknown-type&sort=title&order=asc`,
    ).expect(200);
    expect(stale.text).toContain(`data-project-card-link href="/projects/${customId}"`);
    expect(stale.text).toContain(`data-project-card-link href="/projects/${ordinaryId}"`);
    expect(stale.text).not.toContain(`status=${deletedStatus.value}`);
    expect(stale.text).not.toContain('type=unknown-type');
  });

  it('project detail renders the selected custom Status and Type', async () => {
    const status = app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Awaiting Review', color: '#123456',
    });
    const projectType = app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Interactive Story (Web)', color: '#654321',
    });
    const selectedId = await createProject({
      title: 'Selected Custom Options', status: status.value, projectType: projectType.value,
    });
    const otherId = await createProject({ title: 'Other Project' });

    const selected = extractProjectDetailSection(
      (await agent.get(`/projects/${selectedId}`).expect(200)).text, 'project-detail-hero',
    );
    const other = extractProjectDetailSection(
      (await agent.get(`/projects/${otherId}`).expect(200)).text, 'project-detail-hero',
    );
    expect(selected).toMatch(/project-status-badge[^>]*>Awaiting Review<\/span>/);
    expect(selected).toMatch(/project-type-badge[^>]*>Interactive Story \(Web\)<\/span>/);
    expect(other).not.toContain('Awaiting Review');
    expect(other).not.toContain('Interactive Story (Web)');
  });

  it('project detail renders each release with its own thumbnail resource', async () => {
    const projectId = await createProject({ title: 'Release Thumbnail Project' });
    const assetRepository = createAssetRepository(db);
    const releaseRepository = createReleaseRepository(db);
    const firstAsset = assetRepository.upsert(projectId, 'first.png', {
      filename: 'first.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 1024, modifiedAt: '2026-08-06 12:00:00',
    });
    const secondAsset = assetRepository.upsert(projectId, 'second.png', {
      filename: 'second.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 2048, modifiedAt: '2026-08-06 12:00:00',
    });
    const overflowAssets = Array.from({ length: 12 }, (_, index) => assetRepository.upsert(
      projectId, `overflow-${index}.png`, {
        filename: `overflow-${index}.png`, extension: 'png', mimeType: 'image/png',
        sizeBytes: 3072 + index, modifiedAt: '2026-08-06 12:00:00',
      },
    ));
    const createRelease = (title) => releaseRepository.create({
      projectId,
      title,
      description: '',
      notes: '',
      plannedDate: null,
      plannedTime: null,
      patreonUrl: null,
      publishedDate: null,
    });
    const firstRelease = createRelease('First Thumbnail Release');
    const secondRelease = createRelease('Second Thumbnail Release');
    const emptyRelease = createRelease('Empty Thumbnail Release');
    releaseRepository.addReleaseAsset(firstRelease.id, firstAsset.id, 'attachment', 0);
    releaseRepository.addReleaseAsset(secondRelease.id, secondAsset.id, 'attachment', 0);
    overflowAssets.forEach((asset, index) => {
      releaseRepository.addReleaseAsset(firstRelease.id, asset.id, 'attachment', index + 1);
    });

    const res = await agent.get(`/projects/${projectId}`).expect(200);
    const releases = extractProjectDetailSection(res.text, 'project-detail-releases');
    const releaseList = extractReleaseList(releases);
    const firstItem = extractReleaseItem(releaseList, firstRelease.id);
    const secondItem = extractReleaseItem(releaseList, secondRelease.id);
    const emptyItem = extractReleaseItem(releaseList, emptyRelease.id);
    expect(firstItem).not.toBe('');
    expect(secondItem).not.toBe('');
    expect(emptyItem).not.toBe('');
    expect(firstItem).toContain(`<a href="/releases/${firstRelease.id}">First Thumbnail Release</a>`);
    expect(secondItem).toContain(`<a href="/releases/${secondRelease.id}">Second Thumbnail Release</a>`);
    expect(firstItem).toContain(`href="/projects/${projectId}/assets/${firstAsset.id}"`);
    expect(firstItem).toContain(
      `src="/projects/${projectId}/assets/${firstAsset.id}/thumbnail?v=${buildAssetRevisionToken(firstAsset)}"`,
    );
    expect(secondItem).toContain(`href="/projects/${projectId}/assets/${secondAsset.id}"`);
    expect(secondItem).toContain(
      `src="/projects/${projectId}/assets/${secondAsset.id}/thumbnail?v=${buildAssetRevisionToken(secondAsset)}"`,
    );
    expect(firstItem).not.toContain(`/assets/${secondAsset.id}/thumbnail`);
    expect(secondItem).not.toContain(`/assets/${firstAsset.id}/thumbnail`);
    expect(firstItem).not.toContain(`/assets/${overflowAssets.at(-1).id}/thumbnail`);
    expect(firstItem).toContain(`href="/releases/${firstRelease.id}">+1 more</a>`);
    expect(emptyItem).not.toContain('release-thumbnail-link');
  });

  // ─── Phase 7D-3: Project status preserves filesystem behavior ──────
  // --- Phase 7D-3: Project status never affects filesystem layout ------
  //
  // Project status is database/UI metadata only. Status changes must never
  // move, rename, or inspect the flat project directory.

  describe('project status filesystem behavior', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title) {
      const slug = parseSlug(title);
      const entries = fs.readdirSync(projectsRoot);
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, matching[0]);
    }

    it('changing project status does not move the flat directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=FS+Status+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Capture the persisted project row
      const beforeRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
      expect(beforeRow).not.toBeNull();
      expect(beforeRow.status).toBe('tbd');

      // Resolve the original path directly from beforeRow.project_dir
      expect(beforeRow.project_dir).toBeTruthy();
      const originalRelPath = beforeRow.project_dir;
      const originalDir = path.resolve(projectsRoot, originalRelPath);

      // Flat contract: the stored path is the bare directory name
      expect(originalRelPath).toMatch(/^000001-fs-status-test$/);

      // Assert the resolved directory is a direct child of PROJECTS_ROOT
      expect(path.dirname(originalDir)).toBe(path.resolve(projectsRoot));
      expect(fs.existsSync(originalDir)).toBe(true);
      expect(fs.statSync(originalDir).isDirectory()).toBe(true);

      // Place a distinctive file inside it
      const userFile = path.join(originalDir, 'status-move.txt');
      fs.writeFileSync(userFile, 'moved content');

      // Change status from tbd to planned
      await agent
        .post(`/projects/${id}`)
        .send('title=FS+Status+Test')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Status is DB-only; project_dir is unchanged
      const afterRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
      expect(afterRow.status).toBe('planned');
      expect(afterRow.project_dir).toBe(originalRelPath);

      // The directory still exists at the same flat location with its contents
      expect(fs.existsSync(originalDir)).toBe(true);
      expect(fs.statSync(originalDir).isDirectory()).toBe(true);
      expect(fs.existsSync(userFile)).toBe(true);
      expect(fs.readFileSync(userFile, 'utf8')).toBe('moved content');
      // No status directory was created
      expect(fs.existsSync(path.join(projectsRoot, 'planned'))).toBe(false);
    });
  });

  describe('archived project detail behavior', () => {
    it('renders the requested archived project as read-only', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Requested+Archived+Detail')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      const toolbar = extractProjectDetailActionToolbar(res.text);
      expect(res.text).toContain('<title>CreatorCrate — Projects — Requested Archived Detail</title>');
      expect(res.text).toContain('This project is archived and read-only.');
      expect(toolbar).toContain(`href="/projects/${id}/assets" aria-label="View Assets"`);
      expect(toolbar).not.toContain(`href="/projects/${id}/edit"`);
      expect(res.text).not.toContain('id="project-edit-dialog"');
      expect(res.text).not.toContain(`/releases/new?projectId=${id}`);
      expect(res.text).not.toContain(`/projects/${id}/archive"`);
      expect(res.text).not.toContain(`/projects/${id}/asset-categories`);
    });
  });

  describe('archived project detail path', () => {
    it('shows the archived project directory as a relative path', async () => {
      const id = await createProject({ title: 'Archived Detail Path' });
      const otherId = await createProject({ title: 'Other Detail Path' });
      const projectDir = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id).project_dir;
      const otherDir = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(otherId).project_dir;
      await agent.post(`/projects/${id}/archive`).send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      const details = extractProjectDetailSection(res.text, 'project-detail-info');
      expect(details).toContain(`<code>${projectDir}</code>`);
      expect(details).not.toContain(`<code>${otherDir}</code>`);
      expect(details).not.toContain(projectsRoot);
    });
  });

  describe('open locally action on project detail', () => {
    async function createDetailProject(title) {
      const id = await createProject({ title });
      return id;
    }

    function configureWindowsRoot() {
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('open_locally.windows_projects_path', 'D:\\example');
    }

    it('renders the Open locally action in the project summary toolbar when configured', async () => {
      const id = await createDetailProject('Open Locally Test');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(row.project_dir).toBeTruthy();
      const actions = extractProjectDetailActionToolbar(res.text);
      expect(actions).toContain('aria-label="Edit project"');
      expect(actions).toContain('aria-label="View Assets"');
      expect(actions).toContain('aria-label="Open locally"');
      expect(actions).toContain(
        `href="creatorcrate-open://open?v=2&amp;path=${encodeURIComponent(`D:\\example\\${row.project_dir}`)}&amp;select=0"`
      );
    });

    it('keeps View Assets and configured Open locally for archived projects without Edit', async () => {
      const id = await createDetailProject('Archived Open Locally Test');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      const toolbar = extractProjectDetailActionToolbar(res.text);

      expect(toolbar).toContain(`href="/projects/${id}/assets"`);
      expect(toolbar).toContain('aria-label="View Assets"');
      expect(toolbar).toContain('aria-label="Open locally"');
      expect(toolbar).toContain(
        `href="creatorcrate-open://open?v=2&amp;path=${encodeURIComponent(`D:\\example\\${row.project_dir}`)}&amp;select=0"`
      );
      expect(toolbar).not.toContain('aria-label="Edit project"');
      expect(toolbar).not.toContain(`href="/projects/${id}/edit"`);
    });

    it('omits the action from the project summary toolbar when no windows root is configured', async () => {
      const id = await createDetailProject('Open Locally No Root Configured');

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(extractProjectDetailActionToolbar(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });

    it('omits Open locally for an archived project without a directory', async () => {
      const id = await createDetailProject('Archived Open Locally Missing Dir');
      configureWindowsRoot();
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(id);
      await agent.post(`/projects/${id}/archive`).send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(extractProjectDetailActionToolbar(res.text)).not.toContain('aria-label="Open locally"');
      expect(extractProjectDetailSection(res.text, 'project-detail-info')).not.toContain('Project directory');
    });

    it('omits the action from the project summary toolbar when project_dir is invalid', async () => {
      const id = await createDetailProject('Open Locally Invalid Dir');
      configureWindowsRoot();
      db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run('../escape', id);

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(extractProjectDetailActionToolbar(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });
  });

  describe('archived project edit guard', () => {
    it('treats a legacy status-only archived project as read-only on detail and edit navigation', async () => {
      const id = await createProject({ title: 'Legacy Status Only Archived' });
      db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(id);

      const detail = await agent.get(`/projects/${id}?edit=1`).expect(200);
      expect(detail.text).toContain('This project is archived and read-only.');
      expect(extractProjectDetailActionToolbar(detail.text)).not.toContain(`href="/projects/${id}/edit"`);
      expect(detail.text).not.toContain('id="project-edit-dialog"');
      expect(detail.text).not.toContain(`/releases/new?projectId=${id}`);

      await agent.get(`/projects/${id}/edit`)
        .expect(302)
        .expect('Location', `/projects/${id}`);
    });

    it('GET /projects/:id/edit redirects to the detail page when the project is archived', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Edit+Redirect+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // The edit form must not be reachable — the route must redirect to the
      // detail page (the read-only workspace) rather than rendering the
      // editable form.
      const res = await agent.get(`/projects/${id}/edit`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/projects/${id}`);
    });

    it('GET /projects/:id/edit redirects active projects to the initially open dialog', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Edit+Active+Allowed')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}/edit`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/projects/${id}?edit=1`);
    });

    it('GET /projects/:id/edit still 404s for non-existent projects (regression)', async () => {
      // The redirect must not hide the 404 path for missing projects.
      await agent.get('/projects/9999/edit').expect(404);
    });
  });

  describe('project list empty state', () => {
    it('renders the first-project action when there are no Projects', async () => {
      const res = await agent.get('/projects').expect(200);
      const emptyState = res.text.match(/<div class="empty-state">[\s\S]*?<\/div>/)?.[0] || '';

      expect(extractProjectCards(res.text)).toHaveLength(0);
      expect(emptyState).toContain('<h2 class="empty-state-heading">No projects yet</h2>');
      expect(emptyState).toContain('href="/projects/new"');
      expect(emptyState).toContain('data-dialog-open="project-create-dialog"');
    });
  });
});
