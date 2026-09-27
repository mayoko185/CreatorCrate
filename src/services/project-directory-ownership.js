/**
 * Canonical project-directory ownership verification (PM-1B).
 *
 * An ownership-sensitive project-root operation is authorized only when ALL
 * of the following hold. Ownership-sensitive means it either mutates
 * project-root filesystem state (directory rename, project deletion, category
 * directory creation/removal, asset rename/move/copy/delete, processing
 * execution, Auto Rename) or reads project-root content and then changes
 * CreatorCrate SQLite authority from those bytes (asset scan, source
 * animation/generation reconciliation, Krita-merged primary-image
 * eligibility). Pure read-only source serving is deliberately not gated.
 *
 *   - the project's `project_directory_ownership` row exists and is `bound`;
 *   - the stored `project_dir` resolves safely (direct child of
 *     PROJECTS_ROOT, no symlink components, carries the project-ID prefix)
 *     to a real, non-symlink directory;
 *   - that directory's `.creatorcrate-owner` marker safely parses and its
 *     token exactly matches the SQLite token.
 *
 * The marker witnesses logical project association, not physical inode
 * identity: nothing here persists or compares a stored dev/ino. Callers may
 * still use the returned operation-local identity for continuity checks
 * during a single mutation. Verification happens once per project per logical
 * operation (see `beginOperation`), never once per file, and a verified
 * result is never cached beyond that operation.
 *
 * Nothing here repairs, rewrites, creates, or binds anything, and a legacy
 * `project.json` is never consulted. Metadata-only operations must not call
 * this — they stay SQLite-only.
 */
import fs from 'node:fs';
import { resolveProjectDir, verifyProjectDirOwnership } from '../storage/project-storage.js';
import { verifyProjectOwnershipMarker } from '../storage/project-ownership-marker.js';

export const PROJECT_OWNERSHIP_ERROR_CODES = Object.freeze([
  'UNBOUND',
  'PROJECT_DIRECTORY_INVALID',
  'PROJECT_DIRECTORY_MISSING',
  'PROJECT_DIRECTORY_UNREADABLE',
  'MARKER_MISSING',
  'MARKER_MALFORMED',
  'MARKER_UNSAFE',
  'MARKER_UNREADABLE',
  'MARKER_MISMATCH',
  'IDENTITY_CHANGED',
]);

const MESSAGES = {
  UNBOUND: 'Project directory ownership is not established for this project. '
    + 'Its folder cannot be changed until ownership is established.',
  PROJECT_DIRECTORY_INVALID: 'Project directory ownership verification failed.',
  PROJECT_DIRECTORY_MISSING: 'Project directory not found.',
  PROJECT_DIRECTORY_UNREADABLE: 'Cannot access project directory.',
  MARKER_MISSING: 'Project directory ownership marker is missing.',
  MARKER_MALFORMED: 'Project directory ownership marker is invalid.',
  MARKER_UNSAFE: 'Project directory ownership marker is not a safe file.',
  MARKER_UNREADABLE: 'Project directory ownership marker cannot be read.',
  MARKER_MISMATCH: 'Project directory belongs to a different project.',
  IDENTITY_CHANGED: 'Project directory changed during the operation.',
};

/**
 * Raised when ownership of a project directory cannot be proven. Messages
 * never contain absolute paths. `status` is a 4xx so the generic handler
 * reports the message: the request conflicts with on-disk state.
 */
export class ProjectOwnershipError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.PROJECT_DIRECTORY_INVALID) {
    super(message);
    this.name = 'ProjectOwnershipError';
    this.code = code;
    this.status = 409;
  }
}

const MARKER_STATUS_CODES = {
  missing: 'MARKER_MISSING',
  malformed: 'MARKER_MALFORMED',
  unsafe: 'MARKER_UNSAFE',
  unreadable: 'MARKER_UNREADABLE',
  mismatch: 'MARKER_MISMATCH',
};

