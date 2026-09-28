import { formatLocalDate, formatLocalTime } from '../util/date.js';
import { AssetCategoryValidationError, parseEnabledField } from './asset-category-validation.js';
import { resolveReleaseSchedule } from './release-notification-service.js';
import {
  RELEASE_NOTIFICATION_CHANNELS,
  RELEASE_NOTIFICATION_TIMING_LIMITS,
} from './release-notification-settings-service.js';

export const CHANNEL_DEFINITIONS = Object.freeze({
  email: Object.freeze({ label: 'Email', acceptedBy: 'SMTP' }),
  ntfy: Object.freeze({ label: 'ntfy', acceptedBy: 'ntfy' }),
  gotify: Object.freeze({ label: 'Gotify', acceptedBy: 'Gotify' }),
  webhook: Object.freeze({ label: 'Webhook', acceptedBy: 'webhook' }),
});

export const DURATION_UNITS = Object.freeze([
  Object.freeze({ value: 'minutes', label: 'minutes', minutes: 1 }),
  Object.freeze({ value: 'hours', label: 'hours', minutes: 60 }),
  Object.freeze({ value: 'days', label: 'days', minutes: 24 * 60 }),
]);

const SAFE_CODE = /^[a-z][a-z0-9_.]{0,63}$/;
const HOSTNAME = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;
const MAILBOX = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,253}$/;
const SMTP_SECURITY_LABELS = Object.freeze({ tls: 'TLS', starttls: 'STARTTLS', plain: 'None (plain SMTP)' });

// Readiness codes come from each transport's configuration check (plus the
// Settings-side status_unavailable/not_configured). Only this fixed wording is
// shown; an unknown code falls back to a generic sentence, never the code text.
const READINESS_MESSAGES = Object.freeze({
  email: Object.freeze({
    missing_host: 'SMTP host is not configured',
    invalid_host: 'SMTP host is invalid',
    invalid_security: 'SMTP security mode is invalid',
    missing_port: 'SMTP port is required for plain SMTP',
    invalid_port: 'SMTP port is invalid',
    invalid_username: 'SMTP username is invalid',
    incomplete_auth: 'SMTP username and password must both be configured',
    missing_sender: 'SMTP sender is not configured',
    invalid_sender: 'SMTP sender address is invalid',
    missing_recipient: 'Recipient email address is not set',
    invalid_recipient: 'Recipient email address is invalid',
  }),
  ntfy: Object.freeze({
    missing_server: 'ntfy server is not configured',
    invalid_server_url: 'ntfy server URL is invalid',
    missing_topic: 'ntfy topic is not configured',
    invalid_topic: 'ntfy topic is invalid',
    invalid_token: 'ntfy access token is invalid',
  }),
  gotify: Object.freeze({
    missing_server: 'Gotify server is not configured',
    invalid_server_url: 'Gotify server URL is invalid',
    missing_token: 'Gotify token is missing',
    invalid_token: 'Gotify token is invalid',
  }),
  webhook: Object.freeze({
    missing_endpoint: 'Webhook URL is not configured',
    invalid_endpoint_url: 'Webhook URL is invalid',
    invalid_token: 'Webhook bearer token is invalid',
  }),
});

const FAILURE_MESSAGES = Object.freeze({
  authentication_failed: 'Authentication was rejected',
  rejected: 'The service rejected the notification',
  tls_failed: 'A secure connection could not be established',
  provider_unavailable: 'The service was temporarily unavailable',
  smtp_temporary_failure: 'The SMTP server reported a temporary failure',
  rate_limited: 'The service is limiting requests',
  timeout: 'The service did not respond in time',
  dns_error: 'The server name could not be resolved',
  network_error: 'Could not connect to the service',
  protocol_error: 'The server responded unexpectedly',
  redirect_refused: 'The service answered with a redirect, which is not followed',
  invalid_configuration: 'The channel configuration is invalid',
  invalid_payload: 'The notification could not be built',
  notifications_disabled: 'Release notifications were turned off',
  channel_disabled: 'The channel was deselected',
  notification_type_disabled: 'That reminder type was turned off',
  lease_expired: 'The attempt did not finish',
  unexpected_error: 'An unexpected error occurred',
});

