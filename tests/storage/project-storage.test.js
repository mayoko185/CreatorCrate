import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatProjectDirName,
  buildProjectRelPath,
  resolveProjectDir,
  ensureNoConflict,
  createProjectCategoryDirs,
  verifyProjectDirOwnership,
  removeProjectDir,
  renameProjectDirSync,
  STATUS_DIR_MAP,
} from '../../src/storage/project-storage.js';
import { StorageError } from '../../src/storage/path-manager.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Attempt to create a directory symlink; returns true if the platform supports it.
 * On Windows this requires Developer Mode or elevated privileges.
 */
function symlinksSupported() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-symlink-test-'));
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(target);
    // Windows: 'junction' works without elevation in most environments
    fs.symlinkSync(target, link, 'junction');
    fs.rmSync(tmp, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Create a complete valid project directory on disk for testing. */
function createRealProjectDir(root, status, id, slug) {
  const dirName = formatProjectDirName(id, slug);
  const relPath = buildProjectRelPath(status, dirName);
  const absPath = resolveProjectDir(root, relPath);
  fs.mkdirSync(absPath, { recursive: true });
  return { dirName, relPath, absPath };
}

/** Normalize backslashes to forward slashes for comparison. */
function norm(p) {
  return p.replace(/\\/g, '/');
}

// ─── formatProjectDirName ────────────────────────────────────────────────

describe('formatProjectDirName', () => {
  it('pads a short ID to 6 digits', () => {
    expect(formatProjectDirName(42, 'my-project')).toBe('000042-my-project');
  });

  it('pads a single-digit ID', () => {
    expect(formatProjectDirName(1, 'test')).toBe('000001-test');
  });

  it('does not truncate IDs longer than 6 digits', () => {
    expect(formatProjectDirName(1234567, 'big-id')).toBe('1234567-big-id');
  });

  it('handles ID 0', () => {
    expect(formatProjectDirName(0, 'zero')).toBe('000000-zero');
  });

  it('handles exactly 6-digit IDs without extra padding', () => {
    expect(formatProjectDirName(123456, 'exact')).toBe('123456-exact');
  });

  it('preserves slug case', () => {
    expect(formatProjectDirName(7, 'UPPERCASE-slug')).toBe('000007-UPPERCASE-slug');
  });
});

// ─── buildProjectRelPath ─────────────────────────────────────────────────

describe('buildProjectRelPath', () => {
  it('maps each status to its canonical directory', () => {
    const testCases = [
      { status: 'tbd', expectDir: 'tbd' },
      { status: 'planned', expectDir: 'planned' },
      { status: 'in-progress', expectDir: 'active' },
      { status: 'ready', expectDir: 'ready' },
      { status: 'published', expectDir: 'published' },
      { status: 'archived', expectDir: 'archived' },
    ];
    for (const { status, expectDir } of testCases) {
      const result = buildProjectRelPath(status, '000042-my-project');
      expect(result).toBe(path.join(expectDir, '000042-my-project'));
    }
  });

  it('throws StorageError for unknown status', () => {
    expect(() => buildProjectRelPath('bogus', 'anything')).toThrow(StorageError);
  });

  it('produces a relative path (no leading separator)', () => {
    const result = buildProjectRelPath('tbd', '000001-test');
    expect(path.isAbsolute(result)).toBe(false);
  });
});

// ─── resolveProjectDir ───────────────────────────────────────────────────

describe('resolveProjectDir', () => {
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resolve-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    // Create a status directory
    fs.mkdirSync(path.join(projectsRoot, 'active'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects an empty path', () => {
    expect(() => resolveProjectDir(projectsRoot, '')).toThrow(StorageError);
  });

  it('rejects an absolute relPath', () => {
    expect(() => resolveProjectDir(projectsRoot, '/etc/passwd')).toThrow(StorageError);
  });

  it('rejects traversal outside PROJECTS_ROOT', () => {
    expect(() => resolveProjectDir(projectsRoot, '..')).toThrow(StorageError);
    expect(() => resolveProjectDir(projectsRoot, '../../etc')).toThrow(StorageError);
    expect(() => resolveProjectDir(projectsRoot, 'active/../..')).toThrow(StorageError);
  });

  it('rejects a path that resolves to PROJECTS_ROOT itself', () => {
    expect(() => resolveProjectDir(projectsRoot, '.')).toThrow(StorageError);
  });

  it('resolves a valid relative path', () => {
    const rel = path.join('active', '000042-my-project');
    const resolved = resolveProjectDir(projectsRoot, rel);
    expect(resolved).toBe(path.resolve(projectsRoot, rel));
  });

  it('resolves a nested path correctly', () => {
    const rel = path.join('active', '000001-test');
    const resolved = resolveProjectDir(projectsRoot, rel);
    expect(resolved).toBe(path.join(projectsRoot, 'active', '000001-test'));
  });

  it('rejects an absolute path even when it is inside PROJECTS_ROOT', () => {
    const inside = path.join(projectsRoot, 'active', '000001-test');
    expect(() => resolveProjectDir(projectsRoot, inside)).toThrow(StorageError);
  });

  describe('symlink rejection', () => {
    const hasSymlinks = symlinksSupported();

    it('refuses a project directory that is a symlink', () => {
      if (!hasSymlinks) return;

      const realDir = path.join(projectsRoot, 'active', 'real-target');
      fs.mkdirSync(realDir, { recursive: true });

      const linkDir = path.join(projectsRoot, 'active', '000001-link');
      fs.symlinkSync(realDir, linkDir, 'junction');

      const rel = path.join('active', '000001-link');
      expect(() => resolveProjectDir(projectsRoot, rel)).toThrow(StorageError);
    });

    it('refuses a symlink escape via intermediate component', () => {
      if (!hasSymlinks) return;

      const outside = path.join(tmpDir, 'outside');
      fs.mkdirSync(outside);

      // Replace the 'active' dir with a symlink pointing outside
      const realActive = path.join(tmpDir, 'real-active');
      fs.mkdirSync(realActive);
      fs.rmSync(path.join(projectsRoot, 'active'), { recursive: true });
      fs.symlinkSync(realActive, path.join(projectsRoot, 'active'), 'junction');

      const rel = path.join('active', '000042-project');
      expect(() => resolveProjectDir(projectsRoot, rel)).toThrow(StorageError);
    });

    it('accepts a real directory that coexists with a symlink sibling', () => {
      if (!hasSymlinks) return;

      // Create a real directory alongside a symlink — only the target's
      // own path components are checked, not siblings.
      const realDir = path.join(projectsRoot, 'active', '000001-real');
      fs.mkdirSync(realDir, { recursive: true });

      const linkTarget = path.join(projectsRoot, 'active', 'link-target');
      fs.mkdirSync(linkTarget);
      const linkDir = path.join(projectsRoot, 'active', 'evil-link');
      fs.symlinkSync(linkTarget, linkDir, 'junction');

      const rel = path.join('active', '000001-real');
      expect(() => resolveProjectDir(projectsRoot, rel)).not.toThrow();
    });
  });
});

// ─── ensureNoConflict ────────────────────────────────────────────────────

describe('ensureNoConflict', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-conflict-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes when the path does not exist', () => {
    const missing = path.join(tmpDir, 'nonexistent');
    expect(() => ensureNoConflict(missing)).not.toThrow();
  });

  it('rejects an existing directory', () => {
    const existing = path.join(tmpDir, 'existing-dir');
    fs.mkdirSync(existing);
    expect(() => ensureNoConflict(existing)).toThrow(StorageError);
  });

  it('rejects an existing file', () => {
    const existing = path.join(tmpDir, 'existing-file');
    fs.writeFileSync(existing, '');
    expect(() => ensureNoConflict(existing)).toThrow(StorageError);
  });
});

