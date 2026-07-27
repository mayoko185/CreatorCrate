import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_FILENAME,
  serializeManifest,
  deserializeManifest,
  formatManifestJson,
  writeManifestSync,
  readManifestSync,
  removeManifestSync,
  isManifestTempFile,
} from '../../src/storage/manifest.js';
import { StorageError } from '../../src/storage/path-manager.js';
import { formatProjectDirName, buildProjectRelPath, resolveProjectDir } from '../../src/storage/project-storage.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Create a minimal ProjectRecord-like object for serialization tests. */
function makeProject(overrides = {}) {
  return {
    id: 42,
    title: 'Summer Character Set',
    slug: 'summer-character-set',
    description: '',
    notes: '',
    status: 'in-progress',
    priority: 'normal',
    created_at: '2026-07-26 14:00:00',
    updated_at: '2026-07-26 14:00:00',
    planned_date: null,
    published_date: null,
    patreon_url: null,
    ...overrides,
  };
}

/** Create a complete valid project directory on disk for writer tests. */
function createRealProjectDir(root, status, id, slug) {
  const dirName = formatProjectDirName(id, slug);
  const relPath = buildProjectRelPath(status, dirName);
  const absPath = resolveProjectDir(root, relPath);
  fs.mkdirSync(absPath, { recursive: true });
  return { dirName, relPath, absPath };
}

/** Check whether directory symlinks are supported on this platform. */
function symlinksSupported() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mft-sym-'));
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

// ─── serializeManifest ───────────────────────────────────────────────────

describe('serializeManifest', () => {
  it('produces all expected manifest fields', () => {
    const project = makeProject();
    const manifest = serializeManifest(project);

    const keys = Object.keys(manifest).sort();
    expect(keys).toEqual([
      'createdAt',
      'description',
      'id',
      'notes',
      'patreonUrl',
      'plannedDate',
      'priority',
      'publishedDate',
      'schemaVersion',
      'slug',
      'status',
      'tags',
      'thumbnail',
      'title',
      'updatedAt',
    ].sort());
  });

  it('sets schemaVersion to exactly 1', () => {
    const manifest = serializeManifest(makeProject());
    expect(manifest.schemaVersion).toBe(1);
  });

  it('uses camelCase for all JSON field names', () => {
    const manifest = serializeManifest(makeProject());
    for (const key of Object.keys(manifest)) {
      // First character is lowercase (camelCase convention)
      expect(key.charAt(0)).toBe(key.charAt(0).toLowerCase());
      // No underscore in any key
      expect(key).not.toContain('_');
    }
  });

  it('converts snake_case database dates to ISO 8601 camelCase', () => {
    const project = makeProject();
    const manifest = serializeManifest(project);

    // SQLite "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS.000Z"
    expect(manifest.createdAt).toBe('2026-07-26T14:00:00.000Z');
    expect(manifest.updatedAt).toBe('2026-07-26T14:00:00.000Z');
  });

  it('converts date-only planned/published dates', () => {
    const project = makeProject({
      planned_date: '2026-08-15',
      published_date: '2026-09-01',
    });
    const manifest = serializeManifest(project);

    expect(manifest.plannedDate).toBe('2026-08-15T00:00:00.000Z');
    expect(manifest.publishedDate).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps nullable metadata as null', () => {
    const project = makeProject({
      planned_date: null,
      published_date: null,
      patreon_url: null,
    });
    const manifest = serializeManifest(project);

    expect(manifest.plannedDate).toBeNull();
    expect(manifest.publishedDate).toBeNull();
    expect(manifest.patreonUrl).toBeNull();
  });

  it('sets tags to an empty array', () => {
    const manifest = serializeManifest(makeProject());
    expect(manifest.tags).toEqual([]);
  });

  it('sets thumbnail to null', () => {
    const manifest = serializeManifest(makeProject());
    expect(manifest.thumbnail).toBeNull();
  });

  it('preserves intentional empty-string fields', () => {
    const manifest = serializeManifest(makeProject({
      description: '',
      notes: '',
    }));
    expect(manifest.description).toBe('');
    expect(manifest.notes).toBe('');
  });

  it('defaults description and notes to empty string if not provided', () => {
    const project = makeProject();
    delete project.description;
    delete project.notes;
    const manifest = serializeManifest(project);
    expect(manifest.description).toBe('');
    expect(manifest.notes).toBe('');
  });

  it('maps patreon_url to camelCase', () => {
    const project = makeProject({ patreon_url: 'https://patreon.com/creator' });
    const manifest = serializeManifest(project);
    expect(manifest.patreonUrl).toBe('https://patreon.com/creator');
  });

  it('passes through existing ISO dates without double-conversion', () => {
    const project = makeProject({ created_at: '2026-07-26T14:00:00.000Z' });
    const manifest = serializeManifest(project);
    expect(manifest.createdAt).toBe('2026-07-26T14:00:00.000Z');
  });
});