const STATE_LABELS = Object.freeze({
  retry_scheduled: 'Retry scheduled',
  failed: 'Failed',
  cancelled: 'Cancelled',
});

const STATE_VARIANTS = Object.freeze({
  accepted: 'success',
  retry_scheduled: 'warning',
  failed: 'error',
  cancelled: 'neutral',
});

export const ENABLE_REQUIRES_READY_CHANNEL_MESSAGE = 'Release notifications need at least one selected channel that is ready. '
  + 'Select a ready channel or finish configuring a selected one.';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFlag(value) {
  return value === true;
}

/** Scheme, host, and port only: path and query may themselves be credentials. */
function safeOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeHost(value) {
  return typeof value === 'string' && HOSTNAME.test(value) ? value : null;
}

function safePort(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function safeMailbox(value) {
  return typeof value === 'string' && value.length <= 254 && MAILBOX.test(value) ? value : null;
}

function normalizeReadiness(readiness) {
  const ready = readFlag(readiness?.ready);
  const reason = typeof readiness?.reason === 'string' && SAFE_CODE.test(readiness.reason)
    ? readiness.reason
    : null;
  return {
    ready,
    reason: ready ? null : (reason ?? 'not_configured'),
    authConfigured: readFlag(readiness?.authConfigured),
  };
}

/**
 * Rebuild the injected per-channel status from a fixed allowlist of safe
 * fields. Whatever else a provider object carries is discarded here, so a
 * credential accidentally included upstream can never reach a template.
 */
function normalizeSummary(channel, summary, readiness) {
  const source = isPlainObject(summary) ? summary : {};
  switch (channel) {
    case 'email':
      return {
        host: safeHost(source.host),
        port: safePort(source.port),
        security: Object.hasOwn(SMTP_SECURITY_LABELS, source.security) ? source.security : null,
        sender: safeMailbox(source.sender),
        credentialsConfigured: readFlag(source.credentialsConfigured) || readiness.authConfigured,
      };
    case 'ntfy':
      return {
        origin: safeOrigin(source.origin),
        topicConfigured: readFlag(source.topicConfigured),
        tokenConfigured: readFlag(source.tokenConfigured),
      };
    case 'gotify':
      return {
        origin: safeOrigin(source.origin),
        tokenConfigured: readFlag(source.tokenConfigured),
      };
    case 'webhook':
      return {
        origin: safeOrigin(source.origin),
        endpointConfigured: readFlag(source.endpointConfigured),
        tokenConfigured: readFlag(source.tokenConfigured),
      };
    default:
      return {};
  }
}

export function normalizeChannelStatus(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return Object.fromEntries(RELEASE_NOTIFICATION_CHANNELS.map((channel) => {
    const entry = isPlainObject(source[channel]) ? source[channel] : {};
    const readiness = normalizeReadiness(entry.readiness);
    return [channel, { readiness, summary: normalizeSummary(channel, entry.summary, readiness) }];
  }));
}

export function unavailableChannelStatus() {
  return Object.fromEntries(RELEASE_NOTIFICATION_CHANNELS.map((channel) => [channel, {
    readiness: { ready: false, reason: 'status_unavailable', authConfigured: false },
    summary: normalizeSummary(channel, {}, { authConfigured: false }),
  }]));
}

export function readinessMessage(channel, reason) {
  if (reason === 'status_unavailable') return 'Configuration status is unavailable';
  if (reason === 'not_configured') return `${CHANNEL_DEFINITIONS[channel].label} is not configured`;
  return READINESS_MESSAGES[channel]?.[reason] ?? 'Configuration is incomplete';
}

export function failureMessage(code) {
  return FAILURE_MESSAGES[code] ?? 'Delivery was not accepted';
}

function configured(flag) {
  return flag ? 'Configured' : 'Not configured';
}

function summaryRows(channel, summary) {
  const notSet = 'Not configured';
  switch (channel) {
    case 'email':
      return [
        { label: 'SMTP host', value: summary.host ?? notSet },
        { label: 'Port', value: summary.port === null ? notSet : String(summary.port) },
        { label: 'Security', value: summary.security ? SMTP_SECURITY_LABELS[summary.security] : notSet },
        { label: 'Sender', value: summary.sender ?? notSet },
        { label: 'Authentication', value: configured(summary.credentialsConfigured) },
      ];
    case 'ntfy':
      return [
        { label: 'Server', value: summary.origin ?? notSet },
        { label: 'Topic', value: configured(summary.topicConfigured) },
        { label: 'Access token', value: configured(summary.tokenConfigured) },
      ];
    case 'gotify':
      return [
        { label: 'Server', value: summary.origin ?? notSet },
        { label: 'Application token', value: configured(summary.tokenConfigured) },
      ];
    case 'webhook':
      return [
        { label: 'Server', value: summary.origin ?? notSet },
        { label: 'Endpoint', value: configured(summary.endpointConfigured) },
        { label: 'Bearer token', value: configured(summary.tokenConfigured) },
      ];
    default:
      return [];
  }
}

function formatInstant(iso, clockFormat) {
  if (typeof iso !== 'string') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatLocalDate(date)} ${formatLocalTime(date, clockFormat)}`;
}

export function presentRecentResult(channel, entry, clockFormat) {
  if (!entry) return null;
  return {
    attemptedAt: formatInstant(entry.at, clockFormat),
    kindLabel: entry.kind === 'test' ? 'Test' : 'Release notification',
    stateLabel: entry.state === 'accepted'
      ? `Accepted by ${CHANNEL_DEFINITIONS[channel].acceptedBy}`
      : STATE_LABELS[entry.state],
    variant: STATE_VARIANTS[entry.state],
    detail: entry.state === 'accepted' ? null : failureMessage(entry.code),
    nextRetryAt: formatInstant(entry.nextRetryAt, clockFormat),
  };
}

export function presentTestFeedback(channel, entry, clockFormat) {
  const { acceptedBy } = CHANNEL_DEFINITIONS[channel];
  if (entry.state === 'accepted') {
    return { variant: 'success', text: `Test notification accepted by ${acceptedBy}.` };
  }
  const nextRetry = formatInstant(entry.nextRetryAt, clockFormat);
  if (entry.state === 'retry_scheduled') {
    return {
      variant: 'warning',
      text: `Test notification not accepted yet: ${failureMessage(entry.code)}.${nextRetry ? ` Next retry ${nextRetry}.` : ''}`,
    };
  }
  return { variant: 'error', text: `Test notification failed: ${failureMessage(entry.code)}.` };
}

export function presentNotReadyTestFeedback(channel, readiness) {
  return { variant: 'error', text: `Test not sent — ${readinessMessage(channel, readiness.reason)}.` };
}

export function presentChannels({ settings, values, status, recentResults, testFeedback = null, clockFormat }) {
  return RELEASE_NOTIFICATION_CHANNELS.map((channel) => {
    const { readiness, summary } = status[channel];
    return {
      key: channel,
      label: CHANNEL_DEFINITIONS[channel].label,
      selected: values.channels.includes(channel),
      savedSelected: settings.enabledChannels.includes(channel),
      ready: readiness.ready,
      readinessText: readiness.ready ? 'Ready' : `Not ready — ${readinessMessage(channel, readiness.reason)}`,
      summaryRows: summaryRows(channel, summary),
      recentResult: presentRecentResult(channel, recentResults[channel], clockFormat),
      testFeedback: testFeedback?.channel === channel ? testFeedback : null,
    };
  });
}

/** Largest unit that represents the stored minutes exactly. */
export function splitMinutes(minutes) {
  for (const unit of [...DURATION_UNITS].reverse()) {
    if (Number.isSafeInteger(minutes) && minutes > 0 && minutes % unit.minutes === 0) {
      return { amount: String(minutes / unit.minutes), unit: unit.value };
    }
  }
  return { amount: String(minutes ?? ''), unit: 'minutes' };
}

export function valuesFromSettings(settings) {
  const advance = splitMinutes(settings.advance.leadMinutes);
  const overdue = splitMinutes(settings.overdue.graceMinutes);
  const repeat = splitMinutes(settings.overdueRepeat.intervalMinutes);
  return {
    enabled: settings.enabled,
    channels: [...settings.enabledChannels],
    emailRecipient: settings.emailRecipient ?? '',
    dateOnlyTime: settings.dateOnlyTime,
    advanceEnabled: settings.advance.enabled,
    advanceAmount: advance.amount,
    advanceUnit: advance.unit,
    scheduledEnabled: settings.scheduled.enabled,
    overdueEnabled: settings.overdue.enabled,
    overdueAmount: overdue.amount,
    overdueUnit: overdue.unit,
    repeatEnabled: settings.overdueRepeat.enabled,
    repeatAmount: repeat.amount,
    repeatUnit: repeat.unit,
  };
}

function firstString(value) {
  const item = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof item === 'string' ? item : '';
}

/**
 * A duration unit must arrive as exactly one string. Arrays (duplicate or
 * multi-value fields) and objects are malformed and read as '', which the
 * unit check then rejects rather than picking one of the submitted values.
 */
function scalarString(value) {
  return typeof value === 'string' ? value : '';
}

const DURATION_FIELDS = Object.freeze({
  advance: Object.freeze({ key: 'advanceLead', label: 'Advance reminder lead time', limits: RELEASE_NOTIFICATION_TIMING_LIMITS.advanceLeadMinutes }),
  overdue: Object.freeze({ key: 'overdueGrace', label: 'Overdue grace period', limits: RELEASE_NOTIFICATION_TIMING_LIMITS.overdueGraceMinutes }),
  repeat: Object.freeze({ key: 'repeatInterval', label: 'Repeat interval', limits: RELEASE_NOTIFICATION_TIMING_LIMITS.overdueRepeatIntervalMinutes }),
});

function describeMinutes(minutes) {
  const { amount, unit } = splitMinutes(minutes);
  if (minutes === 0) return '0 minutes';
  return `${amount} ${Number(amount) === 1 ? unit.replace(/s$/, '') : unit}`;
}

function rangeMessage(field) {
  const { label, limits } = DURATION_FIELDS[field];
  return `${label} must be a whole number from ${describeMinutes(limits.min)} to ${describeMinutes(limits.max)}.`;
}

function findDurationUnit(unit) {
  return DURATION_UNITS.find((candidate) => candidate.value === unit) ?? null;
}

/**
 * Convert an amount + unit pair to WP1's whole-minute representation. An
 * unparseable amount is passed through unchanged so the core validator stays
 * the authority that rejects it. An unknown unit never falls back to minutes;
 * parseSubmittedPreferences reports it before anything is saved.
 */
function toMinutes(amount, unit) {
  const definition = findDurationUnit(unit);
  if (!definition) return null;
  if (!/^\d{1,9}$/.test(amount)) return amount;
  return Number(amount) * definition.minutes;
}

function readEnabled(body, name, errors, errorKey) {
  try {
    return parseEnabledField(body?.[name], { defaultValue: false, fieldLabel: errorKey });
  } catch (err) {
    if (!(err instanceof AssetCategoryValidationError)) throw err;
    errors[errorKey] = 'Choose enabled or disabled.';
    return false;
  }
}

/**
 * Read the submitted form into WP1's preference input. Only the structural
 * checks needed to build that input happen here; every business rule
 * (ranges, dependencies, duplicate instants) is left to the core validator.
 */
export function parseSubmittedPreferences(body) {
  const errors = {};
  const rawChannels = body?.channels === undefined ? [] : [].concat(body.channels);
  const channels = rawChannels.filter((value) => typeof value === 'string');
  if (channels.length !== rawChannels.length) errors.channels = 'Unknown notification channel.';

  const values = {
    enabled: readEnabled(body, 'enabled', errors, 'enabled'),
    channels,
    emailRecipient: firstString(body?.emailRecipient).trim(),
    dateOnlyTime: firstString(body?.dateOnlyTime).trim(),
    advanceEnabled: readEnabled(body, 'advanceEnabled', errors, 'advanceEnabled'),
    advanceAmount: firstString(body?.advanceAmount).trim(),
    advanceUnit: scalarString(body?.advanceUnit),
    scheduledEnabled: readEnabled(body, 'scheduledEnabled', errors, 'scheduledEnabled'),
    overdueEnabled: readEnabled(body, 'overdueEnabled', errors, 'overdueEnabled'),
    overdueAmount: firstString(body?.overdueAmount).trim(),
    overdueUnit: scalarString(body?.overdueUnit),
    repeatEnabled: readEnabled(body, 'repeatEnabled', errors, 'repeatEnabled'),
    repeatAmount: firstString(body?.repeatAmount).trim(),
    repeatUnit: scalarString(body?.repeatUnit),
  };

  for (const field of Object.keys(DURATION_FIELDS)) {
    if (!findDurationUnit(values[`${field}Unit`])) {
      errors[DURATION_FIELDS[field].key] = `${DURATION_FIELDS[field].label} unit must be minutes, hours, or days.`;
    }
  }

  const minutes = {
    advance: toMinutes(values.advanceAmount, values.advanceUnit),
    overdue: toMinutes(values.overdueAmount, values.overdueUnit),
    repeat: toMinutes(values.repeatAmount, values.repeatUnit),
  };

  const input = {
    enabled: values.enabled,
    enabledChannels: channels,
    emailRecipient: values.emailRecipient,
    dateOnlyTime: values.dateOnlyTime,
    advance: { enabled: values.advanceEnabled, leadMinutes: minutes.advance },
    scheduled: { enabled: values.scheduledEnabled },
    overdue: { enabled: values.overdueEnabled, graceMinutes: minutes.overdue },
    overdueRepeat: { enabled: values.repeatEnabled, intervalMinutes: minutes.repeat },
  };
  return { input, values, minutes, errors };
}

function outOfRange(field, minutes) {
  const { limits } = DURATION_FIELDS[field];
  return !Number.isSafeInteger(minutes) || minutes < limits.min || minutes > limits.max;
}

const CORE_ERROR_FIELDS = Object.freeze({
  enabled: 'enabled',
  enabledChannels: 'channels',
  emailRecipient: 'emailRecipient',
  dateOnlyTime: 'dateOnlyTime',
  'advance.enabled': 'advanceEnabled',
  'scheduled.enabled': 'scheduledEnabled',
  'overdue.enabled': 'overdueEnabled',
  'overdueRepeat.enabled': 'repeatEnabled',
});

const CORE_DURATION_ERRORS = Object.freeze({
  'advance.leadMinutes': 'advance',
  'overdue.graceMinutes': 'overdue',
  'overdueRepeat.intervalMinutes': 'repeat',
});

/**
 * Attach the core validator's errors to form fields. Range failures on
 * minute fields are reworded in the units the form offers; every other
 * message (including the duplicate-instant and repeat-dependency rules) is
 * the core's own text.
 */
export function mapCoreErrors(coreErrors, minutes) {
  const errors = {};
  for (const [key, message] of Object.entries(coreErrors ?? {})) {
    const durationField = CORE_DURATION_ERRORS[key];
    if (durationField) {
      const { key: formKey } = DURATION_FIELDS[durationField];
      errors[formKey] = outOfRange(durationField, minutes[durationField]) ? rangeMessage(durationField) : message;
      continue;
    }
    const formKey = CORE_ERROR_FIELDS[key] ?? 'form';
    errors[formKey] = errors[formKey] ? `${errors[formKey]} ${message}` : message;
  }
  return errors;
}

export function isValidTimeZone(value) {
  if (typeof value !== 'string' || value === '' || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Example schedule for a date-only release planned tomorrow, in server-local time. */
export function presentDateOnlyExample(settings, now, clockFormat) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const plannedDate = formatLocalDate(tomorrow);
  const schedule = resolveReleaseSchedule({ planned_date: plannedDate, planned_time: null }, settings);
  if (!schedule) return null;
  return {
    plannedDate,
    scheduledAt: `${formatLocalDate(schedule.scheduledAt)} ${formatLocalTime(schedule.scheduledAt, clockFormat)}`,
  };
}
