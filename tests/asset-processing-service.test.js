import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { decode as decodeBmp, encode as encodeBmp } from '@nktkas/bmp';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createProcessingPresetRepository } from '../src/data/processing-preset-repository.js';
import { createWatermarkScaleMapRepository } from '../src/data/watermark-scale-map-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createAssetProcessingPlanner } from '../src/services/asset-processing-planner.js';
import {
  createAssetProcessingService,
  AssetProcessingError,
} from '../src/services/asset-processing-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingPresetService } from '../src/services/processing-preset-service.js';
import { createWatermarkScaleMapService } from '../src/services/watermark-scale-map-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { createPngChunk, PNG_SIGNATURE } from '../src/services/workflow-prompt-editor.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function validProjectInput(overrides = {}) {
  return {
    title: 'Processing Project',
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

describe('asset processing service', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let projectRepository;
  let assetRepository;
  let assetCategoryRepository;
  let assetCategoryService;
  let projectService;
  let processingService;
  let planner;
  let projectOperationCoordinator;
  let project;
  let projectDir;
  let imageBuffer;
  let finalCategory;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);

    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    assetCategoryRepository = createAssetCategoryRepository(db);
    assetCategoryService = createAssetCategoryService(assetCategoryRepository);
    const assetBrowserPreferenceRepository = createAssetBrowserPreferenceRepository(db);
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository,
    });
    project = projectService.create(validProjectInput());
    projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    finalCategory = assetCategoryRepository.listProjectCategories(project.id)
      .find((category) => category.directory_slug === 'final');

    imageBuffer = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 230, g: 90, b: 40, alpha: 1 },
      },
    }).png().toBuffer();

    projectOperationCoordinator = createProjectOperationCoordinator();
    const scopeService = createAssetProcessingScopeService({ projectRepository, assetRepository });
    planner = createAssetProcessingPlanner({
      scopeService,
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
    });
    processingService = createAssetProcessingService({
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeIndexedImage(relativePath, nestedPath = '') {
    const normalized = relativePath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalized);
    const target = path.join(projectDir, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, imageBuffer);
    const stats = fs.statSync(target);
    const inFinal = normalized === filename || normalized.startsWith('Final/');
    return assetRepository.upsert(project.id, normalized, {
      categoryId: inFinal ? finalCategory.id : null,
      nestedPath,
      filename,
      extension: filename.slice(filename.lastIndexOf('.') + 1).toLowerCase(),
      mimeType: 'image/png',
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  function writeIndexedBuffer(relativePath, buffer, mimeType, nestedPath = '') {
    const normalized = relativePath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalized);
    const target = path.join(projectDir, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    const stats = fs.statSync(target);
    const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    const inFinal = normalized === filename || normalized.startsWith('Final/');
    return assetRepository.upsert(project.id, normalized, {
      categoryId: inFinal ? finalCategory.id : null,
      nestedPath,
      filename,
      extension,
      mimeType,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  async function makeAnimatedGif() {
    const frameData = Buffer.from([
      255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0,
      0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255,
    ]);
    return sharp(frameData, {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    }).gif({ animated: true, delay: [100, 100] }).toBuffer();
  }

  function writeIndexedPromptPng(relativePath, key, value, nestedPath = '') {
    const normalized = relativePath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalized);
    const target = path.join(projectDir, ...normalized.split('/'));
    const metadata = Buffer.concat([
      PNG_SIGNATURE,
      createPngChunk('IHDR', Buffer.alloc(13)),
      createPngChunk('tEXt', Buffer.concat([
        Buffer.from(key, 'ascii'),
        Buffer.from([0]),
        Buffer.from(value, 'utf8'),
      ])),
      createPngChunk('IEND'),
    ]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, metadata);
    const stats = fs.statSync(target);
    const inFinal = normalized === filename || normalized.startsWith('Final/');
    return assetRepository.upsert(project.id, normalized, {
      categoryId: inFinal ? finalCategory.id : null,
      nestedPath,
      filename,
      extension: filename.slice(filename.lastIndexOf('.') + 1).toLowerCase(),
      mimeType: 'image/png',
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  function insertRelease({ published = false } = {}) {
    return db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date,
                            published_date, patreon_url, archived_at)
      VALUES (?, 'Processing Release', '', '', NULL, ?, NULL, NULL)
      RETURNING id
    `).get(project.id, published ? '2026-01-01' : null).id;
  }

  function linkRelease(releaseId, assetId) {
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, assetId, 'attachment', 0);
  }

  it('converts a selected image to WebP and keeps the original indexed row', async () => {
    const source = writeIndexedImage('Final/render.png');

    const result = await processingService.convertAssets(project.id, [source.id], {
      format: 'webp',
      quality: 85,
      originalHandling: 'keep',
    });

    expect(result).toMatchObject({
      convertedCount: 1,
      requestedCount: 1,
      format: 'webp',
      quality: 85,
      originalHandling: 'keep',
    });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'render.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'render.webp'))).toBe(true);

    const output = assetRepository.findByProjectIdAndPath(project.id, 'Final/render.webp');
    expect(output).toMatchObject({
      project_id: project.id,
      relative_path: 'Final/render.webp',
      category_id: finalCategory.id,
      nested_path: '',
      extension: 'webp',
      mime_type: 'image/webp',
    });
    expect(output.id).not.toBe(source.id);
    expect(assetRepository.findById(source.id)).toMatchObject({
      relative_path: 'Final/render.png',
      filename: 'render.png',
    });
    expect((await sharp(fs.readFileSync(path.join(projectDir, 'Final', 'render.webp'))).metadata()).format)
      .toBe('webp');
  });

  it('defaults WebP quality to 85 and accepts the 1..95 range only', async () => {
    const defaultSource = writeIndexedImage('Final/default-quality.png');
    const lowSource = writeIndexedImage('Final/low-quality.png');
    const highSource = writeIndexedImage('Final/high-quality.png');

    await expect(processingService.convertAssets(project.id, [defaultSource.id], {
      format: 'webp', originalHandling: 'keep',
    })).resolves.toMatchObject({ quality: 85 });
    await expect(processingService.convertAssets(project.id, [lowSource.id], {
      format: 'webp', quality: 1, originalHandling: 'keep',
    })).resolves.toMatchObject({ quality: 1 });
    await expect(processingService.convertAssets(project.id, [highSource.id], {
      format: 'webp', quality: 95, originalHandling: 'keep',
    })).resolves.toMatchObject({ quality: 95 });

    await expect(processingService.convertAssets(project.id, [defaultSource.id], {
      format: 'webp', quality: 0, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'INVALID_QUALITY' });
    await expect(processingService.convertAssets(project.id, [defaultSource.id], {
      format: 'webp', quality: 96, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'INVALID_QUALITY' });
    await expect(processingService.convertAssets(project.id, [defaultSource.id], {
      format: 'png', quality: 100, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'INVALID_QUALITY' });
  });

  it('writes jpg and jpeg as valid JPEG files with distinct extensions', async () => {
    const jpegSource = writeIndexedImage('Final/output-jpeg.png');
    const jpgSource = writeIndexedImage('Final/output-jpg.png');

    await processingService.convertAssets(project.id, [jpegSource.id], {
      format: 'jpeg', quality: 85, originalHandling: 'keep',
    });
    await processingService.convertAssets(project.id, [jpgSource.id], {
      format: 'jpg', quality: 85, originalHandling: 'keep',
    });

    for (const extension of ['jpeg', 'jpg']) {
      const outputPath = path.join(projectDir, 'Final', `output-${extension}.${extension}`);
      const bytes = fs.readFileSync(outputPath);
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect((await sharp(bytes).metadata()).format).toBe('jpeg');
      expect(assetRepository.findByProjectIdAndPath(
        project.id,
        `Final/output-${extension}.${extension}`,
      )).toMatchObject({ extension, mime_type: 'image/jpeg' });
    }
  });

  it('decodes BMP sources and encodes valid BMP output', async () => {
    const bmpBuffer = Buffer.from(encodeBmp({
      width: 2,
      height: 2,
      channels: 3,
      data: new Uint8Array([
        255, 0, 0, 0, 255, 0,
        0, 0, 255, 255, 255, 0,
      ]),
    }, { bitsPerPixel: 24 }));
    const bmpSource = writeIndexedBuffer('Final/source.bmp', bmpBuffer, 'image/bmp');

    for (const format of ['png', 'webp', 'jpeg']) {
      await processingService.convertAssets(project.id, [bmpSource.id], {
        format,
        quality: 85,
        originalHandling: 'keep',
      });
      const outputPath = path.join(projectDir, 'Final', `source.${format}`);
      expect((await sharp(fs.readFileSync(outputPath)).metadata()).format)
        .toBe(format === 'jpeg' ? 'jpeg' : format);
    }

    const pngSource = writeIndexedImage('Final/to-bmp.png');
    await processingService.convertAssets(project.id, [pngSource.id], {
      format: 'bmp',
      quality: 1,
      originalHandling: 'keep',
    });
    const output = fs.readFileSync(path.join(projectDir, 'Final', 'to-bmp.bmp'));
    const decoded = decodeBmp(new Uint8Array(output));
    expect(decoded).toMatchObject({ width: 2, height: 2, channels: 3 });
    expect(decoded.data.length).toBe(decoded.width * decoded.height * decoded.channels);
  });

  it('turns malformed BMP input into a controlled conversion failure', async () => {
    const source = writeIndexedBuffer('Final/malformed.bmp', Buffer.from('not-a-bmp'), 'image/bmp');

    await expect(processingService.convertAssets(project.id, [source.id], {
      format: 'png', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ name: 'AssetProcessingError', code: 'CONVERSION_FAILED' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'malformed.png'))).toBe(false);
  });

  it('writes GIF output as a static first-frame image and ignores quality', async () => {
    const animated = await makeAnimatedGif();
    const first = writeIndexedBuffer('Final/animated-first.gif', animated, 'image/gif');
    const second = writeIndexedBuffer('Final/animated-second.gif', animated, 'image/gif');
    const pngSource = writeIndexedImage('Final/static-to-gif.png');

    await processingService.convertAssets(project.id, [pngSource.id], {
      format: 'gif', quality: 1, originalHandling: 'keep',
    });
    expect((await sharp(fs.readFileSync(path.join(projectDir, 'Final', 'static-to-gif.gif'))).metadata()))
      .toMatchObject({ format: 'gif', pages: 1 });

    await processingService.convertAssets(project.id, [first.id], {
      format: 'png', quality: 85, originalHandling: 'keep',
    });
    const expectedFirstFrame = await sharp(animated, { page: 0 }).png().toBuffer();
    expect(fs.readFileSync(path.join(projectDir, 'Final', 'animated-first.png')))
      .toEqual(expectedFirstFrame);

    for (const format of ['jpeg', 'webp', 'bmp']) {
      await processingService.convertAssets(project.id, [first.id], {
        format, quality: 85, originalHandling: 'keep',
      });
      const output = fs.readFileSync(path.join(projectDir, 'Final', `animated-first.${format}`));
      const raw = format === 'bmp'
        ? decodeBmp(new Uint8Array(output))
        : await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(raw.data[0]).toBeGreaterThan(150);
      expect(raw.data[1]).toBeLessThan(100);
      expect(raw.data[2]).toBeLessThan(100);
    }

    await processingService.convertAssets(project.id, [second.id], {
      format: 'gif', quality: 95, originalHandling: 'keep',
    });
    const staticGif = fs.readFileSync(path.join(projectDir, 'Final', 'animated-second.gif'));
    expect((await sharp(staticGif).metadata())).toMatchObject({ format: 'gif', pages: 1 });
    const lowQuality = writeIndexedBuffer('Final/gif-quality-low.gif', animated, 'image/gif');
    const highQuality = writeIndexedBuffer('Final/gif-quality-high.gif', animated, 'image/gif');
    await processingService.convertAssets(project.id, [lowQuality.id], {
      format: 'gif', quality: 1, originalHandling: 'keep',
    });
    await processingService.convertAssets(project.id, [highQuality.id], {
      format: 'gif', quality: 95, originalHandling: 'keep',
    });
    expect(fs.readFileSync(path.join(projectDir, 'Final', 'gif-quality-low.gif')))
      .toEqual(fs.readFileSync(path.join(projectDir, 'Final', 'gif-quality-high.gif')));
  });

  it('re-encodes WebP in place while preserving asset identity and associations', async () => {
    const pixels = Buffer.alloc(8 * 8 * 3);
    for (let index = 0; index < pixels.length; index += 3) {
      pixels[index] = index % 256;
      pixels[index + 1] = (index * 3) % 256;
      pixels[index + 2] = (255 - index) & 0xff;
    }
    const webp = await sharp(pixels, { raw: { width: 8, height: 8, channels: 3 } })
      .webp({ quality: 95 }).toBuffer();
    const source = writeIndexedBuffer('Final/in-place.webp', webp, 'image/webp');
    const releaseId = insertRelease();
    linkRelease(releaseId, source.id);
    const before = assetRepository.findById(source.id);
    const beforeBytes = fs.readFileSync(path.join(projectDir, 'Final', 'in-place.webp'));

    const result = await processingService.convertAssets(project.id, [source.id], {
      format: 'webp', quality: 1, originalHandling: 'keep',
    });

    const target = path.join(projectDir, 'Final', 'in-place.webp');
    const after = assetRepository.findById(source.id);
    const afterBytes = fs.readFileSync(target);
    expect(result.convertedAssetIds).toEqual([source.id]);
    expect(after).toMatchObject({
      id: source.id,
      relative_path: before.relative_path,
      filename: before.filename,
      category_id: before.category_id,
      nested_path: before.nested_path,
      size_bytes: afterBytes.length,
      modified_at: fs.statSync(target).mtime.toISOString(),
    });
    expect(afterBytes).not.toEqual(beforeBytes);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/in-place.webp').id)
      .toBe(source.id);
    expect(db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ?').get(releaseId).asset_id)
      .toBe(source.id);
  });

  it('supports same-extension PNG, GIF, and BMP re-encodes', async () => {
    const pngSource = writeIndexedImage('Final/in-place.png');
    const animated = await makeAnimatedGif();
    const gifSource = writeIndexedBuffer('Final/in-place.gif', animated, 'image/gif');
    const jpegBytes = await sharp(imageBuffer).jpeg({ quality: 90 }).toBuffer();
    const jpgSource = writeIndexedBuffer('Final/in-place.jpg', jpegBytes, 'image/jpeg');
    const jpegSource = writeIndexedBuffer('Final/in-place.jpeg', jpegBytes, 'image/jpeg');
    const bmpSource = writeIndexedBuffer('Final/in-place.bmp', Buffer.from(encodeBmp({
      width: 2,
      height: 2,
      channels: 3,
      data: new Uint8Array([
        255, 0, 0, 0, 255, 0,
        0, 0, 255, 255, 255, 0,
      ]),
    }, { bitsPerPixel: 24 })), 'image/bmp');

    for (const [asset, format, relativePath] of [
      [pngSource, 'png', 'Final/in-place.png'],
      [gifSource, 'gif', 'Final/in-place.gif'],
      [jpgSource, 'jpg', 'Final/in-place.jpg'],
      [jpegSource, 'jpeg', 'Final/in-place.jpeg'],
      [bmpSource, 'bmp', 'Final/in-place.bmp'],
    ]) {
      await processingService.convertAssets(project.id, [asset.id], {
        format, quality: 95, originalHandling: 'keep',
      });
      expect(assetRepository.findByProjectIdAndPath(project.id, relativePath).id).toBe(asset.id);
    }
    expect((await sharp(fs.readFileSync(path.join(projectDir, 'Final', 'in-place.gif'))).metadata()))
      .toMatchObject({ format: 'gif', pages: 1 });
    expect(decodeBmp(new Uint8Array(fs.readFileSync(path.join(projectDir, 'Final', 'in-place.bmp')))))
      .toMatchObject({ width: 2, height: 2 });
  });

  it('rejects destructive handling for same-extension conversion before mutation', async () => {
    const source = writeIndexedImage('Final/destructive-same-extension.png');
    const target = path.join(projectDir, 'Final', 'destructive-same-extension.png');
    const before = fs.readFileSync(target);

    for (const originalHandling of ['move', 'delete']) {
      await expect(processingService.convertAssets(project.id, [source.id], {
        format: 'png', quality: 85, originalHandling,
      })).rejects.toMatchObject({ code: 'INVALID_ORIGINAL_HANDLING' });
      expect(fs.readFileSync(target)).toEqual(before);
      expect(assetRepository.findById(source.id).relative_path)
        .toBe('Final/destructive-same-extension.png');
    }
  });

  it('restores original bytes when same-extension publication fails', async () => {
    const source = writeIndexedImage('Final/publication-failure.png');
    const target = path.join(projectDir, 'Final', 'publication-failure.png');
    const before = fs.readFileSync(target);
    const originalLink = fs.linkSync;
    let publicationFailed = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (!publicationFailed
        && String(to) === target
        && String(from).endsWith('.output')) {
        publicationFailed = true;
        throw new Error('injected publication failure');
      }
      return originalLink.call(fs, from, to);
    });

    try {
      await expect(processingService.convertAssets(project.id, [source.id], {
        format: 'png', quality: 85, originalHandling: 'keep',
      })).rejects.toMatchObject({
        name: 'AssetProcessingError',
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id).relative_path)
      .toBe('Final/publication-failure.png');
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-convert-')))
      .toEqual([]);
  });

  it('restores an in-place re-encode when the index update fails', async () => {
    const source = writeIndexedImage('Final/index-failure.png');
    const target = path.join(projectDir, 'Final', 'index-failure.png');
    const before = fs.readFileSync(target);
    const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
      .mockImplementation(() => { throw new Error('injected database failure'); });

    await expect(processingService.convertAssets(project.id, [source.id], {
      format: 'png', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

    applySpy.mockRestore();
    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id)).toMatchObject({
      relative_path: 'Final/index-failure.png',
      size_bytes: before.length,
    });
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-convert-')))
      .toEqual([]);
  });

  it('strictly validates format, quality, and original handling options', async () => {
    const source = writeIndexedImage('Final/options.png');
    const invalidOptions = [
      [{ format: 'tiff', quality: 85, originalHandling: 'keep' }, 'INVALID_FORMAT'],
      [{ format: 'webp', quality: 0, originalHandling: 'keep' }, 'INVALID_QUALITY'],
      [{ format: 'jpeg', quality: 96, originalHandling: 'keep' }, 'INVALID_QUALITY'],
      [{ format: 'png', quality: 0, originalHandling: 'keep' }, 'INVALID_QUALITY'],
      [{ format: 'png', originalHandling: 'copy' }, 'INVALID_ORIGINAL_HANDLING'],
    ];

    for (const [options, code] of invalidOptions) {
      await expect(processingService.convertAssets(project.id, [source.id], options))
        .rejects.toMatchObject({ name: 'AssetProcessingError', code });
    }

    expect(fs.existsSync(path.join(projectDir, 'Final', 'options.png'))).toBe(true);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/options.webp')).toBeUndefined();
  });

  it('moves a nested original into its current parent originals directory and preserves its ID', async () => {
    const source = writeIndexedImage('Final/exports/render.png', 'exports');
    const releaseId = insertRelease();
    linkRelease(releaseId, source.id);

    await processingService.convertAssets(project.id, [source.id], {
      format: 'jpeg',
      quality: 90,
      originalHandling: 'move',
    });

    const moved = assetRepository.findById(source.id);
    expect(moved).toMatchObject({
      relative_path: 'Final/exports/originals/render.png',
      filename: 'render.png',
      extension: 'png',
      category_id: finalCategory.id,
      nested_path: 'exports/originals',
    });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'exports', 'render.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'exports', 'originals', 'render.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'exports', 'render.jpeg'))).toBe(true);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/exports/render.jpeg')).toMatchObject({
      category_id: finalCategory.id,
      nested_path: 'exports',
      mime_type: 'image/jpeg',
    });
    expect(db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ?').get(releaseId).asset_id)
      .toBe(source.id);
  });

  it('classifies a root originals move like the scanner when originals is a category slug', async () => {
    const originalsCategory = db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
      VALUES (?, 'Originals', 'originals', 99, 1)
      RETURNING id
    `).get(project.id);
    const source = writeIndexedImage('root-original.png');
    const scanner = createAssetScanner(db, projectsRoot, {
      projectService,
      assetCategoryService,
      projectOperationCoordinator,
      previewCategorySettingsService: { getPreviewCategory: () => '__disabled__' },
      projectPrimaryImageRepository: {
        findByProjectId: () => undefined,
        setPrimaryImage: () => undefined,
      },
    });

    await processingService.convertAssets(project.id, [source.id], {
      format: 'webp',
      quality: 85,
      originalHandling: 'move',
    });
    scanner.scanProjectAssets(project.id);

    const moved = assetRepository.findByProjectIdAndPath(project.id, 'originals/root-original.png');
    expect(moved).toMatchObject({
      category_id: originalsCategory.id,
      nested_path: '',
    });
  });

  it('deletes the original only after writing the converted output', async () => {
    const source = writeIndexedImage('Final/delete-me.png');

    await processingService.convertAssets(project.id, [source.id], {
      format: 'webp',
      quality: 80,
      originalHandling: 'delete',
    });

    expect(fs.existsSync(path.join(projectDir, 'Final', 'delete-me.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'delete-me.webp'))).toBe(true);
    expect(assetRepository.findById(source.id)).toBeUndefined();
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/delete-me.webp')).toBeTruthy();
  });

  it('protects originals referenced by a published release in delete mode', async () => {
    const source = writeIndexedImage('Final/published.png');
    linkRelease(insertRelease({ published: true }), source.id);

    await expect(processingService.convertAssets(project.id, [source.id], {
      format: 'webp',
      quality: 85,
      originalHandling: 'delete',
    })).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_ASSET_PROTECTED' });

    expect(fs.existsSync(path.join(projectDir, 'Final', 'published.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'published.webp'))).toBe(false);
  });

  it('rejects unsupported, missing, and foreign selected assets before mutation', async () => {
    const unsupported = writeIndexedImage('Final/not-an-image.png');
    const unsupportedPath = path.join(projectDir, 'Final', 'not-an-image.png');
    fs.renameSync(unsupportedPath, path.join(projectDir, 'Final', 'not-an-image.txt'));
    assetRepository.updateAssetLocation(project.id, unsupported.id, 'Final/not-an-image.png', {
      relativePath: 'Final/not-an-image.txt',
      filename: 'not-an-image.txt',
      extension: 'txt',
      mimeType: 'text/plain',
      categoryId: finalCategory.id,
      nestedPath: '',
      sizeBytes: 1,
      modifiedAt: null,
    });

    await expect(processingService.convertAssets(project.id, [unsupported.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE_TYPE' });

    const missing = assetRepository.upsert(project.id, 'Final/missing.png', {
      categoryId: finalCategory.id,
      nestedPath: '',
      filename: 'missing.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });
    await expect(processingService.convertAssets(project.id, [missing.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'SOURCE_MISSING' });

    const otherProject = projectService.create(validProjectInput({ title: 'Foreign Processing Project' }));
    const foreign = assetRepository.upsert(otherProject.id, 'Final/foreign.png', {
      categoryId: null,
      nestedPath: '',
      filename: 'foreign.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });
    await expect(processingService.convertAssets(project.id, [foreign.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('rejects indexed and filesystem destination conflicts without mutating the source', async () => {
    const indexedConflict = writeIndexedImage('Final/indexed.png');
    assetRepository.upsert(project.id, 'Final/indexed.webp', {
      categoryId: finalCategory.id,
      nestedPath: '',
      filename: 'indexed.webp',
      extension: 'webp',
      mimeType: 'image/webp',
      sizeBytes: 1,
      modifiedAt: null,
    });

    await expect(processingService.convertAssets(project.id, [indexedConflict.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'indexed.png'))).toBe(true);

    const filesystemConflict = writeIndexedImage('Final/filesystem.png');
    fs.writeFileSync(path.join(projectDir, 'Final', 'filesystem.webp'), 'occupied');
    await expect(processingService.convertAssets(project.id, [filesystemConflict.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'filesystem.png'))).toBe(true);
  });

  it('rejects an occupied originals destination before moving the source', async () => {
    const source = writeIndexedImage('Final/original-conflict.png');
    writeIndexedImage('Final/originals/original-conflict.png', 'originals');

    await expect(processingService.convertAssets(project.id, [source.id], {
      format: 'webp', quality: 85, originalHandling: 'move',
    })).rejects.toMatchObject({ code: 'ORIGINAL_DESTINATION_CONFLICT' });

    expect(fs.existsSync(path.join(projectDir, 'Final', 'original-conflict.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'original-conflict.webp'))).toBe(false);
  });

  it('rejects an intra-batch destination collision on case-insensitive filesystems', async () => {
    if (process.platform !== 'win32') return;
    const first = writeIndexedImage('Final/collision.png');
    const second = assetRepository.upsert(project.id, 'Final/collision.PNG', {
      categoryId: finalCategory.id,
      nestedPath: '',
      filename: 'collision.PNG',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });

    await expect(processingService.convertAssets(project.id, [first.id, second.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'INTRA_BATCH_COLLISION' });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'collision.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'collision.webp'))).toBe(false);
  });

  it('cleans a published output when the post-write index update fails', async () => {
    const source = writeIndexedImage('Final/recovery.png');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
      .mockImplementation(() => { throw new Error('injected database failure'); });

    await expect(processingService.convertAssets(project.id, [source.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({
      name: 'AssetProcessingError',
      code: 'DATABASE_OPERATION_FAILED',
    });

    applySpy.mockRestore();
    expect(fs.existsSync(path.join(projectDir, 'Final', 'recovery.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'recovery.webp'))).toBe(false);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/recovery.webp')).toBeUndefined();
  });

  it('reports controlled domain errors for invalid selection and exposes the error type', async () => {
    await expect(processingService.convertAssets(project.id, [], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toBeInstanceOf(AssetProcessingError);
    await expect(processingService.convertAssets(project.id, [1], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('uses the shared project lock for the full asynchronous conversion operation', async () => {
    const source = writeIndexedImage('Final/locked.png');

    await projectOperationCoordinator.runAsync(project.id, async () => {
      await expect(processingService.convertAssets(project.id, [source.id], {
        format: 'webp', quality: 85, originalHandling: 'keep',
      })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      expect(fs.existsSync(path.join(projectDir, 'Final', 'locked.png'))).toBe(true);
    });
  });

  it('edits ComfyUI positive and negative prompts in place without changing asset identity', async () => {
    const graph = JSON.stringify({
      '1': {
        class_type: 'KSampler',
        inputs: { positive: ['2', 0], negative: ['3', 0], seed: 9 },
      },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait', clip: ['4', 0] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'unrelated' } },
    });
    const source = writeIndexedPromptPng('Final/workflow.png', 'prompt', graph, 'renders');
    const releaseId = insertRelease();
    linkRelease(releaseId, source.id);
    const before = assetRepository.findById(source.id);
    const promptOptions = {
      positive: {
        rules: [
          { type: 'append', text: ' detailed' },
          { type: 'replace', search: 'portrait', replacement: 'subject' },
          { type: 'remove', text: 'missing' },
          { type: 'prepend', text: 'positive ' },
        ],
      },
      negative: {
        rules: [
          { type: 'replace', search: 'blurry', replacement: 'low quality' },
          { type: 'append', text: ' caution' },
          { type: 'prepend', text: 'not ' },
          { type: 'remove', text: 'missing' },
        ],
      },
    };

    const firstPlan = await planner.planWorkflowPromptEdit(project.id, {
      type: 'selected',
      assetIds: [source.id],
    }, promptOptions);
    expect(firstPlan.items[0]).toMatchObject({
      status: 'ready',
      beforePositive: 'portrait',
      afterPositive: 'positive subject detailed',
      beforeNegative: 'blurry',
      afterNegative: 'not low quality caution',
      positiveChanged: true,
      negativeChanged: true,
    });

    const result = await processingService.editWorkflowPrompts(project.id, [source.id], promptOptions);

    const after = assetRepository.findById(source.id);
    const target = path.join(projectDir, 'Final', 'workflow.png');
    const firstRunBytes = fs.readFileSync(target);
    const firstRunMtime = fs.statSync(target).mtimeMs;

    expect(result).toMatchObject({
      status: 'completed',
      changedCount: 1,
      unchangedCount: 0,
      changedAssetIds: [source.id],
      unchangedAssetIds: [],
      noWorkflowAssetIds: [],
      noChangeAssetIds: [],
    });
    expect(after).toMatchObject({
      id: before.id,
      project_id: before.project_id,
      relative_path: before.relative_path,
      filename: before.filename,
      category_id: before.category_id,
      nested_path: before.nested_path,
    });
    expect(db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ?').get(releaseId).asset_id)
      .toBe(source.id);
    expect(firstRunBytes.includes(Buffer.from('positive subject detailed'))).toBe(true);
    expect(firstRunBytes.includes(Buffer.from('not low quality caution'))).toBe(true);
    expect(firstRunBytes.includes(Buffer.from('unrelated'))).toBe(true);

    const secondResult = await processingService.editWorkflowPrompts(project.id, [source.id], promptOptions);

    expect(secondResult).toMatchObject({
      status: 'completed',
      changedCount: 0,
      unchangedCount: 1,
      changedAssetIds: [],
      unchangedAssetIds: [source.id],
      noWorkflowAssetIds: [],
      noChangeAssetIds: [source.id],
    });
    expect(fs.readFileSync(target)).toEqual(firstRunBytes);
    expect(fs.statSync(target).mtimeMs).toBe(firstRunMtime);

    const secondPlan = await planner.planWorkflowPromptEdit(project.id, {
      type: 'selected',
      assetIds: [source.id],
    }, promptOptions);
    expect(secondPlan.items[0]).toMatchObject({
      status: 'unchanged',
      reasonCode: 'NO_PROMPT_CHANGES',
      beforePositive: 'positive subject detailed',
      afterPositive: 'positive subject detailed',
      beforeNegative: 'not low quality caution',
      afterNegative: 'not low quality caution',
      positiveChanged: false,
      negativeChanged: false,
    });
  });

  it('applies a seeded Workflow preset directly through the execution entry point', async () => {
    const source = writeIndexedPromptPng(
      'Final/preset-workflow.png',
      'parameters',
      'Positive prompt: portrait\nNegative prompt: blurry\nSteps: 20',
    );
    const scaleMapService = createWatermarkScaleMapService({
      repository: createWatermarkScaleMapRepository(db),
    });
    const presetService = createProcessingPresetService({
      repository: createProcessingPresetRepository(db),
      scaleMapService,
      watermarkService: {
        getWatermark(id) {
          if (id !== 1) throw Object.assign(new Error('Watermark not found.'), { code: 'WATERMARK_NOT_FOUND' });
          return { id };
        },
        resolveForProcessing(id) { return { watermark: this.getWatermark(id) }; },
      },
    });
    presetService.seedReferencePresets();
    const benji = presetService.listPresets({ operationType: 'workflow-prompt' })
      .find((preset) => preset.systemKey === 'workflow-benji');
    const resolved = presetService.resolvePresetForExecution(benji.id);

    const result = await processingService.editWorkflowPrompts(project.id, [source.id], resolved.options);

    expect(result).toMatchObject({ status: 'completed', changedCount: 1, changedAssetIds: [source.id] });
    expect(fs.readFileSync(path.join(projectDir, 'Final', 'preset-workflow.png')).includes(Buffer.from('Negative prompt: extra abs, blurry')))
      .toBe(true);
    await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
      positive: [], negative: { rules: [] },
    })).rejects.toMatchObject({ code: 'INVALID_PROMPT_RULES' });
  });

  it('returns unchanged assets and does not rewrite a no-op PNG', async () => {
    const source = writeIndexedPromptPng('Final/no-op.png', 'parameters', 'same prompt');
    const noWorkflow = writeIndexedPromptPng('Final/no-workflow.png', 'comment', 'plain image');
    const target = path.join(projectDir, 'Final', 'no-op.png');
    const noWorkflowTarget = path.join(projectDir, 'Final', 'no-workflow.png');
    const beforeBytes = fs.readFileSync(target);
    const beforeMtime = fs.statSync(target).mtimeMs;
    const noWorkflowBytes = fs.readFileSync(noWorkflowTarget);
    const noWorkflowMtime = fs.statSync(noWorkflowTarget).mtimeMs;

    const result = await processingService.editWorkflowPrompts(project.id, [source.id, noWorkflow.id], {
      positive: { rules: [{ type: 'remove', text: 'not present' }] },
    });

    expect(result).toMatchObject({
      status: 'completed',
      changedCount: 0,
      unchangedCount: 2,
      changedAssetIds: [],
      unchangedAssetIds: [source.id, noWorkflow.id],
      noWorkflowAssetIds: [noWorkflow.id],
      noChangeAssetIds: [source.id],
    });
    expect(fs.readFileSync(target)).toEqual(beforeBytes);
    expect(fs.statSync(target).mtimeMs).toBe(beforeMtime);
    expect(fs.readFileSync(noWorkflowTarget)).toEqual(noWorkflowBytes);
    expect(fs.statSync(noWorkflowTarget).mtimeMs).toBe(noWorkflowMtime);
  });

  it('rejects non-PNG, missing, foreign, and non-regular selections', async () => {
    const nonPng = writeIndexedImage('Final/not-png.jpg');
    await expect(processingService.editWorkflowPrompts(project.id, [nonPng.id], {
      positive: { rules: [{ type: 'append', text: 'x' }] },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE_TYPE' });

    const missing = assetRepository.upsert(project.id, 'Final/missing.png', {
      categoryId: finalCategory.id,
      nestedPath: '',
      filename: 'missing.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });
    await expect(processingService.editWorkflowPrompts(project.id, [missing.id], {
      positive: { rules: [{ type: 'append', text: 'x' }] },
    })).rejects.toMatchObject({ code: 'SOURCE_MISSING' });

    const otherProject = projectService.create(validProjectInput({ title: 'Foreign Prompt Project' }));
    const foreign = assetRepository.upsert(otherProject.id, 'Final/foreign.png', {
      categoryId: null,
      nestedPath: '',
      filename: 'foreign.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });
    await expect(processingService.editWorkflowPrompts(project.id, [foreign.id], {
      positive: { rules: [{ type: 'append', text: 'x' }] },
    })).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });

    const directoryAsset = assetRepository.upsert(project.id, 'Final/directory.png', {
      categoryId: finalCategory.id,
      nestedPath: '',
      filename: 'directory.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 0,
      modifiedAt: null,
    });
    fs.mkdirSync(path.join(projectDir, 'Final', 'directory.png'));
    await expect(processingService.editWorkflowPrompts(project.id, [directoryAsset.id], {
      positive: { rules: [{ type: 'append', text: 'x' }] },
    })).rejects.toMatchObject({ code: 'SOURCE_NOT_REGULAR' });
  });

  it('rejects a final symlink source where the platform permits symlinks', async () => {
    const source = writeIndexedPromptPng('Final/symlink.png', 'parameters', 'prompt');
    const realPath = path.join(projectDir, 'Final', 'real-prompt.png');
    fs.renameSync(path.join(projectDir, 'Final', 'symlink.png'), realPath);
    try {
      fs.symlinkSync('real-prompt.png', path.join(projectDir, 'Final', 'symlink.png'));
    } catch {
      return;
    }

    await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
      positive: { rules: [{ type: 'append', text: 'x' }] },
    })).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });

  it('leaves the original intact when staged writing fails', async () => {
    const source = writeIndexedPromptPng('Final/stage-failure.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'stage-failure.png');
    const before = fs.readFileSync(target);
    const originalWriteFile = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('.creatorcrate-workflow-prompts-')) {
        throw new Error('injected staged write failure');
      }
      return originalWriteFile.call(fs, file, ...args);
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      writeSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('rolls back replaced files when the asset metadata update fails', async () => {
    const source = writeIndexedPromptPng('Final/database-failure.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'database-failure.png');
    const before = fs.readFileSync(target);
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits')
      .mockImplementation(() => { throw new Error('injected database failure'); });

    await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
      positive: { rules: [{ type: 'append', text: ' changed' }] },
    })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

    applySpy.mockRestore();
    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id).size_bytes).toBe(before.length);
  });

  it('preflights every selected asset before mutating any source', async () => {
    const first = writeIndexedPromptPng('Final/first.png', 'parameters', 'first');
    const second = assetRepository.upsert(project.id, 'Final/second.png', {
      categoryId: finalCategory.id,
      nestedPath: '',
      filename: 'second.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1,
      modifiedAt: null,
    });
    const firstPath = path.join(projectDir, 'Final', 'first.png');
    const before = fs.readFileSync(firstPath);

    await expect(processingService.editWorkflowPrompts(project.id, [first.id, second.id], {
      positive: { rules: [{ type: 'append', text: ' changed' }] },
    })).rejects.toMatchObject({ code: 'SOURCE_MISSING' });

    expect(fs.readFileSync(firstPath)).toEqual(before);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'second.png'))).toBe(false);
  });

  it('uses the shared async project lock for prompt editing', async () => {
    const source = writeIndexedPromptPng('Final/prompt-lock.png', 'parameters', 'locked');

    await projectOperationCoordinator.runAsync(project.id, async () => {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: 'x' }] },
      })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      expect(fs.existsSync(path.join(projectDir, 'Final', 'prompt-lock.png'))).toBe(true);
    });
  });
});
