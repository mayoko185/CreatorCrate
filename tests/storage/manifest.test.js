import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  serializeManifest,
  deserializeManifest,
  formatManifestJson,
  readManifestSync,
  removeManifestSync,
  isManifestTempFile,
} from '../../src/storage/manifest.js';
import { StorageError } from '../../src/storage/path-manager.js';
import { formatProjectDirName, resolveProjectDir } from '../../src/storage/project-storage.js';

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
    created_at: '2026-07-26 14:00:00',
    updated_at: '2026-07-26 14:00:00',
    patreon_url: null,
    ...overrides,
  };
}

/** Create minimal project-owned category rows for serialization tests. */
function makeCategories(overrides = []) {
  return [
    { id: 1, project_id: 42, display_name: 'Final', directory_slug: 'final', display_order: 0, enabled: 1, created_at: '2026-07-24 14:00:00', updated_at: '2026-07-24 14:00:00' },
    { id: 2, project_id: 42, display_name: 'WIP', directory_slug: 'wip', display_order: 1, enabled: 1, created_at: '2026-07-24 14:00:00', updated_at: '2026-07-24 14:00:00' },
    ...overrides,
  ];
}

/**
 * Plant a legacy project.json directly on disk. CreatorCrate no longer
 * writes manifests at runtime; these files exist only as legacy sidecars.
 */
function plantLegacyManifest(absPath, project, categories = []) {
  fs.writeFileSync(
    path.join(absPath, MANIFEST_FILENAME),
    formatManifestJson(serializeManifest(project, categories)),
    'utf8',
  );
}

/**
 * Create a complete valid project directory on disk for file tests.
 * Project directories are direct children of PROJECTS_ROOT:
 * `PROJECTS_ROOT/<project-directory>`.
 */
function createRealProjectDir(root, id, slug) {
  const dirName = formatProjectDirName(id, slug);
  const relPath = dirName;
  const absPath = resolveProjectDir(root, relPath);
  fs.mkdirSync(absPath, { recursive: true });
  return { dirName, relPath, absPath };
}


// ─── serializeManifest ───────────────────────────────────────────────────

