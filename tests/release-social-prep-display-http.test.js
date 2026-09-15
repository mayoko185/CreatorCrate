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
  function target(platform, status = 'pending', attempts = 1, preparedAt = null, postedAt = null) {
    app.locals.socialPrepRepository.ensurePlatforms(releaseId, [platform]);
    db.prepare(`UPDATE release_social_platforms SET status = ?, attempts = ?,
      prepared_at = ?, posted_at = ?, updated_at = ?, message = ?, detail_code = ?
      WHERE release_id = ? AND platform = ?`).run(status, attempts, preparedAt, postedAt, UPDATED,
      'PRIVATE_MESSAGE token=PRIVATE_TOKEN C:\\PRIVATE_PATH creator=PRIVATE_CREATOR <script>PRIVATE_SCRIPT</script>',
      'PRIVATE_DETAIL_CODE', releaseId, platform);
  }

  async function detail({ allowPostedState = false } = {}) {
    const response = await agent.get(`/releases/${releaseId}`).expect(200);
    const section = response.text.match(/<section id="release-social-preparation"[\s\S]*?<\/section>/)?.[0];
    expect(section).toBeTruthy();
    expect(section).toContain('<h2 id="release-social-preparation-heading">Social Posts</h2>');
    expect(section).not.toMatch(/<h2\b[^>]*>Social Preparation<\/h2>/);
    expect(section).not.toContain('Preparation opens a composer for human submission. Prepared does not mean posted.');
    expect(section).not.toContain('Helper preparation actions are not available in this checkpoint.');
    expect(section).not.toMatch(/<form\b|<input\b|data-dialog/i);
    expect(response.text).not.toMatch(/PRIVATE_|openlocally:|creatorcrate-social:/i);
    // Preparation states must not claim publication or submission. The posting
    // aggregate and explicit confirmation wording are the only exceptions.
    let publicationNeutral = section
      .replace(/\d+ of \d+ platforms marked as posted\./gi, '')
      .replace(/All social posts marked as posted\./gi, '')
      .replace(/not marked as posted/gi, '');
    if (allowPostedState) publicationNeutral = publicationNeutral
      .replace(/Posted — confirmed by you/gi, '')
      .replace(/Posted confirmation/gi, '');
    expect(publicationNeutral).not.toMatch(/\b(posted|published|submitted|sent successfully)\b/i);
    expect(section).not.toMatch(/Full report|Complete diagnostic|Native report|Prepare again|Send to helper again/i);
    return { html: response.text, section };
  }

  function companionAction(section) {
    return section.match(/<span data-release-social-prep-companion[\s\S]*?<\/button>/)?.[0];
  }

  function companionActions(section) {
    return [...section.matchAll(/<span data-release-social-prep-companion[\s\S]*?<\/button>/g)]
      .map((match) => match[0]);
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
        expect(summary).not.toContain('<small>Social posts</small>');
        expect(summary).toContain('aria-label="Social posts"');
        expect(summary).not.toMatch(/Social targets|\(last recorded preparation\)/);
        expect(summary).not.toMatch(/<form\b|<button\b|<input\b|<a\b|data-dialog|data-social|\b(posted|published|submitted|live)\b|sent successfully|retry|reprepare|activate/i);
      }
      expect(html).toContain('href="/releases/new" data-dialog-open="release-create-dialog"');
      expect(html).toContain('aria-label="Releases defaults"');
      expect(html).toContain('aria-label="Reset filters"');
      expect(html).toContain('aria-label="Release list pages"');
      expect(html).toContain('class="table-scroll releases-table-scroll" tabindex="0" aria-label="Release list"');
      expect(html.match(/<thead>[\s\S]*?<\/thead>/)[0]).toContain('<th>Social Posts</th>');
      expect(html.match(/<thead>[\s\S]*?<\/thead>/)[0].match(/<th\b/g)).toHaveLength(7);
      expect(row.match(/<td\b/g)).toHaveLength(7);
      expect(row).toContain(`href="/releases/${releaseId}">Display release</a>`);
      const cells = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) || [];
      expect(cells[0]).not.toMatch(/release-social-prep-summary|Social posts/);
      if (summary) expect(cells[4]).toContain(summary);
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

    it('keeps the default visible label in the standalone Project detail summary', async () => {
      target('x', 'prepared');
      const { text: html } = await agent.get(`/projects/${projectId}`).expect(200);
      const summary = html.match(/<div class="release-social-prep-summary"[\s\S]*?<\/div>/)?.[0];
      expect(summary).toContain('<small>Social posts</small>');
      expect(summary).toContain('aria-label="Social posts"');
      expect(summary).toContain('>X · Prepared</span>');
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

  it.each([
    ['staging', 'Preparing for manual publishing'],
    ['ready', 'Ready for manual publishing — not marked as posted'],
  ])('renders compact %s wording without claiming social publication', async (state, label) => {
    target('x', state);
    const { text } = await agent.get('/releases').expect(200);
    const row = text.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)
      ?.find((candidate) => candidate.includes(`href="/releases/${releaseId}"`));
    const summary = row?.match(/<div class="release-social-prep-summary"[\s\S]*?<\/div>/)?.[0];
    expect(summary).toContain(`>X · ${label}</span>`);
    expect(summary.replace(/not marked as posted/gi, '')).not.toMatch(/\b(posted|published|submitted|sent successfully)\b/i);
  });

  it('renders compact posted confirmation wording', async () => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    target('x', 'posted', 1, null, FIRST);
    const { text } = await agent.get('/releases').expect(200);
    const row = text.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)
      ?.find((candidate) => candidate.includes(`href="/releases/${releaseId}"`));
    const summary = row?.match(/<div class="release-social-prep-summary"[\s\S]*?<\/div>/)?.[0];
    expect(summary).toContain('>X · Posted — confirmed by you</span>');
    const [action] = companionActions(summary);
    expect(action).toContain('data-target-platform="x"');
    expect(action).toContain('aria-label="Prepare another X post"');
    expect(action).toContain('>Prepare another post</button>');
  });

  it('renders independent posted-target actions in the shared summary on both release surfaces', async () => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    target('patreon', 'posted', 1, null, FIRST);
    target('x', 'posted', 1, null, UPDATED);
    target('bluesky', 'ready', 1);

    for (const url of ['/releases', `/projects/${projectId}`]) {
      const { text } = await agent.get(url).expect(200);
      const summary = text.match(/<div class="release-social-prep-summary"[\s\S]*?<\/div>/)?.[0];
      const actions = companionActions(summary);
      expect(actions).toHaveLength(2);
      expect(actions[0]).toMatch(/data-target-platform="patreon"[\s\S]*aria-label="Prepare another Patreon post"/);
      expect(actions[1]).toMatch(/data-target-platform="x"[\s\S]*aria-label="Prepare another X post"/);
      expect(summary).toContain('>Bluesky · Ready for manual publishing — not marked as posted</span>');
      expect(summary).not.toContain('data-target-platform="bluesky"');
    }
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
    ['staging', 'Preparing content and files for manual publishing'],
    ['ready', 'Ready for manual publishing — not marked as posted'],
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

  it('renders explicit posted confirmation, timestamp, and configured-platform aggregate without claiming release publication', async () => {
    target('patreon', 'posted', 1, null, FIRST);
    target('x', 'posted', 1, null, UPDATED);
    settings.setPlatforms(['patreon', 'x']);
    const { section } = await detail({ allowPostedState: true });
    expect(section).toContain('2 of 2 platforms marked as posted.');
    expect(section).toContain('All social posts marked as posted.');
    expect(platformSection(section, 'patreon')).toContain('Posted — confirmed by you');
    expect(platformSection(section, 'patreon')).toMatch(new RegExp(`<dt>Posted confirmation</dt>\\s*<dd>${FIRST}</dd>`));
    expect(section).not.toMatch(/Release published|release is published/i);
  });

  it('keeps all-posted completion visible while rendering one targeted action beside each platform', async () => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    target('patreon', 'posted', 1, null, FIRST);
    target('x', 'posted', 1, null, UPDATED);
    target('bluesky', 'posted', 1, null, FIRST);

    const { section } = await detail({ allowPostedState: true });
    expect(section).toContain('3 of 3 platforms marked as posted.');
    expect(section).toContain('All social posts marked as posted.');
    expect(companionActions(platformSection(section, 'patreon'))[0]).toContain('data-target-platform="patreon"');
    expect(companionActions(platformSection(section, 'x'))[0]).toContain('data-target-platform="x"');
    expect(companionActions(platformSection(section, 'bluesky'))[0]).toContain('data-target-platform="bluesky"');
    expect(companionActions(section).filter((action) => action.includes('Prepare another post'))).toHaveLength(3);
  });

  it('renders mixed posted actions only for configured posted targets and does not mutate on repeated GETs', async () => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    target('patreon', 'posted', 1, null, FIRST);
    target('x', 'failed', 2);
    target('bluesky', 'ready', 1);
    settings.setPlatforms(['patreon', 'bluesky']);
    const before = app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId);
    const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count;

    const first = await detail({ allowPostedState: true });
    const second = await detail({ allowPostedState: true });

    expect(companionActions(platformSection(first.section, 'patreon'))[0]).toContain('data-target-platform="patreon"');
    expect(platformSection(first.section, 'x')).not.toContain('Prepare another post');
    expect(platformSection(first.section, 'bluesky')).not.toContain('Prepare another post');
    expect(second.section).toContain(FIRST);
    expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(sessionCount);
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

  it('uses only read-only preparation policy and performs no token or database mutation on detail GET', async () => {
    target('x', 'prepared', 1, FIRST);
    const tokenSpies = Object.values(socialTokens).filter(vi.isMockFunction);
    expect(tokenSpies.length).toBeGreaterThan(0);
    tokenSpies.forEach((spy) => spy.mockClear());
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    await detail();
    expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    tokenSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it.each([
    ['pending', 'Open publishing companion', 'activate'],
    ['failed', 'Open publishing companion', 'activate'],
    ['cancelled', 'Open publishing companion', 'activate'],
    ['ready', 'Reopen publishing companion', 'reprepare'],
    ['prepared', 'Reopen publishing companion', 'reprepare'],
  ])('renders the server-selected %s action as %s', async (status, label, mode) => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    target('x', status, status === 'pending' ? 0 : 1, status === 'prepared' ? FIRST : null);
    const { section } = await detail();
    const action = companionAction(section);
    expect(action).toContain(`data-action-mode="${mode}"`);
    expect(action).toContain(`>${label}</button>`);
    expect(action).not.toContain('data-platform=');
    expect(action).not.toMatch(/creatorcrate-social:|intent=|data-activation-uri/i);
  });

  it.each([
    ['two ready targets', [['x', 'ready'], ['bluesky', 'ready']]],
    ['two legacy prepared targets', [['x', 'prepared'], ['bluesky', 'prepared']]],
    ['mixed completed targets', [['patreon', 'ready'], ['x', 'prepared'], ['bluesky', 'ready']]],
  ])('renders one release-level Reopen action for %s', async (_name, completedTargets) => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    for (const [platform, status] of completedTargets) {
      target(platform, status, 1, status === 'prepared' ? FIRST : null);
    }
    const { section } = await detail();
    const actions = section.match(/data-release-social-prep-companion-action/g) || [];
    expect(actions).toHaveLength(1);
    expect(companionAction(section)).toContain('data-action-mode="reprepare"');
    expect(companionAction(section)).toContain('>Reopen publishing companion</button>');
    expect(companionAction(section)).not.toContain('data-platform=');
  });

  it('renders exact-session Retry for issued unredeemed state without exposing a URI', async () => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    target('x', 'pending', 0);
    const issued = app.locals.socialPrepService.activate({
      releaseId, platforms: ['x'], intentHash: 'server-only-digest', expiresAt: new Date(Date.now() + 60_000),
    });
    const { section } = await detail();
    const action = companionAction(section);
    expect(action).toContain('data-action-mode="reissue"');
    expect(action).toContain(`data-session-id="${issued.session.id}"`);
    expect(action).toContain('>Retry opening companion</button>');
    expect(action).not.toMatch(/server-only-digest|creatorcrate-social:|intent=/i);
  });

  it('suppresses the action for a redeemed active staging attempt', async () => {
    db.prepare("UPDATE releases SET published_date = '2026-08-01' WHERE id = ?").run(releaseId);
    target('x', 'pending', 0);
    const issued = app.locals.socialPrepService.activate({
      releaseId, platforms: ['x'], intentHash: 'intent-hash', expiresAt: new Date(Date.now() + 60_000),
    });
    app.locals.socialPrepService.redeem({ sessionId: issued.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    app.locals.socialPrepService.recordPlatformStatus({ releaseId, platform: 'x', sessionId: issued.session.id, status: 'staging' });
    const { section } = await detail();
    expect(companionAction(section)).toBeUndefined();
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
    expect(companionAction(draft.section)).toBeUndefined();
    expect(companionAction(published.section)).toContain('Reopen publishing companion');
    expect(published.html).toContain('<h2>Publication Summary</h2>');
    expect(published.html).toContain('2026-08-01 <small>(release published)</small>');
    expect(published.html).not.toContain('data-dialog-open="release-publish-dialog"');
  });
});
