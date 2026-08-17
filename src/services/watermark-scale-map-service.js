import { validateScaleMap, WatermarkEngineError } from './watermark-engine.js';

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/u;

export class WatermarkScaleMapServiceError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'WatermarkScaleMapServiceError';
    this.code = code;
  }
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    throw new WatermarkScaleMapServiceError('Scale map display name must be a string.', { code: 'INVALID_SCALE_MAP_NAME' });
  }
  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > 200 || CONTROL_CHARACTERS.test(displayName)) {
    throw new WatermarkScaleMapServiceError('Scale map display name is invalid.', { code: 'INVALID_SCALE_MAP_NAME' });
  }
  return displayName;
}

function compareScaleMapKeys(left, right) {
  if (left === 'default') return right === 'default' ? 0 : 1;
  if (right === 'default') return -1;
  const [leftWidth, leftHeight] = left.split('x').map(Number);
  const [rightWidth, rightHeight] = right.split('x').map(Number);
  return leftWidth - rightWidth || leftHeight - rightHeight;
}

/**
 * Empty maps are valid because the engine validator accepts them: they simply
 * leave every image to the existing manual-scale fallback.
 */
export function normalizeScaleMapDefinition(definition) {
  validateScaleMap(definition);
  return Object.fromEntries(Object.entries(definition).sort(([left], [right]) => compareScaleMapKeys(left, right)));
}

function canonicalDefinitionJson(definition) {
  return JSON.stringify(normalizeScaleMapDefinition(definition));
}

function publicRecord(record) {
  let parsed;
  try {
    parsed = JSON.parse(record.definition_json);
  } catch (cause) {
    throw new WatermarkScaleMapServiceError('Stored scale map definition is invalid.', {
      code: 'SCALE_MAP_INVALID',
      cause,
    });
  }
  try {
    return {
    id: record.id,
    displayName: record.display_name,
    systemKey: record.system_key,
      definition: normalizeScaleMapDefinition(parsed),
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  } catch (cause) {
    throw new WatermarkScaleMapServiceError('Stored scale map definition is invalid.', {
      code: 'SCALE_MAP_INVALID',
      cause,
    });
  }
}

export function createWatermarkScaleMapService({ repository } = {}) {
  if (!repository
    || typeof repository.findById !== 'function'
    || typeof repository.list !== 'function'
    || typeof repository.create !== 'function'
    || typeof repository.rename !== 'function'
    || typeof repository.replaceDefinition !== 'function'
    || typeof repository.delete !== 'function') {
    throw new Error('createWatermarkScaleMapService requires a scale-map repository.');
  }

  function requireRecord(id) {
    if (!isPositiveId(id)) {
      throw new WatermarkScaleMapServiceError('scaleMapId must be a positive integer.', { code: 'INVALID_SCALE_MAP_ID' });
    }
    const record = repository.findById(id);
    if (!record) throw new WatermarkScaleMapServiceError('Scale map not found.', { code: 'SCALE_MAP_NOT_FOUND' });
    return record;
  }

  function normalizeInputDefinition(definition) {
    try {
      return canonicalDefinitionJson(definition);
    } catch (cause) {
      if (cause instanceof WatermarkEngineError) {
        throw new WatermarkScaleMapServiceError(cause.message, { code: cause.code, cause });
      }
      throw cause;
    }
  }

  function mapRepositoryError(error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new WatermarkScaleMapServiceError('A scale map with that display name already exists.', {
        code: 'SCALE_MAP_NAME_CONFLICT',
        cause: error,
      });
    }
    // better-sqlite3 can surface a DELETE RESTRICT failure as either the
    // foreign-key extended code or SQLITE_CONSTRAINT_TRIGGER depending on the
    // SQLite build, so normalize both database details at this boundary.
    if (error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
      || (error?.code === 'SQLITE_CONSTRAINT_TRIGGER' && /foreign key/i.test(error?.message || ''))) {
      throw new WatermarkScaleMapServiceError('This scale map is used by one or more processing presets.', {
        code: 'SCALE_MAP_IN_USE',
        cause: error,
      });
    }
    throw error;
  }

  return {
    listScaleMaps() { return repository.list().map(publicRecord); },
    getScaleMap(id) { return publicRecord(requireRecord(id)); },
    createScaleMap({ displayName, definition } = {}) {
      try {
        return publicRecord(repository.create({
          displayName: normalizeDisplayName(displayName),
          definitionJson: normalizeInputDefinition(definition),
        }));
      } catch (error) {
        mapRepositoryError(error);
      }
    },
    renameScaleMap(id, displayName) {
      requireRecord(id);
      try {
        const record = repository.rename(id, normalizeDisplayName(displayName));
        if (!record) throw new WatermarkScaleMapServiceError('Scale map not found.', { code: 'SCALE_MAP_NOT_FOUND' });
        return publicRecord(record);
      } catch (error) {
        mapRepositoryError(error);
      }
    },
    replaceScaleMap(id, definition) {
      requireRecord(id);
      const record = repository.replaceDefinition(id, normalizeInputDefinition(definition));
      if (!record) throw new WatermarkScaleMapServiceError('Scale map not found.', { code: 'SCALE_MAP_NOT_FOUND' });
      return publicRecord(record);
    },
    deleteScaleMap(id) {
      requireRecord(id);
      try {
        const record = repository.delete(id);
        if (!record) throw new WatermarkScaleMapServiceError('Scale map not found.', { code: 'SCALE_MAP_NOT_FOUND' });
        return publicRecord(record);
      } catch (error) {
        mapRepositoryError(error);
      }
    },
    resolveForProcessing(id) {
      const scaleMap = publicRecord(requireRecord(id));
      return { scaleMap, definition: scaleMap.definition };
    },
  };
}
