// F2 — Database restoration and auth replacement versus queued and active comic operations.
//
// Real application context, real restore route and backup service, real comic runtime (shared
// admission, rendition supervisor and recovered preparation cache), real comic media services
// built per graph against that graph's database, real CBZ/CBR fixtures and readers. Only the
// narrow boundaries needed for deterministic timing are touched: descriptor open/close are
// counted, the services' own test-only timing hooks hold an operation at a known point, and the
// backup service's restoreBackup is wrapped to observe the retirement boundary (the moment it
// is called, maintenance owns the live database it is about to close).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import request from 'supertest';
import sharp from 'sharp';
import { makeZip } from './helpers/zip-fixture.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';

// Every recover() on Windows reads the cache path's ACLs through Windows PowerShell.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const handles = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock('../src/storage/asset-file.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openAssetFileAsync: async (...args) => {
      const opened = await actual.openAssetFileAsync(...args);
      handles.opened += 1;
      return opened;
    },
    closeAssetFileAsync: async (opened) => {
      handles.closed += 1;
      return actual.closeAssetFileAsync(opened);
    },
  };
});

const { openDatabase, runMigrations, closeDatabase } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { createApplicationContext } = await import('../src/app-context.js');
const { createBackupService, BackupError } = await import('../src/services/backup-service.js');
const { managedUploadTracker: tracker } = await import('../src/services/managed-upload-tracker.js');
const { createProjectRepository } = await import('../src/data/project-repository.js');
const { createAssetRepository } = await import('../src/data/asset-repository.js');
const { formatProjectDirName } = await import('../src/storage/project-storage.js');
const { createPreviewService } = await import('../src/services/preview-service.js');
const { createComicMediaService } = await import('../src/services/comic-media-service.js');
const { createComicRuntime } = await import('../src/services/comic-runtime.js');
const { defaultComicPreparationCacheRoot } = await import('../src/services/comic-preparation-cache.js');

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const CBR_MIME = 'application/vnd.comicbook-rar';
const CBZ_MIME = 'application/vnd.comicbook+zip';
const BUSY_TEXT = 'Comics are busy; try again shortly.';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function binary(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

// ─── Shared runtime (one per process, like server.js) ────────────────────────────────────

let tmpDir;
let appDataRoot;
let projectsRoot;
let previewRoot;
let runtime;
const children = new Map(); // pid -> { exited }
const img = {};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-comic-restore-'));
  appDataRoot = path.join(tmpDir, 'app');
  projectsRoot = path.join(tmpDir, 'projects');
  previewRoot = path.join(appDataRoot, 'previews');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(previewRoot, { recursive: true });
  runtime = createComicRuntime({
    appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 },
    renditionOptions: {
      hooks: {
        spawned: ({ pid }) => children.set(pid, { exited: false }),
        exited: ({ pid }) => { children.get(pid).exited = true; },
      },
    },
  });
  await runtime.start();
  expect(runtime.state).toBe('ready');
  img.jpeg = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  img.png = await sharp({ create: { width: 40, height: 50, channels: 3, background: '#993366' } }).png().toBuffer();
});