// ─── createProjectCategoryDirs ───────────────────────────────────────────

describe('createProjectCategoryDirs', () => {
  let tmpDir;
  let projectDir;

  const EXPECTED_SUBDIRS = ['source', 'exports', 'extras', 'references', 'thumbnails'];

  /** Ordered, all-enabled category rows matching the seeded defaults. */
  function makeCategories(slugs = EXPECTED_SUBDIRS) {
    return slugs.map((slug, i) => ({
      directory_slug: slug,
      display_order: i,
      enabled: 1,
    }));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-subdirs-'));
    projectDir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates one direct-child directory per enabled category', () => {
    createProjectCategoryDirs(projectDir, makeCategories());
    for (const sub of EXPECTED_SUBDIRS) {
      const subPath = path.join(projectDir, sub);
      expect(fs.existsSync(subPath)).toBe(true);
      expect(fs.statSync(subPath).isDirectory()).toBe(true);
    }
  });

  it('does not create exports/full or exports/web', () => {
    createProjectCategoryDirs(projectDir, makeCategories());
    expect(fs.existsSync(path.join(projectDir, 'exports', 'full'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'exports', 'web'))).toBe(false);
  });

  it('skips disabled categories', () => {
    const categories = [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: 'extras', display_order: 1, enabled: 0 },
      { directory_slug: 'exports', display_order: 2, enabled: true },
      { directory_slug: 'thumbnails', display_order: 3, enabled: false },
    ];
    createProjectCategoryDirs(projectDir, categories);

    expect(fs.existsSync(path.join(projectDir, 'source'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'exports'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'extras'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'thumbnails'))).toBe(false);
  });

  it('creates no directories when given an empty list', () => {
    createProjectCategoryDirs(projectDir, []);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('is idempotent', () => {
    createProjectCategoryDirs(projectDir, makeCategories());
    createProjectCategoryDirs(projectDir, makeCategories());
    for (const sub of EXPECTED_SUBDIRS) {
      expect(fs.statSync(path.join(projectDir, sub)).isDirectory()).toBe(true);
    }
  });

  it('does not create files or unrelated directories', () => {
    createProjectCategoryDirs(projectDir, makeCategories());
    const created = new Set(
      fs.readdirSync(projectDir, { recursive: true }).map(norm)
    );
    const expected = new Set(EXPECTED_SUBDIRS.map(norm));
    for (const sub of expected) {
      expect(created.has(sub)).toBe(true);
    }
    // Only directories at the top level
    const top = fs.readdirSync(projectDir);
    for (const entry of top) {
      expect(fs.statSync(path.join(projectDir, entry)).isDirectory()).toBe(true);
    }
  });

  it('keeps unknown neighboring directories untouched', () => {
    // Create an unknown directory inside the project dir
    fs.mkdirSync(path.join(projectDir, 'user-data'));

    createProjectCategoryDirs(projectDir, makeCategories());

    // After creation, the user-data dir should still exist
    expect(fs.statSync(path.join(projectDir, 'user-data')).isDirectory()).toBe(true);

    // And all standard dirs should be present
    for (const sub of EXPECTED_SUBDIRS) {
      expect(fs.statSync(path.join(projectDir, sub)).isDirectory()).toBe(true);
    }
  });

  it('throws when project directory does not exist', () => {
    const missing = path.join(tmpDir, 'nonexistent');
    expect(() => createProjectCategoryDirs(missing, makeCategories())).toThrow(StorageError);
  });

  it('throws when project directory is a file', () => {
    const filePath = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(filePath, '');
    expect(() => createProjectCategoryDirs(filePath, makeCategories())).toThrow(StorageError);
  });

  // ─── slug safety ──────────────────────────────────────

  it('rejects a slug containing a path separator', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'nested/evil', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'nested\\evil', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
  });

  it('rejects traversal slugs', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: '..', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: '.', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
  });

  it('rejects an absolute-path slug', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: '/etc/passwd', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'C:\\evil', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
  });

  it('rejects a reserved device name', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'CON', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
  });

  it('rejects an empty slug', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: '', display_order: 0, enabled: 1 },
    ])).toThrow(StorageError);
  });

  it('does not create anything when an unsafe slug is rejected', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: '../evil', display_order: 1, enabled: 1 },
    ])).toThrow(StorageError);
    // All enabled slugs are validated up front, before any directory is
    // created — an unsafe later entry must not leave an earlier, valid
    // entry partially created.
    expect(fs.existsSync(path.join(projectDir, 'source'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '..', 'evil'))).toBe(false);
  });

  it('rejects an unsafe portable slug before creating any directory', () => {
    for (const slug of ['project.json', 'PROJECT.JSON', 'Source', 'source files', '.hidden', 'source_files']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-subdirs-slug-'));
      expect(() => createProjectCategoryDirs(dir, [
        { directory_slug: slug, display_order: 0, enabled: 1 },
      ])).toThrow(StorageError);
      expect(fs.readdirSync(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when an early slug is valid but a later slug is invalid, creating nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-subdirs-order-'));
    expect(() => createProjectCategoryDirs(dir, [
      { directory_slug: 'valid-one', display_order: 0, enabled: 1 },
      { directory_slug: 'source files', display_order: 1, enabled: 1 },
    ])).toThrow(StorageError);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts an explicitly mapped storage-safe shape (directorySlug/enabled)', () => {
    createProjectCategoryDirs(projectDir, [
      { directorySlug: 'source', enabled: true },
      { directorySlug: 'extras', enabled: false },
    ]);
    expect(fs.existsSync(path.join(projectDir, 'source'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'extras'))).toBe(false);
  });

  // ─── complete-set preflight (duplicates, disabled validity) ───────────

  it('rejects a non-array category collection without touching the filesystem', () => {
    expect(() => createProjectCategoryDirs(projectDir, null)).toThrow(StorageError);
    expect(() => createProjectCategoryDirs(projectDir, { directory_slug: 'source', enabled: 1 }))
      .toThrow(StorageError);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('rejects two enabled categories sharing the same slug, creating nothing', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: 'source', display_order: 1, enabled: 1 },
    ])).toThrow(StorageError);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('rejects duplicate slugs differing only by case, creating nothing', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: 'Source', display_order: 1, enabled: 1 },
    ])).toThrow(StorageError);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('rejects an enabled category sharing a slug with a disabled category, creating nothing', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: 'source', display_order: 1, enabled: 0 },
    ])).toThrow(StorageError);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('rejects a disabled category with an unsafe slug, creating nothing', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: '../evil', display_order: 1, enabled: 0 },
    ])).toThrow(StorageError);
    expect(fs.readdirSync(projectDir)).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'evil'))).toBe(false);
  });

  it('rejects a valid first category followed by a duplicate later category, creating nothing', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: 'extras', display_order: 1, enabled: 1 },
      { directory_slug: 'source', display_order: 2, enabled: 0 },
    ])).toThrow(StorageError);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('rejects a malformed "enabled" field even when direct input bypasses service validation', () => {
    expect(() => createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 'true' },
    ])).toThrow(StorageError);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('still creates nothing for a disabled valid category and creates enabled valid categories', () => {
    createProjectCategoryDirs(projectDir, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
      { directory_slug: 'extras', display_order: 1, enabled: 0 },
    ]);
    expect(fs.existsSync(path.join(projectDir, 'source'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'extras'))).toBe(false);
  });
});

