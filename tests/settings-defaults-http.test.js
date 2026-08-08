import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';
const LEGACY_NEW_PROJECT_PRIORITY_KEY = 'page_defaults.new_project.priority';

const VALID_DEFAULTS = {
  projectsView: 'list',
  projectsSort: 'title',
  projectsOrder: 'asc',
  releasesView: 'board',
  releasesSort: 'title',
  releasesOrder: 'desc',
  releaseManagementView: 'board',
  releaseManagementSort: 'planned',
  releaseManagementOrder: 'asc',
  projectAssetsView: 'list',
  projectAssetsSort: 'category',
  projectAssetsOrder: 'asc',
  projectAssetsPageSize: '50',
  assetViewerView: 'list',
  assetViewerSort: 'project',
  assetViewerOrder: 'desc',
  assetViewerPageSize: '100',
  new_projectStatus: 'ready',
  defaultCategory: 'all',
};

function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function readMeta(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(key);
}

function selectedValue(html, id) {
  const select = html.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`))?.[0];
  if (!select) throw new Error(`Select ${id} was not rendered.`);
  return select.match(/<option value="([^"]+)" selected>/)?.[1];
}

function activeNavKeys(html) {
  const keys = [];
  const re = /class="app-nav-link" data-nav-key="([^"]+)" aria-current="page"/g;
  let match;
  while ((match = re.exec(html)) !== null) keys.push(match[1]);
  return keys;
}

function activeSettingsNavLabels(html) {
  const settingsNav = html.match(/<nav class="settings-nav"[\s\S]*?<\/nav>/)?.[0] || '';
  const labels = [];
  const re = /<a href="[^"]+" aria-current="page">([^<]+)<\/a>/g;
  let match;
  while ((match = re.exec(settingsNav)) !== null) labels.push(match[1]);
  return labels;
}

function defaultKey(page, option) {
  return PAGE_DEFAULT_DEFINITIONS[page][option].key;
}

const DEFAULT_SECTION_ANCHORS = [
  { title: 'New Projects', anchor: 'defaults-new-projects' },
  { title: 'Projects', anchor: 'defaults-projects' },
  { title: 'Releases', anchor: 'defaults-releases' },
  { title: 'Release Management', anchor: 'defaults-release-management' },
  { title: 'Project Assets', anchor: 'defaults-project-assets' },
  { title: 'Asset Viewer', anchor: 'defaults-asset-viewer' },
];

describe('settings — page defaults HTTP', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-defaults-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders the supported defaults with the Defaults sub-navigation active and Settings active in the shell', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).toContain('Settings — Defaults');
    for (const { title, anchor } of DEFAULT_SECTION_ANCHORS) {
      expect(res.text).toContain(
        `<section id="${anchor}" class="settings-section" aria-labelledby="${anchor}-heading">`
      );
      expect(res.text).toContain(`<h3 id="${anchor}-heading">${title}</h3>`);
    }
    expect((res.text.match(/<section id="defaults-[^"]+" class="settings-section" aria-labelledby="defaults-[^"]+-heading">/g) || [])).toHaveLength(6);
    expect(res.text).not.toContain('<div class="form-section">');
    expect(res.text).toContain('<section class="settings-section asset-browser-default-section" aria-labelledby="project-assets-default-category-heading">');
    expect(res.text).toContain('<h3 id="project-assets-default-category-heading">Asset browser default</h3>');
    expect(res.text).toContain('These defaults apply only to new projects. Changing them does not modify existing projects.');
    expect(res.text).not.toContain('New Releases');
    expect((res.text.match(/<select /g) || [])).toHaveLength(19);
    for (const id of [
      'new_projectStatus',
      'projectsView',
      'projectsSort',
      'projectsOrder',
      'releasesView',
      'releasesSort',
      'releasesOrder',
      'releaseManagementView',
      'releaseManagementSort',
      'releaseManagementOrder',
      'projectAssetsView',
      'projectAssetsSort',
      'projectAssetsOrder',
      'projectAssetsPageSize',
      'assetViewerView',
      'assetViewerSort',
      'assetViewerOrder',
      'assetViewerPageSize',
    ]) {
      expect((res.text.match(new RegExp(`id="${id}"`, 'g')) || [])).toHaveLength(1);
      expect(res.text).toContain(`id="${id}" name="${id}"`);
    }
    expect(res.text).toContain('<label for="assetViewerView">Default view</label>');
    expect(res.text).toContain('<label for="assetViewerSort">Default sort</label>');
    expect(res.text).toContain('<label for="assetViewerOrder">Default order</label>');
    expect(res.text).toContain('<label for="assetViewerPageSize">Default page size</label>');
    expect(res.text).toContain('<option value="project">Project</option>');
    expect(res.text).toContain('<option value="modified">Modified</option>');
    expect(res.text).toContain('<option value="size">Size</option>');
    expect(res.text).toContain('<option value="category">Category</option>');
    expect(res.text).toContain('id="project-assets-default-category" name="defaultCategory"');

    expect(activeNavKeys(res.text)).toEqual(['settings']);
    expect(activeSettingsNavLabels(res.text)).toEqual(['Defaults']);
  });

  it('uses application fallbacks when no valid values are saved', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(selectedValue(res.text, 'projectsView')).toBe('grid');
    expect(selectedValue(res.text, 'projectsSort')).toBe('created');
    expect(selectedValue(res.text, 'projectsOrder')).toBe('desc');
    expect(selectedValue(res.text, 'releasesView')).toBe('list');
    expect(selectedValue(res.text, 'releasesSort')).toBe('planned');
    expect(selectedValue(res.text, 'releasesOrder')).toBe('asc');
    expect(selectedValue(res.text, 'releaseManagementView')).toBe('list');
    expect(selectedValue(res.text, 'releaseManagementSort')).toBe('updated');
    expect(selectedValue(res.text, 'releaseManagementOrder')).toBe('desc');
    expect(selectedValue(res.text, 'projectAssetsView')).toBe('grid');
    expect(selectedValue(res.text, 'projectAssetsSort')).toBe('filename');
    expect(selectedValue(res.text, 'projectAssetsOrder')).toBe('asc');
    expect(selectedValue(res.text, 'projectAssetsPageSize')).toBe('25');
    expect(selectedValue(res.text, 'assetViewerView')).toBe('grid');
    expect(selectedValue(res.text, 'assetViewerSort')).toBe('filename');
    expect(selectedValue(res.text, 'assetViewerOrder')).toBe('asc');
    expect(selectedValue(res.text, 'assetViewerPageSize')).toBe('25');
    expect(selectedValue(res.text, 'new_projectStatus')).toBe('tbd');
    expect(selectedValue(res.text, 'project-assets-default-category')).toBe('all');
    expect((res.text.match(/Application fallback:/g) || [])).toHaveLength(18);
    expect(res.text).toContain('<label for="releaseManagementView">Default view</label>');
    expect(res.text).toContain('<option value="board">Board</option>');
    expect(res.text).toContain('<option value="tbd" selected>TBD</option>');
    expect(res.text).toContain('<option value="planned">Planned</option>');
    expect(res.text).toContain('<option value="in-progress">In progress</option>');
    expect(res.text).toContain('<option value="ready">Ready</option>');
  });

  it('uses saved valid values and fallbacks for invalid stored values without displaying invalid storage', async () => {
    writeMeta(db, defaultKey('projects', 'view'), 'list');
    writeMeta(db, defaultKey('projects', 'sort'), 'not-a-project-sort');
    writeMeta(db, defaultKey('projects', 'order'), 'asc');
    writeMeta(db, defaultKey('releases', 'view'), 'not-a-view');
    writeMeta(db, defaultKey('releases', 'sort'), 'title');
    writeMeta(db, defaultKey('releases', 'order'), 'not-an-order');
    writeMeta(db, defaultKey('releaseManagement', 'view'), 'grid');
    writeMeta(db, defaultKey('releaseManagement', 'sort'), 'published');
    writeMeta(db, defaultKey('releaseManagement', 'order'), 'forwards');
    writeMeta(db, defaultKey('projectAssets', 'view'), 'board');
    writeMeta(db, defaultKey('projectAssets', 'sort'), 'published');
    writeMeta(db, defaultKey('projectAssets', 'order'), 'forwards');
    writeMeta(db, defaultKey('projectAssets', 'pageSize'), '20');
    writeMeta(db, defaultKey('assetViewer', 'view'), 'board');
    writeMeta(db, defaultKey('assetViewer', 'sort'), 'title');
    writeMeta(db, defaultKey('assetViewer', 'order'), 'forwards');
    writeMeta(db, defaultKey('assetViewer', 'pageSize'), '20');
    writeMeta(db, defaultKey('new_project', 'status'), 'cancelled');
    writeMeta(db, LEGACY_NEW_PROJECT_PRIORITY_KEY, 'urgent');
    writeMeta(db, 'asset_browser.default_category', 'does-not-exist');

    const res = await agent.get('/settings/defaults').expect(200);

    expect(selectedValue(res.text, 'projectsView')).toBe('list');
    expect(selectedValue(res.text, 'projectsSort')).toBe('created');
    expect(selectedValue(res.text, 'projectsOrder')).toBe('asc');
    expect(selectedValue(res.text, 'releasesView')).toBe('list');
    expect(selectedValue(res.text, 'releasesSort')).toBe('title');
    expect(selectedValue(res.text, 'releasesOrder')).toBe('asc');
    expect(selectedValue(res.text, 'releaseManagementView')).toBe('list');
    expect(selectedValue(res.text, 'releaseManagementSort')).toBe('updated');
    expect(selectedValue(res.text, 'releaseManagementOrder')).toBe('desc');
    expect(selectedValue(res.text, 'projectAssetsView')).toBe('grid');
    expect(selectedValue(res.text, 'projectAssetsSort')).toBe('filename');
    expect(selectedValue(res.text, 'projectAssetsOrder')).toBe('asc');
    expect(selectedValue(res.text, 'projectAssetsPageSize')).toBe('25');
    expect(selectedValue(res.text, 'assetViewerView')).toBe('grid');
    expect(selectedValue(res.text, 'assetViewerSort')).toBe('filename');
    expect(selectedValue(res.text, 'assetViewerOrder')).toBe('asc');
    expect(selectedValue(res.text, 'assetViewerPageSize')).toBe('25');
    expect(selectedValue(res.text, 'new_projectStatus')).toBe('tbd');
    expect(res.text).not.toContain('new_projectPriority');
    expect(readMeta(db, LEGACY_NEW_PROJECT_PRIORITY_KEY)).toBe('urgent');
    expect(res.text).toContain('Category &quot;does-not-exist&quot; (unavailable)');
    expect(res.text).toContain('Effective:</span> <strong>All Categories</strong>');
    expect((res.text.match(/Application fallback:/g) || [])).toHaveLength(15);
    expect(res.text).not.toContain('not-a-project-sort');
    expect(res.text).not.toContain('not-a-view');
    expect(res.text).not.toContain('not-an-order');
    expect(res.text).not.toContain('<option value="board" selected>');
    expect(res.text).not.toContain('value="published" selected');
    expect(res.text).not.toContain('value="forwards"');
    expect(res.text).not.toContain('value="20"');
    expect(res.text).not.toMatch(/<select id="assetViewerSort"[\s\S]*?value="title" selected/);
    expect(res.text).not.toContain('value="cancelled"');
    expect(res.text).not.toContain('value="urgent"');
  });

  it('renders the existing saved global category preference through its original slug semantics', async () => {
    writeMeta(db, 'asset_browser.default_category', 'wip');

    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).toContain('<option value="wip" selected>WIP</option>');
    expect(res.text).toContain('Saved:</span> <strong>WIP</strong>');
  });

  it('saves all Defaults values through the service, redirects, shows a success notice, and preserves unrelated app_meta values', async () => {
    writeMeta(db, 'unrelated.preference', 'preserve-me');
    const assetBrowserDefaultBefore = readMeta(db, 'asset_browser.default_category');
    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status)
      VALUES (?, ?, ?, ?, ?)
    `).run('Existing Project', 'existing-project', 'Description', 'Notes', 'planned').lastInsertRowid);
    const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    const save = await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);

    expect(save.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(readMeta(db, defaultKey('projects', 'view'))).toBe('list');
    expect(readMeta(db, defaultKey('projects', 'sort'))).toBe('title');
    expect(readMeta(db, defaultKey('projects', 'order'))).toBe('asc');
    expect(readMeta(db, defaultKey('releases', 'view'))).toBe('board');
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe('title');
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe('desc');
    expect(readMeta(db, defaultKey('releaseManagement', 'view'))).toBe('board');
    expect(readMeta(db, defaultKey('releaseManagement', 'sort'))).toBe('planned');
    expect(readMeta(db, defaultKey('releaseManagement', 'order'))).toBe('asc');
    expect(readMeta(db, defaultKey('projectAssets', 'view'))).toBe('list');
    expect(readMeta(db, defaultKey('projectAssets', 'sort'))).toBe('category');
    expect(readMeta(db, defaultKey('projectAssets', 'order'))).toBe('asc');
    expect(readMeta(db, defaultKey('projectAssets', 'pageSize'))).toBe('50');
    expect(readMeta(db, defaultKey('assetViewer', 'view'))).toBe('list');
    expect(readMeta(db, defaultKey('assetViewer', 'sort'))).toBe('project');
    expect(readMeta(db, defaultKey('assetViewer', 'order'))).toBe('desc');
    expect(readMeta(db, defaultKey('assetViewer', 'pageSize'))).toBe('100');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
    expect(readMeta(db, 'asset_browser.default_category')).toBe('all');
    expect(readMeta(db, 'unrelated.preference')).toBe('preserve-me');
    expect(assetBrowserDefaultBefore).toBe('all');
    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual(projectBefore);

    const redirected = await agent.get(save.headers.location).expect(200);
    expect(redirected.text).toContain('Page defaults saved successfully.');
    expect(redirected.text).toContain('notice--success');
    expect(selectedValue(redirected.text, 'projectsView')).toBe('list');
    expect(selectedValue(redirected.text, 'releasesSort')).toBe('title');
    expect(selectedValue(redirected.text, 'releaseManagementView')).toBe('board');
    expect(selectedValue(redirected.text, 'releaseManagementSort')).toBe('planned');
    expect(selectedValue(redirected.text, 'releaseManagementOrder')).toBe('asc');
    expect(selectedValue(redirected.text, 'projectAssetsPageSize')).toBe('50');
    expect(selectedValue(redirected.text, 'assetViewerView')).toBe('list');
    expect(selectedValue(redirected.text, 'assetViewerSort')).toBe('project');
    expect(selectedValue(redirected.text, 'assetViewerOrder')).toBe('desc');
    expect(selectedValue(redirected.text, 'assetViewerPageSize')).toBe('100');
    expect(selectedValue(redirected.text, 'new_projectStatus')).toBe('ready');
    expect(selectedValue(redirected.text, 'project-assets-default-category')).toBe('all');
  });

  it('rejects invalid submitted values with field feedback and preserves every stored default', async () => {
    const existing = {
      projectsView: 'grid',
      projectsSort: 'created',
      projectsOrder: 'desc',
      releasesView: 'list',
      releasesSort: 'planned',
      releasesOrder: 'asc',
      projectAssetsView: 'grid',
      projectAssetsSort: 'filename',
      projectAssetsOrder: 'asc',
      projectAssetsPageSize: '25',
      new_projectStatus: 'tbd',
      defaultCategory: 'all',
    };
    writeMeta(db, defaultKey('projects', 'view'), existing.projectsView);
    writeMeta(db, defaultKey('projects', 'sort'), existing.projectsSort);
    writeMeta(db, defaultKey('projects', 'order'), existing.projectsOrder);
    writeMeta(db, defaultKey('releases', 'view'), existing.releasesView);
    writeMeta(db, defaultKey('releases', 'sort'), existing.releasesSort);
    writeMeta(db, defaultKey('releases', 'order'), existing.releasesOrder);
    writeMeta(db, defaultKey('projectAssets', 'view'), existing.projectAssetsView);
    writeMeta(db, defaultKey('projectAssets', 'sort'), existing.projectAssetsSort);
    writeMeta(db, defaultKey('projectAssets', 'order'), existing.projectAssetsOrder);
    writeMeta(db, defaultKey('projectAssets', 'pageSize'), existing.projectAssetsPageSize);
    writeMeta(db, defaultKey('new_project', 'status'), existing.new_projectStatus);
    writeMeta(db, 'asset_browser.default_category', existing.defaultCategory);

    const res = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        ...VALID_DEFAULTS,
        projectAssetsSort: 'unsupported',
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('Defaults could not be saved.');
    expect(res.text).toContain('projectAssets.sort');
    expect(res.text).toContain('Submitted value: unsupported');
    expect(readMeta(db, defaultKey('projects', 'view'))).toBe(existing.projectsView);
    expect(readMeta(db, defaultKey('projects', 'sort'))).toBe(existing.projectsSort);
    expect(readMeta(db, defaultKey('projects', 'order'))).toBe(existing.projectsOrder);
    expect(readMeta(db, defaultKey('releases', 'view'))).toBe(existing.releasesView);
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe(existing.releasesSort);
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe(existing.releasesOrder);
    expect(readMeta(db, defaultKey('projectAssets', 'view'))).toBe(existing.projectAssetsView);
    expect(readMeta(db, defaultKey('projectAssets', 'sort'))).toBe(existing.projectAssetsSort);
    expect(readMeta(db, defaultKey('projectAssets', 'order'))).toBe(existing.projectAssetsOrder);
    expect(readMeta(db, defaultKey('projectAssets', 'pageSize'))).toBe(existing.projectAssetsPageSize);
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe(existing.new_projectStatus);
    expect(readMeta(db, 'asset_browser.default_category')).toBe(existing.defaultCategory);
  });

  it('rejects an invalid New Project status before partially saving any Defaults values', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);

    const res = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        ...VALID_DEFAULTS,
        projectsView: 'grid',
        projectAssetsPageSize: '100',
        new_projectStatus: 'cancelled',
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('new_project.status');
    expect(res.text).toContain('Submitted value: cancelled');
    expect(readMeta(db, defaultKey('projects', 'view'))).toBe(VALID_DEFAULTS.projectsView);
    expect(readMeta(db, defaultKey('projects', 'sort'))).toBe(VALID_DEFAULTS.projectsSort);
    expect(readMeta(db, defaultKey('projects', 'order'))).toBe(VALID_DEFAULTS.projectsOrder);
    expect(readMeta(db, defaultKey('releases', 'view'))).toBe(VALID_DEFAULTS.releasesView);
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe(VALID_DEFAULTS.releasesSort);
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe(VALID_DEFAULTS.releasesOrder);
    expect(readMeta(db, defaultKey('projectAssets', 'view'))).toBe(VALID_DEFAULTS.projectAssetsView);
    expect(readMeta(db, defaultKey('projectAssets', 'sort'))).toBe(VALID_DEFAULTS.projectAssetsSort);
    expect(readMeta(db, defaultKey('projectAssets', 'order'))).toBe(VALID_DEFAULTS.projectAssetsOrder);
    expect(readMeta(db, defaultKey('projectAssets', 'pageSize'))).toBe(VALID_DEFAULTS.projectAssetsPageSize);
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe(VALID_DEFAULTS.new_projectStatus);
    expect(readMeta(db, 'asset_browser.default_category')).toBe(VALID_DEFAULTS.defaultCategory);
  });

  it('ignores obsolete stored and submitted New Release status defaults', async () => {
    const obsoleteKey = 'page_defaults.new_release.status';
    writeMeta(db, obsoleteKey, 'cancelled');

    const rendered = await agent.get('/settings/defaults').expect(200);
    expect(rendered.text).not.toContain('new_releaseStatus');
    expect(rendered.text).not.toContain('New Releases');

    const saved = await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, new_releaseStatus: 'published', _csrf: csrfToken })
      .expect(302);

    expect(saved.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(readMeta(db, obsoleteKey)).toBe('cancelled');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe(VALID_DEFAULTS.new_projectStatus);
  });

  it('rejects an invalid Release Management value before partially saving any Defaults values', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);

    const res = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        ...VALID_DEFAULTS,
        projectsView: 'grid',
        releaseManagementView: 'kanban',
        projectAssetsPageSize: '100',
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('releaseManagement.view');
    expect(res.text).toContain('Submitted value: kanban');
    for (const [page, options] of Object.entries(PAGE_DEFAULT_DEFINITIONS)) {
      for (const option of Object.keys(options)) {
        expect(readMeta(db, defaultKey(page, option))).toBe(
          VALID_DEFAULTS[`${page}${option.charAt(0).toUpperCase()}${option.slice(1)}`]
        );
      }
    }
    expect(readMeta(db, 'asset_browser.default_category')).toBe(VALID_DEFAULTS.defaultCategory);
  });

  it('rejects an invalid Asset Viewer value before partially saving any Defaults values', async () => {
    writeMeta(db, 'unrelated.preference', 'preserve-me');

    await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);

    const res = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        ...VALID_DEFAULTS,
        projectsView: 'grid',
        projectsSort: 'created',
        projectsOrder: 'desc',
        releasesView: 'list',
        releasesSort: 'planned',
        releasesOrder: 'asc',
        releaseManagementView: 'list',
        releaseManagementSort: 'updated',
        releaseManagementOrder: 'desc',
        projectAssetsView: 'grid',
        projectAssetsSort: 'filename',
        projectAssetsOrder: 'desc',
        projectAssetsPageSize: '10',
        assetViewerView: 'grid',
        assetViewerSort: 'title',
        assetViewerOrder: 'asc',
        assetViewerPageSize: '10',
        new_projectStatus: 'tbd',
        defaultCategory: 'all',
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('assetViewer.sort');
    expect(res.text).toContain('Submitted value: title');
    for (const [page, options] of Object.entries(PAGE_DEFAULT_DEFINITIONS)) {
      for (const option of Object.keys(options)) {
        expect(readMeta(db, defaultKey(page, option))).toBe(
          VALID_DEFAULTS[`${page}${option.charAt(0).toUpperCase()}${option.slice(1)}`]
        );
      }
    }
    expect(readMeta(db, 'asset_browser.default_category')).toBe(VALID_DEFAULTS.defaultCategory);
    expect(readMeta(db, 'unrelated.preference')).toBe('preserve-me');
  });

  it('requires CSRF for the defaults mutation', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send(VALID_DEFAULTS)
      .expect(403);

    expect(readMeta(db, defaultKey('projects', 'view'))).toBeUndefined();
  });
});
