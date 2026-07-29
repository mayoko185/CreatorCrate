import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import {
  formatProjectDirName,
  buildProjectRelPath,
  STATUS_DIR_MAP,
} from '../src/storage/project-storage.js';
import {
  THUMBNAIL_FILENAME,
  PREVIEW_FILENAME,
  META_FILENAME,
  CURRENT_POINTER_FILENAME,
  getCacheDir,
  getCurrentPointerPath,
  readCurrentPointer,
  resolvePublishedDir,
  buildRevisionDirName,
  isValidRevisionDirName,
  readMetaFile,
  DERIVATIVE_CONFIG_VERSION,
} from '../src/storage/preview-cache.js';
import {
  createPreviewService,
  PreviewError,
  PreviewNotFoundError,
  classifyPreviewable,
  THUMBNAIL_MAX,
  PREVIEW_MAX,
  _lockCountForTests,
} from '../src/services/preview-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// ─── Fixture builders ────────────────────────────────────────────────────

async function sharp() {
  return (await import('sharp')).default;
}

/** Create a real PNG buffer of arbitrary dimensions and color. */
async function makePng(width, height, { r = 80, g = 120, b = 200 } = {}) {
  const sh = await sharp();
  return sh({
    create: { width, height, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

/** Create a real JPEG buffer. */
async function makeJpeg(width, height) {
  const sh = await sharp();
  return sh({
    create: { width, height, channels: 3, background: { r: 200, g: 160, b: 80 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Create a real WebP buffer. */
async function makeWebp(width, height) {
  const sh = await sharp();
  return sh({
    create: { width, height, channels: 3, background: { r: 60, g: 200, b: 120 } },
  })
    .webp({ quality: 90 })
    .toBuffer();
}

/**
 * Create an animated GIF with N solid-color frames. Used to verify animation
 * preservation in preview derivatives and first-frame-only thumbnails.
 */
async function makeAnimatedGif(width, height, frames) {
  const sh = await sharp();
  const frameBufs = [];
  for (let i = 0; i < frames; i++) {
    frameBufs.push(
      await sh({
        create: {
          width,
          height,
          channels: 3,
          background: { r: i * 60, g: 100, b: 200 - i * 40 },
        },
      })
        .png()
        .toBuffer()
    );
  }
  return sh(frameBufs, { join: { animated: true } })
    .gif()
    .toBuffer();
}

/**
 * Create a PNG with an EXIF Orientation tag. Sharp's `withMetadata` can
 * inject EXIF; we use rotate + withMetadata to embed orientation 6 (90° CW).
 */
async function makePngWithExifOrientation(width, height, orientation) {
  const sh = await sharp();
  const png = await sh({
    create: { width, height, channels: 3, background: { r: 220, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();
  // Re-export with EXIF orientation injected. Sharp reads the Orientation tag
  // from the EXIF IFD; we craft a minimal EXIF block with the given value.
  return sh(png)
    .rotate()
    .withMetadata({ orientation })
    .png()
    .toBuffer();
}

/** Write a file into a project directory, creating parent dirs as needed. */
function writeProjectFile(projectAbs, relPath, buffer) {
  const target = path.join(projectAbs, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return target;
}

// ─── Test harness ────────────────────────────────────────────────────────

function makeHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preview-svc-'));
  const projectsRoot = path.join(tmpDir, 'projects');
  for (const dir of Object.values(STATUS_DIR_MAP)) {
    fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
  }
  const previewRoot = path.join(tmpDir, 'app', 'previews');
  fs.mkdirSync(previewRoot, { recursive: true });

  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDatabase(dbPath);
  runMigrations(db, MIGRATIONS_DIR);

  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);

  function createProject(title, status = 'tbd') {
    let project = projectRepo.create({
      title,
      slug: slugify(title, { lowercase: true }),
      description: '',
      notes: '',
      status,
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    const dirName = formatProjectDirName(project.id, project.slug);
    const relPath = buildProjectRelPath(project.status, dirName);
    const absPath = path.resolve(projectsRoot, relPath);
    fs.mkdirSync(absPath, { recursive: true });
    // setProjectDir returns the updated record; replace the local project so
    // callers that pass it to indexAsset get a record with project_dir set.
    project = projectRepo.setProjectDir(project.id, relPath);
    return { project, absPath, relPath };
  }

  /**
   * Index a file as an asset by upserting a record that mirrors what the
   * scanner would produce. We bypass the scanner so tests stay focused on
   * the preview service and don't re-test scanner reconciliation here.
   *
   * Accepts either a project record (with project_dir) or a createProject
   * context tuple ({ project, absPath, relPath }).
   *
   * @param {object} projectOrCtx
   * @param {string} relPath - asset relative path inside the project dir.
   */
  function indexAsset(projectOrCtx, relPath, { mimeType, sizeBytes, modifiedAt } = {}) {
    const project = projectOrCtx.project || projectOrCtx;
    const dirRel = project.project_dir;
    if (!dirRel) {
      throw new Error(`project ${project.id} has no project_dir; pass the createProject context`);
    }
    const filename = path.basename(relPath);
    const ext = filename.split('.').pop().toLowerCase();
    const stat = fs.statSync(path.join(projectsRoot, dirRel, relPath));
    return assetRepo.upsert(project.id, relPath, {
      filename,
      extension: ext,
      mimeType: mimeType ?? defaultMime(ext),
      sizeBytes: sizeBytes ?? stat.size,
      modifiedAt: modifiedAt ?? dbNow(),
    });
  }

  function dbNow() {
    // SQLite datetime('now') format
    return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }

  function defaultMime(ext) {
    return (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        kra: 'application/x-krita',
        krz: 'application/x-krita',
      }[ext] ?? 'application/octet-stream'
    );
  }

  const service = createPreviewService({
    db,
    projectsRoot,
    previewRoot,
  });

  return {
    tmpDir,
    projectsRoot,
    previewRoot,
    db,
    projectRepo,
    assetRepo,
    service,
    createProject,
    indexAsset,
    cleanup: () => {
      closeDatabase(db);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// Resolve the per-asset cache root (the directory holding current.json and
// the published r-*/ revision directories). Replaces the legacy flat-path
// helper: readers must resolve a published entry through the current.json
// pointer, never by assuming files sit directly under the cache root.
function assetCacheRoot(h, projectId, assetId) {
  return getCacheDir(h.previewRoot, projectId, assetId);
}

// Absolute path to current.json for an asset.
function pointerPath(h, projectId, assetId) {
  return getCurrentPointerPath(h.previewRoot, projectId, assetId);
}

// Resolve the currently-published revision directory for an asset, throwing
// if no complete cache has been published yet.
function publishedDir(h, projectId, assetId) {
  const dir = resolvePublishedDir(h.previewRoot, projectId, assetId);
  if (!dir) throw new Error(`no published cache for asset ${projectId}/${assetId}`);
  return dir;
}

// Resolve a file inside the currently-published revision directory.
function publishedFile(h, projectId, assetId, filename) {
  return path.join(publishedDir(h, projectId, assetId), filename);
}

// ─── Concurrency / failure-test helpers ──────────────────────────────────

/** A one-shot gate: await .promise, release with .release(). */
function makeGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release, released: false };
}

/**
 * Build a preview service over the harness's DB/roots with test-only hooks.
 * The module-level lock map is shared with the harness service, so a hooked
 * service observes the same per-asset serialization a production service does.
 */
function makeHookedService(h, hooks) {
  return createPreviewService({
    db: h.db,
    projectsRoot: h.projectsRoot,
    previewRoot: h.previewRoot,
    _hooks: hooks,
  });
}

/** Snapshot the byte content of the published cache + pointer for comparison. */
function snapshotCache(h, projectId, assetId) {
  return {
    pointer: fs.readFileSync(pointerPath(h, projectId, assetId)),
    thumbnail: fs.readFileSync(publishedFile(h, projectId, assetId, THUMBNAIL_FILENAME)),
    preview: fs.readFileSync(publishedFile(h, projectId, assetId, PREVIEW_FILENAME)),
    meta: fs.readFileSync(publishedFile(h, projectId, assetId, META_FILENAME)),
    dir: publishedDir(h, projectId, assetId),
  };
}

/** Return the tmp-* staging directories currently in an asset's cache root. */
function stagingDirs(h, projectId, assetId) {
  const root = assetCacheRoot(h, projectId, assetId);
  return fs.readdirSync(root).filter((n) => n.startsWith('tmp-'));
}

async function prepareFailureFixture(h) {
  const ctx = h.createProject('Filesystem Failure Project');
  const initial = await makePng(900, 700);
  writeProjectFile(ctx.absPath, 'f.png', initial);
  const asset = h.indexAsset(ctx.project, 'f.png');

  await h.service.getPreview(ctx.project.id, asset.id);
  const snapshot = snapshotCache(h, ctx.project.id, asset.id);

  const next = await makePng(920, 700, { r: 5, g: 5, b: 5 });
  writeProjectFile(ctx.absPath, 'f.png', next);
  h.assetRepo.upsert(ctx.project.id, 'f.png', {
    filename: 'f.png',
    extension: 'png',
    mimeType: 'image/png',
    sizeBytes: next.length,
    modifiedAt: '2026-11-01 10:00:00',
  });

  return { project: ctx.project, asset, snapshot };
}

function assertFailurePreserved(h, projectId, assetId, snapshot) {
  const after = snapshotCache(h, projectId, assetId);
  expect(after.pointer.equals(snapshot.pointer)).toBe(true);
  expect(after.thumbnail.equals(snapshot.thumbnail)).toBe(true);
  expect(after.preview.equals(snapshot.preview)).toBe(true);
  expect(after.meta.equals(snapshot.meta)).toBe(true);
  expect(after.dir).toBe(snapshot.dir);

  const root = assetCacheRoot(h, projectId, assetId);
  expect(fs.readdirSync(root).filter((name) => name.startsWith('tmp-'))).toEqual([]);
  expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect(fs.readdirSync(root).filter((name) => name.startsWith('r-'))).toEqual([
    path.basename(snapshot.dir),
  ]);
  expect(_lockCountForTests()).toBe(0);
}

// ─── Image correctness tests ─────────────────────────────────────────────

describe('preview-service image correctness', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  it('generates a PNG thumbnail as decodable WebP within 256x256', async () => {
    const { project, absPath } = h.createProject('PNG Project');
    const buf = await makePng(800, 600);
    writeProjectFile(absPath, path.join('source', 'art.png'), buf);
    const asset = h.indexAsset(project, path.join('source', 'art.png'));

    const r = await h.service.getThumbnail(project.id, asset.id);

    expect(r.status).toBe('ready');
    expect(r.mimeType).toBe('image/webp');
    expect(r.width).toBeLessThanOrEqual(THUMBNAIL_MAX);
    expect(r.height).toBeLessThanOrEqual(THUMBNAIL_MAX);
    expect(r.bytes).toBeGreaterThan(0);

    // Output decodes as WebP.
    const sh = await sharp();
    const out = fs.readFileSync(r.path);
    const meta = await sh(out).metadata();
    expect(meta.format).toBe('webp');
  });

  it('generates a JPEG preview as decodable WebP within 1600x1600', async () => {
    const { project, absPath } = h.createProject('JPEG Project');
    const buf = await makeJpeg(2400, 1600);
    writeProjectFile(absPath, 'cover.jpg', buf);
    const asset = h.indexAsset(project, 'cover.jpg');

    const r = await h.service.getPreview(project.id, asset.id);

    expect(r.status).toBe('ready');
    expect(r.mimeType).toBe('image/webp');
    expect(r.width).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(r.height).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(r.bytes).toBeGreaterThan(0);

    const sh = await sharp();
    const out = fs.readFileSync(r.path);
    const meta = await sh(out).metadata();
    expect(meta.format).toBe('webp');
  });

  it('generates a WebP source derivative', async () => {
    const { project, absPath } = h.createProject('WebP Project');
    const buf = await makeWebp(1200, 900);
    writeProjectFile(absPath, 'src.webp', buf);
    const asset = h.indexAsset(project, 'src.webp');

    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.status).toBe('ready');
    expect(r.width).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(r.height).toBeLessThanOrEqual(PREVIEW_MAX);

    const sh = await sharp();
    const meta = await sh(fs.readFileSync(r.path)).metadata();
    expect(meta.format).toBe('webp');
  });

  it('preserves aspect ratio (PNG 800x600 → preview 1600x1200 cap, but no upscale below)', async () => {
    // 800x600 fits inside 1600x1600 without enlargement, so the preview
    // should be exactly 800x600 (no upscale) with aspect preserved.
    const { project, absPath } = h.createProject('Aspect Project');
    const buf = await makePng(800, 600);
    writeProjectFile(absPath, 'a.png', buf);
    const asset = h.indexAsset(project, 'a.png');

    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    // Aspect ratio preserved exactly.
    expect(r.width / r.height).toBeCloseTo(800 / 600, 5);
  });

  it('preserves aspect ratio when downscaling (2000x1000 → 1600x800)', async () => {
    const { project, absPath } = h.createProject('Downscale Project');
    const buf = await makePng(2000, 1000);
    writeProjectFile(absPath, 'big.png', buf);
    const asset = h.indexAsset(project, 'big.png');

    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.width).toBe(1600);
    expect(r.height).toBe(800);
  });

  it('never enlarges a small source (thumbnail of 64x48 stays 64x48)', async () => {
    const { project, absPath } = h.createProject('Tiny Project');
    const buf = await makePng(64, 48);
    writeProjectFile(absPath, 'tiny.png', buf);
    const asset = h.indexAsset(project, 'tiny.png');

    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.width).toBe(64);
    expect(r.height).toBe(48);
  });

  it('applies EXIF orientation before resizing (orientation 6: 90° CW)', async () => {
    // Source: 400x300 with EXIF orientation 6. After autoOrient, the image
    // becomes 300x400 (rotated 90° CW). A 256x256 thumbnail of that should
    // be 192x256 (aspect 300:400 = 0.75 → 256*0.75=192).
    const { project, absPath } = h.createProject('EXIF Project');
    const buf = await makePngWithExifOrientation(400, 300, 6);
    writeProjectFile(absPath, 'exif.png', buf);
    const asset = h.indexAsset(project, 'exif.png');

    const r = await h.service.getThumbnail(project.id, asset.id);
    // After auto-orientation, the displayed image is 300x400; the thumbnail
    // is fit-inside 256x256 → 192x256.
    expect(r.width).toBe(192);
    expect(r.height).toBe(256);
  });

  it('strips source metadata from the derivative', async () => {
    const { project, absPath } = h.createProject('Meta Project');
    const buf = await makePngWithExifOrientation(200, 200, 6);
    writeProjectFile(absPath, 'meta.png', buf);
    const asset = h.indexAsset(project, 'meta.png');

    const r = await h.service.getThumbnail(project.id, asset.id);
    const sh = await sharp();
    const meta = await sh(fs.readFileSync(r.path)).metadata();
    // autoOrient removes the Orientation tag; Sharp strips other source
    // metadata by default. hasProfile should be false and no exif buffer.
    expect(meta.hasProfile).toBe(false);
    expect(meta.exif).toBeUndefined();
  });

  it('leaves source bytes unchanged after generation', async () => {
    const { project, absPath } = h.createProject('Intact Project');
    const buf = await makePng(500, 400);
    writeProjectFile(absPath, 'keep.png', buf);
    const asset = h.indexAsset(project, 'keep.png');
    const srcPath = path.join(absPath, 'keep.png');
    const before = fs.readFileSync(srcPath);

    await h.service.getPreview(project.id, asset.id);

    const after = fs.readFileSync(srcPath);
    expect(after.equals(before)).toBe(true);
  });

  it('leaves source mtime unchanged after generation', async () => {
    const { project, absPath } = h.createProject('Mtime Project');
    const buf = await makePng(500, 400);
    writeProjectFile(absPath, 'keep2.png', buf);
    const srcPath = path.join(absPath, 'keep2.png');
    // Pin mtime to a known value.
    const pinned = new Date('2025-01-15T10:30:00.000Z');
    fs.utimesSync(srcPath, pinned, pinned);
    const asset = h.indexAsset(project, 'keep2.png', {
      modifiedAt: '2025-01-15 10:30:00',
    });

    await h.service.getPreview(project.id, asset.id);

    const stat = fs.statSync(srcPath);
    expect(stat.mtime.toISOString()).toBe(pinned.toISOString());
  });

  // ── GIF / animation ─────────────────────────────────────────────────

  it('GIF thumbnail is first-frame only and static (not animated)', async () => {
    const { project, absPath } = h.createProject('GIF Thumb Project');
    const buf = await makeAnimatedGif(120, 80, 3);
    writeProjectFile(absPath, 'anim.gif', buf);
    const asset = h.indexAsset(project, 'anim.gif');

    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.status).toBe('ready');
    expect(r.animated).toBe(false);

    const sh = await sharp();
    const meta = await sh(fs.readFileSync(r.path)).metadata();
    expect(meta.format).toBe('webp');
    // Static output: pages is 1 (or undefined).
    expect((meta.pages ?? 1)).toBe(1);
  });

  it('GIF preview preserves animation with all frames', async () => {
    const { project, absPath } = h.createProject('GIF Preview Project');
    const buf = await makeAnimatedGif(200, 150, 4);
    writeProjectFile(absPath, 'anim4.gif', buf);
    const asset = h.indexAsset(project, 'anim4.gif');

    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.status).toBe('ready');
    expect(r.animated).toBe(true);

    const sh = await sharp();
    const out = fs.readFileSync(r.path);
    const meta = await sh(out, { animated: true }).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.pages).toBe(4);
    expect(meta.pageHeight).toBe(r.height);
    expect(r.width).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(r.height).toBeLessThanOrEqual(PREVIEW_MAX);
  });

  it('GIF preview preserves aspect ratio across frames', async () => {
    const { project, absPath } = h.createProject('GIF Aspect Project');
    const buf = await makeAnimatedGif(400, 200, 2);
    writeProjectFile(absPath, 'aspect.gif', buf);
    const asset = h.indexAsset(project, 'aspect.gif');

    const r = await h.service.getPreview(project.id, asset.id);
    // 400x200 fits inside 1600x1600 without enlargement.
    expect(r.width).toBe(400);
    expect(r.height).toBe(200);
    expect(r.width / r.height).toBeCloseTo(2, 5);
  });

  // ── Unsupported / corrupt ───────────────────────────────────────────

  it('returns unsupported for a Krita (.kra) asset', async () => {
    const { project, absPath } = h.createProject('Krita Project');
    fs.writeFileSync(path.join(absPath, 'draw.kra'), Buffer.from('fake-krita'));
    const asset = h.indexAsset(project, 'draw.kra');

    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.status).toBe('unsupported');
    expect(r.cacheState).toBe('unsupported-format');
    // No cache should have been written: no pointer, no revision directory.
    expect(readCurrentPointer(h.previewRoot, project.id, asset.id).ok).toBe(false);
    expect(resolvePublishedDir(h.previewRoot, project.id, asset.id)).toBeNull();
  });

  it('returns unsupported for a Krita .krz asset', async () => {
    const { project, absPath } = h.createProject('Krz Project');
    fs.writeFileSync(path.join(absPath, 'draw.krz'), Buffer.from('fake-krz'));
    const asset = h.indexAsset(project, 'draw.krz');

    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.status).toBe('unsupported');
  });

  it('returns unsupported for an unknown binary format with a fake image MIME', async () => {
    // The database MIME is never trusted alone. A random blob whose DB MIME
    // happens to be image/png but whose extension is .bin must be rejected.
    const { project, absPath } = h.createProject('Unknown Project');
    fs.writeFileSync(path.join(absPath, 'blob.bin'), Buffer.from('random'));
    const asset = h.indexAsset(project, 'blob.bin', { mimeType: 'image/png' });

    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.status).toBe('unsupported');
  });

  it('returns unsupported when extension is image but recorded MIME is not', async () => {
    // Mismatch defense: extension png but MIME octet-stream.
    const { project, absPath } = h.createProject('Mismatch Project');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'mismatch.png', buf);
    const asset = h.indexAsset(project, 'mismatch.png', {
      mimeType: 'application/octet-stream',
    });

    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.status).toBe('unsupported');
  });

  it('throws on a corrupt image source (Sharp fails to decode)', async () => {
    const { project, absPath } = h.createProject('Corrupt Project');
    fs.writeFileSync(path.join(absPath, 'broken.png'), Buffer.from('not a real png'));
    const asset = h.indexAsset(project, 'broken.png');

    // Sharp will fail to decode the bogus bytes; the service surfaces this
    // as a thrown error (unexpected failure) rather than a controlled result.
    await expect(h.service.getThumbnail(project.id, asset.id)).rejects.toThrow();
  });
});

// ─── Service contract ────────────────────────────────────────────────────

describe('preview-service service contract', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  it('rejects an invalid project id', async () => {
    await expect(h.service.getThumbnail(0, 1)).rejects.toThrow(PreviewError);
    await expect(h.service.getThumbnail('x', 1)).rejects.toThrow(PreviewError);
    await expect(h.service.getThumbnail(-1, 1)).rejects.toThrow(PreviewError);
  });

  it('rejects an invalid asset id', async () => {
    await expect(h.service.getThumbnail(1, 0)).rejects.toThrow(PreviewError);
    await expect(h.service.getThumbnail(1, 'x')).rejects.toThrow(PreviewError);
  });

  it('throws PreviewNotFoundError for a missing project', async () => {
    await expect(h.service.getThumbnail(99999, 1)).rejects.toThrow(PreviewNotFoundError);
  });

  it('throws PreviewNotFoundError for a missing asset', async () => {
    const { project } = h.createProject('Has Project');
    await expect(h.service.getThumbnail(project.id, 99999)).rejects.toThrow(PreviewNotFoundError);
  });

  it('throws PreviewError when asset does not belong to project', async () => {
    const a = h.createProject('A');
    const b = h.createProject('B');
    const buf = await makePng(64, 64);
    writeProjectFile(a.absPath, 'x.png', buf);
    const asset = h.indexAsset(a.project, 'x.png');

    await expect(
      h.service.getThumbnail(b.project.id, asset.id)
    ).rejects.toThrow(PreviewError);
  });

  it('throws PreviewNotFoundError when the asset is marked not present', async () => {
    const { project, absPath } = h.createProject('Missing Project');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'gone.png', buf);
    const asset = h.indexAsset(project, 'gone.png');
    h.assetRepo.markMissingByProjectIdAndPathNotIn(project.id, []);
    await expect(
      h.service.getThumbnail(project.id, asset.id)
    ).rejects.toThrow(PreviewNotFoundError);
  });

  it('getOriginalDescriptor returns a descriptor with revision for a supported asset', async () => {
    const { project, absPath } = h.createProject('Desc Project');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'd.png', buf);
    const asset = h.indexAsset(project, 'd.png');

    const d = h.service.getOriginalDescriptor(project.id, asset.id);
    expect(d.status).toBe('ready');
    expect(d.previewable).toBe(true);
    expect(d.projectId).toBe(project.id);
    expect(d.assetId).toBe(asset.id);
    expect(d.relativePath).toBe('d.png');
    expect(d.extension).toBe('png');
    expect(d.mimeType).toBe('image/png');
    expect(d.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it('getOriginalDescriptor returns unsupported for a Krita asset', async () => {
    const { project, absPath } = h.createProject('Desc Krita');
    fs.writeFileSync(path.join(absPath, 'k.kra'), Buffer.from('x'));
    const asset = h.indexAsset(project, 'k.kra');

    const d = h.service.getOriginalDescriptor(project.id, asset.id);
    expect(d.status).toBe('unsupported');
    expect(d.previewable).toBe(false);
    expect(d.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never mutates database or source state during generation', async () => {
    const { project, absPath } = h.createProject('NoMutate');
    const buf = await makePng(200, 150);
    writeProjectFile(absPath, 'nm.png', buf);
    const asset = h.indexAsset(project, 'nm.png');

    const beforeAsset = h.assetRepo.findById(asset.id);
    await h.service.getPreview(project.id, asset.id);
    const afterAsset = h.assetRepo.findById(asset.id);

    // No asset field changed.
    expect(afterAsset).toEqual(beforeAsset);
  });
});

// ─── Cache freshness & lifecycle tests ───────────────────────────────────

describe('preview-service cache lifecycle', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  async function setupAssetWithPng(width = 800, height = 600) {
    const { project, absPath } = h.createProject('Cache Project');
    const buf = await makePng(width, height);
    writeProjectFile(absPath, 'c.png', buf);
    const asset = h.indexAsset(project, 'c.png');
    return { project, absPath, asset, buf };
  }

  it('cold generation writes thumbnail, preview, and meta.json under a published revision dir', async () => {
    const { project, asset } = await setupAssetWithPng();

    await h.service.getThumbnail(project.id, asset.id);
    await h.service.getPreview(project.id, asset.id);

    // A current.json pointer exists and references a valid revision dir.
    const pointer = readCurrentPointer(h.previewRoot, project.id, asset.id);
    expect(pointer.ok).toBe(true);
    expect(isValidRevisionDirName(pointer.pointer.dir)).toBe(true);

    const dir = publishedDir(h, project.id, asset.id);
    expect(fs.existsSync(path.join(dir, THUMBNAIL_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, PREVIEW_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, META_FILENAME))).toBe(true);

    const metaRes = readMetaFile(path.join(dir, META_FILENAME));
    expect(metaRes.ok).toBe(true);
    expect(metaRes.meta.thumbnail.format).toBe('webp');
    expect(metaRes.meta.preview.format).toBe('webp');
  });

  it('warm cache hit returns the same path and cacheState=fresh', async () => {
    const { project, asset } = await setupAssetWithPng();

    const first = await h.service.getThumbnail(project.id, asset.id);
    const firstPath = first.path;
    const firstBytes = fs.statSync(firstPath).size;
    expect(first.cacheState).toBe('regenerated');

    const second = await h.service.getThumbnail(project.id, asset.id);
    expect(second.cacheState).toBe('fresh');
    expect(second.path).toBe(firstPath);
    expect(second.bytes).toBe(firstBytes);
  });

  it('source-size revision change triggers regeneration', async () => {
    const { project, absPath, asset } = await setupAssetWithPng();
    const first = await h.service.getThumbnail(project.id, asset.id);

    // Replace source with a larger PNG and re-index with the new size.
    const bigger = await makePng(900, 700);
    writeProjectFile(absPath, 'c.png', bigger);
    const updated = h.assetRepo.upsert(project.id, 'c.png', {
      filename: 'c.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bigger.length,
      modifiedAt: '2026-07-29 10:00:00',
    });

    const second = await h.service.getThumbnail(updated.project_id, updated.id);
    expect(second.cacheState).toBe('regenerated');
    expect(second.revision).not.toBe(first.revision);
  });

  it('source-mtime revision change triggers regeneration', async () => {
    const { project, absPath, asset } = await setupAssetWithPng();
    const first = await h.service.getPreview(project.id, asset.id);

    // Same bytes, same size, only mtime changes.
    const srcPath = path.join(absPath, 'c.png');
    const pinned = new Date('2026-08-01T09:00:00.000Z');
    fs.utimesSync(srcPath, pinned, pinned);
    h.assetRepo.upsert(project.id, 'c.png', {
      filename: 'c.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: asset.size_bytes,
      modifiedAt: '2026-08-01 09:00:00',
    });

    const second = await h.service.getPreview(project.id, asset.id);
    expect(second.cacheState).toBe('regenerated');
    expect(second.revision).not.toBe(first.revision);
  });

  it('relative-path change triggers regeneration (same project, new path)', async () => {
    const { project, absPath, asset } = await setupAssetWithPng();
    await h.service.getPreview(project.id, asset.id);

    // Move the file to a new relative path and index it as a new asset.
    const buf = await makePng(800, 600);
    writeProjectFile(absPath, path.join('source', 'moved.png'), buf);
    const moved = h.indexAsset(project, path.join('source', 'moved.png'));

    const r = await h.service.getPreview(project.id, moved.id);
    expect(r.cacheState).toBe('regenerated');
    expect(r.revision).not.toBe(
      (await h.service.getOriginalDescriptor(project.id, asset.id)).revision
    );
  });

  it('derivative-version change invalidates the cache', async () => {
    const { project, asset } = await setupAssetWithPng();
    await h.service.getThumbnail(project.id, asset.id);

    // Tamper with the meta.json's derivativeConfigVersion to simulate a
    // pipeline-version bump on an existing entry.
    const metaPath = publishedFile(h, project.id, asset.id, META_FILENAME);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.derivativeConfigVersion = 999;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.cacheState).toBe('regenerated');
  });

  // ── Corrupt-cache detection ─────────────────────────────────────────

  it('regenerates when meta.json is missing', async () => {
    const { project, asset } = await setupAssetWithPng();
    await h.service.getThumbnail(project.id, asset.id);

    fs.rmSync(publishedFile(h, project.id, asset.id, META_FILENAME));
    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.cacheState).toBe('regenerated');
  });

  it('regenerates when meta.json is malformed', async () => {
    const { project, asset } = await setupAssetWithPng();
    await h.service.getThumbnail(project.id, asset.id);

    fs.writeFileSync(
      publishedFile(h, project.id, asset.id, META_FILENAME),
      '{ not valid json'
    );
    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.cacheState).toBe('regenerated');
  });

  it('regenerates when a derivative file is missing', async () => {
    const { project, asset } = await setupAssetWithPng();
    await h.service.getPreview(project.id, asset.id);

    fs.rmSync(publishedFile(h, project.id, asset.id, PREVIEW_FILENAME));
    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.cacheState).toBe('regenerated');
  });

  it('regenerates when a derivative file is not decodable as WebP', async () => {
    const { project, asset } = await setupAssetWithPng();
    await h.service.getPreview(project.id, asset.id);

    // Overwrite the preview with non-WebP bytes but keep the size matching
    // meta so the size check passes and the decode check is what catches it.
    const p = publishedFile(h, project.id, asset.id, PREVIEW_FILENAME);
    const originalSize = fs.statSync(p).size;
    fs.writeFileSync(p, Buffer.alloc(originalSize, 0x41));

    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.cacheState).toBe('regenerated');
  });

  it('regenerates when derivative byte size does not match meta', async () => {
    const { project, asset } = await setupAssetWithPng();
    await h.service.getPreview(project.id, asset.id);

    const p = publishedFile(h, project.id, asset.id, PREVIEW_FILENAME);
    // Append extra bytes so the on-disk size differs from meta.
    fs.appendFileSync(p, Buffer.from('extra'));
    const r = await h.service.getPreview(project.id, asset.id);
    expect(r.cacheState).toBe('regenerated');
  });

  it('regenerates when derivative metadata is incomplete (thumbnail block removed)', async () => {
    const { project, asset } = await setupAssetWithPng();
    await h.service.getThumbnail(project.id, asset.id);

    const metaPath = publishedFile(h, project.id, asset.id, META_FILENAME);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.thumbnail;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

    const r = await h.service.getThumbnail(project.id, asset.id);
    expect(r.cacheState).toBe('regenerated');
  });

  // ── Atomic failure cleanup ──────────────────────────────────────────

  it('a failed regeneration leaves no staging directory and keeps the prior cache', async () => {
    const { project, absPath, asset } = await setupAssetWithPng();
    // First generation succeeds and publishes a valid cache entry.
    await h.service.getThumbnail(project.id, asset.id);
    const thumbPath = publishedFile(h, project.id, asset.id, THUMBNAIL_FILENAME);
    const priorThumb = fs.readFileSync(thumbPath);
    const priorDir = publishedDir(h, project.id, asset.id);
    const priorPointer = fs.readFileSync(pointerPath(h, project.id, asset.id));

    // Corrupt the SOURCE so the next regeneration fails. The existing cache
    // entry should be left intact (the failure happens during staging,
    // before publication touches the pointer).
    fs.writeFileSync(path.join(absPath, 'c.png'), Buffer.from('broken'));
    h.assetRepo.upsert(project.id, 'c.png', {
      filename: 'c.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 6,
      modifiedAt: '2026-07-30 10:00:00',
    });

    await expect(h.service.getThumbnail(project.id, asset.id)).rejects.toThrow();

    // No staging (tmp-*) directories left in the cache root.
    const root = assetCacheRoot(h, project.id, asset.id);
    const stagingDirs = fs.readdirSync(root).filter((n) => n.startsWith('tmp-'));
    expect(stagingDirs).toEqual([]);
    // No stray temp files left by atomic writes.
    const temps = fs.readdirSync(root).filter((n) => n.endsWith('.tmp'));
    expect(temps).toEqual([]);
    // The previously published thumbnail and pointer are byte-for-byte
    // unchanged; the failure never reached publication.
    expect(fs.readFileSync(thumbPath).equals(priorThumb)).toBe(true);
    expect(fs.readFileSync(pointerPath(h, project.id, asset.id)).equals(priorPointer)).toBe(true);
    // The lock map is empty.
    expect(_lockCountForTests()).toBe(0);
    // The prior revision directory is untouched.
    expect(publishedDir(h, project.id, asset.id)).toBe(priorDir);
  });

  it('a valid prior cache survives a failed regeneration', async () => {
    const { project, absPath, asset } = await setupAssetWithPng();
    await h.service.getPreview(project.id, asset.id);
    const previewPath = publishedFile(h, project.id, asset.id, PREVIEW_FILENAME);
    const beforeBytes = fs.readFileSync(previewPath);

    // Change source so the revision differs, then corrupt the source so
    // regeneration fails. The stale-but-valid prior derivative should NOT
    // be destroyed by the failure.
    fs.writeFileSync(path.join(absPath, 'c.png'), Buffer.from('broken'));
    h.assetRepo.upsert(project.id, 'c.png', {
      filename: 'c.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 6,
      modifiedAt: '2026-07-31 10:00:00',
    });

    await expect(h.service.getPreview(project.id, asset.id)).rejects.toThrow();

    // The prior derivative file is unchanged.
    const afterBytes = fs.readFileSync(previewPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });
});

