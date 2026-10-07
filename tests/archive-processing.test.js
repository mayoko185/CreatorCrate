import { processingRecoveryEvidenceDependencies } from './helpers/processing-recovery-evidence.js';
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
import { createProcessingRecoveryEvidenceRepository } from '../src/data/processing-recovery-evidence-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createAssetProcessingPlanner } from '../src/services/asset-processing-planner.js';
import { createAssetProcessingService } from '../src/services/asset-processing-service.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { read7zArchiveEntries } from '../src/services/watermark-7z.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import {
  replaceStageAfterClose,
  replaceWithForeignDirectory,
  replaceWithForeignFile,
} from './helpers/processing-fs-races.js';
import { stagingWorkspaces, stageArtifact } from './helpers/processing-staging.js';

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

// Assigns fake file IDs to real inodes so tests can model IDs past 2^53, where distinct
// exact bigint IDs share one rounded Number. autoAssign tags the first file later observed
// at a matching path before CreatorCrate captures its identity.
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

// Reports chosen exact identity fields (dev, ino, birthtimeNs) for real inodes and every
// hard link to them, so tests can model inode reuse (same exact dev/ino, another birth
// time) and IDs past 2^53. autoAssign tags the first file later observed at a matching path.
// birthtimeNs may be a function of the real bigint stats, to model filesystem birth-time
// semantics (none reported, or a ctime-like value that a hard link changes).
function mockFileIdentities() {
  const realLstat = fs.lstatSync.bind(fs);
  const realFstat = fs.fstatSync.bind(fs);
  const assigned = new Map();
  const autoAssignments = [];
  const remap = (stats, realIno) => {
    const fields = assigned.get(realIno);
    if (!stats || !fields) return stats;
    const bigint = typeof stats.ino === 'bigint';
    const remapped = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats);
    for (const key of ['dev', 'ino']) {
      if (fields[key] !== undefined) remapped[key] = bigint ? fields[key] : Number(fields[key]);
    }
    if (bigint && fields.birthtimeNs !== undefined) {
      remapped.birthtimeNs = typeof fields.birthtimeNs === 'function'
        ? fields.birthtimeNs(stats) : fields.birthtimeNs;
    }
    return remapped;
  };
  const tagObserved = (observedPath, realIno) => {
    const tag = autoAssignments.find((entry) => !entry.used && entry.matches(path.resolve(String(observedPath))));
    if (tag && !assigned.has(realIno)) {
      tag.used = true;
      assigned.set(realIno, tag.fields);
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
    assign(filePath, fields) {
      assigned.set(realLstat(filePath, { bigint: true }).ino, fields);
    },
    autoAssign(matches, fields) {
      autoAssignments.push({ matches, fields, used: false });
    },
    restore() {
      fstatSpy.mockRestore();
      closeSpy.mockRestore();
      openSpy.mockRestore();
      lstatSpy.mockRestore();
    },
  };
}

// Hooks CreatorCrate's exclusive creation ('wx'/'wx+') of paths accepted by `matches`:
// `before(path)` runs immediately before the open (it may throw to fail the create, or make a
// foreign file appear), `after(path)` immediately after that descriptor closes (it may throw to
// fail the create after its bytes were written). Each hook runs only while `when()` holds, and
// at most `times` times.
function hookOwnedCreate(matches, { before, after, when = () => true, times = Infinity } = {}) {
  const realOpen = fs.openSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const created = new Map();
  let calls = 0;
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    const hooked = resolved && typeof flags === 'string' && flags.startsWith('wx') && matches(resolved)
      && when() && calls < times;
    if (hooked) {
      calls += 1;
      before?.(resolved);
    }
    const descriptor = realOpen(filePath, flags, ...args);
    if (hooked) created.set(descriptor, resolved);
    return descriptor;
  });
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
    const result = realClose(descriptor, ...args);
    const createdPath = created.get(descriptor);
    created.delete(descriptor);
    if (createdPath) after?.(createdPath);
    return result;
  });
  return {
    get calls() { return calls; },
    restore() {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

// Runs `onRead(path)` once, immediately before CreatorCrate's first read-only open of a path
// accepted by `matches` (a content hash), while `when()` holds.
function hookFirstRead(matches, onRead, { when = () => true } = {}) {
  const realOpen = fs.openSync.bind(fs);
  let fired = false;
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    if (!fired && resolved && (flags === undefined || flags === 'r') && matches(resolved) && when()) {
      fired = true;
      onRead(resolved);
    }
    return realOpen(filePath, flags, ...args);
  });
  return {
    get fired() { return fired; },
    restore() { openSpy.mockRestore(); },
  };
}

// Runs `onRead(path)` once, immediately before CreatorCrate's first read-only open of a path
// accepted by `second` that follows a read-only open of a path accepted by `first` (each
// counted only while `when()` holds): the content read of one object after another object's
// bytes were already verified.
function hookReadAfterRead(first, second, onRead, { when = () => true } = {}) {
  const realOpen = fs.openSync.bind(fs);
  let firstRead = false;
  let fired = false;
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    if (!fired && resolved && (flags === undefined || flags === 'r') && when()) {
      if (firstRead && second(resolved)) {
        fired = true;
        onRead(resolved);
      } else if (first(resolved)) {
        firstRead = true;
      }
    }
    return realOpen(filePath, flags, ...args);
  });
  return {
    get fired() { return fired; },
    restore() { openSpy.mockRestore(); },
  };
}

