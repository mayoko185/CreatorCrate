import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP11C-F2: a Defaults preference save's answer is offered to the page
// (a bubbling, cancelable event on its region) before its render replaces the
// region, so a page that knows the render is older than what it shows can
// keep it out. The generic fetch save and the dropdowns are stand-ins; the
// whole path against the real server is covered in Chromium
// (tests/browser/settings-category-delete.spec.js, F2-B*).

const saves = vi.hoisted(() => ({ options: [], bound: 0 }));
vi.mock('../src/static/client/settings-fetch-save.js', () => ({
  captureRegionFocus: () => null,
  restoreRegionFocus: () => false,
  enhanceSettingsFetchSave: (form, options) => { saves.options.push({ form, options }); saves.bound += 1; return 1; },
}));
const dropdowns = vi.hoisted(() => ({ enhanced: 0 }));
vi.mock('../src/static/client/dropdowns.js', () => ({ enhanceDropdowns: () => { dropdowns.enhanced += 1; } }));

const {
  ASSET_CATEGORY_PREFERENCE_ANSWER_EVENT: EVENT,
  ASSET_CATEGORY_PREFERENCE_SETTLED_EVENT: SETTLED,
  enhanceAssetCategoryPreferencesFetchSave,
} = await import('../src/static/client/settings-asset-category-preferences-fetch-save.js');

const REGION = 'data-settings-asset-category-preference';

// A small element shim on Node's own EventTarget: enough for the module's
// region lookups, replacement and event dispatch.
class El extends EventTarget {
  constructor(tag, attributes = {}, children = []) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    children.forEach((child) => this.append(child));
  }

  get ownerDocument() { let node = this; while (node.parentNode) node = node.parentNode; return node.document || null; }
  get dataset() { return {}; }
  append(child) { child.parentNode = this; this.children.push(child); return child; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  matches(selector) {
    if (selector === 'form') return this.tagName === 'FORM';
    if (selector === 'select') return this.tagName === 'SELECT';
    const match = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    return Boolean(match) && this.hasAttribute(match[1])
      && (match[2] === undefined || this.getAttribute(match[1]) === match[2]);
  }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+/);
    if (parts.length === 2) {
      return this.descendants().filter((node) => node.matches(parts[1]) && node.parentNode && closestFrom(node.parentNode, parts[0]) && this.contains(closestFrom(node.parentNode, parts[0])));
    }
    return this.descendants().filter((node) => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return closestFrom(this, selector); }
  replaceWith(next) {
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1, next);
    next.parentNode = parent;
    this.parentNode = null;
  }
}

function closestFrom(node, selector) {
  for (let n = node; n instanceof El; n = n.parentNode) if (n.matches(selector)) return n;
  return null;
}

function preference(identity, version, stored) {
  const status = new El('div', { 'data-settings-fetch-save-status': '' });
  const form = new El('form', { action: `/settings/asset-categories/${identity}` }, [status]);
  return new El('div', { [REGION]: identity, 'data-settings-asset-category-preference-stored': stored, 'data-version': version }, [form]);
}

function page(version, stored = { 'browser-default': 'final', 'preview-category': 'disabled' }) {
  const root = new El('main', {}, [
    preference('browser-default', version, stored['browser-default']),
    preference('preview-category', version, stored['preview-category']),
  ]);
  return root;
}

function setup() {
  const renders = new Map();
  const window = {
    CustomEvent,
    DOMParser: class {
      parseFromString(html) {
        const parsed = renders.get(html);
        return { querySelectorAll: (selector) => parsed.querySelectorAll(selector) };
      }
    },
  };
  const document = { defaultView: window, activeElement: null };
  const root = page('initial');
  root.document = document;
  const region = (identity) => root.children.find((node) => node.getAttribute(REGION) === identity);
  saves.options.length = 0;
  enhanceAssetCategoryPreferencesFetchSave(root);
  const optionsFor = (identity) => saves.options.find(({ form }) => form === region(identity).querySelector('form')).options;
  const render = (name, stored) => { renders.set(name, page(name, stored)); return name; };
  // Node's EventTarget does not bubble through this shim, so a page listener
  // is put on both regions (the module dispatches with bubbles: true).
  const listen = (handler) => ['browser-default', 'preview-category'].forEach((identity) => region(identity).addEventListener(EVENT, handler));
  return { root, region, optionsFor, render, renders, listen };
}

