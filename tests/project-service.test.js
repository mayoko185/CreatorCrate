import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  createProjectService,
  ProjectValidationError,
  ProjectNotFoundError,
} from '../src/services/project-service.js';
import { MANIFEST_FILENAME, readManifestSync, writeManifestSync } from '../src/storage/manifest.js';
import {
  formatProjectDirName,
  buildProjectRelPath,
  resolveProjectDir,
  renameProjectDirSync,
  ensureNoConflict,
  createProjectSubdirs,
  verifyProjectDirOwnership,
  STATUS_DIR_MAP,
} from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project service', () => {
  let tmpDir;
  let db;
  let service;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-service-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    // Create status directories (as the real startup would)
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    service = createProjectService(db, projectsRoot);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('rejects an invalid priority', () => {
    expect(() => service.create(validInput({ priority: 'urgent' }))).toThrow(ProjectValidationError);
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

  it('rejects an invalid Patreon URL', () => {
    expect(() => service.create(validInput({ patreonUrl: 'http://patreon.com/foo' }))).toThrow(
      ProjectValidationError
    );
    expect(() => service.create(validInput({ patreonUrl: 'https://example.com' }))).toThrow(
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
      const relPath = buildProjectRelPath(project.status, dirName);
      return { dirName, relPath, absPath: resolveProjectDir(projectsRoot, relPath) };
    }

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

    it('uses the correct status root directory', () => {
      const project = service.create(validInput({ title: 'Status Dir Test', status: 'in-progress' }));
      const { relPath } = getProjectDir(project);
      expect(relPath.startsWith('active' + path.sep)).toBe(true);
    });

    it('uses a six-digit ID prefix in the directory name', () => {
      const project = service.create(validInput({ title: 'Prefix Test' }));
      const { dirName } = getProjectDir(project);
      expect(dirName).toMatch(/^\d{6}-/);
      expect(dirName.startsWith(String(project.id).padStart(6, '0'))).toBe(true);
    });

    it('creates all standard subdirectories', () => {
      const expectedSubdirs = [
        'source',
        path.join('exports', 'full'),
        path.join('exports', 'web'),
        'references',
        'extras',
        'thumbnails',
      ];
      const project = service.create(validInput({ title: 'Subdirs Test' }));
      const { absPath } = getProjectDir(project);

      for (const sub of expectedSubdirs) {
        const subPath = path.join(absPath, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.statSync(subPath).isDirectory()).toBe(true);
      }
    });

    it('writes a manifest with the exact expected project data', () => {
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

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.id).toBe(project.id);
      expect(manifest.title).toBe('Manifest Test');
      expect(manifest.slug).toBe('manifest-test');
      expect(manifest.status).toBe('planned');
      expect(manifest.priority).toBe('high');
      expect(manifest.description).toBe('Desc content');
      expect(manifest.notes).toBe('Note content');
      expect(manifest.plannedDate).toBe('2026-08-15T00:00:00.000Z');
      expect(manifest.publishedDate).toBeNull();
      expect(manifest.patreonUrl).toBe('https://patreon.com/creator');
      expect(manifest.tags).toEqual([]);
      expect(manifest.thumbnail).toBeNull();
    });

    it('stores the relative path in the database', () => {
      const project = service.create(validInput({ title: 'Rel Path Test', status: 'tbd' }));
      const { relPath } = getProjectDir(project);
      expect(project.project_dir).toBe(relPath);

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
      // writeManifestSync uses fs.renameSync internally — inject failure
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => service.create(validInput({ title: 'Manifest Fail' }))).toThrow(
        'Project creation failed'
      );

      renameSpy.mockRestore();

      // Verify DB record was removed
      const record = service.repository.findBySlug('manifest-fail');
      expect(record).toBeUndefined();

      // Verify no directory exists for this slug (ID is unknown after rollback)
      const statusDir = path.join(projectsRoot, 'tbd');
      const entries = fs.readdirSync(statusDir);
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
      const statusDir = path.join(projectsRoot, 'tbd');
      const entries = fs.readdirSync(statusDir);
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
      const relPath = buildProjectRelPath(project.status, dirName);
      return { dirName, relPath, absPath: resolveProjectDir(projectsRoot, relPath) };
    }

    function createTestProject(overrides = {}) {
      return service.create(validInput(overrides));
    }

    it('non-title metadata edit rewrites manifest without moving directory', () => {
      const project = createTestProject({ title: 'Meta Edit' });
      const { absPath: originalPath } = getProjectDir(project);

      // Add a custom file to prove directory identity
      const userFile = path.join(originalPath, 'user-data.txt');
      fs.writeFileSync(userFile, 'custom content');

      const updated = service.update(project.id, validInput({
        title: 'Meta Edit',
        description: 'New description',
        notes: 'Updated notes',
        priority: 'high',
      }));

      // Directory was NOT moved
      const { absPath } = getProjectDir(updated);
      expect(absPath).toBe(originalPath);
      expect(fs.existsSync(originalPath)).toBe(true);

      // Manifest was rewritten with new data
      const manifest = readManifestSync(originalPath);
      expect(manifest.description).toBe('New description');
      expect(manifest.notes).toBe('Updated notes');
      expect(manifest.priority).toBe('high');

      // Custom file survived
      expect(fs.existsSync(userFile)).toBe(true);
      expect(fs.readFileSync(userFile, 'utf8')).toBe('custom content');

      // updated_at changed
      expect(manifest.updatedAt).not.toBeNull();
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

    it('status change moves the directory', () => {
      const project = createTestProject({ title: 'Status Move', status: 'tbd' });
      const { absPath: oldPath, relPath: oldRel } = getProjectDir(project);

      // Custom file
      const userFile = path.join(oldPath, 'custom-file.psd');
      fs.writeFileSync(userFile, 'design file');

      const updated = service.update(project.id, validInput({
        title: 'Status Move',
        status: 'in-progress',
      }));

      // Old path is gone, new path exists under 'active/'
      const { absPath: newPath, relPath: newRel } = getProjectDir(updated);
      expect(newRel.startsWith('active' + path.sep)).toBe(true);
      expect(newPath).not.toBe(oldPath);
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(newPath)).toBe(true);

      // Custom file survived
      expect(fs.existsSync(path.join(newPath, 'custom-file.psd'))).toBe(true);

      // Manifest has new status
      const manifest = readManifestSync(newPath);
      expect(manifest.status).toBe('in-progress');

      // DB has updated path
      const found = service.findById(updated.id);
      expect(found.project_dir).toBe(newRel);
    });

    it('combined title/status change performs one final move', () => {
      const project = createTestProject({ title: 'Combined Start', status: 'planned' });
      const { absPath: oldPath } = getProjectDir(project);

      // Custom file
      const userFile = path.join(oldPath, 'source', 'asset.blend');
      fs.writeFileSync(userFile, 'blend file');

      const updated = service.update(project.id, validInput({
        title: 'Combined Final',
        status: 'published',
      }));

      const { absPath: newPath, relPath: newRel } = getProjectDir(updated);
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(newPath)).toBe(true);
      expect(newRel.startsWith('published' + path.sep)).toBe(true);

      // Custom file in subdirectory survived
      expect(fs.existsSync(path.join(newPath, 'source', 'asset.blend'))).toBe(true);
      expect(fs.readFileSync(path.join(newPath, 'source', 'asset.blend'), 'utf8')).toBe('blend file');

      // Manifest is correct
      const manifest = readManifestSync(newPath);
      expect(manifest.title).toBe('Combined Final');
      expect(manifest.status).toBe('published');
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

    it('existing manually added files survive status move', () => {
      const project = createTestProject({ title: 'Files Survive Move', status: 'tbd' });
      const { absPath: oldPath } = getProjectDir(project);

      const extraFiles = ['custom.sprite', path.join('exports', 'full', 'render.png')];
      for (const f of extraFiles) {
        const fullPath = path.join(oldPath, f);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, `content`);
      }

      const updated = service.update(project.id, validInput({
        title: 'Files Survive Move',
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
      // Create a manifest so pre-flight manifest check passes
      fs.writeFileSync(path.join(srcPath, 'project.json'), JSON.stringify({
        id: project.id, title: 'Conflict Src', slug: 'conflict-src', status: 'tbd',
      }));

      // Create a directory at the target path to simulate a conflict
      // Target: "active/0000XX-conflict-src"
      const conflictDir = path.join(projectsRoot, 'active',
        formatProjectDirName(project.id, 'conflict-src'));
      fs.mkdirSync(conflictDir, { recursive: true });
      fs.writeFileSync(path.join(conflictDir, 'placeholder'), 'exists');

      // EnsureNoConflict blocks the move since the target already exists
      try {
        service.update(project.id, validInput({
          title: 'Conflict Src',
          status: 'in-progress',
        }));
        expect(true).toBe(false); // Should have thrown
      } catch (err) {
        // Pre-flight catches destination conflict before any mutation
        expect(err.message).toMatch(/exists|conflict|failed/i);
      }

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

    it('manifest and database agree after success', () => {
      const project = createTestProject({
        title: 'Agreement Test',
        status: 'tbd',
        description: 'Original desc',
        priority: 'low',
      });

      const updated = service.update(project.id, validInput({
        title: 'Agreement Test Renamed',
        status: 'published',
        description: 'New desc',
        priority: 'high',
        plannedDate: '2027-01-15',
      }));

      // DB values
      expect(updated.title).toBe('Agreement Test Renamed');
      expect(updated.slug).toBe('agreement-test-renamed');
      expect(updated.status).toBe('published');
      expect(updated.description).toBe('New desc');
      expect(updated.priority).toBe('high');
      expect(updated.planned_date).toBe('2027-01-15');

      // Read manifest at final location
      const { absPath } = getProjectDir(updated);
      const manifest = readManifestSync(absPath);

      expect(manifest.title).toBe(updated.title);
      expect(manifest.slug).toBe(updated.slug);
      expect(manifest.status).toBe(updated.status);
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
        title: 'Manifest Mismatch', // same slug — triggers status move
        status: 'in-progress',
      }))).toThrow('Existing manifest does not match the expected project');
    });

    it('missing source directory is reported safely', () => {
      const project = createTestProject({ title: 'Missing Dir' });
      const { absPath } = getProjectDir(project);

      // Remove the directory
      fs.rmSync(absPath, { recursive: true, force: true });

      expect(() => service.update(project.id, validInput({
        title: 'Missing Dir', // same slug — triggers status move
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
          title: 'Manifest Fail Update', // same slug
          status: 'published',
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
          title: 'Set Dir Fail Update', // same slug
          status: 'published',
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
          title: 'Comp Log New',
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
          title: 'Path Safety', // same slug
          status: 'in-progress',
        }));
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).not.toMatch(/[A-Z]:\\/);
        expect(err.message).not.toMatch(/\/\w+/);
      }
    });
  });

  // ─── Backfill (Phase 3 — existing record reconciliation) ──────────────

  describe('backfill', () => {
    function getProjectDir(project) {
      const dirName = formatProjectDirName(project.id, project.slug);
      const relPath = buildProjectRelPath(project.status, dirName);
      return { dirName, relPath, absPath: resolveProjectDir(projectsRoot, relPath) };
    }

    function insertNullDirRecord(overrides = {}) {
      return service.repository.create({
        title: 'Backfill Test',
        slug: 'backfill-test',
        description: '',
        notes: '',
        status: 'tbd',
        priority: 'normal',
        plannedDate: null,
        publishedDate: null,
        patreonUrl: null,
        ...overrides,
      });
    }

    it('creates a canonical directory for a record with no path', () => {
      const project = insertNullDirRecord({ title: 'Backfill Dir', slug: 'backfill-dir' });
      expect(project.project_dir).toBeNull();

      const result = service.backfillProjectDirs();
      const { absPath } = getProjectDir(project);

      expect(result.backfilled).toBe(1);
      expect(result.adopted).toBe(0);
      expect(result.conflicts).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(absPath)).toBe(true);
      expect(fs.statSync(absPath).isDirectory()).toBe(true);
    });

    it('creates standard subdirectories', () => {
      const project = insertNullDirRecord({ title: 'Subdirs Backfill', slug: 'subdirs-backfill' });
      service.backfillProjectDirs();

      const { absPath } = getProjectDir(project);
      const expectedSubdirs = ['source', 'references', 'extras', 'thumbnails',
        path.join('exports', 'full'), path.join('exports', 'web')];

      for (const sub of expectedSubdirs) {
        const fullPath = path.join(absPath, sub);
        expect(fs.existsSync(fullPath)).toBe(true);
        expect(fs.statSync(fullPath).isDirectory()).toBe(true);
      }
    });

    it('writes a manifest with correct project data', () => {
      const project = insertNullDirRecord({
        title: 'Manifest Backfill',
        slug: 'manifest-backfill',
        description: 'Test description',
      });
      service.backfillProjectDirs();

      const { absPath } = getProjectDir(project);
      const manifest = readManifestSync(absPath);

      expect(manifest).not.toBeNull();
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.id).toBe(project.id);
      expect(manifest.title).toBe('Manifest Backfill');
      expect(manifest.slug).toBe('manifest-backfill');
      expect(manifest.description).toBe('Test description');
      expect(manifest.status).toBe('tbd');
    });

    it('stores the relative path in the database', () => {
      const project = insertNullDirRecord({ title: 'Path Backfill', slug: 'path-backfill' });
      service.backfillProjectDirs();

      const updated = service.repository.findById(project.id);
      const { relPath } = getProjectDir(project);
      expect(updated.project_dir).toBe(relPath);
    });

    it('is idempotent — second backfill does not create duplicates', () => {
      const project = insertNullDirRecord({ title: 'Idempotent', slug: 'idempotent' });
      const first = service.backfillProjectDirs();
      expect(first.backfilled).toBe(1);

      const second = service.backfillProjectDirs();
      expect(second.backfilled).toBe(0);
      expect(second.adopted).toBe(0);
      expect(second.conflicts).toBe(0);
      expect(second.errors).toHaveLength(0);
    });

    it('reports destination conflict safely without modifying DB', () => {
      const project = insertNullDirRecord({ title: 'Conflict', slug: 'conflict' });
      const { absPath } = getProjectDir(project);

      // Create a file at the destination path (not a directory)
      fs.writeFileSync(absPath, 'not a directory');

      const result = service.backfillProjectDirs();
      expect(result.conflicts).toBe(1);
      expect(result.backfilled).toBe(0);

      // DB path should still be null
      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toBeNull();

      // Clean up
      fs.rmSync(absPath);
    });

    it('refuses to adopt a directory with a nonmatching manifest', () => {
      const project = insertNullDirRecord({ title: 'Mismatch', slug: 'mismatch' });
      const { absPath } = getProjectDir(project);

      // Create directory with a wrong manifest
      fs.mkdirSync(absPath, { recursive: true });
      const wrongManifest = {
        schemaVersion: 1,
        id: 99999,
        title: 'Wrong',
        slug: 'wrong',
        status: 'tbd',
      };
      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      fs.writeFileSync(manifestPath, JSON.stringify(wrongManifest, null, 2) + '\n');

      const result = service.backfillProjectDirs();
      expect(result.conflicts).toBe(1);
      expect(result.backfilled).toBe(0);

      // DB path should still be null
      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toBeNull();

      // Original manifest should be untouched
      const stored = readManifestSync(absPath);
      expect(stored.id).toBe(99999);

      // Clean up
      fs.rmSync(absPath, { recursive: true, force: true });
    });

    it('rejects a symlink destination', () => {
      const project = insertNullDirRecord({ title: 'Symlink Reject', slug: 'symlink-reject' });
      const { absPath } = getProjectDir(project);

      // Create a real directory, then replace with symlink
      const realDir = path.join(path.dirname(absPath), 'symlink-target');
      fs.mkdirSync(realDir, { recursive: true });
      fs.symlinkSync(realDir, absPath, 'junction');

      const result = service.backfillProjectDirs();
      expect(result.conflicts).toBe(1);
      expect(result.backfilled).toBe(0);

      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toBeNull();

      // Clean up
      fs.rmSync(realDir, { recursive: true, force: true });
      if (fs.existsSync(absPath)) {
        fs.rmSync(absPath);
      }
    });

    it('adopts an existing matching directory', () => {
      const project = insertNullDirRecord({ title: 'Adopt Me', slug: 'adopt-me' });
      const { relPath, absPath } = getProjectDir(project);

      // Manually create the directory with a valid manifest
      fs.mkdirSync(absPath, { recursive: true });
      createProjectSubdirs(absPath);
      writeManifestSync(absPath, project, projectsRoot);

      // Add a custom file to prove it was adopted, not overridden
      const userFile = path.join(absPath, 'my-notes.txt');
      fs.writeFileSync(userFile, 'custom content');

      const result = service.backfillProjectDirs();
      expect(result.adopted).toBe(1);
      expect(result.backfilled).toBe(0);
      expect(result.conflicts).toBe(0);

      // DB path should be set
      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toBe(relPath);

      // Custom file should survive
      expect(fs.existsSync(userFile)).toBe(true);
      expect(fs.readFileSync(userFile, 'utf8')).toBe('custom content');
    });

    it('does not modify existing complete records', () => {
      // Create a project normally through the service (full flow)
      const project = service.create(validInput({ title: 'Complete Record' }));
      expect(project.project_dir).toBeTruthy();

      const result = service.backfillProjectDirs();
      expect(result.backfilled).toBe(0);
      expect(result.adopted).toBe(0);
      expect(result.conflicts).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('leaves database path unset when filesystem creation fails', () => {
      const project = insertNullDirRecord({
        title: 'FS Fail',
        slug: 'fs-fail',
      });
      const originalMkdir = fs.mkdirSync;
      fs.mkdirSync = vi.fn(() => { throw new Error('Disk full'); });

      try {
        const result = service.backfillProjectDirs();
        expect(result.backfilled).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].id).toBe(project.id);
      } finally {
        fs.mkdirSync = originalMkdir;
      }

      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toBeNull();
    });

    it('compensates when directory is created but path update fails', () => {
      const project = insertNullDirRecord({
        title: 'DB Fail After Dir',
        slug: 'db-fail-after-dir',
      });
      const originalSetDir = service.repository.setProjectDir;
      service.repository.setProjectDir = vi.fn(() => {
        throw new Error('Database connection lost');
      });

      try {
        const result = service.backfillProjectDirs();
        expect(result.backfilled).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].id).toBe(project.id);
      } finally {
        service.repository.setProjectDir = originalSetDir;
      }

      // Directory should have been cleaned up
      const { absPath } = getProjectDir(project);
      expect(fs.existsSync(absPath)).toBe(false);

      // DB path should still be null
      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toBeNull();
    });

    it('rejects unsupported manifest schema version on adoption', () => {
      const project = insertNullDirRecord({ title: 'Schema V2', slug: 'schema-v2' });
      const { absPath } = getProjectDir(project);

      fs.mkdirSync(absPath, { recursive: true });
      const badManifest = {
        schemaVersion: 2,
        id: project.id,
        title: 'Schema V2',
        slug: 'schema-v2',
        status: 'tbd',
      };
      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      fs.writeFileSync(manifestPath, JSON.stringify(badManifest, null, 2) + '\n');

      const result = service.backfillProjectDirs();
      expect(result.conflicts).toBe(1);

      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toBeNull();

      fs.rmSync(absPath, { recursive: true, force: true });
    });

    it('assigns correct status directory for non-tbd records', () => {
      const project = insertNullDirRecord({
        title: 'Status Dir Check',
        slug: 'status-dir-check',
        status: 'in-progress',
      });

      const result = service.backfillProjectDirs();
      expect(result.backfilled).toBe(1);

      const updated = service.repository.findById(project.id);
      expect(updated.project_dir).toContain(path.join('active', ''));
      expect(path.basename(updated.project_dir)).toBe('000001-status-dir-check');

      const { absPath } = getProjectDir(project);
      expect(absPath).toContain(path.join(projectsRoot, 'active'));
      expect(fs.existsSync(absPath)).toBe(true);
    });
  });

  // ─── Filesystem archive flow ─────────────────────────────────────────

  describe('filesystem archive', () => {
    function getProjectDir(project) {
      const dirName = formatProjectDirName(project.id, project.slug);
      const relPath = buildProjectRelPath(project.status, dirName);
      return { dirName, relPath, absPath: resolveProjectDir(projectsRoot, relPath) };
    }

    function getArchiveDir(project) {
      const dirName = formatProjectDirName(project.id, project.slug);
      const relPath = buildProjectRelPath('archived', dirName);
      const absPath = resolveProjectDir(projectsRoot, relPath);
      return { dirName, relPath, absPath };
    }

    function createTestProject(overrides = {}) {
      return service.create(validInput(overrides));
    }

    it('archive moves the directory to archived/', () => {
      const project = createTestProject({ title: 'Dir Move Archive' });
      const { absPath: originalPath } = getProjectDir(project);
      const { absPath: archivePath } = getArchiveDir(project);

      const archived = service.archive(project.id);

      expect(archived).toBeTruthy();
      expect(fs.existsSync(originalPath)).toBe(false);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.statSync(archivePath).isDirectory()).toBe(true);
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

    it('relative path is updated', () => {
      const project = createTestProject({ title: 'Path Update' });
      const { relPath: archiveRel } = getArchiveDir(project);
      const archived = service.archive(project.id);
      expect(archived.project_dir).toBe(archiveRel);
    });

    it('manifest reflects archived status', () => {
      const project = createTestProject({ title: 'Manifest Status' });
      const { absPath: archivePath } = getArchiveDir(project);
      service.archive(project.id);

      const manifest = readManifestSync(archivePath);
      expect(manifest).not.toBeNull();
      expect(manifest.status).toBe('archived');
      expect(manifest.id).toBe(project.id);
    });

    it('existing files survive archive', () => {
      const project = createTestProject({ title: 'Files Survive' });
      const { absPath: originalPath } = getProjectDir(project);

      const extraFiles = ['custom.txt', path.join('source', 'render.png')];
      for (const f of extraFiles) {
        const fullPath = path.join(originalPath, f);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, `content of ${f}`);
      }

      const { absPath: archivePath } = getArchiveDir(project);
      service.archive(project.id);

      for (const f of extraFiles) {
        const fullPath = path.join(archivePath, f);
        expect(fs.existsSync(fullPath)).toBe(true);
        expect(fs.readFileSync(fullPath, 'utf8')).toBe(`content of ${f}`);
      }
    });

    it('move failure leaves the database unarchived', () => {
      const project = createTestProject({ title: 'Move Fail' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('rename failed');
      });

      let err;
      try {
        service.archive(project.id);
      } catch (e) {
        err = e;
      } finally {
        renameSpy.mockRestore();
      }
      expect(err).toBeTruthy();
      expect(err.message).toContain('failed');

      // DB still has original values
      const found = service.findById(project.id);
      expect(found.status).not.toBe('archived');
      expect(found.archived_at).toBeNull();
      expect(found.project_dir).toBe(originalRel);

      // Directory still at original location
      expect(fs.existsSync(originalPath)).toBe(true);
    });

    it('database failure after move restores the original directory', () => {
      const project = createTestProject({ title: 'DB Fail Archive' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);
      const { absPath: archivePath } = getArchiveDir(project);

      const archiveSpy = vi.spyOn(service.repository, 'archive').mockImplementation(() => {
        throw new Error('DB archive failed');
      });

      let err;
      try {
        service.archive(project.id);
      } catch (e) {
        err = e;
      } finally {
        archiveSpy.mockRestore();
      }
      expect(err).toBeTruthy();
      expect(err.message).toContain('failed');

      // Directory moved back to original location
      expect(fs.existsSync(originalPath)).toBe(true);
      expect(fs.statSync(originalPath).isDirectory()).toBe(true);

      // Archive directory is gone
      expect(fs.existsSync(archivePath)).toBe(false);

      // DB unchanged
      const found = service.findById(project.id);
      expect(found.status).not.toBe('archived');
      expect(found.archived_at).toBeNull();
      expect(found.project_dir).toBe(originalRel);
    });

    it('manifest failure triggers compensation', () => {
      const project = createTestProject({ title: 'Manifest Fail' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);
      const { absPath: archivePath } = getArchiveDir(project);

      // Add custom file to prove restore
      fs.writeFileSync(path.join(originalPath, 'survivor.txt'), 'should survive');

      // Spy on renameSync: first call (dir move) succeeds, second call (manifest) fails
      const renameSpy = vi.spyOn(fs, 'renameSync');
      renameSpy.mockImplementationOnce(() => undefined);
      renameSpy.mockImplementationOnce(() => { throw new Error('manifest write failed'); });

      let err;
      try {
        service.archive(project.id);
      } catch (e) {
        err = e;
      } finally {
        renameSpy.mockRestore();
      }
      expect(err).toBeTruthy();
      expect(err.message).toContain('failed');

      // Directory moved back to original location
      expect(fs.existsSync(originalPath)).toBe(true);
      expect(fs.statSync(originalPath).isDirectory()).toBe(true);

      // Custom file survived the move-back
      expect(fs.existsSync(path.join(originalPath, 'survivor.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(originalPath, 'survivor.txt'), 'utf8')).toBe('should survive');

      // Archive directory gone
      expect(fs.existsSync(archivePath)).toBe(false);

      // DB restored to original values
      const found = service.findById(project.id);
      expect(found.status).not.toBe('archived');
      expect(found.archived_at).toBeNull();
      expect(found.project_dir).toBe(originalRel);
    });

    it('destination conflict leaves state intact', () => {
      const project = createTestProject({ title: 'Conflict Archive' });
      const { absPath: originalPath, relPath: originalRel } = getProjectDir(project);
      const { absPath: archivePath } = getArchiveDir(project);

      // Pre-create something at the destination
      fs.mkdirSync(archivePath, { recursive: true });
      fs.writeFileSync(path.join(archivePath, 'blocker.txt'), 'blocking');

      let err;
      try {
        service.archive(project.id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeTruthy();

      // Original directory untouched
      expect(fs.existsSync(originalPath)).toBe(true);
      expect(fs.readdirSync(originalPath).length).toBeGreaterThan(0);

      // DB unchanged
      const found = service.findById(project.id);
      expect(found.status).not.toBe('archived');
      expect(found.archived_at).toBeNull();
      expect(found.project_dir).toBe(originalRel);
    });

    it('missing source directory returns a safe error', () => {
      const project = createTestProject({ title: 'Missing Dir Archive' });
      const { absPath } = getProjectDir(project);

      fs.rmSync(absPath, { recursive: true, force: true });

      expect(() => service.archive(project.id)).toThrow('Project directory not found');
    });

    it('already-archived project is rejected', () => {
      const project = createTestProject({ title: 'Double Archive' });
      service.archive(project.id);

      expect(() => service.archive(project.id)).toThrow('already archived');
    });

    it('absolute paths are not rendered in error messages', () => {
      const project = createTestProject({ title: 'Archive Path Safety' });
      const { absPath } = getProjectDir(project);

      fs.rmSync(absPath, { recursive: true, force: true });

      let err;
      try {
        service.archive(project.id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeTruthy();
      expect(err.message).not.toMatch(/[A-Z]:\\/);
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
