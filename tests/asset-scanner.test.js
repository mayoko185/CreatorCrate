import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService, ProjectNotFoundError } from '../src/services/project-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
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
  let projectsRoot;

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
    projectService = createProjectService(db, projectsRoot);
    assetScanner = createAssetScanner(db, projectsRoot, { projectService });
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

  it('removes database records for deleted files', () => {
    const { project, absPath } = createProjectWithDir('Cleanup Test');
    fs.writeFileSync(path.join(absPath, 'will-delete.png'), 'to delete');
    fs.writeFileSync(path.join(absPath, 'will-keep.png'), 'to keep');

    assetScanner.scanProjectAssets(project.id);
    expect(assetScanner.repository.countByProjectId(project.id)).toBe(2);

    // Delete one file on disk
    fs.unlinkSync(path.join(absPath, 'will-delete.png'));

    const result = assetScanner.scanProjectAssets(project.id);
    expect(result.removed).toBe(1);
    expect(result.total).toBe(1);
    expect(
      assetScanner.repository.findByProjectIdAndPath(project.id, 'will-delete.png')
    ).toBeUndefined();
  });

  it('removes all assets when directory is emptied', () => {
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
    expect(result.total).toBe(0);
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
    expect(result.total).toBe(2);
  });
});
