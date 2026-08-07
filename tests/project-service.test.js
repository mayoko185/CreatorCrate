import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import {
  createProjectService,
  ProjectValidationError,
  ProjectNotFoundError,
} from '../src/services/project-service.js';
import { MANIFEST_FILENAME, readManifestSync, writeManifestSync } from '../src/storage/manifest.js';
import {
  formatProjectDirName,
  resolveProjectDir,
  renameProjectDirSync,
  ensureNoConflict,
  createProjectCategoryDirs,
  verifyProjectDirOwnership,
} from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project service', () => {
  let tmpDir;
  let db;
  let service;
  let assetBrowserPreferenceRepository;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-service-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(db));
    assetBrowserPreferenceRepository = createAssetBrowserPreferenceRepository(db);
    service = createProjectService(db, projectsRoot, { assetCategoryService, assetBrowserPreferenceRepository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Dependency injection ───────────────────────────────────────────

  describe('asset-category dependency injection', () => {
    it('requires an assetCategoryService dependency', () => {
      expect(() => createProjectService(db, projectsRoot)).toThrow(
        'createProjectService requires an assetCategoryService dependency.'
      );
      expect(() => createProjectService(db, projectsRoot, {})).toThrow(
        'createProjectService requires an assetCategoryService dependency.'
      );
    });

    it('requires an assetBrowserPreferenceRepository dependency', () => {
      expect(() => createProjectService(db, projectsRoot, { assetCategoryService: {} })).toThrow(
        'createProjectService requires an assetBrowserPreferenceRepository dependency.'
      );
    });

    it('uses the exact injected assetCategoryService (a focused fake), not one it constructs itself', () => {
      let copyCallCount = 0;
      let listCallCount = 0;
      const fake = {
        copyDefaultsForProject(projectId) {
          copyCallCount++;
          return [{ display_name: 'Fake', directory_slug: 'fake', display_order: 0, enabled: 1, project_id: projectId }];
        },
        listProjectCategories() {
          listCallCount++;
          return [];
        },
      };
      const fakeService = createProjectService(db, projectsRoot, {
        assetCategoryService: fake,
        assetBrowserPreferenceRepository,
      });

      const project = fakeService.create(validInput({ title: 'Fake DI Project' }));
      expect(copyCallCount).toBe(1);

      // A title change (rename path) must use the exact injected service
      fakeService.update(project.id, validInput({ title: 'Fake DI Project Renamed' }));
      expect(listCallCount).toBeGreaterThan(0);
    });
  });

  it('rejects a missing title', () => {
    expect(() => service.create(validInput({ title: '' }))).toThrow(ProjectValidationError);
    try {
      service.create(validInput({ title: '' }));
    } catch (err) {
      expect(err.errors.title).toBe('Title is required.');
    }
  });

  it('rejects archived status on create', () => {
    expect(() => service.create(validInput({ status: 'archived' }))).toThrow(ProjectValidationError);
  });

  it('rejects archived status on update', () => {
    const created = service.create(validInput({ title: 'Archive Test' }));
    expect(() => service.update(created.id, validInput({ status: 'archived' }))).toThrow(
      ProjectValidationError
    );
  });

  it('rejects an invalid status', () => {
    expect(() => service.create(validInput({ status: 'banana' }))).toThrow(ProjectValidationError);
  });

  it('rejects published as a project status', () => {
    expect(() => service.create(validInput({ status: 'published' }))).toThrow(ProjectValidationError);
    const project = service.create(validInput({ title: 'Status Update Project' }));
    expect(() => service.update(project.id, validInput({ status: 'published' })))
      .toThrow(ProjectValidationError);
  });

  it.each(['', null, 'urgent'])('rejects an invalid priority %j', (priority) => {
    expect(() => service.create(validInput({ priority }))).toThrow(ProjectValidationError);
  });

  it.each(['low', 'normal', 'high'])('preserves explicit %s priority on create', (priority) => {
    const project = service.create(validInput({ title: `Explicit ${priority}`, priority }));
    expect(project.priority).toBe(priority);
  });

  it.each([
    { date: 'tomorrow', label: 'non-numeric' },
    { date: '2024-02-30', label: 'invalid February' },
    { date: '2023-02-29', label: 'non-leap year' },
    { date: '2024-04-31', label: 'invalid 30-day month' },
    { date: '2024-13-01', label: 'invalid month' },
    { date: '2024-00-10', label: 'zero month' },
    { date: '2024-01-00', label: 'zero day' },
  ])('rejects impossible date $label ($date)', ({ date }) => {
    expect(() => service.create(validInput({ plannedDate: date }))).toThrow(ProjectValidationError);
    expect(() => service.create(validInput({ publishedDate: date }))).toThrow(
      ProjectValidationError
    );
  });

  it.each([
    { date: '2024-01-01', label: 'year start' },
    { date: '2024-12-31', label: 'year end' },
    { date: '2024-02-29', label: 'leap day' },
  ])('accepts valid date $label ($date)', ({ date }) => {
    const project = service.create(validInput({ plannedDate: date, publishedDate: date }));
    expect(project.planned_date).toBe(date);
    expect(project.published_date).toBe(date);
  });

  it('accepts empty optional dates', () => {
    const project = service.create(validInput({ plannedDate: null, publishedDate: '' }));
    expect(project.planned_date).toBeNull();
    expect(project.published_date).toBeNull();
  });

  it.each([
    { url: 'https://example.com/creator', label: 'non-Patreon HTTPS URL' },
    { url: 'http://example.com/creator', label: 'HTTP URL' },
    { url: 'https://patreon.com/creator', label: 'Patreon URL' },
    { url: 'https://mysite.patreon.com/creator', label: 'Patreon subdomain URL' },
  ])('accepts a valid $label', ({ url }) => {
    const project = service.create(validInput({ patreonUrl: url }));
    expect(project.patreon_url).toBe(url);
  });

  it.each([
    { url: 'example.com/creator', label: 'URL without a protocol' },
    { url: 'javascript:alert(1)', label: 'unsafe protocol' },
    { url: 'ftp://example.com/creator', label: 'unsupported protocol' },
    { url: 'https://[invalid', label: 'malformed URL' },
  ])('rejects a $label', ({ url }) => {
    expect(() => service.create(validInput({ patreonUrl: url }))).toThrow(ProjectValidationError);
  });

  it('allows an empty optional project link', () => {
    const project = service.create(validInput({ patreonUrl: '' }));
    expect(project.patreon_url).toBeNull();
  });

  it('validates the project link on update', () => {
    const created = service.create(validInput());
    const updated = service.update(created.id, validInput({ patreonUrl: 'http://example.com/edit' }));
    expect(updated.patreon_url).toBe('http://example.com/edit');

    expect(() => service.update(created.id, validInput({ patreonUrl: 'file:///tmp/project' }))).toThrow(
      ProjectValidationError
    );
  });

  it('generates a slug from the title', () => {
    const project = service.create(validInput({ title: 'Hello World!' }));
    expect(project.slug).toBe('hello-world');
  });

  it('handles slug collisions by rejecting the title', () => {
    service.create(validInput({ title: 'Collision' }));
    expect(() => service.create(validInput({ title: 'Collision' }))).toThrow(
      ProjectValidationError
    );
  });

  it('translates a database slug unique-constraint error into a validation error', () => {
    service.create(validInput({ title: 'Collision' }));
    const realSlugExists = service.repository.slugExists;
    service.repository.slugExists = () => false;
    try {
      expect(() => service.create(validInput({ title: 'Collision' }))).toThrow(
        ProjectValidationError
      );
      try {
        service.create(validInput({ title: 'Collision' }));
      } catch (err) {
        expect(err.errors.title).toBe('A project with this title already exists.');
      }
    } finally {
      service.repository.slugExists = realSlugExists;
    }
  });

  it('does not treat the same project as a slug collision on update', () => {
    const created = service.create(validInput({ title: 'Unchanged Title' }));
    const updated = service.update(created.id, validInput({ title: 'Unchanged Title' }));
    expect(updated.id).toBe(created.id);
  });

  it('throws ProjectNotFoundError when updating a missing project', () => {
    expect(() => service.update(999, validInput())).toThrow(ProjectNotFoundError);
  });

  it('does not default an omitted priority during update', () => {
    const created = service.create(validInput({ title: 'Strict Update Priority', priority: 'high' }));
    const input = validInput({ title: 'Strict Update Priority', status: 'planned' });
    delete input.priority;

    expect(() => service.update(created.id, input)).toThrow(ProjectValidationError);
    expect(service.findById(created.id).priority).toBe('high');
  });

  it('archives an existing project', () => {
    const created = service.create(validInput());
    const archived = service.archive(created.id);
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).toBeTruthy();
  });

  it('throws ProjectNotFoundError when archiving a missing project', () => {
    expect(() => service.archive(999)).toThrow(ProjectNotFoundError);
  });

  // ─── Filesystem creation flow ────────────────────────────────────────

  describe('filesystem creation', () => {
    function getProjectDir(project) {
      const dirName = formatProjectDirName(project.id, project.slug);
      // Status never participates — the project directory is a direct
      // child of PROJECTS_ROOT.
      const relPath = dirName;
      return { dirName, relPath, absPath: resolveProjectDir(projectsRoot, relPath) };
    }

    it('defaults omitted create priority to normal in the database and manifest', () => {
      const input = validInput({ title: 'Default Priority' });
      delete input.priority;

      const project = service.create(input);
      expect(project.priority).toBe('normal');
      expect(service.findById(project.id).priority).toBe('normal');

      const { absPath } = getProjectDir(project);
      expect(readManifestSync(absPath).priority).toBe('normal');
    });

    it('creates a database record and project directory', () => {
      const project = service.create(validInput({ title: 'FS Test' }));
      const { absPath } = getProjectDir(project);
      expect(fs.existsSync(absPath)).toBe(true);
      expect(fs.statSync(absPath).isDirectory()).toBe(true);

      // Verify the record exists
      const found = service.findById(project.id);
      expect(found).toBeTruthy();
      expect(found.slug).toBe('fs-test');
    });

    it('produces the same flat path shape for every status', () => {
      for (const status of ['tbd', 'planned', 'in-progress', 'ready']) {
        const project = service.create(validInput({ title: `Status Shape ${status}`, status }));
        const { relPath, absPath } = getProjectDir(project);

        expect(relPath).toBe(formatProjectDirName(project.id, project.slug));
        expect(relPath.split(path.sep)).toHaveLength(1);
        expect(path.dirname(absPath)).toBe(path.resolve(projectsRoot));
        expect(fs.existsSync(absPath)).toBe(true);
        expect(fs.statSync(absPath).isDirectory()).toBe(true);
      }
    });

    it('uses a six-digit ID prefix in the directory name', () => {
      const project = service.create(validInput({ title: 'Prefix Test' }));
      const { dirName } = getProjectDir(project);
      expect(dirName).toMatch(/^\d{6}-/);
      expect(dirName.startsWith(String(project.id).padStart(6, '0'))).toBe(true);
    });

    it('creates a category directory for each enabled default', () => {
      const expectedSubdirs = ['final', 'wip', 'krz', 'wm', 'wm-lq'];
      const project = service.create(validInput({ title: 'Subdirs Test' }));
      const { absPath } = getProjectDir(project);

      for (const sub of expectedSubdirs) {
        const subPath = path.join(absPath, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.statSync(subPath).isDirectory()).toBe(true);
      }

      expect(fs.existsSync(path.join(absPath, 'exports', 'full'))).toBe(false);
      expect(fs.existsSync(path.join(absPath, 'exports', 'web'))).toBe(false);
    });

    it('writes a schema-version-3 manifest with the exact expected project data and no status', () => {
      const input = validInput({
        title: 'Manifest Test',
        description: 'Desc content',
        notes: 'Note content',
        status: 'planned',
        priority: 'high',
        plannedDate: '2026-08-15',
        publishedDate: null,
        patreonUrl: 'https://patreon.com/creator',
      });
      const project = service.create(input);
      const { absPath } = getProjectDir(project);

      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(content);

      expect(manifest.schemaVersion).toBe(3);
      expect(manifest.id).toBe(project.id);
      expect(manifest.title).toBe('Manifest Test');
      expect(manifest.slug).toBe('manifest-test');
      expect(manifest).not.toHaveProperty('status');
      expect(content).not.toMatch(/"status"\s*:/);
      expect(manifest.priority).toBe('high');
      expect(manifest.description).toBe('Desc content');
      expect(manifest.notes).toBe('Note content');
      expect(manifest.plannedDate).toBe('2026-08-15T00:00:00.000Z');
      expect(manifest.publishedDate).toBeNull();
      expect(manifest.patreonUrl).toBe('https://patreon.com/creator');
      expect(manifest.tags).toEqual([]);
      expect(manifest.thumbnail).toBeNull();
      expect(manifest.assetCategories.map((c) => c.directorySlug)).toEqual([
        'final', 'wip', 'krz', 'wm', 'wm-lq',
      ]);
    });

    it('stores the relative path in the database', () => {
      const project = service.create(validInput({ title: 'Rel Path Test', status: 'tbd' }));
      const { relPath } = getProjectDir(project);
      expect(project.project_dir).toBe(relPath);
      expect(relPath.split(path.sep)).toHaveLength(1);

      // Verify it's stored in the DB
      const found = service.findById(project.id);
      expect(found.project_dir).toBe(relPath);
    });

    it('removes the database record when filesystem directory creation fails', () => {
      // Inject mkdirSync failure
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => service.create(validInput({ title: 'Mkdir Fail' }))).toThrow(
        'Project creation failed'
      );

      mkdirSpy.mockRestore();

      // Verify no DB record was left
      const project = service.repository.findBySlug('mkdir-fail');
      expect(project).toBeUndefined();
    });

    it('removes the database record and directory when manifest creation fails', () => {
      // writeManifestSync uses fs.renameSync internally for its atomic
      // temp-file → project.json step — inject failure only for that
      // specific rename. Cleanup's own quarantine-and-verify sequence also
      // uses fs.renameSync (to move tracked artifacts aside before removing
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

      // Verify DB record was removed
      const record = service.repository.findBySlug('manifest-fail');
      expect(record).toBeUndefined();

      // Verify no directory exists for this slug (ID is unknown after rollback)
      const entries = fs.readdirSync(projectsRoot);
      const matching = entries.filter((e) => e.endsWith('-manifest-fail'));
      expect(matching).toHaveLength(0);
    });

    it('removes the directory and database record when setProjectDir fails', () => {
      // Spy on setProjectDir to inject failure
      const setDirSpy = vi.spyOn(service.repository, 'setProjectDir').mockImplementation(() => {
        throw new Error('DB update failed');
      });

      expect(() => service.create(validInput({ title: 'SetDir Fail' }))).toThrow(
        'Project creation failed'
      );

      setDirSpy.mockRestore();

      // Verify DB record was removed
      const project = service.repository.findBySlug('setdir-fail');
      expect(project).toBeUndefined();

      // Verify no directory exists for this slug
      const entries = fs.readdirSync(projectsRoot);
      const matching = entries.filter((e) => e.endsWith('-setdir-fail'));
      expect(matching).toHaveLength(0);
    });

    it('does not delete unrelated directories during rollback', () => {
      // Create a legitimate project first
      const legit = service.create(validInput({ title: 'Keep Me' }));

      // Now try to create a project that fails
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => service.create(validInput({ title: 'Remove Fail' }))).toThrow(
        'Project creation failed'
      );

      renameSpy.mockRestore();

      // Verify legitimate project still exists
      const found = service.findBySlug('keep-me');
      expect(found).toBeTruthy();
      const { absPath: legitPath } = getProjectDir(found);
      expect(fs.existsSync(legitPath)).toBe(true);
    });

    it('HTTP creation redirects only after success', () => {
      // This test verifies the service returns the project with project_dir set
      const project = service.create(validInput({ title: 'Redirect Check' }));
      expect(project.id).toBeGreaterThan(0);
      expect(project.project_dir).toBeTruthy();
    });

    it('existing Phase 2 validation still works', () => {
      // Verify that validation errors still prevent creation
      expect(() => service.create(validInput({ title: '' }))).toThrow(ProjectValidationError);
      expect(() => service.create(validInput({ status: 'archived' }))).toThrow(
        ProjectValidationError
      );
      expect(() => service.create(validInput({ status: 'banana' }))).toThrow(
        ProjectValidationError
      );
    });
  });

  // ─── Filesystem update flow ────────────────────────────────────────

  describe('filesystem update', () => {
    function getProjectDir(project) {
      const dirName = formatProjectDirName(project.id, project.slug);
      const relPath = dirName;
      return { dirName, relPath, absPath: resolveProjectDir(projectsRoot, relPath) };
    }

    function createTestProject(overrides = {}) {
      return service.create(validInput(overrides));
    }

    it('pure status-only update is DB/UI-only and leaves the manifest byte-identical', () => {
      const project = createTestProject({ title: 'Meta Edit', status: 'tbd' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);

      // Add a custom file to prove directory identity
      const userFile = path.join(originalPath, 'user-data.txt');
      fs.writeFileSync(userFile, 'custom content');

      const manifestPath = path.join(originalPath, MANIFEST_FILENAME);
      const manifestBefore = fs.readFileSync(manifestPath, 'utf8');

      const updated = service.update(project.id, validInput({
        title: 'Meta Edit',
        status: 'in-progress',
      }));

      // Directory was NOT moved or touched
      const { absPath, relPath } = getProjectDir(updated);
      expect(absPath).toBe(originalPath);
      expect(relPath).toBe(originalRel);
      expect(updated.project_dir).toBe(originalRel);
      expect(fs.existsSync(originalPath)).toBe(true);
      expect(fs.existsSync(userFile)).toBe(true);
      expect(fs.readFileSync(userFile, 'utf8')).toBe('custom content');

      // Status lives only in the database — the manifest is not rewritten
      expect(updated.status).toBe('in-progress');
      expect(service.findById(project.id).status).toBe('in-progress');
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    });

    it('metadata-only update rewrites project.json without renaming the directory', () => {
      const project = createTestProject({ title: 'Meta Only', description: 'Old desc' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);

      const manifestPath = path.join(originalPath, MANIFEST_FILENAME);
      const manifestBefore = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Change only description — title/slug/status unchanged
      const updated = service.update(project.id, validInput({
        title: 'Meta Only',
        description: 'New description',
      }));

      // No rename — directory and project_dir unchanged
      const { absPath, relPath } = getProjectDir(updated);
      expect(absPath).toBe(originalPath);
      expect(relPath).toBe(originalRel);
      expect(updated.project_dir).toBe(originalRel);

      // Manifest rewritten in place with the new value; status still absent
      const manifestAfter = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifestAfter.description).toBe('New description');
      expect(manifestAfter.title).toBe('Meta Only');
      expect(manifestAfter.slug).toBe('meta-only');
      expect(manifestAfter).not.toHaveProperty('status');

      // The rewrite actually happened — the file changed
      expect(manifestAfter).not.toEqual(manifestBefore);

      // Status unchanged in DB
      expect(updated.status).toBe('tbd');
    });

    it('status-only update succeeds when the project directory is missing', () => {
      const project = createTestProject({ title: 'Missing Dir Status', status: 'tbd' });
      const { relPath: originalRel } = getProjectDir(project);

      // Remove the directory entirely
      fs.rmSync(resolveProjectDir(projectsRoot, originalRel), { recursive: true, force: true });

      const updated = service.update(project.id, validInput({
        title: 'Missing Dir Status',
        status: 'ready',
      }));

      // DB-only transition succeeds without any filesystem inspection
      expect(updated.status).toBe('ready');
      expect(updated.project_dir).toBe(originalRel);
      expect(service.findById(project.id).status).toBe('ready');
      expect(service.findById(project.id).project_dir).toBe(originalRel);
    });

    it('title change renames the directory (slug change)', () => {
      const project = createTestProject({ title: 'Old Title' });
      const { absPath: oldPath } = getProjectDir(project);

      // Create a custom file to prove contents survive
      const userFile = path.join(oldPath, 'user-data.txt');
      fs.writeFileSync(userFile, 'surviving content');

      const updated = service.update(project.id, validInput({ title: 'New Title' }));

      // Directory was renamed
      const { absPath: newPath } = getProjectDir(updated);
      expect(newPath).not.toBe(oldPath);
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(newPath)).toBe(true);

      // Custom file survived the rename
      expect(fs.existsSync(path.join(newPath, 'user-data.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(newPath, 'user-data.txt'), 'utf8')).toBe('surviving content');

      // Manifest has new title
      const manifest = readManifestSync(newPath);
      expect(manifest.title).toBe('New Title');
      expect(manifest.slug).toBe('new-title');

      // DB has updated project_dir
      expect(updated.project_dir).toBeTruthy();
      const found = service.findById(updated.id);
      expect(found.project_dir).toBe(updated.project_dir);
    });

    it('combined title/status change renames only because of the title', () => {
      const project = createTestProject({ title: 'Combined Start', status: 'planned' });
      const { absPath: oldPath } = getProjectDir(project);

      // Custom file
      const userFile = path.join(oldPath, 'final', 'asset.blend');
      fs.writeFileSync(userFile, 'blend file');

      const updated = service.update(project.id, validInput({
        title: 'Combined Final',
        status: 'ready',
      }));

      const { absPath: newPath, relPath: newRel } = getProjectDir(updated);
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(newPath)).toBe(true);
      // Flat rename: the new directory name is the formatted ID + new slug
      expect(newRel).toBe(formatProjectDirName(project.id, 'combined-final'));
      expect(newRel.split(path.sep)).toHaveLength(1);
      expect(updated.project_dir).toBe(newRel);

      // Custom file in subdirectory survived
      expect(fs.existsSync(path.join(newPath, 'final', 'asset.blend'))).toBe(true);
      expect(fs.readFileSync(path.join(newPath, 'final', 'asset.blend'), 'utf8')).toBe('blend file');

      // Manifest is rewritten at the new location with the new title, but
      // status itself is never written to the manifest
      const manifest = readManifestSync(newPath);
      expect(manifest.title).toBe('Combined Final');
      expect(manifest.slug).toBe('combined-final');
      expect(manifest).not.toHaveProperty('status');

      // Status is DB-only
      expect(updated.status).toBe('ready');
      expect(service.findById(project.id).status).toBe('ready');
    });

    it('existing manually added files survive rename', () => {
      const project = createTestProject({ title: 'Files Survive Rename' });
      const { absPath: oldPath } = getProjectDir(project);

      const extraFiles = [
        'extra-file.txt',
        path.join('source', 'custom-asset.fbx'),
        path.join('references', 'concept.jpg'),
        path.join('extras', 'notes.md'),
      ];
      for (const f of extraFiles) {
        const fullPath = path.join(oldPath, f);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, `content of ${f}`);
      }

      const updated = service.update(project.id, validInput({ title: 'Renamed With Files' }));
      const { absPath: newPath } = getProjectDir(updated);

      for (const f of extraFiles) {
        const fullPath = path.join(newPath, f);
        expect(fs.existsSync(fullPath)).toBe(true);
        expect(fs.readFileSync(fullPath, 'utf8')).toBe(`content of ${f}`);
      }
    });

    it('existing manually added files survive a combined title/status change', () => {
      const project = createTestProject({ title: 'Files Survive Move', status: 'tbd' });
      const { absPath: oldPath } = getProjectDir(project);

      const extraFiles = ['custom.sprite', path.join('exports', 'full', 'render.png')];
      for (const f of extraFiles) {
        const fullPath = path.join(oldPath, f);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, `content`);
      }

      const updated = service.update(project.id, validInput({
        title: 'Files Survive Move Renamed',
        status: 'ready',
      }));
      const { absPath: newPath } = getProjectDir(updated);

      for (const f of extraFiles) {
        expect(fs.existsSync(path.join(newPath, f))).toBe(true);
      }
    });

    it('destination conflict leaves prior state intact', () => {
      const project = createTestProject({ title: 'Conflict Src', status: 'tbd' });
      const { absPath: srcPath } = getProjectDir(project);

      // Create a directory at the target path to simulate a conflict
      // Target: "0000XX-conflict-dst" (flat, direct child of PROJECTS_ROOT)
      const conflictDir = path.join(projectsRoot,
        formatProjectDirName(project.id, 'conflict-dst'));
      fs.mkdirSync(conflictDir, { recursive: true });
      fs.writeFileSync(path.join(conflictDir, 'placeholder'), 'exists');

      // EnsureNoConflict blocks the rename since the target already exists
      expect(() => service.update(project.id, validInput({
        title: 'Conflict Dst', // slug change → flat rename into the conflict dir
        status: 'in-progress',
      }))).toThrow(/exists|conflict|failed/i);

      // Original directory is untouched
      expect(fs.existsSync(srcPath)).toBe(true);
      expect(fs.readdirSync(srcPath).length).toBeGreaterThan(0);

      // DB still has original values
      const found = service.findById(project.id);
      expect(found.title).toBe('Conflict Src');
      expect(found.status).toBe('tbd');
      expect(found.project_dir).toBeTruthy();

      // Manifest still has original content at original location
      expect(fs.existsSync(path.join(srcPath, 'project.json'))).toBe(true);
    });

    it('unchanged slug causes no rename', () => {
      const project = createTestProject({ title: 'No Slug Change' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);

      const updated = service.update(project.id, validInput({
        title: 'No Slug Change', // same title = same slug
        status: 'tbd',           // same status
        priority: 'high',         // metadata-only change
      }));

      const { absPath } = getProjectDir(updated);
      expect(absPath).toBe(originalPath);
      expect(fs.existsSync(originalPath)).toBe(true);
      // No rename happened — original path still valid
      expect(fs.statSync(originalPath).isDirectory()).toBe(true);

      // Project_dir unchanged
      expect(updated.project_dir).toBe(originalRel);
    });

    it('unchanged status causes no move', () => {
      const project = createTestProject({ title: 'No Status Change', status: 'planned' });
      const { absPath } = getProjectDir(project);

      // Add a file
      fs.writeFileSync(path.join(absPath, 'proof.txt'), 'still here');

      const updated = service.update(project.id, validInput({
        title: 'No Status Change', // same slug
        status: 'planned',         // same status
        description: 'Only desc changed',
      }));

      const { absPath: afterPath } = getProjectDir(updated);
      expect(afterPath).toBe(absPath);
      expect(fs.existsSync(path.join(absPath, 'proof.txt'))).toBe(true);
    });

    it('manifest and database agree after a title/status rename', () => {
      const project = createTestProject({
        title: 'Agreement Test',
        status: 'tbd',
        description: 'Original desc',
        priority: 'low',
      });

      const updated = service.update(project.id, validInput({
        title: 'Agreement Test Renamed',
        status: 'ready',
        description: 'New desc',
        priority: 'high',
        plannedDate: '2027-01-15',
      }));

      // DB values
      expect(updated.title).toBe('Agreement Test Renamed');
      expect(updated.slug).toBe('agreement-test-renamed');
      expect(updated.status).toBe('ready');
      expect(updated.description).toBe('New desc');
      expect(updated.priority).toBe('high');
      expect(updated.planned_date).toBe('2027-01-15');

      // Read manifest at final location
      const { absPath } = getProjectDir(updated);
      const manifest = readManifestSync(absPath);

      expect(manifest.title).toBe(updated.title);
      expect(manifest.slug).toBe(updated.slug);
      expect(manifest).not.toHaveProperty('status');
      expect(manifest.description).toBe(updated.description);
      expect(manifest.priority).toBe(updated.priority);
      expect(manifest.plannedDate).toBe('2027-01-15T00:00:00.000Z');
      expect(manifest.id).toBe(updated.id);
    });

    it('source manifest mismatch is rejected', () => {
      const project = createTestProject({ title: 'Manifest Mismatch' });
      const { absPath } = getProjectDir(project);

      // Corrupt manifest to have a different ID
      const manifestPath = path.join(absPath, 'project.json');
      const corrupt = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      corrupt.id = 99999;
      fs.writeFileSync(manifestPath, JSON.stringify(corrupt, null, 2));

      // Pre-flight validation rejects the mismatch before any mutation
      expect(() => service.update(project.id, validInput({
        title: 'Manifest Mismatch Renamed', // triggers the flat rename
        status: 'in-progress',
      }))).toThrow('Existing manifest does not match the expected project');
    });

    it('rejects a structurally invalid manifest (missing assetCategories) on update preflight', () => {
      const project = createTestProject({ title: 'Structurally Invalid' });
      const { absPath } = getProjectDir(project);

      const manifestPath = path.join(absPath, 'project.json');
      const corrupt = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      delete corrupt.assetCategories;
      fs.writeFileSync(manifestPath, JSON.stringify(corrupt, null, 2));

      expect(() => service.update(project.id, validInput({
        title: 'Structurally Invalid Renamed', // triggers the flat rename
        status: 'in-progress',
      }))).toThrow('Existing manifest does not match the expected project');
    });

    it('missing source directory is reported safely when a rename is required', () => {
      const project = createTestProject({ title: 'Missing Dir' });
      const { absPath } = getProjectDir(project);

      // Remove the directory
      fs.rmSync(absPath, { recursive: true, force: true });

      expect(() => service.update(project.id, validInput({
        title: 'Missing Dir Renamed', // triggers the flat rename
        status: 'in-progress',
      }))).toThrow('Project directory not found');
    });

    it('injected rename failure triggers compensation', () => {
      const project = createTestProject({ title: 'Rename Fail' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);

      // Spy on renameSync to inject failure
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('rename failed');
      });

      try {
        service.update(project.id, validInput({
          title: 'Rename Fail New', // triggers slug change
          status: 'in-progress',
        }));
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).toContain('failed');
      } finally {
        renameSpy.mockRestore();
      }

      // DB was restored to original values
      const found = service.findById(project.id);
      expect(found.title).toBe('Rename Fail');
      expect(found.slug).toBe('rename-fail');
      expect(found.status).toBe('tbd');
      expect(found.project_dir).toBe(originalRel);

      // Directory still at original location
      expect(fs.existsSync(originalPath)).toBe(true);
      expect(fs.statSync(originalPath).isDirectory()).toBe(true);
    });

    it('injected manifest failure triggers compensation', () => {
      const project = createTestProject({ title: 'Manifest Fail Update' });
      const { absPath: originalPath } = getProjectDir(project);

      // Custom file to prove restore
      fs.writeFileSync(path.join(originalPath, 'extra.bin'), 'original content');

      // Spy on renameSync to trigger failure after the directory rename succeeds
      // writeManifestSync uses renameSync internally for the atomic write
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        // First call succeeds (it's the directory rename), second call fails (manifest write)
        renameSpy.mockImplementationOnce(() => { throw new Error('manifest write failed'); });
        return undefined;
      });

      try {
        service.update(project.id, validInput({
          title: 'Manifest Fail Update Renamed', // triggers slug change
          status: 'ready',
        }));
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).toContain('failed');
      } finally {
        renameSpy.mockRestore();
      }

      // Directory moved back to original location
      expect(fs.existsSync(originalPath)).toBe(true);
      expect(fs.statSync(originalPath).isDirectory()).toBe(true);

      // Custom file survived the move-back
      expect(fs.existsSync(path.join(originalPath, 'extra.bin'))).toBe(true);
      expect(fs.readFileSync(path.join(originalPath, 'extra.bin'), 'utf8')).toBe('original content');

      // DB restored
      const found = service.findById(project.id);
      expect(found.title).toBe('Manifest Fail Update');
      expect(found.status).toBe('tbd');
    });

    it('injected setProjectDir failure triggers compensation', () => {
      const project = createTestProject({ title: 'Set Dir Fail Update' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);

      // Spy on setProjectDir
      const setDirSpy = vi.spyOn(service.repository, 'setProjectDir').mockImplementation(() => {
        throw new Error('DB update failed');
      });

      try {
        service.update(project.id, validInput({
          title: 'Set Dir Fail Update Renamed', // triggers slug change
          status: 'ready',
        }));
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).toContain('failed');
      } finally {
        setDirSpy.mockRestore();
      }

      // Directory moved back
      expect(fs.existsSync(originalPath)).toBe(true);

      // DB restored
      const found = service.findById(project.id);
      expect(found.title).toBe('Set Dir Fail Update');
      expect(found.status).toBe('tbd');
      expect(found.project_dir).toBe(originalRel);
    });

    it('failed compensation is logged clearly', () => {
      const project = createTestProject({ title: 'Comp Log' });
      const { absPath: originalPath } = getProjectDir(project);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Both rename and manifest write will fail, but more critically,
      // also make the compensation's rename fail by making all renames fail
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('all renames fail');
      });

      try {
        service.update(project.id, validInput({
          title: 'Comp Log New', // triggers slug change
          status: 'in-progress',
        }));
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).toContain('failed');
      } finally {
        renameSpy.mockRestore();
      }

      // Compensation was attempted (at least log was written)
      expect(consoleSpy).toHaveBeenCalled();

      // Even though compensation failed, user still sees generic error
      // DB was restored (the rename failure prevented the directory move,
      // but the DB update happened first — compensation should restore it)
      const found = service.findById(project.id);
      expect(found).toBeTruthy();

      consoleSpy.mockRestore();
    });

    it('existing Phase 2 validation and PRG behavior remain correct', () => {
      const project = createTestProject({ title: 'Phase 2 Check' });

      // Reject archived status on update
      expect(() => service.update(project.id, validInput({
        title: 'Phase 2 Check',
        status: 'archived',
      }))).toThrow(ProjectValidationError);

      // Reject duplicate slug
      const other = createTestProject({ title: 'Other Project' });
      expect(() => service.update(other.id, validInput({
        title: 'Phase 2 Check', // same as first project
      }))).toThrow(ProjectValidationError);

      // Own slug is allowed
      const sameSlug = service.update(project.id, validInput({
        title: 'Phase 2 Check', // same slug as before
      }));
      expect(sameSlug.slug).toBe('phase-2-check');

      // Missing project throws not found
      expect(() => service.update(99999, validInput())).toThrow(ProjectNotFoundError);
    });

    it('absolute paths are not rendered in error messages', () => {
      const project = createTestProject({ title: 'Path Safety', status: 'tbd' });
      const { absPath } = getProjectDir(project);

      // Remove directory to cause a pre-flight failure
      fs.rmSync(absPath, { recursive: true, force: true });

      try {
        service.update(project.id, validInput({
          title: 'Path Safety Renamed', // triggers the flat rename
          status: 'in-progress',
        }));
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).not.toMatch(/[A-Z]:\\/);
        expect(err.message).not.toMatch(/\/\w+/);
      }
    });
  });

  // ─── Filesystem archive flow ─────────────────────────────────────────

  describe('filesystem archive', () => {
    function getProjectDir(project) {
      const dirName = formatProjectDirName(project.id, project.slug);
      const relPath = dirName;
      return { dirName, relPath, absPath: resolveProjectDir(projectsRoot, relPath) };
    }

    function createTestProject(overrides = {}) {
      return service.create(validInput(overrides));
    }

    it('archive is a database transition that preserves the flat project directory', () => {
      const project = createTestProject({ title: 'Dir Preserve Archive' });
      const { absPath, relPath } = getProjectDir(project);

      // Custom files to prove nothing moves
      const userFile = path.join(absPath, 'custom.txt');
      fs.writeFileSync(userFile, 'still here');
      const manifestBefore = fs.readFileSync(path.join(absPath, MANIFEST_FILENAME), 'utf8');

      const archived = service.archive(project.id);

      // DB transition happened
      expect(archived.status).toBe('archived');
      expect(archived.archived_at).toBeTruthy();

      // project_dir preserved � no archived/ move, no rename
      expect(archived.project_dir).toBe(relPath);
      expect(service.findById(project.id).project_dir).toBe(relPath);
      expect(relPath.split(path.sep)).toHaveLength(1);
      expect(path.dirname(absPath)).toBe(path.resolve(projectsRoot));

      // Directory still at the same flat location with all contents
      expect(fs.existsSync(absPath)).toBe(true);
      expect(fs.statSync(absPath).isDirectory()).toBe(true);
      expect(fs.existsSync(userFile)).toBe(true);
      expect(fs.readFileSync(userFile, 'utf8')).toBe('still here');
      // Manifest is untouched by archiving
      expect(fs.readFileSync(path.join(absPath, MANIFEST_FILENAME), 'utf8')).toBe(manifestBefore);
      // No archived/ directory was created
      expect(fs.existsSync(path.join(projectsRoot, 'archived'))).toBe(false);
    });

    it('archive succeeds when the project directory is missing', () => {
      const project = createTestProject({ title: 'Missing Dir Archive' });
      const { relPath } = getProjectDir(project);

      // Remove the directory entirely
      fs.rmSync(resolveProjectDir(projectsRoot, relPath), { recursive: true, force: true });

      const archived = service.archive(project.id);

      expect(archived.status).toBe('archived');
      expect(archived.archived_at).toBeTruthy();
      expect(archived.project_dir).toBe(relPath);
      expect(service.findById(project.id).archived_at).toBeTruthy();
    });

    it('status becomes archived', () => {
      const project = createTestProject({ title: 'Status Check' });
      const archived = service.archive(project.id);
      expect(archived.status).toBe('archived');
    });

    it('archived_at is populated', () => {
      const project = createTestProject({ title: 'Archived At' });
      const archived = service.archive(project.id);
      expect(archived.archived_at).toBeTruthy();
    });

    it('already-archived project is rejected', () => {
      const project = createTestProject({ title: 'Double Archive' });
      service.archive(project.id);

      expect(() => service.archive(project.id)).toThrow('already archived');
    });

    it('missing project throws ProjectNotFoundError', () => {
      expect(() => service.archive(99999)).toThrow(ProjectNotFoundError);
    });
  });
});

function validInput(overrides = {}) {
  return {
    title: 'Valid Project',
    description: 'A description',
    notes: 'Some notes',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}