/**
 * Confirm that the directory at `dirPath` carries a marker for `token`.
 * Used both by {@link createProjectDirectoryOwnershipVerifier} and to
 * re-verify a directory after this operation moved it (rename destination,
 * deletion quarantine). `dirPath` must already be a path this operation
 * derived safely; it is never caller-supplied request input.
 *
 * @throws {ProjectOwnershipError}
 */
export function assertProjectOwnershipMarker(dirPath, token) {
  const result = verifyProjectOwnershipMarker(dirPath, token);
  if (result.status === 'match') return;
  // The marker reader reports a missing/non-directory project dir as unsafe.
  if (result.status === 'unsafe' && result.reason === 'project-directory-missing') {
    throw new ProjectOwnershipError('PROJECT_DIRECTORY_MISSING');
  }
  if (result.status === 'unsafe' && result.reason === 'project-directory-not-directory') {
    throw new ProjectOwnershipError('PROJECT_DIRECTORY_INVALID', 'Project directory is not a safe directory.');
  }
  throw new ProjectOwnershipError(MARKER_STATUS_CODES[result.status] ?? 'MARKER_UNREADABLE');
}

/**
 * Whether an operation-local identity can prove continuity at all. SMB and
 * similar shares may report no usable file ID (`ino` 0), and a numeric `ino`
 * beyond 2^53 has lost precision; two such values can compare equal for
 * different directories, so they are "unknown", never positive proof.
 *
 * @param {{ dev: number|bigint, ino: number|bigint }|null|undefined} identity
 * @returns {boolean}
 */
export function isKnownDirectoryIdentity(identity) {
  if (!identity) return false;
  const { ino } = identity;
  if (typeof ino === 'bigint') return ino > 0n;
  return Number.isSafeInteger(ino) && ino > 0;
}

/**
 * Operation-local continuity: the directory at `dirPath` is still the same
 * real directory (dev/ino) this operation verified. Never persisted.
 *
 * On its own this proves nothing when the identity is unknown (see
 * {@link isKnownDirectoryIdentity}); callers relying on continuity must pair
 * it with a marker check, or use the verifier's `assertContinuity`.
 *
 * @throws {ProjectOwnershipError} code IDENTITY_CHANGED
 */
export function assertSameDirectory(dirPath, identity) {
  let stats;
  try {
    stats = fs.lstatSync(dirPath);
  } catch {
    throw new ProjectOwnershipError('IDENTITY_CHANGED');
  }
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
  ) {
    throw new ProjectOwnershipError('IDENTITY_CHANGED');
  }
}

// Operation handles minted by a canonical verifier. Membership lets a
// service accept a handle from its caller (queued Rename planning, a
// presentation policy) without trusting an arbitrary object as a witness.
const OPERATIONS = new WeakSet();

