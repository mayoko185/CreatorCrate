import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { MANIFEST_FILENAME, readManifestSync } from '../src/storage/manifest.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import {
  STATUS_DIR_MAP,
  formatProjectDirName,
  buildProjectRelPath,
  resolveProjectDir,
} from '../src/storage/project-storage.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { makeZip } from './helpers/zip-fixture.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function extractProjectCard(html, projectId) {
  const cards = html.match(/<article\b[^>]*data-project-card[^>]*>[\s\S]*?<\/article>/g) || [];
  return cards.find((card) => card.includes(`data-project-card-link href="/projects/${projectId}"`)) || '';
}

function extractProjectCards(html) {
  return html.match(/<article\b[^>]*data-project-card[^>]*>[\s\S]*?<\/article>/g) || [];
}

function extractPageHeadingActions(html) {
  return html.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
}

function extractProjectTags(card) {
  return card.match(/<div class="project-card-meta project-card-meta--tags">([\s\S]*?)<\/div>/)?.[0] || '';
}

function extractTagFilter(html) {
  return html.match(/<select id="tag"[\s\S]*?<\/select>/)?.[0] || '';
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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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

  async function createProject({ title, status = 'tbd', priority = 'normal', plannedDate, publishedDate }) {
    const fields = new URLSearchParams({
      title,
      status,
      priority,
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
    expect(res.text).toContain('<option value="created" selected>Created</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
    expect(extractTagFilter(res.text)).toContain('<select id="tag" name="tag" disabled>');
    expect(extractTagFilter(res.text)).toContain('<option value="" selected>All tags</option>');
  });

  it('redirects a bare request to valid saved non-fallback Projects defaults', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const redirect = await agent.get('/projects').expect(302);
    expect(redirect.headers.location).toBe('/projects?sort=title&order=asc&view=list');

    const rendered = await agent.get(redirect.headers.location).expect(200);
    expect(rendered.text).toContain('<input type="hidden" name="view" value="list">');
    expect(rendered.text).toContain('<option value="title" selected>Title</option>');
    expect(rendered.text).toContain('<option value="asc" selected>Asc</option>');
  });

  it('uses application fallbacks for invalid stored Projects defaults', async () => {
    writeStoredProjectDefault('view', 'board');
    writeStoredProjectDefault('sort', 'published');
    writeStoredProjectDefault('order', 'forwards');

    const res = await agent.get('/projects').expect(200);
    expect(res.text).not.toContain('<input type="hidden" name="view"');
    expect(res.text).toContain('href="/projects?view=list"');
    expect(res.text).toContain('<option value="created" selected>Created</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
    expect(res.headers.location).toBeUndefined();
  });

  it('gives valid explicit values precedence while resolving omitted options from saved defaults', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const res = await agent.get('/projects?view=grid&sort=updated').expect(200);
    expect(res.text).not.toContain('<ul class="project-list">');
    expect(res.text).toContain('<option value="updated" selected>Updated</option>');
    expect(res.text).toContain('<option value="asc" selected>Asc</option>');
    expect(res.text).toContain('<input type="hidden" name="view" value="grid">');
    expect(res.text).toContain('href="/projects?sort=updated&amp;order=asc&amp;view=grid"');
  });

  it('keeps invalid explicit presentation values on application fallbacks instead of saved values', async () => {
    saveProjectDefault('view', 'list');
    saveProjectDefault('sort', 'title');
    saveProjectDefault('order', 'asc');

    const res = await agent.get('/projects?view=invalid&sort=invalid&order=invalid').expect(200);
    expect(res.text).toContain('<input type="hidden" name="view" value="grid">');
    expect(res.text).toContain('<option value="created" selected>Created</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
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
    expect(res.text).toContain('<option value="created" selected>Created</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
  });

  it('renders one semantic project card per row with primary-image states and retained metadata', async () => {
    const availableId = await createProject({
      title: 'Available Primary Image',
      status: 'ready',
      priority: 'high',
      plannedDate: '2026-09-01',
      publishedDate: '2026-10-01',
    });
    const noneId = await createProject({
      title: 'No Image Missing Dates',
      status: 'tbd',
      priority: 'low',
    });
    const unavailableId = await createProject({
      title: 'Unavailable Primary Image',
      status: 'planned',
      priority: 'normal',
    });

    seedPrimaryImage(availableId);
    const unavailableAsset = seedPrimaryImage(unavailableId, 'unavailable.png');
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(unavailableAsset.id);

    const res = await agent.get('/projects').expect(200);
    const availableCard = extractProjectCard(res.text, availableId);
    const noneCard = extractProjectCard(res.text, noneId);
    const unavailableCard = extractProjectCard(res.text, unavailableId);

    expect(res.text).toContain('<ul class="project-grid">');
    expect(res.text).not.toContain('<table class="data-table">');
    expect(res.text.match(/<li class="project-grid-item">/g)).toHaveLength(3);
    expect(res.text.match(/<article class="project-card[^"]*" data-project-card>/g)).toHaveLength(3);

    expect(availableCard).toContain(`data-project-card-link href="/projects/${availableId}">Available Primary Image</a>`);
    expect(availableCard).toMatch(
      /<img class="project-card-media-image" data-preview-image src="\/projects\/\d+\/assets\/\d+\/preview\?v=[0-9a-f]+" alt="Preview of cover\.png" loading="lazy" decoding="async">/
    );
    expect(availableCard).toContain('data-preview-enhancement');
    expect(availableCard).toContain('data-preview-fallback');
    expect(availableCard).not.toContain('/original');
    expect(availableCard).not.toContain('/thumbnail');
    expect(availableCard).toMatch(
      /<h2 class="project-card-title">\s*<a class="project-card-link"[^>]*>Available Primary Image<\/a>\s*<\/h2>\s*<div class="project-card-details">/
    );

    expect(noneCard).toContain('data-primary-image-state="none"');
    expect(noneCard).toContain('No image');
    expect(noneCard).not.toContain('<img');

    expect(unavailableCard).toContain('data-primary-image-state="unavailable"');
    expect(unavailableCard).toContain('Image unavailable');
    expect(unavailableCard).not.toContain('<img');

    const availableRow = db.prepare('SELECT updated_at FROM projects WHERE id = ?').get(availableId);
    expect(availableCard).toMatch(/<dt>Status<\/dt>\s*<dd>[\s\S]*Ready[\s\S]*<\/dd>/);
    expect(availableCard).toMatch(/<dt>Priority<\/dt>\s*<dd>High<\/dd>/);
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
    expect(availableListCard).toContain('class="project-card project-card--list"');
    expect(availableListCard).toMatch(
      /<img class="project-card-media-image project-card-media-image--list" data-preview-image src="\/projects\/\d+\/assets\/\d+\/thumbnail\?v=[0-9a-f]+"/
    );
    expect(availableListCard).not.toContain('/preview');
    expect(availableListCard).not.toContain('/original');
    expect(availableListCard).toContain('<dt>Status</dt>');
    expect(availableListCard).toContain('<dt>Priority</dt>');
    expect(availableListCard).toContain('<dt>Updated</dt>');
    expect(availableListCard).toContain('<dt>Planned</dt>');
    expect(availableListCard).toContain('<dt>Published</dt>');
    expect(noneListCard).not.toContain('<img');
    expect(noneListCard).toContain('data-primary-image-state="none"');
    expect(unavailableListCard).not.toContain('<img');
    expect(unavailableListCard).toContain('data-primary-image-state="unavailable"');
  });

  it('serves scoped responsive project-card presentation contracts', async () => {
    const page = await agent.get('/projects').expect(200);
    const css = (await agent.get('/creatorcrate.css').expect(200)).text;

    expect(page.text).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
    expect(css).toMatch(/\.project-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*17rem\),\s*1fr\)\)/);
    expect(css).toMatch(/\.project-card-media-image\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/);
    expect(css).not.toMatch(/\.project-card[^{}]*\{[^}]*aspect-ratio\s*:/);
    expect(css).not.toMatch(/\.project-card[^{}]*\{[^}]*object-fit\s*:\s*cover/);
    expect(css).toMatch(/\.project-card-link\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.project-card \.project-card-link,\s*\.project-card \.project-card-link:visited\s*\{[^}]*color:\s*#fff;/);
    expect(css).not.toMatch(/\.project-card--archived \.project-card-link\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(css).toMatch(/\.project-card-meta dd\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/@media\s*\(max-width:\s*540px\)\s*\{[\s\S]*?\.project-card-meta\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.project-card:focus-within\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)[\s\S]*?transform:\s*scale\(1\.01\)/);
    expect(css).toMatch(/\.project-card--grid \.project-card-media\s*\{[\s\S]*?margin:\s*var\(--space-sm\) var\(--space-sm\) 0;/);
    expect(css).toMatch(/\.project-card--grid \.project-card-details\s*\{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/\.project-card--grid:hover \.project-card-details,[\s\S]*?\.project-card--grid:focus-within \.project-card-details\s*\{[\s\S]*?display:\s*flex;/);
    expect(css).toMatch(/@media\s*\(hover:\s*none\)\s*\{[\s\S]*?\.project-card--grid \.project-card-details\s*\{[\s\S]*?display:\s*flex;/);
    expect(css).toMatch(/\.project-card--list \.project-card-media-image\s*\{[\s\S]*?width:\s*auto;[\s\S]*?height:\s*auto;[\s\S]*?max-width:\s*4rem;[\s\S]*?max-height:\s*4rem;/);
    expect(css).not.toMatch(/\.project-card--list \.project-card-media-image\s*\{[^}]*object-fit\s*:\s*cover/);
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
    expect(gridTags).toContain('<dt>Tags</dt>');
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
    expect(extractProjectTags(untaggedGridCard)).toBe('');
    expect(grid.text).not.toContain('name="tagIds"');
    const gridTagFilter = extractTagFilter(grid.text);
    expect(gridTagFilter).toContain('<option value="" selected>All tags</option>');
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
    expect(extractProjectTags(taggedListCard)).toContain('Alpha Display');
    expect(extractProjectTags(taggedListCard)).toContain('Shared Display');
    expect(extractProjectTags(taggedListCard)).toContain('Zebra Display');
    expect(extractProjectTags(secondTaggedListCard)).toContain('Shared Display');
    expect(extractProjectTags(untaggedListCard)).toBe('');
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
    expect(filtered.text).not.toContain('Needle Other Tag');
    expect(filtered.text).not.toContain('Asset Only Filter');
    expect(filtered.text.match(/<article\b[^>]*data-project-card[^>]*>/g)).toHaveLength(4);
    expect(extractTagFilter(filtered.text)).toContain(
      `<option value="${shared.id}" selected>Shared Filter Tag</option>`,
    );

    const composed = await agent
      .get(`/projects?tag=${shared.id}&search=needle&status=planned&sort=title&order=asc&view=list`)
      .expect(200);
    expect(composed.text).toContain('1 project found');
    expect(composed.text).toContain('Needle Planned');
    expect(composed.text).not.toContain('Needle Ready');
    expect(composed.text).not.toContain('Needle Other Tag');
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
    expect(archived.text).not.toContain('Needle Planned');
  });

  it('normalizes empty, malformed, nonexistent, and deleted tag values to the unfiltered state', async () => {
    const tag = app.locals.tagService.createTag({ name: 'Safe Filter Tag' });
    const taggedId = await createProject({ title: 'Safe Tagged Project', status: 'planned' });
    await createProject({ title: 'Safe Untagged Project', status: 'planned' });
    app.locals.projectTagService.replaceProjectTags(taggedId, [tag.id]);

    for (const rawTag of ['', '0', '-1', 'not-a-tag', '1.5', '999999']) {
      const response = await agent
        .get(`/projects?tag=${encodeURIComponent(rawTag)}&search=Safe&view=list`)
        .expect(200);

      expect(response.text).toContain('Safe Tagged Project');
      expect(response.text).toContain('Safe Untagged Project');
      expect(extractTagFilter(response.text)).toContain('<option value="" selected>All tags</option>');
      expect(extractTagFilter(response.text)).not.toContain(`value="${tag.id}" selected`);
    }

    app.locals.tagService.deleteTag(tag.id);
    const deleted = await agent
      .get(`/projects?tag=${tag.id}&search=Safe&status=planned&view=list`)
      .expect(200);

    expect(deleted.text).toContain('Safe Tagged Project');
    expect(deleted.text).toContain('Safe Untagged Project');
    expect(extractTagFilter(deleted.text)).not.toContain(`value="${tag.id}"`);
    expect(deleted.text).toContain('href="/projects?search=Safe&amp;status=planned&amp;view=list"');
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
    expect(created.text).toContain('<option value="created" selected>Created</option>');
    expect(created.text.indexOf(`data-project-card-link href="/projects/${newerCreatedId}"`))
      .toBeLessThan(created.text.indexOf(`data-project-card-link href="/projects/${olderCreatedId}"`));

    const updated = await agent.get('/projects?sort=updated&order=asc').expect(200);
    expect(updated.text).toContain('<option value="updated" selected>Updated</option>');
    expect(updated.text.indexOf(`data-project-card-link href="/projects/${newerCreatedId}"`))
      .toBeLessThan(updated.text.indexOf(`data-project-card-link href="/projects/${olderCreatedId}"`));
  });

  it('normalizes project view state and preserves allowed query values', async () => {
    const tag = app.locals.tagService.createTag({ name: 'View State Tag' });
    for (let i = 0; i < 26; i += 1) {
      const projectId = await createProject({ title: `View State ${String(i).padStart(2, '0')}`, status: 'planned' });
      app.locals.projectTagService.replaceProjectTags(projectId, [tag.id]);
    }

    const list = await agent.get(`/projects?search=View+State&status=planned&tag=${tag.id}&sort=title&order=asc&view=list&unknown=discarded`).expect(200);
    expect(list.text).toContain('<ul class="project-list">');
    expect(list.text).toContain('name="view" value="list"');
    expect(list.text).toContain(`href="/projects?search=View+State&amp;status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc"`);
    expect(list.text).toContain(`href="/projects?search=View+State&amp;status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list"`);
    expect(list.text).toContain(`href="/projects?search=View+State&amp;status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=2"`);
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
      .get(`/projects?search=Canonical+Project&status=planned&tag=${tag.id}&page=2&unknown=discarded`)
      .expect(302);
    expect(redirect.headers.location)
      .toBe(`/projects?search=Canonical+Project&status=planned&tag=${tag.id}&sort=title&order=asc&view=list&page=2`);

    const pageTwo = await agent.get(redirect.headers.location).expect(200);
    expect(pageTwo.text).toContain('<ul class="project-list">');
    expect(pageTwo.text).toContain('Canonical Project 25');
    expect(pageTwo.text).not.toContain('unknown=discarded');
    expect(pageTwo.text).toContain(
      `href="/projects?search=Canonical+Project&amp;status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=1"`
    );

    const pageOne = await agent
      .get(`/projects?search=Canonical+Project&status=planned&tag=${tag.id}&sort=title&order=asc&view=list`)
      .expect(200);
    expect(pageOne.text).toContain(
      `href="/projects?search=Canonical+Project&amp;status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=list&amp;page=2"`
    );
    expect(pageOne.text).toContain(
      `href="/projects?search=Canonical+Project&amp;status=planned&amp;tag=${tag.id}&amp;sort=title&amp;order=asc&amp;view=grid"`
    );
    expect(pageOne.text).toContain('<input type="hidden" name="view" value="list">');
    expect(pageOne.text).toContain('<option value="title" selected>Title</option>');
    expect(pageOne.text).toContain('<option value="asc" selected>Asc</option>');
    expect(pageOne.text).not.toContain('unknown=discarded');
  });

  it('new-project form renders', async () => {
    const res = await agent.get('/projects/new').expect(200);
    expect(res.text).toContain('Create Project');
    expect(res.text).toContain('Title');
    expect(res.text).not.toContain('value="archived"');
    expect(res.text).toContain('<option value="normal" selected>Normal</option>');
    expect(res.text).not.toContain('<option value="low" selected>Low</option>');
  });

  it('new-project form seeds valid saved New Project status and priority defaults', async () => {
    saveNewProjectDefault('status', 'ready');
    saveNewProjectDefault('priority', 'high');

    const res = await agent.get('/projects/new').expect(200);

    expect(res.text).toContain('<option value="ready" selected>Ready</option>');
    expect(res.text).not.toContain('<option value="tbd" selected>Tbd</option>');
    expect(res.text).toContain('<option value="high" selected>High</option>');
    expect(res.text).not.toContain('<option value="normal" selected>Normal</option>');
  });

  it('new-project form uses tbd/normal fallbacks when no defaults are saved', async () => {
    const res = await agent.get('/projects/new').expect(200);

    expect(res.text).toContain('<option value="tbd" selected>Tbd</option>');
    expect(res.text).toContain('<option value="normal" selected>Normal</option>');
    expect(res.text).not.toContain('<option value="ready" selected>Ready</option>');
    expect(res.text).not.toContain('<option value="high" selected>High</option>');
  });

  it('new-project form falls back to tbd/normal when stored defaults are invalid', async () => {
    writeStoredNewProjectDefault('status', 'archived');
    writeStoredNewProjectDefault('priority', 'urgent');

    const res = await agent.get('/projects/new').expect(200);

    expect(res.text).toContain('<option value="tbd" selected>Tbd</option>');
    expect(res.text).toContain('<option value="normal" selected>Normal</option>');
  });

  it('rejected create submission preserves submitted status/priority over saved defaults', async () => {
    saveNewProjectDefault('status', 'ready');
    saveNewProjectDefault('priority', 'high');

    const res = await agent
      .post('/projects')
      .send('title=')
      .send('status=in-progress')
      .send('priority=low')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('<option value="in-progress" selected>In Progress</option>');
    expect(res.text).toContain('<option value="low" selected>Low</option>');
    expect(res.text).not.toContain('<option value="ready" selected>Ready</option>');
    expect(res.text).not.toContain('<option value="high" selected>High</option>');
  });

  it('successful create uses submitted status/priority, not saved defaults', async () => {
    saveNewProjectDefault('status', 'ready');
    saveNewProjectDefault('priority', 'high');

    const res = await agent
      .post('/projects')
      .send('title=Submitted+Wins')
      .send('status=planned')
      .send('priority=low')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(res.headers.location.replace('/projects/', ''));
    const project = db.prepare('SELECT status, priority FROM projects WHERE id = ?').get(id);
    expect(project.status).toBe('planned');
    expect(project.priority).toBe('low');
  });

  it('edit form shows stored project values even when New Project defaults differ', async () => {
    saveNewProjectDefault('status', 'ready');
    saveNewProjectDefault('priority', 'high');
    const id = await createProject({ title: 'Editable', status: 'in-progress', priority: 'low' });

    const res = await agent.get(`/projects/${id}/edit`).expect(200);

    expect(res.text).toContain('<option value="in-progress" selected>In Progress</option>');
    expect(res.text).toContain('<option value="low" selected>Low</option>');
    expect(res.text).not.toContain('<option value="ready" selected>Ready</option>');
    expect(res.text).not.toContain('<option value="high" selected>High</option>');
  });

  it('valid create request redirects to detail', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Test+Project')
      .send('description=A+test')
      .send('notes=notes')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toMatch(/^\/projects\/\d+$/);
  });

  it('omitted create priority defaults to normal in the database and manifest', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Default+Priority')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(res.headers.location.replace('/projects/', ''));
    const row = db.prepare('SELECT priority, project_dir FROM projects WHERE id = ?').get(id);
    expect(row.priority).toBe('normal');

    const manifest = readManifestSync(resolveProjectDir(projectsRoot, row.project_dir));
    expect(manifest.priority).toBe('normal');
  });

  it.each(['low', 'high'])('explicit %s priority remains unchanged on create', async (priority) => {
    const res = await agent
      .post('/projects')
      .send(`title=Explicit+${priority}`)
      .send('status=tbd')
      .send(`priority=${priority}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(res.headers.location.replace('/projects/', ''));
    const row = db.prepare('SELECT priority, project_dir FROM projects WHERE id = ?').get(id);
    expect(row.priority).toBe(priority);

    const manifest = readManifestSync(resolveProjectDir(projectsRoot, row.project_dir));
    expect(manifest.priority).toBe(priority);
  });

  it.each(['', 'urgent'])('invalid create priority %j returns a controlled validation error', async (priority) => {
    const res = await agent
      .post('/projects')
      .send(`title=Invalid+Priority+${priority || 'Empty'}`)
      .send('status=tbd')
      .send(`priority=${encodeURIComponent(priority)}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('Priority must be one of');
    expect(res.text).not.toContain('<option value="normal" selected>Normal</option>');
  });

  it('invalid create request rerenders with values and errors', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Create+Preserves')
      .send('description=A')
      .send('notes=Create+notes')
      .send('status=ready')
      .send('priority=high')
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
    expect(res.text).toContain('<option value="ready" selected>Ready</option>');
    expect(res.text).toContain('<option value="high" selected>High</option>');
    expect(res.text).toContain('value="2026-08-01"');
    expect(res.text).toContain('value="2026-08-15"');
    expect(res.text).toContain('value="example.com/not-patreon"');
    expect(res.text).toContain('Basic information');
    expect(res.text).toContain('Status and scheduling');
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

  it('active project detail places project actions in the page heading', async () => {
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

    expect(res.text).toContain('Detail Project');
    expect(headingActions).toContain(`href="${location}/edit">Edit project</a>`);
    expect(headingActions).toContain(`href="${location}/assets">View Assets</a>`);
    expect(headingActions).toContain(`href="${location}/tags">Manage tags</a>`);
    // Asset Categories is reached from the assets page, not the detail header.
    expect(headingActions).not.toContain(`href="${location}/asset-categories"`);
    expect((headingActions.match(/<a\b/g) || [])).toHaveLength(3);
    expect(res.text).not.toMatch(
      new RegExp(`<section class="workflow-actions">\\s*<a[^>]+href="${location}/assets"`),
    );
  });

  it('archived project detail keeps read-safe actions in the page heading without Edit', async () => {
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

    expect(headingActions).toContain(`href="${location}/assets">View Assets</a>`);
    expect(headingActions).not.toContain(`href="${location}/asset-categories"`);
    expect(headingActions).not.toContain(`href="${location}/edit">Edit project</a>`);
    expect(res.text).not.toContain('Edit project');
    expect((headingActions.match(/<a\b/g) || [])).toHaveLength(1);
    expect(res.text).not.toMatch(
      new RegExp(`<section class="workflow-actions">\\s*<a[^>]+href="${location}/assets"`),
    );
  });

  it('edit form renders', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Editable+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent.get(`${createRes.headers.location}/edit`).expect(200);
    expect(res.text).toContain('Projects — Edit Editable Project');
    expect(res.text).not.toContain('value="archived"');
  });

  it('valid update redirects to detail', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Old+Name')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent
      .post(createRes.headers.location)
      .send('title=New+Name')
      .send('status=planned')
      .send('priority=high')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Name');
  });

  it('rejects archived status on update', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Update+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent
      .post(createRes.headers.location)
      .send('title=Update+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Status must be one of');
  });

  it('invalid edit request rerenders with submitted values and errors', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Edit+Preserves+Initial')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(createRes.headers.location)
      .send('title=Edit+Preserves+Submitted')
      .send('description=Submitted+description')
      .send('notes=Submitted+notes')
      .send('status=in-progress')
      .send('priority=low')
      .send('plannedDate=2026-10-01')
      .send('publishedDate=2026-10-15')
      .send('patreonUrl=example.com/not-patreon')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('Project link must be a valid absolute HTTP or HTTPS URL.');
    expect(res.text).toContain('value="Edit Preserves Submitted"');
    expect(res.text).toContain('Submitted description');
    expect(res.text).toContain('Submitted notes');
    expect(res.text).toContain('<option value="in-progress" selected>In Progress</option>');
    expect(res.text).toContain('<option value="low" selected>Low</option>');
    expect(res.text).toContain('value="2026-10-01"');
    expect(res.text).toContain('value="2026-10-15"');
    expect(res.text).toContain('value="example.com/not-patreon"');
    expect(res.text).toContain('Basic information');
    expect(res.text).toContain('Status and scheduling');
    expect(res.text).toContain('Links');
    expect(res.text).toContain(`href="${createRes.headers.location}"`);
  });

  it('editing an existing high-priority project does not reset it to normal', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=High+Priority+Edit')
      .send('status=tbd')
      .send('priority=high')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const location = createRes.headers.location;

    const edit = await agent.get(`${location}/edit`).expect(200);
    expect(edit.text).toContain('<option value="high" selected>High</option>');
    expect(edit.text).not.toContain('<option value="normal" selected>Normal</option>');

    await agent
      .post(location)
      .send('title=High+Priority+Edit')
      .send('status=planned')
      .send('priority=high')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const id = Number(location.replace('/projects/', ''));
    const row = db.prepare('SELECT priority FROM projects WHERE id = ?').get(id);
    expect(row.priority).toBe('high');
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
    expect(archivedList.text).toContain('class="project-card project-card--grid project-card--archived" data-project-card');

    const dashboard = await agent.get('/').expect(200);
    expect(dashboard.text).toContain('<span class="count">1</span> Archived');
  });

  it('search and status query parameters affect results', async () => {
    await agent
      .post('/projects')
      .send('title=Searchable+Alpha')
      .send('description=find me')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    await agent
      .post('/projects')
      .send('title=Beta+One')
      .send('status=ready')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));

    const search = await agent.get('/projects?search=alpha').expect(200);
    expect(search.text).toContain('Searchable Alpha');
    expect(search.text).not.toContain('Beta One');

    const status = await agent.get('/projects?status=ready').expect(200);
    expect(status.text).toContain('Beta One');
    expect(status.text).not.toContain('Searchable Alpha');
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
    expect(res.text).not.toContain('Status Filter Nonmatch');
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
    expect(res.text).toContain('Reset Filters');
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

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
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
      const projectDir = getProjectDir('HTTP FS Test', 'tbd');
      expect(projectDir).not.toBeNull();
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.statSync(projectDir).isDirectory()).toBe(true);
    });

    it('uses correct status root directory', async () => {
      await agent
        .post('/projects')
        .send('title=Status+Root+Check')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectDir = getProjectDir('Status Root Check', 'in-progress');
      expect(projectDir).not.toBeNull();
      // The directory should be under the 'active' directory
      expect(projectDir).toContain(path.join(projectsRoot, 'active'));
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

      const projectDir = getProjectDir('Subdirs HTTP', 'tbd');
      expect(projectDir).not.toBeNull();

      const expectedSubdirs = ['source', 'exports', 'extras', 'references', 'thumbnails'];
      for (const sub of expectedSubdirs) {
        const subPath = path.join(projectDir, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.statSync(subPath).isDirectory()).toBe(true);
      }
      expect(fs.existsSync(path.join(projectDir, 'exports', 'full'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'exports', 'web'))).toBe(false);
    });

    it('writes a project manifest', async () => {
      await agent
        .post('/projects')
        .send('title=Manifest+HTTP')
        .send('description=Test+description')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectDir = getProjectDir('Manifest HTTP', 'tbd');
      expect(projectDir).not.toBeNull();

      const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.title).toBe('Manifest HTTP');
      expect(manifest.description).toBe('Test description');
      expect(manifest.assetCategories.map((c) => c.directorySlug)).toEqual([
        'source', 'exports', 'extras', 'references', 'thumbnails',
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

    it('detail page shows relative project directory after creation', async () => {
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
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-detail-dir-test/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('filesystem conflict during creation renders safe error with preserved values', async () => {
      // Block the expected path for project id=1 (first project in a fresh DB)
      const slug = parseSlug('Conflict+Create');
      const statusDir = STATUS_DIR_MAP.tbd;
      const conflictPath = path.join(projectsRoot, statusDir, `000001-${slug}`);
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

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
    }

    it('valid metadata edit rewrites manifest and redirects', async () => {
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

      // Edit metadata only (no slug/status change)
      const res = await agent
        .post(location)
        .send('title=HTTP+Meta+Edit')
        .send('description=Updated+desc')
        .send('notes=New+notes')
        .send('status=tbd')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      expect(res.headers.location).toBe(location);

      // Manifest was rewritten
      const projectDir = getProjectDir('HTTP Meta Edit', 'tbd');
      expect(projectDir).not.toBeNull();
      const manifest = readManifestSync(projectDir);
      expect(manifest.description).toBe('Updated desc');
      expect(manifest.notes).toBe('New notes');
      expect(manifest.priority).toBe('high');
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
      const oldDir = getProjectDir('Old HTTP Name', 'tbd');
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

      // New directory exists
      const newDir = getProjectDir('New HTTP Name', 'tbd');
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

    it('status change moves the directory', async () => {
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
      const oldDir = getProjectDir('Status Move HTTP', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add a custom file
      fs.writeFileSync(path.join(oldDir, 'move-test.txt'), 'moved');

      // Change status to in-progress (maps to 'active')
      await agent
        .post(location)
        .send('title=Status+Move+HTTP')
        .send('description=Moved')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory under 'active'
      const newDir = getProjectDir('Status Move HTTP', 'in-progress');
      expect(newDir).not.toBeNull();
      expect(newDir).toContain(path.join(projectsRoot, 'active'));

      // Custom file survived
      expect(fs.existsSync(path.join(newDir, 'move-test.txt'))).toBe(true);

      // Manifest reflects new status
      const manifest = readManifestSync(newDir);
      expect(manifest.status).toBe('in-progress');
    });

    it('combined title/status change works correctly', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Combined+HTTP+Start')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Combined HTTP Start', 'planned');
      expect(oldDir).not.toBeNull();

      // Change both title and status
      await agent
        .post(location)
        .send('title=Combined+HTTP+Final')
        .send('status=published')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory under 'published'
      const newDir = getProjectDir('Combined HTTP Final', 'published');
      expect(newDir).not.toBeNull();
      expect(newDir).toContain(path.join(projectsRoot, 'published'));

      // Detail page shows everything
      const detail = await agent.get(location).expect(200);
      expect(detail.text).toContain('Combined HTTP Final');
      expect(detail.text).toContain('Published');
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

      // Before rename — detail shows old dir
      let detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-old-path-name/);

      // Rename
      await agent
        .post(createRes.headers.location)
        .send('title=New+Path+Name')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After rename — detail shows new dir
      detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-new-path-name/);
      expect(detail.text).not.toMatch(/old-path-name/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('status change updates the displayed relative path', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Status+Path+Change')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Before — under planned/
      let detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/planned(?:&#92;|\/)\d+-status-path-change/);

      // Change status
      await agent
        .post(createRes.headers.location)
        .send('title=Status+Path+Change')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After — under active/
      detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/active(?:&#92;|\/)\d+-status-path-change/);
      expect(detail.text).not.toMatch(/planned/);
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
      const projectDir = getProjectDir('Update Fail Safe', 'tbd');
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

      expect(res.text).toContain('Project update failed');
      expect(res.text).toContain('Updated Title');
      expect(res.text).toContain('Preserved text');
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });
  });

  // ─── Filesystem archive flow ────────────────────────────────────────

  describe('HTTP filesystem archive', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
    }

    function getArchiveDir(title) {
      const slug = parseSlug(title);
      const entries = fs.readdirSync(path.join(projectsRoot, 'archived'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, 'archived', matching[0]);
    }

    it('archive moves the directory to archived/', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Move')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const oldDir = getProjectDir('HTTP Archive Move', 'tbd');
      expect(oldDir).not.toBeNull();
      expect(fs.existsSync(oldDir)).toBe(true);

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory under archived/
      const archiveDir = getArchiveDir('HTTP Archive Move');
      expect(archiveDir).not.toBeNull();
      expect(fs.existsSync(archiveDir)).toBe(true);
      expect(archiveDir).toContain(path.join(projectsRoot, 'archived'));
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

    it('relative path is updated', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Path')
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

      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(Number(id));
      expect(row.project_dir).toMatch(path.join('archived', ''));
    });

    it('manifest reflects archived status', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Manifest')
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

      const archiveDir = getArchiveDir('HTTP Archive Manifest');
      expect(archiveDir).not.toBeNull();
      const manifest = readManifestSync(archiveDir);
      expect(manifest).not.toBeNull();
      expect(manifest.status).toBe('archived');
    });

    it('existing files survive archive', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Files+Survive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const oldDir = getProjectDir('HTTP Files Survive', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add custom files
      fs.writeFileSync(path.join(oldDir, 'http-extra.txt'), 'http content');
      fs.mkdirSync(path.join(oldDir, 'source'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'source', 'render.png'), 'png data');

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Files survived at new location
      const archiveDir = getArchiveDir('HTTP Files Survive');
      expect(archiveDir).not.toBeNull();
      expect(fs.existsSync(path.join(archiveDir, 'http-extra.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(archiveDir, 'http-extra.txt'), 'utf8')).toBe('http content');
      expect(fs.existsSync(path.join(archiveDir, 'source', 'render.png'))).toBe(true);
    });

    it('error responses contain no absolute filesystem paths', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+No+Path+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Remove the directory to cause a failure
      const projectDir = getProjectDir('HTTP No Path Archive', 'tbd');
      expect(projectDir).not.toBeNull();
      fs.rmSync(projectDir, { recursive: true, force: true });

      const res = await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archive changes the displayed relative path to archived/', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archive+Path+Display')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Before archive — under tbd/
      let detail = await agent.get(`/projects/${id}`).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-archive-path-display/);

      // Archive
      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After archive — under archived/
      detail = await agent.get(`/projects/${id}`).expect(200);
      expect(detail.text).toMatch(/archived(?:&#92;|\/)\d+-archive-path-display/);
      expect(detail.text).not.toMatch(/tbd(?:&#92;|\/)/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
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

      // GET should not archive — 404 from route matching
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
        const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
        const matching = entries.filter((e) => e.endsWith(`-${slug}`));
        return path.join(projectsRoot, 'tbd', matching[0]);
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

    it('project form shows generic project-link help text in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'patreonUrl');
      expect(container).not.toBeNull();
      expect(container).toContain('<label for="patreonUrl">Project link</label>');
      expect(container).toContain('Optional absolute HTTP or HTTPS URL for this project.');
      expect(container).toMatch(/<input[^>]*id="patreonUrl"[^>]*>/);
    });

    it('project detail shows planned date and the project link, and omits the published date', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Wording+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('plannedDate=2025-12-01')
        .send('publishedDate=2025-12-15')
        .send('patreonUrl=https://patreon.com/test')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}`).expect(200);

      // Planned date remains a labelled dt/dd pair in the Details list.
      const plannedDt = res.text.match(/<dt>Planned date<\/dt>\s*<dd>[^<]*(?:<small>\(project target\)<\/small>)[^<]*<\/dd>/);
      expect(plannedDt).not.toBeNull();

      // Published date is intentionally not rendered on the detail page — the
      // publication model is being reworked and the date is no longer surfaced.
      expect(res.text).not.toContain('Published date');

      // Project link now lives in the hero summary as a direct link.
      expect(res.text).toMatch(/<a class="project-detail-link" href="https:\/\/patreon\.com\/test"[^>]*>Project link<\/a>/);
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

  // ─── Phase 7D-3: Project status preserves filesystem behavior ──────
  //
  // Project status governs filesystem directory placement. Changing a
  // project's status must move its directory to the corresponding status
  // directory. This is independent of release planning fields.

  describe('project status filesystem behavior', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
    }

    it('changing project status moves the directory', async () => {
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

      // Assert the exact canonical original relative path
      expect(originalRelPath).toMatch(/^tbd[/\\]000001-fs-status-test$/);

      // Assert the resolved directory exists under PROJECTS_ROOT
      expect(originalDir.startsWith(path.resolve(projectsRoot))).toBe(true);
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

      // Derive the exact expected relative path using the application's directory convention
      const dirName = path.basename(originalRelPath);
      const expectedRelPath = path.join('planned', dirName);

      const afterRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
      expect(afterRow.project_dir).toBe(expectedRelPath);

      // Original path no longer exists
      expect(fs.existsSync(originalDir)).toBe(false);

      // Exact new path exists
      const newDir = path.resolve(projectsRoot, expectedRelPath);
      expect(fs.existsSync(newDir)).toBe(true);
      expect(fs.statSync(newDir).isDirectory()).toBe(true);

      // New path remains inside PROJECTS_ROOT
      expect(newDir.startsWith(path.resolve(projectsRoot))).toBe(true);

      // Distinctive file exists at the new path with unchanged contents
      expect(fs.existsSync(path.join(newDir, 'status-move.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'status-move.txt'), 'utf8')).toBe('moved content');
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

    it('GET /projects/:id/edit still renders for active projects (regression)', async () => {
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
      expect(res.status).toBe(200);
      expect(res.text).toContain('Projects — Edit Edit Active Allowed');
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

      // Filtered empty (no match for search in a non-empty repository)
      const res2 = await agent.get('/projects?search=nonexistent').expect(200);
      expect(res2.text).toContain('No projects found');
      expect(res2.text).toContain('Reset Filters');
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
      expect(res.text).toContain('Reset Filters');
      expect(res.text).not.toContain('Create your first project to get started.');
    });
  });

  describe('project status badge rendering', () => {
    const statuses = ['tbd', 'planned', 'in-progress', 'ready', 'published'];

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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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
    const relPath = buildProjectRelPath('tbd', dirName);
    const absPath = resolveProjectDir(projectsRoot, relPath);
    expect(fs.existsSync(path.join(absPath, 'fake'))).toBe(true);

    const manifest = readManifestSync(absPath);
    expect(manifest.assetCategories).toEqual([
      { displayName: 'Fake', directorySlug: 'fake', displayOrder: 0, enabled: true },
    ]);
  });
});
