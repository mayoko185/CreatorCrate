import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import slugify from '@sindresorhus/slugify';
import {
  createProjectRepository,
  ARCHIVED_PROJECT_STATUS,
} from '../data/project-repository.js';
import { createTagRepository } from '../data/tag-repository.js';
import { createAppMetaRepository } from '../data/app-meta-repository.js';
import { createReleaseRepository } from '../data/release-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../data/project-directory-ownership-repository.js';
import { createPageDefaultsService } from './page-defaults-service.js';
import {
  formatProjectDirName,
  resolveProjectDir,
  ensureNoConflict,
  createProjectCategoryDirs,
  renameProjectDirSync,
} from '../storage/project-storage.js';
import {
  PROJECT_OWNERSHIP_MARKER_FILENAME,
  createProjectOwnershipMarker,
  generateProjectOwnershipToken,
} from '../storage/project-ownership-marker.js';
import {
  ProjectOwnershipError,
  assertProjectOwnershipMarker,
  assertSameDirectory,
  createProjectDirectoryOwnershipVerifier,
} from './project-directory-ownership.js';
import { isValidWebUrl } from '../util/url.js';
import { isProjectArchived } from './project-state.js';

export class ProjectValidationError extends Error {
  constructor(errors) {
    super('Project validation failed');
    this.name = 'ProjectValidationError';
    this.errors = errors;
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id) {
    super(`Project ${id} not found`);
    this.name = 'ProjectNotFoundError';
    this.status = 404;
  }
}

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const NOTES_MAX = 10000;
const TAGS_UNCHANGED = Symbol('tags-unchanged');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectsRoot
 * @param {object} deps
 * @param {object} deps.assetCategoryService - Injected asset-category
 *   service (see services/asset-category-service.js). Required — this
 *   service never constructs its own category repository or service.
 * @param {object} deps.assetBrowserPreferenceRepository - Injected
 *   transaction-compatible preference repository. Required — project
 *   creation owns preference-row initialization in its database transaction.
 * @param {object} deps.projectOptionCatalogueService - App-scoped live
 *   Project option catalogue. Required for create/update membership checks.
 * @param {object} [deps.pageDefaultsService] - App-scoped Page Defaults service.
 *   Direct callers fall back to the same service over `db`.
 * @param {object} [deps.projectRepository] - Shared repository for the current
 *   application graph. Defaults to a repository over `db` for direct callers.
 * @param {object} [deps.tagRepository] - Shared tag repository for atomic
 *   requested-tag validation and assignment during project creation/update.
 * @param {object} [deps.projectDirectoryOwnershipRepository] - Shared
 *   project-directory ownership repository (PM-1A). Defaults to a repository
 *   over `db` for direct callers.
 */
