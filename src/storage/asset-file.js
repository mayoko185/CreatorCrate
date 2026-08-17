import fs from 'node:fs';
import path from 'node:path';
import { StorageError } from './path-manager.js';
import { resolveProjectDir } from './project-storage.js';

// ─── Safe contained-file resolver ───────────────────────────────────────
//
// Open an individual asset file inside a project directory with the same
// containment and symlink conventions used by resolveProjectDir, then
// validate the opened descriptor with fstat before returning it. The caller
// receives an already-opened read-only handle so it does not have to reopen
// the untrusted path.
//
// Race-safety limitations (documented):
//
// The pre-open `lstat` walk (checkSymlinks) inspects every existing path
// component from PROJECTS_ROOT down to the file's parent. This blocks
// symlink-escape vectors that exist *at check time*. It does NOT eliminate
// time-of-check/time-of-use (TOCTOU) races: a component could be replaced by
// a symlink between the lstat walk and the open() call. The strongest
// mitigation reasonably available in the current Node runtime is applied:
//
//   1. The file is opened with O_RDONLY (read-only) — write access is refused.
//   2. fstat() is run on the opened descriptor and the descriptor is rejected
//      if it is not a regular file (blocks symlinked files and directories).
//   3. The returned handle is the only thing later services read from; the
//      untrusted absolute path is not re-opened downstream.
//
// On platforms that lack a fully race-free openat-style path walk (every
// supported Node.js platform today), the residual TOCTOU window between
// checkSymlinks and fs.openSync cannot be closed from userland JavaScript.
// This module narrows that window as far as the runtime allows and rejects
// every tamper vector it can observe (symlinked intermediates, symlinked
// final file, non-regular descriptor, write access).

/**
 * Result of a successful openAssetFile call.
 *
 * The handle is an opened read-only file descriptor (fs.promises.FileHandle
 * or a number, depending on the runtime). Callers MUST invoke close() when
 * done, typically in a try/finally block.
 *
 * @typedef {Object} OpenedAssetFile
 * @property {number} handle        - Opened read-only file descriptor.
 * @property {string} absolutePath  - Validated absolute path. Not for route or
 *                                    template use; internal storage only.
 * @property {fs.Stats} stat        - fstat result from the opened descriptor.
 */

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/u;

/**
 * Normalize a stored project-relative asset path without touching the
 * filesystem. Stored asset paths use forward slashes; empty is valid only
 * when the caller is representing the project root. Dot and empty segments
 * are rejected instead of being collapsed into a different scope.
 *
 * @param {unknown} value
 * @param {{allowEmpty?: boolean}} [options]
 * @returns {string}
 * @throws {StorageError} when the value is not a canonical project-relative path
 */
export function normalizeProjectRelativePath(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new StorageError('Project-relative asset path must be a string.');
  }
  if (value.length === 0) {
    if (allowEmpty) return '';
    throw new StorageError('Project-relative asset path must not be empty.');
  }

  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(normalized)) {
    throw new StorageError('Project-relative asset path must not be absolute.');
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new StorageError('Project-relative asset path must not contain control characters.');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new StorageError('Project-relative asset path must not contain empty or dot segments.');
  }

  return segments.join('/');
}

/**
 * Resolve an asset-relative path beneath an already-validated project
 * directory, with full containment and symlink checks, WITHOUT opening the
 * file. Shared by {@link openAssetFile} (which opens the result read-only)
 * and by callers that only need to stat/mutate the path themselves (e.g.
 * the asset rename/move action service).
 *
 * Steps:
 *   1. Reject an absolute or empty asset relative path.
 *   2. Normalize the asset relative path and verify lexical containment
 *      within the project directory.
 *   3. Inspect every existing path component from the project directory down
 *      to the file with lstat and reject any symlink.
 *
 * @param {string} projectDir   - Already-resolved absolute project directory
 *                                 (e.g. via resolveProjectDir).
 * @param {string} assetRelPath - Relative path of the asset inside the
 *                                 project directory (e.g. "source/art.png").
 * @returns {string} Resolved, validated absolute path. Does not guarantee
 *   the path exists — callers that need existence must stat it themselves.
 * @param {object} [options]
 * @param {boolean} [options.checkFinalSymlink=true] - When false, the final
 *   path component's own symlink-ness is NOT checked here — only every
 *   intermediate directory component is. Set this to false when the caller
 *   needs to distinguish "leaf is a symlink" from other leaf conditions
 *   (missing, directory, non-regular) with its own dedicated lstat/error
 *   handling; intermediate-component safety is still fully enforced either
 *   way.
 * @throws {StorageError} on any containment or (checked) symlink failure.
 */
