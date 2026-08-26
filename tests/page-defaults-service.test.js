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

function createInMemoryProjectPageDefaultRepository() {
  const values = new Map();
  const keyFor = (projectId, page, option) => `${projectId}:${page}:${option}`;

  return {
    getOption(projectId, page, option) {
      return values.get(keyFor(projectId, page, option));
    },
    setOption(projectId, page, option, value) {
      values.set(keyFor(projectId, page, option), value);
      return value;
    },
    deletePageOptions(projectId, page) {
      let deleted = false;
      for (const key of values.keys()) {
        if (key.startsWith(`${projectId}:${page}:`)) {
          values.delete(key);
          deleted = true;
        }
      }
      return deleted;
    },
    hasPageOptions(projectId, page) {
      return [...values.keys()].some((key) => key.startsWith(`${projectId}:${page}:`));
    },
  };
}

describe('page defaults service', () => {
  let tmpDir;
  let db;
  let repository;
  let projectPageDefaultRepository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-default-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    projectPageDefaultRepository = createInMemoryProjectPageDefaultRepository();
    service = createPageDefaultsService({ appMetaRepository: repository, projectPageDefaultRepository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the exact existing fallback when no saved value exists', () => {
    expect(service.resolve('projects', 'view')).toBe('grid');
    expect(service.resolve('projects', 'sort')).toBe('created');
    expect(service.resolve('projects', 'order')).toBe('desc');
    expect(service.resolve('releases', 'sort')).toBe('planned');
    expect(service.resolve('releases', 'order')).toBe('asc');
    expect(service.resolve('projectAssets', 'view')).toBe('grid');
    expect(service.resolve('projectAssets', 'gridSize')).toBe('default');
    expect(service.resolve('projectAssets', 'listSize')).toBe('large');
    expect(service.resolve('projectAssets', 'sort')).toBe('filename');
    expect(service.resolve('projectAssets', 'order')).toBe('asc');
    expect(service.resolve('projectAssets', 'pageSize')).toBe('25');
    expect(service.resolve('projectAssets', 'extension')).toBe('all');
    expect(service.resolve('projectAssets', 'tag')).toBe('all');
    expect(service.resolve('assetViewer', 'view')).toBe('grid');
    expect(service.resolve('assetViewer', 'sort')).toBe('filename');
    expect(service.resolve('assetViewer', 'order')).toBe('asc');
    expect(service.resolve('assetViewer', 'pageSize')).toBe('25');
    expect(service.resolve('assetViewer', 'extension')).toBe('all');
    expect(service.resolve('assetViewer', 'category')).toBe('all');
    expect(service.resolve('assetViewer', 'presence')).toBe('all');
    expect(service.resolve('assetViewer', 'tag')).toBe('all');
    expect(service.resolve('new_project', 'status')).toBe('tbd');
  });

  it('defines the exact Project Assets option allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.projectAssets).toEqual({
      view: {
        key: 'page_defaults.project_assets.view',
        values: ['grid', 'list'],
        fallback: 'grid',
      },
      gridSize: {
        key: 'page_defaults.project_assets.grid_size',
        values: ['compact', 'default', 'large'],
        fallback: 'default',
      },
      listSize: {
        key: 'page_defaults.project_assets.list_size',
        values: ['compact', 'large'],
        fallback: 'large',
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
      extension: {
        key: 'page_defaults.project_assets.extension',
        values: ['all'],
        fallback: 'all',
        multi: true,
      },
      tag: {
        key: 'page_defaults.project_assets.tag',
        values: ['all'],
        fallback: 'all',
        multi: true,
      },
    });
  });

  it('defines the exact Asset Viewer option allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.assetViewer).toEqual({
      view: {
        key: 'page_defaults.asset_viewer.view',
        values: ['grid', 'list'],
        fallback: 'grid',
      },
      sort: {
        key: 'page_defaults.asset_viewer.sort',
        values: ['filename', 'modified', 'size', 'category', 'project'],
        fallback: 'filename',
      },
      order: {
        key: 'page_defaults.asset_viewer.order',
        values: ['asc', 'desc'],
        fallback: 'asc',
      },
      pageSize: {
        key: 'page_defaults.asset_viewer.page_size',
        values: ['10', '25', '50', '100'],
        fallback: '25',
      },
      extension: {
        key: 'page_defaults.asset_viewer.extension',
        values: ['all'],
        fallback: 'all',
      },
      category: {
        key: 'page_defaults.asset_viewer.category',
        values: ['all'],
        fallback: 'all',
      },
      presence: {
        key: 'page_defaults.asset_viewer.presence',
        values: ['all', 'present', 'missing'],
        fallback: 'all',
      },
      tag: {
        key: 'page_defaults.asset_viewer.tag',
        values: ['all'],
        fallback: 'all',
      },
    });
  });

  it('defines the exact New Projects option allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.new_project).toEqual({
      status: {
        key: 'page_defaults.new_project.status',
        values: ['tbd', 'planned', 'in-progress', 'ready', 'completed'],
        fallback: 'tbd',
      },
    });
  });

  it('does not define an obsolete New Release status default', () => {
    expect(PAGE_DEFAULT_DEFINITIONS).not.toHaveProperty('new_release');
  });

  it('defines the exact Projects option allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.projects).toEqual({
      view: {
        key: 'page_defaults.projects.view',
        values: ['grid', 'list'],
        fallback: 'grid',
      },
      sort: {
        key: 'page_defaults.projects.sort',
        values: ['updated', 'created', 'title', 'published'],
        fallback: 'created',
      },
      order: {
        key: 'page_defaults.projects.order',
        values: ['asc', 'desc'],
        fallback: 'desc',
      },
      status: {
        key: 'page_defaults.projects.status',
        values: ['all', 'tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived'],
        fallback: 'all',
      },
      projectType: {
        key: 'page_defaults.projects.project_type',
        values: ['all', 'images', 'comic', 'animation', 'wallpaper'],
        fallback: 'all',
      },
      tag: {
        key: 'page_defaults.projects.tag',
        values: ['all'],
        fallback: 'all',
      },
    });
  });

  it('accepts published as a valid Projects sort default', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'published');

    expect(service.getSavedDefault('projects', 'sort')).toBe('published');
    expect(service.resolve('projects', 'sort')).toBe('published');
  });

  it('does not expose a second Release Management defaults namespace', () => {
    expect(PAGE_DEFAULT_DEFINITIONS).not.toHaveProperty('releaseManagement');
  });

  it('accepts a valid saved value', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key, 'list');

    expect(service.getSavedDefault('projects', 'view')).toBe('list');
    expect(service.resolve('projects', 'view')).toBe('list');
  });

  it('accepts valid New Projects saved values', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_project.status.key, 'ready');

    expect(service.getSavedDefault('new_project', 'status')).toBe('ready');
    expect(service.resolvePageDefaults('new_project')).toEqual({
      status: 'ready',
    });
  });

  it('ignores legacy New Project Priority storage while resolving supported defaults', () => {
    const legacyKey = 'page_defaults.new_project.priority';
    repository.setValue(legacyKey, 'high');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_project.status.key, 'ready');

    expect(PAGE_DEFAULT_DEFINITIONS.new_project).not.toHaveProperty('priority');
    expect(service.resolvePageDefaults('new_project')).toEqual({ status: 'ready' });
    expect(repository.getValue(legacyKey)).toBe('high');
  });

  it('ignores stale Release Management values while resolving canonical Releases defaults', () => {
    repository.setValue('page_defaults.release_management.sort', 'updated');
    repository.setValue('page_defaults.release_management.order', 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.releases.sort.key, 'title');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.releases.order.key, 'desc');

    expect(service.resolvePageDefaults('releases')).toEqual({ sort: 'title', order: 'desc' });
    expect(repository.getValue('page_defaults.release_management.sort')).toBe('updated');
    expect(repository.getValue('page_defaults.release_management.order')).toBe('desc');
  });

  it('accepts valid Project Assets saved values', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.gridSize.key, 'large');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.listSize.key, 'compact');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'category');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.pageSize.key, '100');

    expect(service.resolvePageDefaults('projectAssets')).toEqual({
      view: 'list',
      gridSize: 'large',
      listSize: 'compact',
      sort: 'category',
      order: 'desc',
      pageSize: '100',
      extension: 'all',
      tag: 'all',
    });
  });

  it('accepts valid Asset Viewer saved values, including project sorting', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.sort.key, 'project');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.pageSize.key, '100');

    expect(service.resolvePageDefaults('assetViewer')).toEqual({
      view: 'list',
      sort: 'project',
      order: 'desc',
      pageSize: '100',
      extension: 'all',
      category: 'all',
      presence: 'all',
      tag: 'all',
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

  it('keeps invalid explicit values at the fallback when resolving a project context', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key, 'list');
    projectPageDefaultRepository.setOption(1, 'projectAssets', 'view', 'list');

    expect(service.resolve('projectAssets', 'view', 'board', undefined, { projectId: 1 })).toBe('grid');
  });

  it('ignores an invalid saved value without rewriting it', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.releases.sort.key;
    repository.setValue(key, 'invalid-sort');

    expect(service.getSavedDefault('releases', 'sort')).toBeUndefined();
    expect(service.resolve('releases', 'sort')).toBe('planned');
    expect(repository.getValue(key)).toBe('invalid-sort');
  });

  it('uses the New Project status fallback for invalid stored values without rewriting it', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.new_project.status.key;
    repository.setValue(key, 'cancelled');

    expect(service.resolvePageDefaults('new_project')).toEqual({ status: 'tbd' });
    expect(repository.getValue(key)).toBe('cancelled');
    expect(service.getSavedDefault('new_project', 'status')).toBeUndefined();
  });

  it('ignores an obsolete stored New Release status default without rewriting it', () => {
    const key = 'page_defaults.new_release.status';
    repository.setValue(key, 'cancelled');

    expect(PAGE_DEFAULT_DEFINITIONS).not.toHaveProperty('new_release');
    expect(repository.getValue(key)).toBe('cancelled');
  });

  it('uses Releases fallbacks for invalid stored values without rewriting them', () => {
    const invalidValues = { sort: 'published', order: 'forwards' };
    for (const [option, value] of Object.entries(invalidValues)) {
      repository.setValue(PAGE_DEFAULT_DEFINITIONS.releases[option].key, value);
    }

    expect(service.resolvePageDefaults('releases')).toEqual({ sort: 'planned', order: 'asc' });
    for (const [option, value] of Object.entries(invalidValues)) {
      expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.releases[option].key)).toBe(value);
      expect(service.getSavedDefault('releases', option)).toBeUndefined();
    }
  });

  it('uses Project Assets fallbacks for invalid stored values without rewriting them', () => {
    const invalidValues = {
      view: 'board',
      gridSize: 'extra-large',
      listSize: 'default',
      sort: 'published',
      order: 'forwards',
      pageSize: '20',
    };
    for (const [option, value] of Object.entries(invalidValues)) {
      repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets[option].key, value);
    }

    expect(service.resolvePageDefaults('projectAssets')).toEqual({
      view: 'grid',
      gridSize: 'default',
      listSize: 'large',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
      extension: 'all',
      tag: 'all',
    });
    for (const [option, value] of Object.entries(invalidValues)) {
      expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projectAssets[option].key)).toBe(value);
      expect(service.getSavedDefault('projectAssets', option)).toBeUndefined();
    }
  });

  it('uses Asset Viewer fallbacks for invalid stored values without rewriting them', () => {
    const invalidValues = {
      view: 'board',
      sort: 'title',
      order: 'forwards',
      pageSize: '20',
      extension: 'retired',
      category: 'retired',
      presence: 'unknown',
      tag: 'retired',
    };
    for (const [option, value] of Object.entries(invalidValues)) {
      repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer[option].key, value);
    }

    expect(service.resolvePageDefaults('assetViewer')).toEqual({
      view: 'grid',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
      extension: 'all',
      category: 'all',
      presence: 'all',
      tag: 'all',
    });
    for (const [option, value] of Object.entries(invalidValues)) {
      expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.assetViewer[option].key)).toBe(value);
      expect(service.getSavedDefault('assetViewer', option)).toBeUndefined();
    }
  });

  it('rejects a value that belongs to another page allowlist', () => {
    expect(() => service.saveDefault('projects', 'sort', 'bogus'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projects', 'view', 'published'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projectAssets', 'sort', 'title'))
      .toThrow(PageDefaultValidationError);
    expect(service.saveDefault('assetViewer', 'sort', 'project')).toBe('project');
    expect(() => service.saveDefault('projectAssets', 'sort', 'project'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projectAssets', 'pageSize', '20'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projectAssets', 'gridSize', 'extra-large'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projectAssets', 'listSize', 'default'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('releaseManagement', 'view', 'grid'))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('releaseManagement', 'sort', 'published'))
      .toThrow(PageDefaultValidationError);
  });

  it('saves a valid value and replaces the prior value', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.releases.order.key;

    expect(service.saveDefault('releases', 'order', 'asc')).toBe('asc');
    expect(service.saveDefault('releases', 'order', 'desc')).toBe('desc');
    expect(repository.getValue(key)).toBe('desc');
  });

  it('saves valid Project Assets size values', () => {
    expect(service.saveDefault('projectAssets', 'gridSize', 'compact')).toBe('compact');
    expect(service.saveDefault('projectAssets', 'listSize', 'large')).toBe('large');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.gridSize.key)).toBe('compact');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.listSize.key)).toBe('large');
  });

  it('resolves all page options with explicit values taking precedence', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'title');

    expect(service.resolvePageDefaults('projects', { view: 'grid' })).toEqual({
      view: 'grid',
      sort: 'title',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    });

    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.gridSize.key, 'large');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.listSize.key, 'compact');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'size');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.pageSize.key, '100');

    expect(service.resolvePageDefaults('projectAssets', {
      view: 'grid',
      gridSize: 'compact',
      listSize: 'large',
      pageSize: '10',
    })).toEqual({
      view: 'grid',
      gridSize: 'compact',
      listSize: 'large',
      sort: 'size',
      order: 'desc',
      pageSize: '10',
      extension: 'all',
      tag: 'all',
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
    expect(service.validatePageDefaults('releases', {
      sort: 'updated',
      order: 'asc',
    })).toEqual({
      sort: 'updated',
      order: 'asc',
    });

    expect(service.validatePageDefaults('projectAssets', {
      view: 'grid',
      gridSize: 'large',
      listSize: 'compact',
      sort: 'modified',
      order: 'desc',
      pageSize: '50',
      extension: 'all',
      tag: 'all',
    })).toEqual({
      view: 'grid',
      gridSize: 'large',
      listSize: 'compact',
      sort: 'modified',
      order: 'desc',
      pageSize: '50',
      extension: 'all',
      tag: 'all',
    });

    expect(service.validatePageDefaults('assetViewer', {
      view: 'list',
      sort: 'project',
      order: 'desc',
      pageSize: '100',
      extension: 'all',
      category: 'all',
      presence: 'all',
      tag: 'all',
    })).toEqual({
      view: 'list',
      sort: 'project',
      order: 'desc',
      pageSize: '100',
      extension: 'all',
      category: 'all',
      presence: 'all',
      tag: 'all',
    });
  });


  it('uses a supplied live catalogue for dynamic validation, persistence, and resolution', () => {
    const catalogue = [
      { value: 'all', label: 'All projects' },
      { value: 'recent', label: 'Recently updated' },
    ];
    const values = {
      view: 'grid',
      sort: 'recent',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    };

    expect(service.validatePageDefaults('projects', values, { sort: catalogue })).toEqual(values);
    expect(service.saveDefault('projects', 'sort', 'recent', catalogue)).toBe('recent');
    expect(service.resolve('projects', 'sort', undefined, catalogue)).toBe('recent');
    expect(() => service.validatePageDefaults('projects', {
      ...values,
      sort: 'title',
    }, { sort: catalogue })).toThrow(PageDefaultValidationError);
  });

  it('uses the dynamic fallback for stale stored values without rewriting storage', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.projects.sort.key;
    const catalogue = [{ value: 'all', label: 'All projects' }];
    repository.setValue(key, 'retired');

    expect(service.getSavedDefault('projects', 'sort', catalogue)).toBeUndefined();
    expect(service.resolve('projects', 'sort', undefined, catalogue)).toBe('created');
    expect(repository.getValue(key)).toBe('retired');
  });

  it('uses dynamic Project Assets catalogues for live values and stale fallbacks without rewriting storage', () => {
    const extensionKey = PAGE_DEFAULT_DEFINITIONS.projectAssets.extension.key;
    const tagKey = PAGE_DEFAULT_DEFINITIONS.projectAssets.tag.key;
    const optionCatalogues = {
      extension: [{ value: 'all', label: 'All extensions' }, { value: 'png', label: '.png' }],
      tag: [{ value: 'all', label: 'All tags' }, { value: '42', label: 'Design' }],
    };
    repository.setValue(extensionKey, 'retired');
    repository.setValue(tagKey, '99');

    expect(service.resolvePageDefaults('projectAssets', {}, optionCatalogues)).toMatchObject({
      extension: 'all',
      tag: 'all',
    });
    expect(repository.getValue(extensionKey)).toBe('retired');
    expect(repository.getValue(tagKey)).toBe('99');
    expect(service.validatePageDefaults('projectAssets', {
      view: 'grid',
      gridSize: 'default',
      listSize: 'large',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
      extension: 'png',
      tag: '42',
    }, optionCatalogues)).toMatchObject({ extension: ['png'], tag: ['42'] });
    expect(() => service.validatePageDefaults('projectAssets', {
      view: 'grid',
      gridSize: 'default',
      listSize: 'large',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
      extension: 'jpg',
      tag: '99',
    }, optionCatalogues)).toThrow(PageDefaultValidationError);
  });

  it('normalizes Project Assets Extension and Tag selections with neutral all semantics', () => {
    const optionCatalogues = {
      extension: [
        { value: 'all', label: 'All extensions' },
        { value: 'png', label: '.png' },
        { value: 'jpg', label: '.jpg' },
      ],
      tag: [
        { value: 'all', label: 'All tags' },
        { value: '42', label: 'Design' },
        { value: '77', label: 'Reference' },
      ],
    };
    const values = {
      view: 'grid',
      gridSize: 'default',
      listSize: 'large',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
      extension: ['png', 'jpg', 'png'],
      tag: ['42', '77', '42'],
    };

    expect(service.validatePageDefaults('projectAssets', values, optionCatalogues)).toMatchObject({
      extension: ['png', 'jpg'],
      tag: ['42', '77'],
    });
    expect(service.validatePageDefaults('projectAssets', {
      ...values,
      extension: ['all'],
      tag: ['all'],
    }, optionCatalogues)).toMatchObject({ extension: 'all', tag: 'all' });
    expect(() => service.validatePageDefaults('projectAssets', {
      ...values,
      extension: ['all', 'png'],
      tag: ['all'],
    }, optionCatalogues)).toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault(
      'projectAssets',
      'extension',
      ['png', 'unsupported'],
      optionCatalogues.extension,
    )).toThrow(PageDefaultValidationError);
    expect(() => service.saveProjectDefault(
      'projectAssets',
      'tag',
      ['42', '99'],
      optionCatalogues.tag,
      { projectId: 1 },
    )).toThrow(PageDefaultValidationError);
  });

  it('persists Project Assets multi selections as JSON arrays and reads legacy scalar selections', () => {
    const extensionKey = PAGE_DEFAULT_DEFINITIONS.projectAssets.extension.key;
    const tagKey = PAGE_DEFAULT_DEFINITIONS.projectAssets.tag.key;
    const optionCatalogues = {
      extension: [
        { value: 'all', label: 'All extensions' },
        { value: 'png', label: '.png' },
        { value: 'jpg', label: '.jpg' },
      ],
      tag: [
        { value: 'all', label: 'All tags' },
        { value: '42', label: 'Design' },
        { value: '77', label: 'Reference' },
      ],
    };

    expect(service.saveDefault('projectAssets', 'extension', ['png', 'jpg'], optionCatalogues.extension))
      .toEqual(['png', 'jpg']);
    expect(repository.getValue(extensionKey)).toBe('["png","jpg"]');
    expect(service.resolve('projectAssets', 'extension', undefined, optionCatalogues.extension))
      .toEqual(['png', 'jpg']);

    expect(service.saveProjectDefault(
      'projectAssets',
      'tag',
      ['42', '77'],
      optionCatalogues.tag,
      { projectId: 1 },
    )).toEqual(['42', '77']);
    expect(projectPageDefaultRepository.getOption(1, 'projectAssets', 'tag')).toBe('["42","77"]');
    expect(service.resolve(
      'projectAssets',
      'tag',
      undefined,
      optionCatalogues.tag,
      { projectId: 1 },
    )).toEqual(['42', '77']);

    repository.setValue(extensionKey, 'png');
    projectPageDefaultRepository.setOption(1, 'projectAssets', 'tag', '42');
    expect(service.resolve('projectAssets', 'extension', undefined, optionCatalogues.extension))
      .toEqual(['png']);
    expect(service.resolve(
      'projectAssets',
      'tag',
      undefined,
      optionCatalogues.tag,
      { projectId: 1 },
    )).toEqual(['42']);
    expect(service.saveDefault('projectAssets', 'extension', 'all', optionCatalogues.extension)).toBe('all');
    expect(repository.getValue(extensionKey)).toBe('all');
    expect(service.resolve('projectAssets', 'extension', undefined, optionCatalogues.extension)).toBe('all');
  });

  it('keeps unrelated page-default options scalar', () => {
    expect(service.saveDefault('projects', 'view', 'list')).toBe('list');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('list');
    expect(service.resolve('projects', 'view')).toBe('list');
    expect(service.validatePageDefaults('projects', {
      view: 'grid',
      sort: 'created',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    }).view).toBe('grid');
  });

  it('keeps static definitions unchanged when no live catalogue is supplied', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'title');

    expect(service.resolve('projects', 'sort')).toBe('title');
    expect(service.validatePageDefaults('projects', {
      view: 'grid',
      sort: 'published',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    })).toEqual({
      view: 'grid',
      sort: 'published',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    });
  });

  it('keeps no-context reads and writes global without a project repository', () => {
    const globalOnlyService = createPageDefaultsService({ appMetaRepository: repository });

    expect(globalOnlyService.resolvePageDefaults('projects')).toEqual({
      view: 'grid',
      sort: 'created',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    });
    expect(globalOnlyService.saveDefault('projects', 'view', 'list')).toBe('list');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('list');
  });

  it('follows global defaults for projects without rows and isolates valid project overrides', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'modified');

    expect(service.getPageDefaultScope('projectAssets', { projectId: 1 })).toBe('global');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('modified');

    expect(service.saveProjectDefault('projectAssets', 'view', 'list', undefined, { projectId: 1 }))
      .toBe('list');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('modified');

    expect(service.saveProjectDefault('projectAssets', 'sort', 'size', undefined, { projectId: 1 }))
      .toBe('size');

    expect(service.getPageDefaultScope('projectAssets', { projectId: 1 })).toBe('project');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('size');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 2 }).sort).toBe('modified');
    expect(service.resolvePageDefaults(
      'projectAssets', { sort: 'category' }, {}, { projectId: 1 }
    ).sort).toBe('category');
  });

  it('inherits global values for missing or stale project options without rewriting either scope', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key;
    repository.setValue(key, 'modified');
    projectPageDefaultRepository.setOption(1, 'projectAssets', 'sort', 'retired');

    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('modified');
    expect(projectPageDefaultRepository.getOption(1, 'projectAssets', 'sort')).toBe('retired');
    expect(repository.getValue(key)).toBe('modified');

    repository.setValue(key, 'removed-global');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('filename');
    expect(projectPageDefaultRepository.getOption(1, 'projectAssets', 'sort')).toBe('retired');
    expect(repository.getValue(key)).toBe('removed-global');
  });

  it('honors live catalogues for global and project resolution', () => {
    const catalogue = [{ value: 'recent', label: 'Recent' }];
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'retired');
    projectPageDefaultRepository.setOption(1, 'projects', 'sort', 'recent');
    projectPageDefaultRepository.setOption(2, 'projects', 'sort', 'retired');

    expect(service.resolveGlobalPageDefaults('projects', { sort: catalogue }).sort).toBe('created');
    expect(service.resolveProjectPageDefaults('projects', { sort: catalogue }, { projectId: 1 }).sort)
      .toBe('recent');
    expect(service.resolveProjectPageDefaults('projects', { sort: catalogue }, { projectId: 2 }).sort)
      .toBe('created');

    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'recent');
    expect(service.resolveGlobalPageDefaults('projects', { sort: catalogue }).sort).toBe('recent');
    expect(service.resolveProjectPageDefaults('projects', { sort: catalogue }, { projectId: 2 }).sort)
      .toBe('recent');
  });

  it('writes global and project scopes independently and clears project following', () => {
    expect(service.saveProjectDefault('projects', 'view', 'list', undefined, { projectId: 1 }))
      .toBe('list');
    expect(service.saveGlobalDefault('projects', 'view', 'grid')).toBe('grid');

    expect(projectPageDefaultRepository.getOption(1, 'projects', 'view')).toBe('list');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('grid');
    expect(service.clearProjectPageDefaults('projects', { projectId: 1 })).toBe(true);
    expect(service.getPageDefaultScope('projects', { projectId: 1 })).toBe('global');
    expect(service.resolveProjectPageDefaults('projects', {}, { projectId: 1 }).view).toBe('grid');
  });

  it('rejects invalid project contexts and project writes without a configured repository', () => {
    const globalOnlyService = createPageDefaultsService({ appMetaRepository: repository });

    expect(() => service.saveProjectDefault('projects', 'view', 'list', undefined, { projectId: 0 }))
      .toThrow(PageDefaultValidationError);
    expect(() => globalOnlyService.saveProjectDefault(
      'projects', 'view', 'list', undefined, { projectId: 1 }
    )).toThrow('projectPageDefaultRepository');
  });
});