beforeEach(() => {
  saves.options.length = 0;
  saves.bound = 0;
  dropdowns.enhanced = 0;
});

describe('WP11C-F2 — preference answers are offered to the page before they install', () => {
  it('F2-C7 — an accepted saved answer installs its own region with "Settings saved." and is told what it saved', () => {
    const t = setup();
    const events = [];
    t.listen((event) => events.push({ ...event.detail, bubbles: event.bubbles, cancelable: event.cancelable }));
    const form = t.region('preview-category').querySelector('form');
    const html = t.render('answer', { 'browser-default': 'final', 'preview-category': 'exports' });
    t.optionsFor('preview-category').onSuccess({ form, html, payload: 'previewCategory=exports' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'saved', payload: 'previewCategory=exports', form, bubbles: true, cancelable: true });
    expect(events[0].region.getAttribute('data-version')).toBe('initial');
    expect(events[0].next.getAttribute(REGION)).toBe('preview-category');
    expect(events[0].next.getAttribute('data-version')).toBe('answer');
    const installed = t.region('preview-category');
    expect(installed.getAttribute('data-version')).toBe('answer');
    expect(installed.getAttribute('data-settings-asset-category-preference-stored')).toBe('exports');
    expect(installed.querySelector('[data-settings-fetch-save-status]').textContent).toBe('Settings saved.');
    // F2-C13: the other setting is not touched.
    expect(t.region('browser-default').getAttribute('data-version')).toBe('initial');
    expect(dropdowns.enhanced).toBe(1);
  });

  it('F2-C1 / C6 — a cancelled answer installs nothing: the region, its stored value and its status stay', () => {
    const t = setup();
    t.listen((event) => event.preventDefault());
    const before = t.region('browser-default');
    const form = before.querySelector('form');
    form.querySelector('[data-settings-fetch-save-status]').textContent = 'Settings saved.';
    const bound = saves.bound;
    t.optionsFor('browser-default').onSuccess({ form, html: t.render('old', { 'browser-default': 'sketches' }), payload: 'defaultCategory=sketches' });
    expect(t.region('browser-default')).toBe(before);
    expect(before.getAttribute('data-settings-asset-category-preference-stored')).toBe('final');
    expect(dropdowns.enhanced).toBe(0);
    expect(saves.bound).toBe(bound);
  });

  it('F2-C8 — a refusal is offered as "refused"; cancelled, it installs nothing; accepted, it installs the server\'s refusal', () => {
    const t = setup();
    let cancel = true;
    const kinds = [];
    t.listen((event) => { kinds.push(event.detail.kind); if (cancel) event.preventDefault(); });
    const form = t.region('preview-category').querySelector('form');
    t.optionsFor('preview-category').onValidationError({ form, html: t.render('refused-old'), payload: 'previewCategory=sketches' });
    expect(t.region('preview-category').getAttribute('data-version')).toBe('initial');
    cancel = false;
    t.optionsFor('preview-category').onValidationError({ form, html: t.render('refused-new'), payload: 'previewCategory=sketches' });
    expect(t.region('preview-category').getAttribute('data-version')).toBe('refused-new');
    expect(kinds).toEqual(['refused', 'refused']);
  });

  it('F2-C9 / C14 — a superseded or unreadable answer is never offered and installs nothing', () => {
    const t = setup();
    const events = [];
    t.listen((event) => events.push(event));
    const form = t.region('browser-default').querySelector('form');
    t.optionsFor('browser-default').onSuccess({ form, html: t.render('superseded'), payload: 'x', superseded: true });
    t.optionsFor('browser-default').onValidationError({ form, html: t.render('superseded-refusal'), payload: 'x', superseded: true });
    t.optionsFor('browser-default').onSuccess({ form, html: '', payload: 'x' });
    expect(events).toEqual([]);
    expect(t.region('browser-default').getAttribute('data-version')).toBe('initial');
  });

  it('F2-C17 — the event name is the one the category Delete page listens for', () => {
    expect(EVENT).toBe('creatorcrate:asset-category-preference-answer');
  });
});

