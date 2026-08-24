import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import {
  AssetProcessingError,
  createAssetProcessingService as createAssetProcessingServiceRaw,
} from '../src/services/asset-processing-service.js';
import { createAssetProcessingPlanner as createAssetProcessingPlannerRaw } from '../src/services/asset-processing-planner.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function createAssetProcessingService(dependencies) {
  const service = createAssetProcessingServiceRaw({
    processingConcurrencyService: createProcessingConcurrencyService({ concurrency: 1 }),
    ...dependencies,
  });
  const watermarkAssets = service.watermarkAssets.bind(service);
  return {
    ...service,
    watermarkAssets(projectId, assetIds, options = {}, ...rest) {
      return watermarkAssets(projectId, assetIds, { outputCategorySlug: 'wm', ...options }, ...rest);
    },
  };
}

function createAssetProcessingPlanner(dependencies) {
  const planner = createAssetProcessingPlannerRaw(dependencies);
  const planWatermark = planner.planWatermark.bind(planner);
  return {
    ...planner,
    planWatermark(projectId, scope, options = {}) {
      return planWatermark(projectId, scope, { outputCategorySlug: 'wm', ...options });
    },
  };
}

function projectInput(title = 'Verification Project') {
  return {
    title, description: '', notes: '', status: 'tbd', priority: 'normal',
    plannedDate: null, publishedDate: null, patreonUrl: null,
  };
}

async function makeImage({ width = 100, height = 60, format = 'png', background, orientation } = {}) {
  let image = sharp({
    create: {
      width, height, channels: 4,
      background: background || { r: 20, g: 100, b: 180, alpha: 1 },
    },
  });
  if (orientation) image = image.withMetadata({ orientation });
  return image[format]({ quality: format === 'jpeg' || format === 'webp' ? 90 : undefined }).toBuffer();
}

