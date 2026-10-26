import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createReleaseService } from '../src/services/release-service.js';
import { createSocialPrepRepository } from '../src/data/social-prep-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { digestToken, generateIntentToken } from '../src/services/social-prep-tokens.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const ORIGINAL_LINK = 'https://www.patreon.com/posts/original';

describe('Social Preparation release link HTTP', () => {
  let app;
  let db;
  let repository;
  let releaseService;
  let projectId;
  let releaseId;
  let tmpDir;
  let clock;
  let nextSession;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-release-link-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectId = Number(db.prepare(`INSERT INTO projects
      (title, slug, project_dir, description, notes, status, project_type, patreon_url)
      VALUES ('Project', 'project', 'project-dir', '', '', 'tbd', 'images', 'https://example.com/project')`).run().lastInsertRowid);
    releaseId = insertRelease(ORIGINAL_LINK);
    clock = new Date('2030-01-01T00:00:00Z');
    nextSession = 1;
    repository = createSocialPrepRepository(db);
    releaseService = createReleaseService({ db });
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot: path.join(tmpDir, 'projects') },
      { socialPrepRepository: repository, releaseService, now: () => clock },
    );
    app.locals.socialPrepSettingsService.setPlatforms(['patreon', 'x', 'bluesky']);
    app.locals.socialPrepSettingsService.setEnabled(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertRelease(link) {
    return Number(db.prepare(`INSERT INTO releases
      (project_id, title, description, notes, planned_date, planned_time, published_date, patreon_url)
      VALUES (?, 'Title', 'Public body', 'Private notes', '2029-12-30', '09:30', '2030-01-01', ?)`)
      .run(projectId, link).lastInsertRowid);
  }

  /** Redeem a session for `platforms` and drive them to `finalStatus` ('ready' finishes the session). */
  function createAttempt({ platforms = ['x'], finalStatus = 'ready', release = releaseId } = {}) {
    const id = `session-${nextSession++}`;
    const token = generateIntentToken();
    repository.insertSession({
      id, releaseId: release, kind: 'initial', intentHash: `intent-${id}`,
      expiresAt: new Date('2030-01-01T01:00:00Z'), now: clock,
    });
    repository.ensurePlatforms(release, platforms, { now: clock });
    repository.reassignPlatformsToSession(id, platforms, { now: clock });
    repository.insertSessionAsset({
      sessionId: id, assetId: 7, projectId, role: 'primary', sortOrder: 0,
      relativePath: 'final/one.png', filename: 'one.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, isPresent: true,
    });
    app.locals.socialPrepService.redeem({ sessionId: id, intentHash: `intent-${id}`, mediaTokenHash: digestToken(token) });
    for (const platform of platforms) {
      app.locals.socialPrepService.recordPlatformStatus({ releaseId: release, platform, sessionId: id, status: 'staging' });
      if (finalStatus === 'ready') {
        app.locals.socialPrepService.recordPlatformStatus({ releaseId: release, platform, sessionId: id, status: 'ready' });
      }
    }
    return { id, authorization: `Bearer ${token}`, url: `/social-prep/${id}/release-link` };
  }

  function storedLink(id = releaseId) {
    return db.prepare('SELECT patreon_url FROM releases WHERE id = ?').get(id).patreon_url;
  }

  /** Everything a link write must leave untouched. */
  function unrelatedState(id = releaseId) {
    const { patreon_url: _link, updated_at: _updated, ...release } = db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
    return {
      release,
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId),
      releaseAssets: db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(id),
      platforms: db.prepare('SELECT * FROM release_social_platforms WHERE release_id = ? ORDER BY platform').all(id),
      sessions: db.prepare('SELECT * FROM social_prep_sessions WHERE release_id = ? ORDER BY id').all(id),
      snapshots: db.prepare('SELECT * FROM social_prep_session_assets ORDER BY session_id, asset_id').all(),
    };
  }

  function patchLink(attempt, body, authorization = attempt.authorization) {
    return request(app).patch(attempt.url).set('Authorization', authorization).send(body);
  }

  describe('valid operations', () => {
    it('reads, updates, clears, and re-reads the release link without touching unrelated state', async () => {
      const attempt = createAttempt({ platforms: ['x', 'bluesky'] });
      await request(app).post(`/social-prep/${attempt.id}/platforms/x/posted`).set('Authorization', attempt.authorization).expect(200);
      const before = unrelatedState();
      const expiresAt = before.sessions[0].manual_confirmation_expires_at;

      // Beyond the 30-minute attempt deadline but inside the manual window.
      clock = new Date('2030-01-01T03:00:00Z');
      const read = await request(app).get(attempt.url).set('Authorization', attempt.authorization).expect(200);
      expect(read.body).toEqual({ ok: true, sessionId: attempt.id, releaseLink: ORIGINAL_LINK });

      const saved = await patchLink(attempt, { releaseLink: 'http://example.com/new', expectedReleaseLink: ORIGINAL_LINK }).expect(200);
      expect(saved.body).toEqual({ ok: true, sessionId: attempt.id, releaseLink: 'http://example.com/new', changed: true });
      expect(storedLink()).toBe('http://example.com/new');

      const https = await patchLink(attempt, { releaseLink: '  https://example.com/final  ', expectedReleaseLink: 'http://example.com/new' }).expect(200);
      expect(https.body.releaseLink).toBe('https://example.com/final');

      const cleared = await patchLink(attempt, { releaseLink: '', expectedReleaseLink: 'https://example.com/final' }).expect(200);
      expect(cleared.body).toEqual({ ok: true, sessionId: attempt.id, releaseLink: null, changed: true });
      expect(storedLink()).toBeNull();
      await request(app).get(attempt.url).set('Authorization', attempt.authorization).expect(200)
        .expect(({ body }) => expect(body.releaseLink).toBeNull());

      const restored = await patchLink(attempt, { releaseLink: 'https://example.com/again', expectedReleaseLink: null }).expect(200);
      expect(restored.body.releaseLink).toBe('https://example.com/again');
      await request(app).get(attempt.url).set('Authorization', attempt.authorization).expect(200)
        .expect(({ body }) => expect(body.releaseLink).toBe('https://example.com/again'));

      expect(unrelatedState()).toEqual(before);
      expect(repository.findSessionById(attempt.id).manual_confirmation_expires_at).toBe(expiresAt);
      const platforms = repository.listPlatformsByReleaseId(releaseId);
      expect(platforms.find((row) => row.platform === 'x')).toMatchObject({ status: 'posted', is_selected: 1 });
      expect(platforms.find((row) => row.platform === 'bluesky')).toMatchObject({ status: 'ready', is_selected: 1 });
      await request(app).post(`/social-prep/${attempt.id}/platforms/bluesky/posted`).set('Authorization', attempt.authorization)
        .expect(200).expect(({ body }) => expect(body.completion).toEqual({ postedCount: 2, totalCount: 2, isComplete: true }));
    });

    it('treats a blank stored link as empty and an already-applied value as an idempotent no-op', async () => {
      db.prepare("UPDATE releases SET patreon_url = '' WHERE id = ?").run(releaseId);
      const attempt = createAttempt();
      await request(app).get(attempt.url).set('Authorization', attempt.authorization).expect(200)
        .expect(({ body }) => expect(body.releaseLink).toBeNull());
      await patchLink(attempt, { releaseLink: 'https://example.com/a', expectedReleaseLink: null }).expect(200);
      const updatedAt = db.prepare('SELECT updated_at FROM releases WHERE id = ?').get(releaseId).updated_at;

      // A retry after a lost response carries the old expected value.
      const retry = await patchLink(attempt, { releaseLink: 'https://example.com/a', expectedReleaseLink: null }).expect(200);
      expect(retry.body).toEqual({ ok: true, sessionId: attempt.id, releaseLink: 'https://example.com/a', changed: false });
      expect(db.prepare('SELECT updated_at FROM releases WHERE id = ?').get(releaseId).updated_at).toBe(updatedAt);
    });

    it('accepts a padded stored link as the exact expected value for update, clear, and resave', async () => {
      const padded = ' https://example.com/post ';
      db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run(padded, releaseId);
      const attempt = createAttempt();
      const before = unrelatedState();
      await request(app).get(attempt.url).set('Authorization', attempt.authorization).expect(200)
        .expect(({ body }) => expect(body.releaseLink).toBe(padded));

      const updated = await patchLink(attempt, { releaseLink: 'https://example.com/other', expectedReleaseLink: padded }).expect(200);
      expect(updated.body).toEqual({ ok: true, sessionId: attempt.id, releaseLink: 'https://example.com/other', changed: true });
      expect(storedLink()).toBe('https://example.com/other');

      db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run(padded, releaseId);
      const cleared = await patchLink(attempt, { releaseLink: '', expectedReleaseLink: padded }).expect(200);
      expect(cleared.body).toEqual({ ok: true, sessionId: attempt.id, releaseLink: null, changed: true });
      expect(storedLink()).toBeNull();

      // Resaving the same URL stores the trimmed form of the proposed value.
      db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run(padded, releaseId);
      const resaved = await patchLink(attempt, { releaseLink: padded, expectedReleaseLink: padded }).expect(200);
      expect(resaved.body).toEqual({ ok: true, sessionId: attempt.id, releaseLink: 'https://example.com/post', changed: true });
      expect(storedLink()).toBe('https://example.com/post');

      expect(unrelatedState()).toEqual(before);
    });

    it('keeps NULL and a stored empty string equivalent without treating whitespace as empty', async () => {
      const attempt = createAttempt();
      db.prepare('UPDATE releases SET patreon_url = NULL WHERE id = ?').run(releaseId);
      await patchLink(attempt, { releaseLink: 'https://example.com/a', expectedReleaseLink: '' }).expect(200);

      db.prepare("UPDATE releases SET patreon_url = '' WHERE id = ?").run(releaseId);
      await patchLink(attempt, { releaseLink: 'https://example.com/b', expectedReleaseLink: '' }).expect(200);
      expect(storedLink()).toBe('https://example.com/b');

      for (const stored of [null, '']) {
        db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run(stored, releaseId);
        const blank = await patchLink(attempt, { releaseLink: 'https://example.com/c', expectedReleaseLink: '  ' }).expect(409);
        expect(blank.body.error).toMatchObject({ code: 'release_link_conflict', currentReleaseLink: null });
        expect(storedLink()).toBe(stored);
      }
    });

    it('updates only the release derived from the authorized session', async () => {
      const otherReleaseId = insertRelease('https://example.com/other');
      const attempt = createAttempt();
      createAttempt({ release: otherReleaseId });
      await patchLink(attempt, { releaseLink: 'https://example.com/mine', expectedReleaseLink: ORIGINAL_LINK }).expect(200);
      expect(storedLink()).toBe('https://example.com/mine');
      expect(storedLink(otherReleaseId)).toBe('https://example.com/other');
    });
  });

  describe('input validation', () => {
    it.each([
      ['a malformed URL', { releaseLink: 'not a url', expectedReleaseLink: ORIGINAL_LINK }, 'invalid_release_link'],
      ['a relative URL', { releaseLink: '/posts/1', expectedReleaseLink: ORIGINAL_LINK }, 'invalid_release_link'],
      ['an FTP URL', { releaseLink: 'ftp://example.com/file', expectedReleaseLink: ORIGINAL_LINK }, 'invalid_release_link'],
      ['a javascript: URL', { releaseLink: 'javascript:alert(1)', expectedReleaseLink: ORIGINAL_LINK }, 'invalid_release_link'],
      ['a numeric link', { releaseLink: 42, expectedReleaseLink: ORIGINAL_LINK }, 'invalid_input'],
      ['an object link', { releaseLink: { href: 'https://example.com' }, expectedReleaseLink: ORIGINAL_LINK }, 'invalid_input'],
      ['a boolean expected value', { releaseLink: 'https://example.com', expectedReleaseLink: false }, 'invalid_input'],
      ['a missing expected value', { releaseLink: 'https://example.com' }, 'invalid_input'],
      ['a missing link', { expectedReleaseLink: ORIGINAL_LINK }, 'invalid_input'],
      ['an unexpected field', { releaseLink: 'https://example.com', expectedReleaseLink: ORIGINAL_LINK, releaseId: 99 }, 'invalid_input'],
      ['an array body', [{ releaseLink: 'https://example.com', expectedReleaseLink: ORIGINAL_LINK }], 'invalid_input'],
      ['an empty object', {}, 'invalid_input'],
    ])('rejects %s without writing', async (_label, body, issueCode) => {
      const attempt = createAttempt();
      const response = await patchLink(attempt, body).expect(422);
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'validation_failed', message: 'Social Preparation validation failed.', issues: [{ code: issueCode, severity: 'blocking' }] },
      });
      expect(storedLink()).toBe(ORIGINAL_LINK);
    });

    it('rejects non-JSON entities and malformed JSON without writing', async () => {
      const attempt = createAttempt();
      await request(app).patch(attempt.url).set('Authorization', attempt.authorization)
        .type('form').send(`releaseLink=${encodeURIComponent('https://example.com')}&expectedReleaseLink=${encodeURIComponent(ORIGINAL_LINK)}`)
        .expect(422);
      await request(app).patch(attempt.url).set('Authorization', attempt.authorization)
        .set('Content-Type', 'text/plain').send('https://example.com').expect(422);
      await request(app).patch(attempt.url).set('Authorization', attempt.authorization).expect(422);
      const malformed = await request(app).patch(attempt.url).set('Authorization', attempt.authorization)
        .set('Content-Type', 'application/json').send('{"releaseLink":');
      expect(malformed.status).toBeGreaterThanOrEqual(400);
      expect(malformed.status).toBeLessThan(500);
      expect(storedLink()).toBe(ORIGINAL_LINK);
    });
  });

  describe('authority', () => {
    const body = { releaseLink: 'https://example.com/attacker', expectedReleaseLink: ORIGINAL_LINK };

    async function expectRejected(attempt, status, code, authorization = attempt.authorization) {
      await request(app).get(attempt.url).set('Authorization', authorization).expect(status)
        .expect(({ body: payload }) => expect(payload).toEqual({ ok: false, error: { code, message: expect.any(String) } }));
      await patchLink(attempt, body, authorization).expect(status)
        .expect(({ body: payload }) => expect(payload.error.code).toBe(code));
      expect(storedLink()).toBe(ORIGINAL_LINK);
    }

    it('rejects missing, malformed, and invalid bearer authority', async () => {
      const attempt = createAttempt();
      for (const method of ['get', 'patch']) {
        await request(app)[method](attempt.url).send(method === 'patch' ? body : undefined).expect(401)
          .expect(({ body: payload }) => expect(payload.error.code).toBe('release_link_token_missing'));
      }
      await expectRejected(attempt, 401, 'release_link_token_malformed', 'Bearer short');
      await expectRejected(attempt, 403, 'release_link_token_invalid', `Bearer ${generateIntentToken()}`);
      await expectRejected({ ...attempt, url: '/social-prep/missing/release-link' }, 403, 'release_link_token_invalid');
    });

    it('rejects a token presented for another session', async () => {
      const otherReleaseId = insertRelease('https://example.com/other');
      const mine = createAttempt();
      const theirs = createAttempt({ release: otherReleaseId });
      await request(app).patch(theirs.url).set('Authorization', mine.authorization).send(body).expect(403)
        .expect(({ body: payload }) => expect(payload.error.code).toBe('release_link_token_invalid'));
      expect(storedLink(otherReleaseId)).toBe('https://example.com/other');
    });

    it('rejects an expired manual window and superseded or unredeemed sessions', async () => {
      const attempt = createAttempt();
      clock = new Date('2030-01-02T00:00:00Z');
      await expectRejected(attempt, 401, 'release_link_token_expired');

      clock = new Date('2030-01-01T00:10:00Z');
      db.prepare("UPDATE social_prep_sessions SET state = 'superseded' WHERE id = ?").run(attempt.id);
      await expectRejected(attempt, 409, 'attempt_superseded');
      db.prepare("UPDATE social_prep_sessions SET state = 'expired' WHERE id = ?").run(attempt.id);
      await expectRejected(attempt, 409, 'attempt_superseded');
      db.prepare("UPDATE social_prep_sessions SET state = 'issued' WHERE id = ?").run(attempt.id);
      await expectRejected(attempt, 409, 'attempt_not_link_editable');
    });

    it('rejects sessions without a selected ready or posted target', async () => {
      const staging = createAttempt({ finalStatus: 'staging' });
      expect(repository.findSessionById(staging.id).state).toBe('redeemed');
      await expectRejected(staging, 409, 'release_link_not_eligible');

      // A release has one live session, so the deselection case uses a finished attempt.
      db.prepare("UPDATE social_prep_sessions SET state = 'superseded' WHERE id = ?").run(staging.id);
      const ready = createAttempt({ platforms: ['bluesky'] });
      await request(app).get(ready.url).set('Authorization', ready.authorization).expect(200);
      repository.replaceSelectedPlatforms(releaseId, ['x']);
      await expectRejected(ready, 409, 'release_link_not_eligible');
    });

    it('rejects archived releases and releases in archived projects', async () => {
      const attempt = createAttempt();
      db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(releaseId);
      await expectRejected(attempt, 409, 'release_not_editable');

      db.prepare('UPDATE releases SET archived_at = NULL WHERE id = ?').run(releaseId);
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(projectId);
      await expectRejected(attempt, 409, 'release_not_editable');

      db.prepare("UPDATE projects SET archived_at = NULL, status = 'archived' WHERE id = ?").run(projectId);
      await expectRejected(attempt, 409, 'release_not_editable');
    });
  });

  describe('concurrent updates', () => {
    it('rejects a stale expected value and preserves the newer link', async () => {
      const attempt = createAttempt();
      await patchLink(attempt, { releaseLink: 'https://example.com/newer', expectedReleaseLink: ORIGINAL_LINK }).expect(200);
      const stale = await patchLink(attempt, { releaseLink: 'https://example.com/stale', expectedReleaseLink: ORIGINAL_LINK }).expect(409);
      expect(stale.body).toEqual({
        ok: false,
        error: { code: 'release_link_conflict', message: expect.any(String), currentReleaseLink: 'https://example.com/newer' },
      });
      expect(storedLink()).toBe('https://example.com/newer');
    });

    it('does not let a stale padded expected value match a newer unpadded link', async () => {
      db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run(' https://example.com/post ', releaseId);
      const attempt = createAttempt();
      // Another editor resaves the link in its trimmed form after the helper read it.
      db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run('https://example.com/post', releaseId);
      const stale = await patchLink(attempt, {
        releaseLink: 'https://example.com/stale', expectedReleaseLink: ' https://example.com/post ',
      }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'release_link_conflict', currentReleaseLink: 'https://example.com/post' });
      expect(storedLink()).toBe('https://example.com/post');
    });

    it('passes a padded expected value to the conditional write unchanged', () => {
      const padded = ' https://example.com/post ';
      db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run(padded, releaseId);
      const conditionalWrite = vi.spyOn(releaseService.repository, 'updateReleaseLink');
      releaseService.updateReleaseLink(releaseId, { releaseLink: 'https://example.com/next', expectedReleaseLink: padded });
      expect(conditionalWrite).toHaveBeenCalledWith(releaseId, 'https://example.com/next', padded);
      expect(storedLink()).toBe('https://example.com/next');
    });

    function interleaveWriteBeforeConditionalUpdate() {
      const original = releaseService.repository.updateReleaseLink;
      return vi.spyOn(releaseService.repository, 'updateReleaseLink').mockImplementationOnce((...args) => {
        // Another writer lands after the service's read but before its write.
        db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run('https://example.com/interleaved', releaseId);
        return original(...args);
      });
    }

    it('applies the comparison in the same statement as the write', () => {
      const conditionalWrite = interleaveWriteBeforeConditionalUpdate();
      expect(() => releaseService.updateReleaseLink(releaseId, {
        releaseLink: 'https://example.com/late', expectedReleaseLink: ORIGINAL_LINK,
      })).toThrow(expect.objectContaining({ code: 'RELEASE_LINK_CONFLICT', currentReleaseLink: 'https://example.com/interleaved' }));
      expect(conditionalWrite).toHaveBeenCalledWith(releaseId, 'https://example.com/late', ORIGINAL_LINK);
      expect(storedLink()).toBe('https://example.com/interleaved');
    });

    it('reports an interleaved write over HTTP as a conflict without applying the stale write', async () => {
      const attempt = createAttempt();
      interleaveWriteBeforeConditionalUpdate();
      const response = await patchLink(attempt, { releaseLink: 'https://example.com/late', expectedReleaseLink: ORIGINAL_LINK }).expect(409);
      expect(response.body.error).toMatchObject({ code: 'release_link_conflict', currentReleaseLink: 'https://example.com/interleaved' });
      // The simulated writer shares this connection's transaction, so it rolls back with the rejected request.
      expect(storedLink()).not.toBe('https://example.com/late');
    });

    it('lets exactly one of two racing writers with the same expected value win', async () => {
      const attempt = createAttempt();
      const [left, right] = await Promise.all([
        patchLink(attempt, { releaseLink: 'https://example.com/left', expectedReleaseLink: ORIGINAL_LINK }),
        patchLink(attempt, { releaseLink: 'https://example.com/right', expectedReleaseLink: ORIGINAL_LINK }),
      ]);
      expect([left.status, right.status].sort()).toEqual([200, 409]);
      const winner = left.status === 200 ? left : right;
      const loser = left.status === 200 ? right : left;
      expect(storedLink()).toBe(winner.body.releaseLink);
      expect(loser.body.error.currentReleaseLink).toBe(winner.body.releaseLink);
    });
  });

  describe('isolation', () => {
    it('leaves preparation, status, and asset capability behavior unchanged', async () => {
      const attempt = createAttempt({ finalStatus: 'staging' });
      db.prepare("UPDATE release_social_platforms SET status = 'ready' WHERE release_id = ? AND platform = 'x'").run(releaseId);
      await patchLink(attempt, { releaseLink: 'https://example.com/during', expectedReleaseLink: ORIGINAL_LINK }).expect(200);

      const status = await request(app).get(`/social-prep/${attempt.id}/status`).set('Authorization', attempt.authorization).expect(200);
      expect(status.body).toMatchObject({ ok: true, sessionId: attempt.id, state: 'redeemed' });
      expect(status.body.platforms).toEqual([expect.objectContaining({ platform: 'x', status: 'ready' })]);
      await request(app).get(`/social-prep/${attempt.id}/platforms/x/posted`).set('Authorization', attempt.authorization).expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ status: 'ready', postedAt: null }));
      await request(app).get(`/social-prep/${attempt.id}/assets/0`).set('Authorization', attempt.authorization).expect(404)
        .expect(({ body }) => expect(body.error.code).toBe('asset_not_in_preparation'));
    });
  });
});
