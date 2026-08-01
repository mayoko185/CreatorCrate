import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset-browser preference repository', () => {
  let tmpDir;
  let db;
  let repository;
  let projectRepository;
  let assetCategoryRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-browser-repository-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAssetBrowserPreferenceRepository(db);
    projectRepository = createProjectRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = 'Repository Project') {
    return projectRepository.create({
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
  }

  it('reads a migrated project preference and creates missing preferences as inherit', () => {
    const project = createProject();

    expect(repository.findProjectPreference(project.id)).toBeUndefined();

    const ensured = repository.ensureProjectPreference(project.id);
    expect(ensured.default_category_mode).toBe('inherit');
    expect(ensured.default_category_id).toBeNull();
  });

  it('ensureProjectPreference is idempotent and preserves an existing value', () => {
    const project = createProject();
    const [category] = assetCategoryRepository.copyEnabledDefaultsForProject(project.id);
    const first = repository.upsertProjectPreference(project.id, 'category', category.id);

    const ensured = repository.ensureProjectPreference(project.id);

    expect(ensured).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_browser_preferences WHERE project_id = ?').get(project.id).count)
      .toBe(1);
  });

  it('upserts all, inherit, and category values with the stored shape', () => {
    const project = createProject();
    const [category] = assetCategoryRepository.copyEnabledDefaultsForProject(project.id);

    const all = repository.upsertProjectPreference(project.id, 'all', null);
    expect(all.default_category_mode).toBe('all');
    expect(all.default_category_id).toBeNull();

    const specific = repository.upsertProjectPreference(project.id, 'category', category.id);
    expect(specific.default_category_mode).toBe('category');
    expect(specific.default_category_id).toBe(category.id);

    const inherit = repository.upsertProjectPreference(project.id, 'inherit', null);
    expect(inherit.default_category_mode).toBe('inherit');
    expect(inherit.default_category_id).toBeNull();
  });

  it('exposes the reset operation without nesting a transaction', () => {
    const project = createProject();
    const [category, otherCategory] = assetCategoryRepository.copyEnabledDefaultsForProject(project.id);
    repository.upsertProjectPreference(project.id, 'category', category.id);

    const reset = db.transaction(() => repository.resetProjectPreferenceIfCategory(project.id, category.id));

    expect(reset()).toBe(true);
    expect(repository.findProjectPreference(project.id).default_category_mode).toBe('inherit');
    expect(repository.resetProjectPreferenceIfCategory(project.id, category.id)).toBe(false);

    repository.upsertProjectPreference(project.id, 'all', null);
    expect(repository.resetProjectPreferenceIfCategory(project.id, category.id)).toBe(false);
    repository.upsertProjectPreference(project.id, 'category', otherCategory.id);
    expect(repository.resetProjectPreferenceIfCategory(project.id, category.id)).toBe(false);
    expect(repository.findProjectPreference(project.id).default_category_id).toBe(otherCategory.id);
  });

  it('reads missing global metadata as all and preserves malformed raw values', () => {
    db.prepare('DELETE FROM app_meta WHERE key = ?').run('asset_browser.default_category');
    expect(repository.getGlobalDefault()).toBe('all');

    repository.setGlobalDefault('not-a-category');
    expect(repository.getGlobalDefault()).toBe('not-a-category');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get('asset_browser.default_category'))
      .toBe('not-a-category');
  });

  it('writes global metadata through the repository boundary', () => {
    expect(repository.setGlobalDefault('exports')).toBe('exports');
    expect(repository.getGlobalDefault()).toBe('exports');
    expect(repository.setGlobalDefault('all')).toBe('all');
    expect(repository.getGlobalDefault()).toBe('all');
  });
});