/** @returns {boolean} whether `value` is an operation handle from {@link createProjectDirectoryOwnershipVerifier} */
export function isProjectOwnershipOperation(value) {
  return OPERATIONS.has(value);
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/project-directory-ownership-repository.js').createProjectDirectoryOwnershipRepository>} deps.ownershipRepository
 * @param {string|null} deps.projectsRoot - Absent roots fail every verification.
 */
export function createProjectDirectoryOwnershipVerifier({ ownershipRepository, projectsRoot } = {}) {
  if (!ownershipRepository || typeof ownershipRepository.findByProjectId !== 'function') {
    throw new Error('createProjectDirectoryOwnershipVerifier requires an ownershipRepository dependency.');
  }

  const verifier = {
    /**
     * Start one logical operation (a batch mutation, a scan, one processing
     * execution, one Preview or one Apply). The handle verifies each distinct
     * project at most once and then reuses that result — so N files in one
     * batch cost one marker read, not N.
     *
     * The handle is operation-local by construction: callers create it at
     * the operation boundary and drop it when the operation ends. It has no
     * TTL and is never stored on a service, carried across requests, plans,
     * queued executions, or application rebuilds; a later operation starts a
     * new handle and verifies again. A failed verification is not
     * remembered, so a retry inside the same operation re-reads.
     */
    beginOperation() {
      const verified = new Map();
      const operation = Object.freeze({
        /** Same contract as {@link verifier.verifyProject}. */
        verifyProject(project) {
          const prior = verified.get(project.id);
          if (prior && prior.relPath === project.project_dir) return prior;
          const result = verifier.verifyProject(project);
          verified.set(project.id, result);
          return result;
        },
      });
      OPERATIONS.add(operation);
      return operation;
    },

    /**
     * Resolve `operation` when it is a genuine handle, else begin a new one.
     * Anything that is not a canonical handle is ignored, never trusted.
     */
    operationFor(operation) {
      return isProjectOwnershipOperation(operation) ? operation : verifier.beginOperation();
    },

    /**
     * Prove that the project's stored directory is its bound, marked
     * project root.
     *
     * @param {{ id: number, project_dir: string|null }} project - current DB row
     * @returns {{ absPath: string, relPath: string, token: string, identity: { dev: number, ino: number } }}
     * @throws {ProjectOwnershipError}
     */
    verifyProject(project) {
      const binding = ownershipRepository.findByProjectId(project.id);
      if (!binding || binding.state !== 'bound') {
        throw new ProjectOwnershipError('UNBOUND');
      }

      if (!project.project_dir) {
        throw new ProjectOwnershipError('PROJECT_DIRECTORY_INVALID', 'Project has no stored directory path.');
      }
      if (!projectsRoot) {
        throw new ProjectOwnershipError('PROJECT_DIRECTORY_INVALID', 'Projects root is not configured.');
      }
      let absPath;
      try {
        absPath = resolveProjectDir(projectsRoot, project.project_dir);
      } catch (err) {
        // StorageError messages carry basenames only, never absolute paths.
        throw new ProjectOwnershipError('PROJECT_DIRECTORY_INVALID', err.message);
      }
      if (!verifyProjectDirOwnership(absPath, project.id)) {
        throw new ProjectOwnershipError('PROJECT_DIRECTORY_INVALID');
      }

      let stats;
      try {
        stats = fs.lstatSync(absPath);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          throw new ProjectOwnershipError('PROJECT_DIRECTORY_MISSING');
        }
        throw new ProjectOwnershipError('PROJECT_DIRECTORY_UNREADABLE');
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ProjectOwnershipError('PROJECT_DIRECTORY_INVALID', 'Project directory is not a safe directory.');
      }

      assertProjectOwnershipMarker(absPath, binding.token);
      assertSameDirectory(absPath, { dev: stats.dev, ino: stats.ino });

      return {
        absPath,
        relPath: project.project_dir,
        token: binding.token,
        identity: { dev: stats.dev, ino: stats.ino },
      };
    },

    /**
     * Prove, after work done since {@link verifier.verifyProject} (e.g. a
     * scan's traversal), that the project root is still the verified one.
     * A trustworthy operation-local identity is compared directly. An
     * unknown identity (SMB without file IDs) proves nothing, so ownership
     * is re-established with the canonical verifier instead: same binding
     * token, same stored path, bound row, matching marker. One extra marker
     * read per operation, never per file.
     *
     * @param {{ id: number, project_dir: string|null }} project - current DB row
     * @param {ReturnType<typeof verifier.verifyProject>} verified - earlier result
     * @throws {ProjectOwnershipError}
     */
    assertContinuity(project, verified) {
      if (isKnownDirectoryIdentity(verified.identity)) {
        assertSameDirectory(verified.absPath, verified.identity);
        return;
      }
      const current = verifier.verifyProject(project);
      if (current.relPath !== verified.relPath
        || current.absPath !== verified.absPath
        || current.token !== verified.token) {
        throw new ProjectOwnershipError('IDENTITY_CHANGED');
      }
    },
  };
  return verifier;
}
