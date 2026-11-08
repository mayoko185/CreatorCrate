// A3.3b-2 — solid preparation cache integrated with the comic media service.
// Real database, preview-service authority, secure asset-file path, A1 decoder workers,
// prepareSolidCbrCb7 staging and comic admission. Narrow wrappers only: descriptor open/close
// counting, decoder worker tracking (incl. the extraction requests posted to them), a
// staging-write failure switch (as on a failing disk), an image-inspection hook to act while a
// preparation verifies pages, and a ctime freeze for one file (as on a filesystem whose ctime
// does not reveal a rewrite).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import sharp from 'sharp';
import { makeZip } from './helpers/zip-fixture.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';
import { asLowerTrustActor, makePrivate, shareWithAuthenticatedUsers, unshare } from './helpers/windows-restricted-token.js';

// F7: on Windows every check of the cache path reads its ACLs through Windows PowerShell
// (about half a second each), so this file needs more than the default time per test there.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 });

const tracked = vi.hoisted(() => ({
  opened: [], closed: 0, workers: [], posted: [], onWorker: null, inspect: null, readOnlyPack: false, frozenCtime: null,
  // Filesystem fault injection (F2): failRm(directory) makes the removal of that staging
  // directory fail with EIO (its pack unlink and its rmdir; as on a failing disk); failSeal makes
  // sealing the finished pack (chmod 0400) fail, after every page was written. rmCalls counts
  // removal attempts per staging directory (each removal starts by unlinking its pack).
  failRm: null, failSeal: false, rmCalls: new Map(),
  // F6: onRemove(directory) runs as a removal starts (before the pack unlink), afterRemove(directory)
  // after its rmdir: to change the filesystem deterministically in the middle of a removal.
  onRemove: null, afterRemove: null, mountInfo: null,
  trustReads: 0, trustReading: null,
  // failLstat(path) (F4): return an error code to make fs.promises.lstat of that path fail with
  // it (as on a failing disk or a denied directory); anything falsy lets the real lstat run.
  failLstat: null,
  // Reports the frozen ctime for the frozen file (bigint stats only, as the service reads them).
  freeze(stat, file) {
    const frozen = tracked.frozenCtime;
    if (frozen && typeof stat?.ctimeNs === 'bigint' && String(file).toLowerCase() === frozen.file.toLowerCase()) {
      stat.ctimeNs = frozen.ctimeNs;
    }
    return stat;
  },
}));

vi.mock('../src/services/windows-directory-trust.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async readWindowsDirectorySecurity(directories) {
      tracked.trustReads += 1;
      const reading = await actual.readWindowsDirectorySecurity(directories);
      return tracked.trustReading ? tracked.trustReading(reading) : reading;
    },
  };
});

vi.mock('../src/storage/asset-file.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openAssetFileAsync: async (...args) => {
      const opened = await actual.openAssetFileAsync(...args);
      tracked.opened.push(opened.handle);
      const stat = opened.handle.stat.bind(opened.handle);
      opened.handle.stat = async (options) => tracked.freeze(await stat(options), opened.absolutePath);
      return opened;
    },
    closeAssetFileAsync: async (opened) => {
      tracked.closed += 1;
      return actual.closeAssetFileAsync(opened);
    },
  };
});

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal();
  class TrackedWorker extends actual.Worker {
    constructor(...args) {
      super(...args);
      tracked.workers.push(this);
      tracked.onWorker?.(this);
    }

    postMessage(message, ...rest) {
      tracked.posted.push(message?.type);
      return super.postMessage(message, ...rest);
    }
  }
  return { ...actual, Worker: TrackedWorker };
});

vi.mock('../src/services/cbz-page-reader.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async inspectImage(...args) {
      if (tracked.inspect) await tracked.inspect();
      return actual.inspectImage(...args);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const open = (file, flags, mode) => {
    if (tracked.readOnlyPack && String(file).endsWith('pages.bin') && typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
      return actual.open(file, (flags & ~fs.constants.O_RDWR) | fs.constants.O_RDONLY, mode);
    }
    return actual.open(file, flags, mode);
  };
  const removalFailure = (key) => Object.assign(new Error('EIO: i/o error, remove ' + key), { code: 'EIO' });
  const unlink = async (file) => {
    if (path.basename(String(file)) === 'pages.bin') {
      const key = path.dirname(String(file));
      tracked.rmCalls.set(key, (tracked.rmCalls.get(key) ?? 0) + 1);
      await tracked.onRemove?.(key);
      if (tracked.failRm?.(key)) throw removalFailure(key);
    }
    return actual.unlink(file);
  };
  const rmdir = async (file, options) => {
    const key = String(file);
    if (tracked.failRm?.(key)) throw removalFailure(key);
    try {
      return await actual.rmdir(file, options);
    } finally {
      await tracked.afterRemove?.(key);
    }
  };
  const chmod = async (file, mode) => {
    if (tracked.failSeal && mode === 0o400 && String(file).endsWith('pages.bin')) {
      throw Object.assign(new Error('EIO: i/o error, chmod'), { code: 'EIO' });
    }
    return actual.chmod(file, mode);
  };
  const lstat = async (file, options) => {
    const code = tracked.failLstat?.(String(file));
    if (code) throw Object.assign(new Error(code + ': lstat ' + String(file)), { code });
    return actual.lstat(file, options);
  };
  // F5 (Linux): mountInfo(text) rewrites (or, by throwing, fails) the process mount table.
  const readFile = async (file, options) => {
    if (tracked.mountInfo && String(file) === '/proc/self/mountinfo') return tracked.mountInfo(await actual.readFile(file, options));
    return actual.readFile(file, options);
  };
  const mocked = { open, unlink, rmdir, chmod, lstat, readFile };
  return { ...actual, ...mocked, default: { ...actual, ...mocked } };
});

const { openDatabase, runMigrations, closeDatabase } = await import('../src/db.js');
const { createProjectRepository } = await import('../src/data/project-repository.js');
const { createAssetRepository } = await import('../src/data/asset-repository.js');
const { formatProjectDirName } = await import('../src/storage/project-storage.js');
const { createPreviewService } = await import('../src/services/preview-service.js');
const { MediaError } = await import('../src/services/media-service.js');
const { createComicMediaService } = await import('../src/services/comic-media-service.js');
const { createComicAdmission, estimateComicOperationBytes } = await import('../src/services/comic-admission.js');
const { createComicPreparationCache, defaultComicPreparationCacheRoot, COMIC_PREPARATION_CACHE_DEFAULTS } = await import('../src/services/comic-preparation-cache.js');

const SevenZip = createRequire(import.meta.url)('7z-wasm');
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const MIB = 1024 * 1024;

const img = {};

beforeAll(async () => {
  const gradient = (width, height, seed) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7 + seed) & 0xff;
    return sharp(raw, { raw: { width, height, channels: 3 } });
  };
  img.jpeg = await gradient(48, 64, 10).jpeg().toBuffer();
  img.png = await gradient(48, 64, 20).png({ compressionLevel: 0 }).toBuffer();
  img.webp = await gradient(48, 64, 30).webp({ lossless: true }).toBuffer();
  img.noise = async (seed) => {
    const raw = Buffer.alloc(64 * 64 * 3);
    let value = seed;
    for (let i = 0; i < raw.length; i += 1) {
      value = (value * 1103515245 + 12345) >>> 0;
      raw[i] = value >>> 24;
    }
    return sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  };
});

async function make7z(entries, switches = ['-ms=on']) {
  const module = await SevenZip({ print() {}, printErr() {} });
  module.FS.mkdirTree('/w');
  module.FS.chdir('/w');
  for (const [name, data] of entries) module.FS.writeFile('/w/' + name, data);
  const code = module.callMain(['a', '-t7z', '-mtc=off', '-mta=off', '-mtm=off', '-mmt=1', '-bsp0', '-bso0', '-bse0',
    ...switches, '/out.7z', ...entries.map(([name]) => name)]);
  if (code !== 0) throw new Error('7z-wasm failed with ' + code);
  return Buffer.from(module.FS.readFile('/out.7z'));
}

const cb7Pages = () => [['b.png', img.png], ['a.jpg', img.jpeg], ['c.webp', img.webp]];

let h;

function makeHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-comic-prep-cache-'));
  // F7: a test-owned directory nobody else can rename or write into (as a private per-user
  // folder is), whatever the system temporary directory itself grants other principals.
  if (process.platform === 'win32') makePrivate(tmpDir);
  const projectsRoot = path.join(tmpDir, 'projects');
  const previewRoot = path.join(tmpDir, 'app', 'previews');
  const cacheRoot = path.join(tmpDir, 'app', 'comic-preparations');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(previewRoot, { recursive: true });
  const db = openDatabase(path.join(tmpDir, 'test.db'));
  runMigrations(db, MIGRATIONS_DIR);
  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);
  const previewService = createPreviewService({ db, projectsRoot, previewRoot });
  const clock = { offset: 0 };
  const caches = [];

  function makeCache(options = {}) {
    const cache = createComicPreparationCache({ stagingRoot: cacheRoot, protectedRoots: [projectsRoot], settleMs: 0, _now: () => Date.now() + clock.offset, ...options });
    caches.push(cache);
    return cache;
  }

  function makeService({ cache, admission, ...options } = {}) {
    return createComicMediaService({ previewService, projectsRoot, admission, preparationCache: cache, ...options });
  }

  let projects = 0;
  function addComic(bytes, extension = 'cbr') {
    projects += 1;
    const title = 'Comic ' + projects;
    let project = projectRepo.create({
      title, projectType: 'images', slug: slugify(title, { lowercase: true }), description: '', notes: '',
      status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
    });
    const relDir = formatProjectDirName(project.id, project.slug);
    const absPath = path.resolve(projectsRoot, relDir);
    fs.mkdirSync(absPath, { recursive: true });
    project = projectRepo.setProjectDir(project.id, relDir);
    bindTestProjectOwnership(db, project.id, absPath);
    const comic = { project, absPath, file: 'book.' + extension, full: path.join(absPath, 'book.' + extension) };
    comic.write = (data) => {
      fs.writeFileSync(comic.full, data);
      comic.reindex();
    };
    // Upserts the row from the file as it is now (as a scan would).
    comic.reindex = () => {
      const stat = fs.statSync(comic.full);
      comic.asset = assetRepo.upsert(project.id, comic.file, {
        filename: comic.file, extension, mimeType: 'application/octet-stream',
        sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
      });
      comic.id = [project.id, comic.asset.id];
    };
    comic.write(bytes);
    return comic;
  }

  return {
    tmpDir, projectsRoot, cacheRoot, db, clock, makeCache, makeService, addComic,
    staged: () => (fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []),
    async cleanup() {
      for (const cache of caches) await cache.close();
      closeDatabase(db);
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
}

const fixture = (name) => fs.readFileSync(path.join(COMICS, name));

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

async function failure(promise) {
  const caught = await promise.then(() => null, (err) => err);
  expect(caught).toBeInstanceOf(MediaError);
  return caught;
}

// Since the worker counts were taken: `requests` cache-served requests started exactly one
// decoder worker each (the catalog listing) and none was asked to extract anything.
function expectListingOnly(workers, posted, requests = 1) {
  expect(tracked.workers.length - workers).toBe(requests);
  expect(tracked.posted.slice(posted).filter((type) => type === 'extract' || type === 'extractBatch')).toEqual([]);
}

// A cache and a service sharing one admission; `prepared` counts preparations that started.
async function setup({ cacheOptions, admission = createComicAdmission(), hooks = {} } = {}) {
  const cache = h.makeCache(cacheOptions);
  await cache.recover();
  const counts = { prepared: 0 };
  const service = h.makeService({
    cache,
    admission,
    _hooks: {
      ...hooks,
      beforePrepare: async (info) => {
        counts.prepared += 1;
        await hooks.beforePrepare?.(info);
      },
    },
  });
  return { cache, service, admission, counts };
}

// Reads one page on demand (which schedules the preparation) and waits for the preparation.
async function prepare(service, cache, comic) {
  const { revision } = await service.getComicManifest(...comic.id);
  const first = await service.getComicPage(...comic.id, { revision, position: 1 });
  expect(first.prepared).toBe(false);
  await cache.whenIdle();
  return revision;
}

beforeEach(() => {
  tracked.opened.length = 0;
  tracked.closed = 0;
  tracked.workers.length = 0;
  tracked.posted.length = 0;
  tracked.onWorker = null;
  tracked.inspect = null;
  tracked.readOnlyPack = false;
  tracked.frozenCtime = null;
  tracked.failRm = null;
  tracked.failSeal = false;
  tracked.failLstat = null;
  tracked.onRemove = null;
  tracked.afterRemove = null;
  tracked.mountInfo = null;
  tracked.trustReads = 0;
  tracked.trustReading = null;
  tracked.rmCalls.clear();
  h = makeHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  tracked.frozenCtime = null;
  tracked.failRm = null;
  tracked.failSeal = false;
  tracked.failLstat = null;
  tracked.onRemove = null;
  tracked.afterRemove = null;
  tracked.mountInfo = null;
  tracked.trustReading = null;
  await h.cleanup();
  expect(tracked.closed).toBe(tracked.opened.length);
  for (const handle of tracked.opened) expect(handle.fd).toBe(-1);
});

describe('solid preparation and reuse', () => {
  it.each([
    ['comic-rar4-solid.cbr', 'cbr'],
    ['comic-rar5-solid.cbr', 'cbr'],
    ['cb7', 'cb7'],
  ])('prepares a solid %s comic once and serves verified pages without decoding again', async (name, extension) => {
    const { cache, service, counts } = await setup();
    const bytes = name === 'cb7' ? await make7z(cb7Pages()) : fixture(name);
    const comic = h.addComic(bytes, extension);
    const manifest = await service.getComicManifest(...comic.id);
    expect(manifest.preparation).toEqual({ solid: true, state: 'on-demand' });
    // A manifest alone never prepares anything.
    expect(cache.snapshot()).toMatchObject({ pending: 0, entries: 0 });

    const revision = await prepare(service, cache, comic);
    expect(counts.prepared).toBe(1);
    expect(cache.snapshot()).toMatchObject({ entries: 1, pending: 0, readers: 0, reservedBytes: 0 });
    expect((await service.getComicManifest(...comic.id)).preparation.state).toBe('ready');
    const [directory] = h.staged();
    expect(h.staged()).toEqual([directory]);
    expect(fs.readdirSync(path.join(h.cacheRoot, directory))).toEqual(['pages.bin']);

    // Every page now comes from the preparation: no decoder worker starts, and the pages equal
    // what an on-demand read of the same revision returns.
    const onDemand = h.makeService();
    const outcome = (promise) => promise.then(
      (page) => ({ ...page, bytes: page.bytes.toString('base64'), prepared: null }),
      (err) => ({ status: err.status, code: err.code, reason: err.reason }));
    let served = 0;
    for (const page of manifest.pages) {
      const workers = tracked.workers.length;
      const posted = tracked.posted.length;
      const request = { revision, position: page.position };
      const cached = await service.getComicPage(...comic.id, request).catch((err) => err);
      if (cached.prepared) served += 1;
      // Ready pages and image-level error slots are answered after one bounded catalog listing
      // (freshness proof) and never extract or decode the solid stream again.
      expectListingOnly(workers, posted);
      const fromCache = await outcome(service.getComicPage(...comic.id, request));
      const direct = await outcome(onDemand.getComicPage(...comic.id, request));
      expect(fromCache).toEqual(direct);
    }
    expect(served).toBe(name === 'cb7' ? 3 : 5);
    expect(counts.prepared).toBe(1);
  });

  it('keeps the numbered error positions of a solid comic, from the cache and on demand', async () => {
    const { cache, service } = await setup();
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    const workers = tracked.workers.length;
    const posted = tracked.posted.length;
    // Position 5 is text named .png: the preparation's own verdict, served without decoding.
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 5 })))
      .toMatchObject({ status: 422, code: 'PAGE_UNAVAILABLE', reason: 'PAGE_INVALID_IMAGE' });
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 7 })))
      .toMatchObject({ status: 404, code: 'PAGE_NOT_FOUND' });
    expectListingOnly(workers, posted, 2);
    expect((await service.getComicPage(...comic.id, { revision, position: 6 })).position).toBe(6);

    // A solid stream broken mid-way: verified pages come from the cache, the corrupt ones are
    // decided on demand and keep their numbers.
    const pages = [];
    for (let index = 1; index <= 6; index += 1) pages.push(['page' + index + '.png', await img.noise(index)]);
    const archive = await make7z(pages, ['-ms=on', '-mx=1']);
    archive[Math.floor(archive.length * 0.6)] ^= 0x55;
    const broken = h.addComic(archive, 'cb7');
    const brokenRevision = await prepare(service, cache, broken);
    const outcomes = [];
    for (let position = 1; position <= 6; position += 1) {
      const result = await service.getComicPage(...broken.id, { revision: brokenRevision, position })
        .then((page) => (page.prepared ? 'prepared' : 'on-demand'), (err) => err.reason);
      outcomes.push(result);
    }
    expect(outcomes[0]).toBe('prepared');
    expect(outcomes.at(-1)).toBe('PAGE_CORRUPT');
    const firstCorrupt = outcomes.indexOf('PAGE_CORRUPT');
    expect(outcomes.slice(0, firstCorrupt).every((outcome) => outcome === 'prepared')).toBe(true);
    expect(outcomes.slice(firstCorrupt).every((outcome) => outcome === 'PAGE_CORRUPT')).toBe(true);
  });

  it('never prepares CBZ or non-solid CBR/CB7 comics', async () => {
    const { cache, service, counts } = await setup();
    const comics = [
      h.addComic(makeZip([{ name: 'p1.jpg', data: img.jpeg }, { name: 'p2.png', data: img.png }]), 'cbz'),
      h.addComic(fixture('comic-rar5.cbr')),
      h.addComic(fixture('comic-rar4.cbr')),
      h.addComic(await make7z(cb7Pages(), ['-ms=off']), 'cb7'),
    ];
    for (const comic of comics) {
      const manifest = await service.getComicManifest(...comic.id);
      expect(manifest.preparation).toEqual({ solid: false, state: 'not-required' });
      for (const position of [1, 2]) {
        expect((await service.getComicPage(...comic.id, { revision: manifest.revision, position })).prepared).toBe(false);
      }
    }
    await cache.whenIdle();
    expect(counts.prepared).toBe(0);
    expect(cache.snapshot()).toMatchObject({ entries: 0, pending: 0, failures: 0 });
    expect(h.staged()).toEqual([]);
  });
});

describe('foreground reads, deduplication and admission', () => {
  it('serves pages on demand while a preparation runs, then from the cache', async () => {
    const hold = gate();
    const started = gate();
    const { cache, service, admission } = await setup({
      hooks: { beforePrepare: async () => { started.open(); await hold.promise; } },
    });
    const comic = h.addComic(fixture('comic-rar4-solid.cbr'));
    const { revision } = await service.getComicManifest(...comic.id);
    expect((await service.getComicPage(...comic.id, { revision, position: 1 })).prepared).toBe(false);
    await started.promise;
    expect(admission.snapshot()).toMatchObject({ activeBackground: 1 });
    expect((await service.getComicManifest(...comic.id)).preparation.state).toBe('preparing');

    // Foreground pages never wait for the preparation.
    const pages = await Promise.all([2, 3, 6].map((position) => service.getComicPage(...comic.id, { revision, position })));
    expect(pages.map((page) => [page.position, page.prepared])).toEqual([[2, false], [3, false], [6, false]]);

    hold.open();
    await cache.whenIdle();
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
    expect(admission.snapshot()).toMatchObject({ active: 0, activeBackground: 0, reservedBytes: 0 });
  });

  it('shares one preparation among all consumers of a revision, even when one cancels', async () => {
    const hold = gate();
    const { cache, service, counts } = await setup({ hooks: { beforePrepare: () => hold.promise } });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const { revision } = await service.getComicManifest(...comic.id);
    const controllers = [1, 2, 3, 6].map(() => new AbortController());
    const pages = await Promise.all([1, 2, 3, 6].map((position, index) =>
      service.getComicPage(...comic.id, { revision, position, signal: controllers[index].signal })));
    expect(pages.every((page) => !page.prepared)).toBe(true);
    // The first consumer goes away; the preparation belongs to the cache and continues.
    controllers[0].abort();
    expect((await service.getComicPage(...comic.id, { revision, position: 4 })).prepared).toBe(false);
    expect(cache.snapshot()).toMatchObject({ pending: 1 });
    hold.open();
    await cache.whenIdle();
    expect(counts.prepared).toBe(1);
    expect(cache.snapshot()).toMatchObject({ entries: 1, pending: 0 });
    expect((await service.getComicPage(...comic.id, { revision, position: 1 })).prepared).toBe(true);
  });

  it('runs one background preparation at a time and bounds pending ones', async () => {
    const hold = gate();
    const started = gate();
    let peak = 0;
    const admission = createComicAdmission();
    const { cache, service, counts } = await setup({
      admission,
      cacheOptions: { maxPending: 2 },
      hooks: {
        beforePrepare: async () => {
          peak = Math.max(peak, admission.snapshot().activeBackground);
          started.open();
          await hold.promise;
        },
      },
    });
    const comics = [1, 2, 3].map(() => h.addComic(fixture('comic-rar4-solid.cbr')));
    const handlesBefore = [];
    for (const comic of comics) {
      const { revision } = await service.getComicManifest(...comic.id);
      await service.getComicPage(...comic.id, { revision, position: 1 });
      handlesBefore.push(tracked.opened.length);
    }
    // One preparation runs, one waits in the background lane (holding no descriptor), the third
    // request was not queued at all.
    await started.promise;
    try {
      expect(admission.snapshot()).toMatchObject({ activeBackground: 1, queuedBackground: 1 });
      expect(cache.snapshot()).toMatchObject({ pending: 2 });
      expect(tracked.opened.length - tracked.closed).toBe(1);
    } finally {
      hold.open();
    }
    await cache.whenIdle();
    expect(peak).toBe(1);
    expect(counts.prepared).toBe(2);
    expect(cache.snapshot()).toMatchObject({ entries: 2, pending: 0 });
    expect(admission.snapshot()).toMatchObject({ active: 0, queuedBackground: 0, reservedBytes: 0 });
  });
});

describe('failures and fallback', () => {
  it('falls back to on-demand reads after a disk failure and backs off before retrying', async () => {
    const { cache, service, counts } = await setup({
      cacheOptions: { retryBaseMs: 60_000 },
      hooks: { beforePrepare: () => { tracked.readOnlyPack = counts.prepared === 1; } },
    });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    expect(cache.snapshot()).toMatchObject({ entries: 0, failures: 1 });
    expect(h.staged()).toEqual([]);
    // Pages stay readable; the failed revision is not prepared again on every request.
    for (const position of [2, 3]) {
      expect((await service.getComicPage(...comic.id, { revision, position })).prepared).toBe(false);
    }
    await cache.whenIdle();
    expect(counts.prepared).toBe(1);
    // After the backoff one retry runs (the disk is healthy again).
    h.clock.offset += 61_000;
    await service.getComicPage(...comic.id, { revision, position: 2 });
    await cache.whenIdle();
    expect(counts.prepared).toBe(2);
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
  });

  it('removes all staging after a timeout or a terminated decoder worker', async () => {
    const workerSettled = async () => {
      for (const worker of tracked.workers) {
        if (worker.threadId !== -1) await new Promise((resolve) => worker.once('exit', resolve));
      }
    };
    const scenarios = {
      timeout: () => { tracked.inspect = () => new Promise((resolve) => setTimeout(resolve, 1600)); },
      terminated: () => {
        let done = false;
        tracked.inspect = async () => {
          if (done) return;
          done = true;
          await tracked.workers.at(-1).terminate();
        };
      },
    };
    let scenario = null;
    const { cache, service } = await setup({
      cacheOptions: { preparationTimeoutMs: 1500 },
      hooks: { beforePrepare: () => scenarios[scenario]() },
    });
    for (scenario of Object.keys(scenarios)) {
      const comic = h.addComic(await make7z(cb7Pages()), 'cb7');
      const revision = await prepare(service, cache, comic);
      tracked.inspect = null;
      expect(cache.snapshot()).toMatchObject({ entries: 0, pending: 0, reservedBytes: 0 });
      expect(h.staged()).toEqual([]);
      expect((await service.getComicPage(...comic.id, { revision, position: 3 })).prepared).toBe(false);
    }
    expect(cache.snapshot().failures).toBe(2);
    await workerSettled();
  });

  it('does not prepare a revision over the size limits', async () => {
    const { cache, service, counts } = await setup({ cacheOptions: { maxPreparedBytes: 1000 } });
    const comic = h.addComic(fixture('comic-rar4-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    await service.getComicPage(...comic.id, { revision, position: 2 });
    expect(counts.prepared).toBe(0);
    expect(cache.snapshot()).toMatchObject({ entries: 0, failures: 1 });
  });
});

describe('source identity', () => {
  async function prepared(comicBytes = fixture('comic-rar5-solid.cbr')) {
    const context = await setup();
    const comic = h.addComic(comicBytes);
    const revision = await prepare(context.service, context.cache, comic);
    expect(context.cache.snapshot().entries).toBe(1);
    return { ...context, comic, revision };
  }

  it('never serves a preparation after the source is replaced and re-indexed', async () => {
    const { cache, service, comic, revision } = await prepared();
    comic.write(fixture('comic-rar4-solid.cbr'));
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 1 }))).toMatchObject({ code: 'REVISION_STALE' });
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0 });
    expect(h.staged()).toEqual([]);
    const fresh = await service.getComicManifest(...comic.id);
    expect(fresh.revision).not.toBe(revision);
    expect(fresh.preparation.state).toBe('on-demand');
    expect((await service.getComicPage(...comic.id, { revision: fresh.revision, position: 1 })).prepared).toBe(false);
  });

  it('never serves a preparation after a source-generation change', async () => {
    const { cache, service, comic, revision } = await prepared();
    h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(comic.asset.id);
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 1 }))).toMatchObject({ code: 'REVISION_STALE' });
    await cache.whenIdle();
    expect(cache.snapshot().entries).toBe(0);
    const fresh = await service.getComicManifest(...comic.id);
    expect((await service.getComicPage(...comic.id, { revision: fresh.revision, position: 1 })).prepared).toBe(false);
  });

  it('never serves a preparation after an in-place rewrite that keeps size, inode and mtime', async () => {
    const { cache, service, comic, revision } = await prepared();
    const before = fs.statSync(comic.full, { bigint: true });
    const dates = fs.statSync(comic.full);
    const bytes = fs.readFileSync(comic.full);
    const fd = fs.openSync(comic.full, 'r+');
    try { fs.writeSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
    fs.utimesSync(comic.full, dates.atime, dates.mtime);
    const after = fs.statSync(comic.full, { bigint: true });
    expect([after.ino, after.size]).toEqual([before.ino, before.size]);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    // The indexed row still matches (size and millisecond mtime), but the identity does not.
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 1 }))).toMatchObject({ code: 'REVISION_STALE' });
    await cache.whenIdle();
    expect(cache.snapshot().entries).toBe(0);
  });

  it('does not prepare a source that changed within the settle window', async () => {
    const { cache, service, counts } = await setup({ cacheOptions: { settleMs: 60_000 } });
    const comic = h.addComic(fixture('comic-rar4-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    expect(counts.prepared).toBe(0);
    expect(cache.snapshot()).toMatchObject({ pending: 0, failures: 0 });
    h.clock.offset += 61_000;
    await service.getComicPage(...comic.id, { revision, position: 2 });
    await cache.whenIdle();
    expect(counts.prepared).toBe(1);
    expect(cache.snapshot().entries).toBe(1);
  });

  it('detects tampered prepared pages, retires them and reads on demand', async () => {
    const { cache, service, comic, revision, counts } = await prepared();
    const [directory] = h.staged();
    const pack = path.join(h.cacheRoot, directory, 'pages.bin');
    fs.chmodSync(pack, 0o600);
    const content = fs.readFileSync(pack);
    for (let i = 0; i < content.length; i += 1) content[i] ^= 0x01;
    fs.writeFileSync(pack, content);
    const direct = await h.makeService().getComicPage(...comic.id, { revision, position: 1 });
    const page = await service.getComicPage(...comic.id, { revision, position: 1 });
    expect(page.prepared).toBe(false);
    expect(page.bytes.equals(direct.bytes)).toBe(true);
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 0, failures: 1 });
    expect(h.staged()).toEqual([]);
    // Not prepared again straight away.
    await service.getComicPage(...comic.id, { revision, position: 2 });
    await cache.whenIdle();
    expect(counts.prepared).toBe(1);
  });
});

