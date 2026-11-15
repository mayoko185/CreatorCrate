import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectPageDefaultRepository } from '../src/data/project-page-default-repository.js';
import {
  createPageDefaultsService,
  PageDefaultValidationError,
  PAGE_DEFAULT_DEFINITIONS,
} from '../src/services/page-defaults-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function createInMemoryProjectPageDefaultRepository() {
  const values = new Map();
  const scopes = new Map();
  const keyFor = (projectId, page, option) => `${projectId}:${page}:${option}`;
  const scopeKeyFor = (projectId, page) => `${projectId}:${page}`;

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
    getPageScope(projectId, page) {
      return scopes.get(scopeKeyFor(projectId, page));
    },
    setPageScope(projectId, page, activeScope) {
      scopes.set(scopeKeyFor(projectId, page), activeScope);
      return activeScope;
    },
  };
}

describe('page defaults service', () => {
  let tmpDir;
  let db;
  let repository;
  let projectPageDefaultRepository;
  let statusCatalogue;
  let projectTypeCatalogue;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-default-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    projectPageDefaultRepository = createInMemoryProjectPageDefaultRepository();
    statusCatalogue = [
      { value: 'tbd', label: 'TBD', color: '#AAAAAA' },
      { value: 'planned', label: 'Planned', color: '#22D3EE' },
      { value: 'in-progress', label: 'In Progress', color: '#22D3EE' },
      { value: 'ready', label: 'Ready', color: '#34D399' },
      { value: 'completed', label: 'Completed', color: '#A78BFA' },
    ];
    projectTypeCatalogue = [
      { value: 'images', label: 'Images', color: '#AAAAAA' },
      { value: 'comic', label: 'Comic', color: '#22D3EE' },
      { value: 'animation', label: 'Animation', color: '#34D399' },
      { value: 'wallpaper', label: 'Wallpaper', color: '#A78BFA' },
    ];
    service = createPageDefaultsService({
      appMetaRepository: repository,
      projectPageDefaultRepository,
      projectOptionCatalogueService: {
        getStatusCatalogue: () => statusCatalogue.map((entry) => ({ ...entry })),
        getProjectTypeCatalogue: () => projectTypeCatalogue.map((entry) => ({ ...entry })),
      },
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the exact existing fallback when no saved value exists', () => {
    expect(service.resolve('projects', 'view')).toBe('grid');
    expect(service.resolve('projects', 'gridStyle')).toBe('uncropped');
    expect(service.resolve('projects', 'sort')).toBe('created');
    expect(service.resolve('projects', 'order')).toBe('desc');
    expect(service.resolve('releases', 'sort')).toBe('planned');
    expect(service.resolve('releases', 'order')).toBe('asc');
    expect(service.resolve('projectAssets', 'view')).toBe('grid');
    expect(service.resolve('projectAssets', 'gridStyle')).toBe('uncropped');
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
    expect(service.resolve('new_project', 'projectType')).toBe('images');
  });

  it('defines, persists, and safely validates the Book detail navigation default', () => {
    const definition = PAGE_DEFAULT_DEFINITIONS.bookDetail.navigation;
    expect(definition).toEqual({
      key: 'page_defaults.book_detail.navigation',
      values: ['expanded', 'collapsed'],
      fallback: 'collapsed',
    });
    expect(service.resolvePageDefaults('bookDetail')).toEqual({ navigation: 'collapsed' });

    expect(service.saveDefault('bookDetail', 'navigation', 'expanded')).toBe('expanded');
    expect(repository.getValue(definition.key)).toBe('expanded');
    expect(service.resolvePageDefaults('bookDetail')).toEqual({ navigation: 'expanded' });

    expect(service.saveDefault('bookDetail', 'navigation', 'collapsed')).toBe('collapsed');
    expect(service.resolvePageDefaults('bookDetail')).toEqual({ navigation: 'collapsed' });

    repository.setValue(definition.key, 'partially-expanded');
    expect(service.resolvePageDefaults('bookDetail')).toEqual({ navigation: 'collapsed' });
    expect(repository.getValue(definition.key)).toBe('partially-expanded');
    expect(() => service.validatePageDefaults('bookDetail', { navigation: 'partially-expanded' }))
      .toThrow(PageDefaultValidationError);
  });

  it('defines the exact Project Assets option allowlists, keys, and fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.projectAssets).toEqual({
      view: {
        key: 'page_defaults.project_assets.view',
        values: ['grid', 'list'],
        fallback: 'grid',
      },
      gridStyle: {
        key: 'page_defaults.project_assets.grid_style',
        values: ['uncropped', 'cropped'],
        fallback: 'uncropped',
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
        values: ['10', '25', '50', '100', '150', '200', 'all'],
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
      gridStyle: {
        key: 'page_defaults.asset_viewer.grid_style',
        values: ['uncropped', 'cropped'],
        fallback: 'uncropped',
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
        values: ['10', '25', '50', '100', '150', '200', 'all'],
        fallback: '25',
      },
      extension: {
        key: 'page_defaults.asset_viewer.extension',
        values: ['all'],
        fallback: 'all',
        multi: true,
      },
      category: {
        key: 'page_defaults.asset_viewer.category',
        values: ['all'],
        fallback: 'all',
        multi: true,
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
        multi: true,
      },
    });
  });

  it('defines only the operational New Projects fallbacks statically', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.new_project).toEqual({
      status: {
        key: 'page_defaults.new_project.status',
        values: ['tbd'],
        fallback: 'tbd',
      },
      projectType: {
        key: 'page_defaults.new_project.project_type',
        values: ['images'],
        fallback: 'images',
      },
    });
  });

  it('does not define an obsolete New Release status default', () => {
    expect(PAGE_DEFAULT_DEFINITIONS).not.toHaveProperty('new_release');
  });

  it('defines only Projects filter sentinels statically', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.projects).toEqual({
      view: {
        key: 'page_defaults.projects.view',
        values: ['grid', 'list'],
        fallback: 'grid',
      },
      gridStyle: {
        key: 'page_defaults.projects.grid_style',
        values: ['uncropped', 'cropped'],
        fallback: 'uncropped',
      },
      sort: {
        key: 'page_defaults.projects.sort',
        values: ['updated', 'created', 'title'],
        fallback: 'created',
      },
      order: {
        key: 'page_defaults.projects.order',
        values: ['asc', 'desc'],
        fallback: 'desc',
      },
      status: {
        key: 'page_defaults.projects.status',
        values: ['all'],
        fallback: 'all',
        multi: true,
      },
      projectType: {
        key: 'page_defaults.projects.project_type',
        values: ['all'],
        fallback: 'all',
        multi: true,
      },
      tag: {
        key: 'page_defaults.projects.tag',
        values: ['all'],
        fallback: 'all',
        multi: true,
      },
    });
  });

  it('resolves the Projects Grid style to Uncropped until Cropped is saved, without writing on read', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.projects.gridStyle.key;

    expect(service.resolve('projects', 'gridStyle')).toBe('uncropped');
    expect(service.getSavedDefault('projects', 'gridStyle')).toBeUndefined();
    expect(repository.getValue(key)).toBeUndefined();

    repository.setValue(key, 'square');
    expect(service.resolve('projects', 'gridStyle')).toBe('uncropped');
    expect(repository.getValue(key)).toBe('square');

    expect(service.saveDefault('projects', 'gridStyle', 'cropped')).toBe('cropped');
    expect(repository.getValue(key)).toBe('cropped');
    expect(service.resolve('projects', 'gridStyle')).toBe('cropped');
    expect(() => service.saveDefault('projects', 'gridStyle', 'stretched'))
      .toThrow(PageDefaultValidationError);
    expect(repository.getValue(key)).toBe('cropped');
  });

  it('resolves the Asset Viewer Grid style to Uncropped until Cropped is saved, without writing on read', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.assetViewer.gridStyle.key;

    expect(key).toBe('page_defaults.asset_viewer.grid_style');
    expect(service.resolve('assetViewer', 'gridStyle')).toBe('uncropped');
    expect(repository.getValue(key)).toBeUndefined();

    repository.setValue(key, 'square');
    expect(service.resolve('assetViewer', 'gridStyle')).toBe('uncropped');
    expect(repository.getValue(key)).toBe('square');

    expect(service.saveDefault('assetViewer', 'gridStyle', 'cropped')).toBe('cropped');
    expect(repository.getValue(key)).toBe('cropped');
    expect(service.resolve('assetViewer', 'gridStyle')).toBe('cropped');
    expect(service.resolve('projects', 'gridStyle')).toBe('uncropped');
    expect(() => service.saveDefault('assetViewer', 'gridStyle', 'stretched'))
      .toThrow(PageDefaultValidationError);
    expect(repository.getValue(key)).toBe('cropped');
  });

  it.each(['published', 'planned'])(
    'uses the Projects fallback for obsolete stored %s sorting without rewriting unrelated preferences',
    (obsoleteSort) => {
      const sortKey = PAGE_DEFAULT_DEFINITIONS.projects.sort.key;
      const viewKey = PAGE_DEFAULT_DEFINITIONS.projects.view.key;
      repository.setValue(sortKey, obsoleteSort);
      repository.setValue(viewKey, 'list');

      expect(service.getSavedDefault('projects', 'sort')).toBeUndefined();
      expect(service.resolvePageDefaults('projects')).toEqual({
        view: 'list',
        gridStyle: 'uncropped',
        sort: 'created',
        order: 'desc',
        status: 'all',
        projectType: 'all',
        tag: 'all',
      });
      expect(repository.getValue(sortKey)).toBe(obsoleteSort);
      expect(repository.getValue(viewKey)).toBe('list');
    },
  );

  it('keeps the Release page-default configuration unchanged', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.releases).toEqual({
      sort: {
        key: 'page_defaults.releases.sort',
        values: ['planned', 'updated', 'created', 'title'],
        fallback: 'planned',
      },
      order: {
        key: 'page_defaults.releases.order',
        values: ['asc', 'desc'],
        fallback: 'asc',
      },
    });
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
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_project.projectType.key, 'comic');

    expect(service.getSavedDefault('new_project', 'status')).toBe('ready');
    expect(service.getSavedDefault('new_project', 'projectType')).toBe('comic');
    expect(service.resolvePageDefaults('new_project')).toEqual({
      status: 'ready',
      projectType: 'comic',
    });
  });

  it('ignores legacy New Project Priority storage while resolving supported defaults', () => {
    const legacyKey = 'page_defaults.new_project.priority';
    repository.setValue(legacyKey, 'high');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.new_project.status.key, 'ready');

    expect(PAGE_DEFAULT_DEFINITIONS.new_project).not.toHaveProperty('priority');
    expect(service.resolvePageDefaults('new_project')).toEqual({ status: 'ready', projectType: 'images' });
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
    const obsoleteGridDetailsKey = 'page_defaults.project_assets.grid_details';
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.gridSize.key, 'large');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.listSize.key, 'compact');
    repository.setValue(obsoleteGridDetailsKey, 'hidden');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.gridStyle.key, 'cropped');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'category');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.pageSize.key, '100');

    expect(service.resolvePageDefaults('projectAssets')).toEqual({
      view: 'list',
      gridStyle: 'cropped',
      gridSize: 'large',
      listSize: 'compact',
      sort: 'category',
      order: 'desc',
      pageSize: '100',
      extension: 'all',
      tag: 'all',
    });
    expect(service.resolvePageDefaults('projectAssets')).not.toHaveProperty('gridDetails');
    expect(repository.getValue(obsoleteGridDetailsKey)).toBe('hidden');
  });

  it('accepts valid Asset Viewer saved values, including project sorting', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.sort.key, 'project');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.pageSize.key, '100');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.assetViewer.gridStyle.key, 'cropped');

    expect(service.resolvePageDefaults('assetViewer')).toEqual({
      view: 'list',
      gridStyle: 'cropped',
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

  it('uses New Project fallbacks for stale stored values without rewriting them', () => {
    const statusKey = PAGE_DEFAULT_DEFINITIONS.new_project.status.key;
    const typeKey = PAGE_DEFAULT_DEFINITIONS.new_project.projectType.key;
    repository.setValue(statusKey, 'cancelled');
    repository.setValue(typeKey, 'deleted-type');

    expect(service.resolvePageDefaults('new_project')).toEqual({ status: 'tbd', projectType: 'images' });
    expect(repository.getValue(statusKey)).toBe('cancelled');
    expect(repository.getValue(typeKey)).toBe('deleted-type');
    expect(service.getSavedDefault('new_project', 'status')).toBeUndefined();
    expect(service.getSavedDefault('new_project', 'projectType')).toBeUndefined();
  });

  it('uses live ordered Project catalogues for global and project-scoped defaults', () => {
    statusCatalogue = [
      { value: 'client-review', label: 'Client Review', color: '#123456' },
      ...statusCatalogue,
    ];
    projectTypeCatalogue = [
      ...projectTypeCatalogue,
      { value: 'interactive', label: 'Interactive', color: '#654321' },
    ];

    expect(service.getOptionCatalogue('new_project', 'status'))
      .toEqual(statusCatalogue);
    expect(service.getOptionCatalogue('new_project', 'projectType'))
      .toEqual(projectTypeCatalogue);
    expect(service.getOptionCatalogue('projects', 'projectType').map(({ value }) => value))
      .toEqual(['all', 'images', 'comic', 'animation', 'wallpaper', 'interactive']);

    expect(service.saveDefault('new_project', 'status', 'client-review')).toBe('client-review');
    expect(service.saveDefault('new_project', 'projectType', 'interactive')).toBe('interactive');
    // WP2: Projects filter defaults are multivalue; one value saves as a
    // one-value selection in the established JSON-array representation.
    expect(service.saveDefault('projects', 'status', 'client-review')).toEqual(['client-review']);
    expect(service.saveDefault('projects', 'projectType', 'interactive')).toEqual(['interactive']);
    expect(service.saveProjectDefault(
      'projects', 'projectType', 'interactive', undefined, { projectId: 1 },
    )).toEqual(['interactive']);

    statusCatalogue = statusCatalogue.filter(({ value }) => value !== 'client-review');
    projectTypeCatalogue = projectTypeCatalogue.filter(({ value }) => value !== 'interactive');

    expect(service.resolve('new_project', 'status')).toBe('tbd');
    expect(service.resolve('new_project', 'projectType')).toBe('images');
    expect(service.resolveGlobalPageDefaults('projects').status).toBe('all');
    expect(service.resolveGlobalPageDefaults('projects').projectType).toBe('all');
    expect(service.resolveProjectPageDefaults('projects', {}, { projectId: 1 }).projectType)
      .toBe('all');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.new_project.status.key)).toBe('client-review');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.new_project.projectType.key)).toBe('interactive');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.status.key)).toBe('["client-review"]');
    expect(projectPageDefaultRepository.getOption(1, 'projects', 'projectType')).toBe('["interactive"]');
  });

  it('treats Archived as a Projects-filter system value without exposing it to New Project defaults', () => {
    expect(statusCatalogue.map(({ value }) => value)).not.toContain('archived');
    expect(service.getOptionCatalogue('projects', 'status')).toEqual([
      { value: 'all', label: 'All active' },
      ...statusCatalogue,
      { value: 'archived', label: 'Archived' },
    ]);

    expect(service.saveDefault('projects', 'status', 'archived')).toEqual(['archived']);
    expect(service.getSavedDefault('projects', 'status')).toEqual(['archived']);
    expect(service.resolvePageDefaults('projects').status).toEqual(['archived']);
    expect(() => service.saveDefault('new_project', 'status', 'archived'))
      .toThrow(PageDefaultValidationError);
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
      gridStyle: 'square',
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
      gridStyle: 'uncropped',
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
      gridStyle: 'square',
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
      gridStyle: 'uncropped',
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
    expect(() => service.saveDefault('projectAssets', 'gridDetails', 'hidden'))
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

  it.each(['150', '200', 'all'])('supports %s as both Global and Project-only Project Assets page size', (pageSize) => {
    expect(service.saveDefault('projectAssets', 'pageSize', pageSize)).toBe(pageSize);
    expect(service.resolveGlobalPageDefaults('projectAssets').pageSize).toBe(pageSize);

    expect(service.saveProjectDefault(
      'projectAssets',
      'pageSize',
      pageSize,
      undefined,
      { projectId: 1 },
    )).toBe(pageSize);
    service.setPageDefaultScope('projectAssets', 'project', { projectId: 1 });

    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 }).pageSize).toBe(pageSize);
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 2 }).pageSize).toBe(pageSize);
  });

  it('scopes the Project Assets Grid style per project with Global inheritance', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.projectAssets.gridStyle.key;
    const effective = (projectId) => service.resolvePageDefaults(
      'projectAssets', {}, {}, { projectId },
    ).gridStyle;

    expect(effective(1)).toBe('uncropped');
    expect(() => service.saveProjectDefault('projectAssets', 'gridStyle', 'square', undefined, { projectId: 1 }))
      .toThrow(PageDefaultValidationError);

    expect(service.saveProjectDefault('projectAssets', 'gridStyle', 'cropped', undefined, { projectId: 1 }))
      .toBe('cropped');
    expect(repository.getValue(key)).toBeUndefined();
    // Stored Project-only values stay dormant until that project selects its scope.
    expect(effective(1)).toBe('uncropped');
    service.setPageDefaultScope('projectAssets', 'project', { projectId: 1 });
    service.setPageDefaultScope('projectAssets', 'project', { projectId: 2 });
    expect(effective(1)).toBe('cropped');
    expect(effective(2)).toBe('uncropped');

    // Project 2 has no Project-only value, so it follows the Global value;
    // the Global save leaves project 1's Project-only value intact.
    service.saveDefault('projectAssets', 'gridStyle', 'cropped');
    service.saveProjectDefault('projectAssets', 'gridStyle', 'uncropped', undefined, { projectId: 1 });
    expect(effective(1)).toBe('uncropped');
    expect(effective(2)).toBe('cropped');
    expect(service.resolveGlobalPageDefaults('projectAssets').gridStyle).toBe('cropped');

    projectPageDefaultRepository.setOption(2, 'projectAssets', 'gridStyle', 'stretched');
    expect(effective(2)).toBe('cropped');
    service.setPageDefaultScope('projectAssets', 'global', { projectId: 1 });
    expect(effective(1)).toBe('cropped');
    expect(projectPageDefaultRepository.getOption(1, 'projectAssets', 'gridStyle')).toBe('uncropped');
  });

  it('keeps a Project-only all page size ahead of a finite Global value', () => {
    service.saveDefault('projectAssets', 'pageSize', '150');
    service.saveProjectDefault('projectAssets', 'pageSize', 'all', undefined, { projectId: 1 });
    service.setPageDefaultScope('projectAssets', 'project', { projectId: 1 });

    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 }).pageSize).toBe('all');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 2 }).pageSize).toBe('150');
    expect(service.resolvePageDefaults(
      'projectAssets',
      { pageSize: '200' },
      {},
      { projectId: 1 },
    ).pageSize).toBe('200');
  });

  it('resolves all page options with explicit values taking precedence', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key, 'list');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projects.sort.key, 'title');

    expect(service.resolvePageDefaults('projects', { view: 'grid' })).toEqual({
      view: 'grid',
      gridStyle: 'uncropped',
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
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.gridStyle.key, 'cropped');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.order.key, 'desc');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.pageSize.key, '100');

    expect(service.resolvePageDefaults('projectAssets', {
      view: 'grid',
      gridSize: 'compact',
      listSize: 'large',
      pageSize: '10',
    })).toEqual({
      view: 'grid',
      gridStyle: 'cropped',
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
      gridStyle: 'cropped',
      gridSize: 'large',
      listSize: 'compact',
      sort: 'modified',
      order: 'desc',
      pageSize: '50',
      extension: 'all',
      tag: 'all',
    })).toEqual({
      view: 'grid',
      gridStyle: 'cropped',
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
      gridStyle: 'cropped',
      sort: 'project',
      order: 'desc',
      pageSize: '100',
      extension: 'all',
      category: 'all',
      presence: 'all',
      tag: 'all',
    })).toEqual({
      view: 'list',
      gridStyle: 'cropped',
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
      gridStyle: 'uncropped',
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
      gridStyle: 'uncropped',
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
      gridStyle: 'uncropped',
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
      gridStyle: 'uncropped',
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
    service.setPageDefaultScope('projectAssets', 'project', { projectId: 1 });
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

  it('applies definition-driven multi-value persistence to Asset Viewer Extension and Tag', () => {
    const extensionKey = PAGE_DEFAULT_DEFINITIONS.assetViewer.extension.key;
    const tagKey = PAGE_DEFAULT_DEFINITIONS.assetViewer.tag.key;
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

    expect(service.saveDefault('assetViewer', 'extension', ['png', 'jpg'], optionCatalogues.extension))
      .toEqual(['png', 'jpg']);
    expect(service.saveDefault('assetViewer', 'tag', ['42', '77'], optionCatalogues.tag))
      .toEqual(['42', '77']);
    expect(repository.getValue(extensionKey)).toBe('["png","jpg"]');
    expect(repository.getValue(tagKey)).toBe('["42","77"]');
    expect(service.resolvePageDefaults('assetViewer', {}, optionCatalogues)).toMatchObject({
      extension: ['png', 'jpg'],
      tag: ['42', '77'],
    });

    repository.setValue(extensionKey, 'png');
    repository.setValue(tagKey, '42');
    expect(service.resolvePageDefaults('assetViewer', {}, optionCatalogues)).toMatchObject({
      extension: ['png'],
      tag: ['42'],
    });

    expect(() => service.saveDefault(
      'assetViewer', 'extension', ['png', 'unsupported'], optionCatalogues.extension,
    )).toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault(
      'assetViewer', 'tag', ['42', '99'], optionCatalogues.tag,
    )).toThrow(PageDefaultValidationError);
    expect(service.saveDefault('assetViewer', 'extension', 'all', optionCatalogues.extension)).toBe('all');
    expect(repository.getValue(extensionKey)).toBe('all');

    expect(service.saveDefault('projectAssets', 'extension', ['png', 'jpg'], optionCatalogues.extension))
      .toEqual(['png', 'jpg']);
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.extension.key))
      .toBe('["png","jpg"]');
  });

  it('keeps unrelated page-default options scalar', () => {
    expect(service.saveDefault('projects', 'view', 'list')).toBe('list');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('list');
    expect(service.resolve('projects', 'view')).toBe('list');
    expect(service.validatePageDefaults('projects', {
      view: 'grid',
      gridStyle: 'uncropped',
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
      gridStyle: 'uncropped',
      sort: 'updated',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    })).toEqual({
      view: 'grid',
      gridStyle: 'uncropped',
      sort: 'updated',
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
      gridStyle: 'uncropped',
      sort: 'created',
      order: 'desc',
      status: 'all',
      projectType: 'all',
      tag: 'all',
    });
    expect(globalOnlyService.saveDefault('projects', 'view', 'list')).toBe('list');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('list');
  });

  it('keeps active Global independent from dormant Project rows', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'modified');

    expect(service.getPageDefaultScope('projectAssets', { projectId: 1 })).toBe('global');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 }).sort).toBe('modified');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('modified');

    expect(service.saveProjectDefault('projectAssets', 'view', 'list', undefined, { projectId: 1 }))
      .toBe('list');
    expect(service.saveProjectDefault('projectAssets', 'sort', 'size', undefined, { projectId: 1 }))
      .toBe('size');

    expect(service.getPageDefaultScope('projectAssets', { projectId: 1 })).toBe('global');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 }).sort).toBe('modified');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('size');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 2 }).sort).toBe('modified');

    expect(service.setPageDefaultScope('projectAssets', 'project', { projectId: 1 })).toBe('project');
    expect(service.getPageDefaultScope('projectAssets', { projectId: 1 })).toBe('project');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 })).toMatchObject({
      view: 'list',
      sort: 'size',
    });
    expect(service.resolveGlobalPageDefaults('projectAssets').sort).toBe('modified');

    expect(service.setPageDefaultScope('projectAssets', 'global', { projectId: 1 })).toBe('global');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 }).sort).toBe('modified');
    expect(service.resolveProjectPageDefaults('projectAssets', {}, { projectId: 1 }).sort).toBe('size');
    expect(projectPageDefaultRepository.getOption(1, 'projectAssets', 'sort')).toBe('size');
    expect(service.resolvePageDefaults(
      'projectAssets', { sort: 'category' }, {}, { projectId: 1 }
    ).sort).toBe('category');
  });

  it('uses partial Project values with Global fallback only while Project is active', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.view.key, 'grid');
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'modified');
    service.saveProjectDefault('projectAssets', 'view', 'list', undefined, { projectId: 1 });

    service.setPageDefaultScope('projectAssets', 'project', { projectId: 1 });
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 })).toMatchObject({
      view: 'list',
      sort: 'modified',
    });

    service.clearProjectPageDefaults('projectAssets', { projectId: 1 });
    expect(service.getPageDefaultScope('projectAssets', { projectId: 1 })).toBe('project');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 })).toMatchObject({
      view: 'grid',
      sort: 'modified',
    });
  });

  it('falls back safely for invalid stored scope and rejects invalid scope writes', () => {
    repository.setValue(PAGE_DEFAULT_DEFINITIONS.projectAssets.sort.key, 'modified');
    projectPageDefaultRepository.setOption(1, 'projectAssets', 'sort', 'size');
    projectPageDefaultRepository.setPageScope(1, 'projectAssets', 'retired');

    expect(service.getPageDefaultScope('projectAssets', { projectId: 1 })).toBe('global');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: 1 }).sort).toBe('modified');
    expect(() => service.setPageDefaultScope('projectAssets', 'retired', { projectId: 1 }))
      .toThrow(PageDefaultValidationError);
    expect(projectPageDefaultRepository.getPageScope(1, 'projectAssets')).toBe('retired');
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

  it('writes global and project values independently without coupling scope to clearing', () => {
    expect(service.saveProjectDefault('projects', 'view', 'list', undefined, { projectId: 1 }))
      .toBe('list');
    expect(service.saveGlobalDefault('projects', 'view', 'grid')).toBe('grid');
    expect(service.setPageDefaultScope('projects', 'project', { projectId: 1 })).toBe('project');

    expect(projectPageDefaultRepository.getOption(1, 'projects', 'view')).toBe('list');
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('grid');
    expect(service.clearProjectPageDefaults('projects', { projectId: 1 })).toBe(true);
    expect(service.getPageDefaultScope('projects', { projectId: 1 })).toBe('project');
    expect(service.resolvePageDefaults('projects', {}, {}, { projectId: 1 }).view).toBe('grid');
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

describe('page defaults saved-state metadata and scoped reset (WP1)', () => {
  let tmpDir;
  let db;
  let appMeta;
  let projectDefaults;
  let service;
  let firstId;
  let secondId;
  const assetKeys = PAGE_DEFAULT_DEFINITIONS.projectAssets;
  const countRows = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  const writeRaw = (key, value) => db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-default-reset-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    appMeta = createAppMetaRepository(db);
    projectDefaults = createProjectPageDefaultRepository(db);
    const projects = createProjectRepository(db);
    const create = (title) => projects.create({
      title,
      slug: title.toLowerCase().replaceAll(' ', '-'),
      description: '',
      notes: '',
      status: 'tbd',
      projectType: 'images',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    }).id;
    firstId = create('Reset First');
    secondId = create('Reset Second');
    service = createPageDefaultsService({
      appMetaRepository: appMeta,
      projectPageDefaultRepository: projectDefaults,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no saved defaults without writing on read', () => {
    const tables = ['app_meta', 'project_page_defaults', 'project_page_default_scopes'];
    const before = tables.map(countRows);
    const state = service.describeSavedDefaults('projectAssets', {}, { projectId: firstId });

    expect(state).toMatchObject({
      page: 'projectAssets',
      activeScope: 'global',
      hasSavedDefaults: false,
      global: { saved: false, invalid: false, active: true },
      project: {
        projectId: firstId,
        storedScope: null,
        active: false,
        saved: false,
        invalid: false,
        inheritance: 'full',
      },
    });
    expect(state.options.sort).toEqual({
      global: { stored: false, valid: false },
      project: { stored: false, valid: false },
      source: 'fallback',
    });
    expect(service.describeSavedDefaults('projects')).not.toHaveProperty('project');
    expect(tables.map(countRows)).toEqual(before);
  });

  it('counts fallback-equal and empty saved values as saved and retained invalid values as stored', () => {
    service.saveDefault('projectAssets', 'sort', assetKeys.sort.fallback);
    writeRaw(assetKeys.gridStyle.key, 'square');
    service.saveDefault('logs', 'level', '');

    const state = service.describeSavedDefaults('projectAssets');
    expect(state.hasSavedDefaults).toBe(true);
    expect(state.global).toEqual({ saved: true, invalid: true, active: true });
    expect(state.options.sort).toEqual({ global: { stored: true, valid: true }, source: 'global' });
    expect(state.options.gridStyle).toEqual({ global: { stored: true, valid: false }, source: 'fallback' });
    expect(state.options.view.global.stored).toBe(false);
    expect(appMeta.getValue(assetKeys.gridStyle.key)).toBe('square');

    expect(service.describeSavedDefaults('logs').options.level.global).toEqual({ stored: true, valid: true });
  });

  it('distinguishes active, inactive, empty, partial, and complete project overrides', () => {
    service.saveDefault('projectAssets', 'sort', 'modified');
    service.saveProjectDefault('projectAssets', 'view', 'list', undefined, { projectId: firstId });
    projectDefaults.setOption(firstId, 'projectAssets', 'order', 'sideways');

    // Stored but inactive: Global stays the source for every option.
    let state = service.describeSavedDefaults('projectAssets', {}, { projectId: firstId });
    expect(state.activeScope).toBe('global');
    expect(state.project).toMatchObject({ active: false, saved: true, invalid: true, inheritance: 'full' });
    expect(state.options.view.source).toBe('fallback');

    // Active with partial overrides; the invalid order row is inherited, not absent.
    service.setPageDefaultScope('projectAssets', 'project', { projectId: firstId });
    state = service.describeSavedDefaults('projectAssets', {}, { projectId: firstId });
    expect(state.activeScope).toBe('project');
    expect(state.global.active).toBe(false);
    expect(state.project).toMatchObject({ storedScope: 'project', active: true, inheritance: 'partial' });
    expect(state.options.view).toEqual({
      global: { stored: false, valid: false },
      project: { stored: true, valid: true },
      source: 'project',
    });
    expect(state.options.sort.source).toBe('global');
    expect(state.options.order).toMatchObject({ project: { stored: true, valid: false }, source: 'fallback' });

    // Active with no overrides inherits everything.
    service.setPageDefaultScope('projectAssets', 'project', { projectId: secondId });
    expect(service.describeSavedDefaults('projectAssets', {}, { projectId: secondId }).project)
      .toMatchObject({ active: true, saved: false, inheritance: 'full' });

    // Active with every option overridden inherits nothing.
    for (const option of Object.keys(assetKeys)) {
      service.saveProjectDefault(
        'projectAssets', option, assetKeys[option].fallback, undefined, { projectId: secondId },
      );
    }
    expect(service.describeSavedDefaults('projectAssets', {}, { projectId: secondId }).project.inheritance)
      .toBe('none');
  });

  it('resets only the page recognized Global keys and is an accurate no-op when repeated', () => {
    service.saveDefault('projectAssets', 'sort', 'modified');
    service.saveDefault('projectAssets', 'view', assetKeys.view.fallback);
    service.saveDefault('projects', 'view', 'list');
    writeRaw('page_defaults.project_assets.legacy_option', 'kept');
    writeRaw('settings.unrelated', 'kept');
    service.saveProjectDefault('projectAssets', 'sort', 'size', undefined, { projectId: firstId });
    service.setPageDefaultScope('projectAssets', 'project', { projectId: firstId });

    expect(service.resetGlobalPageDefaults('projectAssets')).toEqual({
      page: 'projectAssets', scope: 'global', changed: true, deletedOptions: ['view', 'sort'],
    });
    expect(appMeta.getValue(assetKeys.sort.key)).toBeUndefined();
    expect(appMeta.getValue(assetKeys.view.key)).toBeUndefined();
    expect(appMeta.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBe('list');
    expect(appMeta.getValue('page_defaults.project_assets.legacy_option')).toBe('kept');
    expect(appMeta.getValue('settings.unrelated')).toBe('kept');
    expect(projectDefaults.getPageOptions(firstId, 'projectAssets')).toEqual({ sort: 'size' });
    expect(service.getPageDefaultScope('projectAssets', { projectId: firstId })).toBe('project');
    expect(service.resolveGlobalPageDefaults('projectAssets').sort).toBe(assetKeys.sort.fallback);
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: firstId }).sort).toBe('size');

    expect(service.resetGlobalPageDefaults('projectAssets')).toEqual({
      page: 'projectAssets', scope: 'global', changed: false, deletedOptions: [],
    });
    expect(() => service.resetGlobalPageDefaults('settings')).toThrow(PageDefaultValidationError);
    expect(() => service.resetGlobalPageDefaults('__proto__')).toThrow(PageDefaultValidationError);
  });

  it('leaves every Global key in place when one deletion fails', () => {
    service.saveDefault('projectAssets', 'view', 'list');
    service.saveDefault('projectAssets', 'sort', 'modified');
    db.exec(`
      CREATE TRIGGER fail_sort_delete BEFORE DELETE ON app_meta
      WHEN OLD.key = '${assetKeys.sort.key}'
      BEGIN SELECT RAISE(ABORT, 'forced'); END;
    `);

    expect(() => service.resetGlobalPageDefaults('projectAssets')).toThrow('forced');
    expect(appMeta.getValue(assetKeys.view.key)).toBe('list');
    expect(appMeta.getValue(assetKeys.sort.key)).toBe('modified');
  });

  it('resets one project overrides to Global without touching Global or other projects', () => {
    service.saveDefault('projectAssets', 'sort', 'modified');
    for (const projectId of [firstId, secondId]) {
      service.saveProjectDefault('projectAssets', 'view', 'list', undefined, { projectId });
      service.setPageDefaultScope('projectAssets', 'project', { projectId });
    }
    projectDefaults.setOption(firstId, 'projects', 'view', 'list');

    expect(service.resetProjectPageDefaults('projectAssets', { projectId: firstId })).toEqual({
      page: 'projectAssets',
      scope: 'project',
      projectId: firstId,
      changed: true,
      deletedOptions: ['view'],
      previousScope: 'project',
      activeScope: 'global',
      scopeChanged: true,
    });
    expect(projectDefaults.getPageOptions(firstId, 'projectAssets')).toEqual({});
    expect(projectDefaults.getPageScope(firstId, 'projectAssets')).toBe('global');
    expect(projectDefaults.getPageOptions(firstId, 'projects')).toEqual({ view: 'list' });
    expect(projectDefaults.getPageOptions(secondId, 'projectAssets')).toEqual({ view: 'list' });
    expect(projectDefaults.getPageScope(secondId, 'projectAssets')).toBe('project');
    expect(appMeta.getValue(assetKeys.sort.key)).toBe('modified');
    expect(service.resolvePageDefaults('projectAssets', {}, {}, { projectId: firstId }))
      .toMatchObject({ view: assetKeys.view.fallback, sort: 'modified' });

    // Nothing left to reset: no rows deleted and no scope row written.
    db.prepare('DELETE FROM project_page_default_scopes WHERE project_id = ?').run(firstId);
    expect(service.resetProjectPageDefaults('projectAssets', { projectId: firstId })).toMatchObject({
      changed: false, deletedOptions: [], previousScope: 'global', scopeChanged: false,
    });
    expect(projectDefaults.getPageScope(firstId, 'projectAssets')).toBeUndefined();
  });

  it('keeps the project overrides and Project-only scope when restoring Global fails', () => {
    service.saveProjectDefault('projectAssets', 'view', 'list', undefined, { projectId: firstId });
    service.setPageDefaultScope('projectAssets', 'project', { projectId: firstId });
    db.exec(`
      CREATE TRIGGER fail_scope_update BEFORE UPDATE ON project_page_default_scopes
      BEGIN SELECT RAISE(ABORT, 'forced'); END;
    `);

    expect(() => service.resetProjectPageDefaults('projectAssets', { projectId: firstId }))
      .toThrow('forced');
    expect(projectDefaults.getPageOptions(firstId, 'projectAssets')).toEqual({ view: 'list' });
    expect(projectDefaults.getPageScope(firstId, 'projectAssets')).toBe('project');
  });

  describe('scope activation (WP3)', () => {
    const optionRows = () => db.prepare(`
      SELECT project_id, page_key, option_key, value, updated_at FROM project_page_defaults
      ORDER BY project_id, page_key, option_key
    `).all();
    const scopeRows = () => db.prepare(`
      SELECT project_id, page_key, active_scope, updated_at FROM project_page_default_scopes
      ORDER BY project_id, page_key
    `).all();
    const metaRows = () => db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();
    const first = () => ({ projectId: firstId });

    it('activates Project only without creating override rows; missing values inherit Global', () => {
      service.saveDefault('projectAssets', 'sort', 'modified');
      service.saveDefault('projects', 'view', 'list');
      const optionsBefore = optionRows();
      const metaBefore = metaRows();

      const activation = service.activatePageDefaultScope('projectAssets', 'project', first());

      expect(activation).toEqual({
        page: 'projectAssets', projectId: firstId, previousScope: 'global', activeScope: 'project', changed: true,
      });
      expect(optionRows()).toEqual(optionsBefore);
      expect(metaRows()).toEqual(metaBefore);
      expect(projectDefaults.getPageOptions(firstId, 'projectAssets')).toEqual({});
      expect(service.resolvePageDefaults('projectAssets', {}, {}, first()).sort).toBe('modified');
      expect(service.describeSavedDefaults('projectAssets', {}, first())).toMatchObject({
        activeScope: 'project',
        global: { saved: true, active: false },
        project: { storedScope: 'project', active: true, saved: false, inheritance: 'full' },
      });
    });

    it('activates Global keeping dormant overrides stored but inactive, and reactivates them', () => {
      service.saveDefault('projectAssets', 'sort', 'modified');
      service.saveProjectDefault('projectAssets', 'view', 'list', undefined, first());
      service.saveProjectDefault('projectAssets', 'sort', 'size', undefined, first());
      service.setPageDefaultScope('projectAssets', 'project', first());
      const optionsBefore = optionRows();
      const metaBefore = metaRows();

      const toGlobal = service.activatePageDefaultScope('projectAssets', 'global', first());
      expect(toGlobal).toMatchObject({ previousScope: 'project', activeScope: 'global', changed: true });
      expect(optionRows()).toEqual(optionsBefore);
      expect(metaRows()).toEqual(metaBefore);
      expect(service.resolvePageDefaults('projectAssets', {}, {}, first())).toMatchObject({
        view: 'grid', sort: 'modified',
      });
      const dormant = service.describeSavedDefaults('projectAssets', {}, first());
      expect(dormant).toMatchObject({
        activeScope: 'global',
        global: { active: true },
        project: { active: false, saved: true, inheritance: 'full' },
      });
      expect(dormant.options.view).toMatchObject({ project: { stored: true, valid: true }, source: 'fallback' });

      const toProject = service.activatePageDefaultScope('projectAssets', 'project', first());
      expect(toProject).toMatchObject({ previousScope: 'global', activeScope: 'project', changed: true });
      expect(optionRows()).toEqual(optionsBefore);
      expect(service.resolvePageDefaults('projectAssets', {}, {}, first())).toMatchObject({
        view: 'list', sort: 'size', order: 'asc',
      });
      expect(service.describeSavedDefaults('projectAssets', {}, first()).project)
        .toMatchObject({ active: true, saved: true, inheritance: 'partial' });
    });

    it('treats a repeated activation as a no-op that writes nothing', () => {
      const global = service.activatePageDefaultScope('projectAssets', 'global', first());
      expect(global).toMatchObject({ previousScope: 'global', activeScope: 'global', changed: false });
      expect(scopeRows()).toEqual([]);

      service.activatePageDefaultScope('projectAssets', 'project', first());
      const before = scopeRows();
      const repeated = service.activatePageDefaultScope('projectAssets', 'project', first());
      expect(repeated).toMatchObject({ previousScope: 'project', activeScope: 'project', changed: false });
      expect(scopeRows()).toEqual(before);
    });

    it('leaves other projects and startup preferences untouched', () => {
      service.saveProjectDefault('projectAssets', 'view', 'list', undefined, { projectId: secondId });
      service.setPageDefaultScope('projectAssets', 'project', { projectId: secondId });
      const secondBefore = { options: optionRows(), scope: projectDefaults.getPageScope(secondId, 'projectAssets') };

      service.activatePageDefaultScope('projectAssets', 'project', first());
      service.activatePageDefaultScope('projectAssets', 'global', first());

      expect(optionRows()).toEqual(secondBefore.options);
      expect(projectDefaults.getPageScope(secondId, 'projectAssets')).toBe(secondBefore.scope);
    });

    it('rejects an unsupported scope or project before any write', () => {
      const before = [optionRows(), scopeRows(), metaRows()];
      for (const call of [
        () => service.activatePageDefaultScope('projectAssets', 'everything', first()),
        () => service.activatePageDefaultScope('projectAssets', undefined, first()),
        () => service.activatePageDefaultScope('projectAssets', 'project', { projectId: 0 }),
        () => service.activatePageDefaultScope('projectAssets', 'project', undefined),
      ]) expect(call).toThrow(PageDefaultValidationError);
      expect(() => service.activatePageDefaultScope('nope', 'project', first())).toThrow();
      expect([optionRows(), scopeRows(), metaRows()]).toEqual(before);
    });

    it('surfaces a storage failure and keeps the previous scope', () => {
      service.setPageDefaultScope('projectAssets', 'project', first());
      db.exec(`
        CREATE TRIGGER fail_scope_activation BEFORE UPDATE ON project_page_default_scopes
        BEGIN SELECT RAISE(ABORT, 'forced'); END;
      `);

      expect(() => service.activatePageDefaultScope('projectAssets', 'global', first())).toThrow('forced');
      expect(projectDefaults.getPageScope(firstId, 'projectAssets')).toBe('project');
    });
  });
});

