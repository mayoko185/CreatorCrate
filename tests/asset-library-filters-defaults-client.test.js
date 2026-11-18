import { describe, expect, it, vi } from 'vitest';
import {
  ASSET_LIBRARY_DEFAULTS_MESSAGES as MESSAGES,
  ASSET_LIBRARY_SAVED_STATE_MESSAGES as SAVED_STATE,
  createAssetLibraryFiltersDefaults,
  describeAssetLibrarySavedState,
  enhanceAssetLibraryFiltersDefaults,
  parseAssetLibraryDefaultsAuthority,
  readAssetLibraryDefaultsAuthority,
  sameAssetLibraryDefaultsValues,
} from '../src/static/client/asset-library-filters-defaults.js';

const FIELDS = ['view', 'gridStyle', 'sort', 'order', 'pageSize', 'extension', 'category', 'presence', 'tag'];
const FALLBACKS = Object.freeze({
  view: 'grid', gridStyle: 'uncropped', sort: 'filename', order: 'asc', pageSize: '25',
  extension: 'all', category: 'all', presence: 'all', tag: 'all',
});
const BASE = 'http://creatorcrate.test';

function authority({ current = {}, defaults = {}, savedKeys = [], revision = 'r1', currentUrl, generation = 0 } = {}) {
  const saved = Object.fromEntries(FIELDS.map((field) => [
    field, { stored: savedKeys.includes(field), valid: savedKeys.includes(field) },
  ]));
  return {
    page: 'assetViewer',
    fields: [...FIELDS],
    fallbacks: { ...FALLBACKS },
    defaults: { ...FALLBACKS, ...defaults },
    saved,
    savedKeys: FIELDS.filter((field) => savedKeys.includes(field)),
    hasSavedDefaults: savedKeys.length > 0,
    generation,
    revision,
    resetFiltersUrl: '/asset-viewer?resetFilters=1',
    current: { ...FALLBACKS, ...current },
    temporary: { projectIds: [3, 7], projectTypes: ['comic', 'images'], search: 'cat', usage: 'unused' },
    currentUrl: currentUrl ?? '/asset-viewer?project=3&project=7&type=comic&type=images&search=cat&usage=unused',
  };
}

function savedAuthority(values, revision = 'r2', generation = 0) {
  const result = authority({ defaults: values, savedKeys: FIELDS, revision, generation });
  delete result.current;
  delete result.temporary;
  delete result.currentUrl;
  return result;
}

