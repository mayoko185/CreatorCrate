import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { TAG_NAME_MAX } from '../src/services/tag-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function activeNavKeys(html, expectedCurrentSettingsChild) {
  activeSettingsNavLabels(html, expectedCurrentSettingsChild);
  const activeParents = [...html.matchAll(
    /<li class="(?:app-nav-item|mobile-nav-item)[^"]*--active[^"]*">[\s\S]*?<a href="[^"]+" class="(?:app-nav-link|mobile-nav-link)" data-nav-key="([^"]+)"/g,
  )];
  return [...new Set(activeParents.map((match) => match[1]))];
}

function activeSettingsNavLabels(html, expectedCurrentSettingsChild) {
  expect(html).not.toContain('<nav class="settings-nav"');
  expect(html).toContain('class="app-nav-item app-nav-item--active app-nav-item--has-children"');
  expect(html).toContain('class="mobile-nav-item mobile-nav-item--active mobile-nav-item--has-children"');
  expect(html).not.toMatch(/<a\b(?=[^>]*\bdata-nav-key="settings")(?=[^>]*\baria-current="page")[^>]*>/);

  const currentChildren = [...html.matchAll(
    /<a\b(?=[^>]*\bclass="(?:app-nav-child-link|mobile-nav-child-link)")(?=[^>]*\bdata-nav-key="(settings-[^"]+)")(?=[^>]*\baria-current="page")[^>]*>([^<]+)<\/a>/g,
  )];
  expect(currentChildren).toHaveLength(2);
  expect(new Set(currentChildren.map((match) => match[1]))).toEqual(new Set([expectedCurrentSettingsChild]));
  return [...new Set(currentChildren.map((match) => match[2]))];
}

function listedTagNames(html) {
  const tagList = html.match(/<h3>Tags<\/h3>[\s\S]*?<ul class="settings-tag-list">([\s\S]*?)<\/ul>/)?.[1] || '';
  return [...tagList.matchAll(/<span class="settings-tag-name">\s*([^<]+?)\s*<\/span>/g)]
    .map((match) => match[1].trim());
}

