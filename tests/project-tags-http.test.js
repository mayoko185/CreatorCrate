import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function extractPageHeadingActions(html) {
  return html.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
}

function extractProjectDetailActionToolbar(html) {
  return html.match(/<nav class="project-detail-action-toolbar"[^>]*>[\s\S]*?<\/nav>/)?.[0] || '';
}

function extractProjectTagsSection(html) {
  return html.match(/<div class="project-detail-tags">([\s\S]*?)<\/div>/)?.[1] || '';
}

function extractCurrentTagsSection(html) {
  return html.match(/<section class="project-tags-current">([\s\S]*?)<\/section>/)?.[1] || '';
}

function checkboxMarkup(html, tagId) {
  return html.match(new RegExp(`<input[^>]*id="project-tag-${tagId}"[^>]*>`))?.[0] || '';
}

describe('project tags — HTTP', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-tags-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });

    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db, projectsRoot }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject(title = 'Project Tags HTTP') {
    const response = await agent
      .post('/projects')
      .type('form')
      .send({ title, status: 'tbd', priority: 'normal', _csrf: csrfToken })
      .expect(302);
    return Number(response.headers.location.replace('/projects/', ''));
  }

  function createTag(name) {
    return app.locals.tagService.createTag({ name });
  }

  function assignProjectTags(projectId, tagIds) {
    return app.locals.projectTagService.replaceProjectTags(projectId, tagIds);
  }

  function createAsset(projectId, relativePath = 'source/cover.png') {
    const filename = relativePath.split('/').pop();
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(projectId, relativePath, filename).lastInsertRowid);
  }

  function projectTagRows(projectId) {
    return db.prepare(`
      SELECT project_id, tag_id, created_at
      FROM project_tags
      WHERE project_id = ?
      ORDER BY tag_id
    `).all(projectId);
  }

  function assetTagRows(assetId) {
    return db.prepare(`
      SELECT asset_id, tag_id, created_at
      FROM asset_tags
      WHERE asset_id = ?
      ORDER BY tag_id
    `).all(assetId);
  }

  it('shows assigned display names in service order and a clear untagged state', async () => {
    const untaggedProjectId = await createProject('Untagged Project');
    const untagged = await agent.get(`/projects/${untaggedProjectId}`).expect(200);
    expect(extractProjectTagsSection(untagged.text)).toContain('No tags assigned to this project.');

    const projectId = await createProject('Tagged Project');
    const zebra = createTag('Zebra Display');
    const alpha = createTag('Alpha Display');
    assignProjectTags(projectId, [zebra.id, alpha.id]);

    const detail = await agent.get(`/projects/${projectId}`).expect(200);
    const tagsSection = extractProjectTagsSection(detail.text);
    expect(tagsSection.indexOf('Alpha Display')).toBeLessThan(tagsSection.indexOf('Zebra Display'));
    expect(tagsSection).not.toContain('zebra display');
    expect(tagsSection).not.toContain('alpha display');
    expect(tagsSection).not.toContain('normalized_name');
    expect(tagsSection).not.toContain(`>${zebra.id}<`);
    expect(tagsSection).not.toContain(`>${alpha.id}<`);
  });

  it('omits Manage tags from the active project detail actions', async () => {
    const projectId = await createProject('Heading Actions Project');
    const detail = await agent.get(`/projects/${projectId}`).expect(200);
    const actions = extractPageHeadingActions(detail.text);
    const toolbar = extractProjectDetailActionToolbar(detail.text);

    expect(actions).toBe('');
    expect(detail.text).not.toContain('Manage tags');
    expect(detail.text).not.toContain(`href="/projects/${projectId}/tags"`);
    expect(toolbar).toContain(`href="/projects/${projectId}/edit"`);
    expect(toolbar).toContain('data-dialog-open="project-edit-dialog"');
    expect(toolbar).toContain(`href="/projects/${projectId}/assets"`);
    expect(toolbar).toContain('aria-label="View Assets"');
    expect(detail.text).not.toContain(`href="/projects/${projectId}/asset-categories"`);
    expect(detail.text).not.toMatch(new RegExp(`<section class="workflow-actions">[\\s\\S]*?/projects/${projectId}/tags`));

    const management = await agent.get(`/projects/${projectId}/tags`).expect(200);
    expect(management.text).toContain(`<h1 class="app-section-title">Projects — Heading Actions Project — Tags</h1>`);
    expect(management.text).toContain(`href="/projects/${projectId}">Back to project</a>`);
  });

  it('keeps archived projects readable without tag mutation controls', async () => {
    const projectId = await createProject('Archived Tags Project');
    const tag = createTag('Archived Display');
    assignProjectTags(projectId, [tag.id]);
    await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

    const detail = await agent.get(`/projects/${projectId}`).expect(200);
    const detailActions = extractPageHeadingActions(detail.text);
    const toolbar = extractProjectDetailActionToolbar(detail.text);
    expect(extractProjectTagsSection(detail.text)).toContain('Archived Display');
    expect(detailActions).toBe('');
    expect(detailActions).not.toContain(`href="/projects/${projectId}/tags">Manage tags</a>`);
    expect(toolbar).toContain(`href="/projects/${projectId}/assets"`);
    expect(toolbar).toContain('aria-label="View Assets"');
    // Asset Categories is reached from the assets page, not the project detail header.
    expect(detailActions).not.toContain(`href="/projects/${projectId}/asset-categories"`);

    const management = await agent.get(`/projects/${projectId}/tags`).expect(200);
    expect(management.text).toMatch(/archived and read-only/i);
    expect(management.text).toContain('Archived Display');
    expect(management.text).not.toContain(`action="/projects/${projectId}/tags"`);
    expect(management.text).not.toContain('type="checkbox"');

    const before = projectTagRows(projectId);
    const rejected = await agent
      .post(`/projects/${projectId}/tags`)
      .type('form')
      .send({ tagIds: String(tag.id), _csrf: csrfToken })
      .expect(409);
    expect(rejected.text).toMatch(/archived and read-only/i);
    expect(projectTagRows(projectId)).toEqual(before);
  });

  it('renders every catalog tag, checks existing assignments, and links to Settings Tags', async () => {
    const projectId = await createProject('Management Page Project');
    const first = createTag('First Display');
    const second = createTag('Second Display');
    const third = createTag('Third Display');
    assignProjectTags(projectId, [second.id]);

    const response = await agent.get(`/projects/${projectId}/tags`).expect(200);
    expect(response.text).toContain('First Display');
    expect(response.text).toContain('Second Display');
    expect(response.text).toContain('Third Display');
    expect(response.text).toContain('href="/settings/tags">Settings › Tags</a>');
    expect(response.text).not.toContain('normalized_name');
    expect(response.text).not.toContain('first display');
    expect(response.text).not.toContain('second display');
    expect(response.text).not.toContain('third display');
    expect(response.text).not.toMatch(/Create Tag|Rename|Delete/);
    expect(response.text).not.toContain('/settings/tags/');

    expect(checkboxMarkup(response.text, first.id)).not.toContain('checked');
    expect(checkboxMarkup(response.text, second.id)).toContain('checked');
    expect(checkboxMarkup(response.text, third.id)).not.toContain('checked');
    expect(extractCurrentTagsSection(response.text)).toContain('Second Display');
  });

  it('renders an empty catalog state with no misleading checkbox control', async () => {
    const projectId = await createProject('Empty Tag Catalog Project');
    const response = await agent.get(`/projects/${projectId}/tags`).expect(200);

    expect(response.text).toContain('No reusable tags yet');
    expect(response.text).toContain('Create reusable tags in Settings › Tags');
    expect(response.text).toContain('href="/settings/tags">Manage tags in Settings</a>');
    expect(response.text).not.toContain(`action="/projects/${projectId}/tags"`);
    expect(response.text).not.toContain('type="checkbox"');
  });

  it('replaces the complete set, deduplicates IDs, redirects, and leaves owners/catalog/assets unchanged', async () => {
    const projectId = await createProject('Replace Project Tags');
    const assetId = createAsset(projectId);
    const original = createTag('Original Tag');
    const added = createTag('Added Tag');
    const retained = createTag('Retained Tag');
    const removed = createTag('Removed Tag');
    assignProjectTags(projectId, [original.id, removed.id]);
    app.locals.assetTagService.replaceAssetTags(assetId, [retained.id]);

    const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const tagsBefore = db.prepare('SELECT * FROM tags ORDER BY id').all();
    const assetBefore = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    const assetAssignmentsBefore = assetTagRows(assetId);

    const response = await agent
      .post(`/projects/${projectId}/tags`)
      .type('form')
      .send({ tagIds: [String(added.id), String(retained.id), String(retained.id)], _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe(`/projects/${projectId}?notice=project_tags_updated`);
    expect(projectTagRows(projectId).map(({ tag_id: tagId }) => tagId)).toEqual([added.id, retained.id]);
    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual(projectBefore);
    expect(db.prepare('SELECT * FROM tags ORDER BY id').all()).toEqual(tagsBefore);
    expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)).toEqual(assetBefore);
    expect(assetTagRows(assetId)).toEqual(assetAssignmentsBefore);

    const redirected = await agent.get(response.headers.location).expect(200);
    expect(redirected.text).toContain('Project tags updated successfully.');
    const tagsSection = extractProjectTagsSection(redirected.text);
    expect(tagsSection).toContain('Added Tag');
    expect(tagsSection).toContain('Retained Tag');
    expect(tagsSection).not.toContain('Original Tag');
    expect(tagsSection).not.toContain('Removed Tag');
  });

  it('treats a missing checkbox field as an empty set and removes every assignment', async () => {
    const projectId = await createProject('Clear Project Tags');
    const first = createTag('Clear First');
    const second = createTag('Clear Second');
    assignProjectTags(projectId, [first.id, second.id]);

    const response = await agent
      .post(`/projects/${projectId}/tags`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe(`/projects/${projectId}?notice=project_tags_updated`);
    expect(projectTagRows(projectId)).toEqual([]);
  });

  it('returns 422 for an invalid submitted ID, preserves selections, and makes no partial changes', async () => {
    const projectId = await createProject('Invalid Project Tag ID');
    const existing = createTag('Existing Invalid Test');
    const added = createTag('Added Invalid Test');
    assignProjectTags(projectId, [existing.id]);

    const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const tagsBefore = db.prepare('SELECT * FROM tags ORDER BY id').all();
    const assignmentsBefore = projectTagRows(projectId);
    const response = await agent
      .post(`/projects/${projectId}/tags`)
      .type('form')
      .send({ tagIds: [String(added.id), 'not-a-tag'], _csrf: csrfToken })
      .expect(422);

    expect(response.text).toContain('Could not update the project tags. No changes were made.');
    expect(response.text).toContain('canonical positive integer IDs');
    expect(response.text).toContain('Added Invalid Test');
    expect(checkboxMarkup(response.text, added.id)).toContain('checked');
    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual(projectBefore);
    expect(db.prepare('SELECT * FROM tags ORDER BY id').all()).toEqual(tagsBefore);
    expect(projectTagRows(projectId)).toEqual(assignmentsBefore);
  });

  it('returns 422 when a tag disappears before POST and preserves all assignments', async () => {
    const projectId = await createProject('Deleted Before Post');
    const retained = createTag('Retained Before Post');
    const deleted = createTag('Deleted Before Post');
    assignProjectTags(projectId, [retained.id]);
    await agent.get(`/projects/${projectId}/tags`).expect(200);

    app.locals.tagService.deleteTag(deleted.id);
    const before = projectTagRows(projectId);
    const response = await agent
      .post(`/projects/${projectId}/tags`)
      .type('form')
      .send({ tagIds: [String(retained.id), String(deleted.id)], _csrf: csrfToken })
      .expect(422);

    expect(response.text).toContain('One or more selected tags no longer exists');
    expect(response.text).toContain('Retained Before Post');
    expect(projectTagRows(projectId)).toEqual(before);
    expect(app.locals.tagService.listTags().map((tag) => tag.display_name)).toEqual(['Retained Before Post']);
  });

  it('uses normal 404 behavior for malformed and missing project IDs', async () => {
    await agent.get('/projects/not-a-project/tags').expect(404);
    await agent.get('/projects/999999/tags').expect(404);
    await agent
      .post('/projects/not-a-project/tags')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);
    await agent
      .post('/projects/999999/tags')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);
  });
});