describe('catalog freshness of cached pages (F1)', () => {
  const tinyPage = (r, g, b) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toBuffer();
  const SECOND = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

  // Two valid solid CB7s of exactly the same size, same member names, different pixels (the
  // reviewer's case). 7-Zip output is deterministic, so the search always finds the same pair.
  async function equalSizedPair() {
    const seen = new Map();
    for (let seed = 1; seed <= 16; seed += 1) {
      const pages = [await tinyPage(seed * 20, 0, 0), await tinyPage(0, seed * 20, 0)];
      const archive = await make7z([['1.png', pages[0]], ['2.png', pages[1]]], ['-ms=on']);
      const twin = seen.get(archive.length);
      if (twin) return [twin, { archive, pages }];
      seen.set(archive.length, { archive, pages });
    }
    throw new Error('no equal-sized pair');
  }

  // As on a filesystem whose ctime does not reveal a rewrite: the service's bigint stats (the
  // opened descriptor's and the path's) report the file's current ctime from now on.
  function freezeCtime(comic) {
    tracked.frozenCtime = { file: comic.full, ctimeNs: fs.statSync(comic.full, { bigint: true }).ctimeNs };
    const stat = fs.promises.stat;
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (file, options) => tracked.freeze(await stat(file, options), file));
  }

  // Rewrites the archive in place (same inode, same size), restores the whole-second mtime and
  // re-upserts the row, which leaves source_generation unchanged.
  function replaceKeepingMetadata(comic, bytes) {
    fs.writeFileSync(comic.full, bytes);
    fs.utimesSync(comic.full, SECOND, SECOND);
    comic.reindex();
  }

  const identityOf = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  const generationOf = (comic) => h.db.prepare('SELECT source_generation FROM assets WHERE id = ?').get(comic.asset.id).source_generation;

  async function preparedPair(hooks) {
    const [before, after] = await equalSizedPair();
    expect(before.archive.length).toBe(after.archive.length);
    expect(before.archive.equals(after.archive)).toBe(false);
    const counts = { checked: 0 };
    const context = await setup({ hooks: { ...hooks, catalogChecked: () => { counts.checked += 1; } } });
    const comic = h.addComic(before.archive, 'cb7');
    fs.utimesSync(comic.full, SECOND, SECOND);
    comic.reindex();
    const revision = await prepare(context.service, context.cache, comic);
    expect((await context.service.getComicManifest(...comic.id)).preparation).toEqual({ solid: true, state: 'ready' });
    const cached = await context.service.getComicPage(...comic.id, { revision, position: 1 });
    expect(cached).toMatchObject({ prepared: true });
    expect(cached.bytes.equals(before.pages[0])).toBe(true);
    expect(counts.checked).toBe(1);
    return { ...context, comic, revision, before, after, counts };
  }

  function expectReleased({ cache, admission }) {
    expect(cache.snapshot()).toMatchObject({ readers: 0, reservedBytes: 0 });
    expect(admission.snapshot()).toEqual({ active: 0, activeBackground: 0, reservedBytes: 0, queued: 0, queuedBackground: 0 });
    expect(tracked.closed).toBe(tracked.opened.length);
  }

  it('refuses an old revision after an equal-sized replacement that keeps inode, size, mtime and ctime', async () => {
    const context = await preparedPair();
    const { cache, service, comic, revision, before, after, counts } = context;
    const generation = generationOf(comic);
    freezeCtime(comic);
    const statBefore = fs.statSync(comic.full, { bigint: true });
    replaceKeepingMetadata(comic, after.archive);
    // Every metadata signal the service can see is unchanged, and so is the indexed row.
    expect(identityOf(tracked.freeze(fs.statSync(comic.full, { bigint: true }), comic.full))).toEqual(identityOf(statBefore));
    expect(generationOf(comic)).toBe(generation);
    expect(cache.snapshot().entries).toBe(1);

    // The cache hit now proves the catalog and answers as an on-demand read of that revision.
    for (const position of [1, 2]) {
      expect(await failure(service.getComicPage(...comic.id, { revision, position })))
        .toMatchObject({ status: 409, code: 'REVISION_STALE' });
    }
    expect(counts.checked).toBe(2);
    expect(await failure(h.makeService().getComicPage(...comic.id, { revision, position: 1 })))
      .toMatchObject({ status: 409, code: 'REVISION_STALE' });
    // The stale preparation was retired and removed; nothing leaked.
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0 });
    expect(h.staged()).toEqual([]);
    expectReleased(context);

    // Only the catalog half changed: the identity evidence could not have caught it.
    const fresh = await service.getComicManifest(...comic.id);
    expect(fresh.revision).not.toBe(revision);
    expect(fresh.revision.slice(0, 16)).toBe(revision.slice(0, 16));
    expect(fresh.preparation.state).toBe('on-demand');

    // The new revision reads the new pixels (on demand, then from its own preparation).
    const first = await service.getComicPage(...comic.id, { revision: fresh.revision, position: 1 });
    expect(first.prepared).toBe(false);
    expect(first.bytes.equals(after.pages[0])).toBe(true);
    await cache.whenIdle();
    const second = await service.getComicPage(...comic.id, { revision: fresh.revision, position: 2 });
    expect(second.prepared).toBe(true);
    expect(second.bytes.equals(after.pages[1])).toBe(true);
    expect(second.bytes.equals(before.pages[1])).toBe(false);

    // The old revision never switches to the new pages, from the cache or on demand.
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 2 })))
      .toMatchObject({ code: 'REVISION_STALE' });
    expect(cache.snapshot().entries).toBe(1);
    expectReleased(context);
  });

  it('publishes nothing when the archive changes undetectably while a cached page is rendered', async () => {
    let during = null;
    const context = await preparedPair({ afterRead: () => during?.() });
    const { cache, service, comic, revision, after } = context;
    freezeCtime(comic);
    during = () => {
      during = null;
      replaceKeepingMetadata(comic, after.archive);
    };
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 2 })))
      .toMatchObject({ status: 409, code: 'REVISION_STALE' });
    expect(during).toBeNull();
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0 });
    expect(h.staged()).toEqual([]);
    expectReleased(context);
    const fresh = await service.getComicManifest(...comic.id);
    expect((await service.getComicPage(...comic.id, { revision: fresh.revision, position: 2 })).bytes.equals(after.pages[1])).toBe(true);
  });

  it('keeps an unchanged preparation when its catalog check is cancelled', async () => {
    const context = await preparedPair();
    const { service, comic, revision, before, counts } = context;
    // Cancel while the catalog listing worker runs.
    const controller = new AbortController();
    tracked.onWorker = () => {
      tracked.onWorker = null;
      controller.abort();
    };
    expect(await failure(service.getComicPage(...comic.id, { revision, position: 2, signal: controller.signal })))
      .toMatchObject({ code: 'CANCELLED' });
    expect(counts.checked).toBe(1);
    expectReleased(context);
    // Cancelled after the listing: the same.
    const late = new AbortController();
    const lateService = h.makeService({ cache: context.cache, admission: context.admission, _hooks: { catalogChecked: () => late.abort() } });
    expect(await failure(lateService.getComicPage(...comic.id, { revision, position: 2, signal: late.signal })))
      .toMatchObject({ code: 'CANCELLED' });
    expectReleased(context);
    // Neither cancellation retired the preparation of the unchanged archive.
    const page = await service.getComicPage(...comic.id, { revision, position: 2 });
    expect(page.prepared).toBe(true);
    expect(page.bytes.equals(before.pages[1])).toBe(true);
    expect(context.cache.snapshot().entries).toBe(1);
  });
});

describe('capacity, eviction and lifetime', () => {
  it('evicts the least recently used preparations by entry count and by bytes', async () => {
    const { cache, service } = await setup({ cacheOptions: { maxEntries: 2 } });
    const [a, b, c] = [1, 2, 3].map(() => h.addComic(fixture('comic-rar5-solid.cbr')));
    const revisions = [];
    revisions.push(await prepare(service, cache, a));
    h.clock.offset += 1000;
    revisions.push(await prepare(service, cache, b));
    h.clock.offset += 1000;
    // Reading A makes B the least recently used.
    expect((await service.getComicPage(...a.id, { revision: revisions[0], position: 2 })).prepared).toBe(true);
    h.clock.offset += 1000;
    revisions.push(await prepare(service, cache, c));
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 2, retiring: 0 });
    expect(h.staged()).toHaveLength(2);
    expect((await service.getComicManifest(...a.id)).preparation.state).toBe('ready');
    expect((await service.getComicManifest(...b.id)).preparation.state).toBe('on-demand');
    const bytes = cache.snapshot().retainedBytes / 2;
    await cache.close();

    // Byte budget for two preparations: preparing a third evicts the least recently used.
    const byBytes = await setup({ cacheOptions: { maxTotalBytes: bytes * 2 + 100 } });
    for (const [index, comic] of [a, b, c].entries()) {
      h.clock.offset += 1000;
      await prepare(byBytes.service, byBytes.cache, comic);
      expect(byBytes.cache.snapshot().usedBytes).toBeLessThanOrEqual(bytes * 2 + 100);
      expect(byBytes.cache.snapshot().entries).toBe(Math.min(index + 1, 2));
    }
    expect((await byBytes.service.getComicManifest(...a.id)).preparation.state).toBe('on-demand');
    expect((await byBytes.service.getComicManifest(...c.id)).preparation.state).toBe('ready');
    expect(h.staged()).toHaveLength(2);
  });

  it('never removes a preparation while a read depends on it', async () => {
    let during = null;
    const { cache, service } = await setup({ hooks: { preparedRead: () => during?.() } });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    let closing;
    during = async () => {
      during = null;
      // Idle expiry and shutdown both arrive while this read holds the preparation.
      h.clock.offset += COMIC_PREPARATION_CACHE_DEFAULTS.idleMs * 2;
      await cache.sweep();
      expect(cache.snapshot()).toMatchObject({ entries: 1, readers: 1 });
      closing = cache.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 1, readers: 1 });
      expect(h.staged()).toHaveLength(1);
    };
    const page = await service.getComicPage(...comic.id, { revision, position: 6 });
    expect(page.prepared).toBe(true);
    await closing;
    expect(h.staged()).toEqual([]);
    expect(cache.snapshot()).toMatchObject({ state: 'closed', retiring: 0, readers: 0 });
  });

  it('expires idle preparations', async () => {
    const { cache, service } = await setup();
    const comic = h.addComic(fixture('comic-rar4-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    h.clock.offset += COMIC_PREPARATION_CACHE_DEFAULTS.idleMs - 1000;
    await cache.sweep();
    expect(cache.snapshot().entries).toBe(1);
    expect((await service.getComicPage(...comic.id, { revision, position: 1 })).prepared).toBe(true);
    h.clock.offset += COMIC_PREPARATION_CACHE_DEFAULTS.idleMs;
    await cache.sweep();
    expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0 });
    expect(h.staged()).toEqual([]);
    expect((await service.getComicManifest(...comic.id)).preparation.state).toBe('on-demand');
  });

  it('cancels waiting and running preparations at shutdown and disposes everything', async () => {
    const admission = createComicAdmission();
    const hold = gate();
    const started = gate();
    let holdNext = false;
    const { cache, service } = await setup({
      admission,
      hooks: { beforePrepare: async () => { if (holdNext) { started.open(); await hold.promise; } } },
    });
    const ready = h.addComic(fixture('comic-rar5-solid.cbr'));
    const readyRevision = await prepare(service, cache, ready);
    holdNext = true;
    const running = h.addComic(fixture('comic-rar4-solid.cbr'));
    const waiting = h.addComic(await make7z(cb7Pages()), 'cb7');
    for (const comic of [running, waiting]) {
      const { revision } = await service.getComicManifest(...comic.id);
      await service.getComicPage(...comic.id, { revision, position: 1 });
    }
    await started.promise;
    expect(admission.snapshot()).toMatchObject({ activeBackground: 1, queuedBackground: 1 });
    const opened = tracked.opened.length;

    const closed = cache.close();
    expect(cache.close()).toBe(closed);
    hold.open();
    expect(await closed).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    // The waiting job never opened its source; nothing is left on disk or in admission.
    expect(tracked.opened.length).toBe(opened);
    expect(admission.snapshot()).toEqual({ active: 0, activeBackground: 0, reservedBytes: 0, queued: 0, queuedBackground: 0 });
    expect(cache.snapshot()).toMatchObject({ state: 'closed', entries: 0, pending: 0, aborting: 0, usedBytes: 0 });
    expect(h.staged()).toEqual([]);
    // After shutdown pages are still read on demand and nothing is scheduled.
    expect((await service.getComicPage(...ready.id, { revision: readyRevision, position: 1 })).prepared).toBe(false);
    expect(cache.snapshot().pending).toBe(0);
  });
});

