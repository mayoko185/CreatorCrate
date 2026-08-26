import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';
const WINDOWS_PROJECTS_PATH_KEY = 'open_locally.windows_projects_path';

function activeNavKeys(html, expectedCurrentSettingsChild) {
  activeSettingsNavLabels(html, expectedCurrentSettingsChild);
  const activeParents = [...html.matchAll(
    /<li class="(?:app-nav-item|mobile-nav-item)[^"]*--active[^"]*">[\s\S]*?<a href="[^"]+" class="(?:app-nav-link|mobile-nav-link)" data-nav-key="([^"]+)"/g,
  )];
  return [...new Set(activeParents.map((match) => match[1]))];
}

function activeSettingsNavLabels(html, expectedCurrentSettingsChild) {
  expect(html).not.toContain('<nav class="settings-nav"');
  expect(html).toContain('class="app-nav-item app-nav-item--active app-nav-item--has-children"');
  expect(html).toContain('class="mobile-nav-item mobile-nav-item--active mobile-nav-item--has-children"');
  expect(html).not.toMatch(/<a\b(?=[^>]*\bdata-nav-key="settings")(?=[^>]*\baria-current="page")[^>]*>/);

  const currentChildren = [...html.matchAll(
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="(settings-[^"]+)")(?=[^>]*\baria-current="page")[^>]*>([^<]+)<\/a>/g,
  )];
  expect(currentChildren).toHaveLength(2);
  expect(new Set(currentChildren.map((match) => match[1]))).toEqual(new Set([expectedCurrentSettingsChild]));
  return [...new Set(currentChildren.map((match) => match[2]))];
}

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