describe('page defaults multivalue compatibility (WP2)', () => {
  let tmpDir;
  let db;
  let appMeta;
  let projectDefaults;
  let service;
  let projectId;
  const statusCatalogue = [
    { value: 'tbd', label: 'TBD', color: '#AAAAAA' },
    { value: 'planned', label: 'Planned', color: '#22D3EE' },
    { value: 'ready', label: 'Ready', color: '#34D399' },
  ];
  const projectTypeCatalogue = [
    { value: 'images', label: 'Images', color: '#AAAAAA' },
    { value: 'comic', label: 'Comic', color: '#22D3EE' },
  ];
  const tagCatalogue = [
    { value: 'all', label: 'All tags' },
    { value: '3', label: 'Three' },
    { value: '7', label: 'Seven' },
  ];
  const categoryCatalogue = [
    { value: 'all', label: 'All categories' },
    { value: 'uncategorized', label: 'Uncategorized' },
    { value: 'images', label: 'Images' },
    { value: 'videos', label: 'Videos' },
  ];
  const keys = {
    status: PAGE_DEFAULT_DEFINITIONS.projects.status.key,
    projectType: PAGE_DEFAULT_DEFINITIONS.projects.projectType.key,
    tag: PAGE_DEFAULT_DEFINITIONS.projects.tag.key,
    category: PAGE_DEFAULT_DEFINITIONS.assetViewer.category.key,
  };
  const writeRaw = (key, value) => db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
  const readRaw = (key) => db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
  const projectCatalogues = { tag: tagCatalogue };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-default-multi-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    appMeta = createAppMetaRepository(db);
    projectDefaults = createProjectPageDefaultRepository(db);
    projectId = createProjectRepository(db).create({
      title: 'Multi Project',
      slug: 'multi-project',
      description: '',
      notes: '',
      status: 'tbd',
      projectType: 'images',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    }).id;
    service = createPageDefaultsService({
      appMetaRepository: appMeta,
      projectPageDefaultRepository: projectDefaults,
      projectOptionCatalogueService: {
        getStatusCatalogue: () => statusCatalogue.map((entry) => ({ ...entry })),
        getProjectTypeCatalogue: () => projectTypeCatalogue.map((entry) => ({ ...entry })),
      },
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks exactly the four WP2 fields as multivalue without changing their keys or fallbacks', () => {
    expect(PAGE_DEFAULT_DEFINITIONS.projects.status).toEqual({
      key: 'page_defaults.projects.status', values: ['all'], fallback: 'all', multi: true,
    });
    expect(PAGE_DEFAULT_DEFINITIONS.projects.projectType).toEqual({
      key: 'page_defaults.projects.project_type', values: ['all'], fallback: 'all', multi: true,
    });
    expect(PAGE_DEFAULT_DEFINITIONS.projects.tag).toEqual({
      key: 'page_defaults.projects.tag', values: ['all'], fallback: 'all', multi: true,
    });
    expect(PAGE_DEFAULT_DEFINITIONS.assetViewer.category).toEqual({
      key: 'page_defaults.asset_viewer.category', values: ['all'], fallback: 'all', multi: true,
    });
    expect(PAGE_DEFAULT_DEFINITIONS.assetViewer.presence.multi).toBeUndefined();
    expect(PAGE_DEFAULT_DEFINITIONS.new_project.status.multi).toBeUndefined();
    expect(PAGE_DEFAULT_DEFINITIONS.new_project.projectType.multi).toBeUndefined();
  });

  it('resolves legacy scalar Projects and Category defaults as one-value selections without rewriting them', () => {
    writeRaw(keys.status, 'planned');
    writeRaw(keys.projectType, 'comic');
    writeRaw(keys.tag, '7');
    writeRaw(keys.category, 'videos');

    const resolved = service.resolvePageDefaults('projects', {}, projectCatalogues);
    expect(resolved.status).toEqual(['planned']);
    expect(resolved.projectType).toEqual(['comic']);
    expect(resolved.tag).toEqual(['7']);
    expect(service.resolve('assetViewer', 'category', undefined, categoryCatalogue)).toEqual(['videos']);

    expect(readRaw(keys.status)).toBe('planned');
    expect(readRaw(keys.projectType)).toBe('comic');
    expect(readRaw(keys.tag)).toBe('7');
    expect(readRaw(keys.category)).toBe('videos');
  });

  it('saves and restores complete multivalue selections through the JSON-array representation', () => {
    expect(service.saveDefault('projects', 'status', ['planned', 'archived'])).toEqual(['planned', 'archived']);
    expect(service.saveDefault('projects', 'projectType', ['comic', 'images'])).toEqual(['comic', 'images']);
    expect(service.saveDefault('projects', 'tag', ['3', '7'], tagCatalogue)).toEqual(['3', '7']);
    expect(service.saveDefault('assetViewer', 'category', ['uncategorized', 'videos'], categoryCatalogue))
      .toEqual(['uncategorized', 'videos']);

    expect(readRaw(keys.status)).toBe('["planned","archived"]');
    expect(readRaw(keys.projectType)).toBe('["comic","images"]');
    expect(readRaw(keys.tag)).toBe('["3","7"]');
    expect(readRaw(keys.category)).toBe('["uncategorized","videos"]');

    expect(service.resolvePageDefaults('projects', {}, projectCatalogues)).toMatchObject({
      status: ['planned', 'archived'],
      projectType: ['comic', 'images'],
      tag: ['3', '7'],
    });
    expect(service.resolve('assetViewer', 'category', undefined, categoryCatalogue))
      .toEqual(['uncategorized', 'videos']);
  });

  it('keeps the unrestricted meaning for legacy, explicit and missing all values', () => {
    for (const stored of [undefined, 'all', '["all"]']) {
      if (stored === undefined) db.prepare('DELETE FROM app_meta WHERE key = ?').run(keys.status);
      else writeRaw(keys.status, stored);
      expect(service.resolve('projects', 'status')).toBe('all');
    }
    expect(service.saveDefault('projects', 'status', 'all')).toBe('all');
    expect(service.saveDefault('projects', 'status', ['all'])).toBe('all');
    expect(readRaw(keys.status)).toBe('all');
    expect(service.saveDefault('assetViewer', 'category', 'all', categoryCatalogue)).toBe('all');
    expect(service.resolve('assetViewer', 'category', undefined, categoryCatalogue)).toBe('all');
  });

  it('falls back safely for invalid, unavailable or malformed stored selections', () => {
    for (const stored of ['retired', '["planned","retired"]', '["all","planned"]', '[]', '[not json', '{"a":1}', '[1]']) {
      writeRaw(keys.status, stored);
      expect(service.resolve('projects', 'status')).toBe('all');
      expect(readRaw(keys.status)).toBe(stored);
    }
    writeRaw(keys.category, '["videos","deleted-category"]');
    expect(service.resolve('assetViewer', 'category', undefined, categoryCatalogue)).toBe('all');
    expect(() => service.saveDefault('projects', 'status', ['planned', 'retired']))
      .toThrow(PageDefaultValidationError);
    expect(() => service.saveDefault('projects', 'status', ['all', 'planned']))
      .toThrow(PageDefaultValidationError);
  });

  it('keeps explicit selections ahead of saved selections and invalid explicit values at the fallback', () => {
    service.saveDefault('projects', 'status', ['planned', 'ready']);
    expect(service.resolve('projects', 'status', 'tbd')).toEqual(['tbd']);
    expect(service.resolve('projects', 'status', ['tbd', 'archived'])).toEqual(['tbd', 'archived']);
    expect(service.resolve('projects', 'status', 'all')).toBe('all');
    expect(service.resolve('projects', 'status', 'retired')).toBe('all');
    expect(service.resolve('projects', 'status')).toEqual(['planned', 'ready']);
  });

  it('resolves project-scoped multivalue overrides and inherits Global otherwise', () => {
    service.saveDefault('projects', 'status', ['planned']);
    service.saveProjectDefault('projects', 'status', ['ready', 'tbd'], undefined, { projectId });
    expect(projectDefaults.getOption(projectId, 'projects', 'status')).toBe('["ready","tbd"]');

    expect(service.resolve('projects', 'status', undefined, undefined, { projectId })).toEqual(['planned']);
    service.setPageDefaultScope('projects', 'project', { projectId });
    expect(service.resolve('projects', 'status', undefined, undefined, { projectId })).toEqual(['ready', 'tbd']);
    expect(service.resolveProjectPageDefaults('projects', projectCatalogues, { projectId }).projectType).toBe('all');
  });

  it('reports multivalue, legacy scalar and invalid stored values through WP1 metadata without writing', () => {
    writeRaw(keys.status, '["planned","archived"]');
    writeRaw(keys.projectType, 'comic');
    writeRaw(keys.tag, '["3","99"]');
    writeRaw(keys.category, 'all');
    projectDefaults.setOption(projectId, 'projects', 'status', '["ready"]');
    projectDefaults.setPageScope(projectId, 'projects', 'project');
    const before = db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();

    const state = service.describeSavedDefaults('projects', projectCatalogues, { projectId });
    expect(state.options.status).toEqual({
      global: { stored: true, valid: true },
      project: { stored: true, valid: true },
      source: 'project',
    });
    expect(state.options.projectType.global).toEqual({ stored: true, valid: true });
    expect(state.options.projectType.source).toBe('global');
    expect(state.options.tag.global).toEqual({ stored: true, valid: false });
    expect(state.options.tag.source).toBe('fallback');
    expect(state.global).toMatchObject({ saved: true, invalid: true });
    expect(state.project).toMatchObject({ saved: true, invalid: false, inheritance: 'partial' });

    // A stored fallback-equal 'all' is still a saved default.
    const assetState = service.describeSavedDefaults('assetViewer', { category: categoryCatalogue });
    expect(assetState.options.category.global).toEqual({ stored: true, valid: true });

    expect(db.prepare('SELECT key, value FROM app_meta ORDER BY key').all()).toEqual(before);
    expect(projectDefaults.getOption(projectId, 'projects', 'status')).toBe('["ready"]');
  });
});
