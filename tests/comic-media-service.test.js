// A3.3a — comic media service: authority, source revisions, numbered pages and renditions.
// Uses the real database, preview-service authority, secure asset-file path and the actual
// CBZ/CBR/CB7 readers; only descriptor open/close are wrapped to count and inspect handles.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import sharp from 'sharp';
import { makeZip } from './helpers/zip-fixture.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';

const handles = vi.hoisted(() => ({ opened: [], closed: 0 }));

vi.mock('../src/storage/asset-file.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openAssetFileAsync: async (...args) => {
      const opened = await actual.openAssetFileAsync(...args);
      handles.opened.push(opened.handle);
      return opened;
    },
    closeAssetFileAsync: async (opened) => {
      handles.closed += 1;
      return actual.closeAssetFileAsync(opened);
    },
  };
});

const { openDatabase, runMigrations, closeDatabase } = await import('../src/db.js');
const { createProjectRepository } = await import('../src/data/project-repository.js');
const { createAssetRepository } = await import('../src/data/asset-repository.js');
const { formatProjectDirName } = await import('../src/storage/project-storage.js');
const { createPreviewService } = await import('../src/services/preview-service.js');
const { MediaError, MediaNotFoundError, MediaUnsupportedError, MediaBadRequestError } = await import('../src/services/media-service.js');
const { createComicMediaService, COMIC_REVISION_RE } = await import('../src/services/comic-media-service.js');
const { createComicAdmission, estimateComicOperationBytes } = await import('../src/services/comic-admission.js');
const { createComicRenditionSupervisor } = await import('../src/services/comic-rendition-process.js');

const SevenZip = createRequire(import.meta.url)('7z-wasm');
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const DECODER_FIXTURES = fileURLToPath(new URL('./fixtures/archive-decoder/', import.meta.url));

const img = {};

beforeAll(async () => {
  const gradient = (width, height, seed) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7 + seed) & 0xff;
    return sharp(raw, { raw: { width, height, channels: 3 } });
  };
  img.jpeg = await gradient(48, 64, 10).jpeg().toBuffer();
  img.png = await gradient(48, 64, 20).png().toBuffer();
  img.webp = await gradient(48, 64, 30).webp({ lossless: true }).toBuffer();
  img.tallPng = await gradient(40, 200, 50).png().toBuffer();
  img.animatedWebp = await makeAnimatedWebp(3, { width: 20, height: 30 });
  img.animatedGif = await sharp([
    { create: { width: 16, height: 24, channels: 3, background: '#ff0000' } },
    { create: { width: 16, height: 24, channels: 3, background: '#00ff00' } },
  ], { join: { animated: true } }).gif({ loop: 0 }).toBuffer();
  const bigJpeg = await gradient(400, 600, 60).jpeg({ quality: 95 }).toBuffer();
  // Header intact, scan data cut short: header inspection passes, a full decode does not.
  img.truncatedJpeg = bigJpeg.subarray(0, Math.floor(bigJpeg.length / 3));
  img.text = Buffer.from('this is not an image, only text. '.repeat(10));
});

