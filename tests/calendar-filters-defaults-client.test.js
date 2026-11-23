import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CALENDAR_DEFAULTS_MESSAGES as MESSAGES,
  CALENDAR_SAVED_STATE_MESSAGES as SAVED_STATE,
  calendarResetDefaultsDestination,
  calendarResetFiltersDestination,
  createCalendarFiltersDefaults,
  describeCalendarSavedState,
  enhanceCalendarFiltersDefaults,
  parseCalendarDefaultsAuthority,
  sameCalendarDefaultsValues,
} from '../src/static/client/calendar-filters-defaults.js';
import { parseReleasesDefaultsAuthority } from '../src/static/client/releases-filters-defaults.js';

/*
 * WP14a: the Calendar config of the shared explicit defaults core
 * (explicit-page-defaults.js). The core's lifecycle rules are covered in depth
 * by asset-library-filters-defaults-client.test.js; these tests pin the
 * Calendar contract: exactly three saveable settings (View, Release status,
 * Week start) from the installed page's effective presentation, the
 * displayed month and repeated Projects / Project Types never saved and
 * always preserved, the Calendar endpoints and generation, the month-keeping
 * Reset filters, and the inactive-until-WP14b opt-in boundary.
 */

const FIELDS = ['view', 'status', 'weekStart'];
const FALLBACKS = Object.freeze({ view: 'grid', status: 'all', weekStart: 'monday' });
const BASE = 'http://creatorcrate.test';
const TEMPORARY = '/calendar?month=2025-06&project=7&project=12&type=animation&type=comic';

function authority({
  current = {}, defaults = {}, savedKeys = [], generation = 0, currentUrl, resetFiltersUrl = '/calendar?month=2025-06',
} = {}) {
  const saved = Object.fromEntries(FIELDS.map((field) => [
    field, { stored: savedKeys.includes(field), valid: savedKeys.includes(field) },
  ]));
  return {
    page: 'calendar',
    fields: [...FIELDS],
    multiFields: [],
    fallbacks: { ...FALLBACKS },
    defaults: { ...FALLBACKS, ...defaults },
    saved,
    savedKeys: FIELDS.filter((field) => savedKeys.includes(field)),
    hasSavedDefaults: savedKeys.length > 0,
    generation,
    revision: 'r1',
    resetFiltersUrl,
    month: '2025-06',
    current: { ...FALLBACKS, ...current },
    currentUrl: currentUrl ?? `${TEMPORARY}&view=list`,
  };
}