export function createProjectService(
  db,
  projectsRoot,
  {
    assetCategoryService,
    assetBrowserPreferenceRepository,
    applicationLogger = null,
    pageDefaultsService,
    projectOptionCatalogueService,
    projectRepository,
    tagRepository,
    projectDirectoryOwnershipRepository,
    onReleaseNotificationStateChanged = null,
  } = {}
) {
  if (!assetCategoryService) {
    throw new Error('createProjectService requires an assetCategoryService dependency.');
  }
  if (!assetBrowserPreferenceRepository) {
    throw new Error('createProjectService requires an assetBrowserPreferenceRepository dependency.');
  }
  if (!projectOptionCatalogueService
    || typeof projectOptionCatalogueService.getStatusCatalogue !== 'function'
    || typeof projectOptionCatalogueService.getProjectTypeCatalogue !== 'function') {
    throw new Error('createProjectService requires a projectOptionCatalogueService dependency.');
  }

  const repository = projectRepository ?? createProjectRepository(db);
  const tags = tagRepository ?? createTagRepository(db);
  const releaseRepository = createReleaseRepository(db);
  const ownershipRepository = projectDirectoryOwnershipRepository
    ?? createProjectDirectoryOwnershipRepository(db);
  const ownershipVerifier = createProjectDirectoryOwnershipVerifier({ ownershipRepository, projectsRoot });
  const creationDefaultsService = pageDefaultsService ?? createPageDefaultsService({
    appMetaRepository: createAppMetaRepository(db),
    projectOptionCatalogueService,
  });
  if (typeof creationDefaultsService.getSavedDefault !== 'function') {
    throw new Error('createProjectService received an invalid pageDefaultsService dependency.');
  }

  function logActivity(event, project, context = {}) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'projects',
        message: 'Project activity completed.',
        projectId: project.id,
        context,
      });
    } catch {
      // Activity logging must never alter the completed project operation.
    }
  }

  /**
   * Record a project-update diagnostic. The caller's own update transaction
   * has always ended (rolled back) by the time this runs; when an outer,
   * caller-owned transaction is still open (e.g. release publication), the
   * write is deferred until it has finished so the diagnostic cannot be
   * rolled back with it. A logging failure never reaches the caller.
   */
  function logUpdateDiagnostic(level, event, message, projectId, context, error) {
    const write = () => {
      try {
        applicationLogger?.[level]?.({
          event,
          kind: 'diagnostic',
          subsystem: 'projects',
          message,
          projectId,
          context,
          error,
        });
      } catch {
        // Diagnostic persistence must not alter the update result or rollback.
      }
    };
    try {
      if (db?.inTransaction) setImmediate(write);
      else write();
    } catch {
      // Diagnostic persistence must not alter the update result or rollback.
    }
  }

  /**
   * Safe, path-free error classification. The logger keeps only the top-level
   * error's name/message/code, so the original filesystem errno carried as
   * `cause` (M1A StorageError contract) is copied out explicitly here.
   */
  function updateErrorContext(err) {
    const cause = err?.cause;
    return {
      errorName: typeof err?.name === 'string' ? err.name : 'Error',
      errorCode: typeof err?.code === 'string' ? err.code : null,
      errno: typeof cause?.code === 'string' ? cause.code : null,
      syscall: typeof cause?.syscall === 'string' ? cause.syscall : null,
    };
  }

  function validate(input, options = {}) {
    const { existingId, existingProjectType } = options;
    const errors = {};

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length < TITLE_MIN) {
      errors.title = 'Title is required.';
    } else if (title.length > TITLE_MAX) {
      errors.title = `Title must be ${TITLE_MAX} characters or fewer.`;
    }

    const description = typeof input.description === 'string' ? input.description : '';
    if (description.length > DESCRIPTION_MAX) {
      errors.description = `Description must be ${DESCRIPTION_MAX} characters or fewer.`;
    }

    const notes = typeof input.notes === 'string' ? input.notes : '';
    if (notes.length > NOTES_MAX) {
      errors.notes = `Notes must be ${NOTES_MAX} characters or fewer.`;
    }

    const status = input.status;
    const statusValues = projectOptionCatalogueService.getStatusCatalogue()
      .map(({ value }) => value)
      .filter((value) => value !== ARCHIVED_PROJECT_STATUS);
    if (!statusValues.includes(status)) {
      errors.status = `Status must be one of: ${statusValues.join(', ')}.`;
    }

    // Empty project type on update retains the project's stored type.
    // Create inputs have already resolved omitted values from Page Defaults.
    const projectType = input.projectType === undefined || input.projectType === null || input.projectType === ''
      ? existingProjectType
      : input.projectType;
    const projectTypeValues = projectOptionCatalogueService.getProjectTypeCatalogue()
      .map(({ value }) => value);
    if (!projectTypeValues.includes(projectType)) {
      errors.projectType = `Project type must be one of: ${projectTypeValues.join(', ')}.`;
    }

    const patreonUrl = input.patreonUrl || null;
    if (!isValidWebUrl(patreonUrl)) {
      errors.patreonUrl = 'Project link must be a valid absolute HTTP or HTTPS URL.';
    }

    if (Object.keys(errors).length > 0) {
      throw new ProjectValidationError(errors);
    }

    const slug = makeSlug(title);
    if (repository.slugExists(slug, { excludeId: existingId })) {
      throw new ProjectValidationError({ title: 'A project with this title already exists.' });
    }

    return {
      title,
      slug,
      description,
      notes,
      status,
      projectType,
      patreonUrl,
    };
  }

  function resolveRequiredCreateDefault(option, fieldLabel) {
    const value = creationDefaultsService.getSavedDefault('new_project', option);
    if (value === undefined) {
      throw new ProjectValidationError({
        [option]: `The configured New Project ${fieldLabel} default is missing or unavailable. Choose a valid default in Settings.`,
      });
    }
    return value;
  }

  function resolveCreateInput(input) {
    return {
      ...input,
      status: input.status === undefined || input.status === null || input.status === ''
        ? resolveRequiredCreateDefault('status', 'Status')
        : input.status,
      projectType: input.projectType === undefined || input.projectType === null || input.projectType === ''
        ? resolveRequiredCreateDefault('projectType', 'Type')
        : input.projectType,
    };
  }

  /**
   * Compensate a failed rename by moving the project directory back to its
   * original location. Database state is restored by the update transaction
   * rollback.
   *
   * Safety: all paths are derived from project.project_dir (which passed
   * resolveProjectDir at creation time) and the project ID.
   *
   * Only the directory this operation moved (operation-local dev/ino) is
   * moved back, and never onto an occupied original path. The ownership
   * marker travels with it untouched.
   *
   * @param {object} project - Original project record (pre-update)
   * @param {string} currentAbsPath - Original absolute directory path
   * @param {string} newAbsPath - New absolute path (may or may not exist)
   * @param {{dev: number, ino: number}} identity - Identity of the moved directory
   * @param {string} newRelPath - Project-relative destination (diagnostics only)
   * @returns {'restored'|'destination_missing'|'failed'} Outcome, for diagnostics only
   */
  function compensateUpdate(project, currentAbsPath, newAbsPath, identity, newRelPath) {
    let step = 'inspect_destination';
    try {
      let moved;
      try {
        moved = fs.lstatSync(newAbsPath);
      } catch (err) {
        if (err.code === 'ENOENT') return 'destination_missing';
        throw err;
      }
      if (
        !moved.isDirectory()
        || moved.isSymbolicLink()
        || moved.dev !== identity.dev
        || moved.ino !== identity.ino
      ) {
        throw new Error('destination no longer holds the moved directory');
      }
      step = 'inspect_original';
      let originalOccupied = true;
      try {
        fs.lstatSync(currentAbsPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        originalOccupied = false;
      }
      if (originalOccupied) {
        throw new Error('original location is occupied');
      }
      step = 'move_back';
      renameProjectDirSync(newAbsPath, currentAbsPath);
      return 'restored';
    } catch (moveBackErr) {
      console.error(
        `[CreatorCrate] Update rollback — failed to move directory ` +
        `"${path.basename(newAbsPath)}" back for project ${project.id}: ${moveBackErr.message}`
      );
      logUpdateDiagnostic('error', 'project.update.rollback_failed',
        'Project directory rename could not be compensated.', project.id, {
          projectDir: project.project_dir,
          targetProjectDir: newRelPath,
          step,
          ...updateErrorContext(moveBackErr),
        }, moveBackErr);
      return 'failed';
    }
  }

  return {
    repository,

    create(input, { tagIds = [] } = {}) {
      const normalized = validate(resolveCreateInput(input));
      if (!Array.isArray(tagIds) || tagIds.some((tagId) => (
        typeof tagId !== 'number' || !Number.isSafeInteger(tagId) || tagId <= 0
      ))) {
        throw new ProjectValidationError({
          tagIds: 'Tag selections must contain safe positive integer IDs.',
        });
      }
      const uniqueTagIds = [...new Set(tagIds)];

      let project;
      let relPath;
      let dirCreated = false;
      // Cleanup ownership record — set ONLY after the exact exclusive root
      // creation below succeeds. Never inferred from the DB row, a slug, or
      // a preflight check; it is the sole authority for what compensation
      // is allowed to recursively remove.
      let ownership = null;
      // Set when marker creation exposed `.creatorcrate-owner` and then
      // failed: from then on no filesystem compensation runs.
      let markerAmbiguous = false;

      const runCreate = db.transaction(() => {
        // Phase 1: Insert the project row to obtain a numeric ID.
        try {
          project = repository.create(normalized);
        } catch (err) {
          if (isSlugUniqueConstraintError(err)) {
            throw new ProjectValidationError({
              title: 'A project with this title already exists.',
            });
          }
          throw err;
        }

        // Requested tags must still exist at the authoritative creation
        // boundary. This is intentionally inside the same transaction as the
        // project row, relationships, and filesystem compensation.
        for (const tagId of uniqueTagIds) {
          if (!tags.findById(tagId)) {
            throw new ProjectValidationError({
              tagIds: 'One or more selected tags no longer exists. Refresh and try again.',
            });
          }
        }
        for (const tagId of uniqueTagIds) {
          tags.assignToProject(project.id, tagId);
        }

        // Phase 2: Copy enabled global defaults into independent,
        // project-owned category rows, in deterministic contiguous order.
        const categories = assetCategoryService.copyDefaultsForProject(project.id);

        // Phase 3: Initialize the explicit project preference in this same
        // transaction. The repository deliberately does not open a nested
        // transaction, so a failure rolls back the project and copied rows.
        assetBrowserPreferenceRepository.ensureProjectPreference(project.id);

        // Phase 4: Persist a fresh ownership token as this project's pending
        // binding. Like every write above it, the row is only durable if the
        // whole creation transaction commits — and it only commits once the
        // row is bound below — so no pending binding survives a failed or
        // interrupted creation.
        const ownershipToken = generateProjectOwnershipToken();
        if (!ownershipRepository.createPending(project.id, ownershipToken)) {
          throw new Error('Project ownership binding already exists.');
        }

        // Phase 5: Compute the canonical (unchanged) project-directory name.
        // Status does not participate: the project directory is always a
        // direct child of PROJECTS_ROOT.
        const dirName = formatProjectDirName(project.id, project.slug);
        relPath = dirName;
        const absPath = resolveProjectDir(projectsRoot, relPath);

        // Phase 6: Destination safety check.
        ensureNoConflict(absPath);

        // Phase 7: Exclusively create the final project root. An existing
        // directory is never adopted, whatever it contains.
        createProjectRootExclusive(absPath, dirName);
        dirCreated = true;
        ownership = beginOwnership(project.id, relPath, dirName, absPath);

        // Phase 8: Category-driven child directories (enabled categories only).
        createProjectCategoryDirs(absPath, categories);
        for (const category of categories) {
          if (!isCategoryEnabled(category)) continue;
          trackOwnedChild(ownership, absPath, category.directory_slug ?? category.directorySlug, true);
        }

        // Phase 9: Exclusively create the ownership marker. The primitive
        // reads the written marker back and confirms its token before
        // reporting `created`. An entry already present is never
        // overwritten, verified into success, or cleaned up by this
        // operation: this directory was just created, so any pre-existing
        // marker is foreign and creation fails. RECOVERY_REQUIRED means the
        // marker pathname was exposed but could not be confirmed; its entry
        // may be foreign, so the directory is left in place (see below).
        let marker;
        try {
          marker = createProjectOwnershipMarker(absPath, ownershipToken);
        } catch (err) {
          if (err?.code === 'RECOVERY_REQUIRED') markerAmbiguous = true;
          throw err;
        }
        if (marker.status !== 'created') {
          throw new Error('Project ownership marker already exists.');
        }
        trackOwnedChild(ownership, absPath, PROJECT_OWNERSHIP_MARKER_FILENAME, false);

        // Phase 10: Bind exactly this project's pending token.
        if (!ownershipRepository.markBound(project.id, ownershipToken)) {
          throw new Error('Project ownership binding could not be completed.');
        }

        // Phase 11: Persist the relative project path. SQLite is the sole
        // authority for project/category metadata; no project.json is written.
        project = repository.setProjectDir(project.id, relPath);

        return project;
      });

      try {
        const created = runCreate();
        logActivity('project.created', created, {
          status: created.status,
          projectType: created.project_type,
        });
        return created;
      } catch (err) {
        // ── Compensation ──────────────────────────────────────────
        // By the time we reach here, SQLite has already rolled back the
        // project row, any project-category rows, and the ownership binding
        // inserted above. Only tracked, operation-created artifacts
        // (category directories, the marker this call created, and the root)
        // are removed, each after an identity check.
        //
        // After an ambiguous marker exposure nothing is moved or removed:
        // the public marker may already be a foreign replacement, and even
        // quarantining the root would carry it along. SQLite has rolled
        // back; the directory stays for manual inspection.
        if (dirCreated && ownership && !markerAmbiguous) {
          safeRemoveCreatedDir(ownership, projectsRoot);
        }

        // Log original failure (project ID + relative path, no absolute paths)
        console.error(
          `[CreatorCrate] Project creation failed` +
          (project ? ` for project ${project.id}` : '') +
          (relPath ? ` (${relPath})` : '') +
          `: ${err.message}`
        );

        // Let validation errors propagate normally
        if (err instanceof ProjectValidationError) throw err;

        if (markerAmbiguous) {
          throw Object.assign(
            new Error('Project creation failed. Its folder was left in place and needs ownership recovery.', { cause: err }),
            { code: 'RECOVERY_REQUIRED' },
          );
        }

        // Generic user-visible error — no absolute paths leaked
        throw new Error('Project creation failed. Please try again.');
      }
    },

    update(id, input, { tagIds = TAGS_UNCHANGED } = {}) {
      // Diagnostics only: the step that was running when a failure surfaced.
      let phase = null;

      // Preflight lookup/validation: record unexpected operational failures
      // (e.g. SQLite I/O errors) as project.update.failed; validation and
      // not-found outcomes stay unlogged. The original error propagates.
      const preflight = (step, run) => {
        phase = step;
        try {
          return run();
        } catch (err) {
          if (!(err instanceof ProjectValidationError || err instanceof ProjectNotFoundError)) {
            logUpdateDiagnostic('error', 'project.update.failed', 'Project update failed.', id, {
              phase,
              slugChanged: null,
              projectDir: null,
              targetProjectDir: null,
              ...updateErrorContext(err),
              compensation: { attempted: false },
            }, err);
          }
          throw err;
        }
      };

      const project = preflight('preflight.lookup', () => repository.findById(id));
      if (!project) {
        throw new ProjectNotFoundError(id);
      }

      if (isProjectArchived(project)) {
        throw new ProjectValidationError({ general: 'Archived projects cannot be edited.' });
      }

      // Phase 1: Validate input
      const normalized = preflight('preflight.validate', () => validate(input, {
        existingId: id,
        existingProjectType: project.project_type,
      }));
      if (tagIds !== TAGS_UNCHANGED && (
        !Array.isArray(tagIds) || tagIds.some((tagId) => (
          typeof tagId !== 'number' || !Number.isSafeInteger(tagId) || tagId <= 0
        ))
      )) {
        throw new ProjectValidationError({
          tagIds: 'Tag selections must contain safe positive integer IDs.',
        });
      }
      const uniqueTagIds = tagIds === TAGS_UNCHANGED ? TAGS_UNCHANGED : [...new Set(tagIds)];

      // Phase 2: Compute changes and pre-flight validation.
      //
      // Only a title/slug change may rename the flat project directory.
      // Every other change (description, notes, link, status, type, tags) is
      // a database-only transition: SQLite owns project metadata, so it must
      // not inspect or write anything on the filesystem and must not require
      // a stored directory. Legacy project.json files are never read,
      // required, or rewritten.
      const slugChanged = normalized.slug !== project.slug;
      const dirNeedsChange = slugChanged;

      // Fields are compared via their DB→input (snake_case→camelCase) mapping.
      const persistedChanged = [
        ['title', 'title'],
        ['slug', 'slug'],
        ['description', 'description'],
        ['notes', 'notes'],
        ['patreon_url', 'patreonUrl'],
        ['status', 'status'],
        ['project_type', 'projectType'],
      ].some(([dbField, inputField]) => normalized[inputField] !== project[dbField]);

      let currentAbsPath = null;
      let newRelPath = null;
      let newAbsPath = null;
      let source = null;

      // Record one project.update.failed diagnostic. Validation and not-found
      // outcomes are ordinary results, not operational failures; ownership
      // refusals are expected state conflicts and are warnings.
      const logUpdateFailure = (err, compensation = null) => {
        if ((err instanceof ProjectValidationError || err instanceof ProjectNotFoundError) && !compensation) {
          return;
        }
        const level = err instanceof ProjectOwnershipError && !compensation ? 'warn' : 'error';
        logUpdateDiagnostic(level, 'project.update.failed', 'Project update failed.', project.id, {
          phase,
          slugChanged,
          projectDir: project.project_dir ?? null,
          targetProjectDir: newRelPath,
          ...updateErrorContext(err),
          compensation: compensation ?? { attempted: false },
        }, err);
      };

      if (dirNeedsChange) {
        try {
          phase = 'preflight.verify_source';
          // Ownership is proven by the persistent witness, never by pathname,
          // ID prefix, or any legacy project.json: the source path comes only
          // from the stored project_dir (never from the caller), must pass the
          // existing containment/direct-child/ID-prefix/symlink checks, and
          // must hold a `.creatorcrate-owner` marker whose token matches this
          // project's bound SQLite binding. An unbound (legacy) project fails
          // closed here; nothing is bound or written.
          source = ownershipVerifier.verifyProject(project);
          currentAbsPath = source.absPath;

          // Compute new path and verify no destination conflict
          const dirName = formatProjectDirName(project.id, normalized.slug);
          newRelPath = dirName;
          phase = 'preflight.destination_check';
          newAbsPath = resolveProjectDir(projectsRoot, newRelPath);
          ensureNoConflict(newAbsPath);
        } catch (err) {
          // Observe only: the original error propagates unchanged.
          logUpdateFailure(err);
          throw err;
        }
      }

      // ── Execution ─────────────────────────────────────────────────
      let updated;
      let dirMoved = false;

      try {
        const runUpdate = db.transaction(() => {
          // Phase 3: Update database metadata.
          phase = 'database.update';
          updated = repository.update(id, normalized);
          if (!updated) {
            throw new ProjectNotFoundError(id);
          }

          // Requested tags are revalidated authoritatively after the Project
          // update begins but before any filesystem mutation. The surrounding
          // transaction rolls the Project row back if any tag is now stale.
          if (uniqueTagIds !== TAGS_UNCHANGED) {
            for (const tagId of uniqueTagIds) {
              if (!tags.findById(tagId)) {
                throw new ProjectValidationError({
                  tagIds: 'One or more selected tags no longer exists. Refresh and try again.',
                });
              }
            }
            tags.replaceForProject(id, uniqueTagIds);
          }

          // Phase 4: Rename the flat project directory if the slug changed,
          // then update the stored path. No other update touches the
          // filesystem. A legacy project.json, if present, simply moves with
          // its containing directory and is otherwise left untouched.
          if (dirNeedsChange) {
            // Mutation boundary: re-prove, immediately before the rename,
            // that the stored path still holds the same directory verified
            // above and that it still carries this project's token.
            phase = 'directory.verify_source';
            assertSameDirectory(currentAbsPath, source.identity);
            assertProjectOwnershipMarker(currentAbsPath, source.token);

            phase = 'directory.rename';
            renameProjectDirSync(currentAbsPath, newAbsPath);
            dirMoved = true;

            // The marker lives inside the directory and moves with it.
            // Confirm the destination is the directory this operation moved
            // and still carries the expected token before the new stored
            // path can commit; otherwise the move is compensated below.
            phase = 'directory.verify_destination';
            assertSameDirectory(newAbsPath, source.identity);
            assertProjectOwnershipMarker(newAbsPath, source.token);

            phase = 'database.persist_binding';
            updated = repository.setProjectDir(id, newRelPath);
          }

          phase = 'database.commit';
          return updated;
        });

        const committed = runUpdate();

        if (persistedChanged) {
          logActivity('project.updated', committed, {
            previousStatus: project.status,
            status: committed.status,
            previousProjectType: project.project_type,
            projectType: committed.project_type,
          });
        }
        return committed;
      } catch (err) {
        // ── Compensation ─────────────────────────────────────────
        let compensation = null;
        if (dirMoved) {
          const outcome = compensateUpdate(project, currentAbsPath, newAbsPath, source.identity, newRelPath);
          compensation = { attempted: true, outcome };
        }
        logUpdateFailure(err, compensation);

        // Log the primary failure (project ID + relative path, no absolute paths)
        console.error(
          `[CreatorCrate] Project update failed for project ${id} ` +
          `(${project.project_dir}): ${err.message}`
        );

        if (err instanceof ProjectValidationError) throw err;
        if (err instanceof ProjectNotFoundError) throw err;
        if (err instanceof ProjectOwnershipError) throw err;
        throw new Error('Project update failed. Please try again.');
      }
    },

    archive(id) {
      const project = repository.findById(id);
      if (!project) {
        throw new ProjectNotFoundError(id);
      }

      if (isProjectArchived(project)) {
        throw new Error('Project is already archived.');
      }

      // ── Execution ───────────────────────────────────────────────────
      // Archiving is a database transition only. The existing project_dir
      // is preserved and the filesystem directory is never inspected,
      // moved, or renamed — it can be missing and archive still succeeds.

      try {
        const archived = repository.archive(id);
        if (!archived) {
          throw new Error('Failed to archive project in database.');
        }
        logActivity('project.archived', archived, {
          status: archived.status,
          projectType: archived.project_type,
        });
        // Queued notifications for this project's releases are now stale; the
        // notification core revalidates before sending regardless.
        try { onReleaseNotificationStateChanged?.(null); } catch { /* best-effort */ }
        return archived;
      } catch (err) {
        // Log the primary failure (safe relative path, no absolute paths)
        console.error(
          `[CreatorCrate] Archive failed for project ${id} ` +
          `(${project.project_dir}): ${err.message}`
        );

        throw new Error('Project archive failed. Please try again.');
      }
    },

    /**
     * Permanently delete a project, its releases, and all project-owned data.
     * Filesystem cleanup is staged through an identity-checked quarantine. The
     * database changes commit atomically before the staged tree is removed;
     * cleanup failure is reported as recovery-required.
     *
     * @param {number} id
     * @returns {boolean} true when the project was deleted
     */
    deleteProject(id) {
      const project = repository.findById(id);
      if (!project) {
        throw new ProjectNotFoundError(id);
      }

      let staged = null;
      let databaseDeleted = false;
      try {
        staged = quarantineProjectDirForDeletion(project, { ownershipVerifier, ownershipRepository });

        const deleteInTransaction = db.transaction(() => {
          // releases.project_id intentionally remains ON DELETE RESTRICT.
          // Reuse the release repository's hard-delete primitive so its
          // release_assets cascade semantics stay centralized.
          const releases = releaseRepository.findByProjectId(id, { includeArchived: true });
          for (const release of releases) {
            if (!releaseRepository.delete(release.id)) {
              throw new Error(`Release ${release.id} could not be deleted.`);
            }
          }

          const deleted = repository.deleteById(id);
          if (!deleted) {
            throw new ProjectNotFoundError(id);
          }

          return deleted;
        });

        const deleted = deleteInTransaction();
        databaseDeleted = true;
        if (staged) {
          try {
            removeQuarantinedProjectDir(staged);
          } catch (cleanupErr) {
            logDeletionCleanupProblem(id, cleanupErr.message);
            throw new Error('Project was deleted, but filesystem cleanup requires recovery.');
          }
          staged = null;
        }
        logActivity('project.deleted', project);
        return deleted;
      } catch (err) {
        if (databaseDeleted) {
          throw err;
        }

        if (staged && !restoreQuarantinedProjectDir(staged)) {
          logDeletionCleanupProblem(id, 'project directory could not be restored after deletion failure');
          throw new Error('Project deletion failed and filesystem recovery is required.');
        }

        if (err instanceof ProjectNotFoundError) {
          throw err;
        }

        console.error(
          `[CreatorCrate] Project deletion failed for project ${id}: ${err.message}`
        );
        if (err instanceof ProjectOwnershipError) throw err;
        throw new Error('Project deletion failed. Please try again.');
      }
    },

    findById(id) {
      return repository.findById(id);
    },

    findBySlug(slug) {
      return repository.findBySlug(slug);
    },

    list(options = {}) {
      return repository.list(options);
    },

    /**
     * Enumerate current projects using the repository's canonical active
     * asset-browser predicate. Filesystem/path validation remains the
     * scanner's responsibility, so this does not introduce a second
     * archived-or-missing-directory rule.
     *
     * @returns {Array<{ id: number, title: string }>}
     */
    listScanEligibleProjects() {
      return repository.listActiveAssetFilterOptions();
    },

    listCalendarFilterOptions() {
      return repository.listCalendarFilterOptions();
    },

    countByStatus() {
      return repository.countByStatus();
    },
  };
}

