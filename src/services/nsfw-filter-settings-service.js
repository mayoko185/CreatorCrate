import { TagValidationError } from './tag-service.js';

export const NSFW_FILTER_ENABLED_KEY = 'nsfw_filter.enabled';
export const NSFW_TAG_NAME = 'NSFW';

const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();
const ENABLED_VALUE = '1';
const DISABLED_VALUE = '0';

function isNsfwTag(tag) {
  return [tag?.display_name, tag?.normalized_name].some((value) => (
    typeof value === 'string' && value.trim().toLowerCase() === NSFW_TAG_NORMALIZED_NAME
  ));
}

/**
 * Owns the NSFW filter's app-level state and its required global tag.
 * Image filtering and presentation behavior deliberately stay outside this
 * service.
 */
export function createNsfwFilterSettingsService({ appMetaRepository, tagService } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createNsfwFilterSettingsService requires an appMetaRepository dependency.');
  }
  if (!tagService || typeof tagService.listTags !== 'function'
    || typeof tagService.createTag !== 'function') {
    throw new Error('createNsfwFilterSettingsService requires a tagService dependency.');
  }

  function findNsfwTag() {
    return tagService.listTags().find(isNsfwTag);
  }

  function ensureNsfwTag() {
    const existing = findNsfwTag();
    if (existing) return existing;

    try {
      return tagService.createTag({ name: NSFW_TAG_NAME });
    } catch (error) {
      // A concurrent enable may create the tag after the initial lookup but
      // before createTag executes. Treat that unique-name race as idempotent.
      if (error instanceof TagValidationError) {
        const concurrent = findNsfwTag();
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  return {
    isEnabled() {
      return appMetaRepository.getValue(NSFW_FILTER_ENABLED_KEY) === ENABLED_VALUE;
    },

    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') {
        throw new TypeError('NSFW filter enabled state must be a boolean.');
      }

      if (enabled) ensureNsfwTag();
      return appMetaRepository.setValue(
        NSFW_FILTER_ENABLED_KEY,
        enabled ? ENABLED_VALUE : DISABLED_VALUE,
      );
    },
  };
}
