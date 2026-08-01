/**
 * Asset rename/move — Node filesystem action service (Phase: asset actions
 * chunk 2, coordinator-integrated in chunk 3).
 *
 * Performs exactly one physical file rename/move per call and updates the
 * same existing asset row in place (same id, same release associations).
 * Uses synchronous filesystem operations throughout to match the rest of
 * the application (scanner, manifest, project-storage are all sync).
 *
 * Every public mutation holds the injected `projectOperationCoordinator`'s
 * per-project lock for its entire duration — validation through database
 * update — so it can never interleave with a scan (or another rename/move)
 * for the same project within this process.
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
 *   a rename/move for one project can never interleave.
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
   * Run `callback` (the full body of a rename/move, from validation through
   * database update) under this project's lock. A same-project scan or another
   * rename/move already in progress surfaces as the coordinator's own
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

  function requirePresentAsset(projectId, assetId) {
    const asset = requireAsset(projectId, assetId);
    if (asset.is_present !== 1) {
      throw new AssetActionError(`Asset ${assetId} is marked missing and cannot be moved or renamed.`, { code: 'ASSET_MISSING' });
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
    let destCategoryId, destDirAbsPath, destCategorySlug;

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
      destCategorySlug = null;
    } else if (isPositiveInteger(destinationCategoryIdOrUncategorized)) {
      const category = assetCategoryRepository.findProjectCategoryById(projectId, destinationCategoryIdOrUncategorized);
      if (!category) {
        throw new AssetActionError('Destination category not found.', { code: 'BATCH_PRECHECK_FAILED' });
      }
      if (!isCategoryEnabled(category)) {
        throw new AssetActionError('Destination category is disabled.', { code: 'BATCH_PRECHECK_FAILED' });
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
          throw new AssetActionError('Destination category directory does not exist.', { code: 'BATCH_PRECHECK_FAILED' });
        }
        throw new AssetActionError('Destination category directory is unsafe.', { code: 'PROJECT_DIRECTORY_UNSAFE' });
      }
      destCategoryId = category.id;
      destDirAbsPath = categoryAbsPath;
      destCategorySlug = category.directory_slug;
    } else {
      throw new AssetActionError(
        'Destination must be a valid enabled category ID or the Uncategorized sentinel.',
        { code: 'BATCH_PRECHECK_FAILED' }
      );
    }

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
  };
}
