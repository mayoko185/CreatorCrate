import { SOCIAL_PREP_SUPPORTED_PLATFORMS } from './social-prep-settings-service.js';

const PLATFORM_NAMES = Object.freeze({ patreon: 'Patreon', x: 'X', bluesky: 'Bluesky' });
const STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  starting: 'Starting',
  preparing: 'Preparing',
  uploading: 'Uploading',
  auth_required: 'Authentication required',
  prepared: 'Composer prepared for human submission',
  failed: 'Preparation failed',
  cancelled: 'Preparation cancelled',
});

function timestamp(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new TypeError('Invalid recorded Social Preparation timestamp.');
  }
  return value;
}

/**
 * Read-only allowlist projection. Settings describe current configuration, never
 * historical targets. Request counts are not evidence of browser execution.
 * firstPreparedAt retains the first recorded success even after a later failure.
 * Timestamps retain the repository's UTC SQLite format; null means unrecorded.
 * No aggregate status is inferred from the independent platform states.
 */
export function buildReleaseSocialPrepPresentation(rows, { enabled = false, platforms = [] } = {}) {
  if (!Array.isArray(rows) || !Array.isArray(platforms)
    || typeof enabled !== 'boolean'
    || platforms.some((platform) => !SOCIAL_PREP_SUPPORTED_PLATFORMS.includes(platform))) {
    throw new TypeError('Invalid Social Preparation presentation input.');
  }
  const configuredPlatforms = SOCIAL_PREP_SUPPORTED_PLATFORMS.filter((platform) => platforms.includes(platform));
  const targets = rows.map((row) => {
    if (!row || !SOCIAL_PREP_SUPPORTED_PLATFORMS.includes(row.platform)
      || typeof row.status !== 'string' || !Object.hasOwn(STATUS_LABELS, row.status)
      || !Number.isSafeInteger(row.attempts) || row.attempts < 0) {
      throw new TypeError('Invalid recorded Social Preparation platform state.');
    }
    return {
      platform: row.platform,
      platformName: PLATFORM_NAMES[row.platform],
      status: row.status,
      statusLabel: STATUS_LABELS[row.status],
      preparationRequestCount: row.attempts,
      noPreparationRequested: row.attempts === 0,
      lastUpdatedAt: timestamp(row.updated_at),
      firstPreparedAt: timestamp(row.prepared_at),
      absentFromCurrentConfiguration: !configuredPlatforms.includes(row.platform),
    };
  }).sort((left, right) => SOCIAL_PREP_SUPPORTED_PLATFORMS.indexOf(left.platform)
    - SOCIAL_PREP_SUPPORTED_PLATFORMS.indexOf(right.platform));

  return { globallyEnabled: enabled, configuredPlatforms, targets };
}
