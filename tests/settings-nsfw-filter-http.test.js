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
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="settings-([^"]+)")(?=[^>]*\baria-current="page")[^>]*>(?:(?!<\/a>)[\s\S])*?<span class="app-nav-child-label">([^<]+)<\/span>\s*<\/a>/g,
  )];
  expect(currentChildren).toHaveLength(2);
  expect(new Set(currentChildren.map((match) => match[1]))).toEqual(new Set(['defaults']));

  return [...new Set([...html.matchAll(
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="settings-[^"]+")[^>]*>(?:(?!<\/a>)[\s\S])*?<span class="app-nav-child-label">([^<]+)<\/span>\s*<\/a>/g,
  )].map((match) => match[1]))];
}

function nsfwControl(html) {
  return html.match(/<input[^>]+id="nsfw-filter-enabled"[^>]*>/)?.[0] || '';
}

function nsfwFilterForm(html) {
  return html.match(/<form method="post" action="\/settings\/nsfw-filter" class="project-form" novalidate>[\s\S]*?<\/form>/)?.[0] || '';
}

// Returns the outerHTML of the <div> opening at `start`, following nesting.
function divAt(html, start) {
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(html))) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  return '';
}

function regionOf(html, attribute) {
  const start = html.search(new RegExp(`<div\\b[^>]*\\b${attribute}[\\s>]`));
  return start === -1 ? '' : divAt(html, start);
}

function nsfwRegion(html) {
  return regionOf(html, 'data-settings-nsfw-filter-region');
}

