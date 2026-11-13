// A3.3c-2 — HTTP comic manifest and numbered-page routes.
//
// Real application graphs (createApp / createApplicationContext), database, preview-service
// authority, the application's comic runtime (one admission + recovered preparation cache),
// the comic media service, the CBZ/CBR/CB7 readers and the A1 decoder. Only descriptor
// open/close are wrapped (to prove none leak); deterministic cancellation and failure tests
// inject a service built by the same factory with its test-only timing hooks.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import request from 'supertest';
import express from 'express';
import { createMediaRouter } from '../src/routes/media.js';
import { AUTH_CONFIG } from './helpers/auth.js';
import sharp from 'sharp';
import { makeZip } from './helpers/zip-fixture.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';

// Every recover() on Windows reads the cache path's ACLs through Windows PowerShell.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const handles = vi.hoisted(() => ({ opened: 0, closed: 0, beforeClose: null }));

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
      try { await handles.beforeClose?.(); }
      finally {
        handles.closed += 1;
        await actual.closeAssetFileAsync(opened);
      }
    },
  };
});

const { openDatabase, runMigrations, closeDatabase } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { createApplicationContext } = await import('../src/app-context.js');
const { ensureAuthEnablement } = await import('../src/auth/auth-state.js');
const { createProjectRepository } = await import('../src/data/project-repository.js');
const { createAssetRepository } = await import('../src/data/asset-repository.js');
const { formatProjectDirName } = await import('../src/storage/project-storage.js');
const { createPreviewService } = await import('../src/services/preview-service.js');
const { createMediaService } = await import('../src/services/media-service.js');
const { createComicMediaService, COMIC_REVISION_RE } = await import('../src/services/comic-media-service.js');
const { createComicAdmission } = await import('../src/services/comic-admission.js');
const { createComicRuntime } = await import('../src/services/comic-runtime.js');
const { createComicRenditionSupervisor } = await import('../src/services/comic-rendition-process.js');
const { defaultComicPreparationCacheRoot } = await import('../src/services/comic-preparation-cache.js');

const SevenZip = createRequire(import.meta.url)('7z-wasm');
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const DECODER_FIXTURES = fileURLToPath(new URL('./fixtures/archive-decoder/', import.meta.url));
const APP_NAME = 'CreatorCrate';
const CBR_MIME = 'application/vnd.comicbook-rar';
const CBZ_MIME = 'application/vnd.comicbook+zip';

const img = {};
let archives;

async function make7z(entries) {
  const module = await SevenZip({ print() {}, printErr() {} });
  module.FS.mkdirTree('/w');
  module.FS.chdir('/w');
  for (const [name, data] of entries) module.FS.writeFile('/w/' + name, data);
  const code = module.callMain(['a', '-t7z', '-mtc=off', '-mta=off', '-mtm=off', '-mmt=1', '-bsp0', '-bso0', '-bse0',
    '/out.7z', ...entries.map(([name]) => name)]);
  if (code !== 0) throw new Error('7z-wasm failed with ' + code);
  return Buffer.from(module.FS.readFile('/out.7z'));
}

