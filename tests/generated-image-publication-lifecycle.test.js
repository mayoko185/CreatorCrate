import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createGeneratedImagePublicationRepository } from '../src/data/generated-image-publication-repository.js';
import {
  createGeneratedImagePublicationLifecycleRepository,
  resetGeneratedImagePublicationsForRestore,
  GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY,
} from '../src/data/generated-image-publication-lifecycle-repository.js';
import { createGeneratedImageRebuildRepository } from '../src/data/generated-image-rebuild-repository.js';
import { createGeneratedImageRebuildService } from '../src/services/generated-image-rebuild-service.js';
import { createGeneratedImagePublicationLifecycleService } from '../src/services/generated-image-publication-lifecycle-service.js';
import { createProjectImageSettingsService } from '../src/services/project-image-settings-service.js';
import { createPreviewService, PreviewPublicationJournalError } from '../src/services/preview-service.js';
import { createBackupService, BackupError } from '../src/services/backup-service.js';
import {
  createManagedUploadTracker,
  beginReplacementMaintenance,
} from '../src/services/managed-upload-tracker.js';
import { formatProjectDirName } from '../src/storage/project-storage.js';
import {
  META_FILENAME,
  PREVIEW_FILENAME,
  CURRENT_POINTER_FILENAME,
  getCacheDir,
  readCurrentPointer,
  readMetaFile,
  writeCurrentPointer,
  buildRevisionDirName,
  buildRevisionToken,
  metaSourceGeneration,
} from '../src/storage/preview-cache.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function makePng(width, height, { r = 80, g = 120, b = 200 } = {}) {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

async function makeGif(width, height, { animated }) {
  const sharp = (await import('sharp')).default;
  const frame = (i) => sharp({ create: { width, height, channels: 3, background: { r: i * 60, g: 100, b: 200 - i * 40 } } })
    .png().toBuffer();
  if (!animated) return sharp(await frame(0)).gif().toBuffer();
  return sharp(await Promise.all([0, 1, 2].map(frame)), { join: { animated: true } }).gif().toBuffer();
}

// Fail every `fs[method]` call on exactly one path with a transient I/O
// error; `hit()` reports whether the fault was reached.
function injectIoFault(method, target) {
  const real = fs[method];
  const faulty = path.resolve(target);
  let reached = false;
  const spy = vi.spyOn(fs, method).mockImplementation(function (file, ...rest) {
    if (typeof file === 'string' && path.resolve(file) === faulty) {
      reached = true;
      throw Object.assign(new Error(`EIO: i/o error, ${method} '${file}'`), { code: 'EIO', errno: -5 });
    }
    return real.call(this, file, ...rest);
  });
  return { hit: () => reached, restore: () => spy.mockRestore() };
}