function makeCbz() {
  return makeZip([
    { name: 'p10.png', data: img.tallPng, compression: 'deflate' },
    { name: 'p1.jpg', data: img.jpeg },
    { name: 'p2.png', data: img.text },
    { name: 'p3.webp', data: img.animatedWebp },
    { name: 'p4.jpg', data: img.truncatedJpeg },
    { name: '__MACOSX/._p1.jpg', data: Buffer.from('junk') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
  ]);
}

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

let h;

function makeHarness(serviceOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-comic-media-'));
  const projectsRoot = path.join(tmpDir, 'projects');
  const previewRoot = path.join(tmpDir, 'app', 'previews');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(previewRoot, { recursive: true });
  const db = openDatabase(path.join(tmpDir, 'test.db'));
  runMigrations(db, MIGRATIONS_DIR);
  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);
  const previewService = createPreviewService({ db, projectsRoot, previewRoot });
  const service = createComicMediaService({ previewService, projectsRoot, ...serviceOptions });

  function createProject(title) {
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
  }

  function addAsset(ctx, relPath, bytes, mimeType) {
    const full = path.join(ctx.absPath, relPath);
    fs.writeFileSync(full, bytes);
    const stat = fs.statSync(full);
    const asset = assetRepo.upsert(ctx.project.id, relPath, {
      filename: relPath, extension: relPath.split('.').pop().toLowerCase(), mimeType,
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
    });
    return { asset, full };
  }

  return {
    tmpDir, projectsRoot, db, service, createProject, addAsset,
    withService: (options) => createComicMediaService({ previewService, projectsRoot, ...options }),
    cleanup() {
      closeDatabase(db);
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
}

async function failure(promise) {
  const caught = await promise.then(() => null, (err) => err);
  expect(caught).toBeInstanceOf(MediaError);
  return caught;
}

function expectHandlesReleased() {
  expect(handles.closed).toBe(handles.opened.length);
  for (const handle of handles.opened) expect(handle.fd).toBe(-1);
}

// Rewrites bytes in place, keeping size and restoring the original mtime.
function rewriteInPlace(full, mutate) {
  const before = fs.statSync(full);
  const bytes = fs.readFileSync(full);
  mutate(bytes);
  const fd = fs.openSync(full, 'r+');
  try { fs.writeSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  fs.utimesSync(full, before.atime, before.mtime);
  const after = fs.statSync(full);
  expect(after.size).toBe(before.size);
  expect(after.mtime.toISOString()).toBe(before.mtime.toISOString());
}

beforeEach(() => {
  handles.opened.length = 0;
  handles.closed = 0;
  h = makeHarness();
});

afterEach(() => {
  expectHandlesReleased();
  h.cleanup();
});

describe('authorized manifests', () => {
  it('lists an authorized CBZ in natural order without renumbering bad pages', async () => {
    const ctx = h.createProject('CBZ Comic');
    const { asset } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const manifest = await h.service.getComicManifest(ctx.project.id, asset.id);
    expect(manifest).toMatchObject({
      projectId: ctx.project.id, assetId: asset.id, format: 'cbz', container: 'zip', pageCount: 5,
      preparation: { solid: false, state: 'not-required' },
    });
    expect(manifest.revision).toMatch(COMIC_REVISION_RE);
    expect(manifest.pages.map((page) => [page.position, page.name])).toEqual([
      [1, 'p1.jpg'], [2, 'p2.png'], [3, 'p3.webp'], [4, 'p4.jpg'], [5, 'p10.png'],
    ]);
    expect(manifest.pages[0]).toEqual({
      position: 1, name: 'p1.jpg', declaredMimeType: 'image/jpeg', size: img.jpeg.length, available: true, problem: null,
    });
    expect(manifest.sourceImageTypes).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    // The same source yields the same revision.
    expect((await h.service.getComicManifest(ctx.project.id, asset.id)).revision).toBe(manifest.revision);
  });

  it.each([
    ['comic-rar4.cbr', 'rar4', false, 'application/vnd.comicbook-rar'],
    ['comic-rar5-solid.cbr', 'rar5', true, 'application/vnd.comicbook-rar'],
    // Rows indexed before comic recognition keep the generic MIME until a rescan.
    ['comic-rar4-solid.cbr', 'rar4', true, 'application/octet-stream'],
  ])('lists an authorized CBR (%s, recorded MIME %s)', async (fixture, container, solid, mimeType) => {
    const ctx = h.createProject('CBR Comic');
    const { asset } = h.addAsset(ctx, 'book.cbr', fs.readFileSync(path.join(COMICS, fixture)), mimeType);
    const manifest = await h.service.getComicManifest(ctx.project.id, asset.id);
    expect(manifest).toMatchObject({
      format: 'cbr', container, pageCount: 6, preparation: { solid, state: solid ? 'on-demand' : 'not-required' },
    });
    expect(manifest.pages.map((page) => page.name)).toEqual(['page1.jpg', 'page2.png', 'page10.webp', 'page1.gif', 'page2.png', 'page1.png']);
    const page = await h.service.getComicPage(ctx.project.id, asset.id, { revision: manifest.revision, position: 6 });
    expect(page).toMatchObject({ mimeType: 'image/png', width: 96, height: 128, converted: false, position: 6, pageCount: 6 });
  });

  it('lists an authorized CB7 and reads its pages by number', async () => {
    const ctx = h.createProject('CB7 Comic');
    const archive = await make7z([['b.png', img.png], ['a.jpg', img.jpeg], ['c.gif', img.animatedGif]]);
    const { asset } = h.addAsset(ctx, 'book.cb7', archive, 'application/x-cb7');
    const manifest = await h.service.getComicManifest(ctx.project.id, asset.id);
    expect(manifest).toMatchObject({ format: 'cb7', container: '7z', pageCount: 3 });
    expect(manifest.pages.map((page) => page.name)).toEqual(['a.jpg', 'b.png', 'c.gif']);
    const first = await h.service.getComicPage(ctx.project.id, asset.id, { revision: manifest.revision, position: 1 });
    expect(first.bytes.equals(img.jpeg)).toBe(true);
    const gif = await h.service.getComicPage(ctx.project.id, asset.id, { revision: manifest.revision, position: 3 });
    expect(gif).toMatchObject({ mimeType: 'image/png', converted: true, sourceAnimated: true, width: 16, height: 24 });
  });
});

describe('authority', () => {
  it('rejects an asset requested through another project, unknown ids and non-comics', async () => {
    const owner = h.createProject('Owner');
    const other = h.createProject('Other');
    const { asset } = h.addAsset(owner, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');

    const wrong = await failure(h.service.getComicManifest(other.project.id, asset.id));
    expect(wrong).toBeInstanceOf(MediaNotFoundError);
    expect(wrong).toMatchObject({ status: 404, code: 'ASSET_PROJECT_MISMATCH' });
    expect((await failure(h.service.getComicManifest(owner.project.id, 9999))).code).toBe('ASSET_NOT_FOUND');
    expect((await failure(h.service.getComicManifest(9999, asset.id))).code).toBe('ASSET_NOT_FOUND');
    expect((await failure(h.service.getComicManifest(0, asset.id))).code).toBe('ASSET_NOT_FOUND');

    // A generic ZIP with page-shaped content is not a comic, nor is an image.
    const zip = h.addAsset(owner, 'pages.zip', makeCbz(), 'application/zip');
    const unsupported = await failure(h.service.getComicManifest(owner.project.id, zip.asset.id));
    expect(unsupported).toBeInstanceOf(MediaUnsupportedError);
    expect(unsupported).toMatchObject({ status: 415, code: 'UNSUPPORTED_COMIC' });
    const png = h.addAsset(owner, 'art.png', img.png, 'image/png');
    expect((await failure(h.service.getComicManifest(owner.project.id, png.asset.id))).code).toBe('UNSUPPORTED_COMIC');
    // A .cbz whose bytes are not an archive is refused by the reader, not by its name.
    const fake = h.addAsset(owner, 'fake.cbz', img.png, 'application/vnd.comicbook+zip');
    expect(await failure(h.service.getComicManifest(owner.project.id, fake.asset.id)))
      .toMatchObject({ status: 422, code: 'COMIC_UNREADABLE', reason: 'UNSUPPORTED_FORMAT' });
  });

  it('reports a deleted source and a row marked missing as a missing source', async () => {
    const ctx = h.createProject('Missing');
    const { asset, full } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const manifest = await h.service.getComicManifest(ctx.project.id, asset.id);
    fs.rmSync(full);
    expect(await failure(h.service.getComicManifest(ctx.project.id, asset.id))).toMatchObject({ status: 404, code: 'SOURCE_MISSING' });
    expect((await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision: manifest.revision, position: 1 }))).code)
      .toBe('SOURCE_MISSING');
    h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
    expect((await failure(h.service.getComicManifest(ctx.project.id, asset.id))).code).toBe('SOURCE_MISSING');
  });

  it('keeps archived projects readable like other media', async () => {
    const ctx = h.createProject('Archived');
    const { asset } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    h.db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(ctx.project.id);
    expect((await h.service.getComicManifest(ctx.project.id, asset.id)).pageCount).toBe(5);
  });
});

describe('source revisions', () => {
  it('rejects malformed and mismatched revisions before decoding', async () => {
    const ctx = h.createProject('Revisions');
    const { asset } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    const invalid = await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision: 'abc', position: 1 }));
    expect(invalid).toBeInstanceOf(MediaBadRequestError);
    expect(invalid.code).toBe('REVISION_INVALID');
    const flip = (index) => revision.slice(0, index) + (revision[index] === '0' ? '1' : '0') + revision.slice(index + 1);
    // Identity half and catalog half are each checked.
    for (const tampered of [flip(0), flip(31)]) {
      expect(await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision: tampered, position: 1 })))
        .toMatchObject({ status: 409, code: 'REVISION_STALE' });
    }
  });

  it('detects an in-place rewrite that keeps size, inode and mtime', async () => {
    const ctx = h.createProject('In place');
    const { asset, full } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    const inodeBefore = fs.statSync(full).ino;
    // Flip one byte of the stored JPEG page; the ZIP directory (and its CRC claim) is unchanged.
    rewriteInPlace(full, (bytes) => { bytes[bytes.indexOf(img.jpeg) + 300] ^= 0xff; });
    expect(fs.statSync(full).ino).toBe(inodeBefore);
    expect(await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision, position: 1 })))
      .toMatchObject({ code: 'REVISION_STALE' });
    const fresh = await h.service.getComicManifest(ctx.project.id, asset.id);
    expect(fresh.revision).not.toBe(revision);
    // The tampered bytes now fail the page's CRC instead of being served.
    expect(await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision: fresh.revision, position: 1 })))
      .toMatchObject({ status: 422, code: 'PAGE_UNAVAILABLE', reason: 'PAGE_CORRUPT' });
  });

  it('treats a replaced source that no longer matches its index as changed', async () => {
    const ctx = h.createProject('Replaced');
    const { asset, full } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    fs.writeFileSync(full, makeZip([{ name: 'p1.jpg', data: img.jpeg }]));
    expect(await failure(h.service.getComicManifest(ctx.project.id, asset.id))).toMatchObject({ status: 409, code: 'SOURCE_CHANGED' });
    expect((await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision, position: 1 }))).code).toBe('SOURCE_CHANGED');
  });

  it('refuses output when the source is replaced during a read', async () => {
    const ctx = h.createProject('During');
    const { asset, full } = h.addAsset(ctx, 'book.cbr', fs.readFileSync(path.join(COMICS, 'comic-rar5.cbr')), 'application/vnd.comicbook-rar');
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    const replacement = path.join(ctx.absPath, 'replacement.tmp');
    let replaced = 0;
    const service = h.withService({
      _hooks: {
        afterRead: () => {
          // Same bytes, size and mtime under the same name, but a different file instance.
          // Windows refuses to rename over a file that is open; there the same bytes are
          // rewritten in place instead (only ctime changes).
          const before = fs.statSync(full);
          fs.copyFileSync(full, replacement);
          fs.utimesSync(replacement, before.atime, before.mtime);
          try {
            fs.renameSync(replacement, full);
          } catch (err) {
            if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
            fs.rmSync(replacement);
            rewriteInPlace(full, () => {});
          }
          replaced += 1;
        },
      },
    });
    expect(await failure(service.getComicPage(ctx.project.id, asset.id, { revision, position: 1 })))
      .toMatchObject({ code: 'REVISION_STALE' });
    expect(await failure(service.getComicManifest(ctx.project.id, asset.id))).toMatchObject({ code: 'REVISION_STALE' });
    expect(replaced).toBe(2);
    // The replacement is a new revision, served once a new manifest names it.
    const fresh = await h.service.getComicManifest(ctx.project.id, asset.id);
    expect(fresh.revision).not.toBe(revision);
    expect((await h.service.getComicPage(ctx.project.id, asset.id, { revision: fresh.revision, position: 1 })).mimeType).toBe('image/jpeg');
  });

  it('refuses output when the indexed row moves to a new generation during a read', async () => {
    const ctx = h.createProject('Generation');
    const { asset } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    const service = h.withService({
      _hooks: {
        afterRead: () => h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id),
      },
    });
    expect((await failure(service.getComicPage(ctx.project.id, asset.id, { revision, position: 1 }))).code).toBe('REVISION_STALE');
    expect((await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision, position: 1 }))).code).toBe('REVISION_STALE');
  });
});

