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
import { ProjectNotFoundError } from './project-service.js';
import { AssetCategoryNotFoundError } from './asset-category-service.js';
import { isProjectArchived } from './project-state.js';
import { AssetCategoryError } from '../data/asset-category-repository.js';
import {
  AssetCategoryValidationError,
  validateCategoryInput,
  validateDisplayName,
  assertPlainObject,
  assertPositiveIntegerId,
  assertStrictBoolean,
} from './asset-category-validation.js';
import { createProjectDirectoryOwnershipVerifier } from './project-directory-ownership.js';
import {
  resolveCategoryDir,
  preflightCategoryDestination,
  createCategoryDirExclusive,
  requireRealCategoryDir,
  quarantineCategoryDir,
  restoreQuarantinedCategoryDir,
  removeEmptyDirIfIdentityMatches,
} from '../storage/project-storage.js';

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
 * @param {ReturnType<import('../data/project-directory-ownership-repository.js').createProjectDirectoryOwnershipRepository>} deps.projectDirectoryOwnershipRepository
 * @param {string} deps.projectsRoot
 * @param {Console} [deps.logger]
 */
export function createProjectAssetCategoryService({
  db,
  projectRepository,
  assetCategoryRepository,
  assetRepository,
  assetBrowserPreferenceRepository,
  projectDirectoryOwnershipRepository,
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
  if (!projectDirectoryOwnershipRepository) throw new Error('createProjectAssetCategoryService requires a projectDirectoryOwnershipRepository dependency.');

  const ownershipVerifier = createProjectDirectoryOwnershipVerifier({
    ownershipRepository: projectDirectoryOwnershipRepository,
    projectsRoot,
  });

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
    if (isProjectArchived(project)) {
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

  /**
   * Resolve the project root for a category FILESYSTEM operation. Requires
   * the persistent ownership witness (bound SQLite token + matching marker)
   * on top of the existing path protections, so a directory substituted at
   * the stored pathname is never modified as this project's. Database-only
   * category operations must not call this.
   *
   * @throws {import('./project-directory-ownership.js').ProjectOwnershipError}
   */
  function resolveOwnedProjectAbsPath(project) {
    return ownershipVerifier.verifyProject(project).absPath;
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
      // Every argument is validated before any repository or filesystem
      // dependency is touched — malformed input must never cause a lookup to
      // run first.
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

      // A disabled category is database-only: the project directory is
      // neither resolved nor inspected, so it may be unbound or unavailable.
      // Only an enabled category creates a directory and needs ownership.
      let absPath = null;
      if (enabled) {
        absPath = resolveOwnedProjectAbsPath(project);
        preflightCategoryDestination(absPath, directorySlug);
      }

      const existing = assetCategoryRepository.listProjectCategories(projectId);
      const displayOrder = existing.length === 0
        ? 0
        : Math.max(...existing.map((c) => c.display_order)) + 1;

      let createdDir = null;

      const runAdd = db.transaction(() => {
        const category = assetCategoryRepository.addProjectCategory({
          projectId, displayName, directorySlug, displayOrder, enabled,
        });

        if (enabled) {
          createdDir = createCategoryDirExclusive(absPath, directorySlug);
        }

        return category;
      });

      try {
        const category = runAdd();
        logActivity('asset_category.created', projectId, { categoryId: category.id, enabled: Boolean(category.enabled) });
        return category;
      } catch (err) {
        // SQLite has rolled the row back; remove only the directory this
        // operation itself created (e.g. after a commit-time failure).
        if (createdDir) {
          safeRemoveCreatedCategoryDir(absPath, directorySlug, createdDir.identity, projectId);
        }
        throw err;
      }
    },

    /**
     * Update only a category's display name. Database-only: no filesystem
     * access, no preview-cache invalidation.
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

      requireMutableProject(projectId);
      const category = requireCategory(projectId, categoryId);

      const updated = assetCategoryRepository.updateProjectCategoryDisplayName(projectId, categoryId, name);
      if (category.display_name !== name) logActivity('asset_category.renamed', projectId, { categoryId });
      return updated;
    },

    /**
     * Enable or disable a category. Disable is database-only (the directory
     * and its content are left untouched); enable validates/creates its
     * directory.
     */
    setEnabled(projectId, categoryId, enabled) {
      // Validate every argument before any repository/filesystem lookup.
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(categoryId, 'categoryId');
      assertStrictBoolean(enabled, 'enabled');

      const project = requireMutableProject(projectId);
      const category = requireCategory(projectId, categoryId);

      if (!enabled) {
        const updated = assetCategoryRepository.setProjectCategoryEnabled(projectId, categoryId, false);
        if (Boolean(category.enabled)) logActivity('asset_category.disabled', projectId, { categoryId, enabled: false });
        return updated;
      }

      // ── Enable ──
      // Whether enabling creates a directory is only known by inspecting the
      // project root, so enable always requires the ownership witness.
      const absPath = resolveOwnedProjectAbsPath(project);
      const slug = category.directory_slug;
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

      try {
        const updated = assetCategoryRepository.setProjectCategoryEnabled(projectId, categoryId, true);
        if (!Boolean(category.enabled)) logActivity('asset_category.enabled', projectId, { categoryId, enabled: true });
        return updated;
      } catch (err) {
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

      requireMutableProject(projectId);

      const categoriesBefore = assetCategoryRepository.listProjectCategories(projectId);
      assertCompleteReorderSet(orderedIds, categoriesBefore);

      try {
        const reordered = assetCategoryRepository.reorderProjectCategories(projectId, orderedIds);
        if (!categoriesBefore.every((category, index) => category.id === orderedIds[index])) {
          logActivity('asset_category.reordered', projectId, { categoryCount: reordered.length });
        }
        return reordered;
      } catch (err) {
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
     * deletion is gated on the post-quarantine check, so it never commits
     * ahead of proof that the directory is empty.
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

      // Deletion inspects, quarantines, removes, and on rollback recreates
      // the category directory: all of it requires the ownership witness.
      const absPath = resolveOwnedProjectAbsPath(project);

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
        });
        runDelete();
      } catch (err) {
        // SQLite has already rolled the row and its order back on its own
        // (including a commit-time failure such as a deferred constraint).
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
