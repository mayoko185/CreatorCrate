import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { createReleaseService } from '../src/services/release-service.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LOADED_LINK = 'https://example.com/loaded';
const HELPER_LINK = 'https://example.com/helper';

// Edit Release saves (POST /releases/:id) carry the Release link the form
// loaded as expectedPatreonUrl; the server applies the whole save only while
// that link is still stored, so a newer link (for example one the Posting
// Helper saved) is never overwritten.
describe('Edit Release Release-link guard HTTP', () => {
  let app;
  let db;
  let tmpDir;
  let agent;
  let csrfToken;
  let releaseService;
  let activity;
  let projectId;
  let releaseId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-edit-link-guard-'));
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectId = Number(db.prepare(`INSERT INTO projects
      (title, slug, project_dir, description, notes, status, project_type, patreon_url)
      VALUES ('Project', 'project', 'project-dir', '', '', 'tbd', 'images', NULL)`).run().lastInsertRowid);
    releaseId = Number(db.prepare(`INSERT INTO releases
      (project_id, title, description, notes, planned_date, planned_time, published_date, patreon_url)
      VALUES (?, 'Loaded title', 'Loaded description', 'Loaded notes', '2031-07-10', '09:30', NULL, ?)`)
      .run(projectId, LOADED_LINK).lastInsertRowid);
    activity = [];
    releaseService = createReleaseService({
      db,
      applicationLogger: { info: (entry) => activity.push(entry.event) },
      socialPrepSettingsService: { getPlatforms: () => ['x', 'bluesky'] },
    });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot: path.join(tmpDir, 'projects') },
      { releaseService, appDataRoot, authState: { csrfPepper } });
    app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
    releaseService.updateRelease(releaseId, { selectedPlatforms: ['x'] });
    activity.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const row = () => db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
  const storedLink = () => row().patreon_url;
  const selectedPlatforms = () => db.prepare(`SELECT platform FROM release_social_platforms
    WHERE release_id = ? AND is_selected = 1 ORDER BY platform`).all(releaseId).map((entry) => entry.platform);
  const setStoredLink = (link) => db.prepare('UPDATE releases SET patreon_url = ? WHERE id = ?').run(link, releaseId);
  // What the Posting Helper's capability-protected PATCH does.
  const helperSavesLink = (releaseLink, expectedReleaseLink = LOADED_LINK) => releaseService
    .updateReleaseLink(releaseId, { releaseLink, expectedReleaseLink });

  // The complete Edit Release form, as the dialog submits it.
  function form(overrides = {}) {
    return {
      _csrf: csrfToken,
      expectedPatreonUrl: LOADED_LINK,
      title: 'Edited title',
      description: 'Edited description',
      notes: 'Edited notes',
      plannedDate: '2031-08-01',
      plannedTime: '10:00',
      publishedDate: '',
      patreonUrl: LOADED_LINK,
      selectedPlatformsPresent: '1',
      selectedPlatforms: 'bluesky',
      ...overrides,
    };
  }

  const postEdit = (fields) => agent.post(`/releases/${releaseId}`).set('Accept', 'application/json')
    .type('form').send(fields);

  function expectUnchanged(before, link = before.patreon_url) {
    expect(row()).toEqual({ ...before, patreon_url: link });
    expect(selectedPlatforms()).toEqual(['x']);
  }

  describe('atomic protection', () => {
    it('saves an ordinary edit when the expected link is current', async () => {
      const res = await postEdit(form()).expect(200);
      expect(res.body).toMatchObject({ status: 'success', values: { title: 'Edited title', patreonUrl: LOADED_LINK } });
      expect(row()).toMatchObject({
        title: 'Edited title', description: 'Edited description', notes: 'Edited notes',
        planned_date: '2031-08-01', planned_time: '10:00', patreon_url: LOADED_LINK,
      });
      expect(selectedPlatforms()).toEqual(['bluesky']);
      expect(activity).toEqual(['release.updated']);
    });

    it('rejects a stale expected link with 409 and writes nothing', async () => {
      setStoredLink(HELPER_LINK);
      const before = row();
      const res = await postEdit(form({ patreonUrl: 'https://example.com/typed' })).expect(409);
      expect(res.body).toEqual({
        status: 'error',
        code: 'RELEASE_LINK_CONFLICT',
        message: expect.stringContaining('The saved Release link changed'),
        currentReleaseLink: HELPER_LINK,
      });
      expectUnchanged(before);
      expect(activity).toEqual([]);
    });

    it('refuses a browser save loaded before a helper link save', async () => {
      const loaded = await agent.get(`/releases/${releaseId}/edit`).set('Accept', 'application/json').expect(200);
      expect(loaded.body.values.patreonUrl).toBe(LOADED_LINK);
      helperSavesLink(HELPER_LINK);
      activity.length = 0;
      const before = row();

      const res = await postEdit(form({ expectedPatreonUrl: loaded.body.values.patreonUrl })).expect(409);
      expect(res.body.currentReleaseLink).toBe(HELPER_LINK);
      expectUnchanged(before);
      expect(storedLink()).toBe(HELPER_LINK);
      expect(activity).toEqual([]);

      // Adopting the newer link as the baseline lets the same draft save.
      await postEdit(form({ expectedPatreonUrl: HELPER_LINK, patreonUrl: HELPER_LINK })).expect(200);
      expect(row()).toMatchObject({ title: 'Edited title', patreon_url: HELPER_LINK });
    });

    // Another writer lands after the service's read but before its write.
    function interleaveHelperSaveBeforeWrite() {
      const original = releaseService.repository.update;
      return vi.spyOn(releaseService.repository, 'update').mockImplementationOnce((...args) => {
        helperSavesLink(HELPER_LINK);
        return original(...args);
      });
    }

    for (const [label, overrides] of [
      ['with a platform selection', {}],
      ['without a platform selection', { selectedPlatformsPresent: undefined, selectedPlatforms: undefined }],
    ]) {
      it(`keeps a link saved between the comparison and the write (${label})`, async () => {
        const before = row();
        const write = interleaveHelperSaveBeforeWrite();
        const res = await postEdit(form(overrides)).expect(409);
        expect(write).toHaveBeenCalledWith(releaseId, expect.objectContaining({ title: 'Edited title' }),
          { expectedPatreonUrl: LOADED_LINK });
        expect(res.body).toMatchObject({ code: 'RELEASE_LINK_CONFLICT', currentReleaseLink: HELPER_LINK });
        // Only the helper's own write is stored: no field of the stale form.
        const after = row();
        expect(after).toMatchObject({
          title: before.title, description: before.description, notes: before.notes,
          planned_date: before.planned_date, planned_time: before.planned_time,
          published_date: before.published_date, patreon_url: HELPER_LINK,
        });
        expect(selectedPlatforms()).toEqual(['x']);
        expect(activity).toEqual(['release.updated']);
      });
    }

    it('lets exactly one of two saves with the same expected link win', async () => {
      const [left, right] = await Promise.all([
        postEdit(form({ title: 'Left', patreonUrl: 'https://example.com/left' })),
        postEdit(form({ title: 'Right', patreonUrl: 'https://example.com/right' })),
      ]);
      expect([left.status, right.status].sort()).toEqual([200, 409]);
      const winner = left.status === 200 ? left : right;
      const loser = left.status === 200 ? right : left;
      expect(storedLink()).toBe(winner.body.values.patreonUrl);
      expect(row().title).toBe(winner.body.values.title);
      expect(loser.body.currentReleaseLink).toBe(winner.body.values.patreonUrl);
    });

    it('allows intentional link edits and clearing, then treats the old baseline as stale', async () => {
      await postEdit(form({ patreonUrl: 'https://example.com/edited' })).expect(200);
      expect(storedLink()).toBe('https://example.com/edited');
      await postEdit(form({ title: 'Old baseline' })).expect(409);
      expect(row().title).toBe('Edited title');
      await postEdit(form({ expectedPatreonUrl: 'https://example.com/edited', patreonUrl: '' })).expect(200);
      expect(storedLink()).toBeNull();
    });

    it('keeps validation and archive rules ahead of saving', async () => {
      const invalid = await postEdit(form({ title: '', patreonUrl: 'not a url' })).expect(422);
      expect(invalid.body.errors).toMatchObject({ title: expect.any(String), patreonUrl: expect.any(String) });
      expect(invalid.body.values).not.toHaveProperty('expectedPatreonUrl');
      expect(row().title).toBe('Loaded title');

      db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(releaseId);
      const archived = await postEdit(form()).expect(422);
      expect(archived.body.code).toBe('RELEASE_ARCHIVED');
      expect(row().title).toBe('Loaded title');
    });

    it('still requires a CSRF token', async () => {
      await postEdit(form({ _csrf: undefined })).expect(403);
      expect(row().title).toBe('Loaded title');
    });
  });

  describe('concurrency token values', () => {
    const PADDED = '  https://example.com/padded  ';

    it('matches a padded stored link only by its exact padded value', async () => {
      setStoredLink(PADDED);
      const stale = await postEdit(form({ expectedPatreonUrl: PADDED.trim() })).expect(409);
      expect(stale.body.currentReleaseLink).toBe(PADDED);
      expect(row().title).toBe('Loaded title');

      await postEdit(form({ expectedPatreonUrl: PADDED, patreonUrl: PADDED })).expect(200);
      expect(row()).toMatchObject({ title: 'Edited title', patreon_url: PADDED });
    });

    it('does not let a stale padded value match a newer trimmed link', async () => {
      setStoredLink(PADDED.trim());
      await postEdit(form({ expectedPatreonUrl: PADDED })).expect(409);
      expect(row().title).toBe('Loaded title');
    });

    it('treats a NULL or empty stored link as an empty expected link', async () => {
      setStoredLink(null);
      await postEdit(form({ expectedPatreonUrl: '', patreonUrl: '', title: 'From null' })).expect(200);
      expect(row()).toMatchObject({ title: 'From null', patreon_url: null });

      setStoredLink('');
      await postEdit(form({ expectedPatreonUrl: '', patreonUrl: '', title: 'From empty' })).expect(200);
      expect(row().title).toBe('From empty');

      setStoredLink(LOADED_LINK);
      const stale = await postEdit(form({ expectedPatreonUrl: '' })).expect(409);
      expect(stale.body.currentReleaseLink).toBe(LOADED_LINK);
    });

    it('keeps a whitespace-only expected link exact', async () => {
      setStoredLink(null);
      const res = await postEdit(form({ expectedPatreonUrl: '   ', patreonUrl: '' })).expect(409);
      expect(res.body.currentReleaseLink).toBeNull();
      expect(row().title).toBe('Loaded title');
    });

    it('rejects a missing or malformed expected link without saving', async () => {
      const before = row();
      const missing = await postEdit(form({ expectedPatreonUrl: undefined })).expect(422);
      expect(missing.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: { general: expect.stringContaining('Release link') } });

      const fields = new URLSearchParams(Object.entries(form({ expectedPatreonUrl: undefined, selectedPlatforms: undefined }))
        .filter(([, value]) => value !== undefined));
      fields.append('expectedPatreonUrl', LOADED_LINK);
      fields.append('expectedPatreonUrl', LOADED_LINK);
      await agent.post(`/releases/${releaseId}`).set('Accept', 'application/json').type('form')
        .send(fields.toString()).expect(422);

      expectUnchanged(before);
      expect(activity).toEqual([]);
    });
  });

  describe('Edit Release entry points', () => {
    for (const [label, pagePath] of [
      ['Release Detail', () => `/releases/${releaseId}`],
      ['Dashboard', () => '/'],
      ['Calendar', () => '/calendar?month=2031-07'],
    ]) {
      it(`${label} renders the shared dialog with the expected-link field`, async () => {
        const res = await agent.get(pagePath()).expect(200);
        const dialogForm = res.text.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
        expect(dialogForm).toContain('data-dialog-async="true"');
        expect(dialogForm).toMatch(/<input type="hidden" name="expectedPatreonUrl" value=""/);
      });
    }
  });
});
