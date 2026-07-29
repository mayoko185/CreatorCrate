import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openAssetFile,
  closeAssetFile,
} from '../../src/storage/asset-file.js';
import { StorageError } from '../../src/storage/path-manager.js';
import {
  formatProjectDirName,
  buildProjectRelPath,
} from '../../src/storage/project-storage.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

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

function makeProjectsRoot(tmpDir) {
  const projectsRoot = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  // Create the canonical directory names that status values map to.
  for (const dir of ['tbd', 'planned', 'active', 'ready', 'published', 'archived']) {
    fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
  }
  return projectsRoot;
}

function makeProjectDir(projectsRoot, status, id, slug) {
  const dirName = formatProjectDirName(id, slug);
  const relPath = buildProjectRelPath(status, dirName);
  const absPath = path.join(projectsRoot, relPath);
  fs.mkdirSync(absPath, { recursive: true });
  fs.mkdirSync(path.join(absPath, 'source'), { recursive: true });
  fs.mkdirSync(path.join(absPath, 'exports', 'full'), { recursive: true });
  return { dirName, relPath, absPath };
}

function writeFile(projectAbs, relPath, content = 'asset-content') {
  const target = path.join(projectAbs, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

// ─── openAssetFile ───────────────────────────────────────────────────────

describe('openAssetFile', () => {
  let tmpDir;
  let projectsRoot;
  let project;
  const HAS_SYMLINKS = symlinksSupported();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-asset-file-'));
    projectsRoot = makeProjectsRoot(tmpDir);
    project = makeProjectDir(projectsRoot, 'in-progress', 42, 'my-project');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Valid paths ──────────────────────────────────────────────────────

  it('opens a valid nested asset file', () => {
    writeFile(project.absPath, path.join('source', 'art.png'), 'png-bytes');
    const opened = openAssetFile(
      projectsRoot,
      project.relPath,
      path.join('source', 'art.png')
    );
    expect(opened.handle).toBeDefined();
    expect(typeof opened.handle).toBe('number');
    expect(opened.absolutePath).toBe(
      path.join(project.absPath, 'source', 'art.png')
    );
    expect(opened.stat.isFile()).toBe(true);
    closeAssetFile(opened);
  });

  it('opens a top-level asset file', () => {
    writeFile(project.absPath, 'cover.png', 'cover');
    const opened = openAssetFile(projectsRoot, project.relPath, 'cover.png');
    expect(opened.stat.isFile()).toBe(true);
    expect(opened.stat.size).toBe('cover'.length);
    closeAssetFile(opened);
  });

  it('opens an asset in the archived status directory', () => {
    const archived = makeProjectDir(projectsRoot, 'archived', 7, 'old-project');
    writeFile(archived.absPath, 'final.png', 'final');
    const opened = openAssetFile(projectsRoot, archived.relPath, 'final.png');
    expect(opened.stat.isFile()).toBe(true);
    closeAssetFile(opened);
  });

  it('normalizes a path with redundant separators and dots', () => {
    writeFile(project.absPath, path.join('source', 'art.png'), 'x');
    const opened = openAssetFile(
      projectsRoot,
      project.relPath,
      path.join('source', '.', 'art.png')
    );
    expect(opened.stat.isFile()).toBe(true);
    closeAssetFile(opened);
  });

  it('returns a stat that matches the file on disk', () => {
    writeFile(project.absPath, 'a.bin', '12345');
    const opened = openAssetFile(projectsRoot, project.relPath, 'a.bin');
    const onDisk = fs.statSync(path.join(project.absPath, 'a.bin'));
    expect(opened.stat.size).toBe(onDisk.size);
    expect(opened.stat.mtime.toISOString()).toBe(onDisk.mtime.toISOString());
    closeAssetFile(opened);
  });

  // ── Absolute / empty / invalid ────────────────────────────────────────

  it('rejects an absolute asset path', () => {
    writeFile(project.absPath, 'x.png', 'x');
    const abs = path.join(project.absPath, 'x.png');
    expect(() => openAssetFile(projectsRoot, project.relPath, abs)).toThrow(StorageError);
  });

  it('rejects an empty asset path', () => {
    expect(() => openAssetFile(projectsRoot, project.relPath, '')).toThrow(StorageError);
  });

  it('rejects a non-string asset path', () => {
    expect(() => openAssetFile(projectsRoot, project.relPath, null)).toThrow(StorageError);
    expect(() => openAssetFile(projectsRoot, project.relPath, undefined)).toThrow(StorageError);
  });

  // ── Traversal ────────────────────────────────────────────────────────

  it('rejects ../ traversal', () => {
    expect(() => openAssetFile(projectsRoot, project.relPath, '../outside.txt')).toThrow(StorageError);
  });

  it('rejects normalized traversal that escapes the project dir', () => {
    // "source/../../outside" normalizes to "../outside"
    expect(() =>
      openAssetFile(projectsRoot, project.relPath, path.join('source', '..', '..', 'outside.txt'))
    ).toThrow(StorageError);
  });

  it('rejects a path that resolves to the project directory itself', () => {
    expect(() => openAssetFile(projectsRoot, project.relPath, '.')).toThrow(StorageError);
  });

  it.runIf(process.platform === 'win32')(
    'rejects mixed-separator traversal on Windows',
    () => {
      writeFile(project.absPath, 'inside.png', 'x');
      // Backslash + forward slash mix that would escape on naive split
      const mixed = 'source\\..\\..\\..\\..\\outside.png';
      expect(() => openAssetFile(projectsRoot, project.relPath, mixed)).toThrow(StorageError);
    }
  );

  it('rejects a path outside the project directory but inside PROJECTS_ROOT', () => {
    // A sibling project's file must not be reachable through this project.
    const sibling = makeProjectDir(projectsRoot, 'in-progress', 43, 'other-project');
    writeFile(sibling.absPath, 'secret.png', 'secret');
    const rel = path.relative(project.absPath, path.join(sibling.absPath, 'secret.png'));
    expect(rel.startsWith('..')).toBe(true);
    expect(() => openAssetFile(projectsRoot, project.relPath, rel)).toThrow(StorageError);
  });

  // ── Symlink rejection ─────────────────────────────────────────────────

  it.skipIf(!HAS_SYMLINKS)(
    'rejects a symlinked intermediate directory',
    () => {
      // Create a real dir outside the project and symlink a subdir to it
      const outside = path.join(tmpDir, 'outside-real');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'evil.png'), 'evil');

      const linkDir = path.join(project.absPath, 'linked');
      fs.symlinkSync(outside, linkDir, 'junction');

      expect(() =>
        openAssetFile(projectsRoot, project.relPath, path.join('linked', 'evil.png'))
      ).toThrow(StorageError);
    }
  );

  it.skipIf(!HAS_SYMLINKS)(
    'rejects a symlinked final file',
    () => {
      const outsideFile = path.join(tmpDir, 'outside-file.png');
      fs.writeFileSync(outsideFile, 'evil');

      const linkFile = path.join(project.absPath, 'link.png');
      fs.symlinkSync(outsideFile, linkFile, 'file');

      expect(() =>
        openAssetFile(projectsRoot, project.relPath, 'link.png')
      ).toThrow(StorageError);
    }
  );

  // ── Directory-as-file ────────────────────────────────────────────────

  it('rejects a directory passed where a file is required', () => {
    // source/ is a directory created by makeProjectDir
    expect(() =>
      openAssetFile(projectsRoot, project.relPath, 'source')
    ).toThrow(StorageError);
  });

  // ── Missing file ─────────────────────────────────────────────────────

  it('rejects a missing file', () => {
    expect(() =>
      openAssetFile(projectsRoot, project.relPath, 'does-not-exist.png')
    ).toThrow(StorageError);
  });

  // ── Read-only / regular descriptor ───────────────────────────────────

  it('opened descriptor is read-only (write to a copy fails)', () => {
    writeFile(project.absPath, 'ro.png', 'ro');
    const opened = openAssetFile(projectsRoot, project.relPath, 'ro.png');

    // Attempting to write through the read-only fd must fail. Node surfaces
    // this as EBADF or EPERM depending on platform — assert it throws.
    expect(() => fs.writeSync(opened.handle, Buffer.from('x'))).toThrow();
    closeAssetFile(opened);
  });

  it('opened descriptor points to a regular file', () => {
    writeFile(project.absPath, 'regular.bin', 'abc');
    const opened = openAssetFile(projectsRoot, project.relPath, 'regular.bin');
    expect(opened.stat.isFile()).toBe(true);
    expect(opened.stat.isDirectory()).toBe(false);
    expect(opened.stat.isSymbolicLink()).toBe(false);
    closeAssetFile(opened);
  });

  // ── Source integrity ─────────────────────────────────────────────────

  it('does not modify the source file', () => {
    const content = 'original-bytes';
    writeFile(project.absPath, 'keep.png', content);
    const opened = openAssetFile(projectsRoot, project.relPath, 'keep.png');
    closeAssetFile(opened);

    const after = fs.readFileSync(path.join(project.absPath, 'keep.png'), 'utf8');
    expect(after).toBe(content);
  });

  it('closeAssetFile is a no-op for null/undefined', () => {
    expect(() => closeAssetFile(null)).not.toThrow();
    expect(() => closeAssetFile(undefined)).not.toThrow();
    expect(() => closeAssetFile({})).not.toThrow();
  });

  it('closeAssetFile closes an opened handle and allows reuse', () => {
    writeFile(project.absPath, 'once.png', 'x');
    const opened = openAssetFile(projectsRoot, project.relPath, 'once.png');
    closeAssetFile(opened);
    // Closing again is a safe no-op
    expect(() => closeAssetFile(opened)).not.toThrow();
  });
});