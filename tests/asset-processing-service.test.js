import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createAssetProcessingPlanner } from '../src/services/asset-processing-planner.js';
import {
  createAssetProcessingService,
  AssetProcessingError,
  RECOVERY_DIAGNOSTIC_LIMIT,
  recoveryLogContext,
  summarizeRecoveryDiagnostics,
} from '../src/services/asset-processing-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingJobService } from '../src/services/processing-job-service.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createProcessingPresetService } from '../src/services/processing-preset-service.js';
import { createWatermarkScaleMapService } from '../src/services/watermark-scale-map-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { createSourceAnimationService } from '../src/services/source-animation-service.js';
import { inspectSourceAnimation } from '../src/services/source-animation.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import {
  createPngChunk,
  editWorkflowPromptsInPng,
  PNG_SIGNATURE,
} from '../src/services/workflow-prompt-editor.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createProcessingRecoveryEvidenceRepository } from '../src/data/processing-recovery-evidence-repository.js';
import { createProcessingRecoveryEvidenceRecorder } from '../src/services/processing-recovery-evidence-recorder.js';
import { isKnownDirectoryIdentity } from '../src/services/project-directory-ownership.js';
import {
  replaceStageAfterClose,
  replaceWithForeignDirectory,
  replaceWithForeignFile,
} from './helpers/processing-fs-races.js';
import { stagingWorkspaces, stageArtifact, stageNames } from './helpers/processing-staging.js';
import { processingRecoveryEvidenceDependencies } from './helpers/processing-recovery-evidence.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// Live SMB timeline (as modelled for Watermark and archives): a file's creating descriptor
// reports its write times T1; once that descriptor closes, the pathname reports later mtime/ctime
// T2 with the same exact identity, size and bytes; the first read-only open of the path refreshes
// it back to T1, which every later stat reports. T2 is T1 plus the live 20448600 ns step. Only
// bigint mtimeNs/ctimeNs are modelled, for the most recent exclusive create at a matching path.
// `observed` lists the modelled mtimeNs of each bigint lstat of the path, in order.
function modelSmbTimeSettling(matches) {
  const POST_CLOSE_STEP_NS = 20448600n;
  const realOpen = fs.openSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const realLstat = fs.lstatSync.bind(fs);
  const realFstat = fs.fstatSync.bind(fs);
  let createDescriptor = null;
  let createdIno = null;
  let closed = false;
  let refreshed = false;
  const observed = [];
  const model = (stats) => {
    if (!stats || typeof stats.ino !== 'bigint' || createdIno === null || stats.ino !== createdIno) return stats;
    const step = closed && !refreshed ? POST_CLOSE_STEP_NS : 0n;
    const modelled = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats);
    modelled.mtimeNs = stats.mtimeNs + step;
    modelled.ctimeNs = stats.ctimeNs + step;
    return modelled;
  };
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    const read = flags === undefined || flags === 'r';
    if (resolved && read && closed && matches(resolved)) refreshed = true;
    const descriptor = realOpen(filePath, flags, ...args);
    if (resolved && typeof flags === 'string' && flags.startsWith('wx') && matches(resolved)) {
      createDescriptor = descriptor;
      createdIno = realFstat(descriptor, { bigint: true }).ino;
    }
    return descriptor;
  });
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
    const result = realClose(descriptor, ...args);
    if (createDescriptor !== null && descriptor === createDescriptor) {
      createDescriptor = null;
      closed = true;
    }
    return result;
  });
  const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
    const stats = model(realLstat(filePath, ...args));
    if (typeof stats?.ino === 'bigint' && stats.ino === createdIno && matches(path.resolve(String(filePath)))) {
      observed.push(stats.mtimeNs);
    }
    return stats;
  });
  const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => (
    model(realFstat(descriptor, ...args))));
  return {
    observed,
    postCloseStepNs: POST_CLOSE_STEP_NS,
    get refreshed() { return refreshed; },
    restore() {
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
      closeSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

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
      projectOptionCatalogueService: createTestProjectOptionCatalogueService(db),
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
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator,
      processingConcurrencyService,
      alreadyCoordinatedCapability: processingExecutionCapability,
      // Workflow Prompt requires durable recovery evidence; other operations ignore it.
      ...processingRecoveryEvidenceDependencies(db),
      ...overrides,
    });
  }

  // Overrides selected stat fields (e.g. zero IDs, link counts) for matching paths on both
  // lstat and descriptor fstat, in Number and bigint form.
  function mockStatOverrides(override) {
    const realLstat = fs.lstatSync.bind(fs);
    const realOpen = fs.openSync.bind(fs);
    const realFstat = fs.fstatSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    const descriptors = new Map();
    const apply = (filePath, stats) => {
      if (!stats || typeof filePath !== 'string') return stats;
      const fields = override(path.resolve(filePath));
      if (!fields) return stats;
      const cast = (value) => (typeof stats.ino === 'bigint' ? BigInt(value) : Number(value));
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats,
        Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, cast(value)])));
    };
    const spies = [
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => apply(filePath, realLstat(filePath, ...args))),
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
        const descriptor = realOpen(filePath, ...args);
        if (typeof filePath === 'string') descriptors.set(descriptor, filePath);
        return descriptor;
      }),
      vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => (
        apply(descriptors.get(descriptor), realFstat(descriptor, ...args))
      )),
      vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        descriptors.delete(descriptor);
        return realClose(descriptor, ...args);
      }),
    ];
    return () => spies.reverse().forEach((spy) => spy.mockRestore());
  }

  // Stage bytes are written through CreatorCrate's exclusive stage descriptor. Routes each
  // such write for a stage path accepted by `matches` through `handler(stagePath, write)`,
  // where `write()` performs the real descriptor write; both return promises.
  function interceptStageWrites(matches, handler) {
    const realOpen = fs.openSync.bind(fs);
    const realWriteFile = fs.writeFile.bind(fs);
    const stagePaths = new Map();
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
      const descriptor = realOpen(filePath, ...args);
      if (typeof filePath === 'string' && matches(filePath)) stagePaths.set(descriptor, filePath);
      return descriptor;
    });
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation((target, data, ...rest) => {
      const callback = rest.pop();
      const stagePath = stagePaths.get(target);
      if (stagePath === undefined) return realWriteFile(target, data, ...rest, callback);
      stagePaths.delete(target);
      const write = () => new Promise((resolve, reject) => {
        realWriteFile(target, data, ...rest, (err) => (err ? reject(err) : resolve()));
      });
      Promise.resolve().then(() => handler(stagePath, write)).then(() => callback(null), callback);
      return undefined;
    });
    return () => {
      writeSpy.mockRestore();
      openSpy.mockRestore();
    };
  }

  const isPromptStagePath = (filePath) => filePath.includes('.creatorcrate-workflow-prompts-')
    && filePath.endsWith('.png');

  function promptWorkspaces() {
    return stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-');
  }

  // Models the live SMB share, where every path reports its own inode number: identities are
  // assigned by path (any `.original` backup or `.png` stage in the Prompt workspace) and, at
  // the selected source path, by object (the pre-run source, then each later object in turn),
  // all on dev 77. A hard link there never exposes its source's dev/ino. Records the identity
  // each exclusively created file exposed through its own descriptor, in creation order.
  function mockSmbPromptIdentities(sourcePath, ids) {
    const resolvedSource = path.resolve(sourcePath);
    const realLstat = fs.lstatSync.bind(fs);
    const realOpen = fs.openSync.bind(fs);
    const realFstat = fs.fstatSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    const originalIno = realLstat(resolvedSource, { bigint: true }).ino;
    const laterIds = [...ids.replacements];
    const laterByIno = new Map();
    const descriptors = new Map();
    const created = [];
    const identityFor = (filePath, realIno) => {
      const resolved = path.resolve(String(filePath));
      if (resolved === resolvedSource) {
        if (realIno === originalIno) return ids.source;
        if (!laterByIno.has(realIno)) laterByIno.set(realIno, laterIds.shift());
        return laterByIno.get(realIno);
      }
      if (!resolved.includes('.creatorcrate-workflow-prompts-')) return undefined;
      if (resolved.endsWith('.original')) return ids.backup;
      if (resolved.endsWith('.png')) return ids.stage;
      return undefined;
    };
    const apply = (filePath, stats, realIno) => {
      const identity = stats && identityFor(filePath, realIno);
      if (!identity) return stats;
      const cast = (value) => (typeof stats.ino === 'bigint' ? value : Number(value));
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        dev: cast(identity.dev),
        ino: cast(identity.ino),
      });
    };
    const spies = [
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        return stats ? apply(filePath, stats, realLstat(filePath, { bigint: true }).ino) : stats;
      }),
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        const descriptor = realOpen(filePath, flags, ...args);
        if (typeof filePath === 'string') {
          descriptors.set(descriptor, { filePath, exclusive: String(flags).startsWith('wx') });
        }
        return descriptor;
      }),
      vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
        const stats = realFstat(descriptor, ...args);
        const opened = descriptors.get(descriptor);
        if (!opened) return stats;
        const observed = apply(opened.filePath, stats, realFstat(descriptor, { bigint: true }).ino);
        if (opened.exclusive && !opened.recorded) {
          opened.recorded = true;
          created.push(`${observed.dev}:${observed.ino}`);
        }
        return observed;
      }),
      vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        descriptors.delete(descriptor);
        return realClose(descriptor, ...args);
      }),
    ];
    return { created, restore: () => spies.reverse().forEach((spy) => spy.mockRestore()) };
  }

  // Routes CreatorCrate's descriptor writes (fs.write, as the owned-file copy uses) for
  // descriptors opened at a path/flags accepted by `matches(filePath, flags)` through
  // `fail()`, which returns the error to report instead of writing, or undefined to write.
  function interceptDescriptorWrites(matches, fail) {
    const realOpen = fs.openSync.bind(fs);
    const realWrite = fs.write.bind(fs);
    const intercepted = new Set();
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      const descriptor = realOpen(filePath, flags, ...args);
      if (typeof filePath === 'string' && matches(path.resolve(filePath), flags)) intercepted.add(descriptor);
      return descriptor;
    });
    const writeSpy = vi.spyOn(fs, 'write').mockImplementation((descriptor, ...rest) => {
      const error = intercepted.has(descriptor) ? fail() : undefined;
      if (!error) return realWrite(descriptor, ...rest);
      const callback = rest[rest.length - 1];
      process.nextTick(() => callback(error));
      return undefined;
    });
    return () => {
      writeSpy.mockRestore();
      openSpy.mockRestore();
    };
  }

  const isPromptBackupPath = (filePath) => String(filePath).includes('.creatorcrate-workflow-prompts-')
    && String(filePath).endsWith('.original');

  // Assigns fake file IDs to real inodes so tests can model IDs past 2^53, where
  // distinct exact bigint IDs share one rounded Number.
  function mockExactFileIds() {
    const realLstat = fs.lstatSync.bind(fs);
    const realFstat = fs.fstatSync.bind(fs);
    const assigned = new Map();
    const autoAssignments = [];
    const remap = (stats, realIno) => {
      const ino = assigned.get(realIno);
      if (ino === undefined) return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        ino: typeof stats.ino === 'bigint' ? ino : Number(ino),
      });
    };
    const tagObserved = (observedPath, realIno) => {
      const tag = autoAssignments.find((entry) => !entry.used && entry.matches(String(observedPath)));
      if (tag && !assigned.has(realIno)) {
        tag.used = true;
        assigned.set(realIno, tag.ino);
      }
    };
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      const stats = realLstat(filePath, ...args);
      if (!stats) return stats;
      const realIno = realLstat(filePath, { bigint: true }).ino;
      tagObserved(filePath, realIno);
      return remap(stats, realIno);
    });
    // Stage ownership is rooted in CreatorCrate's exclusive descriptor, so a file first
    // observed through fstat is tagged by the path that descriptor was opened at.
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    const openedPaths = new Map();
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
      const descriptor = realOpen(filePath, ...args);
      if (typeof filePath === 'string') openedPaths.set(descriptor, filePath);
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
      openedPaths.delete(descriptor);
      return realClose(descriptor, ...args);
    });
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
      const realIno = realFstat(descriptor, { bigint: true }).ino;
      if (openedPaths.has(descriptor)) tagObserved(openedPaths.get(descriptor), realIno);
      return remap(realFstat(descriptor, ...args), realIno);
    });
    return {
      assign(filePath, ino) {
        assigned.set(realLstat(filePath, { bigint: true }).ino, ino);
      },
      // Gives the first file later observed at a matching path the fake ID, before
      // CreatorCrate captures its identity.
      autoAssign(matches, ino) {
        autoAssignments.push({ matches, ino, used: false });
      },
      restore() {
        fstatSpy.mockRestore();
        closeSpy.mockRestore();
        openSpy.mockRestore();
        lstatSpy.mockRestore();
      },
    };
  }

  const isReadOpen = (flags) => flags === undefined || flags === 'r';
  const isExclusiveOpen = (flags) => typeof flags === 'string' && flags.startsWith('wx');
  const isConvertStageFile = (filePath, name) => String(filePath).includes('.creatorcrate-convert-')
    && String(filePath).endsWith(`.${name}`);

  // Wraps whatever fs.openSync/closeSync currently are (so it composes with the spies above;
  // undo in reverse order). `onOpen(resolvedPath, flags)` runs before each open and may return
  // an Error to throw instead; `onClose(resolvedPath, flags)` runs after each close of a
  // descriptor opened by path.
  function hookFileDescriptors({ onOpen, onClose } = {}) {
    const previousOpen = fs.openSync;
    const previousClose = fs.closeSync;
    const opened = new Map();
    fs.openSync = function hookedOpen(filePath, flags, ...args) {
      const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
      const error = resolved ? onOpen?.(resolved, flags) : undefined;
      if (error) throw error;
      const descriptor = previousOpen.call(fs, filePath, flags, ...args);
      if (resolved) opened.set(descriptor, [resolved, flags]);
      return descriptor;
    };
    fs.closeSync = function hookedClose(descriptor, ...args) {
      const result = previousClose.call(fs, descriptor, ...args);
      const entry = opened.get(descriptor);
      opened.delete(descriptor);
      if (entry) onClose?.(...entry);
      return result;
    };
    return () => {
      fs.closeSync = previousClose;
      fs.openSync = previousOpen;
    };
  }

  // Rewrites a file in place: same inode, different bytes.
  function rewriteInPlace(target, bytes) {
    fs.writeFileSync(target, bytes);
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

  it('records Conversion and Workflow Prompt recovery evidence and leaves none after clean runs', async () => {
    // Both operations record evidence and remove all of it once cleanup is positively complete.
    const evidenceRepository = createProcessingRecoveryEvidenceRepository(db);
    const calls = [];
    const countingRepository = Object.fromEntries(Object.entries(evidenceRepository).map(([name, method]) => [
      name, (...args) => { calls.push(name); return method(...args); },
    ]));
    const recorder = createProcessingRecoveryEvidenceRecorder({ db, repository: countingRepository });
    const service = createProcessingService({
      processingRecoveryEvidenceRecorder: recorder, processingRecoveryEvidenceRepository: countingRepository,
    });
    expect(service.recoveryEvidenceRecorder).toBe(recorder);

    const image = writeIndexedImage('Final/dormant.png');
    await service.convertAssets(project.id, [image.id], { format: 'webp', quality: 80, originalHandling: 'keep' });
    expect(calls).toEqual(expect.arrayContaining(['createMutationGroup', 'createEvidence', 'deleteMutationGroup']));
    expect(db.prepare('SELECT COUNT(*) FROM processing_recovery_mutation_groups').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM processing_recovery_evidence').pluck().get()).toBe(0);
    calls.length = 0;
    const graph = JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } },
    });
    const prompt = writeIndexedPromptPng('Final/dormant-workflow.png', 'prompt', graph);
    const promptResult = await service.editWorkflowPrompts(project.id, [prompt.id], {
      positive: { rules: [{ type: 'append', text: ' detailed' }] },
    });
    expect(promptResult).toMatchObject({ status: 'completed', changedCount: 1 });

    expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/dormant.webp')).toBeTruthy();
    expect(calls).toEqual(expect.arrayContaining(['createMutationGroup', 'createEvidence', 'deleteMutationGroup']));
    expect(db.prepare('SELECT COUNT(*) FROM processing_recovery_mutation_groups').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM processing_recovery_evidence').pluck().get()).toBe(0);
  });

  it('rejects invalid recovery evidence dependencies', () => {
    expect(() => createProcessingService({ processingRecoveryEvidenceRecorder: {} }))
      .toThrow(/processingRecoveryEvidenceRecorder is invalid/);
    expect(() => createProcessingService({ processingRecoveryEvidenceRepository: {} }))
      .toThrow(/processingRecoveryEvidenceRepository is invalid/);
    expect(createProcessingService({
      processingRecoveryEvidenceRecorder: null, processingRecoveryEvidenceRepository: null,
    }).recoveryEvidenceRecorder).toBeNull();
  });

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
    expect(fs.existsSync(path.join(projectDir, '.creatorcrate-convert-staging'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'active.webp'))).toBe(false);

    deferred.get('source:active').resolve(Buffer.from('output:active'));
    await expect(operation).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    expect(started).toEqual(['source:failing', 'source:active']);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'failing.webp'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'active.webp'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'unstarted.webp'))).toBe(false);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-convert-')).toEqual([]);
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

  async function makeAnimatedWebp() {
    const frameData = Buffer.from([
      255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0,
      0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255,
    ]);
    return sharp(frameData, {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  }

  function createTestScanner() {
    return createAssetScanner(db, projectsRoot, {
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectService,
      assetCategoryService,
      projectOperationCoordinator,
      previewCategorySettingsService: { getPreviewCategory: () => '__disabled__' },
      projectPrimaryImageRepository: {
        findByProjectId: () => undefined,
        setPrimaryImage: () => undefined,
      },
    });
  }

  // Index sources exactly as the scanner does (on-disk category directory,
  // scanner animation classification) so a later scan has nothing to repair.
  function writeScannedSources(files) {
    for (const [relativePath, buffer] of files) {
      const target = path.join(projectDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
    }
    createTestScanner().scanProjectAssets(project.id);
    return files.map(([relativePath]) => assetRepository.findByProjectIdAndPath(project.id, relativePath));
  }

  // Scanner and Preview source reconciliation over the unchanged converted
  // bytes: neither may write the row again.
  function expectConvertedSourceSettled(assetId, expected) {
    const converted = assetRepository.findById(assetId);
    expect(converted).toMatchObject({ ...expected, is_present: 1 });
    const target = path.join(projectDir, ...converted.relative_path.split('/'));
    const bytesBefore = fs.readFileSync(target);
    const revision = buildAssetRevisionToken(converted);

    createTestScanner().scanProjectAssets(project.id);
    expect(assetRepository.findById(assetId)).toEqual(converted);

    const sourceAnimation = createSourceAnimationService({ assetRepository, projectRepository, projectsRoot, projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db) });
    expect(sourceAnimation.reconcileSource(converted)).toBeNull();
    const reconciled = assetRepository.findById(assetId);
    expect(reconciled).toEqual(converted);
    expect(buildAssetRevisionToken(reconciled)).toBe(revision);
    expect(fs.readFileSync(target)).toEqual(bytesBefore);
  }

  it('records a flattened animated WebP re-encode as still in its one generation advance', async () => {
    const animated = await makeAnimatedWebp();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    const [source] = writeScannedSources([['final/animated-in-place.webp', animated]]);
    const target = path.join(projectDir, 'final', 'animated-in-place.webp');
    expect(source).toMatchObject({ source_animated: 1, source_generation: 0 });
    const revisionBefore = buildAssetRevisionToken(source);

    await processingService.convertAssets(project.id, [source.id], {
      format: 'webp', quality: 85, originalHandling: 'keep',
    });

    const output = fs.readFileSync(target);
    expect((await sharp(output).metadata()).pages ?? 1).toBe(1);
    expect(inspectSourceAnimation(target, 'webp')).toBe(false);
    const converted = assetRepository.findById(source.id);
    expect(converted).toMatchObject({
      size_bytes: output.length,
      modified_at: fs.statSync(target).mtime.toISOString(),
      source_animated: 0,
      source_generation: 1,
    });
    expect(buildAssetRevisionToken(converted)).not.toBe(revisionBefore);

    expectConvertedSourceSettled(source.id, { source_animated: 0, source_generation: 1 });
  });

  it('keeps a still WebP re-encode classified still with a single generation advance', async () => {
    const still = await sharp(imageBuffer).webp({ quality: 95 }).toBuffer();
    const [known, legacy] = writeScannedSources([
      ['final/still-in-place.webp', still],
      ['final/legacy-in-place.webp', still],
    ]);
    // A row indexed before animation classification existed.
    db.prepare('UPDATE assets SET source_animated = NULL WHERE id = ?').run(legacy.id);
    expect(known).toMatchObject({ source_animated: 0, source_generation: 0 });
    expect(assetRepository.findById(legacy.id)).toMatchObject({ source_animated: null, source_generation: 0 });

    await processingService.convertAssets(project.id, [known.id, legacy.id], {
      format: 'webp', quality: 40, originalHandling: 'keep',
    });

    expectConvertedSourceSettled(known.id, { source_animated: 0, source_generation: 1 });
    expectConvertedSourceSettled(legacy.id, { source_animated: 0, source_generation: 1 });
  });

  it('records the scanner classification for every same-extension re-encode format', async () => {
    const jpegBytes = await sharp(imageBuffer).jpeg({ quality: 90 }).toBuffer();
    const bmpBytes = Buffer.from(encodeBmp({
      width: 1, height: 1, channels: 3, data: new Uint8Array([255, 0, 0]),
    }, { bitsPerPixel: 24 }));
    const files = [
      ['final/classify.png', imageBuffer, 'png', null],
      ['final/classify.gif', await makeAnimatedGif(), 'gif', 0],
      ['final/classify.jpg', jpegBytes, 'jpg', null],
      ['final/classify.jpeg', jpegBytes, 'jpeg', null],
      ['final/classify.bmp', bmpBytes, 'bmp', null],
    ];
    const assets = writeScannedSources(files.map(([relativePath, buffer]) => [relativePath, buffer]));
    expect(assets[1]).toMatchObject({ source_animated: 1, source_generation: 0 });

    for (const [index, [, , format, sourceAnimated]] of files.entries()) {
      await processingService.convertAssets(project.id, [assets[index].id], {
        format, quality: 85, originalHandling: 'keep',
      });
      expectConvertedSourceSettled(assets[index].id, { source_animated: sourceAnimated, source_generation: 1 });
    }
  });

  it('keeps generation and animation authority when an animated WebP re-encode fails to index', async () => {
    const [source] = writeScannedSources([['final/animated-failure.webp', await makeAnimatedWebp()]]);
    const target = path.join(projectDir, 'final', 'animated-failure.webp');
    const before = fs.readFileSync(target);
    const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
      .mockImplementation(() => { throw new Error('injected database failure'); });

    try {
      await expect(processingService.convertAssets(project.id, [source.id], {
        format: 'webp', quality: 85, originalHandling: 'keep',
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    } finally {
      applySpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id)).toEqual(source);
    expect(source).toMatchObject({ source_animated: 1, source_generation: 0 });
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
    const target = path.resolve(projectDir, 'Final', 'publication-failure.png');
    const before = fs.readFileSync(target);
    // The replacement is written through its own exclusive descriptor at the source pathname.
    let publicationFailed = false;
    const restoreWrites = interceptDescriptorWrites(
      (filePath, flags) => filePath === target && String(flags).startsWith('wx'),
      () => {
        if (publicationFailed) return undefined;
        publicationFailed = true;
        return Object.assign(new Error('injected publication failure'), { code: 'EIO' });
      },
    );
    const linkSpy = vi.spyOn(fs, 'linkSync');
    let linkCallCount;

    try {
      await expect(processingService.convertAssets(project.id, [source.id], {
        format: 'png', quality: 85, originalHandling: 'keep',
      })).rejects.toMatchObject({
        name: 'AssetProcessingError',
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    } finally {
      linkCallCount = linkSpy.mock.calls.length;
      linkSpy.mockRestore();
      restoreWrites();
    }

    expect(publicationFailed).toBe(true);
    expect(linkCallCount).toBe(0);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id).relative_path)
      .toBe('Final/publication-failure.png');
    expect(stagingWorkspaces(projectDir, '.creatorcrate-convert-'))
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
    expect(stagingWorkspaces(projectDir, '.creatorcrate-convert-'))
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
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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

  it('deletes an original whose exact file ID is past 2^53 when ownership is exact', async () => {
    const source = writeIndexedImage('Final/large-id-delete.png');
    const target = path.join(projectDir, 'Final', 'large-id-delete.png');
    const ids = mockExactFileIds();
    ids.assign(target, 9007199254740993n);

    try {
      await processingService.convertAssets(project.id, [source.id], {
        format: 'webp',
        quality: 80,
        originalHandling: 'delete',
      });
    } finally {
      ids.restore();
    }

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'large-id-delete.webp'))).toBe(true);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-convert-'))
      .toEqual([]);
  });

  it('never deletes a replaced source whose exact file ID only collides after Number rounding', async () => {
    const source = writeIndexedImage('Final/rounded-source.png');
    const target = path.join(projectDir, 'Final', 'rounded-source.png');
    const trustedIno = 9007199254740992n;
    const replacementIno = 9007199254740993n;
    expect(Number(trustedIno)).toBe(Number(replacementIno));
    const foreign = Buffer.from('foreign replacement source');
    const ids = mockExactFileIds();
    ids.assign(target, trustedIno);
    let replaced = false;
    let roundedIno;
    // A foreign writer swaps the source after its staged copy was created, while that copy is
    // first validated. The replacement rounds to the same Number ID.
    const unhook = hookFileDescriptors({
      onOpen(filePath, flags) {
        if (replaced || !isReadOpen(flags) || !isConvertStageFile(filePath, 'original')) return;
        replaced = true;
        fs.rmSync(target);
        fs.writeFileSync(target, foreign);
        ids.assign(target, replacementIno);
        roundedIno = fs.lstatSync(target).ino;
      },
    });

    try {
      await expect(processingService.convertAssets(project.id, [source.id], {
        format: 'webp',
        quality: 80,
        originalHandling: 'delete',
      })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    } finally {
      unhook();
      ids.restore();
    }

    expect(replaced).toBe(true);
    expect(roundedIno).toBe(Number(trustedIno));
    expect(fs.readFileSync(target)).toEqual(foreign);
    expect(fs.existsSync(path.join(projectDir, 'Final', 'rounded-source.webp'))).toBe(false);
    expect(assetRepository.findById(source.id)).toBeTruthy();
    expect(stagingWorkspaces(projectDir, '.creatorcrate-convert-')).toEqual([]);
  });

  describe('delete-mode staged originals', () => {
    const convertWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-convert-');
    const isStagedOriginal = (filePath) => isConvertStageFile(filePath, 'original');

    // Previously the abandoned alias's path stayed recorded, so rollback tried to restore from
    // a stage that no longer existed and reported a false RECOVERY_REQUIRED.
    it('fails ordinarily without a restore attempt when unlinking the source fails before removal', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedImage('Final/unlink-fails.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'unlink-fails.png');
      const sourceBytes = fs.readFileSync(sourcePath);
      const sourceIdentity = fs.lstatSync(sourcePath, { bigint: true });
      const realUnlink = fs.unlinkSync.bind(fs);
      let sourceUnlinkFailed = false;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (!sourceUnlinkFailed && path.resolve(String(filePath)) === sourcePath) {
          sourceUnlinkFailed = true;
          throw Object.assign(new Error('injected source unlink failure'), { code: 'EPERM' });
        }
        return realUnlink(filePath, ...args);
      });
      const restoreCreates = [];
      const unhook = hookFileDescriptors({
        onOpen(filePath, flags) {
          if (filePath === sourcePath && isExclusiveOpen(flags)) restoreCreates.push(filePath);
        },
      });
      const linkSpy = vi.spyOn(fs, 'linkSync');
      const onProgress = vi.fn();
      onProgress.jobId = 'job-unlink-fails';
      let linkCallCount;

      try {
        const executor = processingService.createAlreadyCoordinatedExecutor(processingExecutionCapability);
        await expect(executor.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'delete',
        }, onProgress)).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      } finally {
        linkCallCount = linkSpy.mock.calls.length;
        linkSpy.mockRestore();
        unhook();
        unlinkSpy.mockRestore();
      }

      expect(sourceUnlinkFailed).toBe(true);
      // No hard link at all, and no restore was attempted onto the untouched source.
      expect(linkCallCount).toBe(0);
      expect(restoreCreates).toEqual([]);
      const after = fs.lstatSync(sourcePath, { bigint: true });
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: sourceIdentity.dev, ino: sourceIdentity.ino });
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'unlink-fails.webp'))).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(convertWorkspaces()).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.failed',
      }));
    });

    // Another actor removes (and optionally replaces) the source pathname just before
    // CreatorCrate's own unlink, which then reports ENOENT. Records the ordered staged-original
    // events so tests can prove the staged copy survives until a verified restore.
    async function raceSourceUnlink(name, { foreignBytes = null } = {}) {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedImage(`Final/${name}.png`);
      const sourcePath = path.resolve(projectDir, 'Final', `${name}.png`);
      const sourceBytes = fs.readFileSync(sourcePath);
      const sourceIdentity = fs.lstatSync(sourcePath, { bigint: true });
      const events = [];
      let stagedAtRace = null;
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (!stagedAtRace && path.resolve(String(filePath)) === sourcePath) {
          const [workspace] = convertWorkspaces();
          const staged = stageArtifact(path.join(projectDir, workspace), '0.original');
          realUnlink(sourcePath);
          if (foreignBytes) fs.writeFileSync(sourcePath, foreignBytes);
          stagedAtRace = { exists: fs.existsSync(staged), bytes: fs.readFileSync(staged) };
          events.push('source-raced');
          throw Object.assign(new Error('injected source unlink race'), { code: 'ENOENT' });
        }
        if (isStagedOriginal(filePath)) events.push('staged-unlink');
        return realUnlink(filePath, ...args);
      });
      const unhook = hookFileDescriptors({
        onOpen(filePath, flags) {
          if (stagedAtRace && filePath === sourcePath && isExclusiveOpen(flags)) events.push('restore-create');
        },
      });

      let failure;
      try {
        failure = await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'delete',
        }).then(() => null, (err) => err);
      } finally {
        unhook();
        unlinkSpy.mockRestore();
      }
      expect(stagedAtRace).toEqual({ exists: true, bytes: sourceBytes });
      return { failure, source, sourcePath, sourceBytes, sourceIdentity, events, applicationLogger };
    }

    // Old: the catch assumed a failed unlink left the source in place, removed the staged
    // alias and cleared its state, destroying the last copy of a source another actor removed.
    it('restores a source removed by another actor during its unlink from the retained staged original', async () => {
      const {
        failure, source, sourcePath, sourceBytes, events, applicationLogger,
      } = await raceSourceUnlink('unlink-race');

      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      // The staged copy is removed only after the source was recreated from it and revalidated.
      expect(events).toEqual(['source-raced', 'restore-create', 'staged-unlink']);
      // The restored source is a new file with the original bytes (its identity is its own).
      expect(fs.lstatSync(sourcePath, { bigint: true }).nlink).toBe(1n);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'unlink-race.webp'))).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(convertWorkspaces()).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.failed',
      }));
    });

    it('keeps the staged original and never overwrites a foreign file that replaced the source', async () => {
      const foreign = Buffer.from('foreign replacement source');
      const { failure, sourcePath, sourceBytes, events } = await raceSourceUnlink('unlink-foreign', {
        foreignBytes: foreign,
      });

      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(events).toEqual(['source-raced']);
      expect(fs.readFileSync(sourcePath)).toEqual(foreign);
      const [workspace, ...others] = convertWorkspaces();
      expect(others).toEqual([]);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(sourceBytes);
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'staged-original', check: 'restore-source-present',
      }));
    });

    it('restores a removed source from its staged original when the index update fails', async () => {
      const source = writeIndexedImage('Final/restore-deleted.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'restore-deleted.png');
      const sourceBytes = fs.readFileSync(sourcePath);
      let sourceAbsentAtCommit;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        sourceAbsentAtCommit = !fs.existsSync(sourcePath);
        throw new Error('injected database failure');
      });

      try {
        await expect(processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'delete',
        })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      } finally {
        applySpy.mockRestore();
      }

      expect(sourceAbsentAtCommit).toBe(true);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'restore-deleted.webp'))).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(convertWorkspaces()).toEqual([]);
    });

    it('requires recovery and keeps the staged original when a removed source cannot be restored', async () => {
      const source = writeIndexedImage('Final/restore-fails.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'restore-fails.png');
      const sourceBytes = fs.readFileSync(sourcePath);
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
        .mockImplementation(() => { throw new Error('injected database failure'); });
      // The only exclusive create at the source path is the restore from the staged original.
      const restoreWrites = interceptDescriptorWrites(
        (filePath, flags) => filePath === sourcePath && String(flags).startsWith('wx'),
        () => Object.assign(new Error('injected restore failure'), { code: 'EIO' }),
      );

      let failure;
      try {
        failure = await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'delete',
        }).then(() => null, (err) => err);
      } finally {
        restoreWrites();
        applySpy.mockRestore();
      }

      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      // The partial restore CreatorCrate owned was withdrawn by its exact identity.
      expect(fs.existsSync(sourcePath)).toBe(false);
      const [workspace, ...others] = convertWorkspaces();
      expect(others).toEqual([]);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(sourceBytes);
      expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'restored-source', check: 'restore-create-failed' }),
        expect.objectContaining({
          artifactRole: 'staged-original', check: 'retained-unrestored', cleanup: 'recovery-critical',
        }),
      ]));
    });
  });

  describe('conversion exact ownership past 2^53', () => {
    // Exact IDs 2^53 + 4 and 2^53 + 5 are distinct files whose Number views are equal.
    const trustedIno = 9007199254740996n;
    const foreignIno = 9007199254740997n;
    const sourceIno = 9007199254740994n;
    const restoredIno = 9007199254740998n;
    const copyIno = 9007199254741000n;
    const convertWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-convert-');
    const at = (target) => (filePath) => path.resolve(String(filePath)) === path.resolve(target);
    // Returns the replacement's Number ino (asserted by the caller, never inside a spy).
    const replaceWithForeign = (ids, target, bytes) => {
      fs.rmSync(target);
      fs.writeFileSync(target, bytes);
      ids.assign(target, foreignIno);
      return fs.lstatSync(target).ino;
    };

    it('moves an original whose exact file ID is past 2^53 into its own large-ID Originals copy', async () => {
      expect(Number(trustedIno)).toBe(Number(foreignIno));
      const source = writeIndexedImage('Final/large-id-move.png');
      const target = path.join(projectDir, 'Final', 'large-id-move.png');
      const original = path.join(projectDir, 'Final', 'originals', 'large-id-move.png');
      const before = fs.readFileSync(target);
      const ids = mockExactFileIds();
      ids.assign(target, sourceIno);
      ids.autoAssign(at(original), copyIno);
      let originalIno;
      try {
        await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'move',
        });
        originalIno = fs.lstatSync(original, { bigint: true }).ino;
      } finally {
        ids.restore();
      }

      expect(originalIno).toBe(copyIno);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readFileSync(original)).toEqual(before);
      expect(assetRepository.findById(source.id).relative_path).toBe('Final/originals/large-id-move.png');
      expect(convertWorkspaces()).toEqual([]);
    });

    // Old: moveOriginalToOriginals trusted Number dev/ino, linked the foreign file into
    // originals and unlinked its source pathname.
    it('never moves a replaced source whose exact ID only collides after Number rounding', async () => {
      const source = writeIndexedImage('Final/rounded-move.png');
      const target = path.join(projectDir, 'Final', 'rounded-move.png');
      const output = path.resolve(projectDir, 'Final', 'rounded-move.webp');
      const foreign = Buffer.from('foreign replacement source');
      const ids = mockExactFileIds();
      ids.assign(target, trustedIno);
      let roundedIno;
      // The source is swapped while the converted output is being created.
      const unhook = hookFileDescriptors({
        onOpen(filePath, flags) {
          if (roundedIno === undefined && filePath === output && isExclusiveOpen(flags)) {
            roundedIno = replaceWithForeign(ids, target, foreign);
          }
        },
      });

      try {
        await expect(processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'move',
        })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      } finally {
        unhook();
        ids.restore();
      }

      expect(roundedIno).toBe(Number(trustedIno));
      expect(fs.readFileSync(target)).toEqual(foreign);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'originals', 'rounded-move.png'))).toBe(false);
      expect(fs.existsSync(output)).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(convertWorkspaces()).toEqual([]);
    });

    // D2 directory policy: `Originals` is validated and used but never claimed or removed,
    // because Node cannot bind a directory's identity to CreatorCrate's own mkdir. Fails the
    // exclusive create of the Originals copy in a freshly created originals directory;
    // `replaceAfterMkdir` substitutes a foreign empty directory immediately after that mkdir
    // succeeds (the boundary where ownership used to be captured from the pathname),
    // `replaceBeforeMove` just before the failing create.
    async function failOriginalsMove(name, { replaceAfterMkdir = false, replaceBeforeMove = false } = {}) {
      const source = writeIndexedImage(`Final/${name}.png`);
      const target = path.join(projectDir, 'Final', `${name}.png`);
      const before = fs.readFileSync(target);
      const originalsDir = path.resolve(projectDir, 'Final', 'originals');
      expect(fs.existsSync(originalsDir)).toBe(false);
      let foreignRealIno;
      const replaceOriginals = () => {
        replaceWithForeignDirectory(originalsDir);
        foreignRealIno = fs.statSync(originalsDir, { bigint: true }).ino;
      };
      const realMkdir = fs.mkdirSync.bind(fs);
      let mkdirRaced = false;
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, ...args) => {
        const result = realMkdir(dirPath, ...args);
        if (replaceAfterMkdir && !mkdirRaced && path.resolve(String(dirPath)) === originalsDir) {
          mkdirRaced = true;
          replaceOriginals();
        }
        return result;
      });
      let injected = false;
      const unhook = hookFileDescriptors({
        onOpen(filePath, flags) {
          if (injected || !isExclusiveOpen(flags) || path.dirname(filePath) !== originalsDir) return undefined;
          injected = true;
          if (replaceBeforeMove) replaceOriginals();
          return Object.assign(new Error('injected originals move failure'), { code: 'EIO' });
        },
      });
      const rmdirSpy = vi.spyOn(fs, 'rmdirSync');

      let failure;
      try {
        failure = await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'move',
        }).then(() => null, (err) => err);
        expect(rmdirSpy).not.toHaveBeenCalled();
      } finally {
        rmdirSpy.mockRestore();
        unhook();
        mkdirSpy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(mkdirRaced).toBe(replaceAfterMkdir);
      expect(fs.readFileSync(target)).toEqual(before);
      expect(fs.existsSync(path.join(projectDir, 'Final', `${name}.webp`))).toBe(false);
      return { failure, originalsDir, foreignRealIno };
    }

    it('retains an originals directory it created and fails with the original error', async () => {
      const { failure, originalsDir } = await failOriginalsMove('created-originals');
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(fs.readdirSync(originalsDir)).toEqual([]);
      expect(convertWorkspaces()).toEqual([]);
    });

    // Old: the pathname was lstat-ed after mkdir and that directory recorded as owned, so a
    // foreign directory substituted in the gap was later removed as "ours".
    it('never claims or removes a foreign originals directory substituted right after its mkdir', async () => {
      const { failure, originalsDir, foreignRealIno } = await failOriginalsMove('post-mkdir-originals', {
        replaceAfterMkdir: true,
      });
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(fs.statSync(originalsDir, { bigint: true }).ino).toBe(foreignRealIno);
    });

    // A foreign empty originals directory left untouched is safe residue: the source was
    // never moved, so the ordinary failure stands instead of RECOVERY_REQUIRED.
    it('keeps a foreign originals directory without escalating to recovery', async () => {
      const { failure, originalsDir, foreignRealIno } = await failOriginalsMove('foreign-originals', {
        replaceBeforeMove: true,
      });
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(fs.statSync(originalsDir, { bigint: true }).ino).toBe(foreignRealIno);
      expect(fs.readdirSync(originalsDir)).toEqual([]);
    });

    it('removes a published output with an exact ID past 2^53 when the index update fails', async () => {
      const source = writeIndexedImage('Final/large-id-output.png');
      const output = path.join(projectDir, 'Final', 'large-id-output.webp');
      const ids = mockExactFileIds();
      ids.autoAssign(at(output), trustedIno);
      let publishedIno;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        publishedIno = fs.lstatSync(output, { bigint: true }).ino;
        throw new Error('injected conversion database failure');
      });
      try {
        await expect(processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'keep',
        })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(publishedIno).toBe(trustedIno);
      expect(fs.existsSync(output)).toBe(false);
      expect(convertWorkspaces()).toEqual([]);
    });

    // Old: cleanupCommittedOutputs unlinked whatever matched the rounded Number identity.
    it('does not unlink a foreign output that only collides after Number rounding during rollback', async () => {
      const source = writeIndexedImage('Final/rounded-output.png');
      const output = path.join(projectDir, 'Final', 'rounded-output.webp');
      const foreign = Buffer.from('foreign converted output');
      const ids = mockExactFileIds();
      ids.autoAssign(at(output), trustedIno);
      let roundedIno;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        roundedIno = replaceWithForeign(ids, output, foreign);
        throw new Error('injected conversion database failure');
      });
      let failure;
      try {
        failure = await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'keep',
        }).then(() => null, (err) => err);
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(roundedIno).toBe(Number(trustedIno));
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.readFileSync(output)).toEqual(foreign);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'rounded-output.png'))).toBe(true);
      // The stage stays as the unresolved publication's evidence.
      const [workspace] = convertWorkspaces();
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.output'))).toBe(true);
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'published-output', check: 'rollback-identity-mismatch', identity: 'mismatched',
      }));
    });

    // The pathname check that follows the output's exclusive create fails once. Nothing is
    // recorded; rollback removes the output only by the identity its own descriptor proved.
    it('removes an owned conversion output whose post-publication path check failed', async () => {
      const source = writeIndexedImage('Final/post-create-owned.png');
      const output = path.resolve(projectDir, 'Final', 'post-create-owned.webp');
      let closed = false;
      let checkFailed = false;
      const unhook = hookFileDescriptors({
        onClose(filePath, flags) {
          if (filePath === output && isExclusiveOpen(flags)) closed = true;
        },
      });
      const realLstat = fs.lstatSync.bind(fs);
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (closed && !checkFailed && path.resolve(String(filePath)) === output) {
          checkFailed = true;
          throw Object.assign(new Error('injected post-create output inspection failure'), { code: 'EIO' });
        }
        return realLstat(filePath, ...args);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions');
      let failure;
      try {
        failure = await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'keep',
        }).then(() => null, (err) => err);
        expect(applySpy).not.toHaveBeenCalled();
      } finally {
        applySpy.mockRestore();
        lstatSpy.mockRestore();
        unhook();
      }

      expect(checkFailed).toBe(true);
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'post-create-owned.png'))).toBe(true);
      expect(convertWorkspaces()).toEqual([]);
    });

    it('keeps the stage of a replaced conversion output and requires recovery', async () => {
      const source = writeIndexedImage('Final/post-create-foreign.png');
      const output = path.resolve(projectDir, 'Final', 'post-create-foreign.webp');
      const foreign = Buffer.from('foreign converted output');
      let replaced = false;
      const unhook = hookFileDescriptors({
        onClose(filePath, flags) {
          if (replaced || filePath !== output || !isExclusiveOpen(flags)) return;
          replaced = true;
          replaceWithForeignFile(output, foreign);
        },
      });
      let failure;
      try {
        failure = await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'keep',
        }).then(() => null, (err) => err);
      } finally {
        unhook();
      }

      expect(replaced).toBe(true);
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.readFileSync(output)).toEqual(foreign);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'post-create-foreign.png'))).toBe(true);
      const [workspace, ...others] = convertWorkspaces();
      expect(others).toEqual([]);
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.output'))).toBe(true);
    });

    it('restores a re-encoded source whose artifacts have exact IDs past 2^53 when the index update fails', async () => {
      const source = writeIndexedImage('Final/large-id-reencode.png');
      const target = path.join(projectDir, 'Final', 'large-id-reencode.png');
      const before = fs.readFileSync(target);
      const ids = mockExactFileIds();
      ids.assign(target, sourceIno);
      ids.autoAssign((filePath) => isConvertStageFile(filePath, 'source'), copyIno);
      // The first new object at the source path is the replacement, the second the restore.
      ids.autoAssign(at(target), trustedIno);
      ids.autoAssign(at(target), restoredIno);
      let publishedIno;
      let finalIno;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        publishedIno = fs.lstatSync(target, { bigint: true }).ino;
        throw new Error('injected re-encode database failure');
      });
      try {
        await expect(processingService.convertAssets(project.id, [source.id], {
          format: 'png', quality: 85, originalHandling: 'keep',
        })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        finalIno = fs.lstatSync(target, { bigint: true }).ino;
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(publishedIno).toBe(trustedIno);
      expect(finalIno).toBe(restoredIno);
      expect(fs.readFileSync(target)).toEqual(before);
      expect(convertWorkspaces()).toEqual([]);
    });

    // Old: restoreReencodedOutputs unlinked the foreign file at the source path because its
    // Number identity matched the published output, then restored the backup over it.
    it('does not unlink a foreign re-encode destination that only collides after Number rounding', async () => {
      const source = writeIndexedImage('Final/rounded-reencode.png');
      const target = path.join(projectDir, 'Final', 'rounded-reencode.png');
      const before = fs.readFileSync(target);
      const foreign = Buffer.from('foreign re-encode destination');
      const ids = mockExactFileIds();
      ids.assign(target, sourceIno);
      ids.autoAssign(at(target), trustedIno);
      let roundedIno;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        roundedIno = replaceWithForeign(ids, target, foreign);
        throw new Error('injected re-encode database failure');
      });
      try {
        await expect(processingService.convertAssets(project.id, [source.id], {
          format: 'png', quality: 85, originalHandling: 'keep',
        })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(roundedIno).toBe(Number(trustedIno));
      expect(fs.readFileSync(target)).toEqual(foreign);
      const [workspace, ...others] = convertWorkspaces();
      expect(others).toEqual([]);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.source'))).toEqual(before);
    });

    it('never restores a moved source from a foreign Originals file that only collides after Number rounding', async () => {
      const source = writeIndexedImage('Final/rounded-originals.png');
      const target = path.join(projectDir, 'Final', 'rounded-originals.png');
      const original = path.join(projectDir, 'Final', 'originals', 'rounded-originals.png');
      const foreign = Buffer.from('foreign originals file');
      const ids = mockExactFileIds();
      ids.assign(target, sourceIno);
      ids.autoAssign(at(original), trustedIno);
      let roundedIno;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        roundedIno = replaceWithForeign(ids, original, foreign);
        throw new Error('injected move database failure');
      });
      let failure;
      try {
        failure = await processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'move',
        }).then(() => null, (err) => err);
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(roundedIno).toBe(Number(trustedIno));
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.readFileSync(original)).toEqual(foreign);
      // The source is never recreated from, and the foreign file is never removed as, the copy.
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'rounded-originals.webp'))).toBe(false);
      expect(assetRepository.findById(source.id).relative_path).toBe('Final/rounded-originals.png');
      expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'originals-copy', check: 'restore-identity-mismatch' }),
        expect.objectContaining({ artifactRole: 'originals-copy', check: 'retained-unrestored' }),
      ]));
    });

    it('stages and restores a deleted source whose artifacts have exact IDs past 2^53', async () => {
      const source = writeIndexedImage('Final/large-id-staged.png');
      const target = path.join(projectDir, 'Final', 'large-id-staged.png');
      const before = fs.readFileSync(target);
      const ids = mockExactFileIds();
      ids.assign(target, sourceIno);
      ids.autoAssign((filePath) => isConvertStageFile(filePath, 'original'), copyIno);
      ids.autoAssign(at(target), restoredIno);
      let finalIno;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
        .mockImplementation(() => { throw new Error('injected delete database failure'); });
      try {
        await expect(processingService.convertAssets(project.id, [source.id], {
          format: 'webp', quality: 80, originalHandling: 'delete',
        })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        finalIno = fs.lstatSync(target, { bigint: true }).ino;
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(finalIno).toBe(restoredIno);
      expect(fs.readFileSync(target)).toEqual(before);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(convertWorkspaces()).toEqual([]);
    });
  });

  describe('descriptor-owned conversion publication', () => {
    const convertWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-convert-');
    const convertWorkspace = () => path.join(projectDir, '.creatorcrate-convert-staging');
    const MODES = Object.freeze({
      output: { format: 'webp', originalHandling: 'keep', copyRole: null },
      reencode: { format: 'png', originalHandling: 'keep', copyRole: 'original-backup' },
      move: { format: 'webp', originalHandling: 'move', copyRole: 'originals-copy' },
      delete: { format: 'webp', originalHandling: 'delete', copyRole: 'staged-original' },
    });

    function conversionPaths(name, mode) {
      const { format } = MODES[mode];
      const sourcePath = path.resolve(projectDir, 'Final', `${name}.png`);
      const outputPath = path.resolve(projectDir, 'Final', `${name}.${format}`);
      const originalPath = path.resolve(projectDir, 'Final', 'originals', `${name}.png`);
      // The owned copy of the source each mode makes (none for a plain new output).
      const isCopy = {
        output: () => false,
        reencode: (filePath) => isConvertStageFile(filePath, 'source'),
        move: (filePath) => filePath === originalPath,
        delete: (filePath) => isConvertStageFile(filePath, 'original'),
      }[mode];
      return { sourcePath, outputPath, originalPath, isCopy };
    }

    function convert(assetId, mode, extra = {}) {
      const { format, originalHandling } = MODES[mode];
      return processingService.convertAssets(project.id, [assetId], {
        format, quality: 80, originalHandling, ...extra,
      });
    }

    // Models the live SMB share, where every path reports its own inode number on dev 77: a
    // regular file's identity is assigned per (pathname, underlying object), so a hard link (or
    // any second name) never exposes its source's dev/ino, and a recreated file at the same path
    // gets a new identity. Directories keep their real IDs. Records the identity each exclusively
    // created file exposed through its own descriptor, in creation order.
    function mockSmbConversionIdentities() {
      const root = `${path.resolve(projectDir)}${path.sep}`;
      const realLstat = fs.lstatSync.bind(fs);
      const realOpen = fs.openSync.bind(fs);
      const realFstat = fs.fstatSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      const assigned = new Map();
      let nextIno = 7000n;
      const descriptors = new Map();
      const created = [];
      const identityFor = (filePath, stats, realIno) => {
        const resolved = path.resolve(String(filePath));
        if (!stats.isFile() || !resolved.startsWith(root)) return undefined;
        const key = `${resolved}|${realIno}`;
        if (!assigned.has(key)) assigned.set(key, nextIno++);
        return { dev: 77n, ino: assigned.get(key) };
      };
      const apply = (filePath, stats, realIno) => {
        const identity = stats && identityFor(filePath, stats, realIno);
        if (!identity) return stats;
        const cast = (value) => (typeof stats.ino === 'bigint' ? value : Number(value));
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          dev: cast(identity.dev),
          ino: cast(identity.ino),
        });
      };
      const spies = [
        vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
          const stats = realLstat(filePath, ...args);
          return stats ? apply(filePath, stats, realLstat(filePath, { bigint: true }).ino) : stats;
        }),
        vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          const descriptor = realOpen(filePath, flags, ...args);
          if (typeof filePath === 'string') descriptors.set(descriptor, { filePath, exclusive: isExclusiveOpen(flags) });
          return descriptor;
        }),
        vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
          const stats = realFstat(descriptor, ...args);
          const opened = descriptors.get(descriptor);
          if (!opened) return stats;
          const observed = apply(opened.filePath, stats, realFstat(descriptor, { bigint: true }).ino);
          if (opened.exclusive && !opened.recorded) {
            opened.recorded = true;
            created.push(`${observed.dev}:${observed.ino}`);
          }
          return observed;
        }),
        vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
          descriptors.delete(descriptor);
          return realClose(descriptor, ...args);
        }),
      ];
      return {
        created,
        idOf(filePath) {
          const stats = fs.lstatSync(filePath, { bigint: true });
          return `${stats.dev}:${stats.ino}`;
        },
        restore: () => spies.reverse().forEach((spy) => spy.mockRestore()),
      };
    }

    it.each([
      ['a new output', 'output', 2],
      ['a re-encode', 'reencode', 3],
      ['a move to Originals', 'move', 3],
      ['a delete-source conversion', 'delete', 3],
    ])('converts %s on SMB-like storage where every created file has its own identity', async (_label, mode, createdCount) => {
      const name = `smb-${mode}`;
      const source = writeIndexedImage(`Final/${name}.png`);
      const { sourcePath, outputPath, originalPath } = conversionPaths(name, mode);
      const sourceBytes = fs.readFileSync(sourcePath);
      const smb = mockSmbConversionIdentities();
      const linkSpy = vi.spyOn(fs, 'linkSync');
      let sourceId;
      let result;
      let linkCallCount;
      try {
        sourceId = smb.idOf(sourcePath);
        result = await convert(source.id, mode);
      } finally {
        linkCallCount = linkSpy.mock.calls.length;
        linkSpy.mockRestore();
        smb.restore();
      }

      expect(linkCallCount).toBe(0);
      expect(sourceId).toMatch(/^77:\d+$/);
      // Stage, public output and (per mode) backup, Originals copy or staged original: each
      // exclusively created with its own identity, none the source's.
      expect(smb.created).toHaveLength(createdCount);
      expect(smb.created.every((id) => id.startsWith('77:'))).toBe(true);
      expect(new Set([sourceId, ...smb.created]).size).toBe(createdCount + 1);
      expect(result.convertedCount).toBe(1);
      const output = assetRepository.findById(result.convertedAssetIds[0]);
      const outputStats = fs.statSync(outputPath);
      expect(output).toMatchObject({
        relative_path: path.relative(projectDir, outputPath).split(path.sep).join('/'),
        size_bytes: outputStats.size,
        modified_at: outputStats.mtime.toISOString(),
      });
      if (mode === 'output') expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      if (mode === 'reencode') expect(output.id).toBe(source.id);
      if (mode === 'move') {
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readFileSync(originalPath)).toEqual(sourceBytes);
        expect(assetRepository.findById(source.id)).toMatchObject({
          relative_path: 'Final/originals/smb-move.png',
          size_bytes: sourceBytes.length,
          modified_at: fs.statSync(originalPath).mtime.toISOString(),
        });
      }
      if (mode === 'delete') {
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(assetRepository.findById(source.id)).toBeUndefined();
      }
      expect(convertWorkspaces()).toEqual([]);
    });

    // Real-SMB shape: the public output's pathname reports post-close write times (T2) until the
    // pre-commit hash's own open settles them back to the creating descriptor's values (T1). The
    // post-hash/re-hash baseline is accepted and the settled values are what the index records.
    it('records a converted output whose SMB write times settle back during its pre-commit hash', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedImage('Final/smb-settle.png');
      const { outputPath } = conversionPaths('smb-settle', 'output');
      const smb = modelSmbTimeSettling((filePath) => filePath === outputPath);
      let result;
      try {
        result = await convert(source.id, 'output');
      } finally {
        smb.restore();
      }

      expect(smb.refreshed).toBe(true);
      const { observed } = smb;
      const settled = observed.at(-1);
      const postClose = settled + smb.postCloseStepNs;
      expect(observed).toContain(postClose);
      expect(observed.lastIndexOf(postClose)).toBeLessThan(observed.indexOf(settled));
      expect(observed.slice(observed.indexOf(settled)).every((value) => value === settled)).toBe(true);
      expect(assetRepository.findById(result.convertedAssetIds[0])).toMatchObject({
        size_bytes: fs.statSync(outputPath).size,
        modified_at: fs.statSync(outputPath).mtime.toISOString(),
      });
      expect(convertWorkspaces()).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).not.toHaveBeenCalled();
    });

    // SMB positive control on rollback: the restored source's write times settle during the
    // evidence-disposal hash; the staged original is still discarded.
    it('discards the staged original when the restored source settles during its cleanup hash', async () => {
      const source = writeIndexedImage('Final/smb-restore-settle.png');
      const { sourcePath } = conversionPaths('smb-restore-settle', 'delete');
      const sourceBytes = fs.readFileSync(sourcePath);
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
        .mockImplementation(() => { throw new Error('injected database failure'); });
      const smb = modelSmbTimeSettling((filePath) => filePath === sourcePath);
      let failure;
      try {
        failure = await convert(source.id, 'delete').then(() => null, (err) => err);
      } finally {
        smb.restore();
        applySpy.mockRestore();
      }

      expect(smb.refreshed).toBe(true);
      expect(smb.observed).toContain(smb.observed.at(-1) + smb.postCloseStepNs);
      expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(convertWorkspaces()).toEqual([]);
    });

    describe('created-but-unclaimed public output', () => {
      async function convertWithUnclaimedOutput(name, injectUnknownIdentity) {
        const source = writeIndexedImage(`Final/${name}.png`);
        const { sourcePath, outputPath } = conversionPaths(name, 'output');
        const sourceBytes = fs.readFileSync(sourcePath);
        const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions');
        const restoreInjection = injectUnknownIdentity(outputPath);
        let failure;
        let applyCallCount;
        try {
          failure = await convert(source.id, 'output').then(() => null, (err) => err);
        } finally {
          restoreInjection();
          applyCallCount = applySpy.mock.calls.length;
          applySpy.mockRestore();
        }
        expect(applyCallCount).toBe(0);
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        // The created public path exists but was never proven ours: never adopted or removed.
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(assetRepository.findByProjectIdAndPath(project.id, `Final/${name}.webp`)).toBeUndefined();
        // Its stage is retained as the unresolved publication's evidence.
        expect(stageNames(convertWorkspace())).toEqual(['0.output']);
        expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
          expect.objectContaining({
            artifactRole: 'published-output', check: 'public-output-identity-inspection-failed',
            cleanup: 'recovery-critical',
          }),
          expect.objectContaining({ artifactRole: 'published-output', check: 'rollback-ownership-unproven' }),
          expect.objectContaining({ artifactRole: 'stage-output', check: 'retained-unresolved-publication' }),
        ]));
      }

      it('never claims or removes a public output whose first descriptor inspection fails', async () => {
        await convertWithUnclaimedOutput('unclaimed-fstat', (outputPath) => {
          const realOpen = fs.openSync.bind(fs);
          const realFstat = fs.fstatSync.bind(fs);
          const created = new Set();
          const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
            const descriptor = realOpen(filePath, flags, ...args);
            if (typeof filePath === 'string' && path.resolve(filePath) === outputPath && isExclusiveOpen(flags)) {
              created.add(descriptor);
            }
            return descriptor;
          });
          const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
            if (created.delete(descriptor)) {
              throw Object.assign(new Error('injected first descriptor inspection failure'), { code: 'EIO' });
            }
            return realFstat(descriptor, ...args);
          });
          return () => {
            fstatSpy.mockRestore();
            openSpy.mockRestore();
          };
        });
      });

      it('never claims or removes a public output whose descriptor exposes no exact identity', async () => {
        await convertWithUnclaimedOutput('unclaimed-zero-id', (outputPath) => mockStatOverrides(
          (filePath) => (filePath === outputPath ? { dev: 0, ino: 0 } : null),
        ));
      });

      // Control: when the exclusive open itself fails, nothing was created, so there is no
      // unclaimed path and the foreign occupant is an ordinary destination conflict.
      it('fails ordinarily without an unclaimed output when the exclusive open itself fails', async () => {
        const source = writeIndexedImage('Final/unclaimed-eexist.png');
        const { sourcePath, outputPath } = conversionPaths('unclaimed-eexist', 'output');
        const foreign = Buffer.from('foreign output that appeared');
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (filePath === outputPath && isExclusiveOpen(flags) && !fs.existsSync(outputPath)) {
              fs.writeFileSync(outputPath, foreign);
            }
          },
        });
        let failure;
        try {
          failure = await convert(source.id, 'output').then(() => null, (err) => err);
        } finally {
          unhook();
        }
        expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        expect(fs.readFileSync(outputPath)).toEqual(foreign);
        expect(fs.existsSync(sourcePath)).toBe(true);
        expect(convertWorkspaces()).toEqual([]);
      });
    });

    // Identity staying the same must not be enough: the owned copy of the source is rewritten
    // IN PLACE (same identity) while the source itself is re-verified, i.e. after the copy's own
    // validation and before the final re-proof that precedes the source unlink.
    it.each(['reencode', 'move', 'delete'])(
      'never removes the source when its owned copy changes in place before the unlink (%s)',
      async (mode) => {
        const name = `copy-tamper-${mode}`;
        const source = writeIndexedImage(`Final/${name}.png`);
        const { sourcePath, outputPath, originalPath, isCopy } = conversionPaths(name, mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const sourceIdentity = fs.lstatSync(sourcePath, { bigint: true });
        let copyPath = null;
        let mutated = false;
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (isExclusiveOpen(flags) && isCopy(filePath)) copyPath = filePath;
            else if (copyPath && !mutated && isReadOpen(flags) && filePath === sourcePath) {
              mutated = true;
              rewriteInPlace(copyPath, Buffer.from('tampered owned copy'));
            }
          },
        });
        const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions');
        let failure;
        let applyCallCount;
        try {
          failure = await convert(source.id, mode).then(() => null, (err) => err);
        } finally {
          applyCallCount = applySpy.mock.calls.length;
          applySpy.mockRestore();
          unhook();
        }

        expect(mutated).toBe(true);
        expect(applyCallCount).toBe(0);
        expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          artifactRole: MODES[mode].copyRole, check: 'remove-final-copy-content-mismatch', identity: 'matched',
        }));
        const after = fs.lstatSync(sourcePath, { bigint: true });
        expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: sourceIdentity.dev, ino: sourceIdentity.ino });
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        if (mode !== 'reencode') expect(fs.existsSync(outputPath)).toBe(false);
        expect(fs.existsSync(originalPath)).toBe(false);
        expect(assetRepository.findById(source.id).relative_path).toBe(`Final/${name}.png`);
        // The tampered copy was still CreatorCrate's own file (exact identity): it is discarded.
        expect(convertWorkspaces()).toEqual([]);
      },
    );

    // A restored source is rewritten in place right after the evidence-disposal hash has read it
    // (the write lands after the hash, before its post-hash metadata check). The last good copy
    // of the source must be kept and recovery required.
    it.each(['reencode', 'move', 'delete'])(
      'keeps the owned copy when the restored source changes during its final evidence hash (%s)',
      async (mode) => {
        const name = `restored-tamper-${mode}`;
        const source = writeIndexedImage(`Final/${name}.png`);
        const { sourcePath, originalPath } = conversionPaths(name, mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const tampered = Buffer.from('restored source rewritten in place');
        let databaseFailed = false;
        let restoreCreated = false;
        let mutated = false;
        const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
          databaseFailed = true;
          throw new Error('injected database failure');
        });
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (databaseFailed && filePath === sourcePath && isExclusiveOpen(flags)) restoreCreated = true;
          },
          onClose(filePath, flags) {
            if (!restoreCreated || mutated || filePath !== sourcePath || !isReadOpen(flags)) return;
            mutated = true;
            rewriteInPlace(sourcePath, tampered);
          },
        });
        let failure;
        try {
          failure = await convert(source.id, mode).then(() => null, (err) => err);
        } finally {
          unhook();
          applySpy.mockRestore();
        }

        expect(mutated).toBe(true);
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
          expect.objectContaining({ artifactRole: 'restored-source', check: 'restored-source-content-mismatch' }),
          expect.objectContaining({
            artifactRole: MODES[mode].copyRole, check: 'retained-restored-source-changed', cleanup: 'recovery-critical',
          }),
        ]));
        // The changed source is never repaired; the last good copy is kept.
        expect(fs.readFileSync(sourcePath)).toEqual(tampered);
        const copyPath = mode === 'move'
          ? originalPath
          : stageArtifact(convertWorkspace(), mode === 'reencode' ? '0.source' : '0.original');
        expect(fs.readFileSync(copyPath)).toEqual(sourceBytes);
        expect(assetRepository.findById(source.id).relative_path).toBe(`Final/${name}.png`);
      },
    );

    describe('cleanup safe versus complete', () => {
      function failUnlinks(matches) {
        const realUnlink = fs.unlinkSync.bind(fs);
        const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          if (matches(path.resolve(String(filePath)))) {
            throw Object.assign(new Error('injected private unlink failure'), { code: 'EIO' });
          }
          return realUnlink(filePath, ...args);
        });
        return () => spy.mockRestore();
      }

      it('completes a committed conversion and reports unremovable private copies as residue', async () => {
        const applicationLogger = { warn: vi.fn(), error: vi.fn() };
        processingService = createProcessingService({ applicationLogger });
        const source = writeIndexedImage('Final/committed-residue.png');
        const { sourcePath, outputPath } = conversionPaths('committed-residue', 'delete');
        const restoreUnlinks = failUnlinks((filePath) => isConvertStageFile(filePath, 'output')
          || isConvertStageFile(filePath, 'original'));
        let result;
        try {
          result = await convert(source.id, 'delete');
        } finally {
          restoreUnlinks();
        }

        expect(result.convertedCount).toBe(1);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(assetRepository.findById(source.id)).toBeUndefined();
        expect(stageNames(convertWorkspace())).toEqual(['0.original', '0.output']);
        expect(applicationLogger.error).not.toHaveBeenCalled();
        expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
          event: 'processing.cleanup.residue',
          context: expect.objectContaining({
            operation: 'convert',
            cleanupSucceeded: false,
            failures: expect.arrayContaining([
              expect.objectContaining({ artifactRole: 'stage-output', check: 'cleanup-unlink-failed', cleanup: 'residue' }),
              expect.objectContaining({ artifactRole: 'staged-original', check: 'cleanup-unlink-failed', cleanup: 'residue' }),
            ]),
          }),
        }));
      });

      it('reports a verified rollback with private residue as the underlying ordinary failure', async () => {
        const applicationLogger = { warn: vi.fn(), error: vi.fn() };
        processingService = createProcessingService({ applicationLogger });
        const source = writeIndexedImage('Final/rollback-residue.png');
        const { sourcePath, outputPath } = conversionPaths('rollback-residue', 'reencode');
        const sourceBytes = fs.readFileSync(sourcePath);
        const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions')
          .mockImplementation(() => { throw new Error('injected database failure'); });
        const restoreUnlinks = failUnlinks((filePath) => isConvertStageFile(filePath, 'output'));
        let failure;
        try {
          failure = await convert(source.id, 'reencode').then(() => null, (err) => err);
        } finally {
          restoreUnlinks();
          applySpy.mockRestore();
        }

        expect(outputPath).toBe(sourcePath);
        expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        expect(failure.recoveryDiagnostics).toMatchObject({ restored: true, cleanupSucceeded: false });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          artifactRole: 'stage-output', check: 'cleanup-unlink-failed', cleanup: 'residue',
        }));
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(stageNames(convertWorkspace())).toEqual(['0.output']);
        expect(applicationLogger.error).not.toHaveBeenCalled();
        expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
          event: 'processing.recovery.succeeded',
        }));
      });

      // A private copy whose exclusive create succeeded but whose descriptor exposed no identity
      // is never claimed. The source was never touched, so it is safe residue, not recovery.
      it.each(['reencode', 'delete'])(
        'leaves an unclaimed private copy as residue before the source is touched (%s)',
        async (mode) => {
          const name = `unclaimed-copy-${mode}`;
          const source = writeIndexedImage(`Final/${name}.png`);
          const { sourcePath, outputPath, isCopy } = conversionPaths(name, mode);
          const sourceBytes = fs.readFileSync(sourcePath);
          const sourceIdentity = fs.lstatSync(sourcePath, { bigint: true });
          const restoreStats = mockStatOverrides((filePath) => (isCopy(filePath) ? { dev: 0, ino: 0 } : null));
          let failure;
          try {
            failure = await convert(source.id, mode).then(() => null, (err) => err);
          } finally {
            restoreStats();
          }

          expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
          expect(failure.recoveryDiagnostics).toMatchObject({ restored: true, cleanupSucceeded: false });
          expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
            expect.objectContaining({
              artifactRole: MODES[mode].copyRole, check: 'copy-identity-inspection-failed', proof: 'identity-unknown',
            }),
            expect.objectContaining({ artifactRole: MODES[mode].copyRole, cleanup: 'residue' }),
          ]));
          const after = fs.lstatSync(sourcePath, { bigint: true });
          expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: sourceIdentity.dev, ino: sourceIdentity.ino });
          expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
          if (mode === 'delete') expect(fs.existsSync(outputPath)).toBe(false);
          expect(stageNames(convertWorkspace())).toEqual([mode === 'reencode' ? '0.source' : '0.original']);
        },
      );
    });

    describe('unknown exact identities', () => {
      it.each(['reencode', 'move', 'delete'])(
        'refuses a zero-ID source before copying or removing it (%s)',
        async (mode) => {
          const name = `zero-source-${mode}`;
          const source = writeIndexedImage(`Final/${name}.png`);
          const { sourcePath, outputPath, originalPath } = conversionPaths(name, mode);
          const sourceBytes = fs.readFileSync(sourcePath);
          const restoreStats = mockStatOverrides((filePath) => (filePath === sourcePath ? { dev: 0, ino: 0 } : null));
          let failure;
          try {
            failure = await convert(source.id, mode).then(() => null, (err) => err);
          } finally {
            restoreStats();
          }

          expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
          expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
            artifactRole: MODES[mode].copyRole, check: 'copy-create-failed', proof: 'reference-identity-unknown',
          }));
          expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
          if (mode !== 'reencode') expect(fs.existsSync(outputPath)).toBe(false);
          expect(fs.existsSync(originalPath)).toBe(false);
          expect(assetRepository.findById(source.id).relative_path).toBe(`Final/${name}.png`);
          expect(convertWorkspaces()).toEqual([]);
        },
      );

      // Keeping the source needs no source identity at all: only the output is created.
      it('converts a zero-ID source into a new output when the source is kept', async () => {
        const source = writeIndexedImage('Final/zero-source-keep.png');
        const { sourcePath, outputPath } = conversionPaths('zero-source-keep', 'output');
        const restoreStats = mockStatOverrides((filePath) => (filePath === sourcePath ? { dev: 0, ino: 0 } : null));
        try {
          await convert(source.id, 'output');
        } finally {
          restoreStats();
        }
        expect(fs.existsSync(sourcePath)).toBe(true);
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(convertWorkspaces()).toEqual([]);
      });

      it.each(['reencode', 'move', 'delete'])(
        'never adopts a restored source whose descriptor exposes no exact identity (%s)',
        async (mode) => {
          const name = `zero-restore-${mode}`;
          const source = writeIndexedImage(`Final/${name}.png`);
          const { sourcePath, originalPath } = conversionPaths(name, mode);
          const sourceBytes = fs.readFileSync(sourcePath);
          let databaseFailed = false;
          let restoring = false;
          const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
            databaseFailed = true;
            throw new Error('injected database failure');
          });
          // Only the restore's own exclusive create (after any replacement was withdrawn) exposes
          // an unknown identity.
          const restoreStats = mockStatOverrides((filePath) => (
            restoring && filePath === sourcePath ? { dev: 0, ino: 0 } : null));
          const unhook = hookFileDescriptors({
            onOpen(filePath, flags) {
              if (databaseFailed && filePath === sourcePath && isExclusiveOpen(flags)) restoring = true;
            },
          });
          let failure;
          try {
            failure = await convert(source.id, mode).then(() => null, (err) => err);
          } finally {
            unhook();
            restoreStats();
            applySpy.mockRestore();
          }

          expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
          expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
            expect.objectContaining({ artifactRole: 'restored-source', check: 'restore-create-failed', proof: 'identity-unknown' }),
            expect.objectContaining({ artifactRole: MODES[mode].copyRole, check: 'retained-unrestored' }),
          ]));
          // The unclaimed path created at the source is left in place; the copy stays.
          expect(fs.existsSync(sourcePath)).toBe(true);
          const copyPath = mode === 'move'
            ? originalPath
            : stageArtifact(convertWorkspace(), mode === 'reencode' ? '0.source' : '0.original');
          expect(fs.readFileSync(copyPath)).toEqual(sourceBytes);
        },
      );
    });

    describe('EEXIST never overwrites or adopts', () => {
      it.each(['reencode', 'delete'])('never adopts a foreign file at the private copy path (%s)', async (mode) => {
        const name = `eexist-copy-${mode}`;
        const source = writeIndexedImage(`Final/${name}.png`);
        const { sourcePath, isCopy } = conversionPaths(name, mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const foreign = Buffer.from('foreign private copy');
        let collided = false;
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (collided || !isExclusiveOpen(flags) || !isCopy(filePath)) return;
            collided = true;
            fs.writeFileSync(filePath, foreign);
          },
        });
        let failure;
        try {
          failure = await convert(source.id, mode).then(() => null, (err) => err);
        } finally {
          unhook();
        }

        expect(collided).toBe(true);
        expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        const copyPath = stageArtifact(convertWorkspace(), mode === 'reencode' ? '0.source' : '0.original');
        expect(fs.readFileSync(copyPath)).toEqual(foreign);
      });

      it('never adopts or overwrites a foreign file that appears at the Originals destination', async () => {
        const source = writeIndexedImage('Final/eexist-originals.png');
        const { sourcePath, outputPath, originalPath } = conversionPaths('eexist-originals', 'move');
        const sourceBytes = fs.readFileSync(sourcePath);
        const foreign = Buffer.from('foreign originals file');
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (filePath === originalPath && isExclusiveOpen(flags) && !fs.existsSync(originalPath)) {
              fs.writeFileSync(originalPath, foreign);
            }
          },
        });
        let failure;
        try {
          failure = await convert(source.id, 'move').then(() => null, (err) => err);
        } finally {
          unhook();
        }

        expect(failure).toMatchObject({ code: 'ORIGINAL_DESTINATION_CONFLICT' });
        expect(fs.readFileSync(originalPath)).toEqual(foreign);
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(fs.existsSync(outputPath)).toBe(false);
        expect(convertWorkspaces()).toEqual([]);
      });

      it.each(['reencode', 'move', 'delete'])(
        'never overwrites a foreign file that appears at the source path before its restore (%s)',
        async (mode) => {
          const name = `eexist-restore-${mode}`;
          const source = writeIndexedImage(`Final/${name}.png`);
          const { sourcePath, originalPath } = conversionPaths(name, mode);
          const sourceBytes = fs.readFileSync(sourcePath);
          const foreign = Buffer.from('foreign file at the source path');
          let databaseFailed = false;
          const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
            databaseFailed = true;
            // A re-encode's source path still holds CreatorCrate's replacement until rollback.
            if (mode !== 'reencode') fs.writeFileSync(sourcePath, foreign);
            throw new Error('injected database failure');
          });
          const realUnlink = fs.unlinkSync.bind(fs);
          const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
            const result = realUnlink(filePath, ...args);
            if (databaseFailed && mode === 'reencode' && path.resolve(String(filePath)) === sourcePath) {
              fs.writeFileSync(sourcePath, foreign);
            }
            return result;
          });
          let failure;
          try {
            failure = await convert(source.id, mode).then(() => null, (err) => err);
          } finally {
            unlinkSpy.mockRestore();
            applySpy.mockRestore();
          }

          expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
          expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
            artifactRole: MODES[mode].copyRole, check: 'restore-source-present',
          }));
          expect(fs.readFileSync(sourcePath)).toEqual(foreign);
          const copyPath = mode === 'move'
            ? originalPath
            : stageArtifact(convertWorkspace(), mode === 'reencode' ? '0.source' : '0.original');
          expect(fs.readFileSync(copyPath)).toEqual(sourceBytes);
        },
      );
    });

    // Cross-item staleness: output A is validated, then B is read; A is rewritten IN PLACE
    // (same identity) during B's read. The final metadata sweep refuses to record A.
    it('never records an earlier output rewritten in place while a later output is validated', async () => {
      const first = writeIndexedImage('Final/cross-a.png');
      const second = writeIndexedImage('Final/cross-b.png');
      const outputA = path.resolve(projectDir, 'Final', 'cross-a.webp');
      const outputB = path.resolve(projectDir, 'Final', 'cross-b.webp');
      let bCreated = false;
      let mutated = false;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetConversions');
      const unhook = hookFileDescriptors({
        onOpen(filePath, flags) {
          if (filePath === outputB && isExclusiveOpen(flags)) bCreated = true;
          else if (bCreated && !mutated && filePath === outputB && isReadOpen(flags)) {
            mutated = true;
            rewriteInPlace(outputA, Buffer.from('output A rewritten in place'));
          }
        },
      });
      let failure;
      let applyCallCount;
      try {
        failure = await processingService.convertAssets(project.id, [first.id, second.id], {
          format: 'webp', quality: 80, originalHandling: 'keep',
        }).then(() => null, (err) => err);
      } finally {
        unhook();
        applyCallCount = applySpy.mock.calls.length;
        applySpy.mockRestore();
      }

      expect(mutated).toBe(true);
      expect(applyCallCount).toBe(0);
      expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        itemIndex: 0, artifactRole: 'published-output', check: 'precommit-final-content-mismatch', identity: 'matched',
      }));
      // Both owned outputs are rolled back by their exact identities; nothing is recorded.
      expect(fs.existsSync(outputA)).toBe(false);
      expect(fs.existsSync(outputB)).toBe(false);
      expect(assetRepository.findByProjectIdAndPath(project.id, 'Final/cross-a.webp')).toBeUndefined();
      expect(convertWorkspaces()).toEqual([]);
    });

    it('converts the committed result of an earlier conversion run', async () => {
      const source = writeIndexedImage('Final/repeat.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'repeat.png');

      const runA = await convert(source.id, 'reencode', { quality: 90 });
      const afterA = fs.readFileSync(sourcePath);
      expect(assetRepository.findById(source.id)).toMatchObject({ source_generation: 1, size_bytes: afterA.length });

      const runB = await convert(source.id, 'reencode', { quality: 40 });
      expect(runB.convertedAssetIds).toEqual(runA.convertedAssetIds);
      expect(assetRepository.findById(source.id)).toMatchObject({
        source_generation: 2,
        size_bytes: fs.statSync(sourcePath).size,
        modified_at: fs.statSync(sourcePath).mtime.toISOString(),
      });

      // A new output from the re-encoded source, then a re-encode of that committed output.
      const runC = await convert(source.id, 'output');
      const webp = assetRepository.findById(runC.convertedAssetIds[0]);
      expect(webp.relative_path).toBe('Final/repeat.webp');
      await processingService.convertAssets(project.id, [webp.id], {
        format: 'webp', quality: 30, originalHandling: 'keep',
      });
      expect(assetRepository.findById(webp.id)).toMatchObject({
        source_generation: 1,
        size_bytes: fs.statSync(path.join(projectDir, 'Final', 'repeat.webp')).size,
      });
      expect(convertWorkspaces()).toEqual([]);
    });
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
      correlationId: 'job-recovery-failed',
      context: expect.objectContaining({
        operation: 'convert',
        assetCount: 1,
        phase: 'recovery',
        recoveryPhase: 'database',
        restored: false,
        cleanupSucceeded: false,
      }),
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
    const deferred = new Map();
    const staged = [];
    let resolveBothStaged;
    const bothStaged = new Promise((resolve) => { resolveBothStaged = resolve; });
    const restoreWrites = interceptStageWrites(isPromptStagePath, (stagePath, write) => (
      new Promise((resolve, reject) => {
        staged.push(stagePath);
        deferred.set(stagePath, () => write().then(resolve, reject));
        if (staged.length === 2) resolveBothStaged();
      })
    ));
    // Publication of each item begins by removing its verified source.
    const publicationTargets = [];
    const realUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
      if (targets.includes(path.resolve(String(filePath)))) publicationTargets.push(path.resolve(String(filePath)));
      return realUnlink(filePath, ...args);
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
      unlinkSpy.mockRestore();
      restoreWrites();
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
    const stageWrites = [];
    let resumeActive;
    let resolveInitialWorkers;
    const initialWorkers = new Promise((resolve) => { resolveInitialWorkers = resolve; });
    const restoreWrites = interceptStageWrites(isPromptStagePath, (stagePath, write) => {
      // Stage names carry a per-operation token: `<token>.<index>.png`.
      const basename = path.basename(stagePath).replace(/^[0-9a-f]{16}./, '');
      stageWrites.push(basename);
      if (stageWrites.length === 2) resolveInitialWorkers();
      if (basename === '0.png') return Promise.reject(new Error('injected Prompt stage failure'));
      if (basename === '1.png') {
        return new Promise((resolve, reject) => {
          resumeActive = () => write().then(resolve, reject);
        });
      }
      return write();
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
      restoreWrites();
    }

    expect(stageWrites).toEqual(['0.png', '1.png']);
    targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-'))
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
    const restoreWrites = interceptStageWrites(isPromptStagePath, () => (
      Promise.reject(new Error('injected staged write failure'))
    ));

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      restoreWrites();
    }

    // The failed stage was still the exclusively created file, so cleanup removed it.
    expect(fs.readFileSync(target)).toEqual(before);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-'))
      .toEqual([]);
  });

  // D2: Old: the stage's owned exact identity was captured by statting the pathname after the
  // write closed, so a file substituted at that boundary became "our stage" and later exact
  // continuity checks proved the wrong file.
  it('never claims or removes a foreign file that replaced a Prompt stage after its descriptor closed', async () => {
    const source = writeIndexedPromptPng('Final/stage-replaced-after-close.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'stage-replaced-after-close.png');
    const before = fs.readFileSync(target);
    const foreign = Buffer.from('foreign replacement of the Prompt stage');
    const race = replaceStageAfterClose(
      (filePath) => isPromptStagePath(filePath),
      (stagePath) => replaceWithForeignFile(stagePath, foreign),
    );
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    const linkSpy = vi.spyOn(fs, 'linkSync');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toBeInstanceOf(AssetProcessingError);
      expect(race.path).toBeDefined();
      expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(filePath) === race.path)).toEqual([]);
      // Nothing is ever published from the foreign file.
      expect(linkSpy.mock.calls.filter(([fromPath]) => path.resolve(fromPath) === race.path)).toEqual([]);
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
      race.restore();
    }

    expect(fs.readFileSync(race.path)).toEqual(foreign);
    expect(fs.readFileSync(target)).toEqual(before);
    fs.rmSync(path.dirname(race.path), { recursive: true, force: true });
  });

  // D2: after a failed stage write, error cleanup may remove the stage only while the
  // pathname is still the file CreatorCrate opened exclusively.
  it('never removes a foreign file that replaced a Prompt stage before write-error cleanup', async () => {
    const source = writeIndexedPromptPng('Final/stage-failure-replaced.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'stage-failure-replaced.png');
    const before = fs.readFileSync(target);
    const foreign = Buffer.from('foreign replacement of the failed stage');
    let stagePath;
    const restoreWrites = interceptStageWrites(isPromptStagePath, (filePath) => {
      stagePath = filePath;
      fs.unlinkSync(filePath);
      fs.writeFileSync(filePath, foreign);
      return Promise.reject(new Error('injected staged write failure'));
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toBeInstanceOf(AssetProcessingError);
      expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(filePath) === path.resolve(stagePath)))
        .toHaveLength(1); // only the test's own replacement unlink
    } finally {
      unlinkSpy.mockRestore();
      restoreWrites();
    }

    expect(fs.readFileSync(stagePath)).toEqual(foreign);
    expect(fs.readFileSync(target)).toEqual(before);
    fs.rmSync(path.dirname(stagePath), { recursive: true, force: true });
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

  // A foreign writer replaces the third replacement right after CreatorCrate closes it, so its
  // pathname no longer is the descriptor-created file: rollback restores the two owned
  // publications in reverse order and keeps the third path, its stage and its backup.
  it('restores owned Prompt publications in reverse order and keeps a replaced one', async () => {
    const sources = ['first', 'second', 'third'].map((name) => writeIndexedPromptPng(
      `Final/multi-publication-${name}.png`,
      'parameters',
      `original-${name}`,
    ));
    const targets = sources.map((source) => path.resolve(projectDir, ...source.relative_path.split('/')));
    const before = targets.map((target) => fs.readFileSync(target));
    const metadata = sources.map((source) => ({
      id: source.id,
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
    }));
    const foreign = Buffer.from('foreign replacement of the third publication');
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    const restorationOrder = [];
    const publicDescriptors = new Map();
    let rollingBack = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      const descriptor = realOpen(filePath, flags, ...args);
      const index = targets.indexOf(path.resolve(String(filePath)));
      if (index >= 0 && flags === 'wx+') {
        if (rollingBack) restorationOrder.push(path.basename(targets[index]));
        else publicDescriptors.set(descriptor, index);
      }
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
      const result = realClose(descriptor, ...args);
      const index = publicDescriptors.get(descriptor);
      publicDescriptors.delete(descriptor);
      if (index === 2) {
        replaceWithForeignFile(targets[2], foreign);
        rollingBack = true;
      }
      return result;
    });

    const options = { positive: { rules: [{ type: 'append', text: ' changed' }] } };
    try {
      await expect(processingService.editWorkflowPrompts(project.id, sources.map(({ id }) => id), options))
        .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(restorationOrder).toEqual([path.basename(targets[1]), path.basename(targets[0])]);
    expect(fs.readFileSync(targets[0])).toEqual(before[0]);
    expect(fs.readFileSync(targets[1])).toEqual(before[1]);
    expect(fs.readFileSync(targets[2])).toEqual(foreign);
    metadata.forEach((expected) => expect(assetRepository.findById(expected.id)).toMatchObject(expected));
    const [workspace, ...others] = stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-');
    expect(others).toEqual([]);
    const edited = editWorkflowPromptsInPng(before[2], options).buffer;
    expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '2.png'))).toEqual(edited);
    expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '2.original'))).toEqual(before[2]);
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
    const targets = sources.map((source) => path.resolve(projectDir, ...source.relative_path.split('/')));
    const before = targets.map((target) => fs.readFileSync(target));
    const metadata = sources.map((source) => ({ id: source.id, size_bytes: source.size_bytes, modified_at: source.modified_at }));
    const realOpen = fs.openSync.bind(fs);
    const restorationOrder = [];
    let rollingBack = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      if (rollingBack && flags === 'wx+' && targets.includes(path.resolve(String(filePath)))) {
        restorationOrder.push(path.basename(String(filePath)));
      }
      return realOpen(filePath, flags, ...args);
    });
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
      rollingBack = true;
      throw new Error('injected multi-asset database failure');
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, sources.map(({ id }) => id), {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    } finally {
      applySpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(restorationOrder).toEqual([
      path.basename(targets[2]), path.basename(targets[1]), path.basename(targets[0]),
    ]);
    targets.forEach((target, index) => {
      expect(fs.readFileSync(target)).toEqual(before[index]);
      // Each recreated original keeps the mtime its unchanged row records.
      expect(fs.statSync(target).mtime.toISOString()).toBe(metadata[index].modified_at);
    });
    metadata.forEach((expected) => expect(assetRepository.findById(expected.id)).toMatchObject(expected));
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-'))
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

    const staging = stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-');
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(target)).toEqual(unexpected);
    expect(fs.readFileSync(stageArtifact(path.join(projectDir, staging[0]), '0.original'))).toEqual(before);
    expect(assetRepository.findById(source.id)).toMatchObject({ size_bytes: source.size_bytes, modified_at: source.modified_at });
  });

  // The replacement's ownership was recorded from its own exclusive descriptor before any byte
  // was written, so a failed post-close pathname check never strands it: rollback removes
  // exactly that file (still the owned identity) and recreates the original.
  it('restores the original when an owned Prompt replacement fails its pathname verification', async () => {
    const source = writeIndexedPromptPng('Final/published-recovery.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'published-recovery.png');
    const before = fs.readFileSync(target);
    const realLstat = fs.lstatSync.bind(fs);
    const realOpen = fs.openSync.bind(fs);
    let published = false;
    let verificationFailed = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      if (flags === 'wx+' && path.resolve(String(filePath)) === target) published = true;
      return realOpen(filePath, flags, ...args);
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (published && !verificationFailed && path.resolve(String(filePath)) === target) {
        verificationFailed = true;
        throw Object.assign(new Error('injected output inspection failure'), { code: 'EIO' });
      }
      return realLstat(filePath, ...args);
    });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(verificationFailed).toBe(true);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id)).toMatchObject({ size_bytes: source.size_bytes, modified_at: source.modified_at });
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-')).toEqual([]);
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
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-'))
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
      // The first pathname inspection is the post-close continuity check against the
      // descriptor-derived identity; it fails closed, and cleanup still removes the stage.
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      lstatSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-'))
      .toEqual([]);
  });

  it('captures and cleans a Prompt backup created before normal bookkeeping fails', async () => {
    const source = writeIndexedPromptPng('Final/late-backup-capture.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'late-backup-capture.png');
    const before = fs.readFileSync(target);
    const realLstat = fs.lstatSync.bind(fs);
    let failed = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (!failed && isPromptBackupPath(filePath)) {
        failed = true;
        throw new Error('injected backup bookkeeping failure');
      }
      return realLstat(filePath, ...args);
    });

    try {
      // The first backup pathname inspection is the post-close continuity check against the
      // descriptor-derived identity; it fails closed before the source is touched, and
      // cleanup still removes the owned backup.
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    } finally {
      lstatSpy.mockRestore();
    }

    expect(failed).toBe(true);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-'))
      .toEqual([]);
  });

  it('leaves the Prompt source untouched and removes the partial backup when the backup copy fails', async () => {
    const source = writeIndexedPromptPng('Final/backup-copy-failure.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'backup-copy-failure.png');
    const before = fs.readFileSync(target);
    const restoreWrites = interceptDescriptorWrites(
      (filePath, flags) => flags === 'wx+' && isPromptBackupPath(filePath),
      () => Object.assign(new Error('injected backup write failure'), { code: 'EIO' }),
    );
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === target)).toEqual([]);
    } finally {
      unlinkSpy.mockRestore();
      restoreWrites();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(assetRepository.findById(source.id)).toMatchObject({ size_bytes: source.size_bytes, modified_at: source.modified_at });
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-')).toEqual([]);
  });

  // Live SMB regression: the share gives every path its own inode number, so the old
  // `.original` hard link reported 77:1842051 for a source reporting 77:10775; strict alias
  // proof rejected it and gated the untouched project with RECOVERY_REQUIRED. Every Prompt
  // artifact is now its own descriptor-owned file whose identity is expected to differ.
  it('edits a Workflow Prompt on SMB-like storage where every created file has its own identity', async () => {
    const applicationLogger = { warn: vi.fn(), error: vi.fn() };
    processingService = createProcessingService({ applicationLogger });
    const source = writeIndexedPromptPng('Final/smb-prompt.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'smb-prompt.png');
    const before = fs.readFileSync(target);
    const options = { positive: { rules: [{ type: 'append', text: ' changed' }] } };
    const expected = editWorkflowPromptsInPng(before, options).buffer;
    const smb = mockSmbPromptIdentities(target, {
      source: { dev: 77n, ino: 10775n },
      backup: { dev: 77n, ino: 1842051n },
      stage: { dev: 77n, ino: 1842052n },
      replacements: [{ dev: 77n, ino: 2903117n }],
    });
    const linkSpy = vi.spyOn(fs, 'linkSync');
    let preRun;
    let published;
    let result;

    try {
      preRun = fs.lstatSync(target, { bigint: true });
      result = await processingService.editWorkflowPrompts(project.id, [source.id], options);
      published = fs.lstatSync(target, { bigint: true });
    } finally {
      linkSpy.mockRestore();
      smb.restore();
    }

    expect(result).toMatchObject({ status: 'completed', changedCount: 1, changedAssetIds: [source.id] });
    expect(linkSpy).not.toHaveBeenCalled();
    expect(`${preRun.dev}:${preRun.ino}`).toBe('77:10775');
    // Stage, backup and public replacement each own the identity their own descriptor exposed.
    expect(smb.created).toEqual(['77:1842052', '77:1842051', '77:2903117']);
    expect(`${published.dev}:${published.ino}`).toBe('77:2903117');
    expect(fs.readFileSync(target)).toEqual(expected);
    expect(assetRepository.findById(source.id)).toMatchObject({
      size_bytes: expected.length,
      modified_at: fs.statSync(target).mtime.toISOString(),
      source_generation: source.source_generation + 1,
      is_present: 1,
    });
    expect(promptWorkspaces()).toEqual([]);
    expect(applicationLogger.error).not.toHaveBeenCalled();
    expect(applicationLogger.warn).not.toHaveBeenCalled();
  });

  // A foreign file with the original's exact bytes replaces the owned backup after its copy
  // completed. The source was never touched, so the edit fails as an ordinary failure before
  // the source is removed, and the foreign path is neither claimed nor unlinked.
  it('never claims a foreign file that replaced the owned Prompt backup before the source was touched', async () => {
    const applicationLogger = { warn: vi.fn(), error: vi.fn() };
    processingService = createProcessingService({ applicationLogger });
    const source = writeIndexedPromptPng('Final/replaced-backup-early.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'replaced-backup-early.png');
    const before = fs.readFileSync(target);
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    let copySource;
    let backupPath;
    let foreignIno;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      const descriptor = realOpen(filePath, flags, ...args);
      if (copySource === undefined && flags === 'r' && path.resolve(String(filePath)) === target) copySource = descriptor;
      if (flags === 'wx+' && isPromptBackupPath(filePath)) backupPath = path.resolve(String(filePath));
      return descriptor;
    });
    // The backup copy closes its source descriptor only after the backup was verified.
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
      const result = realClose(descriptor, ...args);
      if (descriptor === copySource) {
        copySource = null; // descriptor numbers are reused by the replacement's own writes
        replaceWithForeignFile(backupPath, before);
        foreignIno = fs.statSync(backupPath, { bigint: true }).ino;
      }
      return result;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      const unlinked = unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
      expect(unlinked).not.toContain(target);
      expect(unlinked).not.toContain(backupPath);
    } finally {
      unlinkSpy.mockRestore();
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.statSync(backupPath, { bigint: true }).ino).toBe(foreignIno);
    expect(fs.readFileSync(backupPath)).toEqual(before);
    expect(applicationLogger.error).not.toHaveBeenCalled();
    expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'processing.recovery.succeeded',
      context: expect.objectContaining({
        restored: true,
        cleanupSucceeded: false,
        failures: [
          expect.objectContaining({
            artifactRole: 'original-backup', check: 'backup-identity-mismatch', identity: 'mismatched',
          }),
          // The owned backup identity no longer matches its path: never unlinked, residue only.
          expect.objectContaining({
            artifactRole: 'original-backup', check: 'cleanup-identity-mismatch', cleanup: 'residue',
          }),
        ],
        retainedRecoveryCriticalCount: 0,
      }),
    }));
  });

  // The owned backup keeps its exact identity (dev/ino) but its bytes are rewritten in place
  // after the copy completed. Ownership still holds, content does not: the backup is no
  // longer recovery material, so the source is never unlinked and the edit fails ordinarily.
  it('never removes the Prompt source when the owned backup bytes change in place before publication', async () => {
    const applicationLogger = { warn: vi.fn(), error: vi.fn() };
    processingService = createProcessingService({ applicationLogger });
    const source = writeIndexedPromptPng('Final/mutated-backup-early.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'mutated-backup-early.png');
    const before = fs.readFileSync(target);
    const beforeIno = fs.statSync(target, { bigint: true }).ino;
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    let copySource;
    let backupPath;
    let backupIdentity;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      const descriptor = realOpen(filePath, flags, ...args);
      if (copySource === undefined && flags === 'r' && path.resolve(String(filePath)) === target) copySource = descriptor;
      if (flags === 'wx+' && isPromptBackupPath(filePath)) backupPath = path.resolve(String(filePath));
      return descriptor;
    });
    // The backup copy closes its source descriptor only after the backup was verified.
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
      const result = realClose(descriptor, ...args);
      if (descriptor === copySource) {
        copySource = null; // descriptor numbers are reused by later writes
        const { dev, ino } = fs.statSync(backupPath, { bigint: true });
        fs.writeFileSync(backupPath, Buffer.alloc(before.length, 0x5a), { flag: 'r+' });
        const after = fs.statSync(backupPath, { bigint: true });
        expect({ dev: after.dev, ino: after.ino }).toEqual({ dev, ino });
        backupIdentity = { dev, ino };
      }
      return result;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      const unlinked = unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
      expect(unlinked).not.toContain(target);
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
      unlinkSpy.mockRestore();
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(backupIdentity).toBeDefined();
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.statSync(target, { bigint: true }).ino).toBe(beforeIno);
    expect(assetRepository.findById(source.id)).toMatchObject({
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
      source_generation: source.source_generation,
    });
    expect(applicationLogger.error).not.toHaveBeenCalled();
    expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'processing.recovery.succeeded',
      context: expect.objectContaining({
        restored: true,
        failures: [
          expect.objectContaining({
            assetId: source.id, artifactRole: 'original-backup', check: 'backup-content-mismatch', identity: 'matched',
          }),
        ],
        retainedRecoveryCriticalCount: 0,
      }),
    }));
  });

  // Once the source was removed the backup is the only original: a foreign file at its path
  // (same bytes) is neither restored from nor unlinked, and the edited replacement stays.
  it('requires recovery instead of restoring from a foreign file that replaced the owned Prompt backup', async () => {
    const source = writeIndexedPromptPng('Final/replaced-backup-late.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'replaced-backup-late.png');
    const before = fs.readFileSync(target);
    const options = { positive: { rules: [{ type: 'append', text: ' changed' }] } };
    let backupPath;
    let foreignIno;
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
      backupPath = stageArtifact(path.join(projectDir, promptWorkspaces()[0]), '0.original');
      replaceWithForeignFile(backupPath, before);
      foreignIno = fs.statSync(backupPath, { bigint: true }).ino;
      throw new Error('injected database failure after the backup was replaced');
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], options))
        .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      const unlinked = unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
      expect(unlinked).not.toContain(path.resolve(backupPath));
      expect(unlinked.filter((filePath) => filePath === target)).toHaveLength(1); // the source removal
    } finally {
      unlinkSpy.mockRestore();
      applySpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(before, options).buffer);
    expect(fs.statSync(backupPath, { bigint: true }).ino).toBe(foreignIno);
    expect(assetRepository.findById(source.id)).toMatchObject({ size_bytes: source.size_bytes, modified_at: source.modified_at });
  });

  // A backup descriptor exposing zero IDs cannot prove ownership: nothing is claimed, the
  // created path stays as residue, and the untouched source makes it an ordinary failure.
  it('never claims a Prompt backup whose descriptor exposes no exact identity', async () => {
    const source = writeIndexedPromptPng('Final/zero-id-backup.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'zero-id-backup.png');
    const before = fs.readFileSync(target);
    const restoreStats = mockStatOverrides((filePath) => (isPromptBackupPath(filePath) ? { ino: 0 } : null));
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    let unlinked;

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      unlinked = unlinkSpy.mock.calls.map(([filePath]) => String(filePath));
    } finally {
      unlinkSpy.mockRestore();
      restoreStats();
    }

    expect(unlinked.filter((filePath) => path.resolve(filePath) === target)).toEqual([]);
    expect(unlinked.filter(isPromptBackupPath)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(before);
    const [workspace] = promptWorkspaces();
    expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toBe(true);
  });

  // The source was removed, then the created replacement exposed zero IDs through its own
  // descriptor: it is never claimed, so rollback cannot remove it and recovery is required.
  it('never claims a Prompt replacement whose descriptor exposes no exact identity', async () => {
    const source = writeIndexedPromptPng('Final/zero-id-replacement.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'zero-id-replacement.png');
    const before = fs.readFileSync(target);
    const realUnlink = fs.unlinkSync.bind(fs);
    const targetUnlinks = [];
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
      if (path.resolve(String(filePath)) === target) targetUnlinks.push(filePath);
      return realUnlink(filePath, ...args);
    });
    const restoreStats = mockStatOverrides((filePath) => (
      filePath === target && targetUnlinks.length > 0 ? { ino: 0 } : null
    ));

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      restoreStats();
      unlinkSpy.mockRestore();
    }

    expect(targetUnlinks).toHaveLength(1); // the verified source removal only
    expect(fs.existsSync(target)).toBe(true);
    const [workspace] = promptWorkspaces();
    expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
  });

  // Rollback removed the owned replacement, then the restore descriptor exposed zero IDs:
  // the restored path is never claimed or removed and the backup stays the original.
  it('never claims a Prompt restore whose descriptor exposes no exact identity', async () => {
    const source = writeIndexedPromptPng('Final/zero-id-restore.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'zero-id-restore.png');
    const before = fs.readFileSync(target);
    const realUnlink = fs.unlinkSync.bind(fs);
    const targetUnlinks = [];
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
      if (path.resolve(String(filePath)) === target) targetUnlinks.push(filePath);
      return realUnlink(filePath, ...args);
    });
    const restoreStats = mockStatOverrides((filePath) => (
      filePath === target && targetUnlinks.length > 1 ? { ino: 0 } : null
    ));
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits')
      .mockImplementation(() => { throw new Error('injected database failure'); });

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      applySpy.mockRestore();
      restoreStats();
      unlinkSpy.mockRestore();
    }

    // Source removal, then the exact-identity removal of the owned replacement; nothing else.
    expect(targetUnlinks).toHaveLength(2);
    expect(fs.existsSync(target)).toBe(true);
    const [workspace] = promptWorkspaces();
    expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
  });

  // Source removal authority is the source's own preflight exact identity plus its preflight
  // bytes. The source is rewritten in place (same inode) after the backup copy completed: a
  // successful copy never authorizes removing it, so the edit fails and the new bytes stay.
  it('never removes a Prompt source that changed in place after its backup was copied', async () => {
    const source = writeIndexedPromptPng('Final/changed-in-place.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'changed-in-place.png');
    const before = fs.readFileSync(target);
    const concurrent = Buffer.alloc(before.length, 0x41);
    const sourceIno = fs.statSync(target, { bigint: true }).ino;
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    let copySource;
    let changed = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      const descriptor = realOpen(filePath, flags, ...args);
      if (copySource === undefined && flags === 'r' && path.resolve(String(filePath)) === target) copySource = descriptor;
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
      const result = realClose(descriptor, ...args);
      if (descriptor === copySource && !changed) {
        changed = true;
        fs.writeFileSync(target, concurrent, { flag: 'r+' });
      }
      return result;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    const linkSpy = vi.spyOn(fs, 'linkSync');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === target)).toEqual([]);
      expect(linkSpy).not.toHaveBeenCalled();
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(changed).toBe(true);
    expect(fs.statSync(target, { bigint: true }).ino).toBe(sourceIno);
    expect(fs.readFileSync(target)).toEqual(concurrent);
    expect(promptWorkspaces()).toEqual([]);
  });

  // A foreign writer replaces the published replacement (with byte-identical content) before
  // rollback. Only the exact descriptor-created identity may be removed; there is no content
  // fallback, so that path and its backup stay while the other item is restored.
  it('never unlinks a foreign file that replaced a published Prompt source before rollback', async () => {
    const applicationLogger = { warn: vi.fn(), error: vi.fn() };
    processingService = createProcessingService({ applicationLogger });
    const sources = ['first', 'second'].map((name) => writeIndexedPromptPng(
      `Final/replaced-published-${name}.png`,
      'parameters',
      `original-${name}`,
    ));
    const targets = sources.map((source) => path.resolve(projectDir, ...source.relative_path.split('/')));
    const before = targets.map((target) => fs.readFileSync(target));
    const metadata = sources.map((source) => ({
      id: source.id,
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
    }));
    const options = { positive: { rules: [{ type: 'append', text: ' changed' }] } };
    const edited = editWorkflowPromptsInPng(before[0], options).buffer;
    let foreignIno;
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
      replaceWithForeignFile(targets[0], edited);
      foreignIno = fs.statSync(targets[0], { bigint: true }).ino;
      throw new Error('injected database failure after the published source was replaced');
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, sources.map(({ id }) => id), options))
        .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === targets[0]))
        .toHaveLength(1); // the verified source removal only
    } finally {
      unlinkSpy.mockRestore();
      applySpy.mockRestore();
    }

    expect(fs.statSync(targets[0], { bigint: true }).ino).toBe(foreignIno);
    expect(fs.readFileSync(targets[0])).toEqual(edited);
    expect(fs.readFileSync(targets[1])).toEqual(before[1]);
    metadata.forEach((expected) => expect(assetRepository.findById(expected.id)).toMatchObject(expected));
    const workspaces = stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-');
    expect(workspaces).toHaveLength(1);
    expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspaces[0]), '0.original'))).toEqual(before[0]);
    expect(fs.existsSync(stageArtifact(path.join(projectDir, workspaces[0]), '1.original'))).toBe(false);
    expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        recoveryPhase: 'database',
        restored: false,
        failures: expect.arrayContaining([expect.objectContaining({
          assetId: sources[0].id,
          artifactRole: 'published-output',
          check: 'destination-foreign',
          publicationMode: 'descriptor-owned',
          identity: 'mismatched',
        })]),
      }),
    }));
  });

  it('does not claim or delete a foreign Prompt stage output after an EEXIST collision', async () => {
    const source = writeIndexedPromptPng('Final/foreign-stage-collision.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'foreign-stage-collision.png');
    const before = fs.readFileSync(target);
    const foreign = Buffer.from('foreign staged output');
    const realOpen = fs.openSync.bind(fs);
    let foreignPath;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      if (!foreignPath && flags === 'wx' && isPromptStagePath(String(filePath))) {
        foreignPath = path.resolve(String(filePath));
        fs.writeFileSync(foreignPath, foreign); // another writer wins the exclusive create
      }
      return realOpen(filePath, flags, ...args);
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

    try {
      // Nothing was ever owned or written and no project file changed: the foreign file is
      // safe private residue, so the ordinary staging failure stands (not RECOVERY_REQUIRED).
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === foreignPath)).toEqual([]);
    } finally {
      unlinkSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readFileSync(foreignPath)).toEqual(foreign);
  });

  it('does not claim or delete a foreign Prompt backup after an EEXIST collision', async () => {
    const source = writeIndexedPromptPng('Final/foreign-backup-collision.png', 'parameters', 'original');
    const target = path.join(projectDir, 'Final', 'foreign-backup-collision.png');
    const before = fs.readFileSync(target);
    const foreign = Buffer.from('foreign original backup');
    const realOpen = fs.openSync.bind(fs);
    let foreignPath;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
      if (!foreignPath && flags === 'wx+' && isPromptBackupPath(filePath)) {
        foreignPath = path.resolve(String(filePath));
        fs.writeFileSync(foreignPath, foreign); // another writer wins the backup name
      }
      return realOpen(filePath, flags, ...args);
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

    try {
      // Nothing was owned and the source was never touched: the foreign file is private
      // residue, so the ordinary backup failure stands (not RECOVERY_REQUIRED).
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === foreignPath)).toEqual([]);
    } finally {
      unlinkSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readFileSync(foreignPath)).toEqual(foreign);
  });

  // Writing the replacement fails after the source was removed. The partial replacement is
  // owned (its descriptor identity was recorded first), so rollback removes exactly it and
  // recreates the original: an ordinary failure, not RECOVERY_REQUIRED.
  it('restores the original and reports a plain failure when writing the Prompt replacement fails', async () => {
    const applicationLogger = { warn: vi.fn(), error: vi.fn() };
    processingService = createProcessingService({ applicationLogger });
    const source = writeIndexedPromptPng('Final/replacement-write-failure.png', 'parameters', 'original');
    const target = path.resolve(projectDir, 'Final', 'replacement-write-failure.png');
    const before = fs.readFileSync(target);
    let failedWrites = 0;
    const restoreWrites = interceptDescriptorWrites(
      (filePath, flags) => flags === 'wx+' && filePath === target,
      () => (failedWrites++ === 0
        ? Object.assign(new Error('injected replacement write failure'), { code: 'EIO' })
        : undefined),
    );
    const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');

    try {
      await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
        positive: { rules: [{ type: 'append', text: ' changed' }] },
      })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
      restoreWrites();
    }

    expect(failedWrites).toBeGreaterThan(0);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.statSync(target).mtime.toISOString()).toBe(source.modified_at);
    expect(assetRepository.findById(source.id)).toMatchObject({
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
    });
    expect(stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-'))
      .toEqual([]);
    expect(applicationLogger.error).not.toHaveBeenCalled();
    expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'processing.recovery.succeeded',
      context: expect.objectContaining({
        recoveryPhase: 'publication',
        restored: true,
        cleanupSucceeded: true,
        failures: [expect.objectContaining({
          artifactRole: 'published-output',
          check: 'publish-create-failed',
          publicationMode: 'descriptor-owned',
          errorCode: 'EIO',
        })],
      }),
    }));
  });

  describe('Conversion recovery evidence', () => {
    const MODES = Object.freeze({
      output: { format: 'webp', originalHandling: 'keep', copyRole: null },
      reencode: { format: 'png', originalHandling: 'keep', copyRole: 'original-backup' },
      move: { format: 'webp', originalHandling: 'move', copyRole: 'originals-copy' },
      delete: { format: 'webp', originalHandling: 'delete', copyRole: 'staged-original' },
    });
    const ROLES = Object.freeze({
      output: ['stage-output', 'published-output'],
      reencode: ['stage-output', 'original-backup', 'published-output'],
      move: ['stage-output', 'published-output', 'originals-copy'],
      delete: ['stage-output', 'published-output', 'staged-original'],
    });
    const PUBLIC_ROLES = ['published-output', 'originals-copy'];
    const RUN = 'convert-evidence-run';
    const progress = (jobId = RUN) => Object.assign(() => {}, { jobId });
    const repository = () => createProcessingRecoveryEvidenceRepository(db);
    const rows = () => repository().listUnresolvedEvidenceByProject(project.id);
    const groups = () => repository().listMutationGroupsByProject(project.id);
    const relative = (p) => path.relative(projectDir, p).split(path.sep).join('/');
    const isPrivate = (p) => String(p).includes('.creatorcrate-convert-staging');
    const convertWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-convert-');
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const intents = (events) => events.filter((event) => event.name === 'createEvidence' && event.result)
      .map((event) => event.result);
    const exactIdentityOf = (p) => {
      const stats = fs.lstatSync(p, { bigint: true });
      return { dev: String(stats.dev), ino: String(stats.ino) };
    };

    function paths(name, mode) {
      const sourcePath = path.resolve(projectDir, 'Final', `${name}.png`);
      return {
        sourcePath,
        outputPath: mode === 'reencode' ? sourcePath : path.resolve(projectDir, 'Final', `${name}.${MODES[mode].format}`),
        originalPath: path.resolve(projectDir, 'Final', 'originals', `${name}.png`),
      };
    }

    // A Conversion service over a wrapped evidence repository that logs every registry call (with
    // whether it ran inside a transaction) and can fail or observe selected calls.
    function harness({ fail = {}, before = {}, ...overrides } = {}) {
      const events = [];
      const real = repository();
      const roleOf = (id) => real.findEvidence(project.id, id)?.artifactRole;
      const wrapped = Object.fromEntries(Object.entries(real).map(([name, method]) => [name, (...args) => {
        before[name]?.(args, { roleOf, events });
        if (fail[name]?.(args, { roleOf, events })) {
          events.push({ type: 'failed', name, args, inTransaction: db.inTransaction });
          throw new Error(`injected ${name}`);
        }
        const result = method(...args);
        events.push({ type: 'db', name, args, result, inTransaction: db.inTransaction });
        return result;
      }]));
      const service = createProcessingService({
        ...processingRecoveryEvidenceDependencies(db, { repository: wrapped }), ...overrides,
      });
      const convert = (assetIds, mode, jobId) => service.convertAssets(project.id, [].concat(assetIds), {
        format: MODES[mode].format, quality: 80, originalHandling: MODES[mode].originalHandling,
      }, progress(jobId));
      return { service, events, convert };
    }

    // Logs exclusive creates, descriptor writes and unlinks into the same event stream.
    function recordFilesystem(events) {
      const realOpen = fs.openSync.bind(fs);
      const realAsyncWrite = fs.write.bind(fs);
      const realAsyncWriteFile = fs.writeFile.bind(fs);
      const realUnlink = fs.unlinkSync.bind(fs);
      const descriptors = new Map();
      const spies = [
        vi.spyOn(fs, 'openSync').mockImplementation((p, flags, ...rest) => {
          const descriptor = realOpen(p, flags, ...rest);
          if (isExclusiveOpen(flags)) {
            descriptors.set(descriptor, path.resolve(String(p)));
            events.push({ type: 'create', path: path.resolve(String(p)) });
          }
          return descriptor;
        }),
        vi.spyOn(fs, 'write').mockImplementation((descriptor, ...rest) => {
          if (descriptors.has(descriptor)) events.push({ type: 'write', path: descriptors.get(descriptor) });
          return realAsyncWrite(descriptor, ...rest);
        }),
        vi.spyOn(fs, 'writeFile').mockImplementation((descriptor, ...rest) => {
          if (descriptors.has(descriptor)) events.push({ type: 'write', path: descriptors.get(descriptor) });
          return realAsyncWriteFile(descriptor, ...rest);
        }),
        vi.spyOn(fs, 'unlinkSync').mockImplementation((p, ...rest) => {
          events.push({ type: 'unlink', path: path.resolve(String(p)) });
          return realUnlink(p, ...rest);
        }),
      ];
      return () => spies.reverse().forEach((spy) => spy.mockRestore());
    }

    function failingApply() {
      return vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        throw new Error('injected database failure');
      });
    }

    it.each(['processingRecoveryEvidenceRecorder', 'processingRecoveryEvidenceRepository'])(
      'rejects a missing %s before any Conversion filesystem mutation', async (missing) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath } = paths('evidence', 'delete');
        const bytes = fs.readFileSync(sourcePath);
        const { convert, events } = harness({ [missing]: null });
        const apply = vi.spyOn(assetRepository, 'applyAssetConversions');
        const restore = recordFilesystem(events);
        let error;
        let applied;
        try { error = await convert(source.id, 'delete').catch((err) => err); } finally {
          restore();
          applied = apply.mock.calls.length;
          apply.mockRestore();
        }
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_UNAVAILABLE' });
        expect(applied).toBe(0);
        expect(events.filter((event) => ['create', 'write', 'unlink'].includes(event.type))).toEqual([]);
        expect(fs.existsSync(path.join(projectDir, '.creatorcrate-convert-staging'))).toBe(false);
        expect(fs.readFileSync(sourcePath)).toEqual(bytes);
        expect(assetRepository.findById(source.id).relative_path).toBe('Final/evidence.png');
        expect(rows()).toEqual([]);
        expect(groups()).toEqual([]);
      },
    );

    it.each(Object.keys(MODES))(
      'maps %s evidence before each create/mutation, finalizes in the commit and leaves none after success',
      async (mode) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath, outputPath, originalPath } = paths('evidence', mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const copyRole = MODES[mode].copyRole;
        const { convert, events } = harness();
        const realApply = assetRepository.applyAssetConversions.bind(assetRepository);
        const apply = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation((...args) => {
          events.push({ type: 'apply', inTransaction: db.inTransaction });
          return realApply(...args);
        });
        const restore = recordFilesystem(events);
        let result;
        try { result = await convert(source.id, mode); } finally { restore(); apply.mockRestore(); }
        expect(result.convertedCount).toBe(1);

        // One group per source asset, durable before any Conversion file is created.
        const started = events.filter((event) => event.name === 'createMutationGroup');
        expect(started.map((event) => event.result)).toEqual([expect.objectContaining({
          operation: 'convert', runId: RUN, itemKey: `asset:${source.id}`, checkpoint: null,
        })]);
        expect(events.indexOf(started[0])).toBeLessThan(events.findIndex((event) => event.type === 'create'));

        const mapped = intents(events);
        const rowOf = (role) => mapped.find((row) => row.artifactRole === role);
        expect(mapped.map((row) => row.artifactRole)).toEqual(ROLES[mode]);
        for (const row of mapped) {
          expect(row).toMatchObject({
            projectId: project.id, assetId: source.id, operation: 'convert', runId: RUN,
            itemKey: `asset:${source.id}`, sourcePath: 'Final/evidence.png', lifecycle: 'intent', identity: null,
          });
        }
        const outputBytes = fs.readFileSync(outputPath);
        expect(rowOf('stage-output')).toMatchObject({
          destinationPath: relative(outputPath), expectedSize: outputBytes.length, expectedSha256: sha(outputBytes),
        });
        expect(rowOf('stage-output').artifactPath).toMatch(/^\.creatorcrate-convert-staging\/[0-9a-f]{16}\.0\.output$/);
        expect(rowOf('published-output')).toMatchObject({
          artifactPath: relative(outputPath), destinationPath: relative(outputPath),
          expectedSize: outputBytes.length, expectedSha256: sha(outputBytes),
        });
        if (copyRole) {
          expect(rowOf(copyRole)).toMatchObject({
            expectedSize: sourceBytes.length, expectedSha256: sha(sourceBytes),
            destinationPath: mode === 'move' ? 'Final/originals/evidence.png' : 'Final/evidence.png',
          });
          if (mode === 'move') expect(rowOf(copyRole).artifactPath).toBe('Final/originals/evidence.png');
          else expect(rowOf(copyRole).artifactPath).toMatch(/^\.creatorcrate-convert-staging\//);
        }

        // Every exclusive create: its intent first, its exact identity before its first byte and
        // outside any transaction.
        const creations = events.filter((event) => event.type === 'create');
        expect(creations).toHaveLength(mapped.length);
        for (const creation of creations) {
          const intentIndex = events.findIndex((event) => event.name === 'createEvidence'
            && event.result?.artifactPath === relative(creation.path));
          const id = events[intentIndex].result.evidenceId;
          const identityIndex = events.findIndex((event) => event.name === 'attachEvidenceIdentity' && event.args[1] === id);
          const writeIndex = events.findIndex((event) => event.type === 'write' && event.path === creation.path);
          expect(intentIndex).toBeGreaterThan(-1);
          expect(intentIndex).toBeLessThan(events.indexOf(creation));
          expect(identityIndex).toBeGreaterThan(events.indexOf(creation));
          expect(identityIndex).toBeLessThan(writeIndex);
          expect(events[identityIndex].inTransaction).toBe(false);
        }

        // Public intent → checkpoint → promotion → public/source mutation.
        const checkpoints = events.filter((event) => event.name === 'markMutationCheckpoint');
        expect(checkpoints.map((event) => event.args[2])).toEqual({
          output: ['public-create'],
          reencode: ['replace'],
          move: ['public-create', 'public-create', 'unlink'],
          delete: ['public-create', 'unlink'],
        }[mode]);
        const promotion = (role) => events.findIndex((event) => event.name === 'setEvidenceLifecycle'
          && event.args[1] === rowOf(role).evidenceId && event.args[2] === 'recovery-critical');
        const publicIntent = events.findIndex((event) => event.result?.artifactRole === 'published-output'
          && event.name === 'createEvidence');
        const firstCheckpoint = events.indexOf(checkpoints[0]);
        const publicCreate = events.findIndex((event) => event.type === 'create' && event.path === outputPath);
        expect(publicIntent).toBeLessThan(firstCheckpoint);
        expect(firstCheckpoint).toBeLessThan(promotion('stage-output'));
        expect(promotion('stage-output')).toBeLessThan(publicCreate);
        expect(events.slice(0, firstCheckpoint).some((event) => event.name === 'setEvidenceLifecycle')).toBe(false);
        const sourceUnlink = events.findIndex((event) => event.type === 'unlink' && event.path === sourcePath);
        if (copyRole) {
          const guard = events.indexOf(checkpoints.at(-1));
          const copyIdentity = events.findIndex((event) => event.name === 'attachEvidenceIdentity'
            && event.args[1] === rowOf(copyRole).evidenceId);
          expect(copyIdentity).toBeLessThan(guard);
          expect(guard).toBeLessThan(promotion(copyRole));
          expect(promotion(copyRole)).toBeLessThan(sourceUnlink);
          if (mode === 'reencode') expect(sourceUnlink).toBeLessThan(publicCreate);
          if (mode === 'move') {
            const originalsCreate = events.findIndex((event) => event.type === 'create' && event.path === originalPath);
            expect(events.indexOf(checkpoints[1])).toBeLessThan(originalsCreate);
            expect(events.findIndex((event) => event.name === 'createEvidence'
              && event.result?.artifactRole === 'originals-copy')).toBeLessThan(events.indexOf(checkpoints[1]));
          }
        } else {
          expect(sourceUnlink).toBe(-1);
        }

        // Private rows become dispensable in the commit transaction, after the asset/index apply;
        // public rows never do and retire only after the autocommit resolution.
        const applyAt = events.findIndex((event) => event.type === 'apply');
        const resolution = events.findIndex((event) => event.name === 'clearMutationCheckpoint');
        expect(events[applyAt].inTransaction).toBe(true);
        expect(events[resolution].inTransaction).toBe(false);
        const committing = events.slice(applyAt, resolution);
        expect(committing.every((event) => event.inTransaction)).toBe(true);
        const dispensable = events.filter((event) => event.name === 'setEvidenceLifecycle' && event.args[2] === 'dispensable');
        const publicIds = mapped.filter((row) => PUBLIC_ROLES.includes(row.artifactRole)).map((row) => row.evidenceId);
        expect(committing.filter((event) => dispensable.includes(event)).map((event) => event.args[1]).sort())
          .toEqual(mapped.filter((row) => !PUBLIC_ROLES.includes(row.artifactRole)).map((row) => row.evidenceId).sort());
        expect(committing.filter((event) => event.name === 'setEvidenceRetentionReason'
          && event.args[2] === 'conversion-committed' && publicIds.includes(event.args[1])).map((event) => event.args[1]).sort())
          .toEqual([...publicIds].sort());
        expect(dispensable.some((event) => publicIds.includes(event.args[1]))).toBe(false);
        for (const id of publicIds) {
          expect(events.findIndex((event) => event.name === 'deleteEvidence' && event.args[1] === id))
            .toBeGreaterThan(resolution);
        }

        // Clean success: the live project files stay, no evidence or group remains.
        expect(rows()).toEqual([]);
        expect(groups()).toEqual([]);
        expect(convertWorkspaces()).toEqual([]);
        expect(fs.readFileSync(outputPath)).toEqual(outputBytes);
        if (mode === 'move') expect(fs.readFileSync(originalPath)).toEqual(sourceBytes);
        if (mode === 'move' || mode === 'delete') expect(fs.existsSync(sourcePath)).toBe(false);
      },
    );

    const FAILURE_CASES = [
      ['group', 'output'], ['stage-intent', 'output'], ['stage-identity', 'output'], ['public-intent', 'output'],
      ['checkpoint', 'output'], ['promotion', 'output'],
      ['copy-intent', 'reencode'], ['copy-identity', 'reencode'], ['checkpoint', 'reencode'], ['promotion', 'reencode'],
      ['copy-intent', 'move'], ['copy-identity', 'move'], ['unlink-checkpoint', 'move'], ['unlink-promotion', 'move'],
      ['copy-intent', 'delete'], ['copy-identity', 'delete'], ['unlink-checkpoint', 'delete'], ['unlink-promotion', 'delete'],
    ];
    it.each(FAILURE_CASES)('halts the guarded mutation on %s persistence failure (%s)', async (stage, mode) => {
      const source = writeIndexedImage('Final/evidence.png');
      const { sourcePath, outputPath } = paths('evidence', mode);
      const sourceBytes = fs.readFileSync(sourcePath);
      const copyRole = MODES[mode].copyRole;
      const promotedRole = stage === 'promotion' ? (mode === 'reencode' ? 'original-backup' : 'stage-output') : copyRole;
      let promotionFailed = false;
      const { convert, events } = harness({ fail: {
        createMutationGroup: () => stage === 'group',
        createEvidence: ([intent]) => (stage === 'stage-intent' && intent.artifactRole === 'stage-output')
          || (stage === 'public-intent' && intent.artifactRole === 'published-output')
          || (stage === 'copy-intent' && intent.artifactRole === copyRole),
        attachEvidenceIdentity: ([, id], { roleOf }) => (stage === 'stage-identity' && roleOf(id) === 'stage-output')
          || (stage === 'copy-identity' && roleOf(id) === copyRole),
        markMutationCheckpoint: ([, , checkpoint]) => (stage === 'checkpoint')
          || (stage === 'unlink-checkpoint' && checkpoint === 'unlink'),
        setEvidenceLifecycle: ([, id, lifecycle], { roleOf }) => {
          if (!['promotion', 'unlink-promotion'].includes(stage) || promotionFailed || lifecycle !== 'recovery-critical'
            || roleOf(id) !== promotedRole) return false;
          promotionFailed = true;
          return true;
        },
      } });
      const apply = vi.spyOn(assetRepository, 'applyAssetConversions');
      const restore = recordFilesystem(events);
      let error;
      let applied;
      try { error = await convert(source.id, mode).catch((err) => err); } finally {
        restore();
        applied = apply.mock.calls.length;
        apply.mockRestore();
      }
      expect(error.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
      expect(applied).toBe(0);
      // The protected source is never removed and the project keeps its pre-run state.
      expect(events.filter((event) => event.type === 'unlink' && event.path === sourcePath)).toEqual([]);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(assetRepository.findById(source.id).relative_path).toBe('Final/evidence.png');
      if (mode !== 'reencode') expect(fs.existsSync(outputPath)).toBe(false);
      if (mode === 'output' || mode === 'reencode') {
        expect(events.filter((event) => event.type === 'create' && !isPrivate(event.path))).toEqual([]);
      }
      if (['group', 'stage-intent'].includes(stage)) expect(events.filter((event) => event.type === 'create')).toEqual([]);
      if (stage === 'group') expect(fs.existsSync(path.join(projectDir, '.creatorcrate-convert-staging'))).toBe(false);
      if (stage === 'copy-intent') {
        expect(events.filter((event) => event.type === 'create'
          && relative(event.path).endsWith(mode === 'move' ? 'originals/evidence.png' : { reencode: '.source', delete: '.original' }[mode])))
          .toEqual([]);
      }
      if (stage === 'checkpoint') {
        // Nothing is recovery-critical before a durable checkpoint.
        expect(events.filter((event) => event.name === 'setEvidenceLifecycle' && event.args[2] === 'recovery-critical')).toEqual([]);
      }
      if (stage === 'unlink-checkpoint') {
        expect(events.filter((event) => event.name === 'setEvidenceLifecycle' && event.args[2] === 'recovery-critical'
          && events.find((intent) => intent.name === 'createEvidence' && intent.result?.evidenceId === event.args[1])
            ?.result.artifactRole === copyRole)).toEqual([]);
      }
      if (stage.endsWith('promotion')) {
        // The checkpoint stays conservative and the unpromoted row stays a pre-mutation intent.
        expect(promotionFailed).toBe(true);
        expect(groups()).toEqual([expect.objectContaining({
          checkpoint: { promotion: mode === 'reencode' ? 'replace' : 'public-create' }[stage] ?? 'unlink',
        })]);
        expect(rows().find((row) => row.artifactRole === promotedRole).lifecycle).toBe('intent');
      } else {
        expect(rows()).toEqual([]);
        expect(groups()).toEqual([]);
        expect(convertWorkspaces()).toEqual([]);
      }
    });

    it.each(['reencode', 'delete'])(
      'retains the %s source copy as recovery-critical evidence when the source cannot be restored', async (mode) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath } = paths('evidence', mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const role = MODES[mode].copyRole;
        const { convert, events } = harness();
        const apply = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
          // A foreign occupant at the source path blocks restoration (and, for a re-encode, the
          // withdrawal of the replacement that held that path).
          if (mode === 'reencode') replaceWithForeignFile(sourcePath, Buffer.from('foreign occupant'));
          else fs.writeFileSync(sourcePath, 'foreign occupant');
          throw new Error('injected database failure');
        });
        let error;
        try { error = await convert(source.id, mode).catch((err) => err); } finally { apply.mockRestore(); }
        expect(error.code).toBe('RECOVERY_REQUIRED');
        const row = rows().find((evidence) => evidence.artifactRole === role);
        expect(row).toMatchObject({
          projectId: project.id, assetId: source.id, operation: 'convert', runId: RUN, itemKey: `asset:${source.id}`,
          artifactRole: role, sourcePath: 'Final/evidence.png', destinationPath: 'Final/evidence.png',
          expectedSize: sourceBytes.length, expectedSha256: sha(sourceBytes),
          lifecycle: 'recovery-critical', observation: 'present',
          retentionReason: 'conversion-source-restoration-failed',
        });
        expect(row.artifactPath).toMatch(/^\.creatorcrate-convert-staging\//);
        const artifact = path.join(projectDir, ...row.artifactPath.split('/'));
        expect(fs.readFileSync(artifact)).toEqual(sourceBytes);
        expect(row.identity).toMatchObject(exactIdentityOf(artifact));
        const [group] = groups();
        expect(group).toMatchObject({ groupId: row.mutationGroupId, itemKey: `asset:${source.id}`, operation: 'convert' });
        expect(group.checkpoint).toBe(mode === 'reencode' ? 'replace' : 'unlink');
        const identityEvent = events.findIndex((event) => event.name === 'attachEvidenceIdentity' && event.args[1] === row.evidenceId);
        const guard = events.findIndex((event) => event.name === 'markMutationCheckpoint'
          && event.args[2] === (mode === 'reencode' ? 'replace' : 'unlink'));
        expect(identityEvent).toBeLessThan(guard);
        // The last good copy was never offered for disposal.
        expect(events.some((event) => event.name === 'setEvidenceLifecycle' && event.args[1] === row.evidenceId
          && event.args[2] === 'dispensable')).toBe(false);
        expect(rows().find((evidence) => evidence.artifactRole === 'published-output')).toMatchObject(mode === 'reencode'
          ? { lifecycle: 'recovery-critical', retentionReason: 'conversion-restoration-failed', observation: 'replaced' }
          : { lifecycle: 'recovery-critical', retentionReason: 'conversion-source-restoration-failed', observation: 'missing' });
      },
    );

    it.each(['reencode', 'move', 'delete'])(
      'keeps the %s copy recovery-critical while the restored source fails its final evidence hash', async (mode) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath, originalPath } = paths('evidence', mode);
        const role = MODES[mode].copyRole;
        let databaseFailed = false;
        let restoreCreated = false;
        let mutated = false;
        const { convert, events } = harness();
        const apply = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
          databaseFailed = true;
          throw new Error('injected database failure');
        });
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (databaseFailed && filePath === sourcePath && isExclusiveOpen(flags)) restoreCreated = true;
          },
          onClose(filePath, flags) {
            if (!restoreCreated || mutated || filePath !== sourcePath || !isReadOpen(flags)) return;
            mutated = true;
            rewriteInPlace(sourcePath, Buffer.from('restored source rewritten in place'));
          },
        });
        let error;
        try { error = await convert(source.id, mode).catch((err) => err); } finally { unhook(); apply.mockRestore(); }
        expect(mutated).toBe(true);
        expect(error.code).toBe('RECOVERY_REQUIRED');
        const row = rows().find((evidence) => evidence.artifactRole === role);
        expect(row).toMatchObject({
          lifecycle: 'recovery-critical', retentionReason: 'conversion-source-restoration-failed', observation: 'present',
        });
        if (mode === 'move') expect(row.artifactPath).toBe(relative(originalPath));
        expect(events.some((event) => event.name === 'setEvidenceLifecycle' && event.args[1] === row.evidenceId
          && event.args[2] === 'dispensable')).toBe(false);
        expect(events.some((event) => event.name === 'deleteEvidence' && event.args[1] === row.evidenceId)).toBe(false);
        expect(groups()[0].checkpoint).not.toBeNull();
      },
    );

    it.each(Object.keys(MODES))(
      'settles a verified %s rollback: failure phase first, then dispensable private rows and retired public rows',
      async (mode) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath, outputPath, originalPath } = paths('evidence', mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const { convert, events } = harness();
        const apply = failingApply();
        let error;
        try { error = await convert(source.id, mode).catch((err) => err); } finally { apply.mockRestore(); }
        expect(error.code).toBe('DATABASE_OPERATION_FAILED');
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        if (mode !== 'reencode') expect(fs.existsSync(outputPath)).toBe(false);
        // An existing rollback semantic: a rolled-back move withdraws its Originals copy.
        expect(fs.existsSync(originalPath)).toBe(false);
        expect(assetRepository.findById(source.id).relative_path).toBe('Final/evidence.png');

        const mapped = intents(events);
        expect(mapped.map((row) => row.artifactRole)).toEqual(ROLES[mode]);
        const phase = events.filter((event) => event.name === 'setEvidenceRetentionReason'
          && event.args[2] === 'conversion-database-failed');
        expect(phase.map((event) => event.args[1]).sort()).toEqual(mapped.map((row) => row.evidenceId).sort());
        const rolledBack = events.filter((event) => event.name === 'setEvidenceRetentionReason'
          && event.args[2] === 'conversion-verified-rollback').map((event) => event.args[1]);
        expect(rolledBack.sort()).toEqual(mapped.filter((row) => !PUBLIC_ROLES.includes(row.artifactRole))
          .map((row) => row.evidenceId).sort());
        expect(events.some((event) => event.name === 'setEvidenceLifecycle' && event.args[2] === 'dispensable'
          && mapped.some((row) => row.evidenceId === event.args[1] && PUBLIC_ROLES.includes(row.artifactRole)))).toBe(false);
        expect(Math.min(...phase.map((event) => events.indexOf(event))))
          .toBeLessThan(events.findIndex((event) => event.name === 'clearMutationCheckpoint'));
        expect(rows()).toEqual([]);
        expect(groups()).toEqual([]);
        expect(convertWorkspaces()).toEqual([]);
      },
    );

    it.each(['output', 'move'])(
      'keeps a created but unclaimed %s public path untouched with null identity and its checkpoint', async (mode) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath, outputPath, originalPath } = paths('evidence', mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const target = mode === 'output' ? outputPath : originalPath;
        const role = mode === 'output' ? 'published-output' : 'originals-copy';
        const { convert, events } = harness();
        const restore = mockStatOverrides((p) => p === target ? { ino: 0n } : null);
        const apply = vi.spyOn(assetRepository, 'applyAssetConversions');
        const unlink = vi.spyOn(fs, 'unlinkSync');
        let error;
        let applied;
        let unlinked;
        try { error = await convert(source.id, mode).catch((err) => err); } finally {
          unlinked = unlink.mock.calls.map(([p]) => path.resolve(String(p)));
          applied = apply.mock.calls.length;
          unlink.mockRestore();
          apply.mockRestore();
          restore();
        }
        expect(error.code).toBe('RECOVERY_REQUIRED');
        expect(applied).toBe(0);
        expect(unlinked).not.toContain(target);
        expect(unlinked).not.toContain(sourcePath);
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        const row = rows().find((evidence) => evidence.artifactRole === role);
        expect(row).toMatchObject({
          projectId: project.id, assetId: source.id, runId: RUN, operation: 'convert', artifactPath: relative(target),
          identity: null, lifecycle: 'recovery-critical', observation: 'ownership-unknown',
          retentionReason: 'conversion-public-created-unclaimed',
        });
        // onCreated ran; ownership was never established, so no identity was ever attached.
        expect(events.some((event) => event.name === 'attachEvidenceIdentity' && event.args[1] === row.evidenceId)).toBe(false);
        expect(groups()).toEqual([expect.objectContaining({ groupId: row.mutationGroupId, checkpoint: 'public-create' })]);
        if (mode === 'move') {
          // The converted output was withdrawn; its tracking stays with the unresolved item.
          expect(fs.existsSync(outputPath)).toBe(false);
          expect(rows().find((evidence) => evidence.artifactRole === 'published-output')).toMatchObject({
            lifecycle: 'recovery-critical', observation: 'missing', retentionReason: 'conversion-public-created-unclaimed',
          });
        }
      },
    );

    it.each([['stage-output', 'output', '.output'], ['original-backup', 'reencode', '.source'], ['staged-original', 'delete', '.original']])(
      'keeps a created but unclaimed private %s as safe ownership-unknown residue (%s)', async (role, mode, suffix) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath, outputPath } = paths('evidence', mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const { convert } = harness();
        const restore = mockStatOverrides((p) => isPrivate(p) && p.endsWith(suffix) ? { ino: 0n } : null);
        const unlink = vi.spyOn(fs, 'unlinkSync');
        let error;
        let unlinked;
        try { error = await convert(source.id, mode).catch((err) => err); } finally {
          unlinked = unlink.mock.calls.map(([p]) => path.resolve(String(p)));
          unlink.mockRestore();
          restore();
        }
        // Project state is proven safe, so a private-only failure is an ordinary one.
        expect(error.code).toBe('FILESYSTEM_OPERATION_FAILED');
        if (role === 'staged-original') expect(error.cause).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(unlinked).not.toContain(sourcePath);
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        if (mode !== 'reencode') expect(fs.existsSync(outputPath)).toBe(false);
        expect(rows()).toEqual([expect.objectContaining({
          artifactRole: role, identity: null, lifecycle: 'dispensable',
          observation: 'ownership-unknown', retentionReason: 'conversion-cleanup-residue',
        })]);
        expect(groups()).toEqual([expect.objectContaining({ checkpoint: null })]);
      },
    );

    it('propagates a failed residue settlement instead of an ordinary downgrade, leaving the private copy', async () => {
      const source = writeIndexedImage('Final/evidence.png');
      const { sourcePath, outputPath } = paths('evidence', 'delete');
      const sourceBytes = fs.readFileSync(sourcePath);
      const { convert } = harness({ fail: { setEvidenceLifecycle: ([, , lifecycle]) => lifecycle === 'dispensable' } });
      const restore = mockStatOverrides((p) => isPrivate(p) && p.endsWith('.original') ? { ino: 0n } : null);
      let error;
      try { error = await convert(source.id, 'delete').catch((err) => err); } finally { restore(); }
      expect(error.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
      // Already-safe project state is not undone; the private copies stay untouched.
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(stageNames(path.join(projectDir, '.creatorcrate-convert-staging'))).toEqual(['0.original', '0.output']);
      expect(groups()[0].checkpoint).not.toBeNull();
    });

    it.each(['present', 'missing', 'replaced', 'unavailable'])(
      'records safe cleanup residue from the existing %s diagnostic', async (observation) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { convert } = harness();
        const realUnlink = fs.unlinkSync.bind(fs);
        const realLstat = fs.lstatSync.bind(fs);
        let failedPath;
        let originalRow;
        const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((p, ...rest) => {
          if (isPrivate(p) && String(p).endsWith('.output')) {
            originalRow = rows().find((row) => row.artifactRole === 'stage-output');
            failedPath = path.resolve(String(p));
            if (observation === 'missing') realUnlink(p);
            if (observation === 'replaced') replaceWithForeignFile(p, Buffer.from('foreign residue'));
            throw Object.assign(new Error('injected cleanup error'), { code: 'EIO' });
          }
          return realUnlink(p, ...rest);
        });
        const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation((p, ...rest) => {
          if (observation === 'unavailable' && failedPath === path.resolve(String(p))) {
            throw Object.assign(new Error('injected diagnostic error'), { code: 'EIO' });
          }
          return realLstat(p, ...rest);
        });
        let result;
        try { result = await convert(source.id, 'output'); } finally { lstat.mockRestore(); unlink.mockRestore(); }
        expect(result.convertedCount).toBe(1);
        expect(rows()).toEqual([expect.objectContaining({
          evidenceId: originalRow.evidenceId, identity: originalRow.identity, artifactRole: 'stage-output',
          lifecycle: 'dispensable', retentionReason: 'conversion-cleanup-residue', observation,
        })]);
        expect(groups()).toEqual([expect.objectContaining({ groupId: originalRow.mutationGroupId, checkpoint: null })]);
      },
    );

    it('treats the Originals copy as public project state, never as private cleanup evidence', async () => {
      const source = writeIndexedImage('Final/evidence.png');
      const { sourcePath, originalPath } = paths('evidence', 'move');
      const sourceBytes = fs.readFileSync(sourcePath);
      const { convert, events } = harness();
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinked = [];
      const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((p, ...rest) => {
        unlinked.push(path.resolve(String(p)));
        // Every private cleanup fails, leaving residue behind.
        if (isPrivate(p)) throw Object.assign(new Error('injected cleanup error'), { code: 'EIO' });
        return realUnlink(p, ...rest);
      });
      let result;
      try { result = await convert(source.id, 'move'); } finally { unlink.mockRestore(); }
      expect(result.convertedCount).toBe(1);
      const originals = intents(events).find((row) => row.artifactRole === 'originals-copy');
      // The moved asset is the very file the Originals copy created, never touched by cleanup.
      expect(fs.readFileSync(originalPath)).toEqual(sourceBytes);
      expect(unlinked).not.toContain(originalPath);
      const attached = events.find((event) => event.name === 'attachEvidenceIdentity' && event.args[1] === originals.evidenceId);
      expect(exactIdentityOf(originalPath)).toEqual({ dev: String(attached.args[2].dev), ino: String(attached.args[2].ino) });
      expect(assetRepository.findById(source.id).relative_path).toBe('Final/originals/evidence.png');
      // Its tracking row was promoted for the unlink, retired after resolution, and never treated
      // as a private cleanup candidate.
      const touching = events.filter((event) => event.args?.[1] === originals.evidenceId);
      expect(touching.some((event) => event.name === 'setEvidenceLifecycle' && event.args[2] === 'dispensable')).toBe(false);
      expect(touching.some((event) => event.name === 'setEvidenceRetentionReason'
        && ['conversion-cleanup-residue', 'conversion-verified-rollback'].includes(event.args[2]))).toBe(false);
      expect(events.findIndex((event) => event.name === 'deleteEvidence' && event.args[1] === originals.evidenceId))
        .toBeGreaterThan(events.findIndex((event) => event.name === 'clearMutationCheckpoint'));
      // Only the private residue remains, and only as private evidence.
      expect(rows().map((row) => row.artifactRole).sort()).toEqual(['stage-output']);
      expect(rows()[0]).toMatchObject({ lifecycle: 'dispensable', retentionReason: 'conversion-cleanup-residue' });
    });

    it('rolls Conversion asset/index changes and evidence finalization back together', async () => {
      const first = writeIndexedImage('Final/evidence.png');
      const second = writeIndexedImage('Final/second.png');
      const bytes = fs.readFileSync(path.join(projectDir, 'Final', 'evidence.png'));
      let finalized = 0;
      let during;
      let afterTransaction;
      const { convert } = harness({
        fail: { setEvidenceLifecycle: ([, , lifecycle]) => {
          if (!db.inTransaction || lifecycle !== 'dispensable') return false;
          finalized += 1;
          if (finalized !== 3) return false;
          // The second item's finalization fails after the first item's was applied.
          during = {
            deleted: assetRepository.findById(first.id),
            output: assetRepository.findByProjectIdAndPath(project.id, 'Final/evidence.webp'),
            committed: rows().filter((row) => row.retentionReason === 'conversion-committed').length,
          };
          return true;
        } },
        before: { setEvidenceRetentionReason: ([, , reason]) => {
          if (reason !== 'conversion-database-failed' || afterTransaction) return;
          afterTransaction = {
            inTransaction: db.inTransaction,
            source: assetRepository.findById(first.id),
            output: assetRepository.findByProjectIdAndPath(project.id, 'Final/evidence.webp'),
            rows: rows(),
          };
        } },
      });
      const error = await convert([first.id, second.id], 'delete').catch((err) => err);
      expect(error).toMatchObject({
        code: 'DATABASE_OPERATION_FAILED', cause: { code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' },
      });
      // Inside the transaction the deletes and outputs were applied and evidence finalized...
      expect(during).toMatchObject({ deleted: undefined, output: expect.objectContaining({ id: expect.any(Number) }) });
      expect(during.committed).toBeGreaterThan(0);
      // ...and all of it was rolled back before the filesystem rollback began.
      expect(afterTransaction.inTransaction).toBe(false);
      expect(afterTransaction.source).toMatchObject({ id: first.id });
      expect(afterTransaction.output).toBeUndefined();
      expect(afterTransaction.rows.some((row) => row.retentionReason === 'conversion-committed')).toBe(false);
      expect(afterTransaction.rows.filter((row) => !PUBLIC_ROLES.includes(row.artifactRole))
        .every((row) => row.lifecycle === 'recovery-critical')).toBe(true);
      expect(afterTransaction.rows.every((row) => row.assetId !== null)).toBe(true);
      // The filesystem rollback ran afterwards and restored both sources.
      expect(fs.readFileSync(path.join(projectDir, 'Final', 'evidence.png'))).toEqual(bytes);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'second.png'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'evidence.webp'))).toBe(false);
      expect(assetRepository.findById(second.id)).toBeTruthy();
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it.each(['reencode', 'move', 'delete'])(
      'never rolls committed %s state back when post-commit resolution fails', async (mode) => {
        const source = writeIndexedImage('Final/evidence.png');
        const { sourcePath, outputPath, originalPath } = paths('evidence', mode);
        const sourceBytes = fs.readFileSync(sourcePath);
        const { convert, events } = harness({ fail: { clearMutationCheckpoint: () => true } });
        const restore = recordFilesystem(events);
        let error;
        try { error = await convert(source.id, mode).catch((err) => err); } finally { restore(); }
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'resolution' });
        // The commit transaction's last evidence write: a public row recording the committed state.
        const committedAt = events.findLastIndex((event) => event.inTransaction && event.name === 'setEvidenceObservation'
          && event.args[2] === 'present');
        const resolutionAt = events.findIndex((event) => event.type === 'failed' && event.name === 'clearMutationCheckpoint');
        expect(committedAt).toBeGreaterThan(-1);
        expect(resolutionAt).toBeGreaterThan(committedAt);
        // No restoration, withdrawal or private disposal after the commit.
        expect(events.slice(committedAt).filter((event) => ['create', 'unlink'].includes(event.type))).toEqual([]);

        const outputBytes = fs.readFileSync(outputPath);
        const output = assetRepository.findByProjectIdAndPath(project.id, relative(outputPath));
        expect(output).toMatchObject({ size_bytes: outputBytes.length });
        if (mode === 'delete') {
          expect(assetRepository.findById(source.id)).toBeUndefined();
          expect(fs.existsSync(sourcePath)).toBe(false);
        }
        if (mode === 'move') {
          expect(assetRepository.findById(source.id).relative_path).toBe('Final/originals/evidence.png');
          expect(fs.readFileSync(originalPath)).toEqual(sourceBytes);
          expect(fs.existsSync(sourcePath)).toBe(false);
        }

        const [group] = groups();
        expect(group).toMatchObject({ itemKey: `asset:${source.id}`, operation: 'convert', runId: RUN,
          checkpoint: mode === 'reencode' ? 'replace' : 'unlink' });
        const remaining = rows();
        expect(remaining.map((row) => row.artifactRole).sort()).toEqual([...ROLES[mode]].sort());
        for (const row of remaining) {
          expect(row.retentionReason).toBe('conversion-committed');
          expect(row.mutationGroupId).toBe(group.groupId);
          expect(row.sourcePath).toBe('Final/evidence.png');
          if (PUBLIC_ROLES.includes(row.artifactRole)) {
            expect(row).toMatchObject({ observation: 'present' });
            expect(row.lifecycle).not.toBe('dispensable');
          } else {
            expect(row.lifecycle).toBe('dispensable');
            // Its private copy is left in place, as the conservative residue it describes.
            expect(fs.existsSync(path.join(projectDir, ...row.artifactPath.split('/')))).toBe(true);
          }
        }
        // A deleted source asset nulls the asset link; item key and paths still identify the item.
        if (mode === 'delete') {
          expect(remaining.every((row) => row.assetId === null)).toBe(true);
          expect(remaining.find((row) => row.artifactRole === 'published-output').destinationPath).toBe('Final/evidence.webp');
        } else {
          expect(remaining.every((row) => row.assetId === source.id)).toBe(true);
        }
      },
    );

    it.each([
      ['published-output', 'move'], ['originals-copy', 'move'], ['staged-original', 'delete'], ['group', 'output'],
    ])('keeps committed state when deleting the post-commit %s evidence fails (%s)', async (target, mode) => {
      const source = writeIndexedImage('Final/evidence.png');
      const { outputPath, originalPath } = paths('evidence', mode);
      const { convert, events } = harness({ fail: {
        deleteEvidence: ([, id], { roleOf }) => roleOf(id) === target,
        deleteMutationGroup: () => target === 'group',
      } });
      const restore = recordFilesystem(events);
      let error;
      try { error = await convert(source.id, mode).catch((err) => err); } finally { restore(); }
      expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'deletion' });
      expect(events.filter((event) => event.type === 'unlink' && [outputPath, originalPath].includes(event.path))).toEqual([]);
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(assetRepository.findByProjectIdAndPath(project.id, relative(outputPath))).toBeTruthy();
      if (mode === 'move') expect(fs.existsSync(originalPath)).toBe(true);
      expect(groups()).toEqual([expect.objectContaining({ checkpoint: null })]);
      if (target !== 'group') expect(rows().map((row) => row.artifactRole)).toEqual([target]);
    });

    it('isolates each source asset in its own group of one run when a sibling cannot be restored', async () => {
      const first = writeIndexedImage('Final/evidence.png');
      const second = writeIndexedImage('Final/second.png');
      const firstSource = path.join(projectDir, 'Final', 'evidence.png');
      const secondBytes = fs.readFileSync(path.join(projectDir, 'Final', 'second.png'));
      const { convert, events } = harness();
      const apply = vi.spyOn(assetRepository, 'applyAssetConversions').mockImplementation(() => {
        fs.writeFileSync(firstSource, 'foreign occupant');
        throw new Error('injected database failure');
      });
      let error;
      try { error = await convert([first.id, second.id], 'delete').catch((err) => err); } finally { apply.mockRestore(); }
      expect(error.code).toBe('RECOVERY_REQUIRED');
      const started = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(started.map((group) => [group.runId, group.itemKey])).toEqual([
        [RUN, `asset:${first.id}`], [RUN, `asset:${second.id}`],
      ]);
      expect(new Set(started.map((group) => group.groupId)).size).toBe(2);
      // Only the unrestored item stays unresolved; its sibling was restored and fully settled.
      expect(groups()).toEqual([expect.objectContaining({ groupId: started[0].groupId, checkpoint: 'unlink' })]);
      expect(rows().length).toBeGreaterThan(0);
      expect(rows().every((row) => row.mutationGroupId === started[0].groupId && row.assetId === first.id)).toBe(true);
      expect(fs.readFileSync(path.join(projectDir, 'Final', 'second.png'))).toEqual(secondBytes);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'second.webp'))).toBe(false);
    });

    it('shares one fallback run ID across the groups of a direct call without a job', async () => {
      const first = writeIndexedImage('Final/evidence.png');
      const second = writeIndexedImage('Final/second.png');
      const { service, events } = harness();
      const options = { format: 'webp', quality: 80, originalHandling: 'delete' };
      await service.convertAssets(project.id, [first.id, second.id], options);
      await service.convertAssets(project.id, [writeIndexedImage('Final/third.png').id], options);
      const started = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(started.map((group) => group.itemKey)).toEqual([
        `asset:${first.id}`, `asset:${second.id}`, expect.stringMatching(/^asset:\d+$/),
      ]);
      expect(started[0].runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(started[1].runId).toBe(started[0].runId);
      // A separate invocation is a separate run.
      expect(started[2].runId).not.toBe(started[0].runId);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it('settles no evidence before the cross-item final validation refuses the commit', async () => {
      const first = writeIndexedImage('Final/cross-a.png');
      const second = writeIndexedImage('Final/cross-b.png');
      const outputA = path.resolve(projectDir, 'Final', 'cross-a.webp');
      const outputB = path.resolve(projectDir, 'Final', 'cross-b.webp');
      const { convert, events } = harness();
      let bCreated = false;
      let mutated = false;
      const apply = vi.spyOn(assetRepository, 'applyAssetConversions');
      const unhook = hookFileDescriptors({
        onOpen(filePath, flags) {
          if (filePath === outputB && isExclusiveOpen(flags)) bCreated = true;
          else if (bCreated && !mutated && filePath === outputB && isReadOpen(flags)) {
            mutated = true;
            rewriteInPlace(outputA, Buffer.from('output A rewritten in place'));
          }
        },
      });
      let error;
      let applied;
      try { error = await convert([first.id, second.id], 'output').catch((err) => err); } finally {
        unhook();
        applied = apply.mock.calls.length;
        apply.mockRestore();
      }
      expect(mutated).toBe(true);
      expect(applied).toBe(0);
      expect(error.code).toBe('OUTPUT_DESTINATION_CONFLICT');
      // Before the rollback names the failing phase, no row was made dispensable or resolved.
      const rollbackAt = events.findIndex((event) => event.name === 'setEvidenceRetentionReason'
        && event.args[2] === 'conversion-publication-failed');
      expect(rollbackAt).toBeGreaterThan(-1);
      expect(events.slice(0, rollbackAt).filter((event) => event.name === 'clearMutationCheckpoint'
        || (event.name === 'setEvidenceLifecycle' && event.args[2] === 'dispensable'))).toEqual([]);
      expect(events.some((event) => event.name === 'setEvidenceRetentionReason'
        && event.args[2] === 'conversion-committed')).toBe(false);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it('starts new groups for a repeated re-encode of committed state without reusing evidence', async () => {
      const source = writeIndexedImage('Final/evidence.png');
      const { sourcePath } = paths('evidence', 'reencode');
      const first = harness();
      await first.convert(source.id, 'reencode', 'run-1');
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
      const committed = fs.readFileSync(sourcePath);
      const second = harness();
      const result = await second.convert(source.id, 'reencode', 'run-2');
      expect(result.convertedAssetIds).toEqual([source.id]);
      const started = second.events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(started).toEqual([expect.objectContaining({ runId: 'run-2', itemKey: `asset:${source.id}` })]);
      expect(first.events.find((event) => event.name === 'createMutationGroup').result.groupId)
        .not.toBe(started[0].groupId);
      // The second run protects the first run's committed output as its source.
      expect(intents(second.events).find((row) => row.artifactRole === 'original-backup')).toMatchObject({
        runId: 'run-2', expectedSize: committed.length, expectedSha256: sha(committed),
      });
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it('bounds the item key by the asset ID whatever the source path length', async () => {
      const name = `long-${'n'.repeat(90)}`;
      const source = writeIndexedImage(`Final/${name}.png`);
      const { convert, events } = harness();
      await convert(source.id, 'output');
      const [group] = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(group.itemKey).toBe(`asset:${source.id}`);
      expect(group.itemKey.length).toBeLessThan(32);
      expect(intents(events).find((row) => row.artifactRole === 'published-output').artifactPath)
        .toBe(`Final/${name}.webp`);
      expect(rows()).toEqual([]);
    });
  });

  describe('Workflow Prompt recovery', () => {
    const editOptions = { positive: { rules: [{ type: 'append', text: ' changed' }] } };

    // Zero IDs can prove neither "already restored" nor "ours", and the source must later be
    // unlinked by its exact identity: a zero-ID source is refused before any backup is
    // created or the source is touched. Nothing needs recovery, so this is an ordinary
    // failure whose rollback log still names the refusal.
    it('refuses a zero-ID Prompt source before copying or unlinking it', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/recover-zero-id.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'recover-zero-id.png');
      const before = fs.readFileSync(target);
      expect(isKnownDirectoryIdentity({ dev: fs.lstatSync(target).dev, ino: 0 })).toBe(false);
      const restoreStats = mockStatOverrides((filePath) => (filePath === path.resolve(target) ? { ino: 0 } : null));
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let published;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        published = fs.readFileSync(target);
        throw new Error('injected database failure');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
        expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === path.resolve(target)))
          .toEqual([]);
      } finally {
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
        restoreStats();
      }

      expect(published).toBeUndefined();
      expect(fs.readFileSync(target)).toEqual(before);
      expect(promptWorkspaces()).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.succeeded',
        context: expect.objectContaining({
          recoveryPhase: 'publication',
          restored: true,
          cleanupSucceeded: true,
          retainedRecoveryCriticalCount: 0,
          failures: [{
            assetId: source.id,
            itemIndex: 0,
            artifactRole: 'original-backup',
            check: 'backup-create-failed',
            proof: 'reference-identity-unknown',
            pathState: 'present',
            identity: 'unknown',
          }],
        }),
      }));
    });

    const isPromptStagePath = (filePath) => String(filePath).includes('.creatorcrate-workflow-prompts-')
      && String(filePath).endsWith('.png');

    // Recovery diagnostics carry only bounded, path-free evidence (never prompt text).
    function expectPrivacySafeRecoveryLog(entry, privateTexts) {
      expect(() => JSON.stringify(entry)).not.toThrow();
      const strings = [];
      const collect = (value) => {
        if (typeof value === 'string') strings.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
      };
      collect(entry.context);
      for (const value of strings) {
        expect(path.isAbsolute(value)).toBe(false);
        expect(value).not.toContain(projectDir);
        for (const text of privateTexts) expect(value).not.toContain(text);
      }
    }

    // The live SMB incident, minus the hard link: the source is untouched and its backup was
    // copied (own identity 77:1842051), then only a private cleanup failed. The project is
    // positively intact, so this must be an ordinary failure with residue, never
    // RECOVERY_REQUIRED, while the log still carries the SMB identities.
    it('reports an unremovable copied Prompt backup as residue when the source was never touched', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const promptText = 'private-prompt-body';
      const appendText = ' private-append';
      const source = writeIndexedPromptPng('Final/diag-backup-residue.png', 'parameters', promptText);
      const target = path.resolve(projectDir, 'Final', 'diag-backup-residue.png');
      const before = fs.readFileSync(target);
      const smb = mockSmbPromptIdentities(target, {
        source: { dev: 77n, ino: 10775n },
        backup: { dev: 77n, ino: 1842051n },
        stage: { dev: 77n, ino: 1842052n },
        replacements: [],
      });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        const resolved = path.resolve(String(filePath));
        if (resolved === target) throw Object.assign(new Error('injected source unlink failure'), { code: 'EBUSY' });
        if (isPromptBackupPath(resolved)) throw Object.assign(new Error('injected backup unlink failure'), { code: 'EIO' });
        return realUnlink(filePath, ...args);
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], {
          positive: { rules: [{ type: 'append', text: appendText }] },
        })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      } finally {
        unlinkSpy.mockRestore();
        smb.restore();
      }

      expect(fs.readFileSync(target)).toEqual(before);
      const [workspace] = promptWorkspaces();
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.png'))).toBe(false);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledTimes(1);
      const [entry] = applicationLogger.warn.mock.calls[0];
      expect(entry).toMatchObject({ event: 'processing.recovery.succeeded' });
      expect(entry.context).toMatchObject({
        operation: 'workflow-prompt',
        recoveryPhase: 'publication',
        restored: true,
        cleanupSucceeded: false,
        diagnosticCount: 1,
        failedCleanupCount: 1,
        retainedRecoveryCriticalCount: 0,
      });
      expect(entry.context.failures).toEqual([{
        assetId: source.id,
        itemIndex: 0,
        artifactRole: 'original-backup',
        check: 'cleanup-unlink-failed',
        pathState: 'present',
        identity: 'matched',
        expected: '77:1842051',
        observed: '77:1842051',
        errorCode: 'EIO',
        cleanup: 'residue',
      }]);
      expectPrivacySafeRecoveryLog(entry, [promptText, appendText.trim()]);
    });

    // Once the edit is committed the stage is a dispensable private copy: an unlink failure
    // leaves residue and a warning, never RECOVERY_REQUIRED, and the result stays completed.
    it('completes a committed Prompt edit and reports an unremovable stage as residue', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/diag-stage-cleanup.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'diag-stage-cleanup.png');
      const before = fs.readFileSync(target);
      const realUnlink = fs.unlinkSync.bind(fs);
      let stageUnlinkAttempts = 0;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (isPromptStagePath(filePath)) {
          stageUnlinkAttempts += 1;
          throw Object.assign(new Error('injected stage unlink failure'), { code: 'EIO' });
        }
        return realUnlink(filePath, ...args);
      });

      let result;
      try {
        result = await processingService.editWorkflowPrompts(project.id, [source.id], editOptions);
      } finally {
        unlinkSpy.mockRestore();
      }

      expect(result).toMatchObject({ status: 'completed', changedCount: 1, changedAssetIds: [source.id] });
      expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(before, editOptions).buffer);
      expect(assetRepository.findById(source.id).source_generation).toBe(source.source_generation + 1);
      const [workspace] = promptWorkspaces();
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.png'))).toBe(true);
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toBe(false);
      expect(stageUnlinkAttempts).toBe(1);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledTimes(1);
      const [entry] = applicationLogger.warn.mock.calls[0];
      expect(entry).toMatchObject({ event: 'processing.cleanup.residue', level: 'warn' });
      expect(entry.context).toMatchObject({
        operation: 'workflow-prompt',
        recoveryPhase: 'cleanup',
        cleanupSucceeded: false,
        failedCleanupCount: 1,
        retainedRecoveryCriticalCount: 0,
      });
      expect(entry.context.failures).toEqual([{
        assetId: source.id,
        itemIndex: 0,
        artifactRole: 'stage-output',
        check: 'cleanup-unlink-failed',
        pathState: 'present',
        identity: 'matched',
        expected: expect.stringMatching(/^\d+:\d+$/),
        observed: expect.stringMatching(/^\d+:\d+$/),
        errorCode: 'EIO',
        cleanup: 'residue',
      }]);
      expectPrivacySafeRecoveryLog(entry, ['original changed']);
    });

    // The cleanup helper's own ownership inspection fails, so unlink is never attempted. A
    // later diagnostic observation succeeds (the stage is present and matched); the check
    // must still name the inspection, not an unlink that never happened.
    it('names a failed cleanup ownership inspection instead of an unlink failure', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/diag-stage-inspect.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'diag-stage-inspect.png');
      const before = fs.readFileSync(target);
      const realLstat = fs.lstatSync.bind(fs);
      const realUnlink = fs.unlinkSync.bind(fs);
      let stageInspectionFailures = 0;
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (isPromptStagePath(filePath) && new Error().stack.includes('removeFileIfExactIdentityMatches')) {
          stageInspectionFailures += 1;
          throw Object.assign(new Error('injected stage inspection failure'), { code: 'EIO' });
        }
        return realLstat(filePath, ...args);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => realUnlink(filePath, ...args));

      let result;
      try {
        result = await processingService.editWorkflowPrompts(project.id, [source.id], editOptions);
      } finally {
        unlinkSpy.mockRestore();
        lstatSpy.mockRestore();
      }

      // Committed edit; only the owned stage stays, as residue.
      expect(result).toMatchObject({ status: 'completed', changedCount: 1 });
      expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(before, editOptions).buffer);
      const [workspace] = promptWorkspaces();
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.png'))).toBe(true);
      expect(stageInspectionFailures).toBe(1);
      expect(unlinkSpy.mock.calls.filter(([filePath]) => isPromptStagePath(filePath))).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      const [entry] = applicationLogger.warn.mock.calls[0];
      expect(entry.context).toMatchObject({
        cleanupSucceeded: false, failedCleanupCount: 1, retainedRecoveryCriticalCount: 0,
      });
      expect(entry.context.failures).toEqual([{
        assetId: source.id,
        itemIndex: 0,
        artifactRole: 'stage-output',
        check: 'cleanup-inspection-failed',
        pathState: 'present',
        identity: 'matched',
        expected: expect.stringMatching(/^\d+:\d+$/),
        observed: expect.stringMatching(/^\d+:\d+$/),
        errorCode: 'EIO',
        cleanup: 'residue',
      }]);
      expectPrivacySafeRecoveryLog(entry, ['original changed']);
    });

    // Full database-failure rollback in the descriptor-owned model: the owned replacement is
    // removed by its exact identity and the original is recreated as a new owned file from
    // the backup, with its mode and indexed mtime reapplied. No hard link is involved.
    it('rolls back a Prompt database failure by recreating the original as a new owned file', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/db-rollback-owned.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'db-rollback-owned.png');
      const before = fs.readFileSync(target);
      const beforeMode = fs.statSync(target).mode;
      let published;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        published = { bytes: fs.readFileSync(target), ino: fs.lstatSync(target, { bigint: true }).ino };
        throw new Error('injected database failure');
      });
      const linkSpy = vi.spyOn(fs, 'linkSync');

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      } finally {
        linkSpy.mockRestore();
        applySpy.mockRestore();
      }

      expect(linkSpy).not.toHaveBeenCalled();
      expect(published.bytes).toEqual(editWorkflowPromptsInPng(before, editOptions).buffer);
      // Correct path, original bytes, reapplied metadata; the identity is simply whatever the
      // new restore descriptor created (never required to equal the pre-run inode).
      expect(fs.readFileSync(target)).toEqual(before);
      expect(fs.statSync(target).mode).toBe(beforeMode);
      expect(fs.statSync(target).mtime.toISOString()).toBe(source.modified_at);
      expect(assetRepository.findById(source.id)).toMatchObject({
        size_bytes: source.size_bytes,
        modified_at: source.modified_at,
        source_generation: source.source_generation,
      });
      expect(promptWorkspaces()).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.succeeded',
        context: { operation: 'workflow-prompt', assetCount: 1, phase: 'rollback' },
      }));
    });

    // Rollback removed the owned replacement, then a foreign file appeared at the source path
    // before the exclusive restore: EEXIST never overwrites or adopts it and the backup stays.
    it('never overwrites a file that appears at the Prompt source path before the original is restored', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/restore-eexist.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'restore-eexist.png');
      const before = fs.readFileSync(target);
      const foreign = Buffer.from('foreign file at the source path');
      const realOpen = fs.openSync.bind(fs);
      let rollingBack = false;
      let appeared = false;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (rollingBack && !appeared && flags === 'wx+' && path.resolve(String(filePath)) === target) {
          appeared = true;
          fs.writeFileSync(target, foreign);
        }
        return realOpen(filePath, flags, ...args);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        rollingBack = true;
        throw new Error('injected database failure');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        applySpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(appeared).toBe(true);
      expect(fs.readFileSync(target)).toEqual(foreign);
      const [workspace] = promptWorkspaces();
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
      expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({
          recoveryPhase: 'database',
          restored: false,
          failures: expect.arrayContaining([
            expect.objectContaining({
              artifactRole: 'restored-source', check: 'restore-create-failed', errorCode: 'EEXIST',
            }),
            expect.objectContaining({
              artifactRole: 'original-backup', check: 'retained-unrestored', cleanup: 'recovery-critical',
            }),
          ]),
        }),
      }));
    });

    // Remaps real inodes to IDs past 2^53 on first observation at a matching path (lstat, or
    // fstat of a descriptor opened there). Distinct exact bigint IDs such as 2^53 and 2^53 + 1
    // round to the same Number, so only exact bigint comparison tells them apart.
    function mockUnsafePromptFileIds() {
      const realLstat = fs.lstatSync.bind(fs);
      const realFstat = fs.fstatSync.bind(fs);
      const realOpen = fs.openSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      const remapped = new Map();
      const pending = [];
      const remap = (stats, realIno) => {
        const ino = remapped.get(realIno);
        if (ino === undefined) return stats;
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          ino: typeof stats.ino === 'bigint' ? ino : Number(ino),
        });
      };
      const tag = (filePath, realIno) => {
        if (remapped.has(realIno)) return;
        const index = pending.findIndex((entry) => entry.matches(path.resolve(String(filePath)), realIno));
        if (index >= 0) remapped.set(realIno, pending.splice(index, 1)[0].ino);
      };
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        const realIno = realLstat(filePath, { bigint: true }).ino;
        tag(filePath, realIno);
        return remap(stats, realIno);
      });
      const openedPaths = new Map();
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
        const descriptor = realOpen(filePath, ...args);
        openedPaths.set(descriptor, filePath);
        return descriptor;
      });
      const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
        const realIno = realFstat(descriptor, { bigint: true }).ino;
        if (openedPaths.has(descriptor)) tag(openedPaths.get(descriptor), realIno);
        return remap(realFstat(descriptor, ...args), realIno);
      });
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        openedPaths.delete(descriptor);
        return realClose(descriptor, ...args);
      });
      return {
        tagNext(matches, ino) {
          pending.push({ matches, ino });
        },
        markForeign(filePath, ino) {
          remapped.set(realLstat(filePath, { bigint: true }).ino, ino);
        },
        restore() {
          closeSpy.mockRestore();
          fstatSpy.mockRestore();
          openSpy.mockRestore();
          lstatSpy.mockRestore();
        },
      };
    }

    const STAGE_INO = 9007199254740992n; // 2^53
    const BACKUP_INO = 9007199254740994n;
    const PUBLISHED_INO = 9007199254740996n;
    const RESTORED_INO = 9007199254740998n;
    // Tags the stage, the backup and, at the source path, each later object in turn.
    function tagPromptArtifacts(ids, target, laterInos) {
      const originalIno = fs.lstatSync(target, { bigint: true }).ino;
      ids.tagNext((filePath) => isPromptStagePath(filePath), STAGE_INO);
      ids.tagNext((filePath) => String(filePath).includes('.creatorcrate-workflow-prompts-')
        && String(filePath).endsWith('.original'), BACKUP_INO);
      for (const ino of laterInos) {
        ids.tagNext((filePath, realIno) => filePath === path.resolve(target) && realIno !== originalIno, ino);
      }
    }

    it('publishes and cleans up Prompt artifacts whose exact file IDs are past 2^53', async () => {
      const source = writeIndexedPromptPng('Final/unsafe-id-strict.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'unsafe-id-strict.png');
      const ids = mockUnsafePromptFileIds();
      tagPromptArtifacts(ids, target, [PUBLISHED_INO]);
      let published;

      try {
        const result = await processingService.editWorkflowPrompts(project.id, [source.id], editOptions);
        expect(result).toMatchObject({ status: 'completed', changedCount: 1 });
        published = fs.lstatSync(target, { bigint: true }).ino;
      } finally {
        ids.restore();
      }

      expect(published).toBe(PUBLISHED_INO);
      expect(fs.readFileSync(target).includes(Buffer.from('original changed'))).toBe(true);
      expect(promptWorkspaces()).toEqual([]);
    });

    // Removal of the replacement and cleanup of backup and stage all go through exact bigint
    // identities past 2^53; the restored original owns a further such identity.
    it('rolls back Prompt artifacts whose exact file IDs are past 2^53', async () => {
      const source = writeIndexedPromptPng('Final/unsafe-id-rollback.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'unsafe-id-rollback.png');
      const before = fs.readFileSync(target);
      const ids = mockUnsafePromptFileIds();
      tagPromptArtifacts(ids, target, [PUBLISHED_INO, RESTORED_INO]);
      let published;
      let restored;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        published = fs.lstatSync(target, { bigint: true }).ino;
        throw new Error('injected database failure');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        restored = fs.lstatSync(target, { bigint: true }).ino;
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(published).toBe(PUBLISHED_INO);
      expect(restored).toBe(RESTORED_INO);
      expect(fs.readFileSync(target)).toEqual(before);
      expect(promptWorkspaces()).toEqual([]);
    });

    it('never unlinks a foreign destination whose file ID only collides after Number rounding', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/unsafe-id-collision.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'unsafe-id-collision.png');
      const before = fs.readFileSync(target);
      const foreignIno = PUBLISHED_INO + 1n;
      expect(Number(foreignIno)).toBe(Number(PUBLISHED_INO));
      const ids = mockUnsafePromptFileIds();
      tagPromptArtifacts(ids, target, [PUBLISHED_INO]);
      let foreign;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        // A foreign writer replaces the published replacement with a file whose exact ID
        // differs but rounds to the same Number.
        foreign = Buffer.alloc(fs.readFileSync(target).length, 0x42);
        replaceWithForeignFile(target, foreign);
        ids.markForeign(target, foreignIno);
        expect(fs.lstatSync(target).ino).toBe(Number(PUBLISHED_INO));
        throw new Error('injected database failure');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(foreign).toBeDefined();
      expect(fs.readFileSync(target)).toEqual(foreign);
      const [workspace] = promptWorkspaces();
      expect(workspace).toBeDefined();
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
      expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({
          failures: expect.arrayContaining([expect.objectContaining({
            assetId: source.id,
            artifactRole: 'published-output',
            check: 'destination-foreign',
            identity: 'mismatched',
            expected: expect.stringMatching(/:9007199254740996$/),
            observed: expect.stringMatching(/:9007199254740997$/),
          })]),
        }),
      }));
    });

    // Rollback finds the original object back at the source path (exact identity 2^53) and
    // hashes it; during the read a foreign file with identical bytes and exact ID 2^53 + 1
    // replaces the pathname. The hash's Number-based continuity cannot tell them apart, so
    // only the post-read exact identity check keeps recovery unresolved and the backup.
    it('never clears Prompt recovery state when the already-original source is replaced during its hash', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/unsafe-id-already-original.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'unsafe-id-already-original.png');
      const kept = path.join(projectDir, 'Final', 'unsafe-id-already-original.kept');
      const before = fs.readFileSync(target);
      const originalIno = fs.lstatSync(target, { bigint: true }).ino;
      const SOURCE_INO = 9007199254740992n; // 2^53
      const FOREIGN_INO = 9007199254740993n;
      expect(Number(FOREIGN_INO)).toBe(Number(SOURCE_INO));
      const realUnlink = fs.unlinkSync.bind(fs);
      const realReadFile = fs.readFileSync.bind(fs);
      const realFstat = fs.fstatSync.bind(fs);
      const ids = mockUnsafePromptFileIds();
      ids.tagNext((filePath, realIno) => filePath === target && realIno === originalIno, SOURCE_INO);
      let armed = false;
      let swapped = false;
      const rollbackUnlinks = [];
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        const resolved = path.resolve(String(filePath));
        if (armed) rollbackUnlinks.push(resolved);
        else if (resolved === target && !fs.existsSync(kept)) fs.linkSync(target, kept); // keep the original alive
        return realUnlink(filePath, ...args);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        // The original object (exact ID 2^53) is back at the source pathname before rollback.
        fs.rmSync(target);
        fs.linkSync(kept, target);
        fs.rmSync(kept);
        armed = true;
        throw new Error('injected database failure');
      });
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
        if (armed && !swapped && typeof file === 'number' && realFstat(file, { bigint: true }).ino === originalIno) {
          // The descriptor keeps reading the original bytes; the pathname becomes foreign.
          swapped = true;
          replaceWithForeignFile(target, before);
          ids.markForeign(target, FOREIGN_INO);
          expect(fs.lstatSync(target).ino).toBe(Number(SOURCE_INO));
        }
        return realReadFile(file, ...args);
      });

      let foreignIno;
      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        foreignIno = fs.lstatSync(target, { bigint: true }).ino;
      } finally {
        readSpy.mockRestore();
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
        ids.restore();
      }

      expect(swapped).toBe(true);
      expect(foreignIno).toBe(FOREIGN_INO);
      expect(rollbackUnlinks.filter((filePath) => filePath === target || isPromptBackupPath(filePath))).toEqual([]);
      expect(fs.readFileSync(target)).toEqual(before);
      const [workspace] = promptWorkspaces();
      expect(workspace).toBeDefined();
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
      expect(applicationLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.succeeded',
      }));
      expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.failed',
        context: expect.objectContaining({
          restored: false,
          failures: expect.arrayContaining([expect.objectContaining({
            assetId: source.id,
            artifactRole: 'restored-source',
            check: 'destination-foreign',
            identity: 'mismatched',
            expected: expect.stringMatching(/:9007199254740992$/),
            observed: expect.stringMatching(/:9007199254740993$/),
          })]),
        }),
      }));
    });

    // The source path is replaced by a hard link of the stage itself: identical bytes and the
    // stage's exact identity. The stage identity never becomes the public source's
    // ownership, so rollback keeps it and recovery is required.
    it('never treats the stage identity or identical bytes at the Prompt source path as the owned replacement', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/stage-alias-destination.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'stage-alias-destination.png');
      const before = fs.readFileSync(target);
      let stageIno;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        const stagePath = stageArtifact(path.join(projectDir, promptWorkspaces()[0]), '0.png');
        fs.rmSync(target);
        fs.linkSync(stagePath, target);
        stageIno = fs.lstatSync(stagePath, { bigint: true }).ino;
        throw new Error('injected database failure after the source became a stage alias');
      });
      const realUnlink = fs.unlinkSync.bind(fs);
      const rollbackUnlinks = [];
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (stageIno !== undefined && path.resolve(String(filePath)) === target) rollbackUnlinks.push(filePath);
        return realUnlink(filePath, ...args);
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        unlinkSpy.mockRestore();
        applySpy.mockRestore();
      }

      expect(rollbackUnlinks).toEqual([]);
      expect(fs.lstatSync(target, { bigint: true }).ino).toBe(stageIno);
      expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(before, editOptions).buffer);
      const [workspace] = promptWorkspaces();
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
      expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({
          failures: expect.arrayContaining([expect.objectContaining({
            assetId: source.id, artifactRole: 'published-output', check: 'destination-foreign', identity: 'mismatched',
          })]),
        }),
      }));
    });

    it('never cleans up a foreign stage replacement whose file ID only collides after Number rounding', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/rounded-stage.png', 'parameters', 'original');
      const foreign = Buffer.from('foreign stage replacement');
      const foreignIno = STAGE_INO + 1n;
      expect(Number(foreignIno)).toBe(Number(STAGE_INO));
      const ids = mockUnsafePromptFileIds();
      ids.tagNext((filePath) => isPromptStagePath(filePath), STAGE_INO);
      const realApply = assetRepository.applyAssetPromptEdits.bind(assetRepository);
      let stagePath;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation((...args) => {
        // After the edit was published, the stage pathname is swapped for a foreign file whose
        // exact ID differs but rounds to the same Number.
        stagePath = stageArtifact(path.join(projectDir, promptWorkspaces()[0]), '0.png');
        replaceWithForeignFile(stagePath, foreign);
        ids.markForeign(stagePath, foreignIno);
        return realApply(...args);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

      let result;
      try {
        result = await processingService.editWorkflowPrompts(project.id, [source.id], editOptions);
        expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === path.resolve(stagePath)))
          .toEqual([]);
      } finally {
        unlinkSpy.mockRestore();
        applySpy.mockRestore();
        ids.restore();
      }

      expect(result).toMatchObject({ status: 'completed', changedCount: 1 });
      expect(fs.readFileSync(stagePath)).toEqual(foreign);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.cleanup.residue',
        context: expect.objectContaining({
          failures: [expect.objectContaining({
            artifactRole: 'stage-output',
            check: 'cleanup-identity-mismatch',
            expected: expect.stringMatching(/:9007199254740992$/),
            observed: expect.stringMatching(/:9007199254740993$/),
            cleanup: 'residue',
          })],
        }),
      }));
    });

    it('keeps the replacement when the original backup changes in place', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/recover-mutated-backup.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'recover-mutated-backup.png');
      const before = fs.readFileSync(target);
      let backupPath;
      let backupIdentity;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        backupPath = stageArtifact(path.join(projectDir, promptWorkspaces()[0]), '0.original');
        backupIdentity = fs.statSync(backupPath, { bigint: true }).ino;
        fs.writeFileSync(backupPath, Buffer.alloc(before.length, 0x5a), { flag: 'r+' });
        throw new Error('injected database failure');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        applySpy.mockRestore();
      }

      expect(fs.statSync(backupPath, { bigint: true }).ino).toBe(backupIdentity);
      expect(fs.readFileSync(backupPath)).not.toEqual(before);
      expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(before, editOptions).buffer);
      expect(promptWorkspaces()).toHaveLength(1);
      expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({
          failures: expect.arrayContaining([expect.objectContaining({
            assetId: source.id, artifactRole: 'original-backup', check: 'backup-content-mismatch',
          })]),
        }),
      }));
    });

    // Recreating the original fails part-way. The partial restore is withdrawn by its exact
    // identity (no unverified bytes stay at the source path) and the backup, still the only
    // original, is retained as recovery-critical and never unlinked.
    it('withdraws a partial Prompt restore and keeps the backup when recreating the original fails', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/recover-restore-write.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'recover-restore-write.png');
      const before = fs.readFileSync(target);
      let rollingBack = false;
      const restoreWrites = interceptDescriptorWrites(
        (filePath, flags) => rollingBack && flags === 'wx+' && filePath === target,
        () => Object.assign(new Error('injected restore write failure'), { code: 'EIO' }),
      );
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        rollingBack = true;
        throw new Error('injected database failure');
      });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (isPromptBackupPath(filePath)) throw Object.assign(new Error('injected backup unlink failure'), { code: 'EIO' });
        return realUnlink(filePath, ...args);
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(unlinkSpy.mock.calls.filter(([filePath]) => isPromptBackupPath(filePath))).toEqual([]);
      } finally {
        unlinkSpy.mockRestore();
        applySpy.mockRestore();
        restoreWrites();
      }

      expect(fs.existsSync(target)).toBe(false);
      const [workspace] = promptWorkspaces();
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toEqual(before);
      expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({
          recoveryPhase: 'database',
          restored: false,
          cleanupSucceeded: false,
          retainedRecoveryCriticalCount: 2,
          failures: expect.arrayContaining([
            expect.objectContaining({
              assetId: source.id, artifactRole: 'restored-source', check: 'restore-create-failed', errorCode: 'EIO',
            }),
            expect.objectContaining({
              artifactRole: 'original-backup', check: 'retained-unrestored', cleanup: 'recovery-critical',
            }),
          ]),
        }),
      }));
    });

    it('restores an absent destination from the owned original and cleans the workspace', async () => {
      const source = writeIndexedPromptPng('Final/recover-absent.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'recover-absent.png');
      const before = fs.readFileSync(target);
      const realOpen = fs.openSync.bind(fs);
      let failed = false;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (!failed && flags === 'wx+' && path.resolve(String(filePath)) === target) {
          failed = true;
          throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
        }
        return realOpen(filePath, flags, ...args);
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      } finally {
        openSpy.mockRestore();
      }

      expect(failed).toBe(true);
      expect(fs.readFileSync(target)).toEqual(before);
      expect(fs.statSync(target).mtime.toISOString()).toBe(source.modified_at);
      expect(promptWorkspaces()).toEqual([]);
    });

    // The edited replacement WAS published, then disappeared before rollback reached it. A
    // verified restore from the owned backup resolves the item completely (no stale
    // replacementPublished flag), so the database failure stays ordinary and the private
    // backup and stage are cleaned up.
    it('resolves a published Prompt replacement that is already absent once the original is restored', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/recover-published-absent.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'recover-published-absent.png');
      const before = fs.readFileSync(target);
      const beforeMode = fs.statSync(target).mode;
      let published;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        published = fs.readFileSync(target);
        fs.rmSync(target);
        throw new Error('injected database failure after the published replacement vanished');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      } finally {
        applySpy.mockRestore();
      }

      expect(published).toEqual(editWorkflowPromptsInPng(before, editOptions).buffer);
      expect(fs.readFileSync(target)).toEqual(before);
      expect(fs.statSync(target).mode).toBe(beforeMode);
      expect(fs.statSync(target).mtime.toISOString()).toBe(source.modified_at);
      expect(assetRepository.findById(source.id)).toMatchObject({
        size_bytes: source.size_bytes,
        modified_at: source.modified_at,
        source_generation: source.source_generation,
      });
      expect(promptWorkspaces()).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.succeeded',
        context: { operation: 'workflow-prompt', assetCount: 1, phase: 'rollback' },
      }));
    });

    it('clears stale mutation flags when the destination is already the original identity', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/recover-already.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'recover-already.png');
      const kept = path.join(projectDir, 'Final', 'recover-already.kept');
      const before = fs.readFileSync(target);
      const realUnlink = fs.unlinkSync.bind(fs);
      const realOpen = fs.openSync.bind(fs);
      let removed = false;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (!removed && path.resolve(String(filePath)) === target) {
          removed = true;
          fs.linkSync(target, kept); // the test keeps the original object alive
        }
        return realUnlink(filePath, ...args);
      });
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (removed && fs.existsSync(kept) && flags === 'wx+' && path.resolve(String(filePath)) === target) {
          // The original object reappears at the pathname before the replacement is created.
          fs.linkSync(kept, target);
          fs.rmSync(kept);
        }
        return realOpen(filePath, flags, ...args);
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      } finally {
        openSpy.mockRestore();
        unlinkSpy.mockRestore();
      }

      expect(fs.readFileSync(target)).toEqual(before);
      expect(fs.existsSync(kept)).toBe(false);
      expect(promptWorkspaces()).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
    });

    it('does not remove the recognized replacement when the staged original is unusable', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const source = writeIndexedPromptPng('Final/recover-bad-backup.png', 'parameters', 'original');
      const target = path.join(projectDir, 'Final', 'recover-bad-backup.png');
      const before = fs.readFileSync(target);
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        fs.rmSync(stageArtifact(path.join(projectDir, promptWorkspaces()[0]), '0.original'));
        throw new Error('injected database failure after the backup was lost');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        applySpy.mockRestore();
      }

      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target).includes(Buffer.from('original changed'))).toBe(true);
      expect(fs.readFileSync(target)).not.toEqual(before);
      expect(promptWorkspaces()).toHaveLength(1);
      expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.failed',
        context: expect.objectContaining({
          recoveryPhase: 'database',
          restored: false,
          failures: expect.arrayContaining([expect.objectContaining({
            assetId: source.id,
            artifactRole: 'original-backup',
            check: 'backup-invalid',
            pathState: 'absent',
            errorCode: 'ENOENT',
          })]),
        }),
      }));
      expect(JSON.stringify(applicationLogger.error.mock.calls)).not.toMatch(/creatorcrate-workflow-prompts|recover-bad-backup|changed/);
    });

    // After the verified source removal a foreign file appears at the source path before the
    // exclusive replacement create: EEXIST never overwrites, adopts or unlinks it, and the
    // original cannot be restored over it, so recovery is required.
    it('never overwrites a file that appears at the Prompt source path before the replacement is created', async () => {
      const source = writeIndexedPromptPng('Final/recover-foreign.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'recover-foreign.png');
      const foreign = Buffer.from('foreign destination');
      const realOpen = fs.openSync.bind(fs);
      let appeared = false;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (!appeared && flags === 'wx+' && path.resolve(String(filePath)) === target) {
          appeared = true;
          fs.writeFileSync(target, foreign);
        }
        return realOpen(filePath, flags, ...args);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

      try {
        await expect(processingService.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(String(filePath)) === target))
          .toHaveLength(1); // the verified source removal only
      } finally {
        unlinkSpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(fs.readFileSync(target)).toEqual(foreign);
      const [workspace] = promptWorkspaces();
      expect(workspace).toBeDefined();
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), '0.original'))).toBe(true);
    });
  });

  // Workflow Prompt artifacts mapped in the recovery evidence registry. Real repositories and
  // transactions on the shared connection; `evidenceHarness` wraps the real repository to
  // record every call (interleaved with filesystem events) and to inject failures.
  describe('Workflow Prompt recovery evidence', () => {
    const editOptions = { positive: { rules: [{ type: 'append', text: ' evidence' }] } };
    const PROMPT_WORKSPACE = '.creatorcrate-workflow-prompts-staging';
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const relativeTo = (absPath) => path.relative(projectDir, absPath).split(path.sep).join('/');
    const jobProgress = (jobId) => Object.assign(() => {}, { jobId });
    let evidenceRepository;

    beforeEach(() => {
      evidenceRepository = createProcessingRecoveryEvidenceRepository(db);
    });

    const groups = () => evidenceRepository.listMutationGroupsByProject(project.id);
    const evidenceRows = () => evidenceRepository.listUnresolvedEvidenceByProject(project.id);
    const rowsByRole = () => Object.fromEntries(evidenceRows().map((row) => [row.artifactRole, row]));
    const workspacePath = () => path.join(projectDir, PROMPT_WORKSPACE);

    // `fail[name](args, ctx)` returning truthy makes that repository call throw before it
    // runs; `before[name](args, ctx)` observes state just before a call. ctx.roleOf maps an
    // evidence ID to the role it was created with.
    function evidenceHarness({ fail = {}, before = {}, ...overrides } = {}) {
      const events = [];
      const roles = new Map();
      const ctx = { roleOf: (evidenceId) => roles.get(evidenceId) };
      const repository = Object.fromEntries(Object.entries(evidenceRepository).map(([name, method]) => [
        name, (...args) => {
          before[name]?.(args, ctx);
          if (fail[name]?.(args, ctx)) {
            events.push({ type: 'db-failed', name, args });
            throw new Error(`injected ${name} failure`);
          }
          const result = method(...args);
          if (name === 'createEvidence') roles.set(result.evidenceId, result.artifactRole);
          events.push({ type: 'db', name, args, result, inTransaction: db.inTransaction });
          return result;
        },
      ]));
      const service = createProcessingService({
        ...processingRecoveryEvidenceDependencies(db, { repository }),
        ...overrides,
      });
      return { service, events, roleOf: ctx.roleOf };
    }

    // Appends exclusive creates, unlinks and directory creation to `events`.
    function recordFilesystem(events) {
      const realOpen = fs.openSync.bind(fs);
      const realUnlink = fs.unlinkSync.bind(fs);
      const realMkdir = fs.mkdirSync.bind(fs);
      const spies = [
        vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          if (typeof flags === 'string' && flags.startsWith('wx')) {
            events.push({ type: 'create', path: path.resolve(String(filePath)) });
          }
          return realOpen(filePath, flags, ...args);
        }),
        vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          events.push({ type: 'unlink', path: path.resolve(String(filePath)) });
          return realUnlink(filePath, ...args);
        }),
        vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, ...args) => {
          events.push({ type: 'mkdir', path: path.resolve(String(dirPath)) });
          return realMkdir(dirPath, ...args);
        }),
      ];
      return () => spies.reverse().forEach((spy) => spy.mockRestore());
    }

    const dbCall = (name, predicate = () => true) => (event) => event.type === 'db' && event.name === name
      && predicate(event);
    const fsCall = (type, predicate) => (event) => event.type === type && predicate(event.path);
    const filesystemMutations = (events) => events.filter((event) => ['create', 'unlink', 'mkdir'].includes(event.type));
    function at(events, predicate) {
      const index = events.findIndex(predicate);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    }

    function exactIdentityOf(absPath) {
      const stats = fs.lstatSync(absPath, { bigint: true });
      return { dev: stats.dev.toString(), ino: stats.ino.toString(), birthtimeNs: null };
    }

    function expectAssetUnchanged(source) {
      expect(assetRepository.findById(source.id)).toMatchObject({
        size_bytes: source.size_bytes,
        modified_at: source.modified_at,
        source_generation: source.source_generation,
      });
    }

    function expectNoEvidence() {
      expect(evidenceRows()).toEqual([]);
      expect(groups()).toEqual([]);
    }

    it('maps every Prompt artifact in durable order and leaves no evidence after a clean run', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      const { service, events, roleOf } = evidenceHarness({ applicationLogger });
      const source = writeIndexedPromptPng('Final/evidence-clean.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-clean.png');
      const before = fs.readFileSync(target);
      const edited = editWorkflowPromptsInPng(before, editOptions).buffer;
      const realApply = assetRepository.applyAssetPromptEdits;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation((...args) => {
        events.push({ type: 'apply', inTransaction: db.inTransaction });
        return realApply.apply(assetRepository, args);
      });
      const restoreFs = recordFilesystem(events);

      let result;
      try {
        result = await service.editWorkflowPrompts(project.id, [source.id], editOptions, jobProgress('job-clean-1'));
      } finally {
        restoreFs();
        applySpy.mockRestore();
      }

      expect(result).toMatchObject({ status: 'completed', changedCount: 1, changedAssetIds: [source.id] });
      expect(fs.readFileSync(target)).toEqual(edited);
      expect(assetRepository.findById(source.id).source_generation).toBe(source.source_generation + 1);

      // One group for the item, under the processing job's run ID.
      const groupCreates = events.filter(dbCall('createMutationGroup'));
      expect(groupCreates.map((event) => event.args[0])).toEqual([{
        projectId: project.id, operation: 'workflow-prompt', runId: 'job-clean-1', itemKey: `asset:${source.id}`,
      }]);
      const { groupId } = groupCreates[0].result;

      // Role, project-relative path and content proof of each intent.
      const intents = Object.fromEntries(events.filter(dbCall('createEvidence'))
        .map((event) => [event.args[0].artifactRole, event.args[0]]));
      expect(Object.keys(intents).sort()).toEqual(['original-backup', 'published-output', 'stage-output']);
      for (const intent of Object.values(intents)) {
        expect(intent).toMatchObject({
          projectId: project.id, mutationGroupId: groupId, assetId: source.id,
          retentionReason: 'publication-pending', identity: null, lifecycle: 'intent',
        });
        for (const key of ['artifactPath', 'sourcePath', 'destinationPath']) {
          if (intent[key] !== undefined) expect(path.isAbsolute(intent[key])).toBe(false);
        }
      }
      expect(intents['stage-output']).toMatchObject({
        artifactPath: expect.stringMatching(/^\.creatorcrate-workflow-prompts-staging\/[0-9a-f]{16}\.0\.png$/),
        sourcePath: 'Final/evidence-clean.png',
        destinationPath: 'Final/evidence-clean.png',
        expectedSize: edited.length,
        expectedSha256: sha256(edited),
      });
      expect(intents['original-backup']).toMatchObject({
        artifactPath: intents['stage-output'].artifactPath.replace(/\.png$/, '.original'),
        sourcePath: 'Final/evidence-clean.png',
        expectedSize: before.length,
        expectedSha256: sha256(before),
      });
      expect(intents['published-output']).toMatchObject({
        artifactPath: 'Final/evidence-clean.png',
        sourcePath: intents['stage-output'].artifactPath,
        expectedSize: edited.length,
        expectedSha256: sha256(edited),
      });

      // Group before the workspace; intent → exclusive create → identity for each private copy.
      const groupAt = at(events, dbCall('createMutationGroup'));
      expect(groupAt).toBeLessThan(at(events, fsCall('mkdir', (dirPath) => dirPath.endsWith(PROMPT_WORKSPACE))));
      const attachOf = (role) => dbCall('attachEvidenceIdentity', (event) => roleOf(event.args[1]) === role);
      for (const [role, matches] of [['stage-output', isPromptStagePath], ['original-backup', isPromptBackupPath]]) {
        const intentAt = at(events, dbCall('createEvidence', (event) => event.args[0].artifactRole === role));
        const createAt = at(events, fsCall('create', matches));
        expect(groupAt).toBeLessThan(intentAt);
        expect(intentAt).toBeLessThan(createAt);
        expect(createAt).toBeLessThan(at(events, attachOf(role)));
      }
      // Publication intent → checkpoint → both recovery-critical copies → source unlink;
      // the replacement identity is durable after its exclusive create.
      const critical = events.filter(dbCall('setEvidenceLifecycle', (event) => event.args[2] === 'recovery-critical'));
      expect(critical.map((event) => roleOf(event.args[1])).sort()).toEqual(['original-backup', 'stage-output']);
      const checkpointAt = at(events, dbCall('markMutationCheckpoint'));
      expect(events[checkpointAt].args).toEqual([project.id, groupId, 'replace']);
      const unlinkAt = at(events, fsCall('unlink', (filePath) => filePath === target));
      const publicCreateAt = at(events, fsCall('create', (filePath) => filePath === target));
      expect(critical.every((event) => events.indexOf(event) > checkpointAt
        && events.indexOf(event) < unlinkAt)).toBe(true);
      expect(at(events, dbCall('createEvidence', (event) => event.args[0].artifactRole === 'published-output')))
        .toBeLessThan(checkpointAt);
      expect(checkpointAt).toBeLessThan(unlinkAt);
      expect(unlinkAt).toBeLessThan(publicCreateAt);
      expect(publicCreateAt).toBeLessThan(at(events, attachOf('published-output')));

      // Asset/index edit and dispensable finalization in one transaction; resolution after
      // it in autocommit; files removed before their rows; the empty group last.
      const applyAt = at(events, (event) => event.type === 'apply');
      expect(events[applyAt].inTransaction).toBe(true);
      const dispensable = events.filter(dbCall('setEvidenceLifecycle', (event) => event.args[2] === 'dispensable'));
      expect(dispensable.map((event) => roleOf(event.args[1])).sort()).toEqual(['original-backup', 'stage-output']);
      expect(dispensable.every((event) => event.inTransaction && events.indexOf(event) > applyAt)).toBe(true);
      const clearAt = at(events, dbCall('clearMutationCheckpoint'));
      expect(events[clearAt].inTransaction).toBe(false);
      expect(Math.max(...dispensable.map((event) => events.indexOf(event)))).toBeLessThan(clearAt);
      for (const [role, matches] of [['stage-output', isPromptStagePath], ['original-backup', isPromptBackupPath]]) {
        const removeAt = at(events, fsCall('unlink', matches));
        const deleteAt = at(events, dbCall('deleteEvidence', (event) => roleOf(event.args[1]) === role));
        expect(clearAt).toBeLessThan(removeAt);
        expect(removeAt).toBeLessThan(deleteAt);
      }
      expect(clearAt).toBeLessThan(at(events, dbCall('deleteEvidence', (event) => roleOf(event.args[1]) === 'published-output')));
      const groupDeletes = events.filter(dbCall('deleteMutationGroup'));
      expect(groupDeletes.map((event) => [event.args[1], event.result])).toEqual([[groupId, true]]);

      expectNoEvidence();
      expect(promptWorkspaces()).toEqual([]);
      expect(applicationLogger.warn).not.toHaveBeenCalled();
      expect(applicationLogger.error).not.toHaveBeenCalled();
    });

    it('maps each Prompt asset of one run to its own mutation group', async () => {
      const sources = ['first', 'second'].map((name) => writeIndexedPromptPng(
        `Final/evidence-multi-${name}.png`, 'parameters', `original-${name}`,
      ));
      const { service, events } = evidenceHarness();

      const result = await service.editWorkflowPrompts(
        project.id, sources.map(({ id }) => id), editOptions, jobProgress('job-multi'),
      );

      expect(result).toMatchObject({ status: 'completed', changedCount: 2 });
      const groupCreates = events.filter(dbCall('createMutationGroup'));
      expect(groupCreates.map((event) => event.args[0])).toEqual(sources.map((source) => ({
        projectId: project.id, operation: 'workflow-prompt', runId: 'job-multi', itemKey: `asset:${source.id}`,
      })));
      const groupIds = groupCreates.map((event) => event.result.groupId);
      expect(new Set(groupIds).size).toBe(2);
      const intents = events.filter(dbCall('createEvidence')).map((event) => event.args[0]);
      expect(intents).toHaveLength(6);
      for (const intent of intents) {
        const source = sources[groupIds.indexOf(intent.mutationGroupId)];
        expect(intent.assetId).toBe(source.id);
        expect(intent.artifactRole === 'published-output' ? intent.artifactPath : intent.sourcePath)
          .toBe(source.relative_path);
      }
      expect(events.filter(dbCall('markMutationCheckpoint')).map((event) => event.args[1])).toEqual(groupIds);
      expect(events.filter(dbCall('clearMutationCheckpoint')).map((event) => event.args[1])).toEqual(groupIds);
      expectNoEvidence();
    });

    it('starts a second Prompt run from the first run\'s committed state without inheriting its evidence', async () => {
      const source = writeIndexedPromptPng('Final/evidence-consecutive.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-consecutive.png');
      const runA = { positive: { rules: [{ type: 'append', text: ' alpha' }] } };
      const runB = { positive: { rules: [{ type: 'append', text: ' beta' }] } };
      const before = fs.readFileSync(target);
      const { service, events } = evidenceHarness();

      await service.editWorkflowPrompts(project.id, [source.id], runA, jobProgress('job-run-a'));
      const afterA = fs.readFileSync(target);
      expect(afterA).toEqual(editWorkflowPromptsInPng(before, runA).buffer);
      expectNoEvidence();

      events.splice(0);
      await service.editWorkflowPrompts(project.id, [source.id], runB, jobProgress('job-run-b'));

      expect(events.filter(dbCall('createMutationGroup')).map((event) => event.args[0].runId)).toEqual(['job-run-b']);
      const backupIntent = events.filter(dbCall('createEvidence'))
        .map((event) => event.args[0]).find((intent) => intent.artifactRole === 'original-backup');
      expect(backupIntent).toMatchObject({ expectedSize: afterA.length, expectedSha256: sha256(afterA) });
      expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(afterA, runB).buffer);
      expect(assetRepository.findById(source.id).source_generation).toBe(source.source_generation + 2);
      expectNoEvidence();
    });

    it('refuses Workflow Prompt before any filesystem mutation without recovery evidence persistence', async () => {
      const service = createProcessingService({
        processingRecoveryEvidenceRecorder: null, processingRecoveryEvidenceRepository: null,
      });
      const source = writeIndexedPromptPng('Final/evidence-no-recorder.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-no-recorder.png');
      const before = fs.readFileSync(target);
      const events = [];
      const restoreFs = recordFilesystem(events);

      try {
        await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_UNAVAILABLE' });
      } finally {
        restoreFs();
      }

      expect(filesystemMutations(events)).toEqual([]);
      expect(fs.existsSync(workspacePath())).toBe(false);
      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      // Conversion records evidence too, so it is refused the same way.
      const image = writeIndexedImage('Final/evidence-dormant.png');
      await expect(service.convertAssets(project.id, [image.id], { format: 'webp', quality: 80, originalHandling: 'keep' }))
        .rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_UNAVAILABLE' });
      expect(fs.existsSync(path.resolve(projectDir, 'Final', 'evidence-dormant.webp'))).toBe(false);
    });

    it('creates no Prompt file when a mutation group cannot be recorded', async () => {
      const sources = ['first', 'second'].map((name) => writeIndexedPromptPng(
        `Final/evidence-group-${name}.png`, 'parameters', `original-${name}`,
      ));
      const targets = sources.map((source) => path.resolve(projectDir, ...source.relative_path.split('/')));
      const before = targets.map((target) => fs.readFileSync(target));
      let groupCalls = 0;
      const { service, events } = evidenceHarness({ fail: { createMutationGroup: () => ++groupCalls === 2 } });
      const restoreFs = recordFilesystem(events);

      try {
        await expect(service.editWorkflowPrompts(project.id, sources.map(({ id }) => id), editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'group' });
      } finally {
        restoreFs();
      }

      expect(filesystemMutations(events)).toEqual([]);
      targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
      // The first item's empty, never-checkpointed group is discarded.
      expectNoEvidence();
    });

    it.each([
      ['stage-output', (filePath) => isPromptStagePath(filePath)],
      ['original-backup', (filePath) => isPromptBackupPath(filePath)],
      ['published-output', () => false],
    ])('creates no %s file and never touches the source when its evidence intent cannot be recorded', async (role, matches) => {
      const source = writeIndexedPromptPng(`Final/evidence-intent-${role}.png`, 'parameters', 'original');
      const target = path.resolve(projectDir, ...source.relative_path.split('/'));
      const before = fs.readFileSync(target);
      const { service, events } = evidenceHarness({
        fail: { createEvidence: ([intent]) => intent.artifactRole === role },
      });
      const restoreFs = recordFilesystem(events);

      try {
        await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'intent' });
      } finally {
        restoreFs();
      }

      expect(events.filter(fsCall('create', matches))).toEqual([]);
      expect(events.filter(fsCall('create', (filePath) => filePath === target))).toEqual([]);
      expect(events.filter(fsCall('unlink', (filePath) => filePath === target))).toEqual([]);
      expect(events.some(dbCall('markMutationCheckpoint'))).toBe(false);
      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      expectNoEvidence();
      expect(promptWorkspaces()).toEqual([]);
    });

    it.each([
      ['stage-output', (filePath) => isPromptStagePath(filePath)],
      ['original-backup', (filePath) => isPromptBackupPath(filePath)],
    ])('discards a %s by its in-memory identity and never touches the source when that identity cannot be recorded', async (role, matches) => {
      const source = writeIndexedPromptPng(`Final/evidence-identity-${role}.png`, 'parameters', 'original');
      const target = path.resolve(projectDir, ...source.relative_path.split('/'));
      const before = fs.readFileSync(target);
      const { service, events } = evidenceHarness({
        fail: { attachEvidenceIdentity: (args, { roleOf }) => roleOf(args[1]) === role },
      });
      const restoreFs = recordFilesystem(events);

      try {
        await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions)).rejects.toMatchObject({
          code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'identity', ownedArtifactRemoved: true,
        });
      } finally {
        restoreFs();
      }

      expect(at(events, fsCall('create', matches))).toBeLessThan(at(events, fsCall('unlink', matches)));
      expect(events.filter(fsCall('unlink', (filePath) => filePath === target))).toEqual([]);
      expect(events.some(dbCall('markMutationCheckpoint'))).toBe(false);
      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      expectNoEvidence();
      expect(promptWorkspaces()).toEqual([]);
    });

    it('removes an owned Prompt replacement whose identity cannot be recorded and restores the original', async () => {
      const source = writeIndexedPromptPng('Final/evidence-identity-public.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-identity-public.png');
      const before = fs.readFileSync(target);
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
      const { service } = evidenceHarness({
        fail: { attachEvidenceIdentity: (args, { roleOf }) => roleOf(args[1]) === 'published-output' },
      });

      let applyCallCount;
      try {
        await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions)).rejects.toMatchObject({
          code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'identity', ownedArtifactRemoved: true,
        });
      } finally {
        applyCallCount = applySpy.mock.calls.length;
        applySpy.mockRestore();
      }

      expect(applyCallCount).toBe(0);
      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      expectNoEvidence();
      expect(promptWorkspaces()).toEqual([]);
    });

    it('never unlinks or replaces the Prompt source when the mutation checkpoint cannot be recorded', async () => {
      const source = writeIndexedPromptPng('Final/evidence-checkpoint.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-checkpoint.png');
      const before = fs.readFileSync(target);
      let beforeCheckpointFailure;
      const { service, events } = evidenceHarness({
        fail: {
          markMutationCheckpoint: () => {
            beforeCheckpointFailure = { groups: groups(), rows: evidenceRows(), source: fs.readFileSync(target) };
            return true;
          },
        },
      });
      const restoreFs = recordFilesystem(events);

      try {
        await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'checkpoint' });
      } finally {
        restoreFs();
      }

      expect(events.filter((event) => event.path === target)).toEqual([]);
      expect(beforeCheckpointFailure.source).toEqual(before);
      expect(beforeCheckpointFailure.groups).toEqual([expect.objectContaining({ checkpoint: null })]);
      expect(beforeCheckpointFailure.rows).toHaveLength(3);
      expect(beforeCheckpointFailure.rows.every((row) => row.lifecycle === 'intent')).toBe(true);
      expect(beforeCheckpointFailure.rows.filter((row) => row.artifactRole !== 'published-output')
        .map((row) => row.observation)).toEqual(['present', 'present']);
      expect(events.some(dbCall('setEvidenceLifecycle', (event) => event.args[2] === 'recovery-critical'))).toBe(false);
      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      expectNoEvidence();
      expect(promptWorkspaces()).toEqual([]);
    });

    it.each(['original-backup', 'stage-output'])(
      'keeps the checkpoint and source intact when %s recovery-critical promotion fails', async (role) => {
        const source = writeIndexedPromptPng(`Final/evidence-promotion-${role}.png`, 'parameters', 'original');
        const target = path.resolve(projectDir, ...source.relative_path.split('/'));
        const before = fs.readFileSync(target);
        const { service, events } = evidenceHarness({
          fail: { setEvidenceLifecycle: (args, { roleOf }) => args[2] === 'recovery-critical' && roleOf(args[1]) === role },
        });
        const restoreFs = recordFilesystem(events);

        try {
          await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions))
            .rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'finalization' });
        } finally {
          restoreFs();
        }

        expect(events.filter((event) => event.path === target)).toEqual([]);
        expect(fs.readFileSync(target)).toEqual(before);
        expectAssetUnchanged(source);
        expect(groups()).toEqual([expect.objectContaining({ checkpoint: 'replace' })]);
        const rows = rowsByRole();
        expect(evidenceRows()).toHaveLength(3);
        expect(rows[role]).toMatchObject({ lifecycle: 'intent', retentionReason: 'publication-pending' });
        if (role === 'stage-output') expect(rows['original-backup'].lifecycle).toBe('recovery-critical');
        expect(rows['stage-output'].lifecycle).toBe('intent');
        expect(events.some(dbCall('clearMutationCheckpoint'))).toBe(false);
        expect(events.some(dbCall('setEvidenceLifecycle', (event) => event.args[2] === 'dispensable'))).toBe(false);
        for (const privateRole of ['stage-output', 'original-backup']) {
          expect(fs.existsSync(path.join(projectDir, rows[privateRole].artifactPath))).toBe(true);
        }
      },
    );

    // After the durable checkpoint and source unlink, a public create whose descriptor
    // exposes no exact identity must retain recovery evidence and never reach DB apply.
    it('requires recovery and keeps the evidence of a Prompt replacement that could not be claimed', async () => {
      const source = writeIndexedPromptPng('Final/evidence-unclaimed.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-unclaimed.png');
      const before = fs.readFileSync(target);
      const realUnlink = fs.unlinkSync.bind(fs);
      const targetUnlinks = [];
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (path.resolve(String(filePath)) === target) targetUnlinks.push(filePath);
        return realUnlink(filePath, ...args);
      });
      const restoreStats = mockStatOverrides((filePath) => (
        filePath === target && targetUnlinks.length > 0 ? { ino: 0 } : null
      ));
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
      const { service } = evidenceHarness();

      let error;
      let applyCallCount;
      try {
        await service.editWorkflowPrompts(project.id, [source.id], editOptions, jobProgress('job-unclaimed'))
          .catch((err) => { error = err; });
      } finally {
        applyCallCount = applySpy.mock.calls.length;
        applySpy.mockRestore();
        restoreStats();
        unlinkSpy.mockRestore();
      }

      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(error.cause).toMatchObject({ code: 'RECOVERY_REQUIRED', evidenceStage: 'identity' });
      expect(applyCallCount).toBe(0);
      expectAssetUnchanged(source);
      expect(targetUnlinks).toHaveLength(1); // the verified source removal only
      expect(fs.existsSync(target)).toBe(true);
      const backupAbs = stageArtifact(workspacePath(), '0.original');
      expect(fs.readFileSync(backupAbs)).toEqual(before);

      const [group, ...otherGroups] = groups();
      expect(otherGroups).toEqual([]);
      expect(group).toMatchObject({
        operation: 'workflow-prompt', runId: 'job-unclaimed', itemKey: `asset:${source.id}`, checkpoint: 'replace',
      });
      const rows = rowsByRole();
      expect(rows['published-output']).toMatchObject({
        mutationGroupId: group.groupId,
        assetId: source.id,
        artifactPath: 'Final/evidence-unclaimed.png',
        identity: null,
        lifecycle: 'recovery-critical',
        retentionReason: 'public-create-unclaimed',
        observation: 'ownership-unknown',
      });
      expect(rows['original-backup']).toMatchObject({
        mutationGroupId: group.groupId,
        lifecycle: 'recovery-critical',
        retentionReason: 'restoration-failed',
        identity: exactIdentityOf(backupAbs),
        expectedSha256: sha256(before),
      });
    });

    // Two assets under one run: the second publication is replaced by a foreign file, so its
    // rollback cannot complete while the first is restored. Only the second item's evidence
    // is retained, recovery-critical, with the full Recovery Details mapping.
    it('retains only the unresolved Prompt item\'s recovery copies with their full mapping', async () => {
      const sources = ['first', 'second'].map((name) => writeIndexedPromptPng(
        `Final/evidence-retained-${name}.png`, 'parameters', `original-${name}`,
      ));
      const targets = sources.map((source) => path.resolve(projectDir, ...source.relative_path.split('/')));
      const before = targets.map((target) => fs.readFileSync(target));
      const edited = before.map((bytes) => editWorkflowPromptsInPng(bytes, editOptions).buffer);
      const foreign = Buffer.from('foreign replacement of the second publication');
      const realOpen = fs.openSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      let secondPublication = null;
      let replaced = false;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        const descriptor = realOpen(filePath, flags, ...args);
        if (!replaced && flags === 'wx+' && path.resolve(String(filePath)) === targets[1]) secondPublication = descriptor;
        return descriptor;
      });
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        const result = realClose(descriptor, ...args);
        if (!replaced && descriptor === secondPublication) {
          replaced = true;
          replaceWithForeignFile(targets[1], foreign);
        }
        return result;
      });
      const { service } = evidenceHarness();

      try {
        await expect(service.editWorkflowPrompts(
          project.id, sources.map(({ id }) => id), editOptions, jobProgress('job-retained'),
        )).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        closeSpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(fs.readFileSync(targets[0])).toEqual(before[0]);
      expect(fs.readFileSync(targets[1])).toEqual(foreign);
      sources.forEach(expectAssetUnchanged);

      // The restored sibling's group is resolved and gone; no run-wide finalization.
      const [group, ...otherGroups] = groups();
      expect(otherGroups).toEqual([]);
      expect(group).toMatchObject({
        projectId: project.id,
        operation: 'workflow-prompt',
        runId: 'job-retained',
        itemKey: `asset:${sources[1].id}`,
        checkpoint: 'replace',
      });
      const rows = evidenceRows();
      expect(rows).toHaveLength(3);
      const backupAbs = stageArtifact(workspacePath(), '1.original');
      const stageAbs = stageArtifact(workspacePath(), '1.png');
      expect(fs.readFileSync(backupAbs)).toEqual(before[1]);
      expect(fs.readFileSync(stageAbs)).toEqual(edited[1]);
      const shared = {
        projectId: project.id,
        operation: 'workflow-prompt',
        runId: 'job-retained',
        itemKey: `asset:${sources[1].id}`,
        mutationGroupId: group.groupId,
        assetId: sources[1].id,
        lifecycle: 'recovery-critical',
      };
      const byRole = rowsByRole();
      expect(byRole['original-backup']).toMatchObject({
        ...shared,
        artifactRole: 'original-backup',
        retentionReason: 'restoration-failed',
        artifactPath: relativeTo(backupAbs),
        sourcePath: sources[1].relative_path,
        destinationPath: null,
        identity: exactIdentityOf(backupAbs),
        expectedSize: before[1].length,
        expectedSha256: sha256(before[1]),
        observation: 'present',
      });
      expect(byRole['stage-output']).toMatchObject({
        ...shared,
        retentionReason: 'restoration-failed',
        artifactPath: relativeTo(stageAbs),
        sourcePath: sources[1].relative_path,
        destinationPath: sources[1].relative_path,
        identity: exactIdentityOf(stageAbs),
        expectedSize: edited[1].length,
        expectedSha256: sha256(edited[1]),
        observation: 'present',
      });
      expect(byRole['published-output']).toMatchObject({
        ...shared,
        retentionReason: 'restoration-failed',
        artifactPath: sources[1].relative_path,
        sourcePath: relativeTo(stageAbs),
        expectedSha256: sha256(edited[1]),
        observation: 'replaced',
      });
      // The replacement's own recorded identity is kept; the foreign file's is never adopted.
      expect(byRole['published-output'].identity).not.toBeNull();
      expect(byRole['published-output'].identity).not.toEqual(exactIdentityOf(targets[1]));
    });

    it.each([
      ['missing', 'stage-output'],
      ['replaced', 'original-backup'],
      ['changed', 'original-backup'],
      ['unavailable', 'original-backup'],
    ])('mirrors %s retained Prompt %s without replacing its descriptor identity', async (observation, role) => {
      const source = writeIndexedPromptPng(`Final/evidence-observation-${observation}.png`, 'parameters', 'original');
      const target = path.resolve(projectDir, ...source.relative_path.split('/'));
      const before = fs.readFileSync(target);
      const edited = editWorkflowPromptsInPng(before, editOptions).buffer;
      const realLstat = fs.lstatSync.bind(fs);
      let unavailablePath;
      let originalRow;
      let retainedPath;
      const statSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (unavailablePath && path.resolve(String(filePath)) === unavailablePath) {
          throw Object.assign(new Error('injected unavailable evidence'), { code: 'EACCES' });
        }
        return realLstat(filePath, ...args);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        originalRow = rowsByRole()[role];
        retainedPath = path.join(projectDir, originalRow.artifactPath);
        if (observation === 'missing') {
          fs.rmSync(retainedPath);
          replaceWithForeignFile(target, Buffer.from('foreign public replacement'));
        } else if (observation === 'replaced') {
          // Create the foreign inode while the owned copy still exists, avoiding inode reuse.
          const foreignPath = `${retainedPath}.foreign`;
          fs.writeFileSync(foreignPath, 'foreign backup');
          fs.rmSync(retainedPath);
          fs.renameSync(foreignPath, retainedPath);
        } else if (observation === 'changed') {
          fs.writeFileSync(retainedPath, Buffer.alloc(before.length, 7));
        } else {
          unavailablePath = retainedPath;
        }
        throw new Error('injected database failure');
      });
      const { service } = evidenceHarness();

      let error;
      try {
        await service.editWorkflowPrompts(project.id, [source.id], editOptions).catch((err) => { error = err; });
      } finally {
        applySpy.mockRestore();
        statSpy.mockRestore();
      }

      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expectAssetUnchanged(source);
      expect(groups()).toEqual([expect.objectContaining({ checkpoint: 'replace' })]);
      const row = rowsByRole()[role];
      expect(row).toMatchObject({
        evidenceId: originalRow.evidenceId,
        mutationGroupId: originalRow.mutationGroupId,
        identity: originalRow.identity,
        lifecycle: 'recovery-critical', retentionReason: 'restoration-failed', observation,
        expectedSize: role === 'stage-output' ? edited.length : before.length,
        expectedSha256: sha256(role === 'stage-output' ? edited : before),
      });
      expect(evidenceRows()).toHaveLength(3);
      if (observation === 'missing') {
        expect(fs.existsSync(retainedPath)).toBe(false);
        expect(error.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          artifactRole: role, check: 'retained-unresolved-publication', pathState: 'absent', cleanup: 'recovery-critical',
        }));
      } else if (observation === 'replaced') {
        expect(row.identity).not.toEqual(exactIdentityOf(retainedPath));
        expect(fs.readFileSync(retainedPath)).toEqual(Buffer.from('foreign backup'));
      } else if (observation === 'changed') {
        expect(exactIdentityOf(retainedPath)).toEqual(originalRow.identity);
        expect(fs.readFileSync(retainedPath)).toEqual(Buffer.alloc(before.length, 7));
      }
    });

    it('keeps filesystem recovery primary when a retained Prompt observation cannot be persisted', async () => {
      const source = writeIndexedPromptPng('Final/evidence-observation-failure.png', 'parameters', 'original');
      const target = path.resolve(projectDir, ...source.relative_path.split('/'));
      let originalRow;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        originalRow = rowsByRole()['stage-output'];
        fs.rmSync(path.join(projectDir, originalRow.artifactPath));
        replaceWithForeignFile(target, Buffer.from('foreign public replacement'));
        throw new Error('injected database failure');
      });
      const { service } = evidenceHarness({ fail: { setEvidenceObservation: (args) => args[2] === 'missing' } });

      let error;
      try {
        await service.editWorkflowPrompts(project.id, [source.id], editOptions).catch((err) => { error = err; });
      } finally {
        applySpy.mockRestore();
      }

      expect(error).toMatchObject({
        code: 'RECOVERY_REQUIRED',
        observationFailure: { code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'observation' },
      });
      expect(groups()).toEqual([expect.objectContaining({ checkpoint: 'replace' })]);
      expect(rowsByRole()['stage-output']).toMatchObject({
        evidenceId: originalRow.evidenceId, identity: originalRow.identity, lifecycle: 'recovery-critical', observation: 'present',
      });
      expect(fs.readFileSync(target)).toEqual(Buffer.from('foreign public replacement'));
    });

    it.each([false, true])(
      'requires durable settlement before downgrading private Prompt recovery (settlement failure: %s)', async (failSettlement) => {
        const source = writeIndexedPromptPng(`Final/evidence-private-settlement-${failSettlement}.png`, 'parameters', 'original');
        const target = path.resolve(projectDir, ...source.relative_path.split('/'));
        const before = fs.readFileSync(target);
        const realUnlink = fs.unlinkSync.bind(fs);
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          if (isPromptStagePath(String(filePath))) {
            throw Object.assign(new Error('injected private unlink failure'), { code: 'EIO' });
          }
          return realUnlink(filePath, ...args);
        });
        const { service, events } = evidenceHarness({
          fail: {
            attachEvidenceIdentity: (args, { roleOf }) => roleOf(args[1]) === 'stage-output',
            setEvidenceLifecycle: (args) => failSettlement && args[2] === 'dispensable',
          },
        });
        const restoreFs = recordFilesystem(events);

        let error;
        try {
          await service.editWorkflowPrompts(project.id, [source.id], editOptions).catch((err) => { error = err; });
        } finally {
          restoreFs();
          unlinkSpy.mockRestore();
        }

        expect(error).toMatchObject(failSettlement
          ? { code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'finalization' }
          : { code: 'FILESYSTEM_OPERATION_FAILED', cause: { code: 'RECOVERY_REQUIRED', evidenceStage: 'identity' } });
        expect(fs.readFileSync(target)).toEqual(before);
        expectAssetUnchanged(source);
        expect(events.filter((event) => event.path === target)).toEqual([]);
        expect(events.some(dbCall('deleteEvidence'))).toBe(false);
        const [row] = evidenceRows();
        expect(evidenceRows()).toHaveLength(1);
        expect(fs.existsSync(path.join(projectDir, row.artifactPath))).toBe(true);
        expect(fs.readFileSync(path.join(projectDir, row.artifactPath))).toHaveLength(0);
        expect(row).toMatchObject({
          artifactRole: 'stage-output', identity: null,
          lifecycle: failSettlement ? 'intent' : 'dispensable',
          retentionReason: failSettlement ? 'publication-pending' : 'cleanup-residue',
          observation: failSettlement ? 'unchecked' : 'ownership-unknown',
        });
        expect(groups()).toEqual([expect.objectContaining({ checkpoint: null })]);
        expect(error.recoveryDiagnostics).toMatchObject({
          restored: true, cleanupSucceeded: false, retainedRecoveryCriticalCount: 0,
        });
        if (failSettlement) expect(events.some(dbCall('clearMutationCheckpoint'))).toBe(false);
        else expect(at(events, dbCall('setEvidenceLifecycle', (event) => event.args[2] === 'dispensable')))
          .toBeLessThan(at(events, dbCall('clearMutationCheckpoint')));
      },
    );

    it('marks Prompt evidence with the database phase before a verified rollback removes it', async () => {
      const source = writeIndexedPromptPng('Final/evidence-db-rollback.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-db-rollback.png');
      const before = fs.readFileSync(target);
      const realOpen = fs.openSync.bind(fs);
      let rollingBack = false;
      let duringRestore;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (rollingBack && !duringRestore && flags === 'wx+' && path.resolve(String(filePath)) === target) {
          duringRestore = { groups: groups(), rows: evidenceRows() };
        }
        return realOpen(filePath, flags, ...args);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        rollingBack = true;
        throw new Error('injected database failure');
      });
      const { service } = evidenceHarness();

      try {
        await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      } finally {
        applySpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(duringRestore.groups).toEqual([expect.objectContaining({ checkpoint: 'replace' })]);
      expect(duringRestore.rows.map((row) => [row.artifactRole, row.lifecycle, row.retentionReason]).sort()).toEqual([
        ['original-backup', 'recovery-critical', 'database-failed'],
        ['published-output', 'recovery-critical', 'database-failed'],
        ['stage-output', 'recovery-critical', 'database-failed'],
      ]);
      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      expectNoEvidence();
      expect(promptWorkspaces()).toEqual([]);
    });

    it('rolls back the Prompt asset edit with its evidence when finalization fails in the transaction', async () => {
      const source = writeIndexedPromptPng('Final/evidence-finalize.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-finalize.png');
      const before = fs.readFileSync(target);
      const realApply = assetRepository.applyAssetPromptEdits;
      let applied;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation((...args) => {
        applied = realApply.apply(assetRepository, args);
        return applied;
      });
      let dispensableCalls = 0;
      let beforeRollback;
      const { service } = evidenceHarness({
        // The stage's dispensable write succeeds in the transaction; the backup's fails.
        fail: { setEvidenceLifecycle: (args) => args[2] === 'dispensable' && ++dispensableCalls === 2 },
        before: {
          setEvidenceRetentionReason: (args) => {
            if (args[2] === 'database-failed' && !beforeRollback) {
              beforeRollback = { asset: assetRepository.findById(source.id), rows: evidenceRows() };
            }
          },
        },
      });

      let error;
      try {
        await service.editWorkflowPrompts(project.id, [source.id], editOptions).catch((err) => { error = err; });
      } finally {
        applySpy.mockRestore();
      }

      expect(error).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(error.cause).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'finalization' });
      // The asset edit ran inside the transaction, then rolled back with the evidence changes.
      expect(applied[0].source_generation).toBe(source.source_generation + 1);
      expect(beforeRollback.asset).toMatchObject({
        size_bytes: source.size_bytes, modified_at: source.modified_at, source_generation: source.source_generation,
      });
      expect(beforeRollback.rows.map((row) => [row.artifactRole, row.lifecycle, row.retentionReason]).sort()).toEqual([
        ['original-backup', 'recovery-critical', 'publication-pending'],
        ['published-output', 'intent', 'publication-pending'],
        ['stage-output', 'recovery-critical', 'publication-pending'],
      ]);
      // Filesystem rollback then ran through the existing Prompt recovery.
      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      expectNoEvidence();
      expect(promptWorkspaces()).toEqual([]);
    });

    it('keeps the committed Prompt edit and its conservative evidence when resolution fails after commit', async () => {
      const source = writeIndexedPromptPng('Final/evidence-resolution.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-resolution.png');
      const before = fs.readFileSync(target);
      const edited = editWorkflowPromptsInPng(before, editOptions).buffer;
      const { service, events } = evidenceHarness({ fail: { clearMutationCheckpoint: () => true } });
      const restoreFs = recordFilesystem(events);

      let error;
      try {
        await service.editWorkflowPrompts(project.id, [source.id], editOptions).catch((err) => { error = err; });
      } finally {
        restoreFs();
      }

      expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'resolution' });
      // No filesystem rollback against the committed index: no create or unlink after commit.
      const committedAt = events.findLastIndex(dbCall('setEvidenceLifecycle', (event) => event.args[2] === 'dispensable'));
      expect(committedAt).toBeGreaterThanOrEqual(0);
      expect(filesystemMutations(events.slice(committedAt))).toEqual([]);
      expect(fs.readFileSync(target)).toEqual(edited);
      expect(assetRepository.findById(source.id).source_generation).toBe(source.source_generation + 1);

      const [group] = groups();
      expect(group).toMatchObject({ itemKey: `asset:${source.id}`, checkpoint: 'replace' });
      const stageAbs = stageArtifact(workspacePath(), '0.png');
      const backupAbs = stageArtifact(workspacePath(), '0.original');
      expect(fs.existsSync(stageAbs)).toBe(true);
      expect(fs.existsSync(backupAbs)).toBe(true);
      const rows = rowsByRole();
      expect(rows['stage-output']).toMatchObject({ lifecycle: 'dispensable', retentionReason: 'committed' });
      expect(rows['original-backup']).toMatchObject({ lifecycle: 'dispensable', retentionReason: 'committed' });
      expect(rows['published-output']).toMatchObject({ lifecycle: 'intent', identity: exactIdentityOf(target) });
    });

    it('keeps a committed Prompt stage that cannot be removed as dispensable cleanup residue', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      const source = writeIndexedPromptPng('Final/evidence-residue.png', 'parameters', 'original');
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (isPromptStagePath(String(filePath))) throw Object.assign(new Error('injected stage unlink failure'), { code: 'EIO' });
        return realUnlink(filePath, ...args);
      });
      const { service } = evidenceHarness({ applicationLogger });

      let result;
      try {
        result = await service.editWorkflowPrompts(project.id, [source.id], editOptions);
      } finally {
        unlinkSpy.mockRestore();
      }

      expect(result).toMatchObject({ status: 'completed', changedCount: 1 });
      const stageAbs = stageArtifact(workspacePath(), '0.png');
      expect(fs.existsSync(stageAbs)).toBe(true);
      const [group, ...otherGroups] = groups();
      expect(otherGroups).toEqual([]);
      expect(group).toMatchObject({ itemKey: `asset:${source.id}`, checkpoint: null });
      expect(evidenceRows()).toEqual([expect.objectContaining({
        mutationGroupId: group.groupId,
        assetId: source.id,
        artifactRole: 'stage-output',
        artifactPath: relativeTo(stageAbs),
        lifecycle: 'dispensable',
        retentionReason: 'cleanup-residue',
        observation: 'present',
        identity: exactIdentityOf(stageAbs),
      })]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledTimes(1);
      expect(applicationLogger.warn.mock.calls[0][0]).toMatchObject({
        event: 'processing.cleanup.residue',
        context: expect.objectContaining({ cleanupSucceeded: false, retainedRecoveryCriticalCount: 0 }),
      });
    });

    it.each([
      ['missing', 'absent'],
      ['replaced', 'present'],
      ['unavailable', 'inspection-failed'],
      ['present', 'present'],
    ])('mirrors %s from the existing safe Prompt cleanup-residue diagnostic', async (observation, pathState) => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      const source = writeIndexedPromptPng(`Final/evidence-cleanup-${observation}.png`, 'parameters', 'original');
      const target = path.resolve(projectDir, ...source.relative_path.split('/'));
      const edited = editWorkflowPromptsInPng(fs.readFileSync(target), editOptions).buffer;
      const realUnlink = fs.unlinkSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      const { service, events } = evidenceHarness({ applicationLogger });
      let originalRow;
      let residuePath;
      let cleanupStarted = false;
      const diagnosticChecks = [];
      const extraChecks = [];
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (isPromptStagePath(String(filePath))) {
          originalRow = rowsByRole()['stage-output'];
          residuePath = path.resolve(String(filePath));
          if (observation === 'missing') realUnlink(filePath, ...args);
          if (observation === 'replaced') replaceWithForeignFile(residuePath, Buffer.from('foreign private residue'));
          cleanupStarted = true;
          throw Object.assign(new Error('injected stage unlink failure'), { code: 'EIO' });
        }
        return realUnlink(filePath, ...args);
      });
      const statSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (cleanupStarted && path.resolve(String(filePath)) === residuePath) {
          diagnosticChecks.push(args);
          events.push({ type: 'cleanup-observation', path: residuePath });
          if (observation === 'unavailable') {
            throw Object.assign(new Error('injected unavailable residue'), { code: 'EACCES' });
          }
        }
        return realLstat(filePath, ...args);
      });
      const extraSpies = ['statSync', 'readFileSync', 'openSync'].map((name) => {
        const real = fs[name].bind(fs);
        return vi.spyOn(fs, name).mockImplementation((filePath, ...args) => {
          if (cleanupStarted && path.resolve(String(filePath)) === residuePath) extraChecks.push(name);
          return real(filePath, ...args);
        });
      });

      let result;
      try {
        result = await service.editWorkflowPrompts(project.id, [source.id], editOptions);
      } finally {
        extraSpies.reverse().forEach((spy) => spy.mockRestore());
        statSpy.mockRestore();
        unlinkSpy.mockRestore();
      }

      expect(result).toMatchObject({ status: 'completed', changedCount: 1 });
      expect(fs.readFileSync(target)).toEqual(edited);
      expect(assetRepository.findById(source.id).source_generation).toBe(source.source_generation + 1);
      expect(groups()).toEqual([expect.objectContaining({ checkpoint: null })]);
      expect(evidenceRows()).toEqual([expect.objectContaining({
        evidenceId: originalRow.evidenceId,
        mutationGroupId: originalRow.mutationGroupId,
        assetId: originalRow.assetId,
        artifactRole: originalRow.artifactRole,
        artifactPath: originalRow.artifactPath,
        identity: originalRow.identity,
        expectedSize: originalRow.expectedSize,
        expectedSha256: originalRow.expectedSha256,
        lifecycle: 'dispensable', retentionReason: 'cleanup-residue', observation,
      })]);
      // Only the existing diagnostic inspects this path after the failed unlink.
      expect(diagnosticChecks).toEqual([[{ bigint: true }]]);
      expect(extraChecks).toEqual([]);
      const diagnosticAt = at(events, (event) => event.type === 'cleanup-observation');
      const settlementAt = at(events, dbCall('setEvidenceRetentionReason', (event) => event.args[2] === 'cleanup-residue'));
      expect(diagnosticAt).toBeLessThan(settlementAt);
      const observationsAfterDiagnostic = events.slice(diagnosticAt).filter(dbCall('setEvidenceObservation'));
      expect(observationsAfterDiagnostic.map((event) => event.args[2])).toEqual([observation]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledTimes(1);
      const [entry] = applicationLogger.warn.mock.calls[0];
      expect(entry).toMatchObject({ event: 'processing.cleanup.residue' });
      expect(entry.context).toMatchObject({ cleanupSucceeded: false, retainedRecoveryCriticalCount: 0 });
      expect(entry.context.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'stage-output', pathState, cleanup: 'residue',
        ...(observation === 'replaced' ? { identity: 'mismatched' } : {}),
        ...(observation === 'present' ? { identity: 'matched' } : {}),
      }));
      if (observation === 'missing') expect(fs.existsSync(residuePath)).toBe(false);
      else if (observation === 'replaced') {
        expect(exactIdentityOf(residuePath)).not.toEqual(originalRow.identity);
        expect(fs.readFileSync(residuePath)).toEqual(Buffer.from('foreign private residue'));
      } else expect(fs.readFileSync(residuePath)).toEqual(edited);
    });

    it.each([false, true])(
      'requires the diagnostic-derived safe Prompt residue observation before ordinary downgrade (write failure: %s)',
      async (failObservation) => {
        const source = writeIndexedPromptPng(`Final/evidence-cleanup-write-${failObservation}.png`, 'parameters', 'original');
        const target = path.resolve(projectDir, ...source.relative_path.split('/'));
        const before = fs.readFileSync(target);
        const edited = editWorkflowPromptsInPng(before, editOptions).buffer;
        const realOpen = fs.openSync.bind(fs);
        const realUnlink = fs.unlinkSync.bind(fs);
        const realLstat = fs.lstatSync.bind(fs);
        let residuePath;
        let originalRow;
        let cleanupStarted = false;
        const { service, events } = evidenceHarness({
          fail: { setEvidenceObservation: (args) => failObservation && args[2] === 'unavailable' },
        });
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          if (typeof flags === 'string' && flags.startsWith('wx')) {
            events.push({ type: 'create', path: path.resolve(String(filePath)) });
          }
          if (typeof flags === 'string' && flags.startsWith('wx') && isPromptBackupPath(String(filePath))) {
            throw Object.assign(new Error('injected backup create failure'), { code: 'EIO' });
          }
          return realOpen(filePath, flags, ...args);
        });
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          events.push({ type: 'unlink', path: path.resolve(String(filePath)) });
          if (isPromptStagePath(String(filePath))) {
            originalRow = rowsByRole()['stage-output'];
            residuePath = path.resolve(String(filePath));
            cleanupStarted = true;
            throw Object.assign(new Error('injected stage unlink failure'), { code: 'EIO' });
          }
          return realUnlink(filePath, ...args);
        });
        const statSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
          if (cleanupStarted && path.resolve(String(filePath)) === residuePath) {
            throw Object.assign(new Error('injected unavailable residue'), { code: 'EACCES' });
          }
          return realLstat(filePath, ...args);
        });
        const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');

        let error;
        let applyCallCount;
        try {
          await service.editWorkflowPrompts(project.id, [source.id], editOptions).catch((err) => { error = err; });
        } finally {
          applyCallCount = applySpy.mock.calls.length;
          applySpy.mockRestore();
          statSpy.mockRestore();
          unlinkSpy.mockRestore();
          openSpy.mockRestore();
        }

        expect(error).toMatchObject(failObservation
          ? { code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', evidenceStage: 'observation' }
          : { code: 'FILESYSTEM_OPERATION_FAILED' });
        expect(error.recoveryDiagnostics).toMatchObject({
          restored: true, cleanupSucceeded: false, retainedRecoveryCriticalCount: 0,
        });
        expect(error.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          artifactRole: 'stage-output', pathState: 'inspection-failed', cleanup: 'residue',
        }));
        expect(applyCallCount).toBe(0);
        expect(events.filter((event) => event.path === target)).toEqual([]);
        expect(fs.readFileSync(target)).toEqual(before);
        expectAssetUnchanged(source);
        expect(fs.readFileSync(residuePath)).toEqual(edited);
        expect(rowsByRole()['stage-output']).toMatchObject({
          evidenceId: originalRow.evidenceId, mutationGroupId: originalRow.mutationGroupId,
          assetId: originalRow.assetId, artifactRole: originalRow.artifactRole, artifactPath: originalRow.artifactPath,
          identity: originalRow.identity, expectedSize: originalRow.expectedSize, expectedSha256: originalRow.expectedSha256,
          lifecycle: 'dispensable', retentionReason: 'cleanup-residue',
          observation: failObservation ? 'present' : 'unavailable',
        });
        expect(evidenceRows()).toHaveLength(failObservation ? 2 : 1);
        expect(groups()).toEqual([expect.objectContaining({ checkpoint: null })]);
        if (failObservation) {
          expect(rowsByRole()['original-backup']).toMatchObject({
            identity: null, lifecycle: 'dispensable', retentionReason: 'rolled-back',
          });
          const failureAt = at(events, (event) => event.type === 'db-failed' && event.name === 'setEvidenceObservation');
          const afterFailure = events.slice(failureAt + 1);
          expect(afterFailure.some(dbCall('deleteEvidence'))).toBe(false);
          expect(afterFailure.some(dbCall('clearMutationCheckpoint'))).toBe(false);
          expect(afterFailure.some(dbCall('deleteMutationGroup', (event) => event.result === true))).toBe(false);
          expect(filesystemMutations(afterFailure)).toEqual([]);
        }
      },
    );

    // The cleanupPromptStaging reporting defect: an unowned private file was left in place
    // while cleanup reported complete. Project state is untouched (safe), so this stays an
    // ordinary failure, but the residue is reported and keeps its dispensable evidence.
    it('reports an unowned Prompt backup left after a safe rollback as incomplete cleanup', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      const source = writeIndexedPromptPng('Final/evidence-unowned.png', 'parameters', 'original');
      const target = path.resolve(projectDir, 'Final', 'evidence-unowned.png');
      const before = fs.readFileSync(target);
      const restoreStats = mockStatOverrides((filePath) => (isPromptBackupPath(filePath) ? { ino: 0 } : null));
      const { service } = evidenceHarness({ applicationLogger });

      try {
        await expect(service.editWorkflowPrompts(project.id, [source.id], editOptions))
          .rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      } finally {
        restoreStats();
      }

      expect(fs.readFileSync(target)).toEqual(before);
      expectAssetUnchanged(source);
      const backupAbs = stageArtifact(workspacePath(), '0.original');
      expect(fs.existsSync(backupAbs)).toBe(true); // never claimed, never removed
      expect(fs.existsSync(stageArtifact(workspacePath(), '0.png'))).toBe(false);
      const [group, ...otherGroups] = groups();
      expect(otherGroups).toEqual([]);
      expect(group.checkpoint).toBeNull();
      expect(evidenceRows()).toEqual([expect.objectContaining({
        mutationGroupId: group.groupId,
        artifactRole: 'original-backup',
        artifactPath: relativeTo(backupAbs),
        identity: null,
        lifecycle: 'dispensable',
        retentionReason: 'cleanup-residue',
        observation: 'ownership-unknown',
      })]);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      const [entry] = applicationLogger.warn.mock.calls[0];
      expect(entry).toMatchObject({ event: 'processing.recovery.succeeded' });
      expect(entry.context).toMatchObject({ restored: true, cleanupSucceeded: false, retainedRecoveryCriticalCount: 0 });
      expect(entry.context.failures).toContainEqual(expect.objectContaining({
        assetId: source.id, artifactRole: 'original-backup', check: 'cleanup-ownership-unproven', cleanup: 'residue',
      }));
    });

    // Cross-item content continuity: every published output is validated as one batch before
    // the index transaction, and every restored source as one batch before its backup may be
    // given up. A same-identity, same-size in-place rewrite of an earlier item while a later
    // item is published, restored or read must be caught.
    describe('final batch validation', () => {
      function promptSources(name, count = 2) {
        const sources = ['a', 'b'].slice(0, count).map((suffix) => writeIndexedPromptPng(
          `Final/${name}-${suffix}.png`, 'parameters', `original-${suffix}`,
        ));
        const targets = sources.map((source) => path.resolve(projectDir, ...source.relative_path.split('/')));
        const before = targets.map((target) => fs.readFileSync(target));
        const edited = before.map((bytes) => editWorkflowPromptsInPng(bytes, editOptions).buffer);
        return { sources, ids: sources.map(({ id }) => id), targets, before, edited };
      }

      // An external in-place rewrite of `current`: same identity and size, different bytes, and
      // write metadata moved far enough for the continuity protocol to observe it. Reads nothing.
      let rewrites = 0;
      function rewriteSameSize(target, current) {
        const bytes = Buffer.from(current);
        bytes[bytes.length - 1] ^= 0xff;
        rewriteInPlace(target, bytes);
        rewrites += 1;
        const moved = new Date(Date.UTC(2001, 0, 1, 0, 0, rewrites));
        fs.utimesSync(target, moved, moved);
        return bytes;
      }

      function failingApply(onFail = () => {}) {
        return vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
          onFail();
          throw new Error('injected database failure');
        });
      }

      const backupOf = (index) => stageArtifact(workspacePath(), `${index}.original`);

      // The retained item keeps its last-good backup, stage, recovery-critical rows, checkpoint and
      // group; nothing else of the run remains.
      function expectOnlyItemRetained(source, original) {
        expect(groups()).toEqual([expect.objectContaining({
          itemKey: `asset:${source.id}`, checkpoint: 'replace',
        })]);
        const byRole = rowsByRole();
        expect(Object.keys(byRole).sort()).toEqual(['original-backup', 'stage-output']);
        expect(byRole['original-backup']).toMatchObject({
          assetId: source.id,
          lifecycle: 'recovery-critical',
          retentionReason: 'restoration-failed',
          expectedSha256: sha256(original),
          observation: 'present',
        });
        expect(byRole['stage-output']).toMatchObject({
          assetId: source.id, lifecycle: 'recovery-critical', retentionReason: 'restoration-failed',
        });
        expect(fs.readFileSync(byRole['original-backup'].artifactPath
          .split('/').reduce((dir, part) => path.join(dir, part), projectDir))).toEqual(original);
      }

      // Reviewer forward reproduction: A is rewritten in place while B is being published.
      it('never commits a published output rewritten in place while a later output is published', async () => {
        const { sources, ids, targets, before, edited } = promptSources('final-publish');
        let changed = null;
        const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (!changed && filePath === targets[1] && isExclusiveOpen(flags)) {
              changed = rewriteSameSize(targets[0], edited[0]);
            }
          },
        });
        const { service } = evidenceHarness();
        let failure;
        let applyCallCount;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions).then(() => null, (err) => err);
        } finally {
          unhook();
          applyCallCount = applySpy.mock.calls.length;
          applySpy.mockRestore();
        }

        expect(changed).not.toBeNull();
        expect(applyCallCount).toBe(0);
        expect(failure).toMatchObject({ code: 'SOURCE_CHANGED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'published-output', check: 'precommit-content-mismatch', identity: 'matched',
        }));
        // Verified rollback: originals restored, nothing recorded, no evidence retained.
        targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
        sources.forEach(expectAssetUnchanged);
        expectNoEvidence();
        expect(promptWorkspaces()).toEqual([]);
      });

      // Stronger window: A passes its own content proof, then is rewritten while B is read; only the
      // final metadata sweep, after every content read, can see it.
      it('catches an output rewritten in place while a later output is validated (final sweep)', async () => {
        const { sources, ids, targets, before, edited } = promptSources('final-sweep');
        let published = false;
        let changed = null;
        const reads = [];
        const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (filePath === targets[1] && isExclusiveOpen(flags)) published = true;
            if (!published || changed || !isReadOpen(flags) || !targets.includes(filePath)) return;
            reads.push({ index: targets.indexOf(filePath), inTransaction: db.inTransaction });
            if (filePath === targets[1]) changed = rewriteSameSize(targets[0], edited[0]);
          },
        });
        const { service } = evidenceHarness();
        let failure;
        let applyCallCount;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions).then(() => null, (err) => err);
        } finally {
          unhook();
          applyCallCount = applySpy.mock.calls.length;
          applySpy.mockRestore();
        }

        // A's own content proof passed before B was read; no SQLite transaction was open.
        expect(reads).toEqual([{ index: 0, inTransaction: false }, { index: 1, inTransaction: false }]);
        expect(applyCallCount).toBe(0);
        expect(failure).toMatchObject({ code: 'SOURCE_CHANGED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'published-output', check: 'precommit-final-content-mismatch', identity: 'matched',
        }));
        targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
        sources.forEach(expectAssetUnchanged);
        expectNoEvidence();
        expect(promptWorkspaces()).toEqual([]);
      });

      it('never commits or adopts an output replaced by another file after its content proof', async () => {
        const { sources, ids, targets, before, edited } = promptSources('final-replaced');
        let published = false;
        let replaced = false;
        let readsAfterReplacement = 0;
        const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (filePath === targets[1] && isExclusiveOpen(flags)) published = true;
            if (replaced && filePath === targets[0] && isReadOpen(flags)) readsAfterReplacement += 1;
            if (published && !replaced && filePath === targets[1] && isReadOpen(flags)) {
              replaced = true;
              // Same edited bytes under a foreign identity: only identity can reveal it.
              replaceWithForeignFile(targets[0], edited[0]);
            }
          },
        });
        const { service } = evidenceHarness();
        let failure;
        let applyCallCount;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions).then(() => null, (err) => err);
        } finally {
          unhook();
          applyCallCount = applySpy.mock.calls.length;
          applySpy.mockRestore();
        }

        expect(replaced).toBe(true);
        expect(applyCallCount).toBe(0);
        // The foreign object is never hashed, adopted or removed.
        expect(readsAfterReplacement).toBe(0);
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'published-output', check: 'precommit-final-identity-mismatch',
        }));
        expect(fs.readFileSync(targets[0])).toEqual(edited[0]);
        expect(fs.readFileSync(targets[1])).toEqual(before[1]);
        sources.forEach(expectAssetUnchanged);
        expect(fs.readFileSync(backupOf(0))).toEqual(before[0]);
        expect(groups()).toEqual([expect.objectContaining({ itemKey: `asset:${sources[0].id}`, checkpoint: 'replace' })]);
      });

      it('commits a multi-item Prompt edit only after the final sweep, outside any transaction', async () => {
        const { sources, ids, targets, edited } = promptSources('final-clean');
        const events = [];
        let published = false;
        const realLstat = fs.lstatSync.bind(fs);
        const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
          const resolved = path.resolve(String(filePath));
          if (published && args[0]?.bigint && targets.includes(resolved)) {
            events.push({ type: 'lstat', index: targets.indexOf(resolved) });
          }
          return realLstat(filePath, ...args);
        });
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (filePath === targets[1] && isExclusiveOpen(flags)) published = true;
            if (published && isReadOpen(flags) && targets.includes(filePath)) {
              events.push({ type: 'read', index: targets.indexOf(filePath), inTransaction: db.inTransaction });
            }
          },
        });
        const realApply = assetRepository.applyAssetPromptEdits;
        const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation((...args) => {
          events.push({ type: 'apply', inTransaction: db.inTransaction });
          return realApply.apply(assetRepository, args);
        });
        const { service } = evidenceHarness();
        let result;
        try {
          result = await service.editWorkflowPrompts(project.id, ids, editOptions);
        } finally {
          unhook();
          applySpy.mockRestore();
          lstatSpy.mockRestore();
        }

        expect(result).toMatchObject({ status: 'completed', changedCount: 2, changedAssetIds: ids });
        targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(edited[index]));
        const applyAt = events.findIndex((event) => event.type === 'apply');
        const lastReadAt = events.findLastIndex((event) => event.type === 'read');
        expect(events.filter((event) => event.type === 'read').map(({ index, inTransaction }) => [index, inTransaction]))
          .toEqual([[0, false], [1, false]]);
        expect(events[applyAt]).toEqual({ type: 'apply', inTransaction: true });
        // Final sweep: metadata-only lstats of every output between the last content read and
        // the transaction.
        const sweep = events.slice(lastReadAt + 1, applyAt);
        expect(sweep.every((event) => event.type === 'lstat')).toBe(true);
        expect(new Set(sweep.map((event) => event.index))).toEqual(new Set([0, 1]));
        sources.forEach((source, index) => expect(assetRepository.findById(source.id)).toMatchObject({
          size_bytes: edited[index].length,
          modified_at: fs.statSync(targets[index]).mtime.toISOString(),
          source_generation: source.source_generation + 1,
        }));
        expectNoEvidence();
        expect(promptWorkspaces()).toEqual([]);
      });

      it('commits a Prompt output whose SMB write times settle during its pre-commit hash', async () => {
        const { sources, ids, targets, edited } = promptSources('final-smb', 1);
        const smb = modelSmbTimeSettling((filePath) => filePath === targets[0]);
        const { service } = evidenceHarness();
        let result;
        try {
          result = await service.editWorkflowPrompts(project.id, ids, editOptions);
        } finally {
          smb.restore();
        }

        expect(result).toMatchObject({ status: 'completed', changedCount: 1 });
        expect(smb.refreshed).toBe(true);
        const settled = smb.observed.at(-1);
        expect(smb.observed).toContain(settled + smb.postCloseStepNs);
        expect(smb.observed.lastIndexOf(settled + smb.postCloseStepNs)).toBeLessThan(smb.observed.indexOf(settled));
        expect(fs.readFileSync(targets[0])).toEqual(edited[0]);
        expect(assetRepository.findById(sources[0].id)).toMatchObject({
          size_bytes: edited[0].length,
          modified_at: fs.statSync(targets[0]).mtime.toISOString(),
        });
        expectNoEvidence();
        expect(promptWorkspaces()).toEqual([]);
      });

      it('never commits a Prompt output rewritten after its first pre-commit hash', async () => {
        const { sources, ids, targets, before, edited } = promptSources('final-stale', 1);
        let published = false;
        let restoring = false;
        let changed = null;
        let validationReads = 0;
        const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (filePath !== targets[0]) return;
            if (isExclusiveOpen(flags)) {
              restoring = published;
              published = true;
            } else if (published && !restoring && isReadOpen(flags)) {
              validationReads += 1;
            }
          },
          onClose(filePath, flags) {
            if (published && !restoring && !changed && filePath === targets[0] && isReadOpen(flags)) {
              changed = rewriteSameSize(targets[0], edited[0]);
            }
          },
        });
        const { service } = evidenceHarness();
        let failure;
        let applyCallCount;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions).then(() => null, (err) => err);
        } finally {
          unhook();
          applyCallCount = applySpy.mock.calls.length;
          applySpy.mockRestore();
        }

        // The first hash matched; the moved metadata forced the re-hash that saw the new bytes.
        expect(validationReads).toBe(2);
        expect(applyCallCount).toBe(0);
        expect(failure).toMatchObject({ code: 'SOURCE_CHANGED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'published-output', check: 'precommit-content-mismatch',
        }));
        expect(fs.readFileSync(targets[0])).toEqual(before[0]);
        expectAssetUnchanged(sources[0]);
        expectNoEvidence();
      });

      // Reviewer rollback reproduction. Rollback restores in reverse order, so item 1 ("A") is
      // restored first and is rewritten in place while item 0 ("B") is being restored.
      it('retains the last-good backup when a restored source is rewritten while a sibling is restored', async () => {
        const { sources, ids, targets, before } = promptSources('final-restore');
        let rollingBack = false;
        let firstRestored = false;
        let changed = null;
        const unlinked = [];
        const realUnlink = fs.unlinkSync.bind(fs);
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          unlinked.push(path.resolve(String(filePath)));
          return realUnlink(filePath, ...args);
        });
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (!rollingBack || changed || !isExclusiveOpen(flags)) return;
            if (filePath === targets[1]) firstRestored = true;
            else if (filePath === targets[0] && firstRestored) changed = rewriteSameSize(targets[1], before[1]);
          },
        });
        const applySpy = failingApply(() => { rollingBack = true; });
        const { service } = evidenceHarness();
        let failure;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions, jobProgress('job-final-restore'))
            .then(() => null, (err) => err);
        } finally {
          unhook();
          applySpy.mockRestore();
          unlinkSpy.mockRestore();
        }

        expect(changed).not.toBeNull();
        // Never a falsely successful ordinary DATABASE_OPERATION_FAILED.
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failure.recoveryDiagnostics).toMatchObject({ phase: 'database', restored: false });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          assetId: sources[1].id, itemIndex: 1, artifactRole: 'restored-source',
          check: 'restored-source-content-mismatch', identity: 'matched',
        }));
        // The changed source is left exactly as found; the sibling is restored.
        expect(fs.readFileSync(targets[1])).toEqual(changed);
        expect(fs.readFileSync(targets[0])).toEqual(before[0]);
        sources.forEach(expectAssetUnchanged);
        // A's last-good original is untouched and was never offered to cleanup.
        expect(fs.readFileSync(backupOf(1))).toEqual(before[1]);
        expect(unlinked).not.toContain(backupOf(1));
        expectOnlyItemRetained(sources[1], before[1]);
        // The verified sibling settled on its own: its copies are gone.
        expect(stageNames(workspacePath())).toEqual(['1.original', '1.png']);
      });

      // A is validated, then rewritten while B is read during the same restored-source pass. The
      // backups, rows and checkpoints are still all recovery-critical while the proof runs.
      it('catches a restored source rewritten while a later restored source is validated', async () => {
        const { sources, ids, targets, before } = promptSources('final-restore-sweep');
        let rollingBack = false;
        let restores = 0;
        let changed = null;
        let duringValidation;
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (!rollingBack || changed || !targets.includes(filePath)) return;
            if (isExclusiveOpen(flags)) {
              restores += 1;
              return;
            }
            if (restores < 2 || !isReadOpen(flags)) return;
            if (filePath === targets[0]) {
              duringValidation ??= {
                groups: groups(),
                rows: evidenceRows(),
                backups: [0, 1].map((index) => fs.readFileSync(backupOf(index))),
              };
            } else {
              changed = rewriteSameSize(targets[0], before[0]);
            }
          },
        });
        const applySpy = failingApply(() => { rollingBack = true; });
        const { service } = evidenceHarness();
        let failure;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions).then(() => null, (err) => err);
        } finally {
          unhook();
          applySpy.mockRestore();
        }

        expect(changed).not.toBeNull();
        // Nothing was made dispensable, resolved or cleaned before the final proof.
        expect(duringValidation.groups).toHaveLength(2);
        expect(duringValidation.groups.every((group) => group.checkpoint === 'replace')).toBe(true);
        expect(duringValidation.rows).toHaveLength(6);
        expect(duringValidation.rows.every((row) => row.lifecycle === 'recovery-critical')).toBe(true);
        expect(duringValidation.backups).toEqual(before);
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'restored-source', check: 'restored-source-final-content-mismatch',
          identity: 'matched',
        }));
        expect(fs.readFileSync(targets[0])).toEqual(changed);
        expect(fs.readFileSync(targets[1])).toEqual(before[1]);
        expectOnlyItemRetained(sources[0], before[0]);
      });

      it('retains the backup of a restored source replaced by another file after its proof', async () => {
        const { sources, ids, targets, before } = promptSources('final-restore-replaced');
        let rollingBack = false;
        let restores = 0;
        let replaced = false;
        let readsAfterReplacement = 0;
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (!rollingBack || !targets.includes(filePath)) return;
            if (replaced) {
              if (filePath === targets[0] && isReadOpen(flags)) readsAfterReplacement += 1;
              return;
            }
            if (isExclusiveOpen(flags)) restores += 1;
            else if (restores === 2 && filePath === targets[1] && isReadOpen(flags)) {
              replaced = true;
              // The original bytes under a foreign identity: only identity can reveal it.
              replaceWithForeignFile(targets[0], before[0]);
            }
          },
        });
        const applySpy = failingApply(() => { rollingBack = true; });
        const { service } = evidenceHarness();
        let failure;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions).then(() => null, (err) => err);
        } finally {
          unhook();
          applySpy.mockRestore();
        }

        expect(replaced).toBe(true);
        expect(readsAfterReplacement).toBe(0);
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'restored-source', check: 'restored-source-final-identity-mismatch',
        }));
        // The foreign file is left in place, never adopted or removed.
        expect(fs.readFileSync(targets[0])).toEqual(before[0]);
        expectOnlyItemRetained(sources[0], before[0]);
      });

      it('retains the backup when a restored source changes after its first validation hash', async () => {
        const { sources, ids, targets, before } = promptSources('final-restore-stale', 1);
        let restored = false;
        let changed = null;
        let validationReads = 0;
        let rollingBack = false;
        const unhook = hookFileDescriptors({
          onOpen(filePath, flags) {
            if (!rollingBack || filePath !== targets[0]) return;
            if (isExclusiveOpen(flags)) restored = true;
            else if (restored && isReadOpen(flags)) validationReads += 1;
          },
          onClose(filePath, flags) {
            if (restored && !changed && filePath === targets[0] && isReadOpen(flags)) {
              changed = rewriteSameSize(targets[0], before[0]);
            }
          },
        });
        const applySpy = failingApply(() => { rollingBack = true; });
        const { service } = evidenceHarness();
        let failure;
        try {
          failure = await service.editWorkflowPrompts(project.id, ids, editOptions).then(() => null, (err) => err);
        } finally {
          unhook();
          applySpy.mockRestore();
        }

        expect(validationReads).toBe(2);
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'restored-source', check: 'restored-source-content-mismatch',
        }));
        expect(fs.readFileSync(targets[0])).toEqual(changed);
        expectAssetUnchanged(sources[0]);
        expectOnlyItemRetained(sources[0], before[0]);
      });

      it('settles a verified multi-item database rollback as an ordinary failure', async () => {
        const { sources, ids, targets, before } = promptSources('final-restore-clean');
        const applySpy = failingApply();
        const { service } = evidenceHarness();
        try {
          await expect(service.editWorkflowPrompts(project.id, ids, editOptions))
            .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        } finally {
          applySpy.mockRestore();
        }

        targets.forEach((target, index) => expect(fs.readFileSync(target)).toEqual(before[index]));
        sources.forEach(expectAssetUnchanged);
        expectNoEvidence();
        expect(promptWorkspaces()).toEqual([]);
      });

      it('settles a restored source whose SMB write times settle during its final validation', async () => {
        const { sources, ids, targets, before } = promptSources('final-restore-smb', 1);
        let smb;
        const applySpy = failingApply(() => {
          // Modelled from the restore's own exclusive create onwards.
          smb = modelSmbTimeSettling((filePath) => filePath === targets[0]);
        });
        const { service } = evidenceHarness();
        try {
          await expect(service.editWorkflowPrompts(project.id, ids, editOptions))
            .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        } finally {
          smb?.restore();
          applySpy.mockRestore();
        }

        expect(smb.refreshed).toBe(true);
        const settled = smb.observed.at(-1);
        expect(smb.observed).toContain(settled + smb.postCloseStepNs);
        expect(smb.observed.lastIndexOf(settled + smb.postCloseStepNs)).toBeLessThan(smb.observed.indexOf(settled));
        expect(fs.readFileSync(targets[0])).toEqual(before[0]);
        expectAssetUnchanged(sources[0]);
        expectNoEvidence();
        expect(promptWorkspaces()).toEqual([]);
      });
    });
  });

  describe('consecutive Workflow Prompt runs', () => {
    const promptWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-workflow-prompts-');
    const runA = { positive: { rules: [{ type: 'append', text: ' alpha' }] } };
    const runB = { positive: { rules: [{ type: 'append', text: ' beta' }] } };
    const assetState = (asset) => {
      const row = assetRepository.findById(asset.id);
      return {
        size_bytes: row.size_bytes,
        modified_at: row.modified_at,
        source_generation: row.source_generation,
        is_present: row.is_present,
      };
    };

    function writeConsecutiveFixture() {
      const assets = ['first', 'second'].map((name) => writeIndexedPromptPng(
        `Final/consecutive-${name}.png`,
        'parameters',
        `${name} prompt`,
      ));
      const targets = assets.map((asset) => path.join(projectDir, ...asset.relative_path.split('/')));
      return { assets, ids: assets.map(({ id }) => id), targets };
    }

    // Each run stages inside the retained workspace under its own operation token
    // (`<token>.<name>`). Records each run's stage namespace (workspace path + token) from its
    // exclusive stage creates, without changing behavior.
    const stageNamespace = (stagePath) => path.join(
      path.dirname(path.resolve(String(stagePath))),
      path.basename(String(stagePath)).split('.')[0],
    );
    const namespaceArtifacts = (namespace) => fs.readdirSync(path.dirname(namespace))
      .filter((name) => name.startsWith(`${path.basename(namespace)}.`));
    function recordPromptWorkspaces() {
      const created = [];
      const realOpen = fs.openSync.bind(fs);
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (flags === 'wx' && String(filePath).includes('.creatorcrate-workflow-prompts-')
          && !created.includes(stageNamespace(filePath))) {
          created.push(stageNamespace(filePath));
        }
        return realOpen(filePath, flags, ...args);
      });
      return { created, restore: () => spy.mockRestore() };
    }

    async function completeRunA(fixture) {
      const result = await processingService.editWorkflowPrompts(project.id, fixture.ids, runA);
      expect(result).toMatchObject({ status: 'completed', changedAssetIds: fixture.ids });
      expect(promptWorkspaces()).toEqual([]);
      return {
        bytes: fixture.targets.map((target) => fs.readFileSync(target)),
        rows: fixture.assets.map(assetState),
      };
    }

    function expectCommittedRunA(fixture, afterA) {
      fixture.targets.forEach((target, index) => {
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.readFileSync(target)).toEqual(afterA.bytes[index]);
        // The restored file must still match the index, so a rescan sees no drift.
        expect(fs.statSync(target).size).toBe(afterA.rows[index].size_bytes);
        expect(fs.statSync(target).mtime.toISOString()).toBe(afterA.rows[index].modified_at);
      });
      expect(fixture.assets.map(assetState)).toEqual(afterA.rows);
      expect(promptWorkspaces()).toEqual([]);
    }

    it('publishes run B from run A\'s published files with separate workspaces and generations', async () => {
      const fixture = writeConsecutiveFixture();
      const initialBytes = fixture.targets.map((target) => fs.readFileSync(target));
      const initialRows = fixture.assets.map(assetState);
      const workspaces = recordPromptWorkspaces();
      // Each backup is a new owned copy; its bytes are read once CreatorCrate closes it.
      const backups = [];
      const backupDescriptors = new Map();
      const realOpen = fs.openSync.getMockImplementation();
      const realClose = fs.closeSync.bind(fs);
      const openSpy = fs.openSync;
      openSpy.mockImplementation((filePath, flags, ...args) => {
        const descriptor = realOpen(filePath, flags, ...args);
        if (flags === 'wx+' && String(filePath).endsWith('.original')) backupDescriptors.set(descriptor, filePath);
        return descriptor;
      });
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        const result = realClose(descriptor, ...args);
        const backupPath = backupDescriptors.get(descriptor);
        backupDescriptors.delete(descriptor);
        if (backupPath) backups.push({ workspace: stageNamespace(backupPath), bytes: fs.readFileSync(backupPath) });
        return result;
      });
      const linkSpy = vi.spyOn(fs, 'linkSync');

      let afterA;
      try {
        afterA = await completeRunA(fixture);
        const resultB = await processingService.editWorkflowPrompts(project.id, fixture.ids, runB);
        expect(resultB).toMatchObject({ status: 'completed', changedAssetIds: fixture.ids });
      } finally {
        linkSpy.mockRestore();
        closeSpy.mockRestore();
        workspaces.restore();
      }

      expect(linkSpy).not.toHaveBeenCalled();
      fixture.targets.forEach((target, index) => {
        const expectedA = editWorkflowPromptsInPng(initialBytes[index], runA).buffer;
        const expectedB = editWorkflowPromptsInPng(afterA.bytes[index], runB).buffer;
        expect(afterA.bytes[index]).toEqual(expectedA);
        // B is cumulative over A, which a stale pre-A source could not produce.
        expect(expectedB).not.toEqual(editWorkflowPromptsInPng(initialBytes[index], runB).buffer);
        expect(fs.readFileSync(target)).toEqual(expectedB);
        expect(fs.readFileSync(target).includes(Buffer.from(' alpha beta'))).toBe(true);
      });

      const afterB = fixture.assets.map(assetState);
      fixture.targets.forEach((target, index) => {
        expect(initialRows[index].source_generation + 1).toBe(afterA.rows[index].source_generation);
        expect(afterA.rows[index].source_generation + 1).toBe(afterB[index].source_generation);
        expect(afterB[index]).toMatchObject({
          is_present: 1,
          size_bytes: fs.statSync(target).size,
          modified_at: fs.statSync(target).mtime.toISOString(),
        });
      });

      expect(workspaces.created).toHaveLength(2);
      expect(new Set(workspaces.created).size).toBe(2);
      const [workspaceA, workspaceB] = workspaces.created;
      // Each run backs up the state immediately before it, inside its own workspace.
      expect(backups.map(({ workspace }) => workspace))
        .toEqual([workspaceA, workspaceA, workspaceB, workspaceB]);
      expect(backups.map(({ bytes }) => bytes))
        .toEqual([...initialBytes, ...afterA.bytes]);
      // Neither run leaves a token artifact; only the fixed workspace directory remains.
      expect(namespaceArtifacts(workspaceA)).toEqual([]);
      expect(namespaceArtifacts(workspaceB)).toEqual([]);
      expect(promptWorkspaces()).toEqual([]);
    });

    it('restores run A\'s result when run B fails part-way through publication', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const fixture = writeConsecutiveFixture();
      const initialBytes = fixture.targets.map((target) => fs.readFileSync(target));
      const afterA = await completeRunA(fixture);
      const workspaces = recordPromptWorkspaces();
      const realOpen = fs.openSync.getMockImplementation();
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits');
      let publishedFirst = null;
      fs.openSync.mockImplementation((filePath, flags, ...args) => {
        if (publishedFirst === null && flags === 'wx+'
          && path.resolve(String(filePath)) === path.resolve(fixture.targets[1])) {
          // B has already published the first asset and removed the second source.
          publishedFirst = fs.readFileSync(fixture.targets[0]);
          throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
        }
        return realOpen(filePath, flags, ...args);
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, fixture.ids, runB))
          .rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      } finally {
        applySpy.mockRestore();
        workspaces.restore();
      }

      expect(publishedFirst).toEqual(editWorkflowPromptsInPng(afterA.bytes[0], runB).buffer);
      expect(applySpy).not.toHaveBeenCalled();
      expectCommittedRunA(fixture, afterA);
      fixture.targets.forEach((target, index) => {
        expect(fs.readFileSync(target)).not.toEqual(initialBytes[index]);
      });
      expect(workspaces.created).toHaveLength(1);
      expect(namespaceArtifacts(workspaces.created[0])).toEqual([]);
      expect(applicationLogger.error).not.toHaveBeenCalled();

      // A later service invocation starts from run A's committed state.
      await processingService.editWorkflowPrompts(project.id, fixture.ids, runB);
      fixture.targets.forEach((target, index) => {
        expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(afterA.bytes[index], runB).buffer);
      });
      expect(fixture.assets.map(assetState).map((row) => row.source_generation))
        .toEqual(afterA.rows.map((row) => row.source_generation + 1));
      expect(promptWorkspaces()).toEqual([]);
    });

    it('restores run A\'s result when run B fails to update the index after publication', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const fixture = writeConsecutiveFixture();
      const afterA = await completeRunA(fixture);
      let publishedB = null;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits').mockImplementation(() => {
        publishedB = fixture.targets.map((target) => fs.readFileSync(target));
        throw new Error('injected database failure');
      });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, fixture.ids, runB))
          .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      } finally {
        applySpy.mockRestore();
      }

      expect(publishedB).toEqual(afterA.bytes.map((bytes) => editWorkflowPromptsInPng(bytes, runB).buffer));
      expectCommittedRunA(fixture, afterA);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.succeeded',
      }));
    });

    // Rollback of B restored A's committed state; only a dispensable stage could not be
    // removed afterwards. That residue never turns the index failure into RECOVERY_REQUIRED.
    it('reports a verified rollback of run B as a plain failure when a stage cannot be removed', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createProcessingService({ applicationLogger });
      const fixture = writeConsecutiveFixture();
      const afterA = await completeRunA(fixture);
      const realUnlink = fs.unlinkSync.bind(fs);
      let failed = false;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        const name = String(filePath);
        if (!failed && name.includes('.creatorcrate-workflow-prompts-') && name.endsWith('.png')) {
          failed = true;
          throw Object.assign(new Error('injected stage cleanup failure'), { code: 'EIO' });
        }
        return realUnlink(filePath, ...args);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetPromptEdits')
        .mockImplementation(() => { throw new Error('injected database failure'); });

      try {
        await expect(processingService.editWorkflowPrompts(project.id, fixture.ids, runB))
          .rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      } finally {
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
      }

      expect(failed).toBe(true);
      fixture.targets.forEach((target, index) => {
        expect(fs.readFileSync(target)).toEqual(afterA.bytes[index]);
        expect(fs.statSync(target).mtime.toISOString()).toBe(afterA.rows[index].modified_at);
      });
      expect(fixture.assets.map(assetState)).toEqual(afterA.rows);
      expect(promptWorkspaces()).toHaveLength(1);
      expect(applicationLogger.error).not.toHaveBeenCalled();
      expect(applicationLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'processing.recovery.succeeded',
        context: expect.objectContaining({
          recoveryPhase: 'database',
          restored: true,
          cleanupSucceeded: false,
          retainedRecoveryCriticalCount: 0,
          failures: [expect.objectContaining({
            artifactRole: 'stage-output', check: 'cleanup-unlink-failed', cleanup: 'residue',
          })],
        }),
      }));
    });

    it('leaves an earlier run\'s retained recovery workspace untouched', async () => {
      const fixture = writeConsecutiveFixture();
      const afterA = await completeRunA(fixture);
      // Recovery material retained from an earlier incident must not be adopted or removed.
      const retained = path.join(projectDir, '.creatorcrate-workflow-prompts-retained');
      fs.mkdirSync(retained);
      const retainedBackup = path.join(retained, '0.original');
      fs.writeFileSync(retainedBackup, afterA.bytes[0]);
      const retainedIdentity = fs.statSync(retainedBackup).ino;
      const workspaces = recordPromptWorkspaces();

      try {
        await processingService.editWorkflowPrompts(project.id, fixture.ids, runB);
      } finally {
        workspaces.restore();
      }

      expect(workspaces.created).toHaveLength(1);
      expect(path.dirname(workspaces.created[0])).not.toBe(path.resolve(retained));
      expect(fs.readFileSync(retainedBackup)).toEqual(afterA.bytes[0]);
      expect(fs.statSync(retainedBackup).ino).toBe(retainedIdentity);
      expect(promptWorkspaces()).toEqual(['.creatorcrate-workflow-prompts-retained']);
      fixture.targets.forEach((target, index) => {
        expect(fs.readFileSync(target)).toEqual(editWorkflowPromptsInPng(afterA.bytes[index], runB).buffer);
      });
    });
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