// ─── Concurrency tests ───────────────────────────────────────────────────

describe('preview-service concurrent generation', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  it('concurrent identical calls share one generation (thumbnail)', async () => {
    const { project, absPath } = h.createProject('Concurrent Thumb');
    const buf = await makePng(1200, 900);
    writeProjectFile(absPath, 'concurrent.png', buf);
    const asset = h.indexAsset(project, 'concurrent.png');

    const [a, b, c] = await Promise.all([
      h.service.getThumbnail(project.id, asset.id),
      h.service.getThumbnail(project.id, asset.id),
      h.service.getThumbnail(project.id, asset.id),
    ]);

    // All three resolved to the same ready result.
    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    expect(c.status).toBe('ready');
    expect(a.path).toBe(b.path);
    expect(b.path).toBe(c.path);
    expect(a.bytes).toBe(b.bytes);
    expect(b.bytes).toBe(c.bytes);

    // Lock map is empty after all operations settled.
    expect(_lockCountForTests()).toBe(0);
  });

  it('concurrent identical calls share one generation (preview)', async () => {
    const { project, absPath } = h.createProject('Concurrent Preview');
    const buf = await makePng(1800, 1200);
    writeProjectFile(absPath, 'big.png', buf);
    const asset = h.indexAsset(project, 'big.png');

    const results = await Promise.all([
      h.service.getPreview(project.id, asset.id),
      h.service.getPreview(project.id, asset.id),
    ]);
    expect(results[0].path).toBe(results[1].path);
    expect(results[0].bytes).toBe(results[1].bytes);
    expect(_lockCountForTests()).toBe(0);
  });

  it('different assets generate concurrently without interfering', async () => {
    const a = h.createProject('Concurrent A');
    const b = h.createProject('Concurrent B');
    const bufA = await makePng(500, 400);
    const bufB = await makePng(700, 300);
    writeProjectFile(a.absPath, 'a.png', bufA);
    writeProjectFile(b.absPath, 'b.png', bufB);
    const assetA = h.indexAsset(a.project, 'a.png');
    const assetB = h.indexAsset(b.project, 'b.png');

    const [rA, rB] = await Promise.all([
      h.service.getThumbnail(a.project.id, assetA.id),
      h.service.getThumbnail(b.project.id, assetB.id),
    ]);
    expect(rA.status).toBe('ready');
    expect(rB.status).toBe('ready');
    expect(rA.path).not.toBe(rB.path);
    expect(_lockCountForTests()).toBe(0);
  });

  it('lock is cleared after a rejected generation', async () => {
    const { project, absPath } = h.createProject('Lock Reject');
    fs.writeFileSync(path.join(absPath, 'broken.png'), Buffer.from('not png'));
    const asset = h.indexAsset(project, 'broken.png');

    await expect(
      h.service.getThumbnail(project.id, asset.id)
    ).rejects.toThrow();

    expect(_lockCountForTests()).toBe(0);
  });

  it('untrusted requested revision does not bypass freshness validation', async () => {
    const { project, absPath } = h.createProject('Untrusted Rev');
    const buf = await makePng(400, 300);
    writeProjectFile(absPath, 'u.png', buf);
    const asset = h.indexAsset(project, 'u.png');

    // First call populates the cache with the real revision.
    const first = await h.service.getThumbnail(project.id, asset.id);
    expect(first.cacheState).toBe('regenerated');

    // Second call with a bogus requested revision: the cache is still fresh
    // (validated against the real source), so it should hit, not regenerate.
    const second = await h.service.getThumbnail(
      project.id,
      asset.id,
      'ffffffffffffffff'
    );
    expect(second.cacheState).toBe('fresh');
    expect(second.revision).toBe(first.revision);
  });

  // ── Per-asset lock: thumbnail and preview share one generation ──────

  it('concurrent thumbnail and preview for the same asset share one generation', async () => {
    const { project, absPath } = h.createProject('Thumb+Preview Same Asset');
    const buf = await makePng(1200, 900);
    writeProjectFile(absPath, 'both.png', buf);
    const asset = h.indexAsset(project, 'both.png');

    // Count actual generation passes via the staging-dir hook. Because the
    // per-asset lock serializes these requests, only one may stage; the other
    // must observe the published cache and return fresh.
    let stagingCount = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => { stagingCount += 1; },
    });

    const [thumb, preview] = await Promise.all([
      service.getThumbnail(project.id, asset.id),
      service.getPreview(project.id, asset.id),
    ]);

    // Exactly one generation pass occurred.
    expect(stagingCount).toBe(1);
    // Both responses resolve to the same canonical (server-computed) revision.
    expect(thumb.status).toBe('ready');
    expect(preview.status).toBe('ready');
    expect(thumb.revision).toBe(preview.revision);
    expect(thumb.revision).toMatch(/^[0-9a-f]{16}$/);
    // One served a regenerated set, the other a fresh hit on the same set.
    const states = [thumb.cacheState, preview.cacheState].sort();
    expect(states).toEqual(['fresh', 'regenerated']);
    // The published cache is complete and valid.
    const dir = publishedDir(h, project.id, asset.id);
    expect(fs.existsSync(path.join(dir, THUMBNAIL_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, PREVIEW_FILENAME))).toBe(true);
    expect(readMetaFile(path.join(dir, META_FILENAME)).ok).toBe(true);
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
    expect(_lockCountForTests()).toBe(0);
  });

  it('arbitrary client requestedRevision tokens do not fragment the per-asset lock', async () => {
    const { project, absPath } = h.createProject('Arbitrary Rev Tokens');
    const buf = await makePng(900, 600);
    writeProjectFile(absPath, 'rev.png', buf);
    const asset = h.indexAsset(project, 'rev.png');

    let stagingCount = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => { stagingCount += 1; },
    });

    // Three concurrent requests with three different arbitrary client tokens.
    const results = await Promise.all([
      service.getThumbnail(project.id, asset.id, 'aabbccddeeff0011'),
      service.getThumbnail(project.id, asset.id, 'zzzzzzzzzzzzzzzz'),
      service.getThumbnail(project.id, asset.id, 'deadbeef'),
    ]);

    // Only one generation occurred; client tokens never created extra locks.
    expect(stagingCount).toBe(1);
    // All responses carry the server-computed revision, not the client tokens.
    for (const r of results) {
      expect(r.status).toBe('ready');
      expect(r.revision).toMatch(/^[0-9a-f]{16}$/);
      expect(r.revision).not.toBe('aabbccddeeff0011');
      expect(r.revision).not.toBe('deadbeef');
    }
    const revs = results.map((r) => r.revision);
    expect(new Set(revs).size).toBe(1);
    expect(_lockCountForTests()).toBe(0);
  });

  it('lock-map size does not grow per client token under high concurrency', async () => {
    const { project, absPath } = h.createProject('Lock Map Size');
    const buf = await makePng(900, 600);
    writeProjectFile(absPath, 'lock.png', buf);
    const asset = h.indexAsset(project, 'lock.png');

    let maxLockDuringGen = 0;
    let stagingCount = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => {
        stagingCount += 1;
        maxLockDuringGen = Math.max(maxLockDuringGen, _lockCountForTests());
      },
    });

    // 20 concurrent requests, each with a distinct invalid token. If the
    // lock key included the client token, the lock map would grow to 20
    // entries and all 20 would generate independently.
    const tokens = Array.from({ length: 20 }, (_, i) =>
      `zz${String(i).padStart(2, '0')}`.padEnd(16, 'x')
    );
    const results = await Promise.all(
      tokens.map((t) => service.getThumbnail(project.id, asset.id, t))
    );

    // Exactly one generation occurred.
    expect(stagingCount).toBe(1);
    // The lock map never exceeded 1 entry — client tokens never created
    // independent lock keys.
    expect(maxLockDuringGen).toBe(1);
    // All responses resolved to the server-computed revision.
    for (const r of results) {
      expect(r.status).toBe('ready');
      expect(r.revision).toMatch(/^[0-9a-f]{16}$/);
    }
    const revs = results.map((r) => r.revision);
    expect(new Set(revs).size).toBe(1);
    expect(_lockCountForTests()).toBe(0);
  });

  it('no arbitrary client token appears in a cache path or lock key', async () => {
    const { project, absPath } = h.createProject('No Token In Path');
    const buf = await makePng(900, 600);
    writeProjectFile(absPath, 'path.png', buf);
    const asset = h.indexAsset(project, 'path.png');

    const evilTokens = [
      '../../../../etc/passwd',     // traversal
      '..%2F..%2Fsecret',           // encoded traversal
      'aabbccddeeff0011',           // valid-looking but stale
      'AAAAAAAAAAAAAAAA',           // uppercase (invalid)
      'very-long-token-string-that-exceeds-normal-length',
    ];

    for (const token of evilTokens) {
      await h.service.getThumbnail(project.id, asset.id, token);
    }

    // Walk every file and directory name under the asset's cache root and
    // assert no evil token substring appears in any name.
    const cacheRoot = assetCacheRoot(h, project.id, asset.id);
    expect(fs.existsSync(cacheRoot)).toBe(true);

    const allNames = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        allNames.push(entry.name);
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
        }
      }
    }
    walk(cacheRoot);

    for (const name of allNames) {
      for (const token of evilTokens) {
        expect(name).not.toContain(token);
      }
    }
    expect(_lockCountForTests()).toBe(0);
  });

  // ── Source changes during generation ────────────────────────────────

  it('source changing during generation discards the older revision and publishes the newer', async () => {
    const { project, absPath } = h.createProject('Source Change Mid-Gen');
    const bufA = await makePng(800, 600, { r: 10, g: 20, b: 30 });
    writeProjectFile(absPath, 's.png', bufA);
    const asset = h.indexAsset(project, 's.png');

    // Publish an initial cache for revision A so there is a "prior" to protect.
    await h.service.getThumbnail(project.id, asset.id);
    const revA = h.service.getOriginalDescriptor(project.id, asset.id).revision;

    // Gate the pre-publish recheck so the test can move the source while the
    // generation for A is staged but not yet published.
    const gate = makeGate();
    let stagingCount = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => { stagingCount += 1; },
      beforePublishRecheck: () => gate.promise,
    });

    // Change the recorded source to revision B BEFORE the generation starts,
    // then move it again to C while attempt #1 is paused at the recheck.
    // (We move it to B first so the request reloads B and generates for B;
    // then while it is paused we move to C so the recheck discards B and the
    // retry publishes C. This proves the staged B output never overwrites
    // anything and the final cache describes C.)
    const bufB = await makePng(820, 600, { r: 40, g: 20, b: 30 });
    writeProjectFile(absPath, 's.png', bufB);
    h.assetRepo.upsert(project.id, 's.png', {
      filename: 's.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bufB.length,
      modifiedAt: '2026-10-01 10:00:00',
    });

    const pending = service.getThumbnail(project.id, asset.id);

    // While attempt #1 (for B) is paused at the recheck, move the source to C.
    const bufC = await makePng(840, 600, { r: 70, g: 20, b: 30 });
    writeProjectFile(absPath, 's.png', bufC);
    h.assetRepo.upsert(project.id, 's.png', {
      filename: 's.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bufC.length,
      modifiedAt: '2026-10-02 10:00:00',
    });
    const revC = h.service.getOriginalDescriptor(project.id, asset.id).revision;
    expect(revC).not.toBe(revA);

    // Release attempt #1: its recheck sees C != B → discard, retry for C.
    gate.release();
    const result = await pending;

    // Two staging passes: attempt #1 (B, discarded) + attempt #2 (C, published).
    expect(stagingCount).toBe(2);
    expect(result.status).toBe('ready');
    expect(result.revision).toBe(revC);

    // The final derivatives and metadata all describe revision C.
    const meta = readMetaFile(
      path.join(publishedDir(h, project.id, asset.id), META_FILENAME)
    ).meta;
    expect(meta.source.size).toBe(bufC.length);
    expect(meta.source.mtime).toBe('2026-10-02T10:00:00.000Z');
    // The published pointer references revision C.
    const pointer = readCurrentPointer(h.previewRoot, project.id, asset.id);
    expect(pointer.pointer.revision).toBe(revC);
    // No mixed files: a single complete published dir, no staging left.
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
    expect(_lockCountForTests()).toBe(0);
  });

  it('source changing during both attempts returns a controlled failure and leaves the prior cache byte-for-byte unchanged', async () => {
    const { project, absPath } = h.createProject('Source Change Twice');
    const bufA = await makePng(800, 600);
    writeProjectFile(absPath, 'twice.png', bufA);
    const asset = h.indexAsset(project, 'twice.png');

    // Establish a prior published cache.
    await h.service.getPreview(project.id, asset.id);
    const snap = snapshotCache(h, project.id, asset.id);

    // Two gates: one per generation attempt.
    const gates = [makeGate(), makeGate()];
    let idx = 0;
    let stagingCount = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => { stagingCount += 1; },
      beforePublishRecheck: () => {
        const g = gates[idx];
        idx += 1;
        return g.promise;
      },
    });

    // Move source to B before starting (so the request generates for B).
    const bufB = await makePng(820, 600);
    writeProjectFile(absPath, 'twice.png', bufB);
    h.assetRepo.upsert(project.id, 'twice.png', {
      filename: 'twice.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bufB.length,
      modifiedAt: '2026-10-10 10:00:00',
    });

    const pending = service.getPreview(project.id, asset.id);

    // Attempt #1 (for B) is paused; move source to C, then release.
    const bufC = await makePng(840, 600);
    writeProjectFile(absPath, 'twice.png', bufC);
    h.assetRepo.upsert(project.id, 'twice.png', {
      filename: 'twice.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bufC.length,
      modifiedAt: '2026-10-11 10:00:00',
    });
    gates[0].release();

    // Attempt #2 (for C) will pause; but to force BOTH attempts to be stale,
    // move the source again to D before releasing the second gate.
    // We need attempt #2 to also observe a mismatch at its recheck. Because
    // the recheck runs after beforePublishRecheck resolves, move to D now
    // (before releasing gate[1]) so attempt #2 generates for C but rechecks
    // against D.
    // Wait until attempt #2 has staged for C: it stages after attempt #1's
    // recheck discarded B. We poll the staging count.
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (stagingCount >= 2) return resolve();
        if (Date.now() - start > 5000) return resolve(new Error('staging #2 never started'));
        setTimeout(tick, 5);
      };
      tick();
    });

    const bufD = await makePng(860, 600);
    writeProjectFile(absPath, 'twice.png', bufD);
    h.assetRepo.upsert(project.id, 'twice.png', {
      filename: 'twice.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bufD.length,
      modifiedAt: '2026-10-12 10:00:00',
    });
    gates[1].release();

    // Both attempts were stale → controlled PreviewError failure.
    await expect(pending).rejects.toThrow(PreviewError);

    // The prior cache (revision A) is byte-for-byte unchanged.
    const after = snapshotCache(h, project.id, asset.id);
    expect(after.pointer.equals(snap.pointer)).toBe(true);
    expect(after.thumbnail.equals(snap.thumbnail)).toBe(true);
    expect(after.preview.equals(snap.preview)).toBe(true);
    expect(after.meta.equals(snap.meta)).toBe(true);
    expect(after.dir).toBe(snap.dir);
    // No staging directories survived.
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
    expect(_lockCountForTests()).toBe(0);
  });
});

