const AUTO_REFRESH_INTERVAL_MS = 30_000;
const LOG_FILTER_NAMES = new Set(['level', 'kind', 'subsystem', 'time']);
const LOG_QUERY_CONTROL_NAMES = new Set(['pageSize']);
const LOG_FORM_STATE_NAMES = new Set([...LOG_FILTER_NAMES, ...LOG_QUERY_CONTROL_NAMES]);
const LOCAL_TIMEZONE = 'local';
const viewerStates = new WeakMap();

export function formatLogTimestamp(timestampMs, timezone = LOCAL_TIMEZONE, { localTimeZone } = {}) {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) return 'Unknown time';

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone === LOCAL_TIMEZONE ? localTimeZone : timezone,
      timeZoneName: 'short',
    }).formatToParts(new Date(timestampMs));
    const values = Object.fromEntries(parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${values.timeZoneName}`;
  } catch {
    return 'Unknown time';
  }
}

function formatLogTimestamps(region, timezone) {
  for (const element of region?.querySelectorAll?.('[data-log-timestamp-ms]') || []) {
    element.textContent = formatLogTimestamp(Number(element.getAttribute('data-log-timestamp-ms')), timezone);
  }
}

function isPageOne(viewer) {
  return Number(viewer.dataset?.logsPage || viewer.getAttribute?.('data-logs-page') || '1') === 1;
}

function isHidden(documentObject) {
  return Boolean(documentObject?.hidden);
}

function setStatus(state, message) {
  if (state.status) state.status.textContent = message;
}

function setControl(state) {
  const label = state.enabled ? 'Disable auto-refresh' : 'Enable auto-refresh';
  state.control.setAttribute('aria-pressed', String(state.enabled));
  state.control.setAttribute('aria-label', label);
  state.control.setAttribute('data-tooltip', label);
  const labelElement = state.control.querySelector?.('[data-logs-auto-refresh-label]');
  if (labelElement) labelElement.textContent = label;
  else if (state.autoRefreshLabel) state.autoRefreshLabel.textContent = label;
}

function clearScheduledRefresh(state) {
  if (state.timer !== null) {
    state.window.clearTimeout(state.timer);
    state.timer = null;
  }
}

function abortRefresh(state) {
  state.generation += 1;
  state.controller?.abort?.();
  state.controller = null;
}

function captureOpenDisclosures(region) {
  return new Set(
    Array.from(region?.querySelectorAll?.('[data-log-id] details[open]') || [])
      .map((details) => details.closest?.('[data-log-id]')?.getAttribute?.('data-log-id'))
      .filter(Boolean)
  );
}

function restoreOpenDisclosures(region, ids) {
  for (const row of Array.from(region?.querySelectorAll?.('[data-log-id]') || [])) {
    if (!ids.has(row.getAttribute?.('data-log-id'))) continue;
    const details = row.querySelector?.('details');
    if (details) details.open = true;
  }
}

function logIds(region) {
  return new Set(
    Array.from(region?.querySelectorAll?.('[data-log-id]') || [])
      .map((row) => row.getAttribute?.('data-log-id'))
      .filter(Boolean)
  );
}

function isLogFormStateField(field) {
  return LOG_FORM_STATE_NAMES.has(field?.name);
}

function isSelectedFilterField(field) {
  return (field?.type !== 'checkbox' && field?.type !== 'radio') || field.checked;
}

function filterFields(state, name) {
  return Array.from(state.form?.querySelectorAll?.('[name]') || [])
    .filter((field) => field.name === name);
}

function setLogFilterValue(state, name, value) {
  const fields = filterFields(state, name);
  if (fields.some((field) => field.type === 'radio')) {
    const selected = fields.find((field) => field.value === String(value ?? ''));
    fields.forEach((field) => { field.checked = field === selected; });
    const EventConstructor = state.window.Event || globalThis.Event;
    if (selected?.dispatchEvent && typeof EventConstructor === 'function') {
      selected.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    }
    return;
  }
  fields.forEach((field) => { field.value = String(value ?? ''); });
}

function logFilterUrl(state) {
  const url = new URL(state.form?.getAttribute?.('action') || '/settings/logs', state.window.location.href);
  url.search = '';
  for (const field of Array.from(state.form?.querySelectorAll?.('[name]') || [])) {
    if (field.disabled || !field.name || !field.value || !isSelectedFilterField(field)) continue;
    url.searchParams.set(field.name, field.value);
  }
  return url;
}

function currentPageRefreshUrl(state) {
  const url = logFilterUrl(state);
  const page = Number(state.viewer.dataset?.logsPage);
  if (Number.isSafeInteger(page) && page > 1) url.searchParams.set('page', String(page));
  return url.href;
}

function pageOneRefreshUrl(state) {
  const url = logFilterUrl(state);
  url.searchParams.delete('page');
  return url.href;
}

function replaceUrl(state, url) {
  state.window.history?.replaceState?.(null, '', url);
}

function synchronizePageState(state, page) {
  const effectivePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const pageOne = effectivePage === 1;
  state.viewer.dataset.logsPage = String(effectivePage);
  state.viewer.setAttribute?.('data-logs-page', String(effectivePage));
  state.enabled = state.autoRefreshPreference && pageOne;
  state.control.disabled = !pageOne;
  if (state.autoRefreshHelp) state.autoRefreshHelp.hidden = pageOne;
  if (pageOne) state.control.removeAttribute?.('aria-describedby');
  else state.control.setAttribute?.('aria-describedby', 'logs-auto-refresh-help');
  setControl(state);
}

function currentLogFilterValue(state, name) {
  const fields = filterFields(state, name);
  const selected = fields.find(isSelectedFilterField);
  return String(selected?.value ?? '');
}

function captureCurrentPageDefaults(state) {
  return {
    ...Object.fromEntries([...LOG_FORM_STATE_NAMES]
      .map((name) => [name, currentLogFilterValue(state, name)])),
    timezone: state.timezone,
    autoRefresh: state.autoRefreshPreference ? 'enabled' : 'disabled',
  };
}

function applySavedDefaults(state, values = {}) {
  state.suppressFilterChange = true;
  try {
    LOG_FORM_STATE_NAMES.forEach((name) => setLogFilterValue(state, name, values[name]));
  } finally {
    state.suppressFilterChange = false;
  }
  if (typeof values.timezone === 'string') {
    state.timezone = values.timezone;
    state.viewer.dataset.logsTimezone = values.timezone;
    formatLogTimestamps(state.viewer, state.timezone);
  }
  state.autoRefreshPreference = values.autoRefresh === 'enabled';
  synchronizePageState(state, Number(state.viewer.dataset.logsPage));
}

function bindDefaultsDialog(state) {
  const dialog = state.document.getElementById?.('logs-defaults-dialog');
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!dialogState) return;

  dialogState.onSuccessfulSubmit = (payload) => {
    const values = payload?.values;
    if (!values || typeof values !== 'object') return false;
    const currentValues = captureCurrentPageDefaults(state);
    const queryStateChanged = [...LOG_FORM_STATE_NAMES]
      .some((name) => String(values[name] ?? '') !== currentValues[name]);
    const autoRefreshChanged = values.autoRefresh !== currentValues.autoRefresh;
    applySavedDefaults(state, values);
    dialogState.savedValues = values;
    dialog.close?.();
    if (queryStateChanged) void applyCurrentFilters(state);
    else if (autoRefreshChanged) {
      clearScheduledRefresh(state);
      if (!state.enabled) abortRefresh(state);
      scheduleRefresh(state);
    }
    return true;
  };
}

function bindClearDialog(state) {
  const dialog = state.document?.getElementById?.('logs-clear-dialog');
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!dialog || !dialogState || dialog.dataset.logsClearBound === 'true') return;
  dialog.dataset.logsClearBound = 'true';
  dialogState.onSuccessfulSubmit = () => requestPageOneResults(state, {
    failureMessage: 'Could not refresh logs. Try again.',
  });
}

function updateResults(state, responseText, { announceNew = false } = {}) {
  const parser = new state.window.DOMParser();
  const nextRegion = parser.parseFromString(responseText, 'text/html')
    ?.querySelector?.('[data-logs-results]');
  const currentRegion = state.viewer.querySelector?.('[data-logs-results]');
  if (!nextRegion || !currentRegion) return false;
  if (currentRegion.contains?.(state.document.activeElement)) return false;

  const currentIds = logIds(currentRegion);
  const openDisclosures = captureOpenDisclosures(currentRegion);
  formatLogTimestamps(nextRegion, state.timezone);
  currentRegion.replaceWith(nextRegion);
  restoreOpenDisclosures(nextRegion, openDisclosures);
  if (!announceNew) return true;

  const newCount = [...logIds(nextRegion)].filter((id) => !currentIds.has(id)).length;
  if (newCount === 1) setStatus(state, '1 new log entry');
  else if (newCount > 1) setStatus(state, `${newCount} new log entries`);
  return true;
}

async function requestResults(state, {
  announceNew = false,
  failureMessage,
  url = currentPageRefreshUrl(state),
} = {}) {
  abortRefresh(state);
  const generation = state.generation;
  const controller = typeof state.window.AbortController === 'function'
    ? new state.window.AbortController()
    : null;
  state.controller = controller;

  try {
    const response = await state.window.fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      signal: controller?.signal,
    });
    if (!response?.ok || typeof response.text !== 'function') throw new Error(failureMessage);
    const responseText = await response.text();
    if (
      state.generation !== generation
      || state.controller !== controller
      || isHidden(state.document)
    ) return false;
    return updateResults(state, responseText, { announceNew });
  } catch (error) {
    if (state.generation === generation && error?.name !== 'AbortError') {
      setStatus(state, failureMessage);
    }
    return false;
  } finally {
    if (state.generation === generation && state.controller === controller) state.controller = null;
  }
}

function scheduleRefresh(state, delay = AUTO_REFRESH_INTERVAL_MS) {
  clearScheduledRefresh(state);
  if (!state.enabled || !isPageOne(state.viewer) || isHidden(state.document)) return;
  state.timer = state.window.setTimeout(() => {
    state.timer = null;
    refresh(state).finally(() => {
      scheduleRefresh(state);
    });
  }, delay);
}

async function refresh(state) {
  if (!state.enabled || !isPageOne(state.viewer) || isHidden(state.document)) return false;
  return requestResults(state, {
    announceNew: true,
    failureMessage: 'Could not refresh logs. Will try again.',
  });
}

async function requestCurrentPageResults(state, options = {}) {
  clearScheduledRefresh(state);
  try {
    return await requestResults(state, {
      ...options,
      url: currentPageRefreshUrl(state),
    });
  } finally {
    scheduleRefresh(state);
  }
}

async function requestPageOneResults(state, options = {}) {
  clearScheduledRefresh(state);
  synchronizePageState(state, 1);
  const url = pageOneRefreshUrl(state);
  replaceUrl(state, url);
  try {
    return await requestResults(state, { ...options, url });
  } finally {
    scheduleRefresh(state);
  }
}

async function applyCurrentFilters(state) {
  return requestPageOneResults(state, {
    failureMessage: 'Could not update logs. Try again.',
  });
}

function clearCurrentFilters(state) {
  state.suppressFilterChange = true;
  try {
    LOG_FILTER_NAMES.forEach((name) => setLogFilterValue(state, name, ''));
  } finally {
    state.suppressFilterChange = false;
  }
  return applyCurrentFilters(state);
}

function destroy(state) {
  state.enabled = false;
  clearScheduledRefresh(state);
  abortRefresh(state);
  state.document.removeEventListener?.('visibilitychange', state.onVisibilityChange);
  state.window.removeEventListener?.('pagehide', state.onPageHide);
  state.form.removeEventListener?.('change', state.onFilterChange);
  state.form.removeEventListener?.('submit', state.onFilterSubmit);
  state.refreshControl?.removeEventListener?.('click', state.onManualRefresh);
  state.clearFiltersControl?.removeEventListener?.('click', state.onClearFilters);
  viewerStates.delete(state.viewer);
}

export function enhanceLogViewerAutoRefresh(scope = globalThis.document) {
  const viewer = scope?.querySelector?.('[data-logs-viewer]');
  if (!viewer || viewerStates.has(viewer)) return 0;

  const documentObject = viewer.ownerDocument || scope;
  const windowObject = documentObject.defaultView || globalThis.window;
  const control = viewer.querySelector?.('[data-logs-auto-refresh]');
  const autoRefreshLabel = control?.querySelector?.('[data-logs-auto-refresh-label]');
  const status = viewer.querySelector?.('[data-logs-live-status]');
  const form = viewer.querySelector?.('[data-logs-filter-form]') || viewer.querySelector?.('.logs-filter-form');
  const refreshControl = viewer.querySelector?.('[data-logs-refresh]');
  const clearFiltersControl = viewer.querySelector?.('[data-logs-clear-filters]');
  const autoRefreshHelp = viewer.querySelector?.('[data-logs-auto-refresh-help]');
  if (!windowObject?.fetch || !windowObject?.DOMParser || !control || !form) return 0;

  const state = {
    viewer,
    document: documentObject,
    window: windowObject,
    control,
    status,
    form,
    refreshControl,
    clearFiltersControl,
    autoRefreshHelp,
    enabled: viewer.dataset?.logsAutoRefreshEnabled === 'true' && isPageOne(viewer),
    autoRefreshPreference: viewer.dataset?.logsAutoRefreshPreference === 'true',
    timezone: viewer.dataset?.logsTimezone || LOCAL_TIMEZONE,
    timer: null,
    controller: null,
    generation: 0,
    suppressFilterChange: false,
    onVisibilityChange: null,
    onPageHide: null,
    onFilterChange: null,
    onFilterSubmit: null,
    onManualRefresh: null,
    onClearFilters: null,
  };

  control.hidden = false;
  synchronizePageState(state, Number(viewer.dataset?.logsPage));
  formatLogTimestamps(viewer, state.timezone);
  setControl(state);
  bindDefaultsDialog(state);
  bindClearDialog(state);
  if (state.enabled) scheduleRefresh(state);

  control.addEventListener?.('click', () => {
    if (!isPageOne(viewer)) return;
    state.enabled = !state.enabled;
    state.autoRefreshPreference = state.enabled;
    setControl(state);
    if (state.enabled) {
      setStatus(state, 'Auto-refresh enabled.');
      scheduleRefresh(state);
    } else {
      clearScheduledRefresh(state);
      abortRefresh(state);
      setStatus(state, 'Auto-refresh disabled.');
    }
  });

  state.onFilterChange = (event) => {
    if (!state.suppressFilterChange && isLogFormStateField(event?.target)) {
      applyCurrentFilters(state);
    }
  };
  state.onFilterSubmit = (event) => {
    event?.preventDefault?.();
    applyCurrentFilters(state);
  };
  state.onManualRefresh = (event) => {
    event?.preventDefault?.();
    requestCurrentPageResults(state, {
      failureMessage: 'Could not refresh logs. Try again.',
    });
  };
  form.addEventListener?.('change', state.onFilterChange);
  form.addEventListener?.('submit', state.onFilterSubmit);
  refreshControl?.addEventListener?.('click', state.onManualRefresh);
  state.onClearFilters = (event) => {
    event?.preventDefault?.();
    clearCurrentFilters(state);
  };
  clearFiltersControl?.addEventListener?.('click', state.onClearFilters);

  state.onVisibilityChange = () => {
    if (isHidden(documentObject)) {
      clearScheduledRefresh(state);
      abortRefresh(state);
    } else if (state.enabled) {
      scheduleRefresh(state);
    }
  };
  state.onPageHide = () => destroy(state);

  documentObject.addEventListener?.('visibilitychange', state.onVisibilityChange);
  windowObject.addEventListener?.('pagehide', state.onPageHide);
  viewerStates.set(viewer, state);
  return 1;
}

export { AUTO_REFRESH_INTERVAL_MS };

