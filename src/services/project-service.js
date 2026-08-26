import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import slugify from '@sindresorhus/slugify';
import {
  createProjectRepository,
  STATUSES,
  WORKFLOW_STATUSES,
  PROJECT_TYPES,
  DEFAULT_PROJECT_TYPE,
} from '../data/project-repository.js';
import { createReleaseRepository } from '../data/release-repository.js';
import {
  formatProjectDirName,
  resolveProjectDir,
  ensureNoConflict,
  createProjectCategoryDirs,
  verifyProjectDirOwnership,
  renameProjectDirSync,
} from '../storage/project-storage.js';
import {
  writeManifestSync,
  readManifestSync,
  validateManifest,
  MANIFEST_FILENAME,
} from '../storage/manifest.js';
import { isValidWebUrl } from '../util/url.js';

export { STATUSES, WORKFLOW_STATUSES };

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidDate(value) {
  if (!value) return true;
  if (!DATE_RE.test(value)) return false;
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

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
 */
export function createProjectService(
  db,
  projectsRoot,
  { assetCategoryService, assetBrowserPreferenceRepository, applicationLogger = null } = {}
) {
  if (!assetCategoryService) {
    throw new Error('createProjectService requires an assetCategoryService dependency.');
  }
  if (!assetBrowserPreferenceRepository) {
    throw new Error('createProjectService requires an assetBrowserPreferenceRepository dependency.');
  }

  const repository = createProjectRepository(db);
  const releaseRepository = createReleaseRepository(db);

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

  function validate(input, options = {}) {
    const { existingId, existingProjectType = DEFAULT_PROJECT_TYPE } = options;
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
    if (!WORKFLOW_STATUSES.includes(status)) {
      errors.status = `Status must be one of: ${WORKFLOW_STATUSES.join(', ')}.`;
    }

    // Empty project type follows form compatibility: create defaults to images;
    // update retains the project's stored type rather than resetting it.
    const projectType = input.projectType === undefined || input.projectType === null || input.projectType === ''
      ? existingProjectType
      : input.projectType;
    if (!PROJECT_TYPES.includes(projectType)) {
      errors.projectType = `Project type must be one of: ${PROJECT_TYPES.join(', ')}.`;
    }

    const plannedDate = input.plannedDate || null;
    if (!isValidDate(plannedDate)) {
      errors.plannedDate = 'Planned date must be a valid date (YYYY-MM-DD).';
    }

    const publishedDate = input.publishedDate || null;
    if (!isValidDate(publishedDate)) {
      errors.publishedDate = 'Published date must be a valid date (YYYY-MM-DD).';
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
      plannedDate,
      publishedDate,
      patreonUrl,
    };
  }

  /**
   * Compensate an update failure by restoring the previous filesystem and
   * database state as closely as possible.
   *
   * Safety: all paths are derived from project.project_dir (which passed
   * resolveProjectDir at creation time) and the project ID.
   *
   * @param {object} project - Original project record (pre-update)
   * @param {object} originalInput - Original values in repository.update format
   * @param {string|null} originalProjectDir - Original project_dir value
   * @param {boolean} dirNeedsChange - Whether a dir change was planned
   * @param {string|null} currentAbsPath - Original absolute directory path
   * @param {string|null} newAbsPath - New absolute path (may or may not exist)
   * @param {boolean} dirMoved - Whether the directory was actually moved
   * @param {object|null} updated - Updated project record (if DB was updated)
   */
  function compensateUpdate(project, originalInput, originalProjectDir,
    dirNeedsChange, currentAbsPath, newAbsPath, dirMoved, updated) {
    try {
      // Step A: If directory was moved to newAbsPath, move it back
      if (dirNeedsChange && dirMoved && newAbsPath && currentAbsPath) {
        try {
          if (fs.existsSync(newAbsPath)) {
            renameProjectDirSync(newAbsPath, currentAbsPath);
          }
        } catch (moveBackErr) {
          console.error(
            `[CreatorCrate] Update rollback — failed to move directory ` +
            `"${path.basename(newAbsPath)}" back: ${moveBackErr.message}`
          );
        }
      }

      // Step B: Restore original manifest at original location
      if (currentAbsPath && fs.existsSync(currentAbsPath)) {
        try {
          const categories = assetCategoryService.listProjectCategories(project.id);
          writeManifestSync(currentAbsPath, project, projectsRoot, categories);
        } catch (manifestErr) {
          console.error(
            `[CreatorCrate] Update rollback — failed to restore manifest ` +
            `for project ${project.id}: ${manifestErr.message}`
          );
        }
      }

      // Step C: Restore original database values
      if (updated) {
        try {
          repository.update(project.id, originalInput);
          repository.setProjectDir(project.id, originalProjectDir);
        } catch (dbErr) {
          console.error(
            `[CreatorCrate] Update rollback — failed to restore database ` +
            `for project ${project.id}: ${dbErr.message}`
          );
        }
      }
    } catch (compErr) {
      console.error(
        `[CreatorCrate] Update rollback — compensation failed for project ` +
        `${project.id}: ${compErr.message}`
      );
    }
  }

  return {
    STATUSES,
    WORKFLOW_STATUSES,

    repository,

    create(input) {
      const normalized = validate(input);

      let project;
      let relPath;
      let dirCreated = false;
      // Cleanup ownership record — set ONLY after the exact exclusive root
      // creation below succeeds. Never inferred from the DB row, a slug, or
      // a preflight check; it is the sole authority for what compensation
      // is allowed to recursively remove.
      let ownership = null;

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

        // Phase 2: Copy enabled global defaults into independent,
        // project-owned category rows, in deterministic contiguous order.
        const categories = assetCategoryService.copyDefaultsForProject(project.id);

        // Phase 3: Initialize the explicit project preference in this same
        // transaction. The repository deliberately does not open a nested
        // transaction, so a failure rolls back the project and copied rows.
        assetBrowserPreferenceRepository.ensureProjectPreference(project.id);

        // Phase 4: Compute the canonical (unchanged) project-directory name.
        // Status does not participate: the project directory is always a
        // direct child of PROJECTS_ROOT.
        const dirName = formatProjectDirName(project.id, project.slug);
        relPath = dirName;
        const absPath = resolveProjectDir(projectsRoot, relPath);

        // Phase 5: Destination safety check.
        ensureNoConflict(absPath);

        // Phase 6: Exclusively create the final project root.
        createProjectRootExclusive(absPath, dirName);
        dirCreated = true;
        ownership = beginOwnership(project.id, relPath, dirName, absPath);

        // Phase 7: Category-driven child directories (enabled categories only).
        createProjectCategoryDirs(absPath, categories);
        for (const category of categories) {
          if (!isCategoryEnabled(category)) continue;
          trackOwnedChild(ownership, absPath, category.directory_slug ?? category.directorySlug, true);
        }

        // Phase 8: Write the schema-version-3 manifest with those categories.
        writeManifestSync(absPath, project, projectsRoot, categories);
        trackOwnedChild(ownership, absPath, MANIFEST_FILENAME, false);

        // Phase 9: Persist the relative project path.
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
        // project row and any project-category rows inserted above.
        if (dirCreated && ownership) {
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

        // Generic user-visible error — no absolute paths leaked
        throw new Error('Project creation failed. Please try again.');
      }
    },

    update(id, input) {
      const project = repository.findById(id);
      if (!project) {
        throw new ProjectNotFoundError(id);
      }

      // Phase 1: Validate input
      const normalized = validate(input, {
        existingId: id,
        existingProjectType: project.project_type,
      });

      // Phase 2: Compute changes and pre-flight validation.
      //
      // Only a title/slug change may rename the flat project directory.
      // A status-only change is a database/UI transition: it must not
      // inspect, rename, or move anything on the filesystem and must not
      // require a valid manifest or stored directory.
      const slugChanged = normalized.slug !== project.slug;
      const dirNeedsChange = slugChanged;

      // The manifest serializes title, slug, description, notes,
      // planned/published date, and patreon URL. Status and project type are
      // database/UI metadata, so either alone skips the filesystem entirely.
      // Fields are compared via their DB→input
      // (snake_case→camelCase) mapping.
      const metadataChanged = [
        ['title', 'title'],
        ['slug', 'slug'],
        ['description', 'description'],
        ['notes', 'notes'],
        ['planned_date', 'plannedDate'],
        ['published_date', 'publishedDate'],
        ['patreon_url', 'patreonUrl'],
      ].some(([dbField, inputField]) => normalized[inputField] !== project[dbField]);
      const manifestNeedsRewrite = dirNeedsChange || metadataChanged;
      const persistedChanged = metadataChanged
        || normalized.status !== project.status
        || normalized.projectType !== project.project_type;

      let currentAbsPath = null;
      let newRelPath = null;
      let newAbsPath = null;

      if (dirNeedsChange) {
        if (!project.project_dir) {
          throw new Error('Project has no stored directory path.');
        }

        currentAbsPath = resolveProjectDir(projectsRoot, project.project_dir);

        // Verify source directory ownership (ID prefix)
        if (!verifyProjectDirOwnership(currentAbsPath, project.id)) {
          throw new Error('Source directory ownership verification failed.');
        }

        // Verify source directory exists and is not a symlink
        let srcStats;
        try {
          srcStats = fs.lstatSync(currentAbsPath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            throw new Error('Project directory not found.');
          }
          throw new Error('Cannot access project directory.');
        }
        if (!srcStats.isDirectory()) {
          throw new Error('Source is not a directory.');
        }
        if (srcStats.isSymbolicLink()) {
          throw new Error('Source is a symbolic link.');
        }

        // Verify existing manifest belongs to the expected project
        let manifest = null;
        try {
          manifest = validateManifest(readManifestSync(currentAbsPath));
        } catch {
          manifest = null;
        }
        if (!manifest || manifest.id !== project.id) {
          throw new Error('Existing manifest does not match the expected project.');
        }

        // Compute new path and verify no destination conflict
        const dirName = formatProjectDirName(project.id, normalized.slug);
        newRelPath = dirName;
        newAbsPath = resolveProjectDir(projectsRoot, newRelPath);
        ensureNoConflict(newAbsPath);
      } else if (manifestNeedsRewrite) {
        if (!project.project_dir) {
          throw new Error('Project has no stored directory path.');
        }
        currentAbsPath = resolveProjectDir(projectsRoot, project.project_dir);
      }

      // Save original values for potential compensation
      const originalInput = {
        title: project.title,
        slug: project.slug,
        description: project.description,
        notes: project.notes,
        status: project.status,
        projectType: project.project_type,
        plannedDate: project.planned_date,
        publishedDate: project.published_date,
        patreonUrl: project.patreon_url,
      };
      const originalProjectDir = project.project_dir;

      // ── Execution ─────────────────────────────────────────────────
      let updated;
      let dirMoved = false;

      try {
        // Phase 3: Update database metadata (status included — it is a
        // DB/UI-only value and must not be written to the manifest).
        updated = repository.update(id, normalized);
        if (!updated) {
          throw new ProjectNotFoundError(id);
        }

        // Phase 4: Rename the flat project directory if the slug changed.
        // A status-only update never touches the filesystem.
        if (dirNeedsChange) {
          renameProjectDirSync(currentAbsPath, newAbsPath);
          dirMoved = true;
        }

        // Phase 5: Write the updated manifest at the final location,
        // preserving the project's current categories (never recopied or
        // propagated from global defaults here). A metadata-only update
        // (no slug change) rewrites project.json in place; a pure
        // status-only update skips the manifest entirely.
        if (manifestNeedsRewrite) {
          const manifestTarget = dirNeedsChange ? newAbsPath : currentAbsPath;
          const categories = assetCategoryService.listProjectCategories(id);
          writeManifestSync(manifestTarget, updated, projectsRoot, categories);
        }

        // Phase 6: Update stored path in database (only on rename)
        if (dirNeedsChange) {
          updated = repository.setProjectDir(id, newRelPath);
        }

        if (persistedChanged) {
          logActivity('project.updated', updated, {
            previousStatus: project.status,
            status: updated.status,
            previousProjectType: project.project_type,
            projectType: updated.project_type,
          });
        }
        return updated;
      } catch (err) {
        // ── Compensation ─────────────────────────────────────────
        compensateUpdate(project, originalInput, originalProjectDir,
          dirNeedsChange, currentAbsPath, newAbsPath, dirMoved, updated);

        // Log the primary failure (project ID + relative path, no absolute paths)
        console.error(
          `[CreatorCrate] Project update failed for project ${id} ` +
          `(${project.project_dir}): ${err.message}`
        );

        if (err instanceof ProjectValidationError) throw err;
        if (err instanceof ProjectNotFoundError) throw err;
        throw new Error('Project update failed. Please try again.');
      }
    },

    archive(id) {
      const project = repository.findById(id);
      if (!project) {
        throw new ProjectNotFoundError(id);
      }

      if (project.archived_at) {
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
        staged = quarantineProjectDirForDeletion(project, projectsRoot);

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
 * Record the filesystem identity of an artifact (category directory or the
 * manifest file) immediately after this operation created it, so
 * compensation can later verify it is still the exact artifact created here
 * before removing it.
 *
 * @param {object} ownership - Record from {@link beginOwnership}
 * @param {string} rootAbsPath - Absolute path to the owned project root
 * @param {string} name - Direct-child name (category slug or manifest filename)
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
 * visually distinct from manifest.js's own temp-file pattern
 * (`.{hex12}.project.json.tmp`) so the two never collide or get confused
 * with one another during normal manifest cleanup.
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
 * directory, the manifest file, or the project root itself).
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
 * its ownership and identity are checked after the atomic move instead.
 *
 * @param {object} project
 * @param {string} projectsRoot
 * @returns {{ originalPath: string, quarantinePath: string, identity: {dev: number, ino: number} }|null}
 */
function quarantineProjectDirForDeletion(project, projectsRoot) {
  if (project.project_dir == null) return null;

  const resolved = resolveProjectDir(projectsRoot, project.project_dir);
  if (!verifyProjectDirOwnership(resolved, project.id)) {
    throw new Error('Project directory ownership verification failed.');
  }

  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error('Cannot safely verify project directory.');
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Project directory is not a safe directory.');
  }

  const staged = {
    originalPath: resolved,
    quarantinePath: null,
    identity: { dev: stats.dev, ino: stats.ino },
    restored: false,
  };

  for (let attempt = 0; attempt < 8 && !staged.quarantinePath; attempt++) {
    const candidate = path.join(path.dirname(resolved), generateQuarantineName());
    try {
      fs.renameSync(resolved, candidate);
      staged.quarantinePath = candidate;
    } catch (err) {
      if (err.code === 'ENOENT') return null; // Already absent — nothing to remove.
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') continue;
      throw new Error('Project directory could not be safely staged.');
    }
  }

  if (!staged.quarantinePath) {
    throw new Error('Project directory could not be safely staged.');
  }

  try {
    const quarantined = fs.lstatSync(staged.quarantinePath);
    if (
      !quarantined.isDirectory()
      || quarantined.isSymbolicLink()
      || quarantined.dev !== staged.identity.dev
      || quarantined.ino !== staged.identity.ino
    ) {
      throw new Error('Project directory identity changed during deletion.');
    }
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
 * captured identity. An absent quarantine is already clean; all other access
 * or removal failures are surfaced to the caller.
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
