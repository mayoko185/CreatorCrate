import fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { decode as decodeBmp, encode as encodeBmp } from '@nktkas/bmp';
import { resolveContainedAssetPath } from '../storage/asset-file.js';
import { createProjectDirectoryOwnershipVerifier, isKnownDirectoryIdentity } from './project-directory-ownership.js';
import { deriveExtensionFromFilename, mimeFromExtension } from './asset-metadata.js';
import { ProjectOperationError } from './project-operation-coordinator.js';
import { classifyAssetPath } from './asset-path-classification.js';
import { isProjectArchived } from './project-state.js';
import { inspectSourceAnimation } from './source-animation.js';
import {
  formatGeneratedOutputProvenance,
  isDurableBirthtimeNs,
  isOwnedWatermarkDestination as isOwnedWatermarkDestinationShared,
  parseGeneratedOutputProvenance,
  resolveTrustedWatermarkFile,
} from './asset-processing-shared.js';
import {
  copyTrustedFileToOwnedFile,
  createOwnedFile,
  matchesOwnedIdentity,
  OWNED_FILE_FAILURE,
  OwnedFileError,
  ownedFileSourceChangeEvidence,
  pathMatchesExactIdentity,
  removeFileIfExactIdentityMatches,
  sameExactFileIdentity,
} from './owned-file.js';
import {
  hashRegularFileInProject,
  ownedPathContentFailure,
  ownedPathContentSnapshot,
  ownedPathContinuityFailure,
  TRACE_STAT_FIELDS,
  traceStats,
  tracedPathMatchesExactIdentity,
} from './owned-path-content.js';
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
import {
  AssetProcessingError,
  CONVERSION_FORMATS,
  CONVERSION_QUALITY_DEFAULT,
  CONVERSION_QUALITY_MAX,
  CONVERSION_QUALITY_MIN,
  deriveConversionOutputPlan,
  isSupportedConversionSource,
  normalizeConversionOptions,
  normalizeRelativePath,
  ORIGINAL_HANDLINGS,
  pathKey,
  WATERMARK_SOURCE_IMAGE_EXTENSIONS,
} from './asset-processing-contracts.js';
export {
  AssetProcessingError,
  CONVERSION_FORMATS,
  CONVERSION_QUALITY_DEFAULT,
  CONVERSION_QUALITY_MAX,
  CONVERSION_QUALITY_MIN,
  deriveConversionOutputPlan,
  isSupportedConversionSource,
  normalizeConversionOptions,
  normalizeRelativePath,
  ORIGINAL_HANDLINGS,
  pathKey,
  WATERMARK_SOURCE_IMAGE_EXTENSIONS,
} from './asset-processing-contracts.js';

const LOSSY_FORMATS = new Set(['webp', 'jpg', 'jpeg']);
export const WATERMARK_GENERATED_BY = 'watermark';

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const NATIVE_BIRTHTIME_PLATFORMS = new Set(['win32', 'darwin', 'freebsd']);

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

// Recovery diagnostic summaries (pure; entries are recorded inside the service below).
const RECOVERY_DIAGNOSTIC_FIELDS = Object.freeze([
  'assetId', 'itemIndex', 'artifactRole', 'check', 'proof', 'pathState', 'identity',
  'expected', 'observed', 'referenceIdentity', 'publicationMode', 'errorCode', 'cleanup',
]);
// Sized to the application logger's 100 context-entry budget, where every object key and
// array element counts one. The recovery log context has 12 top-level keys (operation,
// assetCount, phase, recoveryPhase, restored, cleanupSucceeded, failures and five counts)
// and a selected entry costs 1 + at most 13 fields: floor((100 - 12) / 14) = 6, so six
// fully populated entries and every count persist untruncated (96 of 100).
export const RECOVERY_DIAGNOSTIC_LIMIT = 6;

const isCleanupDiagnostic = (entry) => entry.check?.startsWith('cleanup-') === true;
// Restoration, ownership and proof failures: neither a cleanup failure nor a record of an
// artifact deliberately retained as recovery evidence.
const isRestorationDiagnostic = (entry) => !isCleanupDiagnostic(entry)
  && entry.check?.startsWith('retained-') !== true;

// Deterministic bounded selection in priority passes, each stopping at the cap:
//  1. the first cleanup failure (it explains cleanupSucceeded: false);
//  2. the first restoration/ownership/proof failure;
//  3. the first cleanup failure of each further artifact role;
//  4. the first entry of each further role/check pair;
//  5. remaining entries in recorded order.
// Selected entries keep their recorded order, so twenty identical output rollback failures
// cannot hide the one staged-original cleanup failure, nor the reverse.
function selectRecoveryDiagnostics(entries) {
  if (entries.length <= RECOVERY_DIAGNOSTIC_LIMIT) return entries.slice();
  const picked = new Set();
  const pickFirst = (predicate) => {
    const index = entries.findIndex((entry, i) => !picked.has(i) && predicate(entry));
    if (index >= 0 && picked.size < RECOVERY_DIAGNOSTIC_LIMIT) picked.add(index);
  };
  const pickDistinct = (keyOf, predicate = () => true) => {
    const kinds = new Set([...picked].filter((i) => predicate(entries[i])).map((i) => keyOf(entries[i])));
    entries.forEach((entry, index) => {
      if (picked.size >= RECOVERY_DIAGNOSTIC_LIMIT || picked.has(index) || !predicate(entry)) return;
      const kind = keyOf(entry);
      if (kinds.has(kind)) return;
      kinds.add(kind);
      picked.add(index);
    });
  };
  pickFirst(isCleanupDiagnostic);
  pickFirst(isRestorationDiagnostic);
  pickDistinct((entry) => entry.artifactRole, isCleanupDiagnostic);
  pickDistinct((entry) => `${entry.artifactRole}/${entry.check}`);
  for (let index = 0; index < entries.length && picked.size < RECOVERY_DIAGNOSTIC_LIMIT; index++) {
    picked.add(index);
  }
  return [...picked].sort((left, right) => left - right).map((index) => entries[index]);
}

// diagnosticCount = recorded entries; failedCleanupCount = failed cleanup attempts (one
// artifact may fail in publication and again in rollback); strictProofFailureCount = entries
// naming a failed strict proof; contentVerifiedCount = items whose publication was only
// content-verified; retainedRecoveryCriticalCount = distinct recovery-critical artifacts
// (asset, item index, role), however many attempts recorded each.
export function summarizeRecoveryDiagnostics(phase, entries = [], items = [], outcome = {}) {
  const retainedArtifacts = new Set(entries
    .filter((entry) => entry.cleanup === 'recovery-critical')
    .map((entry) => JSON.stringify([entry.assetId, entry.itemIndex, entry.artifactRole])));
  return {
    phase,
    ...(typeof outcome.restored === 'boolean' ? { restored: outcome.restored } : {}),
    ...(typeof outcome.cleanupSucceeded === 'boolean' ? { cleanupSucceeded: outcome.cleanupSucceeded } : {}),
    failures: selectRecoveryDiagnostics(entries),
    diagnosticCount: entries.length,
    failedCleanupCount: entries.filter(isCleanupDiagnostic).length,
    strictProofFailureCount: entries.filter((entry) => entry.proof !== undefined).length,
    contentVerifiedCount: items.filter((item) => item.outputVerification?.mode === 'content-verified').length,
    retainedRecoveryCriticalCount: retainedArtifacts.size,
  };
}

// The persisted recovery log context; its shape is what RECOVERY_DIAGNOSTIC_LIMIT is sized to.
export function recoveryLogContext({ operation, assetCount, phase }, error) {
  return { operation, assetCount, phase, ...recoveryContext(error) };
}

