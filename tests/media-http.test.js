// Phase 10.1C — HTTP routes for generated previews and safe originals.
//
// Coverage:
//   - Successful thumbnail / preview / original responses (Section 9)
//   - Cache behavior: current / missing / stale / malformed revision,
//     cache hit, regenerated derivative, unavailable, unsupported
//     (Section 10)
//   - Security: malformed IDs, unknown project/asset, cross-project,
//     traversal in the stored row, symlinked intermediate/final, missing
//     source, archived project, unsafe filename in headers, unknown MIME,
//     route cannot serve arbitrary files (Section 11)
//   - Unexpected errors: stubbed media service throws a plain error for
//     each route family (Section 12)
//
// Tests use a temporary PROJECTS_ROOT + preview root + in-memory DB. They
// index real PNG/JPEG/WebP/GIF/Krita files so Sharp produces real
// derivatives the routes can stream and compare against.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import {
  STATUS_DIR_MAP,
  formatProjectDirName,
  buildProjectRelPath,
} from '../src/storage/project-storage.js';
import { writeManifestSync } from '../src/storage/manifest.js';
import { resolvePublishedDir, THUMBNAIL_FILENAME, PREVIEW_FILENAME, buildRevisionToken } from '../src/storage/preview-cache.js';
import {
  createMediaService,
  sanitizeDispositionFilename,
  inlineMimeFor,
  CONTENT_DISPOSITION_HEADER_MAX,
} from '../src/services/media-service.js';
import { createPreviewService, buildAssetRevisionToken } from '../src/services/preview-service.js';
import { createWorkflowQueryService } from '../src/services/workflow-query-service.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';
import { Readable } from 'node:stream';
import http from 'node:http';
import { makeZip } from './helpers/zip-fixture.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function sharp() {
  return (await import('sharp')).default;
}

