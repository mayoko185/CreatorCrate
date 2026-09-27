/**
 * PM-1B: new-project ownership binding and ownership-gated project-root
 * filesystem mutations (rename, deletion, category directories).
 *
 * Filesystem-backed: substitution scenarios physically move real project
 * directories rather than mocking a mismatch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';
import { createProjectAssetCategoryService } from '../src/services/project-asset-category-service.js';
import { ProjectOwnershipError } from '../src/services/project-directory-ownership.js';
import {
  PROJECT_OWNERSHIP_MARKER_FILENAME,
  generateProjectOwnershipToken,
  serializeProjectOwnershipMarker,
} from '../src/storage/project-ownership-marker.js';
import { MANIFEST_FILENAME } from '../src/storage/manifest.js';
import { formatProjectDirName } from '../src/storage/project-storage.js';
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const DEFAULT_CATEGORY_SLUGS = ['final', 'krz', 'wip', 'wm', 'wm-lq'];

function input(title, overrides = {}) {
  return { title, description: '', notes: '', status: 'tbd', patreonUrl: null, ...overrides };
}

function ownershipError(code) {
  return expect.objectContaining({ name: 'ProjectOwnershipError', code });
}

describe('project directory ownership (PM-1B)', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let projectRepository;
  let assetCategoryRepository;
  let ownershipRepository;
  let projectService;
  let categoryService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pm1b-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);

    projectRepository = createProjectRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
    ownershipRepository = createProjectDirectoryOwnershipRepository(db);
    const assetBrowserPreferenceRepository = createAssetBrowserPreferenceRepository(db);
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService: createAssetCategoryService(assetCategoryRepository),
      assetBrowserPreferenceRepository,
      projectOptionCatalogueService: createTestProjectOptionCatalogueService(db),
      projectRepository,
      projectDirectoryOwnershipRepository: ownershipRepository,
    });
    categoryService = createProjectAssetCategoryService({
      db,
      projectRepository,
      assetCategoryRepository,
      assetRepository: createAssetRepository(db),
      assetBrowserPreferenceRepository,
      projectDirectoryOwnershipRepository: ownershipRepository,
      projectsRoot,
      logger: { error() {} },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── helpers ──────────────────────────────────────────────────────────

  function dirOf(project) {
    return path.join(projectsRoot, project.project_dir);
  }

  function markerOf(dir) {
    return path.join(dir, PROJECT_OWNERSHIP_MARKER_FILENAME);
  }

  function writeMarker(dir, token) {
    fs.writeFileSync(markerOf(dir), serializeProjectOwnershipMarker(token));
  }

  function tokenOf(project) {
    return ownershipRepository.findByProjectId(project.id).token;
  }

  function ownershipRows() {
    return db.prepare('SELECT project_id, token, state FROM project_directory_ownership ORDER BY project_id').all();
  }

  function categoryRows(projectId) {
    return db.prepare('SELECT id, directory_slug, display_order, enabled FROM project_asset_categories WHERE project_id = ? ORDER BY display_order').all(projectId);
  }

  function rootEntries() {
    return fs.readdirSync(projectsRoot).sort();
  }

  function quarantineEntries() {
    return fs.readdirSync(projectsRoot).filter((name) => name.startsWith('.cc-quarantine-'));
  }

  function categoryId(projectId, slug) {
    return db.prepare('SELECT id FROM project_asset_categories WHERE project_id = ? AND directory_slug = ?')
      .get(projectId, slug).id;
  }

  /**
   * Put B's real directory (with B's marker and content) at A's stored
   * pathname. A's original directory is parked outside PROJECTS_ROOT; no DB
   * state changes.
   */
  function substituteBIntoA(a, b) {
    const aDir = dirOf(a);
    const parked = path.join(tmpDir, 'parked-a');
    fs.renameSync(aDir, parked);
    fs.renameSync(dirOf(b), aDir);
    return { aDir, parked };
  }

  function makeLegacyUnbound(project) {
    // The shape of an installation at the end of PM-1A: no ownership row and
    // no marker, but a legacy project.json naming this project.
    db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
    fs.rmSync(markerOf(dirOf(project)));
    fs.writeFileSync(path.join(dirOf(project), MANIFEST_FILENAME), JSON.stringify({ schemaVersion: 3, id: project.id }));
  }

  // ─── New-project binding ──────────────────────────────────────────────

  describe('new project binding', () => {
    it('creates a project row, a bound ownership row, a matching marker, and the category tree', () => {
      const project = projectService.create(input('Alpha'));
      const dir = dirOf(project);

      expect(project.project_dir).toBe(formatProjectDirName(project.id, 'alpha'));
      const binding = ownershipRepository.findByProjectId(project.id);
      expect(binding).toMatchObject({ projectId: project.id, state: 'bound' });
      expect(fs.readFileSync(markerOf(dir), 'ascii')).toBe(serializeProjectOwnershipMarker(binding.token));
      expect(fs.readdirSync(dir).sort()).toEqual([PROJECT_OWNERSHIP_MARKER_FILENAME, ...DEFAULT_CATEGORY_SLUGS]);
      expect(fs.existsSync(path.join(dir, MANIFEST_FILENAME))).toBe(false);
    });

    it('gives every project a distinct token', () => {
      const a = projectService.create(input('Alpha'));
      const b = projectService.create(input('Beta'));
      expect(tokenOf(a)).not.toBe(tokenOf(b));
    });

    it('rolls back the project, ownership row, and operation-owned directories when marker creation fails', () => {
      const realOpen = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (String(target).endsWith(PROJECT_OWNERSHIP_MARKER_FILENAME)) {
          const err = new Error('denied');
          err.code = 'EACCES';
          throw err;
        }
        return realOpen(target, ...rest);
      });

      expect(() => projectService.create(input('Alpha'))).toThrow('Project creation failed');
      expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM project_asset_categories').get().c).toBe(0);
      expect(ownershipRows()).toEqual([]);
      expect(rootEntries()).toEqual([]);
    });

    it('removes the marker it created when binding cannot be completed', () => {
      vi.spyOn(ownershipRepository, 'markBound').mockReturnValue(false);

      expect(() => projectService.create(input('Alpha'))).toThrow('Project creation failed');
      expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c).toBe(0);
      expect(ownershipRows()).toEqual([]);
      expect(rootEntries()).toEqual([]);
    });

    it.each([
      ['its own unconfirmed marker', null],
      ['a foreign replacement', 'foreign'],
    ])('keeps the new directory with %s when the marker fails after exposure', (_label, replace) => {
      const foreignToken = generateProjectOwnershipToken();
      const realOpen = fs.openSync;
      const realFsync = fs.fsyncSync;
      const realClose = fs.closeSync;
      let markerFd = null;
      let markerFile = null;
      let closed = false;
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        const fd = realOpen(target, flags, ...rest);
        if (markerFd === null && path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME
          && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) {
          markerFd = fd;
          markerFile = String(target);
        }
        return fd;
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (fd === markerFd && !closed) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return realFsync(fd);
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        realClose(fd);
        if (fd !== markerFd || closed) return;
        closed = true;
        if (replace) {
          fs.unlinkSync(markerFile);
          fs.writeFileSync(markerFile, serializeProjectOwnershipMarker(foreignToken));
        }
      });
      const rename = vi.spyOn(fs, 'renameSync');
      const rmdir = vi.spyOn(fs, 'rmdirSync');
      const unlink = vi.spyOn(fs, 'unlinkSync');

      let error;
      try { projectService.create(input('Alpha')); } catch (err) { error = err; }
      const cleanupCalls = rename.mock.calls.length + rmdir.mock.calls.length
        + unlink.mock.calls.length - (replace ? 1 : 0);
      vi.restoreAllMocks();

      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(error.message).toMatch(/^Project creation failed/);
      expect(error.message).not.toContain(projectsRoot);
      expect(error.cause).toMatchObject({ name: 'ProjectOwnershipMarkerError', code: 'RECOVERY_REQUIRED' });
      // SQLite rolled back completely.
      expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM project_asset_categories').get().c).toBe(0);
      expect(ownershipRows()).toEqual([]);
      // The directory, its category directories, and the public marker are
      // left exactly where they are: nothing was moved, quarantined or removed.
      expect(cleanupCalls).toBe(0);
      const dirName = formatProjectDirName(1, 'alpha');
      expect(rootEntries()).toEqual([dirName]);
      const root = path.join(projectsRoot, dirName);
      expect(fs.readdirSync(root).sort()).toEqual([PROJECT_OWNERSHIP_MARKER_FILENAME, ...DEFAULT_CATEGORY_SLUGS].sort());
      const marker = fs.readFileSync(markerOf(root), 'ascii');
      if (replace) expect(marker).toBe(serializeProjectOwnershipMarker(foreignToken));
      else expect(marker).toMatch(/^creatorcrate-owner\/1 [0-9a-f]{64}\n$/);
    });

    it('never adopts or overwrites a pre-existing directory that already carries a marker', () => {
      const foreignDir = path.join(projectsRoot, formatProjectDirName(1, 'alpha'));
      fs.mkdirSync(foreignDir);
      const foreignToken = generateProjectOwnershipToken();
      writeMarker(foreignDir, foreignToken);
      fs.writeFileSync(path.join(foreignDir, 'keep.txt'), 'foreign');

      expect(() => projectService.create(input('Alpha'))).toThrow('Project creation failed');
      expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c).toBe(0);
      expect(ownershipRows()).toEqual([]);
      expect(fs.readFileSync(markerOf(foreignDir), 'ascii')).toBe(serializeProjectOwnershipMarker(foreignToken));
      expect(fs.readdirSync(foreignDir).sort()).toEqual([PROJECT_OWNERSHIP_MARKER_FILENAME, 'keep.txt']);
    });

    it('fails without overwriting a marker that appears inside the new root before the marker is written', () => {
      const realMkdir = fs.mkdirSync;
      const foreignToken = generateProjectOwnershipToken();
      vi.spyOn(fs, 'mkdirSync').mockImplementation((target, ...rest) => {
        const result = realMkdir(target, ...rest);
        if (path.dirname(String(target)) === projectsRoot) {
          fs.writeFileSync(markerOf(String(target)), serializeProjectOwnershipMarker(foreignToken));
        }
        return result;
      });

      expect(() => projectService.create(input('Alpha'))).toThrow('Project creation failed');
      expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c).toBe(0);
      expect(ownershipRows()).toEqual([]);
      // The foreign marker survives untouched; only the category directories
      // this operation created were removed, so the non-empty root remains.
      const root = path.join(projectsRoot, formatProjectDirName(1, 'alpha'));
      expect(fs.readdirSync(root)).toEqual([PROJECT_OWNERSHIP_MARKER_FILENAME]);
      expect(fs.readFileSync(markerOf(root), 'ascii')).toBe(serializeProjectOwnershipMarker(foreignToken));
    });

    it('cannot bind a mismatched token or re-bind an existing binding', () => {
      const project = projectService.create(input('Alpha'));
      const token = tokenOf(project);
      const other = generateProjectOwnershipToken();

      expect(ownershipRepository.markBound(project.id, other)).toBe(false);
      expect(ownershipRepository.createPending(project.id, other)).toBeNull();
      expect(ownershipRepository.deletePending(project.id, token)).toBe(false);
      expect(ownershipRepository.findByProjectId(project.id)).toEqual({ projectId: project.id, token, state: 'bound' });
    });

    it('performs metadata-only edits without reading or rewriting the marker', () => {
      const project = projectService.create(input('Alpha'));
      fs.rmSync(markerOf(dirOf(project)));
      const openSpy = vi.spyOn(fs, 'openSync');

      const edited = projectService.update(project.id, input('Alpha', { description: 'Edited', status: 'ready' }));
      expect(edited).toMatchObject({ description: 'Edited', status: 'ready' });
      expect(projectService.archive(project.id).status).toBe('archived');

      expect(openSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(markerOf(dirOf(project)))).toBe(false);
    });
  });

  // ─── Substituted directory ───────────────────────────────────────────

  describe('substituted directory (B moved into A\'s stored pathname)', () => {
    let a;
    let b;
    let aDir;

    beforeEach(() => {
      a = projectService.create(input('Alpha'));
      b = projectService.create(input('Beta'));
      fs.writeFileSync(path.join(dirOf(b), 'b-content.txt'), 'belongs to B');
      ({ aDir } = substituteBIntoA(a, b));
    });

    function expectBIntactAtAPath() {
      expect(fs.readFileSync(path.join(aDir, 'b-content.txt'), 'utf8')).toBe('belongs to B');
      expect(fs.readFileSync(markerOf(aDir), 'ascii')).toBe(serializeProjectOwnershipMarker(tokenOf(b)));
      expect(fs.readdirSync(aDir).sort()).toEqual([PROJECT_OWNERSHIP_MARKER_FILENAME, 'b-content.txt', ...DEFAULT_CATEGORY_SLUGS].sort());
    }

    it('rejects renaming A before any filesystem rename', () => {
      const renameSpy = vi.spyOn(fs, 'renameSync');

      expect(() => projectService.update(a.id, input('Alpha Renamed'))).toThrowError(ownershipError('MARKER_MISMATCH'));

      expect(renameSpy).not.toHaveBeenCalled();
      expectBIntactAtAPath();
      expect(fs.existsSync(path.join(projectsRoot, formatProjectDirName(a.id, 'alpha-renamed')))).toBe(false);
      expect(projectRepository.findById(a.id)).toMatchObject({ title: 'Alpha', project_dir: a.project_dir });
    });

    it('rejects deleting A before quarantine; B content and A relationships survive', () => {
      const categoriesBefore = categoryRows(a.id);
      const renameSpy = vi.spyOn(fs, 'renameSync');

      expect(() => projectService.deleteProject(a.id)).toThrowError(ownershipError('MARKER_MISMATCH'));

      expect(renameSpy).not.toHaveBeenCalled();
      expect(quarantineEntries()).toEqual([]);
      expectBIntactAtAPath();
      expect(projectRepository.findById(a.id)).toBeTruthy();
      expect(categoryRows(a.id)).toEqual(categoriesBefore);
      expect(ownershipRepository.findByProjectId(a.id).state).toBe('bound');
    });

    it('rejects category directory creation, enable, and deletion inside B', () => {
      expect(() => categoryService.add(a.id, { displayName: 'Extra', directorySlug: 'extra' }))
        .toThrowError(ownershipError('MARKER_MISMATCH'));
      expect(fs.existsSync(path.join(aDir, 'extra'))).toBe(false);

      const finalId = categoryId(a.id, 'final');
      categoryService.setEnabled(a.id, finalId, false);
      expect(() => categoryService.setEnabled(a.id, finalId, true)).toThrowError(ownershipError('MARKER_MISMATCH'));

      const wipId = categoryId(a.id, 'wip');
      expect(() => categoryService.delete(a.id, wipId)).toThrowError(ownershipError('MARKER_MISMATCH'));
      expect(assetCategoryRepository.findProjectCategoryById(a.id, wipId)).toBeTruthy();

      expectBIntactAtAPath();
    });

    it('still allows DB-only category operations on A', () => {
      const created = categoryService.add(a.id, { displayName: 'Later', directorySlug: 'later', enabled: false });
      expect(created.enabled).toBeFalsy();
      categoryService.editDisplayName(a.id, created.id, { displayName: 'Later Renamed' });
      const ids = categoryRows(a.id).map((row) => row.id).reverse();
      expect(categoryService.reorder(a.id, ids).map((row) => row.id)).toEqual(ids);
      expect(fs.existsSync(path.join(aDir, 'later'))).toBe(false);
      expectBIntactAtAPath();
    });
  });

  // ─── Removed / recreated directory at the same path ───────────────────

  describe('unrelated directory recreated at a bound project\'s path', () => {
    const cases = [
      ['no marker', () => {}, 'MARKER_MISSING'],
      ['another project token', (dir) => writeMarker(dir, generateProjectOwnershipToken()), 'MARKER_MISMATCH'],
      ['a malformed marker', (dir) => fs.writeFileSync(markerOf(dir), 'not a marker\n'), 'MARKER_MALFORMED'],
      ['a directory at the marker name', (dir) => fs.mkdirSync(markerOf(dir)), 'MARKER_UNSAFE'],
    ];

    for (const [label, plant, code] of cases) {
      it(`fails closed with ${label}`, () => {
        const project = projectService.create(input('Alpha'));
        const dir = dirOf(project);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        fs.mkdirSync(path.join(dir, 'wip'));
        fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'unrelated');
        plant(dir);
        const before = fs.readdirSync(dir).sort();

        expect(() => projectService.update(project.id, input('Alpha Renamed'))).toThrowError(ownershipError(code));
        expect(() => projectService.deleteProject(project.id)).toThrowError(ownershipError(code));
        expect(() => categoryService.add(project.id, { displayName: 'Extra', directorySlug: 'extra' }))
          .toThrowError(ownershipError(code));
        expect(() => categoryService.delete(project.id, categoryId(project.id, 'wip')))
          .toThrowError(ownershipError(code));

        expect(fs.readdirSync(dir).sort()).toEqual(before);
        expect(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8')).toBe('unrelated');
        expect(projectRepository.findById(project.id)).toMatchObject({ title: 'Alpha', project_dir: project.project_dir });
        expect(ownershipRepository.findByProjectId(project.id).state).toBe('bound');
        expect(quarantineEntries()).toEqual([]);
      });
    }

    it('fails closed when the marker cannot be read', () => {
      const project = projectService.create(input('Alpha'));
      const marker = markerOf(dirOf(project));
      const realOpen = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (String(target) === marker) {
          const err = new Error('busy');
          err.code = 'EBUSY';
          throw err;
        }
        return realOpen(target, ...rest);
      });

      expect(() => projectService.update(project.id, input('Alpha Renamed'))).toThrowError(ownershipError('MARKER_UNREADABLE'));
      expect(() => projectService.deleteProject(project.id)).toThrowError(ownershipError('MARKER_UNREADABLE'));
      expect(fs.existsSync(dirOf(project))).toBe(true);
      expect(projectRepository.findById(project.id)).toBeTruthy();
    });
  });

  // ─── Legacy unbound projects (before PM-1C) ───────────────────────────

  describe('legacy unbound project', () => {
    let project;
    let dir;

    beforeEach(() => {
      project = projectService.create(input('Legacy'));
      dir = dirOf(project);
      makeLegacyUnbound(project);
    });

    function expectStillUnbound() {
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(fs.existsSync(markerOf(dir))).toBe(false);
    }

    it('keeps metadata-only project and category operations working', () => {
      expect(projectService.update(project.id, input('Legacy', { notes: 'n', status: 'ready' })).notes).toBe('n');
      const finalId = categoryId(project.id, 'final');
      categoryService.editDisplayName(project.id, finalId, { displayName: 'Finals' });
      categoryService.setEnabled(project.id, finalId, false);
      const ids = categoryRows(project.id).map((row) => row.id).reverse();
      categoryService.reorder(project.id, ids);
      categoryService.add(project.id, { displayName: 'Later', directorySlug: 'later', enabled: false });
      expect(projectService.archive(project.id).status).toBe('archived');
      expectStillUnbound();
    });

    it('blocks ownership-sensitive filesystem mutations without binding or reading project.json', () => {
      const manifestBytes = fs.readFileSync(path.join(dir, MANIFEST_FILENAME));
      const readSpy = vi.spyOn(fs, 'readFileSync');

      expect(() => projectService.update(project.id, input('Legacy Renamed'))).toThrowError(ownershipError('UNBOUND'));
      expect(() => projectService.deleteProject(project.id)).toThrowError(ownershipError('UNBOUND'));
      expect(() => categoryService.add(project.id, { displayName: 'Extra', directorySlug: 'extra' }))
        .toThrowError(ownershipError('UNBOUND'));
      const finalId = categoryId(project.id, 'final');
      categoryService.setEnabled(project.id, finalId, false);
      expect(() => categoryService.setEnabled(project.id, finalId, true)).toThrowError(ownershipError('UNBOUND'));
      expect(() => categoryService.delete(project.id, categoryId(project.id, 'wip'))).toThrowError(ownershipError('UNBOUND'));

      expect(readSpy.mock.calls.some(([target]) => String(target).endsWith(MANIFEST_FILENAME))).toBe(false);
      readSpy.mockRestore();
      expectStillUnbound();
      expect(fs.readFileSync(path.join(dir, MANIFEST_FILENAME)).equals(manifestBytes)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'extra'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'wip'))).toBe(true);
      expect(projectRepository.findById(project.id)).toMatchObject({ title: 'Legacy', project_dir: project.project_dir });
    });
  });

  // ─── Legitimate rename ────────────────────────────────────────────────

  describe('legitimate rename', () => {
    it('moves the marker with the directory and keeps the binding unchanged', () => {
      const project = projectService.create(input('Alpha'));
      const token = tokenOf(project);
      const categoriesBefore = categoryRows(project.id);
      const oldDir = dirOf(project);

      const renamed = projectService.update(project.id, input('New Slug'));

      expect(renamed.id).toBe(project.id);
      expect(renamed.project_dir).toBe(formatProjectDirName(project.id, 'new-slug'));
      expect(fs.existsSync(oldDir)).toBe(false);
      expect(fs.readFileSync(markerOf(dirOf(renamed)), 'ascii')).toBe(serializeProjectOwnershipMarker(token));
      expect(ownershipRepository.findByProjectId(project.id)).toEqual({ projectId: project.id, token, state: 'bound' });
      expect(categoryRows(project.id)).toEqual(categoriesBefore);
      expect(fs.existsSync(path.join(dirOf(renamed), MANIFEST_FILENAME))).toBe(false);
      expect(ownershipRows()).toHaveLength(1);
    });

    it('moves the directory back with its marker when the DB update fails after the move', () => {
      const project = projectService.create(input('Alpha'));
      const token = tokenOf(project);
      vi.spyOn(projectRepository, 'setProjectDir').mockImplementationOnce(() => {
        throw new Error('db failure');
      });

      expect(() => projectService.update(project.id, input('New Slug'))).toThrow('Project update failed');

      expect(fs.readFileSync(markerOf(dirOf(project)), 'ascii')).toBe(serializeProjectOwnershipMarker(token));
      expect(fs.existsSync(path.join(projectsRoot, formatProjectDirName(project.id, 'new-slug')))).toBe(false);
      expect(projectRepository.findById(project.id)).toMatchObject({ title: 'Alpha', project_dir: project.project_dir });
      expect(ownershipRepository.findByProjectId(project.id).state).toBe('bound');

      // The binding remains valid for a later legitimate rename.
      expect(projectService.update(project.id, input('New Slug')).project_dir)
        .toBe(formatProjectDirName(project.id, 'new-slug'));
    });

    it('rejects a substitution at the mutation boundary, after preflight verification', () => {
      const a = projectService.create(input('Alpha'));
      const b = projectService.create(input('Beta'));
      const realUpdate = projectRepository.update.bind(projectRepository);
      let aDir;
      vi.spyOn(projectRepository, 'update').mockImplementation((...args) => {
        const result = realUpdate(...args);
        ({ aDir } = substituteBIntoA(a, b));
        return result;
      });

      expect(() => projectService.update(a.id, input('Alpha Renamed'))).toThrowError(expect.objectContaining({
        name: 'ProjectOwnershipError',
      }));

      expect(fs.readFileSync(markerOf(aDir), 'ascii')).toBe(serializeProjectOwnershipMarker(tokenOf(b)));
      expect(fs.existsSync(path.join(projectsRoot, formatProjectDirName(a.id, 'alpha-renamed')))).toBe(false);
      expect(projectRepository.findById(a.id)).toMatchObject({ title: 'Alpha', project_dir: a.project_dir });
    });

    it('moves the directory back, without rewriting the marker, when the destination fails verification', () => {
      const project = projectService.create(input('Alpha'));
      const oldDir = dirOf(project);
      const newDir = path.join(projectsRoot, formatProjectDirName(project.id, 'new-slug'));
      const tampered = generateProjectOwnershipToken();
      const realRename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        realRename(from, to);
        if (from === oldDir && to === newDir) writeMarker(newDir, tampered);
      });

      expect(() => projectService.update(project.id, input('New Slug'))).toThrowError(ownershipError('MARKER_MISMATCH'));

      expect(fs.existsSync(newDir)).toBe(false);
      expect(fs.readFileSync(markerOf(oldDir), 'ascii')).toBe(serializeProjectOwnershipMarker(tampered));
      expect(projectRepository.findById(project.id)).toMatchObject({ title: 'Alpha', project_dir: project.project_dir });
    });
  });

  // ─── Deletion ─────────────────────────────────────────────────────────

  describe('deletion', () => {
    it('deletes a correctly bound project, its directory, and its binding', () => {
      const project = projectService.create(input('Alpha'));
      fs.writeFileSync(path.join(dirOf(project), 'owned.txt'), 'x');

      expect(projectService.deleteProject(project.id)).toBe(true);
      expect(projectRepository.findById(project.id)).toBeUndefined();
      expect(ownershipRows()).toEqual([]);
      expect(rootEntries()).toEqual([]);
    });

    it('rejects a missing marker before quarantine', () => {
      const project = projectService.create(input('Alpha'));
      fs.rmSync(markerOf(dirOf(project)));

      expect(() => projectService.deleteProject(project.id)).toThrowError(ownershipError('MARKER_MISSING'));
      expect(fs.existsSync(dirOf(project))).toBe(true);
      expect(quarantineEntries()).toEqual([]);
      expect(projectRepository.findById(project.id)).toBeTruthy();
    });

    it('fails closed when the whole projects root is unavailable', () => {
      const project = projectService.create(input('Alpha'));
      fs.renameSync(projectsRoot, path.join(tmpDir, 'offline-share'));

      expect(() => projectService.deleteProject(project.id)).toThrowError(expect.objectContaining({
        name: 'ProjectOwnershipError',
      }));
      expect(projectRepository.findById(project.id)).toBeTruthy();
      expect(categoryRows(project.id).length).toBeGreaterThan(0);
    });

    it('keeps the marker and directory in place when the DB deletion rolls back', () => {
      const project = projectService.create(input('Alpha'));
      const token = tokenOf(project);
      vi.spyOn(projectRepository, 'deleteById').mockImplementationOnce(() => {
        throw new Error('db failure');
      });

      expect(() => projectService.deleteProject(project.id)).toThrow('Project deletion failed');
      expect(fs.readFileSync(markerOf(dirOf(project)), 'ascii')).toBe(serializeProjectOwnershipMarker(token));
      expect(ownershipRepository.findByProjectId(project.id).state).toBe('bound');
      expect(quarantineEntries()).toEqual([]);
    });

    it('restores the staged directory when it fails ownership verification after quarantine', () => {
      const project = projectService.create(input('Alpha'));
      const dir = dirOf(project);
      fs.writeFileSync(path.join(dir, 'owned.txt'), 'x');
      const tampered = generateProjectOwnershipToken();
      const realRename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        realRename(from, to);
        if (from === dir && path.basename(to).startsWith('.cc-quarantine-')) writeMarker(to, tampered);
      });

      expect(() => projectService.deleteProject(project.id)).toThrowError(ownershipError('MARKER_MISMATCH'));
      expect(fs.readFileSync(path.join(dir, 'owned.txt'), 'utf8')).toBe('x');
      expect(quarantineEntries()).toEqual([]);
      expect(projectRepository.findById(project.id)).toBeTruthy();
    });

    it('never recursively removes a staged directory whose ownership changed before removal', () => {
      const project = projectService.create(input('Alpha'));
      fs.writeFileSync(path.join(dirOf(project), 'owned.txt'), 'x');
      const realDelete = projectRepository.deleteById.bind(projectRepository);
      vi.spyOn(projectRepository, 'deleteById').mockImplementation((id) => {
        const result = realDelete(id);
        const [staged] = quarantineEntries();
        writeMarker(path.join(projectsRoot, staged), generateProjectOwnershipToken());
        return result;
      });

      expect(() => projectService.deleteProject(project.id)).toThrow(/cleanup requires recovery/);
      const [staged] = quarantineEntries();
      expect(fs.readFileSync(path.join(projectsRoot, staged, 'owned.txt'), 'utf8')).toBe('x');
    });
  });

  // ─── Category filesystem operations ───────────────────────────────────

  describe('category operations', () => {
    it('creates a disabled category without resolving the project directory or marker', () => {
      const project = projectService.create(input('Alpha'));
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(project.id);
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
      const lstatSpy = vi.spyOn(fs, 'lstatSync');
      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      const openSpy = vi.spyOn(fs, 'openSync');

      const created = categoryService.add(project.id, { displayName: 'Later', directorySlug: 'later', enabled: false });

      expect(created).toMatchObject({ directory_slug: 'later' });
      expect(created.enabled).toBeFalsy();
      expect(lstatSpy).not.toHaveBeenCalled();
      expect(readdirSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('keeps DB-only category operations independent of the project directory', () => {
      const project = projectService.create(input('Alpha'));
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(project.id);
      const finalId = categoryId(project.id, 'final');

      categoryService.editDisplayName(project.id, finalId, { displayName: 'Finals' });
      categoryService.setEnabled(project.id, finalId, false);
      const ids = categoryRows(project.id).map((row) => row.id).reverse();
      expect(categoryService.reorder(project.id, ids).map((row) => row.id)).toEqual(ids);
    });

    it('creates an enabled category directory in a verified project', () => {
      const project = projectService.create(input('Alpha'));
      categoryService.add(project.id, { displayName: 'Extra', directorySlug: 'extra' });
      expect(fs.statSync(path.join(dirOf(project), 'extra')).isDirectory()).toBe(true);
    });

    it('re-enables and deletes category directories in a verified project', () => {
      const project = projectService.create(input('Alpha'));
      const wipId = categoryId(project.id, 'wip');
      categoryService.setEnabled(project.id, wipId, false);
      fs.rmdirSync(path.join(dirOf(project), 'wip'));
      categoryService.setEnabled(project.id, wipId, true);
      expect(fs.statSync(path.join(dirOf(project), 'wip')).isDirectory()).toBe(true);

      expect(categoryService.delete(project.id, wipId)).toBe(true);
      expect(fs.existsSync(path.join(dirOf(project), 'wip'))).toBe(false);
      expect(fs.existsSync(markerOf(dirOf(project)))).toBe(true);
    });
  });

  it('exposes ownership failures as 4xx errors without absolute paths', () => {
    const project = projectService.create(input('Alpha'));
    fs.rmSync(markerOf(dirOf(project)));
    try {
      projectService.update(project.id, input('Alpha Renamed'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectOwnershipError);
      expect(err.status).toBe(409);
      expect(err.message).not.toContain(tmpDir);
    }
  });
});
