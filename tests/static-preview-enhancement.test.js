import { describe, it, expect, vi } from 'vitest';
import nunjucks from 'nunjucks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enhancePreview,
  enhancePreviewMedia,
  enhanceProjectCards,
  enhanceAutoSubmit,
  enhanceDefaultsFetchSave,
  enhanceAssetCategoryPreferencesFetchSave,
  enhanceNsfwFilterFetchSave,
  enhanceOpenLocallyFetchSave,
  enhanceSettingsFetchSave,
  enhanceCategoryReorder,
  enhanceBookReorder,
  enhanceBookDefaultsFetchSave,
  enhanceBookEditFetchSave,
  enhanceChapterPageReorder,
  enhanceBookContentReorder,
  enhanceBookHierarchyReorder,
  enhanceNotesEditor,
  enhanceNotesCodeBlocks,
  enhanceCategoryDetails,
  enhanceConfirmations,
  enhanceAssetSelection,
  enhanceAssetRenames,
  enhanceAssetGridSize,
  enhanceProjectGridSize,
  enhanceProjectAssetCategoryFilter,
  enhanceAssetViewerFilterDisclosures,
  enhanceDropdowns,
  enhanceDatePickers,
  enhanceTimePickers,
} from '../src/static/creatorcrate.js';
import { parseBookCoverAuthority } from '../src/static/client/book-edit-fetch-save.js';

function makeElement(props = {}) {
  const listeners = [];
  const attrOps = [];
  const element = {
    dataset: {},
    hidden: false,
    complete: false,
    naturalWidth: 0,
    src: '',
    ...props,
    listeners,
    attrOps,
    setAttribute(name, value) {
      attrOps.push(['set', name, value]);
      if (name === 'data-preview-state') this.dataset.previewState = String(value);
      if (name === 'hidden') this.hidden = true;
    },
    removeAttribute(name) {
      attrOps.push(['remove', name]);
      if (name === 'hidden') this.hidden = false;
    },
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    dispatch(type) {
      for (const listener of listeners.filter((entry) => entry.type === type)) {
        listener.handler();
      }
    },
  };
  return element;
}

function makeProjectDomNode({ tagName = 'div', parent = null, attributes = {} } = {}) {
  const listeners = [];
  const node = {
    tagName: tagName.toUpperCase(),
    parentElement: parent,
    parentNode: parent,
    attributes,
    dataset: {},
    listeners,
    matches(selector) {
      return selector.split(',').some((part) => {
        const candidate = part.trim().toLowerCase();
        if (candidate === this.tagName.toLowerCase()) return true;
        if (candidate === '[contenteditable]') return Object.hasOwn(attributes, 'contenteditable');
        if (candidate === '[role="button"]') return attributes.role === 'button';
        if (candidate === '[tabindex]') return Object.hasOwn(attributes, 'tabindex');
        return false;
      });
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: this,
        button: 0,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      for (const listener of listeners.filter((entry) => entry.type === type)) {
        listener.handler(event);
      }
      return event;
    },
  };
  return node;
}

function makeProjectCardFixture() {
  const card = makeProjectDomNode({ tagName: 'article' });
  const link = makeProjectDomNode({ tagName: 'a', parent: card });
  const metadataRow = makeProjectDomNode({ tagName: 'div', parent: card });
  const metadataValue = makeProjectDomNode({ tagName: 'span', parent: metadataRow });
  const blank = makeProjectDomNode({ tagName: 'div', parent: card });
  const secondaryLink = makeProjectDomNode({ tagName: 'a', parent: card });
  const button = makeProjectDomNode({ tagName: 'button', parent: card });
  const form = makeProjectDomNode({ tagName: 'form', parent: card });
  const input = makeProjectDomNode({ tagName: 'input', parent: form });
  const select = makeProjectDomNode({ tagName: 'select', parent: card });
  const label = makeProjectDomNode({ tagName: 'label', parent: card });
  const details = makeProjectDomNode({ tagName: 'details', parent: card });
  const summary = makeProjectDomNode({ tagName: 'summary', parent: details });
  let linkActivations = 0;

  link.click = () => {
    linkActivations += 1;
  };
  card.querySelector = (selector) => (
    selector === '[data-project-card-link]' ? link : null
  );

  return {
    card,
    link,
    blank,
    metadataValue,
    interactive: [secondaryLink, button, form, input, select, label, details, summary],
    get linkActivations() {
      return linkActivations;
    },
  };
}

function makePreview({ complete = false, naturalWidth = 0, src = '/thumbnail.webp', clickable = false } = {}) {
  const previewLink = clickable
    ? makeElement({
      href: '/original.webp',
      classList: { contains: (className) => className === 'asset-preview-link' },
    })
    : null;
  const image = makeElement({ complete, naturalWidth, src, parentElement: previewLink });
  if (previewLink) {
    image.closest = (selector) => (
      selector === '.asset-preview-link' && previewLink.classList.contains('asset-preview-link')
        ? previewLink
        : null
    );
  }
  const fallback = makeElement({ hidden: true });
  const loading = makeElement();
  const root = makeElement({ dataset: { previewState: 'loading' } });
  root.querySelector = (selector) => {
    if (selector === '[data-preview-image]') return image;
    if (selector === '[data-preview-loading]') return loading;
    if (selector === '[data-preview-fallback]') return fallback;
    return null;
  };
  return { root, image, loading, fallback, previewLink };
}

describe('static preview enhancement helpers', () => {
  it('server-renders the shared Book cover loading presentation with an unchanged image alt', () => {
    const viewsPath = fileURLToPath(new URL('../src/views', import.meta.url));
    const environment = new nunjucks.Environment(new nunjucks.FileSystemLoader(viewsPath));
    const html = environment.renderString(`{% import "partials/book-primary-image.njk" as cover %}
      {{ cover.render(book, 'preview') }}`, {
      book: {
        id: 7,
        title: 'Slow cover',
        primaryImage: {
          state: 'available',
          previewUrl: '/preview.webp',
          thumbnailUrl: '/thumbnail.webp',
          alt: 'Cover for Slow cover',
        },
      },
    });

    expect(html).toContain('data-preview-state="loading"');
    expect(html).toContain('data-preview-loading');
    expect(html).toContain('Loading cover…');
    expect(html).toContain('alt="Cover for Slow cover"');
    expect(html).toContain('data-preview-fallback hidden>Image unavailable</span>');
  });

  it('handles already-complete success and failure immediately', () => {
    for (const { naturalWidth, state, imageHidden, fallbackHidden } of [
      { naturalWidth: 128, state: 'loaded', imageHidden: false, fallbackHidden: true },
      { naturalWidth: 0, state: 'failed', imageHidden: true, fallbackHidden: false },
    ]) {
      const { root, image, loading, fallback } = makePreview({ complete: true, naturalWidth });

      expect(enhancePreview(root)).toBe(state);
      expect(root.dataset.previewState).toBe(state);
      expect(image.hidden).toBe(imageHidden);
      expect(loading.hidden).toBe(true);
      expect(fallback.hidden).toBe(fallbackHidden);
      expect(image.listeners).toEqual([]);
    }
  });

  it('handles asynchronous load and error terminal states', () => {
    for (const { event, state, imageHidden, fallbackHidden } of [
      { event: 'load', state: 'loaded', imageHidden: false, fallbackHidden: true },
      { event: 'error', state: 'failed', imageHidden: true, fallbackHidden: false },
    ]) {
      const { root, image, loading, fallback } = makePreview();

      expect(enhancePreview(root)).toBe('listening');
      expect(image.listeners.map((listener) => listener.type)).toEqual(['load', 'error']);
      expect(image.listeners.every((listener) => listener.options.once === true)).toBe(true);

      image.dispatch(event);

      expect(root.dataset.previewState).toBe(state);
      expect(image.hidden).toBe(imageHidden);
      expect(loading.hidden).toBe(true);
      expect(fallback.hidden).toBe(fallbackHidden);
    }
  });

  it('does not bind duplicate preview listeners when re-enhanced', () => {
    const { root, image } = makePreview();

    expect(enhancePreview(root)).toBe('listening');
    expect(enhancePreview(root)).toBe('listening');
    expect(image.listeners.map((listener) => listener.type)).toEqual(['load', 'error']);
  });

  it('does not mutate a preview after its root is detached', () => {
    const { root, image, loading } = makePreview();
    root.isConnected = true;
    enhancePreview(root);

    root.isConnected = false;
    image.dispatch('load');

    expect(root.dataset.previewState).toBe('loading');
    expect(loading.hidden).toBe(false);
  });

  it('hides a clickable preview link when its image fails', () => {
    const { root, image, fallback, previewLink } = makePreview({ clickable: true });

    enhancePreview(root);
    image.dispatch('error');

    expect(previewLink.hidden).toBe(true);
    expect(previewLink.attrOps).toContainEqual(['set', 'hidden', '']);
    expect(previewLink.href).toBe('/original.webp');
    expect(fallback.hidden).toBe(false);
  });

  it('does not retry or rewrite image sources after repeated errors', () => {
    const src = '/projects/1/assets/2/thumbnail?v=abc123';
    const { root, image, fallback } = makePreview({ src });

    enhancePreview(root);
    image.dispatch('error');
    const imageOpCount = image.attrOps.length;
    const fallbackOpCount = fallback.attrOps.length;

    image.dispatch('error');

    expect(image.src).toBe(src);
    expect(root.dataset.previewState).toBe('failed');
    expect(root.querySelector('[data-preview-fallback]')).toBe(fallback);
    expect(image.attrOps.filter((op) => op[1] === 'src')).toEqual([]);
    expect(image.attrOps.length).toBe(imageOpCount);
    expect(fallback.attrOps.length).toBe(fallbackOpCount);
  });

  it('no-ops when no matching elements exist', () => {
    const scope = {
      querySelectorAll(selector) {
        expect(selector).toBe('[data-preview-enhancement]');
        return [];
      },
    };

    expect(() => enhancePreviewMedia(scope)).not.toThrow();
    expect(enhancePreviewMedia(scope)).toBe(0);
  });

  it('does not use innerHTML for DOM replacement', () => {
    const staticDirectory = fileURLToPath(new URL('../src/static/', import.meta.url));
    const sourcePaths = [
      fileURLToPath(new URL('../src/static/creatorcrate.js', import.meta.url)),
      ...fs.readdirSync(path.join(staticDirectory, 'client'), { recursive: true })
        .filter((entry) => entry.endsWith('.js'))
        .map((entry) => path.join(staticDirectory, 'client', entry)),
    ];

    sourcePaths.forEach((sourcePath) => {
      expect(fs.readFileSync(sourcePath, 'utf8')).not.toMatch(/innerHTML/i);
    });
  });

  it('uses only browser-local storage for the presentation preference', () => {
    const sizePreferencesSource = fs.readFileSync(
      fileURLToPath(new URL('../src/static/client/size-preferences.js', import.meta.url)),
      'utf8'
    );
    const liveRegionsSource = fs.readFileSync(
      fileURLToPath(new URL('../src/static/client/live-regions.js', import.meta.url)),
      'utf8'
    );

    expect(sizePreferencesSource).toMatch(/localStorage/);
    expect(sizePreferencesSource).not.toMatch(/sessionStorage|XMLHttpRequest/i);
    expect(liveRegionsSource).toMatch(/fetch\(/i);
  });

  it('initializes the flat and connected Book reorder enhancements from the shared client boot', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.js', import.meta.url)),
      'utf8'
    );

    expect(source).toContain('enhanceBookContentReorder(document)');
    expect(source).toContain('enhanceBookHierarchyReorder(document)');
  });
});

describe('project card navigation enhancement', () => {
  function makeScope(cards) {
    return {
      querySelectorAll(selector) {
        expect(selector).toBe('[data-project-card]');
        return cards;
      },
    };
  }

  it('activates the real project link from blank space and ordinary metadata once', () => {
    const fixture = makeProjectCardFixture();

    expect(enhanceProjectCards(makeScope([fixture.card]))).toBe(1);

    fixture.card.dispatch('click', { target: fixture.blank });
    expect(fixture.linkActivations).toBe(1);

    fixture.card.dispatch('click', { target: fixture.metadataValue });
    expect(fixture.linkActivations).toBe(2);

    fixture.card.dispatch('click', { target: fixture.link });
    expect(fixture.linkActivations).toBe(2);
  });

  it('does not navigate for secondary links, buttons, forms, or controls', () => {
    const fixture = makeProjectCardFixture();
    enhanceProjectCards(makeScope([fixture.card]));

    for (const target of fixture.interactive) {
      const event = fixture.card.dispatch('click', { target });
      expect(fixture.linkActivations).toBe(0);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(fixture.linkActivations).toBe(0);
  });

  it('ignores modified clicks and non-primary mouse buttons', () => {
    const fixture = makeProjectCardFixture();
    enhanceProjectCards(makeScope([fixture.card]));

    fixture.card.dispatch('click', { target: fixture.blank, metaKey: true });
    fixture.card.dispatch('click', { target: fixture.blank, ctrlKey: true });
    fixture.card.dispatch('click', { target: fixture.blank, shiftKey: true });
    fixture.card.dispatch('click', { target: fixture.blank, altKey: true });
    fixture.card.dispatch('click', { target: fixture.blank, button: 1 });
    fixture.card.dispatch('click', { target: fixture.blank, button: 2 });

    expect(fixture.linkActivations).toBe(0);
  });

  it('is idempotent and safely handles pages without project cards', () => {
    const fixture = makeProjectCardFixture();
    const scope = makeScope([fixture.card]);

    expect(enhanceProjectCards(scope)).toBe(1);
    expect(enhanceProjectCards(scope)).toBe(1);
    expect(fixture.card.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);

    fixture.card.dispatch('click', { target: fixture.blank });
    expect(fixture.linkActivations).toBe(1);

    expect(enhanceProjectCards(makeScope([]))).toBe(0);
    expect(() => enhanceProjectCards(null)).not.toThrow();
  });
});

// ─── Phase 3 chunk 3: page-local asset selection ─────────────────────────

function makeCheckbox({ checked = false, disabled = false } = {}) {
  const listeners = [];
  return {
    dataset: {},
    checked,
    disabled,
    listeners,
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      for (const l of listeners.filter((entry) => entry.type === type)) l.handler(event);
      return event;
    },
  };
}

class TestFormData {
  constructor(form) {
    form ||= {};
    this.form = form;
    const values = {
      _csrf: [form.csrfToken || 'csrf-token'],
    };
    if (form.control) values.enabled = ['0', ...(form.control.checked ? ['1'] : [])];
    if (form.controls) {
      for (const control of form.controls) values[control.name] = [control.value];
    }
    const orderInput = form.querySelector?.('[data-category-order-input]');
    if (orderInput) values.orderedCategoryIds = [orderInput.value || ''];
    const noteOrderInput = form.querySelector?.('[data-note-order-input]');
    if (noteOrderInput) values.orderedNoteIds = [noteOrderInput.value || ''];
    const bookOrderInput = form.querySelector?.('[data-book-order-input]');
    if (bookOrderInput) values.orderedBookIds = [bookOrderInput.value || ''];
    this.values = values;
  }

  getAll(name) {
    return this.values[name] || [];
  }

  set(name, value) {
    this.values[name] = [value];
  }

  // Iterable of [name, value] pairs so the enhancement's
  // `new URLSearchParams(new FormData(form))` (urlencoded body) can consume it.
  *[Symbol.iterator]() {
    for (const [name, list] of Object.entries(this.values)) {
      for (const value of list) yield [name, value];
    }
  }
}

async function withBrowserGlobals(fetchImplementation, callback) {
  const originalFetch = globalThis.fetch;
  const originalFormData = globalThis.FormData;
  globalThis.fetch = fetchImplementation;
  globalThis.FormData = TestFormData;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FormData = originalFormData;
  }
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeEnabledFixture({ action, checked = true } = {}) {
  const status = { textContent: '' };
  const attributes = new Map();
  const form = {
    action,
    method: 'post',
    csrfToken: 'csrf-enabled',
    control: null,
    querySelector(selector) {
      return selector === '[data-category-enabled-status]' ? status : null;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) || null; },
    hasAttribute(name) { return attributes.has(name); },
    requestSubmitCount: 0,
    submitCount: 0,
    requestSubmit() { this.requestSubmitCount += 1; },
    submit() { this.submitCount += 1; },
  };
  const control = makeCheckbox({ checked });
  control.form = form;
  form.control = control;
  return { control, form, status, attributes };
}

describe('category enabled autosubmit enhancement', () => {
  it('refreshes Project Assets only after a confirmed enable or disable redirect', async () => {
    const fixture = makeEnabledFixture({ action: '/projects/7/asset-categories/11/enabled' });
    const changed = vi.fn();
    fixture.form.closest = () => ({});
    fixture.form.ownerDocument = { dispatchEvent: changed };
    const responses = [
      { ok: true, redirected: true, url: 'http://creatorcrate.test/projects/7/assets?notice=category_disabled' },
      { ok: true, redirected: true, url: 'http://creatorcrate.test/projects/7/assets?notice=category_enable_failed' },
      { ok: true, redirected: true, url: 'http://creatorcrate.test/projects/7/assets?notice=category_enabled' },
    ];
    await withBrowserGlobals(async () => responses.shift(), async () => {
      enhanceAutoSubmit({ querySelectorAll: () => [fixture.control] });
      fixture.control.checked = false;
      fixture.control.dispatch('change');
      await flushAsync();
      expect(changed).toHaveBeenCalledTimes(1);

      fixture.control.checked = true;
      fixture.control.dispatch('change');
      await flushAsync();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(fixture.control.checked).toBe(false);

      fixture.control.checked = true;
      fixture.control.dispatch('change');
      await flushAsync();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(fixture.control.checked).toBe(true);
    });
  });

  it('uses each form action and complete FormData for checked and unchecked changes', async () => {
    const project = makeEnabledFixture({ action: '/projects/7/asset-categories/11/enabled', checked: true });
    const settings = makeEnabledFixture({ action: '/settings/asset-categories/12/enabled', checked: false });
    const calls = [];

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true };
    }, async () => {
      const scope = { querySelectorAll: () => [project.control, settings.control] };
      enhanceAutoSubmit(scope);

      project.control.checked = false;
      const projectChange = project.control.dispatch('change');
      settings.control.checked = true;
      const settingsChange = settings.control.dispatch('change');
      await flushAsync();

      expect(projectChange.defaultPrevented).toBe(true);
      expect(settingsChange.defaultPrevented).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.action)).toEqual([
        '/projects/7/asset-categories/11/enabled',
        '/settings/asset-categories/12/enabled',
      ]);
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].options.credentials).toBe('same-origin');
      expect(calls[0].options.body).toBeInstanceOf(URLSearchParams);
      expect(calls[0].options.body.getAll('_csrf')).toEqual(['csrf-enabled']);
      expect(calls[0].options.body.getAll('enabled')).toEqual(['0']);
      expect(calls[1].options.body.getAll('enabled')).toEqual(['0', '1']);
      expect(project.form.requestSubmitCount).toBe(0);
      expect(project.form.submitCount).toBe(0);
      expect(settings.form.requestSubmitCount).toBe(0);
      expect(settings.form.submitCount).toBe(0);
      expect(project.control.checked).toBe(false);
      expect(settings.control.checked).toBe(true);
      expect(project.status.textContent).toContain('Disabled status saved.');
      expect(settings.status.textContent).toContain('Enabled status saved.');
      expect(project.form.hasAttribute('aria-busy')).toBe(false);
      expect(settings.form.hasAttribute('aria-busy')).toBe(false);
    });
  });

  it('is idempotent, ignores unrelated controls, and keeps each pending form independent', async () => {
    const first = makeEnabledFixture({ action: '/projects/7/asset-categories/11/enabled', checked: true });
    const second = makeEnabledFixture({ action: '/settings/asset-categories/12/enabled', checked: true });
    const unrelated = makeCheckbox({ checked: true });
    const deferred = [];

    await withBrowserGlobals((action) => new Promise((resolve) => deferred.push({ action, resolve })), async () => {
      const scope = {
        querySelectorAll(selector) {
          expect(selector).toBe('[data-autosubmit]');
          return [first.control, second.control];
        },
      };
      expect(enhanceAutoSubmit(scope)).toBe(2);
      expect(enhanceAutoSubmit(scope)).toBe(2);
      expect(first.control.listeners).toHaveLength(1);
      expect(second.control.listeners).toHaveLength(1);
      expect(unrelated.listeners).toHaveLength(0);

      first.control.checked = false;
      first.control.dispatch('change');
      await flushAsync();
      expect(deferred).toHaveLength(1);
      expect(first.form.hasAttribute('aria-busy')).toBe(true);
      expect(second.form.hasAttribute('aria-busy')).toBe(false);

      first.control.checked = true;
      const duplicate = first.control.dispatch('change');
      expect(duplicate.defaultPrevented).toBe(true);
      expect(first.control.checked).toBe(false);
      expect(deferred).toHaveLength(1);

      deferred[0].resolve({ ok: true });
      await flushAsync();
      expect(first.form.hasAttribute('aria-busy')).toBe(false);
      expect(first.control.disabled).toBe(false);
    });
  });

  it('restores the previous state and announces a controlled failure for HTTP and network errors', async () => {
    const httpFailure = makeEnabledFixture({ action: '/settings/asset-categories/12/enabled', checked: true });
    const networkFailure = makeEnabledFixture({ action: '/projects/7/asset-categories/11/enabled', checked: false });
    let call = 0;

    await withBrowserGlobals(() => {
      call += 1;
      return call === 1 ? Promise.resolve({ ok: false, status: 500 }) : Promise.reject(new Error('secret server detail'));
    }, async () => {
      const scope = { querySelectorAll: () => [httpFailure.control, networkFailure.control] };
      enhanceAutoSubmit(scope);

      httpFailure.control.checked = false;
      networkFailure.control.checked = true;
      httpFailure.control.dispatch('change');
      networkFailure.control.dispatch('change');
      await flushAsync();

      expect(httpFailure.control.checked).toBe(true);
      expect(networkFailure.control.checked).toBe(false);
      expect(httpFailure.status.textContent).toContain('previous status was restored');
      expect(networkFailure.status.textContent).toContain('previous status was restored');
      expect(httpFailure.status.textContent).not.toContain('500');
      expect(networkFailure.status.textContent).not.toContain('secret');
      expect(httpFailure.form.hasAttribute('aria-busy')).toBe(false);
      expect(networkFailure.form.hasAttribute('aria-busy')).toBe(false);
    });
  });
});

describe('native autosubmit navigation', () => {
  it('submits through the owning form once after repeated enhancement and ignores non-change events or missing forms', () => {
    const fixture = makeEnabledFixture({ action: '/autosubmit', checked: false });
    const fallback = makeEnabledFixture({ action: '/autosubmit-fallback', checked: false });
    const orphan = makeCheckbox();
    fixture.control.dataset.autosubmit = 'submit';
    fallback.control.dataset.autosubmit = 'submit';
    delete fallback.form.requestSubmit;
    orphan.dataset.autosubmit = 'submit';

    const scope = {
      querySelectorAll(selector) {
        expect(selector).toBe('[data-autosubmit]');
        return [fixture.control, fallback.control, orphan];
      },
    };
    expect(enhanceAutoSubmit(scope)).toBe(3);
    expect(enhanceAutoSubmit(scope)).toBe(3);

    expect(fixture.form.requestSubmitCount).toBe(0);
    expect(fallback.form.submitCount).toBe(0);
    fixture.control.dispatch('input');
    expect(fixture.form.requestSubmitCount).toBe(0);

    fixture.control.dispatch('change');
    fixture.control.dispatch('change');
    fallback.control.dispatch('change');

    expect(fixture.form.requestSubmitCount).toBe(1);
    expect(fixture.form.submitCount).toBe(0);
    expect(fallback.form.submitCount).toBe(1);
    expect(() => orphan.dispatch('change')).not.toThrow();
  });
});


function makeFetchSaveFixture({ action = '/settings/defaults', values = { value: 'initial' } } = {}) {
  const status = {
    _textContent: '',
    children: [],
    attributes: new Map(),
    get textContent() { return this._textContent; },
    set textContent(value) {
      this._textContent = String(value);
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
  };
  const attributes = new Map();
  const form = {
    tagName: 'FORM',
    dataset: {},
    action,
    method: 'post',
    csrfToken: 'csrf-fetch-save',
    controls: [],
    requestSubmitCount: 0,
    submitCount: 0,
    querySelector(selector) {
      return selector === '[data-settings-fetch-save-status]' ? status : null;
    },
    querySelectorAll(selector) {
      return selector === 'input, select, textarea' ? controls : [];
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
    requestSubmit() { this.requestSubmitCount += 1; },
    submit() { this.submitCount += 1; },
  };
  const controls = Object.entries(values).map(([name, value]) => {
    const control = makeCheckbox();
    control.name = name;
    control.value = value;
    control.dataset.autosubmit = 'fetch';
    control.form = form;
    return control;
  });
  form.controls = controls;
  return { form, controls, status, attributes };
}

function makeDefaultsFetchFixture({ value = 'tbd', name = 'new_projectStatus' } = {}) {
  const fixture = makeFetchSaveFixture({ values: { [name]: value } });
  const cards = Object.fromEntries(['new_projectStatus', 'clockFormat', 'noteRevisionRetention']
    .map((controlName) => [controlName, {
      appendChild(status) { status.parentNode = this; },
    }]));
  fixture.status.parentNode = cards.new_projectStatus;
  fixture.controls[0].closest = (selector) => selector === '.settings-defaults-section' ? cards[name] : null;
  const numberInputQueries = { count: 0 };
  const effective = {
    parentNode: {},
    replacement: null,
    replaceWith(next) { this.replacement = next; },
  };
  const region = {
    parentNode: {},
    replacement: null,
    replaceWith(next) { this.replacement = next; },
    querySelector(selector) {
      return selector === '#settings-defaults-form' ? fixture.form : null;
    },
    querySelectorAll(selector) {
      if (selector === '#settings-defaults-form') return [fixture.form];
      if (selector === '[data-cc-dropdown]') return [];
      if (selector === 'input[type="number"]') numberInputQueries.count += 1;
      return [];
    },
  };
  const querySelector = fixture.form.querySelector.bind(fixture.form);
  const querySelectorAll = fixture.form.querySelectorAll.bind(fixture.form);
  fixture.form.matches = (selector) => selector === '#settings-defaults-form';
  fixture.form.closest = (selector) => selector === '[data-settings-defaults-region]' ? region : null;
  fixture.form.querySelector = (selector) => {
    if (selector === '[data-settings-defaults-effective]') return effective;
    return querySelector(selector);
  };
  fixture.form.querySelectorAll = (selector) => {
    if (selector === '[data-autosubmit="fetch"]') return fixture.controls;
    return querySelectorAll(selector);
  };
  return { ...fixture, cards, effective, numberInputQueries, region, scope: { querySelectorAll: () => [fixture.form] } };
}

async function withDefaultsDomParser(parser, callback) {
  const originalDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString(html) { return parser(html); }
  };
  try {
    return await callback();
  } finally {
    globalThis.DOMParser = originalDOMParser;
  }
}

function makeBookDefaultsFetchFixture() {
  const fixture = makeFetchSaveFixture({
    action: '/notes/books/7/defaults',
    values: {
      navigation: 'expanded',
      previewMode: 'random',
      randomPageCount: '5',
      selectedPageIds: '41',
    },
  });
  fixture.form.setAttribute('data-book-defaults-autosave', '');
  fixture.form.matches = (selector) => selector === '#book-defaults-form';
  const makeOptions = (values) => values.map((value) => ({ value }));
  fixture.controls[0].options = makeOptions(['expanded', 'collapsed']);
  fixture.controls[1].options = makeOptions(['random', 'selected']);
  fixture.controls[2].options = makeOptions(['5', '8', '12']);
  fixture.controls[3].options = makeOptions(['41', '42']);
  const body = {
    parentNode: {},
    children: [],
    contains(target) {
      return fixture.form.controls.some((control) => (
        target === control
          || target === control.__bookDefaultsDropdown
          || target === control.__bookDefaultsDropdown?.querySelector?.('summary')
      )) || this.children.includes(target);
    },
    replaceWith(next) {
      currentBody = next;
      if (next.controls) fixture.form.controls = next.controls;
    },
    appendChild(child) { this.children.push(child); },
  };
  let currentBody = body;
  fixture.form.ownerDocument = {
    activeElement: null,
    defaultView: { location: { href: 'http://creatorcrate.local/notes/books/7' } },
    createElement() {
      return {
        attributes: new Map(),
        listeners: new Map(),
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        addEventListener(type, handler) { this.listeners.set(type, handler); },
        focus() {
          this.focused = true;
          fixture.form.ownerDocument.activeElement = this;
        },
        remove() {
          this.removed = true;
          if (this.parentNode?.children) {
            this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
          }
          this.parentNode = null;
        },
        dispatch(type) { this.listeners.get(type)?.({ preventDefault() {} }); },
      };
    },
  };
  const querySelector = fixture.form.querySelector.bind(fixture.form);
  fixture.form.querySelector = (selector) => {
    if (selector === '.app-dialog-body') return currentBody;
    const named = selector.match(/^\[name="([^"]+)"\]$/);
    if (named) return fixture.form.controls.find((control) => control.name === named[1]) || null;
    return querySelector(selector);
  };
  fixture.form.querySelectorAll = (selector) => {
    if (selector === '[data-autosubmit="fetch"]') return fixture.form.controls;
    return [];
  };
  const close = {
    focus() {
      this.focused = true;
      fixture.form.ownerDocument.activeElement = this;
    },
  };
  const dialog = {
    open: true,
    querySelector(selector) { return selector === '[data-dialog-close]' ? close : null; },
  };
  fixture.form.closest = (selector) => selector === '[data-app-dialog]' ? dialog : null;
  return {
    ...fixture,
    dialog,
    close,
    body,
    scope: { querySelectorAll: (selector) => selector === '#book-defaults-form' ? [fixture.form] : [] },
  };
}

function attachBookDefaultsDropdowns(fixture) {
  const surfaces = fixture.form.controls.map((control) => {
    const multiple = control.name === 'selectedPageIds';
    const dropdownAttributes = new Map();
    const summaryAttributes = new Map([['aria-label', `${control.name}: ${control.value}`]]);
    const summary = {
      id: `${control.name}-dropdown-trigger`,
      disabled: false,
      tabIndex: 0,
      getAttribute(name) { return summaryAttributes.get(name) ?? null; },
      setAttribute(name, value) { summaryAttributes.set(name, String(value)); },
      removeAttribute(name) { summaryAttributes.delete(name); },
      focus() {
        this.focused = true;
        fixture.form.ownerDocument.activeElement = this;
      },
      closest(selector) { return selector === '[data-cc-dropdown]' ? dropdown : null; },
    };
    const currentSummary = { textContent: '' };
    const inputs = control.options.map((option) => ({
      type: multiple ? 'checkbox' : 'radio',
      value: option.value,
      checked: multiple ? Boolean(option.selected) : option.value === control.value,
      disabled: false,
      getAttribute() { return null; },
      closest(selector) {
        if (selector === 'label') return { textContent: option.value };
        if (selector === '[data-cc-dropdown]') return dropdown;
        return null;
      },
    }));
    const dropdown = {
      dataset: {
        ccDropdownMode: multiple ? 'multiple' : 'single',
        ccDropdownEmptySummary: 'None selected',
        ccDropdownCountLabel: 'Pages',
      },
      open: false,
      getAttribute(name) { return dropdownAttributes.get(name) ?? null; },
      hasAttribute(name) { return dropdownAttributes.has(name); },
      setAttribute(name, value = '') { dropdownAttributes.set(name, String(value)); },
      removeAttribute(name) {
        if (name === 'hidden') this.initializationCount = (this.initializationCount || 0) + 1;
        dropdownAttributes.delete(name);
      },
      closest(selector) { return selector === 'form' ? fixture.form : null; },
      querySelector(selector) {
        if (selector === '[data-cc-dropdown-native-select]') return control;
        if (selector === 'summary') return summary;
        if (selector === '[data-cc-dropdown-summary-current]') return currentSummary;
        if (selector === 'input[type="radio"]:checked') {
          return inputs.find((input) => input.type === 'radio' && input.checked) || null;
        }
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'input[type="radio"]') return inputs.filter((input) => input.type === 'radio');
        if (selector === 'input[type="checkbox"]') return inputs.filter((input) => input.type === 'checkbox');
        return [];
      },
    };
    const field = {
      querySelector(selector) {
        if (selector === '[data-cc-dropdown-native-select]') return control;
        if (selector === '[data-cc-dropdown]') return dropdown;
        return null;
      },
    };
    dropdown.parentElement = field;
    dropdown.parentNode = field;
    control.parentElement = field;
    control.parentNode = field;
    control.__bookDefaultsDropdown = dropdown;
    return { control, dropdown, inputs, summary, summaryAttributes, currentSummary };
  });

  const querySelectorAll = fixture.form.querySelectorAll.bind(fixture.form);
  fixture.form.querySelectorAll = (selector) => {
    if (selector === '[data-cc-dropdown]') {
      return fixture.form.controls
        .map((control) => control.__bookDefaultsDropdown)
        .filter(Boolean);
    }
    return querySelectorAll(selector);
  };
  return surfaces;
}

function bookDefaultsAuthority(fixture, values = {}) {
  const canonical = makeBookDefaultsFetchFixture();
  Object.entries(values).forEach(([name, value]) => {
    const control = canonical.form.controls.find((candidate) => candidate.name === name);
    if (control) control.value = value;
  });
  return {
    destination: 'http://creatorcrate.local/notes/books/7',
    detailRegion: { authority: values },
    canonicalForm: canonical.form,
    dialogBody: {
      parentNode: {},
      controls: canonical.form.controls,
      children: [],
      contains(target) {
        return this.controls.some((control) => (
          target === control
            || target === control.__bookDefaultsDropdown
            || target === control.__bookDefaultsDropdown?.querySelector?.('summary')
        )) || this.children.includes(target);
      },
      replaceWith() {},
      appendChild(child) { this.children.push(child); },
    },
  };
}

function bookDefaultsAcknowledgement(bookId = 7) {
  return {
    ok: true,
    redirected: false,
    status: 200,
    text: async () => JSON.stringify({
      status: 'success',
      refreshUrl: `/notes/books/${bookId}`,
    }),
  };
}

describe('Book defaults immediate persistence enhancement', () => {
  it('queues rapid committed changes as complete payloads and refreshes once after the newest acknowledgement', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const requests = [];
    const beginRefresh = vi.fn(() => 8);
    const refresh = vi.fn(() => 'started');

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      expect(enhanceBookDefaultsFetchSave(fixture.scope, { beginRefresh, refresh })).toBe(4);
      fixture.controls[0].value = 'collapsed';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      fixture.controls[1].value = 'selected';
      fixture.controls[2].value = '12';
      fixture.controls[3].value = '42';
      fixture.controls[3].dispatch('change');
      expect(requests).toHaveLength(1);
      expect(requests[0].options.body.get('navigation')).toBe('collapsed');
      expect(requests[0].options.body.get('previewMode')).toBe('random');
      expect(requests[0].options.body.get('randomPageCount')).toBe('5');
      expect(requests[0].options.body.get('selectedPageIds')).toBe('41');
      expect(requests[0].options.headers['X-CreatorCrate-Enhancement']).toBe('book-defaults-autosave');

      requests[0].resolve(bookDefaultsAcknowledgement());
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('navigation')).toBe('collapsed');
      expect(requests[1].options.body.get('previewMode')).toBe('selected');
      expect(requests[1].options.body.get('randomPageCount')).toBe('12');
      expect(requests[1].options.body.get('selectedPageIds')).toBe('42');
      expect(refresh).not.toHaveBeenCalled();

      requests[1].resolve(bookDefaultsAcknowledgement());
      await flushAsync();

      expect(beginRefresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith(
        fixture.form.ownerDocument,
        '/notes/books/7',
        8,
        expect.objectContaining({ onError: expect.any(Function) }),
      );
      expect(fixture.dialog.open).toBe(true);
      expect(fixture.form.submitCount).toBe(0);
      expect(fixture.status.textContent).toBe('Settings saved.');
    });
  });

  it('refreshes to the last acknowledged state when a newer queued mutation fails without retrying it', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const requests = [];
    const refresh = vi.fn(() => 'started');

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, { beginRefresh: () => 3, refresh });
      fixture.controls[0].value = 'collapsed';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[1].value = 'selected';
      fixture.controls[1].dispatch('change');

      requests[0].resolve(bookDefaultsAcknowledgement());
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(refresh).not.toHaveBeenCalled();

      requests[1].resolve({
        ok: false,
        redirected: false,
        status: 422,
        text: async () => '<!doctype html><html></html>',
      });
      await flushAsync();

      expect(requests).toHaveLength(2);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0][1]).toBe('/notes/books/7');
      expect(fixture.status.textContent).toBe('Could not save defaults. Your current changes were kept.');
      expect(fixture.attributes.get('data-settings-fetch-save-state')).toBe('error');
      expect(fixture.dialog.open).toBe(true);
      expect(fixture.controls[1].value).toBe('selected');
    });
  });

  it('distinguishes a committed save from a failed detail refresh', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const requests = [];
    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return bookDefaultsAcknowledgement();
    }, async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 1,
        refresh: () => 'unavailable',
      });
      fixture.controls[2].value = '8';
      fixture.controls[2].dispatch('change');
      await flushAsync();

      expect(fixture.status.textContent).toContain('Defaults were saved, but the Book detail could not refresh.');
      expect(fixture.attributes.get('data-settings-fetch-save-state')).toBe('saved-refresh-error');
      expect(requests).toHaveLength(1);
      expect(fixture.status.children).toHaveLength(1);
      expect(fixture.status.children[0].type).toBe('button');
      expect(fixture.status.children[0].textContent).toBe('Retry refresh');
    });
  });

  it('retries an acknowledged Defaults presentation with GET-only authority until it installs', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const posts = [];
    const authority = bookDefaultsAuthority(fixture, {
      navigation: 'collapsed',
      previewMode: 'selected',
      randomPageCount: '8',
      selectedPageIds: '42',
    });
    const fetchAuthority = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(authority);
    const installDetail = vi.fn(() => 'installed');

    await withBrowserGlobals(async (action, options) => {
      posts.push({ action, options });
      return bookDefaultsAcknowledgement();
    }, async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 5,
        refresh: () => 'unavailable',
        fetchAuthority,
        installDetail,
      });
      fixture.controls[0].value = 'collapsed';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      fixture.status.children[0].dispatch('click');
      await flushAsync();
      expect(fixture.status.children).toHaveLength(1);
      expect(fixture.status.children[0].textContent).toBe('Retry refresh');

      fixture.status.children[0].dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(posts).toHaveLength(1);
      expect(posts[0].options.method).toBe('POST');
      expect(fetchAuthority).toHaveBeenCalledTimes(2);
      expect(installDetail).toHaveBeenCalledOnce();
      expect(fixture.status.children).toHaveLength(0);
      expect(fixture.status.textContent).toBe('Settings saved. Book detail refreshed.');
      expect(fixture.attributes.get('data-settings-fetch-save-state')).toBe('saved');
    });
  });

  it('reissues an acknowledged refresh under the current generation without looping', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const generations = [8, 11];
    const beginRefresh = vi.fn(() => generations.shift());
    const refresh = vi.fn()
      .mockReturnValueOnce('superseded')
      .mockReturnValueOnce('started');

    await withBrowserGlobals(async () => bookDefaultsAcknowledgement(), async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, { beginRefresh, refresh });
      fixture.controls[0].value = 'collapsed';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      expect(beginRefresh).toHaveBeenCalledTimes(2);
      expect(refresh.mock.calls.map((call) => call[2])).toEqual([8, 11]);
      expect(fixture.status.textContent).toBe('Settings saved.');
    });

    const repeated = makeBookDefaultsFetchFixture();
    const alwaysSuperseded = vi.fn(() => 'superseded');
    await withBrowserGlobals(async () => bookDefaultsAcknowledgement(), async () => {
      enhanceBookDefaultsFetchSave(repeated.scope, {
        beginRefresh: vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(3),
        refresh: alwaysSuperseded,
      });
      repeated.controls[0].dispatch('change');
      await flushAsync();
      expect(alwaysSuperseded).toHaveBeenCalledTimes(2);
      expect(repeated.status.textContent).toContain('Defaults were saved, but the Book detail could not refresh.');
    });
  });

  it('reconciles an uncertain acknowledgement to canonical Defaults and keeps the active mutation single-shot', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const authority = bookDefaultsAuthority(fixture, {
      navigation: 'collapsed',
      previewMode: 'selected',
      randomPageCount: '8',
      selectedPageIds: '42',
    });
    const installDetail = vi.fn(() => 'installed');
    let posts = 0;
    await withBrowserGlobals(async () => {
      posts += 1;
      throw new TypeError('network interrupted');
    }, async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 1,
        refresh: vi.fn(),
        fetchAuthority: async () => authority,
        installDetail,
      });
      fixture.controls[0].dispatch('change');
      await flushAsync();
      await flushAsync();

      expect(fixture.status.textContent).toContain('Current Book Defaults were restored.');
      expect(fixture.status.textContent).not.toContain('Could not save defaults.');
      expect(fixture.form.controls.map(({ value }) => value)).toEqual(['collapsed', 'selected', '8', '42']);
      expect(installDetail).toHaveBeenCalledWith(
        fixture.form.ownerDocument,
        authority.destination,
        1,
        authority.detailRegion,
      );
      expect(posts).toBe(1);
      expect(fixture.dialog.open).toBe(true);
    });
  });

  it('restores a focused custom Defaults dropdown to its equivalent mounted summary after reconciliation', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const currentSurfaces = attachBookDefaultsDropdowns(fixture);
    const authority = bookDefaultsAuthority(fixture, { previewMode: 'selected' });
    const canonicalFixture = { form: { controls: authority.dialogBody.controls } };
    canonicalFixture.form.querySelectorAll = () => [];
    canonicalFixture.form.ownerDocument = fixture.form.ownerDocument;
    const canonicalSurfaces = attachBookDefaultsDropdowns(canonicalFixture);

    await withBrowserGlobals(async () => { throw new TypeError('response lost'); }, async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 1,
        refresh: vi.fn(),
        fetchAuthority: async () => authority,
        installDetail: vi.fn(() => 'installed'),
      });
      currentSurfaces[1].summary.focus();
      fixture.controls[0].dispatch('change');
      await flushAsync();
      await flushAsync();

      expect(fixture.form.ownerDocument.activeElement).toBe(canonicalSurfaces[1].summary);
      expect(fixture.form.ownerDocument.activeElement).not.toBe(currentSurfaces[1].summary);
      expect(authority.dialogBody.contains(fixture.form.ownerDocument.activeElement)).toBe(true);
      expect(canonicalSurfaces[1].summary.disabled).toBe(false);
      expect(canonicalSurfaces[1].summary.tabIndex).toBe(0);
    });
  });

  it('falls back to the first mounted Defaults dropdown when focused content has no stable identity', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const authority = bookDefaultsAuthority(fixture);
    const canonicalFixture = { form: { controls: authority.dialogBody.controls } };
    canonicalFixture.form.querySelectorAll = () => [];
    canonicalFixture.form.ownerDocument = fixture.form.ownerDocument;
    const canonicalSurfaces = attachBookDefaultsDropdowns(canonicalFixture);
    const unmapped = {
      focus() { fixture.form.ownerDocument.activeElement = this; },
      closest() { return null; },
      getAttribute() { return null; },
    };
    fixture.body.children.push(unmapped);

    await withBrowserGlobals(async () => { throw new TypeError('response lost'); }, async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 1,
        refresh: vi.fn(),
        fetchAuthority: async () => authority,
        installDetail: vi.fn(() => 'installed'),
      });
      unmapped.focus();
      fixture.controls[0].dispatch('change');
      await flushAsync();
      await flushAsync();

      expect(fixture.form.ownerDocument.activeElement).toBe(canonicalSurfaces[0].summary);
      expect(fixture.form.ownerDocument.activeElement).not.toBe(unmapped);
      expect(authority.dialogBody.contains(fixture.form.ownerDocument.activeElement)).toBe(true);
    });
  });

  it('does not move focus during an acknowledged autosave that does not replace the dialog body', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const surfaces = attachBookDefaultsDropdowns(fixture);

    await withBrowserGlobals(async () => bookDefaultsAcknowledgement(), async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 1,
        refresh: vi.fn(() => 'started'),
      });
      surfaces[1].summary.focus();
      fixture.controls[0].dispatch('change');
      await flushAsync();

      expect(fixture.form.ownerDocument.activeElement).toBe(surfaces[1].summary);
    });
  });

  it('classifies an unusable successful acknowledgement as uncertain rather than a definite rejection', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const fetchAuthority = vi.fn(async () => bookDefaultsAuthority(fixture));
    await withBrowserGlobals(async () => ({
      ok: true,
      status: 200,
      text: async () => '{malformed acknowledgement',
    }), async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 3,
        refresh: vi.fn(),
        fetchAuthority,
        installDetail: vi.fn(() => 'installed'),
      });
      fixture.controls[0].dispatch('change');
      await flushAsync();
      await flushAsync();

      expect(fetchAuthority).toHaveBeenCalledOnce();
      expect(fixture.status.textContent).toContain('Current Book Defaults were restored.');
      expect(fixture.status.textContent).not.toContain('Could not save defaults.');
    });
  });

  it('blocks dispatch until canonical authority is installed, then sends one valid queued complete payload', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const surfaces = attachBookDefaultsDropdowns(fixture);
    enhanceDropdowns(fixture.form);
    const requests = [];
    let releaseAuthority;
    const authority = bookDefaultsAuthority(fixture, {
      navigation: 'expanded',
      previewMode: 'random',
      randomPageCount: '5',
      selectedPageIds: '41',
    });
    const canonicalFixture = { form: { controls: authority.dialogBody.controls } };
    canonicalFixture.form.querySelectorAll = () => [];
    const canonicalSurfaces = attachBookDefaultsDropdowns(canonicalFixture);
    await withBrowserGlobals((action, options) => new Promise((resolve, reject) => {
      requests.push({ action, options, resolve, reject });
    }), async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: vi.fn(() => 'started'),
        fetchAuthority: () => new Promise((resolve) => { releaseAuthority = () => resolve(authority); }),
        installDetail: vi.fn(() => 'installed'),
      });
      fixture.controls[0].value = 'collapsed';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[1].value = 'selected';
      fixture.controls[2].value = '8';
      fixture.controls[3].value = '42';
      fixture.controls[3].dispatch('change');
      requests[0].reject(new TypeError('response lost'));
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.controls.every(({ disabled }) => disabled)).toBe(true);
      expect(surfaces.every(({ dropdown, inputs, summary, summaryAttributes }) => (
        dropdown.hasAttribute('data-cc-dropdown-disabled')
          && inputs.every(({ disabled }) => disabled)
          && summary.disabled
          && summary.tabIndex === -1
          && summaryAttributes.get('aria-disabled') === 'true'
      ))).toBe(true);
      fixture.controls[0].dispatch('change');
      expect(requests).toHaveLength(1);

      releaseAuthority();
      await flushAsync();
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('navigation')).toBe('collapsed');
      expect(requests[1].options.body.get('previewMode')).toBe('selected');
      expect(requests[1].options.body.get('randomPageCount')).toBe('8');
      expect(requests[1].options.body.get('selectedPageIds')).toBe('42');
      expect(canonicalSurfaces.every(({ dropdown, inputs, summary, summaryAttributes }) => (
        !dropdown.hasAttribute('data-cc-dropdown-disabled')
          && dropdown.initializationCount === 1
          && inputs.every(({ disabled }) => !disabled)
          && !summary.disabled
          && summary.tabIndex === 0
          && !summaryAttributes.has('aria-disabled')
      ))).toBe(true);
      expect(canonicalSurfaces.map(({ currentSummary }) => currentSummary.textContent))
        .toEqual(['collapsed', 'selected', '8', '42']);

      requests[1].resolve(bookDefaultsAcknowledgement());
      await flushAsync();
      expect(requests).toHaveLength(2);
    });
  });

  it('rejects an invalid queued Page selection after canonical reconciliation instead of sending it', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const requests = [];
    const authority = bookDefaultsAuthority(fixture, { selectedPageIds: '41' });
    authority.dialogBody.controls.find(({ name }) => name === 'selectedPageIds').options = [{ value: '41' }];
    await withBrowserGlobals((action, options) => new Promise((resolve, reject) => {
      requests.push({ action, options, resolve, reject });
    }), async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 2,
        refresh: vi.fn(),
        fetchAuthority: async () => authority,
        installDetail: vi.fn(() => 'installed'),
      });
      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[3].value = '42';
      fixture.controls[3].dispatch('change');
      requests[0].reject(new TypeError('response lost'));
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.status.textContent).toContain('was not applied');
      expect(fixture.attributes.get('data-settings-fetch-save-state')).toBe('reconciled-queued-invalid');
    });
  });

  it('does not publish canonical Defaults markup when detail publication does not install', async () => {
    for (const publicationOutcome of ['superseded', 'unavailable']) {
      const fixture = makeBookDefaultsFetchFixture();
      const surfaces = attachBookDefaultsDropdowns(fixture);
      enhanceDropdowns(fixture.form);
      const originalControls = fixture.form.controls;
      const authority = bookDefaultsAuthority(fixture, {
        navigation: 'collapsed',
        previewMode: 'selected',
      });
      const requests = [];

      await withBrowserGlobals((action, options) => new Promise((resolve, reject) => {
        requests.push({ action, options, resolve, reject });
      }), async () => {
        enhanceBookDefaultsFetchSave(fixture.scope, {
          beginRefresh: () => 9,
          refresh: vi.fn(),
          fetchAuthority: async () => authority,
          installDetail: vi.fn(() => publicationOutcome),
        });
        fixture.controls[0].dispatch('change');
        await flushAsync();
        fixture.controls[1].value = 'selected';
        fixture.controls[1].dispatch('change');
        requests[0].reject(new TypeError('response lost'));
        await flushAsync();
        await flushAsync();

        expect(requests).toHaveLength(1);
        expect(fixture.form.controls).toBe(originalControls);
        expect(fixture.form.controls).not.toBe(authority.dialogBody.controls);
        expect(fixture.controls.every(({ disabled }) => disabled)).toBe(true);
        expect(surfaces.every(({ dropdown, inputs, summary }) => (
          dropdown.hasAttribute('data-cc-dropdown-disabled')
            && inputs.every(({ disabled }) => disabled)
            && summary.disabled
        ))).toBe(true);
        const retry = fixture.body.children.find((child) => (
          child.attributes?.has('data-book-defaults-reconciliation-retry')
        ));
        expect(retry?.focused).toBe(true);
        expect(fixture.status.textContent).toContain('changes remain blocked');
      });
    }
  });

  it('keeps autosave blocked after reconciliation failure and Retry restores normal dispatch without replaying POST', async () => {
    const fixture = makeBookDefaultsFetchFixture();
    const requests = [];
    const authority = bookDefaultsAuthority(fixture);
    const canonicalFixture = { form: { controls: authority.dialogBody.controls } };
    canonicalFixture.form.querySelectorAll = () => [];
    canonicalFixture.form.ownerDocument = fixture.form.ownerDocument;
    const canonicalSurfaces = attachBookDefaultsDropdowns(canonicalFixture);
    const installDetail = vi.fn()
      .mockReturnValueOnce('unavailable')
      .mockReturnValueOnce('installed');
    await withBrowserGlobals((action, options) => new Promise((resolve, reject) => {
      requests.push({ action, options, resolve, reject });
    }), async () => {
      enhanceBookDefaultsFetchSave(fixture.scope, {
        beginRefresh: () => 6,
        refresh: vi.fn(() => 'started'),
        fetchAuthority: async () => authority,
        installDetail,
      });
      fixture.controls[0].dispatch('change');
      await flushAsync();
      requests[0].reject(new TypeError('response lost'));
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.status.textContent).toContain('changes remain blocked');
      expect(fixture.form.controls).not.toBe(authority.dialogBody.controls);
      const retry = fixture.body.children.find((child) => child.attributes?.has('data-book-defaults-reconciliation-retry'));
      expect(retry?.focused).toBe(true);
      fixture.controls[1].dispatch('change');
      expect(requests).toHaveLength(1);

      retry.dispatch('click');
      await flushAsync();
      await flushAsync();
      expect(requests).toHaveLength(1);
      expect(fixture.status.textContent).toContain('Current Book Defaults were restored.');
      expect(fixture.form.ownerDocument.activeElement).toBe(canonicalSurfaces[0].summary);
      expect(fixture.form.ownerDocument.activeElement).not.toBe(retry);
      expect(authority.dialogBody.contains(fixture.form.ownerDocument.activeElement)).toBe(true);
      expect(installDetail).toHaveBeenCalledTimes(2);

      const canonicalControl = fixture.form.controls[0];
      canonicalControl.value = 'collapsed';
      canonicalControl.dispatch('change');
      await flushAsync();
      expect(requests).toHaveLength(2);
    });
  });
});

function makeBookEditFetchFixture() {
  const listeners = new Map();
  const control = (attrs = {}) => ({
    value: '',
    files: [],
    disabled: false,
    isConnected: true,
    ...attrs,
    addEventListener(type, handler) { listeners.set(`${attrs.kind}:${type}`, handler); },
    dispatch(type) { listeners.get(`${attrs.kind}:${type}`)?.({ target: this }); },
    closest() { return null; },
    removeAttribute() {},
    setAttribute() {},
    focus() { this.ownerDocument.activeElement = this; },
  });
  const title = control({ kind: 'title', id: 'title', value: 'Book', type: 'text' });
  const cover = control({ kind: 'cover', id: 'book-cover', type: 'file' });
  const status = {
    _textContent: '',
    children: [],
    get textContent() { return this._textContent; },
    set textContent(value) {
      this._textContent = String(value);
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      child.isConnected = true;
    },
  };
  const csrf = { value: 'csrf-book-edit' };
  const expectedKind = { value: 'none' };
  const expectedId = { value: '' };
  const confirmed = { value: 'false' };
  const attributes = new Map();
  const createdButtons = [];
  const body = {
    children: [],
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      child.isConnected = true;
    },
    prepend() {},
    contains(element) { return element === title || element === cover || this.children.includes(element); },
    querySelector(selector) {
      if (selector === '#title') return title;
      if (selector === '#book-cover') return cover;
      return null;
    },
  };
  const document = {
    title: 'CreatorCrate',
    body: { tagName: 'BODY', isConnected: true },
    activeElement: null,
    defaultView: { location: { href: 'http://creatorcrate.local/notes/books/7' } },
    querySelector() { return null; },
    getElementById(id) {
      if (id === 'title') return title;
      if (id === 'book-cover') return cover;
      return null;
    },
    createElement(tagName) {
      const handlers = new Map();
      const element = {
        tagName,
        ownerDocument: document,
        isConnected: false,
        attributes: new Map(),
        addEventListener(type, handler) { handlers.set(type, handler); },
        dispatch(type) { handlers.get(type)?.({ target: this }); },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        remove() {
          if (!this.parentNode) return;
          this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
          this.parentNode = null;
          this.isConnected = false;
          if (document.activeElement === this) document.activeElement = document.body;
        },
        focus() { document.activeElement = this; },
      };
      if (tagName === 'button') createdButtons.push(element);
      return element;
    },
  };
  title.ownerDocument = document;
  cover.ownerDocument = document;
  const close = {
    isConnected: true,
    focus() { document.activeElement = this; },
  };
  const dialog = {
    open: true,
    contains(element) { return element === close || body.contains(element); },
    querySelector(selector) { return selector === '[data-dialog-close]' ? close : null; },
  };
  const form = {
    ownerDocument: document,
    action: '/notes/books/7',
    dataset: {},
    querySelector(selector) {
      return ({
        '[data-book-title-autosave]': title,
        '[data-book-cover-autosave]': cover,
        '[data-book-edit-save-status]': status,
        'input[name="_csrf"]': csrf,
        'input[name="expectedCoverKind"]': expectedKind,
        'input[name="expectedCoverId"]': expectedId,
        'input[name="coverReplacementConfirmed"]': confirmed,
        '.app-dialog-body': body,
      })[selector] || null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners.set(`form:${type}`, handler); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) || null; },
    closest(selector) { return selector === '[data-app-dialog]' ? dialog : null; },
  };
  return {
    form, title, cover, status, attributes, body, createdButtons, document, dialog, close,
    scope: { querySelectorAll: () => [form] },
  };
}

function acknowledgedCoverPresentationOptions(fixture) {
  return {
    fetchAuthority: async (state) => ({
      destination: '/notes/books/7',
      detailRegion: {},
      coverPresentation: {},
      title: state.acknowledgedTitle,
      currentCover: {
        kind: fixture.form.querySelector('input[name="expectedCoverKind"]').value,
        id: fixture.form.querySelector('input[name="expectedCoverId"]').value,
      },
    }),
    installDialogPresentation: () => true,
    publishDetailAndDialog: (document, destination, generation, detailRegion, publishDialog) => (
      publishDialog() ? 'installed' : 'unavailable'
    ),
  };
}

describe('Book edit immediate persistence enhancement', () => {
  it('accepts each canonical cover authority kind without coercing its ID', () => {
    for (const [kind, id] of [
      ['none', ''],
      ['project_asset', '42'],
      ['managed_asset', 'opaque:Managed-Cover/Value'],
    ]) {
      expect(parseBookCoverAuthority(kind, id)).toEqual({ kind, id });
    }
  });

  it('rejects each malformed cover authority boundary', () => {
    for (const [kind, id] of [
      ['none', '1'],
      ['project_asset', ''],
      ['project_asset', '01'],
      ['project_asset', '9007199254740992'],
      ['managed_asset', ''],
      ['unsupported', '1'],
    ]) {
      expect(parseBookCoverAuthority(kind, id)).toBeNull();
    }
  });

  it('publishes an acknowledged cover through canonical detail and dialog authority without replaying it', async () => {
    const currentCover = { kind: 'managed_asset', id: 'opaque:Managed-Cover/Value' };
    const fixture = makeBookEditFetchFixture();
    const detailRegion = {};
    const coverPresentation = {};
    const fetchAuthority = vi.fn(async () => ({
      destination: '/notes/books/7', detailRegion, coverPresentation,
      title: 'Book', currentCover,
    }));
    const installDialogPresentation = vi.fn(() => true);
    const publishDetailAndDialog = vi.fn((document, destination, generation, region, publishDialog) => (
      publishDialog() ? 'installed' : 'unavailable'
    ));
    const requests = [];

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          refreshUrl: '/notes/books/7',
          currentCover,
          book: { title: 'Book' },
        }),
      };
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        fetchAuthority,
        installDialogPresentation,
        publishDetailAndDialog,
      });
      fixture.cover.files = [{ name: 'cover.png' }];
      fixture.cover.dispatch('change');
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fetchAuthority).toHaveBeenCalledOnce();
      expect(publishDetailAndDialog).toHaveBeenCalledWith(
        fixture.form.ownerDocument, '/notes/books/7', 4, detailRegion, expect.any(Function),
      );
      expect(installDialogPresentation).toHaveBeenCalledWith(
        expect.any(Object), expect.objectContaining({ coverPresentation, currentCover }),
      );
      expect(fixture.form.querySelector('input[name="expectedCoverKind"]').value).toBe(currentCover.kind);
      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe(currentCover.id);
      expect(fixture.status.textContent).toBe('Book cover saved.');
    });
  });

  it('keeps acknowledged cover authority and does not replay POST when canonical presentation refresh fails', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];
    const currentCover = { kind: 'managed_asset', id: 'saved-cover-id' };

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7', currentCover, book: { title: 'Book' },
        }),
      };
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        fetchAuthority: async () => null,
        publishDetailAndDialog: vi.fn(),
      });
      fixture.cover.files = [{ name: 'cover.png' }];
      fixture.cover.dispatch('change');
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.form.querySelector('input[name="expectedCoverKind"]').value).toBe(currentCover.kind);
      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe(currentCover.id);
      expect(fixture.attributes.get('data-book-edit-save-state')).toBe('saved-refresh-error');
      expect(fixture.status.textContent).toContain('The Book was saved');
      expect(fixture.body.children).toHaveLength(1);
      expect(fixture.body.children[0].textContent).toBe('Retry refresh');
      expect(fixture.body.children[0].attributes.get('aria-describedby')).toBe('book-edit-save-status');
    });
  });

  it('recovers an acknowledged title presentation through repeated GET-only Retry without replaying POST', async () => {
    const fixture = makeBookEditFetchFixture();
    const posts = [];
    const authority = {
      destination: '/notes/books/7', detailRegion: {}, coverPresentation: {},
      title: 'Canonical saved title', currentCover: { kind: 'none', id: '' },
    };
    const fetchAuthority = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(authority);
    const publishDetailAndDialog = vi.fn((document, destination, generation, detailRegion, publishDialog) => (
      publishDialog() ? 'installed' : 'unavailable'
    ));

    await withBrowserGlobals(async (action, options) => {
      posts.push({ action, options });
      return {
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'none', id: '' }, book: { title: 'Saved title' },
        }),
      };
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: () => 'unavailable',
        fetchAuthority,
        installDialogPresentation: () => true,
        publishDetailAndDialog,
      });
      fixture.title.value = 'Saved title';
      fixture.title.dispatch('change');
      await flushAsync();

      fixture.body.children[0].focus();
      fixture.body.children[0].dispatch('click');
      await flushAsync();
      expect(fixture.body.children).toHaveLength(1);
      expect(fixture.document.activeElement).toBe(fixture.body.children[0]);

      fixture.body.children[0].dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(posts).toHaveLength(1);
      expect(posts[0].options.method).toBe('POST');
      expect(fetchAuthority).toHaveBeenCalledTimes(2);
      expect(publishDetailAndDialog).toHaveBeenCalledOnce();
      expect(fixture.title.value).toBe('Canonical saved title');
      expect(fixture.body.children).toHaveLength(0);
      expect(fixture.status.textContent).toBe('Book saved. Presentation refreshed.');
      expect(fixture.document.activeElement).toBe(fixture.title);
    });
  });

  it('recovers an acknowledged cover presentation through GET-only Retry without resending multipart data', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];
    const acknowledgedCover = { kind: 'managed_asset', id: 'saved-cover-id' };
    const authority = {
      destination: '/notes/books/7', detailRegion: {}, coverPresentation: {},
      title: 'Book', currentCover: acknowledgedCover,
    };
    const fetchAuthority = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(authority);

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: acknowledgedCover, book: { title: 'Book' },
        }),
      };
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 6,
        fetchAuthority,
        installDialogPresentation: () => true,
        publishDetailAndDialog: (document, destination, generation, detailRegion, publishDialog) => (
          publishDialog() ? 'installed' : 'unavailable'
        ),
      });
      fixture.cover.files = [{ name: 'cover.png' }];
      fixture.cover.dispatch('change');
      await flushAsync();

      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe('saved-cover-id');
      fixture.body.children[0].focus();
      fixture.body.children[0].dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(requests[0].options.body).toBeInstanceOf(TestFormData);
      expect(fetchAuthority).toHaveBeenCalledTimes(2);
      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe('saved-cover-id');
      expect(fixture.body.children).toHaveLength(0);
      expect(fixture.status.textContent).toBe('Book saved. Presentation refreshed.');
      expect(fixture.document.activeElement).toBe(fixture.title);
    });
  });

  it('submits the acknowledged title with a cover while preserving and later committing local title typing', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      const title = options.body instanceof URLSearchParams
        ? options.body.get('title')
        : options.body.getAll('title')[0];
      return {
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: '44' }, book: { title },
        }),
      };
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: vi.fn(() => 'started'),
        ...acknowledgedCoverPresentationOptions(fixture),
      });
      fixture.title.value = 'Uncommitted title';
      fixture.cover.files = [{ name: 'cover.png' }];
      fixture.cover.dispatch('change');
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(requests[0].options.body.getAll('title')).toEqual(['Book']);
      expect(fixture.title.value).toBe('Uncommitted title');
      expect(fixture.status.textContent).toBe('Book cover saved.');

      fixture.title.dispatch('change');
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('title')).toBe('Uncommitted title');
      expect(fixture.status.textContent).toBe('Book title saved.');
    });
  });

  it('does not let an uncommitted blank title block an otherwise valid cover save', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: '45' }, book: { title: 'Book' },
        }),
      };
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: vi.fn(() => 'started'),
        ...acknowledgedCoverPresentationOptions(fixture),
      });
      fixture.title.value = '';
      fixture.cover.files = [{ name: 'cover.png' }];
      fixture.cover.dispatch('change');
      await flushAsync();

      expect(requests[0].options.body.getAll('title')).toEqual(['Book']);
      expect(fixture.title.value).toBe('');
      expect(fixture.status.textContent).toBe('Book cover saved.');
    });
  });

  it('uses a newly acknowledged title when a cover waits behind its active title mutation', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];

    await withBrowserGlobals((action, options) => {
      requests.push({ action, options });
      if (requests.length === 1) return new Promise((resolve) => { requests[0].resolve = resolve; });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: '46' }, book: { title: 'Title B' },
        }),
      });
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: vi.fn(() => 'started'),
        ...acknowledgedCoverPresentationOptions(fixture),
      });
      fixture.title.value = 'Title B';
      fixture.title.dispatch('change');
      fixture.cover.files = [{ name: 'cover.png' }];
      fixture.cover.dispatch('change');
      expect(requests).toHaveLength(1);

      requests[0].resolve({
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'none', id: '' }, book: { title: 'Title B' },
        }),
      });
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.getAll('title')).toEqual(['Title B']);
      expect(fixture.status.textContent).toBe('Book cover saved.');
    });
  });

  it('lets a newer title commit finish after an active cover without the cover overwriting it', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];

    await withBrowserGlobals((action, options) => {
      requests.push({ action, options });
      if (requests.length === 1) return new Promise((resolve) => { requests[0].resolve = resolve; });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: '47' }, book: { title: 'Title B' },
        }),
      });
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: vi.fn(() => 'started'),
        ...acknowledgedCoverPresentationOptions(fixture),
      });
      fixture.cover.files = [{ name: 'cover.png' }];
      fixture.cover.dispatch('change');
      await flushAsync();
      fixture.title.value = 'Title B';
      fixture.title.dispatch('change');
      expect(requests[0].options.body.getAll('title')).toEqual(['Book']);

      requests[0].resolve({
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: '47' }, book: { title: 'Book' },
        }),
      });
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('title')).toBe('Title B');
      expect(fixture.title.value).toBe('Title B');
      expect(fixture.status.textContent).toBe('Book title saved.');
    });
  });

  it('reconciles an uncertain title acknowledgement before dispatching one queued newer title', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];
    const canonicalRegion = { canonical: true };

    await withBrowserGlobals((action, options) => {
      if (options.method === 'POST' && requests.length === 0) {
        return new Promise((resolve, reject) => requests.push({ kind: 'post', action, options, resolve, reject }));
      }
      requests.push({ kind: 'post', action, options });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: '81' },
          book: { title: 'Queued title' },
        }),
      });
    }, async () => {
      const installDetail = vi.fn(() => 'installed');
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: vi.fn(() => 'started'),
        installDetail,
        installDialogPresentation: () => true,
        fetchAuthority: vi.fn(async () => ({
          destination: '/notes/books/7', detailRegion: canonicalRegion,
          title: 'Committed uncertain title', currentCover: { kind: 'managed_asset', id: '80' },
        })),
      });

      fixture.title.value = 'Committed uncertain title';
      fixture.title.dispatch('change');
      fixture.title.value = 'Queued title';
      fixture.title.dispatch('change');
      requests[0].reject(new Error('response lost'));
      await flushAsync();
      await flushAsync();

      expect(installDetail).toHaveBeenCalledWith(fixture.form.ownerDocument, '/notes/books/7', 4, canonicalRegion);
      expect(requests.filter(({ kind }) => kind === 'post')).toHaveLength(2);
      expect(requests[1].options.body.get('title')).toBe('Queued title');
      expect(fixture.attributes.get('data-book-edit-save-state')).toBe('saved');
      expect(fixture.attributes.has('aria-busy')).toBe(false);
      expect(fixture.title.disabled).toBe(false);
    });
  });

  it('does not replay an uncertain cover and sends a distinct never-dispatched cover with fresh identity', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];

    await withBrowserGlobals((action, options) => {
      if (requests.length === 0) return new Promise((resolve, reject) => requests.push({ action, options, resolve, reject }));
      requests.push({ action, options });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: '92' }, book: { title: 'Canonical title' },
        }),
      });
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 7,
        refresh: vi.fn(() => 'started'),
        installDetail: () => 'installed',
        installDialogPresentation: () => true,
        confirmCover: async () => true,
        fetchAuthority: vi.fn()
          .mockResolvedValueOnce({
            destination: '/notes/books/7', detailRegion: {}, coverPresentation: {},
            title: 'Canonical title', currentCover: { kind: 'managed_asset', id: '91' },
          })
          .mockResolvedValueOnce({
            destination: '/notes/books/7', detailRegion: {}, coverPresentation: {},
            title: 'Canonical title', currentCover: { kind: 'managed_asset', id: '92' },
          }),
        publishDetailAndDialog: (document, destination, generation, detailRegion, publishDialog) => (
          publishDialog() ? 'installed' : 'unavailable'
        ),
      });
      const uncertainFile = { name: 'uncertain.png' };
      const laterFile = { name: 'later.png' };
      fixture.cover.files = [uncertainFile];
      fixture.cover.dispatch('change');
      await flushAsync();
      fixture.cover.files = [laterFile];
      fixture.cover.dispatch('change');
      requests[0].reject(new Error('response lost'));
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.values.cover[0]).toBe(laterFile);
      expect(requests[1].options.body.getAll('title')).toEqual(['Canonical title']);
      expect(requests[1].options.body.getAll('expectedCoverId')).toEqual(['91']);
      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe('92');
    });
  });

  it('canonically reconciles a controlled stale cover before accepting a deliberate replacement', async () => {
    const fixture = makeBookEditFetchFixture();
    const staleFile = { name: 'stale-selection.png' };
    const replacementFile = { name: 'replacement.png' };
    const managedId = '4fb0c5e1-2c9a-4d9a-a8e1-83ad0d843730';
    const requests = [];
    let resolveAuthority;
    fixture.form.querySelector('input[name="expectedCoverKind"]').value = 'managed_asset';
    fixture.form.querySelector('input[name="expectedCoverId"]').value = 'cover-a';

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      if (requests.length === 1) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            status: 'error', code: 'STALE_SOURCE', message: 'Book cover changed since it was read.',
            currentCover: { kind: 'managed_asset', id: managedId },
          }),
        };
      }
      const submittedTitle = options.body instanceof URLSearchParams
        ? options.body.get('title')
        : options.body.getAll('title')[0];
      return {
        ok: true,
        json: async () => ({
          status: 'success', refreshUrl: '/notes/books/7',
          currentCover: { kind: 'managed_asset', id: 'cover-d' },
          book: { title: submittedTitle },
        }),
      };
    }, async () => {
      const installDetail = vi.fn(() => 'installed');
      const installDialogPresentation = vi.fn(() => true);
      const fetchAuthority = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveAuthority = resolve; }))
        .mockResolvedValueOnce({
          destination: '/notes/books/7', detailRegion: {}, coverPresentation: {},
          title: 'Canonical title', currentCover: { kind: 'managed_asset', id: 'cover-d' },
        });
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 9,
        refresh: vi.fn(() => 'started'),
        fetchAuthority,
        installDetail,
        installDialogPresentation,
        publishDetailAndDialog: (document, destination, generation, detailRegion, publishDialog) => (
          publishDialog() ? 'installed' : 'unavailable'
        ),
        confirmCover: async () => true,
      });

      fixture.title.value = 'Local uncommitted title';
      fixture.cover.value = 'C:\\fakepath\\stale-selection.png';
      fixture.cover.files = [staleFile];
      fixture.cover.dispatch('change');
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fetchAuthority).toHaveBeenCalledOnce();
      expect(fixture.cover.value).toBe('');
      expect(fixture.title.disabled).toBe(true);
      expect(fixture.cover.disabled).toBe(true);
      expect(fixture.status.textContent).toContain('selected replacement was not applied');
      expect(fixture.status.textContent).not.toContain('confirm whether');

      const detailRegion = { canonical: 'detail-b' };
      const coverPresentation = { canonical: 'cover-b' };
      resolveAuthority({
        destination: '/notes/books/7', detailRegion, coverPresentation,
        title: 'Canonical title', currentCover: { kind: 'managed_asset', id: managedId },
      });
      await flushAsync();
      await flushAsync();

      expect(installDetail).toHaveBeenCalledWith(fixture.form.ownerDocument, '/notes/books/7', 9, detailRegion);
      expect(installDialogPresentation).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ coverPresentation }),
      );
      expect(fixture.form.querySelector('input[name="expectedCoverKind"]').value).toBe('managed_asset');
      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe(managedId);
      expect(fixture.title.value).toBe('Local uncommitted title');
      expect(fixture.title.disabled).toBe(false);
      expect(fixture.cover.disabled).toBe(false);
      expect(fixture.status.textContent).toContain('current cover was refreshed');
      expect(fixture.status.textContent).toContain('choose the file again');
      expect(requests).toHaveLength(1);

      fixture.cover.files = [replacementFile];
      fixture.cover.dispatch('change');
      await flushAsync();
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.getAll('expectedCoverKind')).toEqual(['managed_asset']);
      expect(requests[1].options.body.getAll('expectedCoverId')).toEqual([managedId]);
      expect(requests[1].options.body.getAll('title')).toEqual(['Canonical title']);
      expect(requests[1].options.body.values.cover[0]).toBe(replacementFile);

      fixture.title.dispatch('change');
      await flushAsync();
      expect(requests).toHaveLength(3);
      expect(requests[2].options.body.get('title')).toBe('Local uncommitted title');
      expect(fixture.status.textContent).toBe('Book title saved.');
    });
  });

  it('keeps a controlled stale cover blocked through GET failure and Retry without replaying it', async () => {
    const fixture = makeBookEditFetchFixture();
    const rejectedFile = { name: 'rejected.png' };
    const requests = [];
    const fetchAuthority = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        destination: '/notes/books/7', detailRegion: {}, coverPresentation: {},
        title: 'Canonical title', currentCover: { kind: 'project_asset', id: '42' },
      });

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: false,
        status: 409,
        json: async () => ({
          status: 'error', code: 'STALE_SOURCE', message: 'Book cover changed since it was read.',
          currentCover: { kind: 'project_asset', id: '42' },
        }),
      };
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 3,
        fetchAuthority,
        installDetail: () => 'installed',
        installDialogPresentation: () => true,
        confirmCover: async () => true,
      });
      fixture.cover.value = 'C:\\fakepath\\rejected.png';
      fixture.cover.files = [rejectedFile];
      fixture.cover.dispatch('change');
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.cover.value).toBe('');
      expect(fixture.title.disabled).toBe(true);
      expect(fixture.cover.disabled).toBe(true);
      expect(fixture.attributes.get('aria-busy')).toBe('true');
      expect(fixture.status.textContent).toContain('selected replacement was not applied');
      expect(fixture.status.textContent).toContain('Retry reconciliation');

      fixture.body.children[0].focus();
      fixture.body.children[0].dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(fetchAuthority).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(1);
      expect(fixture.form.querySelector('input[name="expectedCoverKind"]').value).toBe('project_asset');
      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe('42');
      expect(fixture.title.disabled).toBe(false);
      expect(fixture.cover.disabled).toBe(false);
      expect(fixture.attributes.has('aria-busy')).toBe(false);
      expect(fixture.status.textContent).toContain('choose the file again');
      expect(fixture.document.activeElement).toBe(fixture.title);
    });
  });

  it('keeps Edit Book non-authoritative and blocked when uncertain reconciliation fails', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];
    await withBrowserGlobals((action, options) => {
      requests.push({ action, options });
      return Promise.reject(new Error('response lost'));
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 3,
        fetchAuthority: async () => null,
        installDetail: vi.fn(),
      });
      fixture.title.value = 'Uncertain';
      fixture.title.dispatch('change');
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.title.disabled).toBe(true);
      expect(fixture.cover.disabled).toBe(true);
      expect(fixture.attributes.get('aria-busy')).toBe('true');
      expect(fixture.status.textContent).toContain('Retry reconciliation');
      expect(fixture.status.textContent).not.toContain('Could not save');
    });
  });

  it('retries canonical reconciliation until a managed UUID authority is installed without replaying POST', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];
    const managedId = '4fb0c5e1-2c9a-4d9a-a8e1-83ad0d843730';
    const fetchAuthority = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        destination: '/notes/books/7', detailRegion: {}, title: 'Canonical title',
        currentCover: parseBookCoverAuthority('managed_asset', managedId),
      });

    await withBrowserGlobals((action, options) => {
      requests.push({ action, options });
      return Promise.reject(new Error('response lost'));
    }, async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 3,
        fetchAuthority,
        installDetail: () => 'installed',
        installDialogPresentation: () => true,
      });
      fixture.title.value = 'Uncertain';
      fixture.title.dispatch('change');
      await flushAsync();
      await flushAsync();

      fixture.body.children[0].focus();
      fixture.body.children[0].dispatch('click');
      await flushAsync();
      await flushAsync();
      expect(fixture.document.activeElement).toBe(fixture.body.children[0]);
      fixture.body.children[0].dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(fetchAuthority).toHaveBeenCalledTimes(3);
      expect(requests).toHaveLength(1);
      expect(fixture.form.querySelector('input[name="expectedCoverKind"]').value).toBe('managed_asset');
      expect(fixture.form.querySelector('input[name="expectedCoverId"]').value).toBe(managedId);
      expect(fixture.body.children).toHaveLength(0);
      expect(fixture.attributes.get('data-book-edit-save-state')).toBe('reconciled');
      expect(fixture.title.disabled).toBe(false);
      expect(fixture.cover.disabled).toBe(false);
      expect(fixture.document.activeElement).toBe(fixture.title);
    });
  });

  it('does not restore Retry focus into Edit Book after the dialog closes during recovery', async () => {
    const fixture = makeBookEditFetchFixture();
    let resolveAuthority;
    const authority = {
      destination: '/notes/books/7', detailRegion: {}, coverPresentation: {},
      title: 'Canonical saved title', currentCover: { kind: 'none', id: '' },
    };
    const fetchAuthority = vi.fn(() => new Promise((resolve) => { resolveAuthority = resolve; }));
    const outside = { focus() { fixture.document.activeElement = this; } };

    await withBrowserGlobals(async () => ({
      ok: true,
      json: async () => ({
        status: 'success', refreshUrl: '/notes/books/7',
        currentCover: { kind: 'none', id: '' }, book: { title: 'Saved title' },
      }),
    }), async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 4,
        refresh: () => 'unavailable',
        fetchAuthority,
        installDialogPresentation: () => true,
        publishDetailAndDialog: (document, destination, generation, detailRegion, publishDialog) => (
          publishDialog() ? 'installed' : 'unavailable'
        ),
      });
      fixture.title.value = 'Saved title';
      fixture.title.dispatch('change');
      await flushAsync();

      const retry = fixture.body.children[0];
      retry.focus();
      retry.dispatch('click');
      fixture.dialog.open = false;
      outside.focus();
      resolveAuthority(authority);
      await flushAsync();
      await flushAsync();

      expect(fixture.document.activeElement).toBe(outside);
      expect(fixture.body.children).toHaveLength(0);
    });
  });

  it('installs canonical title authority without overwriting newer uncommitted typing', async () => {
    const fixture = makeBookEditFetchFixture();
    const requests = [];
    await withBrowserGlobals((action, options) => new Promise((resolve, reject) => {
      requests.push({ action, options, resolve, reject });
    }), async () => {
      enhanceBookEditFetchSave(fixture.scope, {
        beginRefresh: () => 5,
        installDetail: () => 'installed',
        installDialogPresentation: () => true,
        fetchAuthority: async () => ({
          destination: '/notes/books/7', detailRegion: {}, title: 'Canonical committed title',
          currentCover: { kind: 'none', id: '' },
        }),
      });
      fixture.title.value = 'Submitted title';
      fixture.title.dispatch('change');
      fixture.title.value = 'Still typing';
      requests[0].reject(new Error('response lost'));
      await flushAsync();
      await flushAsync();

      expect(fixture.title.value).toBe('Still typing');
      expect(requests).toHaveLength(1);
      expect(fixture.attributes.has('aria-busy')).toBe(false);
    });
  });
});

describe('Settings fetch autosave enhancement', () => {
  it('uses an explicit opt-in mode without changing the existing bare or submit modes', async () => {
    const bare = makeEnabledFixture({ action: '/settings/asset-categories/12/enabled', checked: false });
    const submit = makeEnabledFixture({ action: '/settings/nsfw-filter', checked: false });
    const fetchSave = makeFetchSaveFixture();
    submit.control.dataset.autosubmit = 'submit';
    const calls = [];

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, text: async () => '<html>saved</html>' };
    }, async () => {
      enhanceAutoSubmit({ querySelectorAll: () => [bare.control, submit.control, fetchSave.controls[0]] });
      enhanceSettingsFetchSave({ querySelectorAll: () => fetchSave.controls });

      bare.control.checked = true;
      bare.control.dispatch('change');
      submit.control.dispatch('change');
      fetchSave.controls[0].value = 'changed';
      fetchSave.controls[0].dispatch('change');
      await flushAsync();

      expect(calls).toHaveLength(2);
      expect(bare.form.requestSubmitCount).toBe(0);
      expect(submit.form.requestSubmitCount).toBe(1);
      expect(fetchSave.form.requestSubmitCount).toBe(0);
      expect(fetchSave.form.submitCount).toBe(0);
    });
  });

  it('posts URL-encoded complete form data, preserves the control value, and exposes final response HTML', async () => {
    const fixture = makeFetchSaveFixture({
      action: '/settings/defaults',
      values: { defaultProjectStatus: 'active', releasesSort: 'name' },
    });
    const calls = [];
    const successes = [];

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, text: async () => '<main>authoritative settings</main>' };
    }, async () => {
      enhanceSettingsFetchSave(
        { querySelectorAll: () => fixture.controls },
        { onSuccess: (detail) => successes.push(detail) },
      );

      fixture.controls[0].value = 'archived';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      expect(calls).toHaveLength(1);
      expect(calls[0].action).toBe('/settings/defaults');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].options.credentials).toBe('same-origin');
      expect(calls[0].options.redirect).toBe('follow');
      expect(calls[0].options.headers['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
      expect(calls[0].options.body).toBeInstanceOf(URLSearchParams);
      expect(calls[0].options.body.get('_csrf')).toBe('csrf-fetch-save');
      expect(calls[0].options.body.get('defaultProjectStatus')).toBe('archived');
      expect(calls[0].options.body.get('releasesSort')).toBe('name');
      expect(fixture.controls[0].value).toBe('archived');
      expect(fixture.status.textContent).toBe('Settings saved.');
      expect(fixture.status.attributes.get('role')).toBe('status');
      expect(fixture.status.attributes.get('aria-live')).toBe('polite');
      expect(fixture.form.hasAttribute('aria-busy')).toBe(false);
      expect(successes).toHaveLength(1);
      expect(successes[0].html).toBe('<main>authoritative settings</main>');
      expect(successes[0].payload).toContain('defaultProjectStatus=archived');
    });
  });

  it('coalesces A → B → C to the latest complete payload and only publishes Saved after C succeeds', async () => {
    const fixture = makeFetchSaveFixture({ values: { defaultProjectStatus: 'active', theme: 'light' } });
    const requests = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceSettingsFetchSave({ querySelectorAll: () => fixture.controls });
      enhanceSettingsFetchSave({ querySelectorAll: () => fixture.controls });
      expect(fixture.controls[0].listeners).toHaveLength(1);

      fixture.controls[0].value = 'A';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[0].value = 'B';
      fixture.controls[0].dispatch('change');
      fixture.controls[0].value = 'C';
      fixture.controls[0].dispatch('change');

      expect(requests).toHaveLength(1);
      requests[0].resolve({ ok: true, redirected: true, text: async () => '<main>a</main>' });
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(fixture.status.textContent).toBe('Saving settings.');
      expect(requests[1].options.body.get('defaultProjectStatus')).toBe('C');
      expect(requests[1].options.body.get('theme')).toBe('light');

      requests[1].resolve({ ok: true, redirected: true, text: async () => '<main>b</main>' });
      await flushAsync();
      expect(fixture.status.textContent).toBe('Settings saved.');
      expect(fixture.form.hasAttribute('aria-busy')).toBe(false);
    });
  });

  it('attributes coalesced control changes only to their acknowledged request', async () => {
    const fixture = makeFetchSaveFixture({ values: { status: 'planned', view: 'list', weekStart: 'monday' } });
    const [status, view, weekStart] = fixture.controls;
    const requests = [];
    const acknowledged = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ options, resolve });
    }), async () => {
      enhanceSettingsFetchSave(
        { querySelectorAll: () => fixture.controls },
        { onAcknowledged: (detail) => acknowledged.push(detail) },
      );

      status.value = 'published';
      status.dispatch('change');
      await flushAsync();
      view.value = 'grid';
      view.dispatch('change');
      weekStart.value = 'sunday';
      weekStart.dispatch('change');
      expect(requests).toHaveLength(1);

      requests[0].resolve({ ok: true, redirected: true, text: async () => '' });
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(acknowledged[0].controlName).toBe('status');
      expect([...acknowledged[0].controlNames]).toEqual(['status']);
      expect(requests[1].options.body.get('view')).toBe('grid');
      expect(requests[1].options.body.get('weekStart')).toBe('sunday');

      requests[1].resolve({ ok: true, redirected: true, text: async () => '' });
      await flushAsync();
      expect(acknowledged[1].controlName).toBe('weekStart');
      expect([...acknowledged[1].controlNames]).toEqual(['view', 'weekStart']);

      status.value = 'planned';
      status.dispatch('change');
      await flushAsync();
      requests[2].resolve({ ok: true, redirected: true, text: async () => '' });
      await flushAsync();
      expect([...acknowledged[2].controlNames]).toEqual(['status']);

      status.value = 'published';
      status.dispatch('change');
      await flushAsync();
      view.value = 'list';
      view.dispatch('change');
      weekStart.value = 'monday';
      weekStart.dispatch('change');
      view.value = 'grid';
      view.dispatch('change');
      requests[3].resolve({ ok: true, redirected: true, text: async () => '' });
      await flushAsync();
      expect(requests).toHaveLength(5);
      requests[4].resolve({ ok: true, redirected: true, text: async () => '' });
      await flushAsync();
      expect([...acknowledged[4].controlNames]).toEqual(['weekStart']);
    });
  });

  it.each([false, true])('attributes a queued full-form save after an active failure (view reverted: %s)', async (reverted) => {
    const fixture = makeFetchSaveFixture({ values: { view: 'list', weekStart: 'monday' } });
    const [view, weekStart] = fixture.controls;
    const requests = [];
    const acknowledged = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ options, resolve });
    }), async () => {
      enhanceSettingsFetchSave(
        { querySelectorAll: () => fixture.controls },
        { onAcknowledged: (detail) => acknowledged.push(detail) },
      );

      view.value = 'grid';
      view.dispatch('change');
      await flushAsync();
      weekStart.value = 'sunday';
      weekStart.dispatch('change');
      if (reverted) {
        view.value = 'list';
        view.dispatch('change');
      }

      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '' });
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('view')).toBe(reverted ? 'list' : 'grid');
      expect(requests[1].options.body.get('weekStart')).toBe('sunday');

      requests[1].resolve({ ok: true, redirected: true, text: async () => '' });
      await flushAsync();
      expect(acknowledged).toHaveLength(1);
      expect([...acknowledged[0].controlNames]).toEqual(reverted ? ['weekStart'] : ['view', 'weekStart']);
    });
  });

  it('does not dispatch a queued reversion after the active request fails', async () => {
    const fixture = makeFetchSaveFixture({ values: { view: 'list', weekStart: 'monday' } });
    const [view, weekStart] = fixture.controls;
    const requests = [];
    const errors = [];
    const validations = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ options, resolve });
    }), async () => {
      enhanceSettingsFetchSave(
        { querySelectorAll: () => fixture.controls },
        {
          onError: (detail) => errors.push(detail),
          onValidationError: (detail) => validations.push(detail),
        },
      );
      view.value = 'grid';
      view.dispatch('change');
      await flushAsync();
      weekStart.value = 'sunday';
      weekStart.dispatch('change');
      view.value = 'list';
      view.dispatch('change');
      weekStart.value = 'monday';
      weekStart.dispatch('change');

      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '' });
      await flushAsync();
      expect(requests).toHaveLength(1);
      expect(view.value).toBe('list');
      expect(weekStart.value).toBe('monday');
      expect(errors[0].superseded).toBe(true);
      expect(validations[0].superseded).toBe(true);
      expect(fixture.form.hasAttribute('aria-busy')).toBe(false);
      expect(fixture.status.textContent).toContain('Could not save settings');
    });
  });

  it('keeps the page loaded for server validation and network failures, and retries a queued newer state', async () => {
    const fixture = makeFetchSaveFixture();
    const requests = [];
    const validations = [];
    const errors = [];

    await withBrowserGlobals((action, options) => new Promise((resolve, reject) => {
      requests.push({ action, options, resolve, reject });
    }), async () => {
      enhanceSettingsFetchSave(
        { querySelectorAll: () => fixture.controls },
        {
          onValidationError: (detail) => validations.push(detail),
          onError: (detail) => errors.push(detail),
        },
      );

      fixture.controls[0].value = 'invalid';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[0].value = 'valid';
      fixture.controls[0].dispatch('change');

      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<form><p>Authoritative error</p></form>' });
      await flushAsync();

      expect(validations).toHaveLength(1);
      expect(validations[0].html).toContain('Authoritative error');
      expect(validations[0].superseded).toBe(true);
      expect(errors[0].superseded).toBe(true);
      expect(requests).toHaveLength(2);
      expect(fixture.status.textContent).toBe('Saving settings.');
      expect(requests[1].options.body.get('value')).toBe('valid');

      requests[1].reject(new Error('offline'));
      await flushAsync();
      expect(fixture.status.textContent).toContain('Could not save settings');
      expect(fixture.status.textContent).not.toContain('Saved');
      expect(fixture.form.hasAttribute('aria-busy')).toBe(false);
      expect(fixture.form.requestSubmitCount).toBe(0);
      expect(fixture.form.submitCount).toBe(0);
      expect(errors[1].type).toBe('network');
      expect(errors[1].superseded).toBe(false);
    });
  });

  it('clears a queued B when the user returns to in-flight A', async () => {
    const fixture = makeFetchSaveFixture({ values: { value: 'A' } });
    const requests = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceSettingsFetchSave({ querySelectorAll: () => fixture.controls });

      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[0].value = 'B';
      fixture.controls[0].dispatch('change');
      fixture.controls[0].value = 'A';
      fixture.controls[0].dispatch('change');

      requests[0].resolve({ ok: true, redirected: true, text: async () => '<main>a</main>' });
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(requests[0].options.body.get('value')).toBe('A');
      expect(fixture.status.textContent).toBe('Settings saved.');
      expect(fixture.form.hasAttribute('aria-busy')).toBe(false);
    });
  });

  it('leaves authoritative validation content rendered by the validation hook untouched', async () => {
    const fixture = makeFetchSaveFixture();
    const requests = [];
    const validations = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceSettingsFetchSave(
        { querySelectorAll: () => fixture.controls },
        {
          onValidationError: (detail) => {
            validations.push(detail);
            fixture.status.textContent = 'Server validation: choose a valid setting.';
          },
        },
      );

      fixture.controls[0].value = 'invalid';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<form>validation</form>' });
      await flushAsync();

      expect(fixture.status.textContent).toBe('Server validation: choose a valid setting.');
      expect(validations[0].superseded).toBe(false);
      expect(fixture.form.hasAttribute('aria-busy')).toBe(false);
    });
  });

  it('binds only marked controls, including detached form-associated controls, and ignores fetch-marked forms and orphans', async () => {
    const fixture = makeFetchSaveFixture();
    const formOnly = makeFetchSaveFixture();
    formOnly.form.dataset.autosubmit = 'fetch';
    delete formOnly.controls[0].dataset.autosubmit;
    const orphan = makeCheckbox();
    orphan.dataset.autosubmit = 'fetch';
    const scope = {
      querySelectorAll: () => [fixture.controls[0], formOnly.form, orphan],
    };
    const calls = [];

    expect(enhanceSettingsFetchSave({ querySelectorAll: () => [formOnly.form] })).toBe(0);
    expect(enhanceSettingsFetchSave({ querySelectorAll: () => [orphan] })).toBe(0);

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, text: async () => '<main>saved</main>' };
    }, async () => {
      expect(enhanceSettingsFetchSave(scope)).toBe(1);
      expect(enhanceSettingsFetchSave(scope)).toBe(0);
      expect(fixture.controls[0].listeners).toHaveLength(1);
      expect(formOnly.controls[0].listeners).toHaveLength(0);

      fixture.controls[0].dispatch('change');
      await flushAsync();
      expect(calls).toHaveLength(1);
    });
  });

  it('binds a newly replaced marked control on a surviving form', async () => {
    const fixture = makeFetchSaveFixture();
    const calls = [];

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, text: async () => '<main>saved</main>' };
    }, async () => {
      expect(enhanceSettingsFetchSave({ querySelectorAll: () => fixture.controls })).toBe(1);
      const replacement = makeCheckbox();
      replacement.name = 'value';
      replacement.value = 'replaced';
      replacement.dataset.autosubmit = 'fetch';
      replacement.form = fixture.form;
      fixture.form.controls = [replacement];

      expect(enhanceSettingsFetchSave({ querySelectorAll: () => [replacement] })).toBe(1);
      expect(replacement.listeners).toHaveLength(1);
      replacement.dispatch('change');
      await flushAsync();

      expect(calls).toHaveLength(1);
      expect(calls[0].options.body.get('value')).toBe('replaced');
    });
  });
});

describe('Open Locally fetch-save adoption', () => {
  function makeOpenLocallyFetchFixture() {
    const fixture = makeFetchSaveFixture({
      action: '/settings/open-locally',
      values: { windowsProjectsPath: 'D:\\example' },
    });
    const listeners = [];
    const region = {
      parentNode: {},
      querySelector(selector) {
        return selector === '#open-locally-save-form' ? fixture.form : null;
      },
      querySelectorAll(selector) {
        return selector === '#open-locally-save-form' ? [fixture.form] : [];
      },
    };
    const document = {
      querySelector(selector) {
        return selector === '[data-settings-open-locally-path]' ? fixture.controls[0] : null;
      },
    };
    fixture.form.ownerDocument = document;
    fixture.form.closest = (selector) => selector === '[data-settings-open-locally-mapping-region]' ? region : null;
    fixture.form.addEventListener = (type, handler) => listeners.push({ type, handler });
    fixture.form.dispatch = (type) => {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
      return event;
    };
    fixture.controls[0].dataset.settingsOpenLocallyPath = '';
    return {
      ...fixture,
      clearForm: { dispatch() { return { defaultPrevented: false }; } },
      scope: {
        querySelector: document.querySelector,
        querySelectorAll(selector) {
          return selector === '#open-locally-save-form' ? [fixture.form] : [];
        },
      },
    };
  }

  it('routes Save and Enter submit through the C7C queue without intercepting the independent Clear form', async () => {
    const fixture = makeOpenLocallyFetchFixture();
    const requests = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      expect(enhanceOpenLocallyFetchSave(fixture.scope)).toBe(2);
      expect(enhanceOpenLocallyFetchSave(fixture.scope)).toBe(0);

      fixture.controls[0].dispatch('change');
      await flushAsync();
      const saveEvent = fixture.form.dispatch('submit');
      const enterEvent = fixture.form.dispatch('submit');

      expect(saveEvent.defaultPrevented).toBe(true);
      expect(enterEvent.defaultPrevented).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0].action).toBe('/settings/open-locally');
      expect(fixture.clearForm.dispatch('submit').defaultPrevented).toBe(false);

      requests[0].resolve({ ok: true, redirected: true, text: async () => '<html>saved</html>' });
      await flushAsync();
      expect(fixture.status.textContent).toBe('Settings saved.');
    });
  });
});

describe('Defaults fetch autosave adoption', () => {
  it.each([
    ['imagesPreviewWebpQuality', true],
    ['clockFormat', false],
  ])('refreshes rebuild status immediately only after a successful %s save', async (name, expectRefresh) => {
    const fixture = makeDefaultsFetchFixture({ name, value: '70' });
    const replacement = makeDefaultsFetchFixture({ name, value: '85' });
    for (const item of [fixture, replacement]) {
      item.cards[name] = { appendChild(status) { status.parentNode = this; } };
    }
    const nodes = {
      '[data-rebuild-message]': { textContent: '' },
      '[data-rebuild-details]': { textContent: '', hidden: true },
      '[data-generated-images-rebuild-button]': { disabled: false },
    };
    const card = {
      dataset: { rebuildPhase: 'idle', rebuildRunId: '' },
      querySelector: (selector) => nodes[selector] || null,
    };
    const windowEvents = new Map();
    const document = {
      location: { href: 'http://localhost/settings/defaults' },
      defaultView: { setTimeout, clearTimeout, addEventListener(name, handler) { windowEvents.set(name, handler); } },
      querySelector: (selector) => selector === '[data-generated-images-rebuild]' ? card : null,
      addEventListener() {},
    };
    fixture.scope.ownerDocument = document;
    fixture.form.ownerDocument = document;
    replacement.region.ownerDocument = document;
    replacement.form.ownerDocument = document;
    const requests = [];
    await withDefaultsDomParser(() => ({
      querySelector: (selector) => selector === '[data-settings-defaults-region]' ? replacement.region : null,
    }), async () => withBrowserGlobals(async (url) => {
      requests.push(url);
      if (url === '/settings/defaults/generated-images/rebuild-status') {
        return { ok: true, json: async () => ({ phase: 'completed', runId: 'saved-run', total: 0 }) };
      }
      return { ok: true, redirected: true, text: async () => '<html>saved</html>' };
    }, async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      fixture.controls[0].value = '85';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      expect(requests.filter((url) => url === '/settings/defaults/generated-images/rebuild-status'))
        .toHaveLength(expectRefresh ? 1 : 0);
      if (expectRefresh) expect(card.dataset.rebuildRunId).toBe('saved-run');
    }));
    windowEvents.get('pagehide')();
  });

  it.each([
    ['clockFormat', '24h', '12h', 'clockFormat'],
    ['noteRevisionRetention', '10', '27', 'noteRevisionRetention'],
  ])('keeps %s autosave feedback inside its card', async (name, initial, saved, payloadName) => {
    const fixture = makeDefaultsFetchFixture({ name, value: initial });
    const replacement = makeDefaultsFetchFixture({ name, value: saved });
    const requests = [];

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => selector === '[data-settings-defaults-region]' ? replacement.region : null,
    }), async () => withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return { ok: true, redirected: true, text: async () => '<html>saved</html>' };
    }, async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      fixture.controls[0].value = saved;
      fixture.controls[0].dispatch('change');
      expect(fixture.status.parentNode).toBe(fixture.cards[name]);
      expect(fixture.status.textContent).toBe('Saving settings.');
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(requests[0].action).toBe('/settings/defaults');
      expect(requests[0].options.body.get(payloadName)).toBe(saved);
      expect(replacement.status.parentNode).toBe(replacement.cards[name]);
      expect(replacement.status.textContent).toBe('Settings saved.');
      expect(replacement.status.attributes.get('role')).toBe('status');
      expect(replacement.status.attributes.get('aria-live')).toBe('polite');
      expect(replacement.status.attributes.get('aria-atomic')).toBe('true');
    }));
  });

  it('saves the native New Project Status control in place and replaces its authoritative region', async () => {
    const fixture = makeDefaultsFetchFixture();
    const replacement = makeDefaultsFetchFixture({ value: 'ready' });

    await withDefaultsDomParser(() => ({
      querySelector(selector) {
        return selector === '[data-settings-defaults-region]'
          ? replacement.region
          : null;
      },
    }), async () => withBrowserGlobals(async () => ({
      ok: true,
      redirected: true,
      text: async () => '<html>success</html>',
    }), async () => {
      expect(enhanceDefaultsFetchSave(fixture.scope)).toBe(1);
      fixture.controls[0].value = 'ready';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      expect(fixture.form.requestSubmitCount).toBe(0);
      expect(fixture.form.submitCount).toBe(0);
      expect(fixture.controls[0].value).toBe('ready');
      expect(fixture.region.replacement).toBe(replacement.region);
      expect(replacement.controls[0].listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
      expect(replacement.numberInputQueries.count).toBe(1);
      expect(fixture.status.textContent).toBe('Settings saved.');
    }));
  });

  it('renders authoritative validation markup in place and re-enhances its replacement control', async () => {
    const fixture = makeDefaultsFetchFixture({ name: 'clockFormat', value: '24h' });
    const replacement = makeDefaultsFetchFixture({ name: 'clockFormat', value: 'invalid' });
    const nextRegion = {
      parentNode: {},
      querySelector(selector) {
        return selector === '#settings-defaults-form' ? replacement.form : null;
      },
      querySelectorAll(selector) {
        if (selector === '#settings-defaults-form') return [replacement.form];
        if (selector === '[data-cc-dropdown]') return [];
        return [];
      },
    };

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => selector === '[data-settings-defaults-region]' ? nextRegion : null,
    }), async () => withBrowserGlobals(async () => ({
      ok: false,
      redirected: false,
      status: 422,
      text: async () => '<html>validation</html>',
    }), async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      fixture.controls[0].value = 'invalid';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      expect(fixture.region.replacement).toBe(nextRegion);
      expect(replacement.controls[0].listeners).toHaveLength(1);
      expect(fixture.form.requestSubmitCount).toBe(0);
      expect(replacement.status.textContent).toBe('');
    }));
  });

  it('keeps a network save error in the changed card', async () => {
    const fixture = makeDefaultsFetchFixture({ name: 'noteRevisionRetention', value: '10' });

    await withBrowserGlobals(async () => { throw new Error('offline'); }, async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      fixture.controls[0].value = '27';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      expect(fixture.status.parentNode).toBe(fixture.cards.noteRevisionRetention);
      expect(fixture.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(fixture.status.attributes.get('role')).toBe('status');
      expect(fixture.status.attributes.get('aria-live')).toBe('polite');
      expect(fixture.status.attributes.get('aria-atomic')).toBe('true');
    });
  });

  it('does not replace Defaults markup for a superseded validation response', async () => {
    const fixture = makeDefaultsFetchFixture();
    const requests = [];
    const nextRegion = { parentNode: {} };

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => selector === '[data-settings-defaults-region]' ? nextRegion : null,
    }), async () => withBrowserGlobals(() => new Promise((resolve) => requests.push(resolve)), async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      fixture.controls[0].value = 'invalid';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[0].value = 'ready';
      fixture.controls[0].dispatch('change');

      requests[0]({ ok: false, redirected: false, status: 422, text: async () => '<html>validation</html>' });
      await flushAsync();

      expect(fixture.region.replacement).toBe(null);
      expect(requests).toHaveLength(2);
      expect(fixture.status.textContent).toBe('Saving settings.');
    }));
  });
});

function makeNsfwFetchFixture({ checked = false } = {}) {
  const fixture = makeEnabledFixture({ action: '/settings/nsfw-filter', checked });
  const region = {
    parentNode: {},
    replacement: null,
    replaceWith(next) { this.replacement = next; },
    querySelector(selector) {
      return selector === 'form' ? fixture.form : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-settings-nsfw-filter-region] form' ? [fixture.form] : [];
    },
  };
  const querySelector = fixture.form.querySelector.bind(fixture.form);
  fixture.control.dataset.autosubmit = 'fetch';
  fixture.form.closest = (selector) => selector === '[data-settings-nsfw-filter-region]' ? region : null;
  fixture.form.querySelector = (selector) => {
    if (selector === '[data-settings-fetch-save-status]') return fixture.status;
    return querySelector(selector);
  };
  fixture.form.querySelectorAll = (selector) => (
    selector === '[data-autosubmit="fetch"]' ? [fixture.control] : []
  );
  return {
    ...fixture,
    region,
    scope: {
      querySelectorAll(selector) {
        return selector === '[data-settings-nsfw-filter-region] form' ? [fixture.form] : [];
      },
    },
  };
}

describe('NSFW Filter fetch autosave adoption', () => {
  it('posts the browser switch payload in place without native submission', async () => {
    const fixture = makeNsfwFetchFixture();
    const replacement = makeNsfwFetchFixture({ checked: false });
    const calls = [];

    await withDefaultsDomParser(() => ({
      querySelector(selector) {
        return selector === '[data-settings-nsfw-filter-region]' ? replacement.region : null;
      },
    }), async () => withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, text: async () => '<html>saved</html>' };
    }, async () => {
      enhanceAutoSubmit({ querySelectorAll: () => [fixture.control] });
      expect(enhanceNsfwFilterFetchSave(fixture.scope)).toBe(1);

      fixture.control.checked = true;
      fixture.control.dispatch('change');
      await flushAsync();

      fixture.control.checked = false;
      fixture.control.dispatch('change');
      await flushAsync();

      expect(calls).toHaveLength(2);
      expect(calls.map(({ action }) => action)).toEqual(['/settings/nsfw-filter', '/settings/nsfw-filter']);
      expect(calls[0].options.body.getAll('enabled')).toEqual(['0', '1']);
      expect(calls[1].options.body.getAll('enabled')).toEqual(['0']);
      expect(fixture.form.requestSubmitCount).toBe(0);
      expect(fixture.form.submitCount).toBe(0);
      expect(fixture.region.replacement).toBe(replacement.region);
      expect(replacement.control.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
      expect(fixture.status.textContent).toBe('Settings saved.');
    }));
  });

  it('skips a redundant queued toggle after a failed active request', async () => {
    const fixture = makeNsfwFetchFixture();
    const requests = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceNsfwFilterFetchSave(fixture.scope);

      fixture.control.checked = true;
      fixture.control.dispatch('change');
      await flushAsync();
      fixture.control.checked = false;
      fixture.control.dispatch('change');

      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<html>stale</html>' });
      await flushAsync();

      expect(fixture.region.replacement).toBeNull();
      expect(requests).toHaveLength(1);
      expect(fixture.control.checked).toBe(false);
      expect(fixture.status.textContent).toContain('Could not save settings');
    });
  });

  it('keeps a reverted switch when the in-flight validation markup is stale', async () => {
    const fixture = makeNsfwFetchFixture();
    const stale = makeNsfwFetchFixture({ checked: true });
    const requests = [];

    await withDefaultsDomParser(() => ({
      querySelector(selector) {
        return selector === '[data-settings-nsfw-filter-region]' ? stale.region : null;
      },
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ options, resolve });
    }), async () => {
      enhanceNsfwFilterFetchSave(fixture.scope);
      fixture.control.checked = true;
      fixture.control.dispatch('change');
      await flushAsync();
      expect(requests[0].options.body.getAll('enabled')).toEqual(['0', '1']);

      fixture.control.checked = false;
      fixture.control.dispatch('change');
      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<html>stale</html>' });
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.control.checked).toBe(false);
      expect(fixture.region.replacement).toBeNull();
      expect(stale.control.listeners).toHaveLength(0);
    }));
  });

  it('replaces and re-enhances only the authoritative NSFW region after validation', async () => {
    const fixture = makeNsfwFetchFixture();
    const replacement = makeNsfwFetchFixture({ checked: true });
    const requests = [];

    await withDefaultsDomParser(() => ({
      querySelector(selector) {
        return selector === '[data-settings-nsfw-filter-region]' ? replacement.region : null;
      },
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceNsfwFilterFetchSave(fixture.scope);
      fixture.control.checked = true;
      fixture.control.dispatch('change');
      await flushAsync();

      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<html>validation</html>' });
      await flushAsync();

      expect(fixture.region.replacement).toBe(replacement.region);
      expect(replacement.control.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
      expect(enhanceNsfwFilterFetchSave(replacement.region)).toBe(0);
    }));
  });

  it('keeps the latest visible state and reports a recoverable network error', async () => {
    const fixture = makeNsfwFetchFixture();

    await withBrowserGlobals(async () => {
      throw new Error('offline');
    }, async () => {
      enhanceNsfwFilterFetchSave(fixture.scope);
      fixture.control.checked = true;
      fixture.control.dispatch('change');
      await flushAsync();

      expect(fixture.control.checked).toBe(true);
      expect(fixture.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(fixture.form.requestSubmitCount).toBe(0);
      expect(fixture.form.submitCount).toBe(0);
    });
  });
});

function makeAssetCategoryPreferenceFetchFixture({ action = '/settings/asset-categories/browser-default', value = 'all' } = {}) {
  const fixture = makeFetchSaveFixture({ action, values: { category: value } });
  const secondary = {
    parentNode: {},
    replacement: null,
    replaceWith(next) { this.replacement = next; },
  };
  const region = {
    parentNode: {},
    replacement: null,
    querySelector(selector) {
      if (selector === 'form') return fixture.form;
      return selector === '[data-settings-asset-category-preference-secondary]' ? secondary : null;
    },
    querySelectorAll(selector) {
      if (selector === 'form' || selector === '[data-settings-asset-category-preference] form') return [fixture.form];
      if (selector === '[data-cc-dropdown]') return [];
      return [];
    },
    replaceWith(next) { this.replacement = next; },
    getAttribute(name) {
      if (name !== 'data-settings-asset-category-preference') return null;
      return action.endsWith('/preview-category') ? 'preview-category' : 'browser-default';
    },
  };
  const querySelectorAll = fixture.form.querySelectorAll.bind(fixture.form);
  fixture.form.closest = (selector) => selector === '[data-settings-asset-category-preference]' ? region : null;
  fixture.form.querySelectorAll = (selector) => {
    if (selector === '[data-autosubmit="fetch"]') return fixture.controls;
    return querySelectorAll(selector);
  };
  return {
    ...fixture,
    region,
    secondary,
    scope: {
      querySelectorAll(selector) {
        return selector === '[data-settings-asset-category-preference] form' ? [fixture.form] : [];
      },
    },
  };
}

async function withAssetCategoryPreferenceDomParser(parser, callback) {
  const originalDOMParser = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString(html) { return parser(html); }
  };
  try {
    return await callback();
  } finally {
    globalThis.DOMParser = originalDOMParser;
  }
}

describe('Asset Categories fetch autosave adoption', () => {
  it('saves Default and Preview through independent C7C form queues without native submission', async () => {
    const defaultFixture = makeAssetCategoryPreferenceFetchFixture();
    const previewFixture = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'wip',
    });
    const calls = [];
    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-settings-asset-category-preference] form'
          ? [defaultFixture.form, previewFixture.form]
          : [];
      },
    };

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, text: async () => '<html>saved</html>' };
    }, async () => {
      expect(enhanceAssetCategoryPreferencesFetchSave(scope)).toBe(2);
      defaultFixture.controls[0].value = 'final';
      previewFixture.controls[0].value = 'wip';
      defaultFixture.controls[0].dispatch('change');
      previewFixture.controls[0].dispatch('change');
      await flushAsync();

      expect(calls).toHaveLength(2);
      expect(calls.map(({ action }) => action)).toEqual([
        '/settings/asset-categories/browser-default',
        '/settings/asset-categories/preview-category',
      ]);
      expect(defaultFixture.controls[0].value).toBe('final');
      expect(previewFixture.controls[0].value).toBe('wip');
      expect(defaultFixture.form.requestSubmitCount).toBe(0);
      expect(previewFixture.form.requestSubmitCount).toBe(0);
      expect(defaultFixture.form.submitCount).toBe(0);
      expect(previewFixture.form.submitCount).toBe(0);
    });
  });

  it('replaces and re-enhances the matching Default region after a followed redirect', async () => {
    const fixture = makeAssetCategoryPreferenceFetchFixture();
    const replacement = makeAssetCategoryPreferenceFetchFixture({ value: 'final' });

    await withAssetCategoryPreferenceDomParser(() => ({
      querySelectorAll(selector) {
        return selector === '[data-settings-asset-category-preference]'
          ? [replacement.region]
          : [];
      },
    }), async () => withBrowserGlobals(async () => ({
      ok: true,
      redirected: true,
      text: async () => '<html>success</html>',
    }), async () => {
      enhanceAssetCategoryPreferencesFetchSave(fixture.scope);
      fixture.controls[0].value = 'final';
      fixture.controls[0].dispatch('change');
      await flushAsync();

      expect(fixture.region.replacement).toBe(replacement.region);
      expect(replacement.controls[0].listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
      expect(fixture.status.textContent).toBe('Settings saved.');
      expect(fixture.form.requestSubmitCount).toBe(0);
    }));
  });

  it('selects the same identified card from a two-region validation response', async () => {
    const browser = makeAssetCategoryPreferenceFetchFixture();
    const preview = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'invalid',
    });
    const browserResponse = makeAssetCategoryPreferenceFetchFixture({ value: 'all' });
    const previewResponse = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'wip',
    });
    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-settings-asset-category-preference] form'
          ? [browser.form, preview.form]
          : [];
      },
    };

    await withAssetCategoryPreferenceDomParser(() => ({
      querySelectorAll(selector) {
        return selector === '[data-settings-asset-category-preference]'
          ? [browserResponse.region, previewResponse.region]
          : [];
      },
    }), async () => withBrowserGlobals(async () => ({
      ok: false,
      redirected: false,
      status: 422,
      text: async () => '<html>both preference regions</html>',
    }), async () => {
      enhanceAssetCategoryPreferencesFetchSave(scope);

      preview.controls[0].dispatch('change');
      await flushAsync();
      expect(preview.region.replacement).toBe(previewResponse.region);
      expect(browser.region.replacement).toBeNull();
      expect(previewResponse.form.action).toBe('/settings/asset-categories/preview-category');
      expect(previewResponse.controls[0].listeners).toHaveLength(1);

      browser.controls[0].dispatch('change');
      await flushAsync();
      expect(browser.region.replacement).toBe(browserResponse.region);
      expect(previewResponse.region.replacement).toBeNull();
      expect(browserResponse.form.action).toBe('/settings/asset-categories/browser-default');
      expect(browserResponse.controls[0].listeners).toHaveLength(1);
    }));
  });

  it('does not replace stale markup for a superseded validation response', async () => {
    const fixture = makeAssetCategoryPreferenceFetchFixture();
    const requests = [];
    const staleResponse = makeAssetCategoryPreferenceFetchFixture({ value: 'invalid' });

    await withAssetCategoryPreferenceDomParser(() => ({
      querySelectorAll(selector) {
        return selector === '[data-settings-asset-category-preference]' ? [staleResponse.region] : [];
      },
    }), async () => withBrowserGlobals(() => new Promise((resolve) => requests.push(resolve)), async () => {
      enhanceAssetCategoryPreferencesFetchSave(fixture.scope);
      fixture.controls[0].value = 'invalid';
      fixture.controls[0].dispatch('change');
      await flushAsync();
      fixture.controls[0].value = 'final';
      fixture.controls[0].dispatch('change');

      requests[0]({ ok: false, redirected: false, status: 422, text: async () => '<html>validation</html>' });
      await flushAsync();

      expect(fixture.region.replacement).toBe(null);
      expect(requests).toHaveLength(2);
      expect(fixture.status.textContent).toBe('Saving settings.');
    }));
  });
});

function makeOpenLocallyReviewerFixture() {
  const fixture = makeFetchSaveFixture({
    action: '/settings/open-locally',
    values: { windowsProjectsPath: 'D:\\example' },
  });
  const listeners = [];
  const region = {
    parentNode: {},
    replacement: null,
    querySelector(selector) {
      if (selector === '#open-locally-save-form') return fixture.form;
      if (selector === '[data-settings-open-locally-path]') return fixture.controls[0];
      return null;
    },
    querySelectorAll(selector) {
      return selector === '#open-locally-save-form' ? [fixture.form] : [];
    },
  };
  fixture.form.closest = (selector) => (
    selector === '[data-settings-open-locally-mapping-region]' ? region : null
  );
  fixture.form.addEventListener = (type, handler) => listeners.push({ type, handler });
  fixture.form.dispatch = (type) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
    return event;
  };
  fixture.controls[0].dataset.settingsOpenLocallyPath = '';
  return {
    ...fixture,
    region,
    scope: {
      querySelector(selector) {
        return selector === '[data-settings-open-locally-path]' ? fixture.controls[0] : null;
      },
      querySelectorAll(selector) {
        return selector === '#open-locally-save-form' ? [fixture.form] : [];
      },
    },
  };
}

function makeFocusDocument() {
  const targets = new Map();
  return {
    activeElement: null,
    getElementById(id) { return targets.get(id) || null; },
    register(...elements) {
      targets.clear();
      elements.forEach((element) => targets.set(element.id, element));
    },
  };
}

function makeFocusable(element, id, document) {
  element.id = id;
  element.focusCalls = [];
  element.focus = (options) => {
    element.focusCalls.push(options);
    document.activeElement = element;
  };
  element.setSelectionRange = (start, end, direction) => {
    element.selectionStart = start;
    element.selectionEnd = end;
    element.selectionDirection = direction;
  };
  return element;
}

function bindFocusRegion(region, document, ...elements) {
  const querySelector = region.querySelector?.bind(region);
  region.ownerDocument = document;
  region.contains = (candidate) => elements.includes(candidate);
  region.querySelector = (selector) => {
    if (selector.startsWith('#')) {
      const match = elements.find((element) => element.id === selector.slice(1));
      if (match) return match;
    }
    return querySelector?.(selector) || null;
  };
}

function replaceFocusedRegion(current, replacement, document, replacementElements) {
  current.replaceWith = (next) => {
    current.replacement = next;
    document.register(...replacementElements);
  };
  bindFocusRegion(replacement, document, ...replacementElements);
}

describe('Settings no-reload reviewer regressions', () => {
  it('restores Save focus after authoritative Open Locally success and validation replacement', async () => {
    const outcomes = [
      {
        response: { ok: true, redirected: true, text: async () => '<html>saved</html>' },
        status: 'Settings saved.',
        state: 'saved',
      },
      {
        response: { ok: false, redirected: false, status: 422, text: async () => '<html>invalid</html>' },
        status: 'Could not save settings.',
        state: 'error',
      },
    ];

    for (const outcome of outcomes) {
      const fixture = makeOpenLocallyReviewerFixture();
      const replacement = makeOpenLocallyReviewerFixture();
      const document = makeFocusDocument();
      const oldSave = makeFocusable({}, 'open-locally-save', document);
      const nextSave = makeFocusable({}, 'open-locally-save', document);
      fixture.form.ownerDocument = document;
      replacement.form.ownerDocument = document;
      document.querySelector = (selector) => (
        selector === '[data-settings-open-locally-path]' ? fixture.controls[0] : null
      );
      bindFocusRegion(fixture.region, document, fixture.controls[0], oldSave);
      replaceFocusedRegion(fixture.region, replacement.region, document, [replacement.controls[0], nextSave]);
      document.register(oldSave);
      oldSave.focus();
      const requests = [];

      await withDefaultsDomParser(() => ({
        querySelector: (selector) => (
          selector === '[data-settings-open-locally-mapping-region]' ? replacement.region : null
        ),
      }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
        requests.push({ action, options, resolve });
      }), async () => {
        enhanceOpenLocallyFetchSave(fixture.scope);
        fixture.form.dispatch('submit');
        await flushAsync();

        expect(requests).toHaveLength(1);
        requests[0].resolve(outcome.response);
        await flushAsync();
      }));

      expect(fixture.region.replacement).toBe(replacement.region);
      expect(document.activeElement).toBe(nextSave);
      expect(nextSave.focusCalls).toHaveLength(1);
      expect(replacement.status.textContent).toBe(outcome.status);
      expect(replacement.attributes.get('data-settings-fetch-save-state')).toBe(outcome.state);
    }
  });
  it('preserves a newer unsent Open Locally value, focus, and selection after success or validation', async () => {
    const outcomes = [
      {
        response: { ok: true, redirected: true, text: async () => '<html>saved</html>' },
        status: 'Current changes have not been saved.',
        state: 'unsaved',
      },
      {
        response: { ok: false, redirected: false, status: 422, text: async () => '<html>invalid</html>' },
        status: 'Could not save the submitted value. Current edits have not been saved.',
        state: 'error',
      },
    ];

    for (const outcome of outcomes) {
      const fixture = makeOpenLocallyReviewerFixture();
      const replacement = makeOpenLocallyReviewerFixture();
      const document = makeFocusDocument();
      const oldInput = makeFocusable(fixture.controls[0], 'windows-projects-path', document);
      const newInput = makeFocusable(replacement.controls[0], 'windows-projects-path', document);
      fixture.form.ownerDocument = document;
      replacement.form.ownerDocument = document;
      document.querySelector = (selector) => (
        selector === '[data-settings-open-locally-path]' ? document.getElementById('windows-projects-path') : null
      );
      bindFocusRegion(fixture.region, document, oldInput);
      replaceFocusedRegion(fixture.region, replacement.region, document, [newInput]);
      document.register(oldInput);
      oldInput.focus();
      oldInput.value = 'D:\\one';
      oldInput.selectionStart = 2;
      oldInput.selectionEnd = 5;
      oldInput.selectionDirection = 'forward';
      const requests = [];

      await withDefaultsDomParser(() => ({
        querySelector: (selector) => (
          selector === '[data-settings-open-locally-mapping-region]' ? replacement.region : null
        ),
      }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
        requests.push({ action, options, resolve });
      }), async () => {
        enhanceOpenLocallyFetchSave(fixture.scope);
        fixture.form.dispatch('submit');
        await flushAsync();
        oldInput.value = 'D:\\onetwo';

        requests[0].resolve(outcome.response);
        await flushAsync();

        expect(replacement.region).toBe(fixture.region.replacement);
        expect(newInput.value).toBe('D:\\onetwo');
        expect(document.activeElement).toBe(newInput);
        expect(newInput.selectionStart).toBe(2);
        expect(newInput.selectionEnd).toBe(5);
        expect(replacement.status.textContent).toBe(outcome.status);
        expect(replacement.attributes.get('data-settings-fetch-save-state')).toBe(outcome.state);
        expect(requests).toHaveLength(1);

        newInput.dispatch('change');
        await flushAsync();
        expect(requests).toHaveLength(2);
        expect(requests[1].options.body.get('windowsProjectsPath')).toBe('D:\\onetwo');
      }));
    }
  });

  it('keeps authoritative Open Locally validation when no newer unsent value exists', async () => {
    const fixture = makeOpenLocallyReviewerFixture();
    const replacement = makeOpenLocallyReviewerFixture();
    fixture.region.replaceWith = (next) => { fixture.region.replacement = next; };

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => (
        selector === '[data-settings-open-locally-mapping-region]' ? replacement.region : null
      ),
    }), async () => withBrowserGlobals(async () => ({
      ok: false,
      redirected: false,
      status: 422,
      text: async () => '<html>invalid</html>',
    }), async () => {
      enhanceOpenLocallyFetchSave(fixture.scope);
      fixture.controls[0].dispatch('change');
      await flushAsync();
    }));

    expect(fixture.region.replacement).toBe(replacement.region);
    expect(replacement.controls[0].value).toBe('D:\\example');
    expect(replacement.status.textContent).toBe('Could not save settings.');
    expect(replacement.attributes.get('data-settings-fetch-save-state')).toBe('error');
  });

  it('restores focused Defaults, NSFW, Browser Default, and Preview controls after validation replacement', async () => {
    const defaults = makeDefaultsFetchFixture();
    const defaultsReplacement = makeDefaultsFetchFixture();
    const nsfw = makeNsfwFetchFixture();
    const nsfwReplacement = makeNsfwFetchFixture();
    const browser = makeAssetCategoryPreferenceFetchFixture();
    const browserReplacement = makeAssetCategoryPreferenceFetchFixture();
    const preview = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
    });
    const previewReplacement = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
    });
    const document = makeFocusDocument();
    const cases = [
      {
        fixture: defaults,
        replacement: defaultsReplacement,
        old: makeFocusable({}, 'new-project-status-dropdown-trigger', document),
        next: makeFocusable({}, 'new-project-status-dropdown-trigger', document),
        enhance: () => enhanceDefaultsFetchSave(defaults.scope),
        control: defaults.controls[0],
        selector: '[data-settings-defaults-region]',
        parser: 'one',
      },
      {
        fixture: nsfw,
        replacement: nsfwReplacement,
        old: makeFocusable(nsfw.control, 'nsfw-filter-enabled', document),
        next: makeFocusable(nsfwReplacement.control, 'nsfw-filter-enabled', document),
        enhance: () => enhanceNsfwFilterFetchSave(nsfw.scope),
        control: nsfw.control,
        selector: '[data-settings-nsfw-filter-region]',
        parser: 'one',
      },
      {
        fixture: browser,
        replacement: browserReplacement,
        old: makeFocusable({}, 'global-asset-browser-default-dropdown-trigger', document),
        next: makeFocusable({}, 'global-asset-browser-default-dropdown-trigger', document),
        enhance: () => enhanceAssetCategoryPreferencesFetchSave(browser.scope),
        control: browser.controls[0],
        selector: '[data-settings-asset-category-preference]',
        parser: 'preferences',
      },
      {
        fixture: preview,
        replacement: previewReplacement,
        old: makeFocusable({}, 'global-preview-category-dropdown-trigger', document),
        next: makeFocusable({}, 'global-preview-category-dropdown-trigger', document),
        enhance: () => enhanceAssetCategoryPreferencesFetchSave(preview.scope),
        control: preview.controls[0],
        selector: '[data-settings-asset-category-preference]',
        parser: 'preferences',
      },
    ];

    for (const testCase of cases) {
      const { fixture, replacement, old, next, enhance, control, selector, parser } = testCase;
      fixture.form.ownerDocument = document;
      replacement.form.ownerDocument = document;
      bindFocusRegion(fixture.region, document, old);
      replaceFocusedRegion(fixture.region, replacement.region, document, [next]);
      document.register(old);
      old.focus();

      await withDefaultsDomParser(() => ({
        querySelector: (candidate) => (parser === 'one' && candidate === selector ? replacement.region : null),
        querySelectorAll: (candidate) => (parser === 'preferences' && candidate === selector ? [replacement.region] : []),
      }), async () => withBrowserGlobals(async () => ({
        ok: false,
        redirected: false,
        status: 422,
        text: async () => '<html>validation</html>',
      }), async () => {
        enhance();
        control.dispatch('change');
        await flushAsync();
      }));

      expect(document.activeElement).toBe(next);
      expect(next.focusCalls).toHaveLength(1);
    }
  });

  it('does not steal focus when it began outside Defaults validation replacement', async () => {
    const fixture = makeDefaultsFetchFixture();
    const replacement = makeDefaultsFetchFixture();
    const document = makeFocusDocument();
    const outside = makeFocusable({}, 'outside-control', document);
    fixture.form.ownerDocument = document;
    replacement.form.ownerDocument = document;
    bindFocusRegion(fixture.region, document, fixture.controls[0]);
    bindFocusRegion(replacement.region, document, replacement.controls[0]);
    document.register(outside);
    outside.focus();

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => selector === '[data-settings-defaults-region]' ? replacement.region : null,
    }), async () => withBrowserGlobals(async () => ({
      ok: false,
      redirected: false,
      status: 422,
      text: async () => '<html>validation</html>',
    }), async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      fixture.controls[0].dispatch('change');
      await flushAsync();
    }));

    expect(document.activeElement).toBe(outside);
  });

  it('does not replace or move focus for superseded Open Locally validation', async () => {
    const fixture = makeOpenLocallyReviewerFixture();
    const replacement = makeOpenLocallyReviewerFixture();
    const document = makeFocusDocument();
    const input = makeFocusable(fixture.controls[0], 'windows-projects-path', document);
    fixture.form.ownerDocument = document;
    document.querySelector = (selector) => (
      selector === '[data-settings-open-locally-path]' ? input : null
    );
    bindFocusRegion(fixture.region, document, input);
    document.register(input);
    input.focus();
    const requests = [];

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => (
        selector === '[data-settings-open-locally-mapping-region]' ? replacement.region : null
      ),
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceOpenLocallyFetchSave(fixture.scope);
      fixture.form.dispatch('submit');
      await flushAsync();
      input.value = 'D:\\later';
      input.dispatch('change');
      requests[0].resolve({ ok: false, redirected: false, status: 422, text: async () => '<html>stale</html>' });
      await flushAsync();
    }));

    expect(fixture.region.replacement).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('restores focused Defaults, NSFW, Browser Default, and Preview controls only after successful replacement', async () => {
    const defaults = makeDefaultsFetchFixture();
    const defaultsReplacement = makeDefaultsFetchFixture();
    const nsfw = makeNsfwFetchFixture();
    const nsfwReplacement = makeNsfwFetchFixture();
    const browser = makeAssetCategoryPreferenceFetchFixture();
    const browserReplacement = makeAssetCategoryPreferenceFetchFixture();
    const preview = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
    });
    const previewReplacement = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
    });
    const document = makeFocusDocument();
    const cases = [
      {
        fixture: defaults,
        replacement: defaultsReplacement,
        old: makeFocusable({ }, 'new-project-status-dropdown-trigger', document),
        next: makeFocusable({ }, 'new-project-status-dropdown-trigger', document),
        enhance: () => enhanceDefaultsFetchSave(defaults.scope),
        control: defaults.controls[0],
        selector: '[data-settings-defaults-region]',
        parser: 'one',
      },
      {
        fixture: nsfw,
        replacement: nsfwReplacement,
        old: makeFocusable(nsfw.control, 'nsfw-filter-enabled', document),
        next: makeFocusable(nsfwReplacement.control, 'nsfw-filter-enabled', document),
        enhance: () => enhanceNsfwFilterFetchSave(nsfw.scope),
        control: nsfw.control,
        selector: '[data-settings-nsfw-filter-region]',
        parser: 'one',
      },
      {
        fixture: browser,
        replacement: browserReplacement,
        old: makeFocusable({ }, 'global-asset-browser-default-dropdown-trigger', document),
        next: makeFocusable({ }, 'global-asset-browser-default-dropdown-trigger', document),
        enhance: () => enhanceAssetCategoryPreferencesFetchSave(browser.scope),
        control: browser.controls[0],
        selector: '[data-settings-asset-category-preference]',
        parser: 'preferences',
      },
      {
        fixture: preview,
        replacement: previewReplacement,
        old: makeFocusable({ }, 'global-preview-category-dropdown-trigger', document),
        next: makeFocusable({ }, 'global-preview-category-dropdown-trigger', document),
        enhance: () => enhanceAssetCategoryPreferencesFetchSave(preview.scope),
        control: preview.controls[0],
        selector: '[data-settings-asset-category-preference]',
        parser: 'preferences',
      },
    ];

    for (const testCase of cases) {
      const { fixture, replacement, old, next, enhance, control, selector, parser } = testCase;
      fixture.form.ownerDocument = document;
      replacement.form.ownerDocument = document;
      bindFocusRegion(fixture.region, document, old);
      replaceFocusedRegion(fixture.region, replacement.region, document, [next]);
      document.register(old);
      old.focus();

      await withDefaultsDomParser(() => ({
        querySelector: (candidate) => (parser === 'one' && candidate === selector ? replacement.region : null),
        querySelectorAll: (candidate) => (parser === 'preferences' && candidate === selector ? [replacement.region] : []),
      }), async () => withBrowserGlobals(async () => ({
        ok: true,
        redirected: true,
        text: async () => '<html>saved</html>',
      }), async () => {
        enhance();
        control.dispatch('change');
        await flushAsync();
      }));

      expect(document.activeElement).toBe(next);
      expect(next.focusCalls).toHaveLength(1);
    }
  });

  it('does not steal focus when it began outside the successful Defaults replacement region', async () => {
    const fixture = makeDefaultsFetchFixture();
    const replacement = makeDefaultsFetchFixture();
    const document = makeFocusDocument();
    const outside = makeFocusable({}, 'outside-control', document);
    fixture.form.ownerDocument = document;
    replacement.form.ownerDocument = document;
    bindFocusRegion(fixture.region, document, fixture.controls[0]);
    bindFocusRegion(replacement.region, document, replacement.controls[0]);
    document.register(outside);
    outside.focus();

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => selector === '[data-settings-defaults-region]' ? replacement.region : null,
    }), async () => withBrowserGlobals(async () => ({
      ok: true,
      redirected: true,
      text: async () => '<html>saved</html>',
    }), async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      fixture.controls[0].dispatch('change');
      await flushAsync();
    }));

    expect(document.activeElement).toBe(outside);
  });

  it('does not replace or move focus for a superseded successful Defaults response', async () => {
    const fixture = makeDefaultsFetchFixture();
    const replacement = makeDefaultsFetchFixture();
    const document = makeFocusDocument();
    const focused = makeFocusable(fixture.controls[0], 'new-project-status', document);
    fixture.form.ownerDocument = document;
    bindFocusRegion(fixture.region, document, focused);
    document.register(focused);
    focused.focus();
    const requests = [];

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => selector === '[data-settings-defaults-region]' ? replacement.region : null,
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceDefaultsFetchSave(fixture.scope);
      focused.value = 'A';
      focused.dispatch('change');
      await flushAsync();
      focused.value = 'B';
      focused.dispatch('change');
      requests[0].resolve({ ok: true, redirected: true, text: async () => '<html>stale</html>' });
      await flushAsync();

      expect(fixture.region.replacement).toBeNull();
      expect(document.activeElement).toBe(focused);
      requests[1].resolve({ ok: true, redirected: true, text: async () => '<html>current</html>' });
      await flushAsync();
    }));
  });

  it('replaces Defaults validation markup with a clean corrected-success region and one binding', async () => {
    const initial = makeDefaultsFetchFixture();
    const invalid = makeDefaultsFetchFixture({ value: 'invalid' });
    const clean = makeDefaultsFetchFixture({ value: 'ready' });
    invalid.region.errorSummary = { id: 'defaults-errors' };
    invalid.controls[0].ariaInvalid = 'true';
    invalid.controls[0].ariaDescribedBy = 'new-project-status-error';
    clean.region.errorSummary = null;
    clean.controls[0].ariaInvalid = null;
    clean.controls[0].ariaDescribedBy = null;
    const responses = [invalid.region, clean.region];
    const requests = [];

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => (
        selector === '[data-settings-defaults-region]' ? responses.shift() : null
      ),
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceDefaultsFetchSave(initial.scope);
      initial.controls[0].dispatch('change');
      await flushAsync();
      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<html>invalid</html>' });
      await flushAsync();

      invalid.controls[0].value = 'ready';
      invalid.controls[0].dispatch('change');
      await flushAsync();
      requests[1].resolve({ ok: true, redirected: true, text: async () => '<html>clean</html>' });
      await flushAsync();
    }));

    expect(initial.region.replacement).toBe(invalid.region);
    expect(invalid.region.replacement).toBe(clean.region);
    expect(clean.region.errorSummary).toBeNull();
    expect(clean.controls[0].ariaInvalid).toBeNull();
    expect(clean.controls[0].ariaDescribedBy).toBeNull();
    expect(clean.controls[0].listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });

  it('replaces NSFW validation markup with a clean corrected-success region and one binding', async () => {
    const initial = makeNsfwFetchFixture();
    const invalid = makeNsfwFetchFixture({ checked: true });
    const clean = makeNsfwFetchFixture({ checked: false });
    invalid.region.errorSummary = { id: 'nsfw-filter-errors' };
    invalid.control.ariaInvalid = 'true';
    invalid.control.ariaDescribedBy = 'nsfw-filter-help nsfw-filter-errors';
    clean.region.errorSummary = null;
    clean.control.ariaInvalid = null;
    clean.control.ariaDescribedBy = 'nsfw-filter-help';
    const responses = [invalid.region, clean.region];
    const requests = [];

    await withDefaultsDomParser(() => ({
      querySelector: (selector) => (
        selector === '[data-settings-nsfw-filter-region]' ? responses.shift() : null
      ),
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceNsfwFilterFetchSave(initial.scope);
      initial.control.checked = true;
      initial.control.dispatch('change');
      await flushAsync();
      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<html>invalid</html>' });
      await flushAsync();

      invalid.control.checked = false;
      invalid.control.dispatch('change');
      await flushAsync();
      requests[1].resolve({ ok: true, redirected: true, text: async () => '<html>clean</html>' });
      await flushAsync();
    }));

    expect(initial.region.replacement).toBe(invalid.region);
    expect(invalid.region.replacement).toBe(clean.region);
    expect(clean.region.errorSummary).toBeNull();
    expect(clean.control.ariaInvalid).toBeNull();
    expect(clean.control.ariaDescribedBy).toBe('nsfw-filter-help');
    expect(clean.control.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });

  it('replaces Browser Default validation markup with its clean matching card from a two-card response', async () => {
    const initial = makeAssetCategoryPreferenceFetchFixture();
    const invalid = makeAssetCategoryPreferenceFetchFixture({ value: 'invalid' });
    const clean = makeAssetCategoryPreferenceFetchFixture({ value: 'all' });
    const previewInvalid = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'preview-invalid',
    });
    const previewClean = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'preview-clean',
    });
    invalid.region.errorSummary = { id: 'global-asset-browser-default-error' };
    invalid.controls[0].ariaInvalid = 'true';
    invalid.controls[0].ariaDescribedBy = 'global-asset-browser-default-help global-asset-browser-default-error';
    clean.region.errorSummary = null;
    clean.controls[0].ariaInvalid = null;
    clean.controls[0].ariaDescribedBy = 'global-asset-browser-default-help';
    const pages = [
      [invalid.region, previewInvalid.region],
      [clean.region, previewClean.region],
    ];
    const requests = [];

    await withAssetCategoryPreferenceDomParser(() => ({
      querySelectorAll: (selector) => (
        selector === '[data-settings-asset-category-preference]' ? pages.shift() : []
      ),
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceAssetCategoryPreferencesFetchSave(initial.scope);
      initial.controls[0].value = 'invalid';
      initial.controls[0].dispatch('change');
      await flushAsync();
      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<html>both invalid</html>' });
      await flushAsync();

      invalid.controls[0].value = 'all';
      invalid.controls[0].dispatch('change');
      await flushAsync();
      requests[1].resolve({ ok: true, redirected: true, text: async () => '<html>both clean</html>' });
      await flushAsync();
    }));

    expect(initial.region.replacement).toBe(invalid.region);
    expect(invalid.region.replacement).toBe(clean.region);
    expect(clean.region.errorSummary).toBeNull();
    expect(clean.controls[0].ariaInvalid).toBeNull();
    expect(clean.controls[0].ariaDescribedBy).toBe('global-asset-browser-default-help');
    expect(clean.controls[0].listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });

  it('replaces Preview validation markup with its clean matching card from a two-card response', async () => {
    const initial = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'invalid',
    });
    const invalid = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'invalid',
    });
    const clean = makeAssetCategoryPreferenceFetchFixture({
      action: '/settings/asset-categories/preview-category',
      value: 'preview',
    });
    const browserInvalid = makeAssetCategoryPreferenceFetchFixture({ value: 'browser-invalid' });
    const browserClean = makeAssetCategoryPreferenceFetchFixture({ value: 'browser-clean' });
    invalid.region.errorSummary = { id: 'global-preview-category-error' };
    invalid.controls[0].ariaInvalid = 'true';
    invalid.controls[0].ariaDescribedBy = 'global-preview-category-help global-preview-category-error';
    clean.region.errorSummary = null;
    clean.controls[0].ariaInvalid = null;
    clean.controls[0].ariaDescribedBy = 'global-preview-category-help';
    const pages = [
      [browserInvalid.region, invalid.region],
      [browserClean.region, clean.region],
    ];
    const requests = [];

    await withAssetCategoryPreferenceDomParser(() => ({
      querySelectorAll: (selector) => (
        selector === '[data-settings-asset-category-preference]' ? pages.shift() : []
      ),
    }), async () => withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceAssetCategoryPreferencesFetchSave(initial.scope);
      initial.controls[0].dispatch('change');
      await flushAsync();
      requests[0].resolve({ ok: false, status: 422, redirected: false, text: async () => '<html>both invalid</html>' });
      await flushAsync();

      invalid.controls[0].value = 'preview';
      invalid.controls[0].dispatch('change');
      await flushAsync();
      requests[1].resolve({ ok: true, redirected: true, text: async () => '<html>both clean</html>' });
      await flushAsync();
    }));

    expect(initial.region.replacement).toBe(invalid.region);
    expect(invalid.region.replacement).toBe(clean.region);
    expect(browserInvalid.region.replacement).toBeNull();
    expect(clean.region.errorSummary).toBeNull();
    expect(clean.controls[0].ariaInvalid).toBeNull();
    expect(clean.controls[0].ariaDescribedBy).toBe('global-preview-category-help');
    expect(clean.controls[0].listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });
});

function makeCategoryNode({ tagName = 'div', attrs = {}, className = '', rect = null } = {}) {
  const listeners = [];
  const attributes = new Map();
  const children = [];
  const node = {
    tagName: tagName.toUpperCase(),
    dataset: {},
    children,
    parentElement: null,
    parentNode: null,
    ownerDocument: null,
    listeners,
    textContent: '',
    classList: {
      values: new Set(className.split(/\s+/).filter(Boolean)),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !this.values.has(name) : force;
        if (next) this.values.add(name); else this.values.delete(name);
        return next;
      },
      contains(name) { return this.values.has(name); },
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    setAttribute(name, value) {
      const stringValue = String(value);
      attributes.set(name, stringValue);
      if (name === 'class') this.classList.values = new Set(stringValue.split(/\s+/).filter(Boolean));
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        this.dataset[key] = stringValue;
      }
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        delete this.dataset[key];
      }
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        const trimmed = part.trim();
        if (trimmed.startsWith('.')) return this.classList.contains(trimmed.slice(1));
        if (trimmed === 'a' || trimmed === 'button' || trimmed === 'input' || trimmed === 'select'
          || trimmed === 'textarea' || trimmed === 'form' || trimmed === 'label'
          || trimmed === 'summary' || trimmed === 'details' || trimmed === 'noscript') {
          return this.tagName === trimmed.toUpperCase();
        }
        const dataMatch = trimmed.match(/^\[data-([\w-]+)\]$/);
        if (dataMatch) {
          const key = dataMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return Object.prototype.hasOwnProperty.call(this.dataset, key);
        }
        const roleMatch = trimmed.match(/^\[role="([^"]+)"\]$/);
        if (roleMatch) return this.getAttribute('role') === roleMatch[1];
        if (trimmed === '[aria-live]') return this.getAttribute('aria-live') !== null;
        if (trimmed === '[contenteditable]') return this.getAttribute('contenteditable') !== null;
        const editableMatch = trimmed === '[contenteditable="true"]';
        return editableMatch && this.getAttribute('contenteditable') === 'true';
      });
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(candidate) {
      if (candidate === this) return true;
      return children.some((child) => child.contains(candidate));
    },
    appendChild(child) {
      if (child.parentElement) {
        const previousIndex = child.parentElement.children.indexOf(child);
        if (previousIndex >= 0) child.parentElement.children.splice(previousIndex, 1);
      }
      children.push(child);
      child.parentElement = this;
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument || (this.tagName === 'DOCUMENT' ? this : null);
      const adopt = (current, ownerDocument) => {
        current.ownerDocument = ownerDocument;
        current.children.forEach((descendant) => adopt(descendant, ownerDocument));
      };
      adopt(child, child.ownerDocument);
      return child;
    },
    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
      this.parentNode = null;
    },
    replaceChildren(...nextChildren) {
      children.forEach((child) => {
        child.parentElement = null;
        child.parentNode = null;
      });
      children.splice(0, children.length);
      nextChildren.forEach((child) => this.appendChild(child));
    },
    replaceWith(replacement) {
      if (!this.parentElement) return;
      const parent = this.parentElement;
      const index = parent.children.indexOf(this);
      if (index < 0) return;
      if (replacement.parentElement) {
        const replacementIndex = replacement.parentElement.children.indexOf(replacement);
        if (replacementIndex >= 0) replacement.parentElement.children.splice(replacementIndex, 1);
      }
      parent.children[index] = replacement;
      replacement.parentElement = parent;
      replacement.parentNode = parent;
      const ownerDocument = parent.ownerDocument || (parent.tagName === 'DOCUMENT' ? parent : null);
      const adopt = (current) => {
        current.ownerDocument = ownerDocument;
        current.children.forEach(adopt);
      };
      adopt(replacement);
      this.parentElement = null;
      this.parentNode = null;
    },
    insertBefore(child, reference) {
      if (child === reference) return child;
      if (child.parentElement) {
        const previousIndex = child.parentElement.children.indexOf(child);
        if (previousIndex >= 0) child.parentElement.children.splice(previousIndex, 1);
      }
      const referenceIndex = children.indexOf(reference);
      if (referenceIndex < 0) return this.appendChild(child);
      children.splice(referenceIndex, 0, child);
      child.parentElement = this;
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
      return child;
    },
    querySelectorAll(selector) {
      const descendants = [];
      const visit = (current) => {
        current.children.forEach((child) => {
          if (child.matches(selector)) descendants.push(child);
          visit(child);
        });
      };
      visit(this);
      return descendants;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    getBoundingClientRect() {
      return rect || { top: 0, height: 40 };
    },
    focus() {
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
      this.focused = true;
    },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: props.target || this,
        currentTarget: null,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      let current = this;
      while (current) {
        event.currentTarget = current;
        current.listeners.filter((listener) => listener.type === type)
          .forEach((listener) => listener.handler(event));
        current = current.parentElement;
      }
      return event;
    },
  };
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function makeCategoryReorderFixture({
  action = '/projects/7/asset-categories/reorder',
  csrfToken = 'csrf-reorder',
  categoryIds = ['1', '2', '3'],
} = {}) {
  const document = makeCategoryNode({ tagName: 'document' });
  document.ownerDocument = document;
  document.getElementById = (id) => document.querySelectorAll(`[id="${id}"]`)[0] || null;
  const section = makeCategoryNode();
  const form = makeCategoryNode({ tagName: 'form', attrs: { id: 'category-reorder-form', 'data-category-reorder-form': '' } });
  form.action = action;
  form.method = 'post';
  form.csrfToken = csrfToken;
  const orderInput = makeCategoryNode({ tagName: 'input', attrs: { 'data-category-order-input': '' } });
  const live = makeCategoryNode({ attrs: { 'data-category-reorder-live': '' } });
  const list = makeCategoryNode({ attrs: {
    'data-category-reorder-list': '',
    'data-reorder-form-target': 'category-reorder-form',
  } });
  const items = categoryIds.map((id, index) => {
    const item = makeCategoryNode({
      attrs: {
        'data-category-reorder-item': '',
        'data-category-id': id,
        'data-category-label': `Source ${id}`,
      },
      rect: { top: index * 50, height: 40 },
    });
    const handle = makeCategoryNode({ tagName: 'button', attrs: { 'data-category-reorder-handle': '' } });
    item.appendChild(handle);
    item.handle = handle;
    return item;
  });

  document.appendChild(section);
  section.appendChild(form);
  form.appendChild(orderInput);
  section.appendChild(list);
  items.forEach((item) => list.appendChild(item));
  section.appendChild(live);
  items.forEach((item) => { item.ownerDocument = document; item.handle.ownerDocument = document; });
  let submitCount = 0;
  form.requestSubmit = () => { submitCount += 1; };
  return {
    document,
    section,
    form,
    orderInput,
    live,
    list,
    items,
    get submitCount() { return submitCount; },
    order() { return list.querySelectorAll('[data-category-reorder-item]').map((item) => item.dataset.categoryId); },
  };
}

function makeDedicatedReorderFixture({
  action,
  csrfToken,
  ids,
  formId,
  formAttribute,
  inputAttribute,
  listAttribute,
  itemAttribute,
  idAttribute,
  idDataset,
  labelAttribute,
  liveAttribute,
  positionAttribute,
  handleAttribute,
  itemLabels = null,
} = {}) {
  const document = makeCategoryNode({ tagName: 'document' });
  document.ownerDocument = document;
  document.createElement = (tagName) => {
    const element = makeCategoryNode({ tagName });
    element.ownerDocument = document;
    return element;
  };
  document.getElementById = (id) => document
    .querySelectorAll(`[${formAttribute}]`)
    .find((form) => form.getAttribute('id') === id) || null;
  const form = makeCategoryNode({
    tagName: 'form',
    attrs: { id: formId, [formAttribute]: '' },
  });
  form.action = action;
  form.method = 'post';
  form.csrfToken = csrfToken;
  const orderInput = makeCategoryNode({ tagName: 'input', attrs: { [inputAttribute]: '' } });
  orderInput.value = ids.join(',');
  const list = makeCategoryNode({ tagName: 'ol', attrs: {
    [listAttribute]: '',
    'data-reorder-form-target': formId,
  } });
  const live = makeCategoryNode({ attrs: { [liveAttribute]: '' } });
  const status = makeCategoryNode({ attrs: { 'data-book-reorder-status': '' } });
  const items = ids.map((id, index) => {
    const item = makeCategoryNode({
      tagName: 'li',
      attrs: {
        [itemAttribute]: '',
        [idAttribute]: id,
        [labelAttribute]: itemLabels?.[index]
          || `${idDataset === 'bookId' ? 'Book' : 'Page'} ${id}`,
      },
      rect: { top: index * 50, height: 40 },
    });
    const handle = makeCategoryNode({ tagName: 'button', attrs: { [handleAttribute]: '' } });
    const position = makeCategoryNode({ attrs: { [positionAttribute]: '' } });
    item.appendChild(handle);
    item.appendChild(position);
    item.handle = handle;
    item.position = position;
    return item;
  });

  document.appendChild(form);
  form.appendChild(orderInput);
  form.appendChild(list);
  items.forEach((item) => list.appendChild(item));
  form.appendChild(live);
  form.appendChild(status);
  return {
    document,
    form,
    orderInput,
    list,
    live,
    status,
    items,
    order() { return list.querySelectorAll(`[${itemAttribute}]`).map((item) => item.dataset[idDataset]); },
  };
}

function makeBookReorderFixture({
  action = '/notes/books/reorder',
  csrfToken = 'csrf-book-reorder',
  bookIds = ['101', '202', '303'],
} = {}) {
  const fixture = makeDedicatedReorderFixture({
    action,
    csrfToken,
    ids: bookIds,
    formId: 'notes-books-order-form',
    formAttribute: 'data-book-reorder-form',
    inputAttribute: 'data-book-order-input',
    listAttribute: 'data-book-reorder-list',
    itemAttribute: 'data-book-reorder-item',
    idAttribute: 'data-book-id',
    idDataset: 'bookId',
    labelAttribute: 'data-book-label',
    liveAttribute: 'data-book-reorder-live',
    positionAttribute: 'data-book-order-position',
    handleAttribute: 'data-book-reorder-handle',
  });
  const dialog = makeCategoryNode({ tagName: 'dialog', attrs: { 'data-app-dialog': '' } });
  dialog.__creatorCrateAppDialogState = { form: fixture.form };
  fixture.document.appendChild(dialog);
  dialog.appendChild(fixture.form);
  fixture.dialog = dialog;
  return fixture;
}

function makeBookReorderAuthority(bookIds, generation = 1) {
  const fixture = makeBookReorderFixture({ bookIds });
  const shelf = makeCategoryNode({ attrs: { 'data-notes-books-live-region': '' } });
  bookIds.forEach((bookId) => {
    const title = makeCategoryNode({ attrs: { class: 'notes-book-card-title' } });
    title.appendChild(makeCategoryNode({ tagName: 'a', attrs: { href: `/notes/books/${bookId}` } }));
    shelf.appendChild(title);
  });
  return {
    fixture,
    snapshot: {
      kind: 'active',
      generation,
      replacementShelf: shelf,
      replacementForm: fixture.form,
      authority: [...bookIds],
    },
  };
}

function makeChapterPageReorderFixture({
  action = '/notes/chapters/7/notes/reorder',
  csrfToken = 'csrf-chapter-page-reorder',
  noteIds = ['11', '22', '33'],
} = {}) {
  return makeDedicatedReorderFixture({
    action,
    csrfToken,
    ids: noteIds,
    formId: 'notes-chapter-order-form',
    formAttribute: 'data-chapter-page-reorder-form',
    inputAttribute: 'data-chapter-page-order-input',
    listAttribute: 'data-chapter-page-reorder-list',
    itemAttribute: 'data-chapter-page-reorder-item',
    idAttribute: 'data-note-id',
    idDataset: 'noteId',
    labelAttribute: 'data-note-label',
    liveAttribute: 'data-chapter-page-reorder-live',
    positionAttribute: 'data-chapter-page-order-position',
    handleAttribute: 'data-chapter-page-reorder-handle',
  });
}

function makeBookContentReorderFixture({
  action = '/notes/books/7/contents/reorder',
  csrfToken = 'csrf-book-content-reorder',
  contentKeys = ['chapter:7', 'page:7', 'chapter:8', 'page:8'],
  labels = ['Chapter: Chapter 7', 'Page: Page 7', 'Chapter: Chapter 8', 'Page: Page 8'],
} = {}) {
  return makeDedicatedReorderFixture({
    action,
    csrfToken,
    ids: contentKeys,
    formId: 'notes-book-order-form',
    formAttribute: 'data-book-content-reorder-form',
    inputAttribute: 'data-book-content-order-input',
    listAttribute: 'data-book-content-reorder-list',
    itemAttribute: 'data-book-content-reorder-item',
    idAttribute: 'data-content-key',
    idDataset: 'contentKey',
    labelAttribute: 'data-content-label',
    liveAttribute: 'data-book-content-reorder-live',
    positionAttribute: 'data-book-content-order-position',
    handleAttribute: 'data-book-content-reorder-handle',
    itemLabels: labels,
  });
}

function makeBookHierarchyReorderFixture() {
  const expected = [
    { type: 'chapter', id: 1, pages: [11, 12] },
    { type: 'page', id: 21 },
    { type: 'chapter', id: 2, pages: [13] },
    { type: 'chapter', id: 3, pages: [] },
    { type: 'page', id: 22 },
  ];
  const document = makeCategoryNode({ tagName: 'document' });
  document.ownerDocument = document;
  document.createElement = (tagName) => {
    const element = makeCategoryNode({ tagName });
    element.ownerDocument = document;
    return element;
  };
  const dialog = makeCategoryNode({ tagName: 'dialog', attrs: { 'data-app-dialog': '' } });
  dialog.__creatorCrateAppDialogState = { onOpen: null, onClose: null };
  const form = makeCategoryNode({
    tagName: 'form',
    attrs: {
      'data-book-hierarchy-form': '',
      action: '/notes/books/7/hierarchy/reorder',
      method: 'post',
    },
  });
  const input = makeCategoryNode({ tagName: 'input', attrs: { 'data-book-hierarchy-input': '', name: 'hierarchy' } });
  input.value = JSON.stringify({ version: 1, expected, target: expected });
  const legacyItems = makeCategoryNode({ tagName: 'input', attrs: { name: 'orderedItems' } });
  legacyItems.value = 'keep-items';
  const legacyNotes = makeCategoryNode({ tagName: 'input', attrs: { name: 'orderedNoteIds' } });
  legacyNotes.value = 'keep-notes';
  const foreignForm = makeCategoryNode({ tagName: 'form', attrs: { 'data-book-hierarchy-form': '' } });
  const foreignInput = makeCategoryNode({ tagName: 'input', attrs: { 'data-book-hierarchy-input': '', name: 'hierarchy' } });
  foreignInput.value = 'foreign-hierarchy';
  const editor = makeCategoryNode({ attrs: { 'data-book-hierarchy-editor': '' } });
  const root = makeCategoryNode({ tagName: 'ol', attrs: { 'data-book-hierarchy-container': 'root' } });
  const items = new Map();
  const containers = new Map([['root', root]]);

  const makeItem = (type, id, top = 0) => {
    const item = makeCategoryNode({
      tagName: 'li',
      attrs: {
        'data-book-hierarchy-item': '',
        draggable: 'true',
        'data-content-key': `${type}:${id}`,
        'data-book-hierarchy-label': `${type === 'chapter' ? 'Chapter' : 'Page'} ${id}`,
      },
      rect: { top, height: 40 },
    });
    const handle = makeCategoryNode({ tagName: 'button', attrs: { 'data-book-hierarchy-handle': '' } });
    const copy = makeCategoryNode();
    const title = makeCategoryNode({ tagName: type === 'chapter' ? 'h3' : 'h4' });
    item.appendChild(handle);
    item.appendChild(copy);
    copy.appendChild(title);
    item.handle = handle;
    item.copy = copy;
    item.title = title;
    items.set(`${type}:${id}`, item);
    return item;
  };
  const makeChapter = (id, pageIds, top) => {
    const chapter = makeItem('chapter', id, top);
    const container = makeCategoryNode({ tagName: 'ol', attrs: { 'data-book-hierarchy-container': `chapter:${id}` } });
    chapter.copy.appendChild(container);
    pageIds.forEach((pageId, index) => container.appendChild(makeItem('page', pageId, index * 50)));
    containers.set(`chapter:${id}`, container);
    return chapter;
  };

  root.appendChild(makeChapter(1, [11, 12], 0));
  root.appendChild(makeItem('page', 21, 50));
  root.appendChild(makeChapter(2, [13], 100));
  root.appendChild(makeChapter(3, [], 150));
  root.appendChild(makeItem('page', 22, 200));
  const live = makeCategoryNode({ attrs: { 'data-book-hierarchy-live': '', 'aria-live': 'polite' } });
  const status = makeCategoryNode({ attrs: { 'data-book-hierarchy-status': '', role: 'status' } });
  editor.appendChild(live);
  document.appendChild(dialog);
  dialog.appendChild(form);
  document.appendChild(foreignForm);
  foreignForm.appendChild(foreignInput);
  form.appendChild(input);
  form.appendChild(legacyItems);
  form.appendChild(legacyNotes);
  form.appendChild(editor);
  form.appendChild(status);
  editor.appendChild(root);

  const target = () => JSON.parse(input.value).target;
  const drag = (item, destination, targetItem = null, clientY = 1000, startTarget = item) => {
    item.dispatch('dragstart', { target: startTarget, dataTransfer: { setData() {} } });
    const eventTarget = targetItem || destination;
    eventTarget.dispatch('dragover', { clientY, dataTransfer: {} });
    eventTarget.dispatch('drop', { clientY, dataTransfer: {} });
  };
  return {
    document, dialog, form, input, foreignInput, legacyItems, legacyNotes, editor, root, items, containers, live, status, expected, target, drag,
  };
}

function removeBookHierarchyItem(fixture, key) {
  const item = fixture.items.get(key);
  const parent = item?.parentElement;
  const index = parent?.children.indexOf(item) ?? -1;
  if (index >= 0) parent.children.splice(index, 1);
  if (item) {
    item.parentElement = null;
    item.parentNode = null;
  }
  fixture.items.delete(key);
  const hierarchy = fixture.expected
    .filter((entry) => `${entry.type}:${entry.id}` !== key)
    .map((entry) => ({ ...entry, pages: entry.pages ? [...entry.pages] : undefined }))
    .map((entry) => entry.pages === undefined ? { type: entry.type, id: entry.id } : entry);
  fixture.input.value = JSON.stringify({ version: 1, expected: hierarchy, target: hierarchy });
  return hierarchy;
}

function bookHierarchyAuthority(fixture, hierarchy) {
  const canonical = JSON.parse(JSON.stringify(hierarchy));
  fixture.input.value = JSON.stringify({ version: 1, expected: canonical, target: canonical });
  return {
    kind: 'active',
    destination: '/notes/books/7',
    replacementEditor: fixture.editor,
    replacementInput: fixture.input,
    replacementDetail: makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }),
    hierarchy: canonical,
  };
}

describe('project category reorder enhancement', () => {
  it('refreshes Project Assets only after the reordered state is confirmed', async () => {
    const fixture = makeCategoryReorderFixture();
    const manager = makeCategoryNode({ attrs: { id: 'project-asset-category-management-dialog' } });
    manager.matches = (selector) => selector === '#project-asset-category-management-dialog';
    manager.ownerDocument = fixture.document;
    manager.appendChild(fixture.section);
    fixture.document.appendChild(manager);
    const changed = vi.fn();
    fixture.document.dispatchEvent = changed;
    const responses = [
      { ok: true, redirected: true, url: 'http://creatorcrate.test/projects/7/assets?notice=category_reordered' },
      { ok: true, redirected: true, url: 'http://creatorcrate.test/projects/7/assets?notice=category_reorder_failed' },
    ];
    await withBrowserGlobals(async () => responses.shift(), async () => {
      enhanceCategoryReorder(fixture.document);
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(fixture.order()).toEqual(['2', '1', '3']);
      expect(changed).toHaveBeenCalledTimes(1);

      fixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(fixture.order()).toEqual(['2', '1', '3']);
      expect(changed).toHaveBeenCalledTimes(1);
    });
  });

  it('is scoped and no-ops when the project reorder list is absent', () => {
    const scope = { querySelectorAll: (selector) => {
      expect(selector).toBe('[data-category-reorder-list]');
      return [];
    } };
    expect(enhanceCategoryReorder(scope)).toBe(0);
  });

  it('moves cards on drop with fetch and submits the complete order once, while an unchanged drop does nothing', async () => {
    const fixture = makeCategoryReorderFixture();
    const unchanged = makeCategoryReorderFixture();
    const calls = [];

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true };
    }, async () => {
      expect(enhanceCategoryReorder(fixture.document)).toBe(1);
      fixture.items[0].dispatch('pointerdown');
      fixture.items[0].dispatch('dragstart', { dataTransfer: { setData() {} } });
      fixture.list.dispatch('dragover', { target: fixture.items[2], clientY: 130, dataTransfer: {} });
      fixture.list.dispatch('drop', { target: fixture.items[2] });
      await flushAsync();

      expect(fixture.order()).toEqual(['2', '3', '1']);
      expect(fixture.orderInput.value).toBe('2,3,1');
      expect(calls).toHaveLength(1);
      expect(calls[0].action).toBe('/projects/7/asset-categories/reorder');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].options.body).toBeInstanceOf(URLSearchParams);
      expect(calls[0].options.body.getAll('_csrf')).toEqual(['csrf-reorder']);
      expect(calls[0].options.body.getAll('orderedCategoryIds')).toEqual(['2,3,1']);
      expect(fixture.submitCount).toBe(0);
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);

      expect(enhanceCategoryReorder(unchanged.document)).toBe(1);
      unchanged.items[0].dispatch('pointerdown');
      unchanged.items[0].dispatch('dragstart', { dataTransfer: { setData() {} } });
      unchanged.list.dispatch('dragover', { target: unchanged.items[1], clientY: 51, dataTransfer: {} });
      unchanged.list.dispatch('drop', { target: unchanged.items[1] });
      await flushAsync();
      expect(unchanged.order()).toEqual(['1', '2', '3']);
      expect(calls).toHaveLength(1);
      expect(unchanged.submitCount).toBe(0);
    });
  });

  it('keeps Project and Settings reorder endpoints, CSRF sources, and orders independent', async () => {
    const project = makeCategoryReorderFixture();
    const settings = makeCategoryReorderFixture({
      action: '/settings/asset-categories/reorder',
      csrfToken: 'csrf-settings-reorder',
      categoryIds: ['41', '42'],
    });
    const requests = [];

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      const scope = {
        querySelectorAll(selector) {
          expect(selector).toBe('[data-category-reorder-list]');
          return [project.list, settings.list];
        },
      };

      expect(enhanceCategoryReorder(scope)).toBe(2);
      project.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      settings.items[0].handle.dispatch('keydown', { key: 'End' });
      await flushAsync();

      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.action)).toEqual([
        '/projects/7/asset-categories/reorder',
        '/settings/asset-categories/reorder',
      ]);
      expect(requests[0].options.body.getAll('_csrf')).toEqual(['csrf-reorder']);
      expect(requests[0].options.body.getAll('orderedCategoryIds')).toEqual(['2,1,3']);
      expect(requests[1].options.body.getAll('_csrf')).toEqual(['csrf-settings-reorder']);
      expect(requests[1].options.body.getAll('orderedCategoryIds')).toEqual(['42,41']);

      requests[0].resolve({ ok: true });
      requests[1].resolve({ ok: true });
      await flushAsync();
      expect(project.order()).toEqual(['2', '1', '3']);
      expect(settings.order()).toEqual(['42', '41']);
    });
  });

  it('allows non-interactive card surfaces and excludes controls, helper, and error content from drag starts', () => {
    const fixture = makeCategoryReorderFixture();
    const title = makeCategoryNode({ tagName: 'span' });
    const slug = makeCategoryNode({ tagName: 'code' });
    const input = makeCategoryNode({ tagName: 'input' });
    const button = makeCategoryNode({ tagName: 'button' });
    const label = makeCategoryNode({ tagName: 'label' });
    const link = makeCategoryNode({ tagName: 'a' });
    const help = makeCategoryNode({ className: 'help-text' });
    const error = makeCategoryNode({ className: 'field-error-message' });
    const alert = makeCategoryNode({ attrs: { role: 'alert' } });
    const live = makeCategoryNode({ attrs: { 'aria-live': 'polite' } });
    const editable = makeCategoryNode({ attrs: { contenteditable: 'plaintext-only' } });
    const noscript = makeCategoryNode({ tagName: 'noscript' });
    const form = makeCategoryNode({ tagName: 'form' });
    const fieldArea = makeCategoryNode({ className: 'category-management-card-fields' });
    const fieldInput = makeCategoryNode({ tagName: 'input' });
    const saveButton = makeCategoryNode({ tagName: 'button' });
    [title, slug, input, button, label, link, help, error, alert, live, editable, noscript, form]
      .forEach((surface) => fixture.items[0].appendChild(surface));
    form.appendChild(fieldArea);
    fieldArea.appendChild(fieldInput);
    form.appendChild(saveButton);
    enhanceCategoryReorder(fixture.document);

    for (const target of [fixture.items[0], title, slug, fixture.items[0].handle, form, fieldArea]) {
      fixture.items[0].dispatch('pointerdown', { target });
      const event = fixture.items[0].dispatch('dragstart', { target, dataTransfer: { setData() {} } });
      expect(event.defaultPrevented).toBe(false);
      fixture.items[0].dispatch('dragend');
    }

    for (const target of [input, button, label, link, help, error, alert, live, editable, noscript, fieldInput, saveButton]) {
      fixture.items[0].dispatch('pointerdown', { target });
      const event = fixture.items[0].dispatch('dragstart', { target, dataTransfer: { setData() {} } });
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('does not start a drag while category text is selected', () => {
    const fixture = makeCategoryReorderFixture();
    const title = makeCategoryNode({ tagName: 'span' });
    fixture.items[0].appendChild(title);
    const originalGetSelection = globalThis.getSelection;
    globalThis.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: title,
      focusNode: title,
    });

    try {
      enhanceCategoryReorder(fixture.document);
      fixture.items[0].dispatch('pointerdown', { target: title });
      const event = fixture.items[0].dispatch('dragstart', {
        target: title,
        dataTransfer: { setData() {} },
      });
      expect(event.defaultPrevented).toBe(true);
    } finally {
      globalThis.getSelection = originalGetSelection;
    }
  });

  it('supports Arrow Up, Arrow Down, Home, End, boundaries, focus, ARIA, and announcements with fetch', async () => {
    const cases = [
      ['ArrowUp', 1, ['2', '1', '3'], '2,1,3', 0],
      ['ArrowDown', 1, ['1', '3', '2'], '1,3,2', 2],
      ['Home', 2, ['3', '1', '2'], '3,1,2', 0],
      ['End', 0, ['2', '3', '1'], '2,3,1', 2],
    ];

    for (const [key, itemIndex, expectedOrder, expectedPayload, expectedPosition] of cases) {
      const fixture = makeCategoryReorderFixture();
      const calls = [];
      await withBrowserGlobals(async (action, options) => {
        calls.push({ action, options });
        return { ok: true };
      }, async () => {
        enhanceCategoryReorder(fixture.document);
        fixture.items[itemIndex].handle.dispatch('keydown', { key });
        expect(fixture.order()).toEqual(expectedOrder);
        expect(fixture.orderInput.value).toBe(expectedPayload);
        expect(fixture.submitCount).toBe(0);
        expect(fixture.document.activeElement).toBe(fixture.items[itemIndex].handle);
        expect(fixture.items[itemIndex].getAttribute('aria-posinset')).toBe(String(expectedPosition + 1));
        expect(fixture.items[itemIndex].getAttribute('aria-setsize')).toBe('3');
        expect(fixture.live.textContent).toContain(`moved to position ${expectedPosition + 1} of 3`);
        await flushAsync();
        expect(calls).toHaveLength(1);
        expect(calls[0].options.body.getAll('orderedCategoryIds')).toEqual([expectedPayload]);
        expect(fixture.form.getAttribute('aria-busy')).toBe(null);
      });
    }

    const boundary = makeCategoryReorderFixture();
    enhanceCategoryReorder(boundary.document);
    boundary.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
    boundary.items[2].handle.dispatch('keydown', { key: 'ArrowDown' });
    boundary.items[2].handle.dispatch('keydown', { key: 'End' });
    expect(boundary.order()).toEqual(['1', '2', '3']);
    expect(boundary.submitCount).toBe(0);
  });

  it('persists once after repeated enhancement and restores order, ARIA, and keyboard focus after failure', async () => {
    const fixture = makeCategoryReorderFixture();
    const calls = [];

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: false, status: 503 };
    }, async () => {
      expect(enhanceCategoryReorder(fixture.document)).toBe(1);
      expect(enhanceCategoryReorder(fixture.document)).toBe(1);
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(calls).toHaveLength(1);
      expect(fixture.order()).toEqual(['1', '2', '3']);
      expect(fixture.items[0].getAttribute('aria-posinset')).toBe('1');
      expect(fixture.items[1].getAttribute('aria-posinset')).toBe('2');
      expect(fixture.items[1].getAttribute('aria-setsize')).toBe('3');
      expect(fixture.document.activeElement).toBe(fixture.items[1].handle);
      expect(fixture.live.textContent).toContain('previous order was restored');
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
      expect(fixture.submitCount).toBe(0);
    });
  });

  it('uses a successful response as the confirmed baseline for a later failed reorder', async () => {
    const fixture = makeCategoryReorderFixture();
    let call = 0;

    await withBrowserGlobals(() => {
      call += 1;
      return call === 1 ? { ok: true } : { ok: false, status: 409 };
    }, async () => {
      enhanceCategoryReorder(fixture.document);
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(fixture.order()).toEqual(['2', '1', '3']);

      fixture.items[2].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(fixture.order()).toEqual(['2', '1', '3']);
      expect(fixture.items[1].getAttribute('aria-posinset')).toBe('1');
      expect(fixture.items[0].getAttribute('aria-posinset')).toBe('2');
      expect(fixture.items[2].getAttribute('aria-posinset')).toBe('3');
      expect(fixture.live.textContent).toContain('previous order was restored');
    });
  });

  it('rejects overlapping keyboard moves until the first response confirms the current order', async () => {
    const fixture = makeCategoryReorderFixture();
    const requests = [];

    await withBrowserGlobals(() => new Promise((resolve) => requests.push(resolve)), async () => {
      enhanceCategoryReorder(fixture.document);
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(requests).toHaveLength(1);

      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowDown' });
      expect(fixture.order()).toEqual(['2', '1', '3']);
      expect(requests).toHaveLength(1);

      requests[0]({ ok: true });
      await flushAsync();
      expect(fixture.order()).toEqual(['2', '1', '3']);
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
    });
  });
});

describe('top-level Book reorder enhancement', () => {
  it('moves rows from the whole card, excludes interactive descendants, and persists a completed drop immediately', () => {
    const fixture = makeBookReorderFixture();
    const calls = [];
    const authority = makeBookReorderAuthority(['202', '303', '101']);
    let authorityFetches = 0;
    let shelfInstalls = 0;

    return withBrowserGlobals((...args) => {
      calls.push(args);
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: [202, 303, 101] }),
      });
    }, async () => {
      expect(enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 1,
        installShelf: (_scope, generation, shelf) => {
          expect(generation).toBe(1);
          expect(shelf).toBe(authority.snapshot.replacementShelf);
          shelfInstalls += 1;
          return 'installed';
        },
        fetchAuthority: async () => {
          authorityFetches += 1;
          return authority.snapshot;
        },
      })).toBe(1);

      const link = makeCategoryNode({ tagName: 'a' });
      fixture.items[0].appendChild(link);
      const rowDrag = fixture.items[0].dispatch('dragstart', { dataTransfer: { setData() {} } });
      expect(rowDrag.defaultPrevented).toBe(false);
      fixture.items[0].dispatch('dragend');
      const interactiveDrag = fixture.items[0].dispatch('dragstart', { target: link, dataTransfer: { setData() {} } });
      expect(interactiveDrag.defaultPrevented).toBe(true);
      // This lightweight DOM only bubbles; invoke the capture listener directly.
      const pointerDown = fixture.items[0].listeners.find(entry => entry.type === 'pointerdown').handler;
      pointerDown({ target: link, button: 0 });
      // Native Chromium reports the draggable ancestor, not the pressed link.
      expect(fixture.items[0].dispatch('dragstart').defaultPrevented).toBe(true);
      expect(fixture.orderInput.value).toBe('101,202,303');
      pointerDown({ target: fixture.items[0], button: 0 });
      expect(fixture.items[0].dispatch('dragstart').defaultPrevented).toBe(false);
      fixture.items[0].dispatch('dragend');
      fixture.items[0].handle.dispatch('dragstart', { dataTransfer: { setData() {} } });
      expect(fixture.items[0].classList.contains('is-dragging')).toBe(true);
      fixture.list.dispatch('dragover', {
        target: fixture.items[2],
        clientY: 130,
        dataTransfer: {},
      });
      expect(fixture.items[2].classList.contains('is-drop-after')).toBe(true);
      fixture.list.dispatch('drop', { target: fixture.items[2] });

      expect(fixture.order()).toEqual(['202', '303', '101']);
      expect(fixture.orderInput.value).toBe('202,303,101');
      expect(fixture.items[0].classList.contains('is-dragging')).toBe(false);
      expect(fixture.items[2].classList.contains('is-drop-after')).toBe(false);
      await flushAsync();
      await flushAsync();
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('/notes/books/reorder');
      expect(calls[0][1]).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      expect(calls[0][1].body.get('orderedBookIds')).toBe('202,303,101');
      expect(authorityFetches).toBe(1);
      expect(shelfInstalls).toBe(1);
      expect(fixture.list.__creatorCrateBookReorderState.acknowledgedIds).toEqual(['202', '303', '101']);
      expect(fixture.status.textContent).toBe('Book order saved.');
    });
  });

  it('queues rapid keyboard moves and acknowledges the newest complete order', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    const authority = makeBookReorderAuthority(['303', '202', '101']);
    let authorityFetches = 0;

    await withBrowserGlobals((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 2,
        installShelf: () => 'installed',
        fetchAuthority: async () => {
          authorityFetches += 1;
          return authority.snapshot;
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();

      expect(fixture.order()).toEqual(['202', '101', '303']);
      expect(fixture.items[1].position.textContent).toBe('Position 1 of 3');
      expect(fixture.items[1].getAttribute('aria-posinset')).toBe('1');
      expect(fixture.items[1].getAttribute('aria-setsize')).toBe('3');
      expect(fixture.items[1].handle.focused).toBe(true);
      expect(fixture.live.textContent).toContain('moved to position 1 of 3');
      expect(requests).toHaveLength(1);

      fixture.items[2].handle.dispatch('keydown', { key: 'Home' });
      expect(fixture.order()).toEqual(['303', '202', '101']);
      expect(requests).toHaveLength(1);

      requests[0].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: [202, 101, 303] }),
      });
      await flushAsync();
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('orderedBookIds')).toBe('303,202,101');
      expect(authorityFetches).toBe(0);

      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: [303, 202, 101] }),
      });
      await flushAsync();
      await flushAsync();
      await flushAsync();
      expect(fixture.order()).toEqual(['303', '202', '101']);
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
      expect(fixture.status.textContent).toBe('Book order saved.');
      expect(authorityFetches).toBe(1);
      expect(fixture.list.__creatorCrateBookReorderState.acknowledgedIds).toEqual(['303', '202', '101']);
    });
  });

  it('does not treat a rejected response as success and restores server authority', async () => {
    const fixture = makeBookReorderFixture();
    const authority = makeBookReorderAuthority(['101', '202', '303']);
    let authorityFetches = 0;

    await withBrowserGlobals(() => Promise.resolve({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'The submitted book order is invalid.',
        orderedBookIds: [101, 202, 303],
      }),
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 3,
        installShelf: () => 'installed',
        fetchAuthority: async () => {
          authorityFetches += 1;
          return authority.snapshot;
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      await flushAsync();

      expect(fixture.order()).toEqual(['101', '202', '303']);
      expect(fixture.orderInput.value).toBe('101,202,303');
      expect(fixture.form.getAttribute('data-book-reorder-state')).toBe('error');
      expect(fixture.status.textContent).toContain('invalid');
      expect(authorityFetches).toBe(1);
      expect(fixture.list.__creatorCrateBookReorderState.acknowledgedIds).toEqual(['101', '202', '303']);
    });
  });

  it('installs same-membership rejection authority before dispatching one queued newer order', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    let canonicalOrder = ['101', '303', '202'];
    let releaseAuthority;
    let authorityFetches = 0;
    let shelfInstalls = 0;

    await withBrowserGlobals((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve, displayedOrder: fixture.order() });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 4,
        installShelf: () => {
          shelfInstalls += 1;
          return 'installed';
        },
        fetchAuthority: async () => {
          authorityFetches += 1;
          if (authorityFetches === 1) await new Promise((resolve) => { releaseAuthority = resolve; });
          return makeBookReorderAuthority(canonicalOrder, 4).snapshot;
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      const rejectedActive = fixture.order();
      fixture.items[2].handle.dispatch('keydown', { key: 'Home' });
      const queuedOrder = fixture.order();

      requests[0].resolve({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          message: 'The submitted book order is stale.',
          orderedBookIds: [101, 303, 202],
        }),
      });
      await flushAsync();
      await flushAsync();

      expect(authorityFetches).toBe(1);
      expect(shelfInstalls).toBe(0);
      expect(requests).toHaveLength(1);
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');
      expect(fixture.form.dispatch('submit').defaultPrevented).toBe(true);
      fixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      fixture.items[0].handle.dispatch('dragstart', { dataTransfer: { setData() {} } });
      fixture.list.dispatch('drop', { target: fixture.items[1] });
      expect(requests).toHaveLength(1);

      releaseAuthority();
      await flushAsync();
      await flushAsync();

      expect(shelfInstalls).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('orderedBookIds')).toBe(queuedOrder.join(','));
      expect(requests[1].displayedOrder).toEqual(queuedOrder);
      expect(requests[1].displayedOrder).not.toEqual(rejectedActive);

      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: queuedOrder.map(Number) }),
      });
      canonicalOrder = queuedOrder;
      await flushAsync();
      await flushAsync();
      await flushAsync();

      fixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(requests).toHaveLength(3);
      expect(requests[2].options.body.get('orderedBookIds')).toBe('303,101,202');
      requests[2].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: [303, 101, 202] }),
      });
      canonicalOrder = ['303', '101', '202'];
      await flushAsync();
      await flushAsync();
    });
  });

  it('does not apply queued intent when canonical membership changes after a controlled rejection', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    let freshFixture;
    let authorityFetches = 0;
    let shelfInstalls = 0;

    await withBrowserGlobals((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 7,
        installShelf: (_scope, generation) => {
          expect(generation).toBe(7);
          shelfInstalls += 1;
          return 'installed';
        },
        fetchAuthority: async () => {
          authorityFetches += 1;
          freshFixture = makeBookReorderFixture({ bookIds: ['202', '101', '404'] });
          return {
            generation: 7,
            replacementShelf: makeCategoryNode({ attrs: { 'data-notes-books-live-region': '' } }),
            replacementForm: freshFixture.form,
            authority: ['202', '101', '404'],
          };
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      fixture.items[2].handle.dispatch('keydown', { key: 'Home' });
      const queuedOrder = fixture.order();

      requests[0].resolve({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          message: 'The submitted book order is invalid.',
          orderedBookIds: [101, 303, 202],
        }),
      });
      await flushAsync();
      await flushAsync();

      expect(fixture.form.getAttribute('aria-busy')).toBe('true');
      expect(fixture.form.dispatch('submit').defaultPrevented).toBe(true);
      const blockedOrder = fixture.order();
      expect(blockedOrder).toEqual(['101', '303', '202']);
      fixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      fixture.items[0].handle.dispatch('dragstart', { dataTransfer: { setData() {} } });
      fixture.list.dispatch('drop', { target: fixture.items[1] });
      expect(fixture.order()).toEqual(blockedOrder);
      expect(requests).toHaveLength(1);

      await flushAsync();
      await flushAsync();
      expect(authorityFetches).toBe(1);
      expect(shelfInstalls).toBe(1);
      expect(fixture.list.__creatorCrateBookReorderState.retired).toBe(true);
      expect(fixture.dialog.querySelector('[data-book-reorder-form]')).toBe(freshFixture.form);
      expect(freshFixture.list.__creatorCrateBookReorderState.acknowledgedIds)
        .toEqual(['202', '101', '404']);
      expect(freshFixture.status.textContent).toContain('pending local reorder was not applied');
      expect(freshFixture.items[0].handle.focused).not.toBe(true);
      expect(fixture.dialog.querySelector('[data-book-reorder-form]')).toBe(freshFixture.form);
      fixture.dialog.open = true;
      expect(fixture.dialog.querySelector('[data-book-reorder-form]')).toBe(freshFixture.form);
      expect(requests).toHaveLength(1);

      fixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      expect(requests).toHaveLength(1);

      freshFixture.items[0].handle.dispatch('keydown', { key: 'End' });
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('orderedBookIds')).toBe('101,404,202');
      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: [101, 404, 202] }),
      });
      await flushAsync();
    });
  });

  it('publishes empty canonical authority and reports that queued intent was not applied', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    const emptyForm = makeCategoryNode({
      tagName: 'form',
      attrs: { 'data-book-reorder-form': '' },
    });
    const emptyStatus = makeCategoryNode({ attrs: { 'data-book-reorder-status': '' } });
    emptyForm.appendChild(emptyStatus);

    await withBrowserGlobals((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 8,
        installShelf: () => 'installed',
        fetchAuthority: async () => ({
          kind: 'empty',
          generation: 8,
          replacementShelf: makeCategoryNode({ attrs: { 'data-notes-books-live-region': '' } }),
          replacementForm: emptyForm,
          authority: [],
        }),
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      fixture.items[2].handle.dispatch('keydown', { key: 'Home' });

      requests[0].resolve({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          message: 'The submitted book order is stale.',
          orderedBookIds: [101, 303, 202],
        }),
      });
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.list.__creatorCrateBookReorderState).toMatchObject({
        retired: true,
        acknowledgedIds: [],
        queuedIds: null,
      });
      expect(fixture.dialog.querySelector('[data-book-reorder-form]')).toBe(emptyForm);
      expect(emptyStatus.textContent).toContain('pending local reorder was not applied');
    });
  });

  it('keeps queued intent blocked across controlled-rejection synchronization failure and Retry', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    const canonicalIds = ['101', '303', '202'];
    let authorityFetches = 0;

    await withBrowserGlobals((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 9,
        installShelf: () => 'installed',
        fetchAuthority: async () => {
          authorityFetches += 1;
          return authorityFetches === 1 ? null : makeBookReorderAuthority(canonicalIds, 9).snapshot;
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      fixture.items[2].handle.dispatch('keydown', { key: 'Home' });
      const queuedOrder = fixture.order();

      requests[0].resolve({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          message: 'The submitted book order is stale.',
          orderedBookIds: canonicalIds.map(Number),
        }),
      });
      await flushAsync();
      await flushAsync();

      const retry = fixture.status.querySelector('[data-book-reorder-reconciliation-retry]');
      expect(retry).toBeTruthy();
      expect(requests).toHaveLength(1);
      expect(fixture.list.__creatorCrateBookReorderState.retired).toBe(true);
      fixture.items[0].handle.dispatch('keydown', { key: 'End' });
      expect(requests).toHaveLength(1);

      retry.dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(authorityFetches).toBe(2);
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('orderedBookIds')).toBe(queuedOrder.join(','));
      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: queuedOrder.map(Number) }),
      });
      await flushAsync();
      await flushAsync();
      expect(requests).toHaveLength(2);
    });
  });

  it('keeps the retired controller blocked and exposes one functional Retry after recovery failure', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    let freshFixture;
    let recoveryAttempts = 0;

    await withBrowserGlobals((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 3,
        installShelf: () => 'installed',
        fetchAuthority: async () => {
          recoveryAttempts += 1;
          if (recoveryAttempts === 1) return null;
          freshFixture = makeBookReorderFixture({ bookIds: ['303', '202'] });
          return {
            generation: 3,
            replacementShelf: makeCategoryNode({ attrs: { 'data-notes-books-live-region': '' } }),
            replacementForm: freshFixture.form,
            authority: ['303', '202'],
          };
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      requests[0].resolve({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          message: 'The submitted book order is stale.',
          orderedBookIds: [303, 202],
        }),
      });
      await flushAsync();
      await flushAsync();

      const retry = fixture.status.querySelector('[data-book-reorder-reconciliation-retry]');
      expect(retry).toBeTruthy();
      expect(retry.tagName).toBe('BUTTON');
      expect(retry.focused).not.toBe(true);
      expect(fixture.status.textContent).not.toContain('close and reopen');
      expect(fixture.list.__creatorCrateBookReorderState.retired).toBe(true);
      fixture.items[0].handle.dispatch('keydown', { key: 'End' });
      expect(requests).toHaveLength(1);

      retry.dispatch('click');
      await flushAsync();
      await flushAsync();
      expect(recoveryAttempts).toBe(2);
      expect(fixture.dialog.querySelectorAll('[data-book-reorder-reconciliation-retry]')).toHaveLength(0);
      expect(fixture.dialog.querySelector('[data-book-reorder-form]')).toBe(freshFixture.form);

      freshFixture.items[0].handle.dispatch('keydown', { key: 'End' });
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('orderedBookIds')).toBe('202,303');
      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: [202, 303] }),
      });
      await flushAsync();
    });
  });

  it('detects a failed controlled-authority DOM restoration and remains reconciling', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    const authority = makeBookReorderAuthority(['101', '202', '303'], 5);

    await withBrowserGlobals((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 5,
        installShelf: () => 'unavailable',
        fetchAuthority: async () => authority.snapshot,
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      requests[0].resolve({
        ok: false,
        status: 422,
        json: async () => ({ status: 'error', orderedBookIds: [101, 202, 303] }),
      });
      await flushAsync();
      await flushAsync();

      expect(fixture.status.querySelector('[data-book-reorder-reconciliation-retry]')).toBeTruthy();
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');
      expect(fixture.order()).toEqual(['101', '202', '303']);
      expect(requests).toHaveLength(1);
    });
  });

  it('blocks stale interaction and preserves a queued newer order across lost-response reconciliation', async () => {
    const fixture = makeBookReorderFixture();
    let freshFixture;
    let authorityFetches = 0;
    let shelfInstalls = 0;
    let releaseAuthority;
    const canonicalIds = ['202', '101', '303'];
    const requests = [];

    await withBrowserGlobals((url, options) => new Promise((resolve, reject) => {
      requests.push({
        url,
        options,
        resolve,
        reject,
        displayedOrder: freshFixture ? freshFixture.order() : fixture.order(),
      });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        refreshShelf: (_scope, callbacks) => {
          callbacks.onComplete();
          return 'started';
        },
        beginShelfRefresh: () => 11,
        installShelf: (_scope, generation) => {
          expect(generation).toBe(11);
          shelfInstalls += 1;
          return 'installed';
        },
        fetchAuthority: async () => {
          authorityFetches += 1;
          if (authorityFetches > 1) {
            return makeBookReorderAuthority(['303', '202', '101'], 11).snapshot;
          }
          await new Promise((resolve) => { releaseAuthority = resolve; });
          freshFixture = makeBookReorderFixture({ bookIds: canonicalIds });
          return {
            kind: 'active',
            generation: 11,
            replacementShelf: makeCategoryNode({ attrs: { 'data-notes-books-live-region': '' } }),
            replacementForm: freshFixture.form,
            authority: canonicalIds,
          };
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      fixture.items[2].handle.dispatch('keydown', { key: 'Home' });
      const queuedOrder = ['303', '202', '101'];
      expect(fixture.order()).toEqual(queuedOrder);
      expect(requests).toHaveLength(1);

      requests[0].reject(new Error('response lost'));
      await flushAsync();
      await flushAsync();
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');

      expect(fixture.form.dispatch('submit').defaultPrevented).toBe(true);
      fixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      fixture.items[0].handle.dispatch('dragstart', { dataTransfer: { setData() {} } });
      fixture.list.dispatch('drop', { target: fixture.items[1] });
      expect(fixture.order()).toEqual(queuedOrder);
      expect(requests).toHaveLength(1);

      releaseAuthority();
      await flushAsync();
      await flushAsync();

      expect(authorityFetches).toBe(1);
      expect(shelfInstalls).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[1].options.body.get('orderedBookIds')).toBe(queuedOrder.join(','));
      expect(requests[1].displayedOrder).toEqual(queuedOrder);
      expect(freshFixture.orderInput.value).toBe(queuedOrder.join(','));

      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', orderedBookIds: queuedOrder.map(Number) }),
      });
      await flushAsync();
      await flushAsync();
      await flushAsync();
      expect(freshFixture.form.getAttribute('aria-busy')).toBe(null);

      freshFixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      expect(requests).toHaveLength(3);
      expect(requests[2].options.body.get('orderedBookIds')).toBe('202,303,101');
      requests[2].resolve({
        ok: false,
        status: 409,
        json: async () => ({ status: 'error', orderedBookIds: queuedOrder.map(Number) }),
      });
      await flushAsync();
      await flushAsync();
      expect(freshFixture.order()).toEqual(queuedOrder);
      expect(freshFixture.orderInput.value).toBe(queuedOrder.join(','));
    });
  });

  it('uses one complete authority snapshot when uncertain recovery discovers changed membership', async () => {
    const fixture = makeBookReorderFixture();
    const requests = [];
    let freshFixture;
    let authorityFetches = 0;
    let shelfInstalls = 0;

    await withBrowserGlobals((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }), async () => {
      enhanceBookReorder(fixture.document, {
        beginShelfRefresh: () => 13,
        installShelf: () => {
          shelfInstalls += 1;
          return 'installed';
        },
        fetchAuthority: async () => {
          authorityFetches += 1;
          freshFixture = makeBookReorderFixture({ bookIds: ['202', '101'] });
          return {
            kind: 'active',
            generation: 13,
            replacementShelf: makeCategoryNode({ attrs: { 'data-notes-books-live-region': '' } }),
            replacementForm: freshFixture.form,
            authority: ['202', '101'],
          };
        },
      });
      fixture.items[1].handle.dispatch('keydown', { key: 'ArrowUp' });
      await flushAsync();
      fixture.items[2].handle.dispatch('keydown', { key: 'Home' });
      requests[0].reject(new Error('response lost'));
      await flushAsync();
      await flushAsync();

      expect(authorityFetches).toBe(1);
      expect(shelfInstalls).toBe(1);
      expect(freshFixture.status.textContent).toContain('pending local reorder was not applied');
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');
      expect(fixture.list.__creatorCrateBookReorderState.retired).toBe(true);
      expect(fixture.dialog.querySelector('[data-book-reorder-form]')).toBe(freshFixture.form);

      const blockedOrder = fixture.order();
      fixture.items[0].handle.dispatch('keydown', { key: 'ArrowUp' });
      fixture.items[0].handle.dispatch('dragstart', { dataTransfer: { setData() {} } });
      fixture.list.dispatch('drop', { target: fixture.items[1] });
      await flushAsync();
      expect(fixture.order()).toEqual(blockedOrder);
      expect(requests).toHaveLength(1);
    });
  });

  it('is idempotent and keeps native form submission intact', () => {
    const fixture = makeBookReorderFixture();

    expect(enhanceBookReorder(fixture.document)).toBe(1);
    expect(enhanceBookReorder(fixture.document)).toBe(1);
    expect(fixture.list.listeners.filter((listener) => listener.type === 'dragover')).toHaveLength(1);
    expect(fixture.items[0].handle.listeners.filter((listener) => listener.type === 'keydown')).toHaveLength(1);
    expect(fixture.form.listeners.filter((listener) => listener.type === 'submit')).toHaveLength(1);
  });
});

describe('Chapter Page reorder enhancement', () => {
  it('keeps numeric Page IDs synchronized through keyboard movement and native Save', () => {
    const fixture = makeChapterPageReorderFixture();

    expect(enhanceChapterPageReorder(fixture.document)).toBe(1);
    expect(fixture.orderInput.value).toBe('11,22,33');

    fixture.items[0].handle.dispatch('keydown', { key: 'ArrowDown' });
    expect(fixture.order()).toEqual(['22', '11', '33']);
    expect(fixture.orderInput.value).toBe('22,11,33');
    expect(fixture.items[0].handle.focused).toBe(true);
    expect(fixture.live.textContent).toContain('Page 11 moved to position 2 of 3');

    const submit = fixture.form.dispatch('submit');
    expect(submit.defaultPrevented).toBe(false);
    expect(fixture.orderInput.value).toBe('22,11,33');
  });

  it.each([
    ['ArrowUp', 0],
    ['ArrowDown', 2],
    ['Home', 0],
    ['End', 2],
  ])('keeps boundary key %s on Page index %i as a native-only no-op', (key, itemIndex) => {
    const fixture = makeChapterPageReorderFixture();
    const fetch = vi.fn();
    const requestSubmit = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;
    fixture.form.requestSubmit = requestSubmit;

    try {
      expect(enhanceChapterPageReorder(fixture.document)).toBe(1);
      const orderBefore = fixture.order();
      const orderInputBefore = fixture.orderInput.value;
      const liveBefore = fixture.live.textContent;
      const handle = fixture.items[itemIndex].handle;
      handle.focus();
      expect(fixture.document.activeElement).toBe(handle);

      const event = handle.dispatch('keydown', { key });

      expect(event.defaultPrevented).toBe(true);
      expect(fixture.order()).toEqual(orderBefore);
      expect(fixture.orderInput.value).toBe(orderInputBefore);
      expect(requestSubmit).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.live.textContent).toBe(liveBefore);
      expect(fixture.document.activeElement).toBe(handle);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('mixed Book-content reorder enhancement', () => {
  it('keeps typed identities opaque through drag and native Save synchronization', async () => {
    const fixture = makeBookContentReorderFixture();
    let requestCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      requestCount += 1;
      return Promise.resolve({ ok: true });
    };

    try {
      expect(enhanceBookContentReorder(fixture.document)).toBe(1);
      expect(fixture.orderInput.value).toBe('chapter:7,page:7,chapter:8,page:8');
      fixture.items[0].handle.dispatch('dragstart', { dataTransfer: { setData() {} } });
      fixture.list.dispatch('dragover', {
        target: fixture.items[3],
        clientY: 1000,
        dataTransfer: {},
      });
      fixture.list.dispatch('drop', { target: fixture.items[3] });

      expect(fixture.order()).toEqual(['page:7', 'chapter:8', 'page:8', 'chapter:7']);
      expect(fixture.orderInput.value).toBe('page:7,chapter:8,page:8,chapter:7');
      expect(fixture.items[0].classList.contains('is-dragging')).toBe(false);
      expect(fixture.items[3].classList.contains('is-drop-after')).toBe(false);
      expect(requestCount).toBe(0);

      expect(new Set(fixture.order())).toEqual(new Set(['chapter:7', 'page:7', 'chapter:8', 'page:8']));

      fixture.list.insertBefore(fixture.items[3], fixture.items[0]);
      const submit = fixture.form.dispatch('submit');
      expect(submit.defaultPrevented).toBe(false);
      expect(fixture.orderInput.value).toBe(fixture.order().join(','));
      expect(requestCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});

describe('connected Book hierarchy reorder enhancement', () => {
  it('uses direct-child container membership, initializes once, and scopes synchronization to hierarchy', () => {
    const fixture = makeBookHierarchyReorderFixture();

    expect(enhanceBookHierarchyReorder(fixture.document)).toBe(1);
    const closeHook = fixture.dialog.__creatorCrateAppDialogState.onClose;
    expect(enhanceBookHierarchyReorder(fixture.document)).toBe(1);
    expect(fixture.editor.listeners.filter(({ type }) => type === 'dragover')).toHaveLength(1);
    expect(fixture.editor.listeners.filter(({ type }) => type === 'keydown')).toHaveLength(1);
    expect(fixture.editor.listeners.filter(({ type }) => type === 'click')).toHaveLength(0);
    expect(fixture.form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
    expect(fixture.dialog.__creatorCrateAppDialogState.onClose).toBe(closeHook);
    expect(fixture.editor.querySelectorAll('[data-book-hierarchy-live]')).toHaveLength(1);
    expect(fixture.editor.querySelectorAll('[data-book-hierarchy-destination]')).toHaveLength(0);
    expect(fixture.editor.querySelectorAll('[data-book-hierarchy-move]')).toHaveLength(0);
    expect(fixture.items.get('chapter:1').getAttribute('aria-setsize')).toBe('5');
    expect(fixture.items.get('page:11').getAttribute('aria-setsize')).toBe('2');
    expect(fixture.items.get('page:13').getAttribute('aria-setsize')).toBe('1');
    expect(fixture.legacyItems.value).toBe('keep-items');
    expect(fixture.legacyNotes.value).toBe('keep-notes');
    expect(fixture.foreignInput.value).toBe('foreign-hierarchy');
    expect(JSON.parse(fixture.input.value)).toEqual({ version: 1, expected: fixture.expected, target: fixture.expected });
  });

  it('moves a root Page into a Chapter and preserves the immutable expected baseline', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);

    fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:1'));

    const payload = JSON.parse(fixture.input.value);
    expect(payload.expected).toEqual(fixture.expected);
    expect(payload.target).toEqual([
      { type: 'chapter', id: 1, pages: [11, 12, 21] },
      { type: 'chapter', id: 2, pages: [13] },
      { type: 'chapter', id: 3, pages: [] },
      { type: 'page', id: 22 },
    ]);
    expect(fixture.items.get('page:21').classList.contains('is-dragging')).toBe(false);
    expect(fixture.items.get('page:12').classList.contains('is-drop-after')).toBe(false);
    expect(fixture.items.get('page:12').getAttribute('data-drop-position')).toBe(null);
    expect(fixture.containers.get('chapter:1').classList.contains('is-drop-target')).toBe(false);
    expect(fixture.legacyItems.value).toBe('keep-items');
    expect(fixture.legacyNotes.value).toBe('keep-notes');
  });

  it('moves a Chapter Page to root and resolves its current container on the next drag', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const page = fixture.items.get('page:11');

    fixture.drag(page, fixture.root, fixture.items.get('chapter:2'), 0);
    expect(fixture.target()).toEqual([
      { type: 'chapter', id: 1, pages: [12] },
      { type: 'page', id: 21 },
      { type: 'page', id: 11 },
      { type: 'chapter', id: 2, pages: [13] },
      { type: 'chapter', id: 3, pages: [] },
      { type: 'page', id: 22 },
    ]);

    fixture.drag(page, fixture.containers.get('chapter:2'));
    expect(fixture.target().find((item) => item.type === 'chapter' && item.id === 2).pages).toEqual([13, 11]);
  });

  it('moves Pages between Chapters and reorders within their current Chapter', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const page = fixture.items.get('page:12');

    fixture.drag(page, fixture.containers.get('chapter:2'));
    expect(fixture.target().find((item) => item.type === 'chapter' && item.id === 2).pages).toEqual([13, 12]);
    fixture.drag(page, fixture.containers.get('chapter:2'), fixture.items.get('page:13'), 0);
    expect(fixture.target().find((item) => item.type === 'chapter' && item.id === 2).pages).toEqual([12, 13]);
  });

  it('reorders Chapters only at root and carries their nested Pages', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const chapter = fixture.items.get('chapter:1');

    fixture.drag(chapter, fixture.root, fixture.items.get('chapter:3'), 1000);

    expect(fixture.target()).toEqual([
      { type: 'page', id: 21 },
      { type: 'chapter', id: 2, pages: [13] },
      { type: 'chapter', id: 3, pages: [] },
      { type: 'chapter', id: 1, pages: [11, 12] },
      { type: 'page', id: 22 },
    ]);
  });

  it('accepts root and Chapter Pages in an empty Chapter without needing a child target', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const empty = fixture.containers.get('chapter:3');

    fixture.drag(fixture.items.get('page:21'), empty);
    fixture.drag(fixture.items.get('page:13'), empty);

    expect(fixture.target().find((item) => item.type === 'chapter' && item.id === 3).pages).toEqual([21, 13]);
  });

  it('resolves whole-card drag ownership for root Pages, Chapters, and nested Pages', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const chapter = fixture.items.get('chapter:1');
    const nestedPage = fixture.items.get('page:11');
    const rootPage = fixture.items.get('page:21');

    for (const target of [rootPage, rootPage.copy, rootPage.title]) {
      rootPage.dispatch('dragstart', { target, dataTransfer: { setData() {} } });
      expect(rootPage.classList.contains('is-dragging')).toBe(true);
      rootPage.dispatch('dragend');
    }

    chapter.dispatch('dragstart', { target: chapter.title, dataTransfer: { setData() {} } });
    expect(chapter.classList.contains('is-dragging')).toBe(true);
    chapter.dispatch('dragend');

    nestedPage.dispatch('dragstart', { target: nestedPage.title, dataTransfer: { setData() {} } });
    expect(nestedPage.classList.contains('is-dragging')).toBe(true);
    expect(chapter.classList.contains('is-dragging')).toBe(false);
    nestedPage.dispatch('dragend');

    nestedPage.handle.dispatch('dragstart', { dataTransfer: { setData() {} } });
    expect(nestedPage.classList.contains('is-dragging')).toBe(true);
    nestedPage.dispatch('dragend');
  });

  it('keeps Chapters root-only and ignores invalid or external destinations', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const initialValue = fixture.input.value;
    const chapter = fixture.items.get('chapter:1');

    fixture.drag(chapter, fixture.containers.get('chapter:2'));
    expect(fixture.input.value).toBe(initialValue);

    fixture.containers.get('chapter:2').dispatch('drop', { dataTransfer: { getData: () => 'foreign' } });
    expect(fixture.input.value).toBe(initialValue);
    expect(fixture.editor.classList.contains('is-dragging')).toBe(false);
    expect(chapter.classList.contains('is-dragging')).toBe(false);
  });

  it('tracks item, append, and empty insertion state without broad container targets and cleans every exit path', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const page = fixture.items.get('page:21');
    const chapter = fixture.items.get('chapter:1');

    page.dispatch('dragstart', { dataTransfer: { setData() {} } });
    fixture.items.get('page:13').dispatch('dragover', { clientY: 0, dataTransfer: {} });
    expect(fixture.items.get('page:13').classList.contains('is-drop-before')).toBe(true);
    expect(fixture.items.get('page:13').getAttribute('data-drop-position')).toBe('before');
    expect(fixture.containers.get('chapter:2').classList.contains('is-drop-target')).toBe(false);

    fixture.containers.get('chapter:2').dispatch('dragover', { dataTransfer: {} });
    expect(fixture.items.get('page:13').classList.contains('is-drop-after')).toBe(true);
    expect(fixture.items.get('page:13').getAttribute('data-drop-position')).toBe('append');

    const empty = fixture.containers.get('chapter:3');
    empty.dispatch('dragover', { dataTransfer: {} });
    expect(empty.classList.contains('is-drop-empty')).toBe(true);
    expect(empty.getAttribute('data-drop-position')).toBe('empty');
    expect(empty.classList.contains('is-drop-target')).toBe(false);
    empty.dispatch('dragleave', { relatedTarget: null });
    expect(empty.classList.contains('is-drop-empty')).toBe(false);
    expect(empty.getAttribute('data-drop-position')).toBe(null);

    fixture.items.get('page:13').dispatch('dragover', { clientY: 0, dataTransfer: {} });
    page.handle.dispatch('keydown', { key: 'Escape' });
    expect(page.classList.contains('is-dragging')).toBe(false);
    expect(fixture.items.get('page:13').classList.contains('is-drop-before')).toBe(false);

    page.dispatch('dragstart', { dataTransfer: { setData() {} } });
    page.dispatch('dragend');
    expect(fixture.editor.classList.contains('is-dragging')).toBe(false);

    chapter.dispatch('dragstart', { dataTransfer: { setData() {} } });
    fixture.containers.get('chapter:2').dispatch('drop');
    expect(chapter.classList.contains('is-dragging')).toBe(false);
    expect(fixture.containers.get('chapter:2').classList.contains('is-drop-target')).toBe(false);
  });

  it('moves Pages and Chapters by keyboard within their current container with focus and announcements', () => {
    const fixture = makeBookHierarchyReorderFixture();
    enhanceBookHierarchyReorder(fixture.document);
    const page = fixture.items.get('page:11');

    page.handle.dispatch('keydown', { key: 'ArrowDown' });
    expect(fixture.target()[0].pages).toEqual([12, 11]);
    expect(page.handle.focused).toBe(true);
    expect(fixture.live.textContent).toBe('Page “Page 11” moved to Chapter “Chapter 1”, position 2 of 2.');
    expect(JSON.parse(fixture.input.value).expected).toEqual(fixture.expected);

    page.handle.dispatch('keydown', { key: 'Home' });
    expect(fixture.target()[0].pages).toEqual([11, 12]);
    page.handle.dispatch('keydown', { key: 'End' });
    expect(fixture.target()[0].pages).toEqual([12, 11]);
    const boundary = fixture.input.value;
    page.handle.dispatch('keydown', { key: 'ArrowDown' });
    expect(fixture.input.value).toBe(boundary);

    const rootPage = fixture.items.get('page:21');
    rootPage.handle.dispatch('keydown', { key: 'ArrowDown' });
    expect(fixture.target().map((item) => `${item.type}:${item.id}`)).toEqual([
      'chapter:1', 'chapter:2', 'page:21', 'chapter:3', 'page:22',
    ]);
    rootPage.handle.dispatch('keydown', { key: 'Home' });
    expect(fixture.target()[0]).toEqual({ type: 'page', id: 21 });
    rootPage.handle.dispatch('keydown', { key: 'End' });
    expect(fixture.target().at(-1)).toEqual({ type: 'page', id: 21 });

    const chapter = fixture.items.get('chapter:2');
    chapter.handle.dispatch('keydown', { key: 'Home' });
    expect(fixture.target()[0].id).toBe(2);
    chapter.handle.dispatch('keydown', { key: 'End' });
    expect(fixture.target().at(-1).id).toBe(2);
    expect(fixture.live.textContent).toBe('Chapter “Chapter 2” moved to position 5 of 5.');
  });

  it('serializes rapid drag and keyboard moves, advances expected, and keeps acknowledged state on close', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const requests = [];
    const fetchAuthority = vi.fn(async (state) => bookHierarchyAuthority(fixture, state.acknowledgedHierarchy));
    const previousClose = vi.fn();
    fixture.dialog.__creatorCrateAppDialogState.onClose = previousClose;

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 1,
        installDetail: () => 'installed',
        fetchAuthority,
      });
      fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
      expect(requests).toHaveLength(1);
      const first = JSON.parse(requests[0].options.body.get('hierarchy'));
      expect(first.expected).toEqual(fixture.expected);

      fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
      expect(requests).toHaveLength(1);
      const newestDesired = fixture.target();

      requests[0].resolve({
        ok: true,
        json: async () => ({ status: 'success', hierarchy: first.target, refreshUrl: '/notes/books/7' }),
      });
      await flushAsync();
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(fetchAuthority).toHaveBeenCalledTimes(1);
      const second = JSON.parse(requests[1].options.body.get('hierarchy'));
      expect(second.expected).toEqual(first.target);
      expect(second.target).toEqual(newestDesired);

      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', hierarchy: second.target, refreshUrl: '/notes/books/7' }),
      });
      await flushAsync();
      await flushAsync();
      expect(JSON.parse(fixture.input.value)).toEqual({
        version: 1,
        expected: newestDesired,
        target: newestDesired,
      });
      expect(fetchAuthority).toHaveBeenCalledTimes(2);
      expect(fixture.status.textContent).toBe('Book hierarchy saved.');
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);

      fixture.dialog.__creatorCrateAppDialogState.onClose();
      expect(previousClose).toHaveBeenCalledOnce();
      expect(fixture.target()).toEqual(newestDesired);
    });
  });

  it('reconciles a stale response to server authority without replaying the rejected move', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const fresh = makeBookHierarchyReorderFixture();
    const authority = [
      { type: 'page', id: 22 },
      ...fixture.expected.slice(0, -1),
    ];
    fresh.root.insertBefore(fresh.items.get('page:22'), fresh.root.children[0]);
    fresh.input.value = JSON.stringify({ version: 1, expected: authority, target: authority });
    const requests = [];
    const fetchAuthority = vi.fn(async () => ({
      destination: '/notes/books/7',
      replacementEditor: fresh.editor,
      replacementInput: fresh.input,
      replacementDetail: makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }),
      hierarchy: authority,
    }));

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: false,
        status: 409,
        json: async () => ({
          status: 'error',
          code: 'HIERARCHY_STALE',
          message: 'The current hierarchy has been refreshed.',
          hierarchy: authority,
          refreshUrl: '/notes/books/7',
        }),
      };
    }, async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 1,
        installDetail: () => 'installed',
        fetchAuthority,
      });
      fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
      const rejected = fixture.target();
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fetchAuthority).toHaveBeenCalledOnce();
      expect(fixture.target()).toEqual(authority);
      expect(JSON.parse(fixture.input.value).expected).toEqual(authority);
      expect(fixture.target()).not.toEqual(rejected);
      expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fresh.editor);
      expect(fixture.editor.__creatorCrateBookHierarchyState.retired).toBe(true);
      expect(fixture.status.textContent).toContain('Current hierarchy synchronized.');
      expect(fixture.form.getAttribute('data-book-hierarchy-state')).toBe('error');
    });
  });

  it('keeps a same-membership rejection blocked through canonical failure and retries GET-only', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const fresh = makeBookHierarchyReorderFixture();
    const authority = [
      { type: 'page', id: 22 },
      ...fixture.expected.slice(0, -1),
    ];
    fresh.root.insertBefore(fresh.items.get('page:22'), fresh.root.children[0]);
    fresh.input.value = JSON.stringify({ version: 1, expected: authority, target: authority });
    const requests = [];
    const refreshDetail = vi.fn(() => 'started');
    const installDetail = vi.fn(() => 'installed');
    const fetchAuthority = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        destination: '/notes/books/7',
        replacementEditor: fresh.editor,
        replacementInput: fresh.input,
        replacementDetail: makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }),
        hierarchy: authority,
      });

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: false,
        status: 409,
        json: async () => ({
          status: 'error',
          code: 'HIERARCHY_STALE',
          message: 'Nothing was saved because the Book hierarchy changed.',
          hierarchy: authority,
          refreshUrl: '/notes/books/7',
        }),
      };
    }, async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 4,
        refreshDetail,
        installDetail,
        fetchAuthority,
      });
      fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
      const rejectedTarget = fixture.target();
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fetchAuthority).toHaveBeenCalledOnce();
      expect(refreshDetail).not.toHaveBeenCalled();
      expect(installDetail).not.toHaveBeenCalled();
      expect(fixture.target()).toEqual(rejectedTarget);
      expect(JSON.parse(fixture.input.value).expected).toEqual(fixture.expected);
      expect(fixture.status.textContent).toContain('Current hierarchy could not be synchronized.');
      expect(fixture.status.textContent).not.toContain('Could not confirm whether');
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');

      const blockedTarget = fixture.target();
      fixture.items.get('page:11').handle.dispatch('keydown', { key: 'Home' });
      expect(fixture.target()).toEqual(blockedTarget);
      const retry = fixture.status.querySelector('[data-book-hierarchy-reconciliation-retry]');
      retry.dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fetchAuthority).toHaveBeenCalledTimes(2);
      expect(installDetail).toHaveBeenCalledOnce();
      expect(refreshDetail).not.toHaveBeenCalled();
      expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fresh.editor);
      expect(fixture.editor.__creatorCrateBookHierarchyState.retired).toBe(true);
      expect(JSON.parse(fixture.input.value).expected).toEqual(authority);
      expect(fixture.status.querySelector('[data-book-hierarchy-reconciliation-retry]')).toBe(null);
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
    });
  });

  it('carries one queued hierarchy through same-membership 409 using fresh expected authority', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const fresh = makeBookHierarchyReorderFixture();
    const authority = [
      { type: 'page', id: 22 },
      ...fixture.expected.slice(0, -1),
    ];
    fresh.root.insertBefore(fresh.items.get('page:22'), fresh.root.children[0]);
    fresh.input.value = JSON.stringify({ version: 1, expected: authority, target: authority });
    const requests = [];
    let authorityFetches = 0;

    await withBrowserGlobals((action, options) => new Promise((resolve) => {
      requests.push({ action, options, resolve });
    }), async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        refreshDetail: () => 'started',
        beginDetailRefresh: () => 1,
        installDetail: () => 'installed',
        fetchAuthority: async (state) => {
          if (authorityFetches++ > 0) return bookHierarchyAuthority(fresh, state.acknowledgedHierarchy);
          return {
            destination: '/notes/books/7',
            replacementEditor: fresh.editor,
            replacementInput: fresh.input,
            replacementDetail: makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }),
            hierarchy: authority,
          };
        },
      });
      fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
      const rejectedActive = fixture.target();
      fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
      const queuedHierarchy = fixture.target();

      requests[0].resolve({
        ok: false,
        status: 409,
        json: async () => ({
          status: 'error',
          code: 'HIERARCHY_STALE',
          message: 'The current hierarchy has been refreshed.',
          hierarchy: authority,
          refreshUrl: '/notes/books/7',
        }),
      });
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(2);
      const carried = JSON.parse(requests[1].options.body.get('hierarchy'));
      expect(carried.expected).toEqual(authority);
      expect(carried.target).toEqual(queuedHierarchy);
      expect(carried.target).not.toEqual(rejectedActive);
      expect(fixture.editor.__creatorCrateBookHierarchyState.retired).toBe(true);
      expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fresh.editor);

      requests[1].resolve({
        ok: true,
        json: async () => ({ status: 'success', hierarchy: queuedHierarchy, refreshUrl: '/notes/books/7' }),
      });
      await flushAsync();
      await flushAsync();

      fresh.items.get('page:12').handle.dispatch('keydown', { key: 'ArrowDown' });
      await flushAsync();
      expect(requests).toHaveLength(3);
      expect(JSON.parse(requests[2].options.body.get('hierarchy')).expected).toEqual(queuedHierarchy);
      requests[2].resolve({
        ok: true,
        json: async () => ({
          status: 'success',
          hierarchy: JSON.parse(requests[2].options.body.get('hierarchy')).target,
          refreshUrl: '/notes/books/7',
        }),
      });
      await flushAsync();
    });
  });

  it('starts the canonical snapshot fetch from a production-resolved single-digit Book action', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    fixture.form.action = 'http://creatorcrate.local/notes/books/7/hierarchy/reorder';
    const fresh = makeBookHierarchyReorderFixture();
    const authority = removeBookHierarchyItem(fresh, 'page:22');
    const detail = makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } });
    fixture.document.appendChild(detail);
    fixture.form.replaceChild = (next, previous) => {
      const index = fixture.form.children.indexOf(previous);
      fixture.form.children[index] = next;
      previous.parentElement = null;
      previous.parentNode = null;
      next.parentElement = fixture.form;
      next.parentNode = fixture.form;
      next.ownerDocument = fixture.document;
    };
    const oldHandle = fixture.items.get('page:11').handle;
    const refreshDetail = vi.fn(() => 'started');
    const installDetail = vi.fn(() => 'installed');
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          querySelector(selector) {
            return ({
              '[data-book-hierarchy-form]': fresh.form,
              '[data-book-hierarchy-editor]': fresh.editor,
              '[data-book-hierarchy-input]': fresh.input,
              '[data-book-detail-live-region]': detail,
            })[selector] || null;
          },
        };
      }
    };
    const requests = [];

    try {
      await withBrowserGlobals(async (action, options) => {
        requests.push({ action, options });
        if (requests.length === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              status: 'error',
              code: 'HIERARCHY_STALE',
              message: 'The hierarchy membership changed.',
              hierarchy: authority,
              refreshUrl: '/notes/books/7',
            }),
          };
        }
        if (options.method === 'GET') {
          if (requests.length > 2) {
            const current = fresh.target();
            fresh.input.value = JSON.stringify({ version: 1, expected: current, target: current });
          }
          return { ok: true, text: async () => '<html></html>' };
        }
        const submission = JSON.parse(options.body.get('hierarchy'));
        return {
          ok: true,
          json: async () => ({ status: 'success', hierarchy: submission.target, refreshUrl: '/notes/books/7' }),
        };
      }, async () => {
        enhanceBookHierarchyReorder(fixture.document, {
          beginDetailRefresh: () => 5,
          refreshDetail,
          installDetail,
        });
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        await flushAsync();
        await flushAsync();

        expect(requests).toHaveLength(2);
        expect(requests[1].options.method).toBe('GET');
        expect(new URL(requests[1].action).pathname).toBe('/notes/books/7/order');
        expect(refreshDetail).not.toHaveBeenCalled();
        expect(installDetail).toHaveBeenCalledWith(
          fixture.document,
          'http://creatorcrate.local/notes/books/7',
          5,
          detail,
        );
        expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fresh.editor);
        expect(JSON.parse(fixture.input.value).expected).toEqual(authority);
        expect(fresh.editor.listeners.filter(({ type }) => type === 'keydown')).toHaveLength(1);
        expect(fixture.form.getAttribute('data-book-hierarchy-state')).toBe('error');
        expect(fixture.dialog.getAttribute('data-dialog-state')).toBe('error');

        oldHandle.dispatch('keydown', { key: 'Home' });
        await flushAsync();
        expect(requests).toHaveLength(2);

        fresh.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        await flushAsync();
        await flushAsync();
        expect(requests).toHaveLength(4);
        expect(JSON.parse(requests[2].options.body.get('hierarchy')).expected).toEqual(authority);

      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('retires a membership-stale controller immediately and explicitly accounts for queued intent', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const fresh = makeBookHierarchyReorderFixture();
    const authority = removeBookHierarchyItem(fresh, 'page:22');
    const detail = makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } });
    fixture.document.appendChild(detail);
    fixture.form.replaceChild = (next, previous) => {
      const index = fixture.form.children.indexOf(previous);
      fixture.form.children[index] = next;
      previous.parentElement = null;
      previous.parentNode = null;
      next.parentElement = fixture.form;
      next.parentNode = fixture.form;
      next.ownerDocument = fixture.document;
    };
    const refreshDetail = vi.fn(() => 'started');
    const installDetail = vi.fn(() => 'installed');
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          querySelector(selector) {
            return ({
              '[data-book-hierarchy-form]': fresh.form,
              '[data-book-detail-live-region]': detail,
            })[selector] || null;
          },
        };
      }
    };
    const requests = [];

    try {
      await withBrowserGlobals((action, options) => {
        if (requests.length === 0) {
          return new Promise((resolve) => requests.push({ action, options, resolve }));
        }
        requests.push({ action, options });
        if (requests.length === 2) return Promise.resolve({ ok: true, text: async () => '<html></html>' });
        const submission = JSON.parse(options.body.get('hierarchy'));
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'success', hierarchy: submission.target, refreshUrl: '/notes/books/7' }),
        });
      }, async () => {
        enhanceBookHierarchyReorder(fixture.document, {
          beginDetailRefresh: () => 17,
          refreshDetail,
          installDetail,
          fetchAuthority: async (state) => {
            requests.push({ action: '/notes/books/7/order', options: { method: 'GET' } });
            if (state.editor === fresh.editor) {
              return bookHierarchyAuthority(fresh, state.acknowledgedHierarchy);
            }
            return {
              destination: '/notes/books/7', replacementEditor: fresh.editor,
              replacementInput: fresh.input, replacementDetail: detail, hierarchy: authority,
            };
          },
        });
        fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
        expect(requests).toHaveLength(1);
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        const queuedHierarchy = fixture.target();

        requests[0].resolve({
          ok: false,
          status: 409,
          json: async () => ({
            status: 'error',
            code: 'HIERARCHY_STALE',
            message: 'The hierarchy membership changed.',
            hierarchy: authority,
            refreshUrl: '/notes/books/7',
          }),
        });
        await flushAsync();
        await flushAsync();

        expect(requests).toHaveLength(2);
        expect(refreshDetail).not.toHaveBeenCalled();
        expect(installDetail).toHaveBeenCalledWith(fixture.document, '/notes/books/7', 17, detail);
        expect(fixture.status.textContent).toContain('newer queued hierarchy change was not applied');
        expect(fixture.target()).not.toEqual(queuedHierarchy);

        const retiredHierarchy = fixture.target();
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'Home' });
        fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
        await flushAsync();
        expect(fixture.target()).toEqual(retiredHierarchy);
        expect(requests).toHaveLength(2);

        expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fresh.editor);
        expect(fresh.editor.listeners.filter(({ type }) => type === 'keydown')).toHaveLength(1);

        fresh.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        await flushAsync();
        await flushAsync();
        expect(requests).toHaveLength(4);
        expect(JSON.parse(requests[2].options.body.get('hierarchy')).expected).toEqual(authority);
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('keeps changed-membership failure retired and recovers through an explicit single-snapshot Retry', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    fixture.form.action = 'http://creatorcrate.local/notes/books/7/hierarchy/reorder';
    const fresh = makeBookHierarchyReorderFixture();
    const authority = removeBookHierarchyItem(fresh, 'page:22');
    const oldDetail = makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } });
    const freshDetail = makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } });
    const close = makeCategoryNode({ tagName: 'button', attrs: { 'data-dialog-close': '' } });
    fixture.document.appendChild(oldDetail);
    fixture.dialog.appendChild(close);
    fixture.form.replaceChild = (next, previous) => {
      const index = fixture.form.children.indexOf(previous);
      fixture.form.children[index] = next;
      previous.parentElement = null;
      previous.parentNode = null;
      next.parentElement = fixture.form;
      next.parentNode = fixture.form;
      next.ownerDocument = fixture.document;
    };
    const installDetail = vi.fn((_scope, _destination, _generation, replacement) => {
      expect(replacement).toBe(freshDetail);
      return 'installed';
    });
    const beginDetailRefresh = vi.fn().mockReturnValueOnce(9).mockReturnValueOnce(12);
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelector: (selector) => ({
          '[data-book-hierarchy-form]': fresh.form,
          '[data-book-detail-live-region]': freshDetail,
        })[selector] || null };
      }
    };
    const requests = [];

    try {
      await withBrowserGlobals(async (action, options) => {
        requests.push({ action, options });
        if (requests.length === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              status: 'error',
              code: 'HIERARCHY_STALE',
              message: 'The hierarchy membership changed.',
              hierarchy: authority,
              refreshUrl: '/notes/books/7',
            }),
          };
        }
        if (options.method === 'GET') {
          const getCount = requests.filter(({ options: requestOptions }) => requestOptions.method === 'GET').length;
          if (getCount > 2) {
            const current = fresh.target();
            fresh.input.value = JSON.stringify({ version: 1, expected: current, target: current });
          }
          return getCount === 1
            ? { ok: false, status: 503, text: async () => '' }
            : { ok: true, text: async () => '<html></html>' };
        }
        const submission = JSON.parse(options.body.get('hierarchy'));
        return {
          ok: true,
          json: async () => ({ status: 'success', hierarchy: submission.target, refreshUrl: '/notes/books/7' }),
        };
      }, async () => {
        enhanceBookHierarchyReorder(fixture.document, { beginDetailRefresh, installDetail });
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        await flushAsync();
        await flushAsync();

        expect(requests).toHaveLength(2);
        expect(new URL(requests[1].action).pathname).toBe('/notes/books/7/order');
        expect(installDetail).not.toHaveBeenCalled();
        expect(fixture.document.querySelector('[data-book-detail-live-region]')).toBe(oldDetail);
        expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fixture.editor);
        expect(JSON.parse(fixture.input.value).expected).toEqual(fixture.expected);
        expect(fixture.status.textContent).toContain('Retry reconciliation');
        expect(fixture.status.textContent).toContain('hierarchy membership changed');
        expect(fixture.form.getAttribute('aria-busy')).toBe('true');
        const retry = fixture.status.querySelector('[data-book-hierarchy-reconciliation-retry]');
        expect(retry).toBeTruthy();
        expect(fixture.document.activeElement).toBe(retry);

        const retiredHierarchy = fixture.target();
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'Home' });
        fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
        await flushAsync();
        expect(fixture.target()).toEqual(retiredHierarchy);
        expect(requests).toHaveLength(2);

        retry.dispatch('click');
        await flushAsync();
        await flushAsync();

        expect(requests).toHaveLength(3);
        expect(new URL(requests[2].action).pathname).toBe('/notes/books/7/order');
        expect(beginDetailRefresh).toHaveBeenNthCalledWith(2, fixture.document);
        expect(installDetail).toHaveBeenCalledWith(
          fixture.document,
          'http://creatorcrate.local/notes/books/7',
          12,
          freshDetail,
        );
        expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fresh.editor);
        expect(JSON.parse(fixture.input.value).expected).toEqual(authority);
        expect(fresh.editor.listeners.filter(({ type }) => type === 'keydown')).toHaveLength(1);
        expect(fixture.form.getAttribute('aria-busy')).toBe(null);
        expect(fixture.form.getAttribute('data-book-hierarchy-state')).toBe('error');
        expect(fixture.dialog.getAttribute('data-dialog-state')).toBe('error');
        expect(fixture.document.activeElement).toBe(close);

        fresh.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        await flushAsync();
        expect(requests).toHaveLength(5);
        expect(JSON.parse(requests[3].options.body.get('hierarchy')).expected).toEqual(authority);
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('keeps one usable Retry after repeated changed-membership reconciliation failures', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const authority = fixture.expected.slice(0, -1);
    const requests = [];
    const fetchAuthority = vi.fn().mockResolvedValue(null);

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return {
        ok: false,
        status: 409,
        json: async () => ({
          status: 'error',
          code: 'HIERARCHY_STALE',
          message: 'The hierarchy membership changed.',
          hierarchy: authority,
          refreshUrl: '/notes/books/7',
        }),
      };
    }, async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 12,
        fetchAuthority,
      });
      fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
      await flushAsync();
      await flushAsync();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const retries = fixture.status.querySelectorAll('[data-book-hierarchy-reconciliation-retry]');
        expect(retries).toHaveLength(1);
        expect(fixture.document.activeElement).toBe(retries[0]);
        retries[0].dispatch('click');
        await flushAsync();
        await flushAsync();
      }

      expect(fetchAuthority).toHaveBeenCalledTimes(3);
      expect(requests).toHaveLength(1);
      expect(fixture.status.querySelectorAll('[data-book-hierarchy-reconciliation-retry]')).toHaveLength(1);
      expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fixture.editor);
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');

      const blocked = fixture.target();
      fixture.items.get('page:12').handle.dispatch('keydown', { key: 'End' });
      fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
      expect(fixture.target()).toEqual(blocked);
    });
  });

  it('keeps an uncertain hierarchy non-authoritative and blocked when canonical reconciliation fails', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const requests = [];

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      return { ok: false, status: 503, json: async () => null };
    }, async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 3,
        fetchAuthority: async () => {
          requests.push({ action: '/notes/books/7/order', options: { method: 'GET' } });
          return null;
        },
      });
      fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
      await flushAsync();
      await flushAsync();

      expect(fixture.target()).not.toEqual(fixture.expected);
      expect(JSON.parse(fixture.input.value).expected).toEqual(fixture.expected);
      expect(fixture.status.textContent).toContain('Retry reconciliation');
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');
      expect(requests).toHaveLength(2);

      const blocked = fixture.target();
      fixture.items.get('page:12').handle.dispatch('keydown', { key: 'End' });
      expect(fixture.target()).toEqual(blocked);
      expect(requests).toHaveLength(2);
    });
  });

  it('reconciles an uncertain hierarchy from one canonical snapshot and dispatches one valid queued move', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const fresh = makeBookHierarchyReorderFixture();
    fresh.containers.get('chapter:3').appendChild(fresh.items.get('page:21'));
    const canonical = [
      { type: 'chapter', id: 1, pages: [11, 12] },
      { type: 'chapter', id: 2, pages: [13] },
      { type: 'chapter', id: 3, pages: [21] },
      { type: 'page', id: 22 },
    ];
    fresh.input.value = JSON.stringify({ version: 1, expected: canonical, target: canonical });
    const detail = makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } });
    fixture.document.appendChild(makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }));
    fixture.form.replaceChild = (next, previous) => {
      const index = fixture.form.children.indexOf(previous);
      fixture.form.children[index] = next;
      previous.parentElement = null;
      previous.parentNode = null;
      next.parentElement = fixture.form;
      next.parentNode = fixture.form;
      next.ownerDocument = fixture.document;
    };
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelector: (selector) => ({
          '[data-book-hierarchy-form]': fresh.form,
          '[data-book-detail-live-region]': detail,
        })[selector] || null };
      }
    };
    const requests = [];
    const installDetail = vi.fn(() => 'installed');

    try {
      await withBrowserGlobals((action, options) => {
        if (requests.length === 0) {
          return new Promise((resolve, reject) => requests.push({ action, options, resolve, reject }));
        }
        requests.push({ action, options });
        if (options.method === 'GET') return Promise.resolve({ ok: true, text: async () => '<html></html>' });
        const submission = JSON.parse(options.body.get('hierarchy'));
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'success', hierarchy: submission.target, refreshUrl: '/notes/books/7' }),
        });
      }, async () => {
        enhanceBookHierarchyReorder(fixture.document, {
          beginDetailRefresh: () => 19,
          installDetail,
          refreshDetail: vi.fn(() => 'started'),
          fetchAuthority: async (state) => {
            requests.push({ action: '/notes/books/7/order', options: { method: 'GET' } });
            if (state.editor === fresh.editor) {
              return bookHierarchyAuthority(fresh, state.acknowledgedHierarchy);
            }
            return {
              destination: '/notes/books/7', replacementEditor: fresh.editor,
              replacementInput: fresh.input, replacementDetail: detail, hierarchy: canonical,
            };
          },
        });
        fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        const queued = fixture.target();
        requests[0].reject(new Error('response lost'));
        await flushAsync();
        await flushAsync();

        expect(requests).toHaveLength(4);
        expect(requests.filter(({ options }) => options.method !== 'GET')).toHaveLength(2);
        expect(installDetail).toHaveBeenCalledWith(fixture.document, '/notes/books/7', 19, detail);
        const replay = JSON.parse(requests[2].options.body.get('hierarchy'));
        expect(replay.expected).toEqual(canonical);
        expect(replay.target).toEqual(queued);
        expect(fixture.status.textContent).toBe('Book hierarchy saved.');
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it.each([
    {
      name: 'accounts for a queued newer hierarchy before uncertain reconciliation publishes empty authority while closed',
      queueNewer: true,
      status: 'Current hierarchy restored. A pending hierarchy change was not applied because the Book contents changed; make the move again if it is still wanted.',
      statusKind: 'error',
    },
    {
      name: 'reports ordinary success when uncertain reconciliation publishes empty authority without a queued hierarchy',
      queueNewer: false,
      status: 'Current hierarchy restored.',
      statusKind: 'saved',
    },
  ])('$name', async ({ queueNewer, status, statusKind }) => {
    const fixture = makeBookHierarchyReorderFixture();
    const emptyEditor = makeCategoryNode({ attrs: { 'data-book-hierarchy-editor': '' } });
    const emptyInput = makeCategoryNode({ tagName: 'input', attrs: { 'data-book-hierarchy-input': '', name: 'hierarchy' } });
    const emptyDetail = makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } });
    const focusGuard = makeCategoryNode({ tagName: 'button' });
    emptyInput.value = JSON.stringify({ version: 1, expected: [], target: [] });
    fixture.document.appendChild(makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }));
    fixture.document.appendChild(focusGuard);
    fixture.dialog.__creatorCrateAppDialogState.open = false;
    fixture.form.replaceChild = (next, previous) => {
      const index = fixture.form.children.indexOf(previous);
      fixture.form.children[index] = next;
      previous.parentElement = null;
      previous.parentNode = null;
      next.parentElement = fixture.form;
      next.parentNode = fixture.form;
      next.ownerDocument = fixture.document;
    };
    const requests = [];

    await withBrowserGlobals((action, options) => {
      requests.push({ action, options });
      return new Promise((_resolve, reject) => { requests[0].reject = reject; });
    }, async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 23,
        installDetail: () => 'installed',
        fetchAuthority: async () => ({
          kind: 'empty',
          destination: '/notes/books/7',
          replacementEditor: emptyEditor,
          replacementInput: emptyInput,
          replacementDetail: emptyDetail,
          hierarchy: [],
        }),
      });
      fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
      const state = fixture.editor.__creatorCrateBookHierarchyState;
      if (queueNewer) {
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        const queued = JSON.parse(JSON.stringify(state.queuedHierarchy));
        expect(queued).not.toEqual(state.activeHierarchy);
      } else {
        expect(state.queuedHierarchy).toBe(null);
      }
      focusGuard.focus();

      requests[0].reject(new Error('response lost'));
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(state.retired).toBe(true);
      expect(state.expected).toEqual([]);
      expect(state.acknowledgedHierarchy).toEqual([]);
      expect(state.desiredHierarchy).toEqual([]);
      expect(state.activeHierarchy).toBe(null);
      expect(state.queuedHierarchy).toBe(null);
      expect(state.pendingUncertainHierarchy).toBe(null);
      expect(fixture.input.value).toBe(JSON.stringify({ version: 1, expected: [], target: [] }));
      expect(fixture.status.textContent).toBe(status);
      expect(fixture.form.getAttribute('data-book-hierarchy-state')).toBe(statusKind);
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
      expect(fixture.document.activeElement).toBe(focusGuard);
      expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(emptyEditor);
    });
  });

  it('reports rather than merges a queued hierarchy when canonical membership changed', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const fresh = makeBookHierarchyReorderFixture();
    const canonical = removeBookHierarchyItem(fresh, 'page:22');
    const detail = makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } });
    fixture.document.appendChild(makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }));
    fixture.form.replaceChild = (next, previous) => {
      const index = fixture.form.children.indexOf(previous);
      fixture.form.children[index] = next;
      previous.parentElement = null;
      previous.parentNode = null;
      next.parentElement = fixture.form;
      next.parentNode = fixture.form;
      next.ownerDocument = fixture.document;
    };
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelector: (selector) => ({
          '[data-book-hierarchy-form]': fresh.form,
          '[data-book-detail-live-region]': detail,
        })[selector] || null };
      }
    };
    const requests = [];

    try {
      await withBrowserGlobals((action, options) => {
        requests.push({ action, options });
        if (requests.length === 1) return new Promise((_resolve, reject) => { requests[0].reject = reject; });
        return Promise.resolve({ ok: true, text: async () => '<html></html>' });
      }, async () => {
        enhanceBookHierarchyReorder(fixture.document, {
          beginDetailRefresh: () => 21,
          installDetail: () => 'installed',
          fetchAuthority: async () => {
            requests.push({ action: '/notes/books/7/order', options: { method: 'GET' } });
            return {
              destination: '/notes/books/7', replacementEditor: fresh.editor,
              replacementInput: fresh.input, replacementDetail: detail, hierarchy: canonical,
            };
          },
        });
        fixture.drag(fixture.items.get('page:21'), fixture.containers.get('chapter:3'));
        fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
        requests[0].reject(new Error('response lost'));
        await flushAsync();
        await flushAsync();

        expect(requests).toHaveLength(2);
        expect(JSON.parse(fixture.input.value).expected).toEqual(canonical);
        expect(fixture.status.textContent).toContain('queued move was not applied');
        expect(fixture.form.getAttribute('aria-busy')).toBe(null);
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('blocks a stale successful controller until changed membership is canonically synchronized', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const fresh = makeBookHierarchyReorderFixture();
    const canonical = removeBookHierarchyItem(fresh, 'page:22');
    let resolveAuthority;
    const fetchAuthority = vi.fn((state) => {
      if (state.editor === fixture.editor) {
        return new Promise((resolve) => { resolveAuthority = resolve; });
      }
      return Promise.resolve(bookHierarchyAuthority(fresh, state.acknowledgedHierarchy));
    });
    const requests = [];

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      const submission = JSON.parse(options.body.get('hierarchy'));
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          hierarchy: submission.target,
          refreshUrl: '/notes/books/7',
        }),
      };
    }, async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 12,
        installDetail: () => 'installed',
        fetchAuthority,
      });
      fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
      await flushAsync();

      expect(fetchAuthority).toHaveBeenCalledOnce();
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');
      fixture.items.get('page:12').handle.dispatch('keydown', { key: 'End' });
      expect(requests).toHaveLength(1);

      resolveAuthority({
        kind: 'active',
        destination: '/notes/books/7',
        replacementEditor: fresh.editor,
        replacementInput: fresh.input,
        replacementDetail: makeCategoryNode({ attrs: { 'data-book-detail-live-region': '' } }),
        hierarchy: canonical,
      });
      await flushAsync();
      await flushAsync();

      expect(fixture.editor.__creatorCrateBookHierarchyState.retired).toBe(true);
      expect(fixture.form.querySelector('[data-book-hierarchy-editor]')).toBe(fresh.editor);
      expect(JSON.parse(fixture.input.value).expected).toEqual(canonical);
      fresh.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
      await flushAsync();
      await flushAsync();
      expect(requests).toHaveLength(2);
      expect(JSON.parse(requests[1].options.body.get('hierarchy')).expected).toEqual(canonical);
    });
  });

  it('reports post-success synchronization failure and retries only the canonical snapshot', async () => {
    const fixture = makeBookHierarchyReorderFixture();
    const requests = [];
    const fetchAuthority = vi.fn()
      .mockResolvedValueOnce(null)
      .mockImplementation(async (state) => bookHierarchyAuthority(fixture, state.acknowledgedHierarchy));

    await withBrowserGlobals(async (action, options) => {
      requests.push({ action, options });
      const submission = JSON.parse(options.body.get('hierarchy'));
      return {
        ok: true,
        json: async () => ({ status: 'success', hierarchy: submission.target, refreshUrl: '/notes/books/7' }),
      };
    }, async () => {
      enhanceBookHierarchyReorder(fixture.document, {
        beginDetailRefresh: () => 12,
        installDetail: () => 'installed',
        fetchAuthority,
      });
      fixture.items.get('page:11').handle.dispatch('keydown', { key: 'End' });
      await flushAsync();
      await flushAsync();

      expect(requests).toHaveLength(1);
      expect(fixture.status.textContent).toContain('Book hierarchy saved, but current Book contents could not be synchronized.');
      expect(fixture.status.textContent).toContain('Retry reconciliation');
      expect(fixture.form.getAttribute('aria-busy')).toBe('true');
      const retry = fixture.status.querySelector('[data-book-hierarchy-reconciliation-retry]');
      retry.dispatch('click');
      await flushAsync();
      await flushAsync();

      expect(fetchAuthority).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(1);
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
      expect(fixture.status.textContent).toBe('Book hierarchy saved.');
    });
  });
});

function makeControl({ value = '', disabled = false } = {}) {
  const listeners = [];
  return {
    value,
    disabled,
    textContent: '',
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    dispatch(type) {
      for (const l of listeners.filter((entry) => entry.type === type)) l.handler();
    },
  };
}

/**
 * Mock an [data-asset-selection-form] element. `enabledCheckboxes` are the
 * rows the CSS selector `input[type="checkbox"][name="selectedAssetIds"]:not(:disabled)`
 * would match — i.e. present-asset rows only. Missing-asset rows render a
 * disabled checkbox that the real DOM selector excludes entirely, so the
 * mock's querySelectorAll for that selector never returns them either.
 */
function makeAssetSelectionForm({ enabledCheckboxes = [], selectedCount, releaseSelect, selectAll, clearSelection, bulkSubmit, renameButtons = [] } = {}) {
  const singles = {
    '[data-release-select]': releaseSelect ?? makeControl(),
    '[data-select-all]': selectAll ?? makeControl(),
    '[data-clear-selection]': clearSelection ?? makeControl(),
    '[data-bulk-submit]': bulkSubmit ?? makeControl(),
  };
  if (selectedCount) singles['[data-selected-count]'] = selectedCount;
  return {
    querySelectorAll(selector) {
      if (selector.includes('selectedAssetIds')) return enabledCheckboxes;
      if (selector === '[data-processing-rename-trigger]') return renameButtons;
      return [];
    },
    querySelector(selector) {
      return singles[selector] || null;
    },
    _singles: singles,
  };
}

function makeAssetSelectionScope(form, cards = [], selectedCount = null) {
  return {
    querySelectorAll(selector) {
      if (selector === '[data-asset-selection-form]') return form ? [form] : [];
      if (selector.includes('selectedAssetIds')) return form?.querySelectorAll(selector) || [];
      if (selector === '[data-asset-selectable-card]') return cards;
      return [];
    },
    querySelector(selector) {
      return selector === '[data-selected-count]' ? selectedCount : null;
    },
  };
}

function makeSelectableAssetCard(checkbox) {
  const listeners = [];
  const attributes = {};
  const classes = new Set();

  return {
    dataset: {},
    listeners,
    attributes,
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    querySelector(selector) {
      if (selector.includes('selectedAssetIds') && !checkbox.disabled) return checkbox;
      return null;
    },
    contains(element) {
      return element === this || element === checkbox;
    },
  };
}

function makeDetailsFixture({
  action = '/settings/asset-categories/1',
  displayNameValue = 'Final',
  directorySlugValue = 'final',
} = {}) {
  const status = { textContent: '' };
  const attributes = new Map();
  const listeners = [];
  const makeControl = (name, value) => {
    const controlListeners = [];
    return {
      name,
      value,
      listeners: controlListeners,
      addEventListener(type, handler) { controlListeners.push({ type, handler }); },
      dispatch(type) {
        const event = { type, target: this };
        controlListeners.filter((listener) => listener.type === type).forEach((listener) => listener.handler(event));
        return event;
      },
    };
  };
  const displayName = makeControl('displayName', displayNameValue);
  const directorySlug = makeControl('directorySlug', directorySlugValue);
  const form = {
    action,
    method: 'post',
    csrfToken: 'csrf-details',
    dataset: {},
    controls: [displayName, directorySlug],
    submitCount: 0,
    submit() { this.submitCount += 1; },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    dispatch(type, props = {}) {
      const event = {
        type,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      listeners.filter((l) => l.type === type).forEach((l) => l.handler(event));
      return event;
    },
    querySelector(selector) {
      return selector === '[data-category-details-status]' ? status : null;
    },
    querySelectorAll(selector) {
      return selector === 'input[name="displayName"], input[name="directorySlug"]' ? this.controls : [];
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
  return { form, status, attributes, displayName, directorySlug };
}

function identifyDetailsFixture(fixture, id) {
  fixture.form.dataset.categoryDetailsId = String(id);
  const getAttribute = fixture.form.getAttribute;
  fixture.form.getAttribute = (name) => (
    name === 'data-category-details-id' ? fixture.form.dataset.categoryDetailsId : getAttribute(name)
  );
  fixture.form.matches = (selector) => selector === '[data-category-details-form]';
  return fixture;
}

describe('category details in-place save enhancement', () => {
  it('is scoped to [data-category-details-form] and no-ops when absent', () => {
    const scope = {
      querySelectorAll: (selector) => {
        expect(selector).toBe('[data-category-details-form]');
        return [];
      },
    };
    expect(enhanceCategoryDetails(scope)).toBe(0);
  });

  it('saves each detail field change in place without navigating, and binds once', async () => {
    const fixture = makeDetailsFixture({ action: '/settings/asset-categories/9' });
    const calls = [];
    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, status: 200 };
    }, async () => {
      const scope = { querySelectorAll: () => [fixture.form] };
      expect(enhanceCategoryDetails(scope)).toBe(1);
      expect(enhanceCategoryDetails(scope)).toBe(1);
      expect(fixture.displayName.listeners).toHaveLength(1);
      expect(fixture.directorySlug.listeners).toHaveLength(1);

      fixture.displayName.value = 'Raw Footage';
      fixture.displayName.dispatch('change');
      await flushAsync();

      expect(calls).toHaveLength(1);
      expect(calls[0].action).toBe('/settings/asset-categories/9');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].options.body).toBeInstanceOf(URLSearchParams);
      expect(calls[0].options.body.getAll('_csrf')).toEqual(['csrf-details']);
      expect(calls[0].options.body.getAll('displayName')).toEqual(['Raw Footage']);
      expect(calls[0].options.body.getAll('directorySlug')).toEqual(['final']);
      expect(fixture.form.submitCount).toBe(0);
      expect(fixture.status.textContent).toBe('Details saved.');
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
    });
  });

  it('serializes rapid changes and saves the latest complete field state', async () => {
    const fixture = identifyDetailsFixture(makeDetailsFixture(), 1);
    const stale = identifyDetailsFixture(makeDetailsFixture({ displayNameValue: '' }), 1);
    const parent = {
      replacement: null,
      replaceChild(next) { this.replacement = next; },
    };
    fixture.form.parentNode = parent;
    const requests = [];
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelectorAll: () => [stale.form] };
      }
    };

    try {
      await withBrowserGlobals((action, options) => new Promise((resolve) => {
        requests.push({ action, options, resolve });
      }), async () => {
        enhanceCategoryDetails({ querySelectorAll: () => [fixture.form] });
        fixture.displayName.value = 'Raw Footage';
        fixture.displayName.dispatch('change');
        await flushAsync();

        fixture.directorySlug.value = 'raw-footage';
        fixture.directorySlug.dispatch('change');
        expect(requests).toHaveLength(1);

        requests[0].resolve({
          ok: false,
          redirected: false,
          status: 422,
          text: async () => '<html>superseded validation</html>',
        });
        await flushAsync();
        expect(parent.replacement).toBeNull();
        expect(requests).toHaveLength(2);
        expect(requests[1].options.body.getAll('displayName')).toEqual(['Raw Footage']);
        expect(requests[1].options.body.getAll('directorySlug')).toEqual(['raw-footage']);

        requests[1].resolve({ ok: true, redirected: true, status: 200 });
        await flushAsync();
        expect(fixture.status.textContent).toBe('Details saved.');
        expect(fixture.form.getAttribute('aria-busy')).toBe(null);
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('keeps a validation response in place when no authoritative replacement can be parsed', async () => {
    const fixture = makeDetailsFixture();
    await withBrowserGlobals(async () => ({ ok: false, redirected: false, status: 422 }), async () => {
      enhanceCategoryDetails({ querySelectorAll: () => [fixture.form] });
      fixture.displayName.dispatch('change');
      await flushAsync();
      expect(fixture.form.submitCount).toBe(0);
      expect(fixture.status.textContent).toBe('Could not save category details. Your current changes were kept.');
    });
  });

  it('replaces only the matching category details form from a validation response', async () => {
    const categoryA = identifyDetailsFixture(makeDetailsFixture({ action: '/settings/asset-categories/1' }), 1);
    const current = identifyDetailsFixture(makeDetailsFixture({ action: '/settings/asset-categories/2' }), 2);
    const categoryB = identifyDetailsFixture(makeDetailsFixture({ action: '/settings/asset-categories/2' }), 2);
    const parent = {
      replacement: null,
      replaceChild(next, previous) {
        expect(previous).toBe(current.form);
        this.replacement = next;
      },
    };
    current.form.parentNode = parent;
    const addCategory = { displayName: 'Unsaved add name', directorySlug: 'unsaved-add-slug' };
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          querySelectorAll: (selector) => (
            selector === '[data-category-details-form]' ? [categoryA.form, categoryB.form] : []
          ),
        };
      }
    };

    try {
      await withBrowserGlobals(async () => ({
        ok: false,
        redirected: false,
        status: 422,
        text: async () => '<!doctype html><html></html>',
      }), async () => {
        enhanceCategoryDetails({ querySelectorAll: () => [current.form] });
        current.displayName.dispatch('change');
        await flushAsync();

        expect(current.form.submitCount).toBe(0);
        expect(parent.replacement).toBe(categoryB.form);
        expect(parent.replacement).not.toBe(categoryA.form);
        expect(categoryB.displayName.listeners).toHaveLength(1);
        expect(categoryB.directorySlug.listeners).toHaveLength(1);
        expect(categoryB.status.textContent).toBe('Could not save category details. Current changes have not been saved.');
        expect(categoryB.form.getAttribute('data-category-details-state')).toBe('error');
        expect(addCategory).toEqual({ displayName: 'Unsaved add name', directorySlug: 'unsaved-add-slug' });
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('preserves an unsent slug and its focus through display-name validation before a corrected retry', async () => {
    const current = identifyDetailsFixture(makeDetailsFixture({
      displayNameValue: 'Raw Footage',
      directorySlugValue: 'old-slug',
    }), 2);
    const invalid = identifyDetailsFixture(makeDetailsFixture({
      displayNameValue: '',
      directorySlugValue: 'old-slug',
    }), 2);
    const clean = identifyDetailsFixture(makeDetailsFixture({
      displayNameValue: 'Raw Footage',
      directorySlugValue: 'raw-footage',
    }), 2);
    const parent = {
      replacements: [],
      replaceChild(next) {
        this.replacements.push(next);
        next.parentNode = this;
      },
    };
    let responseFixture = invalid;
    const document = {
      activeElement: current.directorySlug,
      getElementById: (id) => (id === 'global-category-2-directory-slug' ? responseFixture.directorySlug : null),
    };
    for (const fixture of [current, invalid, clean]) {
      fixture.form.parentNode = parent;
      fixture.form.ownerDocument = document;
      fixture.form.contains = (element) => fixture.form.controls.includes(element);
      fixture.directorySlug.id = 'global-category-2-directory-slug';
    }
    current.directorySlug.selectionStart = 2;
    current.directorySlug.selectionEnd = 5;
    invalid.directorySlug.focus = () => { document.activeElement = invalid.directorySlug; };
    invalid.directorySlug.setSelectionRange = (start, end) => {
      invalid.directorySlug.selectionStart = start;
      invalid.directorySlug.selectionEnd = end;
    };
    const requests = [];
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelectorAll: (selector) => (
          selector === '[data-category-details-form]' ? [responseFixture.form] : []
        ) };
      }
    };

    try {
      await withBrowserGlobals((action, options) => new Promise((resolve) => {
        requests.push({ action, options, resolve });
      }), async () => {
        enhanceCategoryDetails({ querySelectorAll: () => [current.form] });
        current.displayName.value = '';
        current.displayName.dispatch('change');
        await flushAsync();
        current.directorySlug.value = 'raw-footage';

        requests[0].resolve({ ok: false, redirected: false, status: 422, text: async () => '<!doctype html><html></html>' });
        await flushAsync();

        expect(parent.replacements).toEqual([invalid.form]);
        expect(invalid.displayName.value).toBe('');
        expect(invalid.directorySlug.value).toBe('raw-footage');
        expect(invalid.status.textContent).toBe('Could not save category details. Current changes have not been saved.');
        expect(invalid.form.getAttribute('data-category-details-state')).toBe('error');
        expect(document.activeElement).toBe(invalid.directorySlug);
        expect(invalid.directorySlug.selectionStart).toBe(2);
        expect(invalid.directorySlug.selectionEnd).toBe(5);

        responseFixture = clean;
        invalid.displayName.value = 'Raw Footage';
        invalid.displayName.dispatch('change');
        await flushAsync();
        requests[1].resolve({ ok: true, redirected: true, status: 200, text: async () => '<!doctype html><html></html>' });
        await flushAsync();

        expect(parent.replacements).toEqual([invalid.form, clean.form]);
        expect(clean.status.textContent).toBe('Details saved.');
        expect(clean.displayName.listeners).toHaveLength(1);
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('preserves a newer unsent sibling value, its focus, and submits it on a later change', async () => {
    const current = identifyDetailsFixture(makeDetailsFixture({
      displayNameValue: 'Old',
      directorySlugValue: 'old-slug',
    }), 2);
    const clean = identifyDetailsFixture(makeDetailsFixture({
      displayNameValue: 'Raw Footage',
      directorySlugValue: 'old-slug',
    }), 2);
    const final = identifyDetailsFixture(makeDetailsFixture({
      displayNameValue: 'Raw Footage',
      directorySlugValue: 'raw-footage',
    }), 2);
    const parent = {
      replacements: [],
      replaceChild(next) {
        this.replacements.push(next);
        next.parentNode = this;
      },
    };
    const document = {
      activeElement: current.directorySlug,
      getElementById: (id) => ({
        'global-category-2-directory-slug': clean.directorySlug,
      })[id] || null,
    };
    for (const fixture of [current, clean, final]) {
      fixture.form.parentNode = parent;
      fixture.form.ownerDocument = document;
      fixture.form.contains = (element) => fixture.form.controls.includes(element);
      fixture.directorySlug.id = 'global-category-2-directory-slug';
    }
    current.directorySlug.selectionStart = 2;
    current.directorySlug.selectionEnd = 5;
    clean.directorySlug.focus = () => { document.activeElement = clean.directorySlug; };
    clean.directorySlug.setSelectionRange = (start, end) => {
      clean.directorySlug.selectionStart = start;
      clean.directorySlug.selectionEnd = end;
    };
    const requests = [];
    const originalDOMParser = globalThis.DOMParser;
    let responseForm = clean.form;
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          querySelectorAll: (selector) => (
            selector === '[data-category-details-form]' ? [responseForm] : []
          ),
        };
      }
    };

    try {
      await withBrowserGlobals((action, options) => new Promise((resolve) => {
        requests.push({ action, options, resolve });
      }), async () => {
        enhanceCategoryDetails({ querySelectorAll: () => [current.form] });
        current.displayName.value = 'Raw Footage';
        current.displayName.dispatch('change');
        await flushAsync();
        current.directorySlug.value = 'raw-footage';

        requests[0].resolve({
          ok: true,
          redirected: true,
          status: 200,
          text: async () => '<!doctype html><html></html>',
        });
        await flushAsync();

        expect(parent.replacements).toEqual([clean.form]);
        expect(clean.displayName.value).toBe('Raw Footage');
        expect(clean.directorySlug.value).toBe('raw-footage');
        expect(clean.status.textContent).toBe('Current changes have not been saved.');
        expect(document.activeElement).toBe(clean.directorySlug);
        expect(clean.directorySlug.selectionStart).toBe(2);
        expect(clean.directorySlug.selectionEnd).toBe(5);

        responseForm = final.form;
        clean.directorySlug.dispatch('change');
        await flushAsync();
        expect(requests).toHaveLength(2);
        expect(requests[1].options.body.getAll('displayName')).toEqual(['Raw Footage']);
        expect(requests[1].options.body.getAll('directorySlug')).toEqual(['raw-footage']);

        requests[1].resolve({
          ok: true,
          redirected: true,
          status: 200,
          text: async () => '<!doctype html><html></html>',
        });
        await flushAsync();
        expect(parent.replacements).toEqual([clean.form, final.form]);
        expect(final.status.textContent).toBe('Details saved.');
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('replaces a corrected form with the authoritative clean form and restores field focus', async () => {
    const current = identifyDetailsFixture(makeDetailsFixture({ action: '/settings/asset-categories/2' }), 2);
    const clean = identifyDetailsFixture(makeDetailsFixture({ action: '/settings/asset-categories/2' }), 2);
    const parent = {
      replacement: null,
      replaceChild(next) { this.replacement = next; },
    };
    const document = {
      activeElement: current.displayName,
      getElementById: (id) => (id === 'global-category-2-display-name' ? clean.displayName : null),
    };
    current.form.parentNode = parent;
    current.form.ownerDocument = document;
    clean.form.ownerDocument = document;
    current.form.contains = (element) => element === current.displayName;
    clean.form.contains = (element) => element === clean.displayName;
    current.displayName.id = 'global-category-2-display-name';
    current.displayName.selectionStart = 1;
    current.displayName.selectionEnd = 3;
    clean.displayName.focusCount = 0;
    clean.displayName.focus = () => { clean.displayName.focusCount += 1; };
    clean.displayName.setSelectionRange = (start, end) => {
      clean.displayName.selectionStart = start;
      clean.displayName.selectionEnd = end;
    };
    const originalDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          querySelectorAll: (selector) => (
            selector === '[data-category-details-form]' ? [clean.form] : []
          ),
        };
      }
    };

    try {
      await withBrowserGlobals(async () => ({
        ok: true,
        redirected: true,
        status: 200,
        text: async () => '<!doctype html><html></html>',
      }), async () => {
        enhanceCategoryDetails({ querySelectorAll: () => [current.form] });
        current.displayName.dispatch('change');
        await flushAsync();

        expect(parent.replacement).toBe(clean.form);
        expect(clean.status.textContent).toBe('Details saved.');
        expect(clean.displayName.focusCount).toBe(1);
        expect(clean.displayName.selectionStart).toBe(1);
        expect(clean.displayName.selectionEnd).toBe(3);
        expect(clean.displayName.listeners).toHaveLength(1);
      });
    } finally {
      globalThis.DOMParser = originalDOMParser;
    }
  });

  it('keeps a network failure in place', async () => {
    const fixture = makeDetailsFixture();
    await withBrowserGlobals(async () => { throw new Error('offline'); }, async () => {
      enhanceCategoryDetails({ querySelectorAll: () => [fixture.form] });
      fixture.directorySlug.dispatch('change');
      await flushAsync();
      expect(fixture.form.submitCount).toBe(0);
      expect(fixture.status.textContent).toBe('Could not save category details. Your current changes were kept.');
    });
  });

  it('leaves the native fallback intact when fetch is unavailable', () => {
    const fixture = makeDetailsFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
      enhanceCategoryDetails({ querySelectorAll: () => [fixture.form] });
      expect(fixture.displayName.listeners).toHaveLength(0);
      const event = fixture.form.dispatch('submit');
      expect(event.defaultPrevented).toBe(false);
      expect(fixture.form.submitCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('page-local asset selection enhancement', () => {
  it('returns zero and no-ops when neither selection forms nor cards are present', () => {
    const scope = {
      querySelectorAll(selector) {
        expect([
          '[data-asset-selection-form]',
          '[data-asset-selectable-card]',
        ]).toContain(selector);
        return [];
      },
    };

    expect(() => enhanceAssetSelection(scope)).not.toThrow();
    expect(enhanceAssetSelection(scope)).toBe(0);
  });

  it('binds eligible cards without a selection form and preserves a zero return count', () => {
    const checkbox = makeCheckbox();
    const card = makeSelectableAssetCard(checkbox);
    const scope = makeAssetSelectionScope(null, [card]);

    expect(enhanceAssetSelection(scope)).toBe(0);

    card.listeners.find((entry) => entry.type === 'click').handler({ target: card });
    expect(checkbox.checked).toBe(true);
    expect(card.attributes['aria-selected']).toBe('true');
  });

  it('binds keyboard selection for eligible cards without a selection form', () => {
    const checkbox = makeCheckbox();
    const card = makeSelectableAssetCard(checkbox);
    const scope = makeAssetSelectionScope(null, [card]);
    let prevented = false;

    enhanceAssetSelection(scope);

    card.listeners.find((entry) => entry.type === 'keydown').handler({
      target: card,
      key: 'Enter',
      preventDefault() { prevented = true; },
    });

    expect(prevented).toBe(true);
    expect(checkbox.checked).toBe(true);
  });

  it('binds standalone cards only once across repeated enhancement', () => {
    const checkbox = makeCheckbox();
    const card = makeSelectableAssetCard(checkbox);
    const scope = makeAssetSelectionScope(null, [card]);

    enhanceAssetSelection(scope);
    enhanceAssetSelection(scope);

    expect(card.listeners.filter((entry) => entry.type === 'click')).toHaveLength(1);
    expect(card.listeners.filter((entry) => entry.type === 'keydown')).toHaveLength(1);
    card.listeners.find((entry) => entry.type === 'click').handler({ target: card });
    expect(checkbox.checked).toBe(true);
  });

  it('leaves disabled card selection checkboxes non-interactive without a selection form', () => {
    const checkbox = makeCheckbox({ disabled: true });
    const card = makeSelectableAssetCard(checkbox);
    const scope = makeAssetSelectionScope(null, [card]);

    expect(enhanceAssetSelection(scope)).toBe(0);
    expect(card.listeners).toHaveLength(0);
    expect(checkbox.checked).toBe(false);
  });

  it('Select All checks only the enabled (present-asset) checkboxes', () => {
    const cb1 = makeCheckbox();
    const cb2 = makeCheckbox();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1, cb2] });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    form._singles['[data-select-all]'].dispatch('click');

    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(true);
  });

  it('Clear Selection unchecks the enabled checkboxes', () => {
    const cb1 = makeCheckbox({ checked: true });
    const cb2 = makeCheckbox({ checked: true });
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1, cb2] });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    form._singles['[data-clear-selection]'].dispatch('click');

    expect(cb1.checked).toBe(false);
    expect(cb2.checked).toBe(false);
  });

  it('missing-asset (disabled) checkboxes are never part of the enabled set Select All/Clear touch', () => {
    // A disabled checkbox never appears in the mock's enabledCheckboxes —
    // this proves the module only ever iterates the checkboxes it was
    // handed, mirroring the real :not(:disabled) selector excluding them.
    const disabledLikeMissingRow = makeCheckbox({ disabled: true });
    const form = makeAssetSelectionForm({ enabledCheckboxes: [] });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    form._singles['[data-select-all]'].dispatch('click');

    expect(disabledLikeMissingRow.checked).toBe(false);
  });

  it('updates the external live selected count for initialization, checkbox changes, Select All, and Clear Selection', () => {
    const cb1 = makeCheckbox();
    const cb2 = makeCheckbox();
    const countEl = makeControl();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1, cb2] });
    const scope = makeAssetSelectionScope(form, [], countEl);

    enhanceAssetSelection(scope);
    expect(countEl.textContent).toBe('0 of 2 selected');

    cb1.checked = true;
    cb1.dispatch('change');
    expect(countEl.textContent).toBe('1 of 2 selected');

    cb2.checked = true;
    cb2.dispatch('change');
    expect(countEl.textContent).toBe('2 of 2 selected');

    cb1.checked = false;
    cb1.dispatch('change');
    expect(countEl.textContent).toBe('1 of 2 selected');

    form._singles['[data-select-all]'].dispatch('click');
    expect(countEl.textContent).toBe('2 of 2 selected');

    form._singles['[data-clear-selection]'].dispatch('click');
    expect(countEl.textContent).toBe('0 of 2 selected');
  });

  it('enables Rename for one or many selected assets and disables it for zero', () => {
    const first = makeCheckbox();
    const second = makeCheckbox();
    const rename = makeControl();
    rename.setAttribute = vi.fn();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [first, second], renameButtons: [rename] });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    expect(rename.disabled).toBe(true);
    expect(rename.setAttribute).toHaveBeenLastCalledWith('aria-disabled', 'true');

    first.checked = true;
    first.dispatch('change');
    expect(rename.disabled).toBe(false);
    expect(rename.setAttribute).toHaveBeenLastCalledWith('aria-disabled', 'false');

    second.checked = true;
    second.dispatch('change');
    expect(rename.disabled).toBe(false);

    first.checked = false;
    second.checked = false;
    second.dispatch('change');
    expect(rename.disabled).toBe(true);
  });

  it('re-enhances a replacement selection form once without duplicating Rename updates', () => {
    const firstCheckbox = makeCheckbox();
    const firstRename = makeControl();
    firstRename.setAttribute = vi.fn();
    const firstForm = makeAssetSelectionForm({ enabledCheckboxes: [firstCheckbox], renameButtons: [firstRename] });
    enhanceAssetSelection(makeAssetSelectionScope(firstForm));

    const replacementCheckbox = makeCheckbox({ checked: true });
    const replacementRename = makeControl();
    replacementRename.setAttribute = vi.fn();
    const replacementForm = makeAssetSelectionForm({
      enabledCheckboxes: [replacementCheckbox], renameButtons: [replacementRename],
    });
    const replacementScope = makeAssetSelectionScope(replacementForm);

    enhanceAssetSelection(replacementScope);
    enhanceAssetSelection(replacementScope);
    expect(replacementRename.disabled).toBe(false);
    expect(replacementCheckbox.listeners.filter((entry) => entry.type === 'change')).toHaveLength(1);
  });

  it('uses the rendered visible-asset total for the live count', () => {
    const checkbox = makeCheckbox();
    const countEl = makeControl();
    countEl.getAttribute = (name) => name === 'data-selected-total' ? '3' : null;
    const form = makeAssetSelectionForm({ enabledCheckboxes: [checkbox] });
    const scope = makeAssetSelectionScope(form, [], countEl);

    enhanceAssetSelection(scope);
    expect(countEl.textContent).toBe('0 of 3 selected');

    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(countEl.textContent).toBe('1 of 3 selected');
  });

  it('submit is disabled until at least one asset is selected and a release is chosen', () => {
    const cb1 = makeCheckbox();
    const releaseSelect = makeControl({ value: '' });
    const submit = makeControl();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1], releaseSelect, bulkSubmit: submit });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    expect(submit.disabled).toBe(true);

    cb1.checked = true;
    cb1.dispatch('change');
    expect(submit.disabled).toBe(true); // asset selected, but no release yet

    releaseSelect.value = '5';
    releaseSelect.dispatch('change');
    expect(submit.disabled).toBe(false);

    cb1.checked = false;
    cb1.dispatch('change');
    expect(submit.disabled).toBe(true); // release chosen, but no assets now
  });

  it('establishes correct initial state on load (e.g. a validation rerender with a preserved selection)', () => {
    const cb1 = makeCheckbox({ checked: true }); // pre-checked from a submitted selection
    const releaseSelect = makeControl({ value: '5' }); // pre-selected from submission
    const submit = makeControl();
    const countEl = makeControl();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1], releaseSelect, bulkSubmit: submit });
    const scope = makeAssetSelectionScope(form, [], countEl);

    enhanceAssetSelection(scope);

    expect(countEl.textContent).toBe('1 of 1 selected');
    expect(submit.disabled).toBe(false);
  });

  it('synchronizes selected card and control state in both directions from the checkbox', () => {
    const checkbox = makeCheckbox({ checked: true });
    const form = makeAssetSelectionForm({ enabledCheckboxes: [checkbox] });
    const listeners = [];
    const controlClasses = new Set(['is-selected']);
    const cardClasses = new Set(['is-selected']);
    const attributes = { 'aria-selected': 'true' };
    const control = {
      classList: {
        toggle(name, enabled) {
          if (enabled) controlClasses.add(name);
          else controlClasses.delete(name);
        },
      },
    };
    const card = {
      dataset: {},
      classList: {
        toggle(name, enabled) {
          if (enabled) cardClasses.add(name);
          else cardClasses.delete(name);
        },
      },
      setAttribute(name, value) { attributes[name] = String(value); },
      querySelector(selector) {
        if (selector === '.asset-selection-control') return control;
        return null;
      },
      addEventListener(type, handler) { listeners.push({ type, handler }); },
    };
    checkbox.form = form;
    checkbox.closest = () => card;
    const scope = makeAssetSelectionScope(form, [card]);

    enhanceAssetSelection(scope);
    expect(cardClasses.has('is-selected')).toBe(true);
    expect(attributes['aria-selected']).toBe('true');
    expect(controlClasses.has('is-selected')).toBe(true);

    checkbox.checked = false;
    checkbox.dispatch('change');
    expect(checkbox.checked).toBe(false);
    expect(cardClasses.has('is-selected')).toBe(false);
    expect(attributes['aria-selected']).toBe('false');
    expect(controlClasses.has('is-selected')).toBe(false);

    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(checkbox.checked).toBe(true);
    expect(cardClasses.has('is-selected')).toBe(true);
    expect(attributes['aria-selected']).toBe('true');
    expect(controlClasses.has('is-selected')).toBe(true);
  });

  it('toggles a whole card but ignores links and forms inside the card', () => {
    const form = makeAssetSelectionForm({});
    const checkbox = makeCheckbox();
    checkbox.form = form;
    const listeners = [];
    const card = {
      dataset: {},
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      classList: {
        classes: new Set(),
        toggle(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); },
      },
      querySelector(selector) {
        if (selector.includes('selectedAssetIds')) return checkbox;
        return null;
      },
      contains(element) { return element === card || element === link || element === renameForm; },
    };
    checkbox.closest = () => card;
    const link = { closest: () => link };
    const renameForm = { closest: () => renameForm };
    const roleSelect = { closest: () => roleSelect };
    card.contains = (element) => element === card || element === link || element === renameForm || element === roleSelect;
    const scope = {
      querySelectorAll(selector) {
        if (selector === '[data-asset-selection-form]') return [form];
        if (selector.includes('selectedAssetIds')) return [checkbox];
        if (selector === '[data-asset-selectable-card]') return [card];
        return [];
      },
    };

    enhanceAssetSelection(scope);
    const click = (target) => listeners.find((entry) => entry.type === 'click').handler({ target });

    click(card);
    expect(checkbox.checked).toBe(true);
    expect(card.classList.classes.has('is-selected')).toBe(true);

    click(link);
    expect(checkbox.checked).toBe(true);
    click(renameForm);
    expect(checkbox.checked).toBe(true);
    click(roleSelect);
    expect(checkbox.checked).toBe(true);

    const keydown = listeners.find((entry) => entry.type === 'keydown').handler;
    keydown({ target: card, key: 'Enter', preventDefault() {} });
    expect(checkbox.checked).toBe(false);
  });

  it.each(['grid', 'list'])('selects project %s-card space while excluding real interactive descendants', (view) => {
    const selectedCount = makeControl();
    const form = makeAssetSelectionForm({ selectedCount });
    const checkbox = makeCheckbox();
    checkbox.form = form;
    const listeners = [];
    const windowObject = { location: { href: '/projects/1/assets?view=' + view } };
    const mediaLink = {};
    const targets = {
      blankMedia: {},
      fallback: {},
      blankLower: {},
      image: {},
      titleRow: {},
      titleText: {},
      details: {},
      status: {},
      renameTrigger: {},
      renameInput: {},
      renameButton: {},
      releaseLink: {},
      releaseDisclosure: {},
      releaseSummary: {},
      dropdown: {},
      autoRenameControl: {},
      contentEditable: {},
      roleButton: {},
      checkbox,
    };
    const interactiveTargets = new Set([
      mediaLink, targets.details, targets.status,
      targets.renameTrigger, targets.renameInput, targets.renameButton,
      targets.releaseLink, targets.releaseDisclosure, targets.releaseSummary,
      targets.dropdown, targets.autoRenameControl, targets.contentEditable,
      targets.roleButton, targets.checkbox,
    ]);
    const card = {
      className: view === 'grid' ? 'asset-card' : 'asset-list-card asset-list-card--project',
      dataset: {},
      attributes: {},
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      classList: {
        classes: new Set(),
        toggle(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); },
      },
      querySelector(selector) {
        if (selector.includes('selectedAssetIds')) return checkbox;
        return null;
      },
      contains(element) { return element === card || interactiveTargets.has(element); },
    };
    checkbox.closest = (selector) => selector.includes('data-asset-selectable-card') ? card : checkbox;
    mediaLink.closest = () => mediaLink;
    targets.image.closest = (selector) => selector.includes('a') ? mediaLink : null;
    for (const name of ['blankMedia', 'fallback', 'blankLower']) targets[name].closest = () => null;
    targets.titleRow.closest = () => null;
    targets.titleText.closest = () => null;
    for (const name of [
      'details', 'status', 'renameTrigger', 'renameInput', 'renameButton', 'releaseLink',
      'releaseDisclosure', 'releaseSummary', 'dropdown', 'autoRenameControl',
      'contentEditable', 'roleButton',
    ]) {
      targets[name].closest = () => targets[name];
    }
    targets.details.href = '/projects/1/assets/101';
    targets.details.click = () => { windowObject.location.href = targets.details.href; };

    const scope = {
      querySelectorAll(selector) {
        if (selector === '[data-asset-selection-form]') return [form];
        if (selector.includes('selectedAssetIds')) return [checkbox];
        if (selector === '[data-asset-selectable-card]') return [card];
        return [];
      },
    };

    enhanceAssetSelection(scope);
    enhanceAssetSelection(scope);
    const click = (target) => listeners.filter((entry) => entry.type === 'click')[0].handler({ target });

    click(targets.blankMedia);
    expect(checkbox.checked).toBe(true);
    expect(selectedCount.textContent).toBe('1 of 1 selected');
    expect(card.attributes['aria-selected']).toBe('true');
    click(targets.blankMedia);
    expect(checkbox.checked).toBe(false);
    expect(selectedCount.textContent).toBe('0 of 1 selected');
    expect(card.attributes['aria-selected']).toBe('false');

    click(targets.fallback);
    expect(checkbox.checked).toBe(true);
    click(targets.blankLower);
    expect(checkbox.checked).toBe(false);
    click(targets.titleRow);
    expect(checkbox.checked).toBe(true);
    click(targets.titleText);
    expect(checkbox.checked).toBe(false);

    checkbox.checked = true;
    checkbox.dispatch('change');
    click(mediaLink);
    expect(checkbox.checked).toBe(true);
    click(targets.image);
    expect(checkbox.checked).toBe(true);
    for (const target of [
      targets.details, targets.status,
      targets.renameTrigger, targets.renameInput, targets.renameButton,
      targets.releaseLink, targets.checkbox,
    ]) {
      if (target === targets.checkbox) {
        checkbox.checked = true;
        checkbox.dispatch('change');
      } else {
        click(target);
      }
      expect(checkbox.checked).toBe(true);
    }

    expect(windowObject.location.href).toBe('/projects/1/assets?view=' + view);
    const locationBeforeDetailsClick = windowObject.location.href;
    click(targets.details);
    expect(checkbox.checked).toBe(true);
    expect(windowObject.location.href).toBe(locationBeforeDetailsClick);
    targets.details.click();
    expect(windowObject.location.href).toBe('/projects/1/assets/101');

    // The native checkbox click has already changed checked before the card's
    // bubbling handler runs; the handler must leave it alone.
    checkbox.checked = false;
    click(checkbox);
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(card.attributes['aria-selected']).toBe('true');
    expect(selectedCount.textContent).toBe('1 of 1 selected');
    expect(listeners.filter((entry) => entry.type === 'click')).toHaveLength(1);
  });
});

describe('asset grid rename enhancement', () => {
  function makeRenameRegion({ editing = false } = {}) {
    const listeners = [];
    const makeControl = (props = {}) => ({
      disabled: false,
      ...props,
      setAttribute(name) {
        if (name === 'disabled') this.disabled = true;
      },
      removeAttribute(name) {
        if (name === 'disabled') this.disabled = false;
      },
    });
    const context = makeControl();
    const input = {
      ...makeControl(),
      focused: false,
      selected: false,
      focus() { this.focused = true; },
      select() { this.selected = true; },
    };
    const confirm = makeControl();
    const cancel = {
      ...makeControl(),
      addEventListener(type, handler) { listeners.push({ target: 'cancel', type, handler }); },
    };
    const titleRow = {
      hidden: editing,
      setAttribute(name) { if (name === 'hidden') this.hidden = true; },
      removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
    };
    const editor = {
      dataset: {},
      hidden: !editing,
      inert: false,
      addEventListener(type, handler) { listeners.push({ target: 'editor', type, handler }); },
      setAttribute(name) {
        if (name === 'hidden') this.hidden = true;
        if (name === 'inert') this.inert = true;
      },
      removeAttribute(name) {
        if (name === 'hidden') this.hidden = false;
        if (name === 'inert') this.inert = false;
      },
      querySelector(selector) {
        if (selector === '[data-asset-rename-input]') return input;
        if (selector === '[data-asset-rename-cancel]') return cancel;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'input, button, select, textarea') return [context, input, confirm, cancel];
        return [];
      },
      dispatch(type, event = {}) {
        for (const listener of listeners.filter((entry) => entry.target === 'editor' && entry.type === type)) {
          listener.handler({ target: input, ...event });
        }
      },
      cancel,
      confirm,
      context,
      input,
      titleRow,
    };
    const region = {
      querySelector(selector) {
        if (selector === '[data-asset-title-row]') return titleRow;
        if (selector === '[data-asset-rename-editor]') return editor;
        return null;
      },
    };
    const trigger = {
      dataset: {},
      focused: false,
      addEventListener(type, handler) { listeners.push({ target: 'trigger', type, handler }); },
      closest() { return region; },
      focus() { this.focused = true; },
      dispatch(type, event = {}) {
        for (const listener of listeners.filter((entry) => entry.target === 'trigger' && entry.type === type)) {
          listener.handler({ target: trigger, ...event });
        }
      },
    };
    cancel.dispatch = (event = {}) => {
      for (const listener of listeners.filter((entry) => entry.target === 'cancel' && entry.type === 'click')) {
        listener.handler(event);
      }
    };
    return { trigger, editor, input, titleRow, cancel, confirm, context, region, listeners };
  }

  it('keeps inactive controls out of the keyboard surface and supports idempotent open/close behavior', () => {
    const { trigger, editor, input, titleRow, cancel, confirm, context, region, listeners } = makeRenameRegion();
    const scope = { querySelectorAll: (selector) => selector === '[data-asset-rename-trigger]' ? [trigger] : [] };

    expect(enhanceAssetRenames(scope)).toBe(1);
    expect(enhanceAssetRenames(scope)).toBe(1);
    expect(listeners.filter((entry) => entry.target === 'trigger' && entry.type === 'click')).toHaveLength(1);
    expect(listeners.filter((entry) => entry.target === 'editor' && entry.type === 'keydown')).toHaveLength(1);
    expect(listeners.filter((entry) => entry.target === 'cancel' && entry.type === 'click')).toHaveLength(1);
    expect(trigger.closest().querySelector('[data-asset-rename-editor]')).toBe(editor);
    expect(editor.hidden).toBe(true);
    expect(editor.inert).toBe(true);
    expect(context.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);

    let prevented = false;
    trigger.dispatch('click', { preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(input.focused).toBe(true);
    expect(input.selected).toBe(true);
    expect(editor.hidden).toBe(false);
    expect(editor.inert).toBe(false);
    expect(context.disabled).toBe(false);
    expect(input.disabled).toBe(false);
    expect(confirm.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
    expect(titleRow.hidden).toBe(true);

    let submitPrevented = false;
    editor.dispatch('submit', { preventDefault() { submitPrevented = true; } });
    expect(submitPrevented).toBe(false);

    editor.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(editor.hidden).toBe(true);
    expect(editor.inert).toBe(true);
    expect(context.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(titleRow.hidden).toBe(false);
    expect(trigger.focused).toBe(true);

    trigger.dispatch('click', { preventDefault() {} });
    cancel.dispatch({ preventDefault() {} });
    expect(editor.hidden).toBe(true);
    expect(editor.inert).toBe(true);
    expect(titleRow.hidden).toBe(false);
  });

  it('keeps a server-rendered initially open editor active', () => {
    const { trigger, editor, input, titleRow, cancel, confirm, context, listeners } = makeRenameRegion({ editing: true });
    const scope = { querySelectorAll: (selector) => selector === '[data-asset-rename-trigger]' ? [trigger] : [] };

    enhanceAssetRenames(scope);
    enhanceAssetRenames(scope);

    expect(editor.hidden).toBe(false);
    expect(editor.inert).toBe(false);
    expect(context.disabled).toBe(false);
    expect(input.disabled).toBe(false);
    expect(confirm.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
    expect(input.focused).toBe(true);
    expect(input.selected).toBe(true);
    expect(listeners.filter((entry) => entry.target === 'trigger' && entry.type === 'click')).toHaveLength(1);
  });
});

describe('Destructive confirmation enhancement', () => {
  it('exports the shared dialog binder rather than a browser-native confirmation path', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/static/client/confirm-dialog.js', import.meta.url)),
      'utf8',
    );
    expect(enhanceConfirmations).toBeDefined();
    expect(source).toContain("querySelectorAll('[data-confirm]')");
    expect(source).not.toContain('globalThis.confirm');
  });
});

describe('Project Assets category filter enhancement', () => {
  function makeFixture({ selected = 'all', presence = 'all' } = {}) {
    const inputs = [
      ['All categories (12)', 'all', 'all'],
      ['Renders (7)', '7', 'all'],
      ['Missing (3)', 'all', 'missing'],
    ].map(([labelText, value, presenceValue]) => {
      const listeners = [];
      const input = {
        value,
        checked: value === selected && (presenceValue !== 'missing' || presence === 'missing'),
        listeners,
        addEventListener(type, handler) { listeners.push({ type, handler }); },
        dispatch(type) {
          listeners.filter((listener) => listener.type === type)
            .forEach((listener) => listener.handler());
        },
        getAttribute(name) {
          return name === 'data-asset-category-presence' ? presenceValue : null;
        },
        closest(selector) {
          return selector === 'label' ? label : null;
        },
      };
      const label = { textContent: labelText };
      const option = {
        querySelector(selector) {
          if (selector === 'input[name="category"]') return input;
          if (selector === 'label') return label;
          return null;
        },
      };
      return { input, option };
    });

    const summaryAttrs = {};
    const summary = {
      setAttribute(name, value) { summaryAttrs[name] = String(value); },
      getAttribute(name) { return summaryAttrs[name] ?? null; },
    };
    const summaryText = { textContent: '' };
    summaryAttrs['aria-label'] = 'Category filter: All categories (12)';
    const presenceListeners = [];
    const presenceControl = {
      value: presence,
      addEventListener(type, handler) { presenceListeners.push({ type, handler }); },
      dispatch(type) {
        presenceListeners.filter((listener) => listener.type === type)
          .forEach((listener) => listener.handler());
      },
    };
    const form = {
      querySelector(selector) {
        return selector === 'select[name="presence"]' ? presenceControl : null;
      },
    };
    const filter = {
      dataset: { ccDropdownMode: 'single' },
      matches(selector) {
        return selector === '[data-cc-dropdown]';
      },
      querySelectorAll(selector) {
        return selector === '.asset-filter-multiselect-option'
          ? inputs.map(({ option }) => option)
          : [];
      },
      querySelector(selector) {
        if (selector === '[data-cc-dropdown-summary-current]') return summaryText;
        if (selector === 'input[type="radio"]:checked') {
          return inputs.find(({ input }) => input.checked)?.input || null;
        }
        if (selector === 'summary') return summary;
        return null;
      },
      closest(selector) {
        return selector === 'form' ? form : null;
      },
    };
    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-asset-category-filter]' ? [filter] : [];
      },
    };

    return {
      scope,
      inputs,
      summaryAttrs,
      summaryText,
      presenceControl,
      presenceListeners,
    };
  }

  it('updates the selected summary and maps Missing to presence without duplicate listeners', () => {
    const fixture = makeFixture();

    expect(enhanceProjectAssetCategoryFilter(fixture.scope)).toBe(1);
    expect(enhanceProjectAssetCategoryFilter(fixture.scope)).toBe(1);
    expect(fixture.summaryText.textContent).toBe('All categories (12)');
    expect(fixture.summaryAttrs['aria-label']).toBe('Category filter: All categories (12)');
    expect(fixture.inputs[2].input.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(fixture.presenceListeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    fixture.inputs[0].input.checked = false;
    fixture.inputs[2].input.checked = true;
    fixture.inputs[2].input.dispatch('change');
    expect(fixture.presenceControl.value).toBe('missing');
    expect(fixture.summaryText.textContent).toBe('Missing (3)');
    expect(fixture.summaryAttrs['aria-label']).toBe('Category filter: Missing (3)');

    fixture.inputs[2].input.checked = false;
    fixture.inputs[1].input.checked = true;
    fixture.inputs[1].input.dispatch('change');
    expect(fixture.presenceControl.value).toBe('all');
    expect(fixture.summaryText.textContent).toBe('Renders (7)');
    expect(fixture.summaryAttrs['aria-label']).toBe('Category filter: Renders (7)');
  });
});

describe('Asset Viewer filter disclosure dismissal', () => {
  function makeSingleSelectDisclosureFixture() {
    const scopeListeners = [];
    const summaryAttrs = { 'aria-label': 'Status: Planned' };
    const currentSummary = { textContent: 'Planned' };
    const radios = [];
    const summary = {
      setAttribute(name, value) { summaryAttrs[name] = String(value); },
      getAttribute(name) { return summaryAttrs[name] || null; },
    };
    const disclosure = {
      open: false,
      dataset: { assetViewerFilterSingleSelect: '' },
      querySelector(selector) {
        if (selector === 'summary') return summary;
        if (selector === '.asset-filter-multiselect-summary-current') return currentSummary;
        if (selector === 'input[type="radio"]:checked') return radios.find((radio) => radio.checked) || null;
        return null;
      },
    };

    for (const [value, labelText] of [['planned', 'Planned'], ['published', 'Published']]) {
      const label = { textContent: labelText };
      radios.push({
        type: 'radio',
        name: 'status',
        value,
        checked: value === 'planned',
        closest(selector) {
          if (selector === 'label') return label;
          return selector === '[data-asset-viewer-filter-disclosure]' ? disclosure : null;
        },
      });
    }

    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-asset-viewer-filter-disclosure]' ? [disclosure] : [];
      },
      addEventListener(type, handler, options) {
        scopeListeners.push({ type, handler, options });
      },
      dispatch(type, target, props = {}) {
        const event = {
          type,
          target,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          ...props,
        };
        scopeListeners
          .filter((listener) => listener.type === type)
          .forEach((listener) => listener.handler(event));
        return event;
      },
    };

    return { scope, scopeListeners, disclosure, summaryAttrs, currentSummary, radios };
  }

  it('initializes and updates the single-select summary while preserving native radio state', () => {
    const fixture = makeSingleSelectDisclosureFixture();
    const planned = fixture.radios.find((radio) => radio.value === 'planned');
    const published = fixture.radios.find((radio) => radio.value === 'published');

    expect(enhanceAssetViewerFilterDisclosures(fixture.scope)).toBe(1);
    expect(fixture.currentSummary.textContent).toBe('Planned');
    expect(planned.checked).toBe(true);
    expect(fixture.scopeListeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    planned.checked = false;
    published.checked = true;
    const changeEvent = fixture.scope.dispatch('change', published);

    expect(changeEvent.defaultPrevented).toBe(false);
    expect(fixture.currentSummary.textContent).toBe('Published');
    expect(fixture.summaryAttrs['aria-label']).toBe('Status: Published');
    expect(published.checked).toBe(true);
    expect(published.name).toBe('status');
    expect(published.value).toBe('published');
    expect(planned.checked).toBe(false);
  });

  function makeMultiSelectDisclosureFixture() {
    const scopeListeners = [];
    const summaryAttrs = { 'aria-label': 'Tags: No tags selected' };
    const currentSummary = { textContent: 'No tags selected' };
    const checkboxes = [];
    const summary = {
      setAttribute(name, value) { summaryAttrs[name] = String(value); },
      getAttribute(name) { return summaryAttrs[name] || null; },
    };
    const disclosure = {
      open: false,
      dataset: { assetViewerFilterMultiSelect: '' },
      querySelector(selector) {
        if (selector === 'summary') return summary;
        if (selector === '.asset-filter-multiselect-summary-current') return currentSummary;
        return null;
      },
      querySelectorAll(selector) {
        return selector === 'input[type="checkbox"]' ? checkboxes : [];
      },
    };

    for (const [value, labelText] of [['1', 'Alpha'], ['2', 'Beta'], ['3', 'Gamma']]) {
      const label = { textContent: labelText };
      const input = {
        type: 'checkbox',
        name: 'tagIds[]',
        value,
        checked: false,
        closest(selector) {
          if (selector === 'label') return label;
          return selector === '[data-asset-viewer-filter-disclosure]' ? disclosure : null;
        },
      };
      checkboxes.push(input);
    }

    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-asset-viewer-filter-disclosure]' ? [disclosure] : [];
      },
      addEventListener(type, handler, options) {
        scopeListeners.push({ type, handler, options });
      },
      dispatch(type, target, props = {}) {
        const event = {
          type,
          target,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          ...props,
        };
        scopeListeners
          .filter((listener) => listener.type === type)
          .forEach((listener) => listener.handler(event));
        return event;
      },
    };

    return { scope, scopeListeners, disclosure, summaryAttrs, currentSummary, checkboxes };
  }

  it('initializes and updates the multi-select summary for one, multiple, and zero selections', () => {
    const fixture = makeMultiSelectDisclosureFixture();
    fixture.checkboxes[0].checked = true;

    expect(enhanceAssetViewerFilterDisclosures(fixture.scope)).toBe(1);
    expect(fixture.currentSummary.textContent).toBe('Alpha');
    expect(fixture.summaryAttrs['aria-label']).toBe('Tags: Alpha');

    fixture.checkboxes[1].checked = true;
    const betaEvent = fixture.scope.dispatch('change', fixture.checkboxes[1]);
    expect(betaEvent.defaultPrevented).toBe(false);
    expect(fixture.currentSummary.textContent).toBe('2 tags selected');
    expect(fixture.summaryAttrs['aria-label']).toBe('Tags: 2 tags selected');

    fixture.checkboxes[0].checked = false;
    fixture.checkboxes[1].checked = false;
    fixture.scope.dispatch('change', fixture.checkboxes[0]);
    fixture.scope.dispatch('change', fixture.checkboxes[1]);
    expect(fixture.currentSummary.textContent).toBe('No tags selected');
    expect(fixture.summaryAttrs['aria-label']).toBe('Tags: No tags selected');
  });
});

describe('asset grid size enhancement', () => {
  function makeGrid() {
    const attrs = {};
    const style = {
      values: {},
      setProperty(name, value) { this.values[name] = value; },
      removeProperty(name) { delete this.values[name]; },
    };
    return {
      style,
      dataset: {},
      setAttribute(name, value) { attrs[name] = String(value); if (name === 'data-grid-size') this.dataset.gridSize = String(value); },
      removeAttribute(name) { delete attrs[name]; delete this.dataset.gridSize; },
      attrs,
    };
  }

  function makeGridSliderControls({ project = false } = {}) {
    const sliderListeners = [];
    const slider = {
      value: '2',
      attrs: {},
      addEventListener(type, handler) { sliderListeners.push({ type, handler }); },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      dispatch(type) {
        sliderListeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler());
      },
    };
    const labels = ['compact', 'default', 'large'].map((size) => ({
      tagName: 'SPAN',
      dataset: { gridSizeOptionLabel: size },
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = String(value); },
      classList: {
        values: new Set(),
        toggle(name, force) {
          if (force) this.values.add(name);
          else this.values.delete(name);
        },
      },
    }));
    const group = {
      querySelectorAll(selector) {
        if (selector === '[data-grid-size-slider]') return [slider];
        if (selector === '[data-grid-size-option-label]') return labels;
        return [];
      },
      hasAttribute() { return false; },
      closest(selector) {
        return project && selector === '[data-project-grid-size-controls]' ? {} : null;
      },
    };
    return { group, slider, labels };
  }

  it('finds every Projects grid and its control, maps every size, and keeps state isolated', () => {
    const assetGrid = makeGrid();
    const projectGrids = [makeGrid(), makeGrid(), makeGrid()];
    const assetControls = makeGridSliderControls();
    const projectControls = makeGridSliderControls({ project: true });
    const storage = new Map([
      ['creatorcrate-asset-grid-size', 'large'],
      ['creatorcrate-project-grid-size', 'compact'],
    ]);
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };
    try {
      const scope = {
        querySelectorAll(selector) {
          if (selector === '[data-asset-grid-size-controls]') return [assetControls.group, projectControls.group];
          if (selector === '[data-project-grid-size-controls] [data-asset-grid-size-controls]') {
            return [projectControls.group];
          }
          if (selector === '.asset-grid') return [assetGrid];
          if (selector === '.project-grid') return projectGrids;
          return [];
        },
      };

      expect(enhanceAssetGridSize(scope)).toBe(1);
      expect(assetGrid.style.values['--asset-card-min']).toBe('20rem');
      for (const projectGrid of projectGrids) {
        expect(projectGrid.style.values).toEqual({});
      }
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');

      assetControls.slider.value = '2';
      assetControls.slider.dispatch('change');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('default');
      expect(assetGrid.attrs['data-grid-size']).toBeUndefined();
      expect(assetGrid.dataset.gridSize).toBeUndefined();
      expect(assetGrid.style.values['--asset-card-min']).toBeUndefined();
      expect(assetControls.slider.attrs['aria-valuenow']).toBe('2');
      expect(assetControls.slider.attrs['aria-valuetext']).toBe('Default');

      expect(enhanceProjectGridSize(scope)).toBe(1);
      for (const projectGrid of projectGrids) {
        expect(projectGrid.attrs['data-grid-size']).toBe('compact');
        expect(projectGrid.style.values['--project-card-min']).toBe('12rem');
        expect(projectGrid.style.values['--asset-card-min']).toBeUndefined();
      }
      expect(projectControls.slider.attrs['aria-valuetext']).toBe('Compact');
      expect(storage.get('creatorcrate-project-grid-size')).toBe('compact');

      const expected = [
        { position: '1', size: 'compact', min: '12rem', label: 'Compact' },
        { position: '2', size: 'default', min: undefined, label: 'Default' },
        { position: '3', size: 'large', min: '20rem', label: 'Large' },
      ];
      for (const { position, size, min, label } of expected) {
        projectControls.slider.value = position;
        projectControls.slider.dispatch('input');

        expect(storage.get('creatorcrate-project-grid-size')).toBe(size);
        expect(projectControls.slider.attrs['aria-valuenow']).toBe(position);
        expect(projectControls.slider.attrs['aria-valuetext']).toBe(label);
        for (const projectGrid of projectGrids) {
          if (min) expect(projectGrid.style.values['--project-card-min']).toBe(min);
          else expect(projectGrid.style.values).toEqual({});
          if (size === 'default') expect(projectGrid.attrs['data-grid-size']).toBeUndefined();
          else expect(projectGrid.attrs['data-grid-size']).toBe(size);
        }
      }

      assetControls.slider.value = '1';
      assetControls.slider.dispatch('input');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-project-grid-size')).toBe('large');
      expect(assetGrid.style.values['--asset-card-min']).toBe('12rem');
      for (const projectGrid of projectGrids) {
        expect(projectGrid.style.values['--project-card-min']).toBe('20rem');
      }
      expect(storage.get('creatorcrate-asset-grid-size')).not.toBe(storage.get('creatorcrate-project-grid-size'));
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('uses the Projects default for missing and invalid stored preferences', () => {
    for (const { name, stored } of [
      { name: 'missing', stored: undefined },
      { name: 'invalid', stored: 'not-supported' },
    ]) {
      const projectGrid = makeGrid();
      const projectControls = makeGridSliderControls({ project: true });
      const storage = new Map();
      if (stored !== undefined) storage.set('creatorcrate-project-grid-size', stored);
      const writes = [];
      const previousStorage = globalThis.localStorage;
      globalThis.localStorage = {
        getItem: (key) => storage.get(key) ?? null,
        setItem(key, value) {
          writes.push([key, value]);
          storage.set(key, value);
        },
      };
      try {
        const scope = {
          querySelectorAll(selector) {
            if (selector === '[data-project-grid-size-controls] [data-asset-grid-size-controls]') {
              return [projectControls.group];
            }
            if (selector === '.project-grid') return [projectGrid];
            return [];
          },
        };

        expect(enhanceProjectGridSize(scope), name).toBe(1);
        expect(projectGrid.attrs['data-grid-size'], name).toBeUndefined();
        expect(projectGrid.dataset.gridSize, name).toBeUndefined();
        expect(projectGrid.style.values['--project-card-min'], name).toBeUndefined();
        expect(projectControls.slider.value, name).toBe('2');
        expect(projectControls.slider.attrs['aria-valuenow'], name).toBe('2');
        expect(projectControls.slider.attrs['aria-valuetext'], name).toBe('Default');
        expect(
          projectControls.labels.map((label) => label.classList.values.has('is-active')),
          name,
        ).toEqual([false, true, false]);
        expect(writes, name).toEqual([]);
        expect(storage.get('creatorcrate-project-grid-size'), name).toBe(stored);
      } finally {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
      }
    }
  });

});

describe('Release form date picker enhancement', () => {
  function makeDatePickerScope({ plannedValue = '', publishedValue = '', timeValue = '', clockFormat = '24h' } = {}) {
    const listeners = [];
    const fields = [];
    const timeFields = [];

    function createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        parentElement: null,
        parentNode: null,
        children: [],
        dataset: {},
        classList: {
          values: new Set(),
          add(name) { this.values.add(name); },
          remove(name) { this.values.delete(name); },
          toggle(name, force) {
            if (force === true) { this.values.add(name); }
            else if (force === false) { this.values.delete(name); }
            else if (this.values.has(name)) { this.values.delete(name); }
            else { this.values.add(name); }
          },
          contains(name) { return this.values.has(name); },
        },
        get className() { return [...this.classList.values].join(' '); },
        set className(value) {
          this.classList.values.clear();
          for (const name of String(value || '').split(/\s+/).filter(Boolean)) {
            this.classList.values.add(name);
          }
        },
        style: {},
        attrs: {},
        textContent: '',
        setAttribute(name, value) { this.attrs[name] = String(value); },
        getAttribute(name) { return this.attrs[name] ?? null; },
        hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
        removeAttribute(name) { delete this.attrs[name]; },
        appendChild(child) {
          child.parentElement = this;
          child.parentNode = this;
          this.children.push(child);
        },
        removeChild(child) {
          const index = this.children.indexOf(child);
          if (index >= 0) this.children.splice(index, 1);
          child.parentElement = null;
          child.parentNode = null;
        },
        get firstChild() { return this.children[0] || null; },
        addEventListener(type, handler) { listeners.push({ target: this, type, handler }); },
        matches(selector) {
          const tag = this.tagName.toLowerCase();
          const classSet = this.classList.values;
          const classNameClasses = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
          const hasClass = (name) => classSet.has(name) || classNameClasses.has(name);
          const simple = selector.split(',').map((s) => s.trim());
          return simple.some((part) => {
            // Strip a single trailing :not(...) clause from the part.
            const notMatch = part.match(/^(.+):not\(([^)]+)\)$/);
            let base = part;
            let notSelector = null;
            if (notMatch) {
              base = notMatch[1].trim();
              notSelector = notMatch[2].trim();
            }
            const pieces = base.split('.');
            const first = pieces[0];
            const requiredClasses = pieces.slice(1).filter(Boolean);
            const matchBase = () => {
              if (base === '' || base === tag) return true;
              if (first === '' || first === tag) {
                return requiredClasses.every((name) => hasClass(name));
              }
              if (base.startsWith('#') && this.id === base.slice(1)) return true;
              if (base.startsWith('[') && base.endsWith(']')) {
                const attr = base.slice(1, -1);
                return this.hasAttribute(attr) || Object.hasOwn(this.dataset, attr);
              }
              if (base === ':disabled' && this.disabled) return true;
              return false;
            };
            if (!matchBase()) return false;
            if (notSelector) {
              if (notSelector.startsWith('.')) {
                const notClasses = notSelector.slice(1).split('.').filter(Boolean);
                if (notClasses.every((name) => hasClass(name))) return false;
              } else if (notSelector === ':disabled' && this.disabled) {
                return false;
              }
            }
            return true;
          });
        },
        querySelector(selector) {
          for (const child of this.children) {
            if (child.matches?.(selector)) return child;
            const found = child.querySelector?.(selector);
            if (found) return found;
          }
          return null;
        },
        querySelectorAll(selector) {
          const found = [];
          const walk = (node) => {
            if (node.matches?.(selector)) found.push(node);
            for (const child of node.children || []) walk(child);
          };
          walk(this);
          return found;
        },
        contains(candidate) {
          let current = candidate;
          while (current) {
            if (current === this) return true;
            current = current.parentElement;
          }
          return false;
        },
        dispatch(type, props = {}) {
          const event = {
            type,
            target: this,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() {},
            ...props,
          };
          listeners
            .filter((entry) => entry.target === this && entry.type === type)
            .forEach((entry) => entry.handler(event));
          return event;
        },
      };
    }

    function makeButton({ parent, attrs = {}, text = '' } = {}) {
      const node = createElement('button');
      node.type = 'button';
      node.disabled = false;
      node.textContent = text;
      node.parentElement = parent;
      node.parentNode = parent;
      Object.assign(node.attrs, attrs);
      node.focus = function () {
        this.focused = { value: true };
        documentStub.activeElement = this;
      };
      return node;
    }

    // Patch the renderer's document.createElement calls for this fixture.
    const previousDocument = globalThis.document;
    const documentStub = {
      activeElement: null,
      createElement: createElement,
      addEventListener(type, handler) { listeners.push({ target: documentStub, type, handler }); },
      dispatch(type, target, props = {}) {
        const event = {
          type,
          target,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
          ...props,
        };
        listeners
          .filter((entry) => entry.target === documentStub && entry.type === type)
          .forEach((entry) => entry.handler(event));
        return event;
      },
    };
    globalThis.document = documentStub;

    function makeInput({ parent, value = '', id = '', type = 'date', attrs = {} } = {}) {
      const node = createElement('input');
      node.type = type;
      node.id = id;
      node.value = value;
      node.parentElement = parent;
      node.parentNode = parent;
      Object.assign(node.attrs, attrs);
      // Mirror data attributes as both attrs and dataset so selector matches work.
      if (Object.hasOwn(attrs, 'data-date-picker-input')) {
        node.dataset.datePickerInput = '';
      }
      if (Object.hasOwn(attrs, 'data-time-picker-input')) {
        node.dataset.timePickerInput = '';
      }
      node.dispatched = [];
      node.dispatchEvent = function (event) { this.dispatched.push(event); };
      node.focus = function () {
        this.focused = { value: true };
        documentStub.activeElement = this;
      };
      return node;
    }

    function makePanel({ parent, id = '', fieldFor = '', kind = 'date' } = {}) {
      const node = createElement('div');
      node.id = id;
      node.role = 'dialog';
      node.hidden = true;
      node.parentElement = parent;
      node.parentNode = parent;
      if (kind === 'time') {
        node.dataset.timePickerPanel = '';
        node.dataset.timePickerFor = fieldFor;
        node.attrs['data-time-picker-panel'] = '';
        node.attrs['data-time-picker-for'] = fieldFor;
      } else {
        node.dataset.datePickerPanel = '';
        node.dataset.datePickerFor = fieldFor;
        node.attrs['data-date-picker-panel'] = '';
        node.attrs['data-date-picker-for'] = fieldFor;
      }
      node.attrs.hidden = 'hidden';
      return node;
    }

    function makeField({ id, inputValue = '' }) {
      const field = createElement('div');
      field.dataset.datePickerField = '';
      field.matches = function (selector) { return selector === '[data-date-picker-field]'; };

      const picker = createElement('div');
      picker.className = 'picker-control';
      picker.parentElement = field;
      picker.parentNode = field;

      const inputRow = createElement('div');
      inputRow.className = 'picker-input-row';
      inputRow.parentElement = picker;
      inputRow.parentNode = picker;

      const input = makeInput({ parent: inputRow, value: inputValue, id, attrs: { class: 'picker-input', 'data-date-picker-input': '' } });
      const trigger = makeButton({
        parent: inputRow,
        text: '📅',
        attrs: {
          class: 'picker-trigger date-picker-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': 'false',
          'aria-controls': `${id}-calendar`,
        },
      });
      trigger.className = 'picker-trigger date-picker-trigger';
      trigger.classList.add('picker-trigger');
      trigger.classList.add('date-picker-trigger');
      const panel = makePanel({ parent: picker, id: `${id}-calendar`, fieldFor: id });

      inputRow.appendChild(input);
      inputRow.appendChild(trigger);
      picker.appendChild(inputRow);
      picker.appendChild(panel);
      field.appendChild(picker);

      fields.push({ field, input, trigger, panel });
      return field;
    }

    function makeTimeField({ inputValue = '', format = '24h' } = {}) {
      const field = createElement('div');
      field.dataset.timePickerField = '';
      field.dataset.clockFormat = format;

      const picker = createElement('div');
      picker.className = 'picker-control';
      picker.parentElement = field;
      picker.parentNode = field;

      const inputRow = createElement('div');
      inputRow.className = 'picker-input-row';
      inputRow.parentElement = picker;
      inputRow.parentNode = picker;

      const input = makeInput({
        parent: inputRow,
        value: inputValue,
        id: 'plannedTime',
        type: 'time',
        attrs: { class: 'picker-input', 'data-time-picker-input': '' },
      });
      const trigger = makeButton({
        parent: inputRow,
        text: '◷',
        attrs: {
          class: 'picker-trigger time-picker-trigger',
          'data-time-picker-trigger': '',
        },
      });
      trigger.className = 'picker-trigger time-picker-trigger';
      trigger.classList.add('picker-trigger');
      trigger.classList.add('time-picker-trigger');

      inputRow.appendChild(input);
      inputRow.appendChild(trigger);
      picker.appendChild(inputRow);
      const panel = makePanel({ parent: picker, id: 'plannedTime-picker', fieldFor: 'plannedTime', kind: 'time' });
      picker.appendChild(panel);
      field.appendChild(picker);

      timeFields.push({ field, input, trigger, panel });
      return field;
    }

    const scope = {
      dataset: {},
      listeners,
      querySelectorAll(selector) {
        if (selector === '[data-date-picker-field]') return fields.map((f) => f.field);
        if (selector === '[data-time-picker-field]') return timeFields.map((f) => f.field);
        return [];
      },
      addEventListener(type, handler) { listeners.push({ target: scope, type, handler }); },
      dispatch(type, target, props = {}) {
        const event = {
          type,
          target,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
          ...props,
        };
        listeners
          .filter((entry) => entry.target === scope && entry.type === type)
          .forEach((entry) => entry.handler(event));
        return event;
      },
    };

    const plannedField = makeField({ id: 'plannedDate', inputValue: plannedValue });
    const publishedField = makeField({ id: 'publishedDate', inputValue: publishedValue });
    makeTimeField({ inputValue: timeValue, format: clockFormat });

    return {
      scope,
      planned: fields.find((f) => f.input.id === 'plannedDate'),
      published: fields.find((f) => f.input.id === 'publishedDate'),
      time: timeFields[0],
      all: fields,
      listeners,
      documentStub,
      restoreDocument() {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
      },
    };
  }

  it('re-enhances each date field exactly once and returns the field count', () => {
    const fixture = makeDatePickerScope();
    try {
      expect(enhanceDatePickers(fixture.scope)).toBe(2);
      expect(enhanceDatePickers(fixture.scope)).toBe(2);
      fixture.planned.trigger.dispatch('click');
      expect(fixture.planned.panel.hidden).toBe(false);
      expect(fixture.planned.trigger.attrs['aria-expanded']).toBe('true');
    } finally {
      fixture.restoreDocument();
    }
  });

  it('opens the corresponding custom time picker once and does not double-bind', () => {
    const fixture = makeDatePickerScope();
    try {
      expect(enhanceTimePickers(fixture.scope)).toBe(1);
      expect(enhanceTimePickers(fixture.scope)).toBe(1);
      fixture.time.trigger.dispatch('click');

      expect(fixture.time.panel.hidden).toBe(false);
      expect(fixture.time.trigger.attrs['aria-expanded']).toBe('true');
      expect(fixture.time.panel.querySelectorAll('.time-picker-option')).toHaveLength(84);
      expect(fixture.time.panel.querySelectorAll('.time-picker-option').filter((option) => option.hasAttribute('data-time-hour'))
        .map((option) => option.textContent)).toEqual(Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')));
      expect(fixture.time.panel.querySelectorAll('.time-picker-option').some((option) => option.hasAttribute('data-time-period'))).toBe(false);
      const roles = fixture.time.panel.querySelectorAll('[role]').map((node) => node.getAttribute('role'));
      expect(roles).not.toContain('listbox');
      expect(roles).not.toContain('option');
      const options = fixture.time.panel.querySelectorAll('.time-picker-option');
      expect(options.every((option) => option.getAttribute('role') === null)).toBe(true);
      expect(options.some((option) => option.getAttribute('aria-pressed') === 'true')).toBe(true);
      expect(fixture.listeners.filter((entry) => entry.target === fixture.time.trigger && entry.type === 'click')).toHaveLength(1);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('selects hour and minute values through the custom panel and closes cleanly', () => {
    const fixture = makeDatePickerScope();
    try {
      enhanceTimePickers(fixture.scope);
      fixture.time.trigger.dispatch('click');
      const hour = fixture.time.panel.querySelectorAll('.time-picker-option')
        .find((option) => option.getAttribute('data-time-hour') === '14');
      const minute = fixture.time.panel.querySelectorAll('.time-picker-option')
        .find((option) => option.getAttribute('data-time-minute') === '30');
      hour.dispatch('click');
      minute.dispatch('click');

      expect(fixture.time.input.value).toBe('14:30');
      expect(fixture.time.input.dispatched.map((event) => event.type)).toEqual(['input', 'change', 'input', 'change']);
      expect(fixture.time.panel.hidden).toBe(false);

      fixture.time.panel.querySelector('.date-picker-close').dispatch('click');
      expect(fixture.time.panel.hidden).toBe(true);
      expect(fixture.time.trigger.attrs['aria-expanded']).toBe('false');
      expect(fixture.time.trigger.focused.value).toBe(true);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('closes the custom time picker without outside-click focus theft and restores focus on Escape', () => {
    const fixture = makeDatePickerScope();
    try {
      enhanceTimePickers(fixture.scope);
      fixture.time.trigger.dispatch('click');
      const outside = { parentElement: null, parentNode: null };
      fixture.documentStub.activeElement = outside;
      globalThis.document.dispatch('click', outside);
      expect(fixture.time.panel.hidden).toBe(true);
      expect(fixture.time.trigger.focused).toBeUndefined();
      expect(fixture.documentStub.activeElement).toBe(outside);

      fixture.time.trigger.dispatch('click');
      const escapeEvent = fixture.time.panel.dispatch('keydown', { key: 'Escape' });
      expect(escapeEvent.defaultPrevented).toBe(true);
      expect(fixture.time.panel.hidden).toBe(true);
      expect(fixture.time.trigger.focused.value).toBe(true);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('opens the intended calendar and closes the previous calendar when another opens', () => {
    const fixture = makeDatePickerScope();
    try {
      enhanceDatePickers(fixture.scope);
      fixture.planned.trigger.dispatch('click');
      expect(fixture.planned.panel.hidden).toBe(false);
      expect(fixture.published.panel.hidden).toBe(true);
      expect(fixture.planned.trigger.attrs['aria-expanded']).toBe('true');
      expect(fixture.published.trigger.attrs['aria-expanded']).toBe('false');
      expect(fixture.planned.panel.children.length).toBeGreaterThan(0);

      fixture.published.trigger.dispatch('click');
      expect(fixture.planned.panel.hidden).toBe(true);
      expect(fixture.planned.trigger.attrs['aria-expanded']).toBe('false');
      expect(fixture.published.panel.hidden).toBe(false);
      expect(fixture.published.trigger.attrs['aria-expanded']).toBe('true');
    } finally {
      fixture.restoreDocument();
    }
  });

  it('closes an open calendar without outside-click focus theft', () => {
    const fixture = makeDatePickerScope();
    try {
      enhanceDatePickers(fixture.scope);
      fixture.planned.trigger.dispatch('click');
      expect(fixture.planned.panel.hidden).toBe(false);

      const outside = { parentElement: null, parentNode: null };
      fixture.documentStub.activeElement = outside;
      globalThis.document.dispatch('click', outside);

      expect(fixture.planned.panel.hidden).toBe(true);
      expect(fixture.planned.trigger.attrs['aria-expanded']).toBe('false');
      expect(fixture.planned.trigger.focused).toBeUndefined();
      expect(fixture.documentStub.activeElement).toBe(outside);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('closes on Escape inside the panel and refocuses the trigger', () => {
    const fixture = makeDatePickerScope();
    try {
      enhanceDatePickers(fixture.scope);
      fixture.planned.trigger.dispatch('click');
      const escapeEvent = fixture.planned.panel.dispatch('keydown', { key: 'Escape' });

      expect(escapeEvent.defaultPrevented).toBe(true);
      expect(fixture.planned.panel.hidden).toBe(true);
      expect(fixture.planned.trigger.focused.value).toBe(true);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('navigates previous and next month without submitting anything', () => {
    const fixture = makeDatePickerScope({ plannedValue: '2025-06-15' });
    try {
      enhanceDatePickers(fixture.scope);
      fixture.planned.trigger.dispatch('click');

      const monthTitle = () => fixture.planned.panel.querySelector('.date-picker-month-title');
      expect(monthTitle().textContent).toContain('June');

      const prevButton = fixture.planned.panel.querySelector('.date-picker-prev');
      prevButton.dispatch('click');
      expect(monthTitle().textContent).toContain('May');

      const nextButton = fixture.planned.panel.querySelector('.date-picker-next');
      nextButton.dispatch('click');
      expect(monthTitle().textContent).toContain('June');

      // No form submission occurs from month navigation buttons.
      expect(fixture.listeners.some((entry) => entry.type === 'submit')).toBe(false);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('selecting a day updates only the corresponding input with exact YYYY-MM-DD and closes', () => {
    const fixture = makeDatePickerScope({ plannedValue: '', publishedValue: '' });
    try {
      enhanceDatePickers(fixture.scope);
      fixture.published.trigger.dispatch('click');

      const dayButton = fixture.published.panel.querySelectorAll('.date-picker-day')
        .find((day) => !day.classList.contains('is-out-of-month') && !day.disabled);
      expect(dayButton).not.toBeUndefined();
      const selectedIso = dayButton.getAttribute('data-date');
      expect(selectedIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      dayButton.dispatch('click');

      expect(fixture.published.input.value).toBe(selectedIso);
      expect(fixture.planned.input.value).toBe('');
      expect(fixture.published.input.dispatched.map((e) => e.type)).toEqual(['input', 'change']);
      expect(fixture.published.panel.hidden).toBe(true);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('clear removes the value, dispatches events, and closes the calendar', () => {
    const fixture = makeDatePickerScope({ plannedValue: '2024-03-10' });
    try {
      enhanceDatePickers(fixture.scope);
      fixture.planned.trigger.dispatch('click');
      const clearButton = fixture.planned.panel.querySelector('.date-picker-clear');
      clearButton.dispatch('click');

      expect(fixture.planned.input.value).toBe('');
      expect(fixture.planned.input.dispatched.map((e) => e.type)).toEqual(['input', 'change']);
      expect(fixture.planned.panel.hidden).toBe(true);
      expect(fixture.planned.trigger.focused.value).toBe(true);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('keeps mobile date and time panels explicitly inside the viewport', () => {
    const css = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)),
      'utf8',
    );
    const narrowPanelRule = css.match(
      /@media\s*\(max-width:\s*767px\)\s*\{\s*\.date-picker-panel\s*\{([^}]*)\}/,
    );

    expect(narrowPanelRule).not.toBeNull();
    expect(narrowPanelRule[1]).toMatch(/position:\s*fixed/);
    expect(narrowPanelRule[1]).toMatch(/top:\s*var\(--space-md\)/);
    expect(narrowPanelRule[1]).toMatch(/max-height:\s*calc\(100vh\s*-\s*2\s*\*\s*var\(--space-md\)\)/);
    expect(narrowPanelRule[1]).toMatch(/overflow-y:\s*auto/);
    expect(narrowPanelRule[1]).not.toMatch(/top:\s*calc\(100%/);
  });

  it('keeps lower and upper calendar navigation safely bounded', () => {
    for (const { value, title, direction, previousBoundary } of [
      { value: '1000-01-15', title: 'January 1000', direction: 'prev', previousBoundary: true },
      { value: '9999-12-15', title: 'December 9999', direction: 'next', previousBoundary: false },
    ]) {
      const fixture = makeDatePickerScope({ plannedValue: value });
      try {
        enhanceDatePickers(fixture.scope);

        expect(() => fixture.planned.trigger.dispatch('click')).not.toThrow();
        expect(fixture.planned.panel.querySelector('.date-picker-month-title').textContent).toContain(title);
        expect(fixture.planned.panel.querySelector(`.date-picker-${direction}`).disabled).toBe(true);

        const outOfMonthCells = fixture.planned.panel.querySelectorAll('.date-picker-day')
          .filter((cell) => cell.classList.contains('is-out-of-month'));
        expect(outOfMonthCells.every((cell) => !cell.getAttribute('aria-label').includes('undefined'))).toBe(true);
        if (previousBoundary) {
          const unavailable = outOfMonthCells
            .filter((cell) => cell.getAttribute('aria-label')?.includes('previous month'));
          expect(unavailable.length).toBeGreaterThan(0);
          expect(unavailable.every((cell) => cell.disabled
            && cell.getAttribute('aria-disabled') === 'true')).toBe(true);
        }
      } finally {
        fixture.restoreDocument();
      }
    }
  });

  it('shows 12-hour choices and initializes an existing afternoon value', () => {
    const fixture = makeDatePickerScope({ timeValue: '13:05', clockFormat: '12h' });
    try {
      enhanceTimePickers(fixture.scope);
      fixture.time.trigger.dispatch('click');
      const options = fixture.time.panel.querySelectorAll('.time-picker-option');
      expect(options.filter((option) => option.hasAttribute('data-time-hour')).map((option) => option.textContent))
        .toEqual(Array.from({ length: 12 }, (_, hour) => String(hour + 1)));
      expect(options.filter((option) => option.hasAttribute('data-time-period')).map((option) => option.textContent))
        .toEqual(['AM', 'PM']);
      expect(fixture.time.panel.querySelector('.date-picker-month-title').textContent).toBe('1:05 PM');
      expect(options.find((option) => option.getAttribute('data-time-hour') === '1').getAttribute('aria-pressed')).toBe('true');
      expect(options.find((option) => option.getAttribute('data-time-period') === 'PM').getAttribute('aria-pressed')).toBe('true');
      expect(fixture.time.input.value).toBe('13:05');
      expect(fixture.time.input.dispatched).toHaveLength(0);
    } finally {
      fixture.restoreDocument();
    }
  });

  it.each([
    [12, 'AM', '00:05', '12:05 AM'],
    [9, 'AM', '09:05', '9:05 AM'],
    [12, 'PM', '12:05', '12:05 PM'],
    [1, 'PM', '13:05', '1:05 PM'],
    [11, 'PM', '23:05', '11:05 PM'],
  ])('writes %i:05 %s as canonical %s', (hour, period, canonical, visible) => {
    const fixture = makeDatePickerScope({ timeValue: '00:05', clockFormat: '12h' });
    try {
      enhanceTimePickers(fixture.scope);
      fixture.time.trigger.dispatch('click');
      fixture.time.panel.querySelectorAll('.time-picker-option')
        .find((option) => option.getAttribute('data-time-hour') === String(hour)).dispatch('click');
      fixture.time.panel.querySelectorAll('.time-picker-option')
        .find((option) => option.getAttribute('data-time-period') === period).dispatch('click');
      expect(fixture.time.input.type).toBe('time');
      expect(fixture.time.input.value).toBe(canonical);
      expect(fixture.time.panel.querySelector('.date-picker-month-title').textContent).toBe(visible);
      expect(fixture.time.input.dispatched.map((event) => event.type))
        .toEqual(['input', 'change', 'input', 'change']);
    } finally {
      fixture.restoreDocument();
    }
  });

  it('marks today and selected day with appropriate classes and aria attributes', () => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const fixture = makeDatePickerScope({ plannedValue: iso });
    try {
      enhanceDatePickers(fixture.scope);
      fixture.planned.trigger.dispatch('click');
      const selected = fixture.planned.panel.querySelector('.date-picker-day.is-selected');
      const todayCell = fixture.planned.panel.querySelector('.date-picker-day.is-today');
      expect(selected).not.toBeNull();
      expect(selected.getAttribute('data-date')).toBe(iso);
      expect(selected.getAttribute('aria-selected')).toBe('true');
      expect(todayCell).not.toBeNull();
      expect(todayCell.getAttribute('aria-current')).toBe('date');

      const roles = fixture.planned.panel.querySelectorAll('[role]').map((node) => node.getAttribute('role'));
      expect(roles).not.toContain('grid');
      expect(roles).not.toContain('row');
      expect(roles).not.toContain('gridcell');
      expect(roles).not.toContain('columnheader');
    } finally {
      fixture.restoreDocument();
    }
  });

  it('scopes native scheduling picker-indicator hiding to the enhanced controls', () => {
    const css = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)),
      'utf8',
    );

    for (const pseudo of ['-webkit-calendar-picker-indicator', '-moz-calendar-picker-indicator']) {
      const rules = css
        .split('}')
        .map((rule) => `${rule}}`)
        .filter((rule) => rule.includes(`::${pseudo}`));
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((rule) => rule.includes('.scheduling-section'))).toBe(true);
      expect(rules.every((rule) => /display:\s*none/.test(rule))).toBe(true);
    }
  });

  it('uses shared visual picker primitives while keeping date and time hooks separate', () => {
    const css = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)),
      'utf8',
    );

    expect(css).toMatch(/\.picker-control\s*\{/);
    expect(css).toMatch(/\.scheduling-field \.picker-input-row\s*\{[^}]*position:\s*relative;[^}]*border:/);
    expect(css).toMatch(/\.picker-trigger\s*\{[^}]*position:\s*absolute;/);
    expect(css).toMatch(/\.picker-option\s*\{/);
    expect(css).toMatch(/\.time-picker-options\s*\{/);
    expect(css).toMatch(/\.time-picker-column\s*\{[^}]*overflow-y:\s*auto;/);
    expect(css).toMatch(/\.time-picker-column::\-webkit-scrollbar\s*\{/);
    expect(css).not.toMatch(/\.date-picker\s*,\s*\.time-picker/);
    expect(css).not.toMatch(/\.time-picker\s*\{/);
  });
});

function makeNotesEditorFixture(value = '') {
  const formListeners = [];
  const textareaAttributes = new Map();
  const textarea = {
    value,
    hidden: false,
    setAttribute(name, attributeValue) {
      textareaAttributes.set(name, String(attributeValue));
    },
  };
  const host = {
    listeners: [],
    addEventListener(type, handler) {
      this.listeners.push({ type, handler });
    },
  };
  const form = {
    dataset: {},
    listeners: formListeners,
    querySelector(selector) {
      if (selector === '[data-notes-editor-host]') return host;
      if (selector === '[data-notes-editor-source]') return textarea;
      return null;
    },
    addEventListener(type, handler) {
      formListeners.push({ type, handler });
    },
  };
  const scope = {
    querySelectorAll(selector) {
      expect(selector).toBe('[data-notes-editor-form]');
      return [form];
    },
  };

  return { form, host, scope, textarea, textareaAttributes };
}

function makeToastUiEditorStub() {
  const instances = [];
  class FakeEditor {
    constructor(options) {
      this.options = options;
      this.markdown = '';
      this.getMarkdownCalls = 0;
      this.setMarkdownCalls = [];
      this.removeHookCalls = [];
      this.destroyCalls = 0;
      instances.push(this);
    }

    getMarkdown() {
      this.getMarkdownCalls += 1;
      return this.markdown;
    }

    setMarkdown(markdown, cursorToEnd) {
      this.markdown = markdown;
      this.setMarkdownCalls.push([markdown, cursorToEnd]);
    }

    removeHook(name) {
      this.removeHookCalls.push(name);
    }

    destroy() {
      this.destroyCalls += 1;
    }
  }

  FakeEditor.instances = instances;
  return FakeEditor;
}

function makeNotesCodeFixture(codeTexts = []) {
  const buttons = [];
  let createElementCalls = 0;
  const document = {
    createElement(tagName) {
      expect(tagName).toBe('button');
      createElementCalls++;
      const button = {
        dataset: {},
        attributes: {},
        disabled: false,
        listeners: [],
        textContent: '',
        type: '',
        className: '',
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        addEventListener(type, handler) {
          this.listeners.push({ type, handler });
        },
        async dispatch(type) {
          const results = this.listeners
            .filter((listener) => listener.type === type)
            .map((listener) => listener.handler({ type, target: this }));
          await Promise.all(results);
        },
      };
      buttons.push(button);
      return button;
    },
  };

  const blocks = codeTexts.map((text, index) => {
    const pre = {
      children: [],
      classList: {
        values: new Set(),
        add(name) { this.values.add(name); },
        contains(name) { return this.values.has(name); },
      },
      querySelector(selector) {
        if (selector !== '.notes-code-copy') return null;
        return this.children.find((child) => child.className.includes('notes-code-copy')) || null;
      },
      insertBefore(child, reference) {
        child.parentElement = this;
        child.parentNode = this;
        const childIndex = reference ? this.children.indexOf(reference) : -1;
        if (childIndex === -1) this.children.push(child);
        else this.children.splice(childIndex, 0, child);
        return child;
      },
    };
    Object.defineProperty(pre, 'firstChild', {
      get() { return this.children[0] || null; },
    });

    const code = {
      className: index === 0 ? 'language-javascript' : '',
      ownerDocument: document,
      parentElement: pre,
      parentNode: pre,
      textContent: text,
    };
    pre.children.push(code);
    return { pre, code };
  });

  return {
    blocks,
    buttons,
    document,
    get createElementCalls() {
      return createElementCalls;
    },
    scope: {
      querySelectorAll(selector) {
        expect(selector).toBe('.notes-content pre > code');
        return blocks.map(({ code }) => code);
      },
    },
  };
}

async function withNavigator(navigator, callback) {
  vi.stubGlobal('navigator', navigator);
  try {
    return await callback();
  } finally {
    vi.unstubAllGlobals();
  }
}

function makeEditorLoader(Editor) {
  let calls = 0;
  return {
    loadEditor() {
      calls += 1;
      return Promise.resolve(Editor);
    },
    get calls() {
      return calls;
    },
  };
}

async function settleNotesEditorImport() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Notes rendered code-block enhancement', () => {
  it('adds one accessible Copy button per rendered block and remains exact-once after re-enhancement', async () => {
    const fixture = makeNotesCodeFixture(['const value = 1;\n', 'plain text\n']);
    const writeText = vi.fn();

    await withNavigator({ clipboard: { writeText } }, async () => {
      expect(enhanceNotesCodeBlocks(fixture.scope)).toBe(2);
      expect(enhanceNotesCodeBlocks(fixture.scope)).toBe(2);
      expect(fixture.createElementCalls).toBe(2);
      expect(fixture.buttons).toHaveLength(2);
      fixture.blocks.forEach(({ pre }) => {
        expect(pre.children.filter((child) => child.className?.includes('notes-code-copy'))).toHaveLength(1);
      });
      fixture.buttons.forEach((button) => {
        expect(button.type).toBe('button');
        expect(button.className).toContain('notes-code-copy');
        expect(button.getAttribute('aria-label')).toBe('Copy code');
        expect(button.textContent).toBe('Copy');
      });
      expect(fixture.blocks.every(({ pre }) => pre.classList?.contains?.('notes-code-block-enhanced'))).toBe(true);

      const secondPre = fixture.blocks[1].pre;
      const secondCopyButtons = secondPre.children
        .filter((child) => child.className?.includes('notes-code-copy'));
      expect(secondCopyButtons).toHaveLength(1);
      const [secondCopyButton] = secondCopyButtons;
      expect(secondCopyButton.parentNode).toBe(secondPre);
      expect(fixture.blocks[0].code.textContent).not.toBe(fixture.blocks[1].code.textContent);

      await secondCopyButton.dispatch('click');
      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith(fixture.blocks[1].code.textContent);
    });
  });

  it('does nothing when no fenced block exists', () => {
    const fixture = makeNotesCodeFixture();

    expect(enhanceNotesCodeBlocks(fixture.scope)).toBe(0);
    expect(fixture.createElementCalls).toBe(0);
    expect(fixture.buttons).toHaveLength(0);
  });

  it('copies exact whitespace and temporarily reports success before restoring Copy', async () => {
    vi.useFakeTimers();
    const exactText = '  <br>\n\nconst value = 1;\n';
    const writeText = vi.fn(() => Promise.resolve());
    const fixture = makeNotesCodeFixture([exactText]);

    try {
      await withNavigator({ clipboard: { writeText } }, async () => {
        enhanceNotesCodeBlocks(fixture.scope);
        const [button] = fixture.buttons;
        await button.dispatch('click');

        expect(writeText).toHaveBeenCalledOnce();
        expect(writeText).toHaveBeenCalledWith(exactText);
        expect(button.textContent).toBe('Copied');
        expect(button.getAttribute('aria-label')).toBe('Code copied');

        vi.advanceTimersByTime(1200);
        expect(button.textContent).toBe('Copy');
        expect(button.getAttribute('aria-label')).toBe('Copy code');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables the trusted button when Clipboard API is unavailable', async () => {
    const fixture = makeNotesCodeFixture(['fallback\n']);

    await withNavigator({}, async () => {
      enhanceNotesCodeBlocks(fixture.scope);
      const [button] = fixture.buttons;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('title')).toContain('unavailable');
    });
  });

  it('reports a failed Clipboard API write and restores the Copy state', async () => {
    vi.useFakeTimers();
    const fixture = makeNotesCodeFixture(['failure\n']);
    const writeText = vi.fn(() => Promise.reject(new Error('clipboard denied')));

    try {
      await withNavigator({ clipboard: { writeText } }, async () => {
        enhanceNotesCodeBlocks(fixture.scope);
        const [button] = fixture.buttons;
        await button.dispatch('click');

        expect(writeText).toHaveBeenCalledWith('failure\n');
        expect(button.textContent).toBe('Copy failed');
        expect(button.getAttribute('aria-label')).toBe('Copy code failed');
        vi.advanceTimersByTime(1200);
        expect(button.textContent).toBe('Copy');
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Notes editor progressive enhancement', () => {
  it('no-ops when the Notes editor target is absent', () => {
    const Editor = makeToastUiEditorStub();
    const loader = makeEditorLoader(Editor);
    const scope = {
      querySelectorAll(selector) {
        expect(selector).toBe('[data-notes-editor-form]');
        return [];
      },
    };

    expect(enhanceNotesEditor(scope, loader)).toBe(0);
    expect(loader.calls).toBe(0);
    expect(Editor.instances).toHaveLength(0);
  });

  it('starts in WYSIWYG mode with Markdown switching, focused formatting, disabled telemetry, and no image support', async () => {
    const Editor = makeToastUiEditorStub();
    const loader = makeEditorLoader(Editor);
    const initialMarkdown = '# Existing\n\n**source**';
    const fixture = makeNotesEditorFixture(initialMarkdown);

    expect(enhanceNotesEditor(fixture.scope, loader)).toBe(1);
    await settleNotesEditorImport();

    const [editor] = Editor.instances;
    expect(editor.options.el).toBe(fixture.host);
    expect(editor.options.initialValue).toBe(initialMarkdown);
    expect(editor.options.initialEditType).toBe('wysiwyg');
    expect(editor.options.hideModeSwitch).toBe(false);
    expect(editor.options.usageStatistics).toBe(false);
    expect(editor.options.toolbarItems.flat()).toEqual(expect.arrayContaining([
      'heading',
      'bold',
      'italic',
      'strike',
      'quote',
      'ul',
      'ol',
      'task',
      'link',
      'table',
      'code',
      'codeblock',
    ]));
    expect(editor.options.toolbarItems.flat()).not.toContain('image');
    expect(editor.options.hooks).toBeUndefined();
    expect(editor.removeHookCalls).toEqual(['addImageBlobHook']);
    expect(fixture.textarea.hidden).toBe(true);
    expect(fixture.textareaAttributes.get('hidden')).toBe('');
  });

  it('synchronizes one authoritative Markdown value at submit time after re-enhancement', async () => {
    const Editor = makeToastUiEditorStub();
    const loader = makeEditorLoader(Editor);
    const fixture = makeNotesEditorFixture('initial source');

    expect(enhanceNotesEditor(fixture.scope, loader)).toBe(1);
    expect(enhanceNotesEditor(fixture.scope, loader)).toBe(1);
    expect(loader.calls).toBe(1);
    await settleNotesEditorImport();
    expect(loader.calls).toBe(1);
    expect(Editor.instances).toHaveLength(1);

    expect(enhanceNotesEditor(fixture.scope, loader)).toBe(1);
    await settleNotesEditorImport();
    expect(loader.calls).toBe(1);
    expect(Editor.instances).toHaveLength(1);

    const [editor] = Editor.instances;
    editor.markdown = '## WYSIWYG result\n\n- item';

    fixture.form.listeners
      .filter((listener) => listener.type === 'submit')
      .forEach((listener) => listener.handler());

    expect(editor.getMarkdownCalls).toBe(1);
    expect(fixture.textarea.value).toBe('## WYSIWYG result\n\n- item');
  });

  it('exposes live Markdown immediately and applies resets safely before or after async initialization', async () => {
    const Editor = makeToastUiEditorStub();
    let resolveEditor;
    const fixture = makeNotesEditorFixture('initial source');
    enhanceNotesEditor(fixture.scope, {
      loadEditor: () => new Promise(resolve => { resolveEditor = resolve; }),
    });

    expect(fixture.form.__creatorCrateNotesEditor.getMarkdown()).toBe('initial source');
    fixture.form.__creatorCrateNotesEditor.resetMarkdown('changed before load');
    resolveEditor(Editor);
    await settleNotesEditorImport();

    const [editor] = Editor.instances;
    expect(editor.options.initialValue).toBe('changed before load');
    editor.markdown = 'live editor value';
    expect(fixture.form.__creatorCrateNotesEditor.getMarkdown()).toBe('live editor value');

    fixture.form.__creatorCrateNotesEditor.resetMarkdown('discarded baseline');
    expect(fixture.textarea.value).toBe('discarded baseline');
    expect(editor.setMarkdownCalls).toEqual([['discarded baseline', false]]);
    expect(fixture.form.__creatorCrateNotesEditor.getMarkdown()).toBe('discarded baseline');
  });

  it('keeps the Markdown textarea usable when the editor import fails', async () => {
    const fixture = makeNotesEditorFixture('fallback source');
    const warnings = [];
    const originalWarn = globalThis.console.warn;
    globalThis.console.warn = (...args) => warnings.push(args);

    try {
      expect(enhanceNotesEditor(fixture.scope, {
        loadEditor: () => Promise.reject(new Error('import failed')),
      })).toBe(1);
      await settleNotesEditorImport();
    } finally {
      globalThis.console.warn = originalWarn;
    }

    expect(fixture.textarea.hidden).toBe(false);
    expect(fixture.textarea.value).toBe('fallback source');
    expect(warnings).toHaveLength(1);
  });
});
