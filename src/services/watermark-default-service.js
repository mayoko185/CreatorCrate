import { WatermarkServiceError } from './watermark-service.js';

export const DEFAULT_WATERMARK_META_KEY = 'processing.watermark.default_id';

function parseStoredId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function parseWatermarkId(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new WatermarkServiceError('watermarkId must be a positive integer.', { code: 'INVALID_WATERMARK_ID' });
  }
  return value;
}

export function createWatermarkDefaultService({ appMetaRepository, watermarkService } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function' || typeof appMetaRepository.setValue !== 'function') {
    throw new TypeError('createWatermarkDefaultService requires an app metadata repository.');
  }
  if (!watermarkService || typeof watermarkService.resolveForProcessing !== 'function') {
    throw new TypeError('createWatermarkDefaultService requires a watermark service.');
  }

  function getDefaultWatermarkId() {
    const id = parseStoredId(appMetaRepository.getValue(DEFAULT_WATERMARK_META_KEY));
    if (id === null) return null;
    try {
      watermarkService.resolveForProcessing(id);
      return id;
    } catch {
      return null;
    }
  }

  return {
    getDefaultWatermarkId,

    setDefaultWatermarkId(value) {
      const id = parseWatermarkId(value);
      watermarkService.resolveForProcessing(id);
      appMetaRepository.setValue(DEFAULT_WATERMARK_META_KEY, String(id));
      return getDefaultWatermarkId();
    },
  };
}