// ─── verifyProjectDirOwnership ───────────────────────────────────────────

describe('verifyProjectDirOwnership', () => {
  it('returns true for matching ID with zero-padded prefix', () => {
    expect(verifyProjectDirOwnership('/root/active/000042-my-project', 42)).toBe(true);
  });

  it('returns true for long IDs (no truncation)', () => {
    expect(verifyProjectDirOwnership('/root/active/1234567-my-project', 1234567)).toBe(true);
  });

  it('returns false for wrong ID', () => {
    expect(verifyProjectDirOwnership('/root/active/000042-my-project', 43)).toBe(false);
  });

  it('returns false for ID 0 when directory has non-zero ID', () => {
    expect(verifyProjectDirOwnership('/root/active/000001-something', 0)).toBe(false);
  });

  it('returns false for a directory named with a different pattern', () => {
    expect(verifyProjectDirOwnership('/root/active/not-an-id-dir', 1)).toBe(false);
  });

  it('handles project dir in nested path correctly', () => {
    // The function uses basename, so the full path depth doesn't matter
    expect(verifyProjectDirOwnership('/a/b/c/000007-test', 7)).toBe(true);
  });
});

// ─── removeProjectDir ────────────────────────────────────────────────────

describe('removeProjectDir', () => {
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cleanup-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    // Create the status dirs that buildProjectRelPath resolves to
    fs.mkdirSync(path.join(projectsRoot, 'tbd'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes an empty project directory that matches expected ID', () => {
    const { absPath } = createRealProjectDir(projectsRoot, 'tbd', 42, 'my-project');
    expect(fs.existsSync(absPath)).toBe(true);
    removeProjectDir(absPath, 42, projectsRoot);
    expect(fs.existsSync(absPath)).toBe(false);
  });

  it('refuses to remove a directory with wrong expected ID', () => {
    const { absPath } = createRealProjectDir(projectsRoot, 'tbd', 42, 'my-project');
    expect(() => removeProjectDir(absPath, 99, projectsRoot)).toThrow(StorageError);
    expect(fs.existsSync(absPath)).toBe(true); // Not removed
  });

  it('refuses to remove a directory outside PROJECTS_ROOT', () => {
    const outside = path.join(tmpDir, 'outside-dir');
    fs.mkdirSync(outside);
    expect(() => removeProjectDir(outside, 1, projectsRoot)).toThrow(StorageError);
  });

  it('is a no-op when the directory does not exist', () => {
    const missing = path.join(projectsRoot, 'active', '000099-ghost');
    expect(() => removeProjectDir(missing, 99, projectsRoot)).not.toThrow();
  });

  it('refuses to remove a directory that is a file', () => {
    const filePath = path.join(projectsRoot, 'tbd', 'some-file');
    fs.writeFileSync(filePath, 'content');
    expect(() => removeProjectDir(filePath, 0, projectsRoot)).toThrow(StorageError);
  });

  it('refuses to remove a non-empty directory', () => {
    const { absPath } = createRealProjectDir(projectsRoot, 'tbd', 50, 'nonempty');
    fs.writeFileSync(path.join(absPath, 'placeholder.txt'), 'stuff');
    expect(() => removeProjectDir(absPath, 50, projectsRoot)).toThrow(StorageError);
    expect(fs.existsSync(absPath)).toBe(true); // Not removed
  });

  it('refuses to remove a symlinked directory', () => {
    if (!symlinksSupported()) return;

    const realDir = path.join(projectsRoot, 'tbd', 'real');
    fs.mkdirSync(realDir);
    const linkDir = path.join(projectsRoot, 'tbd', '000099-link');
    fs.symlinkSync(realDir, linkDir, 'junction');

    expect(() => removeProjectDir(linkDir, 99, projectsRoot)).toThrow(StorageError);
    expect(fs.existsSync(linkDir)).toBe(true); // Not removed
  });

  it('does not affect neighboring directories', () => {
    createRealProjectDir(projectsRoot, 'tbd', 1, 'keep-me');
    const { absPath: removeMe } = createRealProjectDir(projectsRoot, 'tbd', 2, 'remove-me');

    removeProjectDir(removeMe, 2, projectsRoot);

    const neighbor = path.join(projectsRoot, 'tbd', '000001-keep-me');
    expect(fs.existsSync(neighbor)).toBe(true);
    expect(fs.existsSync(removeMe)).toBe(false);
  });
});

