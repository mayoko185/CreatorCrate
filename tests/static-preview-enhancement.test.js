import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  enhancePreview,
  enhancePreviewMedia,
  enhanceProjectCards,
  enhanceAutoSubmit,
  enhanceCategoryReorder,
  enhanceCategoryDetails,
  enhanceConfirmations,
  enhanceAssetSelection,
  enhanceAssetRenames,
  enhanceAssetGridSize,
  enhanceProjectGridSize,
  enhanceAssetProjectFilter,
  enhanceProjectAssetCategoryFilter,
  enhanceAssetViewerFilterDisclosures,
  enhanceAssetViewerInfoCards,
  enhanceProjectInfoCards,
} from '../src/static/creatorcrate.js';

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

function makeProjectCardFixture({ variant = 'grid' } = {}) {
  const card = makeProjectDomNode({
    tagName: 'article',
    attributes: { class: `project-card project-card--${variant}` },
  });
  const link = makeProjectDomNode({ tagName: 'a', parent: card });
  const metadataRow = makeProjectDomNode({ tagName: 'div', parent: card });
  const metadataValue = makeProjectDomNode({ tagName: 'span', parent: metadataRow });
  const blank = makeProjectDomNode({ tagName: 'div', parent: card });
  const secondaryLink = makeProjectDomNode({ tagName: 'a', parent: card });
  const patreonLink = makeProjectDomNode({
    tagName: 'a',
    parent: card,
    attributes: {
      href: 'https://www.patreon.com/creator',
      target: '_blank',
      rel: 'noopener noreferrer',
    },
  });
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
    patreonLink,
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
  const root = makeElement({ dataset: { previewState: 'loading' } });
  root.querySelector = (selector) => {
    if (selector === '[data-preview-image]') return image;
    if (selector === '[data-preview-fallback]') return fallback;
    return null;
  };
  return { root, image, fallback, previewLink };
}

