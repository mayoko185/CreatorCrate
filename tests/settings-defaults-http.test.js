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
const GLOBAL_ASSET_BROWSER_DEFAULT_KEY = 'asset_browser.default_category';

const VALID_DEFAULTS = {
  new_projectStatus: 'ready',
  releasesSort: 'planned',
  releasesOrder: 'asc',
};

const NEW_PROJECT_STATUS_OPTIONS = [
  ['tbd', 'TBD'],
  ['planned', 'Planned'],
  ['in-progress', 'In progress'],
  ['ready', 'Ready'],
  ['completed', 'Completed'],
];

const MOVED_DEFAULTS = {
  projectAssetsView: 'list',
  projectAssetsSort: 'category',
  projectAssetsOrder: 'asc',
  projectAssetsPageSize: '50',
  assetViewerView: 'list',
  assetViewerSort: 'project',
  assetViewerOrder: 'desc',
  assetViewerPageSize: '100',
};

function readMeta(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(key);
}

function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
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
    Object.entries(MOVED_DEFAULTS).map(([field]) => {
      const page = field.startsWith('projectAssets') ? 'projectAssets' : 'assetViewer';
      const option = field.replace(page, '').replace(/^./, (char) => char.toLowerCase());
      return [field, readMeta(db, defaultKey(page, option))];
    }),
  );
}

