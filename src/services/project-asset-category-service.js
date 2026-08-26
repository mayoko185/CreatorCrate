/**
 * Phase 2 chunk 2: project-specific category mutations and filesystem
 * compensation.
 *
 * Every dependency is injected explicitly — this service never constructs
 * its own repositories, opens its own database connection, or reaches for
 * hidden state. All mutation methods reject archived projects; `list` is
 * read-only and works for archived projects too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ProjectNotFoundError } from './project-service.js';
import { AssetCategoryNotFoundError } from './asset-category-service.js';
import { AssetCategoryError } from '../data/asset-category-repository.js';
import {
  AssetCategoryValidationError,
  validateCategoryInput,
  validateDisplayName,
  assertPlainObject,
  assertPositiveIntegerId,
  assertStrictBoolean,
} from './asset-category-validation.js';
import { resolveProjectDir } from '../storage/project-storage.js';
import {
  resolveCategoryDir,
  preflightCategoryDestination,
  createCategoryDirExclusive,
  requireRealCategoryDir,
  quarantineCategoryDir,
  restoreQuarantinedCategoryDir,
  removeEmptyDirIfIdentityMatches,
} from '../storage/project-storage.js';
import { writeManifestSync, readManifestSync, MANIFEST_FILENAME } from '../storage/manifest.js';

export { AssetCategoryValidationError, AssetCategoryNotFoundError, ProjectNotFoundError };

export class ProjectArchivedError extends Error {
  constructor(projectId) {
    super(`Project ${projectId} is archived and cannot be modified.`);
    this.name = 'ProjectArchivedError';
    this.status = 409;
  }
}

export class ProjectAssetCategoryError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ProjectAssetCategoryError';
    this.code = code;
  }
}

function logProblem(logger, projectId, reason) {
  logger.error(`[CreatorCrate] Project category operation for project ${projectId} — ${reason}.`);
}

/**
 * Whether a manifest currently exists at `absPath`, for capturing state
 * before a mutation begins. An unreadable/corrupt manifest still counts as
 * "something was there" — it is never treated as safely absent, since that
 * would risk deleting or overwriting content this operation didn't create.
 */
function manifestExists(absPath) {
  try {
    return readManifestSync(absPath) !== null;
  } catch {
    return true;
  }
}

const REORDER_VALIDATION_CODES = new Set([
  'INVALID_SEQUENCE_LENGTH',
  'DUPLICATE_ID',
  'UNKNOWN_ID',
  'INVALID_ID',
]);

function invalidReorder(message = 'Category order must contain every current project category exactly once.') {
  throw new AssetCategoryValidationError({ orderedCategoryIds: message });
}

function assertCompleteReorderSet(orderedIds, categories) {
  if (orderedIds.length !== categories.length) {
    invalidReorder();
  }

  const currentIds = new Set(categories.map((category) => category.id));
  if (orderedIds.some((id) => !currentIds.has(id))) {
    invalidReorder();
  }
}

