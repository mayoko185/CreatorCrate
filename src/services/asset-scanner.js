import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectDir } from '../storage/project-storage.js';
import { ProjectNotFoundError } from './project-service.js';
import { createAssetRepository } from '../data/asset-repository.js';

/**
 * MIME type mapping by file extension.
 * Only known asset types are mapped; everything else is application/octet-stream.
 */
const EXTENSION_MIME_MAP = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  kra: 'application/x-krita',
  krz: 'application/x-krita',
};

/**
 * Files to skip during scanning.
 * These are managed by CreatorCrate itself and should not be indexed as assets.
 */
const SKIP_FILENAMES = new Set([
  'project.json',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/**
 * Check if a filename is a temporary manifest file (e.g., .{hex}.project.json.tmp).
 */
function isTempManifest(name) {
  return /^\.[0-9a-f]+\.project\.json\.tmp$/.test(name);
}

/**
 * Categorize a filesystem error to determine how to handle it.
 * @param {NodeJS.ErrnoException} err
 * @returns {'enoent' | 'access' | 'other'} - ENOENT means file disappeared (mark missing),
 *   access means permission error (abort reconciliation), other means unexpected error (abort).
 */
function categorizeFsError(err) {
  if (err.code === 'ENOENT') return 'enoent';
  if (err.code === 'EACCES' || err.code === 'EPERM') return 'access';
  return 'other';
}

/**
 * Map a file extension to its MIME type.
 * @param {string} ext - Extension without the leading dot, lowercased
 * @returns {string}
 */
function mimeFromExtension(ext) {
  return EXTENSION_MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * Classify a file type for display purposes.
 * @param {string} ext
 * @returns {string}
 */
function classifyType(ext) {
  if (['png', 'webp', 'jpg', 'jpeg', 'gif'].includes(ext)) return 'image';
  if (['kra', 'krz'].includes(ext)) return 'krita';
  return 'unknown';
}

/**
 * Recursively walk a directory and collect file metadata.
 * Returns only relative paths and metadata — no absolute paths stored.
 * Throws on permission/traversal errors to prevent false missing states.
 *
 * @param {string} dirPath - Absolute path to the directory to scan
 * @param {string} projectRelPrefix - Relative path prefix (empty string for root)
 * @throws {Error} if a permission or I/O error occurs during traversal
 * @returns {Array<{relativePath: string, filename: string, extension: string, mimeType: string, sizeBytes: number, modifiedAt: string|null}>}
 */
function walkDirectory(dirPath, projectRelPrefix = '') {
  const entries = [];
  const isRoot = projectRelPrefix === '';

  let dirEntries;
  try {
    dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    const cat = categorizeFsError(err);
    if (cat === 'enoent') {
      // Directory disappeared between scan start and read — treat as empty
      return entries;
    }
    // Permission or I/O error — abort reconciliation, do not mutate asset presence
    const rel = projectRelPrefix || dirPath;
    throw new Error(`Cannot read directory "${rel}": ${err.code || err.message}`);
  }

  for (const entry of dirEntries) {
    // Skip dotfiles at root level (hidden OS files in project root)
    if (isRoot && entry.name.startsWith('.')) {
      continue;
    }

    // Skip ignored files
    if (SKIP_FILENAMES.has(entry.name)) {
      continue;
    }

    // Skip temp manifest files
    if (isTempManifest(entry.name)) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden directories (like .git, .svn)
      if (entry.name.startsWith('.')) {
        continue;
      }

      // Skip symlink directories to prevent traversing outside project root
      let dirStats;
      try {
        dirStats = fs.lstatSync(fullPath);
      } catch (err) {
        const cat = categorizeFsError(err);
        if (cat === 'enoent') {
          // Symlink target disappeared — skip
          continue;
        }
        // Permission or I/O error — abort
        throw new Error(`Cannot stat directory "${fullPath}": ${err.code || err.message}`);
      }
      if (dirStats.isSymbolicLink()) {
        continue;
      }

      // Recurse into subdirectories
      const relSubDir = projectRelPrefix ? `${projectRelPrefix}/${entry.name}` : entry.name;
      const subEntries = walkDirectory(fullPath, relSubDir);
      entries.push(...subEntries);
    } else if (entry.isFile()) {
      // Skip symlinks — only index real files
      let fileStats;
      try {
        fileStats = fs.lstatSync(fullPath);
      } catch (err) {
        const cat = categorizeFsError(err);
        if (cat === 'enoent') {
          // Symlink target disappeared — skip
          continue;
        }
        // Permission or I/O error — abort
        throw new Error(`Cannot stat file "${fullPath}": ${err.code || err.message}`);
      }
      if (fileStats.isSymbolicLink()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase().replace('.', '');
      const filename = entry.name;

      let relativePath;
      if (projectRelPrefix) {
        relativePath = `${projectRelPrefix}/${filename}`;
      } else {
        relativePath = filename;
      }

      let sizeBytes = 0;
      let modifiedAt = null;
      try {
        const stats = fs.statSync(fullPath);
        sizeBytes = stats.size;
        modifiedAt = stats.mtime.toISOString();
      } catch (err) {
        const cat = categorizeFsError(err);
        if (cat === 'enoent') {
          // File disappeared between readdir and stat — skip this file
          continue;
        }
        // Permission or I/O error — abort (do not mark file as missing incorrectly)
        throw new Error(`Cannot read file "${fullPath}": ${err.code || err.message}`);
      }

      entries.push({
        relativePath,
        filename,
        extension: ext,
        mimeType: mimeFromExtension(ext),
        sizeBytes,
        modifiedAt,
      });
    }
  }

  return entries;
}

/**
 * Create an asset scanner service.
 *
 * Responsibilities:
 * - Accept a project and resolve its directory safely.
 * - Recursively scan files (ignoring CreatorCrate metadata files).
 * - Compare discovered files with existing database records.
 * - Insert new files, update changed files, remove stale records.
 * - Return a scan summary with counts.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectsRoot
 * @param {object} deps
 * @param {import('../services/project-service.js').ProjectService} deps.projectService
 */
export function createAssetScanner(db, projectsRoot, { projectService }) {
  const repository = createAssetRepository(db);

  /**
   * Scan a project's directory and sync the asset index.
   *
   * @param {number} projectId
   * @returns {{ added: number, updated: number, removed: number, total: number }}
   * @throws {ProjectNotFoundError} if the project is unknown
   * @throws {Error} if the project directory is missing or unsafe
   */
  function scanProjectAssets(projectId) {
    const project = projectService.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    if (!project.project_dir) {
      throw new Error('Project has no stored directory path.');
    }

    // Resolve the project directory safely (containment + symlink checks)
    let absPath;
    try {
      absPath = resolveProjectDir(projectsRoot, project.project_dir);
    } catch (err) {
      throw new Error('Project directory cannot be accessed.');
    }

    // Verify the directory exists
    let stats;
    try {
      stats = fs.lstatSync(absPath);
    } catch {
      throw new Error('Project directory not found on disk.');
    }

    if (!stats.isDirectory()) {
      throw new Error('Project path exists but is not a directory.');
    }

    if (stats.isSymbolicLink()) {
      throw new Error('Project directory is a symbolic link.');
    }

    // Walk the directory and collect file metadata
    // Throws on permission/I/O errors to prevent false missing states
    let discovered;
    try {
      discovered = walkDirectory(absPath);
    } catch (err) {
      // Rethrow with a safe message (no path leakage)
      throw new Error('Project directory cannot be scanned.');
    }

    // Discover present paths and restore any that were previously missing
    const discoveredPaths = discovered.map((d) => d.relativePath);

    // Restore any previously-missing assets that are now present
    repository.restorePresent(projectId, discoveredPaths);

    // Find new/changed files
    let added = 0;
    let updated = 0;

    for (const file of discovered) {
      const existing = repository.findByProjectIdAndPath(projectId, file.relativePath);
      if (!existing) {
        // New file
        repository.upsert(projectId, file.relativePath, file);
        added++;
      } else if (
        existing.is_present === 0 ||
        existing.size_bytes !== file.sizeBytes ||
        existing.modified_at !== file.modifiedAt
      ) {
        // File was missing and is back, or content changed
        repository.upsert(projectId, file.relativePath, file);
        updated++;
      }
    }

    // Mark records as missing for files that no longer exist on disk
    const removed = repository.markMissingByProjectIdAndPathNotIn(projectId, discoveredPaths);

    const total = repository.countByProjectId(projectId);

    return { added, updated, removed, total };
  }

  /**
   * List assets for a project with optional filtering.
   * @param {number} projectId
   * @param {object} [options]
   * @param {string} [options.extension]
   * @param {string} [options.search]
   * @param {string} [options.sortBy]
   * @param {string} [options.order]
   * @returns {Array}
   */
  function listProjectAssets(projectId, options = {}) {
    return repository.findByProjectId(projectId, options);
  }

  /**
   * Get asset counts for a project (present, missing, total).
   * @param {number} projectId
   * @returns {{ present: number, missing: number, total: number }}
   */
  function getAssetCounts(projectId) {
    const all = repository.findByProjectId(projectId);
    const present = all.filter((a) => a.is_present === 1).length;
    const missing = all.filter((a) => a.is_present === 0).length;
    return { present, missing, total: all.length };
  }

  /**
   * Get distinct extensions for a project's assets.
   * @param {number} projectId
   * @returns {string[]}
   */
  function getExtensionList(projectId) {
    return repository.getExtensions(projectId);
  }

  /**
   * Get total asset count across all projects.
   * @returns {number}
   */
  function getTotalAssetCount() {
    return repository.getTotalCount();
  }

  return {
    repository,
    scanProjectAssets,
    classifyType,
    listProjectAssets,
    getAssetCounts,
    getExtensionList,
    getTotalAssetCount,
  };
}
