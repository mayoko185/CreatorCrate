import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

import { assetTagReviewToken } from '../src/services/asset-tag-service.js';

// WP10A1-F3: every tag save carries the reviewed-state witness of the saved set
// its form showed. Tests written before it send the form a page would render
// now: the current set's token is injected unless the body names tagReview
// itself (a key with the value undefined sends no field at all).
let tagReviewDb = null;
const sendWithoutTagReview = request.Test.prototype.send;
request.Test.prototype.send = function sendWithTagReview(data) {
  const match = /^\/projects\/(\d+)\/assets\/(\d+)\/tags$/.exec(new URL(this.url, 'http://x').pathname);
  if (match && tagReviewDb && this.method === 'POST' && data && typeof data === 'object'
    && !Object.hasOwn(data, 'tagReview')) {
    data = { ...data, tagReview: currentTagReview(tagReviewDb, Number(match[1]), Number(match[2])) };
  }
  return sendWithoutTagReview.call(this, data);
};

// A well-formed token that names no saved set: for requests refused before
// (or regardless of) the review check.
const PLACEHOLDER_TAG_REVIEW = `t1.${'A'.repeat(43)}`;

function currentTagReview(database, projectId, assetId) {
  const tagIds = database.prepare('SELECT tag_id FROM asset_tags WHERE asset_id = ?').all(assetId)
    .map((row) => row.tag_id);
  return assetTagReviewToken({ projectId, assetId, tagIds }) || PLACEHOLDER_TAG_REVIEW;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function activeNavKeys(html) {
  const keys = [];
  const re = /class="app-nav-link" data-nav-key="([^"]+)" aria-current="page"/g;
  let match;
  while ((match = re.exec(html)) !== null) keys.push(match[1]);
  return keys;
}

function headingActions(html) {
  return html.match(/<div class="page-heading-actions">([\s\S]*?)<\/div>/)?.[1] || '';
}

function section(html, className) {
  return html.match(new RegExp(`<section class="[^"]*\\b${className}\\b[^"]*"[\\s\\S]*?<\\/section>`))?.[0] || '';
}

function checkboxMarkup(html, tagId) {
  return html.match(new RegExp(`<input[^>]*id="asset-tag-${tagId}"[^>]*>`))?.[0] || '';
}

