import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { createWorkflowQueryService } from '../src/services/workflow-query-service.js';
import { createTagRepository } from '../src/data/tag-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, { title, status = 'tbd', archivedAt = null }) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return db.prepare(`
    INSERT INTO projects (title, slug, description, notes, status,
                          planned_date, published_date, patreon_url, archived_at)
    VALUES (?, ?, '', '', ?, NULL, NULL, NULL, ?)
    RETURNING *
  `).get(title, slug, status, archivedAt);
}

function insertProjectCategory(db, {
  projectId,
  displayName,
  directorySlug,
  displayOrder = 0,
  enabled = 1,
}) {
  return db.prepare(`
    INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).get(projectId, displayName, directorySlug, displayOrder, enabled);
}

function insertGlobalCategory(db, {
  displayName,
  directorySlug,
  displayOrder = 0,
  enabled = 1,
}) {
  return db.prepare(`
    INSERT INTO asset_category_defaults (display_name, directory_slug, display_order, enabled)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `).get(displayName, directorySlug, displayOrder, enabled);
}

function insertAsset(db, {
  projectId,
  relativePath,
  filename = relativePath.split('/').pop(),
  extension = filename.includes('.') ? filename.split('.').pop() : '',
  categoryId = null,
  nestedPath = '',
  sizeBytes = 100,
  modifiedAt = null,
  isPresent = 1,
}) {
  return db.prepare(`
    INSERT INTO assets (project_id, category_id, relative_path, nested_path,
                        filename, extension, mime_type, size_bytes, modified_at,
                        is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, 'application/octet-stream', ?, ?, ?, datetime('now'),
            ${isPresent === 0 ? "datetime('now')" : 'NULL'})
    RETURNING *
  `).get(
    projectId,
    categoryId,
    relativePath,
    nestedPath,
    filename,
    extension,
    sizeBytes,
    modifiedAt,
    isPresent,
  );
}

function insertRelease(db, { projectId, title }) {
  return db.prepare(`
    INSERT INTO releases (project_id, title, description, notes,
                          planned_date, published_date, patreon_url, archived_at)
    VALUES (?, ?, '', '', NULL, NULL, NULL, NULL)
    RETURNING *
  `).get(projectId, title);
}

function linkAssetToRelease(db, releaseId, assetId) {
  db.prepare(`
    INSERT INTO release_assets (release_id, asset_id, role, sort_order)
    VALUES (?, ?, 'attachment', 0)
  `).run(releaseId, assetId);
}

