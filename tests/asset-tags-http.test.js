import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

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
    app = createApp({ appName: APP_NAME, db, projectsRoot, previewRoot }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
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
    expect(editDialog).toContain('data-dialog-backdrop-static');
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
});
