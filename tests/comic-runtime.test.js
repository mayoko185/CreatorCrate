// A3.3c-1 — application ownership of the comic admission and preparation cache.
// Real application context and app graphs, database, preview-service authority, comic media
// service, A1 decoder workers, A3.2b preparation and the reviewed automatic cache location
// (os.tmpdir(), private by creation). Only the service constructor is wrapped, to observe
// which shared instances each graph's service receives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';

// Every recover() on Windows reads the cache path's ACLs through Windows PowerShell.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 });

const built = vi.hoisted(() => ({ services: [] }));

vi.mock('../src/services/comic-media-service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createComicMediaService: (deps) => {
      const service = actual.createComicMediaService(deps);
      built.services.push({ service, deps });
      return service;
    },
  };
});

const { openDatabase, runMigrations, closeDatabase } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { createApplicationContext } = await import('../src/app-context.js');
const { createShutdownHandler } = await import('../src/server.js');
const { createProjectRepository } = await import('../src/data/project-repository.js');
const { createAssetRepository } = await import('../src/data/asset-repository.js');
const { formatProjectDirName } = await import('../src/storage/project-storage.js');
const {
  ComicPreparationCacheError, createComicPreparationCache, defaultComicPreparationCacheRoot,
} = await import('../src/services/comic-preparation-cache.js');
const { createComicRuntime, reportComicRuntimeClose, reportComicRuntimeStart } = await import('../src/services/comic-runtime.js');

const FAKE_RENDITION_CHILD = fileURLToPath(new URL('./helpers/fake-rendition-child.js', import.meta.url));

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const APP_NAME = 'CreatorCrate';

let h;

function makeHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-comic-runtime-'));
  const appDataRoot = path.join(tmpDir, 'app');
  const projectsRoot = path.join(tmpDir, 'projects');
  const previewRoot = path.join(appDataRoot, 'previews');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(previewRoot, { recursive: true });
  const databasePath = path.join(appDataRoot, 'creatorcrate.db');
  const db = openDatabase(databasePath);
  runMigrations(db, MIGRATIONS_DIR);
  const runtimes = [];
  const contexts = [];
  const extraDbs = [];

  function runtime(options = {}) {
    const created = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 }, ...options });
    runtimes.push(created);
    return created;
  }

  function context(comicRuntime) {
    const created = createApplicationContext({
      appName: APP_NAME, projectsRoot, previewRoot,
      appOpts: {
        appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR, maintenanceState: { active: false },
        ...(comicRuntime ? { comicRuntime } : {}),
      },
    }, db);
    contexts.push(created);
    return created;
  }

  function freshDatabase() {
    const other = openDatabase(path.join(tmpDir, `replacement-${extraDbs.length}.db`));
    runMigrations(other, MIGRATIONS_DIR);
    extraDbs.push(other);
    return other;
  }

  let projects = 0;
  function addComic(name = 'comic-rar5-solid.cbr', connection = db) {
    projects += 1;
    const title = 'Comic ' + projects;
    const projectRepo = createProjectRepository(connection);
    let project = projectRepo.create({
      title, projectType: 'images', slug: slugify(title, { lowercase: true }), description: '', notes: '',
      status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
    });
    const relDir = formatProjectDirName(project.id, project.slug);
    const absPath = path.resolve(projectsRoot, relDir);
    fs.mkdirSync(absPath, { recursive: true });
    project = projectRepo.setProjectDir(project.id, relDir);
    bindTestProjectOwnership(connection, project.id, absPath);
    const full = path.join(absPath, 'book.cbr');
    fs.copyFileSync(path.join(COMICS, name), full);
    const stat = fs.statSync(full);
    const asset = createAssetRepository(connection).upsert(project.id, 'book.cbr', {
      filename: 'book.cbr', extension: 'cbr', mimeType: 'application/vnd.comicbook-rar',
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
    });
    return [project.id, asset.id];
  }

  return {
    tmpDir, appDataRoot, projectsRoot, db, runtime, context, freshDatabase, addComic,
    async cleanup() {
      for (const ctx of contexts) {
        for (const owner of [ctx.generatedImageRebuildService, ctx.generatedImagePublicationLifecycle,
          ctx.projectOwnershipAdoption, ctx.legacyManifestCleanup]) owner?.stop();
        ctx.releaseNotificationRuntime?.stop();
        await ctx.generatedImageRebuildService?.waitForIdle();
        await ctx.generatedImagePublicationLifecycle?.waitForIdle();
        await ctx.projectOwnershipAdoption?.waitForIdle();
        await ctx.legacyManifestCleanup?.waitForIdle();
        await ctx.releaseNotificationRuntime?.waitForIdle();
      }
      for (const created of runtimes) await created.close();
      for (const connection of [db, ...extraDbs]) if (connection.open) closeDatabase(connection);
      // The automatic root of this disposable installation (empty once its runtime closed).
      fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// A preparation job that holds the background lane until cancelled.
function heldPreparation(admission, started) {
  return ({ signal }) => admission.run(() => new Promise((_, reject) => {
    started?.();
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }), { lane: 'background', signal, weightBytes: 1024 });
}

// A 1x1 PNG (the stand-in child never decodes it).
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function withTemporaryDirectory(directory, fn) {
  const keys = ['TEMP', 'TMP', 'TMPDIR'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = directory;
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// The startup background passes hold replacement maintenance until they are idle.
async function backgroundIdle(ctx) {
  await ctx.generatedImageRebuildService?.waitForIdle();
  await ctx.generatedImagePublicationLifecycle?.waitForIdle();
  await ctx.projectOwnershipAdoption?.waitForIdle();
  await ctx.legacyManifestCleanup?.waitForIdle();
}

function logger() {
  const events = [];
  const record = (level) => (entry) => events.push({ level, ...entry });
  return { events, info: record('info'), warn: record('warn'), error: record('error') };
}

beforeEach(() => {
  built.services.length = 0;
  h = makeHarness();
});

afterEach(async () => {
  await h.cleanup();
});

describe('shared construction and automatic location', () => {
  it('recovers the reviewed private location before exposing the cache, and shares one admission and cache with every graph', async () => {
    const runtime = h.runtime();
    // The installation identity selects a root in platform temporary storage, not app-data.
    const cacheRoot = defaultComicPreparationCacheRoot(h.appDataRoot);
    expect(path.dirname(cacheRoot)).toBe(path.resolve(os.tmpdir()));
    expect(cacheRoot.startsWith(h.appDataRoot)).toBe(false);
    expect(runtime.state).toBe('created');
    expect(runtime.preparationCache).toBeNull();

    const result = await runtime.start();
    expect(result).toEqual({ state: 'ready', recovery: { removed: 0, failed: 0, uninspected: 0 } });
    const cache = runtime.preparationCache;
    expect(cache.stagingRoot).toBe(cacheRoot);
    expect(fs.statSync(cacheRoot).isDirectory()).toBe(true);
    // Repeated start returns the one recovery; it never re-runs.
    expect(await runtime.start()).toBe(result);

    const ctx = h.context(runtime);
    expect(ctx.comicRuntime).toBe(runtime);
    expect(built.services).toHaveLength(1);
    expect(built.services[0].deps.admission).toBe(runtime.admission);
    expect(built.services[0].deps.renditions).toBe(runtime.renditions);
    expect(built.services[0].deps.preparationCache).toBe(cache);
    expect(ctx.comicMediaService.getComicManifest).toBe(built.services[0].service.getComicManifest);
    expect(ctx.comicMediaService.getComicPage).toBe(built.services[0].service.getComicPage);
    expect(ctx.comicMediaService.startComicCoverSource).toBe(built.services[0].service.startComicCoverSource);
    expect(ctx.comicMediaService.pauseForMaintenance).not.toBe(built.services[0].service.pauseForMaintenance);
    expect(ctx.app.locals.comicMediaService).toBe(ctx.comicMediaService);
    // Existing image/video services are built as before, beside it.
    expect(ctx.app.locals.mediaService).toBeTruthy();
    expect(ctx.app.locals.previewService).toBe(built.services[0].deps.previewService);
  });

  it('never hands a graph a cache that has not been recovered', async () => {
    const recovering = deferred();
    const runtime = h.runtime({
      createPreparationCache: (options) => {
        const cache = createComicPreparationCache(options);
        return { ...cache, recover: async () => { await recovering.promise; return cache.recover(); } };
      },
    });
    const starting = runtime.start();
    expect(runtime.state).toBe('starting');
    expect(runtime.preparationCache).toBeNull();
    // Built while recovery is pending: on-demand reads through the shared admission only.
    h.context(runtime);
    expect(built.services[0].deps.admission).toBe(runtime.admission);
    expect(built.services[0].deps.preparationCache).toBeUndefined();
    recovering.resolve();
    expect((await starting).state).toBe('ready');
    expect(runtime.preparationCache).not.toBeNull();
  });

  it('refuses a second owner of the same installation until the first has closed', async () => {
    const first = h.runtime();
    await first.start();
    expect(() => createComicRuntime({ appDataRoot: h.appDataRoot, projectsRoot: h.projectsRoot }))
      .toThrow(/already owns this staging root/);
    await first.close();
    // Repeated startup/shutdown of the same installation.
    const second = h.runtime();
    expect((await second.start()).state).toBe('ready');
    await second.close();
    expect(second.state).toBe('closed');
  });

  it('gives a context built without a runtime one admission-only runtime shared by its graphs', async () => {
    const ctx = h.context();
    expect(ctx.comicRuntime.state).toBe('disabled');
    expect(built.services[0].deps.admission).toBe(ctx.comicRuntime.admission);
    expect(built.services[0].deps.renditions).toBe(ctx.comicRuntime.renditions);
    expect(built.services[0].deps.preparationCache).toBeUndefined();
    await backgroundIdle(ctx);
    ctx.replaceAuthConfig(null);
    expect(built.services).toHaveLength(2);
    expect(built.services[1].deps.admission).toBe(ctx.comicRuntime.admission);
    expect(built.services[1].deps.renditions).toBe(ctx.comicRuntime.renditions);
    // Direct createApp callers keep the service's own default (unchanged convention).
    const app = createApp({ appName: APP_NAME, db: h.db, projectsRoot: h.projectsRoot, previewRoot: path.join(h.appDataRoot, 'previews') },
      { appDataRoot: h.appDataRoot, startGeneratedImageRebuild: false });
    expect(app.locals.comicMediaService.getComicManifest).toBe(built.services[2].service.getComicManifest);
    expect(app.locals.comicMediaService.getComicPage).toBe(built.services[2].service.getComicPage);
    expect(app.locals.comicMediaService.startComicCoverSource).toBe(built.services[2].service.startComicCoverSource);
    expect(app.locals.comicMediaService.pauseForMaintenance).not.toBe(built.services[2].service.pauseForMaintenance);
    expect(built.services[2].deps.admission).toBeUndefined();
    expect(built.services[2].deps.renditions).toBeUndefined();
    expect(app.locals.mediaService).toBeTruthy();
  });
});

describe('degraded and failed startup', () => {
  it('reports an unusable location and keeps on-demand comic reading without background preparation', async () => {
    // The platform temporary directory lies beneath a regular file: the location cannot exist.
    const blocker = path.join(h.tmpDir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const runtime = withTemporaryDirectory(path.join(blocker, 'tmp'), () => h.runtime());
    const result = await runtime.start();
    expect(result).toMatchObject({ state: 'degraded', code: 'STAGING_UNAVAILABLE' });
    expect(runtime.preparationCache).toBeNull();

    const log = logger();
    const consoleLog = { warn: vi.fn() };
    reportComicRuntimeStart(result, log, consoleLog);
    expect(log.events).toEqual([expect.objectContaining({
      level: 'warn', subsystem: 'comics', event: 'comics.preparation_cache.unavailable',
      context: expect.objectContaining({ code: 'STAGING_UNAVAILABLE' }),
    })]);
    expect(consoleLog.warn).toHaveBeenCalledTimes(1);

    const ctx = h.context(runtime);
    expect(built.services[0].deps.preparationCache).toBeUndefined();
    const comic = h.addComic();
    const { revision } = await ctx.comicMediaService.getComicManifest(...comic);
    const page = await ctx.comicMediaService.getComicPage(...comic, { revision, position: 1 });
    expect(page.prepared).toBe(false);
    expect(runtime.admission.snapshot()).toEqual({ active: 0, activeBackground: 0, reservedBytes: 0, queued: 0, queuedBackground: 0 });
    expect(await runtime.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
  });

  it('does not disguise an unexpected recovery failure as cache unavailability', async () => {
    const unexpected = new Error('unexpected recovery failure');
    let inner;
    const runtime = h.runtime({
      createPreparationCache: (options) => {
        inner = createComicPreparationCache(options);
        return { ...inner, recover: async () => { throw unexpected; } };
      },
    });
    await expect(runtime.start()).rejects.toBe(unexpected);
    expect(runtime.state).toBe('failed');
    expect(runtime.preparationCache).toBeNull();
    // Its claim on the root was released.
    expect(inner.snapshot().state).toBe('closed');
    await expect(runtime.start()).rejects.toBe(unexpected);
  });

  it('logs a successful recovery, and leftovers it could not remove as a warning', () => {
    const log = logger();
    reportComicRuntimeStart({ state: 'ready', recovery: { removed: 2, failed: 0, uninspected: 0 } }, log);
    reportComicRuntimeStart({ state: 'ready', recovery: { removed: 0, failed: 1, uninspected: 1 } }, log);
    expect(log.events.map((entry) => [entry.level, entry.event, entry.context])).toEqual([
      ['info', 'comics.preparation_cache.recovered', { removed: 2, failed: 0, uninspected: 0 }],
      ['warn', 'comics.preparation_cache.recovered', { removed: 0, failed: 1, uninspected: 1 }],
    ]);
  });
});

// F1b — the runtime is the one owner of the preloaded rendition spare.
// Placed before the shutdown tests: createShutdownHandler leaves the process-wide upload
// tracker in maintenance (exit is a stub), which refuses any later graph replacement here.
describe('preloaded rendition spare ownership (F1b)', () => {
  function tracked(options = {}) {
    const children = [];
    const runtime = h.runtime({
      ...options,
      renditionOptions: {
        ...options.renditionOptions,
        hooks: {
          spawned: ({ pid, spare }) => children.push({ pid, spare, exited: false }),
          exited: ({ pid }) => { children.find((child) => child.pid === pid).exited = true; },
        },
      },
    });
    return { runtime, children };
  }
  const spareState = (runtime) => runtime.snapshot().renditions.spare;
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH';
    }
  };

  it('preloads one spare only after start(), keeps it across graph rebuilds, serves pages from it and closes it', async () => {
    const { runtime, children } = tracked({ renditionSpare: true });
    // Construction launches nothing.
    expect(spareState(runtime).state).toBe('off');
    expect(children).toEqual([]);
    await runtime.start();
    await vi.waitFor(() => expect(spareState(runtime).state).toBe('ready'), { timeout: 15_000 });

    const ctx = h.context(runtime);
    const comic = h.addComic();
    const { revision } = await ctx.comicMediaService.getComicManifest(...comic);
    // The page read is admitted, then its rendition claims the runtime's spare.
    expect((await ctx.comicMediaService.getComicPage(...comic, { revision, position: 1 })).prepared).toBe(false);
    expect(spareState(runtime)).toMatchObject({ claimed: 1 });
    // Background solid preparation is independent of the spare: it publishes as before.
    await runtime.preparationCache.whenIdle();
    expect(runtime.preparationCache.snapshot()).toMatchObject({ entries: 1, pending: 0 });
    await vi.waitFor(() => expect(spareState(runtime).state).toBe('ready'), { timeout: 15_000 });

    // Auth and database replacement build new graphs on the same supervisor: no second spare.
    await backgroundIdle(ctx);
    ctx.replaceAuthConfig(null);
    // A prepared page is still rendered (by the same rendition step): the replacement spare.
    expect((await ctx.comicMediaService.getComicPage(...comic, { revision, position: 2 })).prepared).toBe(true);
    expect(spareState(runtime)).toMatchObject({ claimed: 2 });
    await vi.waitFor(() => expect(spareState(runtime).state).toBe('ready'), { timeout: 15_000 });
    await backgroundIdle(ctx);
    ctx.replaceDatabase(h.freshDatabase());
    for (const { deps } of built.services) expect(deps.renditions).toBe(runtime.renditions);
    expect(spareState(runtime)).toMatchObject({ state: 'ready', launched: 3, claimed: 2, failed: 0 });
    expect(children.filter((child) => !child.exited)).toHaveLength(1);

    expect(await runtime.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(children.every((child) => child.exited && gone(child.pid))).toBe(true);
    expect(runtime.snapshot().renditions).toMatchObject({ state: 'closed', active: 0, spare: { state: 'off' } });
    const again = runtime.close();
    expect(again).toBe(runtime.close());
    await again;
  }, 30_000);

  it('never preloads for test, rootless or default-built owners', async () => {
    const plain = tracked();
    await plain.runtime.start();
    const disabled = createComicRuntime({ preparation: false });
    await disabled.start();
    const ctx = h.context();
    for (const runtime of [plain.runtime, disabled, ctx.comicRuntime]) {
      expect(spareState(runtime).state).toBe('off');
    }
    expect(plain.children).toEqual([]);
    await disabled.close();
    await ctx.comicRuntime.close();
  });

  it('launches no spare when startup fails, and none after close() began', async () => {
    const unexpected = new Error('unexpected recovery failure');
    const failing = tracked({
      renditionSpare: true,
      createPreparationCache: (options) => {
        const inner = createComicPreparationCache(options);
        return { ...inner, recover: async () => { throw unexpected; } };
      },
    });
    await expect(failing.runtime.start()).rejects.toBe(unexpected);
    expect(spareState(failing.runtime).state).toBe('off');
    expect(failing.children).toEqual([]);

    // Shutdown while the cache is still recovering: start() settles after close() began.
    const racing = tracked({ renditionSpare: true });
    const starting = racing.runtime.start();
    const closing = racing.runtime.close();
    await starting.catch(() => {});
    await closing;
    expect(spareState(racing.runtime).state).toBe('off');
    expect(racing.children).toEqual([]);
  });

  it('kills an idle spare and active renditions together at shutdown and awaits every exit', async () => {
    const { runtime, children } = tracked({
      renditionSpare: true, renditionOptions: { childModule: FAKE_RENDITION_CHILD, childArgs: ['hang'] },
    });
    await runtime.start();
    await vi.waitFor(() => expect(spareState(runtime).state).toBe('ready'), { timeout: 15_000 });
    const job = { bytes: ONE_PIXEL_PNG, image: { format: 'png', width: 1, height: 1, animated: false }, maxInputPixels: 100,
      limits: { maxPixels: 100, maxOutputBytes: 1024, maxWebpDimension: 100, timeoutSeconds: 30 } };
    let running = 0;
    const outcomes = [1, 2].map(() => runtime.renditions.run(job, { onPhase: () => { running += 1; } })
      .then(() => 'served', (err) => err.code));
    await vi.waitFor(() => expect(running).toBe(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(spareState(runtime).state).toBe('ready'), { timeout: 15_000 });
    expect(children.filter((child) => !child.exited)).toHaveLength(3);

    await runtime.close();
    expect(await Promise.all(outcomes)).toEqual(['CLOSED', 'CLOSED']);
    expect(children).toHaveLength(3);
    expect(children.every((child) => child.exited && gone(child.pid))).toBe(true);
    expect(runtime.renditions.snapshot()).toMatchObject({ state: 'closed', active: 0, launched: 3, exited: 3 });
  });
});

describe('preparation ownership, replacement and shutdown', () => {
  it('keeps one cache across graph replacement and disposes the prepared comic at close', async () => {
    const runtime = h.runtime();
    await runtime.start();
    const cache = runtime.preparationCache;
    const ctx = h.context(runtime);
    const comic = h.addComic();
    const { revision } = await ctx.comicMediaService.getComicManifest(...comic);
    expect((await ctx.comicMediaService.getComicPage(...comic, { revision, position: 1 })).prepared).toBe(false);
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 1, pending: 0 });
    expect(fs.readdirSync(cache.stagingRoot)).toHaveLength(1);

    // Auth reconfiguration rebuilds the graph against the same database: the new graph's
    // service gets the very same admission and cache, and is served from the preparation.
    const before = ctx.comicMediaService;
    await backgroundIdle(ctx);
    ctx.replaceAuthConfig(null);
    expect(ctx.comicMediaService).not.toBe(before);
    expect(built.services.at(-1).deps.preparationCache).toBe(cache);
    expect(built.services.at(-1).deps.admission).toBe(runtime.admission);
    expect(built.services.at(-1).deps.renditions).toBe(runtime.renditions);
    expect((await ctx.comicMediaService.getComicPage(...comic, { revision, position: 2 })).prepared).toBe(true);

    // A database replacement re-authorizes every read against the new graph: the comic of
    // the retired database is unknown there, and the preparation is never served for it.
    await backgroundIdle(ctx);
    ctx.replaceDatabase(h.freshDatabase());
    expect(built.services.at(-1).deps.preparationCache).toBe(cache);
    expect(built.services.at(-1).deps.renditions).toBe(runtime.renditions);
    await expect(ctx.comicMediaService.getComicPage(...comic, { revision, position: 2 }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^ASSET_(NOT_FOUND|PROJECT_MISMATCH)$/) });

    const closing = runtime.close();
    // New work is refused from the first step of close().
    expect(cache.schedule({ projectId: 1, assetId: 1, revision: 'r', expectedBytes: 1, changedAtMs: 0, run: async () => ({}) }))
      .toBe('closed');
    expect(runtime.preparationCache).toBeNull();
    expect(await closing).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(fs.readdirSync(cache.stagingRoot)).toEqual([]);
    expect(cache.snapshot()).toMatchObject({ state: 'closed', entries: 0, retiring: 0, pending: 0, aborting: 0 });
    // Idempotent.
    expect(runtime.close()).toBe(closing);
  });

  it('cancels running and queued preparations at shutdown and releases their admission', async () => {
    const runtime = h.runtime();
    await runtime.start();
    const cache = runtime.preparationCache;
    const started = deferred();
    const request = (assetId, run) => cache.schedule({
      projectId: 1, assetId, revision: 'r' + assetId, expectedBytes: 1024, changedAtMs: 0, run,
    });
    expect(request(1, heldPreparation(runtime.admission, started.resolve))).toBe('scheduled');
    await started.promise;
    // The background lane runs one preparation; the next waits in the admission queue.
    expect(request(2, heldPreparation(runtime.admission))).toBe('scheduled');
    await vi.waitFor(() => expect(runtime.admission.snapshot()).toMatchObject({ activeBackground: 1, queuedBackground: 1 }));

    expect(await runtime.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(cache.snapshot()).toMatchObject({ state: 'closed', pending: 0, aborting: 0, reservedBytes: 0 });
    expect(runtime.admission.snapshot()).toEqual({ active: 0, activeBackground: 0, reservedBytes: 0, queued: 0, queuedBackground: 0 });
  });

  it('waits for comic cleanup before retiring the database, and reports retained storage', async () => {
    const closing = deferred();
    const events = [];
    const log = logger();
    let closeCalls = 0;
    const comicRuntime = {
      close: () => {
        closeCalls += 1;
        events.push('comic-close');
        return closing.promise;
      },
    };
    const db = h.freshDatabase();
    let finishHttp;
    const shutdown = createShutdownHandler({
      appContext: {
        get db() { return db; },
        comicRuntime,
        processingJobService: { waitForIdle: async () => {} },
      },
      server: { close: (callback) => { events.push('http'); finishHttp = callback; } },
      viteServer: null,
      automaticProjectScanScheduler: { stop: () => {} },
      applicationLogger: { ...log, info: (entry) => { log.info(entry); events.push(entry.event); } },
      retireDatabase: (connection) => { events.push('database'); closeDatabase(connection); },
      exit: () => events.push('exit'),
    });
    const done = shutdown();
    // Comic work stops before HTTP drains.
    expect(events.slice(0, 2)).toEqual(['comic-close', 'runtime.shutdown.requested']);
    await vi.waitFor(() => expect(events).toContain('http'));
    finishHttp();
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).not.toContain('database');
    closing.resolve({ stranded: 1, strandedBytes: 2048, unmeasured: 0 });
    await done;
    expect(events.slice(-3)).toEqual(['runtime.shutdown.completed', 'database', 'exit']);
    expect(log.events).toContainEqual(expect.objectContaining({
      level: 'warn', event: 'comics.preparation_cache.retained', context: { stranded: 1, strandedBytes: 2048, unmeasured: 0 },
    }));
    // Repeated signals do not close again.
    await shutdown();
    expect(closeCalls).toBe(1);
  });

  it('finishes shutdown when comic cleanup fails, reporting the failure', async () => {
    const log = logger();
    const events = [];
    const failure = new ComicPreparationCacheError('STAGING_UNAVAILABLE', 'root changed');
    const db = h.freshDatabase();
    const shutdown = createShutdownHandler({
      appContext: {
        get db() { return db; },
        comicRuntime: { close: () => Promise.reject(failure) },
        processingJobService: { waitForIdle: async () => {} },
      },
      server: { close: (callback) => callback() },
      automaticProjectScanScheduler: { stop: () => {} },
      applicationLogger: log,
      retireDatabase: (connection) => { events.push('database'); closeDatabase(connection); },
      exit: () => events.push('exit'),
    });
    await shutdown();
    expect(events).toEqual(['database', 'exit']);
    expect(log.events).toContainEqual(expect.objectContaining({ level: 'error', event: 'comics.runtime.close_failed', error: failure }));
  });

  it('reports nothing when shutdown left no temporary storage', () => {
    const log = logger();
    reportComicRuntimeClose({ stranded: 0, strandedBytes: 0, unmeasured: 0 }, log);
    expect(log.events).toEqual([]);
    reportComicRuntimeClose({ stranded: 1, strandedBytes: 0, unmeasured: 1 }, log);
    expect(log.events).toEqual([expect.objectContaining({ level: 'warn', event: 'comics.preparation_cache.retained' })]);
  });

  it('kills active rendition children at shutdown, awaits their exit and refuses new renditions', async () => {
    const children = [];
    const runtime = h.runtime({
      renditionOptions: {
        childModule: FAKE_RENDITION_CHILD,
        childArgs: ['hang'],
        hooks: {
          spawned: ({ pid }) => children.push({ pid, exited: false }),
          exited: ({ pid }) => { children.find((child) => child.pid === pid).exited = true; },
        },
      },
    });
    await runtime.start();
    const job = { bytes: ONE_PIXEL_PNG, image: { format: 'png', width: 1, height: 1, animated: false }, maxInputPixels: 100,
      limits: { maxPixels: 100, maxOutputBytes: 1024, maxWebpDimension: 100, timeoutSeconds: 30 } };
    let running = 0;
    const outcomes = [1, 2].map(() => runtime.renditions.run(job, { onPhase: () => { running += 1; } })
      .then(() => 'served', (err) => err.code));
    await vi.waitFor(() => expect(running).toBe(2), { timeout: 10_000 });
    expect(runtime.snapshot().renditions).toMatchObject({ state: 'open', active: 2 });

    const closing = runtime.close();
    await expect(runtime.renditions.run(job)).rejects.toMatchObject({ code: 'CLOSED' });
    expect(await closing).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    // close() resolved only after both children (busy in JavaScript) were confirmed gone.
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.exited).toBe(true);
      expect(() => process.kill(child.pid, 0)).toThrow();
    }
    expect(await Promise.all(outcomes)).toEqual(['CLOSED', 'CLOSED']);
    expect(runtime.renditions.snapshot()).toMatchObject({ state: 'closed', active: 0, launched: 2, exited: 2 });
    expect(runtime.close()).toBe(closing);
  });

  it('closes the rendition supervisor of an admission-only runtime', async () => {
    const runtime = createComicRuntime({ preparation: false });
    expect(runtime.renditions.state).toBe('open');
    expect(await runtime.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(runtime.renditions.state).toBe('closed');
  });

  it('closes a runtime that never started, releasing its root', async () => {
    const runtime = h.runtime();
    expect(await runtime.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    await expect(runtime.start()).rejects.toMatchObject({ code: 'CACHE_CLOSED' });
    const again = h.runtime();
    expect((await again.start()).state).toBe('ready');
  });
});