describe('settings — open locally HTTP', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-open-locally-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db, projectsRoot }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders the page with the server projects root, unconfigured state, and active navigation', async () => {
    const res = await agent.get('/settings/open-locally').expect(200);

    expect(res.text).toContain('<h1 class="app-section-title">Settings — Open locally</h1>');
    expect(res.text).toContain('<h3>Open locally helper</h3>');
    expect(res.text).toContain('Windows only: the Open locally buttons rely on the Open locally helper app.');
    expect(res.text).toContain('<h3>Projects path</h3>');
    expect(res.text).toContain('CreatorCrate cannot open files on your Windows machine directly.');
    expect(activeNavKeys(res.text, 'settings-open-locally')).toEqual(['settings']);
    expect(activeSettingsNavLabels(res.text, 'settings-open-locally')).toEqual(['Open locally']);
    expect(res.text).toContain(`<code>${projectsRoot.replaceAll('\\', '&#92;')}</code>`);
    expect(res.text).toContain('Not configured');
    expect(res.text).toContain('name="windowsProjectsPath"');
    expect(res.text).toContain('placeholder="D:\\example"');
    expect(res.text).toContain('>Save</button>');
    expect(res.text).toContain('Download installer');
    expect(res.text).toContain('href="/downloads/creatorcrate-open-locally-setup.exe"');
    expect(res.text).not.toContain('>Cancel</a>');
    expect(res.text).not.toContain('Clear mapping');
  });

  it('always renders the download installer action regardless of the artifact state', async () => {
    const res = await agent.get('/settings/open-locally').expect(200);

    expect(res.text).toContain('Download installer');
    expect(res.text).toContain('href="/downloads/creatorcrate-open-locally-setup.exe"');
    expect(res.text).not.toContain('The Open locally installer is not currently available.');
    expect(res.text).not.toContain('installer is not currently available');
  });

  it('renders the mapping section with the standard Settings card layout', async () => {
    const res = await agent.get('/settings/open-locally').expect(200);

    // Uses the standard Settings idioms (same as the Tags page): plain
    // .settings-section cards with .project-form / .form-actions, and the
    // primary action button flush in the card. No bespoke body wrapper.
    expect(res.text).toContain('class="settings-section"');
    expect(res.text).not.toContain('open-locally-section-body');
    expect(res.text).not.toContain('open-locally-body');
    expect(res.text).toContain('class="form-actions"');
    expect(res.text).toContain('class="button button-primary" download>Download installer</a>');
    expect(res.text).toContain('class="button button-primary">Save</button>');
  });

  it('shows the saved Windows path as the configured state and pre-fills the input', async () => {
    writeMeta(db, WINDOWS_PROJECTS_PATH_KEY, 'D:\\example');

    const res = await agent.get('/settings/open-locally').expect(200);

    expect(res.text).toContain('<code>D:&#92;example</code>');
    expect(res.text).not.toContain('Not configured');
    expect(res.text).toContain('value="D:&#92;example"');
    expect(res.text).toContain('>Clear mapping</button>');
  });

  it('saves a valid Windows path, redirects, and shows the saved notice', async () => {
    const save = await agent
      .post('/settings/open-locally')
      .type('form')
      .send({ windowsProjectsPath: 'D:\\example\\', _csrf: csrfToken })
      .expect(302);

    expect(save.headers.location).toBe('/settings/open-locally?notice=open_locally_saved');
    expect(readMeta(db, WINDOWS_PROJECTS_PATH_KEY)).toBe('D:\\example');

    const redirected = await agent.get(save.headers.location).expect(200);
    expect(redirected.text).toContain('Open locally mapping saved.');
    expect(redirected.text).toContain('<code>D:&#92;example</code>');
  });

  it('records path-setting changes without persisting the Windows path', async () => {
    await agent.post('/settings/open-locally').type('form')
      .send({ windowsProjectsPath: 'D:\\example\\', _csrf: csrfToken })
      .expect(302);
    await agent.post('/settings/open-locally').type('form')
      .send({ windowsProjectsPath: 'D:\\example', _csrf: csrfToken })
      .expect(302);
    await agent.post('/settings/open-locally/clear').type('form').send({ _csrf: csrfToken }).expect(302);

    const rows = db.prepare("SELECT event, level, kind, context_json FROM application_logs WHERE event LIKE 'settings.open_locally.%' ORDER BY id").all();
    expect(rows.map(({ event, level, kind, context_json: contextJson }) => ({
      event, level, kind, context: JSON.parse(contextJson),
    }))).toEqual([
      { event: 'settings.open_locally.updated', level: 'info', kind: 'activity', context: { configured: true } },
      { event: 'settings.open_locally.cleared', level: 'info', kind: 'activity', context: { configured: false } },
    ]);
    expect(JSON.stringify(rows)).not.toContain('D:\\example');
  });

  it('records a committed mapping change when the legacy mapping snapshot is unavailable', async () => {
    app.locals.openLocallySettingsService.getWindowsProjectsPath = () => {
      throw new Error('legacy snapshot unavailable');
    };

    await agent.post('/settings/open-locally').type('form')
      .send({ windowsProjectsPath: 'D:\\example', _csrf: csrfToken }).expect(302);

    const rows = db.prepare("SELECT event FROM application_logs WHERE event = 'settings.open_locally.updated'").all();
    expect(rows).toEqual([{ event: 'settings.open_locally.updated' }]);
  });

  it('rejects an invalid path with 422, retains the submitted value, and does not save', async () => {
    const before = readMeta(db, WINDOWS_PROJECTS_PATH_KEY);

    const res = await agent
      .post('/settings/open-locally')
      .type('form')
      .send({ windowsProjectsPath: 'relative/path', _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('Could not save the Windows projects path.');
    expect(res.text).toContain('Windows projects path must be an absolute Windows drive path.');
    expect(res.text).toContain('value="relative/path"');
    expect(res.text).toContain('aria-invalid="true"');
    expect(activeSettingsNavLabels(res.text, 'settings-open-locally')).toEqual(['Open locally']);
    expect(readMeta(db, WINDOWS_PROJECTS_PATH_KEY)).toBe(before);
  });

  it('rejects the bare drive root with 422 and does not save it', async () => {
    const before = readMeta(db, WINDOWS_PROJECTS_PATH_KEY);

    const res = await agent
      .post('/settings/open-locally')
      .type('form')
      .send({ windowsProjectsPath: 'C:\\', _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('Windows projects path must not be the drive root.');
    expect(res.text).toContain('value="C:&#92;"');
    expect(readMeta(db, WINDOWS_PROJECTS_PATH_KEY)).toBe(before);
  });

  it('clears the mapping through the clear route, redirects, and shows the cleared notice', async () => {
    writeMeta(db, WINDOWS_PROJECTS_PATH_KEY, 'D:\\example');

    const clear = await agent
      .post('/settings/open-locally/clear')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(clear.headers.location).toBe('/settings/open-locally?notice=open_locally_cleared');
    expect(readMeta(db, WINDOWS_PROJECTS_PATH_KEY)).toBe('');

    const redirected = await agent.get(clear.headers.location).expect(200);
    expect(redirected.text).toContain('Open locally mapping removed.');
    expect(redirected.text).toContain('Not configured');
    expect(redirected.text).not.toContain('Clear mapping');
  });


  it('does not materialize or log an absent mapping when clearing', async () => {
    await agent.post('/settings/open-locally/clear').type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(readMeta(db, 'open_locally.windows_projects_path')).toBeUndefined();
    expect(db.prepare('SELECT event FROM application_logs WHERE event = ?').all('settings.open_locally.cleared')).toEqual([]);
  });


  it('persists a real clear and does not re-log a repeated clear', async () => {
    writeMeta(db, 'open_locally.windows_projects_path', 'D:\\example');

    await agent.post('/settings/open-locally/clear').type('form')
      .send({ _csrf: csrfToken })
      .expect(302);
    await agent.post('/settings/open-locally/clear').type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(readMeta(db, 'open_locally.windows_projects_path')).toBe('');
    expect(db.prepare('SELECT event FROM application_logs WHERE event = ?').all('settings.open_locally.cleared'))
      .toEqual([{ event: 'settings.open_locally.cleared' }]);
  });

  it('keeps existing Settings routes unaffected and lists the Open locally link in the sub-navigation', async () => {
    const overview = await agent.get('/settings').expect(200);
    expect(overview.text).toContain('href="/settings/open-locally"');

    const tags = await agent.get('/settings/tags').expect(200);
    expect(activeSettingsNavLabels(tags.text, 'settings-tags')).toEqual(['Tags']);
  });
});