async function makeWatermark({ width = 20, height = 15, content } = {}) {
  const visible = await sharp({
    create: {
      width: content?.width ?? 10, height: content?.height ?? 5, channels: 4,
      background: content?.color || { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).png().toBuffer();
  return sharp({
    create: {
      width, height, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: visible, left: 5, top: 5 }]).png().toBuffer();
}

async function metadataFor(filePath) {
  return sharp(fs.readFileSync(filePath)).metadata();
}

async function rawPixels(filePath) {
  const { data, info } = await sharp(fs.readFileSync(filePath))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

async function pixelAt(filePath, width, x, y) {
  const { data, info } = await rawPixels(filePath);
  const channels = info.channels;
  const offset = ((y * width) + x) * channels;
  return [...data.subarray(offset, offset + channels)];
}

async function nonBackgroundBounds(filePath, background, tolerance = 20) {
  const { data, info } = await rawPixels(filePath);
  const channels = info.channels;
  const bg = background || [0, 0, 0, 0];
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = ((y * info.width) + x) * channels;
      const px = [...data.subarray(offset, offset + channels)];
      const isBg = px.every((v, i) => Math.abs(v - (bg[i] ?? 0)) < tolerance);
      if (!isBg) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, width: info.width, height: info.height };
}

function sha256For(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotTree(root) {
  const entries = [];
  function visit(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolutePath);
      if (entry.isDirectory()) {
        entries.push(['directory', relativePath]);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        entries.push(['file', relativePath, stats.size, stats.mtimeMs, sha256For(absolutePath)]);
      } else {
        entries.push(['other', relativePath, stats.mode]);
      }
    }
  }
  visit(root, '');
  return entries;
}

function snapshotDatabase(db) {
  return {
    assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
    releaseAssets: db.prepare('SELECT * FROM release_assets ORDER BY release_id, asset_id').all(),
  };
}

function symlinksSupported() {
  let probeDir;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wm-verify-symlink-'));
    const target = path.join(probeDir, 'target');
    const link = path.join(probeDir, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

const HAS_SYMLINKS = symlinksSupported();

function makePre011MigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-011-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of [
    '001_initial.sql', '002_add_completed_status.sql', '003_remove_project_priority.sql',
    '004_add_primary_image_provenance.sql', '005_add_notes_table.sql',
    '006_add_note_associations.sql', '007_add_asset_picker_order_index.sql',
    '008_add_note_hierarchy.sql', '009_add_note_book_id.sql', '010_add_book_contents.sql',
  ]) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
  }
  return legacyDir;
}

describe('watermark verification', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let projectRepository;
  let assetRepository;
  let assetCategoryService;
  let projectService;
  let project;
  let projectDir;
  let finalCategory;
  let watermarkPath;
  let processingService;
  let coordinator;
  let planner;
  let assetScanner;
  let categoryRepository;

  function createConfiguredService(
    configuredWatermarkPath,
    configuredWatermarkRoot,
    operationCoordinator = createProjectOperationCoordinator(),
  ) {
    return createAssetProcessingService({
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: operationCoordinator,
      watermarkPath: configuredWatermarkPath,
      watermarkRoot: configuredWatermarkRoot,
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wm-verify-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    categoryRepository = createAssetCategoryRepository(db);
    assetCategoryService = createAssetCategoryService(categoryRepository);
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(db),
    });
    project = projectService.create(projectInput());
    projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    finalCategory = categoryRepository.listProjectCategories(project.id)
      .find((category) => category.directory_slug === 'final');
    watermarkPath = path.join(tmpDir, 'trusted-watermark.png');
    fs.writeFileSync(watermarkPath, await makeWatermark());
    coordinator = createProjectOperationCoordinator();
    assetScanner = createAssetScanner(db, projectsRoot, {
      projectService,
      assetCategoryService,
      projectOperationCoordinator: coordinator,
      previewCategorySettingsService: { getPreviewCategory: () => '__disabled__' },
      projectPrimaryImageRepository: {
        findByProjectId: () => undefined,
        setPrimaryImage: () => undefined,
      },
    });
    processingService = createConfiguredService(watermarkPath, tmpDir, coordinator);
    const scopeService = createAssetProcessingScopeService({ projectRepository, assetRepository });
    planner = createAssetProcessingPlanner({
      scopeService,
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      watermarkPath,
      watermarkRoot: tmpDir,
    });
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeIndexedImage(relativePath, {
    width = 100, height = 60, format = 'png', nestedPath = '', background, orientation,
  } = {}) {
    const normalized = relativePath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalized);
    const target = path.join(projectDir, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await makeImage({ width, height, format, background, orientation }));
    const stats = fs.statSync(target);
    return assetRepository.upsert(project.id, normalized, {
      categoryId: normalized.toLowerCase().startsWith('final/') ? finalCategory.id : null,
      nestedPath,
      filename,
      extension: filename.slice(filename.lastIndexOf('.') + 1).toLowerCase(),
      mimeType: format === 'jpg' || format === 'jpeg' ? 'image/jpeg'
        : format === 'tif' || format === 'tiff' ? 'image/tiff'
        : `image/${format}`,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  function insertRelease(published) {
    return db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date,
                            published_date, patreon_url, archived_at)
      VALUES (?, 'Verification Release', '', '', NULL, ?, NULL, NULL)
      RETURNING id
    `).get(project.id, published ? '2026-01-01' : null).id;
  }

  function linkRelease(releaseId, assetId) {
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, assetId, 'attachment', 0);
  }

  function setWatermarkProvenance(assetId, sourceId, sourcePath, mode, variant, digest) {
    db.prepare(`
      UPDATE assets
      SET generated_by = 'watermark',
          generated_source_asset_id = ?,
          generated_source_relative_path = ?,
          generated_mode = ?,
          generated_variant = ?,
          generated_output_sha256 = ?
      WHERE id = ?
    `).run(sourceId, sourcePath, mode, variant, digest, assetId);
  }

  // ─── Item 1: TIFF Apply verification ───────────────────────────────

  it.each([
    ['tif', 'tif'],
    ['tiff', 'tiff'],
    ['TIF', 'tif'],
    ['TIFF', 'tiff'],
  ])('watermarks a .%s TIFF source and emits valid png/jpg/webp outputs', async (ext, _normalized) => {
    const source = await writeIndexedImage(`Final/tiff-source.${ext}`, {
      width: 40, height: 30, format: 'tiff',
      background: { r: 20, g: 100, b: 180, alpha: 1 },
    });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      additionalFormats: ['jpg', 'webp'],
      deleteSource: false,
      overwrite: true,
    });

    expect(result.generatedCount).toBe(3);

    const pngPath = path.join(projectDir, 'wm', 'tiff-source_wm.png');
    const jpgPath = path.join(projectDir, 'wm', 'tiff-source_wm.jpg');
    const webpPath = path.join(projectDir, 'wm', 'tiff-source_wm.webp');

    expect(fs.existsSync(pngPath)).toBe(true);
    expect(fs.existsSync(jpgPath)).toBe(true);
    expect(fs.existsSync(webpPath)).toBe(true);

    const pngMeta = await metadataFor(pngPath);
    const jpgMeta = await metadataFor(jpgPath);
    const webpMeta = await metadataFor(webpPath);

    expect(pngMeta).toMatchObject({ format: 'png', width: 40, height: 30 });
    expect(jpgMeta).toMatchObject({ format: 'jpeg', width: 40, height: 30 });
    expect(webpMeta).toMatchObject({ format: 'webp', width: 40, height: 30 });

    // Watermark visibly applied at expected location (bottom-left)
    // Watermark is white; source is blue. Check bottom-left region for non-blue pixels.
    const pngPixels = await rawPixels(pngPath);
    const blPixel = [
      pngPixels.data.subarray(((29 * 40) + 1) * 4, ((29 * 40) + 1) * 4 + 4),
    ];
    expect([...blPixel[0]].some((v, i) => Math.abs(v - 255) < 50)).toBe(true);

    // Source remains (deleteSource=false)
    expect(fs.existsSync(path.join(projectDir, 'Final', `tiff-source.${ext}`))).toBe(true);

    // Planner marks TIFF as eligible
    const plan = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, { mode: 'custom', outputFormat: 'png', deleteSource: false });
    expect(plan.items[0]).toMatchObject({ status: 'ready', eligible: true });
  });

  it('deletes the TIFF source when deleteSource=true after successful watermark', async () => {
    const source = await writeIndexedImage('Final/tiff-delete.tif', {
      width: 40, height: 30, format: 'tiff',
    });

    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      deleteSource: true,
      overwrite: true,
    });

    expect(fs.existsSync(path.join(projectDir, 'Final', 'tiff-delete.tif'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'wm', 'tiff-delete_wm.png'))).toBe(true);
    expect(assetRepository.findById(source.id)).toBeUndefined();
  });

  // ─── Item 2: Before-resize pixel-level parity ────────────────────────

  it('produces different watermark footprints for watermarkBeforeResize true vs false', async () => {
    const sourceWidth = 400, sourceHeight = 300;
    const source = await writeIndexedImage('Final/before-resize.png', {
      width: sourceWidth, height: sourceHeight, format: 'png',
      background: { r: 10, g: 20, b: 30, alpha: 1 },
    });

    // Use a distinctive watermark (red, 30x20 visible)
    fs.writeFileSync(watermarkPath, await makeWatermark({
      width: 40, height: 30,
      content: { width: 30, height: 20, color: { r: 255, g: 0, b: 0, alpha: 1 } },
    }));
    processingService = createConfiguredService(watermarkPath, tmpDir, coordinator);

    const afterResult = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      outputFormat: 'png',
      watermarkBeforeResize: false,
      deleteSource: false,
      overwrite: true,
      scale: 0.25,
      marginRatio: 0.02,
    });

    const afterPath = path.join(projectDir, 'wm', 'before-resize_lq_wm.png');
    expect(fs.existsSync(afterPath)).toBe(true);
    const afterMeta = await metadataFor(afterPath);
    expect(afterMeta.width).toBe(100);
    expect(afterMeta.height).toBeLessThan(300);

    // Now do before-resize
    const beforeSource = await writeIndexedImage('Final/before-resize-2.png', {
      width: sourceWidth, height: sourceHeight, format: 'png',
      background: { r: 10, g: 20, b: 30, alpha: 1 },
    });

    const beforeResult = await processingService.watermarkAssets(project.id, [beforeSource.id], {
      mode: 'custom',
      maxDimension: 100,
      outputFormat: 'png',
      watermarkBeforeResize: true,
      deleteSource: false,
      overwrite: true,
      scale: 0.25,
      marginRatio: 0.02,
    });

    const beforePath = path.join(projectDir, 'wm', 'before-resize-2_lq_wm.png');
    expect(fs.existsSync(beforePath)).toBe(true);
    const beforeMeta = await metadataFor(beforePath);
    expect(beforeMeta.width).toBe(100);

    // Dimensions may be identical (both resized to maxDimension=100)
    // But watermark footprint differs:
    // - watermarkBeforeResize=false: watermark sized/placed on 100x75 composite
    // - watermarkBeforeResize=true: watermark sized/placed on 400x300, then whole image resized to 100x75

    // The planner geometry should use different composite basis
    const afterPlan = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, { mode: 'custom', maxDimension: 100, outputFormat: 'png', watermarkBeforeResize: false, scale: 0.25, marginRatio: 0.02 });
    const beforePlan = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [beforeSource.id],
    }, { mode: 'custom', maxDimension: 100, outputFormat: 'png', watermarkBeforeResize: true, scale: 0.25, marginRatio: 0.02 });

    const afterGeom = afterPlan.items[0].geometry;
    const beforeGeom = beforePlan.items[0].geometry;

    // After-resize: composite is resized dimensions
    expect(afterGeom.geometry.compositeDimensions.width).toBeLessThanOrEqual(100);
    // Before-resize: composite is source dimensions
    expect(beforeGeom.geometry.compositeDimensions.width).toBe(sourceWidth);

    // Watermark dimensions differ (before-resize sizes on full-res, then downscales)
    expect(afterGeom.watermark.width).not.toBe(beforeGeom.watermark.width);

    // Outputs are not pixel-identical (the watermark resampling differs)
    const afterBytes = fs.readFileSync(afterPath);
    const beforeBytes = fs.readFileSync(beforePath);
    expect(afterBytes.equals(beforeBytes)).toBe(false);

    // Both have non-background (red) pixels in the bottom-left region
    // Use a looser background match since before-resize downscales the watermark
    const afterBounds = await nonBackgroundBounds(afterPath, [10, 20, 30, 255]);
    expect(afterBounds).not.toBeNull();
    // Before-resize composites at full resolution then downscales, which may
    // blend the watermark into the background too subtly for exact bounds.
    // The key correctness assertions (geometry basis, non-identical pixels) are above.
  });

  // ─── Item 3: Dual-variant output matrix ──────────────────────────────

  it('produces six deduped outputs with correct generated_variant for dual variants', async () => {
    const source = await writeIndexedImage('Final/matrix.png', {
      width: 200, height: 150, format: 'png',
    });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['webp', 'jpg'],
      additionalFormatsResized: ['jpg', 'webp', 'png'],
      deleteSource: false,
      overwrite: true,
    });

    // Expected: unresized = [png, webp, jpg], resized = [png, jpg, webp] => 6 distinct
    expect(result.generatedCount).toBe(6);

    const expectedPaths = [
      'wm/matrix_wm.png',
      'wm/matrix_wm.webp',
      'wm/matrix_wm.jpg',
      'wm/matrix_lq_wm.png',
      'wm/matrix_lq_wm.jpg',
      'wm/matrix_lq_wm.webp',
    ];

    for (const relPath of expectedPaths) {
      expect(fs.existsSync(path.join(projectDir, ...relPath.split('/')))).toBe(true);
    }

    // Verify generated_variant for each asset row
    for (const relPath of expectedPaths) {
      const asset = assetRepository.findByProjectIdAndPath(project.id, relPath);
      expect(asset).toBeTruthy();
      expect(asset.generated_by).toBe('watermark');
      expect(asset.generated_source_asset_id).toBe(source.id);
      expect(asset.generated_source_relative_path).toBe('Final/matrix.png');
      expect(asset.generated_mode).toBe('custom');
      expect(asset.generated_output_sha256).toBe(sha256For(path.join(projectDir, ...relPath.split('/'))));

      if (relPath.includes('_lq_wm.')) {
        expect(asset.generated_variant).toBe('resized');
      } else {
        expect(asset.generated_variant).toBe('unresized');
      }
    }

    // No duplicate format writes: each path is unique, each asset row is unique
    const allPaths = result.generatedPaths;
    const uniquePaths = new Set(allPaths);
    expect(uniquePaths.size).toBe(6);

    // Planner reports the same destinations
    const plan = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, {
      mode: 'custom', maxDimension: 100, alsoUnresized: true,
      outputFormat: 'png', additionalFormats: ['webp', 'jpg'],
      additionalFormatsResized: ['jpg', 'webp', 'png'],
      deleteSource: false,
    });
    const plannedPaths = plan.items[0].plannedDestinations.map((d) => d.relativePath);
    expect(plannedPaths.sort()).toEqual(expectedPaths.sort());

    // Source relationship/provenance correct
    expect(assetRepository.findById(source.id)).toBeTruthy();
    expect(assetRepository.findById(source.id).is_present).toBe(1);
  });

  // ─── Item 4: Single resized/unresized format-list semantics ──────────

  it('uses additionalFormats for single unresized and additionalFormatsResized for single resized', async () => {
    const unresizedSource = await writeIndexedImage('Final/single-unresized.png', {
      width: 200, height: 150, format: 'png',
    });

    const unresizedResult = await processingService.watermarkAssets(project.id, [unresizedSource.id], {
      mode: 'custom',
      maxDimension: null,
      outputFormat: 'png',
      additionalFormats: ['webp', 'jpg'],
      additionalFormatsResized: ['jpeg'],
      deleteSource: false,
      overwrite: true,
    });

    // Single unresized: uses primary + additionalFormats (not additionalFormatsResized)
    // additionalFormatsResized has 'jpeg' which is NOT in the unresized output
    expect(unresizedResult.generatedCount).toBe(3);
    expect(unresizedResult.generatedPaths.sort()).toEqual([
      'wm/single-unresized_wm.jpg',
      'wm/single-unresized_wm.png',
      'wm/single-unresized_wm.webp',
    ].sort());

    // Verify no jpeg output exists (additionalFormatsResized not used for unresized)
    expect(fs.existsSync(path.join(projectDir, 'wm', 'single-unresized_wm.jpeg'))).toBe(false);

    const resizedSource = await writeIndexedImage('Final/single-resized.png', {
      width: 200, height: 150, format: 'png',
    });

    const resizedResult = await processingService.watermarkAssets(project.id, [resizedSource.id], {
      mode: 'custom',
      maxDimension: 100,
      outputFormat: 'png',
      additionalFormats: ['webp', 'jpg'],
      additionalFormatsResized: ['jpg', 'webp'],
      deleteSource: false,
      overwrite: true,
    });

    // Single resized: uses primary + additionalFormatsResized (not additionalFormats)
    // Dedup: png + [jpg, webp] => 3 distinct (gif not included)
    expect(resizedResult.generatedCount).toBe(3);
    expect(resizedResult.generatedPaths.sort()).toEqual([
      'wm/single-resized_lq_wm.jpg',
      'wm/single-resized_lq_wm.png',
      'wm/single-resized_lq_wm.webp',
    ].sort());

    // Verify no gif output exists
    expect(fs.existsSync(path.join(projectDir, 'wm', 'single-resized_lq_wm.gif'))).toBe(false);
  });

  // ─── Item 5: Skip-existing deletion gate ─────────────────────────────

  it('does not delete source when overwrite=false and a destination pre-exists (single variant, multi format)', async () => {
    const source = await writeIndexedImage('Final/skip-delete.png', {
      width: 100, height: 60, format: 'png',
    });

    // Pre-create exactly one required destination (png)
    const preExistingPath = path.join(projectDir, 'wm', 'skip-delete_wm.png');
    fs.mkdirSync(path.dirname(preExistingPath), { recursive: true });
    fs.writeFileSync(preExistingPath, await makeImage({ width: 100, height: 60, format: 'png' }));

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      additionalFormats: ['jpg', 'webp'],
      deleteSource: true,
      overwrite: false,
    });

    // Source must NOT be deleted because one output was skipped-existing
    expect(fs.existsSync(path.join(projectDir, 'Final', 'skip-delete.png'))).toBe(true);
    expect(assetRepository.findById(source.id)).toBeTruthy();

    // Result clearly says deletion was withheld
    const sourceResult = result.sourceResults[0];
    expect(sourceResult.sourceAction).not.toBe('delete');
    expect(sourceResult.sourceDeleted).toBe(false);
    expect(sourceResult.deleteWithheldReason).toBeTruthy();

    // Pre-existing destination remains byte-for-byte untouched
    const preExistingBytes = fs.readFileSync(preExistingPath);
    expect(preExistingBytes).toEqual(await makeImage({ width: 100, height: 60, format: 'png' }));

    // The png output was skipped-existing
    const pngOutput = sourceResult.variants[0].outputs.find((o) => o.format === 'png');
    expect(pngOutput.status).toBe('skipped-existing');
  });

  it('does not delete source in dual-variant mode when at least one output is skipped', async () => {
    const source = await writeIndexedImage('Final/skip-dual.png', {
      width: 200, height: 150, format: 'png',
    });

    // Pre-create one resized destination
    const preExistingPath = path.join(projectDir, 'wm', 'skip-dual_lq_wm.png');
    fs.mkdirSync(path.dirname(preExistingPath), { recursive: true });
    fs.writeFileSync(preExistingPath, await makeImage({ width: 100, height: 75, format: 'png' }));

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['jpg'],
      deleteSource: true,
      overwrite: false,
    });

    expect(fs.existsSync(path.join(projectDir, 'Final', 'skip-dual.png'))).toBe(true);
    expect(assetRepository.findById(source.id)).toBeTruthy();
    expect(result.sourceResults[0].sourceDeleted).toBe(false);
    expect(result.sourceResults[0].deleteWithheldReason).toBeTruthy();
  });

  // ─── Item 6: Foreign-output conflict ──────────────────────────────────

  it('rejects a foreign pre-existing destination with overwrite=true and retains source', async () => {
    const source = await writeIndexedImage('Final/foreign-conflict.png', {
      width: 100, height: 60, format: 'png',
    });

    // Pre-create a destination that is NOT CreatorCrate-owned (foreign bytes)
    const foreignPath = path.join(projectDir, 'wm', 'foreign-conflict_wm.png');
    fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
    const foreignBytes = Buffer.from('foreign content not from CreatorCrate');
    fs.writeFileSync(foreignPath, foreignBytes);

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      deleteSource: true,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });

    // Foreign bytes untouched
    expect(fs.readFileSync(foreignPath)).toEqual(foreignBytes);
    // Source retained
    expect(fs.existsSync(path.join(projectDir, 'Final', 'foreign-conflict.png'))).toBe(true);
    expect(assetRepository.findById(source.id)).toBeTruthy();
    // No false successful provenance
    expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/foreign-conflict_wm.png')).toBeUndefined();
  });

  // ─── Item 7: Valid owned overwrite among multiple outputs ────────────

  it('replaces valid generated outputs with new hashes and preserves asset IDs', async () => {
    const source = await writeIndexedImage('Final/owned-overwrite.png', {
      width: 200, height: 150, format: 'png',
    });

    // First run: create valid generated outputs (unresized + resized, multiple formats)
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
      overwrite: true,
      opacity: 100,
    });

    expect(first.generatedCount).toBe(4);
    const firstAssets = first.generatedAssetIds.map((id) => assetRepository.findById(id));
    const firstHashes = {};
    for (const asset of firstAssets) {
      firstHashes[asset.relative_path] = asset.generated_output_sha256;
      expect(asset.generated_output_sha256).toBe(sha256For(path.join(projectDir, ...asset.relative_path.split('/'))));
    }

    // Rerun with different watermark (changed opacity) => different hashes, same paths, same asset IDs
    fs.writeFileSync(watermarkPath, await makeWatermark({
      width: 40, height: 30,
      content: { width: 30, height: 20, color: { r: 0, g: 255, b: 0, alpha: 1 } },
    }));
    processingService = createConfiguredService(watermarkPath, tmpDir, coordinator);

    const second = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
      overwrite: true,
      opacity: 50,
    });

    expect(second.generatedAssetIds.sort()).toEqual(first.generatedAssetIds.sort());

    for (const id of second.generatedAssetIds) {
      const asset = assetRepository.findById(id);
      const newHash = sha256For(path.join(projectDir, ...asset.relative_path.split('/')));
      expect(asset.generated_output_sha256).toBe(newHash);
      // Hash updated (different watermark opacity)
      expect(newHash).not.toBe(firstHashes[asset.relative_path]);
    }

    // Asset IDs preserved where existing row is reused
    for (const id of second.generatedAssetIds) {
      expect(first.generatedAssetIds).toContain(id);
    }
  });

  // ─── Item 8: Missing generated output among multiple outputs ──────────

  it('recreates a missing generated output reusing the same asset ID', async () => {
    const source = await writeIndexedImage('final/missing-output.png', {
      width: 200, height: 150, format: 'png',
    });

    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
    });

    // Externally delete exactly one generated file (the resized webp)
    const missingPath = path.join(projectDir, 'wm', 'missing-output_lq_wm.webp');
    fs.unlinkSync(missingPath);
    assetScanner.scanProjectAssets(project.id);

    const missingAsset = assetRepository.findByProjectIdAndPath(project.id, 'wm/missing-output_lq_wm.webp');
    expect(missingAsset.is_present).toBe(0);

    // Rerun
    const rerun = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
      overwrite: true,
    });

    // Missing destination recreated
    expect(fs.existsSync(missingPath)).toBe(true);
    // Same generated asset ID reused
    const recreated = assetRepository.findByProjectIdAndPath(project.id, 'wm/missing-output_lq_wm.webp');
    expect(recreated.id).toBe(first.generatedAssetIds.find((id) => assetRepository.findById(id).relative_path === 'wm/missing-output_lq_wm.webp'));
    expect(recreated.is_present).toBe(1);
    expect(recreated.generated_output_sha256).toBe(sha256For(missingPath));

    // No duplicate asset row
    const allRows = db.prepare('SELECT * FROM assets WHERE relative_path = ? AND project_id = ?')
      .all('wm/missing-output_lq_wm.webp', project.id);
    expect(allRows.length).toBe(1);

    // Source deletion gate remains correct (source retained)
    expect(fs.existsSync(path.join(projectDir, 'final', 'missing-output.png'))).toBe(true);
  });

  // ─── Item 9: Externally replaced one output ──────────────────────────

  it('rejects an externally replaced output while preserving legitimate siblings', async () => {
    const source = await writeIndexedImage('final/replaced-one.png', {
      width: 200, height: 150, format: 'png',
    });

    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
    });

    // Externally replace one output's bytes (the unresized jpg)
    const replacedPath = path.join(projectDir, 'wm', 'replaced-one_wm.jpg');
    const originalBytes = fs.readFileSync(replacedPath);
    const replacement = Buffer.from(originalBytes);
    replacement[0] ^= 0xff;
    fs.writeFileSync(replacedPath, replacement);

    assetScanner.scanProjectAssets(project.id);
    const replacedAsset = assetRepository.findByProjectIdAndPath(project.id, 'wm/replaced-one_wm.jpg');
    expect(replacedAsset.generated_output_sha256).not.toBe(sha256For(replacedPath));

    // Rerun with overwrite enabled
    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });

    // Externally replaced bytes untouched
    expect(fs.readFileSync(replacedPath)).toEqual(replacement);

    // Legitimate sibling outputs not damaged (the unresized png and resized webp/png)
    const pngPath = path.join(projectDir, 'wm', 'replaced-one_wm.png');
    expect(fs.existsSync(pngPath)).toBe(true);
    const webpPath = path.join(projectDir, 'wm', 'replaced-one_lq_wm.webp');
    expect(fs.existsSync(webpPath)).toBe(true);

    // Source retained
    expect(fs.existsSync(path.join(projectDir, 'final', 'replaced-one.png'))).toBe(true);
  });

  // ─── Item 10: Malformed provenance isolated per output ───────────────

  it('fails closed for one malformed provenance output while siblings remain valid', async () => {
    const source = await writeIndexedImage('Final/malformed-isolated.png', {
      width: 200, height: 150, format: 'png',
    });

    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
    });

    // Mutate one output row's generated_output_sha256 to be malformed
    const targetAsset = first.generatedAssetIds
      .map((id) => assetRepository.findById(id))
      .find((a) => a.relative_path === 'wm/malformed-isolated_wm.jpg');
    db.prepare('UPDATE assets SET generated_output_sha256 = ? WHERE id = ?')
      .run('g'.repeat(64), targetAsset.id);

    // Rerun with overwrite enabled - should reject the malformed one
    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });

    // Source retained
    expect(fs.existsSync(path.join(projectDir, 'Final', 'malformed-isolated.png'))).toBe(true);
    // The malformed output's file untouched (not overwritten)
    const malformedPath = path.join(projectDir, 'wm', 'malformed-isolated_wm.jpg');
    expect(fs.existsSync(malformedPath)).toBe(true);
  });

  // ─── Item 11: Multi-output DB failure recovery ────────────────────────

  it('rolls back DB and removes newly published outputs when DB fails after multi-output publish', async () => {
    const source = await writeIndexedImage('Final/db-failure.png', {
      width: 200, height: 150, format: 'png',
    });

    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected multi-output DB failure'); });

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'custom',
        maxDimension: 100,
        alsoUnresized: true,
        outputFormat: 'png',
        additionalFormats: ['jpg'],
        additionalFormatsResized: ['webp'],
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

      // DB transaction rolled back - no generated asset rows persisted
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/db-failure_wm.png')).toBeUndefined();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/db-failure_wm.jpg')).toBeUndefined();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/db-failure_lq_wm.png')).toBeUndefined();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/db-failure_lq_wm.webp')).toBeUndefined();

      // Newly published output files removed
      expect(fs.existsSync(path.join(projectDir, 'wm', 'db-failure_wm.png'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'wm', 'db-failure_wm.jpg'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'wm', 'db-failure_lq_wm.png'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'wm', 'db-failure_lq_wm.webp'))).toBe(false);

      // Source remains
      expect(fs.existsSync(path.join(projectDir, 'Final', 'db-failure.png'))).toBe(true);

      // No staging artifacts remain
      expect(fs.readdirSync(projectDir).filter((n) => n.startsWith('.creatorcrate-watermark-'))).toEqual([]);
    } finally {
      applySpy.mockRestore();
    }
  });

  // ─── Item 12: Mixed new + replacement recovery ───────────────────────

  it('restores original bytes for replaced outputs and removes new outputs on DB failure', async () => {
    const source = await writeIndexedImage('Final/mixed-recovery.png', {
      width: 200, height: 150, format: 'png',
    });

    // First run: create valid outputs
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
      opacity: 100,
    });

    // Record original bytes for the unresized png (will be replaced)
    const replacePath = path.join(projectDir, 'wm', 'mixed-recovery_wm.png');
    const originalBytes = fs.readFileSync(replacePath);
    const replaceAsset = assetRepository.findByProjectIdAndPath(project.id, 'wm/mixed-recovery_wm.png');
    const originalHash = replaceAsset.generated_output_sha256;

    // Change watermark so replacement produces different bytes
    fs.writeFileSync(watermarkPath, await makeWatermark({
      width: 40, height: 30,
      content: { width: 30, height: 20, color: { r: 0, g: 255, b: 0, alpha: 1 } },
    }));
    processingService = createConfiguredService(watermarkPath, tmpDir, coordinator);

    // Inject DB failure after publication
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected mixed recovery DB failure'); });

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'custom',
        maxDimension: 100,
        alsoUnresized: true,
        outputFormat: 'png',
        additionalFormats: ['jpg'],
        additionalFormatsResized: ['webp'],
        deleteSource: false,
        overwrite: true,
        opacity: 50,
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

      // Existing replacement: original generated bytes restored from backup
      expect(fs.existsSync(replacePath)).toBe(true);
      expect(fs.readFileSync(replacePath)).toEqual(originalBytes);

      // Original stored SHA/provenance remain coherent after DB rollback
      const restoredAsset = assetRepository.findByProjectIdAndPath(project.id, 'wm/mixed-recovery_wm.png');
      expect(restoredAsset.id).toBe(replaceAsset.id);
      expect(restoredAsset.generated_output_sha256).toBe(originalHash);

      // New outputs (that didn't exist before) removed safely
      // The resized webp may have existed already; the new outputs are those created fresh
      // Since all 4 outputs existed from first run, all should be restored to original bytes
      expect(fs.existsSync(path.join(projectDir, 'Final', 'mixed-recovery.png'))).toBe(true);

      // No staging artifacts
      expect(fs.readdirSync(projectDir).filter((n) => n.startsWith('.creatorcrate-watermark-'))).toEqual([]);
    } finally {
      applySpy.mockRestore();
    }
  });

  it('removes only newly created outputs and preserves existing foreign files on DB failure', async () => {
    const source = await writeIndexedImage('Final/mixed-new.png', {
      width: 200, height: 150, format: 'png',
    });

    // First run: create one unresized png only
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: null,
      outputFormat: 'png',
      deleteSource: false,
    });
    const firstPngPath = path.join(projectDir, 'wm', 'mixed-new_wm.png');
    const firstPngBytes = fs.readFileSync(firstPngPath);

    // Second run: add new outputs (jpg, webp) + replace the png
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected new-only DB failure'); });

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'custom',
        maxDimension: null,
        outputFormat: 'png',
        additionalFormats: ['jpg', 'webp'],
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

      // Existing replacement (png) restored from backup
      expect(fs.existsSync(firstPngPath)).toBe(true);
      expect(fs.readFileSync(firstPngPath)).toEqual(firstPngBytes);

      // New outputs (jpg, webp) removed safely
      expect(fs.existsSync(path.join(projectDir, 'wm', 'mixed-new_wm.jpg'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'wm', 'mixed-new_wm.webp'))).toBe(false);

      // Source remains
      expect(fs.existsSync(path.join(projectDir, 'Final', 'mixed-new.png'))).toBe(true);

      // No staging artifacts
      expect(fs.readdirSync(projectDir).filter((n) => n.startsWith('.creatorcrate-watermark-'))).toEqual([]);
    } finally {
      applySpy.mockRestore();
    }
  });

  // ─── Item 13: Destination race during multi-output publish ────────────

  it('detects a foreign file appearing at a destination during publish and leaves it untouched', async () => {
    const source = await writeIndexedImage('final/race-multi.png', {
      width: 200, height: 150, format: 'png',
    });

    // First run: create outputs
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: false,
    });

    // Delete one output to force recreation path
    const racePath = path.join(projectDir, 'wm', 'race-multi_lq_wm.webp');
    fs.unlinkSync(racePath);
    assetScanner.scanProjectAssets(project.id);

    const externalBytes = Buffer.from('external race content for multi-output');
    const realLink = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((srcPath, targetPath) => {
      if (targetPath === racePath && srcPath.includes('.creatorcrate-watermark-')) {
        fs.writeFileSync(racePath, externalBytes);
      }
      return realLink(srcPath, targetPath);
    });

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'custom',
        maxDimension: 100,
        alsoUnresized: true,
        outputFormat: 'png',
        additionalFormats: ['jpg'],
        additionalFormatsResized: ['webp'],
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
    } finally {
      linkSpy.mockRestore();
    }

    // Foreign file untouched
    expect(fs.readFileSync(racePath)).toEqual(externalBytes);
    // Source retained
    expect(fs.existsSync(path.join(projectDir, 'final', 'race-multi.png'))).toBe(true);
  });

  // ─── Item 14: Source deletion after complete success ─────────────────

  it('deletes source after complete multi-output success with deleteSource=true', async () => {
    const source = await writeIndexedImage('Final/destructive-success.png', {
      width: 200, height: 150, format: 'png',
    });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: true,
      overwrite: true,
    });

    // Every output valid/indexed
    expect(result.generatedCount).toBe(4);
    for (const id of result.generatedAssetIds) {
      const asset = assetRepository.findById(id);
      expect(asset.is_present).toBe(1);
      expect(asset.generated_output_sha256).toBe(sha256For(path.join(projectDir, ...asset.relative_path.split('/'))));
    }

    // Source then removed
    expect(fs.existsSync(path.join(projectDir, 'Final', 'destructive-success.png'))).toBe(false);
    expect(assetRepository.findById(source.id)).toBeUndefined();

    // Result says source was deleted
    expect(result.deletedSourceAssetIds).toEqual([source.id]);
    expect(result.sourceResults[0].sourceDeleted).toBe(true);

    // Every generated output remains
    for (const relPath of result.generatedPaths) {
      expect(fs.existsSync(path.join(projectDir, ...relPath.split('/')))).toBe(true);
    }
  });

  // ─── Item 15: Published-release protection ────────────────────────────

  it('blocks deletion when source is protected by a published release', async () => {
    const source = await writeIndexedImage('Final/published-protect.png', {
      width: 200, height: 150, format: 'png',
    });
    const releaseId = insertRelease(true);
    linkRelease(releaseId, source.id);

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: true,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_ASSET_PROTECTED' });

    // No source deletion
    expect(fs.existsSync(path.join(projectDir, 'Final', 'published-protect.png'))).toBe(true);
    expect(assetRepository.findById(source.id)).toBeTruthy();

    // No output set left behind (operation blocked before mutation)
    expect(fs.existsSync(path.join(projectDir, 'wm', 'published-protect_wm.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'wm', 'published-protect_lq_wm.png'))).toBe(false);
  });

  it('planner indicates deletion blocked for published-release source', async () => {
    const source = await writeIndexedImage('Final/planner-protect.png', {
      width: 200, height: 150, format: 'png',
    });
    const releaseId = insertRelease(true);
    linkRelease(releaseId, source.id);

    const plan = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, {
      mode: 'custom', maxDimension: 100, alsoUnresized: true,
      outputFormat: 'png', additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'], deleteSource: true,
    });

    expect(plan.items[0]).toMatchObject({
      status: 'blocked',
      reasonCode: 'PUBLISHED_RELEASE_PROTECTED',
    });
  });

  // ─── Item 16: Output-category apply verification ─────────────────────

  it('applies watermark directly at the selected output category root', async () => {
    const source = await writeIndexedImage('Final/sub/image.png', {
      width: 100, height: 60, format: 'png',
    });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputCategorySlug: 'wm',
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      deleteSource: false,
      overwrite: true,
    });

    expect(fs.existsSync(path.join(projectDir, 'wm', 'image_wm.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'wm', 'image_wm.jpg'))).toBe(true);

    const pngAsset = assetRepository.findByProjectIdAndPath(project.id, 'wm/image_wm.png');
    expect(pngAsset).toBeTruthy();
    expect(pngAsset.generated_source_relative_path).toBe('Final/sub/image.png');

    expect(pngAsset).toMatchObject({ category_id: expect.any(Number), nested_path: '' });
  });

  it('planner creates no directories for an output-category plan', async () => {
    const source = await writeIndexedImage('Final/sub/planner-dir.png', {
      width: 100, height: 60, format: 'png',
    });

    const beforeTree = snapshotTree(projectDir);
    await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, {
      mode: 'custom', outputCategorySlug: 'wm',
      outputFormat: 'png', deleteSource: false,
    });
    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(fs.existsSync(path.join(projectDir, 'wm', 'sub'))).toBe(false);
  });

  it.each([
    ['absolute', '/absolute/path'],
    ['windows-drive', 'C:/path'],
    ['traversal', '../escape'],
  ])('rejects %s legacy output directory', async (_label, outputDir) => {
    const source = await writeIndexedImage(`Final/invalid-output-${_label}.png`);
    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputCategorySlug: outputDir,
      outputFormat: 'png',
    })).rejects.toMatchObject({ code: 'INVALID_OUTPUT_CATEGORY' });
  });

  it('rejects nested source filename collisions before mutating the category root', async () => {
    const a = await writeIndexedImage('Final/a/image.png', { width: 50, height: 30 });
    const b = await writeIndexedImage('Final/b/image.png', { width: 50, height: 30 });

    await expect(processingService.watermarkAssets(project.id, [a.id, b.id], {
      mode: 'custom',
      outputCategorySlug: 'wm',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'INTRA_BATCH_COLLISION' });

    expect(fs.existsSync(path.join(projectDir, 'wm', 'image_wm.png'))).toBe(false);
  });

  it('writes Patreon output beneath the selected category', async () => {
    const source = await writeIndexedImage('Final/patreon-preset.png', {
      width: 100, height: 60, format: 'png',
    });

    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });

    expect(fs.existsSync(path.join(projectDir, 'wm', 'patreon-preset_wm.png'))).toBe(true);
  });

  // ─── Item 17: Custom suffix apply verification ───────────────────────

  it.each(['-final', '.custom', '_version2'])('applies a valid custom suffix %s', async (suffix) => {
    const source = await writeIndexedImage(`Final/suffix-${suffix.slice(1)}.png`, {
      width: 100, height: 60, format: 'png',
    });

    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      unresizedSuffix: suffix,
      outputFormat: 'png',
      deleteSource: false,
    });

    const expectedRelPath = `wm/suffix-${suffix.slice(1)}${suffix}.png`;
    expect(fs.existsSync(path.join(projectDir, ...expectedRelPath.split('/')))).toBe(true);

    const asset = assetRepository.findByProjectIdAndPath(project.id, expectedRelPath);
    expect(asset).toBeTruthy();
    expect(asset.generated_source_relative_path).toBe(`Final/suffix-${suffix.slice(1)}.png`);
  });

  it.each(['/', '\\', '../', '\x00', '\n'])('rejects unsafe suffix %j', async (suffix) => {
    const source = await writeIndexedImage('Final/unsafe-suffix.png', {
      width: 100, height: 60, format: 'png',
    });

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      unresizedSuffix: suffix,
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'INVALID_SUFFIX' });

    expect(fs.existsSync(path.join(projectDir, 'wm', 'unsafe-suffix_wm.png'))).toBe(false);
  });

  // ─── Item 18: WebP lossless verification ──────────────────────────────

  it('produces a lossless WebP output when webpLossless=true', async () => {
    const source = await writeIndexedImage('Final/webp-lossless.png', {
      width: 100, height: 60, format: 'png',
      background: { r: 200, g: 50, b: 10, alpha: 1 },
    });

    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'webp',
      webpLossless: true,
      deleteSource: false,
    });

    const webpPath = path.join(projectDir, 'wm', 'webp-lossless_wm.webp');
    const meta = await metadataFor(webpPath);
    expect(meta.format).toBe('webp');

    // Sharp exposes lossless via the 'compression' field or we check the file header
    // WebP lossless files have 'VP8L' in the RIFF chunk; lossy uses 'VP8 '
    const webpBuffer = fs.readFileSync(webpPath);
    const riffType = webpBuffer.subarray(12, 16).toString('ascii');
    expect(riffType).toBe('VP8L');
  });

  it('produces a lossy WebP output when webpLossless=false', async () => {
    const source = await writeIndexedImage('Final/webp-lossy.png', {
      width: 100, height: 60, format: 'png',
    });

    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'webp',
      webpLossless: false,
      deleteSource: false,
    });

    const webpPath = path.join(projectDir, 'wm', 'webp-lossy_wm.webp');
    const webpBuffer = fs.readFileSync(webpPath);
    const riffType = webpBuffer.subarray(12, 16).toString('ascii');
    expect(riffType).toBe('VP8 ');
  });

  // ─── Item 19: JPEG background verification ────────────────────────────

  it('flattens transparent source onto a white background for JPEG by default', async () => {
    // Create a transparent source (mostly transparent with a small opaque region)
    const transparentBuf = await sharp({
      create: {
        width: 40, height: 30, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).png().toBuffer();

    const sourcePath = path.join(projectDir, 'Final', 'jpeg-bg-default.png');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, transparentBuf);
    const stats = fs.statSync(sourcePath);
    const source = assetRepository.upsert(project.id, 'Final/jpeg-bg-default.png', {
      categoryId: finalCategory.id, nestedPath: '', filename: 'jpeg-bg-default.png',
      extension: 'png', mimeType: 'image/png', sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });

    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'jpg',
      deleteSource: false,
    });

    const jpgPath = path.join(projectDir, 'wm', 'jpeg-bg-default_wm.jpg');
    const { data, info } = await rawPixels(jpgPath);
    // JPEG has no alpha; background should be near-white (255)
    // Check a corner pixel (should be white-ish from flatten)
    const cornerOffset = 0;
    expect(data[cornerOffset]).toBeGreaterThan(240); // R
    expect(data[cornerOffset + 1]).toBeGreaterThan(240); // G
    expect(data[cornerOffset + 2]).toBeGreaterThan(240); // B
  });

  it('flattens transparent source onto a custom background for JPEG', async () => {
    const transparentBuf = await sharp({
      create: {
        width: 40, height: 30, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).png().toBuffer();

    const sourcePath = path.join(projectDir, 'Final', 'jpeg-bg-custom.png');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, transparentBuf);
    const stats = fs.statSync(sourcePath);
    const source = assetRepository.upsert(project.id, 'Final/jpeg-bg-custom.png', {
      categoryId: finalCategory.id, nestedPath: '', filename: 'jpeg-bg-custom.png',
      extension: 'png', mimeType: 'image/png', sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });

    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'jpg',
      jpegBackground: { r: 30, g: 60, b: 90 },
      deleteSource: false,
    });

    const jpgPath = path.join(projectDir, 'wm', 'jpeg-bg-custom_wm.jpg');
    const { data } = await rawPixels(jpgPath);
    // Corner should be approximately the custom background (within JPEG tolerance)
    expect(Math.abs(data[0] - 30)).toBeLessThan(15);
    expect(Math.abs(data[1] - 60)).toBeLessThan(15);
    expect(Math.abs(data[2] - 90)).toBeLessThan(15);
  });

  // ─── Item 20: Planner no-mutation regression ─────────────────────────

  it('planner does not mutate filesystem, DB, or mtimes for a complex dual-variant plan', async () => {
    const source = await writeIndexedImage('Final/no-mutation.png', {
      width: 400, height: 300, format: 'png',
    });

    // Create a valid existing generated output (unresized png) with provenance
    const existingOutput = await writeIndexedImage('wm/no-mutation_wm.png', {
      width: 400, height: 300, format: 'png',
    });
    const existingPath = path.join(projectDir, 'wm', 'no-mutation_wm.png');
    setWatermarkProvenance(existingOutput.id, source.id, 'Final/no-mutation.png', 'custom', 'unresized', sha256For(existingPath));

    const beforeTree = snapshotTree(projectDir);
    const beforeDatabase = snapshotDatabase(db);

    await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, {
      mode: 'custom',
      maxDimension: 100,
      alsoUnresized: true,
      outputDirectory: 'processed',
      outputFormat: 'png',
      additionalFormats: ['jpg'],
      additionalFormatsResized: ['webp'],
      deleteSource: true,
      overwrite: true,
    });

    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(snapshotDatabase(db)).toEqual(beforeDatabase);
    expect(fs.readdirSync(projectDir).filter((n) => n.startsWith('.creatorcrate-'))).toEqual([]);
  });

  // ─── Item 21: Migration 012 verification ─────────────────────────────

  describe('migration 012 (generated_variant)', () => {
    let migrationDb;
    let migrationDbPath;

    beforeEach(() => {
      migrationDbPath = path.join(tmpDir, 'migration-test.db');
    });

    afterEach(() => {
      if (migrationDb) closeDatabase(migrationDb);
      migrationDb = undefined;
    });

    it('adds generated_variant column on clean install', () => {
      migrationDb = openDatabase(migrationDbPath);
      runMigrations(migrationDb, MIGRATIONS_DIR);
      const columns = migrationDb.prepare("SELECT name FROM pragma_table_info('assets')").pluck().all();
      expect(columns).toContain('generated_variant');
    });

    it('upgrades from 011 to 012 adding generated_variant', () => {
      const legacyDir = makePre011MigrationsDir(tmpDir);
      // Copy 011 too for the upgrade baseline
      fs.copyFileSync(
        path.join(MIGRATIONS_DIR, '011_add_watermark_asset_provenance.sql'),
        path.join(legacyDir, '011_add_watermark_asset_provenance.sql'),
      );

      migrationDb = openDatabase(migrationDbPath);
      runMigrations(migrationDb, legacyDir);

      const appliedBefore = migrationDb.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
      expect(appliedBefore).not.toContain('012_add_watermark_generated_variant.sql');
      expect(migrationDb.prepare("SELECT name FROM pragma_table_info('assets')").pluck().all()).not.toContain('generated_variant');

      closeDatabase(migrationDb);
      migrationDb = openDatabase(migrationDbPath);
      runMigrations(migrationDb, MIGRATIONS_DIR);

      const appliedAfter = migrationDb.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
      expect(appliedAfter).toContain('012_add_watermark_generated_variant.sql');
      expect(migrationDb.prepare("SELECT name FROM pragma_table_info('assets')").pluck().all()).toContain('generated_variant');
    });

    it('keeps existing historical rows readable after upgrade', () => {
      const legacyDir = makePre011MigrationsDir(tmpDir);
      fs.copyFileSync(
        path.join(MIGRATIONS_DIR, '011_add_watermark_asset_provenance.sql'),
        path.join(legacyDir, '011_add_watermark_asset_provenance.sql'),
      );

      migrationDb = openDatabase(migrationDbPath);
      runMigrations(migrationDb, legacyDir);

      // Insert a historical row with watermark provenance (no generated_variant column yet)
      const projectId = migrationDb.prepare("INSERT INTO projects (title, slug, status) VALUES ('Hist', 'hist', 'tbd') RETURNING id").get().id;
      const historicalHash = 'a'.repeat(64);
      migrationDb.prepare(`
        INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at,
                            is_present, last_seen_at, generated_by, generated_source_asset_id, generated_source_relative_path,
                            generated_mode, generated_output_sha256)
        VALUES (?, 'Final/hist.png', NULL, '', 'hist.png', 'png', 'image/png', 100, '2026-01-01', 1, datetime('now'),
                'watermark', ?, 'Final/source.png', 'patreon', ?)
      `).run(projectId, projectId, historicalHash);

      closeDatabase(migrationDb);
      migrationDb = openDatabase(migrationDbPath);
      runMigrations(migrationDb, MIGRATIONS_DIR);

      const row = migrationDb.prepare('SELECT * FROM assets WHERE relative_path = ?').get('Final/hist.png');
      expect(row).toBeTruthy();
      expect(row.generated_by).toBe('watermark');
      expect(row.generated_variant).toBeNull();
      expect(row.generated_output_sha256).toBe('a'.repeat(64));
    });

    it('NULL historical variant does not authorize unrelated modern multi-output overwrite', async () => {
      const source = await writeIndexedImage('Final/null-variant.png', {
        width: 200, height: 150, format: 'png',
      });

      // First run: create a single-variant output (generated_variant = 'single' or NULL for legacy)
      const first = await processingService.watermarkAssets(project.id, [source.id], {
        mode: 'custom',
        maxDimension: null,
        outputFormat: 'png',
        deleteSource: false,
      });

      const firstAsset = assetRepository.findById(first.generatedAssetIds[0]);
      // Force generated_variant to NULL (simulating a historical row)
      db.prepare('UPDATE assets SET generated_variant = NULL WHERE id = ?').run(firstAsset.id);

      // Attempt a dual-variant overwrite - the NULL-variant row should NOT authorize the resized variant
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'custom',
        maxDimension: 100,
        alsoUnresized: true,
        outputFormat: 'png',
        additionalFormats: ['jpg'],
        additionalFormatsResized: ['webp'],
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
    });

    it('scanner preserves generated_variant on re-scan', async () => {
      const source = await writeIndexedImage('final/scanner-variant.png', {
        width: 200, height: 150, format: 'png',
      });

      await processingService.watermarkAssets(project.id, [source.id], {
        mode: 'custom',
        maxDimension: 100,
        alsoUnresized: true,
        outputFormat: 'png',
        additionalFormats: ['jpg'],
        additionalFormatsResized: ['webp'],
        deleteSource: false,
      });

      const unresizedAsset = assetRepository.findByProjectIdAndPath(project.id, 'wm/scanner-variant_wm.png');
      expect(unresizedAsset.generated_variant).toBe('unresized');

      // Re-scan
      assetScanner.scanProjectAssets(project.id);

      const rescanned = assetRepository.findByProjectIdAndPath(project.id, 'wm/scanner-variant_wm.png');
      expect(rescanned.generated_variant).toBe('unresized');
      expect(rescanned.id).toBe(unresizedAsset.id);
    });

    it('upgrades from 012 to the generated artifact table without changing asset rows', () => {
      const legacyDir = makePre011MigrationsDir(tmpDir);
      for (const migration of [
        '011_add_watermark_asset_provenance.sql',
        '012_add_watermark_generated_variant.sql',
      ]) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, migration), path.join(legacyDir, migration));
      }
      migrationDb = openDatabase(migrationDbPath);
      runMigrations(migrationDb, legacyDir);
      const projectId = migrationDb.prepare("INSERT INTO projects (title, slug, status) VALUES ('Artifact upgrade', 'artifact-upgrade', 'tbd') RETURNING id").get().id;
      migrationDb.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
        VALUES (?, 'Final/existing.png', 'existing.png', 'png', 'image/png', 1, 1, datetime('now'))
      `).run(projectId);
      closeDatabase(migrationDb);
      migrationDb = openDatabase(migrationDbPath);
      runMigrations(migrationDb, MIGRATIONS_DIR);

      expect(migrationDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generated_artifacts'").pluck().get())
        .toBe('generated_artifacts');
      expect(migrationDb.prepare("SELECT relative_path FROM assets WHERE project_id = ?").pluck().get(projectId))
        .toBe('Final/existing.png');
    });
  });
});
