import { describe, expect, it, vi } from 'vitest';
import {
  RELEASES_DEFAULTS_MESSAGES as MESSAGES,
  RELEASES_SAVED_STATE_MESSAGES as SAVED_STATE,
  createReleasesFiltersDefaults,
  describeReleasesSavedState,
  enhanceReleasesFiltersDefaults,
  parseReleasesDefaultsAuthority,
  releasesResetDefaultsDestination,
  releasesResetFiltersDestination,
  sameReleasesDefaultsValues,
} from '../src/static/client/releases-filters-defaults.js';
import { parseProjectsDefaultsAuthority } from '../src/static/client/projects-filters-defaults.js';

/*
 * WP12: the Releases config of the shared explicit defaults core
 * (explicit-page-defaults.js). The core's lifecycle rules are covered in depth
 * by asset-library-filters-defaults-client.test.js; these tests pin the
 * Releases contract: exactly two saveable settings (Sort, Order), every
 * temporary filter / exact-asset scope / page size never saved, the Releases
 * endpoints and generation, the temporary context Reset defaults keeps, the
 * page-size-preserving Reset filters, and fail-closed arming.
 */

const FIELDS = ['sort', 'order'];
const FALLBACKS = Object.freeze({ sort: 'planned', order: 'asc' });
const BASE = 'http://creatorcrate.test';
const TEMPORARY = '/releases?asset=42&search=needle&project=7&project=12&type=animation&type=comic&schedule=today&includeArchived=1&pageSize=50';

function authority({
  current = {}, defaults = {}, savedKeys = [], generation = 0, currentUrl, resetFiltersUrl = '/releases?pageSize=50',
} = {}) {
  const saved = Object.fromEntries(FIELDS.map((field) => [
    field, { stored: savedKeys.includes(field), valid: savedKeys.includes(field) },
  ]));
  return {
    page: 'releases',
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
    current: { ...FALLBACKS, ...current },
    currentUrl: currentUrl ?? `${TEMPORARY}&sort=title`,
  };
}

