import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { NOTE_REVISION_RETENTION_KEY } from '../src/services/note-revision-settings-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const GLOBAL_ASSET_BROWSER_DEFAULT_KEY = 'asset_browser.default_category';

const VALID_DEFAULTS = {
  new_projectStatus: 'ready',
  new_projectProjectType: 'comic',
};

const NEW_PROJECT_STATUS_OPTIONS = [
  ['tbd', 'Tbd'],
  ['planned', 'Planned'],
  ['in-progress', 'In Progress'],
  ['ready', 'Ready'],
  ['completed', 'Completed'],
];

const NEW_PROJECT_TYPE_OPTIONS = [
  ['images', 'Images'],
  ['comic', 'Comic'],
  ['animation', 'Animation'],
  ['wallpaper', 'Wallpaper'],
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

function inputMarkup(html, id) {
  return html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] || '';
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

  it('does not render obsolete Releases defaults or their anchor', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).not.toContain('defaults-releases');
    expect(res.text).not.toContain('id="releasesSort"');
    expect(res.text).not.toContain('id="releasesOrder"');
    expect(res.text).not.toContain('Release Management');
  });

  it('keeps the Defaults form intact without a normal Save action and with a no-JS fallback', async () => {
    const res = await agent.get('/settings/defaults').expect(200);
    const heading = res.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';
    const form = res.text.match(/<form id="settings-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';

    expect(heading).not.toContain('Save Defaults');
    expect(form).toContain('method="post" action="/settings/defaults"');
    expect(form).toContain('name="_csrf" value="');
    for (const field of Object.keys(VALID_DEFAULTS)) {
      expect(form).toContain(`name="${field}"`);
    }
    expect(form).toContain('id="defaults-new-projects" class="settings-section settings-defaults-section"');
    expect(form).toContain('id="defaults-notes" class="settings-section settings-defaults-section"');
    expect(form).not.toContain('id="defaults-releases"');
    expect(form).toContain('data-settings-fetch-save-status role="status" aria-live="polite" aria-atomic="true"');
    expect(res.text.indexOf('data-settings-defaults-region')).toBeLessThan(res.text.indexOf('<form id="settings-defaults-form"'));
    expect(form).toContain('<noscript>');
    expect(form).toContain('<button type="submit" class="button button-primary">Save Defaults</button>');
  });

  it('renders Note revision retention with fallback 10 without persisting it on GET', async () => {
    const res = await agent.get('/settings/defaults').expect(200);
    const notes = settingsSection(res.text, 'defaults-notes');
    const input = inputMarkup(notes, 'noteRevisionRetention');

    expect(notes).toContain('<h3 id="defaults-notes-heading">Notes</h3>');
    expect(notes).toContain('<label for="noteRevisionRetention">Old revisions to keep</label>');
    expect(notes).toContain('Number of previous revisions retained for each Note; the current Note is additional. Changes take effect when a Note is next changed or restored.');
    expect(input).toMatch(/name="noteRevisionRetention" type="number"/);
    expect(input).toContain('value="10"');
    expect(input).toContain('min="1" max="9007199254740991" step="1" required');
    expect(input).toContain('data-autosubmit="fetch"');
    expect(notes).toContain('Application fallback: <strong>10</strong>');
    expect(readMeta(db, NOTE_REVISION_RETENTION_KEY)).toBeUndefined();
  });

  it('renders the saved Note revision retention value', async () => {
    writeMeta(db, NOTE_REVISION_RETENTION_KEY, '27');

    const res = await agent.get('/settings/defaults').expect(200);
    const notes = settingsSection(res.text, 'defaults-notes');

    expect(inputMarkup(notes, 'noteRevisionRetention')).toContain('value="27"');
    expect(notes).toContain('Saved default: <strong>27</strong>');
  });

  it('uses native-backed live catalogue selects for New Projects Status and Project Type', async () => {
    const res = await agent.get('/settings/defaults').expect(200);
    const newProjects = settingsSection(res.text, 'defaults-new-projects');
    const statusSelect = newProjects.match(/<select id="new_projectStatus"[\s\S]*?<\/select>/)?.[0] || '';
    const typeSelect = newProjects.match(/<select id="new_projectProjectType"[\s\S]*?<\/select>/)?.[0] || '';

    expect(newProjects).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(newProjects).toContain('data-cc-dropdown-dispatch-native-change');
    expect(statusSelect).toMatch(
      /<select id="new_projectStatus" name="new_projectStatus" class="cc-dropdown-native-select" data-cc-dropdown-native-select[^>]*required[^>]*data-autosubmit="fetch">/,
    );
    expect(statusSelect).not.toContain('data-autosubmit="submit"');
    expect(statusSelect).not.toBe('');
    for (const [value, label] of NEW_PROJECT_STATUS_OPTIONS) {
      expect(statusSelect).toMatch(new RegExp(`<option value="${value}"(?: selected)?>${label}</option>`));
    }
    expect(statusSelect).toContain('<option value="tbd" selected>Tbd</option>');
    expect(newProjects).toMatch(/<input[^>]*type="radio" value="tbd"[^>]*checked/);
    expect(newProjects).not.toMatch(/<input[^>]*name="new_projectStatus"/);
    expect((newProjects.match(/name="new_projectStatus"/g) || [])).toHaveLength(1);
    expect(newProjects).not.toContain('aria-invalid');
    expect(newProjects).not.toContain('new_projectStatus-error');
    expect(typeSelect).toMatch(
      /<select id="new_projectProjectType" name="new_projectProjectType" class="cc-dropdown-native-select" data-cc-dropdown-native-select[^>]*required[^>]*data-autosubmit="fetch">/,
    );
    for (const [value, label] of NEW_PROJECT_TYPE_OPTIONS) {
      expect(typeSelect).toMatch(new RegExp(`<option value="${value}"(?: selected)?>${label}</option>`));
    }
    expect(typeSelect).toContain('<option value="images" selected>Images</option>');
    expect((newProjects.match(/name="new_projectProjectType"/g) || [])).toHaveLength(1);
    expect(newProjects).not.toContain('value="archived"');
  });

  it('renders and persists the live ordered Project Type default by stable value', async () => {
    const custom = app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Interactive Story',
      color: '#123456',
    });
    app.locals.projectOptionCatalogueService.reorderOptions('projectType', [
      custom.value, 'images', 'comic', 'animation', 'wallpaper',
    ]);

    await agent.post('/settings/defaults').type('form').send({
      new_projectStatus: 'tbd',
      new_projectProjectType: custom.value,
      _csrf: csrfToken,
    }).expect(302);

    const res = await agent.get('/settings/defaults').expect(200);
    const section = settingsSection(res.text, 'defaults-new-projects');
    const typeSelect = section.match(/<select id="new_projectProjectType"[\s\S]*?<\/select>/)?.[0] || '';
    expect(typeSelect).toContain(`<option value="${custom.value}" selected>Interactive Story</option>`);
    expect(typeSelect.indexOf(custom.value)).toBeLessThan(typeSelect.indexOf('value="images"'));
    expect(readMeta(db, defaultKey('new_project', 'projectType'))).toBe(custom.value);
  });

  it('renders the persisted migration defaults for new Project creation', async () => {
    const res = await agent.get('/settings/defaults').expect(200);

    expect(selectedValue(res.text, 'new_projectStatus')).toBe('tbd');
    expect(selectedValue(res.text, 'new_projectProjectType')).toBe('images');
    expect((res.text.match(/Application fallback:/g) || [])).toHaveLength(1);
    expect(res.text).toContain('Saved default: <strong>Tbd</strong>');
    expect(res.text).toContain('Saved default: <strong>Images</strong>');
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

  it('auto-saves rendered Defaults without changing persisted Releases defaults or moved namespaces', async () => {
    seedMovedDefaults(db);
    writeMeta(db, defaultKey('releases', 'sort'), 'updated');
    writeMeta(db, defaultKey('releases', 'order'), 'desc');
    writeMeta(db, 'page_defaults.release_management.sort', 'updated');
    writeMeta(db, 'page_defaults.release_management.order', 'desc');

    const save = await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, _csrf: csrfToken })
      .expect(302);

    expect(save.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
    expect(readMeta(db, defaultKey('new_project', 'projectType'))).toBe('comic');
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe('updated');
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe('desc');
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
    expect(readMeta(db, GLOBAL_ASSET_BROWSER_DEFAULT_KEY)).toBe('wip');
    expect(readMeta(db, 'page_defaults.release_management.sort')).toBe('updated');
    expect(readMeta(db, 'page_defaults.release_management.order')).toBe('desc');
  });

  it('persists Note revision retention without mutating Notes or revisions', async () => {
    const bookId = Number(db.prepare("INSERT INTO books (title, sort_order) VALUES ('Book', 0)").run().lastInsertRowid);
    const noteId = Number(db.prepare(`
      INSERT INTO notes (book_id, title, content, sort_order)
      VALUES (?, 'Current title', 'Current content', 0)
    `).run(bookId).lastInsertRowid);
    db.prepare(`
      INSERT INTO note_revisions (
        note_id, title, content, project_ids_json, asset_ids_json, source_updated_at
      ) VALUES (?, 'Old title', 'Old content', '[]', '[]', '2026-09-08 12:00:00')
    `).run(noteId);
    const notesBefore = db.prepare('SELECT * FROM notes ORDER BY id').all();
    const revisionsBefore = db.prepare('SELECT * FROM note_revisions ORDER BY id').all();

    await agent
      .post('/settings/defaults')
      .type('form')
      .send({ ...VALID_DEFAULTS, noteRevisionRetention: '5', _csrf: csrfToken })
      .expect(302);

    expect(readMeta(db, NOTE_REVISION_RETENTION_KEY)).toBe('5');
    expect(db.prepare('SELECT * FROM notes ORDER BY id').all()).toEqual(notesBefore);
    expect(db.prepare('SELECT * FROM note_revisions ORDER BY id').all()).toEqual(revisionsBefore);

    const res = await agent.get('/settings/defaults').expect(200);
    expect(inputMarkup(settingsSection(res.text, 'defaults-notes'), 'noteRevisionRetention')).toContain('value="5"');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['blank', ''],
    ['malformed', 'five'],
    ['object-like malformed', '[object Object]'],
    ['unsafe integer', '9007199254740992'],
    ['repeated values', ['5', '6']],
  ])('rejects %s Note revision retention atomically', async (_label, value) => {
    writeMeta(db, NOTE_REVISION_RETENTION_KEY, '7');
    writeMeta(db, defaultKey('new_project', 'status'), 'planned');

    const res = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        new_projectStatus: 'ready',
        noteRevisionRetention: value,
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('Revision retention must be a positive safe integer.');
    expect(inputMarkup(settingsSection(res.text, 'defaults-notes'), 'noteRevisionRetention')).toContain('aria-invalid="true"');
    expect(readMeta(db, NOTE_REVISION_RETENTION_KEY)).toBe('7');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('planned');
  });

  it('accepts and persists explicit legacy Releases defaults posts', async () => {
    await agent.get('/settings/defaults').expect(200);

    const save = await agent
      .post('/settings/defaults')
      .type('form')
      .send({
        new_projectStatus: 'ready',
        releasesSort: 'updated',
        releasesOrder: 'desc',
        _csrf: csrfToken,
      })
      .expect(302);

    expect(save.headers.location).toBe('/settings/defaults?notice=defaults_saved');
    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('ready');
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBe('updated');
    expect(readMeta(db, defaultKey('releases', 'order'))).toBe('desc');
    expect(readMeta(db, NOTE_REVISION_RETENTION_KEY)).toBeUndefined();
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
    expect(JSON.parse(rows[0].context_json)).toEqual({ changedPages: ['new_project'], changedOptionCount: 2 });
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
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBeUndefined();
    expect(readMeta(db, defaultKey('releases', 'order'))).toBeUndefined();
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
        _csrf: csrfToken,
      })
      .expect(422);

    expect(res.text).toContain('new_project.status');
    expect(res.text).not.toContain('releases.sort');
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
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBeUndefined();
    expect(readMeta(db, defaultKey('releases', 'order'))).toBeUndefined();
    expect(movedStorageSnapshot(db)).toEqual(MOVED_DEFAULTS);
  });

  it('requires CSRF for the remaining Defaults mutation', async () => {
    await agent
      .post('/settings/defaults')
      .type('form')
      .send(VALID_DEFAULTS)
      .expect(403);

    expect(readMeta(db, defaultKey('new_project', 'status'))).toBe('tbd');
    expect(readMeta(db, defaultKey('new_project', 'projectType'))).toBe('images');
    expect(readMeta(db, defaultKey('releases', 'sort'))).toBeUndefined();
    expect(readMeta(db, defaultKey('releases', 'order'))).toBeUndefined();
  });

  it('does not render obsolete Projects or New Releases defaults', async () => {
    writeMeta(db, defaultKey('projects', 'view'), 'list');
    writeMeta(db, 'page_defaults.new_release.status', 'cancelled');

    const res = await agent.get('/settings/defaults').expect(200);

    expect(res.text).toContain('defaults-new-projects');
    expect(res.text).not.toContain('defaults-releases');
    expect(res.text).not.toContain('defaults-projects');
    expect(res.text).not.toContain('projectsView');
    expect(res.text).not.toContain('new_releaseStatus');
    expect(res.text).not.toContain('New Releases');
    expect(readMeta(db, defaultKey('projects', 'view'))).toBe('list');
    expect(readMeta(db, 'page_defaults.new_release.status')).toBe('cancelled');
  });
});
