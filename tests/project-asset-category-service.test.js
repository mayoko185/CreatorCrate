/**
 * Phase 2 chunk 2: project-specific category mutations and filesystem
 * compensation — service + storage integration tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetBrowserPreferenceService } from '../src/services/asset-browser-preference-service.js';
import {
  createProjectAssetCategoryService,
  ProjectArchivedError,
  ProjectAssetCategoryError,
  ProjectNotFoundError,
  AssetCategoryNotFoundError,
  AssetCategoryValidationError,
} from '../src/services/project-asset-category-service.js';
import { resolveProjectDir, STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { readManifestSync } from '../src/storage/manifest.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

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

describe('project asset category service', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let projectRepository;
  let assetCategoryRepository;
  let assetBrowserPreferenceRepository;
  let assetRepository;
  let projectService;
  let assetBrowserPreferenceService;
  let service;
  let project;
  let absPath;

  function makeService(overrides = {}) {
    return createProjectAssetCategoryService({
      db,
      projectRepository,
      assetCategoryRepository,
      assetRepository,
      assetBrowserPreferenceRepository,
      projectsRoot,
      ...overrides,
    });
  }

  function insertRelease(projectId, title = 'Release') {
    return db.prepare(`
      INSERT INTO releases (project_id, title) VALUES (?, ?)
      RETURNING id
    `).get(projectId, title);
  }

  function linkReleaseAsset(releaseId, assetId) {
    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)
    `).run(releaseId, assetId);
  }

  /**
   * Force a REAL SQLite commit-time failure — not a thrown error from
   * writeManifestSync — inside a project-category mutation's own
   * transaction. Spies on one repository method that runs inside the
   * transaction under test; on its `targetCallIndex`-th invocation (1-based,
   * across the whole operation, including any pre-transaction calls this
   * service now makes to capture prior manifest state), it calls through to
   * the real implementation and then inserts an `assets` row referencing a
   * nonexistent category id. The `assets.category_id` foreign key
   * (migration 011) is DEFERRABLE INITIALLY DEFERRED, so the insert itself
   * succeeds; the violation only surfaces when the operation's own
   * `db.transaction(...)` call reaches its implicit COMMIT — exactly the
   * "manifest published, then commit fails" sequence this defect requires.
   *
   * @returns the vi spy — caller must `.mockRestore()` it.
   */
  function forceCommitFailureOn(repoObj, methodName, targetCallIndex, projectId) {
    const original = repoObj[methodName].bind(repoObj);
    let calls = 0;
    return vi.spyOn(repoObj, methodName).mockImplementation((...args) => {
      calls++;
      const result = original(...args);
      if (calls === targetCallIndex) {
        db.prepare(`
          INSERT INTO assets (project_id, category_id, relative_path, filename)
          VALUES (?, 999999, 'commit-fail-probe.tmp', 'commit-fail-probe.tmp')
        `).run(projectId);
      }
      return result;
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pacs-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    projectRepository = createProjectRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
    assetRepository = createAssetRepository(db);
    const assetCategoryService = createAssetCategoryService(assetCategoryRepository);
    assetBrowserPreferenceRepository = createAssetBrowserPreferenceRepository(db);
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository,
    });
    assetBrowserPreferenceService = createAssetBrowserPreferenceService({
      preferenceRepository: assetBrowserPreferenceRepository,
      projectRepository,
      assetCategoryRepository,
    });

    service = makeService();

    project = projectService.create(validProjectInput());
    absPath = resolveProjectDir(projectsRoot, project.project_dir);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Dependency injection ────────────────────────────────────────────

  describe('dependency injection', () => {
    it('requires every explicit dependency', () => {
      expect(() => createProjectAssetCategoryService({})).toThrow(/db dependency/);
      expect(() => createProjectAssetCategoryService({ db })).toThrow(/projectRepository dependency/);
      expect(() => createProjectAssetCategoryService({ db, projectRepository })).toThrow(/assetCategoryRepository dependency/);
      expect(() => createProjectAssetCategoryService({ db, projectRepository, assetCategoryRepository }))
        .toThrow(/assetRepository dependency/);
      expect(() => createProjectAssetCategoryService({ db, projectRepository, assetCategoryRepository, assetRepository }))
        .toThrow(/projectsRoot dependency/);
      expect(() => createProjectAssetCategoryService({
        db, projectRepository, assetCategoryRepository, assetRepository, projectsRoot,
      })).toThrow(/assetBrowserPreferenceRepository dependency/);
    });
  });

  // ─── Defect 2: validation before dependency access ──────────────────

  describe('validation before dependency access', () => {
    let findByIdSpy;
    let findProjectCategoryByIdSpy;
    let listProjectCategoriesSpy;
    let countByCategoryIdSpy;

    beforeEach(() => {
      findByIdSpy = vi.spyOn(projectRepository, 'findById');
      findProjectCategoryByIdSpy = vi.spyOn(assetCategoryRepository, 'findProjectCategoryById');
      listProjectCategoriesSpy = vi.spyOn(assetCategoryRepository, 'listProjectCategories');
      countByCategoryIdSpy = vi.spyOn(assetRepository, 'countByCategoryId');
    });

    afterEach(() => {
      findByIdSpy.mockRestore();
      findProjectCategoryByIdSpy.mockRestore();
      listProjectCategoriesSpy.mockRestore();
      countByCategoryIdSpy.mockRestore();
    });

    function expectZeroDependencyCalls() {
      expect(findByIdSpy).not.toHaveBeenCalled();
      expect(findProjectCategoryByIdSpy).not.toHaveBeenCalled();
      expect(listProjectCategoriesSpy).not.toHaveBeenCalled();
      expect(countByCategoryIdSpy).not.toHaveBeenCalled();
    }

    describe('add', () => {
      it('a malformed projectId throws the validation error with zero dependency calls', () => {
        expect(() => service.add('not-an-id', { displayName: 'X', directorySlug: 'x' }))
          .toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a non-object input throws with zero dependency calls (never a raw TypeError)', () => {
        expect(() => service.add(project.id, null)).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('an invalid displayName/directorySlug throws with zero dependency calls', () => {
        expect(() => service.add(project.id, { displayName: '', directorySlug: 'x' }))
          .toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a non-boolean enabled throws with zero dependency calls', () => {
        expect(() => service.add(project.id, { displayName: 'X', directorySlug: 'x', enabled: 'yes' }))
          .toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a valid projectId referring to a missing project still performs the lookup and reports not found', () => {
        expect(() => service.add(999999, { displayName: 'X', directorySlug: 'x' })).toThrow(ProjectNotFoundError);
        expect(findByIdSpy).toHaveBeenCalled();
      });
    });

    describe('editDisplayName', () => {
      it('a malformed projectId throws with zero dependency calls', () => {
        expect(() => service.editDisplayName('bad', 1, { displayName: 'X' })).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a malformed categoryId throws with zero dependency calls', () => {
        expect(() => service.editDisplayName(project.id, 'bad', { displayName: 'X' })).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a non-object input throws with zero dependency calls', () => {
        expect(() => service.editDisplayName(project.id, 1, undefined)).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('an invalid displayName throws with zero dependency calls', () => {
        expect(() => service.editDisplayName(project.id, 1, { displayName: '' })).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });
    });

    describe('setEnabled', () => {
      it('a malformed projectId throws with zero dependency calls', () => {
        expect(() => service.setEnabled('bad', 1, true)).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a malformed categoryId throws with zero dependency calls', () => {
        expect(() => service.setEnabled(project.id, 'bad', true)).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a non-boolean enabled throws with zero dependency calls', () => {
        expect(() => service.setEnabled(project.id, 1, 'yes')).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });
    });

    describe('reorder', () => {
      it('a malformed projectId throws with zero dependency calls', () => {
        expect(() => service.reorder('bad', [1, 2])).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a non-array order throws with zero dependency calls', () => {
        expect(() => service.reorder(project.id, 'not-an-array')).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a non-positive-integer ID in the order throws with zero dependency calls', () => {
        expect(() => service.reorder(project.id, [1, -2])).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a duplicate ID in the order throws with zero dependency calls', () => {
        expect(() => service.reorder(project.id, [1, 1])).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });
    });

    describe('delete', () => {
      it('a malformed projectId throws with zero dependency calls', () => {
        expect(() => service.delete('bad', 1)).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a malformed categoryId throws with zero dependency calls, even when projectId is valid', () => {
        expect(() => service.delete(project.id, 'bad')).toThrow(AssetCategoryValidationError);
        expectZeroDependencyCalls();
      });

      it('a valid but missing category still performs the lookup and reports not found', () => {
        expect(() => service.delete(project.id, 999999)).toThrow(AssetCategoryNotFoundError);
        expect(findByIdSpy).toHaveBeenCalled();
        expect(findProjectCategoryByIdSpy).toHaveBeenCalled();
      });
    });
  });

  // ─── list ──────────────────────────────────────────────────────────

  describe('list', () => {
    it('lists enabled and disabled categories in deterministic order', () => {
      const listed = service.list(project.id);
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.map((c) => c.display_order)).toEqual(listed.map((_, i) => i));
    });

    it('throws ProjectNotFoundError for an unknown project', () => {
      expect(() => service.list(999999)).toThrow(ProjectNotFoundError);
    });

    it('allows listing an archived project (read-only)', () => {
      projectService.archive(project.id);
      expect(() => service.list(project.id)).not.toThrow();
    });
  });

  // ─── mutability guard ─────────────────────────────────────────────

  describe('archived project mutability', () => {
    let category;

    beforeEach(() => {
      category = service.list(project.id)[0];
      projectService.archive(project.id);
    });

    it('rejects add on an archived project', () => {
      expect(() => service.add(project.id, { displayName: 'Raw', directorySlug: 'raw' }))
        .toThrow(ProjectArchivedError);
    });

    it('rejects editDisplayName on an archived project', () => {
      expect(() => service.editDisplayName(project.id, category.id, { displayName: 'X' }))
        .toThrow(ProjectArchivedError);
    });

    it('rejects setEnabled on an archived project', () => {
      expect(() => service.setEnabled(project.id, category.id, false)).toThrow(ProjectArchivedError);
    });

    it('rejects reorder on an archived project', () => {
      expect(() => service.reorder(project.id, [category.id])).toThrow(ProjectArchivedError);
    });

    it('rejects delete on an archived project', () => {
      expect(() => service.delete(project.id, category.id)).toThrow(ProjectArchivedError);
    });
  });

  // ─── project/category scoping ─────────────────────────────────────

  describe('project scoping', () => {
    it('a category owned by another project behaves as not found', () => {
      const other = projectService.create(validProjectInput({ title: 'Other Project' }));
      const otherCategory = service.list(other.id)[0];

      expect(() => service.editDisplayName(project.id, otherCategory.id, { displayName: 'Hijack' }))
        .toThrow(AssetCategoryNotFoundError);
    });
  });

  // ─── Add ───────────────────────────────────────────────────────────

  describe('add', () => {
    it('creates one direct-child directory and a manifest entry when enabled', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: true });

      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(true);
      expect(fs.statSync(path.join(absPath, 'raw')).isDirectory()).toBe(true);

      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === 'raw')).toEqual({
        displayName: 'Raw', directorySlug: 'raw', displayOrder: category.display_order, enabled: true,
      });
    });

    it('creates no directory when disabled', () => {
      service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(false);

      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === 'raw').enabled).toBe(false);
    });

    it('defaults to enabled when omitted', () => {
      service.add(project.id, { displayName: 'Raw', directorySlug: 'raw' });
      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(true);
    });

    it('appends at the next project-local position', () => {
      const before = service.list(project.id);
      const added = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw' });
      expect(added.display_order).toBe(before.length);
    });

    it('rejects an exact slug conflict with an existing project category', () => {
      const [existing] = service.list(project.id);
      let caught;
      try {
        service.add(project.id, { displayName: 'Dup', directorySlug: existing.directory_slug });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
      expect(caught.code).toBe('SLUG_CONFLICT');
    });

    it('rejects a slug conflict that differs only by case from an existing (raw-inserted) category', () => {
      const [existing] = service.list(project.id);
      // A differently-cased slug can never arrive through validated input,
      // but the conflict check itself must still be case-insensitive —
      // simulate a pre-existing raw-inserted row to prove that.
      db.prepare(`
        UPDATE project_asset_categories SET directory_slug = ? WHERE id = ?
      `).run(existing.directory_slug.toUpperCase(), existing.id);

      let caught;
      try {
        service.add(project.id, { displayName: 'Dup', directorySlug: existing.directory_slug });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
      expect(caught.code).toBe('SLUG_CONFLICT');
    });

    it('rejects invalid display name / slug input', () => {
      expect(() => service.add(project.id, { displayName: '', directorySlug: 'raw' }))
        .toThrow(AssetCategoryValidationError);
      expect(() => service.add(project.id, { displayName: 'Raw', directorySlug: 'Not Valid' }))
        .toThrow(AssetCategoryValidationError);
    });

    it('rolls back the category row and safely removes only the directory it created, on manifest failure', () => {
      const before = service.list(project.id);

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('manifest write failed');
      });

      try {
        expect(() => service.add(project.id, { displayName: 'Raw', directorySlug: 'raw' })).toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(false);
      expect(service.list(project.id)).toEqual(before);
    });

    it('never removes a pre-existing directory when creation itself fails due to a race', () => {
      // Pre-create the destination out from under the service (simulates a
      // race between the case-insensitive preflight and the exclusive mkdir).
      fs.mkdirSync(path.join(absPath, 'raw'));
      fs.writeFileSync(path.join(absPath, 'raw', 'keep.txt'), 'keep');

      const preflightSpy = vi.spyOn(fs, 'readdirSync');
      // Let the case-insensitive preflight pass by pretending the dir isn't there yet.
      preflightSpy.mockImplementationOnce(() => []);

      try {
        expect(() => service.add(project.id, { displayName: 'Raw', directorySlug: 'raw' })).toThrow();
      } finally {
        preflightSpy.mockRestore();
      }

      expect(fs.existsSync(path.join(absPath, 'raw', 'keep.txt'))).toBe(true);
    });

    // Defect 1: a real SQLite commit-time failure (not a thrown error from
    // writeManifestSync) happening AFTER the manifest was already published
    // from the in-progress (about-to-roll-back) state.
    it('restores the prior manifest and rolls back the inserted row when the transaction fails at commit time', () => {
      const before = service.list(project.id);
      const manifestBefore = readManifestSync(absPath);

      const spy = forceCommitFailureOn(assetCategoryRepository, 'listProjectCategories', 2, project.id);
      let caught;
      try {
        try {
          service.add(project.id, { displayName: 'Raw', directorySlug: 'raw' });
        } catch (err) {
          caught = err;
        }
      } finally {
        spy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/FOREIGN KEY constraint failed/i);

      // Inserted row rolled back.
      expect(service.list(project.id)).toEqual(before);
      // Prior manifest is restored exactly.
      expect(readManifestSync(absPath)).toEqual(manifestBefore);
      // The directory created inside the failed transaction was cleaned up.
      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(false);
    });
  });

  // ─── editDisplayName ───────────────────────────────────────────────

  describe('editDisplayName', () => {
    it('updates only the display name, with no filesystem rename', () => {
      const [category] = service.list(project.id);

      const before = fs.readdirSync(absPath).sort();
      const updated = service.editDisplayName(project.id, category.id, { displayName: 'Renamed Display' });

      expect(updated.display_name).toBe('Renamed Display');
      expect(updated.directory_slug).toBe(category.directory_slug);
      expect(fs.readdirSync(absPath).sort()).toEqual(before);

      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === category.directory_slug).displayName)
        .toBe('Renamed Display');
    });

    it('rejects an invalid display name', () => {
      const [category] = service.list(project.id);
      expect(() => service.editDisplayName(project.id, category.id, { displayName: '' }))
        .toThrow(AssetCategoryValidationError);
    });

    it('rolls back the database change when manifest publication fails', () => {
      const [category] = service.list(project.id);
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('manifest write failed');
      });

      try {
        expect(() => service.editDisplayName(project.id, category.id, { displayName: 'New Name' })).toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id).display_name)
        .toBe(category.display_name);
    });

    it('throws AssetCategoryNotFoundError for an unknown category', () => {
      expect(() => service.editDisplayName(project.id, 999999, { displayName: 'X' }))
        .toThrow(AssetCategoryNotFoundError);
    });

    // Defect 1: old name and prior manifest remain after a real commit-time
    // failure that happens after the manifest was already published.
    it('restores the old name and the prior manifest when the transaction fails at commit time', () => {
      const [category] = service.list(project.id);
      const manifestBefore = readManifestSync(absPath);

      const spy = forceCommitFailureOn(assetCategoryRepository, 'listProjectCategories', 2, project.id);
      let caught;
      try {
        try {
          service.editDisplayName(project.id, category.id, { displayName: 'New Name' });
        } catch (err) {
          caught = err;
        }
      } finally {
        spy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/FOREIGN KEY constraint failed/i);

      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id).display_name)
        .toBe(category.display_name);
      expect(readManifestSync(absPath)).toEqual(manifestBefore);
    });
  });

  // ─── setEnabled ────────────────────────────────────────────────────

  describe('setEnabled — disable', () => {
    it('preserves the directory and assets when disabling', () => {
      const [category] = service.list(project.id);
      const asset = assetRepository.upsert(project.id, `${category.directory_slug}/a.png`, {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: category.id,
      });

      const updated = service.setEnabled(project.id, category.id, false);

      expect(updated.enabled).toBe(0);
      expect(fs.existsSync(path.join(absPath, category.directory_slug))).toBe(true);
      expect(assetRepository.findById(asset.id)).toBeTruthy();

      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === category.directory_slug).enabled).toBe(false);
    });

    // Defect 1: prior enabled state and manifest remain after a real
    // commit-time failure that happens after the manifest was published.
    it('restores the prior enabled state and manifest when the transaction fails at commit time', () => {
      const [category] = service.list(project.id);
      const manifestBefore = readManifestSync(absPath);

      const spy = forceCommitFailureOn(assetCategoryRepository, 'listProjectCategories', 2, project.id);
      let caught;
      try {
        try {
          service.setEnabled(project.id, category.id, false);
        } catch (err) {
          caught = err;
        }
      } finally {
        spy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/FOREIGN KEY constraint failed/i);

      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id).enabled).toBe(1);
      expect(readManifestSync(absPath)).toEqual(manifestBefore);
    });
  });

  describe('setEnabled — enable', () => {
    it('exclusively creates the directory when absent', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(false);

      const updated = service.setEnabled(project.id, category.id, true);

      expect(updated.enabled).toBe(1);
      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(true);
    });

    it('validates an existing directory instead of recreating it', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      fs.mkdirSync(path.join(absPath, 'raw'));
      fs.writeFileSync(path.join(absPath, 'raw', 'keep.txt'), 'keep');

      service.setEnabled(project.id, category.id, true);

      expect(fs.existsSync(path.join(absPath, 'raw', 'keep.txt'))).toBe(true);
    });

    it('rejects an existing file at the destination', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      fs.writeFileSync(path.join(absPath, 'raw'), 'not a directory');

      expect(() => service.setEnabled(project.id, category.id, true)).toThrow();
    });

    it('never removes a pre-existing directory when enabling fails', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      fs.mkdirSync(path.join(absPath, 'raw'));
      fs.writeFileSync(path.join(absPath, 'raw', 'keep.txt'), 'keep');

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('manifest write failed');
      });

      try {
        expect(() => service.setEnabled(project.id, category.id, true)).toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(path.join(absPath, 'raw', 'keep.txt'))).toBe(true);
    });

    it('rolls back a directory it created itself when enabling fails', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('manifest write failed');
      });

      try {
        expect(() => service.setEnabled(project.id, category.id, true)).toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(false);
      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id).enabled).toBe(0);
    });

    // Defect 1: a newly created directory is compensated safely, and the
    // prior enabled state and manifest are restored, after a real
    // commit-time failure that happens after the manifest was published.
    it('rolls back a newly created directory and restores prior state when the transaction fails at commit time', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      const manifestBefore = readManifestSync(absPath);

      const spy = forceCommitFailureOn(assetCategoryRepository, 'listProjectCategories', 2, project.id);
      let caught;
      try {
        try {
          service.setEnabled(project.id, category.id, true);
        } catch (err) {
          caught = err;
        }
      } finally {
        spy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/FOREIGN KEY constraint failed/i);

      // The directory this call created was cleaned up.
      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(false);
      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id).enabled).toBe(0);
      expect(readManifestSync(absPath)).toEqual(manifestBefore);
    });
  });

  // ─── reorder ───────────────────────────────────────────────────────

  describe('reorder', () => {
    it('persists a full reorder and rewrites the manifest', () => {
      const categories = service.list(project.id);
      const reversedIds = categories.map((c) => c.id).reverse();

      const reordered = service.reorder(project.id, reversedIds);

      expect(reordered.map((c) => c.id)).toEqual(reversedIds);
      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.map((c) => c.directorySlug)).toEqual(
        reordered.map((c) => c.directory_slug)
      );
    });

    it('performs no filesystem changes', () => {
      const categories = service.list(project.id);
      const before = fs.readdirSync(absPath).sort();

      service.reorder(project.id, categories.map((c) => c.id).reverse());

      expect(fs.readdirSync(absPath).sort()).toEqual(before);
    });

    it('rejects a partial or unknown ID sequence and mutates nothing', () => {
      const categories = service.list(project.id);
      const ids = categories.map((c) => c.id);
      expect(() => service.reorder(project.id, ids.slice(1))).toThrow();
      expect(service.list(project.id)).toEqual(categories);
    });

    it('rolls back on manifest failure', () => {
      const categories = service.list(project.id);
      const before = service.list(project.id);

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('manifest write failed');
      });

      try {
        expect(() => service.reorder(project.id, categories.map((c) => c.id).reverse())).toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      expect(service.list(project.id)).toEqual(before);
    });

    // Defect 1: prior order and manifest remain after a real commit-time
    // failure that happens after the manifest was published.
    it('restores the prior order and manifest when the transaction fails at commit time', () => {
      const before = service.list(project.id);
      const manifestBefore = readManifestSync(absPath);
      const reversedIds = before.map((c) => c.id).reverse();

      const spy = forceCommitFailureOn(assetCategoryRepository, 'reorderProjectCategories', 1, project.id);
      let caught;
      try {
        try {
          service.reorder(project.id, reversedIds);
        } catch (err) {
          caught = err;
        }
      } finally {
        spy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/FOREIGN KEY constraint failed/i);

      expect(service.list(project.id)).toEqual(before);
      expect(readManifestSync(absPath)).toEqual(manifestBefore);
    });
  });

  // ─── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('rejects deletion when a present asset references the category', () => {
      const [category] = service.list(project.id);
      assetRepository.upsert(project.id, `${category.directory_slug}/a.png`, {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: category.id,
      });

      let caught;
      try {
        service.delete(project.id, category.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
      expect(caught.code).toBe('HAS_ASSETS');
    });

    it('rejects deletion when a missing asset references the category', () => {
      const [category] = service.list(project.id);
      assetRepository.upsert(project.id, `${category.directory_slug}/a.png`, {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: category.id,
      });
      assetRepository.markAllMissing(project.id);

      expect(() => service.delete(project.id, category.id)).toThrow(ProjectAssetCategoryError);
    });

    it('rejects deletion of a non-empty directory', () => {
      const [category] = service.list(project.id);
      fs.writeFileSync(path.join(absPath, category.directory_slug, 'leftover.txt'), 'x');

      let caught;
      try {
        service.delete(project.id, category.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
      expect(caught.code).toBe('NOT_EMPTY');
      expect(fs.existsSync(path.join(absPath, category.directory_slug))).toBe(true);
    });

    it('rejects deletion when the category path is a file', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      fs.writeFileSync(path.join(absPath, 'raw'), 'not a dir');

      expect(() => service.delete(project.id, category.id)).toThrow(ProjectAssetCategoryError);
    });

    it('succeeds when the directory is absent', () => {
      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      expect(fs.existsSync(path.join(absPath, 'raw'))).toBe(false);

      const result = service.delete(project.id, category.id);

      expect(result).toBe(true);
      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeUndefined();
    });

    it('resets the selected project preference when deleting that category', () => {
      const [category] = service.list(project.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', category.id);

      expect(service.delete(project.id, category.id)).toBe(true);

      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeUndefined();
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'inherit',
        categoryId: null,
      });
    });

    it('leaves a selected preference unchanged when deleting another category', () => {
      const [selected, target] = service.list(project.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', selected.id);

      expect(service.delete(project.id, target.id)).toBe(true);

      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: selected.id,
      });
    });

    it.each(['all', 'inherit'])('leaves a %s project preference unchanged when deleting a category', (mode) => {
      const [category] = service.list(project.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, mode, null);

      expect(service.delete(project.id, category.id)).toBe(true);

      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode,
        categoryId: null,
      });
    });

    it('retains a disabled selected category and resolves it again after re-enabling', () => {
      const [category] = service.list(project.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', category.id);

      service.setEnabled(project.id, category.id, false);
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: category.id,
      });
      expect(assetBrowserPreferenceService.resolveEffectiveCategory(project.id)).toMatchObject({
        fallback: true,
        effective: { kind: 'all', category: null },
      });

      service.setEnabled(project.id, category.id, true);
      expect(assetBrowserPreferenceService.resolveEffectiveCategory(project.id)).toMatchObject({
        fallback: false,
        effective: { kind: 'category', category: { id: category.id } },
      });
    });

    it('leaves the preference unchanged when deletion is blocked by an asset assignment', () => {
      const [category] = service.list(project.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', category.id);
      assetRepository.upsert(project.id, `${category.directory_slug}/a.png`, {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: category.id,
      });

      expect(() => service.delete(project.id, category.id)).toThrow(ProjectAssetCategoryError);
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: category.id,
      });
      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
    });

    it('rolls back the category deletion when preference reset fails', () => {
      const [category] = service.list(project.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', category.id);
      const originalReset = assetBrowserPreferenceRepository.resetProjectPreferenceIfCategory.bind(
        assetBrowserPreferenceRepository
      );
      const resetSpy = vi.spyOn(assetBrowserPreferenceRepository, 'resetProjectPreferenceIfCategory')
        .mockImplementation((...args) => {
          originalReset(...args);
          throw new Error('preference reset failed');
        });

      try {
        expect(() => service.delete(project.id, category.id)).toThrow('preference reset failed');
      } finally {
        resetSpy.mockRestore();
      }

      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: category.id,
      });
      expect(fs.existsSync(path.join(absPath, category.directory_slug))).toBe(true);
    });

    it('rolls back the preference reset when category deletion fails', () => {
      const [category] = service.list(project.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', category.id);
      const originalDelete = assetCategoryRepository.deleteProjectCategoryAndCompact.bind(
        assetCategoryRepository
      );
      const deleteSpy = vi.spyOn(assetCategoryRepository, 'deleteProjectCategoryAndCompact')
        .mockImplementation((...args) => {
          originalDelete(...args);
          throw new Error('category deletion failed');
        });

      try {
        expect(() => service.delete(project.id, category.id)).toThrow('category deletion failed');
      } finally {
        deleteSpy.mockRestore();
      }

      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: category.id,
      });
      expect(fs.existsSync(path.join(absPath, category.directory_slug))).toBe(true);
    });

    it('cannot use a category ID from another project to reset this project preference', () => {
      const [category] = service.list(project.id);
      const otherProject = projectService.create(validProjectInput({ title: 'Other Project' }));
      const [otherCategory] = assetCategoryRepository.listProjectCategories(otherProject.id);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', category.id);

      expect(() => service.delete(project.id, otherCategory.id)).toThrow(AssetCategoryNotFoundError);
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: category.id,
      });
      expect(assetCategoryRepository.findProjectCategoryById(otherProject.id, otherCategory.id)).toBeTruthy();
    });

    it('safely quarantines and removes an empty directory, compacting positions', () => {
      const categoriesBefore = service.list(project.id);
      const target = categoriesBefore[1];

      const result = service.delete(project.id, target.id);

      expect(result).toBe(true);
      expect(fs.existsSync(path.join(absPath, target.directory_slug))).toBe(false);
      // No leftover quarantine artifact.
      const leftover = fs.readdirSync(absPath).filter((name) => name.startsWith('.cc-cat-'));
      expect(leftover).toEqual([]);

      const after = service.list(project.id);
      expect(after.find((c) => c.id === target.id)).toBeUndefined();
      expect(after.map((c) => c.display_order)).toEqual(after.map((_, i) => i));

      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === target.directory_slug)).toBeUndefined();
    });

    it('rejects deletion of a symlinked category path', () => {
      const symlinksSupported = (() => {
        try {
          const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-symlink-probe-'));
          const target = path.join(probe, 't');
          const link = path.join(probe, 'l');
          fs.mkdirSync(target);
          fs.symlinkSync(target, link, 'junction');
          fs.rmSync(probe, { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      })();
      if (!symlinksSupported) return;

      const category = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw', enabled: false });
      const realTarget = path.join(tmpDir, 'outside-target');
      fs.mkdirSync(realTarget);
      fs.symlinkSync(realTarget, path.join(absPath, 'raw'), 'junction');

      let caught;
      try {
        service.delete(project.id, category.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
      expect(caught.code).toBe('PATH_UNSAFE');
    });

    // Defect 2: filesystem mutations cannot participate in the SQLite
    // transaction, so the (already-proven-empty) directory is removed
    // BEFORE the category row is deleted. If the database/manifest
    // transaction then fails, the row survives but its directory is gone —
    // compensation must recreate that empty directory (or, if that isn't
    // safely possible, report the failure without touching the row).
    it('recreates the empty category directory when the database/manifest transaction fails after pre-commit removal', () => {
      const [category] = service.list(project.id);
      const slug = category.directory_slug;
      const categoryPath = path.join(absPath, slug);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', category.id);

      const originalRenameSync = fs.renameSync.bind(fs);
      let calls = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        calls++;
        // Call 1 is the quarantine rename (must succeed so the directory is
        // proven empty and removed pre-commit); call 2 is the manifest's
        // atomic temp->final rename inside the database transaction.
        if (calls === 2) {
          throw new Error('manifest write failed');
        }
        return originalRenameSync(...args);
      });

      try {
        expect(() => service.delete(project.id, category.id)).toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      // Category row remains — the transaction rolled back.
      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
      // The selected-category reset rolled back with the failed transaction.
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: category.id,
      });
      // Manifest remains unchanged (still lists the category).
      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === slug)).toBeTruthy();
      // The empty directory was recreated as compensation.
      expect(fs.existsSync(categoryPath)).toBe(true);
      expect(fs.statSync(categoryPath).isDirectory()).toBe(true);
      expect(fs.readdirSync(categoryPath)).toEqual([]);
      // No leftover quarantine artifact.
      const leftover = fs.readdirSync(absPath).filter((name) => name.startsWith('.cc-cat-quarantine-'));
      expect(leftover).toEqual([]);
    });

    // Defect 1: a real SQLite commit-time failure (not a thrown error from
    // writeManifestSync) happening AFTER the manifest was already
    // published from the (about-to-roll-back) in-progress state, and after
    // the category directory was already removed pre-commit.
    it('restores the category row, order, selected preference, prior manifest bytes, and directory when the transaction fails at commit time', () => {
      const categoriesBefore = service.list(project.id);
      const target = categoriesBefore[1];
      const manifestBefore = readManifestSync(absPath);
      assetBrowserPreferenceRepository.upsertProjectPreference(project.id, 'category', target.id);

      // Unrelated asset/release state that must be completely undisturbed.
      const otherCategory = categoriesBefore[0];
      const otherAsset = assetRepository.upsert(project.id, `${otherCategory.directory_slug}/kept.png`, {
        filename: 'kept.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: otherCategory.id,
      });
      const release = insertRelease(project.id, 'Kept Release');
      linkReleaseAsset(release.id, otherAsset.id);
      const releaseAssetsBefore = db.prepare('SELECT * FROM release_assets').all();

      const spy = forceCommitFailureOn(assetCategoryRepository, 'listProjectCategories', 2, project.id);
      let caught;
      try {
        try {
          service.delete(project.id, target.id);
        } catch (err) {
          caught = err;
        }
      } finally {
        spy.mockRestore();
      }

      // The original commit failure is what the caller sees.
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/FOREIGN KEY constraint failed/i);

      // Category row and order remain exactly as before.
      expect(service.list(project.id)).toEqual(categoriesBefore);
      // The selected-category reset rolled back with the failed transaction.
      expect(assetBrowserPreferenceService.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: target.id,
      });
      // The prior manifest bytes are restored exactly.
      expect(readManifestSync(absPath)).toEqual(manifestBefore);
      // The category directory was recreated (empty) as compensation.
      const categoryPath = path.join(absPath, target.directory_slug);
      expect(fs.existsSync(categoryPath)).toBe(true);
      expect(fs.readdirSync(categoryPath)).toEqual([]);
      // No quarantine artifact remains after successful compensation.
      const leftover = fs.readdirSync(absPath).filter((name) => name.startsWith('.cc-cat-quarantine-'));
      expect(leftover).toEqual([]);
      // No asset or release association changed.
      expect(assetRepository.findById(otherAsset.id)).toBeTruthy();
      expect(db.prepare('SELECT * FROM release_assets').all()).toEqual(releaseAssetsBefore);
    });

    it('does not overwrite a competing artifact when post-failure recreation is blocked, and reports the compensation failure', () => {
      const errorLogs = [];
      const testLogger = { error: (msg) => errorLogs.push(msg) };
      const spiedService = makeService({ logger: testLogger });

      const [category] = spiedService.list(project.id);
      const slug = category.directory_slug;
      const categoryPath = path.join(absPath, slug);

      const originalRenameSync = fs.renameSync.bind(fs);
      let calls = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        calls++;
        if (calls === 2) {
          // A foreign actor claims the now-empty slug in the window
          // between pre-commit removal and the failed manifest write.
          fs.mkdirSync(categoryPath);
          fs.writeFileSync(path.join(categoryPath, 'competing.txt'), 'competing');
          throw new Error('manifest write failed');
        }
        return originalRenameSync(...args);
      });

      try {
        expect(() => spiedService.delete(project.id, category.id)).toThrow();
      } finally {
        renameSpy.mockRestore();
      }

      // The competing artifact was never overwritten by compensation.
      expect(fs.existsSync(path.join(categoryPath, 'competing.txt'))).toBe(true);
      // Category row remains despite the directory being unavailable.
      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
      // The compensation failure was logged, not thrown as the primary error.
      expect(errorLogs.some((msg) => msg.includes('could not recreate category directory'))).toBe(true);
    });

    it('never recursively deletes a category directory', () => {
      const rmSyncSpy = vi.spyOn(fs, 'rmSync');
      try {
        const created = service.add(project.id, { displayName: 'Temp', directorySlug: 'temp-cat', enabled: true });
        service.delete(project.id, created.id);
      } finally {
        rmSyncSpy.mockRestore();
      }
      expect(rmSyncSpy).not.toHaveBeenCalled();
    });

    it('throws AssetCategoryNotFoundError for an unknown category', () => {
      expect(() => service.delete(project.id, 999999)).toThrow(AssetCategoryNotFoundError);
    });

    // Defect 3: emptiness must be proven on the quarantined directory
    // (after the atomic move), not just on the original path beforehand.
    describe('race safety — content appearing around quarantine', () => {
      it('a file created after the preflight check but before/at quarantine prevents deletion', () => {
        const [category] = service.list(project.id);
        const slug = category.directory_slug;
        const categoryDirPath = path.join(absPath, slug);

        // The preflight readdirSync call (on the original path) is the
        // first one delete() makes; fake it reporting "empty", and use that
        // exact moment to drop a file in — simulating a concurrent actor
        // racing the check. The file travels into quarantine with the
        // directory and must still be caught by the post-quarantine check.
        const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
          fs.writeFileSync(path.join(categoryDirPath, 'concurrent.txt'), 'concurrent');
          return [];
        });

        let caught;
        try {
          try {
            service.delete(project.id, category.id);
          } catch (err) {
            caught = err;
          }
        } finally {
          readdirSpy.mockRestore();
        }

        expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
        expect(caught.code).toBe('NOT_EMPTY');

        // Category row remains — the database was never touched.
        expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
        // Manifest remains unchanged.
        const manifest = readManifestSync(absPath);
        expect(manifest.assetCategories.find((c) => c.directorySlug === slug)).toBeTruthy();

        // Restoration can never safely move content back (no portable
        // no-replace rename), so the file is not lost — it is left inside
        // the quarantined directory rather than silently discarded, and
        // the original slug path is left absent (never overwritten, and
        // never blindly restored either).
        const quarantineEntry = fs.readdirSync(absPath).find((name) => name.startsWith('.cc-cat-quarantine-'));
        expect(quarantineEntry).toBeTruthy();
        expect(fs.existsSync(path.join(absPath, quarantineEntry, 'concurrent.txt'))).toBe(true);
        expect(fs.existsSync(categoryDirPath)).toBe(false);
      });

      it('content appearing between the emptiness proof and pre-commit removal prevents deletion', () => {
        const [category] = service.list(project.id);
        const slug = category.directory_slug;

        // The authoritative emptiness proof (step 1) and the pre-commit
        // removal's own internal emptiness check (step 2) are two separate
        // readdirSync calls on the quarantine path. Let the first one see
        // genuinely empty (as it truly is), and use that exact moment to
        // drop a file in — so the second call, moments later, discovers it
        // before the database is ever touched.
        const originalReaddirSync = fs.readdirSync.bind(fs);
        let injected = false;
        const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
          const result = originalReaddirSync(p, ...rest);
          if (!injected && typeof p === 'string' && p.includes('.cc-cat-quarantine-') && result.length === 0) {
            injected = true;
            fs.writeFileSync(path.join(p, 'late.txt'), 'late');
          }
          return result;
        });

        const rmSyncSpy = vi.spyOn(fs, 'rmSync');

        let caught;
        try {
          try {
            service.delete(project.id, category.id);
          } catch (err) {
            caught = err;
          }
        } finally {
          readdirSpy.mockRestore();
          rmSyncSpy.mockRestore();
        }

        expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
        expect(caught.code).toBe('NOT_EMPTY');

        // Deletion did not commit.
        expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
        const manifest = readManifestSync(absPath);
        expect(manifest.assetCategories.find((c) => c.directorySlug === slug)).toBeTruthy();

        // The late file is not lost — it is left inside the quarantine.
        const quarantineEntry = fs.readdirSync(absPath).find((name) => name.startsWith('.cc-cat-quarantine-'));
        expect(quarantineEntry).toBeTruthy();
        expect(fs.existsSync(path.join(absPath, quarantineEntry, 'late.txt'))).toBe(true);
        // Never removed recursively.
        expect(rmSyncSpy).not.toHaveBeenCalled();
      });
    });

    // Defect 2: a structured read failure from the removal helper (not a
    // raw filesystem exception) must prevent the database mutation and
    // surface as a controlled category error.
    it('a read failure during pre-commit quarantine removal prevents deletion and reports a controlled error', () => {
      const errorLogs = [];
      const testLogger = { error: (msg) => errorLogs.push(msg) };
      const spiedService = makeService({ logger: testLogger });

      const [category] = spiedService.list(project.id);
      const slug = category.directory_slug;

      // First quarantine readdirSync call is the service's own authoritative
      // emptiness proof (let it succeed normally); the second is
      // removeEmptyDirIfIdentityMatches' internal check — fail that one.
      const originalReaddirSync = fs.readdirSync.bind(fs);
      let quarantineReaddirCalls = 0;
      const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
        if (typeof p === 'string' && p.includes('.cc-cat-quarantine-')) {
          quarantineReaddirCalls++;
          if (quarantineReaddirCalls === 2) {
            const err = new Error('permission denied');
            err.code = 'EACCES';
            throw err;
          }
        }
        return originalReaddirSync(p, ...rest);
      });

      let caught;
      try {
        try {
          spiedService.delete(project.id, category.id);
        } catch (err) {
          caught = err;
        }
      } finally {
        readdirSpy.mockRestore();
      }

      expect(caught).toBeInstanceOf(ProjectAssetCategoryError);
      expect(caught.code).toBe('NOT_EMPTY');
      // The controlled error never leaks the raw filesystem error or a path.
      expect(caught.message).not.toMatch(/EACCES|permission denied/i);
      expect(caught.message).not.toContain(absPath);

      // Database mutation never happened — category row remains.
      expect(assetCategoryRepository.findProjectCategoryById(project.id, category.id)).toBeTruthy();
      // Manifest was never rewritten.
      const manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === slug)).toBeTruthy();
      // Quarantine remains preserved.
      const quarantineEntry = fs.readdirSync(absPath).find((name) => name.startsWith('.cc-cat-quarantine-'));
      expect(quarantineEntry).toBeTruthy();
      // A safe, path-free log entry was emitted with the structured reason.
      expect(errorLogs.some((m) => m.includes('read-failed'))).toBe(true);
      expect(errorLogs.every((m) => !m.includes(absPath))).toBe(true);
    });
  });

  // ─── global defaults isolation ─────────────────────────────────────

  it('never mutates global category defaults', () => {
    const defaultsBefore = assetCategoryRepository.listDefaults();

    const added = service.add(project.id, { displayName: 'Raw', directorySlug: 'raw' });
    service.editDisplayName(project.id, added.id, { displayName: 'Renamed' });
    service.setEnabled(project.id, added.id, false);
    service.setEnabled(project.id, added.id, true);
    service.reorder(project.id, service.list(project.id).map((c) => c.id).reverse());
    service.delete(project.id, added.id);

    expect(assetCategoryRepository.listDefaults()).toEqual(defaultsBefore);
  });
});
