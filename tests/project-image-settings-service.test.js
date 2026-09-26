import { describe, expect, it } from 'vitest';
import {
  PROJECT_IMAGE_FIELDS,
  PROJECT_IMAGE_SETTINGS,
  createProjectImageSettingsService,
} from '../src/services/project-image-settings-service.js';

describe('project image settings policy', () => {
  function fixture() {
    const values = new Map();
    const service = createProjectImageSettingsService({
      appMetaRepository: {
        getValue: (key) => values.get(key),
        setValue: (key, value) => values.set(key, value),
      },
    });
    return { values, service };
  }

  it('resolves missing settings without writing app_meta', () => {
    const { values, service } = fixture();
    expect(service.getPolicy()).toEqual({
      thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'webp', webpQuality: 90, maxDimension: 1600 },
    });
    expect(values.size).toBe(0);
    for (const name of Object.keys(PROJECT_IMAGE_SETTINGS)) {
      expect(service.getSetting(name).isDefault).toBe(true);
    }
  });

  it('validates and persists a single effective policy', () => {
    const { values, service } = fixture();
    const submitted = {
      imagesThumbnailFormat: 'png',
      imagesThumbnailWebpQuality: '95',
      imagesThumbnailMaxDimension: '64',
      imagesPreviewFormat: 'original',
      imagesPreviewWebpQuality: '1',
      imagesPreviewMaxDimension: '2560',
    };
    const result = service.validateSubmitted(submitted);
    expect(result.errors).toEqual({});
    expect(service.saveValidated(result.values)).toBe(6);
    expect(service.getPolicy()).toEqual({
      thumbnail: { format: 'png', webpQuality: 95, maxDimension: 64 },
      preview: { format: 'original', webpQuality: 1, maxDimension: 2560 },
    });
    for (const [name, definition] of Object.entries(PROJECT_IMAGE_SETTINGS)) {
      expect(values.get(definition.key)).toBe(submitted[PROJECT_IMAGE_FIELDS[name]]);
    }
  });

  it.each([
    ['imagesThumbnailFormat', 'original'],
    ['imagesPreviewFormat', 'gif'],
    ['imagesThumbnailWebpQuality', '0'],
    ['imagesThumbnailWebpQuality', '96'],
    ['imagesThumbnailWebpQuality', '1.5'],
    ['imagesPreviewWebpQuality', '0'],
    ['imagesPreviewWebpQuality', '96'],
    ['imagesPreviewWebpQuality', '2.5'],
    ['imagesThumbnailMaxDimension', '63'],
    ['imagesThumbnailMaxDimension', '513'],
    ['imagesThumbnailMaxDimension', '64.5'],
    ['imagesPreviewMaxDimension', '319'],
    ['imagesPreviewMaxDimension', '2561'],
    ['imagesPreviewMaxDimension', '320.5'],
  ])('rejects %s = %s', (field, value) => {
    const { service } = fixture();
    expect(service.validateSubmitted({ [field]: value }).errors).toHaveProperty(field);
  });
});