// WP11C-F11: a save that settles with no answer render installed (lost,
// unreadable, cancelled, superseded) is announced to the page so it can
// reconcile the kept region's options; whether the save may have run is
// carried as `uncertain`. Nothing is installed, saved or retried by it.
describe('WP11C-F11 — a save settled without an installed answer is announced', () => {
  function track(t) {
    const answers = [];
    const settled = [];
    t.listen((event) => answers.push(event.detail.kind));
    ['browser-default', 'preview-category'].forEach((identity) => t.region(identity).addEventListener(SETTLED, (event) => {
      settled.push({ ...event.detail, identity, bubbles: event.bubbles, cancelable: event.cancelable });
    }));
    return { answers, settled };
  }

  it('F11-C4 / C11 / C12 — a lost answer (network) is announced once as uncertain on its own region; nothing is installed or offered as an answer', () => {
    const t = setup();
    const seen = track(t);
    const region = t.region('browser-default');
    const form = region.querySelector('form');
    t.optionsFor('browser-default').onError({ form, type: 'network', error: new TypeError('Failed to fetch'), superseded: false, willContinue: false });
    expect(seen.settled).toEqual([{ form, region, uncertain: true, identity: 'browser-default', bubbles: true, cancelable: false }]);
    expect(seen.answers).toEqual([]);
    expect(t.region('browser-default')).toBe(region);
    expect(region.getAttribute('data-settings-asset-category-preference-stored')).toBe('final');
    expect(dropdowns.enhanced).toBe(0);
  });

  it('F11-C5 — an unreadable answer (200, no matching region) is offered, installs nothing, and is announced as uncertain', () => {
    const t = setup();
    const seen = track(t);
    const form = t.region('preview-category').querySelector('form');
    // A body that is not the Settings page: no preference region at all.
    t.renders.set('unreadable', new El('main', {}, [new El('p')]));
    // settings-fetch-save reports the error first, then the refusal handler.
    t.optionsFor('preview-category').onError({ form, type: 'response', response: { ok: true, status: 200 }, willContinue: false });
    expect(seen.settled).toEqual([]);
    t.optionsFor('preview-category').onValidationError({ form, html: 'unreadable', response: { ok: true, status: 200 }, payload: 'previewCategory=s' });
    expect(seen.answers).toEqual(['refused']);
    expect(t.region('preview-category').getAttribute('data-version')).toBe('initial');
    expect(seen.settled).toHaveLength(1);
    expect(seen.settled[0]).toMatchObject({ form, uncertain: true, identity: 'preview-category' });
    expect(dropdowns.enhanced).toBe(0);
  });

  it('F11-C14 — a refusal the page cancels is announced as settled, not uncertain; an accepted refusal installs and is not announced', () => {
    const t = setup();
    const seen = track(t);
    let cancel = true;
    t.region('browser-default').addEventListener(EVENT, (event) => { if (cancel) event.preventDefault(); });
    const form = t.region('browser-default').querySelector('form');
    t.optionsFor('browser-default').onValidationError({ form, html: t.render('refused-old'), response: { ok: false, status: 422 }, payload: 'defaultCategory=s' });
    expect(t.region('browser-default').getAttribute('data-version')).toBe('initial');
    expect(seen.settled).toEqual([expect.objectContaining({ form, uncertain: false, identity: 'browser-default' })]);
    cancel = false;
    t.optionsFor('browser-default').onValidationError({ form, html: t.render('refused-new'), response: { ok: false, status: 422 }, payload: 'defaultCategory=s' });
    expect(t.region('browser-default').getAttribute('data-version')).toBe('refused-new');
    expect(seen.settled).toHaveLength(1);
  });

  it('F11-C6 / C15 — a continuing queued save, a response error (its refusal handler follows) and every success are not announced; the other setting is never told', () => {
    const t = setup();
    const seen = track(t);
    const form = t.region('browser-default').querySelector('form');
    t.optionsFor('browser-default').onError({ form, type: 'network', willContinue: true });
    t.optionsFor('browser-default').onError({ form, type: 'response', response: { ok: false, status: 422 }, willContinue: false });
    t.optionsFor('browser-default').onSuccess({ form, html: t.render('answer', { 'browser-default': 'exports' }), payload: 'defaultCategory=exports' });
    expect(seen.settled).toEqual([]);
    // Only the setting whose save settled is told.
    const preview = t.region('preview-category').querySelector('form');
    t.optionsFor('preview-category').onError({ form: preview, type: 'network', willContinue: false });
    expect(seen.settled.map(({ identity }) => identity)).toEqual(['preview-category']);
  });

  it('F11-C18 — a superseded refusal installs nothing and is announced (the page decides whether the form is still busy)', () => {
    const t = setup();
    const seen = track(t);
    const form = t.region('preview-category').querySelector('form');
    t.optionsFor('preview-category').onValidationError({ form, html: t.render('superseded-refusal'), response: { ok: false, status: 422 }, payload: 'x', superseded: true });
    expect(t.region('preview-category').getAttribute('data-version')).toBe('initial');
    expect(seen.answers).toEqual([]);
    expect(seen.settled).toEqual([expect.objectContaining({ form, uncertain: false, identity: 'preview-category' })]);
  });

  it('F11 contract — the settled event name', () => {
    expect(SETTLED).toBe('creatorcrate:asset-category-preference-settled');
  });
});