// ─── deserializeManifest ─────────────────────────────────────────────────

describe('deserializeManifest', () => {
  it('converts camelCase manifest back to snake_case', () => {
    const manifest = {
      schemaVersion: 1,
      id: 42,
      title: 'Test',
      slug: 'test',
      status: 'tbd',
      priority: 'normal',
      description: 'desc',
      notes: 'notes',
      tags: [],
      createdAt: '2026-07-26T14:00:00.000Z',
      updatedAt: '2026-07-26T14:00:00.000Z',
      plannedDate: '2026-08-15T00:00:00.000Z',
      publishedDate: null,
      patreonUrl: 'https://patreon.com/user',
      thumbnail: null,
    };

    const data = deserializeManifest(manifest);

    expect(data.id).toBe(42);
    expect(data.title).toBe('Test');
    expect(data.created_at).toBe('2026-07-26 14:00:00');
    expect(data.updated_at).toBe('2026-07-26 14:00:00');
    expect(data.planned_date).toBe('2026-08-15');
    expect(data.published_date).toBeNull();
    expect(data.patreon_url).toBe('https://patreon.com/user');
    expect(data.thumbnail).toBeNull();
  });

  it('round-trips through serialize → JSON → parse → deserialize', () => {
    const project = makeProject({
      planned_date: '2026-08-15',
      published_date: null,
      patreon_url: 'https://patreon.com/creator',
    });
    const manifest = serializeManifest(project);
    const json = formatManifestJson(manifest);
    const parsed = JSON.parse(json);
    const result = deserializeManifest(parsed);

    expect(result.id).toBe(project.id);
    expect(result.title).toBe(project.title);
    expect(result.slug).toBe(project.slug);
    expect(result.description).toBe(project.description);
    expect(result.notes).toBe(project.notes);
    expect(result.planned_date).toBe('2026-08-15');
    expect(result.published_date).toBeNull();
    expect(result.patreon_url).toBe('https://patreon.com/creator');
  });
});

// ─── formatManifestJson ──────────────────────────────────────────────────

