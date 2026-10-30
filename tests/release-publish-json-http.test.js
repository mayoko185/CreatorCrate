import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createReleaseService } from '../src/services/release-service.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Review & Publish JSON contract', () => {
  let app;
  let agent;
  let csrfToken;
  let db;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-publish-json-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createRelease() {
    const project = app.locals.projectService.create({ title: `Publish JSON project ${Date.now()} ${Math.random()}` });
    const created = await agent.post('/releases').type('form')
      .send({ _csrf: csrfToken, projectId: String(project.id), title: 'JSON release' })
      .expect(302);
    return { projectId: project.id, releaseId: Number(created.headers.location.replace('/releases/', '')) };
  }

  function publishJson(releaseId, fields = {}) {
    return agent.post(`/releases/${releaseId}/publish`).type('form').set('Accept', 'application/json')
      .send({ _csrf: csrfToken, publishedDate: '2026-01-15', ...fields });
  }

  function publishedDate(releaseId) {
    return db.prepare('SELECT published_date FROM releases WHERE id = ?').get(releaseId).published_date;
  }

  it('publishes and answers with the authoritative publication state', async () => {
    const { projectId, releaseId } = await createRelease();
    const res = await publishJson(releaseId).expect(200);

    expect(res.body).toMatchObject({
      status: 'success',
      message: 'Release published.',
      release: { id: releaseId, projectId, publishedDate: '2026-01-15', published: true, archived: false },
      eligibility: { publishable: false },
      socialPreparation: { available: false },
      values: { publishedDate: '2026-01-15', projectStatus: '' },
    });
    expect(publishedDate(releaseId)).toBe('2026-01-15');
  });

  it('keeps the native redirect for a plain form post', async () => {
    const { releaseId } = await createRelease();
    const res = await agent.post(`/releases/${releaseId}/publish`).type('form')
      .send({ _csrf: csrfToken, publishedDate: '2026-01-15' })
      .expect(302);
    expect(res.headers.location).toBe(`/releases/${releaseId}`);
  });

  it('reports initialized Social Preparation instead of redirecting with prep=1', async () => {
    const { releaseId } = await createRelease();
    app.locals.socialPrepSettingsService.setEnabled(true);
    app.locals.socialPrepSettingsService.setPlatforms(['x']);
    const { socialPrepSettingsService, projectService } = app.locals;
    createReleaseService({ db, socialPrepSettingsService, projectService }).updateRelease(releaseId, {
      title: 'JSON release', description: '', notes: '', plannedDate: null, plannedTime: null,
      publishedDate: null, patreonUrl: '', selectedPlatforms: ['x'],
    });

    const res = await publishJson(releaseId).expect(200);
    expect(res.body.socialPreparation).toEqual({ available: true });
    const detail = await agent.get(`/releases/${releaseId}`).expect(200);
    expect(detail.text).toContain('data-release-social-prep-companion-action');
    expect(detail.text).not.toContain('data-auto-launch');
  });

  it('answers a validation failure with field errors and the submitted values, publishing nothing', async () => {
    const { releaseId } = await createRelease();
    const res = await publishJson(releaseId, { publishedDate: 'not-a-date', projectStatus: 'in-progress' }).expect(422);

    expect(res.body).toMatchObject({
      status: 'error',
      code: 'VALIDATION_FAILED',
      errors: { publishedDate: 'Published date must be a valid date (YYYY-MM-DD).' },
      values: { publishedDate: 'not-a-date', projectStatus: 'in-progress' },
    });
    expect(publishedDate(releaseId)).toBeNull();
  });

  it('refuses a second publication and keeps the first date', async () => {
    const { releaseId } = await createRelease();
    await publishJson(releaseId).expect(200);
    const res = await publishJson(releaseId, { publishedDate: '2026-02-20' }).expect(409);

    expect(res.body).toMatchObject({
      status: 'error',
      code: 'RELEASE_ALREADY_PUBLISHED',
      release: { published: true, publishedDate: '2026-01-15' },
    });
    expect(publishedDate(releaseId)).toBe('2026-01-15');
  });

  it('refuses archived releases and archived projects', async () => {
    const { releaseId } = await createRelease();
    await agent.post(`/releases/${releaseId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
    const archived = await publishJson(releaseId).expect(422);
    expect(archived.body).toMatchObject({
      status: 'error',
      code: 'RELEASE_ARCHIVED',
      message: 'This release is archived, so it cannot be published.',
    });
    const archivedState = await agent.get(`/releases/${releaseId}/publish`).set('Accept', 'application/json').expect(200);
    expect(archivedState.body).toMatchObject({
      release: { published: false, archived: true },
      eligibility: { publishable: false },
      dialogHtml: null,
    });
    expect(publishedDate(releaseId)).toBeNull();
    const archivedDetail = await agent.get(`/releases/${releaseId}`).expect(200);
    expect(archivedDetail.text).toContain('data-release-detail-archived');
    expect(archivedDetail.text).not.toContain('data-release-detail-editing');

    const other = await createRelease();
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(other.projectId);
    const parent = await publishJson(other.releaseId).expect(422);
    expect(parent.body).toMatchObject({
      status: 'error',
      code: 'PROJECT_ARCHIVED',
      message: 'The parent project is archived, so this release cannot be published.',
    });
    expect(publishedDate(other.releaseId)).toBeNull();
  });

  it('answers 404 JSON for an unknown release', async () => {
    const res = await publishJson(999999).expect(404);
    expect(res.body).toMatchObject({ status: 'error', code: 'RELEASE_NOT_FOUND' });
  });

  it('never exposes an internal failure', async () => {
    const { releaseId } = await createRelease();
    db.exec(`CREATE TRIGGER fail_publish BEFORE UPDATE ON releases
      BEGIN SELECT RAISE(ABORT, 'SQLITE secret internal detail'); END`);
    const res = await publishJson(releaseId).expect(500);
    db.exec('DROP TRIGGER fail_publish');

    expect(res.body).toEqual({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'The release was not published. Please try again.',
    });
    expect(publishedDate(releaseId)).toBeNull();
  });

  it('reads the publication state and the closed dialog with a GET', async () => {
    const { releaseId } = await createRelease();
    const res = await agent.get(`/releases/${releaseId}/publish`).set('Accept', 'application/json').expect(200);

    expect(res.body).toMatchObject({
      status: 'success',
      release: { id: releaseId, published: false, archived: false },
      eligibility: { publishable: true },
      actions: { publish: `/releases/${releaseId}/publish` },
    });
    expect(res.body.dialogHtml).toContain('<dialog id="release-publish-dialog"');
    expect(res.body.dialogHtml).not.toMatch(/<dialog id="release-publish-dialog"[^>]*\sopen/);
    expect(res.body.dialogHtml).toContain(`name="_csrf" value="${csrfToken}"`);
    expect(res.body.dialogHtml).not.toContain('<html');
    expect(publishedDate(releaseId)).toBeNull();

    await publishJson(releaseId).expect(200);
    const after = await agent.get(`/releases/${releaseId}/publish`).set('Accept', 'application/json').expect(200);
    expect(after.body).toMatchObject({
      release: { published: true, publishedDate: '2026-01-15' },
      eligibility: { publishable: false },
      dialogHtml: null,
    });
  });

  it('keeps the direct publish URL opening the Release Detail dialog', async () => {
    const { releaseId } = await createRelease();
    const res = await agent.get(`/releases/${releaseId}/publish`).expect(302);
    expect(res.headers.location).toBe(`/releases/${releaseId}?publish=1`);
  });
});