// ─── Failure preservation tests ──────────────────────────────────────────

describe('preview-service failure preservation (forced failures per stage)', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  it('fails during actual derivative validation after staged bytes exist', async () => {
    const { project, asset, snapshot } = await prepareFailureFixture(h);
    const originalReadFileSync = fs.readFileSync;
    let stagedBytes;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      const candidate = String(filePath);
      if (
        path.basename(candidate) === THUMBNAIL_FILENAME &&
        path.basename(path.dirname(candidate)).startsWith('tmp-')
      ) {
        stagedBytes = originalReadFileSync.call(fs, filePath, ...args);
        throw new Error('injected derivative validation failure');
      }
      return originalReadFileSync.call(fs, filePath, ...args);
    });
    try {
      await expect(h.service.getPreview(project.id, asset.id)).rejects.toThrow(
        'injected derivative validation failure'
      );
    } finally {
      readSpy.mockRestore();
    }

    expect(Buffer.isBuffer(stagedBytes)).toBe(true);
    expect(stagedBytes.length).toBeGreaterThan(0);
    assertFailurePreserved(h, project.id, asset.id, snapshot);
  });

  it('fails during actual metadata rename after both staged derivatives are complete', async () => {
    const { project, asset, snapshot } = await prepareFailureFixture(h);
    const originalRenameSync = fs.renameSync;
    let metadataTempExisted = false;
    let stagedDerivativesComplete = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      const sourcePath = String(source);
      const targetPath = String(target);
      if (
        path.basename(targetPath) === META_FILENAME &&
        path.basename(sourcePath).includes('.meta.json.webp.tmp')
      ) {
        metadataTempExisted = fs.existsSync(sourcePath);
        const stagingDir = path.dirname(sourcePath);
        stagedDerivativesComplete =
          fs.existsSync(path.join(stagingDir, THUMBNAIL_FILENAME)) &&
          fs.existsSync(path.join(stagingDir, PREVIEW_FILENAME));
        throw new Error('injected metadata rename failure');
      }
      return originalRenameSync.call(fs, source, target);
    });
    try {
      await expect(h.service.getPreview(project.id, asset.id)).rejects.toThrow(
        'Cannot write cache file'
      );
    } finally {
      renameSpy.mockRestore();
    }

    expect(metadataTempExisted).toBe(true);
    expect(stagedDerivativesComplete).toBe(true);
    assertFailurePreserved(h, project.id, asset.id, snapshot);
  });

  it('fails during actual staging-to-revision rename after the complete staged set exists', async () => {
    const { project, asset, snapshot } = await prepareFailureFixture(h);
    const originalRenameSync = fs.renameSync;
    let completeStagingObserved = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      const sourcePath = String(source);
      const targetPath = String(target);
      if (
        path.basename(sourcePath).startsWith('tmp-') &&
        path.basename(targetPath).startsWith('r-')
      ) {
        const names = new Set(fs.readdirSync(sourcePath));
        completeStagingObserved = [
          THUMBNAIL_FILENAME,
          PREVIEW_FILENAME,
          META_FILENAME,
        ].every((name) => names.has(name));
        throw new Error('injected staging promotion failure');
      }
      return originalRenameSync.call(fs, source, target);
    });
    try {
      await expect(h.service.getPreview(project.id, asset.id)).rejects.toThrow(
        'Failed to publish derivative cache'
      );
    } finally {
      renameSpy.mockRestore();
    }

    expect(completeStagingObserved).toBe(true);
    assertFailurePreserved(h, project.id, asset.id, snapshot);
  });

  it('fails during actual current.json temp-file write after revision promotion', async () => {
    const { project, asset, snapshot } = await prepareFailureFixture(h);
    const originalOpenSync = fs.openSync;
    const originalWriteSync = fs.writeSync;
    let pointerFd = null;
    let pointerTempPath = null;
    let pointerTempExisted = false;
    let promotedRevisionObserved = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
      const fd = originalOpenSync.call(fs, filePath, ...args);
      if (path.basename(String(filePath)).includes('.current.json.webp.tmp')) {
        pointerFd = fd;
        pointerTempPath = String(filePath);
      }
      return fd;
    });
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation((fd, ...args) => {
      if (fd === pointerFd) {
        pointerTempExisted = fs.existsSync(pointerTempPath);
        promotedRevisionObserved =
          fs.readdirSync(path.dirname(pointerTempPath)).filter((name) => name.startsWith('r-')).length === 2;
        throw new Error('injected current pointer write failure');
      }
      return originalWriteSync.call(fs, fd, ...args);
    });
    try {
      await expect(h.service.getPreview(project.id, asset.id)).rejects.toThrow(
        'Cannot write cache file'
      );
    } finally {
      writeSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(pointerTempExisted).toBe(true);
    expect(promotedRevisionObserved).toBe(true);
    assertFailurePreserved(h, project.id, asset.id, snapshot);
  });

  it('fails during actual current.json temp-to-final rename after pointer bytes exist', async () => {
    const { project, asset, snapshot } = await prepareFailureFixture(h);
    const originalRenameSync = fs.renameSync;
    let pointerTempExisted = false;
    let promotedRevisionObserved = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      const sourcePath = String(source);
      const targetPath = String(target);
      if (
        path.basename(targetPath) === CURRENT_POINTER_FILENAME &&
        path.basename(sourcePath).includes('.current.json.webp.tmp')
      ) {
        pointerTempExisted = fs.existsSync(sourcePath);
        promotedRevisionObserved =
          fs.readdirSync(path.dirname(sourcePath)).filter((name) => name.startsWith('r-')).length === 2;
        throw new Error('injected current pointer rename failure');
      }
      return originalRenameSync.call(fs, source, target);
    });
    try {
      await expect(h.service.getPreview(project.id, asset.id)).rejects.toThrow(
        'Cannot write cache file'
      );
    } finally {
      renameSpy.mockRestore();
    }

    expect(pointerTempExisted).toBe(true);
    expect(promotedRevisionObserved).toBe(true);
    assertFailurePreserved(h, project.id, asset.id, snapshot);
  });

  /**
   * Shared driver: publishes a valid cache, snapshots it, changes the source
   * so the next request must regenerate, then runs a hooked service that
   * throws at the named stage. Asserts the call fails AND the prior complete
   * cache (thumbnail, preview, meta, current.json pointer) is byte-for-byte
   * unchanged, with no staging/temp directories left and the lock released.
   */
  async function runFailureCase(hookName) {
    const { project, absPath, asset } = await (async () => {
      const ctx = h.createProject('Failure Project');
      const buf = await makePng(900, 700);
      writeProjectFile(ctx.absPath, 'f.png', buf);
      const a = h.indexAsset(ctx.project, 'f.png');
      return { project: ctx.project, absPath: ctx.absPath, asset: a };
    })();

    // 1. Publish a valid prior cache.
    await h.service.getPreview(project.id, asset.id);
    const snap = snapshotCache(h, project.id, asset.id);

    // 2. Change the recorded source so the next request regenerates.
    const next = await makePng(920, 700, { r: 5, g: 5, b: 5 });
    writeProjectFile(absPath, 'f.png', next);
    h.assetRepo.upsert(project.id, 'f.png', {
      filename: 'f.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: next.length,
      modifiedAt: '2026-11-01 10:00:00',
    });

    // 3. Hooked service throws at the target stage.
    const service = makeHookedService(h, {
      [hookName]: () => {
        throw new Error(`forced failure at ${hookName}`);
      },
    });

    // 4. The call must fail.
    await expect(service.getPreview(project.id, asset.id)).rejects.toThrow(
      `forced failure at ${hookName}`
    );

    // 5. The prior complete cache is byte-for-byte unchanged.
    const after = snapshotCache(h, project.id, asset.id);
    expect(after.pointer.equals(snap.pointer)).toBe(true);
    expect(after.thumbnail.equals(snap.thumbnail)).toBe(true);
    expect(after.preview.equals(snap.preview)).toBe(true);
    expect(after.meta.equals(snap.meta)).toBe(true);
    expect(after.dir).toBe(snap.dir);

    // 6. No staging directories or stray temp files remain.
    const root = assetCacheRoot(h, project.id, asset.id);
    const staging = fs.readdirSync(root).filter((n) => n.startsWith('tmp-'));
    expect(staging).toEqual([]);
    const temps = fs.readdirSync(root).filter((n) => n.endsWith('.tmp'));
    expect(temps).toEqual([]);
    // No orphaned revision directories were left unreferenced by the pointer
    // either (a failed post-rename publication removes its promoted dir).
    const revDirs = fs.readdirSync(root).filter((n) => n.startsWith('r-'));
    expect(revDirs).toEqual([path.basename(snap.dir)]);

    // 7. The lock was released.
    expect(_lockCountForTests()).toBe(0);
  }

  it('thumbnail transformation failure preserves the prior cache', async () => {
    await runFailureCase('beforeThumbTransform');
  });

  it('thumbnail validation failure preserves the prior cache', async () => {
    await runFailureCase('beforeThumbValidate');
  });

  it('preview transformation failure preserves the prior cache', async () => {
    await runFailureCase('beforePreviewTransform');
  });

  it('preview validation failure preserves the prior cache', async () => {
    await runFailureCase('beforePreviewValidate');
  });

  it('staged metadata creation failure preserves the prior cache', async () => {
    await runFailureCase('beforeMetaWrite');
  });

  it('staged set validation failure preserves the prior cache', async () => {
    await runFailureCase('beforeStagedSetValidate');
  });

  it('publication failure before the first final replacement preserves the prior cache', async () => {
    await runFailureCase('beforePublishRename');
  });

  it('publication failure after the rename (before pointer replacement) preserves the prior cache', async () => {
    await runFailureCase('beforePointerWrite');
  });
});