describe('asset tags — HTTP', () => {
  let tmpDir;
  let projectsRoot;
  let previewRoot;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-tags-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });

    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    tagReviewDb = db;
    app = createApp({ appName: APP_NAME, db, projectsRoot, previewRoot }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    tagReviewDb = null;
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject(title = 'Asset Tags HTTP Project') {
    const response = await agent
      .post('/projects')
      .type('form')
      .send({ title, status: 'tbd', priority: 'normal', _csrf: csrfToken })
      .expect(302);
    return Number(response.headers.location.replace('/projects/', ''));
  }

  function projectDirectory(projectId) {
    const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(projectId);
    return path.join(projectsRoot, project.project_dir);
  }

  function createAsset(projectId, filename = 'hero.png', { missing = false } = {}) {
    const relativePath = `source/${filename}`;
    const filePath = path.join(projectDirectory(projectId), 'source', filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!missing) fs.writeFileSync(filePath, 'asset bytes');

    const extension = path.extname(filename).slice(1).toLowerCase();
    const assetId = Number(db.prepare(`
      INSERT INTO assets (
        project_id, relative_path, filename, extension, mime_type,
        size_bytes, is_present, last_seen_at, missing_since
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      relativePath,
      filename,
      extension,
      extension === 'png' ? 'image/png' : 'application/octet-stream',
      missing ? 0 : 11,
      missing ? 0 : 1,
      missing ? null : '2026-08-03 10:00:00',
      missing ? '2026-08-03 11:00:00' : null,
    ).lastInsertRowid);

    return { id: assetId, filename, relativePath, filePath };
  }

  function createTag(name) {
    return app.locals.tagService.createTag({ name });
  }

  function assignAssetTags(assetId, tagIds) {
    return app.locals.assetTagService.replaceAssetTags(assetId, tagIds);
  }

  function assignProjectTags(projectId, tagIds) {
    return app.locals.projectTagService.replaceProjectTags(projectId, tagIds);
  }

  function assetTagRows(assetId) {
    return db.prepare(`
      SELECT asset_id, tag_id, created_at
      FROM asset_tags
      WHERE asset_id = ?
      ORDER BY tag_id
    `).all(assetId);
  }

  function projectTagRows(projectId) {
    return db.prepare(`
      SELECT project_id, tag_id, created_at
      FROM project_tags
      WHERE project_id = ?
      ORDER BY tag_id
    `).all(projectId);
  }

  function ownerSnapshot(projectId, assetId) {
    return {
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId),
      asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId),
      tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
      projectTags: projectTagRows(projectId),
    };
  }

  it('shows assigned display names in service order and an untagged state without a redundant Manage tags action', async () => {
    const untaggedProjectId = await createProject('Untagged Asset');
    const untaggedAsset = createAsset(untaggedProjectId, 'untagged.png');
    const untagged = await agent.get(`/projects/${untaggedProjectId}/assets/${untaggedAsset.id}`).expect(200);
    const untaggedTags = section(untagged.text, 'asset-tags-section');
    expect(untaggedTags).toContain('No tags assigned to this asset.');
    expect(headingActions(untagged.text)).not.toContain(
      `href="/projects/${untaggedProjectId}/assets/${untaggedAsset.id}/tags">Manage tags</a>`,
    );

    const projectId = await createProject('Tagged Asset');
    const asset = createAsset(projectId, 'tagged.png');
    const zebra = createTag('Zebra Display');
    const alpha = createTag('Alpha Display');
    assignAssetTags(asset.id, [zebra.id, alpha.id]);

    const detail = await agent.get(`/projects/${projectId}/assets/${asset.id}`).expect(200);
    const tags = section(detail.text, 'asset-tags-section');
    expect(tags.indexOf('Alpha Display')).toBeLessThan(tags.indexOf('Zebra Display'));
    expect(tags).not.toContain('alpha display');
    expect(tags).not.toContain('zebra display');
    expect(tags).not.toContain('normalized_name');
    expect(tags).not.toContain(`>${alpha.id}<`);
    expect(tags).not.toContain(`>${zebra.id}<`);
    const editDialog = detail.text.match(/<dialog id="asset-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(editDialog).toContain(`id="asset-edit-form" method="post" action="/projects/${projectId}/assets/${asset.id}/tags"`);
    expect(editDialog).toContain('<input type="hidden" name="origin" value="asset-edit">');
    expect(editDialog).toContain('name="tagIds[]"');
    expect(editDialog).toContain('data-autosubmit="submit"');
    expect(editDialog).not.toContain('data-dialog-backdrop-static');
    expect(editDialog).not.toContain('Save tags');
    expect(editDialog).not.toContain('app-dialog-footer');
    expect(tags).not.toContain('name="tagIds[]"');
  });

  it('renders the management page with Projects active, all catalog tags, checked assignments, and Settings link', async () => {
    const projectId = await createProject('Management Asset');
    const asset = createAsset(projectId, 'management.png');
    const first = createTag('First Display');
    const second = createTag('Second Display');
    const third = createTag('Third Display');
    assignAssetTags(asset.id, [second.id]);

    const response = await agent.get(`/projects/${projectId}/assets/${asset.id}/tags`).expect(200);

    expect(activeNavKeys(response.text)).toEqual(['projects']);
    expect(response.text).toContain('<h1 class="app-section-title">Assets — Management Asset — management.png — Tags</h1>');
    expect(response.text).toContain('Management Asset');
    expect(response.text).toContain('management.png');
    expect(response.text).toContain('href="/settings/tags">Settings › Tags</a>');
    expect(response.text).not.toContain('normalized_name');
    expect(response.text).not.toContain('First Display'.toLowerCase());
    expect(response.text).not.toContain('Second Display'.toLowerCase());
    expect(response.text).not.toContain('Third Display'.toLowerCase());
    expect(response.text).not.toMatch(/Create Tag|Rename|Delete/);
    expect(response.text).not.toContain('/settings/tags/');
    expect(response.text).toContain('name="tagIds[]"');
    expect(checkboxMarkup(response.text, first.id)).not.toContain('checked');
    expect(checkboxMarkup(response.text, second.id)).toContain('checked');
    expect(checkboxMarkup(response.text, third.id)).not.toContain('checked');
  });

  it('presents the refined tag choices and chips without changing the submitted fields', async () => {
    const projectId = await createProject('Refined Asset Tags');
    const asset = createAsset(projectId, 'refined.png');
    const assigned = createTag('Assigned Chip');
    const other = createTag('Other Chip');
    assignAssetTags(asset.id, [assigned.id]);

    const response = await agent.get(`/projects/${projectId}/assets/${asset.id}/tags`).expect(200);

    expect(response.text).toMatch(/<body class="refined-page">/);
    expect(section(response.text, 'asset-tags-current'))
      .toMatch(/^<section class="settings-section asset-tags-current"[^>]*>\s*<h2 id="asset-tags-current-heading">Current tags<\/h2>\s*<ul class="tag-chip-list">\s*<li class="tag-chip">Assigned Chip<\/li>/);
    const form = response.text.match(new RegExp(`<form method="post" action="/projects/${projectId}/assets/${asset.id}/tags"[\\s\\S]*?</form>`))?.[0] || '';
    const choices = form.match(/<fieldset class="project-tag-choices asset-tag-choices"[^>]*>[\s\S]*?<\/fieldset>/)?.[0] || '';
    expect(choices.match(/<div class="field project-tag-choice">/g)).toHaveLength(2);
    expect(choices).toMatch(new RegExp(`<input type="checkbox" id="asset-tag-${assigned.id}" name="tagIds\\[\\]" value="${assigned.id}" checked>\\s*<label for="asset-tag-${assigned.id}">Assigned Chip</label>`));
    expect(choices).toMatch(new RegExp(`<input type="checkbox" id="asset-tag-${other.id}" name="tagIds\\[\\]" value="${other.id}">\\s*<label for="asset-tag-${other.id}">Other Chip</label>`));
    expect(form.match(/name="tagIds\[\]"/g)).toHaveLength(2);
    expect(form.match(/<input type="hidden"[^>]*>/g)).toEqual([
      `<input type="hidden" name="_csrf" value="${csrfToken}">`,
      // WP10A1-F3: the reviewed-state witness of the saved set shown.
      `<input type="hidden" name="tagReview" value="${assetTagReviewToken({ projectId, assetId: asset.id, tagIds: [assigned.id] })}">`,
    ]);
  });

  it('opts Asset Detail into refined-page with the Edit Asset dialog outside <main>', async () => {
    const projectId = await createProject('Refined Asset Detail');
    const asset = createAsset(projectId, 'detail.png');

    const response = await agent.get(`/projects/${projectId}/assets/${asset.id}`).expect(200);

    expect(response.text).toMatch(/<body class="refined-page">/);
    expect(response.text).toMatch(/<section class="settings-section asset-preview-section" aria-labelledby="asset-preview-heading">/);
    expect(response.text.indexOf('id="asset-edit-dialog"')).toBeGreaterThan(response.text.indexOf('</main>'));
  });

  it('renders an empty catalog with a Settings link and no checkbox controls', async () => {
    const projectId = await createProject('Empty Asset Catalog');
    const asset = createAsset(projectId, 'empty.png');

    const response = await agent.get(`/projects/${projectId}/assets/${asset.id}/tags`).expect(200);

    expect(response.text).toContain('No reusable tags available');
    expect(response.text).toContain('Create reusable tags in Settings › Tags');
    expect(response.text).toContain('href="/settings/tags">Manage tags in Settings</a>');
    expect(response.text).not.toContain('type="checkbox"');
    expect(response.text).not.toContain(`action="/projects/${projectId}/assets/${asset.id}/tags"`);
  });

  it('replaces the complete Edit Asset tag set, deduplicates IDs, redirects with a notice, and preserves owner and project-tag rows', async () => {
    const projectId = await createProject('Replace Asset Tags');
    const asset = createAsset(projectId, 'replace.png');
    const original = createTag('Original Tag');
    const added = createTag('Added Tag');
    const retained = createTag('Retained Tag');
    const removed = createTag('Removed Tag');
    const projectTag = createTag('Project Only Tag');
    assignAssetTags(asset.id, [original.id, removed.id]);
    assignProjectTags(projectId, [projectTag.id]);

    const before = ownerSnapshot(projectId, asset.id);
    const response = await agent
      .post(`/projects/${projectId}/assets/${asset.id}/tags`)
      .type('form')
      .send({
        origin: 'asset-edit',
        tagIds: [String(added.id), String(retained.id), String(retained.id)],
        _csrf: csrfToken,
      })
      .expect(302);

    expect(response.headers.location).toBe(
      `/projects/${projectId}/assets/${asset.id}?notice=asset_tags_updated&edit=1`,
    );
    expect(assetTagRows(asset.id).map(({ tag_id: tagId }) => tagId)).toEqual([added.id, retained.id]);
    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual(before.project);
    expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id)).toEqual(before.asset);
    expect(db.prepare('SELECT * FROM tags ORDER BY id').all()).toEqual(before.tags);
    expect(projectTagRows(projectId)).toEqual(before.projectTags);

    const redirected = await agent.get(response.headers.location).expect(200);
    expect(redirected.text).toContain('Asset tags updated successfully.');
    expect(redirected.text).toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
    const redirectedEditDialog = redirected.text.match(/<dialog id="asset-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(redirectedEditDialog).toMatch(new RegExp(`value="${added.id}"[^>]*checked`));
    expect(redirectedEditDialog).toMatch(new RegExp(`value="${retained.id}"[^>]*checked`));
    const tags = section(redirected.text, 'asset-tags-section');
    expect(tags).toContain('Added Tag');
    expect(tags).toContain('Retained Tag');
    expect(tags).not.toContain('Original Tag');
    expect(tags).not.toContain('Removed Tag');
  });

  it('rejects an invalid non-empty CSRF token before replacing asset tags', async () => {
    const projectId = await createProject('Asset Tags CSRF');
    const asset = createAsset(projectId, 'csrf.png');
    const existing = createTag('Existing CSRF Tag');
    const replacement = createTag('Replacement CSRF Tag');
    assignAssetTags(asset.id, [existing.id]);
    const before = assetTagRows(asset.id);
    const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags');

    try {
      await agent
        .post(`/projects/${projectId}/assets/${asset.id}/tags`)
        .type('form')
        .send({ tagIds: [String(replacement.id)], _csrf: 'deliberately-invalid-csrf-token' })
        .expect(403);
      expect(replaceAssetTags).not.toHaveBeenCalled();
    } finally {
      replaceAssetTags.mockRestore();
    }
    expect(assetTagRows(asset.id)).toEqual(before);
  });

  it('treats a missing checkbox field as an empty set and removes every assignment', async () => {
    const projectId = await createProject('Clear Asset Tags');
    const asset = createAsset(projectId, 'clear.png');
    const first = createTag('Clear First');
    const second = createTag('Clear Second');
    assignAssetTags(asset.id, [first.id, second.id]);

    const response = await agent
      .post(`/projects/${projectId}/assets/${asset.id}/tags`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe(
      `/projects/${projectId}/assets/${asset.id}?notice=asset_tags_updated`,
    );
    expect(assetTagRows(asset.id)).toEqual([]);
  });

  it('redirects Edit Asset empty selections back to the open dialog', async () => {
    const projectId = await createProject('Clear Edit Asset Tags');
    const asset = createAsset(projectId, 'clear-edit.png');
    const assigned = createTag('Assigned Before Clear');
    assignAssetTags(asset.id, [assigned.id]);

    const response = await agent
      .post(`/projects/${projectId}/assets/${asset.id}/tags`)
      .type('form')
      .send({ origin: 'asset-edit', _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe(
      `/projects/${projectId}/assets/${asset.id}?notice=asset_tags_updated&edit=1`,
    );
    expect(assetTagRows(asset.id)).toEqual([]);

    const redirected = await agent.get(response.headers.location).expect(200);
    expect(redirected.text).toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
    expect(section(redirected.text, 'asset-tags-section')).toContain('No tags assigned to this asset.');
  });

  it('returns 422 for invalid submitted IDs with retained selections and no partial changes', async () => {
    const projectId = await createProject('Invalid Asset Tag ID');
    const asset = createAsset(projectId, 'invalid.png');
    const existing = createTag('Existing Invalid Test');
    const added = createTag('Added Invalid Test');
    assignAssetTags(asset.id, [existing.id]);
    const before = assetTagRows(asset.id);

    const renderSpy = vi.spyOn(app, 'render');
    let response;
    try {
      response = await agent
        .post(`/projects/${projectId}/assets/${asset.id}/tags`)
        .type('form')
        .send({ origin: 'asset-edit', tagIds: [String(added.id), 'not-a-tag'], _csrf: csrfToken })
        .expect(422);

      const viewerModel = renderSpy.mock.calls.find(([view]) => view === 'projects/asset-viewer.njk')?.[1];
      expect(viewerModel).toEqual(expect.objectContaining({
        assetEditDialogOpen: true,
        selectedAssetTagIds: [String(added.id), 'not-a-tag'],
        confirmedAssetTagIds: [String(existing.id)],
      }));
    } finally {
      renderSpy.mockRestore();
    }

    expect(response.text).toContain('Could not update the asset tags. No changes were made.');
    expect(response.text).toContain('canonical positive integer IDs');
    expect(response.text).toContain('Added Invalid Test');
    expect(response.text).toMatch(new RegExp(`value="${added.id}"[^>]*checked`));
    expect(response.text).toContain('Existing Invalid Test');
    expect(response.text).toMatch(/<dialog id="asset-edit-dialog"[^>]*\bopen\b/);
    expect(response.text).toContain('asset-metadata-section');
    expect(response.text).toContain('asset-release-usage-section');
    expect(response.text).not.toContain('<h2>Manage tags</h2>');
    expect(assetTagRows(asset.id)).toEqual(before);
  });

  it('keeps standalone controlled tag failures on the Manage Tags page', async () => {
    const projectId = await createProject('Standalone Invalid Asset Tag ID');
    const asset = createAsset(projectId, 'standalone-invalid.png');
    const added = createTag('Standalone Added Invalid Test');

    const response = await agent
      .post(`/projects/${projectId}/assets/${asset.id}/tags`)
      .type('form')
      .send({ tagIds: [String(added.id), 'not-a-tag'], _csrf: csrfToken })
      .expect(422);

    expect(response.text).toContain('<h2>Manage tags</h2>');
    expect(response.text).toContain('canonical positive integer IDs');
    expect(checkboxMarkup(response.text, added.id)).toContain('checked');
    expect(response.text).not.toContain('<dialog id="asset-edit-dialog"');
  });

  it('returns 422 when a tag disappears between GET and POST without partial changes', async () => {
    const projectId = await createProject('Deleted Asset Tag');
    const asset = createAsset(projectId, 'deleted-race.png');
    const retained = createTag('Retained Before Post');
    const deleted = createTag('Deleted Before Post');
    assignAssetTags(asset.id, [retained.id]);

    await agent.get(`/projects/${projectId}/assets/${asset.id}/tags`).expect(200);
    app.locals.tagService.deleteTag(deleted.id);
    const before = assetTagRows(asset.id);

    const response = await agent
      .post(`/projects/${projectId}/assets/${asset.id}/tags`)
      .type('form')
      .send({ tagIds: [String(retained.id), String(deleted.id)], _csrf: csrfToken })
      .expect(422);

    expect(response.text).toContain('One or more selected tags no longer exists');
    expect(response.text).toContain('Retained Before Post');
    expect(assetTagRows(asset.id)).toEqual(before);
  });

  it('keeps missing retained rows visible and allows tag assignment without changing presence', async () => {
    const projectId = await createProject('Missing Retained Asset');
    const asset = createAsset(projectId, 'missing.png', { missing: true });
    const existing = createTag('Missing Existing');
    const replacement = createTag('Missing Replacement');
    assignAssetTags(asset.id, [existing.id]);

    const detail = await agent.get(`/projects/${projectId}/assets/${asset.id}`).expect(200);
    expect(section(detail.text, 'asset-tags-section')).toContain('Missing Existing');
    expect(headingActions(detail.text)).not.toContain(
      `href="/projects/${projectId}/assets/${asset.id}/tags">Manage tags</a>`,
    );

    const management = await agent.get(`/projects/${projectId}/assets/${asset.id}/tags`).expect(200);
    expect(management.text).toContain('missing at last scan');
    expect(checkboxMarkup(management.text, existing.id)).toContain('checked');

    await agent
      .post(`/projects/${projectId}/assets/${asset.id}/tags`)
      .type('form')
      .send({ tagIds: String(replacement.id), _csrf: csrfToken })
      .expect(302);

    expect(assetTagRows(asset.id).map(({ tag_id: tagId }) => tagId)).toEqual([replacement.id]);
    expect(db.prepare('SELECT is_present FROM assets WHERE id = ?').get(asset.id)).toEqual({ is_present: 0 });
  });

  it('keeps archived tags visible, hides mutation controls, and rejects direct POST mutation', async () => {
    const projectId = await createProject('Archived Asset Tags');
    const asset = createAsset(projectId, 'archived.png');
    const tag = createTag('Archived Display');
    assignAssetTags(asset.id, [tag.id]);

    await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

    const detail = await agent.get(`/projects/${projectId}/assets/${asset.id}`).expect(200);
    expect(section(detail.text, 'asset-tags-section')).toContain('Archived Display');
    expect(headingActions(detail.text)).not.toContain(
      `href="/projects/${projectId}/assets/${asset.id}/tags">Manage tags</a>`,
    );

    const management = await agent.get(`/projects/${projectId}/assets/${asset.id}/tags`).expect(200);
    expect(management.text).toMatch(/archived and read-only/i);
    expect(management.text).toContain('Archived Display');
    expect(management.text).not.toContain('type="checkbox"');
    expect(management.text).not.toContain(`action="/projects/${projectId}/assets/${asset.id}/tags"`);

    const before = assetTagRows(asset.id);
    const rejected = await agent
      .post(`/projects/${projectId}/assets/${asset.id}/tags`)
      .type('form')
      .send({ tagIds: [], _csrf: csrfToken })
      .expect(409);
    expect(rejected.text).toMatch(/archived and read-only/i);
    expect(assetTagRows(asset.id)).toEqual(before);
  });

  it('uses normal 404 behavior for malformed, missing, and cross-project project/asset IDs', async () => {
    const ownerId = await createProject('Asset Tag Owner');
    const ownerAsset = createAsset(ownerId, 'owner.png');
    const otherId = await createProject('Asset Tag Other');
    const otherAsset = createAsset(otherId, 'other.png');

    const getPaths = [
      `/projects/not-a-project/assets/${ownerAsset.id}/tags`,
      `/projects/${ownerId}/assets/not-an-asset/tags`,
      `/projects/999999/assets/${ownerAsset.id}/tags`,
      `/projects/${ownerId}/assets/999999/tags`,
      `/projects/${otherId}/assets/${ownerAsset.id}/tags`,
    ];
    for (const route of getPaths) await agent.get(route).expect(404);

    const postPaths = [
      `/projects/not-a-project/assets/${ownerAsset.id}/tags`,
      `/projects/${ownerId}/assets/not-an-asset/tags`,
      `/projects/999999/assets/${ownerAsset.id}/tags`,
      `/projects/${ownerId}/assets/999999/tags`,
      `/projects/${otherId}/assets/${ownerAsset.id}/tags`,
    ];
    for (const route of postPaths) {
      await agent.post(route).type('form').send({ _csrf: csrfToken }).expect(404);
    }

    expect(otherAsset.id).toBeGreaterThan(ownerAsset.id);
  });

  it('leaves the existing asset detail and project-scoped asset routes functional', async () => {
    const projectId = await createProject('Existing Asset Routes');
    const asset = createAsset(projectId, 'routes.png');

    await agent.get(`/projects/${projectId}/assets`).expect(200);
    const detail = await agent.get(`/projects/${projectId}/assets/${asset.id}`).expect(200);
    expect(detail.text).toContain('Existing Asset Routes');
    expect(detail.text).toContain('routes.png');
    expect(detail.text).toContain('Tags');
  });

  it('persists one aggregate asset-tag activity per real change without identifier-list or path leakage', async () => {
    const projectId = await createProject('Logging asset tags');
    const asset = createAsset(projectId, 'log-safe.png');
    const tag = createTag('Logging tag');

    assignAssetTags(asset.id, [tag.id]);
    assignAssetTags(asset.id, [tag.id]);
    assignAssetTags(asset.id, []);

    const rows = db.prepare(`
      SELECT event, project_id, context_json
      FROM application_logs
      WHERE event IN ('asset.tags.assigned', 'asset.tags.removed')
      ORDER BY id
    `).all();

    expect(rows).toEqual([
      expect.objectContaining({
        event: 'asset.tags.assigned',
        project_id: projectId,
        context_json: JSON.stringify({ tagId: null, assetCount: 1, assignmentCount: 1 }),
      }),
      expect.objectContaining({
        event: 'asset.tags.removed',
        project_id: projectId,
        context_json: JSON.stringify({ tagId: null, assetCount: 1, assignmentCount: 1 }),
      }),
    ]);
    expect(rows.map((row) => row.context_json).join('')).not.toContain('log-safe.png');
    expect(rows.map((row) => row.context_json).join('')).not.toContain('assetIds');
  });

  // WP10A1: the Edit Asset dialog's in-place save (Accept: application/json).
  describe('enhanced JSON tag save', () => {
    function postJson(route, body) {
      return agent
        .post(route)
        .set('Accept', 'application/json')
        .type('form')
        .send(body);
    }

    function tagIdsOf(assetId) {
      return assetTagRows(assetId).map(({ tag_id: tagId }) => tagId);
    }

    it('replaces the complete set and answers with the authoritative saved IDs, no redirect and no other row changed', async () => {
      const projectId = await createProject('JSON Replace Tags');
      const asset = createAsset(projectId, 'json-replace.png');
      const other = createAsset(projectId, 'json-other.png');
      const original = createTag('Json Original');
      const added = createTag('Json Added');
      const retained = createTag('Json Retained');
      const projectTag = createTag('Json Project Only');
      assignAssetTags(asset.id, [original.id, retained.id]);
      assignAssetTags(other.id, [original.id]);
      assignProjectTags(projectId, [projectTag.id]);
      const before = ownerSnapshot(projectId, asset.id);
      const otherBefore = assetTagRows(other.id);

      const response = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
        origin: 'asset-edit',
        tagIds: [String(added.id), String(retained.id), String(retained.id)],
        _csrf: csrfToken,
      }).expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.headers.location).toBeUndefined();
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'committed',
        message: 'Asset tags updated.',
        projectId,
        assetId: asset.id,
        tagIds: expect.arrayContaining([added.id, retained.id]),
        tags: expect.arrayContaining([
          { id: added.id, displayName: 'Json Added' },
          { id: retained.id, displayName: 'Json Retained' },
        ]),
        // WP10A1-F3: the witness of the set this save stored.
        tagReview: assetTagReviewToken({ projectId, assetId: asset.id, tagIds: [added.id, retained.id] }),
        refreshRequired: true,
      });
      expect(response.body.tagIds).toHaveLength(2);
      expect([...response.body.tagIds].sort((a, b) => a - b)).toEqual(tagIdsOf(asset.id));
      expect(tagIdsOf(asset.id)).toEqual([added.id, retained.id].sort((a, b) => a - b));
      expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id)).toEqual(before.asset);
      expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual(before.project);
      expect(db.prepare('SELECT * FROM tags ORDER BY id').all()).toEqual(before.tags);
      expect(projectTagRows(projectId)).toEqual(before.projectTags);
      expect(assetTagRows(other.id)).toEqual(otherBefore);
    });

    it('treats a form with no tagIds field as an explicit empty set and reports no saved tags', async () => {
      const projectId = await createProject('JSON Empty Tags');
      const asset = createAsset(projectId, 'json-empty.png');
      const first = createTag('Json Empty First');
      const second = createTag('Json Empty Second');
      assignAssetTags(asset.id, [first.id, second.id]);

      const response = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
        origin: 'asset-edit',
        _csrf: csrfToken,
      }).expect(200);

      expect(response.body).toEqual(expect.objectContaining({
        status: 'success',
        outcome: 'committed',
        tagIds: [],
        tags: [],
      }));
      expect(assetTagRows(asset.id)).toEqual([]);
    });

    it('keeps the native Edit Asset and standalone forms on their redirect contract', async () => {
      const projectId = await createProject('JSON Native Compatibility');
      const asset = createAsset(projectId, 'json-native.png');
      const tag = createTag('Json Native');

      const native = await agent
        .post(`/projects/${projectId}/assets/${asset.id}/tags`)
        .type('form')
        .send({ origin: 'asset-edit', tagIds: [String(tag.id)], _csrf: csrfToken })
        .expect(302);
      expect(native.headers.location).toBe(`/projects/${projectId}/assets/${asset.id}?notice=asset_tags_updated&edit=1`);

      const standalone = await agent
        .post(`/projects/${projectId}/assets/${asset.id}/tags`)
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(302);
      expect(standalone.headers.location).toBe(`/projects/${projectId}/assets/${asset.id}?notice=asset_tags_updated`);
      expect(assetTagRows(asset.id)).toEqual([]);
    });

    it('refuses missing, malformed and cross-project identities as JSON 404 without calling the service', async () => {
      const ownerId = await createProject('JSON Tag Owner');
      const ownerAsset = createAsset(ownerId, 'json-owner.png');
      const otherId = await createProject('JSON Tag Other');
      const tag = createTag('Json Identity');
      assignAssetTags(ownerAsset.id, [tag.id]);
      const before = assetTagRows(ownerAsset.id);
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags');

      try {
        for (const route of [
          `/projects/not-a-project/assets/${ownerAsset.id}/tags`,
          `/projects/${ownerId}/assets/not-an-asset/tags`,
          `/projects/999999/assets/${ownerAsset.id}/tags`,
          `/projects/${ownerId}/assets/999999/tags`,
          `/projects/${otherId}/assets/${ownerAsset.id}/tags`,
        ]) {
          const response = await postJson(route, { origin: 'asset-edit', _csrf: csrfToken }).expect(404);
          expect(response.body).toEqual({
            status: 'error',
            code: 'ASSET_NOT_FOUND',
            outcome: 'refused',
            message: 'This asset no longer exists in this project.',
          });
        }
        expect(replaceAssetTags).not.toHaveBeenCalled();
      } finally {
        replaceAssetTags.mockRestore();
      }
      expect(assetTagRows(ownerAsset.id)).toEqual(before);
    });

    it('reports an asset deleted after the ownership read as missing without changing anything', async () => {
      const projectId = await createProject('JSON Deleted Race');
      const asset = createAsset(projectId, 'json-deleted.png');
      const tag = createTag('Json Deleted');
      // The repository transaction returns undefined when the asset row is gone.
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags')
        .mockImplementation(() => undefined);

      try {
        const response = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
          origin: 'asset-edit',
          tagIds: [String(tag.id)],
          _csrf: csrfToken,
        }).expect(404);
        expect(response.body).toEqual(expect.objectContaining({ code: 'ASSET_NOT_FOUND', outcome: 'refused' }));
      } finally {
        replaceAssetTags.mockRestore();
      }
      expect(assetTagRows(asset.id)).toEqual([]);
    });

    it('refuses an archived project with 409 PROJECT_ARCHIVED and keeps every assignment', async () => {
      const projectId = await createProject('JSON Archived Tags');
      const asset = createAsset(projectId, 'json-archived.png');
      const tag = createTag('Json Archived');
      assignAssetTags(asset.id, [tag.id]);
      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
      const before = assetTagRows(asset.id);

      const response = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
        origin: 'asset-edit',
        _csrf: csrfToken,
      }).expect(409);

      expect(response.body).toEqual(expect.objectContaining({
        status: 'error',
        code: 'PROJECT_ARCHIVED',
        outcome: 'refused',
        errors: { tagIds: expect.stringMatching(/archived and read-only/i) },
      }));
      expect(assetTagRows(asset.id)).toEqual(before);
    });

    it('refuses unknown or deleted tags with 422 TAG_NOT_FOUND, returning the submitted selection', async () => {
      const projectId = await createProject('JSON Stale Catalog');
      const asset = createAsset(projectId, 'json-stale.png');
      const retained = createTag('Json Stale Retained');
      const deleted = createTag('Json Stale Deleted');
      assignAssetTags(asset.id, [retained.id]);
      app.locals.tagService.deleteTag(deleted.id);
      const before = assetTagRows(asset.id);

      for (const ids of [[String(retained.id), String(deleted.id)], ['999999']]) {
        const response = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
          origin: 'asset-edit',
          tagIds: ids,
          _csrf: csrfToken,
        }).expect(422);
        expect(response.body).toEqual({
          status: 'error',
          code: 'TAG_NOT_FOUND',
          outcome: 'refused',
          message: 'One or more selected tags no longer exists. Refresh and try again.',
          errors: { tagIds: 'One or more selected tags no longer exists. Refresh and try again.' },
          submittedTagIds: ids,
        });
      }
      expect(assetTagRows(asset.id)).toEqual(before);
    });

    it('refuses malformed and nested tag input with 422 TAG_IDS_INVALID before the service runs', async () => {
      const projectId = await createProject('JSON Malformed Tags');
      const asset = createAsset(projectId, 'json-malformed.png');
      const tag = createTag('Json Malformed');
      assignAssetTags(asset.id, [tag.id]);
      const before = assetTagRows(asset.id);
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags');

      try {
        for (const body of [
          `origin=asset-edit&tagIds%5B%5D=not-a-tag&_csrf=${encodeURIComponent(csrfToken)}`,
          `origin=asset-edit&tagIds%5B%5D=0${tag.id}&_csrf=${encodeURIComponent(csrfToken)}`,
          `origin=asset-edit&tagIds%5Bnested%5D%5Bdeep%5D=1&_csrf=${encodeURIComponent(csrfToken)}`,
          `origin=asset-edit&tagIds%5B%5D=&_csrf=${encodeURIComponent(csrfToken)}`,
        ]) {
          const response = await agent
            .post(`/projects/${projectId}/assets/${asset.id}/tags`)
            .set('Accept', 'application/json')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send(body)
            .expect(422);
          expect(response.body).toEqual(expect.objectContaining({
            status: 'error',
            code: 'TAG_IDS_INVALID',
            outcome: 'refused',
            errors: { tagIds: expect.any(String) },
          }));
        }
        expect(replaceAssetTags).not.toHaveBeenCalled();
      } finally {
        replaceAssetTags.mockRestore();
      }
      expect(assetTagRows(asset.id)).toEqual(before);
    });

    it('deduplicates repeated IDs without treating them as an error', async () => {
      const projectId = await createProject('JSON Duplicate Tags');
      const asset = createAsset(projectId, 'json-duplicate.png');
      const tag = createTag('Json Duplicate');

      const response = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
        origin: 'asset-edit',
        tagIds: [String(tag.id), String(tag.id)],
        _csrf: csrfToken,
      }).expect(200);

      expect(response.body.tagIds).toEqual([tag.id]);
      expect(tagIdsOf(asset.id)).toEqual([tag.id]);
    });

    it('answers an unexpected service failure with a safe 500 whose outcome is unknown', async () => {
      const projectId = await createProject('JSON Service Failure');
      const asset = createAsset(projectId, 'json-failure.png');
      const tag = createTag('Json Failure');
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags')
        .mockImplementation(() => { throw new Error('SQLITE_BUSY: database is locked at C:\\secret\\path'); });

      try {
        const response = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
          origin: 'asset-edit',
          tagIds: [String(tag.id)],
          _csrf: csrfToken,
        }).expect(500);
        expect(response.body).toEqual({
          status: 'error',
          code: 'TAG_SAVE_FAILED',
          outcome: 'unknown',
          message: 'The asset tag save could not be confirmed.',
        });
        expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|secret/);
      } finally {
        replaceAssetTags.mockRestore();
      }
    });

    it('rejects a bad CSRF token and an unauthenticated request before any tag mutation', async () => {
      const projectId = await createProject('JSON Tag Security');
      const asset = createAsset(projectId, 'json-security.png');
      const existing = createTag('Json Security Existing');
      const replacement = createTag('Json Security Replacement');
      assignAssetTags(asset.id, [existing.id]);
      const before = assetTagRows(asset.id);
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags');

      try {
        const badCsrf = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
          origin: 'asset-edit',
          tagIds: [String(replacement.id)],
          _csrf: 'deliberately-invalid-csrf-token',
        }).expect(403);
        expect(badCsrf.body).toEqual(expect.objectContaining({ status: 'error' }));

        const missingCsrf = await postJson(`/projects/${projectId}/assets/${asset.id}/tags`, {
          origin: 'asset-edit',
          tagIds: [String(replacement.id)],
        });
        expect(missingCsrf.status).toBe(403);

        const anonymous = await request(app)
          .post(`/projects/${projectId}/assets/${asset.id}/tags`)
          .set('Accept', 'application/json')
          .type('form')
          .send({ origin: 'asset-edit', tagIds: [String(replacement.id)], _csrf: csrfToken });
        expect([401, 403]).toContain(anonymous.status);
        expect(replaceAssetTags).not.toHaveBeenCalled();
      } finally {
        replaceAssetTags.mockRestore();
      }
      expect(assetTagRows(asset.id)).toEqual(before);
    });

    it('marks the Asset detail regions and identity the in-place refresh reads', async () => {
      const projectId = await createProject('JSON Refresh Markers');
      const asset = createAsset(projectId, 'json-markers.png');
      const tag = createTag('Json Marker');
      assignAssetTags(asset.id, [tag.id]);

      const detail = await agent.get(`/projects/${projectId}/assets/${asset.id}`).expect(200);
      expect(detail.text).toContain(
        `<div class="asset-preview-viewer" data-asset-viewer-host data-asset-viewer-project-id="${projectId}" data-asset-viewer-asset-id="${asset.id}">`,
      );
      expect(detail.text).toContain('data-asset-viewer-region="tags"');
      expect(section(detail.text, 'asset-tags-section')).toContain('Json Marker');
      const editDialog = detail.text.match(/<dialog id="asset-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(editDialog).toContain(`data-confirmed-tag-ids="${tag.id}"`);
      expect(editDialog).toContain('data-asset-tags-form');
      // The tag save reports through the dialog's one live region.
      expect((editDialog.match(/data-dialog-status/g) || [])).toHaveLength(1);
      expect((detail.text.match(/aria-live="polite"/g) || [])).toHaveLength(1);
    });
  });
  // WP10A1-F3: a delayed complete-set replacement, reviewed against an older
  // saved set (another tab, a reload, a lost answer), never overwrites a newer
  // one. The witness is compared inside the replacement transaction.
  describe('F3. reviewed tag-set witness', () => {
    const route = (projectId, assetId) => `/projects/${projectId}/assets/${assetId}/tags`;

    function postJson(url, body) {
      return agent.post(url).set('Accept', 'application/json').type('form').send(body);
    }

    function tagIdsOf(assetId) {
      return assetTagRows(assetId).map(({ tag_id: tagId }) => tagId);
    }

    function review(projectId, assetId, tagIds) {
      return assetTagReviewToken({ projectId, assetId, tagIds });
    }

    function formReview(html, projectId, assetId) {
      const form = html.match(new RegExp(`<form[^>]*action="/projects/${projectId}/assets/${assetId}/tags"[\\s\\S]*?</form>`))?.[0] || '';
      return form.match(/name="tagReview" value="([^"]*)"/)?.[1] ?? null;
    }

    async function fixture(title) {
      const projectId = await createProject(title);
      const asset = createAsset(projectId, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
      const alpha = createTag(`${title} Alpha`);
      const beta = createTag(`${title} Beta`);
      return { projectId, asset, alpha, beta, url: route(projectId, asset.id) };
    }

    it('H1. saves the complete set when the reviewed saved set is still current', async () => {
      const { projectId, asset, alpha, beta, url } = await fixture('F3 Current');
      assignAssetTags(asset.id, [alpha.id]);

      const response = await postJson(url, {
        origin: 'asset-edit',
        tagIds: [String(alpha.id), String(beta.id)],
        tagReview: review(projectId, asset.id, [alpha.id]),
        _csrf: csrfToken,
      }).expect(200);

      expect(response.body).toEqual(expect.objectContaining({
        status: 'success',
        outcome: 'committed',
        tagIds: expect.arrayContaining([alpha.id, beta.id]),
        tagReview: review(projectId, asset.id, [alpha.id, beta.id]),
      }));
      expect(tagIdsOf(asset.id)).toEqual([alpha.id, beta.id].sort((a, b) => a - b));
    });

    it('H2. refuses an older review after another save changed the set, keeping the newer tags', async () => {
      const { projectId, asset, alpha, beta, url } = await fixture('F3 Stale');
      // Tabs A and B both review the empty saved set.
      const reviewedEmpty = review(projectId, asset.id, []);

      await postJson(url, {
        origin: 'asset-edit',
        tagIds: [String(alpha.id), String(beta.id)],
        tagReview: reviewedEmpty,
        _csrf: csrfToken,
      }).expect(200);
      const newer = assetTagRows(asset.id);

      const stale = await postJson(url, {
        origin: 'asset-edit',
        tagIds: [String(alpha.id)],
        tagReview: reviewedEmpty,
        _csrf: csrfToken,
      }).expect(409);

      expect(stale.body).toEqual({
        status: 'error',
        code: 'TAG_SET_STALE',
        outcome: 'refused',
        message: expect.stringMatching(/saved tags changed.*not saved/i),
        errors: { tagIds: expect.any(String) },
        submittedTagIds: [String(alpha.id)],
      });
      expect(JSON.stringify(stale.body)).not.toMatch(/sqlite|SELECT |FROM asset_tags|[A-Z]:\\|\/tmp\//);
      // Untouched: the same rows, created_at included.
      expect(assetTagRows(asset.id)).toEqual(newer);
    });

    it('H3. witnesses an empty saved baseline distinctly from a missing witness', async () => {
      const { projectId, asset, alpha, url } = await fixture('F3 Expected Empty');
      const emptyReview = review(projectId, asset.id, []);
      expect(emptyReview).toMatch(/^t1\.[A-Za-z0-9_-]{43}$/);
      expect(emptyReview).not.toBe(review(projectId, asset.id, [alpha.id]));

      const page = await agent.get(`/projects/${projectId}/assets/${asset.id}?edit=1`).expect(200);
      expect(formReview(page.text, projectId, asset.id)).toBe(emptyReview);

      await postJson(url, {
        origin: 'asset-edit', tagIds: [String(alpha.id)], tagReview: emptyReview, _csrf: csrfToken,
      }).expect(200);
      expect(tagIdsOf(asset.id)).toEqual([alpha.id]);
    });

    it('H4. removes every tag for a current review, and refuses a stale empty replacement', async () => {
      const { projectId, asset, alpha, beta, url } = await fixture('F3 Desired Empty');
      assignAssetTags(asset.id, [alpha.id, beta.id]);

      // Current review of {Alpha, Beta}; no tagIds field: the explicit empty set.
      const cleared = await postJson(url, {
        origin: 'asset-edit', tagReview: review(projectId, asset.id, [alpha.id, beta.id]), _csrf: csrfToken,
      }).expect(200);
      expect(cleared.body).toEqual(expect.objectContaining({ outcome: 'committed', tagIds: [], tags: [] }));
      expect(tagIdsOf(asset.id)).toEqual([]);

      // A stale empty replacement reviewed against {Alpha} while {Alpha, Beta} is saved.
      assignAssetTags(asset.id, [alpha.id, beta.id]);
      const newer = assetTagRows(asset.id);
      const stale = await postJson(url, {
        origin: 'asset-edit', tagReview: review(projectId, asset.id, [alpha.id]), _csrf: csrfToken,
      }).expect(409);
      expect(stale.body).toEqual(expect.objectContaining({ code: 'TAG_SET_STALE', outcome: 'refused', submittedTagIds: [] }));
      expect(assetTagRows(asset.id)).toEqual(newer);
    });

    it('H5. refuses a missing, empty, malformed, duplicated, nested, foreign or tampered witness before replacing', async () => {
      const { projectId, asset, alpha, beta, url } = await fixture('F3 Invalid');
      const otherProjectId = await createProject('F3 Invalid Other');
      const otherAsset = createAsset(projectId, 'f3-invalid-other.png');
      assignAssetTags(asset.id, [alpha.id]);
      const before = assetTagRows(asset.id);
      const current = review(projectId, asset.id, [alpha.id]);
      const tampered = `${current.slice(0, -1)}${current.endsWith('A') ? 'B' : 'A'}`;
      const desired = [String(alpha.id), String(beta.id)];
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags');

      try {
        // Shape refusals: decided by the route before the service is called.
        for (const tagReview of [undefined, '', 'garbage', `v1.${'A'.repeat(43)}`, [current, current], { nested: current }]) {
          const response = await postJson(url, { origin: 'asset-edit', tagIds: desired, tagReview, _csrf: csrfToken }).expect(422);
          expect(response.body).toEqual(expect.objectContaining({
            status: 'error', code: 'TAG_REVIEW_INVALID', outcome: 'refused', submittedTagIds: desired,
          }));
        }
        for (const raw of [
          `origin=asset-edit&tagIds%5B%5D=${beta.id}&tagReview=${current}&tagReview=${current}`,
          `origin=asset-edit&tagIds%5B%5D=${beta.id}&tagReview%5Bdeep%5D%5Bx%5D=${current}`,
        ]) {
          const response = await agent.post(url)
            .set('Accept', 'application/json')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send(`${raw}&_csrf=${encodeURIComponent(csrfToken)}`)
            .expect(422);
          expect(response.body.code).toBe('TAG_REVIEW_INVALID');
        }
        expect(replaceAssetTags).not.toHaveBeenCalled();

        // Well-formed but naming another project, another asset or nothing:
        // a mismatch, refused inside the transaction before any change.
        for (const tagReview of [
          review(otherProjectId, asset.id, [alpha.id]),
          review(projectId, otherAsset.id, [alpha.id]),
          tampered,
          review(projectId, asset.id, desired),
        ]) {
          const response = await postJson(url, { origin: 'asset-edit', tagIds: desired, tagReview, _csrf: csrfToken }).expect(409);
          expect(response.body).toEqual(expect.objectContaining({ code: 'TAG_SET_STALE', outcome: 'refused' }));
        }
      } finally {
        replaceAssetTags.mockRestore();
      }
      expect(assetTagRows(asset.id)).toEqual(before);
      expect(assetTagRows(otherAsset.id)).toEqual([]);
    });

    it('H6. keeps the native forms on their contract and refuses a missing or stale native witness', async () => {
      const { projectId, asset, alpha, beta, url } = await fixture('F3 Native');
      assignAssetTags(asset.id, [alpha.id]);

      // Valid native Edit Asset save: the redirect contract is unchanged.
      const saved = await agent.post(url).type('form').send({
        origin: 'asset-edit',
        tagIds: [String(alpha.id), String(beta.id)],
        tagReview: review(projectId, asset.id, [alpha.id]),
        _csrf: csrfToken,
      }).expect(302);
      expect(saved.headers.location).toBe(`/projects/${projectId}/assets/${asset.id}?notice=asset_tags_updated&edit=1`);
      const newer = assetTagRows(asset.id);

      // Missing witness: 422 viewer page, nothing changed.
      const missing = await agent.post(url).type('form').send({
        origin: 'asset-edit', tagIds: [String(beta.id)], tagReview: undefined, _csrf: csrfToken,
      }).expect(422);
      expect(missing.text).toContain('could not be checked against the saved tags');
      expect(assetTagRows(asset.id)).toEqual(newer);

      // Stale native Edit Asset save: 409 viewer page with the submitted
      // selection kept as a draft and the witness of what is saved now.
      const stale = await agent.post(url).type('form').send({
        origin: 'asset-edit', tagIds: [String(beta.id)], tagReview: review(projectId, asset.id, [alpha.id]), _csrf: csrfToken,
      }).expect(409);
      expect(stale.text).toContain('The saved tags changed after this selection was reviewed');
      expect(stale.text).toContain(`data-confirmed-tag-ids="${[alpha.id, beta.id].sort((a, b) => a - b).join(',')}"`);
      expect(formReview(stale.text, projectId, asset.id)).toBe(review(projectId, asset.id, [alpha.id, beta.id]));
      expect(assetTagRows(asset.id)).toEqual(newer);

      // The standalone tags page: stale refused (409 page), current saved.
      const standaloneStale = await agent.post(url).type('form').send({
        tagIds: [String(beta.id)], tagReview: review(projectId, asset.id, []), _csrf: csrfToken,
      }).expect(409);
      expect(standaloneStale.text).toContain('The saved tags changed after this selection was reviewed');
      expect(checkboxMarkup(standaloneStale.text, beta.id)).toContain('checked');
      expect(checkboxMarkup(standaloneStale.text, alpha.id)).not.toContain('checked');
      expect(formReview(standaloneStale.text, projectId, asset.id)).toBe(review(projectId, asset.id, [alpha.id, beta.id]));
      expect(assetTagRows(asset.id)).toEqual(newer);

      const page = await agent.get(url).expect(200);
      const standaloneSaved = await agent.post(url).type('form').send({
        tagIds: [String(beta.id)], tagReview: formReview(page.text, projectId, asset.id), _csrf: csrfToken,
      }).expect(302);
      expect(standaloneSaved.headers.location).toBe(`/projects/${projectId}/assets/${asset.id}?notice=asset_tags_updated`);
      expect(tagIdsOf(asset.id)).toEqual([beta.id]);
    });

    it('H7. keeps ownership and archive refusals ahead of a valid witness', async () => {
      const { projectId, asset, alpha, url } = await fixture('F3 Guards');
      const otherProjectId = await createProject('F3 Guards Other');
      const valid = review(projectId, asset.id, []);
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags');
      try {
        // The asset under another project's URL: not found, whatever the witness says.
        await postJson(route(otherProjectId, asset.id), {
          origin: 'asset-edit', tagIds: [String(alpha.id)], tagReview: valid, _csrf: csrfToken,
        }).expect(404);
        await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
        const archived = await postJson(url, {
          origin: 'asset-edit', tagIds: [String(alpha.id)], tagReview: valid, _csrf: csrfToken,
        }).expect(409);
        expect(archived.body.code).toBe('PROJECT_ARCHIVED');
        expect(replaceAssetTags).not.toHaveBeenCalled();
      } finally {
        replaceAssetTags.mockRestore();
      }
      expect(tagIdsOf(asset.id)).toEqual([]);
    });

    it('H8. compares the witness with the set read inside the replacement transaction, all or nothing', async () => {
      const { createTagRepository } = await import('../src/data/tag-repository.js');
      const { createAssetRepository } = await import('../src/data/asset-repository.js');
      const { createAssetTagService, AssetTagSetStaleError } = await import('../src/services/asset-tag-service.js');
      const { projectId, asset, alpha, beta } = await fixture('F3 Atomic');
      const gamma = createTag('F3 Atomic Gamma');
      assignAssetTags(asset.id, [alpha.id]);
      const reviewedAlpha = review(projectId, asset.id, [alpha.id]);

      const tagRepository = createTagRepository(db);
      const realReplace = tagRepository.replaceForAsset;
      const observed = [];
      // Another writer commits {Beta, Gamma} after the service's own checks and
      // before its replacement transaction begins.
      tagRepository.replaceForAsset = (assetId, tagIds, options = {}) => {
        realReplace(assetId, [beta.id, gamma.id]);
        return realReplace(assetId, tagIds, {
          precondition: (stored) => {
            observed.push({ inTransaction: db.inTransaction, stored: [...stored].sort((a, b) => a - b) });
            return options.precondition(stored);
          },
        });
      };
      const service = createAssetTagService({ tagRepository, assetRepository: createAssetRepository(db) });

      expect(() => service.replaceAssetTags(asset.id, [alpha.id], { expectedReview: reviewedAlpha }))
        .toThrow(AssetTagSetStaleError);
      expect(observed).toEqual([{ inTransaction: true, stored: [beta.id, gamma.id] }]);
      // No partial replacement: exactly the newer set.
      expect(tagIdsOf(asset.id)).toEqual([beta.id, gamma.id]);
    });

    it('H9. keeps the unconditional replacement for existing service callers', async () => {
      const { createTagRepository } = await import('../src/data/tag-repository.js');
      const { AssetTagReviewInvalidError } = await import('../src/services/asset-tag-service.js');
      const { asset, alpha, beta } = await fixture('F3 Callers');
      assignAssetTags(asset.id, [alpha.id]);
      expect(app.locals.assetTagService.replaceAssetTags(asset.id, [beta.id]).map((tag) => tag.id)).toEqual([beta.id]);
      expect(app.locals.assetTagService.replaceAssetTags(asset.id, [alpha.id], {}).map((tag) => tag.id)).toEqual([alpha.id]);
      expect(createTagRepository(db).replaceForAsset(asset.id, [beta.id]).map((tag) => tag.id)).toEqual([beta.id]);
      // Asking for the check without a token is a caller error, never unconditional.
      expect(() => app.locals.assetTagService.replaceAssetTags(asset.id, [], { expectedReview: undefined }))
        .toThrow(AssetTagReviewInvalidError);
      expect(tagIdsOf(asset.id)).toEqual([beta.id]);
    });

    it('H10. renders an advanced witness after a save, so a follow-up save from a fresh form succeeds', async () => {
      const { projectId, asset, alpha, beta, url } = await fixture('F3 Follow Up');
      const first = await agent.get(`/projects/${projectId}/assets/${asset.id}?edit=1`).expect(200);
      const firstReview = formReview(first.text, projectId, asset.id);

      const saved = await postJson(url, {
        origin: 'asset-edit', tagIds: [String(alpha.id)], tagReview: firstReview, _csrf: csrfToken,
      }).expect(200);

      const second = await agent.get(`/projects/${projectId}/assets/${asset.id}?edit=1`).expect(200);
      const secondReview = formReview(second.text, projectId, asset.id);
      expect(secondReview).not.toBe(firstReview);
      expect(secondReview).toBe(saved.body.tagReview);

      await postJson(url, {
        origin: 'asset-edit', tagIds: [String(alpha.id), String(beta.id)], tagReview: secondReview, _csrf: csrfToken,
      }).expect(200);
      expect(tagIdsOf(asset.id)).toEqual([alpha.id, beta.id].sort((a, b) => a - b));
      // The first form's witness is now stale.
      await postJson(url, {
        origin: 'asset-edit', tagIds: [], tagReview: firstReview, _csrf: csrfToken,
      }).expect(409);
      expect(tagIdsOf(asset.id)).toEqual([alpha.id, beta.id].sort((a, b) => a - b));
    });

    it('H11. keeps catalog validation: a tag deleted after review is refused with no change', async () => {
      const { projectId, asset, alpha, beta, url } = await fixture('F3 Catalog');
      assignAssetTags(asset.id, [alpha.id]);
      const reviewed = review(projectId, asset.id, [alpha.id]);
      app.locals.tagService.deleteTag(beta.id);

      const response = await postJson(url, {
        origin: 'asset-edit', tagIds: [String(alpha.id), String(beta.id)], tagReview: reviewed, _csrf: csrfToken,
      }).expect(422);
      expect(response.body).toEqual(expect.objectContaining({ code: 'TAG_NOT_FOUND', outcome: 'refused' }));
      expect(tagIdsOf(asset.id)).toEqual([alpha.id]);
    });

    it('H12. reports an unexpected failure as unknown, never as nothing saved', async () => {
      const { projectId, asset, alpha, url } = await fixture('F3 Unknown');
      const replaceAssetTags = vi.spyOn(app.locals.assetTagService, 'replaceAssetTags')
        .mockImplementation(() => { throw new Error('SQLITE_BUSY at C:\\secret\\creatorcrate.db'); });
      try {
        const response = await postJson(url, {
          origin: 'asset-edit', tagIds: [String(alpha.id)], tagReview: review(projectId, asset.id, []), _csrf: csrfToken,
        }).expect(500);
        expect(response.body).toEqual({
          status: 'error',
          code: 'TAG_SAVE_FAILED',
          outcome: 'unknown',
          message: 'The asset tag save could not be confirmed.',
        });
        expect(response.body.message).not.toMatch(/nothing|no changes|not saved/i);
        expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|secret/);
      } finally {
        replaceAssetTags.mockRestore();
      }
    });
  });
});