afterAll(async () => {
  await runtime?.close();
  if (appDataRoot) fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

// ─── Per-test application context ────────────────────────────────────────────────────────

let seq = 0;
let db;
let backup;
let context;
let hooks;
let graphs;
let restoreGate;
let atRetire;
let connections;
let databasePath;
let lastOwner;
let closedAuthority;

beforeEach(() => {
  seq += 1;
  databasePath = path.join(appDataRoot, `restore-${seq}.db`);
  lastOwner = null;
  db = openDatabase(databasePath);
  runMigrations(db, MIGRATIONS_DIR);
  connections = new Set([db]);
  backup = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
  hooks = {};
  graphs = [];
  restoreGate = null;
  atRetire = [];
  // The retirement boundary: restoreBackup checkpoints and closes the live database it is given.
  const service = {
    ...backup,
    restoreBackup: async (filename, liveDb, owner) => {
      atRetire.push({
        dbOpen: liveDb.open,
        admission: runtime.admission.snapshot(),
        renditions: runtime.renditions.snapshot(),
        handlesBalanced: handles.closed === handles.opened,
        uploadAdmissionClosed: tracker.begin() === null,
      });
      await restoreGate?.();
      const result = await backup.restoreBackup(filename, liveDb, owner);
      connections.add(result.db);
      return result;
    },
  };
  // Each graph gets the real comic media service createApp would build (this graph's preview
  // authority, the shared runtime's admission/supervisor/cache), plus the test timing hooks.
  closedAuthority = [];
  const factory = (deps, opts) => {
    // Records any authorization a graph attempts through its database after that database closed.
    const previewService = new Proxy(
      createPreviewService({ db: deps.db, projectsRoot: deps.projectsRoot, previewRoot: deps.previewRoot }),
      {
        get(target, key) {
          const value = target[key];
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (!deps.db.open) closedAuthority.push(String(key));
            return value.apply(target, args);
          };
        },
      },
    );
    const comicMediaService = createComicMediaService({
      previewService,
      projectsRoot: deps.projectsRoot,
      admission: opts.comicRuntime.admission,
      renditions: opts.comicRuntime.renditions,
      ...(opts.comicRuntime.preparationCache ? { preparationCache: opts.comicRuntime.preparationCache } : {}),
      _hooks: hooks,
    });
    const app = createApp(deps, {
      ...opts, previewService, comicMediaService,
      // Observed only, so a fail-closed scenario's retained owner can be released at teardown.
      beginReplacementAfterRebuild: async () => (lastOwner = await opts.beginReplacementAfterRebuild()),
    });
    graphs.push(app);
    return app;
  };
  context = createApplicationContext({
    appName: 'CreatorCrate', projectsRoot, previewRoot,
    appOpts: {
      appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR, backupService: service,
      maintenanceState: { active: false }, comicRuntime: runtime,
    },
  }, db, factory);
});

afterEach(async () => {
  for (const owner of [context.generatedImageRebuildService, context.generatedImagePublicationLifecycle,
    context.projectOwnershipAdoption, context.legacyManifestCleanup]) owner?.stop();
  context.releaseNotificationRuntime?.stop();
  // Fail-closed scenarios deliberately retain maintenance until this isolated graph is torn down.
  lastOwner?.release();
  await context.generatedImageRebuildService?.waitForIdle();
  await context.generatedImagePublicationLifecycle?.waitForIdle();
  await context.projectOwnershipAdoption?.waitForIdle();
  await context.legacyManifestCleanup?.waitForIdle();
  await context.releaseNotificationRuntime?.waitForIdle();
  try {
    await runtime.preparationCache?.whenIdle();
    // Nothing leaked: descriptors, admission, rendition children, cache leases, upload ownership.
    expect(handles.closed).toBe(handles.opened);
    expect(runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, queuedBackground: 0, reservedBytes: 0 });
    expect(runtime.renditions.snapshot()).toMatchObject({ active: 0, terminating: 0 });
    expect([...children.values()].every((child) => child.exited)).toBe(true);
    expect(runtime.preparationCache.snapshot()).toMatchObject({ readers: 0, pending: 0, aborting: 0, reservedBytes: 0 });
    expect(tracker.activeCount).toBe(0);
  } finally {
    for (const connection of new Set([...connections, context.db])) if (connection?.open) closeDatabase(connection);
  }
});

const handler = (req, res) => context.handleRequest(req, res);

function addComic(title, relPath, bytes, mimeType) {
  const projectRepo = createProjectRepository(context.db);
  const assetRepo = createAssetRepository(context.db);
  let project = projectRepo.create({
    title, projectType: 'images', slug: slugify(title, { lowercase: true }), description: '', notes: '',
    status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
  });
  const relDir = formatProjectDirName(project.id, project.slug) + `-${seq}`;
  const absPath = path.resolve(projectsRoot, relDir);
  fs.mkdirSync(absPath, { recursive: true });
  project = projectRepo.setProjectDir(project.id, relDir);
  bindTestProjectOwnership(context.db, project.id, absPath);
  const full = path.join(absPath, relPath);
  fs.writeFileSync(full, bytes);
  const stat = fs.statSync(full);
  const asset = assetRepo.upsert(project.id, relPath, {
    filename: relPath, extension: relPath.split('.').pop().toLowerCase(), mimeType,
    sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
  });
  return { base: `/projects/${project.id}/assets/${asset.id}`, projectId: project.id, assetId: asset.id, full };
}

async function manifestOf(base) {
  const res = await request(handler).get(base + '/comic');
  expect(res.status).toBe(200);
  return res.body;
}

const getPage = (url) => request(handler).get(url).buffer(true).parse(binary);
const cbr = (name) => fs.readFileSync(path.join(COMICS, name));
const restore = (filename) => request(handler).post(`/settings/backups/${filename}/restore`).then((res) => res);

function expectMaintenanceRefusal(res) {
  expect(res.status).toBe(503);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.text ?? res.body.toString()).toBe(BUSY_TEXT);
}

function holdAdmission() {
  const gate = deferred();
  const holders = Array.from({ length: runtime.admission.limits.maxActive },
    () => runtime.admission.run(() => gate.promise, { weightBytes: 1024 }));
  return { release: async () => { gate.resolve(); await Promise.all(holders); } };
}