async function settleAll(...services) {
  for (let i = 0; i < 10; i++) {
    await Promise.all(services.map((service) => service.waitForIdle()));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gi-lifecycle-'));
  const projectsRoot = path.join(tmpDir, 'projects');
  const previewRoot = path.join(tmpDir, 'app', 'previews');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(previewRoot, { recursive: true });
  const databasePath = path.join(tmpDir, 'app', 'creatorcrate.db');
  let db = openDatabase(databasePath);
  runMigrations(db, MIGRATIONS_DIR);

  const h = {
    tmpDir, projectsRoot, previewRoot, databasePath,
    get db() { return db; },
    bind(nextDb) {
      db = nextDb;
      h.projectRepo = createProjectRepository(db);
      h.assetRepo = createAssetRepository(db);
      h.appMeta = createAppMetaRepository(db);
      h.lifecycleRepo = createGeneratedImagePublicationLifecycleRepository(db);
      h.publications = createGeneratedImagePublicationRepository(db);
      h.imageSettings = createProjectImageSettingsService({ appMetaRepository: h.appMeta });
      h.preview = h.makePreview();
    },
    makePreview(overrides = {}) {
      return createPreviewService({
        db, projectsRoot, previewRoot,
        projectImageSettingsService: h.imageSettings,
        generatedImagePublicationRepository: h.publications,
        publicationIndexReady: h.lifecycleRepo.isPublicationIndexReady,
        ...overrides,
      });
    },
    createProject(title, status = 'tbd') {
      let project = h.projectRepo.create({
        title, slug: slugify(title, { lowercase: true }), description: '', notes: '', status,
        projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const relPath = formatProjectDirName(project.id, project.slug);
      const absPath = path.resolve(projectsRoot, relPath);
      fs.mkdirSync(absPath, { recursive: true });
      project = h.projectRepo.setProjectDir(project.id, relPath);
      return { project, absPath };
    },
    async addAsset(ctx, name, color) {
      const target = path.join(ctx.absPath, name);
      fs.writeFileSync(target, await makePng(320, 240, color));
      const stat = fs.statSync(target);
      return h.assetRepo.upsert(ctx.project.id, name, {
        filename: name, extension: 'png', mimeType: 'image/png',
        sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
      });
    },
    cleanup() {
      try { closeDatabase(db); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
  h.bind(db);
  return h;
}

const cacheRoot = (h, projectId, assetId) => getCacheDir(h.previewRoot, projectId, assetId);

function publishedMeta(h, projectId, assetId) {
  const pointer = readCurrentPointer(h.previewRoot, projectId, assetId).pointer;
  const meta = readMetaFile(path.join(cacheRoot(h, projectId, assetId), pointer.dir, META_FILENAME)).meta;
  return { pointer, meta };
}

// Stands in for the pre-041 writer: it had no publication index to wait for.
const legacyWriter = (h) => h.makePreview({ publicationIndexReady: () => true });

/** Publish a real pair, then drop its SQLite rows: a pre-041 legacy cache. */
async function legacyAsset(h, { projectStatus = 'tbd', name = 'legacy.png', color } = {}) {
  const ctx = h.createProject(`Project ${name} ${crypto.randomBytes(3).toString('hex')}`, projectStatus);
  const asset = await h.addAsset(ctx, name, color);
  await legacyWriter(h).getPreview(ctx.project.id, asset.id);
  h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(asset.id);
  return { project: ctx.project, asset };
}

/**
 * Rewrite the published generation as another self-consistent legacy
 * generation: meta.json mutated, its revision token recomputed, a new
 * immutable directory, and current.json pointed at it.
 */
function rewriteLegacyGeneration(h, projectId, assetId, mutate) {
  const root = cacheRoot(h, projectId, assetId);
  const { pointer, meta } = publishedMeta(h, projectId, assetId);
  const next = structuredClone(meta);
  mutate(next);
  const revision = buildRevisionToken({
    projectId: next.projectId, assetId: next.assetId, relativePath: next.source.relativePath,
    size: next.source.size, mtime: next.source.mtime, policyFingerprint: next.policyFingerprint,
    sourceGeneration: metaSourceGeneration(next),
  });
  const dir = buildRevisionDirName(revision);
  fs.cpSync(path.join(root, pointer.dir), path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, META_FILENAME), JSON.stringify(next, null, 2));
  writeCurrentPointer(root, { dir, revision });
  return { dir, revision, meta: next };
}

function fakeRebuild() {
  return { queueRepair: vi.fn(() => 'queued'), signal: vi.fn() };
}

function makeLifecycle(h, overrides = {}) {
  return createGeneratedImagePublicationLifecycleService({
    repository: h.lifecycleRepo,
    publications: h.publications,
    previewService: h.preview,
    rebuildService: fakeRebuild(),
    managedUploadTracker: createManagedUploadTracker(),
    schedule: () => null,
    ...overrides,
  });
}

async function runLifecycle(lifecycle) {
  lifecycle.prepare();
  lifecycle.signal();
  await lifecycle.waitForIdle();
  return lifecycle.readiness();
}

const rowCounts = (db) => ({
  publications: db.prepare('SELECT COUNT(*) AS n FROM generated_image_publications').get().n,
  derivatives: db.prepare('SELECT COUNT(*) AS n FROM generated_image_derivatives').get().n,
  intents: db.prepare('SELECT COUNT(*) AS n FROM generated_image_publication_intents').get().n,
});

function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${fs.statSync(full).size}`);
    }
  };
  walk(root);
  return out.sort();
}

// ─── Upgrade backfill ────────────────────────────────────────────────────

describe('generated-image publication backfill (one-time upgrade import)', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  it('imports a populated legacy publication exactly as current.json and meta.json describe it', async () => {
    const { project, asset } = await legacyAsset(h);
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();
    const { pointer, meta } = publishedMeta(h, project.id, asset.id);

    const readiness = await runLifecycle(makeLifecycle(h));

    expect(readiness.publicationIndexReady).toBe(true);
    expect(readiness.backfill).toMatchObject({ mode: 'upgrade', phase: 'completed', repairRequired: false });
    expect(readiness.backfill.counts.imported).toBe(1);
    expect(h.publications.findPublication(project.id, asset.id)).toEqual({
      projectId: project.id, assetId: asset.id,
      directoryName: pointer.dir, revision: pointer.revision, generatedAt: meta.generatedAt,
      cacheSchemaVersion: meta.schemaVersion, derivativeConfigVersion: meta.derivativeConfigVersion,
      sourceRelativePath: meta.source.relativePath, sourceSizeBytes: meta.source.size,
      sourceMtime: meta.source.mtime, sourceGeneration: meta.source.generation ?? 0,
      policyFingerprint: meta.policyFingerprint, animated: meta.animated, frameCount: meta.frameCount,
      sourcePreviewQuality: null, generationIdentityVersion: meta.generationIdentities.version,
      derivatives: {
        thumbnail: {
          format: meta.thumbnail.format, width: meta.thumbnail.width, height: meta.thumbnail.height,
          sizeBytes: meta.thumbnail.bytes, generationIdentity: meta.generationIdentities.thumbnail,
        },
        preview: {
          format: meta.preview.format, width: meta.preview.width, height: meta.preview.height,
          sizeBytes: meta.preview.bytes, generationIdentity: meta.generationIdentities.preview,
        },
      },
    });
  });

  it('writes the parent row and exactly both derivative rows', async () => {
    const { asset } = await legacyAsset(h);
    await runLifecycle(makeLifecycle(h));
    expect(rowCounts(h.db)).toEqual({ publications: 1, derivatives: 2, intents: 0 });
    expect(h.db.prepare('SELECT kind FROM generated_image_derivatives WHERE asset_id = ? ORDER BY kind')
      .pluck().all(asset.id)).toEqual(['preview', 'thumbnail']);
  });

  it('includes assets of archived projects', async () => {
    const { project, asset } = await legacyAsset(h, { projectStatus: 'archived' });
    const readiness = await runLifecycle(makeLifecycle(h));
    expect(readiness.backfill.counts.imported).toBe(1);
    expect(h.publications.findPublication(project.id, asset.id)).not.toBeNull();
  });

  it('fabricates nothing for a missing pointer, and records the repair need', async () => {
    const { project, asset } = await legacyAsset(h);
    fs.rmSync(path.join(cacheRoot(h, project.id, asset.id), CURRENT_POINTER_FILENAME));
    const rebuildService = fakeRebuild();

    const readiness = await runLifecycle(makeLifecycle(h, { rebuildService }));

    expect(readiness.backfill.counts.missing).toBe(1);
    expect(rowCounts(h.db).publications).toBe(0);
    // Admitted to the existing rebuild machinery once the index completed.
    expect(rebuildService.queueRepair).toHaveBeenCalledTimes(1);
    expect(rebuildService.signal).toHaveBeenCalled();
    expect(h.lifecycleRepo.get().repairRequired).toBe(false);
  });

  it('fabricates nothing for a malformed pointer and never picks another revision directory', async () => {
    const { project, asset } = await legacyAsset(h);
    fs.writeFileSync(path.join(cacheRoot(h, project.id, asset.id), CURRENT_POINTER_FILENAME), '{"dir":');
    const readiness = await runLifecycle(makeLifecycle(h));
    expect(readiness.backfill.counts.malformed).toBe(1);
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();
  });

  it('fabricates nothing for corrupt or non-corresponding meta.json', async () => {
    const corrupt = await legacyAsset(h, { name: 'corrupt.png' });
    const foreign = await legacyAsset(h, { name: 'foreign.png' });
    const corruptMeta = path.join(cacheRoot(h, corrupt.project.id, corrupt.asset.id),
      publishedMeta(h, corrupt.project.id, corrupt.asset.id).pointer.dir, META_FILENAME);
    fs.writeFileSync(corruptMeta, '{ not json');
    // Self-consistent meta.json that names another asset.
    rewriteLegacyGeneration(h, foreign.project.id, foreign.asset.id, (meta) => { meta.assetId += 1000; });

    const readiness = await runLifecycle(makeLifecycle(h));

    expect(readiness.backfill.counts.invalid).toBe(2);
    expect(rowCounts(h.db).publications).toBe(0);
  });

  it('does not import an incomplete derivative pair', async () => {
    const { project, asset } = await legacyAsset(h);
    const { pointer } = publishedMeta(h, project.id, asset.id);
    fs.rmSync(path.join(cacheRoot(h, project.id, asset.id), pointer.dir, PREVIEW_FILENAME));
    const readiness = await runLifecycle(makeLifecycle(h));
    expect(readiness.backfill.counts.incomplete).toBe(1);
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();
  });

  it('keeps legacy-absent fields null and legacy source generation zero', async () => {
    const { project, asset } = await legacyAsset(h);
    // The policy fingerprint stays: the current one is always recorded, so a
    // fingerprint-less pair is never fresh (see the prior-policy tests below).
    const { dir, revision } = rewriteLegacyGeneration(h, project.id, asset.id, (meta) => {
      delete meta.generationIdentities;
      delete meta.animated;
      delete meta.frameCount;
      delete meta.source.generation;
    });

    const readiness = await runLifecycle(makeLifecycle(h));

    expect(readiness.backfill.counts.imported).toBe(1);
    expect(h.publications.findPublication(project.id, asset.id)).toMatchObject({
      directoryName: dir, revision, sourceGeneration: 0,
      animated: null, frameCount: null, generationIdentityVersion: null,
      derivatives: {
        thumbnail: { generationIdentity: null }, preview: { generationIdentity: null },
      },
    });
  });

  it('imports a prior-policy publication with its own recorded fingerprint, but not a source-stale one', async () => {
    const prior = await legacyAsset(h, { name: 'prior.png' });
    const stale = await legacyAsset(h, { name: 'stale.png' });
    rewriteLegacyGeneration(h, prior.project.id, prior.asset.id, (meta) => { meta.policyFingerprint = '0123456789abcdef'; });
    rewriteLegacyGeneration(h, stale.project.id, stale.asset.id, (meta) => { meta.source.size += 1; });

    const readiness = await runLifecycle(makeLifecycle(h));

    expect(readiness.backfill.counts).toMatchObject({ imported: 1, stale: 1 });
    expect(h.publications.findPublication(prior.project.id, prior.asset.id).policyFingerprint)
      .toBe('0123456789abcdef');
    expect(h.publications.findPublication(stale.project.id, stale.asset.id)).toBeNull();
    expect(readiness.backfill.repairRequired).toBe(false); // admitted to the fake rebuild
    // Presentation parity: the imported prior-policy pair is served as is.
    const served = publishedMeta(h, prior.project.id, prior.asset.id).pointer.dir;
    await h.preview.getPreview(prior.project.id, prior.asset.id);
    expect(publishedMeta(h, prior.project.id, prior.asset.id).pointer.dir).toBe(served);
  });

  it('never imports a prior-policy publication without a recorded fingerprint', async () => {
    // Identity matches, but meta.json records no policy fingerprint: under the
    // always-recorded current fingerprint that is a policy-only mismatch.
    const { project, asset } = await legacyAsset(h);
    const { dir } = rewriteLegacyGeneration(h, project.id, asset.id, (meta) => { delete meta.policyFingerprint; });
    const rebuildService = fakeRebuild();

    const readiness = await runLifecycle(makeLifecycle(h, { rebuildService }));

    expect(readiness.publicationIndexReady).toBe(true);
    expect(readiness.backfill).toMatchObject({ phase: 'completed', repairRequired: false });
    expect(readiness.backfill.counts).toMatchObject({ imported: 0, stale: 1 });
    expect(h.lifecycleRepo.get().cursor).toBe(asset.id);
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();
    expect(rebuildService.queueRepair).toHaveBeenCalledTimes(1);
    // Presentation parity: the reader does not serve it either; it regenerates.
    await h.preview.getPreview(project.id, asset.id);
    expect(publishedMeta(h, project.id, asset.id).pointer.dir).not.toBe(dir);
  });

  it('does not let a fingerprint-less pair block the rest of the pass', async () => {
    const unrecorded = await legacyAsset(h, { name: 'unrecorded.png' });
    const kept = await legacyAsset(h, { name: 'kept.png' });
    rewriteLegacyGeneration(h, unrecorded.project.id, unrecorded.asset.id, (meta) => { delete meta.policyFingerprint; });

    const readiness = await runLifecycle(makeLifecycle(h));

    expect(readiness.backfill.counts).toMatchObject({ imported: 1, stale: 1 });
    expect(h.publications.findPublication(unrecorded.project.id, unrecorded.asset.id)).toBeNull();
    expect(h.publications.findPublication(kept.project.id, kept.asset.id)).not.toBeNull();
  });

  it('rejects a recorded-fingerprint pair that is otherwise incompatible', async () => {
    const { project, asset } = await legacyAsset(h);
    rewriteLegacyGeneration(h, project.id, asset.id, (meta) => {
      meta.policyFingerprint = '0123456789abcdef';
      meta.source.size += 1;
    });
    const readiness = await runLifecycle(makeLifecycle(h));
    expect(readiness.backfill.counts).toMatchObject({ imported: 0, stale: 1 });
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();
  });

  it('resumes an interrupted pass from its committed cursor', async () => {
    const first = await legacyAsset(h, { name: 'a.png' });
    const second = await legacyAsset(h, { name: 'b.png' });
    const failing = {
      ...h.preview,
      inspectLegacyPublication: vi.fn(async (projectId, assetId) => {
        if (assetId === second.asset.id) throw new Error('crash');
        return h.preview.inspectLegacyPublication(projectId, assetId);
      }),
    };
    const interrupted = await runLifecycle(makeLifecycle(h, { previewService: failing }));
    expect(interrupted.publicationIndexReady).toBe(false);
    expect(h.lifecycleRepo.get()).toMatchObject({ phase: 'running', cursor: first.asset.id });
    expect(h.publications.findPublication(first.project.id, first.asset.id)).not.toBeNull();

    const counting = { ...h.preview, inspectLegacyPublication: vi.fn(h.preview.inspectLegacyPublication) };
    const resumed = await runLifecycle(makeLifecycle(h, { previewService: counting }));

    expect(resumed.publicationIndexReady).toBe(true);
    expect(counting.inspectLegacyPublication.mock.calls.map(([, assetId]) => assetId)).toEqual([second.asset.id]);
    expect(resumed.backfill.counts.imported).toBe(2);
  });

  it('advances the cursor only in the transaction that installs the import', async () => {
    const { project, asset } = await legacyAsset(h);
    const publications = {
      ...h.publications,
      installPublication: (snapshot) => {
        h.publications.installPublication(snapshot);
        throw new Error('crash after install, before commit');
      },
    };
    await runLifecycle(makeLifecycle(h, { publications }));
    expect(h.lifecycleRepo.get()).toMatchObject({ phase: 'running', cursor: 0 });
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();

    // A step for an asset the pass already committed is refused.
    await runLifecycle(makeLifecycle(h));
    expect(h.lifecycleRepo.commitStep(asset.id, 'missing')).toBeNull();
    expect(h.lifecycleRepo.get().counts).toMatchObject({ imported: 1, missing: 0 });
  });

  it('does no filesystem publication scan once the pass is durably complete', async () => {
    const { project, asset } = await legacyAsset(h);
    await runLifecycle(makeLifecycle(h));
    h.db.prepare('DELETE FROM generated_image_publications').run();

    const counting = {
      ...h.preview,
      inspectLegacyPublication: vi.fn(h.preview.inspectLegacyPublication),
      inspectPublicationIntent: vi.fn(h.preview.inspectPublicationIntent),
    };
    const readiness = await runLifecycle(makeLifecycle(h, { previewService: counting }));

    expect(readiness.publicationIndexReady).toBe(true);
    expect(counting.inspectLegacyPublication).not.toHaveBeenCalled();
    expect(counting.inspectPublicationIntent).not.toHaveBeenCalled();
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();
  });

  it('never imports orphan cache directories without a DB-owned asset', async () => {
    const { project, asset } = await legacyAsset(h);
    const orphan = cacheRoot(h, project.id, asset.id + 500);
    fs.cpSync(cacheRoot(h, project.id, asset.id), orphan, { recursive: true });
    const counting = { ...h.preview, inspectLegacyPublication: vi.fn(h.preview.inspectLegacyPublication) };

    await runLifecycle(makeLifecycle(h, { previewService: counting }));

    expect(counting.inspectLegacyPublication.mock.calls.map(([, id]) => id)).toEqual([asset.id]);
    expect(h.db.prepare('SELECT asset_id FROM generated_image_publications').pluck().all()).toEqual([asset.id]);
  });

  it('never writes filesystem metadata into asset or project business state', async () => {
    const imported = await legacyAsset(h, { name: 'kept.png' });
    const stale = await legacyAsset(h, { name: 'changed.png' });
    rewriteLegacyGeneration(h, stale.project.id, stale.asset.id, (meta) => {
      meta.source.size += 7;
      meta.source.mtime = '2001-01-01T00:00:00.000Z';
    });
    const snapshot = () => ({
      assets: h.db.prepare('SELECT * FROM assets ORDER BY id').all(),
      projects: h.db.prepare('SELECT * FROM projects ORDER BY id').all(),
    });
    const before = snapshot();

    await runLifecycle(makeLifecycle(h));

    expect(snapshot()).toEqual(before);
    expect(h.publications.findPublication(imported.project.id, imported.asset.id)).not.toBeNull();
  });

  it('republishes a row-less asset from a rebuild probe without consulting its legacy JSON', async () => {
    const { project, asset } = await legacyAsset(h);
    const legacy = publishedMeta(h, project.id, asset.id).pointer;
    const policy = h.imageSettings.getPolicy();
    h.lifecycleRepo.initialize(); // upgrade pass running: the legacy pair is not imported yet
    // The rebuild probe reads only SQLite: a missing row is published afresh
    // through the journal, never served or imported from current.json/meta.json.
    const early = await h.preview.ensureTargetGeneration(project.id, asset.id, policy);
    expect(early.cacheState).toBe('regenerated');
    const committed = h.publications.findPublication(project.id, asset.id);
    expect(committed.directoryName).not.toBe(legacy.dir);
    expect(publishedMeta(h, project.id, asset.id).pointer.dir).toBe(committed.directoryName);

    // The backfill then finds the asset already decided by the writer.
    const readiness = await runLifecycle(makeLifecycle(h));
    expect(readiness.backfill.counts).toMatchObject({ imported: 0, alreadyPublished: 1 });
    const settled = await h.preview.ensureTargetGeneration(project.id, asset.id, policy);
    expect(settled.cacheState).toBeUndefined();
    expect(h.publications.findPublication(project.id, asset.id)).toEqual(committed);
  });

  // A GIF legacy publication generated from a (still or animated) source,
  // whose asset row then records `rowAnimated` (1, 0, or unknown/null): the
  // row, never the pair's meta.json, is the animation authority.
  async function legacyGif({ pairAnimated, rowAnimated }) {
    const ctx = h.createProject(`Gif ${crypto.randomBytes(3).toString('hex')}`);
    const name = 'legacy.gif';
    const target = path.join(ctx.absPath, name);
    fs.writeFileSync(target, await makeGif(40, 30, { animated: pairAnimated }));
    const stat = fs.statSync(target);
    const asset = h.assetRepo.upsert(ctx.project.id, name, {
      filename: name, extension: 'gif', mimeType: 'image/gif',
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sourceAnimated: pairAnimated,
    });
    await legacyWriter(h).getPreview(ctx.project.id, asset.id);
    expect(publishedMeta(h, ctx.project.id, asset.id).meta.animated).toBe(pairAnimated);
    h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(asset.id);
    h.db.prepare('UPDATE assets SET source_animated = ? WHERE id = ?')
      .run(rowAnimated == null ? null : Number(rowAnimated), asset.id);
    return { project: ctx.project, asset: h.assetRepo.findById(asset.id) };
  }

  it.each([
    // label, pair recorded animation, row source_animated, prior policy, outcome
    ['animated source with a static pair', false, true, false, 'stale'],
    ['animated source with an animated pair', true, true, false, 'imported'],
    ['static source with a static pair', false, false, false, 'imported'],
    ['static source with an animated pair', true, false, false, 'stale'],
    ['animated source with a prior-policy animated pair', true, true, true, 'imported'],
    ['animated source with a prior-policy static pair', false, true, true, 'stale'],
    ['unrecorded source animation with a fresh pair', true, null, false, 'imported'],
    ['unrecorded source animation with a prior-policy pair', false, null, true, 'stale'],
  ])('applies the presentation animation authority: %s', async (_label, pairAnimated, rowAnimated, priorPolicy, outcome) => {
    const { project, asset } = await legacyGif({ pairAnimated, rowAnimated });
    if (priorPolicy) {
      rewriteLegacyGeneration(h, project.id, asset.id, (meta) => { meta.policyFingerprint = '0123456789abcdef'; });
    }
    const rebuildService = fakeRebuild();

    const readiness = await runLifecycle(makeLifecycle(h, { rebuildService }));

    expect(readiness.backfill.counts).toMatchObject({ [outcome]: 1 });
    const row = h.publications.findPublication(project.id, asset.id);
    if (outcome === 'imported') {
      expect(row).toMatchObject({ animated: pairAnimated });
      expect(rebuildService.queueRepair).not.toHaveBeenCalled();
    } else {
      // Classified for repair through the existing rebuild machinery.
      expect(row).toBeNull();
      expect(rebuildService.queueRepair).toHaveBeenCalledTimes(1);
    }
    // Generated metadata never overwrites the row's animation authority.
    expect(h.assetRepo.findById(asset.id).source_animated).toBe(asset.source_animated);
  });
});

// ─── Targeted intent recovery ────────────────────────────────────────────

describe('generated-image publication intent recovery', () => {
  let h;
  beforeEach(async () => {
    h = makeHarness();
    // Recovery tests start from a completed index; only intents are pending.
    h.lifecycleRepo.initialize();
    h.lifecycleRepo.complete();
  });
  afterEach(() => h.cleanup());

  async function published(name = 'asset.png', color) {
    const ctx = h.createProject(`Recovery ${name} ${crypto.randomBytes(3).toString('hex')}`);
    const asset = await h.addAsset(ctx, name, color);
    await h.preview.getPreview(ctx.project.id, asset.id);
    const committed = h.publications.findPublication(ctx.project.id, asset.id);
    return { project: ctx.project, asset, committed, root: cacheRoot(h, ctx.project.id, asset.id) };
  }

  // A crash after promotion: a complete candidate (same revision token,
  // different directory) plus its intent; `pointer` selects current.json.
  function crashedCandidate({ project, asset, committed, root }, { pointer = 'previous' } = {}) {
    const candidate = buildRevisionDirName(committed.revision);
    fs.cpSync(path.join(root, committed.directoryName), path.join(root, candidate), { recursive: true });
    const staging = `tmp-${crypto.randomBytes(6).toString('hex')}`;
    fs.mkdirSync(path.join(root, staging));
    const intent = h.publications.acquireIntent({
      projectId: project.id, assetId: asset.id, candidateDirectoryName: candidate,
      stagingDirectoryName: staging, expectedRevision: committed.revision,
      previousDirectoryName: committed.directoryName,
    });
    if (pointer === 'candidate') writeCurrentPointer(root, { dir: candidate, revision: committed.revision });
    return { intent, candidate, staging };
  }

  it('finalizes a candidate current.json names, from its own meta.json', async () => {
    const state = await published();
    const failing = { ...h.publications, finalizePublication: () => { throw new Error('database unavailable'); } };
    const writer = h.makePreview({ generatedImagePublicationRepository: failing });
    await expect(writer.ensureTargetGeneration(state.project.id, state.asset.id, h.imageSettings.getPolicy(),
      () => true, { force: true })).rejects.toBeInstanceOf(PreviewPublicationJournalError);
    const intent = h.publications.findIntent(state.project.id, state.asset.id);
    const { pointer, meta } = publishedMeta(h, state.project.id, state.asset.id);
    expect(pointer.dir).toBe(intent.candidateDirectoryName);
    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);

    const readiness = await runLifecycle(makeLifecycle(h));

    expect(readiness.recovery.unresolvedAssetIds).toEqual([]);
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
    expect(h.publications.findPublication(state.project.id, state.asset.id)).toMatchObject({
      directoryName: intent.candidateDirectoryName, revision: pointer.revision, generatedAt: meta.generatedAt,
    });
  });

  it('preserves the committed publication when current.json still names the previous directory', async () => {
    const state = await published();
    const { intent, candidate, staging } = crashedCandidate(state, { pointer: 'previous' });
    const rebuildService = fakeRebuild();

    await runLifecycle(makeLifecycle(h, { rebuildService }));

    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
    // Operation-owned remnants removed; the previous generation untouched.
    expect(fs.existsSync(path.join(state.root, candidate))).toBe(false);
    expect(fs.existsSync(path.join(state.root, staging))).toBe(false);
    expect(fs.existsSync(path.join(state.root, state.committed.directoryName, PREVIEW_FILENAME))).toBe(true);
    expect(rebuildService.queueRepair).not.toHaveBeenCalled();
    expect(intent.previousDirectoryName).toBe(state.committed.directoryName);
  });

  it.each([
    ['missing', (root) => fs.rmSync(path.join(root, CURRENT_POINTER_FILENAME))],
    ['malformed', (root) => fs.writeFileSync(path.join(root, CURRENT_POINTER_FILENAME), 'nope')],
    ['unexpected', (root, revision) => {
      const other = buildRevisionDirName(revision);
      fs.mkdirSync(path.join(root, other));
      writeCurrentPointer(root, { dir: other, revision });
    }],
  ])('never chooses the newest directory when current.json is %s', async (_label, breakPointer) => {
    const state = await published();
    const { candidate } = crashedCandidate(state);
    breakPointer(state.root, state.committed.revision);
    const pointerBefore = fs.existsSync(path.join(state.root, CURRENT_POINTER_FILENAME))
      ? fs.readFileSync(path.join(state.root, CURRENT_POINTER_FILENAME)) : null;
    // The candidate is the newest, complete directory: still not selected.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(state.root, candidate), future, future);
    const rebuildService = fakeRebuild();

    await runLifecycle(makeLifecycle(h, { rebuildService }));

    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
    expect(fs.existsSync(path.join(state.root, candidate))).toBe(true);
    const pointerAfter = fs.existsSync(path.join(state.root, CURRENT_POINTER_FILENAME))
      ? fs.readFileSync(path.join(state.root, CURRENT_POINTER_FILENAME)) : null;
    expect(pointerAfter).toEqual(pointerBefore);
    expect(rebuildService.queueRepair).toHaveBeenCalledTimes(1);
  });

  it('does not erase the independently usable previous publication for invalid candidate metadata', async () => {
    const state = await published();
    const { candidate } = crashedCandidate(state, { pointer: 'candidate' });
    fs.writeFileSync(path.join(state.root, candidate, META_FILENAME), '{ corrupt');

    await runLifecycle(makeLifecycle(h));

    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
    expect(fs.readdirSync(path.join(state.root, state.committed.directoryName)).sort())
      .toEqual([META_FILENAME, PREVIEW_FILENAME, 'thumbnail.webp'].sort());
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
    expect(h.lifecycleRepo.get().repairRequired).toBe(false); // admitted
  });

  it('does not finalize a candidate with an incomplete derivative pair', async () => {
    const state = await published();
    const { candidate } = crashedCandidate(state, { pointer: 'candidate' });
    fs.rmSync(path.join(state.root, candidate, PREVIEW_FILENAME));

    await runLifecycle(makeLifecycle(h));

    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
  });

  it('never finalizes or clears through a stale intent ID', async () => {
    const state = await published();
    const { intent: stale, candidate } = crashedCandidate(state, { pointer: 'candidate' });
    let newer = null;
    // A newer operation replaces the intent after recovery listed it but
    // before recovery inspected it.
    const racing = {
      ...h.preview,
      inspectPublicationIntent: vi.fn(async (intent) => {
        if (!newer) {
          h.publications.clearIntent(state.project.id, state.asset.id, stale.intentId);
          newer = h.publications.acquireIntent({
            projectId: state.project.id, assetId: state.asset.id, candidateDirectoryName: candidate,
            stagingDirectoryName: stale.stagingDirectoryName, expectedRevision: stale.expectedRevision,
            previousDirectoryName: stale.previousDirectoryName,
          });
        }
        return h.preview.inspectPublicationIntent(intent);
      }),
    };

    await runLifecycle(makeLifecycle(h, { previewService: racing }));

    expect(racing.inspectPublicationIntent).toHaveBeenCalledTimes(1);
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toEqual(newer);
    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
    // Repository guards: a stale ID can neither finalize nor clear.
    expect(h.publications.finalizePublication(stale.intentId, { ...state.committed, directoryName: candidate }))
      .toBe(false);
    expect(h.publications.clearIntent(state.project.id, state.asset.id, stale.intentId)).toBe(false);
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toEqual(newer);
  });

  it('recovers an intent left behind in-process in the background, without a restart', async () => {
    const state = await published();
    const lifecycle = makeLifecycle(h);
    lifecycle.prepare();
    const failing = { ...h.publications, finalizePublication: () => { throw new Error('database busy'); } };
    const signal = vi.spyOn(lifecycle, 'signal');
    const writer = h.makePreview({
      generatedImagePublicationRepository: failing,
      onPublicationUnresolved: () => lifecycle.signal(),
    });

    const error = await writer.ensureTargetGeneration(state.project.id, state.asset.id,
      h.imageSettings.getPolicy(), () => true, { force: true }).catch((err) => err);

    expect(error).toBeInstanceOf(PreviewPublicationJournalError);
    expect(error.state).toBe('unresolved');
    expect(signal).toHaveBeenCalledTimes(1);
    await lifecycle.waitForIdle();
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
    expect(h.publications.findPublication(state.project.id, state.asset.id).directoryName)
      .toBe(error.candidateDirectoryName);
  });

  it('is idempotent when interrupted and rerun', async () => {
    const reverted = await published('reverted.png');
    const finalized = await published('finalized.png', { r: 200, g: 20, b: 20 });
    const revertState = crashedCandidate(reverted, { pointer: 'previous' });
    const finalizeState = crashedCandidate(finalized, { pointer: 'candidate' });
    // Interrupted after removing remnants, before clearing the intent.
    h.preview.removeIntentRemnants(revertState.intent);
    const flaky = {
      ...h.preview,
      inspectPublicationIntent: vi.fn(async (intent) => {
        if (intent.assetId === finalized.asset.id) throw new Error('crash');
        return h.preview.inspectPublicationIntent(intent);
      }),
    };
    const first = await runLifecycle(makeLifecycle(h, { previewService: flaky }));
    expect(first.recovery.unresolvedAssetIds).toEqual([finalized.asset.id]);
    expect(h.publications.findIntent(reverted.project.id, reverted.asset.id)).toBeNull();

    await runLifecycle(makeLifecycle(h));
    const afterSecond = h.publications.findPublication(finalized.project.id, finalized.asset.id);
    expect(afterSecond.directoryName).toBe(finalizeState.candidate);
    await runLifecycle(makeLifecycle(h));
    expect(h.publications.findPublication(finalized.project.id, finalized.asset.id)).toEqual(afterSecond);
    expect(h.publications.findPublication(reverted.project.id, reverted.asset.id)).toEqual(reverted.committed);
    expect(rowCounts(h.db).intents).toBe(0);
  });

  it('decides by directory identity when previous and candidate share a revision token', async () => {
    const state = await published();
    const { candidate } = crashedCandidate(state, { pointer: 'candidate' });
    expect(candidate).not.toBe(state.committed.directoryName);
    expect(candidate.startsWith(`r-${state.committed.revision}-`)).toBe(true);

    await runLifecycle(makeLifecycle(h));

    expect(h.publications.findPublication(state.project.id, state.asset.id))
      .toEqual({ ...state.committed, directoryName: candidate });
  });

  it('isolates one broken intent from unrelated assets and from index readiness', async () => {
    const broken = await published('broken.png');
    const healthy = await published('healthy.png', { r: 20, g: 200, b: 20 });
    const untouched = await published('untouched.png', { r: 20, g: 20, b: 200 });
    crashedCandidate(broken, { pointer: 'candidate' });
    const healthyState = crashedCandidate(healthy, { pointer: 'candidate' });
    const flaky = {
      ...h.preview,
      inspectPublicationIntent: vi.fn(async (intent) => {
        if (intent.assetId === broken.asset.id) throw new Error('unreadable volume');
        return h.preview.inspectPublicationIntent(intent);
      }),
    };
    const lifecycle = makeLifecycle(h, { previewService: flaky });

    const readiness = await runLifecycle(lifecycle);

    expect(readiness.publicationIndexReady).toBe(true);
    expect(readiness.recovery.retained).toEqual([{ assetId: broken.asset.id, reason: 'error' }]);
    expect(lifecycle.isAssetRecoverySettled(broken.asset.id)).toBe(false);
    expect(lifecycle.isAssetRecoverySettled(healthy.asset.id)).toBe(true);
    expect(lifecycle.isAssetRecoverySettled(untouched.asset.id)).toBe(true);
    expect(h.publications.findPublication(healthy.project.id, healthy.asset.id).directoryName)
      .toBe(healthyState.candidate);
    // The retained intent stays actionable; the previous snapshot stays servable.
    expect(h.publications.findIntent(broken.project.id, broken.asset.id)).not.toBeNull();
    expect(h.publications.findPublication(broken.project.id, broken.asset.id)).toEqual(broken.committed);
    expect(h.publications.findPublication(untouched.project.id, untouched.asset.id)).toEqual(untouched.committed);
  });

  it('is never performed by an ordinary request', async () => {
    const state = await published();
    const { intent } = crashedCandidate(state, { pointer: 'candidate' });

    const served = await h.preview.getPreview(state.project.id, state.asset.id);

    expect(served.status).toBe('ready');
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toEqual(intent);
    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
    await runLifecycle(makeLifecycle(h));
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
  });

  it.each([
    ['current.json read', 'readFileSync', (root) => path.join(root, CURRENT_POINTER_FILENAME), 'pointer-unreadable'],
    ['current.json inspection', 'lstatSync', (root) => path.join(root, CURRENT_POINTER_FILENAME), 'pointer-unreadable'],
    ['candidate meta.json read', 'readFileSync',
      (root, candidate) => path.join(root, candidate, META_FILENAME), 'candidate-unreadable'],
    ['candidate derivative read', 'readFileSync',
      (root, candidate) => path.join(root, candidate, PREVIEW_FILENAME), 'candidate-unreadable'],
    ['candidate derivative inspection', 'lstatSync',
      (root, candidate) => path.join(root, candidate, PREVIEW_FILENAME), 'candidate-unreadable'],
  ])('retains the intent through a transient %s failure and resolves it on a later run',
    async (_label, method, target, reason) => {
      const state = await published();
      const { intent, candidate } = crashedCandidate(state, { pointer: 'candidate' });
      const rebuildService = fakeRebuild();
      const lifecycle = makeLifecycle(h, { rebuildService });
      const fault = injectIoFault(method, target(state.root, candidate));
      let readiness;
      try {
        readiness = await runLifecycle(lifecycle);
      } finally {
        fault.restore();
      }

      expect(fault.hit()).toBe(true);
      // Unsettled, never abandoned: intent, candidate, and previous publication all kept.
      expect(readiness.recovery.retained).toEqual([{ assetId: state.asset.id, reason }]);
      expect(lifecycle.isAssetRecoverySettled(state.asset.id)).toBe(false);
      expect(h.publications.findIntent(state.project.id, state.asset.id)).toEqual(intent);
      expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
      expect(fs.readdirSync(path.join(state.root, candidate)).sort())
        .toEqual([META_FILENAME, PREVIEW_FILENAME, 'thumbnail.webp'].sort());
      expect(h.lifecycleRepo.get().repairRequired).toBe(false);
      expect(rebuildService.queueRepair).not.toHaveBeenCalled();

      // A later run, with the filesystem readable again, resolves the same intent.
      lifecycle.signal();
      await lifecycle.waitForIdle();
      expect(lifecycle.isAssetRecoverySettled(state.asset.id)).toBe(true);
      expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
      expect(h.publications.findPublication(state.project.id, state.asset.id))
        .toEqual({ ...state.committed, directoryName: candidate });
    });

  it.each([
    ['a pointer path that is not a file', 'pointer-unsafe', (root) => {
      fs.rmSync(path.join(root, CURRENT_POINTER_FILENAME));
      fs.mkdirSync(path.join(root, CURRENT_POINTER_FILENAME));
    }],
    ['candidate derivative bytes that were read but do not decode', 'candidate-incomplete', (root, candidate) => {
      const file = path.join(root, candidate, PREVIEW_FILENAME);
      fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size));
    }],
  ])('still abandons the intent for %s', async (_label, reason, breakState) => {
    const state = await published();
    const { candidate } = crashedCandidate(state, { pointer: 'candidate' });
    breakState(state.root, candidate);
    const applicationLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rebuildService = fakeRebuild();

    await runLifecycle(makeLifecycle(h, { rebuildService, applicationLogger }));

    expect(applicationLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'generated_images.publication.recovered',
      context: { assetId: state.asset.id, outcome: 'abandoned', reason },
    }));
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
    expect(h.publications.findPublication(state.project.id, state.asset.id)).toEqual(state.committed);
    expect(fs.existsSync(path.join(state.root, candidate))).toBe(true);
    expect(rebuildService.queueRepair).toHaveBeenCalledTimes(1);
  });
});

// ─── Explicit database restore ───────────────────────────────────────────

describe('generated-image publication state across database restore', () => {
  let h;
  let owner;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => {
    owner?.release();
    owner = null;
    h.cleanup();
  });

  const takeOwner = () => {
    owner = beginReplacementMaintenance(h.db, () => h.db.open);
    return owner;
  };
  const backupService = (hooks) => createBackupService({
    appDataRoot: path.join(h.tmpDir, 'app'), databasePath: h.databasePath,
    migrationsDir: MIGRATIONS_DIR, _hooks: hooks,
  });

  // Live DB with a committed publication, an unresolved intent, and a
  // completed upgrade index, plus a backup taken of that state.
  async function populatedWithBackup(service) {
    h.lifecycleRepo.initialize();
    h.lifecycleRepo.complete();
    const ctx = h.createProject('Restore project');
    const asset = await h.addAsset(ctx, 'restore.png');
    const other = await h.addAsset(ctx, 'intent.png', { r: 10, g: 10, b: 10 });
    await h.preview.getPreview(ctx.project.id, asset.id);
    await h.preview.getPreview(ctx.project.id, other.id);
    const committed = h.publications.findPublication(ctx.project.id, other.id);
    h.publications.acquireIntent({
      projectId: ctx.project.id, assetId: other.id,
      candidateDirectoryName: buildRevisionDirName(committed.revision),
      stagingDirectoryName: 'tmp-abcdef012345', expectedRevision: committed.revision,
      previousDirectoryName: committed.directoryName,
    });
    const backup = await service.createBackup(h.db);
    return { project: ctx.project, asset, other, backup };
  }

  it('resets the staged database index before adoption and marks it for regeneration', async () => {
    let stagedState = null;
    const service = backupService({
      afterStagedRestorePrepared: (stagingPath) => {
        const staged = new Database(stagingPath, { readonly: true });
        try {
          stagedState = {
            counts: rowCounts(staged),
            record: JSON.parse(staged.prepare('SELECT value FROM app_meta WHERE key = ?')
              .pluck().get(GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY)),
          };
        } finally { staged.close(); }
        // The live database has not been touched yet.
        expect(fs.existsSync(`${h.databasePath}.rollback`)).toBe(false);
      },
    });
    const { backup } = await populatedWithBackup(service);
    const treeBefore = listTree(h.previewRoot);

    const result = await service.restoreBackup(backup.filename, h.db, takeOwner());
    h.bind(result.db);

    expect(stagedState.counts).toEqual({ publications: 0, derivatives: 0, intents: 0 });
    expect(stagedState.record).toMatchObject({ mode: 'restore', phase: 'completed', repairRequired: true });
    expect(rowCounts(h.db)).toEqual({ publications: 0, derivatives: 0, intents: 0 });
    // Cache directories are ignored derived remnants, never deleted.
    expect(listTree(h.previewRoot)).toEqual(treeBefore);
    // The backup file itself is unchanged.
    const archived = new Database(path.join(resolveBackups(h), backup.filename), { readonly: true });
    try { expect(rowCounts(archived)).toMatchObject({ publications: 2, intents: 1 }); } finally { archived.close(); }
  });

  it('regenerates rather than importing the legacy cache after adoption', async () => {
    const service = backupService();
    const { project, asset, backup } = await populatedWithBackup(service);
    const result = await service.restoreBackup(backup.filename, h.db, takeOwner());
    h.bind(result.db);
    const counting = { ...h.preview, inspectLegacyPublication: vi.fn(h.preview.inspectLegacyPublication) };
    const rebuildService = fakeRebuild();

    const lifecycle = makeLifecycle(h, { previewService: counting, rebuildService });
    const readiness = await runLifecycle(lifecycle);

    expect(counting.inspectLegacyPublication).not.toHaveBeenCalled();
    expect(readiness.publicationIndexReady).toBe(true);
    expect(readiness.backfill).toMatchObject({ mode: 'restore', repairRequired: false });
    expect(rebuildService.queueRepair).toHaveBeenCalledTimes(1);
    expect(h.publications.findPublication(project.id, asset.id)).toBeNull();

    // The existing rebuild machinery republishes the row-less fresh pair.
    const rebuild = createGeneratedImageRebuildService({
      repository: createGeneratedImageRebuildRepository(h.db, h.appMeta),
      imageSettings: h.imageSettings, previewService: h.preview,
      maintenanceState: { active: false }, managedUploadTracker: createManagedUploadTracker(),
      schedule: () => null,
    });
    expect(rebuild.queueRepair()).toBe('queued');
    rebuild.signal();
    await rebuild.waitForIdle();
    expect(rebuild.readStatus()).toMatchObject({ phase: 'completed', reason: 'publication-repair' });
    const { pointer } = publishedMeta(h, project.id, asset.id);
    expect(h.publications.findPublication(project.id, asset.id).directoryName).toBe(pointer.dir);
  });

  it('preserves the original publication rows and intents when restore fails', async () => {
    const service = backupService({ afterStagedRestorePrepared: () => { throw new Error('crash before adoption'); } });
    const { project, asset, other, backup } = await populatedWithBackup(service);
    const committed = h.publications.findPublication(project.id, asset.id);
    const intent = h.publications.findIntent(project.id, other.id);
    const recordBefore = h.lifecycleRepo.get();

    const error = await service.restoreBackup(backup.filename, h.db, takeOwner()).catch((err) => err);

    expect(error).toBeInstanceOf(BackupError);
    h.bind(error.db);
    expect(h.publications.findPublication(project.id, asset.id)).toEqual(committed);
    expect(h.publications.findIntent(project.id, other.id)).toEqual(intent);
    expect(h.lifecycleRepo.get()).toMatchObject({ mode: recordBefore.mode, phase: recordBefore.phase });
    expect(fs.readdirSync(path.dirname(h.databasePath)).filter((name) => name.includes('.restoring-'))).toEqual([]);
  });

  it('only ever installs an already-reset staged database', async () => {
    // A crash at this point leaves exactly this staged file (the one that is
    // installed next) on disk: it already carries no publication state.
    const crashImage = path.join(h.tmpDir, 'crash-image.db');
    const service = backupService({
      afterStagedRestorePrepared: (stagingPath) => { fs.copyFileSync(stagingPath, crashImage); },
    });
    const { backup } = await populatedWithBackup(service);
    const result = await service.restoreBackup(backup.filename, h.db, takeOwner());
    h.bind(result.db);
    const staged = new Database(crashImage, { readonly: true });
    try {
      expect(rowCounts(staged)).toEqual({ publications: 0, derivatives: 0, intents: 0 });
    } finally { staged.close(); }
    expect(h.lifecycleRepo.get()).toMatchObject({ mode: 'restore', phase: 'completed' });
  });

  it('runs normal migrations on a restored pre-041 backup and still marks it for regeneration', async () => {
    const legacyMigrations = path.join(h.tmpDir, 'legacy-migrations');
    fs.mkdirSync(legacyMigrations);
    for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((file) => file < '041')) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(legacyMigrations, name));
    }
    const legacyPath = path.join(h.tmpDir, 'legacy.db');
    const legacy = openDatabase(legacyPath);
    runMigrations(legacy, legacyMigrations);
    const backupDir = resolveBackups(h);
    fs.mkdirSync(backupDir, { recursive: true });
    const filename = 'creatorcrate-2026-01-01T000000Z.sqlite';
    await legacy.backup(path.join(backupDir, filename));
    closeDatabase(legacy);
    const service = backupService();
    expect(service.validateBackup(filename)).toMatchObject({ valid: true });

    const result = await service.restoreBackup(filename, h.db, takeOwner());
    h.bind(result.db);

    expect(h.db.prepare("SELECT filename FROM schema_migrations WHERE filename LIKE '041%'").pluck().get())
      .toBe('041_add_generated_image_publications.sql');
    expect(rowCounts(h.db)).toEqual({ publications: 0, derivatives: 0, intents: 0 });
    expect(h.lifecycleRepo.get()).toMatchObject({ mode: 'restore', phase: 'completed', repairRequired: true });
  });
});

function resolveBackups(h) {
  return path.join(h.tmpDir, 'app', 'backups');
}

describe('generated-image publication lifecycle record', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  it('treats an untrusted record as regeneration, never as an unfinished import', () => {
    h.appMeta.setValue(GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY, '{"version":1,"mode":"upgrade"}');
    expect(h.lifecycleRepo.initialize()).toMatchObject({ mode: 'reset', phase: 'completed', repairRequired: true });
  });

  it('restore reset is one transaction over the three publication tables', () => {
    resetGeneratedImagePublicationsForRestore(h.db);
    expect(h.lifecycleRepo.get()).toMatchObject({ mode: 'restore', phase: 'completed' });
    expect(h.lifecycleRepo.isPublicationIndexReady()).toBe(true);
  });
});

describe('rebuild repair admission', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  const rebuild = () => createGeneratedImageRebuildService({
    repository: createGeneratedImageRebuildRepository(h.db, h.appMeta),
    imageSettings: h.imageSettings, previewService: h.preview,
    maintenanceState: { active: false }, managedUploadTracker: createManagedUploadTracker(),
    schedule: () => null,
  });

  it('coalesces with an unstarted repair pass and defers to a started manual run', async () => {
    const service = rebuild();
    expect(service.queueRepair()).toBe('queued');
    expect(service.readStatus()).toMatchObject({ mode: 'automatic', phase: 'queued', reconcileAll: true });
    expect(service.queueRepair()).toBe('covered');

    service.queueManual();
    const repository = createGeneratedImageRebuildRepository(h.db, h.appMeta);
    repository.save({ ...repository.get(), phase: 'running', started: true });
    expect(service.queueRepair()).toBe('deferred');

    // The lifecycle keeps a deferred need durable for a later admission.
    h.lifecycleRepo.initialize();
    h.lifecycleRepo.complete();
    const lifecycle = makeLifecycle(h, { rebuildService: service });
    expect(lifecycle.requestRepair()).toBe('deferred');
    expect(h.lifecycleRepo.get().repairRequired).toBe(true);
  });

  // A completed index, published assets, and a real rebuild service whose
  // terminal-run hook signals the real lifecycle, as app.js wires it.
  async function deferredRepairFixture({ names = ['target.png'], previewService = null, repository = null,
    schedule = () => null, onTerminal = null } = {}) {
    h.lifecycleRepo.initialize();
    h.lifecycleRepo.complete();
    const ctx = h.createProject(`Deferred ${crypto.randomBytes(3).toString('hex')}`);
    const assets = [];
    for (const [index, name] of names.entries()) {
      const asset = await h.addAsset(ctx, name, { r: 40 * index, g: 120, b: 200 });
      await h.preview.getPreview(ctx.project.id, asset.id);
      assets.push(asset);
    }
    let lifecycle = null;
    const service = createGeneratedImageRebuildService({
      repository: repository ?? createGeneratedImageRebuildRepository(h.db, h.appMeta),
      imageSettings: h.imageSettings, previewService: previewService ?? h.preview,
      maintenanceState: { active: false }, managedUploadTracker: createManagedUploadTracker(),
      schedule,
      onRunTerminal: (run) => { onTerminal?.(run, service); lifecycle.signal(); },
    });
    const queueRepair = vi.spyOn(service, 'queueRepair');
    lifecycle = makeLifecycle(h, { rebuildService: service });
    lifecycle.prepare();
    return { project: ctx.project, assets, service, lifecycle, queueRepair };
  }

  it('re-admits a repair deferred to a started manual run once that run completes', async () => {
    let reachedLater;
    const reached = new Promise((resolve) => { reachedLater = resolve; });
    let releaseLater;
    const gate = new Promise((resolve) => { releaseLater = resolve; });
    let gated = false;
    let fixture = null;
    const previewService = {
      ...h.preview,
      ensureTargetGeneration: async (projectId, assetId, ...rest) => {
        if (assetId === fixture.assets[1].id && !gated) { gated = true; reachedLater(); await gate; }
        return h.preview.ensureTargetGeneration(projectId, assetId, ...rest);
      },
    };
    fixture = await deferredRepairFixture({ names: ['target.png', 'later.png'], previewService });
    const { project, assets: [target], service, lifecycle, queueRepair } = fixture;

    service.queueManual();
    service.signal();
    await reached;
    const manual = service.readStatus();
    // The manual run has already checkpointed past the repair target.
    expect(manual).toMatchObject({ mode: 'manual', phase: 'running', cursor: target.id });

    h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(target.id);
    expect(lifecycle.requestRepair()).toBe('deferred');
    expect(h.lifecycleRepo.get().repairRequired).toBe(true);

    releaseLater();
    await settleAll(service, lifecycle);

    expect(queueRepair.mock.results.map((result) => result.value)).toEqual(['deferred', 'queued']);
    expect(h.lifecycleRepo.get().repairRequired).toBe(false);
    const repair = service.readStatus();
    expect(repair).toMatchObject({ mode: 'automatic', reason: 'publication-repair', reconcileAll: true,
      phase: 'completed' });
    expect(repair.runId).not.toBe(manual.runId);
    const { pointer } = publishedMeta(h, project.id, target.id);
    expect(h.publications.findPublication(project.id, target.id).directoryName).toBe(pointer.dir);
  });

  it('re-admits a deferred repair when the blocking manual run ends failed', async () => {
    const base = createGeneratedImageRebuildRepository(h.db, h.appMeta);
    // Every page read of the manual run is a control fault: the bounded
    // runner retry policy ends that run 'failed'.
    const repository = { ...base, page: (...args) => {
      if (base.get()?.mode === 'manual') throw new Error('volume unavailable');
      return base.page(...args);
    } };
    const timers = [];
    const terminal = [];
    const { project, assets: [target], service, lifecycle, queueRepair } = await deferredRepairFixture({
      repository, schedule: (callback) => { timers.push(callback); return null; },
      onTerminal: (run) => terminal.push(run),
    });

    service.queueManual();
    service.signal();
    await service.waitForIdle();
    expect(service.readStatus()).toMatchObject({ mode: 'manual', phase: 'running', started: true });
    h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(target.id);
    expect(lifecycle.requestRepair()).toBe('deferred');

    let retries = 0;
    while (timers.length) {
      retries++;
      timers.shift()();
      await settleAll(service, lifecycle);
    }

    expect(retries).toBe(3);
    expect(terminal[0]).toMatchObject({ mode: 'manual', phase: 'failed' });
    expect(queueRepair.mock.results.map((result) => result.value)).toEqual(['deferred', 'queued']);
    expect(h.lifecycleRepo.get().repairRequired).toBe(false);
    expect(service.readStatus()).toMatchObject({ reason: 'publication-repair', phase: 'completed' });
    expect(h.publications.findPublication(project.id, target.id)).not.toBeNull();
  });

  it('admits no second run when a pending run already covers the deferred repair', async () => {
    let followUp = null;
    const { service, lifecycle, queueRepair } = await deferredRepairFixture({
      // A new manual rebuild is queued the moment the blocking one ends.
      onTerminal: (run, rebuild) => {
        if (run.mode === 'manual' && !followUp) { rebuild.queueManual(); followUp = rebuild.readStatus().runId; }
      },
    });
    service.queueManual();
    const repository = createGeneratedImageRebuildRepository(h.db, h.appMeta);
    repository.save({ ...repository.get(), phase: 'running', started: true });
    expect(lifecycle.requestRepair()).toBe('deferred');

    service.signal();
    await settleAll(service, lifecycle);

    expect(queueRepair.mock.results.map((result) => result.value)).toEqual(['deferred', 'covered']);
    expect(h.lifecycleRepo.get().repairRequired).toBe(false);
    expect(service.readStatus()).toMatchObject({ runId: followUp, mode: 'manual', phase: 'queued' });
  });
});

describe('application context startup ordering', () => {
  it('prepares the publication lifecycle after migrations and rebuild recovery, before any runner', async () => {
    const { createApplicationContext } = await import('../src/app-context.js');
    const calls = [];
    let graphs = 0;
    const service = (tag) => ({
      recover: () => calls.push(`${tag}.recover`),
      prepare: () => calls.push(`${tag}.prepare`),
      signal: () => calls.push(`${tag}.signal`),
      stop: () => calls.push(`${tag}.stop`),
      pauseForMaintenance: () => {
        calls.push(`${tag}.pause`);
        return { waitForIdle: async () => calls.push(`${tag}.idle`), release: () => calls.push(`${tag}.release`) };
      },
    });
    const appFactory = () => {
      const graph = ++graphs;
      const app = () => {};
      app.locals = {
        generatedImageRebuildService: service(`rebuild${graph}`),
        generatedImagePublicationLifecycle: service(`lifecycle${graph}`),
      };
      return app;
    };
    const initialDb = new Database(':memory:');
    const context = createApplicationContext({ appName: 'CreatorCrate' }, initialDb, appFactory);
    expect(calls).toEqual(['rebuild1.recover', 'lifecycle1.prepare', 'rebuild1.signal', 'lifecycle1.signal']);

    calls.length = 0;
    const replacementDb = new Database(':memory:');
    context.replaceDatabase(replacementDb);
    expect(calls).toEqual([
      'rebuild1.pause', 'lifecycle1.pause',
      'rebuild2.recover', 'lifecycle2.prepare',
      'rebuild1.stop', 'lifecycle1.stop',
      'rebuild1.release', 'lifecycle1.release',
      'rebuild2.signal', 'lifecycle2.signal',
    ]);
    expect(context.generatedImagePublicationLifecycle).toBe(context.app.locals.generatedImagePublicationLifecycle);

    calls.length = 0;
    const owner = await context.beginReplacementAfterRebuild();
    expect(calls).toEqual(['rebuild2.pause', 'lifecycle2.pause', 'rebuild2.idle', 'lifecycle2.idle']);
    owner.release();
    initialDb.close();
    replacementDb.close();
  });
});