function makeSlug(title) {
  return slugify(title, { lowercase: true });
}

function isSlugUniqueConstraintError(err) {
  return (
    err != null &&
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof err.message === 'string' &&
    err.message.includes('projects.slug')
  );
}

/**
 * @param {object} category - Category row (snake_case or storage-safe shape)
 * @returns {boolean}
 */
function isCategoryEnabled(category) {
  return category.enabled === true || category.enabled === 1;
}

/**
 * Exclusively create a project root directory. No `recursive: true` — a
 * foreign directory appearing at this exact path between preflight checks
 * and this call must surface as a real destination conflict rather than
 * silently being adopted as if this operation created it.
 *
 * @param {string} absPath
 * @param {string} dirName - Used only for the error message (no absolute paths)
 * @throws {Error} on EEXIST (destination conflict) or any other creation failure
 */
function createProjectRootExclusive(absPath, dirName) {
  try {
    fs.mkdirSync(absPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(`Destination "${dirName}" already exists.`);
    }
    throw err;
  }
}

/**
 * Begin a cleanup-ownership record for a just-created project root. Must be
 * called immediately after the root directory is exclusively created, so
 * the captured filesystem identity (device + inode) reflects exactly the
 * directory this operation created — not whatever might occupy that path
 * later, if it is renamed away and replaced before compensation runs.
 *
 * @param {number} projectId
 * @param {string} relPath - Path relative to PROJECTS_ROOT
 * @param {string} expectedBasename - Directory name this operation created
 * @param {string} absPath - Absolute path to the newly created root
 * @returns {{projectId: number, relPath: string, expectedBasename: string, rootIdentity: {dev: number, ino: number}, children: Array}}
 */
