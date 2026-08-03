import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveContainedAssetPath } from '../storage/asset-file.js';
import { resolveProjectDir } from '../storage/project-storage.js';
import { ProjectOperationError } from './project-operation-coordinator.js';
import { validateAssetFilename } from './asset-filename-validation.js';
import { validateDirectorySlug } from './asset-category-validation.js';
import { deriveExtensionFromFilename, mimeFromExtension } from './asset-metadata.js';

export const AUTO_RENAME_PLAN_VERSION = 1;
export const AUTO_RENAME_NAMING_POLICY_VERSION = 2;
export const AUTO_RENAME_MAX_RELATIVE_PATH_BYTES = 4096;

export const AUTO_RENAME_ERROR_CODES = Object.freeze({
  INVALID_PROJECT_ID: 'INVALID_PROJECT_ID',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  CATEGORY_REQUIRED: 'CATEGORY_REQUIRED',
  CATEGORY_INVALID: 'CATEGORY_INVALID',
  CATEGORY_DISABLED: 'CATEGORY_DISABLED',
  CATEGORY_EMPTY: 'CATEGORY_EMPTY',
  PROJECT_BUSY: 'PROJECT_BUSY',
  PROJECT_DIRECTORY_UNSAFE: 'PROJECT_DIRECTORY_UNSAFE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  FILESYSTEM_INSPECTION_FAILED: 'FILESYSTEM_INSPECTION_FAILED',
  FILESYSTEM_OPERATION_FAILED: 'FILESYSTEM_OPERATION_FAILED',
  SIGNING_FAILED: 'SIGNING_FAILED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  ORDER_INVALID: 'ORDER_INVALID',
  STALE_PLAN: 'STALE_PLAN',
  PLAN_BLOCKED: 'PLAN_BLOCKED',
  NO_CHANGES: 'NO_CHANGES',
  AUTO_RENAME_FAILED: 'AUTO_RENAME_FAILED',
  AUTO_RENAME_RECOVERY_REQUIRED: 'AUTO_RENAME_RECOVERY_REQUIRED',
});

const TOKEN_PREFIX = 'cc-auto-rename-h1';

export class AutoRenameError extends Error {
  constructor(message, { code, cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AutoRenameError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

class AutoRenameInspectionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AutoRenameInspectionError';
    this.code = code;
  }
}

function assertCanonicalPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AutoRenameError(
      `${field} must be a positive integer.`,
      { code: AUTO_RENAME_ERROR_CODES.INVALID_PROJECT_ID }
    );
  }
}

function categoryRequiredError() {
  return new AutoRenameError(
    'A concrete category is required for Auto Rename.',
    { code: AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED }
  );
}

function categoryInvalidError() {
  return new AutoRenameError(
    'The Auto Rename category is invalid or does not belong to the project.',
    { code: AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID }
  );
}

function categoryDisabledError() {
  return new AutoRenameError(
    'The Auto Rename category is disabled.',
    { code: AUTO_RENAME_ERROR_CODES.CATEGORY_DISABLED }
  );
}

function categoryEmptyError() {
  return new AutoRenameError(
    'The Auto Rename category contains no assets.',
    { code: AUTO_RENAME_ERROR_CODES.CATEGORY_EMPTY }
  );
}

function categoryOrderInvalidError() {
  return new AutoRenameError(
    'Ordered asset IDs must be an exact permutation of the complete category.',
    { code: AUTO_RENAME_ERROR_CODES.ORDER_INVALID }
  );
}

function sortedAssetIds(assetIds) {
  return [...assetIds].sort((a, b) => a - b);
}

function assetIdArraysEqual(left, right) {
  return left.length === right.length && left.every((assetId, index) => assetId === right[index]);
}

function assertExactCategoryPermutation(orderedAssetIds, membershipAssetIds) {
  if (!Array.isArray(orderedAssetIds) || orderedAssetIds.length === 0) {
    throw categoryOrderInvalidError();
  }
  if (orderedAssetIds.length !== membershipAssetIds.length) {
    throw categoryOrderInvalidError();
  }

  const membership = new Set(membershipAssetIds);
  if (membership.size !== membershipAssetIds.length) throw categoryOrderInvalidError();

  const seen = new Set();
  for (const assetId of orderedAssetIds) {
    if (!Number.isSafeInteger(assetId) || assetId <= 0 || !membership.has(assetId) || seen.has(assetId)) {
      throw categoryOrderInvalidError();
    }
    seen.add(assetId);
  }

  if (seen.size !== membership.size) throw categoryOrderInvalidError();
  return [...orderedAssetIds];
}

function isPresent(asset) {
  return asset && (asset.is_present === 1 || asset.is_present === true);
}

function normalizeNfc(value) {
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function collisionKey(value) {
  return normalizeNfc(value).replace(/[\\/]+/g, '/').toLowerCase();
}

function sourceIdentityFromStats(stats) {
  return {
    dev: typeof stats.dev === 'number' && Number.isFinite(stats.dev) ? stats.dev : null,
    ino: typeof stats.ino === 'number' && Number.isFinite(stats.ino) ? stats.ino : null,
    birthtimeMs: typeof stats.birthtimeMs === 'number' && Number.isFinite(stats.birthtimeMs)
      ? stats.birthtimeMs
      : null,
  };
}

function sourceIdentityMatches(expected, stats) {
  if (!expected) return true;
  const actual = sourceIdentityFromStats(stats);
  if (expected.dev !== undefined && expected.dev !== null && expected.dev !== actual.dev) return false;
  if (expected.ino !== undefined && expected.ino !== null && expected.ino !== actual.ino) return false;
  if (
    expected.birthtimeMs !== undefined
    && expected.birthtimeMs !== null
    && expected.birthtimeMs !== actual.birthtimeMs
  ) return false;
  return true;
}

function isAbsoluteLike(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsoluteLike(value)) return null;
  return value;
}

function relativeDirectory(relativePath) {
  const directory = path.posix.dirname(relativePath);
  return directory === '.' ? '' : directory;
}

function relativeBasename(relativePath) {
  return path.posix.basename(relativePath);
}

function exactExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot) : '';
}

function makeRelativePath(directory, filename) {
  return directory ? `${directory}/${filename}` : filename;
}

function isControlCharacter(value) {
  return /\p{Cc}/u.test(value);
}

function validateGeneratedFilename(filename) {
  const existingError = validateAssetFilename(filename);
  if (existingError) return existingError;
  if (isControlCharacter(filename)) return 'Generated filename must not contain control characters.';
  return null;
}

function isCategoryEnabled(value) {
  return value === 1 || value === true;
}

function isValidCategoryDirectorySlug(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.normalize('NFC') !== value) return false;
  return validateDirectorySlug(value) === null && validateAssetFilename(value) === null;
}

function categoryStateFromRecord(category) {
  if (!category || !Number.isSafeInteger(category.id) || category.id <= 0) return null;
  if (!Number.isSafeInteger(category.project_id) || category.project_id <= 0) return null;
  if (typeof category.display_name !== 'string') return null;
  if (!Number.isSafeInteger(category.display_order)) return null;
  if (!isValidCategoryDirectorySlug(category.directory_slug)) return null;

  return {
    id: category.id,
    projectId: category.project_id,
    displayName: category.display_name,
    directorySlug: category.directory_slug,
    displayOrder: category.display_order,
    enabled: isCategoryEnabled(category.enabled),
  };
}

function normalizeCategorySnapshotState(category) {
  if (!category || typeof category !== 'object' || Array.isArray(category)) return null;
  if (!Number.isSafeInteger(category.id) || category.id <= 0) return null;
  if (!Number.isSafeInteger(category.projectId) || category.projectId <= 0) return null;
  if (typeof category.displayName !== 'string') return null;
  if (!Number.isSafeInteger(category.displayOrder)) return null;
  if (typeof category.enabled !== 'boolean') return null;
  if (!isValidCategoryDirectorySlug(category.directorySlug)) return null;

  return {
    id: category.id,
    projectId: category.projectId,
    displayName: category.displayName,
    directorySlug: category.directorySlug,
    displayOrder: category.displayOrder,
    enabled: category.enabled,
  };
}

function categoryStatesEqual(left, right) {
  return Boolean(left && right)
    && left.id === right.id
    && left.projectId === right.projectId
    && left.displayName === right.displayName
    && left.directorySlug === right.directorySlug
    && left.displayOrder === right.displayOrder
    && left.enabled === right.enabled;
}

function categoryBlockReason(projectId, asset) {
  if (!asset) return null;
  if (asset.category_id === null || asset.category_id === undefined) return 'uncategorized';
  if (asset.category_record_id !== asset.category_id || asset.category_project_id !== projectId) {
    return 'category-unavailable';
  }
  if (!isCategoryEnabled(asset.category_enabled)) return 'category-disabled';
  if (!isValidCategoryDirectorySlug(asset.category_directory_slug)) return 'invalid-category';
  return null;
}

