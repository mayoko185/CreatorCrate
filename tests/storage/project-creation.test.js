import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../../src/db.js';
import {
  createProjectService,
  ProjectValidationError,
} from '../../src/services/project-service.js';
import {
  formatProjectDirName,
  buildProjectRelPath,
  resolveProjectDir,
  verifyProjectDirOwnership,
  STATUS_DIR_MAP,
} from '../../src/storage/project-storage.js';
import { MANIFEST_FILENAME } from '../../src/storage/manifest.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

// ─── Helpers ─────────────────────────────────────────────────────────────

function validInput(overrides = {}) {
  return {
    title: 'Creation Test',
    description: 'Test description',
    notes: 'Test notes',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('project creation integration', () => {
  let tmpDir;
  let db;
  let service;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-creation-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
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

  // ── Success path ─────────────────────────────────────────────────────

  describe('successful creation', () => {
    it('creates database record with all fields', () => {
      const project = service.create(validInput({ title: 'Full Record', description: 'Desc' }));
      expect(project.id).toBeGreaterThan(0);
      expect(project.title).toBe('Full Record');
      expect(project.slug).toBe('full-record');
      expect(project.description).toBe('Desc');
      expect(project.status).toBe('tbd');
      expect(project.priority).toBe('normal');
      expect(project.created_at).toBeTruthy();
      expect(project.updated_at).toBeTruthy();
      expect(project.archived_at).toBeNull();
    });

    it('creates project directory at correct path', () => {
      const project = service.create(validInput({ title: 'Path Check', status: 'in-progress' }));

      const dirName = formatProjectDirName(project.id, project.slug);
      const relPath = buildProjectRelPath(project.status, dirName);
      const absPath = resolveProjectDir(projectsRoot, relPath);

      expect(fs.existsSync(absPath)).toBe(true);
      expect(fs.statSync(absPath).isDirectory()).toBe(true);

      expect(relPath.startsWith('active' + path.sep)).toBe(true);
      expect(absPath).toContain(path.join(projectsRoot, 'active'));
    });

    it('uses six-digit zero-padded ID in directory name', () => {
      const project = service.create(validInput({ title: 'ID Prefix' }));
      const dirName = formatProjectDirName(project.id, project.slug);
      expect(dirName).toMatch(/^\d{6}-/);
      const prefix = dirName.split('-')[0];
      expect(Number(prefix)).toBe(project.id);
    });

    it('creates exactly the expected subdirectories', () => {
      const project = service.create(validInput({ title: 'Subdir Check' }));
      const absPath = resolveProjectDir(
        projectsRoot,
        buildProjectRelPath(project.status, formatProjectDirName(project.id, project.slug))
      );

      const expected = [
        'source', 'references', 'extras', 'thumbnails',
        path.join('exports', 'full'), path.join('exports', 'web'),
      ];

      for (const sub of expected) {
        const subPath = path.join(absPath, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.statSync(subPath).isDirectory()).toBe(true);
      }
    });

    it('writes valid manifest matching project data', () => {
      const project = service.create(validInput({
        title: 'Manifest Data',
        description: 'Desc for manifest',
        notes: 'Notes for manifest',
        status: 'planned',
        priority: 'high',
        plannedDate: '2026-09-15',
        patreonUrl: 'https://patreon.com/artist',
      }));

      const absPath = resolveProjectDir(
        projectsRoot,
        buildProjectRelPath(project.status, formatProjectDirName(project.id, project.slug))
      );
      const content = fs.readFileSync(path.join(absPath, MANIFEST_FILENAME), 'utf8');
      const manifest = JSON.parse(content);

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.id).toBe(project.id);
      expect(manifest.title).toBe('Manifest Data');
      expect(manifest.slug).toBe('manifest-data');
      expect(manifest.status).toBe('planned');
      expect(manifest.priority).toBe('high');
      expect(manifest.description).toBe('Desc for manifest');
      expect(manifest.notes).toBe('Notes for manifest');
      expect(manifest.plannedDate).toBe('2026-09-15T00:00:00.000Z');
      expect(manifest.publishedDate).toBeNull();
      expect(manifest.patreonUrl).toBe('https://patreon.com/artist');
      expect(manifest.createdAt).toBeTruthy();
      expect(manifest.updatedAt).toBeTruthy();
    });

    it('stores relative path and returns updated project', () => {
      const project = service.create(validInput({ title: 'Rel Path Store' }));
      expect(project.project_dir).toBeTruthy();

      const dirName = formatProjectDirName(project.id, project.slug);
      const expectedRelPath = buildProjectRelPath(project.status, dirName);
      expect(project.project_dir).toBe(expectedRelPath);

      // Verify via repository lookup
      const found = service.findById(project.id);
      expect(found.project_dir).toBe(expectedRelPath);
    });
  });

  // ── Failure injection and compensation ───────────────────────────────

  describe('compensation on failure', () => {
    it('deletes database record when mkdirSync fails', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => service.create(validInput({ title: 'Mkdir Fail' }))).toThrow(
        'Project creation failed'
      );
      mkdirSpy.mockRestore();

      expect(service.repository.findBySlug('mkdir-fail')).toBeUndefined();
    });

    it('removes directory and database record when manifest write fails', () => {
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => service.create(validInput({ title: 'Manifest Fail' }))).toThrow(
        'Project creation failed'
      );
      renameSpy.mockRestore();

      // No database record
      expect(service.repository.findBySlug('manifest-fail')).toBeUndefined();

      // No directory
      const statusDir = path.join(projectsRoot, 'tbd');
      const entries = fs.readdirSync(statusDir);
      expect(entries.filter((e) => e.endsWith('-manifest-fail'))).toHaveLength(0);
    });

    it('removes directory and database record when setProjectDir fails', () => {
      const setDirSpy = vi.spyOn(service.repository, 'setProjectDir').mockImplementation(() => {
        throw new Error('DB update failed');
      });

      expect(() => service.create(validInput({ title: 'Set Dir Fail' }))).toThrow(
        'Project creation failed'
      );
      setDirSpy.mockRestore();

      expect(service.repository.findBySlug('set-dir-fail')).toBeUndefined();

      const statusDir = path.join(projectsRoot, 'tbd');
      const entries = fs.readdirSync(statusDir);
      expect(entries.filter((e) => e.endsWith('-set-dir-fail'))).toHaveLength(0);
    });

    it('does not delete unrelated directories during rollback', () => {
      // Create a legitimate project first
      const legit = service.create(validInput({ title: 'Keep Me Safe' }));

      // Now create another that fails
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => service.create(validInput({ title: 'Fail Project' }))).toThrow(
        'Project creation failed'
      );
      renameSpy.mockRestore();

      // Legitimate project still exists
      const found = service.findById(legit.id);
      expect(found).toBeTruthy();
      expect(found.slug).toBe('keep-me-safe');
      expect(found.project_dir).toBeTruthy();

      // Its directory still exists
      const legitDir = resolveProjectDir(
        projectsRoot,
        buildProjectRelPath(legit.status, formatProjectDirName(legit.id, legit.slug))
      );
      expect(fs.existsSync(legitDir)).toBe(true);
    });

    it('surfaces generic user-visible error without absolute paths', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      try {
        service.create(validInput({ title: 'Generic Error' }));
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err.message).toBe('Project creation failed. Please try again.');
        expect(err.message).not.toMatch(/[A-Z]:\\/);
        expect(err.message).not.toMatch(/\/\w+/);
      }

      mkdirSpy.mockRestore();
    });

    it('ownership verification correctly identifies matching and non-matching IDs', () => {
      const project = service.create(validInput({ title: 'Ownership Check' }));
      const absPath = resolveProjectDir(
        projectsRoot,
        buildProjectRelPath(project.status, formatProjectDirName(project.id, project.slug))
      );

      expect(verifyProjectDirOwnership(absPath, project.id)).toBe(true);
      expect(verifyProjectDirOwnership(absPath, 99999)).toBe(false);
    });
  });

  // ── Concurrent creation ──────────────────────────────────────────────

  describe('concurrent creation safety', () => {
    it('rejects duplicate slugs', () => {
      service.create(validInput({ title: 'Unique Title' }));
      expect(() => service.create(validInput({ title: 'Unique Title' }))).toThrow(
        ProjectValidationError
      );
    });

    it('creates multiple projects with different slugs', () => {
      const p1 = service.create(validInput({ title: 'Project Alpha' }));
      const p2 = service.create(validInput({ title: 'Project Beta' }));

      expect(p2.id).not.toBe(p1.id);
      expect(p2.slug).not.toBe(p1.slug);

      for (const p of [p1, p2]) {
        const absPath = resolveProjectDir(
          projectsRoot,
          buildProjectRelPath(p.status, formatProjectDirName(p.id, p.slug))
        );
        expect(fs.existsSync(absPath)).toBe(true);
      }
    });
  });
});
