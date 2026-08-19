import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { resolveContainedAssetPath } from '../storage/asset-file.js';
import { resolveProjectDir } from '../storage/project-storage.js';
import { deriveExtensionFromFilename } from './asset-metadata.js';
import { classifyAssetPath } from './asset-path-classification.js';
import {
  isOwnedWatermarkDestination as isOwnedWatermarkDestinationShared,
  isValidGeneratedOutputSha256,
  resolveTrustedWatermarkFile,
} from './asset-processing-shared.js';
import {
  AssetProcessingError,
  deriveConversionOutputPlan,
  isSupportedConversionSource,
  normalizeConversionOptions,
  normalizeRelativePath,
  pathKey,
  WATERMARK_SOURCE_IMAGE_EXTENSIONS,
} from './asset-processing-service.js';
import {
  editWorkflowPromptsInPng,
  normalizeOrUsePromptEditOptions,
  WorkflowPromptMetadataError,
} from './workflow-prompt-editor.js';
import {
  deriveWatermarkGeometry as deriveSharedWatermarkGeometry,
  deriveWatermarkOutputPlan,
  normalizeWatermarkOptions,
  prepareWatermark,
  renderWatermarkedImage,
  resolveWatermarkOutputCategory,
  WatermarkEngineError,
} from './watermark-engine.js';
import { deriveWatermarkArchivePlans, WatermarkArchiveError } from './watermark-archive.js';
import {
  ARCHIVE_SOURCE_IMAGE_EXTENSIONS,
  ARCHIVES_GENERATED_BY,
  ArchiveProcessingError,
  deriveArchivePlans,
  normalizeArchiveOptions,
} from './archive-processing.js';

const SOURCE_MISSING_CODES = new Set(['ENOENT', 'SOURCE_MISSING']);
const SWAPPED_ORIENTATIONS = new Set([5, 6, 7, 8]);

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const ITEM_ERROR_MESSAGES = Object.freeze({
  MISSING_SOURCE: 'Source file does not exist.',
  SOURCE_PATH_UNSAFE: 'Source file cannot be safely accessed.',
  OUTPUT_PATH_UNSAFE: 'Output path cannot be safely accessed.',
  ORIGINAL_PATH_UNSAFE: 'Original path cannot be safely accessed.',
  ORIGINALS_DIRECTORY_UNSAFE: 'Originals directory cannot be safely accessed.',
  MALFORMED_PNG: 'The PNG workflow metadata is invalid.',
  WATERMARK_PROCESSING_FAILED: 'The source image could not be inspected for watermarking.',
  INVALID_IMAGE_DIMENSIONS: 'The source image dimensions are invalid.',
});

function isPresent(asset) {
  return asset?.is_present === 1 || asset?.is_present === true;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function plannerError(message, code, cause) {
  return new AssetProcessingError(message, { code, cause });
}

function normalizePlanningErrorCode(code, fallback) {
  if (code === 'SOURCE_MISSING' || code === 'ENOENT') return 'MISSING_SOURCE';
  if (code === 'INVALID_PNG_SIGNATURE'
    || code === 'MALFORMED_PNG_METADATA'
    || code === 'OVERSIZED_PNG_METADATA'
    || code === 'MALFORMED_PNG') return 'MALFORMED_PNG';
  return code || fallback;
}

function planningMessage(code, fallback) {
  return ITEM_ERROR_MESSAGES[code] || fallback;
}

function baseItem(asset) {
  const relativePath = typeof asset?.relative_path === 'string'
    ? normalizeRelativePath(asset.relative_path)
    : null;
  return {
    assetId: asset?.id ?? null,
    relativePath,
    filename: relativePath ? path.posix.basename(relativePath) : null,
    eligible: false,
    operationEligibility: null,
    status: 'error',
    reasonCode: null,
    reason: null,
    conflicts: [],
    plannedDestination: null,
    sourceAction: null,
    destructive: false,
  };
}

function unsupportedItem(item) {
  return {
    ...item,
    status: 'skipped',
    operationEligibility: 'unsupported',
    reasonCode: 'UNSUPPORTED_SOURCE_TYPE',
    reason: 'The source type is not supported by this operation.',
  };
}

function itemError(item, err, fallbackCode, fallbackMessage) {
  const code = normalizePlanningErrorCode(err?.code, fallbackCode);
  return {
    ...item,
    status: code === 'INVALID_ORIGINAL_HANDLING' ? 'blocked' : 'error',
    reasonCode: code,
    reason: planningMessage(code, fallbackMessage || err?.message || 'The asset could not be planned.'),
  };
}

function itemConflict(item, reasonCode, reason) {
  return {
    ...item,
    status: 'conflict',
    reasonCode,
    reason,
  };
}

function itemBlocked(item, reasonCode, reason) {
  return {
    ...item,
    status: 'blocked',
    reasonCode,
    reason,
  };
}

function completePlan(operation, projectId, scope, items, options) {
  return {
    operation,
    projectId,
    scope,
    options,
    counts: {
      total: items.length,
      eligible: items.filter((item) => item.eligible).length,
      changed: items.filter((item) => item.status === 'ready' && item.changed !== false).length,
      unchanged: items.filter((item) => item.status === 'unchanged').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      conflicts: items.filter((item) => item.status === 'conflict').length,
      destructive: items.filter((item) => item.destructive).length,
    },
    items,
  };
}

function inspectRequiredFile(absolutePath, code = 'SOURCE_PATH_UNSAFE', label = 'Source') {
  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (err) {
    if (SOURCE_MISSING_CODES.has(err?.code)) {
      throw plannerError(`${label} file does not exist.`, 'MISSING_SOURCE', err);
    }
    throw plannerError(`${label} file cannot be accessed.`, code, err);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw plannerError(`${label} path is not a regular file.`, code);
  }
  return stats;
}

function inspectOptionalFile(absolutePath, code = 'OUTPUT_PATH_UNSAFE', label = 'Output') {
  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw plannerError(`${label} file cannot be accessed.`, code, err);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw plannerError(`${label} path is not a regular file.`, code);
  }
  return stats;
}

