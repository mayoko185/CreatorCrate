import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { decode as decodeBmp, encode as encodeBmp } from '@nktkas/bmp';
import { resolveContainedAssetPath } from '../storage/asset-file.js';
import { resolveProjectDir } from '../storage/project-storage.js';
import { deriveExtensionFromFilename, mimeFromExtension } from './asset-metadata.js';
import { ProjectOperationError } from './project-operation-coordinator.js';
import { classifyAssetPath } from './asset-path-classification.js';
import {
  isOwnedWatermarkDestination as isOwnedWatermarkDestinationShared,
  resolveTrustedWatermarkFile,
} from './asset-processing-shared.js';
import {
  editWorkflowPromptsInPng,
  normalizeOrUsePromptEditOptions,
  parsePngChunks,
  WorkflowPromptMetadataError,
} from './workflow-prompt-editor.js';
import {
  WATERMARK_WINDOW_SCALE_MAP,
  WatermarkEngineError,
  normalizeWatermarkOptions,
  prepareWatermark,
  renderWatermarkedImage,
  deriveWatermarkOutputPlan,
  resolveWatermarkOutputCategory,
} from './watermark-engine.js';
import { deriveWatermarkArchivePlans, WatermarkArchiveError } from './watermark-archive.js';
import {
  ARCHIVE_SOURCE_IMAGE_EXTENSIONS,
  ARCHIVES_GENERATED_BY,
  ArchiveProcessingError,
  deriveArchivePlans,
  normalizeArchiveOptions,
  STANDALONE_ARCHIVE_KINDS,
  writeArchiveFile,
} from './archive-processing.js';

export const CONVERSION_FORMATS = Object.freeze(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);
export const ORIGINAL_HANDLINGS = Object.freeze(['keep', 'move', 'delete']);
export const CONVERSION_QUALITY_MIN = 1;
export const CONVERSION_QUALITY_MAX = 95;
export const CONVERSION_QUALITY_DEFAULT = 85;

const LOSSY_FORMATS = new Set(['webp', 'jpg', 'jpeg']);
const SOURCE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);
export const WATERMARK_SOURCE_IMAGE_EXTENSIONS = Object.freeze(new Set(['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff']));
export const WATERMARK_GENERATED_BY = 'watermark';

export class AssetProcessingError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'AssetProcessingError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/');
}

function relativeJoin(parent, basename) {
  return parent ? `${parent}/${basename}` : basename;
}

function relativeParent(relativePath) {
  const parent = path.posix.dirname(relativePath);
  return parent === '.' ? '' : parent;
}

function replaceExtension(filename, extension) {
  const dotIndex = filename.lastIndexOf('.');
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return `${stem}.${extension}`;
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function isPresent(asset) {
  return asset?.is_present === 1 || asset?.is_present === true;
}

function createProgressReporter(total, onProgress) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError('Processing progress total must be a non-negative integer.');
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('Processing progress reporter must be a function.');
  }

  let completed = 0;
  const report = () => onProgress?.({ completed, total });
  report();
  return {
    advance() {
      if (completed < total) {
        completed += 1;
        report();
      }
    },
    finish() {
      if (completed !== total) {
        completed = total;
        report();
      }
    },
  };
}

export function isSupportedConversionSource(extension) {
  return SOURCE_IMAGE_EXTENSIONS.has(extension);
}

export function normalizeConversionOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AssetProcessingError('Conversion options are required.', { code: 'INVALID_OPTIONS' });
  }

  const { format, originalHandling, quality } = options;
  if (!CONVERSION_FORMATS.includes(format)) {
    throw new AssetProcessingError(
      `Conversion format must be one of: ${CONVERSION_FORMATS.join(', ')}.`,
      { code: 'INVALID_FORMAT' },
    );
  }
  if (!ORIGINAL_HANDLINGS.includes(originalHandling)) {
    throw new AssetProcessingError(
      `Original handling must be one of: ${ORIGINAL_HANDLINGS.join(', ')}.`,
      { code: 'INVALID_ORIGINAL_HANDLING' },
    );
  }

  const normalizedQuality = quality === undefined || quality === null
    ? CONVERSION_QUALITY_DEFAULT
    : quality;
  if (!Number.isInteger(normalizedQuality)
    || normalizedQuality < CONVERSION_QUALITY_MIN
    || normalizedQuality > CONVERSION_QUALITY_MAX) {
    throw new AssetProcessingError(
      `Quality must be an integer from ${CONVERSION_QUALITY_MIN} to ${CONVERSION_QUALITY_MAX}.`,
      { code: 'INVALID_QUALITY' },
    );
  }

  return {
    format,
    originalHandling,
    quality: normalizedQuality,
  };
}

export function deriveConversionOutputPlan(sourceRelativePath, options) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const sourceFilename = path.posix.basename(normalizedSourcePath);
  const sourceParent = relativeParent(normalizedSourcePath);
  const sourceExtension = deriveExtensionFromFilename(sourceFilename);
  const sameExtension = sourceExtension === options.format;
  if (sameExtension && options.originalHandling !== 'keep') {
    throw new AssetProcessingError(
      'Same-extension conversion requires originalHandling=keep.',
      { code: 'INVALID_ORIGINAL_HANDLING' },
    );
  }

  const outputFilename = sameExtension
    ? sourceFilename
    : replaceExtension(sourceFilename, options.format);
  const outputRelativePath = sameExtension
    ? normalizedSourcePath
    : relativeJoin(sourceParent, outputFilename);

  const result = {
    sourceRelativePath: normalizedSourcePath,
    sourceFilename,
    sourceParent,
    sourceExtension,
    sameExtension,
    outputFilename,
    outputRelativePath,
  };

  if (options.originalHandling === 'move') {
    const originalsDirRelative = relativeJoin(sourceParent, 'originals');
    result.originalRelativePath = relativeJoin(originalsDirRelative, sourceFilename);
    result.originalsDirRelative = originalsDirRelative;
  }

  return result;
}

function sharpOutputFormat(format) {
  return format === 'jpg' ? 'jpeg' : format;
}

function decodeBmpForSharp(sourceBuffer, sharpImplementation) {
  const decoded = decodeBmp(new Uint8Array(sourceBuffer));
  const { width, height, channels, data } = decoded || {};
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || ![1, 3, 4].includes(channels)
    || !(data instanceof Uint8Array)) {
    throw new Error('BMP decoder returned invalid image data.');
  }

  const expectedLength = width * height * channels;
  if (!Number.isSafeInteger(expectedLength) || data.length !== expectedLength) {
    throw new Error('BMP decoder returned an invalid pixel buffer length.');
  }

  return sharpImplementation(Buffer.from(data), {
    raw: { width, height, channels },
  });
}

function encodeBmpFromSharp(rawResult) {
  const { data, info } = rawResult || {};
  const width = info?.width;
  const height = info?.height;
  const channels = info?.channels;
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || channels !== 3
    || !(data instanceof Uint8Array)) {
    throw new Error('Sharp returned invalid raw image data for BMP encoding.');
  }

  const expectedLength = width * height * channels;
  if (!Number.isSafeInteger(expectedLength) || data.length !== expectedLength) {
    throw new Error('Sharp returned an invalid raw pixel buffer length.');
  }

  return Buffer.from(encodeBmp({
    width,
    height,
    channels: 3,
    data: new Uint8Array(data),
  }, {
    bitsPerPixel: 24,
    compression: 0,
  }));
}

