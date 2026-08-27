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
import { createProcessingJobService } from '../src/services/processing-job-service.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createProcessingPresetService } from '../src/services/processing-preset-service.js';
import { createWatermarkScaleMapService } from '../src/services/watermark-scale-map-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import {
  createPngChunk,
  editWorkflowPromptsInPng,
  PNG_SIGNATURE,
} from '../src/services/workflow-prompt-editor.js';

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
  let processingConcurrencyService;
  let processingExecutionCapability;
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
    processingConcurrencyService = createProcessingConcurrencyService({ concurrency: 1 });
    processingExecutionCapability = Object.freeze({});
    const scopeService = createAssetProcessingScopeService({ projectRepository, assetRepository });
    planner = createAssetProcessingPlanner({
      scopeService,
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
    });
    processingService = createProcessingService();
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

  function createProcessingService(overrides = {}) {
    return createAssetProcessingService({
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator,
      processingConcurrencyService,
      alreadyCoordinatedCapability: processingExecutionCapability,
      ...overrides,
    });
  }

  function mockCifsLikePromptStats(sourcePath, {
    deviceMismatch = false,
    sizeMismatch = false,
    linkCountMismatch = false,
    replacePublishedContent = false,
    publishedIdentityOffset = () => 2000000,
  } = {}) {
    const resolvedSourcePath = path.resolve(sourcePath);
    const realLstat = fs.lstatSync.bind(fs);
    const realOpen = fs.openSync.bind(fs);
    const realFstat = fs.fstatSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    const realLink = fs.linkSync.bind(fs);
    const realUnlink = fs.unlinkSync.bind(fs);
    const descriptors = new Map();
    let published = false;

    const aliasKind = (filePath) => {
      if (typeof filePath !== 'string') return null;
      if (filePath.includes('.creatorcrate-workflow-prompts-') && filePath.endsWith('.original')) {
        return 'backup';
      }
      if (published && path.resolve(filePath) === resolvedSourcePath) return 'published';
      return null;
    };
    const divergentStats = (stats, kind) => Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      dev: deviceMismatch ? (stats.dev === 0 ? 1 : 0) : stats.dev,
      ino: stats.ino + (kind === 'backup' ? 1000000 : publishedIdentityOffset()),
      size: sizeMismatch ? stats.size + 1 : stats.size,
      nlink: linkCountMismatch ? Math.max(1, stats.nlink - 1) : stats.nlink,
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      const stats = realLstat(filePath, ...args);
      const kind = aliasKind(filePath);
      return kind ? divergentStats(stats, kind) : stats;
    });
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
      const descriptor = realOpen(filePath, ...args);
      const kind = aliasKind(filePath);
      if (kind) descriptors.set(descriptor, kind);
      return descriptor;
    });
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
      const stats = realFstat(descriptor, ...args);
      const kind = descriptors.get(descriptor);
      return kind ? divergentStats(stats, kind) : stats;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
      descriptors.delete(descriptor);
      return realClose(descriptor, ...args);
    });
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((fromPath, toPath, ...args) => {
      const result = realLink(fromPath, toPath, ...args);
      if (typeof fromPath === 'string' && typeof toPath === 'string'
        && fromPath.includes('.creatorcrate-workflow-prompts-')
        && fromPath.endsWith('.png')
        && path.resolve(toPath) === resolvedSourcePath) {
        published = true;
        if (replacePublishedContent) {
          const anchor = path.join(path.dirname(resolvedSourcePath), '.prompt-cifs-content-anchor');
          const size = realLstat(toPath).size;
          realUnlink(toPath);
          fs.writeFileSync(anchor, Buffer.alloc(size, 0x7f));
          realLink(anchor, toPath);
        }
      }
      return result;
    });
    return () => {
      linkSpy.mockRestore();
      closeSpy.mockRestore();
      fstatSpy.mockRestore();
      openSpy.mockRestore();
      lstatSpy.mockRestore();
    };
  }

  function createControlledSharp(onStage) {
    return (input) => {
      const label = input.toString();
      if (label.startsWith('source:')) {
        return {
          webp() {
            return { toBuffer: () => onStage(label) };
          },
        };
      }
      if (label.startsWith('output:')) {
        return { metadata: async () => ({ format: 'webp' }) };
      }
      throw new Error(`Unexpected controlled Sharp input: ${label}`);
    };
  }

  it('converts a selected image to WebP and keeps the original indexed row', async () => {
    const source = writeIndexedImage('Final/render.png');
    const progress = [];

    const result = await processingService.convertAssets(project.id, [source.id], {
      format: 'webp',
      quality: 85,
      originalHandling: 'keep',
    }, (snapshot) => progress.push(snapshot));

    expect(progress).toEqual([{ completed: 0, total: 1 }, { completed: 1, total: 1 }]);

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

  it('uses the injected bounded pool for disjoint Convert staging while preserving plan order', async () => {
    const first = writeIndexedBuffer('Final/first.png', Buffer.from('source:first'), 'image/png');
    const second = writeIndexedBuffer('Final/second.png', Buffer.from('source:second'), 'image/png');
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const injectedPool = {
      concurrency: bounded.concurrency,
      mapBounded: vi.fn((items, worker) => bounded.mapBounded(items, worker)),
    };
    const deferred = new Map();
    const started = [];
    let activeWorkers = 0;
    let maxActive = 0;
    let resolveBothStarted;
    const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve; });

    processingService = createProcessingService({
      processingConcurrencyService: injectedPool,
      sharpImplementation: createControlledSharp((label) => new Promise((resolve) => {
        started.push(label);
        activeWorkers += 1;
        maxActive = Math.max(maxActive, activeWorkers);
        deferred.set(label, (output) => {
          deferred.delete(label);
          activeWorkers -= 1;
          resolve(output);
        });
        if (started.length === 2) resolveBothStarted();
      })),
    });

    const progress = [];
    const operation = processingService.convertAssets(project.id, [first.id, second.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    }, (snapshot) => progress.push(snapshot));

    await bothStarted;
    expect(injectedPool.mapBounded).toHaveBeenCalledTimes(1);
    expect(started).toEqual(['source:first', 'source:second']);
    expect(maxActive).toBe(2);
    expect(maxActive).toBeLessThanOrEqual(injectedPool.concurrency);

    deferred.get('source:second')(Buffer.from('output:second'));
    deferred.get('source:first')(Buffer.from('output:first'));

    const result = await operation;
    expect(result.assets.map((asset) => asset.relative_path)).toEqual([
      'Final/first.webp',
      'Final/second.webp',
    ]);
    expect(result.convertedAssetIds).toEqual(result.assets.map((asset) => asset.id));
    expect(progress).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
  });

  it('keeps Convert staging serial and in plan order with concurrency one', async () => {
    const first = writeIndexedBuffer('Final/serial-first.png', Buffer.from('source:serial-first'), 'image/png');
    const second = writeIndexedBuffer('Final/serial-second.png', Buffer.from('source:serial-second'), 'image/png');
    const staged = [];

    processingService = createProcessingService({
      sharpImplementation: createControlledSharp(async (label) => {
        staged.push(label);
        return Buffer.from(`output:${label.slice('source:'.length)}`);
      }),
    });

    const result = await processingService.convertAssets(project.id, [first.id, second.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    });

    expect(processingConcurrencyService.concurrency).toBe(1);
    expect(staged).toEqual(['source:serial-first', 'source:serial-second']);
    expect(result.assets.map((asset) => asset.relative_path)).toEqual([
      'Final/serial-first.webp',
      'Final/serial-second.webp',
    ]);
  });

  it('drains active Convert staging workers before rollback after a staging failure', async () => {
    const failing = writeIndexedBuffer('Final/failing.png', Buffer.from('source:failing'), 'image/png');
    const active = writeIndexedBuffer('Final/active.png', Buffer.from('source:active'), 'image/png');
    const unstarted = writeIndexedBuffer('Final/unstarted.png', Buffer.from('source:unstarted'), 'image/png');
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const deferred = new Map();
    const started = [];
    let resolveInitialWorkers;
    const initialWorkers = new Promise((resolve) => { resolveInitialWorkers = resolve; });

    processingService = createProcessingService({
      processingConcurrencyService: bounded,
      sharpImplementation: createControlledSharp((label) => new Promise((resolve, reject) => {
        started.push(label);
        if (started.length === 2) resolveInitialWorkers();
        deferred.set(label, { resolve, reject });
      })),
    });

    const operation = processingService.convertAssets(project.id, [failing.id, active.id, unstarted.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    });
    let settled = false;
    operation.finally(() => { settled = true; }).catch(() => {});

    await initialWorkers;
    expect(started).toEqual(['source:failing', 'source:active']);
    deferred.get('source:failing').reject(new Error('injected staging failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['source:failing', 'source:active']);
    expect(settled).toBe(false);
    expect(fs.readdirSync(projectDir).some((entry) => entry.startsWith('.creatorcrate-convert-'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'active.webp'))).toBe(false);

    deferred.get('source:active').resolve(Buffer.from('output:active'));
    await expect(operation).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    expect(started).toEqual(['source:failing', 'source:active']);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'failing.webp'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'active.webp'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'unstarted.webp'))).toBe(false);
    expect(fs.readdirSync(projectDir).some((entry) => entry.startsWith('.creatorcrate-convert-'))).toBe(false);
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
    const applicationLogger = createApplicationLogger({ repository: createApplicationLogRepository(db) });
    processingService = createProcessingService({ applicationLogger });
    const source = writeIndexedImage('Final/recovery.png');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
      .mockImplementation(() => { throw new Error('injected database failure'); });

    const executor = processingService.createAlreadyCoordinatedExecutor(processingExecutionCapability);
    const onProgress = vi.fn();
    onProgress.jobId = 'job-recovery';
    await expect(executor.convertAssets(project.id, [source.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    }, onProgress)).rejects.toMatchObject({
      name: 'AssetProcessingError',
      code: 'DATABASE_OPERATION_FAILED',
    });

    applySpy.mockRestore();
    expect(fs.existsSync(path.join(projectDir, 'Final', 'recovery.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'recovery.webp'))).toBe(false);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/recovery.webp')).toBeUndefined();
    const recoveryLog = db.prepare("SELECT subsystem, event, project_id, correlation_id, context_json FROM application_logs WHERE event = 'processing.recovery.succeeded'").get();
    expect(recoveryLog).toMatchObject({
      subsystem: 'processing', event: 'processing.recovery.succeeded', project_id: project.id,
      correlation_id: 'job-recovery',
    });
    expect(JSON.parse(recoveryLog.context_json)).toEqual({ operation: 'convert', assetCount: 1, phase: 'rollback' });
  });

  it('records a failed recovery without allowing diagnostic persistence to change the result', async () => {
    const applicationLogger = { warn: vi.fn(), error: vi.fn(() => { throw new Error('diagnostic sink unavailable'); }) };
    processingService = createProcessingService({ applicationLogger });
    const source = writeIndexedImage('Final/recovery-failed.png');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
      .mockImplementation(() => { throw new Error('injected database failure'); });
    const originalUnlink = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (String(target).endsWith('recovery-failed.webp')) throw new Error('injected recovery cleanup failure');
      return originalUnlink.call(fs, target, ...args);
    });
    const onProgress = vi.fn();
    onProgress.jobId = 'job-recovery-failed';

    try {
      const executor = processingService.createAlreadyCoordinatedExecutor(processingExecutionCapability);
      await expect(executor.convertAssets(project.id, [source.id], {
        format: 'webp', quality: 85, originalHandling: 'keep',
      }, onProgress)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      unlinkSpy.mockRestore();
      applySpy.mockRestore();
    }

    expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'processing.recovery.failed', level: 'error', kind: 'diagnostic', projectId: project.id,
      correlationId: 'job-recovery-failed', context: { operation: 'convert', assetCount: 1, phase: 'recovery' },
    }));
    expect(JSON.stringify(applicationLogger.error.mock.calls)).not.toMatch(/creatorcrate-processing|recovery-failed\.png|quality|originalHandling/i);
  });

  it('reports controlled domain errors for invalid selection and exposes the error type', async () => {
    await expect(processingService.convertAssets(project.id, [], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toBeInstanceOf(AssetProcessingError);
    await expect(processingService.convertAssets(project.id, [1], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    })).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('keeps background coordination bypass behind an unforgeable composition capability', async () => {
    const directSource = writeIndexedImage('Final/direct-capability.png');
    const backgroundSource = writeIndexedImage('Final/background-capability.png');
    const runAsync = vi.spyOn(projectOperationCoordinator, 'runAsync');

    expect(processingService).not.toHaveProperty('convertAssetsAlreadyCoordinated');
    expect(() => processingService.createAlreadyCoordinatedExecutor()).toThrow(/capability/i);
    expect(() => processingService.createAlreadyCoordinatedExecutor({})).toThrow(/capability/i);
    expect(() => processingService.createAlreadyCoordinatedExecutor(Symbol('lookalike'))).toThrow(/capability/i);
    await expect(processingService.convertAssets(project.id, [directSource.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    }, undefined, {})).rejects.toMatchObject({ code: 'INVALID_PROCESSING_COORDINATION_CAPABILITY' });
    expect(runAsync).not.toHaveBeenCalled();

    await processingService.convertAssets(project.id, [directSource.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    });
    expect(runAsync).toHaveBeenCalledTimes(1);

    const backgroundExecutor = processingService.createAlreadyCoordinatedExecutor(processingExecutionCapability);
    await backgroundExecutor.convertAssets(project.id, [backgroundSource.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    });
    expect(runAsync).toHaveBeenCalledTimes(1);
    expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
  });

  it('serializes direct processing behind the legitimate background execution path', async () => {
    const backgroundSource = writeIndexedImage('Final/background-queue.png');
    const directSource = writeIndexedImage('Final/direct-queue.png');
    const backgroundExecutor = processingService.createAlreadyCoordinatedExecutor(processingExecutionCapability);
    const processingJobService = createProcessingJobService({ projectOperationCoordinator });
    let releaseBackground;
    const backgroundGate = new Promise((resolve) => { releaseBackground = resolve; });
    const jobId = processingJobService.enqueue({
      projectId: project.id,
      execute: async ({ updateProgress }) => {
        await backgroundGate;
        return backgroundExecutor.convertAssets(project.id, [backgroundSource.id], {
          format: 'webp', quality: 85, originalHandling: 'keep',
        }, updateProgress);
      },
    });
    await Promise.resolve();

    let directSettled = false;
    const direct = processingService.convertAssets(project.id, [directSource.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    });
    void direct.then(() => { directSettled = true; }, () => { directSettled = true; });
    await Promise.resolve();
    expect(directSettled).toBe(false);
    expect(projectOperationCoordinator.isActive(project.id)).toBe(true);

    releaseBackground();
    await expect(direct).resolves.toMatchObject({ convertedCount: 1 });
    expect(processingJobService.getJob(jobId)).toMatchObject({ state: 'succeeded' });
    expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
  });

  it('queues conversion behind an active same-project operation without overlapping execution', async () => {
    const source = writeIndexedImage('Final/locked.png');

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const holder = projectOperationCoordinator.runAsync(project.id, () => gate);
    const queued = processingService.convertAssets(project.id, [source.id], {
        format: 'webp', quality: 85, originalHandling: 'keep',
      });
      expect(fs.existsSync(path.join(projectDir, 'Final', 'locked.png'))).toBe(true);
    let settled = false;
    void queued.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(projectOperationCoordinator.isActive(project.id)).toBe(true);
    release();
    await holder;
    await expect(queued).resolves.toMatchObject({ convertedCount: 1 });
    expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
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

    const progress = [];
    const result = await processingService.editWorkflowPrompts(project.id, [source.id, noWorkflow.id], {
      positive: { rules: [{ type: 'remove', text: 'not present' }] },
    }, (snapshot) => progress.push(snapshot));

    expect(progress).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);

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

  it('uses the injected bounded pool for Prompt preparation and staging with concurrency one', async () => {
    const first = writeIndexedPromptPng('Final/prompt-serial-first.png', 'parameters', 'first');
    const second = writeIndexedPromptPng('Final/prompt-serial-second.png', 'parameters', 'second');
    const targets = [first, second].map((asset) => path.resolve(projectDir, ...asset.relative_path.split('/')));
    const bounded = createProcessingConcurrencyService({ concurrency: 1 });
    const injectedPool = {
      concurrency: bounded.concurrency,
      mapBounded: vi.fn((items, worker) => bounded.mapBounded(items, worker)),
    };
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    const started = [];
    let resumeFirst;
    let resolveFirstStarted;
    const firstStarted = new Promise((resolve) => { resolveFirstStarted = resolve; });
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation((filePath, ...args) => {
      if (!targets.includes(path.resolve(String(filePath)))) return originalReadFile(filePath, ...args);
      started.push(path.resolve(String(filePath)));
      if (started.length !== 1) return originalReadFile(filePath, ...args);
      resolveFirstStarted();
      return new Promise((resolve, reject) => {
        resumeFirst = () => originalReadFile(filePath, ...args).then(resolve, reject);
      });
    });
    processingService = createProcessingService({ processingConcurrencyService: injectedPool });

    const operation = processingService.editWorkflowPrompts(project.id, [first.id, second.id], {
      positive: { rules: [{ type: 'append', text: ' changed' }] },
    });

    try {
      await firstStarted;
      await Promise.resolve();
      expect(started).toEqual([targets[0]]);
      resumeFirst();
      const result = await operation;
      expect(injectedPool.concurrency).toBe(1);
      expect(injectedPool.mapBounded).toHaveBeenCalledTimes(2);
      expect(result.changedAssetIds).toEqual([first.id, second.id]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('overlaps independent Prompt preparation reads within the configured bound', async () => {
    const first = writeIndexedPromptPng('Final/prompt-read-first.png', 'parameters', 'first');
    const second = writeIndexedPromptPng('Final/prompt-read-second.png', 'parameters', 'second');
    const targets = new Set([first, second].map((asset) => path.resolve(projectDir, ...asset.relative_path.split('/'))));
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    const deferred = new Map();
    const started = [];
    let resolveBothStarted;
    const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve; });
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation((filePath, ...args) => {
      const resolved = path.resolve(String(filePath));
      if (!targets.has(resolved)) return originalReadFile(filePath, ...args);
      return new Promise((resolve, reject) => {
        started.push(resolved);
        deferred.set(resolved, () => originalReadFile(filePath, ...args).then(resolve, reject));
        if (started.length === 2) resolveBothStarted();
      });
    });
    processingService = createProcessingService({ processingConcurrencyService: bounded });

    const operation = processingService.editWorkflowPrompts(project.id, [first.id, second.id], {
      positive: { rules: [{ type: 'append', text: ' changed' }] },
    });

    try {
      await bothStarted;
      expect(started).toHaveLength(2);
      expect(started).toEqual(expect.arrayContaining([...targets]));
      expect(started.length).toBeLessThanOrEqual(bounded.concurrency);
      deferred.forEach((resume) => resume());
      await expect(operation).resolves.toMatchObject({ changedAssetIds: [first.id, second.id] });
    } finally {
      readSpy.mockRestore();
    }
  });

  it('waits for every bounded Prompt stage write before serial publication', async () => {
    const first = writeIndexedPromptPng('Final/prompt-stage-first.png', 'parameters', 'first');
    const second = writeIndexedPromptPng('Final/prompt-stage-second.png', 'parameters', 'second');
    const targets = [first, second].map((asset) => path.resolve(projectDir, ...asset.relative_path.split('/')));
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const deferred = new Map();
    const staged = [];
    let resolveBothStaged;
    const bothStaged = new Promise((resolve) => { resolveBothStaged = resolve; });
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementation((filePath, ...args) => {
      if (!String(filePath).includes('.creatorcrate-workflow-prompts-')) {
        return originalWriteFile(filePath, ...args);
      }
      return new Promise((resolve, reject) => {
        staged.push(String(filePath));
        deferred.set(String(filePath), () => originalWriteFile(filePath, ...args).then(resolve, reject));
        if (staged.length === 2) resolveBothStaged();
      });
    });
    const publicationTargets = [];
    const realLink = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((fromPath, toPath, ...args) => {
      if (targets.includes(path.resolve(toPath))) publicationTargets.push(path.resolve(toPath));
      return realLink(fromPath, toPath, ...args);
    });
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
    processingService = createProcessingService({ processingConcurrencyService: bounded });

    const operation = processingService.editWorkflowPrompts(project.id, [first.id, second.id], {
      positive: { rules: [{ type: 'append', text: ' changed' }] },
    });

    try {
      await bothStaged;
      expect(staged).toHaveLength(2);
      expect(publicationTargets).toEqual([]);
      expect(applySpy).not.toHaveBeenCalled();
      deferred.forEach((resume) => resume());
      await operation;
    } finally {
      applySpy.mockRestore();
      linkSpy.mockRestore();
      writeSpy.mockRestore();
    }

    expect(publicationTargets).toEqual(targets);
  });

  it('drains active Prompt staging workers and leaves sources untouched after a staging failure', async () => {
    const failing = writeIndexedPromptPng('Final/prompt-stage-failing.png', 'parameters', 'failing');
    const active = writeIndexedPromptPng('Final/prompt-stage-active.png', 'parameters', 'active');
    const unstarted = writeIndexedPromptPng('Final/prompt-stage-unstarted.png', 'parameters', 'unstarted');
    const targets = [failing, active, unstarted].map((asset) => path.join(projectDir, ...asset.relative_path.split('/')));
    const before = targets.map((target) => fs.readFileSync(target));
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const stageWrites = [];
    let resumeActive;
    let resolveInitialWorkers;
    const initialWorkers = new Promise((resolve) => { resolveInitialWorkers = resolve; });
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementation((filePath, ...args) => {
      if (!String(filePath).includes('.creatorcrate-workflow-prompts-')) {
        return originalWriteFile(filePath, ...args);
      }
      const basename = path.basename(String(filePath));
      stageWrites.push(basename);
      if (stageWrites.length === 2) resolveInitialWorkers();
      if (basename === '0.png') return Promise.reject(new Error('injected Prompt stage failure'));
      if (basename === '1.png') {
        return new Promise((resolve, reject) => {
          resumeActive = () => originalWriteFile(filePath, ...args).then(resolve, reject);
        });
      }
      return originalWriteFile(filePath, ...args);
    });
    const linkSpy = vi.spyOn(fs, 'linkSync');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
    processingService = createProcessingService({ processingConcurrencyService: bounded });
    const operation = processingService.editWorkflowPrompts(project.id, [failing.id, active.id, unstarted.id], {
      positive: { rules: [{ type: 'append', text: ' changed' }] },
    });
    let settled = false;
    operation.finally(() => { settled = true; }).catch(() => {});

    try {
      await initialWorkers;
      await Promise.resolve();
      await Promise.resolve();
      expect(stageWrites).toEqual(['0.png', '1.png']);
      expect(settled).toBe(false);
      expect(linkSpy).not.toHaveBeenCalled();
      expect(applySpy).not.toHaveBeenCalled();
      targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
      resumeActive();
      await expect(operation).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      applySpy.mockRestore();
      linkSpy.mockRestore();
      writeSpy.mockRestore();
    }

    expect(stageWrites).toEqual(['0.png', '1.png']);
    targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('keeps unchanged Prompt batches out of staging after bounded preparation', async () => {
    const noChange = writeIndexedPromptPng('Final/prompt-no-change.png', 'parameters', 'unchanged');
    const noWorkflow = writeIndexedPromptPng('Final/prompt-no-workflow.png', 'comment', 'plain image');
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const injectedPool = {
      concurrency: bounded.concurrency,
      mapBounded: vi.fn((items, worker) => bounded.mapBounded(items, worker)),
    };
    const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync');
    processingService = createProcessingService({ processingConcurrencyService: injectedPool });

    try {
      const result = await processingService.editWorkflowPrompts(project.id, [noChange.id, noWorkflow.id], {
        positive: { rules: [{ type: 'remove', text: 'not present' }] },
      });
      expect(result).toMatchObject({ changedCount: 0, unchangedAssetIds: [noChange.id, noWorkflow.id] });
    } finally {
      mkdtempSpy.mockRestore();
    }

    expect(injectedPool.mapBounded).toHaveBeenCalledTimes(1);
    expect(mkdtempSpy).not.toHaveBeenCalled();
  });

  it('preserves request order while excluding unchanged Prompt items from staging and publication', async () => {
    const first = writeIndexedPromptPng('Final/prompt-mixed-first.png', 'parameters', 'first');
    const unchanged = writeIndexedPromptPng('Final/prompt-mixed-unchanged.png', 'comment', 'plain image');
    const third = writeIndexedPromptPng('Final/prompt-mixed-third.png', 'parameters', 'third');
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    processingService = createProcessingService({ processingConcurrencyService: bounded });

    const result = await processingService.editWorkflowPrompts(project.id, [first.id, unchanged.id, third.id], {
      positive: { rules: [{ type: 'append', text: ' changed' }] },
    });

    expect(result.changedAssetIds).toEqual([first.id, third.id]);
    expect(result.unchangedAssetIds).toEqual([unchanged.id]);
    expect(result.assets.map((asset) => asset.id)).toEqual([first.id, third.id]);
  });

  it('preserves Prompt PNG output bytes while changing only scheduling and I/O', async () => {
    const source = writeIndexedPromptPng('Final/prompt-output-parity.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'prompt-output-parity.png');
    const options = { positive: { rules: [{ type: 'append', text: ' changed' }] } };
    const expected = editWorkflowPromptsInPng(fs.readFileSync(target), options).buffer;

    await processingService.editWorkflowPrompts(project.id, [source.id], options);

    expect(fs.readFileSync(target)).toEqual(expected);
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
    const originalWriteFile = fs.promises.writeFile;
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementation((file, ...args) => {
      if (String(file).includes('.creatorcrate-workflow-prompts-')) {
        return Promise.reject(new Error('injected staged write failure'));
      }
      return originalWriteFile.call(fs.promises, file, ...args);
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

  it('restores three Prompt publications in reverse order and removes verified rollback artifacts', async () => {
    const sources = ['first', 'second', 'third'].map((name) => writeIndexedPromptPng(
      `Final/multi-publication-${name}.png`,
      'parameters',
      `original-${name}`,
    ));
    const targets = sources.map((source) => path.join(projectDir, ...source.relative_path.split('/')));
    const before = targets.map((target) => fs.readFileSync(target));
    const metadata = sources.map((source) => ({
      id: source.id,
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
    }));
    const realLstat = fs.lstatSync.bind(fs);
    const realLink = fs.linkSync.bind(fs);
    const restorationOrder = [];
    let thirdPublished = false;
    let verificationFailed = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((fromPath, toPath, ...args) => {
      if (path.resolve(toPath) === path.resolve(targets[2]) && String(fromPath).endsWith('.png')) {
        thirdPublished = true;
      }
      if (String(fromPath).endsWith('.original') && targets.some((target) => path.resolve(target) === path.resolve(toPath))) {
        restorationOrder.push(path.basename(toPath));
      }
      return realLink(fromPath, toPath, ...args);
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (thirdPublished && !verificationFailed && path.resolve(filePath) === path.resolve(targets[2])) {
        verificationFailed = true;
        throw new Error('injected post-publication verification failure');
      }
      return realLstat(filePath, ...args);
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, sources.map(({ id }) => id), {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(restorationOrder).toEqual([
      path.basename(targets[2]), path.basename(targets[1]), path.basename(targets[0]),
    ]);
    targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
    metadata.forEach((expected) => expect(assetRepository.findById(expected.id)).toMatchObject(expected));
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('restores every published Prompt in reverse order after a multi-asset database failure', async () => {
    processingService = createProcessingService({
      processingConcurrencyService: createProcessingConcurrencyService({ concurrency: 2 }),
    });
    const sources = ['first', 'second', 'third'].map((name) => writeIndexedPromptPng(
      `Final/multi-database-${name}.png`,
      'parameters',
      `original-${name}`,
    ));
    const targets = sources.map((source) => path.join(projectDir, ...source.relative_path.split('/')));
    const before = targets.map((target) => fs.readFileSync(target));
    const metadata = sources.map((source) => ({ id: source.id, size_bytes: source.size_bytes, modified_at: source.modified_at }));
    const realLink = fs.linkSync.bind(fs);
    const restorationOrder = [];
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((fromPath, toPath, ...args) => {
      if (String(fromPath).endsWith('.original') && targets.some((target) => path.resolve(target) === path.resolve(toPath))) {
        restorationOrder.push(path.basename(toPath));
      }
      return realLink(fromPath, toPath, ...args);
    });
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits')
      .mockImplementation(() => { throw new Error('injected multi-asset database failure'); });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, sources.map(({ id }) => id), {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    } finally {
      applySpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(restorationOrder).toEqual([
      path.basename(targets[2]), path.basename(targets[1]), path.basename(targets[0]),
    ]);
    targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
    metadata.forEach((expected) => expect(assetRepository.findById(expected.id)).toMatchObject(expected));
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('preserves the trusted Prompt backup when an unexpected replacement makes restoration uncertain', async () => {
    const source = writeIndexedPromptPng('Final/uncertain-restoration.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'uncertain-restoration.png');
    const before = fs.readFileSync(target);
    const unexpected = Buffer.from('unexpected replacement');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
      fs.unlinkSync(target);
      fs.writeFileSync(target, unexpected);
      throw new Error('injected database failure after replacement changed');
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      applySpy.mockRestore();
    }

    const staging = fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-'));
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(target)).toEqual(unexpected);
    expect(fs.readFileSync(path.join(projectDir, staging[0], '0.original'))).toEqual(before);
    expect(assetRepository.findById(source.id)).toMatchObject({ size_bytes: source.size_bytes, modified_at: source.modified_at });
  });

  it('recovers a published Prompt when post-publication ownership bookkeeping fails', async () => {
    const source = writeIndexedPromptPng('Final/published-recovery.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'published-recovery.png');
    const before = fs.readFileSync(target);
    const realLstat = fs.lstatSync.bind(fs);
    const realLink = fs.linkSync.bind(fs);
    let published = false;
    let verificationFailed = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((fromPath, toPath, ...args) => {
      if (String(fromPath).endsWith('.png') && path.resolve(toPath) === path.resolve(target)) published = true;
      return realLink(fromPath, toPath, ...args);
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (published && !verificationFailed && path.resolve(filePath) === path.resolve(target)) {
        verificationFailed = true;
        throw new Error('injected output inspection failure');
      }
      return realLstat(filePath, ...args);
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id)).toMatchObject({ size_bytes: source.size_bytes, modified_at: source.modified_at });
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('cleans verified Prompt artifacts and preserves the underlying error when source mutation cannot begin', async () => {
    const source = writeIndexedPromptPng('Final/pre-mutation-failure.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'pre-mutation-failure.png');
    const before = fs.readFileSync(target);
    const realUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
      if (path.resolve(filePath) === path.resolve(target)) throw new Error('injected source unlink failure');
      return realUnlink(filePath, ...args);
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('captures and cleans a Prompt stage output created before normal bookkeeping fails', async () => {
    const source = writeIndexedPromptPng('Final/late-stage-capture.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'late-stage-capture.png');
    const before = fs.readFileSync(target);
    const realLstat = fs.lstatSync.bind(fs);
    let failed = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (!failed && String(filePath).includes('.creatorcrate-workflow-prompts-') && String(filePath).endsWith('.png')) {
        failed = true;
        throw new Error('injected stage bookkeeping failure');
      }
      return realLstat(filePath, ...args);
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'PROMPT_STAGE_INVALID' });
    } finally {
      lstatSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('captures and cleans a Prompt backup created before normal bookkeeping fails', async () => {
    const source = writeIndexedPromptPng('Final/late-backup-capture.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'late-backup-capture.png');
    const before = fs.readFileSync(target);
    const realLstat = fs.lstatSync.bind(fs);
    let failed = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (!failed && String(filePath).includes('.creatorcrate-workflow-prompts-') && String(filePath).endsWith('.original')) {
        failed = true;
        throw new Error('injected backup bookkeeping failure');
      }
      return realLstat(filePath, ...args);
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'PROMPT_BACKUP_INVALID' });
    } finally {
      lstatSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('edits Workflow Prompt files through verified hard-link fallback when CIFS aliases diverge', async () => {
    const source = writeIndexedPromptPng('Final/cifs-prompt.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'cifs-prompt.png');
    const restoreCifsStats = mockCifsLikePromptStats(target);

    try {
      const result = await processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      });
      expect(result).toMatchObject({ status: 'completed', changedCount: 1, changedAssetIds: [source.id] });
    } finally {
      restoreCifsStats();
    }

    expect(fs.readFileSync(target).includes(Buffer.from('original changed'))).toBe(true);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('uses strict Prompt hard-link verification without fallback hashing when alias identities match', async () => {
    const source = writeIndexedPromptPng('Final/strict-prompt.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'strict-prompt.png');
    const realOpen = fs.openSync.bind(fs);
    let sourceOpenCount = 0;
    let backupOpenCount = 0;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
      if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(target)) {
        sourceOpenCount += 1;
      }
      if (typeof filePath === 'string' && filePath.endsWith('.original')) {
        backupOpenCount += 1;
      }
      return realOpen(filePath, ...args);
    });

    try {
      await processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      });
    } finally {
      openSpy.mockRestore();
    }

    expect(sourceOpenCount).toBe(1);
    expect(backupOpenCount).toBe(0);
    expect(fs.readFileSync(target).includes(Buffer.from('original changed'))).toBe(true);
  });

  it('retains verified-hard-link Prompt staging evidence for a later rollback after the published inode changes', async () => {
    const sources = ['first', 'second'].map((name) => writeIndexedPromptPng(
      `Final/cifs-retained-${name}.png`,
      'parameters',
      `original-${name}`,
    ));
    const targets = sources.map((source) => path.join(projectDir, ...source.relative_path.split('/')));
    const before = targets.map((target) => fs.readFileSync(target));
    const metadata = sources.map((source) => ({
      id: source.id,
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
    }));
    let publishedIdentityOffset = 2000000;
    const restoreCifsStats = mockCifsLikePromptStats(targets[0], {
      publishedIdentityOffset: () => publishedIdentityOffset,
    });
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
      publishedIdentityOffset = 3000000;
      throw new Error('injected database failure after CIFS identity changed');
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, sources.map(({ id }) => id), {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    } finally {
      applySpy.mockRestore();
      restoreCifsStats();
    }

    targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
    metadata.forEach((expected) => expect(assetRepository.findById(expected.id)).toMatchObject(expected));
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('does not claim or delete a foreign Prompt stage output after an EEXIST collision', async () => {
    const source = writeIndexedPromptPng('Final/foreign-stage-collision.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'foreign-stage-collision.png');
    const before = fs.readFileSync(target);
    const foreign = Buffer.from('foreign staged output');
    const realMkdtemp = fs.mkdtempSync.bind(fs);
    let foreignPath;
    const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, ...args) => {
      const directory = realMkdtemp(prefix, ...args);
      foreignPath = path.join(directory, '0.png');
      fs.writeFileSync(foreignPath, foreign);
      return directory;
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      mkdtempSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readFileSync(foreignPath)).toEqual(foreign);
  });

  it('does not claim or delete a foreign Prompt backup after an EEXIST collision', async () => {
    const source = writeIndexedPromptPng('Final/foreign-backup-collision.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'foreign-backup-collision.png');
    const before = fs.readFileSync(target);
    const foreign = Buffer.from('foreign original backup');
    const realMkdtemp = fs.mkdtempSync.bind(fs);
    let foreignPath;
    const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, ...args) => {
      const directory = realMkdtemp(prefix, ...args);
      foreignPath = path.join(directory, '0.original');
      fs.writeFileSync(foreignPath, foreign);
      return directory;
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      mkdtempSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readFileSync(foreignPath)).toEqual(foreign);
  });

  it('fails closed when strict Prompt publication content changes after identity verification', async () => {
    const source = writeIndexedPromptPng('Final/strict-publication-content.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'strict-publication-content.png');
    const before = fs.readFileSync(target);
    const realLink = fs.linkSync.bind(fs);
    const realOpen = fs.openSync.bind(fs);
    let published = false;
    let mutated = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((fromPath, toPath, ...args) => {
      const result = realLink(fromPath, toPath, ...args);
      if (String(fromPath).endsWith('.png') && path.resolve(toPath) === path.resolve(target)) published = true;
      return result;
    });
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
      if (published && !mutated && path.resolve(filePath) === path.resolve(target)) {
        mutated = true;
        fs.writeFileSync(filePath, Buffer.alloc(fs.statSync(filePath).size, 0x7f));
      }
      return realOpen(filePath, ...args);
    });
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(mutated).toBe(true);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id)).toMatchObject({
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
    });
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('fails closed for a CIFS-like Prompt alias on the wrong device', async () => {
    const source = writeIndexedPromptPng('Final/cifs-device-prompt.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'cifs-device-prompt.png');
    const before = fs.readFileSync(target);
    const restoreCifsStats = mockCifsLikePromptStats(
      path.join(projectDir, 'Final', 'cifs-device-prompt.png'),
      { deviceMismatch: true },
    );

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      restoreCifsStats();
    }
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('fails closed for a CIFS-like Prompt alias with the wrong size', async () => {
    const source = writeIndexedPromptPng('Final/cifs-size-prompt.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'cifs-size-prompt.png');
    const before = fs.readFileSync(target);
    const restoreCifsStats = mockCifsLikePromptStats(
      path.join(projectDir, 'Final', 'cifs-size-prompt.png'),
      { sizeMismatch: true },
    );

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      restoreCifsStats();
    }
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('fails closed for a CIFS-like Prompt alias with the wrong link count', async () => {
    const source = writeIndexedPromptPng('Final/cifs-link-count-prompt.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'cifs-link-count-prompt.png');
    const before = fs.readFileSync(target);
    const restoreCifsStats = mockCifsLikePromptStats(
      path.join(projectDir, 'Final', 'cifs-link-count-prompt.png'),
      { linkCountMismatch: true },
    );

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      restoreCifsStats();
    }
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
  });

  it('fails closed for a CIFS-like Prompt alias with changed content', async () => {
    const source = writeIndexedPromptPng('Final/cifs-content-prompt.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'cifs-content-prompt.png');
    const restoreCifsStats = mockCifsLikePromptStats(target, { replacePublishedContent: true });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      restoreCifsStats();
      fs.rmSync(path.join(projectDir, 'Final', '.prompt-cifs-content-anchor'), { force: true });
    }
  });

  it('uses the generalized verifier to restore a Prompt backup after a database failure', async () => {
    const source = writeIndexedPromptPng('Final/cifs-restore-prompt.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'cifs-restore-prompt.png');
    const before = fs.readFileSync(target);
    const restoreCifsStats = mockCifsLikePromptStats(target);
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits')
      .mockImplementation(() => { throw new Error('injected database failure'); });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    } finally {
      applySpy.mockRestore();
      restoreCifsStats();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-workflow-prompts-')))
      .toEqual([]);
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

  it('queues prompt editing behind an active same-project operation without overlapping execution', async () => {
    const source = writeIndexedPromptPng('Final/prompt-lock.png', 'parameters', 'locked');

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const holder = projectOperationCoordinator.runAsync(project.id, () => gate);
    const queued = processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: 'x' }] },
      });
      expect(fs.existsSync(path.join(projectDir, 'Final', 'prompt-lock.png'))).toBe(true);
    let settled = false;
    void queued.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(projectOperationCoordinator.isActive(project.id)).toBe(true);
    release();
    await holder;
    await expect(queued).resolves.toMatchObject({ status: 'completed', changedCount: 1 });
    expect(projectOperationCoordinator.isActive(project.id)).toBe(false);
  });



});
