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
import { NSFW_FILTER_ENABLED_KEY } from '../src/services/nsfw-filter-settings-service.js';
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

  it('project list renders with application fallbacks and no canonical redirect when defaults are absent', async () => {
    const res = await agent.get('/projects').expect(200);
    expect(res.text).toContain('Projects');
    expect(res.text).toContain('No projects yet');
    expect(res.text).not.toContain('<input type="hidden" name="view"');
    expect(res.text).toContain('href="/projects?view=list"');
    expectProjectSortOrderSelection(res.text, 'created', 'desc');
    expect(extractStatusFilter(res.text)).toContain('aria-label="Status filter: All active"');
    expect(extractProjectTypeFilter(res.text)).toContain('aria-label="Project Type filter: All types"');
    expect(extractTagFilter(res.text)).toContain('aria-label="Tag filter: All tags"');
    expect(extractTagFilter(res.text)).toContain('No tags available');
    expect(extractProjectFilter(res.text)).toContain('aria-label="Project filter: All projects"');
    expect(extractProjectFilter(res.text)).toMatch(/No matching projects|No projects available/);
  });

  it('requests grid information only when the resolved Projects view is grid', async () => {
    await createProject({ title: 'Resolved View Project' });
    const capture = (url) => capturePreparedSql(db, () => agent.get(url).expect(200));
    const assetBatchCount = (statements) => statements.filter((sql) => (
      sql.includes('COUNT(assets.id) AS asset_count')
    )).length;
    const releaseBatchCount = (statements) => statements.filter((sql) => (
      sql.includes('ROW_NUMBER() OVER') && sql.includes('recent_rank <= 5')
    )).length;

    const fallbackGrid = await capture('/projects');
    expect(assetBatchCount(fallbackGrid)).toBe(1);
    expect(releaseBatchCount(fallbackGrid)).toBe(1);

    const normalizedGrid = await capture('/projects?view=invalid');
    expect(assetBatchCount(normalizedGrid)).toBe(1);
    expect(releaseBatchCount(normalizedGrid)).toBe(1);

    const explicitList = await capture('/projects?view=list');
    expect(assetBatchCount(explicitList)).toBe(0);
    expect(releaseBatchCount(explicitList)).toBe(0);

    saveProjectDefault('view', 'list');
    const savedList = await capture('/projects?view=list');
    expect(assetBatchCount(savedList)).toBe(0);
    expect(releaseBatchCount(savedList)).toBe(0);

    const explicitGridOverSavedList = await capture('/projects?view=grid');
    expect(assetBatchCount(explicitGridOverSavedList)).toBe(1);
    expect(releaseBatchCount(explicitGridOverSavedList)).toBe(1);
  });

  it('renders Projects Filter, Defaults, and the NSFW toggle with Reset inside Filter', async () => {
    const projectTag = app.locals.tagService.createTag({ name: 'Projects Defaults Tag' });
    const response = await agent.get('/projects').expect(200);
    const filterActions = response.text.match(/<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?<\/div>/)?.[0] || '';
    const filterLink = filterActions.match(/<a class="[^"]*\bproject-filter-control\b[^"]*"[\s\S]*?data-dialog-open="projects-filter-dialog"[\s\S]*?<\/a>/)?.[0];
    const defaultsLink = filterActions.match(/<a class="[^"]*\basset-viewer-defaults-link\b[^"]*"[\s\S]*?<\/a>/)?.[0];
    const nsfwForm = filterActions.match(/<form method="post" action="\/projects\/nsfw-filter"[\s\S]*?<\/form>/)?.[0];

    expect(filterLink).toBeDefined();
    expect(defaultsLink).toBeDefined();
    expect(nsfwForm).toBeDefined();
    expect(filterActions.indexOf('data-dialog-open="projects-filter-dialog"')).toBeLessThan(filterActions.indexOf('asset-viewer-defaults-link'));
    expect(filterActions.indexOf('asset-viewer-defaults-link')).toBeLessThan(filterActions.indexOf('data-projects-nsfw-filter'));
    expect(defaultsLink).toContain('class="asset-viewer-defaults-link button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left"');
    expect(defaultsLink).toContain('href="/projects?defaults=1"');
    expect(defaultsLink).toContain('data-dialog-open="projects-defaults-dialog"');
    expect(defaultsLink).not.toContain('/settings/defaults#defaults-projects');
    expect(defaultsLink).toContain('aria-label="Projects defaults"');
    expect(defaultsLink).toContain('data-tooltip="Projects defaults"');
    expect(defaultsLink).not.toContain('title=');
    expect(defaultsLink).toContain('<svg');
    expect(nsfwForm).toContain('name="_csrf"');
    expect(nsfwForm).toContain('name="enabled" value="1"');
    expect(nsfwForm).toContain('aria-pressed="false"');
    expect(nsfwForm).toContain('aria-label="Enable NSFW filter"');
    expect(nsfwForm).toContain('data-tooltip="Enable NSFW filter"');
    expect(nsfwForm).not.toContain('title=');
    expect(nsfwForm).toContain('project-filter-control asset-tooltip asset-tooltip--left');
    expect(nsfwForm).toMatch(/<button[^>]*>\s*<svg[\s\S]*<\/svg>\s*<\/button>/);
    expect(filterActions).not.toContain('aria-label="Reset filters"');
    expect(filterActions).not.toContain('data-projects-reset');
    expect(filterActions.match(/project-filter-control/g)).toHaveLength(3);
    expect(filterActions.match(/asset-tooltip--left/g)).toHaveLength(3);
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

  it('renders the persisted enabled NSFW state accessibly', async () => {
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const response = await agent.get('/projects').expect(200);
    const nsfwForm = response.text.match(/<form method="post" action="\/projects\/nsfw-filter"[\s\S]*?<\/form>/)?.[0] || '';

    expect(nsfwForm).toContain('name="enabled" value="0"');
    expect(nsfwForm).toContain('aria-pressed="true"');
    expect(nsfwForm).toContain('aria-label="Disable NSFW filter"');
    expect(nsfwForm).toContain('data-tooltip="Disable NSFW filter"');
    expect(nsfwForm).not.toContain('title=');
  });

  it('protects the Projects NSFW mutation with CSRF and persists the shared setting', async () => {
    await agent
      .post('/projects/nsfw-filter')
      .set('Accept', 'application/json')
      .type('form')
      .send({ enabled: '1' })
      .expect(403);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(NSFW_FILTER_ENABLED_KEY)).toBeUndefined();

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
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(NSFW_FILTER_ENABLED_KEY)).toBe('1');
    expect((await agent.get('/projects')).text).toContain('aria-pressed="true"');
    expect((await agent.get('/settings/nsfw-filter')).text).toContain('id="nsfw-filter-enabled"');
    expect((await agent.get('/settings/nsfw-filter')).text.match(/id="nsfw-filter-enabled"[^>]*checked/)).not.toBeNull();

    await agent
      .post('/projects/nsfw-filter')
      .set('Accept', 'application/json')
      .type('form')
      .send({ enabled: '0', _csrf: csrfToken })
      .expect(200);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(NSFW_FILTER_ENABLED_KEY)).toBe('0');

    await agent
      .post('/settings/nsfw-filter')
      .type('form')
      .send({ enabled: '1', _csrf: csrfToken })
      .expect(302);
    expect((await agent.get('/projects')).text).toContain('aria-pressed="true"');

    await agent
      .post('/settings/nsfw-filter')
      .type('form')
      .send({ enabled: '0', _csrf: csrfToken })
      .expect(302);
    expect((await agent.get('/projects')).text).toContain('aria-pressed="false"');
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

  it('returns the Dashboard NSFW toggle to the exact root URL', async () => {
    const response = await agent
      .post('/projects/nsfw-filter')
      .type('form')
      .send({ enabled: '1', returnTo: '/', _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe('/');
  });

  it.each([
    ['//example.com', 'protocol-relative external URL'],
    ['https://example.com', 'absolute external URL'],
    ['/assets', 'unrelated application path'],
    ['/\\example.com', 'backslash path-confusion URL'],
    ['///example.com', 'malformed protocol-relative URL'],
  ])('falls back to /projects for unsafe NSFW return URL: %s (%s)', async (returnTo) => {
    const response = await agent
      .post('/projects/nsfw-filter')
      .type('form')
      .send({ enabled: '1', returnTo, _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe('/projects');
  });

  it('loads persisted Projects defaults in the dialog rather than active query values', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const response = await agent.get('/projects?view=grid&sort=updated&order=desc&defaults=1').expect(200);
    const dialog = response.text.match(/<dialog id="projects-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

    expect(dialog).toMatch(/name="view"[^>]*>[\s\S]*?value="list" selected/);
    expect(dialog).toMatch(/name="sort"[^>]*>[\s\S]*?value="title" selected/);
    expect(dialog).toMatch(/name="order"[^>]*>[\s\S]*?value="asc" selected/);
    expect(dialog).toMatch(/name="status"[^>]*>[\s\S]*?value="all" selected/);
    expect(dialog).toMatch(/name="projectType"[^>]*>[\s\S]*?value="all" selected/);
    expect(dialog).toMatch(/name="tag"[^>]*>[\s\S]*?value="all" selected/);
  });

  it('saves all Projects defaults atomically through the enhanced JSON contract', async () => {
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

    expect(response.body).toEqual({
      status: 'success',
      message: 'Projects defaults saved successfully.',
      values: {
        view: 'list',
        sort: 'updated',
        order: 'asc',
        status: 'archived',
        projectType: 'comic',
        tag: 'all',
      },
    });
    expect(app.locals.pageDefaultsService.resolvePageDefaults('projects')).toEqual({
      view: 'list',
      sort: 'updated',
      order: 'asc',
      status: 'archived',
      projectType: 'comic',
      tag: 'all',
    });
  });

  it('accepts a live Tag default and rejects a stale Tag without partial persistence', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Live Projects Default Tag' });
    const accepted = await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({
        view: 'grid',
        sort: 'created',
        order: 'desc',
        status: 'all',
        projectType: 'all',
        tag: String(tag.id),
        _csrf: csrfToken,
      })
      .expect(200);

    expect(accepted.body.values.tag).toBe(String(tag.id));
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(
      PAGE_DEFAULT_DEFINITIONS.projects.tag.key,
    )).toBe(String(tag.id));

    const stale = await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({
        view: 'list',
        sort: 'title',
        order: 'asc',
        status: 'ready',
        projectType: 'comic',
        tag: String(tag.id + 1),
        _csrf: csrfToken,
      })
      .expect(422);

    expect(stale.body.errors.tag).toContain(String(tag.id + 1));
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(
      PAGE_DEFAULT_DEFINITIONS.projects.tag.key,
    )).toBe(String(tag.id));
  });

  it('rejects invalid Projects defaults without partially saving', async () => {
    saveProjectDefault('view', 'grid');
    saveProjectDefault('sort', 'created');
    saveProjectDefault('order', 'desc');

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

    expect(response.body.status).toBe('error');
    expect(response.body.errors.sort).toContain('not-valid');
    expect(response.body.values).toEqual({
      view: 'list',
      sort: 'not-valid',
      order: 'asc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    });
    expect(app.locals.pageDefaultsService.resolvePageDefaults('projects')).toEqual({
      view: 'grid',
      sort: 'created',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    });
  });

  it('marks server-rendered submitted Projects default options for dialog cleanup', async () => {
    const response = await agent
      .post('/projects/defaults')
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
    const dialog = response.text.match(/<dialog id="projects-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    const temporaryOptions = dialog.match(/<option[^>]*data-dialog-submitted-value[^>]*>[\s\S]*?<\/option>/g) || [];

    expect(temporaryOptions).toHaveLength(1);
    expect(temporaryOptions[0]).toContain('value="not-valid"');
    expect(temporaryOptions[0]).toContain('selected');

    expect(dialog).toMatch(
      /<select id="projects-default-sort" name="sort"[^>]*data-cc-dropdown-native-select[^>]*aria-describedby="projects-default-sort-error"[^>]*aria-invalid(?:="true")?/,
    );
    expect(dialog).toMatch(
      /id="projects-default-sort-dropdown"[^>]*data-cc-dropdown data-cc-dropdown-mode="single"[\s\S]*?<summary[^>]*aria-describedby="projects-default-sort-error"[^>]*aria-invalid(?:="true")?/,
    );
    expect(dialog).toContain('class="asset-filter-multiselect-summary-current">Submitted value: not-valid</span>');
    expect(dialog).toMatch(
      /id="projects-default-sort-submitted"[^>]*value="not-valid"[^>]*checked[^>]*data-dialog-submitted-value/,
    );
    expect(dialog).toContain('id="projects-default-sort-error"');
    expect(dialog).toMatch(/class="field app-dialog-field field-error" data-dialog-field="sort"/);
    expect(dialog).not.toMatch(/<input[^>]*name="sort"/);
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

    const css = await fetchProjectCss(app);
    expect(css).not.toMatch(/#project-filters\s+\.field\s+select\s*\{/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-panel\s*\{[^}]*max-height:\s*20rem/);
    expect(css).toMatch(/\.project-filter-actions--projects\s*\{[^}]*top:\s*var\(--space-xs\)[^}]*z-index:\s*70/);
    expect(css).toMatch(/\.asset-viewer-filters\s*\{[^}]*z-index:\s*20/);
    expect(css).toMatch(/--shell-z-overlay:\s*1200/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s*\{[^}]*z-index:\s*45/);
    expect(css).not.toMatch(/#project-filters\s*>\s*\.asset-viewer-project-filter\s*\{[^}]*z-index:\s*auto/);
    expect(css).toMatch(/\.project-filter-actions--projects \.project-filter-control\s*\{[^}]*min-block-size:\s*2\.25rem[^}]*min-inline-size:\s*2\.25rem/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list\s*\{[\s\S]*?scrollbar-color:\s*var\(--border-strong\)\s+transparent;[\s\S]*?scrollbar-width:\s*thin/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list::\-webkit-scrollbar\s*\{[^}]*width:\s*0\.5rem/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list::\-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list::\-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*var\(--border-strong\)[\s\S]*?border:\s*2px solid var\(--surface-card\)[\s\S]*?border-radius:\s*999px/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list::\-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--muted\)/);
    expect(css).not.toMatch(/#(?:project|asset)-project-filter\s+\.asset-project-filter-option-list/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-filter-multiselect-summary-current\s*\{[^}]*text-overflow:\s*ellipsis/);
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
      /<div class="asset-viewer-display-controls" data-project-grid-size-controls>\s*<nav class="view-switcher" aria-label="Project display">[\s\S]*?<\/nav>\s*<div class="asset-grid-size-controls asset-viewer-grid-size-controls" data-asset-grid-size-controls[\s\S]*?<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?data-projects-nsfw-filter/
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
      /<div class="asset-viewer-display-controls">\s*<nav class="view-switcher" aria-label="Project display">[\s\S]*?<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?data-projects-nsfw-filter/
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
    writeStoredProjectDefault('view', 'board');
    writeStoredProjectDefault('sort', 'bogus');
    writeStoredProjectDefault('order', 'forwards');

    const res = await agent.get('/projects').expect(200);
    expect(res.text).not.toContain('<input type="hidden" name="view"');
    expect(res.text).toContain('href="/projects?view=list"');
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

  it('uses all for a stale saved Tag without rewriting its stored value', async () => {
    writeStoredProjectDefault('tag', '999999');

    const res = await agent.get('/projects').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(extractTagFilter(res.text)).toContain('aria-label="Tag filter: All tags"');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(
      PAGE_DEFAULT_DEFINITIONS.projects.tag.key,
    )).toBe('999999');
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

  it('blurs only NSFW-tagged project primary images across project surfaces when enabled', async () => {
    const nsfwTag = app.locals.tagService.createTag({ name: 'NSFW' });
    const nsfwProjectId = await createProject({ title: 'NSFW Project', status: 'ready' });
    const safeProjectId = await createProject({ title: 'Safe Project', status: 'ready' });
    seedPrimaryImage(nsfwProjectId);
    seedPrimaryImage(safeProjectId, 'safe.png');
    app.locals.projectTagService.replaceProjectTags(nsfwProjectId, [nsfwTag.id]);
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const css = await fetchProjectCss(app);
    expect(css).toContain('.project-image--nsfw-blurred');
    expect(css).toContain('filter: blur(2rem)');
    expect(css).toContain('clip-path: inset(0)');
    expect(css).not.toContain('.project-card-media--nsfw-clipped');
    expect(css).toMatch(/\.project-image--nsfw-blurred\s*\{[\s\S]*?filter:\s*blur\(2rem\)[\s\S]*?clip-path:\s*inset\(0\)/);
    const hasCardLevelBlur = /\.project-card(?:--grid|--list)?\s*\{[^}]*filter:\s*blur\(2rem\)/.test(css)
      || /\.project-grid-card-preview\s*\{[^}]*filter:\s*blur\(2rem\)/.test(css)
      || /\.project-list-card-media\s*\{[^}]*filter:\s*blur\(2rem\)/.test(css)
      || /\.project-detail-media\s*\{[^}]*filter:\s*blur\(2rem\)/.test(css)
      || /\.project-card-media\s*\{[^}]*filter:\s*blur\(2rem\)/.test(css);
    expect(hasCardLevelBlur).toBe(false);
    const hasNsfwSpecificWrapperClip = /\.project-card-media--nsfw-clipped/.test(css)
      || /\.project-grid-card-preview\.project-image--nsfw-blurred/.test(css)
      || /\.project-list-card-media\.project-image--nsfw-blurred/.test(css)
      || /\.project-detail-media\.project-image--nsfw-blurred/.test(css);
    expect(hasNsfwSpecificWrapperClip).toBe(false);
    expect(css).not.toMatch(/\.project-image--nsfw-blurred\s*\{[^}]*overflow:/);
    expect(css).toMatch(/\.project-detail-media\s*\{[^}]*overflow:\s*hidden/);

    const grid = await agent.get('/projects').expect(200);
    const nsfwGridCard = extractProjectCard(grid.text, nsfwProjectId);
    const safeGridCard = extractProjectCard(grid.text, safeProjectId);
    expect(nsfwGridCard).toMatch(/<img class="[^"]*project-image--nsfw-blurred[^"]*" data-preview-image/);
    expect(nsfwGridCard).not.toMatch(/<article[^>]*project-image--nsfw-blurred/);
    expect(nsfwGridCard).not.toMatch(/<div[^>]*project-image--nsfw-blurred/);
    expect(nsfwGridCard).not.toMatch(/class="[^"]*project-grid-card-preview[^"]*project-card-media--nsfw-clipped/);
    expect(nsfwGridCard).not.toMatch(/class="[^"]*project-card-media--nsfw-clipped/);
    expect(safeGridCard).not.toContain('project-image--nsfw-blurred');
    expect(safeGridCard).not.toContain('project-card-media--nsfw-clipped');
    expect(nsfwGridCard).toContain(`data-project-card-link href="/projects/${nsfwProjectId}"`);
    expect(nsfwGridCard).toContain('>Ready</span>');
    expect(nsfwGridCard).toContain('>NSFW</li>');

    const list = await agent.get('/projects?view=list').expect(200);
    const nsfwListCard = extractProjectCard(list.text, nsfwProjectId);
    const safeListCard = extractProjectCard(list.text, safeProjectId);
    expect(nsfwListCard).toMatch(/<img class="[^"]*project-image--nsfw-blurred[^"]*" data-preview-image/);
    expect(nsfwListCard).not.toMatch(/class="[^"]*project-list-card-media[^"]*project-card-media--nsfw-clipped/);
    expect(nsfwListCard).not.toMatch(/class="[^"]*project-card-media--nsfw-clipped/);
    expect(safeListCard).not.toContain('project-image--nsfw-blurred');
    expect(safeListCard).not.toContain('project-card-media--nsfw-clipped');
    expect(nsfwListCard).toContain(`data-project-card-link href="/projects/${nsfwProjectId}">NSFW Project</a>`);
    expect(nsfwListCard).toContain('<dt>Status</dt>');
    expect(nsfwListCard).toContain('>Ready</span>');
    expect(nsfwListCard).not.toMatch(/<div[^>]*project-image--nsfw-blurred/);

    const detail = await agent.get(`/projects/${nsfwProjectId}`).expect(200);
    expect(detail.text).toMatch(/<img class="project-detail-media-image project-image--nsfw-blurred" data-preview-image/);
    expect(detail.text).not.toMatch(/class="[^"]*project-detail-media[^"]*project-card-media--nsfw-clipped/);
    expect(detail.text).not.toMatch(/class="[^"]*project-card-media--nsfw-clipped/);
    expect(detail.text).toContain('NSFW Project');
    expect(detail.text).toContain('<li class="tag-chip">NSFW</li>');
    expect(detail.text).toContain('<section class="project-detail-info">');
    expect(detail.text).toContain(`href="/projects/${nsfwProjectId}/assets"`);
    expect(detail.text).not.toMatch(/<div[^>]*project-image--nsfw-blurred/);

    const safeDetail = await agent.get(`/projects/${safeProjectId}`).expect(200);
    expect(safeDetail.text).not.toContain('project-image--nsfw-blurred');
    expect(safeDetail.text).not.toContain('project-card-media--nsfw-clipped');
    expect(safeDetail.text).toContain('Safe Project');

    app.locals.nsfwFilterSettingsService.setEnabled(false);

    const disabledGrid = await agent.get('/projects').expect(200);
    const disabledGridCard = extractProjectCard(disabledGrid.text, nsfwProjectId);
    expect(disabledGridCard).not.toContain('project-image--nsfw-blurred');
    expect(disabledGridCard).not.toContain('project-card-media--nsfw-clipped');
    expect(disabledGridCard).toContain('<img');

    const disabledList = await agent.get('/projects?view=list').expect(200);
    const disabledListCard = extractProjectCard(disabledList.text, nsfwProjectId);
    expect(disabledListCard).not.toContain('project-image--nsfw-blurred');
    expect(disabledListCard).not.toContain('project-card-media--nsfw-clipped');
    expect(disabledListCard).toContain('<img');

    const disabledDetail = await agent.get(`/projects/${nsfwProjectId}`).expect(200);
    expect(disabledDetail.text).not.toContain('project-image--nsfw-blurred');
    expect(disabledDetail.text).not.toContain('project-card-media--nsfw-clipped');
    expect(disabledDetail.text).toContain('<img class="project-detail-media-image" data-preview-image');
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

    const list = await agent.get('/projects?view=list').expect(200);
    expect(extractProjectCard(list.text, projectId)).toMatch(
      /<img class="[^"]*project-image--nsfw-blurred[^"]*" data-preview-image/,
    );

    const detail = await agent.get(`/projects/${projectId}`).expect(200);
    expect(detail.text).toMatch(/<img class="project-detail-media-image project-image--nsfw-blurred" data-preview-image/);
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
    expect(css).toMatch(/\.project-image--nsfw-blurred\s*\{[\s\S]*?filter:\s*blur\(2rem\);[\s\S]*?clip-path:\s*inset\(0\);/);
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

  it('renders assigned project display names and the tag filter in grid and list views', async () => {
    const taggedProjectId = await createProject({ title: 'Assigned Tags Project' });
    const secondTaggedProjectId = await createProject({ title: 'Shared Tags Project' });
    const untaggedProjectId = await createProject({ title: 'No Assigned Tags Project' });
    const zebra = app.locals.tagService.createTag({ name: 'Zebra Display' });
    const shared = app.locals.tagService.createTag({ name: 'Shared Display' });
    const alpha = app.locals.tagService.createTag({ name: 'Alpha Display' });
    const assetOnly = app.locals.tagService.createTag({ name: 'Asset Only Display' });

    app.locals.projectTagService.replaceProjectTags(taggedProjectId, [zebra.id, shared.id, alpha.id]);
    app.locals.projectTagService.replaceProjectTags(secondTaggedProjectId, [shared.id]);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(taggedProjectId, 'source/asset-only.png', 'asset-only.png').lastInsertRowid);
    app.locals.assetTagService.replaceAssetTags(assetId, [assetOnly.id]);

    const grid = await agent.get('/projects?sort=title&order=asc').expect(200);
    const taggedGridCard = extractProjectCard(grid.text, taggedProjectId);
    const secondTaggedGridCard = extractProjectCard(grid.text, secondTaggedProjectId);
    const untaggedGridCard = extractProjectCard(grid.text, untaggedProjectId);
    const gridTags = extractProjectTags(taggedGridCard);

    expect(grid.text).toContain('<ul class="project-grid">');
    expect(gridTags).toContain('<span class="project-grid-card-info-section-label">Tags</span>');
    expect(gridTags.indexOf('Alpha Display')).toBeLessThan(gridTags.indexOf('Shared Display'));
    expect(gridTags.indexOf('Shared Display')).toBeLessThan(gridTags.indexOf('Zebra Display'));
    expect(gridTags).not.toContain('Asset Only Display');
    expect(gridTags).not.toContain('alpha display');
    expect(gridTags).not.toContain('normalized_name');
    expect(gridTags).not.toContain(`>${alpha.id}<`);
    expect(gridTags).not.toContain(`>${shared.id}<`);
    expect(gridTags).not.toContain(`>${zebra.id}<`);
    expect(gridTags).not.toContain('href=');
    expect(extractProjectTags(secondTaggedGridCard)).toContain('Shared Display');
    expect(extractProjectTags(untaggedGridCard)).toContain('No tags assigned');
    expect(grid.text).not.toContain('name="tagIds"');
    const gridTagFilter = extractTagFilter(grid.text);
    expect(gridTagFilter).toContain('aria-label="Tag filter: All tags"');
    expect(gridTagFilter.indexOf('Alpha Display')).toBeLessThan(gridTagFilter.indexOf('Asset Only Display'));
    expect(gridTagFilter.indexOf('Asset Only Display')).toBeLessThan(gridTagFilter.indexOf('Shared Display'));
    expect(gridTagFilter.indexOf('Shared Display')).toBeLessThan(gridTagFilter.indexOf('Zebra Display'));
    expect(gridTagFilter).not.toContain('normalized_name');
    expect(gridTagFilter).not.toContain('selected>Shared Display</option>');
    expect(grid.text).not.toContain('sort=tag');
    expect(grid.text).not.toContain('Tag sort');

    const list = await agent.get('/projects?sort=title&order=asc&view=list').expect(200);
    const taggedListCard = extractProjectCard(list.text, taggedProjectId);
    const secondTaggedListCard = extractProjectCard(list.text, secondTaggedProjectId);
    const untaggedListCard = extractProjectCard(list.text, untaggedProjectId);

    expect(list.text).toContain('<ul class="project-list">');
    const taggedListAssociations = taggedListCard.match(/<div class="project-list-card-associations">([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/)?.[1] || '';
    expect(taggedListAssociations).toContain('project-list-card-association--tags');
    expect(taggedListAssociations).toContain('Alpha Display');
    expect(taggedListAssociations).toContain('Shared Display');
    expect(taggedListAssociations).toContain('Zebra Display');
    const secondListAssociations = secondTaggedListCard.match(/<div class="project-list-card-associations">([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/)?.[1] || '';
    const untaggedListAssociations = untaggedListCard.match(/<div class="project-list-card-associations">([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/)?.[1] || '';
    expect(secondListAssociations).toContain('Shared Display');
    expect(untaggedListAssociations).toContain('No tags assigned');
  });

  it('filters projects by a valid tag ID, composes with search/status, and excludes asset-only assignments', async () => {
    const shared = app.locals.tagService.createTag({ name: 'Shared Filter Tag' });
    const additional = app.locals.tagService.createTag({ name: 'Additional Filter Tag' });
    const firstId = await createProject({ title: 'Filter Alpha', status: 'planned' });
    const secondId = await createProject({ title: 'Filter Beta', status: 'planned' });
    const multiAssignedId = await createProject({ title: 'Needle Planned', status: 'planned' });
    const wrongStatusId = await createProject({ title: 'Needle Ready', status: 'ready' });
    const otherTagId = await createProject({ title: 'Needle Other Tag', status: 'planned' });
    const assetOnlyId = await createProject({ title: 'Asset Only Filter', status: 'planned' });

    app.locals.projectTagService.replaceProjectTags(firstId, [shared.id]);
    app.locals.projectTagService.replaceProjectTags(secondId, [shared.id]);
    app.locals.projectTagService.replaceProjectTags(multiAssignedId, [shared.id, additional.id]);
    app.locals.projectTagService.replaceProjectTags(wrongStatusId, [shared.id]);
    app.locals.projectTagService.replaceProjectTags(otherTagId, [additional.id]);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(assetOnlyId, 'source/asset-only-filter.png', 'asset-only-filter.png').lastInsertRowid);
    app.locals.assetTagService.replaceAssetTags(assetId, [shared.id]);

    const filtered = await agent
      .get(`/projects?tag=${shared.id}&sort=title&order=asc`)
      .expect(200);
    expect(filtered.text).toContain('4 projects found');
    expect(filtered.text).toContain('Filter Alpha');
    expect(filtered.text).toContain('Filter Beta');
    expect(filtered.text).toContain('Needle Planned');
    expect(filtered.text).toContain('Needle Ready');
    expect(extractProjectCards(filtered.text).join('')).not.toContain('Needle Other Tag');
    expect(extractProjectCards(filtered.text).join('')).not.toContain('Asset Only Filter');
    expect(filtered.text.match(/<article\b[^>]*data-project-card[^>]*>/g)).toHaveLength(4);
    expect(extractTagFilter(filtered.text)).toContain(
      `value="${shared.id}" checked`,
    );

    const multiTag = await agent
      .get(`/projects?tag=${additional.id}&tag=${shared.id}&sort=title&order=asc`)
      .expect(200);
    expect(multiTag.text).toContain('5 projects found');
    expect(multiTag.text).toContain('Filter Alpha');
    expect(multiTag.text).toContain('Filter Beta');
    expect(multiTag.text).toContain('Needle Planned');
    expect(multiTag.text).toContain('Needle Ready');
    expect(multiTag.text).toContain('Needle Other Tag');
    expect(extractProjectCards(multiTag.text).join('')).not.toContain('Asset Only Filter');
    expect(extractTagFilter(multiTag.text)).toContain('aria-label="Tag filter: 2 tags selected"');
    expect((extractTagFilter(multiTag.text).match(/name="tag"[^>]+checked/g) || [])).toHaveLength(2);

    const composed = await agent
      .get(`/projects?tag=${shared.id}&status=planned&sort=title&order=asc&view=list`)
      .expect(200);
    expect(composed.text).toContain('3 projects found');
    expect(composed.text).toContain('Needle Planned');
    expect(composed.text).toContain('Needle Ready');
    expect(extractProjectCards(composed.text).join('')).not.toContain('Needle Other Tag');
    expect(composed.text).toContain('href="/projects"');

    await agent
      .post(`/projects/${wrongStatusId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const archived = await agent
      .get(`/projects?tag=${shared.id}&status=archived&sort=title&order=asc`)
      .expect(200);
    expect(archived.text).toContain('1 project found');
    expect(archived.text).toContain('Needle Ready');
    expect(extractProjectCards(archived.text).join('')).not.toContain('Needle Planned');
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

  it('filters projects by a valid project id, shows selected summary, and treats it as an active filter', async () => {
    const firstId = await createProject({ title: 'Project Filter Alpha', status: 'planned' });
    const secondId = await createProject({ title: 'Project Filter Beta', status: 'ready' });

    const filtered = await agent.get(`/projects?project=${firstId}`).expect(200);

    expect(filtered.text).toContain('1 project found');
    expect(filtered.text).toContain('Project Filter Alpha');
    expect(extractProjectCards(filtered.text).join('')).not.toContain('Project Filter Beta');
    expect(filtered.text).not.toContain('No projects yet');
    expect(filtered.text).toContain('href="/projects"');
    const projectFilter = extractProjectFilter(filtered.text);
    expect(projectFilter).toContain(`value="${firstId}" checked`);
    expect(projectFilter).toContain(`value="${secondId}"`);
    expect(projectFilter).toContain('Project Filter Alpha');
    expect(projectFilter).toContain('Project Filter Beta');
    expect(projectFilter).toContain('id="project-project-filter-trigger" aria-controls="project-project-filter-options"');
    expect(projectFilter).toContain('id="project-project-filter-search"');
    expect(projectFilter).toContain('id="project-project-option-all"');
    expect(projectFilter).toContain(`id="${firstId}" name="project" type="radio" value="${firstId}" checked`);
    expect(projectFilter).toContain('aria-label="Project filter: Project Filter Alpha"');
  });

  it('preserves the selected project id through generated pagination and view links', async () => {
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

  it('defaults to Created descending while explicit Updated remains available', async () => {
    const olderCreatedId = await createProject({ title: 'Older Created Project' });
    const newerCreatedId = await createProject({ title: 'Newer Created Project' });
    db.prepare("UPDATE projects SET created_at = '2026-01-01 00:00:00', updated_at = '2026-03-01 00:00:00' WHERE id = ?")
      .run(olderCreatedId);
    db.prepare("UPDATE projects SET created_at = '2026-02-01 00:00:00', updated_at = '2026-01-01 00:00:00' WHERE id = ?")
      .run(newerCreatedId);

    const created = await agent.get('/projects').expect(200);
    expectProjectSortOrderSelection(created.text, 'created', 'desc');
    expect(created.text.indexOf(`data-project-card-link href="/projects/${newerCreatedId}"`))
      .toBeLessThan(created.text.indexOf(`data-project-card-link href="/projects/${olderCreatedId}"`));

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

  it('preserves filters, pagination, and effective saved settings through canonical URLs and links', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const tag = app.locals.tagService.createTag({ name: 'Canonical Tag' });
    for (let i = 0; i < 26; i += 1) {
      const projectId = await createProject({ title: `Canonical Project ${String(i).padStart(2, '0')}`, status: 'planned' });
      app.locals.projectTagService.replaceProjectTags(projectId, [tag.id]);
    }

    const redirect = await agent
      .get(`/projects?status=planned&tag=${tag.id}&page=2&unknown=discarded`)
      .expect(302);
    expect(redirect.headers.location)
      .toBe(`/projects?status=planned&tag=${tag.id}&sort=title&order=asc&view=list&page=2`);

    const pageTwo = await agent.get(redirect.headers.location).expect(200);
    expect(pageTwo.text).toContain('<ul class="project-list">');
    expect(pageTwo.text).toContain('Canonical Project 25');
    expect(pageTwo.text).not.toContain('unknown=discarded');
    expect(pageTwo.text).toContain(
      `href="/projects?status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=1"`
    );

    const pageOne = await agent
      .get(`/projects?status=planned&tag=${tag.id}&sort=title&order=asc&view=list`)
      .expect(200);
    expect(pageOne.text).toContain(
      `href="/projects?status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=2"`
    );
    expect(pageOne.text).toContain(
      `href="/projects?status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=grid"`
    );
    expect(pageOne.text).toContain('<input type="hidden" name="view" value="list">');
    expectProjectSortOrderSelection(pageOne.text, 'title', 'asc');
    expect(pageOne.text).not.toContain('unknown=discarded');
  });

  it('preserves repeated status and tag selections through saved defaults, pagination, and view links', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const firstTag = app.locals.tagService.createTag({ name: 'Repeated First Tag' });
    const secondTag = app.locals.tagService.createTag({ name: 'Repeated Second Tag' });
    for (let i = 0; i < 26; i += 1) {
      const projectId = await createProject({
        title: `Repeated State ${String(i).padStart(2, '0')}`,
        status: i % 2 === 0 ? 'planned' : 'ready',
      });
      app.locals.projectTagService.replaceProjectTags(projectId, [firstTag.id, secondTag.id]);
    }

    const redirect = await agent
      .get(`/projects?status=ready&status=planned&tag=${secondTag.id}&tag=${firstTag.id}&page=2`)
      .expect(302);
    const canonical = `/projects?status=planned&status=ready&tag=${firstTag.id}&tag=${secondTag.id}&sort=title&order=asc&view=list&page=2`;
    expect(redirect.headers.location).toBe(canonical);

    const pageTwo = await agent.get(canonical).expect(200);
    expect(pageTwo.text).toContain('26 projects found');
    expect(pageTwo.text).toContain('name="view" value="list"');
    expect(pageTwo.text).toContain(
      `href="/projects?status=planned&amp;status=ready&amp;tag=${firstTag.id}&amp;tag=${secondTag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=1"`
    );
    expect(pageTwo.text).toContain(
      `href="/projects?status=planned&amp;status=ready&amp;tag=${firstTag.id}&amp;tag=${secondTag.id}&amp;sort=title&amp;order=asc&amp;view=grid&amp;page=2"`
    );
    expect(extractStatusFilter(pageTwo.text)).toContain('aria-label="Status filter: 2 statuses selected"');
    expect(extractTagFilter(pageTwo.text)).toContain('aria-label="Tag filter: 2 tags selected"');
    expect((extractStatusFilter(pageTwo.text).match(/name="status"[^>]+checked/g) || [])).toHaveLength(2);
    expect((extractTagFilter(pageTwo.text).match(/name="tag"[^>]+checked/g) || [])).toHaveLength(2);
  });

  it('preserves repeated Project Type selections through canonical pagination, view, sort, and order links', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    for (let i = 0; i < 26; i += 1) {
      await createProject({
        title: `Project Type State ${String(i).padStart(2, '0')}`,
        projectType: i % 2 === 0 ? 'images' : 'comic',
      });
    }

    const redirect = await agent.get('/projects?type=comic&type=images&page=2').expect(302);
    const canonical = '/projects?type=images&type=comic&sort=title&order=asc&view=list&page=2';
    expect(redirect.headers.location).toBe(canonical);

    const pageTwo = await agent.get(canonical).expect(200);
    expect(extractProjectTypeFilter(pageTwo.text)).toContain('aria-label="Project Type filter: 2 types selected"');
    expect(pageTwo.text).toContain('href="/projects?type=images&amp;type=comic&amp;sort=title&amp;order=asc&amp;view=grid&amp;page=2"');

    const pageOne = await agent.get('/projects?type=images&type=comic&sort=title&order=asc&view=list').expect(200);
    expect(pageOne.text).toContain('href="/projects?type=images&amp;type=comic&amp;sort=title&amp;order=asc&amp;view=list&amp;page=2"');
  });

  it('new-project form renders with available tags and no selected tags', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Form Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Form Beta' });

    const res = await agent.get('/projects/new').expect(200);
    expect(res.text).toContain('Create Project');
    expect(res.text).toContain('Title');
    expectProjectFormSectionCards(res.text);
    const statusField = expectProjectFormStatusDisclosure(res.text, 'tbd');
    expect(statusField).not.toContain('value="archived"');
    expect(statusField).not.toContain('aria-invalid');
    expect(statusField).not.toContain('aria-describedby');
    expect(statusField).not.toContain('status-error');
    expect(res.text).not.toContain('id="priority"');
    expect(res.text).not.toContain('name="priority"');

    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).not.toBe('');
    expect(tagsField).toContain('asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown');
    expect(tagsField).toContain('data-cc-dropdown data-cc-dropdown-mode="multiple"');
    expect(tagsField).not.toContain('data-asset-viewer-filter-disclosure');
    expect(tagsField).not.toContain('data-asset-viewer-filter-single-select');
    expect(tagsField).not.toContain('data-asset-viewer-filter-multi-select');
    expect(tagsField).toMatch(/id="project-tags-form-trigger"\s+aria-controls="project-tags-form-options"/);
    expect(tagsField).toContain('aria-label="Tags: No tags selected"');
    expect(tagsField).toContain('data-cc-dropdown-summary class="asset-filter-multiselect-summary"');
    expect(tagsField).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">No tags selected</span>');
    expect(tagsField).toContain('class="asset-filter-multiselect-panel" role="group" aria-label="Tag options"');
    expect(tagsField).toContain('name="tagIds[]"');
    expect(tagsField).toContain(`value="${alpha.id}"`);
    expect(tagsField).toContain(`value="${beta.id}"`);
    expect(tagsField).toContain('Form Alpha');
    expect(tagsField).toContain('Form Beta');
    expect(tagsField).toContain('type="checkbox"');
    expect(tagsField).not.toContain('required');
    expect(tagsField).not.toContain('aria-invalid');
    expect(tagsField).not.toContain('tagIds-error');
    expect(tagsField).not.toMatch(/<select[^>]*name="tagIds\[\]"/);
    expect(tagsField).not.toMatch(/<input[^>]*type="hidden"[^>]*name="tagIds\[\]"/);
    expect((tagsField.match(/name="tagIds\[\]"[^>]*checked/g) || [])).toHaveLength(0);
    expect((tagsField.match(/<input[^>]*name="tagIds\[\]"/g) || [])).toHaveLength(2);

    expect(res.text.indexOf('project-status-form-trigger'))
      .toBeLessThan(res.text.indexOf('project-tags-form-trigger'));
    expectProjectFormStructure(res.text);
  });

  it('new-project form renders an empty tag catalog with a Settings link', async () => {
    const res = await agent.get('/projects/new').expect(200);
    const tagsField = extractProjectFormTagsField(res.text);
    expectProjectFormStructure(res.text);
    expect(tagsField).toContain('data-cc-dropdown data-cc-dropdown-mode="multiple"');
    expect(tagsField).not.toContain('data-asset-viewer-filter-disclosure');
    expect(tagsField).not.toContain('data-asset-viewer-filter-multi-select');
    expect(tagsField).toContain('<p class="asset-filter-multiselect-empty">No tags available. <a href="/settings/tags">Add tags in Settings</a>.</p>');
    expect(tagsField).toContain('aria-label="Tags: No tags selected"');
    expect(res.text).toContain('<span class="help-text">Add new tags in <a href="/settings/tags">Settings › Tags</a>.</span>');
    expect((res.text.match(/href="\/settings\/tags"/g) || [])).toHaveLength(2);
    expect(tagsField.indexOf('No tags available')).toBeLessThan(tagsField.indexOf('Add tags in Settings'));
    expect(res.text.indexOf('project-tags-form-options')).toBeLessThan(res.text.indexOf('Add new tags in'));
  });

  it('project form places actions in the page heading and associates the submit button with the form', async () => {
    const create = await agent.get('/projects/new').expect(200);
    const createActions = extractPageHeadingActions(create.text);
    expect(createActions).toContain('<button class="button button-primary" type="submit" form="project-form">Create</button>');
    expect(createActions).toContain('<a class="button button-secondary" href="/projects">Cancel</a>');
    expect(create.text).toContain('<form id="project-form" method="post" action="/projects" class="project-form" novalidate>');
    expect(create.text.indexOf('<div class="page-heading-actions">')).toBeLessThan(create.text.indexOf('<form id="project-form"'));
    expect(create.text).not.toContain('<div class="form-actions">');
    expect(createActions).not.toContain('View assets');
    expect(create.text).not.toContain('Project actions');
    expect(create.text).not.toContain('project-edit-dialog');
    expect(create.text).not.toContain('data-dialog-open');
    expect(create.text).not.toContain('/archive');
    expect(create.text).not.toContain('/delete');
  });

  it('new-project form seeds the valid saved New Project status default', async () => {
    saveNewProjectDefault('status', 'ready');

    const res = await agent.get('/projects/new').expect(200);

    expectProjectFormStatusDisclosure(res.text, 'ready');
    expect(res.text).not.toContain('id="priority"');
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

    expectProjectFormStatusDisclosure(res.text, 'tbd');
    expect(res.text).not.toContain('id="priority"');
  });

  it('rejects creation when the stored status default is stale without rewriting it', async () => {
    writeStoredNewProjectDefault('status', 'archived');
    writeLegacyNewProjectPriority('urgent');

    const beforeCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    const res = await agent
      .post('/projects')
      .send('title=Stale+Status+Default')
      .send('projectType=images')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(beforeCount);
    expect(res.text).toContain(
      'The configured New Project Status default is missing or unavailable. Choose a valid default in Settings.'
    );
    expectProjectFormStatusDisclosure(res.text, null, { statusError: true });
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(
      PAGE_DEFAULT_DEFINITIONS.new_project.status.key,
    )).toBe('archived');
    expect(res.text).not.toContain('id="priority"');
  });

  it('rejected create submission preserves the submitted status over the saved default', async () => {
    saveNewProjectDefault('status', 'ready');

    const res = await agent
      .post('/projects')
      .send('title=')
      .send('status=in-progress')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expectProjectFormStatusDisclosure(res.text, 'in-progress');
    expect(res.text).not.toContain('id="priority"');
  });

  it('successful create uses the submitted status, not the saved default', async () => {
    saveNewProjectDefault('status', 'ready');

    const res = await agent
      .post('/projects')
      .send('title=Submitted+Wins')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(res.headers.location.replace('/projects/', ''));
    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(id);
    expect(project.status).toBe('planned');
  });

  it('edit dialog shows the stored project status even when the New Project default differs', async () => {
    saveNewProjectDefault('status', 'ready');
    const id = await createProject({ title: 'Editable', status: 'in-progress' });

    const res = await agent.get(`/projects/${id}?edit=1`).expect(200);

    expectProjectFormStatusDisclosure(res.text, 'in-progress');
    expect(res.text).not.toContain('id="priority"');
  });

  it('valid create request redirects to detail', async () => {
    const returnTo = '/projects?search=needle&sort=title&order=asc&page=3#projects-list';
    const res = await agent
      .post('/projects')
      .send('title=Test+Project')
      .send('description=A+test')
      .send('notes=notes')
      .send('status=tbd')
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toMatch(/^\/projects\/\d+$/);
  });

  it('create persists multiple selected tags and redirects to detail', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Create Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Create Beta' });

    const res = await agent
      .post('/projects')
      .send('title=Tagged+Create')
      .send('status=tbd')
      .send(`tagIds[]=${alpha.id}`)
      .send(`tagIds[]=${beta.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(res.headers.location.replace('/projects/', ''));
    const assigned = app.locals.projectTagService.listProjectTags(id).map((tag) => tag.id);
    expect(assigned).toHaveLength(2);
    expect(assigned).toContain(alpha.id);
    expect(assigned).toContain(beta.id);
  });

  it('create with no tags leaves no assignments', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Untagged+Create')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(res.headers.location.replace('/projects/', ''));
    const assigned = app.locals.projectTagService.listProjectTags(id);
    expect(assigned).toHaveLength(0);
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
    expect(tagsField).toContain('2 tags selected');
    expect(tagsField).toContain('field-error');
    expect(tagsField).toMatch(/<input[^>]*name="tagIds\[\]"[^>]*aria-describedby="tagIds-error"[^>]*aria-invalid="true"/);
    expect(tagsField).toMatch(/<summary[^>]*aria-describedby="tagIds-error"[^>]*aria-invalid="true"/);
    expect(res.text).toContain('class="field-error-message" id="tagIds-error"');
    expectProjectFormStructure(res.text, { tagError: true });
  });

  it('invalid create request rerenders with values and errors', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Create+Preserves')
      .send('description=A')
      .send('notes=Create+notes')
      .send('status=ready')
      .send('plannedDate=2026-08-01')
      .send('publishedDate=2026-08-15')
      .send('patreonUrl=example.com/not-patreon')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    expect(res.text).toContain('value="Create Preserves"');
    expect(res.text).toContain('A');
    expect(res.text).toContain('Create notes');
    expectProjectFormStatusDisclosure(res.text, 'ready');
    expect(res.text).not.toContain('id="priority"');
    expect(res.text).not.toMatch(/\b(?:id|name)="(?:plannedDate|publishedDate)"/);
    expect(res.text).toContain('value="example.com/not-patreon"');
    expect(res.text).toContain('Basic information');
    expect(res.text).toContain('>Status</h3>');
    expect(res.text).not.toContain('>Scheduling</h3>');
    expect(res.text).toContain('Links');
    expect(res.text).toContain('href="/projects"');
    expect(res.text).toContain('<form id="project-form" method="post" action="/projects" class="project-form" novalidate>');
    expect(res.text).not.toContain('id="project-create-dialog"');
  });

  it('validation failure from the Dashboard dialog rerenders the Dashboard with submitted dialog state', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Dashboard retry tag' });

    const res = await agent
      .post('/projects')
      .send('title=Dashboard+Preserves')
      .send('description=Dashboard+description')
      .send('status=in-progress')
      .send('patreonUrl=not-a-url')
      .send(`tagIds[]=${tag.id}`)
      .send('returnTo=/')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    const dialog = extractProjectCreateDialog(res.text);
    expect(res.text).toContain('Dashboard');
    expect(dialog).toMatch(/<dialog id="project-create-dialog"[^>]*\bopen\b/);
    expect(dialog).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    expect(dialog).toContain('value="Dashboard Preserves"');
    expect(dialog).toContain('Dashboard description');
    expect(dialog).toMatch(/name="status"[^>]*value="in-progress"[^>]*checked/);
    expect(dialog).toMatch(new RegExp(`name="tagIds\\[\\]"[^>]*value="${tag.id}"[^>]*checked`));
    expect(dialog).toContain('Dashboard retry tag');
    expect(dialog).toContain('name="returnTo" value="/"');
    expectProjectFormStructure(dialog);
  });

  it('validation failure from a filtered Projects dialog preserves the exact invocation URL and submitted state', async () => {
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
    expect(res.text).toContain('<form id="project-filters"');
    expect(dialog).toMatch(/<dialog id="project-create-dialog"[^>]*\bopen\b/);
    expect(dialog).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    expect(dialog).toContain('value="Projects Preserves"');
    expect(dialog).toMatch(/name="status"[^>]*value="planned"[^>]*checked/);
    expect(dialog).toMatch(new RegExp(`name="tagIds\\[\\]"[^>]*value="${tag.id}"[^>]*checked`));
    expect(dialog).toContain('Projects retry tag');
    expect(dialog).toContain('name="returnTo" value="/projects?search=needle&amp;status=planned&amp;sort=title&amp;order=asc&amp;view=list&amp;page=3#projects-list" data-dialog-return-location');
    expectProjectFormStructure(dialog);
  });

  it('validation failure preserves explicit All filters in generated Projects links', async () => {
    const savedTag = app.locals.tagService.createTag({ name: 'Saved default tag' });
    for (let i = 0; i < 26; i += 1) {
      await createProject({
        title: `Explicit All Recovery ${String(i).padStart(2, '0')}`,
        status: 'planned',
        projectType: 'images',
      });
    }
    saveProjectDefault('status', 'ready');
    saveProjectDefault('projectType', 'comic');
    writeStoredProjectDefault('tag', String(savedTag.id));
    const returnTo = '/projects?status=all&type=all&tag=all&page=2#projects-list';

    const res = await agent
      .post('/projects')
      .send('title=Explicit+All+Preserves')
      .send('status=planned')
      .send('patreonUrl=not-a-url')
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    const dialog = extractProjectCreateDialog(res.text);
    expect(dialog).toContain('name="returnTo" value="/projects?status=all&amp;type=all&amp;tag=all&amp;page=2#projects-list" data-dialog-return-location');
    expect(res.text).toContain('26 projects found');
    expect(res.text).toContain('Page 2 of 2');
    expect(res.text).toContain('href="/projects?status=all&amp;type=all&amp;tag=all&amp;page=2&amp;view=list"');
    expect(res.text).toContain('href="/projects?status=all&amp;type=all&amp;tag=all&amp;page=1"');
  });

  it.each([
    'https://evil.example/projects',
    '//evil.example/projects',
    '/projects/%',
    '/releases?sort=title',
  ])('does not trust an invalid Project create invocation returnTo on validation failure: %s', async (returnTo) => {
    const res = await agent
      .post('/projects')
      .send('title=Invalid+Host')
      .send('status=tbd')
      .send('patreonUrl=not-a-url')
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('<form id="project-form" method="post" action="/projects" class="project-form" novalidate>');
    expect(res.text).not.toContain('id="project-create-dialog"');
    expect(res.text).not.toContain(`name="returnTo" value="${returnTo}"`);
  });

  it('rejects archived status on create', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Direct+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Status must be one of');
    expect(res.text).toContain('Direct Archive');
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

  it('archived project detail keeps View Assets in the compact toolbar without Edit', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Archived+Detail+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const location = createRes.headers.location;

    await agent
      .post(`${location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent.get(location).expect(200);
    const headingActions = extractPageHeadingActions(res.text);
    const toolbar = extractProjectDetailActionToolbar(res.text);

    expect(headingActions).toBe('');
    expect(toolbar).toContain(`href="${location}/assets"`);
    expect(toolbar).toContain('aria-label="View Assets"');
    expect((toolbar.match(/<a\b/g) || [])).toHaveLength(1);
    expect(headingActions).not.toContain(`href="${location}/asset-categories"`);
    expect(toolbar).not.toContain(`href="${location}/edit"`);
    expect(toolbar).not.toContain('aria-label="Edit project"');
    expect(toolbar).not.toContain('aria-label="Open locally"');
    expect(res.text).not.toContain('Edit project');
    expect(res.text).not.toMatch(
      new RegExp(`<section class="workflow-actions">\\s*<a[^>]+href="${location}/assets"`),
    );
  });

  it('edit dialog renders from the normal project detail page', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Editable+Project')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent.get(`${createRes.headers.location}?edit=1`).expect(200);
    expect(res.text).toContain('Edit Project');
    expect(res.text).toContain('id="project-edit-dialog"');
    expect(res.text).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
    expect(res.text).toContain(`action="${createRes.headers.location}"`);
    expect(res.text).not.toContain('value="archived"');
    expect(res.text).not.toContain('id="priority"');
    expect(res.text).not.toContain('data-dialog-return-location');
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

  it('retains submitted values and invocation metadata after edit validation fails', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Invoked+Edit+Validation')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');
    const returnTo = `/projects/${id}/assets?view=list&page=3#asset-42`;

    const res = await agent
      .post(`/projects/${id}`)
      .type('form')
      .send({ title: 'Still Submitted', status: 'not-a-status', returnTo, _csrf: csrfToken })
      .expect(422);

    expect(res.text).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
    expect(res.text).toContain('value="Still Submitted"');
    expect(res.text).toContain(`name="returnTo" value="/projects/${id}/assets?view=list&amp;page=3#asset-42" data-dialog-return-location`);
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
      `//example.com/projects/${id}/assets`,
      `/projects/${otherId}/assets?view=list`,
      `/projects/${id}/assets/extra?view=list`,
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

  it('valid update redirects to detail', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Old+Name')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent
      .post(createRes.headers.location)
      .send('title=New+Name')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Name');
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

    await agent
      .post(createRes.headers.location)
      .send('title=Tag+Edit')
      .send('status=tbd')
      .send(`tagIds[]=${beta.id}`)
      .send(`tagIds[]=${gamma.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const assigned = app.locals.projectTagService.listProjectTags(id).map((tag) => tag.id);
    expect(assigned).toHaveLength(2);
    expect(assigned).not.toContain(alpha.id);
    expect(assigned).toContain(beta.id);
    expect(assigned).toContain(gamma.id);
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

  it('edit with a stale deleted tag returns 422 without mutating the project or its tags', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Stale Edit Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Stale Edit Beta' });
    const gamma = app.locals.tagService.createTag({ name: 'Stale Edit Gamma' });

    const createRes = await agent
      .post('/projects')
      .send('title=Stale+Tag+Edit')
      .send('status=tbd')
      .send('plannedDate=2026-08-01')
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
      .send('plannedDate=2026-09-01')
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

  it('rejects archived status on update', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Update+Archive')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent
      .post(createRes.headers.location)
      .send('title=Update+Archive')
      .send('status=archived')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Status must be one of');
  });

  it('keeps validation errors for archived projects on the read-only detail page', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Archived+Invalid+Edit')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const location = createRes.headers.location;

    await agent
      .post(`${location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(location)
      .send('title=Archived+Invalid+Edit')
      .send('status=not-a-status')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.status).toBe(422);
    expect(res.text).toContain('<section class="project-detail-hero">');
    expect(res.text).toContain('This project is archived and read-only.');
    expect(res.text).not.toContain('id="project-edit-dialog"');
    expect(res.text).not.toContain('data-dialog-open="project-edit-dialog"');
  });

  it('rejects published status and does not render it as a project choice', async () => {
    const form = await agent.get('/projects/new').expect(200);
    expect(form.text).not.toMatch(/<input[^>]*name="status"[^>]*value="published"/);

    const res = await agent
      .post('/projects')
      .send('title=Invalid+Published+Project')
      .send('status=published')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Status must be one of');
    const statusField = expectProjectFormStatusDisclosure(res.text, null);
    expect(statusField).not.toMatch(/<input[^>]*name="status"[^>]*value="published"/);
    expect(statusField).toContain('field-error');
    expect(statusField).toMatch(/<input[^>]*name="status"[^>]*aria-describedby="status-error"[^>]*aria-invalid="true"/);
    expect(statusField).toMatch(/<summary[^>]*aria-describedby="status-error"[^>]*aria-invalid="true"/);
    expect(statusField).toContain('aria-label="Status: "');
    expect(res.text).toContain('class="field-error-message" id="status-error"');
    expectProjectFormStructure(res.text, { statusError: true });
  });

  it('invalid edit request renders the detail page with an open dialog and submitted values', async () => {
    const persistedTag = app.locals.tagService.createTag({ name: 'Persisted Edit Tag' });
    const submittedTag = app.locals.tagService.createTag({ name: 'Submitted Edit Tag' });
    const createRes = await agent
      .post('/projects')
      .send('title=Persisted+Edit+Values')
      .send('description=Persisted+description')
      .send('notes=Persisted+notes')
      .send('status=tbd')
      .send('plannedDate=2026-01-01')
      .send('publishedDate=2026-01-15')
      .send('patreonUrl=https://example.com/initial')
      .send(`tagIds[]=${persistedTag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(createRes.headers.location)
      .send('title=Submitted+Edit+Values')
      .send('description=Submitted+description')
      .send('notes=Submitted+notes')
      .send('status=in-progress')
      .send('plannedDate=2026-10-01')
      .send('publishedDate=2026-10-15')
      .send('patreonUrl=not-a-url')
      .send(`tagIds[]=${submittedTag.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.status).toBe(422);
    expect(res.text).toContain('<section class="project-detail-hero">');
    expect(res.text).toContain('<h2>Releases</h2>');
    expect(res.text).toContain('<span class="count">0</span> Total assets');
    expect(res.text).toContain('Persisted Edit Tag');
    expect(res.text).not.toContain('<form id="project-form"');

    const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(dialog).not.toBe('');
    expect(dialog).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
    expect(dialog).toContain('<form id="project-edit-form"');
    expect(dialog).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    expect(dialog).toContain('id="patreonUrl-error"');
    expect(dialog).toMatch(/name="title"[^>]*value="Submitted Edit Values"/);
    expect(dialog).toMatch(/<textarea id="description"[^>]*>Submitted description<\/textarea>/);
    expect(dialog).toMatch(/<textarea id="notes"[^>]*>Submitted notes<\/textarea>/);
    expectProjectFormStatusDisclosure(dialog, 'in-progress');
    expectProjectFormStructure(dialog, { statusError: false });
    expect(res.text).not.toContain('id="priority"');
    expect(dialog).not.toMatch(/\b(?:id|name)="(?:plannedDate|publishedDate)"/);
    expect(dialog).toContain('value="not-a-url"');
    expect(dialog).toContain('Basic information');
    expect(dialog).toContain('>Status</h3>');
    expect(dialog).not.toContain('>Scheduling</h3>');
    expect(dialog).toContain('Links');

    const tagsField = extractProjectFormTagsField(dialog);
    expect(tagsField).toMatch(new RegExp(`value="${submittedTag.id}"[^>]*checked`));
    expect(tagsField).not.toMatch(new RegExp(`value="${persistedTag.id}"[^>]*checked`));
    expect(tagsField).toContain('Submitted Edit Tag');
    expect(tagsField).toContain('aria-label="Tags: Submitted Edit Tag"');
  });

  it('edit form checks currently assigned tags and renders the multi-tag summary', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Edit Render Alpha' });
    const beta = app.locals.tagService.createTag({ name: 'Edit Render Beta' });
    const gamma = app.locals.tagService.createTag({ name: 'Edit Render Gamma' });
    const createRes = await agent
      .post('/projects')
      .send('title=Edit+Render+Tags')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = Number(createRes.headers.location.replace('/projects/', ''));
    app.locals.projectTagService.replaceProjectTags(id, [alpha.id, beta.id]);

    const res = await agent.get(`${createRes.headers.location}?edit=1`).expect(200);
    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).toMatch(new RegExp(`value="${alpha.id}"[^>]*checked`));
    expect(tagsField).toMatch(new RegExp(`value="${beta.id}"[^>]*checked`));
    expect(tagsField).not.toMatch(new RegExp(`value="${gamma.id}"[^>]*checked`));
    expect(tagsField).toContain('class="asset-filter-multiselect-summary-current">2 tags selected</span>');
    expect(tagsField).toContain('aria-label="Tags: 2 tags selected"');
    expect(tagsField).toContain('Edit Render Alpha');
    expect(tagsField).toContain('Edit Render Beta');
    expect(tagsField).toContain('Edit Render Gamma');
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

  it('invalid create submission preserves selected tag IDs in the form model', async () => {
    const alpha = app.locals.tagService.createTag({ name: 'Create Preserve Alpha' });

    const res = await agent
      .post('/projects')
      .send('title=')
      .send('status=tbd')
      .send(`tagIds[]=${alpha.id}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('Title is required.');
    expect(res.text).toContain('id="project-form"');
    const tagsField = extractProjectFormTagsField(res.text);
    expect(tagsField).toMatch(new RegExp(`value="${alpha.id}"[^>]*checked`));
    expect(tagsField).toContain('Create Preserve Alpha');
    expect(tagsField).toContain('class="asset-filter-multiselect-summary-current">Create Preserve Alpha</span>');
    expect(tagsField).toContain('aria-label="Tags: Create Preserve Alpha"');
  });

  it('missing project returns 404', async () => {
    await agent.get('/projects/9999').expect(404);
  });

  it('invalid project id returns 404', async () => {
    await agent.get('/projects/abc').expect(404);
  });

  it('archive action preserves the record and redirects', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=To+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post(`/projects/${id}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe('/projects');

    const detail = await agent.get(`/projects/${id}`).expect(200);
    expect(detail.text).toContain('<span class="status-badge status-badge--archived">Archived</span>');
    expect(detail.text).not.toMatch(/project-status-badge[^>]*>Archived<\/span>/);
  });

  it('delete action removes the project and redirects to the project list', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=To+Delete')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post(`/projects/${id}/delete`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    expect(res.headers.location).toBe('/projects');
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(id))).toBeUndefined();
    await agent.get(`/projects/${id}`).expect(404);
  });

  it('delete action returns 404 for a missing project', async () => {
    await agent
      .post('/projects/9999/delete')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(404);
  });

  it('protects project deletion with CSRF', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Protected+Delete')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');

    await agent.post(`/projects/${id}/delete`).expect(403);
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(id))).toBeDefined();
  });

  it('surfaces project deletion recovery failures instead of redirecting', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Failed+Delete')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const id = createRes.headers.location.replace('/projects/', '');
    const deleteProject = vi.spyOn(app.locals.projectService, 'deleteProject')
      .mockImplementationOnce(() => {
        throw new Error('Project was deleted, but filesystem cleanup requires recovery.');
      });

    try {
      const res = await agent
        .post(`/projects/${id}/delete`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);

      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('Something went wrong.');
    } finally {
      deleteProject.mockRestore();
    }
  });

  it('archived project is excluded from the default list', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Hidden+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken));

    const list = await agent.get('/projects').expect(200);
    expect(list.text).not.toContain('Hidden Project');
  });

  it('archived project appears under the archived filter', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Filter+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');
    const archivedTag = app.locals.tagService.createTag({ name: 'Archived List Display' });
    app.locals.projectTagService.replaceProjectTags(Number(id), [archivedTag.id]);
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken));

    const archivedList = await agent.get('/projects?status=archived').expect(200);
    expect(archivedList.text).toContain('Filter Archive');
    expect(archivedList.text).toContain('Archived List Display');
    expect(archivedList.text).toContain('class="project-card project-card--grid project-grid-card project-card--archived" data-project-card');
    expect(archivedList.text).toContain('<span class="status-badge status-badge--archived">Archived</span>');
    expect(app.locals.projectOptionCatalogueService.getStatusCatalogue().map(({ value }) => value))
      .not.toContain('archived');
  });

  it('project id and status query parameters affect results', async () => {
    const alphaId = await createProject({ title: 'Project Alpha', status: 'planned' });
    const betaId = await createProject({ title: 'Project Beta', status: 'ready' });

    const projectFilter = await agent.get(`/projects?project=${alphaId}`).expect(200);
    expect(projectFilter.text).toContain('Project Alpha');
    expect(extractProjectCards(projectFilter.text).join('')).not.toContain('Project Beta');
    expect(extractProjectFilter(projectFilter.text)).toContain(`value="${alphaId}" checked`);

    const status = await agent.get('/projects?status=ready').expect(200);
    expect(status.text).toContain('Project Beta');
    expect(extractProjectCards(status.text).join('')).not.toContain('Project Alpha');
  });

  it('filters Projects by every valid Project Type, multiple types, and Status while normalizing invalid types', async () => {
    await Promise.all([
      createProject({ title: 'Type Images', status: 'planned', projectType: 'images' }),
      createProject({ title: 'Type Comic', status: 'planned', projectType: 'comic' }),
      createProject({ title: 'Type Animation', status: 'ready', projectType: 'animation' }),
      createProject({ title: 'Type Wallpaper', status: 'ready', projectType: 'wallpaper' }),
    ]);
    const names = ['Images', 'Comic', 'Animation', 'Wallpaper'];
    const types = ['images', 'comic', 'animation', 'wallpaper'];

    for (const [index, type] of types.entries()) {
      const response = await agent.get(`/projects?type=${type}`).expect(200);
      expect(extractProjectCards(response.text).join('')).toContain(`Type ${names[index]}`);
      expect(extractProjectTypeFilter(response.text)).toMatch(new RegExp(`name="type"[^>]+value="${type}"[^>]*checked`));
    }

    const multiple = await agent.get('/projects?type=wallpaper&type=comic&sort=title&order=asc').expect(200);
    expect(extractProjectCards(multiple.text).join('')).toContain('Type Comic');
    expect(extractProjectCards(multiple.text).join('')).toContain('Type Wallpaper');
    expect(extractProjectCards(multiple.text).join('')).not.toContain('Type Images');
    expect(extractProjectTypeFilter(multiple.text)).toContain('aria-label="Project Type filter: 2 types selected"');

    const combined = await agent.get('/projects?type=images&type=comic&status=planned').expect(200);
    expect(extractProjectCards(combined.text).join('')).toContain('Type Images');
    expect(extractProjectCards(combined.text).join('')).toContain('Type Comic');
    expect(extractProjectCards(combined.text).join('')).not.toContain('Type Animation');

    const invalid = await agent.get('/projects?type=not-a-type').expect(200);
    expect(extractProjectTypeFilter(invalid.text)).toContain('aria-label="Project Type filter: All types"');
    expect(extractProjectTypeFilter(invalid.text)).not.toMatch(/name="type"[^>]+checked/);
  });

  it('project list preserves title sort ordering in the card grid', async () => {
    const zetaId = await createProject({ title: 'Sort Zeta' });
    const alphaId = await createProject({ title: 'Sort Alpha' });

    const ascending = await agent.get('/projects?sort=title&order=asc').expect(200);
    const alphaPosition = ascending.text.indexOf(`data-project-card-link href="/projects/${alphaId}"`);
    const zetaPosition = ascending.text.indexOf(`data-project-card-link href="/projects/${zetaId}"`);
    expect(alphaPosition).toBeGreaterThan(-1);
    expect(zetaPosition).toBeGreaterThan(-1);
    expect(alphaPosition).toBeLessThan(zetaPosition);

    const descending = await agent.get('/projects?sort=title&order=desc').expect(200);
    const descendingAlphaPosition = descending.text.indexOf(`data-project-card-link href="/projects/${alphaId}"`);
    const descendingZetaPosition = descending.text.indexOf(`data-project-card-link href="/projects/${zetaId}"`);
    expect(descendingZetaPosition).toBeLessThan(descendingAlphaPosition);
  });

  it('project list still filters by status', async () => {
    await agent
      .post('/projects')
      .send('title=Status+Filter+Match')
      .send('status=in-progress')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    await agent
      .post('/projects')
      .send('title=Status+Filter+Nonmatch')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent.get('/projects?status=in-progress').expect(200);
    expect(res.text).toContain('Status Filter Match');
    expect(extractProjectCards(res.text).join('')).not.toContain('Status Filter Nonmatch');
  });

  it('filters by multiple statuses and applies every checked status', async () => {
    await createProject({ title: 'Multi Status Planned', status: 'planned' });
    await createProject({ title: 'Multi Status Ready', status: 'ready' });
    await createProject({ title: 'Multi Status TBD', status: 'tbd' });

    const res = await agent
      .get('/projects?status=ready&status=planned&sort=title&order=asc')
      .expect(200);

    expect(res.text).toContain('2 projects found');
    expect(res.text).toContain('Multi Status Planned');
    expect(res.text).toContain('Multi Status Ready');
    expect(extractProjectCards(res.text).join('')).not.toContain('Multi Status TBD');
    expect(extractStatusFilter(res.text)).toContain('aria-label="Status filter: 2 statuses selected"');
    expect((extractStatusFilter(res.text).match(/name="status"[^>]+checked/g) || [])).toHaveLength(2);
    expect(extractStatusFilter(res.text)).toMatch(/value="planned" checked/);
    expect(extractStatusFilter(res.text)).toMatch(/value="ready" checked/);
  });

  it('valid status filter with no matches shows filtered-empty state and reset action', async () => {
    await agent
      .post('/projects')
      .send('title=Only+Planned')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent.get('/projects?status=ready').expect(200);
    expect(res.text).toContain('No projects found');
    expect(res.text).toContain('Reset');
    expect(res.text).not.toContain('Reset Filters');
    expect(res.text).toContain('href="/projects"');
    expect(res.text).not.toContain('Create your first project to get started.');
  });

  it('pagination is bounded', async () => {
    const pageTwoTag = app.locals.tagService.createTag({ name: 'Page Two Only Tag' });
    let pageTwoProjectId;

    for (let i = 1; i <= 30; i += 1) {
      const response = await agent
        .post('/projects')
        .send(`title=Page+${String(i).padStart(2, '0')}`)
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      if (i === 30) pageTwoProjectId = Number(response.headers.location.replace('/projects/', ''));
    }
    app.locals.projectTagService.replaceProjectTags(pageTwoProjectId, [pageTwoTag.id]);

    const page1 = await agent.get('/projects?sort=title&order=asc&page=1').expect(200);
    expect(page1.text).toContain('30 projects found');
    expect(page1.text).toContain('Page 1 of 2');
    expect(page1.text).toContain('href="/projects?sort=title&amp;order=asc&amp;page=2"');
    expect(extractProjectCards(page1.text)).toHaveLength(25);
    expect(extractProjectCards(page1.text).join('')).not.toContain('Page Two Only Tag');

    const page2 = await agent.get('/projects?sort=title&order=asc&page=2').expect(200);
    expect(page2.text).toContain('Page 2 of 2');
    expect(page2.text).toContain('Page Two Only Tag');
    expect(extractProjectCards(page2.text)).toHaveLength(5);

    const huge = await agent.get('/projects?sort=title&order=asc&page=999').expect(200);
    expect(huge.text).toContain('Page 2 of 2');
    expect(huge.text).toContain('href="/projects?sort=title&amp;order=asc&amp;page=1"');
    expect(huge.text).toContain('Page Two Only Tag');
  });

  it('unknown routes still return safe 404', async () => {
    const res = await agent.get('/not-a-real-route').expect(404);
    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('at ');
  });

  // ─── Filesystem creation flow ────────────────────────────────────────

  describe('HTTP filesystem creation', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title) {
      // Flat layout: project directories are direct children of PROJECTS_ROOT
      const slug = parseSlug(title);
      const entries = fs.readdirSync(projectsRoot);
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, matching[0]);
    }

    it('creates the database record and project directory', async () => {
      const res = await agent
        .post('/projects')
        .send('title=HTTP+FS+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const location = res.headers.location;
      expect(location).toMatch(/^\/projects\/\d+$/);

      // Verify the directory exists
      const projectDir = getProjectDir('HTTP FS Test');
      expect(projectDir).not.toBeNull();
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.statSync(projectDir).isDirectory()).toBe(true);
      // Flat layout: direct child of PROJECTS_ROOT
      expect(path.dirname(projectDir)).toBe(path.resolve(projectsRoot));
    });

    it('creates the same flat path shape for every status', async () => {
      for (const status of ['tbd', 'planned', 'in-progress', 'ready']) {
        await agent
          .post('/projects')
          .send(`title=Flat+Shape+${encodeURIComponent(status)}`)
          .send(`status=${encodeURIComponent(status)}`)
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const projectDir = getProjectDir(`Flat Shape ${status}`);
        expect(projectDir).not.toBeNull();
        expect(projectDir).toContain(path.join(projectsRoot, ''));
        // Status never participates — no status directory is created
        expect(fs.existsSync(path.join(projectsRoot, 'active'))).toBe(false);
        expect(fs.existsSync(path.join(projectsRoot, 'inbox'))).toBe(false);
        expect(path.dirname(projectDir)).toBe(path.resolve(projectsRoot));
      }
    });

    it('creates standard subdirectories', async () => {
      await agent
        .post('/projects')
        .send('title=Subdirs+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectDir = getProjectDir('Subdirs HTTP');
      expect(projectDir).not.toBeNull();

      const expectedSubdirs = ['final', 'wip', 'krz', 'wm', 'wm-lq'];
      for (const sub of expectedSubdirs) {
        const subPath = path.join(projectDir, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.statSync(subPath).isDirectory()).toBe(true);
      }
      expect(fs.existsSync(path.join(projectDir, 'exports', 'full'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'exports', 'web'))).toBe(false);
    });

    it('writes a schema-version-3 project manifest without status', async () => {
      await agent
        .post('/projects')
        .send('title=Manifest+HTTP')
        .send('description=Test+description')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectDir = getProjectDir('Manifest HTTP');
      expect(projectDir).not.toBeNull();

      const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(content);
      expect(manifest.schemaVersion).toBe(3);
      expect(manifest.title).toBe('Manifest HTTP');
      expect(manifest.description).toBe('Test description');
      expect(manifest).not.toHaveProperty('status');
      expect(content).not.toMatch(/"status"\s*:/);
      expect(manifest.assetCategories.map((c) => c.directorySlug)).toEqual([
        'final', 'wip', 'krz', 'wm', 'wm-lq',
      ]);
    });

    it('stores relative path in the database', async () => {
      const res = await agent
        .post('/projects')
        .send('title=Rel+Path+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const id = res.headers.location.replace('/projects/', '');
      const detail = await agent.get(`/projects/${id}`).expect(200);
      // Verify the detail page renders — the project was stored
      expect(detail.text).toContain('Rel Path HTTP');
    });

    it('HTTP creation error contains no absolute paths', async () => {
      // This requires a server restart with a broken projectsRoot to simulate failure
      // Instead, verify that invalid data produces errors without paths
      const res = await agent
        .post('/projects')
        .send('title=')
        .send('status=invalid')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
      // The real intent here is "no filesystem path leak" — checked directly
      // against the actual temp root/projectsRoot for this test, rather than
      // a generic "/word/word" regex. That generic form now also matches
      // ordinary in-app relative links (e.g. the disabled-auth warning
      // banner's href="/settings/security", rendered on every page while
      // authentication is disabled) with no path-leak significance at all.
      expect(res.text).not.toContain(tmpDir);
      expect(res.text).not.toContain(projectsRoot);
    });

    it('detail page shows the flat project directory after creation', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Detail+Dir+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toContain('Project directory');
      // Flat layout: the displayed path is the bare directory name
      expect(detail.text).toMatch(/\d+-detail-dir-test/);
      expect(detail.text).not.toMatch(/tbd(?:&#92;|\/)/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('filesystem conflict from the Dashboard dialog rerenders the host with a safe error', async () => {
      // Block the expected path for project id=1 (first project in a fresh DB)
      const slug = parseSlug('Conflict+Create');
      const conflictPath = path.join(projectsRoot, `000001-${slug}`);
      fs.writeFileSync(conflictPath, 'blocker');

      const res = await agent
        .post('/projects')
        .send('title=Conflict+Create')
        .send('description=Value+kept')
        .send('status=tbd')
        .send('priority=normal')
        .send('returnTo=/')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);

      const dialog = extractProjectCreateDialog(res.text);
      expect(res.text).toContain('Dashboard');
      expect(dialog).toMatch(/<dialog id="project-create-dialog"[^>]*\bopen\b/);
      expect(dialog).toContain('Project creation failed');
      expect(dialog).toContain('Conflict Create');
      expect(dialog).toContain('Value kept');
      expect(dialog).toContain('name="returnTo" value="/"');
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    it('filesystem conflict from a filtered Projects dialog preserves its exact invocation URL', async () => {
      const slug = parseSlug('Filtered Conflict Create');
      const conflictPath = path.join(projectsRoot, `000001-${slug}`);
      fs.writeFileSync(conflictPath, 'blocker');
      const returnTo = '/projects?search=conflict&sort=title&order=asc&page=2#projects-list';

      const res = await agent
        .post('/projects')
        .send('title=Filtered+Conflict+Create')
        .send('description=Value+kept')
        .send('status=tbd')
        .send('priority=normal')
        .send('returnTo=' + encodeURIComponent(returnTo))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);

      const dialog = extractProjectCreateDialog(res.text);
      expect(dialog).toMatch(/<dialog id="project-create-dialog"[^>]*\bopen\b/);
      expect(dialog).toContain('Project creation failed');
      expect(dialog).toContain('Filtered Conflict Create');
      expect(dialog).toContain('name="returnTo" value="/projects?search=conflict&amp;sort=title&amp;order=asc&amp;page=2#projects-list" data-dialog-return-location');
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });
  });

  // ─── Filesystem update flow ────────────────────────────────────────

  describe('HTTP filesystem update', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title) {
      // Flat layout: project directories are direct children of PROJECTS_ROOT
      const slug = parseSlug(title);
      const entries = fs.readdirSync(projectsRoot);
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, matching[0]);
    }

    it('status-only edit is DB/UI-only and leaves the flat directory untouched', async () => {
      // Create a project
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Meta+Edit')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;

      const projectDir = getProjectDir('HTTP Meta Edit');
      expect(projectDir).not.toBeNull();
      const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
      const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
      const customFile = path.join(projectDir, 'user-data.txt');
      fs.writeFileSync(customFile, 'keep me');

      // Change status only (same title, no slug change, no metadata change)
      const res = await agent
        .post(location)
        .send('title=HTTP+Meta+Edit')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      expect(res.headers.location).toBe(location);

      // Status is DB-only — manifest and directory are untouched
      const row = db.prepare('SELECT status, project_dir FROM projects WHERE title = ?')
        .get('HTTP Meta Edit');
      expect(row.status).toBe('in-progress');
      expect(row.project_dir.split(path.sep)).toHaveLength(1);

      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.existsSync(customFile)).toBe(true);
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
      expect(fs.existsSync(path.join(projectsRoot, 'active'))).toBe(false);
    });

    it('title change renames the directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Old+HTTP+Name')
        .send('description=Before')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Old HTTP Name');
      expect(oldDir).not.toBeNull();

      // Add a custom file to prove contents survive
      fs.writeFileSync(path.join(oldDir, 'custom-file.txt'), 'survived');

      // Rename
      await agent
        .post(location)
        .send('title=New+HTTP+Name')
        .send('description=After')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory exists (flat rename)
      const newDir = getProjectDir('New HTTP Name');
      expect(newDir).not.toBeNull();
      expect(fs.existsSync(newDir)).toBe(true);

      // Custom file survived
      expect(fs.existsSync(path.join(newDir, 'custom-file.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'custom-file.txt'), 'utf8')).toBe('survived');

      // Detail page shows new name
      const detail = await agent.get(location).expect(200);
      expect(detail.text).toContain('New HTTP Name');
      expect(detail.text).not.toContain('Old HTTP Name');
    });

    it('status-only change is DB/UI-only and leaves the flat directory untouched', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Status+Move+HTTP')
        .send('description=Moved')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Status Move HTTP');
      expect(oldDir).not.toBeNull();

      // Add a custom file
      fs.writeFileSync(path.join(oldDir, 'move-test.txt'), 'moved');

      // Change status only (same title → no slug change → no rename)
      await agent
        .post(location)
        .send('title=Status+Move+HTTP')
        .send('description=Moved')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Directory untouched at the same flat location
      expect(fs.existsSync(oldDir)).toBe(true);
      expect(path.dirname(oldDir)).toBe(path.resolve(projectsRoot));

      // Custom file survived
      expect(fs.existsSync(path.join(oldDir, 'move-test.txt'))).toBe(true);

      // Status is DB-only; the manifest is not rewritten with status
      const row = db.prepare('SELECT status, project_dir FROM projects WHERE title = ?')
        .get('Status Move HTTP');
      expect(row.status).toBe('in-progress');
      expect(row.project_dir).toBe(path.basename(oldDir));
      const manifest = readManifestSync(oldDir);
      expect(manifest).not.toHaveProperty('status');
      expect(fs.existsSync(path.join(projectsRoot, 'active'))).toBe(false);
    });

    it('combined title/status change renames the flat directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Combined+HTTP+Start')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Combined HTTP Start');
      expect(oldDir).not.toBeNull();

      // Change both title and status
      await agent
        .post(location)
        .send('title=Combined+HTTP+Final')
        .send('status=ready')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New flat directory (no status parent)
      const newDir = getProjectDir('Combined HTTP Final');
      expect(newDir).not.toBeNull();
      expect(path.dirname(newDir)).toBe(path.resolve(projectsRoot));
      expect(fs.existsSync(path.join(projectsRoot, 'ready'))).toBe(false);

      // Detail page shows everything
      const detail = await agent.get(location).expect(200);
      expect(detail.text).toContain('Combined HTTP Final');
      expect(detail.text).toContain('Ready');
    });

    it('error responses contain no absolute filesystem paths on update failure', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=No+Path+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Trigger a validation error (non-filesystem) — should be path-safe
      const res = await agent
        .post(createRes.headers.location)
        .send('title=No+Path+HTTP')
        .send('status=archived')  // rejected by the operational archive guard
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      // Only check for absolute Windows paths (drive-letter paths)
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archived status is still rejected from edit form', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=No+Archive+In+Edit')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post(createRes.headers.location)
        .send('title=No+Archive+In+Edit')
        .send('status=archived')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toContain('Status must be one of');
    });

    it('title change updates the displayed relative path', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Old+Path+Name')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Before rename — detail shows the flat dir
      let detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/\d+-old-path-name/);
      expect(detail.text).not.toMatch(/tbd(?:&#92;|\/)/);

      // Rename
      await agent
        .post(createRes.headers.location)
        .send('title=New+Path+Name')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After rename — detail shows the new flat dir
      detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/\d+-new-path-name/);
      expect(detail.text).not.toMatch(/old-path-name/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('status change does not change the displayed flat project directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Status+Path+Change')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Before — flat dir
      let detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/\d+-status-path-change/);
      expect(detail.text).not.toMatch(/planned(?:&#92;|\/)/);

      // Change status
      await agent
        .post(createRes.headers.location)
        .send('title=Status+Path+Change')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After — the same flat dir is still displayed
      detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/\d+-status-path-change/);
      expect(detail.text).not.toMatch(/active(?:&#92;|\/)/);
      expect(detail.text).not.toMatch(/planned(?:&#92;|\/)/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('filesystem failure during update renders safe error with preserved values', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Update+Fail+Safe')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Remove the project directory to trigger a filesystem error on update
      const projectDir = getProjectDir('Update Fail Safe');
      expect(projectDir).not.toBeNull();
      fs.rmSync(projectDir, { recursive: true, force: true });

      const res = await agent
        .post(createRes.headers.location)
        .send('title=Updated+Title')
        .send('description=Preserved+text')
        .send('status=tbd')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);

      expect(res.text).toContain('<section class="project-detail-hero">');
      const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).not.toBe('');
      expect(dialog).toMatch(/<dialog id="project-edit-dialog"[^>]*\bopen\b/);
      expect(dialog).toContain('Project update failed. Please try again.');
      expect(dialog).toContain('Updated Title');
      expect(dialog).toContain('Preserved text');
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });
  });

  // ─── Filesystem archive flow ────────────────────────────────────────

  describe('HTTP filesystem archive', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title) {
      // Flat layout: project directories are direct children of PROJECTS_ROOT
      const slug = parseSlug(title);
      const entries = fs.readdirSync(projectsRoot);
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, matching[0]);
    }

    it('archive is a database transition that preserves the flat directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Move')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const projectDir = getProjectDir('HTTP Archive Move');
      expect(projectDir).not.toBeNull();
      expect(fs.existsSync(projectDir)).toBe(true);

      const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
      const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
      fs.writeFileSync(path.join(projectDir, 'http-extra.txt'), 'http content');

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Directory stays in place at the same flat location
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.statSync(projectDir).isDirectory()).toBe(true);
      expect(path.dirname(projectDir)).toBe(path.resolve(projectsRoot));
      expect(fs.existsSync(path.join(projectDir, 'http-extra.txt'))).toBe(true);
      // Manifest untouched � archiving does not rewrite it
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
      // No archived/ directory was created
      expect(fs.existsSync(path.join(projectsRoot, 'archived'))).toBe(false);
    });

    it('status becomes archived', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Status')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const row = db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(Number(id));
      expect(row.status).toBe('archived');
      expect(row.archived_at).toBeTruthy();
    });

    it('project_dir is preserved across archive', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Path')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const before = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(Number(id));
      expect(before.project_dir.split(path.sep)).toHaveLength(1);

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const after = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(Number(id));
      expect(after.project_dir).toBe(before.project_dir);
    });

    it('archive succeeds when the project directory is missing', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+No+Dir+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Remove the directory entirely � archive must still succeed
      const projectDir = getProjectDir('HTTP No Dir Archive');
      expect(projectDir).not.toBeNull();
      fs.rmSync(projectDir, { recursive: true, force: true });

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const row = db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(Number(id));
      expect(row.status).toBe('archived');
      expect(row.archived_at).toBeTruthy();
    });

    it('archive remains POST-only', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+GET+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // GET should not archive � 404 from route matching
      await agent
        .get(`/projects/${id}/archive`)
        .expect(404);
    });

    it('invalid project id returns 404 on archive', async () => {
      await agent
        .post('/projects/abc/archive')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);
    });

    it('missing project returns 404 on archive', async () => {
      await agent
        .post('/projects/99999/archive')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);
    });

    it('archived scan rejection causes no asset changes (full row snapshot)', async () => {
      const title = 'Archived Scan Reject';
      const createRes = await agent
        .post('/projects')
        .send('title=' + encodeURIComponent(title))
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const getProjectDirForTitle = () => {
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const entries = fs.readdirSync(projectsRoot);
        const matching = entries.filter((e) => e.endsWith(`-${slug}`));
        return path.join(projectsRoot, matching[0]);
      };
      const projectDir = getProjectDirForTitle();

      // 1. Create at least two baseline files
      const baselineFile1 = 'baseline-a.txt';
      const baselineFile2 = 'baseline-b.txt';
      const newFile = 'will-be-new.txt';

      fs.writeFileSync(path.join(projectDir, baselineFile1), 'baseline a');
      fs.writeFileSync(path.join(projectDir, baselineFile2), 'baseline b');

      // 2. Run a successful scan so both have persisted asset rows
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // 3. Modify the first baseline file
      fs.writeFileSync(path.join(projectDir, baselineFile1), 'modified content');

      // 4. Delete the second baseline file
      fs.unlinkSync(path.join(projectDir, baselineFile2));

      // 5. Add a new file
      fs.writeFileSync(path.join(projectDir, newFile), 'brand new');

      // 6. Snapshot all persisted asset rows before the rejected scan
      const assetRepo = createAssetRepository(db);
      const beforeAssets = assetRepo.findByProjectId(Number(id));
      expect(beforeAssets.length).toBe(2);

      const beforeSnapshot = beforeAssets.map((a) => ({ ...a }));

      // 7. Archive the project
      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // 8. POST the scan route — must be rejected
      const scanRes = await agent
        .post(`/projects/${id}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken));
      expect(scanRes.status).toBe(302);
      expect(scanRes.headers.location).toContain('scan_error=archived');

      // 9. Assert the archived-scan rejection
      // 10. Query all project assets again
      const afterAssets = assetRepo.findByProjectId(Number(id));
      expect(afterAssets.length).toBe(2);

      // complete before/after asset rows are deeply equal
      for (let i = 0; i < beforeSnapshot.length; i++) {
        const before = beforeSnapshot[i];
        const after = afterAssets.find((a) => a.id === before.id);
        expect(after).toBeDefined();
        expect(after.id).toBe(before.id);
        expect(after.project_id).toBe(before.project_id);
        expect(after.relative_path).toBe(before.relative_path);
        expect(after.filename).toBe(before.filename);
        expect(after.extension).toBe(before.extension);
        expect(after.mime_type).toBe(before.mime_type);
        expect(after.size_bytes).toBe(before.size_bytes);
        expect(after.modified_at).toBe(before.modified_at);
        expect(after.is_present).toBe(before.is_present);
        expect(after.last_seen_at).toBe(before.last_seen_at);
        expect(after.missing_since).toBe(before.missing_since);
        expect(after.created_at).toBe(before.created_at);
        expect(after.updated_at).toBe(before.updated_at);
      }

      // the new file was not inserted
      const newAsset = afterAssets.find((a) => a.relative_path === newFile);
      expect(newAsset).toBeUndefined();

      // the modified file's metadata was not updated
      const modifiedAsset = afterAssets.find((a) => a.relative_path === baselineFile1);
      expect(modifiedAsset).toBeDefined();
      const beforeModified = beforeSnapshot.find((a) => a.relative_path === baselineFile1);
      expect(modifiedAsset.size_bytes).toBe(beforeModified.size_bytes);
      expect(modifiedAsset.modified_at).toBe(beforeModified.modified_at);

      // the deleted file's persisted row still exists
      const deletedAsset = afterAssets.find((a) => a.relative_path === baselineFile2);
      expect(deletedAsset).toBeDefined();
      // the deleted file still has is_present = 1
      expect(deletedAsset.is_present).toBe(1);
      // missing_since remains unchanged
      expect(deletedAsset.missing_since).toBeNull();
      // no scanner-maintained timestamp changed
      const beforeDeleted = beforeSnapshot.find((a) => a.relative_path === baselineFile2);
      expect(deletedAsset.last_seen_at).toBe(beforeDeleted.last_seen_at);
      expect(deletedAsset.updated_at).toBe(beforeDeleted.updated_at);
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

    it('project detail shows retained metadata without Project scheduling dates', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Wording+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('description=Project+description')
        .send('plannedDate=2025-12-01')
        .send('publishedDate=2025-12-15')
        .send('patreonUrl=https://patreon.com/test')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}`).expect(200);
      const details = extractProjectDetailSection(res.text, 'project-detail-info');
      const metaStart = res.text.indexOf('<div class="project-detail-meta">');
      const meta = metaStart >= 0 ? extractHtmlElement(res.text, metaStart) : '';

      expect(details).toContain('<section class="project-detail-info project-detail-section">');
      expect(details).toContain('<h2>Details</h2>');
      expect(details).toContain('<div class="project-detail-section-body">');
      const detailListStart = details.indexOf('<dl class="detail-list">');
      const detailList = extractHtmlElement(details, detailListStart);
      const detailRows = extractDirectHtmlChildren(detailList);
      const detailLabels = detailRows
        .filter((row) => row.startsWith('<dt>'))
        .map((row) => row.match(/^<dt>([^<]+)<\/dt>$/)?.[1]);
      expect(detailLabels).toEqual([
        'Project directory',
        'Slug',
        'Created',
        'Updated',
        'Description',
        'Project link',
      ]);
      expect(details).toContain('<dd class="description">Project description</dd>');
      expect(details).toMatch(/<dt>Project link<\/dt>\s*<dd><a class="project-detail-link" href="https:\/\/patreon\.com\/test" target="_blank" rel="noopener">Project link<\/a><\/dd>/);
      expect(details).not.toMatch(/<dt>(?:Planned date|Published date)<\/dt>/);
      expect(res.text).not.toContain('<p class="description">Project description</p>');
      expect(meta).not.toContain('project-detail-link');
    });

    it('project detail renders the established missing description and omits scheduling dates and an absent project link', async () => {
      const id = await createProject({ title: 'Optional Detail Fields Empty' });

      const res = await agent.get(`/projects/${id}`).expect(200);
      const details = extractProjectDetailSection(res.text, 'project-detail-info');

      expect(details).toMatch(/<dt>Description<\/dt>\s*<dd class="description">—<\/dd>/);
      expect(details).not.toMatch(/<dt>(?:Planned date|Published date)<\/dt>/);
      expect(details).not.toContain('project-detail-link');
      expect(details).toContain('<dt>Slug</dt>');
      expect(details).toContain('<dt>Created</dt>');
      expect(details).toContain('<dt>Updated</dt>');
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

    it('project detail hero renders the primary image when one is set', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Hero+Available')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      seedPrimaryImage(Number(id));

      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).toContain('data-preview-enhancement');
      expect(res.text).toMatch(
        /<img class="project-detail-media-image" data-preview-image src="\/projects\/\d+\/assets\/\d+\/preview\?v=[0-9a-f]+" alt="Preview of cover\.png"/
      );
    });

    it('project detail hero shows a placeholder and asset-viewer CTA when no primary image is set', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Hero+None')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).toContain('data-primary-image-state="none"');
      expect(res.text).toContain('No primary image set.');
      expect(res.text).toContain(`href="/projects/${id}/assets"`);
    });
  });

  describe('project detail Social Preparation summaries', () => {
    let projectId, releaseId;

    beforeEach(async () => {
      projectId = await createProject({ title: 'Social summary fixture' });
      releaseId = db.prepare("INSERT INTO releases (project_id, title, planned_date) VALUES (?, 'Saved targets release', '2099-01-01') RETURNING id").get(projectId).id;
      app.locals.socialPrepSettingsService.setPlatforms(['patreon', 'x', 'bluesky']);
      app.locals.socialPrepSettingsService.setEnabled(true);
    });

    afterEach(() => vi.restoreAllMocks());

    function target(platform, status, attempts = 1, id = releaseId) {
      app.locals.socialPrepRepository.ensurePlatforms(id, [platform]);
      db.prepare(`UPDATE release_social_platforms SET status = ?, attempts = ?, message = ?, detail_code = ?
        WHERE release_id = ? AND platform = ?`).run(status, attempts,
        'PRIVATE_MESSAGE PRIVATE_TOKEN PRIVATE_SESSION PRIVATE_STDERR C:\\PRIVATE_PATH PRIVATE_CREATOR PRIVATE_BROWSER',
        'PRIVATE_DETAIL_CODE', id, platform);
    }

    async function page() {
      const { text } = await agent.get(`/projects/${projectId}`).expect(200);
      expect(text).not.toMatch(/PRIVATE_|openlocally:|creatorcrate-social:|\/social-prep\/activate|\/social-preparation\/activate/i);
      const list = extractReleaseList(text);
      expect(list).not.toMatch(/Send to helper again|Prepare again|Retry|Reprepare|data-social/i);
      for (const summary of list.match(/<div class="release-social-prep-summary"[\s\S]*?<\/div>/g) || []) {
        expect(summary).toContain('<small>Social posts</small>');
        expect(summary).toContain('aria-label="Social posts"');
        expect(summary).not.toMatch(/Social targets|\(last recorded preparation\)/);
        expect(summary).not.toMatch(/<form\b|<button\b|<input\b|<a\b|\b(posted|published|submitted|live)\b|sent successfully/i);
      }
      return { text, list, item: extractReleaseItem(list, releaseId) };
    }

    it('shows mixed platforms in presenter order after metadata, without crossing release boundaries', async () => {
      target('bluesky', 'failed');
      target('x', 'prepared');
      target('patreon', 'pending', 0);
      const otherId = db.prepare("INSERT INTO releases (project_id, title, published_date) VALUES (?, 'Other release', '2026-08-01') RETURNING id").get(projectId).id;
      target('x', 'cancelled', 1, otherId);
      const { text, list, item } = await page();
      const summary = item.match(/<div class="release-social-prep-summary"[\s\S]*?<\/div>/)[0];
      expect(summary.match(/class="status-badge status-badge--neutral">[^<]+/g)).toEqual([
        'class="status-badge status-badge--neutral">Patreon · Not attempted',
        'class="status-badge status-badge--neutral">X · Prepared',
        'class="status-badge status-badge--neutral">Bluesky · Failed',
      ]);
      expect(item).toContain(`href="/releases/${releaseId}">Saved targets release</a>`);
      expect(item).toContain('planned 2099-01-01');
      expect(item.indexOf('updated')).toBeLessThan(item.indexOf(summary));
      expect(item).not.toContain('Cancelled');
      const other = extractReleaseItem(list, otherId);
      expect(other).toContain('X · Cancelled');
      expect(other).toContain('published 2026-08-01');
      expect(other).not.toMatch(/Patreon|Bluesky|Prepared/);
      expect(text).toContain(`href="/releases?project=${projectId}"`);
      expect(text).toContain(`href="/releases/new?projectId=${projectId}"`);
    });

    it('omits targets rather than backfilling from current Settings', async () => {
      const { item } = await page();
      expect(item).not.toMatch(/Social posts|release-social-prep-summary/);
      expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)).toEqual([]);
    });

    it.each([
      ['pending', 'Pending'], ['starting', 'Starting'], ['preparing', 'Preparing'],
      ['uploading', 'Uploading'], ['auth_required', 'Authentication required'],
    ])('shows persisted %s with the compact Social posts label', async (status, label) => {
      target('x', status);
      const { item } = await page();
      expect(item).toContain(`X · ${label}`);
      expect(item).toContain('<small>Social posts</small>');
    });

    it.each([true, false])('retains removed saved targets on archived read-only summaries (enabled=%s)', async (enabled) => {
      target('patreon', 'prepared');
      app.locals.socialPrepSettingsService.setPlatforms(['bluesky']);
      app.locals.socialPrepSettingsService.setEnabled(enabled);
      db.prepare("UPDATE projects SET archived_at = '2026-08-01' WHERE id = ?").run(projectId);
      db.prepare("UPDATE releases SET archived_at = '2026-08-01' WHERE id = ?").run(releaseId);
      const { text, item } = await page();
      expect(item).toContain('Patreon · Prepared');
      expect(item).not.toContain('Bluesky');
      expect(text).toContain('This project is archived and read-only');
      expect(text).not.toContain(`href="/releases/new?projectId=${projectId}"`);
    });

    it.each([false, true])('GET remains read-only and batches overlapping active/recent IDs once (saved=%s)', async (saved) => {
      if (saved) target('x', 'prepared');
      const queries = vi.spyOn(db, 'prepare');
      const tokens = await import('../src/services/social-prep-tokens.js');
      app.locals.socialPrepService = Object.fromEntries(Object.entries(app.locals.socialPrepService).map(([key, value]) => [
        key, typeof value === 'function' ? vi.fn(() => { throw new Error('Display must not execute preparation'); }) : value,
      ]));
      const executionSpies = [...Object.values(app.locals.socialPrepService), ...Object.values(tokens)].filter(vi.isMockFunction);
      executionSpies.forEach((spy) => spy.mockClear());
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      const { list } = await page();
      const socialReads = queries.mock.calls.map(([sql]) => sql).filter((sql) => /FROM release_social_platforms/.test(sql));
      expect(socialReads).toHaveLength(1);
      expect(socialReads[0]).toContain('WHERE release_id IN (?)');
      expect(list.match(new RegExp(`href="/releases/${releaseId}"`, 'g'))).toHaveLength(1);
      expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(before);
      executionSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
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

  it('project detail renders release thumbnails per release with accessible labels and a display cap', async () => {
    const projectId = await createProject({ title: 'Release Thumbnail Project' });
    const assetRepository = createAssetRepository(db);
    const releaseRepository = createReleaseRepository(db);
    const firstAssets = Array.from({ length: 14 }, (_, index) => assetRepository.upsert(
      projectId,
      `first-${index}.png`,
      {
        filename: index === 0 ? 'cover & <featured>.png' : `first-${index}.png`,
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 1024 + index,
        modifiedAt: '2026-08-06 12:00:00',
      },
    ));
    const secondAssets = Array.from({ length: 2 }, (_, index) => assetRepository.upsert(
      projectId,
      `second-${index}.png`,
      {
        filename: `second-${index}.png`,
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048 + index,
        modifiedAt: '2026-08-06 12:00:00',
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
    app.locals.socialPrepRepository.ensurePlatforms(firstRelease.id, ['x']);

    firstAssets.forEach((asset, sortOrder) => {
      releaseRepository.addReleaseAsset(firstRelease.id, asset.id, 'attachment', sortOrder);
    });
    secondAssets.forEach((asset, sortOrder) => {
      releaseRepository.addReleaseAsset(secondRelease.id, asset.id, 'attachment', sortOrder);
    });

    const res = await agent.get(`/projects/${projectId}`).expect(200);
    const releases = extractProjectDetailSection(res.text, 'project-detail-releases');
    expect(releases).toContain('<section class="release-summary project-detail-releases project-detail-section">');
    expect(releases).toContain('<h2>Releases</h2>');
    expect(releases).toContain('<div class="project-detail-section-body">');
    expect(releases).toContain('href="/releases?project=' + projectId + '"');
    expect(releases).toContain('href="/releases/new?projectId=' + projectId + '"');
    expect(releases).toContain('<ul class="release-list">');
    const releaseList = extractReleaseList(res.text);
    const firstItem = extractReleaseItem(releaseList, firstRelease.id);
    const secondItem = extractReleaseItem(releaseList, secondRelease.id);
    const emptyItem = extractReleaseItem(releaseList, emptyRelease.id);
    const firstThumbnailLinks = firstItem.match(/<a class="release-thumbnail-link"[^>]*>[\s\S]*?<\/a>/g) || [];
    const secondThumbnailLinks = secondItem.match(/<a class="release-thumbnail-link"[^>]*>[\s\S]*?<\/a>/g) || [];

    expect(firstItem).toContain(`<a href="/releases/${firstRelease.id}">First Thumbnail Release</a>`);
    expect(firstItem).toContain('class="meta"');
    expect(firstItem).toContain('updated');
    expect(firstItem).toContain('X · Not attempted');
    expect(firstItem.indexOf('release-social-prep-summary')).toBeLessThan(firstItem.indexOf('release-thumbnail-strip'));
    expect(firstThumbnailLinks).toHaveLength(12);
    for (const [index, asset] of firstAssets.slice(0, 12).entries()) {
      expect(firstThumbnailLinks[index]).toContain(`href="/projects/${projectId}/assets/${asset.id}"`);
      expect(firstThumbnailLinks[index]).toContain(
        `src="/projects/${projectId}/assets/${asset.id}/thumbnail?v=${buildAssetRevisionToken(asset)}"`,
      );
      expect(firstThumbnailLinks[index]).toContain('loading="lazy" decoding="async"');
      expect(firstThumbnailLinks[index]).not.toContain('data-preview-enhancement');
    }
    expect(firstThumbnailLinks[0]).toContain('aria-label="View cover &amp; &lt;featured&gt;.png"');
    expect(firstThumbnailLinks[0]).toContain('alt="cover &amp; &lt;featured&gt;.png"');
    expect(firstThumbnailLinks[0]).not.toContain('aria-label="View cover & <featured>.png"');
    expect(firstItem).not.toContain(`/projects/${projectId}/assets/${firstAssets[12].id}/thumbnail`);
    expect(firstItem).not.toContain(`/projects/${projectId}/assets/${firstAssets[13].id}/thumbnail`);
    expect(firstItem).toContain(
      `<a class="release-thumbnail-more" href="/releases/${firstRelease.id}">+2 more</a>`,
    );

    expect(secondItem).toContain(`<a href="/releases/${secondRelease.id}">Second Thumbnail Release</a>`);
    expect(secondThumbnailLinks).toHaveLength(2);
    for (const [index, asset] of secondAssets.entries()) {
      expect(secondThumbnailLinks[index]).toContain(`href="/projects/${projectId}/assets/${asset.id}"`);
      expect(secondThumbnailLinks[index]).toContain(
        `src="/projects/${projectId}/assets/${asset.id}/thumbnail?v=${buildAssetRevisionToken(asset)}"`,
      );
    }
    expect(firstItem).not.toContain(`/projects/${projectId}/assets/${secondAssets[0].id}/thumbnail`);
    expect(secondItem).not.toContain(`/projects/${projectId}/assets/${firstAssets[0].id}/thumbnail`);
    expect(emptyItem).not.toContain('release-thumbnail-strip');
  });

  it('serves larger responsive release-thumbnail styles without changing shared asset-card rules', async () => {
    const css = (await agent.get('/creatorcrate.css').expect(200)).text;

    expect(css).toMatch(
      /\.release-thumbnail-strip\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/,
    );
    expect(css).toMatch(
      /\.release-thumbnail-link\s*\{[\s\S]*?flex:\s*0 1 5\.5rem;[\s\S]*?width:\s*5\.5rem;[\s\S]*?height:\s*5\.5rem;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/,
    );
    expect(css).toMatch(
      /\.release-thumbnail-image\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*contain;/,
    );
    expect(css).toMatch(
      /\.release-thumbnail-more\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;/,
    );
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

  // ─── Archived project detail behavior ───────────────────────────────
  //
  // Moved from phase-105b-consolidation.test.js — organizational move
  // only. Behavior and assertions are unchanged from their prior home.

  describe('archived project detail behavior', () => {
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
      expect(res.text).toMatch(/class="[^"]*\bnotice--warning\b[^"]*"/);
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

    it('redirects archived asset categories management to the canonical Assets surface', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archived+Categories+Link')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // Asset Categories is managed from the canonical Assets surface, not an
      // independently active legacy page or the project detail header.
      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).not.toContain(`/projects/${id}/asset-categories`);
      const redirect = await agent.get(`/projects/${id}/asset-categories`).expect(302);
      expect(redirect.headers.location).toBe(`/projects/${id}/assets?manage_categories=1`);
    });
  });

  // ─── Project detail path safety ─────────────────────────────────────
  //
  // Moved from phase-105b-consolidation.test.js — organizational move
  // only. Behavior and assertions are unchanged from their prior home.

  describe('project detail path safety', () => {
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

  // ─── Open locally action on project detail ─────────────────────────
  //
  // The detail page renders a custom-protocol link built from the shared
  // URI builder. The href is Nunjucks-escaped (autoescape), so ampersands
  // appear as &amp; in the markup; browsers decode them when following the
  // link. The action must never leak the container root or an absolute path.
  // The action lives in the project summary toolbar, not inline in the
  // project directory detail row.

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
      expect(actions).toContain('Open locally');
      expect(actions).toContain('aria-label="Open locally"');
      expect((actions.match(/<a\b/g) || [])).toHaveLength(3);
      expect(actions).toContain('creatorcrate-open://');
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
      expect((toolbar.match(/<a\b/g) || [])).toHaveLength(2);
    });

    it('uses the creatorcrate-open scheme with the encoded absolute path and select=0', async () => {
      const id = await createDetailProject('Open Locally Href Test');
      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
      configureWindowsRoot();

      const res = await agent.get(`/projects/${id}`).expect(200);
      const actions = extractProjectDetailActionToolbar(res.text);
      const href = actions.match(/href="(creatorcrate-open:[^"]+)"/)?.[1] || '';

      expect(href).toMatch(/^creatorcrate-open:\/\/open\?v=2/);
      expect(href).toContain(`path=${encodeURIComponent(`D:\\example\\${row.project_dir}`)}`);
      expect(href).toContain('select=0');
      expect(href).not.toContain('mapping=');
      expect(href).not.toContain('/data/projects');
      expect(href).not.toContain(projectsRoot);
    });

    it('does not expose the container projects root anywhere on the detail page', async () => {
      const id = await createDetailProject('Open Locally No Root Leak');

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(res.text).not.toContain('/data/projects');
      expect(res.text).not.toContain(projectsRoot);
    });

    it('omits the action from the project summary toolbar when no windows root is configured', async () => {
      const id = await createDetailProject('Open Locally No Root Configured');

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(extractProjectDetailActionToolbar(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });

    it('omits the action from the project summary toolbar when project_dir is missing', async () => {
      const id = await createDetailProject('Open Locally Missing Dir');
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(id);

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(extractProjectDetailActionToolbar(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });

    it('omits the action from the project summary toolbar when project_dir is invalid', async () => {
      const id = await createDetailProject('Open Locally Invalid Dir');
      db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run('../escape', id);

      const res = await agent.get(`/projects/${id}`).expect(200);

      expect(extractProjectDetailActionToolbar(res.text)).not.toContain('Open locally');
      expect(res.text).not.toContain('creatorcrate-open://');
    });

    it('no longer renders the obsolete inline Open locally link in the project directory row', async () => {
      const id = await createDetailProject('Open Locally Inline Link Gone');
      configureWindowsRoot();

      const res = await agent.get(`/projects/${id}`).expect(200);

      const detailList = res.text.match(/<dl class="detail-list">([\s\S]*?)<\/dl>/)?.[1] || '';
      expect(detailList).not.toContain('project-detail-link');
      expect(detailList).not.toContain('creatorcrate-open://');
      expect(detailList).not.toContain('Open locally');
    });
  });

  // ─── Phase 6B regression: archived project edit route guard ─────────
  //
  // Archived projects are immutable. The edit form must not be reachable
  // through GET /projects/:id/edit; the route must redirect to the detail
  // page (the read-only workspace) instead. The detail page is unaffected.

  describe('archived project edit guard', () => {
    it('treats a legacy status-only archived project as read-only in detail, edit, update, and card presentation', async () => {
      const id = await createProject({ title: 'Legacy Status Only Archived' });
      db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(id);

      const detail = await agent.get(`/projects/${id}?edit=1`).expect(200);
      expect(detail.text).toContain('This project is archived and read-only.');
      expect(detail.text).toContain('<span class="status-badge status-badge--archived">Archived</span>');
      expect(detail.text).not.toContain('aria-label="Edit project"');
      expect(detail.text).not.toContain('id="project-edit-dialog"');
      expect(detail.text).not.toContain(`/releases/new?projectId=${id}`);

      await agent.get(`/projects/${id}/edit`)
        .expect(302)
        .expect('Location', `/projects/${id}`);

      await agent.post(`/projects/${id}`)
        .type('form')
        .send({ title: 'Accidental Unarchive', status: 'tbd', projectType: 'images', _csrf: csrfToken })
        .expect(422);
      expect(db.prepare('SELECT title, status, archived_at FROM projects WHERE id = ?').get(id)).toEqual({
        title: 'Legacy Status Only Archived',
        status: 'archived',
        archived_at: null,
      });

      const archivedList = await agent.get('/projects?status=archived').expect(200);
      const card = extractProjectCard(archivedList.text, id);
      expect(card).toContain('project-card--archived');
      expect(card).toContain('<span class="status-badge status-badge--archived">Archived</span>');
      expect(card).not.toContain('project-status-badge');
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

  describe('project list rendering/status behavior', () => {
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

      // Filtered empty (no match for project id in a non-empty repository)
      const res2 = await agent.get('/projects?project=999999').expect(200);
      expect(res2.text).toContain('No projects found');
      expect(res2.text).toContain('Reset');
      expect(res2.text).not.toContain('Reset Filters');
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
      expect(res.text).toContain('Reset');
      expect(res.text).not.toContain('Reset Filters');
      expect(res.text).not.toContain('Create your first project to get started.');
    });
  });

  describe('project status badge rendering', () => {
    const statuses = ['tbd', 'planned', 'in-progress', 'ready'];

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
});

// ─── Asset-category dependency wiring (app composition root) ─────────────

describe('asset-category dependency wiring through createApp', () => {
  let db;
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-di-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('projectService uses the exact injected assetCategoryService, not one it constructs itself', async () => {
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);

    const fakeCategory = { display_name: 'Fake', directory_slug: 'fake', display_order: 0, enabled: 1 };
    let copyCallCount = 0;
    const fakeAssetCategoryService = {
      copyDefaultsForProject(projectId) {
        copyCallCount++;
        return [{ ...fakeCategory, id: 1, project_id: projectId }];
      },
      listProjectCategories() {
        return [];
      },
    };

    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper }, assetCategoryService: fakeAssetCategoryService }
    );
    const { agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot);

    await agent
      .post('/projects')
      .send('title=DI+Check')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // The fake was invoked exactly once — proving projectService received
    // and used this exact instance rather than constructing its own
    // repository/service internally.
    expect(copyCallCount).toBe(1);

    const dirName = formatProjectDirName(1, 'di-check');
    const absPath = resolveProjectDir(projectsRoot, dirName);
    expect(fs.existsSync(path.join(absPath, 'fake'))).toBe(true);

    const manifest = readManifestSync(absPath);
    expect(manifest.assetCategories).toEqual([
      { displayName: 'Fake', directorySlug: 'fake', displayOrder: 0, enabled: true },
    ]);
  });

});