function makeLive({ intendedUrl = `${BASE}/asset-viewer?project=3&project=7&type=comic&type=images&search=cat&usage=unused` } = {}) {
  const listeners = new Set();
  const live = {
    s: { generation: 1, pending: false, failed: false, failedUrl: null, intendedUrl, requestedHistoryMode: null },
    transportNavigations: [],
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
    // An ordinary user edit through the live engine (not the transport).
    userNavigate(url) {
      return live.start(url, 'push');
    },
    install(generation = live.s.generation) {
      live.s.pending = false;
      live.s.failed = false;
      live.emit({ phase: 'installed', generation, url: live.s.intendedUrl });
    },
    fail(generation = live.s.generation) {
      live.s.pending = false;
      live.s.failed = true;
      live.s.failedUrl = live.s.intendedUrl;
      live.emit({ phase: 'failed', generation, url: live.s.intendedUrl });
    },
    // The engine's own GET-only Retry of the failed request.
    engineRetry() {
      return live.start(live.s.failedUrl, 'push');
    },
  };
  live.navigate = vi.fn((document, url, { historyMode } = {}) => {
    const generation = live.start(url, historyMode);
    live.transportNavigations.push({ url, historyMode, generation });
    return { status: 'started', generation };
  });
  return live;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/*
 * WP9a F7: the application's own answer to the request it is matched with.
 * It is materialized when the controller's request is made, echoing that
 * request's operation identity and generation exactly as the server does
 * (src/routes/asset-library.js defaultsOperationAcknowledgement). Anything
 * built with jsonResponse() is, by contrast, an uncorrelated response.
 */
const APP_ANSWER = Symbol('app-answer');
function appAnswer(status, body = {}, overrides = {}) {
  const result = overrides.result ?? ({ 200: 'committed', 409: 'conflict', 422: 'invalid' }[status]
    ?? (body.committed === true ? 'committed' : 'failed'));
  return { [APP_ANSWER]: true, status, body, ...overrides, result };
}

function materialize(answer, url, options) {
  if (!answer?.[APP_ANSWER]) return answer;
  const sent = options?.body;
  const expected = Number(sent?.get?.('defaultsGeneration'));
  const committedOrConflict = answer.result === 'committed' || answer.result === 'conflict';
  const generation = answer.generation !== undefined ? answer.generation : (committedOrConflict ? expected + 1 : null);
  const payload = {
    ...answer.body,
    operation: {
      id: answer.id ?? sent?.get?.('defaultsOperation'),
      kind: answer.kind ?? (String(url).endsWith('/reset') ? 'resetDefaults' : 'save'),
      result: answer.result,
      committed: answer.result === 'committed',
      expectedGeneration: answer.expectedGeneration ?? expected,
      generation,
    },
  };
  if (payload.authority && committedOrConflict && answer.keepAuthorityGeneration !== true) {
    payload.authority = { ...payload.authority, generation };
  }
  return jsonResponse(answer.status, payload);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function setup({ installed = authority(), live = makeLive(), fetch } = {}) {
  const page = { authority: installed };
  const fetchMock = fetch ?? vi.fn();
  const statuses = [];
  let operations = 0;
  const controller = createAssetLibraryFiltersDefaults({ defaultView: { location: { href: `${BASE}/asset-viewer` } } }, {
    live,
    fetch: (url, options) => Promise.resolve(fetchMock(url, options)).then((answer) => materialize(answer, url, options)),
    createOperationId: () => `op-${operations += 1}`,
    readAuthority: () => page.authority,
    csrfToken: () => 'token-1',
    onStatus: (message, kind) => statuses.push({ message, kind }),
  });
  return { controller, live, fetch: fetchMock, page, statuses };
}

const posts = (fetch) => fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
const reads = (fetch) => fetch.mock.calls.filter(([, options]) => options?.method === 'GET');

describe('WP9a Asset Library explicit Save transport', () => {
  it('ordinary edits, Grid style choices and installs never POST defaults', async () => {
    const { controller, live, fetch } = setup();
    live.userNavigate('/asset-viewer?sort=size');
    live.install();
    controller.setGridStyle('cropped');
    live.userNavigate('/asset-viewer?view=list');
    live.fail();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it('captures one coherent snapshot of the nine eligible settings with repeated keys and no temporary filters', async () => {
    const installed = authority({
      current: { view: 'list', sort: 'size', order: 'desc', pageSize: '50', extension: ['png', 'jpg'],
        category: ['art'], presence: 'present', tag: ['4', '9'] },
    });
    const { controller, fetch } = setup({ installed });
    controller.setGridStyle('cropped');
    const expected = { ...installed.current, gridStyle: 'cropped' };
    fetch.mockResolvedValueOnce(appAnswer(200, {
      status: 'success', values: expected, authority: savedAuthority(expected),
    }));

    expect(controller.currentValues()).toEqual(expected);
    const result = await controller.save();
    expect(result.outcome).toBe('refreshing');
    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/asset-viewer/defaults');
    expect(options.headers.Accept).toBe('application/json');
    const body = options.body;
    expect(body.get('_csrf')).toBe('token-1');
    expect(body.get('returnTo')).toBe(installed.currentUrl);
    expect(body.getAll('extension')).toEqual(['png', 'jpg']);
    expect(body.getAll('tag')).toEqual(['4', '9']);
    expect(body.getAll('category')).toEqual(['art']);
    expect(body.get('gridStyle')).toBe('cropped');
    expect(body.get('view')).toBe('list');
    expect(body.get('pageSize')).toBe('50');
    for (const temporary of ['project', 'type', 'search', 'usage']) expect(body.has(temporary)).toBe(false);
    // WP9a F6/F7: the generation it is based on and a unique operation identity.
    expect(body.get('defaultsGeneration')).toBe('0');
    expect(body.get('defaultsOperation')).toBe('op-1');
    expect([...new Set([...body.keys()])].sort())
      .toEqual(['_csrf', 'returnTo', 'defaultsGeneration', 'defaultsOperation', ...FIELDS].sort());
  });

  it('refuses a second Save while one is in flight (no duplicate POST)', async () => {
    const { controller, fetch } = setup();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const first = controller.save();
    const second = await controller.save();
    expect(second).toEqual({ outcome: 'blocked', reason: MESSAGES.saveInProgress });
    pending.resolve(appAnswer(200, { status: 'success', values: FALLBACKS, authority: savedAuthority(FALLBACKS) }));
    await first;
    expect(posts(fetch)).toHaveLength(1);
  });

  it('refuses Save while a filter GET is pending or failed instead of mixing generations', async () => {
    const { controller, live, fetch, page } = setup();
    live.userNavigate('/asset-viewer?view=list');
    // The response is prepared (its authority could be visible) but not installed.
    page.authority = authority({ current: { view: 'list' } });
    expect(controller.saveBlockedReason()).toBe(MESSAGES.loading);
    expect(controller.currentValues()).toBeNull();
    expect((await controller.save()).outcome).toBe('blocked');
    live.fail();
    expect(controller.saveBlockedReason()).toBe(MESSAGES.loadFailed);
    expect((await controller.save()).outcome).toBe('blocked');
    expect(fetch).not.toHaveBeenCalled();
    live.engineRetry();
    live.install();
    expect(controller.saveBlockedReason()).toBeNull();
    expect(controller.currentValues().view).toBe('list');
  });

  it('acknowledges only the submitted snapshot and keeps newer edits made during Save', async () => {
    const { controller, live, fetch, page } = setup();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const saving = controller.save();
    // Newer intentions while the POST is pending.
    controller.setGridStyle('cropped');
    live.userNavigate('/asset-viewer?search=newer&sort=size');
    pending.resolve(appAnswer(200, { status: 'success', values: FALLBACKS, authority: savedAuthority(FALLBACKS) }));
    const result = await saving;

    expect(result.snapshot).toEqual(FALLBACKS);
    expect(result.outcome).toBe('refreshing');
    // The refresh is a GET of the newest intention, never the old returnTo.
    expect(live.navigate).toHaveBeenCalledTimes(1);
    expect(live.navigate.mock.calls[0][1]).toBe(`${BASE}/asset-viewer?search=newer&sort=size`);
    expect(live.navigate.mock.calls[0][2]).toEqual({ historyMode: 'push' });
    expect(controller.currentGridStyle()).toBe('cropped');
    expect(controller.savedMetadata().defaults).toEqual(FALLBACKS);

    page.authority = authority({ current: { sort: 'size' }, savedKeys: FIELDS, revision: 'r2' });
    live.install();
    expect(controller.operation).toBeNull();
    expect(controller.status).toEqual({ message: MESSAGES.saved, kind: 'saved' });
    expect(controller.currentValues()).toMatchObject({ sort: 'size', gridStyle: 'cropped' });
    expect(posts(fetch)).toHaveLength(1);
  });

  it('completes when a newer navigation supersedes the post-ack refresh, without re-posting', async () => {
    const { controller, live, fetch } = setup();
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', values: FALLBACKS, authority: savedAuthority(FALLBACKS) }));
    await controller.save();
    live.userNavigate('/asset-viewer?view=list');
    expect(controller.operation).toBeNull();
    expect(posts(fetch)).toHaveLength(1);
  });

  // F7 update: an answer echoing different values is not a consistent
  // acknowledgement of this request. The re-check shows the generation moved
  // past the one sent, so the request can no longer commit: the barrier is
  // released, but neither success nor failure is claimed (was: 'rejected').
  it('treats an acknowledgement for different values as uncertain and reconciles', async () => {
    const { controller, fetch } = setup();
    fetch
      .mockResolvedValueOnce(appAnswer(200, { status: 'success', values: { ...FALLBACKS, view: 'list' } }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority({ ...FALLBACKS, view: 'list' }, 'r2', 1) }));
    const result = await controller.save();
    expect(result.outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.saveOutcomeUnknown);
    expect(controller.operation).toMatchObject({ confirmed: false, unresolved: false });
    expect(posts(fetch)).toHaveLength(1);
    expect(reads(fetch)).toHaveLength(1);
  });

  it('reports a validation failure without refreshing, reconciling or updating saved metadata', async () => {
    const { controller, live, fetch } = setup();
    fetch.mockResolvedValueOnce(appAnswer(422, { status: 'error', errors: { tag: 'bad' } }));
    const result = await controller.save();
    expect(result).toMatchObject({ outcome: 'rejected', errors: { tag: 'bad' } });
    expect(controller.status).toEqual({ message: MESSAGES.invalid, kind: 'error' });
    expect(live.navigate).not.toHaveBeenCalled();
    expect(reads(fetch)).toHaveLength(0);
    expect(controller.savedMetadata().savedKeys).toEqual([]);
    expect(controller.saveBlockedReason()).toBeNull();
  });

  // F7 update: a 403 produced before the handler (CSRF middleware, or any
  // intermediary) carries no correlated answer, so it cannot prove the write
  // did not and will not happen (was: 'rejected' as CSRF). It is reconciled
  // by GET and the barrier stays while the generation is unchanged.
  it('does not treat an uncorrelated 403 as proof the Save was refused', async () => {
    const { controller, fetch } = setup();
    fetch
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' })
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: authority() }));
    expect((await controller.save()).outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.saveUnresolved);
    expect(controller.operation).toMatchObject({ unresolved: true });
    expect(reads(fetch)).toHaveLength(1);
  });

  it('reconciles a network failure against stored state without claiming failure or success', async () => {
    const { controller, live, fetch } = setup();
    fetch
      .mockRejectedValueOnce(new TypeError('offline'))
      // Stored state shows nothing saved yet — but the POST may still commit.
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: authority() }));
    const result = await controller.save();
    expect(result.outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.saveUnresolved);
    expect(controller.operation).toMatchObject({ confirmed: false, unresolved: true });
    expect(posts(fetch)).toHaveLength(1);
    expect(reads(fetch)[0][0]).toBe('/asset-viewer/defaults');
    expect(live.navigate).not.toHaveBeenCalled();
  });

  // F7 update: an unreadable 200 is not this handler's answer. Matching
  // stored values do not prove this request executed (F5), so it is never
  // confirmed from them (was: confirmed + refresh). The generation moved, so
  // the request is finished and the barrier is released without a claim.
  it('reconciles a malformed success answer without confirming it from stored values', async () => {
    const { controller, live, fetch } = setup();
    fetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } })
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(FALLBACKS, 'r2', 1) }));
    const result = await controller.save();
    expect(result.outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.saveOutcomeUnknown);
    expect(live.navigate).not.toHaveBeenCalled();
    expect(controller.savedMetadata().savedKeys).toEqual(FIELDS);
    expect(controller.operation).toMatchObject({ confirmed: false, unresolved: false });
    expect(posts(fetch)).toHaveLength(1);
  });

  // F7 update: an unreadable 200 is uncorrelated, so the write stays
  // unresolved (was: settled by the 200). A GET-only re-check that shows the
  // generation moved releases the barrier without claiming the save.
  it('keeps an uncertain outcome unresolved until a GET-only re-check shows the generation moved', async () => {
    const { controller, live, fetch } = setup();
    fetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => null })
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(FALLBACKS, 'r2', 1) }));
    expect((await controller.save()).outcome).toBe('uncertain');
    expect(controller.status).toEqual({ message: MESSAGES.saveUnresolved, kind: 'error' });
    expect(controller.operation).toMatchObject({ kind: 'save', phase: 'uncertain', confirmed: false, unresolved: true });
    expect(live.navigate).not.toHaveBeenCalled();

    expect(await controller.retryReconcile()).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.saveOutcomeUnknown);
    expect(controller.operation).toMatchObject({ confirmed: false, unresolved: false });
    expect(posts(fetch)).toHaveLength(1);
    expect(reads(fetch)).toHaveLength(2);
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it('never repeats a confirmed Save when its refresh fails; Retry is GET-only', async () => {
    const { controller, live, fetch } = setup();
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', values: FALLBACKS, authority: savedAuthority(FALLBACKS) }));
    await controller.save();
    live.fail();
    expect(controller.status).toEqual({ message: MESSAGES.savedRefreshFailed, kind: 'saved-refresh-error' });
    expect(controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
    expect(controller.savedMetadata().savedKeys).toEqual(FIELDS);
    expect(controller.saveBlockedReason()).toBe(MESSAGES.loadFailed);

    expect(controller.retryRefresh()).toBe('refreshing');
    expect(live.navigate).toHaveBeenCalledTimes(2);
    live.install();
    expect(controller.operation).toBeNull();
    expect(controller.status.message).toBe(MESSAGES.saved);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('lets the engine\'s own GET Retry recover a failed post-Save refresh', async () => {
    const { controller, live, fetch } = setup();
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', values: FALLBACKS, authority: savedAuthority(FALLBACKS) }));
    await controller.save();
    live.fail();
    live.engineRetry();
    live.install();
    expect(controller.operation).toBeNull();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('does not let an unrelated install complete a Save that is still posting', async () => {
    const { controller, live, fetch } = setup();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const saving = controller.save();
    live.userNavigate('/asset-viewer?sort=size');
    live.install();
    expect(controller.operation).toMatchObject({ phase: 'posting', confirmed: false });
    expect(controller.status.message).toBe(MESSAGES.saving);
    pending.resolve(appAnswer(500, { status: 'error', message: 'No changes were made.' }));
    expect((await saving).outcome).toBe('rejected');
  });
});

describe('WP9a Asset Library Reset filters lifecycle', () => {
  it('supersedes a pending filter GET with a GET-only Reset and restores installed presentation', async () => {
    const { controller, live, fetch, page } = setup();
    controller.setGridStyle('cropped');
    const older = live.userNavigate('/asset-viewer?sort=size');
    const reset = controller.resetFilters();
    expect(reset).toEqual({ outcome: 'started', generation: older + 1 });
    expect(live.navigate).toHaveBeenCalledWith(expect.anything(), '/asset-viewer?resetFilters=1', { historyMode: 'push' });
    expect(controller.saveBlockedReason()).toBe(MESSAGES.resetPending);
    // The saved Grid style is the installed one once Reset lands.
    page.authority = authority({ current: { view: 'list', gridStyle: 'uncropped', pageSize: '10' }, savedKeys: ['view', 'pageSize'], defaults: { view: 'list', pageSize: '10' } });
    live.install(reset.generation);
    expect(controller.filtersReset).toBeNull();
    expect(controller.currentGridStyle()).toBe('uncropped');
    expect(controller.currentValues()).toMatchObject({ view: 'list', pageSize: '10' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks Save after a failed Reset until a GET-only Retry installs authoritative results', async () => {
    const { controller, live, fetch } = setup();
    const reset = controller.resetFilters();
    live.fail(reset.generation);
    expect(controller.filtersReset).toMatchObject({ phase: 'failed' });
    expect(controller.saveBlockedReason()).toBe(MESSAGES.resetIncomplete);
    expect((await controller.save()).outcome).toBe('blocked');
    const retried = live.engineRetry();
    expect(controller.filtersReset).toEqual(expect.objectContaining({ phase: 'pending', generation: retried }));
    live.install(retried);
    expect(controller.filtersReset).toBeNull();
    expect(controller.saveBlockedReason()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets a newer explicit choice win over an older pending Reset', () => {
    const { controller, live, page } = setup();
    controller.resetFilters();
    const newer = live.userNavigate('/asset-viewer?view=list&search=newer');
    expect(controller.filtersReset).toBeNull();
    controller.setGridStyle('cropped');
    page.authority = authority({ current: { view: 'list' } });
    live.install(newer);
    expect(controller.currentValues()).toMatchObject({ view: 'list', gridStyle: 'cropped' });
  });

  it('treats a prepared Reset response that failed to install as incomplete', async () => {
    const { controller, live, page, fetch } = setup();
    const reset = controller.resetFilters();
    // The parsed response's authority may already be in the DOM, but the
    // install failed: only 'installed' counts.
    page.authority = authority({ current: { view: 'list' }, savedKeys: ['view'], defaults: { view: 'list' } });
    live.fail(reset.generation);
    expect(controller.currentValues()).toBeNull();
    expect((await controller.save()).outcome).toBe('blocked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when an installed Reset carries no valid authority, and recovers on a later authoritative install', async () => {
    const { controller, live, page } = setup();
    const reset = controller.resetFilters();
    page.authority = null;
    live.install(reset.generation);
    expect(controller.filtersReset).toMatchObject({ phase: 'incomplete' });
    expect(controller.saveBlockedReason()).toBe(MESSAGES.resetIncomplete);
    const next = live.userNavigate('/asset-viewer?search=again');
    page.authority = authority();
    live.install(next);
    expect(controller.filtersReset).toBeNull();
    expect(controller.saveBlockedReason()).toBeNull();
  });

  it('refuses Reset filters while a defaults POST is in flight', async () => {
    const { controller, live, fetch } = setup();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const saving = controller.save();
    expect(controller.resetFilters()).toEqual({ outcome: 'blocked' });
    expect(live.navigate).not.toHaveBeenCalled();
    pending.resolve(appAnswer(422, { status: 'error', errors: {} }));
    await saving;
  });
});

describe('WP9a Asset Library Reset defaults', () => {
  const resetAnswer = (refreshUrl = '/asset-viewer?project=3&project=7&type=comic&type=images&search=cat&usage=unused') => ({
    status: 'success',
    reset: { page: 'assetViewer', scope: 'global', changed: true, deletedOptions: ['view'] },
    refreshUrl,
    authority: (() => {
      const result = authority();
      delete result.current;
      return result;
    })(),
  });

  it('posts one CSRF-protected deletion and refreshes the authoritative destination', async () => {
    const { controller, live, fetch, page } = setup({ installed: authority({ savedKeys: ['view'], defaults: { view: 'list' } }) });
    controller.setGridStyle('cropped');
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const first = controller.resetDefaults();
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(controller.status.message).toBe(MESSAGES.resetDefaultsRunning);
    expect((await controller.save()).outcome).toBe('blocked');
    pending.resolve(appAnswer(200, resetAnswer()));
    expect((await first).outcome).toBe('refreshing');

    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/asset-viewer/defaults/reset');
    expect(options.body.get('_csrf')).toBe('token-1');
    expect(options.body.get('returnTo')).toBe('/asset-viewer?project=3&project=7&type=comic&type=images&search=cat&usage=unused');
    expect(options.body.get('defaultsGeneration')).toBe('0');
    expect(options.body.get('defaultsOperation')).toBe('op-1');
    expect(live.navigate.mock.calls[0][1]).toBe('/asset-viewer?project=3&project=7&type=comic&type=images&search=cat&usage=unused');
    expect(controller.savedMetadata().savedKeys).toEqual([]);
    expect(controller.currentGridStyle()).toBe('uncropped');
    page.authority = authority({ generation: 1 });
    live.install();
    expect(controller.status.message).toBe(MESSAGES.defaultsReset);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('never repeats the deletion when the refresh fails; recovery is GET-only', async () => {
    const { controller, live, fetch } = setup();
    fetch.mockResolvedValueOnce(appAnswer(200, resetAnswer()));
    await controller.resetDefaults();
    live.fail();
    expect(controller.status).toEqual({ message: MESSAGES.defaultsResetRefreshFailed, kind: 'saved-refresh-error' });
    expect(controller.retryRefresh()).toBe('refreshing');
    live.install();
    expect(controller.operation).toBeNull();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('refreshes the newest intention when the user navigated during the deletion POST', async () => {
    const { controller, live, fetch } = setup();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const resetting = controller.resetDefaults();
    controller.setGridStyle('cropped');
    live.userNavigate('/asset-viewer?view=list&sort=size');
    pending.resolve(appAnswer(200, resetAnswer()));
    await resetting;
    expect(live.navigate.mock.calls[0][1]).toBe(`${BASE}/asset-viewer?view=list&sort=size`);
    expect(controller.currentGridStyle()).toBe('cropped');
  });

  it('reconciles a committed answer without metadata and an uncertain outcome without deleting again', async () => {
    const { controller, live, fetch } = setup();
    fetch
      .mockResolvedValueOnce(appAnswer(500, { status: 'error', committed: true, refreshUrl: '/asset-viewer?search=cat' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: { ...resetAnswer().authority, generation: 1 } }));
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    expect(live.navigate.mock.calls[0][1]).toBe('/asset-viewer?search=cat');
    live.install();

    fetch
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(FALLBACKS, 'r2', 1) }));
    // Saved keys still exist, but the in-transit deletion may still commit.
    expect((await controller.resetDefaults()).outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.resetDefaultsUnresolved);
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(posts(fetch)).toHaveLength(2);
  });

  // F7 update: only the handler's correlated rollback answer proves the
  // deletion was refused. An uncorrelated 403 (was: 'rejected') is reconciled
  // and stays unresolved while the generation is unchanged.
  it('reports a correlated refused deletion without refreshing; an uncorrelated 403 stays unresolved', async () => {
    const { controller, live, fetch } = setup();
    fetch.mockResolvedValueOnce(appAnswer(500, { status: 'error', message: 'No changes were made.' }));
    expect((await controller.resetDefaults()).outcome).toBe('rejected');
    expect(controller.status.message).toBe(MESSAGES.defaultsNotReset);
    expect(reads(fetch)).toHaveLength(0);
    fetch
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' })
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: resetAuthority() }));
    expect((await controller.resetDefaults()).outcome).toBe('uncertain');
    expect(controller.operation).toMatchObject({ unresolved: true });
    expect(live.navigate).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(2);
  });
});

const NINE_SAVED = Object.freeze({
  view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '50',
  extension: ['png'], category: ['art'], presence: 'present', tag: ['4'],
});
const resetAuthority = () => {
  const result = authority();
  delete result.current;
  delete result.temporary;
  delete result.currentUrl;
  return result;
};

describe('WP9a F1 — an unresolved defaults write blocks every later defaults mutation', () => {
  // Save whose POST fails in transit and whose reconciliation read fails:
  // the request may still be committed later by the server.
  async function unresolvedSave(context) {
    const post = deferred();
    const check = deferred();
    context.fetch.mockReturnValueOnce(post.promise).mockReturnValueOnce(check.promise);
    const saving = context.controller.save();
    await flush();
    post.reject(new TypeError('connection reset'));
    await flush();
    expect(context.controller.operation).toMatchObject({ kind: 'save', phase: 'reconciling' });
    check.reject(new TypeError('offline'));
    return saving;
  }

  async function unresolvedReset(context) {
    const post = deferred();
    const check = deferred();
    context.fetch.mockReturnValueOnce(post.promise).mockReturnValueOnce(check.promise);
    const resetting = context.controller.resetDefaults();
    await flush();
    post.resolve({ ok: false, status: 504, json: async () => null });
    await flush();
    check.reject(new TypeError('offline'));
    return resetting;
  }

  it('an uncertain Save blocks Reset defaults and another Save before any POST', async () => {
    const context = setup({ installed: authority({ current: NINE_SAVED }) });
    const { controller, fetch, live } = context;
    expect((await unresolvedSave(context)).outcome).toBe('uncertain');
    expect(controller.status).toEqual({ message: MESSAGES.saveUnresolved, kind: 'error' });

    const reset = await controller.resetDefaults();
    expect(reset).toEqual({ outcome: 'blocked', reason: MESSAGES.saveUnresolved });
    const again = await controller.save();
    expect(again).toEqual({ outcome: 'blocked', reason: MESSAGES.saveUnresolved });
    expect(controller.saveBlockedReason()).toBe(MESSAGES.saveUnresolved);
    expect(posts(fetch).map(([url]) => url)).toEqual(['/asset-viewer/defaults']);
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it('an uncertain Reset defaults blocks Save and a second deletion before any POST', async () => {
    const context = setup({ installed: authority({ savedKeys: ['view'], defaults: { view: 'list' } }) });
    const { controller, fetch } = context;
    expect((await unresolvedReset(context)).outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.resetDefaultsUnresolved);

    expect(await controller.save()).toEqual({ outcome: 'blocked', reason: MESSAGES.resetDefaultsUnresolved });
    expect(await controller.resetDefaults()).toEqual({ outcome: 'blocked', reason: MESSAGES.resetDefaultsUnresolved });
    expect(posts(fetch).map(([url]) => url)).toEqual(['/asset-viewer/defaults/reset']);
  });

  it('read-only checks stay available, and a read of old state never releases the barrier', async () => {
    const context = setup();
    const { controller, fetch } = context;
    await unresolvedSave(context);

    // GET-only re-check: stored state still shows nothing saved. That does
    // not prove the earlier POST cannot still be committed.
    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: resetAuthority() }));
    expect(await controller.retryReconcile()).toBe('uncertain');
    expect(controller.operation).toMatchObject({ kind: 'save', phase: 'uncertain', confirmed: false });
    expect(controller.savedMetadata().savedKeys).toEqual([]);

    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: resetAuthority() }));
    await controller.refreshSavedMetadata();
    // Reset filters is GET-only navigation and stays available.
    expect(controller.resetFilters().outcome).toBe('started');

    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(posts(fetch)).toHaveLength(1);
    expect(reads(fetch)).toHaveLength(3);
  });

  it('an earlier Save cannot overwrite a later Reset: the Reset is never dispatched while the Save is unresolved', async () => {
    // A server-side store that applies POSTs in the order they arrive.
    const store = { saved: { ...NINE_SAVED } };
    const savePost = deferred();
    const fetch = vi.fn((url, options) => {
      if (options.method === 'GET') return Promise.reject(new TypeError('offline'));
      if (url === '/asset-viewer/defaults') return savePost.promise;
      store.saved = null; // Reset defaults deletes.
      return Promise.resolve(jsonResponse(200, { status: 'success', authority: resetAuthority() }));
    });
    const context = setup({ fetch, installed: authority({ current: NINE_SAVED }) });
    const saving = context.controller.save();
    await flush();
    // The Save's answer is lost; it is still queued on the server.
    savePost.reject(new TypeError('connection reset'));
    expect((await saving).outcome).toBe('uncertain');

    expect((await context.controller.resetDefaults()).outcome).toBe('blocked');
    // The earlier Save commits late; no later Reset was sent to be overwritten.
    store.saved = { ...NINE_SAVED };
    expect(posts(fetch).map(([url]) => url)).toEqual(['/asset-viewer/defaults']);
    expect(store.saved).toEqual(NINE_SAVED);
  });

  it('a received app answer settles the write: a rejected Save does not block a later Reset', async () => {
    const { controller, fetch } = setup();
    fetch.mockResolvedValueOnce(appAnswer(500, { status: 'error', message: 'No changes were made.' }));
    expect((await controller.save()).outcome).toBe('rejected');
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', refreshUrl: '/asset-viewer', authority: resetAuthority() }));
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    expect(posts(fetch)).toHaveLength(2);
  });
});

describe('WP9a F2 — a reconciled Reset defaults refreshes a post-deletion destination', () => {
  const obsolete = `${BASE}/asset-viewer?project=3&project=7&type=comic&type=images&search=cat&usage=unused&sort=size&pageSize=50&view=list`;

  it('reconstructs the refresh from the temporary context only, never the obsolete URL', async () => {
    const live = makeLive({ intendedUrl: obsolete });
    const { controller, fetch, page } = setup({
      live,
      installed: authority({
        savedKeys: ['view', 'sort', 'pageSize'], defaults: { view: 'list', sort: 'size', pageSize: '50' },
        current: { view: 'list', sort: 'size', pageSize: '50' },
      }),
    });
    fetch
      // F7 update: the deletion is confirmed by the handler's correlated
      // answer, which here carries neither refreshUrl nor metadata (an
      // unreadable 200 can no longer confirm anything).
      .mockResolvedValueOnce(appAnswer(200, { status: 'success' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: { ...resetAuthority(), generation: 1 } }));
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    await flush();

    expect(posts(fetch)).toHaveLength(1);
    expect(posts(fetch)[0][1].body.get('returnTo')).toBe(new URL(obsolete).pathname + new URL(obsolete).search);
    expect(live.navigate).toHaveBeenCalledTimes(1);
    const destination = new URL(live.navigate.mock.calls[0][1], BASE);
    expect(destination.pathname).toBe('/asset-viewer');
    expect(destination.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(destination.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(destination.searchParams.get('search')).toBe('cat');
    expect(destination.searchParams.get('usage')).toBe('unused');
    for (const stale of ['view', 'gridStyle', 'sort', 'order', 'pageSize', 'extension', 'category', 'presence', 'tag', 'page']) {
      expect(destination.searchParams.has(stale)).toBe(false);
    }
    expect(destination.search).not.toContain('%2C');

    // The refreshed page renders the application fallbacks.
    page.authority = authority({ generation: 1 });
    live.install();
    expect(controller.status.message).toBe(MESSAGES.defaultsReset);
    expect(controller.currentValues()).toMatchObject({ view: 'grid', sort: 'filename', pageSize: '25' });
    expect(controller.savedMetadata().savedKeys).toEqual([]);

    expect(posts(fetch)).toHaveLength(1);
  });

  it('a failed post-deletion refresh retries the reconstructed destination by GET only', async () => {
    const live = makeLive({ intendedUrl: obsolete });
    const { controller, fetch } = setup({ live });
    fetch
      .mockResolvedValueOnce(appAnswer(200, { status: 'success' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: { ...resetAuthority(), generation: 1 } }));
    await controller.resetDefaults();
    live.fail();
    expect(controller.retryRefresh()).toBe('refreshing');
    const retried = new URL(live.navigate.mock.calls[1][1], BASE);
    expect(retried.searchParams.has('view')).toBe(false);
    expect(retried.searchParams.has('sort')).toBe(false);
    expect(retried.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('keeps a newer user edit made while the deletion POST was pending', async () => {
    const live = makeLive({ intendedUrl: obsolete });
    const { controller, fetch } = setup({ live });
    const post = deferred();
    fetch
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: resetAuthority() }));
    const resetting = controller.resetDefaults();
    controller.setGridStyle('cropped');
    live.userNavigate('/asset-viewer?search=newer&view=list');
    live.install();
    post.resolve(appAnswer(200, { status: 'success' }));
    expect((await resetting).outcome).toBe('refreshing');
    expect(live.navigate.mock.calls[0][1]).toBe(`${BASE}/asset-viewer?search=newer&view=list`);
    expect(controller.currentGridStyle()).toBe('cropped');
    expect(posts(fetch)).toHaveLength(1);
  });
});

describe('WP9a F3 — a confirmed deletion stays confirmed when the follow-up read fails', () => {
  it('committed:true with a failing metadata GET keeps the confirmation and recovers by GET only', async () => {
    const live = makeLive();
    const { controller, fetch, page } = setup({
      live, installed: authority({ savedKeys: ['view'], defaults: { view: 'list' }, current: { view: 'list' } }),
    });
    fetch
      .mockResolvedValueOnce(appAnswer(500, { status: 'error', committed: true, refreshUrl: '/asset-viewer?search=cat' }))
      .mockRejectedValueOnce(new TypeError('offline'));
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    expect(controller.operation).toMatchObject({ kind: 'resetDefaults', confirmed: true });
    expect(controller.status.message).not.toBe(MESSAGES.defaultsResetUncertain);
    // Saved status is known to be out of date, not reported as still saved.
    expect(controller.savedMetadata()).toBeNull();

    live.fail();
    expect(controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
    expect(controller.status).toEqual({ message: MESSAGES.defaultsResetRefreshFailed, kind: 'saved-refresh-error' });
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect((await controller.save()).outcome).toBe('blocked');
    expect(posts(fetch)).toHaveLength(1);

    // GET-only recovery restores the fallback settings and saved status.
    expect(controller.retryRefresh()).toBe('refreshing');
    expect(live.navigate.mock.calls.at(-1)[1]).toBe('/asset-viewer?search=cat');
    // The acknowledged generation is known even though its metadata is not.
    expect(controller.generation).toBe(1);
    page.authority = authority({ generation: 1 });
    live.install();
    expect(controller.operation).toBeNull();
    expect(controller.status.message).toBe(MESSAGES.defaultsReset);
    expect(controller.savedMetadata().savedKeys).toEqual([]);
    expect(controller.currentValues().view).toBe('grid');
    expect(controller.saveBlockedReason()).toBeNull();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('a late stale read cannot reverse a committed deletion', async () => {
    const { controller, fetch } = setup({ installed: authority({ savedKeys: ['view'], defaults: { view: 'list' } }) });
    const stale = deferred();
    fetch.mockReturnValueOnce(stale.promise);
    const reread = controller.refreshSavedMetadata();
    fetch
      .mockResolvedValueOnce(appAnswer(500, { status: 'error', committed: true, refreshUrl: '/asset-viewer' }))
      .mockRejectedValueOnce(new TypeError('offline'));
    await controller.resetDefaults();
    stale.resolve(jsonResponse(200, { status: 'success', authority: savedAuthority({ ...FALLBACKS, view: 'list' }) }));
    await reread;
    expect(controller.operation).toMatchObject({ confirmed: true });
    expect(controller.savedMetadata()).toBeNull();
  });

  it('a normal successful deletion acknowledgement is unchanged', async () => {
    const { controller, fetch, live } = setup({ installed: authority({ savedKeys: ['view'], defaults: { view: 'list' } }) });
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', refreshUrl: '/asset-viewer?search=cat', authority: resetAuthority() }));
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    expect(controller.savedMetadata().savedKeys).toEqual([]);
    expect(reads(fetch)).toHaveLength(0);
    live.install();
    expect(controller.status.message).toBe(MESSAGES.defaultsReset);
  });
});

describe('WP9a F4 — metadata GETs are owned by the state when they start', () => {
  it('an older metadata GET cannot overwrite a newer Save acknowledgement', async () => {
    const { controller, fetch, live, page } = setup({ installed: authority({ current: NINE_SAVED }) });
    const older = deferred();
    fetch.mockReturnValueOnce(older.promise);
    const reread = controller.refreshSavedMetadata();
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', values: NINE_SAVED, authority: savedAuthority(NINE_SAVED, 'r-saved') }));
    await controller.save();
    page.authority = authority({ current: NINE_SAVED, savedKeys: FIELDS, defaults: NINE_SAVED, revision: 'r-saved', generation: 1 });
    live.install();
    expect(controller.status.message).toBe(MESSAGES.saved);
    older.resolve(jsonResponse(200, { status: 'success', authority: resetAuthority() }));
    await reread;
    expect(controller.savedMetadata().savedKeys).toEqual(FIELDS);
    expect(controller.savedMetadata().revision).toBe('r-saved');
    expect(controller.savedMetadata().defaults).toEqual(NINE_SAVED);
  });

  it('an older metadata GET cannot overwrite a newer Reset defaults acknowledgement', async () => {
    const { controller, fetch } = setup({ installed: authority({ savedKeys: FIELDS, defaults: NINE_SAVED }) });
    const older = deferred();
    fetch.mockReturnValueOnce(older.promise);
    const reread = controller.refreshSavedMetadata();
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', refreshUrl: '/asset-viewer', authority: { ...resetAuthority(), revision: 'r-reset' } }));
    await controller.resetDefaults();
    older.resolve(jsonResponse(200, { status: 'success', authority: savedAuthority(NINE_SAVED, 'r-old') }));
    await reread;
    expect(controller.savedMetadata().savedKeys).toEqual([]);
    expect(controller.savedMetadata().revision).toBe('r-reset');
  });

  it('two metadata GETs resolving in reverse order keep the newer answer', async () => {
    const { controller, fetch } = setup();
    const first = deferred();
    const second = deferred();
    fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = controller.refreshSavedMetadata();
    const b = controller.refreshSavedMetadata();
    second.resolve(jsonResponse(200, { status: 'success', authority: savedAuthority(NINE_SAVED, 'r-new') }));
    await b;
    first.resolve(jsonResponse(200, { status: 'success', authority: { ...resetAuthority(), revision: 'r-old' } }));
    await a;
    expect(controller.savedMetadata().revision).toBe('r-new');
    expect(controller.savedMetadata().savedKeys).toEqual(FIELDS);
    expect(controller.savedMetadata().defaults).toEqual(NINE_SAVED);
  });

  it('an older GET failing after a newer success changes nothing; a newer GET may update', async () => {
    const { controller, fetch } = setup();
    const first = deferred();
    fetch.mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(NINE_SAVED, 'r-2') }));
    const a = controller.refreshSavedMetadata();
    await controller.refreshSavedMetadata();
    first.reject(new TypeError('offline'));
    await expect(a).rejects.toThrow();
    expect(controller.savedMetadata().revision).toBe('r-2');

    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: { ...resetAuthority(), revision: 'r-3' } }));
    await controller.refreshSavedMetadata();
    expect(controller.savedMetadata().revision).toBe('r-3');
    expect(controller.savedMetadata().savedKeys).toEqual([]);
  });

  it('an older metadata GET cannot overwrite a newer installed page authority', async () => {
    const { controller, fetch, live, page } = setup();
    const older = deferred();
    fetch.mockReturnValueOnce(older.promise);
    const reread = controller.refreshSavedMetadata();
    const generation = live.userNavigate('/asset-viewer?sort=size');
    page.authority = authority({ savedKeys: FIELDS, defaults: NINE_SAVED, revision: 'r-page' });
    live.install(generation);
    older.resolve(jsonResponse(200, { status: 'success', authority: { ...resetAuthority(), revision: 'r-old' } }));
    await reread;
    expect(controller.savedMetadata().revision).toBe('r-page');
  });
});

describe('WP9a F5 — matching stored values are not proof that a POST executed', () => {
  it('a Save that never reached the server is not reported as confirmed when values already match', async () => {
    const stored = savedAuthority(NINE_SAVED, 'r-same');
    const { controller, fetch, live } = setup({
      installed: { ...authority({ current: NINE_SAVED, savedKeys: FIELDS, defaults: NINE_SAVED, revision: 'r-same' }) },
    });
    fetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: stored }));
    const result = await controller.save();
    expect(result.outcome).toBe('uncertain');
    expect(controller.operation).toMatchObject({ kind: 'save', confirmed: false, phase: 'uncertain' });
    expect(controller.status).toEqual({ message: MESSAGES.saveMatchesUnconfirmed, kind: 'error' });
    expect(controller.status.message).not.toBe(MESSAGES.saved);
    expect(live.navigate).not.toHaveBeenCalled();
    // The known stored state is reported; the matching values are visible.
    expect(controller.savedMetadata().revision).toBe('r-same');
    // Value equality does not enable a later mutation.
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect((await controller.save()).outcome).toBe('blocked');
    expect(posts(fetch)).toHaveLength(1);
  });
});