function validateProjectSlugComponent(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return false;
  const normalized = normalizeNfc(slug);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.includes('/')
    || normalized.includes('\\')
    || normalized !== normalized.trim()
    || normalized.endsWith('.')
    || isControlCharacter(normalized)
  ) {
    return false;
  }

  // Project slugs are generated components, not arbitrary display names. Keep
  // Unicode letters/numbers while rejecting spaces and punctuation that could
  // make the assembled filename ambiguous or unsafe.
  return /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u.test(normalized);
}

function createItem(assetId, asset) {
  const rawRelativePath = asset && typeof asset.relative_path === 'string'
    ? asset.relative_path
    : null;
  const currentRelativePath = safeRelativePath(rawRelativePath);
  const currentFilename = currentRelativePath ? relativeBasename(currentRelativePath) : null;
  const directory = currentRelativePath ? relativeDirectory(currentRelativePath) : null;
  const extension = asset?.extension ?? null;
  const mimeType = asset?.mime_type ?? null;
  const sizeBytes = asset?.size_bytes ?? null;
  const modifiedAt = asset?.modified_at ?? null;
  const databaseFilename = asset?.filename ?? null;
  const categoryId = asset?.category_id ?? null;
  const categoryEnabled = asset?.category_enabled === null || asset?.category_enabled === undefined
    ? null
    : isCategoryEnabled(asset.category_enabled);

  return {
    assetId,
    currentRelativePath,
    proposedRelativePath: null,
    currentFilename,
    proposedFilename: null,
    directory,
    status: 'pending',
    reason: null,
    // These fields are part of the immutable plan snapshot. They are kept on
    // the item so H2 can verify a submitted token without trusting form data.
    presenceState: isPresent(asset) ? 'present' : 'missing',
    sizeBytes,
    modifiedAt,
    modifiedTime: modifiedAt,
    databaseFilename,
    categoryId,
    categoryDisplayName: asset?.category_display_name ?? null,
    categoryDirectorySlug: asset?.category_directory_slug ?? null,
    categoryEnabled,
    categoryRecordId: asset?.category_record_id ?? null,
    categoryProjectId: asset?.category_project_id ?? null,
    databaseCategoryId: categoryId,
    databaseNestedPath: asset?.nested_path ?? '',
    databaseSizeBytes: sizeBytes,
    databaseModifiedAt: modifiedAt,
    extension,
    mimeType,
    filename: currentFilename,
    size_bytes: sizeBytes,
    modified_at: modifiedAt,
    sourceIdentity: null,
  };
}

function block(item, reason) {
  item.status = 'blocked';
  item.reason = reason;
  item.proposedRelativePath = null;
  item.proposedFilename = null;
  return item;
}

function inspectSource(projectDir, item, asset) {
  if (!isPresent(asset)) {
    return { ok: false, reason: 'missing' };
  }
  if (!item.currentRelativePath || !item.currentFilename || item.directory === null) {
    return { ok: false, reason: 'unsupported-source' };
  }

  let sourceAbsPath;
  try {
    sourceAbsPath = resolveContainedAssetPath(
      projectDir,
      item.currentRelativePath,
      { checkFinalSymlink: false }
    );
  } catch {
    return { ok: false, reason: 'unsupported-source' };
  }

  let stats;
  try {
    stats = fs.lstatSync(sourceAbsPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    if (err.code === 'ENOTDIR') return { ok: false, reason: 'unsupported-source' };
    throw new AutoRenameInspectionError(AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED);
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { ok: false, reason: 'unsupported-source' };
  }

  const modifiedAt = stats.mtime.toISOString();
  item.presenceState = 'present';
  item.sizeBytes = stats.size;
  item.modifiedAt = modifiedAt;
  item.modifiedTime = modifiedAt;
  item.size_bytes = stats.size;
  item.modified_at = modifiedAt;
  item.sourceIdentity = sourceIdentityFromStats(stats);

  return {
    ok: true,
    sourceAbsPath,
    sourceKey: collisionKey(item.currentRelativePath),
    stats,
    sourceIdentity: item.sourceIdentity,
  };
}

function generateName(projectSlug, candidate, sequence, width, projectDir) {
  if (!validateProjectSlugComponent(projectSlug)) {
    return { ok: false };
  }

  const normalizedSlug = normalizeNfc(projectSlug);
  const stem = `${normalizedSlug}-${candidate.item.categoryDirectorySlug}-${String(sequence).padStart(width, '0')}`
    .normalize('NFC');
  const filename = `${stem}${candidate.extension}`.normalize('NFC');
  const filenameError = validateGeneratedFilename(filename);
  if (filenameError) return { ok: false };

  const proposedRelativePath = makeRelativePath(candidate.directory, filename);
  if (Buffer.byteLength(proposedRelativePath, 'utf8') > AUTO_RENAME_MAX_RELATIVE_PATH_BYTES) {
    return { ok: false };
  }

  try {
    resolveContainedAssetPath(projectDir, proposedRelativePath, { checkFinalSymlink: false });
  } catch {
    return { ok: false };
  }

  return {
    ok: true,
    filename,
    relativePath: proposedRelativePath,
    key: collisionKey(proposedRelativePath),
  };
}

function assignGeneratedNames(candidates, projectSlug, projectDir) {
  const groups = new Map();
  for (const candidate of candidates) {
    const groupKey = candidate.item.categoryId;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(candidate);
  }

  const active = [];
  for (const group of groups.values()) {
    let remaining = [...group];
    while (remaining.length > 0) {
      const width = Math.max(2, String(remaining.length).length);
      const generated = remaining.map((candidate, index) => ({
        candidate,
        result: generateName(projectSlug, candidate, index + 1, width, projectDir),
      }));
      const invalid = generated.filter(({ result }) => !result.ok);

      if (invalid.length === 0) {
        for (const { candidate, result } of generated) {
          candidate.item.proposedFilename = result.filename;
          candidate.item.proposedRelativePath = result.relativePath;
          candidate.proposedKey = result.key;
          candidate.willMove = candidate.proposedKey !== candidate.sourceKey;
          active.push(candidate);
        }
        break;
      }

      for (const { candidate } of invalid) {
        block(candidate.item, 'invalid-name');
      }
      remaining = generated
        .filter(({ result }) => result.ok)
        .map(({ candidate }) => candidate);
    }
  }

  return active;
}

function assignCategoryGeneratedNames(candidates, orderedRows, projectSlug, projectDir) {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.item.assetId, candidate]));
  const width = Math.max(2, String(candidates.length).length);
  const active = [];
  let sequence = 0;

  for (let index = 0; index < orderedRows.length; index++) {
    const candidate = candidatesById.get(orderedRows[index].id);
    if (!candidate || candidate.item.status === 'blocked') continue;

    const generated = generateName(
      projectSlug,
      candidate,
      sequence + 1,
      width,
      projectDir,
    );
    if (!generated.ok) {
      block(candidate.item, 'invalid-name');
      continue;
    }

    candidate.item.proposedFilename = generated.filename;
    candidate.item.proposedRelativePath = generated.relativePath;
    candidate.proposedKey = generated.key;
    candidate.willMove = candidate.proposedKey !== candidate.sourceKey;
    active.push(candidate);
    sequence += 1;
  }

  return active;
}

function addPathOccupant(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildPathMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (typeof row.relative_path !== 'string') continue;
    addPathOccupant(map, collisionKey(row.relative_path), row);
  }
  return map;
}