// WP11C-B: a preference save is acknowledged only by its redirected Settings
// answer that renders the same preference region. The module's
// parseAcknowledgement is given to the shared fetch save, which consults it
// before it moves its acknowledged baseline or says "Settings saved.".
describe('WP11C-B — a preference save is acknowledged only by its own Settings region', () => {
  const answerOf = (html, { ok = true, status = 200, redirected = true } = {}) => ({
    ok, status, redirected, text: async () => html,
  });
  const loginPage = () => new El('main', {}, [new El('form', { action: '/login' })]);

  it("B-C1 — parser contract: only a redirected 200 rendering this form's own region acknowledges", () => {
    const t = setup();
    const parse = (identity, html, response) => t.optionsFor(identity).parseAcknowledgement({ response, body: html });
    const both = t.render('settings');
    t.renders.set('login', loginPage());
    t.renders.set('browser-only', new El('main', {}, [preference('browser-default', 'only', 'final')]));
    const ok = { ok: true, status: 200, redirected: true };
    // Valid: the redirected Settings page with this setting's region.
    expect(parse('browser-default', both, ok).getAttribute(REGION)).toBe('browser-default');
    expect(parse('preview-category', both, ok).getAttribute(REGION)).toBe('preview-category');
    // The login page (or any page without the region) is not an acknowledgement.
    expect(parse('browser-default', 'login', ok)).toBeNull();
    // The other setting's region only: missing the matching region.
    expect(parse('preview-category', 'browser-only', ok)).toBeNull();
    expect(parse('browser-default', 'browser-only', ok).getAttribute(REGION)).toBe('browser-default');
    // Not redirected (a rendered page, a refusal) or not ok, or no body.
    expect(parse('browser-default', both, { ok: true, status: 200, redirected: false })).toBeNull();
    expect(parse('browser-default', both, { ok: false, status: 422, redirected: false })).toBeNull();
    expect(parse('browser-default', both, { ok: false, status: 500, redirected: true })).toBeNull();
    expect(parse('browser-default', '', ok)).toBeNull();
    expect(parse('browser-default', both, undefined)).toBeNull();
  });

  // The real shared fetch save with the module's options, on the shim.
  async function engineSetup() {
    const engine = await vi.importActual('../src/static/client/settings-fetch-save.js');
    const t = setup();
    const posts = [];
    const pending = [];
    const fields = new Map();
    const originals = { fetch: globalThis.fetch, FormData: globalThis.FormData };
    globalThis.FormData = class {
      constructor(form) { const select = fields.get(form); this.pairs = select ? [[select.name, select.value]] : []; }
      [Symbol.iterator]() { return this.pairs[Symbol.iterator](); }
    };
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      posts.push({ url, body: init.body.toString() });
      pending.push({ resolve, reject });
    });
    const bind = (region) => {
      const form = region.querySelector('form');
      if (fields.has(form)) return;
      const name = region.getAttribute(REGION) === 'browser-default' ? 'defaultCategory' : 'previewCategory';
      const select = new El('select', { name, 'data-autosubmit': 'fetch' });
      select.name = name;
      select.value = region.getAttribute('data-settings-asset-category-preference-stored');
      select.form = form;
      form.append(select);
      fields.set(form, select);
    };
    ['browser-default', 'preview-category'].forEach((identity) => {
      bind(t.region(identity));
      engine.enhanceSettingsFetchSave(t.region(identity).querySelector('form'), t.optionsFor(identity));
    });
    const restore = () => Object.assign(globalThis, originals);
    const choose = (identity, value) => {
      const select = t.region(identity).querySelector('select');
      select.value = value;
      select.dispatchEvent(new Event('change'));
    };
    const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
    const view = (identity) => {
      const form = t.region(identity).querySelector('form');
      return {
        state: form.getAttribute('data-settings-fetch-save-state'),
        status: form.querySelector('[data-settings-fetch-save-status]').textContent,
        busy: form.hasAttribute('aria-busy'),
        version: t.region(identity).getAttribute('data-version'),
        stored: t.region(identity).getAttribute('data-settings-asset-category-preference-stored'),
      };
    };
    const settled = [];
    ['browser-default', 'preview-category'].forEach((identity) => t.region(identity).addEventListener(SETTLED, (event) => {
      settled.push({ identity, uncertain: event.detail.uncertain });
    }));
    return { ...t, posts, pending, choose, flush, view, settled, restore };
  }

  const NOT_SAVED = 'Could not save settings. Your current changes were kept.';

  it('B-C2 — original P2: the answer is the login page (200, redirected): not acknowledged, the baseline stays, uncertain', async () => {
    const e = await engineSetup();
    try {
      e.renders.set('login', loginPage());
      e.choose('browser-default', 'sketches');
      await e.flush();
      expect(e.posts).toEqual([{ url: '/settings/asset-categories/browser-default', body: 'defaultCategory=sketches' }]);
      e.pending[0].resolve(answerOf('login'));
      await e.flush();
      expect(e.view('browser-default')).toMatchObject({ state: 'error', status: NOT_SAVED, busy: false, version: 'initial', stored: 'final' });
      expect(e.settled).toEqual([{ identity: 'browser-default', uncertain: true }]);
      // No automatic retry and no second save.
      expect(e.posts).toHaveLength(1);
      expect(e.view('preview-category')).toMatchObject({ state: null, version: 'initial' });
    } finally { e.restore(); }
  });

  it('B-C3 — baseline: back to the acknowledged value while pending sends nothing more when the answer is not an acknowledgement', async () => {
    const e = await engineSetup();
    try {
      e.renders.set('login', loginPage());
      e.choose('browser-default', 'sketches');
      await e.flush();
      // Back to the acknowledged 'final' while 'sketches' is pending: queued.
      e.choose('browser-default', 'final');
      e.pending[0].resolve(answerOf('login'));
      await e.flush();
      // Had the login page counted, the baseline would be 'sketches' and
      // 'final' would have been sent as a second save.
      expect(e.posts).toHaveLength(1);
      expect(e.view('browser-default')).toMatchObject({ state: 'error', status: NOT_SAVED, busy: false, stored: 'final' });
    } finally { e.restore(); }
  });

  it('B-C4 — missing matching region: a redirected Settings answer with only the other setting is not acknowledged', async () => {
    const e = await engineSetup();
    try {
      e.renders.set('browser-only', new El('main', {}, [preference('browser-default', 'only', 'final')]));
      e.choose('preview-category', 'sketches');
      await e.flush();
      e.pending[0].resolve(answerOf('browser-only'));
      await e.flush();
      expect(e.view('preview-category')).toMatchObject({ state: 'error', status: NOT_SAVED, version: 'initial', stored: 'disabled' });
      expect(e.view('browser-default')).toMatchObject({ version: 'initial', state: null });
      expect(e.settled).toEqual([{ identity: 'preview-category', uncertain: true }]);
      expect(e.posts).toHaveLength(1);
    } finally { e.restore(); }
  });

  it('B-C5 — normal: the redirected Settings answer is acknowledged, installs its region and says "Settings saved."', async () => {
    const e = await engineSetup();
    try {
      e.choose('browser-default', 'sketches');
      await e.flush();
      e.pending[0].resolve(answerOf(e.render('saved', { 'browser-default': 'sketches' })));
      await e.flush();
      expect(e.view('browser-default')).toMatchObject({ state: 'saved', status: 'Settings saved.', version: 'saved', stored: 'sketches', busy: false });
      expect(e.settled).toEqual([]);
      expect(e.posts).toHaveLength(1);
    } finally { e.restore(); }
  });

  it('B-C6 — a network failure and an unreadable body: the draft stays, error, uncertain; nothing is retried', async () => {
    const e = await engineSetup();
    try {
      e.choose('browser-default', 'sketches');
      await e.flush();
      e.pending[0].reject(new TypeError('Failed to fetch'));
      await e.flush();
      expect(e.view('browser-default')).toMatchObject({ state: 'error', status: NOT_SAVED, stored: 'final', busy: false });
      expect(e.region('browser-default').querySelector('select').value).toBe('sketches');
      e.choose('preview-category', 'sketches');
      await e.flush();
      e.pending[1].resolve({ ok: true, status: 200, redirected: true, text: async () => { throw new TypeError('body'); } });
      await e.flush();
      expect(e.view('preview-category')).toMatchObject({ state: 'error', status: NOT_SAVED, stored: 'disabled', busy: false });
      expect(e.settled).toEqual([{ identity: 'browser-default', uncertain: true }, { identity: 'preview-category', uncertain: true }]);
      expect(e.posts).toHaveLength(2);
    } finally { e.restore(); }
  });

  it("B-C7 — a 422 refusal keeps its refusal path: the server's render installs; nothing reads as saved", async () => {
    const e = await engineSetup();
    try {
      e.choose('browser-default', 'sketches');
      await e.flush();
      e.pending[0].resolve(answerOf(e.render('refused'), { ok: false, status: 422, redirected: false }));
      await e.flush();
      expect(e.view('browser-default')).toMatchObject({ version: 'refused', busy: false });
      expect(e.view('browser-default').status).not.toBe('Settings saved.');
      expect(e.settled).toEqual([]);
      expect(e.posts).toHaveLength(1);
    } finally { e.restore(); }
  });

  it('B-C8 — queued: a newer choice waits; each is sent once with its own payload; only the newer answer installs', async () => {
    const e = await engineSetup();
    try {
      e.choose('browser-default', 'sketches');
      await e.flush();
      e.choose('browser-default', 'exports');
      await e.flush();
      expect(e.posts).toHaveLength(1);
      e.pending[0].resolve(answerOf(e.render('first', { 'browser-default': 'sketches' })));
      await e.flush();
      expect(e.posts.map(({ body }) => body)).toEqual(['defaultCategory=sketches', 'defaultCategory=exports']);
      // The superseded answer installs nothing.
      expect(e.view('browser-default')).toMatchObject({ version: 'initial', busy: true });
      e.pending[1].resolve(answerOf(e.render('second', { 'browser-default': 'exports' })));
      await e.flush();
      expect(e.view('browser-default')).toMatchObject({ state: 'saved', status: 'Settings saved.', version: 'second', stored: 'exports', busy: false });
      expect(e.posts).toHaveLength(2);
    } finally { e.restore(); }
  });
});
