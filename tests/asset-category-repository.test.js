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

    it('reorders an arbitrary permutation without colliding with a unique order constraint', () => {
      const defaults = repository.listDefaults();
      const orderedIds = [defaults[2].id, defaults[0].id, defaults[4].id, defaults[1].id, defaults[3].id];
      db.exec(`
        CREATE UNIQUE INDEX asset_category_defaults_order_unique
        ON asset_category_defaults(display_order)
      `);

      const reordered = repository.reorderDefaults(orderedIds);

      expect(reordered.map((d) => d.id)).toEqual(orderedIds);
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

    it('rejects non-positive and unsafe IDs without changing the current order', () => {
      const defaults = repository.listDefaults();
      const ids = defaults.map((d) => d.id);
      const before = repository.listDefaults();

      expect(() => repository.reorderDefaults([0, ...ids.slice(1)])).toThrow();
      expect(() => repository.reorderDefaults([-1, ...ids.slice(1)])).toThrow();
      expect(() => repository.reorderDefaults([Number.MAX_SAFE_INTEGER + 1, ...ids.slice(1)])).toThrow();

      expect(repository.listDefaults()).toEqual(before);
    });

    it('accepts the empty exact set when no global defaults exist', () => {
      for (const category of repository.listDefaults()) {
        expect(repository.deleteDefault(category.id)).toBe(true);
      }

      expect(repository.reorderDefaults([])).toEqual([]);
    });

    it('rolls back the entire reorder when the final update fails', () => {
      const before = repository.listDefaults();
      db.exec(`
        CREATE TRIGGER fail_global_category_reorder
        BEFORE UPDATE OF display_order ON asset_category_defaults
        WHEN OLD.display_order >= 6 AND NEW.display_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced global reorder failure');
        END
      `);

      expect(() => repository.reorderDefaults(before.map((category) => category.id).reverse()))
        .toThrow(/forced global reorder failure/);
      expect(repository.listDefaults()).toEqual(before);
    });

    it('preserves global metadata, the stored default preference, and existing project categories', () => {
      const project = createProject();
      repository.copyEnabledDefaultsForProject(project.id);
      const projectCategoriesBefore = repository.listProjectCategories(project.id);
      const defaultsBefore = repository.listDefaults();
      const metadataBefore = defaultsBefore
        .map(({ id, display_name, directory_slug, enabled }) => ({ id, display_name, directory_slug, enabled }))
        .sort((a, b) => a.id - b.id);
      db.prepare('UPDATE app_meta SET value = ? WHERE key = ?')
        .run('exports', 'asset_browser.default_category');

      repository.reorderDefaults(defaultsBefore.map((category) => category.id).reverse());

      const defaultsAfter = repository.listDefaults();
      expect(defaultsAfter
        .map(({ id, display_name, directory_slug, enabled }) => ({ id, display_name, directory_slug, enabled }))
        .sort((a, b) => a.id - b.id)).toEqual(metadataBefore);
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
        .get('asset_browser.default_category')).toBe('exports');
      expect(repository.listProjectCategories(project.id)).toEqual(projectCategoriesBefore);
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

  // ─── Phase 2 chunk 2: project-scoped category mutations ────────────────

  describe('project category mutations', () => {
    it('finds a project category by project ID and category ID', () => {
      const project = createProject();
      const [category] = repository.copyEnabledDefaultsForProject(project.id);

      const found = repository.findProjectCategoryById(project.id, category.id);
      expect(found).toEqual(category);
    });

    it('treats a category owned by another project as not found', () => {
      const projectA = createProject('Project A');
      const projectB = createProject('Project B');
      const [categoryA] = repository.copyEnabledDefaultsForProject(projectA.id);
      repository.copyEnabledDefaultsForProject(projectB.id);

      expect(repository.findProjectCategoryById(projectB.id, categoryA.id)).toBeUndefined();
    });

    it('returns undefined for an unknown category ID', () => {
      const project = createProject();
      expect(repository.findProjectCategoryById(project.id, 999999)).toBeUndefined();
    });

    it('appends a new project category deterministically', () => {
      const project = createProject();
      repository.copyEnabledDefaultsForProject(project.id);
      const before = repository.listProjectCategories(project.id);
      const nextOrder = before.length;

      const added = repository.addProjectCategory({
        projectId: project.id,
        displayName: 'Raw',
        directorySlug: 'raw',
        displayOrder: nextOrder,
        enabled: true,
      });

      expect(added.project_id).toBe(project.id);
      expect(added.display_name).toBe('Raw');
      expect(added.directory_slug).toBe('raw');
      expect(added.display_order).toBe(nextOrder);
      expect(added.enabled).toBe(1);

      const after = repository.listProjectCategories(project.id);
      expect(after).toHaveLength(before.length + 1);
      expect(after[after.length - 1].id).toBe(added.id);
    });

    it('adds a disabled project category', () => {
      const project = createProject();
      const added = repository.addProjectCategory({
        projectId: project.id,
        displayName: 'Raw',
        directorySlug: 'raw',
        displayOrder: 0,
        enabled: false,
      });
      expect(added.enabled).toBe(0);
    });

    it('edits only the display name, leaving the slug untouched', () => {
      const project = createProject();
      const [category] = repository.copyEnabledDefaultsForProject(project.id);

      const updated = repository.updateProjectCategoryDisplayName(project.id, category.id, 'Renamed');

      expect(updated.display_name).toBe('Renamed');
      expect(updated.directory_slug).toBe(category.directory_slug);
      expect(updated.id).toBe(category.id);
    });

    it('does not edit a display name for a category owned by another project', () => {
      const projectA = createProject('Project A');
      const projectB = createProject('Project B');
      const [categoryA] = repository.copyEnabledDefaultsForProject(projectA.id);
      repository.copyEnabledDefaultsForProject(projectB.id);

      const result = repository.updateProjectCategoryDisplayName(projectB.id, categoryA.id, 'Hijacked');
      expect(result).toBeUndefined();
      expect(repository.findProjectCategoryById(projectA.id, categoryA.id).display_name).toBe(categoryA.display_name);
    });

    it('sets the enabled state for a project category', () => {
      const project = createProject();
      const [category] = repository.copyEnabledDefaultsForProject(project.id);

      const disabled = repository.setProjectCategoryEnabled(project.id, category.id, false);
      expect(disabled.enabled).toBe(0);
      const enabled = repository.setProjectCategoryEnabled(project.id, category.id, true);
      expect(enabled.enabled).toBe(1);
    });

    it('reorders a project\'s categories to contiguous zero-based positions', () => {
      const project = createProject();
      const categories = repository.copyEnabledDefaultsForProject(project.id);
      const reversedIds = categories.map((c) => c.id).reverse();

      const reordered = repository.reorderProjectCategories(project.id, reversedIds);

      expect(reordered.map((c) => c.id)).toEqual(reversedIds);
      expect(reordered.map((c) => c.display_order)).toEqual(reordered.map((_, i) => i));
    });

    it('reorders an arbitrary permutation without colliding with a unique order constraint', () => {
      const project = createProject();
      const categories = repository.copyEnabledDefaultsForProject(project.id);
      const orderedIds = [categories[2].id, categories[0].id, categories[4].id, categories[1].id, categories[3].id];
      db.exec(`
        CREATE UNIQUE INDEX project_asset_categories_project_order_unique
        ON project_asset_categories(project_id, display_order)
      `);

      const reordered = repository.reorderProjectCategories(project.id, orderedIds);

      expect(reordered.map((c) => c.id)).toEqual(orderedIds);
      expect(reordered.map((c) => c.display_order)).toEqual([0, 1, 2, 3, 4]);
    });

    it('reorder is exact — rejects missing, duplicate, or unknown IDs', () => {
      const project = createProject();
      const categories = repository.copyEnabledDefaultsForProject(project.id);
      const ids = categories.map((c) => c.id);

      expect(() => repository.reorderProjectCategories(project.id, ids.slice(1))).toThrow();
      expect(() => repository.reorderProjectCategories(project.id, [...ids.slice(1), ids[0], ids[0]])).toThrow();
      expect(() => repository.reorderProjectCategories(project.id, [...ids.slice(1), 999999])).toThrow();
    });

    it('reorder does not accept another project\'s category IDs', () => {
      const projectA = createProject('Project A');
      const projectB = createProject('Project B');
      const categoriesA = repository.copyEnabledDefaultsForProject(projectA.id);
      repository.copyEnabledDefaultsForProject(projectB.id);

      expect(() => repository.reorderProjectCategories(projectB.id, categoriesA.map((c) => c.id))).toThrow();
    });

    it('a failed reorder makes no partial mutation', () => {
      const project = createProject();
      const categories = repository.copyEnabledDefaultsForProject(project.id);
      const before = repository.listProjectCategories(project.id);
      const ids = categories.map((c) => c.id);

      expect(() => repository.reorderProjectCategories(project.id, [...ids.slice(1), 999999])).toThrow();

      const after = repository.listProjectCategories(project.id);
      expect(after).toEqual(before);
    });

    it('rejects unsafe and non-positive IDs without changing the current order', () => {
      const project = createProject();
      const categories = repository.copyEnabledDefaultsForProject(project.id);
      const before = repository.listProjectCategories(project.id);
      const ids = categories.map((c) => c.id);

      expect(() => repository.reorderProjectCategories(project.id, [0, ...ids.slice(1)])).toThrow();
      expect(() => repository.reorderProjectCategories(project.id, [-1, ...ids.slice(1)])).toThrow();
      expect(() => repository.reorderProjectCategories(project.id, [Number.MAX_SAFE_INTEGER + 1, ...ids.slice(1)])).toThrow();

      expect(repository.listProjectCategories(project.id)).toEqual(before);
    });

    it('reorder never mutates global defaults', () => {
      const project = createProject();
      const categories = repository.copyEnabledDefaultsForProject(project.id);
      const defaultsBefore = repository.listDefaults();

      repository.reorderProjectCategories(project.id, categories.map((c) => c.id).reverse());

      expect(repository.listDefaults()).toEqual(defaultsBefore);
    });

    it('deletes a project category and compacts remaining positions', () => {
      const project = createProject();
      const categories = repository.copyEnabledDefaultsForProject(project.id);
      const [, second, third] = categories;

      const remaining = repository.deleteProjectCategoryAndCompact(project.id, second.id);

      expect(remaining.find((c) => c.id === second.id)).toBeUndefined();
      expect(remaining.map((c) => c.display_order)).toEqual(remaining.map((_, i) => i));
      expect(remaining.find((c) => c.id === third.id).display_order).toBe(
        remaining.findIndex((c) => c.id === third.id)
      );
    });

    it('deleting a category owned by another project throws and mutates nothing', () => {
      const projectA = createProject('Project A');
      const projectB = createProject('Project B');
      const [categoryA] = repository.copyEnabledDefaultsForProject(projectA.id);
      repository.copyEnabledDefaultsForProject(projectB.id);

      expect(() => repository.deleteProjectCategoryAndCompact(projectB.id, categoryA.id)).toThrow();
      expect(repository.findProjectCategoryById(projectA.id, categoryA.id)).toBeTruthy();
    });

    it('project-category mutations never mutate global defaults', () => {
      const project = createProject();
      const [category] = repository.copyEnabledDefaultsForProject(project.id);
      const defaultsBefore = repository.listDefaults();

      repository.updateProjectCategoryDisplayName(project.id, category.id, 'Changed');
      repository.setProjectCategoryEnabled(project.id, category.id, false);
      repository.addProjectCategory({
        projectId: project.id, displayName: 'New', directorySlug: 'new', displayOrder: 99, enabled: true,
      });

      expect(repository.listDefaults()).toEqual(defaultsBefore);
    });
  });
});