describe('WP9a saved metadata and opt-in boundary', () => {
  it('reopening recovers authoritative saved metadata and ignores installs that predate an acknowledgement', async () => {
    const { controller, live, fetch, page } = setup();
    const olderLoad = live.userNavigate('/asset-viewer?sort=size');
    // Wait for the load, then save after it installs.
    page.authority = authority({ current: { sort: 'size' } });
    live.install(olderLoad);
    fetch.mockResolvedValueOnce(appAnswer(200, {
      status: 'success', values: { ...FALLBACKS, sort: 'size' }, authority: savedAuthority({ ...FALLBACKS, sort: 'size' }),
    }));
    await controller.save();
    // An install from before the acknowledgement must not undo saved status.
    live.emit({ phase: 'installed', generation: olderLoad });
    expect(controller.savedMetadata().savedKeys).toEqual(FIELDS);

    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(FALLBACKS, 'r9', 1) }));
    const reread = await controller.refreshSavedMetadata();
    expect(reread.revision).toBe('r9');
    expect(controller.savedMetadata().revision).toBe('r9');
    expect(posts(fetch)).toHaveLength(1);
  });

  it('validates authority metadata strictly and compares multi values canonically', () => {
    expect(parseAssetLibraryDefaultsAuthority(authority(), { requireCurrent: true })).not.toBeNull();
    expect(parseAssetLibraryDefaultsAuthority('{not json')).toBeNull();
    expect(parseAssetLibraryDefaultsAuthority({ ...authority(), savedKeys: ['view'] })).toBeNull();
    expect(parseAssetLibraryDefaultsAuthority({ ...authority(), defaults: { ...FALLBACKS, tag: [] } })).toBeNull();
    expect(parseAssetLibraryDefaultsAuthority({ ...authority(), current: undefined }, { requireCurrent: true })).toBeNull();
    // WP9a F6: the durable generation is required authority.
    expect(parseAssetLibraryDefaultsAuthority({ ...authority(), generation: undefined })).toBeNull();
    expect(parseAssetLibraryDefaultsAuthority({ ...authority(), generation: -1 })).toBeNull();
    expect(parseAssetLibraryDefaultsAuthority({ ...authority(), generation: '3' })).toBeNull();
    expect(parseAssetLibraryDefaultsAuthority({ ...authority(), generation: 3 })).not.toBeNull();
    expect(sameAssetLibraryDefaultsValues(
      { ...FALLBACKS, tag: ['9', '4'], extension: 'all' },
      { ...FALLBACKS, tag: ['4', '9'], extension: [] },
    )).toBe(true);
    expect(sameAssetLibraryDefaultsValues(FALLBACKS, { ...FALLBACKS, view: 'list' })).toBe(false);
  });

  function makeDocument(formAttributes) {
    const listeners = {};
    const script = { textContent: JSON.stringify(authority()) };
    const csrf = { value: 'form-token' };
    const formListeners = {};
    const form = formAttributes === null ? null : {
      hasAttribute: (name) => formAttributes.includes(name),
      setAttribute: vi.fn(),
      querySelector: (selector) => (selector === 'input[name="_csrf"]' ? csrf : null),
      addEventListener: (type, handler) => { formListeners[type] = handler; },
    };
    return {
      document: {
        defaultView: { location: { href: `${BASE}/asset-viewer` } },
        querySelector: (selector) => {
          if (selector === '#asset-viewer-defaults-form') return form;
          if (selector.includes('data-asset-library-defaults-authority')) return script;
          return null;
        },
        addEventListener: (type, handler) => { listeners[type] = handler; },
      },
      formListeners,
      listeners,
    };
  }

  it('stays inert for the legacy autosave dialog and binds only an opted-in explicit-save form', async () => {
    expect(enhanceAssetLibraryFiltersDefaults(makeDocument(null).document)).toBeNull();
    expect(enhanceAssetLibraryFiltersDefaults(makeDocument(['data-asset-viewer-defaults-autosave']).document)).toBeNull();
    expect(enhanceAssetLibraryFiltersDefaults(makeDocument([
      'data-defaults-explicit-save', 'data-asset-viewer-defaults-autosave',
    ]).document)).toBeNull();

    const live = makeLive();
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      status: 'success', values: FALLBACKS, authority: savedAuthority(FALLBACKS),
    }));
    const { document, formListeners, listeners } = makeDocument(['data-defaults-explicit-save']);
    const controller = enhanceAssetLibraryFiltersDefaults(document, { live, fetch });
    expect(controller).not.toBeNull();
    expect(enhanceAssetLibraryFiltersDefaults(document, { live, fetch })).toBe(controller);
    expect(readAssetLibraryDefaultsAuthority(document)).toMatchObject({ page: 'assetViewer' });

    const submit = { preventDefault: vi.fn() };
    formListeners.submit(submit);
    formListeners.submit({ preventDefault: vi.fn() });
    await flush();
    expect(submit.preventDefault).toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
    expect(posts(fetch)[0][1].body.get('_csrf')).toBe('form-token');

    live.install();
    const resetClick = {
      target: { closest: (selector) => (selector === '[data-asset-library-filters-reset]' ? {} : null) },
      preventDefault: vi.fn(),
    };
    listeners.click(resetClick);
    expect(resetClick.preventDefault).toHaveBeenCalled();
    expect(live.navigate).toHaveBeenLastCalledWith(document, '/asset-viewer?resetFilters=1', { historyMode: 'push' });
  });
});