describe('static preview enhancement helpers', () => {
  it('handles cached success with the final loaded state', () => {
    const { root, image, fallback } = makePreview({ complete: true, naturalWidth: 128 });

    expect(enhancePreview(root)).toBe('loaded');

    expect(root.dataset.previewState).toBe('loaded');
    expect(root.dataset.previewState).not.toBe('loading');
    expect(image.hidden).toBe(false);
    expect(fallback.hidden).toBe(true);
    expect(image.listeners).toEqual([]);
  });

  it('handles load success without announcements or focus changes', () => {
    const { root, image, fallback } = makePreview();

    expect(enhancePreview(root)).toBe('listening');
    expect(image.listeners.map((listener) => listener.type)).toEqual(['load', 'error']);
    expect(image.listeners.every((listener) => listener.options.once === true)).toBe(true);

    image.dispatch('load');

    expect(root.dataset.previewState).toBe('loaded');
    expect(root.dataset.previewState).not.toBe('loading');
    expect(image.hidden).toBe(false);
    expect(fallback.hidden).toBe(true);
  });

  it('handles image errors by hiding the image and revealing the fallback', () => {
    const { root, image, fallback } = makePreview();

    enhancePreview(root);
    image.dispatch('error');

    expect(root.dataset.previewState).toBe('failed');
    expect(root.dataset.previewState).not.toBe('loading');
    expect(image.hidden).toBe(true);
    expect(fallback.hidden).toBe(false);
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
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.js', import.meta.url)),
      'utf8'
    );

    expect(source).not.toMatch(/innerHTML/i);
  });

  it('uses only browser-local storage for the presentation preference', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.js', import.meta.url)),
      'utf8'
    );

    expect(source).toMatch(/localStorage/);
    expect(source).not.toMatch(/sessionStorage|XMLHttpRequest/i);
    expect(source).toMatch(/fetch\(/i);
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

  it('activates blank space and metadata in a list row while keeping Patreon independent', () => {
    const fixture = makeProjectCardFixture({ variant: 'list' });
    enhanceProjectCards(makeScope([fixture.card]));

    fixture.card.dispatch('click', { target: fixture.blank });
    fixture.card.dispatch('click', { target: fixture.metadataValue });
    const patreonEvent = fixture.card.dispatch('click', { target: fixture.patreonLink });

    expect(fixture.linkActivations).toBe(2);
    expect(patreonEvent.defaultPrevented).toBe(false);
  });

  it('does not navigate for secondary links, buttons, forms, or controls', () => {
    const fixture = makeProjectCardFixture();
    enhanceProjectCards(makeScope([fixture.card]));

    for (const target of fixture.interactive) {
      fixture.card.dispatch('click', { target });
    }

    expect(fixture.linkActivations).toBe(0);
  });

  it('leaves a Patreon anchor native and independent from project navigation', () => {
    const fixture = makeProjectCardFixture();
    enhanceProjectCards(makeScope([fixture.card]));

    const event = fixture.card.dispatch('click', { target: fixture.patreonLink });

    expect(event.defaultPrevented).toBe(false);
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
    const gridFixture = makeProjectCardFixture({ variant: 'grid' });
    const listFixture = makeProjectCardFixture({ variant: 'list' });
    const scope = makeScope([gridFixture.card, listFixture.card]);

    expect(enhanceProjectCards(scope)).toBe(2);
    expect(enhanceProjectCards(scope)).toBe(2);
    expect(gridFixture.card.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
    expect(listFixture.card.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);

    gridFixture.card.dispatch('click', { target: gridFixture.blank });
    listFixture.card.dispatch('click', { target: listFixture.blank });
    expect(gridFixture.linkActivations).toBe(1);
    expect(listFixture.linkActivations).toBe(1);

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
    this.form = form;
    const values = {
      _csrf: [form.csrfToken || 'csrf-token'],
    };
    if (form.control) values.enabled = ['0', ...(form.control.checked ? ['1'] : [])];
    const orderInput = form.querySelector?.('[data-category-order-input]');
    if (orderInput) values.orderedCategoryIds = [orderInput.value || ''];
    this.values = values;
  }

  getAll(name) {
    return this.values[name] || [];
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
      return child;
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

describe('project category reorder enhancement', () => {
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

  it('keeps Project and Settings reorder endpoints, CSRF sources, and confirmed state independent', async () => {
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

      project.items[0].handle.dispatch('keydown', { key: 'End' });
      await flushAsync();
      expect(requests).toHaveLength(3);
      requests[2].resolve({ ok: false, status: 409 });
      await flushAsync();

      expect(project.order()).toEqual(['2', '1', '3']);
      expect(settings.order()).toEqual(['42', '41']);
    });
  });

  it('starts a drag from blank, title, and slug surfaces while the handle remains available', () => {
    const fixture = makeCategoryReorderFixture();
    const title = makeCategoryNode({ tagName: 'span' });
    const slug = makeCategoryNode({ tagName: 'code' });
    [title, slug].forEach((surface) => fixture.items[0].appendChild(surface));
    enhanceCategoryReorder(fixture.document);

    for (const target of [fixture.items[0], title, slug]) {
      fixture.items[0].dispatch('pointerdown', { target });
      const event = fixture.items[0].dispatch('dragstart', {
        target,
        dataTransfer: { setData() {} },
      });
      expect(event.defaultPrevented).toBe(false);
      fixture.items[0].dispatch('dragend');
    }

    fixture.items[0].dispatch('pointerdown', { target: fixture.items[0].handle });
    const handleDrag = fixture.items[0].dispatch('dragstart', {
      target: fixture.items[0].handle,
      dataTransfer: { setData() {} },
    });
    expect(handleDrag.defaultPrevented).toBe(false);
    expect(fixture.items[0].classList.contains('is-dragging')).toBe(true);
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

  it('does not start a drag from interactive descendants, selected text, or helper/error content', () => {
    const fixture = makeCategoryReorderFixture();
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
    [input, button, label, link, help, error, alert, live, editable, noscript]
      .forEach((control) => fixture.items[0].appendChild(control));
    enhanceCategoryReorder(fixture.document);

    for (const target of [input, button, label, link, help, error, alert, live, editable, noscript]) {
      fixture.items[0].dispatch('pointerdown', { target });
      const event = fixture.items[0].dispatch('dragstart', { target, dataTransfer: { setData() {} } });
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('starts a drag from a form wrapper and its non-interactive field area (Settings card), but not from the form controls', () => {
    const fixture = makeCategoryReorderFixture();
    // Mirrors the Settings card, whose display-name/slug fields are wrapped in a
    // single <form> (for "Save details"). The form wrapper and its field
    // container must stay draggable — otherwise the bulk of the card is dead to
    // drag and only the handle works (the project card, whose fields aren't in a
    // form, does not have this problem). The actual controls stay excluded.
    const form = makeCategoryNode({ tagName: 'form' });
    const fieldArea = makeCategoryNode({ className: 'category-management-card-fields' });
    const fieldInput = makeCategoryNode({ tagName: 'input' });
    const saveButton = makeCategoryNode({ tagName: 'button' });
    fixture.items[0].appendChild(form);
    form.appendChild(fieldArea);
    fieldArea.appendChild(fieldInput);
    form.appendChild(saveButton);
    enhanceCategoryReorder(fixture.document);

    for (const target of [form, fieldArea]) {
      fixture.items[0].dispatch('pointerdown', { target });
      const event = fixture.items[0].dispatch('dragstart', { target, dataTransfer: { setData() {} } });
      expect(event.defaultPrevented).toBe(false);
    }
    for (const target of [fieldInput, saveButton]) {
      fixture.items[0].dispatch('pointerdown', { target });
      const event = fixture.items[0].dispatch('dragstart', { target, dataTransfer: { setData() {} } });
      expect(event.defaultPrevented).toBe(true);
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
    boundary.items[2].handle.dispatch('keydown', { key: 'End' });
    expect(boundary.order()).toEqual(['1', '2', '3']);
    expect(boundary.submitCount).toBe(0);
  });

  it('is idempotent and restores the confirmed order, ARIA positions, and keyboard focus after failure', async () => {
    const fixture = makeCategoryReorderFixture();
    const calls = [];

    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: false, status: 503 };
    }, async () => {
      expect(enhanceCategoryReorder(fixture.document)).toBe(1);
      expect(enhanceCategoryReorder(fixture.document)).toBe(1);
      expect(fixture.items[1].handle.listeners.filter((listener) => listener.type === 'keydown')).toHaveLength(1);
      expect(fixture.list.listeners.filter((listener) => listener.type === 'dragover')).toHaveLength(1);

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
function makeAssetSelectionForm({ enabledCheckboxes = [], selectedCount, releaseSelect, selectAll, clearSelection, bulkSubmit } = {}) {
  const singles = {
    '[data-selected-count]': selectedCount ?? makeControl(),
    '[data-release-select]': releaseSelect ?? makeControl(),
    '[data-select-all]': selectAll ?? makeControl(),
    '[data-clear-selection]': clearSelection ?? makeControl(),
    '[data-bulk-submit]': bulkSubmit ?? makeControl(),
  };
  return {
    querySelectorAll(selector) {
      if (selector.includes('selectedAssetIds')) return enabledCheckboxes;
      return [];
    },
    querySelector(selector) {
      return singles[selector] || null;
    },
    _singles: singles,
  };
}

function makeAssetSelectionScope(form, cards = []) {
  return {
    querySelectorAll(selector) {
      if (selector === '[data-asset-selection-form]') return [form];
      if (selector.includes('selectedAssetIds')) return form.querySelectorAll(selector);
      if (selector === '[data-asset-selectable-card]') return cards;
      return [];
    },
  };
}

function makeDetailsFixture({ action = '/settings/asset-categories/1' } = {}) {
  const status = { textContent: '' };
  const attributes = new Map();
  const listeners = [];
  const form = {
    action,
    method: 'post',
    csrfToken: 'csrf-details',
    dataset: {},
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
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
  return { form, status, attributes };
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

  it('saves in place on a redirected response without navigating, and binds once', async () => {
    const fixture = makeDetailsFixture({ action: '/settings/asset-categories/9' });
    const calls = [];
    await withBrowserGlobals(async (action, options) => {
      calls.push({ action, options });
      return { ok: true, redirected: true, status: 200 };
    }, async () => {
      const scope = { querySelectorAll: () => [fixture.form] };
      expect(enhanceCategoryDetails(scope)).toBe(1);
      expect(enhanceCategoryDetails(scope)).toBe(1);

      const event = fixture.form.dispatch('submit');
      await flushAsync();

      expect(event.defaultPrevented).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].action).toBe('/settings/asset-categories/9');
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].options.body).toBeInstanceOf(URLSearchParams);
      expect(calls[0].options.body.getAll('_csrf')).toEqual(['csrf-details']);
      expect(fixture.form.submitCount).toBe(0);
      expect(fixture.status.textContent).toBe('Details saved.');
      expect(fixture.form.getAttribute('aria-busy')).toBe(null);
    });
  });

  it('falls back to a native submit when the response is not a redirect (validation error)', async () => {
    const fixture = makeDetailsFixture();
    await withBrowserGlobals(async () => ({ ok: false, redirected: false, status: 422 }), async () => {
      enhanceCategoryDetails({ querySelectorAll: () => [fixture.form] });
      fixture.form.dispatch('submit');
      await flushAsync();
      expect(fixture.form.submitCount).toBe(1);
    });
  });

  it('falls back to a native submit on network failure', async () => {
    const fixture = makeDetailsFixture();
    await withBrowserGlobals(async () => { throw new Error('offline'); }, async () => {
      enhanceCategoryDetails({ querySelectorAll: () => [fixture.form] });
      fixture.form.dispatch('submit');
      await flushAsync();
      expect(fixture.form.submitCount).toBe(1);
    });
  });

  it('leaves the native submit intact when fetch is unavailable', () => {
    const fixture = makeDetailsFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
      enhanceCategoryDetails({ querySelectorAll: () => [fixture.form] });
      const event = fixture.form.dispatch('submit');
      expect(event.defaultPrevented).toBe(false);
      expect(fixture.form.submitCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('page-local asset selection enhancement', () => {
  it('is scoped to [data-asset-selection-form] and no-ops when absent', () => {
    const scope = {
      querySelectorAll(selector) {
        expect(selector).toBe('[data-asset-selection-form]');
        return [];
      },
    };

    expect(() => enhanceAssetSelection(scope)).not.toThrow();
    expect(enhanceAssetSelection(scope)).toBe(0);
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

  it('updates the live selected count after a checkbox change', () => {
    const cb1 = makeCheckbox();
    const cb2 = makeCheckbox();
    const countEl = makeControl();
    const form = makeAssetSelectionForm({ enabledCheckboxes: [cb1, cb2], selectedCount: countEl });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);
    expect(countEl.textContent).toBe('0 selected');

    cb1.checked = true;
    cb1.dispatch('change');
    expect(countEl.textContent).toBe('1 selected');

    cb2.checked = true;
    cb2.dispatch('change');
    expect(countEl.textContent).toBe('2 selected');
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
    const form = makeAssetSelectionForm({
      enabledCheckboxes: [cb1], releaseSelect, bulkSubmit: submit, selectedCount: countEl,
    });
    const scope = makeAssetSelectionScope(form);

    enhanceAssetSelection(scope);

    expect(countEl.textContent).toBe('1 selected');
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

    const keydown = listeners.find((entry) => entry.type === 'keydown').handler;
    keydown({ target: card, key: 'Enter', preventDefault() {} });
    expect(checkbox.checked).toBe(false);
  });

  it('selects project list-card blank space while excluding real interactive descendants', () => {
    const selectedCount = makeControl();
    const form = makeAssetSelectionForm({ selectedCount });
    const checkbox = makeCheckbox();
    checkbox.form = form;
    const listeners = [];
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
      checkbox,
    };
    const interactiveTargets = new Set([
      mediaLink, targets.details, targets.status,
      targets.renameTrigger, targets.renameInput, targets.renameButton,
      targets.releaseLink, targets.checkbox,
    ]);
    const card = {
      className: 'asset-list-card asset-list-card--project',
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
    for (const name of ['details', 'status', 'renameTrigger', 'renameInput', 'renameButton', 'releaseLink']) {
      targets[name].closest = () => targets[name];
    }

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
    expect(selectedCount.textContent).toBe('1 selected');
    expect(card.attributes['aria-selected']).toBe('true');
    click(targets.blankMedia);
    expect(checkbox.checked).toBe(false);
    expect(selectedCount.textContent).toBe('0 selected');
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

    // The native checkbox click has already changed checked before the card's
    // bubbling handler runs; the handler must leave it alone.
    checkbox.checked = false;
    click(checkbox);
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(card.attributes['aria-selected']).toBe('true');
    expect(selectedCount.textContent).toBe('1 selected');
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

describe('Asset Viewer Project filter enhancement', () => {
  function makeProjectFilterFixture(selectedValue = '') {
    const makeInput = (value, checked = false) => {
      const listeners = [];
      return {
        value,
        checked,
        listeners,
        addEventListener(type, handler) { listeners.push({ type, handler }); },
        dispatch(type) {
          listeners.filter((listener) => listener.type === type)
            .forEach((listener) => listener.handler());
        },
      };
    };

    const makeOption = (title, value) => {
      const input = makeInput(value, value === selectedValue);
      const label = { textContent: title };
      const attrs = { 'data-project-title': title };
      return {
        input,
        label,
        hidden: false,
        attrs,
        querySelector(selector) {
          if (selector === 'input[name="project"]') return input;
          if (selector === 'label') return label;
          return null;
        },
        getAttribute(name) { return attrs[name] ?? null; },
        setAttribute(name, valueToSet) {
          attrs[name] = String(valueToSet);
          if (name === 'hidden') this.hidden = true;
        },
        removeAttribute(name) {
          delete attrs[name];
          if (name === 'hidden') this.hidden = false;
        },
      };
    };

    const all = makeOption('All projects', '');
    const alpha = makeOption('Alpha Project', '1');
    const beta = makeOption('Beta Project', '2');
    const options = [all, alpha, beta];
    const searchListeners = [];
    const search = {
      value: '',
      listeners: searchListeners,
      addEventListener(type, handler) { searchListeners.push({ type, handler }); },
      dispatch(type) {
        searchListeners.filter((listener) => listener.type === type)
          .forEach((listener) => listener.handler());
      },
    };
    const summaryText = { textContent: '' };
    const summaryAttrs = {};
    const summary = {
      setAttribute(name, value) { summaryAttrs[name] = String(value); },
    };
    const empty = {
      hidden: true,
      setAttribute(name) { if (name === 'hidden') this.hidden = true; },
      removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
    };
    const toggleListeners = [];
    const filter = {
      dataset: {},
      open: false,
      querySelector(selector) {
        if (selector === '[data-asset-project-filter-search]') return search;
        if (selector === '[data-asset-project-filter-summary]') return summaryText;
        if (selector === '[data-asset-project-filter-no-results]') return empty;
        if (selector === 'summary') return summary;
        return null;
      },
      querySelectorAll(selector) {
        return selector === '[data-asset-project-filter-option]' ? options : [];
      },
      addEventListener(type, handler) { toggleListeners.push({ type, handler }); },
      dispatchToggle(open) {
        this.open = open;
        toggleListeners.filter((listener) => listener.type === 'toggle')
          .forEach((listener) => listener.handler());
      },
    };
    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-asset-project-filter]' ? [filter] : [];
      },
    };

    return {
      scope,
      filter,
      search,
      all,
      alpha,
      beta,
      empty,
      summaryText,
      summaryAttrs,
      toggleListeners,
    };
  }

  it('filters project titles case-insensitively by partial match and restores the complete list', () => {
    const fixture = makeProjectFilterFixture();

    expect(enhanceAssetProjectFilter(fixture.scope)).toBe(1);
    expect(fixture.summaryText.textContent).toBe('All projects');
    expect(fixture.all.input.checked).toBe(true);
    expect(fixture.search.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);

    fixture.search.value = 'aLp';
    fixture.search.dispatch('input');
    expect(fixture.all.hidden).toBe(false);
    expect(fixture.alpha.hidden).toBe(false);
    expect(fixture.beta.hidden).toBe(true);
    expect(fixture.empty.hidden).toBe(true);

    fixture.search.value = 'does-not-exist';
    fixture.search.dispatch('input');
    expect(fixture.all.hidden).toBe(false);
    expect(fixture.alpha.hidden).toBe(true);
    expect(fixture.beta.hidden).toBe(true);
    expect(fixture.empty.hidden).toBe(false);

    fixture.search.value = '';
    fixture.search.dispatch('input');
    expect(fixture.alpha.hidden).toBe(false);
    expect(fixture.beta.hidden).toBe(false);
    expect(fixture.empty.hidden).toBe(true);
  });

  it('keeps the selected radio through filtering, updates the closed summary, and tracks disclosure state', () => {
    const fixture = makeProjectFilterFixture('2');

    enhanceAssetProjectFilter(fixture.scope);
    expect(fixture.summaryText.textContent).toBe('Beta Project');
    expect(fixture.beta.input.checked).toBe(true);
    expect(fixture.all.input.checked).toBe(false);
    expect(fixture.summaryAttrs['aria-label']).toBe('Project filter: Beta Project');
    expect(fixture.summaryAttrs['aria-expanded']).toBe('false');

    fixture.filter.dispatchToggle(true);
    expect(fixture.summaryAttrs['aria-expanded']).toBe('true');
    fixture.search.value = 'alpha';
    fixture.search.dispatch('input');
    expect(fixture.beta.input.checked).toBe(true);
    expect(fixture.beta.hidden).toBe(true);

    fixture.filter.dispatchToggle(false);
    expect(fixture.summaryAttrs['aria-expanded']).toBe('false');

    fixture.all.input.checked = true;
    fixture.beta.input.checked = false;
    fixture.all.input.dispatch('change');
    expect(fixture.summaryText.textContent).toBe('All projects');
    expect(fixture.summaryAttrs['aria-label']).toBe('Project filter: All projects');
    expect(fixture.alpha.input.value).toBe('1');
    expect(fixture.beta.input.value).toBe('2');
    expect(fixture.search.name).toBeUndefined();
  });
});

describe('Destructive confirmation enhancement', () => {
  it('prevents an unconfirmed data-confirm submit action', () => {
    const message = 'The selected files will be permanently deleted from disk and cannot be restored through CreatorCrate. Continue?';
    const listeners = [];
    const control = {
      getAttribute(name) {
        return name === 'data-confirm' ? message : null;
      },
      addEventListener(type, handler) {
        listeners.push({ type, handler });
      },
    };
    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-confirm]' ? [control] : [];
      },
    };
    const previousConfirm = globalThis.confirm;
    let promptedMessage = null;
    globalThis.confirm = (prompt) => {
      promptedMessage = prompt;
      return false;
    };

    try {
      expect(enhanceConfirmations(scope)).toBe(1);
      const click = listeners.find((listener) => listener.type === 'click');
      expect(click).toBeDefined();
      const event = {
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      click.handler(event);
      expect(promptedMessage).toBe(message);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      if (previousConfirm === undefined) delete globalThis.confirm;
      else globalThis.confirm = previousConfirm;
    }
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
    };
    const summaryText = { textContent: '' };
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
      dataset: {},
      querySelectorAll(selector) {
        return selector === '.asset-filter-multiselect-option'
          ? inputs.map(({ option }) => option)
          : [];
      },
      querySelector(selector) {
        if (selector === '[data-asset-category-filter-summary]') return summaryText;
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
  function makeDisclosureFixture() {
    const scopeListeners = [];
    const disclosures = [];
    const outside = { closest() { return null; } };

    for (const name of ['project', 'category', 'tag', 'extension']) {
      const summaryAttrs = {};
      const disclosure = {
        name,
        open: false,
        dataset: {},
        querySelector(selector) {
          if (selector === 'summary') return summary;
          return null;
        },
        closest(selector) {
          return selector === '[data-asset-viewer-filter-disclosure]' ? this : null;
        },
      };
      const makeInsideNode = () => ({
        closest(selector) {
          return selector === '[data-asset-viewer-filter-disclosure]' ? disclosure : null;
        },
      });
      const summary = {
        focused: false,
        attrs: summaryAttrs,
        setAttribute(nameToSet, value) { summaryAttrs[nameToSet] = String(value); },
        focus() { this.focused = true; },
        closest(selector) {
          return selector === '[data-asset-viewer-filter-disclosure]' ? disclosure : null;
        },
      };

      disclosure.summary = summary;
      disclosure.checkboxes = [makeInsideNode(), makeInsideNode()];
      disclosure.search = makeInsideNode();
      disclosures.push(disclosure);
    }

    const scope = {
      dataset: {},
      querySelectorAll(selector) {
        return selector === '[data-asset-viewer-filter-disclosure]' ? disclosures : [];
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

    return { scope, scopeListeners, disclosures, outside };
  }

  it('closes every Asset Viewer disclosure on outside click and keeps the listener set scoped and unique', () => {
    const fixture = makeDisclosureFixture();

    expect(enhanceAssetViewerFilterDisclosures(fixture.scope)).toBe(4);
    expect(enhanceAssetViewerFilterDisclosures(fixture.scope)).toBe(4);
    expect(fixture.scopeListeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(fixture.scopeListeners.filter(({ type }) => type === 'keydown')).toHaveLength(1);
    expect(fixture.scopeListeners.filter(({ type }) => type === 'toggle')).toHaveLength(1);

    for (const disclosure of fixture.disclosures) {
      disclosure.open = true;
      fixture.scope.dispatch('click', fixture.outside);
      expect(disclosure.open).toBe(false);
      expect(disclosure.summary.attrs['aria-expanded']).toBe('false');
    }
  });

  it('keeps internal multi-select clicks and Project search interaction open', () => {
    const fixture = makeDisclosureFixture();

    enhanceAssetViewerFilterDisclosures(fixture.scope);
    for (const name of ['category', 'tag', 'extension']) {
      const disclosure = fixture.disclosures.find((candidate) => candidate.name === name);
      disclosure.open = true;
      for (const checkbox of disclosure.checkboxes) {
        fixture.scope.dispatch('click', checkbox);
        expect(disclosure.open).toBe(true);
      }
    }

    const project = fixture.disclosures.find((disclosure) => disclosure.name === 'project');
    project.open = true;
    fixture.scope.dispatch('keydown', project.search, { key: 's' });
    expect(project.open).toBe(true);
  });

  it('closes the previous disclosure when another opens, toggles its own state normally, and dismisses Escape to its trigger', () => {
    const fixture = makeDisclosureFixture();
    const project = fixture.disclosures.find((disclosure) => disclosure.name === 'project');
    const category = fixture.disclosures.find((disclosure) => disclosure.name === 'category');

    enhanceAssetViewerFilterDisclosures(fixture.scope);
    project.open = true;
    fixture.scope.dispatch('click', category.summary);
    expect(project.open).toBe(false);
    expect(category.open).toBe(false);

    category.open = true;
    fixture.scope.dispatch('toggle', category);
    expect(category.open).toBe(true);
    expect(category.summary.attrs['aria-expanded']).toBe('true');

    const escapeEvent = fixture.scope.dispatch('keydown', category.search, { key: 'Escape' });
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(category.open).toBe(false);
    expect(category.summary.attrs['aria-expanded']).toBe('false');
    expect(category.summary.focused).toBe(true);
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
      dataset: { gridSizeOptionLabel: size },
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
      closest(selector) {
        return project && selector === '[data-project-grid-size-controls]' ? {} : null;
      },
    };
    return { group, slider, labels };
  }

  it('uses the current default sizing without writing a custom property', () => {
    const grid = makeGrid();
    const controls = makeGridSliderControls();
    const scope = {
      querySelectorAll(selector) {
        if (selector === '[data-asset-grid-size-controls]') return [controls.group];
        if (selector === '.asset-grid') return [grid];
        return [];
      },
    };

    expect(enhanceAssetGridSize(scope)).toBe(1);
    expect(grid.style.values).toEqual({});
    expect(controls.slider.value).toBe('2');
    expect(controls.slider.attrs['aria-valuenow']).toBe('2');
    expect(controls.slider.attrs['aria-valuetext']).toBe('Default');
    expect(controls.labels.map((option) => option.classList.values.has('is-active')))
      .toEqual([false, true, false]);
  });

  it('applies finite compact/default/large values and persists the selection across page scopes', () => {
    const grid = makeGrid();
    const controls = makeGridSliderControls();
    const storage = new Map();
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };
    try {
      const scope = {
        querySelectorAll(selector) {
          if (selector === '[data-asset-grid-size-controls]') return [controls.group];
          if (selector === '.asset-grid') return [grid];
          return [];
        },
      };

      enhanceAssetGridSize(scope);
      controls.slider.value = '3';
      controls.slider.dispatch('input');

      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
      expect(grid.attrs['data-grid-size']).toBe('large');
      expect(grid.style.values['--asset-card-min']).toBe('20rem');
      expect(controls.slider.attrs['aria-valuenow']).toBe('3');
      expect(controls.slider.attrs['aria-valuetext']).toBe('Large');

      const secondGrid = makeGrid();
      const secondControls = makeGridSliderControls();
      const secondScope = {
        querySelectorAll(selector) {
          if (selector === '[data-asset-grid-size-controls]') return [secondControls.group];
          if (selector === '.asset-grid') return [secondGrid];
          return [];
        },
      };
      enhanceAssetGridSize(secondScope);
      expect(secondGrid.style.values['--asset-card-min']).toBe('20rem');
      expect(secondControls.slider.value).toBe('3');
      expect(secondControls.slider.attrs['aria-valuetext']).toBe('Large');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('rejects an invalid stored value and falls back to the default size', () => {
    const grid = makeGrid();
    const controls = makeGridSliderControls();
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: () => 'not-supported',
      setItem() {},
    };
    try {
      const scope = {
        querySelectorAll(selector) {
          if (selector === '[data-asset-grid-size-controls]') return [controls.group];
          if (selector === '.asset-grid') return [grid];
          return [];
        },
      };

      enhanceAssetGridSize(scope);
      expect(grid.style.values).toEqual({});
      expect(controls.slider.value).toBe('2');
      expect(controls.slider.attrs['aria-valuetext']).toBe('Default');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('maps the three slider positions to the existing sizes, updates immediately, and restores the saved value', () => {
    const grid = makeGrid();
    const controls = makeGridSliderControls();
    const storage = new Map([['creatorcrate-asset-grid-size', 'compact']]);
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };

    const makeScope = (targetGrid) => ({
      querySelectorAll(selector) {
        if (selector === '[data-asset-grid-size-controls]') return [controls.group];
        if (selector === '.asset-grid') return [targetGrid];
        return [];
      },
    });

    try {
      expect(enhanceAssetGridSize(makeScope(grid))).toBe(1);
      expect(controls.slider.value).toBe('1');
      expect(controls.slider.attrs['aria-valuenow']).toBe('1');
      expect(controls.slider.attrs['aria-valuetext']).toBe('Compact');
      expect(controls.labels[0].classList.values.has('is-active')).toBe(true);

      const expected = [
        { position: '1', size: 'compact', min: '12rem', label: 'Compact' },
        { position: '2', size: 'default', min: undefined, label: 'Default' },
        { position: '3', size: 'large', min: '20rem', label: 'Large' },
      ];
      for (const { position, size, min, label } of expected) {
        controls.slider.value = position;
        controls.slider.dispatch('input');

        expect(storage.get('creatorcrate-asset-grid-size')).toBe(size);
        expect(controls.slider.attrs['aria-valuenow']).toBe(position);
        expect(controls.slider.attrs['aria-valuetext']).toBe(label);
        expect(controls.labels.map((option) => option.classList.values.has('is-active')))
          .toEqual(expected.map((entry) => entry.size === size));
        if (min) expect(grid.style.values['--asset-card-min']).toBe(min);
        else expect(grid.style.values).toEqual({});
        if (size === 'default') expect(grid.attrs['data-grid-size']).toBeUndefined();
        else expect(grid.attrs['data-grid-size']).toBe(size);
      }

      const restoredGrid = makeGrid();
      enhanceAssetGridSize(makeScope(restoredGrid));
      expect(restoredGrid.attrs['data-grid-size']).toBe('large');
      expect(restoredGrid.style.values['--asset-card-min']).toBe('20rem');
      expect(controls.slider.value).toBe('3');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('finds the Projects grid and control, maps every size, and keeps state isolated', () => {
    const assetGrid = makeGrid();
    const projectGrid = makeGrid();
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
          if (selector === '.project-grid') return [projectGrid];
          return [];
        },
      };

      expect(enhanceAssetGridSize(scope)).toBe(1);
      expect(assetGrid.style.values['--asset-card-min']).toBe('20rem');
      expect(projectGrid.style.values).toEqual({});
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');

      expect(enhanceProjectGridSize(scope)).toBe(1);
      expect(projectGrid.attrs['data-grid-size']).toBe('compact');
      expect(projectGrid.style.values['--project-card-min']).toBe('12rem');
      expect(projectGrid.style.values['--asset-card-min']).toBeUndefined();
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
        if (min) expect(projectGrid.style.values['--project-card-min']).toBe(min);
        else expect(projectGrid.style.values).toEqual({});
        if (size === 'default') expect(projectGrid.attrs['data-grid-size']).toBeUndefined();
        else expect(projectGrid.attrs['data-grid-size']).toBe(size);
      }

      assetControls.slider.value = '1';
      assetControls.slider.dispatch('input');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-project-grid-size')).toBe('large');
      expect(assetGrid.style.values['--asset-card-min']).toBe('12rem');
      expect(projectGrid.style.values['--project-card-min']).toBe('20rem');
      expect(storage.get('creatorcrate-asset-grid-size')).not.toBe(storage.get('creatorcrate-project-grid-size'));
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('applies a Projects size when the range control emits change without input', () => {
    const grid = makeGrid();
    const controls = makeGridSliderControls({ project: true });
    const storage = new Map();
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };
    try {
      const scope = {
        querySelectorAll(selector) {
          if (selector === '[data-project-grid-size-controls] [data-asset-grid-size-controls]') return [controls.group];
          if (selector === '.project-grid') return [grid];
          return [];
        },
      };

      expect(enhanceProjectGridSize(scope)).toBe(1);
      controls.slider.value = '3';
      controls.slider.dispatch('change');

      expect(storage.get('creatorcrate-project-grid-size')).toBe('large');
      expect(grid.style.values['--project-card-min']).toBe('20rem');
      expect(grid.attrs['data-grid-size']).toBe('large');
      expect(controls.slider.attrs['aria-valuetext']).toBe('Large');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('falls back to the responsive default for missing or invalid Projects storage', () => {
    for (const stored of [null, 'not-supported']) {
      const grid = makeGrid();
      const controls = makeGridSliderControls({ project: true });
      const previousStorage = globalThis.localStorage;
      globalThis.localStorage = {
        getItem: () => stored,
        setItem() {},
      };
      try {
        const scope = {
          querySelectorAll(selector) {
            if (selector === '[data-project-grid-size-controls] [data-asset-grid-size-controls]') return [controls.group];
            if (selector === '.project-grid') return [grid];
            return [];
          },
        };

        expect(enhanceProjectGridSize(scope)).toBe(1);
        expect(grid.style.values).toEqual({});
        expect(controls.slider.value).toBe('2');
        expect(controls.slider.attrs['aria-valuetext']).toBe('Default');
      } finally {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
      }
    }
  });

  it('binds Grid preview hover/focus positioning without adding a metadata trigger', () => {
    const listeners = [];
    const styleValues = {};
    const attrs = {};
    const info = {
      offsetWidth: 240,
      offsetHeight: 120,
      style: {
        setProperty(name, value) { styleValues[name] = value; },
      },
      getBoundingClientRect() {
        return { width: 240, height: 120 };
      },
      setAttribute(name, value) { attrs[name] = String(value); },
    };
    const preview = {
      dataset: {},
      querySelector(selector) {
        return selector === '[data-asset-info-card]' ? info : null;
      },
      getBoundingClientRect() {
        return { left: 900, top: 400, width: 200, height: 100, bottom: 500 };
      },
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      contains() { return true; },
      setAttribute(name, value) { attrs[name] = String(value); },
    };
    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-asset-viewer-preview]' ? [preview] : [];
      },
    };
    const previousWidth = globalThis.innerWidth;
    const previousHeight = globalThis.innerHeight;
    const previousDocument = globalThis.document;
    globalThis.innerWidth = 1000;
    globalThis.innerHeight = 700;
    globalThis.document = { documentElement: { clientWidth: 960, clientHeight: 680 } };

    try {
      expect(enhanceAssetViewerInfoCards(scope)).toBe(1);
      expect(listeners.map(({ type }) => type)).toEqual([
        'pointerenter',
        'focusin',
        'pointerleave',
        'focusout',
      ]);

      listeners.find(({ type }) => type === 'focusin').handler();

      expect(attrs['data-positioned']).toBe('true');
      expect(styleValues['--asset-info-left']).toBe('-188px');
      expect(styleValues['--asset-info-top']).toBe('108px');
    } finally {
      if (previousWidth === undefined) delete globalThis.innerWidth;
      else globalThis.innerWidth = previousWidth;
      if (previousHeight === undefined) delete globalThis.innerHeight;
      else globalThis.innerHeight = previousHeight;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  });

  it('binds Projects Grid preview information to the shared viewport edge positioning', () => {
    const listeners = [];
    const styleValues = {};
    const attrs = {};
    const info = {
      offsetWidth: 240,
      offsetHeight: 120,
      style: {
        setProperty(name, value) { styleValues[name] = value; },
      },
      getBoundingClientRect() {
        return { width: 240, height: 120 };
      },
      setAttribute(name, value) { attrs[name] = String(value); },
    };
    const preview = {
      dataset: {},
      querySelector(selector) {
        return selector === '[data-project-info-card]' ? info : null;
      },
      getBoundingClientRect() {
        return { left: 0, top: 600, width: 200, height: 100, bottom: 700 };
      },
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      contains() { return true; },
      setAttribute(name, value) { attrs[name] = String(value); },
    };
    const scope = {
      querySelectorAll(selector) {
        return selector === '[data-project-grid-preview]' ? [preview] : [];
      },
    };
    const previousWidth = globalThis.innerWidth;
    const previousHeight = globalThis.innerHeight;
    const previousDocument = globalThis.document;
    globalThis.innerWidth = 800;
    globalThis.innerHeight = 700;
    globalThis.document = { documentElement: { clientWidth: 800, clientHeight: 700 } };

    try {
      expect(enhanceProjectInfoCards(scope)).toBe(1);
      expect(listeners.map(({ type }) => type)).toEqual([
        'pointerenter',
        'focusin',
        'pointerleave',
        'focusout',
      ]);

      listeners.find(({ type }) => type === 'focusin').handler();

      expect(attrs['data-positioned']).toBe('true');
      expect(styleValues['--project-info-left']).toBe('8px');
      expect(styleValues['--project-info-top']).toBe('-128px');
    } finally {
      if (previousWidth === undefined) delete globalThis.innerWidth;
      else globalThis.innerWidth = previousWidth;
      if (previousHeight === undefined) delete globalThis.innerHeight;
      else globalThis.innerHeight = previousHeight;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  });
});