describe('numbered pages and renditions', () => {
  let projects = 0;
  async function cbz(serviceOptions) {
    projects += 1;
    const ctx = h.createProject('Pages ' + projects);
    const { asset } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const service = serviceOptions ? h.withService(serviceOptions) : h.service;
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    const page = (position, signal) => service.getComicPage(ctx.project.id, asset.id, { revision, position, signal });
    return { page, revision, ctx, asset };
  }

  it('returns valid static pages unchanged and refuses invalid positions', async () => {
    const { page } = await cbz();
    const first = await page(1);
    expect(first).toMatchObject({ position: 1, pageCount: 5, mimeType: 'image/jpeg', width: 48, height: 64, converted: false });
    expect(first.bytes.equals(img.jpeg)).toBe(true);
    const last = await page(5);
    expect(last).toMatchObject({ mimeType: 'image/png', width: 40, height: 200, converted: false });
    expect(last.bytes.equals(img.tallPng)).toBe(true);
    for (const position of [0, -1, 1.5, '1', null, undefined]) {
      expect(await failure(page(position))).toMatchObject({ status: 400, code: 'PAGE_INVALID_POSITION' });
    }
    expect(await failure(page(6))).toMatchObject({ status: 404, code: 'PAGE_NOT_FOUND' });
  });

  it('keeps corrupt and truncated pages as numbered errors', async () => {
    const { page } = await cbz();
    expect(await failure(page(2))).toMatchObject({ status: 422, code: 'PAGE_UNAVAILABLE', reason: 'PAGE_INVALID_IMAGE' });
    // The truncated JPEG passes header inspection and fails the full decode.
    expect(await failure(page(4))).toMatchObject({ status: 422, code: 'PAGE_UNAVAILABLE', reason: 'PAGE_INVALID_IMAGE' });
    // Later pages keep their numbers.
    expect((await page(5)).position).toBe(5);
  });

  it('fails pixel-level corruption at rendition that header inspection accepts', async () => {
    const { inspectImage, CBZ_READER_LIMITS } = await import('../src/services/cbz-page-reader.js');
    const { renderComicPageStill } = await import('../src/services/comic-media-service.js');
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#336699' } })
      .png({ compressionLevel: 0 }).toBuffer();
    const corruptPng = Buffer.from(png);
    corruptPng[Math.floor(corruptPng.length / 2)] ^= 0xff;
    for (const bytes of [img.truncatedJpeg, corruptPng]) {
      const header = await inspectImage(bytes, CBZ_READER_LIMITS);
      expect(header.width).toBeGreaterThan(0);
      const caught = await renderComicPageStill(bytes, header).then(() => null, (err) => err);
      expect(caught).toMatchObject({ code: 'PAGE_UNAVAILABLE', reason: 'PAGE_INVALID_IMAGE' });
    }
  });

  it('renders animated WebP and GIF pages as still images', async () => {
    const { page } = await cbz();
    const still = await page(3);
    expect(still).toMatchObject({ mimeType: 'image/webp', converted: true, sourceAnimated: true, width: 20, height: 30 });
    const metadata = await sharp(still.bytes).metadata();
    expect(metadata.pages ?? 1).toBe(1);
    expect(metadata).toMatchObject({ format: 'webp', width: 20, height: 30 });

    const ctx = h.createProject('GIF');
    const { asset } = h.addAsset(ctx, 'gif.cbr', fs.readFileSync(path.join(COMICS, 'comic-rar4.cbr')), 'application/vnd.comicbook-rar');
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    const gif = await h.service.getComicPage(ctx.project.id, asset.id, { revision, position: 4 });
    expect(gif).toMatchObject({ mimeType: 'image/png', sourceAnimated: true, width: 16, height: 24 });
    expect((await sharp(gif.bytes).metadata()).pages ?? 1).toBe(1);
    expect(await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision, position: 5 })))
      .toMatchObject({ code: 'PAGE_UNAVAILABLE', reason: 'PAGE_INVALID_IMAGE' });
  });

  it('downscales over the pixel bound preserving aspect, and enforces output and input limits', async () => {
    const scaled = await (await cbz({ renditionLimits: { maxPixels: 2000 } })).page(5);
    expect(scaled).toMatchObject({ mimeType: 'image/png', converted: true });
    expect(scaled.width * scaled.height).toBeLessThanOrEqual(2000);
    expect(scaled.height / scaled.width).toBeCloseTo(5, 0);

    expect(await failure((await cbz({ renditionLimits: { maxOutputBytes: 100 } })).page(1)))
      .toMatchObject({ code: 'PAGE_UNAVAILABLE', reason: 'RENDITION_LIMIT_EXCEEDED' });
    expect(await failure((await cbz({ readerLimits: { maxImagePixels: 1000 } })).page(1)))
      .toMatchObject({ code: 'PAGE_UNAVAILABLE', reason: 'IMAGE_LIMIT_EXCEEDED' });
    // Limits can only be tightened.
    expect(() => h.withService({ renditionLimits: { maxPixels: 30_000_000 } })).toThrow(TypeError);
    expect(() => h.withService({ readerLimits: { maxImagePixels: 200_000_000 } })).toThrow(TypeError);
    expect(() => h.withService({ readerLimits: { bogus: 1 } })).toThrow(TypeError);
  });

  it('cancels before and during reads and always releases descriptors', async () => {
    const before = new AbortController();
    before.abort();
    const { page } = await cbz();
    expect(await failure(page(1, before.signal))).toMatchObject({ status: 503, code: 'CANCELLED' });

    const ctx = h.createProject('Cancel CBR');
    const { asset } = h.addAsset(ctx, 'book.cbr', fs.readFileSync(path.join(COMICS, 'comic-rar5-solid.cbr')), 'application/vnd.comicbook-rar');
    const { revision } = await h.service.getComicManifest(ctx.project.id, asset.id);
    const during = new AbortController();
    const service = h.withService({ _hooks: { afterRead: () => during.abort() } });
    expect((await failure(service.getComicPage(ctx.project.id, asset.id, { revision, position: 6, signal: during.signal }))).code)
      .toBe('CANCELLED');
    // Abort while the decoder worker is running.
    const racing = new AbortController();
    const pending = h.service.getComicPage(ctx.project.id, asset.id, { revision, position: 6, signal: racing.signal });
    setTimeout(() => racing.abort(), 5);
    expect((await failure(pending)).code).toBe('CANCELLED');
    expect(handles.opened.length).toBeGreaterThan(3);
  });
});