describe('WP9a F7 — only a request-correlated application answer settles a defaults write', () => {
  const GATEWAY_JSON = { status: 'error', message: 'Gateway timeout' };

  // Every case: a Save is POSTed, answered by `answer`, then reconciled by a
  // GET of `read` (the server's current authority) when it is not correlated.
  async function saveAnsweredBy(answer, read = jsonResponse(200, { status: 'success', authority: authority() })) {
    const context = setup({ installed: authority({ current: NINE_SAVED }) });
    const post = deferred();
    context.fetch.mockReturnValueOnce(post.promise);
    if (read) context.fetch.mockResolvedValueOnce(read);
    const saving = context.controller.save();
    await flush();
    post.resolve(answer);
    return { ...context, result: await saving };
  }

  it('A: the exact gateway 504 JSON reproduction no longer clears the unresolved barrier', async () => {
    const { controller, fetch, live, result } = await saveAnsweredBy(
      { ok: false, status: 504, json: async () => GATEWAY_JSON },
      // The reconciliation GET returns the old storage state.
      jsonResponse(200, { status: 'success', authority: resetAuthority() }),
    );
    expect(result.outcome).toBe('uncertain');
    expect(controller.operation).toMatchObject({ kind: 'save', confirmed: false, unresolved: true });
    expect(controller.status).toEqual({ message: MESSAGES.saveUnresolved, kind: 'error' });
    // Reset defaults is NOT accepted while the original Save may still run.
    expect(await controller.resetDefaults()).toEqual({ outcome: 'blocked', reason: MESSAGES.saveUnresolved });
    expect(await controller.save()).toEqual({ outcome: 'blocked', reason: MESSAGES.saveUnresolved });
    expect(posts(fetch).map(([url]) => url)).toEqual(['/asset-viewer/defaults']);
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it('B: a gateway 502 HTML page proves nothing about the write', async () => {
    const { controller, fetch, result } = await saveAnsweredBy({
      ok: false, status: 502, json: async () => { throw new SyntaxError('<html>Bad gateway</html>'); },
    });
    expect(result.outcome).toBe('uncertain');
    expect(controller.operation).toMatchObject({ unresolved: true });
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(posts(fetch)).toHaveLength(1);
  });

  it('C: successful-looking JSON without this operation identity is not a confirmation', async () => {
    const { controller, fetch, live, result } = await saveAnsweredBy(
      jsonResponse(200, { status: 'success', values: NINE_SAVED, authority: savedAuthority(NINE_SAVED, 'r2', 1) }),
    );
    expect(result.outcome).toBe('uncertain');
    expect(controller.status.message).not.toBe(MESSAGES.saved);
    expect(controller.operation).toMatchObject({ confirmed: false, unresolved: true });
    expect(live.navigate).not.toHaveBeenCalled();
    expect(reads(fetch)).toHaveLength(1);
  });

  it('D: an answer with another operation identity (or inconsistent status/generation) is not this answer', async () => {
    for (const answer of [
      appAnswer(200, { status: 'success', values: NINE_SAVED, authority: savedAuthority(NINE_SAVED) }, { id: 'op-other' }),
      appAnswer(200, { status: 'success', values: NINE_SAVED }, { kind: 'resetDefaults' }),
      appAnswer(200, { status: 'success', values: NINE_SAVED }, { expectedGeneration: 5 }),
      appAnswer(200, { status: 'success', values: NINE_SAVED }, { generation: 7 }),
      // A committed result relayed with a gateway status is inconsistent.
      appAnswer(504, { status: 'error', committed: true }, { result: 'committed' }),
      appAnswer(502, { status: 'error' }, { result: 'failed' }),
      appAnswer(200, { status: 'error' }, { result: 'conflict', generation: 1 }),
    ]) {
      const { controller, live, result } = await saveAnsweredBy(answer);
      expect(result.outcome).toBe('uncertain');
      expect(controller.operation).toMatchObject({ confirmed: false, unresolved: true });
      expect(live.navigate).not.toHaveBeenCalled();
    }
  });

  it('E: a correlated success is confirmed, adopts its generation, and the next write is based on it', async () => {
    const { controller, fetch, live, page } = setup({ installed: authority({ current: NINE_SAVED }) });
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', values: NINE_SAVED, authority: savedAuthority(NINE_SAVED) }));
    expect((await controller.save()).outcome).toBe('refreshing');
    expect(controller.operation).toMatchObject({ confirmed: true, expectedGeneration: 0 });
    expect(controller.generation).toBe(1);
    expect(controller.savedMetadata()).toMatchObject({ generation: 1, savedKeys: FIELDS });
    page.authority = authority({ current: NINE_SAVED, savedKeys: FIELDS, defaults: NINE_SAVED, generation: 1 });
    live.install();
    expect(controller.status.message).toBe(MESSAGES.saved);
    expect(reads(fetch)).toHaveLength(0);

    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', refreshUrl: '/asset-viewer', authority: resetAuthority() }));
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    expect(posts(fetch)[1][1].body.get('defaultsGeneration')).toBe('1');
    expect(posts(fetch)[1][1].body.get('defaultsOperation')).toBe('op-2');
    expect(controller.generation).toBe(2);
  });

  it('F: a correlated application rejection settles the write without refreshing or re-posting', async () => {
    const invalid = await saveAnsweredBy(appAnswer(422, { status: 'error', errors: { tag: 'gone' } }), null);
    expect(invalid.result).toMatchObject({ outcome: 'rejected', errors: { tag: 'gone' } });
    expect(invalid.controller.operation).toBeNull();
    expect(reads(invalid.fetch)).toHaveLength(0);

    const failed = await saveAnsweredBy(appAnswer(500, { status: 'error', message: 'No changes were made.' }), null);
    expect(failed.result.outcome).toBe('rejected');
    expect(failed.controller.status.message).toBe(MESSAGES.notSaved);
    // Settled: the next mutation may be sent, based on the unchanged generation.
    failed.fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', refreshUrl: '/asset-viewer', authority: resetAuthority() }));
    expect((await failed.controller.resetDefaults()).outcome).toBe('refreshing');
    expect(posts(failed.fetch).map(([, options]) => options.body.get('defaultsGeneration'))).toEqual(['0', '0']);
  });

  it('G: a correlated generation conflict writes nothing, keeps newer choices, and is never resent', async () => {
    const { controller, fetch, live } = setup({ installed: authority({ current: NINE_SAVED }) });
    controller.setGridStyle('uncropped');
    fetch.mockResolvedValueOnce(appAnswer(409, {
      status: 'error', code: 'DEFAULTS_GENERATION_CONFLICT', message: 'changed',
      authority: resetAuthority(),
    }, { generation: 3 }));
    expect((await controller.save()).outcome).toBe('conflict');
    expect(controller.status).toEqual({ message: MESSAGES.saveConflict, kind: 'error' });
    expect(controller.operation).toBeNull();
    // Current authority from the answer becomes the known metadata.
    expect(controller.generation).toBe(3);
    expect(controller.savedMetadata()).toMatchObject({ generation: 3, savedKeys: [] });
    // Newer choices are kept; nothing refreshes and nothing is resent.
    expect(controller.currentGridStyle()).toBe('uncropped');
    expect(live.navigate).not.toHaveBeenCalled();
    await flush();
    expect(posts(fetch)).toHaveLength(1);

    // Only an explicit new Save posts again, now based on generation 3.
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', values: { ...NINE_SAVED, gridStyle: 'uncropped' } }));
    expect((await controller.save()).outcome).toBe('refreshing');
    expect(posts(fetch)).toHaveLength(2);
    expect(posts(fetch)[1][1].body.get('defaultsGeneration')).toBe('3');
  });

  it('G: a conflict without readable authority recovers it by GET only', async () => {
    const { controller, fetch } = setup();
    fetch
      .mockResolvedValueOnce(appAnswer(409, { status: 'error', code: 'DEFAULTS_GENERATION_CONFLICT' }, { generation: 2 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: { ...resetAuthority(), generation: 2 } }));
    expect((await controller.resetDefaults()).outcome).toBe('conflict');
    expect(controller.status.message).toBe(MESSAGES.resetConflict);
    await flush();
    expect(reads(fetch)).toHaveLength(1);
    expect(controller.generation).toBe(2);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('H: a correlated committed:true answer stays confirmed even when the follow-up GET fails', async () => {
    const { controller, fetch } = setup({ installed: authority({ current: NINE_SAVED }) });
    fetch
      .mockResolvedValueOnce(appAnswer(500, { status: 'error', committed: true, message: 'read failed' }))
      .mockRejectedValueOnce(new TypeError('offline'));
    expect((await controller.save()).outcome).toBe('refreshing');
    await flush();
    expect(controller.operation).toMatchObject({ confirmed: true, unresolved: false });
    expect(controller.savedMetadata()).toBeNull();
    expect(controller.generation).toBe(1);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('I: an unreadable answer after the server committed is not claimed; the moved generation releases the barrier', async () => {
    const { controller, fetch, live, result } = await saveAnsweredBy(
      { ok: true, status: 200, json: async () => { throw new SyntaxError('truncated'); } },
      jsonResponse(200, { status: 'success', authority: savedAuthority(NINE_SAVED, 'r2', 1) }),
    );
    expect(result.outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.saveOutcomeUnknown);
    expect(controller.operation).toMatchObject({ confirmed: false, unresolved: false });
    expect(live.navigate).not.toHaveBeenCalled();
    // A later mutation is safe: it is fenced on the current generation.
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', refreshUrl: '/asset-viewer', authority: resetAuthority() }));
    expect((await controller.resetDefaults()).outcome).toBe('refreshing');
    expect(posts(fetch)[1][1].body.get('defaultsGeneration')).toBe('1');
  });

  it('J: a lost response keeps the barrier while the generation is unchanged and releases it only once it moves', async () => {
    const { controller, fetch } = setup({ installed: authority({ current: NINE_SAVED }) });
    fetch
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: authority() }));
    expect((await controller.save()).outcome).toBe('uncertain');
    expect(controller.operation).toMatchObject({ unresolved: true });

    // Still the same generation: the POST may still commit.
    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: authority() }));
    expect(await controller.retryReconcile()).toBe('uncertain');
    expect(controller.operation).toMatchObject({ unresolved: true });
    expect((await controller.resetDefaults()).outcome).toBe('blocked');

    // The server has since moved on (this POST or another write): the fence
    // now rejects the old request, so the barrier is released.
    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(NINE_SAVED, 'r3', 1) }));
    expect(await controller.retryReconcile()).toBe('uncertain');
    expect(controller.operation).toMatchObject({ unresolved: false, confirmed: false });
    expect(controller.status.message).toBe(MESSAGES.saveOutcomeUnknown);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('applies the same correlation rules to Reset defaults (504 JSON keeps the barrier)', async () => {
    const { controller, fetch } = setup({ installed: authority({ savedKeys: FIELDS, defaults: NINE_SAVED }) });
    fetch
      .mockResolvedValueOnce({ ok: false, status: 504, json: async () => GATEWAY_JSON })
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(NINE_SAVED) }));
    expect((await controller.resetDefaults()).outcome).toBe('uncertain');
    expect(controller.status.message).toBe(MESSAGES.resetDefaultsUnresolved);
    expect((await controller.save()).outcome).toBe('blocked');
    expect(posts(fetch)).toHaveLength(1);
  });
});

