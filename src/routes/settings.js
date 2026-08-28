import express from 'express';
import { BackupError } from '../services/backup-service.js';
import { invalidateAllSessionsForDb } from '../services/auth-service.js';
import { clearSessionCookie } from '../middleware/auth.js';
import { formatLocalDate, formatLocalTime, formatRelativeTime } from '../util/date.js';
import {
  AssetCategoryValidationError,
  AssetCategoryNotFoundError,
} from '../services/asset-category-service.js';
import { AssetCategoryValidationError as PreferenceValidationError } from '../services/asset-browser-preference-service.js';
import { buildGlobalAssetBrowserPreferenceModel } from '../services/asset-browser-preference-presenter.js';
import { parseEnabledField } from '../services/asset-category-validation.js';
import {
  LOGS_PAGE_SIZE_VALUES,
  LOGS_TIMEZONE_VALUES,
  PageDefaultValidationError,
  PAGE_DEFAULT_DEFINITIONS,
} from '../services/page-defaults-service.js';
import { TAG_NAME_MAX, TagNotFoundError, TagValidationError } from '../services/tag-service.js';
import { OpenLocallySettingsValidationError } from '../services/open-locally-settings-service.js';
import {
  PreviewCategoryValidationError,
  PREVIEW_CATEGORY_DISABLED_VALUE,
} from '../services/preview-category-settings-service.js';
import {
  AUTO_SCAN_LAST_COMPLETED_AT_KEY,
  AUTO_SCAN_NEXT_SCHEDULED_AT_KEY,
} from '../services/automatic-project-scan-scheduler.js';
import { APPLICATION_LOG_LEVELS } from '../services/application-logger.js';
import {
  buildPageDefaultsDialogModel,
  handlePageDefaultsPost,
} from './page-defaults.js';

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

// Controlled, curated notice text keyed by a fixed code — never the raw
// exception message, so an internal failure detail can never reach a
// rendered page (see BackupError's own message-safety contract).
const NOTICES = {
  backup_created: { variant: 'success', text: 'Backup created successfully.' },
  backup_failed: { variant: 'error', text: 'Backup creation failed. The previous backups are unaffected.' },
  restore_success: { variant: 'success', text: 'Database restored from the selected backup.' },
  restore_failed: { variant: 'error', text: 'Restore failed. The database was left unchanged.' },
  restore_conflict: { variant: 'warning', text: 'A restore is already in progress. Please wait for it to finish.' },
  backup_deleted: { variant: 'success', text: 'Backup deleted.' },
  delete_failed: { variant: 'error', text: 'Could not delete the backup. It may have already been removed.' },
  password_rotated: { variant: 'success', text: 'Password changed. Sign in again with the new password.' },
  backup_created_prune_warning: {
    variant: 'warning',
    text: 'Backup created successfully, but one or more older backups could not be automatically pruned. Check the backup directory permissions.',
  },
  authentication_disabled: {
    variant: 'warning',
    text: 'Authentication has been disabled. Anyone who can reach this server can access CreatorCrate.',
  },
  auth_already_enabled: { variant: 'error', text: 'Authentication is already enabled.' },
  auth_already_disabled: { variant: 'error', text: 'Authentication is already disabled.' },
  auth_transition_conflict: {
    variant: 'error',
    text: 'Another authentication change is already in progress. Please try again in a moment.',
  },
  auth_transition_failed: {
    variant: 'error',
    text: 'Could not change the authentication setting. The previous configuration is still active.',
  },
  category_added: { variant: 'success', text: 'Asset category default added.' },
  category_updated: { variant: 'success', text: 'Asset category default updated.' },
  category_enabled: { variant: 'success', text: 'Asset category default enabled.' },
  category_disabled: { variant: 'success', text: 'Asset category default disabled.' },
  category_deleted: { variant: 'success', text: 'Asset category default deleted.' },
  category_reordered: { variant: 'success', text: 'Asset category order updated.' },
  category_reorder_invalid: {
    variant: 'error',
    text: 'The submitted category order is invalid. Submit every global category exactly once.',
  },
  category_reorder_failed: {
    variant: 'error',
    text: 'Could not update the order. No changes were made.',
  },
  category_mutation_failed: {
    variant: 'error',
    text: 'Could not save the asset category default. Please try again.',
  },
  global_default_saved: { variant: 'success', text: 'Global asset-browser default saved.' },
  preview_category_saved: { variant: 'success', text: 'Preview category saved.' },
  defaults_saved: { variant: 'success', text: 'Page defaults saved successfully.' },
  tag_created: { variant: 'success', text: 'Tag created successfully.' },
  tag_renamed: { variant: 'success', text: 'Tag renamed successfully.' },
  tag_deleted: { variant: 'success', text: 'Tag deleted successfully.' },
  nsfw_filter_enabled: { variant: 'success', text: 'NSFW Filter enabled.' },
  nsfw_filter_disabled: { variant: 'success', text: 'NSFW Filter disabled.' },
  open_locally_saved: { variant: 'success', text: 'Open locally mapping saved.' },
  open_locally_cleared: { variant: 'success', text: 'Open locally mapping removed.' },
  logging_cleared: { variant: 'success', text: 'Application logs cleared.' },
};

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

const DEFAULTS_PAGE_SECTIONS = Object.freeze([
  Object.freeze({ page: 'new_project', title: 'New Projects', anchor: 'defaults-new-projects' }),
]);

const DEFAULTS_POST_SECTIONS = Object.freeze([
  ...DEFAULTS_PAGE_SECTIONS,
  Object.freeze({ page: 'releases' }),
]);

const DEFAULT_OPTION_LABELS = Object.freeze({
  view: 'Default view',
  sort: 'Default sort',
  order: 'Default order',
  pageSize: 'Assets per page',
  assetViewer: Object.freeze({
    view: 'Default view',
    sort: 'Default sort',
    order: 'Default order',
    pageSize: 'Default page size',
  }),
  status: 'New project status',
});

const DEFAULT_VALUE_LABELS = Object.freeze({
  new_project: Object.freeze({
    status: Object.freeze({
      tbd: 'TBD',
      planned: 'Planned',
      'in-progress': 'In progress',
      ready: 'Ready',
      completed: 'Completed',
    }),
  }),
  projects: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
    sort: Object.freeze({ updated: 'Recently updated', created: 'Recently created', title: 'Title' }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
  }),
  projectAssets: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
    sort: Object.freeze({
      filename: 'Filename',
      modified: 'Modified date',
      size: 'File size',
      category: 'Category & location',
    }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
    pageSize: Object.freeze({ 10: '10', 25: '25', 50: '50', 100: '100' }),
  }),
  assetViewer: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
    sort: Object.freeze({
      filename: 'Filename',
      modified: 'Modified',
      size: 'Size',
      category: 'Category',
      project: 'Project',
    }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
    pageSize: Object.freeze({ 10: '10', 25: '25', 50: '50', 100: '100' }),
  }),
});