// Runs `onRead(path)` once, immediately after the descriptor of CreatorCrate's first read-only
// open of a path accepted by `matches` (while `when()` holds) closes: the content hash has
// already read its bytes, but the caller has not yet finished validating them.
function hookAfterRead(matches, onRead, { when = () => true } = {}) {
  const realOpen = fs.openSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  let hooked = null;
  let fired = false;
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    const descriptor = realOpen(filePath, flags, ...args);
    if (!fired && hooked === null && resolved && (flags === undefined || flags === 'r') && matches(resolved)
      && when()) {
      hooked = { descriptor, resolved };
    }
    return descriptor;
  });
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
    const result = realClose(descriptor, ...args);
    if (!fired && hooked?.descriptor === descriptor) {
      fired = true;
      onRead(hooked.resolved);
    }
    return result;
  });
  return {
    get fired() { return fired; },
    restore() {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

// hookAfterRead for EVERY read-only open of a path accepted by `matches`: `onRead(path)` runs
// immediately after each such descriptor closes (each content hash, including a re-hash).
function hookAfterEachRead(matches, onRead) {
  const realOpen = fs.openSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const hooked = new Map();
  let calls = 0;
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    const descriptor = realOpen(filePath, flags, ...args);
    if (resolved && (flags === undefined || flags === 'r') && matches(resolved)) hooked.set(descriptor, resolved);
    return descriptor;
  });
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
    const result = realClose(descriptor, ...args);
    const resolved = hooked.get(descriptor);
    hooked.delete(descriptor);
    if (resolved) {
      calls += 1;
      onRead(resolved);
    }
    return result;
  });
  return {
    get fired() { return calls > 0; },
    get calls() { return calls; },
    restore() {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

// Live WP4 SMB timeline (project 36, CBZ): the public archive's creating descriptor reports its
// write times T1; once that descriptor closes, the pathname reports later mtime/ctime T2 with
// the same exact identity, size, birth time and bytes; the first read-only open of the path
// (the pre-commit hash) refreshes it back to T1, which every later stat reports. Modelled on
// the real file created at a path accepted by `matches`: T1 is its real mtime/ctime (so a real
// later write still moves them) and T2 is T1 plus the live 20448600 ns step. Only bigint
// mtimeNs/ctimeNs are modelled; bytes and every other stat field are real. `observed` lists the
// modelled mtimeNs of each bigint lstat of that path, in order. `onReadOpen(path)` runs before
// every read-only open, for a test's own hook (openSync can carry only one spy).
function modelSmbTimeSettling(matches, { onReadOpen } = {}) {
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
    if (resolved && read) onReadOpen?.(resolved);
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

// Rewrites a file's bytes in place: the same inode (exact identity) with different content.
function rewriteInPlace(target, bytes) {
  const descriptor = fs.openSync(target, 'r+');
  try {
    fs.ftruncateSync(descriptor, 0);
    fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
}

// rewriteInPlace by a writer whose write lands in a later filesystem clock tick than the bytes
// CreatorCrate verified, so the modification time visibly advances (pinned here, since a test
// can otherwise run within one coarse timestamp tick). A same-tick, same-size write is the
// documented residual that write-metadata continuity cannot see.
function rewriteInPlaceLater(target, bytes) {
  const { atimeMs, mtimeMs } = fs.statSync(target);
  rewriteInPlace(target, bytes);
  fs.utimesSync(target, atimeMs / 1000, mtimeMs / 1000 + 5);
}

// Replaces `target` with a same-bytes foreign file (a distinct inode) and returns its exact ino.
function replaceWithSameBytes(target) {
  const bytes = fs.readFileSync(target);
  fs.rmSync(target);
  fs.writeFileSync(target, bytes);
  return fs.statSync(target, { bigint: true }).ino;
}

const provenanceTupleOf = (filePath) => {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return `v1:${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
};

// A share that cannot keep hard-link aliases: no archive boundary may depend on one.
const refuseHardLinks = () => vi.spyOn(fs, 'linkSync').mockImplementation(() => {
  throw Object.assign(new Error('hard links are not supported here'), { code: 'EPERM' });
});

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
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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
      projectOptionCatalogueService: createTestProjectOptionCatalogueService(db),
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
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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

  describe('Archive recovery evidence', () => {
    const options = { setName: 'Evidence', makeCbz: true };
    const progress = (jobId = 'archive-evidence-run') => Object.assign(() => {}, { jobId });
    const repository = () => createProcessingRecoveryEvidenceRepository(db);
    const rows = () => repository().listUnresolvedEvidenceByProject(project.id);
    const groups = () => repository().listMutationGroupsByProject(project.id);
    const relative = (target) => path.relative(projectDir, target).split(path.sep).join('/');
    const publicPath = () => path.join(projectDir, 'Evidence_jpg_q80.zip');
    const privatePath = (target) => target.includes('.creatorcrate-watermark-staging');

    function harness({ fail = {}, before = {}, repositoryOptions = {}, ...overrides } = {}) {
      const events = [];
      const real = createProcessingRecoveryEvidenceRepository(db, repositoryOptions);
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
      const service = makeProcessingService({
        ...processingRecoveryEvidenceDependencies(db, { repository: wrapped }), ...overrides,
      });
      return { service, events };
    }

    function recordFilesystem(events) {
      const realOpen = fs.openSync.bind(fs);
      const realWrite = fs.writeSync.bind(fs);
      const realAsyncWrite = fs.write.bind(fs);
      const realUnlink = fs.unlinkSync.bind(fs);
      const descriptors = new Map();
      const spies = [
        vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
          const descriptor = realOpen(target, flags, ...rest);
          if (typeof flags === 'string' && flags.startsWith('wx')) {
            const absPath = path.resolve(String(target));
            descriptors.set(descriptor, absPath);
            events.push({ type: 'create', path: absPath });
          }
          return descriptor;
        }),
        vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, ...rest) => {
          if (descriptors.has(descriptor)) events.push({ type: 'write', path: descriptors.get(descriptor) });
          return realWrite(descriptor, ...rest);
        }),
        vi.spyOn(fs, 'write').mockImplementation((descriptor, ...rest) => {
          if (descriptors.has(descriptor)) events.push({ type: 'write', path: descriptors.get(descriptor) });
          return realAsyncWrite(descriptor, ...rest);
        }),
        vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...rest) => {
          events.push({ type: 'unlink', path: path.resolve(String(target)) });
          return realUnlink(target, ...rest);
        }),
      ];
      return () => spies.reverse().forEach((spy) => spy.mockRestore());
    }

    it.each(['processingRecoveryEvidenceRecorder', 'processingRecoveryEvidenceRepository'])(
      'rejects missing %s before Archive filesystem mutation', async (missing) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        const { service, events } = harness({ [missing]: null });
        const restore = recordFilesystem(events);
        let error;
        try { error = await service.createArchives(project.id, [asset.id], options).catch((err) => err); }
        finally { restore(); }
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_UNAVAILABLE' });
        expect(events.filter((event) => ['create', 'unlink'].includes(event.type))).toEqual([]);
        expect(fs.existsSync(path.join(projectDir, '.creatorcrate-watermark-staging'))).toBe(false);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
        expect(rows()).toEqual([]);
      },
    );

    it.each([false, true])('publishes a valid long Archive destination with bounded stable evidence keys (CBZ=%s)', async (makeCbz) => {
      const asset = await writeIndexedImage('Final/long-name.png');
      const setName = 'L'.repeat(240);
      const longOptions = { setName, outputDirectory: 'Long', makeArchives: !makeCbz, makeCbz };
      const destinations = makeCbz ? [`Long/${setName}_jpg_q85.cbz`]
        : [`Long/${setName}_jpg_q80.zip`, `Long/${setName}_webp_q90.zip`];
      const { service, events } = harness();
      const first = await service.createArchives(project.id, [asset.id], longOptions);
      const second = await service.createArchives(project.id, [asset.id], {
        ...longOptions, replaceExistingArchives: true,
      });
      expect(first.status).toBe('completed');
      expect(second.status).toBe('completed');
      expect(first.generatedPaths).toEqual(destinations);
      expect(second.generatedPaths).toEqual(destinations);
      for (const destination of destinations) {
        expect(Buffer.byteLength(path.posix.basename(destination))).toBeLessThanOrEqual(255);
        expect(fs.existsSync(path.join(projectDir, destination))).toBe(true);
        const intents = events.filter((event) => event.name === 'createEvidence'
          && event.result.destinationPath === destination);
        expect(intents).toHaveLength(5);
        const kind = destination.endsWith('.cbz') ? 'archive-cbz'
          : destination.includes('_webp_') ? 'archive-webp' : 'archive-jpg';
        expect(`${kind}:${destination}`.length).toBeGreaterThan(256);
        expect(intents.every((event) => event.result.itemKey === `${kind}:${sha256(destination)}`)).toBe(true);
        expect(intents.every((event) => event.result.itemKey.length <= 256)).toBe(true);
        expect(intents.filter((event) => event.result.artifactRole === 'published-archive')
          .every((event) => event.result.artifactPath === destination)).toBe(true);
      }
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it('distinguishes long Archive destinations that share a prefix and differ near the end', async () => {
      const asset = await writeIndexedImage('Final/long-prefix.png');
      const prefix = 'P'.repeat(239);
      const { service, events } = harness();
      for (const suffix of ['A', 'B']) {
        const result = await service.createArchives(project.id, [asset.id], { setName: `${prefix}${suffix}` });
        expect(result.status).toBe('completed');
      }
      const createdGroups = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(createdGroups).toHaveLength(4);
      expect(new Set(createdGroups.map((group) => group.itemKey)).size).toBe(4);
      expect(createdGroups.every((group) => group.itemKey.length <= 256)).toBe(true);
      for (const event of events.filter((event) => event.name === 'createEvidence')) {
        const destination = event.result.destinationPath;
        expect(destination).toMatch(new RegExp(`^${prefix}[AB]_(jpg_q80|webp_q90)\\.zip$`));
        const kind = destination.includes('_webp_') ? 'archive-webp' : 'archive-jpg';
        expect(event.result.itemKey).toBe(`${kind}:${sha256(destination)}`);
      }
    });

    it('orders durable intent, exact identity, checkpoint and promotion before Archive writes and replacement', async () => {
      const assets = [await writeIndexedImage('Final/a.png'), await writeIndexedImage('Final/b.png')];
      const { service, events } = harness();
      const restore = recordFilesystem(events);
      let first;
      let second;
      try {
        first = await service.createArchives(project.id, assets.map((asset) => asset.id), options, progress());
        second = await service.createArchives(project.id, assets.map((asset) => asset.id), {
          ...options, replaceExistingArchives: true,
        }, progress('archive-replacement-run'));
      } finally { restore(); }
      expect(first.artifacts).toHaveLength(3);
      expect(second.artifacts.map((artifact) => artifact.id)).toEqual(first.artifacts.map((artifact) => artifact.id));
      const intents = events.filter((event) => event.name === 'createEvidence');
      expect(intents).toHaveLength(15); // Three containers: stage/public, then stage/backup/public.
      expect(new Set(intents.map((event) => event.result.artifactRole))).toEqual(
        new Set(['archive-stage', 'destination-backup', 'published-archive']),
      );
      for (const creation of events.filter((event) => event.type === 'create')) {
        const intentIndex = events.findIndex((event) => event.name === 'createEvidence'
          && event.result.artifactPath === relative(creation.path)
          && events.indexOf(event) < events.indexOf(creation)
          && !events.slice(events.indexOf(event) + 1, events.indexOf(creation)).some((later) =>
            later.type === 'create' && later.path === creation.path));
        expect(intentIndex).toBeGreaterThan(-1);
        const intent = events[intentIndex].result;
        const identityIndex = events.findIndex((event) => event.name === 'attachEvidenceIdentity'
          && event.args[1] === intent.evidenceId);
        const writeIndex = events.findIndex((event, index) => index > events.indexOf(creation)
          && event.type === 'write' && event.path === creation.path);
        expect(identityIndex).toBeGreaterThan(events.indexOf(creation));
        expect(writeIndex).toBeGreaterThan(identityIndex);
        expect(events[identityIndex].inTransaction).toBe(false);
        expect(intent).toMatchObject({ operation: 'archive', assetId: null });
        expect(first.generatedPaths).toContain(intent.destinationPath);
        expect(intent.artifactPath).toBe(relative(creation.path));
        expect(intent.artifactPath).not.toMatch(/\\|^[A-Za-z]:|^\//);
        expect(intent.sourcePath).toBe(intent.artifactRole === 'destination-backup' ? intent.destinationPath : null);
        if (intent.artifactRole === 'published-archive') {
          const checkpoint = events.findIndex((event) => event.name === 'markMutationCheckpoint'
            && event.args[1] === intent.mutationGroupId);
          const promotions = events.filter((event) => event.name === 'setEvidenceLifecycle'
            && event.args[2] === 'recovery-critical' && intents.some((entry) => entry.result.evidenceId === event.args[1]
              && entry.result.mutationGroupId === intent.mutationGroupId));
          expect(checkpoint).toBeGreaterThan(intentIndex);
          expect(promotions.length).toBeGreaterThan(0);
          expect(promotions.every((event) => events.indexOf(event) > checkpoint
            && events.indexOf(event) < events.indexOf(creation))).toBe(true);
          if (events[checkpoint].args[2] === 'replace') {
            const unlinkIndex = events.findIndex((event, index) => index > checkpoint
              && event.type === 'unlink' && event.path === creation.path);
            expect(unlinkIndex).toBeGreaterThan(Math.max(...promotions.map((event) => events.indexOf(event))));
            expect(unlinkIndex).toBeLessThan(events.indexOf(creation));
          }
        }
      }
      const createdGroups = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(createdGroups).toHaveLength(6);
      expect(new Set(createdGroups.map((group) => group.groupId)).size).toBe(6);
      expect(createdGroups.filter((group) => group.itemKey.includes('archive-cbz:'))).toHaveLength(2);
      expect(createdGroups.slice(0, 3).every((group) => group.runId === 'archive-evidence-run')).toBe(true);
      expect(events.filter((event) => event.name === 'clearMutationCheckpoint').every((event) => !event.inTransaction)).toBe(true);
      expect(events.filter((event) => event.name === 'setEvidenceRetentionReason'
        && event.args[2] === 'archive-committed').some((event) => event.inTransaction)).toBe(true);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it.each(['group', 'stage-intent', 'stage-identity', 'content-proof', 'public-intent', 'checkpoint', 'promotion'])(
      'halts Archive public mutation on %s persistence failure', async (stage) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        let promotionFailed = false;
        const { service, events } = harness({ fail: {
          createMutationGroup: () => stage === 'group',
          createEvidence: ([intent]) => (stage === 'stage-intent' && intent.artifactRole === 'archive-stage')
            || (stage === 'public-intent' && intent.artifactRole === 'published-archive'),
          attachEvidenceIdentity: ([, id], { roleOf }) => stage === 'stage-identity' && roleOf(id) === 'archive-stage',
          updateEvidenceContentProof: () => stage === 'content-proof',
          markMutationCheckpoint: () => stage === 'checkpoint',
          setEvidenceLifecycle: ([, , lifecycle]) => {
            if (stage === 'promotion' && lifecycle === 'recovery-critical' && !promotionFailed) {
              promotionFailed = true;
              return true;
            }
            return false;
          },
        } });
        const restore = recordFilesystem(events);
        let error;
        try { error = await service.createArchives(project.id, [asset.id], options, progress()).catch((err) => err); }
        finally { restore(); }
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' });
        expect(events.filter((event) => ['create', 'unlink'].includes(event.type) && !privatePath(event.path))).toEqual([]);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
        if (['group', 'stage-intent'].includes(stage)) expect(events.filter((event) => event.type === 'create')).toEqual([]);
        if (stage === 'group') expect(fs.existsSync(path.join(projectDir, '.creatorcrate-watermark-staging'))).toBe(false);
        if (stage === 'checkpoint') expect(events.filter((event) => event.name === 'setEvidenceLifecycle'
          && event.args[2] === 'recovery-critical')).toEqual([]);
        if (stage === 'promotion') {
          expect(groups()).toEqual([expect.objectContaining({ checkpoint: 'public-create', operation: 'archive' })]);
          expect(rows().find((row) => row.artifactRole === 'archive-stage').lifecycle).toBe('intent');
        }
      },
    );

    it.each(['intent', 'identity'])(
      'leaves the old archive untouched on backup %s persistence failure', async (failureStage) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        await processingService.createArchives(project.id, [asset.id], options);
        const old = fs.readFileSync(publicPath());
        const { service, events } = harness({ fail: {
          createEvidence: ([intent]) => failureStage === 'intent' && intent.artifactRole === 'destination-backup',
          attachEvidenceIdentity: ([, id], { roleOf }) => failureStage === 'identity' && roleOf(id) === 'destination-backup',
        } });
        const restore = recordFilesystem(events);
        let error;
        try { error = await service.createArchives(project.id, [asset.id], {
          ...options, replaceExistingArchives: true,
        }).catch((err) => err); } finally { restore(); }
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' });
        expect(events.filter((event) => ['create', 'unlink'].includes(event.type) && !privatePath(event.path))).toEqual([]);
        expect(fs.readFileSync(publicPath())).toEqual(old);
        expect(rows()).toEqual([]);
        expect(groups()).toEqual([]);
      },
    );

    it.each(['lifecycle', 'public-observation'])('requires the shared Archive transaction and rolls back failed finalization (%s)', async (failedWrite) => {
      const asset = await writeIndexedImage('Final/evidence.png');
      let finalizationFailed = false;
      const { service, events } = harness({ fail: {
        setEvidenceRetentionReason: ([, , reason]) => {
          if (failedWrite !== 'lifecycle' || reason !== 'archive-committed' || finalizationFailed) return false;
          expect(db.inTransaction).toBe(true);
          expect(generatedArtifactRepository.listByProjectId(project.id)).toHaveLength(3);
          expect(generatedArtifactRepository.listByProjectId(project.id).every((artifact) => artifact.output_provenance)).toBe(true);
          finalizationFailed = true;
          return true;
        },
        setEvidenceObservation: ([, , observation]) => {
          if (failedWrite !== 'public-observation' || observation !== 'present' || finalizationFailed) return false;
          expect(db.inTransaction).toBe(true);
          expect(generatedArtifactRepository.listByProjectId(project.id)).toHaveLength(3);
          finalizationFailed = true;
          return true;
        },
      } });
      const apply = assetRepository.applyAssetWatermarks.bind(assetRepository);
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation((...args) => {
        // Removing the outer transaction is detected here, before the index write.
        expect(db.inTransaction).toBe(true);
        return apply(...args);
      });
      let error;
      try { error = await service.createArchives(project.id, [asset.id], options).catch((err) => err); }
      finally { applySpy.mockRestore(); }
      expect(finalizationFailed).toBe(true);
      expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' });
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(fs.existsSync(publicPath())).toBe(false);
      expect(events.filter((event) => event.name === 'clearMutationCheckpoint').every((event) => !event.inTransaction)).toBe(true);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it.each(['resolution', 'public-delete', 'private-delete', 'group-delete', 'cleanup-observation'])(
      'preserves committed Archive files and provenance on post-commit %s failure', async (failureStage) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        const { service } = harness({ fail: {
          clearMutationCheckpoint: () => failureStage === 'resolution',
          deleteEvidence: ([, id], { roleOf }) => (failureStage === 'public-delete' && roleOf(id) === 'published-archive')
            || (failureStage === 'private-delete' && roleOf(id) === 'archive-stage'),
          deleteMutationGroup: () => failureStage === 'group-delete',
          setEvidenceObservation: ([, , observation]) => failureStage === 'cleanup-observation' && observation === 'missing',
        } });
        const error = await service.createArchives(project.id, [asset.id], options).catch((err) => err);
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' });
        const artifacts = generatedArtifactRepository.listByProjectId(project.id);
        expect(artifacts).toHaveLength(3);
        for (const artifact of artifacts) {
          const target = path.join(projectDir, artifact.relative_path);
          expect(createHash('sha256').update(fs.readFileSync(target)).digest('hex')).toBe(artifact.sha256);
          expect(artifact.output_provenance).toBeTruthy();
        }
        expect(groups()).toHaveLength(3);
        if (failureStage === 'resolution') {
          expect(groups().every((group) => group.checkpoint === 'public-create')).toBe(true);
          expect(rows()).toHaveLength(6);
          expect(rows().filter((row) => row.artifactRole === 'archive-stage').every((row) =>
            row.lifecycle === 'dispensable' && fs.existsSync(path.join(projectDir, row.artifactPath)))).toBe(true);
        } else expect(groups().every((group) => group.checkpoint === null)).toBe(true);
        if (failureStage === 'private-delete') expect(rows().every((row) => row.observation === 'missing'
          && row.lifecycle === 'dispensable' && !fs.existsSync(path.join(projectDir, row.artifactPath)))).toBe(true);
      },
    );

    it('retains an unclaimed public Archive with null identity, its group and recovery-critical stage', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const identities = mockFileIdentities();
      identities.autoAssign((target) => target === publicPath(), { dev: 0n, ino: 0n });
      let error;
      try { error = await processingService.createArchives(project.id, [asset.id], options, progress()).catch((err) => err); }
      finally { identities.restore(); }
      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.existsSync(publicPath())).toBe(true);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(groups()).toEqual([expect.objectContaining({ operation: 'archive', runId: 'archive-evidence-run', checkpoint: 'public-create' })]);
      expect(rows()).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'published-archive', identity: null, observation: 'ownership-unknown',
          retentionReason: 'archive-public-created-unclaimed' }),
        expect.objectContaining({ artifactRole: 'archive-stage', lifecycle: 'recovery-critical', observation: 'present' }),
      ]));
      expect(rows()).toHaveLength(2);
    });

    it.each(['restore', 'provenance'])(
      'protects the last-good archive backup until %s proof succeeds', async (failedProof) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        await processingService.createArchives(project.id, [asset.id], options);
        const old = fs.readFileSync(publicPath());
        let rollingBack = false;
        const { service } = harness();
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
          rollingBack = true;
          throw new Error('injected index failure');
        });
        const realOpen = fs.openSync.bind(fs);
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
          if (failedProof === 'restore' && rollingBack && target === publicPath() && flags.startsWith('wx')) {
            throw Object.assign(new Error('injected restore EIO'), { code: 'EIO' });
          }
          return realOpen(target, flags, ...rest);
        });
        const reconcile = assetRepository.reconcileGeneratedArtifactProvenance.bind(assetRepository);
        const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedArtifactProvenance').mockImplementation((...args) => {
          if (failedProof === 'provenance') throw new Error('injected reconciliation failure');
          return reconcile(...args);
        });
        let error;
        try { error = await service.createArchives(project.id, [asset.id], {
          ...options, replaceExistingArchives: true,
        }).catch((err) => err); }
        finally { reconcileSpy.mockRestore(); openSpy.mockRestore(); applySpy.mockRestore(); }
        expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        const backups = rows().filter((row) => row.artifactRole === 'destination-backup');
        expect(backups.length).toBeGreaterThan(0);
        expect(backups.every((row) => row.lifecycle === 'recovery-critical')).toBe(true);
        expect(backups.every((row) => row.retentionReason === (failedProof === 'restore'
          ? 'archive-restoration-failed' : 'archive-provenance-reconciliation-failed'))).toBe(true);
        expect(fs.readFileSync(path.join(projectDir, backups.find((row) => row.destinationPath === relative(publicPath())).artifactPath))).toEqual(old);
        expect(groups().every((group) => group.checkpoint === 'replace')).toBe(true);
        if (failedProof === 'restore') expect(groups()).toHaveLength(1);
        const publicRow = rows().find((row) => row.artifactRole === 'published-archive'
          && row.destinationPath === relative(publicPath()));
        expect(publicRow.observation).toBe(failedProof === 'restore' ? 'missing' : 'replaced');
      },
    );

    it.each(['present', 'changed', 'missing', 'unavailable'])(
      'preserves the original published Archive proof after restoration when the current path is %s', async (pathState) => {
        const asset = await writeIndexedImage('Final/restored-evidence.png');
        await processingService.createArchives(project.id, [asset.id], options);
        const old = fs.readFileSync(publicPath());
        const { service, events } = harness({ fail: {
          deleteEvidence: ([, id], { roleOf }) => pathState === 'present' && roleOf(id) === 'published-archive',
        } });
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
          throw new Error('injected index failure');
        });
        let originalProof;
        let restoredIdentity;
        let inspectionUnavailable = false;
        const realLstat = fs.lstatSync.bind(fs);
        const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
          if (inspectionUnavailable && target === publicPath()) {
            throw Object.assign(new Error('injected restored-path EIO'), { code: 'EIO' });
          }
          return realLstat(target, ...rest);
        });
        const reconcile = assetRepository.reconcileGeneratedArtifactProvenance.bind(assetRepository);
        const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedArtifactProvenance').mockImplementation((...args) => {
          originalProof = rows().find((row) => row.artifactRole === 'published-archive'
            && row.destinationPath === relative(publicPath()));
          const stats = realLstat(publicPath(), { bigint: true });
          restoredIdentity = { dev: String(stats.dev), ino: String(stats.ino),
            birthtimeNs: String(stats.birthtimeNs) };
          const result = reconcile(...args);
          if (pathState === 'changed') rewriteInPlaceLater(publicPath(), Buffer.from('corrupted restored archive'));
          if (pathState === 'missing') fs.unlinkSync(publicPath());
          if (pathState === 'unavailable') inspectionUnavailable = true;
          return result;
        });
        let error;
        try { error = await service.createArchives(project.id, [asset.id], {
          ...options, replaceExistingArchives: true,
        }).catch((err) => err); }
        finally { reconcileSpy.mockRestore(); lstatSpy.mockRestore(); applySpy.mockRestore(); }
        expect(originalProof).toBeDefined();
        expect(originalProof.identity).not.toMatchObject({ dev: restoredIdentity.dev, ino: restoredIdentity.ino });
        const publicRow = rows().find((row) => row.evidenceId === originalProof.evidenceId);
        expect(publicRow).toMatchObject({
          identity: originalProof.identity,
          expectedSize: originalProof.expectedSize,
          expectedSha256: originalProof.expectedSha256,
          observation: ['present', 'changed'].includes(pathState) ? 'replaced' : pathState,
        });
        expect(events.filter((event) => event.name === 'attachEvidenceIdentity'
          && event.args[1] === originalProof.evidenceId)).toHaveLength(1);
        if (pathState === 'present') {
          expect(fs.readFileSync(publicPath())).toEqual(old);
          expect(error.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
        } else {
          expect(error.code).toBe('RECOVERY_REQUIRED');
          const backup = rows().find((row) => row.artifactRole === 'destination-backup'
            && row.destinationPath === relative(publicPath()));
          expect(backup).toMatchObject({ lifecycle: 'recovery-critical', observation: 'present',
            expectedSha256: sha256(old), expectedSize: old.length });
          expect(fs.readFileSync(path.join(projectDir, backup.artifactPath))).toEqual(old);
          const diagnostic = error.recoveryDiagnostics.failures.find((entry) => entry.artifactRole === 'restored-archive');
          expect(diagnostic).toMatchObject(pathState === 'changed'
            ? { pathState: 'present', identity: 'matched', check: 'restored-archive-content-mismatch' }
            : { pathState: pathState === 'missing' ? 'absent' : 'inspection-failed' });
        }
      },
    );

    it.each(['present', 'replaced', 'unavailable', 'ownership-unknown'])(
      'mirrors the existing Archive cleanup diagnostic for safe %s residue', async (observation) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        let residuePath;
        let expectedIdentity;
        let expectedEvidenceId;
        let generatedId = 100;
        const realUnlink = fs.unlinkSync.bind(fs);
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...rest) => {
          if (privatePath(String(target))) throw Object.assign(new Error('injected cleanup EACCES'), { code: 'EACCES' });
          return realUnlink(target, ...rest);
        });
        const realLstat = fs.lstatSync.bind(fs);
        const lstatSpy = observation === 'unavailable' ? vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
          if (target === residuePath && observation === 'unavailable') {
            throw Object.assign(new Error('injected cleanup EIO'), { code: 'EIO' });
          }
          return realLstat(target, ...rest);
        }) : null;
        const before = harness({ repositoryOptions: {
          now: () => new Date('2026-01-01T00:00:00.000Z'),
          generateId: () => `00000000-0000-4000-8000-${String(generatedId--).padStart(12, '0')}`,
        }, before: {
          clearMutationCheckpoint: ([, groupId]) => {
            const stage = repository().listEvidenceByMutationGroup(project.id, groupId).find((row) => row.artifactRole === 'archive-stage');
            if (!stage) return;
            residuePath = path.join(projectDir, stage.artifactPath);
            expectedIdentity = stage.identity;
            expectedEvidenceId = stage.evidenceId;
            if (observation === 'replaced') replaceWithForeignFile(residuePath, Buffer.from('foreign'));
          },
        } });
        // Unknown descriptor identity is private and stops before any public mutation.
        const identities = observation === 'ownership-unknown' ? mockFileIdentities() : null;
        identities?.autoAssign((target) => privatePath(target) && /\.archive-\d+\./.test(path.basename(target)), { dev: 0n, ino: 0n });
        let result;
        try { result = await before.service.createArchives(project.id, [asset.id], options).catch((err) => err); }
        finally { identities?.restore(); lstatSpy?.mockRestore(); unlinkSpy.mockRestore(); }
        if (observation === 'ownership-unknown') expect(result).toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });
        else expect(result.status).toBe('completed');
        const residue = rows().filter((row) => row.artifactRole === 'archive-stage');
        expect(residue.length).toBeGreaterThan(0);
        expect(residue.every((row) => row.lifecycle === 'dispensable' && row.retentionReason === 'archive-cleanup-residue'
          && row.observation === observation)).toBe(true);
        expect(groups().every((group) => group.checkpoint === null)).toBe(true);
        if (observation === 'replaced') {
          const createdStageIds = before.events.filter((event) => event.name === 'createEvidence'
            && event.result.artifactRole === 'archive-stage').map((event) => event.result.evidenceId);
          expect(new Set(residue.map((row) => row.createdAt)).size).toBe(1);
          expect(createdStageIds).toHaveLength(3);
          expect(createdStageIds).toEqual([...createdStageIds].sort().reverse());
          expect(residue.find((row) => row.evidenceId === expectedEvidenceId).identity).toEqual(expectedIdentity);
        }
      },
    );

    it('mirrors changed owned backup residue without replacing its recorded content proof', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      await processingService.createArchives(project.id, [asset.id], options);
      const old = fs.readFileSync(publicPath());
      const { service } = harness();
      const hook = hookOwnedCreate((target) => path.basename(target).endsWith('.destination'), {
        after: (target) => rewriteInPlaceLater(target, Buffer.alloc(old.length, 0x77)), times: 1,
      });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...rest) => {
        if (String(target).endsWith('.destination')) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        return realUnlink(target, ...rest);
      });
      let error;
      try { error = await service.createArchives(project.id, [asset.id], {
        ...options, replaceExistingArchives: true,
      }).catch((err) => err); } finally { unlinkSpy.mockRestore(); hook.restore(); }
      expect(error).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED',
        recoveryDiagnostics: { restored: true, cleanupSucceeded: false } });
      const backup = rows().find((row) => row.artifactRole === 'destination-backup');
      expect(backup).toMatchObject({ lifecycle: 'dispensable', observation: 'changed', retentionReason: 'archive-cleanup-residue',
        expectedSha256: createHash('sha256').update(old).digest('hex'), expectedSize: old.length });
      expect(groups()).toEqual([expect.objectContaining({ checkpoint: null })]);
      expect(fs.readFileSync(publicPath())).toEqual(old);
    });

    it.each([false, true])('keeps accurate evidence settlement mandatory after a verified rollback (unresolved=%s)', async (unresolved) => {
      const asset = await writeIndexedImage('Final/evidence.png');
      let rollingBack = false;
      const { service } = harness({ fail: { setEvidenceObservation: () => rollingBack } });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        rollingBack = true;
        throw new Error('injected DB failure');
      });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...rest) => {
        if (unresolved && rollingBack && target === publicPath()) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        return realUnlink(target, ...rest);
      });
      let error;
      try { error = await service.createArchives(project.id, [asset.id], options).catch((err) => err); }
      finally { unlinkSpy.mockRestore(); applySpy.mockRestore(); }
      expect(error.code).toBe(unresolved ? 'RECOVERY_REQUIRED' : 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
      if (unresolved) expect(error.observationFailure.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(rows().length).toBeGreaterThan(0);
      expect(groups().some((group) => group.checkpoint !== null)).toBe(true);
    });

    it('uses one fallback run per invocation and never adopts prior Archive residue', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service, events } = harness();
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...rest) => {
        if (privatePath(String(target))) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        return realUnlink(target, ...rest);
      });
      try { await service.createArchives(project.id, [asset.id], options); }
      finally { unlinkSpy.mockRestore(); }
      const retained = rows();
      const second = await service.createArchives(project.id, [asset.id], { ...options, setName: 'Next' });
      expect(second.artifacts).toHaveLength(3);
      expect(rows()).toEqual(retained);
      expect(retained.every((row) => fs.existsSync(path.join(projectDir, row.artifactPath)))).toBe(true);
      const createdGroups = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(new Set(createdGroups.slice(0, 3).map((group) => group.runId)).size).toBe(1);
      expect(new Set(createdGroups.slice(3).map((group) => group.runId)).size).toBe(1);
      expect(createdGroups[0].runId).not.toBe(createdGroups[3].runId);
    });

    it.each([false, true])('requires durable settlement before a private-only recovery downgrade (observation failure=%s)', async (observationFails) => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service } = harness({ fail: {
        attachEvidenceIdentity: ([, id], { roleOf }) => roleOf(id) === 'archive-stage',
        setEvidenceObservation: () => observationFails,
      } });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...rest) => {
        if (privatePath(String(target))) throw Object.assign(new Error('injected private unlink EACCES'), { code: 'EACCES' });
        return realUnlink(target, ...rest);
      });
      let error;
      try { error = await service.createArchives(project.id, [asset.id], options).catch((err) => err); }
      finally { unlinkSpy.mockRestore(); }
      expect(error.code).toBe(observationFails ? 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' : 'FILESYSTEM_OPERATION_FAILED');
      if (!observationFails) expect(error.recoveryDiagnostics).toMatchObject({ restored: true, cleanupSucceeded: false });
      expect(fs.existsSync(publicPath())).toBe(false);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(rows()).toHaveLength(1);
      expect(fs.existsSync(path.join(projectDir, rows()[0].artifactPath))).toBe(true);
      if (!observationFails) expect(rows()[0]).toMatchObject({ identity: null, lifecycle: 'dispensable',
        retentionReason: 'archive-cleanup-residue', observation: 'ownership-unknown' });
      expect(groups()).toEqual([expect.objectContaining({ checkpoint: null })]);
    });

    it('keeps core Watermark and Archive groups separate under the same job run and rolls both back', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service, events } = harness({ fail: {
        createEvidence: ([intent]) => intent.artifactRole === 'published-archive',
      } });
      const error = await service.watermarkAssets(project.id, [asset.id], {
        mode: 'custom', outputFormat: 'png', outputCategorySlug: 'final', makeArchives: true, makeCbz: true, setName: 'Evidence',
      }, progress('shared-job-run')).catch((err) => err);
      expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' });
      const intents = events.filter((event) => event.type === 'db' && event.name === 'createEvidence').map((event) => event.result);
      expect(intents.filter((row) => row.operation === 'watermark').map((row) => row.artifactRole)).toEqual(['stage-output', 'published-output']);
      expect(intents.filter((row) => row.operation === 'archive')).toHaveLength(3);
      expect(intents.filter((row) => row.operation === 'archive').every((row) => row.artifactRole === 'archive-stage')).toBe(true);
      const created = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(created).toHaveLength(4);
      expect(created.every((group) => group.runId === 'shared-job-run')).toBe(true);
      expect(new Set(created.map((group) => group.groupId)).size).toBe(4);
      const coreOutput = intents.find((row) => row.operation === 'watermark' && row.artifactRole === 'published-output');
      expect(assetRepository.findByProjectIdAndPath(project.id, coreOutput.destinationPath)).toBeFalsy();
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
      const success = await makeProcessingService().watermarkAssets(project.id, [asset.id], {
        mode: 'custom', outputFormat: 'png', outputCategorySlug: 'final', makeArchives: true, makeCbz: true, setName: 'Evidence',
      }, progress('shared-success'));
      expect(success.artifacts).toHaveLength(3);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it.each(['rollback', 'committed-resolution'])(
      'isolates Archive evidence from core Watermark settlement during %s', async (failureStage) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        let rollingBack = false;
        const { service, events } = harness({ fail: {
          clearMutationCheckpoint: ([, groupId]) => failureStage === 'committed-resolution'
            && repository().findMutationGroup(project.id, groupId).operation === 'archive',
        } });
        const apply = assetRepository.applyAssetWatermarks.bind(assetRepository);
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation((...args) => {
          expect(db.inTransaction).toBe(true);
          if (failureStage === 'rollback') { rollingBack = true; throw new Error('injected DB failure'); }
          return apply(...args);
        });
        const realUnlink = fs.unlinkSync.bind(fs);
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...rest) => {
          if (rollingBack && path.basename(String(target)) === 'Evidence_jpg_q80.zip') {
            throw Object.assign(new Error('injected archive rollback EACCES'), { code: 'EACCES' });
          }
          return realUnlink(target, ...rest);
        });
        let error;
        try { error = await service.watermarkAssets(project.id, [asset.id], {
          mode: 'custom', outputFormat: 'png', outputCategorySlug: 'final', makeArchives: true, makeCbz: true, setName: 'Evidence',
        }, progress('shared-isolation-run')).catch((err) => err); }
        finally { unlinkSpy.mockRestore(); applySpy.mockRestore(); }
        expect(error.code).toBe(failureStage === 'rollback' ? 'RECOVERY_REQUIRED' : 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
        expect(rows().length).toBeGreaterThan(0);
        expect(rows().every((row) => row.operation === 'archive' && row.runId === 'shared-isolation-run')).toBe(true);
        expect(groups().every((group) => group.operation === 'archive' && group.checkpoint === 'public-create')).toBe(true);
        expect(events.filter((event) => event.type === 'db' && event.name === 'createEvidence'
          && event.result.operation === 'archive').map((event) => event.result.artifactRole)).toEqual([
          'archive-stage', 'archive-stage', 'archive-stage', 'published-archive', 'published-archive', 'published-archive',
        ]);
        const coreOutput = events.find((event) => event.type === 'db' && event.name === 'createEvidence'
          && event.result.operation === 'watermark' && event.result.artifactRole === 'published-output').result;
        if (failureStage === 'rollback') {
          expect(groups()).toHaveLength(1);
          expect(rows()).toHaveLength(2);
          expect(rows().every((row) => row.lifecycle === 'recovery-critical')).toBe(true);
          expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
          expect(assetRepository.findByProjectIdAndPath(project.id, coreOutput.destinationPath)).toBeFalsy();
        } else {
          expect(groups()).toHaveLength(3);
          expect(generatedArtifactRepository.listByProjectId(project.id)).toHaveLength(3);
          expect(assetRepository.findByProjectIdAndPath(project.id, coreOutput.destinationPath)).toBeTruthy();
        }
      },
    );
  });

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
    await expect(makeProcessingService(processingRecoveryEvidenceDependencies(db)).watermarkAssets(project.id, [source.id], {
      mode: 'custom',
      outputFormat: 'png',
      outputCategorySlug: 'final',
      deleteSource: false,
      makeArchives: true,
      setName: 'Shared',
    })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });

    const watermarkService = createAssetProcessingService({
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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
    // Each previous archive returns as a new descriptor-owned file; only its row's provenance
    // is reconciled to that restored file, and it stays replaceable.
    const afterArtifacts = generatedArtifactRepository.listByProjectId(project.id);
    expect(afterArtifacts.map(({ output_provenance: _, ...row }) => row))
      .toEqual(beforeArtifacts.map(({ output_provenance: _, ...row }) => row));
    for (const row of afterArtifacts) {
      expect(row.output_provenance).toBe(provenanceTupleOf(path.join(projectDir, row.relative_path)));
    }
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);
    await processingService.createArchives(project.id, [source.id], {
      setName: 'Restore', replaceExistingArchives: true,
    });
  });

  // Old: an owned replacement that vanished between rollback's ownership proof and its unlink
  // (ENOENT) was treated as unresolved, so the previous archive was never restored and the
  // failure became RECOVERY_REQUIRED.
  it('restores the previous archive when the owned replacement vanishes at rollback unlink', async () => {
    const source = await writeIndexedImage('Final/rollback-enoent.png');
    await processingService.createArchives(project.id, [source.id], { setName: 'Vanish' });
    const jpgPath = path.resolve(projectDir, 'Vanish_jpg_q80.zip');
    const previousBytes = fs.readFileSync(jpgPath);
    const previousRow = generatedArtifactRepository.findByProjectIdAndPath(project.id, 'Vanish_jpg_q80.zip');
    expect(previousRow.output_provenance).toMatch(/^v1:\d+:[1-9]\d*:\d+$/);
    const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);

    const applicationLogger = { warn: vi.fn(), error: vi.fn() };
    const service = makeProcessingService({ applicationLogger });
    let rollingBack = false;
    let vanished = false;
    let replacementIno;
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
      replacementIno = fs.statSync(jpgPath, { bigint: true }).ino;
      rollingBack = true;
      throw new Error('injected archive index failure');
    });
    const realUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
      if (rollingBack && !vanished && path.resolve(String(filePath)) === jpgPath) {
        // Rollback has already proven this is the owned archive; it disappears first.
        vanished = true;
        realUnlink(filePath, ...args);
        throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${filePath}'`), {
          code: 'ENOENT', syscall: 'unlink', path: String(filePath),
        });
      }
      return realUnlink(filePath, ...args);
    });

    let failure;
    try {
      failure = await service.createArchives(project.id, [source.id], {
        setName: 'Vanish', replaceExistingArchives: true,
      }).catch((err) => err);
    } finally {
      unlinkSpy.mockRestore();
      applySpy.mockRestore();
    }

    expect(vanished).toBe(true);
    expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    // The previous archive is restored as a new owned file with the same bytes, and the row's
    // provenance is reconciled to that restored file.
    expect(fs.readFileSync(jpgPath)).toEqual(previousBytes);
    const restored = fs.lstatSync(jpgPath, { bigint: true });
    expect(restored.ino).not.toBe(replacementIno);
    const restoredRow = generatedArtifactRepository.findByProjectIdAndPath(project.id, 'Vanish_jpg_q80.zip');
    expect(restoredRow.output_provenance).toBe(`v1:${restored.dev}:${restored.ino}:${restored.birthtimeNs}`);
    expect({ ...restoredRow, output_provenance: previousRow.output_provenance }).toEqual(previousRow);
    expect(generatedArtifactRepository.listByProjectId(project.id)).toHaveLength(beforeArtifacts.length);
    // Stage and previous-archive backup are both cleaned after the verified recovery.
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);
    expect(applicationLogger.error).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'processing.recovery.failed',
    }));
  });

  // D2 directory policy: Node cannot bind a directory's identity to its creation (mkdir and
  // mkdtemp return only a pathname), so CreatorCrate never claims or removes a directory.
  // Output directories and the fixed staging workspace are validated, used and retained.
  describe('created directory ownership', () => {
    const workspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
    const workspacePath = () => path.join(projectDir, '.creatorcrate-watermark-staging');

    // Fails the first archive render (after output directories exist and before any
    // publication), running `beforeFailure` at that point.
    function failingRenderService(beforeFailure = () => {}) {
      let failed = false;
      return makeProcessingService({
        sharpImplementation: (...args) => {
          if (failed) return sharp(...args);
          failed = true;
          beforeFailure();
          throw new Error('injected archive render failure');
        },
      });
    }

    // Runs `afterCreate(dirPath)` once, immediately after CreatorCrate's own mkdir of
    // `target` succeeds: the boundary where ownership used to be captured from the pathname.
    function afterOwnMkdir(target, afterCreate) {
      const realMkdir = fs.mkdirSync.bind(fs);
      let fired = false;
      const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, ...args) => {
        const result = realMkdir(dirPath, ...args);
        if (!fired && path.resolve(String(dirPath)) === path.resolve(target)) {
          fired = true;
          afterCreate(path.resolve(target));
        }
        return result;
      });
      return { get fired() { return fired; }, restore: () => spy.mockRestore() };
    }

    // Runs `beforeCreate(dirPath)` once, immediately before CreatorCrate's mkdir of `target`,
    // so that mkdir reports EEXIST for whatever another writer placed there.
    function beforeOwnMkdir(target, beforeCreate) {
      const realMkdir = fs.mkdirSync.bind(fs);
      const attempts = [];
      let fired = false;
      const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, ...args) => {
        attempts.push(path.resolve(String(dirPath)));
        if (!fired && path.resolve(String(dirPath)) === path.resolve(target)) {
          fired = true;
          beforeCreate(path.resolve(target));
        }
        return realMkdir(dirPath, ...args);
      });
      return { attempts, get fired() { return fired; }, restore: () => spy.mockRestore() };
    }

    it('retains every directory component it created and fails with the original error', async () => {
      const source = await writeIndexedImage('Final/created-dirs.png');
      const service = failingRenderService();

      await expect(service.createArchives(project.id, [source.id], {
        setName: 'CreatedDirs', outputDirectory: 'Final/new-parent/new-child',
      })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });

      // Retained, empty, and bounded to the configured output path.
      expect(fs.readdirSync(path.join(projectDir, 'Final', 'new-parent'))).toEqual(['new-child']);
      expect(fs.readdirSync(path.join(projectDir, 'Final', 'new-parent', 'new-child'))).toEqual([]);
      expect(workspaces()).toEqual([]);
    });

    it('reuses one retained, empty staging workspace across successful runs', async () => {
      const source = await writeIndexedImage('Final/bounded-workspace.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'BoundedA' });
      await processingService.createArchives(project.id, [source.id], { setName: 'BoundedB' });

      expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-watermark-')))
        .toEqual(['.creatorcrate-watermark-staging']);
      expect(fs.readdirSync(workspacePath())).toEqual([]);
    });

    // Old: after a successful mkdir the pathname was lstat-ed and whatever directory was then
    // there was recorded as owned, so a foreign directory substituted in that gap was removed.
    it('never claims or removes a foreign output directory substituted right after its mkdir', async () => {
      const source = await writeIndexedImage('Final/post-mkdir-dir.png');
      const outputDir = path.join(projectDir, 'post-mkdir-output');
      let foreignIno;
      const race = afterOwnMkdir(outputDir, (dirPath) => {
        replaceWithForeignDirectory(dirPath);
        foreignIno = fs.statSync(dirPath, { bigint: true }).ino;
      });
      const rmdirSpy = vi.spyOn(fs, 'rmdirSync');

      try {
        await expect(failingRenderService().createArchives(project.id, [source.id], {
          setName: 'PostMkdir', outputDirectory: 'post-mkdir-output',
        })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });
        expect(race.fired).toBe(true);
        expect(rmdirSpy).not.toHaveBeenCalled();
      } finally {
        rmdirSpy.mockRestore();
        race.restore();
      }

      expect(fs.statSync(outputDir, { bigint: true }).ino).toBe(foreignIno);
    });

    // Reviewer scenario: the build fails before publication and the created output directory
    // has meanwhile become a foreign empty directory. Leaving it untouched is harmless
    // residue, not unresolved project state.
    it('keeps a foreign empty output directory and reports the original failure, not recovery', async () => {
      const source = await writeIndexedImage('Final/foreign-dir.png');
      const outputDir = path.join(projectDir, 'foreign-output');
      let foreignIno;
      const service = failingRenderService(() => {
        replaceWithForeignDirectory(outputDir);
        foreignIno = fs.statSync(outputDir, { bigint: true }).ino;
      });

      await expect(service.createArchives(project.id, [source.id], {
        setName: 'ForeignDir', outputDirectory: 'foreign-output',
      })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });

      expect(foreignIno).toBeDefined();
      expect(fs.statSync(outputDir, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readdirSync(outputDir)).toEqual([]);
      expect(workspaces()).toEqual([]);
    });

    it('never records or removes an output directory whose identity is unknown (zero)', async () => {
      const source = await writeIndexedImage('Final/zero-dir.png');
      const outputDir = path.join(projectDir, 'zero-output');
      const ids = mockFileIdentities();
      ids.autoAssign((filePath) => filePath === path.resolve(outputDir), { ino: 0n });
      let foreignRealIno;
      const service = failingRenderService(() => {
        replaceWithForeignDirectory(outputDir);
        ids.assign(outputDir, { ino: 0n });
        foreignRealIno = fs.statSync(outputDir, { bigint: true }).ino;
      });

      try {
        await expect(service.createArchives(project.id, [source.id], {
          setName: 'ZeroDir', outputDirectory: 'zero-output',
        })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });
      } finally {
        ids.restore();
      }

      expect(fs.statSync(outputDir, { bigint: true }).ino).toBe(foreignRealIno);
      expect(workspaces()).toEqual([]);
    });

    it('uses but never claims a directory component another writer created during creation', async () => {
      const source = await writeIndexedImage('Final/race-dir.png');
      const parentDir = path.join(projectDir, 'race-parent');
      const childDir = path.join(parentDir, 'race-child');
      const race = beforeOwnMkdir(parentDir, (dirPath) => fs.mkdirSync(dirPath));

      try {
        await expect(failingRenderService().createArchives(project.id, [source.id], {
          setName: 'RaceDir', outputDirectory: 'race-parent/race-child',
        })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });
      } finally {
        race.restore();
      }

      expect(race.fired).toBe(true);
      expect(fs.readdirSync(parentDir)).toEqual(['race-child']);
      expect(fs.readdirSync(childDir)).toEqual([]);
    });

    // Old: EEXIST was taken to mean "another writer created the directory" and creation
    // continued beneath the component without re-validating what it actually was.
    it('rejects a symlink/junction raced in at the mkdir boundary and never traverses it', async () => {
      const source = await writeIndexedImage('Final/junction-race.png');
      const outside = path.join(tmpDir, 'outside-junction-target');
      fs.mkdirSync(outside);
      const parentDir = path.join(projectDir, 'junction-parent');
      const childDir = path.join(parentDir, 'junction-child');
      const race = beforeOwnMkdir(parentDir, (dirPath) => fs.symlinkSync(outside, dirPath, 'junction'));

      try {
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'JunctionRace', outputDirectory: 'junction-parent/junction-child',
        })).rejects.toMatchObject({ code: 'OUTPUT_PATH_UNSAFE' });
      } finally {
        race.restore();
      }

      expect(race.fired).toBe(true);
      expect(race.attempts).not.toContain(path.resolve(childDir));
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.lstatSync(parentDir).isSymbolicLink()).toBe(true);
      fs.unlinkSync(parentDir);
    });

    it('rejects a regular file raced in at the mkdir boundary and never traverses it', async () => {
      const source = await writeIndexedImage('Final/file-race.png');
      const parentDir = path.join(projectDir, 'file-parent');
      const childDir = path.join(parentDir, 'file-child');
      const race = beforeOwnMkdir(parentDir, (dirPath) => fs.writeFileSync(dirPath, 'not a directory'));

      try {
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'FileRace', outputDirectory: 'file-parent/file-child',
        })).rejects.toMatchObject({ code: 'OUTPUT_PATH_UNSAFE' });
      } finally {
        race.restore();
      }

      expect(race.fired).toBe(true);
      expect(race.attempts).not.toContain(path.resolve(childDir));
      expect(fs.readFileSync(parentDir, 'utf8')).toBe('not a directory');
    });

    // The destination's ancestors are re-validated with the established containment helper
    // immediately before publication, so an ancestor swapped after creation is refused.
    it('refuses publication when an output ancestor became a junction after creation', async () => {
      const source = await writeIndexedImage('Final/containment.png');
      const outside = path.join(tmpDir, 'outside-publication-target');
      fs.mkdirSync(outside);
      const outputDir = path.join(projectDir, 'contained-output');
      let swapped = false;
      const service = makeProcessingService({
        sharpImplementation: (...args) => {
          if (!swapped) {
            swapped = true;
            fs.rmdirSync(outputDir);
            fs.symlinkSync(outside, outputDir, 'junction');
          }
          return sharp(...args);
        },
      });

      try {
        await expect(service.createArchives(project.id, [source.id], {
          setName: 'Contained', outputDirectory: 'contained-output',
        })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_UNSAFE' });
      } finally {
        if (fs.lstatSync(outputDir).isSymbolicLink()) fs.unlinkSync(outputDir);
      }

      expect(swapped).toBe(true);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(generatedArtifactRepository.findByProjectIdAndPath(project.id, 'contained-output/Contained_jpg_q80.zip'))
        .toBeFalsy();
      expect(workspaces()).toEqual([]);
    });

    // Old: mkdtemp's pathname was lstat-ed afterwards and that directory was claimed, so a
    // foreign workspace substituted in the gap was removed by cleanup.
    it('never claims or removes a foreign directory substituted for its staging workspace', async () => {
      const source = await writeIndexedImage('Final/workspace-dir.png');
      let foreignIno;
      const race = afterOwnMkdir(workspacePath(), (dirPath) => {
        replaceWithForeignDirectory(dirPath);
        foreignIno = fs.statSync(dirPath, { bigint: true }).ino;
      });

      try {
        await expect(failingRenderService().createArchives(project.id, [source.id], {
          setName: 'WorkspaceDir',
        })).rejects.toMatchObject({ code: 'ARCHIVE_BUILD_FAILED' });
      } finally {
        race.restore();
      }

      expect(race.fired).toBe(true);
      expect(fs.statSync(workspacePath(), { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readdirSync(workspacePath())).toEqual([]);
    });
  });

  // D2: the archive stage's owned identity comes from the descriptor CreatorCrate opened
  // exclusively, never from whatever the pathname holds after the write closes.
  describe('archive stage provenance', () => {
    it('never claims or removes a foreign file that replaced the stage after its descriptor closed', async () => {
      const source = await writeIndexedImage('Final/stage-replaced.png');
      const foreign = Buffer.from('foreign replacement of the archive stage');
      const race = replaceStageAfterClose(
        (filePath) => filePath.includes('.creatorcrate-watermark-') && filePath.endsWith('archive-0.zip'),
        (stagePath) => replaceWithForeignFile(stagePath, foreign),
      );
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], { setName: 'StageRace' })
          .then(() => null, (err) => err);
        expect(race.path).toBeDefined();
        expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(filePath) === race.path)).toEqual([]);
      } finally {
        unlinkSpy.mockRestore();
        race.restore();
      }

      // The foreign file stays in the private workspace, so cleanup cannot complete; but no
      // public or database state ever depended on it, so it is safe residue: the original
      // failure is reported, never RECOVERY_REQUIRED.
      expect(failure).toMatchObject({
        code: 'ARCHIVE_BUILD_FAILED',
        cause: { code: 'FILESYSTEM_OPERATION_FAILED' },
        recoveryDiagnostics: { restored: true, cleanupSucceeded: false },
      });
      expect(failure.recoveryDiagnostics.failures).toEqual([expect.objectContaining({
        artifactRole: 'archive-stage', check: 'cleanup-identity-mismatch', cleanup: 'residue',
      })]);
      expect(fs.readFileSync(race.path)).toEqual(foreign);
      expect(fs.existsSync(path.join(projectDir, 'StageRace_jpg_q80.zip'))).toBe(false);
      expect(generatedArtifactRepository.findByProjectIdAndPath(project.id, 'StageRace_jpg_q80.zip')).toBeFalsy();
    });
  });

  describe('exact archive ownership past 2^53', () => {
    // Exact IDs 2^53 + 4 and 2^53 + 5 are distinct files whose Number views are equal.
    const trustedIno = 9007199254740996n;
    const foreignIno = 9007199254740997n;
    // Distinct exact IDs past 2^53 for every archive role; each has a Number-colliding neighbor.
    const BIG = Object.freeze({
      stage: 9007199254741000n,
      public: 9007199254741004n,
      backup: 9007199254741008n,
      restored: 9007199254741012n,
    });
    const archiveWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
    const replaceWithForeign = (ids, target, bytes, ino = foreignIno) => {
      fs.rmSync(target);
      fs.writeFileSync(target, bytes);
      ids.assign(target, ino);
      return fs.statSync(target, { bigint: true }).ino;
    };
    const realLstat = fs.lstatSync.bind(fs);
    // Tags the first file observed at `target` that is not the object currently there.
    const tagNextAt = (ids, target, ino) => {
      let current = null;
      try { current = realLstat(target, { bigint: true }).ino; } catch { /* absent */ }
      ids.autoAssign((filePath) => path.resolve(filePath) === target
        && realLstat(filePath, { bigint: true }).ino !== current, ino);
    };

    it('replaces an owned public archive whose exact file ID is past 2^53', async () => {
      expect(Number(trustedIno)).toBe(Number(foreignIno));
      const source = await writeIndexedImage('Final/large-id-archive.png');
      const jpgPath = path.resolve(projectDir, 'LargeId_jpg_q80.zip');
      const ids = mockExactFileIds();
      tagNextAt(ids, jpgPath, trustedIno);
      try {
        await processingService.createArchives(project.id, [source.id], { setName: 'LargeId' });
        // Provenance persists the public archive's exact bigint ID, not its rounded Number view.
        expect(generatedArtifactRepository.findByProjectIdAndPath(project.id, 'LargeId_jpg_q80.zip')
          .output_provenance).toContain(`:${trustedIno}:`);
        await processingService.createArchives(project.id, [source.id], {
          setName: 'LargeId', replaceExistingArchives: true,
        });
      } finally {
        ids.restore();
      }

      expect(fs.existsSync(jpgPath)).toBe(true);
      expect(archiveWorkspaces()).toEqual([]);
    });

    // Old: Number dev/ino equality accepted the swapped destination, moved it into the
    // backup, and successful cleanup then unlinked that backup.
    it('never replaces a foreign archive destination that only collides after Number rounding', async () => {
      const source = await writeIndexedImage('Final/rounded-archive.png');
      const jpgPath = path.resolve(projectDir, 'Rounded_jpg_q80.zip');
      const ids = mockExactFileIds();
      tagNextAt(ids, jpgPath, trustedIno);
      try {
        await processingService.createArchives(project.id, [source.id], { setName: 'Rounded' });
      } catch (err) {
        ids.restore();
        throw err;
      }
      const ownedBytes = fs.readFileSync(jpgPath);
      let foreignRealIno;
      const racedService = makeProcessingService({
        sharpImplementation: (...args) => {
          if (!foreignRealIno) {
            // Same bytes, so the artifact hash still matches: only exact identity differs.
            foreignRealIno = replaceWithForeign(ids, jpgPath, ownedBytes);
            expect(fs.lstatSync(jpgPath).ino).toBe(Number(trustedIno));
          }
          return sharp(...args);
        },
      });
      try {
        await expect(racedService.createArchives(project.id, [source.id], {
          setName: 'Rounded', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
      } finally {
        ids.restore();
      }

      expect(foreignRealIno).toBeDefined();
      expect(fs.statSync(jpgPath, { bigint: true }).ino).toBe(foreignRealIno);
      expect(fs.readFileSync(jpgPath)).toEqual(ownedBytes);
      expect(archiveWorkspaces()).toEqual([]);
    });

    it('restores with distinct exact IDs past 2^53 for stage, public archive, backup and restore', async () => {
      const source = await writeIndexedImage('Final/large-id-restore.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'LargeRestore' });
      const jpgPath = path.resolve(projectDir, 'LargeRestore_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const ids = mockFileIdentities();
      ids.autoAssign((filePath) => filePath.includes('.creatorcrate-watermark-')
        && filePath.endsWith('archive-0.zip'), { ino: BIG.stage });
      ids.autoAssign((filePath) => filePath.includes('.creatorcrate-watermark-')
        && filePath.endsWith('archive-0.destination'), { ino: BIG.backup });
      let rollingBack = false;
      tagNextAt(ids, jpgPath, { ino: BIG.public });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(BIG.public);
        rollingBack = true;
        tagNextAt(ids, jpgPath, { ino: BIG.restored, birthtimeNs: 1700000000123456789n });
        throw new Error('injected archive database failure');
      });
      let restored;
      try {
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'LargeRestore', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        restored = fs.lstatSync(jpgPath, { bigint: true });
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      expect(rollingBack).toBe(true);
      expect(restored.ino).toBe(BIG.restored);
      expect(fs.readFileSync(jpgPath)).toEqual(before);
      // The restored archive's own exact bigint tuple is reconciled, never a rounded view.
      expect(generatedArtifactRepository.findByProjectIdAndPath(project.id, 'LargeRestore_jpg_q80.zip')
        .output_provenance).toBe(`v1:${restored.dev}:${BIG.restored}:1700000000123456789`);
      expect(archiveWorkspaces()).toEqual([]);
    });

    // Old: restoreArchiveArtifacts unlinked whatever matched the published archive's rounded
    // Number identity before restoring the backup over it.
    it('never unlinks a foreign archive that only collides after Number rounding during restore', async () => {
      const source = await writeIndexedImage('Final/rounded-restore.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'RoundedRestore' });
      const jpgPath = path.resolve(projectDir, 'RoundedRestore_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeRow = generatedArtifactRepository.findByProjectIdAndPath(project.id, 'RoundedRestore_jpg_q80.zip');
      const foreign = Buffer.from('foreign archive destination');
      const ids = mockExactFileIds();
      tagNextAt(ids, jpgPath, BIG.public);
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(BIG.public);
        replaceWithForeign(ids, jpgPath, foreign, BIG.public + 1n);
        expect(fs.lstatSync(jpgPath).ino).toBe(Number(BIG.public));
        throw new Error('injected archive database failure');
      });
      try {
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'RoundedRestore', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        applySpy.mockRestore();
        ids.restore();
      }

      // The Number-colliding foreign neighbor survives; the backup of the previous archive and
      // the unresolved publication's stage stay as evidence; the row is not reconciled.
      expect(fs.readFileSync(jpgPath)).toEqual(foreign);
      const [workspace, ...others] = archiveWorkspaces();
      expect(others).toEqual([]);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.destination'))).toEqual(before);
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.zip'))).toBe(true);
      expect(generatedArtifactRepository.findByProjectIdAndPath(project.id, 'RoundedRestore_jpg_q80.zip'))
        .toEqual(beforeRow);
    });
  });

  describe('cross-run archive provenance', () => {
    const workspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
    const artifactAt = (relativePath) => generatedArtifactRepository
      .findByProjectIdAndPath(project.id, relativePath);

    // Old: preflight trusted the artifact row plus a matching hash and captured the
    // current (foreign) file's exact identity as owned, so replacement unlinked it.
    it('never replaces a same-bytes foreign archive from a later run despite a matching hash', async () => {
      const source = await writeIndexedImage('Final/cross-run.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'CrossRun' });
      const jpgPath = path.join(projectDir, 'CrossRun_jpg_q80.zip');
      const row = artifactAt('CrossRun_jpg_q80.zip');
      expect(row.output_provenance).toMatch(/^v1:\d+:[1-9]\d*:\d+$/);

      const bytes = fs.readFileSync(jpgPath);
      fs.unlinkSync(jpgPath);
      fs.writeFileSync(jpgPath, bytes);
      const foreignIno = fs.statSync(jpgPath, { bigint: true }).ino;
      expect(sha256(fs.readFileSync(jpgPath))).toBe(row.sha256);

      await expect(processingService.createArchives(project.id, [source.id], {
        setName: 'CrossRun', replaceExistingArchives: true,
      })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });

      expect(fs.statSync(jpgPath, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readFileSync(jpgPath)).toEqual(bytes);
      expect(artifactAt('CrossRun_jpg_q80.zip')).toEqual(row);
      expect(workspaces()).toEqual([]);
    });

    it('replaces an unchanged archive across runs and records the new provenance', async () => {
      const source = await writeIndexedImage('Final/cross-run-owned.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'Owned' });
      const jpgPath = path.join(projectDir, 'Owned_jpg_q80.zip');
      const firstIno = fs.statSync(jpgPath, { bigint: true }).ino;
      const first = artifactAt('Owned_jpg_q80.zip').output_provenance;

      await processingService.createArchives(project.id, [source.id], {
        setName: 'Owned', replaceExistingArchives: true,
      });
      const second = artifactAt('Owned_jpg_q80.zip').output_provenance;
      const current = fs.statSync(jpgPath, { bigint: true });
      expect(current.ino).not.toBe(firstIno);
      expect(second).not.toBe(first);
      expect(second).toBe(`v1:${current.dev}:${current.ino}:${current.birthtimeNs}`);

      // The rotated provenance authorizes the next replacement too.
      await processingService.createArchives(project.id, [source.id], {
        setName: 'Owned', replaceExistingArchives: true,
      });
      expect(workspaces()).toEqual([]);
    });

    it('treats a legacy artifact row without provenance as not owned', async () => {
      const source = await writeIndexedImage('Final/legacy.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'Legacy' });
      const jpgPath = path.join(projectDir, 'Legacy_jpg_q80.zip');
      const ino = fs.statSync(jpgPath, { bigint: true }).ino;
      db.prepare('UPDATE generated_artifacts SET output_provenance = NULL WHERE project_id = ?').run(project.id);

      await expect(processingService.createArchives(project.id, [source.id], {
        setName: 'Legacy', replaceExistingArchives: true,
      })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
      expect(fs.statSync(jpgPath, { bigint: true }).ino).toBe(ino);
      expect(workspaces()).toEqual([]);
    });

    const parseProvenance = (value) => {
      const [, dev, ino, birthtimeNs] = value.split(':');
      return { dev: BigInt(dev), ino: BigInt(ino), birthtimeNs: BigInt(birthtimeNs) };
    };
    const provenanceOf = ({ dev, ino, birthtimeNs }) => `v1:${dev}:${ino}:${birthtimeNs}`;
    const isPublicArchive = (filePath) => (candidate) => candidate === path.resolve(filePath);
    // Runs `onCreate` once, immediately before CreatorCrate exclusively creates `target`: a
    // point after every earlier archive was published and verified.
    const beforeCreating = (target, onCreate) => hookOwnedCreate(isPublicArchive(target), {
      before: onCreate, times: 1,
    });

    // Old: preflight matched the full persisted tuple but carried only {dev, ino} forward, so
    // a foreign archive reusing that exact dev/ino (other birth time) was backed up and unlinked.
    it('never replaces an archive that reuses the owned exact dev/ino with another birth time', async () => {
      const source = await writeIndexedImage('Final/reused-inode.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'Reused' });
      const jpgPath = path.resolve(projectDir, 'Reused_jpg_q80.zip');
      const provenance = artifactAt('Reused_jpg_q80.zip').output_provenance;
      const owned = parseProvenance(provenance);
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      const bytes = fs.readFileSync(jpgPath);
      const ids = mockFileIdentities();
      let foreignIno;
      let observedForeign;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      // Preflight has already accepted the owned archive; the swap lands before the
      // destructive backup/unlink boundary and reuses the exact owned dev/ino.
      const racedService = makeProcessingService({
        sharpImplementation: (...args) => {
          if (!foreignIno) {
            fs.unlinkSync(jpgPath);
            fs.writeFileSync(jpgPath, bytes);
            foreignIno = fs.statSync(jpgPath, { bigint: true }).ino;
            ids.assign(jpgPath, { ino: owned.ino, birthtimeNs: owned.birthtimeNs + 1n });
            observedForeign = fs.lstatSync(jpgPath, { bigint: true });
            unlinkSpy.mockClear(); // only CreatorCrate's own unlinks from here on
          }
          return sharp(...args);
        },
      });

      try {
        await expect(racedService.createArchives(project.id, [source.id], {
          setName: 'Reused', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(jpgPath);
      } finally {
        unlinkSpy.mockRestore();
        ids.restore();
      }

      // The foreign archive matched the exact persisted dev/ino; only the birth time differed.
      expect(observedForeign.dev).toBe(owned.dev);
      expect(observedForeign.ino).toBe(owned.ino);
      expect(observedForeign.birthtimeNs).not.toBe(owned.birthtimeNs);
      expect(fs.statSync(jpgPath, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readFileSync(jpgPath)).toEqual(bytes);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
      expect(workspaces()).toEqual([]);
    });

    // Old: after strict publication proof, an archive swapped before the index commit was
    // committed as success with null provenance, recording a hash for a file CreatorCrate no
    // longer published. The final pre-commit validation must now refuse to commit.
    it('never commits an archive whose destination was swapped after publication proof', async () => {
      const source = await writeIndexedImage('Final/publication-swap.png');
      const jpgPath = path.resolve(projectDir, 'Swap_jpg_q80.zip');
      const webpPath = path.resolve(projectDir, 'Swap_webp_q90.zip');
      let foreignIno;
      let publishedBytes;
      // The JPG archive is already published and verified; the swap lands during later work.
      const hook = beforeCreating(webpPath, () => {
        publishedBytes = fs.readFileSync(jpgPath);
        foreignIno = replaceWithSameBytes(jpgPath);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');

      try {
        await expect(processingService.createArchives(project.id, [source.id], { setName: 'Swap' }))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(applySpy).not.toHaveBeenCalled();
      } finally {
        applySpy.mockRestore();
        hook.restore();
      }

      // The same-bytes foreign archive is untouched; the owned WebP archive is rolled back.
      expect(fs.statSync(jpgPath, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readFileSync(jpgPath)).toEqual(publishedBytes);
      expect(fs.existsSync(webpPath)).toBe(false);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      const evidence = createProcessingRecoveryEvidenceRepository(db);
      expect(evidence.listMutationGroupsByProject(project.id)).toEqual([
        expect.objectContaining({ operation: 'archive', checkpoint: 'public-create', itemKey: `archive-jpg:${sha256('Swap_jpg_q80.zip')}` }),
      ]);
      expect(evidence.listUnresolvedEvidenceByProject(project.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'published-archive', observation: 'replaced', lifecycle: 'recovery-critical' }),
        expect.objectContaining({ artifactRole: 'archive-stage', lifecycle: 'recovery-critical' }),
      ]));
      // The JPG archive's stage is kept as recovery evidence.
      const [workspace, ...others] = workspaces();
      expect(others).toEqual([]);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.zip'))).toEqual(publishedBytes);
    });

    it('restores an owned previous archive when a replacement was swapped after publication proof', async () => {
      const source = await writeIndexedImage('Final/replacement-swap.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'ReplaceSwap' });
      const jpgPath = path.resolve(projectDir, 'ReplaceSwap_jpg_q80.zip');
      const webpPath = path.resolve(projectDir, 'ReplaceSwap_webp_q90.zip');
      const previous = fs.readFileSync(jpgPath);
      const beforeJpgRow = artifactAt('ReplaceSwap_jpg_q80.zip');
      const foreign = Buffer.from('foreign archive after publication proof');
      let swapped = false;
      const hook = beforeCreating(webpPath, () => {
        swapped = true;
        fs.rmSync(jpgPath);
        fs.writeFileSync(jpgPath, foreign);
      });
      try {
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'ReplaceSwap', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        hook.restore();
      }

      // The foreign path is never overwritten; stage and previous-archive backup remain, and
      // the unrestored archive's row is untouched. The WebP archive was restored as a new
      // owned file and only its provenance was reconciled to that file.
      expect(swapped).toBe(true);
      expect(fs.readFileSync(jpgPath)).toEqual(foreign);
      expect(artifactAt('ReplaceSwap_jpg_q80.zip')).toEqual(beforeJpgRow);
      expect(artifactAt('ReplaceSwap_webp_q90.zip').output_provenance).toBe(provenanceTupleOf(webpPath));
      const [workspace, ...others] = workspaces();
      expect(others).toEqual([]);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.destination'))).toEqual(previous);
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.zip'))).toBe(true);
    });

    it('fails ordinarily after a verified rollback when owned archive bytes changed before commit', async () => {
      const source = await writeIndexedImage('Final/changed-archive.png');
      const jpgPath = path.resolve(projectDir, 'Changed_jpg_q80.zip');
      const webpPath = path.resolve(projectDir, 'Changed_webp_q90.zip');
      let ownedIno;
      let rewrittenIno;
      const hook = beforeCreating(webpPath, () => {
        ownedIno = fs.statSync(jpgPath, { bigint: true }).ino;
        // Same inode (still the owned public archive), different bytes.
        rewriteInPlace(jpgPath, Buffer.from('rewritten in place'));
        rewrittenIno = fs.statSync(jpgPath, { bigint: true }).ino;
      });
      try {
        await expect(processingService.createArchives(project.id, [source.id], { setName: 'Changed' }))
          .rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
      } finally {
        hook.restore();
      }

      expect(rewrittenIno).toBe(ownedIno);
      expect(fs.existsSync(jpgPath)).toBe(false);
      expect(fs.existsSync(webpPath)).toBe(false);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(workspaces()).toEqual([]);
    });

    it('never lets a legacy zero-birth-time provenance authorize archive replacement', async () => {
      const source = await writeIndexedImage('Final/zero-birth-row.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'ZeroRow' });
      const jpgPath = path.resolve(projectDir, 'ZeroRow_jpg_q80.zip');
      const current = fs.lstatSync(jpgPath, { bigint: true });
      const legacy = `v1:${current.dev}:${current.ino}:0`;
      db.prepare('UPDATE generated_artifacts SET output_provenance = ? WHERE project_id = ? AND relative_path = ?')
        .run(legacy, project.id, 'ZeroRow_jpg_q80.zip');
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      const ids = mockFileIdentities();
      // The current object matches the row's exact dev/ino, zero birth time and hash.
      ids.assign(jpgPath, { birthtimeNs: 0n });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      try {
        const observed = fs.lstatSync(jpgPath, { bigint: true });
        expect(`v1:${observed.dev}:${observed.ino}:${observed.birthtimeNs}`).toBe(legacy);
        expect(sha256(fs.readFileSync(jpgPath))).toBe(artifactAt('ZeroRow_jpg_q80.zip').sha256);
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'ZeroRow', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
        expect(unlinkSpy).not.toHaveBeenCalled();
      } finally {
        unlinkSpy.mockRestore();
        ids.restore();
      }

      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(current.ino);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
      expect(workspaces()).toEqual([]);
    });

    // Publishes on a modeled filesystem, then shows the later replacement is refused.
    async function expectVerifiedArchiveWithoutProvenance(setName, birthtimeNs, service = processingService) {
      const source = await writeIndexedImage(`Final/${setName}.png`);
      const relativePath = `${setName}_jpg_q80.zip`;
      const jpgPath = path.resolve(projectDir, relativePath);
      const ids = mockFileIdentities();
      ids.autoAssign(isPublicArchive(jpgPath), { birthtimeNs });
      try {
        await service.createArchives(project.id, [source.id], { setName });
        const row = artifactAt(relativePath);
        expect(row.sha256).toBe(sha256(fs.readFileSync(jpgPath)));
        expect(row.output_provenance).toBeNull();
        expect(workspaces()).toEqual([]);

        const ino = fs.lstatSync(jpgPath, { bigint: true }).ino;
        await expect(service.createArchives(project.id, [source.id], {
          setName, replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
        expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(ino);
        expect(artifactAt(relativePath)).toEqual(row);
      } finally {
        ids.restore();
      }
      expect(workspaces()).toEqual([]);
    }

    it('publishes an archive on a zero-birth-time filesystem without durable provenance', async () => {
      await expectVerifiedArchiveWithoutProvenance('ZeroFs', 0n);
    });

    it('persists no archive provenance where birth time may mirror an unchanged ctime', async () => {
      const linuxService = makeProcessingService({ platform: 'linux' });
      await expectVerifiedArchiveWithoutProvenance('CtimeBirth', (stats) => stats.ctimeNs, linuxService);
    });

    // The stage is content input only: a durable stage birth time never becomes the public
    // archive's provenance.
    it('never derives archive provenance from its stage', async () => {
      const source = await writeIndexedImage('Final/stage-birth.png');
      const jpgPath = path.resolve(projectDir, 'StageBirth_jpg_q80.zip');
      const ids = mockFileIdentities();
      ids.autoAssign((filePath) => filePath.includes('.creatorcrate-watermark-')
        && filePath.endsWith('archive-0.zip'), { birthtimeNs: 1700000000000000077n });
      ids.autoAssign(isPublicArchive(jpgPath), { birthtimeNs: 0n });
      try {
        await processingService.createArchives(project.id, [source.id], { setName: 'StageBirth' });
      } finally {
        ids.restore();
      }
      expect(artifactAt('StageBirth_jpg_q80.zip').output_provenance).toBeNull();
      expect(workspaces()).toEqual([]);
    });

    it('persists the public archive descriptor tuple exactly, past 2^53, and replaces it later', async () => {
      const source = await writeIndexedImage('Final/large-tuple.png');
      const jpgPath = path.resolve(projectDir, 'LargeTuple_jpg_q80.zip');
      // Exact values beyond Number.MAX_SAFE_INTEGER; their Number views round.
      const bigTuple = { dev: 9007199254740995n, ino: 9007199254740997n, birthtimeNs: 1700000000123456789n };
      expect(Number(bigTuple.ino)).toBe(Number(bigTuple.ino - 1n));
      const ids = mockFileIdentities();
      ids.autoAssign(isPublicArchive(jpgPath), bigTuple);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      try {
        await processingService.createArchives(project.id, [source.id], { setName: 'LargeTuple' });
        expect(artifactAt('LargeTuple_jpg_q80.zip').output_provenance).toBe(provenanceOf(bigTuple));

        // The unchanged owned archive is backed up, unlinked and replaced under the full tuple.
        unlinkSpy.mockClear();
        await processingService.createArchives(project.id, [source.id], {
          setName: 'LargeTuple', replaceExistingArchives: true,
        });
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).toContain(jpgPath);
        expect(artifactAt('LargeTuple_jpg_q80.zip').output_provenance)
          .toBe(provenanceOf(fs.lstatSync(jpgPath, { bigint: true })));
      } finally {
        unlinkSpy.mockRestore();
        ids.restore();
      }
      expect(workspaces()).toEqual([]);
    });
  });

  describe('archive publication failure after descriptor create', () => {
    const workspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-watermark-');

    // Fails CreatorCrate's first exclusive creation of the public archive `target` right after
    // its descriptor closed (its bytes are written and it is owned), optionally mutating the
    // destination first.
    function failPublicationAfterCreate(target, { beforeFailure } = {}) {
      return hookOwnedCreate((filePath) => filePath === target, {
        times: 1,
        after() {
          beforeFailure?.();
          throw Object.assign(new Error('injected archive publication failure'), { code: 'EIO' });
        },
      });
    }

    it('removes a newly published archive and fails ordinarily after a verified rollback', async () => {
      const source = await writeIndexedImage('Final/read-failure.png');
      const jpgPath = path.resolve(projectDir, 'ReadFailure_jpg_q80.zip');
      const injected = failPublicationAfterCreate(jpgPath);
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], { setName: 'ReadFailure' })
          .catch((err) => err);
      } finally {
        injected.restore();
      }

      expect(injected.calls).toBe(1);
      expect(failure).toMatchObject({ name: 'AssetProcessingError', code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(fs.existsSync(jpgPath)).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'ReadFailure_webp_q90.zip'))).toBe(false);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(workspaces()).toEqual([]);
    });

    it('restores the owned previous archive after a publication failure during replacement', async () => {
      const source = await writeIndexedImage('Final/read-failure-replace.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'ReadReplace' });
      const jpgPath = path.resolve(projectDir, 'ReadReplace_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeRow = generatedArtifactRepository.findByProjectIdAndPath(project.id, 'ReadReplace_jpg_q80.zip');
      const injected = failPublicationAfterCreate(jpgPath);
      try {
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'ReadReplace', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      } finally {
        injected.restore();
      }

      expect(injected.calls).toBe(1);
      // The previous archive returns as a new owned file; its row names that restored file.
      expect(fs.readFileSync(jpgPath)).toEqual(before);
      const restoredRow = generatedArtifactRepository.findByProjectIdAndPath(project.id, 'ReadReplace_jpg_q80.zip');
      expect(restoredRow.output_provenance).toBe(provenanceTupleOf(jpgPath));
      expect({ ...restoredRow, output_provenance: beforeRow.output_provenance }).toEqual(beforeRow);
      expect(workspaces()).toEqual([]);

      // The restored previous archive remains replaceable under its reconciled provenance.
      await processingService.createArchives(project.id, [source.id], {
        setName: 'ReadReplace', replaceExistingArchives: true,
      });
      expect(workspaces()).toEqual([]);
    });

    it('requires recovery and keeps stage and backup when the published archive was swapped', async () => {
      const source = await writeIndexedImage('Final/read-failure-swap.png');
      await processingService.createArchives(project.id, [source.id], { setName: 'ReadSwap' });
      const jpgPath = path.resolve(projectDir, 'ReadSwap_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      const foreign = Buffer.from('foreign archive after publication');
      let stagedBytes;
      const injected = failPublicationAfterCreate(jpgPath, {
        beforeFailure() {
          stagedBytes = fs.readFileSync(jpgPath);
          fs.rmSync(jpgPath);
          fs.writeFileSync(jpgPath, foreign);
        },
      });
      try {
        await expect(processingService.createArchives(project.id, [source.id], {
          setName: 'ReadSwap', replaceExistingArchives: true,
        })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        injected.restore();
      }

      expect(fs.readFileSync(jpgPath)).toEqual(foreign);
      const [workspace, ...others] = workspaces();
      expect(others).toEqual([]);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.zip'))).toEqual(stagedBytes);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.destination'))).toEqual(before);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
    });
  });

  // WP4: archive publication, backup, restore and cleanup are descriptor-owned. Ownership
  // comes only from CreatorCrate's exclusive descriptor; bytes are content evidence only.
  describe('SMB-compatible descriptor-owned archives', () => {
    const workspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
    const workspacePath = () => path.join(projectDir, '.creatorcrate-watermark-staging');
    const inStaging = (suffix) => (filePath) => filePath.includes('.creatorcrate-watermark-')
      && filePath.endsWith(suffix);
    const archiveAt = (name) => path.resolve(projectDir, name);
    const rowAt = (name) => generatedArtifactRepository.findByProjectIdAndPath(project.id, name);
    const withLogger = () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = makeProcessingService({ applicationLogger });
      return applicationLogger;
    };
    const loggedEvents = (logger, level) => logger[level].mock.calls.map(([entry]) => entry.event);
    const failures = (err) => err.recoveryDiagnostics?.failures ?? [];
    const realLstat = fs.lstatSync.bind(fs);
    // Tags the first file observed at `target` that is not the object currently there.
    const tagNextAt = (ids, target, fields) => {
      let current = null;
      try { current = realLstat(target, { bigint: true }).ino; } catch { /* absent */ }
      ids.autoAssign((filePath) => path.resolve(filePath) === target
        && realLstat(filePath, { bigint: true }).ino !== current, fields);
    };
    // A replacement run whose index transaction fails; `onFailure` runs just before it throws.
    const failIndexAfter = (onFailure = () => {}) => {
      const state = { rollingBack: false };
      const spy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        onFailure();
        state.rollingBack = true;
        throw new Error('injected archive database failure');
      });
      return { state, restore: () => spy.mockRestore() };
    };
    async function publishOnce(setName, source, extra = {}) {
      await processingService.createArchives(project.id, [source.id], { setName, ...extra });
    }

    // Live SMB shape: every path reports its own inode, so the stage, the public archive, its
    // backup and a restored archive never alias. No boundary may need a hard link.
    it('publishes, restores and replaces archives and a CBZ on the SMB identity shape without hard links', async () => {
      const source = await writeIndexedImage('Final/smb-archive.png');
      const jpgPath = archiveAt('Smb_jpg_q80.zip');
      const cbzPath = archiveAt('Smb_jpg_q85.cbz');
      const linkSpy = refuseHardLinks();
      const ids = mockFileIdentities();
      ids.autoAssign(inStaging('archive-0.zip'), { dev: 77n, ino: 1855472n });
      ids.autoAssign((filePath) => filePath === jpgPath, {
        dev: 77n, ino: 1855493n, birthtimeNs: 1700000000000000093n,
      });
      try {
        await publishOnce('Smb', source, { makeCbz: true });
        expect(rowAt('Smb_jpg_q80.zip').output_provenance).toBe('v1:77:1855493:1700000000000000093');
        expect(rowAt('Smb_jpg_q85.cbz').output_provenance).toBe(provenanceTupleOf(cbzPath));
        expect(workspaces()).toEqual([]);

        const previous = [jpgPath, cbzPath].map((filePath) => fs.readFileSync(filePath));
        const index = failIndexAfter();
        try {
          await expect(processingService.createArchives(project.id, [source.id], {
            setName: 'Smb', makeCbz: true, replaceExistingArchives: true,
          })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        } finally {
          index.restore();
        }
        expect([jpgPath, cbzPath].map((filePath) => fs.readFileSync(filePath))).toEqual(previous);
        expect(fs.lstatSync(jpgPath, { bigint: true }).ino).not.toBe(1855493n);
        for (const name of ['Smb_jpg_q80.zip', 'Smb_webp_q90.zip', 'Smb_jpg_q85.cbz']) {
          expect(rowAt(name).output_provenance).toBe(provenanceTupleOf(archiveAt(name)));
        }
        expect(workspaces()).toEqual([]);

        await processingService.createArchives(project.id, [source.id], {
          setName: 'Smb', makeCbz: true, replaceExistingArchives: true,
        });
        expect(rowAt('Smb_jpg_q85.cbz').output_provenance).toBe(provenanceTupleOf(cbzPath));
        expect(workspaces()).toEqual([]);
        expect(linkSpy).not.toHaveBeenCalled();
      } finally {
        ids.restore();
        linkSpy.mockRestore();
      }
    });

    // The stage is content input only. A foreign file that reports the stage's exact identity
    // at the public path is still not the public archive CreatorCrate created.
    it('never removes a public archive that only matches its stage identity at rollback', async () => {
      const source = await writeIndexedImage('Final/stage-identity.png');
      const jpgPath = archiveAt('StageId_jpg_q80.zip');
      const foreign = Buffer.from('foreign file carrying the stage identity');
      const ids = mockFileIdentities();
      const index = failIndexAfter(() => {
        const stage = fs.lstatSync(stageArtifact(workspacePath(), 'archive-0.zip'), { bigint: true });
        fs.rmSync(jpgPath);
        fs.writeFileSync(jpgPath, foreign);
        ids.assign(jpgPath, { dev: stage.dev, ino: stage.ino });
      });
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], { setName: 'StageId' })
          .catch((err) => err);
      } finally {
        index.restore();
        ids.restore();
      }

      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.readFileSync(jpgPath)).toEqual(foreign);
      expect(fs.existsSync(archiveAt('StageId_webp_q90.zip'))).toBe(false);
      expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
        artifactRole: 'published-archive', check: 'rollback-identity-mismatch', publicationMode: 'descriptor-owned',
      })]));
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
    });

    // Real SMB regression (live WP4, project 36, CBZ): after the public CBZ's descriptor closes,
    // its pathname reports later mtime/ctime (T2) with the same identity, size and birth time;
    // the pre-commit hash's own open settles them back to the descriptor's values (T1). The
    // bytes are exactly the expected ones, so the archive is recorded, with the post-hash T1
    // fingerprint as the baseline its final sweep holds against.
    it('records a CBZ whose SMB write times settle back to the descriptor values during its hash', async () => {
      const source = await writeIndexedImage('Final/smb-settle.png');
      const cbzPath = archiveAt('SmbSettle_jpg_q85.cbz');
      const smb = modelSmbTimeSettling((filePath) => filePath === cbzPath);
      const records = [];
      processingService = makeProcessingService({
        applicationLogger: createApplicationLogger({
          repository: { insert: (record) => records.push(record), prune: () => {} },
        }),
      });
      let result;
      try {
        result = await processingService.createArchives(project.id, [source.id], { setName: 'SmbSettle', makeCbz: true });
      } finally {
        smb.restore();
      }

      // The live sequence happened: T2 (= T1 + step) observed before the hash, T1 after it.
      expect(smb.refreshed).toBe(true);
      const { observed } = smb;
      const settled = observed.at(-1);
      const postClose = settled + smb.postCloseStepNs;
      expect(observed).toContain(postClose);
      expect(observed.lastIndexOf(postClose)).toBeLessThan(observed.indexOf(settled));
      // Every stat after the settling (post-hash, re-hash bracket, final sweep) reports T1.
      expect(observed.slice(observed.indexOf(settled)).every((value) => value === settled)).toBe(true);
      expect(observed.slice(observed.indexOf(settled)).length).toBeGreaterThanOrEqual(3);

      expect(records.filter((record) => record.event === 'processing.archive.validation.failed')).toEqual([]);
      expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual(expect.arrayContaining([
        'SmbSettle_jpg_q85.cbz',
      ]));
      const row = generatedArtifactRepository.listByProjectId(project.id)
        .find((artifact) => artifact.relative_path === 'SmbSettle_jpg_q85.cbz');
      expect(row).toBeDefined();
      expect(row.sha256).toBe(createHash('sha256').update(fs.readFileSync(cbzPath)).digest('hex'));
      expect(workspaces()).toEqual([]);
    });

    // Required cross-item race: archive A is fully validated; while archive B's content is
    // hashed, A is replaced by a same-bytes foreign file. Only the final identity-only sweep
    // over every public archive can see it, and the index commit must not proceed.
    it('refuses the commit when an earlier archive is replaced during a later archive hash', async () => {
      const source = await writeIndexedImage('Final/cross-item.png');
      const jpgPath = archiveAt('CrossItem_jpg_q80.zip');
      const webpPath = archiveAt('CrossItem_webp_q90.zip');
      let foreignIno;
      let publishedBytes;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      // B's only read-only open is its pre-commit hash, after A passed validation.
      const hook = hookFirstRead((filePath) => filePath === webpPath, () => {
        publishedBytes = fs.readFileSync(jpgPath);
        foreignIno = replaceWithSameBytes(jpgPath);
      });
      let failure;
      let applyCalls;
      try {
        failure = await processingService.createArchives(project.id, [source.id], { setName: 'CrossItem' })
          .catch((err) => err);
      } finally {
        // mockRestore() clears the spy's call history: count the index commits first.
        applyCalls = applySpy.mock.calls.length;
        hook.restore();
        applySpy.mockRestore();
      }

      expect(hook.fired).toBe(true);
      expect(applyCalls).toBe(0);
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED', cause: { code: 'ARCHIVE_DESTINATION_CONFLICT' } });
      expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
        itemIndex: 0, artifactRole: 'published-archive', check: 'precommit-final-identity-mismatch',
      })]));
      // The foreign same-bytes archive is untouched; the owned WebP archive is rolled back.
      expect(fs.statSync(jpgPath, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readFileSync(jpgPath)).toEqual(publishedBytes);
      expect(fs.existsSync(webpPath)).toBe(false);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
    });

    // Required cross-item content race: archive A passes identity, content, identity; while
    // archive B's content is hashed, A is rewritten IN PLACE (same inode, same size). An
    // identity-only final sweep passes, so only content continuity keeps A's stale hash and
    // provenance out of the index.
    it('refuses the commit when an earlier archive is rewritten in place during a later archive hash', async () => {
      const source = await writeIndexedImage('Final/cross-item-content.png');
      const jpgPath = archiveAt('CrossContent_jpg_q80.zip');
      const webpPath = archiveAt('CrossContent_webp_q90.zip');
      let inoAtMutation;
      let inoAfterMutation;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      // B's only read-only open is its pre-commit hash, after A passed validation.
      const hook = hookFirstRead((filePath) => filePath === webpPath, () => {
        inoAtMutation = fs.lstatSync(jpgPath, { bigint: true }).ino;
        rewriteInPlaceLater(jpgPath, Buffer.alloc(fs.lstatSync(jpgPath).size, 0x42));
        inoAfterMutation = fs.lstatSync(jpgPath, { bigint: true }).ino;
      });
      let failure;
      let applyCalls;
      try {
        failure = await processingService.createArchives(project.id, [source.id], { setName: 'CrossContent' })
          .catch((err) => err);
      } finally {
        // mockRestore() clears the spy's call history: count the index commits first.
        applyCalls = applySpy.mock.calls.length;
        hook.restore();
        applySpy.mockRestore();
      }

      expect(hook.fired).toBe(true);
      expect(inoAfterMutation).toBe(inoAtMutation);
      expect(applyCalls).toBe(0);
      expect(failure).toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
      expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
        itemIndex: 0, artifactRole: 'published-archive', check: 'precommit-final-content-mismatch',
      })]));
      // Both owned archives are rolled back by their exact identities; nothing is recorded.
      expect(fs.existsSync(jpgPath)).toBe(false);
      expect(fs.existsSync(webpPath)).toBe(false);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      expect(workspaces()).toEqual([]);
    });

    // WP4 SMB diagnostics: an archive pre-commit validation failure logs the values its actual
    // decision read, through the real application logger and its sanitizer.
    describe('archive validation failure diagnostics', () => {
      const VALIDATION_EVENT = 'processing.archive.validation.failed';
      const withRealLogger = () => {
        const records = [];
        const applicationLogger = createApplicationLogger({
          repository: { insert: (record) => records.push(record), prune: () => {} },
        });
        processingService = makeProcessingService({ applicationLogger });
        return records;
      };
      const validationRecords = (records) => records.filter((record) => record.event === VALIDATION_EVENT);
      // Every object key and array element counts one against the logger's 100-entry budget.
      const contextEntries = (value) => {
        if (Array.isArray(value)) return value.reduce((sum, item) => sum + 1 + contextEntries(item), 0);
        if (value && typeof value === 'object') {
          return Object.values(value).reduce((sum, item) => sum + 1 + contextEntries(item), 0);
        }
        return 0;
      };
      const expectSafeContext = (context) => {
        const json = JSON.stringify(context);
        expect(json).not.toContain('[truncated]');
        expect(json).not.toContain('[unsupported value]');
        expect(json).not.toContain('[redacted');
        expect(json).not.toContain(projectDir);
        expect(json).not.toContain(path.basename(tmpDir));
        expect(contextEntries(context)).toBeLessThanOrEqual(100);      };
      const onProgress = Object.assign(() => {}, { jobId: 'job-archive-diagnostic' });
      // Runs one archive set and returns the failure plus the index commits it attempted.
      async function runFailing(setName, hook, extra = {}) {
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
        let failure;
        let applyCalls;
        try {
          failure = await processingService.createArchives(project.id, [sourceId], { setName, ...extra }, onProgress)
            .catch((err) => err);
        } finally {
          applyCalls = applySpy.mock.calls.length;
          hook.restore();
          applySpy.mockRestore();
        }
        expect(hook.fired).toBe(true);
        expect(applyCalls).toBe(0);
        return failure;
      }
      let sourceId;
      beforeEach(async () => {
        sourceId = (await writeIndexedImage('Final/validation-diagnostic.png')).id;
      });

      // Focused test 1: identity, size and bytes hold, but the write metadata moves across the
      // archive's own pre-commit hash AND across the re-hash its moved metadata requires, so no
      // post-hash baseline ever held across a read. The same validation runs for a ZIP and CBZ.
      it.each([
        ['ZIP', 'FpZip', 'FpZip_jpg_q80.zip', {}, 'archive-jpg', 'zip'],
        ['CBZ', 'FpCbz', 'FpCbz_jpg_q85.cbz', { makeCbz: true }, 'archive-cbz', 'zip'],
      ])('logs the fingerprint change a %s pre-commit re-hash was bracketed by', async (
        _label, setName, fileName, extra, archiveKind, container,
      ) => {
        const records = withRealLogger();
        const target = archiveAt(fileName);
        // Same bytes and inode; only the modification time advances after each hash read.
        const hook = hookAfterEachRead((filePath) => filePath === target, (filePath) => {
          const { atimeMs, mtimeMs } = fs.statSync(filePath);
          fs.utimesSync(filePath, atimeMs / 1000, mtimeMs / 1000 + 5);
        });
        const failure = await runFailing(setName, hook, extra);

        expect(hook.calls).toBe(2);
        expect(failure).toMatchObject({
          code: 'ARCHIVE_DESTINATION_CONFLICT', message: 'The archive changed before it could be recorded.',
        });
        const [record, ...others] = validationRecords(records);
        expect(others).toEqual([]);
        expect(record).toMatchObject({
          level: 'warn', kind: 'diagnostic', subsystem: 'processing', projectId: project.id,
          correlationId: 'job-archive-diagnostic',
        });
        const { context } = record;
        // The rejected comparison is post-hash to post-re-hash, never the pre-hash observation.
        expect(context).toMatchObject({
          operation: 'archive', archiveKind, container, check: 'precommit-content',
          subcheck: 'fingerprint-changed', identityMatch: 'matched', hashMatch: true,
          compared: ['precommit-after-hash', 'precommit-after-rehash'], failedArchiveCount: 1,
        });
        const { phases } = context;
        expect(Object.keys(phases)).toEqual([
          'public-descriptor-final', 'public-post-close', 'precommit-before-hash', 'precommit-identity-before-hash',
          'precommit-size-check', 'precommit-identity-after-hash', 'precommit-after-hash', 'precommit-after-rehash',
        ]);
        const before = phases['precommit-before-hash'];
        const after = phases['precommit-after-hash'];
        const afterRehash = phases['precommit-after-rehash'];
        // changedFields are exactly the fingerprint components that differ between the two
        // observations the decision compared, and mtime is among them.
        expect(context.changedFields).toContain('mtimeNs');
        expect(context.changedFields)
          .toEqual(['size', 'mtimeNs', 'ctimeNs'].filter((key) => after[key] !== afterRehash[key]));
        expect(context.firstChangedPhase).toBe('precommit-identity-after-hash');
        // The pre-hash observation stays observable: it differs from the first post-hash one.
        expect(before.mtimeNs).not.toBe(after.mtimeNs);
        expect(afterRehash.size).toBe(before.size);
        expect(afterRehash.ino).toBe(before.ino);
        expect(context.expected).toMatchObject({ dev: before.dev, ino: before.ino, size: before.size });
        for (const field of ['dev', 'ino', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs']) {
          expect(before[field]).toMatch(/^\d+$/);
        }
        expectSafeContext(context);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });

      // Real-SMB shape (live WP4 evidence): metadata settles back to the creating descriptor's
      // values during the hash. It is accepted; a LATER in-place write of that archive (during
      // another archive's hash) is still rejected, against the post-hash baseline.
      it('logs a later in-place write against the post-hash baseline after SMB settling', async () => {
        const records = withRealLogger();
        const jpgPath = archiveAt('SmbLater_jpg_q80.zip');
        const webpPath = archiveAt('SmbLater_webp_q90.zip');
        let mutated = false;
        const smb = modelSmbTimeSettling((filePath) => filePath === jpgPath, {
          onReadOpen: (filePath) => {
            if (!mutated && filePath === webpPath) {
              mutated = true;
              rewriteInPlaceLater(jpgPath, Buffer.alloc(fs.lstatSync(jpgPath).size, 0x42));
            }
          },
        });
        const hook = { get fired() { return mutated; }, restore: () => smb.restore() };
        const failure = await runFailing('SmbLater', hook);

        expect(failure).toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
        const [{ context }, ...others] = validationRecords(records);
        expect(others).toEqual([]);
        expect(context).toMatchObject({
          itemIndex: 0, check: 'precommit-final-content-mismatch', subcheck: 'fingerprint-changed',
          identityMatch: 'matched', hashMatch: true, compared: ['precommit-after-rehash', 'precommit-final-sweep'],
        });
        const { phases } = context;
        // The SMB settling itself stays observable: pre-hash (post-close) times, then the
        // descriptor's times from the first post-hash stat on.
        expect(phases['precommit-before-hash'].mtimeNs).toBe(phases['public-post-close'].mtimeNs);
        expect(phases['precommit-after-hash'].mtimeNs).not.toBe(phases['precommit-before-hash'].mtimeNs);
        expect(phases['precommit-after-rehash'].mtimeNs).toBe(phases['precommit-after-hash'].mtimeNs);
        expect(context.changedFields).toContain('mtimeNs');
        expect(context.changedFields).toEqual(['size', 'mtimeNs', 'ctimeNs']
          .filter((key) => phases['precommit-after-rehash'][key] !== phases['precommit-final-sweep'][key]));
        expect(phases['precommit-final-sweep']).toMatchObject({ dev: context.expected.dev, ino: context.expected.ino });
        expectSafeContext(context);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });

      it('logs a pre-commit hash mismatch with the size check that passed before it', async () => {
        const records = withRealLogger();
        const target = archiveAt('HashMiss_jpg_q80.zip');
        const hook = hookFirstRead((filePath) => filePath === target, (filePath) => {
          rewriteInPlaceLater(filePath, Buffer.alloc(fs.lstatSync(filePath).size, 0x42));
        });
        const failure = await runFailing('HashMiss', hook);

        expect(failure).toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
        const [{ context }] = validationRecords(records);
        expect(context).toMatchObject({
          check: 'precommit-content', subcheck: 'hash-mismatch', identityMatch: 'matched', hashMatch: false,
          changedFields: [],
        });
        expect(context.phases['precommit-size-check'].size).toBe(context.expected.size);
        expect(context.phases['precommit-after-hash']).toBeUndefined();
        expectSafeContext(context);
      });

      // The pre-commit hash helper's own byte read of `target` (recognized by the descriptor it
      // reads through): `onRead(target, read)` runs in its place, once.
      const hookHashRead = (target, onRead) => {
        const realReadFile = fs.readFileSync.bind(fs);
        let fired = false;
        const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
          if (!fired && typeof file === 'number' && fs.existsSync(target)
            && fs.fstatSync(file, { bigint: true }).ino === fs.lstatSync(target, { bigint: true }).ino) {
            fired = true;
            return onRead(target, () => realReadFile(file, ...args));
          }
          return realReadFile(file, ...args);
        });
        return { get fired() { return fired; }, restore: () => readSpy.mockRestore() };
      };
      // The helper decides from non-bigint stats: exact IDs past 2^53 appear rounded there.
      const numeric = (exact) => String(Number(exact));
      const expectUnreadable = (failure) => expect(failure.cause ?? failure).toMatchObject({
        code: 'FILESYSTEM_OPERATION_FAILED', message: 'The archive could not be read before it was recorded.',
      });

      // The outer pre-hash checks see the owned archive; the helper reads its bytes, and then its
      // own pathname continuity stat sees another object. Shared by the ZIP and CBZ validation.
      it.each([
        ['ZIP', 'HashId', 'HashId_jpg_q80.zip', {}, 'archive-jpg'],
        ['CBZ', 'HashIdCbz', 'HashIdCbz_jpg_q85.cbz', { makeCbz: true }, 'archive-cbz'],
      ])('logs a %s hash-helper identity rejection as an identity mismatch, not a read failure', async (
        _label, setName, fileName, extra, archiveKind,
      ) => {
        const records = withRealLogger();
        // From the helper's read on, the archive's inode reports another ino (past 2^53, so the
        // helper's numeric stat rounds it): its own pathname continuity stat sees another object.
        const ids = mockFileIdentities();
        const hashRead = hookHashRead(archiveAt(fileName), (target, read) => {
          const bytes = read();
          ids.assign(target, { ino: 9007199254740993n });
          return bytes;
        });
        const hook = { get fired() { return hashRead.fired; }, restore: () => { hashRead.restore(); ids.restore(); } };
        const failure = await runFailing(setName, hook, extra);

        expectUnreadable(failure);
        const [{ context }, ...others] = validationRecords(records);
        expect(others).toEqual([]);
        expect(context).toMatchObject({
          archiveKind, check: 'precommit-unreadable', subcheck: 'hash-identity-mismatch',
          identityMatch: 'dev-ino-mismatch', hashMatch: 'not-evaluated',
          compared: ['hash-before-lstat', 'hash-after-lstat'], firstChangedPhase: 'hash-after-lstat',
        });
        expect(context.errorCode).toBeUndefined();
        const { phases } = context;
        expect(phases['precommit-hash']).toEqual({ bytesRead: true });
        const helperBefore = phases['hash-before-lstat'];
        const helperAfter = phases['hash-after-lstat'];
        // The helper's baseline was the owned archive; its deciding stat was another object.
        expect(helperBefore).toMatchObject({
          stat: 'number', ino: numeric(context.expected.ino), dev: numeric(context.expected.dev),
        });
        expect(helperAfter).toMatchObject({ stat: 'number', ino: String(Number(9007199254740993n)), dev: helperBefore.dev });
        expect(context.changedFields).toEqual(['ino']);
        for (const field of ['dev', 'ino', 'size']) {
          expect(helperBefore[field]).toMatch(/^\d+$/);
          expect(helperAfter[field]).toMatch(/^\d+$/);
        }
        expectSafeContext(context);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });

      it('logs a hash-helper size rejection as a size mismatch under a held identity', async () => {
        const records = withRealLogger();
        const hook = hookHashRead(archiveAt('HashSize_jpg_q80.zip'), (target, read) => {
          const bytes = read();
          fs.appendFileSync(target, Buffer.from('grown'));
          return bytes;
        });
        const failure = await runFailing('HashSize', hook);

        expectUnreadable(failure);
        const [{ context }] = validationRecords(records);
        expect(context).toMatchObject({
          check: 'precommit-unreadable', subcheck: 'hash-size-mismatch', identityMatch: 'matched',
          hashMatch: 'not-evaluated', compared: ['hash-before-lstat', 'hash-after-lstat'], changedFields: ['size'],
          firstChangedPhase: 'hash-after-lstat',
        });
        const { phases } = context;
        expect(phases['precommit-hash']).toEqual({ bytesRead: true });
        expect(phases['hash-before-lstat']).toMatchObject({ size: context.expected.size, ino: numeric(context.expected.ino) });
        expect(phases['hash-after-lstat']).toMatchObject({
          size: String(Number(context.expected.size) + 5), ino: numeric(context.expected.ino), dev: numeric(context.expected.dev),
        });
        expectSafeContext(context);
      });

      // Control: a genuine I/O failure of the helper's read stays a read failure.
      it('keeps a hash-helper EIO read as a read failure with its error code', async () => {
        const records = withRealLogger();
        const hook = hookHashRead(archiveAt('HashEio_jpg_q80.zip'), () => {
          throw Object.assign(new Error('injected hash read EIO'), { code: 'EIO' });
        });
        const failure = await runFailing('HashEio', hook);

        expectUnreadable(failure);
        const [{ context }] = validationRecords(records);
        expect(context).toMatchObject({
          check: 'precommit-unreadable', subcheck: 'hash-read-failed', identityMatch: 'matched',
          hashMatch: 'read-failed', changedFields: [], errorCode: 'EIO',
        });
        expect(context.phases['hash-after-lstat']).toBeUndefined();
        expectSafeContext(context);
      });

      // Focused test 2: archive A is fully validated; during archive B's hash A changes. Only
      // the final sweep sees it, and it tells an identity change from a metadata change.
      it('distinguishes a final-sweep metadata change from a final-sweep identity change', async () => {
        const records = withRealLogger();
        const metadataTarget = archiveAt('SweepMeta_jpg_q80.zip');
        const metadataHook = hookFirstRead((filePath) => filePath === archiveAt('SweepMeta_webp_q90.zip'), () => {
          rewriteInPlaceLater(metadataTarget, Buffer.alloc(fs.lstatSync(metadataTarget).size, 0x42));
        });
        expect(await runFailing('SweepMeta', metadataHook)).toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });

        const identityTarget = archiveAt('SweepId_jpg_q80.zip');
        const identityHook = hookFirstRead((filePath) => filePath === archiveAt('SweepId_webp_q90.zip'), () => {
          replaceWithSameBytes(identityTarget);
        });
        expect(await runFailing('SweepId', identityHook)).toMatchObject({
          code: 'RECOVERY_REQUIRED', cause: { code: 'ARCHIVE_DESTINATION_CONFLICT' },
        });

        const [metadata, identity, ...others] = validationRecords(records).map((record) => record.context);
        expect(others).toEqual([]);
        expect(metadata).toMatchObject({
          itemIndex: 0, check: 'precommit-final-content-mismatch', subcheck: 'fingerprint-changed',
          identityMatch: 'matched', hashMatch: true, compared: ['precommit-after-hash', 'precommit-final-sweep'],
          firstChangedPhase: 'precommit-final-sweep',
        });
        const sweep = metadata.phases['precommit-final-sweep'];
        expect(sweep.identity).toBeUndefined();
        expect(sweep).toMatchObject({ dev: metadata.expected.dev, ino: metadata.expected.ino });
        expect(metadata.changedFields).toContain('mtimeNs');
        expect(metadata.changedFields).not.toContain('ino');

        expect(identity).toMatchObject({
          itemIndex: 0, check: 'precommit-final-identity-mismatch', subcheck: 'dev-ino-mismatch',
          identityMatch: 'dev-ino-mismatch', hashMatch: true, compared: ['expected', 'precommit-final-sweep'],
          changedFields: ['ino'], firstChangedPhase: 'precommit-final-sweep',
        });
        expect(identity.phases['precommit-final-sweep'].identity).toBe('dev-ino-mismatch');
        expect(identity.phases['precommit-after-hash'].ino).toBe(identity.expected.ino);
        expectSafeContext(metadata);
        expectSafeContext(identity);
      });

      // Focused test 3 and the logger budget (test 4): the durable birth time is part of the
      // owned identity, so a birth-time-only change is an identity failure, told apart from a
      // dev/ino change and from a write-fingerprint change. This record carries every phase.
      it('logs a birth-time-only identity change distinctly and within the logger budget', async () => {
        const records = withRealLogger();
        const target = archiveAt('Birth_jpg_q80.zip');
        let birthtimeNs = 1700000000000000093n;
        const ids = mockFileIdentities();
        ids.autoAssign((filePath) => filePath === target, {
          dev: 18446744073709551557n, ino: 9007199254740993n, birthtimeNs: () => birthtimeNs,
        });
        // mockFileIdentities already spies on openSync, so the WebP archive's pre-commit hash is
        // recognized by the descriptor its bytes are read through.
        const webpPath = archiveAt('Birth_webp_q90.zip');
        const realReadFile = fs.readFileSync.bind(fs);
        let fired = false;
        const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
          if (!fired && typeof file === 'number' && fs.existsSync(webpPath)
            && fs.fstatSync(file, { bigint: true }).ino === fs.lstatSync(webpPath, { bigint: true }).ino) {
            fired = true;
            birthtimeNs = 1700000000000000094n;
          }
          return realReadFile(file, ...args);
        });
        const hook = { get fired() { return fired; }, restore: () => readSpy.mockRestore() };
        let failure;
        try {
          failure = await runFailing('Birth', hook);
        } finally {
          ids.restore();
        }

        expect((failure.cause ?? failure).code).toBe('ARCHIVE_DESTINATION_CONFLICT');
        const [{ context }] = validationRecords(records);
        expect(context).toMatchObject({
          check: 'precommit-final-identity-mismatch', subcheck: 'birthtime-mismatch',
          identityMatch: 'birthtime-mismatch', hashMatch: true, changedFields: ['birthtimeNs'],
          compared: ['expected', 'precommit-final-sweep'], firstChangedPhase: 'precommit-final-sweep',
          // Exact bigint values past 2^53 survive as decimal strings.
          expected: { dev: '18446744073709551557', ino: '9007199254740993', birthtimeNs: '1700000000000000093' },
        });
        expect(context.phases['public-descriptor-final']).toMatchObject({
          dev: '18446744073709551557', ino: '9007199254740993', birthtimeNs: '1700000000000000093',
        });
        expect(context.phases['precommit-final-sweep']).toMatchObject({
          dev: '18446744073709551557', ino: '9007199254740993', birthtimeNs: '1700000000000000094',
          identity: 'birthtime-mismatch',
        });
        expect(Object.keys(context.phases)).toHaveLength(8);
        expectSafeContext(context);
      });
    });

    it('never removes an existing archive when its owned backup is mutated in place', async () => {
      const source = await writeIndexedImage('Final/backup-mutated.png');
      await publishOnce('BackupMutated', source);
      const jpgPath = archiveAt('BackupMutated_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeIno = fs.lstatSync(jpgPath, { bigint: true }).ino;
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      // Same backup inode (its owned identity holds), different bytes.
      const hook = hookOwnedCreate(inStaging('archive-0.destination'), {
        times: 1, after: (backupPath) => rewriteInPlace(backupPath, Buffer.from('mutated backup')),
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'BackupMutated', replaceExistingArchives: true,
        }).catch((err) => err);
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(jpgPath);
      } finally {
        unlinkSpy.mockRestore();
        hook.restore();
      }

      expect(hook.calls).toBe(1);
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
        artifactRole: 'archive-backup', check: 'replace-backup-content-mismatch',
      })]));
      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(beforeIno);
      expect(fs.readFileSync(jpgPath)).toEqual(before);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
      expect(workspaces()).toEqual([]);
    });

    // The destination read that follows the backup's first validation (the backup already
    // exists by then; every earlier read-only open of the destination precedes its creation).
    const hookDestinationReadAfterBackup = (jpgPath, onRead) => {
      const backupPath = () => (fs.existsSync(workspacePath())
        ? stageArtifact(workspacePath(), 'archive-0.destination') : null);
      return hookFirstRead((filePath) => filePath === jpgPath, () => onRead(backupPath()), {
        when: () => Boolean(backupPath() && fs.existsSync(backupPath())),
      });
    };

    it('never removes an existing archive when its backup is rewritten in place during the destination read', async () => {
      const source = await writeIndexedImage('Final/backup-late-mutated.png');
      await publishOnce('BackupLate', source);
      const jpgPath = archiveAt('BackupLate_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeIno = fs.lstatSync(jpgPath, { bigint: true }).ino;
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      let backupIno;
      let backupInoAfter;
      // Same size and inode (the backup's owned identity holds), different bytes: only a
      // content revalidation after the destination read can see it.
      const hook = hookDestinationReadAfterBackup(jpgPath, (backupPath) => {
        backupIno = fs.lstatSync(backupPath, { bigint: true }).ino;
        rewriteInPlace(backupPath, Buffer.alloc(before.length, 0x41));
        backupInoAfter = fs.lstatSync(backupPath, { bigint: true }).ino;
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'BackupLate', replaceExistingArchives: true,
        }).catch((err) => err);
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(jpgPath);
      } finally {
        unlinkSpy.mockRestore();
        hook.restore();
      }

      expect(hook.fired).toBe(true);
      expect(backupIno).toBeDefined();
      expect(backupInoAfter).toBe(backupIno);
      // Failed before the destructive step: nothing public changed, so recovery is not required.
      expect(failure).toMatchObject({
        code: 'FILESYSTEM_OPERATION_FAILED',
        recoveryDiagnostics: { restored: true },
      });
      expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
        artifactRole: 'archive-backup', check: 'replace-final-backup-content-mismatch',
      })]));
      // The corrupted backup is never kept or used as recovery evidence.
      for (const role of ['restored-archive', 'archive-backup']) {
        expect(failures(failure)).not.toEqual(expect.arrayContaining([expect.objectContaining({
          artifactRole: role, cleanup: 'recovery-critical',
        })]));
      }
      expect(failures(failure)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'restored-archive' }),
      ]));
      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(beforeIno);
      expect(fs.readFileSync(jpgPath)).toEqual(before);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
      expect(workspaces()).toEqual([]);
    });

    // The reverse direction: the destination passed its own content validation after the
    // backup existed, and is rewritten in place (same inode, same size) while the FINAL backup
    // content read runs. Only a final destination content-continuity proof can see it.
    it('never removes an existing archive rewritten in place during the final backup read', async () => {
      const source = await writeIndexedImage('Final/destination-late-mutated.png');
      await publishOnce('DestinationLate', source);
      const jpgPath = archiveAt('DestinationLate_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeIno = fs.lstatSync(jpgPath, { bigint: true }).ino;
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      const mutated = Buffer.alloc(before.length, 0x42);
      const isBackup = inStaging('archive-0.destination');
      const backupPath = () => stageArtifact(workspacePath(), 'archive-0.destination');
      let backupBytesAtMutation;
      // The destination read after the backup exists is its final content validation; the
      // next backup read is the final backup validation.
      const hook = hookReadAfterRead(
        (filePath) => filePath === jpgPath && fs.existsSync(workspacePath()) && fs.existsSync(backupPath()),
        isBackup,
        () => {
          backupBytesAtMutation = fs.readFileSync(backupPath());
          rewriteInPlaceLater(jpgPath, mutated);
        },
      );
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const unlinked = () => unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
      let failure;
      let applyCalls;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'DestinationLate', replaceExistingArchives: true,
        }).catch((err) => err);
        expect(unlinked()).not.toContain(jpgPath);
      } finally {
        // mockRestore() clears the spy's call history: count the index commits first.
        applyCalls = applySpy.mock.calls.length;
        unlinkSpy.mockRestore();
        applySpy.mockRestore();
        hook.restore();
      }

      expect(hook.fired).toBe(true);
      // The backup was still the valid prior archive when the destination changed.
      expect(backupBytesAtMutation).toEqual(before);
      expect(applyCalls).toBe(0);
      // Refused before the destructive step: nothing public was removed or published, so the
      // backup is only disposed of once rollback established that.
      expect(failure).toMatchObject({
        code: 'ARCHIVE_DESTINATION_CONFLICT',
        recoveryDiagnostics: { restored: true },
      });
      expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
        itemIndex: 0, artifactRole: 'archive-destination', check: 'replace-final-destination-content-mismatch',
      })]));
      expect(failures(failure)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'restored-archive' }),
      ]));
      // Never unlinked, repaired or adopted: the externally rewritten destination stays as is.
      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(beforeIno);
      expect(fs.readFileSync(jpgPath)).toEqual(mutated);
      expect(fs.existsSync(archiveAt('DestinationLate_webp_q90.zip'))).toBe(true);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
    });

    it('replaces an archive when its backup and destination both stay exact through the final checks', async () => {
      const source = await writeIndexedImage('Final/backup-late-control.png');
      await publishOnce('BackupLateControl', source);
      const jpgPath = archiveAt('BackupLateControl_jpg_q80.zip');
      const beforeIno = fs.lstatSync(jpgPath, { bigint: true }).ino;
      const hook = hookDestinationReadAfterBackup(jpgPath, () => {});
      let result;
      try {
        result = await processingService.createArchives(project.id, [source.id], {
          setName: 'BackupLateControl', replaceExistingArchives: true,
        });
      } finally {
        hook.restore();
      }

      expect(hook.fired).toBe(true);
      expect(result).toMatchObject({ status: 'completed', generatedCount: 2 });
      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).not.toBe(beforeIno);
      expect(rowAt('BackupLateControl_jpg_q80.zip').output_provenance).toBe(provenanceTupleOf(jpgPath));
    });

    it('never removes a same-bytes foreign archive that replaced a new archive before rollback', async () => {
      const source = await writeIndexedImage('Final/public-replaced.png');
      const jpgPath = archiveAt('PublicReplaced_jpg_q80.zip');
      let foreignIno;
      const index = failIndexAfter(() => { foreignIno = replaceWithSameBytes(jpgPath); });
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], { setName: 'PublicReplaced' })
          .catch((err) => err);
      } finally {
        index.restore();
      }

      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.statSync(jpgPath, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.existsSync(archiveAt('PublicReplaced_webp_q90.zip'))).toBe(false);
      expect(failures(failure)).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'published-archive', check: 'rollback-identity-mismatch' }),
        expect.objectContaining({
          artifactRole: 'archive-stage', check: 'retained-unresolved-publication', cleanup: 'recovery-critical',
        }),
      ]));
      const [workspace, ...others] = workspaces();
      expect(others).toEqual([]);
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspace), 'archive-0.zip'))).toBe(true);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
    });

    it('keeps the backup and never reconciles provenance when the restored archive is corrupted in place', async () => {
      const source = await writeIndexedImage('Final/restored-corrupted.png');
      await publishOnce('RestoredCorrupt', source);
      const jpgPath = archiveAt('RestoredCorrupt_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      const corrupted = Buffer.from('restored archive corrupted in place');
      const index = failIndexAfter();
      let restoredIno;
      // The restore itself succeeds; the same inode is rewritten before reconciliation.
      const hook = hookOwnedCreate((filePath) => filePath === jpgPath, {
        when: () => index.state.rollingBack,
        times: 1,
        after: (restoredPath) => {
          restoredIno = fs.lstatSync(restoredPath, { bigint: true }).ino;
          rewriteInPlace(restoredPath, corrupted);
        },
      });
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'RestoredCorrupt', replaceExistingArchives: true,
        }).catch((err) => err);
      } finally {
        hook.restore();
        index.restore();
      }

      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(failures(failure)).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'restored-archive', check: 'provenance-reconcile-content-mismatch' }),
        expect.objectContaining({ artifactRole: 'archive-backup', check: 'retained-unrestored' }),
      ]));
      // Never repaired, never adopted: the corrupted restore stays; the row is not reconciled.
      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(restoredIno);
      expect(fs.readFileSync(jpgPath)).toEqual(corrupted);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
      expect(fs.readFileSync(stageArtifact(workspacePath(), 'archive-0.destination'))).toEqual(before);
    });

    // Cross-item reconciliation race: both replaced archives are restored; restored archive A
    // passes identity, content, identity, then is rewritten IN PLACE (same inode, same size)
    // while restored archive B is read. An identity-only final sweep would reconcile A's row.
    it('never reconciles a restored archive rewritten in place during a later restored archive read', async () => {
      const source = await writeIndexedImage('Final/restored-cross-item.png');
      await publishOnce('RestoredCross', source);
      const jpgPath = archiveAt('RestoredCross_jpg_q80.zip');
      const webpPath = archiveAt('RestoredCross_webp_q90.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
      const mutated = Buffer.alloc(before.length, 0x43);
      const index = failIndexAfter();
      let restoredIno;
      let inoAfterMutation;
      // During rollback, the first reads of the restored archives are their reconciliation
      // validations: A (jpg) first, then B (webp).
      const hook = hookReadAfterRead((filePath) => filePath === jpgPath, (filePath) => filePath === webpPath, () => {
        restoredIno = fs.lstatSync(jpgPath, { bigint: true }).ino;
        rewriteInPlaceLater(jpgPath, mutated);
        inoAfterMutation = fs.lstatSync(jpgPath, { bigint: true }).ino;
      }, { when: () => index.state.rollingBack });
      const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedArtifactProvenance');
      let failure;
      let reconcileCalls;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'RestoredCross', replaceExistingArchives: true,
        }).catch((err) => err);
      } finally {
        // mockRestore() clears the spy's call history: count the reconciliations first.
        reconcileCalls = reconcileSpy.mock.calls.length;
        reconcileSpy.mockRestore();
        hook.restore();
        index.restore();
      }

      expect(hook.fired).toBe(true);
      expect(inoAfterMutation).toBe(restoredIno);
      expect(reconcileCalls).toBe(0);
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED', recoveryDiagnostics: { restored: false } });
      expect(failures(failure)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          itemIndex: 0, artifactRole: 'restored-archive', check: 'provenance-reconcile-final-content-mismatch',
        }),
        expect.objectContaining({ itemIndex: 0, artifactRole: 'archive-backup', check: 'retained-unrestored' }),
      ]));
      // Never repaired or adopted; the rows keep their pre-run provenance and A's valid backup stays.
      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(restoredIno);
      expect(fs.readFileSync(jpgPath)).toEqual(mutated);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
      expect(fs.readFileSync(stageArtifact(workspacePath(), 'archive-0.destination'))).toEqual(before);
    });

    // A restored archive validated for reconciliation can still change before its backup is
    // deleted: the backup is the last known-good copy and is deleted only after a fresh
    // identity, content, identity revalidation of the restored archive.
    it('keeps the backup when the restored archive changes after reconciliation', async () => {
      const source = await writeIndexedImage('Final/restored-after-reconcile.png');
      await publishOnce('AfterReconcile', source);
      const jpgPath = archiveAt('AfterReconcile_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const realReconcile = assetRepository.reconcileGeneratedArtifactProvenance.bind(assetRepository);
      let reconciled = 0;
      const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedArtifactProvenance')
        .mockImplementation((...args) => {
          const result = realReconcile(...args);
          reconciled += 1;
          rewriteInPlace(jpgPath, Buffer.from('changed after reconciliation'));
          return result;
        });
      const index = failIndexAfter();
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'AfterReconcile', replaceExistingArchives: true,
        }).catch((err) => err);
      } finally {
        index.restore();
        reconcileSpy.mockRestore();
      }

      expect(reconciled).toBe(1);
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(failures(failure)).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactRole: 'restored-archive', check: 'restored-archive-content-mismatch' }),
        expect.objectContaining({ artifactRole: 'archive-backup', check: 'retained-restored-archive-changed' }),
      ]));
      expect(fs.readFileSync(stageArtifact(workspacePath(), 'archive-0.destination'))).toEqual(before);
      const evidence = createProcessingRecoveryEvidenceRepository(db);
      const backup = evidence.listUnresolvedEvidenceByProject(project.id).find((row) => row.artifactRole === 'destination-backup');
      expect(backup).toMatchObject({ lifecycle: 'recovery-critical', retentionReason: 'archive-restoration-failed' });
      expect(evidence.listMutationGroupsByProject(project.id)).toEqual([
        expect.objectContaining({ checkpoint: 'replace', itemKey: `archive-jpg:${sha256('AfterReconcile_jpg_q80.zip')}` }),
      ]);
    });

    // The disposal check's own hash reads the expected prior bytes; only then (before its
    // final identity check) is the restored archive rewritten IN PLACE: same inode, same size,
    // later mtime/ctime. An identity, content, identity check accepts that stale hash, so only
    // the write fingerprint captured around the hash keeps the last known-good backup.
    it('keeps the backup when the restored archive is rewritten in place during its disposal-check hash', async () => {
      const source = await writeIndexedImage('Final/restored-cleanup-hash.png');
      await publishOnce('CleanupHash', source);
      const jpgPath = archiveAt('CleanupHash_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const mutated = Buffer.alloc(before.length, 0x44);
      const logger = withLogger();
      const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedArtifactProvenance');
      const index = failIndexAfter();
      let bytesAtHash;
      let restoredIno;
      let inoAfterMutation;
      // After reconciliation, the next read of the restored archive is the disposal check.
      const hook = hookAfterRead((filePath) => filePath === jpgPath, () => {
        bytesAtHash = fs.readFileSync(jpgPath);
        restoredIno = fs.lstatSync(jpgPath, { bigint: true }).ino;
        rewriteInPlaceLater(jpgPath, mutated);
        inoAfterMutation = fs.lstatSync(jpgPath, { bigint: true }).ino;
      }, { when: () => reconcileSpy.mock.calls.length > 0 });
      let failure;
      let reconcileCalls;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'CleanupHash', replaceExistingArchives: true,
        }).catch((err) => err);
      } finally {
        reconcileCalls = reconcileSpy.mock.calls.length;
        hook.restore();
        index.restore();
        reconcileSpy.mockRestore();
      }

      expect(reconcileCalls).toBe(1);
      expect(hook.fired).toBe(true);
      expect(bytesAtHash).toEqual(before);
      expect(inoAfterMutation).toBe(restoredIno);
      expect(fs.lstatSync(jpgPath).size).toBe(before.length);
      expect(failure).toMatchObject({
        code: 'RECOVERY_REQUIRED',
        recoveryDiagnostics: { restored: true, cleanupSucceeded: false },
      });
      expect(failures(failure)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          itemIndex: 0, artifactRole: 'restored-archive', check: 'restored-archive-content-mismatch', identity: 'matched',
        }),
        expect.objectContaining({
          itemIndex: 0, artifactRole: 'archive-backup', check: 'retained-restored-archive-changed',
          cleanup: 'recovery-critical',
        }),
      ]));
      expect(loggedEvents(logger, 'warn')).not.toContain('processing.recovery.succeeded');
      // The valid backup stays; the changed restored archive is never repaired or adopted.
      expect(fs.readFileSync(stageArtifact(workspacePath(), 'archive-0.destination'))).toEqual(before);
      expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(restoredIno);
      expect(fs.readFileSync(jpgPath)).toEqual(mutated);
    });

    it('disposes of the backup when the restored archive stays exact through its disposal check', async () => {
      const source = await writeIndexedImage('Final/restored-cleanup-stable.png');
      await publishOnce('CleanupStable', source);
      const jpgPath = archiveAt('CleanupStable_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const logger = withLogger();
      const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedArtifactProvenance');
      const index = failIndexAfter();
      const hook = hookAfterRead((filePath) => filePath === jpgPath, () => {},
        { when: () => reconcileSpy.mock.calls.length > 0 });
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'CleanupStable', replaceExistingArchives: true,
        }).catch((err) => err);
      } finally {
        hook.restore();
        index.restore();
        reconcileSpy.mockRestore();
      }

      expect(hook.fired).toBe(true);
      // A clean recovery: the ordinary failure, with no recovery evidence at all.
      expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics).toBeUndefined();
      expect(loggedEvents(logger, 'warn')).toEqual(['processing.recovery.succeeded']);
      expect(fs.readFileSync(jpgPath)).toEqual(before);
      expect(workspaces()).toEqual([]);
      const evidence = createProcessingRecoveryEvidenceRepository(db);
      expect(evidence.listUnresolvedEvidenceByProject(project.id)).toEqual([]);
      expect(evidence.listMutationGroupsByProject(project.id)).toEqual([]);
    });

    it('never overwrites a foreign file that appears before the archive restore', async () => {
      const source = await writeIndexedImage('Final/restore-eexist.png');
      await publishOnce('RestoreEexist', source);
      const jpgPath = archiveAt('RestoreEexist_jpg_q80.zip');
      const before = fs.readFileSync(jpgPath);
      const beforeRow = rowAt('RestoreEexist_jpg_q80.zip');
      const foreign = Buffer.from('foreign file before archive restore');
      const index = failIndexAfter();
      const hook = hookOwnedCreate((filePath) => filePath === jpgPath, {
        when: () => index.state.rollingBack,
        times: 1,
        before: (target) => fs.writeFileSync(target, foreign),
      });
      let failure;
      try {
        failure = await processingService.createArchives(project.id, [source.id], {
          setName: 'RestoreEexist', replaceExistingArchives: true,
        }).catch((err) => err);
      } finally {
        hook.restore();
        index.restore();
      }

      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
        artifactRole: 'restored-archive', check: 'restore-create-failed', errorCode: 'EEXIST',
      })]));
      expect(fs.readFileSync(jpgPath)).toEqual(foreign);
      expect(fs.readFileSync(stageArtifact(workspacePath(), 'archive-0.destination'))).toEqual(before);
      expect(rowAt('RestoreEexist_jpg_q80.zip')).toEqual(beforeRow);
    });

    describe('zero or unknown descriptor identities', () => {
      it('never claims a new public archive whose descriptor identity is unknown', async () => {
        const source = await writeIndexedImage('Final/public-unknown.png');
        const jpgPath = archiveAt('PublicUnknown_jpg_q80.zip');
        const ids = mockFileIdentities();
        ids.autoAssign((filePath) => filePath === jpgPath, { dev: 0n, ino: 0n });
        let failure;
        try {
          failure = await processingService.createArchives(project.id, [source.id], { setName: 'PublicUnknown' })
            .catch((err) => err);
        } finally {
          ids.restore();
        }

        // The public path was created (public state mutated) but can never be proven ours.
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failures(failure)).toEqual(expect.arrayContaining([
          expect.objectContaining({
            artifactRole: 'published-archive',
            check: 'public-archive-identity-inspection-failed',
            proof: 'identity-unknown',
            cleanup: 'recovery-critical',
          }),
          expect.objectContaining({ artifactRole: 'published-archive', check: 'rollback-ownership-unproven' }),
          expect.objectContaining({ artifactRole: 'archive-stage', check: 'retained-unresolved-publication' }),
        ]));
        expect(failure.recoveryDiagnostics).toMatchObject({ restored: false, cleanupSucceeded: false });
        expect(fs.existsSync(jpgPath)).toBe(true);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });

      // Fails the first fstat of the descriptor CreatorCrate exclusively created at `target`.
      const failFirstCreatedFstat = (target) => {
        const realOpen = fs.openSync.bind(fs);
        const realFstat = fs.fstatSync.bind(fs);
        const created = new Set();
        let failed = 0;
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          const descriptor = realOpen(filePath, flags, ...args);
          if (typeof filePath === 'string' && path.resolve(filePath) === target
            && typeof flags === 'string' && flags.startsWith('wx') && failed === 0) created.add(descriptor);
          return descriptor;
        });
        const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
          if (created.delete(descriptor)) {
            failed += 1;
            throw Object.assign(new Error('injected descriptor fstat EIO'), { code: 'EIO' });
          }
          return realFstat(descriptor, ...args);
        });
        return {
          get failed() { return failed; },
          restore() { fstatSpy.mockRestore(); openSpy.mockRestore(); },
        };
      };

      it('requires recovery and never removes a created public archive whose first descriptor inspection fails', async () => {
        const source = await writeIndexedImage('Final/public-fstat-eio.png');
        const jpgPath = archiveAt('PublicFstat_jpg_q80.zip');
        const inspection = failFirstCreatedFstat(jpgPath);
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
        let failure;
        try {
          failure = await processingService.createArchives(project.id, [source.id], { setName: 'PublicFstat' })
            .catch((err) => err);
          expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(jpgPath);
        } finally {
          unlinkSpy.mockRestore();
          inspection.restore();
        }

        expect(inspection.failed).toBe(1);
        // The exclusive create succeeded, so the zero-byte public path exists, but it can never
        // be proven owned: it stays, with its stage, and recovery is required.
        expect(failure).toMatchObject({
          code: 'RECOVERY_REQUIRED',
          recoveryDiagnostics: { restored: false, cleanupSucceeded: false },
        });
        expect(failures(failure)).toEqual(expect.arrayContaining([
          expect.objectContaining({
            artifactRole: 'published-archive',
            check: 'public-archive-identity-inspection-failed',
            errorCode: 'EIO',
            cleanup: 'recovery-critical',
          }),
          expect.objectContaining({ artifactRole: 'published-archive', check: 'rollback-ownership-unproven' }),
          expect.objectContaining({ artifactRole: 'archive-stage', check: 'retained-unresolved-publication' }),
        ]));
        expect(failures(failure)).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ artifactRole: 'published-archive', check: 'publish-create-failed' }),
        ]));
        expect(fs.existsSync(jpgPath)).toBe(true);
        expect(fs.lstatSync(jpgPath).size).toBe(0);
        expect(fs.existsSync(stageArtifact(workspacePath(), 'archive-0.zip'))).toBe(true);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });

      // The initiating failure is the descriptor's EIO; the diagnostic's later pathname
      // observation failing with EACCES is secondary and never replaces that evidence.
      it('keeps the initiating descriptor error when the later diagnostic observation also fails', async () => {
        const source = await writeIndexedImage('Final/public-fstat-observe.png');
        const jpgPath = archiveAt('PublicObserve_jpg_q80.zip');
        const inspection = failFirstCreatedFstat(jpgPath);
        let observationsFailed = 0;
        const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
          if (inspection.failed === 1 && observationsFailed === 0
            && typeof filePath === 'string' && path.resolve(filePath) === jpgPath) {
            observationsFailed += 1;
            throw Object.assign(new Error('injected observation EACCES'), { code: 'EACCES' });
          }
          return realLstat(filePath, ...args);
        });
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
        let failure;
        try {
          failure = await processingService.createArchives(project.id, [source.id], { setName: 'PublicObserve' })
            .catch((err) => err);
          expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(jpgPath);
        } finally {
          unlinkSpy.mockRestore();
          lstatSpy.mockRestore();
          inspection.restore();
        }

        expect(inspection.failed).toBe(1);
        expect(observationsFailed).toBe(1);
        const created = failures(failure).filter((entry) => entry.check === 'public-archive-identity-inspection-failed');
        expect(created).toEqual([expect.objectContaining({
          artifactRole: 'published-archive',
          errorCode: 'EIO',
          pathState: 'inspection-failed',
          cleanup: 'recovery-critical',
        })]);
        // Recovery stays unsafe exactly as without the observation failure.
        expect(failure).toMatchObject({
          code: 'RECOVERY_REQUIRED',
          recoveryDiagnostics: { restored: false, cleanupSucceeded: false },
        });
        expect(failures(failure)).toEqual(expect.arrayContaining([
          expect.objectContaining({ artifactRole: 'published-archive', check: 'rollback-ownership-unproven' }),
          expect.objectContaining({ artifactRole: 'archive-stage', check: 'retained-unresolved-publication' }),
        ]));
        expect(fs.existsSync(jpgPath)).toBe(true);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });

      it('records no created-unclaimed state when the exclusive public open itself fails', async () => {
        const source = await writeIndexedImage('Final/public-open-eacces.png');
        const jpgPath = archiveAt('PublicOpen_jpg_q80.zip');
        const hook = hookOwnedCreate((filePath) => filePath === jpgPath, {
          times: 1,
          before: () => { throw Object.assign(new Error('injected open EACCES'), { code: 'EACCES' }); },
        });
        let failure;
        try {
          failure = await processingService.createArchives(project.id, [source.id], { setName: 'PublicOpen' })
            .catch((err) => err);
        } finally {
          hook.restore();
        }

        expect(hook.calls).toBe(1);
        // Nothing was created: an ordinary failure after a verified rollback.
        expect(failure).toMatchObject({
          code: 'FILESYSTEM_OPERATION_FAILED',
          recoveryDiagnostics: { restored: true, cleanupSucceeded: true },
        });
        expect(failures(failure)).toEqual(expect.arrayContaining([expect.objectContaining({
          artifactRole: 'published-archive', check: 'publish-create-failed', errorCode: 'EACCES',
        })]));
        for (const check of ['public-archive-identity-inspection-failed', 'rollback-ownership-unproven',
          'retained-unresolved-publication']) {
          expect(failures(failure)).not.toEqual(expect.arrayContaining([expect.objectContaining({ check })]));
        }
        expect(fs.existsSync(jpgPath)).toBe(false);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });

      it('leaves the existing archive untouched when the backup descriptor identity is unknown', async () => {
        const source = await writeIndexedImage('Final/backup-unknown.png');
        await publishOnce('BackupUnknown', source);
        const jpgPath = archiveAt('BackupUnknown_jpg_q80.zip');
        const before = fs.readFileSync(jpgPath);
        const beforeIno = fs.lstatSync(jpgPath, { bigint: true }).ino;
        const beforeArtifacts = generatedArtifactRepository.listByProjectId(project.id);
        const logger = withLogger();
        const ids = mockFileIdentities();
        ids.autoAssign(inStaging('archive-0.destination'), { dev: 0n, ino: 0n });
        let failure;
        try {
          failure = await processingService.createArchives(project.id, [source.id], {
            setName: 'BackupUnknown', replaceExistingArchives: true,
          }).catch((err) => err);
        } finally {
          ids.restore();
        }

        // Nothing public changed: an ordinary failure with the unclaimed backup as residue.
        expect(failure).toMatchObject({
          code: 'FILESYSTEM_OPERATION_FAILED',
          recoveryDiagnostics: { restored: true, cleanupSucceeded: false },
        });
        expect(failures(failure)).toEqual(expect.arrayContaining([
          expect.objectContaining({ artifactRole: 'archive-backup', check: 'backup-create-failed', proof: 'identity-unknown' }),
          expect.objectContaining({ artifactRole: 'archive-backup', cleanup: 'residue' }),
        ]));
        expect(loggedEvents(logger, 'error')).toEqual([]);
        expect(fs.lstatSync(jpgPath, { bigint: true }).ino).toBe(beforeIno);
        expect(fs.readFileSync(jpgPath)).toEqual(before);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual(beforeArtifacts);
      });

      it('requires recovery and keeps the backup when the restore descriptor identity is unknown', async () => {
        const source = await writeIndexedImage('Final/restore-unknown.png');
        await publishOnce('RestoreUnknown', source);
        const jpgPath = archiveAt('RestoreUnknown_jpg_q80.zip');
        const before = fs.readFileSync(jpgPath);
        const beforeRow = rowAt('RestoreUnknown_jpg_q80.zip');
        const ids = mockFileIdentities();
        // Tags the restore: the first new object at the path after the replacement published.
        const index = failIndexAfter(() => tagNextAt(ids, jpgPath, { dev: 0n, ino: 0n }));
        let failure;
        try {
          failure = await processingService.createArchives(project.id, [source.id], {
            setName: 'RestoreUnknown', replaceExistingArchives: true,
          }).catch((err) => err);
        } finally {
          index.restore();
          ids.restore();
        }

        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(failures(failure)).toEqual(expect.arrayContaining([
          expect.objectContaining({ artifactRole: 'restored-archive', check: 'restore-create-failed', proof: 'identity-unknown' }),
          expect.objectContaining({ artifactRole: 'archive-backup', check: 'retained-unrestored' }),
        ]));
        expect(fs.readFileSync(stageArtifact(workspacePath(), 'archive-0.destination'))).toEqual(before);
        // The unresolved archive's row is untouched; the WebP archive restored normally and its
        // row names its own restored file.
        expect(rowAt('RestoreUnknown_jpg_q80.zip')).toEqual(beforeRow);
        expect(rowAt('RestoreUnknown_webp_q90.zip').output_provenance)
          .toBe(provenanceTupleOf(archiveAt('RestoreUnknown_webp_q90.zip')));
      });
    });

    describe('cleanup safety versus completeness', () => {
      const failUnlinkOf = (matches) => {
        const realUnlink = fs.unlinkSync.bind(fs);
        return vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          if (matches(path.resolve(String(filePath)))) {
            throw Object.assign(new Error('injected cleanup unlinkSync EIO'), { code: 'EIO' });
          }
          return realUnlink(filePath, ...args);
        });
      };

      it('succeeds and reports residue when a committed replacement cannot remove its backup', async () => {
        const source = await writeIndexedImage('Final/committed-residue.png');
        await publishOnce('CommittedResidue', source);
        const logger = withLogger();
        const unlinkSpy = failUnlinkOf(inStaging('archive-0.destination'));
        let result;
        try {
          result = await processingService.createArchives(project.id, [source.id], {
            setName: 'CommittedResidue', replaceExistingArchives: true,
          });
        } finally {
          unlinkSpy.mockRestore();
        }

        expect(result).toMatchObject({ status: 'completed', generatedCount: 2 });
        expect(loggedEvents(logger, 'warn')).toEqual(['processing.cleanup.residue']);
        expect(logger.warn.mock.calls[0][0].context).toMatchObject({
          cleanupSucceeded: false,
          failures: [expect.objectContaining({
            artifactRole: 'archive-backup', check: 'cleanup-unlink-failed', errorCode: 'EIO', cleanup: 'residue',
          })],
        });
        expect(loggedEvents(logger, 'error')).toEqual([]);
        expect(rowAt('CommittedResidue_jpg_q80.zip').output_provenance)
          .toBe(provenanceTupleOf(archiveAt('CommittedResidue_jpg_q80.zip')));
      });

      it('keeps the ordinary failure with residue when a verified rollback cannot remove its stage', async () => {
        const source = await writeIndexedImage('Final/rollback-residue.png');
        const logger = withLogger();
        const unlinkSpy = failUnlinkOf(inStaging('archive-0.zip'));
        const index = failIndexAfter();
        let failure;
        try {
          failure = await processingService.createArchives(project.id, [source.id], { setName: 'RollbackResidue' })
            .catch((err) => err);
        } finally {
          index.restore();
          unlinkSpy.mockRestore();
        }

        expect(failure).toMatchObject({
          code: 'DATABASE_OPERATION_FAILED',
          recoveryDiagnostics: { phase: 'database', restored: true, cleanupSucceeded: false },
        });
        expect(failures(failure)).toEqual([expect.objectContaining({
          artifactRole: 'archive-stage', check: 'cleanup-unlink-failed', errorCode: 'EIO', cleanup: 'residue',
        })]);
        expect(loggedEvents(logger, 'warn')).toEqual(['processing.recovery.succeeded']);
        expect(loggedEvents(logger, 'error')).toEqual([]);
        expect(fs.existsSync(archiveAt('RollbackResidue_jpg_q80.zip'))).toBe(false);
        expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
      });
    });

    it('never adopts or removes archive staging evidence from an earlier run', async () => {
      const source = await writeIndexedImage('Final/earlier-evidence.png');
      fs.mkdirSync(workspacePath(), { recursive: true });
      const earlier = path.join(workspacePath(), '0123456789abcdef.archive-0.zip');
      fs.writeFileSync(earlier, Buffer.from('evidence from an earlier failed run'));

      await publishOnce('Earlier', source);

      expect(fs.readFileSync(earlier)).toEqual(Buffer.from('evidence from an earlier failed run'));
      expect(fs.readdirSync(workspacePath())).toEqual(['0123456789abcdef.archive-0.zip']);
    });
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