describe('admission (A3.3b-1)', () => {
  const MIB = 1024 * 1024;

  function gate() {
    let open;
    const promise = new Promise((resolve) => { open = resolve; });
    return { promise, open };
  }

  // A service whose admitted operations stop after reading until their gate opens. `entered`
  // resolves once `count` operations are inside the admitted region.
  function gatedService(admission, count = 1) {
    const g = gate();
    const reached = gate();
    let inside = 0;
    let peak = 0;
    const service = h.withService({
      admission,
      _hooks: {
        afterRead: async () => {
          inside += 1;
          peak = Math.max(peak, admission.snapshot().active);
          if (inside >= count) reached.open();
          await g.promise;
        },
      },
    });
    return { service, open: g.open, entered: reached.promise, peak: () => peak, inside: () => inside };
  }

  function addComic(name, fixture) {
    const ctx = h.createProject(name);
    const bytes = fixture ? fs.readFileSync(path.join(COMICS, fixture)) : makeCbz();
    const file = fixture ? 'book.cbr' : 'book.cbz';
    const { asset, full } = h.addAsset(ctx, file, bytes, fixture ? 'application/vnd.comicbook-rar' : 'application/vnd.comicbook+zip');
    return { ctx, asset, full, id: [ctx.project.id, asset.id] };
  }

  const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

  function expectIdle(admission) {
    expect(admission.snapshot()).toEqual({ active: 0, activeBackground: 0, reservedBytes: 0, queued: 0, queuedBackground: 0 });
  }

  it('bounds concurrent manifest requests and opens no descriptor while a request waits', async () => {
    const admission = createComicAdmission({ maxActive: 2 });
    const comics = [addComic('M1'), addComic('M2', 'comic-rar5.cbr'), addComic('M3'), addComic('M4', 'comic-rar4.cbr'), addComic('M5')];
    const gated = gatedService(admission, 2);
    const requests = comics.map((comic) => settle(gated.service.getComicManifest(...comic.id)));
    await gated.entered;
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 3 });
    // Only the two admitted requests opened their source.
    expect(handles.opened.length).toBe(2);
    gated.open();
    const results = await Promise.all(requests);
    expect(results.map((result) => result.value?.pageCount)).toEqual([5, 6, 5, 6, 5]);
    expect(gated.peak()).toBe(2);
    expectIdle(admission);
  });

  it('bounds concurrent and mixed page and manifest requests shared by several services', async () => {
    const admission = createComicAdmission({ maxActive: 2 });
    const cbr = addComic('Pages CBR', 'comic-rar5.cbr');
    const cbz = addComic('Pages CBZ');
    const plain = h.withService({ admission });
    const cbrRevision = (await plain.getComicManifest(...cbr.id)).revision;
    const cbzRevision = (await plain.getComicManifest(...cbz.id)).revision;
    expectIdle(admission);

    const gated = gatedService(admission, 2);
    const other = h.withService({ admission });
    const requests = [
      settle(gated.service.getComicPage(...cbr.id, { revision: cbrRevision, position: 1 })),
      settle(gated.service.getComicPage(...cbz.id, { revision: cbzRevision, position: 1 })),
      settle(other.getComicPage(...cbr.id, { revision: cbrRevision, position: 6 })),
      settle(other.getComicManifest(...cbz.id)),
      settle(gated.service.getComicPage(...cbz.id, { revision: cbzRevision, position: 5 })),
    ];
    await gated.entered;
    // Requests from the second service wait for the same two slots.
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 3 });
    gated.open();
    const results = await Promise.all(requests);
    expect(results.map((result) => result.error?.code ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(results[0].value.bytes.length).toBeGreaterThan(0);
    expect(results[3].value.revision).toBe(cbzRevision);
    expect(results[4].value).toMatchObject({ position: 5, mimeType: 'image/png' });
    expect(gated.peak()).toBe(2);
    expectIdle(admission);
  });

  it('weights decoder work by its estimate so two default CBR reads run and a third waits', async () => {
    const admission = createComicAdmission({ maxActive: 3 });
    const comics = [addComic('W1', 'comic-rar5.cbr'), addComic('W2', 'comic-rar4.cbr'), addComic('W3', 'comic-rar5.cbr')];
    const gated = gatedService(admission, 2);
    const requests = comics.map((comic) => settle(gated.service.getComicManifest(...comic.id)));
    await gated.entered;
    expect(admission.snapshot()).toMatchObject({
      active: 2, queued: 1, reservedBytes: 2 * estimateComicOperationBytes('manifest', 'cbr'),
    });
    gated.open();
    expect((await Promise.all(requests)).every((result) => result.value)).toBe(true);
    expectIdle(admission);
  });

  it('refuses requests over the queue bound with BUSY before opening a descriptor', async () => {
    const admission = createComicAdmission({ maxActive: 1, maxQueued: 1 });
    const comic = addComic('Full');
    const gated = gatedService(admission);
    const first = settle(gated.service.getComicManifest(...comic.id));
    const second = settle(gated.service.getComicManifest(...comic.id));
    await gated.entered;
    const refused = await failure(gated.service.getComicManifest(...comic.id));
    expect(refused).toMatchObject({ status: 503, code: 'BUSY', reason: 'QUEUE_FULL' });
    expect(handles.opened.length).toBe(1);
    // Authority is still checked first: an unknown asset is not reported as busy.
    expect((await failure(gated.service.getComicManifest(comic.ctx.project.id, 9999))).code).toBe('ASSET_NOT_FOUND');
    gated.open();
    expect((await first).value.pageCount).toBe(5);
    expect((await second).value.pageCount).toBe(5);
    expectIdle(admission);
  });

  it('times out a waiting request as BUSY, distinct from decoder failures, without starting it', async () => {
    const admission = createComicAdmission({ maxActive: 1, queueTimeoutMs: 20 });
    const comic = addComic('Timeout', 'comic-rar5.cbr');
    const gated = gatedService(admission);
    const first = settle(gated.service.getComicManifest(...comic.id));
    await gated.entered;
    const waited = await failure(gated.service.getComicManifest(...comic.id));
    expect(waited).toMatchObject({ status: 503, code: 'BUSY', reason: 'ADMISSION_TIMEOUT' });
    expect(gated.inside()).toBe(1);
    expect(handles.opened.length).toBe(1);
    gated.open();
    expect((await first).value.pageCount).toBe(6);
    expectIdle(admission);
  });

  it('cancels a queued request without starting it, and an active one without blocking the queue', async () => {
    const admission = createComicAdmission({ maxActive: 1 });
    const comic = addComic('Cancel', 'comic-rar5-solid.cbr');
    const { revision } = await h.withService({ admission }).getComicManifest(...comic.id);
    const opensBefore = handles.opened.length;

    const gated = gatedService(admission);
    const active = new AbortController();
    const first = settle(gated.service.getComicPage(...comic.id, { revision, position: 6, signal: active.signal }));
    await gated.entered;
    const queued = new AbortController();
    const waiting = settle(gated.service.getComicPage(...comic.id, { revision, position: 1, signal: queued.signal }));
    const behind = settle(gated.service.getComicPage(...comic.id, { revision, position: 1 }));
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 2 });
    queued.abort();
    expect((await waiting).error).toMatchObject({ status: 503, code: 'CANCELLED' });
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });
    expect(handles.opened.length - opensBefore).toBe(1);

    // The active request is cancelled after reading; its slot passes to the next request.
    active.abort();
    gated.open();
    expect((await first).error).toMatchObject({ code: 'CANCELLED' });
    expect((await behind).value).toMatchObject({ position: 1, mimeType: 'image/jpeg' });
    expect(handles.opened.length - opensBefore).toBe(2);

    // Abort while the decoder worker runs: the next request still gets the slot.
    const racing = new AbortController();
    const plain = h.withService({ admission });
    const raced = settle(plain.getComicPage(...comic.id, { revision, position: 6, signal: racing.signal }));
    setTimeout(() => racing.abort(), 5);
    expect((await raced).error?.code).toBe('CANCELLED');
    expect((await plain.getComicPage(...comic.id, { revision, position: 6 })).position).toBe(6);
    expectIdle(admission);
  });

  it('releases capacity after every failure and keeps FIFO progress', async () => {
    const admission = createComicAdmission({ maxActive: 1 });
    const cbz = addComic('Failures');
    const cbr = addComic('Failures CBR', 'comic-rar5.cbr');
    const fake = h.addAsset(cbz.ctx, 'fake.cbz', img.png, 'application/vnd.comicbook+zip');
    const plain = h.withService({ admission });
    const cbzRevision = (await plain.getComicManifest(...cbz.id)).revision;
    const cbrRevision = (await plain.getComicManifest(...cbr.id)).revision;
    const stale = cbzRevision.slice(0, 31) + (cbzRevision[31] === '0' ? '1' : '0');
    let thrown = 0;
    const throwing = h.withService({
      admission,
      _hooks: { afterRead: () => { thrown += 1; throw new Error('unexpected'); } },
    });

    const gated = gatedService(admission);
    const head = settle(gated.service.getComicManifest(...cbz.id));
    await gated.entered;
    const order = [
      ['corrupt archive', plain.getComicManifest(cbz.ctx.project.id, fake.asset.id), 'COMIC_UNREADABLE'],
      ['decoder page failure', plain.getComicPage(...cbr.id, { revision: cbrRevision, position: 5 }), 'PAGE_UNAVAILABLE'],
      ['rendition failure', plain.getComicPage(...cbz.id, { revision: cbzRevision, position: 4 }), 'PAGE_UNAVAILABLE'],
      ['stale revision', plain.getComicPage(...cbz.id, { revision: stale, position: 1 }), 'REVISION_STALE'],
      ['output limit', h.withService({ admission, renditionLimits: { maxOutputBytes: 100 } })
        .getComicPage(...cbz.id, { revision: cbzRevision, position: 1 }), 'PAGE_UNAVAILABLE'],
      ['unexpected', throwing.getComicManifest(...cbz.id), 'INTERNAL'],
      ['success', plain.getComicPage(...cbz.id, { revision: cbzRevision, position: 5 }), null],
    ].map(([label, promise, code]) => settle(promise).then((result) => ({ label, code, result })));
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 7 });
    gated.open();
    expect((await head).value.pageCount).toBe(5);
    for (const { label, code, result } of await Promise.all(order)) {
      if (code) expect(result.error?.code, label).toBe(code);
      else expect(result.value?.position, label).toBe(5);
    }
    expect(thrown).toBe(1);
    expectIdle(admission);
  });

  it('revalidates a source replaced or re-indexed while its request waited', async () => {
    const admission = createComicAdmission({ maxActive: 1 });
    const blocker = addComic('Blocker');
    const replaced = addComic('Replaced while waiting');
    const regenerated = addComic('Regenerated while waiting');
    const plain = h.withService({ admission });
    const replacedRevision = (await plain.getComicManifest(...replaced.id)).revision;
    const regeneratedRevision = (await plain.getComicManifest(...regenerated.id)).revision;

    const gated = gatedService(admission);
    const head = settle(gated.service.getComicManifest(...blocker.id));
    await gated.entered;
    const pageOfReplaced = settle(plain.getComicPage(...replaced.id, { revision: replacedRevision, position: 1 }));
    const manifestOfReplaced = settle(plain.getComicManifest(...replaced.id));
    const pageOfRegenerated = settle(plain.getComicPage(...regenerated.id, { revision: regeneratedRevision, position: 1 }));
    // Changed after authorization and queueing, before admission.
    fs.writeFileSync(replaced.full, makeZip([{ name: 'p1.jpg', data: img.jpeg }]));
    h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(regenerated.asset.id);
    gated.open();
    await head;
    expect((await pageOfReplaced).error).toMatchObject({ status: 409, code: 'SOURCE_CHANGED' });
    expect((await manifestOfReplaced).error).toMatchObject({ status: 409, code: 'SOURCE_CHANGED' });
    expect((await pageOfRegenerated).error).toMatchObject({ status: 409, code: 'REVISION_STALE' });

    // A row that moved to another project while waiting is refused by the repeated authority check.
    const owner = addComic('Owner while waiting');
    const elsewhere = h.createProject('Elsewhere');
    const gatedAgain = gatedService(admission);
    const head2 = settle(gatedAgain.service.getComicManifest(...blocker.id));
    await gatedAgain.entered;
    const moved = settle(plain.getComicManifest(...owner.id));
    h.db.prepare('UPDATE assets SET project_id = ? WHERE id = ?').run(elsewhere.project.id, owner.asset.id);
    gatedAgain.open();
    await head2;
    expect((await moved).error).toMatchObject({ status: 404, code: 'ASSET_PROJECT_MISMATCH' });
    expectIdle(admission);
  });

  it('leaves no reservation behind across many repeated mixed requests', async () => {
    const admission = createComicAdmission({ maxActive: 2, maxQueued: 100 });
    const cbz = addComic('Repeat');
    const plain = h.withService({ admission });
    const { revision } = await plain.getComicManifest(...cbz.id);
    const requests = [];
    for (let i = 0; i < 40; i += 1) {
      const controller = new AbortController();
      const position = (i % 5) + 1;
      requests.push(settle(i % 4 === 0
        ? plain.getComicManifest(...cbz.id, { signal: controller.signal })
        : plain.getComicPage(...cbz.id, { revision, position, signal: controller.signal })));
      if (i % 9 === 0) controller.abort();
    }
    const results = await Promise.all(requests);
    expect(results.some((result) => result.value)).toBe(true);
    expect(results.some((result) => result.error?.code === 'CANCELLED')).toBe(true);
    expect(results.some((result) => result.error?.code === 'PAGE_UNAVAILABLE')).toBe(true);
    expectIdle(admission);
  });

  it('admits a real solid preparation in the background lane without blocking foreground pages', async () => {
    const { prepareSolidCbrCb7 } = await import('../src/services/cbr-cb7-preparation.js');
    const { openAssetFileAsync, closeAssetFileAsync } = await import('../src/storage/asset-file.js');
    const admission = createComicAdmission();
    const solid = addComic('Solid', 'comic-rar5-solid.cbr');
    const plain = h.withService({ admission });
    const { revision } = await plain.getComicManifest(...solid.id);
    const stagingRoot = fs.mkdtempSync(path.join(h.tmpDir, 'staging-'));
    const weightBytes = estimateComicOperationBytes('preparation', 'cbr');

    const hold = gate();
    const preparing = gate();
    const preparation = admission.run(async () => {
      preparing.open();
      await hold.promise;
      const opened = await openAssetFileAsync(h.projectsRoot, solid.ctx.project.project_dir, 'book.cbr');
      try {
        const prepared = await prepareSolidCbrCb7(opened, { format: 'cbr', stagingRoot });
        try {
          return prepared.slots.map((slot) => slot.status);
        } finally {
          await prepared.dispose();
        }
      } finally {
        await closeAssetFileAsync(opened);
      }
    }, { lane: 'background', weightBytes });
    await preparing.promise;
    expect(admission.snapshot()).toMatchObject({ active: 1, activeBackground: 1, reservedBytes: weightBytes });

    // Foreground pages are admitted while the preparation holds its background slot.
    const pages = await Promise.all([1, 6].map((position) => plain.getComicPage(...solid.id, { revision, position })));
    expect(pages.map((page) => page.position)).toEqual([1, 6]);
    // A second preparation waits rather than taking the slot kept for the foreground.
    const second = settle(admission.run(() => 'second', { lane: 'background', weightBytes, queueTimeoutMs: 20 }));
    expect((await second).error?.code).toBe('ADMISSION_TIMEOUT');

    hold.open();
    expect((await preparation).length).toBe(6);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    expectIdle(admission);
  });

  it('builds a private admission when none is shared, and rejects an invalid one', async () => {
    const comic = addComic('Private');
    expect((await h.service.getComicManifest(...comic.id)).pageCount).toBe(5);
    expect(() => h.withService({ admission: {} })).toThrow(TypeError);
  });
});