// ─── renameProjectDirSync ────────────────────────────────────────────────

describe('renameProjectDirSync', () => {
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rename-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    // Create status dirs that buildProjectRelPath resolves to
    fs.mkdirSync(path.join(projectsRoot, 'tbd'), { recursive: true });
    fs.mkdirSync(path.join(projectsRoot, 'published'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renames a project directory within the same filesystem', () => {
    const { absPath: oldPath } = createRealProjectDir(projectsRoot, 'tbd', 42, 'old-name');
    const newPath = path.join(projectsRoot, 'tbd', '000042-new-name');

    // Create a file inside the project dir to prove contents survive
    fs.writeFileSync(path.join(oldPath, 'project.json'), JSON.stringify({ id: 42 }));
    fs.mkdirSync(path.join(oldPath, 'source'));

    renameProjectDirSync(oldPath, newPath);

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.statSync(newPath).isDirectory()).toBe(true);
    // Contents survived
    expect(fs.existsSync(path.join(newPath, 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(newPath, 'source'))).toBe(true);
  });

  it('surfaces EXDEV as a StorageError', () => {
    const oldPath = path.join(projectsRoot, 'active', '000042-project');
    const newPath = path.join(projectsRoot, 'published', '000042-project');

    const mockError = new Error('cross-device link');
    mockError.code = 'EXDEV';
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw mockError; });

    try {
      expect(() => renameProjectDirSync(oldPath, newPath)).toThrow(StorageError);
    } finally {
      spy.mockRestore();
    }
  });

  it('surfaces unexpected rename errors', () => {
    const oldPath = path.join(projectsRoot, 'active', 'ghost');
    const newPath = path.join(projectsRoot, 'active', '000042-target');

    const mockError = new Error('access denied');
    mockError.code = 'EACCES';
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw mockError; });

    try {
      expect(() => renameProjectDirSync(oldPath, newPath)).toThrow(StorageError);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Integrated flow ─────────────────────────────────────────────────────

describe('integrated directory lifecycle', () => {
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lifecycle-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    // Create status directories (as the real startup would)
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: resolve → create → subdirs → verify → move', () => {
    const id = 42;
    const slug = 'my-project';

    // 1. Build and resolve
    const dirName = formatProjectDirName(id, slug);
    const relPath = buildProjectRelPath('tbd', dirName);
    const absPath = resolveProjectDir(projectsRoot, relPath);

    // 2. Ensure no conflict and create
    ensureNoConflict(absPath);
    fs.mkdirSync(absPath, { recursive: true });

    // 3. Create category directories
    createProjectCategoryDirs(absPath, [
      { directory_slug: 'source', display_order: 0, enabled: 1 },
    ]);

    // 4. Verify ownership
    expect(verifyProjectDirOwnership(absPath, id)).toBe(true);

    // 5. Move to different status (in-progress maps to 'active' dir)
    const newRelPath = buildProjectRelPath('in-progress', dirName);
    const newAbsPath = resolveProjectDir(projectsRoot, newRelPath);
    ensureNoConflict(newAbsPath);
    renameProjectDirSync(absPath, newAbsPath);

    expect(fs.existsSync(absPath)).toBe(false);
    expect(fs.existsSync(newAbsPath)).toBe(true);
    expect(fs.statSync(path.join(newAbsPath, 'source')).isDirectory()).toBe(true);

    // removeProjectDir correctly refuses non-empty directories (safety check)
    expect(() => removeProjectDir(newAbsPath, id, projectsRoot)).toThrow(StorageError);
  });
});
