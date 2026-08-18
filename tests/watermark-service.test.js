import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createWatermarkRepository } from '../src/data/watermark-repository.js';
import { createWatermarkService, WatermarkServiceError } from '../src/services/watermark-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function png({ width = 20, height = 10, alpha = 1 } = {}) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha },
    },
  }).png().toBuffer();
}

describe('managed Watermark service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;
  let storageRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-managed-watermark-'));
    storageRoot = path.join(tmpDir, 'watermarks');
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createWatermarkRepository(db);
    service = createWatermarkService({ repository, storageRoot });
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a canonical app-owned PNG and exposes only public metadata', async () => {
    const source = await png({ width: 31, height: 17 });
    const watermark = await service.createWatermark({ displayName: 'Oliver Mark', pngBytes: source });

    expect(watermark).toMatchObject({ id: 1, displayName: 'Oliver Mark', width: 31, height: 17 });
    expect(watermark).not.toHaveProperty('storageKey');
    expect(watermark).not.toHaveProperty('path');

    const stored = repository.findById(watermark.id);
    const filePath = path.join(storageRoot, stored.storage_key);
    expect(stored.storage_key).toMatch(/^wm-[0-9a-f-]{36}\.png$/);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(stored.sha256).toBe(createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'));
    // Migration-014 rows without a filesystem source path remain preserved
    // for historical provenance but are not global source candidates.
    expect(service.listWatermarks()).toEqual([]);
    expect(service.resolveForProcessing(watermark.id).watermark).toEqual(watermark);
  });

  it('renames without changing storage identity, then replaces bytes under the same stable ID', async () => {
    const created = await service.createWatermark({ displayName: 'Original', pngBytes: await png() });
    const before = repository.findById(created.id);
    const renamed = service.renameWatermark(created.id, 'Renamed');
    expect(renamed).toMatchObject({ id: created.id, displayName: 'Renamed' });
    expect(repository.findById(created.id).storage_key).toBe(before.storage_key);

    const replaced = await service.replaceWatermark(created.id, { pngBytes: await png({ width: 11, height: 7 }) });
    const after = repository.findById(created.id);
    expect(replaced).toMatchObject({ id: created.id, displayName: 'Renamed', width: 11, height: 7 });
    expect(after.storage_key).toBe(before.storage_key);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it('rejects invalid and entirely transparent PNG inputs', async () => {
    await expect(service.createWatermark({ displayName: 'Bad', pngBytes: Buffer.from('not a png') }))
      .rejects.toMatchObject({ code: 'INVALID_WATERMARK_PNG' });
    await expect(service.createWatermark({ displayName: 'Blank', pngBytes: await png({ alpha: 0 }) }))
      .rejects.toMatchObject({ code: 'EMPTY_WATERMARK' });
  });

  it('fails closed when managed bytes are externally replaced', async () => {
    const watermark = await service.createWatermark({ displayName: 'Trusted', pngBytes: await png() });
    const record = repository.findById(watermark.id);
    fs.writeFileSync(path.join(storageRoot, record.storage_key), await png({ width: 8, height: 8 }));

    expect(() => service.resolveForProcessing(watermark.id)).toThrow(WatermarkServiceError);
    expect(() => service.resolveForProcessing(watermark.id)).toThrow(expect.objectContaining({
      code: 'WATERMARK_RESOURCE_TAMPERED',
    }));
  });

  it('deletes the registry row and its managed file', async () => {
    const watermark = await service.createWatermark({ displayName: 'Disposable', pngBytes: await png() });
    const record = repository.findById(watermark.id);
    const filePath = path.join(storageRoot, record.storage_key);

    expect(service.deleteWatermark(watermark.id)).toMatchObject({ id: watermark.id });
    expect(repository.findById(watermark.id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('nulls generated asset and artifact provenance without deleting historical outputs', async () => {
    const watermark = await service.createWatermark({ displayName: 'Historical', pngBytes: await png() });
    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('Watermark history', 'watermark-history', 'tbd')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, generated_watermark_id)
      VALUES (?, 'Final/output.png', 'output.png', ?)
    `).run(projectId, watermark.id).lastInsertRowid);
    const artifactId = Number(db.prepare(`
      INSERT INTO generated_artifacts (
        project_id, relative_path, kind, generated_by, generated_mode, generated_watermark_id, sha256, size_bytes
      ) VALUES (?, 'Final/output.zip', 'watermark-archive-jpeg', 'watermark', 'patreon', ?, ?, 1)
    `).run(projectId, watermark.id, 'a'.repeat(64)).lastInsertRowid);

    service.deleteWatermark(watermark.id);

    expect(db.prepare('SELECT generated_watermark_id FROM assets WHERE id = ?').get(assetId))
      .toEqual({ generated_watermark_id: null });
    expect(db.prepare('SELECT generated_watermark_id FROM generated_artifacts WHERE id = ?').get(artifactId))
      .toEqual({ generated_watermark_id: null });
  });
});
