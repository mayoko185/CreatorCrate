import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

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

function expectLogFilterOption(html, name, value) {
  expect(html).toMatch(new RegExp('<input[^>]*name="' + name + '"[^>]*type="radio"[^>]*value="' + value + '"'));
}

function expectLogFilterChecked(html, name, value) {
  expect(html).toMatch(new RegExp('<input[^>]*name="' + name + '"[^>]*type="radio"[^>]*value="' + value + '" checked>'));
}

describe('settings — logs HTTP', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;
  let repository;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-logs-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db, projectsRoot }, { authConfig: AUTH_CONFIG });
    repository = app.locals.applicationLogRepository;
    ({ agent, csrfToken } = await authenticate(app));
    // Authentication is intentionally logged; reset the direct repository fixture
    // so each viewer assertion starts with only the records it creates.
    repository.clear();
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertLog(overrides = {}) {
    return repository.insert({
      occurredAtMs: 1_000,
      level: 'info',
      kind: 'activity',
      subsystem: 'settings',
      event: 'test.event',
      message: 'Test message.',
      context: {},
      ...overrides,
    });
  }

  it('adds Logs to Settings navigation and renders the authenticated server-rendered viewer', async () => {
    const res = await agent.get('/settings/logs').expect(200);

    expect(activeSettingsNavLabels(res.text, 'settings-logs')).toEqual(['Logs']);
    expect(res.text).toContain('method="get" action="/settings/logs"');
    expect(res.text).toContain('<nav class="project-filter-actions project-filter-actions--projects" aria-label="Log actions">');
    expect(res.text).toContain('aria-label="Refresh logs" data-tooltip="Refresh logs"');
    expect(res.text).toContain('aria-label="Clear logs" data-tooltip="Clear logs"');
    expect(res.text).toContain('data-logs-auto-refresh');
    expect(res.text).toContain('data-logs-auto-refresh-label>Disable auto-refresh</span>');
    expect(res.text).toContain('data-logs-auto-refresh-enabled="true"');
    expect(res.text).toContain('data-logs-auto-refresh-preference="true"');
    expect(res.text).toContain('data-dialog-open="logs-defaults-dialog"');
    expect(res.text).toContain('id="logs-defaults-dialog"');
    expect(res.text).toContain('method="post" action="/settings/logs/defaults"');
    const defaultsDialog = res.text.match(/<dialog id="logs-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(defaultsDialog).toContain('data-dialog-close aria-label="Close Logs defaults"');
    expect(defaultsDialog).not.toContain('data-dialog-close>Cancel</button>');
    expect(defaultsDialog).toContain('class="button button-primary" type="submit" data-dialog-submit>Save</button>');
    expect(res.text).toContain('data-logs-results');
    expect(res.text).toContain('aria-live="polite"');
    await request(app).get('/settings/logs').expect(302);
  });

  it('maps the Clear Logs confirmation to the Logs shell navigation child', async () => {
    const response = await agent.get('/settings/logs/clear').expect(200);

    expect(activeSettingsNavLabels(response.text, 'settings-logs')).toEqual(['Logs']);
  });

  it('renders distinct manual and automatic refresh toolbar icons without changing control contracts', async () => {
    const response = await agent.get('/settings/logs').expect(200);
    const refresh = response.text.match(/<a[^>]*data-logs-refresh[^>]*>[\s\S]*?<\/a>/)?.[0];
    const autoRefresh = response.text.match(/<button[^>]*data-logs-auto-refresh[^>]*>[\s\S]*?<\/button>/)?.[0];
    const refreshIcon = refresh?.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
    const autoRefreshIcon = autoRefresh?.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
    const template = fs.readFileSync(fileURLToPath(new URL('../src/views/settings/logs.njk', import.meta.url)), 'utf8');

    expect(refresh).toContain('button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left');
    expect(autoRefresh).toContain('button button-small button-secondary project-filter-control asset-tooltip asset-tooltip--left');
    expect(refresh).toContain('aria-label="Refresh logs"');
    expect(autoRefresh).toMatch(/aria-label="(?:Enable|Disable) auto-refresh"/);
    expect(autoRefresh).toMatch(/data-tooltip="(?:Enable|Disable) auto-refresh"/);
    expect(autoRefresh).toMatch(/data-logs-auto-refresh-label>(?:Enable|Disable) auto-refresh<\/span>/);
    expect(refreshIcon).not.toBe(autoRefreshIcon);
    expect(template).toContain("data-logs-refresh>\n            {{ icons.icon('releases') }}");
    expect(template).toContain("data-logs-auto-refresh-label>{{ autoRefreshLabel }}</span>");
    expect(template).toContain("{{ icons.icon('calendar') }}<span class=\"sr-only\" data-logs-auto-refresh-label>");
    expect(template).toContain("{{ icons.icon('settings') }}");
    expect(template).toContain("{{ icons.icon('reset') }}");
    expect(template).toContain("{{ icons.icon('warning') }}");
  });

  it('renders one Any time choice in both the Logs filter and Defaults dialog', async () => {
    const res = await agent.get('/settings/logs').expect(200);
    const timeFilterValues = [...res.text.matchAll(/<input[^>]*name="time"[^>]*type="radio"[^>]*value="([^"]*)"/g)]
      .map((match) => match[1]);
    const defaultsTimeSelect = res.text.match(/<select id="logs-default-time"[\s\S]*?<\/select>/)?.[0] || '';
    const defaultsTimeValues = [...defaultsTimeSelect.matchAll(/<option value="([^"]*)"/g)]
      .map((match) => match[1]);

    expect(timeFilterValues).toEqual(['', 'hour', 'day', '7d', '30d']);
    expect(defaultsTimeValues).toEqual(['', 'hour', 'day', '7d', '30d']);
    expect(defaultsTimeSelect).toMatch(/<option value="" selected>\s*Any time\s*<\/option>/);
  });

  it('renders the progressive-enhancement clear dialog and only shows the page-one auto-refresh restriction when applicable', async () => {
    const firstPage = await agent.get('/settings/logs').expect(200);
    expect(firstPage.text).toContain('id="logs-clear-dialog"');
    expect(firstPage.text).toContain('<form id="logs-clear-form" method="post" action="/settings/logs/clear" class="app-dialog-form"');
    expect(firstPage.text).toContain('data-dialog-form data-dialog-async');
    expect(firstPage.text).toContain('data-dialog-open="logs-clear-dialog"');
    expect(firstPage.text).toContain('id="logs-auto-refresh-help" class="form-help" data-logs-auto-refresh-help hidden');
    expect(firstPage.text).not.toContain('aria-describedby="logs-auto-refresh-help"');

    for (let index = 0; index < 51; index += 1) insertLog({ occurredAtMs: index + 1 });
    const laterPage = await agent.get('/settings/logs?page=2').expect(200);
    expect(laterPage.text).toContain('Auto-refresh is available only on page 1.');
    expect(laterPage.text).toContain('id="logs-auto-refresh-help" class="form-help" data-logs-auto-refresh-help');
    expect(laterPage.text).toContain('aria-describedby="logs-auto-refresh-help"');
    const css = (await agent.get('/creatorcrate.css').expect(200)).text;
    expect(css).toContain('.filters > .form-help { margin-block: 0; }');

    const clear = await agent.post('/settings/logs/clear')
      .set('Accept', 'application/json')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(200);
    expect(clear.body).toMatchObject({ status: 'success' });
  });

  it('reuses the Projects filter card and project-detail section contracts', async () => {
    insertLog();
    const page = await agent.get('/settings/logs').expect(200);
    const css = (await agent.get('/creatorcrate.css').expect(200)).text;
    const filterForm = page.text.match(/<form method="get" action="\/settings\/logs"[\s\S]*?<\/form>/)?.[0] || '';

    expect(page.text.indexOf('aria-current="page">Logs</a>')).toBeLessThan(
      page.text.indexOf('<div class="asset-viewer-display-controls">')
    );
    expect(page.text.indexOf('<div class="asset-viewer-display-controls">')).toBeLessThan(
      page.text.indexOf('<form method="get" action="/settings/logs"')
    );
    expect(page.text).toContain('<nav class="project-filter-actions project-filter-actions--projects" aria-label="Log actions">');
    expect(page.text).toContain('<form method="get" action="/settings/logs" class="filters asset-viewer-filters asset-viewer-filters--projects logs-filter-form" data-logs-filter-form>');
    expect(page.text).toContain('class="project-detail-section logs-results-section"');
    expect(page.text).toContain('<h2 id="logs-results-heading">Log entries</h2>');
    expect(page.text).toContain('class="project-detail-section-body"');
    expect(page.text).toContain('class="table-scroll logs-table-scroll"');
    expect(page.text).toContain('class="button button-small button-secondary project-filter-control');
    expect(page.text).not.toContain('aria-label="Apply filters"');
    expect(page.text).toContain('aria-label="Clear filters" data-tooltip="Clear filters" data-logs-clear-filters');
    expect(filterForm).toContain('data-cc-dropdown-mode="single"');
    expect(filterForm).not.toContain('data-cc-dropdown-native-select');
    expect(filterForm).not.toContain('data-cc-dropdown-dispatch-native-change');

    expect(css).toMatch(/\.project-detail-section\s*\{[^}]*background:\s*var\(--surface\)[^}]*border:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/\.project-detail-section > h2\s*\{[^}]*background:\s*var\(--surface-hover\)[^}]*border-bottom:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/\.project-detail-section-body\s*\{[^}]*padding:\s*var\(--space-md\) var\(--space-lg\)/);
    expect(css).toMatch(/\.logs-filter-form\s*\{[^}]*border:\s*1px solid var\(--border\)[^}]*border-radius:\s*var\(--radius-lg\)/);
    expect(css).toMatch(/\.project-filter-actions--projects \.project-filter-control svg\s*\{[^}]*width:\s*1\.25rem[^}]*height:\s*1\.25rem/);
    expect(css).toMatch(/\.logs-table-scroll\s*\{[^}]*scrollbar-color:\s*var\(--border-strong\) transparent[^}]*scrollbar-width:\s*thin/);
    expect(css).toMatch(/\.logs-table td\s*\{[^}]*font-size:\s*0\.8125rem/);
  });

  it('renders newest-first records, nullable references, and structured safe context', async () => {
    insertLog({ occurredAtMs: 1_000, event: 'older.event', message: 'Older message.' });
    insertLog({
      occurredAtMs: 2_000,
      event: 'newer.event',
      message: 'Newer message.',
      projectId: 7,
      correlationId: 'corr-7',
      context: { count: 2, nested: { state: 'ready' } },
    });

    const res = await agent.get('/settings/logs').expect(200);

    expect(res.text.indexOf('newer.event')).toBeLessThan(res.text.indexOf('older.event'));
    expect(res.text).toContain('<code>7</code>');
    expect(res.text).toContain('<code>corr-7</code>');
    expect(res.text).toContain('<details class="logs-context">');
    expect(res.text).toContain('<dl class="detail-list logs-context-list">');
    expect(res.text).toContain('<dt>nested.state</dt>');
    expect(res.text).toContain('>—</td>');
  });

  it('renders a UTC fallback plus the authoritative epoch for client-side timezone formatting', async () => {
    const occurredAtMs = Date.UTC(2024, 5, 1, 12, 0, 0) + 123;
    insertLog({ occurredAtMs, event: 'timestamp.utc' });

    const res = await agent.get('/settings/logs').expect(200);

    expect(res.text).toContain('data-logs-timezone="local"');
    expect(res.text).toContain('datetime="2024-06-01T12:00:00.123Z" data-log-timestamp-ms="1717243200123"');
    expect(res.text).toContain('>2024-06-01 12:00:00 UTC</time>');
  });

  it('renders a persisted positive numeric watermarkId without relaxing other sensitive context redaction', async () => {
    insertLog({
      event: 'processing.watermark.default.changed',
      context: { watermarkId: 17, watermarkPath: '/srv/creatorcrate/watermark.png' },
    });

    const response = await agent.get('/settings/logs').expect(200);

    expect(response.text).toMatch(/watermarkId[\s\S]{0,100}17/);
    expect(response.text).toMatch(/watermarkPath[\s\S]{0,100}\[redacted\]/);
  });

  it('filters exactly by level, kind, subsystem, and their combination', async () => {
    insertLog({ level: 'warn', kind: 'activity', subsystem: 'settings', event: 'warn.settings' });
    insertLog({ level: 'warn', kind: 'diagnostic', subsystem: 'worker', event: 'warn.worker' });
    insertLog({ level: 'error', kind: 'activity', subsystem: 'worker', event: 'error.worker' });

    const level = await agent.get('/settings/logs?level=warn').expect(200);
    expect(level.text).toContain('warn.settings');
    expect(level.text).toContain('warn.worker');
    expect(level.text).not.toContain('error.worker');

    const kind = await agent.get('/settings/logs?kind=diagnostic').expect(200);
    expect(kind.text).toContain('warn.worker');
    expect(kind.text).not.toContain('warn.settings');

    const subsystem = await agent.get('/settings/logs?subsystem=worker').expect(200);
    expect(subsystem.text).toContain('warn.worker');
    expect(subsystem.text).toContain('error.worker');

    const combined = await agent.get('/settings/logs?level=warn&kind=diagnostic&subsystem=worker').expect(200);
    expect(combined.text).toContain('warn.worker');
    expect(combined.text).not.toContain('error.worker');
    expectLogFilterChecked(combined.text, 'level', 'warn');
    expectLogFilterChecked(combined.text, 'kind', 'diagnostic');
    expectLogFilterChecked(combined.text, 'subsystem', 'worker');
  });

  it('paginates at 50 records and preserves filters through Previous and Next links', async () => {
    for (let index = 0; index < 51; index += 1) {
      insertLog({
        occurredAtMs: index + 1,
        level: 'warn',
        kind: 'activity',
        subsystem: 'paging',
        event: 'page-' + index,
      });
    }

    const firstPage = await agent.get('/settings/logs?level=warn&kind=activity&subsystem=paging').expect(200);
    expect(firstPage.text).toContain('Page 1 of 2');
    expect(firstPage.text).toContain('/settings/logs?level=warn&amp;kind=activity&amp;subsystem=paging&amp;pageSize=50&amp;page=2');

    const secondPage = await agent.get('/settings/logs?level=warn&kind=activity&subsystem=paging&page=2').expect(200);
    expect(secondPage.text).toContain('Page 2 of 2');
    expect(secondPage.text).toContain('/settings/logs?level=warn&amp;kind=activity&amp;subsystem=paging&amp;pageSize=50');
    expect(secondPage.text).toContain('page-0');
    expect(secondPage.text).not.toContain('page-50');
  });

  it('accepts only bounded item counts, preserves them through pagination, and keeps no-JavaScript GET navigation', async () => {
    for (let index = 0; index < 51; index += 1) {
      insertLog({ occurredAtMs: index + 1, event: `items-${index}` });
    }

    const firstPage = await agent.get('/settings/logs?pageSize=25').expect(200);
    expectLogFilterChecked(firstPage.text, 'pageSize', '25');
    expect(firstPage.text).toContain('Page 1 of 3');
    expect(firstPage.text).toContain('/settings/logs?pageSize=25&amp;page=2');

    const secondPage = await agent.get('/settings/logs?pageSize=25&page=2').expect(200);
    expect(secondPage.text).toContain('Page 2 of 3');
    expect(secondPage.text).toContain('/settings/logs?pageSize=25');

    const seventyFive = await agent.get('/settings/logs?pageSize=75').expect(200);
    expectLogFilterChecked(seventyFive.text, 'pageSize', '75');
    expect(seventyFive.text).toContain('Page 1 of 1');

    const invalid = await agent.get('/settings/logs?pageSize=999').expect(200);
    expectLogFilterChecked(invalid.text, 'pageSize', '50');
    expect(invalid.text).toContain('Page 1 of 2');
  });

  it('keeps an explicit item count in the no-JavaScript Clear Filters destination', async () => {
    await agent
      .post('/settings/logs/defaults')
      .type('form')
      .send({
        _csrf: csrfToken,
        level: '',
        kind: '',
        subsystem: '',
        time: '',
        pageSize: '50',
        timezone: 'local',
        autoRefresh: 'enabled',
      })
      .expect(302);

    const page = await agent
      .get('/settings/logs?level=error&kind=diagnostic&time=day&pageSize=25&page=2')
      .expect(200);

    const clearFilters = page.text.match(/<a[^>]*data-logs-clear-filters[^>]*>/)?.[0] || '';
    expect(clearFilters).toContain('href="/settings/logs?pageSize=25"');
    expect(clearFilters).not.toContain('level=');
    expect(clearFilters).not.toContain('page=');
    expect(app.locals.pageDefaultsService.resolve('logs', 'pageSize')).toBe('50');
  });

  it('handles invalid filters and page inputs without errors or query reflection', async () => {
    insertLog({ event: 'safe.event' });

    const res = await agent
      .get('/settings/logs?level=invalid&kind=<script>alert(1)</script>&subsystem=missing&page=999999999999999999999')
      .expect(200);

    expect(res.text).toContain('safe.event');
    expect(res.text).toContain('Page 1 of 1');
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });

  it('renders distinct no-logs and filtered-empty states', async () => {
    const empty = await agent.get('/settings/logs').expect(200);
    expect(empty.text).toContain('No application logs yet');

    insertLog({ level: 'warn', event: 'only.warn' });
    const filteredEmpty = await agent.get('/settings/logs?level=error').expect(200);
    expect(filteredEmpty.text).toContain('No logs match these filters');
    expect(filteredEmpty.text).toContain('Adjust the filters or return to the full log view.');
  });

  it('escapes messages and context while defensively redacting sensitive keys, paths, and stacks', async () => {
    insertLog({
      event: 'unsafe.event',
      message: '<script>window.pwned = true</script>',
      context: {
        safe: '<img src=x onerror=alert(1)>',
        closingTag: '</div>',
        password: 'not visible',
        path: 'C:\\CreatorCrate\\secret.txt',
        trace: 'Error: failed\n    at run (C:\\CreatorCrate\\app.js:1:1)',
      },
    });

    const res = await agent.get('/settings/logs').expect(200);

    expect(res.text).toContain('&lt;script&gt;window.pwned = true&lt;/script&gt;');
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).toContain('&lt;/div&gt;');
    expect(res.text).toContain('<dd>[redacted]</dd>');
    expect(res.text).toContain('[redacted path]');
    expect(res.text).toContain('[redacted stack trace]');
    expect(res.text).not.toContain('not visible');
    expect(res.text).not.toContain('C:&#92;CreatorCrate');
  });

  it('defensively redacts punctuation-delimited absolute paths from directly persisted legacy messages and context', async () => {
    const legacyPathTexts = [
      'open <C:\\Users\\Andy\\file.png>',
      'open </home/user/file.png>',
      'open </etc>',
      'open </tmp>',
      'open </var>',
      "open 'C:\\Users\\Andy\\file.png'",
      'open "/home/user/file.png"',
      'open (C:\\Users\\Andy\\file.png)',
      'open [/home/user/file.png]',
      'open: C:\\Users\\Andy\\file.png',
      'open, /home/user/file.png',
    ];

    for (const [index, legacyPathText] of legacyPathTexts.entries()) {
      insertLog({
        event: `legacy.path.${index}`,
        message: legacyPathText,
        context: { detail: legacyPathText },
      });
    }
    insertLog({
      event: 'legacy.path.safe',
      message: 'Safe aggregate message.',
      context: { requestedCount: 12, detail: 'ordinary slash-separated prose' },
    });

    const res = await agent.get('/settings/logs').expect(200);

    expect(res.text).not.toContain('file.png');
    expect(res.text).not.toContain('/home/user/file.png');
    expect(res.text).not.toContain('/etc>');
    expect(res.text).not.toContain('/tmp>');
    expect(res.text).not.toContain('/var>');
    expect(res.text.match(/\[redacted path\]/g)).toHaveLength(legacyPathTexts.length * 2);
    expect(res.text).toContain('Safe aggregate message.');
    expect(res.text).toContain('ordinary slash-separated prose');
    expect(res.text).toMatch(/<dt>requestedCount<\/dt>\s*<dd>12<\/dd>/);
  });

  it('defensively redacts generic auth-bearing text from directly persisted legacy messages and context', async () => {
    insertLog({
      event: 'legacy.generic-auth.message.token',
      message: 'token=visible-token-secret',
    });
    insertLog({
      event: 'legacy.generic-auth.message.authorization',
      message: 'Authorization: Custom visible-authorization-secret',
    });
    insertLog({
      event: 'legacy.generic-auth.context',
      context: {
        detailOne: 'CSRF=visible-csrf-secret',
        detailTwo: 'auth=visible-auth-secret',
      },
    });
    insertLog({
      event: 'legacy.generic-auth.safe-prose',
      message: 'Authorization failed',
      context: { detail: 'Token validation failed' },
    });

    const res = await agent.get('/settings/logs').expect(200);

    expect(res.text).not.toContain('visible-');
    expect(res.text.match(/\[redacted secret\]/g)?.length).toBeGreaterThanOrEqual(4);
    expect(res.text).toContain('Authorization failed');
    expect(res.text).toContain('Token validation failed');
  });

  it('omits unsafe legacy metadata from filter options while preserving canonical filters', async () => {
    const unsafeSubsystems = [
      'token=visible-token-secret',
      'Authorization: Custom visible-authorization-secret',
      'C:\\private',
    ];
    for (const [index, subsystem] of unsafeSubsystems.entries()) {
      insertLog({
        level: `legacy-level-${index}`,
        kind: `legacy-kind-${index}`,
        subsystem,
        event: `legacy.metadata.${index}`,
      });
    }
    insertLog({ level: 'warn', kind: 'diagnostic', subsystem: 'safe-viewer', event: 'safe.metadata' });

    const res = await agent.get('/settings/logs').expect(200);

    for (const unsafeSubsystem of unsafeSubsystems) {
      expect(res.text).not.toContain(unsafeSubsystem);
    }
    expectLogFilterOption(res.text, 'level', 'warn');
    expectLogFilterOption(res.text, 'kind', 'diagnostic');
    expectLogFilterOption(res.text, 'subsystem', 'safe-viewer');
    expect(res.text).not.toContain('value="legacy-level-0"');
    expect(res.text).not.toContain('value="legacy-kind-0"');

    const safeFilter = await agent.get('/settings/logs?level=warn&kind=diagnostic&subsystem=safe-viewer').expect(200);
    expect(safeFilter.text).toContain('safe.metadata');
    expectLogFilterChecked(safeFilter.text, 'level', 'warn');
    expectLogFilterChecked(safeFilter.text, 'kind', 'diagnostic');
    expectLogFilterChecked(safeFilter.text, 'subsystem', 'safe-viewer');

    const unsafeFilter = await agent.get('/settings/logs?subsystem=token%3Dvisible-token-secret').expect(200);
    expect(unsafeFilter.text).not.toContain('token=visible-token-secret');
  });

  it('renders no more than 100 safe dynamic subsystem choices', async () => {
    for (let index = 149; index >= 0; index -= 1) {
      insertLog({ subsystem: `safe-subsystem-${String(index).padStart(3, '0')}` });
    }

    const res = await agent.get('/settings/logs').expect(200);
    const subsystemDropdown = res.text.match(/<details[^>]*id="logs-subsystem-filter"[\s\S]*?<\/details>/)?.[0] || '';

    expect([...subsystemDropdown.matchAll(/<input[^>]*name="subsystem"[^>]*value="safe-subsystem-\d{3}"/g)]).toHaveLength(100);
    expect(subsystemDropdown).toContain('value="safe-subsystem-000"');
    expect(subsystemDropdown).toContain('value="safe-subsystem-099"');
    expect(subsystemDropdown).not.toContain('value="safe-subsystem-100"');
  });

  it('renders safe request-count summaries while redacting legacy request context', async () => {
    insertLog({
      context: {
        requestedCount: 12,
        requestBody: { raw: 'legacy top-level request body' },
        resultSummary: {
          requestedCount: 7,
          requestPayload: { raw: 'legacy nested request payload' },
        },
      },
    });

    const res = await agent.get('/settings/logs').expect(200);

    expect(res.text).toMatch(/<dt>requestedCount<\/dt>\s*<dd>12<\/dd>/);
    expect(res.text).toMatch(/<dt>resultSummary\.requestedCount<\/dt>\s*<dd>7<\/dd>/);
    expect(res.text).toMatch(/<dt>requestBody<\/dt>\s*<dd>\[redacted\]<\/dd>/);
    expect(res.text).toMatch(/<dt>resultSummary\.requestPayload<\/dt>\s*<dd>\[redacted\]<\/dd>/);
    expect(res.text).not.toContain('legacy top-level request body');
    expect(res.text).not.toContain('legacy nested request payload');
  });

  it('requires CSRF and a confirmation page before clearing logs', async () => {
    insertLog({ event: 'to.clear' });

    const confirmation = await agent.get('/settings/logs/clear?level=info').expect(200);
    expect(confirmation.text).toContain('Clear all application logs?');
    expect(confirmation.text).toContain('method="post" action="/settings/logs/clear"');
    expect(confirmation.text).toContain('name="_csrf"');

    await agent.post('/settings/logs/clear').type('form').send({}).expect(403);
    expect(repository.findPage().map((entry) => entry.event)).toContain('to.clear');
  });

  it('renders Clear Logs with the shared destructive dialog structure and progressive fallback', async () => {
    const response = await agent.get('/settings/logs').expect(200);

    expect(response.text).toContain('href="/settings/logs/clear?pageSize=50"');
    expect(response.text).toContain('data-dialog-open="logs-clear-dialog"');
    expect(response.text).toContain('id="logs-clear-dialog" class="app-dialog app-confirmation-dialog" data-app-dialog');
    expect(response.text).toContain('<form id="logs-clear-form" method="post" action="/settings/logs/clear" class="app-dialog-form"');
    expect(response.text).toContain('data-dialog-form data-dialog-async');
    expect(response.text).toContain('name="_csrf" value="');
    const clearDialog = response.text.match(/<dialog id="logs-clear-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(clearDialog).toContain('data-dialog-close aria-label="Close Clear logs"');
    expect(clearDialog).not.toContain('class="app-dialog-body"');
    expect(clearDialog).toContain('class="app-dialog-footer"');
    expect(clearDialog).not.toContain('data-dialog-close>Cancel</button>');
    expect(clearDialog).toContain('class="button button-danger" type="submit" data-dialog-submit>Clear logs</button>');
    expect(response.text).toContain('class="app-dialog-status" data-dialog-status role="status" aria-live="polite"');
    expect(clearDialog).toContain('data-dialog-pending-message="Clearing logs…"');
    expect(clearDialog).toContain('data-dialog-error-message="Logs could not be cleared."');
    expect(clearDialog).toContain('data-dialog-network-error-message="Could not clear logs."');
    expect(clearDialog).toContain('data-dialog-success-message="Logs cleared."');
    expect(response.text).not.toContain('data-logs-clear-form');
  });

  it('clears transactionally then records exactly one safe logging.cleared marker', async () => {
    insertLog({ event: 'before.clear.one', context: { customer: 'private value' } });
    insertLog({ event: 'before.clear.two', context: { requestBody: 'private request' } });

    const clear = await agent
      .post('/settings/logs/clear')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(clear.headers.location).toBe('/settings/logs?notice=logging_cleared');
    const rows = repository.findPage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: 'info',
      kind: 'activity',
      subsystem: 'settings',
      event: 'logging.cleared',
      message: 'Application logs cleared.',
    });
    expect(JSON.parse(rows[0].context_json)).toEqual({ deletedCount: 2 });
    expect(rows[0].context_json).not.toContain('private');

    const redirected = await agent.get(clear.headers.location).expect(200);
    expect(redirected.text).toContain('Application logs cleared.');
    expect(redirected.text).toContain('logging.cleared');
  });


  it('redirects after a successful clear when the activity logger throws', async () => {
    const loggedEntries = [];
    const projectsRoot = path.join(tmpDir, 'projects');
    app = createApp({ appName: APP_NAME, db, projectsRoot }, {
      authConfig: AUTH_CONFIG,
      applicationLogger: {
        info(entry) {
          loggedEntries.push(entry);
          throw new Error('injected logging failure');
        },
        rebindRepository() {},
        prune() {},
      },
    });
    ({ agent, csrfToken } = await authenticate(app));
    loggedEntries.length = 0;

    insertLog({ event: 'before.clear.one' });
    insertLog({ event: 'before.clear.two' });

    const response = await agent
      .post('/settings/logs/clear')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe('/settings/logs?notice=logging_cleared');
    expect(repository.count()).toBe(0);
    expect(loggedEntries).toEqual([
      expect.objectContaining({
        event: 'logging.cleared',
        kind: 'activity',
        subsystem: 'settings',
        message: 'Application logs cleared.',
        context: { deletedCount: 2 },
      }),
    ]);
  });

  it('applies bounded time presets server-side and preserves them through pagination', async () => {
    const nowMs = 10_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      insertLog({ occurredAtMs: nowMs - 60 * 60 * 1000 - 1, level: 'warn', event: 'outside-hour' });
      insertLog({ occurredAtMs: nowMs - 60 * 60 * 1000, level: 'warn', event: 'at-hour-boundary' });
      insertLog({ occurredAtMs: nowMs - 1, level: 'error', event: 'recent-error' });

      const filtered = await agent.get('/settings/logs?time=hour&level=warn').expect(200);
      expect(filtered.text).toContain('at-hour-boundary');
      expect(filtered.text).not.toContain('outside-hour');
      expect(filtered.text).not.toContain('recent-error');
      expectLogFilterChecked(filtered.text, 'time', 'hour');

      for (let index = 0; index <= 50; index += 1) {
        insertLog({ occurredAtMs: nowMs - index, level: 'warn', subsystem: 'time-page', event: 'time-page-' + index });
      }
      const paged = await agent.get('/settings/logs?time=day&level=warn&subsystem=time-page').expect(200);
      expect(paged.text).toContain('level=warn&amp;subsystem=time-page&amp;time=day&amp;pageSize=50&amp;page=2');
      await agent.get('/settings/logs?time=invalid').expect(200);
    } finally {
      now.mockRestore();
    }
  });

  it('persists global Logs defaults and applies them to a bare no-JavaScript navigation', async () => {
    const saved = await agent
      .post('/settings/logs/defaults')
      .type('form')
      .send({
        _csrf: csrfToken,
        level: 'error',
        kind: 'diagnostic',
        subsystem: '',
        time: 'day',
        pageSize: '25',
        timezone: 'America/New_York',
        autoRefresh: 'disabled',
      })
      .expect(302);

    expect(saved.headers.location).toBe('/settings/logs?level=error&kind=diagnostic&time=day&pageSize=25');
    insertLog({ occurredAtMs: Date.now(), level: 'error', kind: 'diagnostic', event: 'saved.defaults.match' });
    insertLog({ occurredAtMs: Date.now(), level: 'warn', kind: 'diagnostic', event: 'saved.defaults.other' });

    const bare = await agent.get('/settings/logs').expect(200);
    expect(bare.text).toContain('saved.defaults.match');
    expect(bare.text).not.toContain('saved.defaults.other');
    expectLogFilterChecked(bare.text, 'level', 'error');
    expectLogFilterChecked(bare.text, 'kind', 'diagnostic');
    expectLogFilterChecked(bare.text, 'time', 'day');
    expectLogFilterChecked(bare.text, 'pageSize', '25');
    expect(bare.text).toContain('data-logs-timezone="America/New_York"');
    expect(bare.text).toContain('data-logs-auto-refresh-enabled="false"');
    expect(app.locals.pageDefaultsService.resolve('logs', 'pageSize')).toBe('25');
    expect(app.locals.pageDefaultsService.resolve('logs', 'timezone')).toBe('America/New_York');
    expect(repository.findPage().some((entry) => entry.event === 'settings.logs_defaults.updated')).toBe(true);
  });

  it('lets an explicit item count override the saved default without changing it', async () => {
    await agent
      .post('/settings/logs/defaults')
      .type('form')
      .send({
        _csrf: csrfToken,
        level: '',
        kind: '',
        subsystem: '',
        time: '',
        pageSize: '25',
        timezone: 'local',
        autoRefresh: 'enabled',
      })
      .expect(302);
    for (let index = 0; index < 26; index += 1) insertLog({ occurredAtMs: index + 1, event: `saved-items-${index}` });

    const bare = await agent.get('/settings/logs').expect(200);
    expect(bare.text).toContain('Page 1 of 2');
    expectLogFilterChecked(bare.text, 'pageSize', '25');

    const explicit = await agent.get('/settings/logs?pageSize=100').expect(200);
    expect(explicit.text).toContain('Page 1 of 1');
    expectLogFilterChecked(explicit.text, 'pageSize', '100');
    expect(app.locals.pageDefaultsService.resolve('logs', 'pageSize')).toBe('25');
  });

  it('lets explicit query filters override saved Logs defaults without changing the saved values', async () => {
    await agent
      .post('/settings/logs/defaults')
      .type('form')
      .send({
        _csrf: csrfToken,
        level: 'error',
        kind: '',
        subsystem: '',
        time: '',
        pageSize: '50',
        timezone: 'local',
        autoRefresh: 'enabled',
      })
      .expect(302);
    insertLog({ level: 'warn', event: 'explicit.warn' });
    insertLog({ level: 'error', event: 'saved.error' });

    const explicit = await agent.get('/settings/logs?level=warn').expect(200);
    expect(explicit.text).toContain('explicit.warn');
    expect(explicit.text).not.toContain('saved.error');
    expectLogFilterChecked(explicit.text, 'level', 'warn');
    expect(app.locals.pageDefaultsService.resolve('logs', 'level')).toBe('error');
  });

  it('rejects invalid or stale Logs default subsystem values safely', async () => {
    const invalid = await agent
      .post('/settings/logs/defaults')
      .set('Accept', 'application/json')
      .type('form')
      .send({
        _csrf: csrfToken,
        level: '',
        kind: '',
        subsystem: 'not-a-current-subsystem',
        time: '',
        pageSize: '50',
        timezone: 'local',
        autoRefresh: 'enabled',
      })
      .expect(422);

    expect(invalid.body.errors).toEqual({
      subsystem: 'Value "not-a-current-subsystem" is not supported for logs.subsystem.',
    });
    app.locals.appMetaRepository.setValue('page_defaults.logs.subsystem', 'stale-subsystem');
    app.locals.appMetaRepository.setValue('page_defaults.logs.page_size', '999');
    app.locals.appMetaRepository.setValue('page_defaults.logs.timezone', 'Mars/Olympus_Mons');
    const bare = await agent.get('/settings/logs').expect(200);
    expectLogFilterChecked(bare.text, 'subsystem', '');
    expectLogFilterChecked(bare.text, 'pageSize', '50');
    expect(bare.text).toContain('data-logs-timezone="local"');
    expect(bare.text).not.toContain('stale-subsystem');
  });

  it('suppresses the saved auto-refresh preference on page two without overwriting it', async () => {
    for (let index = 0; index < 51; index += 1) {
      insertLog({ occurredAtMs: index + 1, event: `paging-${index}` });
    }

    const secondPage = await agent.get('/settings/logs?page=2').expect(200);
    expect(secondPage.text).toContain('data-logs-auto-refresh-enabled="false"');
    expect(secondPage.text).toContain('data-logs-auto-refresh-preference="true"');
    expect(app.locals.pageDefaultsService.resolve('logs', 'autoRefresh')).toBe('enabled');
    const firstPage = await agent.get('/settings/logs').expect(200);
    expect(firstPage.text).toContain('data-logs-auto-refresh-enabled="true"');
  });
});
