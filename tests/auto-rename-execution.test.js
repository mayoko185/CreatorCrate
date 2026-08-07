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
  createAutoRenameService,
} from '../src/services/auto-rename-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const SIGNING_KEY = Buffer.from('creatorcrate-auto-rename-execution-test-key');

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

function listFiles(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(path.join(root, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

function temporaryFiles(ctx) {
  return listFiles(ctx.projectDir).filter((relativePath) => relativePath.includes('__creatorcrate_auto_rename_'));
}

describe('category-scoped Auto Rename execution', () => {
  let ctx;

  function buildService(_hooks = {}, signingKey = SIGNING_KEY) {
    return createAutoRenameService({
      projectRepository: ctx.projectRepository,
      assetRepository: ctx.assetRepository,
      assetCategoryRepository: ctx.assetCategoryRepository,
      projectsRoot: ctx.projectsRoot,
      projectOperationCoordinator: createProjectOperationCoordinator(),
      signingKey,
      _hooks,
    });
  }

  function absolute(relativePath) {
    return path.join(ctx.projectDir, ...relativePath.split('/'));
  }

  function writeAsset(relativePath, content = 'asset', overrides = {}) {
    const absolutePath = absolute(relativePath);
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
      mimeType: extension === 'kra' ? 'application/x-krita' : 'application/octet-stream',
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      categoryId: overrides.categoryId ?? ctx.categories[0].id,
      nestedPath: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
      ...overrides,
    });
  }

  function orderFor(categoryId = ctx.categories[0].id) {
    return ctx.assetRepository.findProjectAssetsByCategoryInBrowserOrder(ctx.project.id, categoryId)
      .map((asset) => asset.id);
  }

  function makePlan(categoryId = ctx.categories[0].id, orderedAssetIds = orderFor(categoryId), service = ctx.service) {
    return service.buildPlan({
      projectId: ctx.project.id,
      categoryId,
      orderedAssetIds,
    });
  }

  function apply(plan, service = ctx.service) {
    return service.applyPlan(ctx.project.id, plan.token);
  }

  function expectOriginalAsset(asset, content) {
    expect(fs.readFileSync(absolute(asset.relative_path), 'utf8')).toBe(content);
    expect(ctx.assetRepository.findById(asset.id)).toMatchObject({
      id: asset.id,
      relative_path: asset.relative_path,
      filename: asset.filename,
      is_present: 1,
    });
  }

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auto-rename-execution-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });

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

    ctx = {
      tmpDir,
      db,
      projectsRoot,
      project,
      projectService,
      projectDir,
      categories,
      assetCategoryRepository,
      projectRepository,
      assetRepository,
      service: null,
    };
    ctx.service = buildService();
  });

  afterEach(() => {
    closeDatabase(ctx.db);
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    ctx = null;
  });

  it('applies a complete category using only project ID and opaque token', () => {
    const first = writeAsset('nested/z.PNG', 'first');
    const second = writeAsset('a.kra', 'second');
    const plan = makePlan(ctx.categories[0].id, [first.id, second.id]);

    const result = apply(plan);

    expect(result).toMatchObject({ renamed: 2, unchanged: 0, selected: 2 });
    expect(fs.readFileSync(absolute('nested/dragon-poster-source-01.PNG'), 'utf8')).toBe('first');
    expect(fs.readFileSync(absolute('dragon-poster-source-02.kra'), 'utf8')).toBe('second');
    expect(ctx.assetRepository.findById(first.id)).toMatchObject({
      relative_path: 'nested/dragon-poster-source-01.PNG',
      category_id: ctx.categories[0].id,
    });
    expect(ctx.assetRepository.findById(second.id)).toMatchObject({
      relative_path: 'dragon-poster-source-02.kra',
      category_id: ctx.categories[0].id,
    });
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('applies swaps and cycles without overwriting files or changing category IDs', () => {
    ctx.db.prepare('UPDATE projects SET slug = ? WHERE id = ?').run('dragon', ctx.project.id);
    const swapA = writeAsset('dragon-source-02.png', 'A');
    const swapB = writeAsset('dragon-source-01.png', 'B');
    const swapOrder = [swapA.id, swapB.id];
    const swapPlan = makePlan(ctx.categories[0].id, swapOrder);

    expect(swapPlan.cycles).toEqual([[swapA.id, swapB.id].sort((left, right) => left - right)]);
    expect(apply(swapPlan).renamed).toBe(2);
    expect(fs.readFileSync(absolute('dragon-source-01.png'), 'utf8')).toBe('A');
    expect(fs.readFileSync(absolute('dragon-source-02.png'), 'utf8')).toBe('B');
    expect(ctx.assetRepository.findById(swapA.id).category_id).toBe(ctx.categories[0].id);
    expect(ctx.assetRepository.findById(swapB.id).category_id).toBe(ctx.categories[0].id);
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('preserves KRA bytes, category IDs, release relationships, and primary-image selection', () => {
    const asset = writeAsset('painting.KRA', 'kra-bytes', {
      categoryId: ctx.categories[1].id,
      mimeType: 'application/x-krita',
    });
    const release = ctx.db.prepare(
      'INSERT INTO releases (project_id, title) VALUES (?, ?) RETURNING id'
    ).get(ctx.project.id, 'Preservation Release');
    ctx.db.prepare(
      'INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)'
    ).run(release.id, asset.id, 'primary', 7);
    ctx.db.prepare(
      'INSERT INTO project_primary_images (project_id, asset_id) VALUES (?, ?)'
    ).run(ctx.project.id, asset.id);
    const beforeRelease = ctx.db.prepare('SELECT * FROM release_assets WHERE release_id = ?').get(release.id);
    const beforePrimary = ctx.db.prepare('SELECT * FROM project_primary_images WHERE project_id = ?').get(ctx.project.id);
    const plan = makePlan(ctx.categories[1].id, [asset.id]);

    apply(plan);

    expect(fs.readFileSync(absolute('dragon-poster-exports-01.KRA'), 'utf8')).toBe('kra-bytes');
    expect(ctx.assetRepository.findById(asset.id)).toMatchObject({
      category_id: ctx.categories[1].id,
      relative_path: 'dragon-poster-exports-01.KRA',
    });
    expect(ctx.db.prepare('SELECT * FROM release_assets WHERE release_id = ?').get(release.id)).toEqual(beforeRelease);
    expect(ctx.db.prepare('SELECT * FROM project_primary_images WHERE project_id = ?').get(ctx.project.id)).toEqual(beforePrimary);
  });

  it('prevents partial Apply when one complete-category member is blocked', () => {
    const blocked = writeAsset('blocked.png', 'blocked');
    ctx.db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(blocked.id);
    fs.rmSync(absolute('blocked.png'));
    const valid = writeAsset('valid.png', 'valid');
    const plan = makePlan(ctx.categories[0].id, [blocked.id, valid.id]);
    const beforeValid = ctx.assetRepository.findById(valid.id);

    expect(() => apply(plan)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.PLAN_BLOCKED }));
    expect(ctx.assetRepository.findById(valid.id)).toEqual(beforeValid);
    expect(fs.existsSync(absolute('valid.png'))).toBe(true);
    expect(fs.existsSync(absolute('dragon-poster-source-02.png'))).toBe(false);
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('skips unchanged items while applying mixed per-directory renames', () => {
    const unchanged = writeAsset('dragon-poster-source-01.png', 'unchanged');
    const root = writeAsset('z-root.bin', 'root');
    const nestedA = writeAsset('nested/z-a.png', 'a');
    const nestedB = writeAsset('nested/z-b.PNG', 'b');
    const plan = makePlan(ctx.categories[0].id, [unchanged.id, nestedB.id, nestedA.id, root.id]);

    expect(plan.counts).toEqual({ selected: 4, rename: 3, unchanged: 1, blocked: 0 });
    expect(apply(plan)).toMatchObject({ renamed: 3, unchanged: 1, selected: 4 });
    expect(fs.readFileSync(absolute('dragon-poster-source-01.png'), 'utf8')).toBe('unchanged');
    expect(fs.readFileSync(absolute('dragon-poster-source-04.bin'), 'utf8')).toBe('root');
    expect(fs.readFileSync(absolute('nested/dragon-poster-source-02.PNG'), 'utf8')).toBe('b');
    expect(fs.readFileSync(absolute('nested/dragon-poster-source-03.png'), 'utf8')).toBe('a');
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('rejects stale category membership, token reuse, malformed tokens, and other signing keys before mutation', () => {
    const first = writeAsset('a.png', 'a');
    const plan = makePlan(ctx.categories[0].id, [first.id]);
    const beforeFiles = listFiles(ctx.projectDir);

    writeAsset('added.png', 'added');
    expect(() => apply(plan)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN }));
    expect(listFiles(ctx.projectDir)).not.toEqual(beforeFiles);
    expect(fs.existsSync(absolute('a.png'))).toBe(true);
    expect(temporaryFiles(ctx)).toEqual([]);

    const fresh = makePlan();
    expect(() => ctx.service.applyPlan(ctx.project.id, 'not-a-token')).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN }),
    );
    const otherKeyService = buildService({}, Buffer.from('another-auto-rename-key'));
    expect(() => otherKeyService.applyPlan(ctx.project.id, fresh.token)).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN }),
    );
    apply(fresh);
    expect(() => apply(fresh)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN }));
  });

  it.each([
    ['project slug', () => ctx.db.prepare('UPDATE projects SET slug = ? WHERE id = ?').run('changed-project', ctx.project.id)],
    ['category slug', () => ctx.db.prepare('UPDATE project_asset_categories SET directory_slug = ? WHERE id = ?').run('changed-category', ctx.categories[0].id)],
    ['category enabled state', () => ctx.db.prepare('UPDATE project_asset_categories SET enabled = 0 WHERE id = ?').run(ctx.categories[0].id)],
    ['project archive state', () => ctx.db.prepare("UPDATE projects SET archived_at = datetime('now'), status = 'archived' WHERE id = ?").run(ctx.project.id)],
  ])('rejects %s changes as stale before filesystem mutation', (_label, mutate) => {
    const asset = writeAsset('source.png', 'source');
    const plan = makePlan(ctx.categories[0].id, [asset.id]);
    const before = ctx.assetRepository.findById(asset.id);
    mutate();

    expect(() => apply(plan)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN }));
    expect(ctx.assetRepository.findById(asset.id)).toEqual(before);
    expect(fs.existsSync(absolute('source.png'))).toBe(true);
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('rejects database and filesystem asset changes as stale without mutation', () => {
    const asset = writeAsset('source.png', 'source');
    const plan = makePlan(ctx.categories[0].id, [asset.id]);
    ctx.db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run('changed.png', asset.id);
    const after = ctx.assetRepository.findById(asset.id);
    const beforeFiles = listFiles(ctx.projectDir);

    expect(() => apply(plan)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN }));
    expect(ctx.assetRepository.findById(asset.id)).toEqual(after);
    expect(listFiles(ctx.projectDir)).toEqual(beforeFiles);
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('rejects blocked and unchanged plans as controlled outcomes', () => {
    const blocked = writeAsset('blocked.png');
    ctx.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(blocked.id);
    expect(() => apply(makePlan(ctx.categories[0].id, [blocked.id]))).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.PLAN_BLOCKED }),
    );

    const unchanged = writeAsset('dragon-poster-exports-01.png', 'unchanged', {
      categoryId: ctx.categories[1].id,
    });
    expect(() => apply(makePlan(ctx.categories[1].id, [unchanged.id]))).toThrow(
      expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.NO_CHANGES }),
    );
    expect(fs.existsSync(absolute('dragon-poster-exports-01.png'))).toBe(true);
  });

  it('restores all sources after a phase-one failure', () => {
    const first = writeAsset('a.png', 'first');
    const second = writeAsset('b.png', 'second');
    ctx.service = buildService({
      afterPhase1Move({ index }) {
        if (index === 0) throw new Error('injected phase-one failure');
      },
    });
    const plan = makePlan(ctx.categories[0].id, [first.id, second.id]);

    expect(() => apply(plan)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED }));
    expectOriginalAsset(first, 'first');
    expectOriginalAsset(second, 'second');
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('restores completed finals and remaining temporaries after a phase-two failure', () => {
    const first = writeAsset('a.png', 'first');
    const second = writeAsset('b.png', 'second');
    ctx.service = buildService({
      afterPhase2Move({ index }) {
        if (index === 0) throw new Error('injected phase-two failure');
      },
    });
    const plan = makePlan(ctx.categories[0].id, [first.id, second.id]);

    expect(() => apply(plan)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED }));
    expectOriginalAsset(first, 'first');
    expectOriginalAsset(second, 'second');
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('rolls back a database transaction failure after filesystem phases complete', () => {
    const first = writeAsset('a.png', 'first');
    const second = writeAsset('b.png', 'second');
    ctx.db.exec(`
      CREATE TRIGGER fail_auto_rename_second_final
      AFTER UPDATE OF relative_path ON assets
       WHEN NEW.relative_path = 'dragon-poster-source-02.png'
      BEGIN
        SELECT RAISE(ABORT, 'injected database failure');
      END;
    `);
    const plan = makePlan(ctx.categories[0].id, [first.id, second.id]);

    expect(() => apply(plan)).toThrow(expect.objectContaining({ code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED }));
    expectOriginalAsset(first, 'first');
    expectOriginalAsset(second, 'second');
    expect(temporaryFiles(ctx)).toEqual([]);
  });

  it('reports recovery required with safe relative details when compensation fails', () => {
    const asset = writeAsset('source.png', 'source');
    ctx.service = buildService({
      afterPhase1Move() { throw new Error('injected operation failure'); },
      beforeCompensationMove() { throw new Error('injected compensation failure'); },
    });
    const plan = makePlan(ctx.categories[0].id, [asset.id]);

    let caught;
    try {
      apply(plan);
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED });
    expect(caught.message).not.toContain('injected');
    expect(caught.message).not.toContain('ENOENT');
    expect(caught.message).not.toContain('SQLITE');
    expect(caught.message).not.toContain('G:\\');
    expect(caught.message).not.toContain('C:\\');
    expect(caught.message).not.toContain('/tmp');
    expect(caught.details.items[0]).toMatchObject({ assetId: asset.id });
    expect(JSON.stringify(caught.details)).not.toContain(ctx.tmpDir);
  });
});
