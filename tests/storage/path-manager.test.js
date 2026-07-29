import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureCanonicalDirs,
  ensureStatusDirs,
  ensurePreviewRoot,
  getProjectDir,
  getStatusDir,
  CANONICAL_DIRS,
  STATUS_DIR_MAP,
  StorageError,
} from '../../src/storage/path-manager.js';

describe('ensureCanonicalDirs / ensureStatusDirs', () => {
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-storage-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all canonical directories', () => {
    ensureCanonicalDirs(projectsRoot);
    for (const dirName of CANONICAL_DIRS) {
      const dirPath = path.join(projectsRoot, dirName);
      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    }
  });

  it('is idempotent', () => {
    ensureCanonicalDirs(projectsRoot);
    ensureCanonicalDirs(projectsRoot);
    for (const dirName of CANONICAL_DIRS) {
      expect(fs.statSync(path.join(projectsRoot, dirName)).isDirectory()).toBe(true);
    }
  });

  it('accepts existing valid directories', () => {
    fs.mkdirSync(path.join(projectsRoot, 'tbd'), { recursive: true });
    fs.mkdirSync(path.join(projectsRoot, 'planned'), { recursive: true });
    ensureCanonicalDirs(projectsRoot);
    for (const dirName of CANONICAL_DIRS) {
      expect(fs.statSync(path.join(projectsRoot, dirName)).isDirectory()).toBe(true);
    }
  });

  it('rejects a required child path that is a file', () => {
    fs.writeFileSync(path.join(projectsRoot, 'tbd'), 'not-a-directory');
    expect(() => ensureCanonicalDirs(projectsRoot)).toThrow(StorageError);
  });

  it('preserves unknown directories', () => {
    fs.mkdirSync(path.join(projectsRoot, 'custom-thing'), { recursive: true });
    ensureCanonicalDirs(projectsRoot);
    expect(fs.statSync(path.join(projectsRoot, 'custom-thing')).isDirectory()).toBe(true);
  });

  it('fails when PROJECTS_ROOT does not exist', () => {
    const missing = path.join(tmpDir, 'nonexistent');
    expect(() => ensureCanonicalDirs(missing)).toThrow(StorageError);
  });

  it('ensureStatusDirs is an alias that produces the same result', () => {
    ensureStatusDirs(projectsRoot);
    for (const dirName of CANONICAL_DIRS) {
      expect(fs.statSync(path.join(projectsRoot, dirName)).isDirectory()).toBe(true);
    }
  });

  it('error messages do not contain absolute paths', () => {
    fs.writeFileSync(path.join(projectsRoot, 'tbd'), 'file-instead');
    try {
      ensureCanonicalDirs(projectsRoot);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).not.toContain(projectsRoot);
      expect(err.message).not.toContain(tmpDir);
    }
  });
});

describe('getProjectDir', () => {
  let projectsRoot;

  beforeEach(() => {
    projectsRoot = '/tmp/test-projects';
  });

  it('resolves path for each status mapping', () => {
    for (const [status, dirName] of Object.entries(STATUS_DIR_MAP)) {
      const result = getProjectDir(projectsRoot, status, 'my-slug');
      expect(result).toBe(path.join(projectsRoot, dirName, 'my-slug'));
    }
  });

  it('throws for unknown status', () => {
    expect(() => getProjectDir(projectsRoot, 'bogus', 'x')).toThrow(StorageError);
  });
});

describe('getStatusDir', () => {
  let projectsRoot;

  beforeEach(() => {
    projectsRoot = '/tmp/test-projects';
  });

  it('resolves status to canonical directory', () => {
    expect(getStatusDir(projectsRoot, 'in-progress')).toBe(
      path.join(projectsRoot, 'active')
    );
    expect(getStatusDir(projectsRoot, 'tbd')).toBe(
      path.join(projectsRoot, 'tbd')
    );
  });

  it('throws for unknown status', () => {
    expect(() => getStatusDir(projectsRoot, 'bogus')).toThrow(StorageError);
  });
});

// ─── ensurePreviewRoot (Phase 10.1A) ────────────────────────────────────

describe('ensurePreviewRoot', () => {
  let tmpDir;
  let appDataRoot;
  let previewRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-preview-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    previewRoot = path.join(appDataRoot, 'previews');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the preview root when it does not exist', () => {
    expect(fs.existsSync(previewRoot)).toBe(false);
    ensurePreviewRoot(previewRoot);
    expect(fs.existsSync(previewRoot)).toBe(true);
    expect(fs.statSync(previewRoot).isDirectory()).toBe(true);
  });

  it('is idempotent (accepts an existing valid directory)', () => {
    fs.mkdirSync(previewRoot, { recursive: true });
    fs.writeFileSync(path.join(previewRoot, 'existing-file'), 'x');
    expect(() => ensurePreviewRoot(previewRoot)).not.toThrow();
    expect(fs.existsSync(path.join(previewRoot, 'existing-file'))).toBe(true);
  });

  it('rejects a path that exists as a file', () => {
    fs.writeFileSync(previewRoot, 'not-a-dir');
    expect(() => ensurePreviewRoot(previewRoot)).toThrow(StorageError);
  });

  it('error messages do not leak absolute paths', () => {
    fs.writeFileSync(previewRoot, 'not-a-dir');
    try {
      ensurePreviewRoot(previewRoot);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).not.toContain(previewRoot);
      expect(err.message).not.toContain(tmpDir);
    }
  });
});