function pageDefaultFieldName(page, option) {
  return `${page}${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

function defaultValueLabel(page, option, value) {
  return DEFAULT_VALUE_LABELS[page][option][value] || value;
}

function readSubmittedPageDefaults(body, service) {
  const rawBody = body && typeof body === 'object' ? body : {};
  const values = Object.fromEntries(
    DEFAULTS_POST_SECTIONS.map(({ page }) => [
      page,
      Object.fromEntries(
        Object.keys(PAGE_DEFAULT_DEFINITIONS[page]).map((option) => {
          const fieldName = pageDefaultFieldName(page, option);
          return [
            option,
            Object.hasOwn(rawBody, fieldName)
              ? rawBody[fieldName]
              : service.resolve(page, option),
          ];
        })
      ),
    ])
  );
  return values;
}

function defaultsPageWasSubmitted(body, page) {
  if (DEFAULTS_PAGE_SECTIONS.some((section) => section.page === page)) return true;
  const rawBody = body && typeof body === 'object' ? body : {};
  return Object.keys(PAGE_DEFAULT_DEFINITIONS[page])
    .some((option) => Object.hasOwn(rawBody, pageDefaultFieldName(page, option)));
}

function getPageDefaultsService(req) {
  const service = req.app?.locals?.pageDefaultsService;
  if (!service) {
    throw new Error('Settings Defaults requires app.locals.pageDefaultsService.');
  }
  return service;
}

function getTagService(req) {
  const service = req.app?.locals?.tagService;
  if (!service) {
    throw new Error('Settings Tags requires app.locals.tagService.');
  }
  return service;
}

function getOpenLocallySettingsService(req) {
  const service = req.app?.locals?.openLocallySettingsService;
  if (!service) {
    throw new Error('Settings Open locally requires app.locals.openLocallySettingsService.');
  }
  return service;
}

function getNsfwFilterSettingsService(req) {
  const service = req.app?.locals?.nsfwFilterSettingsService;
  if (!service) {
    throw new Error('Settings NSFW Filter requires app.locals.nsfwFilterSettingsService.');
  }
  return service;
}

function formatScanTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatLocalDate(date)} ${formatLocalTime(date)}`;
}

function buildAutomaticScanTiming(appMetaRepository, intervalMinutes) {
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes <= 0) return null;

  return {
    lastScan: formatScanTimestamp(appMetaRepository.getValue(AUTO_SCAN_LAST_COMPLETED_AT_KEY)),
    nextScan: formatScanTimestamp(appMetaRepository.getValue(AUTO_SCAN_NEXT_SCHEDULED_AT_KEY)),
  };
}

