import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createWatermarkScaleMapRepository } from '../src/data/watermark-scale-map-repository.js';
import {
  createWatermarkScaleMapService,
  WatermarkScaleMapServiceError,
} from '../src/services/watermark-scale-map-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('managed Watermark scale-map service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-scale-map-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createWatermarkScaleMapRepository(db);
    service = createWatermarkScaleMapService({ repository });
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates canonical, parsed definitions while preserving stable IDs across rename and replacement', () => {
    const created = service.createScaleMap({
      displayName: 'Patreon / Social Map',
      definition: { default: 0.1, '1024x1024': 0.37, '1365x768': 2 },
    });

    expect(created).toMatchObject({
      id: 1,
      displayName: 'Patreon / Social Map',
      definition: { '1024x1024': 0.37, '1365x768': 2, default: 0.1 },
    });
    expect(repository.findById(created.id).definition_json)
      .toBe('{"1024x1024":0.37,"1365x768":2,"default":0.1}');

    const renamed = service.renameScaleMap(created.id, 'Renamed map');
    const replaced = service.replaceScaleMap(created.id, { '1365x768': 0.5 });
    expect(renamed.id).toBe(created.id);
    expect(replaced).toMatchObject({ id: created.id, displayName: 'Renamed map', definition: { '1365x768': 0.5 } });
    expect(service.listScaleMaps()).toEqual([replaced]);
  });

  it('allows an empty map as the intentional manual-scale fallback and rejects invalid shared-validator inputs', () => {
    expect(service.createScaleMap({ displayName: 'Manual fallback', definition: {} }).definition).toEqual({});
    for (const definition of [
      { '1365X768': 0.35 },
      { '1365x768': 0 },
      { '1365x768': '0.35' },
      { DEFAULT: 0.1 },
    ]) {
      expect(() => service.createScaleMap({ displayName: `Invalid ${JSON.stringify(definition)}`, definition }))
        .toThrow(WatermarkScaleMapServiceError);
    }
  });

  it('fails closed for malformed IDs and corrupted stored definitions, then deletes only the row', () => {
    const created = service.createScaleMap({ displayName: 'Disposable', definition: { '100x60': 0.25 } });
    expect(() => service.getScaleMap('1')).toThrow(expect.objectContaining({ code: 'INVALID_SCALE_MAP_ID' }));
    db.prepare('UPDATE watermark_scale_maps SET definition_json = ? WHERE id = ?').run('{bad', created.id);
    expect(() => service.resolveForProcessing(created.id)).toThrow(expect.objectContaining({ code: 'SCALE_MAP_INVALID' }));
    db.prepare('UPDATE watermark_scale_maps SET definition_json = ? WHERE id = ?').run('{"100x60":0.25}', created.id);
    expect(service.deleteScaleMap(created.id)).toMatchObject({ id: created.id });
    expect(repository.findById(created.id)).toBeUndefined();
  });
});
