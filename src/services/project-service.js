import fs from 'node:fs';
import path from 'node:path';
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
  createProjectSubdirs,
  verifyProjectDirOwnership,
  renameProjectDirSync,
} from '../storage/project-storage.js';
import { writeManifestSync, readManifestSync } from '../storage/manifest.js';

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

export function createProjectService(db, projectsRoot) {
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
          writeManifestSync(currentAbsPath, project, projectsRoot);
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
          writeManifestSync(currentAbsPath, project, projectsRoot);
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

      // Phase 1: Create database record to obtain numeric ID
      let project;
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

      // ── Compute paths ──────────────────────────────────────────────
      const dirName = formatProjectDirName(project.id, project.slug);
      const relPath = buildProjectRelPath(project.status, dirName);
      const absPath = resolveProjectDir(projectsRoot, relPath);

      let dirCreated = false;

      try {
        // Phase 2: Create filesystem directory structure
        // 2a. Verify no existing file/directory at destination
        ensureNoConflict(absPath);
        // 2b. Create the project directory
        fs.mkdirSync(absPath, { recursive: true });
        dirCreated = true;
        // 2c. Create standard subdirectories (source, exports/, etc.)
        createProjectSubdirs(absPath);

        // Phase 3: Write the project manifest (project.json)
        writeManifestSync(absPath, project, projectsRoot);

        // Phase 4: Store the relative project path in the database
        project = repository.setProjectDir(project.id, relPath);

        return project;
      } catch (err) {
        // ── Compensation ──────────────────────────────────────────
        // Rollback filesystem artifacts if any were created
        if (dirCreated) {
          safeRemoveCreatedDir(absPath, project.id, projectsRoot);
        }

        // Rollback database record (hard delete, not archive)
        try {
          repository.deleteById(project.id);
        } catch (deleteErr) {
          console.error(
            `[CreatorCrate] Creation rollback — failed to delete project ` +
            `record ${project.id}: ${deleteErr.message}`
          );
        }

        // Log original failure (project ID + relative path, no absolute paths)
        console.error(
          `[CreatorCrate] Project creation failed for project ${project.id} ` +
          `(${relPath}): ${err.message}`
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
        const manifest = readManifestSync(currentAbsPath);
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

        // Phase 5: Write updated manifest at final location
        const manifestTarget = dirNeedsChange ? newAbsPath : currentAbsPath;
        writeManifestSync(manifestTarget, updated, projectsRoot);

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
      const manifest = readManifestSync(currentAbsPath);
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

        // Phase 3: Write manifest at new location
        writeManifestSync(newAbsPath, archived, projectsRoot);

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
     * - schemaVersion is 1
     * - Manifest project ID matches the database record
     * - Manifest slug matches the database record
     *
     * Never overwrites or modifies a non-matching directory.
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

            const manifest = readManifestSync(absPath);
            if (!manifest) {
              throw new Error('Destination has no project manifest.');
            }
            if (manifest.schemaVersion !== 1) {
              throw new Error(
                `Schema version ${manifest.schemaVersion} is not supported.`
              );
            }
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
            fs.mkdirSync(absPath, { recursive: true });
            createdByUs = true;
            createProjectSubdirs(absPath);
            writeManifestSync(absPath, project, projectsRoot);
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
            if (createdByUs && absPath) {
              try {
                safeRemoveCreatedDir(absPath, project.id, projectsRoot);
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
 * Safely remove a newly created project directory during creation rollback.
 *
 * Safety checks (in order):
 * 1. Path is contained within PROJECTS_ROOT.
 * 2. Path contains no symlinks (via resolveProjectDir).
 * 3. Directory name matches the expected project ID prefix.
 * 4. Target is a real directory (not a file or symlink).
 *
 * Only after all checks pass is recursive removal attempted.
 *
 * @param {string} projectDir - Absolute path to the project directory
 * @param {number} expectedId - Expected project ID for ownership check
 * @param {string} projectsRoot - Absolute path to PROJECTS_ROOT
 */
function safeRemoveCreatedDir(projectDir, expectedId, projectsRoot) {
  // Step 1: Verify containment — reject paths that escape PROJECTS_ROOT
  const relPath = path.relative(projectsRoot, projectDir);
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    console.error(
      `[CreatorCrate] Rollback skipped — path escapes PROJECTS_ROOT: ` +
      `"${path.basename(projectDir)}"`
    );
    return;
  }

  // resolveProjectDir does additional safety checks (containment + symlinks)
  let resolved;
  try {
    resolved = resolveProjectDir(projectsRoot, relPath);
  } catch {
    // Directory doesn't exist or path is invalid — nothing to clean up
    return;
  }

  // Step 2: Verify directory ownership (ID prefix match)
  if (!verifyProjectDirOwnership(resolved, expectedId)) {
    console.error(
      `[CreatorCrate] Rollback skipped — directory "${path.basename(resolved)}" ` +
      `does not match expected ID ${expectedId}.`
    );
    return;
  }

  // Step 3: Verify it's a real directory, not a symlink
  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch {
    return; // Already gone
  }

  if (!stats.isDirectory()) {
    console.error(
      `[CreatorCrate] Rollback skipped — "${path.basename(resolved)}" ` +
      `is not a directory.`
    );
    return;
  }

  if (stats.isSymbolicLink()) {
    console.error(
      `[CreatorCrate] Rollback skipped — "${path.basename(resolved)}" ` +
      `is a symbolic link.`
    );
    return;
  }

  // Step 4: Recursively remove the directory tree
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[CreatorCrate] Rollback — failed to remove directory ` +
      `"${path.basename(resolved)}": ${err.message}`
    );
  }
}
