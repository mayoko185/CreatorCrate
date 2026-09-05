import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  SOCIAL_PREP_ENABLED_KEY,
  SOCIAL_PREP_PLATFORMS_KEY,
} from '../src/services/social-prep-settings-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function settingsNavLabels(html) {
  return [...new Set([...html.matchAll(
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="settings-[^"]+")[^>]*>(?:(?!<\/a>)[\s\S])*?<span class="app-nav-child-label">([^<]+)<\/span>\s*<\/a>/g,
  )].map((match) => match[1]))];
}

function control(html, id) {
  return html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`))?.[0] || '';
}

function readMeta(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(key);
}

describe('settings — Social Preparation HTTP', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-social-prep-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders disabled by default with an explicit opt-in and the Settings child', async () => {
    const res = await agent.get('/settings/social-prep').expect(200);

    expect(res.text).toContain('<h1 class="app-section-title">Settings — Social Preparation</h1>');
    expect(settingsNavLabels(res.text)).toEqual([
      'Overview', 'Security', 'Backups', 'Logs', 'Defaults', 'NSFW Filter',
      'Social Preparation', 'Asset Categories', 'Tags', 'Open locally',
    ]);
    expect(res.text).toContain('Social Preparation is disabled unless you explicitly opt in.');
    expect(res.text).toContain('This setting does not prepare, publish, or send anything.');
    expect(control(res.text, 'social-prep-enabled')).not.toContain('checked');
    for (const platform of ['patreon', 'x', 'bluesky']) {
      expect(control(res.text, `social-prep-platform-${platform}`)).not.toContain('checked');
    }
    expect(res.text).toContain('data-autosubmit="fetch"');
    expect(res.text).toContain('<form method="post" action="/settings/social-prep" class="project-form" novalidate>');
  });

  it('loads persisted enabled and platform selections', async () => {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?), (?, ?)')
      .run(SOCIAL_PREP_ENABLED_KEY, '1', SOCIAL_PREP_PLATFORMS_KEY, 'patreon,x,bluesky');

    const res = await agent.get('/settings/social-prep').expect(200);

    expect(control(res.text, 'social-prep-enabled')).toContain('checked');
    for (const platform of ['patreon', 'x', 'bluesky']) {
      expect(control(res.text, `social-prep-platform-${platform}`)).toContain('checked');
    }
  });

  it('saves through the settings service using canonical platform order', async () => {
    const res = await agent
      .post('/settings/social-prep')
      .type('form')
      .send({ enabled: ['0', '1'], platforms: ['bluesky', 'patreon'], _csrf: csrfToken })
      .expect(302);

    expect(res.headers.location).toBe('/settings/social-prep?notice=social_prep_saved');
    expect(readMeta(db, SOCIAL_PREP_ENABLED_KEY)).toBe('1');
    expect(readMeta(db, SOCIAL_PREP_PLATFORMS_KEY)).toBe('patreon,bluesky');
  });

  it('persists disabled and an empty platform selection', async () => {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?), (?, ?)')
      .run(SOCIAL_PREP_ENABLED_KEY, '1', SOCIAL_PREP_PLATFORMS_KEY, 'patreon,x');

    await agent
      .post('/settings/social-prep')
      .type('form')
      .send({ enabled: '0', _csrf: csrfToken })
      .expect(302);

    expect(readMeta(db, SOCIAL_PREP_ENABLED_KEY)).toBe('0');
    expect(readMeta(db, SOCIAL_PREP_PLATFORMS_KEY)).toBe('');
  });

  it('does not expose malformed persisted platform state', async () => {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
      .run(SOCIAL_PREP_PLATFORMS_KEY, 'x,patreon');

    const res = await agent.get('/settings/social-prep').expect(200);

    for (const platform of ['patreon', 'x', 'bluesky']) {
      expect(control(res.text, `social-prep-platform-${platform}`)).not.toContain('checked');
    }
  });

  it('renders service validation errors without mutating the enabled state', async () => {
    const res = await agent
      .post('/settings/social-prep')
      .type('form')
      .send({ enabled: ['0', '1'], platforms: 'mastodon', _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('Unsupported Social Preparation platform: mastodon.');
    expect(readMeta(db, SOCIAL_PREP_ENABLED_KEY)).toBeUndefined();
    expect(readMeta(db, SOCIAL_PREP_PLATFORMS_KEY)).toBeUndefined();
  });

  it('requires CSRF for mutations', async () => {
    await agent
      .post('/settings/social-prep')
      .type('form')
      .send({ enabled: '1', platforms: 'patreon' })
      .expect(403);
  });
});