export function resolveContainedAssetPath(projectDir, assetRelPath, { checkFinalSymlink = true } = {}) {
  // 1. Reject an absolute or empty asset path.
  if (!assetRelPath || typeof assetRelPath !== 'string') {
    throw new StorageError('Asset path must be a non-empty relative path.');
  }
  if (path.isAbsolute(assetRelPath)) {
    throw new StorageError('Asset path must be relative to the project directory.');
  }

  // 2. Normalize and verify lexical containment within the project dir.
  //    path.normalize collapses ".." segments where possible but leaves a
  //    leading ".." if the path escapes; the containment check catches that.
  const normalizedAsset = path.normalize(assetRelPath);
  if (normalizedAsset === '.') {
    throw new StorageError('Asset path must not resolve to the project directory.');
  }
  // Reject a normalized path that is empty or starts with a traversal segment.
  const firstSeg = normalizedAsset.split(path.sep)[0];
  if (firstSeg === '..') {
    throw new StorageError('Asset path escapes the project directory.');
  }

  const resolvedAsset = path.resolve(projectDir, normalizedAsset);
  const relativeToProject = path.relative(projectDir, resolvedAsset);
  if (
    relativeToProject === '' ||
    relativeToProject.startsWith('..') ||
    path.isAbsolute(relativeToProject)
  ) {
    throw new StorageError('Asset path escapes the project directory.');
  }

  // 3. Inspect every existing path component from projectDir down to the file.
  //    Reject any symlink in the path (intermediate always; final unless
  //    the caller opted out via checkFinalSymlink: false).
  checkAssetSymlinks(projectDir, resolvedAsset, { skipFinal: !checkFinalSymlink });

  return resolvedAsset;
}

/**
 * Open an individual asset file inside a project directory with full
 * containment and symlink validation.
 *
 * Steps:
 *   1. Resolve and validate the project directory via resolveProjectDir
 *      (rejects absolute project paths, traversal, symlinked components).
 *   2. Reject an absolute or empty asset relative path.
 *   3. Normalize the asset relative path and verify lexical containment
 *      within the project directory.
 *   4. Inspect every existing path component from the project directory down
 *      to the file with lstat and reject any symlink.
 *   5. Open the final file read-only (O_RDONLY).
 *   6. Validate the opened descriptor with fstat — reject non-regular files.
 *
 * @param {string} projectsRoot   - Absolute path to configured PROJECTS_ROOT.
 * @param {string} projectRelPath- Trusted relative path of the project
 *                                  directory (e.g. "active/000042-my-project").
 * @param {string} assetRelPath   - Relative path of the asset inside the
 *                                  project directory (e.g. "source/art.png").
 * @returns {OpenedAssetFile}
 * @throws {StorageError} on any containment, symlink, or open failure.
 */
export function openAssetFile(projectsRoot, projectRelPath, assetRelPath) {
  // 1. Resolve and validate the project directory (containment + symlinks).
  const projectDir = resolveProjectDir(projectsRoot, projectRelPath);

  // 2-4. Resolve the asset path beneath it (containment + symlink checks).
  const resolvedAsset = resolveContainedAssetPath(projectDir, assetRelPath);

  // 5. Open the final file read-only.
  let fd;
  try {
    fd = fs.openSync(resolvedAsset, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new StorageError('Asset file does not exist.');
    }
    if (err.code === 'EACCES') {
      throw new StorageError('Asset file cannot be read.');
    }
    if (err.code === 'EISDIR') {
      throw new StorageError('Asset path is a directory, not a file.');
    }
    throw new StorageError('Asset file cannot be opened.');
  }

  // 6. Validate the opened descriptor with fstat. This runs on the descriptor,
  //    not on the path, so it reflects the file we actually opened. Reject
  //    non-regular files (covers symlinked final file and any oddity).
  let stat;
  try {
    stat = fs.fstatSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    throw new StorageError('Opened asset descriptor cannot be stat.');
  }

  if (!stat.isFile()) {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    throw new StorageError('Asset path does not point to a regular file.');
  }

  return { handle: fd, absolutePath: resolvedAsset, stat };
}

/**
 * Close an opened asset file handle. Safe to call with null/undefined.
 * @param {OpenedAssetFile|null|undefined} opened
 */
export function closeAssetFile(opened) {
  if (!opened || opened.handle == null) return;
  try {
    fs.closeSync(opened.handle);
  } catch {
    // Closing an already-closed or invalid descriptor is a no-op best effort.
  }
}

/**
 * Walk each existing path component from the project directory to the target
 * file and refuse any symlink. Mirrors checkSymlinks in project-storage.js
 * but starts from the project directory (which resolveProjectDir already
 * validated) rather than PROJECTS_ROOT.
 *
 * @param {string} projectDir - Validated absolute project directory.
 * @param {string} target     - Absolute target file path.
 * @param {object} [options]
 * @param {boolean} [options.skipFinal=false] - When true, the final path
 *   component (the target itself) is walked past without an lstat/symlink
 *   check — only its intermediate ancestors are checked. The caller is then
 *   responsible for inspecting the leaf itself.
 * @throws {StorageError} if any existing (checked) component is a symbolic link.
 */
function checkAssetSymlinks(projectDir, target, { skipFinal = false } = {}) {
  const relative = path.relative(projectDir, target);
  if (relative === '') return;

  // Normalize separators so mixed-separator input ("a\\b/../c") is split
  // consistently on this platform.
  const parts = relative.split(path.sep);
  let current = projectDir;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '') continue;
    current = path.join(current, part);
    if (skipFinal && i === parts.length - 1) continue;
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw new StorageError(
          'Asset path contains a symbolic link.'
        );
      }
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (err.code === 'ENOENT') return; // further components can't be vectors
      throw new StorageError('Asset path component cannot be accessed.');
    }
  }
}