const LOG_CONTEXT_SENSITIVE_KEY = /(?:authorization|cookie|credential|csrf|password|secret|session|token|watermark|(?:^|[_-])(?:request|body|headers?|options?)(?:[_-]|$)|(?:request|body|headers?|options?)(?:body|payload|data|headers?|options?)$)/i;
const LOG_SENSITIVE_TEXT = /(?:\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|digest)\s+\S+|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}|\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|session(?:[ _-]?id)?|password|secret|credential)\b(?:\s*[:=]\s*|\s+[\"'(\[<]\s*)\S+|\b(?:cookie|set-cookie)\s*:\s*[^;\r\n]+)/i;
const LOG_GENERIC_SECRET_TEXT = /\b(?:token|csrf|auth(?:orization)?)\b\s*[:=]\s*\S+/i;
const LOG_ABSOLUTE_PATH = /(?:^|[\s"'`([{<=,:;])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)(?!(?:div|script)>))/i;
const LOG_STACK_TRACE = /^[^\S\r\n]*(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error|Exception)\b[^\r\n]*(?:\r?\n[^\S\r\n]*at\s+[^\r\n]+)+/i;
const LOG_CONTEXT_MAX_ENTRIES = 100;
const LOG_CONTEXT_MAX_DEPTH = 4;

function safeLogViewerText(value, fallback = '—') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  if (LOG_STACK_TRACE.test(value)) return '[redacted stack trace]';
  if (LOG_SENSITIVE_TEXT.test(normalized) || LOG_GENERIC_SECRET_TEXT.test(normalized)) return '[redacted secret]';
  if (LOG_ABSOLUTE_PATH.test(normalized)) return '[redacted path]';
  return normalized.slice(0, 2_000);
}

function isSafeWatermarkIdLogContextEntry(label, value) {
  return label.split(/[.\[\]]/).at(-1) === 'watermarkId'
    && typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function logSettingsActivity(applicationLogger, event, context = {}, message = 'Settings activity completed.') {
  try {
    applicationLogger?.info?.({
      event,
      kind: 'activity',
      subsystem: 'settings',
      message,
      context,
    });
  } catch {
    // Activity logging must never alter a completed Settings mutation.
  }
}

function safeLogContextEntries(contextJson) {
  let context;
  try {
    context = JSON.parse(contextJson);
  } catch {
    return [];
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) return [];

  const entries = [];
  const visit = (value, label, depth) => {
    if (entries.length >= LOG_CONTEXT_MAX_ENTRIES) return;
    const safeLabel = LOG_ABSOLUTE_PATH.test(label) ? '[redacted key]' : safeLogViewerText(label, '[unavailable key]');
    if (LOG_CONTEXT_SENSITIVE_KEY.test(label.split(/[.\[\]]/).at(-1)) && !isSafeWatermarkIdLogContextEntry(label, value)) {
      entries.push({ label: safeLabel, value: '[redacted]' });
      return;
    }
    if (value === null || typeof value === 'boolean') {
      entries.push({ label: safeLabel, value: String(value) });
      return;
    }
    if (typeof value === 'number') {
      entries.push({ label: safeLabel, value: Number.isFinite(value) ? String(value) : '[invalid number]' });
      return;
    }
    if (typeof value === 'string') {
      entries.push({ label: safeLabel, value: safeLogViewerText(value, '') });
      return;
    }
    if (depth >= LOG_CONTEXT_MAX_DEPTH || !value || typeof value !== 'object') {
      entries.push({ label: safeLabel, value: '[truncated]' });
      return;
    }
    const children = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [key, child] of children) {
      visit(child, Array.isArray(value) ? `${label}[${key}]` : `${label}.${key}`, depth + 1);
      if (entries.length >= LOG_CONTEXT_MAX_ENTRIES) return;
    }
  };

  for (const [key, value] of Object.entries(context)) {
    visit(value, key, 0);
    if (entries.length >= LOG_CONTEXT_MAX_ENTRIES) break;
  }
  return entries;
}

const LOG_TIME_PRESETS = Object.freeze({
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});
const LOG_TIME_OPTIONS = Object.freeze([
  Object.freeze({ value: '', label: 'Any time' }),
  Object.freeze({ value: 'hour', label: 'Last hour' }),
  Object.freeze({ value: 'day', label: 'Last 24 hours' }),
  Object.freeze({ value: '7d', label: 'Last 7 days' }),
  Object.freeze({ value: '30d', label: 'Last 30 days' }),
]);
const LOG_TIMEZONE_LABELS = Object.freeze({
  local: 'Local / Browser timezone',
  UTC: 'UTC',
  'America/New_York': 'Eastern',
  'America/Chicago': 'Central',
  'America/Denver': 'Mountain',
  'America/Los_Angeles': 'Pacific',
});
const LOG_TIMEZONE_OPTIONS = Object.freeze(
  LOGS_TIMEZONE_VALUES.map((value) => Object.freeze({ value, label: LOG_TIMEZONE_LABELS[value] }))
);
const LOGS_PAGE_DEFAULTS = 'logs';
const LOGS_DEFAULT_LABELS = Object.freeze({
  fields: Object.freeze({
    level: 'Level',
    kind: 'Kind',
    subsystem: 'Subsystem',
    time: 'Time range',
    pageSize: 'Items per page',
    timezone: 'Timezone',
    autoRefresh: 'Auto-refresh',
  }),
  options: Object.freeze({
    level: Object.freeze({ '': 'Any level' }),
    kind: Object.freeze({ '': 'Any kind', activity: 'Activity', diagnostic: 'Diagnostic' }),
    subsystem: Object.freeze({ '': 'Any subsystem' }),
    time: Object.freeze({
      '': 'Any time', hour: 'Last hour', day: 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days',
    }),
    pageSize: Object.freeze({ '25': '25', '50': '50', '75': '75', '100': '100' }),
    timezone: LOG_TIMEZONE_LABELS,
    autoRefresh: Object.freeze({ enabled: 'Enabled', disabled: 'Disabled' }),
  }),
});
const LOGS_DEFAULTS_NOTICE = 'Logs defaults saved successfully.';

function parseLogPage(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}

function getLogsDefaultsQuery(query) {
  const values = query && typeof query === 'object' ? { ...query } : {};
  if (!LOGS_PAGE_SIZE_VALUES.includes(values.pageSize)) delete values.pageSize;
  return values;
}

function buildLogFilters(query, options) {
  const allowed = {
    level: new Set([...APPLICATION_LOG_LEVELS, ...options.levels]),
    kind: new Set(['activity', 'diagnostic', ...options.kinds]),
    subsystem: new Set(options.subsystems),
  };
  const filters = Object.fromEntries(
    ['level', 'kind', 'subsystem']
      .filter((field) => typeof query?.[field] === 'string' && allowed[field].has(query[field]))
      .map((field) => [field, query[field]])
  );
  if (typeof query?.time === 'string' && Object.hasOwn(LOG_TIME_PRESETS, query.time)) {
    filters.time = query.time;
  }
  return filters;
}

function buildLogsUrl(filters, page = 1) {
  const params = new URLSearchParams();
  for (const field of ['level', 'kind', 'subsystem', 'time', 'pageSize']) {
    if (filters[field]) params.set(field, filters[field]);
  }
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? '/settings/logs?' + query : '/settings/logs';
}

function formatLogRecord(record) {
  const timestamp = new Date(record.occurred_at_ms);
  const timestampValid = !Number.isNaN(timestamp.getTime());
  return {
    id: record.id,
    timestampMs: timestampValid ? record.occurred_at_ms : null,
    timestampIso: timestampValid ? timestamp.toISOString() : null,
    timestamp: timestampValid ? timestamp.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : 'Unknown time',
    level: safeLogViewerText(record.level),
    kind: safeLogViewerText(record.kind),
    subsystem: safeLogViewerText(record.subsystem),
    event: safeLogViewerText(record.event),
    message: safeLogViewerText(record.message),
    projectId: Number.isSafeInteger(record.project_id) && record.project_id > 0 ? record.project_id : null,
    correlationId: safeLogViewerText(record.correlation_id, null),
    contextEntries: safeLogContextEntries(record.context_json),
  };
}

function isSafeLogFilterValue(value) {
  return typeof value === 'string' && safeLogViewerText(value, '') === value;
}

function getLogFilterOptions(applicationLogRepository) {
  const repositoryFilterOptions = applicationLogRepository.listFilterOptions();
  return {
    levels: [...APPLICATION_LOG_LEVELS].sort(),
    kinds: ['activity', 'diagnostic'],
    subsystems: repositoryFilterOptions.subsystems.filter(isSafeLogFilterValue),
  };
}

function buildLogsDefaultOptionCatalogues(filterOptions) {
  return {
    pageSize: LOGS_PAGE_SIZE_VALUES.map((value) => ({ value, label: value })),
    subsystem: [
      { value: '', label: 'Any subsystem' },
      ...filterOptions.subsystems.map((value) => ({ value, label: value })),
    ],
    timezone: LOG_TIMEZONE_OPTIONS,
  };
}

function renderLogsPage(req, res, {
  appName,
  applicationLogRepository,
  applicationLogDefaultPageSize,
  status = 200,
  logsDefaultsDialogOpen = req.query?.defaults === '1',
  logsDefaultsSubmittedValues = null,
  logsDefaultsErrors = {},
} = {}) {
  const filterOptions = getLogFilterOptions(applicationLogRepository);
  const optionCatalogues = buildLogsDefaultOptionCatalogues(filterOptions);
  const logFilterDropdowns = {
    level: filterOptions.levels.map((value) => ({ value, label: value })),
    kind: filterOptions.kinds.map((value) => ({ value, label: value })),
    subsystem: filterOptions.subsystems.map((value) => ({ value, label: value })),
    time: LOG_TIME_OPTIONS.slice(1),
    pageSize: LOGS_PAGE_SIZE_VALUES.map((value) => ({ value, label: value })),
  };
  const pageDefaultsService = getPageDefaultsService(req);
  const resolvedDefaults = pageDefaultsService.resolvePageDefaults(
    LOGS_PAGE_DEFAULTS,
    getLogsDefaultsQuery(req.query),
    optionCatalogues,
  );
  const filters = {
    ...buildLogFilters(resolvedDefaults, filterOptions),
    pageSize: resolvedDefaults.pageSize,
  };
  const pageSize = Number(resolvedDefaults.pageSize) || applicationLogDefaultPageSize;
  const sinceMs = filters.time ? Math.max(0, Date.now() - LOG_TIME_PRESETS[filters.time]) : undefined;
  const repositoryFilters = sinceMs === undefined ? filters : { ...filters, sinceMs };
  const totalLogs = applicationLogRepository.count(repositoryFilters);
  const totalPages = Math.max(1, Math.ceil(totalLogs / pageSize));
  const page = Math.min(parseLogPage(req.query?.page), totalPages);
  const logs = applicationLogRepository.findPage({
    ...repositoryFilters,
    page,
    pageSize,
  }).map(formatLogRecord);
  const logsDefaults = buildPageDefaultsDialogModel({
    pageDefaultsService,
    page: LOGS_PAGE_DEFAULTS,
    labels: LOGS_DEFAULT_LABELS,
    submittedValues: logsDefaultsSubmittedValues,
    errors: logsDefaultsErrors,
    optionCatalogues,
  });

  res.status(status).render('settings/logs.njk', {
    appName,
    notice: resolveNotice(req.query.notice),
    logs,
    filters,
    filterOptions,
    logFilterDropdowns,
    logsDefaults,
    logsDefaultsDialogOpen,
    timezone: resolvedDefaults.timezone,
    autoRefreshEnabled: resolvedDefaults.autoRefresh === 'enabled' && page === 1,
    autoRefreshPreferenceEnabled: resolvedDefaults.autoRefresh === 'enabled',
    page,
    totalPages,
    totalLogs,
    refreshUrl: buildLogsUrl(filters, page),
    clearFiltersUrl: buildLogsUrl({ pageSize: filters.pageSize }),
    clearUrl: buildLogsUrl(filters).replace('/settings/logs', '/settings/logs/clear'),
    previousUrl: page > 1 ? buildLogsUrl(filters, page - 1) : null,
    nextUrl: page < totalPages ? buildLogsUrl(filters, page + 1) : null,
  });
}

function renderTagsPage(req, res, {
  appName,
  status = 200,
  notice = null,
  submittedName = '',
  errors = {},
} = {}) {
  const tags = getTagService(req).listTags();
  res.status(status).render('settings/tags.njk', {
    appName,
    tags,
    notice,
    submittedName,
    errors,
    errorMessages: Object.values(errors),
    tagNameMax: TAG_NAME_MAX,
  });
}

function renderTagEditPage(res, {
  appName,
  tag,
  status = 200,
  notice = null,
  submittedName,
  errors = {},
} = {}) {
  res.status(status).render('settings/tag-edit.njk', {
    appName,
    tag,
    notice,
    submittedName: submittedName === undefined ? tag.display_name : submittedName,
    errors,
    errorMessages: Object.values(errors),
    tagNameMax: TAG_NAME_MAX,
  });
}

function renderOpenLocallyPage(req, res, {
  appName,
  projectsRoot,
  status = 200,
  notice = null,
  submittedValue = null,
  errors = {},
} = {}) {
  const service = getOpenLocallySettingsService(req);
  const configuredPath = service.getWindowsProjectsPath();
  res.status(status).render('settings/open-locally.njk', {
    appName,
    projectsRoot,
    notice,
    configuredPath,
    submittedValue,
    errors,
    errorMessages: Object.values(errors),
  });
}

function renderNsfwFilterPage(req, res, {
  appName,
  status = 200,
  notice = null,
  errors = [],
} = {}) {
  res.status(status).render('settings/nsfw-filter.njk', {
    appName,
    enabled: getNsfwFilterSettingsService(req).isEnabled(),
    notice,
    errors,
  });
}

function buildDefaultsPageModel(service, {
  submittedValues = null,
  errors = {},
} = {}) {
  const hasSubmittedValues = submittedValues !== null;
  const sections = DEFAULTS_PAGE_SECTIONS.map(({ page, title, anchor }) => ({
    page,
    title,
    anchor,
    fields: Object.keys(PAGE_DEFAULT_DEFINITIONS[page]).map((option) => {
      const definition = PAGE_DEFAULT_DEFINITIONS[page][option];
      const name = pageDefaultFieldName(page, option);
      const savedValue = service.getSavedDefault(page, option);
      const fallbackValue = service.getFallback(page, option);
      const effectiveValue = service.resolve(page, option);
      const submittedValue = hasSubmittedValues
        ? submittedValues[page]?.[option]
        : effectiveValue;
      const error = errors[name] || null;
      const showSubmittedValue = hasSubmittedValues
        && Boolean(error)
        && typeof submittedValue === 'string'
        && !definition.values.includes(submittedValue);

      return {
        id: name,
        name,
        label: DEFAULT_OPTION_LABELS[page]?.[option] ?? DEFAULT_OPTION_LABELS[option],
        options: definition.values.map((value) => ({
          value,
          label: defaultValueLabel(page, option, value),
        })),
        selectedValue: submittedValue,
        savedLabel: savedValue === undefined ? null : defaultValueLabel(page, option, savedValue),
        fallbackLabel: defaultValueLabel(page, option, fallbackValue),
        usesFallback: savedValue === undefined,
        error,
        showSubmittedValue,
        submittedOptionValue: showSubmittedValue ? submittedValue : null,
        submittedDisplayValue: Array.isArray(submittedValue)
          ? submittedValue.join(', ')
          : submittedValue,
      };
    }),
  }));

  const errorMessages = [...Object.values(errors)];

  return {
    sections,
    hasErrors: errorMessages.length > 0,
    errorMessages,
  };
}

function previewCategoryIsEnabled(category) {
  return category?.enabled === 1 || category?.enabled === true;
}

function previewCategorySlug(category) {
  return category?.directory_slug ?? category?.directorySlug;
}

function previewCategoryDisplayName(category) {
  return category?.display_name ?? category?.displayName ?? `Category ${category?.id}`;
}

function previewCategoryErrorMessage(error) {
  if (typeof error?.errors?.value === 'string') return error.errors.value;
  if (error?.errors && typeof error.errors === 'object') {
    const first = Object.values(error.errors).find((value) => typeof value === 'string');
    if (first) return first;
  }
  return typeof error?.message === 'string' ? error.message : null;
}

function buildPreviewCategoryModel({
  previewCategorySettingsService,
  categories,
  submittedValue,
  error,
} = {}) {
  const allCategories = Array.isArray(categories) ? categories : [];
  const enabledCategories = allCategories
    .filter(previewCategoryIsEnabled)
    .map((category) => ({
      displayName: previewCategoryDisplayName(category),
      directorySlug: previewCategorySlug(category),
    }))
    .filter((category) => typeof category.directorySlug === 'string' && category.directorySlug.length > 0);
  const storedValue = previewCategorySettingsService.getPreviewCategory();
  const validValues = new Set([
    PREVIEW_CATEGORY_DISABLED_VALUE,
    ...enabledCategories.map((category) => category.directorySlug),
  ]);
  const storedCategory = allCategories.find((category) => previewCategorySlug(category) === storedValue);
  const storedAvailable = validValues.has(storedValue);
  const submittedValueProvided = typeof submittedValue === 'string';
  const selectedValue = submittedValueProvided
    ? submittedValue
    : (storedAvailable ? storedValue : '');
  const submittedOption = submittedValueProvided
    && submittedValue.length > 0
    && !validValues.has(submittedValue)
    ? {
        value: submittedValue,
        label: 'Submitted value is unavailable; choose a valid replacement.',
      }
    : null;
  let selectionPlaceholder = null;
  if (selectedValue === '') {
    const unavailableLabel = !submittedValueProvided && !storedAvailable
      ? storedCategory
        ? `${previewCategoryDisplayName(storedCategory)} (disabled)`
        : (typeof storedValue === 'string' && storedValue.length > 0
          ? `Category "${storedValue}" (unavailable)`
          : 'Invalid saved preview category')
      : null;
    selectionPlaceholder = {
      value: '',
      label: unavailableLabel
        ? `Saved setting unavailable — ${unavailableLabel}.`
        : 'Choose a valid replacement…',
      disabled: true,
    };
  }

  let storedLabel = 'Invalid saved preview category';
  if (storedValue === PREVIEW_CATEGORY_DISABLED_VALUE) {
    storedLabel = 'Disabled';
  } else if (storedCategory) {
    storedLabel = `${previewCategoryDisplayName(storedCategory)}${previewCategoryIsEnabled(storedCategory) ? '' : ' (disabled)'}`;
  } else if (typeof storedValue === 'string' && storedValue.length > 0) {
    storedLabel = `Category "${storedValue}" (unavailable)`;
  }

  return {
    disabledValue: PREVIEW_CATEGORY_DISABLED_VALUE,
    enabledCategories,
    storedValue,
    storedLabel,
    options: [
      { value: PREVIEW_CATEGORY_DISABLED_VALUE, label: 'Disabled' },
      ...enabledCategories.map((category) => ({
        value: category.directorySlug,
        label: category.displayName,
      })),
    ],
    selectedValue,
    submittedOption,
    selectionPlaceholder,
    errorMessage: previewCategoryErrorMessage(error),
  };
}

function validateSubmittedPageDefaults(service, submittedValues, body) {
  const errors = {};
  const validatedValues = {};

  for (const { page } of DEFAULTS_POST_SECTIONS) {
    if (!defaultsPageWasSubmitted(body, page)) continue;
    try {
      validatedValues[page] = service.validatePageDefaults(page, submittedValues[page]);
    } catch (err) {
      if (!(err instanceof PageDefaultValidationError)) throw err;
      for (const [option, message] of Object.entries(err.errors || {})) {
        errors[pageDefaultFieldName(page, option)] = message;
      }
    }
  }

  return { errors, validatedValues };
}

function renderDefaultsPage(req, res, {
  appName,
  status = 200,
  notice = null,
  submittedValues = null,
  errors = {},
} = {}) {
  const service = getPageDefaultsService(req);
  res.status(status).render('settings/defaults.njk', {
    appName,
    notice,
    ...buildDefaultsPageModel(service, {
      submittedValues,
      errors,
    }),
  });
}

/**
 * Phase 11.2 — server-rendered backup management and guarded restore.
 *
 * @param {object} opts
 * @param {string} opts.appName
 * @param {import('better-sqlite3').Database} opts.db - the app's live connection
 * @param {ReturnType<import('../services/backup-service.js').createBackupService>} opts.backupService
 * @param {{active: boolean}} opts.maintenanceState - shared, mutated in place
 * @param {(newDb: import('better-sqlite3').Database) => void} [opts.onDatabaseReplaced]
 *   Called after a restore (success or a rolled-back failure) leaves the
 *   caller with a new live connection. The caller is responsible for
 *   re-pointing every other service/route at it — this module never touches
 *   any connection but the one it was given.
 */
function transitionFailureNotice(result) {
  if (result.alreadyEnabled) return 'auth_already_enabled';
  if (result.alreadyDisabled) return 'auth_already_disabled';
  if (result.conflict) return 'auth_transition_conflict';
  return 'auth_transition_failed';
}

function parseCategoryId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value)) {
    return null;
  }
  return id;
}