describe('private storage and configuration', () => {
  it('recovers only abandoned preparation directories under its own root', async () => {
    const outside = fs.mkdtempSync(path.join(h.tmpDir, 'outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.mkdirSync(h.cacheRoot, { recursive: true });
    const leftover = path.join(h.cacheRoot, 'comic-prep-Ab3dE9');
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'pages.bin'), 'stale');
    fs.chmodSync(path.join(leftover, 'pages.bin'), 0o400);
    fs.mkdirSync(path.join(h.cacheRoot, 'comic-prep-toolongname'));
    fs.mkdirSync(path.join(h.cacheRoot, 'unrelated'));
    fs.writeFileSync(path.join(h.cacheRoot, 'comic-prep-File01'), 'not a directory');
    fs.writeFileSync(path.join(h.cacheRoot, 'notes.txt'), 'x');
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(h.cacheRoot, 'comic-prep-Link01'), 'junction');
      linked = true;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    }

    const cache = h.makeCache();
    expect(await cache.recover()).toEqual({ removed: 1, failed: 0, uninspected: 0 });
    expect(h.staged().sort()).toEqual(['comic-prep-File01', 'comic-prep-toolongname', 'notes.txt', 'unrelated',
      ...(linked ? ['comic-prep-Link01'] : [])].sort());
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');

    // A real preparation uses the recognised layout, and recovery refuses to run beside a job.
    const hold = gate();
    const service = h.makeService({ cache, admission: createComicAdmission(), _hooks: { beforePrepare: () => hold.promise } });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const { revision } = await service.getComicManifest(...comic.id);
    await service.getComicPage(...comic.id, { revision, position: 1 });
    await expect(cache.recover()).rejects.toMatchObject({ code: 'CACHE_BUSY' });
    hold.open();
    await cache.whenIdle();
    const prepDir = h.staged().find((name) => /^comic-prep-[A-Za-z0-9]{6}$/.test(name) && name !== 'comic-prep-File01');
    expect(prepDir).toBeDefined();
    // Live entries survive a later recovery.
    expect(await cache.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
    expect(fs.existsSync(path.join(h.cacheRoot, prepDir))).toBe(true);
    if (linked) fs.rmSync(path.join(h.cacheRoot, 'comic-prep-Link01'), { force: true });
  });

  it('creates a missing root and validates ownership and configuration', async () => {
    expect(fs.existsSync(h.cacheRoot)).toBe(false);
    const cache = h.makeCache();
    expect(await cache.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
    expect(fs.statSync(h.cacheRoot).isDirectory()).toBe(true);
    // One owner per root; relative roots, unknown and loosened options are refused.
    expect(() => h.makeCache()).toThrow(TypeError);
    const protectedRoots = [h.projectsRoot];
    expect(() => createComicPreparationCache({ stagingRoot: 'relative/root', protectedRoots })).toThrow(TypeError);
    const other = path.join(h.tmpDir, 'other-root');
    expect(() => createComicPreparationCache({ stagingRoot: other, protectedRoots, maxPreparedBytes: 2048 * MIB })).toThrow(TypeError);
    expect(() => createComicPreparationCache({ stagingRoot: other, protectedRoots, preparationTimeoutMs: 600_000 })).toThrow(TypeError);
    expect(() => createComicPreparationCache({ stagingRoot: other, protectedRoots, colour: 1 })).toThrow(TypeError);
    // The projects root must be protected explicitly, by absolute path.
    expect(() => createComicPreparationCache({ stagingRoot: other })).toThrow(TypeError);
    expect(() => createComicPreparationCache({ stagingRoot: other, protectedRoots: [] })).toThrow(TypeError);
    expect(() => createComicPreparationCache({ stagingRoot: other, protectedRoots: ['projects'] })).toThrow(TypeError);
    // Derived data never inside (or around) the projects tree; preparations need background admission.
    expect(() => createComicPreparationCache({ stagingRoot: path.join(h.projectsRoot, 'cache'), protectedRoots })).toThrow(TypeError);
    if (process.platform === 'win32') {
      expect(() => createComicPreparationCache({ stagingRoot: h.projectsRoot.toUpperCase(), protectedRoots })).toThrow(TypeError);
    }
    expect(() => createComicPreparationCache({ stagingRoot: h.tmpDir, protectedRoots })).toThrow(TypeError);
    // A service refuses a cache that does not protect its projects root.
    const unprotected = createComicPreparationCache({ stagingRoot: other, protectedRoots: [path.join(h.tmpDir, 'elsewhere')] });
    expect(() => h.makeService({ cache: unprotected })).toThrow(TypeError);
    await unprotected.close();
    expect(() => h.makeService({ cache, admission: createComicAdmission({ maxBackgroundActive: 0 }) })).toThrow(TypeError);
    expect(() => h.makeService({ cache, admission: createComicAdmission({ memoryBudgetBytes: 512 * MIB, foregroundReserveBytes: 100 * MIB }) }))
      .toThrow(TypeError);
    expect(estimateComicOperationBytes('preparation', 'cbr')).toBeLessThanOrEqual(1024 * MIB - 364 * MIB);
    // Closing releases the root for a later owner.
    await cache.close();
    const again = h.makeCache();
    await again.close();
  });
});