describe('settings — tags HTTP', () => {
  let tmpDir;
  let db;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-tags-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const app = createApp({ appName: APP_NAME, db }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createTag(name) {
    return agent.post('/settings/tags').type('form').send({ name, _csrf: csrfToken }).expect(302);
  }

  function findTagByName(name) {
    return db.prepare('SELECT * FROM tags WHERE display_name = ?').get(name);
  }

  function createProject(title = 'Settings Tags Project') {
    return Number(db.prepare(`
      INSERT INTO projects (
        title, slug, description, notes, status,
        planned_date, published_date, patreon_url
      ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
    `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
  }

  function createAsset(projectId, relativePath = 'source/cover.png') {
    const filename = relativePath.split('/').pop();
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(projectId, relativePath, filename).lastInsertRowid);
  }

  it('renders the heading, active navigation, accessible form, and empty state', async () => {
    const res = await agent.get('/settings/tags').expect(200);

    expect(res.text).toContain('<h1 class="app-section-title">Settings — Tags</h1>');
    expect(activeNavKeys(res.text, 'settings-tags')).toEqual(['settings']);
    expect(activeSettingsNavLabels(res.text, 'settings-tags')).toEqual(['Tags']);
    expect(res.text).toContain('No tags yet');
    expect(res.text).toContain('<label for="tag-name">Tag name');
    expect(res.text).toContain(`id="tag-name" name="name"`);
    expect(res.text).toContain('<div class="field settings-tags-name-field">');
    expect(res.text).toContain(`maxlength="${TAG_NAME_MAX}"`);
    expect(res.text).not.toContain('normalized_name');
    expect(res.text).not.toContain('Delete');
  });

  it('renders accessible rename and delete links for every listed tag', async () => {
    await createTag('Landscape');
    await createTag('Character Art');

    const tags = db.prepare('SELECT id, display_name FROM tags ORDER BY id').all();
    const res = await agent.get('/settings/tags').expect(200);

    for (const tag of tags) {
      expect(res.text).toContain(`href="/settings/tags/${tag.id}/edit"`);
      expect(res.text).toContain(`aria-label="Rename tag ${tag.display_name}"`);
      expect(res.text).toContain(`href="/settings/tags/${tag.id}/delete"`);
      expect(res.text).toContain(`aria-label="Delete tag ${tag.display_name}"`);
    }
    expect(res.text).not.toContain('normalized_name');
  });

  it('renders the populated list as intentional settings rows with scoped classes', async () => {
    await createTag('Landscape');
    await createTag('Character Art');

    const res = await agent.get('/settings/tags').expect(200);

    expect(res.text).toContain('<ul class="settings-tag-list">');
    const rowCount = (res.text.match(/<li class="settings-tag-row">/g) || []).length;
    expect(rowCount).toBe(2);
    expect((res.text.match(/<span class="settings-tag-name">/g) || []).length).toBe(2);
    expect((res.text.match(/<span class="settings-tag-actions">/g) || []).length).toBe(2);
    expect(res.text).toContain('<span class="settings-tag-name">Landscape</span>');
    expect(res.text).toContain('<span class="settings-tag-name">Character Art</span>');
  });

  it('renders existing tags in service order without exposing normalized names', async () => {
    await createTag('Zebra Tag');
    await createTag('Alpha Tag');

    const res = await agent.get('/settings/tags').expect(200);

    expect(listedTagNames(res.text)).toEqual(['Alpha Tag', 'Zebra Tag']);
    expect(res.text).not.toContain('alpha tag');
    expect(res.text).not.toContain('zebra tag');
  });

  it('renders the rename form with the current display name and active Settings navigation', async () => {
    await createTag('Current Display Name');
    const tag = findTagByName('Current Display Name');

    const res = await agent.get(`/settings/tags/${tag.id}/edit`).expect(200);

    expect(res.text).toContain('<h1 class="app-section-title">Settings — Rename Tag</h1>');
    expect(activeNavKeys(res.text, 'settings-tags')).toEqual(['settings']);
    expect(activeSettingsNavLabels(res.text, 'settings-tags')).toEqual(['Tags']);
    expect(res.text).toContain('Current tag: <strong>Current Display Name</strong>');
    expect(res.text).toContain('<label for="tag-name">Tag name');
    expect(res.text).toContain(`id="tag-name" name="name"`);
    expect(res.text).toContain(`value="Current Display Name"`);
    expect(res.text).toContain(`maxlength="${TAG_NAME_MAX}"`);
    expect(res.text).toContain(`action="/settings/tags/${tag.id}/edit"`);
    expect(res.text).not.toContain('normalized_name');
    expect(res.text).not.toContain('Delete');
  });

  it('renders the delete confirmation with the current tag name, warning, POST form, cancel link, and active navigation', async () => {
    await createTag('Tag To Delete');
    const tag = findTagByName('Tag To Delete');
    const before = db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id);

    const res = await agent.get(`/settings/tags/${tag.id}/delete`).expect(200);

    expect(res.text).toContain('<h1 class="app-section-title">Settings — Delete Tag</h1>');
    expect(activeNavKeys(res.text, 'settings-tags')).toEqual(['settings']);
    expect(activeSettingsNavLabels(res.text, 'settings-tags')).toEqual(['Tags']);
    expect(res.text).toContain('<h2>Delete this tag?</h2>');
    expect(res.text).toContain('Tag: <strong>Tag To Delete</strong>');
    expect(res.text).toContain('Deleting this tag removes it from all assigned projects and assets.');
    expect(res.text).toContain('Projects, assets, and their files are not deleted.');
    expect(res.text).toContain(`<form method="post" action="/settings/tags/${tag.id}/delete">`);
    expect(res.text).toContain('>Delete Tag</button>');
    expect(res.text).toContain('href="/settings/tags"');
    expect(res.text).not.toContain('data-confirm');
    expect(db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id)).toEqual(before);
  });

  it('returns the normal not-found response for malformed and missing tag IDs', async () => {
    await agent.get('/settings/tags/not-a-tag/edit').expect(404);
    await agent.get('/settings/tags/999999/edit').expect(404);
    await agent
      .post('/settings/tags/999999/edit')
      .type('form')
      .send({ name: 'Missing', _csrf: csrfToken })
      .expect(404);
    await agent.get('/settings/tags/not-a-tag/delete').expect(404);
    await agent.get('/settings/tags/999999/delete').expect(404);
    await agent
      .post('/settings/tags/not-a-tag/delete')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);
    await agent
      .post('/settings/tags/999999/delete')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);
  });

  it('creates a trimmed tag, preserves display capitalization, redirects, and shows its notice', async () => {
    const create = await createTag('  MiXeD Tag  ');

    expect(create.headers.location).toBe('/settings/tags?notice=tag_created');
    expect(db.prepare('SELECT display_name, normalized_name FROM tags').get()).toEqual({
      display_name: 'MiXeD Tag',
      normalized_name: 'mixed tag',
    });

    const redirected = await agent.get(create.headers.location).expect(200);
    expect(redirected.text).toContain('Tag created successfully.');
    expect(listedTagNames(redirected.text)).toEqual(['MiXeD Tag']);
  });

  it('renames a tag through the edit form, redirects, and shows the updated list', async () => {
    await createTag('Old Display Name');
    const tag = findTagByName('Old Display Name');

    const rename = await agent
      .post(`/settings/tags/${tag.id}/edit`)
      .type('form')
      .send({ name: '  New Display Name  ', _csrf: csrfToken })
      .expect(302);

    expect(rename.headers.location).toBe('/settings/tags?notice=tag_renamed');

    const redirected = await agent.get(rename.headers.location).expect(200);
    expect(redirected.text).toContain('Tag renamed successfully.');
    expect(redirected.text).toContain('New Display Name');
    expect(redirected.text).not.toContain('Old Display Name');
    expect(db.prepare('SELECT id, display_name, normalized_name FROM tags').get()).toEqual({
      id: tag.id,
      display_name: 'New Display Name',
      normalized_name: 'new display name',
    });
  });

  it('allows a capitalization-only rename while preserving the stable tag ID', async () => {
    await createTag('Landscape');
    const tag = findTagByName('Landscape');

    await agent
      .post(`/settings/tags/${tag.id}/edit`)
      .type('form')
      .send({ name: ' LANDSCAPE ', _csrf: csrfToken })
      .expect(302);

    expect(db.prepare('SELECT id, display_name, normalized_name FROM tags').get()).toEqual({
      id: tag.id,
      display_name: 'LANDSCAPE',
      normalized_name: 'landscape',
    });
  });

  it.each(['', '   '])('rejects an empty or whitespace-only rename with 422 and retained input: %j', async (name) => {
    await createTag('Existing Name');
    const tag = findTagByName('Existing Name');
    const before = db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id);

    const res = await agent
      .post(`/settings/tags/${tag.id}/edit`)
      .type('form')
      .send({ name, _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('Could not rename the tag.');
    expect(res.text).toContain('Tag name is required.');
    expect(res.text).toContain(`value="${name}"`);
    expect(res.text).toContain('aria-invalid="true"');
    expect(activeSettingsNavLabels(res.text, 'settings-tags')).toEqual(['Tags']);
    expect(db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id)).toEqual(before);
  });

  it('rejects an over-limit rename with 422 and retains the submitted text', async () => {
    await createTag('Existing Name');
    const tag = findTagByName('Existing Name');
    const name = 'x'.repeat(TAG_NAME_MAX + 1);
    const before = db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id);

    const res = await agent
      .post(`/settings/tags/${tag.id}/edit`)
      .type('form')
      .send({ name, _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain(`Tag name must be ${TAG_NAME_MAX} characters or fewer.`);
    expect(res.text).toContain(`value="${name}"`);
    expect(db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id)).toEqual(before);
  });

  it('rejects a duplicate case-insensitive rename with 422 without changing either tag', async () => {
    await createTag('Landscape');
    await createTag('Portrait');
    const first = findTagByName('Landscape');
    const second = findTagByName('Portrait');
    const before = db.prepare('SELECT id, display_name, normalized_name, updated_at FROM tags ORDER BY id').all();

    const res = await agent
      .post(`/settings/tags/${second.id}/edit`)
      .type('form')
      .send({ name: ' LANDSCAPE ', _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('A tag with this name already exists.');
    expect(res.text).toContain('value=" LANDSCAPE "');
    expect(res.text).toContain(`Current tag: <strong>${second.display_name}</strong>`);
    expect(db.prepare('SELECT id, display_name, normalized_name, updated_at FROM tags ORDER BY id').all())
      .toEqual(before);
    expect(db.prepare('SELECT id FROM tags WHERE display_name = ?').get(first.display_name)).toEqual({ id: first.id });
  });

  it('preserves project and asset assignments when a tag is renamed', async () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    await createTag('Assigned Tag');
    const tag = findTagByName('Assigned Tag');
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, tag.id);
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, tag.id);

    await agent
      .post(`/settings/tags/${tag.id}/edit`)
      .type('form')
      .send({ name: 'Renamed Assigned Tag', _csrf: csrfToken })
      .expect(302);

    expect(db.prepare('SELECT project_id, tag_id FROM project_tags WHERE tag_id = ?').all(tag.id))
      .toEqual([{ project_id: projectId, tag_id: tag.id }]);
    expect(db.prepare('SELECT asset_id, tag_id FROM asset_tags WHERE tag_id = ?').all(tag.id))
      .toEqual([{ asset_id: assetId, tag_id: tag.id }]);
  });

  it('reorders the tag list deterministically after a display-name change', async () => {
    await createTag('Gamma');
    await createTag('Zebra');
    await createTag('Alpha');
    const tag = findTagByName('Zebra');

    await agent
      .post(`/settings/tags/${tag.id}/edit`)
      .type('form')
      .send({ name: 'Beta', _csrf: csrfToken })
      .expect(302);

    const redirected = await agent.get('/settings/tags?notice=tag_renamed').expect(200);
    expect(listedTagNames(redirected.text)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('deletes through POST, cascades assignments, and preserves projects, assets, files, and other tags', async () => {
    const firstProjectId = createProject('Delete Project One');
    const secondProjectId = createProject('Delete Project Two');
    const firstAssetId = createAsset(firstProjectId, 'source/one.png');
    const secondAssetId = createAsset(secondProjectId, 'source/two.png');
    const filePaths = [
      path.join(tmpDir, 'source', 'one.png'),
      path.join(tmpDir, 'source', 'two.png'),
    ];
    for (const filePath of filePaths) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'preserve this file');
    }

    await createTag('Deleted Tag');
    await createTag('Retained Tag');
    await createTag('Other Tag');
    const deletedTag = findTagByName('Deleted Tag');
    const retainedTag = findTagByName('Retained Tag');
    const otherTag = findTagByName('Other Tag');

    for (const projectId of [firstProjectId, secondProjectId]) {
      db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, deletedTag.id);
      db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, retainedTag.id);
    }
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(firstProjectId, otherTag.id);
    for (const assetId of [firstAssetId, secondAssetId]) {
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, deletedTag.id);
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, retainedTag.id);
    }
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(firstAssetId, otherTag.id);

    const projectsBefore = db.prepare('SELECT * FROM projects ORDER BY id').all();
    const assetsBefore = db.prepare('SELECT * FROM assets ORDER BY id').all();

    const deletion = await agent
      .post(`/settings/tags/${deletedTag.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(deletion.headers.location).toBe('/settings/tags?notice=tag_deleted');
    expect(db.prepare('SELECT * FROM tags WHERE id = ?').get(deletedTag.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM tags WHERE id = ?').get(retainedTag.id)).toEqual(retainedTag);
    expect(db.prepare('SELECT * FROM tags WHERE id = ?').get(otherTag.id)).toEqual(otherTag);
    expect(db.prepare('SELECT * FROM project_tags WHERE tag_id = ?').all(deletedTag.id)).toEqual([]);
    expect(db.prepare('SELECT * FROM asset_tags WHERE tag_id = ?').all(deletedTag.id)).toEqual([]);
    expect(db.prepare('SELECT * FROM project_tags WHERE tag_id = ?').all(retainedTag.id)).toHaveLength(2);
    expect(db.prepare('SELECT * FROM asset_tags WHERE tag_id = ?').all(retainedTag.id)).toHaveLength(2);
    expect(db.prepare('SELECT * FROM project_tags WHERE tag_id = ?').all(otherTag.id)).toEqual([
      { project_id: firstProjectId, tag_id: otherTag.id, created_at: expect.any(String) },
    ]);
    expect(db.prepare('SELECT * FROM asset_tags WHERE tag_id = ?').all(otherTag.id)).toEqual([
      { asset_id: firstAssetId, tag_id: otherTag.id, created_at: expect.any(String) },
    ]);
    expect(db.prepare('SELECT * FROM projects ORDER BY id').all()).toEqual(projectsBefore);
    expect(db.prepare('SELECT * FROM assets ORDER BY id').all()).toEqual(assetsBefore);
    for (const filePath of filePaths) expect(fs.existsSync(filePath)).toBe(true);

    const redirected = await agent.get(deletion.headers.location).expect(200);
    expect(redirected.text).toContain('Tag deleted successfully.');
    expect(listedTagNames(redirected.text)).toEqual(['Other Tag', 'Retained Tag']);
    expect(redirected.text).not.toContain('Deleted Tag');
  });

  it('treats deletion between confirmation GET and POST, and reposting after deletion, as not found', async () => {
    await createTag('Race Tag');
    const tag = findTagByName('Race Tag');

    await agent.get(`/settings/tags/${tag.id}/delete`).expect(200);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);

    await agent
      .post(`/settings/tags/${tag.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);
    await agent
      .post(`/settings/tags/${tag.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);
  });

  it.each(['', '   '])('rejects an empty or whitespace-only name without creating a tag: %j', async (name) => {
    const res = await agent.post('/settings/tags').type('form').send({ name, _csrf: csrfToken }).expect(422);

    expect(res.text).toContain('Tag name is required.');
    expect(res.text).toContain(`value="${name}"`);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags').get().count).toBe(0);
  });

  it('rejects an over-limit name, preserves it, and does not create a tag', async () => {
    const name = 'x'.repeat(TAG_NAME_MAX + 1);
    const res = await agent.post('/settings/tags').type('form').send({ name, _csrf: csrfToken }).expect(422);

    expect(res.text).toContain(`Tag name must be ${TAG_NAME_MAX} characters or fewer.`);
    expect(res.text).toContain(`value="${name}"`);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags').get().count).toBe(0);
  });

  it('rejects a case-insensitive duplicate, preserves existing tags, and keeps the submitted value', async () => {
    await createTag('Landscape');

    const res = await agent
      .post('/settings/tags')
      .type('form')
      .send({ name: ' LANDSCAPE ', _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('A tag with this name already exists.');
    expect(res.text).toContain('value=" LANDSCAPE "');
    expect(listedTagNames(res.text)).toEqual(['Landscape']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags').get().count).toBe(1);
  });

  it('keeps existing Settings Defaults and Asset Categories routes unaffected', async () => {
    const defaults = await agent.get('/settings/defaults').expect(200);
    expect(defaults.text).toContain('Settings — Defaults');
    expect(activeSettingsNavLabels(defaults.text, 'settings-defaults')).toEqual(['Defaults']);

    const categories = await agent.get('/settings/asset-categories').expect(200);
    expect(categories.text).toContain('Settings — Asset Categories');
    expect(activeSettingsNavLabels(categories.text, 'settings-asset-categories')).toEqual(['Asset Categories']);
  });

  it('does not expose assignment controls or usage-count UI', async () => {
    await createTag('Existing');

    const page = await agent.get('/settings/tags').expect(200);
    expect(page.text).not.toContain('project_tags');
    expect(page.text).not.toContain('asset_tags');
    expect(page.text).not.toMatch(/usage\s+count/i);
    expect(page.text).not.toMatch(/assign\s+tag/i);
  });
});