function parseTagId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value)) {
    return null;
  }
  return id;
}

// Directory-slug uniqueness is enforced by a case-insensitive unique index,
// not by the service's own validation — a conflicting insert/update throws
// straight from better-sqlite3 rather than an AssetCategoryValidationError.
function isDuplicateSlugError(err) {
  return (
    err != null &&
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof err.message === 'string' &&
    err.message.includes('asset_category_defaults')
  );
}

/**
 * Parse the batch reorder form contract: one `orderedCategoryIds` field whose
 * value is a comma-separated list of canonical positive integer IDs. An empty
 * string represents the complete empty set; a missing field is invalid.
 */
function parseOrderedCategoryIds(raw) {
  if (raw === undefined || raw === null) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Submit the complete ordered category ID list.',
    });
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be submitted as one comma-separated value.',
    });
  }
  if (raw === '') return [];
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be canonical positive integers separated by commas.',
    });
  }

  const ids = raw.split(',').map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be safe positive integers.',
    });
  }
  return ids;
}

// Full order array with the given id swapped one position toward `direction`.
// Returns null if the id isn't present; returns the unchanged order if
// already at the boundary (a no-op move).
function buildMovedOrder(categories, id, direction) {
  const ids = categories.map((c) => c.id);
  const index = ids.indexOf(id);
  if (index === -1) return null;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= ids.length) return ids;
  const reordered = [...ids];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  return reordered;
}