describe('failed cleanup accounting (F2)', () => {
  const STAGING_NAME = /^comic-prep-[A-Za-z0-9]{6}$/;
  const isStaging = (file) => STAGING_NAME.test(path.basename(file));
  const stagedDirs = () => h.staged().filter((name) => STAGING_NAME.test(name));
  // Bytes actually on disk in staging directories.
  const diskBytes = () => stagedDirs().reduce((sum, name) => sum + fs.readdirSync(path.join(h.cacheRoot, name))
    .reduce((inner, file) => inner + fs.lstatSync(path.join(h.cacheRoot, name, file)).size, 0), 0);
  // Removal attempts of one staging directory, however its root was spelled.
  const attempts = (name) => [...tracked.rmCalls].filter(([file]) => path.basename(file) === name)
    .reduce((sum, [, count]) => sum + count, 0);
  const cb7Bytes = () => img.png.length + img.jpeg.length + img.webp.length;

  // The exact staged size of the RAR5 fixture (the reviewer's 48,174-byte budget).
  async function preparedSize() {
    const probe = await setup();
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    await prepare(probe.service, probe.cache, comic);
    const bytes = probe.cache.snapshot().retainedBytes;
    expect(await probe.cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    return bytes;
  }

  it('keeps a failed preparation charged while its staging remains, so the budget holds', async () => {
    const budget = await preparedSize();
    const { cache, service, counts } = await setup({ cacheOptions: { maxTotalBytes: budget } });
    // Every page is written, then sealing the pack fails and so does every removal.
    tracked.failSeal = true;
    tracked.failRm = isStaging;
    const comics = [1, 2, 3].map(() => h.addComic(fixture('comic-rar5-solid.cbr')));
    await prepare(service, cache, comics[0]);
    expect(counts.prepared).toBe(1);
    const [leftover] = stagedDirs();
    expect(stagedDirs()).toEqual([leftover]);
    expect(diskBytes()).toBe(budget);
    expect(cache.snapshot()).toMatchObject({
      entries: 0, pending: 0, reservedBytes: 0, stranded: 1, strandedBytes: budget, usedBytes: budget, unmeasured: 0, capacityWithheld: false,
    });

    // The leftover fills the budget: further preparations are refused before writing anything.
    for (const comic of comics.slice(1)) await prepare(service, cache, comic);
    expect(counts.prepared).toBe(1);
    expect(stagedDirs()).toEqual([leftover]);
    expect(diskBytes()).toBe(budget);
    expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: budget, usedBytes: budget, failures: 3 });

    // Nothing retries on its own; each sweep tries once and never charges twice.
    const before = attempts(leftover);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(attempts(leftover)).toBe(before);
    for (const round of [1, 2]) {
      await cache.sweep();
      expect(attempts(leftover)).toBe(before + round);
      expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: budget, usedBytes: budget, reservedBytes: 0 });
    }

    // A successful retry releases the charge exactly once.
    tracked.failRm = null;
    await cache.sweep();
    expect(stagedDirs()).toEqual([]);
    expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0, reservedBytes: 0 });
    await cache.sweep();
    expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0 });

    // The capacity is usable again once the backoff has passed.
    tracked.failSeal = false;
    h.clock.offset += 61 * 60_000;
    await prepare(service, cache, comics[1]);
    expect(counts.prepared).toBe(2);
    expect(cache.snapshot()).toMatchObject({ entries: 1, usedBytes: budget, stranded: 0 });
  });

  it('reports leftovers at close and keeps startup-recovery leftovers charged until removed', async () => {
    const budget = await preparedSize();
    const first = await setup({ cacheOptions: { maxTotalBytes: budget } });
    tracked.failSeal = true;
    tracked.failRm = isStaging;
    const [a, b] = [1, 2].map(() => h.addComic(fixture('comic-rar5-solid.cbr')));
    await prepare(first.service, first.cache, a);
    expect(await first.cache.close()).toEqual({ stranded: 1, strandedBytes: budget, unmeasured: 0 });
    const [leftover] = stagedDirs();
    expect(stagedDirs()).toEqual([leftover]);
    tracked.failSeal = false;

    // A later run holds no reservation for it: recovery measures and charges it.
    const cache = h.makeCache({ maxTotalBytes: budget });
    expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 0 });
    expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: budget, usedBytes: budget, capacityWithheld: false });
    let prepared = 0;
    const service = h.makeService({ cache, admission: createComicAdmission(), _hooks: { beforePrepare: () => { prepared += 1; } } });
    await prepare(service, cache, b);
    expect(prepared).toBe(0);
    expect(stagedDirs()).toEqual([leftover]);
    // Repeated recovery neither charges twice nor releases.
    expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 0 });
    expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: budget });

    // A leftover not of the staging layout cannot be measured: all new capacity is withheld.
    const odd = path.join(h.cacheRoot, 'comic-prep-Odd001');
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, 'pages.bin'), 'x');
    fs.writeFileSync(path.join(odd, 'more.bin'), 'y');
    expect(await cache.recover()).toEqual({ removed: 0, failed: 2, uninspected: 0 });
    expect(cache.snapshot()).toMatchObject({ stranded: 2, strandedBytes: budget, unmeasured: 1, capacityWithheld: true });

    // Once the filesystem allows, the staging layout is removed; the foreign file is never
    // deleted (F6: removal is not recursive), so that directory stays and keeps capacity withheld.
    tracked.failRm = null;
    expect(await cache.recover()).toEqual({ removed: 1, failed: 1, uninspected: 0 });
    expect(fs.readFileSync(path.join(odd, 'more.bin'), 'utf8')).toBe('y');
    expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: 0, unmeasured: 1, capacityWithheld: true });
    // After someone removes the foreign content, recovery releases it, once.
    fs.rmSync(path.join(odd, 'more.bin'));
    expect(await cache.recover()).toEqual({ removed: 1, failed: 0, uninspected: 0 });
    expect(h.staged().filter((name) => name.startsWith('comic-prep-'))).toEqual([]);
    expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0, unmeasured: 0, capacityWithheld: false });
    h.clock.offset += 61 * 60_000;
    await prepare(service, cache, b);
    expect(prepared).toBe(1);
    expect(cache.snapshot()).toMatchObject({ entries: 1, usedBytes: budget });
    expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
  });

  it('withholds all capacity while an unmeasurable leftover remains', async () => {
    fs.mkdirSync(h.cacheRoot, { recursive: true });
    const odd = path.join(h.cacheRoot, 'comic-prep-Odd002');
    fs.mkdirSync(path.join(odd, 'nested'), { recursive: true });
    tracked.failRm = isStaging;
    const { cache, service, counts } = await setup();
    expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: 0, unmeasured: 1, capacityWithheld: true });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    await prepare(service, cache, comic);
    expect(counts.prepared).toBe(0);
    expect(cache.snapshot()).toMatchObject({ entries: 0, failures: 1 });
    // Its foreign content is never removed (F6: removal is not recursive): even when the
    // filesystem allows, sweep() leaves it charged.
    tracked.failRm = null;
    await cache.sweep();
    expect(fs.existsSync(path.join(odd, 'nested'))).toBe(true);
    expect(cache.snapshot()).toMatchObject({ stranded: 1, unmeasured: 1, capacityWithheld: true });
    // Once the foreign content is gone, sweep() removes the directory; capacity returns.
    fs.rmdirSync(path.join(odd, 'nested'));
    await cache.sweep();
    expect(cache.snapshot()).toMatchObject({ stranded: 0, unmeasured: 0, capacityWithheld: false });
    expect(fs.existsSync(odd)).toBe(false);
  });

  it('keeps an evicted preparation charged beside retained and leased ones until it is removed', async () => {
    let during = null;
    const { cache, service } = await setup({ cacheOptions: { maxEntries: 1 }, hooks: { preparedRead: () => during?.() } });
    const [a, b] = [1, 2].map(() => h.addComic(fixture('comic-rar5-solid.cbr')));
    await prepare(service, cache, a);
    const [dirA] = stagedDirs();
    const bytes = cache.snapshot().retainedBytes;
    // Preparing B evicts A, whose removal fails.
    tracked.failRm = (file) => path.basename(file) === dirA;
    h.clock.offset += 1000;
    const revisionB = await prepare(service, cache, b);
    expect(stagedDirs()).toHaveLength(2);
    expect(cache.snapshot()).toMatchObject({
      entries: 1, retiring: 0, retainedBytes: bytes, stranded: 1, strandedBytes: bytes, usedBytes: bytes * 2,
    });
    // While a read holds B, a sweep retries A only; nothing is released or double-charged.
    during = async () => {
      during = null;
      await cache.sweep();
      expect(cache.snapshot()).toMatchObject({ entries: 1, readers: 1, stranded: 1, usedBytes: bytes * 2 });
      tracked.failRm = null;
      await cache.sweep();
      expect(cache.snapshot()).toMatchObject({ entries: 1, readers: 1, stranded: 0, strandedBytes: 0, usedBytes: bytes });
    };
    expect((await service.getComicPage(...b.id, { revision: revisionB, position: 2 })).prepared).toBe(true);
    expect(during).toBe(null);
    expect(stagedDirs()).toHaveLength(1);
    expect(cache.snapshot()).toMatchObject({ entries: 1, readers: 0, usedBytes: bytes });
  });

  it('charges timed-out and cancelled preparations whose staging cannot be removed', async () => {
    const workerSettled = async () => {
      for (const worker of tracked.workers) {
        if (worker.threadId !== -1) await new Promise((resolve) => worker.once('exit', resolve));
      }
    };
    const hold = gate();
    const started = gate();
    let scenario = null;
    const { cache, service } = await setup({
      cacheOptions: { preparationTimeoutMs: 1500 },
      hooks: {
        beforePrepare: () => {
          tracked.inspect = scenario === 'timeout'
            ? () => new Promise((resolve) => setTimeout(resolve, 1600))
            : async () => { started.open(); await hold.promise; };
        },
      },
    });
    tracked.failRm = isStaging;
    scenario = 'timeout';
    await prepare(service, cache, h.addComic(await make7z(cb7Pages()), 'cb7'));
    tracked.inspect = null;
    expect(cache.snapshot()).toMatchObject({ entries: 0, pending: 0, reservedBytes: 0, stranded: 1, strandedBytes: cb7Bytes() });
    expect(stagedDirs()).toHaveLength(1);

    // Cancelled at shutdown while verifying pages.
    scenario = 'cancel';
    const comic = h.addComic(await make7z(cb7Pages()), 'cb7');
    const { revision } = await service.getComicManifest(...comic.id);
    await service.getComicPage(...comic.id, { revision, position: 1 });
    await started.promise;
    const closing = cache.close();
    hold.open();
    expect(await closing).toEqual({ stranded: 2, strandedBytes: cb7Bytes() * 2, unmeasured: 0 });
    expect(stagedDirs()).toHaveLength(2);
    tracked.inspect = null;
    await workerSettled();
  });

  describe('recovery metadata failures (F4)', () => {
    // A leftover in the A3.2b layout written by an earlier run, outside any accounting.
    function makeLeftover(name, bytes, { seal = true } = {}) {
      fs.mkdirSync(h.cacheRoot, { recursive: true });
      const directory = path.join(h.cacheRoot, name);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'pages.bin'), Buffer.alloc(bytes, 7));
      if (seal) fs.chmodSync(path.join(directory, 'pages.bin'), 0o400);
      return directory;
    }
    const failLstatOf = (name, code) => (file) => (path.basename(file) === name ? code : null);

    it('keeps an uninspectable leftover charged and withholds capacity until it is removed (reviewer reproduction)', async () => {
      const budget = await preparedSize();
      expect(budget).toBe(48_174);
      const name = 'comic-prep-Eio001';
      const leftover = makeLeftover(name, budget);
      fs.writeFileSync(path.join(h.cacheRoot, 'notes.txt'), 'keep');
      tracked.failLstat = failLstatOf(name, 'EIO');

      // Recovery cannot inspect it: not assumed gone, not removed, not a success.
      const cache = h.makeCache({ maxTotalBytes: budget });
      expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 1 });
      const unresolved = { stranded: 1, strandedBytes: 0, unmeasured: 1, capacityWithheld: true, usedBytes: 0, reservedBytes: 0 };
      expect(cache.snapshot()).toMatchObject(unresolved);

      // No other preparation is admitted beside it: disk usage stays within the budget.
      let prepared = 0;
      const service = h.makeService({ cache, admission: createComicAdmission(), _hooks: { beforePrepare: () => { prepared += 1; } } });
      const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
      await prepare(service, cache, comic);
      expect(prepared).toBe(0);
      expect(stagedDirs()).toEqual([name]);
      expect(diskBytes()).toBe(budget);
      expect(cache.snapshot()).toMatchObject({ ...unresolved, entries: 0, failures: 1 });

      // Repeated sweeps and recoveries neither charge twice, release, nor delete it.
      for (let round = 0; round < 2; round += 1) {
        await cache.sweep();
        expect(cache.snapshot()).toMatchObject(unresolved);
        expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 1 });
        expect(cache.snapshot()).toMatchObject(unresolved);
      }
      expect(attempts(name)).toBe(0);
      expect(fs.existsSync(path.join(leftover, 'pages.bin'))).toBe(true);

      // Inspectable again but still not removable: measured, so the exact bytes stay charged.
      tracked.failLstat = null;
      tracked.failRm = isStaging;
      expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 0 });
      const measured = { stranded: 1, strandedBytes: budget, usedBytes: budget, unmeasured: 0, capacityWithheld: false };
      expect(cache.snapshot()).toMatchObject(measured);

      // A tracked record keeps its charge when its metadata fails again.
      tracked.failLstat = failLstatOf(name, 'EIO');
      expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 1 });
      expect(cache.snapshot()).toMatchObject(measured);
      await cache.sweep();
      expect(cache.snapshot()).toMatchObject(measured);

      // Removal succeeds once inspection and the filesystem allow it: released exactly once.
      tracked.failLstat = null;
      tracked.failRm = null;
      await cache.sweep();
      expect(stagedDirs()).toEqual([]);
      const clear = { stranded: 0, strandedBytes: 0, usedBytes: 0, unmeasured: 0, capacityWithheld: false };
      expect(cache.snapshot()).toMatchObject(clear);
      await cache.sweep();
      expect(await cache.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
      expect(cache.snapshot()).toMatchObject(clear);
      expect(fs.readFileSync(path.join(h.cacheRoot, 'notes.txt'), 'utf8')).toBe('keep');

      // The capacity is usable again, and only one preparation's bytes are on disk.
      h.clock.offset += 61 * 60_000;
      await prepare(service, cache, comic);
      expect(prepared).toBe(1);
      expect(diskBytes()).toBe(budget);
      expect(cache.snapshot()).toMatchObject({ entries: 1, usedBytes: budget, stranded: 0 });
      expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    });

    it.each(['EACCES', 'EPERM', 'EUNEXPECTED'])('reports a leftover it cannot inspect (%s) through close()', async (code) => {
      const name = 'comic-prep-Bad001';
      const leftover = makeLeftover(name, 1000);
      tracked.failLstat = failLstatOf(name, code);
      const cache = h.makeCache();
      expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 1 });
      expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: 0, unmeasured: 1, capacityWithheld: true });
      expect(await cache.close()).toEqual({ stranded: 1, strandedBytes: 0, unmeasured: 1 });
      expect(fs.readFileSync(path.join(leftover, 'pages.bin')).length).toBe(1000);
      expect(attempts(name)).toBe(0);
    });

    it('resolves a tracked leftover that is genuinely gone when recovery inspects it', async () => {
      const name = 'comic-prep-Gone01';
      const leftover = makeLeftover(name, 1000, { seal: false });
      tracked.failRm = isStaging;
      const cache = h.makeCache();
      expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 0 });
      expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: 1000, unmeasured: 0 });
      // It disappears between the listing and its inspection: ENOENT beneath the trusted root.
      tracked.failLstat = (file) => {
        if (path.basename(file) === name) fs.rmSync(leftover, { recursive: true, force: true });
        return null;
      };
      expect(await cache.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
      expect(fs.existsSync(leftover)).toBe(false);
      expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0, unmeasured: 0, capacityWithheld: false });
      expect(await cache.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
      expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    });
  });
});

