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

  function createCanonical(definition = { '100x60': 0.35, default: 0.1 }) {
    return Number(db.prepare(`
      INSERT INTO watermark_scale_maps (display_name, system_key, definition_json)
      VALUES ('Reference', 'reference-watermark-scale-map', ?)
    `).run(JSON.stringify(definition)).lastInsertRowid);
  }

  it('reads and replaces only the canonical singleton definition', () => {
    const canonicalId = createCanonical();
    const historicalId = Number(db.prepare(`
      INSERT INTO watermark_scale_maps (display_name, definition_json)
      VALUES ('Historical map', '{"100x60":0.9}')
    `).run().lastInsertRowid);

    expect(service.getScaleMap()).toEqual({ definition: { '100x60': 0.35, default: 0.1 } });
    expect(service.replaceScaleMap({ default: 0.2, '1365x768': 0.5 }))
      .toEqual({ definition: { '1365x768': 0.5, default: 0.2 } });
    expect(repository.findById(canonicalId).definition_json).toBe('{"1365x768":0.5,"default":0.2}');
    expect(repository.findById(historicalId).definition_json).toBe('{"100x60":0.9}');
  });

  it('allows an empty singleton map as the intentional manual-scale fallback and rejects invalid definitions', () => {
    createCanonical();
    expect(service.replaceScaleMap({}).definition).toEqual({});
    for (const definition of [
      { '1365X768': 0.35 },
      { '1365x768': 0 },
      { '1365x768': '0.35' },
      { DEFAULT: 0.1 },
    ]) {
      expect(() => service.replaceScaleMap(definition))
        .toThrow(WatermarkScaleMapServiceError);
    }
  });

  it('resolves processing strictly through the system-keyed canonical singleton', () => {
    const historicalId = Number(db.prepare(`
      INSERT INTO watermark_scale_maps (display_name, definition_json)
      VALUES ('Historical map', '{"100x60":0.9}')
    `).run().lastInsertRowid);
    const canonicalId = createCanonical();

    expect(service.resolveForProcessing()).toMatchObject({ definition: { '100x60': 0.35, default: 0.1 } });
    expect(repository.findById(historicalId).definition_json).toBe('{"100x60":0.9}');

    db.prepare('UPDATE watermark_scale_maps SET definition_json = ? WHERE id = ?').run('{bad', canonicalId);
    expect(() => service.resolveForProcessing()).toThrow(expect.objectContaining({ code: 'SCALE_MAP_INVALID' }));
  });
});
