import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createWatermarkRepository } from '../src/data/watermark-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createApp } from '../src/app.js';
import { createProcessingRouter } from '../src/routes/processing.js';
import { runInitialWatermarkScan } from '../src/server.js';
import { createWatermarkService } from '../src/services/watermark-service.js';
import { createWatermarkDefaultService, DEFAULT_WATERMARK_META_KEY } from '../src/services/watermark-default-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function png({ width = 20, height = 10, red = 255 } = {}) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: red, g: 10, b: 20, alpha: 1 },
    },
  }).png().toBuffer();
}

function canCreateSymlinks() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-global-watermark-link-'));
  try {
    fs.mkdirSync(path.join(probe, 'target'));
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const HAS_SYMLINKS = canCreateSymlinks();

describe('global filesystem-backed Watermark source', () => {
  let tmpDir;
  let projectsRoot;
  let watermarkRoot;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-global-watermark-'));
    projectsRoot = path.join(tmpDir, 'projects');
    watermarkRoot = path.join(projectsRoot, 'watermarks');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createWatermarkRepository(db);
    service = createWatermarkService({ repository, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the sibling global root, accepts it idempotently, and rejects unsafe roots', () => {
    expect(fs.existsSync(watermarkRoot)).toBe(false);
    service.ensureRoot();
    service.ensureRoot();
    expect(fs.lstatSync(watermarkRoot).isDirectory()).toBe(true);
    expect(path.dirname(watermarkRoot)).toBe(projectsRoot);

    fs.rmSync(watermarkRoot, { recursive: true, force: true });
    fs.writeFileSync(watermarkRoot, 'not a directory');
    expect(() => service.ensureRoot()).toThrowError(expect.objectContaining({ code: 'WATERMARK_STORAGE_UNAVAILABLE' }));
  });

  it.runIf(HAS_SYMLINKS)('rejects a symlink at the global root', () => {
    service.ensureRoot();
    fs.rmSync(watermarkRoot, { recursive: true, force: true });
    const target = path.join(projectsRoot, 'real-watermarks');
    fs.mkdirSync(target);
    fs.symlinkSync(target, watermarkRoot, 'junction');

    expect(() => service.ensureRoot()).toThrowError(expect.objectContaining({ code: 'WATERMARK_STORAGE_UNAVAILABLE' }));
  });

  it('creates the global root during app construction even with zero projects', () => {
    fs.rmSync(watermarkRoot, { recursive: true, force: true });
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot });

    expect(fs.lstatSync(watermarkRoot).isDirectory()).toBe(true);
    expect(app.locals.watermarkSourceRoot).toBe(watermarkRoot);
    expect(app.locals.watermarkDiscoveryService).toBeUndefined();
    expect(app.locals.projectWatermarkProvisioner).toBeUndefined();
    expect(app.locals.projectWatermarkProvisioning).toBeUndefined();
    expect(app.locals.projectService.listScanEligibleProjects()).toEqual([]);
  });

  it('runs and clearly reports the initial startup scan', async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const applicationLogger = { info: vi.fn(), error: vi.fn() };
    const scan = { added: 1, updated: 0, restored: 0, removed: 0, total: 1, failed: 0 };
    const serviceStub = { scanWatermarks: vi.fn(async () => scan) };
    const appContext = { app: { locals: { watermarkService: serviceStub } } };

    await expect(runInitialWatermarkScan(appContext, logger, applicationLogger)).resolves.toEqual(scan);
    expect(serviceStub.scanWatermarks).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Initial global Watermark scan completed'));
    expect(logger.log).toHaveBeenLastCalledWith(expect.stringContaining('0 failed'));
    expect(applicationLogger.info).toHaveBeenCalledWith({
      kind: 'diagnostic',
      subsystem: 'runtime',
      event: 'runtime.watermark.initial_scan.completed',
      message: 'Initial global Watermark scan completed.',
      context: { total: 1, added: 1, updated: 0, restored: 0, removed: 0, failed: 0 },
    });

    serviceStub.scanWatermarks.mockRejectedValueOnce(new Error('unreadable source'));
    await expect(runInitialWatermarkScan(appContext, logger, applicationLogger)).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Initial global Watermark scan failed'));
    expect(applicationLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'diagnostic',
      subsystem: 'runtime',
      event: 'runtime.watermark.initial_scan.failed',
      error: expect.objectContaining({ message: 'unreadable source' }),
    }));

    const partial = { ...scan, failed: 1, errors: [{ relativePath: 'broken.png', code: 'INVALID_WATERMARK_PNG' }] };
    serviceStub.scanWatermarks.mockResolvedValueOnce(partial);
    await expect(runInitialWatermarkScan(appContext, logger, applicationLogger)).resolves.toEqual(partial);
    expect(logger.log).toHaveBeenLastCalledWith(expect.stringContaining('1 failed'));
  });


  it('logs clean initial startup scan completion at diagnostic info severity', async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const applicationLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scan = { added: 1, updated: 0, restored: 0, removed: 0, total: 1, failed: 0 };
    const serviceStub = { scanWatermarks: vi.fn(async () => scan) };
    const appContext = { app: { locals: { watermarkService: serviceStub } } };

    await expect(runInitialWatermarkScan(appContext, logger, applicationLogger)).resolves.toEqual(scan);

    expect(applicationLogger.info).toHaveBeenCalledTimes(1);
    expect(applicationLogger.info).toHaveBeenCalledWith({
      event: 'runtime.watermark.initial_scan.completed',
      kind: 'diagnostic',
      subsystem: 'runtime',
      message: 'Initial global Watermark scan completed.',
      context: { total: 1, added: 1, updated: 0, restored: 0, removed: 0, failed: 0 },
    });
    expect(applicationLogger.warn).not.toHaveBeenCalled();
    expect(applicationLogger.error).not.toHaveBeenCalled();
  });

  it('logs partial initial startup scan completion at diagnostic warn severity', async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const applicationLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scan = { added: 1, updated: 0, restored: 0, removed: 0, total: 1, failed: 1 };
    const serviceStub = { scanWatermarks: vi.fn(async () => scan) };
    const appContext = { app: { locals: { watermarkService: serviceStub } } };

    await expect(runInitialWatermarkScan(appContext, logger, applicationLogger)).resolves.toEqual(scan);

    expect(applicationLogger.warn).toHaveBeenCalledTimes(1);
    expect(applicationLogger.warn).toHaveBeenCalledWith({
      event: 'runtime.watermark.initial_scan.completed',
      kind: 'diagnostic',
      subsystem: 'runtime',
      message: 'Initial global Watermark scan completed.',
      context: { total: 1, added: 1, updated: 0, restored: 0, removed: 0, failed: 1 },
    });
    expect(applicationLogger.info).not.toHaveBeenCalled();
    expect(applicationLogger.error).not.toHaveBeenCalled();
  });


  it('isolates application logger failures from a completed initial startup scan', async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const applicationLogger = { info: vi.fn(() => { throw new Error('logger unavailable'); }) };
    const scan = { added: 1, updated: 0, restored: 0, removed: 0, total: 1, failed: 0 };
    const serviceStub = { scanWatermarks: vi.fn(async () => scan) };
    const appContext = { app: { locals: { watermarkService: serviceStub } } };

    await expect(runInitialWatermarkScan(appContext, logger, applicationLogger)).resolves.toEqual(scan);

    expect(serviceStub.scanWatermarks).toHaveBeenCalledTimes(1);
    expect(applicationLogger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reconciles valid sources when a malformed candidate fails and reports the safe relative identifier', async () => {
    service.ensureRoot();
    fs.writeFileSync(path.join(watermarkRoot, 'good-a.png'), await png({ width: 7, height: 4 }));
    fs.writeFileSync(path.join(watermarkRoot, 'broken.png'), 'not a PNG');
    fs.writeFileSync(path.join(watermarkRoot, 'good-b.png'), await png({ width: 9, height: 5 }));

    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 2, updated: 0, restored: 0, removed: 0, total: 2,
      failed: 1,
      errors: [{ relativePath: 'broken.png', code: 'INVALID_WATERMARK_PNG' }],
    });
    expect(service.listWatermarks().map((watermark) => watermark.relativePath)).toEqual(['good-a.png', 'good-b.png']);
  });

  it('marks a malformed indexed source unavailable, then restores its existing identity after a valid rescan', async () => {
    service.ensureRoot();
    const sourcePath = path.join(watermarkRoot, 'recoverable.png');
    fs.writeFileSync(sourcePath, await png({ width: 13, height: 8 }));
    await service.scanWatermarks();
    const id = service.listWatermarks()[0].id;

    fs.writeFileSync(sourcePath, 'not a PNG');
    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 0, updated: 0, restored: 0, removed: 1, total: 0,
      failed: 1,
      errors: [{ relativePath: 'recoverable.png', code: 'INVALID_WATERMARK_PNG' }],
    });
    expect(repository.findById(id)).toMatchObject({ source_present: 0 });
    expect(() => service.resolveForProcessing(id)).toThrowError(expect.objectContaining({
      code: 'WATERMARK_NOT_FOUND',
    }));

    fs.writeFileSync(sourcePath, await png({ width: 13, height: 8 }));
    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 0, updated: 0, restored: 1, removed: 0, total: 1, failed: 0,
    });
    expect(service.resolveForProcessing(id).watermark).toMatchObject({ id, width: 13, height: 8 });
  });

  it('preserves an indexed source during a transient read failure while reconciling unrelated valid sources', async () => {
    service.ensureRoot();
    const racedPath = path.join(watermarkRoot, 'raced.png');
    fs.writeFileSync(racedPath, await png({ width: 12, height: 6 }));
    await service.scanWatermarks();
    const racedId = service.listWatermarks()[0].id;
    fs.writeFileSync(path.join(watermarkRoot, 'fresh.png'), await png({ width: 14, height: 7 }));

    const originalReadFileSync = fs.readFileSync;
    const readFileSync = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      if (filePath === racedPath) {
        const error = new Error('simulated source read race');
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFileSync(filePath, ...args);
    });
    try {
      await expect(service.scanWatermarks()).resolves.toEqual({
        added: 1, updated: 0, restored: 0, removed: 0, total: 1,
        failed: 1,
        errors: [{ relativePath: 'raced.png', code: 'WATERMARK_SOURCE_UNSAFE' }],
      });
    } finally {
      readFileSync.mockRestore();
    }

    expect(repository.findById(racedId)).toMatchObject({ source_present: 1 });
    expect(service.listWatermarks().map((watermark) => watermark.relativePath)).toEqual(['fresh.png', 'raced.png']);
    expect(service.resolveForProcessing(racedId).watermark).toMatchObject({ id: racedId });
  });

  it('reconciles additions, nested PNGs, changes, removals, restorations, and renames by path', async () => {
    service.ensureRoot();
    const alphaPath = path.join(watermarkRoot, 'Alpha.png');
    const nestedPath = path.join(watermarkRoot, 'nested', 'zeta.PNG');
    fs.mkdirSync(path.dirname(nestedPath), { recursive: true });
    const alphaBytes = await png({ width: 20, height: 10 });
    const nestedBytes = await png({ width: 11, height: 7, red: 80 });
    fs.writeFileSync(alphaPath, alphaBytes);
    fs.writeFileSync(nestedPath, nestedBytes);
    fs.writeFileSync(path.join(watermarkRoot, 'ignore.txt'), 'ignored');
    fs.writeFileSync(path.join(watermarkRoot, 'ignore.jpg'), alphaBytes);

    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 2, updated: 0, restored: 0, removed: 0, total: 2, failed: 0,
    });
    const first = service.listWatermarks();
    expect(first).toEqual([
      { id: expect.any(Number), filename: 'Alpha.png', relativePath: 'Alpha.png', width: 20, height: 10 },
      { id: expect.any(Number), filename: 'zeta.PNG', relativePath: 'nested/zeta.PNG', width: 11, height: 7 },
    ]);
    const alphaId = first[0].id;
    const nestedId = first[1].id;
    const projectId = Number(db.prepare(
      "INSERT INTO projects (title, slug, status) VALUES ('Global Watermark Project', 'global-watermark-project', 'tbd')"
    ).run().lastInsertRowid);
    const generatedAssetId = Number(db.prepare(
      "INSERT INTO assets (project_id, relative_path, filename, generated_watermark_id) VALUES (?, 'Final/generated.png', 'generated.png', ?)"
    ).run(projectId, nestedId).lastInsertRowid);

    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 0, updated: 0, restored: 0, removed: 0, total: 2, failed: 0,
    });
    expect(service.listWatermarks().map(({ id }) => id)).toEqual([alphaId, nestedId]);

    fs.writeFileSync(alphaPath, await png({ width: 31, height: 17, red: 30 }));
    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 0, updated: 1, restored: 0, removed: 0, total: 2, failed: 0,
    });
    expect(service.getWatermark(alphaId)).toMatchObject({ id: alphaId, width: 31, height: 17 });

    fs.rmSync(nestedPath);
    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 0, updated: 0, restored: 0, removed: 1, total: 1, failed: 0,
    });
    expect(service.listWatermarks().map(({ id }) => id)).toEqual([alphaId]);
    expect(repository.findById(nestedId)).toMatchObject({ source_present: 0, source_relative_path: 'nested/zeta.PNG' });
    expect(db.prepare('SELECT generated_watermark_id FROM assets WHERE id = ?').get(generatedAssetId))
      .toEqual({ generated_watermark_id: nestedId });

    fs.writeFileSync(nestedPath, nestedBytes);
    await expect(service.scanWatermarks()).resolves.toEqual({
      added: 0, updated: 0, restored: 1, removed: 0, total: 2, failed: 0,
    });
    expect(service.getWatermark(nestedId)).toMatchObject({ id: nestedId, relativePath: 'nested/zeta.PNG' });

    fs.renameSync(alphaPath, path.join(watermarkRoot, 'renamed.png'));
    const renamed = await service.scanWatermarks();
    expect(renamed).toEqual({ added: 1, updated: 0, restored: 0, removed: 1, total: 2, failed: 0 });
    const renamedCandidate = service.listWatermarks().find(({ relativePath }) => relativePath === 'renamed.png');
    expect(renamedCandidate.id).not.toBe(alphaId);
    expect(repository.findById(alphaId)).toMatchObject({ source_present: 0, source_relative_path: 'Alpha.png' });
  });

  it('fails closed when indexed source bytes are changed until the next scan', async () => {
    service.ensureRoot();
    const sourcePath = path.join(watermarkRoot, 'trusted.png');
    fs.writeFileSync(sourcePath, await png());
    await service.scanWatermarks();
    const id = service.listWatermarks()[0].id;

    fs.writeFileSync(sourcePath, await png({ width: 99, height: 4 }));
    expect(() => service.resolveForProcessing(id)).toThrowError(expect.objectContaining({
      code: 'WATERMARK_RESOURCE_TAMPERED',
    }));

    await service.scanWatermarks();
    expect(service.resolveForProcessing(id).watermark).toMatchObject({ id, width: 99, height: 4 });
  });

  it('serves trusted global candidates and images while exposing no source mutations', async () => {
    service.ensureRoot();
    const bytes = await png({ width: 9, height: 6 });
    fs.writeFileSync(path.join(watermarkRoot, 'http.png'), bytes);
    const watermarkDefaultService = createWatermarkDefaultService({
      appMetaRepository: createAppMetaRepository(db),
      watermarkService: service,
    });
    const router = createProcessingRouter({
      watermarkService: service,
      watermarkDefaultService,
      watermarkScaleMapService: {
        getScaleMap: () => ({ definition: {} }),
        replaceScaleMap: (definition) => ({ definition }),
      },
      processingPresetService: {
        listPresets: () => [],
      },
    });
    const app = express();
    app.use(express.json());
    app.use(router);

    expect((await request(app).get('/processing/watermarks/default').expect(200)).body).toEqual({ ok: true, watermarkId: null });
    await request(app).post('/processing/watermarks/default').send({ watermarkId: 0 }).expect(400);

    const scan = await request(app).post('/processing/watermarks/scan').expect(200);
    expect(scan.body).toEqual({ ok: true, scan: { added: 1, updated: 0, restored: 0, removed: 0, total: 1, failed: 0 } });
    const candidate = (await request(app).get('/processing/watermarks').expect(200)).body.watermarks[0];
    expect(candidate).toEqual({ id: expect.any(Number), filename: 'http.png', relativePath: 'http.png', width: 9, height: 6 });
    await request(app).post('/processing/watermarks/default').send({ watermarkId: candidate.id }).expect(200);
    expect((await request(app).get('/processing/watermarks/default').expect(200)).body).toEqual({ ok: true, watermarkId: candidate.id });
    await request(app).post('/processing/watermarks/default').send({ watermarkId: candidate.id + 1 }).expect(404);

    fs.rmSync(path.join(watermarkRoot, 'http.png'));
    await request(app).post('/processing/watermarks/scan').expect(200);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(DEFAULT_WATERMARK_META_KEY)).toEqual({ value: String(candidate.id) });
    expect((await request(app).get('/processing/watermarks/default').expect(200)).body).toEqual({ ok: true, watermarkId: null });

    fs.writeFileSync(path.join(watermarkRoot, 'http.png'), bytes);
    await request(app).post('/processing/watermarks/scan').expect(200);
    expect((await request(app).get('/processing/watermarks/default').expect(200)).body).toEqual({ ok: true, watermarkId: candidate.id });

    const image = await request(app).get(`/processing/watermarks/${candidate.id}/image`).expect(200);
    expect(image.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.from(image.body)).toEqual(bytes);

    await request(app).post('/processing/watermarks').send({}).expect(404);
    await request(app).post(`/processing/watermarks/${candidate.id}/rename`).send({}).expect(404);
    await request(app).post(`/processing/watermarks/${candidate.id}/replace`).send({}).expect(404);
    await request(app).post(`/processing/watermarks/${candidate.id}/delete`).send({}).expect(404);
  });
});
