import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { digestToken, generateIntentToken } from '../src/services/social-prep-tokens.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Social Preparation status capability HTTP', () => {
  let app;
  let db;
  let repository;
  let projectId;
  let releaseId;
  let tmpDir;
  let nextSession = 1;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-status-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectId = Number(db.prepare(
      "INSERT INTO projects (title, slug, project_dir, description, notes, status, patreon_url) VALUES ('Project', 'project', 'project-dir', '', '', 'tbd', NULL)"
    ).run().lastInsertRowid);
    releaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, published_date) VALUES (?, 'Title', 'Public body', 'Private Notes', '2026-08-01')"
    ).run(projectId).lastInsertRowid);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
    repository = app.locals.socialPrepRepository;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRedeemedAttempt(platforms = ['x']) {
    const id = `session-${nextSession++}`;
    const mediaToken = generateIntentToken();
    repository.insertSession({
      id, releaseId, kind: 'initial', intentHash: `intent-${id}`,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    repository.ensurePlatforms(releaseId, platforms);
    repository.reassignPlatformsToSession(id, platforms);
    app.locals.socialPrepService.redeem({
      sessionId: id,
      intentHash: `intent-${id}`,
      mediaTokenHash: digestToken(mediaToken),
    });
    return { id, authorization: `Bearer ${mediaToken}` };
  }

  function platformRow(platform) {
    return repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === platform);
  }

  it('keeps bearer authentication and state disclosure ordering on both endpoints', async () => {
    const attempt = createRedeemedAttempt();

    await request(app).get(`/social-prep/${attempt.id}/status`).expect(401).expect(({ body }) => {
      expect(body.error.code).toBe('media_token_missing');
    });
    await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', 'Basic x').send({ status: 'preparing' }).expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('media_token_malformed'));
    await request(app).get(`/social-prep/${attempt.id}/status`).set('Authorization', `Bearer ${generateIntentToken()}`).expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('media_token_invalid'));
    await request(app).get('/social-prep/missing/status').set('Authorization', `Bearer ${generateIntentToken()}`).expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('media_token_invalid'));

    db.prepare("UPDATE social_prep_sessions SET attempt_deadline_at = '2000-01-01 00:00:00' WHERE id = ?").run(attempt.id);
    await request(app).get(`/social-prep/${attempt.id}/status`).set('Authorization', attempt.authorization).expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('media_token_expired'));
    repository.supersedeSession(attempt.id);

    const superseded = createRedeemedAttempt(['superseded']);
    repository.supersedeSession(superseded.id);
    await request(app).patch(`/social-prep/${superseded.id}/platforms/superseded`).set('Authorization', `Bearer ${generateIntentToken()}`).send({ status: 'preparing' }).expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('media_token_invalid'));
    await request(app).get(`/social-prep/${superseded.id}/status`).set('Authorization', superseded.authorization).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('attempt_superseded'));
  });

  it('returns only active owned status state without probe mutations', async () => {
    const attempt = createRedeemedAttempt(['x', 'bluesky']);
    const beforeSession = repository.findSessionById(attempt.id);
    const beforePlatforms = repository.listPlatformsByReleaseId(releaseId);

    const response = await request(app).get(`/social-prep/${attempt.id}/status`).set('Authorization', attempt.authorization).expect(200);

    expect(response.body).toEqual({
      ok: true,
      sessionId: attempt.id,
      state: 'redeemed',
      attemptDeadlineAt: beforeSession.attempt_deadline_at,
      platforms: beforePlatforms.filter((row) => row.session_id === attempt.id).map((row) => ({
        platform: row.platform,
        status: row.status,
        detailCode: row.detail_code,
        attempts: row.attempts,
        preparedAt: row.prepared_at,
      })),
    });
    expect(JSON.stringify(response.body)).not.toContain('Private Notes');
    expect(JSON.stringify(response.body)).not.toContain('Public body');
    expect(repository.findSessionById(attempt.id)).toEqual(beforeSession);
    expect(repository.listPlatformsByReleaseId(releaseId)).toEqual(beforePlatforms);
  });

  it('accepts only preparation statuses and records owned platform activity without changing attempts', async () => {
    const attempt = createRedeemedAttempt(['x', 'bluesky']);
    db.prepare("UPDATE release_social_platforms SET updated_at = '2000-01-01 00:00:00' WHERE release_id = ? AND platform = 'x'").run(releaseId);

    for (const status of ['pending', 'starting', 'preparing', 'uploading']) {
      await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization).send({ status }).expect(200);
    }
    const prepared = await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization)
      .send({ status: 'prepared', detailCode: null, message: null }).expect(200);
    const firstPreparedAt = prepared.body.platform.preparedAt;
    await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization).send({ status: 'uploading' }).expect(200);
    const repeated = await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization).send({ status: 'prepared' }).expect(200);

    expect(firstPreparedAt).toBeTruthy();
    expect(repeated.body.platform.preparedAt).toBe(firstPreparedAt);
    expect(platformRow('x')).toMatchObject({ attempts: 1, status: 'prepared', prepared_at: firstPreparedAt });
    expect(platformRow('x').updated_at).not.toBe('2000-01-01 00:00:00');

    for (const status of ['posted', 'submitted', 'unknown']) {
      await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization).send({ status }).expect(422);
    }
  });

  it('rejects absent or reassigned platform rows without extending their activity', async () => {
    const attempt = createRedeemedAttempt(['x']);
    const absent = await request(app).patch(`/social-prep/${attempt.id}/platforms/missing`).set('Authorization', attempt.authorization)
      .send({ status: 'preparing' }).expect(404);
    expect(absent.body.error.code).toBe('platform_not_in_release');

    repository.insertSession({
      id: 'newer-session', releaseId, kind: 'retry', state: 'finished', intentHash: 'newer-intent',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    repository.reassignPlatformsToSession('newer-session', ['x']);
    const before = platformRow('x');
    const stale = await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization)
      .send({ status: 'failed' }).expect(409);

    expect(stale.body.error.code).toBe('attempt_superseded');
    expect(platformRow('x')).toEqual(before);
  });

  it('atomically finishes sessions after each terminal status and excludes rows assigned to a newer session', async () => {
    for (const status of ['prepared', 'failed', 'auth_required', 'cancelled']) {
      const platform = `terminal-${status}`;
      const attempt = createRedeemedAttempt([platform]);
      await request(app).patch(`/social-prep/${attempt.id}/platforms/${platform}`).set('Authorization', attempt.authorization)
        .send({ status }).expect(200);
      expect(repository.findSessionById(attempt.id).state).toBe('finished');
    }

    const attempt = createRedeemedAttempt(['old-owned', 'newer-owned']);
    repository.insertSession({
      id: 'newer-owner', releaseId, kind: 'retry', state: 'finished', intentHash: 'newer-owner-intent',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    repository.reassignPlatformsToSession('newer-owner', ['newer-owned']);
    await request(app).patch(`/social-prep/${attempt.id}/platforms/old-owned`).set('Authorization', attempt.authorization)
      .send({ status: 'prepared' }).expect(200);

    expect(repository.findSessionById(attempt.id).state).toBe('finished');
    expect(platformRow('newer-owned')).toMatchObject({ session_id: 'newer-owner', status: 'pending' });
  });

  it('rejects late calls to a finished session before any further mutation', async () => {
    const attempt = createRedeemedAttempt();
    await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization).send({ status: 'prepared' }).expect(200);
    const before = platformRow('x');

    await request(app).get(`/social-prep/${attempt.id}/status`).set('Authorization', attempt.authorization).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('attempt_finished'));
    await request(app).patch(`/social-prep/${attempt.id}/platforms/x`).set('Authorization', attempt.authorization).send({ status: 'prepared' }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('attempt_finished'));
    expect(platformRow('x')).toEqual(before);
  });
});
