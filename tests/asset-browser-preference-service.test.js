import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import {
  createAssetBrowserPreferenceService,
  AssetCategoryValidationError,
  AUTO_RENAME_UNAVAILABLE_REASONS,
  PREFERENCE_FALLBACK_REASONS,
} from '../src/services/asset-browser-preference-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset-browser preference service', () => {
  let tmpDir;
  let db;
  let preferenceRepository;
  let projectRepository;
  let assetCategoryRepository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-browser-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    preferenceRepository = createAssetBrowserPreferenceRepository(db);
    projectRepository = createProjectRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
    service = createAssetBrowserPreferenceService({
      preferenceRepository,
      projectRepository,
      assetCategoryRepository,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = 'Preference Project') {
    const project = projectRepository.create({
      title,
      slug: title.toLowerCase().replaceAll(' ', '-'),
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    const categories = assetCategoryRepository.copyEnabledDefaultsForProject(project.id);
    return { project, categories };
  }

  function setProjectCategoryEnabled(projectId, categoryId, enabled) {
    assetCategoryRepository.setProjectCategoryEnabled(projectId, categoryId, enabled);
  }

  it('reads a missing project row as inherit without creating it', () => {
    const { project } = createProject();
    db.prepare('DELETE FROM project_asset_browser_preferences WHERE project_id = ?').run(project.id);

    expect(service.getProjectPreference(project.id)).toEqual({ mode: 'inherit', categoryId: null });
    expect(preferenceRepository.findProjectPreference(project.id)).toBeUndefined();
  });

  it('sets inherit, all, and a valid owned enabled category', () => {
    const { project, categories } = createProject();

    expect(service.setProjectPreference(project.id, 'all')).toEqual({ mode: 'all', categoryId: null });
    expect(service.setProjectPreference(project.id, 'inherit')).toEqual({ mode: 'inherit', categoryId: null });
    expect(service.setProjectPreference(project.id, `category:${categories[0].id}`)).toEqual({
      mode: 'category',
      categoryId: categories[0].id,
    });
  });

  it.each(['', 'inherit ', 'ALL', 'category:', 'category:0', 'category:-1', 'category:1.5', 'category:01x'])
    ('rejects malformed or non-positive project token %p', (value) => {
      const { project } = createProject();
      expect(() => service.setProjectPreference(project.id, value)).toThrow(AssetCategoryValidationError);
    });

  it('rejects a category token owned by another project', () => {
    const first = createProject('First Project');
    const second = createProject('Second Project');

    expect(() => service.setProjectPreference(first.project.id, `category:${second.categories[0].id}`))
      .toThrow(AssetCategoryValidationError);
    expect(service.getProjectPreference(first.project.id)).toEqual({ mode: 'inherit', categoryId: null });
  });

  it('rejects direct selection of a disabled project category', () => {
    const { project, categories } = createProject();
    setProjectCategoryEnabled(project.id, categories[0].id, false);

    expect(() => service.setProjectPreference(project.id, `category:${categories[0].id}`))
      .toThrow(AssetCategoryValidationError);
    expect(service.getProjectPreference(project.id)).toEqual({ mode: 'inherit', categoryId: null });
  });

  describe('effective resolution', () => {
    it('exposes presentation state through the same fallback implementation', () => {
      const { project, categories } = createProject('Presentation State');
      service.setProjectPreference(project.id, `category:${categories[0].id}`);

      const state = service.getProjectPreferenceState(project.id);
      expect(state.preference).toEqual({ mode: 'category', categoryId: categories[0].id });
      expect(state.resolution).toEqual(service.resolveEffectiveCategory(project.id));
    });

    it('resolves project all to All', () => {
      const { project } = createProject();
      service.setProjectPreference(project.id, 'all');

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        storedMode: 'all',
        storedCategoryId: null,
        effective: { kind: 'all', category: null },
        fallback: false,
        fallbackReason: null,
      });
    });

    it('resolves a specific enabled category', () => {
      const { project, categories } = createProject();
      service.setProjectPreference(project.id, `category:${categories[0].id}`);

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        storedMode: 'category',
        storedCategoryId: categories[0].id,
        effective: { kind: 'category', category: categories[0] },
        fallback: false,
        fallbackReason: null,
      });
    });

    it('uses an explicit enabled category and lets it override the stored default', () => {
      const { project, categories } = createProject('Explicit Category');
      service.setProjectPreference(project.id, `category:${categories[1].id}`);

      const resolution = service.resolveEffectiveCategory(project.id, {
        explicitCategory: categories[0].id,
      });

      expect(resolution).toMatchObject({
        storedMode: 'category',
        storedCategoryId: categories[1].id,
        effective: { kind: 'category', category: categories[0] },
        autoRenameAvailable: true,
        autoRenameUnavailableReason: null,
      });
    });

    it('uses the existing concrete project default when no explicit category is supplied', () => {
      const { project, categories } = createProject('Default Category');
      service.setProjectPreference(project.id, `category:${categories[1].id}`);

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        effective: { kind: 'category', category: categories[1] },
        autoRenameAvailable: true,
        autoRenameUnavailableReason: null,
      });
    });

    it.each([
      ['all', AUTO_RENAME_UNAVAILABLE_REASONS.ALL],
      ['uncategorized', AUTO_RENAME_UNAVAILABLE_REASONS.UNCATEGORIZED],
    ])('marks explicit %s unavailable without falling back', (value, reason) => {
      const { project, categories } = createProject(`Unsupported ${value}`);
      service.setProjectPreference(project.id, `category:${categories[0].id}`);

      expect(service.resolveEffectiveCategory(project.id, { explicitCategory: value })).toMatchObject({
        effective: { kind: 'all', category: null },
        autoRenameAvailable: false,
        autoRenameUnavailableReason: reason,
      });
    });

    it('marks a missing concrete default unavailable without inventing a replacement', () => {
      const { project } = createProject('No Concrete Default');
      service.setProjectPreference(project.id, 'inherit');
      preferenceRepository.setGlobalDefault('all');

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        effective: { kind: 'all', category: null },
        autoRenameAvailable: false,
        autoRenameUnavailableReason: AUTO_RENAME_UNAVAILABLE_REASONS.ALL,
      });
    });

    it('controls missing and deleted explicit categories', () => {
      const { project, categories } = createProject('Missing Explicit Category');
      const missingCategoryId = categories[0].id;
      db.prepare('DELETE FROM project_asset_categories WHERE project_id = ? AND id = ?')
        .run(project.id, missingCategoryId);

      expect(service.resolveEffectiveCategory(project.id, { explicitCategory: missingCategoryId })).toMatchObject({
        effective: { kind: 'all', category: null },
        autoRenameAvailable: false,
        autoRenameUnavailableReason: AUTO_RENAME_UNAVAILABLE_REASONS.MISSING,
      });
    });

    it('controls disabled explicit categories', () => {
      const { project, categories } = createProject('Disabled Explicit Category');
      setProjectCategoryEnabled(project.id, categories[0].id, false);

      expect(service.resolveEffectiveCategory(project.id, { explicitCategory: categories[0].id })).toMatchObject({
        effective: { kind: 'all', category: null },
        autoRenameAvailable: false,
        autoRenameUnavailableReason: AUTO_RENAME_UNAVAILABLE_REASONS.DISABLED,
      });
    });

    it('controls cross-project explicit categories', () => {
      const owner = createProject('Explicit Owner');
      const foreign = createProject('Explicit Foreign');

      expect(service.resolveEffectiveCategory(owner.project.id, {
        explicitCategory: foreign.categories[0].id,
      })).toMatchObject({
        effective: { kind: 'all', category: null },
        autoRenameAvailable: false,
        autoRenameUnavailableReason: AUTO_RENAME_UNAVAILABLE_REASONS.CROSS_PROJECT,
      });
    });

    it.each([0, -1, '0', '1.5', '+1', 'category:1', null])
      ('controls invalid explicit category ID %p without falling back', (value) => {
        const { project, categories } = createProject('Invalid Explicit Category');
        service.setProjectPreference(project.id, `category:${categories[0].id}`);

        expect(service.resolveEffectiveCategory(project.id, { explicitCategory: value })).toMatchObject({
          effective: { kind: 'all', category: null },
          autoRenameAvailable: false,
          autoRenameUnavailableReason: AUTO_RENAME_UNAVAILABLE_REASONS.INVALID,
        });
      });

    it('falls back from a disabled specific category while retaining the stored preference', () => {
      const { project, categories } = createProject();
      service.setProjectPreference(project.id, `category:${categories[0].id}`);
      setProjectCategoryEnabled(project.id, categories[0].id, false);

      const resolution = service.resolveEffectiveCategory(project.id);
      expect(resolution).toMatchObject({
        storedMode: 'category',
        storedCategoryId: categories[0].id,
        effective: { kind: 'all', category: null },
        fallback: true,
        fallbackReason: PREFERENCE_FALLBACK_REASONS.PROJECT_CATEGORY_DISABLED,
      });
      expect(service.getProjectPreference(project.id)).toEqual({
        mode: 'category',
        categoryId: categories[0].id,
      });

      setProjectCategoryEnabled(project.id, categories[0].id, true);
      expect(service.resolveEffectiveCategory(project.id).effective).toEqual({
        kind: 'category',
        category: assetCategoryRepository.findProjectCategoryById(project.id, categories[0].id),
      });
    });

    it('falls back from a missing category while retaining the stored preference', () => {
      const { project, categories } = createProject();
      service.setProjectPreference(project.id, `category:${categories[0].id}`);
      db.prepare('DELETE FROM project_asset_categories WHERE project_id = ? AND id = ?')
        .run(project.id, categories[0].id);

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        storedMode: 'category',
        storedCategoryId: categories[0].id,
        effective: { kind: 'all', category: null },
        fallback: true,
        fallbackReason: PREFERENCE_FALLBACK_REASONS.PROJECT_CATEGORY_MISSING,
      });
    });

    it('resolves inherit plus global all to All', () => {
      const { project } = createProject();
      service.setProjectPreference(project.id, 'inherit');
      service.setGlobalPreference('all');

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        storedMode: 'inherit',
        effective: { kind: 'all', category: null },
        fallback: false,
        fallbackReason: null,
      });
    });

    it('resolves inherit plus a matching enabled global/project slug', () => {
      const { project, categories } = createProject();
      const final = categories.find((category) => category.directory_slug === 'final');
      service.setGlobalPreference('final');
      service.setProjectPreference(project.id, 'inherit');

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        effective: { kind: 'category', category: final },
        fallback: false,
        fallbackReason: null,
      });
    });

    it('falls back when the global category has no project match', () => {
      const { project } = createProject();
      service.setGlobalPreference('final');
      db.prepare('DELETE FROM project_asset_categories WHERE project_id = ? AND directory_slug = ?')
        .run(project.id, 'final');

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        effective: { kind: 'all', category: null },
        fallback: true,
        fallbackReason: PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_NOT_IN_PROJECT,
      });
    });

    it('falls back when the matching project category is disabled and restores it when re-enabled', () => {
      const { project, categories } = createProject();
      const final = categories.find((category) => category.directory_slug === 'final');
      service.setGlobalPreference('final');
      setProjectCategoryEnabled(project.id, final.id, false);

      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        effective: { kind: 'all', category: null },
        fallback: true,
        fallbackReason: PREFERENCE_FALLBACK_REASONS.GLOBAL_PROJECT_CATEGORY_DISABLED,
      });

      setProjectCategoryEnabled(project.id, final.id, true);
      expect(service.resolveEffectiveCategory(project.id).effective).toEqual({
        kind: 'category',
        category: assetCategoryRepository.findProjectCategoryById(project.id, final.id),
      });
    });

    it('falls back for malformed or stale global values without rewriting them', () => {
      const { project } = createProject();
      service.setProjectPreference(project.id, 'inherit');

      preferenceRepository.setGlobalDefault('category:12');
      expect(service.resolveEffectiveCategory(project.id)).toMatchObject({
        effective: { kind: 'all', category: null },
        fallback: true,
        fallbackReason: PREFERENCE_FALLBACK_REASONS.GLOBAL_PREFERENCE_MALFORMED,
      });
      expect(service.getGlobalPreference()).toBe('category:12');

      preferenceRepository.setGlobalDefault('does-not-exist');
      expect(service.resolveEffectiveCategory(project.id).fallbackReason)
        .toBe(PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_MISSING);

      preferenceRepository.setGlobalDefault('');
      expect(service.resolveEffectiveCategory(project.id).fallbackReason)
        .toBe(PREFERENCE_FALLBACK_REASONS.GLOBAL_PREFERENCE_MALFORMED);
      expect(service.getGlobalPreference()).toBe('');
    });

    it.each(['disabled', 'deleted', 'renamed'])('falls back when the global category is %s', (change) => {
      const { project } = createProject();
      const global = assetCategoryRepository.listDefaults().find((category) => category.directory_slug === 'final');
      service.setGlobalPreference('final');

      if (change === 'disabled') {
        assetCategoryRepository.setDefaultEnabled(global.id, false);
      } else if (change === 'deleted') {
        assetCategoryRepository.deleteDefault(global.id);
      } else {
        assetCategoryRepository.updateDefaultNameSlug(global.id, {
          displayName: global.display_name,
          directorySlug: 'renamed-source',
        });
      }

      const resolution = service.resolveEffectiveCategory(project.id);
      expect(resolution.effective).toEqual({ kind: 'all', category: null });
      expect(resolution.fallback).toBe(true);
      expect([
        PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_DISABLED,
        PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_MISSING,
        PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_NOT_IN_PROJECT,
      ]).toContain(resolution.fallbackReason);
      expect(service.getGlobalPreference()).toBe('final');

      if (change === 'disabled') {
        assetCategoryRepository.setDefaultEnabled(global.id, true);
        expect(service.resolveEffectiveCategory(project.id).effective.kind).toBe('category');
        expect(service.resolveEffectiveCategory(project.id).effective.category.directory_slug).toBe('final');
      }
    });
  });

  describe('global writes', () => {
    it('sets all and an enabled global slug', () => {
      expect(service.setGlobalPreference('all')).toBe('all');
      expect(service.setGlobalPreference('wip')).toBe('wip');
      expect(service.getGlobalPreference()).toBe('wip');
    });

    it('rejects unknown and disabled global values without changing the stored value', () => {
      service.setGlobalPreference('wip');
      expect(() => service.setGlobalPreference('unknown-slug')).toThrow(AssetCategoryValidationError);
      expect(service.getGlobalPreference()).toBe('wip');

      const final = assetCategoryRepository.listDefaults().find((category) => category.directory_slug === 'final');
      assetCategoryRepository.setDefaultEnabled(final.id, false);
      expect(() => service.setGlobalPreference('final')).toThrow(AssetCategoryValidationError);
      expect(service.getGlobalPreference()).toBe('wip');
    });
  });

  describe('deleted-category reset support', () => {
    it('resets only a matching category preference', () => {
      const { project, categories } = createProject();
      const [first, second] = categories;

      service.setProjectPreference(project.id, `category:${first.id}`);
      expect(service.resetPreferenceForDeletedCategory(project.id, second.id)).toBe(false);
      expect(service.getProjectPreference(project.id)).toEqual({ mode: 'category', categoryId: first.id });

      expect(service.resetPreferenceForDeletedCategory(project.id, first.id)).toBe(true);
      expect(service.getProjectPreference(project.id)).toEqual({ mode: 'inherit', categoryId: null });
    });

    it('does not alter all or inherit preferences', () => {
      const { project, categories } = createProject();

      service.setProjectPreference(project.id, 'all');
      expect(service.resetPreferenceForDeletedCategory(project.id, categories[0].id)).toBe(false);
      expect(service.getProjectPreference(project.id)).toEqual({ mode: 'all', categoryId: null });

      service.setProjectPreference(project.id, 'inherit');
      expect(service.resetPreferenceForDeletedCategory(project.id, categories[0].id)).toBe(false);
      expect(service.getProjectPreference(project.id)).toEqual({ mode: 'inherit', categoryId: null });
    });

    it('participates in the caller transaction', () => {
      const { project, categories } = createProject();
      service.setProjectPreference(project.id, `category:${categories[0].id}`);

      db.transaction(() => {
        expect(service.resetPreferenceForDeletedCategory(project.id, categories[0].id)).toBe(true);
        db.prepare('DELETE FROM project_asset_categories WHERE project_id = ? AND id = ?')
          .run(project.id, categories[0].id);
      })();

      expect(service.getProjectPreference(project.id)).toEqual({ mode: 'inherit', categoryId: null });
    });
  });
});
