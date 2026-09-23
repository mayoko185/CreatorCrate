import { describe, expect, it } from 'vitest';
import {
  CLOCK_FORMAT_KEY,
  ClockFormatSettingsValidationError,
  createClockFormatSettingsService,
} from '../src/services/clock-format-settings-service.js';

describe('clock format settings service', () => {
  it('uses the 24-hour fallback and persists only valid values', () => {
    const values = new Map();
    const service = createClockFormatSettingsService({
      appMetaRepository: {
        getValue: (key) => values.get(key),
        setValue: (key, value) => {
          values.set(key, value);
          return value;
        },
      },
    });

    expect(service.getClockFormatSetting()).toEqual({ value: '24h', isDefault: true });
    expect(service.setClockFormat('12h')).toBe('12h');
    expect(values.get(CLOCK_FORMAT_KEY)).toBe('12h');
    expect(service.getClockFormat()).toBe('12h');
    expect(service.setClockFormat('24h')).toBe('24h');
    expect(service.getClockFormatSetting()).toEqual({ value: '24h', isDefault: false });
    expect(() => service.setClockFormat('invalid')).toThrow(ClockFormatSettingsValidationError);
    expect(values.get(CLOCK_FORMAT_KEY)).toBe('24h');
  });
});
