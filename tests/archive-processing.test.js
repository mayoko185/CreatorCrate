import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createGeneratedArtifactRepository } from '../src/data/generated-artifact-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createAssetProcessingPlanner } from '../src/services/asset-processing-planner.js';
import { createAssetProcessingService } from '../src/services/asset-processing-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { read7zArchiveEntries } from '../src/services/watermark-7z.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title = 'Archive Project') {
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

async function makeImage({ width = 100, height = 60, format = 'png' } = {}) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 100, b: 180, alpha: 1 },
    },
  })[format]({ quality: format === 'jpeg' || format === 'webp' ? 90 : undefined }).toBuffer();
}

async function makeWatermark() {
  return sharp({
    create: {
      width: 20,
      height: 15,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0.8 },
    },
  }).png().toBuffer();
}

function readZipEntries(filePath) {
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('standalone archive processing', () => {
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
  let processingService;
  let processingConcurrencyService;
  let planner;

  function makeProcessingService(overrides = {}) {
    return createAssetProcessingService({
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: createProjectOperationCoordinator(),
      processingConcurrencyService,
      watermarkPath: path.join(tmpDir, 'watermark.png'),
      watermarkRoot: tmpDir,
      ...overrides,
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-archive-'));
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
    projectDir = path.join(projectsRoot, project.project_dir);
    finalCategory = categoryRepository.listProjectCategories(project.id)
      .find((category) => category.directory_slug === 'final');

    processingConcurrencyService = createProcessingConcurrencyService({ concurrency: 1 });
    processingService = makeProcessingService();
    fs.writeFileSync(path.join(tmpDir, 'watermark.png'), await makeWatermark());

    const scopeService = createAssetProcessingScopeService({
      projectRepository,
      assetRepository,
    });
    planner = createAssetProcessingPlanner({
      scopeService,
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      sharpImplementation: () => {
        throw new Error('Planner must not initialize an image runtime.');
      },
    });
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeIndexedImage(relativePath, { format = 'png' } = {}) {
    const normalized = relativePath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalized);
    const target = path.join(projectDir, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = await makeImage({ width: 240, height: 120, format });
    fs.writeFileSync(target, bytes);
    const stats = fs.statSync(target);
    return assetRepository.upsert(project.id, normalized, {
      categoryId: normalized.toLowerCase().startsWith('final/') ? finalCategory.id : null,
      nestedPath: '',
      filename,
      extension: filename.slice(filename.lastIndexOf('.') + 1).toLowerCase(),
      mimeType: format === 'jpg' ? 'image/jpeg' : 'image/' + format,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  it('plans selected and project scopes without mutation or WASM initialization', async () => {
    const selected = await writeIndexedImage('Final/nested/cover.png');
    const other = await writeIndexedImage('Final/other.webp', { format: 'webp' });

    const selectedPlan = planner.planArchives(
      project.id,
      { type: 'selected', assetIds: [selected.id] },
      { archiveFormat: '7z', makeCbz: true, setName: 'Preview' },
    );
    expect(selectedPlan).toMatchObject({
      operation: 'archive',
      sourceCount: 1,
      entryCount: 3,
      counts: { eligible: 1, conflicts: 0 },
      operationBlockers: [],
    });
    expect(selectedPlan.archives.map((archive) => archive.containerFormat)).toEqual(['7z', '7z', 'zip']);
    expect(selectedPlan.archives.map((archive) => archive.entryNames)).toEqual([
      ['Final/nested/cover.jpg'],
      ['Final/nested/cover.webp'],
      ['Final/nested/cover.jpg'],
    ]);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
    expect(fs.readdirSync(path.join(projectDir, 'Final', 'nested'))).toEqual(['cover.png']);

    const projectPlan = planner.planArchives(
      project.id,
      { type: 'directory', relativePath: '', recursive: true },
      { makeArchives: true },
    );
    expect(projectPlan.sourceCount).toBe(2);
    expect(projectPlan.entryCount).toBe(4);
    expect(projectPlan.archives[0].entryNames).toEqual([
      'Final/nested/cover.jpg',
      'Final/other.jpg',
    ]);
    expect(other).toBeDefined();
  });

  it('creates JPEG/WebP pairs and CBZ with POSIX entries while preserving sources', async () => {
    const png = await writeIndexedImage('Final/nested/cover.png');
    const webp = await writeIndexedImage('Final/second/image.webp', { format: 'webp' });
    const before = new Map([
      ['Final/nested/cover.png', fs.readFileSync(path.join(projectDir, 'Final/nested/cover.png'))],
      ['Final/second/image.webp', fs.readFileSync(path.join(projectDir, 'Final/second/image.webp'))],
    ]);

    const progress = [];
    const result = await processingService.createArchives(project.id, [png.id, webp.id], {
      makeCbz: true,
      setName: 'Standalone',
      zipJpgQuality: 71,
      zipWebpQuality: 83,
      cbzJpgQuality: 65,
    }, (snapshot) => progress.push(snapshot));

    expect(progress).toEqual([
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);

    expect(result).toMatchObject({
      status: 'completed',
      operation: 'archives',
      requestedCount: 2,
      sourceCount: 2,
      generatedCount: 3,
    });
    expect(result.artifacts.map((artifact) => ({
      relativePath: artifact.relativePath,
      format: artifact.format,
      containerFormat: artifact.containerFormat,
      quality: artifact.quality,
      entryCount: artifact.entryCount,
    }))).toEqual([
      { relativePath: 'Standalone_jpg_q71.zip', format: 'zip', containerFormat: 'zip', quality: 71, entryCount: 2 },
      { relativePath: 'Standalone_webp_q83.zip', format: 'zip', containerFormat: 'zip', quality: 83, entryCount: 2 },
      { relativePath: 'Standalone_jpg_q65.cbz', format: 'cbz', containerFormat: 'zip', quality: 65, entryCount: 2 },
    ]);

    const jpgEntries = await readZipEntries(path.join(projectDir, 'Standalone_jpg_q71.zip'));
    const webpEntries = await readZipEntries(path.join(projectDir, 'Standalone_webp_q83.zip'));
    const cbzEntries = await readZipEntries(path.join(projectDir, 'Standalone_jpg_q65.cbz'));
    expect(jpgEntries.map((entry) => entry.name)).toEqual(['Final/nested/cover.jpg', 'Final/second/image.jpg']);
    expect(webpEntries.map((entry) => entry.name)).toEqual(['Final/nested/cover.webp', 'Final/second/image.webp']);
    expect(cbzEntries.map((entry) => entry.name)).toEqual(['Final/nested/cover.jpg', 'Final/second/image.jpg']);
    expect((await sharp(jpgEntries[0].data).metadata()).format).toBe('jpeg');
    expect((await sharp(webpEntries[0].data).metadata()).format).toBe('webp');
    expect((await sharp(cbzEntries[0].data).metadata()).format).toBe('jpeg');

    const cbzSevenResult = await processingService.createArchives(project.id, [png.id], {
      makeArchives: false,
      makeCbz: true,
      archiveFormat: '7z',
      setName: 'CBZ seven',
    });
    expect(cbzSevenResult.artifacts).toMatchObject([
      { format: 'cbz', containerFormat: 'zip', relativePath: 'CBZ seven_jpg_q85.cbz' },
    ]);
    const cbzSevenEntries = await readZipEntries(path.join(projectDir, 'CBZ seven_jpg_q85.cbz'));
    expect(cbzSevenEntries.map((entry) => entry.name)).toEqual(['Final/nested/cover.jpg']);

    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relative_path: 'Standalone_jpg_q71.zip',
        kind: 'archive-jpg',
        generated_by: 'archives',
        generated_mode: 'standalone',
        generated_watermark_id: null,
        sha256: sha256(fs.readFileSync(path.join(projectDir, 'Standalone_jpg_q71.zip'))),
      }),
    ]));
    for (const [relativePath, bytes] of before) {
      expect(fs.readFileSync(path.join(projectDir, ...relativePath.split('/')))).toEqual(bytes);
    }
  });

  it('uses the shared bounded pool for archive-entry staging and keeps member order deterministic', async () => {
    const first = await writeIndexedImage('Final/first.png');
    const second = await writeIndexedImage('Final/second.png');
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    let mapBoundedCalls = 0;
    const injectedPool = {
      mapBounded(...args) {
        mapBoundedCalls += 1;
        return bounded.mapBounded(...args);
      },
    };
    const deferred = [];
    let resolveBothStarted;
    const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve; });
    let started = 0;
    let active = 0;
    let observedConcurrency = 0;
    const stageEntry = () => {
      const entryIndex = started;
      started += 1;
      active += 1;
      observedConcurrency = Math.max(observedConcurrency, active);
      return new Promise((resolve) => {
        deferred[entryIndex] = () => {
          active -= 1;
          resolve(Buffer.from(`entry-${entryIndex}`));
        };
        if (entryIndex === 1) resolveBothStarted();
      });
    };
    const controlledSharp = () => ({
      rotate() {
        return {
          jpeg() { return { toBuffer: stageEntry }; },
          webp() { return { toBuffer: stageEntry }; },
        };
      },
    });
    const service = makeProcessingService({
      processingConcurrencyService: injectedPool,
      sharpImplementation: controlledSharp,
    });
    const progress = [];
    const operation = service.createArchives(project.id, [first.id, second.id], {
      makeArchives: false,
      makeCbz: true,
      setName: 'Ordered',
    }, (snapshot) => progress.push(snapshot));

    await bothStarted;
    expect(mapBoundedCalls).toBe(1);
    expect(observedConcurrency).toBe(2);
    expect(observedConcurrency).toBeLessThanOrEqual(2);

    deferred[1]();
    deferred[0]();
    const result = await operation;
    const entries = await readZipEntries(path.join(projectDir, result.artifacts[0].relativePath));

    expect(progress).toEqual([{ completed: 0, total: 1 }, { completed: 1, total: 1 }]);
    expect(entries.map((entry) => entry.name)).toEqual(['Final/first.jpg', 'Final/second.jpg']);
    expect(entries.map((entry) => entry.data.toString())).toEqual(['entry-0', 'entry-1']);
  });

  it('keeps archive-entry staging serial and in plan order with concurrency one', async () => {
    const first = await writeIndexedImage('Final/first.png');
    const second = await writeIndexedImage('Final/second.png');
    const bounded = createProcessingConcurrencyService({ concurrency: 1 });
    const calls = [];
    let active = 0;
    let observedConcurrency = 0;
    const stageEntry = async () => {
      const entryIndex = calls.filter((call) => call.startsWith('start')).length;
      calls.push(`start-${entryIndex}`);
      active += 1;
      observedConcurrency = Math.max(observedConcurrency, active);
      await Promise.resolve();
      active -= 1;
      calls.push(`finish-${entryIndex}`);
      return Buffer.from(`entry-${entryIndex}`);
    };
    const service = makeProcessingService({
      processingConcurrencyService: bounded,
      sharpImplementation: () => ({
        rotate() {
          return {
            jpeg() { return { toBuffer: stageEntry }; },
            webp() { return { toBuffer: stageEntry }; },
          };
        },
      }),
    });

    const result = await service.createArchives(project.id, [first.id, second.id], {
      makeArchives: false,
      makeCbz: true,
      setName: 'Serial',
    });
    const entries = await readZipEntries(path.join(projectDir, result.artifacts[0].relativePath));

    expect(observedConcurrency).toBe(1);
    expect(calls).toEqual(['start-0', 'finish-0', 'start-1', 'finish-1']);
    expect(entries.map((entry) => entry.data.toString())).toEqual(['entry-0', 'entry-1']);
  });

  it('drains active archive-entry staging workers before rollback and preserves the original failure', async () => {
    const failing = await writeIndexedImage('Final/failing.png');
    const active = await writeIndexedImage('Final/active.png');
    const unstarted = await writeIndexedImage('Final/unstarted.png');
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const deferred = [];
    let resolveInitialWorkers;
    const initialWorkers = new Promise((resolve) => { resolveInitialWorkers = resolve; });
    const started = [];
    let settled = false;
    const stageEntry = () => {
      const entryIndex = started.length;
      started.push(entryIndex);
      return new Promise((resolve, reject) => {
        deferred[entryIndex] = { resolve, reject };
        if (entryIndex === 1) resolveInitialWorkers();
      });
    };
    const service = makeProcessingService({
      processingConcurrencyService: bounded,
      sharpImplementation: () => ({
        rotate() {
          return {
            jpeg() { return { toBuffer: stageEntry }; },
            webp() { return { toBuffer: stageEntry }; },
          };
        },
      }),
    });
    const operation = service.createArchives(project.id, [failing.id, active.id, unstarted.id], {
      makeArchives: false,
      makeCbz: true,
      setName: 'Failure',
    });
    operation.finally(() => { settled = true; }).catch(() => {});

    await initialWorkers;
    deferred[0].reject(new Error('original archive entry failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([0, 1]);
    expect(settled).toBe(false);

    deferred[1].resolve(Buffer.from('active entry'));
    await expect(operation).rejects.toMatchObject({
      code: 'ARCHIVE_BUILD_FAILED',
      cause: expect.objectContaining({ message: 'original archive entry failure' }),
    });

    expect(started).toEqual([0, 1]);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, 'Failure_jpg_q85.cbz'))).toBe(false);
  });

  it('keeps ZIP and real 7z logical membership identical', async () => {
    const source = await writeIndexedImage('Final/-cover.png');
    const zipResult = await processingService.createArchives(project.id, [source.id], {
      setName: 'Zip',
      zipJpgQuality: 72,
      zipWebpQuality: 81,
    });
    const sevenResult = await processingService.createArchives(project.id, [source.id], {
      archiveFormat: '7z',
      setName: 'Seven',
      zipJpgQuality: 72,
      zipWebpQuality: 81,
    });

    const zipJpg = await readZipEntries(path.join(projectDir, zipResult.artifacts[0].relativePath));
    const sevenJpg = await read7zArchiveEntries(fs.readFileSync(path.join(projectDir, sevenResult.artifacts[0].relativePath)));
    const zipWebp = await readZipEntries(path.join(projectDir, zipResult.artifacts[1].relativePath));
    const sevenWebp = await read7zArchiveEntries(fs.readFileSync(path.join(projectDir, sevenResult.artifacts[1].relativePath)));
    expect(sevenJpg.map((entry) => entry.name)).toEqual(zipJpg.map((entry) => entry.name));
    expect(sevenWebp.map((entry) => entry.name)).toEqual(zipWebp.map((entry) => entry.name));
    expect(sevenJpg.map((entry) => entry.name)).toEqual(['Final/-cover.jpg']);
    expect(sevenWebp.map((entry) => entry.name)).toEqual(['Final/-cover.webp']);
  });

  it('fails closed on cross-operation archive ownership and supports owned replacement', async () => {
    const source = await writeIndexedImage('Final/shared.png');

    await processingService.createArchives(project.id, [source.id], { setName: 'Shared' });
    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      outputCategorySlug: 'final',
      deleteSource: false,
      makeArchives: true,
      setName: 'Shared',
    })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });

    const watermarkService = createAssetProcessingService({
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: createProjectOperationCoordinator(),
      processingConcurrencyService,
      watermarkPath: path.join(tmpDir, 'watermark.png'),
      watermarkRoot: tmpDir,
    });
    await watermarkService.watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      outputCategorySlug: 'final',
      deleteSource: false,
      makeArchives: true,
      setName: 'WatermarkOwned',
    });
    await expect(processingService.createArchives(project.id, [source.id], {
      setName: 'WatermarkOwned',
    })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });

    const replaced = await processingService.createArchives(project.id, [source.id], {
      setName: 'Shared',
      replaceExistingArchives: true,
    });
    expect(replaced.artifacts).toHaveLength(2);
  });

  it('restores sources and removes partial artifacts when the artifact transaction fails', async () => {
    const source = await writeIndexedImage('Final/db-failure.png');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected archive database failure'); });

    await expect(processingService.createArchives(project.id, [source.id], {
      setName: 'DB failure',
    })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });

    applySpy.mockRestore();
    expect(fs.existsSync(path.join(projectDir, 'DB failure_jpg_q80.zip'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'DB failure_webp_q90.zip'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final/db-failure.png'))).toBe(true);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
  });

  it('restores an owned replacement when the artifact transaction fails', async () => {
    const source = await writeIndexedImage('Final/replacement.png');
    await processingService.createArchives(project.id, [source.id], { setName: 'Restore' });
    const jpgPath = path.join(projectDir, 'Restore_jpg_q80.zip');
    const beforeJpg = fs.readFileSync(jpgPath);
    const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);

    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => { throw new Error('injected replacement database failure'); });
    await expect(processingService.createArchives(project.id, [source.id], {
      setName: 'Restore',
      replaceExistingArchives: true,
    })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    applySpy.mockRestore();

    expect(fs.readFileSync(jpgPath)).toEqual(beforeJpg);
    expect(fs.existsSync(path.join(projectDir, 'Restore_webp_q90.zip'))).toBe(true);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
  });

  it('fails closed when a destination appears during archive publication', async () => {
    const source = await writeIndexedImage('Final/race.png');
    const foreignPath = path.join(projectDir, 'Race_jpg_q80.zip');
    let created = false;
    const racedService = makeProcessingService({
      sharpImplementation: (...args) => {
        if (!created) {
          created = true;
          fs.writeFileSync(foreignPath, Buffer.from('foreign destination'));
        }
        return sharp(...args);
      },
    });

    await expect(racedService.createArchives(project.id, [source.id], {
      setName: 'Race',
    })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });

    expect(fs.readFileSync(foreignPath)).toEqual(Buffer.from('foreign destination'));
    expect(fs.existsSync(path.join(projectDir, 'Race_webp_q90.zip'))).toBe(false);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
  });

  it('removes a completed first archive when the second archive fails', async () => {
    const source = await writeIndexedImage('Final/partial.png');
    const sourceBefore = fs.readFileSync(path.join(projectDir, 'Final/partial.png'));
    let sharpCalls = 0;
    const failingService = makeProcessingService({
      sharpImplementation: (...args) => {
        sharpCalls += 1;
        if (sharpCalls === 2) throw new Error('injected WebP archive failure');
        return sharp(...args);
      },
    });

    await expect(failingService.createArchives(project.id, [source.id], {
      setName: 'Partial',
    })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });

    expect(sharpCalls).toBe(2);
    expect(fs.existsSync(path.join(projectDir, 'Partial_jpg_q80.zip'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Partial_webp_q90.zip'))).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, 'Final/partial.png'))).toEqual(sourceBefore);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
  });

  it('removes all outputs when CBZ generation fails after paired archives stage', async () => {
    const source = await writeIndexedImage('Final/cbz-failure.png');
    let sharpCalls = 0;
    const failingService = makeProcessingService({
      sharpImplementation: (...args) => {
        sharpCalls += 1;
        if (sharpCalls === 3) throw new Error('injected CBZ archive failure');
        return sharp(...args);
      },
    });

    await expect(failingService.createArchives(project.id, [source.id], {
      makeCbz: true,
      setName: 'CBZ failure',
    })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });

    expect(sharpCalls).toBe(3);
    expect(fs.existsSync(path.join(projectDir, 'CBZ failure_jpg_q80.zip'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'CBZ failure_webp_q90.zip'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'CBZ failure_jpg_q85.cbz'))).toBe(false);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
  });
});