function defaultsRegion(html) {
  return regionOf(html, 'data-settings-defaults-region');
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

  async function defaultsPage(query = '') {
    return agent.get(`/settings/defaults${query}`).expect(200);
  }

  function settingsSectionCss(css) {
    const buttonRule = css.match(/\.button\s*\{[^}]*\}/s)?.[0] || '';
    const primaryRule = css.match(/\.button-primary\s*\{[^}]*\}/s)?.[0] || '';
    const secondaryRule = css.match(/\.button-secondary\s*\{[^}]*\}/s)?.[0] || '';
    return { buttonRule, primaryRule, secondaryRule };
  }


  it('renders the section on Defaults disabled by default, includes the note, and places navigation correctly', async () => {
    const res = await defaultsPage();

    expect(res.text).toContain('<h1 class="app-section-title">Settings — Defaults</h1>');
    expect((res.text.match(/<h1\b/g) || []).length).toBe(1);
    expect(settingsNavLabels(res.text)).toEqual([
      'Overview',
      'Security',
      'Backups',
      'Logs',
      'Defaults',
      'Social Preparation',
      'Release Notifications',
      'Asset Categories',
      'Tags',
      'Open locally',
    ]);

    const form = nsfwFilterForm(res.text);
    expect(form).toContain('<h3 id="defaults-nsfw-filter-heading">NSFW Filter</h3>');
    expect(form).toContain('Enabling the filter will add the <strong>NSFW</strong> tag as an available option if it does not already exist.');
    expect(form).toContain('<section id="defaults-nsfw-filter" class="settings-section" aria-labelledby="defaults-nsfw-filter-heading">');
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

  it('places the NSFW region last, outside the Defaults region and form, without nesting forms', async () => {
    const res = await defaultsPage();
    const defaults = defaultsRegion(res.text);
    const nsfw = nsfwRegion(res.text);

    expect(defaults).toContain('id="settings-defaults-form"');
    expect(defaults).not.toContain('data-settings-nsfw-filter-region');
    expect(defaults).not.toContain('action="/settings/nsfw-filter"');
    expect(defaults).not.toContain('id="nsfw-filter-enabled"');
    expect(nsfw).toMatch(/^<div class="settings-content settings-nsfw-filter-content" data-settings-nsfw-filter-region>/);
    expect(nsfw).not.toContain('data-settings-defaults-region');
    expect(nsfw).not.toContain('id="settings-defaults-form"');
    expect((nsfw.match(/<form\b/g) || []).length).toBe(1);

    // The section follows the Project Type catalogue, after the Defaults region closes.
    expect(res.text.indexOf('id="defaults-project-type"')).toBeGreaterThan(-1);
    expect(res.text.indexOf('id="defaults-project-type"')).toBeLessThan(res.text.indexOf('id="defaults-nsfw-filter"'));
    expect(res.text.indexOf(defaults) + defaults.length).toBeLessThanOrEqual(res.text.indexOf(nsfw));
    expect((res.text.match(/id="defaults-nsfw-filter"/g) || []).length).toBe(1);
    expect((res.text.match(/id="nsfw-filter-enabled"/g) || []).length).toBe(1);

    let depth = 0;
    for (const [tag] of res.text.matchAll(/<\/?form\b[^>]*>/g)) {
      depth += tag.startsWith('</') ? -1 : 1;
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
  });

  it('redirects the legacy page to the Defaults section, keeping only NSFW notices', async () => {
    const plain = await agent.get('/settings/nsfw-filter').expect(302);
    expect(plain.headers.location).toBe('/settings/defaults#defaults-nsfw-filter');

    const enabled = await agent.get('/settings/nsfw-filter?notice=nsfw_filter_enabled').expect(302);
    expect(enabled.headers.location).toBe('/settings/defaults?notice=nsfw_filter_enabled#defaults-nsfw-filter');

    const disabled = await agent.get('/settings/nsfw-filter?notice=nsfw_filter_disabled').expect(302);
    expect(disabled.headers.location).toBe('/settings/defaults?notice=nsfw_filter_disabled#defaults-nsfw-filter');

    for (const query of ['?notice=defaults_saved', '?notice=https://example.com', '?next=//example.com', '?notice[]=nsfw_filter_enabled']) {
      const res = await agent.get(`/settings/nsfw-filter${query}`).expect(302);
      expect(res.headers.location).toBe('/settings/defaults#defaults-nsfw-filter');
    }

    const page = await defaultsPage('?notice=nsfw_filter_enabled');
    expect(page.text).toContain('NSFW Filter enabled.');
  });

  it('renders the stored enabled state', async () => {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(NSFW_FILTER_ENABLED_KEY, '1');

    const res = await defaultsPage();

    expect(nsfwControl(res.text)).toContain('checked');
    expect(res.text).toContain('>Enabled</span>');
  });

  it('enables and persists the filter while creating NSFW when absent', async () => {
    const res = await setFilter(true);

    expect(res.headers.location).toBe('/settings/defaults?notice=nsfw_filter_enabled#defaults-nsfw-filter');
    expect(nsfwControl((await defaultsPage('?notice=nsfw_filter_enabled')).text)).toContain('checked');
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

    expect(res.headers.location).toBe('/settings/defaults?notice=nsfw_filter_disabled#defaults-nsfw-filter');
    expect(nsfwControl((await defaultsPage()).text)).not.toContain('checked');
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

    expect(res.text).toContain('<h1 class="app-section-title">Settings — Defaults</h1>');
    settingsNavLabels(res.text);
    const region = nsfwRegion(res.text);
    expect(region).toContain('id="nsfw-filter-errors"');
    expect(region).toContain('Enabled value must be 0, 1, on, off, true, or false.');
    expect(nsfwControl(region)).toContain('aria-describedby="nsfw-filter-help nsfw-filter-errors"');
    expect(nsfwControl(region)).toContain('aria-invalid="true"');
    expect(nsfwControl(res.text)).not.toContain('checked');
    // The Defaults region renders its saved state without the NSFW errors.
    const defaults = defaultsRegion(res.text);
    expect(defaults).toContain('id="settings-defaults-form"');
    expect(defaults).not.toContain('id="defaults-errors"');
    expect(defaults).not.toContain('Enabled value must be');
    expect(defaults).not.toContain('aria-invalid="true"');
    expect(readMeta(db)).toBeUndefined();
  });

  describe('CSRF regression', () => {
    it('renders a CSRF token in the form', async () => {
      const res = await defaultsPage();
      const formMatch = res.text.match(/<form method="post" action="\/settings\/nsfw-filter"[\s\S]*?<\/form>/);
      expect(formMatch).not.toBeNull();
      const csrfInForm = (formMatch[0].match(/name="_csrf"/g) || []).length;
      expect(csrfInForm).toBe(1);
    });

    it('enables the filter using the token rendered in the page', async () => {
      const page = await defaultsPage();
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

      const page = await defaultsPage();
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
