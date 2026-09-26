import { projectImagePresentationPolicy } from './project-image-policy.js';

export const PROJECT_IMAGE_SETTINGS = Object.freeze({
  thumbnailFormat: { key: 'images.thumbnail.format', defaultValue: 'webp', values: ['webp', 'png'] },
  thumbnailWebpQuality: { key: 'images.thumbnail.webp_quality', defaultValue: 80, min: 1, max: 95 },
  thumbnailMaxDimension: { key: 'images.thumbnail.max_dimension', defaultValue: 256, min: 64, max: 512 },
  previewFormat: { key: 'images.preview.format', defaultValue: 'webp', values: ['webp', 'png', 'original'] },
  previewWebpQuality: { key: 'images.preview.webp_quality', defaultValue: 90, min: 1, max: 95 },
  previewMaxDimension: { key: 'images.preview.max_dimension', defaultValue: 1600, min: 320, max: 2560 },
});

export const PROJECT_IMAGE_FIELDS = Object.freeze(Object.fromEntries(
  Object.keys(PROJECT_IMAGE_SETTINGS).map((name) => [name, `images${name[0].toUpperCase()}${name.slice(1)}`]),
));

export function validateProjectImageSetting(name, value) {
  const definition = PROJECT_IMAGE_SETTINGS[name];
  if (!definition) throw new Error(`Unknown project image setting: ${name}`);
  if (definition.values) {
    if (typeof value === 'string' && definition.values.includes(value)) return value;
    throw new Error(`${name.includes('thumbnail') ? 'Thumbnail' : 'Preview'} format must be ${definition.values.join(', ')}.`);
  }
  if ((typeof value !== 'string' && typeof value !== 'number')
    || !/^\d+$/.test(String(value))
    || !Number.isSafeInteger(Number(value))
    || Number(value) < definition.min
    || Number(value) > definition.max) {
    const label = name.includes('Quality') ? 'WebP quality' : 'Maximum dimension';
    throw new Error(`${label} must be an integer from ${definition.min} to ${definition.max}.`);
  }
  return Number(value);
}

export function createProjectImageSettingsService({ appMetaRepository, sourceAnimationService } = {}) {
  if (!appMetaRepository?.getValue || !appMetaRepository?.setValue) {
    throw new Error('createProjectImageSettingsService requires an appMetaRepository dependency.');
  }

  function getSetting(name) {
    const definition = PROJECT_IMAGE_SETTINGS[name];
    const stored = appMetaRepository.getValue(definition.key);
    if (stored === undefined) return { value: definition.defaultValue, isDefault: true };
    try {
      return { value: validateProjectImageSetting(name, stored), isDefault: false };
    } catch {
      return { value: definition.defaultValue, isDefault: true };
    }
  }

  function getPolicy() {
    return {
      thumbnail: {
        format: getSetting('thumbnailFormat').value,
        webpQuality: getSetting('thumbnailWebpQuality').value,
        maxDimension: getSetting('thumbnailMaxDimension').value,
      },
      preview: {
        format: getSetting('previewFormat').value,
        webpQuality: getSetting('previewWebpQuality').value,
        maxDimension: getSetting('previewMaxDimension').value,
      },
    };
  }

  function validateSubmitted(body) {
    const values = {};
    const errors = {};
    for (const name of Object.keys(PROJECT_IMAGE_SETTINGS)) {
      const field = PROJECT_IMAGE_FIELDS[name];
      const submitted = Object.hasOwn(body, field) ? body[field] : getSetting(name).value;
      try {
        values[name] = validateProjectImageSetting(name, submitted);
      } catch (error) {
        errors[field] = error.message;
      }
    }
    return { values, errors };
  }

  function saveValidated(values) {
    let changed = 0;
    for (const [name, definition] of Object.entries(PROJECT_IMAGE_SETTINGS)) {
      const value = String(values[name]);
      const previous = getSetting(name).value;
      appMetaRepository.setValue(definition.key, value);
      if (previous !== values[name]) changed += 1;
    }
    return changed;
  }

  return {
    getSetting, getPolicy, validateSubmitted, saveValidated,
    getPresentationPolicy: (policy = getPolicy()) => projectImagePresentationPolicy(policy, sourceAnimationService),
  };
}
