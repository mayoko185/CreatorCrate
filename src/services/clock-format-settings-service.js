export const CLOCK_FORMAT_KEY = 'display.clock_format';
export const DEFAULT_CLOCK_FORMAT = '24h';

export class ClockFormatSettingsValidationError extends Error {
  constructor() {
    super('Clock format must be 12h or 24h.');
    this.name = 'ClockFormatSettingsValidationError';
  }
}

export function validateClockFormat(value) {
  if (value !== '12h' && value !== '24h') {
    throw new ClockFormatSettingsValidationError();
  }
  return value;
}

export function createClockFormatSettingsService({ appMetaRepository } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createClockFormatSettingsService requires an appMetaRepository dependency.');
  }

  function getClockFormatSetting() {
    const stored = appMetaRepository.getValue(CLOCK_FORMAT_KEY);
    return stored === undefined
      ? { value: DEFAULT_CLOCK_FORMAT, isDefault: true }
      : { value: validateClockFormat(stored), isDefault: false };
  }

  return {
    getClockFormatSetting,
    getClockFormat() {
      return getClockFormatSetting().value;
    },

    setClockFormat(value) {
      return appMetaRepository.setValue(CLOCK_FORMAT_KEY, validateClockFormat(value));
    },
  };
}