function resolveDirectory(projectDir, directory) {
  let directoryAbsPath = projectDir;
  if (directory) {
    try {
      directoryAbsPath = resolveContainedAssetPath(projectDir, directory);
    } catch {
      throw new AutoRenameInspectionError(AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED);
    }
  }

  let stats;
  try {
    stats = fs.lstatSync(directoryAbsPath);
  } catch {
    throw new AutoRenameInspectionError(AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AutoRenameInspectionError(AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED);
  }
  return directoryAbsPath;
}

function inspectDirectories(projectDir, candidates) {
  const directories = new Map();
  for (const candidate of candidates) {
    const key = collisionKey(candidate.directory);
    if (directories.has(key)) continue;

    const absPath = resolveDirectory(projectDir, candidate.directory);
    let entries;
    try {
      entries = fs.readdirSync(absPath, { withFileTypes: true });
    } catch {
      throw new AutoRenameInspectionError(AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED);
    }

    const byKey = new Map();
    for (const entry of entries) {
      if (typeof entry.name !== 'string') continue;
      const relativePath = makeRelativePath(candidate.directory, entry.name);
      addPathOccupant(byKey, collisionKey(relativePath), {
        name: entry.name,
        relativePath,
      });
    }
    directories.set(key, byKey);
  }
  return directories;
}

function classifyCollisions(candidates, allProjectRows, selectedIds, directoryEntries) {
  const dbByKey = buildPathMap(allProjectRows);
  const selectedIdSet = new Set(selectedIds);
  const duplicateDestinations = new Map();
  for (const candidate of candidates) {
    addPathOccupant(duplicateDestinations, candidate.proposedKey, candidate);
  }
  for (const occupants of duplicateDestinations.values()) {
    if (occupants.length > 1) {
      for (const candidate of occupants) block(candidate.item, 'duplicate-destination');
    }
  }

  const eligible = candidates.filter((candidate) => candidate.item.status !== 'blocked');
  const movingBySourceKey = new Map();
  for (const candidate of eligible) {
    if (candidate.willMove) addPathOccupant(movingBySourceKey, candidate.sourceKey, candidate);
  }

  const movingSourcePaths = new Set(
    eligible
      .filter((candidate) => candidate.willMove)
      .map((candidate) => candidate.item.currentRelativePath)
  );

  for (const candidate of eligible) {
    const proposedKey = candidate.proposedKey;
    const dbOccupants = (dbByKey.get(proposedKey) || [])
      .filter((row) => !selectedIdSet.has(row.id));

    if (dbOccupants.length > 0) {
      const exact = dbOccupants.some((row) => row.relative_path === candidate.item.proposedRelativePath);
      block(candidate.item, exact ? 'database-conflict' : 'case-conflict');
      continue;
    }

    const selectedOccupants = (dbByKey.get(proposedKey) || [])
      .filter((row) => selectedIdSet.has(row.id) && row.id !== candidate.item.assetId);
    const movingSelectedOccupants = selectedOccupants.filter((row) => {
      return (movingBySourceKey.get(proposedKey) || []).some((occupant) => occupant.item.assetId === row.id);
    });

    if (selectedOccupants.length > movingSelectedOccupants.length) {
      const exact = selectedOccupants.some((row) => {
        return row.relative_path === candidate.item.proposedRelativePath
          && !movingSelectedOccupants.some((occupant) => occupant.item.assetId === row.id);
      });
      block(candidate.item, exact ? 'database-conflict' : 'case-conflict');
      continue;
    }

    const entries = directoryEntries.get(collisionKey(candidate.directory))?.get(proposedKey) || [];
    const externalEntries = entries.filter((entry) => {
      return !movingSourcePaths.has(entry.relativePath)
        && entry.relativePath !== candidate.item.currentRelativePath;
    });
    if (externalEntries.length > 0) {
      const exact = externalEntries.some((entry) => entry.relativePath === candidate.item.proposedRelativePath);
      block(candidate.item, exact ? 'filesystem-conflict' : 'case-conflict');
    }
  }
}

function buildDependencies(items) {
  const sourceByKey = new Map();
  for (const item of items) {
    if (item.status !== 'rename') continue;
    const key = collisionKey(item.currentRelativePath);
    sourceByKey.set(key, item);
  }

  const dependencies = [];
  for (const item of items) {
    if (item.status !== 'rename') continue;
    const dependsOn = sourceByKey.get(collisionKey(item.proposedRelativePath));
    if (!dependsOn || dependsOn.assetId === item.assetId) continue;
    dependencies.push({
      assetId: item.assetId,
      dependsOnAssetId: dependsOn.assetId,
      sourceRelativePath: item.currentRelativePath,
      destinationRelativePath: item.proposedRelativePath,
    });
  }
  return dependencies;
}

function buildCycles(dependencies) {
  const next = new Map(dependencies.map((dependency) => [dependency.assetId, dependency.dependsOnAssetId]));
  const cycles = [];
  const seenCycles = new Set();

  for (const start of [...next.keys()].sort((a, b) => a - b)) {
    const positions = new Map();
    const trail = [];
    let current = start;
    while (next.has(current) && !positions.has(current)) {
      positions.set(current, trail.length);
      trail.push(current);
      current = next.get(current);
    }
    if (!positions.has(current)) continue;

    const cycle = trail.slice(positions.get(current));
    const minimum = Math.min(...cycle);
    const startIndex = cycle.indexOf(minimum);
    const normalized = [...cycle.slice(startIndex), ...cycle.slice(0, startIndex)];
    const key = normalized.join(',');
    if (!seenCycles.has(key)) {
      seenCycles.add(key);
      cycles.push(normalized);
    }
  }

  return cycles.sort((a, b) => a[0] - b[0]);
}

function signedAssetFromItem(item, { includeGeneratedState = false } = {}) {
  const signed = {
    assetId: item.assetId,
    currentRelativePath: item.currentRelativePath,
    currentFilename: item.currentFilename,
    filename: item.filename,
    databaseFilename: item.databaseFilename,
    presenceState: item.presenceState,
    sizeBytes: item.sizeBytes,
    size_bytes: item.size_bytes,
    modifiedAt: item.modifiedAt,
    modifiedTime: item.modifiedTime,
    modified_at: item.modified_at,
    databaseSizeBytes: item.databaseSizeBytes,
    databaseModifiedAt: item.databaseModifiedAt,
    databaseCategoryId: item.databaseCategoryId,
    categoryId: item.categoryId,
    categoryDirectorySlug: item.categoryDirectorySlug,
    categoryEnabled: item.categoryEnabled,
    categoryRecordId: item.categoryRecordId,
    categoryProjectId: item.categoryProjectId,
    databaseNestedPath: item.databaseNestedPath,
    sourceIdentity: item.sourceIdentity,
    directory: item.directory,
  };

  if (includeGeneratedState) {
    signed.status = item.status;
    signed.reason = item.reason;
    signed.proposedRelativePath = item.proposedRelativePath;
    signed.proposedFilename = item.proposedFilename;
  }

  return signed;
}

function normalizeSnapshotAssetIds(assetIds) {
  if (!Array.isArray(assetIds) || assetIds.length === 0) return null;
  const normalized = [];
  const seen = new Set();
  for (const assetId of assetIds) {
    if (!Number.isSafeInteger(assetId) || assetId <= 0 || seen.has(assetId)) return null;
    seen.add(assetId);
    normalized.push(assetId);
  }
  return sortedAssetIds(normalized);
}

function isValidCategorySnapshotAsset(asset, category) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
  if (asset.categoryId !== category.id || asset.databaseCategoryId !== category.id) return false;
  if (asset.categoryRecordId !== category.id || asset.categoryProjectId !== category.projectId) return false;
  if (asset.categoryDirectorySlug !== category.directorySlug || asset.categoryEnabled !== category.enabled) {
    return false;
  }
  if (!['blocked', 'rename', 'unchanged'].includes(asset.status)) return false;
  if (asset.reason !== null && typeof asset.reason !== 'string') return false;

  if (asset.status === 'blocked') {
    return asset.proposedRelativePath === null && asset.proposedFilename === null;
  }
  return typeof asset.proposedRelativePath === 'string'
    && typeof asset.proposedFilename === 'string';
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  if (!Number.isSafeInteger(snapshot.planVersion) || snapshot.planVersion <= 0) return null;
  if (!Number.isSafeInteger(snapshot.namingPolicyVersion) || snapshot.namingPolicyVersion <= 0) return null;
  if (!Number.isSafeInteger(snapshot.projectId) || snapshot.projectId <= 0) return null;
  if (snapshot.projectSlug !== null && typeof snapshot.projectSlug !== 'string') return null;
  if (snapshot.projectRelativePath !== null && typeof snapshot.projectRelativePath !== 'string') return null;
  if (!Array.isArray(snapshot.assets)) return null;

  const assets = [...snapshot.assets].sort((left, right) => (left?.assetId ?? 0) - (right?.assetId ?? 0));
  const assetIds = normalizeSnapshotAssetIds(assets.map((asset) => asset?.assetId));
  if (assets.some((asset) => !asset || typeof asset !== 'object' || Array.isArray(asset))) return null;

  if (snapshot.scope !== 'category') return null;
  const category = normalizeCategorySnapshotState(snapshot.category);
  if (!category || !category.enabled || snapshot.categoryId !== category.id) return null;

  const membershipAssetIds = normalizeSnapshotAssetIds(snapshot.membershipAssetIds);
  if (!membershipAssetIds || !assetIds || !assetIdArraysEqual(assetIds, membershipAssetIds)) return null;

  const orderedAssetIds = Array.isArray(snapshot.orderedAssetIds)
    && snapshot.orderedAssetIds.length > 0
    && snapshot.orderedAssetIds.every((assetId) => Number.isSafeInteger(assetId) && assetId > 0)
    ? [...snapshot.orderedAssetIds]
    : null;
  if (!orderedAssetIds) return null;
  if (!assetIdArraysEqual(sortedAssetIds(orderedAssetIds), membershipAssetIds)) return null;
  if (assets.length !== membershipAssetIds.length) return null;
  if (assets.some((asset) => !isValidCategorySnapshotAsset(asset, category))) return null;

  return {
    scope: 'category',
    planVersion: snapshot.planVersion,
    namingPolicyVersion: snapshot.namingPolicyVersion,
    projectId: snapshot.projectId,
    projectSlug: snapshot.projectSlug,
    projectRelativePath: snapshot.projectRelativePath,
    categoryId: category.id,
    category,
    membershipAssetIds,
    orderedAssetIds,
    assets,
  };
}

function snapshotFromItems({
  projectId,
  projectSlug,
  projectRelativePath,
  planVersion,
  namingPolicyVersion,
  scope = 'category',
  category,
  orderedAssetIds,
  items,
}) {
  const signedItems = [...items].sort((left, right) => left.assetId - right.assetId);
  const base = {
    planVersion,
    namingPolicyVersion,
    projectId,
    projectSlug,
    projectRelativePath,
    scope,
    assets: signedItems.map((item) => signedAssetFromItem(item, { includeGeneratedState: true })),
  };

  base.categoryId = category?.id;
  base.category = category;
  base.membershipAssetIds = signedItems.map((item) => item.assetId);
  base.orderedAssetIds = orderedAssetIds;

  return normalizeSnapshot(base);
}