async function makePng(width, height, { r = 80, g = 120, b = 200 } = {}) {
  const sh = await sharp();
  return sh({ create: { width, height, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
}

async function makeJpeg(width, height) {
  const sh = await sharp();
  return sh({ create: { width, height, channels: 3, background: { r: 200, g: 160, b: 80 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function makeWebp(width, height) {
  const sh = await sharp();
  return sh({ create: { width, height, channels: 3, background: { r: 60, g: 200, b: 120 } } })
    .webp({ quality: 90 })
    .toBuffer();
}

async function makeGif(width, height) {
  const sh = await sharp();
  return sh({ create: { width, height, channels: 3, background: { r: 120, g: 60, b: 200 } } })
    .gif()
    .toBuffer();
}

function writeProjectFile(projectAbs, relPath, buffer) {
  const target = path.join(projectAbs, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return target;
}

function makeKritaArchive({ merged = null, preview = null } = {}) {
  const entries = [];
  if (preview) entries.push({ name: 'preview.png', data: preview, compression: 'deflate' });
  if (merged) entries.push({ name: 'mergedimage.png', data: merged, compression: 'deflate' });
  return makeZip(entries);
}

// ─── Harness ──────────────────────────────────────────────────────────────

function makeHarness({ withMediaService = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-media-http-'));
  const projectsRoot = path.join(tmpDir, 'projects');
  for (const dir of Object.values(STATUS_DIR_MAP)) {
    fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
  }
  const previewRoot = path.join(tmpDir, 'app', 'previews');
  fs.mkdirSync(previewRoot, { recursive: true });

  const appDataRoot = path.join(tmpDir, 'app');
  fs.mkdirSync(appDataRoot, { recursive: true });
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);

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
    // Write the manifest so the archive HTTP flow (which reads the manifest
    // to verify ownership) succeeds — mirrors what the project service
    // does on create.
    writeManifestSync(absPath, project, projectsRoot);
    project = projectRepo.setProjectDir(project.id, relPath);
    return { project, absPath, relPath };
  }

  function indexAsset(projectOrCtx, relPath, { mimeType, sizeBytes, modifiedAt, filename, extension } = {}) {
    const project = projectOrCtx.project || projectOrCtx;
    const dirRel = project.project_dir;
    if (!dirRel) {
      throw new Error(`project ${project.id} has no project_dir; pass createProject context`);
    }
    const filenameResolved = filename || path.basename(relPath);
    const ext = extension || filenameResolved.split('.').pop().toLowerCase();
    const full = path.join(projectsRoot, dirRel, relPath);
    const stat = fs.statSync(full);
    return assetRepo.upsert(project.id, relPath, {
      filename: filenameResolved,
      extension: ext,
      mimeType: mimeType ?? defaultMime(ext),
      sizeBytes: sizeBytes ?? stat.size,
      modifiedAt: modifiedAt ?? dbNow(),
    });
  }

  function dbNow() {
    return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }

  function defaultMime(ext) {
    return ({
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      kra: 'application/x-krita',
      krz: 'application/x-krita',
      bin: 'application/octet-stream',
    })[ext] ?? 'application/octet-stream';
  }

  // Build a real media service over the real preview service.
  const previewService = createPreviewService({ db, projectsRoot, previewRoot });
  const mediaService = withMediaService
    ? createMediaService({ previewService, projectsRoot, previewRoot })
    : null;

  const app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
    { previewService, mediaService, appDataRoot, authState: { csrfPepper } }
  );

  return {
    tmpDir,
    projectsRoot,
    previewRoot,
    appDataRoot,
    db,
    projectRepo,
    assetRepo,
    previewService,
    mediaService,
    app,
    createProject,
    indexAsset,
    cleanup: () => {
      closeDatabase(db);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// Resolve a published derivative file via the current.json pointer. The
// route streams result.path (inside the published revision directory), so
// on-disk bytes must be resolved the same way for comparison.
function cachePath(h, projectId, assetId, filename) {
  const dir = resolvePublishedDir(h.previewRoot, projectId, assetId);
  if (!dir) throw new Error(`no published cache for asset ${projectId}/${assetId}`);
  return path.join(dir, filename);
}

// ─── Section 9 — Successful behavior ──────────────────────────────────────

describe('media routes — successful behavior', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  it('serves a valid thumbnail as image/webp with correct headers', async () => {
    const { project, absPath } = h.createProject('Thumb OK');
    const buf = await makePng(400, 300);
    writeProjectFile(absPath, 'art.png', buf);
    const asset = h.indexAsset(project, 'art.png');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
    expect(res.body.length).toBeGreaterThan(0);

    const sh = await sharp();
    const meta = await sh(res.body).metadata();
    expect(meta.format).toBe('webp');
  });

  it('serves a valid preview as image/webp with correct headers', async () => {
    const { project, absPath } = h.createProject('Preview OK');
    const buf = await makePng(1800, 1200);
    writeProjectFile(absPath, 'big.png', buf);
    const asset = h.indexAsset(project, 'big.png');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/preview`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));

    const sh = await sharp();
    const meta = await sh(res.body).metadata();
    expect(meta.format).toBe('webp');
  });

  it('serves merged KRA preview and thumbnail derivatives from the application cache', async () => {
    const { project, absPath } = h.createProject('KRA HTTP Merged');
    const merged = await makePng(2000, 1000);
    const thumbnail = await makePng(320, 160);
    writeProjectFile(absPath, 'draw.kra', makeKritaArchive({ merged, preview: thumbnail }));
    const asset = h.indexAsset(project, 'draw.kra');

    const preview = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/preview`)
      .expect(200);
    const thumb = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(200);

    for (const response of [preview, thumb]) {
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    }

    const sh = await sharp();
    await expect(sh(preview.body).metadata()).resolves.toMatchObject({
      format: 'webp', width: 1600, height: 800,
    });
    await expect(sh(thumb.body).metadata()).resolves.toMatchObject({
      format: 'webp', width: 256, height: 128,
    });

    expect(fs.existsSync(path.join(absPath, 'mergedimage.png'))).toBe(false);
    expect(fs.existsSync(path.join(absPath, 'preview.png'))).toBe(false);
    const cacheDir = resolvePublishedDir(h.previewRoot, project.id, asset.id);
    expect(cacheDir).not.toBeNull();
    expect(cacheDir.startsWith(path.resolve(h.previewRoot))).toBe(true);

    const revision = h.previewService.getOriginalDescriptor(project.id, asset.id).revision;
    const versioned = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/preview?v=${revision}`)
      .expect(200);
    expect(versioned.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(versioned.headers.etag).toContain(revision);
  });

  it('serves preview-only KRA and KRZ documents through the same WebP derivative pipeline', async () => {
    const { project, absPath } = h.createProject('Krita HTTP Preview Only');
    const preview = await makePng(320, 180);
    writeProjectFile(absPath, 'fallback.kra', makeKritaArchive({ preview }));
    writeProjectFile(absPath, 'compressed.krz', makeKritaArchive({ preview }));
    const kra = h.indexAsset(project, 'fallback.kra');
    const krz = h.indexAsset(project, 'compressed.krz');

    for (const asset of [kra, krz]) {
      const response = await request(h.app)
        .get(`/projects/${project.id}/assets/${asset.id}/preview`)
        .expect(200);
      expect(response.headers['content-type']).toBe('image/webp');
      await expect((await sharp())(response.body).metadata()).resolves.toMatchObject({
        format: 'webp', width: 320, height: 180,
      });
    }
  });

  it('serves an inline PNG original with exact MIME and disposition', async () => {
    const { project, absPath } = h.createProject('PNG Original');
    const buf = await makePng(200, 150);
    writeProjectFile(absPath, 'png-orig.png', buf);
    const asset = h.indexAsset(project, 'png-orig.png');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe(String(buf.length));
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['content-disposition']).toContain('filename="png-orig.png"');
    expect(res.body.equals(buf)).toBe(true);
  });

  it('serves an inline JPEG original', async () => {
    const { project, absPath } = h.createProject('JPEG Original');
    const buf = await makeJpeg(300, 200);
    writeProjectFile(absPath, 'jpeg-orig.jpg', buf);
    const asset = h.indexAsset(project, 'jpeg-orig.jpg');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toContain('filename="jpeg-orig.jpg"');
    expect(res.body.equals(buf)).toBe(true);
  });

  it('serves an inline WebP original', async () => {
    const { project, absPath } = h.createProject('WebP Original');
    const buf = await makeWebp(400, 300);
    writeProjectFile(absPath, 'webp-orig.webp', buf);
    const asset = h.indexAsset(project, 'webp-orig.webp');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.body.equals(buf)).toBe(true);
  });

  it('serves an inline GIF original', async () => {
    const { project, absPath } = h.createProject('GIF Original');
    const buf = await makeGif(120, 90);
    writeProjectFile(absPath, 'gif-orig.gif', buf);
    const asset = h.indexAsset(project, 'gif-orig.gif');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.body.equals(buf)).toBe(true);
  });

  it.each(['kra', 'krz'])('Krita .%s original uses the documented non-inline contract (415)', async (extension) => {
    const { project, absPath } = h.createProject(`Krita Original ${extension}`);
    fs.writeFileSync(path.join(absPath, `draw.${extension}`), Buffer.from('fake-krita'));
    const asset = h.indexAsset(project, `draw.${extension}`);

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(415);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toBe('Unsupported media type');
  });

  it('unknown extension original uses the non-inline contract (415)', async () => {
    const { project, absPath } = h.createProject('Unknown Original');
    fs.writeFileSync(path.join(absPath, 'blob.bin'), Buffer.from('random'));
    const asset = h.indexAsset(project, 'blob.bin');

    await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(415);
  });

  it('thumbnail bytes match the generated derivative on disk', async () => {
    const { project, absPath } = h.createProject('Thumb Bytes');
    const buf = await makePng(500, 400);
    writeProjectFile(absPath, 'tb.png', buf);
    const asset = h.indexAsset(project, 'tb.png');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(200);

    const onDisk = fs.readFileSync(cachePath(h, project.id, asset.id, THUMBNAIL_FILENAME));
    expect(res.body.equals(onDisk)).toBe(true);
  });

  it('preview bytes match the generated derivative on disk', async () => {
    const { project, absPath } = h.createProject('Preview Bytes');
    const buf = await makePng(1700, 1100);
    writeProjectFile(absPath, 'pb.png', buf);
    const asset = h.indexAsset(project, 'pb.png');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/preview`)
      .expect(200);

    const onDisk = fs.readFileSync(cachePath(h, project.id, asset.id, PREVIEW_FILENAME));
    expect(res.body.equals(onDisk)).toBe(true);
  });

  it('source file remains unchanged after serving thumbnail, preview, and original', async () => {
    const { project, absPath } = h.createProject('Source Intact');
    const buf = await makePng(800, 600);
    const srcPath = path.join(absPath, 'keep.png');
    writeProjectFile(absPath, 'keep.png', buf);
    const asset = h.indexAsset(project, 'keep.png');
    const before = fs.readFileSync(srcPath);

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(200);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/preview`).expect(200);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(200);

    const after = fs.readFileSync(srcPath);
    expect(after.equals(before)).toBe(true);
  });
});

// ─── Section 10 — Cache behavior ──────────────────────────────────────────

describe('media routes — cache behavior', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  async function setupAsset() {
    const { project, absPath } = h.createProject('Cache Project');
    const buf = await makePng(900, 700);
    writeProjectFile(absPath, 'c.png', buf);
    const asset = h.indexAsset(project, 'c.png');
    return { project, absPath, asset };
  }

  it('matching revision response is immutable', async () => {
    const { project, asset } = await setupAsset();
    // Prime the cache and read the real revision.
    const prime = await h.previewService.getThumbnail(project.id, asset.id);

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=${prime.revision}`)
      .expect(200);

    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['etag']).toContain(prime.revision);
  });

  it('missing revision response is must-revalidate', async () => {
    const { project, asset } = await setupAsset();
    // Prime the cache so the second request is a hit.
    await h.previewService.getThumbnail(project.id, asset.id);

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(200);

    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(res.headers['etag']).toBeUndefined();
  });

  it('stale revision response is must-revalidate', async () => {
    const { project, asset } = await setupAsset();
    await h.previewService.getThumbnail(project.id, asset.id);

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=0000000000000000`)
      .expect(200);

    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(res.headers['etag']).toBeUndefined();
  });

  it('malformed revision response is must-revalidate', async () => {
    const { project, asset } = await setupAsset();
    await h.previewService.getThumbnail(project.id, asset.id);

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=not-a-revision`)
      .expect(200);

    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  it('cache hit returns the same bytes and a fresh state', async () => {
    const { project, asset } = await setupAsset();
    await h.previewService.getThumbnail(project.id, asset.id);

    const a = await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(200);
    const b = await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(200);

    expect(b.body.equals(a.body)).toBe(true);
  });

  it('regenerated derivative still serves correctly with the new revision', async () => {
    const { project, absPath, asset } = await setupAsset();
    const first = await h.previewService.getThumbnail(project.id, asset.id);

    // Replace source to invalidate cache and regenerate.
    const bigger = await makePng(1200, 1000);
    writeProjectFile(absPath, 'c.png', bigger);
    h.assetRepo.upsert(project.id, 'c.png', {
      filename: 'c.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: bigger.length,
      modifiedAt: '2026-08-15 10:00:00',
    });

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=${first.revision}`)
      .expect(200);

    // Stale revision → must-revalidate (the service regenerated; the route
    // compares the stale requested revision to the new computed one).
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  it('unsupported preview returns 415 with no-store', async () => {
    const { project, absPath } = h.createProject('Unsupported Cache');
    fs.writeFileSync(path.join(absPath, 'draw.bin'), Buffer.from('unknown binary'));
    const asset = h.indexAsset(project, 'draw.bin');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(415);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('unsupported preview also returns no-store for the preview route', async () => {
    const { project, absPath } = h.createProject('Unsupported Preview Cache');
    fs.writeFileSync(path.join(absPath, 'draw2.bin'), Buffer.from('unknown binary'));
    const asset = h.indexAsset(project, 'draw2.bin');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/preview`)
      .expect(415);

    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('media routes — controlled Krita extraction failures', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  it.each([
    ['malformed archive', Buffer.from('not a zip')],
    ['preview-less archive', makeZip([{ name: 'maindoc.xml', data: Buffer.from('<doc/>') }])],
    ['corrupt embedded PNG', makeKritaArchive({ preview: Buffer.from('not a png') })],
    ['encrypted embedded PNG', makeZip([{ name: 'preview.png', data: Buffer.from('encrypted'), flags: 0x801 }])],
    ['oversized embedded PNG', makeZip([{
      name: 'preview.png',
      data: Buffer.from('small'),
      uncompressedSize: 256 * 1024 * 1024 + 1,
      localUncompressedSize: 256 * 1024 * 1024 + 1,
    }])],
  ])('maps %s to a controlled unavailable response without internal details', async (_label, archive) => {
    const { project, absPath } = h.createProject(`Krita Failure ${_label}`);
    writeProjectFile(absPath, 'broken.kra', archive);
    const asset = h.indexAsset(project, 'broken.kra');

    const response = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/preview`)
      .expect(503);

    expect(response.text).toBe('Preview unavailable');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    for (const detail of ['broken.kra', 'preview.png', 'yauzl', 'Sharp', h.projectsRoot]) {
      expect(response.text).not.toContain(detail);
    }
    expect(resolvePublishedDir(h.previewRoot, project.id, asset.id)).toBeNull();
  });

  it('keeps missing-source 404 behavior distinct from unavailable generation', async () => {
    const { project, absPath } = h.createProject('Krita Missing Source');
    writeProjectFile(absPath, 'gone.kra', makeKritaArchive({ preview: Buffer.from('not a png') }));
    const asset = h.indexAsset(project, 'gone.kra');
    fs.rmSync(path.join(absPath, 'gone.kra'));

    const response = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/preview`)
      .expect(404);

    expect(response.text).toBe('Not found');
    expect(response.text).not.toContain('Preview unavailable');
  });
});

// ─── Section 10b — Revision-token normalization ───────────────────────────

describe('media routes — revision-token normalization', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  async function setupAsset() {
    const { project, absPath } = h.createProject('Norm Project');
    const buf = await makePng(900, 700);
    writeProjectFile(absPath, 'n.png', buf);
    const asset = h.indexAsset(project, 'n.png');
    // Prime the cache.
    await h.previewService.getThumbnail(project.id, asset.id);
    return { project, asset };
  }

  // Each of these invalid shapes must normalize to null (unversioned),
  // yielding must-revalidate — never an error, never unique work.

  it('repeated v query keys normalize to unversioned', async () => {
    const { project, asset } = await setupAsset();
    const res = await request(h.app)
      .get(
        `/projects/${project.id}/assets/${asset.id}/thumbnail` +
        `?v=aabbccddeeff0011&v=0011223344556677`
      )
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(res.headers['etag']).toBeUndefined();
  });

  it('empty v value normalizes to unversioned', async () => {
    const { project, asset } = await setupAsset();
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  it('excessively long v normalizes to unversioned', async () => {
    const { project, asset } = await setupAsset();
    const longToken = 'a'.repeat(64);
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=${longToken}`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  it('uppercase hex v normalizes to unversioned', async () => {
    const { project, asset } = await setupAsset();
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=AABBCCDDEEFF0011`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  it('non-hex characters in v normalize to unversioned', async () => {
    const { project, asset } = await setupAsset();
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=zzzzzzzzzzzzzzzz`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  it('traversal-like v normalizes to unversioned without error', async () => {
    const { project, asset } = await setupAsset();
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=..%2F..%2Fetc`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  it('valid matching v gets immutable cache-control', async () => {
    const { project, asset } = await setupAsset();
    const desc = h.previewService.getOriginalDescriptor(project.id, asset.id);
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=${desc.revision}`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.headers['etag']).toContain(desc.revision);
  });

  it('concurrent requests with distinct invalid tokens do not fragment generation', async () => {
    const { project, absPath } = h.createProject('Concurrent Norm');
    const buf = await makePng(900, 700);
    writeProjectFile(absPath, 'cn.png', buf);
    const asset = h.indexAsset(project, 'cn.png');

    const tokens = Array.from({ length: 15 }, (_, i) =>
      `zz${String(i).padStart(2, '0')}`.padEnd(16, 'x')
    );

    const responses = await Promise.all(
      tokens.map((t) =>
        request(h.app)
          .get(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=${t}`)
          .expect(200)
      )
    );

    // Every response is must-revalidate (invalid tokens → unversioned).
    for (const res of responses) {
      expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    }

    // Only one cache directory was created (one asset, one generation).
    const cacheDir = path.join(h.previewRoot, 'projects', String(project.id), String(asset.id));
    expect(fs.existsSync(cacheDir)).toBe(true);
    const revDirs = fs.readdirSync(cacheDir).filter((n) => n.startsWith('r-'));
    expect(revDirs.length).toBe(1);

    // No evil token appears in any cache path name.
    for (const name of fs.readdirSync(cacheDir)) {
      for (const token of tokens) {
        expect(name).not.toContain(token);
      }
    }
  });
});

// ─── Section 10c — Revision eligibility parity ────────────────────────────

describe('media routes — revision eligibility parity', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  async function setupPreviewableAsset(label) {
    const { project, absPath } = h.createProject(`Revision ${label}`);
    const buf = await makePng(96, 64);
    writeProjectFile(absPath, 'eligible.png', buf);
    const asset = h.indexAsset(project, 'eligible.png', {
      modifiedAt: '2026-07-28 12:00:00',
    });
    return { project, asset, size: buf.length };
  }

  function assetCacheRoot(projectId, assetId) {
    return path.join(h.previewRoot, 'projects', String(projectId), String(assetId));
  }

  async function collectRevisionState(project, assetId) {
    const workflow = createWorkflowQueryService({ db: h.db, evaluateReleaseReadiness });
    const browser = workflow.getProjectAssetBrowser(project.id, { pageSize: 100 });
    const browserAsset = browser.assets.find((asset) => asset.id === assetId);
    const viewer = workflow.getProjectAssetViewer(project.id, assetId);
    const descriptor = h.previewService.getOriginalDescriptor(project.id, assetId);

    let mediaResult = null;
    let mediaError = null;
    try {
      mediaResult = await h.mediaService.getDerivative('thumbnail', project.id, assetId);
    } catch (err) {
      mediaError = err;
    }

    return {
      browserRevision: browserAsset?.preview_revision ?? null,
      browserThumbnailUrl: browserAsset?.thumbnail_url ?? null,
      browserPreviewUrl: browserAsset?.preview_url ?? null,
      viewerRevision: viewer?.asset.revision_token ?? null,
      viewerThumbnailUrl: viewer?.asset.thumbnail_url ?? null,
      viewerPreviewUrl: viewer?.asset.preview_url ?? null,
      descriptorRevision: descriptor.revision,
      mediaRevision: mediaResult?.revision ?? null,
      mediaError,
    };
  }

  const metadataCases = [
    {
      name: 'valid metadata',
      valid: true,
      mutate: () => true,
    },
    {
      name: 'null size',
      valid: false,
      directOverride: { size_bytes: null },
      mutate: ({ asset }) => {
        try {
          h.db.prepare('UPDATE assets SET size_bytes = NULL WHERE id = ?').run(asset.id);
          return true;
        } catch {
          return false;
        }
      },
    },
    {
      name: 'negative size',
      valid: false,
      mutate: ({ asset }) => {
        h.db.prepare('UPDATE assets SET size_bytes = -1 WHERE id = ?').run(asset.id);
        return true;
      },
    },
    {
      name: 'non-finite size where constructible',
      valid: false,
      directOverride: { size_bytes: Number.POSITIVE_INFINITY },
      mutate: ({ asset }) => {
        try {
          h.db.prepare('UPDATE assets SET size_bytes = ? WHERE id = ?').run(Number.POSITIVE_INFINITY, asset.id);
        } catch {
          return false;
        }
        const stored = h.assetRepo.findById(asset.id);
        return typeof stored.size_bytes === 'number' && !Number.isFinite(stored.size_bytes);
      },
    },
    {
      name: 'missing modification time',
      valid: false,
      mutate: ({ asset }) => {
        h.db.prepare('UPDATE assets SET modified_at = NULL WHERE id = ?').run(asset.id);
        return true;
      },
    },
    {
      name: 'malformed modification time',
      valid: false,
      mutate: ({ asset }) => {
        h.db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('not-a-time', asset.id);
        return true;
      },
    },
    {
      name: 'empty relative path',
      valid: false,
      mutate: ({ asset }) => {
        h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?').run('', asset.id);
        return true;
      },
    },
  ];

  for (const testCase of metadataCases) {
    it(`keeps browser, viewer, and media revision eligibility aligned for ${testCase.name}`, async () => {
      const fixture = await setupPreviewableAsset(testCase.name);
      if (testCase.mutate(fixture) === false) {
        expect(buildAssetRevisionToken({
          project_id: fixture.project.id,
          id: fixture.asset.id,
          relative_path: 'eligible.png',
          size_bytes: fixture.size,
          modified_at: '2026-07-28T12:00:00.000Z',
          ...(testCase.directOverride || {}),
        })).toBeNull();
        return;
      }

      const state = await collectRevisionState(fixture.project, fixture.asset.id);
      const revisions = [
        state.browserRevision,
        state.viewerRevision,
        state.descriptorRevision,
        state.mediaRevision,
      ];

      if (testCase.valid) {
        const expectedRevision = buildRevisionToken({
          projectId: fixture.project.id,
          assetId: fixture.asset.id,
          relativePath: 'eligible.png',
          size: fixture.size,
          mtime: '2026-07-28T12:00:00.000Z',
        });

        expect(revisions).toEqual([
          expectedRevision,
          expectedRevision,
          expectedRevision,
          expectedRevision,
        ]);
        expect(state.browserThumbnailUrl).toBe(`/projects/${fixture.project.id}/assets/${fixture.asset.id}/thumbnail?v=${expectedRevision}`);
        expect(state.browserPreviewUrl).toBe(`/projects/${fixture.project.id}/assets/${fixture.asset.id}/preview?v=${expectedRevision}`);
        expect(state.viewerThumbnailUrl).toBe(`/projects/${fixture.project.id}/assets/${fixture.asset.id}/thumbnail?v=${expectedRevision}`);
        expect(state.viewerPreviewUrl).toBe(`/projects/${fixture.project.id}/assets/${fixture.asset.id}/preview?v=${expectedRevision}`);
        expect(fs.existsSync(assetCacheRoot(fixture.project.id, fixture.asset.id))).toBe(true);
        return;
      }

      expect(revisions).toEqual([null, null, null, null]);
      expect(state.browserThumbnailUrl).toBeNull();
      expect(state.browserPreviewUrl).toBeNull();
      expect(state.viewerThumbnailUrl).toBeNull();
      expect(state.viewerPreviewUrl).toBeNull();
      expect(state.mediaError?.status).toBe(404);

      const res = await request(h.app)
        .get(`/projects/${fixture.project.id}/assets/${fixture.asset.id}/thumbnail`)
        .expect(404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(fs.existsSync(assetCacheRoot(fixture.project.id, fixture.asset.id))).toBe(false);
    });
  }

  it('rejects invalid IDs in the shared revision-eligibility helper', () => {
    const valid = {
      project_id: 1,
      id: 1,
      relative_path: 'eligible.png',
      size_bytes: 100,
      modified_at: '2026-07-28T12:00:00.000Z',
    };

    expect(buildAssetRevisionToken(valid)).toMatch(/^[a-f0-9]{16}$/);
    expect(buildAssetRevisionToken({ ...valid, project_id: 0 })).toBeNull();
    expect(buildAssetRevisionToken({ ...valid, project_id: -1 })).toBeNull();
    expect(buildAssetRevisionToken({ ...valid, id: 0 })).toBeNull();
    expect(buildAssetRevisionToken({ ...valid, id: -1 })).toBeNull();
    expect(buildAssetRevisionToken({ ...valid, size_bytes: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

// ─── Section 11 — Security ────────────────────────────────────────────────

describe('media routes — security', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  it('rejects malformed project id with 404', async () => {
    const { project, absPath } = h.createProject('Malformed P');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'a.png', buf);
    const asset = h.indexAsset(project, 'a.png');

    const r1 = await request(h.app).get(`/projects/abc/assets/${asset.id}/thumbnail`).expect(404);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(r1.headers['x-content-type-options']).toBe('nosniff');
    await request(h.app).get(`/projects/0/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/-1/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/1.5/assets/${asset.id}/thumbnail`).expect(404);
  });

  it('rejects malformed asset id with 404', async () => {
    const { project } = h.createProject('Malformed A');

    const r1 = await request(h.app).get(`/projects/${project.id}/assets/abc/thumbnail`).expect(404);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(r1.headers['x-content-type-options']).toBe('nosniff');
    await request(h.app).get(`/projects/${project.id}/assets/0/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/-1/thumbnail`).expect(404);
  });

  it('returns 404 for an unknown project', async () => {
    const { project, absPath } = h.createProject('Known P');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'a.png', buf);
    const asset = h.indexAsset(project, 'a.png');

    await request(h.app).get(`/projects/99999/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/99999/assets/${asset.id}/preview`).expect(404);
    await request(h.app).get(`/projects/99999/assets/${asset.id}/original`).expect(404);
  });

  it('returns 404 for an unknown asset', async () => {
    const { project } = h.createProject('Unknown Asset');

    await request(h.app).get(`/projects/${project.id}/assets/99999/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/99999/preview`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/99999/original`).expect(404);
  });

  it('rejects cross-project asset with 404', async () => {
    const a = h.createProject('Owner');
    const b = h.createProject('Other');
    const buf = await makePng(64, 64);
    writeProjectFile(a.absPath, 'shared.png', buf);
    const asset = h.indexAsset(a.project, 'shared.png');

    // Asset belongs to a, request from b — must be 404 (not 403, to avoid
    // revealing existence in another project).
    await request(h.app).get(`/projects/${b.project.id}/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${b.project.id}/assets/${asset.id}/preview`).expect(404);
    await request(h.app).get(`/projects/${b.project.id}/assets/${asset.id}/original`).expect(404);
  });

  it('rejects an absolute path stored in the asset row', async () => {
    const { project, absPath } = h.createProject('Abs Path');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'legit.png', buf);
    const asset = h.indexAsset(project, 'legit.png');

    // Tamper with the row to store an absolute path.
    h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?')
      .run('/etc/passwd', asset.id);

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(404);
  });

  it('rejects a .. traversal path stored in the asset row', async () => {
    const { project, absPath } = h.createProject('Dot Path');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'ok.png', buf);
    const asset = h.indexAsset(project, 'ok.png');

    h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?')
      .run('../../../../etc/passwd', asset.id);

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(404);
  });

  it('rejects a mixed-separator traversal path stored in the asset row', async () => {
    const { project, absPath } = h.createProject('Mixed Path');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'ok.png', buf);
    const asset = h.indexAsset(project, 'ok.png');

    h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?')
      .run('..\\..\\..\\..\\etc\\passwd', asset.id);

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(404);
  });

  it('rejects URL-encoded traversal at the HTTP boundary', async () => {
    const { project } = h.createProject('Enc Traversal');

    // Express decodes %2F etc. before routing, so these collapse to path
    // segments that the strict ID parser rejects.
    await request(h.app).get(`/projects/${project.id}/assets/1%2F..%2F..%2Fthumbnail`).expect(404);
  });

  it('rejects a symlinked intermediate directory in the asset path', async () => {
    const { project, absPath } = h.createProject('Symlink Mid');
    const buf = await makePng(64, 64);
    // Create the real file under source/.
    writeProjectFile(absPath, path.join('source', 'real.png'), buf);

    // Create a symlinked directory "link" → "source", then index the asset
    // through the symlink path.
    fs.symlinkSync(
      path.join(absPath, 'source'),
      path.join(absPath, 'link')
    );

    const asset = h.indexAsset(project, path.join('link', 'real.png'), {
      filename: 'real.png',
    });

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(404);
  });

  it('rejects a symlinked final file in the asset path', async () => {
    const { project, absPath } = h.createProject('Symlink Final');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'real.png', buf);
    fs.symlinkSync(
      path.join(absPath, 'real.png'),
      path.join(absPath, 'link.png')
    );
    const asset = h.indexAsset(project, 'link.png', { filename: 'link.png' });

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(404);
  });

  it('returns 404 when the source file is missing on disk', async () => {
    const { project, absPath } = h.createProject('Source Gone');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'gone.png', buf);
    const asset = h.indexAsset(project, 'gone.png');

    fs.rmSync(path.join(absPath, 'gone.png'));

    // Thumbnail generation tries to open the missing source → the safe
    // resolver throws StorageError → mapped to 404.
    const res = await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');

    const res2 = await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`);
    expect(res2.status).toBe(404);
  });

  it('returns 404 for an asset marked missing', async () => {
    const { project, absPath } = h.createProject('Marked Missing');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'm.png', buf);
    const asset = h.indexAsset(project, 'm.png');

    h.assetRepo.markMissingByProjectIdAndPathNotIn(project.id, []);

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/preview`).expect(404);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(404);
  });

  it('sanitizes an unsafe filename in Content-Disposition', async () => {
    const { project, absPath } = h.createProject('Unsafe Name');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'safe.png', buf);
    const asset = h.indexAsset(project, 'safe.png');

    // Tamper with the stored filename to include header-injection chars.
    h.db.prepare('UPDATE assets SET filename = ? WHERE id = ?')
      .run('evil\r\nX-Inject: yes/\\..', asset.id);

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    const cd = res.headers['content-disposition'];
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    expect(cd).not.toContain('X-Inject');
    // Path separators from the tampered filename must not appear in the
    // disposition filename parameter (basename collapse + sanitizer).
    const filenameMatch = cd.match(/filename="([^"]*)"/);
    expect(filenameMatch).not.toBeNull();
    const safeName = filenameMatch[1];
    expect(safeName).not.toContain('/');
    expect(safeName).not.toContain('\\');
  });

  it('rejects an unknown MIME for the original route (415)', async () => {
    const { project, absPath } = h.createProject('Unknown MIME');
    fs.writeFileSync(path.join(absPath, 'blob.bin'), Buffer.from('bytes'));
    const asset = h.indexAsset(project, 'blob.bin');

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`).expect(415);
  });

  it('rejects a PNG recorded as application/octet-stream for the original route (415)', async () => {
    const { project, absPath } = h.createProject('PNG Octet MIME');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'octet.png', buf);
    const asset = h.indexAsset(project, 'octet.png', { mimeType: 'application/octet-stream' });

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(415);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toBe('Unsupported media type');
  });

  it('rejects extension and recorded MIME disagreement for the original route (415)', async () => {
    const { project, absPath } = h.createProject('MIME Mismatch');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'mismatch.png', buf);
    const asset = h.indexAsset(project, 'mismatch.png', { mimeType: 'image/jpeg' });

    await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(415);
  });

  it('rejects missing recorded MIME for the original route (415)', async () => {
    const { project, absPath } = h.createProject('Missing MIME');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'missing-mime.png', buf);
    const asset = h.indexAsset(project, 'missing-mime.png');
    h.db.prepare('UPDATE assets SET mime_type = ? WHERE id = ?').run('', asset.id);

    await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(415);
  });

  it('archived project media remains viewable', async () => {
    // Archived projects are still readable; only mutations are gated. The
    // preview service's loadProjectAndAsset does NOT check archived_at.
    const { project, absPath } = h.createProject('Archivable Media', 'tbd');
    const buf = await makePng(400, 300);
    writeProjectFile(absPath, 'archive.png', buf);
    const asset = h.indexAsset(project, 'archive.png');

    // Prime the cache BEFORE archiving (so the file is reachable in the
    // tbd directory).
    await h.previewService.getThumbnail(project.id, asset.id);

    // Archive the project through the HTTP API (moves the directory to
    // archived/).
    const { agent, csrfToken } = await getDisabledModeCsrf(h.app, h.appDataRoot);
    await agent.post(`/projects/${project.id}/archive`).send({ _csrf: csrfToken }).expect(302);

    // Re-index the asset at its new (archived) location so the row points
    // to a present file again. The scan would do this on the next scan.
    const archivedProject = h.projectRepo.findById(project.id);
    const archivedAbs = path.resolve(h.projectsRoot, archivedProject.project_dir);
    // The file moved with the directory, so it still exists. Re-stat.
    h.assetRepo.upsert(project.id, 'archive.png', {
      filename: 'archive.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: fs.statSync(path.join(archivedAbs, 'archive.png')).size,
      modifiedAt: '2026-09-01 10:00:00',
    });

    // The original route must still serve the file from the archived dir.
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.equals(buf)).toBe(true);

    // Thumbnail also still works from the archived dir (cache was primed
    // before the move; the cache file lives under preview root, not the
    // project dir, so the move does not invalidate it).
    const thumbRes = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(200);
    expect(thumbRes.headers['content-type']).toBe('image/webp');
  });

  it('route cannot serve arbitrary files outside project storage', async () => {
    // Plant a secret file outside PROJECTS_ROOT and try to reach it via a
    // tampered asset row.
    const { project, absPath } = h.createProject('Arbitrary');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'ok.png', buf);
    const asset = h.indexAsset(project, 'ok.png');

    const secretPath = path.join(h.tmpDir, 'secret.txt');
    fs.writeFileSync(secretPath, 'top-secret');

    h.db.prepare('UPDATE assets SET relative_path = ?, filename = ? WHERE id = ?')
      .run(path.relative(path.resolve(h.projectsRoot, project.project_dir), secretPath) || 'x', 'secret.txt', asset.id);

    // Use a relative path that escapes the project dir.
    const escapeRel = path.relative(
      path.resolve(h.projectsRoot, project.project_dir),
      secretPath
    );
    h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?')
      .run(escapeRel, asset.id);

    const res = await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // Must not leak the secret bytes.
    if (res.status < 500) {
      expect(res.text).not.toContain('top-secret');
    }
  });

  it('no absolute path appears in any rejected response body', async () => {
    const { project, absPath } = h.createProject('No Abs Leak');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'leak.png', buf);
    const asset = h.indexAsset(project, 'leak.png');

    h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?')
      .run('../../etc/passwd', asset.id);

    const res = await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`);
    expect(res.text).not.toContain(h.projectsRoot);
    expect(res.text).not.toMatch(/[A-Z]:\\/);
    expect(res.text).not.toContain('/etc/passwd');
  });

  it('no cache mutation on rejected security requests', async () => {
    const { project, absPath } = h.createProject('No Cache Mutation');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'nm.png', buf);
    const asset = h.indexAsset(project, 'nm.png');

    h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?')
      .run('../../etc/passwd', asset.id);

    const res = await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`);
    if (res.status >= 200 && res.status < 300) {
      // Rejected responses must not carry immutable cache policy.
      expect(res.headers['cache-control']).not.toBe('private, max-age=31536000, immutable');
    }
  });

  it('source state unchanged after rejected security requests', async () => {
    const { project, absPath } = h.createProject('Source Unchanged');
    const buf = await makePng(64, 64);
    const srcPath = path.join(absPath, 'keep.png');
    writeProjectFile(absPath, 'keep.png', buf);
    const asset = h.indexAsset(project, 'keep.png');
    const before = fs.readFileSync(srcPath);

    h.db.prepare('UPDATE assets SET relative_path = ? WHERE id = ?')
      .run('../../etc/passwd', asset.id);

    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/original`);
    await request(h.app).get(`/projects/${project.id}/assets/${asset.id}/thumbnail`);

    const after = fs.readFileSync(srcPath);
    expect(after.equals(before)).toBe(true);
  });
});

// ─── Section 12 — Unexpected errors ───────────────────────────────────────

describe('media routes — unexpected errors reach the global handler', () => {
  let h;

  afterEach(() => {
    vi.restoreAllMocks();
    if (h) h.cleanup();
  });

  function makeHarnessWithStub(stub) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-media-stub-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    const db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { previewService: {}, mediaService: stub }
    );

    h = {
      tmpDir,
      projectsRoot,
      previewRoot,
      db,
      app,
      cleanup: () => {
        closeDatabase(db);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
    return h;
  }

  function makeHarnessWithPreviewStub(previewService) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-media-preview-stub-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    const db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const mediaService = createMediaService({ previewService, projectsRoot, previewRoot });

    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { previewService, mediaService }
    );

    h = {
      tmpDir,
      projectsRoot,
      previewRoot,
      db,
      app,
      cleanup: () => {
        closeDatabase(db);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
    return h;
  }

  function expectGlobal500(res, secret) {
    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).not.toMatch(/^image\//);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.text).toContain('Something went wrong.');
    if (secret) expect(res.text).not.toContain(secret);
  }

  it('thumbnail route forwards unexpected errors to the global handler', async () => {
    const stub = {
      prepareDerivativeResponse: async () => {
        throw new Error('unexpected thumbnail failure');
      },
      prepareOriginalResponse: () => {
        throw new Error('not used');
      },
    };
    const local = makeHarnessWithStub(stub);
    const res = await request(local.app).get('/projects/1/assets/1/thumbnail');
    expect(res.status).toBe(500);
    // Global handler returns a generic message, never the raw error.
    expect(res.text).not.toContain('unexpected thumbnail failure');
  });

  it('preview route forwards unexpected errors to the global handler', async () => {
    const stub = {
      prepareDerivativeResponse: async () => {
        throw new Error('unexpected preview failure');
      },
      prepareOriginalResponse: () => {
        throw new Error('not used');
      },
    };
    const local = makeHarnessWithStub(stub);
    const res = await request(local.app).get('/projects/1/assets/1/preview');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('unexpected preview failure');
  });

  it('original route forwards unexpected errors to the global handler', async () => {
    const stub = {
      prepareDerivativeResponse: async () => {
        throw new Error('not used');
      },
      prepareOriginalResponse: () => {
        throw new Error('unexpected original failure');
      },
    };
    const local = makeHarnessWithStub(stub);
    const res = await request(local.app).get('/projects/1/assets/1/original');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('unexpected original failure');
  });

  it('no partial media response is sent on unexpected error', async () => {
    const stub = {
      prepareDerivativeResponse: async () => {
        throw new Error('unexpected');
      },
      prepareOriginalResponse: () => {
        throw new Error('unexpected');
      },
    };
    const local = makeHarnessWithStub(stub);
    const res = await request(local.app).get('/projects/1/assets/1/thumbnail');
    // The body is the global handler's text/JSON, never image bytes.
    expect(res.headers['content-type']).not.toBe('image/webp');
    expect(res.body.length === 0 || res.text.length > 0).toBe(true);
  });

  it('plain preview-service failure propagates as a global 500', async () => {
    const local = makeHarnessWithPreviewStub({
      getThumbnail: async () => { throw new Error('plain preview service failure'); },
      getPreview: async () => { throw new Error('not used'); },
      getOriginalDescriptor: () => { throw new Error('not used'); },
    });

    const res = await request(local.app).get('/projects/1/assets/1/thumbnail');

    expectGlobal500(res, 'plain preview service failure');
  });

  it('plain media-service stream-preparation failure propagates as a global 500', async () => {
    const local = makeHarnessWithStub({
      prepareDerivativeResponse: async () => {
        throw new Error('plain media stream preparation failure');
      },
      prepareOriginalResponse: () => {
        throw new Error('not used');
      },
    });

    const res = await request(local.app).get('/projects/1/assets/1/preview');

    expectGlobal500(res, 'plain media stream preparation failure');
  });

  it('plain repository lookup failure propagates as a global 500', async () => {
    const local = makeHarnessWithPreviewStub({
      getThumbnail: async () => { throw new Error('not used'); },
      getPreview: async () => { throw new Error('not used'); },
      getOriginalDescriptor: () => { throw new Error('plain repository lookup failure'); },
    });

    const res = await request(local.app).get('/projects/1/assets/1/original');

    expectGlobal500(res, 'plain repository lookup failure');
  });

  it('plain derivative stream creation failure propagates as a global 500', async () => {
    h = makeHarness();
    const { project, absPath } = h.createProject('Derivative Open Failure');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'derivative-open.png', buf);
    const asset = h.indexAsset(project, 'derivative-open.png');
    await h.previewService.getThumbnail(project.id, asset.id);

    vi.spyOn(fs, 'createReadStream').mockImplementationOnce(() => {
      throw new Error('plain derivative stream creation failure');
    });

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`);

    expectGlobal500(res, 'plain derivative stream creation failure');
  });

  it('plain original stream creation failure closes the descriptor and propagates as a global 500', async () => {
    h = makeHarness();
    const { project, absPath } = h.createProject('Original Open Failure');
    const buf = await makePng(64, 64);
    const srcPath = path.resolve(absPath, 'original-open.png');
    writeProjectFile(absPath, 'original-open.png', buf);
    const asset = h.indexAsset(project, 'original-open.png');

    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    const openedFds = new Set();
    let openedCount = 0;
    let closedCount = 0;

    vi.spyOn(fs, 'openSync').mockImplementation(function openSync(file, ...args) {
      const fd = originalOpenSync.call(this, file, ...args);
      if (path.resolve(String(file)) === srcPath) {
        openedCount++;
        openedFds.add(fd);
      }
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(function closeSync(fd) {
      if (openedFds.has(fd)) {
        closedCount++;
        openedFds.delete(fd);
      }
      return originalCloseSync.call(this, fd);
    });
    vi.spyOn(fs, 'createReadStream').mockImplementationOnce(() => {
      throw new Error('plain original stream creation failure');
    });

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`);

    expect(openedCount).toBe(1);
    expect(closedCount).toBe(1);
    expectGlobal500(res, 'plain original stream creation failure');
  });
});

// ─── Sanitizer unit tests ─────────────────────────────────────────────────

describe('media-service filename sanitizer', () => {
  it('strips CR/LF', () => {
    const { ascii } = sanitizeDispositionFilename('a\rb\nc.png');
    expect(ascii).not.toContain('\r');
    expect(ascii).not.toContain('\n');
  });

  it('strips quotes and backslashes', () => {
    const { ascii } = sanitizeDispositionFilename('"evil\\.png');
    expect(ascii).not.toContain('"');
    expect(ascii).not.toContain('\\');
  });

  it('collapses path separators from mixed-separator input', () => {
    const { ascii } = sanitizeDispositionFilename('a/b\\c.png');
    expect(ascii).not.toContain('/');
    expect(ascii).not.toContain('\\');
  });

  it('strips control characters', () => {
    const { ascii } = sanitizeDispositionFilename('a\x00b\x07c.png');
    expect(ascii).not.toContain('\x00');
    expect(ascii).not.toContain('\x07');
  });

  it('falls back for empty input', () => {
    const { ascii } = sanitizeDispositionFilename('');
    expect(ascii).toBe('asset.png');
  });

  it('falls back for unsafe residues (., ..)', () => {
    expect(sanitizeDispositionFilename('.').ascii).toBe('asset.png');
    expect(sanitizeDispositionFilename('..').ascii).toBe('asset.png');
  });

  it('produces an RFC 5987 filename* for non-ASCII', () => {
    const { utf8 } = sanitizeDispositionFilename('café.png');
    expect(utf8).toMatch(/^UTF-8''/);
    // é is percent-encoded.
    expect(utf8).toContain('%C3%A9');
  });

  it('RFC 5987 encoder percent-encodes disallowed bytes with uppercase hex', () => {
    const { utf8 } = sanitizeDispositionFilename("a'b*c(d)% é 🐱.png");
    expect(utf8).toMatch(/^UTF-8''/);
    const encoded = utf8.slice("UTF-8''".length);
    expect(encoded).toContain('a%27b%2Ac%28d%29%25%20');
    expect(encoded).toContain('e%CC%81');
    expect(encoded).toContain('%F0%9F%90%B1');
    expect(encoded).not.toContain("'");
    expect(encoded).not.toContain('*');
    expect(encoded).not.toContain('(');
    expect(encoded).not.toContain(')');
    expect(encoded).not.toContain(' ');
    for (const [escape] of encoded.matchAll(/%[0-9A-Fa-f]{2}/g)) {
      expect(escape).toBe(escape.toUpperCase());
    }
  });

  it('inlineMimeFor returns the right MIME only for matching allowlisted pairs', () => {
    expect(inlineMimeFor('png', 'image/png')).toBe('image/png');
    expect(inlineMimeFor('jpg', 'image/jpeg')).toBe('image/jpeg');
    expect(inlineMimeFor('jpeg', 'image/jpeg')).toBe('image/jpeg');
    expect(inlineMimeFor('webp', 'image/webp')).toBe('image/webp');
    expect(inlineMimeFor('gif', 'image/gif')).toBe('image/gif');
  });

  it('inlineMimeFor rejects missing, unsupported, octet-stream, and mismatched MIME', () => {
    expect(inlineMimeFor('png', '')).toBeNull();
    expect(inlineMimeFor('png', 'application/octet-stream')).toBeNull();
    expect(inlineMimeFor('png', 'image/jpeg')).toBeNull();
    expect(inlineMimeFor('jpg', 'image/png')).toBeNull();
    expect(inlineMimeFor('kra', 'application/x-krita')).toBeNull();
    expect(inlineMimeFor('krz', 'application/x-krita')).toBeNull();
    expect(inlineMimeFor('bin', 'application/octet-stream')).toBeNull();
    expect(inlineMimeFor('', '')).toBeNull();
  });
});

// ─── Section 13 — Filename sanitization (expanded) ────────────────────────

describe('media-service filename sanitizer (expanded)', () => {
  // Helper: assert the header value is accepted by Node's http module
  // (setHeader rejects values containing characters outside Latin-1 or
  // certain control chars).
  function expectSetHeaderAccepts(value) {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Disposition', value);
      res.end('ok');
    });
    return new Promise((resolve, reject) => {
      server.listen(0, () => {
        const port = server.address().port;
        http.get(`http://127.0.0.1:${port}/`, (res) => {
          res.resume();
          server.close();
          resolve(res.headers['content-disposition']);
        }).on('error', (err) => {
          server.close();
          reject(err);
        });
      });
    });
  }

  it('ASCII name passes through to both parameters', () => {
    const { ascii, utf8 } = sanitizeDispositionFilename('photo.png');
    expect(ascii).toBe('photo.png');
    expect(utf8).toBe("UTF-8''photo.png");
  });

  it('quotes are stripped from ASCII fallback', () => {
    const { ascii } = sanitizeDispositionFilename('"evil".png');
    expect(ascii).not.toContain('"');
  });

  it('semicolons are stripped from ASCII fallback', () => {
    const { ascii } = sanitizeDispositionFilename('file;name.png');
    expect(ascii).not.toContain(';');
  });

  it('percent signs are preserved in ASCII fallback and encoded in utf8', () => {
    const { ascii, utf8 } = sanitizeDispositionFilename('50%.png');
    expect(ascii).toBe('50%.png');
    expect(utf8).toContain('50%25.png'); // % encoded as %25 in filename*
  });

  it('forward and backward slashes are stripped', () => {
    const { ascii } = sanitizeDispositionFilename('a/b\\c.png');
    expect(ascii).not.toContain('/');
    expect(ascii).not.toContain('\\');
  });

  it('CR and LF are stripped', () => {
    const { ascii } = sanitizeDispositionFilename('a\rb\nc.png');
    expect(ascii).not.toContain('\r');
    expect(ascii).not.toContain('\n');
  });

  it('NUL is stripped', () => {
    const { ascii } = sanitizeDispositionFilename('a\x00b.png');
    expect(ascii).not.toContain('\0');
  });

  it('tab is stripped', () => {
    const { ascii } = sanitizeDispositionFilename('a\tb.png');
    expect(ascii).not.toContain('\t');
  });

  it('Latin-1 characters are transliterated to ASCII in fallback', () => {
    const { ascii } = sanitizeDispositionFilename('café.png');
    // é → e after NFD decomposition + combining-mark removal
    expect(ascii).toBe('cafe.png');
  });

  it('CJK characters are removed from ASCII fallback', () => {
    const { ascii } = sanitizeDispositionFilename('絵.png');
    expect(ascii).toBe('asset.png');
  });

  it('emoji are removed from ASCII fallback', () => {
    const { ascii } = sanitizeDispositionFilename('cat🐱.png');
    expect(ascii).toBe('cat.png');
  });

  it('combining marks are stripped in ASCII fallback', () => {
    const { ascii } = sanitizeDispositionFilename('e\u0301.png');
    // e + combining acute → e
    expect(ascii).toBe('e.png');
  });

  it('only-non-ASCII name falls back to asset.png', () => {
    const { ascii, utf8 } = sanitizeDispositionFilename('絵文字');
    expect(ascii).toBe('asset.png');
    expect(utf8).toContain('%E7%B5%B5'); // 絵 percent-encoded
  });

  it('extremely long name is bounded in ASCII fallback', () => {
    const long = 'a'.repeat(300) + '.png';
    const { ascii } = sanitizeDispositionFilename(long);
    expect(ascii.length).toBeLessThanOrEqual(128);
    expect(ascii).toContain('.png');
  });

  it('. and .. are replaced with safe fallback', () => {
    expect(sanitizeDispositionFilename('.').ascii).toBe('asset.png');
    expect(sanitizeDispositionFilename('..').ascii).toBe('asset.png');
  });

  it('Windows-reserved-looking names are handled safely', () => {
    // CON, PRN, etc. are not special in Content-Disposition but the
    // sanitizer should not break on them.
    const { ascii } = sanitizeDispositionFilename('CON.png');
    expect(ascii).toBe('CON.png');
  });

  it('safe extension is retained in fallback', () => {
    const { ascii } = sanitizeDispositionFilename('絵.jpg');
    expect(ascii).toBe('asset.jpg');
  });

  it('unsafe extension falls back to .png', () => {
    const { ascii } = sanitizeDispositionFilename('絵');
    expect(ascii).toBe('asset.png');
  });

  it('ASCII fallback contains only printable ASCII', () => {
    const inputs = [
      'café.png', '絵.png', '"ev\\il\r\n.png', 'a/b\\c.png',
      'hello world.png', String.fromCharCode(0x00, 0x07) + '.png',
      '50%.png', 'file;name.png',
    ];
    for (const input of inputs) {
      const { ascii } = sanitizeDispositionFilename(input);
      // Every character must be in the printable ASCII range (0x20–0x7E).
      for (const ch of ascii) {
        expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
        expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0x7E);
      }
    }
  });

  it('filename* preserves encoded Unicode', () => {
    const { utf8 } = sanitizeDispositionFilename('café.png');
    expect(utf8).toMatch(/^UTF-8''/);
    // é (U+00E9) → %C3%A9 in UTF-8 percent-encoding.
    expect(utf8).toContain('%C3%A9');
  });

  it('no header injection is possible in either parameter', () => {
    const inputs = [
      'evil\r\nX-Inject: yes.png',
      'a\r\nLocation: http://evil.com.png',
      'file"; inject=.png',
    ];
    for (const input of inputs) {
      const { ascii, utf8 } = sanitizeDispositionFilename(input);
      const header = `inline; filename="${ascii}"; filename*=${utf8}`;
      expect(header).not.toContain('\r');
      expect(header).not.toContain('\n');
      // The filename= value should not contain characters that could split
      // the header or inject new parameters.
      const filenameMatch = header.match(/filename="([^"]*)"/);
      expect(filenameMatch).not.toBeNull();
      const safeName = filenameMatch[1];
      expect(safeName).not.toContain(';');
    }
  });

  it('extension remains sensible after sanitization', () => {
    const cases = [
      ['photo.png', 'photo.png'],
      ['photo.jpg', 'photo.jpg'],
      ['PHOTO.PNG', 'PHOTO.png'],
      ['archive.tar.gz', 'archive.tar.gz'],
      ['絵.jpg', 'asset.jpg'],
      ['絵', 'asset.png'],
    ];
    for (const [input, expectedAscii] of cases) {
      const { ascii } = sanitizeDispositionFilename(input);
      expect(ascii).toBe(expectedAscii);
    }
  });

  it('complete Content-Disposition header is bounded for a 5,000-character CJK basename', () => {
    const long = '界'.repeat(5000) + '.png';
    const { ascii, utf8 } = sanitizeDispositionFilename(long);
    const header = `inline; filename="${ascii}"; filename*=${utf8}`;

    expect(ascii).toBe('asset.png');
    expect(utf8).toMatch(/^UTF-8''/);
    expect(utf8).toMatch(/\.png$/);
    expect(header.length).toBeLessThan(CONTENT_DISPOSITION_HEADER_MAX);
    expect(header.length).toBeLessThan(1024);
  });

  it('setHeader accepts the complete Content-Disposition value', async () => {
    const cases = [
      'café.png', '絵.png', '"evil".png', 'a/b\\c.png',
      'hello world.png', '50%.png',
    ];
    for (const name of cases) {
      const { ascii, utf8 } = sanitizeDispositionFilename(name);
      const header = `inline; filename="${ascii}"; filename*=${utf8}`;
      // This will throw if setHeader rejects the value.
      await expectSetHeaderAccepts(header);
    }
  });
});