describe('serializeManifest', () => {
  it('produces all expected manifest fields', () => {
    const project = makeProject();
    const manifest = serializeManifest(project);

    const keys = Object.keys(manifest).sort();
    expect(keys).toEqual([
      'assetCategories',
      'createdAt',
      'description',
      'id',
      'notes',
      'patreonUrl',
      'schemaVersion',
      'slug',
      'tags',
      'thumbnail',
      'title',
      'updatedAt',
    ].sort());
  });

  it('does not serialize project status', () => {
    const project = makeProject({ status: 'in-progress' });
    const manifest = serializeManifest(project);

    expect(manifest).not.toHaveProperty('status');
    const json = formatManifestJson(manifest);
    expect(json).not.toMatch(/"status"\s*:/);
    expect(json).not.toContain('in-progress');
  });

  it('does not serialize project priority', () => {
    const manifest = serializeManifest(makeProject({ priority: 'high' }));

    expect(manifest).not.toHaveProperty('priority');
    expect(formatManifestJson(manifest)).not.toMatch(/"priority"\s*:/);
  });

  it('sets schemaVersion to exactly 3', () => {
    const manifest = serializeManifest(makeProject());
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.schemaVersion).toBe(3);
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

  it('omits obsolete project scheduling fields even when legacy record keys are present', () => {
    const project = makeProject({
      planned_date: '2026-08-15',
      published_date: '2026-09-01',
    });
    const manifest = serializeManifest(project);

    expect(manifest).not.toHaveProperty('plannedDate');
    expect(manifest).not.toHaveProperty('publishedDate');
    expect(formatManifestJson(manifest)).not.toMatch(/"(?:plannedDate|publishedDate)"\s*:/);
  });

  it('keeps nullable metadata as null', () => {
    const project = makeProject({
      patreon_url: null,
    });
    const manifest = serializeManifest(project);

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

  // ─── assetCategories ─────────────────────────────────

  it('defaults assetCategories to an empty array when no categories are given', () => {
    const manifest = serializeManifest(makeProject());
    expect(manifest.assetCategories).toEqual([]);
  });

  it('serializes categories to exactly displayName/directorySlug/displayOrder/enabled', () => {
    const manifest = serializeManifest(makeProject(), makeCategories());
    for (const category of manifest.assetCategories) {
      expect(Object.keys(category).sort()).toEqual(
        ['displayName', 'directorySlug', 'displayOrder', 'enabled'].sort()
      );
    }
  });

  it('maps category fields correctly and coerces enabled to a boolean', () => {
    const manifest = serializeManifest(makeProject(), [
      { id: 7, project_id: 42, display_name: 'Final', directory_slug: 'final', display_order: 0, enabled: 1 },
      { id: 8, project_id: 42, display_name: 'KRZ', directory_slug: 'krz', display_order: 1, enabled: 0 },
    ]);

    expect(manifest.assetCategories).toEqual([
      { displayName: 'Final', directorySlug: 'final', displayOrder: 0, enabled: true },
      { displayName: 'KRZ', directorySlug: 'krz', displayOrder: 1, enabled: false },
    ]);
  });

  it('preserves the given category order', () => {
    const manifest = serializeManifest(makeProject(), makeCategories());
    expect(manifest.assetCategories.map((c) => c.directorySlug)).toEqual(['final', 'wip']);
  });

  it('does not serialize database category IDs, project IDs, or timestamps', () => {
    const manifest = serializeManifest(makeProject(), makeCategories());
    const json = formatManifestJson(manifest);
    for (const category of manifest.assetCategories) {
      expect(category).not.toHaveProperty('id');
      expect(category).not.toHaveProperty('projectId');
      expect(category).not.toHaveProperty('createdAt');
      expect(category).not.toHaveProperty('updatedAt');
    }
    // Category primary-key/foreign-key values must never leak into the file.
    expect(json).not.toMatch(/"id":\s*1\b/);
    expect(json).not.toMatch(/"id":\s*2\b/);
  });
});

// ─── deserializeManifest ─────────────────────────────────────────────────

describe('deserializeManifest', () => {
  it('loads a legacy v3 manifest without restoring obsolete scheduling fields', () => {
    const manifest = {
      schemaVersion: 3,
      id: 42,
      title: 'Test',
      slug: 'test',
      description: 'desc',
      notes: 'notes',
      tags: [],
      createdAt: '2026-07-26T14:00:00.000Z',
      updatedAt: '2026-07-26T14:00:00.000Z',
      plannedDate: '2026-08-15T00:00:00.000Z',
      publishedDate: null,
      patreonUrl: 'https://patreon.com/user',
      thumbnail: null,
      assetCategories: [],
    };

    const data = deserializeManifest(manifest);

    expect(data.id).toBe(42);
    expect(data.title).toBe('Test');
    expect(data.created_at).toBe('2026-07-26 14:00:00');
    expect(data.updated_at).toBe('2026-07-26 14:00:00');
    expect(data).not.toHaveProperty('planned_date');
    expect(data).not.toHaveProperty('published_date');
    expect(data.patreon_url).toBe('https://patreon.com/user');
    expect(data.thumbnail).toBeNull();
    expect(data).not.toHaveProperty('priority');
  });

  it('does not expose status as project metadata', () => {
    // A stale v2 manifest carries a status field, but it is now obsolete
    // and must not survive parsing as project metadata.
    const stale = validBaseManifest({ status: 'in-progress' });
    expect(() => deserializeManifest(stale)).toThrow(StorageError);

    const data = deserializeManifest(validBaseManifest());
    expect(data).not.toHaveProperty('status');
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
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('planned_date');
    expect(result).not.toHaveProperty('published_date');
    expect(result.patreon_url).toBe('https://patreon.com/creator');
  });

  it('rejects a schema-version-1 manifest', () => {
    const v1Manifest = {
      schemaVersion: 1,
      id: 42,
      title: 'Test',
      slug: 'test',
      status: 'tbd',
      description: '',
      notes: '',
      tags: [],
      createdAt: '2026-07-26T14:00:00.000Z',
      updatedAt: '2026-07-26T14:00:00.000Z',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
      thumbnail: null,
    };
    expect(() => deserializeManifest(v1Manifest)).toThrow(StorageError);
  });

  it('rejects a schema-version-2 manifest', () => {
    const v2Manifest = validBaseManifest({ schemaVersion: 2 });
    expect(() => deserializeManifest(v2Manifest)).toThrow(StorageError);
  });

  it('rejects a manifest with no schemaVersion', () => {
    expect(() => deserializeManifest({ id: 1, title: 'x', slug: 'x' })).toThrow(StorageError);
  });

  it('rejects a null manifest', () => {
    expect(() => deserializeManifest(null)).toThrow(StorageError);
  });

  // ─── authoritative assetCategories validation ────────────────────────

  function validBaseManifest(overrides = {}) {
    return {
      schemaVersion: 3,
      id: 42,
      title: 'Test',
      slug: 'test',
      description: '',
      notes: '',
      tags: [],
      createdAt: '2026-07-26T14:00:00.000Z',
      updatedAt: '2026-07-26T14:00:00.000Z',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
      thumbnail: null,
      assetCategories: [],
      ...overrides,
    };
  }

  it('accepts a valid manifest with an empty assetCategories array', () => {
    expect(() => deserializeManifest(validBaseManifest())).not.toThrow();
  });

  it('tolerates a legacy priority field without restoring it', () => {
    const data = deserializeManifest(validBaseManifest({ priority: 'high' }));

    expect(data).not.toHaveProperty('priority');
  });

  it('accepts a valid manifest with populated assetCategories', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Source', directorySlug: 'source', displayOrder: 0, enabled: true },
        { displayName: 'Exports', directorySlug: 'exports', displayOrder: 1, enabled: false },
      ],
    });
    expect(() => deserializeManifest(manifest)).not.toThrow();
  });

  it('rejects a manifest missing assetCategories', () => {
    const manifest = validBaseManifest();
    delete manifest.assetCategories;
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a manifest with an obsolete "categories" property', () => {
    const manifest = validBaseManifest({ categories: [] });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a manifest with an obsolete "status" property', () => {
    const manifest = validBaseManifest({ status: 'in-progress' });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a non-array assetCategories', () => {
    const manifest = validBaseManifest({ assetCategories: { source: true } });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a category missing required fields', () => {
    const manifest = validBaseManifest({
      assetCategories: [{ displayName: 'Source', directorySlug: 'source', displayOrder: 0 }],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a category with extra fields such as id', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { id: 1, displayName: 'Source', directorySlug: 'source', displayOrder: 0, enabled: true },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects duplicate directory slugs differing only by case', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Source', directorySlug: 'source', displayOrder: 0, enabled: true },
        { displayName: 'SOURCE Again', directorySlug: 'SOURCE', displayOrder: 1, enabled: true },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects an unsafe directory slug', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Bad', directorySlug: 'Not Valid', displayOrder: 0, enabled: true },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a non-boolean enabled value', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Source', directorySlug: 'source', displayOrder: 0, enabled: 'true' },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a negative display order', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Source', directorySlug: 'source', displayOrder: -1, enabled: true },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects duplicate display orders', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Source', directorySlug: 'source', displayOrder: 0, enabled: true },
        { displayName: 'Exports', directorySlug: 'exports', displayOrder: 0, enabled: true },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects sparse display orders', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Source', directorySlug: 'source', displayOrder: 0, enabled: true },
        { displayName: 'Exports', directorySlug: 'exports', displayOrder: 2, enabled: true },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects a non-integer display order', () => {
    const manifest = validBaseManifest({
      assetCategories: [
        { displayName: 'Source', directorySlug: 'source', displayOrder: 0.5, enabled: true },
      ],
    });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
  });

  it('rejects an incorrect (non-integer) project id', () => {
    const manifest = validBaseManifest({ id: 'not-an-id' });
    expect(() => deserializeManifest(manifest)).toThrow(StorageError);
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

// ─── readManifestSync + removeManifestSync (legacy files) ───────────────

describe('manifest file operations', () => {
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-manifest-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── readManifestSync ────────────────────────────────

  describe('readManifestSync', () => {
    it('returns null when no manifest file exists', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 42, 'no-manifest');
      expect(readManifestSync(absPath)).toBeNull();
    });

    it('throws StorageError for invalid JSON', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 42, 'bad-json');
      fs.writeFileSync(path.join(absPath, MANIFEST_FILENAME), 'not json');
      expect(() => readManifestSync(absPath)).toThrow(StorageError);
    });

    it('reads back an existing legacy manifest', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 42, 'read-back');
      const project = makeProject({ id: 42, slug: 'read-back' });
      plantLegacyManifest(absPath, project);

      const result = readManifestSync(absPath);
      expect(result).toBeInstanceOf(Object);
      expect(result.id).toBe(42);
      expect(result.title).toBe('Summer Character Set');
      // Verify camelCase keys
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('updatedAt');
      expect(result).not.toHaveProperty('plannedDate');
      expect(result).not.toHaveProperty('publishedDate');
    });
  });

  // ─── removeManifestSync ──────────────────────────────

  describe('removeManifestSync', () => {
    it('removes an existing manifest file', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 42, 'remove-me');
      const project = makeProject({ id: 42, slug: 'remove-me' });
      plantLegacyManifest(absPath, project);

      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      removeManifestSync(absPath);
      expect(fs.existsSync(manifestPath)).toBe(false);
    });

    it('is a no-op when no manifest exists', () => {
      const { absPath } = createRealProjectDir(projectsRoot, 42, 'noop');
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