function inspectOptionalDirectory(absolutePath) {
  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw plannerError('The originals directory cannot be accessed.', 'ORIGINALS_DIRECTORY_UNSAFE', err);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw plannerError('The originals directory is unsafe.', 'ORIGINALS_DIRECTORY_UNSAFE');
  }
  return stats;
}

function readStableSource(absolutePath) {
  const before = inspectRequiredFile(absolutePath, 'SOURCE_PATH_UNSAFE', 'Source');
  let bytes;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch (err) {
    if (SOURCE_MISSING_CODES.has(err?.code)) {
      throw plannerError('Source file does not exist.', 'MISSING_SOURCE', err);
    }
    throw plannerError('Source file cannot be read.', 'SOURCE_PATH_UNSAFE', err);
  }
  const after = inspectRequiredFile(absolutePath, 'SOURCE_PATH_UNSAFE', 'Source');
  if (!sameIdentity(before, after)) {
    throw plannerError('Source file changed while it was read.', 'SOURCE_CHANGED');
  }
  return { bytes, stats: after };
}

function resolveContained(projectDir, relativePath, code, label) {
  try {
    return resolveContainedAssetPath(projectDir, relativePath, { checkFinalSymlink: false });
  } catch (err) {
    throw plannerError(`${label} path is unsafe.`, code, err);
  }
}

function hashRegularFile(absolutePath, code = 'OUTPUT_PATH_UNSAFE', label = 'Output') {
  inspectRequiredFile(absolutePath, code, label);
  try {
    return createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
  } catch (err) {
    throw plannerError(`${label} file cannot be hashed.`, code, err);
  }
}

function resolveProjectContext(projectRepository, projectId, projectsRoot) {
  const project = projectRepository.findById(projectId);
  if (!project) throw plannerError(`Project ${projectId} not found.`, 'PROJECT_NOT_FOUND');
  if (project.archived_at || project.status === 'archived') {
    throw plannerError(`Project ${projectId} is archived and cannot be modified.`, 'PROJECT_ARCHIVED');
  }
  if (!project.project_dir) throw plannerError('Project has no stored directory path.', 'PROJECT_DIRECTORY_UNSAFE');

  let projectDir;
  try {
    projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    const stats = fs.lstatSync(projectDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Project directory is unsafe.');
  } catch (err) {
    throw plannerError('Project directory cannot be accessed.', 'PROJECT_DIRECTORY_UNSAFE', err);
  }
  return { project, projectDir };
}

function resolveTrustedWatermarkPath(watermarkPath, watermarkRoot) {
  try {
    return resolveTrustedWatermarkFile(watermarkPath, watermarkRoot);
  } catch (err) {
    throw plannerError('The trusted watermark file is invalid.', 'WATERMARK_FILE_INVALID', err);
  }
}

function watermarkDestinationOwnership({
  watermarkId,
  destinationAsset,
  destinationStats,
  sourceAsset,
  sourceRelativePath,
  outputRelativePath,
  outputCategoryId,
  outputNestedPath,
  variant,
  options,
  projectDir,
  assetRepository,
  outputAbsPath,
}) {
  let destinationHash = null;
  try {
    if (destinationStats) destinationHash = hashRegularFile(outputAbsPath);
  } catch {
    return { owned: false, reasonCode: 'FOREIGN_DESTINATION' };
  }

  const owned = isOwnedWatermarkDestinationShared({
    destinationAsset,
    destinationStats,
    destinationHash,
    sourceAsset,
    sourceRelativePath,
    outputRelativePath,
    outputCategoryId,
    outputNestedPath,
    variant,
    options,
    assetRepository,
    watermarkId,
  });
  if (!owned) {
    return {
      owned: false,
      reasonCode: isValidGeneratedOutputSha256(destinationAsset?.generated_output_sha256)
        ? 'FOREIGN_DESTINATION'
        : 'MALFORMED_PROVENANCE',
    };
  }
  return {
    owned: true,
    kind: destinationStats ? 'creatorcrate-owned-overwrite' : 'missing-generated-destination',
  };
}

function outputFormatForExtension(extension) {
  return extension === 'jpg' ? 'jpeg' : extension;
}

function orientedDimensions(metadata) {
  const width = metadata?.width;
  const height = metadata?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new WatermarkEngineError('Source image dimensions are invalid.', {
      code: 'INVALID_IMAGE_DIMENSIONS',
    });
  }
  return SWAPPED_ORIENTATIONS.has(metadata.orientation)
    ? { width: height, height: width }
    : { width, height };
}