describe('WP9a F6 — client generation ownership', () => {
  it('a reloaded controller bases its mutation on the installed page generation', async () => {
    const { controller, fetch } = setup({ installed: authority({ generation: 41, savedKeys: FIELDS, defaults: NINE_SAVED }) });
    expect(controller.generation).toBe(41);
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', refreshUrl: '/asset-viewer', authority: resetAuthority() }));
    await controller.resetDefaults();
    expect(posts(fetch)[0][1].body.get('defaultsGeneration')).toBe('41');
    expect(controller.generation).toBe(42);
  });

  it('a metadata answer with an older generation never replaces a newer acknowledged one', async () => {
    const { controller, fetch } = setup({ installed: authority({ current: NINE_SAVED }) });
    fetch.mockResolvedValueOnce(appAnswer(200, { status: 'success', values: NINE_SAVED, authority: savedAuthority(NINE_SAVED) }));
    await controller.save();
    // A GET that STARTED after the acknowledgement but reports generation 0.
    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: resetAuthority() }));
    await controller.refreshSavedMetadata();
    expect(controller.generation).toBe(1);
    expect(controller.savedMetadata().savedKeys).toEqual(FIELDS);
    // A GET reporting a newer generation (another tab wrote) is adopted.
    fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: { ...resetAuthority(), generation: 2 } }));
    await controller.refreshSavedMetadata();
    expect(controller.generation).toBe(2);
    expect(controller.savedMetadata().savedKeys).toEqual([]);
  });

  it('refuses to mutate without a known generation instead of guessing one', async () => {
    const { controller, fetch } = setup({ installed: null });
    expect(controller.generation).toBeNull();
    expect((await controller.resetDefaults())).toEqual({ outcome: 'blocked', reason: MESSAGES.unreadable });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('every mutation carries a fresh operation identity', async () => {
    const { controller, fetch } = setup();
    fetch
      .mockResolvedValueOnce(appAnswer(500, { status: 'error' }))
      .mockResolvedValueOnce(appAnswer(500, { status: 'error' }));
    await controller.save();
    await controller.resetDefaults();
    const ids = posts(fetch).map(([, options]) => options.body.get('defaultsOperation'));
    expect(ids).toEqual(['op-1', 'op-2']);
  });
});