function beginOwnership(projectId, relPath, expectedBasename, absPath) {
  const stats = fs.lstatSync(absPath);
  return {
    projectId,
    relPath,
    expectedBasename,
    rootIdentity: { dev: stats.dev, ino: stats.ino },
    children: [],
  };
}

/**
 * Record the filesystem identity of an artifact (a category directory)
 * immediately after this operation created it, so
 * compensation can later verify it is still the exact artifact created here
 * before removing it.
 *
 * @param {object} ownership - Record from {@link beginOwnership}
 * @param {string} rootAbsPath - Absolute path to the owned project root
 * @param {string} name - Direct-child name (category slug)
 * @param {boolean} isDirectory
 */
function trackOwnedChild(ownership, rootAbsPath, name, isDirectory) {
  try {
    const stats = fs.lstatSync(path.join(rootAbsPath, name));
    ownership.children.push({ name, isDirectory, dev: stats.dev, ino: stats.ino });
  } catch {
    // Vanished before we could capture it — nothing to track for cleanup.
  }
}

/**
 * Log a cleanup problem without exposing an absolute path to the user —
 * only the project ID and a safe artifact name (never a full path) reach
 * the log line.
 */
function logCleanupProblem(projectId, reason) {
  console.error(`[CreatorCrate] Creation rollback for project ${projectId} — ${reason}.`);
}

