import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  NSFW_FILTER_ENABLED_KEY,
  NSFW_TAG_NAME,
} from '../src/services/nsfw-filter-settings-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function settingsNavLabels(html) {
  const settingsNav = html.match(/<nav class="settings-nav"[\s\S]*?<\/nav>/)?.[0] || '';
  return [...settingsNav.matchAll(/<a href="[^"]+"(?: aria-current="page")?>([^<]+)<\/a>/g)]
    .map((match) => match[1]);
}

function nsfwControl(html) {
  return html.match(/<input[^>]+id="nsfw-filter-enabled"[^>]*>/)?.[0] || '';
}

function readMeta(db) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(NSFW_FILTER_ENABLED_KEY);
}

function listNsfwTags(db) {
  return db.prepare('SELECT id, display_name, normalized_name FROM tags WHERE lower(trim(display_name)) = ? OR lower(trim(normalized_name)) = ? ORDER BY id')
    .all(NSFW_TAG_NAME.toLowerCase(), NSFW_TAG_NAME.toLowerCase());
}

describe('settings — NSFW Filter HTTP', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-nsfw-filter-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setFilter(enabled) {
    return agent
      .post('/settings/nsfw-filter')
      .type('form')
      .send({ enabled: enabled ? '1' : '0', _csrf: csrfToken })
      .expect(302);
  }

  function securityPageStructure(html) {
    const settingsContent = html.match(/<div class="settings-content">([\s\S]*?)<\/div>\s*\r?\n\s*<\/main>/)?.[1] || '';
    const match = settingsContent.match(/<form method="post" action="\/settings\/nsfw-filter" class="project-form" novalidate>\s*<div class="settings-section">\s*<h3>([^<]+)<\/h3>\s*<p class="help-text" id="([^"]+)">([\s\S]*?)<\/p>\s*<div class="field field--switch[^"]*">[\s\S]*?<\/div>\s*<div class="form-actions">[\s\S]*?<\/div>\s*<\/div>\s*<\/form>/);
    if (!match) return null;
    return { heading: match[1], helpId: match[2], helpText: match[3], full: match[0] };
  }

  function settingsSectionCss(css) {
    const buttonRule = css.match(/\.button\s*\{[^}]*\}/s)?.[0] || '';
    const primaryRule = css.match(/\.button-primary\s*\{[^}]*\}/s)?.[0] || '';
    const secondaryRule = css.match(/\.button-secondary\s*\{[^}]*\}/s)?.[0] || '';
    return { buttonRule, primaryRule, secondaryRule };
  }


  it('renders the page disabled by default, includes the note, and places navigation correctly', async () => {
    const res = await agent.get('/settings/nsfw-filter').expect(200);

    expect(res.text).toContain('<h1 class="app-section-title">Settings — NSFW Filter</h1>');
    expect(settingsNavLabels(res.text)).toEqual([
      'Overview',
      'Security',
      'Backups',
      'Defaults',
      'NSFW Filter',
      'Asset Categories',
      'Tags',
      'Open locally',
    ]);

    const structure = securityPageStructure(res.text);
    expect(structure).not.toBeNull();
    expect(structure.heading).toBe('NSFW Filter');
    expect(structure.helpText).toContain('Enabling the filter will add the <strong>NSFW</strong> tag as an available option if it does not already exist.');
    expect(structure.full).toContain('<form method="post" action="/settings/nsfw-filter" class="project-form" novalidate>');
    expect(structure.full).toContain('<div class="settings-section">');
    expect(structure.full).toContain('<div class="field field--switch">');
    expect(structure.full).toContain('<div class="form-actions">');
    expect(structure.full).toContain('class="button button-primary">Save</button>');
    expect(structure.full).toContain('class="button button-secondary">Cancel</a>');

    const css = (await agent.get('/creatorcrate.css').expect(200)).text;
    const padding = settingsSectionCss(css);
    expect(padding.buttonRule).toContain('padding:');
    expect(padding.primaryRule).toBeTruthy();
    expect(padding.secondaryRule).toBeTruthy();
    expect(padding.buttonRule).toContain('padding: 0.4rem 0.8rem;');
    expect(css.match(/\.button-primary\s*\{[^}]*\}/s)?.[0]).not.toMatch(/padding\s*:/);
    expect(css.match(/\.button-secondary\s*\{[^}]*\}/s)?.[0]).not.toMatch(/padding\s*:/);
    expect(css.match(/\.settings-section\s+\.form-actions\s*\{[^}]*\}/s)?.[0]).toContain('margin-bottom');
    expect(css.match(/\.settings-section\s+\.form-actions\s*\{[^}]*\}/s)?.[0]).toContain('margin-left');

    expect(nsfwControl(res.text)).not.toContain('checked');
    expect(res.text).toContain('>Disabled</span>');
    expect(res.text).toContain('<form method="post" action="/settings/nsfw-filter" class="project-form" novalidate>');
  });

  it('renders the stored enabled state', async () => {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(NSFW_FILTER_ENABLED_KEY, '1');

    const res = await agent.get('/settings/nsfw-filter').expect(200);

    expect(nsfwControl(res.text)).toContain('checked');
    expect(res.text).toContain('>Enabled</span>');
  });

  it('enables and persists the filter while creating NSFW when absent', async () => {
    const res = await setFilter(true);

    expect(res.headers.location).toBe('/settings/nsfw-filter?notice=nsfw_filter_enabled');
    expect(readMeta(db)).toBe('1');
    expect(listNsfwTags(db)).toEqual([
      expect.objectContaining({ display_name: 'NSFW', normalized_name: 'nsfw' }),
    ]);
  });

  it('is idempotent when enabling with an existing NSFW tag', async () => {
    const existing = app.locals.tagService.createTag({ name: NSFW_TAG_NAME });

    await setFilter(true);
    await setFilter(true);

    expect(readMeta(db)).toBe('1');
    expect(listNsfwTags(db)).toEqual([expect.objectContaining({
      id: existing.id,
      display_name: existing.display_name,
      normalized_name: existing.normalized_name,
    })]);
  });

  it('does not duplicate an equivalent differently-cased tag when enabling', async () => {
    const existing = app.locals.tagService.createTag({ name: 'nSfW' });

    await setFilter(true);

    expect(listNsfwTags(db)).toEqual([expect.objectContaining({
      id: existing.id,
      display_name: existing.display_name,
      normalized_name: existing.normalized_name,
    })]);
    expect(readMeta(db)).toBe('1');
  });

  it('persists disabling without deleting the NSFW tag', async () => {
    const existing = app.locals.tagService.createTag({ name: NSFW_TAG_NAME });
    await setFilter(true);

    const res = await setFilter(false);

    expect(res.headers.location).toBe('/settings/nsfw-filter?notice=nsfw_filter_disabled');
    expect(readMeta(db)).toBe('0');
    expect(listNsfwTags(db)).toEqual([expect.objectContaining({
      id: existing.id,
      display_name: existing.display_name,
      normalized_name: existing.normalized_name,
    })]);
  });

  it('requires CSRF for the setting mutation', async () => {
    await agent
      .post('/settings/nsfw-filter')
      .type('form')
      .send({ enabled: '1' })
      .expect(403);
    expect(readMeta(db)).toBeUndefined();
    expect(listNsfwTags(db)).toEqual([]);
  });
});
