/**
 * Asset rename/move/copy/delete — Node filesystem action service (Phase: asset actions
 * chunk 2, coordinator-integrated in chunk 3).
 *
 * Rename/move updates the same existing asset row in place (same id, same
 * release associations). Batch copy creates new rows, while batch delete
 * stages validated files before removing rows and their schema-defined
 * references.
 * Uses synchronous filesystem operations throughout to match the rest of
 * the application (scanner, manifest, project-storage are all sync).
 *
 * Every public mutation holds the injected `projectOperationCoordinator`'s
 * per-project lock for its entire duration — validation through database
 * update — so it can never interleave with a scan (or another rename/move/copy/
 * missing-record cleanup) for the same project within this process.
 *
 * ─── Post-move failure policy ───────────────────────────────────────────
 * If the physical `fs.renameSync` succeeds but any subsequent step fails
 * (destination verification, metadata derivation, database update), the
 * destination file is left untouched — no rename-back is attempted. The
 * caller receives RECOVERY_REQUIRED so the user can inspect the folder
 * before scanning or retrying. A rescan will re-index whatever is on disk.
 * No automatic compensation is performed because renaming back races with
 * concurrent actors and can silently overwrite newly created files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectDir, resolveCategoryDir, requireRealCategoryDir } from '../storage/project-storage.js';
import { resolveContainedAssetPath } from '../storage/asset-file.js';
import { assertValidAssetFilename, AssetFilenameValidationError } from './asset-filename-validation.js';
import { mimeFromExtension, deriveExtensionFromFilename } from './asset-metadata.js';
import { ProjectOperationError } from './project-operation-coordinator.js';

/**
 * Stable sentinel identifying the "move to Uncategorized" destination.
 * Deliberately not a string or number — callers must import and pass this
 * exact value, so an arbitrary string can never be mistaken for it or for a
 * category ID.
 */
export const UNCATEGORIZED = Symbol('asset-action-service.uncategorized');

export class AssetActionError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'AssetActionError';
    this.code = code;
  }
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function assertPositiveInteger(value, code, label) {
  if (!isPositiveInteger(value)) {
    throw new AssetActionError(`${label} must be a positive integer.`, { code });
  }
}

function isCategoryEnabled(category) {
  return category.enabled === true || category.enabled === 1;
}

/**
 * @param {object} deps
 * @param {import('../data/project-repository.js').ProjectRepository} deps.projectRepository
 * @param {ReturnType<import('../data/asset-repository.js').createAssetRepository>} deps.assetRepository
 * @param {ReturnType<import('../data/asset-category-repository.js').createAssetCategoryRepository>} deps.assetCategoryRepository
 * @param {string} deps.projectsRoot
 * @param {ReturnType<import('./project-operation-coordinator.js').createProjectOperationCoordinator>} deps.projectOperationCoordinator
 *   Shared per-project lock (Phase: asset actions chunk 3) — the same
 *   instance the caller also injects into the asset scanner, so a scan and
 *   a rename/move/copy/delete/cleanup for one project can never interleave.
 */