function makeLive({ intendedUrl = `${BASE}${TEMPORARY}&view=list` } = {}) {
  const listeners = new Set();
  const live = {
    s: { generation: 1, pending: false, failed: false, failedUrl: null, intendedUrl, requestedHistoryMode: null },
    snapshot: () => ({ ...live.s }),
    subscribe: (document, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get listenerCount() {
      return listeners.size;
    },
    emit(detail) {
      listeners.forEach((listener) => listener(detail));
    },
    start(url, historyMode = 'push') {
      live.emit({ phase: 'superseded', generation: live.s.generation, loading: live.s.pending });
      live.s.generation += 1;
      live.s.pending = true;
      live.s.failed = false;
      live.s.requestedHistoryMode = historyMode;
      live.s.intendedUrl = new URL(url, BASE).href;
      live.emit({ phase: 'started', generation: live.s.generation, url: live.s.intendedUrl });
      return live.s.generation;
    },
    install(generation = live.s.generation) {
      live.s.pending = false;
      live.emit({ phase: 'installed', generation, url: live.s.intendedUrl });
    },
    fail(generation = live.s.generation) {
      live.s.pending = false;
      live.s.failed = true;
      live.s.failedUrl = live.s.intendedUrl;
      live.emit({ phase: 'failed', generation, url: live.s.intendedUrl });
    },
  };
  live.navigate = vi.fn((document, url, { historyMode } = {}) => {
    const generation = live.start(url, historyMode);
    return { status: 'started', generation };
  });
  return live;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// The application's correlated answer to the request it is matched with.
function appAnswer(url, options, status, body, result) {
  const expected = Number(options.body.get('defaultsGeneration'));
  return jsonResponse(status, {
    ...body,
    operation: {
      id: options.body.get('defaultsOperation'),
      kind: String(url).endsWith('/reset') ? 'resetDefaults' : 'save',
      result,
      committed: result === 'committed',
      expectedGeneration: expected,
      generation: result === 'committed' || result === 'conflict' ? expected + 1 : null,
    },
  });
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function setup({ installed = authority(), live = makeLive(), answer, fetchImpl } = {}) {
  const page = { authority: installed };
  const statuses = [];
  let operations = 0;
  const fetch = vi.fn(fetchImpl ?? ((url, options) => Promise.resolve(answer?.(url, options))));
  const controller = createCalendarFiltersDefaults({ defaultView: { location: { href: `${BASE}${TEMPORARY}` } } }, {
    live,
    fetch,
    createOperationId: () => `op-${operations += 1}`,
    readAuthority: () => page.authority,
    csrfToken: () => 'token-1',
    onStatus: (message, kind) => statuses.push({ message, kind }),
  });
  return { controller, live, fetch, page, statuses };
}

const posts = (fetch) => fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
const gets = (fetch) => fetch.mock.calls.filter(([, options]) => options?.method === 'GET');
const committedSave = (values, generation) => (url, options) => appAnswer(url, options, 200, {
  status: 'success',
  values,
  authority: authority({ defaults: values, savedKeys: FIELDS, generation }),
}, 'committed');

describe('WP14a Calendar explicit defaults config', () => {
  it('accepts only complete Calendar authority (never another page\'s)', () => {
    const valid = authority();
    expect(parseCalendarDefaultsAuthority(valid, { requireCurrent: true })).toEqual(valid);
    expect(parseCalendarDefaultsAuthority({ ...valid, page: 'releases' })).toBeNull();
    expect(parseReleasesDefaultsAuthority(valid)).toBeNull();
    expect(parseCalendarDefaultsAuthority({ ...valid, current: { view: 'grid', status: '', weekStart: 'monday' } },
      { requireCurrent: true })).toBeNull();
    const { generation, ...withoutGeneration } = valid;
    expect(generation).toBe(0);
    expect(parseCalendarDefaultsAuthority(withoutGeneration)).toBeNull();
    expect(parseCalendarDefaultsAuthority({ ...valid, savedKeys: ['view'] })).toBeNull();
  });

  it.each(['defaults', 'fallbacks', 'current'])('validates every Calendar value in %s', (section) => {
    const supported = authority({ current: { view: 'list', status: 'planned', weekStart: 'sunday' } });
    expect(parseCalendarDefaultsAuthority(supported)).toEqual(supported);
    for (const [field, unsupported] of Object.entries({ view: 'timeline', status: 'archived', weekStart: 'saturday' })) {
      for (const invalid of [unsupported, undefined, null, '', 1, [FALLBACKS[field]]]) {
        expect(parseCalendarDefaultsAuthority({
          ...supported,
          [section]: { ...supported[section], [field]: invalid },
        })).toBeNull();
      }
    }
  });

  it('accepts metadata GET authority with no current values and no stored defaults', () => {
    const { current, currentUrl, ...metadata } = authority();
    expect(metadata.savedKeys).toEqual([]);
    expect(parseCalendarDefaultsAuthority(metadata)).toEqual(metadata);
    expect(parseCalendarDefaultsAuthority(metadata, { requireCurrent: true })).toBeNull();
  });

  it('ordinary month, filter and presentation changes never POST defaults', async () => {
    const { controller, live, fetch } = setup();
    live.start('/calendar?month=2025-07&project=7&project=12', 'push');
    live.install();
    live.start('/calendar?month=2025-07&status=planned&weekStart=sunday&view=list&type=comic', 'push');
    live.fail();
    live.start('/calendar?month=2025-05', 'push');
    live.install();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(live.navigate).not.toHaveBeenCalled();
    expect(controller.operation).toBeNull();
  });

  it('Save posts exactly the three-value snapshot once, never the month, Projects or Types', async () => {
    const installed = authority({ current: { view: 'list', status: 'planned', weekStart: 'sunday' }, generation: 3 });
    const expected = { view: 'list', status: 'planned', weekStart: 'sunday' };
    const { controller, fetch, live, statuses } = setup({ installed, answer: committedSave(expected, 4) });
    expect(controller.currentValues()).toEqual(expected);
    const pending = controller.save();
    expect(controller.operation).toMatchObject({ kind: 'save', phase: 'posting', unresolved: true });
    // A duplicate Save while the first is in flight sends nothing.
    expect((await controller.save()).reason).toBe(MESSAGES.saveInProgress);
    const result = await pending;

    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/calendar/defaults');
    expect(options.headers.Accept).toBe('application/json');
    const body = options.body;
    expect(body.get('view')).toBe('list');
    expect(body.get('status')).toBe('planned');
    expect(body.get('weekStart')).toBe('sunday');
    expect(body.get('defaultsGeneration')).toBe('3');
    expect(body.get('defaultsOperation')).toBe('op-1');
    expect(body.get('_csrf')).toBe('token-1');
    for (const key of ['month', 'project', 'type', 'page', 'notice']) expect(body.has(key)).toBe(false);
    expect([...new Set([...body.keys()])].sort()).toEqual(
      ['_csrf', 'defaultsGeneration', 'defaultsOperation', 'returnTo', ...FIELDS].sort(),
    );
    // The installed location travels as context only (month, repeated values).
    expect(body.get('returnTo')).toBe(`${TEMPORARY}&view=list`);
    expect(result).toMatchObject({ outcome: 'refreshing', snapshot: expected });
    // The GET-only refresh keeps the displayed month and repeated filters.
    expect(live.navigate).toHaveBeenCalledTimes(1);
    const refreshed = new URL(live.navigate.mock.calls[0][1]);
    expect(refreshed.searchParams.get('month')).toBe('2025-06');
    expect(refreshed.searchParams.getAll('project')).toEqual(['7', '12']);
    expect(refreshed.searchParams.getAll('type')).toEqual(['animation', 'comic']);
    expect(live.navigate.mock.calls[0][2]).toEqual({ historyMode: 'replace' });
    live.install();
    expect(controller.status).toEqual({ message: MESSAGES.saved, kind: 'saved' });
    expect(statuses.filter((entry) => entry.message === MESSAGES.saved)).toHaveLength(1);
    expect(controller.savedMetadata()).toMatchObject({ generation: 4, savedKeys: FIELDS, defaults: expected });
  });

  it('keeps a newer edit and month made during Save: the acknowledgement updates only the saved baseline', async () => {
    let answerSave;
    const snapshot = { view: 'list', status: 'planned', weekStart: 'sunday' };
    const { controller, live, fetch, page } = setup({
      installed: authority({ current: snapshot, generation: 2 }),
      fetchImpl: (url, options) => new Promise((resolve) => {
        answerSave = () => resolve(committedSave(snapshot, 3)(url, options));
      }),
    });
    const pending = controller.save();
    await flush();
    // The user changes status and month while the POST is pending.
    live.start('/calendar?month=2025-08&status=published&project=7&project=12', 'push');
    answerSave();
    const result = await pending;
    expect(result.outcome).toBe('refreshing');
    // The refresh follows the newer intent, never the Save's older month.
    expect(live.navigate.mock.calls.at(-1)[1]).toBe(`${BASE}/calendar?month=2025-08&status=published&project=7&project=12`);
    expect(live.navigate.mock.calls.at(-1)[2]).toEqual({ historyMode: 'push' });
    page.authority = authority({ current: { ...snapshot, status: 'published' }, defaults: snapshot, savedKeys: FIELDS, generation: 3 });
    live.install();
    expect(controller.status.message).toBe(MESSAGES.saved);
    // Saved baseline = the acknowledged snapshot; current = the newer edit.
    expect(controller.savedMetadata().defaults).toEqual(snapshot);
    expect(controller.currentValues()).toEqual({ ...snapshot, status: 'published' });
    expect(posts(fetch)).toHaveLength(1);
  });

  it('never trusts an acknowledgement of other values or another operation (stale acknowledgement)', async () => {
    const snapshot = { view: 'list', status: 'planned', weekStart: 'sunday' };
    const { controller, fetch, live } = setup({
      installed: authority({ current: snapshot, generation: 6 }),
      fetchImpl: (url, options) => {
        if (options.method === 'GET') {
          return Promise.resolve(jsonResponse(200, { status: 'success', authority: authority({ generation: 6 }) }));
        }
        // An older request's answer: echoes another identity and other values.
        return Promise.resolve(jsonResponse(200, {
          status: 'success',
          values: { view: 'grid', status: 'all', weekStart: 'monday' },
          operation: { id: 'op-older', kind: 'save', result: 'committed', committed: true, expectedGeneration: 6, generation: 7 },
        }));
      },
    });
    const result = await controller.save();
    expect(result.outcome).toBe('uncertain');
    expect(controller.operation).toMatchObject({ phase: 'uncertain', unresolved: true, confirmed: false });
    expect(gets(fetch).map(([url]) => url)).toEqual(['/calendar/defaults']);
    expect(live.navigate).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('refuses Save while Calendar is loading, failed, or a Reset filters is unfinished; Retry is GET-only', async () => {
    const { controller, live, fetch } = setup();
    live.start('/calendar?month=2025-07', 'push');
    expect((await controller.save()).reason).toBe(MESSAGES.loading);
    live.fail();
    expect((await controller.save()).reason).toBe(MESSAGES.loadFailed);
    // The engine's GET Retry of the failed month (a new generation).
    live.start('/calendar?month=2025-07', 'none');
    live.install();
    expect(controller.saveBlockedReason()).toBeNull();
    expect(controller.resetFilters().outcome).toBe('started');
    // Reset filters is a GET to the installed authority's month-only destination.
    expect(live.navigate.mock.calls.at(-1)[1]).toBe('/calendar?month=2025-06');
    expect(live.navigate.mock.calls.at(-1)[2]).toEqual({ historyMode: 'push' });
    expect((await controller.save()).reason).toBe(MESSAGES.resetPending);
    live.fail();
    expect((await controller.save()).reason).toBe(MESSAGES.resetIncomplete);
    // The engine's Retry of the failed Reset filters repeats its address.
    const retried = live.start('/calendar?month=2025-06', 'push');
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', generation: retried });
    live.install(retried);
    expect(controller.filtersReset).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets a newer edit or Back/Forward supersede a pending Reset filters', async () => {
    const { controller, live, fetch } = setup();
    controller.resetFilters();
    // A history traversal starts a newer GET through the same engine.
    live.start('/calendar?month=2025-05&project=7', 'none');
    expect(controller.filtersReset).toBeNull();
    live.install();
    expect(controller.saveBlockedReason()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never repeats a confirmed Save when its refresh fails; Retry is GET-only', async () => {
    const values = { view: 'list', status: 'all', weekStart: 'monday' };
    const { controller, fetch, live } = setup({
      installed: authority({ current: values, generation: 0 }),
      answer: committedSave(values, 1),
    });
    await controller.save();
    live.fail();
    expect(controller.operation).toMatchObject({ kind: 'save', phase: 'refresh-failed', confirmed: true, unresolved: false });
    expect(controller.status.message).toBe(MESSAGES.savedRefreshFailed);
    expect((await controller.save()).reason).toBe(MESSAGES.loadFailed);
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(controller.retryRefresh()).toBe('refreshing');
    expect(new URL(live.navigate.mock.calls.at(-1)[1]).searchParams.get('month')).toBe('2025-06');
    expect(posts(fetch)).toHaveLength(1);
    live.install();
    expect(controller.status.message).toBe(MESSAGES.saved);
  });

  it('confirms a Save whose answer carried no authority and re-reads it with GET only', async () => {
    const values = { view: 'grid', status: 'all', weekStart: 'monday' };
    const { controller, fetch, live } = setup({
      installed: authority({ current: values, generation: 4 }),
      fetchImpl: (url, options) => {
        if (options.method === 'GET') {
          return Promise.resolve(jsonResponse(200, {
            status: 'success', authority: authority({ defaults: values, savedKeys: FIELDS, generation: 5 }),
          }));
        }
        return Promise.resolve(appAnswer(url, options, 200, {
          status: 'success', values, authorityUnavailable: true,
        }, 'committed'));
      },
    });
    const result = await controller.save();
    expect(result.outcome).toBe('refreshing');
    expect(controller.operation).toMatchObject({ confirmed: true });
    await flush();
    expect(gets(fetch).map(([url]) => url)).toEqual(['/calendar/defaults']);
    expect(controller.savedMetadata()).toMatchObject({ generation: 5, savedKeys: FIELDS });
    live.install();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('reconciles an uncertain Save with GET only and keeps later mutations blocked', async () => {
    const { controller, fetch } = setup({
      installed: authority({ current: { view: 'list' }, generation: 4 }),
      fetchImpl: (url, options) => {
        if (options.method === 'POST') return Promise.resolve(jsonResponse(504, { status: 'error' }));
        return Promise.resolve(jsonResponse(200, { status: 'success', authority: authority({ generation: 4 }) }));
      },
    });
    const result = await controller.save();
    expect(result.outcome).toBe('uncertain');
    expect(gets(fetch).map(([url]) => url)).toEqual(['/calendar/defaults']);
    expect(controller.operation).toMatchObject({ phase: 'uncertain', unresolved: true });
    expect((await controller.save()).reason).toBe(MESSAGES.saveUnresolved);
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(await controller.retryReconcile()).toBe('uncertain');
    expect(posts(fetch)).toHaveLength(1);
  });

  it('releases an uncertain Save once the generation moved past it, without claiming it', async () => {
    let generation = 4;
    const { controller, fetch } = setup({
      installed: authority({ current: { view: 'list' }, generation: 4 }),
      fetchImpl: (url, options) => {
        if (options.method === 'POST') return Promise.reject(new TypeError('network'));
        return Promise.resolve(jsonResponse(200, { status: 'success', authority: authority({ generation }) }));
      },
    });
    expect((await controller.save()).outcome).toBe('uncertain');
    // A legacy Settings write (or this request) advanced the generation.
    generation = 5;
    expect(await controller.retryReconcile()).toBe('uncertain');
    expect(controller.operation).toMatchObject({ unresolved: false, confirmed: false });
    expect(controller.status.message).toBe(MESSAGES.saveOutcomeUnknown);
    expect(controller.generation).toBe(5);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('reports a correlated generation conflict without resending and keeps the current choices', async () => {
    const values = { view: 'list', status: 'planned', weekStart: 'sunday' };
    const { controller, fetch, live } = setup({
      installed: authority({ current: values, generation: 1 }),
      answer: (url, options) => appAnswer(url, options, 409, {
        status: 'error', code: 'DEFAULTS_GENERATION_CONFLICT', authority: authority({ generation: 2 }),
      }, 'conflict'),
    });
    expect((await controller.save()).outcome).toBe('conflict');
    expect(controller.status).toEqual({ message: MESSAGES.saveConflict, kind: 'error' });
    expect(controller.generation).toBe(2);
    expect(controller.currentValues()).toEqual(values);
    expect(live.navigate).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('Reset defaults posts once, keeps the month and repeated filters, and supersedes an older GET', async () => {
    let answerReset;
    const { controller, fetch, live } = setup({
      installed: authority({ savedKeys: ['view', 'weekStart'], generation: 5 }),
      fetchImpl: (url, options) => new Promise((resolve) => {
        answerReset = () => resolve(appAnswer(url, options, 200, {
          status: 'success',
          refreshUrl: '/calendar?month=2025-07&project=7&project=12&type=comic',
          authority: authority({ generation: 6 }),
        }, 'committed'));
      }),
    });
    // An earlier month GET is still pending when Reset defaults starts.
    const older = live.start('/calendar?month=2025-07&status=published&project=7&project=12&type=comic', 'push');
    const pending = controller.resetDefaults();
    expect(controller.operation).toMatchObject({ kind: 'resetDefaults', phase: 'posting' });
    expect((await controller.resetDefaults()).reason).toBe(MESSAGES.resetDefaultsRunning);
    expect((await controller.save()).reason).toBe(MESSAGES.busy);
    await flush();
    answerReset();
    const result = await pending;

    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/calendar/defaults/reset');
    expect(options.body.get('defaultsGeneration')).toBe('5');
    // The pending (newest) intent is the context, month and repeated values kept.
    expect(options.body.get('returnTo')).toBe('/calendar?month=2025-07&status=published&project=7&project=12&type=comic');
    expect(FIELDS.some((field) => options.body.has(field))).toBe(false);
    expect(result.outcome).toBe('refreshing');
    expect(live.navigate.mock.calls[0][1]).toBe('/calendar?month=2025-07&project=7&project=12&type=comic');
    // The older GET's late install is not this refresh.
    live.install(older);
    expect(controller.operation).toMatchObject({ phase: 'refreshing' });
    live.install();
    expect(controller.status.message).toBe(MESSAGES.defaultsReset);
    expect(controller.savedMetadata()).toMatchObject({ generation: 6, savedKeys: [] });
  });

  it('never repeats a confirmed Reset defaults when its refresh fails; recovery is GET-only', async () => {
    const { controller, fetch, live } = setup({
      answer: (url, options) => appAnswer(url, options, 500, {
        status: 'error', committed: true, refreshUrl: '/calendar?month=2025-06&type=comic',
      }, 'committed'),
    });
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    live.fail();
    expect(controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
    expect(controller.status.message).toBe(MESSAGES.defaultsResetRefreshFailed);
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(controller.retryRefresh()).toBe('refreshing');
    expect(live.navigate.mock.calls.at(-1)[1]).toBe('/calendar?month=2025-06&type=comic');
    expect(posts(fetch)).toHaveLength(1);
  });

  it('builds the Reset defaults fallback destination from the month and temporary filters only', () => {
    expect(calendarResetDefaultsDestination(
      '/calendar?month=2025-06&status=planned&weekStart=sunday&view=list&project=12&project=7&type=comic&type=animation',
      BASE,
    )).toBe('/calendar?month=2025-06&project=12&project=7&type=comic&type=animation');
    expect(calendarResetDefaultsDestination('/calendar?view=list&status=all', BASE)).toBe('/calendar');
  });

  it('describes saved state from stored keys, never from value equality', () => {
    expect(describeCalendarSavedState(null, null)).toBe(SAVED_STATE.checking);
    expect(describeCalendarSavedState(null, null, { readFailed: true })).toBe(SAVED_STATE.unreadable);
    const none = authority();
    expect(describeCalendarSavedState(none, none.current)).toBe('No saved defaults.');
    // An explicitly saved fallback-equal value counts as saved.
    const fallbackEqual = authority({ savedKeys: ['status'] });
    expect(describeCalendarSavedState(fallbackEqual, fallbackEqual.current)).toBe('1 of 3 defaults saved.');
    const all = authority({ savedKeys: FIELDS, defaults: { view: 'list' } });
    expect(describeCalendarSavedState(all, { view: 'list', status: 'all', weekStart: 'monday' })).toBe('Defaults saved.');
    expect(describeCalendarSavedState(all, { view: 'grid', status: 'all', weekStart: 'monday' }))
      .toBe('Defaults saved · Current settings differ from the saved defaults.');
    expect(sameCalendarDefaultsValues(FALLBACKS, { ...FALLBACKS })).toBe(true);
    expect(sameCalendarDefaultsValues(FALLBACKS, { ...FALLBACKS, weekStart: 'sunday' })).toBe(false);
  });
});

/*
 * C4: Reset filters when the installed defaults authority is missing,
 * malformed or carries no Reset destination. The destination is the
 * DISPLAYED month only (the installed live region's data-calendar-month, the
 * month the route's own resetFiltersUrl and the native Reset form carry) —
 * never bare /calendar (the current month) and never the current location
 * with its temporary Projects / Types.
 */
describe('C4 Calendar Reset filters without a trustworthy authority destination', () => {
  const DISPLAYED = '2031-07';
  const FILTERED_LOCATION = `${BASE}/calendar?month=${DISPLAYED}&project=7&project=12&type=comic&status=planned&view=list&weekStart=sunday`;

  function pageDocument(month = DISPLAYED) {
    const region = { getAttribute: (name) => (name === 'data-calendar-month' ? month : null) };
    return {
      defaultView: { location: { href: FILTERED_LOCATION } },
      querySelector: (selector) => (selector === '[data-calendar-live-region]' ? region : null),
    };
  }

  function resetSetup({ readAuthority, month } = {}) {
    const live = makeLive({ intendedUrl: FILTERED_LOCATION });
    const fetch = vi.fn();
    const statuses = [];
    const controller = createCalendarFiltersDefaults(pageDocument(month), {
      live,
      fetch,
      readAuthority,
      csrfToken: () => 'token-1',
      onStatus: (message, kind) => statuses.push({ message, kind }),
    });
    return { controller, live, fetch, statuses };
  }

  const withoutDestination = () => {
    const value = authority({ current: { view: 'list' } });
    delete value.resetFiltersUrl;
    return value;
  };
  const cases = [
    ['missing', () => null],
    ['malformed', () => parseCalendarDefaultsAuthority('{"page":"calendar",', { requireCurrent: true })],
    ['incomplete', () => parseCalendarDefaultsAuthority(JSON.stringify({ ...authority(), generation: 'x' }), { requireCurrent: true })],
    ['missing its Reset destination', withoutDestination],
    ['carrying an empty Reset destination', () => ({ ...authority(), resetFiltersUrl: '' })],
    ['carrying a non-string Reset destination', () => ({ ...authority(), resetFiltersUrl: 42 })],
  ];

  it('uses the valid installed authority destination unchanged', () => {
    const { controller, live } = resetSetup({ readAuthority: () => authority({ resetFiltersUrl: `/calendar?month=${DISPLAYED}` }) });
    expect(controller.resetFilters().outcome).toBe('started');
    expect(live.navigate.mock.calls[0][1]).toBe(`/calendar?month=${DISPLAYED}`);
  });

  it.each(cases)('authority %s: navigates GET-only to the displayed month alone, never posting', async (_label, readAuthority) => {
    const { controller, live, fetch } = resetSetup({ readAuthority });
    expect(controller.resetFilters().outcome).toBe('started');
    const [, destination, options] = live.navigate.mock.calls[0];
    expect(options).toEqual({ historyMode: 'push' });
    const url = new URL(destination, BASE);
    expect(url.pathname).toBe('/calendar');
    // Projects / Types cleared; View, status and week start left to the
    // server's saved defaults (then fallbacks); the noncurrent month kept.
    expect([...url.searchParams.entries()]).toEqual([['month', DISPLAYED]]);
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', destination: `/calendar?month=${DISPLAYED}` });
    live.install();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps Save and Reset defaults fail-closed while the authority is untrustworthy', async () => {
    const { controller, fetch } = resetSetup({ readAuthority: () => null });
    expect((await controller.save()).outcome).toBe('blocked');
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    controller.resetFilters();
    expect((await controller.save()).reason).toBe(MESSAGES.resetPending);
    expect(posts(fetch)).toEqual([]);
  });

  it('a failed Reset GET keeps Save blocked; the engine GET Retry of the month-only address is adopted', async () => {
    const { controller, live, fetch } = resetSetup({ readAuthority: () => null });
    controller.resetFilters();
    live.fail();
    expect(controller.filtersReset).toMatchObject({ phase: 'failed' });
    expect((await controller.save()).reason).toBe(MESSAGES.resetIncomplete);
    const retried = live.start(`${BASE}/calendar?month=${DISPLAYED}`, 'push');
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', generation: retried });
    live.install(retried);
    // Installed, but still without authority: not trusted for a Save.
    expect(controller.filtersReset).toMatchObject({ phase: 'incomplete' });
    expect((await controller.save()).outcome).toBe('blocked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a newer month navigation or Back/Forward supersedes a pending Reset', () => {
    const { controller, live, fetch } = resetSetup({ readAuthority: () => null });
    controller.resetFilters();
    live.start(`/calendar?month=2031-08&project=7`, 'push');
    expect(controller.filtersReset).toBeNull();
    live.install();
    controller.resetFilters();
    expect(new URL(live.navigate.mock.calls.at(-1)[1], BASE).searchParams.get('month')).toBe(DISPLAYED);
    live.start(`/calendar?month=2031-06`, 'none');
    expect(controller.filtersReset).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[null], [''], ['2031-13'], ['2031-7'], ['2031-07&project=7']])(
    'refuses without navigating when the displayed month is %j',
    (month) => {
      const { controller, live, fetch, statuses } = resetSetup({ readAuthority: () => null, month });
      expect(controller.resetFilters().outcome).toBe('blocked');
      expect(live.navigate).not.toHaveBeenCalled();
      expect(controller.filtersReset).toBeNull();
      expect(statuses.at(-1)).toEqual({ message: MESSAGES.resetFiltersUnavailable, kind: 'error' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('derives exactly the route-shaped month-only destination', () => {
    expect(calendarResetFiltersDestination(pageDocument('2031-07'))).toBe('/calendar?month=2031-07');
    expect(calendarResetFiltersDestination(pageDocument('2031-13'))).toBeNull();
    expect(calendarResetFiltersDestination(null)).toBeNull();
  });
});

function makeElement(attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  const listeners = {};
  return {
    disabled: attrs.has('disabled'),
    hidden: attrs.has('hidden'),
    textContent: '',
    attrs,
    listeners,
    hasAttribute: (name) => attrs.has(name),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute(name) {
      attrs.delete(name);
      if (name === 'disabled') this.disabled = false;
    },
    addEventListener: (type, handler) => {
      (listeners[type] ||= []).push(handler);
    },
    closest() {
      return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeDocument({ form, save, reset, legacyForm = null }) {
  const documentListeners = {};
  return {
    defaultView: { location: { href: `${BASE}${TEMPORARY}` } },
    documentListeners,
    querySelector(selector) {
      if (selector === '#calendar-filters-defaults-form') return form;
      if (selector === '#calendar-defaults-form[data-calendar-defaults-fetch-save]') return legacyForm;
      if (selector === '[data-calendar-defaults-save]') return save;
      if (selector === '[data-calendar-defaults-reset]') return reset;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      (documentListeners[type] ||= []).push(handler);
    },
  };
}

describe('WP14a Calendar Save / Reset defaults opt-in boundary', () => {
  const inertLive = () => ({ snapshot: () => null, navigate: vi.fn(), subscribe: () => () => {} });

  it('arms Save and Reset defaults only once the controller owns them, exactly once per document', () => {
    const form = makeElement({ id: 'calendar-filters-defaults-form', 'data-defaults-explicit-save': '' });
    const save = makeElement({ disabled: '' });
    const reset = makeElement({ disabled: '' });
    const document = makeDocument({ form, save, reset });
    const fetch = vi.fn();
    const live = makeLive();

    const controller = enhanceCalendarFiltersDefaults(document, { live, fetch });
    expect(controller).not.toBeNull();
    expect(save.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
    const clicks = document.documentListeners.click.length;
    const submits = form.listeners.submit.length;
    expect(enhanceCalendarFiltersDefaults(document, { live, fetch })).toBe(controller);
    // No duplicate handlers or live subscriptions.
    expect(document.documentListeners.click).toHaveLength(clicks);
    expect(form.listeners.submit).toHaveLength(submits);
    expect(live.listenerCount).toBe(1);
    // Ordinary control changes and live navigation never POST.
    document.documentListeners.change?.forEach((handler) => handler({ target: makeElement({ name: 'status' }) }));
    live.start('/calendar?month=2025-07&status=planned', 'push');
    live.install();
    expect(fetch).not.toHaveBeenCalled();
    const event = { preventDefault: vi.fn() };
    form.listeners.submit[0](event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('stays inert while the legacy autosave form is present, or without the opt-in', () => {
    const cases = [
      // WP14a today: the legacy Calendar defaults dialog is still rendered.
      { form: null, legacy: true },
      // An opted-in form beside the legacy autosave form: never both writers.
      { form: { 'data-defaults-explicit-save': '' }, legacy: true },
      // The opted-in form itself carrying the legacy marker.
      { form: { 'data-defaults-explicit-save': '', 'data-calendar-defaults-fetch-save': '' }, legacy: false },
      { form: {}, legacy: false },
    ];
    for (const { form: attributes, legacy } of cases) {
      const form = attributes ? makeElement(attributes) : null;
      const save = makeElement({ disabled: '' });
      const reset = makeElement({ disabled: '' });
      const legacyForm = legacy ? makeElement({ id: 'calendar-defaults-form', 'data-calendar-defaults-fetch-save': '' }) : null;
      const document = makeDocument({ form, save, reset, legacyForm });
      expect(enhanceCalendarFiltersDefaults(document, { live: inertLive(), fetch: vi.fn() })).toBeNull();
      expect(save.disabled).toBe(true);
      expect(reset.disabled).toBe(true);
      expect(document.documentListeners.click).toBeUndefined();
    }
  });
});

describe('WP14b Calendar combined dialog activation', () => {
  const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  it('renders every hook the adapter binds, on the opted-in form, with no legacy autosave writer', () => {
    const template = read('../src/views/releases/calendar.njk');
    expect(template).toMatch(/<form id="calendar-filters-defaults-form" method="dialog"[^>]*\sdata-defaults-explicit-save\s/);
    expect(template).not.toContain('data-calendar-defaults-fetch-save');
    expect(template).not.toContain('id="calendar-defaults-form"');
    expect(template).not.toContain('/settings/defaults');
    expect(template).not.toContain("data-autosubmit', 'fetch'");
    for (const hook of [
      'data-calendar-defaults-indicator', 'data-calendar-defaults-save', 'data-calendar-defaults-reset',
      'data-calendar-filters-reset', 'data-calendar-defaults-recovery', 'data-calendar-defaults-retry',
      'data-calendar-defaults-check', 'data-calendar-defaults-authority',
    ]) {
      expect(template).toContain(hook);
    }
    // The dialog the adapter's opener refresh listens for.
    expect(template).toContain("dialog.render('calendar-filter-dialog', 'Filters & Defaults'");
    expect(template.match(/data-dialog-open="calendar-filter-dialog"/g)).toHaveLength(1);
  });

  it('retires the legacy Calendar autosave bootstrap and binds only the explicit transport', () => {
    const bootstrap = read('../src/static/creatorcrate.js');
    expect(bootstrap).not.toContain("formSelector: '#calendar-defaults-form'");
    expect(bootstrap).not.toContain("markerAttribute: 'data-calendar-defaults-fetch-save'");
    expect(bootstrap.match(/enhanceCalendarFiltersDefaults\(document\);/g)).toHaveLength(1);
    // Settings keeps its own /settings/defaults writer for other consumers.
    expect(read('../src/routes/settings.js')).toContain("'/defaults'");
  });
});
