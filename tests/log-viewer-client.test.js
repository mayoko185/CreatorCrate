import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_REFRESH_INTERVAL_MS,
  enhanceLogViewerAutoRefresh,
  formatLogTimestamp,
} from '../src/static/creatorcrate.js';

function node({ attrs = {}, value = '', name = '', type = '', checked = false } = {}) {
  const attributes = new Map(Object.entries(attrs));
  const listeners = new Map();
  return {
    attrs: attributes,
    value,
    name,
    type,
    checked,
    disabled: false,
    hidden: attributes.has('hidden'),
    textContent: '',
    ownerDocument: null,
    parentNode: null,
    setAttribute(key, nextValue) { attributes.set(key, String(nextValue)); },
    removeAttribute(key) { attributes.delete(key); },
    getAttribute(key) { return attributes.get(key) ?? null; },
    addEventListener(typeName, listener) { listeners.set(typeName, listener); },
    removeEventListener(typeName) { listeners.delete(typeName); },
    fire(typeName, properties = {}) {
      return listeners.get(typeName)?.({ target: this, ...properties });
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    contains(candidate) { return candidate === this.activeChild; },
    replaceWith(next) {
      this.parentNode.results = next;
      next.parentNode = this.parentNode;
    },
  };
}

function results(ids = [], timestampMs = []) {
  const region = node();
  const rows = ids.map((id) => {
    const row = node({ attrs: { 'data-log-id': String(id) } });
    row.getAttribute = (key) => key === 'data-log-id' ? String(id) : null;
    return row;
  });
  const timestamps = timestampMs.map((value) => node({
    attrs: { 'data-log-timestamp-ms': String(value) },
  }));
  region.querySelectorAll = (selector) => ({
    '[data-log-id]': rows,
    '[data-log-timestamp-ms]': timestamps,
  })[selector] || [];
  return region;
}

function response(token, ok = true) {
  return {
    ok,
    text: vi.fn(async () => token),
  };
}

function makePage({
  page = 1,
  ids = ['1'],
  timestampMs = [],
  filters = {},
  timezone = 'local',
  autoRefreshEnabled = false,
  autoRefreshPreference = autoRefreshEnabled,
  logsDefaultsDialogState = null,
  logsClearDialogState = null,
  dropdownFilters = false,
} = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const control = node({ attrs: { 'data-logs-auto-refresh': '', hidden: '' } });
  const autoRefreshLabel = node({ attrs: { 'data-logs-auto-refresh-label': '' } });
  const autoRefreshHelp = node({
    attrs: page > 1 ? { 'data-logs-auto-refresh-help': '' } : { 'data-logs-auto-refresh-help': '', hidden: '' },
  });
  const refreshControl = node({ attrs: { 'data-logs-refresh': '' } });
  const clearFiltersControl = node({ attrs: { 'data-logs-clear-filters': '' } });
  control.querySelector = (selector) => selector === '[data-logs-auto-refresh-label]' ? autoRefreshLabel : null;
  const status = node({ attrs: { 'data-logs-live-status': '' } });
  const fields = dropdownFilters
    ? [
      ['level', ['', 'debug', 'info', 'warn', 'error', 'fatal']],
      ['kind', ['', 'activity', 'diagnostic']],
      ['subsystem', ['', 'worker']],
      ['time', ['', 'hour', 'day', '7d', '30d']],
      ['pageSize', ['25', '50', '75', '100']],
    ].flatMap(([name, values]) => values.map((value) => node({
      name,
      type: 'radio',
      value,
      checked: value === (filters[name] || ''),
    })))
    : ['level', 'kind', 'subsystem', 'time', 'pageSize'].map((name) => node({
      name,
      value: filters[name] || '',
    }));
  const form = node({ attrs: { action: '/settings/logs' } });
  form.getAttribute = (key) => key === 'action' ? '/settings/logs' : null;
  form.querySelectorAll = (selector) => selector === '[name]' ? fields : [];
  const viewer = node({
    attrs: {
      'data-logs-viewer': '',
      'data-logs-page': String(page),
      'data-logs-timezone': timezone,
      'data-logs-auto-refresh-enabled': String(autoRefreshEnabled),
      'data-logs-auto-refresh-preference': String(autoRefreshPreference),
    },
  });
  viewer.dataset = {
    logsPage: String(page),
    logsTimezone: timezone,
    logsAutoRefreshEnabled: String(autoRefreshEnabled),
    logsAutoRefreshPreference: String(autoRefreshPreference),
  }; 
  viewer.control = control;
  viewer.refreshControl = refreshControl;
  viewer.status = status;
  viewer.form = form;
  viewer.results = results(ids, timestampMs);
  viewer.results.parentNode = viewer;
  viewer.querySelectorAll = (selector) => selector === '[data-log-timestamp-ms]'
    ? viewer.results.querySelectorAll(selector)
    : [];
  viewer.querySelector = (selector) => ({
    '[data-logs-auto-refresh]': control,
    '[data-logs-auto-refresh-help]': autoRefreshHelp,
    '[data-logs-live-status]': status,
    '.logs-filter-form': form,
    '[data-logs-refresh]': refreshControl,
    '[data-logs-results]': viewer.results,
    '[data-logs-clear-filters]': clearFiltersControl,
  })[selector] || null;

  if (logsDefaultsDialogState?.dialog) {
    logsDefaultsDialogState.dialog.__creatorCrateAppDialogState = logsDefaultsDialogState;
  }
  if (logsClearDialogState?.dialog) {
    logsClearDialogState.dialog.__creatorCrateAppDialogState = logsClearDialogState;
  }

  const document = {
    hidden: false,
    activeElement: null,
    defaultView: null,
    querySelector: (selector) => selector === '[data-logs-viewer]' ? viewer : null,
    getElementById: (id) => ({ 'logs-defaults-dialog': logsDefaultsDialogState?.dialog, 'logs-clear-dialog': logsClearDialogState?.dialog })[id] || null,
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: (type) => documentListeners.delete(type),
    dispatch: (type, event = {}) => documentListeners.get(type)?.(event),
  };
  const parsed = new Map();
  const timers = new Map();
  let nextTimerId = 0;
  const windowObject = {
    location: { href: 'http://creatorcrate.test/settings/logs?page=7' },
    history: { replaceState: vi.fn() },
    fetch: vi.fn(),
    DOMParser: class {
      parseFromString(text) {
        return { querySelector: (selector) => selector === '[data-logs-results]' ? parsed.get(text) : null };
      }
    },
    AbortController,
    setTimeout(callback) {
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    removeEventListener: (type) => windowListeners.delete(type),
    dispatch: (type) => windowListeners.get(type)?.(),
  };
  document.defaultView = windowObject;
  viewer.ownerDocument = document;
  control.ownerDocument = document;
  autoRefreshHelp.ownerDocument = document;
  refreshControl.ownerDocument = document;
  clearFiltersControl.ownerDocument = document;
  status.ownerDocument = document;
  form.ownerDocument = document;
  return {
    document,
    windowObject,
    viewer,
    control,
    autoRefreshHelp,
    refreshControl,
    clearFiltersControl,
    status,
    fields,
    parsed,
    timerCount: () => timers.size,
    runNext: async () => {
      const [id, callback] = timers.entries().next().value || [];
      if (id === undefined) throw new Error('No scheduled refresh.');
      timers.delete(id);
      callback();
      await flush();
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('logs auto-refresh client enhancement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('formats fixed instants in UTC, Eastern daylight time, and an injected browser timezone', () => {
    const timestampMs = Date.UTC(2024, 5, 1, 12, 0, 0);

    expect(formatLogTimestamp(timestampMs, 'UTC')).toBe('2024-06-01 12:00 UTC');
    expect(formatLogTimestamp(timestampMs, 'America/New_York')).toBe('2024-06-01 08:00 EDT');
    expect(formatLogTimestamp(Date.UTC(2024, 0, 1, 12, 0, 0), 'America/New_York'))
      .toBe('2024-01-01 07:00 EST');
    expect(formatLogTimestamp(timestampMs, 'local', { localTimeZone: 'America/New_York' }))
      .toBe('2024-06-01 08:00 EDT');
  });

  it('starts enabled from the rendered default, preserves filters on page-one refresh, and keeps manual navigation native', async () => {
    const page = makePage({
      autoRefreshEnabled: true,
      filters: { level: 'warn', kind: 'diagnostic', subsystem: 'worker' },
    });
    page.parsed.set('next', results(['2', '1']));
    page.windowObject.fetch.mockResolvedValue(response('next'));

    expect(AUTO_REFRESH_INTERVAL_MS).toBe(30_000);
    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);
    expect(page.control.hidden).toBe(false);
    expect(page.control.getAttribute('aria-pressed')).toBe('true');
    expect(page.control.getAttribute('aria-label')).toBe('Disable auto-refresh');
    expect(page.timerCount()).toBe(1);

    await page.runNext();
    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?level=warn&kind=diagnostic&subsystem=worker',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.viewer.results).toBe(page.parsed.get('next'));
    expect(page.status.textContent).toBe('1 new log entry');
  });

  it('updates auto-refresh accessible text without replacing its icon', () => {
    const page = makePage();
    enhanceLogViewerAutoRefresh(page.document);
    const label = page.control.querySelector('[data-logs-auto-refresh-label]');

    expect(page.control.getAttribute('aria-label')).toBe('Enable auto-refresh');
    expect(page.control.getAttribute('data-tooltip')).toBe('Enable auto-refresh');
    expect(label.textContent).toBe('Enable auto-refresh');

    page.control.fire('click');

    expect(page.control.getAttribute('aria-label')).toBe('Disable auto-refresh');
    expect(page.control.getAttribute('data-tooltip')).toBe('Disable auto-refresh');
    expect(label.textContent).toBe('Disable auto-refresh');
  });

  it('does not announce unchanged records', async () => {
    const page = makePage();
    page.parsed.set('unchanged', results(['1']));
    page.windowObject.fetch.mockResolvedValue(response('unchanged'));
    enhanceLogViewerAutoRefresh(page.document);

    page.control.fire('click');
    page.status.textContent = '';
    await page.runNext();

    expect(page.status.textContent).toBe('');
  });

  it('does not enable polling on later pages and leaves the server-rendered filter form alone', () => {
    const page = makePage({ page: 2 });
    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);
    expect(page.control.disabled).toBe(true);
    expect(page.autoRefreshHelp.hidden).toBe(false);
    expect(page.control.getAttribute('aria-describedby')).toBe('logs-auto-refresh-help');
    page.control.fire('click');
    expect(page.windowObject.fetch).not.toHaveBeenCalled();
    expect(page.timerCount()).toBe(0);
  });

  it('pauses while hidden, resumes once visible, and stops pending work when disabled', async () => {
    const page = makePage();
    let resolveFirst;
    page.windowObject.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    page.parsed.set('late', results(['2', '1']));
    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);

    page.control.fire('click');
    await page.runNext();
    const firstSignal = page.windowObject.fetch.mock.calls[0][1].signal;
    page.document.hidden = true;
    page.document.dispatch('visibilitychange');
    expect(firstSignal.aborted).toBe(true);

    page.document.hidden = false;
    page.document.dispatch('visibilitychange');
    expect(page.timerCount()).toBe(1);
    page.control.fire('click');
    resolveFirst(response('late'));
    await flush();
    expect(page.viewer.results.querySelectorAll('[data-log-id]')[0].getAttribute('data-log-id')).toBe('1');
    expect(page.status.textContent).toBe('Auto-refresh disabled.');
    expect(page.timerCount()).toBe(0);
  });

  it('rejects stale responses, announces only new stable IDs, and preserves focus', async () => {
    const page = makePage();
    let resolveFirst;
    let resolveSecond;
    page.windowObject.fetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const fresh = results(['3', '2', '1']);
    const stale = results(['2', '1']);
    page.parsed.set('fresh', fresh);
    page.parsed.set('stale', stale);
    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);

    page.control.fire('click');
    await page.runNext();
    page.document.hidden = true;
    page.document.dispatch('visibilitychange');
    page.document.hidden = false;
    page.document.dispatch('visibilitychange');
    await page.runNext();
    resolveSecond(response('fresh'));
    await flush();
    resolveFirst(response('stale'));
    await flush();

    expect(page.viewer.results).toBe(fresh);
    expect(page.status.textContent).toBe('2 new log entries');

    const focusedRegion = page.viewer.results;
    page.document.activeElement = { name: 'details control' };
    focusedRegion.activeChild = page.document.activeElement;
    page.parsed.set('ignored-for-focus', results(['4', '3', '2', '1']));
    page.windowObject.fetch.mockResolvedValueOnce(response('ignored-for-focus'));
    await page.runNext();
    expect(page.viewer.results).toBe(focusedRegion);
  });

  it('keeps existing results after a failed poll and retries normally on the next interval', async () => {
    const page = makePage();
    const recovered = results(['2', '1']);
    page.parsed.set('recovered', recovered);
    page.windowObject.fetch
      .mockResolvedValueOnce(response('failed', false))
      .mockResolvedValueOnce(response('recovered'));
    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);

    page.control.fire('click');
    await page.runNext();
    expect(page.status.textContent).toBe('Could not refresh logs. Will try again.');
    expect(page.viewer.results.querySelectorAll('[data-log-id]')).toHaveLength(1);

    await page.runNext();
    expect(page.viewer.results).toBe(recovered);
  });

  it('keeps polling after ordinary interaction and stops only on page teardown', async () => {
    const page = makePage();
    let resolveRefresh;
    let resolveAfterTeardown;
    page.windowObject.fetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAfterTeardown = resolve; }));
    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);

    page.control.fire('click');
    await page.runNext();
    const signal = page.windowObject.fetch.mock.calls[0][1].signal;
    page.document.dispatch('click', { target: {} });
    page.document.dispatch('submit', { target: page.form });
    expect(signal.aborted).toBe(false);
    resolveRefresh(response('unchanged'));
    await flush();
    expect(page.timerCount()).toBe(1);

    await page.runNext();
    const teardownSignal = page.windowObject.fetch.mock.calls[1][1].signal;
    page.windowObject.dispatch('pagehide');
    expect(teardownSignal.aborted).toBe(true);
    resolveAfterTeardown(response('unchanged'));
    await flush();
    expect(page.timerCount()).toBe(0);
  });

  it('cleans up polling on page teardown', () => {
    const page = makePage();
    enhanceLogViewerAutoRefresh(page.document);
    page.control.fire('click');
    expect(page.timerCount()).toBe(1);
    page.windowObject.dispatch('pagehide');
    expect(page.timerCount()).toBe(0);
  });

  it('applies changed filters in place, resets page one, and preserves the selected time in the URL', async () => {
    const page = makePage({
      page: 2,
      autoRefreshPreference: true,
      filters: { level: 'warn', time: 'day' },
    });
    const next = results(['2']);
    page.parsed.set('filtered', next);
    page.windowObject.fetch.mockResolvedValue(response('filtered'));

    enhanceLogViewerAutoRefresh(page.document);
    page.viewer.form.fire('change', { target: page.fields.find((field) => field.name === 'time') });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?level=warn&time=day',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.windowObject.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      'http://creatorcrate.test/settings/logs?level=warn&time=day',
    );
    expect(page.viewer.results).toBe(next);
    expect(page.viewer.dataset.logsPage).toBe('1');
    expect(page.autoRefreshHelp.hidden).toBe(true);
    expect(page.control.getAttribute('aria-describedby')).toBeNull();
    expect(page.timerCount()).toBe(1);
    expect(page.status.textContent).toBe('');
  });

  it('omits time from the URL when Any time is selected', async () => {
    const page = makePage({ filters: { level: 'warn', time: 'day' } });
    page.parsed.set('unfiltered', results(['2']));
    page.windowObject.fetch.mockResolvedValue(response('unfiltered'));
    const time = page.fields.find((field) => field.name === 'time');
    time.value = '';

    enhanceLogViewerAutoRefresh(page.document);
    page.viewer.form.fire('change', { target: time });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?level=warn',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.windowObject.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      'http://creatorcrate.test/settings/logs?level=warn',
    );
  });

  it('restores polling when a page-size change returns a later page to page one under an enabled preference', async () => {
    const page = makePage({
      page: 2,
      autoRefreshEnabled: false,
      autoRefreshPreference: true,
      filters: { pageSize: '25' },
    });
    page.parsed.set('page-one', results(['1']));
    page.windowObject.fetch.mockResolvedValue(response('page-one'));

    enhanceLogViewerAutoRefresh(page.document);
    page.viewer.form.fire('change', { target: page.fields.find((field) => field.name === 'pageSize') });
    await flush();

    expect(page.viewer.dataset.logsPage).toBe('1');
    expect(page.autoRefreshHelp.hidden).toBe(true);
    expect(page.control.getAttribute('aria-describedby')).toBeNull();
    expect(page.control.getAttribute('aria-label')).toBe('Disable auto-refresh');
    expect(page.timerCount()).toBe(1);
  });

  it('clears only filter fields while retaining the active page-size control and resetting page state', async () => {
    const page = makePage({
      page: 2,
      autoRefreshPreference: true,
      dropdownFilters: true,
      filters: {
        level: 'error',
        kind: 'diagnostic',
        subsystem: 'worker',
        time: 'day',
        pageSize: '25',
      },
    });
    page.parsed.set('cleared-filters', results(['1']));
    page.windowObject.fetch.mockResolvedValue(response('cleared-filters'));

    enhanceLogViewerAutoRefresh(page.document);
    page.clearFiltersControl.fire('click', { preventDefault: vi.fn() });
    await flush();

    expect(page.fields.filter((field) => field.checked).map((field) => [field.name, field.value])).toEqual([
      ['level', ''],
      ['kind', ''],
      ['subsystem', ''],
      ['time', ''],
      ['pageSize', '25'],
    ]);
    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?pageSize=25',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.windowObject.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      'http://creatorcrate.test/settings/logs?pageSize=25',
    );
    expect(page.viewer.dataset.logsPage).toBe('1');
    expect(page.autoRefreshHelp.hidden).toBe(true);
    expect(page.control.getAttribute('aria-describedby')).toBeNull();
    expect(page.timerCount()).toBe(1);
  });

  it('manually refreshes the current later page without rewriting its state or enabling polling', async () => {
    const page = makePage({
      page: 2,
      autoRefreshPreference: true,
      filters: { level: 'error', time: 'day', pageSize: '25' },
    });
    page.parsed.set('refreshed-page-two', results(['3']));
    page.windowObject.fetch.mockResolvedValue(response('refreshed-page-two'));

    enhanceLogViewerAutoRefresh(page.document);
    page.refreshControl.fire('click', { preventDefault: vi.fn() });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?level=error&time=day&pageSize=25&page=2',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.windowObject.history.replaceState).not.toHaveBeenCalled();
    expect(page.viewer.dataset.logsPage).toBe('2');
    expect(page.autoRefreshHelp.hidden).toBe(false);
    expect(page.control.getAttribute('aria-describedby')).toBe('logs-auto-refresh-help');
    expect(page.timerCount()).toBe(0);
    expect(page.status.textContent).toBe('');
  });

  it('manually refreshes page one without announcing entries or duplicating its polling timer', async () => {
    const page = makePage({
      autoRefreshEnabled: true,
      autoRefreshPreference: true,
      filters: { level: 'warn', pageSize: '25' },
    });
    page.parsed.set('refreshed-page-one', results(['2', '1']));
    page.windowObject.fetch.mockResolvedValue(response('refreshed-page-one'));

    enhanceLogViewerAutoRefresh(page.document);
    expect(page.timerCount()).toBe(1);
    page.refreshControl.fire('click', { preventDefault: vi.fn() });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?level=warn&pageSize=25',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.windowObject.history.replaceState).not.toHaveBeenCalled();
    expect(page.viewer.dataset.logsPage).toBe('1');
    expect(page.autoRefreshHelp.hidden).toBe(true);
    expect(page.control.getAttribute('aria-describedby')).toBeNull();
    expect(page.timerCount()).toBe(1);
    expect(page.status.textContent).toBe('');
  });

  it('applies saved Defaults immediately through the owned filter request without a new-entry announcement', async () => {
    const dialog = { close: vi.fn() };
    const logsDefaultsDialogState = { dialog };
    const timestampMs = Date.UTC(2024, 5, 1, 12, 0, 0);
    const page = makePage({
      page: 2,
      timestampMs: [timestampMs],
      logsDefaultsDialogState,
      dropdownFilters: true,
    });
    const next = results(['2'], [timestampMs]);
    page.parsed.set('defaults', next);
    page.windowObject.fetch.mockResolvedValue(response('defaults'));

    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);
    expect(logsDefaultsDialogState.onSuccessfulSubmit({
      values: {
        level: 'error',
        kind: 'diagnostic',
        subsystem: '',
        time: 'day',
        pageSize: '25',
        timezone: 'America/New_York',
        autoRefresh: 'enabled',
      },
    })).toBe(true);
    expect(page.viewer.results.querySelectorAll('[data-log-timestamp-ms]')[0].textContent)
      .toBe('2024-06-01 08:00 EDT');
    await flush();

    expect(dialog.close).toHaveBeenCalledOnce();
    expect(page.fields.filter((field) => field.checked).map((field) => [field.name, field.value])).toEqual([
      ['level', 'error'],
      ['kind', 'diagnostic'],
      ['subsystem', ''],
      ['time', 'day'],
      ['pageSize', '25'],
    ]);
    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?level=error&kind=diagnostic&time=day&pageSize=25',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.viewer.results).toBe(next);
    expect(next.querySelectorAll('[data-log-timestamp-ms]')[0].textContent).toBe('2024-06-01 08:00 EDT');
    expect(page.viewer.dataset.logsPage).toBe('1');
    expect(page.control.getAttribute('aria-label')).toBe('Disable auto-refresh');
    expect(page.timerCount()).toBe(1);
    expect(page.status.textContent).toBe('');
  });

  it('applies unchanged saved Defaults over explicit later-page query state through one page-one request', async () => {
    const dialog = { close: vi.fn() };
    const savedValues = {
      level: 'error',
      kind: '',
      subsystem: '',
      time: '',
      pageSize: '50',
      timezone: 'local',
      autoRefresh: 'enabled',
    };
    const logsDefaultsDialogState = { dialog, savedValues };
    const page = makePage({
      page: 2,
      autoRefreshPreference: true,
      filters: { level: 'warn', pageSize: '25' },
      logsDefaultsDialogState,
    });
    const next = results(['2']);
    page.parsed.set('defaults', next);
    page.windowObject.fetch.mockResolvedValue(response('defaults'));

    enhanceLogViewerAutoRefresh(page.document);
    expect(logsDefaultsDialogState.onSuccessfulSubmit({ values: savedValues })).toBe(true);
    await flush();

    expect(dialog.close).toHaveBeenCalledOnce();
    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/settings/logs?level=error&pageSize=50',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(page.windowObject.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      'http://creatorcrate.test/settings/logs?level=error&pageSize=50',
    );
    expect(page.fields.find((field) => field.name === 'level').value).toBe('error');
    expect(page.fields.find((field) => field.name === 'pageSize').value).toBe('50');
    expect(page.viewer.results).toBe(next);
    expect(page.viewer.dataset.logsPage).toBe('1');
    expect(page.autoRefreshHelp.hidden).toBe(true);
    expect(page.control.getAttribute('aria-describedby')).toBeNull();
    expect(page.timerCount()).toBe(1);
    expect(page.status.textContent).toBe('');
  });

  it('does not fetch or rewrite state when changed Defaults already match the current page', () => {
    const dialog = { close: vi.fn() };
    const logsDefaultsDialogState = {
      dialog,
      savedValues: {
        level: 'error', kind: '', subsystem: '', time: '', pageSize: '25', timezone: 'local', autoRefresh: 'disabled',
      },
    };
    const page = makePage({ filters: { level: 'warn', pageSize: '25' }, logsDefaultsDialogState });

    enhanceLogViewerAutoRefresh(page.document);
    expect(logsDefaultsDialogState.onSuccessfulSubmit({
      values: { ...logsDefaultsDialogState.savedValues, level: 'warn' },
    })).toBe(true);

    expect(dialog.close).toHaveBeenCalledOnce();
    expect(page.windowObject.fetch).not.toHaveBeenCalled();
    expect(page.windowObject.history.replaceState).not.toHaveBeenCalled();
    expect(page.viewer.dataset.logsPage).toBe('1');
  });

  it('applies an auto-refresh-only Defaults save without fetching or duplicating its timer', () => {
    const dialog = { close: vi.fn() };
    const savedValues = {
      level: 'warn', kind: '', subsystem: '', time: '', pageSize: '25', timezone: 'local', autoRefresh: 'disabled',
    };
    const logsDefaultsDialogState = { dialog, savedValues };
    const page = makePage({ filters: { level: 'warn', pageSize: '25' }, logsDefaultsDialogState });

    enhanceLogViewerAutoRefresh(page.document);
    expect(logsDefaultsDialogState.onSuccessfulSubmit({
      values: { ...savedValues, autoRefresh: 'enabled' },
    })).toBe(true);

    expect(page.windowObject.fetch).not.toHaveBeenCalled();
    expect(page.windowObject.history.replaceState).not.toHaveBeenCalled();
    expect(page.control.getAttribute('aria-label')).toBe('Disable auto-refresh');
    expect(page.timerCount()).toBe(1);
  });

  it('leaves every page concern untouched when a Defaults save is a current-state no-op', () => {
    const dialog = { close: vi.fn() };
    const savedValues = {
      level: 'warn', kind: '', subsystem: '', time: '', pageSize: '25', timezone: 'local', autoRefresh: 'enabled',
    };
    const logsDefaultsDialogState = { dialog, savedValues };
    const page = makePage({
      autoRefreshEnabled: true,
      autoRefreshPreference: true,
      filters: { level: 'warn', pageSize: '25' },
      logsDefaultsDialogState,
    });

    enhanceLogViewerAutoRefresh(page.document);
    expect(logsDefaultsDialogState.onSuccessfulSubmit({ values: savedValues })).toBe(true);

    expect(page.windowObject.fetch).not.toHaveBeenCalled();
    expect(page.windowObject.history.replaceState).not.toHaveBeenCalled();
    expect(page.timerCount()).toBe(1);
  });

  it('reformats timestamps for a timezone-only Defaults save without requesting new results', () => {
    const dialog = { close: vi.fn() };
    const logsDefaultsDialogState = {
      dialog,
      savedValues: {
        level: '',
        kind: '',
        subsystem: '',
        time: '',
        pageSize: '50',
        timezone: 'local',
        autoRefresh: 'disabled',
      },
    };
    const timestampMs = Date.UTC(2024, 5, 1, 12, 0, 0);
    const page = makePage({
      timestampMs: [timestampMs],
      filters: { pageSize: '50' },
      logsDefaultsDialogState,
    });

    expect(enhanceLogViewerAutoRefresh(page.document)).toBe(1);
    expect(logsDefaultsDialogState.onSuccessfulSubmit({
      values: { ...logsDefaultsDialogState.savedValues, timezone: 'America/New_York' },
    })).toBe(true);

    expect(dialog.close).toHaveBeenCalledOnce();
    expect(page.viewer.results.querySelectorAll('[data-log-timestamp-ms]')[0].textContent)
      .toBe('2024-06-01 08:00 EDT');
    expect(page.windowObject.fetch).not.toHaveBeenCalled();
  });
  it('canonicalizes a successful Clear Logs result to page one through the owned request', async () => {
    const dialog = { close: vi.fn(), dataset: {} };
    const logsClearDialogState = { dialog };
    const page = makePage({
      page: 2,
      autoRefreshPreference: true,
      filters: { level: 'error', time: 'day', pageSize: '25' },
      logsClearDialogState,
    });
    page.parsed.set('cleared', results(['logging.cleared']));
    page.windowObject.fetch.mockResolvedValueOnce(response('cleared'));

    enhanceLogViewerAutoRefresh(page.document);

    await expect(logsClearDialogState.onSuccessfulSubmit()).resolves.toBe(true);

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = page.windowObject.fetch.mock.calls[0];
    expect(url).toBe('http://creatorcrate.test/settings/logs?level=error&time=day&pageSize=25');
    expect(options).toEqual(expect.objectContaining({
      method: 'GET',
      headers: { Accept: 'text/html' },
    }));
    expect(page.windowObject.history.replaceState).toHaveBeenCalledWith(null, '', url);
    expect(page.viewer.results).toBe(page.parsed.get('cleared'));
    expect(page.viewer.dataset.logsPage).toBe('1');
    expect(page.autoRefreshHelp.hidden).toBe(true);
    expect(page.control.getAttribute('aria-describedby')).toBeNull();
    expect(page.timerCount()).toBe(1);
  });

  it('keeps later-page state unchanged when Clear Logs does not report success', () => {
    const dialog = { close: vi.fn(), dataset: {} };
    const logsClearDialogState = { dialog };
    const page = makePage({
      page: 2,
      autoRefreshPreference: true,
      filters: { level: 'error', time: 'day', pageSize: '25' },
      logsClearDialogState,
    });

    enhanceLogViewerAutoRefresh(page.document);

    expect(page.windowObject.fetch).not.toHaveBeenCalled();
    expect(page.windowObject.history.replaceState).not.toHaveBeenCalled();
    expect(page.viewer.dataset.logsPage).toBe('2');
    expect(page.autoRefreshHelp.hidden).toBe(false);
    expect(page.control.getAttribute('aria-describedby')).toBe('logs-auto-refresh-help');
    expect(page.timerCount()).toBe(0);
  });

  it('lets a manual refresh supersede an in-flight poll', async () => {
    const page = makePage({ autoRefreshEnabled: true, autoRefreshPreference: true });
    let resolvePoll;
    page.windowObject.fetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }))
      .mockResolvedValueOnce(response('manual'));
    const manual = results(['3', '2', '1']);
    page.parsed.set('manual', manual);
    page.parsed.set('poll', results(['2', '1']));

    enhanceLogViewerAutoRefresh(page.document);
    await page.runNext();
    const pollSignal = page.windowObject.fetch.mock.calls[0][1].signal;
    page.refreshControl.fire('click', { preventDefault: vi.fn() });
    await flush();

    expect(pollSignal.aborted).toBe(true);
    expect(page.viewer.results).toBe(manual);
    resolvePoll(response('poll'));
    await flush();
    expect(page.viewer.results).toBe(manual);
    expect(page.timerCount()).toBe(1);
  });

  it('aborts a stale filter request and keeps the latest filter result', async () => {
    const page = makePage({ filters: { level: 'warn' } });
    let resolveFirst;
    page.windowObject.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    page.windowObject.fetch.mockResolvedValueOnce(response('latest'));
    page.parsed.set('latest', results(['3']));

    enhanceLogViewerAutoRefresh(page.document);
    page.viewer.form.fire('change', { target: page.fields.find((field) => field.name === 'level') });
    await flush();
    const firstSignal = page.windowObject.fetch.mock.calls[0][1].signal;

    const time = page.fields.find((field) => field.name === 'time');
    time.value = 'day';
    page.viewer.form.fire('change', { target: time });
    await flush();
    expect(firstSignal.aborted).toBe(true);

    resolveFirst(response('stale'));
    await flush();
    expect(page.viewer.results).toBe(page.parsed.get('latest'));
    expect(page.status.textContent).toBe('');
  });
});
