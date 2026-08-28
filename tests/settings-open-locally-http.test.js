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
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="(settings-[^"]+)")(?=[^>]*\baria-current="page")[^>]*>(?:(?!<\/a>)[\s\S])*?<span class="app-nav-child-label">([^<]+)<\/span>\s*<\/a>/g,
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

    expect(res.text).toContain('<div class="form-actions open-locally-installer-actions">');
    expect(res.text).toContain('<a href="/downloads/creatorcrate-open-locally-setup.exe" class="button button-primary" download>Download installer</a>');
    expect(res.text).not.toContain('The Open locally installer is not currently available.');
    expect(res.text).not.toContain('installer is not currently available');
  });

  it('renders the mapping section with the standard Settings card layout', async () => {
    const res = await agent.get('/settings/open-locally').expect(200);

    expect(res.text).toContain('class="settings-content settings-open-locally-content"');
    expect(res.text).toContain('class="settings-section settings-open-locally-installer-section"');
    expect(res.text).toContain('class="settings-section settings-open-locally-mapping-section"');
    expect(res.text).toContain('class="settings-open-locally-section-body settings-open-locally-installer-body"');
    expect(res.text).toContain('class="settings-open-locally-section-body settings-open-locally-mapping-body"');
    expect(res.text).toContain('class="form-actions open-locally-installer-actions"');
    expect(res.text).toMatch(/id="open-locally-save-form"[\s\S]*?name="_csrf"[\s\S]*?<input[^>]*form="open-locally-save-form"[^>]*>\s*<button id="open-locally-save" type="submit" form="open-locally-save-form" class="button button-primary">Save<\/button>/);
    expect([...res.text.matchAll(/id="open-locally-save"/g)]).toHaveLength(1);
  });

  it('keeps the C7G progressive-enhancement contract on the detached native Save form', async () => {
    writeMeta(db, WINDOWS_PROJECTS_PATH_KEY, 'D:\\example');

    const res = await agent.get('/settings/open-locally').expect(200);

    expect(res.text).toMatch(/<div class="settings-section settings-open-locally-mapping-section" data-settings-open-locally-mapping-region>/);
    expect(res.text).toMatch(/<form id="open-locally-save-form" method="post" action="\/settings\/open-locally" class="inline-form" novalidate>[\s\S]*?name="_csrf"[\s\S]*?data-settings-fetch-save-status[\s\S]*?<\/form>/);
    expect(res.text).toMatch(/<span class="help-text" data-settings-fetch-save-status role="status" aria-live="polite" aria-atomic="true"><\/span>/);
    expect(res.text).toMatch(/<input[^>]*id="windows-projects-path"[^>]*form="open-locally-save-form"[^>]*data-autosubmit="fetch"[^>]*data-settings-open-locally-path[^>]*>/);
    expect(res.text).toMatch(/<div class="open-locally-path-row">\s*<input[^>]*>\s*<button id="open-locally-save" type="submit" form="open-locally-save-form" class="button button-primary">Save<\/button>\s*<form method="post" action="\/settings\/open-locally\/clear"/);
  });

  it('shows the saved Windows path as the configured state and pre-fills the input', async () => {
    writeMeta(db, WINDOWS_PROJECTS_PATH_KEY, 'D:\\example');

    const res = await agent.get('/settings/open-locally').expect(200);

    expect(res.text).toContain('<code>D:&#92;example</code>');
    expect(res.text).not.toContain('Not configured');
    expect(res.text).toContain('value="D:&#92;example"');
    expect(res.text).toContain('>Clear mapping</button>');
    expect(res.text).toMatch(/<div class="open-locally-path-row">\s*<input[^>]*form="open-locally-save-form"[^>]*>\s*<button id="open-locally-save" type="submit" form="open-locally-save-form" class="button button-primary">Save<\/button>\s*<form method="post" action="\/settings\/open-locally\/clear" class="inline-form" novalidate>/);
    expect(res.text).toMatch(/<form id="open-locally-save-form" method="post" action="\/settings\/open-locally" class="inline-form" novalidate>[\s\S]*?<\/form>[\s\S]*?<div class="open-locally-path-row">[\s\S]*?<form method="post" action="\/settings\/open-locally\/clear" class="inline-form" novalidate>/);
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
    expect(redirected.text.indexOf('class="notice')).toBeLessThan(
      redirected.text.indexOf('class="settings-content settings-open-locally-content"'),
    );
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
