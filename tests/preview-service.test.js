import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createProjectImageSettingsService } from '../src/services/project-image-settings-service.js';
import {
  projectImageGenerationIdentities,
  projectImagePolicyFingerprint,
  projectImagePresentationPolicy,
  projectImageRebuildScope,
} from '../src/services/project-image-policy.js';
import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { inspectSourceAnimation } from '../src/services/source-animation.js';
import { createSourceAnimationService } from '../src/services/source-animation-service.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { createGeneratedImageRebuildService } from '../src/services/generated-image-rebuild-service.js';
import { createGeneratedImageRebuildRepository } from '../src/data/generated-image-rebuild-repository.js';
import {
  formatProjectDirName,
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
  PreviewGenerationError,
  PreviewNotFoundError,
  classifyPreviewable,
  buildAssetRevisionToken,
  buildDerivativePipeline,
  THUMBNAIL_MAX,
  PREVIEW_MAX,
  _lockCountForTests,
} from '../src/services/preview-service.js';
import { makeZip } from './helpers/zip-fixture.js';
import { makeAnimatedWebp, makeSolidAnimatedWebp } from './helpers/animated-webp.js';

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

function makeKritaArchive({ merged = null, preview = null, deflated = false } = {}) {
  const entries = [];
  if (preview) {
    entries.push({
      name: 'preview.png',
      data: preview,
      ...(deflated ? { compression: 'deflate' } : {}),
    });
  }
  if (merged) {
    entries.push({
      name: 'mergedimage.png',
      data: merged,
      ...(deflated ? { compression: 'deflate' } : {}),
    });
  }
  return makeZip(entries);
}

// ─── Test harness ────────────────────────────────────────────────────────

function makeHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preview-svc-'));
  const projectsRoot = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
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
      projectType: 'images',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    // Flat layout: the project directory is a direct child of PROJECTS_ROOT.
    const dirName = formatProjectDirName(project.id, project.slug);
    const relPath = dirName;
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
  function indexAsset(projectOrCtx, relPath, { mimeType, sizeBytes, modifiedAt, sourceAnimated } = {}) {
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
      modifiedAt: modifiedAt ?? stat.mtime.toISOString(),
      sourceAnimated,
    });
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
  fs.utimesSync(path.join(ctx.absPath, 'f.png'), new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'));
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

  it('generates a KRA preview from mergedimage.png even when preview.png appears first', async () => {
    const { project, absPath } = h.createProject('KRA Merged Project');
    const merged = await makePng(2000, 1000);
    const thumbnail = await makePng(320, 160);
    writeProjectFile(
      absPath,
      'draw.kra',
      makeKritaArchive({ merged, preview: thumbnail, deflated: true })
    );
    const asset = h.indexAsset(project, 'draw.kra');

    const r = await h.service.getPreview(project.id, asset.id);

    expect(r.status).toBe('ready');
    expect(r.quality).toBe('merged');
    expect(r.width).toBe(1600);
    expect(r.height).toBe(800);
    expect(r.path.startsWith(h.previewRoot)).toBe(true);
    expect(fs.existsSync(path.join(absPath, 'mergedimage.png'))).toBe(false);
    expect(fs.existsSync(path.join(absPath, 'preview.png'))).toBe(false);

    const sh = await sharp();
    const meta = await sh(fs.readFileSync(r.path)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(800);
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.source.previewQuality)
      .toBe('merged');
  });

  it('generates a KRA thumbnail from the merged preview', async () => {
    const { project, absPath } = h.createProject('KRA Thumbnail Project');
    const merged = await makePng(2000, 1000);
    writeProjectFile(absPath, 'draw.kra', makeKritaArchive({ merged }));
    const asset = h.indexAsset(project, 'draw.kra');

    const r = await h.service.getThumbnail(project.id, asset.id);

    expect(r.status).toBe('ready');
    expect(r.quality).toBe('merged');
    expect(r.width).toBe(256);
    expect(r.height).toBe(128);
  });

  it('generates preview-only KRA derivatives without server enlargement', async () => {
    const { project, absPath } = h.createProject('KRA Fallback Project');
    const preview = await makePng(320, 180);
    writeProjectFile(absPath, 'fallback.kra', makeKritaArchive({ preview }));
    const asset = h.indexAsset(project, 'fallback.kra');

    const previewResult = await h.service.getPreview(project.id, asset.id);
    const thumbnailResult = await h.service.getThumbnail(project.id, asset.id);

    expect(previewResult.status).toBe('ready');
    expect(previewResult.quality).toBe('thumbnail');
    expect(previewResult.width).toBe(320);
    expect(previewResult.height).toBe(180);
    expect(thumbnailResult.quality).toBe('thumbnail');
    expect(thumbnailResult.width).toBe(256);
    expect(thumbnailResult.height).toBe(144);
  });

  it('generates KRZ derivatives from preview.png without server enlargement', async () => {
    const { project, absPath } = h.createProject('KRZ Project');
    const preview = await makePng(320, 180);
    writeProjectFile(
      absPath,
      'draw.krz',
      makeKritaArchive({ merged: Buffer.from('ignored merged entry'), preview })
    );
    const asset = h.indexAsset(project, 'draw.krz');

    const r = await h.service.getPreview(project.id, asset.id);

    expect(r.status).toBe('ready');
    expect(r.quality).toBe('thumbnail');
    expect(r.width).toBe(320);
    expect(r.height).toBe(180);
  });

  it('maps corrupt archives to a controlled preview-generation failure', async () => {
    const { project, absPath } = h.createProject('Corrupt KRA Project');
    fs.writeFileSync(path.join(absPath, 'broken.kra'), Buffer.from('not a zip'));
    const asset = h.indexAsset(project, 'broken.kra');

    await expect(h.service.getPreview(project.id, asset.id)).rejects.toMatchObject({
      name: 'PreviewGenerationError',
      message: 'Embedded preview unavailable.',
    });
  });

  it('maps an absent embedded preview to a controlled failure', async () => {
    const { project, absPath } = h.createProject('Absent KRA Project');
    writeProjectFile(
      absPath,
      'absent.kra',
      makeZip([{ name: 'maindoc.xml', data: Buffer.from('<doc/>') }])
    );
    const asset = h.indexAsset(project, 'absent.kra');

    await expect(h.service.getPreview(project.id, asset.id)).rejects.toBeInstanceOf(
      PreviewGenerationError
    );
  });

  it('maps a corrupt embedded PNG to a controlled failure without archive details', async () => {
    const { project, absPath } = h.createProject('Corrupt Embedded PNG');
    writeProjectFile(
      absPath,
      'broken-preview.kra',
      makeKritaArchive({ preview: Buffer.from('not a png') })
    );
    const asset = h.indexAsset(project, 'broken-preview.kra');

    await expect(h.service.getPreview(project.id, asset.id)).rejects.toMatchObject({
      name: 'PreviewGenerationError',
      message: 'Source image cannot be decoded.',
    });
  });

  it('uses the cache on a warm KRA request without re-extracting the source', async () => {
    const { project, absPath } = h.createProject('KRA Cache Project');
    const preview = await makePng(640, 360);
    writeProjectFile(absPath, 'cached.kra', makeKritaArchive({ preview }));
    const asset = h.indexAsset(project, 'cached.kra');

    const first = await h.service.getPreview(project.id, asset.id);
    fs.rmSync(path.join(absPath, 'cached.kra'));
    const second = await h.service.getPreview(project.id, asset.id);

    expect(first.cacheState).toBe('regenerated');
    expect(first.quality).toBe('thumbnail');
    expect(second.cacheState).toBe('fresh');
    expect(second.quality).toBe('thumbnail');
    expect(second.path).toBe(first.path);
  });

  it('regenerates a KRA derivative when recorded size or mtime changes', async () => {
    const { project, absPath } = h.createProject('KRA Revision Project');
    const firstPreview = await makePng(640, 360);
    writeProjectFile(absPath, 'revision.kra', makeKritaArchive({ preview: firstPreview }));
    const asset = h.indexAsset(project, 'revision.kra');
    const first = await h.service.getPreview(project.id, asset.id);

    const nextPreview = await makePng(800, 400, { r: 10, g: 20, b: 30 });
    const nextArchive = makeKritaArchive({ preview: nextPreview });
    writeProjectFile(absPath, 'revision.kra', nextArchive);
    const updated = h.assetRepo.upsert(project.id, 'revision.kra', {
      filename: 'revision.kra',
      extension: 'kra',
      mimeType: 'application/x-krita',
      sizeBytes: nextArchive.length,
      modifiedAt: '2026-08-02 12:00:00',
    });

    const second = await h.service.getPreview(project.id, asset.id);

    expect(updated.id).toBe(asset.id);
    expect(second.cacheState).toBe('regenerated');
    expect(second.revision).not.toBe(first.revision);
    expect(second.width).toBe(800);
    expect(second.height).toBe(400);
  });

  it('keeps concurrent KRA requests serialized by the existing per-asset lock', async () => {
    const { project, absPath } = h.createProject('Concurrent KRA Project');
    const preview = await makePng(640, 360);
    writeProjectFile(absPath, 'concurrent.kra', makeKritaArchive({ preview }));
    const asset = h.indexAsset(project, 'concurrent.kra');
    let stagingCount = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => { stagingCount += 1; },
    });

    const [first, second] = await Promise.all([
      service.getPreview(project.id, asset.id),
      service.getPreview(project.id, asset.id),
    ]);

    expect(stagingCount).toBe(1);
    expect(first.revision).toBe(second.revision);
    expect(_lockCountForTests()).toBe(0);
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

describe('project image policy derivatives', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.cleanup(); });

  function settings() {
    return createAppMetaRepository(h.db);
  }

  function set(name, value) {
    settings().setValue(name, String(value));
  }

  async function source(name, bytes) {
    const { project, absPath } = h.createProject(`Policy ${name}`);
    writeProjectFile(absPath, name, bytes);
    const sourceAnimated = ((await (await sharp())(bytes).metadata()).pages ?? 1) > 1;
    return { project, absPath, asset: h.indexAsset(project, name, { sourceAnimated }) };
  }

  async function metadata(result) {
    return (await (await sharp())(fs.readFileSync(result.path)).metadata());
  }

  function padStillGif(bytes, size) {
    const extra = size - bytes.length;
    if (extra < 5 || extra > 258 || bytes.at(-1) !== 0x3b) {
      throw new Error('GIF fixture cannot be padded to the requested size.');
    }
    return Buffer.concat([
      bytes.subarray(0, -1), Buffer.from([0x21, 0xfe, extra - 4]),
      Buffer.alloc(extra - 4), Buffer.from([0, 0x3b]),
    ]);
  }

  function padStillWebp(bytes, size) {
    const extra = size - bytes.length;
    if (extra < 8 || extra % 2 !== 0) {
      throw new Error('WebP fixture cannot be padded to the requested size.');
    }
    const chunk = Buffer.alloc(extra);
    chunk.write('JUNK', 0);
    chunk.writeUInt32LE(extra - 8, 4);
    const padded = Buffer.concat([bytes, chunk]);
    padded.writeUInt32LE(padded.length - 8, 4);
    return padded;
  }

  async function legacySource(name, bytes) {
    const { project, absPath } = h.createProject(`Legacy ${name}`);
    writeProjectFile(absPath, name, bytes);
    const filePath = path.join(absPath, name);
    const asset = h.indexAsset(project, name, {
      modifiedAt: fs.statSync(filePath).mtime.toISOString(),
    });
    const imageSettings = createProjectImageSettingsService({
      appMetaRepository: settings(),
      sourceAnimationService: createSourceAnimationService({
        assetRepository: h.assetRepo,
        projectRepository: h.projectRepo,
        projectsRoot: h.projectsRoot,
      }),
    });
    return { project, asset, filePath, imageSettings };
  }

  it.each([
    ['still WebP', 'legacy.webp', async () => makeWebp(40, 30), false],
    ['still GIF', 'legacy.gif', async () => (await sharp())({
      create: { width: 40, height: 30, channels: 3, background: '#ffffff' },
    }).gif().toBuffer(), false],
    ['animated WebP', 'legacy.webp', async () => makeSolidAnimatedWebp(3, { width: 40, height: 30 }), true],
    ['animated GIF', 'legacy.gif', async () => makeAnimatedGif(40, 30, 3), true],
  ])('reconciles legacy %s before identity without a scan', async (_label, name, makeBytes, animated) => {
    set('images.preview.format', 'png');
    set('images.preview.webp_quality', 52);
    const { project, asset, filePath, imageSettings } = await legacySource(name, await makeBytes());
    expect(asset.source_animated).toBeNull();
    const originalUpdatedAt = asset.updated_at;

    const first = buildAssetPreviewModel(asset, imageSettings.getPresentationPolicy());
    const learned = h.assetRepo.findById(asset.id);
    expect(learned.source_animated).toBe(Number(animated));
    expect(learned.updated_at).toBe(originalUpdatedAt);
    expect(first.revision).toBe(buildAssetPreviewModel(learned, imageSettings.getPresentationPolicy()).revision);
    const firstFingerprint = projectImagePolicyFingerprint(imageSettings.getPolicy(), learned);
    const generated = await h.service.getPreview(project.id, asset.id);
    expect(generated.revision).toBe(first.revision);
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.policyFingerprint)
      .toBe(firstFingerprint);
    expect((await metadata(generated)).format).toBe(animated ? 'webp' : 'png');

    set('images.preview.webp_quality', 71);
    const next = buildAssetPreviewModel(asset, imageSettings.getPresentationPolicy());
    const nextFingerprint = projectImagePolicyFingerprint(imageSettings.getPolicy(), learned);
    expect(nextFingerprint === firstFingerprint).toBe(!animated);
    expect(next.revision === first.revision).toBe(!animated);
    const nextGenerated = await h.service.getPreview(project.id, asset.id);
    expect(nextGenerated.cacheState).toBe(animated ? 'prior-policy' : 'fresh');
    const current = await h.service.ensureCurrentPreview(project.id, asset.id);
    expect(current.revision === generated.revision).toBe(!animated);

    fs.unlinkSync(filePath);
    expect(buildAssetPreviewModel(asset, imageSettings.getPresentationPolicy()).revision)
      .toBe(next.revision);
  });

  it('keeps an unavailable legacy source unknown and rejects stale metadata writes', async () => {
    set('images.preview.format', 'png');
    const { project, asset, filePath, imageSettings } = await legacySource('unavailable.webp',
      await makeWebp(40, 30));
    fs.unlinkSync(filePath);
    buildAssetPreviewModel(asset, imageSettings.getPresentationPolicy());
    expect(h.assetRepo.findById(asset.id).source_animated).toBeNull();
    await expect(h.service.getPreview(project.id, asset.id)).rejects.toThrow();

    const replacement = await makeWebp(50, 40);
    writeProjectFile(path.dirname(filePath), path.basename(filePath), replacement);
    const stat = fs.statSync(filePath);
    h.assetRepo.upsert(project.id, 'unavailable.webp', {
      filename: 'unavailable.webp', extension: 'webp', mimeType: 'image/webp',
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
    });
    expect(h.assetRepo.setSourceAnimationIfUnknown(asset, 0)).toBeUndefined();
    expect(h.assetRepo.findById(asset.id).source_animated).toBeNull();
  });

  it('classifies a legacy still WebP when generation is the first identity path', async () => {
    set('images.preview.format', 'png');
    const { project, asset, imageSettings } = await legacySource('generation-first.webp',
      await makeWebp(40, 30));
    const generated = await h.service.getPreview(project.id, asset.id);
    const learned = h.assetRepo.findById(asset.id);
    expect(learned.source_animated).toBe(0);
    expect((await metadata(generated)).format).toBe('png');
    expect(generated.revision).toBe(buildAssetPreviewModel(learned,
      imageSettings.getPresentationPolicy()).revision);
    set('images.preview.webp_quality', 71);
    expect((await h.service.getPreview(project.id, asset.id)).cacheState).toBe('fresh');
  });

  it.each([
    ['still to animated WebP', 'webp', async () => makeWebp(40, 30), async () => makeSolidAnimatedWebp(3, { width: 40, height: 30 }), 0, 1, 'webp'],
    ['animated to still WebP', 'webp', async () => makeSolidAnimatedWebp(3, { width: 40, height: 30 }), async () => makeWebp(40, 30), 1, 0, 'png'],
    ['still to animated GIF', 'gif', async () => (await sharp())({
      create: { width: 40, height: 30, channels: 3, background: '#ffffff' },
    }).gif().toBuffer(), async () => makeAnimatedGif(40, 30, 3), 0, 1, 'webp'],
  ])('repairs %s replacement during generation without a scan', async (_label, extension, initial, replacement, before, after, format) => {
    set('images.preview.format', 'png');
    set('images.preview.webp_quality', 52);
    const name = `replaced.${extension}`;
    const { project, absPath, asset } = await source(name, await initial());
    expect(asset.source_animated).toBe(before);
    const filePath = path.join(absPath, name);
    const bytes = await replacement();
    fs.writeFileSync(filePath, bytes);
    fs.utimesSync(filePath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const updatedAt = asset.updated_at;
    let attempts = 0;
    const service = createPreviewService({ db: h.db, projectsRoot: h.projectsRoot,
      previewRoot: h.previewRoot, _hooks: { onStagingCreated: () => { attempts++; } } });
    const result = await service.getPreview(project.id, asset.id);
    const repaired = h.assetRepo.findById(asset.id);
    const fingerprint = projectImagePolicyFingerprint(
      createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy(), repaired);
    expect(attempts).toBe(2);
    expect(repaired).toMatchObject({ source_animated: after, size_bytes: bytes.length,
      modified_at: fs.statSync(filePath).mtime.toISOString(), updated_at: updatedAt });
    expect(h.assetRepo.reconcileSourceAnimation(asset,
      { size: asset.size_bytes, mtime: asset.modified_at }, before)).toBeUndefined();
    expect(h.assetRepo.findById(asset.id).source_animated).toBe(after);
    expect(result.revision).toBe(buildAssetRevisionToken(repaired, fingerprint));
    expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision)
      .toBe(result.revision);
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.policyFingerprint)
      .toBe(fingerprint);
    expect((await metadata(result)).format).toBe(format);
    const expected = await (await buildDerivativePipeline(bytes,
      { width: 1600, height: 1600, quality: 52, animated: after === 1, format })).toBuffer();
    expect(fs.readFileSync(result.path)).toEqual(expected);
    expect((await service.getPreview(project.id, asset.id)).cacheState).toBe('fresh');
    expect(attempts).toBe(2);
  });

  it.each([
    ['before the retry reads', 'onStagingCreated'],
    ['after the retry generates', 'beforePointerWrite'],
  ])('does not publish a second replacement %s', async (_window, hookName) => {
    set('images.preview.format', 'webp');
    const { project, absPath } = h.createProject(`Double replacement ${hookName}`);
    const filePath = writeProjectFile(absPath, 'double.webp', await makeWebp(40, 30));
    const initialStat = fs.statSync(filePath);
    const asset = h.indexAsset(project, 'double.webp', {
      modifiedAt: initialStat.mtime.toISOString(), sourceAnimated: 0,
    });
    await h.service.getPreview(project.id, asset.id);
    const prior = snapshotCache(h, project.id, asset.id);
    set('images.preview.format', 'png');

    fs.writeFileSync(filePath, await makeSolidAnimatedWebp(3, { width: 50, height: 30 }));
    fs.utimesSync(filePath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const replacement = fs.statSync(filePath);
    const newest = await makeWebp(80, 30);
    let attempts = 0;
    const replaceAgain = () => {
      fs.writeFileSync(filePath, newest);
      fs.utimesSync(filePath, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    };
    const service = createPreviewService({ db: h.db, projectsRoot: h.projectsRoot,
      previewRoot: h.previewRoot, _hooks: {
        onStagingCreated: () => {
          attempts++;
          if (hookName === 'onStagingCreated' && attempts === 2) replaceAgain();
        },
        beforePointerWrite: () => {
          if (hookName === 'beforePointerWrite') replaceAgain();
        },
      } });

    await expect(service.getPreview(project.id, asset.id)).rejects.toBeInstanceOf(PreviewGenerationError);
    expect(attempts).toBe(2);
    expect(h.assetRepo.findById(asset.id)).toMatchObject({
      source_animated: 1, size_bytes: replacement.size,
      modified_at: replacement.mtime.toISOString(),
    });
    const after = snapshotCache(h, project.id, asset.id);
    expect(after.pointer).toEqual(prior.pointer);
    expect(after.thumbnail).toEqual(prior.thumbnail);
    expect(after.preview).toEqual(prior.preview);
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
    expect(fs.readdirSync(assetCacheRoot(h, project.id, asset.id)).filter((name) => name.startsWith('r-')))
      .toHaveLength(1);
  });

  it.each([
    ['still', async () => makeWebp(40, 30), 0, 'png'],
    ['animated', async () => makeSolidAnimatedWebp(3, { width: 40, height: 30 }), 1, 'webp'],
  ])('reconciles malformed unknown WebP replaced by valid %s without a scan', async (_kind, makeValid, animated, format) => {
    set('images.preview.format', 'png');
    set('images.preview.webp_quality', 52);
    const { project, asset, filePath, imageSettings } = await legacySource('malformed-replaced.webp',
      Buffer.from('RIFF\x04\x00\x00\x00WEBP'));
    const updatedAt = asset.updated_at;
    const valid = await makeValid();
    fs.writeFileSync(filePath, valid);
    fs.utimesSync(filePath, new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
    let attempts = 0;
    const service = createPreviewService({ db: h.db, projectsRoot: h.projectsRoot,
      previewRoot: h.previewRoot, _hooks: { onStagingCreated: () => { attempts++; } } });
    const result = await service.getPreview(project.id, asset.id);
    const row = h.assetRepo.findById(asset.id);
    const fingerprint = projectImagePolicyFingerprint(imageSettings.getPolicy(), row);
    expect(attempts).toBe(2);
    expect(row).toMatchObject({ source_animated: animated, size_bytes: valid.length,
      modified_at: fs.statSync(filePath).mtime.toISOString(), updated_at: updatedAt });
    expect(result.revision).toBe(buildAssetPreviewModel(row, imageSettings.getPresentationPolicy()).revision);
    expect(result.revision).toBe(buildAssetRevisionToken(row, fingerprint));
    expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(result.revision);
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.policyFingerprint)
      .toBe(fingerprint);
    expect((await metadata(result)).format).toBe(format);
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);

    set('images.preview.webp_quality', 71);
    const next = await service.getPreview(project.id, asset.id);
    expect(next.cacheState).toBe(animated ? 'prior-policy' : 'fresh');
  });

  it.each([
    ['WebP', 'broken.webp', Buffer.from('RIFF\x04\x00\x00\x00WEBP'), 'webp'],
    ['empty VP8 WebP', 'empty.webp', (() => {
      const bytes = Buffer.alloc(30);
      bytes.write('RIFF', 0);
      bytes.writeUInt32LE(22, 4);
      bytes.write('WEBPVP8 ', 8);
      bytes.writeUInt32LE(10, 16);
      Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0]).copy(bytes, 20);
      return bytes;
    })(), 'webp'],
    ['GIF', 'broken.gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;'), 'gif'],
  ])('keeps malformed %s animation unknown', async (_label, name, bytes, extension) => {
    set('images.preview.format', 'png');
    const { project, asset, filePath, imageSettings } = await legacySource(name, bytes);
    expect(inspectSourceAnimation(filePath, extension)).toBeNull();
    buildAssetPreviewModel(asset, imageSettings.getPresentationPolicy());
    expect(h.assetRepo.findById(asset.id).source_animated).toBeNull();
    await expect(h.service.getPreview(project.id, asset.id)).rejects.toBeInstanceOf(PreviewGenerationError);
    expect(h.assetRepo.findById(asset.id).source_animated).toBeNull();
  });

  it('classifies a valid animated WebP with transparency', async () => {
    set('images.preview.format', 'png');
    const { project, asset, filePath, imageSettings } = await legacySource('alpha.webp',
      await makeAnimatedWebp(3));
    expect(inspectSourceAnimation(filePath, 'webp')).toBe(true);
    buildAssetPreviewModel(asset, imageSettings.getPresentationPolicy());
    expect(h.assetRepo.findById(asset.id).source_animated).toBe(1);
    expect((await metadata(await h.service.getPreview(project.id, asset.id))).pages).toBe(3);
  });

  it('writes actual PNG thumbnail and still preview filenames, bytes, and dimensions', async () => {
    set('images.thumbnail.format', 'png');
    set('images.thumbnail.max_dimension', 128);
    set('images.preview.format', 'png');
    set('images.preview.max_dimension', 640);
    const { project, asset } = await source('still.png', await makePng(1200, 900));
    const thumb = await h.service.getThumbnail(project.id, asset.id);
    const preview = await h.service.getPreview(project.id, asset.id);
    const meta = readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta;
    expect(thumb.cacheState).toBe('regenerated');
    expect(preview.cacheState).toBe('fresh');
    expect([path.basename(thumb.path), thumb.mimeType, (await metadata(thumb)).format])
      .toEqual(['thumbnail.png', 'image/png', 'png']);
    expect([path.basename(preview.path), preview.mimeType, (await metadata(preview)).format])
      .toEqual(['preview.png', 'image/png', 'png']);
    expect((await metadata(thumb)).width).toBe(128);
    expect((await metadata(preview)).width).toBe(640);
    expect(meta.thumbnail).toMatchObject({ format: 'png', filename: 'thumbnail.png' });
    expect(meta.preview).toMatchObject({ format: 'png', filename: 'preview.png' });
  });

  it('keeps animated PNG-selected preview as WebP and its thumbnail static', async () => {
    set('images.thumbnail.format', 'png');
    set('images.preview.format', 'png');
    set('images.preview.webp_quality', 52);
    set('images.preview.max_dimension', 320);
    const { project, asset } = await source('motion.gif', await makeAnimatedGif(640, 400, 3));
    const thumb = await h.service.getThumbnail(project.id, asset.id);
    const preview = await h.service.getPreview(project.id, asset.id);
    const thumbInfo = await metadata(thumb);
    const previewInfo = await metadata(preview);
    const meta = readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta;
    expect([thumbInfo.format, thumbInfo.pages ?? 1, path.basename(thumb.path)])
      .toEqual(['png', 1, 'thumbnail.png']);
    expect([previewInfo.format, previewInfo.pages, previewInfo.width, path.basename(preview.path)])
      .toEqual(['webp', 3, 320, 'preview.webp']);
    expect(meta.preview).toMatchObject({ format: 'webp', filename: 'preview.webp' });
    expect(preview.mimeType).toBe('image/webp');
  });

  it('keeps animated WebP source animated when PNG preview is selected', async () => {
    set('images.preview.format', 'png');
    set('images.preview.max_dimension', 320);
    const input = await makeSolidAnimatedWebp(3, { width: 640, height: 400 });
    const { project, asset } = await source('motion.webp', input);
    const result = await h.service.getPreview(project.id, asset.id);
    const info = await metadata(result);
    expect([path.basename(result.path), result.mimeType, info.format, info.pages, info.width])
      .toEqual(['preview.webp', 'image/webp', 'webp', 3, 320]);
  });

  it('uses fixed WebP 90 / 1600 fallback for Original despite hidden values', async () => {
    set('images.preview.format', 'original');
    set('images.preview.webp_quality', 11);
    set('images.preview.max_dimension', 320);
    const input = await makePng(2000, 1200);
    const { project, asset } = await source('original.png', input);
    const result = await h.service.getPreview(project.id, asset.id);
    expect([path.basename(result.path), result.mimeType, (await metadata(result)).width])
      .toEqual(['preview.webp', 'image/webp', 1600]);
    const expected = await (await buildDerivativePipeline(input,
      { width: 1600, height: 1600, quality: 90, animated: false })).toBuffer();
    expect(fs.readFileSync(result.path)).toEqual(expected);
    const revision = result.revision;
    set('images.preview.webp_quality', 95);
    set('images.preview.max_dimension', 2560);
    const same = await h.service.getPreview(project.id, asset.id);
    expect(same.cacheState).toBe('fresh');
    expect(same.revision).toBe(revision);
  });

  it('uses configured WebP quality and size for thumbnail and animated preview', async () => {
    set('images.thumbnail.webp_quality', 34);
    set('images.thumbnail.max_dimension', 128);
    set('images.preview.webp_quality', 63);
    set('images.preview.max_dimension', 320);
    const input = await makeAnimatedGif(640, 400, 3);
    const { project, asset } = await source('configured.gif', input);
    const thumb = await h.service.getThumbnail(project.id, asset.id);
    const preview = await h.service.getPreview(project.id, asset.id);
    const expectedThumb = await (await buildDerivativePipeline(input,
      { width: 128, height: 128, quality: 34, animated: false })).toBuffer();
    const expectedPreview = await (await buildDerivativePipeline(input,
      { width: 320, height: 320, quality: 63, animated: true })).toBuffer();
    expect(fs.readFileSync(thumb.path)).toEqual(expectedThumb);
    expect(fs.readFileSync(preview.path)).toEqual(expectedPreview);
    expect([path.basename(thumb.path), (await metadata(thumb)).pages ?? 1]).toEqual(['thumbnail.webp', 1]);
    expect([path.basename(preview.path), (await metadata(preview)).pages]).toEqual(['preview.webp', 3]);
  });

  it('ignores thumbnail WebP quality while PNG is selected', async () => {
    set('images.thumbnail.format', 'png');
    const { project, asset } = await source('quality.png', await makePng(500, 400));
    const first = await h.service.getThumbnail(project.id, asset.id);
    set('images.thumbnail.webp_quality', 10);
    const next = await h.service.getThumbnail(project.id, asset.id);
    expect(next.cacheState).toBe('fresh');
    expect(next.revision).toBe(first.revision);
  });

  it('uses Preview-PNG WebP quality only for animated sources across cache and rendered revisions', async () => {
    set('images.preview.format', 'png');
    const sh = await sharp();
    const still = await makePng(40, 30);
    const cases = [
      ['still.png', still, false],
      ['still.jpg', await sh(still).jpeg().toBuffer(), false],
      ['still.webp', await sh(still).webp().toBuffer(), false],
      ['motion.gif', await makeAnimatedGif(640, 400, 3), true],
      ['motion.webp', await makeSolidAnimatedWebp(3, { width: 640, height: 400 }), true],
    ];
    for (const [name, bytes, animated] of cases) {
      set('images.preview.webp_quality', 52);
      const { project, absPath, asset } = await source(name, bytes);
      expect(inspectSourceAnimation(path.join(absPath, name), name.split('.').pop()))
        .toBe(/\.(gif|webp)$/.test(name) ? animated : null);
      const firstPolicy = createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();
      const firstFingerprint = projectImagePolicyFingerprint(firstPolicy, asset);
      const firstRendered = buildAssetPreviewModel(asset, projectImagePresentationPolicy(firstPolicy));
      const first = await h.service.getThumbnail(project.id, asset.id);
      const pointer = readCurrentPointer(h.previewRoot, project.id, asset.id).pointer;
      expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.policyFingerprint)
        .toBe(firstFingerprint);
      set('images.preview.webp_quality', 71);
      const nextPolicy = createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();
      const nextFingerprint = projectImagePolicyFingerprint(nextPolicy, asset);
      const nextRendered = buildAssetPreviewModel(asset, projectImagePresentationPolicy(nextPolicy));
      const next = await h.service.getThumbnail(project.id, asset.id);
      expect(nextFingerprint === firstFingerprint).toBe(!animated);
      expect(nextRendered.revision === firstRendered.revision).toBe(!animated);
      expect(nextRendered.urls.thumbnail === firstRendered.urls.thumbnail).toBe(!animated);
      expect(nextRendered.urls.preview === firstRendered.urls.preview).toBe(!animated);
      expect(next.revision).toBe(first.revision);
      expect(next.cacheState).toBe(animated ? 'prior-policy' : 'fresh');
      if (animated) await h.service.ensureCurrentPreview(project.id, asset.id);
      expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.policyFingerprint)
        .toBe(nextFingerprint);
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.dir === pointer.dir)
        .toBe(!animated);
      if (animated) {
        const preview = await h.service.getPreview(project.id, asset.id);
        const expected = await (await buildDerivativePipeline(bytes,
          { width: 1600, height: 1600, quality: 71, animated: true })).toBuffer();
        expect(fs.readFileSync(preview.path)).toEqual(expected);
      }
    }
  });

  it('invalidates the pair and changes revision for effective format, quality, and size changes', async () => {
    const { project, asset } = await source('revisions.png', await makePng(1000, 700));
    let previous = await h.service.getThumbnail(project.id, asset.id);
    expect((await h.service.getThumbnail(project.id, asset.id)).cacheState).toBe('fresh');
    for (const [key, value] of [
      ['images.thumbnail.format', 'png'],
      ['images.thumbnail.max_dimension', 128],
      ['images.preview.format', 'png'],
      ['images.preview.max_dimension', 640],
      ['images.preview.format', 'webp'],
      ['images.preview.webp_quality', 71],
      ['images.thumbnail.format', 'webp'],
      ['images.thumbnail.webp_quality', 42],
    ]) {
      set(key, value);
      const prior = await h.service.getThumbnail(project.id, asset.id);
      expect(prior.cacheState).toBe('prior-policy');
      await h.service.ensureCurrentPreview(project.id, asset.id);
      const next = await h.service.getThumbnail(project.id, asset.id);
      expect(next.cacheState).toBe('fresh');
      expect(next.revision).not.toBe(previous.revision);
      previous = next;
    }
  });

  it('discards a staged generation when policy changes before publication', async () => {
    const { project, asset } = await source('race.png', await makePng(1000, 700));
    const gate = makeGate();
    let attempts = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => { attempts += 1; },
      beforePublishRecheck: () => attempts === 1 ? gate.promise : undefined,
    });
    const pending = service.getThumbnail(project.id, asset.id);
    while (attempts === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    set('images.thumbnail.format', 'png');
    gate.release();
    const result = await pending;
    expect(attempts).toBe(2);
    expect(path.basename(result.path)).toBe('thumbnail.png');
    expect((await metadata(result)).format).toBe('png');
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
  });

  it.each([
    ['PNG before promotion', 'race.png', 'beforePublishRecheck', makePng],
    ['JPEG before current.json', 'race.jpg', 'beforePointerWrite', makeJpeg],
  ])('discards and reconciles a replaced %s source after generation without a scan', async (_case, name, hookName, makeImage) => {
    const { project, absPath, asset } = await source(name, await makeImage(1000, 700));
    await h.service.getPreview(project.id, asset.id);
    const priorPointer = fs.readFileSync(pointerPath(h, project.id, asset.id));
    const priorDir = path.basename(publishedDir(h, project.id, asset.id));
    set('images.thumbnail.max_dimension', 128);

    const filePath = path.join(absPath, name);
    const replacementPath = path.join(absPath, `${name}.replacement`);
    fs.writeFileSync(replacementPath, await makeImage(120, 90));
    let attempts = 0;
    const replaceAfterGeneration = () => {
      if (attempts !== 1) return;
      expect(fs.readFileSync(pointerPath(h, project.id, asset.id))).toEqual(priorPointer);
      fs.rmSync(filePath);
      fs.renameSync(replacementPath, filePath);
    };
    const service = makeHookedService(h, {
      onStagingCreated: () => { attempts++; },
      [hookName]: replaceAfterGeneration,
    });

    // The output generated from the replaced source is never published; the
    // first attempt reconciles the row and the retry publishes the new source.
    const result = await service.ensureCurrentPreview(project.id, asset.id);
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ cacheState: 'regenerated', width: 120, height: 90 });
    const stat = fs.statSync(filePath);
    expect(h.assetRepo.findById(asset.id)).toMatchObject({ size_bytes: stat.size,
      modified_at: stat.mtime.toISOString() });
    const pointer = readCurrentPointer(h.previewRoot, project.id, asset.id).pointer;
    expect(pointer.revision).toBe(result.revision);
    expect(fs.readdirSync(assetCacheRoot(h, project.id, asset.id))
      .filter((entry) => entry.startsWith('r-')).sort()).toEqual([priorDir, pointer.dir].sort());
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
  });

  it('keeps the prior pointer when policy changes after staging is promoted', async () => {
    const { project, asset } = await source('pointer.png', await makePng(1000, 700));
    const original = await h.service.getThumbnail(project.id, asset.id);
    const originalPointer = fs.readFileSync(pointerPath(h, project.id, asset.id));
    set('images.thumbnail.max_dimension', 128);
    let attempts = 0;
    const service = makeHookedService(h, {
      beforePointerWrite: () => {
        attempts += 1;
        if (attempts === 1) {
          expect(fs.readFileSync(pointerPath(h, project.id, asset.id))).toEqual(originalPointer);
          set('images.thumbnail.max_dimension', 64);
        }
      },
    });
    await service.ensureCurrentPreview(project.id, asset.id);
    const result = await service.getThumbnail(project.id, asset.id);
    expect(attempts).toBe(2);
    expect(result.revision).not.toBe(original.revision);
    expect((await metadata(result)).width).toBe(64);
    expect(fs.readdirSync(assetCacheRoot(h, project.id, asset.id))
      .filter((name) => name.startsWith('tmp-'))).toEqual([]);
  });

  it('serves a validated prior pair without waiting for target generation', async () => {
    const { project, asset } = await source('fallback.png', await makePng(900, 700));
    const first = await h.service.getThumbnail(project.id, asset.id);
    set('images.thumbnail.format', 'png');
    const target = createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();
    const gate = makeGate();
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const worker = makeHookedService(h, { beforeThumbTransform: async () => {
      entered();
      await gate.promise;
    } });
    const pending = worker.ensureTargetGeneration(project.id, asset.id, target);
    await started;
    try {
      const prior = await Promise.race([
        h.service.getThumbnail(project.id, asset.id),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Fallback waited on rebuild lock.')), 1000)),
      ]);
      expect(prior).toMatchObject({ cacheState: 'prior-policy', revision: first.revision,
        path: first.path });
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(first.revision);
    } finally {
      gate.release();
    }
    const built = await pending;
    expect(built.cacheState).toBe('regenerated');
    expect((await h.service.getThumbnail(project.id, asset.id)).mimeType).toBe('image/png');
  });

  it('forces a fresh target pair through the normal atomic publication path', async () => {
    const { project, asset } = await source('force.png', await makePng(900, 700));
    await h.service.getThumbnail(project.id, asset.id);
    const prior = readCurrentPointer(h.previewRoot, project.id, asset.id).pointer;
    const target = createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();
    const result = await h.service.ensureTargetGeneration(project.id, asset.id, target,
      () => true, { force: true });
    const current = readCurrentPointer(h.previewRoot, project.id, asset.id).pointer;
    expect(result.cacheState).toBe('regenerated');
    expect(current.revision).toBe(prior.revision);
    expect(current.dir).not.toBe(prior.dir);
    expect(fs.existsSync(path.join(assetCacheRoot(h, project.id, asset.id), prior.dir))).toBe(true);
  });

  it.each([
    ['still to animated', false, true, 'webp'],
    ['animated to still', true, false, 'png'],
  ])('rejects a prior GIF pair after %s with the same size and mtime', async (_label, before, after, expectedFormat) => {
    set('images.preview.format', 'png');
    const animated = await makeAnimatedGif(40, 30, 3);
    const still = padStillGif(await (await sharp())({
      create: { width: 40, height: 30, channels: 3, background: '#ffffff' },
    }).gif().toBuffer(), animated.length);
    const name = 'same-revision.gif';
    const { project, absPath, asset } = await source(name, before ? animated : still);
    const first = await h.service.getPreview(project.id, asset.id);
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.animated).toBe(before);
    const oldPointer = readCurrentPointer(h.previewRoot, project.id, asset.id).pointer;
    const filePath = path.join(absPath, name);
    const oldStat = fs.statSync(filePath);
    fs.writeFileSync(filePath, after ? animated : still);
    fs.utimesSync(filePath, oldStat.atime, oldStat.mtime);
    const updated = h.indexAsset(project, name, { sourceAnimated: after });
    expect(updated.size_bytes).toBe(asset.size_bytes);
    expect(updated.modified_at).toBe(asset.modified_at);
    expect(inspectSourceAnimation(filePath, 'gif')).toBe(after);
    set('images.thumbnail.format', 'png');
    let generations = 0;
    const service = makeHookedService(h, { onStagingCreated: () => { generations++; } });
    const next = await service.getPreview(project.id, asset.id);
    expect(next.cacheState).toBe('regenerated');
    expect(next.revision).not.toBe(first.revision);
    expect(next.path).not.toBe(first.path);
    expect(generations).toBe(1);
    expect((await metadata(next)).format).toBe(expectedFormat);
    expect(next.animated).toBe(after);
    expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.dir).not.toBe(oldPointer.dir);
  });

  it('rejects a prior WebP pair after a same-size, same-mtime animation change', async () => {
    set('images.preview.format', 'png');
    const animated = await makeSolidAnimatedWebp(3, { width: 40, height: 30 });
    const still = padStillWebp(await makeWebp(40, 30), animated.length);
    const name = 'same-revision.webp';
    const { project, absPath, asset } = await source(name, still);
    const first = await h.service.getPreview(project.id, asset.id);
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.animated).toBe(false);
    const filePath = path.join(absPath, name);
    const oldStat = fs.statSync(filePath);
    fs.writeFileSync(filePath, animated);
    fs.utimesSync(filePath, oldStat.atime, oldStat.mtime);
    const updated = h.indexAsset(project, name, { sourceAnimated: true });
    expect(updated.size_bytes).toBe(asset.size_bytes);
    expect(updated.modified_at).toBe(asset.modified_at);
    expect(inspectSourceAnimation(filePath, 'webp')).toBe(true);
    set('images.thumbnail.format', 'png');
    const next = await h.service.getPreview(project.id, asset.id);
    expect(next.cacheState).toBe('regenerated');
    expect(next.revision).not.toBe(first.revision);
    expect((await metadata(next)).format).toBe('webp');
    expect(next.animated).toBe(true);
  });

  it.each([
    ['still GIF', 'gif', async () => (await sharp())({
      create: { width: 40, height: 30, channels: 3, background: '#ffffff' },
    }).gif().toBuffer(), false],
    ['animated WebP', 'webp', async () => makeSolidAnimatedWebp(3, { width: 40, height: 30 }), true],
  ])('keeps a valid prior pair for unchanged %s animation', async (_label, extension, makeBytes, animated) => {
    set('images.preview.format', 'png');
    const { project, asset } = await source(`unchanged.${extension}`, await makeBytes());
    const first = await h.service.getPreview(project.id, asset.id);
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.animated).toBe(animated);
    set('images.thumbnail.format', 'png');
    const preview = await h.service.getPreview(project.id, asset.id);
    const thumbnail = await h.service.getThumbnail(project.id, asset.id);
    expect(preview).toMatchObject({ cacheState: 'prior-policy', revision: first.revision, path: first.path });
    expect(thumbnail).toMatchObject({ cacheState: 'prior-policy', revision: first.revision });
  });

  it.each([
    ['gif', undefined], ['gif', 'false'], ['webp', undefined],
  ])('rejects a prior %s pair with animation metadata %s', async (extension, recordedAnimation) => {
    set('images.preview.format', 'png');
    const bytes = extension === 'gif'
      ? await (await sharp())({
        create: { width: 40, height: 30, channels: 3, background: '#ffffff' },
      }).gif().toBuffer()
      : await makeWebp(40, 30);
    const { project, asset } = await source(`missing.${extension}`, bytes);
    await h.service.getPreview(project.id, asset.id);
    const metaPath = publishedFile(h, project.id, asset.id, META_FILENAME);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (recordedAnimation === undefined) delete meta.animated;
    else meta.animated = recordedAnimation;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    set('images.thumbnail.format', 'png');
    const next = await h.service.getPreview(project.id, asset.id);
    expect(next.cacheState).toBe('regenerated');
    expect(readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta.animated).toBe(false);
  });

  it('rejects an obsolete target before pointer publication', async () => {
    const { project, asset } = await source('obsolete.png', await makePng(900, 700));
    const first = await h.service.getThumbnail(project.id, asset.id);
    set('images.thumbnail.format', 'png');
    const target = createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();
    let authoritative = true;
    const worker = makeHookedService(h, { beforePointerWrite: () => { authoritative = false; } });
    await expect(worker.ensureTargetGeneration(project.id, asset.id, target,
      () => authoritative)).rejects.toThrow('obsolete');
    expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(first.revision);
    expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
  });

  it('rejects a prior pair when source or cache authority changes', async () => {
    const { project, absPath, asset } = await source('invalid.png', await makePng(900, 700));
    await h.service.getThumbnail(project.id, asset.id);
    set('images.thumbnail.format', 'png');
    const previewPath = publishedFile(h, project.id, asset.id, PREVIEW_FILENAME);
    fs.appendFileSync(previewPath, Buffer.from('invalid'));
    expect((await h.service.getThumbnail(project.id, asset.id)).cacheState).toBe('regenerated');

    set('images.thumbnail.format', 'webp');
    const metaPath = publishedFile(h, project.id, asset.id, META_FILENAME);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.schemaVersion = 999;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    expect((await h.service.getThumbnail(project.id, asset.id)).cacheState).toBe('regenerated');

    set('images.thumbnail.format', 'png');
    fs.rmSync(path.join(absPath, 'invalid.png'));
    await expect(h.service.getThumbnail(project.id, asset.id)).rejects.toThrow();
  });

  it('regenerates after a scanned source replacement despite a policy change', async () => {
    const { project, absPath, asset } = await source('replaced.png', await makePng(900, 700));
    const first = await h.service.getThumbnail(project.id, asset.id);
    set('images.thumbnail.format', 'png');
    const replacement = await makePng(480, 300);
    const filePath = path.join(absPath, 'replaced.png');
    fs.writeFileSync(filePath, replacement);
    const pinned = new Date('2026-08-15T10:00:00Z');
    fs.utimesSync(filePath, pinned, pinned);
    h.assetRepo.upsert(project.id, 'replaced.png', {
      filename: 'replaced.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: replacement.length, modifiedAt: '2026-08-15 10:00:00',
    });
    const next = await h.service.getThumbnail(project.id, asset.id);
    expect(next.cacheState).toBe('regenerated');
    expect(next.revision).not.toBe(first.revision);
    expect(next.mimeType).toBe('image/png');
  });

  it('scopes rebuilds to effective output for raster, animation, and Krita', () => {
    const base = createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();
    const png = { ...base, thumbnail: { ...base.thumbnail, format: 'png' },
      preview: { ...base.preview, format: 'png' } };
    const hiddenQuality = { ...png, thumbnail: { ...png.thumbnail, webpQuality: 10 },
      preview: { ...png.preview, webpQuality: 10 } };
    expect(projectImageRebuildScope(png, hiddenQuality,
      { extension: 'png', source_animated: 0 }).needsRebuild).toBe(false);
    expect(projectImageRebuildScope(png, hiddenQuality,
      { extension: 'gif', source_animated: 1 })).toMatchObject({ thumbnail: false, preview: true });
    const original = { ...base, preview: { ...base.preview, format: 'original' } };
    const changedHidden = { ...original, preview: { ...original.preview,
      webpQuality: 10, maxDimension: 640 } };
    expect(projectImageRebuildScope(original, changedHidden,
      { extension: 'png', source_animated: 0 }).needsRebuild).toBe(false);
    expect(projectImageRebuildScope(original, changedHidden,
      { extension: 'kra', source_animated: null }).needsRebuild).toBe(false);
    const smallerGenerated = { ...base, preview: { ...base.preview, maxDimension: 640 } };
    expect(projectImageRebuildScope(smallerGenerated, original,
      { extension: 'kra', source_animated: null }).preview).toBe(true);
    expect(projectImageRebuildScope(original, png,
      { extension: 'png', source_animated: 0 }).preview).toBe(true);
    expect(projectImageRebuildScope(base, original,
      { extension: 'png', source_animated: 0 }).needsRebuild).toBe(false);
  });

  describe('selective derivative reuse', () => {
    const targetPolicy = () => createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();

    function tracked(hooks = {}) {
      const staged = [];
      const service = makeHookedService(h, { ...hooks,
        onDerivativeStaged: (kind, mode) => { staged.push(`${kind}:${mode}`); } });
      return { service, staged };
    }

    function rebuild(service, project, asset, options) {
      return service.ensureTargetGeneration(project.id, asset.id, targetPolicy(), () => true, options);
    }

    function publishedMeta(project, asset) {
      return readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta;
    }

    function publishedBytes(project, asset, kind) {
      return fs.readFileSync(publishedFile(h, project.id, asset.id, publishedMeta(project, asset)[kind].filename));
    }

    async function published(name, bytes, indexed = null) {
      const fixture = indexed ?? await source(name, bytes);
      await h.service.getThumbnail(fixture.project.id, fixture.asset.id);
      const { project, asset } = fixture;
      return { ...fixture, before: {
        meta: publishedMeta(project, asset),
        pointer: readCurrentPointer(h.previewRoot, project.id, asset.id).pointer,
        thumbnail: publishedBytes(project, asset, 'thumbnail'),
        preview: publishedBytes(project, asset, 'preview'),
      } };
    }

    // Asserts the published pair is complete, self-describing and targets the
    // current policy regardless of which derivative was copied.
    async function expectTargetPair(project, asset, sourceAnimated, result) {
      const policy = targetPolicy();
      const meta = publishedMeta(project, asset);
      const current = h.assetRepo.findById(asset.id);
      expect(meta.generationIdentities).toEqual(projectImageGenerationIdentities(policy, sourceAnimated));
      expect(meta.policyFingerprint).toBe(projectImagePolicyFingerprint(policy, current));
      expect(meta.source).toMatchObject({ relativePath: current.relative_path, size: current.size_bytes });
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(result.revision);
      expect(result.revision).toBe(buildAssetRevisionToken(current, meta.policyFingerprint));
      for (const kind of ['thumbnail', 'preview']) {
        const info = await (await sharp())(publishedBytes(project, asset, kind)).metadata();
        expect(info.format).toBe(meta[kind].format);
        expect(info.width).toBe(meta[kind].width);
      }
      expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
      expect((await h.service.getThumbnail(project.id, asset.id)).cacheState).toBe('fresh');
      expect((await h.service.getPreview(project.id, asset.id)).cacheState).toBe('fresh');
    }

    it('encodes only the preview when only preview policy changes', async () => {
      const { project, asset, before } = await published('preview-only.png', await makePng(900, 700));
      set('images.preview.webp_quality', 40);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(result.cacheState).toBe('regenerated');
      expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      expect(publishedBytes(project, asset, 'thumbnail')).toEqual(before.thumbnail);
      expect(publishedBytes(project, asset, 'preview')).not.toEqual(before.preview);
      const meta = publishedMeta(project, asset);
      expect(meta.generatedAt >= before.meta.generatedAt).toBe(true);
      expect(meta.policyFingerprint).not.toBe(before.meta.policyFingerprint);
      expect(meta.generationIdentities.thumbnail).toBe(before.meta.generationIdentities.thumbnail);
      expect(meta.generationIdentities.preview).not.toBe(before.meta.generationIdentities.preview);
      expect(result.revision).not.toBe(before.pointer.revision);
      await expectTargetPair(project, asset, false, result);
    });

    it('encodes only the thumbnail when only thumbnail policy changes', async () => {
      const { project, asset, before } = await published('thumb-only.png', await makePng(900, 700));
      set('images.thumbnail.max_dimension', 128);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:reused']);
      expect(publishedBytes(project, asset, 'preview')).toEqual(before.preview);
      expect(publishedMeta(project, asset).thumbnail.width).toBe(128);
      await expectTargetPair(project, asset, false, result);
    });

    it('encodes both derivatives when both policies change', async () => {
      const { project, asset } = await published('both.png', await makePng(900, 700));
      set('images.thumbnail.format', 'png');
      set('images.preview.max_dimension', 640);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      await expectTargetPair(project, asset, false, result);
    });

    it('does not re-encode a PNG thumbnail for hidden WebP quality', async () => {
      set('images.thumbnail.format', 'png');
      const { project, asset, before } = await published('hidden-thumb.png', await makePng(900, 700));
      set('images.thumbnail.webp_quality', 10);
      set('images.preview.webp_quality', 40);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      expect(publishedBytes(project, asset, 'thumbnail')).toEqual(before.thumbnail);
      expect(publishedMeta(project, asset).thumbnail.filename).toBe('thumbnail.png');
      await expectTargetPair(project, asset, false, result);
    });

    it('does not re-encode a still PNG preview for hidden WebP quality', async () => {
      set('images.preview.format', 'png');
      const { project, asset, before } = await published('hidden-preview.png', await makePng(900, 700));
      set('images.preview.webp_quality', 10);
      set('images.thumbnail.max_dimension', 128);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:reused']);
      expect(publishedBytes(project, asset, 'preview')).toEqual(before.preview);
      expect(publishedMeta(project, asset).preview.filename).toBe('preview.png');
      await expectTargetPair(project, asset, false, result);
    });

    it('re-encodes an animated PNG-selection preview when WebP quality changes', async () => {
      set('images.preview.format', 'png');
      const { project, asset, before } = await published('animated.gif', await makeAnimatedGif(60, 40, 3));
      expect(before.meta.preview.format).toBe('webp');
      set('images.preview.webp_quality', 30);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      const meta = publishedMeta(project, asset);
      expect(meta).toMatchObject({ animated: true, frameCount: 3 });
      expect(meta.preview.filename).toBe('preview.webp');
      await expectTargetPair(project, asset, true, result);
    });

    it('keeps animation metadata from the validated copy when an animated preview is reused', async () => {
      set('images.preview.format', 'png');
      const { project, asset, before } = await published('animated-thumb.gif', await makeAnimatedGif(60, 40, 3));
      set('images.thumbnail.max_dimension', 128);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:reused']);
      expect(publishedBytes(project, asset, 'preview')).toEqual(before.preview);
      expect(publishedMeta(project, asset)).toMatchObject({ animated: true, frameCount: 3 });
      await expectTargetPair(project, asset, true, result);
    });

    it('rejects reuse after a scanned source change even when a kind identity is unchanged', async () => {
      const { project, absPath, asset, before } = await published('changed.png', await makePng(900, 700));
      const replacement = await makePng(900, 700, { r: 5, g: 5, b: 5 });
      const filePath = path.join(absPath, 'changed.png');
      fs.writeFileSync(filePath, replacement);
      const pinned = new Date('2026-08-15T10:00:00Z');
      fs.utimesSync(filePath, pinned, pinned);
      h.assetRepo.upsert(project.id, 'changed.png', {
        filename: 'changed.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: replacement.length, modifiedAt: '2026-08-15 10:00:00', sourceAnimated: false,
      });
      set('images.preview.webp_quality', 40);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      expect(publishedMeta(project, asset).generationIdentities.thumbnail)
        .toBe(before.meta.generationIdentities.thumbnail);
      expect(publishedBytes(project, asset, 'thumbnail')).not.toEqual(before.thumbnail);
      await expectTargetPair(project, asset, false, result);
    });

    it.each([
      ['missing (legacy)', (meta) => { delete meta.generationIdentities; }],
      ['from another identity version', (meta) => { meta.generationIdentities.version = 2; }],
    ])('disables reuse when per-kind identities are %s', async (_label, mutate) => {
      const { project, asset } = await published('legacy.png', await makePng(900, 700));
      const metaPath = publishedFile(h, project.id, asset.id, META_FILENAME);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      mutate(meta);
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      set('images.preview.webp_quality', 40);
      const first = tracked();
      const result = await rebuild(first.service, project, asset);
      expect(first.staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      await expectTargetPair(project, asset, false, result);

      // The upgraded generation records identities, so later rebuilds reuse.
      set('images.preview.webp_quality', 50);
      const next = tracked();
      await rebuild(next.service, project, asset);
      expect(next.staged).toEqual(['thumbnail:reused', 'preview:encoded']);
    });

    // A malformed identity block is not partial proof: a valid, matching sibling
    // identity must not be trusted when the other kind's value only coerces to a
    // valid-looking hash.
    it.each([
      ['thumbnail', 'an array', (id) => [id], 'images.thumbnail.max_dimension', 128],
      ['thumbnail', 'a number', () => 1234567890123456, 'images.thumbnail.max_dimension', 128],
      ['preview', 'an array', (id) => [id], 'images.preview.webp_quality', 40],
    ])('disables reuse of both kinds when the %s identity is %s', async (kind, _label, malform, key, value) => {
      const { project, asset } = await published('malformed.png', await makePng(900, 700));
      const metaPath = publishedFile(h, project.id, asset.id, META_FILENAME);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.generationIdentities[kind] = malform(meta.generationIdentities[kind]);
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      // Only `kind` changes, so the sibling identity still matches the target.
      set(key, value);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      await expectTargetPair(project, asset, false, result);
    });

    it('rejects a corrupt published derivative and encodes it instead', async () => {
      const { project, asset } = await published('corrupt.png', await makePng(900, 700));
      fs.appendFileSync(publishedFile(h, project.id, asset.id, THUMBNAIL_FILENAME), Buffer.from('invalid'));
      set('images.preview.webp_quality', 40);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      await expectTargetPair(project, asset, false, result);
    });

    it('rejects reuse when a published derivative is missing', async () => {
      const { project, asset } = await published('missing.png', await makePng(900, 700));
      fs.rmSync(publishedFile(h, project.id, asset.id, THUMBNAIL_FILENAME));
      set('images.preview.webp_quality', 40);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      await expectTargetPair(project, asset, false, result);
    });

    it('falls back to encoding when copying a reusable derivative fails', async () => {
      const { project, asset } = await published('copy-fails.png', await makePng(900, 700));
      set('images.preview.webp_quality', 40);
      const reuseAttempts = [];
      const { service, staged } = tracked({ beforeDerivativeReuse: (kind) => {
        reuseAttempts.push(kind);
        throw new Error('injected copy failure');
      } });
      const result = await rebuild(service, project, asset);
      expect(reuseAttempts).toEqual(['thumbnail']);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      await expectTargetPair(project, asset, false, result);
    });

    it('keeps the fixed generated fallback identity for Preview Original rasters', async () => {
      const base = targetPolicy();
      const original = { ...base, preview: { ...base.preview, format: 'original' } };
      const hidden = { ...original, preview: { ...original.preview, webpQuality: 10, maxDimension: 640 } };
      const explicit = { ...base, preview: { format: 'webp', webpQuality: 90, maxDimension: 1600 } };
      expect(projectImageGenerationIdentities(hidden, false).preview)
        .toBe(projectImageGenerationIdentities(original, false).preview);
      expect(projectImageGenerationIdentities(explicit, false).preview)
        .toBe(projectImageGenerationIdentities(original, false).preview);
      expect(projectImageGenerationIdentities(original, true).preview)
        .not.toBe(projectImageGenerationIdentities(original, false).preview);

      set('images.preview.format', 'original');
      const { project, asset, before } = await published('original.png', await makePng(2000, 1000));
      expect(before.meta.preview).toMatchObject({ format: 'webp', width: 1600, height: 800 });
      expect(before.meta.generationIdentities.preview)
        .toBe(projectImageGenerationIdentities(original, false).preview);
      set('images.preview.webp_quality', 10);
      set('images.preview.max_dimension', 640);
      set('images.thumbnail.max_dimension', 128);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:reused']);
      expect(publishedBytes(project, asset, 'preview')).toEqual(before.preview);
      await expectTargetPair(project, asset, false, result);
    });

    it('conservatively encodes both derivatives for Krita sources', async () => {
      set('images.preview.format', 'original');
      const krita = h.createProject('Policy draw.kra');
      writeProjectFile(krita.absPath, 'draw.kra', makeKritaArchive({ merged: await makePng(900, 700) }));
      const { project, asset, before } = await published('draw.kra', null,
        { project: krita.project, absPath: krita.absPath, asset: h.indexAsset(krita.project, 'draw.kra') });
      expect(before.meta.generationIdentities.preview)
        .toBe(projectImageGenerationIdentities(targetPolicy(), false).preview);
      set('images.thumbnail.max_dimension', 128);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      expect(publishedMeta(project, asset).source.previewQuality).toBe('merged');
      await expectTargetPair(project, asset, false, result);
    });

    it('encodes both derivatives for a manual force rebuild with matching identities', async () => {
      const { project, asset, before } = await published('force.png', await makePng(900, 700));
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset, { force: true });
      expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
      expect(publishedMeta(project, asset).generationIdentities).toEqual(before.meta.generationIdentities);
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.dir).not.toBe(before.pointer.dir);
      await expectTargetPair(project, asset, false, result);
    });

    it('publishes copied derivatives that survive removal of the old generation', async () => {
      const { project, asset, before } = await published('independent.png', await makePng(900, 700));
      set('images.preview.webp_quality', 40);
      const { service, staged } = tracked();
      const result = await rebuild(service, project, asset);
      expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      const root = assetCacheRoot(h, project.id, asset.id);
      fs.renameSync(path.join(root, before.pointer.dir), path.join(root, 'removed-old-generation'));
      fs.rmSync(path.join(root, 'removed-old-generation'), { recursive: true, force: true });
      expect(publishedBytes(project, asset, 'thumbnail')).toEqual(before.thumbnail);
      await expectTargetPair(project, asset, false, result);
    });

    it('keeps the old pair authoritative when a mixed pair fails to publish', async () => {
      const { project, asset, before } = await published('publish-fails.png', await makePng(900, 700));
      const snapshot = snapshotCache(h, project.id, asset.id);
      set('images.preview.webp_quality', 40);
      const { service, staged } = tracked({ beforePointerWrite: () => {
        throw new Error('injected publication failure');
      } });
      await expect(rebuild(service, project, asset)).rejects.toThrow('injected publication failure');
      expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      const after = snapshotCache(h, project.id, asset.id);
      expect(after.pointer.equals(snapshot.pointer)).toBe(true);
      expect(after.thumbnail.equals(snapshot.thumbnail)).toBe(true);
      expect(after.preview.equals(snapshot.preview)).toBe(true);
      expect(after.meta.equals(snapshot.meta)).toBe(true);
      expect(fs.readdirSync(assetCacheRoot(h, project.id, asset.id))
        .filter((name) => name.startsWith('r-') || name.startsWith('tmp-'))).toEqual([before.pointer.dir]);
      expect((await h.service.getThumbnail(project.id, asset.id))).toMatchObject({
        cacheState: 'prior-policy', revision: before.pointer.revision });
    });
  });

  describe('shared processing admission', () => {
    const targetPolicy = () => createProjectImageSettingsService({ appMetaRepository: settings() }).getPolicy();

    // Wraps a real shared pool so tests can observe admissions and occupy
    // its slots directly; the preview service only ever sees `service`.
    function admissionPool(concurrency = 1) {
      const pool = createProcessingConcurrencyService({ concurrency });
      const stats = { requested: 0, admitted: 0, active: 0, maxActive: 0, released: 0 };
      let requested = null;
      const service = Object.freeze({
        concurrency,
        mapBounded: pool.mapBounded,
        run(task) {
          stats.requested += 1;
          requested?.();
          return pool.run(async () => {
            stats.admitted += 1;
            stats.active += 1;
            stats.maxActive = Math.max(stats.maxActive, stats.active);
            try {
              return await task();
            } finally {
              stats.active -= 1;
              stats.released += 1;
            }
          });
        },
      });
      return {
        pool, service, stats,
        nextRequest: () => new Promise((resolve) => { requested = resolve; }),
        occupy() {
          const gate = makeGate();
          const held = pool.run(() => gate.promise);
          return { release: () => { gate.release(); return held; } };
        },
      };
    }

    function admittedService(pool, hooks = {}) {
      return createPreviewService({
        db: h.db, projectsRoot: h.projectsRoot, previewRoot: h.previewRoot,
        processingConcurrencyService: pool.service, _hooks: hooks,
      });
    }

    async function drainTurns() {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    }

    it('reads a fresh cached derivative without a processing permit', async () => {
      const { project, asset } = await source('fresh.png', await makePng(900, 700));
      await h.service.getPreview(project.id, asset.id);
      const pool = admissionPool(1);
      const service = admittedService(pool);
      expect((await service.getPreview(project.id, asset.id)).cacheState).toBe('fresh');
      expect((await service.getThumbnail(project.id, asset.id)).cacheState).toBe('fresh');
      expect((await service.ensureCurrentPreview(project.id, asset.id)).cacheState).toBe('fresh');
      expect((await service.ensureTargetGeneration(project.id, asset.id, targetPolicy())).status).toBe('ready');
      expect(pool.stats.requested).toBe(0);
    });

    it('serves a prior-policy fallback without a processing permit, even when the pool is full', async () => {
      const { project, asset } = await source('fallback.png', await makePng(900, 700));
      const first = await h.service.getThumbnail(project.id, asset.id);
      set('images.thumbnail.format', 'png');
      const pool = admissionPool(1);
      const busy = pool.occupy();
      try {
        const service = admittedService(pool);
        expect(await service.getThumbnail(project.id, asset.id))
          .toMatchObject({ cacheState: 'prior-policy', revision: first.revision });
        expect(await service.getPreview(project.id, asset.id))
          .toMatchObject({ cacheState: 'prior-policy', revision: first.revision });
        expect(pool.stats.requested).toBe(0);
      } finally {
        await busy.release();
      }
    });

    it('waits for a shared permit before cold generation and releases it afterward', async () => {
      const { project, asset } = await source('cold.png', await makePng(900, 700));
      const pool = admissionPool(1);
      let staged = 0;
      const service = admittedService(pool, { onStagingCreated: () => { staged += 1; } });
      const busy = pool.occupy();
      const requested = pool.nextRequest();
      const pending = service.getPreview(project.id, asset.id);
      await requested;
      await drainTurns();
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 0 });
      expect(staged).toBe(0);
      expect(fs.existsSync(pointerPath(h, project.id, asset.id))).toBe(false);
      await busy.release();
      expect((await pending).cacheState).toBe('regenerated');
      expect(staged).toBe(1);
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, active: 0, maxActive: 1, released: 1 });
      expect(_lockCountForTests()).toBe(0);
    });

    it('admits policy-stale current-preview generation exactly once', async () => {
      const { project, asset } = await source('stale.png', await makePng(900, 700));
      await h.service.getPreview(project.id, asset.id);
      set('images.preview.webp_quality', 40);
      const pool = admissionPool(1);
      const result = await admittedService(pool).ensureCurrentPreview(project.id, asset.id);
      expect(result.cacheState).toBe('regenerated');
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, released: 1 });
    });

    it('holds one permit for a selectively reused pair', async () => {
      const { project, asset } = await source('reuse.png', await makePng(900, 700));
      await h.service.getThumbnail(project.id, asset.id);
      set('images.preview.webp_quality', 40);
      const pool = admissionPool(1);
      const staged = [];
      const activeDuringStage = [];
      const service = admittedService(pool, { onDerivativeStaged: (kind, mode) => {
        staged.push(`${kind}:${mode}`);
        activeDuringStage.push(pool.stats.active);
      } });
      const result = await service.ensureTargetGeneration(project.id, asset.id, targetPolicy());
      expect(result.cacheState).toBe('regenerated');
      expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      expect(activeDuringStage).toEqual([1, 1]);
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, released: 1 });
    });

    it('keeps one permit across the bounded second attempt', async () => {
      const { project, asset } = await source('retry.png', await makePng(1000, 700));
      await h.service.getThumbnail(project.id, asset.id);
      set('images.thumbnail.max_dimension', 128);
      const pool = admissionPool(1);
      let attempts = 0;
      const service = admittedService(pool, { beforePointerWrite: () => {
        attempts += 1;
        expect(pool.stats.active).toBe(1);
        if (attempts === 1) set('images.thumbnail.max_dimension', 64);
      } });
      await service.ensureCurrentPreview(project.id, asset.id);
      expect(attempts).toBe(2);
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, released: 1 });
    });

    it('rechecks target authority after a queued permit is granted', async () => {
      const { project, asset } = await source('queued.png', await makePng(900, 700));
      const first = await h.service.getThumbnail(project.id, asset.id);
      set('images.thumbnail.format', 'png');
      const pool = admissionPool(1);
      let staged = 0;
      let authoritative = true;
      const service = admittedService(pool, { onStagingCreated: () => { staged += 1; } });
      const busy = pool.occupy();
      const requested = pool.nextRequest();
      const pending = service.ensureTargetGeneration(project.id, asset.id, targetPolicy(),
        () => authoritative);
      await requested;
      authoritative = false;
      await busy.release();
      await expect(pending).rejects.toThrow('obsolete');
      expect(staged).toBe(0);
      expect(pool.stats).toMatchObject({ admitted: 1, active: 0, released: 1 });
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(first.revision);
      expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
    });

    // Queues a request behind an occupied single slot, applies `whileQueued`,
    // then frees the slot and returns the request's outcome.
    async function queuedBehindBusyPool(pool, start, whileQueued) {
      const admittedBefore = pool.stats.admitted;
      const busy = pool.occupy();
      const requested = pool.nextRequest();
      const pending = start();
      await requested;
      await drainTurns();
      expect(pool.stats.admitted).toBe(admittedBefore);
      whileQueued();
      await busy.release();
      return pending;
    }

    function recordingService(pool) {
      const events = [];
      const service = admittedService(pool, {
        onStagingCreated: () => events.push('staging'),
        beforeThumbTransform: () => events.push('thumbnail:encode'),
        beforePreviewTransform: () => events.push('preview:encode'),
        onDerivativeStaged: (kind, mode) => events.push(`${kind}:${mode}`),
      });
      return { service, events };
    }

    it('returns the current pair when policy returns to it while queued for admission', async () => {
      const { project, asset } = await source('aba.png', await makePng(900, 700));
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => set('images.preview.webp_quality', 71));
      expect(result).toMatchObject({ cacheState: 'fresh', revision: first.revision, path: first.path });
      expect(events).toEqual([]);
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(first.revision);
      expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, active: 0, released: 1 });
      expect(_lockCountForTests()).toBe(0);
    });

    it('still generates against the refreshed policy when the pair stays stale while queued', async () => {
      const { project, asset } = await source('abc.png', await makePng(900, 700));
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => set('images.preview.webp_quality', 33));
      expect(result.cacheState).toBe('regenerated');
      expect(result.revision).not.toBe(first.revision);
      expect(events).toEqual(['staging', 'thumbnail:reused', 'preview:encode', 'preview:encoded']);
      expect((await h.service.getPreview(project.id, asset.id)))
        .toMatchObject({ cacheState: 'fresh', revision: result.revision });
      expect(pool.stats).toMatchObject({ admitted: 1, active: 0, released: 1 });
    });

    it('returns an explicit target pair that became fresh while queued, unless forced', async () => {
      const { project, asset } = await source('target-fresh.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      const row = h.db.prepare('SELECT modified_at FROM assets WHERE id = ?').get(asset.id);
      const setMtime = (value) => h.db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?')
        .run(value, asset.id);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      // The database source identity moves, so the pair is stale before admission,
      // then moves back while the request waits for a permit.
      setMtime('2001-01-01T00:00:00.000Z');
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureTargetGeneration(project.id, asset.id, targetPolicy()),
        () => setMtime(row.modified_at));
      expect(result).toMatchObject({ status: 'ready', revision: first.revision,
        thumbnail: { cacheState: 'fresh' }, preview: { cacheState: 'fresh', path: first.path } });
      expect(events).toEqual([]);
      expect(pool.stats).toMatchObject({ admitted: 1, active: 0, released: 1 });

      setMtime('2001-01-01T00:00:00.000Z');
      const forced = await queuedBehindBusyPool(pool,
        () => service.ensureTargetGeneration(project.id, asset.id, targetPolicy(), () => true,
          { force: true }),
        () => setMtime(row.modified_at));
      expect(forced.cacheState).toBe('regenerated');
      expect(events).toEqual(['staging', 'thumbnail:encode', 'thumbnail:encoded',
        'preview:encode', 'preview:encoded']);
      expect(pool.stats).toMatchObject({ admitted: 2, active: 0, released: 2 });
      expect(_lockCountForTests()).toBe(0);
    });

    // Uncompressed PNGs of equal dimensions have equal byte sizes, so a
    // replacement can keep the stored size/mtime tuple while changing pixels.
    async function storedPng(width, height, background) {
      return (await sharp())({ create: { width, height, channels: 3, background } })
        .png({ compressionLevel: 0 }).toBuffer();
    }

    // Replace the source with a new file (new descriptor identity) while
    // restoring the original mtime, without rescanning the database row.
    function replaceKeepingTuple(absPath, name, bytes) {
      const target = path.join(absPath, name);
      const before = fs.statSync(target);
      expect(bytes.length).toBe(before.size);
      const replacement = `${target}.replacement`;
      fs.writeFileSync(replacement, bytes);
      fs.renameSync(replacement, target);
      fs.utimesSync(target, before.atime, before.mtime);
      expect(fs.statSync(target).mtime.toISOString()).toBe(before.mtime.toISOString());
    }

    async function previewPixel(result) {
      const { data } = await (await sharp())(fs.readFileSync(result.path)).raw()
        .toBuffer({ resolveWithObject: true });
      return [data[0], data[1], data[2]];
    }

    function sourceRow(assetId) {
      return h.db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    }

    function currentRevisionToken(assetId) {
      return buildAssetRevisionToken(h.assetRepo.findById(assetId),
        projectImagePolicyFingerprint(targetPolicy()));
    }

    it('reconciles and regenerates a PNG source replaced on disk while queued, without a scan', async () => {
      const { project, absPath, asset } = await source('changed.png', await makePng(200, 200));
      const replacement = await makePng(400, 400, { r: 200, g: 30, b: 30 });
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      expect(first.width).toBe(200);
      const before = sourceRow(asset.id);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => {
          // No scan: the DB row still describes the 200px source.
          writeProjectFile(absPath, 'changed.png', replacement);
          set('images.preview.webp_quality', 71);
        });
      // The stale 200px pair is not returned; the first attempt reconciles the
      // row to the file on disk and the bounded retry regenerates from it
      // without copying any derivative of the replaced source.
      expect(result).toMatchObject({ cacheState: 'regenerated', width: 400, height: 400 });
      expect(result.revision).not.toBe(first.revision);
      expect(events).toEqual(['staging', 'staging', 'thumbnail:encode', 'thumbnail:encoded',
        'preview:encode', 'preview:encoded']);
      const [r, , b] = await previewPixel(result);
      expect(r).toBeGreaterThan(150);
      expect(b).toBeLessThan(80);
      // Only the source tuple moved, advancing the source generation once;
      // every other column is untouched.
      const stat = fs.statSync(path.join(absPath, 'changed.png'));
      expect(sourceRow(asset.id)).toEqual({ ...before, size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(), source_generation: before.source_generation + 1 });
      expect(result.revision).toBe(currentRevisionToken(asset.id));
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(result.revision);
      expect(await h.service.getPreview(project.id, asset.id))
        .toMatchObject({ cacheState: 'fresh', revision: result.revision, width: 400 });
      expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, active: 0, released: 1 });
      expect(_lockCountForTests()).toBe(0);
    });

    it('reconciles a JPEG source replaced on disk while queued through the same path', async () => {
      const { project, absPath, asset } = await source('changed.jpg', await makeJpeg(200, 200));
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      const before = sourceRow(asset.id);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      const replacement = await makeJpeg(400, 300);
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => {
          writeProjectFile(absPath, 'changed.jpg', replacement);
          set('images.preview.webp_quality', 71);
        });
      expect(result).toMatchObject({ cacheState: 'regenerated', width: 400, height: 300 });
      expect(result.revision).not.toBe(first.revision);
      expect(events.filter((event) => event === 'staging')).toHaveLength(2);
      expect(events).not.toContain('thumbnail:reused');
      const stat = fs.statSync(path.join(absPath, 'changed.jpg'));
      // No animation classification is added or changed for JPEG.
      expect(sourceRow(asset.id)).toEqual({ ...before, size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(), source_generation: before.source_generation + 1 });
      expect(result.revision).toBe(currentRevisionToken(asset.id));
    });

    it('keeps a row a scan reconciled first and retries under it', async () => {
      const { project, absPath, asset } = await source('scanned.png', await makePng(200, 200));
      set('images.preview.webp_quality', 71);
      await h.service.getPreview(project.id, asset.id);
      set('images.preview.webp_quality', 52);
      const replacement = await makePng(400, 400);
      const pool = admissionPool(1);
      let staged = 0;
      const service = admittedService(pool, { onStagingCreated: () => {
        staged += 1;
        if (staged !== 1) return;
        // The first attempt already loaded the 200px row; a scan then records
        // the replacement before the request reconciles. Count any later
        // source-tuple write to prove the request never overwrites it.
        writeProjectFile(absPath, 'scanned.png', replacement);
        h.indexAsset(project, 'scanned.png');
        h.db.exec(`CREATE TEMP TABLE source_writes (id INTEGER);
          CREATE TEMP TRIGGER count_source_writes AFTER UPDATE OF size_bytes, modified_at ON assets
          BEGIN INSERT INTO source_writes VALUES (NEW.id); END;`);
      } });
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => set('images.preview.webp_quality', 33));
      // The conditional write lost to the scan; the retry used the scan's row.
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM source_writes').get().n).toBe(0);
      expect(staged).toBe(2);
      expect(result).toMatchObject({ cacheState: 'regenerated', width: 400,
        revision: currentRevisionToken(asset.id) });
      h.db.exec('DROP TRIGGER count_source_writes; DROP TABLE source_writes;');
    });

    it('fails safely when the source is replaced again during the bounded retry', async () => {
      const { project, absPath, asset } = await source('unstable.png', await makePng(200, 200));
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const second = await makePng(300, 300, { r: 200, g: 30, b: 30 });
      const third = await makePng(500, 500, { r: 10, g: 200, b: 10 });
      let rechecks = 0;
      const service = admittedService(pool, { beforePublishRecheck: () => {
        rechecks += 1;
        writeProjectFile(absPath, 'unstable.png', third);
      } });
      const pending = queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => {
          writeProjectFile(absPath, 'unstable.png', second);
          set('images.preview.webp_quality', 71);
        });
      await expect(pending).rejects.toThrow('Source changed during generation');
      // Attempt one reconciled to the second source; only the retry reached
      // publication, found the third, and was not reconciled again.
      expect(rechecks).toBe(1);
      expect(sourceRow(asset.id).size_bytes).toBe(second.length);
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(first.revision);
      expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, active: 0, released: 1 });
      expect(_lockCountForTests()).toBe(0);
    });

    it('reconciles and regenerates a WebP source replaced on disk while queued', async () => {
      const { project, absPath, asset } = await source('changed.webp', await makeWebp(200, 200));
      const replacement = await makeWebp(400, 400);
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      expect(first.width).toBe(200);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => {
          writeProjectFile(absPath, 'changed.webp', replacement);
          set('images.preview.webp_quality', 71);
        });
      expect(result).toMatchObject({ cacheState: 'regenerated', width: 400, height: 400 });
      expect(result.revision).not.toBe(first.revision);
      // The first attempt reconciled the source tuple; the retry regenerated
      // both derivatives without reusing bytes from the replaced source.
      expect(events).toEqual(['staging', 'staging', 'thumbnail:encode', 'thumbnail:encoded',
        'preview:encode', 'preview:encoded']);
      const row = h.db.prepare('SELECT size_bytes, modified_at FROM assets WHERE id = ?').get(asset.id);
      const stat = fs.statSync(path.join(absPath, 'changed.webp'));
      expect(row).toEqual({ size_bytes: stat.size, modified_at: stat.mtime.toISOString() });
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(result.revision);
      expect(await h.service.getPreview(project.id, asset.id))
        .toMatchObject({ cacheState: 'fresh', revision: result.revision, width: 400 });
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, active: 0, released: 1 });
      expect(_lockCountForTests()).toBe(0);
    });

    it('publishes a same-size, same-mtime replacement made while queued under a new source generation', async () => {
      const { project, absPath, asset } = await source('tuple.png', await storedPng(300, 200, '#2050c0'));
      const replacement = await storedPng(300, 200, '#c02020');
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      const firstThumbnail = await h.service.getThumbnail(project.id, asset.id);
      const before = sourceRow(asset.id);
      const firstUrls = buildAssetPreviewModel(before, projectImagePolicyFingerprint(targetPolicy())).urls;
      expect(firstUrls.preview).toContain(`v=${first.revision}`);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => {
          replaceKeepingTuple(absPath, 'tuple.png', replacement);
          set('images.preview.webp_quality', 71);
        });
      // The fresh return is rejected and the proven replacement advances the
      // source generation (tuple unchanged) before the bounded retry encodes
      // it; nothing is copied from the old generation.
      const after = sourceRow(asset.id);
      expect(after).toEqual({ ...before, source_generation: before.source_generation + 1 });
      expect(result).toMatchObject({ cacheState: 'regenerated' });
      expect(result.revision).not.toBe(first.revision);
      expect(result.revision).toBe(currentRevisionToken(asset.id));
      expect(events).toEqual(['staging', 'thumbnail:encode', 'thumbnail:encoded',
        'preview:encode', 'preview:encoded']);
      const [r, , b] = await previewPixel(result);
      expect(r).toBeGreaterThan(150);
      expect(b).toBeLessThan(80);
      // current.json names the new revision and its own new directory.
      const pointer = readCurrentPointer(h.previewRoot, project.id, asset.id).pointer;
      expect(pointer.revision).toBe(result.revision);
      expect(pointer.dir.startsWith(`r-${result.revision}-`)).toBe(true);
      expect(path.dirname(result.path)).toBe(path.join(assetCacheRoot(h, project.id, asset.id), pointer.dir));
      // The user-visible immutable URLs change for both Preview and Thumbnail.
      const urls = buildAssetPreviewModel(after, projectImagePolicyFingerprint(targetPolicy())).urls;
      expect(urls.preview).toContain(`v=${result.revision}`);
      expect(urls.thumbnail).toContain(`v=${result.revision}`);
      expect(urls.preview).not.toBe(firstUrls.preview);
      expect(urls.thumbnail).not.toBe(firstUrls.thumbnail);
      const thumbnail = await h.service.getThumbnail(project.id, asset.id);
      expect(thumbnail).toMatchObject({ cacheState: 'fresh', revision: result.revision });
      expect(thumbnail.revision).not.toBe(firstThumbnail.revision);
      expect(pool.stats).toMatchObject({ requested: 1, admitted: 1, active: 0, released: 1 });
    });

    it('never serves a prior-policy pair or reuses derivatives across a source generation', async () => {
      const { project, asset } = await source('generation-fallback.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      // Legacy metadata without a recorded generation reads as generation 0
      // and stays current while the row is still at generation 0.
      const metaPath = path.join(publishedDir(h, project.id, asset.id), 'meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.source.generation).toBe(0);
      delete meta.source.generation;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      expect(await h.service.getPreview(project.id, asset.id))
        .toMatchObject({ cacheState: 'fresh', revision: first.revision });
      // Only the policy changes: the prior pair is served as prior-policy.
      set('images.preview.webp_quality', 52);
      expect(await h.service.getPreview(project.id, asset.id))
        .toMatchObject({ cacheState: 'prior-policy', revision: first.revision });
      // Once the row is at a later generation the same mismatch is a source
      // difference: no prior-policy fallback and no copied derivative.
      h.db.prepare('UPDATE assets SET source_generation = 1 WHERE id = ?').run(asset.id);
      const { service, events } = recordingService(admissionPool(1));
      const result = await service.getPreview(project.id, asset.id);
      expect(result.cacheState).toBe('regenerated');
      expect(result.revision).toBe(currentRevisionToken(asset.id));
      expect(result.revision).not.toBe(first.revision);
      expect(events).toEqual(['staging', 'thumbnail:encode', 'thumbnail:encoded',
        'preview:encode', 'preview:encoded']);
      expect(JSON.parse(fs.readFileSync(path.join(path.dirname(result.path), 'meta.json'), 'utf8'))
        .source.generation).toBe(1);
    });

    it('advances the source generation for a same-tuple replacement found at publication', async () => {
      const { project, absPath, asset } = await source('publish-tuple.png', await storedPng(300, 200, '#2050c0'));
      const first = await h.service.getPreview(project.id, asset.id);
      set('images.preview.webp_quality', 52);
      const replacement = await storedPng(300, 200, '#c02020');
      let rechecks = 0;
      const service = admittedService(admissionPool(1), { beforePublishRecheck: () => {
        rechecks += 1;
        if (rechecks === 1) replaceKeepingTuple(absPath, 'publish-tuple.png', replacement);
      } });
      const result = await service.ensureCurrentPreview(project.id, asset.id);
      // The first attempt's output is discarded; the retry publishes the
      // replacement under the advanced generation, never the prior revision.
      expect(rechecks).toBe(2);
      expect(sourceRow(asset.id).source_generation).toBe(1);
      expect(result.revision).toBe(currentRevisionToken(asset.id));
      expect(result.revision).not.toBe(buildAssetRevisionToken({ ...sourceRow(asset.id), source_generation: 0 },
        projectImagePolicyFingerprint(targetPolicy())));
      expect(first.revision).not.toBe(result.revision);
      const [r, , b] = await previewPixel(result);
      expect(r).toBeGreaterThan(150);
      expect(b).toBeLessThan(80);
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(result.revision);
    });

    it('does not count a queued replacement a scan already recorded a second time', async () => {
      const { project, absPath, asset } = await source('scan-first.png', await storedPng(300, 200, '#2050c0'));
      const replacement = await storedPng(300, 200, '#c02020');
      set('images.preview.webp_quality', 71);
      await h.service.getPreview(project.id, asset.id);
      const before = sourceRow(asset.id);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(1);
      const { service } = recordingService(pool);
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => {
          replaceKeepingTuple(absPath, 'scan-first.png', replacement);
          // A writer that won first (standing in for a scan observing a new
          // source instance) already advanced the generation.
          h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?')
            .run(asset.id);
          set('images.preview.webp_quality', 71);
        });
      // The request reloads the winner's row and generates under it.
      expect(sourceRow(asset.id).source_generation).toBe(before.source_generation + 1);
      expect(result).toMatchObject({ cacheState: 'regenerated', revision: currentRevisionToken(asset.id) });
      const [r] = await previewPixel(result);
      expect(r).toBeGreaterThan(150);
    });

    it('fails safely when a same-tuple replacement repeats during the bounded retry', async () => {
      const { project, absPath, asset } = await source('twice-tuple.png', await storedPng(300, 200, '#2050c0'));
      set('images.preview.webp_quality', 71);
      const first = await h.service.getPreview(project.id, asset.id);
      const before = sourceRow(asset.id);
      set('images.preview.webp_quality', 52);
      const second = await storedPng(300, 200, '#c02020');
      const third = await storedPng(300, 200, '#20c020');
      const pool = admissionPool(1);
      const service = admittedService(pool, { beforePublishRecheck: () => {
        replaceKeepingTuple(absPath, 'twice-tuple.png', third);
      } });
      await expect(queuedBehindBusyPool(pool,
        () => service.ensureCurrentPreview(project.id, asset.id),
        () => {
          replaceKeepingTuple(absPath, 'twice-tuple.png', second);
          set('images.preview.webp_quality', 71);
        })).rejects.toThrow('Source changed during generation');
      // B was established once; C seen at the final attempt's publication is
      // neither published nor counted, and the old pointer stays in place.
      expect(sourceRow(asset.id).source_generation).toBe(before.source_generation + 1);
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(first.revision);
      expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
      expect(_lockCountForTests()).toBe(0);
    });

    it('does not return an explicit target pair ready when its source changed while queued', async () => {
      const { project, absPath, asset } = await source('target-changed.png',
        await storedPng(300, 200, '#2050c0'));
      const replacement = await storedPng(300, 200, '#c02020');
      const first = await h.service.getPreview(project.id, asset.id);
      const row = h.db.prepare('SELECT modified_at FROM assets WHERE id = ?').get(asset.id);
      const setMtime = (value) => h.db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?')
        .run(value, asset.id);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      setMtime('2001-01-01T00:00:00.000Z');
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureTargetGeneration(project.id, asset.id, targetPolicy()),
        () => {
          setMtime(row.modified_at);
          replaceKeepingTuple(absPath, 'target-changed.png', replacement);
        });
      // The unchanged Settings target stays authoritative; only the source
      // generation advanced, so the same target policy yields a new revision.
      expect(sourceRow(asset.id).source_generation).toBe(1);
      expect(result).toMatchObject({ status: 'ready', cacheState: 'regenerated',
        revision: currentRevisionToken(asset.id) });
      expect(result.revision).not.toBe(first.revision);
      expect(result.preview.revision).toBe(result.revision);
      expect(result.thumbnail.revision).toBe(result.revision);
      expect(readCurrentPointer(h.previewRoot, project.id, asset.id).pointer.revision).toBe(result.revision);
      expect(events).toEqual(['staging', 'thumbnail:encode', 'thumbnail:encoded',
        'preview:encode', 'preview:encoded']);
      const [r, , b] = await previewPixel(result.preview);
      expect(r).toBeGreaterThan(150);
      expect(b).toBeLessThan(80);
      expect(pool.stats).toMatchObject({ admitted: 1, active: 0, released: 1 });
      expect(_lockCountForTests()).toBe(0);
    });

    it('reconciles an explicit target whose PNG source was replaced while queued', async () => {
      const { project, absPath, asset } = await source('target-replaced.png', await makePng(200, 200));
      await h.service.getPreview(project.id, asset.id);
      // Only the preview setting changes, so the thumbnail identity alone
      // would still match the old pair.
      set('images.preview.webp_quality', 40);
      const pool = admissionPool(1);
      const { service, events } = recordingService(pool);
      const replacement = await makePng(400, 400, { r: 200, g: 30, b: 30 });
      const result = await queuedBehindBusyPool(pool,
        () => service.ensureTargetGeneration(project.id, asset.id, targetPolicy()),
        () => writeProjectFile(absPath, 'target-replaced.png', replacement));
      expect(result).toMatchObject({ status: 'ready', cacheState: 'regenerated',
        revision: currentRevisionToken(asset.id), preview: { width: 400, height: 400 } });
      expect(events).toEqual(['staging', 'staging', 'thumbnail:encode', 'thumbnail:encoded',
        'preview:encode', 'preview:encoded']);
      expect(sourceRow(asset.id).size_bytes).toBe(replacement.length);
      expect(pool.stats).toMatchObject({ admitted: 1, active: 0, released: 1 });
      expect(_lockCountForTests()).toBe(0);
    });

    it('releases the permit when generation fails', async () => {
      const { project, asset } = await source('fails.png', await makePng(900, 700));
      const pool = admissionPool(1);
      const service = admittedService(pool, { beforeThumbTransform: () => {
        throw new Error('injected generation failure');
      } });
      await expect(service.getPreview(project.id, asset.id)).rejects.toThrow('injected generation failure');
      expect(pool.stats).toMatchObject({ admitted: 1, active: 0, released: 1 });
      expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
      expect(_lockCountForTests()).toBe(0);
      // The single slot is free again for the next caller.
      expect((await admittedService(pool).getPreview(project.id, asset.id)).cacheState).toBe('regenerated');
    });

    it('rebuilds through Preview Service admission at capacity one without nesting', async () => {
      const assets = [];
      for (const name of ['r1.png', 'r2.png']) {
        const fixture = await source(name, await makePng(900, 700));
        await h.service.getPreview(fixture.project.id, fixture.asset.id);
        assets.push(fixture);
      }
      const pool = admissionPool(1);
      const imageSettings = createProjectImageSettingsService({ appMetaRepository: settings() });
      const repository = createGeneratedImageRebuildRepository(h.db, settings());
      const rebuild = createGeneratedImageRebuildService({
        repository, imageSettings, previewService: admittedService(pool),
        maintenanceState: { active: false },
        managedUploadTracker: { begin: () => ({ complete() {} }) },
      });
      rebuild.queueManual();
      rebuild.signal();
      await rebuild.waitForIdle();
      expect(rebuild.readStatus()).toMatchObject({ phase: 'completed', succeeded: 2, failed: 0,
        cursor: assets.at(-1).asset.id });
      expect(pool.stats).toMatchObject({ requested: 2, admitted: 2, maxActive: 1, active: 0, released: 2 });
    });

    it('leaves shared permits for a cold foreground preview while the rebuild window is full', async () => {
      const assets = [];
      for (const name of ['w1.png', 'w2.png', 'w3.png', 'w4.png']) {
        assets.push(await source(name, await makePng(900, 700)));
      }
      const pool = admissionPool(4);
      const gate = makeGate();
      let gated = 0;
      const allGated = makeGate();
      // Only the first two generations (the rebuild window at C = 4) wait
      // here, inside the permit they were admitted with.
      const service = admittedService(pool, { onStagingCreated: () => {
        if (gated >= 2) return undefined;
        gated += 1;
        if (gated === 2) allGated.release();
        return gate.promise;
      } });
      const imageSettings = createProjectImageSettingsService({ appMetaRepository: settings() });
      const rebuild = createGeneratedImageRebuildService({
        repository: createGeneratedImageRebuildRepository(h.db, settings()),
        imageSettings, previewService: service,
        maintenanceState: { active: false },
        managedUploadTracker: { begin: () => ({ complete() {} }) },
        processingConcurrency: pool.service.concurrency,
      });
      rebuild.queueManual();
      rebuild.signal();
      await allGated.promise;
      await drainTurns();
      // B = min(C - 1, 2): the rebuild never submits its third asset while two wait.
      expect(pool.stats).toMatchObject({ requested: 2, admitted: 2, active: 2 });
      const foreground = assets[3];
      const cold = await service.getPreview(foreground.project.id, foreground.asset.id);
      expect(cold.cacheState).toBe('regenerated');
      expect(pool.stats).toMatchObject({ requested: 3, admitted: 3, active: 2, maxActive: 3 });
      gate.release();
      await rebuild.waitForIdle();
      expect(rebuild.readStatus()).toMatchObject({ phase: 'completed', succeeded: 4, failed: 0,
        cursor: foreground.asset.id });
      expect(pool.stats).toMatchObject({ requested: 5, admitted: 5, active: 0, maxActive: 3 });
    });

    // Holds a manual force rebuild of one asset inside its permit and lock,
    // after it has started generating, until `release()`.
    async function heldForceRebuild(project, asset, pool, hooks = {}) {
      const gate = makeGate();
      const entered = makeGate();
      let holds = 0;
      const service = admittedService(pool, { ...hooks, beforeThumbTransform: () => {
        holds += 1;
        if (holds > 1) return undefined;
        entered.release();
        return gate.promise;
      } });
      const force = service.ensureTargetGeneration(project.id, asset.id, targetPolicy(), () => true,
        { force: true });
      await entered.promise;
      return { service, force, release: () => gate.release() };
    }

    it.each(['getThumbnail', 'getPreview'])(
      '%s serves the published pair without waiting for a held same-asset force rebuild', async (method) => {
        const { project, asset } = await source(`force-held-${method}.png`, await makePng(900, 700));
        const first = await h.service.getPreview(project.id, asset.id);
        const firstDir = path.dirname(first.path);
        const pool = admissionPool(2);
        const held = await heldForceRebuild(project, asset, pool);
        try {
          // Resolves while the force generation still owns the asset lock
          // and its permit; waiting on either would never settle here.
          const served = await held.service[method](project.id, asset.id);
          expect(served).toMatchObject({ status: 'ready', cacheState: 'fresh', revision: first.revision });
          expect(path.dirname(served.path)).toBe(firstDir);
          expect(pool.stats).toMatchObject({ requested: 1, active: 1 });
        } finally {
          held.release();
        }
        const rebuilt = await held.force;
        expect(rebuilt.cacheState).toBe('regenerated');
        // The force caller still regenerated; later reads see its new pair.
        const after = await held.service[method](project.id, asset.id);
        expect(after).toMatchObject({ cacheState: 'fresh', revision: first.revision });
        expect(path.dirname(after.path)).not.toBe(firstDir);
        expect(_lockCountForTests()).toBe(0);
      },
    );

    it('never serves the held pair once the source generation moved on during a force rebuild', async () => {
      const { project, asset } = await source('force-held-generation.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      const held = await heldForceRebuild(project, asset, admissionPool(2));
      h.db.prepare('UPDATE assets SET source_generation = 1 WHERE id = ?').run(asset.id);
      const pending = held.service.getPreview(project.id, asset.id);
      held.release();
      await held.force.catch(() => {});
      const result = await pending;
      expect(result.revision).toBe(currentRevisionToken(asset.id));
      expect(result.revision).not.toBe(first.revision);
      expect(JSON.parse(fs.readFileSync(path.join(path.dirname(result.path), 'meta.json'), 'utf8'))
        .source.generation).toBe(1);
    });

    // Starts a presentation read on a held force rebuild's service and, once
    // it has validated a pre-lock candidate and run `duringProof` (if any),
    // reports whether it settled without the asset lock. The force rebuild is
    // released before returning so a failed assertion never strands the lock.
    async function presentationAfterProof(held, proof, method) {
      let settled = false;
      const pending = held.service[method](...held.ids).finally(() => { settled = true; });
      await proof.reached.promise;
      await drainTurns();
      const settledBeforeRelease = settled;
      held.release();
      return { pending, settled: settledBeforeRelease };
    }

    function proofHooks(duringProof = () => {}) {
      const reached = makeGate();
      let calls = 0;
      return {
        reached,
        get calls() { return calls; },
        hooks: { beforePresentationSourceProof: async () => {
          calls += 1;
          if (calls === 1) await duringProof();
          reached.release();
        } },
      };
    }

    async function heldWithProof(project, asset, duringProof) {
      const proof = proofHooks(duringProof);
      const held = await heldForceRebuild(project, asset, admissionPool(2), proof.hooks);
      held.ids = [project.id, asset.id];
      return { held, proof };
    }

    it.each(['getThumbnail', 'getPreview'])(
      '%s queues on the lock when the PNG source was replaced on disk during a held force rebuild',
      async (method) => {
        const name = `force-held-replaced-${method}.png`;
        const { project, absPath, asset } = await source(name, await makePng(900, 700));
        const first = await h.service.getPreview(project.id, asset.id);
        const { held, proof } = await heldWithProof(project, asset);
        // No scan: the row still describes the old source, so the published
        // pair is fresh against the DB but not against the disk.
        writeProjectFile(absPath, name, await makePng(400, 300, { r: 200, g: 30, b: 30 }));
        const { pending, settled } = await presentationAfterProof(held, proof, method);
        expect(settled).toBe(false);
        await held.force.catch(() => {});
        const result = await pending;
        expect(result.revision).not.toBe(first.revision);
        expect(result.revision).toBe(currentRevisionToken(asset.id));
        expect(sourceRow(asset.id).size_bytes).not.toBe(asset.size_bytes);
        if (method === 'getPreview') expect(result).toMatchObject({ width: 400, height: 300 });
        expect(_lockCountForTests()).toBe(0);
      },
    );

    it('queues on the lock when the source is replaced keeping size and mtime during validation', async () => {
      const name = 'force-held-same-tuple.png';
      const { project, absPath, asset } = await source(name, await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      const filePath = path.join(absPath, name);
      const { held, proof } = await heldWithProof(project, asset, () => {
        // A new file instance with the same bytes, size and mtime.
        const stat = fs.statSync(filePath);
        const replacement = `${filePath}.replacement`;
        fs.writeFileSync(replacement, fs.readFileSync(filePath));
        fs.utimesSync(replacement, stat.atime, stat.mtime);
        fs.renameSync(replacement, filePath);
        expect(fs.statSync(filePath).size).toBe(stat.size);
        expect(fs.statSync(filePath).mtime.toISOString()).toBe(stat.mtime.toISOString());
      });
      const { pending, settled } = await presentationAfterProof(held, proof, 'getPreview');
      expect(settled).toBe(false);
      await held.force.catch(() => {});
      const result = await pending;
      expect(result.status).toBe('ready');
      expect(path.dirname(result.path)).not.toBe(path.dirname(first.path));
    });

    it('never returns the pre-lock pair when the source generation advances during validation', async () => {
      const { project, asset } = await source('force-held-generation-race.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      const { held, proof } = await heldWithProof(project, asset, () => {
        h.db.prepare('UPDATE assets SET source_generation = 1 WHERE id = ?').run(asset.id);
      });
      const { pending, settled } = await presentationAfterProof(held, proof, 'getPreview');
      expect(settled).toBe(false);
      await held.force.catch(() => {});
      const result = await pending;
      expect(result.revision).not.toBe(first.revision);
      expect(result.revision).toBe(currentRevisionToken(asset.id));
      expect(JSON.parse(fs.readFileSync(path.join(path.dirname(result.path), 'meta.json'), 'utf8'))
        .source.generation).toBe(1);
    });

    it('never returns the pre-lock pair as fresh when the policy changes during validation', async () => {
      const { project, asset } = await source('force-held-policy-race.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      const { held, proof } = await heldWithProof(project, asset, () => {
        set('images.preview.webp_quality', 52);
      });
      const { pending, settled } = await presentationAfterProof(held, proof, 'getPreview');
      expect(settled).toBe(false);
      // The force target is obsolete under the new policy.
      await expect(held.force).rejects.toThrow('obsolete');
      const result = await pending;
      expect(result.cacheState).toBe('regenerated');
      expect(result.revision).not.toBe(first.revision);
      expect(result.revision).toBe(currentRevisionToken(asset.id));
    });

    it('queues a corrupt published pair on the lock without a pre-lock source proof', async () => {
      const { project, asset } = await source('force-held-corrupt.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      const { held, proof } = await heldWithProof(project, asset);
      fs.writeFileSync(first.path, Buffer.from('not an image'));
      let settled = false;
      const pending = held.service.getPreview(project.id, asset.id).finally(() => { settled = true; });
      // Let the pre-lock probe (a failed decode) finish before checking.
      for (let i = 0; i < 20 && proof.calls === 0; i++) await drainTurns();
      const settledBeforeRelease = settled;
      held.release();
      expect(settledBeforeRelease).toBe(false);
      expect(proof.calls).toBe(0);
      const rebuilt = await held.force;
      const result = await pending;
      expect(result).toMatchObject({ cacheState: 'fresh', path: rebuilt.preview.path });
      expect(proof.calls).toBe(0);
    });

    it.each(['getThumbnail', 'getPreview'])(
      '%s proves an unchanged source and serves the published pair during a held force rebuild',
      async (method) => {
        const { project, asset } = await source(`force-held-proof-${method}.png`, await makePng(900, 700));
        const first = await h.service.getPreview(project.id, asset.id);
        const { held, proof } = await heldWithProof(project, asset);
        try {
          const served = await held.service[method](project.id, asset.id);
          expect(served).toMatchObject({ status: 'ready', cacheState: 'fresh', revision: first.revision });
          expect(path.dirname(served.path)).toBe(path.dirname(first.path));
          expect(proof.calls).toBe(1);
        } finally {
          held.release();
        }
        expect((await held.force).cacheState).toBe('regenerated');
      },
    );

    it('serves prior-policy bytes without waiting for a held automatic target generation', async () => {
      const { project, asset } = await source('automatic-held.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      set('images.preview.webp_quality', 52);
      const pool = admissionPool(2);
      const gate = makeGate();
      const entered = makeGate();
      const service = admittedService(pool, { onStagingCreated: () => {
        entered.release();
        return gate.promise;
      } });
      const target = service.ensureTargetGeneration(project.id, asset.id, targetPolicy());
      await entered.promise;
      try {
        expect(await service.getThumbnail(project.id, asset.id))
          .toMatchObject({ cacheState: 'prior-policy', revision: first.revision });
        expect(await service.getPreview(project.id, asset.id))
          .toMatchObject({ cacheState: 'prior-policy', revision: first.revision });
        expect(pool.stats).toMatchObject({ requested: 1, active: 1 });
      } finally {
        gate.release();
      }
      expect((await target).cacheState).toBe('regenerated');
      expect(await service.getPreview(project.id, asset.id))
        .toMatchObject({ cacheState: 'fresh', revision: currentRevisionToken(asset.id) });
    });

    describe('failed presentation source proof carried into the lock', () => {
      const RED = { r: 220, g: 20, b: 20 };
      const BLUE = { r: 20, g: 20, b: 220 };

      function stagedRecorder(pool, hooks = {}) {
        const staged = [];
        const service = admittedService(pool, { ...hooks,
          onDerivativeStaged: (kind, mode) => staged.push(`${kind}:${mode}`) });
        return { service, staged };
      }

      function publishedPair(project, asset) {
        const meta = readMetaFile(publishedFile(h, project.id, asset.id, META_FILENAME)).meta;
        return { meta,
          thumbnail: { path: publishedFile(h, project.id, asset.id, meta.thumbnail.filename) },
          preview: { path: publishedFile(h, project.id, asset.id, meta.preview.filename) } };
      }

      async function expectPairColor(project, asset, color) {
        for (const kind of ['thumbnail', 'preview']) {
          const [r, , b] = await previewPixel(publishedPair(project, asset)[kind]);
          if (color === RED) {
            expect(r).toBeGreaterThan(150);
            expect(b).toBeLessThan(80);
          } else {
            expect(b).toBeGreaterThan(150);
            expect(r).toBeLessThan(80);
          }
        }
      }

      // Replaces the source with a new file instance carrying the same size
      // and mtime as the current one.
      function replaceKeepingTuple(filePath, bytes) {
        const stat = fs.statSync(filePath);
        expect(bytes.length).toBe(stat.size);
        const replacement = `${filePath}.replacement`;
        fs.writeFileSync(replacement, bytes);
        fs.utimesSync(replacement, stat.atime, stat.mtime);
        fs.renameSync(replacement, filePath);
        expect(fs.statSync(filePath).mtime.toISOString()).toBe(stat.mtime.toISOString());
      }

      it.each(['getThumbnail', 'getPreview'])(
        '%s reconciles an unscanned different-size replacement instead of serving the old pair',
        async (method) => {
          const name = `presentation-resized-${method}.png`;
          const { project, absPath, asset } = await source(name, await makePng(900, 700, RED));
          const first = await h.service.getPreview(project.id, asset.id);
          expect(first).toMatchObject({ width: 900, height: 700 });
          const before = sourceRow(asset.id);
          // No scan: the row and the published pair still describe 900x700.
          writeProjectFile(absPath, name, await makePng(400, 300, BLUE));
          const { service, staged } = stagedRecorder(admissionPool(2));
          const result = await service[method](project.id, asset.id);
          expect(result.cacheState).toBe('regenerated');
          expect(result.revision).not.toBe(first.revision);
          expect(result.revision).toBe(currentRevisionToken(asset.id));
          const stat = fs.statSync(path.join(absPath, name));
          expect(sourceRow(asset.id)).toEqual({ ...before, size_bytes: stat.size,
            modified_at: stat.mtime.toISOString(), source_generation: before.source_generation + 1 });
          expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
          const { meta } = publishedPair(project, asset);
          expect(meta.preview).toMatchObject({ width: 400, height: 300 });
          expect(meta.source.generation).toBe(before.source_generation + 1);
          await expectPairColor(project, asset, BLUE);
          expect(await service.getPreview(project.id, asset.id))
            .toMatchObject({ cacheState: 'fresh', revision: result.revision, width: 400, height: 300 });
          expect(_lockCountForTests()).toBe(0);
        },
      );

      it.each(['getThumbnail', 'getPreview'])(
        '%s never publishes a mixed pair after a same-size, same-mtime replacement during validation',
        async (method) => {
          const name = `presentation-same-tuple-${method}.png`;
          const { project, absPath, asset } = await source(name, await makePng(900, 700, RED));
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          // A Preview-only policy change: the old Thumbnail would be reusable
          // if the source were unchanged.
          set('images.preview.webp_quality', 52);
          const blue = await makePng(900, 700, BLUE);
          const proof = proofHooks(() => replaceKeepingTuple(path.join(absPath, name), blue));
          const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
          const result = await service[method](project.id, asset.id);
          expect(proof.calls).toBe(1);
          expect(result.cacheState).toBe('regenerated');
          expect(result.revision).not.toBe(first.revision);
          expect(result.revision).toBe(currentRevisionToken(asset.id));
          // Only the source generation moved: the tuple is identical.
          expect(sourceRow(asset.id)).toEqual({ ...before,
            source_generation: before.source_generation + 1 });
          expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
          const { meta } = publishedPair(project, asset);
          expect(meta.source.generation).toBe(before.source_generation + 1);
          await expectPairColor(project, asset, BLUE);
          expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
          expect(_lockCountForTests()).toBe(0);
        },
      );

      it('accepts a replacement a scan recorded before the lock without counting it twice', async () => {
        const name = 'presentation-scanned.png';
        const { project, absPath, asset } = await source(name, await makePng(900, 700, RED));
        await h.service.getPreview(project.id, asset.id);
        let scanned;
        const proof = proofHooks(async () => {
          writeProjectFile(absPath, name, await makePng(400, 300, BLUE));
          scanned = h.indexAsset(project, name);
        });
        const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
        const result = await service.getPreview(project.id, asset.id);
        expect(scanned.source_generation).toBe(asset.source_generation + 1);
        // The request accepted the scanned row as-is: no second increment.
        expect(sourceRow(asset.id).source_generation).toBe(scanned.source_generation);
        expect(result).toMatchObject({ cacheState: 'regenerated', width: 400, height: 300,
          revision: currentRevisionToken(asset.id) });
        expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
        await expectPairColor(project, asset, BLUE);
      });

      it('reconciles the source on disk when it is replaced again while waiting for admission', async () => {
        const name = 'presentation-replaced-again.png';
        const { project, absPath, asset } = await source(name, await makePng(900, 700, RED));
        await h.service.getPreview(project.id, asset.id);
        const before = sourceRow(asset.id);
        const second = await makePng(400, 300, RED);
        const third = await makePng(300, 200, BLUE);
        const proof = proofHooks(() => writeProjectFile(absPath, name, second));
        const pool = admissionPool(1);
        const { service, staged } = stagedRecorder(pool, proof.hooks);
        const result = await queuedBehindBusyPool(pool,
          () => service.getPreview(project.id, asset.id),
          () => writeProjectFile(absPath, name, third));
        // The row is reconciled once, to the file actually on disk.
        const stat = fs.statSync(path.join(absPath, name));
        expect(sourceRow(asset.id)).toEqual({ ...before, size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(), source_generation: before.source_generation + 1 });
        expect(result).toMatchObject({ cacheState: 'regenerated', width: 300, height: 200,
          revision: currentRevisionToken(asset.id) });
        expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
        await expectPairColor(project, asset, BLUE);
        expect(pool.stats).toMatchObject({ requested: 1, active: 0 });
      });

      it('keeps a policy change during validation separate from source replacement', async () => {
        const name = 'presentation-policy-only.png';
        const { project, asset } = await source(name, await makePng(900, 700, RED));
        const first = await h.service.getPreview(project.id, asset.id);
        const before = sourceRow(asset.id);
        const proof = proofHooks(() => set('images.preview.webp_quality', 52));
        const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
        const result = await service.getPreview(project.id, asset.id);
        expect(result.cacheState).toBe('regenerated');
        expect(result.revision).not.toBe(first.revision);
        expect(result.revision).toBe(currentRevisionToken(asset.id));
        // Same source: no generation bump, and the unchanged Thumbnail is reused.
        expect(sourceRow(asset.id)).toEqual(before);
        expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      });

      // Counts opens of one source file and fails the next `fail(n)` of them
      // with EIO, so a pre-lock proof can be made unproven ('unknown').
      function sourceOpenFaults(name) {
        const originalOpenSync = fs.openSync;
        const state = { opens: 0, pending: 0, injected: 0 };
        const spy = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
          if (path.basename(String(file)) === name) {
            state.opens += 1;
            if (state.pending > 0) {
              state.pending -= 1;
              state.injected += 1;
              throw Object.assign(new Error('source read failed'), { code: 'EIO' });
            }
          }
          return originalOpenSync.call(fs, file, ...args);
        });
        return {
          state,
          // Arms `count` failures and restarts the open count from here.
          fail(count = 1) { state.pending += count; state.opens = 0; },
          restore: () => spy.mockRestore(),
        };
      }

      it.each(['getThumbnail', 'getPreview'])(
        '%s never serves the old pair after a replacement whose pre-lock proof hit a transient EIO',
        async (method) => {
          const name = `presentation-eio-resized-${method}.png`;
          const { project, absPath, asset } = await source(name, await makePng(900, 700, RED));
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          const faults = sourceOpenFaults(name);
          const proof = proofHooks(async () => {
            writeProjectFile(absPath, name, await makePng(400, 300, BLUE));
            faults.fail(1);
          });
          const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
          let result;
          try {
            result = await service[method](project.id, asset.id);
          } finally {
            faults.restore();
          }
          // The pre-lock proof failed on open; the locked path opened the
          // source again and proved the replacement.
          expect(proof.calls).toBe(1);
          expect(faults.state.injected).toBe(1);
          expect(faults.state.opens).toBeGreaterThanOrEqual(2);
          expect(result.cacheState).toBe('regenerated');
          expect(result.revision).not.toBe(first.revision);
          expect(result.revision).toBe(currentRevisionToken(asset.id));
          const stat = fs.statSync(path.join(absPath, name));
          expect(sourceRow(asset.id)).toEqual({ ...before, size_bytes: stat.size,
            modified_at: stat.mtime.toISOString(), source_generation: before.source_generation + 1 });
          expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
          const { meta } = publishedPair(project, asset);
          expect(meta.preview).toMatchObject({ width: 400, height: 300 });
          await expectPairColor(project, asset, BLUE);
          expect(_lockCountForTests()).toBe(0);
        },
      );

      it.each(['getThumbnail', 'getPreview'])(
        '%s serves the current pair after a transient pre-lock EIO once the locked proof succeeds',
        async (method) => {
          const name = `presentation-eio-unchanged-${method}.png`;
          const { project, asset } = await source(name, await makePng(900, 700, RED));
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          const faults = sourceOpenFaults(name);
          const proof = proofHooks(() => faults.fail(1));
          const pool = admissionPool(2);
          const { service, staged } = stagedRecorder(pool, proof.hooks);
          let result;
          try {
            result = await service[method](project.id, asset.id);
          } finally {
            faults.restore();
          }
          expect(faults.state.injected).toBe(1);
          expect(faults.state.opens).toBeGreaterThanOrEqual(2);
          // An unproven source is not a replacement: nothing regenerates and
          // the source generation stays put.
          expect(result).toMatchObject({ status: 'ready', cacheState: 'fresh', revision: first.revision });
          expect(path.dirname(result.path)).toBe(path.dirname(first.path));
          expect(sourceRow(asset.id)).toEqual(before);
          expect(staged).toEqual([]);
          expect(pool.stats).toMatchObject({ requested: 1, active: 0 });
          expect(_lockCountForTests()).toBe(0);
        },
      );

      it('keeps selective reuse for a prior-policy candidate whose source proves unchanged in the lock', async () => {
        const name = 'presentation-eio-prior-policy.png';
        const { project, asset } = await source(name, await makePng(900, 700, RED));
        const first = await h.service.getPreview(project.id, asset.id);
        const before = sourceRow(asset.id);
        set('images.preview.webp_quality', 52);
        const faults = sourceOpenFaults(name);
        const proof = proofHooks(() => faults.fail(1));
        const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
        let result;
        try {
          result = await service.getPreview(project.id, asset.id);
        } finally {
          faults.restore();
        }
        expect(faults.state.injected).toBe(1);
        // The unproven prior-policy pair is not served; the locked proof
        // succeeds, so the unchanged Thumbnail is still reused.
        expect(result.cacheState).toBe('regenerated');
        expect(result.revision).not.toBe(first.revision);
        expect(result.revision).toBe(currentRevisionToken(asset.id));
        expect(sourceRow(asset.id)).toEqual(before);
        expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
      });

      it('reconciles a same-size, same-mtime replacement whose pre-lock proof hit a transient EIO', async () => {
        const name = 'presentation-eio-same-tuple.png';
        const { project, absPath, asset } = await source(name, await makePng(900, 700, RED));
        const first = await h.service.getPreview(project.id, asset.id);
        const before = sourceRow(asset.id);
        // A Preview-only policy change: the pre-lock candidate is prior-policy
        // and the old Thumbnail would be reusable if the source were unchanged.
        set('images.preview.webp_quality', 52);
        const blue = await makePng(900, 700, BLUE);
        const faults = sourceOpenFaults(name);
        const proof = proofHooks(() => {
          replaceKeepingTuple(path.join(absPath, name), blue);
          faults.fail(1);
        });
        const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
        let result;
        try {
          result = await service.getPreview(project.id, asset.id);
        } finally {
          faults.restore();
        }
        expect(faults.state.injected).toBe(1);
        expect(result.cacheState).toBe('regenerated');
        expect(result.revision).not.toBe(first.revision);
        expect(result.revision).toBe(currentRevisionToken(asset.id));
        // The baseline pinned before probing proved the new file instance.
        expect(sourceRow(asset.id)).toEqual({ ...before,
          source_generation: before.source_generation + 1 });
        expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
        await expectPairColor(project, asset, BLUE);
        expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
      });

      it('never serves the old pair when the source stays unreadable inside the lock', async () => {
        const name = 'presentation-eio-persistent.png';
        const { project, absPath, asset } = await source(name, await makePng(900, 700, RED));
        const first = await h.service.getPreview(project.id, asset.id);
        const before = sourceRow(asset.id);
        const publishedBefore = publishedPair(project, asset).meta;
        writeProjectFile(absPath, name, await makePng(400, 300, BLUE));
        const faults = sourceOpenFaults(name);
        const proof = proofHooks(() => faults.fail(100));
        const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
        try {
          await expect(service.getPreview(project.id, asset.id)).rejects.toThrow('Asset file cannot be opened.');
        } finally {
          faults.restore();
        }
        expect(faults.state.injected).toBeGreaterThanOrEqual(2);
        expect(sourceRow(asset.id)).toEqual(before);
        expect(staged).toEqual([]);
        expect(publishedPair(project, asset).meta).toEqual(publishedBefore);
        expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
        expect(_lockCountForTests()).toBe(0);
        // Once the source reads again, the replacement is reconciled.
        const recovered = await service.getPreview(project.id, asset.id);
        expect(recovered).toMatchObject({ cacheState: 'regenerated', width: 400, height: 300 });
        expect(recovered.revision).not.toBe(first.revision);
        expect(sourceRow(asset.id).source_generation).toBe(before.source_generation + 1);
      });

      describe('GIF/WebP animation read during the pre-lock proof', () => {
        // Tracks descriptors opened on one source file and faults their
        // GIF/WebP structural read (fs.readFileSync on the descriptor) and,
        // optionally, the identity checks that follow it. Hooks run at the
        // point of the fault, after the proof's initial identity checks.
        function animationReadFaults(name) {
          const fds = new Set();
          const state = { reads: 0, injected: 0, readFailures: 0, persistent: false,
            onRead: null, afterRead: null, fstatFailures: 0 };
          const eio = () => Object.assign(new Error('source read failed'), { code: 'EIO' });
          const originalOpenSync = fs.openSync;
          const originalCloseSync = fs.closeSync;
          const originalReadFileSync = fs.readFileSync;
          const originalFstatSync = fs.fstatSync;
          const originalReadFile = fs.readFile;
          const spies = [
            vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
              const fd = originalOpenSync.call(fs, file, ...args);
              if (path.basename(String(file)) === name) fds.add(fd);
              return fd;
            }),
            vi.spyOn(fs, 'closeSync').mockImplementation((fd, ...args) => {
              fds.delete(fd);
              return originalCloseSync.call(fs, fd, ...args);
            }),
            vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
              if (typeof file !== 'number' || !fds.has(file)) return originalReadFileSync.call(fs, file, ...args);
              state.reads += 1;
              if (state.onRead) {
                const hook = state.onRead;
                state.onRead = null;
                hook();
              }
              if (state.persistent || state.readFailures > 0) {
                if (!state.persistent) state.readFailures -= 1;
                state.injected += 1;
                throw eio();
              }
              const bytes = originalReadFileSync.call(fs, file, ...args);
              if (state.afterRead) {
                const hook = state.afterRead;
                state.afterRead = null;
                hook();
              }
              return bytes;
            }),
            vi.spyOn(fs, 'fstatSync').mockImplementation((fd, ...args) => {
              if (state.fstatFailures > 0 && fds.has(fd)) {
                state.fstatFailures -= 1;
                state.injected += 1;
                throw eio();
              }
              return originalFstatSync.call(fs, fd, ...args);
            }),
            vi.spyOn(fs, 'readFile').mockImplementation((file, ...args) => {
              if (state.persistent && typeof file === 'number' && fds.has(file)) {
                state.injected += 1;
                const callback = args[args.length - 1];
                setImmediate(() => callback(eio()));
                return undefined;
              }
              return originalReadFile.call(fs, file, ...args);
            }),
          ];
          return {
            state,
            // Fails the next `count` structural reads, running `onRead` first.
            failRead(count = 1, onRead = null) { state.readFailures += count; state.onRead = onRead; },
            // Fails every structural and descriptor read of the source.
            failPersistently(onRead = null) { state.persistent = true; state.onRead = onRead; },
            // Lets the next structural read succeed, then runs `afterRead`.
            afterNextRead(afterRead) { state.afterRead = afterRead; },
            restore: () => spies.forEach((spy) => spy.mockRestore()),
          };
        }

        async function gifPair() {
          const a = await makeAnimatedGif(90, 70, 3);
          const b = await makeAnimatedGif(40, 30, 3);
          expect(a.length).not.toBe(b.length);
          return { a, b };
        }

        async function run(faults, fn) {
          try {
            return await fn();
          } finally {
            faults.restore();
          }
        }

        it.each(['getThumbnail', 'getPreview'])(
          '%s never serves the old GIF pair after a replacement whose animation read hit EIO',
          async (method) => {
            const name = `presentation-anim-eio-${method}.gif`;
            const { a, b } = await gifPair();
            const { project, absPath, asset } = await source(name, a);
            expect(asset.source_animated).toBe(1);
            const first = await h.service.getPreview(project.id, asset.id);
            expect(first).toMatchObject({ width: 90, height: 70 });
            const before = sourceRow(asset.id);
            const faults = animationReadFaults(name);
            // The initial identity checks pass on A; A is then replaced by B
            // and the structural read fails.
            const proof = proofHooks(() => faults.failRead(1,
              () => writeProjectFile(absPath, name, b)));
            const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
            const result = await run(faults, () => service[method](project.id, asset.id));
            expect(proof.calls).toBe(1);
            expect(faults.state.injected).toBe(1);
            expect(result.cacheState).toBe('regenerated');
            expect(result.revision).not.toBe(first.revision);
            expect(result.revision).toBe(currentRevisionToken(asset.id));
            expect(path.dirname(result.path)).not.toBe(path.dirname(first.path));
            const stat = fs.statSync(path.join(absPath, name));
            expect(stat.size).toBe(b.length);
            expect(sourceRow(asset.id)).toEqual({ ...before, size_bytes: stat.size,
              modified_at: stat.mtime.toISOString(), source_generation: before.source_generation + 1 });
            expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
            const { meta } = publishedPair(project, asset);
            expect(meta.preview).toMatchObject({ width: 40, height: 30 });
            expect(meta.source.generation).toBe(before.source_generation + 1);
            expect(_lockCountForTests()).toBe(0);
          },
        );

        it.each(['getThumbnail', 'getPreview'])(
          '%s serves the current GIF pair after a transient animation-read EIO once the locked proof succeeds',
          async (method) => {
            const name = `presentation-anim-eio-unchanged-${method}.gif`;
            const { project, asset } = await source(name, await makeAnimatedGif(90, 70, 3));
            const first = await h.service.getPreview(project.id, asset.id);
            const before = sourceRow(asset.id);
            const faults = animationReadFaults(name);
            const proof = proofHooks(() => faults.failRead(1));
            const pool = admissionPool(2);
            const { service, staged } = stagedRecorder(pool, proof.hooks);
            const result = await run(faults, () => service[method](project.id, asset.id));
            expect(faults.state.injected).toBe(1);
            // The locked proof read the animation again, and it matched.
            expect(faults.state.reads).toBeGreaterThanOrEqual(2);
            expect(result).toMatchObject({ status: 'ready', cacheState: 'fresh', revision: first.revision });
            expect(path.dirname(result.path)).toBe(path.dirname(first.path));
            expect(sourceRow(asset.id)).toEqual(before);
            expect(staged).toEqual([]);
            expect(pool.stats).toMatchObject({ requested: 1, active: 0 });
            expect(_lockCountForTests()).toBe(0);
          },
        );

        it('never serves the old GIF pair while the replaced source stays unreadable', async () => {
          const name = 'presentation-anim-eio-persistent.gif';
          const { a, b } = await gifPair();
          const { project, absPath, asset } = await source(name, a);
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          const publishedBefore = publishedPair(project, asset).meta;
          const faults = animationReadFaults(name);
          const proof = proofHooks(() => faults.failPersistently(() => writeProjectFile(absPath, name, b)));
          const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
          await run(faults, () => expect(service.getPreview(project.id, asset.id))
            .rejects.toMatchObject({ code: 'EIO' }));
          expect(faults.state.injected).toBeGreaterThanOrEqual(2);
          // An unreadable source is not a proven replacement.
          expect(sourceRow(asset.id)).toEqual(before);
          expect(staged).toEqual([]);
          expect(publishedPair(project, asset).meta).toEqual(publishedBefore);
          expect(fs.existsSync(first.path)).toBe(true);
          expect(stagingDirs(h, project.id, asset.id)).toEqual([]);
          expect(_lockCountForTests()).toBe(0);
          // Once the source reads again, the replacement is reconciled once.
          const recovered = await service.getPreview(project.id, asset.id);
          expect(recovered).toMatchObject({ cacheState: 'regenerated', width: 40, height: 30 });
          expect(sourceRow(asset.id).source_generation).toBe(before.source_generation + 1);
        });

        it('never serves the old GIF pair when the source is replaced after its animation read', async () => {
          const name = 'presentation-anim-after-read.gif';
          const { a, b } = await gifPair();
          const { project, absPath, asset } = await source(name, a);
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          const faults = animationReadFaults(name);
          // A's bytes are read and classify; B then replaces it before the
          // final descriptor/path identity checks.
          const proof = proofHooks(() => faults.afterNextRead(() => writeProjectFile(absPath, name, b)));
          const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
          const result = await run(faults, () => service.getPreview(project.id, asset.id));
          expect(faults.state.injected).toBe(0);
          expect(result).toMatchObject({ cacheState: 'regenerated', width: 40, height: 30 });
          expect(result.revision).not.toBe(first.revision);
          expect(sourceRow(asset.id).source_generation).toBe(before.source_generation + 1);
          expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
        });

        it('never serves the old GIF pair when the final identity check throws after a replacement', async () => {
          const name = 'presentation-anim-final-check-eio.gif';
          const { a, b } = await gifPair();
          const { project, absPath, asset } = await source(name, a);
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          const faults = animationReadFaults(name);
          // The animation read succeeds on A; B replaces it and the final
          // descriptor check then fails with EIO.
          const proof = proofHooks(() => faults.afterNextRead(() => {
            writeProjectFile(absPath, name, b);
            faults.state.fstatFailures = 1;
          }));
          const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
          const result = await run(faults, () => service.getPreview(project.id, asset.id));
          expect(faults.state.injected).toBe(1);
          expect(result).toMatchObject({ cacheState: 'regenerated', width: 40, height: 30 });
          expect(result.revision).not.toBe(first.revision);
          expect(sourceRow(asset.id).source_generation).toBe(before.source_generation + 1);
          expect(staged).toEqual(['thumbnail:encoded', 'preview:encoded']);
        });

        it('keeps selective reuse for a prior-policy GIF pair after a transient animation-read EIO', async () => {
          const name = 'presentation-anim-eio-prior-policy.gif';
          const { project, asset } = await source(name, await makeAnimatedGif(90, 70, 3));
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          set('images.preview.webp_quality', 52);
          const faults = animationReadFaults(name);
          const proof = proofHooks(() => faults.failRead(1));
          const { service, staged } = stagedRecorder(admissionPool(2), proof.hooks);
          const result = await run(faults, () => service.getPreview(project.id, asset.id));
          expect(faults.state.injected).toBe(1);
          // The unproven prior-policy pair is not served pre-lock; the
          // locked proof succeeds, so the unchanged Thumbnail is reused.
          expect(result.cacheState).toBe('regenerated');
          expect(result.revision).not.toBe(first.revision);
          expect(result.revision).toBe(currentRevisionToken(asset.id));
          expect(sourceRow(asset.id)).toEqual(before);
          expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
        });

        it('keeps a stable, structurally unclassified GIF on its published pair without regenerating', async () => {
          const name = 'presentation-anim-unclassified.gif';
          // Trailing bytes after the GIF trailer: Sharp decodes it, while the
          // structural inspector returns it as unclassified (null).
          const bytes = Buffer.concat([await makeAnimatedGif(90, 70, 3), Buffer.from([0])]);
          const { project, absPath, asset } = await source(name, bytes);
          expect(asset.source_animated).toBe(1);
          expect(inspectSourceAnimation(path.join(absPath, name), 'gif')).toBeNull();
          const first = await h.service.getPreview(project.id, asset.id);
          const before = sourceRow(asset.id);
          const pool = admissionPool(2);
          const { service, staged } = stagedRecorder(pool);
          for (const method of ['getThumbnail', 'getPreview', 'getPreview']) {
            expect(await service[method](project.id, asset.id))
              .toMatchObject({ status: 'ready', cacheState: 'fresh', revision: first.revision });
          }
          expect(staged).toEqual([]);
          expect(pool.stats.requested).toBe(0);
          expect(sourceRow(asset.id)).toEqual(before);
        });

        it.each(['getThumbnail', 'getPreview'])(
          '%s serves a readable, unchanged GIF pair during a held force rebuild',
          async (method) => {
            const { project, asset } = await source(`force-held-anim-${method}.gif`,
              await makeAnimatedGif(90, 70, 3));
            const first = await h.service.getPreview(project.id, asset.id);
            const { held, proof } = await heldWithProof(project, asset);
            try {
              const served = await held.service[method](project.id, asset.id);
              expect(served).toMatchObject({ status: 'ready', cacheState: 'fresh', revision: first.revision });
              expect(path.dirname(served.path)).toBe(path.dirname(first.path));
              expect(proof.calls).toBe(1);
            } finally {
              held.release();
            }
            expect((await held.force).cacheState).toBe('regenerated');
          },
        );
      });
    });

    it('keeps ensureCurrentPreview behind a held same-asset generation', async () => {
      const { project, asset } = await source('ensure-current-held.png', await makePng(900, 700));
      await h.service.getPreview(project.id, asset.id);
      const held = await heldForceRebuild(project, asset, admissionPool(2));
      let settled = false;
      const current = held.service.ensureCurrentPreview(project.id, asset.id)
        .finally(() => { settled = true; });
      await drainTurns();
      expect(settled).toBe(false);
      held.release();
      const rebuilt = await held.force;
      expect(await current).toMatchObject({ cacheState: 'fresh', path: rebuilt.preview.path });
    });

    it('does not re-probe the published pair before a force rebuild regenerates it', async () => {
      const { project, asset } = await source('force-no-probe.png', await makePng(900, 700));
      const first = await h.service.getPreview(project.id, asset.id);
      const publishedPaths = new Set([first.path, path.join(path.dirname(first.path), THUMBNAIL_FILENAME)]);
      const originalReadFileSync = fs.readFileSync;
      const publishedReads = [];
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
        if (publishedPaths.has(String(filePath))) publishedReads.push(path.basename(String(filePath)));
        return originalReadFileSync.call(fs, filePath, ...args);
      });
      let result;
      try {
        result = await admittedService(admissionPool(1)).ensureTargetGeneration(
          project.id, asset.id, targetPolicy(), () => true, { force: true });
      } finally {
        readSpy.mockRestore();
      }
      expect(result.cacheState).toBe('regenerated');
      expect(publishedReads).toEqual([]);
    });
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

  it('getOriginalDescriptor classifies a Krita asset as previewable', async () => {
    const { project, absPath } = h.createProject('Desc Krita');
    fs.writeFileSync(path.join(absPath, 'k.kra'), Buffer.from('x'));
    const asset = h.indexAsset(project, 'k.kra');

    const d = h.service.getOriginalDescriptor(project.id, asset.id);
    expect(d.status).toBe('unsupported');
    expect(d.previewable).toBe(true);
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
    fs.utimesSync(path.join(absPath, 'c.png'), new Date('2026-07-29T10:00:00Z'), new Date('2026-07-29T10:00:00Z'));
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
    fs.utimesSync(path.join(absPath, 'c.png'), new Date('2026-07-30T10:00:00Z'), new Date('2026-07-30T10:00:00Z'));
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
    fs.utimesSync(path.join(absPath, 'c.png'), new Date('2026-07-31T10:00:00Z'), new Date('2026-07-31T10:00:00Z'));
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
    fs.utimesSync(path.join(absPath, 's.png'), new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));
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
    fs.utimesSync(path.join(absPath, 's.png'), new Date('2026-10-02T10:00:00Z'), new Date('2026-10-02T10:00:00Z'));
    h.assetRepo.upsert(project.id, 's.png', {
      filename: 's.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bufC.length,
      modifiedAt: '2026-10-02 10:00:00',
    });
    const revC = buildAssetRevisionToken(h.assetRepo.findById(asset.id),
      projectImagePolicyFingerprint(createProjectImageSettingsService({
        appMetaRepository: createAppMetaRepository(h.db),
      }).getPolicy()));
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
    let sourceReads = 0;
    const service = makeHookedService(h, {
      onStagingCreated: () => { stagingCount += 1; },
      // Runs after the attempt has fully read (asynchronously) and checked
      // its source, before encoding.
      beforeThumbTransform: () => { sourceReads += 1; },
      beforePublishRecheck: () => {
        const g = gates[idx];
        idx += 1;
        return g.promise;
      },
    });

    // Move source to B before starting (so the request generates for B).
    const bufB = await makePng(820, 600);
    writeProjectFile(absPath, 'twice.png', bufB);
    fs.utimesSync(path.join(absPath, 'twice.png'), new Date('2026-10-10T10:00:00Z'), new Date('2026-10-10T10:00:00Z'));
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
    fs.utimesSync(path.join(absPath, 'twice.png'), new Date('2026-10-11T10:00:00Z'), new Date('2026-10-11T10:00:00Z'));
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
    // Wait until attempt #2 has read C: it stages and reads after attempt
    // #1's recheck discarded B. Moving the source before that read finishes
    // would instead fail the read's own descriptor/path identity check.
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (sourceReads >= 2) return resolve();
        if (Date.now() - start > 5000) return resolve(new Error('staging #2 never started'));
        setTimeout(tick, 5);
      };
      tick();
    });

    const bufD = await makePng(860, 600);
    writeProjectFile(absPath, 'twice.png', bufD);
    fs.utimesSync(path.join(absPath, 'twice.png'), new Date('2026-10-12T10:00:00Z'), new Date('2026-10-12T10:00:00Z'));
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
    fs.utimesSync(path.join(absPath, 'f.png'), new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'));
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
    expect(classifyPreviewable({ extension: 'png', mime_type: 'image/png' })).toMatchObject({
      supported: true,
      kind: 'image',
      extension: 'png',
      mimeType: 'image/png',
    });
  });

  it('supports jpg/jpeg case-insensitively', () => {
    expect(classifyPreviewable({ extension: 'JPG', mime_type: 'image/jpeg' }).supported).toBe(true);
    expect(classifyPreviewable({ extension: 'JPEG', mime_type: 'IMAGE/JPEG' }).supported).toBe(true);
  });

  it('supports webp and gif', () => {
    expect(classifyPreviewable({ extension: 'webp', mime_type: 'image/webp' }).supported).toBe(true);
    expect(classifyPreviewable({ extension: 'gif', mime_type: 'image/gif' }).supported).toBe(true);
  });

  it('supports matching KRA and KRZ records as Krita documents', () => {
    expect(classifyPreviewable({ extension: 'kra', mime_type: 'application/x-krita' })).toMatchObject({
      supported: true,
      kind: 'krita',
      extension: 'kra',
      mimeType: 'application/x-krita',
    });
    expect(classifyPreviewable({ extension: 'krz', mime_type: 'application/x-krita' })).toMatchObject({
      supported: true,
      kind: 'krita',
      extension: 'krz',
      mimeType: 'application/x-krita',
    });
  });

  it('rejects mismatched or generic Krita MIME values', () => {
    expect(classifyPreviewable({ extension: 'kra', mime_type: 'image/png' }).supported).toBe(false);
    expect(classifyPreviewable({ extension: 'krz', mime_type: 'application/octet-stream' }).supported).toBe(false);
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