function resizedDimensions(dimensions, maxDimension) {
  if (maxDimension === null) return dimensions;
  const scale = Math.min(1, maxDimension / Math.max(dimensions.width, dimensions.height));
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

function deriveWatermarkGeometry(sourceMetadata, watermarkInput, options) {
  const oriented = orientedDimensions(sourceMetadata);
  const target = options.watermarkBeforeResize ? oriented : resizedDimensions(oriented, options.maxDimension);
  const geometry = deriveSharedWatermarkGeometry({
    sourceWidth: oriented.width,
    sourceHeight: oriented.height,
    compositeWidth: target.width,
    compositeHeight: target.height,
    watermarkWidth: watermarkInput.width,
    watermarkHeight: watermarkInput.height,
    options,
  });
  return {
    output: resizedDimensions(oriented, options.maxDimension),
    watermark: {
      width: geometry.watermarkDimensions.width,
      height: geometry.watermarkDimensions.height,
      scale: geometry.effectiveScale,
      margin: { x: geometry.margin, y: geometry.margin },
      left: geometry.effectiveCoordinates.left,
      top: geometry.effectiveCoordinates.top,
    },
    geometry,
  };
}

function addPathUse(uses, key, candidate, kind) {
  const list = uses.get(key) || [];
  list.push({ candidate, kind });
  uses.set(key, list);
}

function markIntraPlanCollisions(candidates) {
  const uses = new Map();
  for (const candidate of candidates) {
    addPathUse(uses, pathKey(candidate.sourceAbsPath), candidate, 'source');
    addPathUse(uses, pathKey(candidate.outputAbsPath), candidate, 'output');
    if (candidate.originalAbsPath) addPathUse(uses, pathKey(candidate.originalAbsPath), candidate, 'original');
  }
  for (const entries of uses.values()) {
    const distinct = new Set(entries.map(({ candidate }) => candidate));
    if (distinct.size < 2) continue;
    for (const candidate of distinct) candidate.intraPlanCollision = true;
  }
}

export function createAssetProcessingPlanner({
  scopeService,
  assetProcessingScopeService,
  projectRepository,
  projectService,
  assetRepository,
  generatedArtifactRepository,
  assetCategoryService,
  projectsRoot,
  sharpImplementation = sharp,
  watermarkPath,
  watermarkRoot,
  watermarkService,
  scaleMapService,
  watermarkScaleMap,
} = {}) {
  const resolvedScopeService = scopeService || assetProcessingScopeService;
  const resolvedProjectRepository = projectRepository || projectService?.repository;
  if (!resolvedScopeService || typeof resolvedScopeService.resolveAssetProcessingScope !== 'function') {
    throw new Error('createAssetProcessingPlanner requires an asset processing scope service.');
  }
  if (!resolvedProjectRepository || typeof resolvedProjectRepository.findById !== 'function') {
    throw new Error('createAssetProcessingPlanner requires a project repository.');
  }
  if (!assetRepository
    || typeof assetRepository.findByProjectIdAndPath !== 'function'
    || typeof assetRepository.findPublishedReleaseAssetIds !== 'function') {
    throw new Error('createAssetProcessingPlanner requires an asset repository.');
  }
  if (!assetCategoryService || typeof assetCategoryService.listProjectCategories !== 'function') {
    throw new Error('createAssetProcessingPlanner requires an asset category service.');
  }
  if (!projectsRoot) throw new Error('createAssetProcessingPlanner requires a projectsRoot dependency.');
  if (typeof sharpImplementation !== 'function') {
    throw new Error('createAssetProcessingPlanner requires a Sharp implementation.');
  }

  function resolveScope(projectId, scope) {
    const resolved = resolvedScopeService.resolveAssetProcessingScope(projectId, scope);
    const context = resolveProjectContext(resolvedProjectRepository, projectId, projectsRoot);
    return { ...resolved, ...context };
  }

  function resolveManagedScaleMap() {
    if (!scaleMapService) return { definition: watermarkScaleMap, scaleMap: null };
    if (typeof scaleMapService.resolveForProcessing !== 'function') {
      throw plannerError('Managed scale maps are unavailable.', 'SCALE_MAP_UNAVAILABLE');
    }
    try {
      return scaleMapService.resolveForProcessing();
    } catch (cause) {
      throw plannerError(cause?.message || 'Managed scale map is unavailable.', cause?.code || 'SCALE_MAP_INVALID', cause);
    }
  }

  function resolveWatermarkInput(rawOptions) {
    const input = rawOptions ?? {};
    if (input.watermarkId !== undefined) {
      const watermarkId = input.watermarkId;
      if (!isPositiveSafeInteger(watermarkId)) {
        throw plannerError('watermarkId must be a positive integer.', 'INVALID_WATERMARK_ID');
      }
      if (!watermarkService || typeof watermarkService.resolveForProcessing !== 'function') {
        throw plannerError('Global Watermark processing is unavailable.', 'WATERMARK_SERVICE_UNAVAILABLE');
      }

      try {
        const resolvedWatermark = watermarkService.resolveForProcessing(watermarkId);
        return {
          filePath: resolvedWatermark.filePath,
          watermarkId,
          metadata: resolvedWatermark.watermark,
        };
      } catch (cause) {
        throw plannerError(cause?.message || 'The global Watermark is unavailable.', cause?.code || 'WATERMARK_FILE_INVALID', cause);
      }
    }

    if (watermarkService) {
      throw plannerError('watermarkId must be a positive integer.', 'INVALID_WATERMARK_ID');
    }

    try {
      return {
        filePath: resolveTrustedWatermarkPath(watermarkPath, watermarkRoot),
        metadata: null,
      };
    } catch (err) {
      throw plannerError('The trusted Watermark file is invalid.', err?.code || 'WATERMARK_FILE_INVALID', err);
    }
  }

  function planWatermarkArchives(projectId, resolved, options, candidates, watermarkIdentity = {}) {
    const { watermarkId } = watermarkIdentity;
    if (!options.makeArchives && !options.makeCbz) return { archives: [], blockers: [] };
    if (options.archiveResizedOnlyBlocked) {
      return {
        archives: [],
        blockers: [{
          code: 'RESIZED_ONLY_ARCHIVE_BLOCKED',
          reason: 'Refusing to create archives from resized-only output unless resized archive inclusion is explicitly enabled.',
          preventsSourceDeletion: options.deleteSource,
        }],
      };
    }
    if (!generatedArtifactRepository || typeof generatedArtifactRepository.findByProjectIdAndPath !== 'function') {
      return {
        archives: [],
        blockers: [{ code: 'ARTIFACT_PERSISTENCE_UNAVAILABLE', reason: 'Generated artifact persistence is unavailable.', preventsSourceDeletion: options.deleteSource }],
      };
    }
    let plans;
    try {
      plans = deriveWatermarkArchivePlans({
        sources: candidates.map((candidate) => ({
          sourceRelativePath: candidate.item.sourceRelativePath,
          derivedOutput: candidate.derivedOutput,
        })),
        options,
        projectSlug: String(resolved.project.slug || 'project'),
      });
    } catch (err) {
      const reason = err instanceof WatermarkArchiveError ? err.message : 'Archive planning failed.';
      return { archives: [], blockers: [{ code: err.code || 'ARCHIVE_PRECHECK_FAILED', reason, preventsSourceDeletion: options.deleteSource }] };
    }
    if (plans.some((plan) => plan.entries.length === 0)) return { archives: [], blockers: [] };
    const archives = [];
    for (const plan of plans) {
      let status = 'ready';
      let reasonCode = null;
      let ownership = 'new-artifact';
      try {
        const outputPath = resolveContained(resolved.projectDir, plan.relativePath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
        const stats = inspectOptionalFile(outputPath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
        const artifact = generatedArtifactRepository.findByProjectIdAndPath(projectId, plan.relativePath) || null;
        if (!artifact && stats) {
          status = 'conflict'; reasonCode = 'ARCHIVE_DESTINATION_CONFLICT'; ownership = 'foreign';
        } else if (artifact) {
          if (artifact.kind !== plan.kind || artifact.generated_by !== 'watermark'
            || !isValidGeneratedOutputSha256(artifact.sha256)
            || (watermarkId !== undefined && artifact.generated_watermark_id !== watermarkId)) {
            status = 'conflict'; reasonCode = 'ARCHIVE_DESTINATION_CONFLICT'; ownership = 'invalid-provenance';
          } else if (!stats) {
            ownership = 'missing-owned-artifact';
          } else if (hashRegularFile(outputPath) !== artifact.sha256.toLowerCase()) {
            status = 'conflict'; reasonCode = 'ARCHIVE_DESTINATION_CONFLICT'; ownership = 'externally-replaced';
          } else if (!options.replaceExistingArchives) {
            status = 'conflict'; reasonCode = 'ARCHIVE_DESTINATION_CONFLICT'; ownership = 'replace-disabled';
          } else {
            ownership = 'creatorcrate-owned-replace';
          }
        }
      } catch (err) {
        status = 'conflict'; reasonCode = err.code || 'ARCHIVE_PATH_UNSAFE'; ownership = 'unsafe';
      }
      archives.push({
        kind: plan.kind,
        format: plan.format,
        relativePath: plan.relativePath,
        quality: plan.quality,
        entryCount: plan.entries.length,
        variants: plan.variants,
        entryNames: plan.entries.length <= 50 ? plan.entries.map((entry) => entry.name) : undefined,
        status,
        reasonCode,
        ownership,
        preventsSourceDeletion: options.deleteSource && status !== 'ready',
      });
    }
    return { archives, blockers: [] };
  }

  async function planConvert(projectId, scope, rawOptions) {
    const options = normalizeConversionOptions(rawOptions);
    const resolved = resolveScope(projectId, scope);
    const categories = assetCategoryService.listProjectCategories(projectId);
    const items = [];
    const candidates = [];

    for (const asset of resolved.assets) {
      let item = baseItem(asset);
      const sourceExtension = item.filename ? deriveExtensionFromFilename(item.filename) : '';
      if (!isSupportedConversionSource(sourceExtension)) {
        items.push(unsupportedItem(item));
        continue;
      }

      item = {
        ...item,
        eligible: true,
        operationEligibility: 'supported',
        sourceAction: {
          type: options.originalHandling,
          relativePath: item.relativePath,
          destructive: options.originalHandling !== 'keep',
        },
        destructive: options.originalHandling !== 'keep',
      };

      try {
        const derived = deriveConversionOutputPlan(item.relativePath, options);
        const sourceAbsPath = resolveContained(resolved.projectDir, derived.sourceRelativePath, 'SOURCE_PATH_UNSAFE', 'Source');
        const sourceStats = inspectRequiredFile(sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
        const outputAbsPath = resolveContained(resolved.projectDir, derived.outputRelativePath, 'OUTPUT_PATH_UNSAFE', 'Output');
        const destinationAsset = assetRepository.findByProjectIdAndPath(projectId, derived.outputRelativePath) || null;
        const destinationStats = derived.sameExtension
          ? sourceStats
          : inspectOptionalFile(outputAbsPath, 'OUTPUT_PATH_UNSAFE', 'Output');
        const outputClassification = classifyAssetPath(derived.outputRelativePath, categories);

        const candidate = {
          asset,
          item: {
            ...item,
            sourceRelativePath: derived.sourceRelativePath,
            outputRelativePath: derived.outputRelativePath,
            outputFilename: derived.outputFilename,
            outputExtension: options.format,
            plannedDestination: {
              relativePath: derived.outputRelativePath,
              filename: derived.outputFilename,
              extension: options.format,
              format: options.format,
              action: derived.sameExtension ? 'reencode-in-place' : 'create-output',
              sameExtension: derived.sameExtension,
              quality: options.quality,
              categoryId: outputClassification.categoryId,
              nestedPath: outputClassification.nestedPath,
              classification: {
                categoryId: outputClassification.categoryId,
                nestedPath: outputClassification.nestedPath,
              },
              existsInIndex: Boolean(destinationAsset),
              existsOnFilesystem: Boolean(destinationStats),
            },
            sourceAction: derived.originalRelativePath
              ? {
                type: 'move',
                relativePath: derived.sourceRelativePath,
                destinationRelativePath: derived.originalRelativePath,
                destructive: true,
              }
              : item.sourceAction.type === 'delete'
                ? { ...item.sourceAction, relativePath: derived.sourceRelativePath }
                : { ...item.sourceAction, relativePath: derived.sourceRelativePath },
          },
          sourceAbsPath,
          outputAbsPath,
          originalAbsPath: null,
          preflightConflicts: [],
          sourceKey: pathKey(sourceAbsPath),
          destinationAsset,
          destinationStats,
          derived,
          outputClassification,
          intraPlanCollision: false,
        };
        if (destinationAsset && (!derived.sameExtension || destinationAsset.id !== asset.id)) {
          candidate.preflightConflicts.push({
            code: 'DESTINATION_EXISTS',
            reason: 'The output destination is already indexed.',
          });
        }
        if (!derived.sameExtension && destinationStats) {
          candidate.preflightConflicts.push({
            code: 'DESTINATION_EXISTS',
            reason: 'The output destination already exists on the filesystem.',
          });
        }

        if (options.originalHandling === 'move') {
          const originalsDirAbsPath = resolveContained(
            resolved.projectDir,
            derived.originalsDirRelative,
            'ORIGINALS_DIRECTORY_UNSAFE',
            'Originals directory',
          );
          const originalAbsPath = resolveContained(
            resolved.projectDir,
            derived.originalRelativePath,
            'ORIGINAL_PATH_UNSAFE',
            'Original',
          );
          inspectOptionalDirectory(originalsDirAbsPath);
          const originalStats = inspectOptionalFile(originalAbsPath, 'ORIGINAL_PATH_UNSAFE', 'Original');
          const originalAsset = assetRepository.findByProjectIdAndPath(projectId, derived.originalRelativePath);
          candidate.originalAbsPath = originalAbsPath;
          candidate.originalStats = originalStats;
          candidate.item.plannedSourceAction = {
            type: 'move',
            destinationRelativePath: derived.originalRelativePath,
          };
          if (originalAsset || originalStats) {
            candidate.preflightConflicts.push({
              code: 'ORIGINAL_DESTINATION_EXISTS',
              reason: originalAsset
                ? 'The originals destination is already indexed.'
                : 'The originals destination already exists on the filesystem.',
            });
          }
        }

        candidates.push(candidate);
        items.push(candidate.item);
      } catch (err) {
        items.push(itemError(item, err, 'CONVERSION_PRECHECK_FAILED', 'The asset could not be planned for conversion.'));
      }
    }

    markIntraPlanCollisions(candidates);
    const protectedIds = options.originalHandling === 'delete'
      ? new Set(assetRepository.findPublishedReleaseAssetIds(projectId, candidates.map((candidate) => candidate.asset.id)))
      : new Set();

    for (const candidate of candidates) {
      let result = candidate.item;
      if (candidate.intraPlanCollision) {
        result = {
          ...itemConflict(result, 'INTRA_PLAN_COLLISION', 'Two or more scoped assets use the same planned path.'),
          conflicts: [
            ...candidate.preflightConflicts,
            { code: 'INTRA_PLAN_COLLISION', reason: 'Two or more scoped assets use the same planned path.' },
          ],
        };
      } else if (candidate.preflightConflicts.length > 0) {
        const first = candidate.preflightConflicts[0];
        result = { ...itemConflict(result, first.code, first.reason), conflicts: candidate.preflightConflicts };
      } else if (protectedIds.has(candidate.asset.id)) {
        result = itemBlocked(
          result,
          'PUBLISHED_RELEASE_PROTECTED',
          'The source asset is associated with a published release and cannot be deleted.',
        );
      } else {
        result = { ...result, status: 'ready', reasonCode: null, reason: null, changed: true };
      }
      const index = items.indexOf(candidate.item);
      items[index] = result;
    }

    return completePlan('convert', projectId, resolved.scope, items, options);
  }

  async function planWorkflowPromptEdit(projectId, scope, rawOptions) {
    let options;
    try {
      options = normalizeOrUsePromptEditOptions(rawOptions);
    } catch (err) {
      throw plannerError(err.message || 'Prompt editing options are invalid.', err.code || 'INVALID_PROMPT_OPTIONS', err);
    }
    const resolved = resolveScope(projectId, scope);
    const items = [];

    for (const asset of resolved.assets) {
      let item = baseItem(asset);
      if (resolved.scope.type !== 'selected'
        && options.outputDirectory
        && (item.relativePath === options.outputDirectory
          || item.relativePath.startsWith(`${options.outputDirectory}/`))) {
        items.push({ ...item, status: 'skipped', operationEligibility: 'generated-output', reasonCode: 'INSIDE_OUTPUT_DIRECTORY', reason: 'The asset is already inside the configured output directory.' });
        continue;
      }
      const sourceExtension = item.filename ? deriveExtensionFromFilename(item.filename) : '';
      if (sourceExtension !== 'png') {
        items.push(unsupportedItem(item));
        continue;
      }
      item = {
        ...item,
        eligible: true,
        operationEligibility: 'png',
        plannedDestination: {
          relativePath: item.relativePath,
          filename: item.filename,
          action: 'rewrite-in-place',
        },
        sourceAction: { type: 'keep', relativePath: item.relativePath, destructive: false },
      };

      try {
        const sourceAbsPath = resolveContained(resolved.projectDir, item.relativePath, 'SOURCE_PATH_UNSAFE', 'Source');
        const { bytes } = readStableSource(sourceAbsPath);
        const edited = editWorkflowPromptsInPng(bytes, options);
        const promptDetails = {
          metadataKey: edited.metadataKey,
          metadataSource: edited.metadataKey ? 'png-text-metadata' : null,
          beforePositive: edited.beforePositive ?? null,
          afterPositive: edited.afterPositive ?? null,
          beforeNegative: edited.beforeNegative ?? null,
          afterNegative: edited.afterNegative ?? null,
          positiveChanged: edited.positiveChanged === true,
          negativeChanged: edited.negativeChanged === true,
        };

        if (!edited.metadataKey) {
          items.push(itemBlocked({ ...item, ...promptDetails, changed: false }, 'NO_WORKFLOW_METADATA', 'No editable workflow or parameters metadata was found.'));
        } else if (!edited.changed) {
          items.push({
            ...item,
            ...promptDetails,
            status: 'unchanged',
            reasonCode: 'NO_PROMPT_CHANGES',
            reason: 'The submitted rules do not change the recognized prompt content.',
            changed: false,
          });
        } else {
          items.push({
            ...item,
            ...promptDetails,
            status: 'ready',
            reasonCode: null,
            reason: null,
            changed: true,
          });
        }
      } catch (err) {
        const isPngError = err instanceof WorkflowPromptMetadataError
          || err?.code === 'MALFORMED_PNG'
          || String(err?.code || '').includes('PNG');
        items.push(itemError(
          item,
          err,
          isPngError ? 'MALFORMED_PNG' : 'PROMPT_METADATA_READ_FAILED',
          isPngError ? 'The PNG workflow metadata is invalid.' : 'Prompt metadata could not be read.',
        ));
      }
    }

    return completePlan('workflowPromptEdit', projectId, resolved.scope, items, options);
  }

  function planArchives(projectId, scope, rawOptions) {
    let options;
    try {
      options = normalizeArchiveOptions(rawOptions);
    } catch (err) {
      throw plannerError(err.message || 'Archive options are invalid.', err.code || 'INVALID_ARCHIVE_OPTIONS', err);
    }

    const resolved = resolveScope(projectId, scope);
    const items = [];
    const sources = [];

    for (const asset of resolved.assets) {
      let item = baseItem(asset);
      const sourceExtension = item.filename ? deriveExtensionFromFilename(item.filename) : '';
      if (!ARCHIVE_SOURCE_IMAGE_EXTENSIONS.has(sourceExtension)) {
        items.push(unsupportedItem(item));
        continue;
      }

      item = {
        ...item,
        eligible: true,
        operationEligibility: 'supported',
        plannedDestination: {
          operation: 'archive',
          sourceRelativePath: item.relativePath,
          formats: ['jpg', 'webp'],
          cbz: options.makeCbz,
        },
        sourceAction: {
          type: 'keep',
          relativePath: item.relativePath,
          destructive: false,
        },
      };

      try {
        const sourceAbsPath = resolveContained(resolved.projectDir, item.relativePath, 'SOURCE_PATH_UNSAFE', 'Source');
        const sourceStats = inspectRequiredFile(sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
        sources.push({
          asset,
          sourceRelativePath: item.relativePath,
          sourceAbsPath,
          sourceIdentity: { dev: sourceStats.dev, ino: sourceStats.ino },
        });
        items.push({
          ...item,
          status: 'ready',
          reasonCode: null,
          reason: null,
          changed: options.makeArchives || options.makeCbz,
        });
      } catch (err) {
        items.push(itemError(item, err, err.code || 'SOURCE_PATH_UNSAFE', 'The asset could not be planned for archiving.'));
      }
    }

    let plans;
    const operationBlockers = [];
    try {
      plans = deriveArchivePlans({
        sources,
        options,
        projectSlug: String(resolved.project.slug || 'project'),
      });
    } catch (err) {
      const code = err instanceof ArchiveProcessingError ? err.code : err.code || 'ARCHIVE_PRECHECK_FAILED';
      operationBlockers.push({
        code,
        reason: err.message || 'Archive planning failed.',
      });
      plans = [];
    }

    if (plans.length > 0
      && (!generatedArtifactRepository || typeof generatedArtifactRepository.findByProjectIdAndPath !== 'function')) {
      operationBlockers.push({
        code: 'ARTIFACT_PERSISTENCE_UNAVAILABLE',
        reason: 'Generated artifact persistence is unavailable.',
      });
    }

    const archives = [];
    for (const plan of plans) {
      let status = 'ready';
      let reasonCode = null;
      let ownership = 'new-artifact';
      try {
        const outputPath = resolveContained(resolved.projectDir, plan.relativePath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
        const stats = inspectOptionalFile(outputPath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
        const artifact = generatedArtifactRepository?.findByProjectIdAndPath(projectId, plan.relativePath) || null;
        if (!artifact && stats) {
          status = 'conflict';
          reasonCode = 'ARCHIVE_DESTINATION_CONFLICT';
          ownership = 'foreign';
        } else if (artifact) {
          const hasWatermarkProvenance = artifact.generated_watermark_id !== null
            && artifact.generated_watermark_id !== undefined;
          if (artifact.kind !== plan.kind
            || artifact.generated_by !== ARCHIVES_GENERATED_BY
            || hasWatermarkProvenance
            || !isValidGeneratedOutputSha256(artifact.sha256)) {
            status = 'conflict';
            reasonCode = 'ARCHIVE_DESTINATION_CONFLICT';
            ownership = 'invalid-provenance';
          } else if (!stats) {
            ownership = 'missing-owned-artifact';
          } else if (hashRegularFile(outputPath) !== artifact.sha256.toLowerCase()) {
            status = 'conflict';
            reasonCode = 'ARCHIVE_DESTINATION_CONFLICT';
            ownership = 'externally-replaced';
          } else if (!options.replaceExistingArchives) {
            status = 'conflict';
            reasonCode = 'ARCHIVE_DESTINATION_CONFLICT';
            ownership = 'replace-disabled';
          } else {
            ownership = 'creatorcrate-owned-replace';
          }
        }
      } catch (err) {
        status = 'conflict';
        reasonCode = err.code || 'ARCHIVE_PATH_UNSAFE';
        ownership = 'unsafe';
      }

      const archive = {
        kind: plan.kind,
        format: plan.format,
        containerFormat: plan.containerFormat,
        relativePath: plan.relativePath,
        quality: plan.quality,
        entryCount: plan.entries.length,
        variants: plan.variants,
        entryNames: plan.entries.length <= 50 ? plan.entries.map((entry) => entry.name) : undefined,
        status,
        reasonCode,
        ownership,
      };
      archives.push(archive);
      if (status !== 'ready') {
        operationBlockers.push({
          code: reasonCode,
          reason: `The planned archive ${plan.relativePath} cannot be safely applied.`,
          relativePath: plan.relativePath,
        });
      }
    }

    return {
      ...completePlan('archive', projectId, resolved.scope, items, options),
      sourceCount: sources.length,
      entryCount: archives.reduce((total, archive) => total + archive.entryCount, 0),
      archives,
      operationBlockers,
    };
  }

  async function prepareWatermarkPlan(projectId, scope, rawOptions) {
    const resolvedScaleMap = resolveManagedScaleMap();
    let normalizedOptions;
    try {
      normalizedOptions = normalizeWatermarkOptions(rawOptions, { scaleMap: resolvedScaleMap.definition });
    } catch (err) {
      throw plannerError(err.message || 'Watermark options are invalid.', err.code || 'INVALID_OPTIONS', err);
    }

    const resolved = resolveScope(projectId, scope);
    const watermarkSelection = resolveWatermarkInput(rawOptions);
    const trustedPath = watermarkSelection.filePath;
    const watermarkId = watermarkSelection.watermarkId;
    const options = watermarkId === undefined
      ? normalizedOptions
      : { ...normalizedOptions, watermarkId };
    let watermarkInput;
    try {
      watermarkInput = await prepareWatermark(trustedPath, sharpImplementation);
    } catch (err) {
      if (err instanceof WatermarkEngineError) {
        throw plannerError(err.message, err.code, err);
      }
      throw plannerError('The trusted watermark file is invalid.', 'WATERMARK_FILE_INVALID', err);
    }

    const categories = assetCategoryService.listProjectCategories(projectId);
    resolveWatermarkOutputCategory(categories, options.outputCategorySlug);
    const items = [];
    const candidates = [];

    for (const asset of resolved.assets) {
      let item = baseItem(asset);
      const sourceExtension = item.filename ? deriveExtensionFromFilename(item.filename) : '';
      if (!WATERMARK_SOURCE_IMAGE_EXTENSIONS.has(sourceExtension)) {
        items.push(unsupportedItem(item));
        continue;
      }
      item = {
        ...item,
        eligible: true,
        operationEligibility: 'supported',
        sourceAction: {
          type: options.deleteSource ? 'delete' : 'keep',
          relativePath: item.relativePath,
          destructive: options.deleteSource,
        },
        destructive: options.deleteSource,
      };

      try {
        const derived = deriveWatermarkOutputPlan(item.relativePath, options);
        const sourceAbsPath = resolveContained(resolved.projectDir, derived.sourceRelativePath, 'SOURCE_PATH_UNSAFE', 'Source');
        const { bytes } = readStableSource(sourceAbsPath);
        const sourceMetadata = await sharpImplementation(bytes).metadata();
        const geometry = deriveWatermarkGeometry(sourceMetadata, watermarkInput, options);
        const outputAbsPath = resolveContained(resolved.projectDir, derived.outputRelativePath, 'OUTPUT_PATH_UNSAFE', 'Output');
        const outputStats = inspectOptionalFile(outputAbsPath, 'OUTPUT_PATH_UNSAFE', 'Output');
        const destinationAsset = assetRepository.findByProjectIdAndPath(projectId, derived.outputRelativePath) || null;
        const classification = classifyAssetPath(derived.outputRelativePath, categories);
        const destination = {
          relativePath: derived.outputRelativePath,
          filename: derived.outputFilename,
          extension: derived.outputExtension,
          format: outputFormatForExtension(derived.outputExtension),
          categoryId: classification.categoryId,
          nestedPath: classification.nestedPath,
          classification: {
            categoryId: classification.categoryId,
            nestedPath: classification.nestedPath,
          },
          existsInIndex: Boolean(destinationAsset),
          existsOnFilesystem: Boolean(outputStats),
          overwrite: options.overwrite,
        };
        const candidate = {
          asset,
          item: {
            ...item,
            sourceRelativePath: derived.sourceRelativePath,
            outputRelativePath: derived.outputRelativePath,
            outputFilename: derived.outputFilename,
            outputExtension: derived.outputExtension,
            outputFormat: outputFormatForExtension(derived.outputExtension),
            plannedDestination: destination,
            destination,
            geometry,
            mode: options.mode,
            maxDimension: options.maxDimension,
            deleteSource: options.deleteSource,
            overwrite: options.overwrite,
          },
          sourceAbsPath,
          outputAbsPath,
          outputStats,
          destinationAsset,
          candidateOwnership: null,
          derivedOutput: derived,
          preflightConflicts: [],
          intraPlanCollision: false,
        };
        candidate.item.variants = [...new Set(derived.outputs.map((output) => output.variant))].map((variant) => {
          const outputs = derived.outputs.filter((output) => output.variant === variant).map((output) => {
            const outputPath = resolveContained(resolved.projectDir, output.outputRelativePath, 'OUTPUT_PATH_UNSAFE', 'Output');
            const outputStatsForVariant = inspectOptionalFile(outputPath, 'OUTPUT_PATH_UNSAFE', 'Output');
            const outputAsset = assetRepository.findByProjectIdAndPath(projectId, output.outputRelativePath) || null;
            let status = 'planned';
            let reasonCode = null;
            if (outputAsset?.id === asset.id) {
              status = 'conflict'; reasonCode = 'INTRA_PLAN_COLLISION';
            } else if (outputStatsForVariant && !options.overwrite) {
              status = 'skipped-existing'; reasonCode = 'DESTINATION_EXISTS';
            } else if (!outputAsset && outputStatsForVariant) {
              status = 'conflict'; reasonCode = 'DESTINATION_EXISTS';
            } else if (outputAsset) {
              const outputClassification = classifyAssetPath(output.outputRelativePath, categories);
              const ownership = watermarkDestinationOwnership({
                destinationAsset: outputAsset, destinationStats: outputStatsForVariant, sourceAsset: asset,
                sourceRelativePath: derived.sourceRelativePath, outputRelativePath: output.outputRelativePath,
                outputCategoryId: outputClassification.categoryId, outputNestedPath: outputClassification.nestedPath,
                watermarkId, variant: output.variant, options, projectDir: resolved.projectDir, assetRepository, outputAbsPath: outputPath,
              });
              if (!ownership.owned) { status = 'conflict'; reasonCode = ownership.reasonCode; }
            }
            return {
              variant: output.variant, format: output.outputFormat, relativePath: output.outputRelativePath,
              filename: output.outputFilename, extension: output.outputExtension, maxDimension: output.maxDimension,
              status, reasonCode,
              geometry: deriveWatermarkGeometry(sourceMetadata, watermarkInput, { ...options, maxDimension: output.maxDimension }),
            };
          });
          return { variant, maxDimension: outputs[0].maxDimension, geometry: outputs[0].geometry, outputs };
        });
        candidate.item.plannedDestinations = candidate.item.variants.flatMap((variant) => variant.outputs);
        const deleteWithheldOutput = candidate.item.plannedDestinations.find((output) => output.status !== 'planned');
        if (deleteWithheldOutput && options.deleteSource) {
          candidate.item.sourceAction = {
            type: 'keep', relativePath: item.relativePath, destructive: false,
            reasonCode: deleteWithheldOutput.status === 'skipped-existing'
              ? 'SKIPPED_EXISTING_OUTPUT' : deleteWithheldOutput.reasonCode,
          };
          candidate.item.destructive = false;
        }

        if (destinationAsset && destinationAsset.id === asset.id) {
          candidate.preflightConflicts.push({
            code: 'INTRA_PLAN_COLLISION',
            reason: 'A watermark output cannot replace its selected source asset.',
          });
        } else if (!destinationAsset && outputStats) {
          candidate.preflightConflicts.push({
            code: 'DESTINATION_EXISTS',
            reason: 'The watermark output destination already exists.',
          });
        } else if (destinationAsset && outputStats && !options.overwrite) {
          candidate.preflightConflicts.push({
            code: 'DESTINATION_EXISTS',
            reason: 'The watermark output destination already exists and overwrite is disabled.',
          });
        }

        if (destinationAsset) {
          candidate.candidateOwnership = watermarkDestinationOwnership({
            destinationAsset,
            destinationStats: outputStats,
            sourceAsset: asset,
            sourceRelativePath: derived.sourceRelativePath,
            outputRelativePath: derived.outputRelativePath,
            outputCategoryId: classification.categoryId,
            outputNestedPath: classification.nestedPath,
            watermarkId,
            variant: derived.variant,
            options,
            projectDir: resolved.projectDir,
            assetRepository,
            outputAbsPath,
          });
          if (!candidate.candidateOwnership.owned) {
            candidate.preflightConflicts.push({
              code: candidate.candidateOwnership.reasonCode,
              reason: candidate.candidateOwnership.reasonCode === 'MALFORMED_PROVENANCE'
                ? 'The indexed watermark destination has malformed provenance.'
                : 'The existing watermark destination is not owned by CreatorCrate.',
            });
          }
        }

        candidates.push(candidate);
        items.push(candidate.item);
      } catch (err) {
        const fallbackCode = err instanceof WatermarkEngineError
          ? err.code || 'WATERMARK_PROCESSING_FAILED'
          : 'WATERMARK_PROCESSING_FAILED';
        items.push(itemError(item, err, fallbackCode, 'The asset could not be planned for watermarking.'));
      }
    }

    markIntraPlanCollisions(candidates);
    const protectedIds = options.deleteSource
      ? new Set(assetRepository.findPublishedReleaseAssetIds(projectId, candidates.map((candidate) => candidate.asset.id)))
      : new Set();

    for (const candidate of candidates) {
      let result = candidate.item;
      if (candidate.intraPlanCollision) {
        result = {
          ...itemConflict(result, 'INTRA_PLAN_COLLISION', 'Two or more scoped assets use the same planned path.'),
          conflicts: [
            ...candidate.preflightConflicts,
            { code: 'INTRA_PLAN_COLLISION', reason: 'Two or more scoped assets use the same planned path.' },
          ],
        };
      } else if (candidate.preflightConflicts.length > 0) {
        const first = candidate.preflightConflicts[0];
        result = { ...itemConflict(result, first.code, first.reason), conflicts: candidate.preflightConflicts };
      } else if (protectedIds.has(candidate.asset.id)) {
        result = itemBlocked(
          result,
          'PUBLISHED_RELEASE_PROTECTED',
          'The source asset is associated with a published release and cannot be deleted.',
        );
      } else {
        const ownershipKind = candidate.candidateOwnership?.kind || 'new-destination';
        result = {
          ...result,
          status: 'ready',
          reasonCode: null,
          reason: null,
          changed: true,
          destinationOwnership: ownershipKind,
        };
      }
      const index = items.indexOf(candidate.item);
      items[index] = result;
      candidate.result = result;
    }

    const archivePlan = planWatermarkArchives(projectId, resolved, options, candidates, {
      watermarkId,
    });
    const archiveBlocked = archivePlan.blockers.length > 0 || archivePlan.archives.some((archive) => archive.status !== 'ready');
    const finalItems = archiveBlocked && options.deleteSource
      ? items.map((item) => (item.destructive ? {
        ...item,
        destructive: false,
        sourceAction: {
          type: 'keep', relativePath: item.relativePath, destructive: false,
          reasonCode: archivePlan.blockers[0]?.code || 'ARCHIVE_DESTINATION_CONFLICT',
        },
      } : item))
      : items;
    return {
      ...completePlan('watermark', projectId, resolved.scope, finalItems, options),
      watermark: watermarkSelection.metadata,
      archives: archivePlan.archives,
      operationBlockers: archivePlan.blockers,
      _preview: {
        candidates,
        options,
        watermarkInput,
      },
    };
  }

  async function planWatermark(projectId, scope, rawOptions) {
    const plan = await prepareWatermarkPlan(projectId, scope, rawOptions);
    delete plan._preview;
    return plan;
  }

  async function renderWatermarkPreview(projectId, scope, rawOptions) {
    const plan = await prepareWatermarkPlan(projectId, scope, rawOptions);
    const { candidates, options, watermarkInput } = plan._preview;
    const candidate = candidates[0];
    if (!candidate) return null;

    // deriveWatermarkOutputPlan keeps its primary output first. This matches
    // Apply's deterministic variant order without exposing output paths.
    const output = candidate.derivedOutput.outputs[0];
    const rendered = await renderWatermarkedImage({
      baseInput: readStableSource(candidate.sourceAbsPath).bytes,
      watermarkInput,
      options: { ...options, maxDimension: output.maxDimension },
      outputFormat: output.outputFormat,
      sharpImplementation,
    });
    return {
      buffer: rendered.buffer,
      contentType: `image/${rendered.format === 'jpeg' ? 'jpeg' : rendered.format}`,
      filename: candidate.item.filename,
      eligibleCount: candidates.length,
      variant: output.variant,
      width: rendered.width,
      height: rendered.height,
    };
  }

  return { planConvert, planWorkflowPromptEdit, planWatermark, renderWatermarkPreview, planArchives };
}