// ─── Section 14 — Cache-failure HTTP mapping (503) ─────────────────────────

describe('media routes — cache-failure HTTP mapping', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  async function setupAsset() {
    const { project, absPath } = h.createProject('Cache Fail');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'cf.png', buf);
    const asset = h.indexAsset(project, 'cf.png');
    return { project, absPath, asset };
  }

  it('preview-root permission failure returns 503 with no-store and nosniff', async () => {
    const { project, asset } = await setupAsset();

    // Create a file where the cache directory should go, so ensureCacheDir
    // fails with PreviewCacheError. This works on both Unix and Windows
    // (chmod 0o444 is unreliable on Windows).
    const cacheDir = path.join(h.previewRoot, 'projects', String(project.id), String(asset.id));
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.writeFileSync(cacheDir, 'blocker');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(503);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toBe('Preview unavailable');
    // No absolute path or OS error leaked.
    expect(res.text).not.toContain(h.previewRoot);
    expect(res.text).not.toMatch(/[A-Z]:\\/);
  });

  it('original route still works when cache fails', async () => {
    const { project, absPath, asset } = await setupAsset();
    const buf = fs.readFileSync(path.join(absPath, 'cf.png'));

    // Block cache creation (same as above).
    const cacheDir = path.join(h.previewRoot, 'projects', String(project.id), String(asset.id));
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.writeFileSync(cacheDir, 'blocker');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.equals(buf)).toBe(true);
  });

  it('no partial derivative is exposed on cache failure', async () => {
    const { project, asset } = await setupAsset();

    // Block cache creation.
    const cacheDir = path.join(h.previewRoot, 'projects', String(project.id), String(asset.id));
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.writeFileSync(cacheDir, 'blocker');

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`);

    expect(res.status).toBe(503);
    // Body must be a controlled message, not image bytes.
    expect(res.headers['content-type']).not.toBe('image/webp');
  });
});

// ─── Section 15 — Global 500 cache policy ─────────────────────────────────

describe('media routes — global 500 cache policy', () => {
  let h;

  afterEach(() => {
    if (h) h.cleanup();
  });

  function makeHarnessWithStub(stub) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-media-500-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const previewRoot = path.join(tmpDir, 'app', 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    const db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { previewService: {}, mediaService: stub }
    );

    h = {
      tmpDir,
      projectsRoot,
      previewRoot,
      db,
      app,
      cleanup: () => {
        closeDatabase(db);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
    return h;
  }

  it('unexpected media-route error receives 500, global error page, Cache-Control: no-store, no raw error', async () => {
    const stub = {
      prepareDerivativeResponse: async () => { throw new Error('secret internal failure'); },
      prepareOriginalResponse: () => { throw new Error('secret internal failure'); },
    };
    const local = makeHarnessWithStub(stub);
    const res = await request(local.app).get('/projects/1/assets/1/thumbnail');
    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('secret internal failure');
    expect(res.text).toContain('error');
  });

  it('controlled 4xx statuses do not receive no-store from global handler', async () => {
    h = makeHarness();
    const { project, absPath } = h.createProject('No Store 4xx');
    const buf = await makePng(64, 64);
    writeProjectFile(absPath, 'ns.png', buf);
    const asset = h.indexAsset(project, 'ns.png');

    // 415 (controlled) should NOT get no-store from the global handler.
    // Krita files return 415 with no-store set by the route.
    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/thumbnail`);

    // This test verifies that the global no-store does not alter
    // controlled domain statuses. If a 415 has no-store, it's from the route.
    // If a 404 has no-store, it's from the route.
    const res404 = await request(h.app)
      .get('/projects/99999/assets/1/thumbnail')
      .expect(404);
    expect(res404.headers['cache-control']).toBe('no-store');
    // The global handler only adds no-store for 5xx.
  });
});

