import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import * as socialTokens from '../src/services/social-prep-tokens.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

vi.mock('../src/services/social-prep-tokens.js', async (importOriginal) => {
  const original = await importOriginal();
  return Object.fromEntries(Object.entries(original).map(([key, value]) => [
    key, typeof value === 'function' ? vi.fn(value) : value,
  ]));
});

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const FIRST = '2026-07-01 01:02:03';
const UPDATED = '2026-08-02 04:05:06';

describe('release Social Preparation detail display', () => {
  let app, agent, db, tmpDir, releaseId, projectId, settings;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-display-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot);
    fs.mkdirSync(appDataRoot);
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot, authState: { csrfPepper },
    });
    const auth = await getDisabledModeCsrf(app, appDataRoot);
    agent = auth.agent;
    const project = await agent.post('/projects').type('form').send({
      _csrf: auth.csrfToken, title: 'Display fixture', status: 'tbd',
    }).expect(302);
    projectId = Number(project.headers.location.split('/').pop());
    const release = await agent.post('/releases').type('form').send({
      _csrf: auth.csrfToken, projectId, title: 'Display release',
    }).expect(302);
    releaseId = Number(release.headers.location.split('/').pop());
    settings = app.locals.socialPrepSettingsService;
    settings.setPlatforms(['patreon', 'x', 'bluesky']);
    settings.setEnabled(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Synthetic persisted states belong only to this temporary database.
  function target(platform, status = 'pending', attempts = 1, preparedAt = null) {
    app.locals.socialPrepRepository.ensurePlatforms(releaseId, [platform]);
    db.prepare(`UPDATE release_social_platforms SET status = ?, attempts = ?,
      prepared_at = ?, updated_at = ?, message = ?, detail_code = ?
      WHERE release_id = ? AND platform = ?`).run(status, attempts, preparedAt, UPDATED,
      'PRIVATE_MESSAGE token=PRIVATE_TOKEN C:\\PRIVATE_PATH creator=PRIVATE_CREATOR <script>PRIVATE_SCRIPT</script>',
      'PRIVATE_DETAIL_CODE', releaseId, platform);
  }

  async function detail() {
    const response = await agent.get(`/releases/${releaseId}`).expect(200);
    const section = response.text.match(/<section id="release-social-preparation"[\s\S]*?<\/section>/)?.[0];
    expect(section).toBeTruthy();
    expect(section).toContain('<h2 id="release-social-preparation-heading">Social Posts</h2>');
    expect(section).not.toMatch(/<h2\b[^>]*>Social Preparation<\/h2>/);
    expect(section).not.toContain('Preparation opens a composer for human submission. Prepared does not mean posted.');
    expect(section).not.toContain('Helper preparation actions are not available in this checkpoint.');
    expect(section).not.toMatch(/<form\b|<button\b|<input\b|data-dialog|data-social/i);
    expect(response.text).not.toMatch(/PRIVATE_|openlocally:|creatorcrate-social:|\/social-prep\/activate|\/social-preparation\/activate/i);
    // Preparation states must not claim publication or submission.
    expect(section).not.toMatch(/\b(posted|published|submitted|sent successfully)\b/i);
    expect(section).not.toMatch(/Full report|Complete diagnostic|Native report|Prepare again|Reprepare|Retry|Send to helper again/i);
    return { html: response.text, section };
  }

  function platformSection(section, platform) {
    return section.match(new RegExp(`<article aria-labelledby="release-social-preparation-${platform}">[\\s\\S]*?</article>`))?.[0];
  }

  describe('compact release list', () => {
    function releaseRow(html, id = releaseId) {
      return html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)
        ?.find((row) => row.includes(`href="/releases/${id}"`));
    }

    async function list(projectFiltered = false) {
      const { text: html } = await agent.get(projectFiltered ? `/releases?project=${projectId}` : '/releases').expect(200);
      const row = releaseRow(html);
      expect(row).toBeTruthy();
      const summary = row.match(/<div class="release-social-prep-summary"[\s\S]*?<\/div>/)?.[0];
      expect(html).not.toMatch(/PRIVATE_|openlocally:|creatorcrate-social:|\/social-prep\/activate|\/social-preparation\/activate/i);
      if (summary) {
        expect(summary).toContain('<small>Social posts</small>');
        expect(summary).toContain('aria-label="Social posts"');
        expect(summary).not.toMatch(/Social targets|\(last recorded preparation\)/);
        expect(summary).not.toMatch(/<form\b|<button\b|<input\b|<a\b|data-dialog|data-social|\b(posted|published|submitted|live)\b|sent successfully|retry|reprepare|activate/i);
      }
      expect(html).toContain('href="/releases/new" data-dialog-open="release-create-dialog"');
      expect(html).toContain('aria-label="Releases defaults"');
      expect(html).toContain('aria-label="Reset filters"');
      expect(html).toContain('aria-label="Release list pages"');
      expect(html).toContain('class="table-scroll" tabindex="0" aria-label="Release list"');
      expect(html.match(/<thead>[\s\S]*?<\/thead>/)[0].match(/<th\b/g)).toHaveLength(7);
      expect(row.match(/<td\b/g)).toHaveLength(7);
      expect(row).toContain(`href="/releases/${releaseId}">Display release</a>`);
      if (summary) expect(row.split('</td>')[0]).toContain(summary);
      return { html, row, summary };
    }

    it.each([false, true])('shows every mixed saved target in canonical order (projectFiltered=%s)', async (filtered) => {
      target('bluesky', 'failed');
      target('x', 'prepared');
      target('patreon', 'pending', 0);
      const { summary } = await list(filtered);
      expect(summary.match(/class="status-badge status-badge--neutral">[^<]+/g)).toEqual([
        'class="status-badge status-badge--neutral">Patreon · Not attempted',
        'class="status-badge status-badge--neutral">X · Prepared',
        'class="status-badge status-badge--neutral">Bluesky · Failed',
      ]);
    });

    it.each([
      ['pending', 'Pending'], ['starting', 'Starting'], ['preparing', 'Preparing'],
      ['uploading', 'Uploading'], ['auth_required', 'Authentication required'],
      ['prepared', 'Prepared'], ['failed', 'Failed'], ['cancelled', 'Cancelled'],
    ])('shows one target with compact %s terminology', async (state, label) => {
      target('x', state);
      const { summary } = await list();
      expect(summary).toContain(`>X · ${label}</span>`);
      expect(summary.match(/class="status-badge /g)).toHaveLength(1);
    });

    it.each([false, true])('omits unsaved targets despite configured Settings (projectFiltered=%s)', async (filtered) => {
      const { row, summary } = await list(filtered);
      expect(summary).toBeUndefined();
      expect(row).not.toContain('Social posts');
      expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)).toEqual([]);
    });

    it.each([false, true])('keeps removed saved platforms independently of global enablement (%s)', async (enabled) => {
      target('patreon', 'failed');
      target('x', 'cancelled');
      settings.setPlatforms(['bluesky']);
      settings.setEnabled(enabled);
      const { summary } = await list(true);
      expect(summary).toContain('>Patreon · Failed</span>');
      expect(summary).toContain('>X · Cancelled</span>');
      expect(summary).not.toContain('Bluesky');
    });

    it('keeps other releases isolated and respects the project filter', async () => {
      target('x', 'prepared');
      const other = db.prepare("INSERT INTO releases (project_id, title) VALUES (?, 'Other release') RETURNING *").get(projectId);
      for (const filtered of [false, true]) {
        const { html } = await list(filtered);
        const otherRow = releaseRow(html, other.id);
        expect(otherRow).toBeTruthy();
        expect(otherRow).not.toMatch(/Social posts|release-social-prep-summary/);
      }
      const { text } = await agent.get('/releases?project=999999').expect(200);
      expect(text).not.toContain(`href="/releases/${releaseId}"`);
    });

    it.each([false, true])('keeps both list GETs read-only without service or token execution (saved=%s)', async (saved) => {
      if (saved) target('x', 'prepared');
      const service = app.locals.socialPrepService;
      app.locals.socialPrepService = Object.fromEntries(Object.entries(service).map(([key, value]) => [
        key, typeof value === 'function' ? vi.fn(() => { throw new Error('List must not execute preparation'); }) : value,
      ]));
      const spies = [...Object.values(app.locals.socialPrepService), ...Object.values(socialTokens)].filter(vi.isMockFunction);
      spies.forEach((spy) => spy.mockClear());
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      try {
        await list();
        await list(true);
        expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(before);
        spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
      } finally {
        app.locals.socialPrepService = service;
      }
    });
  });

  it('renders separate mixed platforms in presenter order with distinct timestamps and safe failure context', async () => {
    target('bluesky', 'failed', 3, FIRST);
    target('x', 'prepared', 1, FIRST);
    target('patreon', 'pending', 0);
    const { section } = await detail();
    expect(section.match(/<article /g)).toHaveLength(3);
    expect(section.indexOf('>Patreon</h3>')).toBeLessThan(section.indexOf('>X</h3>'));
    expect(section.indexOf('>X</h3>')).toBeLessThan(section.indexOf('>Bluesky</h3>'));
    expect(platformSection(section, 'patreon')).toContain('Not attempted');
    expect(platformSection(section, 'patreon')).toContain('No helper preparation request has been issued.');
    expect(platformSection(section, 'x')).toContain('Composer prepared for human submission');
    const failed = platformSection(section, 'bluesky');
    expect(failed).toContain('Preparation failed');
    expect(failed).toMatch(/<dt>Preparation requests<\/dt>\s*<dd>3<\/dd>/);
    expect(failed).toMatch(new RegExp(`<dt>First prepared</dt>\\s*<dd>${FIRST}</dd>`));
    expect(failed).toMatch(new RegExp(`<dt>Last updated</dt>\\s*<dd>${UPDATED}</dd>`));
    expect(failed).not.toMatch(/Last prepared|Latest success|Most recent preparation/i);
    expect(failed).toContain('retained diagnostic context');
    expect(failed).toContain('href="/settings/logs?subsystem=social_preparation">Social Preparation Logs</a>');
  });

  it.each([
    ['pending', 'Preparation request pending'], ['starting', 'Starting'],
    ['preparing', 'Preparing'], ['uploading', 'Uploading'],
    ['auth_required', 'Authentication required'], ['prepared', 'Composer prepared for human submission'],
    ['failed', 'Preparation failed'], ['cancelled', 'Preparation cancelled'],
  ])('renders %s as a last recorded state, not a running process or publication outcome', async (state, label) => {
    target('x', state);
    const { section } = await detail();
    expect(section).toContain('Last recorded state');
    expect(section).toContain('These are last recorded states, not live progress.');
    expect(section).toContain('Preparation-request counts do not confirm that a browser or adapter ran.');
    expect(section).toContain(`>${label}</span>`);
    expect(section).not.toContain('First prepared');
    if (state === 'auth_required') expect(section).toContain('Sign-in is required for preparation.');
    if (['auth_required', 'failed'].includes(state)) {
      expect(section).toContain('retained diagnostic context');
      expect(section).toContain('href="/settings/logs?subsystem=social_preparation"');
    } else expect(section).not.toContain('/settings/logs');
  });

  it.each([true, false])('retains a saved removed platform without substituting Settings targets (enabled=%s)', async (enabled) => {
    target('patreon', 'prepared', 2, FIRST);
    settings.setPlatforms(['bluesky']);
    settings.setEnabled(enabled);
    const { section } = await detail();
    expect(section.match(/<article /g)).toHaveLength(1);
    expect(section).toContain('>Patreon</h3>');
    expect(section).not.toContain('>Bluesky</h3>');
    expect(section).toContain('Currently disabled or not configured in Settings.');
    expect(section).toContain('Composer prepared for human submission');
    expect(section).toContain(FIRST);
    expect(section.includes('Social Preparation is currently disabled.')).toBe(!enabled);
  });

  it('retains all historical platforms while globally disabled, separately from platform configuration', async () => {
    target('patreon', 'prepared', 1, FIRST);
    target('x', 'failed', 2);
    target('bluesky', 'cancelled', 1);
    settings.setEnabled(false);
    const { section } = await detail();
    expect(section.match(/<article /g)).toHaveLength(3);
    expect(section).toContain('Social Preparation is currently disabled.');
    expect(section).not.toContain('Currently disabled or not configured in Settings.');
    expect(section).toContain('Composer prepared for human submission');
    expect(section).toContain('Preparation failed');
    expect(section).toContain('Preparation cancelled');
  });

  it.each([false, true])('shows honest empty history despite current defaults (published=%s)', async (published) => {
    if (published) db.prepare("UPDATE releases SET published_date = '2025-01-01' WHERE id = ?").run(releaseId);
    const { section } = await detail();
    expect(section).toContain('No Social posts are saved for this release.');
    expect(section).not.toMatch(/<article|Not attempted|Last updated|First prepared|Preparation requests/);
    expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)).toEqual([]);
  });

  it.each(['release', 'parent'])('keeps preparation history read-only under an archived %s', async (archived) => {
    target('bluesky', 'failed', 2, FIRST);
    if (archived === 'release') db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(releaseId);
    else db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(projectId);
    const { html, section } = await detail();
    expect(html).toContain('read-only');
    expect(section).toContain('Preparation failed');
    expect(section).toContain(FIRST);
    expect(html).not.toContain('data-dialog-open="release-publish-dialog"');
  });

  it('performs no preparation service/token calls or database mutations on detail GET', async () => {
    target('x', 'prepared', 1, FIRST);
    const service = app.locals.socialPrepService;
    app.locals.socialPrepService = Object.fromEntries(Object.entries(service).map(([key, value]) => [
      key, typeof value === 'function' ? vi.fn(() => { throw new Error('Display must not call preparation service'); }) : value,
    ]));
    const serviceSpies = Object.values(app.locals.socialPrepService).filter(vi.isMockFunction);
    const tokenSpies = Object.values(socialTokens).filter(vi.isMockFunction);
    expect(serviceSpies.length).toBeGreaterThan(0);
    expect(tokenSpies.length).toBeGreaterThan(0);
    tokenSpies.forEach((spy) => spy.mockClear());
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    try {
      await detail();
      expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(before);
      [...serviceSpies, ...tokenSpies].forEach((spy) => expect(spy).not.toHaveBeenCalled());
    } finally {
      app.locals.socialPrepService = service;
    }
  });

  it('places Social Preparation after release details and leaves ordinary publication metadata and controls separate', async () => {
    target('x', 'prepared', 1, FIRST);
    const draft = await detail();
    expect(draft.html).toContain(`href="/releases/${releaseId}/publish" data-dialog-open="release-publish-dialog"`);
    expect(draft.html).toContain(`action="/releases/${releaseId}/publish"`);
    expect(draft.html.indexOf('<h2>Release details</h2>')).toBeLessThan(draft.html.indexOf(draft.section));
    expect(draft.html.indexOf(draft.section)).toBeLessThan(draft.html.indexOf('<h2>Selected Assets</h2>'));
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    const published = await detail();
    expect(published.section).toBe(draft.section);
    expect(published.html).toContain('<h2>Publication Summary</h2>');
    expect(published.html).toContain('2026-08-01 <small>(release published)</small>');
    expect(published.html).not.toContain('data-dialog-open="release-publish-dialog"');
  });
});