/*
 * WP9b — the combined Filters & Defaults dialog binding. A small fake DOM
 * stands in for the rendered dialog: the binding is presentation only, so
 * every assertion is about what it shows and what it never sends.
 */
function fakeElement(attrs = {}) {
  const attributes = new Map(Object.entries(attrs).map(([name, value]) => [name, String(value)]));
  return {
    hidden: attributes.has('hidden'),
    value: attrs.value ?? '',
    textContent: '',
    attributes,
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'hidden') this.hidden = true;
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
  };
}

function dialogDocument({ formAttributes = ['data-defaults-explicit-save'] } = {}) {
  const page = { authority: authority() };
  const listeners = {};
  const formListeners = {};
  const csrf = { value: 'form-token' };
  const form = Object.assign(fakeElement(Object.fromEntries(formAttributes.map((name) => [name, '']))), {
    querySelector: (selector) => (selector === 'input[name="_csrf"]' ? csrf : null),
    addEventListener: (type, handler) => { formListeners[type] = handler; },
  });
  const elements = {
    indicator: fakeElement(),
    gridControl: Object.assign(fakeElement({ 'data-asset-library-grid-style': '' }), {
      value: 'uncropped',
      matches: (selector) => selector === '[data-asset-library-grid-style]',
    }),
    grid: fakeElement({ 'data-grid-style': 'uncropped' }),
    save: fakeElement(),
    resetDefaults: fakeElement(),
    recovery: fakeElement({ hidden: '' }),
    retry: fakeElement({ hidden: '' }),
    check: fakeElement({ hidden: '' }),
  };
  const bySelector = {
    '#asset-viewer-defaults-form': form,
    '[data-asset-library-defaults-indicator]': elements.indicator,
    '[data-asset-library-grid-style]': elements.gridControl,
    '[data-asset-library-defaults-save]': elements.save,
    '[data-asset-library-defaults-reset]': elements.resetDefaults,
    '[data-asset-library-defaults-recovery]': elements.recovery,
    '[data-asset-library-defaults-retry]': elements.retry,
    '[data-asset-library-defaults-check]': elements.check,
  };
  const document = {
    defaultView: { location: { href: `${BASE}/asset-viewer` } },
    querySelector: (selector) => {
      if (selector.includes('data-asset-library-defaults-authority')) {
        return page.authority ? { textContent: JSON.stringify(page.authority) } : null;
      }
      return bySelector[selector] ?? null;
    },
    querySelectorAll: (selector) => (selector === '[data-asset-library-live-region] .asset-grid' ? [elements.grid] : []),
    addEventListener: (type, handler) => { (listeners[type] ||= []).push(handler); },
  };
  const dispatch = (type, event) => (listeners[type] || []).forEach((handler) => handler(event));
  const clickOn = (selector) => {
    const event = {
      target: { closest: (candidate) => (candidate === selector ? {} : null) },
      preventDefault: vi.fn(),
    };
    dispatch('click', event);
    return event;
  };
  return { document, page, form, formListeners, elements, dispatch, clickOn };
}

