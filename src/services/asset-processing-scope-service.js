import { normalizeProjectRelativePath } from '../storage/asset-file.js';

export class AssetProcessingScopeError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'AssetProcessingScopeError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertProjectId(projectId) {
  if (!isPositiveSafeInteger(projectId)) {
    throw new AssetProcessingScopeError('projectId must be a positive integer.', {
      code: 'INVALID_PROJECT_ID',
    });
  }
}

function assertAssetId(assetId, label = 'assetId') {
  if (!isPositiveSafeInteger(assetId)) {
    throw new AssetProcessingScopeError(`${label} must be a positive integer.`, {
      code: 'INVALID_ASSET_ID',
    });
  }
}

function normalizeDirectory(relativePath, label = 'relativePath') {
  try {
    return normalizeProjectRelativePath(relativePath, { allowEmpty: true });
  } catch (cause) {
    throw new AssetProcessingScopeError(
      `${label} must be a canonical project-relative directory.`,
      { code: 'INVALID_DIRECTORY', cause },
    );
  }
}

function normalizeRecursive(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new AssetProcessingScopeError(`${label} recursive must be a boolean.`, {
      code: 'INVALID_SCOPE',
    });
  }
  return value;
}

function normalizeSelectedScope(scope) {
  if (!Array.isArray(scope.assetIds) || scope.assetIds.length === 0) {
    throw new AssetProcessingScopeError('selected assetIds must be a non-empty array.', {
      code: 'INVALID_SCOPE',
    });
  }

  const assetIds = [];
  const seen = new Set();
  for (const assetId of scope.assetIds) {
    assertAssetId(assetId);
    if (seen.has(assetId)) {
      throw new AssetProcessingScopeError('Duplicate asset IDs in selected scope.', {
        code: 'DUPLICATE_ASSET_SELECTION',
      });
    }
    seen.add(assetId);
    assetIds.push(assetId);
  }

  return { type: 'selected', assetIds };
}

function normalizeDirectoryScope(scope) {
  if (!Object.hasOwn(scope, 'relativePath')) {
    throw new AssetProcessingScopeError('directory relativePath is required.', {
      code: 'INVALID_SCOPE',
    });
  }

  return {
    type: 'directory',
    relativePath: normalizeDirectory(scope.relativePath),
    recursive: normalizeRecursive(scope.recursive, 'directory'),
  };
}

function normalizeMixedScope(scope) {
  if (!Array.isArray(scope.entries) || scope.entries.length === 0) {
    throw new AssetProcessingScopeError('mixed entries must be a non-empty array.', {
      code: 'INVALID_SCOPE',
    });
  }

  const entries = scope.entries.map((entry, index) => {
    const label = `mixed entry ${index}`;
    if (!isRecord(entry) || typeof entry.type !== 'string') {
      throw new AssetProcessingScopeError(`${label} is malformed.`, { code: 'INVALID_SCOPE' });
    }

    if (entry.type === 'asset') {
      assertAssetId(entry.assetId, `${label} assetId`);
      return { type: 'asset', assetId: entry.assetId };
    }

    if (entry.type === 'directory') {
      if (!Object.hasOwn(entry, 'relativePath')) {
        throw new AssetProcessingScopeError(`${label} relativePath is required.`, {
          code: 'INVALID_SCOPE',
        });
      }
      return {
        type: 'directory',
        relativePath: normalizeDirectory(entry.relativePath, `${label} relativePath`),
        recursive: normalizeRecursive(entry.recursive, label),
      };
    }

    throw new AssetProcessingScopeError(`${label} has an unsupported type.`, {
      code: 'INVALID_SCOPE',
    });
  });

  return { type: 'mixed', entries };
}

function normalizeScope(scope) {
  if (!isRecord(scope) || typeof scope.type !== 'string') {
    throw new AssetProcessingScopeError('A valid asset processing scope is required.', {
      code: 'INVALID_SCOPE',
    });
  }

  if (scope.type === 'selected') return normalizeSelectedScope(scope);
  if (scope.type === 'directory') return normalizeDirectoryScope(scope);
  if (scope.type === 'mixed') return normalizeMixedScope(scope);

  throw new AssetProcessingScopeError(`Unsupported asset processing scope type: ${scope.type}.`, {
    code: 'INVALID_SCOPE',
  });
}

function isPresent(asset) {
  return asset?.is_present === 1 || asset?.is_present === true;
}

