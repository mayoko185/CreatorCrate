import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import {
  AUTO_RENAME_ERROR_CODES,
  AUTO_RENAME_MAX_RELATIVE_PATH_BYTES,
  createAutoRenameService,
} from '../src/services/auto-rename-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { resolveProjectDir, STATUS_DIR_MAP } from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function validProjectInput(overrides = {}) {
  return {
    title: 'Dragon Poster',
    description: '',
    notes: '',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}

function symlinksSupported() {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auto-rename-link-'));
  try {
    fs.writeFileSync(path.join(probeRoot, 'target'), 'target');
    fs.symlinkSync(path.join(probeRoot, 'target'), path.join(probeRoot, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

const HAS_SYMLINKS = symlinksSupported();

describe('category-scoped Auto Rename service', () => {
  let ctx;

  function writeAsset(relativePath, content = 'asset', overrides = {}) {
    const absolutePath = path.join(ctx.projectDir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
    const stats = fs.lstatSync(absolutePath);
    const filename = relativePath.split('/').pop();
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 && dot < filename.length - 1
      ? filename.slice(dot + 1).toLowerCase()
      : '';
    return ctx.assetRepository.upsert(ctx.project.id, relativePath, {
      filename,
      extension,
      mimeType: extension === 'png' ? 'image/png' : 'application/octet-stream',
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      categoryId: overrides.categoryId ?? ctx.categories[0].id,
      nestedPath: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
      ...overrides,
    });
  }

  function writeDbOnlyAsset(relativePath, overrides = {}) {
    const filename = relativePath.split('/').pop();
    const dot = filename.lastIndexOf('.');
    return ctx.assetRepository.upsert(ctx.project.id, relativePath, {
      filename,
      extension: dot > 0 ? filename.slice(dot + 1).toLowerCase() : '',
      mimeType: 'application/octet-stream',
      sizeBytes: 10,
      modifiedAt: new Date(0).toISOString(),
      categoryId: overrides.categoryId ?? ctx.categories[0].id,
      nestedPath: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
      ...overrides,
    });
  }

  function orderFor(categoryId = ctx.categories[0].id) {
    return ctx.assetRepository.findProjectAssetsByCategoryInBrowserOrder(ctx.project.id, categoryId)
      .map((asset) => asset.id);
  }

  function makePlan(categoryId = ctx.categories[0].id, orderedAssetIds = orderFor(categoryId)) {
    return ctx.service.buildPlan({
      projectId: ctx.project.id,
      categoryId,
      orderedAssetIds,
    });
  }

  function markMissing(asset) {
    ctx.db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(asset.id);
  }

  function setSlug(slug) {
    ctx.db.prepare('UPDATE projects SET slug = ? WHERE id = ?').run(slug, ctx.project.id);
  }

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auto-rename-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const directory of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, directory), { recursive: true });
    }

    const db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const assetCategoryRepository = createAssetCategoryRepository(db);
    const assetBrowserPreferenceRepository = createAssetBrowserPreferenceRepository(db);
    const assetCategoryService = createAssetCategoryService(assetCategoryRepository);
    const projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository,
    });
    const project = projectService.create(validProjectInput());
    const projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    const categories = assetCategoryRepository.listProjectCategories(project.id);
    const projectRepository = createProjectRepository(db);
    const assetRepository = createAssetRepository(db);
    const service = createAutoRenameService({
      projectRepository,
      assetRepository,
      assetCategoryRepository,
      projectsRoot,
      projectOperationCoordinator: createProjectOperationCoordinator(),
      signingKey: Buffer.from('creatorcrate-auto-rename-test-key'),
    });

    ctx = {
      tmpDir,
      db,
      projectsRoot,
      project,
      projectService,
      projectDir,
      categories,
      assetRepository,
      assetCategoryRepository,
      service,
    };
  });

  afterEach(() => {
    closeDatabase(ctx.db);
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    ctx = null;
  });

  it('uses category slug, minimum two digits, exact extension case, and complete canonical membership', () => {
    const assets = [
      writeAsset('zeta.png'),
      writeAsset('alpha.PNG'),
      writeAsset('beta.kra'),
      writeAsset('gamma.krz'),
      writeAsset('delta.bin'),
      writeAsset('README'),
      writeAsset('multi.part.WebP'),
      writeAsset('animated.GIF'),
      writeAsset('photo.JPEG'),
    ];
    const plan = makePlan();

    expect(plan.items.map((item) => item.currentFilename)).toEqual([
      'alpha.PNG', 'animated.GIF', 'beta.kra', 'delta.bin', 'gamma.krz',
      'multi.part.WebP', 'photo.JPEG', 'README', 'zeta.png',
    ]);
    expect(plan.items.map((item) => item.proposedFilename)).toEqual([
      'dragon-poster-source-01.PNG', 'dragon-poster-source-02.GIF',
      'dragon-poster-source-03.kra', 'dragon-poster-source-04.bin',
      'dragon-poster-source-05.krz', 'dragon-poster-source-06.WebP',
      'dragon-poster-source-07.JPEG', 'dragon-poster-source-08',
      'dragon-poster-source-09.png',
    ]);
    expect(plan.counts).toEqual({ selected: assets.length, rename: assets.length, unchanged: 0, blocked: 0 });
    expect(plan.membershipAssetIds).toEqual(orderFor().sort((left, right) => left - right));
    expect(plan.canApply).toBe(true);
  });

  it('uses the exact submitted complete-category permutation and restarts numbering only within that category', () => {
    const first = writeAsset('nested/zeta.PNG');
    const second = writeAsset('alpha.kra');
    const third = writeAsset('nested/beta.KRZ');
    const otherCategory = ctx.assetCategoryRepository.addProjectCategory({
      projectId: ctx.project.id,
      displayName: 'Exports',
      directorySlug: 'service-other',
      displayOrder: 99,
      enabled: true,
    });
    const other = writeAsset('other.png', 'other', { categoryId: otherCategory.id });
    const order = [first.id, third.id, second.id];
    const plan = makePlan(ctx.categories[0].id, order);
    const byId = new Map(plan.items.map((item) => [item.assetId, item]));

    expect(plan).toMatchObject({
      scope: 'category',
      categoryId: ctx.categories[0].id,
      membershipAssetIds: [...order].sort((left, right) => left - right),
      orderedAssetIds: order,
      counts: { selected: 3, rename: 3, unchanged: 0, blocked: 0 },
    });
    expect(plan.items.map((item) => item.assetId)).toEqual(order);
    expect(byId.get(first.id).proposedFilename).toBe('dragon-poster-source-01.PNG');
    expect(byId.get(third.id).proposedFilename).toBe('dragon-poster-source-02.KRZ');
    expect(byId.get(second.id).proposedFilename).toBe('dragon-poster-source-03.kra');
    expect(plan.items.map((item) => item.assetId)).not.toContain(other.id);
  });

  it('widens numbering at one hundred complete-category assets', () => {
    for (let index = 0; index < 100; index += 1) {
      writeAsset(`category-${String(index).padStart(3, '0')}.png`);
    }
    const plan = makePlan();
    expect(plan.items).toHaveLength(100);
    expect(plan.items[0].proposedFilename).toBe('dragon-poster-source-001.png');
    expect(plan.items[99].proposedFilename).toBe('dragon-poster-source-100.png');
  });

  it('keeps missing members in signed order, blocks them, and excludes them from numbering', () => {
    const missing = writeDbOnlyAsset('missing.png');
    markMissing(missing);
    const valid = writeAsset('valid.png');
    const plan = makePlan(ctx.categories[0].id, [missing.id, valid.id]);

    expect(plan.items.map((item) => item.assetId)).toEqual([missing.id, valid.id]);
    expect(plan.items[0]).toMatchObject({ status: 'blocked', reason: 'missing', proposedFilename: null });
    expect(plan.items[1].proposedFilename).toBe('dragon-poster-source-01.png');
    expect(plan.counts).toEqual({ selected: 2, rename: 1, unchanged: 0, blocked: 1 });
    expect(plan.canApply).toBe(false);
    expect(plan.snapshot.orderedAssetIds).toEqual([missing.id, valid.id]);
  });

  it('rejects incomplete, duplicate, added, cross-category, and cross-project orders', () => {
    const first = writeAsset('first.png');
    const second = writeAsset('second.png');
    const otherCategory = ctx.assetCategoryRepository.addProjectCategory({
      projectId: ctx.project.id,
      displayName: 'Other',
      directorySlug: 'other',
      displayOrder: 99,
      enabled: true,
    });
    const other = writeAsset('other.png', 'other', { categoryId: otherCategory.id });
    const foreignProject = ctx.projectService.create(validProjectInput({ title: 'Foreign Order Project' }));
    const foreignCategory = ctx.assetCategoryRepository.listProjectCategories(foreignProject.id)[0];
    const foreign = ctx.assetRepository.upsert(foreignProject.id, 'foreign.png', {
      filename: 'foreign.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: new Date(0).toISOString(),
      categoryId: foreignCategory.id,
      nestedPath: '',
    });

    for (const order of [
      [first.id],
      [first.id, second.id, other.id],
      [first.id, first.id],
      [first.id, foreign.id],
    ]) {
      expect(() => makePlan(ctx.categories[0].id, order)).toThrow(
        expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.ORDER_INVALID }),
      );
    }
  });

  it('rejects missing, disabled, invalid, wrong-project, deleted, and empty categories without fallback', () => {
    const asset = writeAsset('source.png');
    const disabled = ctx.assetCategoryRepository.addProjectCategory({
      projectId: ctx.project.id,
      displayName: 'Disabled',
      directorySlug: 'disabled',
      displayOrder: 99,
      enabled: false,
    });
    const empty = ctx.assetCategoryRepository.addProjectCategory({
      projectId: ctx.project.id,
      displayName: 'Empty',
      directorySlug: 'empty',
      displayOrder: 100,
      enabled: true,
    });
    const invalidSlug = ctx.assetCategoryRepository.addProjectCategory({
      projectId: ctx.project.id,
      displayName: 'Invalid Slug',
      directorySlug: 'invalid slug',
      displayOrder: 101,
      enabled: true,
    });
    const foreignProject = ctx.projectService.create(validProjectInput({ title: 'Foreign Category Project' }));
    const foreignCategory = ctx.assetCategoryRepository.listProjectCategories(foreignProject.id)[0];

    expect(() => ctx.service.buildPlan({
      projectId: ctx.project.id,
      categoryId: undefined,
      orderedAssetIds: [asset.id],
    })).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED }),
    );
    expect(() => makePlan('1', [asset.id])).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID }),
    );
    expect(() => makePlan(disabled.id, [])).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_DISABLED }),
    );
    expect(() => makePlan(foreignCategory.id, [])).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID }),
    );
    expect(() => makePlan(empty.id, [])).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_EMPTY }),
    );
    expect(() => makePlan(invalidSlug.id, [])).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID }),
    );

    ctx.db.exec('PRAGMA foreign_keys = OFF');
    ctx.db.prepare('DELETE FROM project_asset_categories WHERE id = ?').run(ctx.categories[0].id);
    ctx.db.exec('PRAGMA foreign_keys = ON');
    expect(() => makePlan(ctx.categories[0].id, [asset.id])).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID }),
    );
  });

  it('blocks unsafe source states and category state without proposing destinations', () => {
    const markedMissing = writeAsset('marked-missing.png');
    markMissing(markedMissing);
    const absent = writeDbOnlyAsset('absent.png');
    const directory = writeDbOnlyAsset('directory');
    fs.mkdirSync(path.join(ctx.projectDir, 'directory'));
    const plan = makePlan();
    const byId = new Map(plan.items.map((item) => [item.assetId, item]));
    expect(byId.get(markedMissing.id).reason).toBe('missing');
    expect(byId.get(absent.id).reason).toBe('missing');
    expect(byId.get(directory.id).reason).toBe('unsupported-source');

    const categoryAsset = writeAsset('category-state.png');
    ctx.db.prepare('UPDATE project_asset_categories SET enabled = 0 WHERE id = ?').run(ctx.categories[0].id);
    expect(() => makePlan()).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.CATEGORY_DISABLED }));
    expect(categoryAsset).toMatchObject({ category_id: ctx.categories[0].id });
  });

  it('detects database/filesystem collisions and dependency cycles across the complete category', () => {
    const selected = writeAsset('source.png');
    writeDbOnlyAsset('dragon-poster-source-01.png', { categoryId: ctx.categories[1].id });
    const databasePlan = makePlan();
    expect(databasePlan.items.find((item) => item.assetId === selected.id)).toMatchObject({
      reason: 'database-conflict',
      proposedRelativePath: null,
    });

    ctx.db.prepare('DELETE FROM assets WHERE relative_path = ? AND project_id = ?')
      .run('dragon-poster-source-01.png', ctx.project.id);
    fs.writeFileSync(path.join(ctx.projectDir, 'DRAGON-POSTER-SOURCE-01.PNG'), 'occupied');
    const filesystemPlan = makePlan();
    expect(filesystemPlan.items.find((item) => item.assetId === selected.id)).toMatchObject({
      reason: 'case-conflict',
      proposedRelativePath: null,
    });

    fs.rmSync(path.join(ctx.projectDir, 'DRAGON-POSTER-SOURCE-01.PNG'));
    ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(selected.id);
    fs.rmSync(path.join(ctx.projectDir, 'source.png'));
    const swapA = writeAsset('dragon-poster-source-02.png');
    const swapB = writeAsset('dragon-poster-source-01.png');
    ctx.db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run('a.png', swapA.id);
    ctx.db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run('z.png', swapB.id);
    const swapPlan = makePlan();
    expect(swapPlan.cycles).toContainEqual([swapA.id, swapB.id].sort((left, right) => left - right));
  });

  it('preserves parent directories, Unicode normalization, and generated-state token binding', () => {
    const nested = writeAsset('Original Folder/source.PNG');
    const plan = makePlan();
    expect(plan.items.find((item) => item.assetId === nested.id)).toMatchObject({
      directory: 'Original Folder',
      proposedRelativePath: 'Original Folder/dragon-poster-source-01.PNG',
    });

    setSlug('cafe\u0301');
    const unicodePlan = makePlan();
    expect(unicodePlan.items.find((item) => item.assetId === nested.id).proposedFilename)
      .toBe('café-source-01.PNG');
    expect(ctx.service.verifyPlanToken(unicodePlan, unicodePlan.token)).toBe(true);

    const changed = structuredClone(unicodePlan);
    changed.items[0].proposedFilename = 'client-name.png';
    expect(ctx.service.verifyPlanToken(changed, unicodePlan.token)).toBe(false);
    expect(unicodePlan.snapshot.assets[0]).toHaveProperty('proposedFilename');
    expect(AUTO_RENAME_MAX_RELATIVE_PATH_BYTES).toBeGreaterThan(255);
  });

  it('rejects missing and archived projects without selecting a fallback category', () => {
    expect(() => ctx.service.buildPlan({ projectId: 987654, categoryId: ctx.categories[0].id, orderedAssetIds: [1] }))
      .toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.PROJECT_NOT_FOUND }));
    ctx.db.prepare("UPDATE projects SET archived_at = datetime('now'), status = 'archived' WHERE id = ?")
      .run(ctx.project.id);
    expect(() => makePlan()).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.PROJECT_ARCHIVED }));
  });

  it('exposes no selected-set service adapter', () => {
    expect(ctx.service.buildPlan.length).toBe(1);
    expect(ctx.service.applyPlan.length).toBe(2);
    expect(() => ctx.service.buildPlan(ctx.project.id, [1])).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.INVALID_PROJECT_ID }),
    );
  });
});
