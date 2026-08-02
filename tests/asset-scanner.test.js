import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService, ProjectNotFoundError } from '../src/services/project-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { createProjectPrimaryImageRepository } from '../src/data/project-primary-image-repository.js';
import { createProjectPrimaryImageService } from '../src/services/project-primary-image-service.js';
import { createWorkflowQueryService } from '../src/services/workflow-query-service.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';
import { createProjectOperationCoordinator, ProjectOperationError } from '../src/services/project-operation-coordinator.js';
import {
  formatProjectDirName,
  buildProjectRelPath,
  STATUS_DIR_MAP,
} from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset scanner', () => {
  let tmpDir;
  let db;
  let projectService;
  let projectRepo;
  let assetScanner;
  let primaryImageRepository;
  let primaryImageService;
  let workflowQueryService;
  let projectsRoot;
  let projectOperationCoordinator;

  /** Create a project and its directory on disk (mimics real creation). */
  function createProjectWithDir(title, status = 'tbd') {
    const project = projectRepo.create({
      title,
      slug: slugify(title, { lowercase: true }),
      description: '',
      notes: '',
      status,
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });

    const dirName = formatProjectDirName(project.id, project.slug);
    const relPath = buildProjectRelPath(project.status, dirName);
    const absPath = path.resolve(projectsRoot, relPath);
    fs.mkdirSync(absPath, { recursive: true });
    projectRepo.setProjectDir(project.id, relPath);

    return { project, absPath, relPath };
  }

  function getPrimaryImageModel(projectId) {
    return workflowQueryService.getProjectList({ limit: 25, offset: 0 }).rows
      .find((row) => row.id === projectId).primaryImage;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-scanner-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }

    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    projectRepo = createProjectRepository(db);
    const assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(db));
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(db),
    });
    projectOperationCoordinator = createProjectOperationCoordinator();
    assetScanner = createAssetScanner(db, projectsRoot, { projectService, assetCategoryService, projectOperationCoordinator });
    primaryImageRepository = createProjectPrimaryImageRepository(db);
    primaryImageService = createProjectPrimaryImageService({
      db,
      projectRepository: projectRepo,
      assetRepository: assetScanner.repository,
      projectPrimaryImageRepository: primaryImageRepository,
    });
    workflowQueryService = createWorkflowQueryService({
      db,
      evaluateReleaseReadiness,
      projectPrimaryImageRepository: primaryImageRepository,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic scanning ──────────────────────────────────────────────

  it('scans an empty project directory', () => {
    const { project } = createProjectWithDir('Empty Project');
    const result = assetScanner.scanProjectAssets(project.id);
    expect(result).toEqual({ added: 0, updated: 0, removed: 0, total: 0 });
  });

  it('discovers image files', () => {
    const { project, absPath } = createProjectWithDir('Image Project');
    fs.writeFileSync(path.join(absPath, 'render.png'), 'png content');
    fs.writeFileSync(path.join(absPath, 'preview.webp'), 'webp content');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(2);
    expect(result.total).toBe(2);

    const assets = assetScanner.repository.findByProjectId(project.id);
    const filenames = assets.map((a) => a.filename).sort();
    expect(filenames).toEqual(['preview.webp', 'render.png']);
  });

  it('discovers Krita files', () => {
    const { project, absPath } = createProjectWithDir('Krita Project');
    fs.writeFileSync(path.join(absPath, 'sketch.kra'), 'krita data');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(1);

    const assets = assetScanner.repository.findByProjectId(project.id);
    expect(assets[0].extension).toBe('kra');
    expect(assets[0].mime_type).toBe('application/x-krita');
  });

  it('handles unknown extensions', () => {
    const { project, absPath } = createProjectWithDir('Mixed Project');
    fs.writeFileSync(path.join(absPath, 'document.pdf'), 'pdf data');
    fs.writeFileSync(path.join(absPath, 'archive.zip'), 'zip data');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(2);

    const assets = assetScanner.repository.findByProjectId(project.id);
    for (const asset of assets) {
      expect(asset.mime_type).toBe('application/octet-stream');
    }
  });

  it('scans files in nested directories', () => {
    const { project, absPath } = createProjectWithDir('Nested Project');
    fs.mkdirSync(path.join(absPath, 'source'), { recursive: true });
    fs.mkdirSync(path.join(absPath, 'exports', 'web'), { recursive: true });
    fs.writeFileSync(path.join(absPath, 'source', 'character.kra'), 'kra');
    fs.writeFileSync(path.join(absPath, 'exports', 'web', 'final.webp'), 'webp');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(2);

    const assets = assetScanner.repository.findByProjectId(project.id);
    const paths = assets.map((a) => a.relative_path).sort();
    expect(paths).toEqual([
      'exports/web/final.webp',
      'source/character.kra',
    ]);
  });

  // ─── Ignored files ───────────────────────────────────────────────

  it('ignores project.json', () => {
    const { project, absPath } = createProjectWithDir('Manifest Test');
    fs.writeFileSync(path.join(absPath, 'project.json'), '{}');
    fs.writeFileSync(path.join(absPath, 'real-file.png'), 'png');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(1);
    expect(result.total).toBe(1);
    expect(
      assetScanner.repository.findByProjectIdAndPath(project.id, 'project.json')
    ).toBeUndefined();
  });

  it('ignores temp manifest files', () => {
    const { project, absPath } = createProjectWithDir('Temp Test');
    fs.writeFileSync(path.join(absPath, '.abc123.project.json.tmp'), 'tmp');
    fs.writeFileSync(path.join(absPath, 'real.png'), 'png');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(1);
  });

  it('ignores .DS_Store files', () => {
    const { project, absPath } = createProjectWithDir('DS Store');
    fs.writeFileSync(path.join(absPath, '.DS_Store'), '');
    fs.writeFileSync(path.join(absPath, 'file.png'), 'png');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(1);
  });

  it('ignores hidden files and directories', () => {
    const { project, absPath } = createProjectWithDir('Hidden');
    fs.writeFileSync(path.join(absPath, 'visible.png'), 'png');
    fs.mkdirSync(path.join(absPath, '.git'), { recursive: true });
    fs.writeFileSync(path.join(absPath, '.git', 'config'), 'config');
    fs.writeFileSync(path.join(absPath, '.hidden-file.txt'), 'hidden');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(1);
    expect(result.total).toBe(1);
  });

  // ─── Relative paths ──────────────────────────────────────────────

  it('stores only relative paths (no absolute paths)', () => {
    const { project, absPath } = createProjectWithDir('Rel Path');
    fs.writeFileSync(path.join(absPath, 'test.png'), 'png');

    assetScanner.scanProjectAssets(project.id);
    const assets = assetScanner.repository.findByProjectId(project.id);

    expect(assets).toHaveLength(1);
    expect(assets[0].relative_path).toBe('test.png');
    expect(assets[0].relative_path).not.toMatch(/^[A-Z]:\\/);
    expect(assets[0].relative_path).not.toMatch(/^\//);
  });

  it('normalizes path separators to forward slashes', () => {
    const { project, absPath } = createProjectWithDir('Sep Norm');
    fs.mkdirSync(path.join(absPath, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(absPath, 'sub', 'file.png'), 'png');

    assetScanner.scanProjectAssets(project.id);
    const assets = assetScanner.repository.findByProjectId(project.id);

    expect(assets[0].relative_path).toBe('sub/file.png');
    expect(assets[0].relative_path).not.toContain('\\');
  });

  // ─── Update detection ────────────────────────────────────────────

  it('detects changed files (size change)', () => {
    const { project, absPath } = createProjectWithDir('Change Detect');
    fs.writeFileSync(path.join(absPath, 'file.png'), 'original');

    assetScanner.scanProjectAssets(project.id);

    // Modify the file — different size
    fs.writeFileSync(path.join(absPath, 'file.png'), 'modified content longer');

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
    expect(result.total).toBe(1);
  });

  it('detects changed files (mtime change)', { timeout: 5000 }, () => {
    const { project, absPath } = createProjectWithDir('Mtime Change');
    fs.writeFileSync(path.join(absPath, 'file.png'), 'content');

    // First scan captures the initial mtime
    assetScanner.scanProjectAssets(project.id);

    // Wait at least 1 second so the new mtime is different
    // (SQLite stores ISO strings without fractional seconds on some platforms)
    const wait = Date.now() + 1100;
    while (Date.now() < wait) { /* spin */ }

    // Touch the file to update mtime
    const now = new Date();
    fs.utimesSync(path.join(absPath, 'file.png'), now, now);

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.updated).toBe(1);
  });

  it('does not report unchanged files as updated', () => {
    const { project, absPath } = createProjectWithDir('No Change');
    fs.writeFileSync(path.join(absPath, 'stable.png'), 'content');

    assetScanner.scanProjectAssets(project.id);
    const result = assetScanner.scanProjectAssets(project.id);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.total).toBe(1);
  });

  // ─── Deleted file cleanup ────────────────────────────────────────

  it('marks missing assets instead of deleting', () => {
    const { project, absPath } = createProjectWithDir('Cleanup Test');
    fs.writeFileSync(path.join(absPath, 'will-delete.png'), 'to delete');
    fs.writeFileSync(path.join(absPath, 'will-keep.png'), 'to keep');

    assetScanner.scanProjectAssets(project.id);
    expect(assetScanner.repository.countByProjectId(project.id)).toBe(2);

    // Delete one file on disk
    fs.unlinkSync(path.join(absPath, 'will-delete.png'));

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.removed).toBe(1);
    expect(result.total).toBe(2); // total includes missing assets

    // Asset should still exist but be marked as missing
    const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'will-delete.png');
    expect(asset).toBeTruthy();
    expect(asset.is_present).toBe(0);
    expect(asset.filename).toBe('will-delete.png'); // identity preserved
  });

  it('marks all assets as missing when directory is emptied', () => {
    const { project, absPath } = createProjectWithDir('Empty Cleanup');
    fs.writeFileSync(path.join(absPath, 'file1.png'), 'one');
    fs.writeFileSync(path.join(absPath, 'file2.png'), 'two');

    assetScanner.scanProjectAssets(project.id);
    expect(assetScanner.repository.countByProjectId(project.id)).toBe(2);

    // Remove all files
    fs.unlinkSync(path.join(absPath, 'file1.png'));
    fs.unlinkSync(path.join(absPath, 'file2.png'));

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.removed).toBe(2);
    expect(result.total).toBe(2); // all still tracked, now missing

    // Both assets should be marked missing
    const missing = assetScanner.repository.findMissingByProjectId(project.id);
    expect(missing).toHaveLength(2);
  });

  it('restores missing asset when file returns', () => {
    const { project, absPath } = createProjectWithDir('Restore Test');
    fs.writeFileSync(path.join(absPath, 'was-gone.png'), 'content');

    assetScanner.scanProjectAssets(project.id);
    const original = assetScanner.repository.findByProjectIdAndPath(project.id, 'was-gone.png');
    expect(original.is_present).toBe(1);

    // Remove file
    fs.unlinkSync(path.join(absPath, 'was-gone.png'));
    assetScanner.scanProjectAssets(project.id);

    const missing = assetScanner.repository.findMissingByProjectId(project.id)[0];
    expect(missing.is_present).toBe(0);
    expect(missing.id).toBe(original.id); // same ID

    // Restore file
    fs.writeFileSync(path.join(absPath, 'was-gone.png'), 'content');
    assetScanner.scanProjectAssets(project.id);

    const restored = assetScanner.repository.findByProjectIdAndPath(project.id, 'was-gone.png');
    expect(restored.is_present).toBe(1);
    expect(restored.id).toBe(original.id); // same ID restored
    expect(restored.last_seen_at).toBeTruthy();
  });

  // ─── Error handling ─────────────────────────────────────────────

  it('throws for missing project', () => {
    expect(() => assetScanner.scanProjectAssets(99999)).toThrow(ProjectNotFoundError);
  });

  it('throws for missing project directory', () => {
    const { project } = createProjectWithDir('Vanished');
    // Remove the directory
    const dirName = formatProjectDirName(project.id, project.slug);
    const relPath = buildProjectRelPath(project.status, dirName);
    const absPath = path.resolve(projectsRoot, relPath);
    fs.rmSync(absPath, { recursive: true, force: true });

    expect(() => assetScanner.scanProjectAssets(project.id)).toThrow(
      'Project directory not found on disk.'
    );
  });

  it('throws for project with no directory path', () => {
    const project = projectRepo.create({
      title: 'No Dir',
      slug: 'no-dir',
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
    });
    // No setProjectDir call — project_dir is null

    expect(() => assetScanner.scanProjectAssets(project.id)).toThrow(
      'Project has no stored directory path.'
    );
  });

  // ─── Symlink rejection ──────────────────────────────────────────

  it('rejects a symlink project directory', () => {
    const { project, absPath } = createProjectWithDir('Real Proj');

    // Replace the real directory with a symlink
    const realDir = path.join(tmpDir, 'real-files');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'file.png'), 'png');

    fs.rmSync(absPath, { recursive: true, force: true });

    // Create junction (symlink on Windows, works with fs.lstatSync.isSymbolicLink)
    try {
      fs.symlinkSync(realDir, absPath, 'junction');
    } catch {
      // Skip if symlinks are not supported
      return;
    }

    // resolveProjectDir throws StorageError which the scanner catches and
    // re-throws as a generic "cannot be accessed" error (safe, no path leak)
    expect(() => assetScanner.scanProjectAssets(project.id)).toThrow(
      'Project directory cannot be accessed.'
    );
  });

  it('skips individual symlink files inside project directory', () => {
    const { project, absPath } = createProjectWithDir('Symlink File');
    fs.writeFileSync(path.join(absPath, 'real.png'), 'real');

    const outsideFile = path.join(tmpDir, 'outside.png');
    fs.writeFileSync(outsideFile, 'outside');

    try {
      fs.symlinkSync(outsideFile, path.join(absPath, 'link.png'));
    } catch {
      // Symlinks may not be supported; just verify real file is found
    }

    const result = assetScanner.scanProjectAssets(project.id);
    // We can't assert the exact count because symlink creation is platform-dependent
    // But we should never crash
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('does not recurse into symlinked directories', () => {
    const { project, absPath } = createProjectWithDir('Symlink Dir Traversal');

    // Create an external directory outside the project
    const externalDir = path.join(tmpDir, 'external-target');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'secret.png'), 'should not be indexed');

    // Create a symlink directory inside the project pointing to external
    const linkPath = path.join(absPath, 'linked-subdir');
    try {
      fs.symlinkSync(externalDir, linkPath, 'junction');
    } catch {
      // Symlinks may not be supported on this platform
      return;
    }

    // Add a real file in the project (not via symlink)
    fs.writeFileSync(path.join(absPath, 'real.png'), 'real');

    const result = assetScanner.scanProjectAssets(project.id);

    // The real file should be indexed
    expect(result.total).toBeGreaterThanOrEqual(1);
    const assets = assetScanner.repository.findByProjectId(project.id);
    const paths = assets.map((a) => a.relative_path);

    // The external file must NOT appear in the indexed assets
    expect(paths).not.toContain('linked-subdir/secret.png');
    expect(paths).not.toContain('secret.png');
  });

  // ─── Full scan summary ──────────────────────────────────────────

  it('returns accurate scan summary with mixed operations', () => {
    const { project, absPath } = createProjectWithDir('Full Summary');

    // First scan: 2 files added
    fs.writeFileSync(path.join(absPath, 'initial.png'), 'initial');
    fs.writeFileSync(path.join(absPath, 'also.png'), 'also');

    let result = assetScanner.scanProjectAssets(project.id);
    expect(result).toEqual({ added: 2, updated: 0, removed: 0, total: 2 });

    // Modify one, add one, delete one
    fs.writeFileSync(path.join(absPath, 'initial.png'), 'modified content');
    fs.writeFileSync(path.join(absPath, 'new.png'), 'new');
    fs.unlinkSync(path.join(absPath, 'also.png'));

    result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.total).toBe(3); // total includes the missing asset
  });

  // ─── Identity preservation ──────────────────────────────────────

  it('preserves asset ID when file is deleted and restored', () => {
    const { project, absPath } = createProjectWithDir('Identity Test');
    fs.writeFileSync(path.join(absPath, 'file.png'), 'content');

    assetScanner.scanProjectAssets(project.id);
    const original = assetScanner.repository.findByProjectIdAndPath(project.id, 'file.png');
    const originalId = original.id;

    // Delete and re-add
    fs.unlinkSync(path.join(absPath, 'file.png'));
    assetScanner.scanProjectAssets(project.id);

    const missing = assetScanner.repository.findByProjectIdAndPath(project.id, 'file.png');
    expect(missing.id).toBe(originalId);
    expect(missing.is_present).toBe(0);

    fs.writeFileSync(path.join(absPath, 'file.png'), 'content');
    assetScanner.scanProjectAssets(project.id);

    const restored = assetScanner.repository.findByProjectIdAndPath(project.id, 'file.png');
    expect(restored.id).toBe(originalId);
    expect(restored.is_present).toBe(1);
  });

  // ─── Traversal error handling ───────────────────────────────────────────

  it('scan throws on permission error and does not mutate asset presence', () => {
    const { project, absPath } = createProjectWithDir('Perm Error Test');
    fs.writeFileSync(path.join(absPath, 'good.txt'), 'content');
    fs.writeFileSync(path.join(absPath, 'bad.txt'), 'content');

    // First scan — index the files
    assetScanner.scanProjectAssets(project.id);
    expect(assetScanner.repository.countByProjectId(project.id)).toBe(2);

    // Lock the directory to simulate permission error
    let canChmod = true;
    try {
      fs.chmodSync(absPath, 0o000);
    } catch {
      canChmod = false;
    }

    if (!canChmod) {
      // chmod may fail on Windows or as admin — skip this platform
      return;
    }

    // Verify chmod actually worked by trying to read the directory
    let readDenied = false;
    try {
      fs.readdirSync(absPath, { withFileTypes: true });
    } catch {
      readDenied = true;
    }

    if (!readDenied) {
      // chmod didn't actually restrict access on this platform
      try { fs.chmodSync(absPath, 0o755); } catch { /* ignore */ }
      return;
    }

    try {
      expect(() => assetScanner.scanProjectAssets(project.id)).toThrow();
    } finally {
      // Restore permissions so cleanup can proceed
      try { fs.chmodSync(absPath, 0o755); } catch { /* ignore */ }
    }

    // Asset presence must NOT have changed after failed scan
    const all = assetScanner.repository.findByProjectId(project.id);
    expect(all.every((a) => a.is_present === 1)).toBe(true);
  });

  it('scan throws on I/O error during file traversal', () => {
    const { project, absPath } = createProjectWithDir('IO Error Test');
    const subDir = path.join(absPath, 'subdir');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'file.txt'), 'content');

    // First scan
    assetScanner.scanProjectAssets(project.id);
    expect(assetScanner.repository.countByProjectId(project.id)).toBe(1);

    // Make the subdirectory unreadable
    let canChmod = true;
    try {
      fs.chmodSync(subDir, 0o000);
    } catch {
      canChmod = false;
    }

    if (!canChmod) {
      return;
    }

    // Verify chmod actually worked
    let readDenied = false;
    try {
      fs.readdirSync(subDir, { withFileTypes: true });
    } catch {
      readDenied = true;
    }

    if (!readDenied) {
      try { fs.chmodSync(subDir, 0o755); } catch { /* ignore */ }
      return;
    }

    let threw = false;
    try {
      assetScanner.scanProjectAssets(project.id);
    } catch {
      threw = true;
    }

    try { fs.chmodSync(subDir, 0o755); } catch { /* ignore */ }

    expect(threw).toBe(true);
  });

  it('disappeared subdirectory causes files to be marked as missing', () => {
    const { project, absPath } = createProjectWithDir('ENOENT Test');
    const subDir = path.join(absPath, 'subdir');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'file.txt'), 'content');

    // First scan
    assetScanner.scanProjectAssets(project.id);
    const countAfterFirst = assetScanner.repository.countByProjectId(project.id);
    expect(countAfterFirst).toBe(1);

    // Remove the subdirectory
    fs.rmSync(subDir, { recursive: true });

    // Second scan — file in disappeared subdirectory should be marked missing
    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(1); // file is now missing

    // Verify the asset is still present in DB but marked missing
    const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'subdir/file.txt');
    expect(asset).toBeTruthy();
    expect(asset.is_present).toBe(0);
  });

  // ─── Phase 5 release-readiness: failed traversal must not mutate state ─────
  //
  // The scanner is responsible for reconciling the on-disk filesystem with
  // the asset index. If traversal fails partway through (e.g. a permission
  // error or other I/O failure), the scanner must NOT call any of its
  // repository mutation methods. Otherwise a transient I/O error would
  // silently mark all previously-indexed assets as missing.

  it('failed scanner traversal does not call any repository mutation methods', () => {
    const { project, absPath } = createProjectWithDir('Fail Traverse Test');
    fs.writeFileSync(path.join(absPath, 'good.png'), 'png content');
    fs.writeFileSync(path.join(absPath, 'other.txt'), 'text content');

    // Initial scan indexes the files. All present.
    assetScanner.scanProjectAssets(project.id);
    const before = assetScanner.repository.findByProjectId(project.id);
    expect(before.length).toBe(2);
    expect(before.every((a) => a.is_present === 1)).toBe(true);
    const beforeIds = before.map((a) => a.id).sort();

    // Spy on every mutation method exposed by the repository. If walkDirectory
    // throws, NONE of these may be called.
    const restoreSpy = vi.spyOn(assetScanner.repository, 'restorePresent');
    const markMissingSpy = vi.spyOn(assetScanner.repository, 'markMissingByProjectIdAndPathNotIn');
    const markAllMissingSpy = vi.spyOn(assetScanner.repository, 'markAllMissing');
    const upsertSpy = vi.spyOn(assetScanner.repository, 'upsert');

    // Force a traversal-time failure by making every readdirSync throw EACCES.
    // walkDirectory treats this as "abort reconciliation, do not mutate".
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('Simulated EACCES'), { code: 'EACCES' });
    });

    try {
      expect(() => assetScanner.scanProjectAssets(project.id)).toThrow();
    } finally {
      readdirSpy.mockRestore();
      restoreSpy.mockRestore();
      markMissingSpy.mockRestore();
      markAllMissingSpy.mockRestore();
      upsertSpy.mockRestore();
    }

    // No mutation methods were invoked.
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(markMissingSpy).not.toHaveBeenCalled();
    expect(markAllMissingSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();

    // The asset state must be unchanged: same rows, same is_present, same
    // identity (no new assets, no removed assets).
    const after = assetScanner.repository.findByProjectId(project.id);
    expect(after.length).toBe(2);
    expect(after.every((a) => a.is_present === 1)).toBe(true);
    const afterIds = after.map((a) => a.id).sort();
    expect(afterIds).toEqual(beforeIds);
  });

  it('a missing project directory aborts the scan without mutating any existing asset state', () => {
    // The "project directory disappeared between requests" case is a real
    // operational failure (e.g. external cleanup, volume unmount). The
    // scanner must not silently mark every asset as missing.
    const { project, absPath } = createProjectWithDir('Vanished Dir Test');
    fs.writeFileSync(path.join(absPath, 'keep.png'), 'png content');
    assetScanner.scanProjectAssets(project.id);

    const before = assetScanner.repository.findByProjectId(project.id);
    expect(before.length).toBe(1);
    expect(before[0].is_present).toBe(1);

    // Remove the entire project directory
    fs.rmSync(absPath, { recursive: true, force: true });

    // Spy on mutation methods to prove they are not invoked.
    const restoreSpy = vi.spyOn(assetScanner.repository, 'restorePresent');
    const markMissingSpy = vi.spyOn(assetScanner.repository, 'markMissingByProjectIdAndPathNotIn');
    const markAllMissingSpy = vi.spyOn(assetScanner.repository, 'markAllMissing');

    try {
      expect(() => assetScanner.scanProjectAssets(project.id)).toThrow();
    } finally {
      restoreSpy.mockRestore();
      markMissingSpy.mockRestore();
      markAllMissingSpy.mockRestore();
    }

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(markMissingSpy).not.toHaveBeenCalled();
    expect(markAllMissingSpy).not.toHaveBeenCalled();

    // Existing asset must remain unchanged.
    const after = assetScanner.repository.findByProjectId(project.id);
    expect(after.length).toBe(1);
    expect(after[0].is_present).toBe(1);
  });

  // ─── Phase 2 chunk 1: category classification ────────────────────

  describe('category classification', () => {
    function addCategory(projectId, displayName, directorySlug, { enabled = true } = {}) {
      return db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug, enabled)
        VALUES (?, ?, ?, ?)
        RETURNING id, project_id, display_name, directory_slug, enabled
      `).get(projectId, displayName, directorySlug, enabled ? 1 : 0);
    }

    it('leaves a project-root file uncategorized', () => {
      const { project, absPath } = createProjectWithDir('Root File');
      fs.writeFileSync(path.join(absPath, 'cover.png'), 'png');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'cover.png');
      expect(asset.category_id).toBeNull();
      expect(asset.nested_path).toBe('');
    });

    it('classifies a file under an exact category slug match', () => {
      const { project, absPath } = createProjectWithDir('Exact Match');
      const source = addCategory(project.id, 'Source', 'source');
      fs.mkdirSync(path.join(absPath, 'source'));
      fs.writeFileSync(path.join(absPath, 'source', 'file.kra'), 'kra');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'source/file.kra');
      expect(asset.category_id).toBe(source.id);
      expect(asset.nested_path).toBe('');
    });

    it('classifies a nested file under its category root and keeps the remaining path as nested_path', () => {
      const { project, absPath } = createProjectWithDir('Nested Category');
      const exports = addCategory(project.id, 'Exports', 'exports');
      fs.mkdirSync(path.join(absPath, 'exports', 'web'), { recursive: true });
      fs.writeFileSync(path.join(absPath, 'exports', 'web', 'final.png'), 'png');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'exports/web/final.png');
      expect(asset.category_id).toBe(exports.id);
      expect(asset.nested_path).toBe('web');
    });

    it('still recognizes a disabled category for classification', () => {
      const { project, absPath } = createProjectWithDir('Disabled Category');
      const extras = addCategory(project.id, 'Extras', 'extras', { enabled: false });
      fs.mkdirSync(path.join(absPath, 'extras'));
      fs.writeFileSync(path.join(absPath, 'extras', 'bonus.png'), 'png');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'extras/bonus.png');
      expect(asset.category_id).toBe(extras.id);
      expect(asset.nested_path).toBe('');
    });

    it('leaves an unknown top-level directory uncategorized and preserves it as nested_path', () => {
      const { project, absPath } = createProjectWithDir('Unknown Top');
      addCategory(project.id, 'Source', 'source');
      fs.mkdirSync(path.join(absPath, 'unknown'));
      fs.writeFileSync(path.join(absPath, 'unknown', 'file.txt'), 'txt');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'unknown/file.txt');
      expect(asset.category_id).toBeNull();
      expect(asset.nested_path).toBe('unknown');
    });

    it('preserves the complete unknown directory portion for a deep unknown path', () => {
      const { project, absPath } = createProjectWithDir('Deep Unknown');
      fs.mkdirSync(path.join(absPath, 'unknown', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(absPath, 'unknown', 'deep', 'file.txt'), 'txt');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'unknown/deep/file.txt');
      expect(asset.category_id).toBeNull();
      expect(asset.nested_path).toBe('unknown/deep');
    });

    it('accepts a unique case-insensitive category slug match', () => {
      const { project, absPath } = createProjectWithDir('Case Insensitive');
      const source = addCategory(project.id, 'Source', 'source');
      fs.mkdirSync(path.join(absPath, 'SOURCE'));
      fs.writeFileSync(path.join(absPath, 'SOURCE', 'file.kra'), 'kra');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'SOURCE/file.kra');
      expect(asset.category_id).toBe(source.id);
      expect(asset.nested_path).toBe('');
    });

    it('normalizes discovered relative paths to forward slashes before classifying', () => {
      const { project, absPath } = createProjectWithDir('Slash Normalization');
      const exports = addCategory(project.id, 'Exports', 'exports');
      fs.mkdirSync(path.join(absPath, 'exports', 'web'), { recursive: true });
      fs.writeFileSync(path.join(absPath, 'exports', 'web', 'final.png'), 'png');

      assetScanner.scanProjectAssets(project.id);

      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'exports/web/final.png');
      expect(asset.relative_path).not.toContain('\\');
      expect(asset.category_id).toBe(exports.id);
      expect(asset.nested_path).toBe('web');
    });

    it('treats an external rename/move as a missing old row plus a new asset row', () => {
      const { project, absPath } = createProjectWithDir('External Move');
      fs.writeFileSync(path.join(absPath, 'old-name.png'), 'content');
      assetScanner.scanProjectAssets(project.id);
      const original = assetScanner.repository.findByProjectIdAndPath(project.id, 'old-name.png');

      // Simulate an external (e.g. SMB) rename: old path gone, new path present.
      fs.renameSync(path.join(absPath, 'old-name.png'), path.join(absPath, 'new-name.png'));

      const result = assetScanner.scanProjectAssets(project.id);
      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);

      const oldRow = assetScanner.repository.findByProjectIdAndPath(project.id, 'old-name.png');
      expect(oldRow.is_present).toBe(0);
      expect(oldRow.id).toBe(original.id);

      const newRow = assetScanner.repository.findByProjectIdAndPath(project.id, 'new-name.png');
      expect(newRow.is_present).toBe(1);
      expect(newRow.id).not.toBe(original.id);
    });

    it('retains a selected row through missing and same-path restoration while the query model reactivates it', () => {
      const { project, absPath } = createProjectWithDir('Primary Restore Lifecycle');
      const assetPath = path.join(absPath, 'cover.png');
      fs.writeFileSync(assetPath, 'content');
      assetScanner.scanProjectAssets(project.id);
      const asset = assetScanner.repository.findByProjectIdAndPath(project.id, 'cover.png');
      primaryImageService.setPrimaryImage(project.id, asset.id);

      expect(getPrimaryImageModel(project.id)).toMatchObject({
        selectedAssetId: asset.id,
        state: 'available',
      });

      fs.rmSync(assetPath);
      assetScanner.scanProjectAssets(project.id);

      expect(assetScanner.repository.findById(asset.id)).toMatchObject({
        id: asset.id,
        is_present: 0,
      });
      expect(primaryImageRepository.findByProjectId(project.id)).toEqual({
        project_id: project.id,
        asset_id: asset.id,
      });
      expect(getPrimaryImageModel(project.id)).toEqual({
        selectedAssetId: asset.id,
        state: 'unavailable',
        previewUrl: null,
        thumbnailUrl: null,
        revision: null,
        alt: 'Preview of cover.png',
      });

      fs.writeFileSync(assetPath, 'restored content');
      assetScanner.scanProjectAssets(project.id);

      const restored = assetScanner.repository.findByProjectIdAndPath(project.id, 'cover.png');
      expect(restored.id).toBe(asset.id);
      expect(restored.is_present).toBe(1);
      expect(getPrimaryImageModel(project.id)).toMatchObject({
        selectedAssetId: asset.id,
        state: 'available',
      });
      expect(getPrimaryImageModel(project.id).previewUrl).toContain(
        `/projects/${project.id}/assets/${asset.id}/preview?v=`
      );
    });

    it('keeps an external rename selected on the old unavailable row without transferring primary state', () => {
      const { project, absPath } = createProjectWithDir('Primary External Move Lifecycle');
      const oldPath = path.join(absPath, 'old-name.png');
      fs.writeFileSync(oldPath, 'content');
      assetScanner.scanProjectAssets(project.id);
      const original = assetScanner.repository.findByProjectIdAndPath(project.id, 'old-name.png');
      primaryImageService.setPrimaryImage(project.id, original.id);

      fs.renameSync(oldPath, path.join(absPath, 'new-name.png'));
      assetScanner.scanProjectAssets(project.id);

      const oldRow = assetScanner.repository.findByProjectIdAndPath(project.id, 'old-name.png');
      const newRow = assetScanner.repository.findByProjectIdAndPath(project.id, 'new-name.png');
      expect(oldRow).toMatchObject({ id: original.id, is_present: 0 });
      expect(newRow).toMatchObject({ is_present: 1 });
      expect(newRow.id).not.toBe(original.id);
      expect(primaryImageRepository.findByProjectId(project.id)).toEqual({
        project_id: project.id,
        asset_id: original.id,
      });
      expect(getPrimaryImageModel(project.id)).toMatchObject({
        selectedAssetId: original.id,
        state: 'unavailable',
        previewUrl: null,
        thumbnailUrl: null,
      });
    });

    it('does not write project.json while scanning', () => {
      const { project, absPath } = createProjectWithDir('No Manifest Write');
      fs.writeFileSync(path.join(absPath, 'file.png'), 'png');
      const manifestPath = path.join(absPath, 'project.json');
      expect(fs.existsSync(manifestPath)).toBe(false);

      assetScanner.scanProjectAssets(project.id);

      expect(fs.existsSync(manifestPath)).toBe(false);
    });
  });

  // ─── Coordinator integration (Phase: asset actions chunk 3) ────────────

  describe('coordinator integration', () => {
    it('requires a projectOperationCoordinator dependency', () => {
      expect(() => createAssetScanner(db, projectsRoot, { projectService })).toThrow();
    });

    it('rejects same-project scan re-entry while the coordinator holds the lock', () => {
      const { project, absPath } = createProjectWithDir('Reentrant Scan');
      fs.writeFileSync(path.join(absPath, 'a.png'), 'png');

      projectOperationCoordinator.run(project.id, () => {
        expect(() => assetScanner.scanProjectAssets(project.id)).toThrow(ProjectOperationError);
        try {
          assetScanner.scanProjectAssets(project.id);
        } catch (err) {
          expect(err.code).toBe('PROJECT_OPERATION_IN_PROGRESS');
        }
      });
    });

    it('rejects a same-project scan while an action (or any other operation) holds the coordinator', () => {
      const { project, absPath } = createProjectWithDir('Action Holds Lock');
      fs.writeFileSync(path.join(absPath, 'a.png'), 'png');

      // Simulates an asset-action-service call holding the lock — the
      // coordinator itself doesn't know or care which caller holds it.
      projectOperationCoordinator.run(project.id, () => {
        expect(() => assetScanner.scanProjectAssets(project.id)).toThrow(ProjectOperationError);
      });
    });

    it('rejects a same-project action while a scan holds the coordinator', () => {
      const { project, absPath } = createProjectWithDir('Scan Holds Lock');
      fs.writeFileSync(path.join(absPath, 'a.png'), 'png');

      // Spy on the reconciliation step (the last thing scanProjectAssets
      // does) to simulate a rename/move attempted while the scan is still
      // inside its protected region.
      let nestedAttemptError;
      const spy = vi.spyOn(assetScanner.repository, 'reconcileScannedAssets');
      const original = assetScanner.repository.reconcileScannedAssets.bind(assetScanner.repository);
      spy.mockImplementationOnce((...args) => {
        try {
          projectOperationCoordinator.run(project.id, () => {});
        } catch (err) {
          nestedAttemptError = err;
        }
        return original(...args);
      });

      assetScanner.scanProjectAssets(project.id);

      expect(nestedAttemptError).toBeInstanceOf(ProjectOperationError);
      expect(nestedAttemptError.code).toBe('PROJECT_OPERATION_IN_PROGRESS');
      spy.mockRestore();
    });

    it('permits different-project scans to run independently', () => {
      const a = createProjectWithDir('Project A');
      const b = createProjectWithDir('Project B');
      fs.writeFileSync(path.join(b.absPath, 'a.png'), 'png');

      let innerResult;
      projectOperationCoordinator.run(a.project.id, () => {
        innerResult = assetScanner.scanProjectAssets(b.project.id);
      });

      expect(innerResult.added).toBe(1);
    });

    it('holds the lock through traversal and the reconciliation transaction, not just one phase', () => {
      const { project, absPath } = createProjectWithDir('Full Region');
      fs.writeFileSync(path.join(absPath, 'a.png'), 'png');

      let lockActiveDuringReconcile = null;
      const spy = vi.spyOn(assetScanner.repository, 'reconcileScannedAssets');
      const original = assetScanner.repository.reconcileScannedAssets.bind(assetScanner.repository);
      spy.mockImplementationOnce((...args) => {
        lockActiveDuringReconcile = projectOperationCoordinator.isActive(project.id);
        return original(...args);
      });

      assetScanner.scanProjectAssets(project.id);

      expect(lockActiveDuringReconcile).toBe(true);
      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
      spy.mockRestore();
    });

    it('releases the lock after a traversal failure', () => {
      const { project, absPath } = createProjectWithDir('Traversal Failure');
      fs.writeFileSync(path.join(absPath, 'a.png'), 'png');

      const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
        const err = new Error('simulated permission failure');
        err.code = 'EACCES';
        throw err;
      });
      try {
        expect(() => assetScanner.scanProjectAssets(project.id)).toThrow();
      } finally {
        readdirSpy.mockRestore();
      }

      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
      // The lock is usable again immediately afterward.
      const result = assetScanner.scanProjectAssets(project.id);
      expect(result.added).toBe(1);
    });

    it('releases the lock after a reconciliation failure', () => {
      const { project, absPath } = createProjectWithDir('Reconcile Failure');
      fs.writeFileSync(path.join(absPath, 'a.png'), 'png');

      const spy = vi.spyOn(assetScanner.repository, 'reconcileScannedAssets').mockImplementationOnce(() => {
        throw new Error('simulated reconciliation failure');
      });
      try {
        expect(() => assetScanner.scanProjectAssets(project.id)).toThrow('simulated reconciliation failure');
      } finally {
        spy.mockRestore();
      }

      expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
    });
  });
});
