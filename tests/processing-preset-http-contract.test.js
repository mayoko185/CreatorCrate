/**
 * Proves the exact client payload shapes the new preset-management UI in
 * src/static/processing.js builds (see collectPresetConfig/
 * collectPresetBindings) round-trip successfully through the REAL
 * /processing/presets HTTP routes and the real ProcessingPresetService —
 * not a mocked contract — for seeded presets specifically (Patreon, Social,
 * Benji, WebP 85 — Delete Originals), and that scope/runtime-only fields
 * are never required or accepted inside a preset payload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createProcessingPresetRepository } from '../src/data/processing-preset-repository.js';
import { createWatermarkScaleMapRepository } from '../src/data/watermark-scale-map-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createWatermarkScaleMapService } from '../src/services/watermark-scale-map-service.js';
import { createWatermarkDefaultService } from '../src/services/watermark-default-service.js';
import { createProcessingPresetService } from '../src/services/processing-preset-service.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createProcessingRouter } from '../src/routes/processing.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Processing preset HTTP contract (seeded presets, client-shaped payloads)', () => {
  let tmpDir;
  let db;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-preset-http-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    // The watermarkService below is a stand-in for HTTP-contract purposes;
    // a bindable watermarkId still needs a real row for the FK constraint.
    db.prepare(`
      INSERT INTO watermarks (id, display_name, storage_key, sha256, width, height)
      VALUES (1, 'Oliver', 'wm-00000000-0000-0000-0000-000000000000.png', ?, 1, 1)
    `).run('a'.repeat(64));
    const repository = createProcessingPresetRepository(db);
    const scaleMapService = createWatermarkScaleMapService({ repository: createWatermarkScaleMapRepository(db) });
    const watermarkService = {
      listWatermarks() { return [{ id: 1, displayName: 'Oliver' }]; },
      getWatermark(id) {
        if (id !== 1) throw Object.assign(new Error('Watermark not found.'), { code: 'WATERMARK_NOT_FOUND' });
        return { id, displayName: 'Oliver' };
      },
      resolveForProcessing(id) { return { watermark: this.getWatermark(id), filePath: 'not-exposed-to-presets' }; },
    };
    const processingPresetService = createProcessingPresetService({ repository, watermarkService, scaleMapService });
    processingPresetService.seedReferencePresets();
    const watermarkDefaultService = createWatermarkDefaultService({
      appMetaRepository: createAppMetaRepository(db),
      watermarkService,
    });
    const applicationLogger = createApplicationLogger({ repository: createApplicationLogRepository(db) });

    app = express();
    app.use(express.json());
    app.use(createProcessingRouter({
      watermarkService,
      watermarkDefaultService,
      watermarkScaleMapService: scaleMapService,
      processingPresetService,
      applicationLogger,
    }));
    app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: { message: error.message } }));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function findSeeded(displayName, operationType) {
    const res = await request(app).get(`/processing/presets?operationType=${operationType}`).expect(200);
    const preset = res.body.presets.find((p) => p.displayName === displayName);
    expect(preset, `expected seeded preset "${displayName}"`).toBeTruthy();
    return preset;
  }

  it('lets the seeded WebP 85 — Delete Originals Convert preset be selected, updated, renamed, and deleted like a user preset', async () => {
    const preset = await findSeeded('WebP 85 — Delete Originals', 'convert');
    expect(preset.config).toEqual({ format: 'webp', quality: 85, originalHandling: 'delete' });

    // Update: exactly the body shape collectPresetConfig() builds for Convert.
    const updateBody = { config: { format: 'webp', quality: 72, originalHandling: 'keep' } };
    expect(Object.keys(updateBody)).not.toContain('scope');
    const updated = await request(app).post(`/processing/presets/${preset.id}/replace`).send(updateBody).expect(200);
    expect(updated.body.preset.config).toEqual(updateBody.config);

    const renamed = await request(app).post(`/processing/presets/${preset.id}/rename`).send({ displayName: 'My WebP' }).expect(200);
    expect(renamed.body.preset.displayName).toBe('My WebP');

    await request(app).post(`/processing/presets/${preset.id}/delete`).send({}).expect(200);
    const list = await request(app).get('/processing/presets?operationType=convert').expect(200);
    expect(list.body.presets.some((p) => p.id === preset.id)).toBe(false);
  });

  it('lets the seeded Benji workflow preset be updated with a full structured rule set and renamed', async () => {
    const preset = await findSeeded('Benji', 'workflow-prompt');

    // Body shape collectPresetConfig() builds for Workflow.
    const updateBody = {
      config: {
        positive: { rules: [{ type: 'remove', text: 'x' }, { type: 'replace', search: '', replacement: 'y' }] },
        negative: { rules: [{ type: 'append', text: 'z' }] },
      },
    };
    const updated = await request(app).post(`/processing/presets/${preset.id}/replace`).send(updateBody).expect(200);
    // The service stores/returns positive/negative as plain rule arrays
    // (see normalizePromptEditOptions) even though {rules:[...]} is an
    // accepted input shape — this is the shape the client must read back.
    expect(updated.body.preset.config).toEqual({
      positive: [{ type: 'remove', text: 'x' }, { type: 'replace', search: '', replacement: 'y' }],
      negative: [{ type: 'append', text: 'z' }],
    });

    const renamed = await request(app).post(`/processing/presets/${preset.id}/rename`).send({ displayName: 'Benji v2' }).expect(200);
    expect(renamed.body.preset.displayName).toBe('Benji v2');
  });

  it('rejects legacy scaleMapId values on create and replace while keeping Watermark identity runtime-only', async () => {
    const preset = await findSeeded('Social Watermark', 'watermark');
    expect(preset.watermarkId).toBeNull();

    const updateBody = {
      config: {
        mode: 'custom', position: 'bl', marginRatio: 0.02, maxDimension: 1100,
        outputFormat: 'png', unresizedSuffix: '_wm', resizedSuffix: '_lq_wm', deleteSource: true, alsoUnresized: false,
        makeArchives: false, makeCbz: false, archiveFormat: 'zip', archivePrefix: '', additionalFormats: [],
      },
      watermarkId: 1,
    };
    const updated = await request(app).post(`/processing/presets/${preset.id}/replace`).send(updateBody).expect(200);
    expect(updated.body.preset.watermarkId).toBeNull();
    expect(updated.body.preset.config).not.toHaveProperty('watermarkId');
    expect(updated.body.preset.config).not.toHaveProperty('watermarkAssetId');
    expect(updated.body.preset.config).not.toHaveProperty('scaleMapId');
    expect(updated.body.preset.config).toMatchObject({ unresizedSuffix: '_wm', resizedSuffix: '_lq_wm' });
    expect(updated.body.preset.config).not.toHaveProperty('singleSuffix');
    expect(updated.body.preset.config).not.toHaveProperty('suffix');
    expect(updated.body.preset).not.toHaveProperty('scaleMapId');
    expect(db.prepare('SELECT scale_map_id FROM processing_presets WHERE id = ?').get(preset.id)).toEqual({ scale_map_id: null });

    const created = await request(app).post('/processing/presets').send({
      operationType: 'watermark', displayName: 'No scale-map binding',
      config: updateBody.config,
    }).expect(201);
    expect(created.body.preset).not.toHaveProperty('scaleMapId');
    expect(db.prepare('SELECT scale_map_id FROM processing_presets WHERE id = ?').get(created.body.preset.id))
      .toEqual({ scale_map_id: null });

    for (const requestWithLegacyScaleMap of [
      request(app).post(`/processing/presets/${preset.id}/replace`).send({ ...updateBody, scaleMapId: 999 }),
      request(app).post('/processing/presets').send({
        operationType: 'watermark', displayName: 'Rejected scale-map binding', config: updateBody.config, scaleMapId: 999,
      }),
    ]) {
      const response = await requestWithLegacyScaleMap.expect(400);
      expect(response.body.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'scaleMapId' });
    }
  });

  it('rejects a preset payload that smuggles scope/runtime-only fields inside config, exactly as the client never sends them', async () => {
    const res = await request(app).post('/processing/presets').send({
      operationType: 'convert',
      displayName: 'Malicious',
      config: { format: 'webp', quality: 85, originalHandling: 'keep', projectId: 1, scope: { type: 'project' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).not.toMatch(/[A-Za-z]:\\/);
    expect(res.body.error.message).not.toContain('SELECT ');
  });

  it('reports a clean duplicate-name conflict without leaking internals when renaming a seeded preset over another', async () => {
    const patreon = await findSeeded('Patreon Watermark', 'watermark');
    const res = await request(app).post(`/processing/presets/${patreon.id}/rename`).send({ displayName: 'Social Watermark' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRESET_NAME_CONFLICT');
    expect(res.body.error.message).not.toMatch(/[A-Za-z]:\\/);
  });

  it('imports a complete versioned bundle atomically, suffixes collisions, and isolates operation types', async () => {
    const convert = await request(app).get('/processing/presets?operationType=convert').expect(200);
    const seededConvert = convert.body.presets.find((preset) => preset.systemKey === 'convert-webp-85-delete-originals');

    const imported = await request(app).post('/processing/presets/import').send({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'convert',
      presets: [
        { displayName: seededConvert.displayName, config: { format: 'webp', quality: 77, originalHandling: 'keep' } },
        { displayName: 'Imported Convert', config: { format: 'png', quality: 72, originalHandling: 'delete' } },
      ],
    }).expect(200);

    expect(imported.body).toMatchObject({ ok: true, imported: 2, renamed: 1 });
    expect(imported.body.presets.map((preset) => preset.displayName)).toEqual([
      `${seededConvert.displayName} (1)`,
      'Imported Convert',
    ]);
    expect(imported.body.presets.every((preset) => preset.systemKey === null)).toBe(true);

    const beforeInvalid = await request(app).get('/processing/presets?operationType=convert').expect(200);
    const invalid = await request(app).post('/processing/presets/import').send({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'convert',
      presets: [
        { displayName: 'Atomic A', config: { format: 'webp', quality: 85, originalHandling: 'keep' } },
        { displayName: 'Atomic B', config: { format: 'webp', quality: 0, originalHandling: 'keep' } },
        { displayName: 'Atomic C', config: { format: 'png', quality: 85, originalHandling: 'delete' } },
      ],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.ok).toBe(false);
    const afterInvalid = await request(app).get('/processing/presets?operationType=convert').expect(200);
    expect(afterInvalid.body.presets.map((preset) => preset.id)).toEqual(beforeInvalid.body.presets.map((preset) => preset.id));

    await request(app).post('/processing/presets/import').send({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'workflow-prompt',
      presets: [{
        displayName: 'Imported Workflow',
        config: { positive: [{ type: 'replace', search: '', replacement: 'x' }] },
      }],
    }).expect(200);
    const isolatedConvert = await request(app).get('/processing/presets?operationType=convert').expect(200);
    expect(isolatedConvert.body.presets.some((preset) => preset.displayName === 'Imported Workflow')).toBe(false);
  });

  it('persists resource activity only for committed semantic changes', async () => {
    const loggedEvents = () => db.prepare(`
      SELECT event, context_json
      FROM application_logs
      WHERE event IN (
        'processing.watermark.default.changed',
        'processing.scale_map.updated',
        'processing.preset.imported',
        'processing.preset.renamed',
        'processing.preset.updated'
      )
      ORDER BY id ASC
    `).all();

    await request(app).post('/processing/watermarks/default').send({ watermarkId: 1 }).expect(200);
    await request(app).post('/processing/watermarks/default').send({ watermarkId: 1 }).expect(200);

    const currentScaleMap = await request(app).get('/processing/scale-map').expect(200);
    const changedScaleMap = Object.keys(currentScaleMap.body.definition).length === 0 ? { default: 0.17 } : {};
    await request(app).post('/processing/scale-map/replace').send({ definition: changedScaleMap }).expect(200);
    await request(app).post('/processing/scale-map/replace').send({ definition: changedScaleMap }).expect(200);

    const imported = {
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'convert',
      presets: [{ displayName: 'Activity import', config: { format: 'png', quality: 72, originalHandling: 'keep' } }],
    };
    await request(app).post('/processing/presets/import').send(imported).expect(200);
    await request(app).post('/processing/presets/import').send({ ...imported, presets: [] }).expect(200);

    const created = await request(app).post('/processing/presets').send({
      operationType: 'convert',
      displayName: 'Activity preset',
      config: { format: 'webp', quality: 85, originalHandling: 'keep' },
    }).expect(201);
    await request(app).post(`/processing/presets/${created.body.preset.id}/rename`).send({ displayName: 'Activity renamed' }).expect(200);
    await request(app).post(`/processing/presets/${created.body.preset.id}/rename`).send({ displayName: 'Activity renamed' }).expect(200);

    const replacement = { config: { format: 'png', quality: 72, originalHandling: 'keep' } };
    await request(app).post(`/processing/presets/${created.body.preset.id}/replace`).send(replacement).expect(200);
    await request(app).post(`/processing/presets/${created.body.preset.id}/replace`).send(replacement).expect(200);

    const events = loggedEvents();
    expect(events.map(({ event }) => event)).toEqual([
      'processing.watermark.default.changed',
      'processing.scale_map.updated',
      'processing.preset.imported',
      'processing.preset.renamed',
      'processing.preset.updated',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/Activity import|Activity preset|quality|definition|0\.17/);
  });

  it('rejects invalid bundle metadata and portable Watermark resource fields before mutation', async () => {
    const before = await request(app).get('/processing/presets?operationType=watermark').expect(200);
    const wrongMarker = await request(app).post('/processing/presets/import').send({
      creatorcrate: 'processing-preset',
      version: 1,
      operationType: 'watermark',
      presets: [],
    });
    expect(wrongMarker.status).toBe(400);

    const forbidden = await request(app).post('/processing/presets/import').send({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'watermark',
      presets: [{
        displayName: 'Unsafe Watermark',
        config: { mode: 'custom', outputDirectory: 'project-output', watermarkId: 1 },
      }],
    });
    expect(forbidden.status).toBe(400);
    const after = await request(app).get('/processing/presets?operationType=watermark').expect(200);
    expect(after.body.presets.map((preset) => preset.id)).toEqual(before.body.presets.map((preset) => preset.id));
  });
});
