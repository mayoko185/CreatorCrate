import { describe, expect, it, vi } from 'vitest';
import {
  PROJECTS_DEFAULTS_MESSAGES as MESSAGES,
  PROJECTS_SAVED_STATE_MESSAGES as SAVED_STATE,
  createProjectsFiltersDefaults,
  describeProjectsSavedState,
  enhanceProjectsFiltersDefaults,
  parseProjectsDefaultsAuthority,
  projectsResetDefaultsDestination,
  sameProjectsDefaultsValues,
} from '../src/static/client/projects-filters-defaults.js';
import { parseAssetLibraryDefaultsAuthority } from '../src/static/client/asset-library-filters-defaults.js';

/*
 * WP10b: the Projects config of the shared explicit defaults core
 * (explicit-page-defaults.js). The core's lifecycle rules are covered in
 * depth by asset-library-filters-defaults-client.test.js; these tests pin the
 * Projects contract: seven saveable settings, Search and Projects never
 * saved, the Projects endpoints and generation, the temporary context Reset
 * defaults keeps, and the fail-closed arming of Save / Reset defaults.
 */

const FIELDS = ['view', 'gridStyle', 'sort', 'order', 'status', 'projectType', 'tag'];
const FALLBACKS = Object.freeze({
  view: 'grid', gridStyle: 'uncropped', sort: 'created', order: 'desc',
  status: 'all', projectType: 'all', tag: 'all',
});
const BASE = 'http://creatorcrate.test';

function authority({ current = {}, defaults = {}, savedKeys = [], generation = 0, currentUrl } = {}) {
  const saved = Object.fromEntries(FIELDS.map((field) => [
    field, { stored: savedKeys.includes(field), valid: savedKeys.includes(field) },
  ]));
  return {
    page: 'projects',
    fields: [...FIELDS],
    multiFields: ['status', 'projectType', 'tag'],
    fallbacks: { ...FALLBACKS },
    defaults: { ...FALLBACKS, ...defaults },
    saved,
    savedKeys: FIELDS.filter((field) => savedKeys.includes(field)),
    hasSavedDefaults: savedKeys.length > 0,
    generation,
    revision: 'r1',
    resetFiltersUrl: '/projects',
    current: { ...FALLBACKS, ...current },
    currentUrl: currentUrl ?? '/projects?search=needle&project=7&project=12&status=ready&status=planned',
  };
}

