import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { digestToken, generateIntentToken } from '../src/services/social-prep-tokens.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Social Preparation media HTTP', () => {
  let app;
  let db;
  let repository;
  let projectId;
  let releaseId;
  let intent;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-redeem-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectId = Number(db.prepare(
      "INSERT INTO projects (title, slug, project_dir, description, notes, status, planned_date, published_date, patreon_url) VALUES ('Project', 'project', 'project-dir', '', '', 'tbd', NULL, NULL, NULL)"
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

  it('downloads only snapshotted assets with private attachment headers', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const directory = path.join(projectsRoot, 'project-dir', 'final');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'first.png'), 'snapshot bytes');
    db.prepare(
      "INSERT INTO assets (id, project_id, relative_path, filename, extension, mime_type, size_bytes) VALUES (1, ?, 'final/first.png', 'first.png', '.png', 'image/png', 14)"
    ).run(projectId);

    const response = await request(app)
      .get('/social-prep/session-1/assets/1')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .expect(200);

    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();

    const outside = await request(app)
      .get('/social-prep/session-1/assets/999')
      .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
      .expect(404);
    expect(outside.body.error.code).toBe('asset_not_in_preparation');
  });

  it('lets the stream close the successful download descriptor exactly once', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const directory = path.join(projectsRoot, 'project-dir', 'final');
    const sourcePath = path.join(directory, 'first.png');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(sourcePath, 'snapshot bytes');
    db.prepare(
      "INSERT INTO assets (id, project_id, relative_path, filename, extension, mime_type, size_bytes) VALUES (1, ?, 'final/first.png', 'first.png', '.png', 'image/png', 14)"
    ).run(projectId);

    const realOpenSync = fs.openSync.bind(fs);
    const realClose = fs.close.bind(fs);
    let sourceDescriptor;
    let sourceCloseCount = 0;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const descriptor = realOpenSync(file, ...args);
      if (path.resolve(file) === sourcePath) sourceDescriptor = descriptor;
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, 'close').mockImplementation((descriptor, callback) => {
      if (descriptor === sourceDescriptor) sourceCloseCount += 1;
      return realClose(descriptor, callback);
    });

    try {
      await request(app)
        .get('/social-prep/session-1/assets/1')
        .set('Authorization', `Bearer ${redeemed.body.mediaToken}`)
        .expect(200);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      openSpy.mockRestore();
      closeSpy.mockRestore();
    }

    expect(sourceCloseCount).toBe(1);
  });

  it('lets the stream close an aborted download descriptor exactly once', async () => {
    const redeemed = await request(app).post('/social-prep/redeem').send({ intent }).expect(200);
    const directory = path.join(projectsRoot, 'project-dir', 'final');
    const sourcePath = path.join(directory, 'first.png');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024));
    db.prepare(
      "INSERT INTO assets (id, project_id, relative_path, filename, extension, mime_type, size_bytes) VALUES (1, ?, 'final/first.png', 'first.png', '.png', 'image/png', 1048576)"
    ).run(projectId);

    const realOpenSync = fs.openSync.bind(fs);
    const realClose = fs.close.bind(fs);
    let sourceDescriptor;
    let sourceCloseCount = 0;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const descriptor = realOpenSync(file, ...args);
      if (path.resolve(file) === sourcePath) sourceDescriptor = descriptor;
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, 'close').mockImplementation((descriptor, callback) => {
      if (descriptor === sourceDescriptor) sourceCloseCount += 1;
      return realClose(descriptor, callback);
    });
    let server;

    try {
      server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const { port } = server.address();
      await new Promise((resolve, reject) => {
        const client = http.get({
          hostname: '127.0.0.1',
          port,
          path: '/social-prep/session-1/assets/1',
          headers: { Authorization: `Bearer ${redeemed.body.mediaToken}` },
        }, (response) => {
          response.once('data', () => {
            client.destroy();
            resolve();
          });
        });
        client.once('error', (error) => {
          if (error.code !== 'ECONNRESET') reject(error);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      openSpy.mockRestore();
      closeSpy.mockRestore();
    }

    expect(sourceCloseCount).toBe(1);
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
  let projectsRoot;