function bindingSetup(options = {}) {
  const harness = dialogDocument(options);
  const live = options.live ?? makeLive();
  const fetch = options.fetch ?? vi.fn();
  let operations = 0;
  const controller = enhanceAssetLibraryFiltersDefaults(harness.document, {
    live,
    fetch: (url, init) => Promise.resolve(fetch(url, init)).then((answer) => materialize(answer, url, init)),
    createOperationId: () => `op-${operations += 1}`,
  });
  return { ...harness, live, fetch, controller };
}

describe('WP9b saved-state indicator', () => {
  it('reports stored-key presence, so an explicitly saved fallback value still counts as saved', () => {
    const allStoredAtFallbacks = authority({ savedKeys: FIELDS });
    expect(describeAssetLibrarySavedState(allStoredAtFallbacks, { ...FALLBACKS })).toBe('Defaults saved.');
    expect(describeAssetLibrarySavedState(authority({ savedKeys: [] }), { ...FALLBACKS })).toBe('No saved defaults.');
    expect(describeAssetLibrarySavedState(authority({ savedKeys: ['gridStyle', 'tag'] }), { ...FALLBACKS }))
      .toBe('2 of 9 defaults saved.');
  });

  it('adds whether the current settings differ, against saved or application defaults', () => {
    expect(describeAssetLibrarySavedState(authority({ savedKeys: [] }), { ...FALLBACKS, view: 'list' }))
      .toBe('No saved defaults · Current settings differ from the application defaults.');
    expect(describeAssetLibrarySavedState(
      authority({ savedKeys: FIELDS, defaults: { view: 'list' } }),
      { ...FALLBACKS, view: 'list', tag: ['4', '9'] },
    )).toBe('Defaults saved · Current settings differ from the saved defaults.');
    expect(describeAssetLibrarySavedState(
      authority({ savedKeys: FIELDS, defaults: { tag: ['9', '4'] } }),
      { ...FALLBACKS, tag: ['4', '9'] },
    )).toBe('Defaults saved.');
  });

  it('never claims a saved state it does not know', () => {
    expect(describeAssetLibrarySavedState(null, FALLBACKS)).toBe(SAVED_STATE.checking);
    expect(describeAssetLibrarySavedState(null, FALLBACKS, { readFailed: true })).toBe(SAVED_STATE.unreadable);
  });
});

