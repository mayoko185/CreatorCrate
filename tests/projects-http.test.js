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

function expectProjectFormSchedulingStructure(html, { statusError = false, tagError = false } = {}) {
  const statusSection = extractProjectSettingsSection(html, 'Status');
  const schedulingSection = extractProjectSettingsSection(html, 'Scheduling');
  expect(statusSection).not.toBe('');
  expect(schedulingSection).not.toBe('');
  expect(html.indexOf('>Status</h3>')).toBeLessThan(html.indexOf('>Scheduling</h3>'));

  const statusRow = extractProjectFormRow(statusSection, 'status-row');
  const schedulingRow = extractProjectFormRow(schedulingSection, 'scheduling-row');
  expect(statusRow).not.toBe('');
  expect(schedulingRow).not.toBe('');

  const statusChildren = extractDirectHtmlChildren(statusRow);
  const schedulingChildren = extractDirectHtmlChildren(schedulingRow);
  expect(statusChildren).toHaveLength(2);
  expect(schedulingChildren).toHaveLength(2);
  expect(statusChildren.every((child) => child.startsWith('<div '))).toBe(true);
  expect(schedulingChildren.every((child) => child.startsWith('<div '))).toBe(true);

  const statusItem = statusChildren.find((child) => child.includes('project-status-form-trigger')) || '';
  const tagsItem = statusChildren.find((child) => child.includes('project-tags-form-trigger')) || '';
  const plannedDateItem = schedulingChildren.find((child) => child.includes('id="plannedDate"')) || '';
  const publishedDateItem = schedulingChildren.find((child) => child.includes('id="publishedDate"')) || '';

  expect(statusItem).not.toBe('');
  expect(tagsItem).not.toBe('');
  expect(plannedDateItem).not.toBe('');
  expect(publishedDateItem).not.toBe('');
  expect(statusItem).toMatch(/^<div class="field status-field">/);
  expect(tagsItem).toMatch(/^<div class="field status-field">/);
  expect(plannedDateItem).toMatch(/^<div class="field scheduling-field/);
  expect(publishedDateItem).toMatch(/^<div class="field scheduling-field/);
  expect(statusItem).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
  expect(tagsItem).toContain('data-cc-dropdown data-cc-dropdown-mode="multiple"');
  expect(tagsItem).toContain('<span class="help-text">Add new tags in <a href="/settings/tags">Settings › Tags</a>.</span>');
  expect(statusChildren.indexOf(statusItem)).toBeLessThan(statusChildren.indexOf(tagsItem));
  expect(schedulingChildren.indexOf(plannedDateItem)).toBeLessThan(schedulingChildren.indexOf(publishedDateItem));

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
  expect(cards).toHaveLength(4);
  expect(html).toMatch(/<section class="settings-section project-form-section">\s*<h3>Basic information<\/h3>/);
  expect(html).toMatch(/<section class="settings-section status-section project-form-section">\s*<h3>Status<\/h3>/);
  expect(html).toMatch(/<section class="settings-section scheduling-section project-form-section">\s*<h3>Scheduling<\/h3>/);
  expect(html).toMatch(/<section class="settings-section project-form-section">\s*<h3>Links<\/h3>/);
  expect(html.indexOf('>Status</h3>')).toBeLessThan(html.indexOf('>Scheduling</h3>'));
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

  async function createProject({ title, status = 'tbd', plannedDate, publishedDate }) {
    const fields = new URLSearchParams({
      title,
      status,
      _csrf: csrfToken,
    });
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

  it('dashboard renders counts and a new project action', async () => {
    const res = await agent.get('/').expect(200);
    expect(res.text).toContain('CreatorCrate');
    expect(res.text).toContain('New Project');
    expect(res.text).toContain('TBD');
    expect(res.text).toContain('View All Projects');
  });

  it('dashboard archived count reflects archived projects', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Archive+Count')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken));

    const res = await agent.get('/').expect(200);
    expect(res.text).toContain('<span class="count">1</span> Archived');
  });

  it('project list renders with application fallbacks and no canonical redirect when defaults are absent', async () => {
    const res = await agent.get('/projects').expect(200);
    expect(res.text).toContain('Projects');
    expect(res.text).toContain('No projects yet');
    expect(res.text).not.toContain('<input type="hidden" name="view"');
    expect(res.text).toContain('href="/projects?view=list"');
    expectProjectSortOrderSelection(res.text, 'created', 'desc');
    expect(extractStatusFilter(res.text)).toContain('aria-label="Status filter: All active"');
    expect(extractTagFilter(res.text)).toContain('aria-label="Tag filter: All tags"');
    expect(extractTagFilter(res.text)).toContain('No tags available');
    expect(extractProjectFilter(res.text)).toContain('aria-label="Project filter: All projects"');
    expect(extractProjectFilter(res.text)).toMatch(/No matching projects|No projects available/);
  });

  it('renders Projects defaults, the NSFW toggle, and icon-only Reset in order', async () => {
    const response = await agent.get('/projects').expect(200);
    const filterActions = response.text.match(/<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?<\/div>/)?.[0] || '';
    const defaultsLink = filterActions.match(/<a class="[^"]*\basset-viewer-defaults-link\b[^"]*"[\s\S]*?<\/a>/)?.[0];
    const nsfwForm = filterActions.match(/<form method="post" action="\/projects\/nsfw-filter"[\s\S]*?<\/form>/)?.[0];
    const resetLink = filterActions.match(/<a class="[^"]*\basset-tooltip\b[^"]*"[\s\S]*?aria-label="Reset filters"[\s\S]*?<\/a>/)?.[0];

    expect(defaultsLink).toBeDefined();
    expect(nsfwForm).toBeDefined();
    expect(resetLink).toBeDefined();
    expect(filterActions.indexOf('asset-viewer-defaults-link')).toBeLessThan(filterActions.indexOf('data-projects-nsfw-filter'));
    expect(filterActions.indexOf('data-projects-nsfw-filter')).toBeLessThan(filterActions.indexOf('aria-label="Reset filters"'));
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
    expect(resetLink).toContain('class="button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left"');
    expect(resetLink).toContain('href="/projects"');
    expect(resetLink).toContain('aria-label="Reset filters"');
    expect(resetLink).toContain('data-tooltip="Reset filters"');
    expect(resetLink).not.toContain('title=');
    expect(resetLink).toContain('<svg');
    expect(resetLink).not.toContain('>Reset</a>');
    expect(filterActions.match(/project-filter-control/g)).toHaveLength(3);
    expect(filterActions.match(/asset-tooltip--left/g)).toHaveLength(3);
    expect(filterActions).not.toContain('title=');

    expect((response.text.match(/<dialog id="projects-defaults-dialog"/g) || [])).toHaveLength(1);
    expect(response.text).toContain('<form id="projects-defaults-form" method="post" action="/projects/defaults"');
    expect(response.text).toContain('name="_csrf"');

    const defaultsDialog = response.text.match(/<dialog id="projects-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect((defaultsDialog.match(/data-cc-dropdown data-cc-dropdown-mode="single"/g) || [])).toHaveLength(3);
    for (const field of [
      { name: 'view', id: 'projects-default-view', values: ['grid', 'list'], selected: 'grid', summary: 'Grid' },
      {
        name: 'sort',
        id: 'projects-default-sort',
        values: ['updated', 'created', 'title', 'published'],
        selected: 'created',
        summary: 'Recently created',
      },
      { name: 'order', id: 'projects-default-order', values: ['asc', 'desc'], selected: 'desc', summary: 'Descending' },
    ]) {
      expect(defaultsDialog).toContain(`data-dialog-field="${field.name}"`);
      const nativeSelect = defaultsDialog.match(new RegExp(`<select id="${field.id}"[\\s\\S]*?<\\/select>`))?.[0] || '';
      expect(nativeSelect).not.toBe('');
      for (const value of field.values) expect(nativeSelect).toContain(`value="${value}"`);
      expect(nativeSelect).toMatch(new RegExp(`value="${field.selected}" selected`));
      expect(defaultsDialog).toMatch(new RegExp(
        `<select id="${field.id}" name="${field.name}"[^>]*data-cc-dropdown-native-select`,
      ));
      expect(defaultsDialog).toMatch(new RegExp(
        `<select[^>]*id="${field.id}"[^>]*required`,
      ));
      expect(defaultsDialog).toMatch(new RegExp(
        `id="${field.id}-dropdown"[^>]*data-cc-dropdown data-cc-dropdown-mode="single"`,
      ));
      expect(defaultsDialog).toContain(`class="asset-filter-multiselect-summary-current">${field.summary}</span>`);
      expect(defaultsDialog).toMatch(new RegExp(
        `<input[^>]*type="radio" value="${field.selected}"[^>]*checked`,
      ));
      expect(defaultsDialog).not.toMatch(new RegExp(`<input[^>]*name="${field.name}"`));
      expect((defaultsDialog.match(new RegExp(`name="${field.name}"`, 'g')) || [])).toHaveLength(1);
    }
    expect(defaultsDialog).not.toContain('field-error');
    expect(defaultsDialog).not.toMatch(/<select[^>]*aria-describedby/);
    expect(defaultsDialog).not.toContain('aria-invalid');
    expect(defaultsDialog).not.toContain('data-dialog-submitted-value');
    expect(defaultsDialog.indexOf('data-dialog-field="view"')).toBeLessThan(defaultsDialog.indexOf('data-dialog-field="sort"'));
    expect(defaultsDialog.indexOf('data-dialog-field="sort"')).toBeLessThan(defaultsDialog.indexOf('data-dialog-field="order"'));
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

  it('preserves the current Projects query in the normal NSFW fallback redirect', async () => {
    const returnTo = '/projects?search=needle&status=ready&tag=2&tag=3&view=list&page=2';
    const response = await agent
      .post('/projects/nsfw-filter')
      .type('form')
      .send({ enabled: '1', returnTo, _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe(returnTo);
    expect(app.locals.nsfwFilterSettingsService.isEnabled()).toBe(true);
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
  });

  it('saves all Projects defaults atomically through the enhanced JSON contract', async () => {
    const response = await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({ view: 'list', sort: 'published', order: 'asc', _csrf: csrfToken })
      .expect(200);

    expect(response.body).toEqual({
      status: 'success',
      message: 'Projects defaults saved successfully.',
      values: { view: 'list', sort: 'published', order: 'asc' },
    });
    expect(app.locals.pageDefaultsService.resolvePageDefaults('projects')).toEqual({
      view: 'list',
      sort: 'published',
      order: 'asc',
    });
  });

  it('rejects invalid Projects defaults without partially saving', async () => {
    saveProjectDefault('view', 'grid');
    saveProjectDefault('sort', 'created');
    saveProjectDefault('order', 'desc');

    const response = await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({ view: 'list', sort: 'not-valid', order: 'asc', _csrf: csrfToken })
      .expect(422);

    expect(response.body.status).toBe('error');
    expect(response.body.errors.sort).toContain('not-valid');
    expect(response.body.values).toEqual({ view: 'list', sort: 'not-valid', order: 'asc' });
    expect(app.locals.pageDefaultsService.resolvePageDefaults('projects')).toEqual({
      view: 'grid',
      sort: 'created',
      order: 'desc',
    });
  });

  it('marks server-rendered submitted Projects default options for dialog cleanup', async () => {
    const response = await agent
      .post('/projects/defaults')
      .type('form')
      .send({ view: 'list', sort: 'not-valid', order: 'asc', _csrf: csrfToken })
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
    const fallback = await agent
      .post('/projects/defaults')
      .type('form')
      .send({ view: 'list', sort: 'title', order: 'asc', _csrf: csrfToken })
      .expect(302);
    expect(fallback.headers.location).toBe('/projects?view=list&sort=title&order=asc&notice=projects_defaults_saved');

    await agent
      .post('/projects/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({ view: 'grid', sort: 'created', order: 'desc' })
      .expect(403);
  });

  it('renders status and tag standard multiselects with checked values', async () => {
    const firstTag = app.locals.tagService.createTag({ name: 'First Project Filter Tag' });
    const secondTag = app.locals.tagService.createTag({ name: 'Second Project Filter Tag' });

    const res = await agent
      .get(`/projects?status=planned&status=ready&tag=${secondTag.id}&tag=${firstTag.id}`)
      .expect(200);

    expect(res.text).toContain('<form id="project-filters" class="filters asset-viewer-filters asset-viewer-filters--projects" method="get" action="/projects">');
    const filterActions = res.text.match(/<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?<\/div>/)?.[0] || '';
    expect(filterActions).not.toContain('<button class="button" type="submit" form="project-filters">Filter</button>');
    expect(res.text).toContain('<noscript><button class="button" type="submit" form="project-filters">Filter</button></noscript>');
    expect(res.text).not.toContain('id="project-search"');
    expect(res.text).not.toContain('data-projects-search');
    expect(res.text.indexOf('<div class="asset-viewer-display-controls"')).toBeLessThan(res.text.indexOf('<form id="project-filters"'));
    expect(res.text).toMatch(/project-filter-actions[^>]*>[\s\S]*?<a class="button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left"[\s\S]*?href="\/projects"[\s\S]*?aria-label="Reset filters"/);
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
    const tagFilter = extractTagFilter(res.text);
    for (const [filter, inputName, mode] of [[statusFilter, 'status', 'multiple'], [tagFilter, 'tag', 'multiple']]) {
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
    expect(tagFilter).toContain('aria-label="Tag filter: 2 tags selected"');
    expect(tagFilter).toMatch(new RegExp(`name="tag"[^>]+value="${firstTag.id}" checked`));
    expect(tagFilter).toMatch(new RegExp(`name="tag"[^>]+value="${secondTag.id}" checked`));
    expect((tagFilter.match(/name="tag"/g) || [])).toHaveLength(2);
    expect(res.text).not.toMatch(/<select[^>]+(?:id="status"|id="tag"|name="status"|name="tag")/);

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
    expect(sortRadios).toHaveLength(4);
    for (const value of ['updated', 'created', 'title', 'published']) {
      expect(sortFilter).toMatch(new RegExp(`name="sort"[^>]*value="${value}"`));
    }
    expect((sortFilter.match(/name="sort"/g) || [])).toHaveLength(4);
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

  it('reset removes all selected status, tag, and project values', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Reset Filter Tag' });
    const projectId = await createProject({ title: 'Reset Filter Project', status: 'planned' });
    const selected = await agent
      .get(`/projects?status=planned&status=ready&tag=${tag.id}&project=${projectId}`)
      .expect(200);

    expect(selected.text).toContain('href="/projects"');
    expect(selected.text).toContain('aria-label="Reset filters"');
    const selectedFilterActions = selected.text.match(/<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?<\/div>/)?.[0] || '';
    expect(selectedFilterActions).not.toContain('>Reset</a>');
    expect(selected.text).not.toContain('Reset Filters');
    expect(extractProjectFilter(selected.text)).toContain(`value="${projectId}" checked`);

    const cleared = await agent.get('/projects').expect(200);
    expect(extractStatusFilter(cleared.text)).toContain('aria-label="Status filter: All active"');
    expect(extractStatusFilter(cleared.text)).not.toMatch(/name="status"[^>]+checked/);
    expect(extractTagFilter(cleared.text)).toContain('aria-label="Tag filter: All tags"');
    expect(extractTagFilter(cleared.text)).not.toMatch(/name="tag"[^>]+checked/);
    expect(extractProjectFilter(cleared.text)).toContain('aria-label="Project filter: All projects"');
    expect(extractProjectFilter(cleared.text)).not.toMatch(/name="project"[^>]+value="[0-9]+"[^>]*checked/);
  });

  it('renders Asset Viewer-style display controls and grid-size hooks only in Projects Grid view', async () => {
    await createProject({ title: 'Grid Controls Project' });
    const grid = await agent.get('/projects?view=grid').expect(200);
    expect(grid.text).toMatch(
      /<div class="asset-viewer-display-controls" data-project-grid-size-controls>\s*<nav class="view-switcher" aria-label="Project display">[\s\S]*?<\/nav>\s*<div class="asset-grid-size-controls asset-viewer-grid-size-controls" data-asset-grid-size-controls[\s\S]*?<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?aria-label="Reset filters"/
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
      /<div class="asset-viewer-display-controls">\s*<nav class="view-switcher" aria-label="Project display">[\s\S]*?<div class="project-filter-actions(?: [^"]*)?">[\s\S]*?aria-label="Reset filters"/
    );
    expect(list.text).not.toContain('data-asset-grid-size-controls');
    expect(list.text).not.toContain('data-grid-size-slider');
    expect(list.text).not.toContain('>Grid</a>');
    expect(list.text).not.toContain('>List</a>');
    expect(list.text).toMatch(/<a class="[^"]*view-switcher-option[^"]*" href="[^"]+"[^>]*aria-current="page"[^>]*aria-label="List view"/);
    expect(list.text).not.toMatch(/<a class="[^"]*view-switcher-option[^"]*" href="[^"]+"[^>]*aria-current="page"[^>]*aria-label="Grid view"/);
  });

  it('redirects a bare request to valid saved non-fallback Projects defaults', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const redirect = await agent.get('/projects').expect(302);
    expect(redirect.headers.location).toBe('/projects?sort=title&order=asc&view=list');

    const rendered = await agent.get(redirect.headers.location).expect(200);
    expect(rendered.text).toContain('<input type="hidden" name="view" value="list">');
    expectProjectSortOrderSelection(rendered.text, 'title', 'asc');
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

  it('accepts published as a valid Projects sort and renders the Published option selected', async () => {
    const res = await agent.get('/projects?sort=published').expect(200);
    expectProjectSortOrderSelection(res.text, 'published', 'desc');
  });

  it('sorts projects by published date with unpublished projects always last', async () => {
    const oldestId = await createProject({
      title: 'Published Older',
      publishedDate: '2025-01-01',
    });
    const newestId = await createProject({
      title: 'Published Newer',
      publishedDate: '2025-12-31',
    });
    const unpublishedId = await createProject({
      title: 'Published Unpublished',
    });
    const middleId = await createProject({
      title: 'Published Middle',
      publishedDate: '2025-06-15',
    });

    const asc = await agent.get('/projects?sort=published&order=asc').expect(200);
    expectProjectSortOrderSelection(asc.text, 'published', 'asc');
    const ascPositions = [
      asc.text.indexOf(`data-project-card-link href="/projects/${oldestId}"`),
      asc.text.indexOf(`data-project-card-link href="/projects/${middleId}"`),
      asc.text.indexOf(`data-project-card-link href="/projects/${newestId}"`),
      asc.text.indexOf(`data-project-card-link href="/projects/${unpublishedId}"`),
    ];
    expect(ascPositions.every((position) => position > -1)).toBe(true);
    expect(ascPositions).toEqual([...ascPositions].sort((a, b) => a - b));

    const desc = await agent.get('/projects?sort=published&order=desc').expect(200);
    expectProjectSortOrderSelection(desc.text, 'published', 'desc');
    const descPositions = [
      desc.text.indexOf(`data-project-card-link href="/projects/${newestId}"`),
      desc.text.indexOf(`data-project-card-link href="/projects/${middleId}"`),
      desc.text.indexOf(`data-project-card-link href="/projects/${oldestId}"`),
      desc.text.indexOf(`data-project-card-link href="/projects/${unpublishedId}"`),
    ];
    expect(descPositions.every((position) => position > -1)).toBe(true);
    expect(descPositions).toEqual([...descPositions].sort((a, b) => a - b));
  });

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
      plannedDate: '2026-09-01',
      publishedDate: '2026-10-01',
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

    expect(availableCard).toContain(`data-project-card-link href="/projects/${availableId}">Available Primary Image</a>`);
    expect(availableCard).toMatch(
      /<img class="project-card-media-image" data-preview-image src="\/projects\/\d+\/assets\/\d+\/preview\?v=[0-9a-f]+" alt="Preview of cover\.png" loading="lazy" decoding="async">/
    );
    expect(availableCard).toContain('data-preview-enhancement');
    expect(availableCard).toContain('data-preview-fallback');
    expect(availableCard).toContain(`class="project-card project-card--grid project-grid-card" data-project-card`);
    expect(availableCard).toContain(`class="project-grid-card-preview-link" href="/projects/${availableId}"`);
    expect(availableCard).not.toContain('project-list-card');
    expect(availableCard).not.toContain('/original');
    expect(availableCard).not.toContain('/thumbnail');
    expect(availableCard).not.toContain('project-grid-card-top');
    expect(availableCard).toMatch(
      /<div class="project-grid-card-status" aria-label="Project status">\s*<span class="status-badge status-badge--active">Ready<\/span>\s*<\/div>\s*<div class="project-grid-card-preview[\s\S]*?<a class="project-grid-card-preview-link"/
    );
    expect(availableCard).not.toContain('project-grid-card-priority');
    expect(availableCard).not.toMatch(/Priority:\s*High/);
    expect(availableCard).not.toMatch(/<dt>Priority<\/dt>/);
    expect(availableCard).toMatch(
      /<div class="project-grid-card-preview[\s\S]*?<div class="project-grid-card-info" data-project-info-card[^>]*>[\s\S]*?<h3 class="project-grid-card-info-heading">Project information<\/h3>[\s\S]*?<dt>Status<\/dt>/
    );
    expect(availableCard).toContain('data-project-grid-preview');
    expect(availableCard).toContain('<dl class="project-grid-card-info-list">');
    expect((availableCard.match(/class="project-grid-card-info-row"/g) || [])).toHaveLength(4);
    expect(availableCard).toContain('<div class="project-grid-card-info-section">');
    expect(availableCard).toContain('<span class="project-grid-card-info-section-label">Tags</span>');
    expect(availableCard).toContain('class="project-grid-card-info-empty">No tags assigned</span>');
    expect(availableCard).toMatch(
      /<div class="project-grid-card-title-area">\s*<h2 class="project-grid-card-title">\s*<a class="project-card-link"[^>]*>Available Primary Image<\/a>\s*<\/h2>\s*<\/div>/
    );

    expect(noneCard).toContain('data-primary-image-state="none"');
    expect(noneCard).toContain('No image');
    expect(noneCard).not.toContain('<img');

    expect(unavailableCard).toContain('data-primary-image-state="unavailable"');
    expect(unavailableCard).toContain('Image unavailable');
    expect(unavailableCard).not.toContain('<img');

    const availableRow = db.prepare('SELECT updated_at FROM projects WHERE id = ?').get(availableId);
    expect(availableCard).toMatch(/<dt>Status<\/dt>\s*<dd>[\s\S]*Ready[\s\S]*<\/dd>/);
    expect(availableCard).toContain(`<dt>Updated</dt>`);
    expect(availableCard).toContain(availableRow.updated_at);
    expect(availableCard).toMatch(/<dt>Planned<\/dt>\s*<dd>2026-09-01<\/dd>/);
    expect(availableCard).toMatch(/<dt>Published<\/dt>\s*<dd>2026-10-01<\/dd>/);
    expect(noneCard).toMatch(/<dt>Planned<\/dt>\s*<dd>—<\/dd>/);
    expect(noneCard).toMatch(/<dt>Published<\/dt>\s*<dd>—<\/dd>/);

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
    expect(availableListCard).toContain('<dt>Planned</dt>');
    expect(availableListCard).toContain('<dt>Published</dt>');
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
    expect(nsfwGridCard).toContain(`data-project-card-link href="/projects/${nsfwProjectId}">NSFW Project</a>`);
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
    const page = await agent.get('/projects').expect(200);
    const css = (await agent.get('/creatorcrate.css').expect(200)).text;

    expect(page.text).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
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
    expect(css).toMatch(/\.project-card--grid \.project-card-media\s*\{[\s\S]*?margin:\s*var\(--space-sm\) var\(--space-sm\) 0;/);
    expect(css).toMatch(/\.project-grid-card\s*\{[\s\S]*?position:\s*relative;[\s\S]*?overflow:\s*visible/);
    expect(css).toMatch(/\.project-grid-card:hover,[\s\S]*?\.project-grid-card:focus-within\s*\{[\s\S]*?z-index:\s*60/);
    expect(css).not.toMatch(/\.project-grid-card-top\s*\{/);
    expect(css).toMatch(/\.project-grid-card-status\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*flex-start;[\s\S]*?padding:\s*var\(--space-sm\)\s+var\(--space-sm\)\s+0;/);
    expect(css).not.toMatch(/\.project-grid-card-status\s*\{[^}]*position:\s*absolute;/);
    expect(css).not.toMatch(/\.project-grid-card-priority\s*\{/);
    expect(css).not.toMatch(/\.project-list-card-priority\s*\{/);
    expect(css).not.toMatch(/\.project-detail-priority\s*\{/);
    expect(css).toMatch(/\.project-grid-card-preview\s*\{[\s\S]*?position:\s*relative;[\s\S]*?overflow:\s*visible/);
    expect(css).toMatch(/\.project-grid-card-preview\s*\{[\s\S]*?--project-info-top:\s*0px;[\s\S]*?--project-info-left:\s*0px/);
    expect(css).toMatch(/\.project-grid-card-info\s*\{[\s\S]*?display:\s*none[\s\S]*?position:\s*absolute[\s\S]*?z-index:\s*30/);
    expect(css).toMatch(/\.project-grid-card-info\s*\{[\s\S]*?width:\s*min\(24rem,\s*calc\(100vw\s*-\s*2rem\)\)[\s\S]*?max-height:\s*calc\(100vh\s*-\s*1rem\)[\s\S]*?overflow:\s*auto[\s\S]*?padding:\s*var\(--space-md\)[\s\S]*?border:\s*1px solid var\(--border-strong\)[\s\S]*?border-radius:\s*var\(--radius-md\)[\s\S]*?background:\s*var\(--surface-card\)[\s\S]*?box-shadow:\s*var\(--shadow-lg\)[\s\S]*?opacity:\s*0[\s\S]*?visibility:\s*hidden[\s\S]*?pointer-events:\s*none[\s\S]*?transition:\s*opacity var\(--transition-fast\), transform var\(--transition-fast\), visibility var\(--transition-fast\)/);
    expect(css).toMatch(/\.project-grid-card-info\[data-positioned="true"\]\s*\{[\s\S]*?top:\s*var\(--project-info-top\)[\s\S]*?left:\s*var\(--project-info-left\)[\s\S]*?transform:\s*translateY\(-0\.25rem\)/);
    expect(css).not.toMatch(/\.project-grid-card:hover \.project-grid-card-info|\.project-grid-card:focus-within \.project-grid-card-info/);
    expect(css).toMatch(/\.project-grid-card-preview:hover \.project-grid-card-info,[\s\S]*?\.project-grid-card-preview:focus-within \.project-grid-card-info\s*\{[\s\S]*?display:\s*block/);
    expect(css).toMatch(/\.project-grid-card-info-row\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*minmax\(5\.5rem,\s*auto\)\s+minmax\(0,\s*1fr\)[\s\S]*?gap:\s*var\(--space-sm\)/);
    expect(css).toMatch(/\.project-grid-card-info-row dt,[\s\S]*?\.project-grid-card-info-section-label\s*\{[\s\S]*?font-size:\s*0\.6875rem[\s\S]*?text-transform:\s*uppercase/);
    expect(css).toMatch(/\.project-grid-card-info-section\s*\{[\s\S]*?margin-top:\s*var\(--space-sm\)[\s\S]*?padding-top:\s*var\(--space-sm\)[\s\S]*?border-top:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/\.project-grid-card-info-tags\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-wrap:\s*wrap[\s\S]*?gap:\s*var\(--space-xs\)/);
    expect(css).toMatch(/\.project-grid-card-info-tags li\s*\{[\s\S]*?padding:\s*0\.2rem 0\.45rem[\s\S]*?border-radius:\s*var\(--radius-sm\)[\s\S]*?background:\s*var\(--surface\)[\s\S]*?font-size:\s*0\.75rem/);
    expect(css).toMatch(/@media\s*\(max-width:\s*540px\)[\s\S]*?\.project-grid-card-info-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(5rem,\s*auto\)\s+minmax\(0,\s*1fr\)[\s\S]*?gap:\s*var\(--space-xs\)/);
    expect(css).not.toMatch(/\.project-card--grid \.project-card-details\s*\{[\s\S]*?display:/);
    expect(css).toMatch(/\.project-list-card\s*\{[\s\S]*?grid-template-columns:\s*clamp\(7rem,\s*20%,\s*15rem\)\s+minmax\(0,\s*1fr\)/);
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
    expect(res.text.indexOf('project-tags-form-trigger'))
      .toBeLessThan(res.text.indexOf('plannedDate'));
    expect(res.text.indexOf('plannedDate'))
      .toBeLessThan(res.text.indexOf('publishedDate'));
    expectProjectFormSchedulingStructure(res.text);
  });

  it('new-project form renders an empty tag catalog with a Settings link', async () => {
    const res = await agent.get('/projects/new').expect(200);
    const tagsField = extractProjectFormTagsField(res.text);
    expectProjectFormSchedulingStructure(res.text);
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

  it('new-project form uses the tbd fallback when no status default is saved', async () => {
    const res = await agent.get('/projects/new').expect(200);

    expectProjectFormStatusDisclosure(res.text, 'tbd');
    expect(res.text).not.toContain('id="priority"');
  });

  it('new-project form falls back to tbd when the stored status default is invalid', async () => {
    writeStoredNewProjectDefault('status', 'archived');
    writeLegacyNewProjectPriority('urgent');

    const res = await agent.get('/projects/new').expect(200);

    expectProjectFormStatusDisclosure(res.text, 'tbd');
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
    const res = await agent
      .post('/projects')
      .send('title=Test+Project')
      .send('description=A+test')
      .send('notes=notes')
      .send('status=tbd')
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
    expectProjectFormSchedulingStructure(res.text, { tagError: true });
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
    expect(res.text).toContain('value="2026-08-01"');
    expect(res.text).toContain('value="2026-08-15"');
    expect(res.text).toContain('value="example.com/not-patreon"');
    expect(res.text).toContain('Basic information');
    expect(res.text).toContain('>Status</h3>');
    expect(res.text).toContain('>Scheduling</h3>');
    expect(res.text).toContain('Links');
    expect(res.text).toContain('href="/projects"');
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
    expect(dialog).toContain('<h2 id="project-edit-dialog-title">Edit Project</h2>');
    expect(dialog).toContain('Edit project details, status, scheduling, and links.');
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
    expect(dialog).toContain('>Scheduling</h3>');
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
    const scheduling = extractProjectSettingsSection(dialog, 'Scheduling');
    expect(scheduling).not.toBe('');
    expect(scheduling).toContain('id="plannedDate"');
    expect(scheduling).toContain('id="publishedDate"');
    expectProjectFormSchedulingStructure(dialog);
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
    expect(dialog).toContain('data-confirm="Archive this project? This cannot be undone."');
    expect(dialog).toContain(`<form method="post" action="${location}/delete">`);
    expect(dialog).toContain('Permanently delete this project and its owned data. This cannot be undone.');
    expect(dialog).toContain('data-confirm="Delete this project permanently? This cannot be undone."');
    expect(dialog).toContain(`name="_csrf" value="${csrfToken}"`);
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
    expect(css).toMatch(/#project-edit-dialog\s*\{[^}]*width:\s*min\(51rem,\s*calc\(100vw - 2rem\)\)/);
    expect(css).not.toMatch(/#project-edit-dialog\s*\{[^}]*width:\s*min\(68rem,\s*calc\(100vw - 2rem\)\)/);
    expect(css).toMatch(/#project-asset-category-management-dialog\s*\{[^}]*width:\s*min\(68rem,\s*calc\(100vw - 2rem\)\)/);
    expect(css).toMatch(/\.project-detail-meta\s*\{[^}]*justify-content:\s*space-between/);
    expect(css).toMatch(/\.project-detail-action-toolbar\s*\{[^}]*margin-left:\s*auto/);
    expect(css).toMatch(/\.project-detail-action\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*min-block-size:\s*2\.25rem[^}]*min-inline-size:\s*2\.25rem[^}]*padding:\s*var\(--space-sm\)/);
    expect(css).toMatch(/\.project-detail-action svg\s*\{[^}]*width:\s*1\.25rem[^}]*height:\s*1\.25rem/);
    const projectEditBodyRule = css.match(/#project-edit-dialog \.app-dialog-body > \*\s*\{[^}]*\}/)?.[0] || '';
    expect(projectEditBodyRule).toContain('flex-shrink: 0');
    const projectEditPanelRule = css.match(/#project-edit-dialog \.project-edit-dialog-section\s*\{[^}]*\}/)?.[0] || '';
    expect(projectEditPanelRule).toContain('background: var(--surface)');
    expect(projectEditPanelRule).toContain('border: 1px solid var(--border)');
    expect(projectEditPanelRule).toContain('border-radius: var(--radius-lg)');
    expect(projectEditPanelRule).toContain('overflow: visible');
    expect(css).toContain('#project-edit-dialog .project-edit-dialog-section > h3');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*#project-edit-dialog \.status-row,[\s\S]*#project-edit-dialog \.scheduling-row[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
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

    const project = db.prepare('SELECT title, status, planned_date FROM projects WHERE id = ?').get(id);
    expect(project.title).toBe('Stale Tag Edit');
    expect(project.status).toBe('tbd');
    expect(project.planned_date).toBe('2026-08-01');

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
    expectProjectFormSchedulingStructure(res.text, { statusError: true });
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
    expectProjectFormSchedulingStructure(dialog, { statusError: false });
    expect(res.text).not.toContain('id="priority"');
    expect(dialog).toContain('value="2026-10-01"');
    expect(dialog).toContain('value="2026-10-15"');
    expect(dialog).toContain('value="not-a-url"');
    expect(dialog).toContain('Basic information');
    expect(dialog).toContain('>Status</h3>');
    expect(dialog).toContain('>Scheduling</h3>');
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
    expect(detail.text).toContain('Archived');
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

  it('archived project appears under archived filter and dashboard count', async () => {
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

    const dashboard = await agent.get('/').expect(200);
    expect(dashboard.text).toContain('<span class="count">1</span> Archived');
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

    it('filesystem conflict during creation renders safe error with preserved values', async () => {
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
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);

      expect(res.text).toContain('Project creation failed');
      expect(res.text).toContain('Conflict Create');
      expect(res.text).toContain('Value kept');
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
        .send('status=archived')  // rejected by WORKFLOW_STATUSES validation
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

  // ─── Phase 7D-3: Project planning field wording ──────────────────────
  //
  // Project planning fields (planned_date, published_date, patreon_url)
  // describe the broader creative project, not an individual release.
  // Help text must clarify this distinction.

  describe('project form planning field wording', () => {
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

    it('project form shows help text for planned date in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'plannedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('Target date for the creative project');
      // Verify the input is inside the same container
      expect(container).toMatch(/<input[^>]*id="plannedDate"[^>]*>/);
    });

    it('project form shows help text for published date in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'publishedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('When the project was published');
      expect(container).toMatch(/<input[^>]*id="publishedDate"[^>]*>/);
    });

    it('project form renders canonical date-picker controls for planned and published dates', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const statusRow = extractProjectFormRow(res.text, 'status-row');
      const schedulingRow = extractProjectFormRow(res.text, 'scheduling-row');
      expect(statusRow).not.toBe('');
      expect(schedulingRow).not.toBe('');

      expect(statusRow).toContain('id="project-status-form-trigger"');
      expect(statusRow).toMatch(/<input[^>]*name="status"[^>]*type="radio"[^>]*value="tbd"[^>]*checked/);
      expect(schedulingRow).toMatch(/<input class="picker-input"[^>]*type="date"[^>]*id="plannedDate"[^>]*name="plannedDate"[^>]*aria-describedby="plannedDate-help"[^>]*data-date-picker-input>/);
      expect(schedulingRow).toMatch(/<input class="picker-input"[^>]*type="date"[^>]*id="publishedDate"[^>]*name="publishedDate"[^>]*aria-describedby="publishedDate-help"[^>]*data-date-picker-input>/);
      expect(schedulingRow).toContain('Target date for the creative project');
      expect(schedulingRow).toContain('When the project was published');
      expect(schedulingRow).not.toContain('plannedTime');
      expect(schedulingRow).not.toContain('time-picker');

      expect(schedulingRow.match(/<div class="picker-control">/g) || []).toHaveLength(2);
      expect(schedulingRow.match(/<div class="picker-input-row">/g) || []).toHaveLength(2);
      expect(schedulingRow.match(/<input class="picker-input"[^>]*>/g) || []).toHaveLength(2);
      const pickerTriggers = schedulingRow.match(/<button[^>]*class="picker-trigger[^"]*"[^>]*>/g) || [];
      expect(pickerTriggers).toHaveLength(2);
      expect(pickerTriggers.every((button) => /\btype="button"/.test(button))).toBe(true);
      expect(schedulingRow).toMatch(/<button[^>]*class="picker-trigger date-picker-trigger"[^>]*aria-controls="plannedDate-calendar"[^>]*>/);
      expect(schedulingRow).toMatch(/<button[^>]*class="picker-trigger date-picker-trigger"[^>]*aria-controls="publishedDate-calendar"[^>]*>/);
      expect(schedulingRow).toMatch(/<div[^>]*id="plannedDate-calendar"[^>]*class="date-picker-panel"[^>]*role="dialog"[^>]*aria-label="Planned date calendar"[^>]*hidden[^>]*data-date-picker-panel[^>]*data-date-picker-for="plannedDate"[^>]*>/);
      expect(schedulingRow).toMatch(/<div[^>]*id="publishedDate-calendar"[^>]*class="date-picker-panel"[^>]*role="dialog"[^>]*aria-label="Published date calendar"[^>]*hidden[^>]*data-date-picker-panel[^>]*data-date-picker-for="publishedDate"[^>]*>/);
      expect(schedulingRow).not.toContain('aria-modal="true"');
    });

    it('project form shows generic project-link help text in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'patreonUrl');
      expect(container).not.toBeNull();
      expect(container).toContain('<label for="patreonUrl">Project link</label>');
      expect(container).toContain('Optional absolute HTTP or HTTPS URL for this project.');
      expect(container).toMatch(/<input[^>]*id="patreonUrl"[^>]*>/);
    });

    it('project detail shows description, planned date, and the project link, and omits the published date', async () => {
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

      // Planned date remains a labelled dt/dd pair in the Details list.
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
        'Planned date',
        'Description',
        'Project link',
      ]);
      expect(details).toContain('<dd class="description">Project description</dd>');
      expect(details).toMatch(/<dt>Project link<\/dt>\s*<dd><a class="project-detail-link" href="https:\/\/patreon\.com\/test" target="_blank" rel="noopener">Project link<\/a><\/dd>/);
      const plannedDt = details.match(/<dt>Planned date<\/dt>\s*<dd>[^<]*(?:<small>\(project target\)<\/small>)[^<]*<\/dd>/);
      expect(plannedDt).not.toBeNull();
      expect(res.text).not.toContain('<p class="description">Project description</p>');
      expect(meta).not.toContain('project-detail-link');

      // Published date is intentionally not rendered in the read-only detail
      // list; it remains available in the edit dialog.
      expect(details).not.toContain('Published date');
    });

    it('project detail renders the established missing value for empty description and planned date, and omits an absent project link', async () => {
      const id = await createProject({ title: 'Optional Detail Fields Empty' });

      const res = await agent.get(`/projects/${id}`).expect(200);
      const details = extractProjectDetailSection(res.text, 'project-detail-info');

      expect(details).toMatch(/<dt>Description<\/dt>\s*<dd class="description">—<\/dd>/);
      expect(details).toMatch(/<dt>Planned date<\/dt>\s*<dd>—<\/dd>/);
      expect(details).not.toContain('project-detail-link');
      expect(details).toContain('<dt>Slug</dt>');
      expect(details).toContain('<dt>Created</dt>');
      expect(details).toContain('<dt>Updated</dt>');
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
    expect(releases).toContain('href="/release-management?project=' + projectId + '"');
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

    it('keeps the archived asset categories page reachable even though the detail header no longer links it', async () => {
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

      // Asset Categories is reached from the assets page, not the project detail
      // header, but the page itself remains reachable directly.
      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).not.toContain(`/projects/${id}/asset-categories`);
      await agent.get(`/projects/${id}/asset-categories`).expect(200);
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