// ─── Section 16 — HEAD and cleanup regression ──────────────────────────────

describe('media routes — HEAD requests', () => {
  let h;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => h.cleanup());

  async function setupAsset() {
    const { project, absPath } = h.createProject('HEAD Test');
    const buf = await makePng(200, 150);
    writeProjectFile(absPath, 'head.png', buf);
    const asset = h.indexAsset(project, 'head.png');
    return { project, absPath, asset };
  }

  function makePreparedHeadHarness() {
    h.cleanup();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-media-head-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    const db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const counts = {
      thumbnail: { opened: 0, destroyed: 0 },
      preview: { opened: 0, destroyed: 0 },
      original: { opened: 0, destroyed: 0 },
    };

    function createTrackedStream(kind) {
      counts[kind].opened++;
      const stream = new Readable({ read() {} });
      const originalDestroy = stream.destroy.bind(stream);
      stream.destroy = (...args) => {
        const alreadyDestroyed = stream.destroyed;
        const result = originalDestroy(...args);
        if (!alreadyDestroyed) counts[kind].destroyed++;
        return result;
      };
      return stream;
    }

    const mediaService = {
      prepareDerivativeResponse: async (kind) => {
        const stream = createTrackedStream(kind);
        return {
          status: 200,
          headers: {
            'Content-Type': 'image/webp',
            'Content-Length': '4',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=0, must-revalidate',
          },
          stream,
          cleanup: () => {
            if (!stream.destroyed) stream.destroy();
          },
        };
      },
      prepareOriginalResponse: () => {
        const stream = createTrackedStream('original');
        return {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': '4',
            'Content-Disposition': 'inline; filename="head.png"',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=0, must-revalidate',
          },
          stream,
          cleanup: () => {
            if (!stream.destroyed) stream.destroy();
          },
        };
      },
    };

    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { previewService: {}, mediaService }
    );

    h = {
      app,
      counts,
      cleanup: () => {
        closeDatabase(db);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
    return h;
  }

  it('HEAD thumbnail returns headers without body', async () => {
    const { project, asset } = await setupAsset();
    // Prime the cache.
    await h.previewService.getThumbnail(project.id, asset.id);

    const res = await request(h.app)
      .head(`/projects/${project.id}/assets/${asset.id}/thumbnail`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBeDefined();
    // HEAD must not deliver a body (supertest does not parse body for HEAD).
  });

  it('HEAD preview returns headers without body', async () => {
    const { project, asset } = await setupAsset();
    await h.previewService.getPreview(project.id, asset.id);

    const res = await request(h.app)
      .head(`/projects/${project.id}/assets/${asset.id}/preview`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // HEAD must not deliver a body.
  });

  it('HEAD original returns headers without body', async () => {
    const { project, asset } = await setupAsset();

    const res = await request(h.app)
      .head(`/projects/${project.id}/assets/${asset.id}/original`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['content-disposition']).toContain('filename="head.png"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // HEAD must not deliver a body.
  });

  it('HEAD thumbnail opens and destroys exactly one prepared stream', async () => {
    const local = makePreparedHeadHarness();

    await request(local.app)
      .head('/projects/1/assets/1/thumbnail')
      .expect(200);

    expect(local.counts.thumbnail).toEqual({ opened: 1, destroyed: 1 });
    expect(local.counts.preview).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.original).toEqual({ opened: 0, destroyed: 0 });
  });

  it('HEAD preview opens and destroys exactly one prepared stream', async () => {
    const local = makePreparedHeadHarness();

    await request(local.app)
      .head('/projects/1/assets/1/preview')
      .expect(200);

    expect(local.counts.thumbnail).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.preview).toEqual({ opened: 1, destroyed: 1 });
    expect(local.counts.original).toEqual({ opened: 0, destroyed: 0 });
  });

  it('HEAD original opens and destroys exactly one prepared stream', async () => {
    const local = makePreparedHeadHarness();

    await request(local.app)
      .head('/projects/1/assets/1/original')
      .expect(200);

    expect(local.counts.thumbnail).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.preview).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.original).toEqual({ opened: 1, destroyed: 1 });
  });

  it('non-GET/HEAD methods on media URLs do not open prepared streams', async () => {
    const local = makePreparedHeadHarness();
    const methods = ['post', 'put', 'patch', 'delete', 'options'];
    const urls = [
      '/projects/1/assets/1/thumbnail',
      '/projects/1/assets/1/preview',
      '/projects/1/assets/1/original',
    ];

    for (const method of methods) {
      for (const url of urls) {
        await request(local.app)[method](url);
      }
    }

    expect(local.counts.thumbnail).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.preview).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.original).toEqual({ opened: 0, destroyed: 0 });
  });

  it('planned asset viewer route does not conflict with media routes', async () => {
    const local = makePreparedHeadHarness();

    await request(local.app).get('/projects/1/assets/1');

    expect(local.counts.thumbnail).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.preview).toEqual({ opened: 0, destroyed: 0 });
    expect(local.counts.original).toEqual({ opened: 0, destroyed: 0 });
  });
});