function makeLive({ intendedUrl = `${BASE}${TEMPORARY}&sort=title` } = {}) {
  const listeners = new Set();
  const live = {
    s: { generation: 1, pending: false, failed: false, failedUrl: null, intendedUrl, requestedHistoryMode: null },
    snapshot: () => ({ ...live.s }),
    subscribe: (document, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
  const controller = createReleasesFiltersDefaults({ defaultView: { location: { href: `${BASE}/releases` } } }, {
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

describe('WP12 Releases explicit defaults config', () => {
  it('accepts only complete Releases authority (never another page\'s)', () => {
    const valid = authority();
    expect(parseReleasesDefaultsAuthority(valid, { requireCurrent: true })).toEqual(valid);
    expect(parseReleasesDefaultsAuthority({ ...valid, page: 'projects' })).toBeNull();
    expect(parseProjectsDefaultsAuthority(valid)).toBeNull();
    expect(parseReleasesDefaultsAuthority({ ...valid, current: { sort: '' , order: 'asc' } }, { requireCurrent: true }))
      .toBeNull();
    const { generation, ...withoutGeneration } = valid;
    expect(generation).toBe(0);
    expect(parseReleasesDefaultsAuthority(withoutGeneration)).toBeNull();
    expect(parseReleasesDefaultsAuthority({ ...valid, savedKeys: ['sort'] })).toBeNull();
  });

  it('ordinary filter and sort edits and installs never POST defaults', async () => {
    const { controller, live, fetch } = setup();
    live.start('/releases?project=7&project=12', 'push');
    live.install();
    live.start('/releases?project=7&project=12&type=comic&sort=title&order=desc', 'push');
    live.fail();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(live.navigate).not.toHaveBeenCalled();
    expect(controller.operation).toBeNull();
  });

  it('Save posts exactly Sort and Order once, without any temporary filter, scope or page size', async () => {
    const installed = authority({ current: { sort: 'title', order: 'desc' }, generation: 3 });
    const expected = { sort: 'title', order: 'desc' };
    const { controller, fetch, live, statuses } = setup({
      installed,
      answer: (url, options) => appAnswer(url, options, 200, {
        status: 'success',
        values: expected,
        authority: authority({ defaults: expected, savedKeys: FIELDS, generation: 4 }),
      }, 'committed'),
    });
    const pending = controller.save();
    // A duplicate Save while the first is in flight sends nothing.
    expect((await controller.save()).reason).toBe(MESSAGES.saveInProgress);
    const result = await pending;

    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/releases/defaults');
    expect(options.headers.Accept).toBe('application/json');
    const body = options.body;
    expect(body.get('sort')).toBe('title');
    expect(body.get('order')).toBe('desc');
    expect(body.get('defaultsGeneration')).toBe('3');
    expect(body.get('defaultsOperation')).toBe('op-1');
    expect(body.get('_csrf')).toBe('token-1');
    for (const key of ['search', 'project', 'type', 'schedule', 'includeArchived', 'asset', 'pageSize', 'page', 'view']) {
      expect(body.has(key)).toBe(false);
    }
    expect([...new Set([...body.keys()])].sort()).toEqual(
      ['_csrf', 'defaultsGeneration', 'defaultsOperation', 'returnTo', ...FIELDS].sort(),
    );
    expect(result.outcome).toBe('refreshing');
    // The GET-only refresh keeps the current temporary intent (scope, repeated
    // Projects and Types, page size) and replaces the history entry.
    expect(live.navigate).toHaveBeenCalledTimes(1);
    const refreshed = new URL(live.navigate.mock.calls[0][1]);
    expect(refreshed.searchParams.getAll('project')).toEqual(['7', '12']);
    expect(refreshed.searchParams.getAll('type')).toEqual(['animation', 'comic']);
    expect(refreshed.searchParams.get('asset')).toBe('42');
    expect(refreshed.searchParams.get('pageSize')).toBe('50');
    expect(live.navigate.mock.calls[0][2]).toEqual({ historyMode: 'replace' });
    live.install();
    expect(controller.status).toEqual({ message: MESSAGES.saved, kind: 'saved' });
    expect(statuses.filter((entry) => entry.message === MESSAGES.saved)).toHaveLength(1);
    expect(controller.savedMetadata()).toMatchObject({ generation: 4, savedKeys: FIELDS });
  });

  it('refuses Save while results are pending, failed, or a Reset filters is unfinished', async () => {
    const { controller, live, fetch } = setup();
    live.start('/releases?search=ne', 'push');
    expect((await controller.save()).reason).toBe(MESSAGES.loading);
    live.fail();
    expect((await controller.save()).reason).toBe(MESSAGES.loadFailed);
    live.install();
    expect(controller.resetFilters().outcome).toBe('started');
    // Reset filters is a GET to the installed authority's destination, which
    // keeps the URL page size.
    expect(live.navigate.mock.calls.at(-1)[1]).toBe('/releases?pageSize=50');
    expect(live.navigate.mock.calls.at(-1)[2]).toEqual({ historyMode: 'push' });
    expect((await controller.save()).reason).toBe(MESSAGES.resetPending);
    live.fail();
    expect((await controller.save()).reason).toBe(MESSAGES.resetIncomplete);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adopts the engine GET Retry of a failed Reset filters that kept the page size', async () => {
    const { controller, live, fetch } = setup();
    expect(controller.resetFilters().outcome).toBe('started');
    live.fail();
    expect(controller.filtersReset).toMatchObject({ phase: 'failed' });
    // The engine's Retry repeats the same address (a new generation).
    const retried = live.start('/releases?pageSize=50', 'push');
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', generation: retried });
    expect((await controller.save()).reason).toBe(MESSAGES.resetPending);
    live.install(retried);
    expect(controller.filtersReset).toBeNull();
    expect(controller.saveBlockedReason()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets a newer edit supersede a pending Reset filters', async () => {
    const { controller, live } = setup();
    controller.resetFilters();
    live.start('/releases?project=7', 'push');
    expect(controller.filtersReset).toBeNull();
    live.install();
    expect(controller.saveBlockedReason()).toBeNull();
  });

  it('keeps a newer edit made during Save: the confirmed Save never refreshes over it', async () => {
    let answerSave;
    const { controller, live, fetch } = setup({
      installed: authority({ current: { sort: 'title', order: 'desc' }, generation: 2 }),
      fetchImpl: (url, options) => new Promise((resolve) => {
        answerSave = () => resolve(appAnswer(url, options, 200, {
          status: 'success',
          values: { sort: 'title', order: 'desc' },
          authority: authority({ defaults: { sort: 'title', order: 'desc' }, savedKeys: FIELDS, generation: 3 }),
        }, 'committed'));
      }),
    });
    const pending = controller.save();
    await flush();
    // The user changes Sort while the POST is pending.
    live.start('/releases?project=7&sort=updated', 'push');
    answerSave();
    const result = await pending;
    expect(result.outcome).toBe('refreshing');
    // The refresh follows the newer intent, never the old Save's location.
    expect(live.navigate.mock.calls.at(-1)[1]).toBe(`${BASE}/releases?project=7&sort=updated`);
    expect(live.navigate.mock.calls.at(-1)[2]).toEqual({ historyMode: 'push' });
    expect(posts(fetch)).toHaveLength(1);
    live.install();
    expect(controller.status.message).toBe(MESSAGES.saved);
  });

  it('never repeats a confirmed Save when its refresh fails; Retry is GET-only', async () => {
    const { controller, fetch, live } = setup({
      installed: authority({ current: { sort: 'title' }, generation: 0 }),
      answer: (url, options) => appAnswer(url, options, 200, {
        status: 'success',
        values: { sort: 'title', order: 'asc' },
        authority: authority({ defaults: { sort: 'title' }, savedKeys: FIELDS, generation: 1 }),
      }, 'committed'),
    });
    await controller.save();
    live.fail();
    expect(controller.operation).toMatchObject({ kind: 'save', phase: 'refresh-failed', confirmed: true });
    expect(controller.status.message).toBe(MESSAGES.savedRefreshFailed);
    expect((await controller.save()).reason).toBe(MESSAGES.loadFailed);
    expect(controller.retryRefresh()).toBe('refreshing');
    expect(posts(fetch)).toHaveLength(1);
    live.install();
    expect(controller.status.message).toBe(MESSAGES.saved);
  });

  it('reconciles an uncertain Save with GET only and keeps later mutations blocked', async () => {
    const { controller, fetch } = setup({
      installed: authority({ current: { sort: 'title' }, generation: 4 }),
      fetchImpl: (url, options) => {
        if (options.method === 'POST') return Promise.resolve(jsonResponse(504, { status: 'error' }));
        return Promise.resolve(jsonResponse(200, { status: 'success', authority: authority({ generation: 4 }) }));
      },
    });
    const result = await controller.save();
    expect(result.outcome).toBe('uncertain');
    expect(gets(fetch).map(([url]) => url)).toEqual(['/releases/defaults']);
    expect(controller.operation).toMatchObject({ phase: 'uncertain', unresolved: true });
    expect((await controller.save()).reason).toBe(MESSAGES.saveUnresolved);
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(await controller.retryReconcile()).toBe('uncertain');
    expect(posts(fetch)).toHaveLength(1);
  });

  it('Reset defaults posts once to the Releases reset route and refreshes the temporary context', async () => {
    const { controller, fetch, live } = setup({
      installed: authority({ savedKeys: ['sort'], generation: 5 }),
      answer: (url, options) => appAnswer(url, options, 200, {
        status: 'success',
        refreshUrl: TEMPORARY,
        authority: authority({ generation: 6 }),
      }, 'committed'),
    });
    const result = await controller.resetDefaults();

    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/releases/defaults/reset');
    expect(options.body.get('defaultsGeneration')).toBe('5');
    expect(options.body.get('returnTo')).toBe(`${TEMPORARY}&sort=title`);
    expect(FIELDS.some((field) => options.body.has(field))).toBe(false);
    expect(result.outcome).toBe('refreshing');
    expect(live.navigate.mock.calls[0][1]).toBe(TEMPORARY);
    live.install();
    expect(controller.status.message).toBe(MESSAGES.defaultsReset);
    expect(controller.savedMetadata()).toMatchObject({ generation: 6, savedKeys: [] });
  });

  it('never repeats a confirmed Reset defaults when its refresh fails; recovery is GET-only', async () => {
    const { controller, fetch, live } = setup({
      answer: (url, options) => appAnswer(url, options, 200, {
        status: 'success', refreshUrl: '/releases?project=7', authority: authority({ generation: 1 }),
      }, 'committed'),
    });
    await controller.resetDefaults();
    live.fail();
    expect(controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(controller.retryRefresh()).toBe('refreshing');
    expect(live.navigate.mock.calls.at(-1)[1]).toBe('/releases?project=7');
    expect(posts(fetch)).toHaveLength(1);
  });

  it('builds the Reset defaults fallback destination from the temporary context only', () => {
    expect(releasesResetDefaultsDestination(
      '/releases?asset=42&sort=title&order=desc&project=12&project=7&type=comic&search=%20needle%20&schedule=today&includeArchived=1&page=3&pageSize=50',
      BASE,
    )).toBe('/releases?asset=42&search=needle&project=12&project=7&type=comic&schedule=today&includeArchived=1&pageSize=50');
    expect(releasesResetDefaultsDestination('/releases?sort=title&order=desc&page=2', BASE)).toBe('/releases');
  });

  it('describes saved state from stored keys, never from value equality', () => {
    expect(describeReleasesSavedState(null, null)).toBe(SAVED_STATE.checking);
    expect(describeReleasesSavedState(null, null, { readFailed: true })).toBe(SAVED_STATE.unreadable);
    const none = authority();
    expect(describeReleasesSavedState(none, none.current)).toBe('No saved defaults.');
    // An explicitly saved fallback-equal value counts as saved.
    const fallbackEqual = authority({ savedKeys: ['order'] });
    expect(describeReleasesSavedState(fallbackEqual, fallbackEqual.current)).toBe('1 of 2 defaults saved.');
    const all = authority({ savedKeys: FIELDS, defaults: { sort: 'title' } });
    expect(describeReleasesSavedState(all, { sort: 'title', order: 'asc' })).toBe('Defaults saved.');
    expect(describeReleasesSavedState(all, { sort: 'updated', order: 'asc' }))
      .toBe('Defaults saved · Current settings differ from the saved defaults.');
    expect(describeReleasesSavedState(none, { sort: 'planned', order: 'desc' }))
      .toBe('No saved defaults · Current settings differ from the application defaults.');
    expect(sameReleasesDefaultsValues({ sort: 'title', order: 'asc' }, { sort: 'title', order: 'asc' })).toBe(true);
    expect(sameReleasesDefaultsValues({ sort: 'title', order: 'asc' }, { sort: 'title', order: 'desc' })).toBe(false);
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

function makeDocument({ form, save, reset }) {
  const documentListeners = {};
  return {
    defaultView: { location: { href: `${BASE}/releases` } },
    documentListeners,
    querySelector(selector) {
      if (selector === '#releases-defaults-form') return form;
      if (selector === '[data-releases-defaults-save]') return save;
      if (selector === '[data-releases-defaults-reset]') return reset;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      (documentListeners[type] ||= []).push(handler);
    },
  };
}

describe('WP12 Releases Save / Reset defaults initialization safety', () => {
  const live = () => ({ snapshot: () => null, navigate: vi.fn(), subscribe: () => () => {} });

  it('arms Save and Reset defaults only once the controller owns them, exactly once per document', () => {
    const form = makeElement({ id: 'releases-defaults-form', 'data-defaults-explicit-save': '' });
    const save = makeElement({ disabled: '' });
    const reset = makeElement({ disabled: '' });
    const document = makeDocument({ form, save, reset });

    const controller = enhanceReleasesFiltersDefaults(document, { live: live(), fetch: vi.fn() });
    expect(controller).not.toBeNull();
    expect(save.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
    const clicks = document.documentListeners.click.length;
    expect(enhanceReleasesFiltersDefaults(document, { live: live(), fetch: vi.fn() })).toBe(controller);
    expect(document.documentListeners.click).toHaveLength(clicks);
    const event = { preventDefault: vi.fn() };
    form.listeners.submit[0](event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('stays inert for a legacy autosave form or a missing opt-in', () => {
    for (const attributes of [
      { 'data-defaults-explicit-save': '', 'data-releases-defaults-autosave': '' },
      {},
    ]) {
      const form = makeElement(attributes);
      const save = makeElement({ disabled: '' });
      const reset = makeElement({ disabled: '' });
      const document = makeDocument({ form, save, reset });
      expect(enhanceReleasesFiltersDefaults(document, { live: live(), fetch: vi.fn() })).toBeNull();
      expect(save.disabled).toBe(true);
      expect(reset.disabled).toBe(true);
    }
  });

  it('leaves both controls disabled when initialization fails before arming', () => {
    const form = makeElement({ 'data-defaults-explicit-save': '' });
    form.addEventListener = () => {
      throw new Error('initialization failure');
    };
    const save = makeElement({ disabled: '' });
    const reset = makeElement({ disabled: '' });
    const document = makeDocument({ form, save, reset });
    expect(() => enhanceReleasesFiltersDefaults(document, { live: live(), fetch: vi.fn() })).toThrow();
    expect(save.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
  });
});

/*
 * P3-B: without a usable installed authority, Reset filters derives the
 * route's own Reset destination from the filter form's intended page size
 * (normalized by the list GET's rule) instead of the bare /releases.
 */
function sizeDocument({ sizes = [], form = true, href = `${BASE}/releases?asset=42&search=Needle&pageSize=10` } = {}) {
  const inputs = sizes.map((entry) => (typeof entry === 'string'
    ? { type: 'hidden', value: entry, disabled: false }
    : { type: 'hidden', disabled: false, ...entry }));
  const formNode = { querySelectorAll: (selector) => (selector === 'input[name="pageSize"]' ? inputs : []) };
  return {
    defaultView: { location: { href } },
    querySelector: (selector) => (selector === '[data-releases-filter]' && form ? formNode : null),
  };
}

function fallbackSetup({ installed = null, sizes = ['10'], form = true, href } = {}) {
  const live = makeLive();
  const statuses = [];
  const fetch = vi.fn();
  const controller = createReleasesFiltersDefaults(sizeDocument({ sizes, form, href }), {
    live,
    fetch,
    readAuthority: () => installed,
    csrfToken: () => 'token-1',
    onStatus: (message, kind) => statuses.push({ message, kind }),
  });
  return { controller, live, fetch, statuses };
}

describe('P3-B Releases Reset filters without a usable authority', () => {
  it.each([
    ['no page-size field (default)', [], '/releases'],
    ['size 10', ['10'], '/releases?pageSize=10'],
    ['size 50', ['50'], '/releases?pageSize=50'],
    ['an explicit default 25', ['25'], '/releases'],
    ['the maximum 100', ['100'], '/releases?pageSize=100'],
    ['a size over the maximum (clamped like the list GET)', ['500'], '/releases?pageSize=100'],
    ['a non-numeric size (the list GET default)', ['abc'], '/releases'],
    ['zero (the list GET default)', ['0'], '/releases'],
    ['a leading-zero size (not a strict integer)', ['010'], '/releases'],
    ['a disabled installed field (Reset / R7 cleared it)', [{ value: '10', disabled: true }], '/releases'],
    ['a newer carrier over a disabled installed field', [{ value: '10', disabled: true }, '50'], '/releases?pageSize=50'],
    ['the same size twice', ['10', '10'], '/releases?pageSize=10'],
    ['a non-hidden pageSize input', [{ value: '10', type: 'text' }], '/releases'],
  ])('derives the Reset destination from %s', (_label, sizes, expected) => {
    expect(releasesResetFiltersDestination(sizeDocument({ sizes }))).toBe(expected);
  });

  it('cannot construct a destination from conflicting sizes or a missing form', () => {
    expect(releasesResetFiltersDestination(sizeDocument({ sizes: ['10', '50'] }))).toBeNull();
    expect(releasesResetFiltersDestination(sizeDocument({ form: false }))).toBeNull();
    expect(releasesResetFiltersDestination(null)).toBeNull();
  });

  it.each([
    ['missing or malformed authority', null],
    ['authority without resetFiltersUrl', (() => { const { resetFiltersUrl, ...rest } = authority(); return rest; })()],
    ['an empty resetFiltersUrl', authority({ resetFiltersUrl: '' })],
    ['a resetFiltersUrl for another page', authority({ resetFiltersUrl: '/calendar?month=2026-11' })],
    ['a cross-origin resetFiltersUrl', authority({ resetFiltersUrl: 'https://elsewhere.test/releases' })],
    ['a non-string resetFiltersUrl', authority({ resetFiltersUrl: 42 })],
  ])('%s: Reset filters GETs /releases?pageSize=10, never bare /releases, and never POSTs', async (_label, installed) => {
    const { controller, live, fetch } = fallbackSetup({ installed });
    expect(controller.resetFilters()).toMatchObject({ outcome: 'started' });
    expect(live.navigate).toHaveBeenCalledTimes(1);
    expect(live.navigate.mock.calls[0][1]).toBe('/releases?pageSize=10');
    expect(live.navigate.mock.calls[0][2]).toEqual({ historyMode: 'push' });
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', destination: '/releases?pageSize=10' });
    live.install();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a valid authority destination is used unchanged (the form is not consulted)', () => {
    const { controller, live } = fallbackSetup({
      installed: authority({ resetFiltersUrl: '/releases?pageSize=50' }), sizes: ['10', '50'],
    });
    expect(controller.resetFilters().outcome).toBe('started');
    expect(live.navigate.mock.calls[0][1]).toBe('/releases?pageSize=50');
  });

  it('refuses with an accessible message instead of navigating when the size cannot be read', () => {
    const { controller, live, fetch, statuses } = fallbackSetup({ sizes: ['10', '50'] });
    expect(controller.resetFilters()).toEqual({ outcome: 'blocked' });
    expect(live.navigate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ message: MESSAGES.resetFiltersUnavailable, kind: 'error' });
    expect(MESSAGES.resetFiltersUnavailable).toMatch(/page size/);
  });

  it('adopts the engine GET-only Retry of a failed fallback Reset and keeps Save fenced until it installs', async () => {
    const { controller, live, fetch } = fallbackSetup();
    controller.resetFilters();
    live.fail();
    expect(controller.filtersReset).toMatchObject({ phase: 'failed', destination: '/releases?pageSize=10' });
    expect((await controller.save()).reason).toBe(MESSAGES.resetIncomplete);
    const retried = live.start('/releases?pageSize=10', 'push');
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', generation: retried });
    // Installed without authority: the Reset is still incomplete.
    live.install(retried);
    expect(controller.filtersReset).toMatchObject({ phase: 'incomplete' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('missing authority never authorizes Save or Reset defaults with guessed metadata', async () => {
    const { controller, fetch } = fallbackSetup();
    expect((await controller.save()).outcome).toBe('blocked');
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(fetch).not.toHaveBeenCalled();
  });
});

/*
 * P3 correction 3: an otherwise readable authority whose Reset destination
 * the URL parser would resolve to the CURRENT (asset-scoped, searched)
 * address — empty after trimming, or fragment-only — is rejected before
 * resolution and the P3-B size-preserving fallback is used instead.
 */
describe('P3 correction 3: malformed Reset destinations in a readable authority', () => {
  const SCOPED = `${BASE}/releases?asset=42&search=Needle&pageSize=10`;
  const RESTRICTED = ['asset', 'search', 'project', 'type', 'schedule', 'includeArchived', 'page', 'sort', 'order'];

  function assertFallback(live, controller) {
    expect(live.navigate).toHaveBeenCalledTimes(1);
    const requested = live.navigate.mock.calls[0][1];
    expect(requested).toBe('/releases?pageSize=10');
    const url = new URL(requested, SCOPED);
    expect(url.pathname).toBe('/releases');
    RESTRICTED.forEach((key) => expect(url.searchParams.has(key)).toBe(false));
    expect(url.searchParams.get('pageSize')).toBe('10');
    expect(live.navigate.mock.calls[0][2]).toEqual({ historyMode: 'push' });
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', destination: '/releases?pageSize=10' });
  }

  it.each([
    ['whitespace only', '   '],
    ['a fragment only', '#ignored'],
    ['an empty fragment', '#'],
    ['whitespace plus a fragment', '  #ignored  '],
    ['tab/newline plus a fragment', '\t\n#ignored\r\n'],
    ['C0 controls only', '\u0000\u001f'],
    ['an empty string', ''],
    ['a malformed URL', 'http://['],
    ['an encoded wrong path', '/%72eleases?pageSize=50'],
    ['a dot-segment wrong path', '/releases/../calendar?pageSize=50'],
    ['a same-origin wrong page', '/releasesx?pageSize=50'],
    ['a cross-origin URL', 'https://elsewhere.test/releases?pageSize=50'],
  ])('%s: GETs /releases?pageSize=10 (asset and Search cleared) and never POSTs', async (_label, resetFiltersUrl) => {
    const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl }) });
    expect(controller.resetFilters()).toMatchObject({ outcome: 'started' });
    assertFallback(live, controller);
    live.install();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['root-relative', '/releases?pageSize=50', '/releases?pageSize=50'],
    ['absolute same-page', `${BASE}/releases?pageSize=50`, `${BASE}/releases?pageSize=50`],
    ['page-relative', 'releases?pageSize=50', 'releases?pageSize=50'],
    ['query-only (replaces the scoped query)', '?pageSize=50', '?pageSize=50'],
    ['root-relative with a trailing fragment', '/releases?pageSize=50#list', '/releases?pageSize=50#list'],
    ['bare page path (default size)', '/releases', '/releases'],
  ])('a valid %s authority destination is used unchanged', (_label, resetFiltersUrl, expected) => {
    const { controller, live } = fallbackSetup({ installed: authority({ resetFiltersUrl }), sizes: ['10', '50'] });
    expect(controller.resetFilters().outcome).toBe('started');
    expect(live.navigate.mock.calls[0][1]).toBe(expected);
    const url = new URL(live.navigate.mock.calls[0][1], SCOPED);
    expect(url.searchParams.has('asset')).toBe(false);
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('conflicting page-size controls still refuse accessibly instead of guessing', () => {
    const { controller, live, fetch, statuses } = fallbackSetup({
      installed: authority({ resetFiltersUrl: '#ignored' }), sizes: ['10', '50'],
    });
    expect(controller.resetFilters()).toEqual({ outcome: 'blocked' });
    expect(live.navigate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ message: MESSAGES.resetFiltersUnavailable, kind: 'error' });
  });

  it('a failed fallback Reset is adopted by its GET-only Retry; a newer Search supersedes the Retry', async () => {
    const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl: '   ' }) });
    controller.resetFilters();
    live.fail();
    expect(controller.filtersReset).toMatchObject({ phase: 'failed', destination: '/releases?pageSize=10' });
    const retried = live.start('/releases?pageSize=10', 'push');
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', generation: retried });
    // A newer Search (built by the engine from the reset form) supersedes the
    // Retry; the stale Retry generation can no longer settle the Reset.
    const searched = live.start('/releases?pageSize=10&search=Other', 'push');
    expect(searched).toBeGreaterThan(retried);
    // The newer explicit Search wins over the pending Retry (R7).
    expect(controller.filtersReset).toBeNull();
    expect(new URL(live.s.intendedUrl).searchParams.has('asset')).toBe(false);
    live.install(searched);
    expect(controller.filtersReset).toBeNull();
    expect(live.navigate).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Back to the scoped entry and Forward to the cleared entry never repeat or redirect the Reset', async () => {
    const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl: '#ignored' }) });
    controller.resetFilters();
    live.install();
    expect(controller.filtersReset).toBeNull();
    const back = live.start('/releases?asset=42&search=Needle&pageSize=10', 'none');
    live.install(back);
    const forward = live.start('/releases?pageSize=10', 'none');
    live.install(forward);
    expect(live.navigate).toHaveBeenCalledTimes(1);
    expect(controller.filtersReset).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an invalid destination changes no defaults gating: Save stays fenced exactly as for a valid one', async () => {
    const reasons = [];
    for (const resetFiltersUrl of ['#ignored', '/releases?pageSize=10']) {
      const { controller, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl }) });
      controller.resetFilters();
      const outcome = await controller.save();
      expect(outcome.outcome).toBe('blocked');
      reasons.push(outcome.reason);
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(reasons[0]).toBe(MESSAGES.resetPending);
    expect(reasons[1]).toBe(reasons[0]);
  });
});

/*
 * P3-C3 follow-up: two further shapes of an effectively empty or unusable
 * Reset destination. A scheme followed by nothing or only a fragment
 * ("http:", "http:#ignored") resolves against a same-scheme base to the
 * CURRENT scoped address; a URL carrying userinfo passes the origin/path
 * check (origin ignores credentials) but cannot be requested. Both are
 * rejected and the P3-B size-preserving fallback is used.
 */
describe('P3-C3 follow-up: scheme-only and credential-bearing Reset destinations', () => {
  const SCOPED = `${BASE}/releases?asset=42&search=Needle&pageSize=10`;
  const RESTRICTED = ['asset', 'search', 'project', 'type', 'schedule', 'includeArchived', 'page', 'sort', 'order'];

  function assertFallback(live, controller, base = SCOPED) {
    expect(live.navigate).toHaveBeenCalledTimes(1);
    const requested = live.navigate.mock.calls[0][1];
    expect(requested).toBe('/releases?pageSize=10');
    const url = new URL(requested, base);
    expect(url.pathname).toBe('/releases');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    RESTRICTED.forEach((key) => expect(url.searchParams.has(key)).toBe(false));
    expect(url.searchParams.get('pageSize')).toBe('10');
    expect(live.navigate.mock.calls[0][2]).toEqual({ historyMode: 'push' });
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', destination: '/releases?pageSize=10' });
  }

  const SCHEME_ONLY = [
    ['http:', 'http:'],
    ['http:#ignored', 'http:#ignored'],
    ['http:# (empty fragment)', 'http:#'],
    ['upper-case HTTP:', 'HTTP:'],
    ['mixed-case Http:#x', 'Http:#x'],
    ['whitespace around the scheme', '  http:  '],
    ['tab/newline inside the scheme', 'ht\ttp:\n'],
    ['C0 controls around a scheme plus fragment', '\u0001http:#ignored\u001f'],
    ['a scheme then a tab before the fragment', 'http:\t#ignored'],
  ];

  it('the reproductions really resolve to the scoped address (parser precondition)', () => {
    for (const reference of ['http:', 'http:#ignored', 'HTTP:', '  http:  ', 'ht\ttp:']) {
      const resolved = new URL(reference, SCOPED);
      expect(resolved.searchParams.get('asset')).toBe('42');
      expect(resolved.searchParams.get('search')).toBe('Needle');
    }
    const secure = new URL('https:#x', 'https://creatorcrate.test/releases?asset=42');
    expect(secure.searchParams.get('asset')).toBe('42');
    const credentialed = new URL('//user:secret@creatorcrate.test/releases', SCOPED);
    expect(credentialed.origin).toBe(BASE);
    expect(credentialed.username).toBe('user');
  });

  it.each(SCHEME_ONLY)('scheme-only %s under an HTTP base: GETs /releases?pageSize=10 and never POSTs', async (_label, resetFiltersUrl) => {
    const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl }) });
    expect(controller.resetFilters()).toMatchObject({ outcome: 'started' });
    assertFallback(live, controller);
    live.install();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['https:', 'https:'],
    ['https:#ignored', 'https:#ignored'],
    ['HTTPS:', 'HTTPS:'],
    [' https:#x ', ' https:#x '],
  ])('scheme-only %s under an HTTPS base: GETs /releases?pageSize=10', async (_label, resetFiltersUrl) => {
    const href = 'https://creatorcrate.test/releases?asset=42&search=Needle&pageSize=10';
    const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl }), href });
    expect(controller.resetFilters()).toMatchObject({ outcome: 'started' });
    assertFallback(live, controller, href);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  const CREDENTIALS = [
    ['username only', 'http://user@creatorcrate.test/releases?pageSize=50'],
    ['username and password', 'http://user:secret@creatorcrate.test/releases?pageSize=50'],
    ['username with an empty password', 'http://user:@creatorcrate.test/releases?pageSize=50'],
    ['an empty username with a password', 'http://:secret@creatorcrate.test/releases?pageSize=50'],
    ['percent-encoded userinfo', 'http://%75ser:p%40ss@creatorcrate.test/releases?pageSize=50'],
    ['protocol-relative with credentials', '//user:secret@creatorcrate.test/releases?pageSize=50'],
    ['credentials on the exact bare page', 'http://user:secret@creatorcrate.test/releases'],
  ];

  it.each(CREDENTIALS)('credential-bearing %s (same origin and path): GETs the fallback, never the credential URL', async (_label, resetFiltersUrl) => {
    const { controller, live, fetch, statuses } = fallbackSetup({ installed: authority({ resetFiltersUrl }) });
    expect(controller.resetFilters()).toMatchObject({ outcome: 'started' });
    assertFallback(live, controller);
    // The supplied credentials are neither requested nor reported.
    expect(new URL(live.s.intendedUrl).username).toBe('');
    expect(JSON.stringify(statuses)).not.toMatch(/user|secret|p%40ss/);
    expect(JSON.stringify(controller.filtersReset)).not.toMatch(/user|secret/);
    live.install();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['root-relative', '/releases?pageSize=50', '/releases?pageSize=50'],
    ['bare root-relative page', '/releases', '/releases'],
    ['absolute same-page', `${BASE}/releases?pageSize=50`, `${BASE}/releases?pageSize=50`],
    ['absolute same-page with a trailing fragment', `${BASE}/releases?pageSize=50#list`, `${BASE}/releases?pageSize=50#list`],
    ['page-relative', 'releases?pageSize=50', 'releases?pageSize=50'],
    ['query-only (replaces the scoped query)', '?pageSize=50', '?pageSize=50'],
    ['path plus fragment', '/releases#list', '/releases#list'],
    ['path, query and fragment', '/releases?pageSize=50#list', '/releases?pageSize=50#list'],
    ['scheme plus a query (replaces the scoped query)', 'http:?pageSize=50', 'http:?pageSize=50'],
    ['scheme plus a path', 'http:/releases?pageSize=50', 'http:/releases?pageSize=50'],
    ['an empty userinfo marker (no credentials once parsed)', 'http://@creatorcrate.test/releases?pageSize=50', 'http://@creatorcrate.test/releases?pageSize=50'],
  ])('a valid %s destination is still used unchanged', (_label, resetFiltersUrl, expected) => {
    const { controller, live } = fallbackSetup({ installed: authority({ resetFiltersUrl }), sizes: ['10', '50'] });
    expect(controller.resetFilters().outcome).toBe('started');
    expect(live.navigate.mock.calls[0][1]).toBe(expected);
    const url = new URL(live.navigate.mock.calls[0][1], SCOPED);
    expect(url.pathname).toBe('/releases');
    expect(url.searchParams.has('asset')).toBe(false);
    expect(url.searchParams.has('search')).toBe(false);
  });

  it.each([
    ['missing authority', null],
    ['an authority with no destination', authority({ resetFiltersUrl: undefined })],
  ])('%s still uses the fallback', (_label, installed) => {
    if (installed) delete installed.resetFiltersUrl;
    const { controller, live } = fallbackSetup({ installed });
    controller.resetFilters();
    assertFallback(live, controller);
  });

  it('unparseable authority JSON still uses the fallback', () => {
    const parsed = parseReleasesDefaultsAuthority('{"resetFiltersUrl":"http:"');
    expect(parsed).toBeNull();
    const { controller, live } = fallbackSetup({ installed: parsed });
    controller.resetFilters();
    assertFallback(live, controller);
  });

  it('conflicting page sizes still refuse accessibly for scheme-only and credential destinations', () => {
    for (const resetFiltersUrl of ['http:', 'http://user:secret@creatorcrate.test/releases']) {
      const { controller, live, fetch, statuses } = fallbackSetup({
        installed: authority({ resetFiltersUrl }), sizes: ['10', '50'],
      });
      expect(controller.resetFilters()).toEqual({ outcome: 'blocked' });
      expect(live.navigate).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(statuses.at(-1)).toEqual({ message: MESSAGES.resetFiltersUnavailable, kind: 'error' });
    }
  });

  it.each([
    ['Search', '/releases?pageSize=10&search=Other'],
    ['Project', '/releases?pageSize=10&project=7'],
    ['Type', '/releases?pageSize=10&type=comic'],
    ['pagination', '/releases?pageSize=10&page=2'],
  ])('a %s made while the fallback Reset is held composes with the cleared filters', async (_label, next) => {
    for (const resetFiltersUrl of ['http:', 'http:#ignored', 'http://user:secret@creatorcrate.test/releases?pageSize=10']) {
      const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl }) });
      controller.resetFilters();
      const resetGeneration = live.s.generation;
      const later = live.start(next, 'push');
      expect(controller.filtersReset).toBeNull();
      const intended = new URL(live.s.intendedUrl);
      expect(intended.searchParams.has('asset')).toBe(false);
      expect(intended.searchParams.getAll('search')).not.toContain('Needle');
      expect(intended.username).toBe('');
      // The older Reset answer arriving last cannot settle anything.
      live.install(later);
      live.install(resetGeneration);
      expect(controller.filtersReset).toBeNull();
      expect(live.navigate).toHaveBeenCalledTimes(1);
      await flush();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('a failed fallback Reset is retried GET-only to the fallback; older failures arriving last are ignored', async () => {
    for (const resetFiltersUrl of ['http:#ignored', '//user:secret@creatorcrate.test/releases?pageSize=10']) {
      const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl }) });
      controller.resetFilters();
      const first = live.s.generation;
      live.fail();
      expect(controller.filtersReset).toMatchObject({ phase: 'failed', destination: '/releases?pageSize=10' });
      expect(live.s.failedUrl).toBe(`${BASE}/releases?pageSize=10`);
      const retried = live.start(live.s.failedUrl, 'push');
      expect(controller.filtersReset).toMatchObject({ phase: 'pending', generation: retried });
      const searched = live.start('/releases?pageSize=10&search=Other', 'push');
      expect(controller.filtersReset).toBeNull();
      live.fail(first);
      live.fail(retried);
      expect(controller.filtersReset).toBeNull();
      live.install(searched);
      expect(new URL(live.s.intendedUrl).searchParams.has('asset')).toBe(false);
      expect(live.navigate).toHaveBeenCalledTimes(1);
      await flush();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('Back to the scoped entry and Forward to the cleared entry never repeat the Reset', async () => {
    const { controller, live, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl: 'http:' }) });
    controller.resetFilters();
    live.install();
    expect(controller.filtersReset).toBeNull();
    const back = live.start('/releases?asset=42&search=Needle&pageSize=10', 'none');
    live.install(back);
    const forward = live.start('/releases?pageSize=10', 'none');
    live.install(forward);
    expect(live.navigate).toHaveBeenCalledTimes(1);
    expect(controller.filtersReset).toBeNull();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an invalid destination changes no defaults gating: Save stays fenced exactly as for a valid one', async () => {
    const outcomes = [];
    for (const resetFiltersUrl of ['http:', 'http://user:secret@creatorcrate.test/releases', '/releases?pageSize=10']) {
      const { controller, fetch } = fallbackSetup({ installed: authority({ resetFiltersUrl }) });
      controller.resetFilters();
      await flush();
      // Clicking Reset filters itself never POSTs.
      expect(fetch).not.toHaveBeenCalled();
      const outcome = await controller.save();
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: MESSAGES.resetPending });
      expect(fetch).not.toHaveBeenCalled();
      outcomes.push(outcome.reason);
    }
    expect(new Set(outcomes).size).toBe(1);
  });
});
