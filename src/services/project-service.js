import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import slugify from '@sindresorhus/slugify';
import {
  createProjectRepository,
  STATUSES,
  WORKFLOW_STATUSES,
  PRIORITIES,
} from '../data/project-repository.js';
import {
  formatProjectDirName,
  buildProjectRelPath,
  resolveProjectDir,
  ensureNoConflict,
  createProjectCategoryDirs,
  verifyProjectDirOwnership,
  renameProjectDirSync,
} from '../storage/project-storage.js';
import {
  writeManifestSync,
  readManifestSync,
  validateManifestV2,
  MANIFEST_FILENAME,
} from '../storage/manifest.js';

export { STATUSES, WORKFLOW_STATUSES, PRIORITIES };

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

function isValidPatreonUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^([^.]+\.)?patreon\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectsRoot
 * @param {object} deps
 * @param {object} deps.assetCategoryService - Injected asset-category
 *   service (see services/asset-category-service.js). Required — this
 *   service never constructs its own category repository or service.
 */
export function createProjectService(db, projectsRoot, { assetCategoryService } = {}) {
  if (!assetCategoryService) {
    throw new Error('createProjectService requires an assetCategoryService dependency.');
  }

  const repository = createProjectRepository(db);

  function validate(input, options = {}) {
    const { existingId } = options;
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

    const priority = input.priority;
    if (!PRIORITIES.includes(priority)) {
      errors.priority = `Priority must be one of: ${PRIORITIES.join(', ')}.`;
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
    if (!isValidPatreonUrl(patreonUrl)) {
      errors.patreonUrl = 'Patreon URL must be a valid https://patreon.com link.';
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
      priority,
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

  /**
   * Compensate an archive failure by restoring filesystem and database state.
   *
   * @param {object} project - Original project record (pre-archive)
   * @param {string} originalStatus - Original status value
   * @param {string|null} originalProjectDir - Original project_dir value
   * @param {string} currentAbsPath - Original absolute directory path
   * @param {string|null} newAbsPath - Target archived absolute path
   * @param {boolean} dirMoved - Whether the directory was moved
   * @param {boolean} dbArchived - Whether the database was archived
   */
  function compensateArchive(project, originalStatus, originalProjectDir,
    currentAbsPath, newAbsPath, dirMoved, dbArchived) {
    try {
      // Step A: If directory was moved, move it back
      if (dirMoved && newAbsPath && currentAbsPath) {
        try {
          if (fs.existsSync(newAbsPath)) {
            renameProjectDirSync(newAbsPath, currentAbsPath);
          }
        } catch (moveBackErr) {
          console.error(
            `[CreatorCrate] Archive rollback — failed to move directory ` +
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
            `[CreatorCrate] Archive rollback — failed to restore manifest ` +
            `for project ${project.id}: ${manifestErr.message}`
          );
        }
      }

      // Step C: Restore original database values
      if (dbArchived) {
        try {
          repository.restoreFromArchive(project.id, originalStatus, originalProjectDir);
        } catch (dbErr) {
          console.error(
            `[CreatorCrate] Archive rollback — failed to restore database ` +
            `for project ${project.id}: ${dbErr.message}`
          );
        }
      }
    } catch (compErr) {
      console.error(
        `[CreatorCrate] Archive rollback — compensation failed for project ` +
        `${project.id}: ${compErr.message}`
      );
    }
  }

  return {
    STATUSES,
    WORKFLOW_STATUSES,
    PRIORITIES,

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

        // Phase 3: Compute the canonical (unchanged) project-directory path.
        const dirName = formatProjectDirName(project.id, project.slug);
        relPath = buildProjectRelPath(project.status, dirName);
        const absPath = resolveProjectDir(projectsRoot, relPath);

        // Phase 4: Destination safety check.
        ensureNoConflict(absPath);

        // Phase 5: Exclusively create the final project root.
        createProjectRootExclusive(absPath, dirName);
        dirCreated = true;
        ownership = beginOwnership(project.id, relPath, dirName, absPath);

        // Phase 6: Category-driven child directories (enabled categories only).
        createProjectCategoryDirs(absPath, categories);
        for (const category of categories) {
          if (!isCategoryEnabled(category)) continue;
          trackOwnedChild(ownership, absPath, category.directory_slug ?? category.directorySlug, true);
        }

        // Phase 7: Write the schema-version-2 manifest with those categories.
        writeManifestSync(absPath, project, projectsRoot, categories);
        trackOwnedChild(ownership, absPath, MANIFEST_FILENAME, false);

        // Phase 8: Persist the relative project path.
        project = repository.setProjectDir(project.id, relPath);

        return project;
      });

      try {
        return runCreate();
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
      const normalized = validate(input, { existingId: id });

      // Phase 2: Compute changes and pre-flight validation
      const slugChanged = normalized.slug !== project.slug;
      const statusChanged = normalized.status !== project.status;
      const dirNeedsChange = slugChanged || statusChanged;

      if (!project.project_dir) {
        throw new Error('Project has no stored directory path.');
      }

      const currentAbsPath = resolveProjectDir(projectsRoot, project.project_dir);

      let newRelPath = null;
      let newAbsPath = null;

      if (dirNeedsChange) {
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
          manifest = validateManifestV2(readManifestSync(currentAbsPath));
        } catch {
          manifest = null;
        }
        if (!manifest || manifest.id !== project.id) {
          throw new Error('Existing manifest does not match the expected project.');
        }

        // Compute new path and verify no destination conflict
        const dirName = formatProjectDirName(project.id, normalized.slug);
        newRelPath = buildProjectRelPath(normalized.status, dirName);
        newAbsPath = resolveProjectDir(projectsRoot, newRelPath);
        ensureNoConflict(newAbsPath);
      }

      // Save original values for potential compensation
      const originalInput = {
        title: project.title,
        slug: project.slug,
        description: project.description,
        notes: project.notes,
        status: project.status,
        priority: project.priority,
        plannedDate: project.planned_date,
        publishedDate: project.published_date,
        patreonUrl: project.patreon_url,
      };
      const originalProjectDir = project.project_dir;

      // ── Execution ─────────────────────────────────────────────────
      let updated;
      let dirMoved = false;

      try {
        // Phase 3: Update database metadata
        updated = repository.update(id, normalized);
        if (!updated) {
          throw new ProjectNotFoundError(id);
        }

        // Phase 4: Rename/move directory if needed
        if (dirNeedsChange) {
          renameProjectDirSync(currentAbsPath, newAbsPath);
          dirMoved = true;
        }

        // Phase 5: Write updated manifest at final location, preserving the
        // project's current categories (never recopied or propagated from
        // global defaults here).
        const manifestTarget = dirNeedsChange ? newAbsPath : currentAbsPath;
        const categories = assetCategoryService.listProjectCategories(id);
        writeManifestSync(manifestTarget, updated, projectsRoot, categories);

        // Phase 6: Update stored path in database (if directory changed)
        if (dirNeedsChange) {
          updated = repository.setProjectDir(id, newRelPath);
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

      if (!project.project_dir) {
        throw new Error('Project has no stored directory path.');
      }

      // ── Phase 0: Pre-flight ────────────────────────────────────────

      const currentAbsPath = resolveProjectDir(projectsRoot, project.project_dir);

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

      // Verify existing manifest matches the project
      let manifest = null;
      try {
        manifest = validateManifestV2(readManifestSync(currentAbsPath));
      } catch {
        manifest = null;
      }
      if (!manifest || manifest.id !== project.id) {
        throw new Error('Existing manifest does not match the expected project.');
      }

      // Compute target path in archived/
      const dirName = formatProjectDirName(project.id, project.slug);
      const newRelPath = buildProjectRelPath('archived', dirName);
      const newAbsPath = resolveProjectDir(projectsRoot, newRelPath);

      // Verify no destination conflict
      ensureNoConflict(newAbsPath);

      // Save original values for compensation
      const originalStatus = project.status;
      const originalProjectDir = project.project_dir;

      // ── Execution ───────────────────────────────────────────────────
      let dirMoved = false;
      let dbArchived = false;

      try {
        // Phase 1: Move directory to archived/
        renameProjectDirSync(currentAbsPath, newAbsPath);
        dirMoved = true;

        // Phase 2: Archive in database
        const archived = repository.archive(id);
        if (!archived) {
          throw new Error('Failed to archive project in database.');
        }
        dbArchived = true;

        // Phase 3: Write manifest at new location, preserving current categories
        const categories = assetCategoryService.listProjectCategories(id);
        writeManifestSync(newAbsPath, archived, projectsRoot, categories);

        // Phase 4: Update stored relative path
        const updated = repository.setProjectDir(id, newRelPath);

        return updated;
      } catch (err) {
        // ── Compensation ───────────────────────────────────────────
        compensateArchive(project, originalStatus, originalProjectDir,
          currentAbsPath, newAbsPath, dirMoved, dbArchived);

        // Log the primary failure (safe relative path, no absolute paths)
        console.error(
          `[CreatorCrate] Archive failed for project ${id} ` +
          `(${project.project_dir}): ${err.message}`
        );

        throw new Error('Project archive failed. Please try again.');
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

    listPublished(options = {}) {
      return repository.listPublished(options);
    },

    countByStatus() {
      return repository.countByStatus();
    },

    /**
     * Backfill project directories for existing records with no relative path.
     *
     * Scans records where project_dir IS NULL, computes the canonical path
     * from the project's status and slug, and either creates the directory
     * fresh or adopts an existing matching directory.
     *
     * Idempotent — subsequent calls skip records that already have project_dir
     * (only findByProjectDirNull() is queried).
     *
     * Adoption rules (all must pass):
     * - Destination is a real directory (not a file, not a symlink)
     * - project.json exists and is valid JSON
     * - schemaVersion is 2
     * - Manifest project ID matches the database record
     * - Manifest slug matches the database record
     *
     * Never overwrites or modifies a non-matching directory, and never
     * invents categories for a project that has no project-category rows.
     *
     * Startup behavior: failures do NOT halt the caller. Each project is
     * processed independently; errors and conflicts are logged and collected
     * in the returned results object.
     *
     * @returns {{ backfilled: number, adopted: number, conflicts: number, errors: Array<{id: number, error: string}> }}
     */
    backfillProjectDirs() {
      const records = repository.findByProjectDirNull();
      const results = { backfilled: 0, adopted: 0, conflicts: 0, errors: [] };

      for (const project of records) {
        let dirName, relPath, absPath;
        let createdByUs = false;
        let exists = false;
        let ownership = null;

        try {
          dirName = formatProjectDirName(project.id, project.slug);
          relPath = buildProjectRelPath(project.status, dirName);

          // Compute absolute path without safety checks first, so we can
          // test existence before resolveProjectDir (which may throw on
          // symlinks that should be treated as conflicts, not errors).
          absPath = path.resolve(projectsRoot, relPath);

          exists = fs.existsSync(absPath);
          if (exists) {
            // ── Adoption path: verify safety then adopt matching directory ──
            // Verify path is safe (contained in projectsRoot, no symlinks)
            resolveProjectDir(projectsRoot, relPath);

            const stats = fs.lstatSync(absPath);
            if (!stats.isDirectory()) {
              throw new Error(
                `"${path.basename(absPath)}" exists but is not a directory.`
              );
            }
            if (stats.isSymbolicLink()) {
              throw new Error(
                `"${path.basename(absPath)}" is a symbolic link.`
              );
            }

            const rawManifest = readManifestSync(absPath);
            if (!rawManifest) {
              throw new Error('Destination has no project manifest.');
            }
            const manifest = validateManifestV2(rawManifest);
            if (manifest.id !== project.id) {
              throw new Error(
                `Manifest ID ${manifest.id} does not match project ${project.id}.`
              );
            }
            if (manifest.slug !== project.slug) {
              throw new Error(
                `Manifest slug "${manifest.slug}" does not match "${project.slug}".`
              );
            }
            // Adoption checks passed
          } else {
            // ── Fresh creation: verify safety then create ──
            resolveProjectDir(projectsRoot, relPath);
            ensureNoConflict(absPath);
            const categories = assetCategoryService.listProjectCategories(project.id);
            // Same exclusive-creation guarantee as normal project creation:
            // a foreign directory appearing between the preflight checks
            // above and this call must surface as a conflict, not be
            // silently adopted as if this operation created it.
            createProjectRootExclusive(absPath, dirName);
            createdByUs = true;
            ownership = beginOwnership(project.id, relPath, dirName, absPath);

            createProjectCategoryDirs(absPath, categories);
            for (const category of categories) {
              if (!isCategoryEnabled(category)) continue;
              trackOwnedChild(ownership, absPath, category.directory_slug ?? category.directorySlug, true);
            }

            writeManifestSync(absPath, project, projectsRoot, categories);
            trackOwnedChild(ownership, absPath, MANIFEST_FILENAME, false);
          }

          // ── Store relative path ──
          repository.setProjectDir(project.id, relPath);

          if (exists) {
            results.adopted++;
          } else {
            results.backfilled++;
          }
        } catch (err) {
          if (exists) {
            // Destination existed but adoption checks failed — safe conflict
            results.conflicts++;
            console.error(
              `[CreatorCrate] Backfill conflict — project ${project.id} ` +
              `(${relPath}): ${err.message}`
            );
          } else {
            // Failed during fresh creation — compensate
            if (createdByUs && ownership) {
              try {
                safeRemoveCreatedDir(ownership, projectsRoot);
              } catch (cleanupErr) {
                console.error(
                  `[CreatorCrate] Backfill cleanup failed for project ${project.id}: ${cleanupErr.message}`
                );
              }
            }
            results.errors.push({ id: project.id, error: err.message });
            console.error(
              `[CreatorCrate] Backfill failed for project ${project.id} ` +
              `(${relPath || dirName}): ${err.message}`
            );
          }
        }
      }

      const total = results.backfilled + results.adopted +
        results.conflicts + results.errors.length;
      if (total > 0) {
        console.log(
          `[CreatorCrate] Backfill complete: ${results.backfilled} created, ` +
          `${results.adopted} adopted, ${results.conflicts} conflicts, ` +
          `${results.errors.length} errors`
        );
      }

      return results;
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
 * silently being adopted as if this operation created it. Shared by normal
 * project creation and fresh-directory backfill so both get the identical
 * exclusivity guarantee.
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