function isReorderValidationError(err) {
  return err instanceof AssetCategoryError && REORDER_VALIDATION_CODES.has(err.code);
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {import('../data/project-repository.js').ProjectRepository} deps.projectRepository
 * @param {ReturnType<import('../data/asset-category-repository.js').createAssetCategoryRepository>} deps.assetCategoryRepository
 * @param {ReturnType<import('../data/asset-repository.js').createAssetRepository>} deps.assetRepository
 * @param {ReturnType<import('../data/asset-browser-preference-repository.js').createAssetBrowserPreferenceRepository>} deps.assetBrowserPreferenceRepository
 * @param {string} deps.projectsRoot
 * @param {Console} [deps.logger]
 */
export function createProjectAssetCategoryService({
  db,
  projectRepository,
  assetCategoryRepository,
  assetRepository,
  assetBrowserPreferenceRepository,
  projectsRoot,
  logger = console,
  applicationLogger = null,
} = {}) {
  if (!db) throw new Error('createProjectAssetCategoryService requires a db dependency.');
  if (!projectRepository) throw new Error('createProjectAssetCategoryService requires a projectRepository dependency.');
  if (!assetCategoryRepository) throw new Error('createProjectAssetCategoryService requires an assetCategoryRepository dependency.');
  if (!assetRepository) throw new Error('createProjectAssetCategoryService requires an assetRepository dependency.');
  if (!projectsRoot) throw new Error('createProjectAssetCategoryService requires a projectsRoot dependency.');
  if (!assetBrowserPreferenceRepository) throw new Error('createProjectAssetCategoryService requires an assetBrowserPreferenceRepository dependency.');

  function requireProject(projectId) {
    assertPositiveIntegerId(projectId, 'projectId');
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }

  function requireMutableProject(projectId) {
    const project = requireProject(projectId);
    if (project.archived_at || project.status === 'archived') {
      throw new ProjectArchivedError(projectId);
    }
    return project;
  }

  function requireCategory(projectId, categoryId) {
    assertPositiveIntegerId(categoryId, 'categoryId');
    const category = assetCategoryRepository.findProjectCategoryById(projectId, categoryId);
    if (!category) {
      throw new AssetCategoryNotFoundError(categoryId);
    }
    return category;
  }

  function logActivity(event, projectId, context = {}) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'assets',
        message: 'Asset category activity completed.',
        projectId,
        context,
      });
    } catch {
      // Activity logging must never alter a completed category mutation.
    }
  }

  function resolveProjectAbsPath(project) {
    if (!project.project_dir) {
      throw new ProjectAssetCategoryError('Project has no stored directory path.', { code: 'NO_PROJECT_DIR' });
    }
    return resolveProjectDir(projectsRoot, project.project_dir);
  }

  function assertNoLocalSlugConflict(projectId, directorySlug) {
    const existing = assetCategoryRepository.listProjectCategories(projectId);
    const slugKey = directorySlug.toLowerCase();
    const conflict = existing.some((c) => c.directory_slug.toLowerCase() === slugKey);
    if (conflict) {
      throw new ProjectAssetCategoryError(
        `Category directory slug "${directorySlug}" already exists in this project.`,
        { code: 'SLUG_CONFLICT' }
      );
    }
  }

  /**
   * Roll back a category directory this operation itself just created:
   * quarantine it, verify it is still the exact (empty) directory created
   * here, and remove it — or restore it if verification fails. Never
   * touches a pre-existing directory. Best-effort; never throws.
   */
  function safeRemoveCreatedCategoryDir(absPath, slug, identity, projectId) {
    try {
      const quarantinePath = quarantineCategoryDir(absPath, slug);
      if (!quarantinePath) return; // Already gone — nothing to do.
      const result = removeEmptyDirIfIdentityMatches(quarantinePath, identity);
      if (!result.removed) {
        restoreQuarantinedCategoryDir(quarantinePath, absPath, slug);
        logProblem(logger, projectId, `left category directory "${slug}" untouched (${result.reason})`);
      }
    } catch (err) {
      logProblem(logger, projectId, `failed to clean up category directory "${slug}": ${err.message}`);
    }
  }

  /**
   * Restore the manifest to its exact pre-mutation state after a mutation's
   * database transaction fails — including a commit-time failure that
   * happens *after* a new manifest was already published from the
   * (about-to-be-rolled-back) in-progress DB state.
   *
   * `priorManifestExisted` and `categoriesBefore` must be captured BEFORE
   * the mutation begins. `publishedIdentity` is the manifest file's
   * dev/ino captured immediately after this operation's own
   * `writeManifestSync` call succeeded, but only when no manifest existed
   * beforehand — it is the proof needed to remove a manifest this
   * operation itself created without ever touching one written by another
   * actor in the interim.
   *
   * - If a manifest existed before: re-publish it from the captured
   *   pre-mutation `project` record and `categoriesBefore` — deterministic
   *   serialization reproduces the exact prior content, since neither input
   *   changed between the original write and this restoration.
   * - If no manifest existed before: remove only the manifest this
   *   operation published, and only when its identity still matches what
   *   was captured right after that write. A mismatch (or the identity
   *   never having been captured) means either nothing was ever published,
   *   or something else now occupies the path — either way it is left
   *   untouched rather than risk deleting or overwriting unproven content.
   *
   * Never throws — every failure is logged path-free via `logProblem` so it
   * can never replace the primary mutation error the caller is about to
   * re-throw.
   */
  function restorePriorManifest({
    absPath, project, categoriesBefore, priorManifestExisted, publishedIdentity, projectId, mutationLabel,
  }) {
    if (priorManifestExisted) {
      try {
        writeManifestSync(absPath, project, projectsRoot, categoriesBefore);
      } catch (restoreErr) {
        logProblem(
          logger, projectId,
          `failed to restore the prior manifest after a failed ${mutationLabel} (${restoreErr.message})`
        );
      }
      return;
    }

    if (!publishedIdentity) return; // Nothing was ever published — nothing to undo.

    try {
      const manifestPath = path.join(absPath, MANIFEST_FILENAME);
      const stats = fs.lstatSync(manifestPath);
      if (stats.dev === publishedIdentity.dev && stats.ino === publishedIdentity.ino) {
        fs.rmSync(manifestPath);
      } else {
        logProblem(
          logger, projectId,
          `left a replacement manifest untouched after a failed ${mutationLabel} (identity mismatch)`
        );
      }
    } catch (cleanupErr) {
      logProblem(
        logger, projectId,
        `failed to remove the manifest published just before a failed ${mutationLabel} (${cleanupErr.message})`
      );
    }
  }

  /**
   * Capture the manifest file's identity immediately after this operation's
   * own `writeManifestSync` call succeeds, but only when no manifest
   * existed before the mutation began — this is the proof
   * {@link restorePriorManifest} needs to safely remove (and never
   * over-broadly delete) a manifest this operation itself just created.
   * Best-effort: a capture failure here just means compensation later logs
   * instead of removing, never throws.
   */
  function capturePublishedManifestIdentity(absPath) {
    try {
      const stats = fs.lstatSync(path.join(absPath, MANIFEST_FILENAME));
      return { dev: stats.dev, ino: stats.ino };
    } catch {
      return null;
    }
  }

  return {
    /**
     * List a project's categories (enabled and disabled), in deterministic
     * order. Read-only — works for archived projects too.
     */
    list(projectId) {
      requireProject(projectId);
      return assetCategoryRepository.listProjectCategories(projectId);
    },

    /**
     * Add a new project-owned category. Optionally creates its direct-child
     * directory (only when enabled).
     */
    add(projectId, input) {
      // Every argument is validated before any repository, filesystem, or
      // manifest dependency is touched — malformed input must never cause a
      // lookup to run first.
      assertPositiveIntegerId(projectId, 'projectId');
      assertPlainObject(input, 'input');
      const { displayName, directorySlug } = validateCategoryInput(input);

      let enabled = true;
      if (input.enabled !== undefined) {
        assertStrictBoolean(input.enabled, 'enabled');
        enabled = input.enabled;
      }

      const project = requireMutableProject(projectId);
      assertNoLocalSlugConflict(projectId, directorySlug);

      const absPath = resolveProjectAbsPath(project);
      if (enabled) {
        preflightCategoryDestination(absPath, directorySlug);
      }

      const existing = assetCategoryRepository.listProjectCategories(projectId);
      const displayOrder = existing.length === 0
        ? 0
        : Math.max(...existing.map((c) => c.display_order)) + 1;

      // Captured before any mutation, so a commit-time database failure —
      // which can happen even after the manifest below has already been
      // published from the (about-to-be-rolled-back) in-progress state —
      // can be compensated for by restoring exactly what was here before.
      const priorManifestExisted = manifestExists(absPath);
      const categoriesBefore = existing;
      let publishedManifestIdentity = null;

      let createdDir = null;

      const runAdd = db.transaction(() => {
        const category = assetCategoryRepository.addProjectCategory({
          projectId, displayName, directorySlug, displayOrder, enabled,
        });

        if (enabled) {
          createdDir = createCategoryDirExclusive(absPath, directorySlug);
        }

        const categories = assetCategoryRepository.listProjectCategories(projectId);
        writeManifestSync(absPath, project, projectsRoot, categories);
        if (!priorManifestExisted) {
          publishedManifestIdentity = capturePublishedManifestIdentity(absPath);
        }

        return category;
      });

      try {
        const category = runAdd();
        logActivity('asset_category.created', projectId, { categoryId: category.id, enabled: Boolean(category.enabled) });
        return category;
      } catch (err) {
        restorePriorManifest({
          absPath, project, categoriesBefore, priorManifestExisted,
          publishedIdentity: publishedManifestIdentity, projectId, mutationLabel: 'add',
        });
        if (createdDir) {
          safeRemoveCreatedCategoryDir(absPath, directorySlug, createdDir.identity, projectId);
        }
        throw err;
      }
    },

    /**
     * Update only a category's display name. No filesystem rename, no
     * preview-cache invalidation.
     */
    editDisplayName(projectId, categoryId, input) {
      // Validate every argument before any repository/filesystem lookup.
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(categoryId, 'categoryId');
      assertPlainObject(input, 'input');
      const { name, error } = validateDisplayName(input.displayName);
      if (error) {
        throw new AssetCategoryValidationError({ displayName: error });
      }

      const project = requireMutableProject(projectId);
      const category = requireCategory(projectId, categoryId);

      const absPath = resolveProjectAbsPath(project);
      const priorManifestExisted = manifestExists(absPath);
      const categoriesBefore = assetCategoryRepository.listProjectCategories(projectId);
      let publishedManifestIdentity = null;

      const runEdit = db.transaction(() => {
        const updated = assetCategoryRepository.updateProjectCategoryDisplayName(projectId, categoryId, name);
        const categories = assetCategoryRepository.listProjectCategories(projectId);
        writeManifestSync(absPath, project, projectsRoot, categories);
        if (!priorManifestExisted) {
          publishedManifestIdentity = capturePublishedManifestIdentity(absPath);
        }
        return updated;
      });

      try {
        const updated = runEdit();
        if (category.display_name !== name) logActivity('asset_category.renamed', projectId, { categoryId });
        return updated;
      } catch (err) {
        restorePriorManifest({
          absPath, project, categoriesBefore, priorManifestExisted,
          publishedIdentity: publishedManifestIdentity, projectId, mutationLabel: 'display-name edit',
        });
        throw err;
      }
    },

    /** Enable or disable a category. Enable validates/creates its directory. */
    setEnabled(projectId, categoryId, enabled) {
      // Validate every argument before any repository/filesystem lookup.
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(categoryId, 'categoryId');
      assertStrictBoolean(enabled, 'enabled');

      const project = requireMutableProject(projectId);
      const category = requireCategory(projectId, categoryId);

      const absPath = resolveProjectAbsPath(project);
      const slug = category.directory_slug;

      const priorManifestExisted = manifestExists(absPath);
      const categoriesBefore = assetCategoryRepository.listProjectCategories(projectId);
      let publishedManifestIdentity = null;

      if (!enabled) {
        const runDisable = db.transaction(() => {
          const updated = assetCategoryRepository.setProjectCategoryEnabled(projectId, categoryId, false);
          const categories = assetCategoryRepository.listProjectCategories(projectId);
          writeManifestSync(absPath, project, projectsRoot, categories);
          if (!priorManifestExisted) {
            publishedManifestIdentity = capturePublishedManifestIdentity(absPath);
          }
          return updated;
        });
        try {
          const updated = runDisable();
          if (Boolean(category.enabled)) logActivity('asset_category.disabled', projectId, { categoryId, enabled: false });
          return updated;
        } catch (err) {
          restorePriorManifest({
            absPath, project, categoriesBefore, priorManifestExisted,
            publishedIdentity: publishedManifestIdentity, projectId, mutationLabel: 'disable',
          });
          throw err;
        }
      }

      // ── Enable ──
      const categoryPath = resolveCategoryDir(absPath, slug);
      let existedAlready = false;
      try {
        fs.lstatSync(categoryPath);
        existedAlready = true;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new ProjectAssetCategoryError(
            `Cannot access category directory "${slug}".`, { code: 'DESTINATION_UNSAFE' }
          );
        }
      }

      let createdDir = null;
      if (existedAlready) {
        requireRealCategoryDir(categoryPath);
      } else {
        createdDir = createCategoryDirExclusive(absPath, slug);
      }

      const runEnable = db.transaction(() => {
        const updated = assetCategoryRepository.setProjectCategoryEnabled(projectId, categoryId, true);
        const categories = assetCategoryRepository.listProjectCategories(projectId);
        writeManifestSync(absPath, project, projectsRoot, categories);
        if (!priorManifestExisted) {
          publishedManifestIdentity = capturePublishedManifestIdentity(absPath);
        }
        return updated;
      });

      try {
        const updated = runEnable();
        if (!Boolean(category.enabled)) logActivity('asset_category.enabled', projectId, { categoryId, enabled: true });
        return updated;
      } catch (err) {
        restorePriorManifest({
          absPath, project, categoriesBefore, priorManifestExisted,
          publishedIdentity: publishedManifestIdentity, projectId, mutationLabel: 'enable',
        });
        if (createdDir) {
          safeRemoveCreatedCategoryDir(absPath, slug, createdDir.identity, projectId);
        }
        throw err;
      }
    },

    /**
     * Reorder a project's complete category set. No filesystem, asset, or
     * cache changes.
     */
    reorder(projectId, orderedIds) {
      // Validate every argument before any repository/filesystem lookup.
      // Full-set completeness is checked against the current rows before any
      // filesystem work and rechecked inside the repository transaction.
      assertPositiveIntegerId(projectId, 'projectId');
      if (!Array.isArray(orderedIds) || orderedIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new AssetCategoryValidationError({
          orderedCategoryIds: 'Reorder input must be an array of safe positive integer IDs.',
        });
      }
      if (new Set(orderedIds).size !== orderedIds.length) {
        throw new AssetCategoryValidationError({
          orderedCategoryIds: 'Reorder input must not contain duplicate IDs.',
        });
      }

      const project = requireMutableProject(projectId);

      const categoriesBefore = assetCategoryRepository.listProjectCategories(projectId);
      assertCompleteReorderSet(orderedIds, categoriesBefore);

      const absPath = resolveProjectAbsPath(project);
      const priorManifestExisted = manifestExists(absPath);
      let publishedManifestIdentity = null;

      const runReorder = db.transaction(() => {
        const reordered = assetCategoryRepository.reorderProjectCategories(projectId, orderedIds);
        writeManifestSync(absPath, project, projectsRoot, reordered);
        if (!priorManifestExisted) {
          publishedManifestIdentity = capturePublishedManifestIdentity(absPath);
        }
        return reordered;
      });

      try {
        const reordered = runReorder();
        if (!categoriesBefore.every((category, index) => category.id === orderedIds[index])) {
          logActivity('asset_category.reordered', projectId, { categoryCount: reordered.length });
        }
        return reordered;
      } catch (err) {
        restorePriorManifest({
          absPath, project, categoriesBefore, priorManifestExisted,
          publishedIdentity: publishedManifestIdentity, projectId, mutationLabel: 'reorder',
        });
        if (isReorderValidationError(err)) {
          throw new AssetCategoryValidationError({
            orderedCategoryIds: 'Category order must contain every current project category exactly once.',
          });
        }
        throw err;
      }
    },

    /**
     * Delete a category only when safe: no asset (present or missing)
     * references it, and its physical directory is absent or an empty,
     * contained, real (non-symlink) directory.
     *
     * Emptiness is proven on the *quarantined* directory — after it has
     * been atomically moved out of its original pathname — not on the
     * original pathname before quarantining. A pre-quarantine check alone
     * cannot prove anything: a file can appear between that check and the
     * quarantine rename, travel with the directory into quarantine, and
     * only be discovered once it's too late to matter. The database
     * deletion and manifest rewrite are gated on the post-quarantine check,
     * so they never commit ahead of proof that the directory is empty.
     */
    delete(projectId, categoryId) {
      // Validate every argument before any repository/filesystem lookup.
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(categoryId, 'categoryId');

      const project = requireMutableProject(projectId);
      const category = requireCategory(projectId, categoryId);
      const slug = category.directory_slug;

      const assetCount = assetRepository.countByCategoryId(projectId, categoryId);
      if (assetCount > 0) {
        throw new ProjectAssetCategoryError(
          `Category "${slug}" still has ${assetCount} referenced asset(s). Disable it instead.`,
          { code: 'HAS_ASSETS' }
        );
      }

      const absPath = resolveProjectAbsPath(project);

      // Captured before any mutation, so a commit-time database failure —
      // which can happen even after the manifest below has already been
      // published from the (about-to-be-rolled-back) in-progress state —
      // can be compensated for by restoring exactly what was here before.
      const priorManifestExisted = manifestExists(absPath);
      const categoriesBefore = assetCategoryRepository.listProjectCategories(projectId);
      let publishedManifestIdentity = null;

      let categoryPath;
      try {
        categoryPath = resolveCategoryDir(absPath, slug);
      } catch {
        throw new ProjectAssetCategoryError(
          `Cannot access category directory "${slug}".`, { code: 'PATH_UNSAFE' }
        );
      }

      let stats = null;
      try {
        stats = fs.lstatSync(categoryPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new ProjectAssetCategoryError(
            `Cannot access category directory "${slug}".`, { code: 'PATH_UNSAFE' }
          );
        }
      }

      // Filesystem mutations cannot participate in the SQLite transaction
      // below, so the directory's fate is settled entirely BEFORE the
      // database is ever touched: quarantine it, prove its identity and
      // emptiness, and remove it. Only once it is verifiably gone (or never
      // existed) does the category row get deleted. This means there is no
      // window in which a database commit could ever be followed by the
      // discovery of a non-empty directory — the emptiness proof always
      // happens first, and removal happens before the row goes away.
      let directoryRemovedBeforeCommit = false;

      if (stats) {
        if (stats.isSymbolicLink()) {
          throw new ProjectAssetCategoryError(
            `Category directory "${slug}" is a symbolic link. Disable it instead.`, { code: 'PATH_UNSAFE' }
          );
        }
        if (!stats.isDirectory()) {
          throw new ProjectAssetCategoryError(
            `Category path "${slug}" is a file. Disable it instead.`, { code: 'PATH_UNSAFE' }
          );
        }
        // Cheap upfront check to fail fast in the common case — never relied
        // on as proof; the authoritative check happens after quarantine.
        if (fs.readdirSync(categoryPath).length > 0) {
          throw new ProjectAssetCategoryError(
            `Category directory "${slug}" is not empty. Disable it instead.`, { code: 'NOT_EMPTY' }
          );
        }

        const identity = { dev: stats.dev, ino: stats.ino };
        const quarantinePath = quarantineCategoryDir(absPath, slug);
        if (quarantinePath) {
          let qStats = null;
          try {
            qStats = fs.lstatSync(quarantinePath);
          } catch {
            qStats = null;
          }
          const identityMatches = qStats && qStats.dev === identity.dev && qStats.ino === identity.ino;
          if (!identityMatches) {
            const { reason } = restoreQuarantinedCategoryDir(quarantinePath, absPath, slug);
            logProblem(
              logger, projectId,
              `category "${slug}" directory changed during deletion — left at quarantine (restore: ${reason})`
            );
            throw new ProjectAssetCategoryError(
              `Category directory "${slug}" changed during deletion. Try again.`, { code: 'CONCURRENT_MODIFICATION' }
            );
          }

          // Authoritative emptiness proof: taken on the quarantined
          // directory itself, after the atomic move out of `slug`, so a
          // file that appeared between the preflight check above and the
          // quarantine rename (and therefore travelled into quarantine
          // with it) is still caught here — before anything commits.
          let quarantineEntries;
          try {
            quarantineEntries = fs.readdirSync(quarantinePath);
          } catch {
            quarantineEntries = null;
          }
          if (!quarantineEntries || quarantineEntries.length > 0) {
            const { reason } = restoreQuarantinedCategoryDir(quarantinePath, absPath, slug);
            logProblem(
              logger, projectId,
              `category "${slug}" directory received content during deletion — left at quarantine (restore: ${reason})`
            );
            throw new ProjectAssetCategoryError(
              `Category directory "${slug}" is not empty. Disable it instead.`, { code: 'NOT_EMPTY' }
            );
          }

          // Proven empty and identity-matching: remove it now, before the
          // category row is deleted. 'missing' means it is already gone by
          // some other means — equally fine, nothing left to remove.
          const removal = removeEmptyDirIfIdentityMatches(quarantinePath, identity);
          if (!removal.removed && removal.reason !== 'missing') {
            const { reason } = restoreQuarantinedCategoryDir(quarantinePath, absPath, slug);
            logProblem(
              logger, projectId,
              `category "${slug}" directory could not be safely removed (${removal.reason}) — left at quarantine (restore: ${reason})`
            );
            throw new ProjectAssetCategoryError(
              `Category directory "${slug}" is not empty. Disable it instead.`, { code: 'NOT_EMPTY' }
            );
          }

          directoryRemovedBeforeCommit = true;
        }
      }

      try {
        const runDelete = db.transaction(() => {
          // All non-transactional deletion preconditions and filesystem
          // cleanup have completed above. Reset the selected preference only
          // inside the same transaction as category deletion.
          assetBrowserPreferenceRepository.resetProjectPreferenceIfCategory(projectId, categoryId);
          assetCategoryRepository.deleteProjectCategoryAndCompact(projectId, categoryId);
          const categories = assetCategoryRepository.listProjectCategories(projectId);
          writeManifestSync(absPath, project, projectsRoot, categories);
          if (!priorManifestExisted) {
            publishedManifestIdentity = capturePublishedManifestIdentity(absPath);
          }
        });
        runDelete();
      } catch (err) {
        // A commit-time failure (e.g. a deferred constraint evaluated only
        // at commit) can happen after the manifest above was already
        // published from state that never actually committed. Restore the
        // exact prior manifest first — SQLite has already rolled the row
        // and its order back on its own.
        restorePriorManifest({
          absPath, project, categoriesBefore, priorManifestExisted,
          publishedIdentity: publishedManifestIdentity, projectId, mutationLabel: 'delete',
        });
        if (directoryRemovedBeforeCommit) {
          // The transaction rolled back — the category row still exists —
          // but its physical directory was already removed moments ago
          // (before the database was ever touched, per the sequence
          // above). Recreate it, empty, so the surviving row keeps its
          // expected directory. This never overwrites a foreign artifact
          // that may have appeared at the slug in the interim; if
          // recreation isn't possible, that is reported as a compensation
          // failure and the original error is still what the caller sees.
          try {
            createCategoryDirExclusive(absPath, slug);
          } catch (compensationErr) {
            logProblem(
              logger, projectId,
              `could not recreate category directory "${slug}" after a failed deletion (${compensationErr.message})`
            );
          }
        }
        throw err;
      }

      logActivity('asset_category.deleted', projectId, { categoryId });
      return true;
    },
  };
}