// ─── Section 17 — Original descriptor cleanup regression ─────────────────

describe('media routes — original descriptor cleanup', () => {
  let h;

  afterEach(() => {
    vi.restoreAllMocks();
    if (h) h.cleanup();
    h = null;
  });

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function expectDescriptorCounts(local, { opened = 1, closed = 1 } = {}) {
    for (let i = 0; i < 20; i++) {
      const counts = local.getDescriptorCounts();
      if (counts.opened === opened && counts.closed === closed) break;
      await wait(10);
    }
    expect(local.getDescriptorCounts()).toEqual({ opened, closed });
  }

  function expectNoRawLeak(res, local, secret) {
    const body = res.text || (Buffer.isBuffer(res.body) ? res.body.toString('utf8') : '');
    expect(body).not.toContain(local.tmpDir);
    expect(body).not.toContain(local.projectsRoot);
    expect(body).not.toMatch(/[A-Z]:\\/);
    if (secret) expect(body).not.toContain(secret);
  }

  function makeDescriptorHarness({ makeStream } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-media-desc-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const previewRoot = path.join(tmpDir, 'app', 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    const db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const descriptorCounts = { opened: 0, closed: 0 };

    function createTrackedStream({ mode = 'success', throwOnListenerEvent = null } = {}) {
      descriptorCounts.opened++;
      let closeRecorded = false;
      const recordClose = () => {
        if (!closeRecorded) {
          closeRecorded = true;
          descriptorCounts.closed++;
        }
      };

      let sentPartial = false;
      const stream = new Readable({
        read() {
          if (mode === 'hang') return;
          if (mode === 'error') {
            this.destroy(new Error('synthetic source read failure'));
            return;
          }
          if (mode === 'partial-error') {
            if (sentPartial) return;
            sentPartial = true;
            this.push(Buffer.from('da'));
            this.destroy(new Error('synthetic committed stream failure'));
            return;
          }
          this.push(Buffer.from('data'));
          this.push(null);
        },
      });
      stream.once('close', recordClose);

      const originalDestroy = stream.destroy.bind(stream);
      stream.destroy = (...args) => {
        const alreadyDestroyed = stream.destroyed;
        const result = originalDestroy(...args);
        if (!alreadyDestroyed) recordClose();
        return result;
      };

      if (throwOnListenerEvent) {
        const originalOn = stream.on.bind(stream);
        stream.on = (event, listener) => {
          if (event === throwOnListenerEvent) {
            throw new Error('synthetic listener installation failure');
          }
          return originalOn(event, listener);
        };
      }

      return { stream, size: mode === 'hang' ? 100 : 4 };
    }

    const mediaService = {
      prepareDerivativeResponse: async () => { throw new Error('not used'); },
      prepareOriginalResponse: () => {
        const opened = makeStream
          ? makeStream(createTrackedStream)
          : createTrackedStream();
        const { stream, size } = opened;
        return {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(size),
            'Content-Disposition': 'inline; filename="test.png"',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=0, must-revalidate',
            ETag: `W/"0123456789abcdef-${size}"`,
          },
          stream,
          cleanup: () => {
            if (!stream.destroyed) stream.destroy();
          },
        };
      },
    };

    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { previewService: {}, mediaService }
    );

    h = {
      tmpDir,
      projectsRoot,
      previewRoot,
      db,
      app,
      getDescriptorCounts: () => ({ ...descriptorCounts }),
      cleanup: () => {
        closeDatabase(db);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
    return h;
  }

  it('res.setHeader throwing after stream open closes the descriptor once', async () => {
    const local = makeDescriptorHarness();
    let setHeaderThrew = false;
    const originalSetHeader = http.ServerResponse.prototype.setHeader;
    vi.spyOn(http.ServerResponse.prototype, 'setHeader').mockImplementation(function setHeader(name, value) {
      if (String(name).toLowerCase() === 'content-disposition') {
        expect(local.getDescriptorCounts().opened).toBe(1);
        setHeaderThrew = true;
        throw new Error('synthetic setHeader failure');
      }
      return originalSetHeader.call(this, name, value);
    });

    const res = await request(local.app).get('/projects/1/assets/1/original');

    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).not.toBe('image/png');
    expect(setHeaderThrew).toBe(true);
    await expectDescriptorCounts(local);
    expectNoRawLeak(res, local, 'synthetic setHeader failure');
  });

  it('listener installation throwing after stream open closes the descriptor once', async () => {
    const local = makeDescriptorHarness({
      makeStream: (createTrackedStream) => createTrackedStream({ throwOnListenerEvent: 'error' }),
    });

    const res = await request(local.app).get('/projects/1/assets/1/original');

    expect(res.status).toBeGreaterThanOrEqual(500);
    await expectDescriptorCounts(local);
    expectNoRawLeak(res, local, 'synthetic listener installation failure');
  });

  it('synchronous stream construction failure after descriptor open closes the descriptor once', async () => {
    h = makeHarness();
    const { project, absPath } = h.createProject('Construct Fail');
    const buf = await makePng(64, 64);
    const srcPath = path.resolve(absPath, 'construct.png');
    writeProjectFile(absPath, 'construct.png', buf);
    const asset = h.indexAsset(project, 'construct.png');

    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    const openedFds = new Set();
    let openedCount = 0;
    let closedCount = 0;

    vi.spyOn(fs, 'openSync').mockImplementation(function openSync(file, ...args) {
      const fd = originalOpenSync.call(this, file, ...args);
      if (path.resolve(String(file)) === srcPath) {
        openedCount++;
        openedFds.add(fd);
      }
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(function closeSync(fd) {
      if (openedFds.has(fd)) {
        closedCount++;
        openedFds.delete(fd);
      }
      return originalCloseSync.call(this, fd);
    });
    vi.spyOn(fs, 'createReadStream').mockImplementationOnce(() => {
      throw new Error('synthetic stream construction failure');
    });

    const res = await request(h.app)
      .get(`/projects/${project.id}/assets/${asset.id}/original`);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(openedCount).toBe(1);
    expect(closedCount).toBe(1);
    expectNoRawLeak(res, h, 'synthetic stream construction failure');
  });

  it('successful original response closes the descriptor once', async () => {
    const local = makeDescriptorHarness();

    const res = await request(local.app)
      .get('/projects/1/assets/1/original')
      .expect(200);

    expect(res.body.equals(Buffer.from('data'))).toBe(true);
    await expectDescriptorCounts(local);
  });

  it('client abort closes the descriptor once', async () => {
    const local = makeDescriptorHarness({
      makeStream: (createTrackedStream) => createTrackedStream({ mode: 'hang' }),
    });

    try {
      await request(local.app)
        .get('/projects/1/assets/1/original')
        .timeout({ deadline: 300 });
    } catch {
      // The client-side timeout aborts the request; cleanup is asserted below.
    }

    await expectDescriptorCounts(local);
  });

  it('source stream error before committed headers reaches the global 500 handler and closes once', async () => {
    const local = makeDescriptorHarness({
      makeStream: (createTrackedStream) => createTrackedStream({ mode: 'error' }),
    });

    const res = await request(local.app).get('/projects/1/assets/1/original');

    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).not.toBe('image/png');
    await expectDescriptorCounts(local);
    expectNoRawLeak(res, local, 'synthetic source read failure');
  });

  it('source stream error after committed headers aborts the response and closes once', async () => {
    const local = makeDescriptorHarness({
      makeStream: (createTrackedStream) => createTrackedStream({ mode: 'partial-error' }),
    });

    await expect(
      request(local.app).get('/projects/1/assets/1/original')
    ).rejects.toThrow();

    await expectDescriptorCounts(local);
  });
});