describe('physical containment (F3)', () => {
  const links = [];
  // A directory link no privileges are needed for: a junction on Windows, a symlink elsewhere.
  function junction(target, at) {
    fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(at);
  }

  afterEach(() => {
    for (const at of links.splice(0).reverse()) fs.rmSync(at, { force: true });
  });

  // A project directory holding data shaped exactly like an abandoned preparation.
  function sentinelProject(name = 'sentinel-project') {
    const project = path.join(h.projectsRoot, name);
    const victim = path.join(project, 'cache', 'comic-prep-Sent01');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'pages.bin'), 'project bytes');
    fs.writeFileSync(path.join(project, 'keep.txt'), 'keep');
    return {
      project,
      intact() {
        expect(fs.readFileSync(path.join(victim, 'pages.bin'), 'utf8')).toBe('project bytes');
        expect(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8')).toBe('keep');
      },
    };
  }

  it('refuses a cache root that a junction ancestor redirects into the projects tree', async () => {
    const sentinel = sentinelProject();
    const external = path.join(h.tmpDir, 'appdata');
    fs.mkdirSync(external);
    junction(sentinel.project, path.join(external, 'link'));
    const stagingRoot = path.join(external, 'link', 'cache');
    const cache = h.makeCache({ stagingRoot });
    // Lexically external, so the configuration is accepted ...
    const service = h.makeService({ cache, admission: createComicAdmission() });
    // ... but recovery refuses to touch it, and the project's data survives.
    await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    sentinel.intact();
    expect([...tracked.rmCalls.keys()].filter((file) => file.includes('comic-prep-Sent01'))).toEqual([]);

    // Nothing is prepared into it either; pages are still read on demand.
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const { revision } = await service.getComicManifest(...comic.id);
    expect((await service.getComicPage(...comic.id, { revision, position: 1 })).prepared).toBe(false);
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 0, failures: 1, usedBytes: 0 });
    expect(fs.readdirSync(path.join(sentinel.project, 'cache'))).toEqual(['comic-prep-Sent01']);
    await cache.sweep();
    expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    sentinel.intact();

    // A root that does not exist yet behind the redirected ancestor is refused and never created.
    const fresh = h.makeCache({ stagingRoot: path.join(external, 'link', 'new-cache') });
    await expect(fresh.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    expect(fs.existsSync(path.join(sentinel.project, 'new-cache'))).toBe(false);

    // A root physically equal to the projects root is refused too.
    junction(h.tmpDir, path.join(external, 'up'));
    const same = h.makeCache({ stagingRoot: path.join(external, 'up', 'projects') });
    expect(() => h.makeService({ cache: same })).not.toThrow();
    await expect(same.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    sentinel.intact();
    expect([...tracked.rmCalls.keys()].filter((file) => file.includes('comic-prep-Sent01'))).toEqual([]);
  });

  it('refuses a root that a symbolic-link ancestor redirects into the projects tree', async (context) => {
    const sentinel = sentinelProject();
    const external = path.join(h.tmpDir, 'appdata');
    fs.mkdirSync(external);
    const at = path.join(external, 'symlink');
    try {
      fs.symlinkSync(sentinel.project, at, 'dir');
      links.push(at);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      // Windows without Developer Mode or elevation cannot create directory symlinks; the
      // junction case covers the same redirection. Reported as skipped, never as passed.
      context.skip('directory symbolic links cannot be created here (' + err.code + ')');
    }
    const cache = h.makeCache({ stagingRoot: path.join(at, 'cache') });
    await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    sentinel.intact();
  });

  it('accepts an application root reached through a link outside the projects tree', async () => {
    const real = path.join(h.tmpDir, 'app-real');
    fs.mkdirSync(real);
    const external = path.join(h.tmpDir, 'appdata');
    fs.mkdirSync(external);
    junction(real, path.join(external, 'link'));
    const cache = h.makeCache({ stagingRoot: path.join(external, 'link', 'cache') });
    expect(await cache.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
    // Abandoned preparations under it are still recovered.
    fs.mkdirSync(path.join(real, 'cache', 'comic-prep-Old001'));
    expect(await cache.recover()).toEqual({ removed: 1, failed: 0, uninspected: 0 });
    let prepared = 0;
    const service = h.makeService({ cache, admission: createComicAdmission(), _hooks: { beforePrepare: () => { prepared += 1; } } });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    expect(prepared).toBe(1);
    expect(fs.readdirSync(path.join(real, 'cache'))).toHaveLength(1);
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
    expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(fs.readdirSync(path.join(real, 'cache'))).toEqual([]);
  });

  it('deletes nothing after an ancestor is swapped for a junction into the projects tree', async () => {
    const anchor = path.join(h.tmpDir, 'appdata', 'anchor');
    fs.mkdirSync(anchor, { recursive: true });
    const cache = h.makeCache({ stagingRoot: path.join(anchor, 'cache') });
    await cache.recover();
    const service = h.makeService({ cache, admission: createComicAdmission() });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    await prepare(service, cache, comic);
    const [name] = fs.readdirSync(path.join(anchor, 'cache'));
    const bytes = cache.snapshot().retainedBytes;

    // Project data with the same generated name, then the validated ancestor is replaced by a
    // junction to it: the preparation's recorded path now leads into the project.
    const project = path.join(h.projectsRoot, 'swapped-project');
    fs.mkdirSync(path.join(project, 'cache', name), { recursive: true });
    fs.writeFileSync(path.join(project, 'cache', name, 'pages.bin'), 'project bytes');
    fs.renameSync(anchor, anchor + '-moved');
    junction(project, anchor);
    const removals = () => [...tracked.rmCalls].filter(([file]) => path.basename(file) === name)
      .reduce((sum, [, count]) => sum + count, 0);
    const removalsBefore = removals();

    // Idle expiry, sweep, recovery and shutdown all refuse; the bytes stay charged.
    h.clock.offset += COMIC_PREPARATION_CACHE_DEFAULTS.idleMs * 2;
    await cache.sweep();
    expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0, stranded: 1, strandedBytes: bytes, usedBytes: bytes });
    await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    expect(await cache.close()).toEqual({ stranded: 1, strandedBytes: bytes, unmeasured: 0 });
    expect(removals()).toBe(removalsBefore);
    expect(fs.readFileSync(path.join(project, 'cache', name, 'pages.bin'), 'utf8')).toBe('project bytes');
    // The real preparation is untouched where the ancestor was moved to.
    expect(fs.readdirSync(path.join(anchor + '-moved', 'cache', name))).toEqual(['pages.bin']);
  });
});

