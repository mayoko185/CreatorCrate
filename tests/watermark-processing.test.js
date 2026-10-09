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
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';
import {
  AssetProcessingError,
  createAssetProcessingService as createAssetProcessingServiceRaw,
} from '../src/services/asset-processing-service.js';
import { replaceStageAfterClose, replaceWithForeignFile } from './helpers/processing-fs-races.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { createAssetProcessingPlanner as createAssetProcessingPlannerRaw } from '../src/services/asset-processing-planner.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { read7zArchiveEntries } from '../src/services/watermark-7z.js';
import { createSourceAnimationService } from '../src/services/source-animation-service.js';
import { inspectSourceAnimation } from '../src/services/source-animation.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { processingRecoveryEvidenceDependencies } from './helpers/processing-recovery-evidence.js';
import { createProcessingRecoveryEvidenceRepository } from '../src/data/processing-recovery-evidence-repository.js';
import { stagingWorkspaces, stageNames, stageArtifact } from './helpers/processing-staging.js';

function createAssetProcessingService(dependencies) {
  const service = createAssetProcessingServiceRaw({
    processingConcurrencyService: createProcessingConcurrencyService({ concurrency: 1 }),
    ...dependencies,
  });
  const watermarkAssets = service.watermarkAssets.bind(service);
  return {
    ...service,
    watermarkAssets(projectId, assetIds, options = {}, ...rest) {
      const outputCategorySlug = options.mode === 'social' ? 'wm-lq' : 'wm';
      return watermarkAssets(projectId, assetIds, { outputCategorySlug, ...options }, ...rest);
    },
  };
}

function createAssetProcessingPlanner(dependencies) {
  const planner = createAssetProcessingPlannerRaw(dependencies);
  const planWatermark = planner.planWatermark.bind(planner);
  return {
    ...planner,
    planWatermark(projectId, scope, options = {}) {
      const outputCategorySlug = options.mode === 'social' ? 'wm-lq' : 'wm';
      return planWatermark(projectId, scope, { outputCategorySlug, ...options });
    },
  };
}

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

function mockCifsLikeOutputStats(outputPaths, {
  deviceMismatch = false,
  includeStagedOriginal = false,
} = {}) {
  const resolvedOutputPaths = new Set(outputPaths.map((outputPath) => path.resolve(outputPath)));
  const isOutputPath = (filePath) => typeof filePath === 'string'
    && (resolvedOutputPaths.has(path.resolve(filePath))
      || (includeStagedOriginal
        && filePath.includes('.creatorcrate-watermark-')
        && filePath.endsWith('.original')));
  const realLstat = fs.lstatSync.bind(fs);
  const realOpen = fs.openSync.bind(fs);
  const realFstat = fs.fstatSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const outputDescriptors = new Set();
  const divergentStats = (stats) => {
    const asStatType = (value) => (typeof stats.ino === 'bigint' ? BigInt(value) : value);
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      dev: deviceMismatch ? (stats.dev === asStatType(0) ? asStatType(1) : asStatType(0)) : stats.dev,
      ino: stats.ino + asStatType(1000000),
    });
  };
  const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
    const stats = realLstat(filePath, ...args);
    return isOutputPath(filePath) ? divergentStats(stats) : stats;
  });
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
    const descriptor = realOpen(filePath, ...args);
    if (isOutputPath(filePath)) outputDescriptors.add(descriptor);
    return descriptor;
  });
  const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
    const stats = realFstat(descriptor, ...args);
    return outputDescriptors.has(descriptor) ? divergentStats(stats) : stats;
  });
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
    outputDescriptors.delete(descriptor);
    return realClose(descriptor, ...args);
  });
  return () => {
    closeSpy.mockRestore();
    fstatSpy.mockRestore();
    openSpy.mockRestore();
    lstatSpy.mockRestore();
  };
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
// foreign file appear), `after(path)` immediately after that descriptor closes. Each hook runs
// only while `when()` holds, and at most `times` times.
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

// Live WP4 SMB timeline (as modelled for archives): the public file's creating descriptor
// reports its write times T1; once that descriptor closes, the pathname reports later
// mtime/ctime T2 with the same exact identity, size, birth time and bytes; the first read-only
// open of the path (the pre-commit hash) refreshes it back to T1, which every later stat
// reports. T1 is the real file's mtime/ctime and T2 is T1 plus the live 20448600 ns step. Only
// bigint mtimeNs/ctimeNs are modelled. `observed` lists the modelled mtimeNs of each bigint
// lstat of the path, in order.
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

// WP3 production NAS trace (project 41, asset 3165, output 6 of nine; Docker in a Debian VM,
// NAS-backed project storage): the pathname mtime (= ctime) reported before the first
// pre-commit hash, after it and after the re-hash, with identity, size and both hashes
// matching. Three distinct values: neither stable nor reverting.
const PRODUCTION_NAS_TIMES = Object.freeze([1791505303076261800n, 1791505302897584100n, 1791505304096824900n]);