// ─── classifyPreviewable unit tests ──────────────────────────────────────

describe('classifyPreviewable', () => {
  it('supports png with image/png', () => {
    expect(classifyPreviewable({ extension: 'png', mime_type: 'image/png' }).supported).toBe(true);
  });

  it('supports jpg/jpeg case-insensitively', () => {
    expect(classifyPreviewable({ extension: 'JPG', mime_type: 'image/jpeg' }).supported).toBe(true);
    expect(classifyPreviewable({ extension: 'JPEG', mime_type: 'IMAGE/JPEG' }).supported).toBe(true);
  });

  it('supports webp and gif', () => {
    expect(classifyPreviewable({ extension: 'webp', mime_type: 'image/webp' }).supported).toBe(true);
    expect(classifyPreviewable({ extension: 'gif', mime_type: 'image/gif' }).supported).toBe(true);
  });

  it('rejects krita extensions regardless of MIME', () => {
    expect(classifyPreviewable({ extension: 'kra', mime_type: 'application/x-krita' }).supported).toBe(false);
    expect(classifyPreviewable({ extension: 'krz', mime_type: 'application/x-krita' }).supported).toBe(false);
  });

  it('rejects unknown extensions', () => {
    expect(classifyPreviewable({ extension: 'bin', mime_type: 'application/octet-stream' }).supported).toBe(false);
    expect(classifyPreviewable({ extension: '', mime_type: '' }).supported).toBe(false);
  });

  it('rejects extension/MIME mismatch', () => {
    expect(classifyPreviewable({ extension: 'png', mime_type: 'application/octet-stream' }).supported).toBe(false);
    expect(classifyPreviewable({ extension: 'png', mime_type: 'image/jpeg' }).supported).toBe(false);
    expect(classifyPreviewable({ extension: 'bin', mime_type: 'image/png' }).supported).toBe(false);
  });
});