describe('WP9b combined dialog binding', () => {
  it('renders the indicator from the installed authority when bound', () => {
    const { elements } = bindingSetup();
    expect(elements.indicator.textContent).toBe('No saved defaults.');
  });

  it('applies a session Grid style to the installed grid without POSTing or navigating, and re-applies it after installs', async () => {
    const { elements, dispatch, controller, live, fetch, page } = bindingSetup();
    elements.gridControl.value = 'cropped';
    dispatch('change', { target: elements.gridControl });
    expect(controller.currentGridStyle()).toBe('cropped');
    expect(elements.grid.getAttribute('data-grid-style')).toBe('cropped');
    expect(elements.indicator.textContent).toBe('No saved defaults · Current settings differ from the application defaults.');

    // A filter edit re-renders the grid with the saved style; the session
    // choice is re-applied once that response is installed.
    live.userNavigate('/asset-viewer?sort=size');
    elements.grid.setAttribute('data-grid-style', 'uncropped');
    elements.gridControl.value = 'uncropped';
    page.authority = authority({ current: { sort: 'size' } });
    live.install();
    expect(elements.grid.getAttribute('data-grid-style')).toBe('cropped');
    expect(elements.gridControl.value).toBe('cropped');

    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it('Reset filters drops the session Grid style in favour of the installed saved style', () => {
    const { elements, dispatch, controller, live, page, clickOn } = bindingSetup();
    elements.gridControl.value = 'cropped';
    dispatch('change', { target: elements.gridControl });
    const click = clickOn('[data-asset-library-filters-reset]');
    expect(click.preventDefault).toHaveBeenCalled();
    expect(live.navigate).toHaveBeenLastCalledWith(expect.anything(), '/asset-viewer?resetFilters=1', { historyMode: 'push' });
    page.authority = authority({ current: { gridStyle: 'uncropped', view: 'list' }, savedKeys: ['view'], defaults: { view: 'list' } });
    live.install();
    expect(controller.currentGridStyle()).toBe('uncropped');
    expect(elements.grid.getAttribute('data-grid-style')).toBe('uncropped');
  });

  it('holds the defaults actions while a Save is posting and releases them on the answer', async () => {
    const pending = deferred();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise);
    const { formListeners, elements, form, controller } = bindingSetup({ fetch });
    formListeners.submit({ preventDefault: vi.fn() });
    await flush();
    expect(controller.operation.phase).toBe('posting');
    expect(elements.save.getAttribute('aria-disabled')).toBe('true');
    expect(elements.resetDefaults.getAttribute('aria-disabled')).toBe('true');
    expect(form.getAttribute('aria-busy')).toBe('true');

    pending.resolve(appAnswer(422, { status: 'error', errors: {} }));
    await flush();
    expect(controller.operation).toBeNull();
    expect(elements.save.getAttribute('aria-disabled')).toBeNull();
    expect(elements.resetDefaults.getAttribute('aria-disabled')).toBeNull();
    expect(form.getAttribute('aria-busy')).toBeNull();
  });

  // WP9b F2: Save is JavaScript-only. The server renders it disabled; only a
  // fully bound controller arms it and owns its activation.
  function disabledSaveHarness(options) {
    const harness = dialogDocument(options);
    harness.elements.save.setAttribute('disabled', '');
    harness.elements.save.disabled = true;
    return harness;
  }

  function enhanceHarness(harness, fetch) {
    let operations = 0;
    return enhanceAssetLibraryFiltersDefaults(harness.document, {
      live: makeLive(),
      fetch: (url, init) => Promise.resolve(fetch(url, init)).then((answer) => materialize(answer, url, init)),
      createOperationId: () => `op-${operations += 1}`,
    });
  }

  it('F2: arms the server-disabled Save once bound; a Save click posts one snapshot through the controller', async () => {
    const harness = disabledSaveHarness();
    const pending = deferred();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise);
    const controller = enhanceHarness(harness, fetch);
    expect(controller).not.toBeNull();
    expect(harness.elements.save.disabled).toBe(false);
    expect(harness.elements.save.hasAttribute('disabled')).toBe(false);

    const click = harness.clickOn('[data-asset-library-defaults-save]');
    expect(click.preventDefault).toHaveBeenCalled();
    await flush();
    expect(posts(fetch)).toHaveLength(1);
    expect(controller.operation.phase).toBe('posting');
    // A repeated activation while posting is refused by the controller.
    harness.clickOn('[data-asset-library-defaults-save]');
    await flush();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('F2: a form that is not opted in, or a binding failure, leaves Save disabled', () => {
    const notOptedIn = disabledSaveHarness({ formAttributes: [] });
    expect(enhanceHarness(notOptedIn, vi.fn())).toBeNull();
    expect(notOptedIn.elements.save.disabled).toBe(true);
    expect(notOptedIn.elements.save.hasAttribute('disabled')).toBe(true);

    const broken = disabledSaveHarness();
    broken.document.querySelectorAll = () => { throw new Error('initialization failure'); };
    const fetch = vi.fn();
    expect(() => enhanceHarness(broken, fetch)).toThrow('initialization failure');
    expect(broken.elements.save.disabled).toBe(true);
    expect(broken.elements.save.hasAttribute('disabled')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('F2: enhancing twice keeps one controller and one set of Save handlers', async () => {
    const harness = disabledSaveHarness();
    const fetch = vi.fn().mockReturnValue(deferred().promise);
    const first = enhanceHarness(harness, fetch);
    expect(enhanceHarness(harness, fetch)).toBe(first);
    harness.clickOn('[data-asset-library-defaults-save]');
    await flush();
    expect(posts(fetch)).toHaveLength(1);
  });

  // WP9b F3: Reset defaults follows the same fail-closed ownership.
  function disabledControlsHarness(options) {
    const harness = disabledSaveHarness(options);
    harness.elements.resetDefaults.setAttribute('disabled', '');
    harness.elements.resetDefaults.disabled = true;
    return harness;
  }

  it('F3: arms the server-disabled Reset defaults once bound; a click posts one controller-owned reset', async () => {
    const harness = disabledControlsHarness();
    const pending = deferred();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise);
    const controller = enhanceHarness(harness, fetch);
    expect(harness.elements.resetDefaults.disabled).toBe(false);
    expect(harness.elements.resetDefaults.hasAttribute('disabled')).toBe(false);

    const click = harness.clickOn('[data-asset-library-defaults-reset]');
    expect(click.preventDefault).toHaveBeenCalled();
    await flush();
    expect(posts(fetch)).toHaveLength(1);
    const [url, init] = posts(fetch)[0];
    expect(url).toBe('/asset-viewer/defaults/reset');
    const body = new URLSearchParams(init.body);
    expect(body.get('defaultsOperation')).toBe('op-1');
    expect(body.getAll('project')).toEqual([]);
    // The latest temporary context travels as returnTo, repeated keys intact.
    const returnTo = new URL(body.get('returnTo'), BASE);
    expect(returnTo.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(returnTo.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(returnTo.searchParams.get('search')).toBe('cat');
    expect(returnTo.searchParams.get('usage')).toBe('unused');
    expect(controller.operation.kind).toBe('resetDefaults');
    // A repeated activation while posting is refused.
    harness.clickOn('[data-asset-library-defaults-reset]');
    await flush();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('F3: a form that is not opted in, or a binding failure, leaves Reset defaults disabled', () => {
    const notOptedIn = disabledControlsHarness({ formAttributes: [] });
    expect(enhanceHarness(notOptedIn, vi.fn())).toBeNull();
    expect(notOptedIn.elements.resetDefaults.disabled).toBe(true);
    expect(notOptedIn.elements.resetDefaults.hasAttribute('disabled')).toBe(true);

    const broken = disabledControlsHarness();
    broken.document.querySelectorAll = () => { throw new Error('initialization failure'); };
    const fetch = vi.fn();
    expect(() => enhanceHarness(broken, fetch)).toThrow('initialization failure');
    expect(broken.elements.resetDefaults.disabled).toBe(true);
    expect(broken.elements.resetDefaults.hasAttribute('disabled')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('F3: enhancing twice keeps one Reset defaults owner', async () => {
    const harness = disabledControlsHarness();
    const fetch = vi.fn().mockReturnValue(deferred().promise);
    const first = enhanceHarness(harness, fetch);
    expect(enhanceHarness(harness, fetch)).toBe(first);
    harness.clickOn('[data-asset-library-defaults-reset]');
    await flush();
    expect(posts(fetch)).toHaveLength(1);
  });

  it('a Reset filters click while a defaults POST is in flight is refused without a native GET', async () => {
    const pending = deferred();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise);
    const { formListeners, clickOn, live } = bindingSetup({ fetch });
    formListeners.submit({ preventDefault: vi.fn() });
    await flush();
    const click = clickOn('[data-asset-library-filters-reset]');
    expect(click.preventDefault).toHaveBeenCalled();
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it('offers a GET-only Check again for an uncertain outcome, never another POST', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: authority() }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: authority({ generation: 1 }) }));
    const { formListeners, elements, clickOn, controller } = bindingSetup({ fetch });
    formListeners.submit({ preventDefault: vi.fn() });
    await flush();
    expect(controller.operation.phase).toBe('uncertain');
    expect(elements.check.hidden).toBe(false);
    expect(elements.recovery.hidden).toBe(false);
    expect(elements.retry.hidden).toBe(true);

    const click = clickOn('[data-asset-library-defaults-check]');
    expect(click.preventDefault).toHaveBeenCalled();
    await flush();
    expect(posts(fetch)).toHaveLength(1);
    expect(reads(fetch)).toHaveLength(2);
  });

  it('offers a GET-only Retry when a confirmed Save could not start its refresh', async () => {
    const live = makeLive();
    const fetch = vi.fn().mockResolvedValueOnce(appAnswer(200, {
      status: 'success', values: FALLBACKS, authority: savedAuthority(FALLBACKS),
    }));
    live.navigate.mockReturnValueOnce({ status: 'unavailable' });
    const { formListeners, elements, clickOn, controller } = bindingSetup({ live, fetch });
    formListeners.submit({ preventDefault: vi.fn() });
    await flush();
    expect(controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
    expect(elements.retry.hidden).toBe(false);
    expect(elements.check.hidden).toBe(true);
    expect(elements.indicator.textContent).toBe('Defaults saved.');

    clickOn('[data-asset-library-defaults-retry]');
    expect(controller.operation.phase).toBe('refreshing');
    expect(elements.retry.hidden).toBe(true);
    expect(posts(fetch)).toHaveLength(1);
    expect(live.navigate).toHaveBeenCalledTimes(2);
  });

  it('re-reads saved metadata by GET when the dialog is opened, and says so when it cannot', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: 'success', authority: savedAuthority(FALLBACKS, 'r9', 3) }))
      .mockResolvedValueOnce(jsonResponse(500, { status: 'error' }));
    const { clickOn, elements, controller } = bindingSetup({ fetch });
    clickOn('[data-dialog-open="asset-viewer-filter-dialog"]');
    await flush();
    expect(reads(fetch)).toHaveLength(1);
    expect(controller.generation).toBe(3);
    expect(elements.indicator.textContent).toBe('Defaults saved.');

    clickOn('[data-dialog-open="asset-viewer-filter-dialog"]');
    await flush();
    // The newer known metadata stays; the failed read changes nothing shown.
    expect(elements.indicator.textContent).toBe('Defaults saved.');
    expect(posts(fetch)).toHaveLength(0);
  });

  it('shows the read failure only when no saved metadata is known', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(500, { status: 'error' }));
    const harness = dialogDocument();
    harness.page.authority = null;
    const controller = enhanceAssetLibraryFiltersDefaults(harness.document, { live: makeLive(), fetch });
    expect(harness.elements.indicator.textContent).toBe(SAVED_STATE.checking);
    harness.clickOn('[data-dialog-open="asset-viewer-filter-dialog"]');
    await flush();
    expect(controller.savedMetadata()).toBeNull();
    expect(harness.elements.indicator.textContent).toBe(SAVED_STATE.unreadable);
  });
});
