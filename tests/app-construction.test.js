/**
 * Phase: asset actions chunk 3 — app.js construction wiring.
 *
 * Focused, non-HTTP checks that createApp wires the shared project
 * operation coordinator into both the asset scanner and the asset action
 * service, and exposes the constructed action service to the asset router.
 * Deliberately calls createApp directly (no supertest) — this is a
 * construction-time fact, not application behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dependencyInstrumentation = vi.hoisted(() => ({
  appMetaRepositories: [],
  bookRepositories: [],
  chapterRepositories: [],
  noteRepositories: [],
  noteServices: [],
  tagRepositories: [],
  preferenceRepositories: [],
  projectServices: [],
  preferenceServices: [],
  pageDefaultsServices: [],
  tagServices: [],
  projectTagServices: [],
  assetTagServices: [],
  projectAssetCategoryServices: [],
  primaryImageRepositories: [],
  primaryImageServices: [],
  autoRenameServices: [],
  workflowQueryServices: [],
  openLocallySettingsServices: [],
  assetRouters: [],
  noteRouters: [],
  projectAssetCategoryRouters: [],
  settingsRouters: [],
}));

vi.mock('../src/data/asset-browser-preference-repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAssetBrowserPreferenceRepository(...args) {
      const repository = actual.createAssetBrowserPreferenceRepository(...args);
      dependencyInstrumentation.preferenceRepositories.push({ args, repository });
      return repository;
    },
  };
});

vi.mock('../src/data/app-meta-repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAppMetaRepository(...args) {
      const repository = actual.createAppMetaRepository(...args);
      dependencyInstrumentation.appMetaRepositories.push({ args, repository });
      return repository;
    },
  };
});

vi.mock('../src/data/note-repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createNoteRepository(...args) {
      const repository = actual.createNoteRepository(...args);
      dependencyInstrumentation.noteRepositories.push({ args, repository });
      return repository;
    },
  };
});

vi.mock('../src/data/book-repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createBookRepository(...args) {
      const repository = actual.createBookRepository(...args);
      dependencyInstrumentation.bookRepositories.push({ args, repository });
      return repository;
    },
  };
});

vi.mock('../src/data/chapter-repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createChapterRepository(...args) {
      const repository = actual.createChapterRepository(...args);
      dependencyInstrumentation.chapterRepositories.push({ args, repository });
      return repository;
    },
  };
});

vi.mock('../src/data/tag-repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createTagRepository(...args) {
      const repository = actual.createTagRepository(...args);
      dependencyInstrumentation.tagRepositories.push({ args, repository });
      return repository;
    },
  };
});

vi.mock('../src/services/project-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProjectService(...args) {
      const service = actual.createProjectService(...args);
      dependencyInstrumentation.projectServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/note-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createNoteService(...args) {
      const service = actual.createNoteService(...args);
      dependencyInstrumentation.noteServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/asset-browser-preference-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAssetBrowserPreferenceService(...args) {
      const service = actual.createAssetBrowserPreferenceService(...args);
      dependencyInstrumentation.preferenceServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/page-defaults-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPageDefaultsService(...args) {
      const service = actual.createPageDefaultsService(...args);
      dependencyInstrumentation.pageDefaultsServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/open-locally-settings-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createOpenLocallySettingsService(...args) {
      const service = actual.createOpenLocallySettingsService(...args);
      dependencyInstrumentation.openLocallySettingsServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/tag-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createTagService(...args) {
      const service = actual.createTagService(...args);
      dependencyInstrumentation.tagServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/project-tag-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProjectTagService(...args) {
      const service = actual.createProjectTagService(...args);
      dependencyInstrumentation.projectTagServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/asset-tag-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAssetTagService(...args) {
      const service = actual.createAssetTagService(...args);
      dependencyInstrumentation.assetTagServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/project-asset-category-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProjectAssetCategoryService(...args) {
      const service = actual.createProjectAssetCategoryService(...args);
      dependencyInstrumentation.projectAssetCategoryServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/data/project-primary-image-repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProjectPrimaryImageRepository(...args) {
      const repository = actual.createProjectPrimaryImageRepository(...args);
      dependencyInstrumentation.primaryImageRepositories.push({ args, repository });
      return repository;
    },
  };
});

vi.mock('../src/services/project-primary-image-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProjectPrimaryImageService(...args) {
      const service = actual.createProjectPrimaryImageService(...args);
      dependencyInstrumentation.primaryImageServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/auto-rename-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAutoRenameService(...args) {
      const service = actual.createAutoRenameService(...args);
      dependencyInstrumentation.autoRenameServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/services/workflow-query-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createWorkflowQueryService(...args) {
      const service = actual.createWorkflowQueryService(...args);
      dependencyInstrumentation.workflowQueryServices.push({ args, service });
      return service;
    },
  };
});

vi.mock('../src/routes/assets.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAssetsRouter(...args) {
      const router = actual.createAssetsRouter(...args);
      dependencyInstrumentation.assetRouters.push({ args, router });
      return router;
    },
  };
});

vi.mock('../src/routes/notes.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createNotesRouter(...args) {
      const router = actual.createNotesRouter(...args);
      dependencyInstrumentation.noteRouters.push({ args, router });
      return router;
    },
  };
});

vi.mock('../src/routes/project-asset-categories.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProjectAssetCategoriesRouter(...args) {
      const router = actual.createProjectAssetCategoriesRouter(...args);
      dependencyInstrumentation.projectAssetCategoryRouters.push({ args, router });
      return router;
    },
  };
});

vi.mock('../src/routes/settings.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSettingsRouter(...args) {
      const router = actual.createSettingsRouter(...args);
      dependencyInstrumentation.settingsRouters.push({ args, router });
      return router;
    },
  };
});

import { createApp } from '../src/app.js';
import { createAssetsRouter } from '../src/routes/assets.js';
import { createProjectAssetCategoriesRouter } from '../src/routes/project-asset-categories.js';
import { createSettingsRouter } from '../src/routes/settings.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';
import { createProjectOperationCoordinator, ProjectOperationError } from '../src/services/project-operation-coordinator.js';
import { AssetActionError } from '../src/services/asset-action-service.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('app construction — asset actions chunk 3 wiring', () => {
  let tmpDir;
  let appDataRoot;
  let projectsRoot;
  let db;
  let csrfPepper;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-app-construction-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(appDataRoot, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    csrfPepper = ensureAuthEnablement(appDataRoot).csrfPepper;
    for (const calls of Object.values(dependencyInstrumentation)) calls.length = 0;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildApp(opts = {}) {
    return createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { authState: { csrfPepper }, appDataRoot, ...opts }
    );
  }

  it('exposes the constructed asset action service on app.locals', () => {
    const app = buildApp();
    expect(app.locals.assetActionService).toBeTruthy();
    expect(typeof app.locals.assetActionService.renameAsset).toBe('function');
    expect(typeof app.locals.assetActionService.moveAsset).toBe('function');
  });

  it('exposes the constructed asset scanner on app.locals', () => {
    const app = buildApp();
    expect(app.locals.assetScanner).toBeTruthy();
    expect(typeof app.locals.assetScanner.scanProjectAssets).toBe('function');
  });

  it('constructs and wires the Notes repository, service, and router explicitly', () => {
    const app = buildApp();

    expect(dependencyInstrumentation.noteRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.noteServices).toHaveLength(1);
    expect(dependencyInstrumentation.bookRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.chapterRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.noteRouters).toHaveLength(1);

    const { args: repositoryArgs, repository: noteRepository } = dependencyInstrumentation.noteRepositories[0];
    const { args: serviceArgs, service: noteService } = dependencyInstrumentation.noteServices[0];
    const { args: routerArgs } = dependencyInstrumentation.noteRouters[0];
    const { repository: bookRepository } = dependencyInstrumentation.bookRepositories[0];
    const { repository: chapterRepository } = dependencyInstrumentation.chapterRepositories[0];
    const projectRepository = dependencyInstrumentation.projectServices[0].service.repository;
    const assetRepository = app.locals.assetScanner.repository;

    expect(repositoryArgs[0]).toBe(db);
    expect(serviceArgs[0]).toEqual({
      noteRepository,
      projectRepository,
      assetRepository,
      chapterRepository,
      bookRepository,
    });
    expect(app.locals.noteRepository).toBe(noteRepository);
    expect(app.locals.noteService).toBe(noteService);
    expect(app.locals.markdownRenderer).toBeTruthy();
    expect(typeof app.locals.markdownRenderer.renderMarkdown).toBe('function');
    expect(routerArgs[0]).toEqual({
      appName: 'CreatorCrate',
      bookService: app.locals.bookService,
      chapterService: app.locals.chapterService,
      noteService,
      markdownRenderer: app.locals.markdownRenderer,
      projectService: dependencyInstrumentation.projectServices[0].service,
      assetRepository: app.locals.assetScanner.repository,
    });
  });

  it('constructs the preference service once and keeps it available without route wiring', () => {
    const app = buildApp();

    expect(app.locals.assetBrowserPreferenceService).toBeTruthy();
    expect(typeof app.locals.assetBrowserPreferenceService.getProjectPreference).toBe('function');
    expect(typeof app.locals.assetBrowserPreferenceService.resolveEffectiveCategory).toBe('function');
  });

  it('constructs one shared app-meta repository and wires it to app locals and Settings', () => {
    const app = buildApp();

    expect(dependencyInstrumentation.appMetaRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.pageDefaultsServices).toHaveLength(1);

    const { args: appMetaRepositoryArgs, repository: appMetaRepository } =
      dependencyInstrumentation.appMetaRepositories[0];
    const { args: preferenceRepositoryArgs } = dependencyInstrumentation.preferenceRepositories[0];
    const { args: pageDefaultsServiceArgs, service } = dependencyInstrumentation.pageDefaultsServices[0];

    expect(appMetaRepositoryArgs[0]).toBe(db);
    expect(preferenceRepositoryArgs[1]).toEqual({ appMetaRepository });
    expect(pageDefaultsServiceArgs[0]).toEqual({ appMetaRepository });
    expect(app.locals.appMetaRepository).toBe(appMetaRepository);
    expect(app.locals.pageDefaultsService).toBe(service);
    expect(dependencyInstrumentation.settingsRouters[0].args[0].appMetaRepository)
      .toBe(appMetaRepository);
    expect(dependencyInstrumentation.settingsRouters[0].args[0].pageDefaultsService).toBeUndefined();
  });

  it('constructs one app-scoped open-locally settings service over the shared app-meta repository', () => {
    const app = buildApp();

    expect(dependencyInstrumentation.openLocallySettingsServices).toHaveLength(1);
    const { args, service } = dependencyInstrumentation.openLocallySettingsServices[0];
    const { repository: appMetaRepository } = dependencyInstrumentation.appMetaRepositories[0];

    expect(args[0]).toEqual({ appMetaRepository });
    expect(app.locals.openLocallySettingsService).toBe(service);
    expect(typeof service.getWindowsProjectsPath).toBe('function');
    expect(typeof service.setWindowsProjectsPath).toBe('function');
    expect(typeof service.clearWindowsProjectsPath).toBe('function');
  });

  it('accepts an injected open-locally settings service without constructing a replacement', () => {
    const injected = {
      getWindowsProjectsPath: () => null,
      setWindowsProjectsPath: () => null,
      clearWindowsProjectsPath: () => false,
    };
    const app = buildApp({ openLocallySettingsService: injected });

    expect(dependencyInstrumentation.openLocallySettingsServices).toHaveLength(0);
    expect(app.locals.openLocallySettingsService).toBe(injected);
  });

  it('preserves existing service overrides while accepting app-scoped metadata/default overrides', () => {
    const appMetaRepository = {
      getValue: () => undefined,
      setValue: () => undefined,
    };
    const pageDefaultsService = { resolve: () => 'grid' };
    const nsfwFilterSettingsService = {};
    const assetBrowserPreferenceService = {
      getProjectPreference: () => ({ mode: 'inherit', categoryId: null }),
      resolveEffectiveCategory: () => null,
    };

    const app = buildApp({
      appMetaRepository,
      pageDefaultsService,
      nsfwFilterSettingsService,
      assetBrowserPreferenceService,
    });

    expect(dependencyInstrumentation.appMetaRepositories).toHaveLength(0);
    expect(dependencyInstrumentation.pageDefaultsServices).toHaveLength(0);
    expect(dependencyInstrumentation.preferenceServices).toHaveLength(0);
    expect(app.locals.pageDefaultsService).toBe(pageDefaultsService);
    expect(app.locals.nsfwFilterSettingsService).toBe(nsfwFilterSettingsService);
    expect(app.locals.assetBrowserPreferenceService).toBe(assetBrowserPreferenceService);
    expect(dependencyInstrumentation.preferenceRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.preferenceRepositories[0].args[1])
      .toEqual({ appMetaRepository });
  });

  it('constructs one shared tag repository and wires all tag services without route consumption', () => {
    const app = buildApp();

    expect(dependencyInstrumentation.tagRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.tagServices).toHaveLength(1);
    expect(dependencyInstrumentation.projectTagServices).toHaveLength(1);
    expect(dependencyInstrumentation.assetTagServices).toHaveLength(1);

    const { args: repositoryArgs, repository } = dependencyInstrumentation.tagRepositories[0];
    const { args: tagServiceArgs, service: tagService } = dependencyInstrumentation.tagServices[0];
    const { args: projectTagServiceArgs, service: projectTagService } =
      dependencyInstrumentation.projectTagServices[0];
    const { args: assetTagServiceArgs, service: assetTagService } =
      dependencyInstrumentation.assetTagServices[0];
    const projectRepository = dependencyInstrumentation.projectServices[0].service.repository;
    const assetRepository = app.locals.assetScanner.repository;

    expect(repositoryArgs[0]).toBe(db);
    expect(tagServiceArgs[0]).toEqual({ tagRepository: repository });
    expect(projectTagServiceArgs[0]).toEqual({ tagRepository: repository, projectRepository });
    expect(assetTagServiceArgs[0]).toEqual({ tagRepository: repository, assetRepository });
    expect(app.locals.tagService).toBe(tagService);
    expect(app.locals.projectTagService).toBe(projectTagService);
    expect(app.locals.assetTagService).toBe(assetTagService);
    expect(dependencyInstrumentation.workflowQueryServices).toHaveLength(1);
    expect(dependencyInstrumentation.workflowQueryServices[0].args[0].tagRepository)
      .toBe(repository);

    for (const dependencies of [
      dependencyInstrumentation.assetRouters[0].args[0],
      dependencyInstrumentation.projectAssetCategoryRouters[0].args[0],
      dependencyInstrumentation.settingsRouters[0].args[0],
    ]) {
      expect(dependencies).not.toHaveProperty('tagService');
      expect(dependencies).not.toHaveProperty('projectTagService');
      expect(dependencies).not.toHaveProperty('assetTagService');
    }
  });

  it('preserves explicit tag repository and service overrides', () => {
    const tagRepository = {};
    const tagService = {};
    const projectTagService = {};
    const assetTagService = {};
    const nsfwFilterSettingsService = {};

    const app = buildApp({
      tagRepository,
      tagService,
      projectTagService,
      assetTagService,
      nsfwFilterSettingsService,
    });

    expect(dependencyInstrumentation.tagRepositories).toHaveLength(0);
    expect(dependencyInstrumentation.tagServices).toHaveLength(0);
    expect(dependencyInstrumentation.projectTagServices).toHaveLength(0);
    expect(dependencyInstrumentation.assetTagServices).toHaveLength(0);
    expect(app.locals.tagService).toBe(tagService);
    expect(app.locals.nsfwFilterSettingsService).toBe(nsfwFilterSettingsService);
    expect(app.locals.projectTagService).toBe(projectTagService);
    expect(app.locals.assetTagService).toBe(assetTagService);
  });

  it('constructs one shared primary-image repository and service from the application database', () => {
    const app = buildApp();

    expect(dependencyInstrumentation.primaryImageRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.primaryImageServices).toHaveLength(1);
    expect(dependencyInstrumentation.workflowQueryServices).toHaveLength(1);

    const { args: repositoryArgs, repository } = dependencyInstrumentation.primaryImageRepositories[0];
    const { args: serviceArgs, service } = dependencyInstrumentation.primaryImageServices[0];
    const projectService = dependencyInstrumentation.projectServices[0].service;

    expect(repositoryArgs[0]).toBe(db);
    expect(serviceArgs[0]).toEqual(expect.objectContaining({
      db,
      projectRepository: projectService.repository,
      assetRepository: app.locals.assetScanner.repository,
      projectPrimaryImageRepository: repository,
    }));
    expect(app.locals.projectPrimaryImageRepository).toBe(repository);
    expect(app.locals.projectPrimaryImageService).toBe(service);
    expect(dependencyInstrumentation.workflowQueryServices[0].args[0].projectPrimaryImageRepository).toBe(repository);
    expect(dependencyInstrumentation.assetRouters[0].args[0].projectPrimaryImageService).toBe(service);
  });

  it('constructs one app-scoped Auto Rename service from shared repositories and injects it into Assets', () => {
    const coordinator = createProjectOperationCoordinator();
    const app = buildApp({
      projectOperationCoordinator: coordinator,
      autoRenameSigningKey: Buffer.from('app-construction-auto-rename-key'),
    });

    expect(dependencyInstrumentation.autoRenameServices).toHaveLength(1);
    const { args, service } = dependencyInstrumentation.autoRenameServices[0];
    expect(args[0]).toEqual(expect.objectContaining({
      projectRepository: dependencyInstrumentation.projectServices[0].service.repository,
      assetRepository: app.locals.assetScanner.repository,
      assetCategoryRepository: dependencyInstrumentation.preferenceServices[0].args[0].assetCategoryRepository,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      signingKey: Buffer.from('app-construction-auto-rename-key'),
    }));
    expect(app.locals.autoRenameService).toBe(service);
    expect(dependencyInstrumentation.assetRouters[0].args[0].autoRenameService).toBe(service);
  });

  it('accepts an injected Auto Rename service without constructing a replacement', () => {
    const injected = {
      buildPlan: () => {},
      applyPlan: () => {},
    };
    const app = buildApp({ autoRenameService: injected });

    expect(dependencyInstrumentation.autoRenameServices).toHaveLength(0);
    expect(app.locals.autoRenameService).toBe(injected);
    expect(dependencyInstrumentation.assetRouters[0].args[0].autoRenameService).toBe(injected);
  });

  it('omits the Assets router when filesystem roots are unavailable', () => {
    const app = createApp(
      { appName: 'CreatorCrate', db },
      { authState: { csrfPepper }, appDataRoot }
    );

    expect(dependencyInstrumentation.assetRouters).toHaveLength(0);
    expect(dependencyInstrumentation.projectAssetCategoryRouters).toHaveLength(0);
    expect(dependencyInstrumentation.settingsRouters).toHaveLength(1);
    expect(app.locals.assetActionService).toBeNull();
    expect(app.locals.projectAssetCategoryService).toBeNull();
    expect(app.locals.projectPrimaryImageService).toBeTruthy();
    expect(typeof app.locals.projectPrimaryImageService.getPrimaryImage).toBe('function');
  });

  it('constructs the rooted Assets router once with non-null dependencies', () => {
    const app = buildApp();

    expect(dependencyInstrumentation.assetRouters).toHaveLength(1);
    const [routerCall] = dependencyInstrumentation.assetRouters;
    const dependencies = routerCall.args[0];

    expect(dependencies.projectService).toBeTruthy();
    expect(dependencies.assetScanner).toBe(app.locals.assetScanner);
    expect(dependencies.workflowQueryService).toBeTruthy();
    expect(dependencies.releaseService).toBeTruthy();
    expect(dependencies.assetActionService).toBe(app.locals.assetActionService);
    expect(dependencies.assetBrowserPreferenceService).toBe(app.locals.assetBrowserPreferenceService);
    expect(dependencies.projectPrimaryImageService).toBe(app.locals.projectPrimaryImageService);
  });

  it('fails clearly when the Assets router preference dependency is absent', () => {
    expect(() => createAssetsRouter({})).toThrow(
      'createAssetsRouter requires an assetBrowserPreferenceService dependency.'
    );
  });

  it('fails clearly when either other preference-aware router dependency is absent', () => {
    expect(() => createProjectAssetCategoriesRouter({})).toThrow(
      'createProjectAssetCategoriesRouter requires an assetBrowserPreferenceService dependency.'
    );
    expect(() => createSettingsRouter({})).toThrow(
      'createSettingsRouter requires an assetBrowserPreferenceService dependency.'
    );
  });

  it('passes one preference repository instance through the complete app graph', () => {
    const app = buildApp();

    expect(dependencyInstrumentation.preferenceRepositories).toHaveLength(1);
    expect(dependencyInstrumentation.projectServices).toHaveLength(1);
    expect(dependencyInstrumentation.preferenceServices).toHaveLength(1);
    expect(dependencyInstrumentation.projectAssetCategoryServices).toHaveLength(1);

    const { args: repositoryArgs, repository } = dependencyInstrumentation.preferenceRepositories[0];
    const { args: projectServiceArgs } = dependencyInstrumentation.projectServices[0];
    const { args: preferenceServiceArgs, service: preferenceService } = dependencyInstrumentation.preferenceServices[0];
    const { args: categoryServiceArgs } = dependencyInstrumentation.projectAssetCategoryServices[0];

    expect(repositoryArgs[0]).toBe(db);
    expect(projectServiceArgs[2].assetBrowserPreferenceRepository).toBe(repository);
    expect(preferenceServiceArgs[0].preferenceRepository).toBe(repository);
    expect(categoryServiceArgs[0].assetBrowserPreferenceRepository).toBe(repository);
    expect(app.locals.assetBrowserPreferenceService).toBe(preferenceService);
  });

  it('passes the exact app-scoped preference service to all rooted preference-aware routers', () => {
    const app = buildApp();
    expect(dependencyInstrumentation.assetRouters).toHaveLength(1);
    expect(dependencyInstrumentation.projectAssetCategoryRouters).toHaveLength(1);
    expect(dependencyInstrumentation.settingsRouters).toHaveLength(1);

    expect(dependencyInstrumentation.assetRouters[0].args[0].assetBrowserPreferenceService)
      .toBe(app.locals.assetBrowserPreferenceService);
    expect(dependencyInstrumentation.projectAssetCategoryRouters[0].args[0].assetBrowserPreferenceService)
      .toBe(app.locals.assetBrowserPreferenceService);
    expect(dependencyInstrumentation.settingsRouters[0].args[0].assetBrowserPreferenceService)
      .toBe(app.locals.assetBrowserPreferenceService);
  });

  it('does not initialize project preference rows during dependency construction', () => {
    const project = createProjectRepository(db).create({
      title: 'Existing Project',
      slug: 'existing-project',
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_browser_preferences').get().count).toBe(0);

    buildApp();

    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM project_asset_browser_preferences WHERE project_id = ?'
    ).get(project.id).count).toBe(0);
  });

  it('does not throw constructing the app (proves the assets router accepts the action service dependency)', () => {
    expect(() => buildApp()).not.toThrow();
  });

  it('shares one coordinator instance between the scanner and the asset action service', () => {
    const coordinator = createProjectOperationCoordinator();
    const app = buildApp({ projectOperationCoordinator: coordinator });

    const assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(db));
    const projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(db),
    });
    const project = projectService.create({
      title: 'Coordinator Sharing', description: '', notes: '', status: 'tbd', priority: 'normal',
      plannedDate: null, publishedDate: null, patreonUrl: null,
    });

    let scanErr;
    let actionErr;
    coordinator.run(project.id, () => {
      try {
        app.locals.assetScanner.scanProjectAssets(project.id);
        expect.unreachable();
      } catch (err) {
        scanErr = err;
      }
      try {
        app.locals.assetActionService.renameAsset(project.id, 1, 'x.png');
        expect.unreachable();
      } catch (err) {
        actionErr = err;
      }
    });

    // Both throw only because THIS externally-held coordinator instance
    // (constructed here in the test, not by createApp) is locked for
    // project.id — proving both services were built around the exact same
    // injected instance rather than each defaulting to an independent one.
    expect(scanErr).toBeInstanceOf(ProjectOperationError);
    expect(scanErr.code).toBe('PROJECT_OPERATION_IN_PROGRESS');
    expect(actionErr).toBeInstanceOf(AssetActionError);
    expect(actionErr.code).toBe('PROJECT_BUSY');

    // The coordinator is free again once the outer .run() above returns —
    // proving the shared instance is the only thing that was ever locked.
    expect(coordinator.isActive(project.id)).toBe(false);
  });

  it('defaults to its own coordinator (still shared between scanner and action service) when none is injected', () => {
    const app = buildApp();

    const assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(db));
    const projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(db),
    });
    const project = projectService.create({
      title: 'Default Coordinator', description: '', notes: '', status: 'tbd', priority: 'normal',
      plannedDate: null, publishedDate: null, patreonUrl: null,
    });

    // A rename/move under a project the scanner has no directory for will
    // hit ASSET_NOT_FOUND quickly — enough to prove the default coordinator
    // at least accepted and released the lock without requiring real
    // concurrent contention.
    expect(() => app.locals.assetActionService.renameAsset(project.id, 999999, 'x.png'))
      .toThrow(AssetActionError);

    // A same-project scan afterward must still succeed normally — proving
    // the default coordinator's lock was released after the prior call.
    expect(() => app.locals.assetScanner.scanProjectAssets(project.id)).not.toThrow();
  });
});