export function createSettingsRouter({
  appName,
  db,
  assetCategoryService,
  backupService,
  maintenanceState,
  processingJobService,
  authService,
  cookieOptions,
  onDatabaseReplaced,
  authTransitionService,
  projectsRoot,
  databasePath,
  appDataRoot,
  backupRetentionCount,
  autoScanIntervalMinutes,
  appMetaRepository,
  authSettings,
  assetBrowserPreferenceService,
  previewCategorySettingsService,
  applicationLogRepository,
  applicationLogDefaultPageSize,
  applicationLogger,
} = {}) {
  if (!assetBrowserPreferenceService) {
    throw new Error('createSettingsRouter requires an assetBrowserPreferenceService dependency.');
  }
  if (!previewCategorySettingsService) {
    throw new Error('createSettingsRouter requires a previewCategorySettingsService dependency.');
  }
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function') {
    throw new Error('createSettingsRouter requires an appMetaRepository dependency.');
  }
  if (!applicationLogRepository || typeof applicationLogRepository.findPage !== 'function') {
    throw new Error('createSettingsRouter requires an applicationLogRepository dependency.');
  }
  if (!applicationLogger || typeof applicationLogger.info !== 'function') {
    throw new Error('createSettingsRouter requires an applicationLogger dependency.');
  }

  const router = express.Router();
  const replaceDatabase = typeof onDatabaseReplaced === 'function' ? onDatabaseReplaced : () => {};

  // GET never mutates — the overview only reads backup listings and
  // deployment-controlled configuration values, never edits them.
  router.get('/', (req, res) => {
    const backups = backupService.listBackups();
    res.render('settings/index.njk', {
      appName,
      authEnabled: Boolean(authService),
      username: res.locals.auth?.username || null,
      latestBackup: backups[0] || null,
      latestBackupRelative: backups[0] ? formatRelativeTime(backups[0].createdAt) : null,
      backupCount: backups.length,
      invalidBackupCount: backups.filter((b) => !b.valid).length,
      retentionCount: backupRetentionCount,
      autoScanIntervalMinutes,
      automaticScanTiming: buildAutomaticScanTiming(appMetaRepository, autoScanIntervalMinutes),
      paths: { projectsRoot, databasePath, appDataRoot },
      session: authSettings
        ? {
            ttlHours: authSettings.sessionTtlHours,
            cookieSecure: authSettings.cookieSecure,
            trustProxy: authSettings.trustProxy,
            hstsEnabled: authSettings.hstsEnabled,
          }
        : null,
    });
  });

  // GET never mutates — listing only reads the managed backup directory.
  router.get('/backups', (req, res) => {
    const backups = backupService.listBackups();
    res.render('settings/backups.njk', {
      appName,
      backups,
      notice: resolveNotice(req.query.notice),
    });
  });

  router.get('/logs', (req, res, next) => {
    try {
      renderLogsPage(req, res, { appName, applicationLogRepository, applicationLogDefaultPageSize });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logs/defaults', (req, res, next) => {
    const optionCatalogues = buildLogsDefaultOptionCatalogues(getLogFilterOptions(applicationLogRepository));
    let changedOptionCount = 0;

    handlePageDefaultsPost(req, res, next, {
      db,
      pageDefaultsService: getPageDefaultsService(req),
      page: LOGS_PAGE_DEFAULTS,
      successMessage: LOGS_DEFAULTS_NOTICE,
      saveErrorMessage: 'Logs defaults could not be saved. No changes were made.',
      optionCatalogues,
      onValidationError: ({ submittedValues, errors }) => {
        renderLogsPage(req, res, {
          appName,
          applicationLogRepository,
          applicationLogDefaultPageSize,
          status: 422,
          logsDefaultsDialogOpen: true,
          logsDefaultsSubmittedValues: submittedValues,
          logsDefaultsErrors: errors,
        });
      },
      saveValidatedValues: ({ validatedValues }) => {
        const service = getPageDefaultsService(req);
        for (const option of Object.keys(PAGE_DEFAULT_DEFINITIONS[LOGS_PAGE_DEFAULTS])) {
          const outcome = service.saveDefaultWithOutcome(
            LOGS_PAGE_DEFAULTS,
            option,
            validatedValues[option],
            optionCatalogues[option],
          );
          if (outcome.changed) changedOptionCount += 1;
        }
        if (changedOptionCount > 0) {
          logSettingsActivity(applicationLogger, 'settings.logs_defaults.updated', { changedOptionCount });
        }
      },
      onSuccess: ({ validatedValues }) => {
        res.redirect(buildLogsUrl(validatedValues));
      },
    });
  });

  // GET never mutates — this is the no-JavaScript confirmation fallback for
  // the destructive clear action.
  router.get('/logs/clear', (req, res) => {
    res.render('settings/logs-clear-confirm.njk', {
      appName,
      returnUrl: buildLogsUrl(buildLogFilters(req.query, getLogFilterOptions(applicationLogRepository))),
    });
  });

  router.post('/logs/clear', (req, res, next) => {
    try {
      const deletedCount = applicationLogRepository.clear();
      logSettingsActivity(applicationLogger, 'logging.cleared', { deletedCount }, 'Application logs cleared.');

      if (req.get('accept')?.includes('application/json')) return res.json({ status: 'success', deletedCount });
      res.redirect('/settings/logs?notice=logging_cleared');
    } catch (err) {
      return next(err);
    }
  });

  router.get('/defaults', (req, res) => {
    renderDefaultsPage(req, res, {
      appName,
      notice: resolveNotice(req.query.notice),
    });
  });

  router.post('/defaults', (req, res, next) => {
    const service = getPageDefaultsService(req);
    const submittedValues = readSubmittedPageDefaults(req.body, service);
    let validation;
    try {
      validation = validateSubmittedPageDefaults(service, submittedValues, req.body);
    } catch (err) {
      return next(err);
    }

    if (Object.keys(validation.errors).length > 0) {
      renderDefaultsPage(req, res, {
        appName,
        status: 422,
        submittedValues,
        errors: validation.errors,
      });
      return;
    }

    const changedOptionsByPage = new Map();
    try {
      db.transaction(() => {
        for (const { page } of DEFAULTS_POST_SECTIONS) {
          for (const option of Object.keys(PAGE_DEFAULT_DEFINITIONS[page])) {
            if (!defaultsPageWasSubmitted(req.body, page)) continue;

            const outcome = service.saveDefaultWithOutcome(
              page,
              option,
              validation.validatedValues[page][option],
            );
            if (outcome.changed) {
              changedOptionsByPage.set(page, (changedOptionsByPage.get(page) || 0) + 1);
            }
          }
        }
      })();
    } catch (err) {
      return next(err);
    }

    const changedPages = DEFAULTS_POST_SECTIONS
      .map(({ page }) => page)
      .filter((page) => changedOptionsByPage.has(page));
    if (changedPages.length > 0) {
      logSettingsActivity(applicationLogger, 'settings.defaults.updated', {
        changedPages,
        changedOptionCount: [...changedOptionsByPage.values()].reduce((count, value) => count + value, 0),
      });
    }
    res.redirect('/settings/defaults?notice=defaults_saved');
  });

  router.get('/nsfw-filter', (req, res) => {
    renderNsfwFilterPage(req, res, {
      appName,
      notice: resolveNotice(req.query.notice),
    });
  });

  router.post('/nsfw-filter', (req, res, next) => {
    let enabled;
    try {
      enabled = parseEnabledField(req.body?.enabled, { defaultValue: false });
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        renderNsfwFilterPage(req, res, {
          appName,
          status: 422,
          errors: Object.values(err.errors),
        });
        return;
      }
      return next(err);
    }

    const service = getNsfwFilterSettingsService(req);
    try {
      const outcome = service.setEnabledWithOutcome(enabled);
      if (outcome.changed) {
        logSettingsActivity(applicationLogger, 'settings.nsfw_filter.updated', { enabled });
      }
      res.redirect(`/settings/nsfw-filter?notice=${enabled ? 'nsfw_filter_enabled' : 'nsfw_filter_disabled'}`);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/tags', (req, res) => {
    renderTagsPage(req, res, {
      appName,
      notice: resolveNotice(req.query.notice),
    });
  });

  router.post('/tags', (req, res, next) => {
    const submittedName = typeof req.body?.name === 'string' ? req.body.name : '';

    try {
      getTagService(req).createTag({ name: submittedName });
      res.redirect('/settings/tags?notice=tag_created');
    } catch (err) {
      if (err instanceof TagValidationError) {
        renderTagsPage(req, res, {
          appName,
          status: 422,
          submittedName,
          errors: err.errors || { name: err.message },
        });
        return;
      }
      next(err);
    }
  });

  router.get('/tags/:tagId/edit', (req, res, next) => {
    const tagId = parseTagId(req.params.tagId);
    if (tagId === null) return next(createNotFound());

    try {
      const tag = getTagService(req).getTag(tagId);
      renderTagEditPage(res, { appName, tag });
    } catch (err) {
      if (err instanceof TagNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  router.post('/tags/:tagId/edit', (req, res, next) => {
    const tagId = parseTagId(req.params.tagId);
    if (tagId === null) return next(createNotFound());

    const submittedName = typeof req.body?.name === 'string' ? req.body.name : '';
    const service = getTagService(req);
    let tag;

    try {
      tag = service.getTag(tagId);
      service.renameTag(tagId, { name: submittedName });
      res.redirect('/settings/tags?notice=tag_renamed');
    } catch (err) {
      if (err instanceof TagNotFoundError) return next(createNotFound());
      if (err instanceof TagValidationError) {
        renderTagEditPage(res, {
          appName,
          tag,
          status: 422,
          submittedName,
          errors: err.errors || { name: err.message },
        });
        return;
      }
      return next(err);
    }
  });

  router.get('/tags/:tagId/delete', (req, res, next) => {
    const tagId = parseTagId(req.params.tagId);
    if (tagId === null) return next(createNotFound());

    try {
      const tag = getTagService(req).getTag(tagId);
      res.render('settings/tag-delete-confirm.njk', { appName, tag });
    } catch (err) {
      if (err instanceof TagNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  router.post('/tags/:tagId/delete', (req, res, next) => {
    const tagId = parseTagId(req.params.tagId);
    if (tagId === null) return next(createNotFound());

    try {
      getTagService(req).deleteTag(tagId);
      res.redirect('/settings/tags?notice=tag_deleted');
    } catch (err) {
      if (err instanceof TagNotFoundError) return next(createNotFound());
      return next(err);
    }
  });

  // ─── Open locally (v2) ─────────────────────────────────────────────────
  //
  // Configures the Windows projects root used to build v2 "Open locally"
  // URIs. The value is validated for shape only — the app runs in
  // Docker/Linux, so the service can never verify the Windows path exists.

  router.get('/open-locally', (req, res) => {
    renderOpenLocallyPage(req, res, {
      appName,
      projectsRoot,
      notice: resolveNotice(req.query.notice),
    });
  });

  router.post('/open-locally', (req, res, next) => {
    const submittedValue = typeof req.body?.windowsProjectsPath === 'string'
      ? req.body.windowsProjectsPath
      : '';

    const service = getOpenLocallySettingsService(req);
    try {
      const outcome = service.setWindowsProjectsPathWithOutcome(submittedValue);
      if (outcome.changed) {
        logSettingsActivity(applicationLogger, 'settings.open_locally.updated', { configured: true });
      }
      res.redirect('/settings/open-locally?notice=open_locally_saved');
    } catch (err) {
      if (err instanceof OpenLocallySettingsValidationError) {
        renderOpenLocallyPage(req, res, {
          appName,
          projectsRoot,
          status: 422,
          submittedValue,
          errors: err.errors || { windowsProjectsPath: err.message },
        });
        return;
      }
      return next(err);
    }
  });

  router.post('/open-locally/clear', (req, res, next) => {
    try {
      const outcome = getOpenLocallySettingsService(req).clearWindowsProjectsPathWithOutcome();
      if (outcome.changed) logSettingsActivity(applicationLogger, 'settings.open_locally.cleared', { configured: false });
      res.redirect('/settings/open-locally?notice=open_locally_cleared');
    } catch (err) {
      return next(err);
    }
  });

  if (authService) {
    router.get('/security', (req, res) => {
      res.render('settings/security.njk', {
        appName,
        notice: resolveNotice(req.query.notice),
        errors: [],
        currentPasswordError: null,
      });
    });

    router.post('/security/password', (req, res) => {
      const result = authService.rotatePassword({
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
        confirmation: req.body?.confirmPassword,
      });
      if (!result.ok) {
        res.status(400);
        res.render('settings/security.njk', {
          appName,
          notice: null,
          errors: result.errors || [],
          currentPasswordError: result.currentPasswordError || null,
        });
        return;
      }
      logSettingsActivity(applicationLogger, 'security.password_changed');
      clearSessionCookie(res, cookieOptions);
      res.redirect('/login?notice=password_rotated');
    });

    // Phase 13 — guarded disable-authentication workflow. Only reachable
    // while authentication is enabled (requireAuth already protects it like
    // any other route; authTransitionService.disable() also independently
    // refuses if it somehow finds auth already disabled).
    router.get('/security/disable', (_req, res) => {
      res.render('settings/disable-confirm.njk', {
        appName,
        currentPasswordError: null,
      });
    });

    router.post('/security/disable', (req, res) => {
      const result = authTransitionService.disable({
        username: res.locals.auth?.username,
        currentPassword: req.body?.currentPassword,
      });
      if (!result.ok) {
        if (result.currentPasswordError) {
          res.status(400);
          res.render('settings/disable-confirm.njk', {
            appName,
            currentPasswordError: result.currentPasswordError,
          });
          return;
        }
        res.redirect(`/settings/security?notice=${transitionFailureNotice(result)}`);
        return;
      }
      logSettingsActivity(applicationLogger, 'security.disabled');
      clearSessionCookie(res, cookieOptions);
      res.redirect('/settings/security?notice=authentication_disabled');
    });
  } else {
    // Phase 13 — browser-based enable-authentication workflow. Available
    // only while authentication is disabled; the app has no session/auth
    // wall at all in this mode, so CSRF here is the disabled-mode anonymous
    // pepper-derived token (see middleware/csrf.js), not session-bound.
    router.get('/security', (req, res) => {
      res.render('settings/security-disabled.njk', {
        appName,
        notice: resolveNotice(req.query.notice),
        errors: [],
        retainedUsername: '',
      });
    });

    router.post('/security/enable', (req, res) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
      const result = authTransitionService.enable({
        username,
        password: req.body?.password,
        confirmation: req.body?.confirmPassword,
      });
      if (!result.ok) {
        if (result.errors) {
          res.status(400);
          res.render('settings/security-disabled.njk', {
            appName,
            notice: null,
            errors: result.errors,
            retainedUsername: username,
          });
          return;
        }
        res.redirect(`/settings/security?notice=${transitionFailureNotice(result)}`);
        return;
      }
      logSettingsActivity(applicationLogger, 'security.enabled');
      res.redirect('/login?notice=authentication_enabled');
    });
  }

  router.post('/backups', async (req, res) => {
    try {
      const result = await backupService.createBackup(db);
      const notice = result.pruneWarnings && result.pruneWarnings.length > 0
        ? 'backup_created_prune_warning'
        : 'backup_created';
      logSettingsActivity(applicationLogger, 'backup.created');
      res.redirect(`/settings/backups?notice=${notice}`);
    } catch {
      // Never surface the internal exception text — createBackup already
      // discards any partial/staging file before rejecting.
      res.redirect('/settings/backups?notice=backup_failed');
    }
  });

  // GET never mutates — this is purely the confirmation view.
  router.get('/backups/:filename/restore', (req, res, next) => {
    const backup = backupService.listBackups().find((entry) => entry.filename === req.params.filename);
    if (!backup) {
      return next(createNotFound());
    }
    res.render('settings/restore-confirm.njk', { appName, backup });
  });

  router.post('/backups/:filename/restore', async (req, res) => {
    // Belt-and-suspenders: the maintenance middleware in app.js already
    // rejects ordinary requests once `maintenanceState.active` is set, but
    // that flag is only set *after* this handler begins running, so two
    // near-simultaneous submissions could both reach here before either
    // flips it. Checking both this flag and the service's own guard closes
    // that window without weakening either boundary.
    if (
      maintenanceState.active
      || backupService.isRestoreInProgress()
      || processingJobService?.hasActiveJobs?.()
    ) {
      return res.redirect('/settings/backups?notice=restore_conflict');
    }

    maintenanceState.active = true;
    try {
      // restoreBackup re-resolves and re-validates the filename itself —
      // traversal, symlink, missing, staging/rollback, and invalid-schema
      // backups are all rejected there, never trusted from the URL alone.
      const result = await backupService.restoreBackup(req.params.filename, db);
      // Phase 12.1: a restored database may carry session rows from whenever
      // the backup was taken — potentially long-lived, no longer trustworthy
      // sessions. Wipe them on the connection being adopted, before any
      // request can resolve against it, rather than relying on whichever
      // authService happens to be rebuilt around it. Best-effort: a real
      // restored connection always supports this, but must never block
      // adopting the connection if it somehow doesn't.
      try { invalidateAllSessionsForDb(result.db); } catch { /* best-effort */ }
      replaceDatabase(result.db);
      // replaceDatabase rebuilds the app graph and rebinds the shared logger
      // to the restored database before publishing it. Log only after that
      // authoritative handoff so the activity record cannot land in the old DB.
      logSettingsActivity(applicationLogger, 'backup.restored');
      res.redirect('/settings/backups?notice=restore_success');
    } catch (err) {
      // A BackupError carrying `.db` means the live database was already
      // closed and a recovered connection was reopened before this handler
      // sees the error — the caller must adopt it even though the restore
      // itself failed, or every other route is left holding a closed handle.
      if (err instanceof BackupError && err.db) {
        try { invalidateAllSessionsForDb(err.db); } catch { /* best-effort */ }
        replaceDatabase(err.db);
      }
      res.redirect('/settings/backups?notice=restore_failed');
    } finally {
      maintenanceState.active = false;
    }
  });

  // GET never mutates — this is purely the confirmation view.
  router.get('/backups/:filename/delete', (req, res, next) => {
    const backup = backupService.listBackups().find((entry) => entry.filename === req.params.filename);
    if (!backup) {
      return next(createNotFound());
    }
    res.render('settings/delete-confirm.njk', { appName, backup });
  });

  router.post('/backups/:filename/delete', (req, res) => {
    try {
      // deleteBackup re-resolves and re-checks the filename itself —
      // traversal, symlink, staging/rollback, and unmanaged names are all
      // rejected there, never trusted from the URL alone.
      backupService.deleteBackup(req.params.filename);
      logSettingsActivity(applicationLogger, 'backup.deleted');
      res.redirect('/settings/backups?notice=backup_deleted');
    } catch {
      res.redirect('/settings/backups?notice=delete_failed');
    }
  });

  // ─── Asset category defaults (Phase 1) ────────────────────────────────
  //
  // Database-only: every handler below talks exclusively to
  // assetCategoryService (already-constructed, injected explicitly — see
  // app.js). None of these routes touch project-storage, manifests, or the
  // filesystem. These are global *defaults* copied into new projects at
  // creation time; editing/disabling/deleting a default never reaches back
  // into project-owned categories already copied from it.

  function renderCategoriesPage(res, {
    status = 200,
    notice = null,
    editingId = null,
    editValues = null,
    editErrors = {},
    addValues = { enabled: true },
    addErrors = {},
    preferenceSubmittedValue,
    preferenceError = null,
    previewCategorySubmittedValue,
    previewCategoryError = null,
    enabledControl = null,
  } = {}) {
    const categories = assetCategoryService.listDefaults();
    const assetBrowserPreference = buildGlobalAssetBrowserPreferenceModel({
      preferenceService: assetBrowserPreferenceService,
      categories,
      submittedValue: preferenceSubmittedValue,
      error: preferenceError,
    });
    const previewCategory = buildPreviewCategoryModel({
      previewCategorySettingsService,
      categories,
      submittedValue: previewCategorySubmittedValue,
      error: previewCategoryError,
    });
    res.status(status).render('settings/asset-categories.njk', {
      appName,
      categories,
      assetBrowserPreference,
      previewCategory,
      notice,
      editingId,
      editValues,
      editErrors,
      addValues,
      addErrors,
      enabledControl,
    });
  }

  router.get('/asset-categories', (req, res) => {
    const editingId = parseCategoryId(req.query.edit);
    let editValues = null;
    if (editingId !== null) {
      const found = assetCategoryService.listDefaults().find((c) => c.id === editingId);
      if (found) {
        editValues = { displayName: found.display_name, directorySlug: found.directory_slug };
      }
    }
    renderCategoriesPage(res, {
      notice: resolveNotice(req.query.notice),
      editingId: editValues ? editingId : null,
      editValues,
    });
  });

  router.post('/asset-categories/browser-default', (req, res) => {
    const submittedValue = typeof req.body?.defaultCategory === 'string' ? req.body.defaultCategory : '';
    try {
      const outcome = assetBrowserPreferenceService.setGlobalPreferenceWithOutcome(submittedValue);
      if (outcome.changed) {
        logSettingsActivity(applicationLogger, 'settings.asset_browser_default.updated', {
          mode: outcome.value === 'all' ? 'all' : 'category',
        });
      }
      res.redirect('/settings/asset-categories?notice=global_default_saved');
    } catch (err) {
      if (err instanceof PreferenceValidationError) {
        renderCategoriesPage(res, {
          status: 422,
          preferenceSubmittedValue: submittedValue,
          preferenceError: err,
        });
        return;
      }
      renderCategoriesPage(res, { status: 500 });
    }
  });

  router.post('/asset-categories/preview-category', (req, res) => {
    const submittedValue = typeof req.body?.previewCategory === 'string' ? req.body.previewCategory : '';
    try {
      const outcome = previewCategorySettingsService.setPreviewCategoryWithOutcome(submittedValue);
      if (outcome.changed) {
        logSettingsActivity(applicationLogger, 'settings.preview_category.updated', {
          enabled: outcome.value !== PREVIEW_CATEGORY_DISABLED_VALUE,
        });
      }
      res.redirect('/settings/asset-categories?notice=preview_category_saved');
    } catch (err) {
      if (err instanceof PreviewCategoryValidationError) {
        renderCategoriesPage(res, {
          status: 422,
          previewCategorySubmittedValue: submittedValue,
          previewCategoryError: err,
        });
        return;
      }
      renderCategoriesPage(res, { status: 500 });
    }
  });

  router.post('/asset-categories', (req, res) => {
    const addValues = { displayName: req.body?.displayName, directorySlug: req.body?.directorySlug, enabled: true };
    try {
      addValues.enabled = parseEnabledField(req.body?.enabled, { defaultValue: true });
      assetCategoryService.addDefault({
        displayName: req.body?.displayName,
        directorySlug: req.body?.directorySlug,
        enabled: addValues.enabled,
      });
      res.redirect('/settings/asset-categories?notice=category_added');
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        renderCategoriesPage(res, { status: 422, addValues, addErrors: err.errors });
        return;
      }
      if (isDuplicateSlugError(err)) {
        renderCategoriesPage(res, {
          status: 422,
          addValues,
          addErrors: { directorySlug: 'A category with this directory slug already exists.' },
        });
        return;
      }
      renderCategoriesPage(res, { status: 500, addValues, notice: resolveNotice('category_mutation_failed') });
    }
  });

  // Complete-set reorder mutation. Registered before the generic
  // '/asset-categories/:id' route below so the literal "reorder" segment is
  // never captured as an :id param. The existing Move Up/Move Down routes
  // below use the same service operation after building their full order.
  router.post('/asset-categories/reorder', (req, res) => {
    try {
      const orderedIds = parseOrderedCategoryIds(req.body?.orderedCategoryIds);
      assetCategoryService.reorderDefaults(orderedIds);
      res.redirect('/settings/asset-categories?notice=category_reordered');
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        return renderCategoriesPage(res, {
          status: 422,
          notice: resolveNotice('category_reorder_invalid'),
        });
      }
      res.redirect('/settings/asset-categories?notice=category_reorder_failed');
    }
  });

  router.post('/asset-categories/:id', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());

    const editValues = { displayName: req.body?.displayName, directorySlug: req.body?.directorySlug };
    try {
      assetCategoryService.editDefault(id, editValues);
      res.redirect('/settings/asset-categories?notice=category_updated');
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof AssetCategoryValidationError) {
        renderCategoriesPage(res, { status: 422, editingId: id, editValues, editErrors: err.errors });
        return;
      }
      if (isDuplicateSlugError(err)) {
        renderCategoriesPage(res, {
          status: 422,
          editingId: id,
          editValues,
          editErrors: { directorySlug: 'A category with this directory slug already exists.' },
        });
        return;
      }
      renderCategoriesPage(res, { status: 500, editingId: id, editValues, notice: resolveNotice('category_mutation_failed') });
    }
  });

  router.post('/asset-categories/:id/enabled', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());

    let enabled;
    try {
      enabled = parseEnabledField(req.body?.enabled);
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        return renderCategoriesPage(res, {
          status: 422,
          enabledControl: {
            categoryId: id,
            submitted: null,
            errorMessage: err.errors.enabled || err.message,
          },
        });
      }
      return next(err);
    }

    try {
      assetCategoryService.setDefaultEnabled(id, enabled);
      const notice = enabled ? 'category_enabled' : 'category_disabled';
      res.redirect(`/settings/asset-categories?notice=${notice}`);
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      next(err);
    }
  });

  router.post('/asset-categories/:id/delete', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    try {
      assetCategoryService.deleteDefault(id);
      res.redirect('/settings/asset-categories?notice=category_deleted');
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      next(err);
    }
  });

  router.post('/asset-categories/:id/move-up', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    const categories = assetCategoryService.listDefaults();
    const orderedIds = buildMovedOrder(categories, id, 'up');
    if (!orderedIds) return next(createNotFound());
    try {
      assetCategoryService.reorderDefaults(orderedIds);
      res.redirect('/settings/asset-categories?notice=category_reordered');
    } catch {
      res.redirect('/settings/asset-categories?notice=category_reorder_failed');
    }
  });

  router.post('/asset-categories/:id/move-down', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    const categories = assetCategoryService.listDefaults();
    const orderedIds = buildMovedOrder(categories, id, 'down');
    if (!orderedIds) return next(createNotFound());
    try {
      assetCategoryService.reorderDefaults(orderedIds);
      res.redirect('/settings/asset-categories?notice=category_reordered');
    } catch {
      res.redirect('/settings/asset-categories?notice=category_reorder_failed');
    }
  });

  return router;
}
