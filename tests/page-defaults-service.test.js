import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createPageDefaultsService,
  PageDefaultValidationError,
  PAGE_DEFAULT_DEFINITIONS,
} from '../src/services/page-defaults-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('page defaults service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-default-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    service = createPageDefaultsService({ appMetaRepository: repository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the exact existing fallback when no saved value exists', () => {
    expect(service.resolve('projects', 'view')).toBe('grid');
    expect(service.resolve('projects', 'sort')).toBe('created');
    expect(service.resolve('projects', 'order')).toBe('desc');
    expect(service.resolve('publishedWork', 'view')).toBe('grid');
    expect(service.resolve('publishedWork', 'sort')).toBe('published');
    expect(service.resolve('publishedWork', 'order')).toBe('desc');
    expect(service.resolve('releaseManagement', 'view')).toBe('list');
    expect(service.resolve('releaseManagement', 'sort')).toBe('updated');
    expect(service.resolve('releaseManagement', 'order')).toBe('desc');
    expect(service.resolve('projectAssets', 'view')).toBe('grid');
    expect(service.resolve('projectAssets', 'sort')).toBe('filename');
    expect(service.resolve('projectAssets', 'order')).toBe('asc');
    expect(service.resolve('projectAssets', 'pageSize')).toBe('25');
    expect(service.resolve('new_project', 'status')).toBe('tbd');
    expect(service.resolve('new_project', 'priority')).toBe('normal');
    expect(service.resolve('new_release', 'status')).toBe('idea');
  });

  it('defines the exact Project Assets option allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.projectAssets).toEqual({
      view: {
        key: 'page_defaults.project_assets.view',
        values: ['grid', 'list'],
        fallback: 'grid',
      },
      sort: {
        key: 'page_defaults.project_assets.sort',
        values: ['filename', 'modified', 'size', 'category'],
        fallback: 'filename',
      },
      order: {
        key: 'page_defaults.project_assets.order',
        values: ['asc', 'desc'],
        fallback: 'asc',
      },
      pageSize: {
        key: 'page_defaults.project_assets.page_size',
        values: ['10', '25', '50', '100'],
        fallback: '25',
      },
    });
  });

  it('defines the exact New Projects option allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.new_project).toEqual({
      status: {
        key: 'page_defaults.new_project.status',
        values: ['tbd', 'planned', 'in-progress', 'ready', 'published'],
        fallback: 'tbd',
      },
      priority: {
        key: 'page_defaults.new_project.priority',
        values: ['low', 'normal', 'high'],
        fallback: 'normal',
      },
    });
  });

  it('defines the exact New Release status allowlist, key, and fallback', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.new_release).toEqual({
      status: {
        key: 'page_defaults.new_release.status',
        values: ['idea', 'planned', 'drafting', 'ready'],
        fallback: 'idea',
      },
    });
  });

  it('defines the exact Release Management allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.releaseManagement).toEqual({
      view: {
        key: 'page_defaults.release_management.view',
        values: ['list', 'board'],
        fallback: 'list',
      },
      sort: {
        key: 'page_defaults.release_management.sort',
        values: ['updated', 'created', 'planned', 'title'],
        fallback: 'updated',
      },
      order: {
        key: 'page_defaults.release_management.order',
        values: ['asc', 'desc'],
        fallback: 'desc',
      },
    });
  });

  it('accepts a valid saved value', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key, 'list');

    expect(service.getSavedDefault('projects', 'view')).toBe('list');
    expect(service.resolve('projects', 'view')).toBe('list');
  });

  it('accepts valid New Projects saved values', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_project.status.key, 'ready');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_project.priority.key, 'high');

    expect(service.getSavedDefault('new_project', 'status')).toBe('ready');
    expect(service.getSavedDefault('new_project', 'priority')).toBe('high');
    expect(service.resolvePageDefaults('new_project')).toEqual({
      status: 'ready',
      priority: 'high',
    });
  });

  it('accepts a valid New Release saved value', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_release.status.key, 'ready');

    expect(service.getSavedDefault('new_release', 'status')).toBe('ready');
    expect(service.resolve('new_release', 'status')).toBe('ready');
  });

  it('accepts valid Release Management saved values', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.releaseManagement.view.key, 'board');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.releaseManagement.sort.key, 'planned');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.releaseManagement.order.key, 'asc');

    expect(service.resolvePageDefaults('releaseManagement')).toEqual({
      view: 'board',
      sort: 'planned',
      order: 'asc',
    });
  });

  it('accepts valid Project Assets saved values', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'category');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.pageSize.key, '100');

    expect(service.resolvePageDefaults('projectAssets')).toEqual({
      view: 'list',
      sort: 'category',
      order: 'desc',
      pageSize: '100',
    });
  });

  it('lets a valid explicit value override the saved value', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'title');

    expect(service.resolve('projects', 'sort', 'updated')).toBe('updated');
  });

  it('uses the existing fallback for an invalid explicit value instead of the saved value', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key, 'list');

    expect(service.resolve('projects', 'view', 'board')).toBe('grid');
  });

  it('ignores an invalid saved value without rewriting it', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.publishedWork.sort.key;
    repository.setValue(key, 'created');

    expect(service.getSavedDefault('publishedWork', 'sort')).toBeUndefined();
    expect(service.resolve('publishedWork', 'sort')).toBe('published');
    expect(repository.getValue(key)).toBe('created');
  });

  it('uses New Projects fallbacks for invalid stored values without rewriting them', () => {
    const invalidValues = {
      status: 'cancelled',
      priority: 'urgent',
    };
    for (const [option, value] of Object.entries(invalidValues)) {
      repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_project[option].key, value);
    }

    expect(service.resolvePageDefaults('new_project')).toEqual({
      status: 'tbd',
      priority: 'normal',
    });
    for (const [option, value] of Object.entries(invalidValues)) {
      expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.new_project[option].key)).toBe(value);
      expect(service.getSavedDefault('new_project', option)).toBeUndefined();
    }
  });

  it('uses the New Release fallback for invalid stored values without rewriting them', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.new_release.status.key;
    repository.setValue(key, 'cancelled');

    expect(service.getSavedDefault('new_release', 'status')).toBeUndefined();
    expect(service.resolve('new_release', 'status')).toBe('idea');
    expect(repository.getValue(key)).toBe('cancelled');
  });

  it('uses Release Management fallbacks for invalid stored values without rewriting them', () => {
    const invalidValues = {
      view: 'grid',
      sort: 'published',
      order: 'forwards',
    };
    for (const [option, value] of Object.entries(invalidValues)) {
      repository.setValue(PAGE_DEFAULT_DEFINITIONS.releaseManagement[option].key, value);
    }

    expect(service.resolvePageDefaults('releaseManagement')).toEqual({
      view: 'list',
      sort: 'updated',
      order: 'desc',
    });
    for (const [option, value] of Object.entries(invalidValues)) {
      expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.releaseManagement[option].key)).toBe(value);
      expect(service.getSavedDefault('releaseManagement', option)).toBeUndefined();
    }
  });

  it('uses Project Assets fallbacks for invalid stored values without rewriting them', () => {
    const invalidValues = {
      view: 'board',
      sort: 'published',
      order: 'forwards',
      pageSize: '20',
    };
    for (const [option, value] of Object.entries(invalidValues)) {
      repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets[option].key, value);
    }

    expect(service.resolvePageDefaults('projectAssets')).toEqual({
      view: 'grid',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
    });
    for (const [option, value] of Object.entries(invalidValues)) {
      expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projectAssets[option].key)).toBe(value);
      expect(service.getSavedDefault('projectAssets', option)).toBeUndefined();
    }
  });

  it('rejects a value that belongs to another page allowlist', () => {
    expect(() => service.saveDefault('projects', 'sort', 'published'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projects', 'view', 'published'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projectAssets', 'sort', 'title'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projectAssets', 'pageSize', '20'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('new_release', 'status', 'published'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('new_release', 'status', 'cancelled'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('releaseManagement', 'view', 'grid'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('releaseManagement', 'sort', 'published'))
      .toThrow(PageDefaultValidationError);
  });

  it('saves a valid value and replaces the prior value', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.publishedWork.order.key;

    expect(service.saveDefault('publishedWork', 'order', 'asc')).toBe('asc');
    expect(service.saveDefault('publishedWork', 'order', 'desc')).toBe('desc');
    expect(repository.getValue(key)).toBe('desc');
  });

  it('resolves all page options with explicit values taking precedence', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'title');

    expect(service.resolvePageDefaults('projects', { view: 'grid' })).toEqual({
      view: 'grid',
      sort: 'title',
      order: 'desc',
    });

    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'size');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.pageSize.key, '100');

    expect(service.resolvePageDefaults('projectAssets', { view: 'grid', pageSize: '10' })).toEqual({
      view: 'grid',
      sort: 'size',
      order: 'desc',
      pageSize: '10',
    });
  });

  it('validates every page option before any defaults are written', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'title');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.order.key, 'asc');

    expect(() => service.validatePageDefaults('projects', {
      view: 'grid',
      sort: 'unsupported',
      order: 'desc',
    })).toThrow(PageDefaultValidationError);

    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('list');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key)).toBe('title');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.order.key)).toBe('asc');
  });

  it('returns definition-backed values when every submitted option is valid', () => {
    expect(service.validatePageDefaults('publishedWork', {
      view: 'list',
      sort: 'updated',
      order: 'asc',
    })).toEqual({
      view: 'list',
      sort: 'updated',
      order: 'asc',
    });

    expect(service.validatePageDefaults('projectAssets', {
      view: 'grid',
      sort: 'modified',
      order: 'desc',
      pageSize: '50',
    })).toEqual({
      view: 'grid',
      sort: 'modified',
      order: 'desc',
      pageSize: '50',
    });
  });
});
