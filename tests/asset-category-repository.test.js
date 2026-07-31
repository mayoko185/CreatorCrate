import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset category repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let repository;
  let projectRepo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-categories-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAssetCategoryRepository(db);
    projectRepo = createProjectRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = 'Test Project') {
    return projectRepo.create({
      title,
      slug: slugify(title, { lowercase: true }),
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
  }

  describe('global defaults', () => {
    it('lists seeded defaults ordered by display_order then id', () => {
      const defaults = repository.listDefaults();
      expect(defaults.map((d) => d.directory_slug)).toEqual([
        'source', 'exports', 'extras', 'references', 'thumbnails',
      ]);
      expect(defaults.map((d) => d.display_order)).toEqual([0, 1, 2, 3, 4]);
    });

    it('adds a default', () => {
      const added = repository.addDefault({
        displayName: 'Raw',
        directorySlug: 'raw',
        displayOrder: 5,
        enabled: true,
      });
      expect(added.display_name).toBe('Raw');
      expect(added.directory_slug).toBe('raw');
      expect(added.enabled).toBe(1);
      expect(repository.listDefaults()).toHaveLength(6);
    });

    it('edits display name and directory slug', () => {
      const [first] = repository.listDefaults();
      const updated = repository.updateDefaultNameSlug(first.id, {
        displayName: 'Renamed Source',
        directorySlug: 'renamed-source',
      });
      expect(updated.display_name).toBe('Renamed Source');
      expect(updated.directory_slug).toBe('renamed-source');
    });

    it('sets enabled state', () => {
      const [first] = repository.listDefaults();
      const disabled = repository.setDefaultEnabled(first.id, false);
      expect(disabled.enabled).toBe(0);
      const enabled = repository.setDefaultEnabled(first.id, true);
      expect(enabled.enabled).toBe(1);
    });

    it('deletes a default', () => {
      const [first] = repository.listDefaults();
      const result = repository.deleteDefault(first.id);
      expect(result).toBe(true);
      expect(repository.listDefaults()).toHaveLength(4);
    });

    it('reorders defaults to contiguous zero-based positions', () => {
      const defaults = repository.listDefaults();
      const reversedIds = defaults.map((d) => d.id).reverse();

      const reordered = repository.reorderDefaults(reversedIds);

      expect(reordered.map((d) => d.id)).toEqual(reversedIds);
      expect(reordered.map((d) => d.display_order)).toEqual([0, 1, 2, 3, 4]);
    });

    it('rejects reorder with missing IDs', () => {
      const defaults = repository.listDefaults();
      const incomplete = defaults.slice(1).map((d) => d.id);
      expect(() => repository.reorderDefaults(incomplete)).toThrow();
    });

    it('rejects reorder with duplicate IDs', () => {
      const defaults = repository.listDefaults();
      const ids = defaults.map((d) => d.id);
      const duplicated = [...ids.slice(1), ids[0], ids[0]];
      expect(() => repository.reorderDefaults(duplicated)).toThrow();
    });

    it('rejects reorder with an invalid/unknown ID', () => {
      const defaults = repository.listDefaults();
      const ids = defaults.map((d) => d.id);
      const withUnknown = [...ids.slice(1), 999999];
      expect(() => repository.reorderDefaults(withUnknown)).toThrow();
    });
  });

  describe('project categories', () => {
    it('lists project categories deterministically by display_order then id', () => {
      const project = createProject();
      const copied = repository.copyEnabledDefaultsForProject(project.id);
      expect(copied.length).toBeGreaterThan(0);

      const listed = repository.listProjectCategories(project.id);
      expect(listed.map((c) => c.directory_slug)).toEqual(
        copied.map((c) => c.directory_slug)
      );
      expect(listed.map((c) => c.display_order)).toEqual(
        listed.map((_, i) => i)
      );
    });

    it('copies only enabled defaults, preserving relative order with contiguous local positions', () => {
      const project = createProject();
      const defaults = repository.listDefaults();
      // Disable the middle default ('extras').
      const extras = defaults.find((d) => d.directory_slug === 'extras');
      repository.setDefaultEnabled(extras.id, false);

      const copied = repository.copyEnabledDefaultsForProject(project.id);

      expect(copied.map((c) => c.directory_slug)).toEqual([
        'source', 'exports', 'references', 'thumbnails',
      ]);
      expect(copied.map((c) => c.display_order)).toEqual([0, 1, 2, 3]);
      expect(copied.every((c) => c.enabled === 1)).toBe(true);
      expect(copied.every((c) => c.project_id === project.id)).toBe(true);
    });

    it('copying with no enabled defaults inserts nothing and returns empty', () => {
      const project = createProject();
      for (const def of repository.listDefaults()) {
        repository.setDefaultEnabled(def.id, false);
      }

      const copied = repository.copyEnabledDefaultsForProject(project.id);

      expect(copied).toEqual([]);
      expect(repository.listProjectCategories(project.id)).toEqual([]);
    });

    it('copied project categories are independent of later default edits, disables, reorders, and deletes', () => {
      const project = createProject();
      const copied = repository.copyEnabledDefaultsForProject(project.id);
      const beforeSnapshot = repository.listProjectCategories(project.id);

      const defaults = repository.listDefaults();
      // Edit
      repository.updateDefaultNameSlug(defaults[0].id, {
        displayName: 'Changed Name',
        directorySlug: 'changed-slug',
      });
      // Disable
      repository.setDefaultEnabled(defaults[1].id, false);
      // Reorder
      repository.reorderDefaults(defaults.map((d) => d.id).reverse());
      // Delete
      repository.deleteDefault(defaults[2].id);

      const afterSnapshot = repository.listProjectCategories(project.id);
      expect(afterSnapshot).toEqual(beforeSnapshot);
      expect(copied.map((c) => c.directory_slug)).toEqual(
        afterSnapshot.map((c) => c.directory_slug)
      );
    });

    it('project categories reference their owning project', () => {
      const projectA = createProject('Project A');
      const projectB = createProject('Project B');

      repository.copyEnabledDefaultsForProject(projectA.id);
      repository.copyEnabledDefaultsForProject(projectB.id);

      const listA = repository.listProjectCategories(projectA.id);
      const listB = repository.listProjectCategories(projectB.id);

      expect(listA.every((c) => c.project_id === projectA.id)).toBe(true);
      expect(listB.every((c) => c.project_id === projectB.id)).toBe(true);
    });

    it('does not require project and default category IDs to differ (independence is not ID-based)', () => {
      const project = createProject();
      const copied = repository.copyEnabledDefaultsForProject(project.id);
      const defaults = repository.listDefaults();

      // No assertion that IDs differ or match — independence is structural
      // (separate tables/rows), not a numeric-ID invariant. This test only
      // documents that both collections exist and are separately addressable.
      expect(copied.length).toBe(defaults.filter((d) => d.enabled === 1).length);
    });
  });
});