/**
 * Create the read-only resolver shared by future Convert, Watermark, and
 * Workflow Prompt Editor planning. It maps Convert/Watermark directory plus
 * --recursive false/true to directory scopes. Workflow Prompt Editor's
 * explicit files, non-recursive directories, and mixed positional inputs map
 * to selected, directory, and mixed entries respectively.
 *
 * @param {object} deps
 * @param {object} deps.projectRepository
 * @param {ReturnType<import('../data/asset-repository.js').createAssetRepository>} deps.assetRepository
 */
export function createAssetProcessingScopeService({ projectRepository, assetRepository } = {}) {
  if (!projectRepository || typeof projectRepository.findById !== 'function') {
    throw new Error('createAssetProcessingScopeService requires a projectRepository dependency.');
  }
  if (!assetRepository
    || typeof assetRepository.findByIds !== 'function'
    || typeof assetRepository.findPresentProjectAssetsByDirectory !== 'function') {
    throw new Error('createAssetProcessingScopeService requires an assetRepository dependency.');
  }

  function requireProject(projectId) {
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new AssetProcessingScopeError(`Project ${projectId} not found.`, {
        code: 'PROJECT_NOT_FOUND',
      });
    }
    return project;
  }

  function resolveExplicitAssets(projectId, assetIds) {
    const rows = assetRepository.findByIds(assetIds);
    const byId = new Map(rows.map((asset) => [asset.id, asset]));
    const resolved = new Map();

    for (const assetId of assetIds) {
      const asset = byId.get(assetId);
      if (!asset) {
        throw new AssetProcessingScopeError(`Asset ${assetId} not found.`, {
          code: 'ASSET_NOT_FOUND',
        });
      }
      if (asset.project_id !== projectId) {
        throw new AssetProcessingScopeError(`Asset ${assetId} does not belong to project ${projectId}.`, {
          code: 'ASSET_PROJECT_MISMATCH',
        });
      }
      if (!isPresent(asset)) {
        throw new AssetProcessingScopeError(`Asset ${assetId} is currently missing.`, {
          code: 'ASSET_MISSING',
        });
      }
      resolved.set(assetId, asset);
    }

    return resolved;
  }

  function appendUnique(target, seen, assets) {
    for (const asset of assets) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      target.push(asset);
    }
  }

  function directoryAssets(projectId, entry) {
    return assetRepository.findPresentProjectAssetsByDirectory(
      projectId,
      entry.relativePath,
      { recursive: entry.recursive },
    );
  }

  /**
   * Resolve only currently indexed, present assets. This method performs no
   * filesystem access, scanner invocation, database mutation, or operation
   * type filtering.
   *
   * @param {number} projectId
   * @param {{type: 'selected', assetIds: number[]}|{type: 'directory', relativePath: string, recursive?: boolean}|{type: 'mixed', entries: Array}} scope
   * @returns {{projectId: number, scope: object, assetIds: number[], assets: object[]}}
   */
  function resolveAssetProcessingScope(projectId, scope) {
    assertProjectId(projectId);
    requireProject(projectId);
    const normalizedScope = normalizeScope(scope);

    const explicitIds = normalizedScope.type === 'selected'
      ? normalizedScope.assetIds
      : normalizedScope.type === 'mixed'
        ? [...new Set(normalizedScope.entries
          .filter((entry) => entry.type === 'asset')
          .map((entry) => entry.assetId))]
        : [];
    const explicitAssets = explicitIds.length > 0
      ? resolveExplicitAssets(projectId, explicitIds)
      : new Map();

    const assets = [];
    const seen = new Set();

    if (normalizedScope.type === 'selected') {
      appendUnique(assets, seen, normalizedScope.assetIds.map((assetId) => explicitAssets.get(assetId)));
    } else if (normalizedScope.type === 'directory') {
      appendUnique(assets, seen, directoryAssets(projectId, normalizedScope));
    } else {
      for (const entry of normalizedScope.entries) {
        if (entry.type === 'asset') {
          appendUnique(assets, seen, [explicitAssets.get(entry.assetId)]);
        } else {
          appendUnique(assets, seen, directoryAssets(projectId, entry));
        }
      }
    }

    return {
      projectId,
      scope: normalizedScope,
      assetIds: assets.map((asset) => asset.id),
      assets,
    };
  }

  return { resolveAssetProcessingScope };
}