function seedMovedDefaults(db) {
  for (const [field, value] of Object.entries(MOVED_DEFAULTS)) {
    const page = field.startsWith('projectAssets') ? 'projectAssets' : 'assetViewer';
    const option = field.replace(page, '').replace(/^./, (char) => char.toLowerCase());
    writeMeta(db, defaultKey(page, option), value);
  }
  writeMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY, 'wip');
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
    app = createApp({ appName: 'CreatorCrate', db }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders canonical Releases defaults without a Release Management namespace', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).toContain('<section id="defaults-releases" class="settings-section" aria-labelledby="defaults-releases-heading">');
    expect(res.text).toContain('<h3 id="defaults-releases-heading">Releases</h3>');
    expect(res.text).toContain('id="releasesSort" name="releasesSort"');
    expect(res.text).toContain('id="releasesOrder" name="releasesOrder"');
    expect(selectedValue(res.text, 'releasesSort')).toBe('planned');
    expect(selectedValue(res.text, 'releasesOrder')).toBe('asc');
    expect(res.text).not.toContain('defaults-release-management');
    expect(res.text).not.toContain('releaseManagement');
  });

  it('uses the native-backed single select contract for New Projects Status', async () => {
    const res = await agent.get('/settings/defaults').expect(200);
    const newProjects = settingsSection(res.text, 'defaults-new-projects');
    const statusSelect = newProjects.match(/<select id="new_projectStatus"[\s\S]*?<\/select>/)?.[0] || '';

    expect(newProjects).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(statusSelect).toMatch(
      /<select id="new_projectStatus" name="new_projectStatus" class="cc-dropdown-native-select" data-cc-dropdown-native-select[^>]*required>/,
    );
    expect(statusSelect).not.toBe('');
    for (const [value, label] of NEW_PROJECT_STATUS_OPTIONS) {
      expect(statusSelect).toMatch(new RegExp(`<option value="${value}"(?: selected)?>${label}</option>`));
    }
    expect(statusSelect).toContain('<option value="tbd" selected>TBD</option>');
    expect(newProjects).toMatch(/<input[^>]*type="radio" value="tbd"[^>]*checked/);
    expect(newProjects).not.toMatch(/<input[^>]*name="new_projectStatus"/);
    expect((newProjects.match(/name="new_projectStatus"/g) || [])).toHaveLength(1);
    expect(newProjects).not.toContain('aria-invalid');
    expect(newProjects).not.toContain('new_projectStatus-error');
  });

  it('uses application fallbacks for current Settings-owned defaults', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(selectedValue(res.text, 'new_projectStatus')).toBe('tbd');
    expect(selectedValue(res.text, 'releasesSort')).toBe('planned');
    expect(selectedValue(res.text, 'releasesOrder')).toBe('asc');
    expect((res.text.match(/Application fallback:/g) || [])).toHaveLength(3);
    expect(res.text).toContain('These defaults apply only to new projects. Changing them does not modify existing projects.');
  });

  it('leaves moved stored values untouched and does not render them on GET', async () => {
    seedMovedDefaults(db);

    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).not.toContain('defaults-project-assets');
    expect(res.text).not.toContain('defaults-asset-viewer');
    expect(res.text).not.toContain('defaultCategory');
    expect(res.text).not.toContain('wip');
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
    expect(readMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY)).toBe('wip');
  });

  it('saves canonical Releases defaults without clobbering moved namespaces', async () => {
    seedMovedDefaults(db);
    writeMeta(db, 'page_defaults.release_management.sort', 'updated');
    writeMeta(db, 'page_defaults.release_management.order', 'desc');

    const save = await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);

    expect(save.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe('planned');
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe('asc');
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
    expect(readMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY)).toBe('wip');
    expect(readMeta(db, 'page_defaults.release_management.sort')).toBe('updated');
    expect(readMeta(db, 'page_defaults.release_management.order')).toBe('desc');
  });

  it('records only effective page-default changes with safe aggregate context', async () => {
    await agent.post('/settings/defaults').type('form').send({ ...VALID_DEFAULTS, _csrf: csrfToken }).expect(302);
    await agent.post('/settings/defaults').type('form').send({ ...VALID_DEFAULTS, _csrf: csrfToken }).expect(302);
    await agent.post('/settings/defaults').type('form').send({
      new_projectStatus: 'invalid', releasesSort: 'planned', releasesOrder: 'asc', _csrf: csrfToken,
    }).expect(422);

    const rows = db.prepare("SELECT event, level, kind, context_json FROM application_logs WHERE event = 'settings.defaults.updated'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'settings.defaults.updated', level: 'info', kind: 'activity' });
    expect(JSON.parse(rows[0].context_json)).toEqual({ changedPages: ['new_project'], changedOptionCount: 1 });
  });

  it('records a committed defaults change when the legacy snapshot API is unavailable', async () => {
    app.locals.pageDefaultsService.resolvePageDefaults = () => {
      throw new Error('legacy snapshot unavailable');
    };

    await agent.post('/settings/defaults').type('form').send({ ...VALID_DEFAULTS, _csrf: csrfToken }).expect(302);

    const rows = db.prepare("SELECT event FROM application_logs WHERE event = 'settings.defaults.updated'").all();
    expect(rows).toEqual([{ event: 'settings.defaults.updated' }]);
  });

  it('preserves a completed Settings mutation when activity logging fails', async () => {
    const failingLogger = {
      info() { throw new Error('logger unavailable'); },
      rebindRepository() {},
      prune() {},
    };
    const failingApp = createApp(
      { appName: 'CreatorCrate', db },
      { authConfig: AUTH_CONFIG, applicationLogger: failingLogger },
    );
    const authenticated = await authenticate(failingApp);
    await authenticated.agent.post('/settings/defaults').type('form')
      .send({ ...VALID_DEFAULTS, _csrf: authenticated.csrfToken })
      .expect(302);
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
  });

  it('ignores invalid moved fields rather than validating or saving them', async () => {
    seedMovedDefaults(db);

    const save = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        ...VALID_DEFAULTS,
        releaseManagementView: 'invalid',
        projectAssetsSort: 'invalid',
        assetViewerPageSize: 'invalid',
        defaultCategory: 'invalid',
        _csrf: csrfToken,
      })
      .expect(302);

    expect(save.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
    expect(readMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY)).toBe('wip');
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe('planned');
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe('asc');
  });

  it('rejects invalid Settings values without mutating defaults and preserves New Projects Status accessibility', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);
    seedMovedDefaults(db);

    const res = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        new_projectStatus: 'cancelled',
        releasesSort: 'published',
        releasesOrder: 'asc',
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('new_project.status');
    expect(res.text).toContain('releases.sort');
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
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe('planned');
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe('asc');
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
  });

  it('requires CSRF for the remaining Defaults mutation', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send(VALID_DEFAULTS)
      .expect(403);

    expect(readMeta(db, defaultKey('new_project', 'status'))).toBeUndefined();
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBeUndefined();
    expect(readMeta(db, defaultKey('releases', 'order'))).toBeUndefined();
  });

  it('does not render obsolete Projects or New Releases defaults', async () => {
    writeMeta(db, defaultKey('projects', 'view'), 'list');
    writeMeta(db, 'page_defaults.new_release.status', 'cancelled');

    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).toContain('defaults-new-projects');
    expect(res.text).toContain('defaults-releases');
    expect(res.text).not.toContain('defaults-projects');
    expect(res.text).not.toContain('projectsView');
    expect(res.text).not.toContain('new_releaseStatus');
    expect(res.text).not.toContain('New Releases');
    expect(readMeta(db, defaultKey('projects', 'view'))).toBe('list');
    expect(readMeta(db, 'page_defaults.new_release.status')).toBe('cancelled');
  });
});