// F5/F6 — Bind-mount aliases and replaceable ancestors. Linux bind mounts need root with
// CAP_SYS_ADMIN (a disposable privileged container); without it those cases are reported as
// skipped, never as passed.
const POSIX_IDS = typeof process.getuid === 'function';
const ROOT_USER = POSIX_IDS && process.getuid() === 0;
const CAN_BIND_MOUNT = (() => {
  if (process.platform !== 'linux' || !ROOT_USER) return false;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bind-probe-'));
  try {
    fs.mkdirSync(path.join(probe, 'a'));
    fs.mkdirSync(path.join(probe, 'b'));
    if (spawnSync('mount', ['--bind', path.join(probe, 'a'), path.join(probe, 'b')]).status !== 0) return false;
    spawnSync('umount', [path.join(probe, 'b')]);
    return true;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

describe('mount aliases and replaceable ancestors (F5, F6)', () => {
  const links = [];
  const mounts = [];
  function link(target, at) {
    fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(at);
  }
  function unlinkAt(at) {
    fs.rmSync(at, { force: true });
    links.splice(links.indexOf(at), 1);
  }
  function bind(source, at) {
    fs.mkdirSync(at, { recursive: true });
    const result = spawnSync('mount', ['--bind', source, at], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('mount --bind failed: ' + result.stderr);
    mounts.push(at);
  }

  afterEach(() => {
    for (const at of mounts.splice(0).reverse()) spawnSync('umount', [at]);
    for (const at of links.splice(0).reverse()) fs.rmSync(at, { force: true });
  });

  // Project data shaped exactly like an abandoned preparation, plus an ordinary file.
  function sentinel(project, name = 'comic-prep-Snt001') {
    const victim = path.join(project, 'cache', name);
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'pages.bin'), 'project bytes');
    fs.writeFileSync(path.join(project, 'keep.txt'), 'keep');
    return {
      intact() {
        expect(fs.readFileSync(path.join(victim, 'pages.bin'), 'utf8')).toBe('project bytes');
        expect(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8')).toBe('keep');
      },
    };
  }
  const removalsOf = (name) => [...tracked.rmCalls].filter(([file]) => path.basename(file) === name)
    .reduce((sum, [, count]) => sum + count, 0);

  // A published preparation under <tmp>/appdata/anchor/cache.
  async function publishedUnderAnchor() {
    const anchor = path.join(h.tmpDir, 'appdata', 'anchor');
    fs.mkdirSync(anchor, { recursive: true });
    const cache = h.makeCache({ stagingRoot: path.join(anchor, 'cache') });
    await cache.recover();
    const service = h.makeService({ cache, admission: createComicAdmission() });
    await prepare(service, cache, h.addComic(fixture('comic-rar5-solid.cbr')));
    const [name] = fs.readdirSync(path.join(anchor, 'cache'));
    return { anchor, cache, name, bytes: cache.snapshot().retainedBytes };
  }
  const expireIdle = () => { h.clock.offset += COMIC_PREPARATION_CACHE_DEFAULTS.idleMs * 2; };

  describe('removal redirected while it runs (F6, all platforms)', () => {
    it('never counts a removal as done when an ancestor is swapped into the projects tree mid-removal', async () => {
      const { anchor, cache, name, bytes } = await publishedUnderAnchor();
      const project = path.join(h.projectsRoot, 'redirect-target');
      fs.mkdirSync(path.join(project, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(project, 'keep.txt'), 'keep');
      // Validation passes; then, as the removal starts, the ancestor is replaced by a link.
      tracked.onRemove = (directory) => {
        if (path.basename(directory) !== name || fs.existsSync(anchor + '-moved')) return;
        fs.renameSync(anchor, anchor + '-moved');
        link(project, anchor);
      };
      expireIdle();
      await cache.sweep();
      // Not reported removed: the bytes stay charged and the real directory is untouched.
      expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0, stranded: 1, strandedBytes: bytes, usedBytes: bytes });
      expect(fs.readdirSync(path.join(anchor + '-moved', 'cache', name))).toEqual(['pages.bin']);
      expect(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8')).toBe('keep');
      expect(fs.readdirSync(path.join(project, 'cache'))).toEqual([]);
      // While redirected, every later attempt refuses before touching anything.
      tracked.onRemove = null;
      const attempts = removalsOf(name);
      await cache.sweep();
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      expect(removalsOf(name)).toBe(attempts);
      expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: bytes });
      // Restored, the stranded directory is removed and released exactly once.
      unlinkAt(anchor);
      fs.renameSync(anchor + '-moved', anchor);
      await cache.sweep();
      expect(fs.readdirSync(path.join(anchor, 'cache'))).toEqual([]);
      expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0 });
      expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    });

    it('never counts a removal as done when the path is redirected and restored around it', async () => {
      const { anchor, cache, name, bytes } = await publishedUnderAnchor();
      const decoy = path.join(h.tmpDir, 'decoy');
      fs.mkdirSync(path.join(decoy, 'cache'), { recursive: true });
      let restored = false;
      tracked.onRemove = (directory) => {
        if (path.basename(directory) !== name || restored) return;
        fs.renameSync(anchor, anchor + '-moved');
        link(decoy, anchor);
      };
      tracked.afterRemove = (directory) => {
        if (path.basename(directory) !== name || restored) return;
        restored = true;
        unlinkAt(anchor);
        fs.renameSync(anchor + '-moved', anchor);
      };
      expireIdle();
      await cache.sweep();
      // The removal reached the decoy (where nothing was), so the real directory remains: still charged.
      expect(restored).toBe(true);
      expect(fs.readdirSync(path.join(anchor, 'cache', name))).toEqual(['pages.bin']);
      expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: bytes, usedBytes: bytes });
      tracked.onRemove = null;
      tracked.afterRemove = null;
      await cache.sweep();
      expect(fs.readdirSync(path.join(anchor, 'cache'))).toEqual([]);
      expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0 });
    });

    it('never empties a staging-named directory that holds anything but the staging layout', async () => {
      fs.mkdirSync(h.cacheRoot, { recursive: true });
      const odd = path.join(h.cacheRoot, 'comic-prep-Frn001');
      fs.mkdirSync(path.join(odd, 'project'), { recursive: true });
      fs.writeFileSync(path.join(odd, 'project', 'keep.txt'), 'keep');
      fs.writeFileSync(path.join(odd, 'pages.bin'), 'x');
      const cache = h.makeCache();
      expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 0 });
      expect(fs.readFileSync(path.join(odd, 'project', 'keep.txt'), 'utf8')).toBe('keep');
      expect(cache.snapshot()).toMatchObject({ stranded: 1, unmeasured: 1, capacityWithheld: true });
      expect(await cache.close()).toEqual({ stranded: 1, strandedBytes: 0, unmeasured: 1 });
    });
  });

  describe.skipIf(!POSIX_IDS)('replaceable ancestors (F6, POSIX)', () => {
    // A cache root below `parent` holding one leftover in the staging layout.
    function rootBelow(parent) {
      const stagingRoot = path.join(parent, 'cache');
      const leftover = path.join(stagingRoot, 'comic-prep-Anc001');
      fs.mkdirSync(leftover, { recursive: true, mode: 0o700 });
      fs.chmodSync(stagingRoot, 0o700);
      fs.writeFileSync(path.join(leftover, 'pages.bin'), 'cache bytes');
      return { stagingRoot, leftover };
    }

    it.each([
      ['world-writable', 0o777],
      ['group-writable', 0o770],
    ])('refuses a root below a %s directory without the sticky bit (reviewer configuration)', async (_, mode) => {
      const parent = path.join(h.tmpDir, 'shared');
      const { stagingRoot, leftover } = rootBelow(parent);
      fs.chmodSync(parent, mode);
      const cache = h.makeCache({ stagingRoot });
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      // Nothing is prepared into it either.
      const service = h.makeService({ cache, admission: createComicAdmission() });
      const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
      const { revision } = await service.getComicManifest(...comic.id);
      expect((await service.getComicPage(...comic.id, { revision, position: 1 })).prepared).toBe(false);
      await cache.whenIdle();
      expect(cache.snapshot()).toMatchObject({ entries: 0, usedBytes: 0, stranded: 0 });
      expect(fs.readdirSync(stagingRoot)).toEqual(['comic-prep-Anc001']);
      expect(fs.readFileSync(path.join(leftover, 'pages.bin'), 'utf8')).toBe('cache bytes');
      expect(removalsOf('comic-prep-Anc001')).toBe(0);
    });

    it('accepts a root below a sticky shared directory (as /tmp) and recovers there', async () => {
      const parent = path.join(h.tmpDir, 'sticky');
      const { stagingRoot, leftover } = rootBelow(parent);
      fs.chmodSync(parent, 0o1777);
      const cache = h.makeCache({ stagingRoot });
      expect(await cache.recover()).toEqual({ removed: 1, failed: 0, uninspected: 0 });
      expect(fs.existsSync(leftover)).toBe(false);
    });

    it('makes its own root private at recovery, and refuses removal once the root is opened to others', async () => {
      fs.mkdirSync(h.cacheRoot, { recursive: true });
      fs.chmodSync(h.cacheRoot, 0o777);
      const cache = h.makeCache();
      await cache.recover();
      expect(fs.statSync(h.cacheRoot).mode & 0o777).toBe(0o700);
      const service = h.makeService({ cache, admission: createComicAdmission() });
      await prepare(service, cache, h.addComic(fixture('comic-rar5-solid.cbr')));
      const [name] = fs.readdirSync(h.cacheRoot);
      const bytes = cache.snapshot().retainedBytes;
      fs.chmodSync(h.cacheRoot, 0o777);
      expireIdle();
      await cache.sweep();
      expect(removalsOf(name)).toBe(0);
      expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: bytes, usedBytes: bytes });
      fs.chmodSync(h.cacheRoot, 0o700);
      await cache.sweep();
      expect(cache.snapshot()).toMatchObject({ stranded: 0, usedBytes: 0 });
      expect(fs.readdirSync(h.cacheRoot)).toEqual([]);
    });

    it('treats ancestor metadata it cannot read as unsafe', async () => {
      const parent = path.join(h.tmpDir, 'unreadable-parent');
      const { stagingRoot, leftover } = rootBelow(parent);
      tracked.failLstat = (file) => (file === parent ? 'EACCES' : null);
      const cache = h.makeCache({ stagingRoot });
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      expect(fs.existsSync(path.join(leftover, 'pages.bin'))).toBe(true);
    });

    it.skipIf(!ROOT_USER)('refuses a root below a directory another user owns', async () => {
      const parent = path.join(h.tmpDir, 'theirs');
      const { stagingRoot, leftover } = rootBelow(parent);
      fs.chmodSync(parent, 0o755);
      fs.chownSync(parent, 4321, 4321);
      const cache = h.makeCache({ stagingRoot });
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      expect(fs.existsSync(path.join(leftover, 'pages.bin'))).toBe(true);
    });
  });

  describe.skipIf(!CAN_BIND_MOUNT)('bind-mount aliases (F5, Linux)', () => {
    it('refuses a cache under a bind mount of a protected project subdirectory (reviewer reproduction)', async () => {
      const project = path.join(h.projectsRoot, 'project');
      const guard = sentinel(project);
      const alias = path.join(h.tmpDir, 'bind-alias');
      bind(project, alias);
      const cache = h.makeCache({ stagingRoot: path.join(alias, 'cache') });
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      guard.intact();
      expect(removalsOf('comic-prep-Snt001')).toBe(0);
      expect(cache.snapshot()).toMatchObject({ stranded: 0, usedBytes: 0 });
      // Nothing is prepared into it; a root not yet created behind the alias is never created.
      const service = h.makeService({ cache, admission: createComicAdmission() });
      const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
      const { revision } = await service.getComicManifest(...comic.id);
      expect((await service.getComicPage(...comic.id, { revision, position: 1 })).prepared).toBe(false);
      await cache.whenIdle();
      expect(fs.readdirSync(path.join(project, 'cache'))).toEqual(['comic-prep-Snt001']);
      const fresh = h.makeCache({ stagingRoot: path.join(alias, 'new-cache') });
      await expect(fresh.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      expect(fs.existsSync(path.join(project, 'new-cache'))).toBe(false);
      expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
      guard.intact();
    });

    it('refuses aliases of the protected root and of a parent containing it, and accepts the parent\'s other storage', async () => {
      const guard = sentinel(path.join(h.projectsRoot, 'project'));
      const rootAlias = path.join(h.tmpDir, 'root-alias');
      bind(h.projectsRoot, rootAlias);
      const viaRoot = h.makeCache({ stagingRoot: path.join(rootAlias, 'project', 'cache') });
      await expect(viaRoot.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      const parentAlias = path.join(h.tmpDir, 'parent-alias');
      bind(h.tmpDir, parentAlias);
      const viaParent = h.makeCache({ stagingRoot: path.join(parentAlias, 'projects', 'project', 'cache') });
      await expect(viaParent.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      const exact = h.makeCache({ stagingRoot: path.join(parentAlias, 'projects') });
      await expect(exact.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      guard.intact();
      // The same filesystem's application storage, reached through the same alias, is fine.
      const ok = h.makeCache({ stagingRoot: path.join(parentAlias, 'app', 'aliased-cache') });
      expect(await ok.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
      expect(fs.existsSync(path.join(h.tmpDir, 'app', 'aliased-cache'))).toBe(true);
    });

    it('refuses a root with storage mounted beneath it, and aliases of storage mounted inside the projects tree', async () => {
      const project = path.join(h.projectsRoot, 'project');
      const guard = sentinel(project);
      bind(project, path.join(h.cacheRoot, 'comic-prep-Mnt001'));
      const cache = h.makeCache();
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      guard.intact();
      expect(removalsOf('comic-prep-Mnt001')).toBe(0);
      // Storage mounted inside the projects tree is protected wherever else it is exposed.
      const external = fs.mkdtempSync(path.join(h.tmpDir, 'external-'));
      bind(external, path.join(h.projectsRoot, 'mounted'));
      const elsewhere = path.join(h.tmpDir, 'elsewhere');
      bind(external, elsewhere);
      const viaOther = h.makeCache({ stagingRoot: path.join(elsewhere, 'cache') });
      await expect(viaOther.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    });

    it('fails closed when the mount table is missing, malformed or names a deleted origin', async () => {
      const rewrites = [
        () => { throw Object.assign(new Error('ENOENT: mountinfo'), { code: 'ENOENT' }); },
        () => 'garbage\n',
        () => '',
        (text) => text.split('\n').map((line) => line.replace(/^(\S+ \S+ \S+ )(\S+)/, '$1$2//deleted')).join('\n'),
      ];
      for (const rewrite of rewrites) {
        tracked.mountInfo = rewrite;
        const cache = h.makeCache();
        await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
        await cache.close();
      }
      tracked.mountInfo = null;
      const cache = h.makeCache();
      expect(await cache.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
    });

    it('refuses a pass-through filesystem it cannot place, but not a separate local one', async () => {
      const appStore = fs.mkdtempSync(path.join(h.tmpDir, 'app-store-'));
      const mountedApp = path.join(h.tmpDir, 'mounted-app');
      bind(appStore, mountedApp);
      // Present that mount as another device of the given filesystem type.
      const as = (fstype) => (text) => text.split('\n').map((line) => {
        const fields = line.split(' ');
        if (fields[4] !== mountedApp) return line;
        fields[2] = '4095:4095';
        fields[fields.indexOf('-', 6) + 1] = fstype;
        return fields.join(' ');
      }).join('\n');
      tracked.mountInfo = as('nfs4');
      const remote = h.makeCache({ stagingRoot: path.join(mountedApp, 'cache') });
      await expect(remote.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      await remote.close();
      tracked.mountInfo = as('ext4');
      const local = h.makeCache({ stagingRoot: path.join(mountedApp, 'cache') });
      expect(await local.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
    });
  });
});

// F7 — Windows: whoever can rename a directory on the cache path and create a junction in its
// place redirects removals into project storage. The lower-trust actor is this user's token
// restricted to Everyone / Authenticated Users / Users (tests/helpers/windows-restricted-token.js):
// it cannot read the private project files, but can do what a directory grants Authenticated
// Users. Every directory involved is test-owned; shared ACLs are granted only on them.
describe.runIf(process.platform === 'win32')('replaceable ancestors (F7, Windows)', () => {
  const junctions = [];
  const shared = [];
  afterEach(() => {
    for (const at of junctions.splice(0).reverse()) fs.rmSync(at, { force: true });
    for (const directory of shared.splice(0)) if (fs.existsSync(directory)) unshare(directory);
  });
  const share = (directory) => {
    shareWithAuthenticatedUsers(directory);
    shared.push(directory);
  };
  const denied = /^(UnauthorizedAccessException|IOException): /;
  const removalsOf = (name) => [...tracked.rmCalls].filter(([file]) => path.basename(file) === name)
    .reduce((sum, [, count]) => sum + count, 0);

  // A private project file at <project>/comic-preparations/<name>/pages.bin: exactly where a
  // removal of the cache's <root>/<name>/pages.bin lands once <root>'s parent leads to <project>.
  function victimProject(name) {
    const project = path.join(h.projectsRoot, 'victim-project');
    const victim = path.join(project, 'comic-preparations', name, 'pages.bin');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'project bytes');
    return {
      project,
      victim,
      intact: () => expect(fs.readFileSync(victim, 'utf8')).toBe('project bytes'),
    };
  }

  // The actor's replacement of `ancestor` by a junction into `project` (after proving it cannot
  // read the project's private file).
  const replace = (ancestor, project, victim) => {
    const results = asLowerTrustActor([['read', victim], ['move', ancestor, ancestor + '-moved'], ['junction', ancestor, project]]);
    if (results[2] === 'ok') junctions.push(ancestor);
    return results;
  };

  it('invalidates recent positive trust before unlink when an ancestor ACL becomes unsafe', async () => {
    const appdata = path.join(h.tmpDir, 'appdata');
    const anchor = path.join(appdata, 'anchor');
    const stagingRoot = path.join(anchor, 'comic-preparations');
    fs.mkdirSync(anchor, { recursive: true });
    // Keep the old verdict inside its reuse interval without relying on wall-clock timing.
    const time = Date.now() + 60_000;
    const cache = h.makeCache({ stagingRoot, _now: () => time });
    await cache.recover();
    const service = h.makeService({ cache, admission: createComicAdmission() });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    const reads = tracked.trustReads;
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
    expect(tracked.trustReads).toBe(reads);
    const [name] = fs.readdirSync(stagingRoot);
    const owned = fs.readFileSync(path.join(stagingRoot, name, 'pages.bin'));
    const bytes = cache.snapshot().retainedBytes;
    expect(bytes).toBeGreaterThan(0);
    const { project, victim, intact } = victimProject(name);
    const before = fs.lstatSync(appdata, { bigint: true }).ctimeNs;
    let attack = null;

    const restoreAnchor = () => {
      if (!fs.existsSync(anchor + '-moved')) return;
      fs.rmSync(anchor, { force: true });
      junctions.splice(junctions.indexOf(anchor), 1);
      fs.renameSync(anchor + '-moved', anchor);
    };
    try {
      share(appdata);
      expect(fs.lstatSync(appdata, { bigint: true }).ctimeNs).not.toBe(before);
      // Reproduce the validation-to-unlink transition: a stale verdict lets the restricted
      // actor redirect this exact unlink into the private project. A fresh refusal never calls it.
      tracked.onRemove = (directory) => {
        if (attack === null && path.basename(directory) === name) attack = replace(anchor, project, victim);
      };
      cache.invalidate({ projectId: comic.id[0], assetId: comic.id[1] }, { revision: 'retired' });
      await cache.sweep();
      if (attack !== null) {
        expect(attack[0]).toMatch(denied);
        expect(attack.slice(1)).toEqual(['ok', 'ok']);
      }
      intact();
      expect(attack).toBeNull();
      expect(removalsOf(name)).toBe(0);
      expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0, stranded: 1, strandedBytes: bytes, usedBytes: bytes });
      expect(fs.readFileSync(path.join(stagingRoot, name, 'pages.bin'))).toEqual(owned);

      // The same real restricted token cannot read the victim, but can rename the newly
      // writable ancestor and replace it with a junction. Later retries must still refuse.
      tracked.onRemove = null;
      const results = replace(anchor, project, victim);
      expect(results[0]).toMatch(denied);
      expect(results.slice(1)).toEqual(['ok', 'ok']);
      await cache.sweep();
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      intact();
      expect(removalsOf(name)).toBe(0);
      expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: bytes, usedBytes: bytes });
      expect(fs.readFileSync(path.join(anchor + '-moved', 'comic-preparations', name, 'pages.bin'))).toEqual(owned);

      restoreAnchor();
      unshare(appdata);
      // The same cache can refresh trust and release its obligation after safe restoration.
      await cache.sweep();
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
      expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0 });
      expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
      intact();
    } finally {
      tracked.onRemove = null;
      restoreAnchor();
      unshare(appdata);
    }
  });

  it.each([
    ['changed root permissions', (reading) => {
      reading.directories[0].rules.push({ sid: 'S-1-5-11', allow: true, mask: 0x1301bf, inheritOnly: false, inheritable: true });
      return reading;
    }],
    ['changed inherited permissions', (reading) => {
      reading.directories[0].rules.push({ sid: 'S-1-5-11', allow: true, mask: 0x1301bf, inheritOnly: true, inheritable: true });
      return reading;
    }],
    ['changed ownership', (reading) => {
      reading.directories[1].owner = 'S-1-5-21-1000-2000-3000-9999';
      return reading;
    }],
    ['an unresolved SID', (reading) => {
      reading.directories[0].rules.push({ sid: 'S-1-5-21-1000-2000-3000-9999', allow: true, mask: 0x1301bf, inheritOnly: false, inheritable: true });
      return reading;
    }],
    ['a reparse point', (reading) => {
      reading.directories[1].attributes |= 0x400;
      return reading;
    }],
    ['malformed trust evidence', () => null],
    ['a failed PowerShell inspection', () => { throw new Error('Directory permissions could not be read.'); }],
  ])('refuses %s after positive trust and retries once evidence is safe', async (_name, change) => {
    const time = Date.now() + 60_000;
    const cache = h.makeCache({ _now: () => time });
    await cache.recover();
    const directory = path.join(h.cacheRoot, 'comic-prep-Acl001');
    const pack = path.join(directory, 'pages.bin');
    fs.mkdirSync(directory);
    fs.writeFileSync(pack, 'owned cache bytes');
    // First establish an actual, measured cleanup obligation with a valid ACL reading.
    tracked.failRm = () => true;
    expect(await cache.recover()).toEqual({ removed: 0, failed: 1, uninspected: 0 });
    tracked.failRm = null;
    tracked.rmCalls.clear();
    const reads = tracked.trustReads;
    tracked.trustReading = change;
    await cache.sweep();
    expect(tracked.trustReads).toBeGreaterThan(reads);
    expect(removalsOf('comic-prep-Acl001')).toBe(0);
    expect(fs.readFileSync(pack, 'utf8')).toBe('owned cache bytes');
    expect(cache.snapshot()).toMatchObject({ stranded: 1, strandedBytes: 17, usedBytes: 17 });
    tracked.trustReading = null;
    await cache.sweep();
    expect(fs.existsSync(directory)).toBe(false);
    expect(cache.snapshot()).toMatchObject({ stranded: 0, strandedBytes: 0, usedBytes: 0 });
  });

  it('refuses a root below a shared directory before any cleanup, though the replacement is possible (reviewer reproduction)', async () => {
    const parent = path.join(h.tmpDir, 'shared');
    const stagingRoot = path.join(parent, 'app', 'comic-preparations');
    const leftover = path.join(stagingRoot, 'comic-prep-Lft001');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'pages.bin'), 'cache bytes');
    share(parent);
    const { project, victim, intact } = victimProject('comic-prep-Lft001');

    const cache = h.makeCache({ stagingRoot });
    // Refused for the root that inherits the shared grant, and for the replaceable ancestor.
    await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE', message: expect.stringMatching(/Other users|replaced/) });
    // Nothing is prepared into it either; pages are still read on demand.
    const service = h.makeService({ cache, admission: createComicAdmission() });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const { revision } = await service.getComicManifest(...comic.id);
    expect((await service.getComicPage(...comic.id, { revision, position: 1 })).prepared).toBe(false);
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 0, usedBytes: 0, stranded: 0 });
    // A root that does not exist yet is never created below the replaceable ancestor either.
    const fresh = h.makeCache({ stagingRoot: path.join(parent, 'app', 'fresh-cache') });
    await expect(fresh.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE', message: expect.stringMatching(/replaced/) });
    expect(fs.existsSync(path.join(parent, 'app', 'fresh-cache'))).toBe(false);

    // The refusal is not hypothetical: the lower-trust actor can carry out the reviewer's attack.
    const app = path.join(parent, 'app');
    const results = replace(app, project, victim);
    expect(results[0]).toMatch(denied);
    expect(results.slice(1)).toEqual(['ok', 'ok']);
    // Recovery, sweep and shutdown still delete nothing: not the victim, not the moved leftover.
    await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    await cache.sweep();
    expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(removalsOf('comic-prep-Lft001')).toBe(0);
    intact();
    expect(fs.readFileSync(path.join(app + '-moved', 'comic-preparations', 'comic-prep-Lft001', 'pages.bin'), 'utf8')).toBe('cache bytes');
  });

  it('keeps a preparation charged and deletes nothing once an ancestor becomes replaceable', async () => {
    const appdata = path.join(h.tmpDir, 'appdata');
    const anchor = path.join(appdata, 'anchor');
    fs.mkdirSync(anchor, { recursive: true });
    const stagingRoot = path.join(anchor, 'cache');
    const cache = h.makeCache({ stagingRoot });
    await cache.recover();
    const service = h.makeService({ cache, admission: createComicAdmission() });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
    const [name] = fs.readdirSync(stagingRoot);
    const bytes = cache.snapshot().retainedBytes;
    const { project, victim, intact } = victimProject(name);

    // A trusted administrator opens the application folder to Authenticated Users. If a removal
    // still ran, the actor would replace the ancestor in the middle of it.
    share(appdata);
    let attack = null;
    tracked.onRemove = (directory) => {
      if (attack === null && path.basename(directory) === name) attack = replace(anchor, project, victim);
    };
    h.clock.offset += COMIC_PREPARATION_CACHE_DEFAULTS.idleMs * 2;
    await cache.sweep();
    // Refused before anything was deleted: the bytes stay charged, no removal began.
    expect(attack).toBeNull();
    expect(removalsOf(name)).toBe(0);
    expect(cache.snapshot()).toMatchObject({ entries: 0, retiring: 0, stranded: 1, strandedBytes: bytes, usedBytes: bytes });
    expect(fs.readdirSync(path.join(stagingRoot, name))).toEqual(['pages.bin']);

    // The actor replaces the ancestor; every later attempt still refuses before touching anything.
    tracked.onRemove = null;
    const results = replace(anchor, project, victim);
    expect(results[0]).toMatch(denied);
    expect(results.slice(1)).toEqual(['ok', 'ok']);
    await cache.sweep();
    await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
    // A refused removal frees no capacity: another comic is not prepared.
    const other = h.addComic(fixture('comic-rar4-solid.cbr'));
    const otherRevision = (await service.getComicManifest(...other.id)).revision;
    expect((await service.getComicPage(...other.id, { revision: otherRevision, position: 1 })).prepared).toBe(false);
    await cache.whenIdle();
    expect(cache.snapshot()).toMatchObject({ entries: 0, stranded: 1, strandedBytes: bytes, usedBytes: bytes });
    expect(await cache.close()).toEqual({ stranded: 1, strandedBytes: bytes, unmeasured: 0 });
    expect(removalsOf(name)).toBe(0);
    intact();
    expect(fs.readdirSync(path.join(anchor + '-moved', 'cache', name))).toEqual(['pages.bin']);

    // Restored and private again, the next start removes the leftover.
    fs.rmSync(anchor, { force: true });
    junctions.splice(junctions.indexOf(anchor), 1);
    fs.renameSync(anchor + '-moved', anchor);
    unshare(appdata);
    const next = h.makeCache({ stagingRoot });
    expect(await next.recover()).toEqual({ removed: 1, failed: 0, uninspected: 0 });
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    intact();
  });

  it('prepares and cleans up in a private location, which the actor cannot redirect mid-removal', async () => {
    const { cache, service } = await setup();
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
    const [name] = h.staged();
    const { project, victim, intact } = victimProject(name);
    const app = path.dirname(h.cacheRoot);
    let attack = null;
    tracked.onRemove = (directory) => {
      if (attack !== null || path.basename(directory) !== name) return;
      attack = asLowerTrustActor([
        ['read', victim],
        ['move', app, app + '-moved'],
        ['move', h.cacheRoot, h.cacheRoot + '-moved'],
        ['move', directory, directory + '-moved'],
        ['junction', path.join(h.cacheRoot, 'comic-prep-Jnc001'), project],
        ['delete', path.join(directory, 'pages.bin')],
      ]);
    };
    h.clock.offset += COMIC_PREPARATION_CACHE_DEFAULTS.idleMs * 2;
    await cache.sweep();
    expect(attack).toHaveLength(6);
    for (const result of attack) expect(result).toMatch(denied);
    expect(h.staged()).toEqual([]);
    expect(cache.snapshot()).toMatchObject({ entries: 0, stranded: 0, strandedBytes: 0, usedBytes: 0 });
    expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    intact();
  });

  it('creates its root private even where the parent grants other users write access', async () => {
    // As in a per-user TEMP that also grants a sandbox group Modify: the parent may be written by
    // others, but nobody else can remove a private child of it.
    const parent = path.join(h.tmpDir, 'writable-parent');
    fs.mkdirSync(parent);
    share(parent);
    const stagingRoot = path.join(parent, 'cache');
    const { cache, service } = await setup({ cacheOptions: { stagingRoot } });
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
    const [name] = fs.readdirSync(stagingRoot);
    const attempts = asLowerTrustActor([
      ['move', stagingRoot, stagingRoot + '-moved'],
      ['junction', path.join(stagingRoot, 'comic-prep-Jnc002'), h.projectsRoot],
      ['delete', path.join(stagingRoot, name, 'pages.bin')],
    ]);
    for (const result of attempts) expect(result).toMatch(denied);
    expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    // An existing root that others can write into is never re-permissioned, only refused.
    const open = path.join(parent, 'open-cache');
    fs.mkdirSync(open);
    const refused = h.makeCache({ stagingRoot: open });
    await expect(refused.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE', message: expect.stringMatching(/Other users/) });
  });
});