describe('formatManifestJson', () => {
  it('formats JSON with 2-space indentation', () => {
    const manifest = serializeManifest(makeProject());
    const json = formatManifestJson(manifest);
    const lines = json.trimEnd().split('\n');
    // Indented lines should start with 2 spaces
    for (const line of lines.slice(1)) {
      if (line.includes(':')) {
        expect(line).toMatch(/^  /);
      }
    }
  });

  it('includes a trailing newline', () => {
    const manifest = serializeManifest(makeProject());
    const json = formatManifestJson(manifest);
    expect(json.endsWith('\n')).toBe(true);
  });

  it('does not contain any absolute path', () => {
    const manifest = serializeManifest(makeProject());
    const json = formatManifestJson(manifest);
    // JSON should not contain slash-prefixed paths
    expect(json).not.toMatch(/"[A-Z]?:\\/);
    expect(json).not.toMatch(/"\/\w+/);
  });
});

// ─── writeManifestSync + readManifestSync + removeManifestSync ───────────

describe('manifest file operations', () => {
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-manifest-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(path.join(projectsRoot, 'active'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── writeManifestSync ───────────────────────────────

  describe('writeManifestSync', () => {
    it('creates a manifest file atomically on first write', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'summer-set');
      const project = makeProject({ id: 42, slug: 'summer-set' });

      writeManifestSync(absPath, project, projectsRoot);

      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.id).toBe(42);
      expect(parsed.title).toBe('Summer Character Set');
      expect(parsed.slug).toBe('summer-set');
    });

    it('replaces an existing manifest', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'project');
      const project1 = makeProject({ id: 42, title: 'First Title', slug: 'project' });
      const project2 = makeProject({ id: 42, title: 'Updated Title', slug: 'project' });

      // First write
      writeManifestSync(absPath, project1, projectsRoot);

      // Second write (replacement)
      writeManifestSync(absPath, project2, projectsRoot);

      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      const content = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.title).toBe('Updated Title');
    });

    it('does not leave a temp file after successful write', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'clean');
      const project = makeProject({ id: 42, slug: 'clean' });

      writeManifestSync(absPath, project, projectsRoot);

      const entries = fs.readdirSync(absPath);
      const tempFiles = entries.filter((f) => f.startsWith('.') && f.endsWith('.tmp'));
      expect(tempFiles).toHaveLength(0);
    });

    it('uses a temp filename that does not look like a valid manifest', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'temp-name');
      const project = makeProject({ id: 42, slug: 'temp-name' });

      // Spy on openSync to capture the temp path
      const openSpy = vi.spyOn(fs, 'openSync');

      writeManifestSync(absPath, project, projectsRoot);

      expect(openSpy).toHaveBeenCalled();
      const tempPath = openSpy.mock.calls[0][0];
      const tempName = path.basename(tempPath);
      expect(tempName).toMatch(/^\.[a-f0-9]{12}\.project\.json\.tmp$/);
      expect(tempName).not.toBe(MANIFEST_FILENAME);

      openSpy.mockRestore();
    });

    it('cleans up the temp file when rename fails', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'rename-fail');
      const project = makeProject({ id: 42, slug: 'rename-fail' });

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('injected rename failure');
      });

      expect(() => writeManifestSync(absPath, project, projectsRoot)).toThrow(StorageError);

      renameSpy.mockRestore();

      // Verify no project.json was created
      expect(fs.existsSync(path.join(absPath, MANIFEST_FILENAME))).toBe(false);

      // Verify temp file was cleaned up
      const entries = fs.readdirSync(absPath);
      const tempFiles = entries.filter((f) => f.startsWith('.') && f.endsWith('.tmp'));
      expect(tempFiles).toHaveLength(0);
    });

    it('preserves existing manifest when replacement rename fails', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'preserve');
      const project1 = makeProject({ id: 42, title: 'Original', slug: 'preserve' });
      const project2 = makeProject({ id: 42, title: 'Replacement', slug: 'preserve' });

      // First write (success)
      writeManifestSync(absPath, project1, projectsRoot);

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('injected rename failure');
      });

      // Second write (failure)
      expect(() => writeManifestSync(absPath, project2, projectsRoot)).toThrow(StorageError);

      renameSpy.mockRestore();

      // Verify the original manifest is still intact
      const content = fs.readFileSync(path.join(absPath, MANIFEST_FILENAME), 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.title).toBe('Original');
    });

    it('rejects a non-existent project directory', () => {
      const ghostPath = path.join(projectsRoot, 'active', '000099-ghost');
      const project = makeProject({ id: 99, slug: 'ghost' });

      expect(() => writeManifestSync(ghostPath, project, projectsRoot)).toThrow(StorageError);
    });

    it('rejects a path that is a file (not a directory)', () => {
      const filePath = path.join(projectsRoot, 'active', 'not-a-dir');
      fs.writeFileSync(filePath, '');

      const project = makeProject({ id: 99, slug: 'not-a-dir' });
      expect(() => writeManifestSync(filePath, project, projectsRoot)).toThrow(StorageError);
    });

    it('rejects a symlink project directory', () => {
      if (!symlinksSupported()) return;

      const realDir = path.join(projectsRoot, 'active', 'real-target');
      fs.mkdirSync(realDir, { recursive: true });

      const linkDir = path.join(projectsRoot, 'active', '000042-link');
      fs.symlinkSync(realDir, linkDir, 'junction');

      const project = makeProject({ id: 42, slug: 'link' });
      expect(() => writeManifestSync(linkDir, project, projectsRoot)).toThrow(StorageError);
    });

    it('includes project ID and safe relative path in error', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'error-msg');
      const project = makeProject({ id: 42, slug: 'error-msg' });

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('injected');
      });

      try {
        expect(() => writeManifestSync(absPath, project, projectsRoot)).toThrow(StorageError);
      } catch (err) {
        expect(err.message).toContain('42');
        expect(err.message).toContain('active');
      }

      renameSpy.mockRestore();
    });

    it('produces valid JSON that can be read back', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'roundtrip');
      const project = makeProject({ id: 42, slug: 'roundtrip' });

      writeManifestSync(absPath, project, projectsRoot);

      // Read it back via readManifestSync
      const manifest = readManifestSync(absPath);
      expect(manifest).not.toBeNull();
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.id).toBe(42);
      expect(manifest.title).toBe('Summer Character Set');
    });
  });

  // ─── readManifestSync ────────────────────────────────

  describe('readManifestSync', () => {
    it('returns null when no manifest file exists', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'no-manifest');
      expect(readManifestSync(absPath)).toBeNull();
    });

    it('throws StorageError for invalid JSON', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'bad-json');
      fs.writeFileSync(path.join(absPath, MANIFEST_FILENAME), 'not json');
      expect(() => readManifestSync(absPath)).toThrow(StorageError);
    });

    it('reads back a previously written manifest', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'read-back');
      const project = makeProject({ id: 42, slug: 'read-back' });
      writeManifestSync(absPath, project, projectsRoot);

      const result = readManifestSync(absPath);
      expect(result).toBeInstanceOf(Object);
      expect(result.id).toBe(42);
      expect(result.title).toBe('Summer Character Set');
      // Verify camelCase keys
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('updatedAt');
      expect(result).toHaveProperty('plannedDate');
    });
  });

  // ─── removeManifestSync ──────────────────────────────

  describe('removeManifestSync', () => {
    it('removes an existing manifest file', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'remove-me');
      const project = makeProject({ id: 42, slug: 'remove-me' });
      writeManifestSync(absPath, project, projectsRoot);

      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      removeManifestSync(absPath);
      expect(fs.existsSync(manifestPath)).toBe(false);
    });

    it('is a no-op when no manifest exists', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 'in-progress', 42, 'noop');
      expect(() => removeManifestSync(absPath)).not.toThrow();
    });
  });

  // ─── isManifestTempFile ──────────────────────────────

  describe('isManifestTempFile', () => {
    it('matches a temp filename', () => {
      expect(isManifestTempFile('.a1b2c3d4e5f6.project.json.tmp')).toBe(true);
    });

    it('does not match the regular manifest filename', () => {
      expect(isManifestTempFile(MANIFEST_FILENAME)).toBe(false);
    });

    it('does not match random filenames', () => {
      expect(isManifestTempFile('readme.txt')).toBe(false);
    });

    it('does not match partially similar names', () => {
      expect(isManifestTempFile('.project.json.tmp')).toBe(false);
      expect(isManifestTempFile('a1b2c3d4e5f6.project.json.tmp')).toBe(false);
      expect(isManifestTempFile('.a1b2c3d4e5f6.project.json')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isManifestTempFile('')).toBe(false);
    });
  });
});