function makeLive({ intendedUrl = `${BASE}/projects?search=needle&project=7&project=12&status=ready&status=planned` } = {}) {
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

function setup({ installed = authority(), live = makeLive(), answer } = {}) {
  const page = { authority: installed };
  const statuses = [];
  let operations = 0;
  const fetch = vi.fn((url, options) => Promise.resolve(answer?.(url, options)));
  const controller = createProjectsFiltersDefaults({ defaultView: { location: { href: `${BASE}/projects` } } }, {
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

describe('WP10b Projects explicit defaults config', () => {
  it('accepts only complete Projects authority (never another page\'s)', () => {
    const valid = authority();
    expect(parseProjectsDefaultsAuthority(valid, { requireCurrent: true })).toEqual(valid);
    expect(parseProjectsDefaultsAuthority({ ...valid, page: 'assetViewer' })).toBeNull();
    expect(parseAssetLibraryDefaultsAuthority(valid)).toBeNull();
    expect(parseProjectsDefaultsAuthority({ ...valid, current: { ...valid.current, status: [] } }, { requireCurrent: true }))
      .toBeNull();
    const { generation, ...withoutGeneration } = valid;
    expect(generation).toBe(0);
    expect(parseProjectsDefaultsAuthority(withoutGeneration)).toBeNull();
    expect(parseProjectsDefaultsAuthority({ ...valid, savedKeys: ['view'] })).toBeNull();
  });

  it('ordinary edits, Grid style choices and installs never POST defaults', async () => {
    const { controller, live, fetch } = setup();
    live.start('/projects?status=ready', 'push');
    live.install();
    controller.setGridStyle('cropped');
    live.start('/projects?view=list', 'push');
    live.fail();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(live.navigate).not.toHaveBeenCalled();
  });

  it('Save posts exactly the seven settings once, repeated, without Search or Projects', async () => {
    const installed = authority({
      current: { view: 'list', sort: 'title', order: 'asc', status: ['ready', 'planned'], projectType: ['comic'], tag: ['4', '9'] },
      generation: 3,
    });
    const expected = { ...installed.current, gridStyle: 'cropped' };
    const { controller, fetch, live, statuses } = setup({
      installed,
      answer: (url, options) => appAnswer(url, options, 200, {
        status: 'success',
        values: expected,
        authority: { ...authority({ defaults: expected, savedKeys: FIELDS, generation: 4 }) },
      }, 'committed'),
    });
    controller.setGridStyle('cropped');
    const pending = controller.save();
    // A duplicate Save while the first is in flight sends nothing.
    await controller.save();
    const result = await pending;

    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/projects/defaults');
    const body = options.body;
    expect(body.getAll('status')).toEqual(['ready', 'planned']);
    expect(body.getAll('tag')).toEqual(['4', '9']);
    expect(body.getAll('projectType')).toEqual(['comic']);
    expect(body.get('gridStyle')).toBe('cropped');
    expect(body.get('defaultsGeneration')).toBe('3');
    expect(body.get('defaultsOperation')).toBe('op-1');
    expect(body.get('_csrf')).toBe('token-1');
    expect(body.has('search')).toBe(false);
    expect(body.has('project')).toBe(false);
    expect([...new Set([...body.keys()])].sort()).toEqual(
      ['_csrf', 'defaultsGeneration', 'defaultsOperation', 'returnTo', ...FIELDS].sort(),
    );
    expect(result.outcome).toBe('refreshing');
    // The GET-only refresh keeps the current (temporary) intent.
    expect(live.navigate).toHaveBeenCalledTimes(1);
    expect(new URL(live.navigate.mock.calls[0][1]).searchParams.getAll('project')).toEqual(['7', '12']);
    live.install();
    expect(controller.status).toEqual({ message: MESSAGES.saved, kind: 'saved' });
    expect(statuses.map((entry) => entry.message)).toContain(MESSAGES.saving);
  });

  it('refuses Save while results are pending, failed, or a Reset filters is unfinished', async () => {
    const { controller, live, fetch } = setup();
    live.start('/projects?search=ne', 'push');
    expect((await controller.save()).reason).toBe(MESSAGES.loading);
    live.fail();
    expect((await controller.save()).reason).toBe(MESSAGES.loadFailed);
    live.install();
    expect(controller.resetFilters().outcome).toBe('started');
    expect(live.navigate.mock.calls.at(-1)[1]).toBe('/projects');
    expect((await controller.save()).reason).toBe(MESSAGES.resetPending);
    live.fail();
    expect((await controller.save()).reason).toBe(MESSAGES.resetIncomplete);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Reset defaults posts once to the Projects reset route and refreshes the temporary context', async () => {
    const { controller, fetch, live } = setup({
      installed: authority({ savedKeys: ['view', 'sort'], generation: 5 }),
      answer: (url, options) => appAnswer(url, options, 200, {
        status: 'success',
        refreshUrl: '/projects?project=7&project=12&search=needle',
        authority: authority({ generation: 6 }),
      }, 'committed'),
    });
    controller.setGridStyle('cropped');
    const result = await controller.resetDefaults();

    expect(posts(fetch)).toHaveLength(1);
    const [url, options] = posts(fetch)[0];
    expect(url).toBe('/projects/defaults/reset');
    expect(options.body.get('defaultsGeneration')).toBe('5');
    expect(options.body.get('returnTo')).toBe('/projects?search=needle&project=7&project=12&status=ready&status=planned');
    expect(FIELDS.some((field) => options.body.has(field))).toBe(false);
    expect(result.outcome).toBe('refreshing');
    expect(live.navigate.mock.calls[0][1]).toBe('/projects?project=7&project=12&search=needle');
    expect(controller.currentGridStyle()).not.toBe('cropped');
  });

  it('never repeats a confirmed Reset defaults when its refresh fails; recovery is GET-only', async () => {
    const { controller, fetch, live } = setup({
      answer: (url, options) => appAnswer(url, options, 200, {
        status: 'success', refreshUrl: '/projects?project=7', authority: authority({ generation: 1 }),
      }, 'committed'),
    });
    await controller.resetDefaults();
    live.fail();
    expect(controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
    expect((await controller.resetDefaults()).outcome).toBe('blocked');
    expect(controller.retryRefresh()).toBe('refreshing');
    expect(live.navigate.mock.calls.at(-1)[1]).toBe('/projects?project=7');
    expect(posts(fetch)).toHaveLength(1);
  });

  it('builds the Reset defaults fallback destination from repeated Projects and Search only', () => {
    expect(projectsResetDefaultsDestination(
      '/projects?status=ready&project=12&project=7&search=%20needle%20&view=list&sort=title&page=3&project=all',
      BASE,
    )).toBe('/projects?project=12&project=7&search=needle');
    expect(projectsResetDefaultsDestination('/projects?status=ready', BASE)).toBe('/projects');
  });

  it('describes saved state from stored keys, never from value equality', () => {
    expect(describeProjectsSavedState(null, null)).toBe(SAVED_STATE.checking);
    expect(describeProjectsSavedState(null, null, { readFailed: true })).toBe(SAVED_STATE.unreadable);
    const none = authority();
    expect(describeProjectsSavedState(none, none.current)).toBe('No saved defaults.');
    const fallbackEqual = authority({ savedKeys: ['view', 'order'] });
    expect(describeProjectsSavedState(fallbackEqual, fallbackEqual.current)).toBe('2 of 7 defaults saved.');
    const all = authority({ savedKeys: FIELDS });
    expect(describeProjectsSavedState(all, { ...all.current, view: 'list' }))
      .toBe('Defaults saved · Current settings differ from the saved defaults.');
    expect(describeProjectsSavedState(none, { ...none.current, status: ['ready'] }))
      .toBe('No saved defaults · Current settings differ from the application defaults.');
    expect(sameProjectsDefaultsValues(
      { ...FALLBACKS, status: ['planned', 'ready'] },
      { ...FALLBACKS, status: ['ready', 'planned'] },
    )).toBe(true);
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
    defaultView: { location: { href: `${BASE}/projects` } },
    documentListeners,
    querySelector(selector) {
      if (selector === '#projects-defaults-form') return form;
      if (selector === '[data-projects-defaults-save]') return save;
      if (selector === '[data-projects-defaults-reset]') return reset;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      (documentListeners[type] ||= []).push(handler);
    },
  };
}

describe('WP10b Projects Save / Reset defaults initialization safety', () => {
  const live = () => ({ snapshot: () => null, navigate: vi.fn(), subscribe: () => () => {} });

  it('arms Save and Reset defaults only once the controller owns them, exactly once per document', () => {
    const form = makeElement({ id: 'projects-defaults-form', 'data-defaults-explicit-save': '' });
    const save = makeElement({ disabled: '' });
    const reset = makeElement({ disabled: '' });
    const document = makeDocument({ form, save, reset });

    const controller = enhanceProjectsFiltersDefaults(document, { live: live(), fetch: vi.fn() });
    expect(controller).not.toBeNull();
    expect(save.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
    // Re-enhancing (for example after reopening) never adds handlers twice.
    const clicks = document.documentListeners.click.length;
    expect(enhanceProjectsFiltersDefaults(document, { live: live(), fetch: vi.fn() })).toBe(controller);
    expect(document.documentListeners.click).toHaveLength(clicks);
    // An implicit or programmatic form submission never submits natively.
    const event = { preventDefault: vi.fn() };
    form.listeners.submit[0](event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('stays inert for a legacy autosave form or a missing opt-in', () => {
    for (const attributes of [
      { 'data-defaults-explicit-save': '', 'data-projects-defaults-autosave': '' },
      {},
    ]) {
      const form = makeElement(attributes);
      const save = makeElement({ disabled: '' });
      const reset = makeElement({ disabled: '' });
      const document = makeDocument({ form, save, reset });
      expect(enhanceProjectsFiltersDefaults(document, { live: live(), fetch: vi.fn() })).toBeNull();
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
    expect(() => enhanceProjectsFiltersDefaults(document, { live: live(), fetch: vi.fn() })).toThrow();
    expect(save.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
  });
});