// The application's cache location: private temporary storage selected automatically.
describe('automatic private cache root', () => {
  const created = [];
  const saved = {};
  afterEach(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
    for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  // Points os.tmpdir() somewhere else for one test.
  function useTemporaryDirectory(directory) {
    for (const key of process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']) {
      if (!Object.hasOwn(saved, key)) saved[key] = process.env[key];
      process.env[key] = directory;
    }
  }

  it('names a stable per-instance (and per-user) directory in the system temporary storage', async () => {
    const instance = path.join(h.tmpDir, 'app');
    const root = defaultComicPreparationCacheRoot(instance);
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(process.platform === 'win32'
      ? /^creatorcrate-comic-prep-[0-9a-f]{16}$/
      : new RegExp(`^creatorcrate-comic-prep-${process.getuid?.()}-[0-9a-f]{16}$`));
    expect(defaultComicPreparationCacheRoot(instance + path.sep)).toBe(root);
    expect(defaultComicPreparationCacheRoot(path.join(h.tmpDir, 'other-app'))).not.toBe(root);
    expect(() => defaultComicPreparationCacheRoot('relative/app')).toThrow(TypeError);
    const protectedRoots = [h.projectsRoot];
    // Exactly one of instance and stagingRoot.
    expect(() => createComicPreparationCache({ protectedRoots })).toThrow(TypeError);
    expect(() => createComicPreparationCache({ instance, stagingRoot: h.cacheRoot, protectedRoots })).toThrow(TypeError);
    const cache = createComicPreparationCache({ instance, protectedRoots });
    expect(cache.stagingRoot).toBe(root);
    await cache.close();
  });

  it('prepares, serves and recovers in the selected location with no setup', async () => {
    const instance = path.join(h.tmpDir, 'app');
    const root = defaultComicPreparationCacheRoot(instance);
    created.push(root);
    expect(fs.existsSync(root)).toBe(false);
    const { cache, service } = await setup({ cacheOptions: { stagingRoot: undefined, instance } });
    expect(fs.statSync(root).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    const comic = h.addComic(fixture('comic-rar5-solid.cbr'));
    const revision = await prepare(service, cache, comic);
    expect((await service.getComicPage(...comic.id, { revision, position: 2 })).prepared).toBe(true);
    const [name] = fs.readdirSync(root);
    expect(name).toMatch(/^comic-prep-[A-Za-z0-9]{6}$/);
    // Abandoned by a crash: the next instance with the same data root removes it.
    const leftover = path.join(root, 'comic-prep-Old002');
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'pages.bin'), 'stale');
    expect(await cache.close()).toEqual({ stranded: 0, strandedBytes: 0, unmeasured: 0 });
    expect(fs.readdirSync(root)).toEqual(['comic-prep-Old002']);
    const next = h.makeCache({ stagingRoot: undefined, instance });
    expect(await next.recover()).toEqual({ removed: 1, failed: 0, uninspected: 0 });
    expect(fs.readdirSync(root)).toEqual([]);
    // Temporary storage cleared between runs is simply created again.
    await next.close();
    fs.rmSync(root, { recursive: true });
    const again = h.makeCache({ stagingRoot: undefined, instance });
    expect(await again.recover()).toEqual({ removed: 0, failed: 0, uninspected: 0 });
    expect(fs.existsSync(root)).toBe(true);
  });

  it('refuses a temporary directory redirected to storage other users can replace', async () => {
    const shared = path.join(h.tmpDir, 'shared');
    const temp = path.join(shared, 'temp');
    fs.mkdirSync(temp, { recursive: true });
    if (process.platform === 'win32') shareWithAuthenticatedUsers(shared);
    else fs.chmodSync(shared, 0o777);
    try {
      useTemporaryDirectory(temp);
      const instance = path.join(h.tmpDir, 'app');
      const root = defaultComicPreparationCacheRoot(instance);
      expect(path.dirname(root)).toBe(temp);
      const cache = h.makeCache({ stagingRoot: undefined, instance });
      await expect(cache.recover()).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' });
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      if (process.platform === 'win32') unshare(shared);
    }
  });
});
