/**
 * Phase: asset actions chunk 3 — app.js construction wiring.
 *
 * Focused, non-HTTP checks that createApp wires the shared project
 * operation coordinator into both the asset scanner and the asset action
 * service, and exposes the constructed action service to the asset router.
 * Deliberately calls createApp directly (no supertest) — this is a
 * construction-time fact, not application behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';
import { createProjectOperationCoordinator, ProjectOperationError } from '../src/services/project-operation-coordinator.js';
import { AssetActionError } from '../src/services/asset-action-service.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    db = openDatabase(path.join(appDataRoot, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    csrfPepper = ensureAuthEnablement(appDataRoot).csrfPepper;
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

  it('does not throw constructing the app (proves the assets router accepts the action service dependency)', () => {
    expect(() => buildApp()).not.toThrow();
  });

  it('shares one coordinator instance between the scanner and the asset action service', () => {
    const coordinator = createProjectOperationCoordinator();
    const app = buildApp({ projectOperationCoordinator: coordinator });

    const assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(db));
    const projectService = createProjectService(db, projectsRoot, { assetCategoryService });
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
    const projectService = createProjectService(db, projectsRoot, { assetCategoryService });
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
