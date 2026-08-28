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
import { authenticate, AUTH_CONFIG, extractCsrfToken } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function settingsNavLabels(html) {
  expect(html).not.toContain('<nav class="settings-nav"');
  expect(html).toContain('class="app-nav-item app-nav-item--active app-nav-item--has-children"');
  expect(html).toContain('class="mobile-nav-item mobile-nav-item--active mobile-nav-item--has-children"');
  expect(html).not.toMatch(/<a\b(?=[^>]*\bdata-nav-key="settings")(?=[^>]*\baria-current="page")[^>]*>/);

  const currentChildren = [...html.matchAll(
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="settings-([^"]+)")(?=[^>]*\baria-current="page")[^>]*>([^<]+)<\/a>/g,
  )];
  expect(currentChildren).toHaveLength(2);
  expect(new Set(currentChildren.map((match) => match[1]))).toEqual(new Set(['nsfw-filter']));

  return [...new Set([...html.matchAll(
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="settings-[^"]+")[^>]*>([^<]+)<\/a>/g,
  )].map((match) => match[1]))];
}

function nsfwControl(html) {
  return html.match(/<input[^>]+id="nsfw-filter-enabled"[^>]*>/)?.[0] || '';
}

function nsfwFilterForm(html) {
  return html.match(/<form method="post" action="\/settings\/nsfw-filter" class="project-form" novalidate>[\s\S]*?<\/form>/)?.[0] || '';
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
      .send({ enabled: enabled ? ['0', '1'] : '0', _csrf: csrfToken })
      .expect(302);
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
      'Logs',
      'Defaults',
      'NSFW Filter',
      'Asset Categories',
      'Tags',
      'Open locally',
    ]);

    const form = nsfwFilterForm(res.text);
    expect(form).toContain('<h3>NSFW Filter</h3>');
    expect(form).toContain('Enabling the filter will add the <strong>NSFW</strong> tag as an available option if it does not already exist.');
    expect(form).toContain('<div class="settings-section">');
    expect(form).toContain('<div class="field field--switch">');
    expect(nsfwControl(form)).toContain('data-autosubmit="fetch"');
    expect(nsfwControl(form)).not.toContain('data-autosubmit="submit"');
    expect(form).toContain('name="_csrf"');
    expect((form.match(/data-settings-fetch-save-status/g) || []).length).toBe(1);
    expect(form).not.toContain('data-category-enabled-status');
    expect(form).toContain('<input type="hidden" name="enabled" value="0" tabindex="-1">');
    expect(nsfwControl(form)).toContain('name="enabled"');
    expect(nsfwControl(form)).toContain('value="1"');
    expect(form).not.toContain('<div class="form-actions">');
    expect(form.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')).not.toContain('>Save</button>');
    expect(form).not.toContain('>Cancel</a>');
    expect(form).toContain('<noscript><button type="submit" class="button button-small button-secondary">Save</button></noscript>');

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

  it('records only effective NSFW filter changes while retaining the existing tag event ownership', async () => {
    await setFilter(true);
    await setFilter(true);
    await setFilter(false);

    const rows = db.prepare("SELECT event, level, kind, context_json FROM application_logs WHERE event = 'settings.nsfw_filter.updated' ORDER BY id").all();
    expect(rows.map(({ event, level, kind, context_json: contextJson }) => ({
      event, level, kind, context: JSON.parse(contextJson),
    }))).toEqual([
      { event: 'settings.nsfw_filter.updated', level: 'info', kind: 'activity', context: { enabled: true } },
      { event: 'settings.nsfw_filter.updated', level: 'info', kind: 'activity', context: { enabled: false } },
    ]);
  });

  it('records a committed change when the legacy enabled-state snapshot is unavailable', async () => {
    app.locals.nsfwFilterSettingsService.isEnabled = () => {
      throw new Error('legacy snapshot unavailable');
    };

    await setFilter(true);

    const rows = db.prepare("SELECT event FROM application_logs WHERE event = 'settings.nsfw_filter.updated'").all();
    expect(rows).toEqual([{ event: 'settings.nsfw_filter.updated' }]);
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

  it('renders the existing validation error for malformed toggle values', async () => {
    const res = await agent
      .post('/settings/nsfw-filter')
      .type('form')
      .send({ enabled: ['0', '1', '1'], _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('Enabled value must be 0, 1, on, off, true, or false.');
    expect(nsfwControl(res.text)).not.toContain('checked');
    expect(readMeta(db)).toBeUndefined();
  });

  describe('CSRF regression', () => {
    it('renders a CSRF token in the form', async () => {
      const res = await agent.get('/settings/nsfw-filter').expect(200);
      const formMatch = res.text.match(/<form method="post" action="\/settings\/nsfw-filter"[\s\S]*?<\/form>/);
      expect(formMatch).not.toBeNull();
      const csrfInForm = (formMatch[0].match(/name="_csrf"/g) || []).length;
      expect(csrfInForm).toBe(1);
    });

    it('enables the filter using the token rendered in the page', async () => {
      const page = await agent.get('/settings/nsfw-filter').expect(200);
      const renderedToken = extractCsrfToken(page.text);

      await agent
        .post('/settings/nsfw-filter')
        .type('form')
        .send({ enabled: '1', _csrf: renderedToken })
        .expect(302);

      expect(readMeta(db)).toBe('1');
    });

    it('disables the filter using the token rendered in the page', async () => {
      await setFilter(true);
      expect(readMeta(db)).toBe('1');

      const page = await agent.get('/settings/nsfw-filter').expect(200);
      const renderedToken = extractCsrfToken(page.text);

      await agent
        .post('/settings/nsfw-filter')
        .type('form')
        .send({ enabled: '0', _csrf: renderedToken })
        .expect(302);

      expect(readMeta(db)).toBe('0');
    });

    it('rejects a POST without a CSRF token', async () => {
      await agent
        .post('/settings/nsfw-filter')
        .type('form')
        .send({ enabled: '1' })
        .expect(403);

      expect(readMeta(db)).toBeUndefined();
    });
  });
});
