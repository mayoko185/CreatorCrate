import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createSocialPrepRepository } from '../src/data/social-prep-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { digestToken, generateIntentToken } from '../src/services/social-prep-tokens.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function postChunkedEntity(app, url, authorization) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const clientRequest = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: url,
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' },
      }, (response) => {
        response.resume();
        response.once('end', () => server.close(() => resolve(response)));
      });
      clientRequest.once('error', (error) => server.close(() => reject(error)));
      clientRequest.write('posted');
      clientRequest.end();
    });
    server.once('error', reject);
  });
}

describe('manual social posting confirmation HTTP', () => {
  let app;
  let db;
  let repository;
  let releaseId;
  let tmpDir;
  let clock;
  let nextSession;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-posted-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const projectId = Number(db.prepare(`INSERT INTO projects
      (title, slug, project_dir, description, notes, status, project_type, patreon_url)
      VALUES ('Project', 'project', 'project-dir', '', '', 'tbd', 'images', NULL)`).run().lastInsertRowid);
    releaseId = Number(db.prepare(`INSERT INTO releases
      (project_id, title, description, notes, published_date)
      VALUES (?, 'Title', 'Public body', 'Private notes', '2030-01-01')`).run(projectId).lastInsertRowid);
    clock = new Date('2030-01-01T00:00:00Z');
    nextSession = 1;
    repository = createSocialPrepRepository(db);
    vi.spyOn(repository, 'markPlatformPostedIfReady');
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot: path.join(tmpDir, 'projects') },
      { socialPrepRepository: repository, now: () => clock },
    );
    app.locals.socialPrepSettingsService.setPlatforms(['patreon', 'x', 'bluesky']);
    app.locals.socialPrepSettingsService.setEnabled(true);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createReadyAttempt(platforms = ['x']) {
    const id = `session-${nextSession++}`;
    const token = generateIntentToken();
    repository.insertSession({
      id, releaseId, kind: 'initial', intentHash: `intent-${id}`,
      expiresAt: new Date('2030-01-01T01:00:00Z'), now: clock,
    });
    repository.ensurePlatforms(releaseId, platforms, { now: clock });
    repository.reassignPlatformsToSession(id, platforms, { now: clock });
    app.locals.socialPrepService.redeem({
      sessionId: id, intentHash: `intent-${id}`, mediaTokenHash: digestToken(token),
    });
    for (const platform of platforms) {
      app.locals.socialPrepService.recordPlatformStatus({ releaseId, platform, sessionId: id, status: 'staging' });
      app.locals.socialPrepService.recordPlatformStatus({ releaseId, platform, sessionId: id, status: 'ready' });
    }
    return { id, token, authorization: `Bearer ${token}` };
  }

  it('confirms a finished manual session idempotently and reconciles canonical aggregate state', async () => {
    const attempt = createReadyAttempt(['x', 'bluesky']);
    const storedSession = repository.findSessionById(attempt.id);
    expect(storedSession.state).toBe('finished');
    expect((new Date(`${storedSession.manual_confirmation_expires_at.replace(' ', 'T')}Z`).getTime()
      - new Date(`${storedSession.redeemed_at.replace(' ', 'T')}Z`).getTime()) / 3_600_000).toBe(24);

    clock = new Date('2030-01-01T00:10:00Z');
    const first = await request(app).post(`/social-prep/${attempt.id}/platforms/x/posted`)
      .set('Authorization', attempt.authorization).expect(200);
    expect(first.body).toEqual({
      ok: true, sessionId: attempt.id, platform: 'x', status: 'posted',
      postedAt: '2030-01-01 00:10:00',
      completion: { postedCount: 1, totalCount: 2, isComplete: false },
    });

    clock = new Date('2030-01-01T00:20:00Z');
    const retry = await request(app).post(`/social-prep/${attempt.id}/platforms/x/posted`)
      .set('Authorization', attempt.authorization).expect(200);
    expect(retry.body).toEqual(first.body);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').posted_at)
      .toBe('2030-01-01 00:10:00');
    const readback = await request(app).get(`/social-prep/${attempt.id}/platforms/x/posted`)
      .set('Authorization', attempt.authorization).expect(200);
    expect(readback.body).toEqual(first.body);

    const second = await request(app).post(`/social-prep/${attempt.id}/platforms/bluesky/posted`)
      .set('Authorization', attempt.authorization).expect(200);
    expect(second.body.completion).toEqual({ postedCount: 2, totalCount: 2, isComplete: true });

    await request(app).get(`/social-prep/${attempt.id}/status`).set('Authorization', attempt.authorization).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('attempt_finished'));
    await request(app).patch(`/social-prep/${attempt.id}/platforms/bluesky`).set('Authorization', attempt.authorization)
      .send({ status: 'failed' }).expect(409);
    await request(app).get(`/social-prep/${attempt.id}/assets/1`).set('Authorization', attempt.authorization).expect(409);
  });

  it('reports completion for one selected target while retaining deselected posted history', async () => {
    const attempt = createReadyAttempt(['x']);
    repository.ensurePlatforms(releaseId, ['patreon'], { now: clock });
    db.prepare("UPDATE release_social_platforms SET status = 'posted', posted_at = '2030-01-01 00:05:00' WHERE release_id = ? AND platform = 'patreon'").run(releaseId);
    repository.replaceSelectedPlatforms(releaseId, ['x']);

    const response = await request(app).post(`/social-prep/${attempt.id}/platforms/x/posted`)
      .set('Authorization', attempt.authorization).expect(200);
    expect(response.body.completion).toEqual({ postedCount: 1, totalCount: 1, isComplete: true });
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'patreon'))
      .toMatchObject({ is_selected: 0, status: 'posted' });
  });

  it('rejects a ready platform deselected after confirmation eligibility was read', async () => {
    const attempt = createReadyAttempt();
    const url = `/social-prep/${attempt.id}/platforms/x/posted`;
    await request(app).get(url).set('Authorization', attempt.authorization).expect(200);

    repository.replaceSelectedPlatforms(releaseId, ['bluesky']);
    const historical = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x');
    expect(historical).toMatchObject({ is_selected: 0, status: 'ready', session_id: attempt.id });

    for (const method of ['get', 'post']) {
      await request(app)[method](url).set('Authorization', attempt.authorization).expect(409)
        .expect(({ body }) => expect(body.error.code).toBe('confirmation_conflict'));
    }

    expect(repository.markPlatformPostedIfReady).not.toHaveBeenCalled();
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toEqual(historical);
  });

  it('accepts only a request with no entity body', async () => {
    const accepted = createReadyAttempt(['x']);
    const acceptedUrl = `/social-prep/${accepted.id}/platforms/x/posted`;
    await request(app).post(acceptedUrl).set('Authorization', accepted.authorization).expect(200);

    const zeroLength = createReadyAttempt(['bluesky']);
    const zeroLengthUrl = `/social-prep/${zeroLength.id}/platforms/bluesky/posted`;
    await request(app).post(zeroLengthUrl).set('Authorization', zeroLength.authorization)
      .set('Content-Length', '0').expect(200);
  });

  it.each([
    ['empty JSON object', 'application/json', {}],
    ['non-empty JSON', 'application/json', { status: 'posted' }],
    ['URL-encoded data', 'application/x-www-form-urlencoded', 'status=posted'],
    ['plain text', 'text/plain', 'posted'],
    ['binary data', 'application/octet-stream', Buffer.from([0x00, 0x01, 0x02])],
    ['positive Content-Length with an unsupported content type', 'application/x-creatorcrate-test', 'posted'],
  ])('rejects %s without calling or committing confirmation', async (_label, contentType, entity) => {
    const attempt = createReadyAttempt();
    const url = `/social-prep/${attempt.id}/platforms/x/posted`;
    repository.markPlatformPostedIfReady.mockClear();

    await request(app).post(url).set('Authorization', attempt.authorization)
      .set('Content-Type', contentType).send(entity).expect(422);

    expect(repository.markPlatformPostedIfReady).not.toHaveBeenCalled();
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ status: 'ready', posted_at: null });
  });

  it('rejects chunked entity framing without calling or committing confirmation', async () => {
    const attempt = createReadyAttempt();
    const url = `/social-prep/${attempt.id}/platforms/x/posted`;
    repository.markPlatformPostedIfReady.mockClear();

    const response = await postChunkedEntity(app, url, attempt.authorization);
    expect(response.statusCode).toBe(422);

    expect(repository.markPlatformPostedIfReady).not.toHaveBeenCalled();
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ status: 'ready', posted_at: null });
  });

  it('rejects caller-controlled fields, wrong ownership, expired authority, and superseded sessions', async () => {
    const attempt = createReadyAttempt();
    const url = `/social-prep/${attempt.id}/platforms/x/posted`;
    await request(app).post(url).set('Authorization', attempt.authorization)
      .send({ releaseId, status: 'posted', postedAt: '1999-01-01 00:00:00' }).expect(422);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').status).toBe('ready');

    await request(app).post(`/social-prep/${attempt.id}/platforms/bluesky/posted`)
      .set('Authorization', attempt.authorization).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('confirmation_target_not_owned'));
    await request(app).post('/social-prep/missing/platforms/x/posted')
      .set('Authorization', attempt.authorization).expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('confirmation_token_invalid'));

    db.prepare("UPDATE social_prep_sessions SET manual_confirmation_expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(attempt.id);
    await request(app).post(url).set('Authorization', attempt.authorization).expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('confirmation_token_expired'));

    db.prepare("UPDATE social_prep_sessions SET manual_confirmation_expires_at = '2030-01-02 00:00:00', state = 'superseded' WHERE id = ?").run(attempt.id);
    await request(app).post(url).set('Authorization', attempt.authorization).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('attempt_superseded'));
  });

  it('serializes duplicate confirmations around one original server timestamp', async () => {
    const attempt = createReadyAttempt();
    const url = `/social-prep/${attempt.id}/platforms/x/posted`;
    clock = new Date('2030-01-01T00:20:00Z');
    const [left, right] = await Promise.all([
      request(app).post(url).set('Authorization', attempt.authorization),
      request(app).post(url).set('Authorization', attempt.authorization),
    ]);
    expect([left.status, right.status]).toEqual([200, 200]);
    expect(left.body.postedAt).toBe('2030-01-01 00:20:00');
    expect(right.body).toEqual(left.body);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ status: 'posted', posted_at: left.body.postedAt });
  });
});