describe('rendition cancellation (F1)', () => {
  const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
  const idle = { active: 0, activeBackground: 0, reservedBytes: 0, queued: 0, queuedBackground: 0 };
  let costly;

  beforeAll(async () => {
    // 36 megapixels: over the 25 MP rendition bound, so a full rendition is metadata, a full
    // stats() decode and a downscaling conversion. Low-entropy rows keep the PNG small.
    const width = 6000;
    const height = 6000;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) raw.fill((y * 13) & 0xff, y * width * 3, (y + 1) * width * 3);
    costly = await sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
  });

  function addCostly(name) {
    const ctx = h.createProject(name);
    const bytes = makeZip([{ name: 'p1.png', data: costly }, { name: 'p2.jpg', data: img.jpeg }]);
    const { asset } = h.addAsset(ctx, 'book.cbz', bytes, 'application/vnd.comicbook+zip');
    return [ctx.project.id, asset.id];
  }

  function alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  // F1a: a rendition supervisor that records each child and the moment it was confirmed gone.
  const supervisors = [];
  function observedRenditions(onExit) {
    const children = [];
    const renditions = createComicRenditionSupervisor({
      hooks: {
        spawned: ({ pid }) => children.push({ pid, exitedAt: null }),
        exited: ({ pid }) => {
          children.find((child) => child.pid === pid).exitedAt = performance.now();
          onExit?.(pid);
        },
      },
    });
    supervisors.push(renditions);
    return { renditions, children };
  }

  afterEach(async () => {
    for (const renditions of supervisors.splice(0)) {
      await renditions.close();
      expect(renditions.snapshot()).toMatchObject({ active: 0, terminating: 0 });
    }
  });

  it('kills a costly rendition cancelled during stats(), releasing the slot only after the child is gone', async () => {
    const id = addCostly('Costly cancel');
    const admission = createComicAdmission({ maxActive: 1 });
    const atExit = [];
    const { renditions, children } = observedRenditions(() => atExit.push(admission.snapshot()));
    const phases = [];
    let entered2At = null;
    let abortedAt = null;
    const controller = new AbortController();
    const inStats = gate();
    const service = h.withService({
      admission,
      renditions,
      _hooks: {
        afterRead: ({ position }) => { if (position === 2 && entered2At === null) entered2At = performance.now(); },
        renditionPhase: ({ phase, position }) => {
          phases.push([position, phase]);
          // The child reported that stats() is running natively: the abort lands during it.
          if (position === 1 && phase === 'stats' && !controller.signal.aborted) {
            abortedAt = performance.now();
            controller.abort();
            inStats.open();
          }
        },
      },
    });
    const { revision } = await service.getComicManifest(...id);
    let cancelledAt = null;
    const cancelled = settle(service.getComicPage(...id, { revision, position: 1, signal: controller.signal })
      .finally(() => { cancelledAt = performance.now(); }));
    await inStats.promise;
    // A second request waits for the one slot.
    const waiting = settle(service.getComicPage(...id, { revision, position: 2 }));
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });

    const { error } = await cancelled;
    expect(error).toMatchObject({ status: 503, code: 'CANCELLED' });
    // The child was killed during stats(), confirmed gone, and only then did the request settle.
    const [child] = children;
    expect(child.exitedAt).toBeGreaterThanOrEqual(abortedAt);
    expect(cancelledAt).toBeGreaterThanOrEqual(child.exitedAt);
    expect(alive(child.pid)).toBe(false);
    expect(cancelledAt - abortedAt).toBeLessThan(1_000);
    // When its exit was confirmed the cancelled request still held the slot.
    expect(atExit[0]).toMatchObject({ active: 1, queued: 1 });
    expect(phases.filter(([position]) => position === 1)).toEqual([[1, 'metadata'], [1, 'stats']]);

    // The waiting request was admitted only after the child was gone, and completes.
    expect((await waiting).value).toMatchObject({ position: 2, mimeType: 'image/jpeg', converted: false });
    expect(entered2At).toBeGreaterThanOrEqual(child.exitedAt);
    expect(entered2At).toBeGreaterThanOrEqual(cancelledAt);
    expect(admission.snapshot()).toEqual(idle);

    // Uncancelled, the same page is fully rendered: metadata, stats and a downscaling conversion.
    phases.length = 0;
    const full = await service.getComicPage(...id, { revision, position: 1 });
    expect(phases).toEqual([[1, 'metadata'], [1, 'stats'], [1, 'convert']]);
    expect(full).toMatchObject({ mimeType: 'image/png', converted: true });
    expect(full.width * full.height).toBeLessThanOrEqual(25_000_000);
    expect(full.width).toBe(full.height);
    expect((await sharp(full.bytes).metadata()).format).toBe('png');
    for (const each of children) expect(alive(each.pid)).toBe(false);
  });

  it('kills a costly rendition cancelled during its conversion', async () => {
    const id = addCostly('Costly convert cancel');
    const admission = createComicAdmission({ maxActive: 1 });
    const { renditions, children } = observedRenditions();
    const controller = new AbortController();
    let abortedAt = null;
    const service = h.withService({
      admission,
      renditions,
      _hooks: {
        renditionPhase: ({ phase }) => {
          if (phase === 'convert') {
            abortedAt = performance.now();
            controller.abort();
          }
        },
      },
    });
    const { revision } = await service.getComicManifest(...id);
    const { error } = await settle(service.getComicPage(...id, { revision, position: 1, signal: controller.signal }));
    const settledAt = performance.now();
    expect(error).toMatchObject({ status: 503, code: 'CANCELLED' });
    expect(children).toHaveLength(1);
    expect(children[0].exitedAt).toBeGreaterThanOrEqual(abortedAt);
    expect(settledAt - abortedAt).toBeLessThan(1_000);
    expect(alive(children[0].pid)).toBe(false);
    expect(admission.snapshot()).toEqual(idle);
    expect(handles.closed).toBe(handles.opened.length);
  });

  it('keeps source revisions and authorization unchanged around process rendition', async () => {
    const { renditions, children } = observedRenditions();
    const service = h.withService({ renditions });
    const ctx = h.createProject('Process authority');
    const { asset } = h.addAsset(ctx, 'book.cbz', makeCbz(), 'application/vnd.comicbook+zip');
    const { revision } = await service.getComicManifest(ctx.project.id, asset.id);
    const other = h.createProject('Process other');
    // Unauthorized and stale requests are refused before any child is launched.
    expect(await failure(service.getComicPage(other.project.id, asset.id, { revision, position: 1 })))
      .toMatchObject({ code: 'ASSET_PROJECT_MISMATCH' });
    expect(await failure(service.getComicPage(ctx.project.id, asset.id, { revision: 'f'.repeat(32), position: 1 })))
      .toMatchObject({ code: 'REVISION_STALE' });
    expect(children).toHaveLength(0);
    const page = await service.getComicPage(ctx.project.id, asset.id, { revision, position: 1 });
    expect(page).toMatchObject({ revision, position: 1, mimeType: 'image/jpeg', converted: false });
    expect(page.bytes.equals(img.jpeg)).toBe(true);
    expect(children).toHaveLength(1);
    for (const child of children) expect(alive(child.pid)).toBe(false);
  });

  it('checks the signal at every rendition boundary and never returns a cancelled rendition', async () => {
    const { inspectImage, CBZ_READER_LIMITS } = await import('../src/services/cbz-page-reader.js');
    const { renderComicPageStill } = await import('../src/services/comic-media-service.js');
    const render = async (bytes, abortAt, limits) => {
      const header = await inspectImage(bytes, CBZ_READER_LIMITS);
      const controller = new AbortController();
      if (abortAt === 'before') controller.abort();
      const phases = [];
      const result = await settle(renderComicPageStill(bytes, header, {
        limits,
        signal: controller.signal,
        onPhase: (phase) => {
          phases.push(phase);
          if (phase === abortAt) controller.abort();
        },
      }));
      return { ...result, phases, controller };
    };
    const oversized = { maxPixels: 1000, maxOutputBytes: 32 * 1024 * 1024, maxWebpDimension: 16_383, timeoutSeconds: 30 };

    expect(await render(img.png, 'before')).toMatchObject({ phases: [], error: { code: 'CANCELLED' } });
    expect(await render(img.png, 'metadata')).toMatchObject({ phases: ['metadata'], error: { code: 'CANCELLED' } });
    // An unchanged page is not returned once cancelled during its decode.
    expect(await render(img.png, 'stats')).toMatchObject({ phases: ['metadata', 'stats'], error: { code: 'CANCELLED' } });
    // A conversion that completes after the abort is discarded.
    expect(await render(img.tallPng, 'convert', oversized))
      .toMatchObject({ phases: ['metadata', 'stats', 'convert'], error: { code: 'CANCELLED', status: 503 } });
    // A decode failure that coincides with the abort is reported as the cancellation...
    expect(await render(img.truncatedJpeg, 'stats')).toMatchObject({ error: { code: 'CANCELLED' } });
    // ...and as the invalid image it is when nobody cancelled.
    expect(await render(img.truncatedJpeg, null)).toMatchObject({ error: { code: 'PAGE_UNAVAILABLE', reason: 'PAGE_INVALID_IMAGE' } });

    // Normal renditions are unaffected, and a completed one is not undone by a later abort.
    const plain = await render(img.png, null);
    expect(plain.value).toMatchObject({ mimeType: 'image/png', converted: false, width: 48, height: 64 });
    expect(plain.value.bytes.equals(img.png)).toBe(true);
    plain.controller.abort();
    const scaled = await render(img.tallPng, null, oversized);
    expect(scaled.phases).toEqual(['metadata', 'stats', 'convert']);
    expect(scaled.value).toMatchObject({ mimeType: 'image/png', converted: true });
    expect(scaled.value.width * scaled.value.height).toBeLessThanOrEqual(1000);
  });

  it('leaves no listener, reservation or descriptor behind across repeated cancelled renditions', async () => {
    const { getEventListeners } = await import('node:events');
    const id = addCostly('Repeated cancel');
    const admission = createComicAdmission({ maxActive: 1, maxQueued: 50 });
    const controllers = new Map();
    const { renditions, children } = observedRenditions();
    const service = h.withService({
      admission,
      renditions,
      _hooks: { renditionPhase: ({ phase, position }) => { if (phase === 'metadata') controllers.get(position)?.abort(); } },
    });
    const { revision } = await service.getComicManifest(...id);
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      const controller = new AbortController();
      controllers.set(1, controller);
      results.push({ controller, outcome: await settle(service.getComicPage(...id, { revision, position: 1, signal: controller.signal })) });
    }
    for (const { controller, outcome } of results) {
      expect(outcome.error).toMatchObject({ code: 'CANCELLED' });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    expect(admission.snapshot()).toEqual(idle);
    // Every cancelled rendition's child is gone; none is left running.
    expect(children).toHaveLength(6);
    for (const child of children) {
      expect(child.exitedAt).not.toBeNull();
      expect(alive(child.pid)).toBe(false);
    }
    expect(renditions.snapshot()).toMatchObject({ active: 0, launched: 6, exited: 6 });
    expect((await service.getComicPage(...id, { revision, position: 2 })).position).toBe(2);
    expect(admission.snapshot()).toEqual(idle);
  });

  function gate() {
    let open;
    const promise = new Promise((resolve) => { open = resolve; });
    return { promise, open };
  }
});

