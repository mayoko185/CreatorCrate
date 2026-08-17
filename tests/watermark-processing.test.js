import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createGeneratedArtifactRepository } from '../src/data/generated-artifact-repository.js';
import { createWatermarkRepository } from '../src/data/watermark-repository.js';
import { createWatermarkScaleMapRepository } from '../src/data/watermark-scale-map-repository.js';
import { createWatermarkService } from '../src/services/watermark-service.js';
import { createWatermarkScaleMapService } from '../src/services/watermark-scale-map-service.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import {
  AssetProcessingError,
  createAssetProcessingService,
} from '../src/services/asset-processing-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { read7zArchiveEntries } from '../src/services/watermark-7z.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title = 'Watermark Project') {
  return {
    title,
    description: '',
    notes: '',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  };
}

async function makeImage({ width = 100, height = 60, format = 'png', orientation } = {}) {
  let image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 100, b: 180, alpha: 1 },
    },
  });
  if (orientation) image = image.withMetadata({ orientation });
  return image[format]({ quality: format === 'jpeg' || format === 'webp' ? 90 : undefined }).toBuffer();
}

async function makeWatermark() {
  const visible = await sharp({
    create: {
      width: 10,
      height: 5,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).png().toBuffer();
  return sharp({
    create: {
      width: 20,
      height: 15,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: visible, left: 5, top: 5 }]).png().toBuffer();
}

async function metadataFor(filePath) {
  return sharp(fs.readFileSync(filePath)).metadata();
}

async function readZipEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = [];
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

function sha256For(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function symlinksSupported() {
  let probeDir;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-watermark-symlink-'));
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

describe('watermark asset processing', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let projectRepository;
  let assetRepository;
  let generatedArtifactRepository;
  let assetCategoryService;
  let projectService;
  let project;
  let projectDir;
  let finalCategory;
  let watermarkPath;
  let watermarkRepository;
  let watermarkService;
  let processingService;
  let coordinator;
  let assetScanner;

  function createConfiguredService(
    configuredWatermarkPath,
    configuredWatermarkRoot,
    operationCoordinator = createProjectOperationCoordinator(),
  ) {
    return createAssetProcessingService({
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: operationCoordinator,
      watermarkPath: configuredWatermarkPath,
      watermarkRoot: configuredWatermarkRoot,
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-watermark-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    generatedArtifactRepository = createGeneratedArtifactRepository(db);
    const categoryRepository = createAssetCategoryRepository(db);
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
    watermarkRepository = createWatermarkRepository(db);
    watermarkService = createWatermarkService({
      repository: watermarkRepository,
      storageRoot: path.join(tmpDir, 'managed-watermarks'),
    });
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
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeIndexedImage(relativePath, {
    width = 100,
    height = 60,
    format = 'png',
    nestedPath = '',
    orientation,
  } = {}) {
    const normalized = relativePath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalized);
    const target = path.join(projectDir, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await makeImage({ width, height, format, orientation }));
    const stats = fs.statSync(target);
    return assetRepository.upsert(project.id, normalized, {
      categoryId: normalized.toLowerCase().startsWith('final/') ? finalCategory.id : null,
      nestedPath,
      filename,
      extension: filename.slice(filename.lastIndexOf('.') + 1).toLowerCase(),
      mimeType: format === 'jpg' ? 'image/jpeg' : `image/${format}`,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  async function expectInvalidTrustedWatermark(configuredPath, configuredRoot, sourceName) {
    const source = await writeIndexedImage(`Final/${sourceName}.png`);
    const service = createConfiguredService(configuredPath, configuredRoot);

    await expect(service.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({
      name: 'AssetProcessingError',
      code: 'WATERMARK_FILE_INVALID',
    });
    expect(fs.existsSync(path.join(projectDir, 'Final', `${sourceName}.png`))).toBe(true);
    expect(assetRepository.findByProjectIdAndPath(
      project.id,
      `Final/wm/${sourceName}_wm.png`,
    )).toBeUndefined();
  }

  function insertRelease(published) {
    return db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date,
                            published_date, patreon_url, archived_at)
      VALUES (?, 'Watermark Release', '', '', NULL, ?, NULL, NULL)
      RETURNING id
    `).get(project.id, published ? '2026-01-01' : null).id;
  }

  function linkRelease(releaseId, assetId) {
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, assetId, 'attachment', 0);
  }

  it('creates a Patreon-style nested wm output and preserves the source', async () => {
    const source = await writeIndexedImage('Final/patreon.png', { width: 1000, height: 600 });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      opacity: 100,
      margin: 0.02,
    });

    const output = assetRepository.findByProjectIdAndPath(project.id, 'Final/wm/patreon_wm.png');
    expect(result).toMatchObject({
      status: 'completed',
      operation: 'watermarkAssets',
      mode: 'patreon',
      generatedCount: 1,
      generatedAssetIds: [output.id],
      deletedSourceAssetIds: [],
    });
    expect(output).toMatchObject({
      project_id: project.id,
      category_id: finalCategory.id,
      nested_path: 'wm',
      generated_by: 'watermark',
      generated_source_asset_id: source.id,
      generated_source_relative_path: 'Final/patreon.png',
      generated_mode: 'patreon',
      generated_output_sha256: sha256For(path.join(projectDir, 'Final', 'wm', 'patreon_wm.png')),
      is_present: 1,
    });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'patreon.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'wm', 'patreon_wm.png'))).toBe(true);
    expect((await metadataFor(path.join(projectDir, 'Final', 'wm', 'patreon_wm.png'))).format).toBe('png');
  });

  it('selects a managed Watermark by ID and rejects output ownership from another ID', async () => {
    const managedA = await watermarkService.createWatermark({
      displayName: 'Managed A',
      pngBytes: await makeWatermark(),
    });
    const managedB = await watermarkService.createWatermark({
      displayName: 'Managed B',
      pngBytes: await makeWatermark(),
    });
    const managedService = createAssetProcessingService({
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      watermarkService,
    });
    const source = await writeIndexedImage('Final/managed.png');

    await managedService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      watermarkId: managedA.id,
    });
    const output = assetRepository.findByProjectIdAndPath(project.id, 'Final/wm/managed_wm.png');
    expect(output.generated_watermark_id).toBe(managedA.id);

    await expect(managedService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      watermarkId: managedB.id,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
  });

  it('resolves a managed scale map by ID before mutation and rejects a missing requested map', async () => {
    const scaleMapService = createWatermarkScaleMapService({
      repository: createWatermarkScaleMapRepository(db),
    });
    const scaleMap = scaleMapService.createScaleMap({
      displayName: 'Processing map',
      definition: { '100x60': 0.35, default: 0.1 },
    });
    const managedService = createAssetProcessingService({
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      watermarkPath,
      watermarkRoot: tmpDir,
      scaleMapService,
    });
    const source = await writeIndexedImage('Final/managed-scale.png', { width: 100, height: 60 });

    await expect(managedService.watermarkAssets(project.id, [source.id], {
      mode: 'custom', outputFormat: 'png', deleteSource: false, scaleMapId: scaleMap.id,
    })).resolves.toMatchObject({ status: 'completed', generatedCount: 1 });
    await expect(managedService.watermarkAssets(project.id, [source.id], {
      mode: 'custom', outputFormat: 'png', deleteSource: false, scaleMapId: 999,
    })).rejects.toMatchObject({ code: 'SCALE_MAP_NOT_FOUND' });
  });

  it('creates paired ZIP archives and a CBZ from logical variants', async () => {
    const source = await writeIndexedImage('Final/sub/archive.png', { width: 240, height: 120 });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      deleteSource: false,
      makeArchives: true,
      makeCbz: true,
      setName: 'Patreon August',
      zipJpgQuality: 80,
      zipWebpQuality: 90,
      cbzJpgQuality: 85,
    });

    expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      'Patreon August_jpg_q80.zip',
      'Patreon August_webp_q90.zip',
      'Patreon August_jpg_q85.cbz',
    ]);
    const jpgEntries = await readZipEntries(path.join(projectDir, 'Patreon August_jpg_q80.zip'));
    const webpEntries = await readZipEntries(path.join(projectDir, 'Patreon August_webp_q90.zip'));
    const cbzEntries = await readZipEntries(path.join(projectDir, 'Patreon August_jpg_q85.cbz'));
    expect(jpgEntries.map((entry) => entry.name)).toEqual(['Final/sub/archive_wm.jpg']);
    expect(webpEntries.map((entry) => entry.name)).toEqual(['Final/sub/archive_wm.webp']);
    expect(cbzEntries.map((entry) => entry.name)).toEqual(['Final/sub/archive_wm.jpg']);
    expect((await sharp(jpgEntries[0].data).metadata()).format).toBe('jpeg');
    expect((await sharp(webpEntries[0].data).metadata()).format).toBe('webp');
    expect((await sharp(cbzEntries[0].data).metadata()).format).toBe('jpeg');
    expect(generatedArtifactRepository.listByProjectId(project.id)).toHaveLength(3);
  });


  it('creates genuine 7z archives with ZIP-parity entries and protects option-like names', async () => {
    const source = await writeIndexedImage('Final/sub/-archive.png', { width: 240, height: 120 });
    const sharedOptions = {
      mode: 'custom',
      outputFormat: 'png',
      deleteSource: false,
      makeArchives: true,
      zipJpgQuality: 73,
      zipWebpQuality: 84,
    };

    const zipResult = await processingService.watermarkAssets(project.id, [source.id], {
      ...sharedOptions,
      archiveFormat: 'zip',
      setName: 'ZIP parity',
    });
    const sevenResult = await processingService.watermarkAssets(project.id, [source.id], {
      ...sharedOptions,
      archiveFormat: '7z',
      setName: '7z parity',
    });

    expect(sevenResult.artifacts.map((artifact) => ({
      relativePath: artifact.relativePath,
      format: artifact.format,
    }))).toEqual([
      { relativePath: '7z parity_jpg_q73.7z', format: '7z' },
      { relativePath: '7z parity_webp_q84.7z', format: '7z' },
    ]);

    const zipJpgEntries = await readZipEntries(path.join(projectDir, 'ZIP parity_jpg_q73.zip'));
    const zipWebpEntries = await readZipEntries(path.join(projectDir, 'ZIP parity_webp_q84.zip'));
    const sevenJpgPath = path.join(projectDir, '7z parity_jpg_q73.7z');
    const sevenWebpPath = path.join(projectDir, '7z parity_webp_q84.7z');
    const sevenJpgBytes = fs.readFileSync(sevenJpgPath);
    const sevenWebpBytes = fs.readFileSync(sevenWebpPath);
    expect(sevenJpgBytes.subarray(0, 6)).toEqual(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
    expect(sevenWebpBytes.subarray(0, 6)).toEqual(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));

    const sevenJpgEntries = await read7zArchiveEntries(sevenJpgBytes);
    const sevenWebpEntries = await read7zArchiveEntries(sevenWebpBytes);
    expect(sevenJpgEntries.map((entry) => entry.name)).toEqual(zipJpgEntries.map((entry) => entry.name));
    expect(sevenWebpEntries.map((entry) => entry.name)).toEqual(zipWebpEntries.map((entry) => entry.name));
    expect(sevenJpgEntries.map((entry) => entry.name)).toEqual(['Final/sub/-archive_wm.jpg']);
    expect(sevenWebpEntries.map((entry) => entry.name)).toEqual(['Final/sub/-archive_wm.webp']);
    expect((await sharp(sevenJpgEntries[0].buffer).metadata()).format).toBe('jpeg');
    expect((await sharp(sevenWebpEntries[0].buffer).metadata()).format).toBe('webp');

    const artifacts = generatedArtifactRepository.listByProjectId(project.id);
    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relative_path: '7z parity_jpg_q73.7z',
        kind: 'watermark-archive-jpg',
        sha256: sha256For(sevenJpgPath),
      }),
      expect.objectContaining({
        relative_path: '7z parity_webp_q84.7z',
        kind: 'watermark-archive-webp',
        sha256: sha256For(sevenWebpPath),
      }),
    ]));
  });

  it('excludes resized archive variants by default and rejects resized-only ZIP archives', async () => {
    const dual = await writeIndexedImage('Final/dual.png', { width: 240, height: 120 });
    await processingService.watermarkAssets(project.id, [dual.id], {
      mode: 'custom', outputFormat: 'png', deleteSource: false,
      maxDimension: 100, alsoUnresized: true, makeArchives: true,
    });
    const entries = await readZipEntries(path.join(projectDir, 'watermarked_jpg_q80.zip'));
    expect(entries.map((entry) => entry.name)).toEqual(['Final/dual_wm.jpg']);

    const resized = await writeIndexedImage('Final/resized.png', { width: 240, height: 120 });
    await expect(processingService.watermarkAssets(project.id, [resized.id], {
      mode: 'custom', outputFormat: 'png', deleteSource: true,
      maxDimension: 100, makeArchives: true,
    })).rejects.toMatchObject({ code: 'RESIZED_ONLY_ARCHIVE_BLOCKED' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'resized.png'))).toBe(true);
  });

  it('removes published archives with image outputs when artifact persistence fails', async () => {
    const source = await writeIndexedImage('Final/archive-db-failure.png');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected artifact database failure'); });

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom', outputFormat: 'png', deleteSource: true, makeArchives: true,
    })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

    applySpy.mockRestore();
    expect(fs.existsSync(path.join(projectDir, 'watermarked_jpg_q80.zip'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'watermarked_webp_q90.zip'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'archive-db-failure.png'))).toBe(true);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
  });

  it.each([true, false])('recreates a missing Patreon output with overwrite=%s', async (overwrite) => {
    const source = await writeIndexedImage('final/image.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const outputPath = path.join(projectDir, 'final', 'wm', 'image_wm.png');
    const priorOutput = assetRepository.findById(first.generatedAssetIds[0]);

    fs.unlinkSync(outputPath);
    assetScanner.scanProjectAssets(project.id);
    const missingOutput = assetRepository.findByProjectIdAndPath(
      project.id,
      'final/wm/image_wm.png',
    );
    expect(missingOutput).toMatchObject({
      id: priorOutput.id,
      is_present: 0,
      generated_by: 'watermark',
      generated_source_asset_id: source.id,
      generated_source_relative_path: 'final/image.png',
      generated_mode: 'patreon',
      generated_output_sha256: priorOutput.generated_output_sha256,
    });

    const rerun = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
      overwrite,
    });
    const recreated = assetRepository.findByProjectIdAndPath(
      project.id,
      'final/wm/image_wm.png',
    );

    expect(rerun.generatedAssetIds).toEqual([priorOutput.id]);
    expect(recreated).toMatchObject({
      id: priorOutput.id,
      is_present: 1,
      generated_source_asset_id: source.id,
      generated_source_relative_path: 'final/image.png',
      generated_mode: 'patreon',
      generated_output_sha256: sha256For(outputPath),
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(assetRepository.findById(source.id)).toMatchObject({ is_present: 1 });
  });

  it('accepts an uppercase valid historical hash when recreating a missing Patreon output', async () => {
    const source = await writeIndexedImage('final/uppercase-hash.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const outputPath = path.join(projectDir, 'final', 'wm', 'uppercase-hash_wm.png');
    const priorOutput = assetRepository.findById(first.generatedAssetIds[0]);
    const uppercaseHash = priorOutput.generated_output_sha256.toUpperCase();

    db.prepare('UPDATE assets SET generated_output_sha256 = ? WHERE id = ?')
      .run(uppercaseHash, priorOutput.id);
    fs.unlinkSync(outputPath);
    assetScanner.scanProjectAssets(project.id);

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
      overwrite: true,
    })).resolves.toMatchObject({ generatedAssetIds: [priorOutput.id] });

    const recreated = assetRepository.findById(priorOutput.id);
    expect(recreated).toMatchObject({
      id: priorOutput.id,
      is_present: 1,
      generated_output_sha256: sha256For(outputPath),
    });
  });

  it('accepts an uppercase valid historical hash when replacing an existing Patreon output', async () => {
    const source = await writeIndexedImage('final/uppercase-existing-hash.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const destinationPath = path.join(projectDir, 'final', 'wm', 'uppercase-existing-hash_wm.png');
    const priorOutput = assetRepository.findById(first.generatedAssetIds[0]);
    const uppercaseHash = priorOutput.generated_output_sha256.toUpperCase();

    db.prepare('UPDATE assets SET generated_output_sha256 = ? WHERE id = ?')
      .run(uppercaseHash, priorOutput.id);

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
      overwrite: true,
    })).resolves.toMatchObject({ generatedAssetIds: [priorOutput.id] });

    expect(assetRepository.findById(priorOutput.id)).toMatchObject({
      id: priorOutput.id,
      is_present: 1,
      generated_output_sha256: sha256For(destinationPath),
    });
  });

  it.each([
    ['NULL', null],
    ['empty', ''],
    ['truncated', 'a'.repeat(63)],
    ['oversized', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['trailing-newline', `${'a'.repeat(64)}\n`],
  ])('rejects a missing output with a %s stored hash', async (label, storedHash) => {
    const source = await writeIndexedImage(`final/malformed-hash-${label.toLowerCase()}.png`);
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const outputPath = path.join(
      projectDir,
      'final',
      'wm',
      `malformed-hash-${label.toLowerCase()}_wm.png`,
    );
    const priorOutput = assetRepository.findById(first.generatedAssetIds[0]);

    db.prepare('UPDATE assets SET generated_output_sha256 = ? WHERE id = ?')
      .run(storedHash, priorOutput.id);
    fs.unlinkSync(outputPath);
    assetScanner.scanProjectAssets(project.id);
    const before = assetRepository.findById(priorOutput.id);

    expect(before).toMatchObject({
      id: priorOutput.id,
      is_present: 0,
      generated_output_sha256: storedHash,
    });
    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });

    expect(fs.existsSync(outputPath)).toBe(false);
    expect(assetRepository.findById(priorOutput.id)).toEqual(before);
  });

  it('uses scanner classification for root, categorized, and nested Patreon outputs', async () => {
    const categorized = await writeIndexedImage('final/classified.png');
    const root = await writeIndexedImage('root-classified.png');
    const nested = await writeIndexedImage('final/sub/nested-classified.png');

    await processingService.watermarkAssets(project.id, [categorized.id, root.id, nested.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    assetScanner.scanProjectAssets(project.id);

    const categories = assetCategoryService.listProjectCategories(project.id);
    const wmCategory = categories.find((category) => category.directory_slug === 'wm');
    expect(assetScanner.repository.findByProjectIdAndPath(project.id, 'final/wm/classified_wm.png'))
      .toMatchObject({ category_id: finalCategory.id, nested_path: 'wm' });
    expect(assetScanner.repository.findByProjectIdAndPath(project.id, 'wm/root-classified_wm.png'))
      .toMatchObject({ category_id: wmCategory.id, nested_path: '' });
    expect(assetScanner.repository.findByProjectIdAndPath(project.id, 'final/sub/wm/nested-classified_wm.png'))
      .toMatchObject({ category_id: finalCategory.id, nested_path: 'sub/wm' });
  });

  it('resizes social output to 1100 without upscaling and deletes the source after success', async () => {
    const source = await writeIndexedImage('Final/social.png', { width: 2200, height: 1100 });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'social',
    });

    const output = assetRepository.findByProjectIdAndPath(project.id, 'Final/social_lq_wm.png');
    const metadata = await metadataFor(path.join(projectDir, 'Final', 'social_lq_wm.png'));
    expect(metadata).toMatchObject({ width: 1100, height: 550, format: 'png' });
    expect(result.deletedSourceAssetIds).toEqual([source.id]);
    expect(assetRepository.findById(source.id)).toBeUndefined();
    expect(output.generated_mode).toBe('social');
    expect(fs.existsSync(path.join(projectDir, 'Final', 'social.png'))).toBe(false);
  });

  it('refreshes a Social output after its source is restored with a new asset ID', async () => {
    const source = await writeIndexedImage('final/restored-social.png', { width: 2200, height: 1100 });
    await processingService.watermarkAssets(project.id, [source.id], { mode: 'social' });
    const outputPath = path.join(projectDir, 'final', 'restored-social_lq_wm.png');
    const priorOutput = assetRepository.findByProjectIdAndPath(
      project.id,
      'final/restored-social_lq_wm.png',
    );

    fs.writeFileSync(path.join(projectDir, 'final', 'restored-social.png'), await makeImage({ width: 1800, height: 900 }));
    assetScanner.scanProjectAssets(project.id);
    const restored = assetRepository.findByProjectIdAndPath(project.id, 'final/restored-social.png');
    expect(restored.id).not.toBe(source.id);

    fs.unlinkSync(outputPath);
    assetScanner.scanProjectAssets(project.id);
    const missingOutput = assetRepository.findByProjectIdAndPath(
      project.id,
      'final/restored-social_lq_wm.png',
    );
    expect(missingOutput).toMatchObject({
      id: priorOutput.id,
      is_present: 0,
      generated_source_asset_id: source.id,
      generated_source_relative_path: 'final/restored-social.png',
      generated_mode: 'social',
      generated_output_sha256: priorOutput.generated_output_sha256,
    });

    await processingService.watermarkAssets(project.id, [restored.id], {
      mode: 'social',
      overwrite: true,
    });

    const refreshed = assetRepository.findByProjectIdAndPath(
      project.id,
      'final/restored-social_lq_wm.png',
    );
    expect(refreshed).toMatchObject({
      id: priorOutput.id,
      generated_by: 'watermark',
      generated_source_asset_id: restored.id,
      generated_source_relative_path: 'final/restored-social.png',
      generated_mode: 'social',
      generated_output_sha256: sha256For(outputPath),
    });
    expect(assetRepository.findById(restored.id)).toBeUndefined();
  });

  it('does not let a source restored at another relative path claim stale Social provenance', async () => {
    const source = await writeIndexedImage('final/path-bound.png');
    await processingService.watermarkAssets(project.id, [source.id], { mode: 'social' });
    const priorOutputPath = path.join(projectDir, 'final', 'path-bound_lq_wm.png');
    const priorOutput = fs.readFileSync(priorOutputPath);

    const otherPath = path.join(projectDir, 'other', 'path-bound.png');
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    fs.writeFileSync(otherPath, await makeImage());
    assetScanner.scanProjectAssets(project.id);
    const otherSource = assetRepository.findByProjectIdAndPath(project.id, 'other/path-bound.png');

    await processingService.watermarkAssets(project.id, [otherSource.id], {
      mode: 'social',
      overwrite: true,
    });

    expect(fs.readFileSync(priorOutputPath)).toEqual(priorOutput);
    expect(fs.existsSync(path.join(projectDir, 'other', 'path-bound_lq_wm.png'))).toBe(true);
  });

  it.each([
    ['png', 'png'],
    ['jpg', 'jpeg'],
    ['webp', 'webp'],
  ])('supports %s source and %s output formats', async (sourceExtension, outputFormat) => {
    const source = await writeIndexedImage(`Final/formats.${sourceExtension}`, {
      format: sourceExtension === 'jpg' ? 'jpeg' : sourceExtension,
    });
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat,
      deleteSource: false,
    });
    const outputPath = path.join(
      projectDir,
      'Final',
      'wm',
      `formats_wm.${outputFormat === 'jpeg' ? 'jpeg' : outputFormat}`,
    );
    expect((await metadataFor(outputPath)).format).toBe(outputFormat);
  });

  it('honors EXIF orientation before calculating final placement dimensions', async () => {
    const source = await writeIndexedImage('Final/oriented.jpg', {
      width: 100,
      height: 60,
      format: 'jpeg',
      orientation: 6,
    });
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'jpeg',
      deleteSource: false,
    });
    const metadata = await metadataFor(path.join(projectDir, 'Final', 'wm', 'oriented_wm.jpeg'));
    expect(metadata).toMatchObject({ width: 60, height: 100, format: 'jpeg' });
  });

  it('skips existing outputs without overwrite and requires provenance for replacement', async () => {
    const source = await writeIndexedImage('final/repeat.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });
    const destination = path.join(projectDir, 'final', 'wm', 'repeat_wm.png');
    const before = fs.readFileSync(destination);
    const firstAsset = assetRepository.findById(first.generatedAssetIds[0]);
    expect(firstAsset.generated_source_relative_path).toBe('final/repeat.png');
    expect(firstAsset.generated_output_sha256).toBe(sha256For(destination));
    assetScanner.scanProjectAssets(project.id);
    expect(assetRepository.findById(first.generatedAssetIds[0]).generated_output_sha256)
      .toBe(firstAsset.generated_output_sha256);
    const skipped = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      overwrite: false,
    });
    expect(skipped).toMatchObject({ generatedCount: 0 });
    expect(skipped.sourceResults[0].variants[0].outputs[0].status).toBe('skipped-existing');
    expect(fs.readFileSync(destination)).toEqual(before);

    const replacement = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      overwrite: true,
    });
    expect(replacement.generatedAssetIds).toEqual(first.generatedAssetIds);

    const unrelatedSource = await writeIndexedImage('Final/unrelated.png');
    await writeIndexedImage('Final/wm/unrelated_wm.png', { nestedPath: 'wm' });
    await expect(processingService.watermarkAssets(project.id, [unrelatedSource.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
  });

  it('refuses to overwrite an externally replaced destination after scan, including same-size bytes', async () => {
    const source = await writeIndexedImage('final/external-replacement.png');
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const destinationPath = path.join(projectDir, 'final', 'wm', 'external-replacement_wm.png');
    const replacement = Buffer.from(fs.readFileSync(destinationPath));
    replacement[0] ^= 0xff;
    fs.writeFileSync(destinationPath, replacement);

    assetScanner.scanProjectAssets(project.id);
    const reconciled = assetRepository.findByProjectIdAndPath(
      project.id,
      'final/wm/external-replacement_wm.png',
    );
    expect(reconciled.size_bytes).toBe(replacement.length);
    expect(reconciled.generated_output_sha256).not.toBe(sha256For(destinationPath));

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
    expect(fs.readFileSync(destinationPath)).toEqual(replacement);
  });

  it('rejects an existing destination with a malformed stored output hash', async () => {
    const source = await writeIndexedImage('final/malformed-existing-hash.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const destinationPath = path.join(projectDir, 'final', 'wm', 'malformed-existing-hash_wm.png');
    const destinationAsset = assetRepository.findById(first.generatedAssetIds[0]);
    const malformedHash = 'g'.repeat(64);
    db.prepare('UPDATE assets SET generated_output_sha256 = ? WHERE id = ?')
      .run(malformedHash, destinationAsset.id);
    const before = fs.readFileSync(destinationPath);
    const rowBefore = assetRepository.findById(destinationAsset.id);

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });

    expect(fs.readFileSync(destinationPath)).toEqual(before);
    expect(assetRepository.findById(destinationAsset.id)).toEqual(rowBefore);
  });

  it('rejects a destination that appears before publishing a missing output', async () => {
    const source = await writeIndexedImage('final/missing-race.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const destinationPath = path.join(projectDir, 'final', 'wm', 'missing-race_wm.png');
    const destinationAsset = assetRepository.findById(first.generatedAssetIds[0]);
    fs.unlinkSync(destinationPath);
    assetScanner.scanProjectAssets(project.id);
    const externalBytes = Buffer.from('external race bytes');
    const realLink = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((sourcePath, targetPath) => {
      if (targetPath === destinationPath && sourcePath.includes('.creatorcrate-watermark-')) {
        fs.writeFileSync(destinationPath, externalBytes);
      }
      return realLink(sourcePath, targetPath);
    });

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.readFileSync(destinationPath)).toEqual(externalBytes);
    expect(assetRepository.findById(destinationAsset.id)).toMatchObject({ is_present: 0 });
  });

  it('does not authorize legacy provenance without source-path and output-hash identity', async () => {
    const source = await writeIndexedImage('Final/legacy-provenance.png');
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const destinationPath = path.join(projectDir, 'Final', 'wm', 'legacy-provenance_wm.png');
    const destination = assetRepository.findByProjectIdAndPath(
      project.id,
      'Final/wm/legacy-provenance_wm.png',
    );
    db.prepare(`
      UPDATE assets
      SET generated_source_relative_path = NULL, generated_output_sha256 = NULL
      WHERE id = ?
    `).run(destination.id);
    const before = fs.readFileSync(destinationPath);

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
    expect(fs.readFileSync(destinationPath)).toEqual(before);
  });

  it('prevents destructive social processing for published-release sources', async () => {
    const source = await writeIndexedImage('Final/published.png');
    const releaseId = insertRelease(true);
    linkRelease(releaseId, source.id);

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'social',
      outputFormat: 'png',
    })).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_ASSET_PROTECTED' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'published.png'))).toBe(true);
    expect(assetRepository.findById(source.id)).toBeTruthy();
  });

  it('preflights unsupported, missing, foreign, and intra-batch selections before mutation', async () => {
    const source = await writeIndexedImage('Final/preflight.png');
    const unsupported = await writeIndexedImage('Final/preflight.gif');
    const missing = assetRepository.upsert(project.id, 'Final/missing.png', {
      categoryId: finalCategory.id,
      nestedPath: '',
      filename: 'missing.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });
    const foreignProject = projectService.create(projectInput('Foreign Watermark Project'));
    const foreign = assetRepository.upsert(foreignProject.id, 'Final/foreign.png', {
      categoryId: null,
      nestedPath: '',
      filename: 'foreign.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });

    await expect(processingService.watermarkAssets(project.id, [source.id, unsupported.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE_TYPE' });
    await expect(processingService.watermarkAssets(project.id, [missing.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'SOURCE_MISSING' });
    await expect(processingService.watermarkAssets(project.id, [foreign.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'wm', 'preflight_wm.png'))).toBe(false);

    const first = await writeIndexedImage('Final/collision.png');
    const second = await writeIndexedImage('Final/collision.jpg', { format: 'jpeg' });
    await expect(processingService.watermarkAssets(project.id, [first.id, second.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'INTRA_BATCH_COLLISION' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'wm', 'collision_wm.png'))).toBe(false);
  });

  it('rolls back staged output when the asset index update fails', async () => {
    const source = await writeIndexedImage('Final/failure.png');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected watermark database failure'); });

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

    applySpy.mockRestore();
    expect(fs.existsSync(path.join(projectDir, 'Final', 'failure.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'wm', 'failure_wm.png'))).toBe(false);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/wm/failure_wm.png')).toBeUndefined();
  });

  it('restores an existing generated destination when overwrite indexing fails', async () => {
    const source = await writeIndexedImage('Final/overwrite-failure.png');
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });
    const destination = path.join(projectDir, 'Final', 'wm', 'overwrite-failure_wm.png');
    const before = fs.readFileSync(destination);
    const destinationAsset = assetRepository.findByProjectIdAndPath(
      project.id,
      'Final/wm/overwrite-failure_wm.png',
    );
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected overwrite database failure'); });

    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

    applySpy.mockRestore();
    expect(fs.readFileSync(destination)).toEqual(before);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/wm/overwrite-failure_wm.png').id)
      .toBe(destinationAsset.id);
  });

  it('uses the same asynchronous project lock as the other asset operations', async () => {
    const source = await writeIndexedImage('Final/locked.png');
    await coordinator.runAsync(project.id, async () => {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
      })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    });
  });

  it('accepts a nested trusted watermark path and uses it for processing', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const configuredPath = path.join(root, 'branding', 'primary', 'mark.png');
    fs.mkdirSync(path.dirname(configuredPath), { recursive: true });
    fs.writeFileSync(configuredPath, await makeWatermark());

    const source = await writeIndexedImage('Final/nested-trusted.png');
    const service = createConfiguredService(configuredPath, root);
    const result = await service.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });

    expect(result).toMatchObject({ status: 'completed', generatedCount: 1 });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'wm', 'nested-trusted_wm.png')))
      .toBe(true);
  });

  it.skipIf(!HAS_SYMLINKS)('rejects an intermediate symlink escape before mutation', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'mark.png'), await makeWatermark());
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');

    await expectInvalidTrustedWatermark(
      path.join(root, 'linked', 'mark.png'),
      root,
      'intermediate-symlink',
    );
  });

  it.skipIf(!HAS_SYMLINKS)('rejects a deeper intermediate symlink escape', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'mark.png'), await makeWatermark());
    fs.symlinkSync(outside, path.join(root, 'a', 'b'), 'junction');

    await expectInvalidTrustedWatermark(
      path.join(root, 'a', 'b', 'mark.png'),
      root,
      'deeper-symlink',
    );
  });

  it.skipIf(!HAS_SYMLINKS)('rejects a final watermark file symlink', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const outsideFile = path.join(tmpDir, 'outside-mark.png');
    const configuredPath = path.join(root, 'mark.png');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(outsideFile, await makeWatermark());
    fs.symlinkSync(outsideFile, configuredPath, 'file');

    await expectInvalidTrustedWatermark(configuredPath, root, 'final-symlink');
  });

  it.skipIf(!HAS_SYMLINKS)('rejects a symlink even when its target remains inside the root', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const branding = path.join(root, 'branding');
    const configuredPath = path.join(root, 'link', 'mark.png');
    fs.mkdirSync(branding, { recursive: true });
    fs.writeFileSync(path.join(branding, 'mark.png'), await makeWatermark());
    fs.symlinkSync(branding, path.join(root, 'link'), 'junction');

    await expectInvalidTrustedWatermark(configuredPath, root, 'inside-root-symlink');
  });

  it.skipIf(!HAS_SYMLINKS)('rejects a symlinked configured watermark root', async () => {
    const realRoot = path.join(tmpDir, 'real-watermarks');
    const configuredRoot = path.join(tmpDir, 'watermarks');
    const configuredPath = path.join(configuredRoot, 'mark.png');
    fs.mkdirSync(realRoot, { recursive: true });
    fs.writeFileSync(path.join(realRoot, 'mark.png'), await makeWatermark());
    fs.symlinkSync(realRoot, configuredRoot, 'junction');

    await expectInvalidTrustedWatermark(configuredPath, configuredRoot, 'root-symlink');
  });

  it('rejects a directory masquerading as a PNG watermark', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const configuredPath = path.join(root, 'mark.png');
    fs.mkdirSync(configuredPath, { recursive: true });

    await expectInvalidTrustedWatermark(configuredPath, root, 'directory-watermark');
  });

  it('rejects a missing intermediate watermark directory', async () => {
    const root = path.join(tmpDir, 'watermarks');
    fs.mkdirSync(root, { recursive: true });

    await expectInvalidTrustedWatermark(
      path.join(root, 'missing', 'mark.png'),
      root,
      'missing-intermediate',
    );
  });

  it('rejects a missing configured watermark root', async () => {
    const root = path.join(tmpDir, 'missing-watermarks');

    await expectInvalidTrustedWatermark(
      path.join(root, 'mark.png'),
      root,
      'missing-root',
    );
  });

  it('rejects a trusted watermark path under a lexical sibling of the root', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const sibling = path.join(tmpDir, 'watermarks-other');
    const configuredPath = path.join(sibling, 'mark.png');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(configuredPath, await makeWatermark());

    await expectInvalidTrustedWatermark(configuredPath, root, 'sibling-escape');
  });

  it('rejects a trusted watermark with a non-PNG extension', async () => {
    const root = path.join(tmpDir, 'watermarks');
    const configuredPath = path.join(root, 'mark.jpg');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(configuredPath, await makeWatermark());

    await expectInvalidTrustedWatermark(configuredPath, root, 'invalid-extension');
  });

  it('rejects a missing trusted watermark before mutating selected assets', async () => {
    const source = await writeIndexedImage('Final/missing-watermark.png');
    const missingService = createAssetProcessingService({
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: createProjectOperationCoordinator(),
      watermarkPath: path.join(tmpDir, 'does-not-exist.png'),
      watermarkRoot: tmpDir,
    });

    await expect(missingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({
      name: 'AssetProcessingError',
      code: 'WATERMARK_FILE_INVALID',
    });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'missing-watermark.png'))).toBe(true);
  });
});