function normalizeWatermarkServiceOptions(options, scaleMap) {
  try {
    const normalized = normalizeWatermarkOptions(options, { scaleMap });
    if (options?.watermarkId === undefined) return normalized;
    if (!isPositiveSafeInteger(options.watermarkId)) {
      throw new AssetProcessingError('watermarkId must be a positive integer.', { code: 'INVALID_WATERMARK_ID' });
    }
    return { ...normalized, watermarkId: options.watermarkId };
  } catch (err) {
    if (err instanceof AssetProcessingError) throw err;
    if (err instanceof WatermarkEngineError) {
      throw new AssetProcessingError(err.message, { code: err.code, cause: err });
    }
    throw new AssetProcessingError('Watermark options are invalid.', {
      code: 'INVALID_OPTIONS',
      cause: err,
    });
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}


export function createAssetProcessingService({
  projectRepository,
  assetRepository,
  generatedArtifactRepository,
  assetCategoryService,
  projectsRoot,
  projectOperationCoordinator,
  sharpImplementation = sharp,
  watermarkPath,
  watermarkRoot,
  watermarkService,
  scaleMapService,
  watermarkScaleMap = WATERMARK_WINDOW_SCALE_MAP,
  alreadyCoordinatedCapability,
  processingConcurrencyService,
  applicationLogger = null,
} = {}) {
  if (!projectRepository || typeof projectRepository.findById !== 'function') {
    throw new Error('createAssetProcessingService requires a projectRepository dependency.');
  }
  if (!assetRepository
    || typeof assetRepository.findById !== 'function'
    || typeof assetRepository.findByProjectIdAndPath !== 'function'
    || typeof assetRepository.findPublishedReleaseAssetIds !== 'function'
    || typeof assetRepository.applyAssetConversions !== 'function'
    || typeof assetRepository.applyAssetPromptEdits !== 'function'
    || typeof assetRepository.applyAssetWatermarks !== 'function') {
    throw new Error('createAssetProcessingService requires an assetRepository dependency.');
  }
  if (!assetCategoryService || typeof assetCategoryService.listProjectCategories !== 'function') {
    throw new Error('createAssetProcessingService requires an assetCategoryService dependency.');
  }
  if (!projectsRoot) {
    throw new Error('createAssetProcessingService requires a projectsRoot dependency.');
  }
  if (!projectOperationCoordinator || typeof projectOperationCoordinator.runAsync !== 'function') {
    throw new Error('createAssetProcessingService requires an asynchronous projectOperationCoordinator dependency.');
  }
  if (!processingConcurrencyService || typeof processingConcurrencyService.mapBounded !== 'function') {
    throw new Error('createAssetProcessingService requires a processingConcurrencyService dependency.');
  }
  if (typeof sharpImplementation !== 'function') {
    throw new Error('createAssetProcessingService requires a Sharp implementation.');
  }
  if (watermarkPath !== undefined && typeof watermarkPath !== 'string') {
    throw new Error('createAssetProcessingService watermarkPath must be a trusted file path.');
  }
  if (watermarkRoot !== undefined && typeof watermarkRoot !== 'string') {
    throw new Error('createAssetProcessingService watermarkRoot must be a trusted directory path.');
  }

  function assertAlreadyCoordinatedCapability(capability) {
    if (capability === undefined
      || alreadyCoordinatedCapability === undefined
      || capability !== alreadyCoordinatedCapability) {
      throw new AssetProcessingError(
        'Already-coordinated processing requires the background execution capability.',
        { code: 'INVALID_PROCESSING_COORDINATION_CAPABILITY' },
      );
    }
  }

  function createAlreadyCoordinatedExecutor(capability) {
    assertAlreadyCoordinatedCapability(capability);
    return Object.freeze({
      convertAssets: (projectId, assetIds, rawOptions, onProgress) => convertAssets(
        projectId, assetIds, rawOptions, onProgress, capability,
      ),
      watermarkAssets: (projectId, assetIds, rawOptions, onProgress) => watermarkAssets(
        projectId, assetIds, rawOptions, onProgress, capability,
      ),
      createArchives: (projectId, assetIds, rawOptions, onProgress) => createArchives(
        projectId, assetIds, rawOptions, onProgress, capability,
      ),
      editWorkflowPrompts: (projectId, assetIds, rawOptions, onProgress) => editWorkflowPrompts(
        projectId, assetIds, rawOptions, onProgress, capability,
      ),
    });
  }

  async function observeRecovery({ operation, projectId, assetCount, onProgress }, execute) {
    try {
      return await execute();
    } catch (error) {
      const event = error?.code === 'DATABASE_OPERATION_FAILED'
        ? { level: 'warn', name: 'processing.recovery.succeeded', phase: 'rollback' }
        : error?.code === 'RECOVERY_REQUIRED'
          ? { level: 'error', name: 'processing.recovery.failed', phase: 'recovery' }
          : null;
      if (event) {
        try {
          applicationLogger?.[event.level]?.({
            subsystem: 'processing',
            event: event.name,
            level: event.level,
            kind: 'diagnostic',
            message: `Processing ${event.phase} ${event.level === 'warn' ? 'completed' : 'failed'}.`,
            projectId,
            ...(typeof onProgress?.jobId === 'string' ? { correlationId: onProgress.jobId } : {}),
            context: { operation, assetCount, phase: event.phase },
          });
        } catch {
          // Diagnostic persistence must not alter recovery or rollback behavior.
        }
      }
      throw error;
    }
  }

  function requireMutableProject(projectId) {
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new AssetProcessingError(`Project ${projectId} not found.`, { code: 'PROJECT_NOT_FOUND' });
    }
    if (project.archived_at || project.status === 'archived') {
      throw new AssetProcessingError(
        `Project ${projectId} is archived and cannot be modified.`,
        { code: 'PROJECT_ARCHIVED' },
      );
    }
    return project;
  }

  function resolveProjectAbsPath(project) {
    if (!project.project_dir) {
      throw new AssetProcessingError('Project has no stored directory path.', {
        code: 'PROJECT_DIRECTORY_UNSAFE',
      });
    }

    let projectDir;
    try {
      projectDir = resolveProjectDir(projectsRoot, project.project_dir);
    } catch (err) {
      throw new AssetProcessingError('Project directory cannot be accessed.', {
        code: 'PROJECT_DIRECTORY_UNSAFE',
        cause: err,
      });
    }

    let stats;
    try {
      stats = fs.lstatSync(projectDir);
    } catch (err) {
      throw new AssetProcessingError('Project directory cannot be accessed.', {
        code: 'PROJECT_DIRECTORY_UNSAFE',
        cause: err,
      });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AssetProcessingError('Project directory is unsafe.', {
        code: 'PROJECT_DIRECTORY_UNSAFE',
      });
    }
    return projectDir;
  }

  function resolveContained(projectDir, relativePath, code, label) {
    try {
      return resolveContainedAssetPath(projectDir, relativePath, { checkFinalSymlink: false });
    } catch (err) {
      throw new AssetProcessingError(`${label} path is unsafe.`, { code, cause: err });
    }
  }

  function inspectSource(sourceAbsPath) {
    let stats;
    try {
      stats = fs.lstatSync(sourceAbsPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new AssetProcessingError('Source file does not exist.', { code: 'SOURCE_MISSING' });
      }
      throw new AssetProcessingError('Source file cannot be accessed.', {
        code: 'SOURCE_PATH_UNSAFE',
        cause: err,
      });
    }
    if (stats.isSymbolicLink()) {
      throw new AssetProcessingError('Source file is a symbolic link.', { code: 'SOURCE_SYMLINK' });
    }
    if (!stats.isFile()) {
      throw new AssetProcessingError('Source path does not point to a regular file.', {
        code: 'SOURCE_NOT_REGULAR',
      });
    }
    return stats;
  }

  function readSourceBytes(item) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during conversion preflight.', {
        code: 'SOURCE_CHANGED',
      });
    }

    let descriptor;
    try {
      descriptor = fs.openSync(item.sourceAbsPath, 'r');
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || !sameIdentity(opened, item.sourceIdentity)
        || !Number.isSafeInteger(opened.size) || opened.size < 0) {
        throw new AssetProcessingError('A selected source changed during conversion.', {
          code: 'SOURCE_CHANGED',
        });
      }

      const bytes = fs.readFileSync(descriptor);
      const afterDescriptor = fs.fstatSync(descriptor);
      const afterPath = inspectSource(item.sourceAbsPath);
      if (!sameIdentity(afterDescriptor, item.sourceIdentity)
        || !sameIdentity(afterPath, item.sourceIdentity)
        || afterDescriptor.size !== opened.size
        || afterPath.size !== opened.size
        || bytes.length !== opened.size) {
        throw new AssetProcessingError('A selected source changed while it was read.', {
          code: 'SOURCE_CHANGED',
        });
      }
      return bytes;
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      throw new AssetProcessingError('Source file could not be read.', {
        code: 'SOURCE_PATH_UNSAFE',
        cause: err,
      });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function assertDestinationClear(absPath, code, label) {
    try {
      fs.lstatSync(absPath);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new AssetProcessingError(`Cannot verify the ${label} path.`, { code, cause: err });
    }
    throw new AssetProcessingError(`The ${label} path already exists.`, { code });
  }

  function inspectOriginalsDirectory(dirAbsPath) {
    try {
      const stats = fs.lstatSync(dirAbsPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AssetProcessingError('The originals directory is unsafe.', {
          code: 'ORIGINALS_DIRECTORY_UNSAFE',
        });
      }
      return { exists: true, identity: { dev: stats.dev, ino: stats.ino } };
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      if (err.code === 'ENOENT') return { exists: false, identity: null };
      throw new AssetProcessingError('The originals directory cannot be accessed.', {
        code: 'ORIGINALS_DIRECTORY_UNSAFE',
        cause: err,
      });
    }
  }

  function removeFileIfIdentityMatches(absPath, identity) {
    if (!identity) return false;
    try {
      const stats = fs.lstatSync(absPath);
      if (stats.isSymbolicLink() || !stats.isFile() || !sameIdentity(stats, identity)) return false;
      fs.unlinkSync(absPath);
      return true;
    } catch (err) {
      return err.code === 'ENOENT';
    }
  }

  function inspectGeneratedFile(absPath, code) {
    let stats;
    try {
      stats = fs.lstatSync(absPath);
    } catch (err) {
      throw new AssetProcessingError('Converted output is missing.', { code, cause: err });
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new AssetProcessingError('Converted output is not a regular file.', { code });
    }
    return stats;
  }

  function hashRegularFileInProject(projectDir, absPath) {
    const relative = path.relative(projectDir, absPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Hash target is outside the project directory.');
    }
    const validatedPath = resolveContainedAssetPath(projectDir, relative, { checkFinalSymlink: false });

    const before = fs.lstatSync(validatedPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error('Hash target is not a regular file.');
    }

    let descriptor;
    try {
      descriptor = fs.openSync(validatedPath, 'r');
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || !sameIdentity(before, opened)) {
        throw new Error('Hash target changed before it could be read.');
      }

      const digest = createHash('sha256')
        .update(fs.readFileSync(descriptor))
        .digest('hex');
      const after = fs.lstatSync(validatedPath);
      const afterDescriptor = fs.fstatSync(descriptor);
      if (after.isSymbolicLink()
        || !after.isFile()
        || !sameIdentity(after, before)
        || !sameIdentity(afterDescriptor, opened)
        || after.size !== before.size
        || afterDescriptor.size !== opened.size) {
        throw new Error('Hash target changed while it was read.');
      }
      return digest;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function verifyWatermarkHardLink({
    projectDir,
    referencePath,
    referenceIdentity,
    referenceStats,
    outputPath,
    outputSha256,
  }) {
    const outputStats = inspectGeneratedFile(outputPath, 'RECOVERY_REQUIRED');
    if (sameIdentity(outputStats, referenceIdentity)) {
      return {
        mode: 'strict',
        identity: { dev: outputStats.dev, ino: outputStats.ino },
        stats: outputStats,
      };
    }

    const expectedLinkCount = Number.isSafeInteger(referenceStats?.nlink) && referenceStats.nlink >= 1
      ? referenceStats.nlink + 1 : null;
    if (!expectedLinkCount
      || outputStats.dev !== referenceStats.dev
      || outputStats.size !== referenceStats.size
      || outputStats.nlink !== expectedLinkCount) {
      return null;
    }

    let currentReference;
    try {
      currentReference = inspectGeneratedFile(referencePath, 'RECOVERY_REQUIRED');
    } catch {
      return null;
    }
    if (!sameIdentity(currentReference, referenceIdentity)
      || currentReference.dev !== referenceStats.dev
      || currentReference.size !== referenceStats.size
      || currentReference.nlink !== expectedLinkCount) {
      return null;
    }

    try {
      if (hashRegularFileInProject(projectDir, outputPath) !== outputSha256) return null;
    } catch {
      return null;
    }

    return {
      mode: 'verified-hard-link',
      identity: { dev: outputStats.dev, ino: outputStats.ino },
      stats: outputStats,
    };
  }

  function watermarkOutputMatchesPublication(item, currentStats, projectDir) {
    if (item.outputVerification?.mode !== 'verified-hard-link') {
      return Boolean(item.outputIdentity && sameIdentity(currentStats, item.outputIdentity));
    }
    if (!item.stageOutput || !item.stageOutputStats) return false;
    try {
      const verification = verifyWatermarkHardLink({
        projectDir,
        referencePath: item.stageOutput,
        referenceIdentity: item.stageOutputIdentity,
        referenceStats: item.stageOutputStats,
        outputPath: item.outputAbsPath,
        outputSha256: item.outputSha256,
      });
      return Boolean(verification);
    } catch {
      return false;
    }
  }

  function resolveTrustedWatermarkPath(watermarkId) {
    if (watermarkService) {
      try {
        if (!isPositiveSafeInteger(watermarkId)) {
          throw new AssetProcessingError('watermarkId must be a positive integer.', { code: 'INVALID_WATERMARK_ID' });
        }
        return watermarkService.resolveForProcessing(watermarkId).filePath;
      } catch (err) {
        if (err instanceof AssetProcessingError) throw err;
        throw new AssetProcessingError('The managed Watermark is unavailable.', {
          code: err?.code || 'WATERMARK_FILE_INVALID',
          cause: err,
        });
      }
    }
    try {
      return resolveTrustedWatermarkFile(watermarkPath, watermarkRoot);
    } catch (err) {
      throw new AssetProcessingError('The trusted watermark file is invalid.', {
        code: 'WATERMARK_FILE_INVALID',
        cause: err,
      });
    }
  }

  function resolveWatermarkInput(rawOptions) {
    const input = rawOptions ?? {};
    if (input.watermarkId !== undefined) {
      const watermarkId = input.watermarkId;
      if (!isPositiveSafeInteger(watermarkId)) {
        throw new AssetProcessingError('watermarkId must be a positive integer.', {
          code: 'INVALID_WATERMARK_ID',
        });
      }
      if (!watermarkService || typeof watermarkService.resolveForProcessing !== 'function') {
        throw new AssetProcessingError('Global Watermark processing is unavailable.', {
          code: 'WATERMARK_SERVICE_UNAVAILABLE',
        });
      }

      try {
        const resolvedWatermark = watermarkService.resolveForProcessing(watermarkId);
        return {
          filePath: resolvedWatermark.filePath,
          watermarkId,
        };
      } catch (cause) {
        throw new AssetProcessingError(
          cause?.message || 'The global Watermark is unavailable.',
          { code: cause?.code || 'WATERMARK_FILE_INVALID', cause },
        );
      }
    }

    if (watermarkService) {
      throw new AssetProcessingError('watermarkId must be a positive integer.', {
        code: 'INVALID_WATERMARK_ID',
      });
    }

    return {
      filePath: resolveTrustedWatermarkPath(undefined),
    };
  }

  function resolveManagedScaleMap() {
    if (!scaleMapService) return { definition: watermarkScaleMap, scaleMap: null };
    if (typeof scaleMapService.resolveForProcessing !== 'function') {
      throw new AssetProcessingError('Managed scale maps are unavailable.', { code: 'SCALE_MAP_UNAVAILABLE' });
    }
    try {
      return scaleMapService.resolveForProcessing();
    } catch (cause) {
      throw new AssetProcessingError(cause?.message || 'Managed scale map is unavailable.', {
        code: cause?.code || 'SCALE_MAP_INVALID',
        cause,
      });
    }
  }

  function inspectOptionalDestination(absPath) {
    try {
      const stats = fs.lstatSync(absPath);
      if (stats.isSymbolicLink()) {
        throw new AssetProcessingError('The watermark output destination is a symbolic link.', {
          code: 'OUTPUT_PATH_UNSAFE',
        });
      }
      if (!stats.isFile()) {
        throw new AssetProcessingError('The watermark output destination is not a regular file.', {
          code: 'OUTPUT_PATH_UNSAFE',
        });
      }
      return stats;
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      if (err.code === 'ENOENT') return null;
      throw new AssetProcessingError('The watermark output destination cannot be accessed.', {
        code: 'OUTPUT_PATH_UNSAFE',
        cause: err,
      });
    }
  }

  function cleanupCreatedOutputDirs(createdDirs) {
    let clean = true;
    for (const item of [...createdDirs].reverse()) {
      try {
        const stats = fs.lstatSync(item.path);
        if (stats.isSymbolicLink() || !sameIdentity(stats, item.identity)) {
          clean = false;
          continue;
        }
        fs.rmdirSync(item.path);
      } catch (err) {
        if (err.code !== 'ENOENT') clean = false;
      }
    }
    return clean;
  }

  function createWatermarkStaging(projectDir) {
    let directory;
    try {
      directory = fs.mkdtempSync(path.join(projectDir, '.creatorcrate-watermark-'));
      const stats = fs.lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Invalid watermark staging directory.');
    } catch (err) {
      if (directory) {
        try { fs.rmdirSync(directory); } catch { /* best effort */ }
      }
      throw new AssetProcessingError('CreatorCrate could not prepare watermark staging.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
    return { directory, items: [], artifacts: [], createdOutputDirs: [] };
  }

  function preflightArchivePlans(project, projectId, projectDir, sources, options, provenance = {}) {
    if (!options.makeArchives && !options.makeCbz) return [];
    if (options.archiveResizedOnlyBlocked) {
      throw new AssetProcessingError(
        'Refusing to create archives from resized-only output unless resized archive inclusion is explicitly enabled.',
        { code: 'RESIZED_ONLY_ARCHIVE_BLOCKED' },
      );
    }
    if (!generatedArtifactRepository || typeof generatedArtifactRepository.findByProjectIdAndPath !== 'function') {
      throw new AssetProcessingError('Generated artifact persistence is unavailable.', { code: 'ARTIFACT_PERSISTENCE_UNAVAILABLE' });
    }

    const derivePlans = provenance.derivePlans || deriveWatermarkArchivePlans;
    const generatedBy = provenance.generatedBy || WATERMARK_GENERATED_BY;
    const expectedWatermarkId = provenance.watermarkId;
    const requireNullWatermarkId = provenance.requireNullWatermarkId === true;
    const archiveLabel = provenance.archiveLabel || 'archive';
    let plans;
    try {
      plans = derivePlans({
        sources,
        options,
        projectSlug: String(project.slug || 'project'),
      });
    } catch (err) {
      if (err instanceof WatermarkArchiveError || err instanceof ArchiveProcessingError) {
        throw new AssetProcessingError(err.message, { code: err.code, cause: err });
      }
      throw err;
    }
    if (plans.some((plan) => plan.entries.length === 0)) return [];

    for (const plan of plans) {
      plan.outputAbsPath = resolveContained(projectDir, plan.relativePath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
      plan.outputDirectoryAbsPath = path.dirname(plan.outputAbsPath);
      plan.artifact = generatedArtifactRepository.findByProjectIdAndPath(projectId, plan.relativePath) || null;
      plan.destinationStats = inspectOptionalDestination(plan.outputAbsPath);
      plan.destinationIdentity = plan.destinationStats
        ? { dev: plan.destinationStats.dev, ino: plan.destinationStats.ino }
        : null;
      if (!plan.artifact && plan.destinationStats) {
        throw new AssetProcessingError(`The ${archiveLabel} destination already exists and is not owned by CreatorCrate.`, {
          code: 'ARCHIVE_DESTINATION_CONFLICT',
        });
      }
      if (!plan.artifact) {
        plan.ownership = 'new-artifact';
        continue;
      }
      if (plan.artifact.kind !== plan.kind || plan.artifact.generated_by !== generatedBy
        || !isSha256(plan.artifact.sha256)
        || (requireNullWatermarkId && plan.artifact.generated_watermark_id !== null)
        || (expectedWatermarkId !== undefined && plan.artifact.generated_watermark_id !== expectedWatermarkId)) {
        throw new AssetProcessingError(`The indexed ${archiveLabel} has invalid ownership provenance.`, {
          code: 'ARCHIVE_DESTINATION_CONFLICT',
        });
      }
      if (!plan.destinationStats) {
        plan.ownership = 'missing-owned-artifact';
        continue;
      }
      let currentHash;
      try {
        currentHash = hashRegularFileInProject(projectDir, plan.outputAbsPath);
      } catch (err) {
        throw new AssetProcessingError(`The existing ${archiveLabel} could not be verified.`, {
          code: 'ARCHIVE_DESTINATION_CONFLICT', cause: err,
        });
      }
      if (currentHash !== plan.artifact.sha256.toLowerCase()) {
        throw new AssetProcessingError(`The existing ${archiveLabel} is no longer owned by CreatorCrate.`, {
          code: 'ARCHIVE_DESTINATION_CONFLICT',
        });
      }
      if (!options.replaceExistingArchives) {
        throw new AssetProcessingError(`The ${archiveLabel} destination already exists and replacement is disabled.`, {
          code: 'ARCHIVE_DESTINATION_CONFLICT',
        });
      }
      plan.ownership = 'creatorcrate-owned-replace';
    }
    return plans;
  }

  async function stageArchiveArtifactWithRenderer(
    plan,
    staging,
    index,
    projectDir,
    renderEntry,
    failureMessage = 'CreatorCrate could not build an archive.',
  ) {
    const stageOutput = path.join(staging.directory, `archive-${index}.${plan.format}`);
    plan.stageOutput = stageOutput;
    plan.stageIndex = index;
    plan.stagingDirectory = staging.directory;
    try {
      const entries = await processingConcurrencyService.mapBounded(plan.entries, async (entry) => {
        const rendered = await renderEntry(entry, plan);
        const buffer = Buffer.isBuffer(rendered) ? rendered : rendered?.buffer;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          throw new Error('Archive renderer returned invalid bytes.');
        }
        return { name: entry.name, buffer };
      });
      await writeArchiveFile(stageOutput, plan.format, entries);
      const stats = inspectGeneratedFile(stageOutput, 'ARCHIVE_OUTPUT_INVALID');
      if (stats.size <= 0) throw new Error('Generated archive is empty.');
      plan.stageOutputIdentity = { dev: stats.dev, ino: stats.ino };
      plan.outputStats = stats;
      plan.sha256 = hashRegularFileInProject(projectDir, stageOutput);
    } catch (err) {
      if (!plan.stageOutputIdentity) {
        try {
          const stats = fs.lstatSync(stageOutput);
          if (stats.isFile() && !stats.isSymbolicLink()) plan.stageOutputIdentity = { dev: stats.dev, ino: stats.ino };
        } catch { /* recovery remains identity-safe */ }
      }
      throw new AssetProcessingError(failureMessage, {
        code: 'ARCHIVE_BUILD_FAILED', cause: err,
      });
    }
  }

  async function stageArchiveArtifact(plan, staging, index, watermarkInput, options, projectDir) {
    return stageArchiveArtifactWithRenderer(
      plan,
      staging,
      index,
      projectDir,
      async (entry) => {
        const sourceBuffer = readSourceBytes(entry.source);
        const rendered = await renderWatermarkedImage({
          baseInput: sourceBuffer,
          watermarkInput,
          options: {
            ...options,
            maxDimension: entry.maxDimension,
            quality: plan.quality,
            // Archive WebP is deliberately lossy, independent of disk output.
            webpLossless: false,
          },
          outputFormat: plan.kind === 'watermark-archive-webp' ? 'webp' : 'jpeg',
          sharpImplementation,
        });
        return rendered.buffer;
      },
      'CreatorCrate could not build a watermark archive.',
    );
  }

  function publishArchiveArtifact(plan, projectDir) {
    const current = inspectOptionalDestination(plan.outputAbsPath);
    if (plan.destinationStats && (!current || !sameIdentity(current, plan.destinationIdentity))) {
      throw new AssetProcessingError('The archive destination changed during processing.', { code: 'ARCHIVE_DESTINATION_CONFLICT' });
    }
    if (!plan.destinationStats && current) {
      throw new AssetProcessingError('An archive destination appeared during processing.', { code: 'ARCHIVE_DESTINATION_CONFLICT' });
    }
    if (current) {
      const currentHash = hashRegularFileInProject(projectDir, plan.outputAbsPath);
      if (!plan.artifact || currentHash !== plan.artifact.sha256.toLowerCase()) {
        throw new AssetProcessingError('The archive destination is no longer owned by CreatorCrate.', { code: 'ARCHIVE_DESTINATION_CONFLICT' });
      }
      plan.destinationBackupPath = path.join(plan.stagingDirectory, `archive-${plan.stageIndex}.destination`);
      fs.linkSync(plan.outputAbsPath, plan.destinationBackupPath);
      const backup = inspectGeneratedFile(plan.destinationBackupPath, 'RECOVERY_REQUIRED');
      if (!sameIdentity(backup, plan.destinationIdentity)) throw new Error('Archive destination backup identity mismatch.');
      plan.destinationBackupIdentity = { dev: backup.dev, ino: backup.ino };
      fs.unlinkSync(plan.outputAbsPath);
      plan.destinationRemoved = true;
    }
    try {
      fs.linkSync(plan.stageOutput, plan.outputAbsPath);
    } catch (err) {
      if (err.code === 'EEXIST') throw new AssetProcessingError('An archive destination appeared during processing.', { code: 'ARCHIVE_DESTINATION_CONFLICT', cause: err });
      throw new AssetProcessingError('CreatorCrate could not publish a watermark archive.', { code: 'FILESYSTEM_OPERATION_FAILED', cause: err });
    }
    const published = inspectGeneratedFile(plan.outputAbsPath, 'RECOVERY_REQUIRED');
    if (!sameIdentity(published, plan.stageOutputIdentity)
      || hashRegularFileInProject(projectDir, plan.outputAbsPath) !== plan.sha256) {
      throw new AssetProcessingError('Archive publication could not be verified.', { code: 'RECOVERY_REQUIRED' });
    }
    plan.outputIdentity = { dev: published.dev, ino: published.ino };
    plan.outputCommitted = true;
    fs.unlinkSync(plan.stageOutput);
    plan.stageOutput = null;
  }

  function restoreArchiveArtifacts(plans) {
    let restored = true;
    for (const plan of [...plans].reverse()) {
      if (!plan.outputCommitted && !plan.destinationRemoved) continue;
      try {
        const current = inspectOptionalDestination(plan.outputAbsPath);
        if (current) {
          if (!sameIdentity(current, plan.outputIdentity)) { restored = false; continue; }
          fs.unlinkSync(plan.outputAbsPath);
        }
        if (plan.destinationBackupPath) {
          const backup = inspectGeneratedFile(plan.destinationBackupPath, 'RECOVERY_REQUIRED');
          if (!sameIdentity(backup, plan.destinationBackupIdentity)) { restored = false; continue; }
          fs.linkSync(plan.destinationBackupPath, plan.outputAbsPath);
          const recovered = inspectGeneratedFile(plan.outputAbsPath, 'RECOVERY_REQUIRED');
          if (!sameIdentity(recovered, plan.destinationIdentity)) { restored = false; continue; }
          fs.unlinkSync(plan.destinationBackupPath);
          plan.destinationBackupPath = null;
        }
        plan.outputCommitted = false;
      } catch { restored = false; }
    }
    return restored;
  }

  function cleanupArchiveStaging(plans) {
    const removeStagingPath = (stagingPath, identity) => {
      if (!stagingPath) return true;
      if (identity) return removeFileIfIdentityMatches(stagingPath, identity);
      try {
        fs.lstatSync(stagingPath);
        return false;
      } catch (err) {
        return err.code === 'ENOENT';
      }
    };

    let clean = true;
    for (const plan of plans) {
      if (!removeStagingPath(plan.stageOutput, plan.stageOutputIdentity)) clean = false;
      if (!removeStagingPath(plan.destinationBackupPath, plan.destinationBackupIdentity)) clean = false;
    }
    return clean;
  }

  function ensureWatermarkOutputDirectories(items, staging) {
    const byPath = new Map();
    for (const item of items) {
      const key = pathKey(item.outputDirectoryAbsPath);
      if (byPath.has(key)) continue;
      try {
        let existed = true;
        try { fs.lstatSync(item.outputDirectoryAbsPath); } catch (err) {
          if (err.code === 'ENOENT') existed = false;
          else throw err;
        }
        fs.mkdirSync(item.outputDirectoryAbsPath, { recursive: true });
        const stats = fs.lstatSync(item.outputDirectoryAbsPath);
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Invalid watermark output directory.');
        const created = {
          path: item.outputDirectoryAbsPath,
          identity: { dev: stats.dev, ino: stats.ino },
        };
        if (!existed) staging.createdOutputDirs.push(created);
        byPath.set(key, created);
      } catch (err) {
        if (err.code === 'EEXIST') {
          let stats;
          try { stats = fs.lstatSync(item.outputDirectoryAbsPath); } catch (statErr) { throw statErr; }
          if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new AssetProcessingError('The watermark output directory is unsafe.', {
              code: 'OUTPUT_PATH_UNSAFE',
            });
          }
          byPath.set(key, { path: item.outputDirectoryAbsPath, identity: null });
          continue;
        }
        throw new AssetProcessingError('CreatorCrate could not prepare the watermark output directory.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
    }
  }

  function cleanupWatermarkStaging(staging) {
    let clean = true;
    const cleanupStagedFile = (filePath, identity) => {
      if (identity) return removeFileIfIdentityMatches(filePath, identity);
      try {
        fs.lstatSync(filePath);
        return false;
      } catch (err) {
        return err.code === 'ENOENT';
      }
    };
    for (const item of staging.items) {
      if (item.stageOutput && !cleanupStagedFile(item.stageOutput, item.stageOutputIdentity)) {
        clean = false;
      }
      if (item.stagedDeletePath
        && !removeFileIfIdentityMatches(item.stagedDeletePath, item.stagedDeleteIdentity)) {
        clean = false;
      }
      if (item.destinationBackupPath
        && item.destinationRestoreAttempted
        && item.destinationRemoved) {
        clean = false;
      } else if (item.destinationBackupPath
        && !removeFileIfIdentityMatches(item.destinationBackupPath, item.destinationBackupIdentity)) {
        clean = false;
      }
    }
    try {
      fs.rmdirSync(staging.directory);
    } catch (err) {
      if (err.code !== 'ENOENT') clean = false;
    }
    return clean;
  }

  function wrapWatermarkEngineError(err) {
    if (err instanceof AssetProcessingError) return err;
    if (err instanceof WatermarkEngineError) {
      return new AssetProcessingError(err.message, { code: err.code, cause: err });
    }
    return new AssetProcessingError('Sharp could not watermark a selected image.', {
      code: 'WATERMARK_PROCESSING_FAILED',
      cause: err,
    });
  }

  async function stageWatermarkOutput(item, staging, index, watermarkInput, options, projectDir) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during watermark preflight.', {
        code: 'SOURCE_CHANGED',
      });
    }

    const stageOutputPath = path.join(staging.directory, `${index}.output`);
    item.stageOutput = stageOutputPath;
    item.stagingDirectory = staging.directory;
    item.stageIndex = index;
    try {
      const sourceBuffer = fs.readFileSync(item.sourceAbsPath);
      const rendered = await renderWatermarkedImage({
        baseInput: sourceBuffer,
        watermarkInput,
        options: { ...options, maxDimension: item.variantMaxDimension },
        outputFormat: item.outputFormat,
        sharpImplementation,
      });
      const afterRenderStats = inspectSource(item.sourceAbsPath);
      if (!sameIdentity(afterRenderStats, item.sourceIdentity)) {
        throw new AssetProcessingError('A selected source changed during watermark processing.', {
          code: 'SOURCE_CHANGED',
        });
      }
      fs.writeFileSync(stageOutputPath, rendered.buffer, {
        flag: 'wx',
        mode: currentStats.mode & 0o7777,
      });
      fs.chmodSync(stageOutputPath, currentStats.mode & 0o7777);
      const stageStats = inspectGeneratedFile(stageOutputPath, 'WATERMARK_OUTPUT_INVALID');
      item.stageOutputIdentity = { dev: stageStats.dev, ino: stageStats.ino };
      item.stageOutputStats = {
        dev: stageStats.dev,
        ino: stageStats.ino,
        size: stageStats.size,
        nlink: stageStats.nlink,
      };
      item.outputStats = stageStats;
      item.outputSha256 = hashRegularFileInProject(projectDir, stageOutputPath);
      const metadata = await sharpImplementation(rendered.buffer).metadata();
      if (metadata.format !== sharpOutputFormat(item.outputFormat)
        || metadata.width !== rendered.width
        || metadata.height !== rendered.height) {
        throw new Error('Sharp produced unexpected watermark output metadata.');
      }
    } catch (err) {
      if (!item.stageOutputIdentity) {
        try {
          const stats = fs.lstatSync(stageOutputPath);
          if (stats.isFile() && !stats.isSymbolicLink()) {
            item.stageOutputIdentity = { dev: stats.dev, ino: stats.ino };
          }
        } catch { /* best effort; recovery will fail closed */ }
      }
      throw wrapWatermarkEngineError(err);
    }
  }

  function publishWatermarkOutput(item, projectDir) {
    if (item.destinationAsset) {
      const currentStats = inspectOptionalDestination(item.outputAbsPath);
      if (item.destinationStats && (!currentStats || !sameIdentity(currentStats, item.destinationIdentity))) {
        throw new AssetProcessingError('The watermark output destination changed during processing.', {
          code: 'OUTPUT_DESTINATION_CONFLICT',
        });
      }
      if (!item.destinationStats && currentStats) {
        throw new AssetProcessingError('A watermark output destination appeared during processing.', {
          code: 'OUTPUT_DESTINATION_CONFLICT',
        });
      }

      if (currentStats) {
        let currentHash;
        try {
          currentHash = hashRegularFileInProject(projectDir, item.outputAbsPath);
        } catch (err) {
          throw new AssetProcessingError('The existing watermark destination could not be verified.', {
            code: 'OUTPUT_DESTINATION_CONFLICT',
            cause: err,
          });
        }
        if (currentHash !== item.destinationAsset.generated_output_sha256.toLowerCase()) {
          throw new AssetProcessingError('The existing watermark destination is no longer owned by CreatorCrate.', {
            code: 'OUTPUT_DESTINATION_CONFLICT',
          });
        }

        item.destinationBackupPath = path.join(item.stagingDirectory, `${item.stageIndex}.destination`);
        try {
          fs.linkSync(item.outputAbsPath, item.destinationBackupPath);
          const backupVerification = verifyWatermarkHardLink({
            projectDir,
            referencePath: item.outputAbsPath,
            referenceIdentity: item.destinationIdentity,
            referenceStats: currentStats,
            outputPath: item.destinationBackupPath,
            outputSha256: item.destinationAsset.generated_output_sha256.toLowerCase(),
          });
          if (!backupVerification) throw new Error('Watermark destination backup identity mismatch.');
          item.destinationBackupIdentity = backupVerification.identity;
          const beforeDelete = inspectOptionalDestination(item.outputAbsPath);
          if (!beforeDelete || !sameIdentity(beforeDelete, item.destinationIdentity)) {
            throw new AssetProcessingError('The watermark output destination changed during processing.', {
              code: 'OUTPUT_DESTINATION_CONFLICT',
            });
          }
          fs.unlinkSync(item.outputAbsPath);
          item.destinationRemoved = true;
        } catch (err) {
          throw wrapWatermarkEngineError(err);
        }
      }
    }

    try {
      fs.linkSync(item.stageOutput, item.outputAbsPath);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new AssetProcessingError('A watermark output destination appeared during processing.', {
          code: 'OUTPUT_DESTINATION_CONFLICT',
          cause: err,
        });
      }
      throw new AssetProcessingError('CreatorCrate could not publish a watermark output.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    item.outputPublication = 'linked';
    item.outputIdentity = { ...item.stageOutputIdentity };

    const outputVerification = verifyWatermarkHardLink({
      projectDir,
      referencePath: item.stageOutput,
      referenceIdentity: item.stageOutputIdentity,
      referenceStats: item.stageOutputStats,
      outputPath: item.outputAbsPath,
      outputSha256: item.outputSha256,
    });
    if (!outputVerification) {
      throw new AssetProcessingError('Watermark output identity could not be verified.', {
        code: 'RECOVERY_REQUIRED',
      });
    }
    item.outputVerification = outputVerification;
    item.outputIdentity = outputVerification.identity;
    item.outputStats = outputVerification.stats;
    let publishedHash;
    try {
      publishedHash = hashRegularFileInProject(projectDir, item.outputAbsPath);
    } catch (err) {
      throw new AssetProcessingError('Watermark output content could not be verified.', {
        code: 'RECOVERY_REQUIRED',
        cause: err,
      });
    }
    if (publishedHash !== item.outputSha256) {
      throw new AssetProcessingError('Watermark output content changed during publication.', {
        code: 'RECOVERY_REQUIRED',
      });
    }

    if (outputVerification.mode === 'strict') {
      try {
        fs.unlinkSync(item.stageOutput);
        item.stageOutput = null;
      } catch (err) {
        throw new AssetProcessingError('Watermark output staging cleanup failed.', {
          code: 'RECOVERY_REQUIRED',
          cause: err,
        });
      }
    }
    item.outputPublication = 'committed';
  }

  function restoreWatermarkOutputs(items, projectDir) {
    let restored = true;
    for (const item of [...items].reverse()) {
      if (item.destinationBackupPath) item.destinationRestoreAttempted = true;
      if (item.outputPublication === 'unlinked' && !item.destinationRemoved) continue;

      let current = null;
      try {
        current = fs.lstatSync(item.outputAbsPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          restored = false;
          continue;
        }
      }

      if (current) {
        if (current.isSymbolicLink() || !current.isFile()
          || !watermarkOutputMatchesPublication(item, current, projectDir)) {
          restored = false;
          continue;
        }
        try {
          fs.unlinkSync(item.outputAbsPath);
        } catch {
          restored = false;
          continue;
        }
      }

      if (item.destinationBackupPath) {
        try {
          const backupStats = inspectGeneratedFile(item.destinationBackupPath, 'RECOVERY_REQUIRED');
          if (!sameIdentity(backupStats, item.destinationBackupIdentity)) {
            restored = false;
            continue;
          }
          fs.linkSync(item.destinationBackupPath, item.outputAbsPath);
          const restoredVerification = verifyWatermarkHardLink({
            projectDir,
            referencePath: item.destinationBackupPath,
            referenceIdentity: item.destinationBackupIdentity,
            referenceStats: backupStats,
            outputPath: item.outputAbsPath,
            outputSha256: item.destinationAsset.generated_output_sha256.toLowerCase(),
          });
          if (!restoredVerification) {
            restored = false;
            continue;
          }
          fs.unlinkSync(item.destinationBackupPath);
          item.destinationBackupPath = null;
          item.destinationRemoved = false;
        } catch {
          restored = false;
          continue;
        }
      }
      item.outputPublication = 'unlinked';
    }
    return restored;
  }

  function recoverWatermarkAfterFailure(staging, items, projectDir) {
    const artifactsRestored = restoreArchiveArtifacts(staging.artifacts || []);
    const outputsRestored = restoreWatermarkOutputs(items, projectDir);
    const deletesRestored = restoreStagedDeletes(items, projectDir);
    const artifactsClean = cleanupArchiveStaging(staging.artifacts || []);
    const stagingClean = cleanupWatermarkStaging(staging);
    const dirsClean = cleanupCreatedOutputDirs(staging.createdOutputDirs);
    return artifactsRestored && outputsRestored && deletesRestored && artifactsClean && stagingClean && dirsClean;
  }

  function cleanupCreatedOriginalDirs(createdDirs) {
    let clean = true;
    for (const item of [...createdDirs].reverse()) {
      try {
        const stats = fs.lstatSync(item.path);
        if (stats.isSymbolicLink() || !sameIdentity(stats, item.identity)) {
          clean = false;
          continue;
        }
        fs.rmdirSync(item.path);
      } catch (err) {
        if (err.code !== 'ENOENT') clean = false;
      }
    }
    return clean;
  }

  function cleanupStaging(staging) {
    let clean = true;
    const cleanupStagedFile = (filePath, identity) => {
      if (identity) return removeFileIfIdentityMatches(filePath, identity);
      try {
        fs.lstatSync(filePath);
        return false;
      } catch (err) {
        return err.code === 'ENOENT';
      }
    };

    for (const item of staging.items) {
      if (item.stageOutput && !cleanupStagedFile(item.stageOutput, item.stageOutputIdentity)) {
        clean = false;
      }
      if (item.stagedDeletePath
        && !removeFileIfIdentityMatches(item.stagedDeletePath, item.stagedDeleteIdentity)) {
        clean = false;
      }
      if (item.destinationBackupPath
        && !removeFileIfIdentityMatches(item.destinationBackupPath, item.destinationBackupIdentity)) {
        clean = false;
      }
    }

    try {
      fs.rmdirSync(staging.directory);
    } catch (err) {
      if (err.code !== 'ENOENT') clean = false;
    }
    return clean;
  }

  function restoreStagedDeletes(items, projectDir) {
    let restored = true;
    for (const item of [...items].reverse()) {
      if (!item.stagedDeletePath) continue;

      try {
        const stagedStats = fs.lstatSync(item.stagedDeletePath);
        if (stagedStats.isSymbolicLink()
          || !stagedStats.isFile()
          || !sameIdentity(stagedStats, item.stagedDeleteIdentity)) {
          restored = false;
          continue;
        }

        try {
          fs.lstatSync(item.sourceAbsPath);
          restored = false;
          continue;
        } catch (err) {
          if (err.code !== 'ENOENT') {
            restored = false;
            continue;
          }
        }

        fs.linkSync(item.stagedDeletePath, item.sourceAbsPath);
        const restoredStats = inspectSource(item.sourceAbsPath);
        const restoredVerification = item.stagedDeleteSha256
          ? verifyWatermarkHardLink({
            projectDir,
            referencePath: item.stagedDeletePath,
            referenceIdentity: item.stagedDeleteIdentity,
            referenceStats: stagedStats,
            outputPath: item.sourceAbsPath,
            outputSha256: item.stagedDeleteSha256,
          })
          : (sameIdentity(restoredStats, item.stagedDeleteIdentity) ? { mode: 'strict' } : null);
        if (!restoredVerification) {
          restored = false;
          continue;
        }
        fs.unlinkSync(item.stagedDeletePath);
        item.stagedDeletePath = null;
      } catch {
        restored = false;
      }
    }
    return restored;
  }

  function cleanupCommittedOutputs(items) {
    let clean = true;
    for (const item of [...items].reverse()) {
      if (!item.outputCommitted) continue;
      if (!removeFileIfIdentityMatches(item.outputAbsPath, item.outputIdentity)) clean = false;
      item.outputCommitted = false;
    }
    return clean;
  }

  function createStaging(projectDir) {
    let directory;
    try {
      directory = fs.mkdtempSync(path.join(projectDir, '.creatorcrate-convert-'));
      const stats = fs.lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Invalid staging directory.');
    } catch (err) {
      throw new AssetProcessingError('CreatorCrate could not prepare conversion staging.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
    return { directory, items: [] };
  }

  async function stageOutput(item, staging, options, index) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during conversion preflight.', {
        code: 'SOURCE_CHANGED',
      });
    }

    const stageOutputPath = path.join(staging.directory, `${index}.output`);
    item.stageOutput = stageOutputPath;
    item.stagingDirectory = staging.directory;
    item.stageIndex = index;
    try {
      const sourceBuffer = readSourceBytes(item);
      const pipeline = item.sourceExtension === 'bmp'
        ? decodeBmpForSharp(sourceBuffer, sharpImplementation)
        : item.sourceExtension === 'gif'
          ? sharpImplementation(sourceBuffer, { page: 0 })
          : sharpImplementation(sourceBuffer);
      let outputBuffer;
      if (options.format === 'bmp') {
        const rawResult = await pipeline
          .toColourspace('srgb')
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        outputBuffer = encodeBmpFromSharp(rawResult);
      } else {
        const output = options.format === 'webp'
          ? pipeline.webp({ quality: options.quality })
          : LOSSY_FORMATS.has(options.format)
            ? pipeline.jpeg({ quality: options.quality })
            : options.format === 'gif'
              ? pipeline.gif()
              : pipeline.png();
        outputBuffer = await output.toBuffer();
      }
      fs.writeFileSync(stageOutputPath, outputBuffer, { flag: 'wx' });
      const stageStats = inspectGeneratedFile(stageOutputPath, 'CONVERSION_OUTPUT_INVALID');
      item.stageOutputIdentity = { dev: stageStats.dev, ino: stageStats.ino };
      const metadata = options.format === 'bmp'
        ? decodeBmp(new Uint8Array(outputBuffer))
        : await sharpImplementation(outputBuffer).metadata();
      const bmpOutputValid = options.format !== 'bmp'
        || (Number.isSafeInteger(metadata.width) && metadata.width > 0
          && Number.isSafeInteger(metadata.height) && metadata.height > 0
          && [1, 3, 4].includes(metadata.channels)
          && metadata.data instanceof Uint8Array
          && Number.isSafeInteger(metadata.width * metadata.height * metadata.channels)
          && metadata.data.length === metadata.width * metadata.height * metadata.channels);
      if (!bmpOutputValid
        || (options.format !== 'bmp' && metadata.format !== sharpOutputFormat(options.format))
        || (options.format === 'gif' && (metadata.pages ?? 1) !== 1)) {
        throw new Error('Sharp produced an unexpected output format.');
      }
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      throw new AssetProcessingError('Sharp could not convert a selected image.', {
        code: 'CONVERSION_FAILED',
        cause: err,
      });
    }
  }

  function ensureOriginalDirectories(items, staging) {
    const byPath = new Map();
    for (const item of items) {
      if (byPath.has(pathKey(item.originalsDirAbsPath))) continue;
      try {
        fs.mkdirSync(item.originalsDirAbsPath);
        const stats = fs.lstatSync(item.originalsDirAbsPath);
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Invalid originals directory.');
        const created = {
          path: item.originalsDirAbsPath,
          identity: { dev: stats.dev, ino: stats.ino },
        };
        staging.createdOriginalDirs.push(created);
        byPath.set(pathKey(item.originalsDirAbsPath), created);
      } catch (err) {
        if (err.code === 'EEXIST') {
          const info = inspectOriginalsDirectory(item.originalsDirAbsPath);
          byPath.set(pathKey(item.originalsDirAbsPath), info);
          continue;
        }
        throw new AssetProcessingError('CreatorCrate could not prepare the originals directory.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
    }
  }

  function materializeOutput(item) {
    try {
      fs.linkSync(item.stageOutput, item.outputAbsPath);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new AssetProcessingError('A converted output destination appeared during processing.', {
          code: 'OUTPUT_DESTINATION_CONFLICT',
        });
      }
      throw new AssetProcessingError('CreatorCrate could not publish a converted output.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    const outputStats = inspectGeneratedFile(item.outputAbsPath, 'RECOVERY_REQUIRED');
    if (!sameIdentity(outputStats, item.stageOutputIdentity)) {
      throw new AssetProcessingError('Converted output identity could not be verified.', {
        code: 'RECOVERY_REQUIRED',
      });
    }
    item.outputCommitted = true;
    item.outputIdentity = { dev: outputStats.dev, ino: outputStats.ino };
    item.outputStats = outputStats;

    try {
      fs.unlinkSync(item.stageOutput);
      item.stageOutput = null;
    } catch (err) {
      throw new AssetProcessingError('Converted output staging cleanup failed.', {
        code: 'RECOVERY_REQUIRED',
        cause: err,
      });
    }
  }

  function materializeReencodedOutput(item) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during conversion.', {
        code: 'SOURCE_CHANGED',
      });
    }

    item.destinationBackupPath = path.join(item.stagingDirectory, `${item.stageIndex}.source`);
    try {
      fs.linkSync(item.sourceAbsPath, item.destinationBackupPath);
      const backupStats = inspectGeneratedFile(item.destinationBackupPath, 'RECOVERY_REQUIRED');
      if (!sameIdentity(backupStats, item.sourceIdentity)) {
        throw new Error('Conversion source backup identity mismatch.');
      }
      item.destinationBackupIdentity = { dev: backupStats.dev, ino: backupStats.ino };

      const beforeDelete = inspectSource(item.sourceAbsPath);
      if (!sameIdentity(beforeDelete, item.sourceIdentity)) {
        throw new AssetProcessingError('A selected source changed during conversion.', {
          code: 'SOURCE_CHANGED',
        });
      }
      fs.unlinkSync(item.sourceAbsPath);
      item.sourceRemoved = true;

      fs.linkSync(item.stageOutput, item.sourceAbsPath);
      item.outputPublished = true;
      const outputStats = inspectGeneratedFile(item.sourceAbsPath, 'RECOVERY_REQUIRED');
      item.outputIdentity = { dev: outputStats.dev, ino: outputStats.ino };
      if (!sameIdentity(outputStats, item.stageOutputIdentity)) {
        throw new AssetProcessingError('Converted output identity could not be verified.', {
          code: 'RECOVERY_REQUIRED',
        });
      }
      item.outputCommitted = true;
      item.outputStats = outputStats;

      fs.unlinkSync(item.stageOutput);
      item.stageOutput = null;
    } catch (err) {
      if (item.destinationBackupPath && !item.destinationBackupIdentity) {
        try {
          const backupStats = fs.lstatSync(item.destinationBackupPath);
          if (!backupStats.isSymbolicLink() && backupStats.isFile()) {
            item.destinationBackupIdentity = { dev: backupStats.dev, ino: backupStats.ino };
          }
        } catch (backupErr) {
          if (backupErr.code === 'ENOENT') item.destinationBackupPath = null;
        }
      }
      if (err instanceof AssetProcessingError) throw err;
      throw new AssetProcessingError('CreatorCrate could not publish a converted output.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
  }

  function restoreReencodedOutputs(items) {
    let restored = true;
    for (const item of [...items].reverse()) {
      if (!item.sameExtension || !item.destinationBackupPath) continue;

      let current = null;
      try {
        current = fs.lstatSync(item.sourceAbsPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          restored = false;
          continue;
        }
      }

      if (current && sameIdentity(current, item.sourceIdentity)) {
        if (!removeFileIfIdentityMatches(item.destinationBackupPath, item.destinationBackupIdentity)) {
          restored = false;
          continue;
        }
        item.destinationBackupPath = null;
        item.sourceRemoved = false;
        item.outputPublished = false;
        item.outputCommitted = false;
        continue;
      }

      if (current) {
        if (current.isSymbolicLink() || !current.isFile()
          || !item.outputIdentity || !sameIdentity(current, item.outputIdentity)) {
          restored = false;
          continue;
        }
        try {
          fs.unlinkSync(item.sourceAbsPath);
        } catch {
          restored = false;
          continue;
        }
      }

      try {
        const backupStats = inspectGeneratedFile(item.destinationBackupPath, 'RECOVERY_REQUIRED');
        if (!sameIdentity(backupStats, item.destinationBackupIdentity)) {
          restored = false;
          continue;
        }
        fs.linkSync(item.destinationBackupPath, item.sourceAbsPath);
        const restoredStats = inspectSource(item.sourceAbsPath);
        if (!sameIdentity(restoredStats, item.sourceIdentity)) {
          restored = false;
          continue;
        }
        fs.unlinkSync(item.destinationBackupPath);
        item.destinationBackupPath = null;
        item.sourceRemoved = false;
        item.outputPublished = false;
        item.outputCommitted = false;
      } catch {
        restored = false;
      }
    }
    return restored;
  }

  function moveOriginalToOriginals(item) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during conversion.', {
        code: 'SOURCE_CHANGED',
      });
    }

    try {
      fs.linkSync(item.sourceAbsPath, item.originalAbsPath);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new AssetProcessingError('An originals destination appeared during processing.', {
          code: 'ORIGINAL_DESTINATION_CONFLICT',
        });
      }
      throw new AssetProcessingError('CreatorCrate could not move an original into originals.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    const originalStats = inspectGeneratedFile(item.originalAbsPath, 'RECOVERY_REQUIRED');
    if (!sameIdentity(originalStats, item.sourceIdentity)) {
      throw new AssetProcessingError('Original destination identity could not be verified.', {
        code: 'RECOVERY_REQUIRED',
      });
    }

    try {
      fs.unlinkSync(item.sourceAbsPath);
    } catch (err) {
      const cleaned = removeFileIfIdentityMatches(item.originalAbsPath, item.sourceIdentity);
      if (!cleaned) {
        throw new AssetProcessingError(
          'The original was copied but could not be safely completed or restored.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw new AssetProcessingError('CreatorCrate could not move an original into originals.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    try {
      fs.lstatSync(item.sourceAbsPath);
      throw new AssetProcessingError('The original source still exists after the move.', {
        code: 'RECOVERY_REQUIRED',
      });
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      if (err.code !== 'ENOENT') throw err;
    }

    item.originalMoved = true;
    item.originalIdentity = { dev: originalStats.dev, ino: originalStats.ino };
    item.originalStats = originalStats;
  }

  function stageOriginalForDelete(item, staging, index, projectDir) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during conversion.', {
        code: 'SOURCE_CHANGED',
      });
    }

    const stagedDeletePath = path.join(staging.directory, `${index}.original`);
    item.stagedDeletePath = stagedDeletePath;
    try {
      const sourceSha256 = projectDir
        ? hashRegularFileInProject(projectDir, item.sourceAbsPath) : null;
      fs.linkSync(item.sourceAbsPath, stagedDeletePath);
      const stagedStats = inspectGeneratedFile(stagedDeletePath, 'RECOVERY_REQUIRED');
      item.stagedDeleteIdentity = { dev: stagedStats.dev, ino: stagedStats.ino };
      const stagedVerification = sourceSha256
        ? verifyWatermarkHardLink({
          projectDir,
          referencePath: item.sourceAbsPath,
          referenceIdentity: item.sourceIdentity,
          referenceStats: currentStats,
          outputPath: stagedDeletePath,
          outputSha256: sourceSha256,
        })
        : (sameIdentity(stagedStats, item.sourceIdentity) ? { mode: 'strict' } : null);
      if (!stagedVerification) throw new Error('Staged original identity mismatch.');
      item.stagedDeleteSha256 = sourceSha256;
      fs.unlinkSync(item.sourceAbsPath);
    } catch (err) {
      let cleaned;
      if (item.stagedDeleteIdentity) {
        cleaned = removeFileIfIdentityMatches(stagedDeletePath, item.stagedDeleteIdentity);
      } else {
        try {
          fs.lstatSync(stagedDeletePath);
          cleaned = false;
        } catch (cleanupErr) {
          cleaned = cleanupErr.code === 'ENOENT';
        }
      }
      if (!cleaned) {
        throw new AssetProcessingError(
          'The original was staged but could not be safely restored.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      if (err instanceof AssetProcessingError) throw err;
      throw new AssetProcessingError('CreatorCrate could not stage an original for deletion.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    try {
      fs.lstatSync(item.sourceAbsPath);
      throw new AssetProcessingError('The original source still exists after staging.', {
        code: 'RECOVERY_REQUIRED',
      });
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      if (err.code !== 'ENOENT') throw err;
    }

  }

  function recoverAfterFailure(staging, items) {
    const outputsClean = cleanupCommittedOutputs(items.filter((item) => !item.sameExtension));
    const reencodedRestored = restoreReencodedOutputs(items);
    const deletesRestored = restoreStagedDeletes(items);
    const stagingClean = cleanupStaging(staging);
    const dirsClean = cleanupCreatedOriginalDirs(staging.createdOriginalDirs);
    const movedOriginalRemains = items.some((item) => item.originalMoved);
    return outputsClean && reencodedRestored && deletesRestored && stagingClean && dirsClean
      && !movedOriginalRemains;
  }

  function buildChanges(items, options) {
    const outputs = items.filter((item) => !item.sameExtension).map((item) => ({
      relativePath: item.outputRelativePath,
      filename: item.outputFilename,
      extension: options.format,
      mimeType: mimeFromExtension(options.format),
      categoryId: item.outputCategoryId,
      nestedPath: item.outputNestedPath,
      sizeBytes: item.outputStats.size,
      modifiedAt: item.outputStats.mtime.toISOString(),
    }));

    const reencodes = items.filter((item) => item.sameExtension).map((item) => ({
      assetId: item.asset.id,
      expectedRelativePath: item.sourceRelativePath,
      expectedSizeBytes: item.asset.size_bytes,
      expectedModifiedAt: item.asset.modified_at,
      sizeBytes: item.outputStats.size,
      modifiedAt: item.outputStats.mtime.toISOString(),
    }));

    const moves = options.originalHandling === 'move'
      ? items.map((item) => ({
        assetId: item.asset.id,
        expectedOldRelativePath: item.sourceRelativePath,
        data: {
          relativePath: item.originalRelativePath,
          filename: item.sourceFilename,
          extension: item.sourceExtension,
          mimeType: mimeFromExtension(item.sourceExtension),
          categoryId: item.originalCategoryId,
          nestedPath: item.originalNestedPath,
          sizeBytes: item.originalStats.size,
          modifiedAt: item.originalStats.mtime.toISOString(),
        },
      }))
      : [];

    const deletes = options.originalHandling === 'delete'
      ? items.map((item) => ({ assetId: item.asset.id, relativePath: item.sourceRelativePath }))
      : [];

    return { moves, deletes, outputs, reencodes };
  }

  async function convertAssetsLocked(projectId, assetIds, options, progress) {
    const project = requireMutableProject(projectId);
    const projectDir = resolveProjectAbsPath(project);
    const categories = assetCategoryService.listProjectCategories(projectId);

    const items = [];
    const outputPaths = new Map();
    const originalPaths = new Map();
    const sourcePaths = new Map();

    for (const assetId of assetIds) {
      const asset = assetRepository.findById(assetId);
      if (!asset || asset.project_id !== projectId) {
        throw new AssetProcessingError(`Asset ${assetId} not found.`, { code: 'ASSET_NOT_FOUND' });
      }
      if (!isPresent(asset)) {
        throw new AssetProcessingError(`Asset ${assetId} is marked missing.`, { code: 'ASSET_MISSING' });
      }

      const sourceRelativePath = normalizeRelativePath(asset.relative_path);
      const sourceFilename = path.posix.basename(sourceRelativePath);
      const sourceExtension = deriveExtensionFromFilename(sourceFilename);
      if (!isSupportedConversionSource(sourceExtension)) {
        throw new AssetProcessingError('The selected asset is not a supported source image.', {
          code: 'UNSUPPORTED_SOURCE_TYPE',
        });
      }

      const derived = deriveConversionOutputPlan(sourceRelativePath, options);
      const {
        sourceParent,
        sameExtension,
        outputFilename,
        outputRelativePath,
      } = derived;
      const outputClassification = classifyAssetPath(outputRelativePath, categories);
      const sourceAbsPath = resolveContained(
        projectDir,
        sourceRelativePath,
        'SOURCE_PATH_UNSAFE',
        'Source',
      );
      const sourceStats = inspectSource(sourceAbsPath);
      const sourceIdentity = { dev: sourceStats.dev, ino: sourceStats.ino };

      const outputAbsPath = resolveContained(
        projectDir,
        outputRelativePath,
        'OUTPUT_PATH_UNSAFE',
        'Output',
      );
      const outputKey = pathKey(outputAbsPath);
      if (outputPaths.has(outputKey) || originalPaths.has(outputKey)) {
        throw new AssetProcessingError('Two selected assets would use the same output destination.', {
          code: 'INTRA_BATCH_COLLISION',
        });
      }
      outputPaths.set(outputKey, assetId);
      const destinationAsset = assetRepository.findByProjectIdAndPath(projectId, outputRelativePath);
      if (destinationAsset && (!sameExtension || destinationAsset.id !== assetId)) {
        throw new AssetProcessingError('The output destination is already indexed.', {
          code: 'OUTPUT_DESTINATION_CONFLICT',
        });
      }
      if (!sameExtension) {
        assertDestinationClear(outputAbsPath, 'OUTPUT_DESTINATION_CONFLICT', 'output destination');
      }

      const item = {
        asset,
        sourceRelativePath,
        sourceFilename,
        sourceExtension,
        sourceAbsPath,
        sourceIdentity,
        outputFilename,
        outputRelativePath,
        outputAbsPath,
        sameExtension,
        outputCategoryId: outputClassification.categoryId,
        outputNestedPath: outputClassification.nestedPath,
      };

      const sourceKey = pathKey(sourceAbsPath);
      if (sourcePaths.has(sourceKey)) {
        throw new AssetProcessingError('Two selected assets resolve to the same source path.', {
          code: 'INTRA_BATCH_COLLISION',
        });
      }
      sourcePaths.set(sourceKey, assetId);

      if (options.originalHandling === 'move') {
        const { originalsDirRelative, originalRelativePath } = derived;
        const originalsDirAbsPath = resolveContained(
          projectDir,
          originalsDirRelative,
          'ORIGINALS_DIRECTORY_UNSAFE',
          'Originals directory',
        );
        const originalAbsPath = resolveContained(
          projectDir,
          originalRelativePath,
          'ORIGINAL_PATH_UNSAFE',
          'Original',
        );
        const originalClassification = classifyAssetPath(originalRelativePath, categories);
        inspectOriginalsDirectory(originalsDirAbsPath);
        const originalKey = pathKey(originalAbsPath);
        if (originalPaths.has(originalKey) || outputPaths.has(originalKey)) {
          throw new AssetProcessingError('Two selected assets would use the same originals destination.', {
            code: 'INTRA_BATCH_COLLISION',
          });
        }
        originalPaths.set(originalKey, assetId);
        if (assetRepository.findByProjectIdAndPath(projectId, originalRelativePath)) {
          throw new AssetProcessingError('The originals destination is already indexed.', {
            code: 'ORIGINAL_DESTINATION_CONFLICT',
          });
        }
        assertDestinationClear(originalAbsPath, 'ORIGINAL_DESTINATION_CONFLICT', 'originals destination');
        item.originalsDirAbsPath = originalsDirAbsPath;
        item.originalRelativePath = originalRelativePath;
        item.originalAbsPath = originalAbsPath;
        item.originalCategoryId = originalClassification.categoryId;
        item.originalNestedPath = originalClassification.nestedPath;
      }

      items.push(item);
    }

    if (options.originalHandling === 'delete') {
      const protectedIds = assetRepository.findPublishedReleaseAssetIds(projectId, assetIds);
      if (protectedIds.length > 0) {
        throw new AssetProcessingError(
          `Assets associated with a published release cannot be deleted: ${protectedIds.join(', ')}.`,
          { code: 'PUBLISHED_RELEASE_ASSET_PROTECTED' },
        );
      }
    }

    const staging = createStaging(projectDir);
    staging.items = items;
    staging.createdOriginalDirs = [];

    try {
      await processingConcurrencyService.mapBounded(items, async (item, index) => {
        await stageOutput(item, staging, options, index);
        progress.advance();
      });

      if (options.originalHandling === 'move') {
        ensureOriginalDirectories(items, staging);
      }

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item.sameExtension) {
          materializeReencodedOutput(item);
        } else {
          materializeOutput(item);
        }
        if (options.originalHandling === 'move') {
          moveOriginalToOriginals(item);
        } else if (options.originalHandling === 'delete') {
          stageOriginalForDelete(item, staging, index);
        }
      }
    } catch (err) {
      const recoverable = recoverAfterFailure(staging, items);
      if (!recoverable) {
        throw new AssetProcessingError(
          'Conversion changed the filesystem but could not safely complete or clean up. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw err;
    }

    let changes;
    let databaseResult;
    try {
      changes = buildChanges(items, options);
      databaseResult = assetRepository.applyAssetConversions(projectId, changes);
      if (!databaseResult
        || !Array.isArray(databaseResult.outputs)
        || !Array.isArray(databaseResult.reencoded)
        || databaseResult.outputs.length + databaseResult.reencoded.length !== items.length) {
        throw new Error('Asset conversion repository returned an unexpected result.');
      }
    } catch (err) {
      const recoverable = recoverAfterFailure(staging, items);
      if (!recoverable) {
        throw new AssetProcessingError(
          'Converted files were written but CreatorCrate could not restore the filesystem after an index failure. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw new AssetProcessingError(
        'Converted files were removed because CreatorCrate could not update the asset index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      );
    }

    const reencodedById = new Map(databaseResult.reencoded.map((asset) => [asset.id, asset]));
    const outputsByPath = new Map(databaseResult.outputs.map((asset) => [asset.relative_path, asset]));
    const resultAssets = items.map((item) => (
      item.sameExtension
        ? reencodedById.get(item.asset.id)
        : outputsByPath.get(item.outputRelativePath)
    ));
    if (resultAssets.some((asset) => !asset)) {
      const recoverable = recoverAfterFailure(staging, items);
      if (!recoverable) {
        throw new AssetProcessingError(
          'Converted files were written but CreatorCrate could not restore the filesystem after an index failure. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED' },
        );
      }
      throw new AssetProcessingError(
        'Converted files were removed because CreatorCrate could not update the asset index.',
        { code: 'DATABASE_OPERATION_FAILED' },
      );
    }

    // Delete-mode staged sources are intentionally removed only after the DB
    // transaction succeeds. Do not use restoreStagedDeletes here; unlinking
    // requires the same identity check without recreating the source path.
    let sourceCleanup = true;
    if (options.originalHandling === 'delete') {
      for (const item of items) {
        if (!removeFileIfIdentityMatches(item.stagedDeletePath, item.stagedDeleteIdentity)) {
          sourceCleanup = false;
        }
        item.stagedDeletePath = null;
      }
    }
    const stagingClean = cleanupStaging(staging);
    if (!sourceCleanup || !stagingClean) {
      throw new AssetProcessingError(
        'Asset records were updated, but CreatorCrate could not safely finish filesystem cleanup. Inspect the project folder before scanning.',
        { code: 'RECOVERY_REQUIRED' },
      );
    }

    return {
      convertedCount: resultAssets.length,
      requestedCount: assetIds.length,
      convertedAssetIds: resultAssets.map((asset) => asset.id),
      assets: resultAssets,
      format: options.format,
      quality: options.quality,
      originalHandling: options.originalHandling,
    };
  }

  async function convertAssets(projectId, assetIds, rawOptions, onProgress, coordinationToken) {
    if (!isPositiveSafeInteger(projectId)) {
      throw new AssetProcessingError('projectId must be a positive integer.', { code: 'INVALID_PROJECT_ID' });
    }
    if (!Array.isArray(assetIds)) {
      throw new AssetProcessingError('assetIds must be an array.', { code: 'INVALID_ASSET_SELECTION' });
    }
    if (assetIds.length === 0) {
      throw new AssetProcessingError('No assets selected.', { code: 'NO_ASSETS_SELECTED' });
    }
    const seen = new Set();
    for (const assetId of assetIds) {
      if (!isPositiveSafeInteger(assetId)) {
        throw new AssetProcessingError(
          'assetIds must contain only positive integer IDs.',
          { code: 'INVALID_ASSET_SELECTION' },
        );
      }
      if (seen.has(assetId)) {
        throw new AssetProcessingError('Duplicate asset IDs in selection.', {
          code: 'DUPLICATE_ASSET_SELECTION',
        });
      }
      seen.add(assetId);
    }

    const options = normalizeConversionOptions(rawOptions);
    const execute = async () => {
      const progress = createProgressReporter(assetIds.length, onProgress);
      const result = await observeRecovery({
        operation: 'convert', projectId, assetCount: assetIds.length, onProgress,
      }, () => convertAssetsLocked(projectId, assetIds, options, progress));
      progress.finish();
      return result;
    };
    if (coordinationToken !== undefined) {
      assertAlreadyCoordinatedCapability(coordinationToken);
      return execute();
    }

    try {
      return await projectOperationCoordinator.runAsync(projectId, execute);
    } catch (err) {
      if (err instanceof ProjectOperationError
        && err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
        throw new AssetProcessingError(
          `An operation is already in progress for project ${projectId}. Try again shortly.`,
          { code: 'PROJECT_BUSY', cause: err },
        );
      }
      throw err;
    }
  }


  function isOwnedWatermarkDestination({
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
  }) {
    let destinationHash = null;
    if (destinationStats) {
      try {
        destinationHash = hashRegularFileInProject(projectDir, resolveContained(
          projectDir,
          outputRelativePath,
          'OUTPUT_PATH_UNSAFE',
          'Output',
        ));
      } catch {
        return false;
      }
    }
    try {
      return isOwnedWatermarkDestinationShared({
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
    } catch {
      return false;
    }
  }

  function buildWatermarkChanges(items, options, watermarkId, artifacts = []) {
    const dataFor = (item) => ({
      relativePath: item.outputRelativePath,
      filename: item.outputFilename,
      extension: item.outputExtension,
      mimeType: mimeFromExtension(item.outputExtension),
      categoryId: item.outputCategoryId,
      nestedPath: item.outputNestedPath,
      sizeBytes: item.outputStats.size,
      modifiedAt: item.outputStats.mtime.toISOString(),
    });

    const replacements = items
      .filter((item) => item.destinationAsset)
      .map((item) => ({
        assetId: item.destinationAsset.id,
        expectedOldRelativePath: item.outputRelativePath,
        generatedSourceAssetId: item.asset.id,
        generatedSourceRelativePath: item.sourceRelativePath,
        generatedMode: options.mode,
        generatedVariant: item.variant,
        generatedOutputSha256: item.outputSha256,
        generatedWatermarkId: watermarkId,
        expectedGeneratedSourceAssetId: item.destinationAsset.generated_source_asset_id,
        expectedGeneratedSourceRelativePath: item.destinationAsset.generated_source_relative_path,
        expectedGeneratedMode: item.destinationAsset.generated_mode,
        expectedGeneratedVariant: item.destinationAsset.generated_variant,
        expectedGeneratedOutputSha256: item.destinationAsset.generated_output_sha256,
        expectedGeneratedWatermarkId: item.destinationAsset.generated_watermark_id,
        data: dataFor(item),
      }));
    const outputs = items
      .filter((item) => !item.destinationAsset)
      .map((item) => ({
        ...dataFor(item),
        generatedSourceAssetId: item.asset.id,
        generatedSourceRelativePath: item.sourceRelativePath,
        generatedMode: options.mode,
        generatedVariant: item.variant,
        generatedOutputSha256: item.outputSha256,
        generatedWatermarkId: watermarkId,
      }));
    const deletes = [...new Map(items
      .filter((item) => item.sourceDeleteEligible)
      .map((item) => [item.asset.id, {
        assetId: item.asset.id,
        relativePath: item.sourceRelativePath,
      }])).values()];
    return {
      replacements,
      deletes,
      outputs,
      artifactReplacements: artifacts.filter((artifact) => artifact.artifact).map((artifact) => ({
        id: artifact.artifact.id,
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        expectedSha256: artifact.artifact.sha256,
        sha256: artifact.sha256,
        sizeBytes: artifact.outputStats.size,
        generatedBy: WATERMARK_GENERATED_BY,
        generatedMode: options.mode,
        generatedWatermarkId: watermarkId,
        expectedGeneratedWatermarkId: artifact.artifact.generated_watermark_id,
      })),
      artifactOutputs: artifacts.filter((artifact) => !artifact.artifact).map((artifact) => ({
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        sha256: artifact.sha256,
        sizeBytes: artifact.outputStats.size,
        generatedBy: WATERMARK_GENERATED_BY,
        generatedMode: options.mode,
        generatedWatermarkId: watermarkId,
      })),
    };
  }

  function buildArchiveArtifactChanges(archivePlans) {
    return {
      replacements: [],
      deletes: [],
      outputs: [],
      artifactReplacements: archivePlans
        .filter((plan) => plan.artifact)
        .map((plan) => ({
          id: plan.artifact.id,
          relativePath: plan.relativePath,
          kind: plan.kind,
          expectedSha256: plan.artifact.sha256,
          sha256: plan.sha256,
          sizeBytes: plan.outputStats.size,
          generatedBy: ARCHIVES_GENERATED_BY,
          generatedMode: 'standalone',
          generatedWatermarkId: null,
          expectedGeneratedWatermarkId: null,
        })),
      artifactOutputs: archivePlans
        .filter((plan) => !plan.artifact)
        .map((plan) => ({
          relativePath: plan.relativePath,
          kind: plan.kind,
          sha256: plan.sha256,
          sizeBytes: plan.outputStats.size,
          generatedBy: ARCHIVES_GENERATED_BY,
          generatedMode: 'standalone',
          generatedWatermarkId: null,
        })),
    };
  }

  async function watermarkAssetsLocked(projectId, assetIds, options, watermarkIdentity = {}, progress) {
    const { watermarkId } = watermarkIdentity;
    const project = requireMutableProject(projectId);
    const projectDir = resolveProjectAbsPath(project);
    const categories = assetCategoryService.listProjectCategories(projectId);
    resolveWatermarkOutputCategory(categories, options.outputCategorySlug);
    if (options.deleteSource) {
      const protectedIds = assetRepository.findPublishedReleaseAssetIds(projectId, assetIds);
      if (protectedIds.length > 0) {
        throw new AssetProcessingError(
          `Assets associated with a published release cannot be deleted: ${protectedIds.join(', ')}.`,
          { code: 'PUBLISHED_RELEASE_ASSET_PROTECTED' },
        );
      }
    }
    const watermarkSelection = resolveWatermarkInput({ watermarkId });
    const trustedWatermarkPath = watermarkSelection.filePath;
    let watermarkInput;
    try {
      watermarkInput = await prepareWatermark(trustedWatermarkPath, sharpImplementation, options.trimWatermark);
    } catch (err) {
      throw wrapWatermarkEngineError(err);
    }

    const items = [];
    const sources = [];
    const outputPaths = new Map();
    const sourcePaths = new Map();
    for (const assetId of assetIds) {
      const asset = assetRepository.findById(assetId);
      if (!asset || asset.project_id !== projectId) {
        throw new AssetProcessingError(`Asset ${assetId} not found.`, { code: 'ASSET_NOT_FOUND' });
      }
      if (!isPresent(asset)) {
        throw new AssetProcessingError(`Asset ${assetId} is marked missing.`, { code: 'ASSET_MISSING' });
      }
      if (typeof asset.relative_path !== 'string' || asset.relative_path.length === 0) {
        throw new AssetProcessingError('The selected asset path is unsafe.', {
          code: 'SOURCE_PATH_UNSAFE',
        });
      }

      const sourceRelativePath = normalizeRelativePath(asset.relative_path);
      const sourceFilename = path.posix.basename(sourceRelativePath);
      const sourceExtension = deriveExtensionFromFilename(sourceFilename);
      if (!WATERMARK_SOURCE_IMAGE_EXTENSIONS.has(sourceExtension)) {
        throw new AssetProcessingError('The selected asset is not a supported watermark source image.', {
          code: 'UNSUPPORTED_SOURCE_TYPE',
        });
      }

      const sourceAbsPath = resolveContained(
        projectDir,
        sourceRelativePath,
        'SOURCE_PATH_UNSAFE',
        'Source',
      );
      const sourceStats = inspectSource(sourceAbsPath);
      const sourceIdentity = { dev: sourceStats.dev, ino: sourceStats.ino };
      const sourceKey = pathKey(sourceAbsPath);
      if (sourcePaths.has(sourceKey) || outputPaths.has(sourceKey)) {
        throw new AssetProcessingError('Two selected assets resolve to the same source or output path.', {
          code: 'INTRA_BATCH_COLLISION',
        });
      }
      sourcePaths.set(sourceKey, assetId);

      let derivedOutput;
      try {
        derivedOutput = deriveWatermarkOutputPlan(sourceRelativePath, options);
      } catch (err) {
        throw wrapWatermarkEngineError(err);
      }
      const source = { asset, sourceRelativePath, sourceAbsPath, sourceIdentity, derivedOutput, outputs: [], deleteReason: null };
      for (const output of derivedOutput.outputs) {
        const outputClassification = classifyAssetPath(output.outputRelativePath, categories);
        const outputAbsPath = resolveContained(projectDir, output.outputRelativePath, 'OUTPUT_PATH_UNSAFE', 'Output');
        const outputKey = pathKey(outputAbsPath);
        if (outputPaths.has(outputKey) || sourcePaths.has(outputKey)) {
          throw new AssetProcessingError('Watermark outputs collide with another selected source or output.', {
            code: 'INTRA_BATCH_COLLISION',
          });
        }
        outputPaths.set(outputKey, assetId);
        const destinationAsset = assetRepository.findByProjectIdAndPath(projectId, output.outputRelativePath);
        const destinationStats = inspectOptionalDestination(outputAbsPath);
        if (destinationAsset?.id === asset.id) {
          throw new AssetProcessingError('A watermark output cannot replace its selected source asset.', { code: 'INTRA_BATCH_COLLISION' });
        }
        if (destinationStats && !options.overwrite) {
          source.outputs.push({ ...output, status: 'skipped-existing' });
          source.deleteReason = 'SKIPPED_EXISTING_OUTPUT';
          continue;
        }
        if (!destinationAsset && destinationStats) {
          throw new AssetProcessingError('The watermark output destination already exists.', { code: 'OUTPUT_DESTINATION_CONFLICT' });
        }
        if (destinationAsset && !isOwnedWatermarkDestination({
          watermarkId,
          destinationAsset, destinationStats, sourceAsset: asset, sourceRelativePath,
          outputRelativePath: output.outputRelativePath, outputCategoryId: outputClassification.categoryId,
          outputNestedPath: outputClassification.nestedPath, variant: output.variant, options, projectDir,
        })) {
          throw new AssetProcessingError('The existing watermark destination is not owned by this operation.', { code: 'OUTPUT_DESTINATION_CONFLICT' });
        }
        const item = {
          asset, sourceRelativePath, sourceFilename, sourceExtension, sourceAbsPath, sourceIdentity,
          variant: output.variant, variantMaxDimension: output.maxDimension,
          outputFilename: output.outputFilename, outputExtension: output.outputExtension,
          outputRelativePath: output.outputRelativePath, outputCategoryId: outputClassification.categoryId,
          outputNestedPath: outputClassification.nestedPath, outputAbsPath,
          outputDirectoryAbsPath: path.dirname(outputAbsPath), outputFormat: output.outputFormat,
          destinationAsset: destinationAsset || null, destinationStats,
          destinationIdentity: destinationStats ? { dev: destinationStats.dev, ino: destinationStats.ino } : null,
          destinationRemoved: false, outputPublication: 'unlinked',
        };
        items.push(item);
        source.outputs.push({ ...output, status: 'planned', item });
      }
      sources.push(source);
    }

    const protectedIds = options.deleteSource
      ? new Set(assetRepository.findPublishedReleaseAssetIds(projectId, assetIds)) : new Set();
    for (const source of sources) {
      source.deleteEligible = options.deleteSource && source.outputs.length > 0
        && source.outputs.every((output) => output.status === 'planned') && !protectedIds.has(source.asset.id);
      if (protectedIds.has(source.asset.id)) source.deleteReason = 'PUBLISHED_RELEASE_PROTECTED';
      for (const output of source.outputs) {
        if (output.item) output.item.sourceDeleteEligible = source.deleteEligible;
      }
    }

    const archivePlans = preflightArchivePlans(project, projectId, projectDir, sources, options, {
      watermarkId,
    });
    const staging = createWatermarkStaging(projectDir);
    staging.items = items;
    staging.artifacts = archivePlans;
    try {
      ensureWatermarkOutputDirectories([...items, ...archivePlans], staging);
      const stageIndexByItem = new Map(items.map((item, index) => [item, index]));
      await processingConcurrencyService.mapBounded(sources, async (source) => {
        const sourceItems = source.outputs
          .filter((output) => output.item)
          .map((output) => output.item);
        for (const item of sourceItems) {
          await stageWatermarkOutput(
            item,
            staging,
            stageIndexByItem.get(item),
            watermarkInput,
            options,
            projectDir,
          );
        }
        progress.advance();
      });
      for (let index = 0; index < archivePlans.length; index++) {
        await stageArchiveArtifact(archivePlans[index], staging, index, watermarkInput, options, projectDir);
      }
      for (const item of items) {
        publishWatermarkOutput(item, projectDir);
      }
      for (const archivePlan of archivePlans) {
        publishArchiveArtifact(archivePlan, projectDir);
      }
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        if (source.deleteEligible) stageOriginalForDelete(source.outputs[0].item, staging, items.length + index, projectDir);
      }
    } catch (err) {
      const recoverable = recoverWatermarkAfterFailure(staging, items, projectDir);
      if (!recoverable) {
        throw new AssetProcessingError(
          'Watermarking changed the filesystem but could not safely complete or clean up. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw err;
    }

    let databaseResult;
    try {
      databaseResult = assetRepository.applyAssetWatermarks(
        projectId,
        buildWatermarkChanges(items, options, watermarkId, archivePlans),
      );
      if (!databaseResult
        || !Array.isArray(databaseResult.replaced)
        || !Array.isArray(databaseResult.outputs)
        || databaseResult.replaced.length + databaseResult.outputs.length !== items.length
        || !Array.isArray(databaseResult.deleted)
        || databaseResult.deleted.length !== sources.filter((source) => source.deleteEligible).length
        || !Array.isArray(databaseResult.artifactReplaced)
        || !Array.isArray(databaseResult.artifactOutputs)
        || databaseResult.artifactReplaced.length + databaseResult.artifactOutputs.length !== archivePlans.length) {
        throw new Error('Asset watermark repository returned an unexpected result.');
      }
    } catch (err) {
      const recoverable = recoverWatermarkAfterFailure(staging, items, projectDir);
      if (!recoverable) {
        throw new AssetProcessingError(
          'Watermarked files were written but CreatorCrate could not restore the filesystem after an index failure. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw new AssetProcessingError(
        'Watermarked files were removed because CreatorCrate could not update the asset index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      );
    }

    let sourceCleanup = true;
    if (options.deleteSource) {
      for (const source of sources) {
        if (!source.deleteEligible) continue;
        const item = source.outputs[0].item;
        if (!removeFileIfIdentityMatches(item.stagedDeletePath, item.stagedDeleteIdentity)) {
          sourceCleanup = false;
        }
        item.stagedDeletePath = null;
      }
    }
    const artifactsClean = cleanupArchiveStaging(archivePlans);
    const stagingClean = cleanupWatermarkStaging(staging);
    if (!sourceCleanup || !artifactsClean || !stagingClean) {
      throw new AssetProcessingError(
        'Watermark asset records were updated, but CreatorCrate could not safely finish filesystem cleanup. Inspect the project folder before scanning.',
        { code: 'RECOVERY_REQUIRED' },
      );
    }

    let replacedIndex = 0;
    let outputIndex = 0;
    const generatedAssets = items.map((item) => (
      item.destinationAsset
        ? databaseResult.replaced[replacedIndex++]
        : databaseResult.outputs[outputIndex++]
    ));
    let artifactReplacedIndex = 0;
    let artifactOutputIndex = 0;
    const artifacts = archivePlans.map((plan) => (
      plan.artifact
        ? databaseResult.artifactReplaced[artifactReplacedIndex++]
        : databaseResult.artifactOutputs[artifactOutputIndex++]
    ));
    return {
      status: 'completed',
      operation: 'watermarkAssets',
      mode: options.mode,
      requestedCount: assetIds.length,
      generatedCount: generatedAssets.length,
      changedCount: generatedAssets.length,
      unchangedCount: 0,
      generatedAssetIds: generatedAssets.map((asset) => asset.id),
      generatedPaths: generatedAssets.map((asset) => asset.relative_path),
      deletedSourceAssetIds: databaseResult.deleted.map((asset) => asset.id),
      deletedAssetIds: databaseResult.deleted.map((asset) => asset.id),
      unchangedAssetIds: [],
      rejectedAssetIds: [],
      assets: generatedAssets,
      artifacts: artifacts.map((artifact, index) => ({
        id: artifact.id,
        kind: artifact.kind,
        relativePath: artifact.relative_path,
        format: archivePlans[index].format,
        sizeBytes: artifact.size_bytes,
        sha256: artifact.sha256,
        status: 'written',
      })),
      deleteSource: options.deleteSource,
      maxDimension: options.maxDimension,
      outputFormat: options.outputFormat,
      sourceResults: sources.map((source) => ({
        assetId: source.asset.id,
        relativePath: source.sourceRelativePath,
        variants: [...new Map(source.outputs.map((output) => [output.variant, output.variant])).values()].map((variant) => ({
          variant,
          outputs: source.outputs.filter((output) => output.variant === variant).map((output) => ({
            format: output.outputFormat,
            relativePath: output.outputRelativePath,
            status: output.item ? 'written' : output.status,
          })),
        })),
        sourceAction: source.deleteEligible ? 'delete' : 'keep',
        sourceDeleted: source.deleteEligible,
        deleteWithheldReason: source.deleteReason,
      })),
    };
  }

  async function watermarkAssets(projectId, assetIds, rawOptions, onProgress, coordinationToken) {
    if (!isPositiveSafeInteger(projectId)) {
      throw new AssetProcessingError('projectId must be a positive integer.', { code: 'INVALID_PROJECT_ID' });
    }
    if (!Array.isArray(assetIds)) {
      throw new AssetProcessingError('assetIds must be an array.', { code: 'INVALID_ASSET_SELECTION' });
    }
    if (assetIds.length === 0) {
      throw new AssetProcessingError('No assets selected.', { code: 'NO_ASSETS_SELECTED' });
    }
    const seen = new Set();
    for (const assetId of assetIds) {
      if (!isPositiveSafeInteger(assetId)) {
        throw new AssetProcessingError(
          'assetIds must contain only positive integer IDs.',
          { code: 'INVALID_ASSET_SELECTION' },
        );
      }
      if (seen.has(assetId)) {
        throw new AssetProcessingError('Duplicate asset IDs in selection.', {
          code: 'DUPLICATE_ASSET_SELECTION',
        });
      }
      seen.add(assetId);
    }

    const resolvedScaleMap = resolveManagedScaleMap();
    const options = normalizeWatermarkServiceOptions(rawOptions, resolvedScaleMap.definition);
    const watermarkId = rawOptions?.watermarkId;
    const execute = async () => {
      const progress = createProgressReporter(assetIds.length, onProgress);
      const result = await observeRecovery({
        operation: 'watermark', projectId, assetCount: assetIds.length, onProgress,
      }, () => watermarkAssetsLocked(projectId, assetIds, options, { watermarkId }, progress));
      progress.finish();
      return result;
    };
    if (coordinationToken !== undefined) {
      assertAlreadyCoordinatedCapability(coordinationToken);
      return execute();
    }

    try {
      return await projectOperationCoordinator.runAsync(projectId, execute);
    } catch (err) {
      if (err instanceof ProjectOperationError
        && err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
        throw new AssetProcessingError(
          `An operation is already in progress for project ${projectId}. Try again shortly.`,
          { code: 'PROJECT_BUSY', cause: err },
        );
      }
      throw err;
    }
  }


  async function createArchivesLocked(projectId, assetIds, options, onProgress) {
    const project = requireMutableProject(projectId);
    const projectDir = resolveProjectAbsPath(project);
    const sources = [];
    const sourcePaths = new Map();

    for (const assetId of assetIds) {
      const asset = assetRepository.findById(assetId);
      if (!asset || asset.project_id !== projectId) {
        throw new AssetProcessingError(`Asset ${assetId} not found.`, { code: 'ASSET_NOT_FOUND' });
      }
      if (!isPresent(asset)) {
        throw new AssetProcessingError(`Asset ${assetId} is marked missing.`, { code: 'ASSET_MISSING' });
      }
      if (typeof asset.relative_path !== 'string' || asset.relative_path.length === 0) {
        throw new AssetProcessingError('The selected asset path is unsafe.', { code: 'SOURCE_PATH_UNSAFE' });
      }

      const sourceRelativePath = normalizeRelativePath(asset.relative_path);
      const sourceExtension = deriveExtensionFromFilename(path.posix.basename(sourceRelativePath));
      if (!ARCHIVE_SOURCE_IMAGE_EXTENSIONS.has(sourceExtension)) {
        throw new AssetProcessingError('The selected asset is not a supported archive source image.', {
          code: 'UNSUPPORTED_SOURCE_TYPE',
        });
      }

      const sourceAbsPath = resolveContained(projectDir, sourceRelativePath, 'SOURCE_PATH_UNSAFE', 'Source');
      const sourceStats = inspectSource(sourceAbsPath);
      const sourceKey = pathKey(sourceAbsPath);
      if (sourcePaths.has(sourceKey)) {
        throw new AssetProcessingError('Two selected assets resolve to the same source path.', {
          code: 'INTRA_BATCH_COLLISION',
        });
      }
      sourcePaths.set(sourceKey, assetId);
      sources.push({
        asset,
        sourceRelativePath,
        sourceAbsPath,
        sourceIdentity: { dev: sourceStats.dev, ino: sourceStats.ino },
      });
    }

    const archivePlans = preflightArchivePlans(
      project,
      projectId,
      projectDir,
      sources,
      options,
      {
        derivePlans: deriveArchivePlans,
        generatedBy: ARCHIVES_GENERATED_BY,
        requireNullWatermarkId: true,
        archiveLabel: 'standalone archive',
      },
    );
    const staging = createWatermarkStaging(projectDir);
    staging.items = [];
    staging.artifacts = archivePlans;
    const progress = createProgressReporter(archivePlans.length, onProgress);

    try {
      ensureWatermarkOutputDirectories(archivePlans, staging);
      for (let index = 0; index < archivePlans.length; index++) {
        await stageArchiveArtifactWithRenderer(
          archivePlans[index],
          staging,
          index,
          projectDir,
          async (entry, plan) => {
            const sourceBuffer = readSourceBytes(entry.source);
            const pipeline = sharpImplementation(sourceBuffer, { animated: false }).rotate();
            if (plan.kind === STANDALONE_ARCHIVE_KINDS.webp) {
              return pipeline.webp({ quality: plan.quality, lossless: false }).toBuffer();
            }
            return pipeline.jpeg({ quality: plan.quality }).toBuffer();
          },
          'CreatorCrate could not build a standalone archive.',
        );
        progress.advance();
      }
      for (const archivePlan of archivePlans) {
        publishArchiveArtifact(archivePlan, projectDir);
      }
    } catch (err) {
      const recoverable = restoreArchiveArtifacts(archivePlans)
        && cleanupArchiveStaging(archivePlans)
        && cleanupWatermarkStaging(staging)
        && cleanupCreatedOutputDirs(staging.createdOutputDirs);
      if (!recoverable) {
        throw new AssetProcessingError(
          'Standalone archives changed the filesystem but could not be safely recovered.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw err;
    }

    let databaseResult;
    try {
      databaseResult = assetRepository.applyAssetWatermarks(
        projectId,
        buildArchiveArtifactChanges(archivePlans),
      );
      if (!databaseResult
        || !Array.isArray(databaseResult.replaced)
        || databaseResult.replaced.length !== 0
        || !Array.isArray(databaseResult.outputs)
        || databaseResult.outputs.length !== 0
        || !Array.isArray(databaseResult.deleted)
        || databaseResult.deleted.length !== 0
        || !Array.isArray(databaseResult.artifactReplaced)
        || !Array.isArray(databaseResult.artifactOutputs)
        || databaseResult.artifactReplaced.length + databaseResult.artifactOutputs.length !== archivePlans.length) {
        throw new Error('Generated artifact repository returned an unexpected result.');
      }
    } catch (err) {
      const recoverable = restoreArchiveArtifacts(archivePlans)
        && cleanupArchiveStaging(archivePlans)
        && cleanupWatermarkStaging(staging)
        && cleanupCreatedOutputDirs(staging.createdOutputDirs);
      if (!recoverable) {
        throw new AssetProcessingError(
          'Standalone archives were written but could not be restored after an index failure.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw new AssetProcessingError(
        'Standalone archives were removed because CreatorCrate could not update the artifact index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      );
    }

    const artifactsClean = cleanupArchiveStaging(archivePlans);
    const stagingClean = cleanupWatermarkStaging(staging);
    if (!artifactsClean || !stagingClean) {
      throw new AssetProcessingError(
        'Standalone archive records were updated, but filesystem cleanup requires recovery.',
        { code: 'RECOVERY_REQUIRED' },
      );
    }
    progress.finish();

    let artifactReplacedIndex = 0;
    let artifactOutputIndex = 0;
    const artifacts = archivePlans.map((plan) => (
      plan.artifact
        ? databaseResult.artifactReplaced[artifactReplacedIndex++]
        : databaseResult.artifactOutputs[artifactOutputIndex++]
    ));
    return {
      status: 'completed',
      operation: 'archives',
      requestedCount: assetIds.length,
      sourceCount: sources.length,
      generatedCount: artifacts.length,
      changedCount: artifacts.length,
      unchangedCount: 0,
      generatedPaths: artifacts.map((artifact) => artifact.relative_path),
      artifacts: artifacts.map((artifact, index) => ({
        id: artifact.id,
        kind: artifact.kind,
        relativePath: artifact.relative_path,
        format: archivePlans[index].format,
        containerFormat: archivePlans[index].containerFormat,
        quality: archivePlans[index].quality,
        entryCount: archivePlans[index].entries.length,
        sizeBytes: artifact.size_bytes,
        sha256: artifact.sha256,
        status: 'written',
      })),
      sources: sources.map((source) => ({
        assetId: source.asset.id,
        relativePath: source.sourceRelativePath,
        entryPaths: archivePlans.map((plan) => ({
          kind: plan.kind,
          relativePath: plan.entries.find((entry) => entry.source.asset.id === source.asset.id)?.name || null,
        })),
      })),
    };
  }

  async function createArchives(projectId, assetIds, rawOptions, onProgress, coordinationToken) {
    if (!isPositiveSafeInteger(projectId)) {
      throw new AssetProcessingError('projectId must be a positive integer.', { code: 'INVALID_PROJECT_ID' });
    }
    if (!Array.isArray(assetIds)) {
      throw new AssetProcessingError('assetIds must be an array.', { code: 'INVALID_ASSET_SELECTION' });
    }
    if (assetIds.length === 0) {
      throw new AssetProcessingError('No assets selected.', { code: 'NO_ASSETS_SELECTED' });
    }
    const seen = new Set();
    for (const assetId of assetIds) {
      if (!isPositiveSafeInteger(assetId)) {
        throw new AssetProcessingError(
          'assetIds must contain only positive integer IDs.',
          { code: 'INVALID_ASSET_SELECTION' },
        );
      }
      if (seen.has(assetId)) {
        throw new AssetProcessingError('Duplicate asset IDs in selection.', {
          code: 'DUPLICATE_ASSET_SELECTION',
        });
      }
      seen.add(assetId);
    }

    let options;
    try {
      options = normalizeArchiveOptions(rawOptions);
    } catch (err) {
      throw new AssetProcessingError(err.message, {
        code: err.code || 'INVALID_ARCHIVE_OPTIONS',
        cause: err,
      });
    }

    const execute = async () => observeRecovery({
      operation: 'archive', projectId, assetCount: assetIds.length, onProgress,
    }, () => createArchivesLocked(projectId, assetIds, options, onProgress));
    if (coordinationToken !== undefined) {
      assertAlreadyCoordinatedCapability(coordinationToken);
      return execute();
    }

    try {
      return await projectOperationCoordinator.runAsync(projectId, execute);
    } catch (err) {
      if (err instanceof ProjectOperationError
        && err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
        throw new AssetProcessingError(
          `An operation is already in progress for project ${projectId}. Try again shortly.`,
          { code: 'PROJECT_BUSY', cause: err },
        );
      }
      throw err;
    }
  }


  function createPromptStaging(projectDir) {
    let directory;
    try {
      directory = fs.mkdtempSync(path.join(projectDir, '.creatorcrate-workflow-prompts-'));
      const stats = fs.lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Invalid prompt staging directory.');
    } catch (err) {
      if (directory) {
        try { fs.rmdirSync(directory); } catch { /* best effort */ }
      }
      throw new AssetProcessingError('CreatorCrate could not prepare prompt editing staging.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
    return { directory, items: [] };
  }

  function inspectPromptFile(absPath, code) {
    let stats;
    try {
      stats = fs.lstatSync(absPath);
    } catch (err) {
      throw new AssetProcessingError('Prompt file is missing.', { code, cause: err });
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new AssetProcessingError('Prompt path is not a regular file.', { code });
    }
    return stats;
  }

  function cleanupPromptStaging(staging) {
    function cleanupArtifact(itemPath, identity) {
      if (!itemPath) return true;
      if (identity) return removeFileIfIdentityMatches(itemPath, identity);
      try {
        fs.lstatSync(itemPath);
        return false;
      } catch (err) {
        return err.code === 'ENOENT';
      }
    }

    let clean = true;
    for (const item of staging.items) {
      if (!cleanupArtifact(item.stagePath, item.stageIdentity)) {
        clean = false;
      }
      if (!cleanupArtifact(item.backupPath, item.backupIdentity)) {
        clean = false;
      }
    }

    try {
      fs.rmdirSync(staging.directory);
    } catch (err) {
      if (err.code !== 'ENOENT') clean = false;
    }
    return clean;
  }

  function stagePromptOutput(item, staging, index) {
    const stagePath = path.join(staging.directory, `${index}.png`);
    item.stagePath = stagePath;
    try {
      fs.writeFileSync(stagePath, item.editedBuffer, {
        flag: 'wx',
        mode: item.sourceStats.mode & 0o7777,
      });
      fs.chmodSync(stagePath, item.sourceStats.mode & 0o7777);
      const stageStats = inspectPromptFile(stagePath, 'PROMPT_STAGE_INVALID');
      item.stageIdentity = { dev: stageStats.dev, ino: stageStats.ino };
      parsePngChunks(fs.readFileSync(stagePath));
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      if (err instanceof WorkflowPromptMetadataError) {
        throw new AssetProcessingError('CreatorCrate produced an invalid staged PNG.', {
          code: 'PROMPT_STAGE_INVALID',
          cause: err,
        });
      }
      throw new AssetProcessingError('CreatorCrate could not stage a prompt edit.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
  }

  function stagePromptBackup(item, staging, index) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during prompt edit preflight.', {
        code: 'SOURCE_CHANGED',
      });
    }

    const backupPath = path.join(staging.directory, `${index}.original`);
    item.backupPath = backupPath;
    try {
      fs.linkSync(item.sourceAbsPath, backupPath);
      const backupStats = inspectPromptFile(backupPath, 'RECOVERY_REQUIRED');
      if (!sameIdentity(backupStats, item.sourceIdentity)) {
        throw new Error('Prompt backup identity mismatch.');
      }
      item.backupIdentity = { dev: backupStats.dev, ino: backupStats.ino };
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      throw new AssetProcessingError('CreatorCrate could not stage a prompt backup.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
  }

  function publishPromptOutput(item) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during prompt editing.', {
        code: 'SOURCE_CHANGED',
      });
    }

    try {
      fs.unlinkSync(item.sourceAbsPath);
      item.sourceRemoved = true;
    } catch (err) {
      throw new AssetProcessingError('CreatorCrate could not replace a prompt source.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    try {
      fs.linkSync(item.stagePath, item.sourceAbsPath);
      item.replacementPublished = true;
      const outputStats = inspectPromptFile(item.sourceAbsPath, 'RECOVERY_REQUIRED');
      if (!sameIdentity(outputStats, item.stageIdentity)) {
        throw new AssetProcessingError('Prompt output identity could not be verified.', {
          code: 'RECOVERY_REQUIRED',
        });
      }
      item.outputIdentity = { dev: outputStats.dev, ino: outputStats.ino };
      item.outputStats = outputStats;
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      if (err.code === 'EEXIST') {
        throw new AssetProcessingError('A prompt source destination appeared during processing.', {
          code: 'SOURCE_CHANGED',
          cause: err,
        });
      }
      throw new AssetProcessingError('CreatorCrate could not publish a prompt edit.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    try {
      fs.unlinkSync(item.stagePath);
      item.stagePath = null;
    } catch (err) {
      throw new AssetProcessingError('Prompt output staging cleanup failed.', {
        code: 'RECOVERY_REQUIRED',
        cause: err,
      });
    }
  }

  function restorePromptReplacements(items) {
    let restored = true;
    for (const item of [...items].reverse()) {
      if (!item.sourceRemoved && !item.replacementPublished) continue;

      let current;
      try {
        current = fs.lstatSync(item.sourceAbsPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          restored = false;
          continue;
        }
      }

      if (current) {
        if (current.isSymbolicLink() || !current.isFile()) {
          restored = false;
          continue;
        }
        if (sameIdentity(current, item.sourceIdentity)) {
          continue;
        }
        if (!item.outputIdentity || !sameIdentity(current, item.outputIdentity)) {
          // Never overwrite a file whose identity is not one of ours.
          restored = false;
          continue;
        }
        try {
          fs.unlinkSync(item.sourceAbsPath);
        } catch {
          restored = false;
          continue;
        }
      }

      try {
        try {
          fs.lstatSync(item.sourceAbsPath);
          restored = false;
          continue;
        } catch (err) {
          if (err.code !== 'ENOENT') {
            restored = false;
            continue;
          }
        }

        const backupStats = inspectPromptFile(item.backupPath, 'RECOVERY_REQUIRED');
        if (!sameIdentity(backupStats, item.backupIdentity)) {
          restored = false;
          continue;
        }
        fs.linkSync(item.backupPath, item.sourceAbsPath);
        const restoredStats = inspectSource(item.sourceAbsPath);
        if (!sameIdentity(restoredStats, item.sourceIdentity)) {
          restored = false;
          continue;
        }
        item.sourceRemoved = false;
        item.replacementPublished = false;
      } catch {
        restored = false;
      }
    }
    return restored;
  }

  function wrapPromptMetadataError(err) {
    if (err instanceof AssetProcessingError) return err;
    if (err instanceof WorkflowPromptMetadataError) {
      return new AssetProcessingError(err.message, { code: err.code, cause: err });
    }
    return new AssetProcessingError('CreatorCrate could not read prompt metadata.', {
      code: 'PROMPT_METADATA_READ_FAILED',
      cause: err,
    });
  }

  async function editWorkflowPromptsLocked(projectId, assetIds, options, progress) {
    const project = requireMutableProject(projectId);
    const projectDir = resolveProjectAbsPath(project);
    const items = [];
    const unchangedAssetIds = [];
    const noWorkflowAssetIds = [];
    const noChangeAssetIds = [];
    const sourcePaths = new Map();

    for (const assetId of assetIds) {
      const asset = assetRepository.findById(assetId);
      if (!asset || asset.project_id !== projectId) {
        throw new AssetProcessingError(`Asset ${assetId} not found.`, { code: 'ASSET_NOT_FOUND' });
      }
      if (!isPresent(asset)) {
        throw new AssetProcessingError(`Asset ${assetId} is marked missing.`, { code: 'ASSET_MISSING' });
      }
      if (typeof asset.relative_path !== 'string') {
        throw new AssetProcessingError('The selected asset path is unsafe.', {
          code: 'SOURCE_PATH_UNSAFE',
        });
      }

      const sourceRelativePath = normalizeRelativePath(asset.relative_path);
      const sourceFilename = path.posix.basename(sourceRelativePath);
      if (deriveExtensionFromFilename(sourceFilename) !== 'png') {
        throw new AssetProcessingError('The selected asset is not a PNG.', {
          code: 'UNSUPPORTED_SOURCE_TYPE',
        });
      }

      const sourceAbsPath = resolveContained(
        projectDir,
        sourceRelativePath,
        'SOURCE_PATH_UNSAFE',
        'Source',
      );
      const sourceStats = inspectSource(sourceAbsPath);
      const sourceKey = pathKey(sourceAbsPath);
      if (sourcePaths.has(sourceKey)) {
        throw new AssetProcessingError('Two selected assets resolve to the same source path.', {
          code: 'INTRA_BATCH_COLLISION',
        });
      }
      sourcePaths.set(sourceKey, assetId);

      let sourceBuffer;
      try {
        sourceBuffer = fs.readFileSync(sourceAbsPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new AssetProcessingError('Source file does not exist.', { code: 'SOURCE_MISSING' });
        }
        throw new AssetProcessingError('Source file cannot be read.', {
          code: 'SOURCE_PATH_UNSAFE',
          cause: err,
        });
      }

      let edited;
      try {
        edited = editWorkflowPromptsInPng(sourceBuffer, options);
      } catch (err) {
        throw wrapPromptMetadataError(err);
      }

      if (!edited.changed) {
        unchangedAssetIds.push(assetId);
        if (edited.metadataKey) noChangeAssetIds.push(assetId);
        else noWorkflowAssetIds.push(assetId);
        progress.advance();
        continue;
      }

      const afterReadStats = inspectSource(sourceAbsPath);
      if (!sameIdentity(afterReadStats, { dev: sourceStats.dev, ino: sourceStats.ino })) {
        throw new AssetProcessingError('A selected source changed during prompt edit preflight.', {
          code: 'SOURCE_CHANGED',
        });
      }

      items.push({
        asset,
        assetId,
        sourceRelativePath,
        sourceAbsPath,
        sourceIdentity: { dev: sourceStats.dev, ino: sourceStats.ino },
        sourceStats: afterReadStats,
        editedBuffer: edited.buffer,
        sourceRemoved: false,
        replacementPublished: false,
      });
    }

    if (items.length === 0) {
      return {
        status: 'completed',
        operation: 'editWorkflowPrompts',
        requestedCount: assetIds.length,
        changedCount: 0,
        unchangedCount: unchangedAssetIds.length,
        changedAssetIds: [],
        unchangedAssetIds,
        noWorkflowAssetIds,
        noChangeAssetIds,
        rejectedAssetIds: [],
        assets: [],
      };
    }

    const staging = createPromptStaging(projectDir);
    staging.items = items;

    try {
      for (let index = 0; index < items.length; index++) {
        stagePromptOutput(items[index], staging, index);
        progress.advance();
      }
      for (let index = 0; index < items.length; index++) {
        stagePromptBackup(items[index], staging, index);
      }
      for (const item of items) {
        publishPromptOutput(item);
      }
    } catch (err) {
      const restored = restorePromptReplacements(items);
      const stagingClean = cleanupPromptStaging(staging);
      if (!restored || !stagingClean) {
        throw new AssetProcessingError(
          'Prompt editing changed the filesystem but could not safely restore it. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw err;
    }

    let databaseResult;
    try {
      databaseResult = assetRepository.applyAssetPromptEdits(projectId, items.map((item) => ({
        assetId: item.assetId,
        expectedRelativePath: item.sourceRelativePath,
        expectedSizeBytes: item.asset.size_bytes,
        expectedModifiedAt: item.asset.modified_at,
        sizeBytes: item.outputStats.size,
        modifiedAt: item.outputStats.mtime.toISOString(),
      })));
      if (!Array.isArray(databaseResult) || databaseResult.length !== items.length) {
        throw new Error('Asset prompt edit repository returned an unexpected result.');
      }
    } catch (err) {
      const restored = restorePromptReplacements(items);
      const stagingClean = cleanupPromptStaging(staging);
      if (!restored || !stagingClean) {
        throw new AssetProcessingError(
          'Prompt edits were written but CreatorCrate could not safely restore the filesystem after an index failure. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
      }
      throw new AssetProcessingError(
        'Prompt edits were removed because CreatorCrate could not update the asset index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      );
    }

    if (!cleanupPromptStaging(staging)) {
      throw new AssetProcessingError(
        'Asset records were updated, but CreatorCrate could not safely finish prompt-edit cleanup. Inspect the project folder before scanning.',
        { code: 'RECOVERY_REQUIRED' },
      );
    }

    return {
      status: 'completed',
      operation: 'editWorkflowPrompts',
      requestedCount: assetIds.length,
      changedCount: items.length,
      unchangedCount: unchangedAssetIds.length,
      changedAssetIds: items.map((item) => item.assetId),
      unchangedAssetIds,
      noWorkflowAssetIds,
      noChangeAssetIds,
      rejectedAssetIds: [],
      assets: databaseResult,
    };
  }

  async function editWorkflowPrompts(projectId, assetIds, rawOptions, onProgress, coordinationToken) {
    if (!isPositiveSafeInteger(projectId)) {
      throw new AssetProcessingError('projectId must be a positive integer.', { code: 'INVALID_PROJECT_ID' });
    }
    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      throw new AssetProcessingError('No assets selected.', { code: 'NO_ASSETS_SELECTED' });
    }

    const seen = new Set();
    for (const assetId of assetIds) {
      if (!isPositiveSafeInteger(assetId)) {
        throw new AssetProcessingError(
          'assetIds must contain only positive integer IDs.',
          { code: 'INVALID_ASSET_SELECTION' },
        );
      }
      if (seen.has(assetId)) {
        throw new AssetProcessingError('Duplicate asset IDs in selection.', {
          code: 'DUPLICATE_ASSET_SELECTION',
        });
      }
      seen.add(assetId);
    }

    let options;
    try {
      options = normalizeOrUsePromptEditOptions(rawOptions);
    } catch (err) {
      throw wrapPromptMetadataError(err);
    }

    const execute = async () => {
      const progress = createProgressReporter(assetIds.length, onProgress);
      const result = await observeRecovery({
        operation: 'workflow-prompt', projectId, assetCount: assetIds.length, onProgress,
      }, () => editWorkflowPromptsLocked(projectId, assetIds, options, progress));
      progress.finish();
      return result;
    };
    if (coordinationToken !== undefined) {
      assertAlreadyCoordinatedCapability(coordinationToken);
      return execute();
    }

    try {
      return await projectOperationCoordinator.runAsync(projectId, execute);
    } catch (err) {
      if (err instanceof ProjectOperationError
        && err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
        throw new AssetProcessingError(
          `An operation is already in progress for project ${projectId}. Try again shortly.`,
          { code: 'PROJECT_BUSY', cause: err },
        );
      }
      throw err;
    }
  }


  return {
    convertAssets,
    convertSelectedAssets: convertAssets,
    watermarkAssets,
    watermarkSelectedAssets: watermarkAssets,
    createArchives,
    createArchiveAssets: createArchives,
    editWorkflowPrompts,
    editSelectedWorkflowPrompts: editWorkflowPrompts,
    createAlreadyCoordinatedExecutor,
  };
}