// Models that trace: once a matching file's creating descriptor closes, every bigint pathname
// lstat of it reports mtime = ctime = timeAfter(n) after n completed read-only opens of it,
// plus any real change since that close (so a real write still shows). The default reports
// the three production values over the pre-commit hash and re-hash, then holds the last.
// `timeAfter(n, path)` may model each path separately.
// `onReadOpen(path, n)` runs before the n-th (0-based) read-only open of a modelled path;
// `observed` maps each path to its modelled mtimeNs values, in order.
function modelNasWriteTimes(matches, {
  timeAfter = (reads) => PRODUCTION_NAS_TIMES[Math.min(reads, PRODUCTION_NAS_TIMES.length - 1)],
  onReadOpen,
  onLstat,
} = {}) {
  const realOpen = fs.openSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const realLstat = fs.lstatSync.bind(fs);
  const creating = new Map();
  const reading = new Map();
  const closed = new Map();
  const observed = new Map();
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    const state = resolved ? closed.get(resolved) : undefined;
    if (state && flags === 'r') onReadOpen?.(resolved, state.opens++);
    const descriptor = realOpen(filePath, flags, ...args);
    if (state && flags === 'r') reading.set(descriptor, state);
    if (resolved && typeof flags === 'string' && flags.startsWith('wx') && matches(resolved)) {
      creating.set(descriptor, resolved);
    }
    return descriptor;
  });
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
    const created = creating.get(descriptor);
    const result = realClose(descriptor, ...args);
    creating.delete(descriptor);
    const read = reading.get(descriptor);
    reading.delete(descriptor);
    if (read) read.reads += 1;
    if (created) {
      const real = realLstat(created, { bigint: true });
      closed.set(created, { ino: real.ino, real, reads: 0, opens: 0 });
    }
    return result;
  });
  const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
    const stats = realLstat(filePath, ...args);
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    const state = resolved ? closed.get(resolved) : undefined;
    if (!state || typeof stats?.ino !== 'bigint' || stats.ino !== state.ino) return stats;
    const base = timeAfter(state.reads, resolved);
    const modelled = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      mtimeNs: base + (stats.mtimeNs - state.real.mtimeNs), ctimeNs: base + (stats.ctimeNs - state.real.ctimeNs),
    });
    observed.set(resolved, [...(observed.get(resolved) ?? []), modelled.mtimeNs]);
    // Runs after this observation is taken, before the caller acts on it.
    onLstat?.(resolved, modelled);
    return modelled;
  });
  return {
    observed,
    restore() {
      lstatSpy.mockRestore();
      closeSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

// WP3 C4 production NAS trace (project 41, asset 3165, output 6 of nine): identity, size and
// the re-hash matched and the post-rehash mtime (= ctime) held; the final metadata sweep,
// after the later outputs' reads, then reported a later mtime (= ctime) under the same
// dev/ino and size.
const PRODUCTION_FINAL_SWEEP_TIMES = Object.freeze({
  afterRehash: 1791519731780353400n,
  finalSweep: 1791519732993764300n,
});

// WP3 C2 production NAS trace (project 41, asset 3167, output 8 of nine): when publication
// copied the private stage output, its pathname lstat reported mtime = ctime 1040648900 ns
// earlier than the descriptor it then opened, with dev/ino, size and birth time identical.
const PRODUCTION_STAGE_OPEN_LAG_NS = 1791508505669399100n - 1791508504628750200n;

// Models that shape on the real file: immediately before each read-only open of a path accepted
// by `isStage`, its write metadata advances by PRODUCTION_STAGE_OPEN_LAG_NS (utimes: same
// inode, size, birth time and bytes), so a pathname stat taken just before the open reports
// earlier mtime/ctime than the descriptor the open returns, and every later stat agrees with
// that descriptor. `onOpen(path, { copy })` replaces the advance (e.g. to rewrite bytes
// instead); `copy` marks an open preceded by a bigint pathname lstat of that path (the trusted
// copy's source inspection; the stage hash inspects with a Number lstat). `observed` pairs the
// pathname stat just before each open with that descriptor's first bigint fstat. It wraps the
// current fs functions (so it composes with other spies); restore it first.
function modelStageOpenWriteTimeLag(isStage, { onOpen } = {}) {
  const previous = { lstatSync: fs.lstatSync, openSync: fs.openSync, fstatSync: fs.fstatSync };
  const opened = new Map();
  const bigintLstat = new Map();
  const observed = [];
  const advance = (target) => {
    const { atimeMs, mtimeMs } = fs.statSync(target);
    fs.utimesSync(target, atimeMs / 1000, (mtimeMs + Number(PRODUCTION_STAGE_OPEN_LAG_NS / 1000000n)) / 1000);
  };
  fs.lstatSync = (filePath, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    if (resolved && isStage(resolved)) bigintLstat.set(resolved, Boolean(args[0]?.bigint));
    return previous.lstatSync.call(fs, filePath, ...args);
  };
  fs.openSync = (filePath, flags, ...args) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
    const modelled = Boolean(resolved && flags === 'r' && isStage(resolved));
    const copy = modelled && bigintLstat.get(resolved) === true;
    const pathname = modelled ? previous.lstatSync.call(fs, resolved, { bigint: true }) : null;
    if (modelled) (onOpen ?? advance)(resolved, { copy });
    const descriptor = previous.openSync.call(fs, filePath, flags, ...args);
    if (modelled) opened.set(descriptor, pathname);
    else opened.delete(descriptor);
    return descriptor;
  };
  fs.fstatSync = (descriptor, ...args) => {
    const stats = previous.fstatSync.call(fs, descriptor, ...args);
    if (opened.has(descriptor) && typeof stats?.ino === 'bigint') {
      observed.push({ pathname: opened.get(descriptor), descriptor: stats });
      opened.delete(descriptor);
    }
    return stats;
  };
  return {
    observed,
    restore() {
      Object.assign(fs, previous);
    },
  };
}

const exactIdOf = (filePath) => {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
};
const provenanceTupleOf = (filePath) => {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return `v1:${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
};

// Replaces `target` with a same-bytes foreign file (a distinct inode) and returns its exact ino.
function replaceWithSameBytes(target) {
  const bytes = fs.readFileSync(target);
  fs.unlinkSync(target);
  fs.writeFileSync(target, bytes);
  return fs.statSync(target, { bigint: true }).ino;
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
    overrides = {},
  ) {
    return createAssetProcessingService({
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: operationCoordinator,
      watermarkPath: configuredWatermarkPath,
      watermarkRoot: configuredWatermarkRoot,
      ...overrides,
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
      projectOptionCatalogueService: createTestProjectOptionCatalogueService(db),
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
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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

  describe('Watermark recovery evidence', () => {
    const options = { mode: 'custom', outputFormat: 'png' };
    const progress = (jobId = 'watermark-evidence-run') => Object.assign(() => {}, { jobId });
    const repository = () => createProcessingRecoveryEvidenceRepository(db);
    const rows = () => repository().listUnresolvedEvidenceByProject(project.id);
    const groups = () => repository().listMutationGroupsByProject(project.id);
    const outputPath = (name = 'evidence') => path.join(projectDir, 'wm', `${name}_wm.png`);
    const relative = (p) => path.relative(projectDir, p).split(path.sep).join('/');
    const isPrivate = (p) => p.includes('.creatorcrate-watermark-staging');

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
      const service = createConfiguredService(watermarkPath, tmpDir, coordinator, {
        ...processingRecoveryEvidenceDependencies(db, { repository: wrapped }), ...overrides,
      });
      return { service, events };
    }

    function recordFilesystem(events) {
      const realOpen = fs.openSync.bind(fs);
      const realWrite = fs.writeSync.bind(fs);
      const realAsyncWrite = fs.write.bind(fs);
      const realWriteFile = fs.writeFileSync.bind(fs);
      const realAsyncWriteFile = fs.writeFile.bind(fs);
      const realUnlink = fs.unlinkSync.bind(fs);
      const descriptors = new Map();
      const spies = [
        vi.spyOn(fs, 'openSync').mockImplementation((p, flags, ...rest) => {
          const descriptor = realOpen(p, flags, ...rest);
          if (typeof flags === 'string' && flags.startsWith('wx')) {
            const target = path.resolve(String(p));
            descriptors.set(descriptor, target);
            events.push({ type: 'create', path: target });
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
        vi.spyOn(fs, 'writeFileSync').mockImplementation((descriptor, ...rest) => {
          if (descriptors.has(descriptor)) events.push({ type: 'write', path: descriptors.get(descriptor) });
          return realWriteFile(descriptor, ...rest);
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

    it.each(['processingRecoveryEvidenceRecorder', 'processingRecoveryEvidenceRepository'])(
      'rejects a missing %s before any Watermark mutation', async (missing) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        const source = fs.readFileSync(path.join(projectDir, 'Final/evidence.png'));
        const { service, events } = harness({ [missing]: null });
        const restore = recordFilesystem(events);
        let error;
        try { error = await service.watermarkAssets(project.id, [asset.id], options).catch((err) => err); }
        finally { restore(); }
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_UNAVAILABLE' });
        expect(events.filter((event) => ['create', 'unlink'].includes(event.type))).toEqual([]);
        expect(fs.existsSync(path.join(projectDir, '.creatorcrate-watermark-staging'))).toBe(false);
        expect(fs.readFileSync(path.join(projectDir, 'Final/evidence.png'))).toEqual(source);
        expect(rows()).toEqual([]);
        expect(groups()).toEqual([]);
      },
    );

    it('persists intent, descriptor identity, checkpoint and promotions before writes/mutations; cleans a repeated run', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service, events } = harness();
      const restore = recordFilesystem(events);
      let first;
      try { first = await service.watermarkAssets(project.id, [asset.id], options, progress()); }
      finally { restore(); }
      const creations = events.filter((event) => event.type === 'create');
      expect(creations).toHaveLength(2);
      for (const creation of creations) {
        const intentIndex = events.findIndex((event) => event.name === 'createEvidence'
          && event.result.artifactPath === relative(creation.path));
        const id = events[intentIndex].result.evidenceId;
        const identityIndex = events.findIndex((event) => event.name === 'attachEvidenceIdentity' && event.args[1] === id);
        const writeIndex = events.findIndex((event) => event.type === 'write' && event.path === creation.path);
        expect(intentIndex).toBeGreaterThan(-1);
        expect(intentIndex).toBeLessThan(events.indexOf(creation));
        expect(identityIndex).toBeGreaterThan(events.indexOf(creation));
        expect(identityIndex).toBeLessThan(writeIndex);
        expect(events[identityIndex].inTransaction).toBe(false);
        expect(events[intentIndex].result).toMatchObject({ assetId: asset.id, runId: 'watermark-evidence-run', operation: 'watermark' });
      }
      const checkpoint = events.findIndex((event) => event.name === 'markMutationCheckpoint');
      const promotion = events.findIndex((event) => event.name === 'setEvidenceLifecycle' && event.args[2] === 'recovery-critical');
      const publicCreate = events.findIndex((event) => event.type === 'create' && event.path === outputPath());
      expect(checkpoint).toBeGreaterThan(-1);
      expect(promotion).toBeGreaterThan(-1);
      expect(checkpoint).toBeLessThan(promotion);
      expect(promotion).toBeLessThan(publicCreate);
      expect(events.filter((event) => event.name === 'clearMutationCheckpoint').every((event) => !event.inTransaction)).toBe(true);
      expect(events.some((event) => event.name === 'setEvidenceLifecycle' && event.args[2] === 'dispensable'
        && event.inTransaction)).toBe(true);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
      const { service: secondService, events: secondEvents } = harness();
      const second = await secondService.watermarkAssets(project.id, [asset.id], { ...options, overwrite: true }, progress('second-run'));
      expect(second.generatedAssetIds).toEqual(first.generatedAssetIds);
      expect(secondEvents.filter((event) => event.name === 'createMutationGroup').map((event) => event.result)).toEqual([
        expect.objectContaining({ runId: 'second-run', itemKey: `asset:${asset.id}` }),
      ]);
      const backup = secondEvents.find((event) => event.name === 'createEvidence' && event.result.artifactRole === 'destination-backup');
      expect(backup.result.destinationPath).toBe('wm/evidence_wm.png');
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, first.generatedAssetIds[0])).toBeTruthy();
    });

    it.each(['group', 'stage-intent', 'stage-identity', 'public-intent', 'checkpoint', 'promotion'])(
      'halts public mutation on %s persistence failure', async (stage) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        let failed = false;
        const { service, events } = harness({ fail: {
          createMutationGroup: () => stage === 'group',
          createEvidence: ([intent]) => (stage === 'stage-intent' && intent.artifactRole === 'stage-output')
            || (stage === 'public-intent' && intent.artifactRole === 'published-output'),
          attachEvidenceIdentity: (_args, { roleOf }) => stage === 'stage-identity' && roleOf(_args[1]) === 'stage-output',
          markMutationCheckpoint: () => stage === 'checkpoint',
          setEvidenceLifecycle: ([, , lifecycle]) => {
            if (stage === 'promotion' && lifecycle === 'recovery-critical' && !failed) { failed = true; return true; }
            return false;
          },
        } });
        const restore = recordFilesystem(events);
        let error;
        try { error = await service.watermarkAssets(project.id, [asset.id], options, progress()).catch((err) => err); }
        finally { restore(); }
        expect(error).toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' });
        expect(events.filter((event) => event.type === 'create' && !isPrivate(event.path))).toEqual([]);
        expect(events.filter((event) => event.type === 'unlink' && !isPrivate(event.path))).toEqual([]);
        expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/evidence_wm.png')).toBeFalsy();
        if (['group', 'stage-intent'].includes(stage)) expect(events.filter((event) => event.type === 'create')).toEqual([]);
        if (stage === 'group') expect(fs.existsSync(path.join(projectDir, '.creatorcrate-watermark-staging'))).toBe(false);
        if (stage === 'checkpoint') expect(events.filter((event) => event.name === 'setEvidenceLifecycle'
          && event.args[2] === 'recovery-critical')).toEqual([]);
        if (stage === 'promotion') {
          expect(groups()).toEqual([expect.objectContaining({ checkpoint: 'public-create' })]);
          expect(rows().find((row) => row.artifactRole === 'stage-output').lifecycle).toBe('intent');
        }
      },
    );

    it.each(['destination-backup', 'staged-original'])(
      'maps %s before unlink and retains it as recovery-critical when restoration fails', async (role) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        if (role === 'destination-backup') await processingService.watermarkAssets(project.id, [asset.id], options);
        const target = role === 'destination-backup' ? outputPath() : path.join(projectDir, 'Final/evidence.png');
        const old = fs.readFileSync(target);
        const { service, events } = harness();
        const apply = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
          if (role === 'destination-backup') replaceWithForeignFile(target, Buffer.from('foreign occupant'));
          else fs.writeFileSync(target, 'foreign occupant');
          throw new Error('injected database failure');
        });
        let error;
        try {
          error = await service.watermarkAssets(project.id, [asset.id], {
            ...options, overwrite: role === 'destination-backup', deleteSource: role === 'staged-original',
          }, progress()).catch((err) => err);
        } finally { apply.mockRestore(); }
        expect(error.code).toBe('RECOVERY_REQUIRED');
        const row = rows().find((evidence) => evidence.artifactRole === role);
        expect(row).toMatchObject({
          projectId: project.id, assetId: asset.id, operation: 'watermark', runId: 'watermark-evidence-run',
          artifactRole: role, sourcePath: 'Final/evidence.png',
          destinationPath: role === 'destination-backup' ? 'wm/evidence_wm.png' : 'Final/evidence.png',
          expectedSize: old.length, expectedSha256: createHash('sha256').update(old).digest('hex'),
          lifecycle: 'recovery-critical', observation: 'present',
          retentionReason: role === 'destination-backup' ? 'watermark-restoration-failed' : 'watermark-source-restoration-failed',
        });
        expect(row.artifactPath).toMatch(/^\.creatorcrate-watermark-staging\//);
        const artifact = path.join(projectDir, ...row.artifactPath.split('/'));
        expect(fs.readFileSync(artifact)).toEqual(old);
        const identity = exactIdOf(artifact);
        expect(row.identity).toMatchObject({ dev: String(identity.dev), ino: String(identity.ino) });
        expect(groups()[0]).toMatchObject({ groupId: row.mutationGroupId, itemKey: `asset:${asset.id}` });
        expect(groups()[0].checkpoint).not.toBeNull();
        const identityEvent = events.findIndex((event) => event.name === 'attachEvidenceIdentity' && event.args[1] === row.evidenceId);
        const checkpoint = events.findIndex((event) => event.name === 'markMutationCheckpoint'
          && event.args[2] === (role === 'destination-backup' ? 'replace' : 'unlink'));
        expect(identityEvent).toBeLessThan(checkpoint);
      },
    );

    it('keeps a created but unclaimed public output untouched, with null identity and its checkpoint', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service } = harness();
      const restore = mockStatOverrides((p) => p === outputPath() ? { ino: 0n } : null);
      const apply = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      const unlink = vi.spyOn(fs, 'unlinkSync');
      let error;
      try {
        error = await service.watermarkAssets(project.id, [asset.id], options, progress()).catch((err) => err);
        expect(apply).not.toHaveBeenCalled();
        expect(unlink.mock.calls.map(([p]) => path.resolve(p))).not.toContain(outputPath());
      } finally { unlink.mockRestore(); apply.mockRestore(); restore(); }
      expect(error.code).toBe('RECOVERY_REQUIRED');
      expect(fs.statSync(outputPath()).size).toBe(0);
      expect(rows().find((row) => row.artifactRole === 'published-output')).toMatchObject({
        projectId: project.id, assetId: asset.id, runId: 'watermark-evidence-run', operation: 'watermark',
        artifactPath: 'wm/evidence_wm.png', identity: null, lifecycle: 'recovery-critical',
        observation: 'ownership-unknown', retentionReason: 'watermark-public-created-unclaimed',
      });
      expect(groups()[0].checkpoint).toBe('public-create');
    });

    it('rolls asset/provenance changes back when evidence finalization fails in the same transaction', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      let during;
      const { service } = harness({ fail: { setEvidenceLifecycle: ([, id, lifecycle]) => {
        if (db.inTransaction && lifecycle === 'dispensable'
          && repository().findEvidence(project.id, id)?.retentionReason === 'watermark-committed') {
          during = assetRepository.findByProjectIdAndPath(project.id, 'wm/evidence_wm.png');
          expect(assetRepository.findGeneratedOutputProvenance(project.id, during.id)).toBeTruthy();
          return true;
        }
        return false;
      } } });
      const error = await service.watermarkAssets(project.id, [asset.id], options).catch((err) => err);
      expect(during).toBeTruthy();
      expect(error).toMatchObject({ code: 'DATABASE_OPERATION_FAILED', cause: { code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' } });
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/evidence_wm.png')).toBeFalsy();
      expect(assetRepository.findGeneratedOutputProvenance(project.id, during.id)).toBeNull();
      expect(fs.existsSync(outputPath())).toBe(false);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
    });

    it.each(['resolution', 'public-deletion', 'private-deletion', 'group-deletion'])(
      'preserves committed output/DB/provenance on post-commit %s failure', async (stage) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        const { service, events } = harness({ fail: {
          clearMutationCheckpoint: () => stage === 'resolution',
          deleteEvidence: ([, id], { roleOf }) => stage === 'public-deletion' ? roleOf(id) === 'published-output'
            : stage === 'private-deletion' && roleOf(id) === 'stage-output',
          deleteMutationGroup: () => stage === 'group-deletion',
        } });
        const restore = recordFilesystem(events);
        let error;
        try { error = await service.watermarkAssets(project.id, [asset.id], options, progress()).catch((err) => err); }
        finally { restore(); }
        expect(error.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
        expect(events.filter((event) => event.type === 'unlink' && event.path === outputPath())).toEqual([]);
        const output = assetRepository.findByProjectIdAndPath(project.id, 'wm/evidence_wm.png');
        expect(output).toBeTruthy();
        expect(fs.existsSync(outputPath())).toBe(true);
        expect(assetRepository.findGeneratedOutputProvenance(project.id, output.id)).toBeTruthy();
        if (stage === 'resolution') {
          expect(groups()[0].checkpoint).toBe('public-create');
          expect(rows().find((row) => row.artifactRole === 'stage-output').lifecycle).toBe('dispensable');
          expect(rows()).toHaveLength(2);
        } else expect(groups()[0].checkpoint).toBeNull();
      },
    );

    it.each(['present', 'missing', 'replaced', 'unavailable'])(
      'records safe cleanup residue from the existing %s diagnostic', async (observation) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        const { service } = harness();
        const realUnlink = fs.unlinkSync.bind(fs);
        const realLstat = fs.lstatSync.bind(fs);
        let failedPath;
        let originalRow;
        const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((p, ...rest) => {
          if (isPrivate(String(p)) && String(p).endsWith('.output')) {
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
        try { result = await service.watermarkAssets(project.id, [asset.id], options, progress()); }
        finally { lstat.mockRestore(); unlink.mockRestore(); }
        expect(result.status).toBe('completed');
        expect(rows()).toEqual([expect.objectContaining({
          evidenceId: originalRow.evidenceId, identity: originalRow.identity,
          lifecycle: 'dispensable', retentionReason: 'watermark-cleanup-residue', observation,
        })]);
        expect(groups()[0].checkpoint).toBeNull();
      },
    );

    it.each(['destination-backup', 'staged-original'])(
      'blocks the protected unlink when %s intent or identity persistence fails', async (role) => {
        const asset = await writeIndexedImage('Final/evidence.png');
        if (role === 'destination-backup') await processingService.watermarkAssets(project.id, [asset.id], options);
        const target = role === 'destination-backup' ? outputPath() : path.join(projectDir, 'Final/evidence.png');
        const bytes = fs.readFileSync(target);
        for (const stage of ['intent', 'identity']) {
          const { service, events } = harness({ fail: {
            createEvidence: ([intent]) => stage === 'intent' && intent.artifactRole === role,
            attachEvidenceIdentity: ([, id], { roleOf }) => stage === 'identity' && roleOf(id) === role,
          } });
          const restore = recordFilesystem(events);
          let error;
          try {
            error = await service.watermarkAssets(project.id, [asset.id], {
              ...options, overwrite: role === 'destination-backup', deleteSource: role === 'staged-original',
            }, progress()).catch((err) => err);
          } finally { restore(); }
          expect(error.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
          expect(events.filter((event) => event.type === 'unlink' && event.path === target)).toEqual([]);
          expect(fs.readFileSync(target)).toEqual(bytes);
          if (stage === 'intent') expect(events.filter((event) => event.type === 'create'
            && event.path.endsWith(role === 'destination-backup' ? '.destination' : '.original'))).toEqual([]);
          expect(rows()).toEqual([]);
          expect(groups()).toEqual([]);
        }
      },
    );

    it('retains a created but unclaimed private stage as safe ownership-unknown residue', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service } = harness();
      const restore = mockStatOverrides((p) => isPrivate(p) && p.endsWith('.output') ? { ino: 0n } : null);
      let error;
      try { error = await service.watermarkAssets(project.id, [asset.id], options, progress()).catch((err) => err); }
      finally { restore(); }
      expect(error).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED',
        recoveryDiagnostics: { restored: true, cleanupSucceeded: false } });
      expect(rows()).toEqual([expect.objectContaining({ identity: null, lifecycle: 'dispensable',
        observation: 'ownership-unknown', retentionReason: 'watermark-cleanup-residue' })]);
      expect(groups()[0].checkpoint).toBeNull();
      expect(fs.existsSync(outputPath())).toBe(false);
    });

    it('settles a private identity-write failure with failed safe discard before an ordinary downgrade', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service } = harness({ fail: { attachEvidenceIdentity: ([, id], { roleOf }) => roleOf(id) === 'stage-output' } });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((p, ...rest) => {
        if (isPrivate(String(p))) throw Object.assign(new Error('injected unlink failure'), { code: 'EIO' });
        return realUnlink(p, ...rest);
      });
      let error;
      try { error = await service.watermarkAssets(project.id, [asset.id], options, progress()).catch((err) => err); }
      finally { unlink.mockRestore(); }
      expect(error).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED', cause: { code: 'RECOVERY_REQUIRED' } });
      expect(rows()).toEqual([expect.objectContaining({ identity: null, observation: 'ownership-unknown',
        lifecycle: 'dispensable', retentionReason: 'watermark-cleanup-residue' })]);
      expect(groups()[0].checkpoint).toBeNull();
      expect(fs.existsSync(outputPath())).toBe(false);
    });

    it.each([false, true])('requires accurate observation settlement on safe residue (committed=%s)', async (committed) => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service } = harness({ fail: { setEvidenceObservation: ([, , observation]) => observation === 'missing' } });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((p, ...rest) => {
        if (isPrivate(String(p)) && String(p).endsWith('.output')) {
          realUnlink(p);
          throw Object.assign(new Error('injected cleanup error'), { code: 'EIO' });
        }
        return realUnlink(p, ...rest);
      });
      const apply = !committed ? vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        throw new Error('injected database failure');
      }) : null;
      let error;
      try { error = await service.watermarkAssets(project.id, [asset.id], options, progress()).catch((err) => err); }
      finally { apply?.mockRestore(); unlink.mockRestore(); }
      expect(error.code).toBe('RECOVERY_EVIDENCE_PERSISTENCE_FAILED');
      expect(fs.existsSync(outputPath())).toBe(committed);
      expect(Boolean(assetRepository.findByProjectIdAndPath(project.id, 'wm/evidence_wm.png'))).toBe(committed);
      expect(rows().find((row) => row.artifactRole === 'stage-output')).toMatchObject({
        lifecycle: 'dispensable', retentionReason: 'watermark-cleanup-residue', observation: 'unchecked',
      });
    });

    it('keeps RECOVERY_REQUIRED primary if an unresolved public observation cannot persist', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service } = harness({ fail: { setEvidenceObservation: () => true } });
      const restore = mockStatOverrides((p) => p === outputPath() ? { ino: 0n } : null);
      let error;
      try { error = await service.watermarkAssets(project.id, [asset.id], options, progress()).catch((err) => err); }
      finally { restore(); }
      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED',
        observationFailure: { code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' } });
      expect(groups()[0].checkpoint).not.toBeNull();
      expect(fs.existsSync(outputPath())).toBe(true);
    });

    it('keeps the destination backup protected if restored provenance reconciliation fails', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      await processingService.watermarkAssets(project.id, [asset.id], options);
      const bytes = fs.readFileSync(outputPath());
      const { service } = harness();
      const apply = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => { throw new Error('index failure'); });
      const reconcile = vi.spyOn(assetRepository, 'reconcileGeneratedOutputProvenance').mockImplementation(() => { throw new Error('reconcile failure'); });
      let error;
      try {
        error = await service.watermarkAssets(project.id, [asset.id], { ...options, overwrite: true }, progress()).catch((err) => err);
      } finally { reconcile.mockRestore(); apply.mockRestore(); }
      expect(error.code).toBe('RECOVERY_REQUIRED');
      expect(fs.readFileSync(outputPath())).toEqual(bytes);
      expect(rows().find((row) => row.artifactRole === 'destination-backup')).toMatchObject({
        lifecycle: 'recovery-critical', observation: 'present', retentionReason: 'watermark-provenance-reconciliation-failed',
      });
      expect(groups()[0].checkpoint).toBe('replace');
    });

    it('keeps source variants in one group and isolates another asset during a cross-item recovery failure', async () => {
      const a = await writeIndexedImage('Final/evidence.png', { width: 400, height: 240 });
      const b = await writeIndexedImage('Final/second.png', { width: 400, height: 240 });
      const { service, events } = harness();
      const apply = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        replaceWithForeignFile(outputPath(), Buffer.from('foreign output'));
        throw new Error('injected database failure');
      });
      let error;
      try {
        error = await service.watermarkAssets(project.id, [a.id, b.id], {
          ...options, maxDimension: 100, alsoUnresized: true, deleteSource: true,
        }, progress()).catch((err) => err);
      } finally { apply.mockRestore(); }
      expect(error.code).toBe('RECOVERY_REQUIRED');
      const started = events.filter((event) => event.name === 'createMutationGroup').map((event) => event.result);
      expect(started).toHaveLength(2);
      expect(started.map((group) => group.runId)).toEqual(['watermark-evidence-run', 'watermark-evidence-run']);
      expect(new Set(started.map((group) => group.groupId)).size).toBe(2);
      expect(groups()).toHaveLength(1);
      expect(groups()[0].itemKey).toBe(`asset:${a.id}`);
      expect(rows().every((row) => row.assetId === a.id && row.mutationGroupId === groups()[0].groupId)).toBe(true);
      expect(rows().some((row) => row.lifecycle === 'recovery-critical')).toBe(true);
      expect(events.filter((event) => event.name === 'createEvidence' && event.result.artifactRole === 'staged-original')).toHaveLength(2);
    });

    it('rolls core Watermark and separate Archive evidence back after an archive-side failure', async () => {
      const asset = await writeIndexedImage('Final/evidence.png');
      const { service, events } = harness();
      const hook = hookOwnedCreate((p) => !isPrivate(p) && p.endsWith('.zip'), {
        before: () => { throw Object.assign(new Error('injected archive failure'), { code: 'EIO' }); },
      });
      let error;
      try {
        error = await service.watermarkAssets(project.id, [asset.id], { ...options, makeArchives: true }, progress()).catch((err) => err);
      } finally { hook.restore(); }
      expect(hook.calls).toBeGreaterThan(0);
      expect(error.code).not.toBe('RECOVERY_REQUIRED');
      const intents = events.filter((event) => event.name === 'createEvidence').map((event) => event.result);
      expect(intents.filter((row) => row.operation === 'watermark').map((row) => row.artifactRole))
        .toEqual(['stage-output', 'published-output']);
      expect(intents.filter((row) => row.operation === 'archive').map((row) => row.artifactRole))
        .toEqual(['archive-stage', 'archive-stage', 'published-archive']);
      expect(intents.every((row) => row.runId === 'watermark-evidence-run')).toBe(true);
      expect(rows()).toEqual([]);
      expect(groups()).toEqual([]);
      expect(fs.existsSync(outputPath())).toBe(false);
    });
  });

  function createDeferredSourceSharp(sourceBuffers, onStage) {
    const sourceLabels = new Map(sourceBuffers.map(([label, buffer]) => [buffer.toString('base64'), label]));
    return (input, ...args) => {
      const label = Buffer.isBuffer(input) ? sourceLabels.get(input.toString('base64')) : null;
      const image = sharp(input, ...args);
      if (!label) return image;
      const toBuffer = image.toBuffer.bind(image);
      image.toBuffer = (...toBufferArgs) => Promise.resolve(onStage(label))
        .then(() => toBuffer(...toBufferArgs));
      return image;
    };
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
      `wm/${sourceName}_wm.png`,
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

  it('creates a Patreon output at the selected category root and preserves the source', async () => {
    const source = await writeIndexedImage('Final/patreon.png', { width: 1000, height: 600 });
    const progress = [];

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      opacity: 100,
      margin: 0.02,
    }, (snapshot) => progress.push(snapshot));

    expect(progress).toEqual([{ completed: 0, total: 1 }, { completed: 1, total: 1 }]);

    const output = assetRepository.findByProjectIdAndPath(project.id, 'wm/patreon_wm.png');
    const wmCategory = assetCategoryService.listProjectCategories(project.id)
      .find((category) => category.directory_slug === 'wm');
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
      category_id: wmCategory.id,
      nested_path: '',
      generated_by: 'watermark',
      generated_source_asset_id: source.id,
      generated_source_relative_path: 'Final/patreon.png',
      generated_mode: 'patreon',
      generated_output_sha256: sha256For(path.join(projectDir, 'wm', 'patreon_wm.png')),
      is_present: 1,
    });
    expect(fs.existsSync(path.join(projectDir, 'Final', 'patreon.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'wm', 'patreon_wm.png'))).toBe(true);
    expect((await metadataFor(path.join(projectDir, 'wm', 'patreon_wm.png'))).format).toBe('png');
  });

  it('uses the injected shared limiter for bounded Watermark staging and preserves plan order', async () => {
    const first = await writeIndexedImage('Final/parallel-first.png', { width: 101 });
    const second = await writeIndexedImage('Final/parallel-second.png', { width: 102 });
    const sourceBuffers = [
      ['first', fs.readFileSync(path.join(projectDir, 'Final', 'parallel-first.png'))],
      ['second', fs.readFileSync(path.join(projectDir, 'Final', 'parallel-second.png'))],
    ];
    const bounded = createProcessingConcurrencyService({ concurrency: 2 });
    const injectedPool = { mapBounded: vi.fn(bounded.mapBounded) };
    const deferred = new Map();
    let active = 0;
    let maxActive = 0;
    let resolveBothStarted;
    const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve; });
    const controlledSharp = createDeferredSourceSharp(sourceBuffers, (label) => {
      if (deferred.has(label)) return undefined;
      return new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        deferred.set(label, () => {
          active -= 1;
          resolve();
        });
        if (deferred.size === 2) resolveBothStarted();
      });
    });
    const service = createConfiguredService(watermarkPath, tmpDir, coordinator, {
      processingConcurrencyService: injectedPool,
      sharpImplementation: controlledSharp,
    });
    const progress = [];
    const resultPromise = service.watermarkAssets(project.id, [first.id, second.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    }, (snapshot) => progress.push(snapshot));

    await bothStarted;
    expect(maxActive).toBe(2);
    expect(injectedPool.mapBounded).toHaveBeenCalledTimes(1);
    expect(deferred.has('first')).toBe(true);
    expect(deferred.has('second')).toBe(true);

    deferred.get('second')();
    await Promise.resolve();
    deferred.get('first')();
    const result = await resultPromise;

    expect(result.generatedPaths).toEqual([
      'wm/parallel-first_wm.png',
      'wm/parallel-second_wm.png',
    ]);
    expect(result.sourceResults.map((source) => source.assetId)).toEqual([first.id, second.id]);
    expect(progress).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
  });

  it('counts a multi-output Watermark source only after all of its staging completes', async () => {
    const source = await writeIndexedImage('Final/multi-output.png');
    const sourceBuffer = fs.readFileSync(path.join(projectDir, 'Final', 'multi-output.png'));
    const deferred = [];
    let releaseFirst;
    let releaseSecond;
    const firstStage = new Promise((resolve) => { releaseFirst = resolve; });
    const secondStage = new Promise((resolve) => { releaseSecond = resolve; });
    const service = createConfiguredService(watermarkPath, tmpDir, coordinator, {
      processingConcurrencyService: createProcessingConcurrencyService({ concurrency: 2 }),
      sharpImplementation: createDeferredSourceSharp([['source', sourceBuffer]], () => {
        const next = deferred.length;
        deferred.push(next);
        return next === 0 ? firstStage : secondStage;
      }),
    });
    const progress = [];
    const resultPromise = service.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      primaryFormat: 'png',
      secondaryFormat: 'jpeg',
      resizedFormat: null,
      deleteSource: false,
    }, (snapshot) => progress.push(snapshot));

    await vi.waitFor(() => expect(deferred).toEqual([0]));
    expect(progress).toEqual([{ completed: 0, total: 1 }]);
    releaseFirst();
    await vi.waitFor(() => expect(deferred).toEqual([0, 1]));
    expect(progress).toEqual([{ completed: 0, total: 1 }]);
    releaseSecond();
    const result = await resultPromise;

    expect(result.generatedPaths).toEqual([
      'wm/multi-output_wm.png',
      'wm/multi-output_wm.jpg',
    ]);
    expect(progress).toEqual([{ completed: 0, total: 1 }, { completed: 1, total: 1 }]);
  });

  it('keeps Watermark source staging serial in input order with concurrency one', async () => {
    const first = await writeIndexedImage('Final/serial-first.png', { width: 103 });
    const second = await writeIndexedImage('Final/serial-second.png', { width: 104 });
    const sourceBuffers = [
      ['first', fs.readFileSync(path.join(projectDir, 'Final', 'serial-first.png'))],
      ['second', fs.readFileSync(path.join(projectDir, 'Final', 'serial-second.png'))],
    ];
    const stages = [];
    const service = createConfiguredService(watermarkPath, tmpDir, coordinator, {
      processingConcurrencyService: createProcessingConcurrencyService({ concurrency: 1 }),
      sharpImplementation: createDeferredSourceSharp(sourceBuffers, async (label) => {
        stages.push(label);
      }),
    });

    const result = await service.watermarkAssets(project.id, [first.id, second.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });

    const firstSecondStage = stages.indexOf('second');
    expect(firstSecondStage).toBeGreaterThan(0);
    expect(stages.slice(0, firstSecondStage)).toEqual(expect.arrayContaining(['first']));
    expect(stages.slice(0, firstSecondStage)).not.toContain('second');
    expect(stages.slice(firstSecondStage)).not.toContain('first');
    expect(result.generatedPaths).toEqual([
      'wm/serial-first_wm.png',
      'wm/serial-second_wm.png',
    ]);
  });

  it('drains active Watermark staging before rollback and preserves the processing error', async () => {
    const first = await writeIndexedImage('Final/failing-first.png', { width: 105 });
    const second = await writeIndexedImage('Final/active-second.png', { width: 106 });
    const third = await writeIndexedImage('Final/queued-third.png', { width: 107 });
    const sourceBuffers = [
      ['first', fs.readFileSync(path.join(projectDir, 'Final', 'failing-first.png'))],
      ['second', fs.readFileSync(path.join(projectDir, 'Final', 'active-second.png'))],
      ['third', fs.readFileSync(path.join(projectDir, 'Final', 'queued-third.png'))],
    ];
    let releaseSecond;
    const secondStage = new Promise((resolve) => { releaseSecond = resolve; });
    const started = [];
    const service = createConfiguredService(watermarkPath, tmpDir, coordinator, {
      processingConcurrencyService: createProcessingConcurrencyService({ concurrency: 2 }),
      sharpImplementation: createDeferredSourceSharp(sourceBuffers, (label) => {
        started.push(label);
        if (label === 'first') return Promise.reject(new Error('first staging failure'));
        if (label === 'second') return secondStage;
        throw new Error('Queued third worker started after failure.');
      }),
    });
    let settled = false;
    const operation = service.watermarkAssets(project.id, [first.id, second.id, third.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });
    operation.finally(() => { settled = true; }).catch(() => {});

    await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining(['first', 'second'])));
    await vi.waitFor(() => expect(started).not.toContain('third'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'wm', 'active-second_wm.png'))).toBe(false);

    releaseSecond();
    await expect(operation).rejects.toMatchObject({
      code: 'WATERMARK_PROCESSING_FAILED',
      cause: expect.objectContaining({ code: 'WATERMARK_PROCESSING_FAILED' }),
    });
    expect(started).not.toContain('third');
    expect(fs.existsSync(path.join(projectDir, 'wm', 'failing-first_wm.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'wm', 'active-second_wm.png'))).toBe(false);
  });

  it('rejects unavailable and path-like output category values during Apply', async () => {
    const source = await writeIndexedImage('Final/category-validation.png');
    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon', outputCategorySlug: 'missing-category',
    })).rejects.toMatchObject({ code: 'OUTPUT_CATEGORY_NOT_FOUND' });
    await expect(processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon', outputCategorySlug: '../outside',
    })).rejects.toMatchObject({ code: 'INVALID_OUTPUT_CATEGORY' });
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
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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
    const output = assetRepository.findByProjectIdAndPath(project.id, 'wm/managed_wm.png');
    expect(output.generated_watermark_id).toBe(managedA.id);

    await expect(managedService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      watermarkId: managedB.id,
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
  });

  it('uses the canonical scale map during Apply and ignores a historical request ID', async () => {
    const scaleMapRepository = createWatermarkScaleMapRepository(db);
    const scaleMapService = createWatermarkScaleMapService({ repository: scaleMapRepository });
    const canonicalId = Number(db.prepare(`
      INSERT INTO watermark_scale_maps (display_name, system_key, definition_json)
      VALUES ('Reference', 'reference-watermark-scale-map', '{"100x60":0.35,"default":0.1}')
    `).run().lastInsertRowid);
    const historicalId = Number(db.prepare(`
      INSERT INTO watermark_scale_maps (display_name, definition_json)
      VALUES ('Historical map', '{"100x60":0.9,"default":0.1}')
    `).run().lastInsertRowid);
    const managedService = createAssetProcessingService({
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectRepository, assetRepository, generatedArtifactRepository, assetCategoryService, projectsRoot,
      projectOperationCoordinator: coordinator, watermarkPath, watermarkRoot: tmpDir, scaleMapService,
    });
    const first = await writeIndexedImage('Final/managed-scale-a.png', { width: 100, height: 60 });
    const second = await writeIndexedImage('Final/managed-scale-b.png', { width: 100, height: 60 });

    await expect(managedService.watermarkAssets(project.id, [first.id], {
      mode: 'custom', outputFormat: 'png', deleteSource: false, scaleMapId: canonicalId,
    })).resolves.toMatchObject({ status: 'completed', generatedCount: 1 });
    await expect(managedService.watermarkAssets(project.id, [second.id], {
      mode: 'custom', outputFormat: 'png', deleteSource: false, scaleMapId: historicalId,
    })).resolves.toMatchObject({ status: 'completed', generatedCount: 1 });
    expect(db.prepare('SELECT definition_json FROM watermark_scale_maps WHERE id = ?').get(historicalId))
      .toEqual({ definition_json: '{"100x60":0.9,"default":0.1}' });
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
    const outputPath = path.join(projectDir, 'wm', 'image_wm.png');
    const priorOutput = assetRepository.findById(first.generatedAssetIds[0]);

    fs.unlinkSync(outputPath);
    assetScanner.scanProjectAssets(project.id);
    const missingOutput = assetRepository.findByProjectIdAndPath(
      project.id,
      'wm/image_wm.png',
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
      'wm/image_wm.png',
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

  async function makeAnimatedWebp() {
    const frameData = Buffer.from([
      255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0,
      0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255,
    ]);
    return sharp(frameData, {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  }

  // Generate, optionally prepare the settled row, delete the output, scan it
  // missing, then recreate it through the real Watermark pipeline. The one
  // recreation must leave nothing for scanner or Preview reconciliation.
  async function recreateMissingOutput(name, outputFormat, prepare = () => {}) {
    const source = await writeIndexedImage(`final/${name}.png`);
    const options = { mode: 'patreon', outputFormat, deleteSource: false };
    const first = await processingService.watermarkAssets(project.id, [source.id], options);
    const outputId = first.generatedAssetIds[0];
    const outputPath = path.join(projectDir, 'wm', `${name}_wm.${outputFormat}`);
    await prepare(outputPath);
    fs.unlinkSync(outputPath);
    assetScanner.scanProjectAssets(project.id);
    const before = assetRepository.findById(outputId);
    expect(before).toMatchObject({ is_present: 0 });

    const rerun = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
    expect(rerun.generatedAssetIds).toEqual([outputId]);
    const recreated = assetRepository.findById(outputId);
    expect(recreated).toMatchObject({
      is_present: 1,
      size_bytes: fs.statSync(outputPath).size,
      modified_at: fs.statSync(outputPath).mtime.toISOString(),
      generated_output_sha256: sha256For(outputPath),
      source_generation: before.source_generation + 1,
    });

    const revision = buildAssetRevisionToken(recreated);
    expect(revision).not.toBe(buildAssetRevisionToken(before));
    assetScanner.scanProjectAssets(project.id);
    expect(assetRepository.findById(outputId)).toEqual(recreated);
    const sourceAnimation = createSourceAnimationService({ assetRepository, projectRepository, projectsRoot, projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db) });
    expect(sourceAnimation.reconcileSource(recreated)).toBeNull();
    expect(assetRepository.findById(outputId)).toEqual(recreated);
    expect(buildAssetRevisionToken(assetRepository.findById(outputId))).toBe(revision);
    return { before, recreated, outputPath };
  }

  it('records a recreated still WebP over an animated replacement in its one generation advance', async () => {
    const animated = await makeAnimatedWebp();
    const { before, recreated, outputPath } = await recreateMissingOutput('animated-replaced', 'webp', (outputPath) => {
      fs.writeFileSync(outputPath, animated);
      assetScanner.scanProjectAssets(project.id);
    });
    expect(before).toMatchObject({ source_animated: 1 });
    expect((await metadataFor(outputPath)).pages ?? 1).toBe(1);
    expect(inspectSourceAnimation(outputPath, 'webp')).toBe(false);
    expect(recreated).toMatchObject({ source_animated: 0, source_generation: before.source_generation + 1 });
  });

  it('records a recreated still WebP over a still classification in one generation advance', async () => {
    const { before, recreated } = await recreateMissingOutput('still-recreated', 'webp', () => {
      assetScanner.scanProjectAssets(project.id);
    });
    expect(before).toMatchObject({ source_animated: 0 });
    expect(recreated).toMatchObject({ source_animated: 0 });
  });

  it('classifies a recreated WebP over an unknown legacy classification in one generation advance', async () => {
    const { before, recreated } = await recreateMissingOutput('legacy-recreated', 'webp');
    expect(before).toMatchObject({ source_animated: null });
    expect(recreated).toMatchObject({ source_animated: 0 });
  });

  it.each(['png', 'jpg'])('keeps a recreated %s output unclassified like the scanner', async (outputFormat) => {
    const { recreated } = await recreateMissingOutput(`format-${outputFormat}`, outputFormat, () => {
      assetScanner.scanProjectAssets(project.id);
    });
    expect(recreated).toMatchObject({ source_animated: null });
  });

  it('rejects and recovers a replacement whose destination authority advanced during rendering', async () => {
    const source = await writeIndexedImage('final/raced.png');
    const options = { mode: 'patreon', deleteSource: false };
    const first = await processingService.watermarkAssets(project.id, [source.id], options);
    const outputId = first.generatedAssetIds[0];
    const outputPath = path.join(projectDir, 'wm', 'raced_wm.png');
    const priorHash = sha256For(outputPath);
    // Same bytes (generated ownership still matches), new mtime not yet indexed.
    fs.utimesSync(outputPath, new Date('2026-03-01T00:00:00.000Z'), new Date('2026-03-01T00:00:00.000Z'));
    const captured = assetRepository.findById(outputId);

    // Request-time Preview reconciliation runs while watermark rendering is
    // underway; it is not serialized by the project operation lock.
    const sourceAnimation = createSourceAnimationService({ assetRepository, projectRepository, projectsRoot, projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db) });
    let reconciled;
    const pool = createProcessingConcurrencyService({ concurrency: 1 });
    const racingService = createConfiguredService(watermarkPath, tmpDir, coordinator, {
      processingConcurrencyService: {
        ...pool,
        mapBounded(items, worker) {
          reconciled = sourceAnimation.reconcileSource(assetRepository.findById(outputId));
          return pool.mapBounded(items, worker);
        },
      },
    });

    const failure = await racingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true })
      .catch((err) => err);
    expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    expect(failure.cause).toMatchObject({ code: 'STALE_STATE' });

    expect(reconciled).toMatchObject({
      modified_at: '2026-03-01T00:00:00.000Z',
      source_generation: captured.source_generation + 1,
      generated_output_sha256: priorHash,
    });
    // The newer authority is untouched: no N+2, no stale tuple.
    const after = assetRepository.findById(outputId);
    expect(after).toEqual(reconciled);
    // Recovery restored the file that authority describes.
    expect(sha256For(outputPath)).toBe(priorHash);
    expect(fs.statSync(outputPath).mtime.toISOString()).toBe(after.modified_at);
    expect(fs.statSync(outputPath).size).toBe(after.size_bytes);
    expect(sourceAnimation.reconcileSource(after)).toBeNull();
    expect(assetRepository.findById(outputId)).toEqual(after);
  });

  it('accepts an uppercase valid historical hash when recreating a missing Patreon output', async () => {
    const source = await writeIndexedImage('final/uppercase-hash.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const outputPath = path.join(projectDir, 'wm', 'uppercase-hash_wm.png');
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
    const destinationPath = path.join(projectDir, 'wm', 'uppercase-existing-hash_wm.png');
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
    const outputPath = path.join(projectDir, 'wm', `malformed-hash-${label.toLowerCase()}_wm.png`);
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

  it('keeps generated Patreon outputs classified at the category root after scanning', async () => {
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
    expect(assetScanner.repository.findByProjectIdAndPath(project.id, 'wm/classified_wm.png'))
      .toMatchObject({ category_id: wmCategory.id, nested_path: '' });
    expect(assetScanner.repository.findByProjectIdAndPath(project.id, 'wm/root-classified_wm.png'))
      .toMatchObject({ category_id: wmCategory.id, nested_path: '' });
    expect(assetScanner.repository.findByProjectIdAndPath(project.id, 'wm/nested-classified_wm.png'))
      .toMatchObject({ category_id: wmCategory.id, nested_path: '' });
  });

  it('resizes social output to 1100 without upscaling and deletes the source after success', async () => {
    const source = await writeIndexedImage('Final/social.png', { width: 2200, height: 1100 });

    const result = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'social',
    });

    const output = assetRepository.findByProjectIdAndPath(project.id, 'wm-lq/social_lq_wm.png');
    const metadata = await metadataFor(path.join(projectDir, 'wm-lq', 'social_lq_wm.png'));
    expect(metadata).toMatchObject({ width: 1100, height: 550, format: 'png' });
    expect(result.deletedSourceAssetIds).toEqual([source.id]);
    expect(assetRepository.findById(source.id)).toBeUndefined();
    expect(output.generated_mode).toBe('social');
    expect(fs.existsSync(path.join(projectDir, 'wm-lq', 'social.png'))).toBe(false);
  });

  it('refreshes a Social output after its source is restored with a new asset ID', async () => {
    const source = await writeIndexedImage('final/restored-social.png', { width: 2200, height: 1100 });
    await processingService.watermarkAssets(project.id, [source.id], { mode: 'social' });
    const outputPath = path.join(projectDir, 'wm-lq', 'restored-social_lq_wm.png');
    const priorOutput = assetRepository.findByProjectIdAndPath(
      project.id,
      'wm-lq/restored-social_lq_wm.png',
    );

    fs.writeFileSync(path.join(projectDir, 'final', 'restored-social.png'), await makeImage({ width: 1800, height: 900 }));
    assetScanner.scanProjectAssets(project.id);
    const restored = assetRepository.findByProjectIdAndPath(project.id, 'final/restored-social.png');
    expect(restored.id).not.toBe(source.id);

    fs.unlinkSync(outputPath);
    assetScanner.scanProjectAssets(project.id);
    const missingOutput = assetRepository.findByProjectIdAndPath(
      project.id,
      'wm-lq/restored-social_lq_wm.png',
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
      'wm-lq/restored-social_lq_wm.png',
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
    const priorOutputPath = path.join(projectDir, 'wm-lq', 'path-bound_lq_wm.png');
    const priorOutput = fs.readFileSync(priorOutputPath);

    const otherPath = path.join(projectDir, 'other', 'path-bound.png');
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    fs.writeFileSync(otherPath, await makeImage());
    assetScanner.scanProjectAssets(project.id);
    const otherSource = assetRepository.findByProjectIdAndPath(project.id, 'other/path-bound.png');

    await expect(processingService.watermarkAssets(project.id, [otherSource.id], {
      mode: 'social',
      overwrite: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });

    expect(fs.readFileSync(priorOutputPath)).toEqual(priorOutput);
    expect(fs.existsSync(path.join(projectDir, 'wm-lq', 'path-bound_lq_wm.png'))).toBe(true);
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
    const outputPath = path.join(projectDir, 'wm', `formats_wm.${outputFormat === 'jpeg' ? 'jpeg' : outputFormat}`);
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
    const metadata = await metadataFor(path.join(projectDir, 'wm', 'oriented_wm.jpeg'));
    expect(metadata).toMatchObject({ width: 60, height: 100, format: 'jpeg' });
  });

  it('skips existing outputs without overwrite and requires provenance for replacement', async () => {
    const source = await writeIndexedImage('final/repeat.png');
    const first = await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });
    const destination = path.join(projectDir, 'wm', 'repeat_wm.png');
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
    await writeIndexedImage('wm/unrelated_wm.png', { nestedPath: 'wm' });
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
    const destinationPath = path.join(projectDir, 'wm', 'external-replacement_wm.png');
    const replacement = Buffer.from(fs.readFileSync(destinationPath));
    replacement[0] ^= 0xff;
    fs.writeFileSync(destinationPath, replacement);

    assetScanner.scanProjectAssets(project.id);
    const reconciled = assetRepository.findByProjectIdAndPath(
      project.id,
      'wm/external-replacement_wm.png',
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
    const destinationPath = path.join(projectDir, 'wm', 'malformed-existing-hash_wm.png');
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
    const destinationPath = path.join(projectDir, 'wm', 'missing-race_wm.png');
    const destinationAsset = assetRepository.findById(first.generatedAssetIds[0]);
    fs.unlinkSync(destinationPath);
    assetScanner.scanProjectAssets(project.id);
    const externalBytes = Buffer.from('external race bytes');
    // The foreign file appears at the instant of the exclusive public create: EEXIST, never adopted.
    const hook = hookOwnedCreate((filePath) => filePath === path.resolve(destinationPath), {
      before: (filePath) => fs.writeFileSync(filePath, externalBytes),
      times: 1,
    });

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
      expect(hook.calls).toBe(1);
    } finally {
      hook.restore();
    }
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);

    expect(fs.readFileSync(destinationPath)).toEqual(externalBytes);
    expect(assetRepository.findById(destinationAsset.id)).toMatchObject({ is_present: 0 });
  });

  it('does not authorize legacy provenance without source-path and output-hash identity', async () => {
    const source = await writeIndexedImage('Final/legacy-provenance.png');
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      deleteSource: false,
    });
    const destinationPath = path.join(projectDir, 'wm', 'legacy-provenance_wm.png');
    const destination = assetRepository.findByProjectIdAndPath(
      project.id,
      'wm/legacy-provenance_wm.png',
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
    expect(fs.existsSync(path.join(projectDir, 'wm', 'preflight_wm.png'))).toBe(false);

    const first = await writeIndexedImage('Final/collision.png');
    const second = await writeIndexedImage('Final/collision.jpg', { format: 'jpeg' });
    await expect(processingService.watermarkAssets(project.id, [first.id, second.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    })).rejects.toMatchObject({ code: 'INTRA_BATCH_COLLISION' });
    expect(fs.existsSync(path.join(projectDir, 'wm', 'collision_wm.png'))).toBe(false);
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
    expect(fs.existsSync(path.join(projectDir, 'wm', 'failure_wm.png'))).toBe(false);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/failure_wm.png')).toBeUndefined();
  });

  // Previously rollback unlinked the published output on hash/size/link-count evidence alone.
  // Its exact ID differs from the stage, so ownership is unproven and evidence is retained.
  // Previously the CIFS-like destination identity was captured from the path at preflight and
  // trusted for backup and replacement, ending in recovery. It must now equal the provenance
  // persisted at publication, so the overwrite is refused before any mutation.
  it('refuses a CIFS-like overwrite whose destination identity does not match its provenance', async () => {
    const source = await writeIndexedImage('Final/cifs-overwrite-recovery.png');
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });

    const output = path.join(projectDir, 'wm', 'cifs-overwrite-recovery_wm.png');
    const before = fs.readFileSync(output);
    const beforeIno = fs.statSync(output, { bigint: true }).ino;
    const restoreCifsStats = mockCifsLikeOutputStats([output]);
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
      restoreCifsStats();
    }

    expect(fs.readFileSync(output)).toEqual(before);
    expect(fs.statSync(output, { bigint: true }).ino).toBe(beforeIno);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);
  });

  it('publishes multiple outputs whose paths report divergent IDs through their own descriptors', async () => {
    const first = await writeIndexedImage('Final/cifs-first.png');
    const second = await writeIndexedImage('Final/cifs-second.png');
    const firstOutput = path.join(projectDir, 'wm', 'cifs-first_wm.png');
    const secondOutput = path.join(projectDir, 'wm', 'cifs-second_wm.png');
    const restoreCifsStats = mockCifsLikeOutputStats([firstOutput, secondOutput]);

    try {
      const result = await processingService.watermarkAssets(project.id, [first.id, second.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
      });
      expect(result.generatedPaths).toEqual([
        'wm/cifs-first_wm.png',
        'wm/cifs-second_wm.png',
      ]);
      // Each output's provenance is the (divergent) identity its own descriptor reported.
      for (const [index, output] of [firstOutput, secondOutput].entries()) {
        expect(assetRepository.findGeneratedOutputProvenance(project.id, result.generatedAssetIds[index]))
          .toBe(provenanceTupleOf(output));
      }
    } finally {
      restoreCifsStats();
    }

    expect(fs.existsSync(firstOutput)).toBe(true);
    expect(fs.existsSync(secondOutput)).toBe(true);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);
  });

  describe('recovery diagnostics', () => {
    function expectPathFreeContext(context) {
      expect(() => JSON.stringify(context)).not.toThrow();
      const collect = (value) => (typeof value === 'string' ? [value]
        : value && typeof value === 'object' ? Object.values(value).flatMap(collect) : []);
      for (const value of collect(context)) {
        expect(path.isAbsolute(value)).toBe(false);
        expect(value).not.toContain(projectDir);
      }
    }

    // Outputs published and sources deleted, then the index fails; during rollback one output
    // path holds a same-bytes foreign file and one source path is occupied.
    async function failWithForeignOccupants(names, applicationLogger) {
      processingService = createConfiguredService(watermarkPath, tmpDir, coordinator, { applicationLogger });
      const sources = [];
      for (const name of names) sources.push(await writeIndexedImage(`Final/${name}.png`));
      const outputs = names.map((name) => path.resolve(projectDir, 'wm', `${name}_wm.png`));
      const firstSource = path.resolve(projectDir, 'Final', `${names[0]}.png`);
      const owned = [];
      const foreign = [];
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        for (const output of outputs.slice(1)) {
          owned.push(exactIdOf(output));
          replaceWithSameBytes(output);
          foreign.push(exactIdOf(output));
        }
        fs.writeFileSync(firstSource, Buffer.from('foreign occupant of a deleted source'));
        throw new Error('injected watermark database failure');
      });
      try {
        await expect(processingService.watermarkAssets(project.id, sources.map((source) => source.id), {
          mode: 'patreon', outputFormat: 'png', deleteSource: true,
        })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } finally {
        applySpy.mockRestore();
      }
      return { sources, outputs, owned, foreign };
    }

    it('names the unresolved output and source with descriptor-owned identities', async () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      const { sources, outputs, owned, foreign } = await failWithForeignOccupants(
        ['diag-first', 'diag-second'], applicationLogger,
      );

      // The owned first output was removed; the foreign second output and source stay.
      expect(fs.existsSync(outputs[0])).toBe(false);
      expect(exactIdOf(outputs[1])).toEqual(foreign[0]);
      const workspace = path.join(projectDir, stagingWorkspaces(projectDir, '.creatorcrate-watermark-')[0]);
      expect(stageNames(workspace)).toEqual(['1.output', '2.original']);

      expect(applicationLogger.error).toHaveBeenCalledTimes(1);
      const [{ event, context }] = applicationLogger.error.mock.calls[0];
      expect(event).toBe('processing.recovery.failed');
      expect(context).toMatchObject({
        operation: 'watermark',
        recoveryPhase: 'database',
        restored: false,
        cleanupSucceeded: false,
        diagnosticCount: 4,
        contentVerifiedCount: 0,
        strictProofFailureCount: 0,
        retainedRecoveryCriticalCount: 2,
      });
      expect(context.failures).toEqual([
        {
          assetId: sources[1].id,
          itemIndex: 1,
          artifactRole: 'published-output',
          check: 'rollback-identity-mismatch',
          publicationMode: 'descriptor-owned',
          pathState: 'present',
          identity: 'mismatched',
          expected: `${owned[0].dev}:${owned[0].ino}`,
          observed: `${foreign[0].dev}:${foreign[0].ino}`,
        },
        expect.objectContaining({
          assetId: sources[0].id,
          itemIndex: 2,
          artifactRole: 'staged-original',
          check: 'restore-source-present',
          identity: 'matched',
          referenceIdentity: 'mismatched',
        }),
        expect.objectContaining({
          assetId: sources[0].id,
          itemIndex: 2,
          artifactRole: 'staged-original',
          check: 'retained-unrestored',
          cleanup: 'recovery-critical',
        }),
        expect.objectContaining({
          assetId: sources[1].id,
          itemIndex: 1,
          artifactRole: 'stage-output',
          check: 'retained-unresolved-publication',
          publicationMode: 'descriptor-owned',
          identity: 'matched',
          cleanup: 'recovery-critical',
        }),
      ]);
      expect(JSON.stringify(context)).not.toMatch(/alias-proof|content-verified/);
      expectPathFreeContext(context);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('caps logged entries while keeping each distinct failure kind', async () => {
      const inserted = [];
      const applicationLogger = createApplicationLogger({
        repository: { insert: (record) => inserted.push(record), prune: () => {} },
      });
      await failWithForeignOccupants(['cap-a', 'cap-b', 'cap-c', 'cap-d', 'cap-e', 'cap-f'], applicationLogger);

      expect(inserted).toHaveLength(1);
      const { context } = inserted[0];
      // 5 output rollbacks + 1 source restore + 1 retained staged original + 5 retained stages.
      expect(context.diagnosticCount).toBe(12);
      // The cap fits six fully populated entries inside the logger's context-entry budget.
      expect(context.failures).toHaveLength(6);
      expect(JSON.stringify(context)).not.toContain('[truncated]');
      expect(new Set(context.failures.map((entry) => `${entry.artifactRole}/${entry.check}`))).toEqual(new Set([
        'published-output/rollback-identity-mismatch',
        'staged-original/restore-source-present',
        'staged-original/retained-unrestored',
        'stage-output/retained-unresolved-publication',
      ]));
      expect(context).toMatchObject({ contentVerifiedCount: 0, retainedRecoveryCriticalCount: 6 });
      expectPathFreeContext(context);
    });
  });

  describe('SMB-compatible descriptor-owned Watermark', () => {
    const options = { mode: 'patreon', outputFormat: 'png', deleteSource: false };
    const watermarkWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
    const inStaging = (suffix) => (filePath) => filePath.includes('.creatorcrate-watermark-')
      && filePath.endsWith(suffix);
    // A share that cannot keep hard-link aliases: no Watermark boundary may depend on one.
    const refuseHardLinks = () => vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('hard links are not supported here'), { code: 'EPERM' });
    });
    const failingIndex = () => vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
      throw new Error('injected watermark database failure');
    });
    const withLogger = () => {
      const applicationLogger = { warn: vi.fn(), error: vi.fn() };
      processingService = createConfiguredService(watermarkPath, tmpDir, coordinator, { applicationLogger });
      return applicationLogger;
    };

    // Live incident: every path reports its own inode, so the source (77:1855461) and its
    // staged original (77:1855492), and the stage (77:1855472) and the public output
    // (77:1855493), never alias. None of those identities is compared with another.
    it('publishes and deletes the source on the live SMB identity shape without any hard link', async () => {
      const logger = withLogger();
      const source = await writeIndexedImage('Final/smb-live.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'smb-live.png');
      const output = path.resolve(projectDir, 'wm', 'smb-live_wm.png');
      const ids = mockFileIdentities();
      ids.assign(sourcePath, { dev: 77n, ino: 1855461n });
      ids.autoAssign(inStaging('.original'), { dev: 77n, ino: 1855492n });
      ids.autoAssign(inStaging('0.output'), { dev: 77n, ino: 1855472n });
      ids.autoAssign((filePath) => filePath === output, {
        dev: 77n, ino: 1855493n, birthtimeNs: 1700000000000000093n,
      });
      const linkSpy = refuseHardLinks();
      let result;
      try {
        result = await processingService.watermarkAssets(project.id, [source.id], { ...options, deleteSource: true });
        expect(linkSpy).not.toHaveBeenCalled();
        expect(exactIdOf(output)).toEqual({ dev: 77n, ino: 1855493n });
      } finally {
        linkSpy.mockRestore();
        ids.restore();
      }

      expect(result).toMatchObject({ status: 'completed', deletedSourceAssetIds: [source.id] });
      // Durable provenance is the public output's own descriptor tuple, not the stage's.
      expect(assetRepository.findGeneratedOutputProvenance(project.id, result.generatedAssetIds[0]))
        .toBe('v1:77:1855493:1700000000000000093');
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(assetRepository.findById(source.id)).toBeFalsy();
      expect(watermarkWorkspaces()).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('rolls back several published outputs and deleted sources per item after a late failure', async () => {
      const names = ['multi-a', 'multi-b', 'multi-c'];
      const sources = [];
      for (const name of names) sources.push(await writeIndexedImage(`Final/${name}.png`));
      const sourcePaths = names.map((name) => path.resolve(projectDir, 'Final', `${name}.png`));
      const outputs = names.map((name) => path.resolve(projectDir, 'wm', `${name}_wm.png`));
      const sourceBytes = sourcePaths.map((sourcePath) => fs.readFileSync(sourcePath));
      const sourceIds = sourcePaths.map(exactIdOf);
      const sourceMtimes = sourcePaths.map((sourcePath) => fs.statSync(sourcePath).mtime.toISOString());
      const foreign = Buffer.from('foreign file at a deleted source path');
      let changes;
      let published;
      let sourcesRemoved;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation((projectId, value) => {
        changes = value;
        published = outputs.map(provenanceTupleOf);
        sourcesRemoved = sourcePaths.every((sourcePath) => !fs.existsSync(sourcePath));
        // Another writer occupies only the first deleted source's path.
        fs.writeFileSync(sourcePaths[0], foreign);
        throw new Error('injected late index failure');
      });
      const linkSpy = refuseHardLinks();
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, sources.map((source) => source.id), {
          ...options, deleteSource: true,
        }).catch((err) => err);
        expect(linkSpy).not.toHaveBeenCalled();
      } finally {
        linkSpy.mockRestore();
        applySpy.mockRestore();
      }

      expect(sourcesRemoved).toBe(true);
      // Independent public identities, each recorded from its own creating descriptor.
      expect(new Set(published).size).toBe(3);
      expect(changes.outputs.map((output) => output.generatedOutputProvenance)).toEqual(published);
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      for (const output of outputs) expect(fs.existsSync(output)).toBe(false);
      // The occupied source stays foreign; the others return with their bytes and indexed mtime.
      expect(fs.readFileSync(sourcePaths[0])).toEqual(foreign);
      for (const index of [1, 2]) {
        expect(fs.readFileSync(sourcePaths[index])).toEqual(sourceBytes[index]);
        expect(fs.statSync(sourcePaths[index]).mtime.toISOString()).toBe(sourceMtimes[index]);
        expect(exactIdOf(sourcePaths[index])).not.toEqual(sourceIds[index]);
        expect(assetRepository.findById(sources[index].id)).toBeTruthy();
      }
      // Only the unresolved item keeps evidence: its staged original. Every stage is removed.
      const [workspace, ...others] = watermarkWorkspaces();
      expect(others).toEqual([]);
      expect(stageNames(path.join(projectDir, workspace))).toEqual(['3.original']);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '3.original'))).toEqual(sourceBytes[0]);
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        assetId: sources[0].id, artifactRole: 'staged-original', check: 'restore-source-present',
      }));
      fs.rmSync(path.join(projectDir, workspace), { recursive: true, force: true });
    });

    it('restores a deleted source as a new file with its bytes, mode and indexed mtime after an index failure', async () => {
      const logger = withLogger();
      const source = await writeIndexedImage('Final/restore-source.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'restore-source.png');
      const output = path.resolve(projectDir, 'wm', 'restore-source_wm.png');
      const before = fs.readFileSync(sourcePath);
      const beforeStats = fs.statSync(sourcePath);
      const beforeId = exactIdOf(sourcePath);
      const applySpy = failingIndex();
      const linkSpy = refuseHardLinks();
      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], {
          ...options, deleteSource: true,
        })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        expect(linkSpy).not.toHaveBeenCalled();
      } finally {
        linkSpy.mockRestore();
        applySpy.mockRestore();
      }

      expect(fs.readFileSync(sourcePath)).toEqual(before);
      expect(exactIdOf(sourcePath)).not.toEqual(beforeId);
      const restored = fs.statSync(sourcePath);
      expect(restored.mtime.toISOString()).toBe(beforeStats.mtime.toISOString());
      expect(restored.mode).toBe(beforeStats.mode);
      expect(fs.existsSync(output)).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(watermarkWorkspaces()).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('replaces an owned generated output through an owned backup copy with distinct identities', async () => {
      const source = await writeIndexedImage('Final/smb-overwrite.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'smb-overwrite.png');
      const output = path.resolve(projectDir, 'wm', 'smb-overwrite_wm.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenanceTupleOf(output));
      const previousId = exactIdOf(output);
      const previousBytes = fs.readFileSync(output);
      const created = {};
      const hook = hookOwnedCreate((filePath) => inStaging('')(filePath) || filePath === output, {
        after: (filePath) => {
          const role = filePath === output ? 'output'
            : filePath.endsWith('.destination') ? 'backup' : filePath.endsWith('.output') ? 'stage' : 'other';
          created[role] = { ...exactIdOf(filePath), bytes: fs.readFileSync(filePath) };
        },
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const linkSpy = refuseHardLinks();
      try {
        await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
        expect(linkSpy).not.toHaveBeenCalled();
        const unlinked = unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
        expect(unlinked).toContain(output);
        expect(unlinked.some((filePath) => filePath.endsWith('.destination'))).toBe(true);
      } finally {
        linkSpy.mockRestore();
        unlinkSpy.mockRestore();
        hook.restore();
      }

      const idKey = ({ dev, ino }) => `${dev}:${ino}`;
      const current = exactIdOf(output);
      expect(new Set([exactIdOf(sourcePath), previousId, created.backup, created.stage, current].map(idKey)).size)
        .toBe(5);
      expect(created.backup.bytes).toEqual(previousBytes);
      expect(idKey(created.output)).toBe(idKey(current));
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenanceTupleOf(output));
      expect(watermarkWorkspaces()).toEqual([]);

      // Preview reads the rotated provenance and keeps a further overwrite ready.
      const planner = createAssetProcessingPlanner({
        projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
        scopeService: createAssetProcessingScopeService({ projectRepository, assetRepository }),
        projectRepository,
        assetRepository,
        generatedArtifactRepository,
        assetCategoryService,
        projectsRoot,
        watermarkPath,
        watermarkRoot: tmpDir,
      });
      const plan = await planner.planWatermark(project.id, { type: 'selected', assetIds: [source.id] }, {
        ...options, overwrite: true,
      });
      expect(plan.items[0].status).toBe('ready');
    });

    it('requires recovery and keeps the backup when restored provenance cannot be reconciled', async () => {
      const logger = withLogger();
      const source = await writeIndexedImage('Final/reconcile-failure.png');
      const output = path.resolve(projectDir, 'wm', 'reconcile-failure_wm.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const provenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
      const previousBytes = fs.readFileSync(output);
      const applySpy = failingIndex();
      const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedOutputProvenance')
        .mockImplementation(() => { throw Object.assign(new Error('injected busy database'), { code: 'SQLITE_BUSY' }); });
      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true }))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
      } finally {
        reconcileSpy.mockRestore();
        applySpy.mockRestore();
      }

      // The bytes are back, but the index could not be made to describe the restored file.
      expect(fs.readFileSync(output)).toEqual(previousBytes);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenance);
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['0.destination']);
      expect(fs.readFileSync(stageArtifact(workspace, '0.destination'))).toEqual(previousBytes);
      const [{ context }] = logger.error.mock.calls[0];
      expect(context.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'restored-destination', check: 'provenance-reconcile-failed', errorCode: 'SQLITE_BUSY',
      }));
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('never removes a same-bytes foreign file that replaced a new public output before rollback', async () => {
      const source = await writeIndexedImage('Final/public-replaced.png');
      const output = path.resolve(projectDir, 'wm', 'public-replaced_wm.png');
      let ownedId;
      let foreignIno;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        ownedId = exactIdOf(output);
        foreignIno = replaceWithSameBytes(output);
        unlinkSpy.mockClear(); // only CreatorCrate's own unlinks from here on
        throw new Error('injected watermark database failure');
      });
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(output);
      } finally {
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
      }

      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.statSync(output, { bigint: true }).ino).toBe(foreignIno);
      expect(foreignIno).not.toBe(ownedId.ino);
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['0.output']);
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'published-output',
        check: 'rollback-identity-mismatch',
        publicationMode: 'descriptor-owned',
        identity: 'mismatched',
        expected: `${ownedId.dev}:${ownedId.ino}`,
      }));
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('never removes the destination when its owned backup was rewritten in place', async () => {
      const source = await writeIndexedImage('Final/backup-rewritten.png');
      const output = path.resolve(projectDir, 'wm', 'backup-rewritten_wm.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const provenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
      const row = assetRepository.findById(assetId);
      const before = fs.readFileSync(output);
      const beforeId = exactIdOf(output);
      let backupId;
      let rewrittenId;
      const hook = hookOwnedCreate(inStaging('.destination'), {
        after: (backupPath) => {
          backupId = exactIdOf(backupPath);
          rewriteInPlace(backupPath, Buffer.from('backup corrupted in place'));
          rewrittenId = exactIdOf(backupPath);
        },
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true })
          .catch((err) => err);
        expect(applySpy).not.toHaveBeenCalled();
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(output);
      } finally {
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
        hook.restore();
      }

      // Ownership held (same exact identity) but content did not: never recovery material.
      expect(rewrittenId).toEqual(backupId);
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'destination-backup', check: 'replace-backup-content-mismatch',
      }));
      expect(fs.readFileSync(output)).toEqual(before);
      expect(exactIdOf(output)).toEqual(beforeId);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenance);
      expect(assetRepository.findById(assetId)).toEqual(row);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('never removes the source when its owned staged original was rewritten in place', async () => {
      const source = await writeIndexedImage('Final/staged-rewritten.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'staged-rewritten.png');
      const output = path.resolve(projectDir, 'wm', 'staged-rewritten_wm.png');
      const before = fs.readFileSync(sourcePath);
      const beforeId = exactIdOf(sourcePath);
      let stagedId;
      let rewrittenId;
      const hook = hookOwnedCreate(inStaging('.original'), {
        after: (stagedPath) => {
          stagedId = exactIdOf(stagedPath);
          rewriteInPlace(stagedPath, Buffer.from('staged original corrupted in place'));
          rewrittenId = exactIdOf(stagedPath);
        },
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, deleteSource: true })
          .catch((err) => err);
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(sourcePath);
      } finally {
        unlinkSpy.mockRestore();
        hook.restore();
      }

      expect(rewrittenId).toEqual(stagedId);
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'staged-original', check: 'staged-original-content-mismatch',
      }));
      expect(fs.readFileSync(sourcePath)).toEqual(before);
      expect(exactIdOf(sourcePath)).toEqual(beforeId);
      expect(fs.existsSync(output)).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('never claims a public output whose creating descriptor reports a zero ID', async () => {
      const source = await writeIndexedImage('Final/zero-id-public.png');
      const output = path.resolve(projectDir, 'wm', 'zero-id-public_wm.png');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const restoreStats = mockStatOverrides((filePath) => (filePath === output ? { ino: 0 } : null));
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(output);
      } finally {
        restoreStats();
        unlinkSpy.mockRestore();
      }

      // CreatorCrate created a public file it can never prove is its own: it stays, unresolved.
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.existsSync(output)).toBe(true);
      expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifactRole: 'published-output',
          check: 'public-output-identity-inspection-failed',
          proof: 'identity-unknown',
          cleanup: 'recovery-critical',
        }),
        expect.objectContaining({ artifactRole: 'published-output', check: 'rollback-ownership-unproven' }),
        expect.objectContaining({ artifactRole: 'stage-output', check: 'retained-unresolved-publication' }),
      ]));
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['0.output']);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(output);
    });

    it('never removes the source when its staged copy descriptor reports a zero ID', async () => {
      const source = await writeIndexedImage('Final/zero-id-staged.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'zero-id-staged.png');
      const output = path.resolve(projectDir, 'wm', 'zero-id-staged_wm.png');
      const before = fs.readFileSync(sourcePath);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const restoreStats = mockStatOverrides((filePath) => (inStaging('.original')(filePath) ? { ino: 0 } : null));
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, deleteSource: true })
          .catch((err) => err);
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(sourcePath);
      } finally {
        restoreStats();
        unlinkSpy.mockRestore();
      }

      // No project path was removed: an ordinary failure; the unowned private copy is residue,
      // which leaves project state safe but cleanup incomplete.
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics).toMatchObject({
        restored: true, cleanupSucceeded: false, retainedRecoveryCriticalCount: 0,
      });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'staged-original', check: 'cleanup-ownership-unproven', pathState: 'present', cleanup: 'residue',
      }));
      expect(fs.readFileSync(sourcePath)).toEqual(before);
      expect(fs.existsSync(output)).toBe(false);
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['1.original']);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('reports complete cleanup when an unowned staged original was never created', async () => {
      const source = await writeIndexedImage('Final/staged-never-created.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'staged-never-created.png');
      const output = path.resolve(projectDir, 'wm', 'staged-never-created_wm.png');
      const before = fs.readFileSync(sourcePath);
      const hook = hookOwnedCreate(inStaging('.original'), {
        before: () => { throw Object.assign(new Error('injected staged create EIO'), { code: 'EIO' }); },
      });
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, deleteSource: true })
          .catch((err) => err);
      } finally {
        hook.restore();
      }

      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics).toMatchObject({ restored: true, cleanupSucceeded: true });
      expect(failure.recoveryDiagnostics.failures.some((entry) => entry.cleanup)).toBe(false);
      expect(fs.readFileSync(sourcePath)).toEqual(before);
      expect(fs.existsSync(output)).toBe(false);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    // Runs `onRead(path)` once, when CreatorCrate opens a matching path for reading after
    // `armed(path)` has matched an earlier read.
    const hookReadAfter = (armed, matches, onRead) => {
      const realOpen = fs.openSync.bind(fs);
      let armedPath = null;
      let fired = false;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
        if (resolved && flags === 'r') {
          if (!armedPath && armed(resolved)) armedPath = resolved;
          else if (armedPath && !fired && matches(resolved)) {
            fired = true;
            onRead(armedPath, resolved);
          }
        }
        return realOpen(filePath, flags, ...args);
      });
      return { get fired() { return fired; }, restore: () => spy.mockRestore() };
    };

    it('never commits a public output displaced after its own check during a later pre-commit read', async () => {
      const first = await writeIndexedImage('Final/sweep-a.png');
      const second = await writeIndexedImage('Final/sweep-b.png');
      const outputA = path.resolve(projectDir, 'wm', 'sweep-a_wm.png');
      const outputB = path.resolve(projectDir, 'wm', 'sweep-b_wm.png');
      let ownedA;
      let foreignIno;
      // Output B is read only by the pre-commit hash, which runs after A passed identity,
      // content and post-hash identity.
      const hook = hookReadAfter((filePath) => filePath === outputA, (filePath) => filePath === outputB, () => {
        ownedA = exactIdOf(outputA);
        foreignIno = replaceWithSameBytes(outputA);
        unlinkSpy.mockClear(); // only CreatorCrate's own unlinks from here on
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [first.id, second.id], options)
          .catch((err) => err);
        expect(hook.fired).toBe(true);
        expect(applySpy).not.toHaveBeenCalled();
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(outputA);
      } finally {
        unlinkSpy.mockRestore();
        applySpy.mockRestore();
        hook.restore();
      }

      // The foreign file is never adopted, recorded or removed; it blocks a complete rollback.
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fs.statSync(outputA, { bigint: true }).ino).toBe(foreignIno);
      expect(foreignIno).not.toBe(ownedA.ino);
      expect(fs.existsSync(outputB)).toBe(false);
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/sweep-a_wm.png')).toBeFalsy();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/sweep-b_wm.png')).toBeFalsy();
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'published-output',
        check: 'precommit-final-identity-mismatch',
        identity: 'mismatched',
        expected: `${ownedA.dev}:${ownedA.ino}`,
      }));
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['0.output']);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outputA);
    });

    it('never removes the destination when its backup is displaced while the destination is read', async () => {
      const source = await writeIndexedImage('Final/backup-displaced.png');
      const output = path.resolve(projectDir, 'wm', 'backup-displaced_wm.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const provenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
      const before = fs.readFileSync(output);
      const beforeId = exactIdOf(output);
      // The backup's own check (identity, content, identity) passes; then the destination's
      // final read runs, during which the backup is replaced.
      const hook = hookReadAfter(inStaging('.destination'), (filePath) => filePath === output, (backupPath) => {
        replaceWithSameBytes(backupPath);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true })
          .catch((err) => err);
        expect(hook.fired).toBe(true);
        expect(applySpy).not.toHaveBeenCalled();
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(output);
      } finally {
        unlinkSpy.mockRestore();
        applySpy.mockRestore();
        hook.restore();
      }

      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'destination-backup', check: 'replace-final-backup-identity-mismatch', identity: 'mismatched',
      }));
      expect(fs.readFileSync(output)).toEqual(before);
      expect(exactIdOf(output)).toEqual(beforeId);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenance);
      // The foreign backup is never removed: safe residue.
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['0.destination']);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('never removes the source when its staged original is displaced while the source is read', async () => {
      const source = await writeIndexedImage('Final/staged-displaced.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'staged-displaced.png');
      const output = path.resolve(projectDir, 'wm', 'staged-displaced_wm.png');
      const before = fs.readFileSync(sourcePath);
      const beforeId = exactIdOf(sourcePath);
      const hook = hookReadAfter(inStaging('.original'), (filePath) => filePath === sourcePath, (stagedPath) => {
        replaceWithSameBytes(stagedPath);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, deleteSource: true })
          .catch((err) => err);
        expect(hook.fired).toBe(true);
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(sourcePath);
      } finally {
        unlinkSpy.mockRestore();
        hook.restore();
      }

      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'staged-original', check: 'staged-original-final-identity-mismatch', identity: 'mismatched',
      }));
      expect(fs.readFileSync(sourcePath)).toEqual(before);
      expect(exactIdOf(sourcePath)).toEqual(beforeId);
      expect(fs.existsSync(output)).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['1.original']);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    // A destination restored from its backup, then (while a delete-source original is being
    // restored) optionally rewritten in place: same exact identity, different bytes.
    const rollbackRestoredDestination = async (name, { corrupt }) => {
      const logger = withLogger();
      const source = await writeIndexedImage(`Final/${name}.png`);
      const sourcePath = path.resolve(projectDir, 'Final', `${name}.png`);
      const output = path.resolve(projectDir, 'wm', `${name}_wm.png`);
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const provenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
      const previousBytes = fs.readFileSync(output);
      const mutation = {};
      const hook = hookOwnedCreate((filePath) => filePath === sourcePath, {
        times: 1,
        before: () => {
          if (!corrupt) return;
          mutation.before = exactIdOf(output);
          const bytes = fs.readFileSync(output);
          bytes[bytes.length - 1] ^= 0xff;
          rewriteInPlace(output, bytes);
          mutation.after = exactIdOf(output);
        },
      });
      const applySpy = failingIndex();
      const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedOutputProvenance');
      let failure;
      let reconcileCalls;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], {
          ...options, overwrite: true, deleteSource: true,
        }).catch((err) => err);
        expect(hook.calls).toBe(1);
        reconcileCalls = reconcileSpy.mock.calls.length;
      } finally {
        reconcileSpy.mockRestore();
        applySpy.mockRestore();
        hook.restore();
      }
      return {
        logger, failure, output, sourcePath, assetId, provenance, previousBytes, mutation, reconcileCalls,
      };
    };

    it('never reconciles provenance for a restored destination rewritten in place before reconciliation', async () => {
      const {
        logger, failure, output, sourcePath, assetId, provenance, previousBytes, mutation, reconcileCalls,
      } = await rollbackRestoredDestination('restored-rewritten', { corrupt: true });

      expect(mutation.after).toEqual(mutation.before);
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(reconcileCalls).toBe(0);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenance);
      expect(exactIdOf(output)).toEqual(mutation.after);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'restored-destination', check: 'provenance-reconcile-content-mismatch', identity: 'matched',
      }));
      // The valid backup stays as recovery evidence.
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['0.destination']);
      expect(fs.readFileSync(stageArtifact(workspace, '0.destination'))).toEqual(previousBytes);
      expect(logger.error).toHaveBeenCalled();
      expect(logger.warn.mock.calls.map(([entry]) => entry.event)).not.toContain('processing.recovery.succeeded');
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('reconciles provenance for a stable restored destination and keeps the failure ordinary', async () => {
      const {
        failure, output, sourcePath, assetId, provenance, previousBytes, reconcileCalls,
      } = await rollbackRestoredDestination('restored-stable', { corrupt: false });

      expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(reconcileCalls).toBe(1);
      expect(fs.readFileSync(output)).toEqual(previousBytes);
      const reconciled = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
      expect(reconciled).toBe(provenanceTupleOf(output));
      expect(reconciled).not.toBe(provenance);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    // WP3.1: the archive-proven content-snapshot model applied to core Watermark.
    describe('core Watermark content continuity', () => {
      const backupPresent = () => watermarkWorkspaces()
        .some((workspace) => stageNames(path.join(projectDir, workspace)).includes('0.destination'));
      // Runs `onRead(path)` immediately after the descriptor of CreatorCrate's first read-only
      // open of a matching path (while `when()` holds) closes: its bytes were already hashed.
      const hookAfterRead = (matches, onRead, { when = () => true } = {}) => {
        const realOpen = fs.openSync.bind(fs);
        const realClose = fs.closeSync.bind(fs);
        let hooked = null;
        let fired = false;
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
          const descriptor = realOpen(filePath, flags, ...args);
          if (!fired && hooked === null && resolved && flags === 'r' && matches(resolved) && when()) {
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
          restore() { closeSpy.mockRestore(); openSpy.mockRestore(); },
        };
      };

      // Existing generated destination replaced with overwrite; the backup's own first
      // validation passes, then it is rewritten IN PLACE (same inode, same size) while the
      // destination's final content read runs. Identity-only would unlink the destination.
      it('never removes the destination when its backup is rewritten in place during the destination read', async () => {
        const source = await writeIndexedImage('Final/backup-late.png');
        const output = path.resolve(projectDir, 'wm', 'backup-late_wm.png');
        const first = await processingService.watermarkAssets(project.id, [source.id], options);
        const assetId = first.generatedAssetIds[0];
        const provenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
        const row = assetRepository.findById(assetId);
        const before = fs.readFileSync(output);
        const beforeId = exactIdOf(output);
        const mutation = {};
        const hook = hookReadAfter(inStaging('.destination'), (filePath) => filePath === output, (backupPath) => {
          mutation.before = exactIdOf(backupPath);
          rewriteInPlace(backupPath, Buffer.alloc(fs.lstatSync(backupPath).size, 0x41));
          mutation.after = exactIdOf(backupPath);
          mutation.size = fs.lstatSync(backupPath).size;
        });
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
        let failure;
        let applyCalls;
        let unlinked;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true })
            .catch((err) => err);
        } finally {
          // mockRestore() clears the spy's call history: capture the calls first.
          applyCalls = applySpy.mock.calls.length;
          unlinked = unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
          unlinkSpy.mockRestore();
          applySpy.mockRestore();
          hook.restore();
        }

        expect(hook.fired).toBe(true);
        expect(mutation.after).toEqual(mutation.before);
        expect(mutation.size).toBe(before.length);
        expect(applyCalls).toBe(0);
        expect(unlinked).not.toContain(output);
        // Refused before the destructive step: nothing public changed.
        expect(failure).toMatchObject({
          code: 'FILESYSTEM_OPERATION_FAILED', recoveryDiagnostics: { restored: true },
        });
        const recorded = failure.recoveryDiagnostics.failures;
        expect(recorded).toContainEqual(expect.objectContaining({
          artifactRole: 'destination-backup', check: 'replace-final-backup-content-mismatch', identity: 'matched',
        }));
        // The corrupted backup is never kept or used as recovery evidence.
        expect(recorded.some((entry) => entry.cleanup === 'recovery-critical')).toBe(false);
        expect(recorded.some((entry) => entry.artifactRole === 'restored-destination')).toBe(false);
        expect(fs.readFileSync(output)).toEqual(before);
        expect(exactIdOf(output)).toEqual(beforeId);
        expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenance);
        expect(assetRepository.findById(assetId)).toEqual(row);
        expect(watermarkWorkspaces()).toEqual([]);
      });

      // The reverse direction: the destination passed its own content validation after the
      // backup existed, then is rewritten in place while the FINAL backup content read runs.
      it('never removes the destination when it is rewritten in place during the final backup read', async () => {
        const source = await writeIndexedImage('Final/destination-late.png');
        const output = path.resolve(projectDir, 'wm', 'destination-late_wm.png');
        const first = await processingService.watermarkAssets(project.id, [source.id], options);
        const assetId = first.generatedAssetIds[0];
        const provenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
        const before = fs.readFileSync(output);
        const beforeId = exactIdOf(output);
        const mutated = Buffer.alloc(before.length, 0x42);
        const hook = hookReadAfter((filePath) => filePath === output && backupPresent(), inStaging('.destination'),
          () => rewriteInPlaceLater(output, mutated));
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
        let failure;
        let applyCalls;
        let unlinked;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true })
            .catch((err) => err);
        } finally {
          applyCalls = applySpy.mock.calls.length;
          unlinked = unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
          unlinkSpy.mockRestore();
          applySpy.mockRestore();
          hook.restore();
        }

        expect(hook.fired).toBe(true);
        expect(applyCalls).toBe(0);
        expect(unlinked).not.toContain(output);
        expect(failure).toMatchObject({
          code: 'OUTPUT_DESTINATION_CONFLICT', recoveryDiagnostics: { restored: true },
        });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          artifactRole: 'existing-destination', check: 'replace-final-destination-content-mismatch', identity: 'matched',
        }));
        // Never unlinked, repaired or adopted: the externally rewritten destination stays as is.
        expect(exactIdOf(output)).toEqual(beforeId);
        expect(fs.readFileSync(output)).toEqual(mutated);
        expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenance);
      });

      it('replaces the destination when it and its backup stay exact through the final checks', async () => {
        const source = await writeIndexedImage('Final/backup-late-control.png');
        const output = path.resolve(projectDir, 'wm', 'backup-late-control_wm.png');
        const first = await processingService.watermarkAssets(project.id, [source.id], options);
        const assetId = first.generatedAssetIds[0];
        const beforeId = exactIdOf(output);
        const hook = hookReadAfter(inStaging('.destination'), (filePath) => filePath === output, () => {});
        let result;
        try {
          result = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
        } finally {
          hook.restore();
        }

        expect(hook.fired).toBe(true);
        expect(result).toMatchObject({ status: 'completed', generatedAssetIds: [assetId] });
        expect(exactIdOf(output)).not.toEqual(beforeId);
        expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenanceTupleOf(output));
        expect(watermarkWorkspaces()).toEqual([]);
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

      it('requires recovery and never removes a created public output whose first descriptor inspection fails', async () => {
        const logger = withLogger();
        const source = await writeIndexedImage('Final/public-fstat-eio.png');
        const output = path.resolve(projectDir, 'wm', 'public-fstat-eio_wm.png');
        const inspection = failFirstCreatedFstat(output);
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
        let failure;
        let applyCalls;
        let unlinked;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        } finally {
          applyCalls = applySpy.mock.calls.length;
          unlinked = unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)));
          unlinkSpy.mockRestore();
          applySpy.mockRestore();
          inspection.restore();
        }

        expect(inspection.failed).toBe(1);
        expect(applyCalls).toBe(0);
        expect(unlinked).not.toContain(output);
        // The exclusive create succeeded, so the zero-byte public path exists, but it can never
        // be proven owned: it stays, with its stage, and recovery is required.
        expect(failure).toMatchObject({
          code: 'RECOVERY_REQUIRED',
          recoveryDiagnostics: { restored: false, cleanupSucceeded: false },
        });
        const recorded = failure.recoveryDiagnostics.failures;
        expect(recorded).toEqual(expect.arrayContaining([
          expect.objectContaining({
            artifactRole: 'published-output',
            check: 'public-output-identity-inspection-failed',
            errorCode: 'EIO',
            cleanup: 'recovery-critical',
          }),
          expect.objectContaining({ artifactRole: 'published-output', check: 'rollback-ownership-unproven' }),
          expect.objectContaining({ artifactRole: 'stage-output', check: 'retained-unresolved-publication' }),
        ]));
        expect(recorded.some((entry) => entry.check === 'publish-create-failed')).toBe(false);
        expect(fs.existsSync(output)).toBe(true);
        expect(fs.lstatSync(output).size).toBe(0);
        expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/public-fstat-eio_wm.png')).toBeFalsy();
        expect(assetRepository.findById(source.id)).toBeTruthy();
        expect(logger.warn.mock.calls.map(([entry]) => entry.event)).not.toContain('processing.recovery.succeeded');
        const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
        expect(stageNames(workspace)).toEqual(['0.output']);
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(output);
      });

      it('records no created-unclaimed state when the exclusive public open itself fails', async () => {
        const source = await writeIndexedImage('Final/public-open-eacces.png');
        const output = path.resolve(projectDir, 'wm', 'public-open-eacces_wm.png');
        const hook = hookOwnedCreate((filePath) => filePath === output, {
          times: 1,
          before: () => { throw Object.assign(new Error('injected open EACCES'), { code: 'EACCES' }); },
        });
        let failure;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        } finally {
          hook.restore();
        }

        expect(hook.calls).toBe(1);
        // Nothing was created: an ordinary failure after a verified rollback.
        expect(failure).toMatchObject({
          code: 'FILESYSTEM_OPERATION_FAILED',
          recoveryDiagnostics: { restored: true, cleanupSucceeded: true },
        });
        const recorded = failure.recoveryDiagnostics.failures;
        expect(recorded).toContainEqual(expect.objectContaining({
          artifactRole: 'published-output', check: 'publish-create-failed', errorCode: 'EACCES',
        }));
        for (const check of ['public-output-identity-inspection-failed', 'rollback-ownership-unproven',
          'retained-unresolved-publication']) {
          expect(recorded.some((entry) => entry.check === check)).toBe(false);
        }
        expect(fs.existsSync(output)).toBe(false);
        expect(watermarkWorkspaces()).toEqual([]);
      });

      // Cross-item content race: output A passes identity, content, identity; while output B
      // is hashed, A is rewritten IN PLACE (same inode, same size, later mtime). An
      // identity-only final sweep passes, so only content continuity keeps A's stale hash and
      // provenance out of the index.
      it('refuses the commit when an earlier output is rewritten in place during a later output hash', async () => {
        const first = await writeIndexedImage('Final/content-a.png');
        const second = await writeIndexedImage('Final/content-b.png');
        const outputA = path.resolve(projectDir, 'wm', 'content-a_wm.png');
        const outputB = path.resolve(projectDir, 'wm', 'content-b_wm.png');
        const mutation = {};
        // B is read only by the pre-commit hash, which runs after A passed validation.
        const hook = hookReadAfter((filePath) => filePath === outputA, (filePath) => filePath === outputB, () => {
          mutation.before = exactIdOf(outputA);
          rewriteInPlaceLater(outputA, Buffer.alloc(fs.lstatSync(outputA).size, 0x42));
          mutation.after = exactIdOf(outputA);
        });
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
        let failure;
        let applyCalls;
        try {
          failure = await processingService.watermarkAssets(project.id, [first.id, second.id], options)
            .catch((err) => err);
        } finally {
          // mockRestore() clears the spy's call history: count the index commits first.
          applyCalls = applySpy.mock.calls.length;
          applySpy.mockRestore();
          hook.restore();
        }

        expect(hook.fired).toBe(true);
        expect(mutation.after).toEqual(mutation.before);
        expect(applyCalls).toBe(0);
        expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          itemIndex: 0, artifactRole: 'published-output', check: 'precommit-final-content-mismatch', identity: 'matched',
        }));
        // Both owned outputs are rolled back by their exact identities; nothing is recorded.
        expect(fs.existsSync(outputA)).toBe(false);
        expect(fs.existsSync(outputB)).toBe(false);
        expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/content-a_wm.png')).toBeFalsy();
        expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/content-b_wm.png')).toBeFalsy();
        expect(watermarkWorkspaces()).toEqual([]);
        const evidence = createProcessingRecoveryEvidenceRepository(db);
        expect(evidence.listUnresolvedEvidenceByProject(project.id)).toEqual([]);
        expect(evidence.listMutationGroupsByProject(project.id)).toEqual([]);
      });

      it('maps only the affected Watermark group when a later hash displaces an earlier public output', async () => {
        const first = await writeIndexedImage('Final/cross-evidence-a.png');
        const second = await writeIndexedImage('Final/cross-evidence-b.png');
        const outputA = path.resolve(projectDir, 'wm', 'cross-evidence-a_wm.png');
        const outputB = path.resolve(projectDir, 'wm', 'cross-evidence-b_wm.png');
        const hook = hookReadAfter((p) => p === outputA, (p) => p === outputB,
          () => replaceWithForeignFile(outputA, Buffer.from('foreign public output')));
        const apply = vi.spyOn(assetRepository, 'applyAssetWatermarks');
        let error;
        try {
          error = await processingService.watermarkAssets(project.id, [first.id, second.id], options,
            Object.assign(() => {}, { jobId: 'cross-item-evidence' })).catch((err) => err);
          expect(apply).not.toHaveBeenCalled();
        } finally { apply.mockRestore(); hook.restore(); }
        expect(hook.fired).toBe(true);
        expect(error.code).toBe('RECOVERY_REQUIRED');
        const evidence = createProcessingRecoveryEvidenceRepository(db);
        const retained = evidence.listUnresolvedEvidenceByProject(project.id);
        expect(retained).toHaveLength(2);
        expect(retained.every((row) => row.assetId === first.id && row.runId === 'cross-item-evidence'
          && row.lifecycle === 'recovery-critical')).toBe(true);
        expect(retained.find((row) => row.artifactRole === 'published-output').observation).toBe('replaced');
        expect(retained.find((row) => row.artifactRole === 'stage-output').observation).toBe('present');
        expect(evidence.listMutationGroupsByProject(project.id)).toEqual([
          expect.objectContaining({ itemKey: `asset:${first.id}`, checkpoint: 'public-create' }),
        ]);
        expect(fs.existsSync(outputB)).toBe(false);
        expect(fs.readFileSync(outputA).toString()).toBe('foreign public output');
      });

      // Real-SMB shape: the output's metadata settles back to the creating descriptor's values
      // during its pre-commit hash. The post-hash/re-hash baseline is accepted.
      it('records an output whose SMB write times settle back to the descriptor values during its hash', async () => {
        const logger = withLogger();
        const source = await writeIndexedImage('Final/smb-settle.png');
        const output = path.resolve(projectDir, 'wm', 'smb-settle_wm.png');
        const smb = modelSmbTimeSettling((filePath) => filePath === output);
        let result;
        try {
          result = await processingService.watermarkAssets(project.id, [source.id], options);
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

        expect(result).toMatchObject({ status: 'completed' });
        const row = assetRepository.findById(result.generatedAssetIds[0]);
        expect(row.generated_output_sha256).toBe(sha256For(output));
        expect(assetRepository.findGeneratedOutputProvenance(project.id, row.id)).toBe(provenanceTupleOf(output));
        expect(watermarkWorkspaces()).toEqual([]);
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      });

      // Two replaced destinations restored after an index failure (reverse order: B, then A).
      // Reconciliation validates A, then B; while B is read, restored A is rewritten IN PLACE.
      it('never reconciles a restored destination rewritten in place during a later restored destination read', async () => {
        const logger = withLogger();
        const sources = [await writeIndexedImage('Final/restored-a.png'), await writeIndexedImage('Final/restored-b.png')];
        const outputA = path.resolve(projectDir, 'wm', 'restored-a_wm.png');
        const outputB = path.resolve(projectDir, 'wm', 'restored-b_wm.png');
        const first = await processingService.watermarkAssets(project.id, sources.map((source) => source.id), options);
        const provenances = first.generatedAssetIds
          .map((assetId) => assetRepository.findGeneratedOutputProvenance(project.id, assetId));
        const beforeA = fs.readFileSync(outputA);
        const mutated = Buffer.alloc(beforeA.length, 0x43);
        let rollingBack = false;
        const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
          rollingBack = true;
          throw new Error('injected watermark database failure');
        });
        const mutation = {};
        const realOpen = fs.openSync.bind(fs);
        let armed = false;
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
          if (rollingBack && flags === 'r' && !mutation.fired) {
            if (resolved === outputA) armed = true;
            else if (armed && resolved === outputB) {
              mutation.fired = true;
              mutation.before = exactIdOf(outputA);
              rewriteInPlaceLater(outputA, mutated);
              mutation.after = exactIdOf(outputA);
            }
          }
          return realOpen(filePath, flags, ...args);
        });
        const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedOutputProvenance');
        let failure;
        let reconcileCalls;
        try {
          failure = await processingService.watermarkAssets(project.id, sources.map((source) => source.id), {
            ...options, overwrite: true,
          }).catch((err) => err);
        } finally {
          // mockRestore() clears the spy's call history: count the reconciliations first.
          reconcileCalls = reconcileSpy.mock.calls.length;
          reconcileSpy.mockRestore();
          openSpy.mockRestore();
          applySpy.mockRestore();
        }

        expect(mutation.fired).toBe(true);
        expect(mutation.after).toEqual(mutation.before);
        expect(reconcileCalls).toBe(0);
        expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED', recoveryDiagnostics: { restored: false } });
        expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
          expect.objectContaining({
            itemIndex: 0, artifactRole: 'restored-destination',
            check: 'provenance-reconcile-final-content-mismatch', identity: 'matched',
          }),
          expect.objectContaining({ itemIndex: 0, artifactRole: 'destination-backup', check: 'retained-unrestored' }),
        ]));
        // Never repaired or adopted; the rows keep their pre-run provenance and A's valid backup stays.
        expect(exactIdOf(outputA)).toEqual(mutation.after);
        expect(fs.readFileSync(outputA)).toEqual(mutated);
        expect(first.generatedAssetIds.map((assetId) => assetRepository.findGeneratedOutputProvenance(project.id, assetId)))
          .toEqual(provenances);
        const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
        expect(stageNames(workspace)).toEqual(expect.arrayContaining(['0.destination']));
        expect(fs.readFileSync(stageArtifact(workspace, '0.destination'))).toEqual(beforeA);
        expect(logger.warn.mock.calls.map(([entry]) => entry.event)).not.toContain('processing.recovery.succeeded');
        fs.rmSync(workspace, { recursive: true, force: true });
      });

      // The backup disposal check's own hash reads the expected prior bytes; only then is the
      // restored destination rewritten IN PLACE (same inode, same size, later mtime). An
      // identity, content, identity check would accept that stale hash and dispose of the
      // last known-good backup.
      it('keeps the backup when the restored destination is rewritten in place during its disposal-check hash', async () => {
        const source = await writeIndexedImage('Final/restored-cleanup.png');
        const output = path.resolve(projectDir, 'wm', 'restored-cleanup_wm.png');
        const first = await processingService.watermarkAssets(project.id, [source.id], options);
        const assetId = first.generatedAssetIds[0];
        const before = fs.readFileSync(output);
        const mutated = Buffer.alloc(before.length, 0x44);
        const applySpy = failingIndex();
        const reconcileSpy = vi.spyOn(assetRepository, 'reconcileGeneratedOutputProvenance');
        const mutation = {};
        // After reconciliation, the next read of the restored destination is the disposal check.
        const hook = hookAfterRead((filePath) => filePath === output, () => {
          mutation.bytesAtHash = fs.readFileSync(output);
          mutation.before = exactIdOf(output);
          rewriteInPlaceLater(output, mutated);
          mutation.after = exactIdOf(output);
        }, { when: () => reconcileSpy.mock.calls.length > 0 });
        let failure;
        let reconcileCalls;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true })
            .catch((err) => err);
        } finally {
          reconcileCalls = reconcileSpy.mock.calls.length;
          hook.restore();
          reconcileSpy.mockRestore();
          applySpy.mockRestore();
        }

        expect(reconcileCalls).toBe(1);
        expect(hook.fired).toBe(true);
        expect(mutation.bytesAtHash).toEqual(before);
        expect(mutation.after).toEqual(mutation.before);
        expect(failure).toMatchObject({
          code: 'RECOVERY_REQUIRED',
          recoveryDiagnostics: { restored: true, cleanupSucceeded: false },
        });
        expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
          expect.objectContaining({
            itemIndex: 0, artifactRole: 'restored-destination',
            check: 'restored-destination-content-mismatch', identity: 'matched',
          }),
          expect.objectContaining({
            itemIndex: 0, artifactRole: 'destination-backup',
            check: 'retained-restored-destination-changed', cleanup: 'recovery-critical',
          }),
        ]));
        // The valid backup stays; the changed restored destination is never repaired or adopted.
        const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
        expect(stageNames(workspace)).toEqual(['0.destination']);
        expect(fs.readFileSync(stageArtifact(workspace, '0.destination'))).toEqual(before);
        const evidence = createProcessingRecoveryEvidenceRepository(db);
        const backupRow = evidence.listUnresolvedEvidenceByProject(project.id)
          .find((row) => row.artifactRole === 'destination-backup');
        expect(backupRow).toMatchObject({ assetId: source.id, lifecycle: 'recovery-critical', observation: 'present',
          retentionReason: 'watermark-restoration-failed' });
        expect(evidence.findMutationGroup(project.id, backupRow.mutationGroupId).checkpoint).not.toBeNull();
        expect(fs.readFileSync(output)).toEqual(mutated);
        expect(assetRepository.findById(assetId)).toBeTruthy();
        fs.rmSync(workspace, { recursive: true, force: true });
      });
    });

    // Two delete-source originals rolled back after an index failure. Sources restore in reverse
    // order, so the second is restored first; `whileRestoringFirst(secondPath)` then runs as
    // later rollback work (immediately before the first source's restore create), and
    // `afterCleanupRead(secondPath)` runs once a rollback-time read of the restored second
    // source closes, after the first source is back (cleanup's content check).
    const rollbackRestoredSources = async (name, { whileRestoringFirst, afterCleanupRead } = {}) => {
      const logger = withLogger();
      const names = [`${name}-a`, `${name}-b`];
      const sources = [];
      for (const entry of names) sources.push(await writeIndexedImage(`Final/${entry}.png`));
      const [firstPath, secondPath] = names.map((entry) => path.resolve(projectDir, 'Final', `${entry}.png`));
      const secondBytes = fs.readFileSync(secondPath);
      const observed = { secondRestoredBeforeLaterWork: false };
      let rollingBack = false;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        rollingBack = true;
        throw new Error('injected watermark database failure');
      });
      const realOpen = fs.openSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      const reads = new Set();
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
        if (rollingBack && resolved === firstPath && typeof flags === 'string' && flags.startsWith('wx')
          && observed.laterWork === undefined) {
          observed.secondRestoredBeforeLaterWork = fs.existsSync(secondPath);
          observed.laterWork = exactIdOf(secondPath);
          whileRestoringFirst?.(secondPath, observed);
        }
        const descriptor = realOpen(filePath, flags, ...args);
        if (rollingBack && resolved === secondPath && flags === 'r') reads.add(descriptor);
        return descriptor;
      });
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        const result = realClose(descriptor, ...args);
        if (reads.delete(descriptor) && fs.existsSync(firstPath) && observed.cleanupRead === undefined) {
          observed.cleanupRead = exactIdOf(secondPath);
          afterCleanupRead?.(secondPath, observed);
        }
        return result;
      });
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, sources.map((source) => source.id), {
          ...options, deleteSource: true,
        }).catch((err) => err);
      } finally {
        closeSpy.mockRestore();
        openSpy.mockRestore();
        applySpy.mockRestore();
      }
      expect(observed.secondRestoredBeforeLaterWork).toBe(true);
      return { logger, failure, sources, firstPath, secondPath, secondBytes, observed };
    };

    const expectRestoredSourceRetained = ({ logger, failure, sources, secondBytes }, check, identity) => {
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(failure.recoveryDiagnostics.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          assetId: sources[1].id, artifactRole: 'restored-source', check, identity,
        }),
        expect.objectContaining({
          assetId: sources[1].id,
          artifactRole: 'staged-original',
          check: 'retained-restored-source-changed',
          identity: 'matched',
          cleanup: 'recovery-critical',
        }),
      ]));
      // The staged original is the last known-good copy of the source and keeps its bytes.
      const [workspace, ...others] = watermarkWorkspaces();
      expect(others).toEqual([]);
      const names = stageNames(path.join(projectDir, workspace));
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/\.original$/);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), names[0]))).toEqual(secondBytes);
      const evidence = createProcessingRecoveryEvidenceRepository(db);
      const originalRow = evidence.listUnresolvedEvidenceByProject(project.id)
        .find((row) => row.artifactRole === 'staged-original' && row.assetId === sources[1].id);
      expect(originalRow).toMatchObject({ lifecycle: 'recovery-critical', observation: 'present',
        retentionReason: 'watermark-source-restoration-failed' });
      expect(evidence.findMutationGroup(project.id, originalRow.mutationGroupId).checkpoint).not.toBeNull();
      expect(logger.error.mock.calls.map(([entry]) => entry.event)).toContain('processing.recovery.failed');
      expect(logger.warn.mock.calls.map(([entry]) => entry.event)).not.toContain('processing.recovery.succeeded');
      expectDiagnosticsPathFree(failure.recoveryDiagnostics);
      return path.join(projectDir, workspace);
    };

    const expectDiagnosticsPathFree = (value) => {
      const text = JSON.stringify(value);
      expect(text).not.toContain(projectDir);
      expect(text).not.toContain(JSON.stringify(projectDir).slice(1, -1));
    };

    it('keeps the staged original when its restored source is rewritten in place by later rollback work', async () => {
      const outcome = await rollbackRestoredSources('restored-src-rewritten', {
        whileRestoringFirst: (secondPath, observed) => {
          const bytes = fs.readFileSync(secondPath);
          bytes[bytes.length - 1] ^= 0xff;
          rewriteInPlace(secondPath, bytes);
          observed.corrupted = { identity: exactIdOf(secondPath), bytes };
        },
      });
      const { secondPath, firstPath, observed } = outcome;

      // Same exact identity, different bytes: only the content check can see it.
      expect(observed.corrupted.identity).toEqual(observed.laterWork);
      const workspace = expectRestoredSourceRetained(outcome, 'restored-source-content-mismatch', 'matched');
      // The changed restored source is never repaired or removed by cleanup.
      expect(exactIdOf(secondPath)).toEqual(observed.laterWork);
      expect(fs.readFileSync(secondPath)).toEqual(observed.corrupted.bytes);
      expect(fs.existsSync(firstPath)).toBe(true);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('keeps the staged original when its restored source is replaced by a foreign file', async () => {
      const outcome = await rollbackRestoredSources('restored-src-replaced', {
        whileRestoringFirst: (secondPath, observed) => {
          observed.foreignIno = replaceWithSameBytes(secondPath);
        },
      });
      const { secondPath, secondBytes, observed } = outcome;

      // The foreign file even holds the original bytes: a matching hash alone never suffices.
      expect(observed.foreignIno).not.toBe(observed.laterWork.ino);
      const workspace = expectRestoredSourceRetained(outcome, 'restored-source-identity-mismatch', 'mismatched');
      expect(fs.statSync(secondPath, { bigint: true }).ino).toBe(observed.foreignIno);
      expect(fs.readFileSync(secondPath)).toEqual(secondBytes);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('keeps the staged original when its restored source is replaced after the cleanup content check', async () => {
      const outcome = await rollbackRestoredSources('restored-src-late-swap', {
        afterCleanupRead: (secondPath, observed) => {
          observed.foreignIno = replaceWithSameBytes(secondPath);
        },
      });
      const { secondPath, observed } = outcome;

      expect(observed.cleanupRead).toEqual(observed.laterWork);
      const workspace = expectRestoredSourceRetained(
        outcome, 'restored-source-identity-mismatch', 'mismatched',
      );
      expect(fs.statSync(secondPath, { bigint: true }).ino).toBe(observed.foreignIno);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    // Stale-hash window: the cleanup hash read the original bytes, then the restored source was
    // rewritten in place (same exact identity and size, different bytes, later write times)
    // before the disposal decision. Identity alone still matches; only the post-hash
    // fingerprint and the conditional re-hash see the write.
    it('keeps the staged original when its restored source is rewritten in place after the cleanup hash', async () => {
      const outcome = await rollbackRestoredSources('restored-src-stale-hash', {
        afterCleanupRead: (secondPath, observed) => {
          const before = fs.lstatSync(secondPath, { bigint: true });
          const bytes = fs.readFileSync(secondPath);
          bytes[bytes.length - 1] ^= 0xff;
          rewriteInPlaceLater(secondPath, bytes);
          const after = fs.lstatSync(secondPath, { bigint: true });
          observed.corrupted = {
            identity: exactIdOf(secondPath), bytes, sizeKept: after.size === before.size,
            mtimeAdvanced: after.mtimeNs > before.mtimeNs, ctimeAdvanced: after.ctimeNs >= before.ctimeNs,
          };
        },
      });
      const { secondPath, firstPath, observed } = outcome;

      expect(observed.cleanupRead).toEqual(observed.laterWork);
      expect(observed.corrupted).toMatchObject({
        identity: observed.laterWork, sizeKept: true, mtimeAdvanced: true, ctimeAdvanced: true,
      });
      const workspace = expectRestoredSourceRetained(outcome, 'restored-source-content-mismatch', 'matched');
      // The changed restored source is left exactly as the writer left it.
      expect(exactIdOf(secondPath)).toEqual(observed.laterWork);
      expect(fs.readFileSync(secondPath)).toEqual(observed.corrupted.bytes);
      expect(fs.existsSync(firstPath)).toBe(true);
      expect(outcome.failure.recoveryDiagnostics).toMatchObject({ cleanupSucceeded: false });
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    // SMB positive control: the restored source's write times settle during the first cleanup
    // hash (identity, size and bytes unchanged). The conditional re-hash stabilizes and the
    // staged original is disposed as in an ordinary rollback.
    it('disposes the staged original when the restored source metadata settles during the cleanup hash', async () => {
      const {
        logger, failure, sources, secondPath, secondBytes, observed,
      } = await rollbackRestoredSources('restored-src-smb-settle', {
        afterCleanupRead: (target, state) => {
          const before = fs.lstatSync(target, { bigint: true });
          const { atimeMs, mtimeMs } = fs.statSync(target);
          fs.utimesSync(target, atimeMs / 1000, mtimeMs / 1000 + 5);
          state.settledMtimeMoved = fs.lstatSync(target, { bigint: true }).mtimeNs !== before.mtimeNs;
        },
      });

      expect(observed.cleanupRead).toEqual(observed.laterWork);
      expect(observed.settledMtimeMoved).toBe(true);
      expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(exactIdOf(secondPath)).toEqual(observed.laterWork);
      expect(fs.readFileSync(secondPath)).toEqual(secondBytes);
      for (const source of sources) expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(watermarkWorkspaces()).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('disposes the staged original of a restored source that stays exact through later rollback work', async () => {
      const {
        logger, failure, sources, firstPath, secondPath, secondBytes, observed,
      } = await rollbackRestoredSources('restored-src-stable');

      expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      // Cleanup re-read the restored source, and it was still the restored object.
      expect(observed.cleanupRead).toEqual(observed.laterWork);
      expect(exactIdOf(secondPath)).toEqual(observed.laterWork);
      expect(fs.readFileSync(secondPath)).toEqual(secondBytes);
      expect(fs.existsSync(firstPath)).toBe(true);
      for (const source of sources) expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(watermarkWorkspaces()).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    });

    // Exact values beyond Number.MAX_SAFE_INTEGER whose Number views collide pairwise.
    const BIG = Object.freeze({
      output: 9007199254740993n,
      backup: 9007199254740995n,
      staged: 9007199254740997n,
      restoredDestination: 9007199254740999n,
      restoredSource: 9007199254741001n,
    });

    it('creates, restores and reconciles exact identities past 2^53', async () => {
      const source = await writeIndexedImage('Final/big-ids.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'big-ids.png');
      const output = path.resolve(projectDir, 'wm', 'big-ids_wm.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const previousBytes = fs.readFileSync(output);
      const sourceBytes = fs.readFileSync(sourcePath);
      let destinationGone = false;
      let sourceGone = false;
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        const result = realUnlink(filePath, ...args);
        if (path.resolve(String(filePath)) === output) destinationGone = true;
        if (path.resolve(String(filePath)) === sourcePath) sourceGone = true;
        return result;
      });
      const ids = mockFileIdentities();
      ids.autoAssign(inStaging('0.destination'), { dev: 77n, ino: BIG.backup });
      ids.autoAssign(inStaging('.original'), { dev: 77n, ino: BIG.staged });
      ids.autoAssign((filePath) => destinationGone && filePath === output, {
        dev: 77n, ino: BIG.output, birthtimeNs: 1700000000000000001n,
      });
      ids.autoAssign((filePath) => destinationGone && filePath === output, {
        dev: 77n, ino: BIG.restoredDestination, birthtimeNs: 1700000000000000003n,
      });
      ids.autoAssign((filePath) => sourceGone && filePath === sourcePath, { dev: 77n, ino: BIG.restoredSource });
      let committed;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation((projectId, changes) => {
        committed = changes.replacements[0].generatedOutputProvenance;
        throw new Error('injected watermark database failure');
      });
      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], {
          ...options, overwrite: true, deleteSource: true,
        })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        expect(exactIdOf(output)).toEqual({ dev: 77n, ino: BIG.restoredDestination });
        expect(exactIdOf(sourcePath)).toEqual({ dev: 77n, ino: BIG.restoredSource });
      } finally {
        applySpy.mockRestore();
        ids.restore();
        unlinkSpy.mockRestore();
      }

      expect(Number(BIG.output)).toBe(Number(BIG.output - 1n));
      expect(committed).toBe(`v1:77:${BIG.output}:1700000000000000001`);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId))
        .toBe(`v1:77:${BIG.restoredDestination}:1700000000000000003`);
      expect(fs.readFileSync(output)).toEqual(previousBytes);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('never removes a foreign output whose exact ID only collides as a Number past 2^53', async () => {
      const source = await writeIndexedImage('Final/big-neighbor.png');
      const output = path.resolve(projectDir, 'wm', 'big-neighbor_wm.png');
      const ids = mockFileIdentities();
      ids.autoAssign((filePath) => filePath === output, { dev: 77n, ino: BIG.output });
      let foreignIno;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        foreignIno = replaceWithSameBytes(output);
        ids.assign(output, { dev: 77n, ino: BIG.output - 1n });
        unlinkSpy.mockClear();
        throw new Error('injected watermark database failure');
      });
      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], options))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(output);
      } finally {
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
        ids.restore();
      }
      expect(fs.statSync(output, { bigint: true }).ino).toBe(foreignIno);
      fs.rmSync(path.join(projectDir, watermarkWorkspaces()[0]), { recursive: true, force: true });
    });

    it('completes a committed overwrite and reports an unremovable backup as residue', async () => {
      const logger = withLogger();
      const source = await writeIndexedImage('Final/backup-residue.png');
      const output = path.resolve(projectDir, 'wm', 'backup-residue_wm.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (inStaging('.destination')(path.resolve(String(filePath)))) {
          throw Object.assign(new Error('injected backup unlinkSync EIO'), { code: 'EIO' });
        }
        return realUnlink(filePath, ...args);
      });
      let result;
      try {
        result = await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
      } finally {
        unlinkSpy.mockRestore();
      }

      expect(result).toMatchObject({ status: 'completed', generatedAssetIds: first.generatedAssetIds });
      expect(assetRepository.findGeneratedOutputProvenance(project.id, first.generatedAssetIds[0]))
        .toBe(provenanceTupleOf(output));
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [entry] = logger.warn.mock.calls[0];
      expect(entry).toMatchObject({ event: 'processing.cleanup.residue', context: { operation: 'watermark' } });
      expect(entry.context.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'destination-backup', check: 'cleanup-unlink-failed', errorCode: 'EIO', cleanup: 'residue',
      }));
      const workspace = path.join(projectDir, watermarkWorkspaces()[0]);
      expect(stageNames(workspace)).toEqual(['0.destination']);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('keeps a verified rollback ordinary when a dispensable stage cannot be removed', async () => {
      const logger = withLogger();
      const source = await writeIndexedImage('Final/stage-residue.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'stage-residue.png');
      const output = path.resolve(projectDir, 'wm', 'stage-residue_wm.png');
      const applySpy = failingIndex();
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (inStaging('0.output')(path.resolve(String(filePath)))) {
          throw Object.assign(new Error('injected stage unlinkSync EIO'), { code: 'EIO' });
        }
        return realUnlink(filePath, ...args);
      });
      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
      } finally {
        unlinkSpy.mockRestore();
        applySpy.mockRestore();
      }

      expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(logger.error).not.toHaveBeenCalled();
      const [entry] = logger.warn.mock.calls[0];
      expect(entry).toMatchObject({ event: 'processing.recovery.succeeded' });
      expect(entry.context).toMatchObject({ restored: true, cleanupSucceeded: false });
      expect(entry.context.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'stage-output', check: 'cleanup-unlink-failed', errorCode: 'EIO', cleanup: 'residue',
      }));
      fs.rmSync(path.join(projectDir, watermarkWorkspaces()[0]), { recursive: true, force: true });
    });

    // WP4: archives and CBZ generated by Watermark use the shared descriptor-owned archive
    // publication, backup, restore and provenance reconciliation.
    const archiveOptions = {
      mode: 'custom', outputFormat: 'png', deleteSource: false, makeArchives: true, makeCbz: true,
    };
    const archiveRow = (name) => generatedArtifactRepository.findByProjectIdAndPath(project.id, name);

    it('publishes, restores and replaces watermark archives and a cbz without hard links', async () => {
      const logger = withLogger();
      const source = await writeIndexedImage('Final/smb-wm-archive.png');
      const names = ['WmSmb_jpg_q80.zip', 'WmSmb_webp_q90.zip', 'WmSmb_jpg_q85.cbz'];
      const archives = names.map((name) => path.resolve(projectDir, name));
      const ids = mockFileIdentities();
      ids.autoAssign(inStaging('archive-2.cbz'), { dev: 77n, ino: 1855572n });
      ids.autoAssign((filePath) => filePath === archives[2], {
        dev: 77n, ino: 1855593n, birthtimeNs: 1700000000000000193n,
      });
      const linkSpy = refuseHardLinks();
      try {
        const first = await processingService.watermarkAssets(project.id, [source.id], {
          ...archiveOptions, setName: 'WmSmb',
        });
        expect(first.artifacts.map((artifact) => artifact.relativePath)).toEqual(names);
        // The CBZ's provenance is its own public descriptor tuple, not its stage's.
        expect(archiveRow(names[2]).output_provenance).toBe('v1:77:1855593:1700000000000000193');
        expect(watermarkWorkspaces()).toEqual([]);

        const previous = archives.map((filePath) => fs.readFileSync(filePath));
        const applySpy = failingIndex();
        try {
          await expect(processingService.watermarkAssets(project.id, [source.id], {
            ...archiveOptions, setName: 'WmSmb', overwrite: true, replaceExistingArchives: true,
          })).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        } finally {
          applySpy.mockRestore();
        }
        // Each previous archive returns as a new owned file whose row names that file.
        expect(archives.map((filePath) => fs.readFileSync(filePath))).toEqual(previous);
        expect(exactIdOf(archives[2])).not.toEqual({ dev: 77n, ino: 1855593n });
        for (const [index, name] of names.entries()) {
          expect(archiveRow(name).output_provenance).toBe(provenanceTupleOf(archives[index]));
        }
        expect(watermarkWorkspaces()).toEqual([]);

        await processingService.watermarkAssets(project.id, [source.id], {
          ...archiveOptions, setName: 'WmSmb', overwrite: true, replaceExistingArchives: true,
        });
        for (const [index, name] of names.entries()) {
          expect(archiveRow(name).output_provenance).toBe(provenanceTupleOf(archives[index]));
        }
        expect(watermarkWorkspaces()).toEqual([]);
        expect(linkSpy).not.toHaveBeenCalled();
      } finally {
        linkSpy.mockRestore();
        ids.restore();
      }
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('refuses the commit when an earlier watermark archive is replaced during a later archive hash', async () => {
      const source = await writeIndexedImage('Final/wm-archive-cross-item.png');
      const jpgArchive = path.resolve(projectDir, 'WmCross_jpg_q80.zip');
      const cbzArchive = path.resolve(projectDir, 'WmCross_jpg_q85.cbz');
      const realOpen = fs.openSync.bind(fs);
      let foreignIno;
      // The CBZ's only read-only open is its pre-commit hash, after the JPG archive passed.
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (foreignIno === undefined && path.resolve(String(filePath)) === cbzArchive
          && (flags === undefined || flags === 'r')) {
          foreignIno = replaceWithSameBytes(jpgArchive);
        }
        return realOpen(filePath, flags, ...args);
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      let failure;
      let applyCallCount;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], {
          ...archiveOptions, setName: 'WmCross',
        }).catch((err) => err);      } finally {
        // mockRestore() clears call history, so capture it first.
        applyCallCount = applySpy.mock.calls.length;
        applySpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(foreignIno).toBeDefined();
      expect(applyCallCount).toBe(0);
      expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED', cause: { code: 'ARCHIVE_DESTINATION_CONFLICT' } });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        itemIndex: 0, artifactRole: 'published-archive', check: 'precommit-final-identity-mismatch',
      }));
      expect(fs.statSync(jpgArchive, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.existsSync(cbzArchive)).toBe(false);
      expect(fs.readdirSync(projectDir, { recursive: true }).filter((name) => String(name).includes('_wm.'))).toEqual([]);
      expect(fs.existsSync(path.resolve(projectDir, 'Final', 'wm-archive-cross-item.png'))).toBe(true);
      expect(generatedArtifactRepository.listByProjectId(project.id)).toEqual([]);
    });

    // WP1 diagnostics: the two observed failure classes log the comparison that decided them
    // through the real application logger and its sanitizer, as processing.watermark.validation.failed.
    describe('validation failure diagnostics', () => {
      const VALIDATION_EVENT = 'processing.watermark.validation.failed';
      const withRealLogger = () => {
        const records = [];
        const applicationLogger = createApplicationLogger({
          repository: { insert: (record) => records.push(record), prune: () => {} },
        });
        processingService = createConfiguredService(watermarkPath, tmpDir, coordinator, { applicationLogger });
        return records;
      };
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
        expect(json).not.toContain('[redacted');
        expect(json).not.toContain('[unsupported value]');
        expect(json).not.toContain(projectDir);
        expect(json).not.toContain(path.basename(tmpDir));
        expect(contextEntries(context)).toBeLessThanOrEqual(100);
      };

      it('logs the fingerprint fields and settling outcome of a precommit-final-content-mismatch', async () => {
        const records = withRealLogger();
        const first = await writeIndexedImage('Final/diag-final-a.png');
        const second = await writeIndexedImage('Final/diag-final-b.png');
        const outputA = path.resolve(projectDir, 'wm', 'diag-final-a_wm.png');
        const outputB = path.resolve(projectDir, 'wm', 'diag-final-b_wm.png');
        // A passes its own pre-commit check; while B is hashed, A is rewritten in place.
        const hook = hookReadAfter((filePath) => filePath === outputA, (filePath) => filePath === outputB,
          () => rewriteInPlaceLater(outputA, Buffer.alloc(fs.lstatSync(outputA).size, 0x42)));
        let failure;
        try {
          failure = await processingService.watermarkAssets(project.id, [first.id, second.id], options)
            .catch((err) => err);
        } finally {
          hook.restore();
        }

        expect(hook.fired).toBe(true);
        expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        const [record, ...others] = records.filter((entry) => entry.event === VALIDATION_EVENT);
        expect(others).toEqual([]);
        expect(record).toMatchObject({ level: 'warn', kind: 'diagnostic', subsystem: 'processing', projectId: project.id });
        const { context } = record;
        expect(context).toMatchObject({
          operation: 'watermark',
          assetId: first.id,
          itemIndex: 0,
          check: 'precommit-final-content-mismatch',
          publicationMode: 'descriptor-owned',
          // The final sweep saw A's write metadata move; its one reverification read the new bytes.
          subcheck: 'hash-mismatch',
          identityMatch: 'matched',
          hashMatch: false,
          rehash: 'not-needed',
          settling: 'held-after-hash',
          finalReverify: 'performed',
          finalSweepMoved: { compared: ['precommit-after-hash', 'precommit-final-sweep'] },
          failedOutputCount: 1,
        });
        expect(context.finalSweepMoved.changedFields).toContain('mtimeNs');
        const { phases } = context;
        expect(Object.keys(phases)).toEqual([
          'precommit-reverify-before-hash', 'precommit-identity-before-hash', 'precommit-size-check',
        ]);
        expect(context.expected).toMatchObject({ size: phases['precommit-size-check'].size });
        expectSafeContext(context);
      });

      it('logs an attempted re-hash whose second content validation fails as performed, not settled', async () => {
        const records = withRealLogger();
        const source = await writeIndexedImage('Final/diag-rehash-mismatch.png');
        const output = path.resolve(projectDir, 'wm', 'diag-rehash-mismatch_wm.png');
        // The first pre-commit hash reads the published bytes; once it closes, the output is
        // rewritten in place (same size, later mtime), so the post-hash fingerprint moves and
        // the re-hash reads mismatching bytes.
        const realOpen = fs.openSync.bind(fs);
        const realClose = fs.closeSync.bind(fs);
        let hashDescriptor = null;
        let hashReads = 0;
        let fired = false;
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          const descriptor = realOpen(filePath, flags, ...args);
          if (typeof filePath === 'string' && flags === 'r' && path.resolve(filePath) === output) {
            hashReads += 1;
            if (hashReads === 1) hashDescriptor = descriptor;
          }
          return descriptor;
        });
        const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
          realClose(descriptor);
          if (!fired && descriptor === hashDescriptor) {
            fired = true;
            rewriteInPlaceLater(output, Buffer.alloc(fs.lstatSync(output).size, 0x44));
          }
        });
        let failure;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        } finally {
          closeSpy.mockRestore();
          openSpy.mockRestore();
        }

        expect(fired).toBe(true);
        expect(hashReads).toBe(2);
        expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        const [record, ...others] = records.filter((entry) => entry.event === VALIDATION_EVENT);
        expect(others).toEqual([]);
        const { context } = record;
        expect(context).toMatchObject({
          operation: 'watermark',
          assetId: source.id,
          check: 'precommit-content',
          subcheck: 'hash-mismatch',
          hashMatch: false,
          rehash: 'performed',
          settling: 'not-reached',
        });
        expect(context.phases['precommit-after-hash']).toBeDefined();
        expect(context.phases['precommit-after-rehash']).toBeUndefined();
        expectSafeContext(context);
      });

      // Forges the post-hash fingerprint lstat (the second bigint lstat of `output` after a
      // pre-commit hash descriptor closes; the first is precommit-identity-after-hash) of the
      // hashes listed in `forge`, keyed by the 1-based hash read.
      const forgePostHashFingerprint = (output, forge) => {
        const realOpen = fs.openSync.bind(fs);
        const realClose = fs.closeSync.bind(fs);
        const realLstat = fs.lstatSync.bind(fs);
        const hashDescriptors = new Map();
        const state = { hashReads: 0, forged: [] };
        let pending = null;
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          const descriptor = realOpen(filePath, flags, ...args);
          if (typeof filePath === 'string' && flags === 'r' && path.resolve(filePath) === output) {
            state.hashReads += 1;
            hashDescriptors.set(descriptor, state.hashReads);
          }
          return descriptor;
        });
        const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
          realClose(descriptor);
          const read = hashDescriptors.get(descriptor);
          hashDescriptors.delete(descriptor);
          if (forge[read]) pending = { read, lstats: 0 };
        });
        const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
          const stats = realLstat(filePath, ...args);
          if (!pending || typeof stats.ino !== 'bigint' || path.resolve(String(filePath)) !== output) return stats;
          pending.lstats += 1;
          if (pending.lstats < 2) return stats;
          const { read } = pending;
          pending = null;
          state.forged.push(read);
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, forge[read](stats));
        });
        state.restore = () => {
          lstatSpy.mockRestore();
          closeSpy.mockRestore();
          openSpy.mockRestore();
        };
        return state;
      };

      it('logs a post-hash identity rejection after a passing first validation as not settled', async () => {
        const records = withRealLogger();
        const source = await writeIndexedImage('Final/diag-after-hash-identity.png');
        const output = path.resolve(projectDir, 'wm', 'diag-after-hash-identity_wm.png');
        // identity → size → hash → identity pass; the post-hash fingerprint then sees a foreign inode.
        const hook = forgePostHashFingerprint(output, { 1: (stats) => ({ ino: stats.ino + 1n }) });
        let failure;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        } finally {
          hook.restore();
        }

        expect(hook.forged).toEqual([1]);
        expect(hook.hashReads).toBe(1);
        expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        const [record, ...others] = records.filter((entry) => entry.event === VALIDATION_EVENT);
        expect(others).toEqual([]);
        const { context } = record;
        expect(context).toMatchObject({
          operation: 'watermark',
          assetId: source.id,
          check: 'precommit-identity',
          subcheck: 'dev-ino-mismatch',
          identityMatch: 'dev-ino-mismatch',
          hashMatch: true,
          rehash: 'not-reached',
          settling: 'not-reached',
          compared: ['expected', 'precommit-after-hash'],
        });
        expect(context.phases['precommit-identity-after-hash']).not.toHaveProperty('identity');
        expect(context.phases['precommit-after-hash']).toMatchObject({ identity: 'dev-ino-mismatch' });
        expect(context.phases['precommit-after-rehash']).toBeUndefined();
        expectSafeContext(context);
      });

      it('logs a post-rehash identity rejection after a passing second validation as performed, not settled', async () => {
        const records = withRealLogger();
        const source = await writeIndexedImage('Final/diag-after-rehash-identity.png');
        const output = path.resolve(projectDir, 'wm', 'diag-after-rehash-identity_wm.png');
        // The first post-hash fingerprint moves (identity held), so the bytes are verified again;
        // that second validation passes and the post-rehash fingerprint sees a foreign inode.
        const hook = forgePostHashFingerprint(output, {
          1: (stats) => ({ mtimeNs: stats.mtimeNs + 1000n, ctimeNs: stats.ctimeNs + 1000n }),
          2: (stats) => ({ ino: stats.ino + 1n }),
        });
        let failure;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        } finally {
          hook.restore();
        }

        expect(hook.forged).toEqual([1, 2]);
        expect(hook.hashReads).toBe(2);
        expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        const [record, ...others] = records.filter((entry) => entry.event === VALIDATION_EVENT);
        expect(others).toEqual([]);
        const { context } = record;
        expect(context).toMatchObject({
          operation: 'watermark',
          assetId: source.id,
          check: 'precommit-identity',
          subcheck: 'dev-ino-mismatch',
          identityMatch: 'dev-ino-mismatch',
          hashMatch: true,
          rehash: 'performed',
          settling: 'not-reached',
          compared: ['expected', 'precommit-after-rehash'],
        });
        expect(context.phases['precommit-after-hash']).not.toHaveProperty('identity');
        expect(context.phases['precommit-after-rehash']).toMatchObject({ identity: 'dev-ino-mismatch' });
        expectSafeContext(context);
      });

      it('logs the copy-source comparison of a publish-create-failed source-changed failure', async () => {
        const records = withRealLogger();
        const source = await writeIndexedImage('Final/diag-source-changed.png');
        const output = path.resolve(projectDir, 'wm', 'diag-source-changed_wm.png');
        // The stage's read descriptor reports a later mtime/ctime after the copy; its identity,
        // size, bytes and pathname stat are unchanged.
        const realOpen = fs.openSync.bind(fs);
        const realFstat = fs.fstatSync.bind(fs);
        const stageReads = new Map();
        let fired = false;
        const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
          const descriptor = realOpen(filePath, flags, ...args);
          if (typeof filePath === 'string' && flags === 'r' && inStaging('0.output')(path.resolve(filePath))) {
            stageReads.set(descriptor, 0);
          }
          return descriptor;
        });
        const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
          const stats = realFstat(descriptor, ...args);
          if (!stageReads.has(descriptor) || typeof stats.ino !== 'bigint') return stats;
          const index = stageReads.get(descriptor);
          stageReads.set(descriptor, index + 1);
          if (fired || index === 0) return stats;
          fired = true;
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
            mtimeNs: stats.mtimeNs + 1000n, ctimeNs: stats.ctimeNs + 1000n,
          });
        });
        let failure;
        try {
          failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
        } finally {
          fstatSpy.mockRestore();
          openSpy.mockRestore();
        }

        expect(fired).toBe(true);
        expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
        expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
          artifactRole: 'published-output', check: 'publish-create-failed', proof: 'source-changed',
        }));
        expect(fs.existsSync(output)).toBe(false);
        const [record, ...others] = records.filter((entry) => entry.event === VALIDATION_EVENT);
        expect(others).toEqual([]);
        const { context } = record;
        expect(context).toMatchObject({
          operation: 'watermark',
          assetId: source.id,
          itemIndex: 0,
          check: 'publish-create-failed',
          proof: 'source-changed',
          copySourceRole: 'stage-output',
          copySource: {
            phase: 'source-after-copy',
            failed: ['descriptor-continuity'],
            identityKnown: true,
            pathDescriptorIdentity: 'matched',
            changed: { 'opened-fstat/after-fstat': ['mtimeNs', 'ctimeNs'], 'opened-fstat/after-lstat': [] },
            involved: ['mtime', 'ctime'],
            copiedContent: 'matched',
          },
        });
        const { observations } = context.copySource;
        expect(Object.keys(observations)).toEqual(['before-lstat', 'opened-fstat', 'after-fstat', 'after-lstat']);
        expect(context.copySource.copiedSize).toBe(observations['opened-fstat'].size);
        expect(BigInt(observations['after-fstat'].mtimeNs) - BigInt(observations['opened-fstat'].mtimeNs)).toBe(1000n);
        expectSafeContext(context);
      });
      describe('NAS write-time settling (WP3)', () => {
        // Runs `onRead(path)` once, immediately before read-only open number `index` (0-based) of
        // `target`: 0 is the first pre-commit hash, 1 the re-hash, 2 the settling verification.
        const beforeReadOf = (target, index, onRead) => {
          const state = { fired: false };
          state.onReadOpen = (filePath, opened) => {
            if (filePath !== target || opened !== index || state.fired) return;
            state.fired = true;
            onRead(filePath);
          };
          return state;
        };
        const nasOn = (outputs, settings) => {
          const resolved = new Set(outputs);
          return modelNasWriteTimes((filePath) => resolved.has(filePath), settings);
        };
        const indexedOutput = (name) => assetRepository.findByProjectIdAndPath(project.id, `wm/${name}_wm.png`);
        const [timeB, timeA, timeC] = PRODUCTION_NAS_TIMES.map(String);

        // Production shape: identity, size and both hashes matched while the pathname reported
        // B, then A, then C. Previously the output was rejected as fingerprint-changed/unstable.
        it('records every output of a multi-output run under the production A-B-C write-time sequence', async () => {
          const records = withRealLogger();
          const names = ['nas-a', 'nas-b', 'nas-c'];
          const sources = [];
          for (const name of names) sources.push(await writeIndexedImage(`Final/${name}.png`));
          const outputs = names.map((name) => path.resolve(projectDir, 'wm', `${name}_wm.png`));
          const nas = nasOn(outputs);
          let result;
          try {
            result = await processingService.watermarkAssets(project.id, sources.map((source) => source.id), options);
          } finally {
            nas.restore();
          }

          for (const output of outputs) {
            // B before the first hash, A after it, C after the re-hash, C through the final sweep.
            const values = nas.observed.get(output).map(String);
            expect([...new Set(values)]).toEqual([timeB, timeA, timeC]);
            expect(values.at(-1)).toBe(timeC);
          }
          expect(result).toMatchObject({ status: 'completed' });
          expect(result.generatedAssetIds).toHaveLength(outputs.length);
          for (const [index, name] of names.entries()) {
            const row = indexedOutput(name);
            expect(result.generatedAssetIds).toContain(row.id);
            expect(row.generated_output_sha256).toBe(sha256For(outputs[index]));
            expect(assetRepository.findGeneratedOutputProvenance(project.id, row.id)).toBe(provenanceTupleOf(outputs[index]));
          }
          expect(watermarkWorkspaces()).toEqual([]);
          expect(records.filter((entry) => entry.event === VALIDATION_EVENT)).toEqual([]);
        });

        it('rejects write times that still move across the settling verification', async () => {
          const records = withRealLogger();
          const source = await writeIndexedImage('Final/nas-drift.png');
          const output = path.resolve(projectDir, 'wm', 'nas-drift_wm.png');
          // The production A-B-C, then a new value after every further read: never settles.
          const nas = nasOn([output], {
            timeAfter: (reads) => (reads < 3 ? PRODUCTION_NAS_TIMES[reads] : PRODUCTION_NAS_TIMES[2] + BigInt(reads) * 1000n),
          });
          let failure;
          try {
            failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
          } finally {
            nas.restore();
          }

          expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
          expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
            assetId: source.id, artifactRole: 'published-output', check: 'precommit-content',
          }));
          expect(fs.existsSync(output)).toBe(false);
          expect(indexedOutput('nas-drift')).toBeFalsy();
          expect(watermarkWorkspaces()).toEqual([]);
          const [record, ...others] = records.filter((entry) => entry.event === VALIDATION_EVENT);
          expect(others).toEqual([]);
          expect(record.context).toMatchObject({
            check: 'precommit-content',
            subcheck: 'fingerprint-changed',
            identityMatch: 'matched',
            hashMatch: true,
            rehash: 'performed',
            settling: 'unstable',
            compared: ['precommit-settle-before-hash', 'precommit-settle-after-hash'],
            changedFields: ['mtimeNs', 'ctimeNs'],
          });
          // The snapshot observed exactly the production sequence.
          expect(record.context.phases).toMatchObject({
            'precommit-before-hash': { mtimeNs: timeB, ctimeNs: timeB },
            'precommit-after-hash': { mtimeNs: timeA, ctimeNs: timeA },
            'precommit-after-rehash': { mtimeNs: timeC, ctimeNs: timeC },
          });
          expectSafeContext(record.context);
        });

        for (const [read, label, settling] of [[1, 're-hash', 'not-reached'], [2, 'settling verification', 'deferred']]) {
          it(`rejects A-B-C write times when the bytes change before the ${label}`, async () => {
            const records = withRealLogger();
            const source = await writeIndexedImage(`Final/nas-bytes-${read}.png`);
            const output = path.resolve(projectDir, 'wm', `nas-bytes-${read}_wm.png`);
            // Rewritten in place (same inode, same size) after the earlier hashes matched.
            const hook = beforeReadOf(output, read,
              (filePath) => rewriteInPlace(filePath, Buffer.alloc(fs.statSync(filePath).size, 0x45)));
            const nas = nasOn([output], { onReadOpen: hook.onReadOpen });
            let failure;
            try {
              failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
            } finally {
              nas.restore();
            }

            expect(hook.fired).toBe(true);
            expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: source.id, artifactRole: 'published-output', check: 'precommit-content',
            }));
            expect(indexedOutput(`nas-bytes-${read}`)).toBeFalsy();
            const [record] = records.filter((entry) => entry.event === VALIDATION_EVENT);
            expect(record.context).toMatchObject({
              subcheck: 'hash-mismatch', hashMatch: false, rehash: 'performed', settling,
            });
            expectSafeContext(record.context);
          });

          it(`rejects A-B-C write times when a same-bytes foreign file replaces the output before the ${label}`, async () => {
            const source = await writeIndexedImage(`Final/nas-foreign-${read}.png`);
            const output = path.resolve(projectDir, 'wm', `nas-foreign-${read}_wm.png`);
            let foreignIno;
            const hook = beforeReadOf(output, read, (filePath) => {
              foreignIno = replaceWithSameBytes(filePath);
            });
            const nas = nasOn([output], { onReadOpen: hook.onReadOpen });
            let failure;
            try {
              failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
            } finally {
              nas.restore();
            }

            expect(hook.fired).toBe(true);
            // The foreign file is never adopted, removed or recorded; it blocks a complete rollback.
            expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: source.id, artifactRole: 'published-output', check: 'precommit-unreadable',
            }));
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: source.id, artifactRole: 'published-output', check: 'rollback-identity-mismatch',
            }));
            expect(fs.statSync(output, { bigint: true }).ino).toBe(foreignIno);
            expect(indexedOutput(`nas-foreign-${read}`)).toBeFalsy();
          });
        }

        // A settled at its settling verification; B's reads follow it. Index 0 of B is B's
        // first pre-commit hash; index 2 is B's own settling verification (both unsettled).
        for (const [read, label] of [[0, 'first hash'], [2, 'settling verification']]) {
          it(`rejects a settled output rewritten in place during a later output's ${label}`, async () => {
            const records = withRealLogger();
            const first = await writeIndexedImage(`Final/nas-sweep-a${read}.png`);
            const second = await writeIndexedImage(`Final/nas-sweep-b${read}.png`);
            const outputA = path.resolve(projectDir, 'wm', `nas-sweep-a${read}_wm.png`);
            const outputB = path.resolve(projectDir, 'wm', `nas-sweep-b${read}_wm.png`);
            // Before B's first hash, A has had its two snapshot reads; before B's settling read,
            // A has also had its own settling verification.
            const hook = beforeReadOf(outputB, read,
              () => rewriteInPlaceLater(outputA, Buffer.alloc(fs.statSync(outputA).size, 0x46)));
            const nas = nasOn([outputA, outputB], { onReadOpen: hook.onReadOpen });
            let failure;
            try {
              failure = await processingService.watermarkAssets(project.id, [first.id, second.id], options)
                .catch((err) => err);
            } finally {
              nas.restore();
            }

            expect(hook.fired).toBe(true);
            expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
            expect(indexedOutput(`nas-sweep-a${read}`)).toBeFalsy();
            expect(indexedOutput(`nas-sweep-b${read}`)).toBeFalsy();
            const [record, ...others] = records.filter((entry) => entry.event === VALIDATION_EVENT);
            expect(others).toEqual([]);
            if (read === 0) {
              // Rewritten before its own settling verification: that read sees the new bytes.
              expect(record.context).toMatchObject({
                assetId: first.id, check: 'precommit-content', subcheck: 'hash-mismatch', settling: 'deferred',
              });
            } else {
              // Rewritten after its own settling verification: the final sweep sees its write
              // metadata move, and its one reverification reads the new bytes.
              expect(record.context).toMatchObject({
                assetId: first.id,
                check: 'precommit-final-content-mismatch',
                subcheck: 'hash-mismatch',
                hashMatch: false,
                rehash: 'performed',
                settling: 'held-after-settle',
                finalReverify: 'performed',
                finalSweepMoved: {
                  compared: ['precommit-settle-after-hash', 'precommit-final-sweep'],
                  changedFields: ['mtimeNs', 'ctimeNs'],
                },
              });
            }
            expectSafeContext(record.context);
          });
        }

        // WP3 C4: the final metadata sweep observed moved write times on a verified output.
        describe('final-sweep write-time movement (WP3 C4)', () => {
          const { afterRehash, finalSweep } = PRODUCTION_FINAL_SWEEP_TIMES;
          // Before the first hash (not in the production evidence; any value other than afterRehash).
          const beforeHash = afterRehash - 1000000000n;
          // Nine outputs, as in production. Output 6 reports beforeHash, then afterRehash across
          // its first hash and re-hash (held-after-rehash); the other outputs hold one value. Once
          // a later output's first pre-commit read opens (`trigger`, 7 by default), each output in
          // `late` reports finalSweep (+ `drift(n)` after n reads), as production's final sweep
          // did. `onTrigger` and `onReadOpen` run further changes at those points.
          const runFinalSweepMovement = async (prefix, {
            late = [6], trigger = 7, drift = () => 0n, onTrigger, onReadOpen, onLstat, logger = true,
          } = {}) => {
            const records = logger ? withRealLogger() : [];
            const names = Array.from({ length: 9 }, (_, index) => `${prefix}-${index}`);
            const sources = [];
            for (const name of names) sources.push(await writeIndexedImage(`Final/${name}.png`));
            const outputs = names.map((name) => path.resolve(projectDir, 'wm', `${name}_wm.png`));
            const moved = new Set();
            const target = outputs[6];
            const nas = nasOn(outputs, {
              timeAfter: (reads, filePath) => {
                if (moved.has(filePath)) return finalSweep + drift(reads);
                if (filePath !== target) return afterRehash;
                return reads === 0 ? beforeHash : afterRehash;
              },
              onReadOpen: (filePath, opened) => {
                if (filePath === outputs[trigger] && opened === 0 && moved.size === 0) {
                  for (const index of late) moved.add(outputs[index]);
                  onTrigger?.(outputs);
                }
                onReadOpen?.(filePath, opened, outputs);
              },
              onLstat: (filePath, stats) => onLstat?.(filePath, stats, outputs),
            });
            const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
            let result;
            let failure;
            let applyCalls;
            try {
              result = await processingService.watermarkAssets(project.id, sources.map((source) => source.id), options)
                .catch((err) => { failure = err; });
            } finally {
              // mockRestore() clears call history, so capture it first.
              applyCalls = applySpy.mock.calls.length;
              applySpy.mockRestore();
              nas.restore();
            }
            expect(moved.size).toBe(late.length);
            const validation = records.filter((entry) => entry.event === VALIDATION_EVENT);
            return { result, failure, applyCalls, outputs, names, sources, nas, validation };
          };
          const expectNothingRecorded = (names) => {
            for (const name of names) expect(indexedOutput(name)).toBeFalsy();
          };
          const sameSizeBytes = (target, fill) => Buffer.alloc(fs.statSync(target).size, fill);

          it('records all nine outputs when only the final sweep observes later write times and the bytes are intact', async () => {
            const { result, applyCalls, outputs, names, nas, validation } = await runFinalSweepMovement('c4-ok');

            // Production: the post-rehash value held, then the final sweep reported a later one.
            const values = nas.observed.get(outputs[6]).map(String);
            expect([...new Set(values)]).toEqual([beforeHash, afterRehash, finalSweep].map(String));
            expect(values.at(-1)).toBe(String(finalSweep));
            expect(result).toMatchObject({ status: 'completed' });
            expect(applyCalls).toBe(1);
            expect(result.generatedAssetIds).toHaveLength(9);
            for (const [index, name] of names.entries()) {
              const row = indexedOutput(name);
              expect(result.generatedAssetIds).toContain(row.id);
              expect(row.generated_output_sha256).toBe(sha256For(outputs[index]));
              expect(assetRepository.findGeneratedOutputProvenance(project.id, row.id)).toBe(provenanceTupleOf(outputs[index]));
            }
            expect(watermarkWorkspaces()).toEqual([]);
            expect(validation).toEqual([]);
          });

          it('records outputs reverified by the final sweep when several outputs moved', async () => {
            const { result, names } = await runFinalSweepMovement('c4-multi', { late: [0, 3, 6], logger: false });
            expect(result).toMatchObject({ status: 'completed' });
            for (const name of names) expect(result.generatedAssetIds).toContain(indexedOutput(name).id);
          });

          // A same-size modification moves only write times, so it is reverified and its hash rejects it.
          for (const [label, rewrite, subcheck] of [
            ['a same-size byte modification', (target) => rewriteInPlace(target, sameSizeBytes(target, 0x47)), 'hash-mismatch'],
          ]) {
            it(`rejects ${label} after the earlier hashes, before the final sweep`, async () => {
              const { failure, applyCalls, outputs, names, sources, validation } = await runFinalSweepMovement(
                `c4-mod-${subcheck}`, { onTrigger: (all) => rewrite(all[6]) });

              expect(applyCalls).toBe(0);
              expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
              expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
                assetId: sources[6].id, artifactRole: 'published-output', check: 'precommit-final-content-mismatch',
              }));
              expectNothingRecorded(names);
              for (const output of outputs) expect(fs.existsSync(output)).toBe(false);
              expect(watermarkWorkspaces()).toEqual([]);
              const [record, ...others] = validation;
              expect(others).toEqual([]);
              expect(record.context).toMatchObject({
                assetId: sources[6].id,
                itemIndex: 6,
                check: 'precommit-final-content-mismatch',
                subcheck,
                identityMatch: 'matched',
                rehash: 'performed',
                settling: 'held-after-rehash',
                finalReverify: 'performed',
                finalSweepMoved: { compared: ['precommit-after-rehash', 'precommit-final-sweep'] },
              });
              expect(record.context.finalSweepMoved.changedFields).toEqual(expect.arrayContaining(['mtimeNs', 'ctimeNs']));
              expectSafeContext(record.context);
            });
          }

          // WP3 C6: a size the final sweep saw differ from the verified size rejects at once, never
          // deferred to the reverification, so a size restored before that read cannot erase it.
          const expectSizeRejected = ({ failure, applyCalls, outputs, names, sources, validation }) => {
            expect(applyCalls).toBe(0);
            expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: sources[6].id, artifactRole: 'published-output', check: 'precommit-final-content-mismatch',
            }));
            expectNothingRecorded(names);
            for (const output of outputs) expect(fs.existsSync(output)).toBe(false);
            expect(watermarkWorkspaces()).toEqual([]);
            const [record, ...others] = validation;
            expect(others).toEqual([]);
            expect(record.context).toMatchObject({
              assetId: sources[6].id,
              itemIndex: 6,
              check: 'precommit-final-content-mismatch',
              identityMatch: 'matched',
              finalReverify: 'not-reached',
              compared: ['precommit-after-rehash', 'precommit-final-sweep'],
            });
            expect(record.context.changedFields).toContain('size');
            expect(record.context.finalSweepMoved).toBeUndefined();
            expectSafeContext(record.context);
          };

          it('rejects a size change seen by the final sweep although the size is restored before reverification', async () => {
            let original;
            const sizes = {};
            const run = await runFinalSweepMovement('c6-transient', {
              onTrigger: (all) => {
                original = fs.readFileSync(all[6]);
                sizes.verified = original.length;
                rewriteInPlace(all[6], Buffer.concat([original, Buffer.alloc(16, 0x4d)]));
              },
              // The first observation of the appended size is the final sweep's; the bytes and size
              // are restored immediately after it, before any reverification could read them.
              onLstat: (filePath, stats, all) => {
                if (filePath !== all[6] || original === undefined || sizes.swept !== undefined
                  || stats.size !== BigInt(sizes.verified + 16)) return;
                sizes.swept = Number(stats.size);
                rewriteInPlace(filePath, original);
                sizes.restored = fs.statSync(filePath).size;
              },
            });

            expect(sizes).toEqual({ verified: sizes.verified, swept: sizes.verified + 16, restored: sizes.verified });
            expectSizeRejected(run);
          });

          it('rejects a size change that persists through the final sweep', async () => {
            const run = await runFinalSweepMovement('c6-persistent', {
              onTrigger: (all) => rewriteInPlace(all[6], Buffer.alloc(fs.statSync(all[6]).size + 16, 0x48)),
            });
            expectSizeRejected(run);
          });

          it('rejects a size change seen by the final sweep with unchanged write times', async () => {
            // No modelled write-time movement: the size alone differs at the final sweep.
            const run = await runFinalSweepMovement('c6-size-only', {
              late: [],
              onTrigger: (all) => {
                const { atimeMs, mtimeMs } = fs.statSync(all[6]);
                rewriteInPlace(all[6], Buffer.alloc(fs.statSync(all[6]).size + 16, 0x4e));
                fs.utimesSync(all[6], atimeMs / 1000, mtimeMs / 1000);
              },
            });
            expectSizeRejected(run);
          });

          it('rejects a same-bytes foreign replacement seen by the final sweep without reverifying it', async () => {
            let foreignIno;
            const { failure, applyCalls, outputs, names, sources, validation } = await runFinalSweepMovement('c4-foreign', {
              onTrigger: (all) => { foreignIno = replaceWithSameBytes(all[6]); },
            });

            expect(applyCalls).toBe(0);
            // The foreign file is never adopted, removed or recorded; it blocks a complete rollback.
            expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: sources[6].id, artifactRole: 'published-output', check: 'precommit-final-identity-mismatch',
            }));
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: sources[6].id, artifactRole: 'published-output', check: 'rollback-identity-mismatch',
            }));
            expect(fs.statSync(outputs[6], { bigint: true }).ino).toBe(foreignIno);
            expectNothingRecorded(names);
            const [record] = validation;
            expect(record.context).toMatchObject({
              assetId: sources[6].id, check: 'precommit-final-identity-mismatch', subcheck: 'dev-ino-mismatch',
              finalReverify: 'not-reached',
            });
            expectSafeContext(record.context);
          });

          // Output 6 has two pre-commit reads (hash, re-hash); open 2 is its final reverification.
          it('rejects a same-size byte modification during the final reverification', async () => {
            const { failure, names, sources, validation } = await runFinalSweepMovement('c4-during', {
              onReadOpen: (filePath, opened, all) => {
                if (filePath === all[6] && opened === 2) rewriteInPlace(filePath, sameSizeBytes(filePath, 0x49));
              },
            });

            expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
            expectNothingRecorded(names);
            expect(watermarkWorkspaces()).toEqual([]);
            expect(validation[0].context).toMatchObject({
              assetId: sources[6].id, check: 'precommit-final-content-mismatch', subcheck: 'hash-mismatch',
              hashMatch: false, finalReverify: 'performed',
            });
            expectSafeContext(validation[0].context);
          });

          it('rejects a same-bytes foreign replacement during the final reverification', async () => {
            let foreignIno;
            const { failure, outputs, names, sources } = await runFinalSweepMovement('c4-during-foreign', {
              logger: false,
              onReadOpen: (filePath, opened, all) => {
                if (filePath === all[6] && opened === 2) foreignIno = replaceWithSameBytes(filePath);
              },
            });

            expect(foreignIno).toBeDefined();
            expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: sources[6].id, artifactRole: 'published-output', check: 'precommit-final-content-unreadable',
            }));
            expect(fs.statSync(outputs[6], { bigint: true }).ino).toBe(foreignIno);
            expectNothingRecorded(names);
          });

          it('rejects write times that still move across the final reverification', async () => {
            const { failure, names, sources, validation } = await runFinalSweepMovement('c4-drift', {
              drift: (reads) => BigInt(reads) * 1000n,
            });

            expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
            expectNothingRecorded(names);
            expect(watermarkWorkspaces()).toEqual([]);
            expect(validation[0].context).toMatchObject({
              assetId: sources[6].id,
              check: 'precommit-final-content-mismatch',
              subcheck: 'fingerprint-changed',
              hashMatch: true,
              finalReverify: 'performed',
              compared: ['precommit-reverify-before-hash', 'precommit-reverify-after-hash'],
              changedFields: ['mtimeNs', 'ctimeNs'],
            });
            expectSafeContext(validation[0].context);
          });

          // The second sweep is strict: nothing it sees moved is reverified again.
          for (const [label, change] of [
            ['rewritten in place', (target) => rewriteInPlaceLater(target, sameSizeBytes(target, 0x4a))],
            ['given later write times with intact bytes', (target) => {
              const { atimeMs, mtimeMs } = fs.statSync(target);
              fs.utimesSync(target, atimeMs / 1000, mtimeMs / 1000 + 5);
            }],
          ]) {
            it(`rejects an earlier output ${label} during a later output's final reverification`, async () => {
              const { failure, names, sources, validation } = await runFinalSweepMovement(`c4-other-${label.length}`, {
                onReadOpen: (filePath, opened, all) => {
                  if (filePath === all[6] && opened === 2) change(all[2]);
                },
              });

              expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
              expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
                assetId: sources[2].id, artifactRole: 'published-output', check: 'precommit-final-content-mismatch',
              }));
              expectNothingRecorded(names);
              expect(watermarkWorkspaces()).toEqual([]);
              expect(validation[0].context).toMatchObject({
                assetId: sources[2].id,
                check: 'precommit-final-content-mismatch',
                subcheck: 'fingerprint-changed',
                finalReverify: 'other-output',
                compared: ['precommit-after-hash', 'precommit-final-sweep'],
                changedFields: ['mtimeNs', 'ctimeNs'],
              });
              expectSafeContext(validation[0].context);
            });
          }

          it('rejects an already reverified output rewritten during a later output\'s final reverification', async () => {
            const { failure, names, sources, validation } = await runFinalSweepMovement('c4-reverified', {
              late: [3, 6],
              onReadOpen: (filePath, opened, all) => {
                if (filePath === all[6] && opened === 2) rewriteInPlaceLater(all[3], sameSizeBytes(all[3], 0x4b));
              },
            });

            expect(failure).toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
            expectNothingRecorded(names);
            expect(validation[0].context).toMatchObject({
              assetId: sources[3].id,
              check: 'precommit-final-content-mismatch',
              subcheck: 'fingerprint-changed',
              finalReverify: 'performed',
              compared: ['precommit-reverify-after-hash', 'precommit-final-sweep'],
            });
            expectSafeContext(validation[0].context);
          });
        });

        // WP3 C5: every recovery backup stays under continuity through C4's final-sweep
        // reverification and every later pre-commit check.
        describe('recovery backup continuity through the final sweep (WP3 C5)', () => {
          const { afterRehash, finalSweep } = PRODUCTION_FINAL_SWEEP_TIMES;
          const isBackup = inStaging('.destination');
          const isArchiveBackup = (filePath) => path.basename(filePath).includes('archive-');
          const isOutput = (filePath) => !filePath.includes('.creatorcrate-') && path.basename(filePath).includes('_wm.');
          // Overwrites the prior run's owned outputs (and archives), so each has a verified backup.
          // Only the outputs' write times are modelled; backup reads are observed, unmodelled, so
          // rollback's restore copy sees a backup whose pathname and descriptor agree.
          // Once a backup's pre-commit read opens after an output's first pre-commit hash, the
          // outputs hashed so far report later write times (production's final-sweep shape), so
          // the final sweep reverifies them (C4). `duringReverify(backups)` runs once, as the first
          // reverification read opens; `backups` lists the backup paths read so far.
          const overwriteWithReverification = async (name, {
            runOptions = options, overwriteOptions = { overwrite: true }, duringReverify, injectIndexFailure = false,
          } = {}) => {
            const source = await writeIndexedImage(`Final/${name}.png`);
            await processingService.watermarkAssets(project.id, [source.id], runOptions);
            const outputs = fs.readdirSync(path.resolve(projectDir, 'wm')).filter((entry) => entry.startsWith(`${name}_`))
              .map((entry) => path.resolve(projectDir, 'wm', entry));
            const previous = new Map(outputs.map((output) => [output, fs.readFileSync(output)]));
            const hashed = new Set();
            const moved = new Set();
            const backups = new Set();
            let reverifyReads = 0;
            const realOpen = fs.openSync;
            fs.openSync = (filePath, flags, ...args) => {
              const resolved = typeof filePath === 'string' ? path.resolve(filePath) : null;
              if (resolved && flags === 'r' && isBackup(resolved)) {
                backups.add(resolved);
                if (hashed.size > 0 && moved.size === 0) for (const output of hashed) moved.add(output);
              }
              return realOpen.call(fs, filePath, flags, ...args);
            };
            const nas = modelNasWriteTimes(isOutput, {
              timeAfter: (reads, filePath) => (moved.has(filePath) ? finalSweep : afterRehash),
              onReadOpen: (filePath, opened) => {
                if (opened === 0) hashed.add(filePath);
                if (moved.has(filePath) && opened === 1 && reverifyReads++ === 0) duringReverify?.([...backups]);
              },
            });
            const applySpy = injectIndexFailure ? failingIndex() : vi.spyOn(assetRepository, 'applyAssetWatermarks');
            let result;
            let failure;
            let applyCalls;
            try {
              result = await processingService.watermarkAssets(project.id, [source.id], { ...runOptions, ...overwriteOptions })
                .catch((err) => { failure = err; });
            } finally {
              // mockRestore() clears call history, so capture it first.
              applyCalls = applySpy.mock.calls.length;
              applySpy.mockRestore();
              nas.restore();
              fs.openSync = realOpen;
            }
            expect(outputs.length).toBeGreaterThan(0);
            expect(moved.size).toBeGreaterThan(0);
            expect(reverifyReads).toBeGreaterThan(0);
            return { result, failure, applyCalls, source, outputs, previous };
          };
          const corruptInPlace = (target) => rewriteInPlaceLater(target, Buffer.alloc(fs.statSync(target).size, 0x4c));
          const retainedBackup = (name) => {
            const [workspace, ...others] = watermarkWorkspaces();
            expect(others).toEqual([]);
            return stageArtifact(path.join(projectDir, workspace), name);
          };

          it('records the overwrite when backups stay unchanged through the final reverification', async () => {
            const { result, applyCalls, outputs } = await overwriteWithReverification('c5-ok');
            expect(result).toMatchObject({ status: 'completed' });
            expect(applyCalls).toBe(1);
            for (const output of outputs) {
              const row = assetRepository.findByProjectIdAndPath(project.id, path.relative(projectDir, output)
                .split(path.sep).join('/'));
              expect(row.generated_output_sha256).toBe(sha256For(output));
            }
            expect(watermarkWorkspaces()).toEqual([]);
          });

          it('rejects a Watermark backup corrupted during the final reverification before the index commit', async () => {
            let corrupted;
            const { failure, applyCalls, source, outputs, previous } = await overwriteWithReverification('c5-wm', {
              duringReverify: (backups) => {
                corrupted = backups.find((backup) => !isArchiveBackup(backup));
                corruptInPlace(corrupted);
              },
            });

            expect(applyCalls).toBe(0);
            // The damaged backup is never restoration material: the destination stays missing,
            // the backup is kept as evidence and recovery is required.
            expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED', cause: { code: 'FILESYSTEM_OPERATION_FAILED' } });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: source.id, artifactRole: 'destination-backup', check: 'precommit-final-backup-content-mismatch',
            }));
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: source.id, artifactRole: 'destination-backup', check: 'destination-restore-content-mismatch',
            }));
            expect(fs.existsSync(outputs[0])).toBe(false);
            const backup = retainedBackup('0.destination');
            expect(path.resolve(backup)).toBe(corrupted);
            expect(fs.readFileSync(backup)).not.toEqual(previous.get(outputs[0]));
          });

          it('rejects and keeps a foreign replacement of a Watermark backup during the final reverification', async () => {
            let foreignIno;
            const { failure, applyCalls, source } = await overwriteWithReverification('c5-wm-foreign', {
              duringReverify: (backups) => { foreignIno = replaceWithSameBytes(backups[0]); },
            });

            expect(applyCalls).toBe(0);
            expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              assetId: source.id, artifactRole: 'destination-backup', check: 'precommit-final-backup-identity-mismatch',
            }));
            expect(fs.statSync(retainedBackup('0.destination'), { bigint: true }).ino).toBe(foreignIno);
          });

          it('rejects an archive backup corrupted during the final reverification before the index commit', async () => {
            let corrupted;
            let corruptedBytes;
            const { failure, applyCalls } = await overwriteWithReverification('c5-archive', {
              runOptions: { ...archiveOptions, setName: 'C5Archive' },
              overwriteOptions: { overwrite: true, replaceExistingArchives: true },
              duringReverify: (backups) => {
                corrupted = backups.find(isArchiveBackup);
                corruptInPlace(corrupted);
                corruptedBytes = fs.readFileSync(corrupted);
              },
            });

            expect(corrupted).toBeDefined();
            expect(applyCalls).toBe(0);
            expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED', cause: { code: 'FILESYSTEM_OPERATION_FAILED' } });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              artifactRole: 'archive-backup', check: 'precommit-final-backup-content-mismatch',
            }));
            // Kept as evidence, never restored from or removed.
            expect(fs.readFileSync(corrupted)).toEqual(corruptedBytes);
          });

          it('restores from unchanged backups after an injected index failure following the final reverification', async () => {
            const { failure, applyCalls, outputs, previous } = await overwriteWithReverification('c5-index', {
              runOptions: { ...archiveOptions, setName: 'C5Index' },
              overwriteOptions: { overwrite: true, replaceExistingArchives: true },
              injectIndexFailure: true,
            });

            expect(applyCalls).toBe(1);
            expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
            for (const output of outputs) expect(fs.readFileSync(output)).toEqual(previous.get(output));
            expect(watermarkWorkspaces()).toEqual([]);
          });

          it('never reaches a failing index transaction with a backup corrupted during the final reverification', async () => {
            const { failure, applyCalls, outputs } = await overwriteWithReverification('c5-index-corrupt', {
              injectIndexFailure: true,
              duringReverify: (backups) => corruptInPlace(backups[0]),
            });

            expect(applyCalls).toBe(0);
            expect(failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              artifactRole: 'destination-backup', check: 'precommit-final-backup-content-mismatch',
            }));
            expect(fs.existsSync(outputs[0])).toBe(false);
            expect(fs.existsSync(retainedBackup('0.destination'))).toBe(true);
          });
        });

        // WP3 C2: the publication copy's open check of the private stage output.
        describe('stage open write-time disagreement (WP3 C2)', () => {
          const lagStages = (settings) => modelStageOpenWriteTimeLag(inStaging('.output'), settings);
          // Same size, different bytes: the last byte of the PNG's IEND CRC.
          const flipLastByte = (target) => {
            const bytes = fs.readFileSync(target);
            bytes[bytes.length - 1] ^= 0xff;
            rewriteInPlace(target, bytes);
          };

          it('publishes pinned stages whose pathname reports earlier write times than the opened descriptor', async () => {
            const records = withRealLogger();
            const names = ['stage-lag-a', 'stage-lag-b', 'stage-lag-c'];
            const sources = [];
            for (const name of names) sources.push(await writeIndexedImage(`Final/${name}.png`));
            const outputs = names.map((name) => path.resolve(projectDir, 'wm', `${name}_wm.png`));
            // The public outputs also follow the C1 production write-time sequence, so publication
            // continues into the deferred settling and final-sweep validation.
            const nas = nasOn(outputs);
            const lag = lagStages();
            let result;
            try {
              result = await processingService.watermarkAssets(project.id, sources.map((source) => source.id), options);
            } finally {
              lag.restore();
              nas.restore();
            }

            // Each publication open saw the production comparison: same identity, size and birth
            // time; the descriptor's mtime/ctime later than the pathname's.
            expect(lag.observed).toHaveLength(names.length);
            for (const { pathname, descriptor } of lag.observed) {
              for (const key of ['dev', 'ino', 'size', 'birthtimeNs']) expect(pathname[key]).toBe(descriptor[key]);
              expect(descriptor.mtimeNs).toBeGreaterThan(pathname.mtimeNs);
              expect(descriptor.ctimeNs).toBeGreaterThan(pathname.ctimeNs);
            }
            for (const output of outputs) {
              expect([...new Set(nas.observed.get(output).map(String))]).toEqual([timeB, timeA, timeC]);
            }
            expect(result).toMatchObject({ status: 'completed' });
            expect(result.generatedAssetIds).toHaveLength(outputs.length);
            for (const [index, name] of names.entries()) {
              const row = indexedOutput(name);
              expect(row.generated_output_sha256).toBe(sha256For(outputs[index]));
              expect(assetRepository.findGeneratedOutputProvenance(project.id, row.id)).toBe(provenanceTupleOf(outputs[index]));
            }
            expect(watermarkWorkspaces()).toEqual([]);
            expect(records.filter((entry) => entry.event === VALIDATION_EVENT)).toEqual([]);
          });

          it('rejects a same-size stage rewrite between the pathname stat and the open, and rolls back', async () => {
            const source = await writeIndexedImage('Final/stage-lag-rewrite.png');
            const sourcePath = path.resolve(projectDir, 'Final', 'stage-lag-rewrite.png');
            const sourceBytes = fs.readFileSync(sourcePath);
            const output = path.resolve(projectDir, 'wm', 'stage-lag-rewrite_wm.png');
            let rewritten = false;
            // Same inode, size and birth time; only the bytes (and write times) differ at open.
            const lag = lagStages({
              onOpen: (stagePath, { copy }) => {
                if (!copy || rewritten) return;
                rewritten = true;
                rewriteInPlaceLater(stagePath, (() => {
                  const bytes = fs.readFileSync(stagePath);
                  bytes[bytes.length - 1] ^= 0xff;
                  return bytes;
                })());
              },
            });
            let failure;
            try {
              failure = await processingService.watermarkAssets(project.id, [source.id], options).catch((err) => err);
            } finally {
              lag.restore();
            }

            expect(rewritten).toBe(true);
            expect(lag.observed).toHaveLength(1);
            const [{ pathname, descriptor }] = lag.observed;
            for (const key of ['dev', 'ino', 'size', 'birthtimeNs']) expect(pathname[key]).toBe(descriptor[key]);
            expect(descriptor.mtimeNs).not.toBe(pathname.mtimeNs);
            expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
            expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
              artifactRole: 'published-output', check: 'publish-create-failed', proof: 'content-mismatch',
            }));
            expect(fs.existsSync(output)).toBe(false);
            expect(indexedOutput('stage-lag-rewrite')).toBeFalsy();
            expect(fs.readFileSync(sourcePath).equals(sourceBytes)).toBe(true);
          });

          // WP3 C3: rewritten after its creating descriptor closed, before CreatorCrate hashed it,
          // so the stage hash matches the stage but not the bytes CreatorCrate rendered. The
          // rendered bytes stay authoritative: staging rejects it, with or without NAS lag,
          // before any publication, commit or source removal.
          for (const [label, withLag] of [['without write-time lag', false], ['with write-time lag', true]]) {
            it(`rejects a stage whose readback is not the rendered output ${label}`, async () => {
              const records = withRealLogger();
              const name = `stage-mismatch-${withLag ? 'lag' : 'plain'}`;
              const source = await writeIndexedImage(`Final/${name}.png`);
              const sourcePath = path.resolve(projectDir, 'Final', `${name}.png`);
              const sourceBytes = fs.readFileSync(sourcePath);
              const output = path.resolve(projectDir, 'wm', `${name}_wm.png`);
              const hook = hookOwnedCreate(inStaging('0.output'), { after: flipLastByte, times: 1 });
              const lag = withLag ? lagStages() : null;
              const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
              let failure;
              try {
                failure = await processingService.watermarkAssets(project.id, [source.id], {
                  ...options, deleteSource: true,
                }).catch((err) => err);
                expect(applySpy).not.toHaveBeenCalled();
              } finally {
                applySpy.mockRestore();
                lag?.restore();
                hook.restore();
              }

              expect(hook.calls).toBe(1);
              // Rejected at staging: the publication open was never reached.
              if (lag) expect(lag.observed).toEqual([]);
              expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
              expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
                artifactRole: 'stage-output', check: 'stage-content-mismatch',
              }));
              expect(fs.existsSync(output)).toBe(false);
              expect(indexedOutput(name)).toBeFalsy();
              expect(fs.readFileSync(sourcePath).equals(sourceBytes)).toBe(true);
              expect(assetRepository.findById(source.id)).toBeTruthy();
              // The changed stage was CreatorCrate's own private artifact and nothing was
              // recovery-critical yet, so rollback disposed it and left no workspace.
              expect(watermarkWorkspaces()).toEqual([]);
              expect(records.filter((entry) => entry.event === VALIDATION_EVENT)).toEqual([]);
            });
          }
        });
      });
    });
  });

  describe('ownership provenance and unknown file IDs', () => {
    const options = { mode: 'patreon', outputFormat: 'png', deleteSource: false };
    const watermarkWorkspaces = () => stagingWorkspaces(projectDir, '.creatorcrate-watermark-');

    // Old: preflight accepted the generated row plus a matching hash and captured the current
    // (foreign) file's exact identity as owned, so the replacement unlinked it.
    it('never replaces a same-bytes foreign destination from a later run despite matching metadata', async () => {
      const source = await writeIndexedImage('Final/cross-run-foreign.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const output = path.resolve(projectDir, 'wm', 'cross-run-foreign_wm.png');
      const row = assetRepository.findById(first.generatedAssetIds[0]);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, row.id)).toMatch(/^v1:\d+:[1-9]\d*:\d+$/);

      const foreignIno = replaceWithSameBytes(output);
      expect(sha256For(output)).toBe(row.generated_output_sha256);
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], {
          ...options, overwrite: true,
        })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        expect(applySpy).not.toHaveBeenCalled();
      } finally {
        applySpy.mockRestore();
      }

      expect(fs.statSync(output, { bigint: true }).ino).toBe(foreignIno);
      expect(sha256For(output)).toBe(row.generated_output_sha256);
      expect(assetRepository.findById(row.id)).toEqual(row);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('replaces an unchanged prior output across runs and rotates its provenance', async () => {
      const source = await writeIndexedImage('Final/cross-run-owned.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const output = path.resolve(projectDir, 'wm', 'cross-run-owned_wm.png');
      const firstProvenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);

      await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
      const current = fs.statSync(output, { bigint: true });
      const secondProvenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
      expect(secondProvenance).not.toBe(firstProvenance);
      expect(secondProvenance).toBe(`v1:${current.dev}:${current.ino}:${current.birthtimeNs}`);

      // The rotated provenance authorizes the next replacement too.
      await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('treats a legacy generated row without provenance as not owned', async () => {
      const source = await writeIndexedImage('Final/legacy-provenance.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const output = path.resolve(projectDir, 'wm', 'legacy-provenance_wm.png');
      const ino = fs.statSync(output, { bigint: true }).ino;
      db.prepare('UPDATE assets SET generated_output_provenance = NULL WHERE id = ?').run(first.generatedAssetIds[0]);

      await expect(processingService.watermarkAssets(project.id, [source.id], {
        ...options, overwrite: true,
      })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
      expect(fs.statSync(output, { bigint: true }).ino).toBe(ino);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    const parseProvenance = (value) => {
      const [, dev, ino, birthtimeNs] = value.split(':');
      return { dev: BigInt(dev), ino: BigInt(ino), birthtimeNs: BigInt(birthtimeNs) };
    };
    const provenanceOf = ({ dev, ino, birthtimeNs }) => `v1:${dev}:${ino}:${birthtimeNs}`;
    // Provenance comes from the public output's own creating descriptor: model its identity.
    const isPublicOutput = (output) => (filePath) => filePath === output;
    const isWatermarkStage = (filePath) => filePath.includes('.creatorcrate-watermark-')
      && filePath.endsWith('0.output');

    // Old: preflight matched the full persisted tuple but carried only {dev, ino} forward, so
    // a foreign file reusing that exact dev/ino (other birth time) was backed up and unlinked.
    it('never replaces a destination that reuses the owned exact dev/ino with another birth time', async () => {
      const source = await writeIndexedImage('Final/reused-inode.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const output = path.resolve(projectDir, 'wm', 'reused-inode_wm.png');
      const provenance = assetRepository.findGeneratedOutputProvenance(project.id, assetId);
      const owned = parseProvenance(provenance);
      const row = assetRepository.findById(assetId);
      const before = fs.readFileSync(output);
      const realMkdir = fs.mkdirSync.bind(fs);
      const ids = mockFileIdentities();
      let foreignIno;
      let observedForeign;
      // Preflight has already accepted the owned destination; the swap lands (as staging is
      // prepared) before the
      // destructive backup/unlink boundary and reuses the exact owned dev/ino.
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, ...args) => {
        if (!foreignIno && String(dirPath).includes('.creatorcrate-watermark-')) {
          foreignIno = replaceWithSameBytes(output);
          ids.assign(output, { ino: owned.ino, birthtimeNs: owned.birthtimeNs + 1n });
          observedForeign = fs.lstatSync(output, { bigint: true });
          unlinkSpy.mockClear(); // only CreatorCrate's own unlinks from here on
        }
        return realMkdir(dirPath, ...args);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');

      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], {
          ...options, overwrite: true,
        })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        expect(applySpy).not.toHaveBeenCalled();
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).not.toContain(output);
      } finally {
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
        mkdirSpy.mockRestore();
        ids.restore();
      }

      // The foreign file matched the exact persisted dev/ino; only the birth time differed.
      expect(observedForeign.dev).toBe(owned.dev);
      expect(observedForeign.ino).toBe(owned.ino);
      expect(observedForeign.birthtimeNs).not.toBe(owned.birthtimeNs);
      expect(fs.statSync(output, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readFileSync(output)).toEqual(before);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenance);
      expect(assetRepository.findById(assetId)).toEqual(row);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    // Old: after strict publication proof, a destination swapped before the index commit was
    // committed as success with null provenance, recording a hash for a file CreatorCrate no
    // longer published. The final pre-commit validation must now refuse to commit.
    it('never commits an output whose destination was swapped after publication proof', async () => {
      const first = await writeIndexedImage('Final/swap-first.png');
      const second = await writeIndexedImage('Final/swap-second.png');
      const firstOutput = path.resolve(projectDir, 'wm', 'swap-first_wm.png');
      const secondOutput = path.resolve(projectDir, 'wm', 'swap-second_wm.png');
      let foreignIno;
      let publishedBytes;
      // The first output is already created and verified; the swap lands during later work.
      const hook = hookOwnedCreate((filePath) => filePath === secondOutput, {
        before: () => {
          publishedBytes = fs.readFileSync(firstOutput);
          foreignIno = replaceWithSameBytes(firstOutput);
        },
        times: 1,
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');

      try {
        await expect(processingService.watermarkAssets(project.id, [first.id, second.id], options))
          .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(applySpy).not.toHaveBeenCalled();
      } finally {
        applySpy.mockRestore();
        hook.restore();
      }

      // The same-bytes foreign destination is untouched; the owned second output is rolled back.
      expect(fs.statSync(firstOutput, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readFileSync(firstOutput)).toEqual(publishedBytes);
      expect(fs.existsSync(secondOutput)).toBe(false);
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/swap-first_wm.png')).toBeUndefined();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/swap-second_wm.png')).toBeUndefined();
      // The first output's stage is kept as recovery evidence.
      const [workspace, ...others] = watermarkWorkspaces();
      expect(others).toEqual([]);
      expect(stageNames(path.join(projectDir, workspace))).toEqual(['0.output']);
      expect(fs.readFileSync(stageArtifact(path.join(projectDir, workspace), '0.output'))).toEqual(publishedBytes);
    });

    it('fails ordinarily after a verified rollback when owned output bytes changed before commit', async () => {
      const first = await writeIndexedImage('Final/changed-first.png');
      const second = await writeIndexedImage('Final/changed-second.png');
      const firstOutput = path.resolve(projectDir, 'wm', 'changed-first_wm.png');
      const secondOutput = path.resolve(projectDir, 'wm', 'changed-second_wm.png');
      let ownedIno;
      let rewrittenIno;
      const hook = hookOwnedCreate((filePath) => filePath === secondOutput, {
        before: () => {
          ownedIno = fs.statSync(firstOutput, { bigint: true }).ino;
          // Same inode (still the owned descriptor-created output), different bytes.
          rewriteInPlace(firstOutput, Buffer.from('rewritten in place'));
          rewrittenIno = fs.statSync(firstOutput, { bigint: true }).ino;
        },
        times: 1,
      });
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');

      try {
        await expect(processingService.watermarkAssets(project.id, [first.id, second.id], options))
          .rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        expect(applySpy).not.toHaveBeenCalled();
      } finally {
        applySpy.mockRestore();
        hook.restore();
      }

      expect(rewrittenIno).toBe(ownedIno);
      expect(fs.existsSync(firstOutput)).toBe(false);
      expect(fs.existsSync(secondOutput)).toBe(false);
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/changed-first_wm.png')).toBeUndefined();
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('never lets a legacy zero-birth-time provenance authorize replacement', async () => {
      const source = await writeIndexedImage('Final/zero-birth-row.png');
      const first = await processingService.watermarkAssets(project.id, [source.id], options);
      const assetId = first.generatedAssetIds[0];
      const output = path.resolve(projectDir, 'wm', 'zero-birth-row_wm.png');
      const current = fs.lstatSync(output, { bigint: true });
      const legacy = `v1:${current.dev}:${current.ino}:0`;
      db.prepare('UPDATE assets SET generated_output_provenance = ? WHERE id = ?').run(legacy, assetId);
      const row = assetRepository.findById(assetId);
      const ids = mockFileIdentities();
      // The current object matches the row's exact dev/ino, zero birth time and hash.
      ids.assign(output, { birthtimeNs: 0n });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks');
      try {
        const observed = fs.lstatSync(output, { bigint: true });
        expect(`v1:${observed.dev}:${observed.ino}:${observed.birthtimeNs}`).toBe(legacy);
        expect(sha256For(output)).toBe(row.generated_output_sha256);
        await expect(processingService.watermarkAssets(project.id, [source.id], {
          ...options, overwrite: true,
        })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        expect(applySpy).not.toHaveBeenCalled();
        expect(unlinkSpy).not.toHaveBeenCalled();
      } finally {
        applySpy.mockRestore();
        unlinkSpy.mockRestore();
        ids.restore();
      }

      expect(fs.lstatSync(output, { bigint: true }).ino).toBe(current.ino);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(legacy);
      expect(assetRepository.findById(assetId)).toEqual(row);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    // Publishes on a modeled filesystem, then shows the later replacement is refused.
    async function expectVerifiedPublicationWithoutProvenance(name, birthtimeNs, service = processingService) {
      const source = await writeIndexedImage(`Final/${name}.png`);
      const output = path.resolve(projectDir, 'wm', `${name}_wm.png`);
      const ids = mockFileIdentities();
      ids.autoAssign(isPublicOutput(output), { birthtimeNs });
      try {
        const first = await service.watermarkAssets(project.id, [source.id], options);
        const assetId = first.generatedAssetIds[0];
        const row = assetRepository.findById(assetId);
        expect(row.generated_output_sha256).toBe(sha256For(output));
        expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBeNull();
        expect(watermarkWorkspaces()).toEqual([]);

        const ino = fs.lstatSync(output, { bigint: true }).ino;
        await expect(service.watermarkAssets(project.id, [source.id], {
          ...options, overwrite: true,
        })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
        expect(fs.lstatSync(output, { bigint: true }).ino).toBe(ino);
        expect(assetRepository.findById(assetId)).toEqual(row);
      } finally {
        ids.restore();
      }
      expect(watermarkWorkspaces()).toEqual([]);
    }

    it('publishes on a zero-birth-time filesystem without durable provenance', async () => {
      await expectVerifiedPublicationWithoutProvenance('zero-birth-fs', 0n);
    });

    it('persists no provenance where birth time may mirror an unchanged ctime', async () => {
      const linuxService = createConfiguredService(watermarkPath, tmpDir, undefined, { platform: 'linux' });
      await expectVerifiedPublicationWithoutProvenance('ctime-mirror', (stats) => stats.ctimeNs, linuxService);
    });

    it('persists a stable birth time distinct from ctime where birth time may mirror ctime', async () => {
      const linuxService = createConfiguredService(watermarkPath, tmpDir, undefined, { platform: 'linux' });
      const source = await writeIndexedImage('Final/linux-stable.png');
      const output = path.resolve(projectDir, 'wm', 'linux-stable_wm.png');
      const tuple = { dev: 9007199254740995n, ino: 9007199254740999n, birthtimeNs: 1000000001n };
      const ids = mockFileIdentities();
      ids.autoAssign(isPublicOutput(output), tuple);
      try {
        const first = await linuxService.watermarkAssets(project.id, [source.id], options);
        expect(assetRepository.findGeneratedOutputProvenance(project.id, first.generatedAssetIds[0]))
          .toBe(provenanceOf(tuple));
        await linuxService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
        expect(fs.existsSync(output)).toBe(true);
      } finally {
        ids.restore();
      }
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('persists the public output tuple exactly, past 2^53, never the stage, and replaces that object later', async () => {
      const source = await writeIndexedImage('Final/large-tuple.png');
      const output = path.resolve(projectDir, 'wm', 'large-tuple_wm.png');
      // Exact values beyond Number.MAX_SAFE_INTEGER; their Number views round.
      const bigTuple = { dev: 9007199254740995n, ino: 9007199254740997n, birthtimeNs: 1700000000123456789n };
      expect(Number(bigTuple.ino)).toBe(Number(bigTuple.ino - 1n));
      const ids = mockFileIdentities();
      // The stage is a distinct object whose (also exact) identity must never become provenance.
      ids.autoAssign(isWatermarkStage, { dev: 9007199254740995n, ino: 9007199254740999n, birthtimeNs: 1700000000000000999n });
      ids.autoAssign(isPublicOutput(output), bigTuple);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      try {
        const first = await processingService.watermarkAssets(project.id, [source.id], options);
        const assetId = first.generatedAssetIds[0];
        expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId)).toBe(provenanceOf(bigTuple));

        // The unchanged owned object is backed up, unlinked and replaced under the full tuple.
        unlinkSpy.mockClear();
        await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
        expect(unlinkSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))).toContain(output);
        const current = fs.lstatSync(output, { bigint: true });
        expect(assetRepository.findGeneratedOutputProvenance(project.id, assetId))
          .toBe(provenanceOf(current));
      } finally {
        unlinkSpy.mockRestore();
        ids.restore();
      }
      expect(watermarkWorkspaces()).toEqual([]);
    });

    it('replaces an owned destination and removes its exact backup on a normal filesystem', async () => {
      const source = await writeIndexedImage('Final/exact-destination-backup.png');
      await processingService.watermarkAssets(project.id, [source.id], options);
      const output = path.join(projectDir, 'wm', 'exact-destination-backup_wm.png');
      const realUnlink = fs.unlinkSync.bind(fs);
      let backupRemoved = false;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
        if (String(filePath).includes('.creatorcrate-watermark-') && String(filePath).endsWith('.destination')) {
          backupRemoved = true;
        }
        return realUnlink(filePath, ...args);
      });
      try {
        await processingService.watermarkAssets(project.id, [source.id], { ...options, overwrite: true });
      } finally {
        unlinkSpy.mockRestore();
      }

      expect(backupRemoved).toBe(true);
      expect(fs.existsSync(output)).toBe(true);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    // Old: zero destination IDs kept Number continuity (0 === 0), so a same-bytes replacement
    // was backed up and unlinked, and the backup holding it was deleted on success.
    it('never replaces a zero-ID destination that was swapped during processing', async () => {
      const source = await writeIndexedImage('Final/zero-id-destination.png');
      await processingService.watermarkAssets(project.id, [source.id], options);
      const output = path.resolve(projectDir, 'wm', 'zero-id-destination_wm.png');
      const before = fs.readFileSync(output);
      const realMkdir = fs.mkdirSync.bind(fs);
      let foreignIno;
      let restoreStats = () => {};
      // After the provenance-proven preflight, the destination is swapped and reports zero IDs.
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, ...args) => {
        if (!foreignIno && String(dirPath).includes('.creatorcrate-watermark-')) {
          foreignIno = replaceWithSameBytes(output);
          restoreStats = mockStatOverrides((filePath) => (filePath === output ? { ino: 0 } : null));
        }
        return realMkdir(dirPath, ...args);
      });

      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], {
          ...options, overwrite: true,
        })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
      } finally {
        restoreStats();
        mkdirSpy.mockRestore();
      }

      expect(fs.statSync(output, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.readFileSync(output)).toEqual(before);
      expect(watermarkWorkspaces()).toEqual([]);
    });

    // Old: the delete-source path accepted zero-ID Number continuity and unlinked the swapped
    // source; the staged copy of it was then removed after the index update.
    it('never deletes a zero-ID source that was swapped during processing', async () => {
      const source = await writeIndexedImage('Final/zero-id-delete-source.png');
      const sourcePath = path.resolve(projectDir, 'Final', 'zero-id-delete-source.png');
      const output = path.join(projectDir, 'wm', 'zero-id-delete-source_wm.png');
      const realMkdir = fs.mkdirSync.bind(fs);
      let foreignIno;
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, ...args) => {
        if (!foreignIno && String(dirPath).includes('.creatorcrate-watermark-')) foreignIno = replaceWithSameBytes(sourcePath);
        return realMkdir(dirPath, ...args);
      });
      const restoreStats = mockStatOverrides((filePath) => (filePath === sourcePath ? { ino: 0 } : null));

      try {
        await expect(processingService.watermarkAssets(project.id, [source.id], {
          ...options, deleteSource: true,
        })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      } finally {
        restoreStats();
        mkdirSpy.mockRestore();
      }

      expect(fs.statSync(sourcePath, { bigint: true }).ino).toBe(foreignIno);
      expect(fs.existsSync(output)).toBe(false);
      expect(assetRepository.findById(source.id)).toBeTruthy();
      expect(watermarkWorkspaces()).toEqual([]);
    });

    // Old: stage cleanup fell back to Number equality when the captured exact stage ID was
    // zero, so a replacement stage that also reported zero IDs was unlinked.
    // D2: Old: the stage's owned identity was captured by statting the pathname after the
    // write closed, so a file substituted at that boundary became the owned stage and could be
    // published, persisted as provenance and later unlinked.
    it('never claims, publishes or removes a foreign file that replaced the stage after its descriptor closed', async () => {
      const source = await writeIndexedImage('Final/stage-replaced.png');
      const output = path.resolve(projectDir, 'wm', 'stage-replaced_wm.png');
      const foreign = Buffer.from('foreign replacement of the watermark stage');
      const race = replaceStageAfterClose(
        (filePath) => filePath.includes('.creatorcrate-watermark-') && filePath.endsWith('0.output'),
        (stagePath) => replaceWithForeignFile(stagePath, foreign),
      );
      const linkSpy = vi.spyOn(fs, 'linkSync');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], options)
          .then(() => null, (err) => err);
        expect(race.path).toBeDefined();
        expect(linkSpy.mock.calls.filter(([fromPath]) => path.resolve(fromPath) === race.path)).toEqual([]);
        expect(unlinkSpy.mock.calls.filter(([filePath]) => path.resolve(filePath) === race.path)).toEqual([]);
      } finally {
        unlinkSpy.mockRestore();
        linkSpy.mockRestore();
        race.restore();
      }

      // The foreign file stays in the private workspace, so cleanup cannot complete; no project
      // path changed, so that is residue under an ordinary failure, never RECOVERY_REQUIRED.
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(failure.recoveryDiagnostics.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'stage-output', check: 'cleanup-identity-mismatch', cleanup: 'residue',
      }));
      expect(fs.readFileSync(race.path)).toEqual(foreign);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'Final', 'stage-replaced.png'))).toBe(true);
      fs.rmSync(path.dirname(race.path), { recursive: true, force: true });
    });

    // D2: stage ownership is rooted in the exclusive descriptor. A descriptor reporting a
    // zero (unknown) ID never becomes an owned stage, so nothing is published from it and
    // the file at its path is never unlinked (a later replacement could not be told apart).
    it('never claims, publishes or removes a stage whose descriptor reports a zero ID', async () => {
      const source = await writeIndexedImage('Final/zero-id-stage.png');
      const output = path.resolve(projectDir, 'wm', 'zero-id-stage_wm.png');
      const isStage = (filePath) => filePath.includes('.creatorcrate-watermark-') && filePath.endsWith('0.output');
      const linkSpy = vi.spyOn(fs, 'linkSync');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const restoreStats = mockStatOverrides((filePath) => (isStage(filePath) ? { ino: 0 } : null));

      let failure;
      try {
        failure = await processingService.watermarkAssets(project.id, [source.id], options)
          .then(() => null, (err) => err);
        expect(linkSpy.mock.calls.filter(([fromPath]) => isStage(path.resolve(fromPath)))).toEqual([]);
        expect(unlinkSpy.mock.calls.filter(([filePath]) => isStage(path.resolve(filePath)))).toEqual([]);
      } finally {
        restoreStats();
        unlinkSpy.mockRestore();
        linkSpy.mockRestore();
      }

      // The stage was never owned, so CreatorCrate never wrote or published it and no project
      // file changed: it stays untouched as safe private residue and the ordinary staging
      // failure stands instead of RECOVERY_REQUIRED.
      expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
      expect(fs.existsSync(path.join(projectDir, 'Final', 'zero-id-stage.png'))).toBe(true);
      expect(fs.existsSync(output)).toBe(false);
      const workspaces = stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
      expect(workspaces).toHaveLength(1);
      expect(fs.existsSync(stageArtifact(path.join(projectDir, workspaces[0]), '0.output'))).toBe(true);
      fs.rmSync(path.join(projectDir, workspaces[0]), { recursive: true, force: true });
    });
  });

  it('uses strict identity verification on a normal filesystem', async () => {
    const source = await writeIndexedImage('Final/strict-identity.png');
    const output = path.join(projectDir, 'wm', 'strict-identity_wm.png');
    const realUnlink = fs.unlinkSync.bind(fs);
    let stageOutputRemoved = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
      if (typeof filePath === 'string' && filePath.includes('.creatorcrate-watermark-')
        && filePath.endsWith('0.output')) {
        stageOutputRemoved = true;
      }
      return realUnlink(filePath, ...args);
    });

    try {
      await processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
      });
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(stageOutputRemoved).toBe(true);
    expect(fs.existsSync(output)).toBe(true);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);
  });

  // Each owned output is rolled back by its own descriptor identity (never the stage's).
  it('removes an earlier owned output when a later publication fails', async () => {
    const first = await writeIndexedImage('Final/cifs-rollback-first.png');
    const second = await writeIndexedImage('Final/cifs-rollback-second.png');
    const firstOutput = path.join(projectDir, 'wm', 'cifs-rollback-first_wm.png');
    const secondOutput = path.join(projectDir, 'wm', 'cifs-rollback-second_wm.png');
    const hook = hookOwnedCreate((filePath) => filePath === path.resolve(secondOutput), {
      before: () => { throw Object.assign(new Error('injected later publication failure'), { code: 'EIO' }); },
    });

    let failure;
    try {
      failure = await processingService.watermarkAssets(project.id, [first.id, second.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
      }).catch((err) => err);
    } finally {
      hook.restore();
    }

    expect(failure).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED' });
    expect(fs.existsSync(firstOutput)).toBe(false);
    expect(fs.existsSync(secondOutput)).toBe(false);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);
  });

  it('does not remove a foreign replacement of an owned output when a later publication fails', async () => {
    const first = await writeIndexedImage('Final/cifs-replacement-first.png');
    const second = await writeIndexedImage('Final/cifs-replacement-second.png');
    const firstOutput = path.join(projectDir, 'wm', 'cifs-replacement-first_wm.png');
    const secondOutput = path.join(projectDir, 'wm', 'cifs-replacement-second_wm.png');
    const unexpectedReplacement = Buffer.from('unexpected replacement after publication');
    const hook = hookOwnedCreate((filePath) => filePath === path.resolve(secondOutput), {
      before: () => {
        fs.rmSync(firstOutput);
        fs.writeFileSync(firstOutput, unexpectedReplacement);
        throw Object.assign(new Error('injected later publication failure'), { code: 'EIO' });
      },
    });

    try {
      await expect(processingService.watermarkAssets(project.id, [first.id, second.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
      })).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: 'Watermarking changed the filesystem but could not safely complete or clean up. Inspect the project folder before scanning.',
      });
    } finally {
      hook.restore();
    }

    expect(fs.readFileSync(firstOutput)).toEqual(unexpectedReplacement);
    // Only the replaced first output's stage is kept as recovery evidence.
    const [workspace, ...others] = stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
    expect(others).toEqual([]);
    expect(stageNames(path.join(projectDir, workspace))).toEqual(['0.output']);
  });

  it('preserves an overwrite backup when an unexpected replacement prevents restoration', async () => {
    const source = await writeIndexedImage('Final/failed-restore-backup.png');
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });

    const output = path.join(projectDir, 'wm', 'failed-restore-backup_wm.png');
    const previousOutput = fs.readFileSync(output);
    const previousIdentity = exactIdOf(output);
    const unexpectedReplacement = Buffer.from('unexpected replacement after watermark publication');
    // Right after the new output's descriptor closes, a foreign file takes its path.
    const hook = hookOwnedCreate((filePath) => filePath === path.resolve(output), {
      after: (filePath) => {
        fs.rmSync(filePath);
        fs.writeFileSync(filePath, unexpectedReplacement);
      },
      times: 1,
    });

    try {
      await expect(processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
        overwrite: true,
      })).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: 'Watermarking changed the filesystem but could not safely complete or clean up. Inspect the project folder before scanning.',
      });
      expect(hook.calls).toBe(1);
    } finally {
      hook.restore();
    }

    expect(fs.readFileSync(output)).toEqual(unexpectedReplacement);
    const stagingDirs = stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
    expect(stagingDirs).toHaveLength(1);
    const backup = stageArtifact(path.join(projectDir, stagingDirs[0]), '0.destination');
    expect(fs.readFileSync(backup)).toEqual(previousOutput);
    // The backup is its own owned copy, never an alias of the replaced destination.
    expect(exactIdOf(backup)).not.toEqual(previousIdentity);
  });

  describe('unresolved output rollback retains the Watermark stage', () => {
    async function rollBackOwnedOverwrite(name, injectRollbackFault) {
      const logger = { warn: vi.fn(), error: vi.fn() };
      processingService = createConfiguredService(watermarkPath, tmpDir, coordinator, {
        applicationLogger: logger,
      });
      const source = await writeIndexedImage(`Final/${name}.png`);
      await processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
      });
      const output = path.join(projectDir, 'wm', `${name}_wm.png`);
      const previousOutput = fs.readFileSync(output);
      const previousStats = fs.lstatSync(output, { bigint: true });
      const previousIdentity = { dev: previousStats.dev, ino: previousStats.ino };

      // The index commit fails only after the owned output was published and proven.
      let rollingBack = false;
      const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks').mockImplementation(() => {
        rollingBack = true;
        throw new Error('injected overwrite database failure');
      });
      const faultSpy = injectRollbackFault(output, () => rollingBack);
      let publishedOutput;
      let failure;
      try {
        await processingService.watermarkAssets(project.id, [source.id], {
          mode: 'patreon',
          outputFormat: 'png',
          deleteSource: false,
          overwrite: true,
        });
      } catch (err) {
        failure = err;
      } finally {
        publishedOutput = fs.existsSync(output) ? fs.readFileSync(output) : null;
        faultSpy?.mockRestore();
        applySpy.mockRestore();
      }
      const stagingDirs = stagingWorkspaces(projectDir, '.creatorcrate-watermark-');
      const assetId = assetRepository.findByProjectIdAndPath(project.id, `wm/${name}_wm.png`).id;
      return { failure, output, previousOutput, previousIdentity, publishedOutput, stagingDirs, logger, assetId };
    }

    function failOutputCall(method, code) {
      return (output, rollingBack) => {
        const real = fs[method].bind(fs);
        return vi.spyOn(fs, method).mockImplementation((filePath, ...args) => {
          if (rollingBack() && filePath === output) {
            throw Object.assign(new Error(`injected ${method} ${code}`), { code });
          }
          return real(filePath, ...args);
        });
      };
    }

    function expectRetainedEvidence(result) {
      expect(result.failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      // The unremovable published output stays, and so does the stage that anchors it.
      expect(fs.readFileSync(result.output)).toEqual(result.publishedOutput);
      expect(result.stagingDirs).toHaveLength(1);
      const stagingDir = path.join(projectDir, result.stagingDirs[0]);
      const stage = stageArtifact(stagingDir, '0.output');
      expect(fs.readFileSync(stage)).toEqual(result.publishedOutput);
      // Stage, published output and backup are three distinct owned objects (no aliases).
      expect(exactIdOf(stage)).not.toEqual(exactIdOf(result.output));
      expect(exactIdOf(result.output)).not.toEqual(result.previousIdentity);
      // The overwritten destination's backup remains as recovery evidence.
      const backup = stageArtifact(stagingDir, '0.destination');
      expect(fs.readFileSync(backup)).toEqual(result.previousOutput);
      expect(exactIdOf(backup)).not.toEqual(result.previousIdentity);

      expect(result.logger.warn).not.toHaveBeenCalled();
      expect(result.logger.error).toHaveBeenCalledTimes(1);
      const event = result.logger.error.mock.calls[0][0];
      expect(event).toMatchObject({
        event: 'processing.recovery.failed',
        context: { operation: 'watermark', phase: 'recovery' },
      });
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(projectDir);
      expect(serialized).not.toContain('_wm.png');
    }

    it('keeps the stage when the owned published output cannot be unlinked', async () => {
      const result = await rollBackOwnedOverwrite('rollback-unlink-eacces', failOutputCall('unlinkSync', 'EACCES'));
      expectRetainedEvidence(result);
    });

    it('keeps the stage when the published output cannot be inspected', async () => {
      const result = await rollBackOwnedOverwrite('rollback-lstat-eio', failOutputCall('lstatSync', 'EIO'));
      expectRetainedEvidence(result);
    });

    it('reports an unremovable backup as residue after a verified restore', async () => {
      let backupUnlinks = 0;
      const result = await rollBackOwnedOverwrite('backup-removal-eio', (output, rollingBack) => {
        const realUnlink = fs.unlinkSync.bind(fs);
        return vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          if (rollingBack() && String(filePath).includes('.creatorcrate-watermark-')
            && path.basename(String(filePath)).includes('destination')) {
            backupUnlinks += 1;
            throw Object.assign(new Error('injected backup unlinkSync EIO'), { code: 'EIO' });
          }
          return realUnlink(filePath, ...args);
        });
      });
      // Ownership was proven and the unlink was actually attempted.
      expect(backupUnlinks).toBeGreaterThan(0);
      // The destination was restored and its provenance reconciled: project and index are
      // safe, so the leftover private backup is residue on an ordinary failure.
      expect(result.failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(fs.readFileSync(result.output)).toEqual(result.previousOutput);
      expect(result.logger.error).not.toHaveBeenCalled();
      const [{ event, context }] = result.logger.warn.mock.calls[0];
      expect(event).toBe('processing.recovery.succeeded');
      expect(context).toMatchObject({ restored: true, cleanupSucceeded: false });
      expect(context.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'destination-backup',
        check: 'cleanup-unlink-failed',
        errorCode: 'EIO',
        cleanup: 'residue',
      }));
      fs.rmSync(path.join(projectDir, result.stagingDirs[0]), { recursive: true, force: true });
    });

    it('logs the filesystem code when the destination cannot be recreated from its backup', async () => {
      const result = await rollBackOwnedOverwrite('backup-restore-eio', failOutputCall('openSync', 'EIO'));
      expect(result.failure).toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(result.publishedOutput).toBeNull();
      const [{ context }] = result.logger.error.mock.calls[0];
      expect(context.failures).toContainEqual(expect.objectContaining({
        artifactRole: 'restored-destination',
        check: 'restore-create-failed',
        errorCode: 'EIO',
      }));
      const backup = stageArtifact(path.join(projectDir, result.stagingDirs[0]), '0.destination');
      expect(fs.readFileSync(backup)).toEqual(result.previousOutput);
    });

    it('treats an owned output that vanishes before its rollback unlink as removed', async () => {
      let destinationAssetId;
      let racedUnlinks = 0;
      const result = await rollBackOwnedOverwrite('rollback-unlink-enoent', (output, rollingBack) => {
        destinationAssetId = assetRepository.findByProjectIdAndPath(
          project.id,
          'wm/rollback-unlink-enoent_wm.png',
        ).id;
        const realUnlink = fs.unlinkSync.bind(fs);
        return vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath, ...args) => {
          if (rollingBack() && filePath === output && racedUnlinks === 0) {
            // The proven output disappears in the race window before this unlink runs.
            racedUnlinks += 1;
            realUnlink(filePath, ...args);
            throw Object.assign(new Error('injected unlinkSync ENOENT'), { code: 'ENOENT' });
          }
          return realUnlink(filePath, ...args);
        });
      });
      expect(racedUnlinks).toBe(1);
      expect(result.failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      // The prior bytes return as a new owned file whose own tuple the index now records.
      expect(exactIdOf(result.output)).not.toEqual(result.previousIdentity);
      expect(fs.readFileSync(result.output)).toEqual(result.previousOutput);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, result.assetId)).toBe(provenanceTupleOf(result.output));
      expect(result.stagingDirs).toHaveLength(0);
      expect(result.logger.error).not.toHaveBeenCalled();
      expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/rollback-unlink-enoent_wm.png').id)
        .toBe(destinationAssetId);
    });

    it('still removes the stage after a successful owned-output rollback', async () => {
      const result = await rollBackOwnedOverwrite('rollback-clean', () => null);
      expect(result.failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      // The prior bytes return as a new owned file whose own tuple the index now records.
      expect(exactIdOf(result.output)).not.toEqual(result.previousIdentity);
      expect(fs.readFileSync(result.output)).toEqual(result.previousOutput);
      expect(assetRepository.findGeneratedOutputProvenance(project.id, result.assetId)).toBe(provenanceTupleOf(result.output));
      expect(result.stagingDirs).toHaveLength(0);
      expect(result.logger.error).not.toHaveBeenCalled();
    });
  });

  it('restores an existing generated destination when overwrite indexing fails', async () => {
    const source = await writeIndexedImage('Final/overwrite-failure.png');
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
    });
    const destination = path.join(projectDir, 'wm', 'overwrite-failure_wm.png');
    const before = fs.readFileSync(destination);
    const beforeStats = fs.statSync(destination);
    const beforeId = exactIdOf(destination);
    const destinationAsset = assetRepository.findByProjectIdAndPath(
      project.id,
      'wm/overwrite-failure_wm.png',
    );
    const oldProvenance = assetRepository.findGeneratedOutputProvenance(project.id, destinationAsset.id);
    expect(oldProvenance).toBe(provenanceTupleOf(destination));
    let publishedProvenance;
    const applySpy = vi.spyOn(assetRepository, 'applyAssetWatermarks')
      .mockImplementation(() => {
        publishedProvenance = provenanceTupleOf(destination);
        throw new Error('injected overwrite database failure');
      });
    const linkSpy = vi.spyOn(fs, 'linkSync');

    try {
      const failure = await processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
        overwrite: true,
      }).catch((err) => err);
      expect(failure).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(linkSpy).not.toHaveBeenCalled();
    } finally {
      linkSpy.mockRestore();
      applySpy.mockRestore();
    }

    // The prior bytes, mode and indexed mtime return as a new file with a new identity...
    expect(fs.readFileSync(destination)).toEqual(before);
    expect(exactIdOf(destination)).not.toEqual(beforeId);
    expect(fs.statSync(destination).mtime.toISOString()).toBe(beforeStats.mtime.toISOString());
    // ...and the index describes that restored object, never the stale tuple or the new output.
    const reconciled = assetRepository.findGeneratedOutputProvenance(project.id, destinationAsset.id);
    expect(reconciled).toBe(provenanceTupleOf(destination));
    expect(reconciled).not.toBe(oldProvenance);
    expect(reconciled).not.toBe(publishedProvenance);
    expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/overwrite-failure_wm.png'))
      .toEqual(destinationAsset);
    expect(stagingWorkspaces(projectDir, '.creatorcrate-watermark-')).toEqual([]);

    // The reconciled provenance authorizes the next replacement of CreatorCrate's own output.
    await processingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon', outputFormat: 'png', deleteSource: false, overwrite: true,
    });
    expect(assetRepository.findGeneratedOutputProvenance(project.id, destinationAsset.id))
      .toBe(provenanceTupleOf(destination));
  });

  it('queues watermarking behind an active same-project operation without overlapping execution', async () => {
    const source = await writeIndexedImage('Final/locked.png');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const holder = coordinator.runAsync(project.id, () => gate);
    const queued = processingService.watermarkAssets(project.id, [source.id], {
        mode: 'patreon',
        outputFormat: 'png',
        deleteSource: false,
      });
    let settled = false;
    void queued.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(coordinator.isActive(project.id)).toBe(true);
    release();
    await holder;
    await expect(queued).resolves.toMatchObject({ status: 'completed' });
    expect(coordinator.isActive(project.id)).toBe(false);
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
    expect(fs.existsSync(path.join(projectDir, 'wm', 'nested-trusted_wm.png')))
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
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
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

  it('uses global Watermark IDs for planning, cross-project apply, and archive provenance', async () => {
    const globalService = createWatermarkService({
      repository: watermarkRepository,
      projectsRoot,
    });
    const globalPath = path.join(projectsRoot, 'watermarks', 'branding.png');
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, await makeWatermark());
    await globalService.scanWatermarks();
    const global = globalService.listWatermarks().find((candidate) => candidate.relativePath === 'branding.png');
    expect(global).toBeDefined();

    const source = await writeIndexedImage('Final/global.png');
    const otherProject = projectService.create(projectInput('Other Global Project'));
    const otherProjectDir = resolveProjectDir(projectsRoot, otherProject.project_dir);
    const otherFinalCategory = assetCategoryService.listProjectCategories(otherProject.id)
      .find((category) => category.directory_slug === 'final');
    const otherPath = path.join(otherProjectDir, 'Final', 'global.png');
    const otherBytes = await makeImage();
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    fs.writeFileSync(otherPath, otherBytes);
    const otherStats = fs.statSync(otherPath);
    const otherSource = assetRepository.upsert(otherProject.id, 'Final/global.png', {
      categoryId: otherFinalCategory.id,
      nestedPath: '',
      filename: 'global.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: otherStats.size,
      modifiedAt: otherStats.mtime.toISOString(),
    });

    const globalProcessingService = createAssetProcessingService({
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      watermarkService: globalService,
    });
    const planner = createAssetProcessingPlanner({
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      scopeService: createAssetProcessingScopeService({ projectRepository, assetRepository }),
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      watermarkService: globalService,
    });
    const plan = await planner.planWatermark(project.id, {
      type: 'selected',
      assetIds: [source.id],
    }, {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: global.id,
    });

    expect(plan.options.watermarkId).toBe(global.id);
    expect(plan.watermark).toMatchObject({
      id: global.id,
      relativePath: 'branding.png',
    });
    expect(plan.watermark).not.toHaveProperty('filePath');
    expect(plan.items[0].status).toBe('ready');

    await globalProcessingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: global.id,
    });
    await globalProcessingService.watermarkAssets(otherProject.id, [otherSource.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: global.id,
    });

    expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/global_wm.png')).toMatchObject({
      generated_watermark_id: global.id,
    });
    expect(assetRepository.findByProjectIdAndPath(otherProject.id, 'wm/global_wm.png')).toMatchObject({
      generated_watermark_id: global.id,
    });

    const archiveSource = await writeIndexedImage('Final/global-archive.png');
    await globalProcessingService.watermarkAssets(project.id, [archiveSource.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      makeArchives: true,
      watermarkId: global.id,
    });
    const artifacts = generatedArtifactRepository.listByProjectId(project.id);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every((artifact) => artifact.generated_watermark_id === global.id)).toBe(true);
  });

  it('re-resolves the global source during apply and rejects stale or missing source bytes', async () => {
    const globalService = createWatermarkService({
      repository: watermarkRepository,
      projectsRoot,
    });
    const globalPath = path.join(projectsRoot, 'watermarks', 'stale.png');
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, await makeWatermark());
    await globalService.scanWatermarks();
    const global = globalService.listWatermarks().find((candidate) => candidate.relativePath === 'stale.png');
    const source = await writeIndexedImage('Final/stale-source.png');
    const globalProcessingService = createAssetProcessingService({
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      watermarkService: globalService,
    });
    const planner = createAssetProcessingPlanner({
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      scopeService: createAssetProcessingScopeService({ projectRepository, assetRepository }),
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      watermarkService: globalService,
    });

    const plan = await planner.planWatermark(project.id, {
      type: 'selected',
      assetIds: [source.id],
    }, {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: global.id,
    });
    expect(plan.items[0].status).toBe('ready');

    fs.writeFileSync(globalPath, await makeImage({ width: 21, height: 16 }));
    await expect(globalProcessingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: global.id,
    })).rejects.toMatchObject({ code: 'WATERMARK_RESOURCE_TAMPERED' });
    expect(assetRepository.findByProjectIdAndPath(project.id, 'wm/stale-source_wm.png')).toBeUndefined();

    fs.unlinkSync(globalPath);
    await globalService.scanWatermarks();
    const missingSource = await writeIndexedImage('Final/missing-global-source.png');
    await expect(globalProcessingService.watermarkAssets(project.id, [missingSource.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: global.id,
    })).rejects.toMatchObject({ code: 'WATERMARK_NOT_FOUND' });
  });

  it('does not treat historical project-local provenance as global ownership', async () => {
    const globalService = createWatermarkService({
      repository: watermarkRepository,
      projectsRoot,
    });
    const globalPath = path.join(projectsRoot, 'watermarks', 'ownership.png');
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, await makeWatermark());
    await globalService.scanWatermarks();
    const global = globalService.listWatermarks().find((candidate) => candidate.relativePath === 'ownership.png');
    const source = await writeIndexedImage('Final/ownership.png');
    const globalProcessingService = createAssetProcessingService({
      ...processingRecoveryEvidenceDependencies(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectRepository,
      assetRepository,
      assetCategoryService,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      watermarkService: globalService,
    });

    await globalProcessingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: global.id,
    });
    const output = assetRepository.findByProjectIdAndPath(project.id, 'wm/ownership_wm.png');
    db.prepare('UPDATE assets SET generated_watermark_id = NULL WHERE id = ?').run(output.id);
    await expect(globalProcessingService.watermarkAssets(project.id, [source.id], {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      overwrite: true,
      watermarkId: global.id,
    })).rejects.toMatchObject({ code: 'OUTPUT_DESTINATION_CONFLICT' });
  });
});
