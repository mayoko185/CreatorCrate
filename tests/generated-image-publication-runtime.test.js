// GI-4 — the committed SQLite publication is the normal runtime authority.
//
// Every normal generated-image consumer (presentation, the locked serving
// path, ensureCurrentPreview, automatic target probes, selective reuse)
// resolves the committed snapshot from SQLite and never inspects
// current.json or the revision-local meta.json. Filesystem operations are
// recorded by exact target path and attributed to a phase, so the legitimate
// JSON activity of publication (the journaling writer), intent recovery, and
// the one-time backfill stays distinguishable from the request/probe phase,
// which must perform none. Source and derivative bytes remain on disk and are
// still read and validated; only the publication JSON leaves the read path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
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
import { createGeneratedImagePublicationLifecycleService } from '../src/services/generated-image-publication-lifecycle-service.js';
import { createProjectImageSettingsService } from '../src/services/project-image-settings-service.js';
import { createManagedUploadTracker } from '../src/services/managed-upload-tracker.js';
import { createMediaService, MediaUnavailableError } from '../src/services/media-service.js';
import {
  createPreviewService,
  PreviewPublicationJournalError,
  PreviewPublicationNotReadyError,
} from '../src/services/preview-service.js';
import { formatProjectDirName } from '../src/storage/project-storage.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';
import {
  CURRENT_POINTER_FILENAME,
  META_FILENAME,
  getCacheDir,
  readCurrentPointer,
  buildRevisionDirName,
} from '../src/storage/preview-cache.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PUBLICATION_JSON = new Set([CURRENT_POINTER_FILENAME, META_FILENAME]);

async function makePng(width, height, { r = 80, g = 120, b = 200 } = {}) {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

// ─── Filesystem operation accounting ─────────────────────────────────────
//
// Every path-taking fs call (sync, callback, and promise forms of reads,
// opens, stat/lstat, access, existence, realpath, and streams) is recorded
// with its resolved target and the phase active when it was made. Calls on
// descriptors carry no path and are not attributed.

const SYNC_METHODS = ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'accessSync', 'existsSync',
  'realpathSync', 'createReadStream', 'readFile', 'open', 'stat', 'lstat', 'access', 'realpath'];
const PROMISE_METHODS = ['readFile', 'open', 'stat', 'lstat', 'access', 'realpath'];

function recordFilesystem() {
  const ops = [];
  const spies = [];
  const recorder = {
    phase: 'setup',
    ops,
    /** Publication-JSON operations (current.json / meta.json), optionally in some phases. */
    jsonOps(phases = null) {
      return ops.filter((op) => PUBLICATION_JSON.has(path.basename(op.target))
        && (!phases || phases.includes(op.phase)));
    },
    /** Operations whose target lies at or under `target`. */
    touching(target, phases = null) {
      const root = path.resolve(target);
      return ops.filter((op) => (op.target === root || op.target.startsWith(root + path.sep))
        && (!phases || phases.includes(op.phase)));
    },
    reads(target, phases = null) {
      const resolved = path.resolve(target);
      return ops.filter((op) => op.target === resolved && op.method.includes('readFile')
        && (!phases || phases.includes(op.phase))).length;
    },
    restore() { for (const spy of spies.splice(0)) spy.mockRestore(); },
  };
  const wrap = (owner, method, label) => {
    const real = owner[method];
    if (typeof real !== 'function') return;
    spies.push(vi.spyOn(owner, method).mockImplementation(function (target, ...rest) {
      if (typeof target === 'string') ops.push({ phase: recorder.phase, method: label, target: path.resolve(target) });
      return real.call(this, target, ...rest);
    }));
  };
  for (const method of SYNC_METHODS) wrap(fs, method, method);
  for (const method of PROMISE_METHODS) wrap(fs.promises, method, `promises.${method}`);
  return recorder;
}

// Test hooks that move the recorder out of the request/probe phase exactly
// when the journaling writer starts (staging) and when it starts writing the
// staged publication metadata; reuse discovery happens in between.
function phaseHooks(recorder, extra = {}) {
  return {
    ...extra,
    onStagingCreated: async (...args) => {
      recorder.phase = 'generation';
      await extra.onStagingCreated?.(...args);
    },
    beforeMetaWrite: async (...args) => {
      recorder.phase = 'publication';
      await extra.beforeMetaWrite?.(...args);
    },
  };
}

function makeGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function within(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle`)), ms); }),
  ]);
}

// ─── Harness ─────────────────────────────────────────────────────────────

function makeHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gi-runtime-'));
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
    /** An ordinary restart: a new connection and a new service graph. */
    restart() {
      closeDatabase(db);
      h.bind(openDatabase(databasePath));
    },
    createProject(title) {
      let project = h.projectRepo.create({
        title, slug: slugify(title, { lowercase: true }), description: '', notes: '', status: 'tbd',
        projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const relPath = formatProjectDirName(project.id, project.slug);
      const absPath = path.resolve(projectsRoot, relPath);
      fs.mkdirSync(absPath, { recursive: true });
      project = h.projectRepo.setProjectDir(project.id, relPath);
      // Bound like real creation: source reconciliation is ownership-gated.
      bindTestProjectOwnership(db, project.id, absPath);
      return { project, absPath };
    },
    async addAsset(ctx, name, color) {
      const target = path.join(ctx.absPath, name);
      fs.writeFileSync(target, await makePng(640, 480, color));
      const stat = fs.statSync(target);
      return h.assetRepo.upsert(ctx.project.id, name, {
        filename: name, extension: 'png', mimeType: 'image/png',
        sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sourceAnimated: false,
      });
    },
    set(key, value) { h.appMeta.setValue(key, String(value)); },
    cleanup() {
      try { closeDatabase(db); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
  h.bind(db);
  // The one-time upgrade backfill has already completed (an ordinary install).
  h.lifecycleRepo.initialize();
  h.lifecycleRepo.complete();
  return h;
}

/** A committed publication written by the journaling writer. */
async function published(h, name = 'art.png', color) {
  const ctx = h.createProject(`Runtime ${name} ${crypto.randomBytes(3).toString('hex')}`);
  const asset = await h.addAsset(ctx, name, color);
  await h.preview.getPreview(ctx.project.id, asset.id);
  const committed = h.publications.findPublication(ctx.project.id, asset.id);
  const root = getCacheDir(h.previewRoot, ctx.project.id, asset.id);
  return { project: ctx.project, asset, committed, root, dir: path.join(root, committed.directoryName) };
}

function revisionDirs(root) {
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.startsWith('r-')).sort() : [];
}

function makeLifecycle(h) {
  return createGeneratedImagePublicationLifecycleService({
    repository: h.lifecycleRepo,
    publications: h.publications,
    previewService: h.preview,
    rebuildService: { queueRepair: vi.fn(() => 'queued'), signal: vi.fn() },
    managedUploadTracker: createManagedUploadTracker(),
    schedule: () => null,
  });
}

// ─── Normal serving ──────────────────────────────────────────────────────

describe('GI-4 runtime publication authority — normal serving', () => {
  let h;
  let recorder;
  beforeEach(() => { h = makeHarness(); recorder = null; });
  afterEach(() => { recorder?.restore(); h.cleanup(); });

  it('A: serves the first request after an ordinary restart from SQLite with zero publication-JSON operations', async () => {
    const state = await published(h);
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const thumbnail = await h.preview.getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    expect(thumbnail).toMatchObject({ status: 'ready', cacheState: 'fresh', revision: state.committed.revision });
    expect(thumbnail.path).toBe(path.join(state.dir, 'thumbnail.webp'));
    expect(fs.statSync(thumbnail.path).size).toBe(thumbnail.bytes);
    expect(recorder.jsonOps()).toEqual([]);
    // The derivative's actual bytes were still read and validated.
    expect(recorder.reads(thumbnail.path)).toBeGreaterThan(0);
  });

  it('B: repeated requests, including from another fresh instance, perform zero publication-JSON operations', async () => {
    const state = await published(h);
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const first = await h.preview.getPreview(state.project.id, state.asset.id);
    const second = await h.preview.getPreview(state.project.id, state.asset.id);
    const third = await h.makePreview().getPreview(state.project.id, state.asset.id);
    recorder.restore();

    for (const result of [first, second, third]) {
      expect(result).toMatchObject({ cacheState: 'fresh', revision: state.committed.revision });
      expect(result.path).toBe(path.join(state.dir, 'preview.webp'));
    }
    expect(recorder.jsonOps()).toEqual([]);
    // No memory cache: every request re-validates the derivative bytes.
    expect(recorder.reads(first.path)).toBeGreaterThanOrEqual(3);
  });

  it('C: Thumbnail then Preview use one committed publication, each validating its own derivative', async () => {
    const state = await published(h);
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'thumbnail';
    const thumbnail = await h.preview.getThumbnail(state.project.id, state.asset.id);
    recorder.phase = 'preview';
    const preview = await h.preview.getPreview(state.project.id, state.asset.id);
    recorder.restore();

    expect(path.dirname(thumbnail.path)).toBe(state.dir);
    expect(path.dirname(preview.path)).toBe(state.dir);
    expect(thumbnail.revision).toBe(preview.revision);
    expect(recorder.reads(thumbnail.path, ['thumbnail'])).toBeGreaterThan(0);
    expect(recorder.reads(preview.path, ['preview'])).toBeGreaterThan(0);
    expect(recorder.jsonOps()).toEqual([]);
  });

  it('E: a pending intent for candidate B neither hides committed A nor makes the request wait or look at B', async () => {
    const state = await published(h);
    // Candidate B: same revision token, another directory, fully on disk
    // (with its own meta.json), and journaled as an unresolved intent.
    const candidate = buildRevisionDirName(state.committed.revision);
    fs.cpSync(state.dir, path.join(state.root, candidate), { recursive: true });
    h.publications.acquireIntent({
      projectId: state.project.id, assetId: state.asset.id,
      candidateDirectoryName: candidate, stagingDirectoryName: 'tmp-abcdef012345',
      expectedRevision: state.committed.revision, previousDirectoryName: state.committed.directoryName,
    });
    h.restart();
    // The asset's publication lock is held for the whole request: a reader
    // that joined candidate publication would never settle.
    const gate = makeGate();
    const held = h.preview.withPublicationLock(state.project.id, state.asset.id, () => gate.promise);

    recorder = recordFilesystem();
    recorder.phase = 'request';
    try {
      const preview = await within(h.preview.getPreview(state.project.id, state.asset.id), 5000, 'preview');
      const thumbnail = await within(h.preview.getThumbnail(state.project.id, state.asset.id), 5000, 'thumbnail');
      expect(preview.path).toBe(path.join(state.dir, 'preview.webp'));
      expect(thumbnail.path).toBe(path.join(state.dir, 'thumbnail.webp'));
      expect(preview.revision).toBe(state.committed.revision);
    } finally {
      recorder.restore();
      gate.release();
      await held;
    }
    expect(recorder.jsonOps()).toEqual([]);
    expect(recorder.touching(path.join(state.root, candidate))).toEqual([]);
    expect(h.publications.findIntent(state.project.id, state.asset.id)).not.toBeNull();
  });

  it('F/G: after current.json names candidate B but before finalization A is served; finalization switches to B', async () => {
    const state = await published(h);
    // A force rebuild of the same source publishes B (same revision token,
    // new directory) and switches current.json, but SQLite finalization fails.
    const failing = { ...h.publications, finalizePublication: () => { throw new Error('database busy'); } };
    const writer = h.makePreview({ generatedImagePublicationRepository: failing });
    await expect(writer.ensureTargetGeneration(state.project.id, state.asset.id, h.imageSettings.getPolicy(),
      () => true, { force: true })).rejects.toBeInstanceOf(PreviewPublicationJournalError);
    const intent = h.publications.findIntent(state.project.id, state.asset.id);
    expect(intent.expectedRevision).toBe(state.committed.revision);
    expect(intent.candidateDirectoryName).not.toBe(state.committed.directoryName);
    expect(readCurrentPointer(h.previewRoot, state.project.id, state.asset.id).pointer.dir)
      .toBe(intent.candidateDirectoryName);
    const candidateDir = path.join(state.root, intent.candidateDirectoryName);
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'before-finalization';
    const before = await h.preview.getPreview(state.project.id, state.asset.id);
    const beforeThumb = await h.preview.getThumbnail(state.project.id, state.asset.id);
    expect(before.path).toBe(path.join(state.dir, 'preview.webp'));
    expect(beforeThumb.path).toBe(path.join(state.dir, 'thumbnail.webp'));
    expect(before.revision).toBe(state.committed.revision);

    // Explicit intent recovery finalizes B; it legitimately reads the JSON.
    recorder.phase = 'recovery';
    const lifecycle = makeLifecycle(h);
    lifecycle.prepare();
    lifecycle.signal();
    await lifecycle.waitForIdle();
    expect(h.publications.findIntent(state.project.id, state.asset.id)).toBeNull();
    expect(h.publications.findPublication(state.project.id, state.asset.id).directoryName)
      .toBe(intent.candidateDirectoryName);

    recorder.phase = 'after-finalization';
    const after = await h.preview.getPreview(state.project.id, state.asset.id);
    recorder.restore();

    expect(after.path).toBe(path.join(candidateDir, 'preview.webp'));
    expect(after.revision).toBe(state.committed.revision); // same token, other directory
    expect(recorder.jsonOps(['before-finalization', 'after-finalization'])).toEqual([]);
    expect(recorder.touching(candidateDir, ['before-finalization'])).toEqual([]);
    expect(recorder.jsonOps(['recovery']).length).toBeGreaterThan(0);
  });

  it('G: a finalized same-token force rebuild is served from its new directory without JSON lookup', async () => {
    const state = await published(h);
    const rebuilt = await h.preview.ensureTargetGeneration(state.project.id, state.asset.id,
      h.imageSettings.getPolicy(), () => true, { force: true });
    expect(rebuilt).toMatchObject({ cacheState: 'regenerated', revision: state.committed.revision });
    const committed = h.publications.findPublication(state.project.id, state.asset.id);
    expect(committed.directoryName).not.toBe(state.committed.directoryName);
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const served = await h.preview.getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    expect(served.path).toBe(path.join(state.root, committed.directoryName, 'thumbnail.webp'));
    expect(served.revision).toBe(state.committed.revision);
    expect(recorder.jsonOps()).toEqual([]);
    expect(recorder.touching(state.dir)).toEqual([]);
  });

  it('serves ensureCurrentPreview from SQLite with zero publication-JSON operations', async () => {
    const state = await published(h);
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.preview.ensureCurrentPreview(state.project.id, state.asset.id);
    recorder.restore();

    expect(result).toMatchObject({ cacheState: 'fresh', revision: state.committed.revision });
    expect(result.path).toBe(path.join(state.dir, 'preview.webp'));
    expect(recorder.jsonOps()).toEqual([]);
  });

  it('A (HTTP): the first media request after an application restart touches no publication JSON', async () => {
    const appDataRoot = path.join(h.tmpDir, 'app');
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const build = () => createApp({ appName: 'CreatorCrate', db: h.db, projectsRoot: h.projectsRoot,
      previewRoot: h.previewRoot }, { appDataRoot, authState: { csrfPepper } });
    const stop = async (app) => {
      app.locals.generatedImageRebuildService?.stop();
      app.locals.generatedImagePublicationLifecycle?.stop();
      await app.locals.generatedImageRebuildService?.waitForIdle();
      await app.locals.generatedImagePublicationLifecycle?.waitForIdle();
    };
    const ctx = h.createProject('Runtime HTTP');
    const asset = await h.addAsset(ctx, 'http.png');
    const url = `/projects/${ctx.project.id}/assets/${asset.id}/thumbnail`;

    const first = build();
    await first.locals.generatedImagePublicationLifecycle.waitForIdle();
    await request(first).get(url).expect(200);
    await stop(first);
    const committed = h.publications.findPublication(ctx.project.id, asset.id);
    h.restart();

    const restarted = build();
    await restarted.locals.generatedImagePublicationLifecycle.waitForIdle();
    await restarted.locals.generatedImageRebuildService.waitForIdle();
    try {
      recorder = recordFilesystem();
      recorder.phase = 'request';
      const response = await request(restarted).get(url).expect(200);
      recorder.restore();

      const onDisk = path.join(getCacheDir(h.previewRoot, ctx.project.id, asset.id), committed.directoryName,
        'thumbnail.webp');
      expect(Buffer.compare(response.body, fs.readFileSync(onDisk))).toBe(0);
      expect(recorder.jsonOps()).toEqual([]);
    } finally {
      await stop(restarted);
    }
  });
});

// ─── Prior-policy fallback ───────────────────────────────────────────────

describe('GI-4 runtime publication authority — prior-policy fallback', () => {
  let h;
  let recorder;
  beforeEach(() => { h = makeHarness(); recorder = null; });
  afterEach(() => { recorder?.restore(); h.cleanup(); });

  it('D: serves a committed prior-policy pair with its own revision after validating both derivatives', async () => {
    const state = await published(h);
    h.set('images.thumbnail.format', 'png');
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const thumbnail = await h.preview.getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    expect(thumbnail).toMatchObject({ cacheState: 'prior-policy', revision: state.committed.revision,
      mimeType: 'image/webp' });
    expect(thumbnail.path).toBe(path.join(state.dir, 'thumbnail.webp'));
    expect(recorder.reads(path.join(state.dir, 'thumbnail.webp'))).toBeGreaterThan(0);
    expect(recorder.reads(path.join(state.dir, 'preview.webp'))).toBeGreaterThan(0);
    expect(recorder.jsonOps()).toEqual([]);
  });

  it('D: does not serve a committed pair without a recorded policy fingerprint as prior-policy', async () => {
    const state = await published(h);
    h.db.prepare('UPDATE generated_image_publications SET policy_fingerprint = NULL WHERE asset_id = ?')
      .run(state.asset.id);
    h.set('images.thumbnail.format', 'png');

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.makePreview({ _hooks: phaseHooks(recorder) })
      .getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    expect(result.cacheState).toBe('regenerated');
    expect(result.mimeType).toBe('image/png');
    expect(path.dirname(result.path)).not.toBe(state.dir);
    expect(recorder.jsonOps(['request'])).toEqual([]);
    expect(recorder.touching(path.join(state.dir, META_FILENAME))).toEqual([]);
  });

  it('D: source authority still applies to a prior-policy pair', async () => {
    const state = await published(h);
    h.set('images.thumbnail.format', 'png');
    // The source changes on disk (over SMB, say) and the row is rescanned.
    const ctxPath = path.join(h.projectsRoot, state.project.project_dir, state.asset.relative_path);
    fs.writeFileSync(ctxPath, await makePng(500, 400, { r: 9, g: 9, b: 9 }));
    const pinned = new Date('2026-08-15T10:00:00Z');
    fs.utimesSync(ctxPath, pinned, pinned);
    const stat = fs.statSync(ctxPath);
    h.assetRepo.upsert(state.project.id, state.asset.relative_path, {
      filename: state.asset.filename, extension: 'png', mimeType: 'image/png',
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sourceAnimated: false,
    });

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.makePreview({ _hooks: phaseHooks(recorder) })
      .getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    expect(result.cacheState).toBe('regenerated');
    expect(result.revision).not.toBe(state.committed.revision);
    expect(recorder.jsonOps(['request'])).toEqual([]);
  });

  it('D: a GIF without recorded source animation admits no prior-policy pair', async () => {
    const ctx = h.createProject('Runtime gif');
    const sharp = (await import('sharp')).default;
    const target = path.join(ctx.absPath, 'still.gif');
    fs.writeFileSync(target, await sharp({ create: { width: 40, height: 30, channels: 3,
      background: '#ffffff' } }).gif().toBuffer());
    const stat = fs.statSync(target);
    const asset = h.assetRepo.upsert(ctx.project.id, 'still.gif', {
      filename: 'still.gif', extension: 'gif', mimeType: 'image/gif',
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sourceAnimated: false,
    });
    await h.preview.getPreview(ctx.project.id, asset.id);
    const committed = h.publications.findPublication(ctx.project.id, asset.id);
    h.db.prepare('UPDATE assets SET source_animated = NULL WHERE id = ?').run(asset.id);
    h.set('images.thumbnail.format', 'png');

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.makePreview({ _hooks: phaseHooks(recorder) }).getThumbnail(ctx.project.id, asset.id);
    recorder.restore();

    expect(result.cacheState).not.toBe('prior-policy');
    expect(path.basename(path.dirname(result.path))).not.toBe(committed.directoryName);
    expect(recorder.jsonOps(['request'])).toEqual([]);
  });
});

// ─── Missing / damaged publication state ─────────────────────────────────

describe('GI-4 runtime publication authority — missing or damaged publication state', () => {
  let h;
  let recorder;
  beforeEach(() => { h = makeHarness(); recorder = null; });
  afterEach(() => { recorder?.restore(); h.cleanup(); });

  it('H: never reads or serves legacy JSON output when the committed row is missing', async () => {
    const state = await published(h);
    h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(state.asset.id);
    const legacyMeta = path.join(state.dir, META_FILENAME);
    expect(fs.existsSync(legacyMeta)).toBe(true);

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.makePreview({ _hooks: phaseHooks(recorder) })
      .getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    // Republished through the journal, not served from the legacy directory.
    expect(result.cacheState).toBe('regenerated');
    expect(path.dirname(result.path)).not.toBe(state.dir);
    expect(h.publications.findPublication(state.project.id, state.asset.id).directoryName)
      .toBe(path.basename(path.dirname(result.path)));
    expect(recorder.jsonOps(['request'])).toEqual([]);
    expect(recorder.touching(legacyMeta)).toEqual([]);
    expect(recorder.touching(state.dir, ['request'])).toEqual([]);
    // The request neither fabricated DB state from JSON nor touched the lifecycle.
    expect(h.lifecycleRepo.get()).toMatchObject({ phase: 'completed', repairRequired: false });
  });

  it.each([
    ['corrupt (same size, undecodable)', (file) => fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 0x41))],
    ['wrong size', (file) => fs.appendFileSync(file, Buffer.from('extra'))],
    ['missing', (file) => fs.rmSync(file)],
  ])('I: a committed row with a %s derivative is never served and is republished without JSON recovery',
    async (_label, damage) => {
      const state = await published(h);
      damage(path.join(state.dir, 'preview.webp'));

      recorder = recordFilesystem();
      recorder.phase = 'request';
      const result = await h.makePreview({ _hooks: phaseHooks(recorder) })
        .getPreview(state.project.id, state.asset.id);
      recorder.restore();

      expect(result.cacheState).toBe('regenerated');
      expect(path.dirname(result.path)).not.toBe(state.dir);
      const sharp = (await import('sharp')).default;
      expect((await sharp(fs.readFileSync(result.path)).metadata()).format).toBe('webp');
      expect(recorder.jsonOps(['request'])).toEqual([]);
      expect(recorder.touching(path.join(state.dir, META_FILENAME))).toEqual([]);
    });

  it('J: a deleted preview root is regenerated from the committed rows without JSON lookup', async () => {
    const state = await published(h);
    fs.rmSync(h.previewRoot, { recursive: true, force: true });

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.makePreview({ _hooks: phaseHooks(recorder) })
      .getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    expect(result.cacheState).toBe('regenerated');
    expect(fs.existsSync(result.path)).toBe(true);
    expect(h.publications.findPublication(state.project.id, state.asset.id).directoryName)
      .toBe(path.basename(path.dirname(result.path)));
    expect(recorder.jsonOps(['request'])).toEqual([]);
  });

  it('O: after a restore reset, surviving host-cache JSON is never read or served by a request', async () => {
    const state = await published(h);
    resetGeneratedImagePublicationsForRestore(h.db);
    h.restart();
    expect(h.lifecycleRepo.get()).toMatchObject({ mode: 'restore', phase: 'completed', repairRequired: true });

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.makePreview({ _hooks: phaseHooks(recorder) })
      .getPreview(state.project.id, state.asset.id);
    recorder.restore();

    expect(result.cacheState).toBe('regenerated');
    expect(path.dirname(result.path)).not.toBe(state.dir);
    expect(recorder.jsonOps(['request'])).toEqual([]);
    expect(recorder.touching(state.dir, ['request'])).toEqual([]);
    expect(recorder.touching(path.join(state.dir, META_FILENAME))).toEqual([]);
    // Nothing was imported; the durable repair need stays the lifecycle's.
    expect(h.lifecycleRepo.get()).toMatchObject({ mode: 'restore', repairRequired: true });
  });
});

// ─── Publication-index readiness ─────────────────────────────────────────

describe('GI-4 runtime publication authority — index readiness', () => {
  let h;
  let recorder;
  beforeEach(() => { h = makeHarness(); recorder = null; });
  afterEach(() => { recorder?.restore(); h.cleanup(); });

  // An install whose one-time upgrade backfill has not completed yet.
  function upgradeRunning() {
    h.db.prepare('DELETE FROM app_meta WHERE key = ?').run(GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY);
    h.lifecycleRepo.initialize();
    expect(h.lifecycleRepo.isPublicationIndexReady()).toBe(false);
  }

  it('N: refuses a row-less asset as not ready, without JSON fallback or generation', async () => {
    const state = await published(h);
    h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(state.asset.id);
    upgradeRunning();
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const error = await h.preview.getThumbnail(state.project.id, state.asset.id).catch((err) => err);
    const ensured = await h.preview.ensureCurrentPreview(state.project.id, state.asset.id).catch((err) => err);
    const media = createMediaService({ previewService: h.preview, projectsRoot: h.projectsRoot,
      previewRoot: h.previewRoot });
    const mediaError = await media.prepareDerivativeResponse('preview', state.project.id, state.asset.id)
      .catch((err) => err);
    recorder.restore();

    expect(error).toBeInstanceOf(PreviewPublicationNotReadyError);
    expect(ensured).toBeInstanceOf(PreviewPublicationNotReadyError);
    expect(mediaError).toBeInstanceOf(MediaUnavailableError);
    expect(mediaError.status).toBe(503);
    expect(recorder.jsonOps()).toEqual([]);
    expect(recorder.touching(state.dir)).toEqual([]);
    expect(revisionDirs(state.root)).toEqual([state.committed.directoryName]);
    expect(h.publications.findPublication(state.project.id, state.asset.id)).toBeNull();
  });

  it('N: serves an already committed publication while the backfill is still running', async () => {
    const state = await published(h);
    upgradeRunning();
    h.restart();

    recorder = recordFilesystem();
    recorder.phase = 'request';
    const result = await h.preview.getThumbnail(state.project.id, state.asset.id);
    recorder.restore();

    expect(result).toMatchObject({ cacheState: 'fresh', revision: state.committed.revision });
    expect(recorder.jsonOps()).toEqual([]);
  });
});

// ─── Rebuild probes, reuse, and force ────────────────────────────────────

describe('GI-4 runtime publication authority — rebuild', () => {
  let h;
  let recorder;
  beforeEach(() => { h = makeHarness(); recorder = null; });
  afterEach(() => { recorder?.restore(); h.cleanup(); });

  it('K: an automatic target probe of a fresh publication needs no rebuild and no publication JSON', async () => {
    const state = await published(h);
    h.restart();
    let staged = 0;

    recorder = recordFilesystem();
    recorder.phase = 'probe';
    const service = h.makePreview({ _hooks: phaseHooks(recorder, { onStagingCreated: () => { staged++; } }) });
    const result = await service.ensureTargetGeneration(state.project.id, state.asset.id,
      h.imageSettings.getPolicy());
    recorder.restore();

    expect(result).toMatchObject({ status: 'ready', revision: state.committed.revision });
    expect(result.cacheState).toBeUndefined();
    expect(staged).toBe(0);
    expect(recorder.jsonOps()).toEqual([]);
    expect(recorder.reads(path.join(state.dir, 'thumbnail.webp'))).toBeGreaterThan(0);
    expect(recorder.reads(path.join(state.dir, 'preview.webp'))).toBeGreaterThan(0);
  });

  it('K: a stale or missing publication enters generation after a JSON-free probe', async () => {
    const stale = await published(h, 'stale.png');
    const missing = await published(h, 'missing.png', { r: 10, g: 200, b: 10 });
    h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(missing.asset.id);
    h.set('images.preview.max_dimension', 320);

    for (const state of [stale, missing]) {
      recorder = recordFilesystem();
      recorder.phase = 'probe';
      const service = h.makePreview({ _hooks: phaseHooks(recorder) });
      const result = await service.ensureTargetGeneration(state.project.id, state.asset.id,
        h.imageSettings.getPolicy());
      recorder.restore();

      expect(result.cacheState).toBe('regenerated');
      expect(recorder.jsonOps(['probe'])).toEqual([]);
      // Only the journaling writer touches the publication JSON.
      expect(recorder.jsonOps(['publication']).length).toBeGreaterThan(0);
      expect(recorder.touching(path.join(state.dir, META_FILENAME))).toEqual([]);
    }
  });

  it('L: selective reuse takes eligibility from the committed row and still validates the copied bytes', async () => {
    const state = await published(h);
    h.set('images.preview.webp_quality', 40);
    const staged = [];

    recorder = recordFilesystem();
    recorder.phase = 'probe';
    const service = h.makePreview({ _hooks: phaseHooks(recorder, {
      onStagingCreated: () => { recorder.phase = 'reuse'; },
      onDerivativeStaged: (kind, mode) => { staged.push(`${kind}:${mode}`); },
    }) });
    // phaseHooks runs its own onStagingCreated first; the extra one refines it.
    const result = await service.ensureTargetGeneration(state.project.id, state.asset.id,
      h.imageSettings.getPolicy());
    recorder.restore();

    expect(result.cacheState).toBe('regenerated');
    expect(staged).toEqual(['thumbnail:reused', 'preview:encoded']);
    expect(recorder.jsonOps(['probe', 'reuse'])).toEqual([]);
    expect(recorder.reads(path.join(state.dir, 'thumbnail.webp'), ['reuse'])).toBeGreaterThan(0);
    expect(recorder.touching(path.join(state.dir, META_FILENAME))).toEqual([]);
  });

  it('M: a force rebuild probes nothing old and the valid publication stays servable meanwhile', async () => {
    const state = await published(h);
    const finds = vi.fn(h.publications.findPublication);
    const counting = { ...h.publications, findPublication: finds };
    const gate = makeGate();
    let reachedRename;
    const atRename = new Promise((resolve) => { reachedRename = resolve; });

    recorder = recordFilesystem();
    recorder.phase = 'force';
    const writer = h.makePreview({ generatedImagePublicationRepository: counting, _hooks: {
      beforePublishRename: async () => { reachedRename(); await gate.promise; },
    } });
    const forced = writer.ensureTargetGeneration(state.project.id, state.asset.id,
      h.imageSettings.getPolicy(), () => true, { force: true });
    await atRename;

    recorder.phase = 'presentation';
    const served = await within(h.preview.getPreview(state.project.id, state.asset.id), 5000, 'presentation');
    expect(served).toMatchObject({ cacheState: 'fresh', revision: state.committed.revision });
    expect(served.path).toBe(path.join(state.dir, 'preview.webp'));

    recorder.phase = 'force';
    gate.release();
    const result = await forced;
    recorder.restore();

    expect(result.cacheState).toBe('regenerated');
    expect(finds).not.toHaveBeenCalled();
    expect(recorder.touching(state.dir, ['force'])).toEqual([]);
    expect(recorder.jsonOps(['presentation'])).toEqual([]);
    const committed = h.publications.findPublication(state.project.id, state.asset.id);
    expect(committed.directoryName).not.toBe(state.committed.directoryName);
    // Filesystem publication witness written as before by the journaling writer.
    expect(readCurrentPointer(h.previewRoot, state.project.id, state.asset.id).pointer.dir)
      .toBe(committed.directoryName);
    expect(fs.existsSync(path.join(state.root, committed.directoryName, META_FILENAME))).toBe(true);
  });
});
