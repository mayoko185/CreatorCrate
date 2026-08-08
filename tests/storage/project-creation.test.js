import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../../src/db.js';
import { createAssetCategoryRepository } from '../../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../../src/services/asset-category-service.js';
import {
  createProjectService,
  ProjectValidationError,
} from '../../src/services/project-service.js';
import {
  formatProjectDirName,
  resolveProjectDir,
  verifyProjectDirOwnership,
} from '../../src/storage/project-storage.js';
import { MANIFEST_FILENAME } from '../../src/storage/manifest.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

// ─── Helpers ─────────────────────────────────────────────────────────────

function validInput(overrides = {}) {
  return {
    title: 'Creation Test',
    description: 'Test description',
    notes: 'Test notes',
    status: 'tbd',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}

/**
 * Resolve the flat project directory path. Status never participates:
 * the project directory is always a direct child of PROJECTS_ROOT.
 */
function projectDirPath(project, root) {
  const dirName = formatProjectDirName(project.id, project.slug);
  return resolveProjectDir(root, dirName);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('project creation integration', () => {
  let tmpDir;
  let db;
  let service;
  let assetBrowserPreferenceRepository;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-creation-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(db));
    assetBrowserPreferenceRepository = createAssetBrowserPreferenceRepository(db);
    service = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Success path ─────────────────────────────────────────────────────

  describe('successful creation', () => {
    it('creates database record with all fields', () => {
      const project = service.create(validInput({ title: 'Full Record', description: 'Desc' }));
      expect(project.id).toBeGreaterThan(0);
      expect(project.title).toBe('Full Record');
      expect(project.slug).toBe('full-record');
      expect(project.description).toBe('Desc');
      expect(project.status).toBe('tbd');
      expect(project).not.toHaveProperty('priority');
      expect(project.created_at).toBeTruthy();
      expect(project.updated_at).toBeTruthy();
      expect(project.archived_at).toBeNull();
      expect(db.prepare(`
        SELECT default_category_mode, default_category_id
        FROM project_asset_browser_preferences
        WHERE project_id = ?
      `).get(project.id)).toEqual({ default_category_mode: 'inherit', default_category_id: null });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM project_asset_browser_preferences
        WHERE project_id = ?
      `).get(project.id).count).toBe(1);
    });

    it('creates the project directory as a direct child of PROJECTS_ROOT regardless of status', () => {
      for (const status of ['tbd', 'planned', 'in-progress', 'ready']) {
        const project = service.create(validInput({
          title: `Path Check ${status}`,
          status,
        }));

        const absPath = projectDirPath(project, projectsRoot);
        expect(fs.existsSync(absPath)).toBe(true);
        expect(fs.statSync(absPath).isDirectory()).toBe(true);
        // Status never participates: the directory is always flat at the root.
        expect(path.dirname(absPath)).toBe(path.resolve(projectsRoot));
        expect(project.project_dir).toBe(formatProjectDirName(project.id, project.slug));
        expect(project.project_dir.split(path.sep)).toHaveLength(1);
      }
    });

    it('does not create any status directory', () => {
      service.create(validInput({ title: 'No Status Dirs', status: 'in-progress' }));
      const entries = fs.readdirSync(projectsRoot);
      expect(entries).not.toContain('active');
      expect(entries).not.toContain('archived');
      expect(entries).not.toContain('inbox');
      expect(entries).not.toContain('tbd');
    });

    it('uses six-digit zero-padded ID in directory name', () => {
      const project = service.create(validInput({ title: 'ID Prefix' }));
      const dirName = formatProjectDirName(project.id, project.slug);
      expect(dirName).toMatch(/^\d{6}-/);
      const prefix = dirName.split('-')[0];
      expect(Number(prefix)).toBe(project.id);
    });

    it('creates exactly the expected category directories', () => {
      const project = service.create(validInput({ title: 'Subdir Check' }));
      const absPath = projectDirPath(project, projectsRoot);

      const expected = ['final', 'wip', 'krz', 'wm', 'wm-lq'];

      for (const sub of expected) {
        const subPath = path.join(absPath, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.statSync(subPath).isDirectory()).toBe(true);
      }

      // No legacy exports/full or exports/web nesting.
      expect(fs.existsSync(path.join(absPath, 'exports', 'full'))).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'exports', 'web'))).toBe(false);

      const topLevel = fs.readdirSync(absPath).filter((e) => e !== MANIFEST_FILENAME);
      expect(topLevel.sort()).toEqual([...expected].sort());
    });

    it('writes a schema-version-3 manifest without status', () => {
      const project = service.create(validInput({
        title: 'Manifest Data',
        description: 'Desc for manifest',
        notes: 'Notes for manifest',
        status: 'planned',
        plannedDate: '2026-09-15',
        patreonUrl: 'https://patreon.com/artist',
      }));

      const absPath = projectDirPath(project, projectsRoot);
      const content = fs.readFileSync(path.join(absPath, MANIFEST_FILENAME), 'utf8');
      const manifest = JSON.parse(content);

      expect(manifest.schemaVersion).toBe(3);
      expect(manifest.id).toBe(project.id);
      expect(manifest.title).toBe('Manifest Data');
      expect(manifest.slug).toBe('manifest-data');
      expect(manifest).not.toHaveProperty('status');
      expect(content).not.toMatch(/"status"\s*:/);
      expect(manifest).not.toHaveProperty('priority');
      expect(content).not.toMatch(/"priority"\s*:/);
      expect(manifest.description).toBe('Desc for manifest');
      expect(manifest.notes).toBe('Notes for manifest');
      expect(manifest.plannedDate).toBe('2026-09-15T00:00:00.000Z');
      expect(manifest.publishedDate).toBeNull();
      expect(manifest.patreonUrl).toBe('https://patreon.com/artist');
      expect(manifest.createdAt).toBeTruthy();
      expect(manifest.updatedAt).toBeTruthy();
      expect(manifest.assetCategories.map((c) => c.directorySlug)).toEqual([
        'final', 'wip', 'krz', 'wm', 'wm-lq',
      ]);
      expect(manifest.assetCategories.every((c) => c.enabled === true)).toBe(true);
    });

    it('stores the flat relative path and returns the updated project', () => {
      const project = service.create(validInput({ title: 'Rel Path Store' }));
      expect(project.project_dir).toBeTruthy();

      const dirName = formatProjectDirName(project.id, project.slug);
      expect(project.project_dir).toBe(dirName);
      expect(project.project_dir.split(path.sep)).toHaveLength(1);

      // Verify via repository lookup
      const found = service.findById(project.id);
      expect(found.project_dir).toBe(dirName);
    });
  });

  // ── Failure injection and compensation ───────────────────────────────

  describe('compensation on failure', () => {
    it('rolls back the project, copied categories, and preference row when preference initialization fails', () => {
      const originalEnsure = assetBrowserPreferenceRepository.ensureProjectPreference.bind(
        assetBrowserPreferenceRepository
      );
      const preferenceSpy = vi.spyOn(assetBrowserPreferenceRepository, 'ensureProjectPreference')
        .mockImplementation((...args) => {
          originalEnsure(...args);
          throw new Error('preference insert failed');
        });

      try {
        expect(() => service.create(validInput({ title: 'Preference Insert Fail' }))).toThrow(
          'Project creation failed'
        );
      } finally {
        preferenceSpy.mockRestore();
      }

      expect(service.repository.findBySlug('preference-insert-fail')).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_categories').get().count).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_browser_preferences').get().count).toBe(0);
    });

    it('deletes database record when mkdirSync fails', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => service.create(validInput({ title: 'Mkdir Fail' }))).toThrow(
        'Project creation failed'
      );
      mkdirSpy.mockRestore();

      expect(service.repository.findBySlug('mkdir-fail')).toBeUndefined();
    });

    it('removes directory and database record when manifest write fails', () => {
      // writeManifestSync's atomic temp-file → project.json step uses
      // fs.renameSync — inject failure only for that specific rename.
      // Cleanup's own quarantine-and-verify sequence also uses
      // fs.renameSync (to move tracked artifacts aside before removing
      // them), so a blanket failure here would break compensation itself
      // rather than exercising it.
      const originalRenameSync = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        if (path.basename(dest) === 'project.json') {
          throw new Error('rename failed');
        }
        return originalRenameSync(src, dest);
      });

      expect(() => service.create(validInput({ title: 'Manifest Fail' }))).toThrow(
        'Project creation failed'
      );
      renameSpy.mockRestore();

      // No database record
      expect(service.repository.findBySlug('manifest-fail')).toBeUndefined();

      // No flat project directory remains at the root
      const entries = fs.readdirSync(projectsRoot);
      expect(entries.filter((e) => e.endsWith('-manifest-fail'))).toHaveLength(0);
    });

    it('removes directory and database record when setProjectDir fails', () => {
      const setDirSpy = vi.spyOn(service.repository, 'setProjectDir').mockImplementation(() => {
        throw new Error('DB update failed');
      });

      expect(() => service.create(validInput({ title: 'Set Dir Fail' }))).toThrow(
        'Project creation failed'
      );
      setDirSpy.mockRestore();

      expect(service.repository.findBySlug('set-dir-fail')).toBeUndefined();

      const entries = fs.readdirSync(projectsRoot);
      expect(entries.filter((e) => e.endsWith('-set-dir-fail'))).toHaveLength(0);
    });

    it('does not delete unrelated directories during rollback', () => {
      // Create a legitimate project first
      const legit = service.create(validInput({ title: 'Keep Me Safe' }));

      // Now create another that fails
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => service.create(validInput({ title: 'Fail Project' }))).toThrow(
        'Project creation failed'
      );
      renameSpy.mockRestore();

      // Legitimate project still exists
      const found = service.findById(legit.id);
      expect(found).toBeTruthy();
      expect(found.slug).toBe('keep-me-safe');
      expect(found.project_dir).toBeTruthy();

      // Its directory still exists
      const legitDir = projectDirPath(legit, projectsRoot);
      expect(fs.existsSync(legitDir)).toBe(true);
    });

    it('does not delete a replacement directory swapped in before compensation runs', () => {
      // Simulates a concurrent process renaming the newly created project
      // root away and dropping a foreign, non-empty, non-symlink directory
      // at the same path — all before compensation gets a chance to run.
      // Only a filesystem-identity check (not path/basename/containment
      // checks alone) can tell that the directory at the expected path is
      // no longer the one this operation created.
      let capturedAbsPath;
      let movedAsidePath;
      const foreignFileName = 'important-foreign-file.txt';
      const foreignFileContent = 'do not delete me';

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        // writeManifestSync's final step: renameSync(tempPath, manifestPath).
        // Intercept exactly that call, once.
        if (path.basename(dest) === 'project.json' && !capturedAbsPath) {
          capturedAbsPath = path.dirname(dest);
          movedAsidePath = `${capturedAbsPath}-moved-aside`;

          renameSpy.mockRestore();
          fs.renameSync(capturedAbsPath, movedAsidePath); // "another process" moves it away

          // A different, non-empty, non-symlink directory now occupies the
          // exact original expected path — same basename, same containment.
          fs.mkdirSync(capturedAbsPath, { recursive: true });
          fs.writeFileSync(path.join(capturedAbsPath, foreignFileName), foreignFileContent);

          throw new Error('injected manifest write failure');
        }
      });

      try {
        expect(() => service.create(validInput({ title: 'Swap Race' }))).toThrow(
          'Project creation failed. Please try again.'
        );
      } finally {
        renameSpy.mockRestore();
      }

      // Database rows (project + copied categories) rolled back.
      expect(service.repository.findBySlug('swap-race')).toBeUndefined();

      // The foreign replacement directory and its contents are untouched.
      expect(fs.existsSync(capturedAbsPath)).toBe(true);
      expect(fs.statSync(capturedAbsPath).isDirectory()).toBe(true);
      const foreignFilePath = path.join(capturedAbsPath, foreignFileName);
      expect(fs.existsSync(foreignFilePath)).toBe(true);
      expect(fs.readFileSync(foreignFilePath, 'utf8')).toBe(foreignFileContent);

      // Clean up test-created artifacts (outside the service's own cleanup).
      fs.rmSync(capturedAbsPath, { recursive: true, force: true });
      if (movedAsidePath && fs.existsSync(movedAsidePath)) {
        fs.rmSync(movedAsidePath, { recursive: true, force: true });
      }
    });

    it('does not delete a foreign artifact swapped in after a child passes its identity check', () => {
      // The tracked "source" category directory is quarantined (atomically
      // renamed aside) and its identity verified there — closing the old
      // check-then-remove race. This simulates a concurrent process
      // dropping a foreign, non-empty directory at the child's now-vacant
      // *original* pathname immediately after that quarantine rename
      // succeeds — i.e. after the identity check has already moved our own
      // artifact safely aside, and before removal from quarantine.
      const dirName = formatProjectDirName(1, 'child-swap');
      const absPath = resolveProjectDir(projectsRoot, dirName);
      const childPath = path.join(absPath, 'final');
      const foreignFileName = 'do-not-delete.txt';
      const foreignFileContent = 'foreign artifact — must survive';

      let intercepted = false;
      const originalRenameSync = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        if (!intercepted && path.basename(dest).startsWith('.cc-quarantine') && src === childPath) {
          intercepted = true;
          originalRenameSync(src, dest); // Cleanup's own atomic quarantine rename.
          fs.mkdirSync(src, { recursive: true });
          fs.writeFileSync(path.join(src, foreignFileName), foreignFileContent);
          return undefined;
        }
        return originalRenameSync(src, dest);
      });

      const setDirSpy = vi.spyOn(service.repository, 'setProjectDir').mockImplementation(() => {
        throw new Error('DB update failed');
      });

      try {
        expect(() => service.create(validInput({ title: 'Child Swap' }))).toThrow(
          'Project creation failed. Please try again.'
        );
      } finally {
        setDirSpy.mockRestore();
        renameSpy.mockRestore();
      }

      expect(intercepted).toBe(true);

      // Database rows rolled back — the original failure remains authoritative.
      expect(service.repository.findBySlug('child-swap')).toBeUndefined();

      // The foreign replacement at the child's original path is untouched.
      expect(fs.existsSync(childPath)).toBe(true);
      expect(fs.statSync(childPath).isDirectory()).toBe(true);
      const foreignFilePath = path.join(childPath, foreignFileName);
      expect(fs.existsSync(foreignFilePath)).toBe(true);
      expect(fs.readFileSync(foreignFilePath, 'utf8')).toBe(foreignFileContent);

      fs.rmSync(absPath, { recursive: true, force: true });
    });

    it('does not delete a foreign directory swapped in for the root after its identity check', () => {
      // Same race as above, but for the project root itself: a concurrent
      // process drops an empty foreign directory at the root's now-vacant
      // *original* pathname right after the root's own quarantine rename
      // succeeds (all tracked children have already been quarantined and
      // removed from the real, unswapped root by this point).
      const dirName = formatProjectDirName(1, 'root-swap');
      const absPath = resolveProjectDir(projectsRoot, dirName);

      let intercepted = false;
      const originalRenameSync = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        if (!intercepted && path.basename(dest).startsWith('.cc-quarantine') && src === absPath) {
          intercepted = true;
          originalRenameSync(src, dest); // Cleanup's own atomic quarantine rename of the root.
          fs.mkdirSync(src, { recursive: true });
          return undefined;
        }
        return originalRenameSync(src, dest);
      });

      const setDirSpy = vi.spyOn(service.repository, 'setProjectDir').mockImplementation(() => {
        throw new Error('DB update failed');
      });

      try {
        expect(() => service.create(validInput({ title: 'Root Swap' }))).toThrow(
          'Project creation failed. Please try again.'
        );
      } finally {
        setDirSpy.mockRestore();
        renameSpy.mockRestore();
      }

      expect(intercepted).toBe(true);

      // Database rows rolled back — the original failure remains authoritative.
      expect(service.repository.findBySlug('root-swap')).toBeUndefined();

      // The foreign replacement at the root's original path is untouched.
      expect(fs.existsSync(absPath)).toBe(true);
      expect(fs.statSync(absPath).isDirectory()).toBe(true);
      expect(fs.readdirSync(absPath)).toEqual([]);

      fs.rmSync(absPath, { recursive: true, force: true });
    });

    it('surfaces generic user-visible error without absolute paths', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      try {
        service.create(validInput({ title: 'Generic Error' }));
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err.message).toBe('Project creation failed. Please try again.');
        expect(err.message).not.toMatch(/[A-Z]:\\/);
        expect(err.message).not.toMatch(/\/\w+/);
      }

      mkdirSpy.mockRestore();
    });

    it('ownership verification correctly identifies matching and non-matching IDs', () => {
      const project = service.create(validInput({ title: 'Ownership Check' }));
      const absPath = projectDirPath(project, projectsRoot);

      expect(verifyProjectDirOwnership(absPath, project.id)).toBe(true);
      expect(verifyProjectDirOwnership(absPath, 99999)).toBe(false);
    });
  });

  // ── Concurrent creation ──────────────────────────────────────────────

  describe('concurrent creation safety', () => {
    it('rejects duplicate slugs', () => {
      service.create(validInput({ title: 'Unique Title' }));
      expect(() => service.create(validInput({ title: 'Unique Title' }))).toThrow(
        ProjectValidationError
      );
    });

    it('creates multiple projects with different slugs', () => {
      const p1 = service.create(validInput({ title: 'Project Alpha' }));
      const p2 = service.create(validInput({ title: 'Project Beta' }));

      expect(p2.id).not.toBe(p1.id);
      expect(p2.slug).not.toBe(p1.slug);

      for (const p of [p1, p2]) {
        const absPath = projectDirPath(p, projectsRoot);
        expect(fs.existsSync(absPath)).toBe(true);
      }
    });
  });
});