function canonicalSerialize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot canonically serialize an unsupported value.');
}

function constantTimeEqual(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function signSnapshot(snapshot, signingKey) {
  const payload = Buffer.from(canonicalSerialize(snapshot), 'utf8');
  const signature = crypto.createHmac('sha256', signingKey).update(payload).digest();
  return {
    payload,
    token: `${TOKEN_PREFIX}.${payload.toString('base64url')}.${signature.toString('base64url')}`,
  };
}

function parseToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;

  let payload;
  let signature;
  try {
    payload = Buffer.from(parts[1], 'base64url');
    signature = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (signature.length !== 32 || payload.length === 0) return null;

  const payloadText = payload.toString('utf8');
  try {
    const parsed = JSON.parse(payloadText);
    if (canonicalSerialize(parsed) !== payloadText) return null;
  } catch {
    return null;
  }

  return { payload, signature };
}

function snapshotFromTokenPayload(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }

  const snapshot = snapshotFromPlanOrSnapshot(parsed);
  if (!snapshot) return null;
  try {
    return canonicalSerialize(snapshot) === payload.toString('utf8') ? snapshot : null;
  } catch {
    return null;
  }
}

function snapshotFromPlanOrSnapshot(planOrSnapshot) {
  if (!planOrSnapshot || typeof planOrSnapshot !== 'object') return null;

  if (Array.isArray(planOrSnapshot.items)) {
    if (planOrSnapshot.scope !== 'category') return null;
    const snapshot = snapshotFromItems({
      projectId: planOrSnapshot.projectId,
      projectSlug: planOrSnapshot.projectSlug,
      projectRelativePath: planOrSnapshot.projectRelativePath,
      planVersion: planOrSnapshot.planVersion,
      namingPolicyVersion: planOrSnapshot.namingPolicyVersion,
      scope: 'category',
      category: planOrSnapshot.category,
      orderedAssetIds: planOrSnapshot.orderedAssetIds,
      items: planOrSnapshot.items,
    });
    if (!snapshot) return null;

    const membershipAssetIds = normalizeSnapshotAssetIds(planOrSnapshot.membershipAssetIds);
    if (
      !membershipAssetIds
      || !assetIdArraysEqual(membershipAssetIds, snapshot.membershipAssetIds)
      || planOrSnapshot.categoryId !== snapshot.categoryId
      || !assetIdArraysEqual(planOrSnapshot.orderedAssetIds || [], snapshot.orderedAssetIds)
    ) return null;

    if (planOrSnapshot.snapshot) {
      try {
        const embeddedSnapshot = snapshotFromPlanOrSnapshot(planOrSnapshot.snapshot);
        if (!embeddedSnapshot || canonicalSerialize(embeddedSnapshot) !== canonicalSerialize(snapshot)) return null;
      } catch {
        return null;
      }
    }
    return snapshot;
  }

  if (Array.isArray(planOrSnapshot.assets)) {
    return normalizeSnapshot({
      scope: planOrSnapshot.scope,
      planVersion: planOrSnapshot.planVersion,
      namingPolicyVersion: planOrSnapshot.namingPolicyVersion,
      projectId: planOrSnapshot.projectId,
      projectSlug: planOrSnapshot.projectSlug,
      projectRelativePath: planOrSnapshot.projectRelativePath,
      categoryId: planOrSnapshot.categoryId,
      category: planOrSnapshot.category,
      membershipAssetIds: planOrSnapshot.membershipAssetIds,
      orderedAssetIds: planOrSnapshot.orderedAssetIds,
      assets: planOrSnapshot.assets,
    });
  }

  return null;
}