describe('workflow query service — asset library page model', () => {
  let db;
  let tmpDir;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-library-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    service = createWorkflowQueryService({ db });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns assets from multiple projects with complete, read-only filter options', () => {
    insertGlobalCategory(db, { displayName: 'Library Source Files', directorySlug: 'library-source', displayOrder: 1 });
    insertGlobalCategory(db, { displayName: 'Library Disabled', directorySlug: 'library-disabled', displayOrder: 2, enabled: 0 });

    const alpha = insertProject(db, { title: 'Alpha Project' });
    const beta = insertProject(db, { title: 'Beta Project' });
    const archived = insertProject(db, { title: 'Archived Project', status: 'archived', archivedAt: '2026-01-01 00:00:00' });
    const alphaCategory = insertProjectCategory(db, {
      projectId: alpha.id,
      displayName: 'Alpha Source',
      directorySlug: 'library-source',
    });
    const betaCategory = insertProjectCategory(db, {
      projectId: beta.id,
      displayName: 'Beta Source',
      directorySlug: 'library-source',
    });

    const alphaAsset = insertAsset(db, {
      projectId: alpha.id,
      categoryId: alphaCategory.id,
      relativePath: 'source/alpha.png',
      filename: 'alpha.png',
      extension: 'PNG',
    });
    const betaAsset = insertAsset(db, {
      projectId: beta.id,
      categoryId: betaCategory.id,
      relativePath: 'source/beta.jpg',
      filename: 'beta.jpg',
      extension: 'JPG',
    });
    insertAsset(db, {
      projectId: alpha.id,
      relativePath: 'notes.txt',
      filename: 'notes.txt',
      extension: 'txt',
    });
    insertAsset(db, {
      projectId: archived.id,
      relativePath: 'hidden.kra',
      filename: 'hidden.kra',
      extension: 'kra',
    });
    const release = insertRelease(db, { projectId: beta.id, title: 'Beta Release' });
    linkAssetToRelease(db, release.id, betaAsset.id);

    const page = service.getAssetLibraryPage({
      category: 'library-source',
      page: 1,
      pageSize: 10,
      view: 'list',
    });

    expect(page.assets.map((asset) => asset.id)).toEqual([alphaAsset.id, betaAsset.id]);
    expect(page.assets.map((asset) => asset.project_id)).toEqual([alpha.id, beta.id]);
    expect(page.assets.find((asset) => asset.id === betaAsset.id)).toMatchObject({
      project_title: 'Beta Project',
      category_directory_slug: 'library-source',
      release_usage_count: 1,
      preview_state: 'unsupported',
      thumbnail_url: null,
      preview_url: null,
    });
    expect(page.total).toBe(2);
    expect(page.hasAnyAssets).toBe(true);

    expect(page.projectOptions).toEqual([
      { id: alpha.id, title: 'Alpha Project' },
      { id: beta.id, title: 'Beta Project' },
    ]);
    expect(page.categoryOptions.find((option) => option.value === 'all')).toMatchObject({
      label: 'All categories',
      selected: false,
    });
    expect(page.categoryOptions.find((option) => option.value === 'library-source')).toMatchObject({
      label: 'Library Source Files',
      selected: true,
    });
    expect(page.categoryOptions.some((option) => option.value === 'library-disabled')).toBe(false);
    expect(page.categoryOptions.every((option) => typeof option.value === 'string')).toBe(true);
    expect(page.extensionOptions).toEqual([
      { value: 'jpg', label: 'jpg', selected: false },
      { value: 'png', label: 'png', selected: false },
      { value: 'txt', label: 'txt', selected: false },
    ]);
    expect(page.tagOptions).toEqual([]);
    expect(page.presenceOptions.map((option) => option.value)).toEqual(['all', 'present', 'missing']);
    expect(page.usageOptions.map((option) => option.value)).toEqual(['all', 'used', 'unused']);
    expect(page.sortOptions.map((option) => option.value)).toEqual([
      'filename', 'modified', 'size', 'category', 'project',
    ]);
    expect(page.viewOptions.map((option) => option.value)).toEqual(['grid', 'list']);
    expect(page.viewOptions.find((option) => option.value === 'list').selected).toBe(true);

    expect(page).not.toHaveProperty('releaseTargets');
    expect(page).not.toHaveProperty('enabledCategories');
    expect(page).not.toHaveProperty('canMutate');
    expect(page).not.toHaveProperty('scan');
    expect(page).not.toHaveProperty('rename');
    expect(page).not.toHaveProperty('move');
    expect(page).not.toHaveProperty('primaryImage');
    expect(page).not.toHaveProperty('autoRename');
  });

  it('keeps project options complete and excludes archived projects independently of the asset page', () => {
    const projects = [];
    for (let index = 1; index <= 27; index++) {
      projects.push(insertProject(db, { title: `Project ${String(index).padStart(2, '0')}` }));
    }
    const archived = insertProject(db, {
      title: 'Project Archived',
      status: 'archived',
      archivedAt: '2026-01-01 00:00:00',
    });
    insertAsset(db, {
      projectId: projects[0].id,
      relativePath: 'only-page.png',
      filename: 'only-page.png',
      extension: 'png',
    });
    insertAsset(db, {
      projectId: archived.id,
      relativePath: 'not-visible.png',
      filename: 'not-visible.png',
      extension: 'png',
    });

    const page = service.getAssetLibraryPage({ page: 1, pageSize: 1 });

    expect(page.assets).toHaveLength(1);
    expect(page.projectOptions).toHaveLength(27);
    expect(page.projectOptions.map((project) => project.id)).toContain(projects[26].id);
    expect(page.projectOptions.map((project) => project.id)).not.toContain(archived.id);
    expect(page.assets.map((asset) => asset.project_id)).not.toContain(archived.id);
  });

  it('attaches release IDs and titles for the current page in one cross-project batch', () => {
    const alpha = insertProject(db, { title: 'Release Alpha Project' });
    const beta = insertProject(db, { title: 'Release Beta Project' });
    const noRelease = insertAsset(db, {
      projectId: alpha.id,
      relativePath: 'a-no-release.txt',
      filename: 'a-no-release.txt',
    });
    const single = insertAsset(db, {
      projectId: alpha.id,
      relativePath: 'b-single.txt',
      filename: 'b-single.txt',
    });
    const multiple = insertAsset(db, {
      projectId: alpha.id,
      relativePath: 'c-multiple.txt',
      filename: 'c-multiple.txt',
    });
    const other = insertAsset(db, {
      projectId: beta.id,
      relativePath: 'd-other.txt',
      filename: 'd-other.txt',
    });

    const singleRelease = insertRelease(db, { projectId: alpha.id, title: 'Single Release' });
    const zetaRelease = insertRelease(db, { projectId: alpha.id, title: 'zeta Release' });
    const alphaRelease = insertRelease(db, { projectId: alpha.id, title: 'Alpha Release' });
    const lowercaseAlphaRelease = insertRelease(db, { projectId: alpha.id, title: 'alpha Release' });
    const otherRelease = insertRelease(db, { projectId: beta.id, title: 'Other Release' });

    linkAssetToRelease(db, singleRelease.id, single.id);
    for (const release of [zetaRelease, alphaRelease, lowercaseAlphaRelease]) {
      linkAssetToRelease(db, release.id, multiple.id);
    }
    linkAssetToRelease(db, otherRelease.id, other.id);

    // Corrupt associations must not appear on either asset.
    linkAssetToRelease(db, otherRelease.id, multiple.id);
    linkAssetToRelease(db, singleRelease.id, other.id);

    const repository = createReleaseRepository(db);
    const batchCalls = [];
    const trackedReleaseRepository = {
      findReleaseTitlesForAssetIds(assetIds) {
        batchCalls.push([...assetIds]);
        return repository.findReleaseTitlesForAssetIds(assetIds);
      },
    };
    const libraryService = createWorkflowQueryService({
      db,
      releaseRepository: trackedReleaseRepository,
    });

    const page = libraryService.getAssetLibraryPage({ page: 1, pageSize: 10 });

    expect(batchCalls).toEqual([[noRelease.id, single.id, multiple.id, other.id]]);
    expect(page.assets.find((asset) => asset.id === noRelease.id).release_titles).toEqual([]);
    expect(page.assets.find((asset) => asset.id === single.id).release_titles).toEqual([
      { id: singleRelease.id, title: 'Single Release' },
    ]);
    expect(page.assets.find((asset) => asset.id === multiple.id).release_titles).toEqual([
      { id: alphaRelease.id, title: 'Alpha Release' },
      { id: lowercaseAlphaRelease.id, title: 'alpha Release' },
      { id: zetaRelease.id, title: 'zeta Release' },
    ]);
    expect(page.assets.find((asset) => asset.id === other.id).release_titles).toEqual([
      { id: otherRelease.id, title: 'Other Release' },
    ]);
  });

  it('attaches deterministic effective tags with direct origins winning in bounded batches', () => {
    const project = insertProject(db, { title: 'Asset Tags Project' });
    const first = insertAsset(db, {
      projectId: project.id,
      relativePath: 'a.png',
      filename: 'a.png',
    });
    const missing = insertAsset(db, {
      projectId: project.id,
      relativePath: 'b.png',
      filename: 'b.png',
      isPresent: 0,
    });
    const untagged = insertAsset(db, {
      projectId: project.id,
      relativePath: 'c.png',
      filename: 'c.png',
    });
    const outsidePage = insertAsset(db, {
      projectId: project.id,
      relativePath: 'z.png',
      filename: 'z.png',
    });

    const tagRepository = createTagRepository(db);
    const alpha = tagRepository.create({ displayName: 'Alpha Label', normalizedName: 'alpha-secret' });
    const shared = tagRepository.create({ displayName: 'Shared Label', normalizedName: 'shared-secret' });
    const zeta = tagRepository.create({ displayName: 'Zeta Label', normalizedName: 'zeta-secret' });
    const projectOnly = tagRepository.create({ displayName: 'Project Only Label', normalizedName: 'project-only-secret' });
    const outside = tagRepository.create({ displayName: 'Outside Page Label', normalizedName: 'outside-page-secret' });

    tagRepository.assignToProject(project.id, projectOnly.id);
    tagRepository.assignToProject(project.id, shared.id);
    for (const tag of [zeta, shared, alpha]) {
      tagRepository.assignToAsset(first.id, tag.id);
    }
    tagRepository.assignToAsset(missing.id, shared.id);
    tagRepository.assignToAsset(outsidePage.id, outside.id);

    const directBatchCalls = [];
    const inheritedBatchCalls = [];
    const taggedService = createWorkflowQueryService({
      db,
      tagRepository: {
        list() {
          return tagRepository.list();
        },
        listForAssetIds(assetIds) {
          directBatchCalls.push(assetIds);
          return tagRepository.listForAssetIds(assetIds);
        },
        listForProjectIds(projectIds) {
          inheritedBatchCalls.push(projectIds);
          return tagRepository.listForProjectIds(projectIds);
        },
      },
    });

    const page = taggedService.getAssetLibraryPage({ page: 1, pageSize: 3 });

    expect(directBatchCalls).toEqual([[first.id, missing.id, untagged.id]]);
    expect(inheritedBatchCalls).toEqual([[project.id]]);
    expect(page.assets.map((asset) => asset.id)).toEqual([first.id, missing.id, untagged.id]);
    expect(page.assets[0].tags).toEqual([
      { displayName: 'Alpha Label', origin: 'direct' },
      { displayName: 'Project Only Label', origin: 'inherited' },
      { displayName: 'Shared Label', origin: 'direct' },
      { displayName: 'Zeta Label', origin: 'direct' },
    ]);
    expect(page.assets[1]).toMatchObject({
      id: missing.id,
      is_present: 0,
      tags: [
        { displayName: 'Project Only Label', origin: 'inherited' },
        { displayName: 'Shared Label', origin: 'direct' },
      ],
    });
    expect(page.assets[2].tags).toEqual([
      { displayName: 'Project Only Label', origin: 'inherited' },
      { displayName: 'Shared Label', origin: 'inherited' },
    ]);
    expect(page.assets.flatMap((asset) => asset.tags.map((tag) => tag.displayName)))
      .toContain('Project Only Label');
    expect(page.assets.flatMap((asset) => asset.tags.map((tag) => tag.displayName)))
      .not.toContain('Outside Page Label');
    expect(page.assets[0].tags[0]).not.toHaveProperty('id');
    expect(page.assets[0].tags[0]).not.toHaveProperty('normalized_name');
    expect(page.assets[0].tags[0]).not.toHaveProperty('normalizedName');
  });

  it('validates selected tags against one deterministic full catalog and drops stale values', () => {
    const project = insertProject(db, { title: 'Catalog Validation Project' });
    const tagged = insertAsset(db, {
      projectId: project.id,
      relativePath: 'tagged.png',
      filename: 'tagged.png',
    });
    const untagged = insertAsset(db, {
      projectId: project.id,
      relativePath: 'untagged.png',
      filename: 'untagged.png',
    });
    const tagRepository = createTagRepository(db);
    const zeta = tagRepository.create({ displayName: 'Zeta Label', normalizedName: 'zeta-catalog-secret' });
    const alpha = tagRepository.create({ displayName: 'Alpha Label', normalizedName: 'alpha-catalog-secret' });
    tagRepository.assignToAsset(tagged.id, zeta.id);

    let catalogCalls = 0;
    const taggedService = createWorkflowQueryService({
      db,
      tagRepository: {
        list() {
          catalogCalls += 1;
          return tagRepository.list();
        },
        listForAssetIds(assetIds) {
          return tagRepository.listForAssetIds(assetIds);
        },
        listForProjectIds(projectIds) {
          return tagRepository.listForProjectIds(projectIds);
        },
      },
    });

    const selected = taggedService.getAssetLibraryPage({ tags: [zeta.id], pageSize: 10 });

    expect(catalogCalls).toBe(1);
    expect(selected.filters.tags).toEqual([zeta.id]);
    expect(selected.context.tags).toEqual([zeta.id]);
    expect(selected.tagOptions).toEqual([
      { value: String(alpha.id), displayName: 'Alpha Label', selected: false },
      { value: String(zeta.id), displayName: 'Zeta Label', selected: true },
    ]);
    expect(selected.assets.map((asset) => asset.id)).toEqual([tagged.id]);
    expect(selected.tagOptions[0]).not.toHaveProperty('normalizedName');
    expect(selected.tagOptions[0]).not.toHaveProperty('normalized_name');
    expect(selected.tagOptions[0]).not.toHaveProperty('usageCount');

    tagRepository.deleteById(zeta.id);
    const stale = taggedService.getAssetLibraryPage({ tags: [zeta.id], pageSize: 10 });

    expect(catalogCalls).toBe(2);
    expect(stale.filters.tags).toEqual([]);
    expect(stale.context.tags).toEqual([]);
    expect(stale.assets.map((asset) => asset.id)).toEqual([tagged.id, untagged.id]);
    expect(stale.filters).not.toHaveProperty('tag');
    expect(stale.filters).not.toHaveProperty('category');
    expect(stale.filters).not.toHaveProperty('extension');
  });

  it('exposes canonical multi-value selections and selected option metadata', () => {
    insertGlobalCategory(db, { displayName: 'Final', directorySlug: 'final', displayOrder: 1 });
    insertGlobalCategory(db, { displayName: 'KRZ', directorySlug: 'krz', displayOrder: 2 });

    const project = insertProject(db, { title: 'Multi-Value Project' });
    const finalCategory = insertProjectCategory(db, {
      projectId: project.id,
      displayName: 'Final',
      directorySlug: 'final',
      displayOrder: 1,
    });
    const krzCategory = insertProjectCategory(db, {
      projectId: project.id,
      displayName: 'KRZ',
      directorySlug: 'krz',
      displayOrder: 2,
    });
    const finalAsset = insertAsset(db, {
      projectId: project.id,
      categoryId: finalCategory.id,
      relativePath: 'final/a-scene.png',
      filename: 'a-scene.png',
      extension: 'png',
    });
    const krzAsset = insertAsset(db, {
      projectId: project.id,
      categoryId: krzCategory.id,
      relativePath: 'krz/b-scene.krz',
      filename: 'b-scene.krz',
      extension: 'krz',
    });
    const direct = createTagRepository(db).create({ displayName: 'Direct', normalizedName: 'direct-multi-secret' });
    const inherited = createTagRepository(db).create({ displayName: 'Inherited', normalizedName: 'inherited-multi-secret' });
    createTagRepository(db).assignToAsset(finalAsset.id, direct.id);
    createTagRepository(db).assignToProject(project.id, inherited.id);

    const page = service.getAssetLibraryPage({
      tags: [inherited.id, direct.id, inherited.id, 999999],
      categories: ['krz', 'final', 'all', 'unavailable'],
      extensions: ['.PNG', 'krz', 'png', 'unavailable'],
      pageSize: 10,
    });

    expect(page.filters).toMatchObject({
      tags: [direct.id, inherited.id].sort((left, right) => left - right),
      categories: ['final', 'krz'],
      extensions: ['krz', 'png'],
    });
    expect(page.filters).not.toHaveProperty('tag');
    expect(page.filters).not.toHaveProperty('category');
    expect(page.filters).not.toHaveProperty('extension');
    expect(page.assets.map((asset) => asset.id)).toEqual([finalAsset.id, krzAsset.id]);
    expect(page.total).toBe(2);
    expect(page.categoryOptions.filter((option) => option.selected).map((option) => option.value))
      .toEqual(['final', 'krz']);
    expect(page.extensionOptions.filter((option) => option.selected).map((option) => option.value))
      .toEqual(['krz', 'png']);
    expect(page.tagOptions.filter((option) => option.selected).map((option) => Number(option.value)))
      .toEqual([direct.id, inherited.id].sort((left, right) => left - right));
  });

  it('passes normalized filters through and preserves them with the requested presentation state', () => {
    const project = insertProject(db, { title: 'Filtered Project' });
    const category = insertProjectCategory(db, {
      projectId: project.id,
      displayName: 'Source',
      directorySlug: 'source',
    });
    const first = insertAsset(db, {
      projectId: project.id,
      categoryId: category.id,
      relativePath: 'source/keep-a.png',
      filename: 'keep-a.png',
      extension: 'png',
      isPresent: 1,
    });
    const used = insertAsset(db, {
      projectId: project.id,
      categoryId: category.id,
      relativePath: 'source/keep-b.png',
      filename: 'keep-b.png',
      extension: 'png',
      isPresent: 1,
    });
    const second = insertAsset(db, {
      projectId: project.id,
      categoryId: category.id,
      relativePath: 'source/keep-c.png',
      filename: 'keep-c.png',
      extension: 'png',
      isPresent: 1,
    });
    const release = insertRelease(db, { projectId: project.id, title: 'Used Release' });
    linkAssetToRelease(db, release.id, used.id);

    const page = service.getAssetLibraryPage({
      projectId: project.id,
      categories: ['source'],
      search: 'keep',
      extensions: ['png'],
      presence: 'present',
      usage: 'unused',
      sort: 'filename',
      order: 'asc',
      page: 2,
      pageSize: 1,
      view: 'list',
    });

    expect(page.assets.map((asset) => asset.id)).toEqual([second.id]);
    expect(page.total).toBe(2);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(1);
    expect(page.pageCount).toBe(2);
    expect(page.hasPreviousPage).toBe(true);
    expect(page.hasNextPage).toBe(false);
    expect(page.filters).toEqual({
      projectId: project.id,
      categories: ['source'],
      tags: [],
      search: 'keep',
      extensions: ['png'],
      presence: 'present',
      usage: 'unused',
      sort: 'filename',
      order: 'asc',
      view: 'list',
    });
    expect(page.presentation).toEqual({ view: 'list' });
    expect(page.context).toMatchObject({
      ...page.filters,
      page: 2,
      pageSize: 1,
    });
    expect(page.projectOptions).toContainEqual({ id: project.id, title: 'Filtered Project' });
    expect(page.categoryOptions.find((option) => option.value === 'source').selected).toBe(true);
    expect(page.extensionOptions.find((option) => option.value === 'png').selected).toBe(true);
    expect(page.presenceOptions.find((option) => option.value === 'present').selected).toBe(true);
    expect(page.usageOptions.find((option) => option.value === 'unused').selected).toBe(true);
    expect(page.sortOptions.find((option) => option.value === 'filename').selected).toBe(true);
    expect(page.viewOptions.find((option) => option.value === 'list').selected).toBe(true);
    expect(first.id).not.toBe(second.id);
  });

  it('calculates zero, one-page, multiple-page, and later-page metadata safely', () => {
    const empty = service.getAssetLibraryPage({ page: 9, pageSize: 2 });
    expect(empty).toMatchObject({
      assets: [],
      total: 0,
      page: 1,
      pageSize: 2,
      pageCount: 1,
      hasPreviousPage: false,
      hasNextPage: false,
      hasAnyAssets: false,
    });

    const project = insertProject(db, { title: 'Pagination Project' });
    for (const filename of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      insertAsset(db, {
        projectId: project.id,
        relativePath: filename,
        filename,
        extension: 'txt',
      });
    }

    const onePage = service.getAssetLibraryPage({ page: 1, pageSize: 10 });
    expect(onePage).toMatchObject({
      total: 5,
      page: 1,
      pageSize: 10,
      pageCount: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    });

    const firstPage = service.getAssetLibraryPage({ page: 1, pageSize: 2 });
    expect(firstPage.assets.map((asset) => asset.filename)).toEqual(['a.txt', 'b.txt']);
    expect(firstPage).toMatchObject({ page: 1, pageCount: 3, hasPreviousPage: false, hasNextPage: true });

    const middlePage = service.getAssetLibraryPage({ page: 2, pageSize: 2 });
    expect(middlePage.assets.map((asset) => asset.filename)).toEqual(['c.txt', 'd.txt']);
    expect(middlePage).toMatchObject({ page: 2, pageCount: 3, hasPreviousPage: true, hasNextPage: true });

    const laterPage = service.getAssetLibraryPage({ page: 99, pageSize: 2 });
    expect(laterPage.assets.map((asset) => asset.filename)).toEqual(['e.txt']);
    expect(laterPage).toMatchObject({ page: 3, pageCount: 3, hasPreviousPage: true, hasNextPage: false });
  });

  it('keeps the existing project-scoped browser read model available and separate', () => {
    const project = insertProject(db, { title: 'Project Browser Regression' });
    insertAsset(db, {
      projectId: project.id,
      relativePath: 'asset.txt',
      filename: 'asset.txt',
      extension: 'txt',
    });

    const projectPage = service.getProjectAssetBrowser(project.id, { pageSize: '1' });
    const libraryPage = service.getAssetLibraryPage({ pageSize: 1 });

    expect(projectPage.assets).toHaveLength(1);
    expect(projectPage.pageSize).toBe(1);
    expect(projectPage).toHaveProperty('releaseTargets');
    expect(libraryPage.assets).toHaveLength(1);
    expect(libraryPage).not.toHaveProperty('releaseTargets');
  });
});
