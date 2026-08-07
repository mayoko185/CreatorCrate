/**
 * Phase: asset actions chunk 2 — asset-action-service.
 *
 * Uses real temporary project directories on disk so rename/move, source
 * validation, and compensation can be exercised against actual filesystem
 * behavior rather than mocks, except where a test needs to deterministically
 * simulate a failure that occurs between two of the service's own syscalls
 * (never a real timing-based race — see the "residual behavior" section).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import { createProjectAssetCategoryService } from '../src/services/project-asset-category-service.js';
import { createProjectPrimaryImageRepository } from '../src/data/project-primary-image-repository.js';
import { createProjectPrimaryImageService } from '../src/services/project-primary-image-service.js';
import { createWorkflowQueryService } from '../src/services/workflow-query-service.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';
import {
  createAssetActionService,
  AssetActionError,
  UNCATEGORIZED,
} from '../src/services/asset-action-service.js';
import { createProjectOperationCoordinator, ProjectOperationError } from '../src/services/project-operation-coordinator.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { getCacheDir } from '../src/storage/preview-cache.js';
import { MANIFEST_FILENAME } from '../src/storage/manifest.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function symlinksSupported() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-symlink-probe-'));
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    fs.rmSync(tmp, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const HAS_SYMLINKS = symlinksSupported();

function validProjectInput(overrides = {}) {
  return {
    title: 'Test Project',
    description: '',
    notes: '',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}

describe('asset action service', () => {
  let tmpDir;
  let projectsRoot;
  let previewRoot;
  let db;
  let projectRepository;
  let assetRepository;
  let primaryImageRepository;
  let primaryImageService;
  let workflowQueryService;
  let assetCategoryRepository;
  let assetBrowserPreferenceRepository;
  let projectService;
  let categoryService;
  let actionService;
  let projectOperationCoordinator;
  let project;
  let absPath;

  function writeFile(relPath, content = 'bytes') {
    const target = path.join(absPath, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  }

  function createAsset(relativePath, overrides = {}) {
    const filename = relativePath.split('/').pop();
    const dotIndex = filename.lastIndexOf('.');
    const extension = dotIndex > 0 ? filename.slice(dotIndex + 1) : '';
    return assetRepository.upsert(project.id, relativePath, {
      filename,
      extension,
      mimeType: 'application/octet-stream',
      sizeBytes: 5,
      modifiedAt: null,
      categoryId: null,
      nestedPath: '',
      ...overrides,
    });
  }

  function createEnabledCategory(displayName, directorySlug) {
    return categoryService.add(project.id, { displayName, directorySlug });
  }

  function createDisabledCategory(displayName, directorySlug) {
    return categoryService.add(project.id, { displayName, directorySlug, enabled: false });
  }

  // A category row without ever creating its directory — simulates a
  // category whose directory was removed (or never created) out from
  // under the database record.
  function createCategoryRowWithoutDir(displayName, directorySlug, displayOrder = 0) {
    return assetCategoryRepository.addProjectCategory({
      projectId: project.id, displayName, directorySlug, displayOrder, enabled: true,
    });
  }

  function insertRelease(title = 'Release') {
    return db.prepare(`
      INSERT INTO releases (project_id, title, description, notes,
                            planned_date, published_date, patreon_url, archived_at)
      VALUES (?, ?, '', '', NULL, NULL, NULL, NULL)
      RETURNING id
    `).get(project.id, title);
  }

  function linkReleaseAsset(releaseId, assetId, role = 'attachment', sortOrder = 0) {
    db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)`)
      .run(releaseId, assetId, role, sortOrder);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-aas-'));
    projectsRoot = path.join(tmpDir, 'projects');
    previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(previewRoot, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    projectRepository = createProjectRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
    assetBrowserPreferenceRepository = createAssetBrowserPreferenceRepository(db);
    assetRepository = createAssetRepository(db);
    const assetCategoryService = createAssetCategoryService(assetCategoryRepository);
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository,
    });
    categoryService = createProjectAssetCategoryService({
      db,
      projectRepository,
      assetCategoryRepository,
      assetRepository,
      assetBrowserPreferenceRepository,
      projectsRoot,
    });
    projectOperationCoordinator = createProjectOperationCoordinator();
    actionService = createAssetActionService({
      projectRepository, assetRepository, assetCategoryRepository, projectsRoot, projectOperationCoordinator,
    });
    primaryImageRepository = createProjectPrimaryImageRepository(db);
    primaryImageService = createProjectPrimaryImageService({
      db,
      projectRepository,
      assetRepository,
      projectPrimaryImageRepository: primaryImageRepository,
    });
    workflowQueryService = createWorkflowQueryService({
      db,
      evaluateReleaseReadiness,
      projectPrimaryImageRepository: primaryImageRepository,
    });

    project = projectService.create(validProjectInput());
    absPath = resolveProjectDir(projectsRoot, project.project_dir);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Construction ────────────────────────────────────────────────────

  describe('construction', () => {
    it('requires every dependency', () => {
      expect(() => createAssetActionService({})).toThrow();
      expect(() => createAssetActionService({ projectRepository })).toThrow();
    });
  });

  // ─── renameAsset ───────────────────────────────────────────────────────

  describe('renameAsset', () => {
    it('renames a present root-level asset', () => {
      writeFile('old.png', 'content');
      const asset = createAsset('old.png');

      const result = actionService.renameAsset(project.id, asset.id, 'new.png');

      expect(result.relative_path).toBe('new.png');
      expect(result.filename).toBe('new.png');
      expect(fs.existsSync(path.join(absPath, 'old.png'))).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'new.png'))).toBe(true);
    });

    it('preserves the asset ID', () => {
      writeFile('old.png', 'content');
      const asset = createAsset('old.png');
      const result = actionService.renameAsset(project.id, asset.id, 'new.png');
      expect(result.id).toBe(asset.id);
    });

    it('preserves the primary selection across native rename and move while refreshing the query revision', () => {
      const sourcePath = writeFile('old.png', 'content');
      const sourceStats = fs.statSync(sourcePath);
      const asset = createAsset('old.png', {
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: sourceStats.size,
        modifiedAt: sourceStats.mtime.toISOString(),
      });
      primaryImageService.setPrimaryImage(project.id, asset.id);
      const renders = createEnabledCategory('Renders', 'renders');

      const getPrimaryImage = () => workflowQueryService.getProjectList({ limit: 25, offset: 0 })
        .rows.find((row) => row.id === project.id).primaryImage;
      const before = getPrimaryImage();
      const setSpy = vi.spyOn(primaryImageRepository, 'setPrimaryImage');
      const clearSpy = vi.spyOn(primaryImageRepository, 'clearPrimaryImageIfMatches');

      const renamed = actionService.renameAsset(project.id, asset.id, 'renamed.png');
      const afterRename = getPrimaryImage();

      expect(renamed.id).toBe(asset.id);
      expect(afterRename).toMatchObject({
        selectedAssetId: asset.id,
        state: 'available',
      });
      expect(afterRename.previewUrl).toBe(
        `/projects/${project.id}/assets/${asset.id}/preview?v=${afterRename.revision}`
      );
      expect(afterRename.revision).not.toBe(before.revision);

      const moved = actionService.moveAsset(project.id, asset.id, renders.id);
      const afterMove = getPrimaryImage();

      expect(moved).toMatchObject({ id: asset.id, relative_path: 'renders/renamed.png' });
      expect(afterMove).toMatchObject({
        selectedAssetId: asset.id,
        state: 'available',
      });
      expect(afterMove.previewUrl).toBe(
        `/projects/${project.id}/assets/${asset.id}/preview?v=${afterMove.revision}`
      );
      expect(afterMove.revision).not.toBe(afterRename.revision);
      expect(primaryImageRepository.findByProjectId(project.id)).toEqual({
        project_id: project.id,
        asset_id: asset.id,
      });
      expect(setSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('updates extension and MIME type when the extension changes', () => {
      writeFile('old.png', 'content');
      const asset = createAsset('old.png', { extension: 'png', mimeType: 'image/png' });

      const result = actionService.renameAsset(project.id, asset.id, 'new.jpg');

      expect(result.extension).toBe('jpg');
      expect(result.mime_type).toBe('image/jpeg');
    });

    it('renames from a basename while preserving the current extension', () => {
      writeFile('archive.final.png', 'content');
      const asset = createAsset('archive.final.png');

      const result = actionService.renameAssetBasename(project.id, asset.id, 'renamed');

      expect(result.relative_path).toBe('renamed.png');
      expect(result.filename).toBe('renamed.png');
      expect(fs.existsSync(path.join(absPath, 'archive.final.png'))).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'renamed.png'))).toBe(true);
    });

    it('validates the reconstructed filename for basename renames', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      expect(() => actionService.renameAssetBasename(project.id, asset.id, 'bad/name')).toThrow(AssetActionError);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
    });

    it('rejects a missing basename before reconstructing the filename', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      expect(() => actionService.renameAssetBasename(project.id, asset.id, undefined)).toThrow(AssetActionError);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
    });

    it('preserves only the final extension for multi-dot filenames', () => {
      writeFile('scene.v2.kra', 'content');
      const asset = createAsset('scene.v2.kra');

      const result = actionService.renameAssetBasename(project.id, asset.id, 'final-scene');

      expect(result.filename).toBe('final-scene.kra');
      expect(fs.existsSync(path.join(absPath, 'final-scene.kra'))).toBe(true);
    });

    it('keeps extensionless assets extensionless', () => {
      writeFile('README', 'content');
      const asset = createAsset('README');

      const result = actionService.renameAssetBasename(project.id, asset.id, 'NOTES');

      expect(result.filename).toBe('NOTES');
      expect(result.extension).toBe('');
      expect(fs.existsSync(path.join(absPath, 'NOTES'))).toBe(true);
    });

    it('rejects invalid, unchanged, and case-only basenames before filesystem mutation', () => {
      writeFile('photo.PNG', 'content');
      const asset = createAsset('photo.PNG');

      for (const [basename, code] of [
        ['photo', 'UNCHANGED_LOCATION'],
        ['PHOTO', 'CASE_ONLY_RENAME_UNSUPPORTED'],
        ['bad/name', 'INVALID_FILENAME'],
        ['bad.', 'INVALID_FILENAME'],
        ['CON', 'INVALID_FILENAME'],
      ]) {
        try {
          actionService.renameAssetBasename(project.id, asset.id, basename);
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(AssetActionError);
          expect(err.code).toBe(code);
        }
        expect(fs.existsSync(path.join(absPath, 'photo.PNG'))).toBe(true);
      }
    });

    it('preserves the current extension casing from the project path', () => {
      writeFile('photo.PNG', 'content');
      const asset = createAsset('photo.PNG');

      const result = actionService.renameAssetBasename(project.id, asset.id, 'renamed');

      expect(result.filename).toBe('renamed.PNG');
      expect(fs.existsSync(path.join(absPath, 'renamed.PNG'))).toBe(true);
    });

    it('preserves category_id and nested_path', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('renders/final/old.png', 'content');
      const asset = createAsset('renders/final/old.png', {
        categoryId: category.id, nestedPath: 'final',
      });

      const result = actionService.renameAsset(project.id, asset.id, 'new.png');

      expect(result.relative_path).toBe('renders/final/new.png');
      expect(result.category_id).toBe(category.id);
      expect(result.nested_path).toBe('final');
    });

    it('rejects an unchanged filename', () => {
      writeFile('same.png', 'content');
      const asset = createAsset('same.png');
      expect(() => actionService.renameAsset(project.id, asset.id, 'same.png')).toThrow(AssetActionError);
      try {
        actionService.renameAsset(project.id, asset.id, 'same.png');
      } catch (err) {
        expect(err.code).toBe('UNCHANGED_LOCATION');
      }
    });

    it('rejects a case-only rename', () => {
      writeFile('same.png', 'content');
      const asset = createAsset('same.png');
      try {
        actionService.renameAsset(project.id, asset.id, 'SAME.png');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('CASE_ONLY_RENAME_UNSUPPORTED');
      }
    });

    it('rejects an invalid filename', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      try {
        actionService.renameAsset(project.id, asset.id, '..');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('INVALID_FILENAME');
      }
      // No filesystem mutation attempted.
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
    });

    it('rejects Win32-forbidden characters before any filesystem mutation', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      for (const badName of ['foo<bar.png', 'foo>bar.png', 'foo:bar.png', 'foo"bar.png', 'foo|bar.png', 'foo?bar.png', 'foo*bar.png', 'C:foo.png']) {
        try {
          actionService.renameAsset(project.id, asset.id, badName);
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(AssetActionError);
          expect(err.code).toBe('INVALID_FILENAME');
        }
      }

      expect(renameSpy).not.toHaveBeenCalled();
      renameSpy.mockRestore();
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
    });

    it('rejects when another asset row already owns the destination path', () => {
      writeFile('a.png', 'content');
      writeFile('b.png', 'content');
      const asset = createAsset('a.png');
      createAsset('b.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('DESTINATION_CONFLICT');
      }
      expect(renameSpy).not.toHaveBeenCalled();
      renameSpy.mockRestore();
    });

    it('rejects when the filesystem destination exists but no database row does', () => {
      writeFile('a.png', 'content');
      writeFile('b.png', 'filesystem-only'); // no matching asset row for b.png
      const asset = createAsset('a.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('DESTINATION_CONFLICT');
      }
      expect(renameSpy).not.toHaveBeenCalled();
      renameSpy.mockRestore();
      // The pre-existing file must not have been touched.
      expect(fs.readFileSync(path.join(absPath, 'b.png'), 'utf8')).toBe('filesystem-only');
    });

    it('rejects when the filesystem destination is a directory', () => {
      writeFile('a.png', 'content');
      fs.mkdirSync(path.join(absPath, 'b.png'));
      const asset = createAsset('a.png');

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('DESTINATION_CONFLICT');
      }
    });

    it.skipIf(!HAS_SYMLINKS)('rejects when the filesystem destination is a symlink', () => {
      writeFile('a.png', 'content');
      const outside = path.join(tmpDir, 'outside.png');
      fs.writeFileSync(outside, 'evil');
      fs.symlinkSync(outside, path.join(absPath, 'b.png'), 'file');
      const asset = createAsset('a.png');

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('DESTINATION_CONFLICT');
      }
    });
  });

  // ─── moveAsset ───────────────────────────────────────────────────────

  describe('moveAsset', () => {
    it('moves an asset into an enabled category root', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      const result = actionService.moveAsset(project.id, asset.id, category.id);

      expect(result.relative_path).toBe('renders/a.png');
      expect(result.category_id).toBe(category.id);
      expect(fs.existsSync(path.join(absPath, 'renders', 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
    });

    it('moves an asset to Uncategorized (project root)', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('renders/a.png', 'content');
      const asset = createAsset('renders/a.png', { categoryId: category.id, nestedPath: '' });

      const result = actionService.moveAsset(project.id, asset.id, UNCATEGORIZED);

      expect(result.relative_path).toBe('a.png');
      expect(result.category_id).toBeNull();
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
    });

    it('resets nested_path to empty on move', () => {
      const staging = createEnabledCategory('Staging', 'staging');
      const rendersCategory = createEnabledCategory('Renders', 'renders');
      writeFile('staging/sub/a.png', 'content');
      const asset = createAsset('staging/sub/a.png', { categoryId: staging.id, nestedPath: 'sub' });

      const result = actionService.moveAsset(project.id, asset.id, rendersCategory.id);

      expect(result.nested_path).toBe('');
    });

    it('updates category_id correctly', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      const result = actionService.moveAsset(project.id, asset.id, category.id);
      expect(result.category_id).toBe(category.id);
    });

    it('rejects a disabled destination category', () => {
      const category = createDisabledCategory('Archive', 'archive');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      try {
        actionService.moveAsset(project.id, asset.id, category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('DESTINATION_CATEGORY_DISABLED');
      }
    });

    it('rejects a nonexistent destination category', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      try {
        actionService.moveAsset(project.id, asset.id, 999999);
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('DESTINATION_CATEGORY_INVALID');
      }
    });

    it('rejects a category owned by a different project', () => {
      const other = projectService.create(validProjectInput({ title: 'Other Project' }));
      const otherCategoryService = categoryService; // same service, project-scoped by argument
      const otherCategory = otherCategoryService.add(other.id, { displayName: 'Renders', directorySlug: 'renders' });

      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      try {
        actionService.moveAsset(project.id, asset.id, otherCategory.id);
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('DESTINATION_CATEGORY_INVALID');
      }
    });

    it('rejects a category whose directory does not exist', () => {
      const category = createCategoryRowWithoutDir('Ghost', 'ghost');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      try {
        actionService.moveAsset(project.id, asset.id, category.id);
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('DESTINATION_DIRECTORY_MISSING');
      }
    });

    it.skipIf(!HAS_SYMLINKS)('rejects a category directory that is a symlink', () => {
      const category = createCategoryRowWithoutDir('Linked', 'linked');
      const outsideDir = path.join(tmpDir, 'outside-dir');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(absPath, 'linked'), 'junction');

      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      try {
        actionService.moveAsset(project.id, asset.id, category.id);
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('DESTINATION_DIRECTORY_UNSAFE');
      }
    });

    it('rejects an unchanged destination', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('renders/a.png', 'content');
      const asset = createAsset('renders/a.png', { categoryId: category.id, nestedPath: '' });

      try {
        actionService.moveAsset(project.id, asset.id, category.id);
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('UNCHANGED_LOCATION');
      }
    });

    it('rejects an arbitrary string destination rather than treating it as a category ID', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      try {
        actionService.moveAsset(project.id, asset.id, 'exports');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('DESTINATION_CATEGORY_INVALID');
      }
    });
  });

  // ─── Source validation ─────────────────────────────────────────────────

  describe('source validation', () => {
    it('rejects an asset row marked missing', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      assetRepository.markAllMissing(project.id);

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('ASSET_MISSING');
      }
    });

    it('rejects a missing source file', () => {
      const asset = createAsset('missing.png'); // never written to disk
      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('SOURCE_MISSING');
      }
    });

    it.skipIf(!HAS_SYMLINKS)('rejects a symlinked source', () => {
      const outside = path.join(tmpDir, 'outside.png');
      fs.writeFileSync(outside, 'evil');
      fs.symlinkSync(outside, path.join(absPath, 'link.png'), 'file');
      const asset = createAsset('link.png');

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('SOURCE_SYMLINK');
      }
    });

    it('rejects a directory source', () => {
      fs.mkdirSync(path.join(absPath, 'a-dir'));
      const asset = createAsset('a-dir');

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('SOURCE_NOT_REGULAR');
      }
    });

    it('rejects an archived project', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      projectRepository.archive(project.id);

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('PROJECT_ARCHIVED');
      }
    });

    it('rejects an asset that does not belong to the project', () => {
      const other = projectService.create(validProjectInput({ title: 'Other Project' }));
      const otherAbsPath = resolveProjectDir(projectsRoot, other.project_dir);
      fs.writeFileSync(path.join(otherAbsPath, 'a.png'), 'content');
      const otherAsset = assetRepository.upsert(other.id, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png', sizeBytes: 5, modifiedAt: null,
      });

      try {
        actionService.renameAsset(project.id, otherAsset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('ASSET_NOT_FOUND');
      }
    });

    it('rejects an unknown project ID', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      try {
        actionService.renameAsset(999999, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('PROJECT_NOT_FOUND');
      }
    });

    it('rejects non-positive-integer IDs', () => {
      for (const invalid of [0, -1, 1.5, 'x', null]) {
        try {
          actionService.renameAsset(invalid, 1, 'b.png');
          expect.unreachable();
        } catch (err) {
          expect(err.code).toBe('INVALID_PROJECT_ID');
        }
      }
      for (const invalid of [0, -1, 1.5, 'x', null]) {
        try {
          actionService.renameAsset(project.id, invalid, 'b.png');
          expect.unreachable();
        } catch (err) {
          expect(err.code).toBe('INVALID_ASSET_ID');
        }
      }
    });
  });

  // ─── Preservation ────────────────────────────────────────────────────

  describe('preservation', () => {
    it('leaves the asset ID unchanged', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      const result = actionService.renameAsset(project.id, asset.id, 'b.png');
      expect(result.id).toBe(asset.id);
      expect(assetRepository.findById(asset.id)).toBeTruthy();
    });

    it('leaves release_assets associations, roles, and sort_order unchanged', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      const release = insertRelease();
      linkReleaseAsset(release.id, asset.id, 'primary', 4);

      actionService.renameAsset(project.id, asset.id, 'b.png');

      const link = db.prepare(
        'SELECT release_id, asset_id, role, sort_order FROM release_assets WHERE release_id = ? AND asset_id = ?'
      ).get(release.id, asset.id);
      expect(link).toMatchObject({ release_id: release.id, asset_id: asset.id, role: 'primary', sort_order: 4 });
    });

    it('leaves project.json bytes unchanged', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      const before = fs.readFileSync(manifestPath);

      actionService.renameAsset(project.id, asset.id, 'b.png');

      const after = fs.readFileSync(manifestPath);
      expect(after.equals(before)).toBe(true);
    });

    it('leaves preview-cache sentinel files unchanged', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      const cacheDir = getCacheDir(previewRoot, project.id, asset.id);
      fs.mkdirSync(cacheDir, { recursive: true });
      const sentinelPath = path.join(cacheDir, 'thumbnail.webp');
      fs.writeFileSync(sentinelPath, 'cached-bytes');

      actionService.renameAsset(project.id, asset.id, 'b.png');

      expect(fs.readFileSync(sentinelPath, 'utf8')).toBe('cached-bytes');
    });
  });

  // ─── Post-move failure handling ──────────────────────────────────────

  describe('post-move failure handling', () => {
    it('returns RECOVERY_REQUIRED and leaves the moved file at the destination when the repository reports NOT_FOUND', () => {
      writeFile('a.png', 'original-bytes');
      const asset = createAsset('a.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      const spy = vi.spyOn(assetRepository, 'updateAssetLocation').mockReturnValueOnce({ ok: false, reason: 'NOT_FOUND' });
      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('RECOVERY_REQUIRED');
      } finally {
        spy.mockRestore();
      }

      // Destination is present with the original content.
      expect(fs.readFileSync(path.join(absPath, 'b.png'), 'utf8')).toBe('original-bytes');
      // Source is absent — no rename-back was attempted.
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
      // renameSync was called exactly once (the forward move only).
      expect(renameSpy).toHaveBeenCalledTimes(1);
      renameSpy.mockRestore();
      // Database row is unchanged because the update never committed.
      expect(assetRepository.findById(asset.id).relative_path).toBe('a.png');
    });

    it('returns RECOVERY_REQUIRED and leaves the moved file at the destination when the repository reports DESTINATION_CONFLICT', () => {
      writeFile('a.png', 'original-bytes');
      const asset = createAsset('a.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      const spy = vi.spyOn(assetRepository, 'updateAssetLocation').mockReturnValueOnce({ ok: false, reason: 'DESTINATION_CONFLICT' });
      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('RECOVERY_REQUIRED');
      } finally {
        spy.mockRestore();
      }

      expect(fs.readFileSync(path.join(absPath, 'b.png'), 'utf8')).toBe('original-bytes');
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      renameSpy.mockRestore();
    });

    it('returns RECOVERY_REQUIRED and leaves the moved file at the destination when the repository throws', () => {
      writeFile('a.png', 'original-bytes');
      const asset = createAsset('a.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      const spy = vi.spyOn(assetRepository, 'updateAssetLocation').mockImplementationOnce(() => {
        throw new Error('simulated database failure');
      });
      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('RECOVERY_REQUIRED');
      } finally {
        spy.mockRestore();
      }

      expect(fs.readFileSync(path.join(absPath, 'b.png'), 'utf8')).toBe('original-bytes');
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      renameSpy.mockRestore();
    });

    it('returns RECOVERY_REQUIRED without rename-back when post-move destination verification fails', () => {
      writeFile('a.png', 'original-bytes');
      const asset = createAsset('a.png');
      const destPath = path.join(absPath, 'b.png');

      const realLstatSync = fs.lstatSync.bind(fs);
      let failNext = false;
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
        if (failNext && target === destPath) {
          failNext = false;
          const err = new Error('simulated transient stat failure');
          err.code = 'EIO';
          throw err;
        }
        return realLstatSync(target, ...rest);
      });

      const realRenameSync = fs.renameSync.bind(fs);
      let renameCalls = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        renameCalls++;
        realRenameSync(src, dest);
        if (renameCalls === 1) failNext = true; // trigger verification failure after forward move
      });

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('RECOVERY_REQUIRED');
      } finally {
        lstatSpy.mockRestore();
        renameSpy.mockRestore();
      }

      // renameSync called exactly once — no rename-back attempted.
      expect(renameCalls).toBe(1);
      // The moved file is at the destination (lstat failure was transient; real file is there).
      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.readFileSync(destPath, 'utf8')).toBe('original-bytes');
      // Source is absent.
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
    });

    it('does not overwrite a file recreated at the source path after the forward move', () => {
      writeFile('a.png', 'original-bytes');
      const asset = createAsset('a.png');
      const sourcePath = path.join(absPath, 'a.png');

      const spy = vi.spyOn(assetRepository, 'updateAssetLocation').mockImplementationOnce(() => {
        // Simulate a concurrent actor recreating the source path between
        // the move and this repository call.
        fs.writeFileSync(sourcePath, 'someone-elses-file');
        throw new Error('simulated database failure');
      });

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('RECOVERY_REQUIRED');
      } finally {
        spy.mockRestore();
      }

      // The recreated source file must not have been overwritten.
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe('someone-elses-file');
      // The moved file must still be at the destination, untouched.
      expect(fs.readFileSync(path.join(absPath, 'b.png'), 'utf8')).toBe('original-bytes');
    });

    it('leaves all observed content untouched when destination identity does not match after the move', () => {
      writeFile('a.png', 'original-bytes');
      const asset = createAsset('a.png');
      const destPath = path.join(absPath, 'b.png');

      const realRenameSync = fs.renameSync.bind(fs);
      const realLstatSync = fs.lstatSync.bind(fs);
      let forwardMoveCompleted = false;
      let renameCalls = 0;
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
        const stats = realLstatSync(target, ...args);
        if (!forwardMoveCompleted || target !== destPath) return stats;

        // Filesystems may reuse the deleted destination's inode immediately;
        // force the replacement to have a distinct identity for this test.
        return {
          ...stats,
          ino: typeof stats.ino === 'number' ? stats.ino + 1 : 1,
          isSymbolicLink: stats.isSymbolicLink.bind(stats),
          isFile: stats.isFile.bind(stats),
        };
      });
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce((src, dest) => {
        renameCalls++;
        realRenameSync(src, dest);
        // Simulate an external actor replacing the destination the instant
        // after our own rename completes, before verification runs.
        fs.rmSync(dest, { force: true });
        fs.writeFileSync(dest, 'replaced-by-someone-else');
        forwardMoveCompleted = true;
      });

      try {
        actionService.renameAsset(project.id, asset.id, 'b.png');
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('RECOVERY_REQUIRED');
      } finally {
        lstatSpy.mockRestore();
        renameSpy.mockRestore();
      }

      // The replacement destination content must not have been overwritten.
      expect(fs.readFileSync(destPath, 'utf8')).toBe('replaced-by-someone-else');
      // Nothing was recreated at the source path.
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
      // renameSync was called exactly once.
      expect(renameCalls).toBe(1);
    });
  });

  // ─── Residual behavior ─────────────────────────────────────────────────

  describe('residual behavior', () => {
    it('never calls fs.renameSync once a known destination conflict is detected (database)', () => {
      writeFile('a.png', 'content');
      writeFile('b.png', 'content');
      const asset = createAsset('a.png');
      createAsset('b.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      expect(() => actionService.renameAsset(project.id, asset.id, 'b.png')).toThrow(AssetActionError);
      expect(renameSpy).not.toHaveBeenCalled();
      renameSpy.mockRestore();
    });

    it('never calls fs.renameSync once a known destination conflict is detected (filesystem)', () => {
      writeFile('a.png', 'content');
      fs.mkdirSync(path.join(absPath, 'b.png'));
      const asset = createAsset('a.png');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      expect(() => actionService.renameAsset(project.id, asset.id, 'b.png')).toThrow(AssetActionError);
      expect(renameSpy).not.toHaveBeenCalled();
      renameSpy.mockRestore();
    });
  });

  // ─── Coordinator integration (Phase: asset actions chunk 3) ────────────

  describe('coordinator integration', () => {
    it('requires a projectOperationCoordinator dependency', () => {
      expect(() => createAssetActionService({
        projectRepository, assetRepository, assetCategoryRepository, projectsRoot,
      })).toThrow();
    });

    it('rejects a same-project rename while a coordinator-held operation is already in progress', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      projectOperationCoordinator.run(project.id, () => {
        try {
          actionService.renameAsset(project.id, asset.id, 'b.png');
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(AssetActionError);
          expect(err.code).toBe('PROJECT_BUSY');
        }
      });

      // Untouched — the busy rename never ran.
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
    });

    it('rejects a same-project move while a coordinator-held operation is already in progress', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      projectOperationCoordinator.run(project.id, () => {
        try {
          actionService.moveAsset(project.id, asset.id, category.id);
          expect.unreachable();
        } catch (err) {
          expect(err.code).toBe('PROJECT_BUSY');
        }
      });
    });

    it('permits a different-project rename while another project holds the coordinator', () => {
      const other = projectService.create(validProjectInput({ title: 'Other Project' }));
      const otherAbsPath = resolveProjectDir(projectsRoot, other.project_dir);
      fs.writeFileSync(path.join(otherAbsPath, 'a.png'), 'content');
      const otherAsset = assetRepository.upsert(other.id, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png', sizeBytes: 5, modifiedAt: null,
      });

      let innerResult;
      projectOperationCoordinator.run(project.id, () => {
        innerResult = actionService.renameAsset(other.id, otherAsset.id, 'b.png');
      });

      expect(innerResult.relative_path).toBe('b.png');
    });

    it('holds the project lock through the repository update for renameAsset', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      let lockActiveDuringUpdate = null;
      const spy = vi.spyOn(assetRepository, 'updateAssetLocation');
      const original = spy.getMockImplementation() || assetRepository.updateAssetLocation.bind(assetRepository);
      spy.mockImplementationOnce((...args) => {
        lockActiveDuringUpdate = projectOperationCoordinator.isActive(project.id);
        return original(...args);
      });

      actionService.renameAsset(project.id, asset.id, 'b.png');

      expect(lockActiveDuringUpdate).toBe(true);
      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
      spy.mockRestore();
    });

    it('holds the project lock through the repository update for moveAsset', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      let lockActiveDuringUpdate = null;
      const spy = vi.spyOn(assetRepository, 'updateAssetLocation');
      const original = spy.getMockImplementation() || assetRepository.updateAssetLocation.bind(assetRepository);
      spy.mockImplementationOnce((...args) => {
        lockActiveDuringUpdate = projectOperationCoordinator.isActive(project.id);
        return original(...args);
      });

      actionService.moveAsset(project.id, asset.id, category.id);

      expect(lockActiveDuringUpdate).toBe(true);
      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
      spy.mockRestore();
    });

    it('releases the lock after a validation failure', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      expect(() => actionService.renameAsset(project.id, asset.id, '..')).toThrow(AssetActionError);
      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);

      // The lock is usable again immediately afterward.
      const result = actionService.renameAsset(project.id, asset.id, 'b.png');
      expect(result.relative_path).toBe('b.png');
    });

    it('releases the lock after a filesystem failure', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('simulated filesystem failure');
      });
      try {
        expect(() => actionService.renameAsset(project.id, asset.id, 'b.png')).toThrow(AssetActionError);
      } finally {
        renameSpy.mockRestore();
      }

      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
    });

    it('releases the lock after a repository failure and compensation', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      const spy = vi.spyOn(assetRepository, 'updateAssetLocation').mockImplementationOnce(() => {
        throw new Error('simulated database failure');
      });
      try {
        expect(() => actionService.renameAsset(project.id, asset.id, 'b.png')).toThrow(AssetActionError);
      } finally {
        spy.mockRestore();
      }

      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
    });

    it('produces a stable AssetActionError busy code suitable for HTTP mapping', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      projectOperationCoordinator.run(project.id, () => {
        try {
          actionService.renameAsset(project.id, asset.id, 'b.png');
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(AssetActionError);
          expect(err.name).toBe('AssetActionError');
          expect(err.code).toBe('PROJECT_BUSY');
          expect(err).not.toBeInstanceOf(ProjectOperationError);
        }
      });
    });
  });

  // ─── moveAssets ────────────────────────────────────────────────────────

  describe('moveAssets', () => {
    // ── Input validation (before lock) ─────────────────────────────────

    it('throws INVALID_ASSET_SELECTION when assetIds is not an array', () => {
      try {
        actionService.moveAssets(project.id, 'not-an-array', UNCATEGORIZED);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('INVALID_ASSET_SELECTION');
      }
    });

    it('throws INVALID_ASSET_SELECTION when assetIds contains a non-positive-integer', () => {
      try {
        actionService.moveAssets(project.id, [0], UNCATEGORIZED);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('INVALID_ASSET_SELECTION');
      }
    });

    it('throws NO_ASSETS_SELECTED for an empty array', () => {
      try {
        actionService.moveAssets(project.id, [], UNCATEGORIZED);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('NO_ASSETS_SELECTED');
      }
    });

    // ── Destination validation (preflight, inside lock) ─────────────────

    it('throws BATCH_PRECHECK_FAILED when the destination category is disabled', () => {
      const disabled = createDisabledCategory('Archive', 'archive');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      try {
        actionService.moveAssets(project.id, [asset.id], disabled.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PRECHECK_FAILED');
      }
    });

    it('throws BATCH_PRECHECK_FAILED when the destination category does not exist', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      try {
        actionService.moveAssets(project.id, [asset.id], 999999);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PRECHECK_FAILED');
      }
    });

    it('throws BATCH_PRECHECK_FAILED when an asset is missing at last scan', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      assetRepository.markAllMissing(project.id);
      try {
        actionService.moveAssets(project.id, [asset.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PRECHECK_FAILED');
      }
    });

    it('throws BATCH_PRECHECK_FAILED when an asset is not found or cross-project', () => {
      const category = createEnabledCategory('Renders', 'renders');
      try {
        actionService.moveAssets(project.id, [999999], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PRECHECK_FAILED');
      }
    });

    it('throws BATCH_PRECHECK_FAILED when an asset is already in the target location', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('renders/a.png', 'content');
      const asset = createAsset('renders/a.png', { categoryId: category.id });
      try {
        actionService.moveAssets(project.id, [asset.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PRECHECK_FAILED');
      }
    });

    it('throws BATCH_PRECHECK_FAILED when duplicate IDs are in the selection', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      try {
        actionService.moveAssets(project.id, [asset.id, asset.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PRECHECK_FAILED');
      }
    });

    it('throws BATCH_DUPLICATE_DESTINATION when two assets share the same destination filename', () => {
      const src = createEnabledCategory('Archive', 'archive');
      const dst = createEnabledCategory('Dest', 'dest');
      writeFile('archive/a.png', 'content1');
      writeFile('renders/a.png', 'content2');
      const asset1 = createAsset('archive/a.png', { categoryId: src.id });
      const asset2 = createAsset('renders/a.png');
      try {
        actionService.moveAssets(project.id, [asset1.id, asset2.id], dst.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_DUPLICATE_DESTINATION');
      }
      // Nothing moved — both source files still present
      expect(fs.existsSync(path.join(absPath, 'archive', 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'renders', 'a.png'))).toBe(true);
    });

    it('throws BATCH_DESTINATION_CONFLICT when an existing asset record occupies the destination', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      writeFile('renders/a.png', 'other');
      const moving = createAsset('a.png');
      createAsset('renders/a.png', { categoryId: category.id });
      try {
        actionService.moveAssets(project.id, [moving.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_DESTINATION_CONFLICT');
      }
    });

    it('throws BATCH_DESTINATION_CONFLICT when a filesystem object occupies the destination', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      writeFile('renders/a.png', 'squatter'); // on disk, not in DB
      const moving = createAsset('a.png');
      try {
        actionService.moveAssets(project.id, [moving.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_DESTINATION_CONFLICT');
      }
    });

    it('throws BATCH_PRECHECK_FAILED when source file is absent from disk', () => {
      const category = createEnabledCategory('Renders', 'renders');
      const asset = createAsset('a.png'); // record exists, file does not
      try {
        actionService.moveAssets(project.id, [asset.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PRECHECK_FAILED');
      }
    });

    // ── Successful batch moves ─────────────────────────────────────────

    it('moves a single asset into a category', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      const result = actionService.moveAssets(project.id, [asset.id], category.id);

      expect(result.movedCount).toBe(1);
      expect(result.requestedCount).toBe(1);
      expect(result.completedAssetIds).toEqual([asset.id]);
      expect(fs.existsSync(path.join(absPath, 'renders', 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
    });

    it('moves multiple assets into a category', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'aaa');
      writeFile('b.png', 'bbb');
      const assetA = createAsset('a.png');
      const assetB = createAsset('b.png');

      const result = actionService.moveAssets(project.id, [assetA.id, assetB.id], category.id);

      expect(result.movedCount).toBe(2);
      expect(result.requestedCount).toBe(2);
      expect(result.completedAssetIds).toEqual([assetA.id, assetB.id]);
      expect(fs.existsSync(path.join(absPath, 'renders', 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'renders', 'b.png'))).toBe(true);
    });

    it('moves assets to Uncategorized (project root)', () => {
      const src = createEnabledCategory('Archive', 'archive');
      writeFile('archive/a.png', 'content');
      const asset = createAsset('archive/a.png', { categoryId: src.id });

      const result = actionService.moveAssets(project.id, [asset.id], UNCATEGORIZED);

      expect(result.movedCount).toBe(1);
      const updated = assetRepository.findById(asset.id);
      expect(updated.relative_path).toBe('a.png');
      expect(updated.category_id).toBeNull();
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
    });

    it('resets nested_path to empty when moving from a subdirectory', () => {
      const src = createEnabledCategory('Staging', 'staging');
      const dst = createEnabledCategory('Renders', 'renders');
      writeFile('staging/sub/a.png', 'content');
      const asset = createAsset('staging/sub/a.png', { categoryId: src.id, nestedPath: 'sub' });

      actionService.moveAssets(project.id, [asset.id], dst.id);

      const updated = assetRepository.findById(asset.id);
      expect(updated.nested_path).toBe('');
    });

    it('updates extension and MIME type based on the (unchanged) filename', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png', { mimeType: 'application/octet-stream' });

      actionService.moveAssets(project.id, [asset.id], category.id);

      const updated = assetRepository.findById(asset.id);
      expect(updated.mime_type).toBe('image/png');
    });

    it('preserves release associations across the move', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      const rel = insertRelease('R1');
      linkReleaseAsset(rel.id, asset.id);

      actionService.moveAssets(project.id, [asset.id], category.id);

      const rows = db.prepare('SELECT * FROM release_assets WHERE asset_id = ?').all(asset.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].release_id).toBe(rel.id);
    });

    it('no filesystem mutation occurs during preflight phase failure', () => {
      const src = createEnabledCategory('Archive', 'archive');
      const dst = createEnabledCategory('Final', 'final');
      writeFile('archive/a.png', 'aaa');
      writeFile('archive/b.png', 'bbb'); // b.png also present
      const assetA = createAsset('archive/a.png', { categoryId: src.id });
      const assetB = createAsset('archive/b.png', { categoryId: src.id });
      // Occupy the destination for b.png on disk to force BATCH_DESTINATION_CONFLICT
      // (discovered during the filesystem preflight that scans ALL assets before moving any)
      writeFile('final/b.png', 'squatter');

      const renameSpy = vi.spyOn(fs, 'renameSync');
      try {
        actionService.moveAssets(project.id, [assetA.id, assetB.id], dst.id);
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('BATCH_DESTINATION_CONFLICT');
      }
      expect(renameSpy).not.toHaveBeenCalled();
      renameSpy.mockRestore();

      expect(fs.existsSync(path.join(absPath, 'archive', 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'archive', 'b.png'))).toBe(true);
    });

    // ── Partial failure semantics ──────────────────────────────────────

    it('reports BATCH_PARTIAL_FAILURE and batchContext when execution fails mid-batch', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'aaa');
      writeFile('b.png', 'bbb');
      const assetA = createAsset('a.png');
      const assetB = createAsset('b.png');

      // Force the second renameSync to throw (simulating a filesystem error
      // after the first asset was already moved).
      let renameCalls = 0;
      const origRename = fs.renameSync.bind(fs);
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        renameCalls++;
        if (renameCalls === 2) throw new Error('injected disk error');
        return origRename(...args);
      });

      try {
        actionService.moveAssets(project.id, [assetA.id, assetB.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(renameCalls).toBe(2);
        renameSpy.mockRestore();
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PARTIAL_FAILURE');
        expect(err.batchContext).toBeDefined();
        expect(err.batchContext.movedCount).toBe(1);
        expect(err.batchContext.requestedCount).toBe(2);
        expect(err.batchContext.completedAssetIds).toEqual([assetA.id]);
      }

      // First asset was physically moved; second was not.
      expect(fs.existsSync(path.join(absPath, 'renders', 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'b.png'))).toBe(true);
    });

    it('reports BATCH_RECOVERY_REQUIRED when a post-move step fails mid-batch', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'aaa');
      writeFile('b.png', 'bbb');
      const assetA = createAsset('a.png');
      const assetB = createAsset('b.png');

      // Inject a failure into lstatSync on the second call after rename
      // (post-move verification), causing RECOVERY_REQUIRED for assetB.
      let renameCalls = 0;
      let lstatCalls = 0;
      const origRename = fs.renameSync.bind(fs);
      const origLstat = fs.lstatSync.bind(fs);
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        renameCalls++;
        return origRename(...args);
      });
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
        lstatCalls++;
        // Fail the lstat that verifies the destination after the second rename
        if (renameCalls === 2 && lstatCalls >= 2) throw new Error('injected lstat error');
        return origLstat(...args);
      });

      try {
        actionService.moveAssets(project.id, [assetA.id, assetB.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(renameCalls).toBe(2);
        renameSpy.mockRestore();
        lstatSpy.mockRestore();
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_RECOVERY_REQUIRED');
        expect(err.batchContext.movedCount).toBe(1);
        expect(err.batchContext.completedAssetIds).toEqual([assetA.id]);
      }
    });

    it('batchContext.movedCount is 0 when the very first execution fails', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'aaa');
      const assetA = createAsset('a.png');

      const origRename = fs.renameSync.bind(fs);
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('injected disk error');
      });

      try {
        actionService.moveAssets(project.id, [assetA.id], category.id);
        expect.unreachable();
      } catch (err) {
        renameSpy.mockRestore();
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('BATCH_PARTIAL_FAILURE');
        expect(err.batchContext.movedCount).toBe(0);
        expect(err.batchContext.completedAssetIds).toEqual([]);
      }
    });
  });

  describe('copyAssets', () => {
    it('rejects an empty selection and an unknown destination category', () => {
      expect(() => actionService.copyAssets(project.id, [], UNCATEGORIZED)).toThrowError(
        expect.objectContaining({ code: 'NO_ASSETS_SELECTED' })
      );

      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      expect(() => actionService.copyAssets(project.id, [asset.id], 999999)).toThrowError(
        expect.objectContaining({ code: 'COPY_PRECHECK_FAILED' })
      );
    });

    it('copies one asset, preserves the original, and creates a destination row', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'original');
      const asset = createAsset('a.png', { categoryId: null });

      const result = actionService.copyAssets(project.id, [asset.id], category.id);

      expect(result).toMatchObject({ copiedCount: 1, requestedCount: 1 });
      expect(result.copiedAssetIds).toHaveLength(1);
      expect(result.copiedAssetIds[0]).not.toBe(asset.id);
      expect(fs.readFileSync(path.join(absPath, 'a.png'), 'utf8')).toBe('original');
      expect(fs.readFileSync(path.join(absPath, 'renders', 'a.png'), 'utf8')).toBe('original');

      const original = assetRepository.findById(asset.id);
      const copied = assetRepository.findByProjectIdAndPath(project.id, 'renders/a.png');
      expect(original).toMatchObject({ relative_path: 'a.png', category_id: null, is_present: 1 });
      expect(copied).toMatchObject({
        project_id: project.id,
        relative_path: 'renders/a.png',
        category_id: category.id,
        nested_path: '',
        filename: 'a.png',
        is_present: 1,
      });
      expect(copied.id).toBe(result.copiedAssetIds[0]);
    });

    it('copies multiple assets into one category', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'aaa');
      writeFile('b.png', 'bbb');
      const assetA = createAsset('a.png');
      const assetB = createAsset('b.png');

      const result = actionService.copyAssets(project.id, [assetA.id, assetB.id], category.id);

      expect(result.copiedCount).toBe(2);
      expect(result.requestedCount).toBe(2);
      expect(result.copiedAssetIds).toHaveLength(2);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'b.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'renders', 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'renders', 'b.png'))).toBe(true);
      expect(assetRepository.findByProjectIdAndPath(project.id, 'renders/a.png')).toBeDefined();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'renders/b.png')).toBeDefined();
    });

    it('rejects a destination collision before copying any part of the batch', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'aaa');
      writeFile('b.png', 'bbb');
      writeFile('renders/a.png', 'existing');
      const assetA = createAsset('a.png');
      const assetB = createAsset('b.png');
      const copySpy = vi.spyOn(fs, 'copyFileSync');

      try {
        actionService.copyAssets(project.id, [assetA.id, assetB.id], category.id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetActionError);
        expect(err.code).toBe('COPY_DESTINATION_CONFLICT');
      } finally {
        copySpy.mockRestore();
      }

      expect(copySpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(absPath, 'renders', 'a.png'), 'utf8')).toBe('existing');
      expect(fs.existsSync(path.join(absPath, 'renders', 'b.png'))).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'b.png'))).toBe(true);
      expect(assetRepository.findByProjectIdAndPath(project.id, 'renders/a.png')).toBeUndefined();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'renders/b.png')).toBeUndefined();
    });

    it('rejects archived projects without copying', () => {
      const category = createEnabledCategory('Renders', 'renders');
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      projectRepository.archive(project.id);

      expect(() => actionService.copyAssets(project.id, [asset.id], category.id)).toThrowError(
        expect.objectContaining({ code: 'PROJECT_ARCHIVED' })
      );
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'renders', 'a.png'))).toBe(false);
    });
  });

  describe('deleteAssets', () => {
    it('rejects malformed selections before touching the filesystem or lock', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');

      expect(() => actionService.deleteAssets(project.id, [asset.id, 0])).toThrowError(
        expect.objectContaining({ code: 'INVALID_ASSET_SELECTION' })
      );

      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(true);
      expect(assetRepository.findById(asset.id)).toBeDefined();
    });

    it('permanently deletes multiple ordinary assets from disk and the index', () => {
      writeFile('a.png', 'aaa');
      writeFile('b.png', 'bbb');
      const assetA = createAsset('a.png');
      const assetB = createAsset('b.png');

      const result = actionService.deleteAssets(project.id, [assetA.id, assetB.id]);

      expect(result).toEqual({
        deletedCount: 2,
        requestedCount: 2,
        deletedAssetIds: [assetA.id, assetB.id],
      });
      expect(fs.existsSync(path.join(absPath, 'a.png'))).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'b.png'))).toBe(false);
      expect(assetRepository.findById(assetA.id)).toBeUndefined();
      expect(assetRepository.findById(assetB.id)).toBeUndefined();
      expect(fs.readdirSync(absPath).filter((name) => name.startsWith('.creatorcrate-delete-'))).toEqual([]);
    });

    it('validates the complete batch before staging or deleting any member', () => {
      writeFile('valid.png', 'valid');
      const valid = createAsset('valid.png');
      const missing = createAsset('missing.png');
      const renameSpy = vi.spyOn(fs, 'renameSync');
      const removeSpy = vi.spyOn(fs, 'rmSync');

      try {
        expect(() => actionService.deleteAssets(project.id, [valid.id, missing.id])).toThrowError(
          expect.objectContaining({ code: 'DELETE_PRECHECK_FAILED' })
        );
      } finally {
        renameSpy.mockRestore();
        removeSpy.mockRestore();
      }

      expect(renameSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(absPath, 'valid.png'))).toBe(true);
      expect(assetRepository.findById(valid.id)).toBeDefined();
      expect(assetRepository.findById(missing.id)).toBeDefined();
    });

    it('rejects published-release assets before filesystem staging', () => {
      writeFile('published.png', 'published');
      const asset = createAsset('published.png');
      const release = insertRelease('Published release');
      db.prepare("UPDATE releases SET published_date = '2026-08-05' WHERE id = ?").run(release.id);
      linkReleaseAsset(release.id, asset.id);
      const stagingSpy = vi.spyOn(fs, 'mkdtempSync');
      const renameSpy = vi.spyOn(fs, 'renameSync');
      const deleteSpy = vi.spyOn(assetRepository, 'deleteMany');

      try {
        expect(() => actionService.deleteAssets(project.id, [asset.id])).toThrowError(
          expect.objectContaining({
            code: 'DELETE_PUBLISHED_RELEASE_ASSET',
            message: expect.stringContaining('published release cannot be deleted'),
          })
        );
      } finally {
        stagingSpy.mockRestore();
        renameSpy.mockRestore();
        deleteSpy.mockRestore();
      }

      expect(stagingSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(absPath, 'published.png'))).toBe(true);
      expect(assetRepository.findById(asset.id)).toBeDefined();
    });

    it('rejects a mixed batch containing one published-release asset without deleting any asset', () => {
      writeFile('ordinary.png', 'ordinary');
      writeFile('published.png', 'published');
      const ordinary = createAsset('ordinary.png');
      const published = createAsset('published.png');
      const release = insertRelease('Published batch blocker');
      db.prepare("UPDATE releases SET published_date = '2026-08-05' WHERE id = ?").run(release.id);
      linkReleaseAsset(release.id, published.id);

      expect(() => actionService.deleteAssets(project.id, [ordinary.id, published.id])).toThrowError(
        expect.objectContaining({ code: 'DELETE_PUBLISHED_RELEASE_ASSET' })
      );

      expect(fs.existsSync(path.join(absPath, 'ordinary.png'))).toBe(true);
      expect(fs.existsSync(path.join(absPath, 'published.png'))).toBe(true);
      expect(assetRepository.findById(ordinary.id)).toBeDefined();
      expect(assetRepository.findById(published.id)).toBeDefined();
      expect(db.prepare('SELECT * FROM release_assets WHERE asset_id = ?').all(published.id)).toHaveLength(1);
    });

    it('rejects an inaccessible member without deleting valid earlier members', () => {
      writeFile('valid.png', 'valid');
      const valid = createAsset('valid.png');
      const blockedPath = writeFile('blocked.png', 'blocked');
      const blocked = createAsset('blocked.png');
      const originalLstat = fs.lstatSync.bind(fs);
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
        if (target === blockedPath) {
          const error = new Error('simulated inaccessible file');
          error.code = 'EACCES';
          throw error;
        }
        return originalLstat(target, ...args);
      });

      try {
        expect(() => actionService.deleteAssets(project.id, [valid.id, blocked.id])).toThrowError(
          expect.objectContaining({ code: 'DELETE_PRECHECK_FAILED' })
        );
      } finally {
        lstatSpy.mockRestore();
      }

      expect(fs.existsSync(path.join(absPath, 'valid.png'))).toBe(true);
      expect(fs.existsSync(blockedPath)).toBe(true);
      expect(assetRepository.findById(valid.id)).toBeDefined();
      expect(assetRepository.findById(blocked.id)).toBeDefined();
    });

    it('rejects an outside-project path without deleting valid members', () => {
      writeFile('valid.png', 'valid');
      const valid = createAsset('valid.png');
      const outsidePath = path.join(tmpDir, 'outside.png');
      fs.writeFileSync(outsidePath, 'outside');
      const outside = createAsset('../outside.png');

      expect(() => actionService.deleteAssets(project.id, [valid.id, outside.id])).toThrowError(
        expect.objectContaining({ code: 'DELETE_PRECHECK_FAILED' })
      );

      expect(fs.existsSync(path.join(absPath, 'valid.png'))).toBe(true);
      expect(fs.existsSync(outsidePath)).toBe(true);
      expect(assetRepository.findById(valid.id)).toBeDefined();
      expect(assetRepository.findById(outside.id)).toBeDefined();
    });

    it.skipIf(!HAS_SYMLINKS)('rejects a symlinked member without deleting valid members', () => {
      writeFile('valid.png', 'valid');
      const valid = createAsset('valid.png');
      const targetPath = path.join(tmpDir, 'symlink-target.png');
      const linkPath = writeFile('linked.png');
      fs.writeFileSync(targetPath, 'target');
      fs.rmSync(linkPath);
      fs.symlinkSync(targetPath, linkPath, 'file');
      const linked = createAsset('linked.png');

      expect(() => actionService.deleteAssets(project.id, [valid.id, linked.id])).toThrowError(
        expect.objectContaining({ code: 'DELETE_PRECHECK_FAILED' })
      );

      expect(fs.existsSync(path.join(absPath, 'valid.png'))).toBe(true);
      expect(fs.existsSync(linkPath)).toBe(true);
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(assetRepository.findById(valid.id)).toBeDefined();
      expect(assetRepository.findById(linked.id)).toBeDefined();
    });

    it('rejects archived projects without deleting valid members', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      projectRepository.archive(project.id);

      expect(() => actionService.deleteAssets(project.id, [asset.id])).toThrowError(
        expect.objectContaining({ code: 'PROJECT_ARCHIVED' })
      );
      expect(assetRepository.findById(asset.id)).toBeDefined();
      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
    });

    it('holds the project lock through indexed deletion', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png');
      const originalDeleteMany = assetRepository.deleteMany.bind(assetRepository);
      let lockActiveDuringDelete = null;
      const deleteSpy = vi.spyOn(assetRepository, 'deleteMany').mockImplementationOnce((...args) => {
        lockActiveDuringDelete = projectOperationCoordinator.isActive(project.id);
        return originalDeleteMany(...args);
      });

      try {
        actionService.deleteAssets(project.id, [asset.id]);
      } finally {
        deleteSpy.mockRestore();
      }

      expect(lockActiveDuringDelete).toBe(true);
      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
    });

    it('restores staged files and rows when indexed deletion fails', () => {
      writeFile('a.png', 'aaa');
      writeFile('b.png', 'bbb');
      const assetA = createAsset('a.png');
      const assetB = createAsset('b.png');
      const deleteSpy = vi.spyOn(assetRepository, 'deleteMany').mockImplementationOnce(() => {
        throw new Error('simulated database failure');
      });

      try {
        expect(() => actionService.deleteAssets(project.id, [assetA.id, assetB.id])).toThrowError(
          expect.objectContaining({ code: 'DELETE_DATABASE_OPERATION_FAILED' })
        );
      } finally {
        deleteSpy.mockRestore();
      }

      expect(fs.readFileSync(path.join(absPath, 'a.png'), 'utf8')).toBe('aaa');
      expect(fs.readFileSync(path.join(absPath, 'b.png'), 'utf8')).toBe('bbb');
      expect(assetRepository.findById(assetA.id)).toBeDefined();
      expect(assetRepository.findById(assetB.id)).toBeDefined();
      expect(fs.readdirSync(absPath).filter((name) => name.startsWith('.creatorcrate-delete-'))).toEqual([]);
    });

    it('deletes an asset associated only with an unpublished release and clears cascaded references', () => {
      writeFile('a.png', 'content');
      const asset = createAsset('a.png', { mimeType: 'image/png' });
      const release = insertRelease('Release using deleted asset');
      linkReleaseAsset(release.id, asset.id, 'primary');
      primaryImageService.setPrimaryImage(project.id, asset.id);
      const tag = db.prepare(`
        INSERT INTO tags (display_name, normalized_name)
        VALUES (?, ?)
        RETURNING id
      `).get('Delete test', 'delete-test');
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(asset.id, tag.id);

      expect(db.prepare('SELECT published_date FROM releases WHERE id = ?').get(release.id).published_date).toBeNull();
      actionService.deleteAssets(project.id, [asset.id]);

      expect(db.prepare('SELECT * FROM release_assets WHERE asset_id = ?').all(asset.id)).toEqual([]);
      expect(db.prepare('SELECT * FROM asset_tags WHERE asset_id = ?').all(asset.id)).toEqual([]);
      expect(primaryImageRepository.findByProjectId(project.id)).toBeUndefined();
      expect(assetRepository.findById(asset.id)).toBeUndefined();
    });
  });
});
