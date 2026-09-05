import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
      "INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url) VALUES ('Project', 'project', '', '', 'tbd', NULL, NULL, NULL)"
    ).run().lastInsertRowid);
    releaseId = Number(db.prepare(
      "INSERT INTO releases (project_id, title, description, notes, published_date) VALUES (?, 'Release title', 'Release body', 'Private release Notes', '2026-08-01')"
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
    const stored = db.prepare('SELECT intent_hash FROM social_prep_sessions WHERE id = ?').get(first.body.sessionId);
    expect(stored.intent_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.intent_hash).not.toBe(intent);
    expect((await agent.get(`/releases/${releaseId}`).expect(200)).text).not.toContain(intent);

    db.prepare("UPDATE social_prep_sessions SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(first.body.sessionId);
    const second = await activate({ platforms: ['x'] }).expect(200);
    expect(new URL(second.body.uri).searchParams.get('intent')).not.toBe(intent);
  });

  it('delegates targeting/reprepare policy and preserves stable service error contracts', async () => {
    const reprepare = await activate({ platforms: ['x', 'bluesky'], reprepare: true }).expect(422);
    expect(reprepare.body.error.code).toBe('reprepare_requires_single_platform');

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

    const response = await activate({ platforms: ['x'] }).expect(422);

    expect(response.body.error.code).toBe('social_prep_disabled');
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_session_assets').get().count).toBe(0);
    expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId).every((row) => row.attempts === 0)).toBe(true);
  });
});
