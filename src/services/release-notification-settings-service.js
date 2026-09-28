export const RELEASE_NOTIFICATION_SETTINGS_KEY = 'release_notifications.settings';
export const RELEASE_NOTIFICATION_SETTINGS_VERSION = 1;
export const RELEASE_NOTIFICATION_CHANNELS = Object.freeze(['email', 'ntfy', 'gotify', 'webhook']);
export const DEFAULT_DATE_ONLY_TIME = '09:00';

const MINUTE = 1;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RELEASE_NOTIFICATION_TIMING_LIMITS = Object.freeze({
  advanceLeadMinutes: Object.freeze({ min: 1 * MINUTE, max: 30 * DAY }),
  overdueGraceMinutes: Object.freeze({ min: 0, max: 30 * DAY }),
  overdueRepeatIntervalMinutes: Object.freeze({ min: 1 * HOUR, max: 30 * DAY }),
});

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// Deliberately loose: deliverability is proven by the transport, not a regex.
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+$/;
const EMAIL_ADDRESS_MAX_LENGTH = 254;

export class ReleaseNotificationSettingsValidationError extends Error {
  constructor(errors) {
    super('Release notification settings validation failed');
    this.name = 'ReleaseNotificationSettingsValidationError';
    this.errors = errors;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultChannelActivation() {
  return Object.fromEntries(RELEASE_NOTIFICATION_CHANNELS.map((channel) => [
    channel, { generation: 0, activatedAt: null },
  ]));
}

export function defaultReleaseNotificationPreferences() {
  return {
    enabled: false,
    enabledChannels: [],
    emailRecipient: null,
    dateOnlyTime: DEFAULT_DATE_ONLY_TIME,
    advance: { enabled: false, leadMinutes: 1 * DAY },
    scheduled: { enabled: true },
    overdue: { enabled: true, graceMinutes: 1 * HOUR },
    overdueRepeat: { enabled: false, intervalMinutes: 1 * DAY },
  };
}

function defaultSettings() {
  return {
    version: RELEASE_NOTIFICATION_SETTINGS_VERSION,
    ...defaultReleaseNotificationPreferences(),
    activation: { activatedAt: null, channels: defaultChannelActivation() },
  };
}

function parseInteger(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function readBoolean(section, errors, field) {
  if (typeof section?.enabled !== 'boolean') {
    errors[field] = 'Must be true or false.';
    return false;
  }
  return section.enabled;
}

function readMinutes(value, errors, field, { min, max }) {
  const parsed = parseInteger(value);
  if (parsed === undefined || parsed < min || parsed > max) {
    errors[field] = `Must be a whole number of minutes from ${min} to ${max}.`;
    return undefined;
  }
  return parsed;
}

function canonicalizeChannels(channels, errors) {
  if (!Array.isArray(channels)) {
    errors.enabledChannels = 'Channels must be a list.';
    return [];
  }
  const selected = new Set();
  for (const channel of channels) {
    if (!RELEASE_NOTIFICATION_CHANNELS.includes(channel)) {
      errors.enabledChannels = 'Unknown notification channel.';
      return [];
    }
    if (selected.has(channel)) {
      errors.enabledChannels = 'Each notification channel may be selected once.';
      return [];
    }
    selected.add(channel);
  }
  return RELEASE_NOTIFICATION_CHANNELS.filter((channel) => selected.has(channel));
}

/**
 * Validate and canonicalize the user-editable preferences. Activation
 * metadata is never accepted from input; it is derived when saving.
 * Transport readiness (credentials, endpoints) is deliberately not checked:
 * it is runtime configuration, not a stored preference.
 */
export function validateReleaseNotificationPreferences(input) {
  if (!isPlainObject(input)) {
    throw new ReleaseNotificationSettingsValidationError({ settings: 'Settings must be an object.' });
  }
  const errors = {};
  const limits = RELEASE_NOTIFICATION_TIMING_LIMITS;

  const enabled = readBoolean(input, errors, 'enabled');
  const enabledChannels = canonicalizeChannels(input.enabledChannels, errors);

  let emailRecipient = null;
  if (input.emailRecipient !== undefined && input.emailRecipient !== null) {
    const trimmed = typeof input.emailRecipient === 'string' ? input.emailRecipient.trim() : undefined;
    if (trimmed === undefined
      || (trimmed !== '' && (!EMAIL_ADDRESS.test(trimmed) || trimmed.length > EMAIL_ADDRESS_MAX_LENGTH))) {
      errors.emailRecipient = 'Enter a valid email address.';
    } else {
      emailRecipient = trimmed === '' ? null : trimmed;
    }
  }

  const dateOnlyTime = input.dateOnlyTime;
  if (typeof dateOnlyTime !== 'string' || !HH_MM.test(dateOnlyTime)) {
    errors.dateOnlyTime = 'Date-only notification time must be HH:MM.';
  }

  const advance = {
    enabled: readBoolean(input.advance, errors, 'advance.enabled'),
    leadMinutes: readMinutes(input.advance?.leadMinutes, errors, 'advance.leadMinutes', limits.advanceLeadMinutes),
  };
  const scheduled = { enabled: readBoolean(input.scheduled, errors, 'scheduled.enabled') };
  const overdue = {
    enabled: readBoolean(input.overdue, errors, 'overdue.enabled'),
    graceMinutes: readMinutes(input.overdue?.graceMinutes, errors, 'overdue.graceMinutes', limits.overdueGraceMinutes),
  };
  const overdueRepeat = {
    enabled: readBoolean(input.overdueRepeat, errors, 'overdueRepeat.enabled'),
    intervalMinutes: readMinutes(
      input.overdueRepeat?.intervalMinutes, errors, 'overdueRepeat.intervalMinutes',
      limits.overdueRepeatIntervalMinutes,
    ),
  };

  if (enabled && enabledChannels.length === 0 && !errors.enabledChannels) {
    errors.enabledChannels = 'Select at least one channel to enable release notifications.';
  }
  // A zero-grace overdue notice would fire at the same instant as the
  // scheduled notice, sending two messages for one moment.
  if (scheduled.enabled && overdue.enabled && overdue.graceMinutes === 0) {
    errors['overdue.graceMinutes'] = 'Overdue grace must be above zero while the scheduled notification is enabled.';
  }
  if (overdueRepeat.enabled && !overdue.enabled) {
    errors['overdueRepeat.enabled'] = 'Repeat overdue reminders require overdue reminders.';
  }

  if (Object.keys(errors).length > 0) {
    throw new ReleaseNotificationSettingsValidationError(errors);
  }
  return { enabled, enabledChannels, emailRecipient, dateOnlyTime, advance, scheduled, overdue, overdueRepeat };
}

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/**
 * A UTC ISO-8601 instant as written by Date#toISOString(). The parsed UTC
 * fields must round-trip, so impossible dates such as 30 Feb are rejected
 * instead of being normalized into a different instant.
 */
function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_UTC.exec(value);
  if (!match) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function normalizeActivation(activation) {
  if (!isPlainObject(activation) || !isPlainObject(activation.channels)) return undefined;
  if (activation.activatedAt !== null && !isIsoTimestamp(activation.activatedAt)) return undefined;
  const channels = {};
  for (const channel of RELEASE_NOTIFICATION_CHANNELS) {
    const entry = activation.channels[channel];
    if (!isPlainObject(entry) || !Number.isSafeInteger(entry.generation) || entry.generation < 0) return undefined;
    if (entry.activatedAt !== null && !isIsoTimestamp(entry.activatedAt)) return undefined;
    if ((entry.generation === 0) !== (entry.activatedAt === null)) return undefined;
    channels[channel] = { generation: entry.generation, activatedAt: entry.activatedAt };
  }
  return { activatedAt: activation.activatedAt, channels };
}

/**
 * A stored document that no longer validates falls back to the disabled
 * defaults. Disabled is the safe direction: any queued delivery then fails
 * revalidation instead of sending under settings nobody chose.
 */
export function normalizeStoredReleaseNotificationSettings(value) {
  let document;
  try {
    document = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    document = undefined;
  }
  if (!isPlainObject(document) || document.version !== RELEASE_NOTIFICATION_SETTINGS_VERSION) {
    return defaultSettings();
  }
  let preferences;
  try {
    preferences = validateReleaseNotificationPreferences(document);
  } catch (err) {
    if (err instanceof ReleaseNotificationSettingsValidationError) return defaultSettings();
    throw err;
  }
  const activation = normalizeActivation(document.activation);
  if (!activation) return defaultSettings();
  return { version: RELEASE_NOTIFICATION_SETTINGS_VERSION, ...preferences, activation };
}

export function isChannelActive(settings, channel) {
  return settings.enabled && settings.enabledChannels.includes(channel);
}

/** Effective per-reason enablement; repeats additionally depend on overdue. */
export function isReasonEnabled(settings, reason) {
  switch (reason) {
    case 'release.advance': return settings.advance.enabled;
    case 'release.scheduled': return settings.scheduled.enabled;
    case 'release.overdue': return settings.overdue.enabled;
    case 'release.overdue_repeat': return settings.overdue.enabled && settings.overdueRepeat.enabled;
    default: return false;
  }
}

const REASONS = ['release.advance', 'release.scheduled', 'release.overdue', 'release.overdue_repeat'];

export function createReleaseNotificationSettingsService({ appMetaRepository } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createReleaseNotificationSettingsService requires an appMetaRepository dependency.');
  }

  function getSettings() {
    return normalizeStoredReleaseNotificationSettings(
      appMetaRepository.getValue(RELEASE_NOTIFICATION_SETTINGS_KEY),
    );
  }

  /**
   * Save preferences and derive activation metadata from the transition.
   * A channel that becomes effectively active (global enabled and selected)
   * gets a new generation and activation instant; other channels' metadata
   * is untouched. Turning notifications on from off re-establishes the global
   * baseline so a long disabled period cannot flood historical notices.
   * Callers that must cancel queued work atomically with the save should run
   * this inside their own transaction.
   */
  function saveSettings(input, { now = new Date() } = {}) {
    const preferences = validateReleaseNotificationPreferences(input);
    const previous = getSettings();
    const nowIso = now.toISOString();

    const activation = {
      activatedAt: previous.activation.activatedAt,
      channels: structuredClone(previous.activation.channels),
    };
    const globallyActivated = !previous.enabled && preferences.enabled;
    if (globallyActivated) activation.activatedAt = nowIso;

    const activatedChannels = [];
    const deactivatedChannels = [];
    for (const channel of RELEASE_NOTIFICATION_CHANNELS) {
      const wasActive = isChannelActive(previous, channel);
      const isActive = isChannelActive(preferences, channel);
      if (!wasActive && isActive) {
        activation.channels[channel] = {
          generation: previous.activation.channels[channel].generation + 1,
          activatedAt: nowIso,
        };
        activatedChannels.push(channel);
      } else if (wasActive && !isActive) {
        deactivatedChannels.push(channel);
      }
    }

    const disabledReasons = REASONS.filter((reason) => isReasonEnabled(previous, reason)
      && !isReasonEnabled(preferences, reason));

    const settings = { version: RELEASE_NOTIFICATION_SETTINGS_VERSION, ...preferences, activation };
    appMetaRepository.setValue(RELEASE_NOTIFICATION_SETTINGS_KEY, JSON.stringify(settings));
    return {
      settings,
      previous,
      changes: {
        globallyActivated,
        globallyDeactivated: previous.enabled && !preferences.enabled,
        activatedChannels,
        deactivatedChannels,
        disabledReasons,
      },
    };
  }

  return { getSettings, saveSettings };
}
