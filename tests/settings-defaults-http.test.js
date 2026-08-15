import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
const GLOBAL_ASSET_BROWSER_DEFAULT_KEY = 'asset_browser.default_category';

const VALID_DEFAULTS = {
  releaseManagementView: 'board',
  releaseManagementSort: 'planned',
  releaseManagementOrder: 'asc',
  new_projectStatus: 'ready',
};

const NEW_PROJECT_STATUS_OPTIONS = [
  ['tbd', 'TBD'],
  ['planned', 'Planned'],
  ['in-progress', 'In progress'],
  ['ready', 'Ready'],
  ['completed', 'Completed'],
];

const MOVED_DEFAULTS = {
  releasesView: 'board',
  releasesSort: 'title',
  releasesOrder: 'desc',
  projectAssetsView: 'list',
  projectAssetsSort: 'category',
  projectAssetsOrder: 'asc',
  projectAssetsPageSize: '50',
  assetViewerView: 'list',
  assetViewerSort: 'project',
  assetViewerOrder: 'desc',
  assetViewerPageSize: '100',
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

function settingsSection(html, id) {
  return html.match(new RegExp(`<section id="${id}"[\\s\\S]*?<\\/section>`))?.[0] || '';
}

function defaultKey(page, option) {
  return PAGE_DEFAULT_DEFINITIONS[page][option].key;
}

function movedStorageSnapshot(db) {
  return Object.fromEntries(
    Object.entries(MOVED_DEFAULTS).map(([field, value]) => {
      const page = field.startsWith('releases') ? 'releases'
        : field.startsWith('projectAssets') ? 'projectAssets'
          : 'assetViewer';
      const option = field.replace(page, '').replace(/^./, (char) => char.toLowerCase());
      return [field, readMeta(db, defaultKey(page, option))];
    }),
  );
}

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

  it('renders only New Projects and Release Management, with moved sections and anchors absent', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).toContain('Settings — Defaults');
    expect(res.text).toContain('<section id="defaults-new-projects" class="settings-section" aria-labelledby="defaults-new-projects-heading">');
    expect(res.text).toContain('<h3 id="defaults-new-projects-heading">New Projects</h3>');
    expect(res.text).toContain('<section id="defaults-release-management" class="settings-section" aria-labelledby="defaults-release-management-heading">');
    expect(res.text).toContain('<h3 id="defaults-release-management-heading">Release Management</h3>');
    expect((res.text.match(/<section id="defaults-[^"]+" class="settings-section" aria-labelledby="defaults-[^"]+-heading">/g) || [])).toHaveLength(2);

    for (const removed of [
      'defaults-project-assets',
      'defaults-asset-viewer',
      'defaults-releases',
      'defaultCategory',
      'projectAssetsView',
      'assetViewerView',
      'releasesView',
    ]) {
      expect(res.text).not.toContain(removed);
    }

    expect((res.text.match(/<select /g) || [])).toHaveLength(4);
    expect(res.text).toContain('id="new_projectStatus" name="new_projectStatus"');
    expect(res.text).toContain('id="releaseManagementView" name="releaseManagementView"');
    expect(res.text).toContain('id="releaseManagementSort" name="releaseManagementSort"');
    expect(res.text).toContain('id="releaseManagementOrder" name="releaseManagementOrder"');
  });

  it('uses a native-backed single select only for New Projects Status', async () => {
    const res = await agent.get('/settings/defaults').expect(200);
    const newProjects = settingsSection(res.text, 'defaults-new-projects');
    const statusSelect = newProjects.match(/<select id="new_projectStatus"[\s\S]*?<\/select>/)?.[0] || '';
    const releaseManagement = settingsSection(res.text, 'defaults-release-management');

    expect(newProjects).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(statusSelect).toMatch(
      /<select id="new_projectStatus" name="new_projectStatus" class="cc-dropdown-native-select" data-cc-dropdown-native-select[^>]*required>/,
    );
    expect(statusSelect).not.toBe('');
    for (const [value, label] of NEW_PROJECT_STATUS_OPTIONS) {
      expect(statusSelect).toMatch(new RegExp(`<option value="${value}"(?: selected)?\>${label}<\\/option>`));
    }
    expect(statusSelect).toContain('<option value="tbd" selected>TBD</option>');
    expect(newProjects).toMatch(/<input[^>]*type="radio" value="tbd"[^>]*checked/);
    expect(newProjects).not.toMatch(/<input[^>]*name="new_projectStatus"/);
    expect((newProjects.match(/name="new_projectStatus"/g) || [])).toHaveLength(1);
    expect(newProjects).not.toContain('aria-invalid');
    expect(newProjects).not.toContain('new_projectStatus-error');

    expect(releaseManagement).not.toContain('data-cc-dropdown');
    expect(releaseManagement).not.toContain('<details');
    expect((releaseManagement.match(/<select /g) || [])).toHaveLength(3);
    for (const id of ['releaseManagementView', 'releaseManagementSort', 'releaseManagementOrder']) {
      expect(releaseManagement).toContain(`id="${id}"`);
    }
  });

  it('uses application fallbacks for the remaining Settings-owned defaults', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(selectedValue(res.text, 'new_projectStatus')).toBe('tbd');
    expect(selectedValue(res.text, 'releaseManagementView')).toBe('list');
    expect(selectedValue(res.text, 'releaseManagementSort')).toBe('updated');
    expect(selectedValue(res.text, 'releaseManagementOrder')).toBe('desc');
    expect((res.text.match(/Application fallback:/g) || [])).toHaveLength(4);
    expect(res.text).toContain('These defaults apply only to new projects. Changing them does not modify existing projects.');
  });

  it('leaves moved stored values untouched and does not render them on GET', async () => {
    for (const [field, value] of Object.entries(MOVED_DEFAULTS)) {
      const page = field.startsWith('releases') ? 'releases'
        : field.startsWith('projectAssets') ? 'projectAssets'
          : 'assetViewer';
      const option = field.replace(page, '').replace(/^./, (char) => char.toLowerCase());
      writeMeta(db, defaultKey(page, option), value);
    }
    writeMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY, 'wip');
    writeMeta(db, LEGACY_NEW_PROJECT_PRIORITY_KEY, 'urgent');

    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).not.toContain('defaults-project-assets');
    expect(res.text).not.toContain('defaults-asset-viewer');
    expect(res.text).not.toContain('defaults-releases');
    expect(res.text).not.toContain('defaultCategory');
    expect(res.text).not.toContain('urgent');
    expect(res.text).not.toContain('wip');
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
    expect(readMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY)).toBe('wip');
    expect(readMeta(db, LEGACY_NEW_PROJECT_PRIORITY_KEY)).toBe('urgent');
  });

  it('saves New Projects and Release Management without moved fields and preserves moved namespaces', async () => {
    for (const [field, value] of Object.entries(MOVED_DEFAULTS)) {
      const page = field.startsWith('releases') ? 'releases'
        : field.startsWith('projectAssets') ? 'projectAssets'
          : 'assetViewer';
      const option = field.replace(page, '').replace(/^./, (char) => char.toLowerCase());
      writeMeta(db, defaultKey(page, option), value);
    }
    writeMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY, 'wip');

    const save = await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);

    expect(save.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
    expect(readMeta(db, defaultKey('releaseManagement', 'view'))).toBe('board');
    expect(readMeta(db, defaultKey('releaseManagement', 'sort'))).toBe('planned');
    expect(readMeta(db, defaultKey('releaseManagement', 'order'))).toBe('asc');
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
    expect(readMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY)).toBe('wip');

    const rendered = await agent.get(save.headers.location).expect(200);
    expect(selectedValue(rendered.text, 'new_projectStatus')).toBe('ready');
    expect(selectedValue(rendered.text, 'releaseManagementView')).toBe('board');
    expect(selectedValue(rendered.text, 'releaseManagementSort')).toBe('planned');
    expect(selectedValue(rendered.text, 'releaseManagementOrder')).toBe('asc');
  });

  it('ignores invalid moved fields rather than validating or saving them', async () => {
    const before = movedStorageSnapshot(db);

    const save = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        ...VALID_DEFAULTS,
        releasesView: 'invalid',
        projectAssetsSort: 'invalid',
        assetViewerPageSize: 'invalid',
        defaultCategory: 'invalid',
        _csrf: csrfToken,
      })
      .expect(302);

    expect(save.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(movedStorageSnapshot(db)).toEqual(before);
  });

  it('rejects invalid remaining values without changing any stored defaults', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);
    const movedBefore = movedStorageSnapshot(db);

    const res = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        ...VALID_DEFAULTS,
        releaseManagementView: 'kanban',
        new_projectStatus: 'cancelled',
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('releaseManagement.view');
    expect(res.text).toContain('new_project.status');
    expect(res.text).toContain('Submitted value: kanban');
    expect(res.text).toContain('Submitted value: cancelled');
    const newProjects = settingsSection(res.text, 'defaults-new-projects');
    const statusSelect = newProjects.match(/<select id="new_projectStatus"[\s\S]*?<\/select>/)?.[0] || '';
    expect(statusSelect).toContain('<option value="cancelled" selected>Submitted value: cancelled</option>');
    expect(statusSelect).toMatch(/aria-describedby="new_projectStatus-error"[^>]*aria-invalid="true"/);
    expect(newProjects).toMatch(
      /<summary[^>]*aria-describedby="new_projectStatus-error"[^>]*aria-invalid="true"/,
    );
    expect(newProjects).toMatch(/id="new_projectStatus-submitted"[^>]*value="cancelled"[^>]*checked/);
    expect(newProjects).not.toMatch(/<input[^>]*name="new_projectStatus"/);
    expect(res.text).toContain(
      'class="field-error-message" id="new_projectStatus-error">Value &quot;cancelled&quot; is not supported for new_project.status.</span>',
    );
    expect(movedStorageSnapshot(db)).toEqual(movedBefore);
    expect(readMeta(db, defaultKey('releaseManagement', 'view'))).toBe('board');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
  });

  it('requires CSRF for the remaining Defaults mutation', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send(VALID_DEFAULTS)
      .expect(403);

    expect(readMeta(db, defaultKey('new_project', 'status'))).toBeUndefined();
    expect(readMeta(db, defaultKey('releaseManagement', 'view'))).toBeUndefined();
  });

  it('does not render obsolete Projects or New Releases defaults', async () => {
    writeMeta(db, defaultKey('projects', 'view'), 'list');
    writeMeta(db, 'page_defaults.new_release.status', 'cancelled');

    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).not.toContain('defaults-projects');
    expect(res.text).not.toContain('projectsView');
    expect(res.text).not.toContain('new_releaseStatus');
    expect(res.text).not.toContain('New Releases');
    expect(readMeta(db, defaultKey('projects', 'view'))).toBe('list');
    expect(readMeta(db, 'page_defaults.new_release.status')).toBe('cancelled');
  });
});