export function createAssetActionService({
  projectRepository,
  assetRepository,
  assetCategoryRepository,
  projectsRoot,
  projectOperationCoordinator,
} = {}) {
  if (!projectRepository) throw new Error('createAssetActionService requires a projectRepository dependency.');
  if (!assetRepository) throw new Error('createAssetActionService requires an assetRepository dependency.');
  if (!assetCategoryRepository) throw new Error('createAssetActionService requires an assetCategoryRepository dependency.');
  if (!projectsRoot) throw new Error('createAssetActionService requires a projectsRoot dependency.');
  if (!projectOperationCoordinator) throw new Error('createAssetActionService requires a projectOperationCoordinator dependency.');

  /**
   * Run `callback` (the full body of a rename/move/copy/delete, from validation through
   * database update) under this project's lock. A same-project scan or another
   * rename/move/copy/delete already in progress surfaces as the coordinator's own
   * PROJECT_OPERATION_IN_PROGRESS — translated here into a precise
   * AssetActionError so callers only ever need to recognize one error type
   * from this service. Intended future HTTP mapping: 409 Conflict (the
   * request can be retried once the in-progress operation finishes).
   * Any other error (including the coordinator's own INVALID_PROJECT_ID,
   * which should be unreachable here since callers validate projectId
   * first) is rethrown unchanged — never swallowed.
   */
  function runLocked(projectId, callback) {
    try {
      return projectOperationCoordinator.run(projectId, callback);
    } catch (err) {
      if (err instanceof ProjectOperationError && err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
        throw new AssetActionError(
          `An operation is already in progress for project ${projectId}. Try again shortly.`,
          { code: 'PROJECT_BUSY' }
        );
      }
      throw err;
    }
  }

  // ── Project / asset loading (shared source-validation steps 1-5) ──────

  function requireProject(projectId) {
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new AssetActionError(`Project ${projectId} not found.`, { code: 'PROJECT_NOT_FOUND' });
    }
    return project;
  }

  function requireMutableProject(projectId) {
    const project = requireProject(projectId);
    if (project.archived_at || project.status === 'archived') {
      throw new AssetActionError(`Project ${projectId} is archived and cannot be modified.`, { code: 'PROJECT_ARCHIVED' });
    }
    return project;
  }

  // Cross-project asset access is indistinguishable from an unknown ID —
  // mirrors the convention documented on
  // assetCategoryRepository.findProjectCategoryById.
  function requireAsset(projectId, assetId) {
    const asset = assetRepository.findById(assetId);
    if (!asset || asset.project_id !== projectId) {
      throw new AssetActionError(`Asset ${assetId} not found.`, { code: 'ASSET_NOT_FOUND' });
    }
    return asset;
  }

  function requirePresentAsset(projectId, assetId, action = 'moved or renamed') {
    const asset = requireAsset(projectId, assetId);
    if (asset.is_present !== 1) {
      throw new AssetActionError(`Asset ${assetId} is marked missing and cannot be ${action}.`, { code: 'ASSET_MISSING' });
    }
    return asset;
  }

  function resolveProjectAbsPath(project) {
    if (!project.project_dir) {
      throw new AssetActionError('Project has no stored directory path.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
    }
    try {
      return resolveProjectDir(projectsRoot, project.project_dir);
    } catch {
      throw new AssetActionError('Project directory cannot be accessed.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
    }
  }

  /**
   * Resolve a project-relative asset path with full containment + symlinked-
   * intermediate checks (reused from storage/asset-file.js), translated into
   * a controlled AssetActionError under the caller-supplied code.
   */
  function resolveContained(dirAbsPath, relativePath, code, label) {
    try {
      // checkFinalSymlink: false — the leaf's own type (missing, symlink,
      // directory, non-regular, or present) is determined by the caller's
      // own lstat-based inspection immediately afterward, so it can report
      // the precise SOURCE_*/DESTINATION_CONFLICT code instead of this
      // generic one. Every intermediate directory component is still fully
      // checked here.
      return resolveContainedAssetPath(dirAbsPath, relativePath, { checkFinalSymlink: false });
    } catch {
      throw new AssetActionError(`${label} path is unsafe.`, { code });
    }
  }

  // ── Source validation (steps 6-10) ─────────────────────────────────────

  /**
   * lstat the source, rejecting anything but a real, non-symlink, regular
   * file. Never follows a symlink. Returns the raw stats so identity
   * (dev/ino) and metadata (size/mtime) can be captured before mutation.
   */
  function inspectSource(sourceAbsPath) {
    let stats;
    try {
      stats = fs.lstatSync(sourceAbsPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new AssetActionError('Source file does not exist.', { code: 'SOURCE_MISSING' });
      }
      throw new AssetActionError('Source file cannot be accessed.', { code: 'SOURCE_PATH_UNSAFE' });
    }
    if (stats.isSymbolicLink()) {
      throw new AssetActionError('Source file is a symbolic link.', { code: 'SOURCE_SYMLINK' });
    }
    if (!stats.isFile()) {
      // Covers directories and any other non-regular object (device, FIFO,
      // socket) with a single check, matching Node's isFile() semantics.
      throw new AssetActionError('Source path does not point to a regular file.', { code: 'SOURCE_NOT_REGULAR' });
    }
    return stats;
  }

  // ── Destination occupancy preflight (DB, then filesystem) ─────────────

  /**
   * Any other asset row already at `newRelativePath` is a conflict —
   * present or missing. Must run before any filesystem mutation.
   */
  function assertDestinationClearInDb(projectId, newRelativePath) {
    const existing = assetRepository.findByProjectIdAndPath(projectId, newRelativePath);
    if (existing) {
      throw new AssetActionError('Destination path is already used by another asset record.', { code: 'DESTINATION_CONFLICT' });
    }
  }

  /**
   * Any existing filesystem object at the destination — file, directory,
   * symlink, or anything else `lstatSync` can see — is a conflict. This
   * check (like the DB check above) runs before `fs.renameSync`, but see
   * the race-window comment on performMoveAndUpdate: it cannot make the
   * subsequent rename atomic-with-respect-to-conflict.
   */
  function assertDestinationClearOnDisk(destAbsPath) {
    try {
      fs.lstatSync(destAbsPath);
    } catch (err) {
      if (err.code === 'ENOENT') return; // clear — nothing occupies the path
      throw new AssetActionError('Cannot verify the destination path.', { code: 'DESTINATION_DIRECTORY_UNSAFE' });
    }
    throw new AssetActionError('Destination path already exists.', { code: 'DESTINATION_CONFLICT' });
  }

  function resolveBatchDestination(
    projectId,
    projectDir,
    destinationCategoryIdOrUncategorized,
    precheckCode = 'BATCH_PRECHECK_FAILED',
  ) {
    let destCategoryId;
    let destDirAbsPath;
    let destCategorySlug = null;

    if (destinationCategoryIdOrUncategorized === UNCATEGORIZED) {
      let rootStats;
      try {
        rootStats = fs.lstatSync(projectDir);
      } catch {
        throw new AssetActionError('Project directory cannot be accessed.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
      }
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw new AssetActionError('Project directory is unsafe.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
      }
      destCategoryId = null;
      destDirAbsPath = projectDir;
    } else if (isPositiveInteger(destinationCategoryIdOrUncategorized)) {
      const category = assetCategoryRepository.findProjectCategoryById(projectId, destinationCategoryIdOrUncategorized);
      if (!category) {
        throw new AssetActionError('Destination category not found.', { code: precheckCode });
      }
      if (!isCategoryEnabled(category)) {
        throw new AssetActionError('Destination category is disabled.', { code: precheckCode });
      }

      let categoryAbsPath;
      try {
        categoryAbsPath = resolveCategoryDir(projectDir, category.directory_slug);
      } catch {
        throw new AssetActionError('Destination category directory is unsafe.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
      }

      try {
        requireRealCategoryDir(categoryAbsPath);
      } catch (err) {
        if (err.message.includes('does not exist')) {
          throw new AssetActionError('Destination category directory does not exist.', { code: precheckCode });
        }
        throw new AssetActionError('Destination category directory is unsafe.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
      }

      destCategoryId = category.id;
      destDirAbsPath = categoryAbsPath;
      destCategorySlug = category.directory_slug;
    } else {
      throw new AssetActionError(
        'Destination must be a valid enabled category ID or the Uncategorized sentinel.',
        { code: precheckCode }
      );
    }

    return { destCategoryId, destDirAbsPath, destCategorySlug };
  }

  // ── Post-move verification ─────────────────────────────────────────────

  function assertSourceGoneAfterMove(sourceAbsPath) {
    try {
      fs.lstatSync(sourceAbsPath);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new Error('Cannot verify the source path is absent after the move.');
    }
    throw new Error('Source path still exists after the move — verification is ambiguous.');
  }

  function inspectDestinationAfterMove(destAbsPath) {
    let stats;
    try {
      stats = fs.lstatSync(destAbsPath);
    } catch {
      throw new Error('Destination path is missing after the move.');
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('Destination path is not a regular, non-symlink file after the move.');
    }
    return stats;
  }

  // dev/ino are the strongest identity signal Node exposes, but they are a
  // filesystem-dependent convention, not a cross-platform guarantee. Both
  // values come from lstatSync calls made in this same process a moment
  // apart, so a straight equality check is the pragmatic comparison used
  // here — no attempt is made to normalize or second-guess platforms where
  // these fields might not be meaningful.
  function identityMatches(sourceIdentity, stats) {
    return stats.dev === sourceIdentity.dev && stats.ino === sourceIdentity.ino;
  }

  function removeDeleteStagingDir(stagingDir) {
    try {
      // Empty-directory removal is intentionally non-recursive: unexpected
      // objects left in the staging area must make cleanup fail visibly.
      fs.rmdirSync(stagingDir);
      return true;
    } catch (err) {
      return err.code === 'ENOENT';
    }
  }

  function restoreStagedDeleteFiles(stagedItems) {
    let restored = true;

    for (const item of [...stagedItems].reverse()) {
      if (!item.staged) continue;

      try {
        const stagedStats = fs.lstatSync(item.stagedAbsPath);
        if (!identityMatches(item.sourceIdentity, stagedStats)) {
          restored = false;
          continue;
        }

        try {
          fs.lstatSync(item.sourceAbsPath);
          // Never overwrite an object that appeared at the original path
          // after staging began.
          restored = false;
          continue;
        } catch (err) {
          if (err.code !== 'ENOENT') {
            restored = false;
            continue;
          }
        }

        fs.renameSync(item.stagedAbsPath, item.sourceAbsPath);
        item.staged = false;
      } catch {
        restored = false;
      }
    }

    return restored;
  }

  function recoverStagedDelete(staging) {
    const restored = restoreStagedDeleteFiles(staging.items);
    const stagingRemoved = removeDeleteStagingDir(staging.stagingDir);
    return restored && stagingRemoved;
  }

  function stageDeleteFiles(projectDir, preflightItems) {
    let stagingDir;
    try {
      // Dot-directories are ignored by the scanner and keep a failed recovery
      // staging area out of the indexed asset surface.
      stagingDir = fs.mkdtempSync(path.join(projectDir, '.creatorcrate-delete-'));
    } catch {
      throw new AssetActionError(
        'CreatorCrate could not prepare a safe deletion staging area.',
        { code: 'DELETE_FILESYSTEM_OPERATION_FAILED' }
      );
    }

    const stagedItems = preflightItems.map((item, index) => ({
      sourceAbsPath: item.sourceAbsPath,
      sourceIdentity: item.sourceIdentity,
      stagedAbsPath: path.join(stagingDir, String(index)),
      staged: false,
    }));

    try {
      for (const item of stagedItems) {
        const currentStats = inspectSource(item.sourceAbsPath);
        if (!identityMatches(item.sourceIdentity, currentStats)) {
          throw new Error('Source identity changed before deletion staging.');
        }

        fs.renameSync(item.sourceAbsPath, item.stagedAbsPath);
        item.staged = true;

        const stagedStats = inspectSource(item.stagedAbsPath);
        if (!identityMatches(item.sourceIdentity, stagedStats)) {
          throw new Error('Staged source identity does not match the selected asset.');
        }
      }

      return { stagingDir, items: stagedItems };
    } catch {
      if (!recoverStagedDelete({ stagingDir, items: stagedItems })) {
        throw new AssetActionError(
          'CreatorCrate could not safely restore files after deletion staging failed. Inspect the project folder before scanning.',
          { code: 'DELETE_RECOVERY_REQUIRED' }
        );
      }
      throw new AssetActionError(
        'The selected files could not be staged for deletion. No selected files were deleted.',
        { code: 'DELETE_FILESYSTEM_OPERATION_FAILED' }
      );
    }
  }

  function cleanupStagedDeleteFiles(staging) {
    let clean = true;

    for (const item of staging.items) {
      if (!item.staged) continue;

      try {
        const stagedStats = fs.lstatSync(item.stagedAbsPath);
        if (!identityMatches(item.sourceIdentity, stagedStats)) {
          clean = false;
          continue;
        }
        fs.rmSync(item.stagedAbsPath);
        item.staged = false;
      } catch (err) {
        if (err.code === 'ENOENT') {
          item.staged = false;
        } else {
          clean = false;
        }
      }
    }

    if (!removeDeleteStagingDir(staging.stagingDir)) clean = false;
    return clean;
  }

  /**
   * Shared tail for both renameAsset and moveAsset: perform the physical
   * `fs.renameSync`, verify it, derive refreshed metadata, and update the
   * existing asset row.
   *
   * If the forward rename succeeds but any later step fails, the destination
   * file is left untouched — no rename-back is attempted. The caller
   * receives RECOVERY_REQUIRED. No automatic compensation is performed
   * because a rename-back races with concurrent actors and can silently
   * overwrite newly created files at the old source path.
   *
   * ─── Residual race (documented, not solved here) ──────────────────────
   * `assertDestinationClearOnDisk` above and this `fs.renameSync` are two
   * separate syscalls, not one atomic operation. An external actor — e.g.
   * another process writing through an SMB/network share to the same
   * project directory — could create a file at exactly `destAbsPath` in the
   * instant between the preflight check and this rename. Node's
   * `fs.renameSync` (like POSIX `rename(2)` and Windows `MoveFileExW`) would
   * then silently replace that newly created file; there is no cross-
   * platform no-clobber rename available from pure JavaScript. This is an
   * accepted residual race for the single-user v1 design — it is not made
   * atomic here, and this comment intentionally does not claim otherwise.
   */
  function performMoveAndUpdate({
    projectId, assetId,
    sourceAbsPath, destAbsPath,
    oldRelativePath, newRelativePath,
    newFilename, categoryId, nestedPath,
    sourceIdentity,
  }) {
    try {
      fs.renameSync(sourceAbsPath, destAbsPath);
    } catch {
      // Nothing moved — no database mutation attempted.
      throw new AssetActionError('Failed to move the asset file on disk.', { code: 'FILESYSTEM_OPERATION_FAILED' });
    }

    // From here on the filesystem has moved. Any failure leaves the
    // destination file untouched — no rename-back is attempted.
    try {
      assertSourceGoneAfterMove(sourceAbsPath);
      const destStats = inspectDestinationAfterMove(destAbsPath);
      if (!identityMatches(sourceIdentity, destStats)) {
        throw new Error('Destination identity does not match the moved source.');
      }

      const extension = deriveExtensionFromFilename(newFilename);
      const mimeType = mimeFromExtension(extension);

      const result = assetRepository.updateAssetLocation(projectId, assetId, oldRelativePath, {
        relativePath: newRelativePath,
        filename: newFilename,
        extension,
        mimeType,
        categoryId,
        nestedPath,
        sizeBytes: destStats.size,
        modifiedAt: destStats.mtime.toISOString(),
      });

      if (!result.ok) {
        throw new Error(`Repository update did not apply (${result.reason}).`);
      }

      return result.asset;
    } catch {
      throw new AssetActionError(
        'The file was moved on disk, but CreatorCrate could not finish updating its records. Inspect the project folder before scanning or trying again.',
        { code: 'RECOVERY_REQUIRED' }
      );
    }
  }

  // Holds the project lock for its entire body — validation through
  // database update. Never exposed publicly; only reachable via runLocked from
  // the returned renameAsset method below.
  function renameAssetLocked(projectId, assetId, filename) {
      let newFilename;
      try {
        newFilename = assertValidAssetFilename(filename);
      } catch (err) {
        if (err instanceof AssetFilenameValidationError) {
          throw new AssetActionError(err.message, { code: 'INVALID_FILENAME' });
        }
        throw err;
      }

      const project = requireMutableProject(projectId);
      const asset = requirePresentAsset(projectId, assetId);

      const oldRelativePath = asset.relative_path;
      const segments = oldRelativePath.split('/');
      const oldFilename = segments[segments.length - 1];

      if (newFilename === oldFilename) {
        throw new AssetActionError('New filename is unchanged.', { code: 'UNCHANGED_LOCATION' });
      }
      if (newFilename.toLowerCase() === oldFilename.toLowerCase()) {
        throw new AssetActionError('Case-only rename is not supported.', { code: 'CASE_ONLY_RENAME_UNSUPPORTED' });
      }

      const newRelativePath = [...segments.slice(0, -1), newFilename].join('/');

      const projectDir = resolveProjectAbsPath(project);
      const sourceAbsPath = resolveContained(projectDir, oldRelativePath, 'SOURCE_PATH_UNSAFE', 'Source');
      const sourceStats = inspectSource(sourceAbsPath);
      const sourceIdentity = { dev: sourceStats.dev, ino: sourceStats.ino };

      const destAbsPath = resolveContained(projectDir, newRelativePath, 'DESTINATION_DIRECTORY_UNSAFE', 'Destination');

      assertDestinationClearInDb(projectId, newRelativePath);
      assertDestinationClearOnDisk(destAbsPath);

      return performMoveAndUpdate({
        projectId, assetId,
        sourceAbsPath, destAbsPath,
        oldRelativePath, newRelativePath,
        newFilename,
        categoryId: asset.category_id,
        nestedPath: asset.nested_path,
        sourceIdentity,
      });
  }

  function renameAssetBasenameLocked(projectId, assetId, basename) {
    const asset = requirePresentAsset(projectId, assetId);
    try {
      assertValidAssetFilename(basename);
    } catch (err) {
      if (err instanceof AssetFilenameValidationError) {
        throw new AssetActionError(err.message, { code: 'INVALID_FILENAME' });
      }
      throw err;
    }

    const pathSegments = asset.relative_path.split('/');
    const currentFilename = pathSegments[pathSegments.length - 1];
    const extensionStart = currentFilename.lastIndexOf('.');
    const extension = extensionStart > 0 ? currentFilename.slice(extensionStart + 1) : '';
    const filename = extension ? `${basename}.${extension}` : basename;
    return renameAssetLocked(projectId, assetId, filename);
  }

  // Holds the project lock for its entire body — validation through
  // database update. Never exposed publicly; only reachable via runLocked from
  // the returned moveAsset method below.
  // ── Batch move (shared destination resolution + preflight + execution) ───

  function moveAssetsLocked(projectId, assetIds, destinationCategoryIdOrUncategorized) {
    const requestedCount = assetIds.length;

    // Reject duplicate IDs — two assets moving to the same destination filename
    // would conflict with each other; detect this before any filesystem work.
    const idSet = new Set(assetIds);
    if (idSet.size !== assetIds.length) {
      throw new AssetActionError('Duplicate asset IDs in selection.', { code: 'BATCH_PRECHECK_FAILED' });
    }

    const project = requireMutableProject(projectId);
    const projectDir = resolveProjectAbsPath(project);

    // Resolve destination once for the whole batch.
    const { destCategoryId, destDirAbsPath, destCategorySlug } = resolveBatchDestination(
      projectId,
      projectDir,
      destinationCategoryIdOrUncategorized,
    );

    // Per-asset preflight — load, validate, compute destination.
    const preflightItems = [];
    const destinationPaths = new Set();

    for (const assetId of assetIds) {
      let asset;
      try {
        asset = requirePresentAsset(projectId, assetId);
      } catch (err) {
        if (err instanceof AssetActionError) {
          throw new AssetActionError(err.message, { code: 'BATCH_PRECHECK_FAILED' });
        }
        throw err;
      }

      const filename = asset.filename;
      const newRelativePath = destCategoryId === null
        ? filename
        : `${destCategorySlug}/${filename}`;

      if (newRelativePath === asset.relative_path) {
        throw new AssetActionError(
          'One or more selected assets are already in the target location.',
          { code: 'BATCH_PRECHECK_FAILED' }
        );
      }

      if (destinationPaths.has(newRelativePath)) {
        throw new AssetActionError(
          'Two or more selected assets would have the same destination filename.',
          { code: 'BATCH_DUPLICATE_DESTINATION' }
        );
      }
      destinationPaths.add(newRelativePath);

      preflightItems.push({ assetId, asset, filename, newRelativePath });
    }

    // DB conflict check: does any existing asset already occupy the destination path?
    for (const item of preflightItems) {
      const existing = assetRepository.findByProjectIdAndPath(projectId, item.newRelativePath);
      if (existing && existing.id !== item.assetId) {
        throw new AssetActionError(
          'Destination already used by another asset record.',
          { code: 'BATCH_DESTINATION_CONFLICT' }
        );
      }
    }

    // Filesystem preflight: source must exist and destination must be clear.
    for (const item of preflightItems) {
      const sourceAbsPath = resolveContained(projectDir, item.asset.relative_path, 'SOURCE_PATH_UNSAFE', 'Source');
      let sourceStats;
      try {
        sourceStats = inspectSource(sourceAbsPath);
      } catch (err) {
        if (err instanceof AssetActionError) {
          throw new AssetActionError(err.message, { code: 'BATCH_PRECHECK_FAILED' });
        }
        throw err;
      }
      const destAbsPath = resolveContained(destDirAbsPath, item.filename, 'DESTINATION_DIRECTORY_UNSAFE', 'Destination');
      try {
        assertDestinationClearOnDisk(destAbsPath);
      } catch (err) {
        if (err instanceof AssetActionError && err.code === 'DESTINATION_CONFLICT') {
          throw new AssetActionError('Destination already exists on disk.', { code: 'BATCH_DESTINATION_CONFLICT' });
        }
        throw new AssetActionError('Cannot verify the destination path.', { code: 'BATCH_PRECHECK_FAILED' });
      }
      item.sourceAbsPath = sourceAbsPath;
      item.sourceIdentity = { dev: sourceStats.dev, ino: sourceStats.ino };
      item.destAbsPath = destAbsPath;
    }

    // Execution phase: move one at a time, stop on the first failure.
    const completedAssetIds = [];

    for (const item of preflightItems) {
      try {
        performMoveAndUpdate({
          projectId, assetId: item.assetId,
          sourceAbsPath: item.sourceAbsPath,
          destAbsPath: item.destAbsPath,
          oldRelativePath: item.asset.relative_path,
          newRelativePath: item.newRelativePath,
          newFilename: item.filename,
          categoryId: destCategoryId,
          nestedPath: '',
          sourceIdentity: item.sourceIdentity,
        });
        completedAssetIds.push(item.assetId);
      } catch (err) {
        const movedCount = completedAssetIds.length;
        const batchCode = (err instanceof AssetActionError && err.code === 'RECOVERY_REQUIRED')
          ? 'BATCH_RECOVERY_REQUIRED'
          : 'BATCH_PARTIAL_FAILURE';
        const batchErr = new AssetActionError(
          `Moved ${movedCount} of ${requestedCount} asset${requestedCount !== 1 ? 's' : ''} before an error occurred.`,
          { code: batchCode }
        );
        batchErr.batchContext = { movedCount, requestedCount, completedAssetIds: [...completedAssetIds] };
        throw batchErr;
      }
    }

    return { movedCount: completedAssetIds.length, requestedCount, completedAssetIds };
  }

  function inspectDestinationAfterCopy(destAbsPath) {
    let stats;
    try {
      stats = fs.lstatSync(destAbsPath);
    } catch {
      throw new Error('Destination path is missing after the copy.');
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('Destination path is not a regular, non-symlink file after the copy.');
    }
    return stats;
  }

  function cleanupCopiedFiles(copiedItems) {
    let clean = true;
    for (const item of [...copiedItems].reverse()) {
      if (!item.identity) {
        clean = false;
        continue;
      }

      try {
        const stats = fs.lstatSync(item.destAbsPath);
        if (stats.dev !== item.identity.dev || stats.ino !== item.identity.ino) {
          clean = false;
          continue;
        }
        fs.rmSync(item.destAbsPath);
      } catch (err) {
        if (err.code !== 'ENOENT') clean = false;
      }
    }
    return clean;
  }

  function copyAssetsLocked(projectId, assetIds, destinationCategoryIdOrUncategorized) {
    const requestedCount = assetIds.length;
    const idSet = new Set(assetIds);
    if (idSet.size !== assetIds.length) {
      throw new AssetActionError('Duplicate asset IDs in selection.', { code: 'COPY_PRECHECK_FAILED' });
    }

    const project = requireMutableProject(projectId);
    const projectDir = resolveProjectAbsPath(project);
    const { destCategoryId, destDirAbsPath, destCategorySlug } = resolveBatchDestination(
      projectId,
      projectDir,
      destinationCategoryIdOrUncategorized,
      'COPY_PRECHECK_FAILED',
    );

    const preflightItems = [];
    const destinationPaths = new Set();

    for (const assetId of assetIds) {
      let asset;
      try {
        asset = requirePresentAsset(projectId, assetId);
      } catch (err) {
        if (err instanceof AssetActionError) {
          throw new AssetActionError(err.message, { code: 'COPY_PRECHECK_FAILED' });
        }
        throw err;
      }

      const filename = asset.filename;
      const newRelativePath = destCategoryId === null
        ? filename
        : `${destCategorySlug}/${filename}`;

      if (destinationPaths.has(newRelativePath)) {
        throw new AssetActionError(
          'Two or more selected assets would have the same destination filename.',
          { code: 'COPY_DUPLICATE_DESTINATION' }
        );
      }
      destinationPaths.add(newRelativePath);

      preflightItems.push({ assetId, asset, filename, newRelativePath });
    }

    // A copy always creates a new indexed row, so even the selected source row
    // itself conflicts when the destination path is already indexed.
    for (const item of preflightItems) {
      const existing = assetRepository.findByProjectIdAndPath(projectId, item.newRelativePath);
      if (existing) {
        throw new AssetActionError(
          'Destination already used by another asset record.',
          { code: 'COPY_DESTINATION_CONFLICT' }
        );
      }
    }

    for (const item of preflightItems) {
      const sourceAbsPath = resolveContained(projectDir, item.asset.relative_path, 'SOURCE_PATH_UNSAFE', 'Source');
      try {
        inspectSource(sourceAbsPath);
      } catch (err) {
        if (err instanceof AssetActionError) {
          throw new AssetActionError(err.message, { code: 'COPY_PRECHECK_FAILED' });
        }
        throw err;
      }

      const destAbsPath = resolveContained(destDirAbsPath, item.filename, 'DESTINATION_DIRECTORY_UNSAFE', 'Destination');
      try {
        assertDestinationClearOnDisk(destAbsPath);
      } catch (err) {
        if (err instanceof AssetActionError && err.code === 'DESTINATION_CONFLICT') {
          throw new AssetActionError('Destination already exists on disk.', { code: 'COPY_DESTINATION_CONFLICT' });
        }
        throw new AssetActionError('Cannot verify the destination path.', { code: 'COPY_PRECHECK_FAILED' });
      }

      item.sourceAbsPath = sourceAbsPath;
      item.destAbsPath = destAbsPath;
    }

    const copiedItems = [];
    try {
      for (const item of preflightItems) {
        fs.copyFileSync(item.sourceAbsPath, item.destAbsPath, fs.constants.COPYFILE_EXCL);
        const copied = { destAbsPath: item.destAbsPath, identity: null };
        copiedItems.push(copied);
        const destStats = inspectDestinationAfterCopy(item.destAbsPath);
        copied.identity = { dev: destStats.dev, ino: destStats.ino };
        item.record = {
          relativePath: item.newRelativePath,
          filename: item.filename,
          extension: deriveExtensionFromFilename(item.filename),
          mimeType: mimeFromExtension(deriveExtensionFromFilename(item.filename)),
          categoryId: destCategoryId,
          nestedPath: '',
          sizeBytes: destStats.size,
          modifiedAt: destStats.mtime.toISOString(),
        };
      }

      const copiedAssets = assetRepository.upsertMany(projectId, preflightItems.map((item) => item.record));
      return {
        copiedCount: copiedAssets.length,
        requestedCount,
        copiedAssetIds: copiedAssets.map((asset) => asset.id),
      };
    } catch (err) {
      const cleaned = cleanupCopiedFiles(copiedItems);
      if (!cleaned) {
        throw new AssetActionError(
          'Files were copied, but CreatorCrate could not safely finish or clean up the batch. Inspect the project folder before scanning.',
          { code: 'COPY_RECOVERY_REQUIRED' }
        );
      }
      if (err instanceof AssetActionError && err.code === 'COPY_DESTINATION_CONFLICT') {
        throw err;
      }
      if (err && err.code === 'EEXIST') {
        throw new AssetActionError('Destination already exists for one or more selected assets.', { code: 'COPY_DESTINATION_CONFLICT' });
      }
      throw new AssetActionError(
        'The selected files could not be copied. No copied files were retained.',
        { code: 'COPY_FILESYSTEM_OPERATION_FAILED' }
      );
    }
  }

  // Holds the project lock for the entire deletion operation. Every selected
  // asset and source path is preflighted before any source is moved into the
  // private staging area. The indexed rows are deleted transactionally after
  // staging; staged files are physically removed only after that commit.
  function deleteAssetsLocked(projectId, assetIds) {
    const requestedCount = assetIds.length;
    const idSet = new Set(assetIds);
    if (idSet.size !== assetIds.length) {
      throw new AssetActionError('Duplicate asset IDs in selection.', { code: 'DELETE_PRECHECK_FAILED' });
    }

    const project = requireMutableProject(projectId);
    const publishedReleaseAssetIds = assetRepository.findPublishedReleaseAssetIds(projectId, assetIds);
    if (publishedReleaseAssetIds.length > 0) {
      throw new AssetActionError(
        `Assets associated with a published release cannot be deleted: ${publishedReleaseAssetIds.join(', ')}.`,
        { code: 'DELETE_PUBLISHED_RELEASE_ASSET' }
      );
    }

    const projectDir = resolveProjectAbsPath(project);
    const preflightItems = [];

    for (const assetId of assetIds) {
      try {
        const asset = requirePresentAsset(projectId, assetId, 'permanently deleted');
        const sourceAbsPath = resolveContained(projectDir, asset.relative_path, 'SOURCE_PATH_UNSAFE', 'Source');
        const sourceStats = inspectSource(sourceAbsPath);
        preflightItems.push({
          assetId,
          asset,
          sourceAbsPath,
          sourceIdentity: { dev: sourceStats.dev, ino: sourceStats.ino },
        });
      } catch (err) {
        if (err instanceof AssetActionError) {
          throw new AssetActionError(err.message, { code: 'DELETE_PRECHECK_FAILED' });
        }
        throw err;
      }
    }

    const staging = stageDeleteFiles(projectDir, preflightItems);
    let deletedAssets;
    try {
      deletedAssets = assetRepository.deleteMany(
        projectId,
        preflightItems.map((item) => ({
          assetId: item.assetId,
          relativePath: item.asset.relative_path,
        })),
      );
      if (!Array.isArray(deletedAssets) || deletedAssets.length !== requestedCount) {
        throw new Error('Asset repository deleted an unexpected number of rows.');
      }
    } catch {
      if (!recoverStagedDelete(staging)) {
        throw new AssetActionError(
          'CreatorCrate could not safely restore files after indexed deletion failed. Inspect the project folder before scanning.',
          { code: 'DELETE_RECOVERY_REQUIRED' }
        );
      }
      throw new AssetActionError(
        'The selected files were restored because CreatorCrate could not remove all indexed asset records.',
        { code: 'DELETE_DATABASE_OPERATION_FAILED' }
      );
    }

    if (!cleanupStagedDeleteFiles(staging)) {
      throw new AssetActionError(
        'Asset records were deleted, but CreatorCrate could not safely remove every staged file. Inspect the project folder before scanning.',
        { code: 'DELETE_RECOVERY_REQUIRED' }
      );
    }

    return {
      deletedCount: deletedAssets.length,
      requestedCount,
      deletedAssetIds: deletedAssets.map((asset) => asset.id),
    };
  }

  // Holds the project lock through candidate selection and indexed cleanup.
  // This operation only removes rows already marked missing; it never needs
  // to inspect, stage, or delete anything on the filesystem.
  function removeMissingAssetsLocked(projectId) {
    requireMutableProject(projectId);

    const candidates = assetRepository.findMissingByProjectId(projectId);
    const candidateIds = candidates.map((asset) => asset.id);
    const protectedAssetIds = new Set(
      assetRepository.findPublishedReleaseAssetIds(projectId, candidateIds)
    );
    const eligible = candidates.filter((asset) => !protectedAssetIds.has(asset.id));

    let removedAssets = [];
    if (eligible.length > 0) {
      try {
        removedAssets = assetRepository.deleteMissingMany(
          projectId,
          eligible.map((asset) => ({ assetId: asset.id, relativePath: asset.relative_path })),
        );
        if (!Array.isArray(removedAssets) || removedAssets.length !== eligible.length) {
          throw new Error('Asset repository removed an unexpected number of rows.');
        }
      } catch {
        throw new AssetActionError(
          'CreatorCrate could not remove the missing asset records.',
          { code: 'REMOVE_MISSING_DATABASE_OPERATION_FAILED' }
        );
      }
    }

    return {
      removedCount: removedAssets.length,
      protectedCount: protectedAssetIds.size,
      totalMissingCandidates: candidates.length,
      removedAssetIds: removedAssets.map((asset) => asset.id),
      protectedAssetIds: candidates
        .filter((asset) => protectedAssetIds.has(asset.id))
        .map((asset) => asset.id),
    };
  }

  function moveAssetLocked(projectId, assetId, destinationCategoryIdOrUncategorized) {
      const project = requireMutableProject(projectId);
      const asset = requirePresentAsset(projectId, assetId);

      const projectDir = resolveProjectAbsPath(project);

      let destCategoryId;
      let destDirAbsPath;
      let destCategorySlug = null;

      if (destinationCategoryIdOrUncategorized === UNCATEGORIZED) {
        let rootStats;
        try {
          rootStats = fs.lstatSync(projectDir);
        } catch {
          throw new AssetActionError('Project directory cannot be accessed.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
        }
        if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
          throw new AssetActionError('Project directory is unsafe.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
        }
        destCategoryId = null;
        destDirAbsPath = projectDir;
      } else if (isPositiveInteger(destinationCategoryIdOrUncategorized)) {
        const category = assetCategoryRepository.findProjectCategoryById(projectId, destinationCategoryIdOrUncategorized);
        if (!category) {
          throw new AssetActionError('Destination category not found.', { code: 'DESTINATION_CATEGORY_INVALID' });
        }
        if (!isCategoryEnabled(category)) {
          throw new AssetActionError('Destination category is disabled.', { code: 'DESTINATION_CATEGORY_DISABLED' });
        }

        let categoryAbsPath;
        try {
          categoryAbsPath = resolveCategoryDir(projectDir, category.directory_slug);
        } catch {
          throw new AssetActionError('Destination category directory is unsafe.', { code: 'DESTINATION_DIRECTORY_UNSAFE' });
        }

        try {
          requireRealCategoryDir(categoryAbsPath);
        } catch (err) {
          if (err.message.includes('does not exist')) {
            throw new AssetActionError('Destination category directory does not exist.', { code: 'DESTINATION_DIRECTORY_MISSING' });
          }
          throw new AssetActionError('Destination category directory is unsafe.', { code: 'DESTINATION_DIRECTORY_UNSAFE' });
        }

        destCategoryId = category.id;
        destDirAbsPath = categoryAbsPath;
        destCategorySlug = category.directory_slug;
      } else {
        throw new AssetActionError(
          'Destination must be a valid enabled category ID or the Uncategorized sentinel.',
          { code: 'DESTINATION_CATEGORY_INVALID' }
        );
      }

      const filename = asset.filename;
      const newRelativePath = destCategoryId === null
        ? filename
        : `${destCategorySlug}/${filename}`;

      const oldRelativePath = asset.relative_path;
      if (newRelativePath === oldRelativePath) {
        throw new AssetActionError('Destination is unchanged.', { code: 'UNCHANGED_LOCATION' });
      }

      const sourceAbsPath = resolveContained(projectDir, oldRelativePath, 'SOURCE_PATH_UNSAFE', 'Source');
      const sourceStats = inspectSource(sourceAbsPath);
      const sourceIdentity = { dev: sourceStats.dev, ino: sourceStats.ino };

      const destAbsPath = resolveContained(destDirAbsPath, filename, 'DESTINATION_DIRECTORY_UNSAFE', 'Destination');

      assertDestinationClearInDb(projectId, newRelativePath);
      assertDestinationClearOnDisk(destAbsPath);

      return performMoveAndUpdate({
        projectId, assetId,
        sourceAbsPath, destAbsPath,
        oldRelativePath, newRelativePath,
        newFilename: filename,
        categoryId: destCategoryId,
        nestedPath: '',
        sourceIdentity,
      });
  }

  return {
    /**
     * Rename an asset's file in place — same parent directory, same
     * category and nested_path, only the filename changes. Holds this
     * project's lock for the entire operation (see runLocked above).
     *
     * @param {number} projectId
     * @param {number} assetId
     * @param {string} filename - New filename (basename only).
     * @returns {import('../data/asset-repository.js').AssetRecord}
     * @throws {AssetActionError}
     */
    renameAsset(projectId, assetId, filename) {
      assertPositiveInteger(projectId, 'INVALID_PROJECT_ID', 'projectId');
      assertPositiveInteger(assetId, 'INVALID_ASSET_ID', 'assetId');
      return runLocked(projectId, () => renameAssetLocked(projectId, assetId, filename));
    },

    /**
     * Rename an asset from a basename while preserving its current extension.
     * The complete filename is reconstructed under the project lock and then
     * passes through the same validation and filesystem mutation path as a
     * direct complete-filename rename.
     *
     * @param {number} projectId
     * @param {number} assetId
     * @param {string} basename - New filename without the current extension.
     * @returns {import('../data/asset-repository.js').AssetRecord}
     * @throws {AssetActionError}
     */
    renameAssetBasename(projectId, assetId, basename) {
      assertPositiveInteger(projectId, 'INVALID_PROJECT_ID', 'projectId');
      assertPositiveInteger(assetId, 'INVALID_ASSET_ID', 'assetId');
      return runLocked(projectId, () => renameAssetBasenameLocked(projectId, assetId, basename));
    },

    /**
     * Move an asset directly into an enabled project category's root
     * directory, or to the project root (Uncategorized). Never preserves a
     * previous nested subdirectory, never creates directories, and never
     * moves across projects. Holds this project's lock for the entire
     * operation (see runLocked above).
     *
     * @param {number} projectId
     * @param {number} assetId
     * @param {number|typeof UNCATEGORIZED} destinationCategoryIdOrUncategorized
     * @returns {import('../data/asset-repository.js').AssetRecord}
     * @throws {AssetActionError}
     */
    moveAsset(projectId, assetId, destinationCategoryIdOrUncategorized) {
      assertPositiveInteger(projectId, 'INVALID_PROJECT_ID', 'projectId');
      assertPositiveInteger(assetId, 'INVALID_ASSET_ID', 'assetId');
      return runLocked(projectId, () => moveAssetLocked(projectId, assetId, destinationCategoryIdOrUncategorized));
    },

    /**
     * Move a batch of present assets to the same destination, under one
     * project lock. Full preflight (intra-batch conflict, DB conflict,
     * filesystem conflict) runs before any physical move. Execution stops on
     * the first failure; completed moves are not rolled back.
     *
     * @param {number} projectId
     * @param {number[]} assetIds - Non-empty array of positive-integer asset IDs.
     * @param {number|typeof UNCATEGORIZED} destinationCategoryIdOrUncategorized
     * @returns {{ movedCount: number, requestedCount: number, completedAssetIds: number[] }}
     * @throws {AssetActionError} codes: NO_ASSETS_SELECTED, INVALID_ASSET_SELECTION,
     *   BATCH_PRECHECK_FAILED, BATCH_DESTINATION_CONFLICT, BATCH_DUPLICATE_DESTINATION,
     *   BATCH_PARTIAL_FAILURE, BATCH_RECOVERY_REQUIRED, PROJECT_NOT_FOUND, PROJECT_BUSY,
     *   PROJECT_DIRECTORY_UNSAFE
     */
    moveAssets(projectId, assetIds, destinationCategoryIdOrUncategorized) {
      assertPositiveInteger(projectId, 'INVALID_PROJECT_ID', 'projectId');
      if (!Array.isArray(assetIds)) {
        throw new AssetActionError('assetIds must be an array.', { code: 'INVALID_ASSET_SELECTION' });
      }
      if (assetIds.length === 0) {
        throw new AssetActionError('No assets selected.', { code: 'NO_ASSETS_SELECTED' });
      }
      for (const id of assetIds) {
        if (!isPositiveInteger(id)) {
          throw new AssetActionError('assetIds must contain only positive integer IDs.', { code: 'INVALID_ASSET_SELECTION' });
        }
      }
      return runLocked(projectId, () => moveAssetsLocked(projectId, assetIds, destinationCategoryIdOrUncategorized));
    },

    /**
     * Copy a batch of present assets into one enabled project category or the
     * project root (Uncategorized), under one project lock. Every source,
     * destination database row, destination filesystem path, and intra-batch
     * collision is preflighted before any copy occurs. Originals are retained
     * and new destination rows are indexed atomically after the copies finish.
     *
     * @param {number} projectId
     * @param {number[]} assetIds - Non-empty array of positive-integer asset IDs.
     * @param {number|typeof UNCATEGORIZED} destinationCategoryIdOrUncategorized
     * @returns {{ copiedCount: number, requestedCount: number, copiedAssetIds: number[] }}
     * @throws {AssetActionError}
     */
    copyAssets(projectId, assetIds, destinationCategoryIdOrUncategorized) {
      assertPositiveInteger(projectId, 'INVALID_PROJECT_ID', 'projectId');
      if (!Array.isArray(assetIds)) {
        throw new AssetActionError('assetIds must be an array.', { code: 'INVALID_ASSET_SELECTION' });
      }
      if (assetIds.length === 0) {
        throw new AssetActionError('No assets selected.', { code: 'NO_ASSETS_SELECTED' });
      }
      for (const id of assetIds) {
        if (!isPositiveInteger(id)) {
          throw new AssetActionError('assetIds must contain only positive integer IDs.', { code: 'INVALID_ASSET_SELECTION' });
        }
      }
      return runLocked(projectId, () => copyAssetsLocked(projectId, assetIds, destinationCategoryIdOrUncategorized));
    },

    /**
     * Permanently delete a batch of present assets from disk and the index.
     * All selected source paths are validated before staging; database rows
     * are removed atomically, and schema-defined asset references cascade.
     * Holds the project lock for validation through physical cleanup.
     *
     * @param {number} projectId
     * @param {number[]} assetIds - Non-empty array of positive-integer asset IDs.
     * @returns {{ deletedCount: number, requestedCount: number, deletedAssetIds: number[] }}
     * @throws {AssetActionError} codes: NO_ASSETS_SELECTED, INVALID_ASSET_SELECTION,
     *   DELETE_PUBLISHED_RELEASE_ASSET, DELETE_PRECHECK_FAILED,
     *   DELETE_FILESYSTEM_OPERATION_FAILED,
     *   DELETE_DATABASE_OPERATION_FAILED, DELETE_RECOVERY_REQUIRED,
     *   PROJECT_NOT_FOUND, PROJECT_ARCHIVED, PROJECT_BUSY, PROJECT_DIRECTORY_UNSAFE
     */
    deleteAssets(projectId, assetIds) {
      assertPositiveInteger(projectId, 'INVALID_PROJECT_ID', 'projectId');
      if (!Array.isArray(assetIds)) {
        throw new AssetActionError('assetIds must be an array.', { code: 'INVALID_ASSET_SELECTION' });
      }
      if (assetIds.length === 0) {
        throw new AssetActionError('No assets selected.', { code: 'NO_ASSETS_SELECTED' });
      }
      for (const id of assetIds) {
        if (!isPositiveInteger(id)) {
          throw new AssetActionError('assetIds must contain only positive integer IDs.', { code: 'INVALID_ASSET_SELECTION' });
        }
      }
      return runLocked(projectId, () => deleteAssetsLocked(projectId, assetIds));
    },

    /**
     * Permanently remove database records for missing assets in one project.
     * Published-release assets remain protected and are reported as skipped;
     * no filesystem operation is performed. Holds this project's lock so the
     * cleanup cannot interleave with a scan or another asset mutation.
     *
     * @param {number} projectId
     * @returns {{ removedCount: number, protectedCount: number, totalMissingCandidates: number, removedAssetIds: number[], protectedAssetIds: number[] }}
     * @throws {AssetActionError} codes: INVALID_PROJECT_ID, PROJECT_NOT_FOUND,
     *   PROJECT_ARCHIVED, PROJECT_BUSY, REMOVE_MISSING_DATABASE_OPERATION_FAILED
     */
    removeMissingAssets(projectId) {
      assertPositiveInteger(projectId, 'INVALID_PROJECT_ID', 'projectId');
      return runLocked(projectId, () => removeMissingAssetsLocked(projectId));
    },
  };
}
