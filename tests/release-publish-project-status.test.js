import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createReleaseService, ReleaseValidationError } from '../src/services/release-service.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Review & Publish optional Project status update', () => {
  let app;
  let agent;
  let csrfToken;
  let db;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-publish-project-status-'));
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

  function editableStatuses() {
    return app.locals.projectOptionCatalogueService.getStatusCatalogue()
      .filter(({ value }) => value !== 'archived');
  }

  async function createProjectAndRelease() {
    const [initialStatus] = editableStatuses();
    const projectTypes = app.locals.projectOptionCatalogueService.getProjectTypeCatalogue();
    const projectType = projectTypes[projectTypes.length - 1].value;
    const tag = app.locals.tagService.createTag({ name: 'Preserved tag' });
    const project = await agent
      .post('/projects')
      .type('form')
      .send({
        _csrf: csrfToken,
        title: 'Publish Status Project',
        description: 'Kept description',
        notes: 'Kept notes',
        status: initialStatus.value,
        projectType,
        patreonUrl: 'https://example.com/project',
        'tagIds[]': String(tag.id),
      })
      .expect(302);
    const projectId = Number(project.headers.location.replace('/projects/', ''));
    const release = await agent
      .post('/releases')
      .type('form')
      .send({ _csrf: csrfToken, projectId: String(projectId), title: 'Status Release' })
      .expect(302);
    const releaseId = Number(release.headers.location.replace('/releases/', ''));
    return { projectId, releaseId, initialStatus: initialStatus.value, tagId: tag.id };
  }

  function readProject(projectId) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  }

  function readPublishedDate(releaseId) {
    return db.prepare('SELECT published_date FROM releases WHERE id = ?').get(releaseId).published_date;
  }

  function readTagIds(projectId) {
    return db.prepare('SELECT tag_id FROM project_tags WHERE project_id = ? ORDER BY tag_id').all(projectId)
      .map(({ tag_id: tagId }) => tagId);
  }

  function publish(releaseId, fields) {
    return agent.post(`/releases/${releaseId}/publish`).type('form')
      .send({ _csrf: csrfToken, publishedDate: '2026-01-15', ...fields });
  }

  function extractPublishForm(html) {
    const start = html.indexOf('<form id="release-publish-form"');
    return start < 0 ? '' : html.slice(start, html.indexOf('</form>', start));
  }

  function checkedProjectStatus(formHtml) {
    return formHtml.match(/<input id="release-publish-project-status-option-\d+" name="projectStatus" type="radio" value="([^"]*)"[^>]*\bchecked\b/)?.[1];
  }

  it('renders the persisted Project Status and a form-owned Update project status defaulting to Keep current status', async () => {
    const { releaseId, initialStatus } = await createProjectAndRelease();
    const res = await agent.get(`/releases/${releaseId}?publish=1`).expect(200);
    const form = extractPublishForm(res.text);

    expect(form).toContain(`data-release-publish-current-project-status="${initialStatus}"`);
    expect(form.indexOf('<dt>Project Status</dt>')).toBeLessThan(form.indexOf('Update project status'));
    expect(checkedProjectStatus(form)).toBe('');
    expect(form).toContain('<span>Keep current status</span>');
    for (const { value } of editableStatuses()) {
      expect(form).toContain(`name="projectStatus" type="radio" value="${value}"`);
    }
    expect(form).not.toContain('name="projectStatus" type="radio" value="archived"');
    expect(form).toContain('data-dialog-reset-values="');
    expect(form).toMatch(/&quot;projectStatus&quot;:&quot;&quot;/);
  });

  it('publishes with Keep current status without changing the Project', async () => {
    const { projectId, releaseId, initialStatus } = await createProjectAndRelease();
    const before = readProject(projectId);

    await publish(releaseId, { projectStatus: '' }).expect(302);

    expect(readPublishedDate(releaseId)).toBe('2026-01-15');
    expect(readProject(projectId)).toMatchObject({ status: initialStatus, updated_at: before.updated_at });
  });

  it('publishes and updates only the Project status through the Project update path', async () => {
    const { projectId, releaseId, initialStatus, tagId } = await createProjectAndRelease();
    const before = readProject(projectId);
    const target = editableStatuses().find(({ value }) => value !== initialStatus).value;

    await publish(releaseId, { projectStatus: target }).expect(302);

    expect(readPublishedDate(releaseId)).toBe('2026-01-15');
    const after = readProject(projectId);
    expect(after.status).toBe(target);
    for (const field of ['title', 'slug', 'description', 'notes', 'project_type', 'patreon_url', 'project_dir']) {
      expect(after[field]).toBe(before[field]);
    }
    expect(readTagIds(projectId)).toEqual([tagId]);
  });

  it('rejects a previously rendered status that was removed from the catalogue without partial persistence', async () => {
    const { projectId, releaseId, initialStatus } = await createProjectAndRelease();
    const catalogue = app.locals.projectOptionCatalogueService;
    const added = catalogue.addOption('status', { name: 'Final Review', color: '#3366CC' });
    const rendered = await agent.get(`/releases/${releaseId}?publish=1`).expect(200);
    expect(extractPublishForm(rendered.text)).toContain(`type="radio" value="${added.value}"`);
    catalogue.deleteOption('status', added.value);

    const res = await publish(releaseId, { projectStatus: added.value }).expect(422);

    expect(readPublishedDate(releaseId)).toBeNull();
    expect(readProject(projectId).status).toBe(initialStatus);
    const form = extractPublishForm(res.text);
    expect(res.text).toContain('<dialog id="release-publish-dialog"');
    expect(form).toContain('The selected project status is no longer available.');
    expect(form).toContain(`data-release-publish-current-project-status="${initialStatus}"`);
    // The removed value is no longer representable, so the selector falls back.
    expect(checkedProjectStatus(form)).toBe('');
  });

  it('preserves a still-valid submitted target when publication validation fails', async () => {
    const { projectId, releaseId, initialStatus } = await createProjectAndRelease();
    const target = editableStatuses().find(({ value }) => value !== initialStatus).value;

    const res = await publish(releaseId, { publishedDate: 'not-a-date', projectStatus: target }).expect(422);

    expect(readPublishedDate(releaseId)).toBeNull();
    expect(readProject(projectId).status).toBe(initialStatus);
    const form = extractPublishForm(res.text);
    expect(form).toContain('field-error-message');
    expect(checkedProjectStatus(form)).toBe(target);
    expect(form).toContain(`data-release-publish-current-project-status="${initialStatus}"`);
    // Closing the dialog after a failed attempt still resets to Keep current status.
    expect(form).toMatch(/&quot;projectStatus&quot;:&quot;&quot;/);
  });

  it('rolls back publication when the Project update fails after writing', async () => {
    const { projectId, releaseId, initialStatus } = await createProjectAndRelease();
    const target = editableStatuses().find(({ value }) => value !== initialStatus).value;
    const projectService = {
      update(...args) {
        app.locals.projectService.update(...args);
        throw new Error('Simulated Project update failure');
      },
    };
    const releaseService = createReleaseService({ db, projectService });

    expect(() => releaseService.publishRelease(releaseId, '2026-01-15', { projectStatus: target }))
      .toThrow('Simulated Project update failure');
    expect(readPublishedDate(releaseId)).toBeNull();
    expect(readProject(projectId).status).toBe(initialStatus);
  });

  it('rejects a non-string target before publication', async () => {
    const { projectId, releaseId, initialStatus } = await createProjectAndRelease();
    const releaseService = createReleaseService({ db, projectService: app.locals.projectService });

    expect(() => releaseService.publishRelease(releaseId, '2026-01-15', { projectStatus: ['ready'] }))
      .toThrow(ReleaseValidationError);
    expect(readPublishedDate(releaseId)).toBeNull();
    expect(readProject(projectId).status).toBe(initialStatus);
  });
});
