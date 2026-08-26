import { validateScaleMap, WatermarkEngineError } from './watermark-engine.js';

const REFERENCE_SCALE_MAP_SYSTEM_KEY = 'reference-watermark-scale-map';

export class WatermarkScaleMapServiceError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'WatermarkScaleMapServiceError';
    this.code = code;
  }
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
      definition: normalizeScaleMapDefinition(parsed),
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
    || typeof repository.findBySystemKey !== 'function'
    || typeof repository.replaceDefinition !== 'function') {
    throw new Error('createWatermarkScaleMapService requires a scale-map repository.');
  }

  function requireCanonicalRecord() {
    const record = repository.findBySystemKey(REFERENCE_SCALE_MAP_SYSTEM_KEY);
    if (!record) throw new WatermarkScaleMapServiceError('Canonical scale map not found.', { code: 'SCALE_MAP_NOT_FOUND' });
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

  function replaceScaleMapWithOutcome(definition) {
    const current = requireCanonicalRecord();
    const definitionJson = normalizeInputDefinition(definition);
    if (canonicalDefinitionJson(publicRecord(current).definition) === definitionJson) {
      return { scaleMap: publicRecord(current), changed: false };
    }
    const record = repository.replaceDefinition(current.id, definitionJson);
    if (!record) throw new WatermarkScaleMapServiceError('Canonical scale map not found.', { code: 'SCALE_MAP_NOT_FOUND' });
    return { scaleMap: publicRecord(record), changed: true };
  }

  return {
    getScaleMap() { return publicRecord(requireCanonicalRecord()); },
    replaceScaleMap(definition) { return replaceScaleMapWithOutcome(definition).scaleMap; },
    replaceScaleMapWithOutcome,
    resolveForProcessing() {
      const scaleMap = publicRecord(requireCanonicalRecord());
      return { scaleMap, definition: scaleMap.definition };
    },
  };
}