describe('no path or diagnostic leakage', () => {
  it('exposes neither filesystem paths nor member paths in results and outcomes', async () => {
    const ctx = h.createProject('Leak');
    const { asset, full } = h.addAsset(ctx, 'book.cbr', fs.readFileSync(path.join(COMICS, 'comic-rar5.cbr')), 'application/vnd.comicbook-rar');
    const manifest = await h.service.getComicManifest(ctx.project.id, asset.id);
    const page = await h.service.getComicPage(ctx.project.id, asset.id, { revision: manifest.revision, position: 1 });
    const errors = [
      await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision: manifest.revision, position: 5 })),
      await failure(h.service.getComicPage(ctx.project.id, asset.id, { revision: manifest.revision, position: 99 })),
    ];
    fs.writeFileSync(full, Buffer.from('garbage'));
    h.db.prepare('UPDATE assets SET size_bytes = ?, modified_at = ? WHERE id = ?')
      .run(7, fs.statSync(full).mtime.toISOString(), asset.id);
    errors.push(await failure(h.service.getComicManifest(ctx.project.id, asset.id)));

    const visible = JSON.stringify([manifest, { ...page, bytes: undefined },
      errors.map((err) => ({ message: err.message, code: err.code, reason: err.reason, status: err.status }))]);
    for (const secret of [h.tmpDir, h.projectsRoot, 'ch1/', 'ch2/', 'ch10/', 'book.cbr', '7-Zip', 'wasm']) {
      expect(visible).not.toContain(secret);
    }
    expect(Object.keys(manifest.pages[0]).sort()).toEqual(['available', 'declaredMimeType', 'name', 'position', 'problem', 'size']);
    expect(errors.map((err) => err.code)).toEqual(['PAGE_UNAVAILABLE', 'PAGE_NOT_FOUND', 'COMIC_UNREADABLE']);
  });

  // Recognized archive-format refusals are unreadable comics, not internal failures.
  it.each([
    ['duplicates.cb7', 'duplicate-names.7z', 'application/x-cb7', 'ARCHIVE_ENTRY_AMBIGUOUS'],
    ['multipart.cbr', 'rar5-multivolume.part01.rar', 'application/vnd.comicbook-rar', 'ARCHIVE_MULTIVOLUME'],
  ])('reports %s as an unreadable comic (%s)', async (name, fixture, mimeType, reason) => {
    const ctx = h.createProject('Refused');
    const { asset } = h.addAsset(ctx, name, fs.readFileSync(path.join(DECODER_FIXTURES, fixture)), mimeType);
    const err = await failure(h.service.getComicManifest(ctx.project.id, asset.id));
    expect(err).toMatchObject({ status: 422, code: 'COMIC_UNREADABLE', reason, message: 'The comic archive cannot be read.' });
    const visible = JSON.stringify({ message: err.message, code: err.code, reason: err.reason, status: err.status });
    for (const secret of [h.tmpDir, h.projectsRoot, name, fixture, 'duplicate', 'volume', '7-Zip', 'wasm']) {
      expect(visible).not.toContain(secret);
    }
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