describe('recovery diagnostic summaries', () => {
  const failure = (artifactRole, check, extra = {}) => ({ assetId: 7, itemIndex: 1, artifactRole, check, ...extra });
  const kinds = (entries) => entries.map((entry) => `${entry.artifactRole}/${entry.check}`);

  it('keeps the only cleanup failure behind more distinct earlier failures than the cap', () => {
    const earlier = [
      failure('staged-original', 'staged-original-alias-proof', { proof: 'alias-identity-mismatch' }),
      failure('published-output', 'rollback-ownership-unproven', { proof: 'alias-identity-mismatch' }),
      failure('published-output', 'rollback-inspect'),
      failure('staged-original', 'restore-ownership-unproven'),
      failure('staged-original', 'restore-link'),
      failure('destination-backup', 'destination-restore-identity'),
      failure('destination-backup', 'destination-restore-verification'),
      failure('stage-output', 'retained-unresolved-publication', { cleanup: 'recovery-critical' }),
    ];
    const repeatedRollbacks = Array.from({ length: 20 }, (_, index) => (
      failure('published-output', 'rollback-unlink', { itemIndex: 10 + index, errorCode: 'EIO' })));
    const stagedOriginalCleanup = failure('staged-original', 'cleanup-unlink-failed', {
      itemIndex: 30, errorCode: 'EIO', cleanup: 'recovery-critical',
    });
    const entries = [...earlier, ...repeatedRollbacks, stagedOriginalCleanup];

    const summary = summarizeRecoveryDiagnostics('publication', entries, [], { cleanupSucceeded: false });

    expect(earlier.length).toBeGreaterThan(RECOVERY_DIAGNOSTIC_LIMIT);
    expect(summary.failures).toHaveLength(RECOVERY_DIAGNOSTIC_LIMIT);
    expect(summary.failures).toContain(stagedOriginalCleanup);
    // Deterministic: the cleanup failure, then role/check diversity in recorded order.
    expect(summary.failures).toEqual([...earlier.slice(0, RECOVERY_DIAGNOSTIC_LIMIT - 1), stagedOriginalCleanup]);
    expect(summarizeRecoveryDiagnostics('publication', entries.slice()).failures).toEqual(summary.failures);
    expect(summary).toMatchObject({ diagnosticCount: 29, failedCleanupCount: 1, strictProofFailureCount: 2 });
  });

  it('keeps a restoration failure and every failed cleanup role behind repeated cleanup failures', () => {
    const outputCleanups = Array.from({ length: 20 }, (_, index) => failure('stage-output', 'cleanup-unlink-failed', {
      itemIndex: index, errorCode: 'EIO', cleanup: 'recovery-critical',
    }));
    const rollback = failure('published-output', 'rollback-unlink', { itemIndex: 3, errorCode: 'EIO' });
    const originalCleanup = failure('staged-original', 'cleanup-inspection-failed', {
      itemIndex: 40, errorCode: 'EIO', cleanup: 'recovery-critical',
    });
    const backupCleanup = failure('destination-backup', 'cleanup-identity-mismatch', {
      itemIndex: 5, cleanup: 'recovery-critical',
    });
    const entries = [...outputCleanups, rollback, originalCleanup, backupCleanup];

    const { failures } = summarizeRecoveryDiagnostics('cleanup', entries, [], { cleanupSucceeded: false });

    expect(failures).toHaveLength(RECOVERY_DIAGNOSTIC_LIMIT);
    expect(failures).toEqual(expect.arrayContaining([outputCleanups[0], rollback, originalCleanup, backupCleanup]));
    expect(kinds(failures)).toEqual([
      'stage-output/cleanup-unlink-failed',
      'stage-output/cleanup-unlink-failed',
      'stage-output/cleanup-unlink-failed',
      'published-output/rollback-unlink',
      'staged-original/cleanup-inspection-failed',
      'destination-backup/cleanup-identity-mismatch',
    ]);
  });

  it('counts retained recovery-critical artifacts, not failure attempts', () => {
    const publicationAttempt = failure('stage-output', 'cleanup-unlink-failed', {
      publicationMode: 'strict', errorCode: 'EIO', cleanup: 'recovery-critical',
    });
    const rollbackAttempt = failure('stage-output', 'cleanup-inspection-failed', {
      errorCode: 'EIO', cleanup: 'recovery-critical',
    });
    const one = summarizeRecoveryDiagnostics('publication', [publicationAttempt, rollbackAttempt]);
    expect(one.failures).toEqual([publicationAttempt, rollbackAttempt]);
    expect(one).toMatchObject({ diagnosticCount: 2, failedCleanupCount: 2, retainedRecoveryCriticalCount: 1 });

    const backup = failure('original-backup', 'retained-unrestored', { cleanup: 'recovery-critical' });
    const two = summarizeRecoveryDiagnostics('publication', [publicationAttempt, rollbackAttempt, backup]);
    expect(two).toMatchObject({ diagnosticCount: 3, failedCleanupCount: 2, retainedRecoveryCriticalCount: 2 });
  });

  it('persists the largest selected payload through the real logger sanitizer untruncated', () => {
    // Every allow-listed field populated, with bigint-scale SMB dev:ino strings.
    const dev = '18446744073709551615';
    const fullEntry = (index) => ({
      assetId: 1000 + index,
      itemIndex: index,
      artifactRole: index % 2 ? 'staged-original' : 'published-output',
      check: index % 2 ? `cleanup-unlink-failed-${index}` : `rollback-ownership-unproven-${index}`,
      proof: 'alias-identity-mismatch',
      pathState: 'present',
      identity: 'mismatched',
      expected: `${dev}:${9007199254740993n + BigInt(index)}`,
      observed: `${dev}:${9007199254741993n + BigInt(index)}`,
      referenceIdentity: 'birthtime-mismatch',
      publicationMode: 'content-verified',
      errorCode: 'EIO',
      cleanup: 'recovery-critical',
    });
    const entries = Array.from({ length: 30 }, (_, index) => fullEntry(index));
    const error = Object.assign(new AssetProcessingError('recovery required', { code: 'RECOVERY_REQUIRED' }), {
      recoveryDiagnostics: summarizeRecoveryDiagnostics('publication', entries, [
        { outputVerification: { mode: 'content-verified' } },
      ], { restored: false, cleanupSucceeded: false }),
    });
    const inserted = [];
    const logger = createApplicationLogger({
      repository: { insert: (record) => inserted.push(record), prune: () => {} },
    });

    logger.error({
      subsystem: 'processing',
      event: 'processing.recovery.failed',
      level: 'error',
      kind: 'diagnostic',
      message: 'Processing recovery failed.',
      projectId: 1,
      context: recoveryLogContext({ operation: 'watermark', assetCount: 30, phase: 'recovery' }, error),
    });

    expect(inserted).toHaveLength(1);
    const { context } = inserted[0];
    expect(JSON.stringify(context)).not.toContain('[truncated]');
    expect(context).toEqual({
      operation: 'watermark',
      assetCount: 30,
      phase: 'recovery',
      recoveryPhase: 'publication',
      restored: false,
      cleanupSucceeded: false,
      failures: error.recoveryDiagnostics.failures,
      diagnosticCount: 30,
      failedCleanupCount: 15,
      strictProofFailureCount: 30,
      contentVerifiedCount: 1,
      retainedRecoveryCriticalCount: 30,
    });
    expect(context.failures).toHaveLength(RECOVERY_DIAGNOSTIC_LIMIT);
    for (const selected of context.failures) {
      expect(Object.keys(selected)).toHaveLength(13);
      expect(selected.expected).toMatch(/^\d+:\d+$/);
      expect(selected.observed).toMatch(/^\d+:\d+$/);
    }
  });
});
