import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createGeneratedArtifactRepository } from '../src/data/generated-artifact-repository.js';
import { createWatermarkScaleMapRepository } from '../src/data/watermark-scale-map-repository.js';
import { createProcessingPresetRepository } from '../src/data/processing-preset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetProcessingScopeService } from '../src/services/asset-processing-scope-service.js';
import { createAssetProcessingPlanner as createAssetProcessingPlannerRaw } from '../src/services/asset-processing-planner.js';
import { createWatermarkScaleMapService } from '../src/services/watermark-scale-map-service.js';
import { createProcessingPresetService } from '../src/services/processing-preset-service.js';
import { createPngChunk, PNG_SIGNATURE } from '../src/services/workflow-prompt-editor.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function createAssetProcessingPlanner(dependencies) {
  const planner = createAssetProcessingPlannerRaw(dependencies);
  const planWatermark = planner.planWatermark.bind(planner);
  const renderWatermarkPreview = planner.renderWatermarkPreview.bind(planner);
  return {
    ...planner,
    planWatermark(projectId, scope, options = {}) {
      const outputCategorySlug = options.mode === 'social' ? 'wm-lq' : 'wm';
      return planWatermark(projectId, scope, { outputCategorySlug, ...options });
    },
    renderWatermarkPreview(projectId, scope, options = {}) {
      const outputCategorySlug = options.mode === 'social' ? 'wm-lq' : 'wm';
      return renderWatermarkPreview(projectId, scope, { outputCategorySlug, ...options });
    },
  };
}

function projectInput() {
  return {
    title: 'Processing Planner Project',
    description: '',
    notes: '',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  };
}

async function imageBuffer(format = 'png', width = 40, height = 24) {
  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 80, g: 120, b: 180, alpha: 1 },
    },
  });
  return format === 'jpg'
    ? image.jpeg({ quality: 85 }).toBuffer()
    : image[format]().toBuffer();
}

function textChunk(key, value) {
  return createPngChunk('tEXt', Buffer.concat([
    Buffer.from(key, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'utf8'),
  ]));
}

function promptPng(key, value) {
  return Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk('IHDR', Buffer.alloc(13)),
    textChunk(key, value),
    createPngChunk('IEND'),
  ]);
}

function comfyWorkflow() {
  return JSON.stringify({
    '1': {
      class_type: 'KSampler',
      inputs: { positive: ['2', 0], negative: ['3', 0] },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'portrait subject' },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'blurry' },
    },
  });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function snapshotTree(root) {
  const entries = [];
  function visit(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolutePath);
      if (entry.isDirectory()) {
        entries.push(['directory', relativePath]);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        entries.push([
          'file',
          relativePath,
          stats.size,
          stats.mtimeMs,
          sha256(fs.readFileSync(absolutePath)),
        ]);
      } else {
        entries.push(['other', relativePath, stats.mode]);
      }
    }
  }
  visit(root, '');
  return entries;
}

function snapshotDatabase(db) {
  return {
    assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
    releaseAssets: db.prepare('SELECT * FROM release_assets ORDER BY release_id, asset_id').all(),
  };
}

