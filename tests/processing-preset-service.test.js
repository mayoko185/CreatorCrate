import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createProcessingPresetRepository } from '../src/data/processing-preset-repository.js';
import {
  createProcessingPresetService,
  ProcessingPresetServiceError,
} from '../src/services/processing-preset-service.js';
import { applyPromptRules } from '../src/services/workflow-prompt-editor.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('processing preset service', () => {
  let tmpDir;
  let db;
  let repository;
  let watermarkService;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-preset-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createProcessingPresetRepository(db);
    watermarkService = {
      getWatermark(id) {
        if (id !== 1) throw Object.assign(new Error('Watermark not found.'), { code: 'WATERMARK_NOT_FOUND' });
        return { id, displayName: 'Managed watermark' };
      },
      resolveForProcessing(id) { return { watermark: this.getWatermark(id), filePath: 'not-exposed-to-presets' }; },
    };
    service = createProcessingPresetService({ repository, watermarkService });
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds the audited reference map and nine mutable structured presets exactly once', () => {
    expect(service.seedReferencePresets()).toBe(true);
    expect(service.seedReferencePresets()).toBe(false);

    const scaleMap = db.prepare(`
      SELECT system_key, definition_json FROM watermark_scale_maps
      WHERE system_key = 'reference-watermark-scale-map'
    `).get();
    expect(scaleMap.system_key).toBe('reference-watermark-scale-map');
    expect(JSON.parse(scaleMap.definition_json)).toEqual({
        '1365x768': 0.35, '1248x832': 0.35, '2496x1664': 0.35, '5376x3072': 0.35, '4992x3328': 0.35,
        '1024x1024': 0.37, '2048x2048': 0.37, '2304x2304': 0.37, '3072x3072': 0.37, '4096x4096': 0.37,
        '1600x2592': 0.31, '2560x6144': 0.28, '832x1248': 0.32, '1365x2048': 0.32, '1664x2496': 0.32,
        '3328x4992': 0.32, default: 0.1,

    });
    const presets = service.listPresets();
    expect(presets).toHaveLength(9);
    expect(presets.map(({ systemKey }) => systemKey)).toEqual(expect.arrayContaining([
      'watermark-patreon', 'watermark-social', 'convert-webp-85-delete-originals',
      'convert-webp-85-move-originals', 'workflow-general', 'workflow-benji', 'workflow-max',
      'workflow-oliver', 'workflow-rory',
    ]));
    expect(presets.find(({ systemKey }) => systemKey === 'watermark-patreon')).toMatchObject({
      watermarkId: null,
      config: expect.objectContaining({ mode: 'patreon', outputCategorySlug: 'wm', primaryFormat: 'png', secondaryFormat: null, resizedFormat: null, unresizedSuffix: '_wm', resizedSuffix: '_lq_wm' }),
    });
    expect(presets.find(({ systemKey }) => systemKey === 'watermark-social')).toMatchObject({
      watermarkId: null,
      config: expect.objectContaining({ mode: 'social', outputCategorySlug: 'wm-lq', maxDimension: 1100, primaryFormat: null, secondaryFormat: null, resizedFormat: 'png', unresizedSuffix: '_wm', resizedSuffix: '_lq_wm', deleteSource: true }),
    });
    expect(presets.filter(({ operationType }) => operationType === 'watermark')).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ scaleMapId: expect.anything() })]),
    );
    expect(db.prepare(`
      SELECT scale_map_id FROM processing_presets
      WHERE system_key IN ('watermark-patreon', 'watermark-social')
      ORDER BY system_key
    `).pluck().all()).toEqual([null, null]);
  });

  it('normalizes a legacy stored single suffix without rewriting the database row', () => {
    const result = db.prepare(`
      INSERT INTO processing_presets (operation_type, display_name, config_version, config_json)
      VALUES ('watermark', 'Legacy suffix', 1, ?)
    `).run(JSON.stringify({ mode: 'custom', singleSuffix: '_legacy' }));

    const preset = service.getPreset(Number(result.lastInsertRowid));
    expect(preset.config).toMatchObject({ unresizedSuffix: '_legacy', resizedSuffix: '_lq_wm' });
    expect(preset.config).not.toHaveProperty('singleSuffix');
    expect(JSON.parse(db.prepare('SELECT config_json FROM processing_presets WHERE id = ?').get(result.lastInsertRowid).config_json))
      .toEqual({ mode: 'custom', singleSuffix: '_legacy' });
  });

  it('seeds safely around single, case-insensitive, and multiple user display-name collisions', () => {
    const userGeneral = service.createPreset({
      operationType: 'workflow-prompt', displayName: 'general',
      config: { positive: { rules: [{ type: 'append', text: ' user' }] } },
    });
    const userBenji = service.createPreset({
      operationType: 'workflow-prompt', displayName: 'Benji', config: {},
    });
    const userConvert = service.createPreset({
      operationType: 'convert', displayName: 'WebP 85 — Delete Originals',
      config: { format: 'webp', quality: 77, originalHandling: 'keep' },
    });

    expect(service.seedReferencePresets()).toBe(true);

    const presets = service.listPresets();
    const seeded = presets.filter((preset) => preset.systemKey);
    expect(service.getPreset(userGeneral.id).config.positive).toEqual([{ type: 'append', text: ' user' }]);
    expect(service.getPreset(userBenji.id).displayName).toBe('Benji');
    expect(service.getPreset(userConvert.id).config.quality).toBe(77);
    expect(seeded).toHaveLength(9);
    expect(seeded.find((preset) => preset.systemKey === 'workflow-general')).toMatchObject({
      displayName: 'General (CreatorCrate)',
    });
    expect(seeded.find((preset) => preset.systemKey === 'workflow-benji')).toMatchObject({
      displayName: 'Benji (CreatorCrate)',
    });
    expect(seeded.find((preset) => preset.systemKey === 'convert-webp-85-delete-originals')).toMatchObject({
      displayName: 'WebP 85 — Delete Originals (CreatorCrate)',
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM watermark_scale_maps WHERE system_key = 'reference-watermark-scale-map'").get())
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get('processing_presets.seed_version_2')).toEqual({ value: '1' });

    expect(service.seedReferencePresets()).toBe(false);
    expect(service.listPresets().filter((preset) => preset.systemKey)).toHaveLength(9);
  });

  it('does not recreate a seeded preset after a successful seed marker is written', () => {
    service.seedReferencePresets();
    const general = service.listPresets().find((preset) => preset.systemKey === 'workflow-general');

    service.deletePreset(general.id);

    expect(service.seedReferencePresets()).toBe(false);
    expect(service.listPresets().find((preset) => preset.systemKey === 'workflow-general')).toBeUndefined();
  });

  it('supports CRUD while rejecting runtime scope and resource fields from configurations', () => {
    const convert = service.createPreset({
      operationType: 'convert', displayName: 'Default',
      config: { format: 'webp', quality: 85, originalHandling: 'move' },
    });
    const workflow = service.createPreset({
      operationType: 'workflow-prompt', displayName: 'Default',
      config: { positive: { rules: [{ type: 'replace', search: '', replacement: 'prefix' }] } },
    });
    const watermark = service.createPreset({
      operationType: 'watermark', displayName: 'Default',
      config: { mode: 'custom', scale: 0.3, outputFormat: 'png' },
    });
    expect(service.listPresets({ operationType: 'convert' })).toEqual([expect.objectContaining({ id: convert.id })]);
    expect(service.renamePreset(convert.id, 'Renamed').displayName).toBe('Renamed');
    expect(service.replacePreset(convert.id, { config: { format: 'webp', quality: 90, originalHandling: 'delete' } }).config)
      .toEqual({ format: 'webp', originalHandling: 'delete', quality: 90 });
    expect(service.deletePreset(workflow.id)).toMatchObject({ id: workflow.id });
    expect(service.getPreset(watermark.id).operationType).toBe('watermark');
    expect(() => service.createPreset({
      operationType: 'convert', displayName: 'Scoped',
      config: { format: 'webp', quality: 85, originalHandling: 'move', projectId: 1 },
    })).toThrow(expect.objectContaining({ code: 'PRESET_FIELD_NOT_ALLOWED' }));
    expect(() => service.createPreset({
      operationType: 'watermark', displayName: 'Unsafe path',
      config: { mode: 'custom', watermarkPath: 'G:\\outside.png' },
    })).toThrow(expect.objectContaining({ code: 'PRESET_FIELD_NOT_ALLOWED' }));
  });

  it('validates the complete bundle before mutating any presets', () => {
    expect(() => service.importPresetBundle({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'convert',
      presets: [
        { displayName: 'Valid A', config: { format: 'webp', quality: 85, originalHandling: 'keep' } },
        { displayName: 'Malformed B', config: { format: 'webp', quality: 0, originalHandling: 'keep' } },
        { displayName: 'Valid C', config: { format: 'png', quality: 85, originalHandling: 'delete' } },
      ],
    })).toThrow(ProcessingPresetServiceError);

    expect(service.listPresets({ operationType: 'convert' })).toEqual([]);
  });

  it('imports all entries with deterministic case-insensitive collision suffixes', () => {
    service.createPreset({ operationType: 'convert', displayName: 'Foo', config: { format: 'webp', quality: 85, originalHandling: 'keep' } });
    service.createPreset({ operationType: 'convert', displayName: 'Foo (1)', config: { format: 'webp', quality: 85, originalHandling: 'keep' } });

    const imported = service.importPresetBundle({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'convert',
      presets: [
        { displayName: 'foo', config: { format: 'webp', quality: 80, originalHandling: 'keep' } },
        { displayName: 'Bar', config: { format: 'png', quality: 70, originalHandling: 'delete' } },
        { displayName: 'Foo', config: { format: 'webp', quality: 75, originalHandling: 'move' } },
      ],
    });

    expect(imported).toMatchObject({ imported: 3, renamed: 2 });
    expect(imported.presets.map(({ displayName }) => displayName)).toEqual(['foo (2)', 'Bar', 'Foo (3)']);
    expect(imported.presets.every(({ systemKey }) => systemKey === null)).toBe(true);

    const duplicateBundle = service.importPresetBundle({
      operationType: 'convert',
      presets: [
        { displayName: 'Baz', config: { format: 'webp', quality: 85, originalHandling: 'keep' } },
        { displayName: 'Baz', config: { format: 'webp', quality: 86, originalHandling: 'keep' } },
      ],
    });
    expect(duplicateBundle.presets.map(({ displayName }) => displayName)).toEqual(['Baz', 'Baz (1)']);
  });

  it('never overwrites a seeded/system preset during import', () => {
    service.seedReferencePresets();
    const systemPreset = service.listPresets({ operationType: 'convert' })
      .find(({ systemKey }) => systemKey === 'convert-webp-85-delete-originals');

    const imported = service.importPresetBundle({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'convert',
      presets: [{
        displayName: systemPreset.displayName,
        config: { format: 'webp', quality: 77, originalHandling: 'keep' },
      }],
    });

    expect(imported.presets[0]).toMatchObject({
      displayName: `${systemPreset.displayName} (1)`,
      systemKey: null,
      config: { quality: 77, originalHandling: 'keep' },
    });
    expect(service.getPreset(systemPreset.id)).toMatchObject({
      displayName: systemPreset.displayName,
      systemKey: systemPreset.systemKey,
      config: systemPreset.config,
    });
  });

  it('preserves Workflow rule order and Watermark portability boundaries', () => {
    const workflow = service.importPresetBundle({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'workflow-prompt',
      presets: [{
        displayName: 'Rules',
        config: {
          positive: [
            { type: 'remove', text: 'remove' },
            { type: 'replace', search: '', replacement: 'replace' },
            { type: 'append', text: 'append' },
          ],
          negative: [{ type: 'prepend', text: 'prepend' }],
        },
      }],
    });
    expect(workflow.presets[0].config).toEqual({
      positive: [
        { type: 'remove', text: 'remove' },
        { type: 'replace', search: '', replacement: 'replace' },
        { type: 'append', text: 'append' },
      ],
      negative: [{ type: 'prepend', text: 'prepend' }],
    });

    const watermark = service.importPresetBundle({
      creatorcrate: 'processing-presets',
      version: 1,
      operationType: 'watermark',
      presets: [{ displayName: 'Portable Watermark', config: { mode: 'custom', outputFormat: 'png', scale: 0.3 } }],
    }).presets[0];
    expect(watermark).toMatchObject({ operationType: 'watermark', watermarkId: null });
    expect(watermark.config).not.toHaveProperty('watermarkId');
    expect(watermark.config).not.toHaveProperty('watermarkAssetId');
    expect(watermark.config).not.toHaveProperty('scaleMapId');
    expect(watermark.config).not.toHaveProperty('scaleMap');
  });

  it('fails closed for corrupted config and uses explicit resource override precedence for resolution', () => {
    service.seedReferencePresets();
    const patreon = service.listPresets().find(({ systemKey }) => systemKey === 'watermark-patreon');
    expect(() => service.resolvePresetForExecution(patreon.id)).toThrow(expect.objectContaining({ code: 'WATERMARK_REQUIRED' }));
    const resolved = service.resolvePresetForExecution(patreon.id, { watermarkId: 1 });
    expect(resolved).toMatchObject({ watermark: { id: 1 }, watermarkId: 1 });
    expect(resolved).not.toHaveProperty('scaleMap');
    expect(resolved).not.toHaveProperty('scaleMapId');
    expect(resolved.options).not.toHaveProperty('scaleMapId');
    db.prepare('UPDATE processing_presets SET config_json = ? WHERE id = ?').run('{broken', patreon.id);
    expect(() => service.getPreset(patreon.id)).toThrow(expect.objectContaining({ code: 'PRESET_INVALID' }));
  });

  it('requires a global runtime Watermark ID for Patreon and Social presets', () => {
    service.seedReferencePresets();
    for (const systemKey of ['watermark-patreon', 'watermark-social']) {
      const preset = service.listPresets().find((candidate) => candidate.systemKey === systemKey);
      const resolved = service.resolvePresetForExecution(preset.id, { watermarkId: 1 });
      expect(resolved).toMatchObject({ watermarkId: 1, watermark: { id: 1 } });
      expect(resolved).not.toHaveProperty('scaleMapId');
      expect(resolved.options).toMatchObject({ watermarkId: 1 });
      expect(resolved.options).not.toHaveProperty('watermarkAssetId');
    }
  });

  it('preserves workflow command rule semantics without exposing Scale Map deletion', () => {
    service.seedReferencePresets();
    const general = service.listPresets().find(({ systemKey }) => systemKey === 'workflow-general');
    const result = applyPromptRules(
      '<lora:Illustrious\\concept\\erection_under_clothes.safetensors:1.0>, masterwork, test',
      general.config.positive,
    );
    expect(result).toContain('<lora:Illustrious/concept/erection_under_clothes:0.8>');
    expect(result).not.toContain('masterwork, ');
  });

  it('matches the supplied workflow command transformations for all five usable presets', () => {
    service.seedReferencePresets();
    const byKey = Object.fromEntries(service.listPresets({ operationType: 'workflow-prompt' })
      .map((preset) => [preset.systemKey, preset]));
    expect(applyPromptRules('<lora:Mayoko\\benji\\benji_run15_2026-03-23_1392-40.safetensors:0.8>', byKey['workflow-benji'].config.positive))
      .toBe('<lora:Mayoko/benji/benji_run15_2026-03-23_1392-40:0.7>');
    expect(applyPromptRules('bad', byKey['workflow-benji'].config.negative)).toBe('extra abs, bad');
    expect(applyPromptRules('<lora:Mayoko\\max\\max_run5_2026-03-23_1600_40.safetensors:0.8>', byKey['workflow-max'].config.positive))
      .toBe('<lora:Mayoko/max/max_run5_2026-03-23_1600_40:0.7>');
    expect(applyPromptRules('bad', byKey['workflow-max'].config.negative)).toBe('red penis, bad');
    expect(applyPromptRules('<lora:Mayoko\\oliver\\oliver_run3_2026-05-04-1360-40.safetensors:0.8>', byKey['workflow-oliver'].config.positive))
      .toBe('<lora:Mayoko/oliver/oliver_run3_2026-05-04-1360-40:0.7>');
    expect(applyPromptRules('<lora:Mayoko\\rory\\rory_run2_2026-06-1280.safetensors:0.8>', byKey['workflow-rory'].config.positive))
      .toBe('<lora:Mayoko/rory/rory_run2_2026-06-1280:0.7>');
  });

  it('keeps Watermark identity runtime-only on saved presets', () => {
    const preset = service.createPreset({
      operationType: 'watermark', displayName: 'Runtime-only', watermarkId: 1,
      config: { mode: 'custom', scale: 0.3, outputFormat: 'png' },
    });
    expect(service.getPreset(preset.id)).toMatchObject({ id: preset.id, watermarkId: null });
    expect(() => service.resolvePresetForExecution(preset.id)).toThrow(expect.objectContaining({ code: 'WATERMARK_REQUIRED' }));
    expect(service.resolvePresetForExecution(preset.id, { watermarkId: 1 })).toMatchObject({
      watermarkId: 1,
      watermark: { id: 1 },
    });
  });

  it('does not expose preset storage corruption as executable options', () => {
    expect(() => service.createPreset({ operationType: 'invalid', displayName: 'No', config: {} }))
      .toThrow(ProcessingPresetServiceError);
  });
});
