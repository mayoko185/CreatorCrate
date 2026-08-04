import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP, resolveProjectDir } from '../src/storage/project-storage.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { makeZip } from './helpers/zip-fixture.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function extractProjectCard(html, projectId) {
  const cards = html.match(/<article\b[^>]*data-project-card[^>]*>[\s\S]*?<\/article>/g) || [];
  return cards.find((card) => card.includes(`data-project-card-link href="/projects/${projectId}"`)) || '';
}

// Phase 2B: GET /releases is now the "Published Work" page — a project-derived
// listing of published projects, requiring no release record. This suite
// covers that page plus the compatibility redirects that send stale
// release-record-list links (?view=, ?status=, etc.) to /release-management.

describe('Published Work HTTP route (Phase 2B)', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let previewRoot;
  let appDataRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pubwork-'));
    projectsRoot = path.join(tmpDir, 'projects');
    previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject(title, options = {}) {
    const {
      status = 'tbd',
      priority = 'normal',
      plannedDate,
      publishedDate,
      patreonUrl,
      description,
      notes,
    } = options;

    const req = agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .send(`priority=${priority}`);
    if (plannedDate) req.send(`plannedDate=${plannedDate}`);
    if (publishedDate) req.send(`publishedDate=${publishedDate}`);
    if (patreonUrl) req.send(`patreonUrl=${encodeURIComponent(patreonUrl)}`);
    if (description) req.send(`description=${encodeURIComponent(description)}`);
    if (notes) req.send(`notes=${encodeURIComponent(notes)}`);

    const res = await req.set('Content-Type', 'application/x-www-form-urlencoded').expect(302);
    return res.headers.location.replace('/projects/', '');
  }

  async function archiveProject(projectId) {
    await agent
      .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
  }

  async function createRelease(projectId, title, status = 'idea') {
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return res.headers.location;
  }

  function savePublishedDefault(option, value) {
    return app.locals.pageDefaultsService.saveDefault('publishedWork', option, value);
  }

  function writeStoredPublishedDefault(option, value) {
    const key = PAGE_DEFAULT_DEFINITIONS.publishedWork[option].key;
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  function seedPrimaryImage(projectId, filename = 'cover.png') {
    const id = Number(projectId);
    const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
    const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    fs.writeFileSync(path.join(projectDir, filename), 'content');
    app.locals.assetScanner.scanProjectAssets(id);
    const asset = app.locals.assetScanner.repository.findByProjectId(id)[0];
    app.locals.projectPrimaryImageService.setPrimaryImage(id, asset.id);
    return asset;
  }

  async function seedMergedKra(projectId) {
    const id = Number(projectId);
    const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
    const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    fs.writeFileSync(path.join(projectDir, 'cover.kra'), makeZip([
      { name: 'mergedimage.png', data: Buffer.from('merged-preview') },
    ]));
    app.locals.assetScanner.scanProjectAssets(id);
    const asset = app.locals.assetScanner.repository.findByProjectId(id)[0];
    await app.locals.projectPrimaryImageService.setPrimaryImage(id, asset.id);
    return asset;
  }

  // ─── Page identity ──────────────────────────────────────────────────────

  it('uses the Published heading for the document title while retaining shell navigation', async () => {
    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('<title>CreatorCrate — Published</title>');
    expect(res.text).toContain('<h1 class="app-section-title">Published</h1>');
    expect(res.text).not.toContain('<h1 class="app-section-title">Published Work</h1>');
    expect(res.text).toContain('Published Work');
  });

  it('redirects a bare request to valid saved Published Work defaults', async () => {
    savePublishedDefault('view', 'list');
    savePublishedDefault('sort', 'title');
    savePublishedDefault('order', 'asc');

    const redirect = await agent.get('/releases').expect(302);
    expect(redirect.headers.location).toBe('/releases?sort=title&order=asc&view=list');

    const rendered = await agent.get(redirect.headers.location).expect(200);
    expect(rendered.text).toContain('aria-current="page">List</a>');
    expect(rendered.text).toContain('<input type="hidden" name="view" value="list">');
    expect(rendered.text).toContain('<option value="title" selected>Title</option>');
    expect(rendered.text).toContain('<option value="asc" selected>Asc</option>');
  });

  it('uses application fallbacks when Published Work defaults are missing', async () => {
    const res = await agent.get('/releases').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('aria-current="page">Grid</a>');
    expect(res.text).not.toContain('<input type="hidden" name="view"');
    expect(res.text).toContain('<option value="published" selected>Published</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
  });

  it('uses application fallbacks when stored Published Work defaults are invalid', async () => {
    writeStoredPublishedDefault('view', 'board');
    writeStoredPublishedDefault('sort', 'created');
    writeStoredPublishedDefault('order', 'forwards');

    const res = await agent.get('/releases').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('aria-current="page">Grid</a>');
    expect(res.text).toContain('<option value="published" selected>Published</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
  });

  it('gives valid explicit values precedence while resolving omitted options from saved defaults', async () => {
    savePublishedDefault('view', 'list');
    savePublishedDefault('sort', 'title');
    savePublishedDefault('order', 'asc');

    const res = await agent.get('/releases?view=grid&sort=published').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('aria-current="page">Grid</a>');
    expect(res.text).toContain('<input type="hidden" name="view" value="grid">');
    expect(res.text).toContain('<option value="published" selected>Published</option>');
    expect(res.text).toContain('<option value="asc" selected>Asc</option>');
    expect(res.text).toContain('href="/releases?sort=published&amp;order=asc&amp;view=grid"');
  });

  it('keeps invalid explicit values on application fallbacks instead of saved defaults', async () => {
    savePublishedDefault('view', 'list');
    savePublishedDefault('sort', 'title');
    savePublishedDefault('order', 'asc');

    const res = await agent.get('/releases?view=invalid&sort=invalid&order=invalid').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('aria-current="page">Grid</a>');
    expect(res.text).toContain('<input type="hidden" name="view" value="grid">');
    expect(res.text).toContain('<option value="published" selected>Published</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
    expect(res.text).not.toContain('sort=invalid');
    expect(res.text).not.toContain('order=invalid');
    expect(res.text).not.toContain('view=invalid');
  });

  it('canonicalizes saved defaults while preserving search, pagination, and effective control URLs', async () => {
    savePublishedDefault('view', 'list');
    savePublishedDefault('sort', 'title');
    savePublishedDefault('order', 'asc');

    for (let i = 0; i < 26; i += 1) {
      await createProject(`Canonical Published ${String(i).padStart(2, '0')}`, {
        status: 'published',
        publishedDate: '2026-01-01',
      });
    }

    const redirect = await agent
      .get('/releases?search=Canonical+Published&page=99&unknown=discarded')
      .expect(302);
    expect(redirect.headers.location)
      .toBe('/releases?search=Canonical+Published&sort=title&order=asc&view=list&page=2');

    const pageTwo = await agent.get(redirect.headers.location).expect(200);
    expect(pageTwo.text).toContain('Page 2 of 2');
    expect(pageTwo.text).toContain('Canonical Published 25');
    expect(pageTwo.text).not.toContain('unknown=discarded');
    expect(pageTwo.text).toContain(
      'href="/releases?search=Canonical+Published&amp;sort=title&amp;order=asc&amp;view=list"'
    );

    const pageOne = await agent
      .get('/releases?search=Canonical+Published&sort=title&order=asc&view=list')
      .expect(200);
    expect(pageOne.text).toContain(
      'href="/releases?search=Canonical+Published&amp;sort=title&amp;order=asc&amp;view=list&amp;page=2"'
    );
    expect(pageOne.text).toContain(
      'href="/releases?search=Canonical+Published&amp;sort=title&amp;order=asc&amp;view=grid"'
    );
    expect(pageOne.text).toContain(
      'href="/releases?search=Canonical+Published&amp;sort=title&amp;order=asc&amp;view=list"'
    );
    expect(pageOne.text).toContain('<option value="title" selected>Title</option>');
    expect(pageOne.text).toContain('<option value="asc" selected>Asc</option>');
    expect(pageOne.text).toContain('href="/releases">Reset Search</a>');
    expect(pageOne.text).not.toContain('unknown=discarded');
  });

  it('does not redirect when saved Published Work defaults equal application fallbacks', async () => {
    savePublishedDefault('view', 'grid');
    savePublishedDefault('sort', 'published');
    savePublishedDefault('order', 'desc');

    const res = await agent.get('/releases').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('aria-current="page">Grid</a>');
    expect(res.text).toContain('<option value="published" selected>Published</option>');
    expect(res.text).toContain('<option value="desc" selected>Desc</option>');
  });

  // ─── Membership ─────────────────────────────────────────────────────────

  it('a published project with no release record appears', async () => {
    await createProject('Solo Published Project', { status: 'published', publishedDate: '2026-01-05' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('Solo Published Project');
  });

  it('a published project with a release record appears exactly once', async () => {
    const projectId = await createProject('Published With Release', { status: 'published', publishedDate: '2026-01-06' });
    await createRelease(projectId, 'Its Release', 'idea');

    const res = await agent.get('/releases').expect(200);
    const occurrences = res.text.split('Published With Release').length - 1;
    expect(occurrences).toBe(1);
  });

  it('an unpublished project does not appear', async () => {
    await createProject('Still Drafting Project', { status: 'in-progress' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('Still Drafting Project');
  });

  it('an archived project does not appear', async () => {
    const projectId = await createProject('Archived Published Project', { status: 'published', publishedDate: '2026-01-07' });
    await archiveProject(projectId);

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('Archived Published Project');
  });

  // ─── Row content ────────────────────────────────────────────────────────

  it('project title links to /projects/:id', async () => {
    const projectId = await createProject('Linked Project', { status: 'published', publishedDate: '2026-01-08' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain(`href="/projects/${projectId}"`);
  });

  it('project status badge renders', async () => {
    await createProject('Badge Project', { status: 'published', publishedDate: '2026-01-09' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('status-badge--published');
    expect(res.text).toContain('Published');
  });

  it('published date renders', async () => {
    await createProject('Dated Project', { status: 'published', publishedDate: '2026-02-14' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('2026-02-14');
  });

  it('missing published date renders "Not recorded"', async () => {
    await createProject('Undated Published Project', { status: 'published' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('Undated Published Project');
    expect(res.text).toContain('Not recorded');
  });

  it('project link renders only when present', async () => {
    await createProject('Patreon Project', {
      status: 'published',
      publishedDate: '2026-01-10',
      patreonUrl: 'https://www.patreon.com/creator',
    });
    const noPatreonId = await createProject('No Patreon Project', { status: 'published', publishedDate: '2026-01-11' });

    const res = await agent.get('/releases').expect(200);
    const noPatreonCard = extractProjectCard(res.text, noPatreonId);
    expect(res.text).toContain('href="https://www.patreon.com/creator" target="_blank" rel="noopener noreferrer">Project link</a>');
    expect(noPatreonCard).toMatch(/<dt>Project link<\/dt>\s*<dd>\s*—\s*<\/dd>/);
    expect(noPatreonCard).not.toContain('target="_blank"');
  });

  it('renders shared responsive cards with primary-image states and Published metadata', async () => {
    const longDescription = `${'Long description marker '.repeat(20)}END MARKER`;
    const availableId = await createProject('Published Card With A Long Title That Wraps On Small Screens', {
      status: 'published',
      publishedDate: '2026-02-10',
      patreonUrl: 'https://www.patreon.com/card',
      description: longDescription,
    });
    const noneId = await createProject('Published Card Without An Image', { status: 'published' });
    const unavailableId = await createProject('Published Card With An Unavailable Image', {
      status: 'published',
      publishedDate: '2026-02-12',
    });

    seedPrimaryImage(availableId);
    const unavailableAsset = seedPrimaryImage(unavailableId, 'unavailable.png');
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(unavailableAsset.id);

    const res = await agent.get('/releases').expect(200);
    const availableCard = extractProjectCard(res.text, availableId);
    const noneCard = extractProjectCard(res.text, noneId);
    const unavailableCard = extractProjectCard(res.text, unavailableId);

    expect(res.text).toContain('<ul class="project-grid">');
    expect(res.text).not.toContain('<table class="data-table">');
    expect(res.text.match(/<li class="project-grid-item">/g)).toHaveLength(3);
    expect(res.text.match(/<article class="project-card[^\"]*" data-project-card>/g)).toHaveLength(3);

    expect(availableCard).toContain(`data-project-card-link href="/projects/${availableId}">Published Card With A Long Title That Wraps On Small Screens</a>`);
    expect(availableCard).toMatch(
      /<img class="project-card-media-image" data-preview-image src="\/projects\/\d+\/assets\/\d+\/preview\?v=[0-9a-f]+" alt="Preview of cover\.png" loading="lazy" decoding="async">/
    );
    expect(availableCard).toContain('data-preview-enhancement');
    expect(availableCard).toContain('data-preview-fallback');
    expect(availableCard).not.toContain('/original');
    expect(availableCard).not.toContain('/thumbnail');

    expect(noneCard).toContain('data-primary-image-state="none"');
    expect(noneCard).toContain('No image');
    expect(noneCard).not.toContain('<img');

    expect(unavailableCard).toContain('data-primary-image-state="unavailable"');
    expect(unavailableCard).toContain('Image unavailable');
    expect(unavailableCard).not.toContain('<img');

    const descriptionMatch = availableCard.match(/<p class="project-card-description">([^<]*)<\/p>/);
    expect(descriptionMatch).not.toBeNull();
    expect(descriptionMatch[1].length).toBeLessThanOrEqual(140);
    expect(descriptionMatch[1]).toContain('Long description marker');
    expect(descriptionMatch[1]).not.toContain('END MARKER');
    expect(availableCard).toMatch(/<dt>Status<\/dt>\s*<dd>[\s\S]*Published[\s\S]*<\/dd>/);
    expect(availableCard).toContain('<dt>Published</dt>');
    expect(availableCard).toContain('2026-02-10');
    expect(availableCard).toContain('href="https://www.patreon.com/card" target="_blank" rel="noopener noreferrer">Project link</a>');
    expect(noneCard).toMatch(/<dt>Published<\/dt>\s*<dd>Not recorded<\/dd>/);
    expect(noneCard).not.toContain('target="_blank"');

    const list = await agent.get('/releases?view=list').expect(200);
    const availableListCard = extractProjectCard(list.text, availableId);
    const noneListCard = extractProjectCard(list.text, noneId);
    const unavailableListCard = extractProjectCard(list.text, unavailableId);
    expect(list.text).toContain('<ul class="project-list">');
    expect(availableListCard).toContain('class="project-card project-card--list"');
    expect(availableListCard).toMatch(
      /<img class="project-card-media-image project-card-media-image--list" data-preview-image src="\/projects\/\d+\/assets\/\d+\/thumbnail\?v=[0-9a-f]+"/
    );
    expect(availableListCard).not.toContain('/preview');
    expect(availableListCard).not.toContain('/original');
    expect(availableListCard).toContain('<p class="project-card-description">');
    expect(availableListCard).toContain('<dt>Status</dt>');
    expect(availableListCard).toContain('<dt>Published</dt>');
    expect(availableListCard).toContain('href="https://www.patreon.com/card" target="_blank" rel="noopener noreferrer">Project link</a>');
    expect(noneListCard).toContain('No description');
    expect(noneListCard).not.toContain('<img');
    expect(unavailableListCard).toContain('data-primary-image-state="unavailable"');
    expect(unavailableListCard).not.toContain('<img');
  });

  it('renders a selected merged KRA through the shared Published card modifier', async () => {
    const projectId = await createProject('Published Merged KRA', {
      status: 'published',
      publishedDate: '2026-02-20',
    });
    const asset = await seedMergedKra(projectId);

    const grid = await agent.get('/releases').expect(200);
    const gridCard = extractProjectCard(grid.text, projectId);
    expect(gridCard).toContain('project-card-media--krita');
    expect(gridCard).toContain(`src="/projects/${projectId}/assets/${asset.id}/preview?v=`);
    expect(gridCard).not.toContain('/original');

    const list = await agent.get('/releases?view=list').expect(200);
    const listCard = extractProjectCard(list.text, projectId);
    expect(listCard).toContain('project-card-media--krita');
    expect(listCard).toContain(`src="/projects/${projectId}/assets/${asset.id}/thumbnail?v=`);
    expect(listCard).not.toContain('/original');
  });

  it('normalizes Published view state and preserves allowed query values', async () => {
    for (let i = 0; i < 26; i += 1) {
      await createProject(`Published View State ${String(i).padStart(2, '0')}`, {
        status: 'published',
        publishedDate: '2026-01-01',
      });
    }

    const list = await agent.get('/releases?search=Published+View&sort=title&order=asc&view=list&unknown=discarded').expect(200);
    expect(list.text).toContain('<ul class="project-list">');
    expect(list.text).toContain('name="view" value="list"');
    expect(list.text).toContain('href="/releases?search=Published+View&amp;sort=title&amp;order=asc"');
    expect(list.text).toContain('href="/releases?search=Published+View&amp;sort=title&amp;order=asc&amp;view=list"');
    expect(list.text).toContain('href="/releases?search=Published+View&amp;sort=title&amp;order=asc&amp;view=list&amp;page=2"');
    expect(list.text).not.toContain('unknown=discarded');

    const invalid = await agent.get('/releases?view=invalid&unknown=discarded').expect(200);
    expect(invalid.text).toContain('<ul class="project-grid">');
    expect(invalid.text).not.toContain('view=invalid');
    expect(invalid.text).not.toContain('unknown=discarded');
    expect(invalid.text).toContain('href="/releases?view=list"');
    expect(invalid.text).toContain('href="/releases"');
  });

  it('release-record title, readiness, and asset fields do not appear', async () => {
    const projectId = await createProject('Release Data Hidden Project', { status: 'published', publishedDate: '2026-01-12' });
    await createRelease(projectId, 'Unmistakable Release Title Xyz', 'ready');

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('Unmistakable Release Title Xyz');
    expect(res.text).not.toContain('readiness-publishable');
    expect(res.text).not.toContain('readiness-blocked');
    expect(res.text).not.toContain('missing-indicator');
  });

  it('no primary New Release action appears', async () => {
    await createProject('No Primary Action Project', { status: 'published', publishedDate: '2026-01-13' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('New Release');
  });

  // ─── Search ─────────────────────────────────────────────────────────────

  it('search matches title', async () => {
    await createProject('Findable By Title', { status: 'published', publishedDate: '2026-01-14' });
    await createProject('Unrelated Published', { status: 'published', publishedDate: '2026-01-15' });

    const res = await agent.get('/releases?search=Findable').expect(200);
    expect(res.text).toContain('Findable By Title');
    expect(res.text).not.toContain('Unrelated Published');
  });

  it('search matches description', async () => {
    await createProject('Description Match Project', {
      status: 'published',
      publishedDate: '2026-01-16',
      description: 'a very distinctive marker phrase',
    });
    await createProject('Other Published Project', { status: 'published', publishedDate: '2026-01-17' });

    const res = await agent.get('/releases?search=distinctive+marker').expect(200);
    expect(res.text).toContain('Description Match Project');
    expect(res.text).not.toContain('Other Published Project');
  });

  it('search matches notes', async () => {
    await createProject('Notes Match Project', {
      status: 'published',
      publishedDate: '2026-01-18',
      notes: 'an unusual internal note keyword',
    });
    await createProject('Untouched Published Project', { status: 'published', publishedDate: '2026-01-19' });

    const res = await agent.get('/releases?search=unusual+internal').expect(200);
    expect(res.text).toContain('Notes Match Project');
    expect(res.text).not.toContain('Untouched Published Project');
  });

  it('search excludes nonmatching projects', async () => {
    await createProject('Alpha Match', { status: 'published', publishedDate: '2026-01-20' });
    await createProject('Beta Nomatch', { status: 'published', publishedDate: '2026-01-21' });

    const res = await agent.get('/releases?search=Alpha').expect(200);
    expect(res.text).toContain('Alpha Match');
    expect(res.text).not.toContain('Beta Nomatch');
  });

  it('search-empty state renders correctly', async () => {
    await createProject('Existing Published Project', { status: 'published', publishedDate: '2026-01-22' });

    const res = await agent.get('/releases?search=NoSuchThingAtAll').expect(200);
    expect(res.text).toContain('No published work matches your search');
    expect(res.text).not.toContain('New Release');
  });

  it('reset-search link targets /releases', async () => {
    await createProject('Reset Search Project', { status: 'published', publishedDate: '2026-01-23' });

    const res = await agent.get('/releases?search=NoSuchThingAtAll').expect(200);
    expect(res.text).toContain('href="/releases"');
  });

  it('no-published-projects empty state renders correctly', async () => {
    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('No published work yet');
    expect(res.text).toContain('Publish a project to see it here.');
    expect(res.text).not.toContain('/releases/new');
  });

  // ─── Sorting ────────────────────────────────────────────────────────────

  it('published-date default ordering is descending', async () => {
    await createProject('Earlier Published', { status: 'published', publishedDate: '2026-01-01' });
    await createProject('Later Published', { status: 'published', publishedDate: '2026-06-01' });

    const res = await agent.get('/releases').expect(200);
    const laterIdx = res.text.indexOf('Later Published');
    const earlierIdx = res.text.indexOf('Earlier Published');
    expect(laterIdx).toBeGreaterThan(-1);
    expect(earlierIdx).toBeGreaterThan(-1);
    expect(laterIdx).toBeLessThan(earlierIdx);
  });

  it('null published dates sort last', async () => {
    await createProject('Has Published Date', { status: 'published', publishedDate: '2026-01-01' });
    await createProject('No Published Date At All', { status: 'published' });

    const res = await agent.get('/releases').expect(200);
    const datedIdx = res.text.indexOf('Has Published Date');
    const undatedIdx = res.text.indexOf('No Published Date At All');
    expect(datedIdx).toBeGreaterThan(-1);
    expect(undatedIdx).toBeGreaterThan(-1);
    expect(datedIdx).toBeLessThan(undatedIdx);
  });

  it('title sorting works', async () => {
    await createProject('Zeta Sort Project', { status: 'published', publishedDate: '2026-01-01' });
    await createProject('Alpha Sort Project', { status: 'published', publishedDate: '2026-01-02' });

    const res = await agent.get('/releases?sort=title&order=asc').expect(200);
    const alphaIdx = res.text.indexOf('Alpha Sort Project');
    const zetaIdx = res.text.indexOf('Zeta Sort Project');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('updated-date sorting works', async () => {
    const firstId = await createProject('First Updated Project', { status: 'published', publishedDate: '2026-01-01' });
    const secondId = await createProject('Second Updated Project', { status: 'published', publishedDate: '2026-01-02' });
    // updated_at has 1-second SQLite resolution, so set it explicitly rather
    // than relying on real-clock ordering between two requests in the same test.
    db.prepare("UPDATE projects SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(Number(secondId));
    db.prepare("UPDATE projects SET updated_at = '2020-01-02 00:00:00' WHERE id = ?").run(Number(firstId));

    const res = await agent.get('/releases?sort=updated&order=desc').expect(200);
    const firstIdx = res.text.indexOf('First Updated Project');
    const secondIdx = res.text.indexOf('Second Updated Project');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  // ─── Pagination ─────────────────────────────────────────────────────────

  it('pagination works', async () => {
    for (let i = 0; i < 30; i++) {
      const padded = String(i).padStart(2, '0');
      await createProject(`Pub Page ${padded}`, { status: 'published', publishedDate: '2026-01-01' });
    }

    const page1 = await agent.get('/releases?sort=title&order=asc').expect(200);
    expect(page1.text).toContain('Pub Page 00');
    expect(page1.text).not.toContain('Pub Page 29');

    const page2 = await agent.get('/releases?sort=title&order=asc&page=2').expect(200);
    expect(page2.text).toContain('Pub Page 29');
    expect(page2.text).not.toContain('Pub Page 00');
  });

  it('clamps an out-of-range page and preserves normalized pagination links', async () => {
    for (let i = 0; i < 26; i++) {
      const padded = String(i).padStart(2, '0');
      await createProject(`Clamp Page ${padded}`, { status: 'published', publishedDate: '2026-01-01' });
    }

    const res = await agent.get('/releases?sort=title&order=asc&page=99').expect(200);
    expect(res.text).toContain('Page 2 of 2');
    expect(res.text).toContain('Clamp Page 25');
    expect(res.text).not.toContain('Clamp Page 00');

    const previousMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^\"]*)"[^>]*>Previous<\/a>/);
    expect(previousMatch).not.toBeNull();
    expect(previousMatch[1]).toBe('/releases?sort=title&amp;order=asc');
  });

  it('pagination preserves Published Work query parameters', async () => {
    for (let i = 0; i < 30; i++) {
      const padded = String(i).padStart(2, '0');
      await createProject(`Preserve Page ${padded}`, { status: 'published', publishedDate: '2026-01-01' });
    }

    const res = await agent.get('/releases?sort=title&order=asc').expect(200);
    const nextMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Next<\/a>/);
    expect(nextMatch).not.toBeNull();
    expect(nextMatch[1]).toContain('sort=title');
    expect(nextMatch[1]).toContain('order=asc');
    expect(nextMatch[1]).toContain('page=2');
  });

  it('page=1 normalization is correct', async () => {
    for (let i = 0; i < 30; i++) {
      const padded = String(i).padStart(2, '0');
      await createProject(`Norm Page ${padded}`, { status: 'published', publishedDate: '2026-01-01' });
    }

    const res = await agent.get('/releases?sort=title&order=asc&page=1').expect(200);
    const nextMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Next<\/a>/);
    expect(nextMatch).not.toBeNull();
    expect(nextMatch[1]).not.toContain('page=1');
  });

  // ─── Compatibility redirects ────────────────────────────────────────────

  describe('compatibility redirects to /release-management', () => {
    it('view redirects to /release-management', async () => {
      const res = await agent.get('/releases?view=board').expect(302);
      expect(res.headers.location).toBe('/release-management?view=board');
    });

    it('project redirects to /release-management', async () => {
      const res = await agent.get('/releases?project=12').expect(302);
      expect(res.headers.location).toBe('/release-management?project=12');
    });

    it('status redirects to /release-management', async () => {
      const res = await agent.get('/releases?status=ready').expect(302);
      expect(res.headers.location).toBe('/release-management?status=ready');
    });

    it('schedule redirects to /release-management', async () => {
      const res = await agent.get('/releases?schedule=overdue').expect(302);
      expect(res.headers.location).toBe('/release-management?schedule=overdue');
    });

    it('readiness redirects to /release-management', async () => {
      const res = await agent.get('/releases?readiness=publishable').expect(302);
      expect(res.headers.location).toBe('/release-management?readiness=publishable');
    });

    it('includeArchived redirects to /release-management', async () => {
      const res = await agent.get('/releases?includeArchived=1').expect(302);
      expect(res.headers.location).toBe('/release-management?includeArchived=1');
    });

    it('redirects preserve all query parameters', async () => {
      const res = await agent.get('/releases?status=ready&sort=planned&page=2').expect(302);
      expect(res.headers.location).toBe('/release-management?status=ready&sort=planned&page=2');
    });

    it('search-only request does not redirect', async () => {
      const res = await agent.get('/releases?search=studio').expect(200);
      expect(res.text).toContain('Published Work');
    });

    it('sort/order/page-only request does not redirect', async () => {
      const res = await agent.get('/releases?sort=published&order=desc&page=1').expect(200);
      expect(res.text).toContain('Published Work');
    });

    it('pageSize-only request does not redirect', async () => {
      const res = await agent.get('/releases?pageSize=10').expect(200);
      expect(res.text).toContain('Published Work');
    });
  });

  // ─── Neighboring routes remain unchanged ───────────────────────────────

  describe('unaffected release-record routes', () => {
    it('Release Management keeps its own list fallbacks when Published Work defaults are saved', async () => {
      savePublishedDefault('view', 'list');
      savePublishedDefault('sort', 'title');
      savePublishedDefault('order', 'asc');

      const res = await agent.get('/release-management').expect(200);

      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('<option value="updated" selected>Updated</option>');
      expect(res.text).toContain('<option value="desc" selected>Desc</option>');
    });

    it('/calendar remains 200 and project-backed', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(res.text).toContain('calendar');
    });

    it('/releases/calendar redirects to the canonical /calendar route', async () => {
      const res = await agent.get('/releases/calendar');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/calendar');
    });

    it('/releases/new remains the existing release-record creation page', async () => {
      await createProject('New Release Form Project', { status: 'tbd' });
      const res = await agent.get('/releases/new').expect(200);
      expect(res.text).toContain('New Release Form Project');
    });

    it('/releases/:id remains the existing release-record detail page', async () => {
      const projectId = await createProject('Detail Route Project', { status: 'tbd' });
      const releaseLocation = await createRelease(projectId, 'Detail Route Release', 'idea');

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toContain('Detail Route Release');
    });

    it('general /projects list remains unchanged', async () => {
      await createProject('Projects Page Smoke Project', { status: 'tbd' });

      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('Projects Page Smoke Project');
      expect(res.text).toContain('<h1 class="app-section-title">Projects</h1>');
    });
  });
});