function recoveryContext(error) {
  const d = error?.recoveryDiagnostics;
  if (!d || typeof d !== 'object') return {};
  const context = {
    recoveryPhase: d.phase,
    restored: d.restored,
    cleanupSucceeded: d.cleanupSucceeded,
    failures: Array.isArray(d.failures)
      ? d.failures.slice(0, RECOVERY_DIAGNOSTIC_LIMIT).map((f) => Object.fromEntries(
        RECOVERY_DIAGNOSTIC_FIELDS
          .filter((key) => f?.[key] !== undefined && f?.[key] !== null)
          .map((key) => [key, f[key]]),
      ))
      : [],
  };
  for (const key of ['diagnosticCount', 'failedCleanupCount', 'strictProofFailureCount',
    'contentVerifiedCount', 'retainedRecoveryCriticalCount']) {
    if (Number.isSafeInteger(d[key])) context[key] = d[key];
  }
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
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
  projectDirectoryOwnershipRepository,
  processingRecoveryEvidenceRecorder = null,
  processingRecoveryEvidenceRepository = null,
  applicationLogger = null,
  platform = process.platform,
} = {}) {
  // Where libuv may report ctime as birth time when no creation time is available
  // (Linux without statx btime, and similar), a birth time equal to the current ctime could
  // be that mirror. Windows, macOS and FreeBSD always report a native creation time.
  const birthtimeMayMirrorCtime = !NATIVE_BIRTHTIME_PLATFORMS.has(platform);
  if (!projectRepository || typeof projectRepository.findById !== 'function') {
    throw new Error('createAssetProcessingService requires a projectRepository dependency.');
  }
  if (!projectDirectoryOwnershipRepository) {
    throw new Error('createAssetProcessingService requires a projectDirectoryOwnershipRepository dependency.');
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
  // Durable recovery evidence (processing-recovery-evidence-recorder.js). The app always
  // wires the recorder, and the repository it writes through, over the shared connection.
  // Both stay optional here only for operations that record no evidence yet: an operation
  // that does (Workflow Prompt) refuses to run without them. The repository is used only
  // for what the recorder leaves to its caller: reading a group's rows, recording what an
  // existing check observed, and deleting rows/groups once cleanup is positively proven.
  if (processingRecoveryEvidenceRecorder !== null
    && (typeof processingRecoveryEvidenceRecorder.startMutationGroup !== 'function'
      || typeof processingRecoveryEvidenceRecorder.runInTransaction !== 'function')) {
    throw new Error('createAssetProcessingService processingRecoveryEvidenceRecorder is invalid.');
  }
  if (processingRecoveryEvidenceRepository !== null
    && ['listEvidenceByMutationGroup', 'setEvidenceObservation', 'deleteEvidence', 'deleteMutationGroup']
      .some((method) => typeof processingRecoveryEvidenceRepository[method] !== 'function')) {
    throw new Error('createAssetProcessingService processingRecoveryEvidenceRepository is invalid.');
  }
  const ownershipVerifier = createProjectDirectoryOwnershipVerifier({
    ownershipRepository: projectDirectoryOwnershipRepository,
    projectsRoot,
  });

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

  const PROCESSING_RECOVERY_SUCCEEDED = Object.freeze({
    level: 'warn', name: 'processing.recovery.succeeded', phase: 'rollback', message: 'Processing rollback completed.',
  });
  const PROCESSING_RECOVERY_FAILED = Object.freeze({
    level: 'error', name: 'processing.recovery.failed', phase: 'recovery', message: 'Processing recovery failed.',
  });
  // Committed work whose dispensable private copies could not all be removed.
  const PROCESSING_CLEANUP_RESIDUE = Object.freeze({
    level: 'warn', name: 'processing.cleanup.residue', phase: 'cleanup', message: 'Processing cleanup left private residue.',
  });
  // Decision-time evidence for an archive pre-commit validation failure (WP4 SMB diagnostics).
  const PROCESSING_ARCHIVE_VALIDATION_FAILED = Object.freeze({
    level: 'warn', name: 'processing.archive.validation.failed', message: 'Archive validation failed before it was recorded.',
  });
  // Decision-time evidence for a Watermark output publication or pre-commit validation
  // failure (WP1 diagnostics): the copy-source observations of a source-changed publication,
  // or the validation trace of a pre-commit check. See watermarkPrecommitFailureContext and
  // watermarkPublicationFailureContext.
  const PROCESSING_WATERMARK_VALIDATION_FAILED = Object.freeze({
    level: 'warn', name: 'processing.watermark.validation.failed',
    message: 'Watermark output validation failed before it was recorded.',
  });

  function logValidationFailure(event, { operation, projectId, assetCount, onProgress }, failure) {
    try {
      applicationLogger?.warn?.({
        subsystem: 'processing',
        event: event.name,
        level: event.level,
        kind: 'diagnostic',
        message: event.message,
        projectId,
        ...(typeof onProgress?.jobId === 'string' ? { correlationId: onProgress.jobId } : {}),
        context: { operation, assetCount, ...failure },
      });
    } catch {
      // Diagnostic persistence must not alter recovery or rollback behavior.
    }
  }

  function logProcessingDiagnostic(event, { operation, projectId, assetCount, onProgress }, carrier) {
    try {
      applicationLogger?.[event.level]?.({
        subsystem: 'processing',
        event: event.name,
        level: event.level,
        kind: 'diagnostic',
        message: event.message,
        projectId,
        ...(typeof onProgress?.jobId === 'string' ? { correlationId: onProgress.jobId } : {}),
        context: recoveryLogContext({ operation, assetCount, phase: event.phase }, carrier),
      });
    } catch {
      // Diagnostic persistence must not alter recovery or rollback behavior.
    }
  }

  async function observeRecovery(observed, execute) {
    try {
      return await execute();
    } catch (error) {
      const archiveFailure = archiveValidationFailureOf(error);
      if (archiveFailure) logValidationFailure(PROCESSING_ARCHIVE_VALIDATION_FAILED, observed, archiveFailure);
      const watermarkFailure = watermarkValidationFailureOf(error);
      if (watermarkFailure) logValidationFailure(PROCESSING_WATERMARK_VALIDATION_FAILED, observed, watermarkFailure);
      // A verified rollback that still carries recovery evidence (Prompt and Watermark attach
      // it to an ordinary failure) is logged like a database rollback.
      const event = error?.code === 'RECOVERY_REQUIRED'
        ? PROCESSING_RECOVERY_FAILED
        : error?.code === 'DATABASE_OPERATION_FAILED' || error?.recoveryDiagnostics
          ? PROCESSING_RECOVERY_SUCCEEDED
          : null;
      if (event) logProcessingDiagnostic(event, observed, error);
      throw error;
    }
  }

  function requireMutableProject(projectId) {
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new AssetProcessingError(`Project ${projectId} not found.`, { code: 'PROJECT_NOT_FOUND' });
    }
    if (isProjectArchived(project)) {
      throw new AssetProcessingError(
        `Project ${projectId} is archived and cannot be modified.`,
        { code: 'PROJECT_ARCHIVED' },
      );
    }
    return project;
  }

  /**
   * Shared project preflight for every processing execution (conversion and
   * reencoding, watermarking, archive generation, workflow/prompt edits).
   * Each execution calls this exactly once, under its project lock, before
   * inspecting, staging, publishing, replacing, moving to Originals, or
   * deleting anything; the one verification covers that whole execution.
   * A plan made earlier is never a witness: every execution verifies anew.
   *
   * @returns {string} the verified project root
   * @throws {import('./project-directory-ownership.js').ProjectOwnershipError}
   */
  function resolveProjectAbsPath(project) {
    if (!project.project_dir) {
      throw new AssetProcessingError('Project has no stored directory path.', {
        code: 'PROJECT_DIRECTORY_UNSAFE',
      });
    }
    return ownershipVerifier.verifyProject(project).absPath;
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

  // Filesystem ownership contract (every unlink, overwrite, restore or cleanup obeys it):
  //  - OWNED exact identity: a known bigint {dev, ino} captured from the descriptor of a file
  //    CreatorCrate created itself exclusively. Only fields holding such an identity
  //    (`*ExactIdentity`, `*RecoveryIdentity`) may authorize destructive actions.
  //  - EXACT CONTINUITY: the live path still has that owned exact identity. It never creates
  //    ownership; it only re-proves it immediately before acting.
  //  - CONTENT-VERIFIED: bytes (plus size/link-count observations) match. Never ownership,
  //    and such a result carries no exact identity that could later be mistaken for one.
  //  - UNKNOWN (zero/unsafe IDs, CIFS): never authorizes a destructive action.
  //  - CROSS-RUN: an existing generated output (a later run's destination) is owned only
  //    when its current exact identity equals the durable provenance persisted when
  //    CreatorCrate published it under strict proof. A generated row plus a matching hash
  //    proves expected bytes (eligibility), never that the pathname is still our object.
  //  - FULL PROVENANCE TUPLE: a persisted generated output's owned identity is
  //    {dev, ino, birthtimeNs}. Every continuity check against it also requires that exact,
  //    nonzero birth time, so a reused (dev, ino) never passes; birth time alone never proves
  //    ownership. A zero birth time is no discriminator: such a tuple is never persisted and
  //    a legacy one never proves ownership.
  //  - DESCRIPTOR-OWNED PUBLICATION (Watermark, Prompt, archives and Conversion): every public
  //    output, backup, Originals copy, staged original and restored file is its own
  //    exclusively created file whose ownership is the exact identity of the descriptor that
  //    created it. A stage or source is only trusted content input; its identity is never
  //    compared with, or adopted by, the copy. Conversion persists no provenance. A Watermark output's or archive's durable provenance comes from its own creating
  //    descriptor (durableDescriptorBirthtimeNs), else it is null.
  // Rounded Number dev/ino and hash/size/link counts are observations only.

  // Recovery diagnostics: internal, bounded evidence for RECOVERY_REQUIRED logs. Entries
  // never carry a path, file bytes, prompt text or an Error object. Exact dev/ino appear only
  // as decimal "dev:ino" strings (bigint-safe) so a divergent SMB alias is visible. Every
  // observation here is read-only, runs after the decision it describes, and never feeds an
  // ownership, cleanup or recovery decision; a diagnostic fault is swallowed.
  function diagnosticFileId(identity) {
    if (!isKnownDirectoryIdentity(identity)) return undefined;
    return `${identity.dev}:${identity.ino}`;
  }

  // pathState plus the exact identity comparison against `expectedIdentity`:
  // matched | mismatched | birthtime-mismatch | expected-unknown | observed-unknown | unknown.
  function observeDiagnosticArtifact(absPath, expectedIdentity) {
    const expected = diagnosticFileId(expectedIdentity);
    const observation = expected ? { expected } : {};
    if (!absPath) return { ...observation, pathState: 'absent' };
    let stats;
    try {
      stats = fs.lstatSync(absPath, { bigint: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return { ...observation, pathState: 'absent' };
      return {
        ...observation,
        pathState: 'inspection-failed',
        ...(typeof err?.code === 'string' ? { errorCode: err.code } : {}),
      };
    }
    const observedIdentity = !stats.isSymbolicLink() && stats.isFile()
      ? { dev: stats.dev, ino: stats.ino } : null;
    const observed = diagnosticFileId(observedIdentity);
    let identity;
    if (!expected) identity = observed ? 'expected-unknown' : 'unknown';
    else if (!observed) identity = 'observed-unknown';
    else if (!sameExactFileIdentity(observedIdentity, expectedIdentity)) identity = 'mismatched';
    else if ('birthtimeNs' in expectedIdentity && !matchesOwnedIdentity(stats, expectedIdentity)) {
      identity = 'birthtime-mismatch';
    } else identity = 'matched';
    return { ...observation, pathState: 'present', identity, ...(observed ? { observed } : {}) };
  }

  // The same observation for a diagnostic whose errorCode belongs to the initiating failure: a
  // later inspection of the path only describes it (pathState 'inspection-failed' when it
  // cannot be read), and its own error code never stands in for, or replaces, that evidence.
  function observeDiagnosticPath(absPath, expectedIdentity) {
    const { errorCode, ...observation } = observeDiagnosticArtifact(absPath, expectedIdentity);
    return observation;
  }

  function recordRecoveryDiagnostic(entries, build) {
    if (!Array.isArray(entries)) return;
    try {
      const entry = build();
      if (!entry) return;
      const safe = {};
      for (const key of RECOVERY_DIAGNOSTIC_FIELDS) {
        if (entry[key] !== undefined && entry[key] !== null) safe[key] = entry[key];
      }
      entries.push(safe);
    } catch {
      // Diagnostics must not alter recovery or rollback behavior.
    }
  }

  function stagingDiagnostics(staging) {
    if (!staging) return undefined;
    if (!Array.isArray(staging.recoveryDiagnostics)) staging.recoveryDiagnostics = [];
    return staging.recoveryDiagnostics;
  }

  // Diagnostic entry for a stage-owned artifact that cleanup left in place. The check names
  // the step removeFileIfExactIdentityMatches recorded as failing; the later observation only
  // describes the path now and never decides which step failed.
  const CLEANUP_FAILED_STEP_CHECKS = Object.freeze({
    inspection: 'cleanup-inspection-failed',
    unlink: 'cleanup-unlink-failed',
  });
  function cleanupFailureDiagnostic(base, absPath, exactIdentity, outcome, uncheckedExpected) {
    const observation = observeDiagnosticArtifact(absPath, exactIdentity ?? uncheckedExpected);
    const check = CLEANUP_FAILED_STEP_CHECKS[outcome?.failedStep]
      ?? (isKnownDirectoryIdentity(exactIdentity) ? 'cleanup-identity-mismatch' : 'cleanup-ownership-unproven');
    return {
      ...base,
      check,
      ...observation,
      ...(outcome?.errorCode ? { errorCode: outcome.errorCode } : {}),
      cleanup: 'recovery-critical',
    };
  }

  // Numeric file IDs can lose precision; ownership decisions need exact IDs.
  function exactFileIdentity(absPath) {
    const stats = fs.lstatSync(absPath, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    return { dev: stats.dev, ino: stats.ino };
  }

  // Directory policy: CreatorCrate never removes a directory. Node offers no create-and-open
  // primitive for directories (mkdir/mkdtemp return only a pathname), so any identity read
  // after a successful create is a pathname observation: another writer may already have
  // replaced the new directory, and a later exact match would only prove that replacement's
  // continuity. Output directories, `Originals` and the fixed staging workspaces are
  // therefore used (after validation) but never claimed, and are retained after success or
  // failure. Retained directories are bounded: each is a fixed path per project or per
  // configured output, and every private stage artifact inside a workspace is still created
  // and removed only under descriptor-rooted exact file ownership.

  // A directory component is usable only when it is an actual directory: a symlink, Windows
  // junction (reported by lstat as a symbolic link) or non-directory is never traversed.
  function assertDirectoryComponent(absPath, code, message) {
    let stats;
    try {
      stats = fs.lstatSync(absPath);
    } catch (err) {
      throw new AssetProcessingError(message, { code, cause: err });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AssetProcessingError(message, { code });
    }
  }

  // Creates each missing component of a directory beneath the verified project root with a
  // non-recursive mkdir. Every component (pre-existing, just created, or raced in and
  // reported as EEXIST) is revalidated before anything is created beneath it, and the path is
  // checked with the established containment helper first. Nothing is claimed as owned.
  function createDirectoryPath(projectDir, targetAbsPath, code, message) {
    const relative = path.relative(projectDir, targetAbsPath);
    // The verified project root itself needs nothing created.
    if (relative === '') return;
    resolveContained(projectDir, relative, code, 'Output directory');
    let current = projectDir;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        fs.mkdirSync(current);
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw new AssetProcessingError(message, { code: 'FILESYSTEM_OPERATION_FAILED', cause: err });
        }
      }
      assertDirectoryComponent(current, code, message);
    }
  }

  // Immediately before a publication writes into its final target, re-establish with the
  // established containment helper that no ancestor became a symlink/junction since
  // preflight, and that the target's parent is still an actual directory.
  function revalidatePublicationTarget(projectDir, absPath, code, label) {
    const resolved = resolveContained(projectDir, path.relative(projectDir, absPath), code, label);
    if (pathKey(resolved) !== pathKey(absPath)) {
      throw new AssetProcessingError(`${label} path is unsafe.`, { code });
    }
    assertDirectoryComponent(path.dirname(absPath), code, `${label} path is unsafe.`);
  }

  // Private staging workspace: a fixed, retained directory per operation kind (see the
  // directory policy above). Each operation names its stage artifacts with a fresh random
  // token, so residue retained by an earlier run never collides with a later one.
  function createStagingDirectory(projectDir, name, message) {
    const directory = path.join(projectDir, name);
    try {
      try {
        fs.mkdirSync(directory);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      assertDirectoryComponent(directory, 'FILESYSTEM_OPERATION_FAILED', message);
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      throw new AssetProcessingError(message, { code: 'FILESYSTEM_OPERATION_FAILED', cause: err });
    }
    return { directory, token: randomBytes(8).toString('hex') };
  }

  function stagingFile(staging, name) {
    return path.join(staging.directory, `${staging.token}.${name}`);
  }

  // Cleanup outcome for one private, descriptor-rooted stage artifact. Aggregating cleanup
  // helpers return true unless some outcome is recoveryCritical: they answer "must the user
  // repair project state before processing continues?", not "did every path disappear?".
  // Every copy is descriptor-owned, so dispensable leftovers are classified as residue.
  //  - clean: absent, or removed under exact ownership;
  //  - residue: no owned exact identity was ever recorded. Ownership is recorded before any
  //    byte is written and every publication requires it, so CreatorCrate never wrote or
  //    published this path; whatever is there is safe residue and is left untouched;
  //  - recoveryCritical: an owned stage could not be removed (it may be the evidence of a
  //    publication), which keeps the conservative recovery classification.
  const STAGE_CLEANUP = Object.freeze({ clean: 'clean', residue: 'residue', recoveryCritical: 'recoveryCritical' });
  function cleanupPrivateStage(stagePath, exactIdentity, outcome) {
    if (!stagePath) return STAGE_CLEANUP.clean;
    if (!isKnownDirectoryIdentity(exactIdentity)) return STAGE_CLEANUP.residue;
    return removeFileIfExactIdentityMatches(stagePath, exactIdentity, outcome)
      ? STAGE_CLEANUP.clean
      : STAGE_CLEANUP.recoveryCritical;
  }

  // Presence only (never ownership): an uninspectable path counts as present.
  function pathIsAbsent(absPath) {
    try {
      fs.lstatSync(absPath);
      return false;
    } catch (err) {
      return err?.code === 'ENOENT';
    }
  }

  // Exclusively creates a private stage file through createOwnedFile, which roots its owned
  // exact identity in the descriptor CreatorCrate opened with 'wx', never in a later
  // pathname stat. `onOwned` receives that identity before any write, so error cleanup can
  // remove the stage only while the pathname still is this file. After close the pathname
  // must still be the owned file; a replacement is never claimed. Returns the owned identity
  // plus the birth time read from the descriptor after writing (a durable-provenance
  // candidate only). Stage failures keep their established errors.
  async function writeOwnedStageFile(stagePath, write, { mode, onCreated, onOwned } = {}) {
    let owned;
    try {
      owned = await createOwnedFile(stagePath, write, { mode, onCreated, onOwned });
    } catch (err) {
      if (!(err instanceof OwnedFileError)) throw err;
      if (err.reason === OWNED_FILE_FAILURE.identityUnknown) {
        throw new AssetProcessingError('CreatorCrate could not prove ownership of a private stage.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
        });
      }
      if (err.reason === OWNED_FILE_FAILURE.pathnameChanged) {
        throw new AssetProcessingError('A private processing stage changed before it could be verified.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
        });
      }
      throw new Error('Stage descriptor identity changed.', { cause: err });
    }
    return { identity: owned.exactIdentity, birthtimeNs: owned.birthtimeNs };
  }

  function writeBytesToDescriptor(descriptor, bytes) {
    return new Promise((resolve, reject) => {
      fs.writeFile(descriptor, bytes, (err) => (err ? reject(err) : resolve()));
    });
  }

  // Cross-run ownership: the persisted full provenance tuple of an existing generated
  // output, only while the current object continues it exactly. That tuple (never a
  // reduced {dev, ino}) is what every later destructive boundary re-proves. Absent,
  // malformed, zero-birth-time or unmatched provenance never proves ownership.
  function provenOwnedOutputIdentity(absPath, provenance) {
    const recorded = parseGeneratedOutputProvenance(provenance);
    if (!recorded || !isDurableBirthtimeNs(recorded.birthtimeNs)) return null;
    return pathMatchesExactIdentity(absPath, recorded) ? recorded : null;
  }

  // The birth time a descriptor-created file reported (createOwnedFile) is a durable
  // anti-reuse discriminator only when it is nonzero and, where libuv may mirror ctime,
  // differs from the ctime read by that same descriptor stat. Otherwise null: the file is
  // still owned within this run by its exact {dev, ino}, but no cross-run provenance exists.
  function durableDescriptorBirthtimeNs(owned) {
    if (!isDurableBirthtimeNs(owned?.birthtimeNs)) return null;
    if (birthtimeMayMirrorCtime && owned.ctimeNs === owned.birthtimeNs) return null;
    return owned.birthtimeNs;
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

  // Final pre-commit validation of every Watermark publication; runs immediately before the
  // index transaction, with no asynchronous step in between. Each public output must still be
  // the exact descriptor-created object (its full tuple when its birth time is durable) and
  // hold the published bytes under a post-hash write fingerprint (ownedPathContentSnapshot),
  // and the owned backup of a replaced destination must still be valid recovery material
  // until the commit no longer needs it. The committed provenance is derived only from the
  // public output's own creating descriptor.
  function revalidateWatermarkPublications(items, archivePlans, projectDir) {
    const fingerprints = new Map();
    for (const item of items) {
      item.outputProvenance = null;
      const { failure: outputFailure, fingerprint } = ownedPathContentSnapshot(projectDir, item.outputAbsPath,
        watermarkOutputIdentity(item), { size: item.outputSize, sha256: item.outputSha256 }, item.validationTrace);
      fingerprints.set(item, fingerprint);
      if (outputFailure) {
        recordRecoveryDiagnostic(stagingDiagnostics(item.staging), () => ({
          assetId: item.asset?.id,
          itemIndex: item.stageIndex,
          artifactRole: 'published-output',
          check: `precommit-${outputFailure}`,
          publicationMode: watermarkPublicationMode(item),
          ...observeDiagnosticArtifact(item.outputAbsPath, watermarkOutputIdentity(item)),
        }));
        const error = new AssetProcessingError(outputFailure === 'unreadable'
          ? 'The watermark output could not be read before it was recorded.'
          : 'The watermark output changed before it could be recorded.', {
          code: outputFailure === 'unreadable' ? 'FILESYSTEM_OPERATION_FAILED' : 'OUTPUT_DESTINATION_CONFLICT',
        });
        noteWatermarkValidationFailure(error, () => watermarkPrecommitFailureContext(item, `precommit-${outputFailure}`, 1));
        throw error;
      }
      if (item.destinationRemoved) assertWatermarkBackupValid(item, projectDir, 'precommit');
      item.outputProvenance = item.outputBirthtimeNs === null || item.outputBirthtimeNs === undefined
        ? null
        : formatGeneratedOutputProvenance({ ...item.outputExactIdentity, birthtimeNs: item.outputBirthtimeNs });
    }
    revalidateArchivePublications(archivePlans, projectDir);
    assertWatermarkOutputsUnchanged(items, fingerprints);
  }

  // Final sweep, after every pre-commit read: an output proven before a later hash (another
  // output, a backup, an archive) may have been displaced, or rewritten in place under the
  // same identity, during it. Each public output must still be its exact descriptor-created
  // object with the write fingerprint its committed hash was verified under; no content is
  // read here, so no fallible read separates this sweep from the index transaction. A
  // mismatch is never adopted and a changed output is never recorded.
  function assertWatermarkOutputsUnchanged(items, fingerprints) {
    let owned = true;
    const changed = [];
    for (const item of items) {
      const change = ownedPathContinuityFailure(item.outputAbsPath, watermarkOutputIdentity(item),
        fingerprints.get(item), item.validationTrace);
      if (!change) continue;
      owned = false;
      changed.push({ item, check: `precommit-final-${OWNED_PATH_FAILURE_CHECKS[change]}` });
      recordRecoveryDiagnostic(stagingDiagnostics(item.staging), () => ({
        assetId: item.asset?.id,
        itemIndex: item.stageIndex,
        artifactRole: 'published-output',
        check: `precommit-final-${OWNED_PATH_FAILURE_CHECKS[change]}`,
        publicationMode: watermarkPublicationMode(item),
        ...observeDiagnosticArtifact(item.outputAbsPath, watermarkOutputIdentity(item)),
      }));
    }
    if (!owned) {
      const error = new AssetProcessingError('The watermark output changed before it could be recorded.', {
        code: 'OUTPUT_DESTINATION_CONFLICT',
      });
      noteWatermarkValidationFailure(error, () => watermarkPrecommitFailureContext(changed[0].item, changed[0].check,
        changed.length));
      throw error;
    }
  }

  // Rollback may unlink a published Prompt destination only while the pathname is still the
  // exact file the publication created through its own exclusive descriptor
  // (outputRecoveryIdentity). A stage-identity or content match never proves it.
  function promptOutputMatchesPublication(item) {
    if (!item.replacementPublished) return false;
    return pathMatchesExactIdentity(item.sourceAbsPath, item.outputRecoveryIdentity);
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

  function createWatermarkStaging(projectDir) {
    const workspace = createStagingDirectory(
      projectDir,
      '.creatorcrate-watermark-staging',
      'CreatorCrate could not prepare watermark staging.',
    );
    return { ...workspace, items: [], artifacts: [] };
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
      // Set only from durable provenance below: the current path's identity is never trusted.
      plan.destinationExactIdentity = null;
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
      // The row and hash prove only expected bytes. Replacement unlinks the destination, so
      // it must be exactly the object CreatorCrate published (persisted provenance).
      plan.destinationExactIdentity = provenOwnedOutputIdentity(plan.outputAbsPath, plan.artifact.output_provenance);
      if (!plan.destinationExactIdentity) {
        throw new AssetProcessingError(`The existing ${archiveLabel} is not provably the file CreatorCrate published.`, {
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
    const stageOutput = stagingFile(staging, `archive-${index}.${plan.format}`);
    plan.stageOutput = stageOutput;
    plan.stageIndex = index;
    plan.staging = staging;
    try {
      const entries = await processingConcurrencyService.mapBounded(plan.entries, async (entry) => {
        const rendered = await renderEntry(entry, plan);
        const buffer = Buffer.isBuffer(rendered) ? rendered : rendered?.buffer;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          throw new Error('Archive renderer returned invalid bytes.');
        }
        return { name: entry.name, buffer };
      });
      // Owned exact identity comes from the exclusive descriptor. The stage is the content
      // input of publication only: its identity never stands for the public archive.
      const stage = await plan.recoveryGroup.createArtifact({
        intent: archiveIntent(plan, 'archive-stage', stageOutput),
        create: ({ onCreated, onOwned }) => writeOwnedStageFile(
          stageOutput,
          (descriptor) => writeArchiveFile(stageOutput, plan.format, entries, { descriptor }),
          { onCreated, onOwned: (identity) => { plan.stageOutputExactIdentity = identity; onOwned(identity); } },
        ),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(stageOutput, identity),
      });
      const stats = inspectGeneratedFile(stageOutput, 'ARCHIVE_OUTPUT_INVALID');
      if (stats.size <= 0) throw new Error('Generated archive is empty.');
      plan.outputStats = stats;
      plan.sha256 = hashRegularFileInProject(projectDir, stageOutput);
      plan.recoveryGroup.recordContentProof(stage.evidenceId, {
        expectedSize: stats.size, expectedSha256: plan.sha256,
      });
    } catch (err) {
      // Ownership only ever comes from the exclusive descriptor; whatever is at the
      // pathname after a failure is never promoted to an owned stage.
      if (['RECOVERY_EVIDENCE_PERSISTENCE_FAILED', 'RECOVERY_REQUIRED'].includes(err?.code)) throw err;
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

  // Archive plan state (every archive artifact is descriptor-owned; see the ownership contract):
  //  - outputPublication: unset until the public archive's creating descriptor exposes its
  //    exact identity (outputExactIdentity), then 'created'; rollback removes it only while
  //    the pathname is still that exact object. outputCreateUnclaimed: the exclusive create of
  //    the public path succeeded (outputCreateStarted) but its descriptor never proved a known
  //    identity (zero/unknown IDs, or its first fstat failed), so it can never be removed.
  //  - destinationRemoved: an existing indexed archive was unlinked after its owned backup copy
  //    (destinationBackupExactIdentity) was verified; rollback restores it as a new file
  //    (destinationRestoredIdentity), whose artifact provenance must then be reconciled
  //    (provenanceReconcilePending).
  // The stage is trusted content input only; its identity never stands for the public archive.
  // Shared by standalone Archive and by Watermark archive/CBZ generation.
  function archivePublicationMode(plan) {
    return plan.outputExactIdentity ? 'descriptor-owned' : undefined;
  }

  // The public archive's owned identity: its creating descriptor's exact {dev, ino}, plus that
  // descriptor's birth time when it is a durable discriminator (the tuple then committed as
  // provenance). Rollback within the run needs only the exact {dev, ino}.
  function archiveOutputIdentity(plan) {
    if (!plan.outputExactIdentity) return null;
    return plan.outputBirthtimeNs === null || plan.outputBirthtimeNs === undefined
      ? plan.outputExactIdentity
      : { ...plan.outputExactIdentity, birthtimeNs: plan.outputBirthtimeNs };
  }

  function archiveOutputContent(plan) {
    return { size: plan.outputStats.size, sha256: plan.sha256 };
  }

  function archiveDestinationContent(plan) {
    return { size: plan.destinationStats.size, sha256: plan.artifact.sha256.toLowerCase() };
  }

  function archiveDiagnostic(plan, artifactRole, check) {
    return { itemIndex: plan.stageIndex, artifactRole, check };
  }

  // The owned backup of a replaced archive must still be its exact descriptor-created object
  // and hold the archive's recorded bytes: ownership and content are both required, and
  // neither ever authorizes anything about the archive destination itself.
  // Returns the write fingerprint the backup's bytes were verified under.
  function assertArchiveBackupValid(plan, projectDir, stage) {
    const { failure, fingerprint } = !plan.destinationBackupComplete
      ? { failure: 'identity' }
      : ownedPathContentSnapshot(projectDir, plan.destinationBackupPath, plan.destinationBackupExactIdentity,
        archiveDestinationContent(plan));
    if (!failure) return fingerprint;
    failArchiveBackup(plan, `${stage}-backup-${OWNED_PATH_FAILURE_CHECKS[failure]}`);
  }

  function failArchiveBackup(plan, check) {
    recordRecoveryDiagnostic(stagingDiagnostics(plan.staging), () => ({
      ...archiveDiagnostic(plan, 'archive-backup', check),
      ...observeDiagnosticArtifact(plan.destinationBackupPath, plan.destinationBackupExactIdentity),
    }));
    throw new AssetProcessingError('The archive destination backup changed during processing.', {
      code: 'FILESYSTEM_OPERATION_FAILED',
    });
  }

  // Replacing an existing indexed archive. Destructive authority over the archive is its
  // persisted durable provenance (the full tuple proven at preflight) plus its recorded bytes,
  // re-proven immediately before the unlink; independently, a complete owned backup copy (its
  // own descriptor identity, expected to differ from the archive's) must hold those bytes. The
  // backup's identity never authorizes anything about the archive, nor its hash.
  async function prepareArchiveDestinationReplacement(plan, projectDir) {
    const diagnostics = stagingDiagnostics(plan.staging);
    const conflict = (message, cause) => new AssetProcessingError(message, {
      code: 'ARCHIVE_DESTINATION_CONFLICT', ...(cause ? { cause } : {}),
    });
    const destinationContent = archiveDestinationContent(plan);
    // Returns the write fingerprint the destination's bytes were verified under.
    const verifyDestination = () => {
      const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, plan.outputAbsPath,
        plan.destinationExactIdentity, destinationContent);
      if (failure === 'identity') throw conflict('The archive destination changed during processing.');
      if (failure) throw conflict('The archive destination is no longer owned by CreatorCrate.');
      return fingerprint;
    };
    verifyDestination();

    const backupPath = stagingFile(plan.staging, `archive-${plan.stageIndex}.destination`);
    plan.destinationBackupPath = backupPath;
    try {
      await plan.recoveryGroup.createArtifact({
        intent: archiveIntent(plan, 'destination-backup', backupPath, destinationContent),
        create: ({ onCreated, onOwned }) => copyTrustedFileToOwnedFile({
          sourcePath: plan.outputAbsPath,
          sourceExactIdentity: { dev: plan.destinationExactIdentity.dev, ino: plan.destinationExactIdentity.ino },
          destinationPath: backupPath,
          expectedSha256: destinationContent.sha256,
          expectedSize: destinationContent.size,
          mode: plan.destinationStats.mode & 0o7777,
          onCreated,
          onOwned: (identity) => { plan.destinationBackupExactIdentity = identity; onOwned(identity); },
        }),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(backupPath, identity),
      });
      plan.destinationBackupComplete = true;
    } catch (err) {
      // An owned partial backup is removed later only by its exact identity; an EEXIST
      // collision or an identity-unknown create is never claimed.
      recordRecoveryDiagnostic(diagnostics, () => ({
        ...archiveDiagnostic(plan, 'archive-backup', 'backup-create-failed'),
        ...ownedFileFailureEvidence(err),
        ...observeDiagnosticPath(backupPath, plan.destinationBackupExactIdentity),
      }));
      if (err instanceof AssetProcessingError) throw err;
      if (err instanceof OwnedFileError && (err.reason === OWNED_FILE_FAILURE.sourceChanged
        || err.reason === OWNED_FILE_FAILURE.sourceUnsafe)) {
        throw conflict('The archive destination changed during processing.', err);
      }
      throw new AssetProcessingError('CreatorCrate could not back up an existing archive.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    return () => {
      // Both authorities, re-proven immediately before the destructive step. Each content read
      // is followed by a fresh proof of the other object: the backup (identity, bytes, identity)
      // again after the destination read, which it could have been rewritten in place or
      // displaced during; then a metadata-only sweep of BOTH, which proves the destination is
      // still its owned object with the write fingerprint its bytes were verified under (it
      // could have been rewritten in place, same identity, during that final backup read) and
      // the backup likewise. No content read separates these final proofs from the unlink.
      assertArchiveBackupValid(plan, projectDir, 'replace');
      const destinationFingerprint = verifyDestination();
      const backupFingerprint = assertArchiveBackupValid(plan, projectDir, 'replace-final');
      const destinationChange = ownedPathContinuityFailure(plan.outputAbsPath, plan.destinationExactIdentity,
        destinationFingerprint);
      if (destinationChange) {
        recordRecoveryDiagnostic(diagnostics, () => ({
          ...archiveDiagnostic(plan, 'archive-destination',
            `replace-final-destination-${OWNED_PATH_FAILURE_CHECKS[destinationChange]}`),
          ...observeDiagnosticArtifact(plan.outputAbsPath, plan.destinationExactIdentity),
        }));
        throw conflict('The archive destination changed during processing.');
      }
      const backupChange = ownedPathContinuityFailure(plan.destinationBackupPath, plan.destinationBackupExactIdentity,
        backupFingerprint);
      if (backupChange) failArchiveBackup(plan, `replace-final-backup-${OWNED_PATH_FAILURE_CHECKS[backupChange]}`);
      try {
        fs.unlinkSync(plan.outputAbsPath);
      } catch (err) {
        // Unless the pathname still holds the owned archive, it no longer does: rollback must
        // then restore it (a foreign occupant is never removed and leaves it unresolved).
        if (!pathMatchesExactIdentity(plan.outputAbsPath, plan.destinationExactIdentity)) plan.destinationRemoved = true;
        throw new AssetProcessingError('CreatorCrate could not replace an existing archive.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
      plan.destinationRemoved = true;
    };
  }

  // The public archive is created exclusively at its final pathname and filled from the
  // validated stage (trusted content input only). Its ownership is its own descriptor
  // identity, recorded before any byte is written; the stage identity is never adopted and no
  // hard link is made. EEXIST never overwrites or adopts what appeared.
  async function publishArchiveArtifact(plan, projectDir) {
    plan.outputProvenance = null;
    plan.validationTrace = [];
    revalidatePublicationTarget(projectDir, plan.outputAbsPath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
    const current = inspectOptionalDestination(plan.outputAbsPath);
    if (plan.destinationStats && !current) {
      throw new AssetProcessingError('The archive destination changed during processing.', { code: 'ARCHIVE_DESTINATION_CONFLICT' });
    }
    if (!plan.destinationStats && current) {
      throw new AssetProcessingError('An archive destination appeared during processing.', { code: 'ARCHIVE_DESTINATION_CONFLICT' });
    }
    const removeDestination = current ? await prepareArchiveDestinationReplacement(plan, projectDir) : null;

    try {
      revalidatePublicationTarget(projectDir, plan.outputAbsPath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
      const content = archiveOutputContent(plan);
      const publication = await plan.recoveryGroup.createArtifact({
        intent: archiveIntent(plan, 'published-archive', plan.outputAbsPath, content),
        checkpoint: removeDestination ? 'replace' : 'public-create',
        create: async ({ onCreated, onOwned }) => {
          try {
            for (const row of archiveEvidenceRows(plan)) {
              if (ARCHIVE_PRIVATE_ROLES.includes(row.artifactRole)) plan.recoveryGroup.markRecoveryCritical(
                row.evidenceId, { retentionReason: ARCHIVE_RETENTION.pending },
              );
            }
          } catch (err) {
            plan.evidenceWithheld = true;
            throw err;
          }
          removeDestination?.();
          return copyTrustedFileToOwnedFile({
            sourcePath: plan.stageOutput,
            sourceExactIdentity: plan.stageOutputExactIdentity,
            destinationPath: plan.outputAbsPath,
            expectedSha256: content.sha256,
            expectedSize: content.size,
            onCreated: () => { plan.outputCreateStarted = true; onCreated(); },
            onOwned: (identity) => {
              plan.outputExactIdentity = identity;
              plan.outputPublication = 'created';
              onOwned(identity);
            },
          });
        },
        discardOwned: (identity) => removeFileIfExactIdentityMatches(plan.outputAbsPath, identity),
      });
      const owned = publication.value;
      plan.outputBirthtimeNs = durableDescriptorBirthtimeNs(owned);
      // The creating descriptor's final stat (dev/ino, birth time, ctime) and hashed size.
      traceStats(plan.validationTrace, 'public-descriptor-final', {
        ...owned.exactIdentity, size: owned.content?.size, birthtimeNs: owned.birthtimeNs, ctimeNs: owned.ctimeNs,
      });
      if (!tracedPathMatchesExactIdentity(plan.outputAbsPath, archiveOutputIdentity(plan), plan.validationTrace,
        'public-post-close')) {
        throw new OwnedFileError(OWNED_FILE_FAILURE.pathnameChanged, 'The published archive changed.');
      }
    } catch (err) {
      // The exclusive create succeeded but its descriptor never proved ownership (unknown IDs,
      // or the first inspection itself failed): a public path exists that is not ours to
      // adopt or remove. A failed open never gets here with outputCreateStarted set.
      if (plan.outputCreateStarted && !plan.outputExactIdentity) plan.outputCreateUnclaimed = true;
      recordRecoveryDiagnostic(stagingDiagnostics(plan.staging), () => ({
        ...archiveDiagnostic(plan, 'published-archive', plan.outputCreateUnclaimed
          ? 'public-archive-identity-inspection-failed' : 'publish-create-failed'),
        publicationMode: archivePublicationMode(plan),
        ...ownedFileFailureEvidence(plan.outputCreateUnclaimed ? err.cause ?? err : err),
        ...observeDiagnosticPath(plan.outputAbsPath, plan.outputExactIdentity),
        // The created public path stays unresolved: never residue, never removed here.
        ...(plan.outputCreateUnclaimed ? { cleanup: 'recovery-critical' } : {}),
      }));
      if (err instanceof AssetProcessingError) throw err;
      if (err?.code === 'EEXIST') {
        throw new AssetProcessingError('An archive destination appeared during processing.', {
          code: 'ARCHIVE_DESTINATION_CONFLICT',
          cause: err,
        });
      }
      throw new AssetProcessingError('CreatorCrate could not publish an archive.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
  }

  // Final pre-commit validation of every archive publication; runs immediately before the
  // index transaction, with no asynchronous step in between. Each public archive must still be
  // its exact descriptor-created object (its full tuple when its birth time is durable) and
  // hold the published bytes, and the owned backup of a replaced archive must still be valid
  // recovery material. The committed provenance is derived only from the public archive's own
  // creating descriptor, never from its stage, its backup or a later pathname stat.
  function revalidateArchivePublications(plans, projectDir) {
    const fingerprints = new Map();
    for (const plan of plans) {
      plan.outputProvenance = null;
      const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, plan.outputAbsPath,
        archiveOutputIdentity(plan), archiveOutputContent(plan), plan.validationTrace);
      fingerprints.set(plan, fingerprint);
      if (failure) {
        recordRecoveryDiagnostic(stagingDiagnostics(plan.staging), () => ({
          ...archiveDiagnostic(plan, 'published-archive', `precommit-${failure}`),
          publicationMode: archivePublicationMode(plan),
          ...observeDiagnosticArtifact(plan.outputAbsPath, archiveOutputIdentity(plan)),
        }));
        const error = new AssetProcessingError(failure === 'unreadable'
          ? 'The archive could not be read before it was recorded.'
          : 'The archive changed before it could be recorded.', {
          code: failure === 'unreadable' ? 'FILESYSTEM_OPERATION_FAILED' : 'ARCHIVE_DESTINATION_CONFLICT',
        });
        noteArchiveValidationFailure(error, plan, `precommit-${failure}`, 1);
        throw error;
      }
      if (plan.destinationRemoved) assertArchiveBackupValid(plan, projectDir, 'precommit');
      plan.outputProvenance = plan.outputBirthtimeNs === null || plan.outputBirthtimeNs === undefined
        ? null
        : formatGeneratedOutputProvenance({ ...plan.outputExactIdentity, birthtimeNs: plan.outputBirthtimeNs });
    }
    assertArchiveOutputsUnchanged(plans, fingerprints);
  }

  // Final sweep, after every archive validation read: an archive proven before a later hash
  // (another archive, a backup) may have been displaced, or rewritten in place under the same
  // identity, during it. Each public archive must still be its exact descriptor-created object
  // with the write fingerprint its committed hash was verified under; no content is read here,
  // so no fallible read separates this sweep from the index transaction. A mismatch is never
  // adopted and a changed archive is never recorded.
  function assertArchiveOutputsUnchanged(plans, fingerprints) {
    let owned = true;
    const changed = [];
    for (const plan of plans) {
      const change = ownedPathContinuityFailure(plan.outputAbsPath, archiveOutputIdentity(plan),
        fingerprints.get(plan), plan.validationTrace);
      if (!change) continue;
      owned = false;
      changed.push({ plan, check: `precommit-final-${OWNED_PATH_FAILURE_CHECKS[change]}` });
      recordRecoveryDiagnostic(stagingDiagnostics(plan.staging), () => ({
        ...archiveDiagnostic(plan, 'published-archive', `precommit-final-${OWNED_PATH_FAILURE_CHECKS[change]}`),
        publicationMode: archivePublicationMode(plan),
        ...observeDiagnosticArtifact(plan.outputAbsPath, archiveOutputIdentity(plan)),
      }));
    }
    if (!owned) {
      const error = new AssetProcessingError('The archive changed before it could be recorded.', {
        code: 'ARCHIVE_DESTINATION_CONFLICT',
      });
      noteArchiveValidationFailure(error, changed[0].plan, changed[0].check, changed.length);
      throw error;
    }
  }

  // Compact, logger-budget-safe evidence for the FIRST archive whose pre-commit validation
  // failed, built only from the values its decision read (plan.validationTrace), keyed by the
  // thrown error and logged once as processing.archive.validation.failed. Sized to the
  // application logger's 100-entry context budget (every key and array element counts one):
  // with operation/assetCount, about 25 top-level entries plus at most 9 phases of at most 7
  // fields (a matched identity is omitted; the size check and descriptor stat carry fewer), ~84
  // in all with a re-hash and a final sweep; verified through the real logger.
  // hashMatch: true | false | 'not-evaluated' (an earlier step decided, or the hash helper
  // rejected on its own continuity check: subcheck hash-identity-/hash-size-mismatch) |
  // 'read-failed' (the helper's open/stat/read itself threw).
  const archiveValidationFailures = new WeakMap();

  function noteArchiveValidationFailure(error, plan, check, failedArchiveCount) {
    try {
      archiveValidationFailures.set(error, archiveValidationFailureContext(plan, check, failedArchiveCount));
    } catch {
      // Diagnostics must not alter validation.
    }
  }

  function archiveValidationFailureOf(error) {
    return archiveValidationFailures.get(error)
      ?? (error?.cause && typeof error.cause === 'object' ? archiveValidationFailures.get(error.cause) : undefined);
  }

  // WP1 Watermark diagnostics: compact evidence for the FIRST Watermark output whose
  // publication failed on a source-changed copy or whose pre-commit validation failed, keyed
  // by the error that reports it and logged once as processing.watermark.validation.failed.
  // A publication failure is keyed by the primitive's OwnedFileError, which rollback may wrap
  // (cause) once or twice. Same logger budget as the archive event: the pre-commit form is
  // the archive context plus rehash/settling; the publication form carries the copy source's
  // own evidence (ownedFileSourceChangeEvidence, at most ~60 entries).
  const watermarkValidationFailures = new WeakMap();

  function noteWatermarkValidationFailure(error, build) {
    if (!error || typeof error !== 'object' || watermarkValidationFailures.has(error)) return;
    try {
      const context = build();
      if (context) watermarkValidationFailures.set(error, context);
    } catch {
      // Diagnostics must not alter validation.
    }
  }

  function watermarkValidationFailureOf(error) {
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
      const context = watermarkValidationFailures.get(current);
      if (context) return context;
      current = current.cause;
    }
    return undefined;
  }

  // rehash: whether ownedPathContentSnapshot verified the bytes a second time because the
  // write metadata moved across the first hash (performed | not-needed | not-reached). The
  // re-verification counts as performed once it recorded any step, whether or not it reached
  // its post-rehash fingerprint; it is not-needed only when the post-hash identity held.
  // settling: the outcome of that one settling re-verification: held-after-hash |
  // held-after-rehash (the post-rehash fingerprint became the baseline) | unstable (it moved
  // across the re-hash too) | not-reached (an earlier step, or the re-verification itself, decided).
  // A post-hash phase is recorded before its identity is decided, so it counts as held only
  // when its recorded identity relation is 'matched'.
  function watermarkPrecommitFailureContext(item, check, failedOutputCount) {
    const expected = validationTraceExpected(watermarkOutputIdentity(item), item.outputSize);
    const {
      subcheck, identityMatch, hashMatch, changedFields, compared, firstChangedPhase, errorCode, phases, last,
    } = validationTraceSummary(item.validationTrace, expected);
    const trace = Array.isArray(item.validationTrace) ? item.validationTrace : [];
    const afterHashIndex = trace.findIndex((entry) => entry.phase === 'precommit-after-hash');
    const rehashed = afterHashIndex >= 0
      && trace.slice(afterHashIndex + 1).some((entry) => entry.phase !== 'precommit-final-sweep');
    const identityHeldAt = (phase) => trace.some((entry) => entry.phase === phase && entry.identity === 'matched');
    let settling = 'not-reached';
    if (subcheck === 'fingerprint-changed' && last.phase === 'precommit-after-rehash') settling = 'unstable';
    else if (identityHeldAt('precommit-after-rehash')) settling = 'held-after-rehash';
    else if (!rehashed && identityHeldAt('precommit-after-hash')) settling = 'held-after-hash';
    return {
      assetId: item.asset?.id,
      itemIndex: item.stageIndex,
      check,
      publicationMode: watermarkPublicationMode(item),
      subcheck,
      identityMatch,
      hashMatch,
      rehash: rehashed ? 'performed' : identityHeldAt('precommit-after-hash') ? 'not-needed' : 'not-reached',
      settling,
      changedFields,
      ...(compared ? { compared } : {}),
      ...(firstChangedPhase ? { firstChangedPhase } : {}),
      expected,
      ...(errorCode ? { errorCode } : {}),
      failedOutputCount,
      phases,
    };
  }

  // A source-changed publication: the copy source is the item's private stage output.
  function watermarkPublicationFailureContext(item, check, err) {
    const copySource = ownedFileSourceChangeEvidence(err);
    if (!copySource) return undefined;
    return {
      assetId: item.asset?.id,
      itemIndex: item.stageIndex,
      check,
      proof: err.reason,
      copySourceRole: 'stage-output',
      copySource,
    };
  }

  function archiveValidationFailureContext(plan, check, failedArchiveCount) {
    const expected = validationTraceExpected(archiveOutputIdentity(plan), plan.outputStats?.size);
    const {
      subcheck, identityMatch, hashMatch, changedFields, compared, firstChangedPhase, errorCode, phases,
    } = validationTraceSummary(plan.validationTrace, expected);
    return {
      itemIndex: plan.stageIndex,
      archiveKind: plan.kind,
      ...(plan.containerFormat ? { container: plan.containerFormat } : {}),
      check,
      subcheck,
      identityMatch,
      hashMatch,
      changedFields,
      ...(compared ? { compared } : {}),
      ...(firstChangedPhase ? { firstChangedPhase } : {}),
      expected,
      ...(errorCode ? { errorCode } : {}),
      failedArchiveCount,
      phases,
    };
  }

  // The owned identity and expected size a validation trace is compared against, as decimal strings.
  function validationTraceExpected(expectedIdentity, size) {
    return {
      ...(expectedIdentity ? { dev: String(expectedIdentity.dev), ino: String(expectedIdentity.ino) } : {}),
      ...(expectedIdentity?.birthtimeNs !== undefined ? { birthtimeNs: String(expectedIdentity.birthtimeNs) } : {}),
      ...(size !== undefined && size !== null ? { size: String(size) } : {}),
    };
  }

  // The deciding comparison of a pre-commit validation trace (ownedPathContentSnapshot and
  // ownedPathContinuityFailure record it), shared by the archive and Watermark validation
  // failure events. Reads only the recorded values; never re-reads the path.
  function validationTraceSummary(validationTrace, expected) {
    const trace = Array.isArray(validationTrace) ? validationTrace : [];
    const phases = {};
    let hashMatch = 'not-evaluated';
    let errorCode;
    for (const { phase, hashMatch: matched, ...fields } of trace) {
      if (phase === 'precommit-hash' && fields.hashRejection) {
        // The helper rejected on its own continuity check: no digest was ever compared.
        phases[phase] = { bytesRead: fields.bytesRead };
        continue;
      }
      if (phase === 'precommit-hash') {
        hashMatch = typeof matched === 'boolean' ? matched : 'read-failed';
        continue;
      }
      // A matched identity is the norm; only a failing phase carries its identity relation.
      const { identity, ...values } = fields;
      phases[phase] = identity && identity !== 'matched' ? { ...values, identity } : values;
    }

    // The deciding observation is the last one the validation recorded.
    const last = trace[trace.length - 1] ?? {};
    if (last.errorCode) errorCode = last.errorCode;
    let subcheck;
    let identityMatch = 'matched';
    let compared;
    let changedFields = [];
    const differing = (left, right, keys) => keys.filter((key) => left?.[key] !== undefined
      && right?.[key] !== undefined && left[key] !== right[key]);
    if (last.phase === 'precommit-hash' && last.hashRejection) {
      subcheck = last.hashRejection;
      identityMatch = { 'hash-identity-mismatch': 'dev-ino-mismatch', 'hash-not-regular-file': 'not-regular-file' }[subcheck]
        ?? 'matched';
      if (last.compared) {
        compared = last.compared;
        changedFields = differing(phases[compared[0]], phases[compared[1]],
          subcheck === 'hash-size-mismatch' ? ['size'] : ['dev', 'ino']);
      }
    } else if (last.phase === 'precommit-hash') {
      subcheck = hashMatch === 'read-failed' ? 'hash-read-failed' : 'hash-mismatch';
    } else if (last.phase === 'precommit-size-check') {
      subcheck = last.identity === 'inspection-failed' ? 'size-read-failed' : 'size-mismatch';
      compared = ['expected', last.phase];
      changedFields = differing(expected, last, ['size']);
    } else if (last.identity && last.identity !== 'matched') {
      subcheck = last.identity;
      identityMatch = last.identity;
      compared = ['expected', last.phase];
      changedFields = differing(expected, last, ['dev', 'ino', 'birthtimeNs']);
    } else {
      // Identity held: the write fingerprint {size, mtimeNs, ctimeNs} moved from its post-hash
      // baseline: at the final sweep, from the one the bytes were verified under (after the
      // re-hash when there was one); at the re-hash, from the first post-hash one. The
      // pre-hash observation stays in `phases` but is never the rejected comparison.
      subcheck = 'fingerprint-changed';
      const baseline = last.phase === 'precommit-final-sweep' && phases['precommit-after-rehash']
        ? 'precommit-after-rehash' : 'precommit-after-hash';
      compared = [baseline, last.phase];
      changedFields = differing(phases[baseline], last, ['size', 'mtimeNs', 'ctimeNs']);
    }

    // First phase with a value differing from the latest earlier observation of that field.
    let firstChangedPhase;
    const seen = {};
    for (const entry of trace) {
      // The hash helper's numeric stats round IDs past 2^53: compare them at that precision.
      const earlier = entry.stat === 'number'
        ? { ...seen, ...Object.fromEntries(['dev', 'ino'].filter((key) => seen[key] !== undefined)
          .map((key) => [key, String(Number(seen[key]))])) }
        : seen;
      if (differing(earlier, entry, TRACE_STAT_FIELDS).length > 0) {
        firstChangedPhase = entry.phase;
        break;
      }
      for (const key of TRACE_STAT_FIELDS) if (entry[key] !== undefined) seen[key] = entry[key];
    }

    return { subcheck, identityMatch, hashMatch, changedFields, compared, firstChangedPhase, errorCode, phases, last };
  }

  // Rollback of the public archives, per plan: a created archive is removed only while its
  // pathname is still the exact descriptor-created object (no hash fallback); then a replaced
  // archive returns from its owned backup as a new, exclusively created file with the recorded
  // bytes, mode and times. Its new identity is recorded so the artifact provenance can be
  // reconciled (reconcileRestoredArchiveProvenance). EEXIST never overwrites or adopts.
  async function restoreArchiveArtifacts(plans, projectDir, diagnostics) {
    let restored = true;
    for (const plan of [...plans].reverse()) {
      const fail = (artifactRole, check, details) => {
        restored = false;
        recordRecoveryDiagnostic(diagnostics, () => ({
          ...archiveDiagnostic(plan, artifactRole, check),
          ...(artifactRole === 'published-archive' ? { publicationMode: archivePublicationMode(plan) } : {}),
          ...details(),
        }));
      };

      if (plan.outputPublication === 'created') {
        const removal = {};
        if (!removeFileIfExactIdentityMatches(plan.outputAbsPath, plan.outputExactIdentity, removal)) {
          // A foreign, uninspectable or unremovable archive stays; its stage is kept as evidence.
          plan.outputRestoreFailed = true;
          const check = { ownership: 'rollback-identity-mismatch', inspection: 'rollback-inspect' }[removal.failedStep]
            ?? 'rollback-unlink';
          fail('published-archive', check, () => ({
            ...observeDiagnosticArtifact(plan.outputAbsPath, plan.outputExactIdentity),
            ...(removal.errorCode ? { errorCode: removal.errorCode } : {}),
          }));
          continue;
        }
        plan.outputPublication = 'unlinked';
      } else if (plan.outputCreateUnclaimed) {
        // CreatorCrate created the public path but never learned its identity: whatever is
        // there can never be proven ours, so it stays and the plan is unresolved.
        if (!pathIsAbsent(plan.outputAbsPath)) {
          plan.outputRestoreFailed = true;
          fail('published-archive', 'rollback-ownership-unproven', () => observeDiagnosticArtifact(plan.outputAbsPath));
          continue;
        }
        plan.outputCreateUnclaimed = false;
      }

      if (!plan.destinationRemoved) continue;
      const backupFailure = !plan.destinationBackupComplete
        ? 'identity'
        : ownedPathContentFailure(projectDir, plan.destinationBackupPath, plan.destinationBackupExactIdentity,
          archiveDestinationContent(plan));
      if (backupFailure) {
        fail('archive-backup', `destination-restore-${OWNED_PATH_FAILURE_CHECKS[backupFailure]}`, () => (
          observeDiagnosticArtifact(plan.destinationBackupPath, plan.destinationBackupExactIdentity)
        ));
        continue;
      }
      try {
        revalidatePublicationTarget(projectDir, plan.outputAbsPath, 'ARCHIVE_PATH_UNSAFE', 'Archive');
      } catch (err) {
        fail('restored-archive', 'destination-unsafe', () => ownedFileFailureEvidence(err.cause ?? err));
        continue;
      }
      let restoredIdentity;
      try {
        const destinationContent = archiveDestinationContent(plan);
        const owned = await copyTrustedFileToOwnedFile({
          sourcePath: plan.destinationBackupPath,
          sourceExactIdentity: plan.destinationBackupExactIdentity,
          destinationPath: plan.outputAbsPath,
          expectedSha256: destinationContent.sha256,
          expectedSize: destinationContent.size,
          mode: plan.destinationStats.mode & 0o7777,
          times: { atime: plan.destinationStats.atime, mtime: plan.destinationStats.mtime },
          onOwned: (identity) => { restoredIdentity = identity; },
        });
        const birthtimeNs = durableDescriptorBirthtimeNs(owned);
        plan.destinationRestoredIdentity = birthtimeNs === null
          ? owned.exactIdentity : { ...owned.exactIdentity, birthtimeNs };
        plan.destinationRestoredProvenance = birthtimeNs === null
          ? null : formatGeneratedOutputProvenance({ ...owned.exactIdentity, birthtimeNs });
      } catch (err) {
        fail('restored-archive', 'restore-create-failed', () => ({
          ...observeDiagnosticPath(plan.outputAbsPath, restoredIdentity),
          ...ownedFileFailureEvidence(err),
        }));
        // A partial restore CreatorCrate owns is withdrawn (exact identity only), so no
        // unverified bytes stay at the destination; the backup remains the prior archive.
        if (restoredIdentity) removeFileIfExactIdentityMatches(plan.outputAbsPath, restoredIdentity);
        continue;
      }
      plan.destinationRemoved = false;
      plan.provenanceReconcilePending = true;
    }
    return restored;
  }

  // Identity, then the archive's recorded bytes, then identity again, under a post-hash write
  // fingerprint that held across a hash (ownedPathContentSnapshot): the restored archive is still exactly the file the restore created and
  // was not rewritten in place while (or after) its bytes were hashed. Nothing reads it after
  // the final check.
  function archiveRestoredFailure(plan, projectDir) {
    const { failure } = ownedPathContentSnapshot(projectDir, plan.outputAbsPath, plan.destinationRestoredIdentity,
      archiveDestinationContent(plan));
    return failure ? OWNED_PATH_FAILURE_CHECKS[failure] : null;
  }

  // A replaced archive restored from its backup holds the prior bytes as a NEW file, so the
  // provenance the artifact row still holds (the replaced object's tuple) no longer describes
  // it and would make a later replacement refuse CreatorCrate's own restored archive. The row
  // is rewritten (compare-and-set against the preflight path, hash and provenance) to the
  // restored file's own descriptor-derived tuple, or to null when that birth time is not
  // durable: never to whatever later occupies the path. Immediately before the write each
  // restored archive must still be exactly that file (identity, bytes, identity) and, after
  // every such read, a final metadata sweep must prove each is still that object with the
  // write fingerprint its bytes were verified under (one rewritten in place during a later
  // archive's read is never reconciled). On failure the backups stay.
  function reconcileRestoredArchiveProvenance(projectId, plans, projectDir, diagnostics) {
    const pending = plans.filter((plan) => plan.provenanceReconcilePending);
    if (pending.length === 0) return true;
    const fail = (plan, check) => recordRecoveryDiagnostic(diagnostics, () => ({
      ...archiveDiagnostic(plan, 'restored-archive', check),
      ...observeDiagnosticArtifact(plan.outputAbsPath, plan.destinationRestoredIdentity),
    }));
    let unchanged = true;
    const fingerprints = new Map();
    for (const plan of pending) {
      const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, plan.outputAbsPath,
        plan.destinationRestoredIdentity, archiveDestinationContent(plan));
      if (failure) {
        unchanged = false;
        fail(plan, `provenance-reconcile-${OWNED_PATH_FAILURE_CHECKS[failure]}`);
      }
      fingerprints.set(plan, fingerprint);
    }
    if (!unchanged) return false;
    for (const plan of pending) {
      const change = ownedPathContinuityFailure(plan.outputAbsPath, plan.destinationRestoredIdentity,
        fingerprints.get(plan));
      if (change) {
        unchanged = false;
        fail(plan, `provenance-reconcile-final-${OWNED_PATH_FAILURE_CHECKS[change]}`);
      }
    }
    if (!unchanged) return false;
    try {
      assetRepository.reconcileGeneratedArtifactProvenance(projectId, pending.map((plan) => ({
        artifactId: plan.artifact.id,
        expectedRelativePath: plan.relativePath,
        expectedSha256: plan.artifact.sha256,
        expectedProvenance: plan.artifact.output_provenance ?? null,
        provenance: plan.destinationRestoredProvenance ?? null,
      })));
    } catch (err) {
      for (const plan of pending) {
        recordRecoveryDiagnostic(diagnostics, () => ({
          ...archiveDiagnostic(plan, 'restored-archive', 'provenance-reconcile-failed'),
          ...(typeof err?.code === 'string' ? { errorCode: err.code } : {}),
        }));
      }
      return false;
    }
    for (const plan of pending) plan.provenanceReconcilePending = false;
    return true;
  }

  // Only these private roles may enter a later cleanup whitelist. Public tracking never does.
  const ARCHIVE_PRIVATE_ROLES = ['archive-stage', 'destination-backup'];
  const ARCHIVE_RETENTION = Object.freeze({
    pending: 'archive-publication-pending',
    publicationFailed: 'archive-publication-failed',
    databaseFailed: 'archive-database-failed',
    restorationFailed: 'archive-restoration-failed',
    provenanceFailed: 'archive-provenance-reconciliation-failed',
    publicUnclaimed: 'archive-public-created-unclaimed',
    committed: 'archive-committed',
    rolledBack: 'archive-verified-rollback',
    residue: 'archive-cleanup-residue',
  });

  function archiveEvidenceFailure(err, evidenceStage) {
    if (err?.code === 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED') return err;
    return Object.assign(new AssetProcessingError('Archive recovery evidence could not be settled.', {
      code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', cause: err,
    }), { evidenceStage });
  }

  function startArchiveMutationGroups(projectId, runId, plans, projectDir) {
    try {
      for (const plan of plans) {
        plan.projectDir = projectDir;
        // One public destination is wholly restored independently of the other containers.
        plan.recoveryGroup = processingRecoveryEvidenceRecorder.startMutationGroup({
          projectId, operation: 'archive', runId,
          itemKey: `${plan.kind}:${createHash('sha256').update(normalizeRelativePath(plan.relativePath)).digest('hex')}`,
        });
      }
    } catch (err) {
      deleteEmptyArchiveGroups(plans);
      throw err;
    }
  }

  function archiveEvidenceRows(plan) {
    const { projectId, groupId } = plan.recoveryGroup;
    return processingRecoveryEvidenceRepository.listEvidenceByMutationGroup(projectId, groupId);
  }

  function archiveIntent(plan, role, artifactPath, content = {}) {
    const source = plan.entries.length === 1 ? plan.entries[0].source : null;
    return {
      artifactRole: role, retentionReason: ARCHIVE_RETENTION.pending,
      artifactPath: projectRelativePath(plan.projectDir, artifactPath),
      assetId: source?.asset.id ?? null,
      sourcePath: role === 'destination-backup' ? plan.relativePath : source?.sourceRelativePath ?? null,
      destinationPath: plan.relativePath,
      expectedSize: content.size ?? null, expectedSha256: content.sha256 ?? null,
    };
  }

  function observeArchiveEvidence(plan, row, diagnostic) {
    const diagnosticRole = row.artifactRole === 'destination-backup' ? 'archive-backup' : row.artifactRole;
    let observation = row.observation;
    if (row.artifactRole === 'published-archive' && plan.outputPublication === 'unlinked') {
      observation = plan.destinationRestoredIdentity ? 'replaced' : 'missing';
    }
    for (const entry of stagingDiagnostics(plan.staging)) {
      if (entry.itemIndex === plan.stageIndex && (entry.artifactRole === diagnosticRole
        || (row.artifactRole === 'published-archive' && entry.artifactRole === 'restored-archive' && entry.pathState))) {
        observation = watermarkDiagnosticObservation(entry, observation);
      }
    }
    if (diagnostic) observation = watermarkDiagnosticObservation(diagnostic, observation);
    const restored = plan.destinationRestoredIdentity;
    if (row.artifactRole === 'published-archive' && row.identity && restored
      && (row.identity.dev !== String(restored.dev) || row.identity.ino !== String(restored.ino)
        || (row.identity.birthtimeNs !== null && row.identity.birthtimeNs !== String(restored.birthtimeNs)))
      && !['missing', 'unavailable'].includes(observation)) {
      // Restored-object diagnostics cannot make it the originally recorded publication.
      observation = 'replaced';
    }
    if (row.identity === null && observation === 'present') observation = 'ownership-unknown';
    if (processingRecoveryEvidenceRepository.setEvidenceObservation(row.projectId, row.evidenceId,
      observation) === false) throw archiveEvidenceFailure(undefined, 'observation');
  }

  function deleteArchiveEvidence(plan, row) {
    try {
      if (processingRecoveryEvidenceRepository.deleteEvidence(row.projectId, row.evidenceId) === false) {
        throw new Error('The Archive evidence row was not deleted.');
      }
    } catch (err) {
      plan.evidenceFailure ??= archiveEvidenceFailure(err, 'deletion');
    }
  }

  function deleteEmptyArchiveGroups(plans) {
    for (const plan of plans) {
      if (!plan.recoveryGroup || plan.evidenceWithheld) continue;
      try {
        if (archiveEvidenceRows(plan).length) continue;
        const { projectId, groupId } = plan.recoveryGroup;
        if (processingRecoveryEvidenceRepository.deleteMutationGroup(projectId, groupId) === false) {
          throw new Error('The empty Archive mutation group was not deleted.');
        }
      } catch (err) {
        plan.evidenceFailure ??= archiveEvidenceFailure(err, 'deletion');
      }
    }
  }

  function finalizeCommittedArchiveEvidence(plans) {
    for (const plan of plans) {
      for (const row of archiveEvidenceRows(plan)) {
        if (ARCHIVE_PRIVATE_ROLES.includes(row.artifactRole)) plan.recoveryGroup.markDispensable(row.evidenceId, {
          retentionReason: ARCHIVE_RETENTION.committed,
        });
        if (row.artifactRole === 'published-archive') {
          try {
            if (processingRecoveryEvidenceRepository.setEvidenceObservation(row.projectId, row.evidenceId,
              'present') === false) throw new Error('The committed Archive observation was not persisted.');
          } catch (err) { throw archiveEvidenceFailure(err, 'observation'); }
        }
      }
    }
  }

  function noteArchiveEvidenceFailure(plans, phase) {
    for (const plan of plans) {
      try {
        for (const row of archiveEvidenceRows(plan)) {
          if (processingRecoveryEvidenceRepository.setEvidenceRetentionReason(row.projectId, row.evidenceId,
            phase === 'database' ? ARCHIVE_RETENTION.databaseFailed : ARCHIVE_RETENTION.publicationFailed) === false) {
            throw new Error('The Archive failure reason was not persisted.');
          }
        }
      } catch (err) {
        plan.evidenceFailure ??= archiveEvidenceFailure(err, 'finalization');
      }
    }
  }

  // Settlement precedes private disposal. Restoration/content and provenance proof are
  // supplied by the existing rollback and last-good-backup checks, never by registry facts.
  function settleArchiveMutation(plan, { committed, stageCritical, backupCritical }) {
    if (plan.evidenceWithheld) return false;
    try {
      plan.evidenceRows = archiveEvidenceRows(plan);
      for (const row of plan.evidenceRows) {
        const critical = !committed && (row.artifactRole === 'archive-stage' ? stageCritical
          : row.artifactRole === 'destination-backup' ? backupCritical : stageCritical || backupCritical);
        const retentionReason = critical ? (plan.outputCreateUnclaimed ? ARCHIVE_RETENTION.publicUnclaimed
          : plan.provenanceReconcilePending ? ARCHIVE_RETENTION.provenanceFailed : ARCHIVE_RETENTION.restorationFailed)
          : committed ? ARCHIVE_RETENTION.committed
            : row.retentionReason === ARCHIVE_RETENTION.residue ? ARCHIVE_RETENTION.residue : ARCHIVE_RETENTION.rolledBack;
        if (critical) plan.recoveryGroup.markRecoveryCritical(row.evidenceId, { retentionReason });
        else if (!committed || row.artifactRole === 'published-archive') {
          plan.recoveryGroup.markDispensable(row.evidenceId, { retentionReason });
        }
        if (!committed) observeArchiveEvidence(plan, row);
      }
      if (!stageCritical && !backupCritical) {
        plan.recoveryGroup.resolveMutation();
        for (const row of archiveEvidenceRows(plan)) {
          if (row.artifactRole === 'published-archive') deleteArchiveEvidence(plan, row);
        }
      }
      return true;
    } catch (err) {
      plan.evidenceWithheld = true;
      plan.evidenceFailure ??= archiveEvidenceFailure(err, 'finalization');
      return false;
    }
  }

  // Cleanup of the private archive artifacts, per plan. `safe` answers "is project state
  // resolved?": it is false only while an unresolved plan keeps its artifacts as recovery
  // evidence (a public archive that could not be removed keeps its stage; a removed archive
  // that was not restored, whose provenance was not reconciled, or whose restored file no
  // longer revalidates keeps its backup). Every other owned artifact is a dispensable private
  // copy: one that cannot be removed is residue (`complete` false), and a path CreatorCrate
  // never owned is left untouched (residue too while it is present). After the commit
  // (`committed`) replaced archives are the intended state, so nothing is unresolved. Removal
  // always requires the artifact's own descriptor-derived exact identity. A backup becomes
  // dispensable after a restore only if the restored archive, immediately before the disposal
  // decision, still is the exact restored object holding the prior archive's bytes.
  function cleanupArchiveStaging(plans, diagnostics, { committed = false, projectDir } = {}) {
    let safe = true;
    let complete = true;
    for (const plan of plans) {
      const stageCritical = !committed && !!(plan.outputRestoreFailed || plan.outputCreateUnclaimed);
      let settled = false;
      if (committed) settled = settleArchiveMutation(plan, { committed, stageCritical: false, backupCritical: false });
      else if (!plan.evidenceWithheld) {
        try {
          plan.evidenceRows = archiveEvidenceRows(plan);
          const row = plan.evidenceRows.find((entry) => entry.artifactRole === 'archive-stage');
          if (row) {
            if (stageCritical) plan.recoveryGroup.markRecoveryCritical(row.evidenceId, {
              retentionReason: plan.outputCreateUnclaimed ? ARCHIVE_RETENTION.publicUnclaimed : ARCHIVE_RETENTION.restorationFailed,
            });
            else plan.recoveryGroup.markDispensable(row.evidenceId, { retentionReason: ARCHIVE_RETENTION.rolledBack });
            observeArchiveEvidence(plan, row);
          }
          settled = true;
        } catch (err) {
          plan.evidenceWithheld = true;
          plan.evidenceFailure ??= archiveEvidenceFailure(err, 'finalization');
        }
      }
      // Settlement failure keeps conservative checkpoints and every remaining private file.
      if (!settled) {
        const restoredFailure = plan.destinationBackupPath && !committed && !plan.destinationRemoved
          && !plan.provenanceReconcilePending && plan.destinationRestoredIdentity
          ? archiveRestoredFailure(plan, projectDir) : null;
        safe &&= !(stageCritical || plan.destinationRemoved || plan.provenanceReconcilePending || restoredFailure);
        complete = false;
        continue;
      }
      const evidenceFor = (entry) => plan.evidenceRows.find((row) => row.artifactRole
        === (entry.artifactRole === 'archive-backup' ? 'destination-backup' : entry.artifactRole));
      const retain = (entry, absPath, identity) => {
        safe = false;
        complete = false;
        let diagnostic;
        recordRecoveryDiagnostic(diagnostics, () => (diagnostic = {
          ...entry,
          ...observeDiagnosticArtifact(absPath, identity),
          cleanup: 'recovery-critical',
        }));
        try {
          const row = evidenceFor(entry);
          if (row) observeArchiveEvidence(plan, row, diagnostic);
        } catch (err) { plan.evidenceFailure ??= archiveEvidenceFailure(err, 'observation'); }
      };
      const dispose = (entry, absPath, identity) => {
        const row = evidenceFor(entry);
        const outcome = {};
        const result = cleanupPrivateStage(absPath, identity, outcome);
        const absent = result === STAGE_CLEANUP.clean
          || (result === STAGE_CLEANUP.residue && pathIsAbsent(absPath));
        if (absent) {
          if (row) {
            try {
              if (processingRecoveryEvidenceRepository.setEvidenceObservation(row.projectId, row.evidenceId,
                'missing') === false) throw new Error('The Archive cleanup observation was not persisted.');
              deleteArchiveEvidence(plan, row);
            } catch (err) { plan.evidenceFailure ??= archiveEvidenceFailure(err, 'observation'); }
          }
          return;
        }
        // Unowned residue is left untouched; cleanup is complete only when nothing is there.
        complete = false;
        let diagnostic;
        recordRecoveryDiagnostic(diagnostics, () => (diagnostic = {
          ...cleanupFailureDiagnostic(entry, absPath, identity, outcome),
          cleanup: 'residue',
        }));
        if (row) {
          try {
            plan.recoveryGroup.markDispensable(row.evidenceId, { retentionReason: ARCHIVE_RETENTION.residue });
            observeArchiveEvidence(plan, row, diagnostic);
          } catch (err) { plan.evidenceFailure ??= archiveEvidenceFailure(err, 'observation'); }
        }
      };

      const stageEntry = { itemIndex: plan.stageIndex, artifactRole: 'archive-stage' };
      if (plan.stageOutput && stageCritical) {
        retain({ ...stageEntry, check: 'retained-unresolved-publication', publicationMode: archivePublicationMode(plan) },
          plan.stageOutput, plan.stageOutputExactIdentity);
      } else {
        dispose(stageEntry, plan.stageOutput, plan.stageOutputExactIdentity);
      }

      const backupEntry = { itemIndex: plan.stageIndex, artifactRole: 'archive-backup' };
      const restoredFailure = plan.destinationBackupPath && !committed && !plan.destinationRemoved
        && !plan.provenanceReconcilePending && plan.destinationRestoredIdentity
        ? archiveRestoredFailure(plan, projectDir) : null;
      const backupCritical = !committed && !!(plan.destinationRemoved || plan.provenanceReconcilePending || restoredFailure);
      if (restoredFailure) {
        recordRecoveryDiagnostic(diagnostics, () => ({
          ...archiveDiagnostic(plan, 'restored-archive', `restored-archive-${restoredFailure}`),
          ...observeDiagnosticArtifact(plan.outputAbsPath, plan.destinationRestoredIdentity),
        }));
      }
      if (!committed && !settleArchiveMutation(plan, { committed, stageCritical, backupCritical })) {
        safe &&= !(stageCritical || backupCritical);
        complete = false;
        continue;
      }
      if (plan.destinationBackupPath && !committed
        && (plan.destinationRemoved || plan.provenanceReconcilePending)) {
        retain({ ...backupEntry, check: 'retained-unrestored' },
          plan.destinationBackupPath, plan.destinationBackupExactIdentity);
      } else if (restoredFailure) {
        // The restored archive changed after its restore: the backup is still the last
        // known-good copy of the prior archive, so it stays as recovery evidence. The changed
        // archive itself is never repaired here.
        retain({ ...backupEntry, check: 'retained-restored-archive-changed' },
          plan.destinationBackupPath, plan.destinationBackupExactIdentity);
      } else {
        dispose(backupEntry, plan.destinationBackupPath, plan.destinationBackupExactIdentity);
      }
    }
    deleteEmptyArchiveGroups(plans);
    // The workspace itself is retained (directory policy).
    return { safe, complete };
  }

  // Rolls back an uncommitted standalone Archive run. `recovered` means project and database
  // state are positively restored (archives removed or restored, provenance reconciled);
  // dispensable residue alone never prevents it and is reported through the diagnostics.
  async function rollbackArchivePublication(projectId, staging, plans, projectDir, phase) {
    const diagnostics = stagingDiagnostics(staging);
    noteArchiveEvidenceFailure(plans, phase);
    const artifactsRestored = await restoreArchiveArtifacts(plans, projectDir, diagnostics);
    const provenanceReconciled = reconcileRestoredArchiveProvenance(projectId, plans, projectDir, diagnostics);
    const cleanup = cleanupArchiveStaging(plans, diagnostics, { projectDir });
    const restored = artifactsRestored && provenanceReconciled;
    return {
      recovered: restored && cleanup.safe,
      evidence: diagnostics.length > 0,
      evidenceFailure: plans.find((plan) => plan.evidenceFailure)?.evidenceFailure,
      diagnostics: summarizeRecoveryDiagnostics(phase, diagnostics, [], {
        restored, cleanupSucceeded: cleanup.complete,
      }),
    };
  }

  function ensureWatermarkOutputDirectories(items, projectDir) {
    const byPath = new Map();
    for (const item of items) {
      const key = pathKey(item.outputDirectoryAbsPath);
      if (byPath.has(key)) continue;
      // Components are validated before traversal and never claimed (directory policy).
      createDirectoryPath(
        projectDir,
        item.outputDirectoryAbsPath,
        'OUTPUT_PATH_UNSAFE',
        'The watermark output directory is unsafe.',
      );
      byPath.set(key, item.outputDirectoryAbsPath);
    }
  }

  // Watermark item state (every artifact is descriptor-owned; see the ownership contract):
  //  - outputPublication: 'unlinked' until the public output's creating descriptor exposes
  //    its exact identity (outputExactIdentity), then 'created'; rollback removes it only
  //    while the pathname is still that exact object. outputCreateUnclaimed: the exclusive
  //    create of the public path succeeded (outputCreateStarted) but its descriptor never proved
  //    a known identity (unknown IDs, or its first inspection failed), so it can never be removed.
  //  - destinationRemoved: an existing generated destination was unlinked after its owned
  //    backup copy (destinationBackupExactIdentity) was verified; rollback restores it as a
  //    new file, whose provenance must then be reconciled (provenanceReconcilePending).
  //  - sourceRemoved: a delete-source original was unlinked after its owned staged copy
  //    (stagedDeleteExactIdentity) was verified; rollback restores it as a new file.
  function watermarkPublicationMode(item) {
    return item.outputExactIdentity ? 'descriptor-owned' : undefined;
  }

  // The public output's owned identity: its creating descriptor's exact {dev, ino}, plus that
  // descriptor's birth time when it is a durable discriminator (the tuple then committed as
  // provenance). Rollback within the run needs only the exact {dev, ino}.
  function watermarkOutputIdentity(item) {
    if (!item.outputExactIdentity) return null;
    return item.outputBirthtimeNs === null || item.outputBirthtimeNs === undefined
      ? item.outputExactIdentity
      : { ...item.outputExactIdentity, birthtimeNs: item.outputBirthtimeNs };
  }

  function watermarkDestinationContent(item) {
    return {
      size: item.destinationStats.size,
      sha256: item.destinationAsset.generated_output_sha256.toLowerCase(),
    };
  }

  function watermarkSourceContent(item) {
    return { size: item.sourceSize, sha256: item.sourceSha256 };
  }

  // Only these private roles may be considered by a future cleanup whitelist.
  // watermark/published-output is public tracking, never a private cleanup candidate.
  const WATERMARK_PRIVATE_ROLES = ['stage-output', 'destination-backup', 'staged-original'];
  const WATERMARK_RETENTION = Object.freeze({
    pending: 'watermark-publication-pending',
    publicationFailed: 'watermark-publication-failed',
    databaseFailed: 'watermark-database-failed',
    restorationFailed: 'watermark-restoration-failed',
    sourceRestorationFailed: 'watermark-source-restoration-failed',
    provenanceFailed: 'watermark-provenance-reconciliation-failed',
    publicUnclaimed: 'watermark-public-created-unclaimed',
    committed: 'watermark-committed',
    rolledBack: 'watermark-verified-rollback',
    residue: 'watermark-cleanup-residue',
  });

  function watermarkEvidenceFailure(err, evidenceStage) {
    if (err?.code === 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED') return err;
    return Object.assign(new AssetProcessingError('Watermark recovery evidence could not be settled.', {
      code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', cause: err,
    }), { evidenceStage });
  }

  function watermarkMutationContexts(items) {
    return [...new Set(items.map((item) => item.recoveryMutation))];
  }

  function startWatermarkMutationGroups(projectId, runId, sources) {
    const started = [];
    try {
      for (const source of sources) {
        const items = source.outputs.filter((output) => output.item).map((output) => output.item);
        if (!items.length) continue;
        // All variants/formats share source deletion and therefore whole-source resolution.
        const mutation = { items, group: processingRecoveryEvidenceRecorder.startMutationGroup({
          projectId, operation: 'watermark', runId, itemKey: `asset:${source.asset.id}`,
        }) };
        started.push(mutation);
        for (const item of items) item.recoveryMutation = mutation;
      }
    } catch (err) {
      for (const { group } of started) {
        try { processingRecoveryEvidenceRepository.deleteMutationGroup(projectId, group.groupId); } catch { /* Empty context only. */ }
      }
      throw err;
    }
  }

  function watermarkEvidenceRows(mutation) {
    const { projectId, groupId } = mutation.group;
    return processingRecoveryEvidenceRepository.listEvidenceByMutationGroup(projectId, groupId);
  }

  function watermarkItemEvidence(item, role) {
    const artifactPath = {
      'stage-output': item.stageOutput,
      'destination-backup': item.destinationBackupPath,
      'staged-original': item.stagedDeletePath,
      'published-output': item.outputAbsPath,
    }[role];
    if (!artifactPath) return undefined;
    return watermarkEvidenceRows(item.recoveryMutation).find((row) => row.artifactRole === role
      && row.artifactPath === projectRelativePath(item.projectDir, artifactPath));
  }

  function watermarkIntent(item, role, artifactPath, content) {
    return {
      assetId: item.asset.id, artifactRole: role, retentionReason: WATERMARK_RETENTION.pending,
      artifactPath: projectRelativePath(item.projectDir, artifactPath),
      sourcePath: item.sourceRelativePath,
      destinationPath: role === 'staged-original' ? item.sourceRelativePath : item.outputRelativePath,
      expectedSize: content.size, expectedSha256: content.sha256,
    };
  }

  function watermarkDiagnosticObservation(diagnostic, previous) {
    const check = diagnostic.check ?? '';
    const content = /content-unreadable|unreadable/.test(check) ? 'unavailable'
      : /content-mismatch|precommit-content/.test(check) ? 'changed' : previous;
    return promptDiagnosticObservation(diagnostic, content);
  }

  // Reuse the latest existing diagnostic, including content failures that a later
  // identity-only cleanup diagnostic cannot disprove. No evidence-only filesystem reads.
  function observeWatermarkEvidence(item, role, row, diagnostic) {
    const history = stagingDiagnostics(item.staging).filter((entry) => entry.assetId === item.asset.id
      && entry.itemIndex === (role === 'staged-original' ? item.stagedDeleteIndex : item.stageIndex)
      && entry.artifactRole === role);
    let observation = row.observation;
    for (const entry of history) observation = watermarkDiagnosticObservation(entry, observation);
    if (diagnostic) observation = watermarkDiagnosticObservation(diagnostic, observation);
    if (row.identity === null && observation === 'present') observation = 'ownership-unknown';
    setWatermarkEvidenceObservation(row, observation);
  }

  function setWatermarkEvidenceObservation(row, observation) {
    try {
      if (processingRecoveryEvidenceRepository.setEvidenceObservation(row.projectId, row.evidenceId,
        observation) === false) throw new Error('The Watermark evidence observation was not persisted.');
    } catch (err) {
      throw watermarkEvidenceFailure(err, 'observation');
    }
  }

  function deleteWatermarkEvidence(mutation, row) {
    try {
      if (processingRecoveryEvidenceRepository.deleteEvidence(row.projectId, row.evidenceId) === false) {
        throw new Error('The Watermark evidence row was not deleted.');
      }
    } catch (err) {
      mutation.evidenceFailure ??= watermarkEvidenceFailure(err, 'deletion');
    }
  }

  function settleWatermarkArtifact(item, role, { critical = false, diagnostic, observation, absent = false,
    retentionReason = WATERMARK_RETENTION.rolledBack } = {}) {
    const mutation = item.recoveryMutation;
    try {
      const row = watermarkItemEvidence(item, role);
      if (!row) return true;
      if (critical) mutation.group.markRecoveryCritical(row.evidenceId, { retentionReason });
      else mutation.group.markDispensable(row.evidenceId, { retentionReason });
      if (diagnostic) observeWatermarkEvidence(item, role, row, diagnostic);
      else if (observation) setWatermarkEvidenceObservation(row,
        row.identity === null && observation !== 'missing' ? 'ownership-unknown' : observation);
      else if (absent) setWatermarkEvidenceObservation(row, 'missing');
      if (absent) deleteWatermarkEvidence(mutation, row);
      return true;
    } catch (err) {
      mutation.evidenceFailure ??= watermarkEvidenceFailure(err, 'finalization');
      if (!critical) mutation.withheld = true;
      return false;
    }
  }

  function finishWatermarkMutations(items, { committed = false } = {}) {
    for (const mutation of watermarkMutationContexts(items)) {
      if (mutation.withheld || (!committed && mutation.items.some((item) => item.recoveryUnresolved
        || item.outputRestoreFailed || item.outputCreateUnclaimed || item.destinationRemoved
        || item.sourceRemoved || item.provenanceReconcilePending))) continue;
      try {
        mutation.group.resolveMutation();
        mutation.resolved = true;
      } catch (err) {
        mutation.withheld = true;
        mutation.evidenceFailure ??= watermarkEvidenceFailure(err, 'resolution');
        continue;
      }
      try {
        for (const row of watermarkEvidenceRows(mutation)) {
          if (row.artifactRole === 'published-output') deleteWatermarkEvidence(mutation, row);
        }
      } catch (err) {
        mutation.evidenceFailure ??= watermarkEvidenceFailure(err, 'deletion');
      }
    }
  }

  function deleteSettledWatermarkGroups(items) {
    for (const mutation of watermarkMutationContexts(items)) {
      if (!mutation.resolved) continue;
      try {
        if (watermarkEvidenceRows(mutation).length) continue;
        if (processingRecoveryEvidenceRepository.deleteMutationGroup(mutation.group.projectId, mutation.group.groupId) === false) {
          throw new Error('The empty Watermark mutation group was not deleted.');
        }
      } catch (err) {
        mutation.evidenceFailure ??= watermarkEvidenceFailure(err, 'deletion');
      }
    }
  }

  const OWNED_PATH_FAILURE_CHECKS = Object.freeze({
    identity: 'identity-mismatch',
    content: 'content-mismatch',
    unreadable: 'content-unreadable',
  });

  // The owned backup of a replaced destination must still be its exact descriptor-created
  // object and hold the destination's recorded bytes: ownership and content are both
  // required, and neither ever authorizes anything about the destination itself.
  // Returns the write fingerprint the backup's bytes were verified under.
  function assertWatermarkBackupValid(item, projectDir, stage) {
    const { failure, fingerprint } = !item.destinationBackupComplete
      ? { failure: 'identity' }
      : ownedPathContentSnapshot(projectDir, item.destinationBackupPath, item.destinationBackupExactIdentity,
        watermarkDestinationContent(item));
    if (!failure) return fingerprint;
    failWatermarkBackup(item, `${stage}-backup-${OWNED_PATH_FAILURE_CHECKS[failure]}`);
  }

  function failWatermarkBackup(item, check) {
    recordRecoveryDiagnostic(stagingDiagnostics(item.staging), () => ({
      assetId: item.asset?.id,
      itemIndex: item.stageIndex,
      artifactRole: 'destination-backup',
      check,
      ...observeDiagnosticArtifact(item.destinationBackupPath, item.destinationBackupExactIdentity),
    }));
    throw new AssetProcessingError('The watermark destination backup changed during processing.', {
      code: 'FILESYSTEM_OPERATION_FAILED',
    });
  }

  // Cleanup of the private Watermark artifacts, per item. `safe` answers "is project state
  // resolved?": it is false only while an unresolved item keeps its artifacts as recovery
  // evidence (a public output that could not be removed keeps its stage; a removed destination
  // that was not restored, whose provenance was not reconciled, or whose restored file no longer
  // revalidates keeps its backup; a removed
  // source that was not restored, or whose restored file no longer revalidates, keeps its staged
  // original). Every other owned artifact is a
  // dispensable private copy: one that cannot be removed is residue (`complete` false), and a
  // path CreatorCrate never owned is left untouched (residue too while it is present). After the commit (`committed`) removed
  // sources and destinations are the intended state, so nothing is unresolved. Removal always
  // requires the artifact's own descriptor-derived exact identity.
  // Rollback may restore a source and then keep working (other sources, provenance), so a
  // staged original becomes dispensable only when its restored source is, immediately before
  // the disposal decision, still the exact restored object holding the source's recorded bytes
  // under a post-hash write fingerprint that held across a hash (ownedPathContentSnapshot):
  // identity, content, identity, and a conditional re-hash when the metadata moved across the
  // first read, so a write landing after the hash read is never accepted. Nothing reads the
  // restored source after that decision.
  const RESTORED_SOURCE_FAILURE_CHECKS = Object.freeze({
    ...OWNED_PATH_FAILURE_CHECKS,
    continuity: 'continuity-mismatch',
  });

  function watermarkRestoredSourceFailure(item, projectDir) {
    const { failure, unstable } = ownedPathContentSnapshot(projectDir, item.sourceAbsPath,
      item.restoredSourceIdentity, watermarkSourceContent(item));
    if (!failure) return null;
    return unstable ? 'continuity' : failure;
  }

  // A destination backup becomes dispensable after a restore only if the restored destination,
  // immediately before the disposal decision, is still the exact restored object holding the
  // prior output's bytes under a post-hash write fingerprint that held across a hash
  // (ownedPathContentSnapshot), so a write landing after the hash read is never accepted.
  function watermarkRestoredDestinationFailure(item, projectDir) {
    const { failure } = ownedPathContentSnapshot(projectDir, item.outputAbsPath, item.destinationRestoredIdentity,
      watermarkDestinationContent(item));
    return failure ? OWNED_PATH_FAILURE_CHECKS[failure] : null;
  }

  function cleanupWatermarkStaging(staging, diagnostics, { committed = false, projectDir } = {}) {
    let safe = true;
    let complete = true;
    for (const item of staging.items) {
      const base = (artifactRole, itemIndex = item.stageIndex) => ({
        assetId: item.asset?.id, itemIndex, artifactRole,
      });
      const retain = (entry, absPath, identity) => {
        safe = false;
        complete = false;
        item.recoveryUnresolved = true;
        const diagnostic = {
          ...entry,
          ...observeDiagnosticArtifact(absPath, identity),
          cleanup: 'recovery-critical',
        };
        recordRecoveryDiagnostic(diagnostics, () => diagnostic);
        const retentionReason = entry.artifactRole === 'staged-original' ? WATERMARK_RETENTION.sourceRestorationFailed
          : item.provenanceReconcilePending ? WATERMARK_RETENTION.provenanceFailed
            : WATERMARK_RETENTION.restorationFailed;
        settleWatermarkArtifact(item, entry.artifactRole, { critical: true, diagnostic, retentionReason });
      };
      const dispose = (entry, absPath, identity) => {
        if (!absPath) return;
        const mutation = item.recoveryMutation;
        if (mutation.withheld || !settleWatermarkArtifact(item, entry.artifactRole, {
          retentionReason: committed ? WATERMARK_RETENTION.committed : WATERMARK_RETENTION.rolledBack,
        })) {
          complete = false;
          return;
        }
        const outcome = {};
        const result = cleanupPrivateStage(absPath, identity, outcome);
        const absent = result === STAGE_CLEANUP.clean
          || (result === STAGE_CLEANUP.residue && pathIsAbsent(absPath));
        if (absent) {
          settleWatermarkArtifact(item, entry.artifactRole, { absent: true,
            retentionReason: committed ? WATERMARK_RETENTION.committed : WATERMARK_RETENTION.rolledBack });
          return;
        }
        complete = false;
        const diagnostic = {
          ...cleanupFailureDiagnostic(entry, absPath, identity, outcome),
          cleanup: 'residue',
        };
        recordRecoveryDiagnostic(diagnostics, () => diagnostic);
        settleWatermarkArtifact(item, entry.artifactRole, { diagnostic, retentionReason: WATERMARK_RETENTION.residue });
      };

      if (item.stageOutput && !committed && (item.outputRestoreFailed || item.outputCreateUnclaimed)) {
        retain({
          ...base('stage-output'),
          check: 'retained-unresolved-publication',
          publicationMode: watermarkPublicationMode(item),
        }, item.stageOutput, item.stageOutputExactIdentity);
      } else {
        dispose(base('stage-output'), item.stageOutput, item.stageOutputExactIdentity);
      }

      const restoredSourceFailure = item.stagedDeletePath && !committed && !item.sourceRemoved
        && item.restoredSourceIdentity
        ? watermarkRestoredSourceFailure(item, projectDir) : null;
      if (item.stagedDeletePath && !committed && item.sourceRemoved) {
        // An unrestored staged original is the last trusted copy of the source.
        retain({ ...base('staged-original', item.stagedDeleteIndex), check: 'retained-unrestored' },
          item.stagedDeletePath, item.stagedDeleteExactIdentity);
      } else if (restoredSourceFailure) {
        // The restored source changed after its restore: the staged original is still the last
        // known-good copy of the source, so it stays as recovery evidence. The changed source
        // itself is never repaired here.
        recordRecoveryDiagnostic(diagnostics, () => ({
          ...base('restored-source', item.stagedDeleteIndex),
          check: `restored-source-${RESTORED_SOURCE_FAILURE_CHECKS[restoredSourceFailure]}`,
          ...observeDiagnosticArtifact(item.sourceAbsPath, item.restoredSourceIdentity),
        }));
        retain({ ...base('staged-original', item.stagedDeleteIndex), check: 'retained-restored-source-changed' },
          item.stagedDeletePath, item.stagedDeleteExactIdentity);
      } else {
        dispose(base('staged-original', item.stagedDeleteIndex), item.stagedDeletePath, item.stagedDeleteExactIdentity);
      }

      const restoredDestinationFailure = item.destinationBackupPath && !committed && !item.destinationRemoved
        && !item.provenanceReconcilePending && item.destinationRestoredIdentity
        ? watermarkRestoredDestinationFailure(item, projectDir) : null;
      if (item.destinationBackupPath && !committed
        && (item.destinationRemoved || item.provenanceReconcilePending)) {
        retain({ ...base('destination-backup'), check: 'retained-unrestored' },
          item.destinationBackupPath, item.destinationBackupExactIdentity);
      } else if (restoredDestinationFailure) {
        // The restored destination changed after its restore: the backup is still the last
        // known-good copy of the prior output, so it stays as recovery evidence. The changed
        // destination itself is never repaired here.
        recordRecoveryDiagnostic(diagnostics, () => ({
          ...base('restored-destination'),
          check: `restored-destination-${restoredDestinationFailure}`,
          ...observeDiagnosticArtifact(item.outputAbsPath, item.destinationRestoredIdentity),
        }));
        retain({ ...base('destination-backup'), check: 'retained-restored-destination-changed' },
          item.destinationBackupPath, item.destinationBackupExactIdentity);
      } else {
        dispose(base('destination-backup'), item.destinationBackupPath, item.destinationBackupExactIdentity);
      }
    }
    // The workspace itself is retained (directory policy).
    return { safe, complete };
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

    const stageOutputPath = stagingFile(staging, `${index}.output`);
    item.stageOutput = stageOutputPath;
    item.staging = staging;
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
      // The rendered source bytes are the expected content of a delete-source original.
      item.sourceSize = sourceBuffer.length;
      item.sourceSha256 = createHash('sha256').update(sourceBuffer).digest('hex');
      item.outputMode = currentStats.mode & 0o7777;
      // Owned exact identity comes from the exclusive descriptor, plus a candidate birth time.
      const stage = await item.recoveryMutation.group.createArtifact({
        intent: watermarkIntent(item, 'stage-output', stageOutputPath, {
          size: rendered.buffer.length, sha256: createHash('sha256').update(rendered.buffer).digest('hex'),
        }),
        create: ({ onCreated, onOwned }) => writeOwnedStageFile(
          stageOutputPath, (descriptor) => writeBytesToDescriptor(descriptor, rendered.buffer), {
            mode: item.outputMode, onCreated,
            onOwned: (identity) => { item.stageOutputExactIdentity = identity; onOwned(identity); },
          },
        ),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(stageOutputPath, identity),
      });
      const owned = stage.value;
      item.stageOutputBirthtimeNs = owned.birthtimeNs;
      const stageStats = inspectGeneratedFile(stageOutputPath, 'WATERMARK_OUTPUT_INVALID');
      item.outputSize = stageStats.size;
      item.outputSha256 = hashRegularFileInProject(projectDir, stageOutputPath);
      const metadata = await sharpImplementation(rendered.buffer).metadata();
      if (metadata.format !== sharpOutputFormat(item.outputFormat)
        || metadata.width !== rendered.width
        || metadata.height !== rendered.height) {
        throw new Error('Sharp produced unexpected watermark output metadata.');
      }
      // Classify the staged bytes with the scanner's own inspector so a
      // recreated generated asset records its complete new source state in
      // the one generation-advancing update.
      item.outputAnimated = inspectSourceAnimation(stageOutputPath, item.outputExtension);
    } catch (err) {
      // Ownership only ever comes from the exclusive descriptor; whatever is at the
      // pathname after a failure is never promoted to an owned stage.
      throw wrapWatermarkEngineError(err);
    }
  }

  // Replacing an existing generated destination. Destructive authority over the destination
  // is its persisted durable provenance (the full tuple proven at preflight) plus its recorded
  // bytes, re-proven immediately before the unlink; independently, a complete owned backup
  // copy (its own descriptor identity, expected to differ from the destination's) must hold
  // those bytes. The backup's identity never authorizes anything about the destination.
  async function prepareWatermarkDestinationReplacement(item, projectDir) {
    const diagnostics = stagingDiagnostics(item.staging);
    const conflict = (message, cause) => new AssetProcessingError(message, {
      code: 'OUTPUT_DESTINATION_CONFLICT', ...(cause ? { cause } : {}),
    });
    const destinationContent = watermarkDestinationContent(item);
    // Returns the write fingerprint the destination's bytes were verified under.
    const verifyDestination = () => {
      const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, item.outputAbsPath,
        item.destinationExactIdentity, destinationContent);
      if (failure === 'identity') throw conflict('The watermark output destination changed during processing.');
      if (failure) throw conflict('The existing watermark destination is no longer owned by CreatorCrate.');
      return fingerprint;
    };
    verifyDestination();

    const backupPath = stagingFile(item.staging, `${item.stageIndex}.destination`);
    item.destinationBackupPath = backupPath;
    try {
      await item.recoveryMutation.group.createArtifact({
        intent: watermarkIntent(item, 'destination-backup', backupPath, destinationContent),
        create: ({ onCreated, onOwned }) => copyTrustedFileToOwnedFile({
          sourcePath: item.outputAbsPath,
          sourceExactIdentity: { dev: item.destinationExactIdentity.dev, ino: item.destinationExactIdentity.ino },
          destinationPath: backupPath,
          expectedSha256: destinationContent.sha256,
          expectedSize: destinationContent.size,
          mode: item.destinationStats.mode & 0o7777,
          onCreated,
          onOwned: (identity) => { item.destinationBackupExactIdentity = identity; onOwned(identity); },
        }),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(backupPath, identity),
      });
      item.destinationBackupComplete = true;
    } catch (err) {
      // An owned partial backup is removed later only by its exact identity; an EEXIST
      // collision or an identity-unknown create is never claimed.
      recordRecoveryDiagnostic(diagnostics, () => ({
        assetId: item.asset?.id,
        itemIndex: item.stageIndex,
        artifactRole: 'destination-backup',
        check: 'backup-create-failed',
        ...ownedFileFailureEvidence(err),
        ...observeDiagnosticArtifact(backupPath, item.destinationBackupExactIdentity),
      }));
      if (err instanceof AssetProcessingError) throw err;
      if (err instanceof OwnedFileError && (err.reason === OWNED_FILE_FAILURE.sourceChanged
        || err.reason === OWNED_FILE_FAILURE.sourceUnsafe)) {
        throw conflict('The watermark output destination changed during processing.', err);
      }
      throw new AssetProcessingError('CreatorCrate could not back up an existing watermark output.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    // Both authorities, re-proven immediately before the destructive step. Each content read
    // is followed by a fresh proof of the other object: the backup (identity, bytes, identity)
    // again after the destination read, which it could have been rewritten in place or
    // displaced during; then a metadata-only sweep of BOTH, which proves the destination is
    // still its owned object with the write fingerprint its bytes were verified under (it
    // could have been rewritten in place, same identity, during that final backup read) and
    // the backup likewise. No content read separates these final proofs from the unlink.
    return () => {
      assertWatermarkBackupValid(item, projectDir, 'replace');
      const destinationFingerprint = verifyDestination();
      const backupFingerprint = assertWatermarkBackupValid(item, projectDir, 'replace-final');
      const destinationChange = ownedPathContinuityFailure(item.outputAbsPath, item.destinationExactIdentity,
        destinationFingerprint);
      if (destinationChange) {
        recordRecoveryDiagnostic(diagnostics, () => ({
          assetId: item.asset?.id,
          itemIndex: item.stageIndex,
          artifactRole: 'existing-destination',
          check: `replace-final-destination-${OWNED_PATH_FAILURE_CHECKS[destinationChange]}`,
          ...observeDiagnosticArtifact(item.outputAbsPath, item.destinationExactIdentity),
        }));
        throw conflict('The watermark output destination changed during processing.');
      }
      const backupChange = ownedPathContinuityFailure(item.destinationBackupPath, item.destinationBackupExactIdentity,
        backupFingerprint);
      if (backupChange) failWatermarkBackup(item, `replace-final-backup-${OWNED_PATH_FAILURE_CHECKS[backupChange]}`);
      try {
        fs.unlinkSync(item.outputAbsPath);
      } catch (err) {
        // Unless the pathname still holds the owned destination, it no longer does: rollback
        // must then restore it (a foreign occupant is never removed and leaves it unresolved).
        if (!pathMatchesExactIdentity(item.outputAbsPath, item.destinationExactIdentity)) item.destinationRemoved = true;
        throw new AssetProcessingError('CreatorCrate could not replace an existing watermark output.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
      item.destinationRemoved = true;
    };
  }

  // The public output is created exclusively at its final pathname and filled from the
  // validated stage (trusted content input only). Its ownership is its own descriptor
  // identity, recorded before any byte is written; the stage identity is never adopted and no
  // hard link is made. The pathname briefly exposes an incomplete file; the project operation
  // lock, the durable recovery hold and exact rollback ownership cover that window. EEXIST
  // never overwrites or adopts what appeared.
  async function publishWatermarkOutput(item, projectDir) {
    item.outputProvenance = null;
    item.validationTrace = [];
    let removeDestination;
    revalidatePublicationTarget(projectDir, item.outputAbsPath, 'OUTPUT_PATH_UNSAFE', 'Output');
    if (item.destinationAsset) {
      const currentStats = inspectOptionalDestination(item.outputAbsPath);
      if (item.destinationStats && !currentStats) {
        throw new AssetProcessingError('The watermark output destination changed during processing.', {
          code: 'OUTPUT_DESTINATION_CONFLICT',
        });
      }
      if (!item.destinationStats && currentStats) {
        throw new AssetProcessingError('A watermark output destination appeared during processing.', {
          code: 'OUTPUT_DESTINATION_CONFLICT',
        });
      }
      if (currentStats) removeDestination = await prepareWatermarkDestinationReplacement(item, projectDir);
    }

    try {
      revalidatePublicationTarget(projectDir, item.outputAbsPath, 'OUTPUT_PATH_UNSAFE', 'Output');
      const publication = await item.recoveryMutation.group.createArtifact({
        intent: watermarkIntent(item, 'published-output', item.outputAbsPath, {
          size: item.outputSize, sha256: item.outputSha256,
        }),
        checkpoint: removeDestination ? 'replace' : 'public-create',
        create: async ({ onCreated, onOwned }) => {
          try {
            for (const role of ['stage-output', 'destination-backup']) {
              const row = watermarkItemEvidence(item, role);
              if (row) item.recoveryMutation.group.markRecoveryCritical(row.evidenceId, {
                retentionReason: WATERMARK_RETENTION.pending,
              });
            }
          } catch (err) {
            item.recoveryMutation.withheld = true;
            throw err;
          }
          removeDestination?.();
          return copyTrustedFileToOwnedFile({
            sourcePath: item.stageOutput,
            sourceExactIdentity: item.stageOutputExactIdentity,
            destinationPath: item.outputAbsPath,
            expectedSha256: item.outputSha256,
            expectedSize: item.outputSize,
            mode: item.outputMode,
            onCreated: () => { item.outputCreateStarted = true; onCreated(); },
            onOwned: (identity) => {
              item.outputExactIdentity = identity;
              item.outputPublication = 'created';
              onOwned(identity);
            },
          });
        },
        discardOwned: (identity) => removeFileIfExactIdentityMatches(item.outputAbsPath, identity),
      });
      const owned = publication.value;
      item.outputBirthtimeNs = durableDescriptorBirthtimeNs(owned);
      // The creating descriptor's final stat (dev/ino, birth time, ctime) and hashed size:
      // the baseline later pre-commit path observations are read against (diagnostics only).
      traceStats(item.validationTrace, 'public-descriptor-final', {
        ...owned.exactIdentity, size: owned.content?.size, birthtimeNs: owned.birthtimeNs, ctimeNs: owned.ctimeNs,
      });
      const outputStats = fs.lstatSync(item.outputAbsPath);
      if (!tracedPathMatchesExactIdentity(item.outputAbsPath, watermarkOutputIdentity(item), item.validationTrace,
        'public-post-close')) {
        throw new OwnedFileError(OWNED_FILE_FAILURE.pathnameChanged, 'The published watermark output changed.');
      }
      item.outputStats = outputStats;
      item.outputVerification = { mode: 'descriptor-owned' };
    } catch (err) {
      // The exclusive create succeeded but its descriptor never proved ownership (unknown IDs,
      // or the first inspection itself failed): a public path exists that is not ours to
      // adopt or remove. A failed open never gets here with outputCreateStarted set.
      if (item.outputCreateStarted && !item.outputExactIdentity) item.outputCreateUnclaimed = true;
      recordRecoveryDiagnostic(stagingDiagnostics(item.staging), () => ({
        assetId: item.asset?.id,
        itemIndex: item.stageIndex,
        artifactRole: 'published-output',
        check: item.outputCreateUnclaimed ? 'public-output-identity-inspection-failed' : 'publish-create-failed',
        publicationMode: watermarkPublicationMode(item),
        ...ownedFileFailureEvidence(item.outputCreateUnclaimed ? err.cause ?? err : err),
        ...observeDiagnosticPath(item.outputAbsPath, item.outputExactIdentity),
        // The created public path stays unresolved: never residue, never removed here.
        ...(item.outputCreateUnclaimed ? { cleanup: 'recovery-critical' } : {}),
      }));
      const copyFailure = [err, err?.cause].find((candidate) => ownedFileSourceChangeEvidence(candidate));
      if (copyFailure) {
        noteWatermarkValidationFailure(copyFailure, () => watermarkPublicationFailureContext(item,
          item.outputCreateUnclaimed ? 'public-output-identity-inspection-failed' : 'publish-create-failed', copyFailure));
      }
      if (err instanceof AssetProcessingError) throw err;
      if (err?.code === 'EEXIST') {
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
  }

  // Delete-source staging. The staged original is a private copy of the source's bytes in a
  // new, exclusively created file whose ownership is its own descriptor identity (expected to
  // differ from the source's). Authority to unlink the source is independent and double: the
  // source's own preflight exact identity plus its rendered bytes, and a complete owned staged
  // copy that still holds those bytes. Each is re-proven after its fallible read.
  async function stageWatermarkOriginalForDelete(item, siblings, staging, index, projectDir) {
    const diagnostics = stagingDiagnostics(staging);
    const base = { assetId: item.asset?.id, itemIndex: index, artifactRole: 'staged-original' };
    const sourceChanged = (cause) => new AssetProcessingError('A selected source changed during watermark processing.', {
      code: 'SOURCE_CHANGED', ...(cause ? { cause } : {}),
    });
    revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
    const sourceStats = inspectSource(item.sourceAbsPath);
    // Unknown (zero) or changed exact IDs fail closed before anything is created or removed.
    if (!pathMatchesExactIdentity(item.sourceAbsPath, item.sourceExactIdentity)) {
      recordRecoveryDiagnostic(diagnostics, () => ({
        ...base,
        check: 'staged-original-create-failed',
        ...(isKnownDirectoryIdentity(item.sourceExactIdentity) ? {} : { proof: 'reference-identity-unknown' }),
        ...observeDiagnosticArtifact(item.sourceAbsPath, item.sourceExactIdentity),
      }));
      throw sourceChanged();
    }
    // Every output of this source must have been rendered from the same bytes.
    if (siblings.some((sibling) => sibling.sourceSha256 !== item.sourceSha256
      || sibling.sourceSize !== item.sourceSize)) {
      throw sourceChanged();
    }
    const sourceContent = watermarkSourceContent(item);
    item.sourceDeleteStats = sourceStats;

    const stagedDeletePath = stagingFile(staging, `${index}.original`);
    item.stagedDeletePath = stagedDeletePath;
    item.stagedDeleteIndex = index;
    try {
      await item.recoveryMutation.group.createArtifact({
        intent: watermarkIntent(item, 'staged-original', stagedDeletePath, sourceContent),
        create: ({ onCreated, onOwned }) => copyTrustedFileToOwnedFile({
          sourcePath: item.sourceAbsPath,
          sourceExactIdentity: item.sourceExactIdentity,
          destinationPath: stagedDeletePath,
          expectedSha256: sourceContent.sha256,
          expectedSize: sourceContent.size,
          mode: sourceStats.mode & 0o7777,
          onCreated,
          onOwned: (identity) => { item.stagedDeleteExactIdentity = identity; onOwned(identity); },
        }),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(stagedDeletePath, identity),
      });
      item.stagedDeleteComplete = true;
    } catch (err) {
      recordRecoveryDiagnostic(diagnostics, () => ({
        ...base,
        check: 'staged-original-create-failed',
        ...ownedFileFailureEvidence(err),
        ...observeDiagnosticArtifact(stagedDeletePath, item.stagedDeleteExactIdentity),
      }));
      if (err instanceof AssetProcessingError) throw err;
      if (err instanceof OwnedFileError && (err.reason === OWNED_FILE_FAILURE.sourceChanged
        || err.reason === OWNED_FILE_FAILURE.sourceUnsafe
        || err.reason === OWNED_FILE_FAILURE.contentMismatch)) {
        throw sourceChanged(err);
      }
      throw new AssetProcessingError('CreatorCrate could not stage an original for deletion.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    const stagedFailure = ownedPathContentFailure(projectDir, stagedDeletePath, item.stagedDeleteExactIdentity,
      sourceContent);
    if (stagedFailure) {
      recordRecoveryDiagnostic(diagnostics, () => ({
        ...base,
        check: `staged-original-${OWNED_PATH_FAILURE_CHECKS[stagedFailure]}`,
        ...observeDiagnosticArtifact(stagedDeletePath, item.stagedDeleteExactIdentity),
      }));
      throw new AssetProcessingError('The staged original changed before the source was removed.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    }
    if (ownedPathContentFailure(projectDir, item.sourceAbsPath, item.sourceExactIdentity, sourceContent)) {
      throw sourceChanged();
    }
    // The staged copy could have been displaced while the source was read.
    if (!pathMatchesExactIdentity(stagedDeletePath, item.stagedDeleteExactIdentity)) {
      recordRecoveryDiagnostic(diagnostics, () => ({
        ...base,
        check: 'staged-original-final-identity-mismatch',
        ...observeDiagnosticArtifact(stagedDeletePath, item.stagedDeleteExactIdentity),
      }));
      throw new AssetProcessingError('The staged original changed before the source was removed.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    }
    item.recoveryMutation.group.beginMutation('unlink', () => {
      try {
        const row = watermarkItemEvidence(item, 'staged-original');
        item.recoveryMutation.group.markRecoveryCritical(row.evidenceId, { retentionReason: WATERMARK_RETENTION.pending });
      } catch (err) {
        item.recoveryMutation.withheld = true;
        throw err;
      }
    });
    try {
      fs.unlinkSync(item.sourceAbsPath);
    } catch (err) {
      // Unless the pathname still holds the exact source, it no longer does: rollback must
      // then restore it (a foreign occupant is never removed and leaves it unresolved).
      if (!pathMatchesExactIdentity(item.sourceAbsPath, item.sourceExactIdentity)) item.sourceRemoved = true;
      throw new AssetProcessingError('CreatorCrate could not remove an original for deletion.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
    item.sourceRemoved = true;
    try {
      fs.lstatSync(item.sourceAbsPath);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new AssetProcessingError('CreatorCrate could not verify an original was removed.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
    throw new AssetProcessingError('The original source still exists after it was removed.', {
      code: 'FILESYSTEM_OPERATION_FAILED',
    });
  }

  // Rollback of the public outputs, per item: a created output is removed only while its
  // pathname is still the exact descriptor-created object (no hash fallback); then a replaced
  // destination returns from its owned backup as a new, exclusively created file with the
  // recorded bytes, mode and indexed times. Its new identity is recorded so the database
  // provenance can be reconciled (reconcileRestoredWatermarkProvenance).
  async function restoreWatermarkOutputs(items, projectDir, diagnostics) {
    let restored = true;
    for (const item of [...items].reverse()) {
      const fail = (artifactRole, check, details) => {
        restored = false;
        recordRecoveryDiagnostic(diagnostics, () => ({
          assetId: item.asset?.id,
          itemIndex: item.stageIndex,
          artifactRole,
          check,
          ...(artifactRole === 'published-output' ? { publicationMode: watermarkPublicationMode(item) } : {}),
          ...details(),
        }));
      };

      if (item.outputPublication !== 'unlinked') {
        const removal = {};
        if (!removeFileIfExactIdentityMatches(item.outputAbsPath, item.outputExactIdentity, removal)) {
          // A foreign, uninspectable or unremovable output stays; its stage is kept as evidence.
          item.outputRestoreFailed = true;
          const check = { ownership: 'rollback-identity-mismatch', inspection: 'rollback-inspect' }[removal.failedStep]
            ?? 'rollback-unlink';
          fail('published-output', check, () => ({
            ...observeDiagnosticArtifact(item.outputAbsPath, item.outputExactIdentity),
            ...(removal.errorCode ? { errorCode: removal.errorCode } : {}),
          }));
          continue;
        }
        item.outputPublication = 'unlinked';
        item.publicRecoveryObservation = 'missing';
      } else if (item.outputCreateUnclaimed) {
        // CreatorCrate created the public path but never learned its identity: whatever is
        // there can never be proven ours, so it stays and the item is unresolved.
        let present = true;
        try {
          fs.lstatSync(item.outputAbsPath);
        } catch (err) {
          present = err.code !== 'ENOENT';
        }
        if (present) {
          item.outputRestoreFailed = true;
          fail('published-output', 'rollback-ownership-unproven', () => observeDiagnosticArtifact(item.outputAbsPath));
          continue;
        }
        item.outputCreateUnclaimed = false;
        item.publicRecoveryObservation = 'missing';
      }

      if (!item.destinationRemoved) continue;
      const backupFailure = !item.destinationBackupComplete
        ? 'identity'
        : ownedPathContentFailure(projectDir, item.destinationBackupPath, item.destinationBackupExactIdentity,
          watermarkDestinationContent(item));
      if (backupFailure) {
        fail('destination-backup', `destination-restore-${OWNED_PATH_FAILURE_CHECKS[backupFailure]}`, () => (
          observeDiagnosticArtifact(item.destinationBackupPath, item.destinationBackupExactIdentity)
        ));
        continue;
      }
      try {
        revalidatePublicationTarget(projectDir, item.outputAbsPath, 'OUTPUT_PATH_UNSAFE', 'Output');
      } catch (err) {
        fail('restored-destination', 'destination-unsafe', () => ownedFileFailureEvidence(err.cause ?? err));
        continue;
      }
      let restoredIdentity;
      try {
        const destinationContent = watermarkDestinationContent(item);
        const owned = await copyTrustedFileToOwnedFile({
          sourcePath: item.destinationBackupPath,
          sourceExactIdentity: item.destinationBackupExactIdentity,
          destinationPath: item.outputAbsPath,
          expectedSha256: destinationContent.sha256,
          expectedSize: destinationContent.size,
          mode: item.destinationStats.mode & 0o7777,
          times: {
            atime: indexedTimeSeconds(item.destinationStats.atime),
            mtime: indexedTimeSeconds(item.destinationStats.mtime),
          },
          onOwned: (identity) => { restoredIdentity = identity; },
        });
        const birthtimeNs = durableDescriptorBirthtimeNs(owned);
        item.destinationRestoredIdentity = birthtimeNs === null
          ? owned.exactIdentity : { ...owned.exactIdentity, birthtimeNs };
        item.destinationRestoredProvenance = birthtimeNs === null
          ? null : formatGeneratedOutputProvenance({ ...owned.exactIdentity, birthtimeNs });
      } catch (err) {
        fail('restored-destination', 'restore-create-failed', () => ({
          ...observeDiagnosticArtifact(item.outputAbsPath, restoredIdentity),
          ...ownedFileFailureEvidence(err),
        }));
        // A partial restore CreatorCrate owns is withdrawn (exact identity only), so no
        // unverified bytes stay at the destination; the backup remains the prior output.
        if (restoredIdentity) removeFileIfExactIdentityMatches(item.outputAbsPath, restoredIdentity);
        continue;
      }
      item.destinationRemoved = false;
      item.provenanceReconcilePending = true;
      item.publicRecoveryObservation = 'replaced';
    }
    return restored;
  }

  // Rollback of delete-source originals: each removed source returns from its owned staged
  // copy (still its exact identity, still the source's bytes) as a new, exclusively created
  // file with the source's mode and indexed times. The source pathname must be absent: EEXIST
  // never overwrites or adopts a foreign file, which leaves the item unresolved.
  async function restoreWatermarkSourceDeletes(items, projectDir, diagnostics) {
    let restored = true;
    for (const item of [...items].reverse()) {
      if (!item.sourceRemoved) continue;
      const fail = (artifactRole, check, details) => {
        restored = false;
        recordRecoveryDiagnostic(diagnostics, () => ({
          assetId: item.asset?.id,
          itemIndex: item.stagedDeleteIndex,
          artifactRole,
          check,
          ...details(),
        }));
      };
      const stagedObservation = () => observeDiagnosticArtifact(item.stagedDeletePath, item.stagedDeleteExactIdentity);

      const stagedFailure = !item.stagedDeleteComplete
        ? 'identity'
        : ownedPathContentFailure(projectDir, item.stagedDeletePath, item.stagedDeleteExactIdentity,
          watermarkSourceContent(item));
      if (stagedFailure) {
        fail('staged-original', isKnownDirectoryIdentity(item.stagedDeleteExactIdentity)
          ? `restore-${OWNED_PATH_FAILURE_CHECKS[stagedFailure]}` : 'restore-ownership-unproven', stagedObservation);
        continue;
      }
      try {
        fs.lstatSync(item.sourceAbsPath);
        fail('staged-original', 'restore-source-present', () => ({
          ...stagedObservation(),
          referenceIdentity: observeDiagnosticArtifact(item.sourceAbsPath, item.sourceExactIdentity).identity,
        }));
        continue;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          fail('staged-original', 'restore-source-inspect', () => ({
            ...stagedObservation(),
            ...(typeof err.code === 'string' ? { errorCode: err.code } : {}),
          }));
          continue;
        }
      }
      try {
        revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
      } catch (err) {
        fail('restored-source', 'restore-destination-unsafe', () => ownedFileFailureEvidence(err.cause ?? err));
        continue;
      }
      let restoredIdentity;
      try {
        await copyTrustedFileToOwnedFile({
          sourcePath: item.stagedDeletePath,
          sourceExactIdentity: item.stagedDeleteExactIdentity,
          destinationPath: item.sourceAbsPath,
          expectedSha256: item.sourceSha256,
          expectedSize: item.sourceSize,
          mode: item.sourceDeleteStats.mode & 0o7777,
          times: {
            atime: indexedTimeSeconds(item.sourceDeleteStats.atime),
            mtime: indexedTimeSeconds(item.sourceDeleteStats.mtime),
          },
          onOwned: (identity) => { restoredIdentity = identity; },
        });
      } catch (err) {
        fail('restored-source', 'restore-create-failed', () => ({
          ...observeDiagnosticArtifact(item.sourceAbsPath, restoredIdentity),
          ...ownedFileFailureEvidence(err),
        }));
        if (restoredIdentity) removeFileIfExactIdentityMatches(item.sourceAbsPath, restoredIdentity);
        continue;
      }
      // copyTrustedFileToOwnedFile verified the restored bytes, mode, times and path continuity.
      item.restoredSourceIdentity = restoredIdentity;
      item.sourceRemoved = false;
    }
    return restored;
  }

  // A destination restored from its backup holds the prior bytes as a NEW file, so the
  // provenance the index still holds (the replaced object's tuple) no longer describes it and
  // would make a later Preview refuse CreatorCrate's own restored output. The row is rewritten
  // (compare-and-set against the preflight path, hash and provenance) to the restored file's
  // own descriptor-derived tuple, or to null when that birth time is not durable: never to
  // whatever later occupies the path. Later rollback work may run after a restore, so
  // immediately before the write each restored object must still be exactly that file
  // (identity, then its recorded bytes, then identity again, under a post-hash write
  // fingerprint: ownedPathContentSnapshot) and, after every such read, a final metadata sweep
  // must prove each is still that object with the fingerprint its bytes were verified under
  // (one rewritten in place during a later restored output's read is never reconciled). On
  // any failure the backups stay and recovery is required.
  function reconcileRestoredWatermarkProvenance(projectId, items, projectDir, diagnostics) {
    const pending = items.filter((item) => item.provenanceReconcilePending);
    if (pending.length === 0) return true;
    const fail = (item, check) => recordRecoveryDiagnostic(diagnostics, () => ({
      assetId: item.asset?.id,
      itemIndex: item.stageIndex,
      artifactRole: 'restored-destination',
      check,
      ...observeDiagnosticArtifact(item.outputAbsPath, item.destinationRestoredIdentity),
    }));
    let unchanged = true;
    const fingerprints = new Map();
    for (const item of pending) {
      const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, item.outputAbsPath,
        item.destinationRestoredIdentity, watermarkDestinationContent(item));
      if (failure) {
        unchanged = false;
        fail(item, `provenance-reconcile-${OWNED_PATH_FAILURE_CHECKS[failure]}`);
      }
      fingerprints.set(item, fingerprint);
    }
    if (!unchanged) return false;
    for (const item of pending) {
      const change = ownedPathContinuityFailure(item.outputAbsPath, item.destinationRestoredIdentity,
        fingerprints.get(item));
      if (change) {
        unchanged = false;
        fail(item, `provenance-reconcile-final-${OWNED_PATH_FAILURE_CHECKS[change]}`);
      }
    }
    if (!unchanged) return false;
    try {
      assetRepository.reconcileGeneratedOutputProvenance(projectId, pending.map((item) => ({
        assetId: item.destinationAsset.id,
        expectedRelativePath: item.outputRelativePath,
        expectedGeneratedOutputSha256: item.destinationAsset.generated_output_sha256,
        expectedProvenance: item.destinationProvenance ?? null,
        provenance: item.destinationRestoredProvenance ?? null,
      })));
    } catch (err) {
      for (const item of pending) {
        recordRecoveryDiagnostic(diagnostics, () => ({
          assetId: item.asset?.id,
          itemIndex: item.stageIndex,
          artifactRole: 'restored-destination',
          check: 'provenance-reconcile-failed',
          ...(typeof err?.code === 'string' ? { errorCode: err.code } : {}),
        }));
      }
      return false;
    }
    for (const item of pending) item.provenanceReconcilePending = false;
    return true;
  }

  // Rolls back an uncommitted Watermark run. `recovered` means project and database state are
  // positively restored (outputs removed, destinations and sources restored, provenance
  // reconciled, archives removed or restored and their provenance reconciled through the shared
  // archive functions); dispensable residue alone never prevents it and is reported through the
  // diagnostics.
  async function rollbackWatermarkPublication(projectId, staging, items, projectDir, phase) {
    const diagnostics = stagingDiagnostics(staging);
    for (const mutation of watermarkMutationContexts(items)) {
      try {
        for (const row of watermarkEvidenceRows(mutation)) {
          if (processingRecoveryEvidenceRepository.setEvidenceRetentionReason(row.projectId, row.evidenceId,
            phase === 'database' ? WATERMARK_RETENTION.databaseFailed : WATERMARK_RETENTION.publicationFailed) === false) {
            throw new Error('The Watermark failure reason was not persisted.');
          }
        }
      } catch (err) {
        mutation.evidenceFailure ??= watermarkEvidenceFailure(err, 'finalization');
      }
    }
    const archivePlans = staging.artifacts || [];
    noteArchiveEvidenceFailure(archivePlans, phase);
    const artifactsRestored = await restoreArchiveArtifacts(archivePlans, projectDir, diagnostics);
    const outputsRestored = await restoreWatermarkOutputs(items, projectDir, diagnostics);
    const deletesRestored = await restoreWatermarkSourceDeletes(items, projectDir, diagnostics);
    const provenanceReconciled = reconcileRestoredWatermarkProvenance(projectId, items, projectDir, diagnostics);
    const artifactProvenanceReconciled = reconcileRestoredArchiveProvenance(projectId, archivePlans, projectDir,
      diagnostics);
    const artifactsCleanup = cleanupArchiveStaging(archivePlans, diagnostics, { projectDir });
    const cleanup = cleanupWatermarkStaging(staging, diagnostics, { projectDir });
    for (const item of items) {
      if (!(item.recoveryUnresolved || item.outputRestoreFailed || item.outputCreateUnclaimed
        || item.destinationRemoved || item.sourceRemoved || item.provenanceReconcilePending)) continue;
      const entry = [...diagnostics].reverse().find((diagnostic) => diagnostic.assetId === item.asset.id
        && diagnostic.itemIndex === item.stageIndex && diagnostic.artifactRole === 'published-output');
      settleWatermarkArtifact(item, 'published-output', { critical: true,
        diagnostic: item.outputRestoreFailed || item.outputCreateUnclaimed ? entry : undefined,
        observation: item.publicRecoveryObservation,
        retentionReason: item.outputCreateUnclaimed ? WATERMARK_RETENTION.publicUnclaimed
          : item.provenanceReconcilePending ? WATERMARK_RETENTION.provenanceFailed
            : item.sourceRemoved || (item.recoveryUnresolved && item.stagedDeletePath)
              ? WATERMARK_RETENTION.sourceRestorationFailed : WATERMARK_RETENTION.restorationFailed });
    }
    finishWatermarkMutations(items);
    deleteSettledWatermarkGroups(items);
    const evidenceFailure = watermarkMutationContexts(items).find((mutation) => mutation.evidenceFailure)?.evidenceFailure
      ?? archivePlans.find((plan) => plan.evidenceFailure)?.evidenceFailure;
    const restored = artifactsRestored && outputsRestored && deletesRestored && provenanceReconciled
      && artifactProvenanceReconciled;
    return {
      recovered: restored && artifactsCleanup.safe && cleanup.safe,
      evidence: diagnostics.length > 0,
      evidenceFailure,
      diagnostics: summarizeRecoveryDiagnostics(phase, diagnostics, items, {
        restored, cleanupSucceeded: artifactsCleanup.complete && cleanup.complete,
      }),
    };
  }

  // Conversion publication is descriptor-owned, like Watermark, Prompt and archives. Every
  // public file and private copy is its own exclusively created file whose ownership is the
  // exact identity of the descriptor that created it; a stage or source is only trusted content
  // input and its identity is never compared with, or adopted by, a copy. No hard link is made.
  //  - new output (other extension): created exclusively at its final pathname from the stage.
  //  - re-encode (same extension, originals kept): an owned private backup COPY of the source
  //    (`.source`); the source is unlinked only under two independent authorities (its own
  //    preflight exact identity plus the bytes it was converted from, and the complete backup
  //    still holding those bytes); the replacement is then created exclusively at the source
  //    pathname.
  //  - move: an owned public copy under `Originals`, then the source unlinked under the same
  //    double authority. The index moves the source row onto that copy.
  //  - delete: an owned private staged copy (`.original`), then the source unlinked likewise;
  //    the staged copy is discarded after the index commit.
  // Each item therefore holds at most one owned copy of its source (sourceCopy*). Rollback
  // removes a public file only by its own exact identity (no hash, size or Number fallback) and
  // recreates a removed source exclusively from its owned copy as a NEW file with the source's
  // bytes, mode and indexed times. The index commit is applyAssetConversions itself; rollback
  // only runs before it succeeds.

  // Conversion recovery evidence. Each selected source asset of one run is one mutation group
  // (runId = the processing job ID, itemKey `asset:<id>`): its stage, its owned copy of the
  // source and its public files are resolved only together. Roles reuse the diagnostics' artifact
  // roles. Private roles, the only ones a later cleanup may consider: the stage, a re-encode's
  // `.source` backup (original-backup) and a delete's `.original` copy (staged-original). Public
  // tracking roles, never private cleanup candidates: the converted file (published-output) and
  // a move's copy under Originals (originals-copy), which is the moved asset once committed.
  // Rows never authorize a filesystem action; the descriptor-owned identities held on each item
  // stay the only cleanup, removal and restoration authority. A deleted source asset leaves its
  // rows' asset link NULL; itemKey and the source/destination paths keep the item identifiable.
  const CONVERSION_PRIVATE_ROLES = Object.freeze(['stage-output', 'original-backup', 'staged-original']);
  const CONVERSION_PUBLIC_ROLES = Object.freeze(['published-output', 'originals-copy']);
  const CONVERSION_RETENTION = Object.freeze({
    pending: 'conversion-publication-pending',
    publicationFailed: 'conversion-publication-failed',
    databaseFailed: 'conversion-database-failed',
    restorationFailed: 'conversion-restoration-failed', // a converted output could not be withdrawn
    sourceRestorationFailed: 'conversion-source-restoration-failed', // a removed source is not proven back
    originalsWithdrawalFailed: 'conversion-originals-withdrawal-failed', // a rolled-back Originals copy stays
    publicUnclaimed: 'conversion-public-created-unclaimed',
    committed: 'conversion-committed',
    rolledBack: 'conversion-verified-rollback',
    residue: 'conversion-cleanup-residue',
  });

  function conversionEvidenceFailure(err, evidenceStage) {
    if (err?.code === 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED') return err;
    return Object.assign(new AssetProcessingError('Conversion recovery evidence could not be settled.', {
      code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', cause: err,
    }), { evidenceStage });
  }

  // Removes groups that never received evidence or a checkpoint (no Conversion file exists).
  function discardConversionMutationGroups(items) {
    for (const item of items) {
      if (!item.recoveryGroup) continue;
      try {
        processingRecoveryEvidenceRepository.deleteMutationGroup(item.recoveryGroup.projectId, item.recoveryGroup.groupId);
      } catch {
        // An empty, never-checkpointed group claims nothing.
      }
    }
  }

  function startConversionMutationGroups(projectId, runId, items, projectDir) {
    try {
      for (const item of items) {
        item.projectDir = projectDir;
        item.recoveryGroup = processingRecoveryEvidenceRecorder.startMutationGroup({
          projectId, operation: 'convert', runId, itemKey: `asset:${item.asset.id}`,
        });
      }
    } catch (err) {
      discardConversionMutationGroups(items);
      throw err;
    }
  }

  function conversionEvidenceRows(item) {
    const { projectId, groupId } = item.recoveryGroup;
    return processingRecoveryEvidenceRepository.listEvidenceByMutationGroup(projectId, groupId);
  }

  // One row per (role, artifact path): a move's two public files are distinct rows.
  function conversionItemEvidence(item, role) {
    const artifactPath = role === 'stage-output' ? item.stageOutput
      : role === 'published-output' ? conversionOutputPath(item)
        : item.sourceCopyRole === role ? item.sourceCopyPath : undefined;
    if (!artifactPath) return undefined;
    const relative = projectRelativePath(item.projectDir, artifactPath);
    return conversionEvidenceRows(item).find((row) => row.artifactRole === role && row.artifactPath === relative);
  }

  function conversionIntent(item, role, absPath, content) {
    const outputRelativePath = item.sameExtension ? item.sourceRelativePath : item.outputRelativePath;
    return {
      assetId: item.asset.id, artifactRole: role, retentionReason: CONVERSION_RETENTION.pending,
      artifactPath: projectRelativePath(item.projectDir, absPath),
      sourcePath: item.sourceRelativePath,
      // A copy of the source names where it would be restored; the others where they publish.
      destinationPath: role === 'original-backup' || role === 'staged-original' ? item.sourceRelativePath
        : role === 'originals-copy' ? item.originalRelativePath : outputRelativePath,
      expectedSize: content.size, expectedSha256: content.sha256,
    };
  }

  // After the durable checkpoint and before the mutation it guards, the evidence a rollback of
  // that mutation needs becomes recovery-critical. A failure stops the mutation and withholds
  // this item's cleanup and resolution, so every row, file and the checkpoint stay conservative.
  function promoteConversionEvidence(item, roles) {
    try {
      for (const role of roles) {
        const row = conversionItemEvidence(item, role);
        if (row) item.recoveryGroup.markRecoveryCritical(row.evidenceId, { retentionReason: CONVERSION_RETENTION.pending });
      }
    } catch (err) {
      item.evidenceWithheld = true;
      throw conversionEvidenceFailure(err, 'finalization');
    }
  }

  // Mirrors the existing diagnostics of this item and role (no evidence-only filesystem read).
  // A public row whose recorded object was withdrawn keeps `replaced` once another object (a
  // restored source) holds its path, whatever later identity-only diagnostics of that path say.
  function observeConversionEvidence(item, row, { diagnostic, observation } = {}) {
    let next = observation;
    if (next === undefined) {
      next = row.observation;
      const history = (stagingDiagnostics(item.staging) ?? []).filter((entry) => entry.assetId === item.asset.id
        && entry.itemIndex === item.stageIndex && entry.artifactRole === row.artifactRole);
      for (const entry of history) next = watermarkDiagnosticObservation(entry, next);
      if (diagnostic) next = watermarkDiagnosticObservation(diagnostic, next);
    }
    if (row.artifactRole === 'published-output' && row.identity && item.sameExtension && item.restoredSourceIdentity
      && !['missing', 'unavailable'].includes(next)) next = 'replaced';
    if (row.identity === null && next === 'present') next = 'ownership-unknown';
    if (next === 'unchecked') return;
    if (processingRecoveryEvidenceRepository.setEvidenceObservation(row.projectId, row.evidenceId, next) === false) {
      throw conversionEvidenceFailure(undefined, 'observation');
    }
  }

  // Called only after the filesystem proved a private artifact removed or absent.
  function deleteConversionEvidence(item, row) {
    try {
      if (processingRecoveryEvidenceRepository.deleteEvidence(row.projectId, row.evidenceId) === false) {
        throw new Error('The Conversion evidence row was not deleted.');
      }
    } catch (err) {
      item.evidenceFailure ??= conversionEvidenceFailure(err, 'deletion');
    }
  }

  // Settles one artifact's row after the existing filesystem decision. A public row is never
  // made dispensable and never deleted here: it retires only through its item's resolution. A
  // failure withholds the item's later private disposal and resolution unless it was retaining.
  function settleConversionArtifact(item, role, {
    lifecycle, retentionReason, diagnostic, observation, history = false, absent = false,
  } = {}) {
    try {
      const row = conversionItemEvidence(item, role);
      if (!row) return true;
      if (lifecycle === 'recovery-critical') item.recoveryGroup.markRecoveryCritical(row.evidenceId, { retentionReason });
      else if (lifecycle === 'dispensable' && CONVERSION_PRIVATE_ROLES.includes(role)) {
        item.recoveryGroup.markDispensable(row.evidenceId, { retentionReason });
      }
      if (absent) observeConversionEvidence(item, row, { observation: 'missing' });
      else if (diagnostic || observation || history) observeConversionEvidence(item, row, { diagnostic, observation });
      if (absent && CONVERSION_PRIVATE_ROLES.includes(role)) deleteConversionEvidence(item, row);
      return true;
    } catch (err) {
      item.evidenceFailure ??= conversionEvidenceFailure(err, 'finalization');
      if (lifecycle !== 'recovery-critical') item.evidenceWithheld = true;
      return false;
    }
  }

  // Whole-item resolution: every mutation of the item must be positively safe.
  function conversionItemUnresolved(item) {
    return !!(item.outputRestoreFailed || item.outputCreateUnclaimed || item.sourceRemoved || item.recoveryUnresolved);
  }

  // Before rollback begins, every row names the failing phase, so a crash during rollback still
  // explains it. A failed write is propagated once project state is otherwise safe.
  function noteConversionFailurePhase(items, phase) {
    const retentionReason = phase === 'database'
      ? CONVERSION_RETENTION.databaseFailed : CONVERSION_RETENTION.publicationFailed;
    for (const item of items) {
      if (!item.recoveryGroup) continue;
      try {
        for (const row of conversionEvidenceRows(item)) {
          if (processingRecoveryEvidenceRepository.setEvidenceRetentionReason(row.projectId, row.evidenceId,
            retentionReason) === false) throw new Error('The Conversion failure reason was not persisted.');
        }
      } catch (err) {
        item.evidenceFailure ??= conversionEvidenceFailure(err, 'finalization');
      }
    }
  }

  // After rollback cleanup: an unresolved item's public rows stay recovery-critical with the
  // reason and observation its rollback established. A public row whose create never began only
  // records the intent and is left unobserved.
  function settleUnresolvedConversionPublicEvidence(items) {
    for (const item of items) {
      if (!item.recoveryGroup || !conversionItemUnresolved(item)) continue;
      const itemReason = item.outputCreateUnclaimed || item.originalsCreateUnclaimed ? CONVERSION_RETENTION.publicUnclaimed
        : item.sourceRemoved || item.sourceRestoreUnverified ? CONVERSION_RETENTION.sourceRestorationFailed
          : item.outputRestoreFailed ? CONVERSION_RETENTION.restorationFailed
            : item.originalsWithdrawalFailed ? CONVERSION_RETENTION.originalsWithdrawalFailed
              : CONVERSION_RETENTION.restorationFailed;
      settleConversionArtifact(item, 'published-output', {
        lifecycle: 'recovery-critical',
        retentionReason: item.outputCreateUnclaimed ? CONVERSION_RETENTION.publicUnclaimed
          : item.outputRestoreFailed ? CONVERSION_RETENTION.restorationFailed : itemReason,
        ...(item.outputRestoreFailed || item.outputCreateUnclaimed ? { history: true }
          : item.outputWithdrawn ? { observation: item.sameExtension && item.restoredSourceIdentity ? 'replaced' : 'missing' }
            : {}),
      });
      // Settled by cleanup when it was retained or could not be withdrawn.
      if (item.sourceCopyPublic && !item.originalsSettled) {
        settleConversionArtifact(item, 'originals-copy', {
          lifecycle: 'recovery-critical', retentionReason: itemReason,
          ...(item.originalsWithdrawn ? { observation: 'missing' } : {}),
        });
      }
    }
  }

  // Resolves each fully safe item's group in autocommit, and only then retires its public
  // tracking rows. A resolution failure never rolls back committed state or restores anything:
  // the item keeps its checkpoint and rows, and its private copies are left in place.
  function finishConversionMutations(items, { committed = false } = {}) {
    for (const item of items) {
      if (!item.recoveryGroup || item.evidenceWithheld || (!committed && conversionItemUnresolved(item))) continue;
      try {
        item.recoveryGroup.resolveMutation();
        item.recoveryResolved = true;
      } catch (err) {
        item.evidenceWithheld = true;
        item.evidenceFailure ??= conversionEvidenceFailure(err, 'resolution');
        continue;
      }
      try {
        for (const row of conversionEvidenceRows(item)) {
          if (CONVERSION_PUBLIC_ROLES.includes(row.artifactRole)) deleteConversionEvidence(item, row);
        }
      } catch (err) {
        item.evidenceFailure ??= conversionEvidenceFailure(err, 'deletion');
      }
    }
  }

  // A resolved group whose rows are all gone is deleted; residue keeps its group as context.
  function deleteSettledConversionGroups(items) {
    for (const item of items) {
      if (!item.recoveryResolved) continue;
      try {
        if (conversionEvidenceRows(item).length) continue;
        if (processingRecoveryEvidenceRepository.deleteMutationGroup(item.recoveryGroup.projectId,
          item.recoveryGroup.groupId) === false) throw new Error('The empty Conversion mutation group was not deleted.');
      } catch (err) {
        item.evidenceFailure ??= conversionEvidenceFailure(err, 'deletion');
      }
    }
  }

  // Inside the commit transaction, together with the asset/index changes: private copies become
  // dispensable and public rows record the committed state the final sweep just proved. A
  // failure throws, rolling back both.
  function finalizeCommittedConversionEvidence(items) {
    for (const item of items) {
      for (const row of conversionEvidenceRows(item)) {
        if (CONVERSION_PRIVATE_ROLES.includes(row.artifactRole)) {
          item.recoveryGroup.markDispensable(row.evidenceId, { retentionReason: CONVERSION_RETENTION.committed });
          continue;
        }
        try {
          if (processingRecoveryEvidenceRepository.setEvidenceRetentionReason(row.projectId, row.evidenceId,
            CONVERSION_RETENTION.committed) === false
            || processingRecoveryEvidenceRepository.setEvidenceObservation(row.projectId, row.evidenceId,
              'present') === false) throw new Error('The committed Conversion evidence was not persisted.');
        } catch (err) {
          throw conversionEvidenceFailure(err, 'finalization');
        }
      }
    }
  }

  function conversionSourceContent(item) {
    return { size: item.sourceSize, sha256: item.sourceSha256 };
  }

  function conversionOutputContent(item) {
    return { size: item.outputSize, sha256: item.outputSha256 };
  }

  // A re-encode publishes over its own source pathname.
  function conversionOutputPath(item) {
    return item.sameExtension ? item.sourceAbsPath : item.outputAbsPath;
  }

  function conversionSourceTimes(item) {
    return {
      atime: indexedTimeSeconds(item.sourceStats.atime),
      mtime: indexedTimeSeconds(item.sourceStats.mtime),
    };
  }

  function conversionDiagnostic(item, artifactRole, check, details = {}) {
    recordRecoveryDiagnostic(stagingDiagnostics(item.staging), () => ({
      assetId: item.asset?.id,
      itemIndex: item.stageIndex,
      artifactRole,
      check,
      ...details,
    }));
  }

  // The owned copy of a source must still be its exact descriptor-created object and hold the
  // source's converted-from bytes: ownership and content are both required, and neither ever
  // authorizes anything about the source itself. Returns the write fingerprint its bytes were
  // verified under.
  function assertConversionSourceCopyValid(item, projectDir, stage) {
    const { failure, fingerprint } = !item.sourceCopyComplete
      ? { failure: 'identity' }
      : ownedPathContentSnapshot(projectDir, item.sourceCopyPath, item.sourceCopyExactIdentity,
        conversionSourceContent(item));
    if (!failure) return fingerprint;
    failConversionSourceCopy(item, `${stage}-copy-${OWNED_PATH_FAILURE_CHECKS[failure]}`);
  }

  function failConversionSourceCopy(item, check) {
    conversionDiagnostic(item, item.sourceCopyRole, check,
      observeDiagnosticArtifact(item.sourceCopyPath, item.sourceCopyExactIdentity));
    throw new AssetProcessingError('The owned copy of a selected source changed during conversion.', {
      code: 'FILESYSTEM_OPERATION_FAILED',
    });
  }

  // Copies the source into its owned copy (`role`: original-backup | originals-copy |
  // staged-original) and returns the step that unlinks the source, which the caller runs only
  // once its recovery checkpoint is durable. Destructive authority is independent and double,
  // re-proven immediately before the unlink exactly as Watermark replaces a destination: the
  // copy (identity, bytes, identity), the source (its own preflight exact identity and the bytes
  // it was converted from), the copy again, then a metadata-only sweep of both (no content read
  // separates those final proofs from the unlink). Unknown (zero) source IDs fail closed before
  // anything is created. EEXIST never overwrites or adopts what is there. The copy's evidence
  // intent is durable before it is created and its exact identity before a byte is written; an
  // Originals copy is a public create, checkpointed first.
  async function prepareConversionSourceRemoval(item, projectDir, role) {
    const publicCopy = role === 'originals-copy';
    const sourceChanged = (cause) => new AssetProcessingError('A selected source changed during conversion.', {
      code: 'SOURCE_CHANGED', ...(cause ? { cause } : {}),
    });
    revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
    inspectSource(item.sourceAbsPath);
    if (!isKnownDirectoryIdentity(item.sourceExactIdentity)) {
      conversionDiagnostic(item, role, 'copy-create-failed', {
        proof: 'reference-identity-unknown',
        ...observeDiagnosticArtifact(item.sourceAbsPath, item.sourceExactIdentity),
      });
      throw new AssetProcessingError('CreatorCrate could not establish the exact identity of a selected source.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    }
    if (!pathMatchesExactIdentity(item.sourceAbsPath, item.sourceExactIdentity)) throw sourceChanged();

    const copyPath = publicCopy
      ? item.originalAbsPath
      : stagingFile(item.staging, `${item.stageIndex}.${role === 'original-backup' ? 'source' : 'original'}`);
    if (publicCopy) revalidatePublicationTarget(projectDir, copyPath, 'ORIGINAL_PATH_UNSAFE', 'Original');
    item.sourceCopyRole = role;
    item.sourceCopyPath = copyPath;
    item.sourceCopyPublic = publicCopy;
    const sourceContent = conversionSourceContent(item);
    let copying = false;
    try {
      await item.recoveryGroup.createArtifact({
        intent: conversionIntent(item, role, copyPath, sourceContent),
        ...(publicCopy ? { checkpoint: 'public-create' } : {}),
        create: ({ onCreated, onOwned }) => {
          copying = true;
          return copyTrustedFileToOwnedFile({
            sourcePath: item.sourceAbsPath,
            sourceExactIdentity: item.sourceExactIdentity,
            destinationPath: copyPath,
            expectedSha256: sourceContent.sha256,
            expectedSize: sourceContent.size,
            mode: item.sourceStats.mode & 0o7777,
            // A move keeps the original's times on its Originals copy.
            ...(publicCopy ? { times: conversionSourceTimes(item) } : {}),
            onCreated: () => { item.sourceCopyCreateStarted = true; onCreated(); },
            onOwned: (identity) => { item.sourceCopyExactIdentity = identity; onOwned(identity); },
          });
        },
        discardOwned: (identity) => removeFileIfExactIdentityMatches(copyPath, identity),
      });
      item.sourceCopyComplete = true;
    } catch (err) {
      // An evidence failure before the copy began left nothing to diagnose.
      if (!copying) throw err;
      // An owned partial copy is removed later only by its exact identity. A created copy whose
      // descriptor never proved ownership is never claimed: private, it is residue (the source
      // is untouched); public, it is an unresolved project path.
      const unclaimed = item.sourceCopyCreateStarted && !item.sourceCopyExactIdentity;
      if (publicCopy && unclaimed) item.originalsCreateUnclaimed = true;
      conversionDiagnostic(item, role, unclaimed ? 'copy-identity-inspection-failed' : 'copy-create-failed', {
        ...ownedFileFailureEvidence(err?.code === 'RECOVERY_REQUIRED' ? err.cause ?? err : err),
        ...observeDiagnosticPath(copyPath, item.sourceCopyExactIdentity),
        ...(publicCopy && unclaimed ? { cleanup: 'recovery-critical' } : {}),
      });
      if (publicCopy && err?.code === 'EEXIST') {
        throw new AssetProcessingError('An originals destination appeared during processing.', {
          code: 'ORIGINAL_DESTINATION_CONFLICT',
          cause: err,
        });
      }
      // Recovery evidence failures (persistence, or an unclaimed checkpointed create) stand.
      if (err instanceof AssetProcessingError) throw err;
      if (err instanceof OwnedFileError && (err.reason === OWNED_FILE_FAILURE.sourceChanged
        || err.reason === OWNED_FILE_FAILURE.sourceUnsafe
        || err.reason === OWNED_FILE_FAILURE.contentMismatch)) {
        throw sourceChanged(err);
      }
      throw new AssetProcessingError(publicCopy
        ? 'CreatorCrate could not move an original into originals.'
        : 'CreatorCrate could not copy a selected source before replacing it.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }

    const verifySource = () => {
      const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, item.sourceAbsPath,
        item.sourceExactIdentity, sourceContent);
      if (!failure) return fingerprint;
      conversionDiagnostic(item, 'existing-source', `remove-source-${OWNED_PATH_FAILURE_CHECKS[failure]}`,
        observeDiagnosticArtifact(item.sourceAbsPath, item.sourceExactIdentity));
      throw sourceChanged();
    };
    return () => {
      assertConversionSourceCopyValid(item, projectDir, 'remove');
      const sourceFingerprint = verifySource();
      const copyFingerprint = assertConversionSourceCopyValid(item, projectDir, 'remove-final');
      const sourceChange = ownedPathContinuityFailure(item.sourceAbsPath, item.sourceExactIdentity, sourceFingerprint);
      if (sourceChange) {
        conversionDiagnostic(item, 'existing-source', `remove-final-source-${OWNED_PATH_FAILURE_CHECKS[sourceChange]}`,
          observeDiagnosticArtifact(item.sourceAbsPath, item.sourceExactIdentity));
        throw sourceChanged();
      }
      const copyChange = ownedPathContinuityFailure(copyPath, item.sourceCopyExactIdentity, copyFingerprint);
      if (copyChange) failConversionSourceCopy(item, `remove-final-copy-${OWNED_PATH_FAILURE_CHECKS[copyChange]}`);

      try {
        fs.unlinkSync(item.sourceAbsPath);
      } catch (err) {
        // Unless the pathname still holds the exact source, it no longer does: rollback must then
        // restore it (a foreign occupant is never removed and leaves it unresolved).
        if (!pathMatchesExactIdentity(item.sourceAbsPath, item.sourceExactIdentity)) item.sourceRemoved = true;
        throw new AssetProcessingError('CreatorCrate could not remove a selected source.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
      item.sourceRemoved = true;
      try {
        fs.lstatSync(item.sourceAbsPath);
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw new AssetProcessingError('CreatorCrate could not verify a selected source was removed.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
      throw new AssetProcessingError('The selected source still exists after it was removed.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    };
  }

  // A move or delete removes its source only once the item's 'unlink' checkpoint is durable and
  // its owned copy (the last copy of the source afterwards) is recovery-critical.
  async function moveConversionSourceToOwnedCopy(item, projectDir, role) {
    const removeSource = await prepareConversionSourceRemoval(item, projectDir, role);
    item.recoveryGroup.beginMutation('unlink', () => promoteConversionEvidence(item, [role]));
    removeSource();
  }

  // The public output (a new pathname, or a re-encode's source pathname after its source was
  // removed) is created exclusively and filled from the validated stage (trusted content input
  // only). Its ownership is its own descriptor identity, recorded before any byte is written:
  // the only rollback authority. EEXIST never overwrites or adopts what appeared. Its public
  // tracking intent and checkpoint ('replace' for a re-encode, whose `removeSource` unlinks the
  // source first) are durable, and the private evidence its rollback needs is recovery-critical,
  // before the source is removed or the output created.
  async function publishConversionOutput(item, projectDir, removeSource) {
    const outputPath = conversionOutputPath(item);
    const revalidate = () => {
      if (item.sameExtension) {
        revalidatePublicationTarget(projectDir, outputPath, 'SOURCE_PATH_UNSAFE', 'Source');
      } else {
        revalidatePublicationTarget(projectDir, outputPath, 'OUTPUT_PATH_UNSAFE', 'Output');
      }
    };
    revalidate();
    let publishing = false;
    try {
      await item.recoveryGroup.createArtifact({
        intent: conversionIntent(item, 'published-output', outputPath, conversionOutputContent(item)),
        checkpoint: removeSource ? 'replace' : 'public-create',
        create: ({ onCreated, onOwned }) => {
          promoteConversionEvidence(item, ['stage-output', 'original-backup']);
          if (removeSource) {
            removeSource();
            revalidate();
          }
          publishing = true;
          return copyTrustedFileToOwnedFile({
            sourcePath: item.stageOutput,
            sourceExactIdentity: item.stageOutputExactIdentity,
            destinationPath: outputPath,
            expectedSha256: item.outputSha256,
            expectedSize: item.outputSize,
            onCreated: () => { item.outputCreateStarted = true; onCreated(); },
            onOwned: (identity) => { item.outputExactIdentity = identity; onOwned(identity); },
          });
        },
        discardOwned: (identity) => removeFileIfExactIdentityMatches(outputPath, identity),
      });
      const outputStats = fs.lstatSync(outputPath);
      if (!pathMatchesExactIdentity(outputPath, item.outputExactIdentity)) {
        throw new OwnedFileError(OWNED_FILE_FAILURE.pathnameChanged, 'The published converted output changed.');
      }
      item.outputStats = outputStats;
    } catch (err) {
      // Evidence, source-removal and target failures before the create began stand as they are.
      if (!publishing) throw err;
      // The exclusive create succeeded but its descriptor never proved ownership (unknown IDs,
      // or the first inspection itself failed): a public path exists that is not ours to adopt
      // or remove. A failed open never sets outputCreateStarted.
      if (item.outputCreateStarted && !item.outputExactIdentity) item.outputCreateUnclaimed = true;
      conversionDiagnostic(item, 'published-output',
        item.outputCreateUnclaimed ? 'public-output-identity-inspection-failed' : 'publish-create-failed', {
          ...ownedFileFailureEvidence(err?.code === 'RECOVERY_REQUIRED' ? err.cause ?? err : err),
          ...observeDiagnosticPath(outputPath, item.outputExactIdentity),
          ...(item.outputCreateUnclaimed ? { cleanup: 'recovery-critical' } : {}),
        });
      // Recovery evidence failures (persistence, or an unclaimed checkpointed create) stand.
      if (err instanceof AssetProcessingError) throw err;
      if (err?.code === 'EEXIST') {
        throw new AssetProcessingError(item.sameExtension
          ? 'A file appeared at a re-encoded source path during processing.'
          : 'A converted output destination appeared during processing.', {
          code: item.sameExtension ? 'SOURCE_CHANGED' : 'OUTPUT_DESTINATION_CONFLICT',
          cause: err,
        });
      }
      throw new AssetProcessingError('CreatorCrate could not publish a converted output.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
  }

  // Final pre-commit validation, immediately before the synchronous index transaction. The
  // index records every item's output (and moved original) size and mtime, and a re-encode's
  // animation classification from its stage bytes, all under one commit: a later item's reads
  // leave a window in which an earlier output could be displaced or rewritten in place. Each
  // public output and Originals copy must still be its exact descriptor-created object holding
  // the published bytes under a post-hash write fingerprint (which tolerates SMB metadata
  // settling across the first read); the recorded stats are read after that settling, and a
  // final metadata-only sweep then proves every object still holds that fingerprint.
  function revalidateConversionPublications(items, projectDir) {
    const snapshots = [];
    const settledStats = (absPath) => {
      try {
        return fs.lstatSync(absPath);
      } catch (err) {
        throw new AssetProcessingError('A converted file could not be inspected before it was recorded.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
    };
    for (const item of items) {
      const outputPath = conversionOutputPath(item);
      const output = ownedPathContentSnapshot(projectDir, outputPath, item.outputExactIdentity,
        conversionOutputContent(item));
      if (output.failure) {
        conversionDiagnostic(item, 'published-output', `precommit-${OWNED_PATH_FAILURE_CHECKS[output.failure]}`,
          observeDiagnosticArtifact(outputPath, item.outputExactIdentity));
        throw new AssetProcessingError(output.failure === 'unreadable'
          ? 'A converted output could not be read before it was recorded.'
          : 'A converted output changed before it could be recorded.', {
          code: output.failure === 'unreadable' ? 'FILESYSTEM_OPERATION_FAILED' : 'OUTPUT_DESTINATION_CONFLICT',
        });
      }
      item.outputStats = settledStats(outputPath);
      snapshots.push([item, 'published-output', outputPath, item.outputExactIdentity, output.fingerprint]);
      if (!item.sourceCopyPublic) continue;
      const original = ownedPathContentSnapshot(projectDir, item.sourceCopyPath, item.sourceCopyExactIdentity,
        conversionSourceContent(item));
      if (original.failure) {
        conversionDiagnostic(item, 'originals-copy', `precommit-${OWNED_PATH_FAILURE_CHECKS[original.failure]}`,
          observeDiagnosticArtifact(item.sourceCopyPath, item.sourceCopyExactIdentity));
        throw new AssetProcessingError(original.failure === 'unreadable'
          ? 'A moved original could not be read before it was recorded.'
          : 'A moved original changed before it could be recorded.', {
          code: original.failure === 'unreadable' ? 'FILESYSTEM_OPERATION_FAILED' : 'ORIGINAL_DESTINATION_CONFLICT',
        });
      }
      item.originalStats = settledStats(item.sourceCopyPath);
      snapshots.push([item, 'originals-copy', item.sourceCopyPath, item.sourceCopyExactIdentity, original.fingerprint]);
    }
    let unchanged = true;
    for (const [item, role, absPath, identity, fingerprint] of snapshots) {
      const change = ownedPathContinuityFailure(absPath, identity, fingerprint);
      if (!change) continue;
      unchanged = false;
      conversionDiagnostic(item, role, `precommit-final-${OWNED_PATH_FAILURE_CHECKS[change]}`,
        observeDiagnosticArtifact(absPath, identity));
    }
    if (!unchanged) {
      throw new AssetProcessingError('A converted file changed before it could be recorded.', {
        code: 'OUTPUT_DESTINATION_CONFLICT',
      });
    }
  }

  // Rollback of the public outputs: a created output is removed only while its pathname is
  // still the exact descriptor-created object. A foreign, uninspectable or unremovable output
  // stays (its stage is kept as evidence); a created-but-unclaimed output is never removed.
  function restoreConversionOutputs(items, diagnostics) {
    let restored = true;
    for (const item of [...items].reverse()) {
      const outputPath = conversionOutputPath(item);
      const fail = (check, details) => {
        restored = false;
        item.outputRestoreFailed = true;
        recordRecoveryDiagnostic(diagnostics, () => ({
          assetId: item.asset?.id,
          itemIndex: item.stageIndex,
          artifactRole: 'published-output',
          check,
          ...details(),
        }));
      };
      if (item.outputExactIdentity && !item.outputWithdrawn) {
        const removal = {};
        if (!removeFileIfExactIdentityMatches(outputPath, item.outputExactIdentity, removal)) {
          const check = { ownership: 'rollback-identity-mismatch', inspection: 'rollback-inspect' }[removal.failedStep]
            ?? 'rollback-unlink';
          fail(check, () => ({
            ...observeDiagnosticArtifact(outputPath, item.outputExactIdentity),
            ...(removal.errorCode ? { errorCode: removal.errorCode } : {}),
          }));
          continue;
        }
        item.outputWithdrawn = true;
      } else if (item.outputCreateUnclaimed) {
        // CreatorCrate created the public path but never learned its identity: whatever is
        // there can never be proven ours, so it stays and the item is unresolved.
        if (!pathIsAbsent(outputPath)) {
          fail('rollback-ownership-unproven', () => observeDiagnosticArtifact(outputPath));
          continue;
        }
        item.outputCreateUnclaimed = false;
      }
    }
    return restored;
  }

  // Rollback of removed sources: each returns from its owned copy (still its exact identity,
  // still the source's bytes) as a new, exclusively created file with the source's mode and
  // indexed times. The source pathname must be absent: EEXIST never overwrites or adopts a
  // foreign file, which leaves the item unresolved. The restored file gets a new identity; the
  // copy stays until cleanup re-proves the restored file (cleanupConversionStaging).
  async function restoreConversionSources(items, projectDir, diagnostics) {
    let restored = true;
    for (const item of [...items].reverse()) {
      if (!item.sourceRemoved) continue;
      const fail = (artifactRole, check, details) => {
        restored = false;
        recordRecoveryDiagnostic(diagnostics, () => ({
          assetId: item.asset?.id,
          itemIndex: item.stageIndex,
          artifactRole,
          check,
          ...details(),
        }));
      };
      const role = item.sourceCopyRole;
      const copyObservation = () => observeDiagnosticArtifact(item.sourceCopyPath, item.sourceCopyExactIdentity);
      const copyFailure = !item.sourceCopyComplete
        ? 'identity'
        : ownedPathContentFailure(projectDir, item.sourceCopyPath, item.sourceCopyExactIdentity,
          conversionSourceContent(item));
      if (copyFailure) {
        fail(role, isKnownDirectoryIdentity(item.sourceCopyExactIdentity)
          ? `restore-${OWNED_PATH_FAILURE_CHECKS[copyFailure]}` : 'restore-ownership-unproven', copyObservation);
        continue;
      }
      try {
        fs.lstatSync(item.sourceAbsPath);
        fail(role, 'restore-source-present', () => ({
          ...copyObservation(),
          referenceIdentity: observeDiagnosticArtifact(item.sourceAbsPath, item.sourceExactIdentity).identity,
        }));
        continue;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          fail(role, 'restore-source-inspect', () => ({
            ...copyObservation(),
            ...(typeof err.code === 'string' ? { errorCode: err.code } : {}),
          }));
          continue;
        }
      }
      try {
        revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
      } catch (err) {
        fail('restored-source', 'restore-destination-unsafe', () => ownedFileFailureEvidence(err.cause ?? err));
        continue;
      }
      let restoredIdentity;
      try {
        await copyTrustedFileToOwnedFile({
          sourcePath: item.sourceCopyPath,
          sourceExactIdentity: item.sourceCopyExactIdentity,
          destinationPath: item.sourceAbsPath,
          expectedSha256: item.sourceSha256,
          expectedSize: item.sourceSize,
          mode: item.sourceStats.mode & 0o7777,
          times: conversionSourceTimes(item),
          onOwned: (identity) => { restoredIdentity = identity; },
        });
      } catch (err) {
        fail('restored-source', 'restore-create-failed', () => ({
          ...observeDiagnosticArtifact(item.sourceAbsPath, restoredIdentity),
          ...ownedFileFailureEvidence(err),
        }));
        // A partial restore CreatorCrate owns is withdrawn (exact identity only), so no
        // unverified bytes stay at the source path; the copy remains the source.
        if (restoredIdentity) removeFileIfExactIdentityMatches(item.sourceAbsPath, restoredIdentity);
        continue;
      }
      // copyTrustedFileToOwnedFile verified the restored bytes, mode, times and path continuity.
      item.restoredSourceIdentity = restoredIdentity;
      item.sourceRemoved = false;
    }
    return restored;
  }

  // A restored source must, immediately before its owned copy is discarded, still be the exact
  // restored object holding the source's bytes under a post-hash write fingerprint that held
  // across a hash (ownedPathContentSnapshot, with its one conditional re-hash), so a write
  // landing after the hash read is never accepted. Nothing reads the restored source after it.
  function conversionRestoredSourceFailure(item, projectDir) {
    const { failure, unstable } = ownedPathContentSnapshot(projectDir, item.sourceAbsPath,
      item.restoredSourceIdentity, conversionSourceContent(item));
    if (!failure) return null;
    return unstable ? 'continuity' : failure;
  }

  // Cleanup of the Conversion artifacts, per item. `safe` answers "is project state resolved?";
  // `complete` "was every dispensable private artifact removed?". Before the commit an
  // unresolved item keeps its artifacts as recovery evidence: an output that could not be
  // removed (or was created but never claimed) keeps its stage; a removed source that was not
  // restored, or whose restored file no longer revalidates, keeps its owned copy. An owned
  // Originals copy is a PUBLIC file: without the commit it must be withdrawn (by its exact
  // identity, after the source is back), and one that cannot be is unresolved project state.
  // Every other owned artifact is a dispensable private copy: one that cannot be removed is
  // residue, and a path CreatorCrate never owned is left untouched (residue while present).
  // After the commit (`committed`) removed sources are the intended state and the Originals copy
  // is the moved asset, so nothing is unresolved. Removal always requires the artifact's own
  // descriptor-derived exact identity.
  // Each outcome is mirrored in the item's evidence rows, always after the filesystem decision: a
  // retained artifact's row becomes recovery-critical; a disposable copy's row becomes dispensable
  // before its removal and is deleted only once it is proven absent, or stays as cleanup residue.
  // An item whose evidence could not be settled keeps its private copies in place.
  function cleanupConversionStaging(staging, diagnostics, { committed = false, projectDir } = {}) {
    let safe = true;
    let complete = true;
    const disposedReason = committed ? CONVERSION_RETENTION.committed : CONVERSION_RETENTION.rolledBack;
    for (const item of staging.items) {
      const base = (artifactRole) => ({ assetId: item.asset?.id, itemIndex: item.stageIndex, artifactRole });
      const retain = (entry, absPath, identity, retentionReason) => {
        safe = false;
        complete = false;
        item.recoveryUnresolved = true;
        const diagnostic = {
          ...entry,
          ...observeDiagnosticArtifact(absPath, identity),
          cleanup: 'recovery-critical',
        };
        recordRecoveryDiagnostic(diagnostics, () => diagnostic);
        settleConversionArtifact(item, entry.artifactRole, { lifecycle: 'recovery-critical', retentionReason, diagnostic });
      };
      const dispose = (entry, absPath, identity) => {
        if (!absPath) return;
        if (item.evidenceWithheld || !settleConversionArtifact(item, entry.artifactRole, {
          lifecycle: 'dispensable', retentionReason: disposedReason,
        })) {
          complete = false;
          return;
        }
        const outcome = {};
        const result = cleanupPrivateStage(absPath, identity, outcome);
        // Unowned residue is left untouched; cleanup is complete only when nothing is there.
        if (result === STAGE_CLEANUP.clean || (result === STAGE_CLEANUP.residue && pathIsAbsent(absPath))) {
          settleConversionArtifact(item, entry.artifactRole, { absent: true });
          return;
        }
        complete = false;
        const diagnostic = {
          ...cleanupFailureDiagnostic(entry, absPath, identity, outcome),
          cleanup: 'residue',
        };
        recordRecoveryDiagnostic(diagnostics, () => diagnostic);
        settleConversionArtifact(item, entry.artifactRole, {
          lifecycle: 'dispensable', retentionReason: CONVERSION_RETENTION.residue, diagnostic,
        });
      };

      if (item.stageOutput && !committed && (item.outputRestoreFailed || item.outputCreateUnclaimed)) {
        retain({ ...base('stage-output'), check: 'retained-unresolved-publication' },
          item.stageOutput, item.stageOutputExactIdentity,
          item.outputCreateUnclaimed ? CONVERSION_RETENTION.publicUnclaimed : CONVERSION_RETENTION.restorationFailed);
      } else {
        dispose(base('stage-output'), item.stageOutput, item.stageOutputExactIdentity);
      }

      if (!item.sourceCopyPath) continue;
      const role = item.sourceCopyRole;
      if (committed) {
        if (!item.sourceCopyPublic) dispose(base(role), item.sourceCopyPath, item.sourceCopyExactIdentity);
        continue;
      }
      if (item.sourceRemoved) {
        // An unrestored copy is the last trusted copy of the source.
        retain({ ...base(role), check: 'retained-unrestored' }, item.sourceCopyPath, item.sourceCopyExactIdentity,
          CONVERSION_RETENTION.sourceRestorationFailed);
        item.originalsSettled = item.sourceCopyPublic;
        continue;
      }
      const restoredFailure = item.restoredSourceIdentity ? conversionRestoredSourceFailure(item, projectDir) : null;
      if (restoredFailure) {
        // The restored source changed after its restore: the copy is still the last known-good
        // copy of the source, so it stays as recovery evidence. The source is never repaired here.
        recordRecoveryDiagnostic(diagnostics, () => ({
          ...base('restored-source'),
          check: `restored-source-${RESTORED_SOURCE_FAILURE_CHECKS[restoredFailure]}`,
          ...observeDiagnosticArtifact(item.sourceAbsPath, item.restoredSourceIdentity),
        }));
        item.sourceRestoreUnverified = true;
        retain({ ...base(role), check: 'retained-restored-source-changed' },
          item.sourceCopyPath, item.sourceCopyExactIdentity, CONVERSION_RETENTION.sourceRestorationFailed);
        item.originalsSettled = item.sourceCopyPublic;
        continue;
      }
      if (!item.sourceCopyPublic) {
        dispose(base(role), item.sourceCopyPath, item.sourceCopyExactIdentity);
        continue;
      }
      // The public Originals copy is withdrawn as project-state rollback, never as private
      // cleanup: its tracking row only records the outcome and retires with the item's resolution.
      if (item.sourceCopyExactIdentity) {
        const outcome = {};
        if (!removeFileIfExactIdentityMatches(item.sourceCopyPath, item.sourceCopyExactIdentity, outcome)) {
          safe = false;
          complete = false;
          item.recoveryUnresolved = true;
          item.originalsWithdrawalFailed = true;
          const diagnostic = cleanupFailureDiagnostic(base(role), item.sourceCopyPath, item.sourceCopyExactIdentity,
            outcome);
          recordRecoveryDiagnostic(diagnostics, () => diagnostic);
          settleConversionArtifact(item, role, {
            lifecycle: 'recovery-critical', retentionReason: CONVERSION_RETENTION.originalsWithdrawalFailed, diagnostic,
          });
          item.originalsSettled = true;
        } else {
          item.originalsWithdrawn = true;
        }
      } else if (item.sourceCopyCreateStarted && !pathIsAbsent(item.sourceCopyPath)) {
        // Created at the public Originals path without a proven identity: never removed here.
        retain({ ...base(role), check: 'rollback-ownership-unproven' }, item.sourceCopyPath, undefined,
          CONVERSION_RETENTION.publicUnclaimed);
        item.originalsSettled = true;
      }
    }
    // The workspace itself is retained (directory policy).
    return { safe, complete };
  }

  // Rolls back an uncommitted Conversion run. `recovered` means project state is positively
  // restored (outputs removed, removed sources recreated and revalidated, Originals copies
  // withdrawn); dispensable private residue alone never prevents it and is reported through the
  // diagnostics. Evidence follows the verified result per item: a fully safe item's group is
  // resolved and its public rows retired; an unresolved item keeps its checkpoint and rows.
  async function rollbackConversion(staging, items, projectDir, phase) {
    const diagnostics = stagingDiagnostics(staging);
    noteConversionFailurePhase(items, phase);
    const outputsRestored = restoreConversionOutputs(items, diagnostics);
    const sourcesRestored = await restoreConversionSources(items, projectDir, diagnostics);
    const cleanup = cleanupConversionStaging(staging, diagnostics, { projectDir });
    settleUnresolvedConversionPublicEvidence(items);
    finishConversionMutations(items);
    deleteSettledConversionGroups(items);
    const restored = outputsRestored && sourcesRestored;
    return {
      recovered: restored && cleanup.safe,
      evidence: diagnostics.length > 0,
      evidenceFailure: items.find((item) => item.evidenceFailure)?.evidenceFailure,
      diagnostics: summarizeRecoveryDiagnostics(phase, diagnostics, items, {
        restored, cleanupSucceeded: cleanup.complete,
      }),
    };
  }

  function createStaging(projectDir) {
    const workspace = createStagingDirectory(
      projectDir,
      '.creatorcrate-convert-staging',
      'CreatorCrate could not prepare conversion staging.',
    );
    return { ...workspace, items: [] };
  }

  async function stageOutput(item, staging, options, index) {
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during conversion preflight.', {
        code: 'SOURCE_CHANGED',
      });
    }

    const stageOutputPath = stagingFile(staging, `${index}.output`);
    item.stageOutput = stageOutputPath;
    item.staging = staging;
    item.stageIndex = index;
    try {
      const sourceBuffer = readSourceBytes(item);
      // The converted-from bytes are the expected content of every owned copy of the source
      // and of a restored source; mode and times come from the same inspected source.
      item.sourceSize = sourceBuffer.length;
      item.sourceSha256 = createHash('sha256').update(sourceBuffer).digest('hex');
      item.sourceStats = currentStats;
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
      item.outputSize = outputBuffer.length;
      item.outputSha256 = createHash('sha256').update(outputBuffer).digest('hex');
      // Owned exact identity comes from the exclusive descriptor, never the pathname. The stage's
      // evidence intent (with its expected content) is durable before it is created, and its
      // identity before a byte is written.
      await item.recoveryGroup.createArtifact({
        intent: conversionIntent(item, 'stage-output', stageOutputPath, conversionOutputContent(item)),
        create: ({ onCreated, onOwned }) => writeOwnedStageFile(
          stageOutputPath,
          (descriptor) => writeBytesToDescriptor(descriptor, outputBuffer),
          { onCreated, onOwned: (identity) => { item.stageOutputExactIdentity = identity; onOwned(identity); } },
        ),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(stageOutputPath, identity),
      });
      inspectGeneratedFile(stageOutputPath, 'CONVERSION_OUTPUT_INVALID');
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
      // Classify the staged bytes with the scanner's own inspector: the
      // published file holds exactly these bytes, so an in-place re-encode can
      // record its complete new source state in the one generation-advancing update.
      item.outputAnimated = inspectSourceAnimation(stageOutputPath, options.format);
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      throw new AssetProcessingError('Sharp could not convert a selected image.', {
        code: 'CONVERSION_FAILED',
        cause: err,
      });
    }
  }

  function ensureOriginalDirectories(items) {
    const byPath = new Set();
    for (const item of items) {
      const key = pathKey(item.originalsDirAbsPath);
      if (byPath.has(key)) continue;
      try {
        fs.mkdirSync(item.originalsDirAbsPath);
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw new AssetProcessingError('CreatorCrate could not prepare the originals directory.', {
            code: 'FILESYSTEM_OPERATION_FAILED',
            cause: err,
          });
        }
      }
      // Created now, pre-existing or raced in: the directory is validated before use and is
      // never claimed as owned (directory policy), so it is never removed.
      if (!inspectOriginalsDirectory(item.originalsDirAbsPath).exists) {
        throw new AssetProcessingError('CreatorCrate could not prepare the originals directory.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
        });
      }
      byPath.add(key);
    }
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
      sourceAnimated: item.outputAnimated,
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

  async function convertAssetsLocked(projectId, assetIds, options, progress, reportResidue, runId) {
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
      const sourceExactIdentity = exactFileIdentity(sourceAbsPath);

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
        sourceExactIdentity,
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

    // One mutation group per selected source, durable before any Conversion file exists.
    startConversionMutationGroups(projectId, runId, items, projectDir);
    let staging;
    try {
      staging = createStaging(projectDir);
    } catch (err) {
      discardConversionMutationGroups(items);
      throw err;
    }
    staging.items = items;

    const failAfterRollback = (rollback, message, cause) => {
      const failure = new AssetProcessingError(message, { code: 'RECOVERY_REQUIRED', ...(cause ? { cause } : {}) });
      failure.recoveryDiagnostics = rollback.diagnostics;
      if (rollback.evidenceFailure) failure.observationFailure = rollback.evidenceFailure;
      return failure;
    };

    try {
      await processingConcurrencyService.mapBounded(items, async (item, index) => {
        await stageOutput(item, staging, options, index);
        progress.advance();
      });

      if (options.originalHandling === 'move') {
        ensureOriginalDirectories(items);
      }

      for (const item of items) {
        // A re-encode first copies its source into an owned private backup; the source is
        // unlinked only under the replacement's own durable checkpoint.
        const removeSource = item.sameExtension
          ? await prepareConversionSourceRemoval(item, projectDir, 'original-backup') : undefined;
        await publishConversionOutput(item, projectDir, removeSource);
        if (options.originalHandling === 'move') {
          await moveConversionSourceToOwnedCopy(item, projectDir, 'originals-copy');
        } else if (options.originalHandling === 'delete') {
          await moveConversionSourceToOwnedCopy(item, projectDir, 'staged-original');
        }
      }
      // Final pre-commit validation; the synchronous index transaction follows directly.
      revalidateConversionPublications(items, projectDir);
    } catch (err) {
      const rollback = await rollbackConversion(staging, items, projectDir, 'publication');
      if (!rollback.recovered) {
        throw failAfterRollback(rollback,
          'Conversion changed the filesystem but could not safely complete or clean up. Inspect the project folder before scanning.',
          err);
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      // A private-only unclaimed create is no longer a recovery once project state is proven safe
      // and its evidence settled.
      if (err?.code === 'RECOVERY_REQUIRED') {
        throw withRollbackEvidence(new AssetProcessingError('Conversion failed and the original files were restored.', {
          code: 'FILESYSTEM_OPERATION_FAILED', cause: err,
        }), rollback);
      }
      throw withRollbackEvidence(err, rollback);
    }

    // The asset/index changes and this run's evidence finalization commit together or not at
    // all; a failure (including an unexpected repository result) rolls both back before the
    // filesystem rollback runs. Nothing after the commit ever rolls the filesystem back.
    let resultAssets;
    try {
      resultAssets = processingRecoveryEvidenceRecorder.runInTransaction(() => {
        const databaseResult = assetRepository.applyAssetConversions(projectId, buildChanges(items, options));
        if (!databaseResult
          || !Array.isArray(databaseResult.outputs)
          || !Array.isArray(databaseResult.reencoded)
          || databaseResult.outputs.length + databaseResult.reencoded.length !== items.length) {
          throw new Error('Asset conversion repository returned an unexpected result.');
        }
        const reencodedById = new Map(databaseResult.reencoded.map((asset) => [asset.id, asset]));
        const outputsByPath = new Map(databaseResult.outputs.map((asset) => [asset.relative_path, asset]));
        const assets = items.map((item) => (
          item.sameExtension
            ? reencodedById.get(item.asset.id)
            : outputsByPath.get(item.outputRelativePath)
        ));
        if (assets.some((asset) => !asset)) {
          throw new Error('Asset conversion repository returned an unexpected result.');
        }
        finalizeCommittedConversionEvidence(items);
        return assets;
      });
    } catch (err) {
      const rollback = await rollbackConversion(staging, items, projectDir, 'database');
      if (!rollback.recovered) {
        throw failAfterRollback(rollback,
          'Converted files were written but CreatorCrate could not restore the filesystem after an index failure. Inspect the project folder before scanning.',
          err);
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      throw withRollbackEvidence(new AssetProcessingError(
        'Converted files were removed because CreatorCrate could not update the asset index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      ), rollback);
    }

    // The outputs, moves and deletes are committed: each item's mutation is resolved, and only
    // then is its public tracking retired (the converted output and Originals copy stay as
    // project files). Every stage, backup and staged original is now a dispensable private copy,
    // so one that cannot be removed is reported as residue and never gates the project. An item
    // whose resolution failed keeps its checkpoint, rows and private copies.
    finishConversionMutations(items, { committed: true });
    const cleanupDiagnostics = stagingDiagnostics(staging);
    const cleanup = cleanupConversionStaging(staging, cleanupDiagnostics, { committed: true, projectDir });
    deleteSettledConversionGroups(items);
    if (!cleanup.complete) {
      reportResidue?.(summarizeRecoveryDiagnostics('cleanup', cleanupDiagnostics, items, {
        cleanupSucceeded: false,
      }));
    }
    const evidenceFailure = items.find((item) => item.evidenceFailure)?.evidenceFailure;
    if (evidenceFailure) throw evidenceFailure;

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
    if (!processingRecoveryEvidenceRecorder || !processingRecoveryEvidenceRepository) {
      throw new AssetProcessingError('Conversion processing requires recovery evidence persistence.', {
        code: 'RECOVERY_EVIDENCE_UNAVAILABLE',
      });
    }
    // One run per invocation: the processing job ID, or a single fallback for a direct call.
    const runId = typeof onProgress?.jobId === 'string' ? onProgress.jobId : randomUUID();
    const execute = async () => {
      const progress = createProgressReporter(assetIds.length, onProgress);
      const observed = { operation: 'convert', projectId, assetCount: assetIds.length, onProgress };
      const result = await observeRecovery(observed, () => convertAssetsLocked(
        projectId, assetIds, options, progress,
        (recoveryDiagnostics) => logProcessingDiagnostic(PROCESSING_CLEANUP_RESIDUE, observed, { recoveryDiagnostics }),
        runId,
      ));
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


  function readGeneratedOutputProvenance(projectId, assetId) {
    if (typeof assetRepository.findGeneratedOutputProvenance !== 'function') return null;
    return assetRepository.findGeneratedOutputProvenance(projectId, assetId) ?? null;
  }

  // Content eligibility only (generated row + matching hash); never pathname ownership.
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
      sourceAnimated: item.outputAnimated,
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
        generatedOutputProvenance: item.outputProvenance ?? null,
        expectedGeneratedOutputProvenance: item.destinationProvenance ?? null,
        expectedGeneratedSourceAssetId: item.destinationAsset.generated_source_asset_id,
        expectedGeneratedSourceRelativePath: item.destinationAsset.generated_source_relative_path,
        expectedGeneratedMode: item.destinationAsset.generated_mode,
        expectedGeneratedVariant: item.destinationAsset.generated_variant,
        expectedGeneratedOutputSha256: item.destinationAsset.generated_output_sha256,
        expectedGeneratedWatermarkId: item.destinationAsset.generated_watermark_id,
        // Source authority of the destination row captured at planning time,
        // before rendering; never re-read here, or a concurrent reconciliation
        // would be mistaken for the expected state.
        expectedExtension: item.destinationAsset.extension,
        expectedSizeBytes: item.destinationAsset.size_bytes,
        expectedModifiedAt: item.destinationAsset.modified_at,
        expectedIsPresent: item.destinationAsset.is_present,
        expectedSourceAnimated: item.destinationAsset.source_animated,
        expectedSourceGeneration: item.destinationAsset.source_generation,
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
        generatedOutputProvenance: item.outputProvenance ?? null,
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
        outputProvenance: artifact.outputProvenance ?? null,
        expectedOutputProvenance: artifact.artifact.output_provenance ?? null,
      })),
      artifactOutputs: artifacts.filter((artifact) => !artifact.artifact).map((artifact) => ({
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        sha256: artifact.sha256,
        sizeBytes: artifact.outputStats.size,
        generatedBy: WATERMARK_GENERATED_BY,
        generatedMode: options.mode,
        generatedWatermarkId: watermarkId,
        outputProvenance: artifact.outputProvenance ?? null,
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
          outputProvenance: plan.outputProvenance ?? null,
          expectedOutputProvenance: plan.artifact.output_provenance ?? null,
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
          outputProvenance: plan.outputProvenance ?? null,
        })),
    };
  }

  async function watermarkAssetsLocked(projectId, assetIds, options, watermarkIdentity = {}, progress, reportResidue, runId) {
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
      const sourceExactIdentity = exactFileIdentity(sourceAbsPath);
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
      const source = {
        asset, sourceRelativePath, sourceAbsPath, sourceIdentity, sourceExactIdentity,
        derivedOutput, outputs: [], deleteReason: null,
      };
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
        // Generated metadata and hash prove only expected content. Replacing an existing
        // destination unlinks it, so it must be exactly the object CreatorCrate published.
        const destinationProvenance = destinationAsset
          ? readGeneratedOutputProvenance(projectId, destinationAsset.id) : null;
        const destinationExactIdentity = destinationStats
          ? provenOwnedOutputIdentity(outputAbsPath, destinationProvenance) : null;
        if (destinationStats && !destinationExactIdentity) {
          throw new AssetProcessingError('The existing watermark destination is not provably the file CreatorCrate published.', { code: 'OUTPUT_DESTINATION_CONFLICT' });
        }
        const item = {
          asset, sourceRelativePath, sourceFilename, sourceExtension, sourceAbsPath, sourceIdentity, projectDir,
          sourceExactIdentity,
          variant: output.variant, variantMaxDimension: output.maxDimension,
          outputFilename: output.outputFilename, outputExtension: output.outputExtension,
          outputRelativePath: output.outputRelativePath, outputCategoryId: outputClassification.categoryId,
          outputNestedPath: outputClassification.nestedPath, outputAbsPath,
          outputDirectoryAbsPath: path.dirname(outputAbsPath), outputFormat: output.outputFormat,
          destinationAsset: destinationAsset || null, destinationStats,
          destinationIdentity: destinationStats ? { dev: destinationStats.dev, ino: destinationStats.ino } : null,
          destinationProvenance, destinationExactIdentity,
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
    startWatermarkMutationGroups(projectId, runId, sources);
    let staging;
    try {
      startArchiveMutationGroups(projectId, runId, archivePlans, projectDir);
      staging = createWatermarkStaging(projectDir);
    } catch (err) {
      for (const mutation of watermarkMutationContexts(items)) {
        try { processingRecoveryEvidenceRepository.deleteMutationGroup(projectId, mutation.group.groupId); } catch { /* Empty context only. */ }
      }
      deleteEmptyArchiveGroups(archivePlans);
      throw err;
    }
    staging.items = items;
    staging.artifacts = archivePlans;
    try {
      ensureWatermarkOutputDirectories([...items, ...archivePlans], projectDir);
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
        await publishWatermarkOutput(item, projectDir);
      }
      for (const archivePlan of archivePlans) {
        await publishArchiveArtifact(archivePlan, projectDir);
      }
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        if (!source.deleteEligible) continue;
        const sourceItems = source.outputs.filter((output) => output.item).map((output) => output.item);
        await stageWatermarkOriginalForDelete(sourceItems[0], sourceItems, staging, items.length + index, projectDir);
      }
      // Final pre-commit validation; the synchronous index transaction follows directly.
      revalidateWatermarkPublications(items, archivePlans, projectDir);
    } catch (err) {
      const rollback = await rollbackWatermarkPublication(projectId, staging, items, projectDir, 'publication');
      if (!rollback.recovered) {
        const failure = new AssetProcessingError(
          'Watermarking changed the filesystem but could not safely complete or clean up. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
        failure.recoveryDiagnostics = rollback.diagnostics;
        if (rollback.evidenceFailure) failure.observationFailure = rollback.evidenceFailure;
        throw failure;
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      if (err?.code === 'RECOVERY_REQUIRED') {
        throw withRollbackEvidence(new AssetProcessingError('Watermarking failed and the original files were restored.', {
          code: 'FILESYSTEM_OPERATION_FAILED', cause: err,
        }), rollback);
      }
      throw withRollbackEvidence(err, rollback);
    }

    let databaseResult;
    try {
      databaseResult = processingRecoveryEvidenceRecorder.runInTransaction(() => {
        const updated = assetRepository.applyAssetWatermarks(
          projectId,
          buildWatermarkChanges(items, options, watermarkId, archivePlans),
        );
        if (!updated
          || !Array.isArray(updated.replaced)
          || !Array.isArray(updated.outputs)
          || updated.replaced.length + updated.outputs.length !== items.length
          || !Array.isArray(updated.deleted)
          || updated.deleted.length !== sources.filter((source) => source.deleteEligible).length
          || !Array.isArray(updated.artifactReplaced)
          || !Array.isArray(updated.artifactOutputs)
          || updated.artifactReplaced.length + updated.artifactOutputs.length !== archivePlans.length) {
          throw new Error('Asset watermark repository returned an unexpected result.');
        }
        for (const mutation of watermarkMutationContexts(items)) {
          for (const row of watermarkEvidenceRows(mutation)) {
            if (WATERMARK_PRIVATE_ROLES.includes(row.artifactRole)) mutation.group.markDispensable(row.evidenceId, {
              retentionReason: WATERMARK_RETENTION.committed,
            });
          }
        }
        finalizeCommittedArchiveEvidence(archivePlans);
        return updated;
      });
    } catch (err) {
      const rollback = await rollbackWatermarkPublication(projectId, staging, items, projectDir, 'database');
      if (!rollback.recovered) {
        const failure = new AssetProcessingError(
          'Watermarked files were written but CreatorCrate could not restore the filesystem after an index failure. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
        failure.recoveryDiagnostics = rollback.diagnostics;
        if (rollback.evidenceFailure) failure.observationFailure = rollback.evidenceFailure;
        throw failure;
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      throw withRollbackEvidence(new AssetProcessingError(
        'Watermarked files were removed because CreatorCrate could not update the asset index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      ), rollback);
    }

    // The outputs and archives are committed: every stage, backup and staged original is now a
    // dispensable private copy, so one that cannot be removed is reported as residue and
    // never gates the project.
    finishWatermarkMutations(items, { committed: true });
    const cleanupDiagnostics = stagingDiagnostics(staging);
    const artifactsCleanup = cleanupArchiveStaging(archivePlans, cleanupDiagnostics, { committed: true });
    const cleanup = cleanupWatermarkStaging(staging, cleanupDiagnostics, { committed: true });
    deleteSettledWatermarkGroups(items);
    if (!artifactsCleanup.complete || !cleanup.complete) {
      reportResidue?.(summarizeRecoveryDiagnostics('cleanup', cleanupDiagnostics, items, {
        cleanupSucceeded: false,
      }));
    }
    const evidenceFailure = watermarkMutationContexts(items).find((mutation) => mutation.evidenceFailure)?.evidenceFailure
      ?? archivePlans.find((plan) => plan.evidenceFailure)?.evidenceFailure;
    if (evidenceFailure) throw evidenceFailure;

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
    if (!processingRecoveryEvidenceRecorder || !processingRecoveryEvidenceRepository) {
      throw new AssetProcessingError('Watermark processing requires recovery evidence persistence.', {
        code: 'RECOVERY_EVIDENCE_UNAVAILABLE',
      });
    }
    const runId = typeof onProgress?.jobId === 'string' ? onProgress.jobId : randomUUID();
    const execute = async () => {
      const progress = createProgressReporter(assetIds.length, onProgress);
      const observed = { operation: 'watermark', projectId, assetCount: assetIds.length, onProgress };
      const result = await observeRecovery(observed, () => watermarkAssetsLocked(
        projectId, assetIds, options, { watermarkId }, progress,
        (recoveryDiagnostics) => logProcessingDiagnostic(PROCESSING_CLEANUP_RESIDUE, observed, { recoveryDiagnostics }),
        runId,
      ));
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


  async function createArchivesLocked(projectId, assetIds, options, onProgress, reportResidue, runId) {
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
    startArchiveMutationGroups(projectId, runId, archivePlans, projectDir);
    let staging;
    try {
      staging = createWatermarkStaging(projectDir);
    } catch (err) {
      deleteEmptyArchiveGroups(archivePlans);
      throw err;
    }
    staging.items = [];
    staging.artifacts = archivePlans;
    const progress = createProgressReporter(archivePlans.length, onProgress);

    try {
      ensureWatermarkOutputDirectories(archivePlans, projectDir);
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
        await publishArchiveArtifact(archivePlan, projectDir);
      }
      // Final pre-commit validation; the synchronous index transaction follows directly.
      revalidateArchivePublications(archivePlans, projectDir);
    } catch (err) {
      const rollback = await rollbackArchivePublication(projectId, staging, archivePlans, projectDir, 'publication');
      if (!rollback.recovered) {
        const failure = new AssetProcessingError(
          'Standalone archives changed the filesystem but could not be safely recovered.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
        failure.recoveryDiagnostics = rollback.diagnostics;
        if (rollback.evidenceFailure) failure.observationFailure = rollback.evidenceFailure;
        throw failure;
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      if (err?.code === 'RECOVERY_REQUIRED') {
        throw withRollbackEvidence(new AssetProcessingError('Archive processing failed and the original files were restored.', {
          code: 'FILESYSTEM_OPERATION_FAILED', cause: err,
        }), rollback);
      }
      throw withRollbackEvidence(err, rollback);
    }

    let databaseResult;
    try {
      databaseResult = processingRecoveryEvidenceRecorder.runInTransaction(() => {
        const updated = assetRepository.applyAssetWatermarks(
          projectId,
          buildArchiveArtifactChanges(archivePlans),
        );
        if (!updated
          || !Array.isArray(updated.replaced)
          || updated.replaced.length !== 0
          || !Array.isArray(updated.outputs)
          || updated.outputs.length !== 0
          || !Array.isArray(updated.deleted)
          || updated.deleted.length !== 0
          || !Array.isArray(updated.artifactReplaced)
          || !Array.isArray(updated.artifactOutputs)
          || updated.artifactReplaced.length + updated.artifactOutputs.length !== archivePlans.length) {
          throw new Error('Generated artifact repository returned an unexpected result.');
        }
        finalizeCommittedArchiveEvidence(archivePlans);
        return updated;
      });
    } catch (err) {
      const rollback = await rollbackArchivePublication(projectId, staging, archivePlans, projectDir, 'database');
      if (!rollback.recovered) {
        const failure = new AssetProcessingError(
          'Standalone archives were written but could not be restored after an index failure.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
        failure.recoveryDiagnostics = rollback.diagnostics;
        if (rollback.evidenceFailure) failure.observationFailure = rollback.evidenceFailure;
        throw failure;
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      if (err?.code === 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED') throw withRollbackEvidence(err, rollback);
      throw withRollbackEvidence(new AssetProcessingError(
        'Standalone archives were removed because CreatorCrate could not update the artifact index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      ), rollback);
    }

    // The archives are committed: every stage and backup is now a dispensable private copy, so
    // one that cannot be removed is reported as residue and never gates the project.
    const cleanupDiagnostics = stagingDiagnostics(staging);
    const cleanup = cleanupArchiveStaging(archivePlans, cleanupDiagnostics, { committed: true });
    if (!cleanup.complete) {
      reportResidue?.(summarizeRecoveryDiagnostics('cleanup', cleanupDiagnostics, [], {
        cleanupSucceeded: false,
      }));
    }
    const evidenceFailure = archivePlans.find((plan) => plan.evidenceFailure)?.evidenceFailure;
    if (evidenceFailure) throw evidenceFailure;
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

    if (!processingRecoveryEvidenceRecorder || !processingRecoveryEvidenceRepository) {
      throw new AssetProcessingError('Archive processing requires recovery evidence persistence.', {
        code: 'RECOVERY_EVIDENCE_UNAVAILABLE',
      });
    }
    const runId = typeof onProgress?.jobId === 'string' ? onProgress.jobId : randomUUID();
    const execute = async () => {
      const observed = { operation: 'archive', projectId, assetCount: assetIds.length, onProgress };
      return observeRecovery(observed, () => createArchivesLocked(
        projectId, assetIds, options, onProgress,
        (recoveryDiagnostics) => logProcessingDiagnostic(PROCESSING_CLEANUP_RESIDUE, observed, { recoveryDiagnostics }),
        runId,
      ));
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


  function createPromptStaging(projectDir) {
    const workspace = createStagingDirectory(
      projectDir,
      '.creatorcrate-workflow-prompts-staging',
      'CreatorCrate could not prepare prompt editing staging.',
    );
    return { ...workspace, projectDir, items: [] };
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

  // Every Prompt artifact (stage, `.original` backup, published replacement, restored
  // original) is its own exclusively created, descriptor-owned file: none is a hard-link
  // alias, so a filesystem that gives each path its own inode number (SMB) needs no alias
  // equality. Diagnostics name that publication mode.
  function promptPublicationMode(item) {
    return item.outputRecoveryIdentity ? 'descriptor-owned' : undefined;
  }

  // An owned-file failure as bounded diagnostic evidence: the primitive's reason (never a
  // message) or the filesystem error code.
  function ownedFileFailureEvidence(err) {
    if (err instanceof OwnedFileError) return { proof: err.reason };
    return typeof err?.code === 'string' ? { errorCode: err.code } : {};
  }

  // Workflow Prompt recovery evidence. Each changed asset of one run is one mutation group
  // (runId = the processing job ID, itemKey `asset:<id>`), created before any Prompt file.
  // Rows are written only through the recorder's ordering seam; the repository is used for
  // reads, observations and the deletion of rows/groups after cleanup is positively proven.
  // No row ever authorizes a filesystem action: the descriptor-owned exact identities held
  // on each item stay the only cleanup, removal and restoration authority. Internal tokens:
  // the Recovery Details UI translates operation + role/reason into text.
  const PROMPT_EVIDENCE_ROLE = Object.freeze({
    stage: 'stage-output', // private staged edited PNG
    backup: 'original-backup', // private descriptor-owned copy of the original source
    published: 'published-output', // public replacement at the source path (tracking only)
  });
  const PROMPT_RETENTION = Object.freeze({
    pending: 'publication-pending', // created for a publication that is not yet resolved
    publicationFailed: 'publication-failed', // publication failed; rollback not yet settled
    databaseFailed: 'database-failed', // index apply failed; rollback not yet settled
    restorationFailed: 'restoration-failed', // rollback could not restore the original
    publicCreateUnclaimed: 'public-create-unclaimed', // a public create left an unowned path
    committed: 'committed', // edit committed; awaiting immediate cleanup
    rolledBack: 'rolled-back', // original verified restored; awaiting immediate cleanup
    cleanupResidue: 'cleanup-residue', // safe, dispensable copy cleanup could not remove
  });

  // Workflow Prompt records evidence, so it never runs on transient-only recovery tracking.
  function requirePromptRecoveryEvidence() {
    if (!processingRecoveryEvidenceRecorder || !processingRecoveryEvidenceRepository) {
      throw new AssetProcessingError('Workflow Prompt processing requires recovery evidence persistence.', {
        code: 'RECOVERY_EVIDENCE_UNAVAILABLE',
      });
    }
  }

  // Project-relative, forward-slash metadata only (never resolved into cleanup authority).
  function projectRelativePath(projectDir, absPath) {
    return path.relative(projectDir, absPath).split(path.sep).join('/');
  }

  // A restored source that failed its final batch validation is unresolved too: its backup is
  // still the last known-good original.
  function promptItemUnresolved(item) {
    return item.sourceRemoved || item.replacementPublished || item.restoreUnverified === true;
  }

  // The public create opened a path at the source that CreatorCrate never claimed.
  function promptReplacementUnclaimed(item) {
    return item.replacementCreated === true && !item.outputRecoveryIdentity;
  }

  // Removes groups that never received evidence or a checkpoint (no Prompt file exists).
  function discardPromptMutationGroups(items) {
    for (const item of items) {
      if (!item.recoveryGroup) continue;
      try {
        processingRecoveryEvidenceRepository.deleteMutationGroup(item.recoveryGroup.projectId, item.recoveryGroup.groupId);
      } catch {
        // An empty, never-checkpointed group claims nothing.
      }
    }
  }

  function startPromptMutationGroups(projectId, runId, items) {
    try {
      for (const item of items) {
        item.recoveryGroup = processingRecoveryEvidenceRecorder.startMutationGroup({
          projectId, operation: 'workflow-prompt', runId, itemKey: `asset:${item.assetId}`,
        });
      }
    } catch (err) {
      discardPromptMutationGroups(items);
      throw err;
    }
  }

  // The item's evidence rows by role (at most one per role in its group). Throws when the
  // registry cannot be read; callers then keep the conservative state.
  function promptEvidenceRows(item) {
    const { projectId, groupId } = item.recoveryGroup;
    return new Map(processingRecoveryEvidenceRepository.listEvidenceByMutationGroup(projectId, groupId)
      .map((row) => [row.artifactRole, row]));
  }

  // Records what an existing check already established. Descriptive only: a failed write
  // never changes a filesystem or recovery decision.
  function observePromptEvidence(item, evidenceId, observation) {
    if (!evidenceId || !observation) return;
    try {
      if (processingRecoveryEvidenceRepository.setEvidenceObservation(
        item.recoveryGroup.projectId, evidenceId, observation,
      ) === false) throw new Error('The Prompt evidence observation was not persisted.');
    } catch (err) {
      const failure = promptEvidencePersistenceFailure(err, 'observation');
      item.evidenceObservationFailure ??= failure;
      return failure;
    }
  }

  function promptEvidencePersistenceFailure(err, evidenceStage) {
    if (err?.code === 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED') return err;
    return Object.assign(new AssetProcessingError('Prompt recovery evidence could not be settled.', {
      code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', cause: err,
    }), { evidenceStage });
  }

  function promptDiagnosticObservation(observation, contentObservation) {
    if (observation.pathState === 'absent') return 'missing';
    if (observation.pathState === 'inspection-failed') return 'unavailable';
    if (!observation.expected) return 'ownership-unknown';
    if (observation.identity !== 'matched') return 'replaced';
    // An identity-only diagnostic cannot disprove an already observed content/read failure.
    return ['changed', 'unavailable'].includes(contentObservation) ? contentObservation : 'present';
  }

  // Called only after the filesystem proved the artifact removed or absent. A row that
  // cannot be deleted stays stale; it overstates what remains and authorizes nothing.
  function deletePromptEvidence(item, evidenceId) {
    try {
      processingRecoveryEvidenceRepository.deleteEvidence(item.recoveryGroup.projectId, evidenceId);
    } catch {
      // See above.
    }
  }

  // Before rollback begins, each item whose public state may have changed names the failing
  // phase on its rows, so a crash during rollback still explains them. Best effort only:
  // filesystem rollback never waits on, or depends on, a registry write.
  function notePromptFailurePhase(items, phase) {
    const retentionReason = phase === 'database' ? PROMPT_RETENTION.databaseFailed : PROMPT_RETENTION.publicationFailed;
    for (const item of items) {
      if (!item.recoveryGroup || !(promptItemUnresolved(item) || item.replacementCreated)) continue;
      try {
        for (const row of promptEvidenceRows(item).values()) {
          item.recoveryGroup.markRecoveryCritical(row.evidenceId, { retentionReason });
        }
      } catch {
        // The rows keep their earlier, still conservative, context.
      }
    }
  }

  // Mirrors restoration's verified result. An unresolved item keeps its rows
  // recovery-critical and its checkpoint (the job retains the recovery gate). A resolved
  // item's private copies become dispensable, its whole mutation is resolved, and only then
  // is its public tracking row dropped (restoration proved the replacement gone or never
  // created). A registry failure on a resolved item withholds its cleanup, so its rows never
  // claim less than remains on disk; it must propagate before a private-only recovery error
  // can be downgraded.
  function settlePromptRollbackEvidence(items) {
    let failure = null;
    for (const item of items) {
      if (!item.recoveryGroup) continue;
      const group = item.recoveryGroup;
      const observations = item.recoveryObservations ?? {};
      let rows;
      if (promptItemUnresolved(item)) {
        try {
          rows = promptEvidenceRows(item);
          for (const role of [PROMPT_EVIDENCE_ROLE.stage, PROMPT_EVIDENCE_ROLE.backup]) {
            const row = rows.get(role);
            if (!row) continue;
            group.markRecoveryCritical(row.evidenceId, { retentionReason: PROMPT_RETENTION.restorationFailed });
            observePromptEvidence(item, row.evidenceId, observations[role]);
          }
          const published = rows.get(PROMPT_EVIDENCE_ROLE.published);
          if (published && (item.replacementPublished || promptReplacementUnclaimed(item))) {
            group.markRecoveryCritical(published.evidenceId, {
              retentionReason: promptReplacementUnclaimed(item)
                ? PROMPT_RETENTION.publicCreateUnclaimed
                : PROMPT_RETENTION.restorationFailed,
            });
            observePromptEvidence(item, published.evidenceId, observations[PROMPT_EVIDENCE_ROLE.published]);
          } else if (published) {
            // Removed under its exact identity, or CreatorCrate's create never opened it.
            deletePromptEvidence(item, published.evidenceId);
          }
        } catch {
          // RECOVERY_REQUIRED retains the gate whatever the registry could record.
        }
        continue;
      }
      if (item.evidenceCleanupWithheld) continue;
      try {
        rows = promptEvidenceRows(item);
        for (const role of [PROMPT_EVIDENCE_ROLE.stage, PROMPT_EVIDENCE_ROLE.backup]) {
          const row = rows.get(role);
          if (!row) continue;
          group.markDispensable(row.evidenceId, { retentionReason: PROMPT_RETENTION.rolledBack });
          const observationFailure = observePromptEvidence(item, row.evidenceId,
            row.identity === null ? 'ownership-unknown' : observations[role]);
          if (observationFailure) throw observationFailure;
        }
        group.resolveMutation();
        item.recoveryResolved = true;
      } catch (err) {
        item.evidenceCleanupWithheld = true;
        failure ??= promptEvidencePersistenceFailure(err, 'finalization');
        continue;
      }
      const published = rows.get(PROMPT_EVIDENCE_ROLE.published);
      if (published) deletePromptEvidence(item, published.evidenceId);
    }
    return failure;
  }

  // Inside the commit transaction: this item's private copies become dispensable together
  // with its asset/index edit. A failure throws, rolling back both.
  function finalizeCommittedPromptEvidence(item) {
    const rows = promptEvidenceRows(item);
    for (const role of [PROMPT_EVIDENCE_ROLE.stage, PROMPT_EVIDENCE_ROLE.backup]) {
      const row = rows.get(role);
      if (row) item.recoveryGroup.markDispensable(row.evidenceId, { retentionReason: PROMPT_RETENTION.committed });
    }
  }

  // After the commit transaction, each item's whole mutation is resolved on its own, in
  // autocommit, and only then is its public tracking row dropped. A resolution failure never
  // rolls back committed state: that item keeps its checkpoint and rows, its private copies
  // are left in place, and the first such failure is returned for the caller to propagate.
  function resolveCommittedPromptMutations(items) {
    let failure = null;
    for (const item of items) {
      try {
        item.recoveryGroup.resolveMutation();
        item.recoveryResolved = true;
      } catch (err) {
        item.evidenceCleanupWithheld = true;
        failure ??= err;
        continue;
      }
      deletePromptEvidence(item, item.publishedEvidenceId);
    }
    return failure;
  }

  // Mirrors one dispensable artifact's cleanup: a positively absent artifact's row is
  // deleted; a copy left in place stays a dispensable cleanup-residue row.
  function settlePromptArtifactEvidence(item, role, residueObservation, { required = false } = {}) {
    if (!item.recoveryGroup) return;
    let row;
    try {
      row = promptEvidenceRows(item).get(role);
    } catch (err) {
      return required ? promptEvidencePersistenceFailure(err, 'finalization') : undefined;
    }
    if (!row) return;
    if (residueObservation === null) {
      deletePromptEvidence(item, row.evidenceId);
      return;
    }
    try {
      item.recoveryGroup.markDispensable(row.evidenceId, { retentionReason: PROMPT_RETENTION.cleanupResidue });
    } catch (err) {
      if (required) return promptEvidencePersistenceFailure(err, 'finalization');
      // The row stays dispensable with its earlier reason.
    }
    const failure = observePromptEvidence(item, row.evidenceId,
      row.identity === null && residueObservation === 'present' ? 'ownership-unknown' : residueObservation);
    if (required) return failure;
  }

  // A resolved group whose rows are all gone is deleted; the repository keeps any group that
  // still has evidence. Only resolved (checkpoint cleared) groups are considered.
  function deleteSettledPromptGroups(items) {
    for (const item of items) {
      if (!item.recoveryGroup || !item.recoveryResolved) continue;
      try {
        processingRecoveryEvidenceRepository.deleteMutationGroup(item.recoveryGroup.projectId, item.recoveryGroup.groupId);
      } catch {
        // The group stays as run/item context.
      }
    }
  }

  // Cleanup of the private Prompt artifacts. `safe` answers "is project state resolved?": it
  // is false only when an unresolved item (source removed or replacement published and not
  // restored) keeps its backup and stage as recovery evidence. Once an item is resolved (its
  // source was never removed, its original was restored and verified, or the edit was
  // committed) the backup and stage are dispensable private copies. `complete` answers "is
  // every dispensable copy positively gone?": it stays true only for a copy removed under its
  // exact descriptor-derived identity or already absent. An owned copy that cannot be removed,
  // and a present path CreatorCrate never owned (left untouched, never adopted), are residue:
  // `complete` false while `safe` stays true. Each outcome is mirrored in the item's evidence
  // rows, always after the filesystem result. An item whose evidence could not be settled
  // (its mutation is unresolved in the registry) keeps its copies in place as residue.
  function cleanupPromptStaging(staging, {
    preserveRecoveryBackups = false, diagnostics, requireEvidenceSettlement = false,
  } = {}) {
    let safe = true;
    let complete = true;
    let evidenceFailure = null;
    for (const item of staging.items) {
      const base = (artifactRole) => ({ assetId: item.assetId, itemIndex: item.stageIndex, artifactRole });
      if (preserveRecoveryBackups && promptItemUnresolved(item)) {
        // Until rollback has verified restoration, the backup is the last trusted original
        // and the stage anchors the unresolved publication: both stay as evidence.
        safe = false;
        complete = false;
        for (const [role, absPath, identity, evidenceId, check] of [
          [PROMPT_EVIDENCE_ROLE.backup, item.backupPath, item.backupRecoveryIdentity,
            item.backupEvidenceId, 'retained-unrestored'],
          [PROMPT_EVIDENCE_ROLE.stage, item.stagePath, item.stageRecoveryIdentity,
            item.stageEvidenceId, 'retained-unresolved-publication'],
        ]) {
          if (!absPath) continue;
          recordRecoveryDiagnostic(diagnostics, () => {
            const observation = observeDiagnosticArtifact(absPath, identity);
            observePromptEvidence(item, evidenceId,
              promptDiagnosticObservation(observation, item.recoveryObservations?.[role]));
            return {
              ...base(role), check, ...observation,
              ...(role === PROMPT_EVIDENCE_ROLE.stage ? { publicationMode: promptPublicationMode(item) } : {}),
              cleanup: 'recovery-critical',
            };
          });
        }
        continue;
      }
      for (const [role, absPath, identity] of [
        [PROMPT_EVIDENCE_ROLE.stage, item.stagePath, item.stageRecoveryIdentity],
        [PROMPT_EVIDENCE_ROLE.backup, item.backupPath, item.backupRecoveryIdentity],
      ]) {
        if (item.evidenceCleanupWithheld) {
          if (!absPath) continue;
          complete = false;
          recordRecoveryDiagnostic(diagnostics, () => ({
            ...base(role),
            check: 'cleanup-withheld',
            ...observeDiagnosticArtifact(absPath, identity),
            cleanup: 'residue',
          }));
          continue;
        }
        const outcome = {};
        const result = cleanupPrivateStage(absPath, identity, outcome);
        const absent = result === STAGE_CLEANUP.clean
          || (result === STAGE_CLEANUP.residue && pathIsAbsent(absPath));
        // Reuse the diagnostic's path state before settling residue; a failed unlink alone
        // cannot establish that the owned artifact is still present.
        const diagnostic = absent ? null : {
          ...cleanupFailureDiagnostic(base(role), absPath, identity, outcome),
          cleanup: 'residue',
        };
        const settlementFailure = settlePromptArtifactEvidence(item, role,
          absent ? null : promptDiagnosticObservation(diagnostic, item.recoveryObservations?.[role]),
          { required: requireEvidenceSettlement });
        evidenceFailure ??= settlementFailure;
        if (settlementFailure) item.evidenceCleanupWithheld = true;
        if (absent) continue;
        complete = false;
        recordRecoveryDiagnostic(diagnostics, () => diagnostic);
      }
    }

    // The workspace itself is retained (directory policy).
    return { safe, complete, evidenceFailure };
  }

  // The stage's evidence intent (with its expected content) is durable before the file is
  // created, and its descriptor identity is durable before any byte is written. The in-memory
  // identity is recorded first: it stays the cleanup authority if the registry write fails.
  async function stagePromptOutput(item, staging, index) {
    const stagePath = stagingFile(staging, `${index}.png`);
    item.stagePath = stagePath;
    item.staging = staging;
    item.stageIndex = index;
    item.outputSha256 = createHash('sha256').update(item.editedBuffer).digest('hex');
    item.outputSize = item.editedBuffer.length;
    try {
      // Owned exact identity comes from the exclusive descriptor, never the pathname.
      const stage = await item.recoveryGroup.createArtifact({
        intent: {
          assetId: item.assetId,
          artifactRole: PROMPT_EVIDENCE_ROLE.stage,
          retentionReason: PROMPT_RETENTION.pending,
          artifactPath: projectRelativePath(staging.projectDir, stagePath),
          sourcePath: item.sourceRelativePath,
          destinationPath: item.sourceRelativePath,
          expectedSize: item.outputSize,
          expectedSha256: item.outputSha256,
        },
        create: ({ onCreated, onOwned }) => writeOwnedStageFile(
          stagePath,
          (descriptor) => writeBytesToDescriptor(descriptor, item.editedBuffer),
          {
            mode: item.sourceStats.mode & 0o7777,
            onCreated,
            onOwned: (identity) => {
              item.stageRecoveryIdentity = identity;
              onOwned(identity);
            },
          },
        ),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(stagePath, identity),
      });
      item.stageEvidenceId = stage.evidenceId;
      inspectPromptFile(stagePath, 'PROMPT_STAGE_INVALID');
      parsePngChunks(await fs.promises.readFile(stagePath));
      observePromptEvidence(item, item.stageEvidenceId, 'present');
    } catch (err) {
      // Ownership only ever comes from the exclusive descriptor; whatever is at the
      // pathname after a failure is never promoted to an owned stage.
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

  // The backup is a private copy of the source's bytes in a new, exclusively created file.
  // Its ownership is its own descriptor-derived exact identity (expected to differ from the
  // source's); the copy reads only the exact source identity captured at preflight and pins
  // the preflight size and hash. A completed backup grants no authority over the source.
  async function stagePromptBackup(item, staging, index, projectDir) {
    const diagnostics = stagingDiagnostics(staging);
    const base = { assetId: item.assetId, itemIndex: index, artifactRole: 'original-backup' };
    revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
    const currentStats = inspectSource(item.sourceAbsPath);
    if (!sameIdentity(currentStats, item.sourceIdentity)) {
      throw new AssetProcessingError('A selected source changed during prompt edit preflight.', {
        code: 'SOURCE_CHANGED',
      });
    }
    // The source will later be unlinked, which needs its known exact identity: unknown (zero)
    // IDs fail closed before anything is created, and a content-only copy is never used.
    if (!isKnownDirectoryIdentity(item.sourceRecoveryIdentity)) {
      recordRecoveryDiagnostic(diagnostics, () => ({
        ...base,
        check: 'backup-create-failed',
        proof: 'reference-identity-unknown',
        ...observeDiagnosticArtifact(item.sourceAbsPath, item.sourceRecoveryIdentity),
      }));
      throw new AssetProcessingError('CreatorCrate could not establish the exact identity of a selected source.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    }

    // Evidence ordering as for the stage: the intent (naming the original source and its
    // preflight size/SHA-256) before the copy is created, the descriptor identity before the
    // first byte. The backup's content proof is the preflight original's.
    const backupPath = stagingFile(staging, `${index}.original`);
    item.backupPath = backupPath;
    try {
      const backup = await item.recoveryGroup.createArtifact({
        intent: {
          assetId: item.assetId,
          artifactRole: PROMPT_EVIDENCE_ROLE.backup,
          retentionReason: PROMPT_RETENTION.pending,
          artifactPath: projectRelativePath(projectDir, backupPath),
          sourcePath: item.sourceRelativePath,
          expectedSize: item.sourceStats.size,
          expectedSha256: item.sourceSha256,
        },
        create: ({ onCreated, onOwned }) => copyTrustedFileToOwnedFile({
          sourcePath: item.sourceAbsPath,
          sourceExactIdentity: item.sourceRecoveryIdentity,
          destinationPath: backupPath,
          expectedSha256: item.sourceSha256,
          expectedSize: item.sourceStats.size,
          mode: item.sourceStats.mode & 0o7777,
          onCreated,
          onOwned: (identity) => {
            item.backupRecoveryIdentity = identity;
            onOwned(identity);
          },
        }),
        discardOwned: (identity) => removeFileIfExactIdentityMatches(backupPath, identity),
      });
      item.backupEvidenceId = backup.evidenceId;
      item.backupComplete = true;
      observePromptEvidence(item, item.backupEvidenceId, 'present');
    } catch (err) {
      // A registry failure keeps the recorder's own error and outcome.
      if (err instanceof AssetProcessingError) throw err;
      // An owned partial backup is removed later only by its exact identity; an EEXIST
      // collision or an identity-unknown create is never claimed.
      recordRecoveryDiagnostic(diagnostics, () => ({
        ...base,
        check: 'backup-create-failed',
        ...ownedFileFailureEvidence(err),
        ...observeDiagnosticArtifact(backupPath, item.backupRecoveryIdentity),
      }));
      if (err instanceof OwnedFileError && (err.reason === OWNED_FILE_FAILURE.sourceChanged
        || err.reason === OWNED_FILE_FAILURE.sourceUnsafe)) {
        throw new AssetProcessingError('A selected source changed during prompt edit preflight.', {
          code: 'SOURCE_CHANGED',
          cause: err,
        });
      }
      throw new AssetProcessingError('CreatorCrate could not stage a prompt backup.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
        cause: err,
      });
    }
  }

  async function publishPromptOutput(item, projectDir) {
    const diagnostics = stagingDiagnostics(item.staging);
    revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
    inspectSource(item.sourceAbsPath);
    // A completed owned backup must still be available before the source may be removed:
    // ownership is its descriptor-derived exact identity, and (separately) its content must
    // still be the preflight original's size and SHA-256. The hash never grants ownership;
    // an owned backup whose bytes changed in place is not recovery material. On either
    // failure the source is left untouched and the backup is not removed here.
    const backupUnavailable = (check) => {
      recordRecoveryDiagnostic(diagnostics, () => ({
        assetId: item.assetId,
        itemIndex: item.stageIndex,
        artifactRole: 'original-backup',
        check,
        ...observeDiagnosticArtifact(item.backupPath, item.backupRecoveryIdentity),
      }));
      return new AssetProcessingError('The prompt original backup changed before the source was replaced.', {
        code: 'FILESYSTEM_OPERATION_FAILED',
      });
    };
    if (!item.backupComplete || !pathMatchesExactIdentity(item.backupPath, item.backupRecoveryIdentity)) {
      throw backupUnavailable('backup-identity-mismatch');
    }
    let backupSha256;
    try {
      if (fs.lstatSync(item.backupPath).size !== item.sourceStats.size) {
        throw backupUnavailable('backup-content-mismatch');
      }
      backupSha256 = hashRegularFileInProject(projectDir, item.backupPath);
    } catch (err) {
      if (err instanceof AssetProcessingError) throw err;
      throw backupUnavailable('backup-content-mismatch');
    }
    if (backupSha256 !== item.sourceSha256) throw backupUnavailable('backup-content-mismatch');
    if (!pathMatchesExactIdentity(item.backupPath, item.backupRecoveryIdentity)) {
      throw backupUnavailable('backup-identity-mismatch');
    }
    // Authority to unlink the source is the source's own preflight exact identity plus its
    // preflight bytes (the backup copy holds exactly those): never the backup's identity or
    // hash. Unknown (zero) or changed exact IDs and changed content fail closed.
    const sourceChanged = () => new AssetProcessingError('A selected source changed during prompt editing.', {
      code: 'SOURCE_CHANGED',
    });
    if (!pathMatchesExactIdentity(item.sourceAbsPath, item.sourceRecoveryIdentity)) throw sourceChanged();
    let currentSha256;
    try {
      currentSha256 = hashRegularFileInProject(projectDir, item.sourceAbsPath);
    } catch {
      throw sourceChanged();
    }
    if (currentSha256 !== item.sourceSha256
      || !pathMatchesExactIdentity(item.sourceAbsPath, item.sourceRecoveryIdentity)) {
      throw sourceChanged();
    }

    const group = item.recoveryGroup;

    // Removing the source and creating its replacement are one 'replace' mutation: the
    // publication intent and then the group checkpoint are durable before the source is
    // touched. The replacement is created exclusively at the source pathname and filled from
    // the validated stage (trusted content input only). Its ownership is its own descriptor
    // identity, durable in the registry before any byte is written; the stage identity is
    // never adopted. A created path that cannot be claimed is RECOVERY_REQUIRED and is never
    // adopted or removed. The pathname briefly exposes an incomplete file; the project
    // operation lock and the owned backup cover that window. EEXIST never overwrites or
    // adopts what appeared.
    try {
      const publication = await group.createArtifact({
        intent: {
          assetId: item.assetId,
          artifactRole: PROMPT_EVIDENCE_ROLE.published,
          retentionReason: PROMPT_RETENTION.pending,
          artifactPath: item.sourceRelativePath,
          sourcePath: projectRelativePath(projectDir, item.stagePath),
          expectedSize: item.outputSize,
          expectedSha256: item.outputSha256,
        },
        checkpoint: 'replace',
        create: async ({ onCreated, onOwned }) => {
          // The checkpoint is already durable. Both private copies must be promoted before
          // unlink begins; a failed promotion retains the checkpoint and withholds cleanup.
          try {
            group.markRecoveryCritical(item.backupEvidenceId, { retentionReason: PROMPT_RETENTION.pending });
            group.markRecoveryCritical(item.stageEvidenceId, { retentionReason: PROMPT_RETENTION.pending });
          } catch (err) {
            item.evidenceCleanupWithheld = true;
            throw err;
          }
          // The source's exact identity is re-proven immediately before it is removed.
          if (!pathMatchesExactIdentity(item.sourceAbsPath, item.sourceRecoveryIdentity)) throw sourceChanged();
          try {
            fs.unlinkSync(item.sourceAbsPath);
            item.sourceRemoved = true;
          } catch (err) {
            throw new AssetProcessingError('CreatorCrate could not replace a prompt source.', {
              code: 'FILESYSTEM_OPERATION_FAILED',
              cause: err,
            });
          }
          revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
          await copyTrustedFileToOwnedFile({
            sourcePath: item.stagePath,
            sourceExactIdentity: item.stageRecoveryIdentity,
            destinationPath: item.sourceAbsPath,
            expectedSha256: item.outputSha256,
            expectedSize: item.outputSize,
            mode: item.sourceStats.mode & 0o7777,
            onCreated: () => {
              item.replacementCreated = true;
              onCreated();
            },
            onOwned: (identity) => {
              item.outputRecoveryIdentity = identity;
              item.replacementPublished = true;
              onOwned(identity);
            },
          });
        },
        discardOwned: (identity) => removeFileIfExactIdentityMatches(item.sourceAbsPath, identity),
      });
      item.publishedEvidenceId = publication.evidenceId;
      const outputStats = fs.lstatSync(item.sourceAbsPath);
      if (!pathMatchesExactIdentity(item.sourceAbsPath, item.outputRecoveryIdentity)) {
        throw new OwnedFileError(OWNED_FILE_FAILURE.pathnameChanged, 'The published prompt output changed.');
      }
      item.outputStats = outputStats;
    } catch (err) {
      // Failures before the source was removed (a registry write, the last source re-proof,
      // the unlink itself) keep their own errors and leave no publication evidence.
      if (!item.sourceRemoved) throw err;
      // A recorder failure carries the filesystem failure, if any, as its cause.
      const failure = err?.evidenceStage !== undefined && err.cause !== undefined ? err.cause : err;
      recordRecoveryDiagnostic(diagnostics, () => ({
        assetId: item.assetId,
        itemIndex: item.stageIndex,
        artifactRole: 'published-output',
        check: 'publish-create-failed',
        publicationMode: promptPublicationMode(item),
        ...ownedFileFailureEvidence(failure),
        ...observeDiagnosticArtifact(item.sourceAbsPath, item.outputRecoveryIdentity),
      }));
      if (err instanceof AssetProcessingError) throw err;
      if (err?.code === 'EEXIST') {
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
  }

  // Final pre-commit validation of every Prompt publication, immediately before the synchronous
  // index transaction. A later item's publication or validation leaves a window in which an
  // earlier published output could be displaced or rewritten in place under the same identity.
  // Each published output must still be its own descriptor-created object holding the edited
  // bytes under a post-hash write fingerprint (ownedPathContentSnapshot, which tolerates SMB
  // metadata settling across the first read); the recorded stats are read after that settling;
  // and, after every output's content read, a metadata-only sweep proves each still holds that
  // fingerprint. No content is read after the sweep. A failure is never adopted or recorded.
  function revalidatePromptPublications(items, projectDir) {
    const fingerprints = new Map();
    const diagnose = (item, check) => recordRecoveryDiagnostic(stagingDiagnostics(item.staging), () => ({
      assetId: item.assetId,
      itemIndex: item.stageIndex,
      artifactRole: 'published-output',
      check,
      publicationMode: promptPublicationMode(item),
      ...observeDiagnosticArtifact(item.sourceAbsPath, item.outputRecoveryIdentity),
    }));
    for (const item of items) {
      revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
      const { failure, fingerprint } = ownedPathContentSnapshot(projectDir, item.sourceAbsPath,
        item.outputRecoveryIdentity, { size: item.outputSize, sha256: item.outputSha256 });
      if (failure) {
        diagnose(item, `precommit-${OWNED_PATH_FAILURE_CHECKS[failure]}`);
        throw new AssetProcessingError(failure === 'unreadable'
          ? 'A prompt edit could not be read before it was recorded.'
          : 'A prompt edit changed before it could be recorded.', {
          code: failure === 'unreadable' ? 'FILESYSTEM_OPERATION_FAILED' : 'SOURCE_CHANGED',
        });
      }
      try {
        item.outputStats = fs.lstatSync(item.sourceAbsPath);
      } catch (err) {
        throw new AssetProcessingError('A prompt edit could not be inspected before it was recorded.', {
          code: 'FILESYSTEM_OPERATION_FAILED',
          cause: err,
        });
      }
      fingerprints.set(item, fingerprint);
    }
    let unchanged = true;
    for (const item of items) {
      const change = ownedPathContinuityFailure(item.sourceAbsPath, item.outputRecoveryIdentity,
        fingerprints.get(item));
      if (!change) continue;
      unchanged = false;
      diagnose(item, `precommit-final-${OWNED_PATH_FAILURE_CHECKS[change]}`);
    }
    if (!unchanged) {
      throw new AssetProcessingError('A prompt edit changed before it could be recorded.', {
        code: 'SOURCE_CHANGED',
      });
    }
  }

  // Restored times are set to the millisecond the index records (Stats dates round the
  // native time to a millisecond, so that whole millisecond is the centre of its rounding
  // interval): the restored file keeps the size/mtime tuple the unchanged asset row holds.
  function indexedTimeSeconds(date) {
    return date.getTime() / 1000;
  }

  async function restorePromptReplacements(items, projectDir, failures = []) {
    let restored = true;
    for (const item of [...items].reverse()) {
      if (!item.sourceRemoved && !item.replacementPublished) continue;
      const publicationMode = promptPublicationMode(item);
      // What this pass establishes about the item's artifacts, mirrored later as evidence
      // observations (only facts the checks below already determine).
      const observations = {};
      item.recoveryObservations = observations;
      const observe = (role, observation) => { observations[role] = observation; };
      const publishedRole = PROMPT_EVIDENCE_ROLE.published;
      const backupRole = PROMPT_EVIDENCE_ROLE.backup;
      const fail = (check, err, { role = 'published-output', absPath, expectedIdentity, evidence } = {}) => {
        restored = false;
        recordRecoveryDiagnostic(failures, () => ({
          assetId: item.assetId,
          itemIndex: item.stageIndex,
          artifactRole: role,
          check,
          ...(absPath ? observeDiagnosticArtifact(absPath, expectedIdentity) : {}),
          ...(role === 'published-output' ? { publicationMode } : {}),
          ...(typeof err?.code === 'string' ? { errorCode: err.code } : {}),
          ...evidence,
        }));
      };
      const publishedArtifact = { absPath: item.sourceAbsPath, expectedIdentity: item.outputRecoveryIdentity };
      const backupArtifact = {
        role: 'original-backup', absPath: item.backupPath, expectedIdentity: item.backupRecoveryIdentity,
      };

      let current;
      try {
        current = fs.lstatSync(item.sourceAbsPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          observe(publishedRole, 'unavailable');
          fail('destination-inspect', err);
          continue;
        }
      }

      if (current) {
        if (current.isSymbolicLink() || !current.isFile()) {
          observe(publishedRole, promptReplacementUnclaimed(item) ? 'ownership-unknown' : 'replaced');
          fail('destination-not-regular-file', undefined, publishedArtifact);
          continue;
        }
        if (pathMatchesExactIdentity(item.sourceAbsPath, item.sourceRecoveryIdentity)) {
          try {
            if (hashRegularFileInProject(projectDir, item.sourceAbsPath) !== item.sourceSha256) {
              fail('restored-content-mismatch');
              continue;
            }
          } catch {
            fail('restored-content-mismatch');
            continue;
          }
          // The hash confirms content only (its read continuity is Number-based). The pathname
          // must still be the exact original identity after the read before recovery state is
          // cleared; a replacement is never adopted.
          if (!pathMatchesExactIdentity(item.sourceAbsPath, item.sourceRecoveryIdentity)) {
            fail('destination-foreign', undefined, {
              role: 'restored-source', absPath: item.sourceAbsPath, expectedIdentity: item.sourceRecoveryIdentity,
            });
            continue;
          }
          item.restoreProofIdentity = item.sourceRecoveryIdentity;
          item.sourceRemoved = false;
          item.replacementPublished = false;
          continue;
        }
        // Only the exact descriptor-created replacement may be removed; no content fallback.
        if (!promptOutputMatchesPublication(item)) {
          observe(publishedRole, promptReplacementUnclaimed(item) ? 'ownership-unknown' : 'replaced');
          fail('destination-foreign', undefined, publishedArtifact);
          continue;
        }
      }

      // The owned backup must be intact before the edited replacement is given up.
      try {
        inspectPromptFile(item.backupPath, 'RECOVERY_REQUIRED');
      } catch (err) {
        // A missing path carries its ENOENT cause; a present non-regular path has no cause.
        observe(backupRole, err.cause?.code === 'ENOENT' ? 'missing' : err.cause ? 'unavailable' : 'replaced');
        fail('backup-invalid', err.cause ?? err, backupArtifact);
        continue;
      }
      if (!item.backupComplete || !pathMatchesExactIdentity(item.backupPath, item.backupRecoveryIdentity)) {
        observe(backupRole, 'replaced');
        fail('backup-identity-mismatch', undefined, backupArtifact);
        continue;
      }
      try {
        if (hashRegularFileInProject(projectDir, item.backupPath) !== item.sourceSha256) {
          observe(backupRole, 'changed');
          fail('backup-content-mismatch', undefined, backupArtifact);
          continue;
        }
      } catch {
        observe(backupRole, 'unavailable');
        fail('backup-content-mismatch', undefined, backupArtifact);
        continue;
      }
      observe(backupRole, 'present');

      if (current) {
        const removal = {};
        if (!removeFileIfExactIdentityMatches(item.sourceAbsPath, item.outputRecoveryIdentity, removal)) {
          observe(publishedRole, removal.failedStep === 'ownership' ? 'replaced'
            : removal.failedStep === 'inspection' ? 'unavailable' : 'present');
          fail(removal.failedStep === 'ownership' ? 'destination-foreign' : 'replacement-unlink',
            removal.errorCode ? { code: removal.errorCode } : undefined, publishedArtifact);
          continue;
        }
        item.replacementPublished = false;
      }

      // The original returns as a new, exclusively created file at the source pathname,
      // filled from the owned backup (which must still be its exact identity and hold the
      // preflight bytes). It gets a new inode; mode and the indexed mtime are reapplied.
      try {
        revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
      } catch (err) {
        fail('destination-unsafe', err.cause ?? err, { role: 'restored-source' });
        continue;
      }
      let restoredIdentity;
      try {
        await copyTrustedFileToOwnedFile({
          sourcePath: item.backupPath,
          sourceExactIdentity: item.backupRecoveryIdentity,
          destinationPath: item.sourceAbsPath,
          expectedSha256: item.sourceSha256,
          expectedSize: item.sourceStats.size,
          mode: item.sourceStats.mode & 0o7777,
          times: {
            atime: indexedTimeSeconds(item.sourceStats.atime),
            mtime: indexedTimeSeconds(item.sourceStats.mtime),
          },
          onOwned: (identity) => { restoredIdentity = identity; },
        });
      } catch (err) {
        fail('restore-create-failed', err, {
          role: 'restored-source',
          absPath: item.sourceAbsPath,
          expectedIdentity: restoredIdentity,
          evidence: ownedFileFailureEvidence(err),
        });
        // A partial restore CreatorCrate owns is withdrawn (exact identity only), so no
        // unverified bytes stay at the source path; the backup remains the original.
        if (restoredIdentity) removeFileIfExactIdentityMatches(item.sourceAbsPath, restoredIdentity);
        continue;
      }
      // copyTrustedFileToOwnedFile verified the restored bytes, mode, times and path
      // continuity: the item no longer has a removed source or an unresolved published
      // replacement, whether the edited output was removed above or was already absent.
      // Its backup stays recovery evidence until verifyRestoredPromptSources proves it again.
      item.restoredRecoveryIdentity = restoredIdentity;
      item.restoreProofIdentity = restoredIdentity;
      item.sourceRemoved = false;
      item.replacementPublished = false;
    }
    return restored;
  }

  // Final batch validation of every source this rollback restored, after ALL restorations and
  // before any backup becomes dispensable or any checkpoint is resolved. A restored source
  // proven early can be rewritten in place while a later item is restored or read, so each
  // must again be its exact restored object holding the original preflight bytes under a
  // post-hash write fingerprint (ownedPathContentSnapshot, with its conditional SMB re-hash),
  // and, after every such read, a metadata-only sweep must prove each still holds that
  // fingerprint. A source that fails stays unresolved: its backup and stage stay
  // recovery-critical, its checkpoint and group remain, and the source itself is left as found
  // (never removed, repaired or adopted). Verified siblings settle on their own.
  function verifyRestoredPromptSources(items, projectDir, failures) {
    const pending = items.filter((item) => item.restoreProofIdentity);
    const fingerprints = new Map();
    const unverified = new Set();
    const fail = (item, check) => {
      unverified.add(item);
      recordRecoveryDiagnostic(failures, () => ({
        assetId: item.assetId,
        itemIndex: item.stageIndex,
        artifactRole: 'restored-source',
        check,
        ...observeDiagnosticArtifact(item.sourceAbsPath, item.restoreProofIdentity),
      }));
    };
    for (const item of pending) {
      try {
        revalidatePublicationTarget(projectDir, item.sourceAbsPath, 'SOURCE_PATH_UNSAFE', 'Source');
      } catch {
        fail(item, 'restored-source-unsafe');
        continue;
      }
      const { failure, unstable, fingerprint } = ownedPathContentSnapshot(projectDir, item.sourceAbsPath,
        item.restoreProofIdentity, { size: item.sourceStats.size, sha256: item.sourceSha256 });
      if (failure) {
        fail(item, `restored-source-${RESTORED_SOURCE_FAILURE_CHECKS[unstable ? 'continuity' : failure]}`);
        continue;
      }
      fingerprints.set(item, fingerprint);
    }
    for (const [item, fingerprint] of fingerprints) {
      const change = ownedPathContinuityFailure(item.sourceAbsPath, item.restoreProofIdentity, fingerprint);
      if (change) fail(item, `restored-source-final-${OWNED_PATH_FAILURE_CHECKS[change]}`);
    }
    for (const item of pending) {
      if (unverified.has(item)) item.restoreUnverified = true;
      item.restoreProofIdentity = undefined;
    }
    return unverified.size === 0;
  }

  // Restoration runs under each item's already durable checkpoint and never waits on a new
  // registry write, so a failing database cannot block filesystem rollback. The restored
  // sources are then validated as one batch; evidence mirrors that verified result before
  // cleanup, and cleanup before group deletion.
  async function rollbackPromptPublication(items, staging, projectDir, phase) {
    // Forward publication evidence (e.g. a failed backup creation) leads the entries.
    const failures = stagingDiagnostics(staging);
    notePromptFailurePhase(items, phase);
    const restoredAll = await restorePromptReplacements(items, projectDir, failures);
    const restored = verifyRestoredPromptSources(items, projectDir, failures) && restoredAll;
    const settlementFailure = settlePromptRollbackEvidence(items);
    const cleanup = cleanupPromptStaging(staging, {
      preserveRecoveryBackups: true, diagnostics: failures, requireEvidenceSettlement: true,
    });
    deleteSettledPromptGroups(items);
    return {
      recovered: restored && cleanup.safe,
      evidenceFailure: settlementFailure ?? cleanup.evidenceFailure,
      observationFailure: items.find((item) => item.evidenceObservationFailure)?.evidenceObservationFailure,
      evidence: failures.length > 0,
      diagnostics: summarizeRecoveryDiagnostics(phase, failures, items, {
        restored, cleanupSucceeded: cleanup.complete,
      }),
    };
  }

  // A verified rollback is an ordinary failure; forward-failure or residue evidence stays
  // attached so the rollback log still explains it (it never gates the project).
  function withRollbackEvidence(error, rollback) {
    if (rollback.evidence && error && typeof error === 'object') error.recoveryDiagnostics = rollback.diagnostics;
    return error;
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

  async function editWorkflowPromptsLocked(projectId, assetIds, options, progress, reportResidue, runId) {
    const project = requireMutableProject(projectId);
    const projectDir = resolveProjectAbsPath(project);
    const candidates = [];
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

      candidates.push({
        asset,
        assetId,
        sourceRelativePath,
        sourceAbsPath,
        sourceIdentity: { dev: sourceStats.dev, ino: sourceStats.ino },
        sourceRecoveryIdentity: exactFileIdentity(sourceAbsPath),
      });
    }

    const prepared = await processingConcurrencyService.mapBounded(candidates, async (candidate) => {
      let sourceBuffer;
      try {
        sourceBuffer = await fs.promises.readFile(candidate.sourceAbsPath);
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

      const afterReadStats = inspectSource(candidate.sourceAbsPath);
      if (!sameIdentity(afterReadStats, candidate.sourceIdentity)) {
        throw new AssetProcessingError('A selected source changed during prompt edit preflight.', {
          code: 'SOURCE_CHANGED',
        });
      }

      return {
        ...candidate,
        sourceStats: afterReadStats,
        sourceSha256: createHash('sha256').update(sourceBuffer).digest('hex'),
        ...(edited.changed ? { editedBuffer: edited.buffer } : { edited }),
      };
    });

    const items = [];
    for (const preparedItem of prepared) {
      if (!preparedItem.editedBuffer) {
        unchangedAssetIds.push(preparedItem.assetId);
        if (preparedItem.edited.metadataKey) noChangeAssetIds.push(preparedItem.assetId);
        else noWorkflowAssetIds.push(preparedItem.assetId);
        progress.advance();
        continue;
      }
      items.push({
        ...preparedItem,
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

    // Every item's mutation group is durable before any Prompt file is created.
    startPromptMutationGroups(projectId, runId, items);
    let staging;
    try {
      staging = createPromptStaging(projectDir);
    } catch (err) {
      discardPromptMutationGroups(items);
      throw err;
    }
    staging.items = items;

    try {
      await processingConcurrencyService.mapBounded(items, async (item, index) => {
        await stagePromptOutput(item, staging, index);
        progress.advance();
      });
      for (let index = 0; index < items.length; index++) {
        await stagePromptBackup(items[index], staging, index, projectDir);
      }
      for (const item of items) {
        await publishPromptOutput(item, projectDir);
      }
      // Synchronous from here: the final sweep is followed directly by the index transaction.
      revalidatePromptPublications(items, projectDir);
    } catch (err) {
      const rollback = await rollbackPromptPublication(items, staging, projectDir, 'publication');
      if (!rollback.recovered) {
        const failure = new AssetProcessingError(
          'Prompt editing changed the filesystem but could not safely restore it. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
        failure.recoveryDiagnostics = rollback.diagnostics;
        if (rollback.observationFailure) failure.observationFailure = rollback.observationFailure;
        throw failure;
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      if (err?.code === 'RECOVERY_REQUIRED') {
        // Project restoration and retained private evidence settlement both succeeded.
        throw withRollbackEvidence(new AssetProcessingError(
          'Prompt editing failed and the original files were restored.',
          { code: 'FILESYSTEM_OPERATION_FAILED', cause: err },
        ), rollback);
      }
      throw withRollbackEvidence(err, rollback);
    }

    // The asset/index edits and each item's evidence finalization commit in one SQLite
    // transaction, or neither does. Filesystem rollback stays outside it.
    let databaseResult;
    try {
      databaseResult = processingRecoveryEvidenceRecorder.runInTransaction(() => {
        const updated = assetRepository.applyAssetPromptEdits(projectId, items.map((item) => ({
          assetId: item.assetId,
          expectedRelativePath: item.sourceRelativePath,
          expectedSizeBytes: item.asset.size_bytes,
          expectedModifiedAt: item.asset.modified_at,
          sizeBytes: item.outputStats.size,
          modifiedAt: item.outputStats.mtime.toISOString(),
        })));
        if (!Array.isArray(updated) || updated.length !== items.length) {
          throw new Error('Asset prompt edit repository returned an unexpected result.');
        }
        for (const item of items) finalizeCommittedPromptEvidence(item);
        return updated;
      });
    } catch (err) {
      const rollback = await rollbackPromptPublication(items, staging, projectDir, 'database');
      if (!rollback.recovered) {
        const failure = new AssetProcessingError(
          'Prompt edits were written but CreatorCrate could not safely restore the filesystem after an index failure. Inspect the project folder before scanning.',
          { code: 'RECOVERY_REQUIRED', cause: err },
        );
        failure.recoveryDiagnostics = rollback.diagnostics;
        if (rollback.observationFailure) failure.observationFailure = rollback.observationFailure;
        throw failure;
      }
      if (rollback.evidenceFailure) throw withRollbackEvidence(rollback.evidenceFailure, rollback);
      throw withRollbackEvidence(new AssetProcessingError(
        'Prompt edits were removed because CreatorCrate could not update the asset index.',
        { code: 'DATABASE_OPERATION_FAILED', cause: err },
      ), rollback);
    }

    // The edits are committed: every backup and stage is now a dispensable private copy, so
    // one that cannot be removed is reported as residue and never gates the project. Each
    // item's mutation is resolved first; a resolution failure is propagated only after the
    // other items were cleaned, and never rolls back the committed edits.
    const resolutionFailure = resolveCommittedPromptMutations(items);
    const cleanupDiagnostics = stagingDiagnostics(staging);
    if (!cleanupPromptStaging(staging, { diagnostics: cleanupDiagnostics }).complete) {
      reportResidue?.(summarizeRecoveryDiagnostics('cleanup', cleanupDiagnostics, items, {
        cleanupSucceeded: false,
      }));
    }
    deleteSettledPromptGroups(items);
    if (resolutionFailure) throw resolutionFailure;

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
    requirePromptRecoveryEvidence();
    // The processing job ID is the run ID (and log correlation ID). A direct call outside a
    // job has none, so its one run gets its own opaque ID.
    const runId = typeof onProgress?.jobId === 'string' ? onProgress.jobId : randomUUID();

    const execute = async () => {
      const progress = createProgressReporter(assetIds.length, onProgress);
      const observed = { operation: 'workflow-prompt', projectId, assetCount: assetIds.length, onProgress };
      const result = await observeRecovery(observed, () => editWorkflowPromptsLocked(
        projectId, assetIds, options, progress,
        (recoveryDiagnostics) => logProcessingDiagnostic(PROCESSING_CLEANUP_RESIDUE, observed, { recoveryDiagnostics }),
        runId,
      ));
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
    recoveryEvidenceRecorder: processingRecoveryEvidenceRecorder,
  };
}
