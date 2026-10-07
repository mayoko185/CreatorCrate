/**
 * PM-1B ownership-coverage correction.
 *
 * Every operation that mutates project-root files, or reads project-root
 * bytes and then changes SQLite authority, first proves (once per project per
 * logical operation) that the stored root is this project's bound, marked
 * directory. These tests substitute project B's real directory — B's marker
 * included — at project A's stored pathname and verify that A's operations
 * refuse it before touching anything, while ordinary external edits inside a
 * correctly owned root (the SMB workflow) keep working.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createProjectPrimaryImageRepository, PRIMARY_IMAGE_PROVENANCE } from '../src/data/project-primary-image-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetActionService, UNCATEGORIZED } from '../src/services/asset-action-service.js';
import { createAssetProcessingService } from '../src/services/asset-processing-service.js';
import { createAssetProcessingPlanner } from '../src/services/asset-processing-planner.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createAutoRenameService, AUTO_RENAME_ERROR_CODES } from '../src/services/auto-rename-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { createAutomaticProjectScanScheduler } from '../src/services/automatic-project-scan-scheduler.js';
import { createSourceAnimationService } from '../src/services/source-animation-service.js';
import { createPreviewService } from '../src/services/preview-service.js';
import { createMediaService } from '../src/services/media-service.js';
import { createProjectPrimaryImageService } from '../src/services/project-primary-image-service.js';
import { createPreviewCategorySettingsService } from '../src/services/preview-category-settings-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import {
  createProjectDirectoryOwnershipVerifier,
  isKnownDirectoryIdentity,
  ProjectOwnershipError,
} from '../src/services/project-directory-ownership.js';
import { createPngChunk, PNG_SIGNATURE } from '../src/services/workflow-prompt-editor.js';
import { resolveProjectDir, formatProjectDirName } from '../src/storage/project-storage.js';
import { PROJECT_OWNERSHIP_MARKER_FILENAME } from '../src/storage/project-ownership-marker.js';
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';
import { processingRecoveryEvidenceDependencies } from './helpers/processing-recovery-evidence.js';
import { makeZip } from './helpers/zip-fixture.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';
import { countMarkerOpens, snapshotTree, substituteProjectRoot } from './helpers/project-ownership.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title) {
  return {
    title, description: '', notes: '', status: 'tbd', priority: 'normal',
    plannedDate: null, publishedDate: null, patreonUrl: null,
  };
}

const ownershipFailure = (code) => expect.objectContaining({ name: 'ProjectOwnershipError', code });

describe('PM-1B ownership coverage', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let projectRepository;
  let assetRepository;
  let assetCategoryRepository;
  let assetCategoryService;
  let ownershipRepository;
  let primaryImageRepository;
  let projectService;
  let coordinator;
  let capability;
  let projectA;
  let projectB;
  let aDir;
  let bDir;
  let finalA;
  let pngBytes;
  let substitution;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-ownership-coverage-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
    assetCategoryService = createAssetCategoryService(assetCategoryRepository);
    ownershipRepository = createProjectDirectoryOwnershipRepository(db);
    primaryImageRepository = createProjectPrimaryImageRepository(db);
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(db),
      projectOptionCatalogueService: createTestProjectOptionCatalogueService(db),
      projectDirectoryOwnershipRepository: ownershipRepository,
    });
    // Real creation binds both projects: token A and token B on disk.
    projectA = projectService.create(projectInput('Alpha'));
    projectB = projectService.create(projectInput('Beta'));
    aDir = resolveProjectDir(projectsRoot, projectA.project_dir);
    bDir = resolveProjectDir(projectsRoot, projectB.project_dir);
    finalA = assetCategoryRepository.listProjectCategories(projectA.id)
      .find((category) => category.directory_slug === 'final');
    coordinator = createProjectOperationCoordinator();
    capability = Object.freeze({});
    pngBytes = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } },
    }).png().toBuffer();
    substitution = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── fixtures ──────────────────────────────────────────────────────────

  function writeFile(dir, relativePath, bytes) {
    const target = path.join(dir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  }

  function index(project, dir, relativePath, bytes, { categoryId = null, mimeType = 'image/png' } = {}) {
    const target = writeFile(dir, relativePath, bytes);
    const stats = fs.statSync(target);
    const filename = relativePath.split('/').pop();
    return assetRepository.upsert(project.id, relativePath, {
      categoryId,
      nestedPath: '',
      filename,
      extension: filename.slice(filename.lastIndexOf('.') + 1).toLowerCase(),
      mimeType,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  function assetRows(projectId) {
    return db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY id').all(projectId);
  }

  // B's real directory, B's marker included, now sits at A's stored path.
  function substituteBUnderA() {
    substitution = substituteProjectRoot(aDir, bDir);
    return snapshotTree(aDir);
  }

  function expectNoStagingResidue(...dirs) {
    for (const dir of dirs) {
      const residue = fs.readdirSync(dir).filter((name) => name.startsWith('.creatorcrate-')
        && name !== PROJECT_OWNERSHIP_MARKER_FILENAME);
      expect(residue).toEqual([]);
    }
  }

  function createActionService() {
    return createAssetActionService({
      projectRepository,
      assetRepository,
      assetCategoryRepository,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      alreadyCoordinatedCapability: capability,
      projectDirectoryOwnershipRepository: ownershipRepository,
    });
  }

  function createScanner(overrides = {}) {
    return createAssetScanner(db, projectsRoot, {
      projectService,
      assetCategoryService,
      projectOperationCoordinator: coordinator,
      previewCategorySettingsService: createPreviewCategorySettingsService({
        appMetaRepository: createAppMetaRepository(db),
        assetCategoryService,
      }),
      projectPrimaryImageRepository: primaryImageRepository,
      projectDirectoryOwnershipRepository: ownershipRepository,
      ...overrides,
    });
  }

  function createProcessing(overrides = {}) {
    return createAssetProcessingService({
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      processingConcurrencyService: createProcessingConcurrencyService({ concurrency: 1 }),
      alreadyCoordinatedCapability: capability,
      projectDirectoryOwnershipRepository: ownershipRepository,
      ...processingRecoveryEvidenceDependencies(db),
      ...overrides,
    });
  }

  function createPlanner(renamePlanner) {
    return createAssetProcessingPlanner({
      scopeService: createAssetProcessingScopeService({ projectRepository, assetRepository }),
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      renamePlanner,
      projectDirectoryOwnershipRepository: ownershipRepository,
    });
  }

  function createAutoRename() {
    return createAutoRenameService({
      projectRepository,
      assetRepository,
      assetCategoryRepository,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      signingKey: Buffer.from('creatorcrate-ownership-coverage-key'),
      projectDirectoryOwnershipRepository: ownershipRepository,
    });
  }

  function promptPng(value) {
    return Buffer.concat([
      PNG_SIGNATURE,
      createPngChunk('IHDR', Buffer.alloc(13)),
      createPngChunk('tEXt', Buffer.concat([Buffer.from('prompt', 'ascii'), Buffer.from([0]), Buffer.from(value, 'utf8')])),
      createPngChunk('IEND'),
    ]);
  }

  // ── 1. Asset mutations ────────────────────────────────────────────────

  describe('asset actions', () => {
    it('reject rename, move, copy, and delete (single and batch) under a substituted root before any mutation', () => {
      const actions = createActionService();
      const one = index(projectA, aDir, 'one.png', pngBytes);
      const two = index(projectA, aDir, 'two.png', pngBytes);
      const three = index(projectA, aDir, 'three.png', pngBytes);
      // B carries files at the same relative paths, so an unverified
      // operation would succeed against B's bytes.
      for (const name of ['one.png', 'two.png', 'three.png']) writeFile(bDir, name, Buffer.from(`B:${name}`));
      const rowsBefore = assetRows(projectA.id);
      const bOriginal = snapshotTree(bDir);
      const substituted = substituteBUnderA();

      const attempts = [
        () => actions.renameAsset(projectA.id, one.id, 'renamed.png'),
        () => actions.renameAssetBasename(projectA.id, one.id, 'renamed'),
        () => actions.moveAsset(projectA.id, one.id, finalA.id),
        () => actions.moveAssets(projectA.id, [one.id, two.id, three.id], finalA.id),
        () => actions.copyAssets(projectA.id, [one.id], finalA.id),
        () => actions.copyAssets(projectA.id, [one.id, two.id, three.id], finalA.id),
        () => actions.deleteAssets(projectA.id, [one.id]),
        () => actions.deleteAssets(projectA.id, [one.id, two.id, three.id]),
        () => createActionService().createAlreadyCoordinatedExecutor(capability).renameAssets(
          projectA.id,
          [one.id, two.id],
          { renames: [{ assetId: one.id, basename: 'x1' }, { assetId: two.id, basename: 'x2' }] },
        ),
      ];
      for (const attempt of attempts) {
        expect(attempt).toThrowError(ownershipFailure('MARKER_MISMATCH'));
      }

      expect(snapshotTree(aDir)).toEqual(substituted);
      expect(snapshotTree(bDir)).toEqual(bOriginal);
      expect(assetRows(projectA.id)).toEqual(rowsBefore);
      expectNoStagingResidue(aDir, bDir);
    });

    it('verifies ownership once per batch, not once per asset', async () => {
      const actions = createActionService();
      const ids = ['a.png', 'b.png', 'c.png'].map((name) => index(projectA, aDir, name, pngBytes).id);

      expect(await countMarkerOpens(vi, () => actions.moveAssets(projectA.id, ids, finalA.id))).toBe(1);
      expect(await countMarkerOpens(vi, () => actions.copyAssets(projectA.id, ids, UNCATEGORIZED))).toBe(1);
      expect(await countMarkerOpens(vi, () => createActionService()
        .createAlreadyCoordinatedExecutor(capability)
        .renameAssets(projectA.id, ids, { renames: ids.map((assetId, i) => ({ assetId, basename: `r${i}` })) })))
        .toBe(1);
      expect(await countMarkerOpens(vi, () => actions.deleteAssets(projectA.id, ids))).toBe(1);
    });

    it('fails an unreadable marker safely and succeeds on retry once it is readable (transient share I/O)', () => {
      const actions = createActionService();
      const asset = index(projectA, aDir, 'art.png', pngBytes);
      const realOpen = fs.openSync;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (typeof target === 'string' && path.basename(target) === PROJECT_OWNERSHIP_MARKER_FILENAME) {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        return realOpen(target, ...rest);
      });

      expect(() => actions.renameAsset(projectA.id, asset.id, 'kept.png'))
        .toThrowError(ownershipFailure('MARKER_UNREADABLE'));
      expect(fs.existsSync(path.join(aDir, 'art.png'))).toBe(true);
      expect(assetRepository.findById(asset.id).relative_path).toBe('art.png');

      spy.mockRestore();
      actions.renameAsset(projectA.id, asset.id, 'kept.png');
      expect(fs.existsSync(path.join(aDir, 'kept.png'))).toBe(true);
    });

    it('fails closed for an unbound legacy project', () => {
      const legacy = projectRepository.create({ ...projectInput('Legacy'), slug: 'legacy', projectType: 'images' });
      const relPath = formatProjectDirName(legacy.id, legacy.slug);
      const legacyDir = path.join(projectsRoot, relPath);
      fs.mkdirSync(legacyDir);
      projectRepository.setProjectDir(legacy.id, relPath);
      const asset = index(legacy, legacyDir, 'x.png', pngBytes);

      expect(() => createActionService().renameAsset(legacy.id, asset.id, 'y.png'))
        .toThrowError(ownershipFailure('UNBOUND'));
      expect(fs.existsSync(path.join(legacyDir, 'x.png'))).toBe(true);
    });
  });

  // ── 2/3/4. Processing execution and planning ─────────────────────────

  describe('processing', () => {
    it('rejects every processing mutation architecture under a substituted root before staging or publishing', async () => {
      const watermarkRoot = path.join(tmpDir, 'watermarks');
      const watermarkPath = writeFile(watermarkRoot, 'mark.png', pngBytes);
      const processing = createProcessing({ watermarkPath, watermarkRoot });
      const png = index(projectA, aDir, 'final/png-source.png', pngBytes, { categoryId: finalA.id });
      const prompt = index(projectA, aDir, 'final/prompt.png', promptPng('portrait'), { categoryId: finalA.id });
      writeFile(bDir, 'final/png-source.png', pngBytes);
      writeFile(bDir, 'final/prompt.png', promptPng('portrait'));
      const rowsBefore = assetRows(projectA.id);
      const bOriginal = snapshotTree(bDir);
      const substituted = substituteBUnderA();

      const attempts = [
        // Same-extension re-encode (in-place replacement).
        () => processing.convertAssets(projectA.id, [png.id], { format: 'png', quality: 85, originalHandling: 'keep' }),
        // Sibling output plus Originals move / source deletion.
        () => processing.convertAssets(projectA.id, [png.id], { format: 'webp', quality: 85, originalHandling: 'move' }),
        () => processing.convertAssets(projectA.id, [png.id], { format: 'webp', quality: 85, originalHandling: 'delete' }),
        // Watermark publication with source deletion.
        () => processing.watermarkAssets(projectA.id, [png.id], {
          mode: 'patreon', outputFormat: 'png', deleteSource: true, outputCategorySlug: 'wm',
        }),
        // Archive generation.
        () => processing.createArchives(projectA.id, [png.id], { makeCbz: true, setName: 'Set' }),
        // Workflow/prompt source rewrite.
        () => processing.editWorkflowPrompts(projectA.id, [prompt.id], {
          positive: { rules: [{ type: 'append', text: 'detailed' }] },
        }),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ name: 'ProjectOwnershipError', code: 'MARKER_MISMATCH' });
      }

      expect(snapshotTree(aDir)).toEqual(substituted);
      expect(snapshotTree(bDir)).toEqual(bOriginal);
      expect(assetRows(projectA.id)).toEqual(rowsBefore);
      expectNoStagingResidue(aDir, bDir);
    });

    it('verifies once per execution and still processes a correctly owned project', async () => {
      const processing = createProcessing();
      const first = index(projectA, aDir, 'final/one.png', pngBytes, { categoryId: finalA.id });
      const second = index(projectA, aDir, 'final/two.png', pngBytes, { categoryId: finalA.id });

      const opens = await countMarkerOpens(vi, () => processing.convertAssets(
        projectA.id, [first.id, second.id], { format: 'webp', quality: 85, originalHandling: 'keep' },
      ));
      expect(opens).toBe(1);
      expect(fs.existsSync(path.join(aDir, 'final', 'one.webp'))).toBe(true);
      expect(fs.existsSync(path.join(aDir, 'final', 'two.webp'))).toBe(true);
    });

    it('verifies at planning, and a valid plan is not an ownership witness for later execution', async () => {
      const actions = createActionService();
      const planner = createPlanner(actions.createProcessingPlanner(capability));
      const processing = createProcessing();
      const png = index(projectA, aDir, 'final/art.png', pngBytes, { categoryId: finalA.id });
      const other = index(projectA, aDir, 'final/other.png', pngBytes, { categoryId: finalA.id });
      const scope = { type: 'selected', assetIds: [png.id, other.id] };

      // One verification per plan, even for per-item Rename inspection.
      const renameOptions = { renames: [{ assetId: png.id, basename: 'p1' }, { assetId: other.id, basename: 'p2' }] };
      expect(await countMarkerOpens(vi, () => planner.planRename(projectA.id, scope, renameOptions))).toBe(1);
      const plan = await planner.planConvert(projectA.id, scope, { format: 'webp', quality: 85, originalHandling: 'keep' });
      expect(plan.items.every((item) => item.status === 'ready')).toBe(true);

      substituteBUnderA();
      await expect(planner.planConvert(projectA.id, scope, { format: 'webp', quality: 85, originalHandling: 'keep' }))
        .rejects.toMatchObject({ name: 'ProjectOwnershipError', code: 'MARKER_MISMATCH' });
      await expect(processing.convertAssets(projectA.id, [png.id, other.id], {
        format: 'webp', quality: 85, originalHandling: 'keep',
      })).rejects.toMatchObject({ name: 'ProjectOwnershipError', code: 'MARKER_MISMATCH' });
      await expect(processing.createAlreadyCoordinatedExecutor(capability).convertAssets(projectA.id, [png.id], {
        format: 'webp', quality: 85, originalHandling: 'keep',
      })).rejects.toMatchObject({ name: 'ProjectOwnershipError', code: 'MARKER_MISMATCH' });
      expect(fs.readdirSync(path.join(aDir, 'final'))).toEqual([]);
    });
  });

  // ── 5. Auto Rename ────────────────────────────────────────────────────

  describe('Auto Rename', () => {
    function seed() {
      const first = index(projectA, aDir, 'final/zeta.png', Buffer.from('zeta'), { categoryId: finalA.id });
      const second = index(projectA, aDir, 'final/alpha.png', Buffer.from('alpha'), { categoryId: finalA.id });
      const order = assetRepository.findProjectAssetsByCategoryInBrowserOrder(projectA.id, finalA.id).map((row) => row.id);
      return { first, second, order };
    }

    it('refuses Preview under a substituted root', () => {
      const service = createAutoRename();
      const { order } = seed();
      substituteBUnderA();

      expect(() => service.buildPlan({ projectId: projectA.id, categoryId: finalA.id, orderedAssetIds: order }))
        .toThrowError(expect.objectContaining({
          code: AUTO_RENAME_ERROR_CODES.PROJECT_OWNERSHIP_UNAVAILABLE,
          details: { ownershipCode: 'MARKER_MISMATCH' },
          cause: expect.any(ProjectOwnershipError),
        }));
    });

    it('re-verifies at Apply: a valid Preview does not authorize a substituted root', () => {
      const service = createAutoRename();
      const { order } = seed();
      const plan = service.buildPlan({ projectId: projectA.id, categoryId: finalA.id, orderedAssetIds: order });
      expect(plan.canApply).toBe(true);
      const rowsBefore = assetRows(projectA.id);
      const bOriginal = snapshotTree(bDir);
      const substituted = substituteBUnderA();

      expect(() => service.applyPlan(projectA.id, plan.token)).toThrowError(expect.objectContaining({
        code: AUTO_RENAME_ERROR_CODES.PROJECT_OWNERSHIP_UNAVAILABLE,
      }));
      expect(snapshotTree(aDir)).toEqual(substituted);
      expect(snapshotTree(bDir)).toEqual(bOriginal);
      expect(assetRows(projectA.id)).toEqual(rowsBefore);
    });

    it('verifies Preview once and Apply once, reusing it across temporary and final phases', async () => {
      const service = createAutoRename();
      const { order } = seed();
      let plan;
      expect(await countMarkerOpens(vi, () => {
        plan = service.buildPlan({ projectId: projectA.id, categoryId: finalA.id, orderedAssetIds: order });
      })).toBe(1);
      let result;
      expect(await countMarkerOpens(vi, () => { result = service.applyPlan(projectA.id, plan.token); })).toBe(1);
      expect(result.renamed).toBe(2);
    });
  });

  // ── 6/17. Scanner ─────────────────────────────────────────────────────

  describe('scanner', () => {
    it('aborts a scan of a substituted root before reconciliation', () => {
      const scanner = createScanner();
      writeFile(aDir, 'art.png', pngBytes);
      writeFile(aDir, 'final/keep.png', pngBytes);
      scanner.scanProjectAssets(projectA.id);
      const kept = assetRepository.findByProjectIdAndPath(projectA.id, 'final/keep.png');
      primaryImageRepository.setPrimaryImage(projectA.id, kept.id, PRIMARY_IMAGE_PROVENANCE.AUTOMATIC);
      // B has different bytes at A's paths plus files A never had.
      writeFile(bDir, 'art.png', Buffer.from('B replaces art'));
      writeFile(bDir, 'b-only.png', pngBytes);
      const rowsBefore = assetRows(projectA.id);
      const primaryBefore = primaryImageRepository.findByProjectId(projectA.id);
      substituteBUnderA();
      const reconcile = vi.spyOn(scanner.repository, 'reconcileScannedAssets');
      const setPrimary = vi.spyOn(primaryImageRepository, 'setPrimaryImage');

      expect(() => scanner.scanProjectAssets(projectA.id)).toThrowError(ownershipFailure('MARKER_MISMATCH'));

      expect(reconcile).not.toHaveBeenCalled();
      expect(setPrimary).not.toHaveBeenCalled();
      expect(assetRows(projectA.id)).toEqual(rowsBefore); // nothing missing, no generation advance
      expect(assetRepository.findByProjectIdAndPath(projectA.id, 'b-only.png')).toBeFalsy();
      expect(primaryImageRepository.findByProjectId(projectA.id)).toEqual(primaryBefore);
    });

    it('aborts when the root is replaced during traversal (operation-local continuity)', () => {
      const scanner = createScanner();
      writeFile(aDir, 'art.png', pngBytes);
      scanner.scanProjectAssets(projectA.id);
      const rowsBefore = assetRows(projectA.id);
      const realReaddir = fs.readdirSync;
      let swapped = false;
      vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
        if (!swapped && target === aDir) {
          swapped = true;
          substitution = substituteProjectRoot(aDir, bDir);
        }
        return realReaddir(target, ...rest);
      });
      const reconcile = vi.spyOn(scanner.repository, 'reconcileScannedAssets');
      // A trustworthy file ID catches the swap by identity; where the
      // platform's IDs are unusable (e.g. NTFS IDs beyond 2^53) the marker
      // re-verification catches it instead.
      const expected = rootIdsKnown() ? 'IDENTITY_CHANGED' : 'MARKER_MISMATCH';

      expect(() => scanner.scanProjectAssets(projectA.id)).toThrowError(ownershipFailure(expected));
      expect(swapped).toBe(true);
      expect(reconcile).not.toHaveBeenCalled();
      expect(assetRows(projectA.id)).toEqual(rowsBefore);
    });

    const rootIdsKnown = () => isKnownDirectoryIdentity(fs.lstatSync(aDir));

    it('treats only a usable file ID as continuity proof', () => {
      expect(isKnownDirectoryIdentity({ dev: 1, ino: 42 })).toBe(true);
      expect(isKnownDirectoryIdentity({ dev: 1, ino: 42n })).toBe(true);
      expect(isKnownDirectoryIdentity({ dev: 0, ino: 0 })).toBe(false);
      expect(isKnownDirectoryIdentity({ dev: 1, ino: 0n })).toBe(false);
      expect(isKnownDirectoryIdentity({ dev: 1, ino: 2 ** 53 + 2 })).toBe(false); // precision lost
      expect(isKnownDirectoryIdentity({ dev: 1, ino: undefined })).toBe(false);
      expect(isKnownDirectoryIdentity(null)).toBe(false);
    });

    it('checks continuity by identity when known, and by the marker when not', async () => {
      const verifier = createProjectDirectoryOwnershipVerifier({ ownershipRepository, projectsRoot });
      const verified = verifier.verifyProject(projectA);
      // A known identity that no longer matches fails without a marker read.
      const known = { ...verified, identity: { dev: verified.identity.dev, ino: 1 } };
      expect(await countMarkerOpens(vi, () => {
        expect(() => verifier.assertContinuity(projectA, known)).toThrowError(ownershipFailure('IDENTITY_CHANGED'));
      })).toBe(0);
      // An unknown identity re-verifies the root: A itself passes…
      const unknown = { ...verified, identity: { dev: 0, ino: 0 } };
      expect(await countMarkerOpens(vi, () => verifier.assertContinuity(projectA, unknown))).toBe(1);
      // …a changed stored path does not…
      expect(() => verifier.assertContinuity({ ...projectA, project_dir: projectB.project_dir }, unknown))
        .toThrowError(ownershipFailure('PROJECT_DIRECTORY_INVALID'));
      // …and B's root at A's pathname does not.
      substitution = substituteProjectRoot(aDir, bDir);
      expect(() => verifier.assertContinuity(projectA, unknown)).toThrowError(ownershipFailure('MARKER_MISMATCH'));
    });

    // SMB shares may report no usable file IDs. Force every operation-local
    // identity the scan sees to the "unavailable" sentinel (ino 0).
    function forceUnavailableFileIds() {
      for (const method of ['lstatSync', 'statSync', 'fstatSync']) {
        const real = fs[method];
        vi.spyOn(fs, method).mockImplementation((...args) => {
          const stats = real(...args);
          if (stats) stats.ino = typeof stats.ino === 'bigint' ? 0n : 0;
          return stats;
        });
      }
    }

    it('without usable file IDs, re-verifies the marker after traversal and refuses a substituted root', () => {
      const scanner = createScanner();
      writeFile(aDir, 'a-only.png', pngBytes);
      writeFile(aDir, 'final/keep.png', pngBytes);
      scanner.scanProjectAssets(projectA.id);
      const kept = assetRepository.findByProjectIdAndPath(projectA.id, 'final/keep.png');
      primaryImageRepository.setPrimaryImage(projectA.id, kept.id, PRIMARY_IMAGE_PROVENANCE.AUTOMATIC);
      writeFile(bDir, 'b-only.png', pngBytes);
      const rowsBefore = assetRows(projectA.id);
      const primaryBefore = primaryImageRepository.findByProjectId(projectA.id);

      forceUnavailableFileIds();
      const realReaddir = fs.readdirSync;
      let swapped = false;
      // A is verified first; B's root appears at A's pathname mid-traversal.
      vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
        if (!swapped && target === aDir) {
          swapped = true;
          substitution = substituteProjectRoot(aDir, bDir);
        }
        return realReaddir(target, ...rest);
      });
      const reconcile = vi.spyOn(scanner.repository, 'reconcileScannedAssets');
      const setPrimary = vi.spyOn(primaryImageRepository, 'setPrimaryImage');
      const transaction = vi.spyOn(db, 'transaction');

      expect(() => scanner.scanProjectAssets(projectA.id)).toThrowError(ownershipFailure('MARKER_MISMATCH'));
      expect(swapped).toBe(true);
      expect(reconcile).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(setPrimary).not.toHaveBeenCalled();
      // A's rows (presence, source generations) are exactly as before, and
      // nothing from B was imported under A.
      expect(assetRows(projectA.id)).toEqual(rowsBefore);
      expect(assetRepository.findByProjectIdAndPath(projectA.id, 'b-only.png')).toBeFalsy();
      expect(primaryImageRepository.findByProjectId(projectA.id)).toEqual(primaryBefore);
    });

    it('without usable file IDs, scans a correctly owned root normally (one extra marker read)', async () => {
      const scanner = createScanner();
      writeFile(aDir, 'a-only.png', pngBytes);
      forceUnavailableFileIds();

      let result;
      const opens = await countMarkerOpens(vi, () => { result = scanner.scanProjectAssets(projectA.id); });
      expect(result).toMatchObject({ added: 1, removed: 0, total: 1 });
      expect(assetRepository.findByProjectIdAndPath(projectA.id, 'a-only.png')).toMatchObject({ is_present: 1 });
      // Constant per scan: before traversal and once after, never per file.
      expect(opens).toBe(2);

      writeFile(aDir, 'final/more.png', pngBytes);
      writeFile(aDir, 'final/again.png', pngBytes);
      expect(await countMarkerOpens(vi, () => { result = scanner.scanProjectAssets(projectA.id); })).toBe(2);
      expect(result).toMatchObject({ added: 2, removed: 0, total: 3 });
    });

    it('treats an unavailable root or unreadable marker as a failed scan, keeps the snapshot, and recovers on retry', () => {
      const scanner = createScanner();
      writeFile(aDir, 'art.png', pngBytes);
      writeFile(aDir, 'final/more.png', pngBytes);
      scanner.scanProjectAssets(projectA.id);
      const rowsBefore = assetRows(projectA.id);

      // Share disconnected: the whole root is momentarily gone.
      const offline = `${aDir}.offline`;
      fs.renameSync(aDir, offline);
      expect(() => scanner.scanProjectAssets(projectA.id)).toThrowError(ownershipFailure('PROJECT_DIRECTORY_MISSING'));
      expect(assetRows(projectA.id)).toEqual(rowsBefore);
      fs.renameSync(offline, aDir);

      // Share reachable but the marker read hits an I/O error.
      const realOpen = fs.openSync;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (typeof target === 'string' && path.basename(target) === PROJECT_OWNERSHIP_MARKER_FILENAME) {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        return realOpen(target, ...rest);
      });
      expect(() => scanner.scanProjectAssets(projectA.id)).toThrowError(ownershipFailure('MARKER_UNREADABLE'));
      expect(assetRows(projectA.id)).toEqual(rowsBefore);
      spy.mockRestore();

      // Availability returns: the retry succeeds and nothing was lost.
      expect(scanner.scanProjectAssets(projectA.id)).toMatchObject({ added: 0, removed: 0, total: 2 });
      expect(assetRows(projectA.id).every((row) => row.is_present === 1)).toBe(true);
    });

    it('keeps SMB-style external edits inside an owned root working, once per scan', async () => {
      const scanner = createScanner();
      writeFile(aDir, 'art.png', pngBytes);
      scanner.scanProjectAssets(projectA.id);
      const before = assetRepository.findByProjectIdAndPath(projectA.id, 'art.png');

      // External edits: artwork rewritten, a new subfolder, a removed file.
      const edited = await sharp({ create: { width: 9, height: 9, channels: 3, background: '#00ff00' } }).png().toBuffer();
      writeFile(aDir, 'art.png', edited);
      fs.utimesSync(path.join(aDir, 'art.png'), new Date(), new Date(Date.now() + 5000));
      writeFile(aDir, 'new-folder/sketch.png', pngBytes);
      writeFile(aDir, 'gone.png', pngBytes);
      scanner.scanProjectAssets(projectA.id);
      fs.rmSync(path.join(aDir, 'gone.png'));

      let result;
      // One marker read per scan; one more only when file IDs are unusable.
      expect(await countMarkerOpens(vi, () => { result = scanner.scanProjectAssets(projectA.id); }))
        .toBe(rootIdsKnown() ? 1 : 2);
      expect(result.removed).toBe(1); // ordinary child-file disappearance still reconciles
      const after = assetRepository.findByProjectIdAndPath(projectA.id, 'art.png');
      expect(after.size_bytes).toBe(edited.length);
      expect(after.source_generation).toBeGreaterThan(before.source_generation ?? 0);
      expect(assetRepository.findByProjectIdAndPath(projectA.id, 'new-folder/sketch.png')?.is_present).toBe(1);
    });

    it('keeps ownership through a project-directory rename (marker travels, no stored inode)', () => {
      const scanner = createScanner();
      writeFile(aDir, 'art.png', pngBytes);
      scanner.scanProjectAssets(projectA.id);
      const renamed = projectService.update(projectA.id, { ...projectInput('Alpha Renamed') });
      expect(renamed.project_dir).not.toBe(projectA.project_dir);

      expect(scanner.scanProjectAssets(projectA.id)).toMatchObject({ removed: 0, total: 1 });
    });

    it('lets the scheduler fail an unbound project independently and keep scanning healthy ones', async () => {
      const scanner = createScanner();
      const legacy = projectRepository.create({ ...projectInput('Legacy'), slug: 'legacy', projectType: 'images' });
      const relPath = formatProjectDirName(legacy.id, legacy.slug);
      fs.mkdirSync(path.join(projectsRoot, relPath));
      writeFile(path.join(projectsRoot, relPath), 'legacy.png', pngBytes);
      projectRepository.setProjectDir(legacy.id, relPath);
      writeFile(bDir, 'healthy.png', pngBytes);
      const logger = { log: vi.fn(), error: vi.fn() };
      const scheduler = createAutomaticProjectScanScheduler({
        intervalMinutes: 60,
        getScanDependencies: () => ({ projectService, assetScanner: scanner, appMetaRepository: createAppMetaRepository(db) }),
        logger,
      });

      const summary = await scheduler.runCycle();

      expect(summary.failed).toBe(1);
      expect(summary.scanned).toBe(2); // A and B
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`project ${legacy.id}`));
      expect(assetRepository.findByProjectIdAndPath(projectB.id, 'healthy.png')?.is_present).toBe(1);
      expect(assetRows(legacy.id)).toEqual([]);
      // Still operational: a second cycle runs normally.
      expect(await scheduler.runCycle()).toMatchObject({ scanned: 2, failed: 1 });
    });
  });

  // ── 7/19. Source-derived DB authority ─────────────────────────────────

  describe('source reconciliation', () => {
    function createSourceAnimation() {
      return createSourceAnimationService({
        assetRepository, projectRepository, projectsRoot, projectDirectoryOwnershipRepository: ownershipRepository,
      });
    }

    it('commits no B-derived facts into A under a substituted root', async () => {
      const service = createSourceAnimation();
      const still = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).webp().toBuffer();
      const asset = index(projectA, aDir, 'anim.webp', still, { mimeType: 'image/webp' });
      writeFile(bDir, 'anim.webp', await makeAnimatedWebp(2));
      substituteBUnderA();
      // Make A's row describe the file now at the path, so only ownership
      // stands between B's bytes and A's animation state.
      const onDisk = fs.statSync(path.join(aDir, 'anim.webp'));
      db.prepare('UPDATE assets SET size_bytes = ?, modified_at = ?, source_animated = NULL WHERE id = ?')
        .run(onDisk.size, onDisk.mtime.toISOString(), asset.id);
      const row = assetRepository.findById(asset.id);

      expect(service.ensureKnown(row)).toMatchObject({ source_animated: null });
      expect(service.reconcileSource(row, { replaced: true })).toBeNull();
      expect(assetRepository.findById(asset.id)).toEqual(row);
    });

    it('still detects and reconciles in-place source edits in an owned root', async () => {
      const service = createSourceAnimation();
      const asset = index(projectA, aDir, 'art.png', pngBytes);
      const edited = await sharp({ create: { width: 7, height: 7, channels: 3, background: '#abcdef' } }).png().toBuffer();
      writeFile(aDir, 'art.png', edited);

      const updated = service.reconcileSource(asset);
      expect(updated).toMatchObject({ size_bytes: edited.length });
      expect(updated.source_generation).toBe((asset.source_generation ?? 0) + 1);

      const animated = index(projectA, aDir, 'loop.webp', await makeAnimatedWebp(2), { mimeType: 'image/webp' });
      expect(service.ensureKnown(animated)).toMatchObject({ source_animated: 1 });
    });
  });

  // ── 8/20. Krita source-dependent selection ────────────────────────────

  describe('Krita-merged primary-image eligibility', () => {
    async function kra({ merged }) {
      const preview = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#444444' } }).png().toBuffer();
      const entries = [{ name: 'preview.png', data: preview }];
      if (merged) {
        entries.push({
          name: 'mergedimage.png',
          data: await sharp({ create: { width: 16, height: 16, channels: 3, background: '#888888' } }).png().toBuffer(),
        });
      }
      return makeZip(entries);
    }

    function createServices() {
      const previewService = createPreviewService({
        db, projectsRoot, previewRoot: path.join(tmpDir, 'previews'),
        projectDirectoryOwnershipRepository: ownershipRepository,
      });
      const primaryImages = createProjectPrimaryImageService({
        db,
        projectRepository,
        assetRepository,
        projectPrimaryImageRepository: primaryImageRepository,
        previewProbe: previewService.inspectKritaPreviewSource,
      });
      return { previewService, primaryImages };
    }

    it("cannot authorize A's selection from B's bytes", async () => {
      const { previewService, primaryImages } = createServices();
      const asset = index(projectA, aDir, 'draw.kra', await kra({ merged: false }), { mimeType: 'application/x-krita' });
      writeFile(bDir, 'draw.kra', await kra({ merged: true }));
      substituteBUnderA();
      // A's row now matches the substituted file, as a stale index might.
      const onDisk = fs.statSync(path.join(aDir, 'draw.kra'));
      db.prepare('UPDATE assets SET size_bytes = ?, modified_at = ? WHERE id = ?')
        .run(onDisk.size, onDisk.mtime.toISOString(), asset.id);

      expect(await previewService.inspectKritaPreviewSource(projectA, asset)).toEqual({ quality: null });
      await expect(Promise.resolve().then(() => primaryImages.setPrimaryImage(projectA.id, asset.id)))
        .rejects.toMatchObject({ code: 'ASSET_UNSUPPORTED' });
      expect(primaryImageRepository.findByProjectId(projectA.id)).toBeFalsy();
    });

    it('keeps valid owned selection unchanged and uses one verification per probe', async () => {
      const { previewService, primaryImages } = createServices();
      const asset = index(projectA, aDir, 'draw.kra', await kra({ merged: true }), { mimeType: 'application/x-krita' });

      expect(await countMarkerOpens(vi, () => primaryImages.setPrimaryImage(projectA.id, asset.id))).toBe(1);
      expect(primaryImageRepository.findByProjectId(projectA.id)).toMatchObject({ asset_id: asset.id });
      // The viewer's presentation hint stays a pure read.
      let hint;
      expect(await countMarkerOpens(vi, async () => {
        hint = await previewService.inspectKritaPreviewPresentation(projectA, asset);
      })).toBe(0);
      expect(hint.quality).toBe('merged');
    });
  });

  // ── 21. Pure read-only serving (approved residual limitation) ─────────

  describe('pure read-only source serving', () => {
    it('adds no ownership-marker read and — documented limitation — serves whatever is at the safe path', async () => {
      const previewService = createPreviewService({
        db, projectsRoot, previewRoot: path.join(tmpDir, 'previews'),
        projectDirectoryOwnershipRepository: ownershipRepository,
      });
      const media = createMediaService({ previewService, projectsRoot, previewRoot: path.join(tmpDir, 'previews') });
      const asset = index(projectA, aDir, 'art.png', pngBytes);
      const read = async () => {
        const response = media.prepareOriginalResponse(projectA.id, asset.id);
        const chunks = [];
        try {
          for await (const chunk of response.stream) chunks.push(chunk);
        } finally {
          response.cleanup();
        }
        return Buffer.concat(chunks);
      };

      let bytes;
      expect(await countMarkerOpens(vi, async () => { bytes = await read(); })).toBe(0);
      expect(bytes.equals(pngBytes)).toBe(true);

      // Residual limitation (approved): a whole-root substitution before a
      // pure read is not detected by serving; mutations and DB authority are.
      const bBytes = Buffer.from(pngBytes);
      writeFile(bDir, 'art.png', bBytes);
      substituteBUnderA();
      expect(await countMarkerOpens(vi, async () => { bytes = await read().catch(() => null); })).toBe(0);
    });
  });
});
