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

describe('Social Preparation capability HTTP', () => {
  let app;
  let db;
  let repository;
  let projectId;
  let releaseId;
  let intent;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-redeem-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectId = Number(db.prepare(
      "INSERT INTO projects (title, slug, project_dir, description, notes, status, patreon_url) VALUES ('Project', 'project', 'project-dir', '', '', 'tbd', NULL)"
    ).run().lastInsertRowid);
    releaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, published_date) VALUES (?, 'Snapshot title', 'Snapshot body', 'Private Notes', '2026-08-01')"
    ).run(projectId).lastInsertRowid);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
    repository = app.locals.socialPrepRepository;
    app.locals.openLocallySettingsService.setWindowsProjectsPath('D:\\Projects');
    intent = generateIntentToken();
    repository.insertSession({
      id: 'session-1', releaseId, kind: 'initial', intentHash: digestToken(intent),
      expiresAt: new Date('2030-01-01T00:00:00.000Z'), now: new Date('2029-12-31T23:59:00.000Z'),
    });
    repository.ensurePlatforms(releaseId, ['patreon']);
    repository.reassignPlatformsToSession('session-1', ['patreon']);
    repository.insertSessionAsset({
      sessionId: 'session-1', assetId: 2, projectId, role: 'attachment', sortOrder: 0,
      relativePath: 'final/second.png', filename: 'second.png', extension: '.png', mimeType: 'image/png', sizeBytes: 2, isPresent: true,
    });
    repository.insertSessionAsset({
      sessionId: 'session-1', assetId: 1, projectId, role: 'primary', sortOrder: 1,
      relativePath: 'final/first.png', filename: 'first.png', extension: '.png', mimeType: 'image/png', sizeBytes: 1, isPresent: true,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bypasses browser session and CSRF, redeems once, and returns only snapshot-derived helper data', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    expect(redeemed.headers['set-cookie']).toBeUndefined();
    expect(redeemed.body).toMatchObject({ ok: true, sessionId: 'session-1' });
    expect(redeemed.body.mediaToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(redeemed.body)).not.toContain('Private Notes');
    expect(redeemed.body.platforms).toMatchObject([{
      platform: 'patreon', title: 'Snapshot title', body: 'Snapshot body',
      assets: [
        { assetId: 2, filename: 'second.png', windowsPath: 'D:\\Projects\\project-dir\\final/second.png' },
        { assetId: 1, filename: 'first.png', windowsPath: 'D:\\Projects\\project-dir\\final/first.png' },
      ],
    }]);
    const stored = db.prepare('SELECT media_token_hash FROM social_prep_sessions WHERE id = ?').get('session-1');
    expect(stored.media_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.media_token_hash).not.toBe(redeemed.body.mediaToken);

    const replay = await request(app).post('/social-prep/redeem').send({ intent }).expect(401);
    const malformed = await request(app).post('/social-prep/redeem').send({ intent: 'invalid' }).expect(401);
    expect(replay.body).toEqual(malformed.body);
  });

  it('keeps wrong-token and unknown-session media failures indistinguishable before session state disclosure', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const url = '/social-prep/session-1/assets/1';
    const missing = await request(app).get(url).expect(401);
    const malformed = await request(app).get(url).set('Authorization', 'Basic ignored').expect(401);
    const wrong = await request(app).get(url).set('Authorization', `Bearer ${generateIntentToken()}`).expect(403);
    const unknown = await request(app).get('/social-prep/unknown-session/assets/1').set('Authorization', `Bearer ${generateIntentToken()}`).expect(403);

    expect(missing.body.error.code).toBe('media_token_missing');
    expect(malformed.body.error.code).toBe('media_token_malformed');
    expect(wrong.body).toEqual(unknown.body);

    repository.supersedeSession('session-1');
    const obsoleteWrong = await request(app).get(url).set('Authorization', `Bearer ${generateIntentToken()}`).expect(403);
    const obsoleteValid = await request(app).get(url).set('Authorization', `Bearer ${redeemed.body.mediaToken}`).expect(409);
    expect(obsoleteWrong.body.error.code).toBe('media_token_invalid');
    expect(obsoleteValid.body.error.code).toBe('attempt_superseded');
  });
  it('returns the frozen deadline and terminal-state codes only after valid authentication', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const url = '/social-prep/session-1/assets/1';
    const authorization = `Bearer ${redeemed.body.mediaToken}`;

    db.prepare("UPDATE social_prep_sessions SET state = 'finished' WHERE id = 'session-1'").run();
    const finished = await request(app).get(url).set('Authorization', authorization).expect(409);
    expect(finished.body.error.code).toBe('attempt_finished');

    db.prepare("UPDATE social_prep_sessions SET state = 'redeemed', attempt_deadline_at = datetime('now') WHERE id = 'session-1'").run();
    const expired = await request(app).get(url).set('Authorization', authorization).expect(401);
    expect(expired.body.error.code).toBe('media_token_expired');

    db.prepare("UPDATE social_prep_sessions SET attempt_deadline_at = datetime('now', '+1 hour'), state = 'issued' WHERE id = 'session-1'").run();
    const inactive = await request(app).get(url).set('Authorization', authorization).expect(409);
    expect(inactive.body.error.code).toBe('attempt_not_active');
  });

  it('treats an expired or query-supplied intent as the same private failure', async () => {
    const expiredIntent = generateIntentToken();
    const expiredReleaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, published_date) VALUES (?, 'Expired', '', '', '2026-08-01')"
    ).run(projectId).lastInsertRowid);
    repository.insertSession({
      id: 'expired-session', releaseId: expiredReleaseId, kind: 'initial', intentHash: digestToken(expiredIntent),
      expiresAt: new Date('2000-01-01T00:00:00.000Z'), now: new Date('1999-12-31T23:59:00.000Z'),
    });
    const expired = await request(app).post('/social-prep/redeem').send({ intent: expiredIntent }).expect(401);
    const query = await request(app).post(`/social-prep/redeem?intent=${intent}`).send({}).expect(401);
    expect(expired.body).toEqual(query.body);
  });
});