// ─── Queued operations ───────────────────────────────────────────────────────────────────

describe('queued comic requests during restore', () => {
  it('cancels a queued request of the old graph before its database is retired; fresh requests use the new graph', async () => {
    const comic = addComic('Queued', 'book.cbz', makeZip([{ name: 'p1.jpg', data: img.jpeg }, { name: 'p2.png', data: img.png }]), CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const saved = await backup.createBackup(db);
    const oldApp = context.app;
    const oldService = oldApp.locals.comicMediaService;
    const opened = handles.opened;

    // 1. Fill the shared admission; 2. queue a page and a manifest request under this graph.
    const held = holdAdmission();
    const queuedPage = request(handler).get(pages[0].url).then((res) => res);
    const queuedManifest = request(handler).get(comic.base + '/comic').then((res) => res);
    await vi.waitFor(() => expect(runtime.admission.snapshot().queued).toBe(2));

    // 3-4. Restore: the queued requests are cancelled at the maintenance pause, before the
    // retirement boundary, while the admission is still full.
    const restoring = restore(saved.filename);
    expectMaintenanceRefusal(await queuedPage);
    expectMaintenanceRefusal(await queuedManifest);
    const response = await restoring;
    expect(response.headers.location).toBe('/settings/backups?notice=restore_success');
    expect(atRetire).toEqual([expect.objectContaining({
      dbOpen: true, handlesBalanced: true, uploadAdmissionClosed: true,
      admission: expect.objectContaining({ queued: 0, active: runtime.admission.limits.maxActive }),
    })]);
    // The queued requests never opened their source, and released their queue places.
    expect(handles.opened).toBe(opened);
    expect(db.open).toBe(false);

    // 5. Releasing capacity starts nothing of the retired graph.
    await held.release();
    expect(runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
    expect(handles.opened).toBe(opened);

    // The retired graph never reaches its closed database: refused before authorization.
    await expect(oldService.getComicManifest(comic.projectId, comic.assetId)).rejects.toMatchObject({
      status: 503, code: 'BUSY', reason: 'MAINTENANCE',
    });
    // Fresh requests reach the new graph, which re-authorizes against the restored database.
    expect(context.app).not.toBe(oldApp);
    expect(context.app.locals.comicRuntime).toBe(runtime);
    const fresh = await manifestOf(comic.base);
    expect(fresh.revision).toBe(pages[0].url.split('v=')[1]);
    const page = await getPage(fresh.pages[0].url);
    expect(page.status).toBe(200);
    expect(page.body.equals(img.jpeg)).toBe(true);
  });

  it('runs repeated restores without leaking queued work, slots or graphs', async () => {
    const comic = addComic('Repeated', 'book.cbz', makeZip([{ name: 'p1.jpg', data: img.jpeg }]), CBZ_MIME);
    const saved = await backup.createBackup(db);
    for (let round = 0; round < 3; round += 1) {
      const held = holdAdmission();
      const queued = request(handler).get(comic.base + '/comic').then((res) => res);
      await vi.waitFor(() => expect(runtime.admission.snapshot().queued).toBe(1));
      const restoring = restore(saved.filename);
      expectMaintenanceRefusal(await queued);
      expect((await restoring).headers.location).toBe('/settings/backups?notice=restore_success');
      await held.release();
      expect(runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
      const { pages } = await manifestOf(comic.base);
      expect((await getPage(pages[0].url)).status).toBe(200);
    }
    // One graph per build (initial + three restores), every graph sharing the one runtime.
    expect(graphs).toHaveLength(4);
    expect(new Set(graphs.map((app) => app.locals.comicRuntime))).toEqual(new Set([runtime]));
    for (const retired of graphs.slice(0, 3)) {
      await expect(retired.locals.comicMediaService.getComicManifest(comic.projectId, comic.assetId))
        .rejects.toMatchObject({ code: 'BUSY', reason: 'MAINTENANCE' });
    }
    expect(atRetire.every((entry) => entry.dbOpen && entry.handlesBalanced && entry.admission.queued === 0)).toBe(true);
  });
});

// ─── Active operations ───────────────────────────────────────────────────────────────────

describe('active comic operations during restore', () => {
  it.each([
    ['manifest', 'cbr', 'comic-rar5.cbr'],
    ['page', 'cbr', 'comic-rar5.cbr'],
    ['page', 'cbz', null],
  ])('restore waits for an active %s read (%s) to be cancelled and cleaned up before retiring the database', async (stage, format, fixture) => {
    const bytes = fixture ? cbr(fixture) : makeZip([{ name: 'p1.jpg', data: img.jpeg }, { name: 'p2.png', data: img.png }]);
    const comic = addComic(`Active ${stage} ${format}`, `book.${format}`, bytes, format === 'cbr' ? CBR_MIME : CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const saved = await backup.createBackup(db);
    const entered = deferred();
    const gate = deferred();
    let held = false;
    hooks.afterRead = async (info) => {
      if (info.stage !== stage || held) return;
      held = true;
      entered.resolve();
      await gate.promise;
    };
    const url = stage === 'manifest' ? comic.base + '/comic' : pages[0].url;
    const active = request(handler).get(url).then((res) => res);
    await entered.promise;
    expect(runtime.admission.snapshot().active).toBe(1);

    const restoring = restore(saved.filename);
    // The pause is in force (new comic work of this graph is refused) ...
    await vi.waitFor(async () => expectMaintenanceRefusal(await request(handler).get(comic.base + '/comic')));
    // ... but maintenance has not begun and the database is untouched while the read is active.
    const upload = tracker.begin();
    expect(upload).not.toBeNull();
    upload.complete();
    expect(atRetire).toEqual([]);
    expect(db.open).toBe(true);

    gate.resolve();
    expectMaintenanceRefusal(await active);
    expect((await restoring).headers.location).toBe('/settings/backups?notice=restore_success');
    // Retirement happened only after the read released its slot and descriptor.
    expect(atRetire).toEqual([expect.objectContaining({
      dbOpen: true, handlesBalanced: true, admission: expect.objectContaining({ active: 0, queued: 0, reservedBytes: 0 }),
    })]);
    hooks.afterRead = undefined;
    const fresh = await manifestOf(comic.base);
    expect((await getPage(fresh.pages[0].url)).status).toBe(200);
  });

  it('restore waits until an active rendition child is killed and confirmed gone', async () => {
    // 36 MP: metadata, a whole-image stats() decode and a downscale in the child.
    const width = 6000;
    const raw = Buffer.alloc(width * width * 3);
    for (let y = 0; y < width; y += 1) raw.fill((y * 13) & 0xff, y * width * 3, (y + 1) * width * 3);
    const costly = await sharp(raw, { raw: { width, height: width, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
    const comic = addComic('Rendition', 'book.cbz', makeZip([{ name: 'p1.png', data: costly }, { name: 'p2.jpg', data: img.jpeg }]), CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const saved = await backup.createBackup(db);
    const reached = deferred();
    hooks.renditionPhase = ({ phase, position }) => { if (position === 1 && phase === 'stats') reached.resolve(); };
    const before = new Set(children.keys());
    const active = request(handler).get(pages[0].url).then((res) => res);
    await reached.promise;
    const pid = [...children.keys()].find((key) => !before.has(key));
    expect(children.get(pid).exited).toBe(false);

    const restoring = restore(saved.filename);
    expectMaintenanceRefusal(await active);
    expect((await restoring).headers.location).toBe('/settings/backups?notice=restore_success');
    // The child was gone, and its admission released, before the database was retired.
    expect(children.get(pid).exited).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(atRetire).toEqual([expect.objectContaining({
      dbOpen: true, handlesBalanced: true,
      admission: expect.objectContaining({ active: 0, reservedBytes: 0 }),
      renditions: expect.objectContaining({ active: 0, terminating: 0 }),
    })]);
    hooks.renditionPhase = undefined;
    const page = await getPage(pages[1].url);
    expect(page.status).toBe(200);
    expect(page.body.equals(img.jpeg)).toBe(true);
  });

  it('cancels a cache-hit read; the restored graph authorizes before any prepared page is served', async () => {
    // The backup predates the comic: the restored database does not know it.
    const saved = await backup.createBackup(db);
    const comic = addComic('Prepared', 'book.cbr', cbr('comic-rar5-solid.cbr'), CBR_MIME);
    const { pages } = await manifestOf(comic.base);
    const cache = runtime.preparationCache;
    expect((await getPage(pages[5].url)).status).toBe(200);
    await cache.whenIdle();
    expect((await manifestOf(comic.base)).preparation.state).toBe('ready');
    const entered = deferred();
    const gate = deferred();
    hooks.preparedRead = async () => { entered.resolve(); await gate.promise; };
    const active = request(handler).get(pages[2].url).then((res) => res);
    await entered.promise;
    const restoring = restore(saved.filename);
    await vi.waitFor(async () => expectMaintenanceRefusal(await request(handler).get(comic.base + '/comic')));
    expect(atRetire).toEqual([]);
    gate.resolve();
    expectMaintenanceRefusal(await active);
    expect((await restoring).headers.location).toBe('/settings/backups?notice=restore_success');
    expect(atRetire[0]).toMatchObject({ dbOpen: true, handlesBalanced: true, admission: { active: 0 } });
    expect(cache.snapshot()).toMatchObject({ readers: 0 });
    hooks.preparedRead = undefined;
    // The preparation still exists, but the restored graph's authority decides: not found.
    const preparedReads = [];
    hooks.preparedRead = (info) => { preparedReads.push(info); };
    expect((await request(handler).get(pages[2].url)).status).toBe(404);
    expect((await request(handler).get(comic.base + '/comic')).status).toBe(404);
    expect(preparedReads).toEqual([]);
  });

  it('cancels a running background preparation without recording a failure, then prepares under the new graph', async () => {
    const comic = addComic('Background', 'book.cbr', cbr('comic-rar4-solid.cbr'), CBR_MIME);
    const { pages } = await manifestOf(comic.base);
    const saved = await backup.createBackup(db);
    const cache = runtime.preparationCache;
    const baseline = cache.snapshot();
    const entered = deferred();
    const gate = deferred();
    hooks.beforePrepare = async () => { entered.resolve(); await gate.promise; };
    expect((await getPage(pages[0].url)).status).toBe(200);
    await entered.promise;
    // The preparation holds a background slot and its source descriptor.
    expect(runtime.admission.snapshot()).toMatchObject({ active: 1, activeBackground: 1 });
    expect(handles.opened).toBe(handles.closed + 1);

    const restoring = restore(saved.filename);
    await vi.waitFor(async () => expectMaintenanceRefusal(await request(handler).get(comic.base + '/comic')));
    expect(atRetire).toEqual([]);
    gate.resolve();
    expect((await restoring).headers.location).toBe('/settings/backups?notice=restore_success');
    expect(atRetire[0]).toMatchObject({
      dbOpen: true, handlesBalanced: true, admission: { active: 0, activeBackground: 0, reservedBytes: 0 },
    });
    await cache.whenIdle();
    // Nothing published from the paused graph, and maintenance is not a failure of the revision.
    expect(cache.snapshot()).toMatchObject({ entries: baseline.entries, failures: baseline.failures, reservedBytes: 0 });

    // The new graph schedules and publishes it normally (no backoff).
    hooks.beforePrepare = undefined;
    const fresh = await manifestOf(comic.base);
    expect(fresh.preparation.state).toBe('on-demand');
    expect((await getPage(fresh.pages[0].url)).status).toBe(200);
    await cache.whenIdle();
    expect(cache.snapshot().entries).toBe(baseline.entries + 1);
    expect((await manifestOf(comic.base)).preparation.state).toBe('ready');
  });
});

// ─── Restore failure, refusal and rollback ───────────────────────────────────────────────

describe('restore failure keeps comics available', () => {
  async function queuedDuring(start) {
    const comic = addComic(`Failure ${seq}`, 'book.cbz', makeZip([{ name: 'p1.jpg', data: img.jpeg }]), CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const held = holdAdmission();
    const queued = request(handler).get(pages[0].url).then((res) => res);
    await vi.waitFor(() => expect(runtime.admission.snapshot().queued).toBe(1));
    const outcome = await start();
    expectMaintenanceRefusal(await queued);
    await held.release();
    return { comic, pages, outcome };
  }

  it('validation failure resumes the same graph', async () => {
    const app = context.app;
    const { pages, outcome } = await queuedDuring(() => restore('missing.sqlite'));
    expect(outcome.headers.location).toBe('/settings/backups?notice=restore_failed');
    expect(context.app).toBe(app);
    expect(db.open).toBe(true);
    expect((await getPage(pages[0].url)).status).toBe(200);
  });

  it('a refused restore (upload active) resumes the same graph', async () => {
    const app = context.app;
    const saved = await backup.createBackup(db);
    const upload = tracker.begin();
    let result;
    try {
      result = await queuedDuring(() => restore(saved.filename));
    } finally {
      upload.complete();
    }
    expect(result.outcome.headers.location).toBe('/settings/backups?notice=restore_conflict');
    expect(context.app).toBe(app);
    expect(db.open).toBe(true);
    expect((await getPage(result.pages[0].url)).status).toBe(200);
  });

  it('a failure before replacement rolls back to the reopened original, served by a new graph', async () => {
    const saved = await backup.createBackup(db);
    const app = context.app;
    // Fail inside the real service after the live database was closed: it rolls back and hands
    // back a recovered connection, which the route adopts.
    const original = backup.restoreBackup;
    const failing = createBackupService({
      appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR,
      _hooks: { afterStagedRestorePrepared: () => { throw new Error('injected failure during replacement'); } },
    });
    backup.restoreBackup = failing.restoreBackup;
    let result;
    try {
      result = await queuedDuring(() => restore(saved.filename));
    } finally {
      backup.restoreBackup = original;
    }
    expect(result.outcome.headers.location).toBe('/settings/backups?notice=restore_failed');
    expect(db.open).toBe(false);
    expect(context.app).not.toBe(app);
    connections.add(context.db);
    expect((await getPage(result.pages[0].url)).status).toBe(200);
  });

  it('a fatal failure after retirement keeps maintenance closed without a comic 500', async () => {
    const comic = addComic('Fatal', 'book.cbz', makeZip([{ name: 'p1.jpg', data: img.jpeg }]), CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const original = backup.restoreBackup;
    backup.restoreBackup = async (_filename, liveDb, owner) => {
      tracker.assertMaintenanceOwner(owner, liveDb);
      liveDb.close();
      throw new Error('injected fatal restore failure');
    };
    try {
      // The restore route itself fails closed exactly as before (unchanged behavior).
      expect((await restore('any.sqlite')).status).toBe(500);
    } finally {
      backup.restoreBackup = original;
    }
    expect(db.open).toBe(false);
    expect(lastOwner).toBeTruthy();
    // Existing fail-closed behavior: the maintenance boundary answers, never the closed graph.
    const res = await request(handler).get(pages[0].url);
    expect(res.status).toBe(503);
    expect(res.text).not.toBe(BUSY_TEXT);
    // Even called directly, the paused graph refuses before touching its closed database.
    await expect(context.app.locals.comicMediaService.getComicManifest(comic.projectId, comic.assetId))
      .rejects.toMatchObject({ status: 503, code: 'BUSY', reason: 'MAINTENANCE' });
  });
});

// ─── Synchronous replacement acquisition ─────────────────────────────────────────────────
//
// beginReplacement() cannot await the comic pause's cleanup, so it must refuse (the context's
// established synchronous refusal: a thrown Error, no owner) while this graph has comic work
// queued, admitted or settling, and must succeed once that work is genuinely idle.

const COMIC_REFUSAL = /comic operations are active/;

// The graph's other background work (resumed whenever an owner releases) briefly holds upload
// lifetimes, which the existing upload guard refuses acquisition for; let it settle first.
async function settleBackgroundWork() {
  await context.generatedImageRebuildService?.waitForIdle();
  await context.generatedImagePublicationLifecycle?.waitForIdle();
  await context.projectOwnershipAdoption?.waitForIdle();
  await context.legacyManifestCleanup?.waitForIdle();
  await tracker.waitForIdle();
}

// While a replacement owner holds maintenance, the application's maintenance boundary answers
// before any comic route (as in the fail-closed scenario above).
function expectMaintenanceHeld(res) {
  expect(res.status).toBe(503);
  expect(res.text).not.toBe(BUSY_TEXT);
}

describe('synchronous replacement acquisition', () => {
  // Proves a refused acquisition left nothing behind: uploads are admitted (no maintenance
  // owner) and the graph still serves comics (no lingering pause).
  async function expectNoMaintenance(comic) {
    const upload = tracker.begin();
    expect(upload).not.toBeNull();
    upload.complete();
    expect(context.comicMediaService.isIdle()).toBe(false);
    expect((await request(handler).get(comic.base + '/comic')).status).toBe(200);
  }

  it.each([
    ['manifest', 'cbz', null],
    ['manifest', 'cbr', 'comic-rar5.cbr'],
    ['page', 'cbz', null],
  ])('reviewer reproduction: refuses while an active %s read (%s) is held, then retires safely once idle', async (stage, format, fixture) => {
    const bytes = fixture ? cbr(fixture) : makeZip([{ name: 'p1.jpg', data: img.jpeg }, { name: 'p2.png', data: img.png }]);
    const comic = addComic(`Sync ${stage} ${format}`, `book.${format}`, bytes, format === 'cbr' ? CBR_MIME : CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const saved = await backup.createBackup(db);
    const oldApp = context.app;
    const oldService = oldApp.locals.comicMediaService;
    // 1-2. Hold the read just before its final filesystem identity check.
    const entered = deferred();
    const gate = deferred();
    let held = false;
    hooks.afterRead = async (info) => {
      if (info.stage !== stage || held) return;
      held = true;
      entered.resolve();
      await gate.promise;
    };
    const active = request(handler).get(stage === 'manifest' ? comic.base + '/comic' : pages[0].url).then((res) => res);
    await entered.promise;
    expect(runtime.admission.snapshot().active).toBe(1);

    // 3-4. Synchronous acquisition is refused: no owner, so nothing can retire the database.
    expect(() => context.beginReplacement()).toThrow(COMIC_REFUSAL);
    // 5. The owner-less retirement entry points refuse too, leaving the live graph in place.
    await expect(backup.restoreBackup(saved.filename, db)).rejects.toThrow(/ownership is required/);
    const candidate = openDatabase(path.join(appDataRoot, `candidate-${seq}.db`));
    connections.add(candidate);
    expect(() => context.replaceDatabase(candidate)).toThrow(COMIC_REFUSAL);
    expect(candidate.open).toBe(false);
    expect(() => context.replaceAuthConfig(null)).toThrow(COMIC_REFUSAL);
    // 6. The old database is untouched and the graph is neither paused nor in maintenance.
    expect(context.app).toBe(oldApp);
    expect(context.db).toBe(db);
    expect(db.open).toBe(true);
    await expectNoMaintenance(comic);

    // 7. The held read was not cancelled by the refusal; it completes normally and settles.
    gate.resolve();
    expect((await active).status).toBe(200);
    hooks.afterRead = undefined;
    expect(oldService.isIdle()).toBe(true);
    expect(runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
    expect(handles.closed).toBe(handles.opened);

    // 8-9. Genuinely idle: acquisition succeeds and the real restore retires the database.
    await settleBackgroundWork();
    const owner = context.beginReplacement();
    let restored;
    try {
      expectMaintenanceHeld(await request(handler).get(comic.base + '/comic'));
      restored = await backup.restoreBackup(saved.filename, db, owner);
      connections.add(restored.db);
      context.replaceDatabase(restored.db, owner);
    } finally {
      owner.release();
    }
    expect(db.open).toBe(false);
    expect(context.db).toBe(restored.db);
    expect(context.app).not.toBe(oldApp);
    // 20. The retired graph refuses before authorizing; nothing reached its closed database.
    await expect(oldService.getComicManifest(comic.projectId, comic.assetId)).rejects.toMatchObject({
      status: 503, code: 'BUSY', reason: 'MAINTENANCE',
    });
    expect(closedAuthority).toEqual([]);
    // New requests authorize against the restored database.
    const fresh = await manifestOf(comic.base);
    expect((await getPage(fresh.pages[0].url)).status).toBe(200);
    expect(closedAuthority).toEqual([]);
  });

  it('refuses while a page request is queued; the awaited owner cancels it and nests correctly; then acquisition succeeds', async () => {
    const comic = addComic('Sync queued', 'book.cbz', makeZip([{ name: 'p1.jpg', data: img.jpeg }]), CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const opened = handles.opened;
    const held = holdAdmission();
    const queued = request(handler).get(pages[0].url).then((res) => res);
    await vi.waitFor(() => expect(runtime.admission.snapshot().queued).toBe(1));

    // A queued request is outstanding work: refused, and the refusal cancels nothing.
    expect(() => context.beginReplacement()).toThrow(COMIC_REFUSAL);
    expect(runtime.admission.snapshot().queued).toBe(1);
    const upload = tracker.begin();
    expect(upload).not.toBeNull();
    upload.complete();

    // The awaited path cancels the queued request and waits for its admission cleanup.
    const owner = await context.beginReplacementAfterRebuild();
    try {
      expectMaintenanceRefusal(await queued);
      expect(runtime.admission.snapshot()).toMatchObject({ queued: 0, active: runtime.admission.limits.maxActive });
      expect(handles.opened).toBe(opened);
      expect(context.comicMediaService.isIdle()).toBe(true);
      // Nested: a synchronous attempt while that owner holds is refused without disturbing it:
      // the owner stays valid, uploads stay closed and the graph's comic pause stays in force.
      expect(() => context.beginReplacement()).toThrow(/managed uploads or maintenance are active/);
      expect(() => tracker.assertMaintenanceOwner(owner, context.db)).not.toThrow();
      expectMaintenanceHeld(await request(handler).get(comic.base + '/comic'));
      expect(tracker.begin()).toBeNull();
      await expect(context.comicMediaService.getComicManifest(comic.projectId, comic.assetId))
        .rejects.toMatchObject({ status: 503, code: 'BUSY', reason: 'MAINTENANCE' });
    } finally {
      owner.release();
      await held.release();
    }
    expect(runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });

    // Idle: synchronous acquisition succeeds, pauses comics, and releasing resumes them.
    await settleBackgroundWork();
    const second = context.beginReplacement();
    expectMaintenanceHeld(await request(handler).get(comic.base + '/comic'));
    second.release();
    expect((await getPage(pages[0].url)).status).toBe(200);
    // Auth replacement through the synchronous path, now idle, still works.
    const app = context.app;
    await settleBackgroundWork();
    context.replaceAuthConfig(null);
    expect(context.app).not.toBe(app);
    expect(context.db).toBe(db);
    expect((await getPage(pages[0].url)).status).toBe(200);
    expect(closedAuthority).toEqual([]);
  });

  it('refuses while a rendition child is active; ownership follows only its confirmed termination', async () => {
    const width = 6000;
    const raw = Buffer.alloc(width * width * 3);
    for (let y = 0; y < width; y += 1) raw.fill((y * 13) & 0xff, y * width * 3, (y + 1) * width * 3);
    const costly = await sharp(raw, { raw: { width, height: width, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
    const comic = addComic('Sync rendition', 'book.cbz', makeZip([{ name: 'p1.png', data: costly }, { name: 'p2.jpg', data: img.jpeg }]), CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const reached = deferred();
    hooks.renditionPhase = ({ phase, position }) => { if (position === 1 && phase === 'stats') reached.resolve(); };
    const before = new Set(children.keys());
    const active = request(handler).get(pages[0].url).then((res) => res);
    await reached.promise;
    const pid = [...children.keys()].find((key) => !before.has(key));

    expect(() => context.beginReplacement()).toThrow(COMIC_REFUSAL);
    expect(children.get(pid).exited).toBe(false);

    const owner = await context.beginReplacementAfterRebuild();
    try {
      expectMaintenanceRefusal(await active);
      expect(children.get(pid).exited).toBe(true);
      expect(runtime.renditions.snapshot()).toMatchObject({ active: 0, terminating: 0 });
    } finally {
      owner.release();
    }
    hooks.renditionPhase = undefined;
    await settleBackgroundWork();
    const second = context.beginReplacement();
    second.release();
    expect((await getPage(pages[1].url)).status).toBe(200);
  });

  it('refuses while a background preparation runs; succeeds once it has settled', async () => {
    const comic = addComic('Sync background', 'book.cbr', cbr('comic-rar4-solid.cbr'), CBR_MIME);
    const { pages } = await manifestOf(comic.base);
    const cache = runtime.preparationCache;
    const entered = deferred();
    const gate = deferred();
    hooks.beforePrepare = async () => { entered.resolve(); await gate.promise; };
    expect((await getPage(pages[0].url)).status).toBe(200);
    await entered.promise;
    expect(runtime.admission.snapshot()).toMatchObject({ activeBackground: 1 });

    expect(() => context.beginReplacement()).toThrow(COMIC_REFUSAL);
    gate.resolve();
    await cache.whenIdle();
    hooks.beforePrepare = undefined;
    await vi.waitFor(() => expect(context.comicMediaService.isIdle()).toBe(true));
    expect(runtime.admission.snapshot()).toMatchObject({ active: 0, activeBackground: 0, reservedBytes: 0 });
    await settleBackgroundWork();
    const owner = context.beginReplacement();
    owner.release();
    expect((await manifestOf(comic.base)).preparation.state).toBe('ready');
  });
});

// ─── Auth configuration replacement ──────────────────────────────────────────────────────

describe('auth configuration replacement', () => {
  it('cancels the old graph\'s queued and active comic work and serves through the new graph', async () => {
    const comic = addComic('Auth', 'book.cbz', makeZip([{ name: 'p1.jpg', data: img.jpeg }, { name: 'p2.png', data: img.png }]), CBZ_MIME);
    const { pages } = await manifestOf(comic.base);
    const oldApp = context.app;
    const entered = deferred();
    const gate = deferred();
    hooks.afterRead = async (info) => {
      if (info.position !== 1) return;
      entered.resolve();
      await gate.promise;
    };
    const active = request(handler).get(pages[0].url).then((res) => res);
    await entered.promise;
    const held = holdAdmission();
    const queued = request(handler).get(pages[1].url).then((res) => res);
    await vi.waitFor(() => expect(runtime.admission.snapshot().queued).toBe(1));

    // The auth-transition service's sequence: owner after rebuild, replace, release.
    let settled = false;
    const owning = context.beginReplacementAfterRebuild().then((owner) => { settled = true; return owner; });
    expectMaintenanceRefusal(await queued);
    expect(settled).toBe(false);
    gate.resolve();
    expectMaintenanceRefusal(await active);
    const owner = await owning;
    try {
      context.replaceAuthConfig(null, owner);
    } finally {
      owner.release();
    }
    await held.release();
    hooks.afterRead = undefined;
    expect(context.app).not.toBe(oldApp);
    expect(context.db).toBe(db);
    await expect(oldApp.locals.comicMediaService.getComicPage(comic.projectId, comic.assetId, {
      revision: pages[0].url.split('v=')[1], position: 1,
    })).rejects.toMatchObject({ code: 'BUSY', reason: 'MAINTENANCE' });
    const page = await getPage(pages[0].url);
    expect(page.status).toBe(200);
    expect(page.body.equals(img.jpeg)).toBe(true);
  });
});