function binary(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

// ─── Harness ─────────────────────────────────────────────────────────────────────────────

const harnesses = [];

function makeHarness({ runtimeOptions, appOptions = () => ({}) } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-comic-http-'));
  const appDataRoot = path.join(tmpDir, 'app');
  const projectsRoot = path.join(tmpDir, 'projects');
  const previewRoot = path.join(appDataRoot, 'previews');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(previewRoot, { recursive: true });
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const db = openDatabase(path.join(appDataRoot, 'creatorcrate.db'));
  runMigrations(db, MIGRATIONS_DIR);
  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);
  const runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 }, ...runtimeOptions });
  const servers = [];

  const h = {
    tmpDir, appDataRoot, projectsRoot, previewRoot, db, runtime, csrfPepper, app: null,
    previewService: null,
    async start() {
      await runtime.start();
      h.previewService = createPreviewService({ db, projectsRoot, previewRoot });
      h.app = h.buildApp();
      return h;
    },
    buildApp(extra = {}) {
      return createApp({ appName: APP_NAME, db, projectsRoot, previewRoot }, {
        appDataRoot, authState: { csrfPepper }, comicRuntime: runtime, previewService: h.previewService,
        ...appOptions(h), ...extra,
      });
    },
    createProject(title) {
      let project = projectRepo.create({
        title, projectType: 'images', slug: slugify(title, { lowercase: true }), description: '', notes: '',
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const relPath = formatProjectDirName(project.id, project.slug);
      const absPath = path.resolve(projectsRoot, relPath);
      fs.mkdirSync(absPath, { recursive: true });
      project = projectRepo.setProjectDir(project.id, relPath);
      bindTestProjectOwnership(db, project.id, absPath);
      return { project, absPath };
    },
    index(ctx, relPath, mimeType) {
      const stat = fs.statSync(path.join(ctx.absPath, relPath));
      return assetRepo.upsert(ctx.project.id, relPath, {
        filename: relPath, extension: relPath.split('.').pop().toLowerCase(), mimeType,
        sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
      });
    },
    addAsset(title, relPath, bytes, mimeType) {
      const ctx = h.createProject(title);
      const full = path.join(ctx.absPath, relPath);
      fs.writeFileSync(full, bytes);
      const asset = h.index(ctx, relPath, mimeType);
      const base = `/projects/${ctx.project.id}/assets/${asset.id}`;
      return { ctx, asset, full, base, projectId: ctx.project.id, assetId: asset.id };
    },
    listen(app) {
      const server = http.createServer(app);
      servers.push(server);
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    async cleanup() {
      for (const server of servers) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
      }
      await runtime.close();
      if (db.open) closeDatabase(db);
      // The automatic cache root of this disposable installation (empty once its runtime closed).
      fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
  harnesses.push(h);
  return h;
}

async function manifestOf(app, base) {
  const res = await request(app).get(base + '/comic');
  expect(res.status).toBe(200);
  return res.body;
}

function getPage(app, url) {
  return request(app).get(url).buffer(true).parse(binary);
}

let h;

beforeAll(async () => {
  const gradient = (width, height, seed) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7 + seed) & 0xff;
    return sharp(raw, { raw: { width, height, channels: 3 } });
  };
  img.jpeg = await gradient(48, 64, 10).jpeg().toBuffer();
  img.png = await gradient(48, 64, 20).png().toBuffer();
  img.tallPng = await gradient(40, 200, 50).png().toBuffer();
  img.animatedWebp = await makeAnimatedWebp(3, { width: 20, height: 30 });
  img.animatedGif = await sharp([
    { create: { width: 16, height: 24, channels: 3, background: '#ff0000' } },
    { create: { width: 16, height: 24, channels: 3, background: '#00ff00' } },
  ], { join: { animated: true } }).gif({ loop: 0 }).toBuffer();
  const bigJpeg = await gradient(400, 600, 60).jpeg({ quality: 95 }).toBuffer();
  img.truncatedJpeg = bigJpeg.subarray(0, Math.floor(bigJpeg.length / 3));
  img.text = Buffer.from('this is not an image, only text. '.repeat(10));
  archives = {
    cbz: makeZip([
      { name: 'p10.png', data: img.tallPng, compression: 'deflate' },
      { name: 'p1.jpg', data: img.jpeg },
      { name: 'p2.png', data: img.text },
      { name: 'p3.webp', data: img.animatedWebp },
      { name: 'p4.jpg', data: img.truncatedJpeg },
      { name: '__MACOSX/._p1.jpg', data: Buffer.from('junk') },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
    ]),
    cb7: await make7z([['b.png', img.png], ['a.jpg', img.jpeg], ['c.gif', img.animatedGif]]),
    cbr: (name) => fs.readFileSync(path.join(COMICS, name)),
  };
  h = await makeHarness().start();
});

afterEach(async () => {
  handles.beforeClose = null;
  // No request leaves a descriptor open or an admission slot/reservation behind (background
  // preparations scheduled by solid CBR/CB7 reads are awaited first: they own their slot).
  await h.runtime.preparationCache?.whenIdle();
  expect(handles.closed).toBe(handles.opened);
  expect(h.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
});

afterAll(async () => {
  for (const harness of harnesses) await harness.cleanup();
});

// ─── Manifests ───────────────────────────────────────────────────────────────────────────

describe('GET /projects/:projectId/assets/:assetId/comic', () => {
  it('returns an authorized CBZ manifest with ordered numbered pages and revision-bound URLs', async () => {
    const comic = h.addAsset('CBZ manifest', 'book.cbz', archives.cbz, CBZ_MIME);
    const res = await request(h.app).get(comic.base + '/comic');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const body = res.body;
    expect(Object.keys(body).sort()).toEqual([
      'assetId', 'displayImageTypes', 'format', 'pageCount', 'pages', 'preparation', 'projectId', 'revision',
      'unavailablePositions',
    ]);
    expect(body).toMatchObject({
      projectId: comic.projectId, assetId: comic.assetId, format: 'cbz', pageCount: 5,
      displayImageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      preparation: { solid: false, state: 'not-required' },
      unavailablePositions: [],
    });
    expect(body.revision).toMatch(COMIC_REVISION_RE);
    expect(body.pages.map((page) => [page.position, page.name])).toEqual([
      [1, 'p1.jpg'], [2, 'p2.png'], [3, 'p3.webp'], [4, 'p4.jpg'], [5, 'p10.png'],
    ]);
    for (const page of body.pages) {
      expect(Object.keys(page).sort()).toEqual(['available', 'name', 'position', 'problem', 'url']);
      expect(page.url).toBe(`/projects/${comic.projectId}/assets/${comic.assetId}/comic/pages/${page.position}?v=${body.revision}`);
    }
    // No filesystem path, member path, selector, container or size crosses the boundary.
    const text = JSON.stringify(body);
    expect(text).not.toContain(h.tmpDir.replace(/\\/g, '\\\\'));
    expect(text).not.toContain('__MACOSX');
    expect(text).not.toMatch(/entryIndex|member|container|declaredMimeType|"size"/);
  });

  it.each([
    ['comic-rar4.cbr', false],
    ['comic-rar5.cbr', false],
    ['comic-rar5-solid.cbr', true],
  ])('returns an authorized CBR manifest (%s)', async (fixture, solid) => {
    const comic = h.addAsset('CBR manifest ' + fixture, 'book.cbr', archives.cbr(fixture), CBR_MIME);
    const body = await manifestOf(h.app, comic.base);
    expect(body).toMatchObject({
      format: 'cbr', pageCount: 6, preparation: { solid, state: solid ? 'on-demand' : 'not-required' },
    });
    // Natural order across chapters; junk, metadata and nested archives never become pages.
    expect(body.pages.map((page) => page.name))
      .toEqual(['page1.jpg', 'page2.png', 'page10.webp', 'page1.gif', 'page2.png', 'page1.png']);
    expect(body.pages.map((page) => page.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(body)).not.toMatch(/ch1\/|ch10\/|nested|ComicInfo/);
  });

  it('returns an authorized CB7 manifest', async () => {
    const comic = h.addAsset('CB7 manifest', 'book.cb7', archives.cb7, 'application/x-cb7');
    const body = await manifestOf(h.app, comic.base);
    expect(body).toMatchObject({ format: 'cb7', pageCount: 3 });
    expect(body.pages.map((page) => page.name)).toEqual(['a.jpg', 'b.png', 'c.gif']);
  });

  it('rejects malformed ids, unknown and wrong-project assets as not found', async () => {
    const comic = h.addAsset('Owner', 'book.cbz', archives.cbz, CBZ_MIME);
    const other = h.createProject('Other');
    for (const url of [
      `/projects/0/assets/${comic.assetId}/comic`,
      `/projects/${comic.projectId}/assets/01/comic`,
      `/projects/${comic.projectId}/assets/abc/comic`,
      `/projects/${comic.projectId}/assets/999999/comic`,
      `/projects/${other.project.id}/assets/${comic.assetId}/comic`,
      `/projects/${other.project.id}/assets/${comic.assetId}/comic/pages/1?v=${'0'.repeat(32)}`,
    ]) {
      const res = await request(h.app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toBe('Not found');
    }
  });

  it('rejects generic archives and non-comic assets as unsupported', async () => {
    const zip = h.addAsset('Generic zip', 'pages.zip', archives.cbz, 'application/zip');
    const png = h.addAsset('Image', 'image.png', img.png, 'image/png');
    for (const { base } of [zip, png]) {
      const res = await request(h.app).get(base + '/comic');
      expect(res.status).toBe(415);
      expect(res.text).toBe('Unsupported media type');
      const page = await request(h.app).get(`${base}/comic/pages/1?v=${'0'.repeat(32)}`);
      expect(page.status).toBe(415);
    }
  });

  it('reports a corrupt archive as unreadable and a deleted source as not found', async () => {
    const corrupt = h.addAsset('Corrupt', 'book.cbz', Buffer.from('not a zip archive at all '.repeat(20)), CBZ_MIME);
    const res = await request(h.app).get(corrupt.base + '/comic');
    expect(res.status).toBe(422);
    expect(res.text).toBe('The comic archive cannot be read.');

    const deleted = h.addAsset('Deleted', 'book.cbz', archives.cbz, CBZ_MIME);
    const { revision } = await manifestOf(h.app, deleted.base);
    fs.rmSync(deleted.full);
    expect((await request(h.app).get(deleted.base + '/comic')).status).toBe(404);
    expect((await request(h.app).get(`${deleted.base}/comic/pages/1?v=${revision}`)).status).toBe(404);
  });

  // Recognized archive-format refusals answer 422, never 500 "Media error".
  it.each([
    ['duplicates.cb7', 'duplicate-names.7z', 'application/x-cb7'],
    ['multipart.cbr', 'rar5-multivolume.part01.rar', CBR_MIME],
  ])('reports %s as unreadable, not an internal error', async (name, fixture, mimeType) => {
    const comic = h.addAsset('Refused ' + name, name, fs.readFileSync(path.join(DECODER_FIXTURES, fixture)), mimeType);
    const res = await request(h.app).get(comic.base + '/comic');
    expect(res.status).toBe(422);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toBe('The comic archive cannot be read.');
  });
});

// ─── Pages ───────────────────────────────────────────────────────────────────────────────

describe('GET /projects/:projectId/assets/:assetId/comic/pages/:position', () => {
  it('serves CBZ first and last pages as their verified image bytes', async () => {
    const comic = h.addAsset('CBZ pages', 'book.cbz', archives.cbz, CBZ_MIME);
    const body = await manifestOf(h.app, comic.base);
    const first = await getPage(h.app, body.pages[0].url);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['content-length']).toBe(String(img.jpeg.length));
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.body.equals(img.jpeg)).toBe(true);
    const last = await getPage(h.app, body.pages[4].url);
    expect(last.status).toBe(200);
    expect(last.headers['content-type']).toBe('image/png');
    expect(last.body.equals(img.tallPng)).toBe(true);
    // The original archive is never the response and is left unchanged.
    expect(fs.readFileSync(comic.full).equals(archives.cbz)).toBe(true);
  });

  it('answers HEAD with the page headers and no body', async () => {
    const comic = h.addAsset('CBZ head', 'book.cbz', archives.cbz, CBZ_MIME);
    const body = await manifestOf(h.app, comic.base);
    const res = await request(h.app).head(body.pages[0].url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-length']).toBe(String(img.jpeg.length));
    expect(res.body).toEqual({});
  });

  it.each([
    ['comic-rar4.cbr'],
    ['comic-rar5.cbr'],
  ])('serves compressed CBR pages (%s)', async (fixture) => {
    const comic = h.addAsset('CBR pages ' + fixture, 'book.cbr', archives.cbr(fixture), CBR_MIME);
    const body = await manifestOf(h.app, comic.base);
    const first = await getPage(h.app, body.pages[0].url);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(await sharp(first.body).metadata()).toMatchObject({ format: 'jpeg', width: 48, height: 64 });
    const last = await getPage(h.app, body.pages[5].url);
    expect(last.headers['content-type']).toBe('image/png');
    expect(await sharp(last.body).metadata()).toMatchObject({ format: 'png', width: 96, height: 128 });
  });

  it('serves CB7 pages and renders animated pages as stills', async () => {
    const comic = h.addAsset('CB7 pages', 'book.cb7', archives.cb7, 'application/x-cb7');
    const body = await manifestOf(h.app, comic.base);
    const first = await getPage(h.app, body.pages[0].url);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.body.equals(img.jpeg)).toBe(true);
    const gif = await getPage(h.app, body.pages[2].url);
    expect(gif.status).toBe(200);
    expect(gif.headers['content-type']).toBe('image/png');
    const meta = await sharp(gif.body).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 16, height: 24 });
    expect(meta.pages ?? 1).toBe(1);

    const cbz = h.addAsset('Animated CBZ', 'book.cbz', archives.cbz, CBZ_MIME);
    const webp = await getPage(h.app, (await manifestOf(h.app, cbz.base)).pages[2].url);
    expect(webp.headers['content-type']).toBe('image/webp');
    const webpMeta = await sharp(webp.body, { animated: true }).metadata();
    expect(webpMeta).toMatchObject({ format: 'webp', width: 20, height: 30 });
    expect(webpMeta.pages ?? 1).toBe(1);
  });

  it('serves solid CBR pages on demand and then from the shared preparation', async () => {
    const comic = h.addAsset('Solid', 'book.cbr', archives.cbr('comic-rar5-solid.cbr'), CBR_MIME);
    const body = await manifestOf(h.app, comic.base);
    const cache = h.runtime.preparationCache;
    await cache.whenIdle();
    const before = cache.snapshot().entries;
    const last = await getPage(h.app, body.pages[5].url);
    expect(last.status).toBe(200);
    expect(await sharp(last.body).metadata()).toMatchObject({ format: 'png', width: 96, height: 128 });
    await cache.whenIdle();
    expect(cache.snapshot().entries).toBe(before + 1);
    expect((await manifestOf(h.app, comic.base)).preparation).toEqual({ solid: true, state: 'ready' });
    // Pages served from the preparation are the same verified renditions.
    const again = await getPage(h.app, body.pages[5].url);
    expect(again.body.equals(last.body)).toBe(true);
    const animated = await getPage(h.app, body.pages[3].url);
    expect(animated.headers['content-type']).toBe('image/png');
    expect(await sharp(animated.body).metadata()).toMatchObject({ width: 16, height: 24 });
  });

  it('refuses invalid positions and missing or malformed revisions before reading', async () => {
    const comic = h.addAsset('Invalid', 'book.cbz', archives.cbz, CBZ_MIME);
    const { revision } = await manifestOf(h.app, comic.base);
    const opened = handles.opened;
    for (const position of ['0', '01', '-1', '1.5', 'abc', '1e2', '99999999999999999999']) {
      const res = await request(h.app).get(`${comic.base}/comic/pages/${position}?v=${revision}`);
      expect(res.status, position).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    for (const query of ['', '?v=', '?v=abc', `?v=${revision.toUpperCase()}`, `?v=${revision}0`,
      `?v=${revision}&v=${revision}`, `?v[]=${revision}`, `?version=${revision}`]) {
      const res = await request(h.app).get(`${comic.base}/comic/pages/1${query}`);
      expect(res.status, query).toBe(400);
    }
    // Nothing was opened for any refused request.
    expect(handles.opened).toBe(opened);
    // Beyond the last page: not found.
    expect((await request(h.app).get(`${comic.base}/comic/pages/6?v=${revision}`)).status).toBe(404);
    // No archive member or path is addressable.
    for (const url of [`${comic.base}/comic/pages/p1.jpg?v=${revision}`, `${comic.base}/comic/p1.jpg`,
      `${comic.base}/comic/pages/..%2Fp1.jpg?v=${revision}`, `${comic.base}/comic/pages/1/p1.jpg?v=${revision}`]) {
      const res = await request(h.app).get(url);
      expect([400, 404], url).toContain(res.status);
      expect(res.headers['content-type'] ?? '').not.toMatch(/^image\//);
    }
  });

  it('reports corrupt and invalid pages as unavailable without a 200', async () => {
    const comic = h.addAsset('Corrupt pages', 'book.cbz', archives.cbz, CBZ_MIME);
    const body = await manifestOf(h.app, comic.base);
    for (const position of [2, 4]) {
      const res = await request(h.app).get(body.pages[position - 1].url);
      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.text).toBe('This page cannot be displayed.');
    }
    // Other pages of the same comic stay readable.
    expect((await getPage(h.app, body.pages[0].url)).status).toBe(200);
  });
});

// ─── Source revision ─────────────────────────────────────────────────────────────────────

describe('source revision over HTTP', () => {
  it('fails an old revision after replacement between manifest and page, and serves the new one', async () => {
    const comic = h.addAsset('Replaced', 'book.cbr', archives.cbr('comic-rar4.cbr'), CBR_MIME);
    const old = await manifestOf(h.app, comic.base);
    fs.writeFileSync(comic.full, archives.cbr('comic-rar5.cbr'));
    // Not yet re-indexed: the source no longer matches its index.
    const unindexed = await request(h.app).get(old.pages[0].url);
    expect(unindexed.status).toBe(409);
    expect(unindexed.text).toBe('The comic has changed since it was indexed.');
    // Re-indexed: the old revision is stale, never answered with the new source's page.
    h.index(comic.ctx, 'book.cbr', CBR_MIME);
    const stale = await request(h.app).get(old.pages[0].url);
    expect(stale.status).toBe(409);
    expect(stale.text).toBe('The comic has changed; reload its pages.');
    const fresh = await manifestOf(h.app, comic.base);
    expect(fresh.revision).not.toBe(old.revision);
    expect(fresh.pages[0].url).toContain(`v=${fresh.revision}`);
    expect((await getPage(h.app, fresh.pages[0].url)).status).toBe(200);
  });

  it('fails a page whose source is replaced while the page is being processed', async () => {
    const comic = h.addAsset('During', 'book.cbz', archives.cbz, CBZ_MIME);
    const { pages } = await manifestOf(h.app, comic.base);
    const service = createComicMediaService({
      previewService: h.previewService, projectsRoot: h.projectsRoot, admission: h.runtime.admission,
      _hooks: {
        afterRead: () => {
          fs.writeFileSync(comic.full, makeZip([{ name: 'p1.jpg', data: img.jpeg }]));
          h.index(comic.ctx, 'book.cbz', CBZ_MIME);
        },
      },
    });
    const res = await request(h.buildApp({ comicMediaService: service })).get(pages[0].url);
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('never serves a preparation for a source replaced while or after it was prepared', async () => {
    const cache = h.runtime.preparationCache;
    // While preparing: the source is replaced (and re-indexed) before the preparation reads it.
    const during = h.addAsset('Preparing', 'book.cbr', archives.cbr('comic-rar5-solid.cbr'), CBR_MIME);
    const service = createComicMediaService({
      previewService: h.previewService, projectsRoot: h.projectsRoot, admission: h.runtime.admission,
      preparationCache: cache,
      _hooks: {
        beforePrepare: () => {
          fs.writeFileSync(during.full, archives.cbr('comic-rar4-solid.cbr'));
          h.index(during.ctx, 'book.cbr', CBR_MIME);
        },
      },
    });
    const app = h.buildApp({ comicMediaService: service });
    const old = await manifestOf(app, during.base);
    const entries = cache.snapshot().entries;
    expect((await getPage(app, old.pages[0].url)).status).toBe(200);
    await cache.whenIdle();
    expect(cache.snapshot().entries).toBe(entries);
    expect((await request(app).get(old.pages[1].url)).status).toBe(409);
    const fresh = await manifestOf(app, during.base);
    expect(fresh.revision).not.toBe(old.revision);
    expect((await getPage(app, fresh.pages[5].url)).status).toBe(200);
    await cache.whenIdle();

    // After the preparation exists: a replacement makes its revision stale.
    const after = h.addAsset('Prepared', 'book.cbr', archives.cbr('comic-rar5-solid.cbr'), CBR_MIME);
    const prepared = await manifestOf(h.app, after.base);
    expect((await getPage(h.app, prepared.pages[0].url)).status).toBe(200);
    await cache.whenIdle();
    expect((await manifestOf(h.app, after.base)).preparation.state).toBe('ready');
    fs.writeFileSync(after.full, archives.cbr('comic-rar4-solid.cbr'));
    h.index(after.ctx, 'book.cbr', CBR_MIME);
    expect((await request(h.app).get(prepared.pages[1].url)).status).toBe(409);
    const replaced = await manifestOf(h.app, after.base);
    const page = await getPage(h.app, replaced.pages[0].url);
    expect(page.status).toBe(200);
    expect(await sharp(page.body).metadata()).toMatchObject({ format: 'jpeg', width: 48, height: 64 });
    await cache.whenIdle();
  });

  it('re-authorizes every page after an asset moves to another project or is removed', async () => {
    const comic = h.addAsset('Moving', 'book.cbz', archives.cbz, CBZ_MIME);
    const { pages } = await manifestOf(h.app, comic.base);
    expect((await getPage(h.app, pages[0].url)).status).toBe(200);
    const elsewhere = h.createProject('Elsewhere');
    h.db.prepare('UPDATE assets SET project_id = ? WHERE id = ?').run(elsewhere.project.id, comic.assetId);
    expect((await request(h.app).get(pages[0].url)).status).toBe(404);
    h.db.prepare('UPDATE assets SET project_id = ? WHERE id = ?').run(comic.projectId, comic.assetId);
    expect((await getPage(h.app, pages[0].url)).status).toBe(200);
    h.db.prepare('DELETE FROM assets WHERE id = ?').run(comic.assetId);
    expect((await request(h.app).get(pages[0].url)).status).toBe(404);
    expect((await request(h.app).get(comic.base + '/comic')).status).toBe(404);
  });
});

// ─── Admission, cancellation and lifecycle ───────────────────────────────────────────────

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('admission and client disconnects', () => {
  it('answers 503 when the shared admission is exhausted, and recovers', async () => {
    const busy = await makeHarness({
      runtimeOptions: { preparation: false, admissionOptions: { maxActive: 1, maxQueued: 0 } },
    }).start();
    const comic = busy.addAsset('Busy', 'book.cbz', archives.cbz, CBZ_MIME);
    const { pages } = await manifestOf(busy.app, comic.base);
    const gate = deferred();
    const holder = busy.runtime.admission.run(() => gate.promise, { weightBytes: 1024 });
    const refused = await request(busy.app).get(pages[0].url);
    expect(refused.status).toBe(503);
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.text).toBe('Comics are busy; try again shortly.');
    expect((await request(busy.app).get(comic.base + '/comic')).status).toBe(503);
    gate.resolve();
    await holder;
    expect((await getPage(busy.app, pages[0].url)).status).toBe(200);
    expect(busy.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
  });

  it('cancels a queued request when its client disconnects, releasing its place', async () => {
    const comic = h.addAsset('Queued disconnect', 'book.cbz', archives.cbz, CBZ_MIME);
    const { pages } = await manifestOf(h.app, comic.base);
    const admission = createComicAdmission({ maxActive: 1 });
    const service = createComicMediaService({ previewService: h.previewService, projectsRoot: h.projectsRoot, admission });
    const port = await h.listen(h.buildApp({ comicMediaService: service }));
    const gate = deferred();
    const holder = admission.run(() => gate.promise, { weightBytes: 1024 });
    const opened = handles.opened;
    const client = http.get({ host: '127.0.0.1', port, path: pages[0].url });
    client.on('error', () => {});
    await vi.waitFor(() => expect(admission.snapshot().queued).toBe(1));
    client.destroy();
    await vi.waitFor(() => expect(admission.snapshot().queued).toBe(0));
    gate.resolve();
    await holder;
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
    // The cancelled request never opened the source.
    expect(handles.opened).toBe(opened);
  });

  it('cancels an active read when its client disconnects, without writing or leaking', async () => {
    const comic = h.addAsset('Active disconnect', 'book.cbr', archives.cbr('comic-rar5.cbr'), CBR_MIME);
    const { pages } = await manifestOf(h.app, comic.base);
    const entered = deferred();
    const gate = deferred();
    const outcomes = [];
    const real = createComicMediaService({
      previewService: h.previewService, projectsRoot: h.projectsRoot, admission: h.runtime.admission,
      _hooks: { afterRead: async () => { entered.resolve(); await gate.promise; } },
    });
    const service = {
      getComicManifest: real.getComicManifest,
      getComicPage: (...args) => {
        const pending = real.getComicPage(...args);
        outcomes.push(pending.then(() => 'served', (err) => err.code));
        return pending;
      },
    };
    const app = h.buildApp({ comicMediaService: service });
    const port = await h.listen(app);
    const client = http.get({ host: '127.0.0.1', port, path: pages[0].url });
    client.on('error', () => {});
    await entered.promise;
    expect(h.runtime.admission.snapshot().active).toBe(1);
    client.destroy();
    // Give the server a moment to observe the closed connection, then let the read continue.
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve();
    expect(await outcomes[0]).toBe('CANCELLED');
    await vi.waitFor(() => expect(h.runtime.admission.snapshot()).toMatchObject({ active: 0, reservedBytes: 0 }));
    expect(handles.closed).toBe(handles.opened);
  });

  for (const target of ['stats', 'convert']) {
    it(`kills a costly rendition child when its client disconnects during ${target}, without writing or holding the slot`, async () => {
      // 36 MP: a full rendition is metadata, a whole-image stats() decode and a downscale.
      const width = 6000;
      const raw = Buffer.alloc(width * width * 3);
      for (let y = 0; y < width; y += 1) raw.fill((y * 13) & 0xff, y * width * 3, (y + 1) * width * 3);
      const costly = await sharp(raw, { raw: { width, height: width, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
      const comic = h.addAsset(`Rendition disconnect ${target}`, 'book.cbz',
        makeZip([{ name: 'p1.png', data: costly }, { name: 'p2.jpg', data: img.jpeg }]), CBZ_MIME);
      const { pages } = await manifestOf(h.app, comic.base);
      const reached = deferred();
      const phases = [];
      let phasesAtAbort = null;
      const outcomes = [];
      // F1a: an observed supervisor (the application's runtime owns its own the same way).
      const children = [];
      const atExit = [];
      const renditions = createComicRenditionSupervisor({
        hooks: {
          spawned: ({ pid }) => children.push({ pid, exitedAt: null }),
          exited: ({ pid }) => {
            children.find((child) => child.pid === pid).exitedAt = performance.now();
            atExit.push(h.runtime.admission.snapshot());
          },
        },
      });
      const real = createComicMediaService({
        previewService: h.previewService, projectsRoot: h.projectsRoot, admission: h.runtime.admission, renditions,
        _hooks: {
          renditionPhase: ({ phase, position }) => {
            phases.push([position, phase]);
            if (position === 1 && phase === target) reached.resolve();
          },
        },
      });
      let abortedAt = null;
      const service = {
        getComicManifest: real.getComicManifest,
        getComicPage: (projectId, assetId, options) => {
          options.signal.addEventListener('abort', () => {
            abortedAt = performance.now();
            phasesAtAbort = [...phases];
          }, { once: true });
          const pending = real.getComicPage(projectId, assetId, options);
          outcomes.push(pending.then(() => 'served', (err) => err.code));
          return pending;
        },
      };
      const port = await h.listen(h.buildApp({ comicMediaService: service }));
      const writeHead = vi.spyOn(http.ServerResponse.prototype, 'writeHead');
      const expected = target === 'stats' ? [[1, 'metadata'], [1, 'stats']] : [[1, 'metadata'], [1, 'stats'], [1, 'convert']];
      try {
        const client = http.get({ host: '127.0.0.1', port, path: pages[0].url });
        client.on('error', () => {});
        await reached.promise;
        client.destroy();
        expect(await outcomes[0]).toBe('CANCELLED');
        const settledAt = performance.now();
        // The disconnect reached the service while that native operation ran in the child.
        expect(phasesAtAbort).toEqual(expected);
        expect(phases).toEqual(expected);
        expect(writeHead.mock.contexts.filter((res) => res.req?.url === pages[0].url)).toHaveLength(0);
        // The child was killed and confirmed gone before the request settled, still holding its
        // slot at that moment; the slot was free as soon as the request settled.
        expect(children).toHaveLength(1);
        expect(children[0].exitedAt).toBeGreaterThanOrEqual(abortedAt);
        expect(children[0].exitedAt).toBeLessThanOrEqual(settledAt);
        expect(settledAt - abortedAt).toBeLessThan(1_000);
        expect(() => process.kill(children[0].pid, 0)).toThrow();
        expect(atExit[0]).toMatchObject({ active: 1 });
        expect(h.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
        expect(renditions.snapshot()).toMatchObject({ active: 0, launched: 1, exited: 1 });
      } finally {
        writeHead.mockRestore();
      }
      expect(handles.closed).toBe(handles.opened);

      // Other pages continue, and the same page renders normally for a client that stays.
      const next = await getPage(h.app, pages[1].url);
      expect(next.status).toBe(200);
      expect(next.body.equals(img.jpeg)).toBe(true);
      const full = await getPage(h.buildApp({ comicMediaService: real }), pages[0].url);
      expect(full.status).toBe(200);
      expect(full.headers['content-type']).toBe('image/png');
      expect(phases.slice(-3)).toEqual([[1, 'metadata'], [1, 'stats'], [1, 'convert']]);
      const shown = await sharp(full.body).metadata();
      expect(shown.width * shown.height).toBeLessThanOrEqual(25_000_000);
      await renditions.close();
      for (const child of children) expect(() => process.kill(child.pid, 0)).toThrow();
    });
  }

  it('serves pages from the runtime\'s preloaded spare and still kills a claimed spare on disconnect (F1b)', async () => {
    const children = [];
    const spared = await makeHarness({
      runtimeOptions: {
        renditionSpare: true,
        renditionOptions: {
          hooks: {
            spawned: ({ pid, spare }) => children.push({ pid, spare, exitedAt: null }),
            exited: ({ pid }) => { children.find((child) => child.pid === pid).exitedAt = performance.now(); },
          },
        },
      },
    }).start();
    const spareOf = () => spared.runtime.snapshot().renditions.spare;
    await vi.waitFor(() => expect(spareOf().state).toBe('ready'), { timeout: 15_000 });

    // An ordinary page: the same bytes as a cold rendition, from the claimed spare.
    const comic = spared.addAsset('Spare pages', 'book.cbz', archives.cbz, CBZ_MIME);
    const { pages } = await manifestOf(spared.app, comic.base);
    const first = await getPage(spared.app, pages[0].url);
    expect(first.status).toBe(200);
    expect(first.body.equals(img.jpeg)).toBe(true);
    expect(spareOf()).toMatchObject({ claimed: 1, failed: 0 });
    // An animated page is rendered as a still by a spare as well.
    const still = await getPage(spared.app, pages[2].url);
    expect(still.status).toBe(200);
    expect(still.headers['content-type']).toBe('image/webp');
    expect((await sharp(still.body).metadata()).pages ?? 1).toBe(1);

    // A disconnect during native work in a claimed spare: killed, confirmed gone, nothing written.
    const width = 6000;
    const raw = Buffer.alloc(width * width * 3);
    for (let y = 0; y < width; y += 1) raw.fill((y * 13) & 0xff, y * width * 3, (y + 1) * width * 3);
    const costly = await sharp(raw, { raw: { width, height: width, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
    const heavy = spared.addAsset('Spare disconnect', 'book.cbz', makeZip([{ name: 'p1.png', data: costly }]), CBZ_MIME);
    const heavyPages = (await manifestOf(spared.app, heavy.base)).pages;
    await vi.waitFor(() => expect(spareOf().state).toBe('ready'), { timeout: 15_000 });
    const claimedBefore = spareOf().claimed;
    const reached = deferred();
    const outcomes = [];
    const real = createComicMediaService({
      previewService: spared.previewService, projectsRoot: spared.projectsRoot,
      admission: spared.runtime.admission, renditions: spared.runtime.renditions,
      _hooks: { renditionPhase: ({ phase }) => { if (phase === 'stats') reached.resolve(); } },
    });
    let abortedAt = null;
    const service = {
      getComicManifest: real.getComicManifest,
      getComicPage: (projectId, assetId, options) => {
        options.signal.addEventListener('abort', () => { abortedAt = performance.now(); }, { once: true });
        const pending = real.getComicPage(projectId, assetId, options);
        outcomes.push(pending.then(() => 'served', (err) => err.code));
        return pending;
      },
    };
    const port = await spared.listen(spared.buildApp({ comicMediaService: service }));
    const writeHead = vi.spyOn(http.ServerResponse.prototype, 'writeHead');
    try {
      const client = http.get({ host: '127.0.0.1', port, path: heavyPages[0].url });
      client.on('error', () => {});
      await reached.promise;
      expect(spareOf().claimed).toBe(claimedBefore + 1);
      const victim = children.filter((child) => child.spare).at(-2);
      client.destroy();
      expect(await outcomes[0]).toBe('CANCELLED');
      const settledAt = performance.now();
      expect(writeHead.mock.contexts.filter((res) => res.req?.url === heavyPages[0].url)).toHaveLength(0);
      expect(victim.exitedAt).toBeGreaterThanOrEqual(abortedAt);
      expect(victim.exitedAt).toBeLessThanOrEqual(settledAt);
      expect(() => process.kill(victim.pid, 0)).toThrow();
      expect(spared.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
    } finally {
      writeHead.mockRestore();
    }

    // Shutdown takes the idle spare with it.
    await vi.waitFor(() => expect(spareOf().state).toBe('ready'), { timeout: 15_000 });
    await spared.runtime.close();
    for (const child of children) expect(() => process.kill(child.pid, 0)).toThrow();
    expect(spared.runtime.renditions.snapshot()).toMatchObject({ state: 'closed', active: 0 });
    expect(spared.runtime.renditions.snapshot().launched).toBe(children.length);
  }, 60_000);

  it('does not treat completed requests as disconnects', async () => {
    const comic = h.addAsset('Completed', 'book.cbz', archives.cbz, CBZ_MIME);
    const signals = [];
    const real = createComicMediaService({
      previewService: h.previewService, projectsRoot: h.projectsRoot, admission: h.runtime.admission,
    });
    const service = {
      getComicManifest: (projectId, assetId, options) => { signals.push(options.signal); return real.getComicManifest(projectId, assetId, options); },
      getComicPage: (projectId, assetId, options) => { signals.push(options.signal); return real.getComicPage(projectId, assetId, options); },
    };
    const port = await h.listen(h.buildApp({ comicMediaService: service }));
    const fetchJson = async (url) => (await fetch(`http://127.0.0.1:${port}${url}`)).json();
    const body = await fetchJson(comic.base + '/comic');
    const page = await fetch(`http://127.0.0.1:${port}${body.pages[0].url}`);
    expect(Buffer.from(await page.arrayBuffer()).equals(img.jpeg)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal.aborted).toBe(false);
  });

  it('keeps a shared background preparation running when a requesting client disconnects', async () => {
    const comic = h.addAsset('Shared prep', 'book.cbr', archives.cbr('comic-rar4-solid.cbr'), CBR_MIME);
    const { pages } = await manifestOf(h.app, comic.base);
    const cache = h.runtime.preparationCache;
    const entries = cache.snapshot().entries;
    const port = await h.listen(h.app);
    // The first read schedules the preparation; its client then goes away mid-response.
    const first = await getPage(h.app, pages[0].url);
    expect(first.status).toBe(200);
    const client = http.get({ host: '127.0.0.1', port, path: pages[1].url });
    client.on('error', () => {});
    client.destroy();
    await cache.whenIdle();
    expect(cache.snapshot().entries).toBe(entries + 1);
    expect((await manifestOf(h.app, comic.base)).preparation.state).toBe('ready');
    await vi.waitFor(() => expect(h.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 }));
  });
});

describe('application integration', () => {
  it('uses the graph-owned service with the shared runtime, never one per request', async () => {
    expect(h.app.locals.comicRuntime).toBe(h.runtime);
    const service = h.app.locals.comicMediaService;
    expect(service).toBeTruthy();
    const comic = h.addAsset('Shared service', 'book.cbz', archives.cbz, CBZ_MIME);
    // Fill the application's one admission: an HTTP request must wait in it, not elsewhere.
    const { maxActive } = h.runtime.admission.limits;
    const gate = deferred();
    const holders = Array.from({ length: maxActive }, () => h.runtime.admission.run(() => gate.promise, { weightBytes: 1024 }));
    const pending = request(h.app).get(comic.base + '/comic').then((res) => res);
    await vi.waitFor(() => expect(h.runtime.admission.snapshot().queued).toBe(1));
    gate.resolve();
    await Promise.all(holders);
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await getPage(h.app, res.body.pages[0].url)).status).toBe(200);
    expect(h.app.locals.comicMediaService).toBe(service);

    // An injected graph service is the one its routes call.
    const calls = [];
    const injected = {
      getComicManifest: (...args) => { calls.push('manifest'); return service.getComicManifest(...args); },
      getComicPage: (...args) => { calls.push('page'); return service.getComicPage(...args); },
    };
    const app = h.buildApp({ comicMediaService: injected });
    expect(app.locals.comicMediaService).toBe(injected);
    const body = await manifestOf(app, comic.base);
    expect((await getPage(app, body.pages[0].url)).status).toBe(200);
    expect(calls).toEqual(['manifest', 'page']);
  });

  it('serves through a replaced application graph with current authorization', async () => {
    const ctxHarness = harnesses[0];
    const context = createApplicationContext({
      appName: APP_NAME, projectsRoot: ctxHarness.projectsRoot, previewRoot: ctxHarness.previewRoot,
      appOpts: {
        appDataRoot: ctxHarness.appDataRoot, databasePath: path.join(ctxHarness.appDataRoot, 'creatorcrate.db'),
        migrationsDir: MIGRATIONS_DIR, maintenanceState: { active: false }, comicRuntime: ctxHarness.runtime,
        authState: { csrfPepper: ctxHarness.csrfPepper },
      },
    }, ctxHarness.db);
    const handler = (req, res) => context.handleRequest(req, res);
    const idle = async () => {
      await context.generatedImageRebuildService?.waitForIdle();
      await context.generatedImagePublicationLifecycle?.waitForIdle();
      await context.projectOwnershipAdoption?.waitForIdle();
      await context.legacyManifestCleanup?.waitForIdle();
    };
    const replacement = openDatabase(path.join(ctxHarness.tmpDir, 'replacement.db'));
    runMigrations(replacement, MIGRATIONS_DIR);
    try {
      const comic = ctxHarness.addAsset('Context', 'book.cbz', archives.cbz, CBZ_MIME);
      const { pages } = await manifestOf(handler, comic.base);
      expect((await getPage(handler, pages[0].url)).status).toBe(200);

      // Auth reconfiguration rebuilds the graph; the same revision stays valid there.
      const before = context.comicMediaService;
      await idle();
      context.replaceAuthConfig(null);
      expect(context.comicMediaService).not.toBe(before);
      expect(context.app.locals.comicRuntime).toBe(ctxHarness.runtime);
      expect((await getPage(handler, pages[1].url)).status).toBe(422);
      expect((await getPage(handler, pages[4].url)).status).toBe(200);

      // A database replacement re-authorizes against the new graph: the asset is unknown there.
      await idle();
      context.replaceDatabase(replacement);
      expect((await request(handler).get(pages[0].url)).status).toBe(404);
      expect((await request(handler).get(comic.base + '/comic')).status).toBe(404);
    } finally {
      for (const owner of [context.generatedImageRebuildService, context.generatedImagePublicationLifecycle,
        context.projectOwnershipAdoption, context.legacyManifestCleanup]) owner?.stop();
      context.releaseNotificationRuntime?.stop();
      await idle();
      await context.releaseNotificationRuntime?.waitForIdle();
      if (replacement.open) closeDatabase(replacement);
    }
  });

  it('answers 404 without a comic service and keeps image routes in that graph', async () => {
    const comic = h.addAsset('No comic service', 'book.cbz', archives.cbz, CBZ_MIME);
    const image = h.addAsset('Plain image', 'image.png', img.png, 'image/png');
    // An injected preview service without original-descriptor authority yields no comic service.
    const { getOriginalDescriptor: _omit, ...withoutAuthority } = h.previewService;
    const mediaService = createMediaService({ previewService: h.previewService, projectsRoot: h.projectsRoot, previewRoot: h.previewRoot });
    const app = h.buildApp({ previewService: withoutAuthority, mediaService });
    expect(app.locals.comicMediaService).toBeNull();
    const res = await request(app).get(comic.base + '/comic');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await request(app).get(`${comic.base}/comic/pages/1?v=${'0'.repeat(32)}`)).status).toBe(404);
    const original = await request(app).get(image.base + '/original').buffer(true).parse(binary);
    expect(original.status).toBe(200);
    expect(original.body.equals(img.png)).toBe(true);
  });

  it('has no comic routes in a rootless application', async () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db, MIGRATIONS_DIR);
      const app = createApp({ appName: APP_NAME, db, projectsRoot: null, previewRoot: null },
        { appDataRoot: h.appDataRoot, authState: { csrfPepper: h.csrfPepper } });
      expect(app.locals.comicMediaService).toBeNull();
      const res = await request(app).get(`/projects/1/assets/1/comic/pages/1?v=${'0'.repeat(32)}`);
      expect(res.status).toBe(404);
      expect(res.headers['content-type'] ?? '').not.toMatch(/^image\//);
    } finally {
      closeDatabase(db);
    }
  });
});


afterAll(() => { for (const fixture of harnesses) fixture.app?.locals.comicMediaService?.stop?.(); });

describe('retired dedicated comic cover backend', () => {
  it('composes only the retained source and Reader APIs', () => {
    const service = h.app.locals.comicMediaService;
    expect(service.startComicCoverSource).toBeTypeOf('function');
    expect(service.getComicManifest).toBeTypeOf('function');
    expect(service.getComicPage).toBeTypeOf('function');
    expect(service.getComicThumbnail).toBeUndefined();
    expect(service.renderComicFirstPage).toBeUndefined();
  });
  it.each(['get', 'head', 'post'])('has no registered dedicated endpoint for %s', async method => {
    const comic = h.addAsset('Retired cover route ' + method, 'book.cbz', archives.cbz, CBZ_MIME);
    const obsolete = vi.fn(() => { throw new Error('Retired backend invoked'); });
    const app = express();
    app.use('/projects', createMediaRouter({ comicMediaService: { getComicThumbnail: obsolete } }));
    expect((await request(app)[method](comic.base + '/comic/thumbnail')).status).toBe(404);
    expect(obsolete).not.toHaveBeenCalled();
    // The composed application's CSRF middleware rejects an untrusted POST before routing.
    expect((await request(h.app)[method](comic.base + '/comic/thumbnail')).status).toBe(method === 'post' ? 403 : 404);
  });
});
