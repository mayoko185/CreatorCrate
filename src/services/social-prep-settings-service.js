export const SOCIAL_PREP_ENABLED_KEY = 'social_prep.enabled';
export const SOCIAL_PREP_PLATFORMS_KEY = 'social_prep.platforms';
export const SOCIAL_PREP_SUPPORTED_PLATFORMS = Object.freeze([
  'patreon',
  'x',
  'bluesky',
]);

const ENABLED_VALUE = '1';
const DISABLED_VALUE = '0';

export class SocialPrepSettingsValidationError extends Error {
  constructor(errors) {
    super('Social Preparation settings validation failed');
    this.name = 'SocialPrepSettingsValidationError';
    this.errors = errors;
  }
}

function invalid(errors) {
  throw new SocialPrepSettingsValidationError(errors);
}

function canonicalizePlatforms(platforms) {
  if (!Array.isArray(platforms)) {
    invalid({ platforms: 'Social Preparation platforms must be an array.' });
  }

  const selected = new Set();
  for (const platform of platforms) {
    if (!SOCIAL_PREP_SUPPORTED_PLATFORMS.includes(platform)) {
      invalid({ platforms: `Unsupported Social Preparation platform: ${platform}.` });
    }
    if (selected.has(platform)) {
      invalid({ platforms: `Duplicate Social Preparation platform: ${platform}.` });
    }
    selected.add(platform);
  }

  return SOCIAL_PREP_SUPPORTED_PLATFORMS.filter((platform) => selected.has(platform));
}

function parseStoredPlatforms(value) {
  if (typeof value !== 'string') return [];

  const platforms = value === '' ? [] : value.split(',');
  const uniquePlatforms = new Set(platforms);
  if (
    uniquePlatforms.size !== platforms.length
    || platforms.some((platform) => !SOCIAL_PREP_SUPPORTED_PLATFORMS.includes(platform))
  ) {
    return [];
  }

  const canonical = SOCIAL_PREP_SUPPORTED_PLATFORMS.filter((platform) => uniquePlatforms.has(platform));
  return canonical.join(',') === value ? canonical : [];
}

/**
 * Owns app-wide Social Preparation enablement and platform selection only.
 * Release preparation, persistence, and browser automation stay outside this
 * service.
 */
export function createSocialPrepSettingsService({ appMetaRepository } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createSocialPrepSettingsService requires an appMetaRepository dependency.');
  }

  function isEnabled() {
    return appMetaRepository.getValue(SOCIAL_PREP_ENABLED_KEY) === ENABLED_VALUE;
  }

  function getPlatforms() {
    return parseStoredPlatforms(appMetaRepository.getValue(SOCIAL_PREP_PLATFORMS_KEY));
  }

  function setEnabledWithOutcome(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Social Preparation enabled state must be a boolean.');
    }

    return appMetaRepository.setValueWithOutcome(
      SOCIAL_PREP_ENABLED_KEY,
      enabled ? ENABLED_VALUE : DISABLED_VALUE,
      { fallbackValue: DISABLED_VALUE },
    );
  }

  function setPlatformsWithOutcome(platforms) {
    const canonicalPlatforms = canonicalizePlatforms(platforms);
    return appMetaRepository.setValueWithOutcome(
      SOCIAL_PREP_PLATFORMS_KEY,
      canonicalPlatforms.join(','),
      { fallbackValue: '' },
    );
  }

  return {
    isEnabled,

    getPlatforms,

    getSettings() {
      return { enabled: isEnabled(), platforms: getPlatforms() };
    },

    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') {
        throw new TypeError('Social Preparation enabled state must be a boolean.');
      }
      return appMetaRepository.setValue(
        SOCIAL_PREP_ENABLED_KEY,
        enabled ? ENABLED_VALUE : DISABLED_VALUE,
      );
    },

    setEnabledWithOutcome,

    setPlatforms(platforms) {
      const canonicalPlatforms = canonicalizePlatforms(platforms);
      return appMetaRepository.setValue(
        SOCIAL_PREP_PLATFORMS_KEY,
        canonicalPlatforms.join(','),
      );
    },

    setPlatformsWithOutcome,
  };
}