function normalizeSigningKey(signingKey) {
  const value = signingKey === undefined ? crypto.randomBytes(32) : signingKey;
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
  if (key.length === 0) throw new Error('createAutoRenameService requires a non-empty signingKey.');
  return key;
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

/**
 * Build an immutable, read-only Auto Rename plan for an explicit asset set.
 * Applying a previously signed plan is a separate operation in this service;
 * preview generation and archive inspection remain outside its scope.
 *
 * @param {object} deps
 * @param {object} deps.projectRepository
 * @param {object} deps.assetRepository
 * @param {object} deps.assetCategoryRepository
 * @param {string} deps.projectsRoot
 * @param {object} deps.projectOperationCoordinator
 * @param {string|Buffer|Uint8Array} [deps.signingKey]
 * @param {object} [deps._hooks] - Internal failure-injection hooks for tests.
 */
export function createAutoRenameService({
  projectRepository,
  assetRepository,
  assetCategoryRepository,
  projectsRoot,
  projectOperationCoordinator,
  signingKey,
  _hooks,
} = {}) {
  if (!projectRepository || typeof projectRepository.findById !== 'function') {
    throw new Error('createAutoRenameService requires a projectRepository dependency.');
  }
  if (
    !assetRepository
    || typeof assetRepository.findProjectAssetsByIdsInBrowserOrder !== 'function'
    || typeof assetRepository.findProjectAssetsByCategoryInBrowserOrder !== 'function'
    || typeof assetRepository.findByProjectId !== 'function'
  ) {
    throw new Error('createAutoRenameService requires an assetRepository dependency.');
  }
  if (!assetCategoryRepository || typeof assetCategoryRepository.findProjectCategoryById !== 'function') {
    throw new Error('createAutoRenameService requires an assetCategoryRepository dependency.');
  }
  if (!projectsRoot) throw new Error('createAutoRenameService requires a projectsRoot dependency.');
  if (!projectOperationCoordinator || typeof projectOperationCoordinator.run !== 'function') {
    throw new Error('createAutoRenameService requires a projectOperationCoordinator dependency.');
  }

  const key = normalizeSigningKey(signingKey);
  const hooks = _hooks && typeof _hooks === 'object' ? _hooks : {};

  function runHook(name, payload) {
    if (typeof hooks[name] === 'function') hooks[name](payload);
  }

  function requireMutableProject(projectId) {
    let project;
    try {
      project = projectRepository.findById(projectId);
    } catch (err) {
      throw new AutoRenameError(
        'Auto Rename planning could not read the project.',
        { code: AUTO_RENAME_ERROR_CODES.DATABASE_ERROR, cause: err }
      );
    }
    if (!project) {
      throw new AutoRenameError(
        `Project ${projectId} was not found.`,
        { code: AUTO_RENAME_ERROR_CODES.PROJECT_NOT_FOUND }
      );
    }
    if (project.archived_at || project.status === 'archived') {
      throw new AutoRenameError(
        `Project ${projectId} is archived and cannot be modified.`,
        { code: AUTO_RENAME_ERROR_CODES.PROJECT_ARCHIVED }
      );
    }
    return project;
  }

  function resolveProjectPath(project) {
    if (!project.project_dir) {
      throw new AutoRenameError(
        'Project directory cannot be accessed.',
        { code: AUTO_RENAME_ERROR_CODES.PROJECT_DIRECTORY_UNSAFE }
      );
    }
    try {
      return resolveProjectDir(projectsRoot, project.project_dir);
    } catch (err) {
      throw new AutoRenameError(
        'Project directory cannot be accessed.',
        { code: AUTO_RENAME_ERROR_CODES.PROJECT_DIRECTORY_UNSAFE, cause: err }
      );
    }
  }

  function requireCategoryRecord(projectId, categoryId) {
    if (categoryId === undefined || categoryId === null) throw categoryRequiredError();
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) throw categoryInvalidError();

    let category;
    try {
      category = assetCategoryRepository.findProjectCategoryById(projectId, categoryId);
    } catch (err) {
      throw new AutoRenameError(
        'Auto Rename planning could not read the category.',
        { code: AUTO_RENAME_ERROR_CODES.DATABASE_ERROR, cause: err }
      );
    }
    if (!category || category.id !== categoryId || category.project_id !== projectId) {
      throw categoryInvalidError();
    }
    if (!isCategoryEnabled(category.enabled)) throw categoryDisabledError();
    if (!isValidCategoryDirectorySlug(category.directory_slug)) throw categoryInvalidError();
    return category;
  }

  function loadRows(projectId, categoryId) {
    try {
      const allProjectRows = assetRepository.findByProjectId(projectId);
      const browserRows = assetRepository.findProjectAssetsByCategoryInBrowserOrder(projectId, categoryId);
      return { allProjectRows, browserRows };
    } catch (err) {
      throw new AutoRenameError(
        'Auto Rename planning could not read asset records.',
        { code: AUTO_RENAME_ERROR_CODES.DATABASE_ERROR, cause: err }
      );
    }
  }

  function buildPlanUnlocked(projectId, categoryId, orderedAssetIds) {
    const project = requireMutableProject(projectId);
    const category = requireCategoryRecord(projectId, categoryId);
    const { allProjectRows, browserRows } = loadRows(projectId, categoryId);
    if (browserRows.length === 0) throw categoryEmptyError();

    const projectDir = resolveProjectPath(project);
    const browserRowsById = new Map(browserRows.map((row) => [row.id, row]));
    const membershipAssetIds = browserRows.map((row) => row.id);
    const normalizedOrder = assertExactCategoryPermutation(orderedAssetIds, membershipAssetIds);
    const orderedRows = normalizedOrder.map((assetId) => browserRowsById.get(assetId));
    const itemsById = new Map();
    const candidates = [];

    for (const row of orderedRows) {
      const item = createItem(row.id, row);
      const categoryState = categoryStateFromRecord(category);
      if (!categoryState) throw categoryInvalidError();
      item.categoryId = categoryState.id;
      item.categoryDisplayName = categoryState.displayName;
      item.categoryDirectorySlug = categoryState.directorySlug;
      item.categoryEnabled = categoryState.enabled;
      item.categoryRecordId = categoryState.id;
      item.categoryProjectId = categoryState.projectId;
      item.databaseCategoryId = categoryState.id;
      itemsById.set(row.id, item);
      const categoryReason = categoryBlockReason(projectId, row);
      if (categoryReason) {
        block(item, categoryReason);
        continue;
      }
      const source = inspectSource(projectDir, item, row);
      if (!source.ok) {
        block(item, source.reason);
        continue;
      }
      const filenameError = validateAssetFilename(item.currentFilename);
      if (filenameError || isControlCharacter(item.currentFilename)) {
        block(item, 'invalid-name');
        continue;
      }
      candidates.push({
        asset: row,
        item,
        directory: item.directory,
        extension: exactExtension(item.currentFilename),
        sourceKey: source.sourceKey,
        sourceAbsPath: source.sourceAbsPath,
        stats: source.stats,
        sourceIdentity: source.sourceIdentity,
      });
    }

    const sourceValidCandidates = candidates.filter((candidate) => candidate.item.status !== 'blocked');
    const namedCandidates = assignCategoryGeneratedNames(sourceValidCandidates, orderedRows, project.slug, projectDir);
    const directoryEntries = inspectDirectories(projectDir, namedCandidates);
    classifyCollisions(
      namedCandidates,
      allProjectRows,
      membershipAssetIds,
      directoryEntries,
    );

    const orderedItems = normalizedOrder.map((assetId) => itemsById.get(assetId));

    for (const item of orderedItems) {
      if (item.status === 'blocked') continue;
      item.status = collisionKey(item.currentRelativePath) === collisionKey(item.proposedRelativePath)
        ? 'unchanged'
        : 'rename';
      item.reason = null;
    }

    const dependencies = buildDependencies(orderedItems);
    const cycles = buildCycles(dependencies);
    const categoryState = categoryStateFromRecord(category);
    const snapshot = snapshotFromItems({
      projectId,
      projectSlug: project.slug ?? null,
      projectRelativePath: project.project_dir ?? null,
      planVersion: AUTO_RENAME_PLAN_VERSION,
      namingPolicyVersion: AUTO_RENAME_NAMING_POLICY_VERSION,
      scope: 'category',
      category: categoryState,
      orderedAssetIds: normalizedOrder,
      items: orderedItems,
    });

    let token;
    try {
      token = signSnapshot(snapshot, key).token;
    } catch (err) {
      throw new AutoRenameError(
        'Auto Rename plan signing failed.',
        { code: AUTO_RENAME_ERROR_CODES.SIGNING_FAILED, cause: err }
      );
    }

    const counts = {
      selected: membershipAssetIds.length,
      rename: orderedItems.filter((item) => item.status === 'rename').length,
      unchanged: orderedItems.filter((item) => item.status === 'unchanged').length,
      blocked: orderedItems.filter((item) => item.status === 'blocked').length,
    };

    const plan = {
      projectId,
      projectSlug: project.slug ?? null,
      projectRelativePath: project.project_dir ?? null,
      planVersion: AUTO_RENAME_PLAN_VERSION,
      namingPolicyVersion: AUTO_RENAME_NAMING_POLICY_VERSION,
      orderedAssetIds: normalizedOrder,
      token,
      canApply: counts.rename > 0 && counts.blocked === 0,
      counts,
      items: orderedItems,
      snapshot,
      dependencies,
      cycles,
      execution: { dependencies, cycles },
    };

    Object.assign(plan, {
      scope: 'category',
      categoryId: categoryState.id,
      category: categoryState,
      membershipAssetIds: sortedAssetIds(membershipAssetIds),
    });

    return freezeDeep(plan);
  }

  function runBuild(projectId, callback) {
    try {
      return projectOperationCoordinator.run(projectId, callback);
    } catch (err) {
      if (err instanceof AutoRenameError) throw err;
      if (err instanceof AutoRenameInspectionError) {
        throw new AutoRenameError(
          'Auto Rename planning could not inspect the project filesystem.',
          { code: AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED, cause: err }
        );
      }
      if (err instanceof ProjectOperationError) {
        if (err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
          throw new AutoRenameError(
            'Another operation is already in progress for this project.',
            { code: AUTO_RENAME_ERROR_CODES.PROJECT_BUSY, cause: err }
          );
        }
        throw new AutoRenameError(
          'Auto Rename planning could not acquire the project operation lock.',
          { code: AUTO_RENAME_ERROR_CODES.INVALID_PROJECT_ID, cause: err }
        );
      }
      throw new AutoRenameError(
        'Auto Rename planning failed.',
        { code: AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED, cause: err }
      );
    }
  }

  function buildCategoryPlan({ projectId, categoryId, orderedAssetIds } = {}) {
    assertCanonicalPositiveInteger(projectId, 'projectId');
    if (categoryId === undefined || categoryId === null) throw categoryRequiredError();
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) throw categoryInvalidError();
    return runBuild(
      projectId,
      () => buildPlanUnlocked(projectId, categoryId, orderedAssetIds),
    );
  }

  /**
   * Category-first public API. Membership is always the complete current
   * category; callers may provide only its exact desired order.
   */
  function buildPlan(input) {
    return buildCategoryPlan(input);
  }

  function stalePlanError() {
    return new AutoRenameError(
      'Auto Rename preview is stale and must be regenerated.',
      { code: AUTO_RENAME_ERROR_CODES.STALE_PLAN }
    );
  }

  function filesystemOperationError() {
    return new AutoRenameError(
      'Auto Rename could not safely complete its filesystem checks.',
      { code: AUTO_RENAME_ERROR_CODES.FILESYSTEM_OPERATION_FAILED }
    );
  }

  function readPathStats(absolutePath) {
    try {
      return fs.lstatSync(absolutePath);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw filesystemOperationError();
    }
  }

  function databaseRowMatchesPlan(item, row) {
    const hasCategoryProjection = row
      && Object.prototype.hasOwnProperty.call(row, 'category_record_id');
    const categoryMatches = !hasCategoryProjection || (
      row.category_record_id === item.categoryRecordId
      && row.category_project_id === item.categoryProjectId
      && (row.category_directory_slug ?? null) === (item.categoryDirectorySlug ?? null)
      && (row.category_enabled === null || row.category_enabled === undefined
        ? null
        : isCategoryEnabled(row.category_enabled)) === item.categoryEnabled
    );

    return row
      && row.id === item.assetId
      && row.relative_path === item.currentRelativePath
      && row.filename === item.databaseFilename
      && row.category_id === item.databaseCategoryId
      && categoryMatches
      && (row.nested_path ?? '') === item.databaseNestedPath
      && row.size_bytes === item.databaseSizeBytes
      && row.modified_at === item.databaseModifiedAt
      && (isPresent(row) ? 'present' : 'missing') === item.presenceState;
  }

  function inspectExecutionSource(projectDir, item) {
    let sourceAbsPath;
    try {
      sourceAbsPath = resolveContainedAssetPath(
        projectDir,
        item.currentRelativePath,
        { checkFinalSymlink: false }
      );
    } catch {
      throw stalePlanError();
    }

    const stats = readPathStats(sourceAbsPath);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw stalePlanError();
    }
    if (
      stats.size !== item.sizeBytes
      || stats.mtime.toISOString() !== item.modifiedAt
      || !sourceIdentityMatches(item.sourceIdentity, stats)
    ) {
      throw stalePlanError();
    }

    return {
      sourceAbsPath,
      sourceIdentity: sourceIdentityFromStats(stats),
      stats,
    };
  }

  function resolveExecutionDirectory(projectDir, directory) {
    let directoryAbsPath = projectDir;
    if (directory) {
      try {
        directoryAbsPath = resolveContainedAssetPath(projectDir, directory);
      } catch {
        throw filesystemOperationError();
      }
    }

    const stats = readPathStats(directoryAbsPath);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw filesystemOperationError();
    }
    return directoryAbsPath;
  }

  function readExecutionDirectory(projectDir, directory) {
    const absolutePath = resolveExecutionDirectory(projectDir, directory);
    let entries;
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      throw filesystemOperationError();
    }

    return {
      absolutePath,
      directory,
      relativePaths: entries
        .filter((entry) => typeof entry.name === 'string')
        .map((entry) => makeRelativePath(directory, entry.name)),
    };
  }

  function findEquivalentDirectoryEntries(projectDir, targetDirectoryKeys) {
    const matches = [];

    function walk(absoluteDirectory, relativeDirectoryPath) {
      let entries;
      try {
        entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
      } catch {
        throw filesystemOperationError();
      }

      for (const entry of entries) {
        if (typeof entry.name !== 'string') continue;
        const childRelativePath = makeRelativePath(relativeDirectoryPath, entry.name);
        const childKey = collisionKey(childRelativePath);
        if (entry.isSymbolicLink()) {
          if (targetDirectoryKeys.has(childKey)) throw filesystemOperationError();
          continue;
        }
        if (!entry.isDirectory()) continue;

        const childAbsolutePath = path.join(absoluteDirectory, entry.name);
        if (targetDirectoryKeys.has(childKey)) {
          matches.push(readExecutionDirectory(projectDir, childRelativePath));
        }
        walk(childAbsolutePath, childRelativePath);
      }
    }

    walk(projectDir, '');
    return matches;
  }

  function assertExecutionDestinationsClear(projectDir, allProjectRows, execution) {
    const sourceKeys = new Set(execution.map((unit) => collisionKey(unit.item.currentRelativePath)));
    const destinationKeys = new Set();
    const directories = new Map();

    for (const unit of execution) {
      const item = unit.item;
      if (relativeDirectory(item.currentRelativePath) !== relativeDirectory(item.proposedRelativePath)) {
        throw stalePlanError();
      }

      try {
        unit.finalAbsPath = resolveContainedAssetPath(
          projectDir,
          item.proposedRelativePath,
          { checkFinalSymlink: false }
        );
      } catch {
        throw stalePlanError();
      }

      const destinationKey = collisionKey(item.proposedRelativePath);
      if (destinationKeys.has(destinationKey)) throw stalePlanError();
      destinationKeys.add(destinationKey);

      const directory = item.directory;
      if (!directories.has(directory)) {
        directories.set(directory, readExecutionDirectory(projectDir, directory));
      }
    }

    const equivalentDirectories = findEquivalentDirectoryEntries(
      projectDir,
      new Set(execution.map((unit) => collisionKey(unit.item.directory))),
    );
    let equivalentIndex = 0;
    for (const directory of equivalentDirectories) {
      if (!directories.has(directory.directory)) {
        directories.set(`\u0000equivalent-${equivalentIndex}`, directory);
        equivalentIndex++;
      }
    }

    const executionIds = new Set(execution.map((unit) => unit.item.assetId));
    for (const row of allProjectRows) {
      const rowKey = collisionKey(row.relative_path);
      if (!destinationKeys.has(rowKey)) continue;
      if (!executionIds.has(row.id) || !sourceKeys.has(rowKey)) {
        throw stalePlanError();
      }
    }

    for (const directory of directories.values()) {
      for (const relativePath of directory.relativePaths) {
        const entryKey = collisionKey(relativePath);
        if (!destinationKeys.has(entryKey)) continue;
        if (!sourceKeys.has(entryKey)) throw stalePlanError();
      }
    }

    return directories;
  }

  function revalidateExecutionPlan(projectId, plan) {
    let project;
    try {
      project = requireMutableProject(projectId);
    } catch (err) {
      if (err instanceof AutoRenameError) throw stalePlanError();
      throw err;
    }
    if (
      project.slug !== plan.projectSlug
      || project.project_dir !== plan.projectRelativePath
    ) {
      throw stalePlanError();
    }

    const projectDir = resolveProjectPath(project);
    let allProjectRows;
    let browserRows;
    let category;
    try {
      category = requireCategoryRecord(projectId, plan.categoryId);
      const categoryState = categoryStateFromRecord(category);
      if (!categoryState || !categoryStatesEqual(categoryState, plan.category)) {
        throw stalePlanError();
      }
      ({ allProjectRows, browserRows } = loadRows(projectId, plan.categoryId));
    } catch (err) {
      if (err instanceof AutoRenameError && err.code === AUTO_RENAME_ERROR_CODES.STALE_PLAN) throw err;
      throw stalePlanError();
    }
    const currentMembership = browserRows.map((row) => row.id);
    if (
      new Set(currentMembership).size !== currentMembership.length
      || !Array.isArray(plan.membershipAssetIds)
      || !assetIdArraysEqual(sortedAssetIds(currentMembership), plan.membershipAssetIds)
    ) {
      throw stalePlanError();
    }
    const rowsById = new Map(browserRows.map((row) => [row.id, row]));

    const execution = [];
    for (const item of plan.items) {
      const row = rowsById.get(item.assetId);
      if (!databaseRowMatchesPlan(item, row)) throw stalePlanError();
      if (item.status !== 'blocked') {
        inspectExecutionSource(projectDir, item);
      }
      if (item.status !== 'rename') continue;

      const source = inspectExecutionSource(projectDir, item);
      execution.push({
        assetId: item.assetId,
        item,
        row,
        sourceAbsPath: source.sourceAbsPath,
        sourceIdentity: source.sourceIdentity,
        sourceStats: source.stats,
        finalAbsPath: null,
        temporaryAbsPath: null,
        temporaryRelativePath: null,
        temporaryFilename: null,
        finalStats: null,
      });
    }

    const directories = assertExecutionDestinationsClear(projectDir, allProjectRows, execution);
    return { project, projectDir, allProjectRows, execution, directories };
  }

  function temporaryPathIsClear(directory, relativePath, directoryData) {
    const key = collisionKey(relativePath);
    if (directoryData.relativePaths.some((entry) => collisionKey(entry) === key)) return false;
    return true;
  }

  function generateTemporaryPath(projectDir, directory, reservedKeys, knownDirectoryData) {
    for (let attempt = 0; attempt < 20; attempt++) {
      let basename;
      try {
        basename = `__creatorcrate_auto_rename_${crypto.randomUUID()}.tmp`;
      } catch {
        throw filesystemOperationError();
      }
      if (validateGeneratedFilename(basename)) continue;

      const relativePath = makeRelativePath(directory, basename);
      const key = collisionKey(relativePath);
      if (reservedKeys.has(key)) continue;
      if (!temporaryPathIsClear(directory, relativePath, knownDirectoryData)) continue;

      let absolutePath;
      try {
        absolutePath = resolveContainedAssetPath(projectDir, relativePath, { checkFinalSymlink: false });
      } catch {
        throw filesystemOperationError();
      }
      if (readPathStats(absolutePath)) continue;

      reservedKeys.add(key);
      return { relativePath, absolutePath, basename };
    }

    throw filesystemOperationError();
  }

  function buildExecutionUnits(projectDir, allProjectRows, execution, directories) {
    const reservedKeys = new Set();
    for (const row of allProjectRows) reservedKeys.add(collisionKey(row.relative_path));
    for (const unit of execution) {
      reservedKeys.add(collisionKey(unit.item.currentRelativePath));
      reservedKeys.add(collisionKey(unit.item.proposedRelativePath));
    }
    for (const directory of directories.values()) {
      for (const relativePath of directory.relativePaths) reservedKeys.add(collisionKey(relativePath));
    }

    for (const unit of execution) {
      const directoryData = directories.get(unit.item.directory);
      const temporary = generateTemporaryPath(
        projectDir,
        unit.item.directory,
        reservedKeys,
        directoryData,
      );
      unit.temporaryRelativePath = temporary.relativePath;
      unit.temporaryAbsPath = temporary.absolutePath;
      unit.temporaryFilename = temporary.basename;
    }
    return execution;
  }

  function assertPathAbsent(absolutePath) {
    if (pathHasFilesystemCollision(absolutePath)) throw new Error('Path is unexpectedly occupied.');
  }

  function pathHasFilesystemCollision(absolutePath) {
    if (readPathStats(absolutePath)) return true;
    let entries;
    try {
      entries = fs.readdirSync(path.dirname(absolutePath), { withFileTypes: true });
    } catch {
      throw new Error('Path parent cannot be inspected.');
    }
    const basenameKey = collisionKey(path.basename(absolutePath));
    return entries.some((entry) => typeof entry.name === 'string' && collisionKey(entry.name) === basenameKey);
  }

  function assertTemporaryDestinationClear(unit) {
    const directoryData = readExecutionDirectory(path.dirname(unit.sourceAbsPath), '');
    if (!temporaryPathIsClear('', path.basename(unit.temporaryAbsPath), directoryData)) {
      throw new Error('Temporary path is unexpectedly occupied.');
    }
    assertPathAbsent(unit.temporaryAbsPath);
  }

  function assertSourceStillPresent(unit) {
    const stats = readPathStats(unit.sourceAbsPath);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) throw stalePlanError();
    if (
      stats.size !== unit.item.sizeBytes
      || stats.mtime.toISOString() !== unit.item.modifiedAt
      || !sourceIdentityMatches(unit.sourceIdentity, stats)
    ) {
      throw stalePlanError();
    }
    return stats;
  }

  function inspectMovedFile(absolutePath, expectedIdentity) {
    const stats = readPathStats(absolutePath);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('Moved path is not a regular file.');
    }
    if (!sourceIdentityMatches(expectedIdentity, stats)) {
      throw new Error('Moved file identity changed.');
    }
    return stats;
  }

  function assertSourceGone(absolutePath) {
    if (readPathStats(absolutePath)) throw new Error('Source path remains after move.');
  }

  function assertFinalDestinationClear(unit) {
    // The exact-path and directory-entry checks are intentionally repeated
    // immediately before rename. Node's fs.renameSync has no portable
    // no-clobber mode, so an external SMB/process race can still occur after
    // these checks and before the syscall; that residual TOCTOU boundary is
    // reported through compensation rather than treated as atomic safety.
    assertPathAbsent(unit.finalAbsPath);
    const directory = unit.item.directory;
    const directoryData = readExecutionDirectory(path.dirname(unit.finalAbsPath), '');
    const destinationKey = collisionKey(unit.item.proposedRelativePath);
    if (directoryData.relativePaths.some((entry) => {
      const relativePath = makeRelativePath(directory, path.basename(entry));
      return collisionKey(relativePath) === destinationKey;
    })) {
      throw new Error('Final destination is unexpectedly occupied.');
    }
  }

  function assertProjectStillMutable(projectId, expectedProject) {
    const current = requireMutableProject(projectId);
    if (
      current.slug !== expectedProject.slug
      || current.project_dir !== expectedProject.project_dir
    ) {
      throw new Error('Project changed during Auto Rename.');
    }
  }

  function buildLocationUpdates(units) {
    return units.map((unit) => {
      if (!unit.finalStats) throw new Error('Final file metadata is unavailable.');
      const finalFilename = unit.item.proposedFilename;
      const extension = deriveExtensionFromFilename(finalFilename);
      return {
        assetId: unit.assetId,
        expectedOldRelativePath: unit.item.currentRelativePath,
        temporaryRelativePath: unit.temporaryRelativePath,
        temporaryFilename: unit.temporaryFilename,
        temporaryExtension: deriveExtensionFromFilename(unit.temporaryFilename),
        temporaryMimeType: mimeFromExtension(deriveExtensionFromFilename(unit.temporaryFilename)),
        temporaryNestedPath: relativeDirectory(unit.item.currentRelativePath),
        relativePath: unit.item.proposedRelativePath,
        filename: finalFilename,
        extension,
        mimeType: mimeFromExtension(extension),
        categoryId: unit.row.category_id ?? null,
        nestedPath: unit.row.nested_path ?? '',
        sizeBytes: unit.finalStats.size,
        modifiedAt: unit.finalStats.mtime.toISOString(),
        expectedDatabaseFilename: unit.item.databaseFilename,
        expectedDatabaseCategoryId: unit.item.databaseCategoryId,
        expectedDatabaseNestedPath: unit.item.databaseNestedPath,
        expectedDatabaseSizeBytes: unit.item.databaseSizeBytes,
        expectedDatabaseModifiedAt: unit.item.databaseModifiedAt,
        expectedDatabasePresent: unit.item.presenceState === 'present',
      };
    });
  }

  function safeRecoveryItems(execution) {
    return execution.map((unit) => ({
      assetId: unit.assetId,
      previousRelativePath: unit.item.currentRelativePath,
      relativePath: unit.item.proposedRelativePath,
      temporaryRelativePath: unit.temporaryRelativePath,
    }));
  }

  function isRegularFileAt(absolutePath, expectedIdentity) {
    try {
      const stats = readPathStats(absolutePath);
      return Boolean(
        stats
        && !stats.isSymbolicLink()
        && stats.isFile()
        && sourceIdentityMatches(expectedIdentity, stats)
      );
    } catch {
      return false;
    }
  }

  function compensationDestinationClear(absolutePath) {
    try {
      return !pathHasFilesystemCollision(absolutePath);
    } catch {
      return false;
    }
  }

  function compensateFilesystem(projectId, expectedProject, execution, phase1Completed, phase2Completed) {
    const phase1Set = new Set(phase1Completed);
    const phase2Set = new Set(phase2Completed);
    const moved = execution.filter((unit) => phase1Set.has(unit));
    const staged = [];
    let databaseState = 'unchanged';
    let failure = false;

    try {
      const reservedKeys = new Set();
      for (const unit of execution) {
        reservedKeys.add(collisionKey(unit.item.currentRelativePath));
        reservedKeys.add(collisionKey(unit.item.proposedRelativePath));
        if (unit.temporaryRelativePath) reservedKeys.add(collisionKey(unit.temporaryRelativePath));
      }
      for (const unit of moved) {
        const currentRelativePath = phase2Set.has(unit)
          ? unit.item.proposedRelativePath
          : unit.temporaryRelativePath;
        reservedKeys.add(collisionKey(currentRelativePath));
      }

      for (const unit of moved) {
        const currentAbsPath = phase2Set.has(unit)
          ? unit.finalAbsPath
          : unit.temporaryAbsPath;
        const recoveryTemporary = generateTemporaryPath(
          path.dirname(unit.sourceAbsPath),
          '',
          reservedKeys,
          readExecutionDirectory(path.dirname(unit.sourceAbsPath), ''),
        );
        unit.recoveryTemporaryAbsPath = recoveryTemporary.absolutePath;
        unit.recoveryTemporaryRelativePath = recoveryTemporary.relativePath;
        if (!isRegularFileAt(currentAbsPath, unit.sourceIdentity)) {
          throw new Error('Current moved file cannot be verified.');
        }
        if (!compensationDestinationClear(unit.recoveryTemporaryAbsPath)) {
          throw new Error('Recovery temporary path is occupied.');
        }
        runHook('beforeCompensationMove', { unit, from: currentAbsPath, to: unit.recoveryTemporaryAbsPath });
        fs.renameSync(currentAbsPath, unit.recoveryTemporaryAbsPath);
        staged.push(unit);
        if (!isRegularFileAt(unit.recoveryTemporaryAbsPath, unit.sourceIdentity)) {
          throw new Error('Recovery temporary file cannot be verified.');
        }
        runHook('afterCompensationMove', { unit, from: currentAbsPath, to: unit.recoveryTemporaryAbsPath });
      }

      for (const unit of staged) {
        if (!compensationDestinationClear(unit.sourceAbsPath)) {
          throw new Error('Original source path is occupied during recovery.');
        }
        runHook('beforeCompensationRestore', { unit, from: unit.recoveryTemporaryAbsPath, to: unit.sourceAbsPath });
        fs.renameSync(unit.recoveryTemporaryAbsPath, unit.sourceAbsPath);
        if (!isRegularFileAt(unit.sourceAbsPath, unit.sourceIdentity)) {
          throw new Error('Original source file cannot be verified after recovery.');
        }
        runHook('afterCompensationRestore', { unit, from: unit.recoveryTemporaryAbsPath, to: unit.sourceAbsPath });
      }
    } catch {
      failure = true;
    }

    const verification = [];
    for (const unit of execution) {
      const sourceRestored = isRegularFileAt(unit.sourceAbsPath, unit.sourceIdentity);
      const temporaryAbsent = (() => {
        try { return !pathHasFilesystemCollision(unit.temporaryAbsPath); } catch { return false; }
      })();
      const recoveryTemporaryAbsent = (() => {
        if (!unit.recoveryTemporaryAbsPath) return true;
        try { return !pathHasFilesystemCollision(unit.recoveryTemporaryAbsPath); } catch { return false; }
      })();
      const finalAbsent = (() => {
        try { return !pathHasFilesystemCollision(unit.finalAbsPath); } catch { return false; }
      })();
      let databaseOriginal = false;
      try {
        const row = assetRepository.findById(unit.assetId);
        databaseOriginal = databaseRowMatchesPlan(unit.item, row);
      } catch {
        databaseOriginal = false;
      }
      verification.push({
        assetId: unit.assetId,
        sourceRestored,
        temporaryAbsent,
        recoveryTemporaryAbsent,
        finalAbsent,
        databaseOriginal,
      });
    }

    const fullyRestored = !failure && verification.every((state) => (
      state.sourceRestored
      && state.temporaryAbsent
      && state.recoveryTemporaryAbsent
      && state.finalAbsent
      && state.databaseOriginal
    ));
    if (!verification.every((state) => state.databaseOriginal)) databaseState = 'unknown';
    if (fullyRestored) databaseState = 'original';

    return {
      ok: fullyRestored,
      databaseState,
      verification,
    };
  }

  function applyPlanLocked(projectId, orderedAssetIds, authorizedSnapshot, { categoryId } = {}) {
    let plan;
    try {
      plan = buildPlanUnlocked(
        projectId,
        categoryId,
        orderedAssetIds,
      );
    } catch (err) {
      if (
        err instanceof AutoRenameError
        && [
          AUTO_RENAME_ERROR_CODES.PROJECT_NOT_FOUND,
          AUTO_RENAME_ERROR_CODES.PROJECT_ARCHIVED,
          AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID,
          AUTO_RENAME_ERROR_CODES.CATEGORY_DISABLED,
          AUTO_RENAME_ERROR_CODES.CATEGORY_EMPTY,
          AUTO_RENAME_ERROR_CODES.ORDER_INVALID,
        ].includes(err.code)
      ) {
        throw stalePlanError();
      }
      throw err;
    }
    if (canonicalSerialize(plan.snapshot) !== canonicalSerialize(authorizedSnapshot)) {
      throw stalePlanError();
    }
    if (plan.counts.blocked > 0) {
      throw new AutoRenameError(
        'Auto Rename plan contains blocked items and cannot be applied.',
        {
          code: AUTO_RENAME_ERROR_CODES.PLAN_BLOCKED,
          details: { blockedAssetIds: plan.items.filter((item) => item.status === 'blocked').map((item) => item.assetId) },
        }
      );
    }
    if (plan.counts.rename === 0) {
      throw new AutoRenameError(
        'Auto Rename plan has no applicable renames.',
        { code: AUTO_RENAME_ERROR_CODES.NO_CHANGES }
      );
    }

    const validated = revalidateExecutionPlan(projectId, plan);
    const execution = buildExecutionUnits(
      validated.projectDir,
      validated.allProjectRows,
      validated.execution,
      validated.directories,
    );
    const phase1Completed = [];
    const phase2Completed = [];
    let failureStage = 'filesystem-phase-1';
    let databaseState = 'not-started';

    try {
      for (let index = 0; index < execution.length; index++) {
        const unit = execution[index];
        runHook('beforePhase1Move', { unit, index });
        assertProjectStillMutable(projectId, validated.project);
        assertSourceStillPresent(unit);
        assertTemporaryDestinationClear(unit);
        try {
          fs.renameSync(unit.sourceAbsPath, unit.temporaryAbsPath);
        } catch {
          if (isRegularFileAt(unit.temporaryAbsPath, unit.sourceIdentity)) phase1Completed.push(unit);
          throw new Error('Filesystem phase one failed.');
        }
        phase1Completed.push(unit);
        assertSourceGone(unit.sourceAbsPath);
        inspectMovedFile(unit.temporaryAbsPath, unit.sourceIdentity);
        runHook('afterPhase1Move', { unit, index });
      }

      failureStage = 'filesystem-phase-2';
      for (let index = 0; index < execution.length; index++) {
        const unit = execution[index];
        runHook('beforePhase2Move', { unit, index });
        assertProjectStillMutable(projectId, validated.project);
        inspectMovedFile(unit.temporaryAbsPath, unit.sourceIdentity);
        assertFinalDestinationClear(unit);
        try {
          fs.renameSync(unit.temporaryAbsPath, unit.finalAbsPath);
        } catch {
          if (isRegularFileAt(unit.finalAbsPath, unit.sourceIdentity)) phase2Completed.push(unit);
          throw new Error('Filesystem phase two failed.');
        }
        phase2Completed.push(unit);
        assertPathAbsent(unit.temporaryAbsPath);
        unit.finalStats = inspectMovedFile(unit.finalAbsPath, unit.sourceIdentity);
        if (
          unit.finalStats.size !== unit.item.sizeBytes
          || unit.finalStats.mtime.toISOString() !== unit.item.modifiedAt
        ) {
          throw new Error('Final file metadata changed during execution.');
        }
        runHook('afterPhase2Move', { unit, index });
      }

      failureStage = 'database';
      databaseState = 'pending';
      runHook('beforeDatabaseUpdate', { execution, plan });
      for (const unit of execution) {
        unit.finalStats = inspectMovedFile(unit.finalAbsPath, unit.sourceIdentity);
        if (
          unit.finalStats.size !== unit.item.sizeBytes
          || unit.finalStats.mtime.toISOString() !== unit.item.modifiedAt
        ) {
          throw new Error('Final file metadata changed before the database update.');
        }
      }
      if (typeof assetRepository.updateAssetLocations !== 'function') {
        throw new Error('Asset repository does not support atomic location updates.');
      }
      const storedRows = assetRepository.updateAssetLocations(projectId, buildLocationUpdates(execution));
      if (!Array.isArray(storedRows) || storedRows.length !== execution.length) {
        throw new Error('Asset location transaction returned an unexpected row count.');
      }
      for (let index = 0; index < storedRows.length; index++) {
        const stored = storedRows[index];
        const unit = execution[index];
        if (
          !stored
          || stored.id !== unit.assetId
          || stored.relative_path !== unit.item.proposedRelativePath
          || stored.filename !== unit.item.proposedFilename
          || stored.size_bytes !== unit.finalStats.size
          || stored.modified_at !== unit.finalStats.mtime.toISOString()
        ) {
          throw new Error('Asset location transaction returned unexpected data.');
        }
      }
      databaseState = 'committed';

      return {
        renamed: plan.counts.rename,
        unchanged: plan.counts.unchanged,
        selected: plan.counts.selected,
        items: plan.items.map((item) => ({
          assetId: item.assetId,
          previousRelativePath: item.currentRelativePath,
          relativePath: item.proposedRelativePath,
          status: item.status,
        })),
      };
    } catch (err) {
      const compensation = compensateFilesystem(
        projectId,
        validated.project,
        execution,
        phase1Completed,
        phase2Completed,
      );
      if (!compensation.ok) {
        throw new AutoRenameError(
          'Auto Rename could not restore the project after a failed operation. Recovery is required.',
          {
            code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED,
            details: {
              failureStage,
              failureCode: failureStage === 'database'
                ? AUTO_RENAME_ERROR_CODES.DATABASE_ERROR
                : AUTO_RENAME_ERROR_CODES.FILESYSTEM_OPERATION_FAILED,
              databaseState: compensation.databaseState === 'unknown' ? databaseState : compensation.databaseState,
              items: safeRecoveryItems(execution),
              verification: compensation.verification,
            },
          }
        );
      }
      if (phase1Completed.length === 0 && err instanceof AutoRenameError) throw err;
      throw new AutoRenameError(
        'Auto Rename failed; no files were renamed and the original state was restored.',
        {
          code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED,
          details: {
            failureStage,
            failureCode: failureStage === 'database'
              ? AUTO_RENAME_ERROR_CODES.DATABASE_ERROR
              : AUTO_RENAME_ERROR_CODES.FILESYSTEM_OPERATION_FAILED,
            databaseState: compensation.databaseState,
            items: safeRecoveryItems(execution),
            verification: compensation.verification,
          },
        }
      );
    }
  }

  function runApply(projectId, callback) {
    try {
      return projectOperationCoordinator.run(projectId, callback);
    } catch (err) {
      if (err instanceof AutoRenameError) throw err;
      if (err instanceof AutoRenameInspectionError) {
        throw new AutoRenameError(
          'Auto Rename could not inspect the project filesystem.',
          { code: AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED }
        );
      }
      if (err instanceof ProjectOperationError) {
        if (err.code === 'PROJECT_OPERATION_IN_PROGRESS') {
          throw new AutoRenameError(
            'Another operation is already in progress for this project.',
            { code: AUTO_RENAME_ERROR_CODES.PROJECT_BUSY }
          );
        }
        throw new AutoRenameError(
          'Auto Rename could not acquire the project operation lock.',
          { code: AUTO_RENAME_ERROR_CODES.INVALID_PROJECT_ID }
        );
      }
      throw new AutoRenameError(
        'Auto Rename failed; no files were renamed and the original state was restored.',
        { code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED }
      );
    }
  }

  function applyCategoryPlan(projectId, planToken) {
    assertCanonicalPositiveInteger(projectId, 'projectId');
    return runApply(projectId, () => {
      const authorizedSnapshot = authenticateToken(planToken);
      if (
        !authorizedSnapshot
        || authorizedSnapshot.scope !== 'category'
        || authorizedSnapshot.projectId !== projectId
        || authorizedSnapshot.categoryId !== authorizedSnapshot.category?.id
      ) {
        throw stalePlanError();
      }
      return applyPlanLocked(
        projectId,
        authorizedSnapshot.orderedAssetIds,
        authorizedSnapshot,
        { categoryId: authorizedSnapshot.categoryId },
      );
    });
  }

  /**
   * Category-first token-only Apply. The signed snapshot supplies the
   * authorized category membership and exact order; no request order is
   * accepted.
   */
  function applyPlan(projectId, planToken) {
    assertCanonicalPositiveInteger(projectId, 'projectId');
    return applyCategoryPlan(projectId, planToken);
  }

  function authenticateToken(token) {
    const parsedToken = parseToken(token);
    if (!parsedToken) return null;

    const expectedSignature = crypto.createHmac('sha256', key).update(parsedToken.payload).digest();
    if (!constantTimeEqual(expectedSignature, parsedToken.signature)) return null;
    return snapshotFromTokenPayload(parsedToken.payload);
  }

  function verifyPlanToken(planOrSnapshot, token) {
    try {
      const authorizedSnapshot = authenticateToken(token);
      const snapshot = snapshotFromPlanOrSnapshot(planOrSnapshot);
      return Boolean(
        authorizedSnapshot
        && snapshot
        && canonicalSerialize(snapshot) === canonicalSerialize(authorizedSnapshot)
      );
    } catch {
      return false;
    }
  }

  return {
    buildPlan,
    buildCategoryPlan,
    verifyPlanToken,
    applyPlan,
    applyCategoryPlan,
  };
}
