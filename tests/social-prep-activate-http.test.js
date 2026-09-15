import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { AUTH_CONFIG, authenticate } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Social Preparation activation HTTP', () => {
  let app;
  let agent;
  let csrfToken;
  let db;
  let releaseId;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-activate-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const projectId = Number(db.prepare(
      "INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url) VALUES ('Project', 'project', '', '', 'tbd', 'images', NULL)"
    ).run().lastInsertRowid);
    releaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, planned_date, published_date) VALUES (?, 'Release title', 'Release body', 'Private release Notes', '2026-07-15', '2026-08-01')"
    ).run(projectId).lastInsertRowid);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { authConfig: AUTH_CONFIG });
    app.locals.socialPrepSettingsService.setEnabled(true);
    app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    app.locals.socialPrepRepository.ensurePlatforms(releaseId, ['x', 'bluesky']);
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function activate(body) {
    return agent.post(`/releases/${releaseId}/social-prep/activate`)
      .set('X-CSRF-Token', csrfToken)
      .send(body);
  }

  function reissue(sessionId) {
    return agent.post(`/releases/${releaseId}/social-prep/reissue`)
      .set('X-CSRF-Token', csrfToken)
      .send({ sessionId });
  }

  it('requires browser authentication and CSRF, persists only a digest, and returns a minimal fresh URI', async () => {
    await agent.post(`/releases/${releaseId}/social-prep/activate`).send({ platforms: ['x'] }).expect(403);
    const first = await activate({ platforms: ['x'] }).expect(200);
    expect(first.body).toMatchObject({ ok: true, platforms: ['x'] });
    const uri = new URL(first.body.uri);
    const intent = uri.searchParams.get('intent');
    expect(uri.protocol).toBe('creatorcrate-social:');
    expect([...uri.searchParams.keys()].sort()).toEqual(['intent', 'server', 'v']);
    expect(intent).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.uri).not.toContain('Release title');
    expect(uri.searchParams.get('v')).toBe('2');
    const stored = db.prepare('SELECT intent_hash FROM social_prep_sessions WHERE id = ?').get(first.body.sessionId);
    expect(stored.intent_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.intent_hash).not.toBe(intent);
    expect((await agent.get(`/releases/${releaseId}`).expect(200)).text).not.toContain(intent);

    db.prepare("UPDATE social_prep_sessions SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(first.body.sessionId);
    const second = await activate({ platforms: ['x'] }).expect(200);
    expect(new URL(second.body.uri).searchParams.get('intent')).not.toBe(intent);
  });

  it('lets the publication handoff activate all server-authoritative pending targets without publication side effects', async () => {
    const releaseBefore = db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId);
    const publicationEventsBefore = app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published').length;

    const response = await activate({}).expect(200);

    expect(response.body).toMatchObject({ ok: true, platforms: ['bluesky', 'x'] });
    const uri = new URL(response.body.uri);
    expect(uri.protocol).toBe('creatorcrate-social:');
    expect(uri.searchParams.get('v')).toBe('2');
    expect(db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId)).toEqual(releaseBefore);
    expect(app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published')).toHaveLength(publicationEventsBefore);
  });

  it('atomically expires an unredeemed issued intent and returns a fresh replacement without publication side effects', async () => {
    const first = await activate({ platforms: ['x'] }).expect(200);
    const oldIntent = new URL(first.body.uri).searchParams.get('intent');
    const releaseBefore = db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId);
    const publicationEventsBefore = app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published').length;

    const replacement = await reissue(first.body.sessionId).expect(200);
    const newIntent = new URL(replacement.body.uri).searchParams.get('intent');

    expect(replacement.body).toMatchObject({ ok: true, platforms: ['x'] });
    expect(replacement.body.sessionId).not.toBe(first.body.sessionId);
    expect(newIntent).not.toBe(oldIntent);
    expect(db.prepare('SELECT state FROM social_prep_sessions WHERE id = ?').get(first.body.sessionId).state).toBe('expired');
    expect(db.prepare('SELECT kind, state FROM social_prep_sessions WHERE id = ?').get(replacement.body.sessionId))
      .toEqual({ kind: 'retry', state: 'issued' });
    await request(app).post('/social-prep/redeem').send({ intent: oldIntent }).expect(401);
    await request(app).post('/social-prep/redeem').send({ intent: newIntent }).expect(200);
    expect(db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId)).toEqual(releaseBefore);
    expect(app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published')).toHaveLength(publicationEventsBefore);
  });

  it('requires browser authentication and CSRF for reissue', async () => {
    const first = await activate({ platforms: ['x'] }).expect(200);
    await request(app).post(`/releases/${releaseId}/social-prep/reissue`).send({ sessionId: first.body.sessionId }).expect(401);
    await agent.post(`/releases/${releaseId}/social-prep/reissue`).send({ sessionId: first.body.sessionId }).expect(403);
    await reissue(first.body.sessionId).expect(200);
  });

  it('refuses redeemed and staging attempts without invalidating their capability', async () => {
    const first = await activate({ platforms: ['x'] }).expect(200);
    const intent = new URL(first.body.uri).searchParams.get('intent');
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);

    const refusedRedeemed = await reissue(first.body.sessionId).expect(409);
    expect(refusedRedeemed.body.error.code).toBe('attempt_not_reissuable');
    await request(app).patch(`/social-prep/${first.body.sessionId}/platforms/x`)
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .send({ status: 'staging' }).expect(200);
    const refusedStaging = await reissue(first.body.sessionId).expect(409);
    expect(refusedStaging.body.error.code).toBe('attempt_not_reissuable');
    expect(db.prepare('SELECT state FROM social_prep_sessions WHERE id = ?').get(first.body.sessionId).state).toBe('redeemed');
  });

  it('serializes double reissue so only one replacement intent remains usable', async () => {
    const first = await activate({ platforms: ['x'] }).expect(200);
    const [left, right] = await Promise.all([reissue(first.body.sessionId), reissue(first.body.sessionId)]);
    const responses = [left, right];
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.status === 200);
    const loser = responses.find((response) => response.status === 409);
    expect(loser.body.error.code).toBe('attempt_not_reissuable');
    const intent = new URL(winner.body.uri).searchParams.get('intent');
    await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM social_prep_sessions WHERE release_id = ? AND state IN ('issued', 'redeemed')").get(releaseId).count).toBe(1);
  });

  it('gives redemption and cancellation exactly one winner', async () => {
    const first = await activate({ platforms: ['x'] }).expect(200);
    const oldIntent = new URL(first.body.uri).searchParams.get('intent');
    const [redeemResponse, reissueResponse] = await Promise.all([
      request(app).post('/social-prep/redeem').send({ intent: oldIntent }),
      reissue(first.body.sessionId),
    ]);

    expect([[200, 409], [401, 200]])
      .toContainEqual([redeemResponse.status, reissueResponse.status]);
    if (redeemResponse.status === 200) {
      expect(reissueResponse.status).toBe(409);
      expect(db.prepare('SELECT state FROM social_prep_sessions WHERE id = ?').get(first.body.sessionId).state).toBe('redeemed');
    } else {
      expect(redeemResponse.status).toBe(401);
      expect(reissueResponse.status).toBe(200);
      expect(db.prepare('SELECT state FROM social_prep_sessions WHERE id = ?').get(first.body.sessionId).state).toBe('expired');
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM social_prep_sessions WHERE release_id = ? AND state IN ('issued', 'redeemed')").get(releaseId).count).toBe(1);
  });

  it('preserves the published-release validation contract', async () => {
    db.prepare('UPDATE releases SET published_date = NULL WHERE id = ?').run(releaseId);
    const invalid = await activate({}).expect(422);
    expect(invalid.body.error).toEqual({
      code: 'validation_failed',
      message: 'Social Preparation validation failed',
      issues: [{ code: 'release_not_published', severity: 'blocking' }],
    });
  });

  it('maps disabled activation to the stable error without creating a helper attempt', async () => {
    app.locals.socialPrepSettingsService.setEnabled(false);
    const releaseBefore = db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId);
    const publicationEventsBefore = app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published').length;

    const response = await activate({ platforms: ['x'] }).expect(422);

    expect(response.body.error.code).toBe('social_prep_disabled');
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_session_assets').get().count).toBe(0);
    expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId).every((row) => row.attempts === 0)).toBe(true);
    expect(db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId)).toEqual(releaseBefore);
    expect(app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published')).toHaveLength(publicationEventsBefore);
  });

  it.each([
    ['one completed target', [['x', 'ready']], ['x']],
    ['two ready targets', [['x', 'ready'], ['bluesky', 'ready']], ['bluesky', 'x']],
    ['two legacy prepared targets', [['x', 'prepared'], ['bluesky', 'prepared']], ['bluesky', 'x']],
    ['mixed ready and prepared targets', [['x', 'prepared'], ['bluesky', 'ready']], ['bluesky', 'x']],
    ['three completed targets', [['patreon', 'ready'], ['x', 'prepared'], ['bluesky', 'ready']], ['bluesky', 'patreon', 'x']],
  ])('reopens %s in one fresh attempt without republishing the release', async (_name, completedTargets, expectedPlatforms) => {
    const requestedPlatforms = completedTargets.map(([platform]) => platform);
    if (requestedPlatforms.includes('patreon')) {
      app.locals.socialPrepSettingsService.setPlatforms(['patreon', 'x', 'bluesky']);
      app.locals.socialPrepRepository.ensurePlatforms(releaseId, ['patreon']);
    }
    const update = db.prepare(`UPDATE release_social_platforms
      SET status = ?, attempts = 1, prepared_at = ?, updated_at = '2026-08-02 00:00:00'
      WHERE release_id = ? AND platform = ?`);
    for (const [platform, status] of completedTargets) {
      update.run(status, status === 'prepared' ? '2026-08-02 00:00:00' : null, releaseId, platform);
    }
    const releaseBefore = db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId);
    const publicationEventsBefore = app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published').length;

    const response = await activate({ reprepare: true }).expect(200);

    expect(response.body).toMatchObject({ ok: true, platforms: expectedPlatforms });
    const uri = new URL(response.body.uri);
    expect(uri.protocol).toBe('creatorcrate-social:');
    expect(uri.searchParams.get('v')).toBe('2');
    expect(uri.searchParams.get('intent')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.prepare('SELECT kind, state, media_token_hash FROM social_prep_sessions WHERE id = ?').get(response.body.sessionId))
      .toEqual({ kind: 'reprepare', state: 'issued', media_token_hash: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions WHERE release_id = ?').get(releaseId).count).toBe(1);
    expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)
      .filter((row) => expectedPlatforms.includes(row.platform))
      .map((row) => ({ platform: row.platform, sessionId: row.session_id, status: row.status, attempts: row.attempts })))
      .toEqual(expectedPlatforms.map((platform) => ({ platform, sessionId: response.body.sessionId, status: 'pending', attempts: 2 })));
    expect(db.prepare('SELECT planned_date, published_date FROM releases WHERE id = ?').get(releaseId)).toEqual(releaseBefore);
    expect(app.locals.applicationLogRepository.findPage({ subsystem: 'releases' })
      .filter((entry) => entry.event === 'release.published')).toHaveLength(publicationEventsBefore);
  });

  it('reprepares only the explicitly submitted posted target and invalidates its old confirmation authority', async () => {
    const first = await activate({ platforms: ['x', 'bluesky'] }).expect(200);
    const oldIntent = new URL(first.body.uri).searchParams.get('intent');
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent: oldIntent }).expect(200);
    const authorization = `Bearer ${redeemed.body.mediaToken}`;
    for (const platform of ['x', 'bluesky']) {
      await request(app).patch(`/social-prep/${first.body.sessionId}/platforms/${platform}`)
        .set('Authorization', authorization).send({ status: 'staging' }).expect(200);
      await request(app).patch(`/social-prep/${first.body.sessionId}/platforms/${platform}`)
        .set('Authorization', authorization).send({ status: 'ready' }).expect(200);
      await request(app).post(`/social-prep/${first.body.sessionId}/platforms/${platform}/posted`)
        .set('Authorization', authorization).expect(200);
    }
    const before = Object.fromEntries(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)
      .map((row) => [row.platform, row]));
    expect(app.locals.socialPrepService.getPostingCompletion(releaseId))
      .toEqual({ postedCount: 2, totalCount: 2, isComplete: true });

    const response = await activate({ platforms: ['x'], reprepare: true }).expect(200);

    expect(response.body).toMatchObject({ ok: true, platforms: ['x'] });
    const after = Object.fromEntries(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)
      .map((row) => [row.platform, row]));
    expect(after.x).toMatchObject({ status: 'pending', posted_at: null, session_id: response.body.sessionId, attempts: 2 });
    expect(after.bluesky).toMatchObject({
      status: 'posted', posted_at: before.bluesky.posted_at, session_id: first.body.sessionId, attempts: 1,
    });
    expect(app.locals.socialPrepService.getPostingCompletion(releaseId))
      .toEqual({ postedCount: 1, totalCount: 2, isComplete: false });
    await request(app).post(`/social-prep/${first.body.sessionId}/platforms/x/posted`)
      .set('Authorization', authorization).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('confirmation_target_not_owned'));
  });
});