/**
 * Generate an unpredictable, collision-resistant quarantine basename. Kept
 * visually distinct from the legacy manifest temp-file pattern
 * (`.{hex12}.project.json.tmp`) so the two never collide or get confused
 * with one another during legacy manifest cleanup.
 *
 * @returns {string}
 */
function generateQuarantineName() {
  return `.cc-quarantine-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Best-effort restoration of a quarantined artifact back to its original
 * pathname. Only proceeds when that pathname is currently free — never
 * overwrites whatever now occupies it, so a foreign replacement that
 * appeared at the original path is always preserved untouched.
 *
 * @param {string} quarantinePath
 * @param {string} originalPath
 * @param {number} projectId
 * @param {string} name - Safe artifact name for logging (never a full path)
 */
function restoreQuarantined(quarantinePath, originalPath, projectId, name) {
  try {
    fs.lstatSync(originalPath);
    // Something already occupies the original path — never overwrite it.
    logCleanupProblem(projectId, `left artifact "${name}" at quarantine — original location is occupied`);
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logCleanupProblem(projectId, `left artifact "${name}" at quarantine — could not verify original location`);
      return;
    }
  }
  try {
    fs.renameSync(quarantinePath, originalPath);
  } catch {
    logCleanupProblem(projectId, `failed to restore artifact "${name}" after an identity mismatch`);
  }
}

/**
 * Atomic quarantine-and-verify removal of one tracked artifact (a category
 * directory or the project root itself).
 *
 * Never checks identity at the artifact's well-known pathname and then
 * removes that same pathname later — that TOCTOU window is exactly what
 * let a concurrent process swap in a foreign replacement between the check
 * and the removal. Instead:
 *
 *   1. Atomically rename the artifact to an unpredictable, private
 *      quarantine pathname in the same parent directory (exclusive
 *      retry-on-collision — never overwrites an existing quarantine path).
 *   2. Inspect the artifact now sitting at that quarantine pathname.
 *   3. Compare its filesystem identity (dev + ino) with the identity
 *      recorded when CreatorCrate created it.
 *   4. Only on a match: remove it from quarantine (a file via unlink; a
 *      directory only non-recursively and only if empty).
 *   5. On a mismatch: never delete it. Restore it to its original pathname
 *      when that pathname is free; otherwise leave it at the quarantine
 *      path and log the problem safely (no absolute paths).
 *
 * Because nothing else can guess the quarantine pathname, whatever a
 * concurrent process does to the *original* pathname after step 1 cannot
 * affect what this function inspects or removes.
 *
 * @param {string} parentDir - Resolved absolute directory containing the artifact
 * @param {string} name - Direct-child basename to quarantine and verify
 * @param {{dev: number, ino: number}} expectedIdentity - Identity captured at creation time
 * @param {boolean} isDirectory
 * @param {number} projectId - For safe (path-free) logging only
 */
function quarantineAndVerify(parentDir, name, expectedIdentity, isDirectory, projectId) {
  const originalPath = path.join(parentDir, name);

  let quarantinePath = null;
  for (let attempt = 0; attempt < 8 && !quarantinePath; attempt++) {
    const candidate = path.join(parentDir, generateQuarantineName());
    try {
      fs.renameSync(originalPath, candidate);
      quarantinePath = candidate;
    } catch (err) {
      if (err.code === 'ENOENT') return; // Already gone — nothing to do.
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') continue; // Quarantine name collision — retry.
      logCleanupProblem(projectId, `failed to quarantine artifact "${name}" for verification`);
      return;
    }
  }
  if (!quarantinePath) {
    logCleanupProblem(projectId, `failed to quarantine artifact "${name}" — no free quarantine name`);
    return;
  }

  let stats;
  try {
    stats = fs.lstatSync(quarantinePath);
  } catch {
    return; // Vanished between quarantine and inspection — nothing to do.
  }

  const identityMatches = stats.dev === expectedIdentity.dev && stats.ino === expectedIdentity.ino;
  if (!identityMatches) {
    logCleanupProblem(projectId, `artifact "${name}" was replaced; leaving it untouched`);
    restoreQuarantined(quarantinePath, originalPath, projectId, name);
    return;
  }

  try {
    if (isDirectory) {
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        logCleanupProblem(projectId, `artifact "${name}" is no longer a plain directory`);
        restoreQuarantined(quarantinePath, originalPath, projectId, name);
        return;
      }
      if (fs.readdirSync(quarantinePath).length > 0) {
        logCleanupProblem(projectId, `artifact "${name}" is not empty`);
        restoreQuarantined(quarantinePath, originalPath, projectId, name);
        return;
      }
      fs.rmdirSync(quarantinePath);
    } else {
      if (!stats.isFile() || stats.isSymbolicLink()) {
        logCleanupProblem(projectId, `artifact "${name}" is no longer a plain file`);
        restoreQuarantined(quarantinePath, originalPath, projectId, name);
        return;
      }
      fs.unlinkSync(quarantinePath);
    }
  } catch {
    logCleanupProblem(projectId, `failed to remove artifact "${name}" from quarantine`);
    restoreQuarantined(quarantinePath, originalPath, projectId, name);
  }
}

/**
 * Safely remove a newly created project directory during creation rollback.
 *
 * This function never checks identity at an artifact's well-known pathname
 * and removes that same pathname later — see {@link quarantineAndVerify}
 * for why that check-then-remove pattern is unsafe and how the atomic
 * quarantine sequence replaces it. Tracked children are quarantined and
 * verified first (the root can only be removed once empty), then the root
 * itself is quarantined and verified from within its own parent directory.
 *
 * A failed cleanup may leave the originally created directory or some of
 * its artifacts behind when ownership can no longer be proven — that is
 * preferable to deleting data this operation did not create. Any such
 * problem is logged with the project ID and artifact name only, never an
 * absolute path.
 *
 * @param {object} ownership - Record from {@link beginOwnership}, with
 *   `children` populated via {@link trackOwnedChild} for each artifact
 * @param {string} projectsRoot - Absolute path to PROJECTS_ROOT
 */
function safeRemoveCreatedDir(ownership, projectsRoot) {
  if (!ownership) return;
  const { projectId, relPath, rootIdentity, children } = ownership;

  let resolved;
  try {
    resolved = resolveProjectDir(projectsRoot, relPath);
  } catch {
    // Path no longer safe to resolve (escapes root, symlink component) —
    // nothing can be safely removed.
    return;
  }

  for (const child of children) {
    quarantineAndVerify(resolved, child.name, { dev: child.dev, ino: child.ino }, child.isDirectory === true, projectId);
  }

  quarantineAndVerify(path.dirname(resolved), path.basename(resolved), rootIdentity, true, projectId);
}

/**
 * Move an existing project root into a private sibling quarantine before the
 * database transaction. The root is never recursively removed by pathname:
 * its ownership witness and identity are checked after the atomic move.
 *
 * Deletion is gated on the persistent ownership witness (bound SQLite token +
 * matching `.creatorcrate-owner` marker). A directory that cannot be proven
 * to be this project's — unbound, missing, unreadable, unmarked, or carrying
 * another project's token — fails closed: nothing is moved and the database
 * row and its relationships survive. In particular, an absent project root
 * no longer authorizes database deletion, because an empty or unavailable
 * PROJECTS_ROOT share is indistinguishable from a deleted directory.
 *
 * The only DB-only deletion is a row with no stored directory and no
 * ownership binding at all: there is no path at which content could exist.
 *
 * @param {object} project
 * @param {object} deps
 * @param {object} deps.ownershipVerifier
 * @param {object} deps.ownershipRepository
 * @returns {{ originalPath: string, quarantinePath: string, identity: {dev: number, ino: number}, token: string }|null}
 */
function quarantineProjectDirForDeletion(project, { ownershipVerifier, ownershipRepository }) {
  if (project.project_dir == null && !ownershipRepository.findByProjectId(project.id)) return null;

  const verified = ownershipVerifier.verifyProject(project);
  const resolved = verified.absPath;

  const staged = {
    originalPath: resolved,
    quarantinePath: null,
    identity: verified.identity,
    token: verified.token,
    restored: false,
  };

  for (let attempt = 0; attempt < 8 && !staged.quarantinePath; attempt++) {
    const candidate = path.join(path.dirname(resolved), generateQuarantineName());
    try {
      fs.renameSync(resolved, candidate);
      staged.quarantinePath = candidate;
    } catch (err) {
      // The verified directory vanished before it could be staged: fail
      // closed rather than deleting the database row without its content.
      if (err.code === 'ENOENT') throw new ProjectOwnershipError('PROJECT_DIRECTORY_MISSING');
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') continue;
      throw new Error('Project directory could not be safely staged.');
    }
  }

  if (!staged.quarantinePath) {
    throw new Error('Project directory could not be safely staged.');
  }

  // The staged directory must be the exact directory verified above and
  // still carry this project's token; otherwise it is put back untouched.
  try {
    assertSameDirectory(staged.quarantinePath, staged.identity);
    assertProjectOwnershipMarker(staged.quarantinePath, staged.token);
  } catch (err) {
    if (!restoreQuarantinedProjectDir(staged)) {
      logDeletionCleanupProblem(project.id, 'project directory could not be restored after verification failure');
      throw new Error('Project directory cleanup requires recovery.');
    }
    throw err;
  }

  return staged;
}

/**
 * Recursively remove a quarantined project root only after rechecking the
 * captured identity and its ownership marker. An absent quarantine is
 * already clean; all other access or removal failures are surfaced to the
 * caller.
 *
 * @param {object} staged
 */
function removeQuarantinedProjectDir(staged) {
  let stats;
  try {
    stats = fs.lstatSync(staged.quarantinePath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new Error('Project directory could not be safely verified for removal.');
  }

  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.dev !== staged.identity.dev
    || stats.ino !== staged.identity.ino
  ) {
    throw new Error('Project directory identity changed before removal.');
  }

  // Last check before the irreversible recursive removal: the staged tree
  // must still be this project's ownership witness.
  try {
    assertProjectOwnershipMarker(staged.quarantinePath, staged.token);
  } catch {
    throw new Error('Project directory ownership changed before removal.');
  }

  try {
    fs.rmSync(staged.quarantinePath, { recursive: true, force: false });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new Error('Project directory could not be removed.');
  }
}

/**
 * Restore a staged project root without overwriting an occupant that appeared
 * at its original path. This mirrors the existing quarantine cleanup policy.
 *
 * @param {object} staged
 * @returns {boolean}
 */
function restoreQuarantinedProjectDir(staged) {
  if (staged.restored) return true;

  try {
    const quarantined = fs.lstatSync(staged.quarantinePath);
    if (
      !quarantined.isDirectory()
      || quarantined.isSymbolicLink()
      || quarantined.dev !== staged.identity.dev
      || quarantined.ino !== staged.identity.ino
    ) return false;
  } catch {
    return false;
  }

  try {
    fs.lstatSync(staged.originalPath);
    return false;
  } catch (err) {
    if (err.code !== 'ENOENT') return false;
  }

  try {
    fs.renameSync(staged.quarantinePath, staged.originalPath);
    staged.restored = true;
    return true;
  } catch {
    return false;
  }
}

function logDeletionCleanupProblem(projectId, reason) {
  console.error(`[CreatorCrate] Project deletion cleanup for project ${projectId} — ${reason}.`);
}