describe('asset processing planner', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let projectRepository;
  let assetRepository;
  let categoryRepository;
  let assetCategoryService;
  let projectService;
  let scopeService;
  let planner;
  let project;
  let projectDir;
  let finalCategory;
  let wmCategory;
  let watermarkPath;
  let baseImage;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-planner-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    const generatedArtifactRepository = createGeneratedArtifactRepository(db);
    categoryRepository = createAssetCategoryRepository(db);
    assetCategoryService = createAssetCategoryService(categoryRepository);
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(db),
    });
    project = projectService.create(projectInput());
    projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    finalCategory = categoryRepository.listProjectCategories(project.id)
      .find((category) => category.directory_slug === 'final');
    wmCategory = categoryRepository.listProjectCategories(project.id)
      .find((category) => category.directory_slug === 'wm');
    baseImage = await imageBuffer();
    watermarkPath = path.join(tmpDir, 'trusted-watermark.png');
    fs.writeFileSync(watermarkPath, await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer());
    scopeService = createAssetProcessingScopeService({ projectRepository, assetRepository });
    planner = createAssetProcessingPlanner({
      scopeService,
      projectRepository,
      assetRepository,
      generatedArtifactRepository,
      assetCategoryService,
      projectsRoot,
      watermarkPath,
      watermarkRoot: tmpDir,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAsset(relativePath, buffer = baseImage) {
    const normalized = relativePath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalized);
    const absolutePath = path.join(projectDir, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);
    const stats = fs.statSync(absolutePath);
    const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    return assetRepository.upsert(project.id, normalized, {
      categoryId: normalized.toLowerCase().startsWith('final/') ? finalCategory.id : null,
      nestedPath: '',
      filename,
      extension,
      mimeType: extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  function addPublishedRelease(assetId) {
    const releaseId = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date,
                            published_date, patreon_url, archived_at)
      VALUES (?, 'Published', '', '', NULL, '2026-01-01', NULL, NULL)
      RETURNING id
    `).get(project.id).id;
    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'attachment', 0)
    `).run(releaseId, assetId);
  }

  function setWatermarkProvenance(asset, source, mode, digest) {
    db.prepare(`
      UPDATE assets
      SET generated_by = 'watermark',
          generated_source_asset_id = ?,
          generated_source_relative_path = ?,
          generated_mode = ?,
          generated_variant = 'unresized',
          generated_output_sha256 = ?
      WHERE id = ?
    `).run(source.id, source.relative_path, mode, digest, asset.id);
  }

  it('plans Convert across selected and directory scopes without mutation', async () => {
    const png = writeAsset('Final/render.png');
    const jpg = writeAsset('Final/photo.jpg');
    const bmp = writeAsset('Final/bitmap.bmp');
    const gif = writeAsset('Final/animation.gif');
    const nested = writeAsset('Final/nested/deep.webp');
    const unsupported = writeAsset('Final/readme.txt', Buffer.from('text'));
    const beforeTree = snapshotTree(projectDir);
    const beforeDatabase = snapshotDatabase(db);

    const selectedPlan = await planner.planConvert(project.id, {
      type: 'selected',
      assetIds: [png.id, jpg.id, bmp.id, gif.id, unsupported.id],
    }, { format: 'webp', originalHandling: 'keep' });
    const directoryPlan = await planner.planConvert(project.id, {
      type: 'directory',
      relativePath: 'Final',
      recursive: false,
    }, { format: 'webp', originalHandling: 'keep' });
    const recursivePlan = await planner.planConvert(project.id, {
      type: 'directory',
      relativePath: 'Final',
      recursive: true,
    }, { format: 'webp', originalHandling: 'keep' });

    expect(selectedPlan.operation).toBe('convert');
    expect(selectedPlan.assetIds).toEqual([png.id, jpg.id, bmp.id, gif.id, unsupported.id]);
    expect(selectedPlan.options.quality).toBe(85);
    expect(selectedPlan.counts).toMatchObject({ total: 5, eligible: 4, skipped: 1, changed: 4 });
    expect(selectedPlan.items.find((item) => item.assetId === unsupported.id)).toMatchObject({
      status: 'skipped',
      operationEligibility: 'unsupported',
      reasonCode: 'UNSUPPORTED_SOURCE_TYPE',
    });
    expect(selectedPlan.items.find((item) => item.assetId === png.id)).toMatchObject({
      status: 'ready',
      plannedDestination: {
        relativePath: 'Final/render.webp',
        action: 'create-output',
      },
    });
    expect(directoryPlan.assetIds).toEqual(directoryPlan.items.map((item) => item.assetId));
    expect(directoryPlan.items.map((item) => item.relativePath)).toEqual([
      'Final/animation.gif',
      'Final/bitmap.bmp',
      'Final/photo.jpg',
      'Final/readme.txt',
      'Final/render.png',
    ]);
    expect(recursivePlan.items.some((item) => item.assetId === nested.id)).toBe(true);
    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(snapshotDatabase(db)).toEqual(beforeDatabase);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-'))).toEqual([]);
  });

  it('plans Convert same-extension re-encode, move/delete guards, and collisions', async () => {
    const same = writeAsset('Final/in-place.png');
    const move = writeAsset('Final/move.png');
    const deleteSource = writeAsset('Final/protected.png');
    const collisionPng = writeAsset('Final/collision.png');
    const collisionJpg = writeAsset('Final/collision.jpg');
    writeAsset('Final/existing.webp');
    addPublishedRelease(deleteSource.id);

    const samePlan = await planner.planConvert(project.id, {
      type: 'selected',
      assetIds: [same.id],
    }, { format: 'png', originalHandling: 'keep' });
    const blockedPlan = await planner.planConvert(project.id, {
      type: 'selected',
      assetIds: [same.id],
    }, { format: 'png', originalHandling: 'move' });
    const movePlan = await planner.planConvert(project.id, {
      type: 'selected',
      assetIds: [move.id],
    }, { format: 'webp', originalHandling: 'move' });
    const deletePlan = await planner.planConvert(project.id, {
      type: 'selected',
      assetIds: [deleteSource.id],
    }, { format: 'webp', originalHandling: 'delete' });
    const collisionPlan = await planner.planConvert(project.id, {
      type: 'selected',
      assetIds: [collisionPng.id, collisionJpg.id],
    }, { format: 'webp', originalHandling: 'keep' });

    expect(samePlan.items[0]).toMatchObject({
      status: 'ready',
      plannedDestination: {
        relativePath: 'Final/in-place.png',
        action: 'reencode-in-place',
        sameExtension: true,
      },
    });
    expect(blockedPlan.items[0]).toMatchObject({ status: 'blocked', reasonCode: 'INVALID_ORIGINAL_HANDLING' });
    expect(movePlan.items[0]).toMatchObject({
      status: 'ready',
      sourceAction: { type: 'move', destinationRelativePath: 'Final/originals/move.png' },
    });
    expect(deletePlan.items[0]).toMatchObject({ status: 'blocked', reasonCode: 'PUBLISHED_RELEASE_PROTECTED' });
    expect(collisionPlan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'conflict', reasonCode: 'INTRA_PLAN_COLLISION' }),
      expect.objectContaining({ status: 'conflict', reasonCode: 'INTRA_PLAN_COLLISION' }),
    ]));
  });

  it('plans Workflow Prompt Editor changes, no-ops, missing metadata, and corrupt PNGs per item', async () => {
    const comfy = writeAsset('Final/comfy.png', promptPng('workflow', comfyWorkflow()));
    const parameters = writeAsset(
      'Final/a1111.png',
      promptPng('parameters', 'Positive prompt: sunset\nNegative prompt: blurry\nSteps: 20'),
    );
    const noWorkflow = writeAsset('Final/no-workflow.png', promptPng('comment', 'plain image'));
    const unchanged = writeAsset('Final/unchanged.png', promptPng('parameters', 'Positive prompt: sunset'));
    const corrupt = writeAsset('Final/corrupt.png', Buffer.from('not a png'));
    const jpg = writeAsset('Final/not-eligible.jpg');
    const beforeTree = snapshotTree(projectDir);
    const beforeDatabase = snapshotDatabase(db);

    const plan = await planner.planWorkflowPromptEdit(project.id, {
      type: 'mixed',
      entries: [
        { type: 'asset', assetId: comfy.id },
        { type: 'directory', relativePath: 'Final', recursive: false },
      ],
    }, {
      positive: { rules: [{ type: 'replace', search: 'portrait', replacement: 'landscape' }] },
      negative: { rules: [{ type: 'append', text: ', low quality' }] },
    });
    const unchangedPlan = await planner.planWorkflowPromptEdit(project.id, {
      type: 'selected',
      assetIds: [unchanged.id],
    }, { positive: { rules: [{ type: 'replace', search: 'missing', replacement: 'still missing' }] } });

    expect(plan.operation).toBe('workflowPromptEdit');
    expect(plan.items.find((item) => item.assetId === comfy.id)).toMatchObject({
      status: 'ready',
      metadataKey: 'workflow',
      beforePositive: 'portrait subject',
      afterPositive: 'landscape subject',
      beforeNegative: 'blurry',
      afterNegative: 'blurry, low quality',
      positiveChanged: true,
      negativeChanged: true,
    });
    expect(plan.items.find((item) => item.assetId === parameters.id)).toMatchObject({
      status: 'ready',
      metadataKey: 'parameters',
      beforePositive: 'sunset',
      afterPositive: 'sunset',
      beforeNegative: 'blurry',
      afterNegative: 'blurry, low quality',
    });
    expect(plan.items.find((item) => item.assetId === noWorkflow.id)).toMatchObject({
      status: 'blocked',
      reasonCode: 'NO_WORKFLOW_METADATA',
    });
    expect(unchangedPlan.items[0]).toMatchObject({
      status: 'unchanged',
      reasonCode: 'NO_PROMPT_CHANGES',
      metadataKey: 'parameters',
    });
    expect(plan.items.find((item) => item.assetId === corrupt.id)).toMatchObject({
      status: 'error',
      reasonCode: 'MALFORMED_PNG',
    });
    expect(plan.items.find((item) => item.assetId === jpg.id)).toMatchObject({
      status: 'skipped',
      operationEligibility: 'unsupported',
      reasonCode: 'UNSUPPORTED_SOURCE_TYPE',
    });
    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(snapshotDatabase(db)).toEqual(beforeDatabase);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-'))).toEqual([]);
  });

  it('accepts all seeded Workflow presets through the planner execution entry point', async () => {
    const source = writeAsset('Final/preset-workflow.png', promptPng('workflow', comfyWorkflow()));
    const scaleMapService = createWatermarkScaleMapService({
      repository: createWatermarkScaleMapRepository(db),
    });
    const presetService = createProcessingPresetService({
      repository: createProcessingPresetRepository(db),
      scaleMapService,
      watermarkService: {
        getWatermark(id) {
          if (id !== 1) throw Object.assign(new Error('Watermark not found.'), { code: 'WATERMARK_NOT_FOUND' });
          return { id };
        },
        resolveForProcessing(id) { return { watermark: this.getWatermark(id) }; },
      },
    });
    presetService.seedReferencePresets();

    const plans = await Promise.all(presetService.listPresets({ operationType: 'workflow-prompt' }).map(async (preset) => {
      const resolved = presetService.resolvePresetForExecution(preset.id);
      return planner.planWorkflowPromptEdit(project.id, { type: 'selected', assetIds: [source.id] }, resolved.options);
    }));
    const benji = plans.find((plan) => plan.items[0].afterNegative === 'extra abs, blurry');

    expect(plans).toHaveLength(5);
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'workflowPromptEdit' }),
    ]));
    expect(benji.items[0]).toMatchObject({ status: 'ready', afterNegative: 'extra abs, blurry' });
    await expect(planner.planWorkflowPromptEdit(project.id, { type: 'selected', assetIds: [source.id] }, {
      positive: [], negative: { rules: [] },
    })).rejects.toMatchObject({ code: 'INVALID_PROMPT_RULES' });
  });

  it('plans Watermark outputs, ownership, deletion protection, and geometry without writing', async () => {
    const patreon = writeAsset('Final/patreon.png', await imageBuffer('png', 100, 60));
    const social = writeAsset('Final/social.png', await imageBuffer('png', 100, 60));
    const unsupported = writeAsset('Final/source.txt', Buffer.from('not an image'));
    const safeSource = writeAsset('Final/safe.png');
    const safeOutputBuffer = await imageBuffer();
    const safeOutput = writeAsset('wm/safe_wm.png', safeOutputBuffer);
    db.prepare('UPDATE assets SET category_id = ?, nested_path = ? WHERE id = ?').run(wmCategory.id, '', safeOutput.id);
    setWatermarkProvenance(safeOutput, safeSource, 'patreon', sha256(safeOutputBuffer));
    const missingSource = writeAsset('Final/missing-generated.png');
    const missingOutput = assetRepository.upsert(project.id, 'wm/missing-generated_wm.png', {
      categoryId: wmCategory.id,
      nestedPath: '',
      filename: 'missing-generated_wm.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 0,
      modifiedAt: null,
    });
    setWatermarkProvenance(missingOutput, missingSource, 'patreon', 'a'.repeat(64));
    const malformedSource = writeAsset('Final/malformed.png');
    const malformedOutput = writeAsset('wm/malformed_wm.png');
    db.prepare('UPDATE assets SET category_id = ?, nested_path = ? WHERE id = ?').run(wmCategory.id, '', malformedOutput.id);
    setWatermarkProvenance(malformedOutput, malformedSource, 'patreon', 'not-a-sha256');
    const protectedSource = writeAsset('Final/protected-watermark.png');
    addPublishedRelease(protectedSource.id);
    const foreignSource = writeAsset('Final/foreign.png');
    const foreignDestinationPath = path.join(projectDir, 'wm', 'foreign_wm.png');
    fs.mkdirSync(path.dirname(foreignDestinationPath), { recursive: true });
    fs.writeFileSync(foreignDestinationPath, await imageBuffer());
    const collisionPng = writeAsset('Final/collision.png');
    const collisionJpg = writeAsset('Final/collision.jpg');

    const beforeTree = snapshotTree(projectDir);
    const beforeDatabase = snapshotDatabase(db);
    const patreonPlan = await planner.planWatermark(project.id, {
      type: 'selected',
      assetIds: [patreon.id, unsupported.id, safeSource.id, missingSource.id, malformedSource.id],
    }, { mode: 'patreon', primaryFormat: 'png', secondaryFormat: null, resizedFormat: null, deleteSource: false });
    const socialPlan = await planner.planWatermark(project.id, {
      type: 'selected',
      assetIds: [social.id, protectedSource.id],
    }, { mode: 'social', primaryFormat: null, secondaryFormat: null, resizedFormat: 'png' });
    const foreignPlan = await planner.planWatermark(project.id, {
      type: 'selected',
      assetIds: [foreignSource.id],
    }, { mode: 'patreon', primaryFormat: 'png', secondaryFormat: null, resizedFormat: null, deleteSource: false });
    const collisionPlan = await planner.planWatermark(project.id, {
      type: 'selected',
      assetIds: [collisionPng.id, collisionJpg.id],
    }, { mode: 'social', primaryFormat: null, secondaryFormat: null, resizedFormat: 'png', deleteSource: false });
    await expect(planner.planWatermark(project.id, {
      type: 'selected', assetIds: [patreon.id],
    }, { mode: 'patreon', outputCategorySlug: 'missing-category' }))
      .rejects.toMatchObject({ code: 'OUTPUT_CATEGORY_NOT_FOUND' });
    await expect(planner.planWatermark(project.id, {
      type: 'selected', assetIds: [patreon.id],
    }, { mode: 'patreon', outputCategorySlug: '../outside' }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT_CATEGORY' });

    expect(patreonPlan.items.find((item) => item.assetId === patreon.id)).toMatchObject({
      status: 'ready',
      plannedDestination: {
        relativePath: 'wm/patreon_wm.png',
        existsInIndex: false,
        existsOnFilesystem: false,
      },
      sourceAction: { type: 'keep' },
      geometry: {
        output: { width: 100, height: 60 },
        geometry: {
          sourceDimensions: { width: 100, height: 60 },
          compositeDimensions: { width: 100, height: 60 },
          effectiveScale: 0.1,
          scaleBasis: 'window',
          scaleBasisPixels: 60,
        },
      },
    });
    expect(patreonPlan.items.find((item) => item.assetId === safeSource.id)).toMatchObject({
      status: 'ready',
      destinationOwnership: 'creatorcrate-owned-overwrite',
    });
    expect(patreonPlan.items.find((item) => item.assetId === missingSource.id)).toMatchObject({
      status: 'ready',
      destinationOwnership: 'missing-generated-destination',
    });
    expect(patreonPlan.items.find((item) => item.assetId === malformedSource.id)).toMatchObject({
      status: 'conflict',
      reasonCode: 'MALFORMED_PROVENANCE',
    });
    expect(patreonPlan.items.find((item) => item.assetId === unsupported.id)).toMatchObject({
      status: 'skipped',
      operationEligibility: 'unsupported',
      reasonCode: 'UNSUPPORTED_SOURCE_TYPE',
    });
    expect(socialPlan.items.find((item) => item.assetId === social.id)).toMatchObject({
      status: 'ready',
      sourceAction: { type: 'delete', destructive: true },
      plannedDestination: { relativePath: 'wm-lq/social_lq_wm.png' },
    });
    expect(socialPlan.items.find((item) => item.assetId === protectedSource.id)).toMatchObject({
      status: 'blocked',
      reasonCode: 'PUBLISHED_RELEASE_PROTECTED',
    });
    expect(foreignPlan.items[0]).toMatchObject({
      status: 'conflict',
      reasonCode: 'DESTINATION_EXISTS',
    });
    expect(collisionPlan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'conflict', reasonCode: 'INTRA_PLAN_COLLISION' }),
      expect.objectContaining({ status: 'conflict', reasonCode: 'INTRA_PLAN_COLLISION' }),
    ]));
    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(snapshotDatabase(db)).toEqual(beforeDatabase);
    expect(fs.readdirSync(projectDir).filter((name) => name.startsWith('.creatorcrate-'))).toEqual([]);
  });

  it('previews ZIP and CBZ artifacts without writing them and reports resized-only blockers', async () => {
    const source = writeAsset('Final/sub/archive.png');
    const beforeTree = snapshotTree(projectDir);
    const beforeDatabase = snapshotDatabase(db);

    const plan = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, {
      mode: 'custom', primaryFormat: 'png', secondaryFormat: null, resizedFormat: null, deleteSource: false,
      makeArchives: true, makeCbz: true, setName: 'Preview Set',
    });
    expect(plan.archives).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'Preview Set_jpg_q80.zip', entryCount: 1, variants: ['unresized'], status: 'ready' }),
      expect.objectContaining({ relativePath: 'Preview Set_webp_q90.zip', entryCount: 1, variants: ['unresized'], status: 'ready' }),
      expect.objectContaining({ relativePath: 'Preview Set_jpg_q85.cbz', entryCount: 1, format: 'cbz', status: 'ready' }),
    ]));
    const sevenPlan = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, {
      mode: 'custom', primaryFormat: 'png', secondaryFormat: null, resizedFormat: null, deleteSource: false,
      makeArchives: true, makeCbz: true, archiveFormat: '7z', setName: 'Preview 7z',
    });
    expect(sevenPlan.archives).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'Preview 7z_jpg_q80.7z', format: '7z', entryCount: 1, status: 'ready' }),
      expect.objectContaining({ relativePath: 'Preview 7z_webp_q90.7z', format: '7z', entryCount: 1, status: 'ready' }),
      expect.objectContaining({ relativePath: 'Preview 7z_jpg_q85.cbz', format: 'cbz', entryCount: 1, status: 'ready' }),
    ]));

    const blocked = await planner.planWatermark(project.id, {
      type: 'selected', assetIds: [source.id],
    }, {
      mode: 'custom', primaryFormat: null, secondaryFormat: null, resizedFormat: 'png', deleteSource: true,
      maxDimension: 20, makeArchives: true,
    });
    expect(blocked.operationBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RESIZED_ONLY_ARCHIVE_BLOCKED', preventsSourceDeletion: true }),
    ]));
    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(snapshotDatabase(db)).toEqual(beforeDatabase);
  });

  it('renders the first canonical Watermark source in memory with the primary resized variant', async () => {
    const first = writeAsset('Final/a-first.png', await imageBuffer('png', 100, 60));
    const second = writeAsset('Final/b-second.png', await imageBuffer('png', 100, 60));
    const beforeTree = snapshotTree(projectDir);
    const beforeDatabase = snapshotDatabase(db);

    const preview = await planner.renderWatermarkPreview(project.id, {
      type: 'selected', assetIds: [second.id, first.id],
    }, {
      mode: 'custom', primaryFormat: null, secondaryFormat: null, resizedFormat: 'png', maxDimension: 40, deleteSource: false,
    });

    expect(preview).toMatchObject({
      filename: 'b-second.png', eligibleCount: 2, variant: 'resized', contentType: 'image/png', width: 40, height: 24,
    });
    expect(preview.buffer).toBeInstanceOf(Buffer);
    expect(preview.buffer.equals(baseImage)).toBe(false);
    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(snapshotDatabase(db)).toEqual(beforeDatabase);
  });

  it('uses the canonical scale map for plan geometry and ignores a historical request ID', async () => {
    const source = writeAsset('Final/managed-scale.png', await imageBuffer('png', 100, 60));
    const scaleMapRepository = createWatermarkScaleMapRepository(db);
    const scaleMapService = createWatermarkScaleMapService({ repository: scaleMapRepository });
    const canonicalId = Number(db.prepare(`
      INSERT INTO watermark_scale_maps (display_name, system_key, definition_json)
      VALUES ('Reference', 'reference-watermark-scale-map', '{"100x60":0.35,"default":0.1}')
    `).run().lastInsertRowid);
    const historicalId = Number(db.prepare(`
      INSERT INTO watermark_scale_maps (display_name, definition_json)
      VALUES ('Historical map', '{"100x60":0.9,"default":0.1}')
    `).run().lastInsertRowid);
    const managedPlanner = createAssetProcessingPlanner({
      scopeService, projectRepository, assetRepository, assetCategoryService, projectsRoot,
      watermarkPath, watermarkRoot: tmpDir, scaleMapService,
    });
    const beforeTree = snapshotTree(projectDir);
    const beforeDatabase = snapshotDatabase(db);

    const canonicalRequest = await managedPlanner.planWatermark(project.id, { type: 'selected', assetIds: [source.id] }, {
      mode: 'custom', outputFormat: 'png', deleteSource: false, scaleMapId: canonicalId,
    });
    const historicalRequest = await managedPlanner.planWatermark(project.id, { type: 'selected', assetIds: [source.id] }, {
      mode: 'custom', outputFormat: 'png', deleteSource: false, scaleMapId: historicalId,
    });

    expect(canonicalRequest).not.toHaveProperty('scaleMap');
    expect(canonicalRequest.items[0].geometry.watermark.scale).toBe(0.35);
    expect(historicalRequest.items[0].geometry.watermark.scale).toBe(0.35);
    expect(scaleMapRepository.findById(historicalId).definition_json).toBe('{"100x60":0.9,"default":0.1}');
    expect(snapshotTree(projectDir)).toEqual(beforeTree);
    expect(snapshotDatabase(db)).toEqual(beforeDatabase);
  });
});
