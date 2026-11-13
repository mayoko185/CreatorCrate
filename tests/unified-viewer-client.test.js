import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { enhanceAppDialogs, openAppDialogById } from '../src/static/client/app-dialogs.js';
import {
  enhanceAssetVideoPreview,
  VIDEO_PREVIEW_DIALOG_ID,
} from '../src/static/client/asset-video-playback.js';
import {
  enhanceUnifiedViewer,
  UNIFIED_VIEWER_DIALOG_ID,
  unifiedViewerFor,
} from '../src/static/client/unified-viewer.js';
import { enhanceDropdowns } from '../src/static/client/dropdowns.js';
import {
  createSingleImageSource,
  createSlideshowSource,
  createViewerSource,
} from '../src/static/client/viewer-sequence.js';

// B2: the shared viewer dialog shell and controller. The markup is the real
// rendered partial, parsed into a purpose-built DOM shim (no jsdom in this
// project), and dialog behavior is the real shared app-dialog binder. Real
// showModal, focus containment, scroll locking and backdrop hit-testing are
// covered in Chromium (tests/browser/unified-viewer-shell.spec.js).

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

// ─── DOM shim ────────────────────────────────────────────────────────────────

function matchCompound(element, selector) {
  let rest = selector.trim();
  const tag = rest.match(/^[a-zA-Z][\w-]*/)?.[0];
  if (tag) {
    if (element.tagName !== tag.toUpperCase()) return false;
    rest = rest.slice(tag.length);
  }
  while (rest) {
    let match;
    if ((match = rest.match(/^#([\w-]+)/))) {
      if (element.getAttribute('id') !== match[1]) return false;
    } else if ((match = rest.match(/^\.([\w-]+)/))) {
      if (!element.classList.contains(match[1])) return false;
    } else if ((match = rest.match(/^\[([^\]=]+)(?:="([^"]*)")?\]/))) {
      const actual = element.getAttribute(match[1]);
      if (actual === null || (match[2] !== undefined && actual !== match[2])) return false;
    } else if ((match = rest.match(/^:not\(([^()]*)\)/))) {
      if (matchCompound(element, match[1])) return false;
    } else if ((match = rest.match(/^:checked/))) {
      // C1f: the shared dropdown reads its checked radio for the summary.
      if (element.checked !== true) return false;
    } else {
      throw new Error(`Unsupported selector in DOM shim: ${selector}`);
    }
    rest = rest.slice(match[0].length);
  }
  return true;
}

function makeElement(tagName, attrs = {}) {
  const attributes = new Map();
  const listeners = [];
  const element = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    parentElement: null,
    ownerDocument: null,
    dataset: {},
    // C1e: the spread layout writes slot/page boxes, the viewport its size.
    style: {},
    // C1f: like the DOM, an element's text includes its descendants' (the
    // shared dropdown reads its option labels this way).
    ownText: '',
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { this.ownText = String(value); },
    listeners,
    open: false,
    classList: {
      values: new Set(),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !this.values.has(name) : force;
        if (next) this.values.add(name);
        else this.values.delete(name);
        return next;
      },
      contains(name) { return this.values.has(name); },
    },
    get hidden() { return attributes.has('hidden'); },
    set hidden(value) { if (value) attributes.set('hidden', ''); else attributes.delete('hidden'); },
    get disabled() { return attributes.has('disabled'); },
    set disabled(value) {
      if (value) attributes.set('disabled', '');
      else attributes.delete('disabled');
      // Like Chromium, a focused control that becomes disabled loses focus at once.
      if (value && this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
    },
    get id() { return attributes.get('id') ?? ''; },
    get isConnected() {
      let current = this;
      while (current) {
        if (current.nodeType === 9) return true;
        current = current.parentNode;
      }
      return false;
    },
    setAttribute(name, rawValue) {
      const value = String(rawValue);
      attributes.set(name, value);
      if (name === 'class') value.split(/\s+/).filter(Boolean).forEach((className) => this.classList.add(className));
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    matches(selector) {
      return selector.split(',').some((part) => matchCompound(this, part));
    },
    closest(selector) {
      let current = this;
      while (current && current.nodeType === 1) {
        if (current.matches(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    appendChild(child) {
      child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
      this.children.push(child);
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      const document = this.nodeType === 9 ? this : this.ownerDocument;
      const adopt = (node) => {
        node.ownerDocument = document;
        node.children.forEach(adopt);
      };
      adopt(child);
      return child;
    },
    insertBefore(child, reference) {
      this.appendChild(child);
      if (reference && reference.parentNode === this) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.splice(this.children.indexOf(reference), 0, child);
      }
      return child;
    },
    remove() {
      const parent = this.parentNode;
      // Native removal blurs focus held anywhere in the removed subtree.
      if (parent && this.contains(this.ownerDocument?.activeElement)) {
        this.ownerDocument.activeElement = this.ownerDocument.body;
      }
      if (parent) parent.children.splice(parent.children.indexOf(this), 1);
      this.parentNode = null;
      this.parentElement = null;
    },
    replaceWith(next) {
      const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this), 1, next);
      next.parentNode = parent;
      next.parentElement = parent;
      next.ownerDocument = parent.ownerDocument;
      this.parentNode = null;
      this.parentElement = null;
    },
    replaceChildren(...nodes) {
      this.children.slice().forEach((child) => child.remove());
      this.textContent = '';
      nodes.forEach((node) => this.appendChild(node));
    },
    addEventListener(type, handler, options) {
      const capture = options === true || options?.capture === true;
      listeners.push({ type, handler, capture });
    },
    removeEventListener(type, handler, options) {
      const capture = options === true || options?.capture === true;
      const index = listeners.findIndex((listener) => listener.type === type
        && listener.handler === handler && listener.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    },
    focus() {
      const document = this.ownerDocument;
      if (document && this.isConnected) document.activeElement = this;
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    querySelectorAll(selector) {
      const result = [];
      const visit = (node) => {
        node.children.forEach((child) => {
          if (child.matches(selector)) result.push(child);
          visit(child);
        });
      };
      visit(this);
      return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    // C1f: the shared dropdown re-dispatches a pick as the native select's change.
    dispatchEvent(event) {
      return !fire(this, event.type).defaultPrevented;
    },
  };
  Object.entries(attrs).forEach(([name, value]) => element.setAttribute(name, value));
  return element;
}

// Bubbling dispatch with a capture phase, enough for the binder and viewer.
function fire(target, type, props = {}) {
  const event = {
    type,
    target,
    defaultPrevented: false,
    propagationStopped: false,
    button: 0,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...props,
  };
  const path = [];
  for (let node = target; node; node = node.parentNode) path.push(node);
  for (const node of [...path].reverse()) {
    node.listeners.filter((listener) => listener.type === type && listener.capture)
      .forEach((listener) => listener.handler(event));
  }
  for (const node of path) {
    if (event.propagationStopped) break;
    node.listeners.filter((listener) => listener.type === type && !listener.capture)
      .forEach((listener) => listener.handler(event));
  }
  return event;
}

const VOID_ELEMENTS = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source']);

function decodeEntities(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// A small parser for the server-rendered partials (no scripts, no raw text).
function parseInto(parent, html) {
  const stack = [parent];
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[0].startsWith('<!--')) continue;
    const top = stack[stack.length - 1];
    if (match[5] !== undefined) {
      if (match[5].trim()) top.ownText += decodeEntities(match[5]).replace(/\s+/g, ' ').trim();
      continue;
    }
    const [, closing, tag, attributeText, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const element = makeElement(tag);
    for (const attribute of attributeText.matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) {
      element.setAttribute(attribute[1], attribute[2] === undefined ? '' : decodeEntities(attribute[2]));
    }
    // C1f: dropdown radios and options carry their value/checked properties.
    if ((element.tagName === 'INPUT' || element.tagName === 'OPTION') && element.hasAttribute('value')) {
      element.value = element.getAttribute('value');
    }
    if (element.tagName === 'INPUT') {
      element.type = element.getAttribute('type') || 'text';
      element.checked = element.hasAttribute('checked');
    }
    top.appendChild(element);
    if (!selfClosing && !VOID_ELEMENTS.has(tag.toLowerCase())) stack.push(element);
  }
  return parent;
}

function installNativeDialog(dialog, page) {
  dialog.showModal = vi.fn(() => {
    dialog.open = true;
    dialog.setAttribute('open', '');
  });
  dialog.close = vi.fn(() => {
    if (!dialog.open) return;
    dialog.open = false;
    dialog.removeAttribute('open');
    // Browsers queue the close event; tests may hold it to reopen first.
    if (page.deferCloseEvents) page.queuedCloseEvents.push(() => fire(dialog, 'close'));
    else fire(dialog, 'close');
  });
}

function renderPartial(name) {
  return env.render(`partials/${name}`, {});
}

function makePage({ video = false } = {}) {
  const document = makeElement('#document');
  document.nodeType = 9;
  document.ownerDocument = null;
  document.activeElement = null;
  document.defaultView = { location: { href: 'http://creatorcrate.local/projects/7/assets', pathname: '/projects/7/assets', search: '', hash: '', assign: vi.fn() } };
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.createElement = (tagName) => makeElement(tagName);
  document.body = makeElement('body');
  document.appendChild(document.body);

  const main = makeElement('main', { id: 'main-content', tabindex: '-1' });
  const region = makeElement('div', { 'data-project-assets-live-region': '' });
  const opener = makeElement('button', { type: 'button', 'data-test-opener': '' });
  const slideshowTrigger = makeElement('button', { type: 'button', 'data-slideshow-trigger': '' });
  const hostFallback = makeElement('button', { type: 'button', 'data-test-fallback': '' });
  region.appendChild(opener);
  region.appendChild(slideshowTrigger);
  main.appendChild(region);
  main.appendChild(hostFallback);
  document.body.appendChild(main);

  const page = { document, main, region, opener, slideshowTrigger, hostFallback, deferCloseEvents: false, queuedCloseEvents: [] };
  if (video) {
    parseInto(document.body, renderPartial('asset-video-preview-dialog.njk'));
    const videoTrigger = makeElement('a', {
      href: '/projects/7/assets/9',
      'data-asset-video-preview-trigger': '',
      'data-video-src': '/projects/7/assets/9/original',
      'data-video-title': 'clip.webm',
    });
    region.appendChild(videoTrigger);
    page.videoTrigger = videoTrigger;
    page.videoDialog = document.getElementById(VIDEO_PREVIEW_DIALOG_ID);
    installNativeDialog(page.videoDialog, page);
  }
  parseInto(document.body, renderPartial('unified-viewer.njk'));
  page.dialog = document.getElementById(UNIFIED_VIEWER_DIALOG_ID);
  installNativeDialog(page.dialog, page);
  const q = (selector) => page.dialog.querySelector(selector);
  page.parts = {
    root: q('[data-unified-viewer]'),
    title: q('[data-unified-viewer-title]'),
    source: q('[data-unified-viewer-source]'),
    details: q('[data-unified-viewer-details]'),
    media: q('[data-unified-viewer-media]'),
    status: q('[data-unified-viewer-status]'),
    controls: q('[data-unified-viewer-controls]'),
    previous: q('[data-unified-viewer-previous]'),
    next: q('[data-unified-viewer-next]'),
    position: q('[data-unified-viewer-position]'),
    close: q('[data-dialog-close]'),
  };
  page.flushCloseEvents = () => {
    const queued = page.queuedCloseEvents.splice(0);
    queued.forEach((dispatch) => dispatch());
  };
  return page;
}

function boundPage(options) {
  const page = makePage(options);
  enhanceAppDialogs(page.document);
  expect(enhanceUnifiedViewer(page.document)).toBe(1);
  page.viewer = unifiedViewerFor(page.document);
  page.opener.focus();
  return page;
}


function expectDialogTitle(page, title) {
  const headingId = page.dialog.getAttribute('aria-labelledby');
  expect(headingId).toBe('unified-viewer-dialog-title');
  expect(page.dialog.querySelectorAll('h2')).toHaveLength(1);
  expect(page.document.getElementById(headingId).textContent).toBe(title);
  expect(page.parts.close.getAttribute('aria-label')).toBe(`Close ${title}`);
  expect(page.parts.close.getAttribute('title')).toBe(`Close ${title}`);
}

function rawItem(id, extra = {}) {
  return {
    projectId: 7,
    assetId: id,
    title: `image-${id}.png`,
    mediaUrl: `/projects/7/assets/${id}/preview`,
    originalUrl: `/projects/7/assets/${id}/original`,
    detailsUrl: `/projects/7/assets/${id}`,
    revision: 'r1',
    ...extra,
  };
}

function sequence(ids, options = {}) {
  return createViewerSource({
    key: 'project-7-assets',
    label: 'Project Seven',
    mode: 'sequence',
    items: ids.map((id) => rawItem(id)),
    ...options,
  });
}

function keyOf(id) {
  return `p:7|a:${id}`;
}

function listenerCount(node) {
  return node.listeners.length;
}

function allListenerCounts(page) {
  const nodes = [page.document, page.dialog, ...page.dialog.querySelectorAll('button, a')];
  return nodes.map(listenerCount);
}

// ─── Template and mounting ───────────────────────────────────────────────────

describe('unified viewer shell template', () => {
  it('shares one bottom footer and keeps only the title and close action in the header', () => {
    const page = makePage();
    const header = page.dialog.querySelector('.app-dialog-header');
    const footer = page.dialog.querySelector('footer');
    expect(header.children.map((element) => element.tagName)).toEqual(['H2', 'BUTTON']);
    expect(page.dialog.querySelectorAll('footer')).toHaveLength(1);
    expect(footer.contains(page.parts.title)).toBe(true);
    expect(footer.contains(page.parts.source)).toBe(true);
    expect(footer.contains(page.parts.details)).toBe(true);
    for (const action of ['fit', 'fullscreen', 'play', 'zoom-in', 'original']) {
      expect(footer.querySelectorAll(`[data-unified-viewer-${action}]`)).toHaveLength(1);
    }
    expect(footer.contains(page.parts.controls)).toBe(false);
    const stage = page.dialog.querySelector('[data-unified-viewer-stage]');
    expect(page.parts.controls.parentNode).toBe(stage);
    expect(page.parts.media.contains(page.parts.controls)).toBe(false);
    for (const name of ['controls', 'previous', 'next', 'position']) {
      expect(stage.querySelectorAll('[data-unified-viewer-' + name + ']')).toHaveLength(1);
    }
    const fit = footer.querySelector('[data-unified-viewer-fit]');
    expect(fit.querySelectorAll('svg')).toHaveLength(1);
    expect(fit.getAttribute('data-tooltip')).toBe('Fit to viewer');
  });
  it('renders one shared native dialog with shared backdrop dismissal and accessible structure', () => {
    const html = renderPartial('unified-viewer.njk');
    expect(html.match(/<dialog\b/g)).toHaveLength(1);
    const dialogTag = html.match(/<dialog [^>]*>/)[0];
    expect(dialogTag).toContain('id="unified-viewer-dialog"');
    expect(dialogTag).toContain('data-app-dialog');
    expect(dialogTag).not.toContain('data-dialog-backdrop-static');
    expect(dialogTag).toContain('aria-labelledby="unified-viewer-dialog-title"');
    expect(dialogTag).toContain('aria-describedby="unified-viewer-context"');
    expect(dialogTag).not.toMatch(/\sopen[\s>]/);
    expect(html).toContain('<h2 id="unified-viewer-dialog-title">Image Preview</h2>');
    expect(html).toContain('aria-label="Close Image Preview"');
    expect(html).toContain('id="unified-viewer-context"');
    expect(html).toMatch(/data-unified-viewer-previous aria-label="Previous" data-tooltip="Previous"/);
    expect(html).toMatch(/data-unified-viewer-next aria-label="Next" data-tooltip="Next"/);
    expect(html).toMatch(/data-unified-viewer-status role="status" aria-live="polite"/);
    expect(html).toMatch(/data-unified-viewer-position aria-live="polite" aria-atomic="true"/);
    expect(html).not.toContain('autofocus');
  });

  it('exposes the shared controls with quality and Actual Size kept distinct', () => {
    const page = makePage();
    const buttons = page.dialog.querySelectorAll('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Close Image Preview', 'Previous', 'Next', 'Play slideshow',
      'Zoom out', 'Zoom in', 'Actual size (100%)', 'Fit to viewer', 'Enter fullscreen', 'Original source',
    ]);
    // B4's fullscreen button and playback group start hidden; they appear
    // only for an open session (fullscreen: where the API exists; playback:
    // for a playable slideshow source).
    expect(page.dialog.querySelector('[data-unified-viewer-fullscreen]').hidden).toBe(true);
    // B3's view tools exist but stay hidden and disabled until an image loads.
    const viewTools = page.dialog.querySelector('[data-unified-viewer-view-tools]');
    expect(viewTools.hidden).toBe(true);
    expect(viewTools.querySelectorAll('button').every((button) => button.disabled)).toBe(true);
    expect(page.dialog.querySelector('[data-unified-viewer-playback]').hidden).toBe(true);
    expect(page.parts.details.hasAttribute('href')).toBe(false);
    expect(page.parts.details.hidden).toBe(true);
    expect(page.parts.controls.hidden).toBe(true);
    expect(page.parts.media.children).toHaveLength(0);
  });

  function renderLayout({ unifiedViewer, assetVideoPreview = false }) {
    return env.renderString(
      `{% extends "layout.njk" %}
{% set unifiedViewer = ${unifiedViewer} %}
{% set assetVideoPreview = ${assetVideoPreview} %}
{% block content %}<div data-project-assets-live-region>Host</div>{% endblock %}`,
      { assetMode: 'test', page_title: 'Assets' },
    );
  }

  it('mounts exactly once, outside main and every live region, only on opted-in pages', () => {
    const html = renderLayout({ unifiedViewer: true, assetVideoPreview: true });
    expect(html.match(/id="unified-viewer-dialog"/g)).toHaveLength(1);
    expect(html.match(/id="asset-video-preview-dialog"/g)).toHaveLength(1);
    expect(html.indexOf('id="unified-viewer-dialog"')).toBeGreaterThan(html.indexOf('</main>'));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);

    expect(renderLayout({ unifiedViewer: false })).not.toContain('unified-viewer-dialog');
  });

  it('is opted in by each image/comic host page exactly once, at template top level', () => {
    // Asset Details (projects/asset-viewer.njk) joined with its own migration
    // (B6): its page keeps exactly one polite live region outside the viewer
    // dialog (tests/assets-http.test.js, tests/asset-tags-http.test.js).
    const hosts = [
      'assets/index.njk',
      'projects/asset-viewer.njk',
      'projects/assets.njk',
      'projects/detail.njk',
      'releases/assets.njk',
      'releases/detail.njk',
    ];
    hosts.forEach((host) => {
      const source = fs.readFileSync(`${VIEWS_DIR}/${host}`, 'utf8');
      expect(source.match(/^\{% set unifiedViewer = true %\}$/gm), host).toHaveLength(1);
      // The flag is set outside every block, so layout.njk sees it.
      const before = source.slice(0, source.indexOf('{% set unifiedViewer = true %}'));
      const opened = (before.match(/\{% block /g) || []).length;
      const closed = (before.match(/\{% endblock/g) || []).length;
      expect(opened - closed, host).toBe(0);
      // No host renders its own viewer shell.
      expect(source, host).not.toContain('unified-viewer.njk');
    });
  });
});

// ─── Binding ─────────────────────────────────────────────────────────────────

describe('unified viewer binding', () => {
  it('binds only through the shared dialog binder, once', () => {
    const page = makePage();
    expect(enhanceUnifiedViewer(page.document)).toBe(0);
    expect(unifiedViewerFor(page.document)).toBeNull();

    enhanceAppDialogs(page.document);
    const before = allListenerCounts(page);
    expect(enhanceUnifiedViewer(page.document)).toBe(1);
    const bound = allListenerCounts(page);
    expect(enhanceUnifiedViewer(page.document)).toBe(1);
    expect(enhanceUnifiedViewer(page.region)).toBe(1);
    expect(allListenerCounts(page)).toEqual(bound);
    // The viewer adds two keydown listeners on its dialog (shell navigation
    // and B3's Shift+Arrow pan) plus B4's capture-phase fullscreen Escape
    // listener, and one click listener on each navigation, view-tool and
    // playback button. On the document it adds only B4's single
    // visibilitychange listener (fullscreenchange/fullscreenerror too where
    // the Fullscreen API exists; this shim has none): no keyboard or click
    // interception.
    const added = page.document.listeners.slice(before[0]).map((listener) => listener.type);
    expect(added).toEqual(['visibilitychange']);
    expect(page.dialog.listeners.slice(before[1]).map((listener) => `${listener.type}:${listener.capture}`))
      .toEqual(['keydown:false', 'keydown:false', 'keydown:true']);
    expect(bound[1] - before[1]).toBe(3);
    expect(unifiedViewerFor(page.region)).toBe(unifiedViewerFor(page.document));
  });

  it('returns 0 on pages without the viewer', () => {
    const document = makeElement('#document');
    document.nodeType = 9;
    document.getElementById = () => null;
    expect(enhanceUnifiedViewer(document)).toBe(0);
    expect(unifiedViewerFor(document)).toBeNull();
  });

  it('leaves the existing slideshow trigger and document listeners alone', () => {
    const page = makePage();
    enhanceAppDialogs(page.document);
    const documentListeners = listenerCount(page.document);
    enhanceUnifiedViewer(page.document);
    const viewer = unifiedViewerFor(page.document);
    viewer.open(sequence([1, 2]), { opener: page.opener });
    viewer.close();
    expect(listenerCount(page.slideshowTrigger)).toBe(0);
    expect(listenerCount(page.opener)).toBe(0);
    // Only B4's one visibilitychange listener, added once at binding.
    expect(page.document.listeners.slice(documentListeners).map((listener) => listener.type))
      .toEqual(['visibilitychange']);
    // A click on the old trigger does not open the new viewer.
    fire(page.slideshowTrigger, 'click');
    expect(page.dialog.open).toBe(false);
    expect(viewer.getState().open).toBe(false);
  });
});

// ─── Opening, header and navigation ─────────────────────────────────────────

describe('unified viewer contextual dialog titles', () => {
  it.each([
    ['single image', () => sequence([1], { mode: 'single' }), 'Image Preview'],
    ['image sequence', () => sequence([1, 2]), 'Image Preview'],
    ['slideshow', () => sequence([1, 2], { slideshow: true }), 'Slideshow'],
    ['one-image slideshow', () => createSlideshowSource({ entries: [
      { id: 1, projectId: 7, filename: 'one.png', previewUrl: '/one' },
    ] }), 'Slideshow'],
    ['comic source', () => sequence([1], { kind: 'comic', items: [rawItem(1, { position: 1 })] }), 'Comic Reader'],
  ])('names a %s from its source contract while loading', (_name, source, title) => {
    const page = boundPage();
    expect(page.viewer.open(source(), { opener: page.opener, autoplay: false })).toBeGreaterThan(0);
    expect(page.viewer.getState().playback.playing).toBe(false);
    expectDialogTitle(page, title);
  });

  it('synchronizes source replacement, accepted refresh and reopening while ignoring stale sessions', () => {
    const page = boundPage();
    const first = page.viewer.open(sequence([1], { slideshow: true }), { autoplay: false });
    expectDialogTitle(page, 'Slideshow');
    page.viewer.update([rawItem(1, { revision: 'r2' })], { session: first });
    expectDialogTitle(page, 'Slideshow');
    page.viewer.open(sequence([2]));
    expectDialogTitle(page, 'Image Preview');
    expect(page.viewer.update([rawItem(1)], { session: first })).toBeNull();
    expectDialogTitle(page, 'Image Preview');
    page.viewer.close();
    page.viewer.open(sequence([3], { slideshow: true }), { autoplay: false });
    expectDialogTitle(page, 'Slideshow');
  });
});

describe('unified viewer opening and navigation', () => {
  it('uses authoritative project metadata and retains the complete filename for accessibility', () => {
    const page = boundPage();
    const filename = 'A long full filename '.repeat(30) + '.png';
    page.viewer.open(createViewerSource({ label: 'Asset Viewer', items: [rawItem(1, { filename, projectName: null })] }));
    expect(page.parts.title.textContent).toBe(filename);
    expect(page.parts.title.getAttribute('title')).toBe(filename);
    expect(page.parts.title.getAttribute('aria-label')).toBe(filename);
    expect(page.parts.source.textContent).toBe('');
    expect(page.dialog.querySelector('[data-unified-viewer-project]').hidden).toBe(true);
  });
  it('opens a single image with its context and no sequence controls', () => {
    const page = boundPage();
    const source = createSingleImageSource({
      key: 'project-7-assets',
      label: 'Project Seven',
      entries: [
        { id: 1, projectId: 7, filename: 'one.png', previewUrl: '/p/1', viewerUrl: '/projects/7/assets/1' },
        { id: 2, projectId: 7, projectName: 'Project Seven', filename: 'two.png', previewUrl: '/p/2', viewerUrl: '/projects/7/assets/2' },
      ],
      projectId: 7,
      assetId: 2,
    });
    const session = page.viewer.open(source, { opener: page.opener });

    expect(session).toBeGreaterThan(0);
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(true);
    expect(page.document.activeElement).toBe(page.parts.close);
    expect(page.parts.title.textContent).toBe('two.png');
    expect(page.parts.source.textContent).toBe('Project Seven');
    expect(page.parts.source.hidden).toBe(false);
    expect(page.parts.details.getAttribute('href')).toBe('/projects/7/assets/2');
    expect(page.parts.details.hidden).toBe(false);
    expect(page.parts.controls.hidden).toBe(true);
    expect(page.parts.root.getAttribute('data-viewer-item-state')).toBe('available');
    expect(page.parts.status.textContent).toBe('');
    expect(page.viewer.getState()).toMatchObject({ open: true, session, key: keyOf(2), index: 0, count: 1 });

    // Arrow keys and step commands have nothing to do.
    const event = fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
    expect(event.defaultPrevented).toBe(false);
    expect(page.viewer.next()).toMatchObject({ moved: false });
    expect(page.viewer.getState().key).toBe(keyOf(2));
  });

  it('opens a sequence on its initial item and steps with the shared commands', () => {
    const page = boundPage();
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    const source = createSlideshowSource({
      key: 'project-7-slideshow',
      label: 'Project Seven',
      entries: [1, 2, 3].map((id) => ({ id, projectId: 7, filename: `f${id}.png`, previewUrl: `/p/${id}`, viewerUrl: `/projects/7/assets/${id}` })),
      initialKey: keyOf(2),
    });
    page.viewer.open(source, { opener: page.opener });

    expect(page.parts.controls.hidden).toBe(false);
    expect(page.parts.previous.hidden).toBe(false);
    expect(page.parts.next.hidden).toBe(false);
    expect(page.parts.position.textContent).toBe('2 of 3');
    expect(page.parts.title.textContent).toBe('f2.png');
    expect(changes.map((change) => change.type)).toEqual(['open']);
    expect(changes[0]).toMatchObject({ key: keyOf(2), index: 1, count: 3, reload: true });

    fire(page.parts.next, 'click');
    expect(page.parts.title.textContent).toBe('f3.png');
    expect(page.parts.position.textContent).toBe('3 of 3');
    expect(page.parts.details.getAttribute('href')).toBe('/projects/7/assets/3');

    // A slideshow source wraps.
    fire(page.parts.next, 'click');
    expect(page.parts.position.textContent).toBe('1 of 3');
    expect(changes.at(-1)).toMatchObject({ type: 'navigate', key: keyOf(1), previousKey: keyOf(3), wrapped: true, reload: true });
    fire(page.parts.previous, 'click');
    expect(page.parts.position.textContent).toBe('3 of 3');
    expect(page.parts.previous.disabled).toBe(false);
    expect(page.parts.next.disabled).toBe(false);

    expect(page.viewer.select(keyOf(2))).toBe(true);
    expect(page.parts.title.textContent).toBe('f2.png');
    expect(page.viewer.select('p:7|a:404')).toBe(false);
  });

  it('respects non-wrapping boundaries and keeps focus on a usable control', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2, 3]), { opener: page.opener });

    expect(page.parts.position.textContent).toBe('1 of 3');
    expect(page.parts.previous.disabled).toBe(true);
    expect(page.parts.next.disabled).toBe(false);
    expect(page.viewer.previous()).toMatchObject({ moved: false, boundary: 'start' });

    page.parts.next.focus();
    fire(page.parts.next, 'click');
    fire(page.parts.next, 'click');
    expect(page.parts.position.textContent).toBe('3 of 3');
    expect(page.parts.next.disabled).toBe(true);
    expect(page.parts.previous.disabled).toBe(false);
    // The disabled Next no longer holds focus; Previous does.
    expect(page.document.activeElement).toBe(page.parts.previous);
    expect(page.viewer.next()).toMatchObject({ moved: false, boundary: 'end' });
  });

  it('hides Previous/Next for a one-item sequence but keeps its position', () => {
    const page = boundPage();
    page.viewer.open(sequence([5]), { opener: page.opener });
    expect(page.parts.controls.hidden).toBe(false);
    expect(page.parts.position.textContent).toBe('1 of 1');
    expect(page.parts.previous.hidden).toBe(true);
    expect(page.parts.next.hidden).toBe(true);
  });

  it('navigates with Left/Right arrows only when the viewer owns the keys', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2, 3]), { opener: page.opener });

    let event = fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
    expect(event.defaultPrevented).toBe(true);
    expect(page.viewer.getState().key).toBe(keyOf(2));
    fire(page.parts.close, 'keydown', { key: 'ArrowLeft' });
    expect(page.viewer.getState().key).toBe(keyOf(1));

    // Modified arrows (browser/history shortcuts, selection) are not ours.
    ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].forEach((modifier) => {
      event = fire(page.parts.close, 'keydown', { key: 'ArrowRight', [modifier]: true });
      expect(event.defaultPrevented).toBe(false);
    });
    expect(page.viewer.getState().key).toBe(keyOf(1));

    // Editable controls and custom dropdowns keep their arrow keys.
    const tools = page.dialog.querySelector('[data-unified-viewer-view-tools]');
    const input = makeElement('input', { type: 'text' });
    const dropdown = makeElement('details', { 'data-cc-dropdown': '' });
    const summary = makeElement('summary');
    dropdown.appendChild(summary);
    tools.appendChild(input);
    tools.appendChild(dropdown);
    event = fire(input, 'keydown', { key: 'ArrowRight' });
    expect(event.defaultPrevented).toBe(false);
    fire(summary, 'keydown', { key: 'ArrowRight' });
    expect(page.viewer.getState().key).toBe(keyOf(1));
    // An open dropdown anywhere in the viewer keeps them too.
    dropdown.setAttribute('open', '');
    fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
    expect(page.viewer.getState().key).toBe(keyOf(1));
    dropdown.removeAttribute('open');

    // A key another handler already took is left alone.
    event = fire(page.parts.close, 'keydown', { key: 'ArrowRight', defaultPrevented: true });
    expect(page.viewer.getState().key).toBe(keyOf(1));

    fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
    expect(page.viewer.getState().key).toBe(keyOf(2));
  });

  it('refuses an empty source and shows a safe state for an unavailable item', () => {
    const page = boundPage();
    expect(page.viewer.open(createViewerSource({ items: [] }), { opener: page.opener })).toBe(0);
    expect(page.viewer.open(null)).toBe(0);
    expect(page.dialog.showModal).not.toHaveBeenCalled();
    expect(page.viewer.getState().open).toBe(false);

    page.viewer.open(createViewerSource({
      mode: 'sequence',
      items: [rawItem(1, { mediaUrl: null }), rawItem(2, { available: false, unavailableReason: 'processing' })],
    }), { opener: page.opener });
    expect(page.parts.root.getAttribute('data-viewer-item-state')).toBe('unavailable');
    expect(page.parts.status.textContent).toBe('No preview is available for this item.');
    page.viewer.next();
    expect(page.parts.status.textContent).toBe('This item is not available.');
    // The details link still works for an asset whose media is unavailable.
    expect(page.parts.details.getAttribute('href')).toBe('/projects/7/assets/2');
  });

  it('renders untrusted titles and labels as text and refuses unsafe details URLs', () => {
    const page = boundPage();
    const hostile = '<img src=x onerror="alert(1)">';
    page.viewer.open(createViewerSource({
      key: 'k',
      label: `<b>${hostile}</b>`,
      mode: 'sequence',
      items: [
        rawItem(1, { title: hostile, projectName: `<b>${hostile}</b>`, detailsUrl: 'javascript:alert(1)' }),
        rawItem(2, { detailsUrl: '//evil.example/assets/2' }),
        rawItem(3, { detailsUrl: 'https://evil.example/' }),
      ],
    }), { opener: page.opener });

    expect(page.parts.title.textContent).toBe(hostile);
    expect(page.parts.title.children).toHaveLength(0);
    expect(page.parts.source.textContent).toBe(`<b>${hostile}</b>`);
    expect(page.parts.source.children).toHaveLength(0);
    expect(page.parts.details.hidden).toBe(false);
    expect(page.parts.details.getAttribute('href')).toBe(`/projects/7/assets/${page.viewer.getState().item.assetId}`);
    page.viewer.next();
    expect(page.parts.details.getAttribute('href')).toBe(`/projects/7/assets/${page.viewer.getState().item.assetId}`);
    page.viewer.next();
    expect(page.parts.details.getAttribute('href')).toBe(`/projects/7/assets/${page.viewer.getState().item.assetId}`);
    expect(page.dialog.querySelectorAll('img')).toHaveLength(0);
  });
});

// ─── Closing, focus and scroll lock ─────────────────────────────────────────

describe('unified viewer closing and focus', () => {
  it('closes from the Close button, restores the opener, unlocks the page and clears the shell', () => {
    const page = boundPage();
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    const session = page.viewer.open(sequence([1, 2]), { opener: page.opener });
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(true);

    fire(page.parts.close, 'click');

    expect(page.dialog.open).toBe(false);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.document.defaultView.location.assign).not.toHaveBeenCalled();
    expect(changes.at(-1)).toMatchObject({ type: 'close', session, reason: 'dismissed', key: keyOf(1) });
    expect(page.viewer.getState()).toMatchObject({ open: false, session: null, key: null, count: 0 });
    expect(page.parts.title.textContent).toBe('');
    expect(page.parts.details.hasAttribute('href')).toBe(false);
    expect(page.parts.controls.hidden).toBe(true);
    expect(page.parts.root.getAttribute('data-viewer-item-state')).toBe('empty');

    // Repeated closes are harmless.
    expect(page.viewer.close()).toBe(false);
    fire(page.parts.close, 'click');
    expect(changes.filter((change) => change.type === 'close')).toHaveLength(1);
  });

  it('closes on Escape through the shared binder, after an open dropdown closes first', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener });
    const tools = page.dialog.querySelector('[data-unified-viewer-view-tools]');
    const dropdown = makeElement('details', { 'data-cc-dropdown': '', open: '' });
    const summary = makeElement('summary');
    dropdown.appendChild(summary);
    tools.appendChild(dropdown);
    dropdown.open = true;

    fire(page.parts.close, 'keydown', { key: 'Escape' });
    expect(dropdown.hasAttribute('open')).toBe(false);
    expect(page.viewer.getState().open).toBe(true);
    expect(page.dialog.open).toBe(true);

    fire(page.parts.close, 'keydown', { key: 'Escape' });
    expect(page.viewer.getState().open).toBe(false);
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
  });

  it('closes programmatically and restores focus the same way', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener });
    expect(page.viewer.close()).toBe(true);
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
  });

  it('defaults the opener to the focused control, and keeps it when the source is replaced from inside', () => {
    const page = boundPage();
    page.hostFallback.focus();
    page.viewer.open(sequence([1, 2]));
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.hostFallback);

    page.opener.focus();
    page.viewer.open(sequence([1, 2], { key: 'a' }));
    expect(page.document.activeElement).toBe(page.parts.close);
    page.viewer.open(sequence([3, 4], { key: 'b' }));
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.opener);
  });

  it('dismisses only when both pointer endpoints belong to the backdrop', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener });

    // A drag that starts on the image surface and ends outside is no dismissal either.
    fire(page.parts.media, 'pointerdown', { pointerId: 2 });
    fire(page.dialog, 'pointerup', { pointerId: 2 });
    fire(page.dialog, 'click');
    expect(page.viewer.getState().open).toBe(true);
    fire(page.dialog, 'pointerdown', { pointerId: 3 });
    fire(page.parts.media, 'pointerup', { pointerId: 3 });
    fire(page.dialog, 'click');
    expect(page.viewer.getState().open).toBe(true);

    const closed = [];
    page.viewer.observe((change) => { if (change.type === 'close') closed.push(change); });
    fire(page.dialog, 'pointerdown', { pointerId: 4 });
    fire(page.dialog, 'pointerup', { pointerId: 4 });
    fire(page.dialog, 'click');
    expect(page.viewer.getState().open).toBe(false);
    expect(page.dialog.open).toBe(false);
    expect(closed).toHaveLength(1);
    expect(page.document.activeElement).toBe(page.opener);
  });

  it('falls back to a host control, then to the main landmark, when a refresh replaced the opener', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
    page.opener.remove();
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.hostFallback);

    const second = boundPage();
    second.viewer.open(sequence([1, 2]), { opener: second.opener, fallbackFocus: second.hostFallback });
    second.region.remove();
    fire(second.parts.close, 'keydown', { key: 'Escape' });
    expect(second.document.activeElement).toBe(second.hostFallback);

    const third = boundPage();
    third.viewer.open(sequence([1, 2]), { opener: third.opener, fallbackFocus: () => { throw new Error('gone'); } });
    third.region.remove();
    third.viewer.close();
    expect(third.document.activeElement).toBe(third.main);
  });

  it.each(['hidden', 'hidden-parent', 'inert-parent', 'disabled'])('uses the host fallback for a connected %s opener', (state) => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
    if (state === 'hidden') page.opener.setAttribute('hidden', '');
    else if (state === 'disabled') page.opener.disabled = true;
    else page.region.setAttribute(state === 'hidden-parent' ? 'hidden' : 'inert', '');
    expect(page.document.contains(page.opener)).toBe(true);
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.hostFallback);
  });

  it('rejects a hidden host fallback and keeps the visible original opener preferred', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.opener);
    page.viewer.open(sequence([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
    page.opener.setAttribute('hidden', '');
    page.hostFallback.setAttribute('hidden', '');
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.main);
  });
});

// ─── Reopening and session replacement ──────────────────────────────────────

describe('unified viewer sessions', () => {
  it('reopens repeatedly without duplicate listeners or leftover state', () => {
    const page = boundPage();
    const baseline = allListenerCounts(page);
    for (let round = 0; round < 3; round += 1) {
      page.viewer.open(sequence([1, 2, 3], { key: `round-${round}` }), { opener: page.opener });
      page.viewer.next();
      fire(page.parts.close, 'click');
    }
    expect(allListenerCounts(page)).toEqual(baseline);

    const session = page.viewer.open(sequence([4, 5]), { opener: page.opener });
    expect(page.viewer.getState()).toMatchObject({ session, key: keyOf(4), index: 0, count: 2 });
    expect(page.parts.position.textContent).toBe('1 of 2');
  });

  it('replaces an open source without leaving the old one visible or actionable', () => {
    const page = boundPage();
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    const first = page.viewer.open(sequence([1, 2, 3], { key: 'first', label: 'First' }), { opener: page.opener });
    page.viewer.next();
    page.hostFallback.focus();
    const second = page.viewer.open(createViewerSource({
      key: 'second',
      label: '',
      mode: 'single',
      items: [rawItem(9, { detailsUrl: null })],
    }), { opener: page.hostFallback });

    expect(second).toBeGreaterThan(first);
    expect(changes.map((change) => [change.type, change.session, change.reason])).toEqual([
      ['open', first, null],
      ['navigate', first, null],
      ['close', first, 'replaced'],
      ['open', second, null],
    ]);
    expect(page.parts.title.textContent).toBe('image-9.png');
    expect(page.parts.source.hidden).toBe(true);
    expect(page.parts.details.hidden).toBe(false);
    expect(page.parts.details.getAttribute('href')).toBe('/projects/7/assets/9');
    expect(page.parts.controls.hidden).toBe(true);

    // The first session's refresh can no longer touch the viewer.
    expect(page.viewer.update([rawItem(1), rawItem(2)], { session: first })).toBeNull();
    expect(page.viewer.getState()).toMatchObject({ session: second, key: keyOf(9) });

    page.viewer.close();
    expect(page.document.activeElement).toBe(page.hostFallback);
  });

  it('keeps a reopened session when the earlier dismissal’s close event arrives late', () => {
    const page = boundPage();
    page.deferCloseEvents = true;
    page.viewer.open(sequence([1, 2], { key: 'a' }), { opener: page.opener });
    page.viewer.close();
    expect(page.viewer.getState().open).toBe(false);
    // Nothing is actionable while the close event is still queued.
    expect(page.viewer.next()).toBeNull();
    expect(page.viewer.update([rawItem(1)])).toBeNull();

    const session = page.viewer.open(sequence([3, 4], { key: 'b' }), { opener: page.opener });
    page.flushCloseEvents();
    expect(page.viewer.getState()).toMatchObject({ open: true, session, key: keyOf(3) });
    expect(page.dialog.open).toBe(true);
    expect(page.parts.title.textContent).toBe('image-3.png');

    page.deferCloseEvents = false;
    page.viewer.close();
    expect(page.viewer.getState().open).toBe(false);
  });

  it('isolates a failing observer and supports unsubscribing', () => {
    const page = boundPage();
    const seen = [];
    page.viewer.observe(() => { throw new Error('participant failed'); });
    const stop = page.viewer.observe((change) => seen.push(change.type));
    page.viewer.open(sequence([1, 2]), { opener: page.opener });
    page.viewer.next();
    stop();
    page.viewer.previous();
    expect(seen).toEqual(['open', 'navigate']);
    expect(page.viewer.getState().key).toBe(keyOf(1));
    expect(Object.isFrozen(page.viewer.getState())).toBe(true);
  });
});

// ─── Live-refresh reconciliation ────────────────────────────────────────────

describe('unified viewer source updates', () => {
  it('keeps the current item, reflects changed metadata and flags a media reload', () => {
    const page = boundPage();
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    const session = page.viewer.open(sequence([1, 2, 3], { initialKey: keyOf(2) }), { opener: page.opener });

    const result = page.viewer.update({
      label: 'Renamed Project',
      items: [rawItem(1), rawItem(2, { title: 'renamed.png', projectName: 'Renamed Project', revision: 'r2', detailsUrl: null }), rawItem(3), rawItem(4)],
    }, { session });

    expect(result.outcome).toBe('kept');
    expect(page.parts.title.textContent).toBe('renamed.png');
    expect(page.parts.source.textContent).toBe('Renamed Project');
    expect(page.parts.position.textContent).toBe('2 of 4');
    // Valid identity retains canonical navigation when the explicit URL is omitted.
    expect(page.parts.details.hidden).toBe(false);
    expect(page.parts.details.getAttribute('href')).toBe('/projects/7/assets/2');
    expect(changes.at(-1)).toMatchObject({
      type: 'update', session, outcome: 'kept', key: keyOf(2), reload: true, revisionChanged: true, preserveView: false,
    });

    page.viewer.update([rawItem(1), rawItem(2, { title: 'renamed.png', revision: 'r2' }), rawItem(3), rawItem(4)]);
    expect(changes.at(-1)).toMatchObject({ outcome: 'kept', reload: false, preserveView: true });
    expect(page.parts.details.getAttribute('href')).toBe('/projects/7/assets/2');
  });

  it('moves to a neighbor when the current item is removed', () => {
    const page = boundPage();
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    page.viewer.open(sequence([1, 2, 3], { initialKey: keyOf(2) }), { opener: page.opener });

    const result = page.viewer.update([rawItem(1), rawItem(3)]);
    expect(result).toMatchObject({ outcome: 'replaced', key: keyOf(3), reason: 'removed' });
    expect(page.parts.title.textContent).toBe('image-3.png');
    expect(page.parts.position.textContent).toBe('2 of 2');
    expect(page.parts.next.disabled).toBe(true);
    expect(changes.at(-1)).toMatchObject({ type: 'update', previousKey: keyOf(2), key: keyOf(3), reload: true });
  });

  it('closes when nothing is left, restoring focus without navigating', () => {
    const page = boundPage();
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    page.viewer.open(sequence([1, 2]), { opener: page.opener, fallbackFocus: page.hostFallback });
    page.opener.remove();

    const result = page.viewer.update([]);
    expect(result).toMatchObject({ outcome: 'closed', reason: 'empty' });
    expect(page.dialog.open).toBe(false);
    expect(page.viewer.getState().open).toBe(false);
    expect(changes.at(-1)).toMatchObject({ type: 'close', reason: 'empty' });
    expect(page.document.activeElement).toBe(page.hostFallback);
    expect(page.document.defaultView.location.assign).not.toHaveBeenCalled();
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
  });

  it('closes a single-image viewer whose image was removed', () => {
    const page = boundPage();
    page.viewer.open(createSingleImageSource({
      key: 'project-7-assets',
      entries: [{ id: 1, projectId: 7, filename: 'one.png', previewUrl: '/p/1' }, { id: 2, projectId: 7, filename: 'two.png', previewUrl: '/p/2' }],
      projectId: 7,
      assetId: 1,
    }), { opener: page.opener });

    const kept = page.viewer.update([{ assetId: 2, projectId: 7, mediaUrl: '/p/2' }, { assetId: 1, projectId: 7, title: 'one-renamed.png', mediaUrl: '/p/1' }]);
    expect(kept.outcome).toBe('kept');
    expect(page.parts.title.textContent).toBe('one-renamed.png');
    expect(page.parts.controls.hidden).toBe(true);

    expect(page.viewer.update([{ assetId: 2, projectId: 7, mediaUrl: '/p/2' }])).toMatchObject({ outcome: 'closed', reason: 'removed' });
    expect(page.viewer.getState().open).toBe(false);
  });

  it('closes on a replacement naming a different source, and ignores updates after closing', () => {
    const page = boundPage();
    const session = page.viewer.open(sequence([1, 2]), { opener: page.opener });
    expect(page.viewer.update({ key: 'another-source', items: [rawItem(1)] }, { session }))
      .toMatchObject({ outcome: 'closed', reason: 'source-changed' });
    expect(page.viewer.getState().open).toBe(false);
    expect(page.viewer.update([rawItem(1)], { session })).toBeNull();
    expect(page.viewer.update([rawItem(1)])).toBeNull();
  });
});

// ─── Coexistence and teardown ───────────────────────────────────────────────

describe('unified viewer coexistence and teardown', () => {
  it('leaves the shared video preview dialog working before and after viewing', () => {
    const page = makePage({ video: true });
    enhanceAppDialogs(page.document);
    enhanceAssetVideoPreview(page.document, openAppDialogById);
    enhanceUnifiedViewer(page.document);
    const viewer = unifiedViewerFor(page.document);

    const playVideo = () => {
      const click = fire(page.videoTrigger, 'click');
      expect(click.defaultPrevented).toBe(true);
      expect(page.videoDialog.open).toBe(true);
      const slot = page.videoDialog.querySelector('[data-asset-video-preview-slot]');
      expect(slot.children).toHaveLength(1);
      expect(slot.children[0].getAttribute('src')).toBe('/projects/7/assets/9/original');
      fire(page.videoDialog.querySelector('[data-dialog-close]'), 'click');
      expect(page.videoDialog.open).toBe(false);
      expect(slot.children).toHaveLength(0);
      expect(page.document.activeElement).toBe(page.videoTrigger);
    };

    playVideo();
    page.opener.focus();
    viewer.open(sequence([1, 2]), { opener: page.opener });
    expect(page.dialog.open).toBe(true);
    expect(page.videoDialog.open).toBe(false);
    viewer.close();
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
    playVideo();
    // Video closes never touch the viewer session.
    expect(viewer.getState().open).toBe(false);
  });

  it('tears down every viewer-owned listener and hook', () => {
    const page = makePage();
    enhanceAppDialogs(page.document);
    const dialogState = page.dialog.__creatorCrateAppDialogState;
    const binderOnClose = dialogState.onClose;
    const baseline = allListenerCounts(page);
    enhanceUnifiedViewer(page.document);
    const viewer = unifiedViewerFor(page.document);
    const seen = [];
    viewer.observe((change) => seen.push(change.type));
    viewer.open(sequence([1, 2]), { opener: page.opener });

    viewer.destroy();
    expect(seen).toEqual(['open', 'close']);
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    expect(allListenerCounts(page)).toEqual(baseline);
    expect(dialogState.onClose).toBe(binderOnClose);
    expect(unifiedViewerFor(page.document)).toBeNull();
    expect(viewer.open(sequence([1, 2]))).toBe(0);
    expect(viewer.observe(() => {})).toBeTypeOf('function');
    viewer.destroy();

    // The shared dialog still opens and closes on its own afterwards.
    expect(openAppDialogById(page.document, UNIFIED_VIEWER_DIALOG_ID, page.opener)).toBe(true);
    fire(page.parts.close, 'click');
    expect(page.dialog.open).toBe(false);
    expect(seen).toEqual(['open', 'close']);

    // And it can be bound again.
    expect(enhanceUnifiedViewer(page.document)).toBe(1);
    expect(unifiedViewerFor(page.document)).not.toBe(viewer);
  });
});

// ─── B3 media integration ────────────────────────────────────────────────────

// ─── Media-backed pages (B3, B4) ──────────────────────────────────────────────

// The page's window supplies fetch/URL; images decode on demand.
function mediaPage({ beforeBind } = {}) {
  const page = makePage();
  const requests = [];
  const live = new Set();
  let created = 0;
  page.document.defaultView.fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
    const request = { url, resolve, reject, aborted: false };
    init.signal.addEventListener('abort', () => {
      request.aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    });
    requests.push(request);
  }));
  page.document.defaultView.URL = {
    createObjectURL: () => {
      created += 1;
      live.add(`blob:${created}`);
      return `blob:${created}`;
    },
    revokeObjectURL: (url) => live.delete(url),
  };
  page.document.defaultView.AbortController = AbortController;
  const createElement = page.document.createElement;
  page.document.createElement = (tagName) => {
    const element = createElement(tagName);
    if (tagName === 'img') {
      element.style = {};
      element.decode = async () => {
        element.naturalWidth = 1600;
        element.naturalHeight = 1200;
      };
    }
    return element;
  };
  beforeBind?.(page);
  enhanceAppDialogs(page.document);
  page.binderKeydowns = page.dialog.listeners.filter((listener) => listener.type === 'keydown').length;
  enhanceUnifiedViewer(page.document);
  page.viewer = unifiedViewerFor(page.document);
  page.opener.focus();
  page.requests = requests;
  page.live = live;
  page.respond = async (request) => {
    request.resolve(new Response('x', { headers: { 'content-type': 'image/webp' } }));
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  // C1e: comic pages sit inside the spread composition, images directly in media.
  page.images = () => page.parts.media.querySelectorAll('img');
  return page;
}

describe('unified viewer media integration (B3)', () => {
  it('loads the opened item and follows the shell’s navigation', async () => {
    const page = mediaPage();
    page.viewer.open(sequence([1, 2, 3]), { opener: page.opener });
    expect(page.requests.map((request) => request.url)).toEqual(['/projects/7/assets/1/preview']);
    expect(page.viewer.media.getState()).toMatchObject({ status: 'loading', key: keyOf(1) });
    await page.respond(page.requests[0]);
    expect(page.viewer.media.getState()).toMatchObject({ status: 'loaded', width: 1600 });
    expect(page.images()).toHaveLength(1);

    fire(page.parts.next, 'click');
    expect(page.parts.position.textContent).toBe('2 of 3');
    expect(page.viewer.media.getState()).toMatchObject({ status: 'loading', key: keyOf(2) });
    fire(page.dialog, 'keydown', { key: 'ArrowRight' });
    expect(page.viewer.getState().key).toBe(keyOf(3));
    expect(page.viewer.media.getState().key).toBe(keyOf(3));
    expect(page.requests.filter((request) => !request.aborted).map((request) => request.url))
      .toEqual(['/projects/7/assets/1/preview', '/projects/7/assets/3/preview']);
  });

  it('closes during a load with the usual focus return and nothing left behind', async () => {
    const page = mediaPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener });
    const pending = page.requests[0];
    fire(page.parts.close, 'click');
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    expect(pending.aborted).toBe(true);
    pending.resolve(new Response('x', { headers: { 'content-type': 'image/webp' } }));
    await page.respond(pending);
    expect(page.parts.media.children).toHaveLength(0);
    expect(page.live.size).toBe(0);
    expect(page.viewer.media.getState().status).toBe('idle');
    expect(page.dialog.querySelector('[data-unified-viewer-view-tools]').hidden).toBe(true);
  });

  it('hands later participants the media state of the change they observe', async () => {
    const page = mediaPage();
    const seen = [];
    page.viewer.observe((change) => seen.push(`${change.type}:${page.viewer.media.getState().status}`));
    const media = [];
    page.viewer.media.observe((state, reason) => media.push(`${reason}:${state.status}`));
    page.viewer.open(createViewerSource({ mode: 'sequence', items: [rawItem(1, { mediaUrl: null }), rawItem(2)], initialKey: keyOf(1) }), { opener: page.opener });
    page.viewer.next();
    await page.respond(page.requests[0]);
    page.viewer.close();
    expect(seen).toEqual(['open:unavailable', 'navigate:loading', 'close:idle']);
    expect(media).toEqual(['status:unavailable', 'status:loading', 'status:loaded', 'status:idle']);
  });

  it('keeps one loader and stable listeners across reopen cycles', async () => {
    const page = mediaPage();
    const baseline = allListenerCounts(page);
    for (let round = 0; round < 3; round += 1) {
      page.viewer.open(sequence([round + 1], { key: `round-${round}` }), { opener: page.opener });
      await page.respond(page.requests[page.requests.length - 1]);
      fire(page.parts.close, 'click');
    }
    expect(page.requests).toHaveLength(3);
    expect(page.live.size).toBe(0);
    expect(allListenerCounts(page)).toEqual(baseline);
  });

  it('removes the media participant with the controller', async () => {
    const page = mediaPage();
    page.viewer.open(sequence([1]), { opener: page.opener });
    await page.respond(page.requests[0]);
    page.viewer.destroy();
    expect(page.live.size).toBe(0);
    expect(page.parts.media.listeners).toHaveLength(0);
    expect(page.dialog.listeners.filter((listener) => listener.type === 'keydown')).toHaveLength(page.binderKeydowns);
  });
});

// ─── B4 playback and fullscreen integration ──────────────────────────────────

describe('unified viewer playback and fullscreen (B4)', () => {
  // A media page whose document also offers a scripted Fullscreen API: the
  // card enters on request, and exitFullscreen leaves, each followed by a
  // fullscreenchange event.
  function playbackPage({ fullscreen = true, holdRequests = false, holdExits = false } = {}) {
    const held = [];
    const heldExits = [];
    const page = mediaPage({
      beforeBind(page) {
        page.card = page.dialog.querySelector('[data-unified-viewer-card]');
        if (!fullscreen) return;
        page.document.fullscreenElement = null;
        page.document.fullscreenEnabled = true;
        page.document.exitFullscreen = vi.fn(() => {
          if (holdExits) {
            return new Promise((resolve, reject) => { heldExits.push({ resolve, reject }); });
          }
          page.document.fullscreenElement = null;
          fire(page.document, 'fullscreenchange');
          return Promise.resolve();
        });
        page.card.requestFullscreen = vi.fn(() => {
          if (holdRequests) {
            return new Promise((resolve, reject) => { held.push({ resolve, reject }); });
          }
          page.document.fullscreenElement = page.card;
          fire(page.document, 'fullscreenchange');
          return Promise.resolve();
        });
      },
    });
    // Chromium's late grant of a held request: the card goes fullscreen, the
    // inert page loses focus to <body>, fullscreenchange fires, then it resolves.
    page.grantHeld = async () => {
      page.document.activeElement = page.document.body;
      page.document.fullscreenElement = page.card;
      fire(page.document, 'fullscreenchange');
      held.shift().resolve();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    };
    page.rejectHeld = async () => {
      held.shift().reject(new TypeError('denied'));
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    };
    page.held = held;
    // A held exit lands: the card leaves fullscreen, fullscreenchange fires,
    // then the exit request resolves.
    page.leaveHeld = async () => {
      page.document.fullscreenElement = null;
      fire(page.document, 'fullscreenchange');
      heldExits.shift().resolve();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    };
    page.heldExits = heldExits;
    // Chromium's inert page while the card is fullscreen: focusing anything
    // outside the card silently fails (the binder's own return included).
    page.inert = (...elements) => elements.forEach((element) => {
      const focus = element.focus;
      element.focus = vi.fn(function inertFocus(...args) {
        if (page.document.fullscreenElement === page.card && !page.card.contains(this)) return undefined;
        return focus.apply(this, args);
      });
    });
    return page;
  }

  function slideshow(ids, withOriginal = false) {
    return createSlideshowSource({
      key: 'project-7-slideshow',
      label: 'Project Seven',
      entries: ids.map((id) => ({
        id,
        projectId: 7,
        filename: `image-${id}.png`,
        previewUrl: `/projects/7/assets/${id}/preview`,
        originalUrl: withOriginal ? `/projects/7/assets/${id}/original` : undefined,
        revision: 'r1',
      })),
    });
  }

  const controlsOf = (page) => ({
    playback: page.dialog.querySelector('[data-unified-viewer-playback]'),
    play: page.dialog.querySelector('[data-unified-viewer-play]'),
    speed: page.dialog.querySelector('[data-unified-viewer-speed]'),
    fullscreen: page.dialog.querySelector('[data-unified-viewer-fullscreen]'),
  });

  const settleTasks = async () => {
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows playback only for a playable slideshow and advances through the controller’s own steps', async () => {
    const page = playbackPage();
    const { playback, play } = controlsOf(page);
    const changes = [];
    page.viewer.observe((change) => changes.push(change));

    page.viewer.open(createSingleImageSource({
      key: 'one', entries: [{ id: 1, projectId: 7, previewUrl: '/projects/7/assets/1/preview' }], projectId: 7, assetId: 1,
    }), { opener: page.opener });
    expect(playback.hidden).toBe(true);
    expect(page.viewer.getState().playback).toEqual({ available: false, playing: false, speed: 4000 });
    page.viewer.close();

    page.viewer.open(slideshow([1, 2, 3]), { opener: page.opener });
    expect(playback.hidden).toBe(false);
    expect(play.getAttribute('aria-label')).toBe('Pause slideshow');
    expect(page.viewer.getState()).toMatchObject({ mediaStatus: 'loading', playback: { available: true, playing: true }, fullscreen: false });
    // Nothing advances while the first slide loads.
    vi.advanceTimersByTime(10_000);
    expect(page.viewer.getState().key).toBe(keyOf(1));
    await page.respond(page.requests.at(-1));
    vi.advanceTimersByTime(4000);
    expect(page.viewer.getState().key).toBe(keyOf(2));
    expect(changes.at(-1)).toMatchObject({ type: 'navigate', cause: 'playback', key: keyOf(2) });
    expect(page.viewer.playback.getState().playing).toBe(true);
    expect(page.parts.position.getAttribute('aria-live')).toBe('off');

    // A user step is marked as such and pauses.
    fire(page.parts.next, 'click');
    expect(changes.at(-1)).toMatchObject({ type: 'navigate', cause: 'user', key: keyOf(3) });
    expect(page.viewer.playback.getState()).toMatchObject({ playing: false, pauseReason: 'navigation' });
    expect(page.parts.position.getAttribute('aria-live')).toBe('polite');
    fire(page.dialog, 'keydown', { key: 'ArrowLeft' });
    expect(changes.at(-1)).toMatchObject({ cause: 'user', key: keyOf(2) });
  });

  it('plays, pauses and changes speed from the controls', async () => {
    const page = playbackPage();
    const { play, speed } = controlsOf(page);
    page.viewer.open(slideshow([1, 2, 3]), { opener: page.opener, autoplay: false });
    await page.respond(page.requests[0]);
    fire(play, 'click');
    expect(page.viewer.playback.getState().playing).toBe(true);
    speed.value = '2000';
    fire(speed, 'change');
    expect(page.viewer.getState().playback.speed).toBe(2000);
    vi.advanceTimersByTime(2000);
    expect(page.viewer.getState().key).toBe(keyOf(2));
    fire(play, 'click');
    expect(play.getAttribute('aria-label')).toBe('Play slideshow');
    expect(page.viewer.getState().key).toBe(keyOf(2));
  });

  it('pauses on a failed slide and Actual Size without fetching another rendition', async () => {
    const page = playbackPage();
    page.parts.media.clientWidth = 800;
    page.parts.media.clientHeight = 600;
    page.viewer.open(slideshow([1, 2, 3], true), { opener: page.opener });
    page.requests[0].resolve(new Response('', { status: 500 }));
    await settleTasks();
    expect(page.viewer.media.getState().status).toBe('failed');
    expect(page.viewer.playback.getState()).toMatchObject({ playing: false, pauseReason: 'media' });
    vi.advanceTimersByTime(30_000);
    expect(page.viewer.getState().key).toBe(keyOf(1));

    // Retry succeeds; playback stays paused until Play.
    fire(page.parts.media.querySelector('[data-unified-viewer-retry]'), 'click');
    await page.respond(page.requests.at(-1));
    expect(page.viewer.media.getState().status).toBe('loaded');
    vi.advanceTimersByTime(30_000);
    expect(page.viewer.playback.getState().playing).toBe(false);

    page.viewer.playback.play();
    expect(page.viewer.playback.getState().scheduled).toBe(true);
    fire(page.dialog.querySelector('[data-unified-viewer-original]'), 'click');
    expect(page.viewer.media.getState().view.scale).toBe(1);
    expect(page.viewer.playback.getState()).toMatchObject({ playing: false, scheduled: false, pauseReason: 'inspection' });
    fire(page.dialog.querySelector('[data-unified-viewer-fit]'), 'click');
    vi.advanceTimersByTime(30_000);
    expect(page.viewer.playback.getState().playing).toBe(false);
    expect(page.viewer.getState().key).toBe(keyOf(1));
  });

  it('enters fullscreen on the dialog card without reloading media or duplicating timers', async () => {
    const page = playbackPage();
    const { fullscreen } = controlsOf(page);
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    expect(fullscreen.hidden).toBe(false);
    const requestsBefore = page.requests.length;
    fire(fullscreen, 'click');
    await Promise.resolve();
    expect(page.card.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(page.viewer.getState().fullscreen).toBe(true);
    expect(page.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(true);
    expect(page.requests.length).toBe(requestsBefore);
    expect(page.viewer.media.getState()).toMatchObject({ status: 'loaded', key: keyOf(1) });
    // The slide interval plus the chrome idle timer; nothing else.
    expect(vi.getTimerCount()).toBe(2);
    expect(page.viewer.playback.getState().playing).toBe(true);
  });

  it('Escape exits fullscreen before the shared binder may close the dialog', async () => {
    const page = playbackPage();
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    page.viewer.fullscreen.enter();
    await Promise.resolve();
    fire(page.parts.next, 'keydown', { key: 'Escape' });
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.viewer.getState().fullscreen).toBe(false);
    expect(page.dialog.open).toBe(true);
    expect(page.viewer.getState().open).toBe(true);
    // Out of fullscreen, Escape dismisses as usual and focus returns.
    fire(page.parts.next, 'keydown', { key: 'Escape' });
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
  });

  it('an open speed dropdown takes Escape first, even in fullscreen', async () => {
    const page = playbackPage();
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    page.viewer.fullscreen.enter();
    await Promise.resolve();
    // C1f added the comic reader dropdowns before it; this is the speed one.
    const dropdown = page.dialog.querySelector('#unified-viewer-speed-dropdown');
    dropdown.open = true;
    dropdown.setAttribute('open', '');
    fire(dropdown.querySelector('summary'), 'keydown', { key: 'Escape' });
    expect(dropdown.hasAttribute('open')).toBe(false);
    expect(page.document.exitFullscreen).not.toHaveBeenCalled();
    expect(page.dialog.open).toBe(true);
  });

  it('backdrop dismissal clears the slideshow timer, pending media and live object URLs', async () => {
    const page = playbackPage();
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    expect(page.viewer.getState().playback.playing).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(page.live.size).toBeGreaterThan(0);
    fire(page.dialog, 'pointerdown', { pointerId: 1 });
    fire(page.dialog, 'pointerup', { pointerId: 1 });
    fire(page.dialog, 'click');
    expect(vi.getTimerCount()).toBe(0);
    expect(page.live.size).toBe(0);
    expect(page.viewer.getState()).toMatchObject({ open: false, mediaStatus: 'idle', playback: { playing: false } });
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    const pending = page.requests.at(-1);
    fire(page.dialog, 'pointerdown', { pointerId: 2 });
    fire(page.dialog, 'pointerup', { pointerId: 2 });
    fire(page.dialog, 'click');
    expect(pending.aborted).toBe(true);
  });

  it('closing from fullscreen exits it, restores focus and clears every timer', async () => {
    const page = playbackPage();
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    page.viewer.fullscreen.enter();
    await Promise.resolve();
    fire(page.parts.close, 'click');
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(page.viewer.getState()).toMatchObject({ open: false, fullscreen: false, playback: { available: false, playing: false } });
    // Reopening after fullscreen starts clean.
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    expect(page.viewer.getState().fullscreen).toBe(false);
    expect(page.card.hasAttribute('data-viewer-chrome-hidden')).toBe(false);
  });

  it('closing during a pending entry releases the late grant and returns focus to the opener', async () => {
    const page = playbackPage({ holdRequests: true });
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    fire(controlsOf(page).fullscreen, 'click');
    expect(page.viewer.fullscreen.getState().pending).toBe(true);
    fire(page.parts.close, 'click');
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    await page.grantHeld();
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.dialog.open).toBe(false);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
    expect(page.viewer.getState()).toMatchObject({ open: false, fullscreen: false, playback: { available: false, playing: false } });
    expect(page.card.hasAttribute('data-viewer-chrome-hidden')).toBe(false);
    expect(page.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a pending entry whose opener was replaced returns focus to the connected fallback', async () => {
    const page = playbackPage({ holdRequests: true });
    page.viewer.open(slideshow([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
    page.viewer.fullscreen.enter();
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.opener);
    page.opener.remove();
    await page.grantHeld();
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.document.activeElement).toBe(page.hostFallback);
  });

  it('a pending entry whose connected opener becomes hidden returns focus to the visible fallback', async () => {
    const page = playbackPage({ holdRequests: true });
    page.viewer.open(slideshow([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
    page.viewer.fullscreen.enter();
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.opener);
    page.opener.setAttribute('hidden', '');
    await page.grantHeld();
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.document.activeElement).toBe(page.hostFallback);
  });

  it('a pending entry refused after close leaves the binder focus alone', async () => {
    const page = playbackPage({ holdRequests: true });
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    page.viewer.fullscreen.enter();
    page.viewer.close();
    await page.rejectHeld();
    expect(page.document.exitFullscreen).not.toHaveBeenCalled();
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.viewer.getState().fullscreen).toBe(false);
  });

  it('a pending entry from a closed session never takes focus from the reopened viewer', async () => {
    const page = playbackPage({ holdRequests: true });
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    page.viewer.fullscreen.enter();
    page.viewer.close();
    const session = page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    page.parts.close.focus();
    await page.grantHeld();
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.viewer.getState()).toMatchObject({ open: true, session, fullscreen: false });
    expect(page.document.activeElement).not.toBe(page.opener);
  });

  it('destroying during a pending entry releases the late grant without reviving the viewer', async () => {
    const page = playbackPage({ holdRequests: true });
    const viewerTypes = ['visibilitychange', 'fullscreenchange', 'fullscreenerror', 'focusin'];
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    page.viewer.fullscreen.enter();
    page.viewer.destroy();
    const requestsBefore = page.requests.length;
    await page.grantHeld();
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.document.listeners.filter((listener) => viewerTypes.includes(listener.type))).toHaveLength(0);
    expect(page.card.listeners).toHaveLength(0);
    expect(page.requests.length).toBe(requestsBefore);
    expect(vi.getTimerCount()).toBe(0);
    expect(page.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    expect(controlsOf(page).fullscreen.hidden).toBe(true);
    page.viewer.destroy();
  });

  // F3: closed from active fullscreen, destroyed while the exit is underway.
  it('closing from fullscreen, then destroying before the exit lands, still returns focus to the opener', async () => {
    const page = playbackPage({ holdExits: true });
    page.inert(page.opener, page.hostFallback, page.main);
    const viewerTypes = ['visibilitychange', 'fullscreenchange', 'fullscreenerror', 'focusin'];
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    page.viewer.fullscreen.enter();
    await Promise.resolve();
    expect(page.document.fullscreenElement).toBe(page.card);
    controlsOf(page).fullscreen.focus();
    fire(page.parts.close, 'click');
    expect(page.dialog.open).toBe(false);
    expect(page.heldExits).toHaveLength(1);
    // The binder's own return failed on the inert page.
    expect(page.document.activeElement).not.toBe(page.opener);
    const requestsBefore = page.requests.length;
    page.viewer.destroy();
    await page.leaveHeld();
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.dialog.open).toBe(false);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(false);
    expect(page.document.listeners.filter((listener) => viewerTypes.includes(listener.type))).toHaveLength(0);
    expect(page.card.listeners).toHaveLength(0);
    expect(page.requests.length).toBe(requestsBefore);
    expect(controlsOf(page).fullscreen.hidden).toBe(true);
    expect(page.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(unifiedViewerFor(page.document)).toBe(null);
  });

  it('close() then destroy() in one task (dismissal still queued) returns focus once the exit lands', async () => {
    for (const openerState of ['visible', 'removed', 'hidden']) {
      const page = playbackPage({ holdExits: true });
      page.deferCloseEvents = true;
      page.inert(page.opener, page.hostFallback, page.main);
      page.viewer.open(slideshow([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
      await page.respond(page.requests[0]);
      page.viewer.fullscreen.enter();
      await Promise.resolve();
      controlsOf(page).fullscreen.focus();
      page.viewer.close();
      if (openerState === 'removed') page.opener.remove();
      if (openerState === 'hidden') page.opener.setAttribute('hidden', '');
      page.viewer.destroy();
      page.viewer.destroy();
      // The binder's queued dismissal runs without the viewer's hook; its
      // own focus return fails on the inert page.
      page.flushCloseEvents();
      expect(page.document.activeElement).not.toBe(page.opener);
      await page.leaveHeld();
      expect(page.document.activeElement).toBe(openerState === 'visible' ? page.opener : page.hostFallback);
      expect(page.document.listeners.filter((listener) => listener.type === 'focusin')).toHaveLength(0);
      expect(page.dialog.open).toBe(false);
    }
  });

  // F4: the same card rebound to a new controller while the destroyed one's
  // request is still outstanding.
  it('a destroyed controller\'s late request completion never exits the replacement controller\'s fullscreen', async () => {
    const page = playbackPage({ holdRequests: true });
    const first = page.viewer;
    first.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    expect(first.fullscreen.enter()).toBe(true);
    first.destroy();

    expect(enhanceUnifiedViewer(page.document)).toBe(1);
    const second = unifiedViewerFor(page.document);
    expect(second).not.toBe(first);
    second.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests.at(-1));
    expect(second.fullscreen.enter()).toBe(true);
    controlsOf(page).fullscreen.focus();
    page.document.fullscreenElement = page.card;
    fire(page.document, 'fullscreenchange');
    page.held[1].resolve();
    await settleTasks();
    expect(second.getState().fullscreen).toBe(true);
    const before = second.getState();
    const requestsBefore = page.requests.length;

    // The destroyed controller's completion is delivered last.
    page.held[0].resolve();
    await settleTasks();
    expect(page.document.exitFullscreen).not.toHaveBeenCalled();
    expect(page.document.fullscreenElement).toBe(page.card);
    expect(second.getState()).toMatchObject({ open: true, session: before.session, fullscreen: true, playback: before.playback });
    expect(page.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(true);
    expect(page.document.activeElement).toBe(controlsOf(page).fullscreen);
    expect(page.requests.length).toBe(requestsBefore);

    // The replacement leaves and closes normally.
    expect(second.fullscreen.exit()).toBe(true);
    expect(page.document.fullscreenElement).toBe(null);
    expect(second.getState()).toMatchObject({ open: true, fullscreen: false });
    second.close();
    expect(page.document.activeElement).toBe(page.opener);
    second.destroy();
  });

  it('a replacement controller cannot enter fullscreen while the destroyed controller\'s exit is still in flight (F5)', async () => {
    const page = playbackPage({ holdRequests: true, holdExits: true });
    const first = page.viewer;
    first.open(slideshow([1, 2, 3]), { opener: page.opener });
    await page.respond(page.requests[0]);
    expect(first.fullscreen.enter()).toBe(true);
    first.destroy();

    expect(enhanceUnifiedViewer(page.document)).toBe(1);
    const second = unifiedViewerFor(page.document);
    second.open(slideshow([1, 2, 3]), { opener: page.opener });
    await page.respond(page.requests.at(-1));
    // The destroyed controller's request is granted late and released: the
    // native exit is now in flight (held).
    await page.grantHeld();
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.heldExits).toHaveLength(1);

    const { fullscreen: button, play } = controlsOf(page);
    expect(second.fullscreen.getState()).toMatchObject({ active: false, pending: false, entryBlocked: true });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Enter fullscreen (unavailable while fullscreen closes)');
    expect(button.hidden).toBe(false);
    const playbackBefore = second.getState().playback;
    const requestsBefore = page.requests.length;

    // Both the direct call and the button are refused before the native API.
    expect(second.fullscreen.enter()).toBe(false);
    fire(button, 'click');
    expect(page.card.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(second.getState()).toMatchObject({ open: true, fullscreen: false, playback: playbackBefore });
    expect(page.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    // The viewer stays usable meanwhile.
    expect(play.hidden).toBe(false);
    second.next();
    expect(second.getState().index).toBe(1);

    // The old exit lands; the control is available again, nothing was queued.
    page.document.fullscreenElement = null;
    fire(page.document, 'fullscreenchange');
    page.heldExits.shift().resolve();
    await settleTasks();
    expect(second.fullscreen.getState()).toMatchObject({ active: false, entryBlocked: false });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Enter fullscreen');
    expect(page.card.requestFullscreen).toHaveBeenCalledTimes(1);

    // A fresh explicit request enters and holds.
    fire(button, 'click');
    expect(page.card.requestFullscreen).toHaveBeenCalledTimes(2);
    await page.grantHeld();
    expect(second.getState().fullscreen).toBe(true);
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.requests.length).toBeGreaterThanOrEqual(requestsBefore);
    second.destroy();
  });

  it('keeps the fullscreen button hidden where the API is missing', () => {
    const page = playbackPage({ fullscreen: false });
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    expect(controlsOf(page).fullscreen.hidden).toBe(true);
    expect(page.viewer.fullscreen.enter()).toBe(false);
  });

  it('removes every B4 listener and timer on destroy', async () => {
    const page = playbackPage();
    const viewerTypes = ['visibilitychange', 'fullscreenchange', 'fullscreenerror'];
    expect(page.document.listeners.filter((listener) => viewerTypes.includes(listener.type)).map((listener) => listener.type))
      .toEqual(['visibilitychange', 'fullscreenchange', 'fullscreenerror']);
    page.viewer.open(slideshow([1, 2]), { opener: page.opener });
    await page.respond(page.requests[0]);
    page.viewer.fullscreen.enter();
    await Promise.resolve();
    page.viewer.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.document.listeners.filter((listener) => viewerTypes.includes(listener.type))).toHaveLength(0);
    const { play, speed, fullscreen } = controlsOf(page);
    expect(play.listeners).toHaveLength(0);
    expect(speed.listeners).toHaveLength(0);
    expect(fullscreen.listeners).toHaveLength(0);
    expect(page.card.listeners).toHaveLength(0);
    expect(page.dialog.listeners.filter((listener) => listener.type === 'keydown')).toHaveLength(page.binderKeydowns);
  });
});

// ─── C1b: comic sessions ─────────────────────────────────────────────────────

describe('unified viewer comic sessions (C1b)', () => {
  const REV_A = 'a'.repeat(32);
  const REV_B = 'b'.repeat(32);
  const MANIFEST_URL = '/projects/7/assets/40/comic';
  const pageUrl = (position, revision = REV_A, assetId = 40) => `/projects/7/assets/${assetId}/comic/pages/${position}?v=${revision}`;
  const pageKey = (position, assetId = 40) => `p:7|a:${assetId}|n:${position}`;

  const settle = async () => {
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  function manifest({ assetId = 40, revision = REV_A, pages = [true, true, true] } = {}) {
    return {
      projectId: 7,
      assetId,
      format: 'cbz',
      revision,
      pageCount: pages.length,
      displayImageTypes: ['image/jpeg', 'image/png'],
      preparation: { solid: false, state: 'not-required' },
      unavailablePositions: pages.flatMap((available, index) => (available ? [] : [index + 1])),
      pages: pages.map((available, index) => ({
        position: index + 1,
        name: `${String(index + 1).padStart(3, '0')}.jpg`,
        available,
        problem: available ? null : 'PAGE_TOO_LARGE',
        url: pageUrl(index + 1, revision, assetId),
      })),
    };
  }

  // A media page whose fetch can also ignore aborts, so a "late" result can
  // still arrive after the viewer moved on (as a completed response does).
  function comicPage({ ignoreAbort = false, beforeBind } = {}) {
    const page = mediaPage({
      beforeBind(target) {
        target.document.defaultView.fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
          const request = { url, init, resolve, reject, aborted: false };
          init.signal?.addEventListener('abort', () => {
            request.aborted = true;
            if (!ignoreAbort) reject(new DOMException('Aborted', 'AbortError'));
          });
          target.comicRequests.push(request);
        }));
        target.comicRequests = [];
        beforeBind?.(target);
      },
    });
    page.requests = page.comicRequests;
    page.manifests = () => page.requests.filter((request) => /\/comic$/.test(request.url));
    page.pages = () => page.requests.filter((request) => request.url.includes('/comic/pages/'));
    page.json = async (request, body, { status = 200, type = 'application/json' } = {}) => {
      request.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status, headers: { 'content-type': type },
      }));
      await settle();
    };
    page.status = async (request, status) => {
      request.resolve(new Response('Internal detail', { status, headers: { 'content-type': 'text/plain' } }));
      await settle();
    };
    page.image = async (request) => {
      request.resolve(new Response('x', { headers: { 'content-type': 'image/jpeg' } }));
      await settle();
    };
    page.comicRetry = () => page.parts.media.querySelector('[data-unified-viewer-comic-retry]');
    page.pageRetry = (position = 1) => page.parts.media.querySelector(`[data-unified-viewer-page-retry="${pageKey(position)}"]`);
    page.open = (descriptor = {}, options = {}) => page.viewer.openComic(
      { projectId: 7, assetId: 40, title: 'Moon Saga #1', ...descriptor },
      { opener: page.opener, ...options },
    );
    return page;
  }

  it('retains archive metadata and canonical details through loading, failure, empty and ready states', async () => {
    const page = comicPage();
    const session = page.open({ filename: 'Moon  Saga #1.cbz', projectName: 'Moon project' });
    const assertContext = () => {
      expect(page.viewer.getState().context).toEqual({ projectId: '7', assetId: '40',
        filename: 'Moon  Saga #1.cbz', projectName: 'Moon project', detailsUrl: '/projects/7/assets/40' });
      expect(page.parts.title.textContent).toBe('Moon  Saga #1.cbz');
      expect(page.parts.details.getAttribute('href')).toBe('/projects/7/assets/40');
      expect(page.parts.details.hidden).toBe(false);
      expectDialogTitle(page, 'Comic Reader');
    };
    assertContext();
    await page.status(page.manifests()[0], 503);
    assertContext();
    page.viewer.retryComic();
    await page.json(page.manifests()[1], manifest({ pages: [] }));
    assertContext();
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 'next' }, { session });
    assertContext();
    await page.json(page.manifests()[2], manifest());
    assertContext();
    page.viewer.next();
    assertContext();
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, eligible: false }, { session });
    expect(page.viewer.getState().context).toBeNull();
    expect(page.parts.details.hasAttribute('href')).toBe(false);
  });

  it('accepts sparse comic metadata refreshes during a pending manifest without old context returning', async () => {
    const page = comicPage({ ignoreAbort: true });
    const session = page.open({ filename: 'old.cbz', projectName: 'Old', sourceRevision: 'h1' });
    const old = page.manifests()[0];
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, filename: 'new  comic.cbz', projectName: null,
      detailsUrl: '/projects/7/assets/40?pageSize=all', sourceRevision: 'h2' }, { session });
    await page.json(old, manifest());
    expect(page.viewer.getState()).toMatchObject({ comic: { state: 'loading' }, context: { filename: 'new  comic.cbz', projectName: null } });
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, filename: 'latest  comic.cbz', sourceRevision: 'h2' }, { session });
    await page.json(page.manifests()[1], manifest({ revision: REV_B }));
    expect(page.viewer.getState().context).toMatchObject({ filename: 'latest  comic.cbz', projectName: null, detailsUrl: '/projects/7/assets/40?pageSize=all' });
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 'h2' }, { session });
    expect(page.viewer.getState().context.filename).toBe('latest  comic.cbz');
    page.viewer.close();
  });

  it('updates ready comic metadata without page or manifest reloads and rejects foreign hints', async () => {
    const { page, session } = await readyComic({}, manifest(), { filename: 'old.cbz', projectName: 'Old' });
    await page.image(page.pages()[0]);
    const requests = page.requests.length;
    const image = page.images()[0];
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    expect(page.viewer.reconcileComic({ projectId: 8, assetId: 40, filename: 'foreign.cbz' }, { session })).toBeNull();
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, filename: 'stale.cbz' }, { session: session - 1 })).toBeNull();
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, filename: 'renamed.cbz', projectName: null }, { session });
    await settle();
    expect(page.requests).toHaveLength(requests);
    expect(page.images()[0]).toBe(image);
    expect(page.viewer.getState().context).toMatchObject({ filename: 'renamed.cbz', projectName: null });
    expect(changes.at(-1)).toMatchObject({ reason: 'metadata', reload: false, preserveView: true, context: { filename: 'renamed.cbz' } });
    page.viewer.close();
  });

  it('never revives withdrawn comic navigation from a late result or leaks context into a new session', async () => {
    const page = comicPage({ ignoreAbort: true });
    const session = page.open({ filename: 'old.cbz', projectName: 'Old' });
    const old = page.manifests()[0];
    page.viewer.reconcileComic(null, { session });
    await page.json(old, manifest());
    expect(page.viewer.getState().context).toBeNull();
    expect(page.parts.details.hasAttribute('href')).toBe(false);
    page.open({ assetId: 41, filename: 'new.cbz' });
    expect(page.viewer.getState().context).toEqual({ projectId: '7', assetId: '41', filename: 'new.cbz', projectName: null, detailsUrl: '/projects/7/assets/41' });
    page.viewer.close();
  });

  async function readyComic(options = {}, body = manifest(), descriptor = {}) {
    const page = comicPage(options);
    const session = page.open(descriptor);
    await page.json(page.manifests()[0], body);
    return { page, session };
  }

  it('keeps Comic Reader through loading, errors, empty manifests and accepted refreshes', async () => {
    const page = comicPage();
    page.open({ sourceRevision: 'h1' });
    expectDialogTitle(page, 'Comic Reader');
    await page.status(page.manifests()[0], 503);
    expect(page.viewer.getState().comic.state).toBe('failed');
    expectDialogTitle(page, 'Comic Reader');
    page.viewer.retryComic();
    await page.json(page.manifests()[1], manifest({ pages: [] }));
    expect(page.viewer.getState().comic.empty).toBe(true);
    expectDialogTitle(page, 'Comic Reader');
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 'h2' }, { session: page.viewer.getState().session });
    expectDialogTitle(page, 'Comic Reader');
    await page.json(page.manifests()[2], manifest({ revision: REV_B }));
    expect(page.viewer.getState().comic.revision).toBe(REV_B);
    expectDialogTitle(page, 'Comic Reader');
  });

  it('cannot restore a comic title from a late manifest after switching or reopening', async () => {
    const page = comicPage({ ignoreAbort: true });
    page.open();
    const first = page.manifests()[0];
    page.viewer.open(sequence([1], { slideshow: true }), { autoplay: false });
    expectDialogTitle(page, 'Slideshow');
    await page.json(first, manifest());
    expectDialogTitle(page, 'Slideshow');
    page.open();
    const second = page.manifests()[1];
    page.viewer.close();
    page.viewer.open(sequence([2], { mode: 'single' }));
    await page.status(second, 422);
    expectDialogTitle(page, 'Image Preview');
  });

  it('backdrop dismissal aborts pending manifests and reopens with a clean session', async () => {
    const page = comicPage({ ignoreAbort: true });
    const session = page.open();
    const request = page.manifests()[0];
    fire(page.dialog, 'pointerdown', { pointerId: 1 });
    fire(page.dialog, 'pointerup', { pointerId: 1 });
    fire(page.dialog, 'click');
    expect(request.aborted).toBe(true);
    expect(page.viewer.getState()).toMatchObject({ open: false, mediaStatus: 'idle', comic: null });
    expect(page.document.activeElement).toBe(page.opener);
    const next = page.open();
    expect(next).toBeGreaterThan(session);
    await page.json(request, manifest());
    expect(page.viewer.getState()).toMatchObject({ session: next, comic: { state: 'loading' } });
    expectDialogTitle(page, 'Comic Reader');
  });

  it('allocates the session and opens the one dialog at once in a loading state', () => {
    const page = comicPage();
    const session = page.open();
    expect(session).toBe(1);
    expect(page.dialog.open).toBe(true);
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(page.requests.map((request) => request.url)).toEqual([MANIFEST_URL]);
    const [request] = page.requests;
    expect(request.init).toMatchObject({ credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
    expect(page.viewer.getState()).toMatchObject({
      open: true,
      session: 1,
      key: null,
      count: 0,
      item: null,
      comic: { state: 'loading', projectId: 7, assetId: 40, revision: null, retryable: false },
    });
    expect(page.viewer.getState().source).toMatchObject({ kind: 'comic', key: 'comic:7:40', items: [] });
    expect(page.parts.title.textContent).toBe('Moon Saga #1');
    expect(page.parts.root.getAttribute('data-viewer-comic-state')).toBe('loading');
    expect(page.parts.media.querySelector('[data-unified-viewer-comic-loading]').children[1].textContent).toBe('Loading comic…');
    expect(page.parts.media.getAttribute('aria-busy')).toBe('true');
    expect(page.parts.status.textContent).toBe('');
    expect(page.parts.controls.hidden).toBe(true);
    expect(page.dialog.querySelector('[data-unified-viewer-playback]').hidden).toBe(true);
    expect(page.dialog.querySelector('[data-unified-viewer-view-tools]').hidden).toBe(true);
    expect(page.viewer.media.getState().status).toBe('idle');
  });

  it('refuses a descriptor without an authoritative identity, and a destroyed viewer', () => {
    const page = comicPage();
    expect(page.viewer.openComic({ projectId: 7 })).toBe(0);
    expect(page.viewer.openComic({ projectId: '7', assetId: 'x' })).toBe(0);
    expect(page.viewer.openComic(null)).toBe(0);
    expect(page.dialog.open).toBe(false);
    expect(page.requests).toHaveLength(0);
    page.viewer.destroy();
    expect(page.viewer.openComic({ projectId: 7, assetId: 40 })).toBe(0);
    expect(page.requests).toHaveLength(0);
  });

  it('publishes the validated manifest into the same session and dialog, on page 1', async () => {
    const page = comicPage();
    const seen = [];
    page.viewer.observe((change) => seen.push(`${change.type}:${change.session}:${change.reason}`));
    const session = page.open();
    const focusedBefore = page.document.activeElement;
    expect(focusedBefore).toBe(page.parts.close);
    await page.json(page.manifests()[0], manifest());
    expect(page.viewer.getState()).toMatchObject({
      session,
      key: pageKey(1),
      index: 0,
      count: 3,
      comic: { state: 'ready', revision: REV_A, pageCount: 3, empty: false },
    });
    expect(seen).toEqual(['open:1:null', 'update:1:manifest']);
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(page.document.activeElement).toBe(focusedBefore);
    expect(page.viewer.getState().source).toMatchObject({ wrap: false, slideshow: false, kind: 'comic' });
    expect(page.parts.position.textContent).toBe('Page 1 of 3');
    expect(page.parts.title.textContent).toBe('Moon Saga #1');
    expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1)]);
    expect(page.parts.media.getAttribute('aria-busy')).toBe('true');
    expect(page.parts.media.querySelector('[data-unified-viewer-page-loading]').children[1].textContent).toBe('Loading page 1…');

    await page.image(page.pages()[0]);
    expect(page.viewer.media.getState()).toMatchObject({ status: 'loaded', key: pageKey(1) });
    expect(page.images()).toHaveLength(1);
    expect(page.images()[0].getAttribute('alt')).toBe('Page 1');
    // No neighbour preload, no slideshow, no original-size action.
    expect(page.pages()).toHaveLength(1);
    expect(page.dialog.querySelector('[data-unified-viewer-playback]').hidden).toBe(true);
    expect(page.viewer.playback.getState().available).toBe(false);
    expect(page.dialog.querySelector('[data-unified-viewer-original]').hidden).toBe(true);
    expect(page.viewer.media.showOriginal()).toBe(false);
    expect(page.requests).toHaveLength(2);
  });

  it('navigates one canonical page at a time without wrapping, reaching unavailable pages', async () => {
    const { page } = await readyComic({}, manifest({ pages: [true, false, true] }));
    await page.image(page.pages()[0]);
    expect(page.parts.previous.disabled).toBe(true);
    expect(page.viewer.previous().moved).toBe(false);

    page.viewer.next({ skipUnavailable: true });
    expect(page.viewer.getState().key).toBe(pageKey(2));
    expect(page.parts.position.textContent).toBe('Page 2 of 3');
    expect(page.parts.status.textContent).toBe('Page unavailable.');
    expect(page.viewer.media.getState().status).toBe('unavailable');
    expect(page.pages()).toHaveLength(1);
    expect(page.live.size).toBe(0);

    fire(page.parts.next, 'click');
    expect(page.parts.position.textContent).toBe('Page 3 of 3');
    expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(3)]);
    expect(page.parts.next.disabled).toBe(true);
    expect(page.viewer.next().moved).toBe(false);
    expect(page.viewer.getState().key).toBe(pageKey(3));

    fire(page.dialog, 'keydown', { key: 'ArrowLeft' });
    expect(page.viewer.getState().key).toBe(pageKey(2));
    expect(page.pages().filter((request) => !request.aborted)).toHaveLength(1);
    fire(page.parts.previous, 'click');
    expect(page.viewer.getState().key).toBe(pageKey(1));
    expect(page.parts.position.textContent).toBe('Page 1 of 3');
  });

  it('keeps an unavailable first page selected and never skips ahead', async () => {
    const { page } = await readyComic({}, manifest({ pages: [false, true] }));
    expect(page.viewer.getState()).toMatchObject({ key: pageKey(1), index: 0 });
    expect(page.parts.status.textContent).toBe('Page unavailable.');
    expect(page.parts.position.textContent).toBe('Page 1 of 2');
    expect(page.pages()).toHaveLength(0);
    await settle();
    expect(page.viewer.getState().key).toBe(pageKey(1));
  });

  it('shows an empty comic as a successful session with nothing to navigate', async () => {
    const { page } = await readyComic({}, manifest({ pages: [] }));
    expect(page.viewer.getState()).toMatchObject({
      open: true, key: null, count: 0, comic: { state: 'ready', empty: true, pageCount: 0, retryable: false },
    });
    expect(page.parts.status.textContent).toBe('This comic contains no supported pages.');
    expect(page.parts.controls.hidden).toBe(true);
    expect(page.parts.media.children).toHaveLength(0);
    expect(page.parts.media.hasAttribute('aria-busy')).toBe(false);
    expect(page.viewer.next()).toMatchObject({ moved: false });
    expect(page.viewer.retryComic()).toBe(false);
    expect(page.pages()).toHaveLength(0);
    expect(page.dialog.open).toBe(true);
  });

  it('shows a one-page comic with disabled Previous/Next', async () => {
    const { page } = await readyComic({}, manifest({ pages: [true] }));
    expect(page.parts.position.textContent).toBe('Page 1 of 1');
    expect(page.parts.controls.hidden).toBe(false);
    expect(page.parts.previous.hidden).toBe(false);
    expect(page.parts.next.hidden).toBe(false);
    expect(page.parts.previous.disabled).toBe(true);
    expect(page.parts.next.disabled).toBe(true);
    fire(page.dialog, 'keydown', { key: 'ArrowRight' });
    expect(page.viewer.getState().key).toBe(pageKey(1));
  });

  it('closing during the pending manifest aborts it, restores focus and ignores a late success', async () => {
    const page = comicPage({ ignoreAbort: true });
    page.open();
    const [request] = page.manifests();
    fire(page.parts.close, 'click');
    expect(request.aborted).toBe(true);
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    await page.json(request, manifest());
    expect(page.dialog.open).toBe(false);
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(page.viewer.getState()).toMatchObject({ open: false, comic: null });
    expect(page.pages()).toHaveLength(0);
    expect(page.parts.media.children).toHaveLength(0);
    expect(page.document.activeElement).toBe(page.opener);
  });

  it('Escape during the pending manifest closes through the binder without a failure', async () => {
    const page = comicPage();
    page.open();
    const [request] = page.manifests();
    fire(page.parts.close, 'keydown', { key: 'Escape' });
    await settle();
    expect(request.aborted).toBe(true);
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.parts.status.textContent).toBe('');
  });

  it('replacing a comic with another aborts the first without a false error', async () => {
    const page = comicPage();
    page.open();
    const first = page.manifests()[0];
    const second = page.open({ assetId: 41, title: 'Moon Saga #2' });
    expect(second).toBe(2);
    expect(first.aborted).toBe(true);
    await settle();
    expect(page.viewer.getState()).toMatchObject({ session: 2, comic: { state: 'loading', assetId: 41 } });
    expect(page.parts.status.textContent).toBe('');
    // Like any source replacement (open() included), the one shared dialog is
    // re-shown in place; no second dialog exists.
    expect(page.dialog.showModal).toHaveBeenCalledTimes(2);
    expect(page.document.querySelectorAll('dialog')).toHaveLength(1);
    await page.json(page.manifests()[1], manifest({ assetId: 41 }));
    expect(page.viewer.getState()).toMatchObject({ session: 2, key: pageKey(1, 41), comic: { state: 'ready' } });
    expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1, REV_A, 41)]);
  });

  it('a late success or failure of an older comic never overwrites the newer one', async () => {
    const page = comicPage({ ignoreAbort: true });
    page.open();
    page.open({ assetId: 41 });
    const [older, newer] = page.manifests();
    await page.json(older, manifest());
    expect(page.viewer.getState()).toMatchObject({ session: 2, comic: { state: 'loading', assetId: 41 } });
    await page.json(newer, manifest({ assetId: 41 }));
    expect(page.viewer.getState()).toMatchObject({ session: 2, key: pageKey(1, 41), comic: { state: 'ready' } });

    const fresh = comicPage({ ignoreAbort: true });
    fresh.open();
    fresh.open({ assetId: 41 });
    await fresh.json(fresh.manifests()[1], manifest({ assetId: 41 }));
    await fresh.status(fresh.manifests()[0], 500);
    expect(fresh.viewer.getState()).toMatchObject({ session: 2, comic: { state: 'ready', error: null } });
    expect(fresh.parts.status.textContent).toBe('');
    expect(fresh.pages().map((request) => request.url)).toEqual([pageUrl(1, REV_A, 41)]);
  });

  it('opening a normal image while a comic loads ends the comic; its late manifest is ignored', async () => {
    const page = comicPage({ ignoreAbort: true });
    page.open();
    const [request] = page.manifests();
    const session = page.viewer.open(sequence([1, 2]), { opener: page.opener });
    expect(request.aborted).toBe(true);
    expect(page.viewer.getState()).toMatchObject({ session, comic: null, key: keyOf(1) });
    expect(page.parts.root.hasAttribute('data-viewer-comic-state')).toBe(false);
    await page.json(request, manifest());
    expect(page.viewer.getState()).toMatchObject({ session, comic: null, key: keyOf(1), count: 2 });
    expect(page.parts.position.textContent).toBe('1 of 2');
    expect(page.pages()).toHaveLength(0);
    // The image source keeps its own behaviour: the neighbour preloads.
    await page.image(page.requests.find((entry) => entry.url === '/projects/7/assets/1/preview'));
    expect(page.requests.map((entry) => entry.url)).toContain('/projects/7/assets/2/preview');
  });

  it('a comic replacing an image keeps the opener and leaves no image behind', async () => {
    const page = comicPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener });
    await page.image(page.requests[0]);
    expect(page.live.size).toBe(1);
    page.open({}, { opener: undefined });
    expect(page.live.size).toBe(0);
    expect(page.images()).toHaveLength(0);
    expect(page.parts.position.textContent).toBe('');
    expect(page.dialog.showModal).toHaveBeenCalledTimes(2);
    expect(page.document.querySelectorAll('dialog')).toHaveLength(1);
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.opener);
  });

  it('destroying during the pending manifest cancels it and nothing revives the viewer', async () => {
    const page = comicPage({ ignoreAbort: true });
    page.open();
    const [request] = page.manifests();
    page.viewer.destroy();
    expect(request.aborted).toBe(true);
    expect(page.dialog.open).toBe(false);
    await page.json(request, manifest());
    expect(page.dialog.open).toBe(false);
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(page.pages()).toHaveLength(0);
    expect(page.parts.media.children).toHaveLength(0);
    expect(page.comicRetry()).toBe(null);
  });

  it('shows source-level manifest failures without inventing pages', async () => {
    const cases = [
      [404, 'This comic could not be found.', false],
      [415, 'This comic could not be read.', false],
      [422, 'This comic could not be read.', false],
      [503, 'This comic is temporarily unavailable. Try again in a moment.', true],
      [500, 'This comic could not be loaded.', true],
    ];
    for (const [status, message, retryable] of cases) {
      const page = comicPage();
      page.open();
      await page.status(page.manifests()[0], status);
      expect(page.viewer.getState()).toMatchObject({
        open: true, key: null, count: 0,
        comic: { state: 'failed', error: 'http-error', httpStatus: status, retryable, message },
      });
      expect(page.dialog.open).toBe(true);
      expect(page.parts.status.textContent).toBe(message);
      expect(page.parts.root.getAttribute('data-viewer-comic-state')).toBe('failed');
      expect(page.parts.media.hasAttribute('aria-busy')).toBe(false);
      expect(Boolean(page.comicRetry())).toBe(retryable);
      expect(page.viewer.retryComic()).toBe(retryable);
      expect(page.pages()).toHaveLength(0);
      expect(page.manifests()).toHaveLength(retryable ? 2 : 1);
    }
  });

  it('rejects an HTML login page and a redirect as safe source failures', async () => {
    const page = comicPage();
    page.open();
    await page.json(page.manifests()[0], '<html><script>alert(1)</script>Sign in</html>', { type: 'text/html' });
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', error: 'not-json', retryable: true });
    expect(page.parts.status.textContent).toBe('This comic could not be loaded.');
    expect(page.parts.media.querySelectorAll('script')).toHaveLength(0);

    fire(page.comicRetry(), 'click');
    page.manifests()[1].resolve({ type: 'opaqueredirect', status: 0, ok: false, redirected: false, headers: new Headers(), body: null });
    await settle();
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', error: 'redirected', attempt: 1 });
    expect(page.pages()).toHaveLength(0);

    fire(page.comicRetry(), 'click');
    await page.json(page.manifests()[2], { ...manifest(), assetId: 41 });
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', error: 'invalid-manifest' });
    expect(page.pages()).toHaveLength(0);
  });

  it('a retryable manifest failure retries once per explicit Retry, keeping session and dialog', async () => {
    const page = comicPage();
    const session = page.open();
    await page.status(page.manifests()[0], 503);
    await settle();
    expect(page.manifests()).toHaveLength(1);
    page.comicRetry().focus();
    fire(page.comicRetry(), 'click');
    expect(page.document.activeElement).toBe(page.parts.close);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'loading', attempt: 1, message: '' });
    expect(page.parts.status.textContent).toBe('');
    expect(page.manifests()).toHaveLength(2);
    expect(page.viewer.retryComic()).toBe(false);
    await page.json(page.manifests()[1], manifest());
    expect(page.viewer.getState()).toMatchObject({ session, key: pageKey(1), comic: { state: 'ready' } });
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
  });

  it('keeps the page position for a failed page and retries it explicitly', async () => {
    for (const status of [404, 422, 503]) {
      const { page } = await readyComic();
      page.viewer.next();
      await page.status(page.pages()[1], status);
      expect(page.viewer.getState()).toMatchObject({ key: pageKey(2), comic: { state: 'ready', revision: REV_A } });
      expect(page.viewer.media.getState()).toMatchObject({ status: 'failed', httpStatus: status, key: pageKey(2) });
      expect(page.parts.position.textContent).toBe('Page 2 of 3');
      await settle();
      expect(page.pages()).toHaveLength(2);
      fire(page.pageRetry(2), 'click');
      expect(page.pages()).toHaveLength(3);
      expect(page.pages()[2].url).toBe(pageUrl(2));
      await page.image(page.pages()[2]);
      expect(page.viewer.media.getState()).toMatchObject({ status: 'loaded', key: pageKey(2) });
      page.viewer.next();
      expect(page.viewer.getState().key).toBe(pageKey(3));
    }
  });

  it('a current page 409 retires the whole revision, releases media and waits for Retry', async () => {
    const { page, session } = await readyComic();
    const seen = [];
    page.viewer.observe((change) => seen.push(`${change.type}:${change.reason}`));
    await page.image(page.pages()[0]);
    expect(page.live.size).toBe(1);
    page.parts.next.focus();
    fire(page.parts.next, 'click');
    expect(page.live.size).toBe(0);
    await page.status(page.pages()[1], 409);

    expect(seen).toEqual(['navigate:null', 'update:conflict']);
    expect(page.viewer.getState()).toMatchObject({
      open: true, session, key: null, count: 0,
      comic: { state: 'changed', revision: null, retryable: true, httpStatus: 409 },
    });
    expect(page.viewer.getState().source.items).toHaveLength(0);
    expect(page.dialog.open).toBe(true);
    expect(page.parts.status.textContent).toBe('This comic changed while it was open. Retry to load the current version.');
    expect(page.parts.controls.hidden).toBe(true);
    expect(page.images()).toHaveLength(0);
    expect(page.live.size).toBe(0);
    expect(page.viewer.media.getState()).toMatchObject({ status: 'idle', key: null });
    expect(page.document.activeElement).toBe(page.parts.close);
    // Old page URLs are gone: navigation and page Retry have nothing to load.
    expect(page.viewer.select(pageKey(1))).toBe(false);
    expect(page.viewer.media.retry()).toBe(false);
    await settle();
    expect(page.manifests()).toHaveLength(1);
    expect(page.pages()).toHaveLength(2);

    fire(page.comicRetry(), 'click');
    expect(page.manifests()).toHaveLength(2);
    expect(page.viewer.getState().comic.state).toBe('loading');
    await page.json(page.manifests()[1], manifest({ revision: REV_B, pages: [true, true] }));
    expect(page.viewer.getState()).toMatchObject({
      session, key: pageKey(1), count: 2, comic: { state: 'ready', revision: REV_B },
    });
    expect(page.parts.position.textContent).toBe('Page 1 of 2');
    expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2), pageUrl(1, REV_B)]);
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(seen.slice(2)).toEqual(['update:manifest']);
  });

  it('a failed recovery stays retryable and nothing loops', async () => {
    const { page } = await readyComic();
    await page.status(page.pages()[0], 409);
    fire(page.comicRetry(), 'click');
    await page.status(page.manifests()[1], 409);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', httpStatus: 409, retryable: true });
    await settle();
    expect(page.manifests()).toHaveLength(2);
    fire(page.comicRetry(), 'click');
    await page.status(page.manifests()[2], 503);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', retryable: true });
    await settle();
    expect(page.manifests()).toHaveLength(3);
    fire(page.comicRetry(), 'click');
    await page.json(page.manifests()[3], manifest({ revision: REV_B }));
    expect(page.viewer.getState().comic).toMatchObject({ state: 'ready', revision: REV_B });
    expect(page.pages().at(-1).url).toBe(pageUrl(1, REV_B));
  });

  it('late old-revision media never installs after the revision is retired', async () => {
    const { page, session } = await readyComic({ ignoreAbort: true }, manifest(), { sourceRevision: 's1' });
    const oldPage = page.pages()[0];
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
      .toEqual({ outcome: 'reloading' });
    expect(oldPage.aborted).toBe(true);
    await page.image(oldPage);
    expect(page.images()).toHaveLength(0);
    expect(page.live.size).toBe(0);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'loading', sourceRevision: 's2' });
    expect(page.manifests()).toHaveLength(2);
  });

  it('a stale 409 from an older session cannot retire the newer comic', async () => {
    const { page } = await readyComic({ ignoreAbort: true });
    const oldPage = page.pages()[0];
    page.open({ assetId: 41 });
    await page.json(page.manifests()[1], manifest({ assetId: 41 }));
    await page.status(oldPage, 409);
    expect(page.viewer.getState()).toMatchObject({ session: 2, key: pageKey(1, 41), comic: { state: 'ready', revision: REV_A } });
    expect(page.viewer.media.getState()).toMatchObject({ status: 'loading', key: pageKey(1, 41) });
    // An old-revision page of the same comic, answering after recovery, is
    // just as harmless.
    const oldRevision = page.pages()[1];
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 41, sourceRevision: 'x' }, { session: 2 }))
      .toEqual({ outcome: 'reloading' });
    await page.json(page.manifests()[2], manifest({ assetId: 41, revision: REV_B }));
    await page.status(oldRevision, 409);
    expect(page.viewer.getState()).toMatchObject({ session: 2, comic: { state: 'ready', revision: REV_B } });
    expect(page.viewer.media.getState()).toMatchObject({ status: 'loading', key: pageKey(1, 41) });
    expect(page.pages().at(-1).url).toBe(pageUrl(1, REV_B, 41));
  });

  it('reconciles host hints only for its own session and comic', async () => {
    const page = comicPage();
    const session = page.open({ sourceRevision: 's1' });
    // While loading, a changed hint restarts the one manifest request.
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
      .toEqual({ outcome: 'reloading' });
    expect(page.manifests()).toHaveLength(2);
    expect(page.manifests()[0].aborted).toBe(true);
    await page.json(page.manifests()[1], manifest());
    await page.image(page.pages()[0]);

    const loaded = page.requests.length;
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
      .toEqual({ outcome: 'unchanged' });
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40 }, { session })).toEqual({ outcome: 'unchanged' });
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's9' }, { session: session + 1 })).toBe(null);
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's9' })).toBe(null);
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 41, sourceRevision: 's9' }, { session })).toBe(null);
    expect(page.viewer.reconcileComic({ projectId: 8, assetId: 40, sourceRevision: 's9' }, { session })).toBe(null);
    expect(page.viewer.update([], { session })).toBe(null);
    expect(page.requests).toHaveLength(loaded);
    expect(page.viewer.media.getState().status).toBe('loaded');
    expect(page.viewer.getState().comic).toMatchObject({ state: 'ready', sourceRevision: 's2' });

    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, eligible: false }, { session }))
      .toEqual({ outcome: 'closed' });
    expect(page.dialog.open).toBe(false);
    expect(page.live.size).toBe(0);
    expect(page.document.activeElement).toBe(page.opener);
  });

  it('automatically refreshes a ready host revision, retiring page 2 before publishing page 1', async () => {
    const { page, session } = await readyComic({}, manifest(), { sourceRevision: 's1' });
    await page.image(page.pages()[0]);
    page.viewer.next();
    await page.image(page.pages()[1]);
    page.parts.media.clientWidth = 800;
    page.parts.media.clientHeight = 600;
    page.viewer.media.refreshGeometry();
    page.viewer.media.zoomIn();
    fire(page.dialog, 'keydown', { key: 'ArrowRight', shiftKey: true });
    const before = page.viewer.media.getState();
    const oldImage = page.images()[0];
    const listeners = allListenerCounts(page);
    const hint = (sourceRevision) => page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision }, { session });
    expect(before.status).toBe('loaded');
    expect(before.view.mode).toBe('zoom');
    expect(before.view.panX).toBe(-48);
    expect(hint('s1')).toEqual({ outcome: 'unchanged' });
    expect(hint(undefined)).toEqual({ outcome: 'unchanged' });
    expect(page.viewer.media.getState()).toEqual(before);
    expect(page.images()[0]).toBe(oldImage);
    expect(page.viewer.getState().key).toBe(pageKey(2));

    page.parts.close.focus();
    const refresh = hint('s2');
    expect(page.manifests()).toHaveLength(2);
    expect(refresh).toEqual({ outcome: 'reloading' });
    expect(page.viewer.getState()).toMatchObject({
      session, key: null, count: 0, comic: { state: 'loading', revision: null, sourceRevision: 's2' },
    });
    expect(page.images()).toHaveLength(0);
    expect(oldImage.isConnected).toBe(false);
    expect(page.live.size).toBe(0);
    expect(page.parts.media.getAttribute('aria-busy')).toBe('true');
    expect(page.parts.media.querySelector('[data-unified-viewer-comic-loading]')).not.toBe(null);
    expect(page.viewer.select(pageKey(2))).toBe(false);
    expect(page.viewer.media.retry()).toBe(false);
    expect(page.viewer.retryComic()).toBe(false);
    expect(hint('s2')).toEqual({ outcome: 'unchanged' });
    expect(page.manifests()).toHaveLength(2);
    expect(page.pages()).toHaveLength(2);

    await page.json(page.manifests()[1], manifest({ revision: REV_B, pages: [true, true] }));
    expect(page.viewer.getState()).toMatchObject({ session, key: pageKey(1), count: 2,
      comic: { state: 'ready', revision: REV_B, sourceRevision: 's2', error: null } });
    expect(page.viewer.getState().source).toMatchObject({ wrap: false, slideshow: false });
    expect(page.pages().at(-1).url).toBe(pageUrl(1, REV_B));
    await page.image(page.pages().at(-1));
    expect(page.images()).toHaveLength(1);
    expect(page.live.size).toBe(1);
    expect(hint('s2')).toEqual({ outcome: 'unchanged' });
    expect(page.manifests()).toHaveLength(2);
    expect(page.document.activeElement).toBe(page.parts.close);
    expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(allListenerCounts(page)).toEqual(listeners);
    page.viewer.close();
    expect(page.document.activeElement).toBe(page.opener);
    expect(page.live.size).toBe(0);
  });

  it.each(['success', 'failure'])('new host hints supersede pending manifests and ignore late %s', async (late) => {
    const page = comicPage({ ignoreAbort: true });
    const session = page.open({ sourceRevision: 's1' });
    const hint = (sourceRevision) => page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision }, { session });
    expect(hint('s2')).toEqual({ outcome: 'reloading' });
    expect(hint('s2')).toEqual({ outcome: 'unchanged' });
    expect(hint('s3')).toEqual({ outcome: 'reloading' });
    expect(page.manifests()).toHaveLength(3);
    expect(page.manifests().map((request) => request.aborted)).toEqual([true, true, false]);
    await page.json(page.manifests()[2], manifest({ revision: REV_B }));
    const accepted = page.viewer.getState();
    for (const request of page.manifests().slice(0, 2)) {
      if (late === 'success') await page.json(request, manifest());
      else await page.status(request, 422);
    }
    expect(page.viewer.getState()).toEqual(accepted);
    expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1, REV_B)]);
  });

  it.each([422, 503])('a new host hint recovers after HTTP %s, without same-hint retry loops', async (status) => {
    const page = comicPage();
    const session = page.open({ sourceRevision: 's1' });
    const hint = (sourceRevision) => page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision }, { session });
    await page.status(page.manifests()[0], status);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', httpStatus: status, retryable: status === 503 });
    expect(Boolean(page.comicRetry())).toBe(status === 503);
    page.comicRetry()?.focus();
    const refresh = hint('s2');
    expect(page.manifests()).toHaveLength(2);
    expect(refresh).toEqual({ outcome: 'reloading' });
    expect(page.viewer.getState().comic).toMatchObject({ state: 'loading', error: null, httpStatus: null });
    expect(page.document.activeElement).toBe(page.parts.close);
    expect(hint('s2')).toEqual({ outcome: 'unchanged' });
    await page.status(page.manifests()[1], status);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', httpStatus: status, sourceRevision: 's2' });
    expect(page.parts.status.textContent).not.toBe('');
    expect(page.live.size).toBe(0);
    expect(hint('s2')).toEqual({ outcome: 'unchanged' });
    await settle();
    expect(page.manifests()).toHaveLength(2);
    expect(page.dialog.open).toBe(true);
    expect(hint('s3')).toEqual({ outcome: 'reloading' });
    expect(page.manifests()).toHaveLength(3);
    await page.json(page.manifests()[2], manifest({ revision: REV_B }));
    expect(page.viewer.getState()).toMatchObject({ session, key: pageKey(1),
      comic: { state: 'ready', revision: REV_B, sourceRevision: 's3', error: null, httpStatus: null } });
    expect(page.comicRetry()).toBe(null);
  });

  it('a failed automatic refresh never restores old media and retains one explicit Retry callback', async () => {
    const { page, session } = await readyComic({}, manifest(), { sourceRevision: 's1' });
    await page.image(page.pages()[0]);
    const oldImage = page.images()[0];
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session });
    await page.status(page.manifests()[1], 503);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', retryable: true, httpStatus: 503 });
    expect(page.images()).toHaveLength(0);
    expect(oldImage.isConnected).toBe(false);
    expect(page.live.size).toBe(0);
    expect(page.viewer.getState().source.items).toHaveLength(0);
    const retry = page.comicRetry();
    expect(retry.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
    fire(retry, 'click');
    fire(retry, 'click');
    expect(page.manifests()).toHaveLength(3);
    await page.json(page.manifests()[2], manifest({ revision: REV_B }));
    await page.image(page.pages().at(-1));
    expect(page.images()).toHaveLength(1);
    expect(page.images()[0]).not.toBe(oldImage);
    expect(page.viewer.getState().comic.attempt).toBe(1);
    page.viewer.destroy();
    expect(retry.listeners).toHaveLength(0);
    expect(page.live.size).toBe(0);
  });

  it('a new host hint reloads an empty source and independently recovers a page conflict', async () => {
    const { page, session } = await readyComic({}, manifest({ pages: [] }), { sourceRevision: 's1' });
    const hint = (sourceRevision) => page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision }, { session });
    expect(hint('s2')).toEqual({ outcome: 'reloading' });
    expect(page.manifests()).toHaveLength(2);
    await page.json(page.manifests()[1], manifest());
    await page.status(page.pages()[0], 409);
    expect(page.viewer.getState().comic).toMatchObject({ state: 'changed', httpStatus: 409 });
    expect(hint('s2')).toEqual({ outcome: 'unchanged' });
    await settle();
    expect(page.manifests()).toHaveLength(2);
    expect(hint('s3')).toEqual({ outcome: 'reloading' });
    expect(page.manifests()).toHaveLength(3);
    await page.json(page.manifests()[2], manifest({ revision: REV_B }));
    expect(page.viewer.getState()).toMatchObject({ session, key: pageKey(1), comic: { state: 'ready', revision: REV_B } });
  });

  it('host retirement closes the viewer and closed or destroyed sessions ignore new hints', async () => {
    const { page, session } = await readyComic();
    expect(page.viewer.reconcileComic(null, { session })).toEqual({ outcome: 'closed' });
    const hint = { projectId: 7, assetId: 40, sourceRevision: 's2' };
    expect(page.viewer.reconcileComic(hint, { session })).toBe(null);
    expect(page.manifests()).toHaveLength(1);
    const second = page.open({ sourceRevision: 's1' });
    page.viewer.destroy();
    expect(page.viewer.reconcileComic(hint, { session: second })).toBe(null);
    expect(page.manifests()).toHaveLength(2);
    expect(page.manifests()[1].aborted).toBe(true);
    expect(page.dialog.open).toBe(false);
  });

  it('a passive retirement observer leaves exactly one automatic replacement request', async () => {
    const { page, session } = await readyComic({}, manifest(), { sourceRevision: 's1' });
    await page.image(page.pages()[0]);
    const listeners = allListenerCounts(page);
    const changes = [];
    const unobserve = page.viewer.observe((change) => changes.push(change.reason));
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session });
    const replacement = page.manifests()[1];
    expect(page.manifests()).toHaveLength(2);
    expect(replacement.aborted).toBe(false);
    expect(changes).toEqual(['source-changed']);
    await page.json(replacement, manifest({ revision: REV_B }));
    await page.image(page.pages().at(-1));
    const media = page.viewer.media.getState();
    const image = page.images()[0];
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
      .toEqual({ outcome: 'unchanged' });
    expect(page.viewer.media.getState()).toEqual(media);
    expect(page.images()[0]).toBe(image);
    expect(page.manifests()).toHaveLength(2);
    expect(changes).toEqual(['source-changed', 'manifest']);
    expect(allListenerCounts(page)).toEqual(listeners);
    unobserve();
  });

  describe.each(['hints', 'Retry'])('retirement observer starts %s', (action) => {
    it.each(['success', 'immediate success', 'failure', 'immediate failure'])(
      'keeps the observer request without duplication after %s', async (result) => {
        const { page, session } = await readyComic({ ignoreAbort: true }, manifest(), { sourceRevision: 's1' });
        await page.image(page.pages()[0]);
        page.viewer.next();
        const oldPage = page.pages().at(-1);
        const listeners = allListenerCounts(page);
        const changes = [];
        const hint = (sourceRevision) => page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision }, { session });
        let replacement;
        let retryStarted;
        let immediateAttempts = 0;
        page.viewer.observe((change) => {
          changes.push(change.reason);
          if (change.reason !== 'source-changed') return;
          if (result === 'immediate failure') {
            page.document.defaultView.fetch = () => {
              immediateAttempts += 1;
              throw new Error('Immediate network failure');
            };
          }
          if (action === 'hints') {
            hint('s3');
            hint('s2');
          } else {
            retryStarted = page.viewer.retryComic({ session });
          }
          replacement = page.manifests().at(-1);
          if (result === 'immediate success') {
            replacement.resolve(new Response(JSON.stringify(manifest({ revision: REV_B })), {
              headers: { 'content-type': 'application/json' },
            }));
          }
        });
        const originalFetch = page.document.defaultView.fetch;
        hint('s2');
        const attempts = action === 'hints' ? 3 : 2;
        // Synchronous fetch throws still count as request attempts.
        if (result === 'immediate failure') {
          page.document.defaultView.fetch = originalFetch;
          await settle();
          expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', sourceRevision: 's2', error: 'network' });
          expect(page.manifests()).toHaveLength(1);
          expect(immediateAttempts).toBe(action === 'hints' ? 2 : 1);
        } else {
          expect(page.manifests()).toHaveLength(attempts);
          expect(replacement).toBe(page.manifests()[attempts - 1]);
          expect(replacement.aborted).toBe(false);
          if (action === 'hints') expect(page.manifests()[1].aborted).toBe(true);
          if (result === 'success') await page.json(replacement, manifest({ revision: REV_B }));
          else if (result === 'failure') await page.status(replacement, 503);
          else await settle();
          expect(replacement.aborted).toBe(false);
          expect(page.manifests()).toHaveLength(attempts);
        }
        if (action === 'Retry') expect(retryStarted).toBe(true);
        const failed = result.includes('failure');
        expect(page.viewer.getState()).toMatchObject({ session,
          comic: { state: failed ? 'failed' : 'ready', sourceRevision: 's2', attempt: action === 'Retry' ? 1 : 0 } });
        expect(changes).toEqual(failed ? ['source-changed'] : ['source-changed', 'manifest']);
        const accepted = page.viewer.getState();
        await page.image(oldPage);
        if (action === 'hints' && result !== 'immediate failure') await page.json(page.manifests()[1], manifest());
        expect(page.viewer.getState()).toEqual(accepted);
        expect(page.images()).toHaveLength(0);
        const settledListeners = allListenerCounts(page);
        expect(hint('s2')).toEqual({ outcome: 'unchanged' });
        await settle();
        expect(page.manifests()).toHaveLength(result === 'immediate failure' ? 1 : attempts);
        expect(allListenerCounts(page)).toEqual(settledListeners);
        if (failed) {
          expect(page.comicRetry().listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
          hint('s4');
          expect(page.manifests()).toHaveLength(result === 'immediate failure' ? 2 : attempts + 1);
          await page.json(page.manifests().at(-1), manifest({ revision: REV_B }));
        }
        await page.image(page.pages().at(-1));
        expect(page.viewer.getState()).toMatchObject({ session, key: pageKey(1), comic: { state: 'ready', revision: REV_B } });
        expect(page.viewer.media.getState()).toMatchObject({ status: 'loaded', key: pageKey(1) });
        expect(page.images()).toHaveLength(1);
        expect(page.live.size).toBe(1);
        expect(allListenerCounts(page)).toEqual(listeners);
      },
    );
  });

  it.each(['close', 'destroy', 'replace', 'image', 'new-hint'])('does not request an obsolete host hint when a retirement observer chooses %s', async (action) => {
    const { page, session } = await readyComic({}, manifest(), { sourceRevision: 's1' });
    page.viewer.observe((change) => {
      if (change.reason !== 'source-changed') return;
      if (action === 'close') page.viewer.close();
      else if (action === 'destroy') page.viewer.destroy();
      else if (action === 'replace') page.open({ assetId: 41 });
      else if (action === 'image') page.viewer.open(sequence([1]), { opener: page.opener });
      else page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's3' }, { session });
    });
    page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session });
    expect(page.manifests()).toHaveLength(['close', 'destroy', 'image'].includes(action) ? 1 : 2);
    if (action === 'close' || action === 'destroy') expect(page.dialog.open).toBe(false);
    if (action === 'image') expect(page.viewer.getState()).toMatchObject({ session: session + 1, comic: null });
    if (action === 'replace') expect(page.manifests()[1].url).toBe('/projects/7/assets/41/comic');
    if (action === 'new-hint') expect(page.viewer.getState().comic.sourceRevision).toBe('s3');
  });

  it('keeps fullscreen through page loading, 409 retirement and recovery, then releases it on close', async () => {
    const page = comicPage({
      beforeBind(target) {
        target.card = target.dialog.querySelector('[data-unified-viewer-card]');
        target.document.fullscreenElement = null;
        target.document.fullscreenEnabled = true;
        target.document.exitFullscreen = vi.fn(() => {
          target.document.fullscreenElement = null;
          fire(target.document, 'fullscreenchange');
          return Promise.resolve();
        });
        target.card.requestFullscreen = vi.fn(() => {
          target.document.fullscreenElement = target.card;
          fire(target.document, 'fullscreenchange');
          return Promise.resolve();
        });
      },
    });
    page.open();
    page.viewer.fullscreen.enter();
    await Promise.resolve();
    expect(page.viewer.getState().fullscreen).toBe(true);
    await page.json(page.manifests()[0], manifest());
    expect(page.viewer.media.getState().status).toBe('loading');
    expect(page.viewer.getState().fullscreen).toBe(true);
    await page.status(page.pages()[0], 409);
    expect(page.viewer.getState()).toMatchObject({ fullscreen: true, comic: { state: 'changed' } });
    fire(page.comicRetry(), 'click');
    await page.json(page.manifests()[1], manifest({ revision: REV_B }));
    expect(page.viewer.getState()).toMatchObject({ fullscreen: true, comic: { state: 'ready', revision: REV_B } });
    expect(page.card.requestFullscreen).toHaveBeenCalledTimes(1);
    fire(page.parts.close, 'click');
    await settle();
    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.document.fullscreenElement).toBe(null);
    expect(page.dialog.open).toBe(false);
    expect(page.document.activeElement).toBe(page.opener);
    page.viewer.destroy();
  });

  it('repeated comic activation keeps one dialog and stable listeners, releasing everything', async () => {
    const page = comicPage();
    const baseline = allListenerCounts(page);
    for (let round = 0; round < 3; round += 1) {
      page.open();
      await page.json(page.manifests().at(-1), manifest());
      await page.image(page.pages().at(-1));
      expect(page.images()).toHaveLength(1);
      fire(page.parts.close, 'click');
      expect(page.document.activeElement).toBe(page.opener);
    }
    expect(page.dialog.showModal).toHaveBeenCalledTimes(3);
    expect(page.live.size).toBe(0);
    expect(page.dialog.querySelectorAll('[data-unified-viewer-comic-retry]')).toHaveLength(0);
    expect(allListenerCounts(page)).toEqual(baseline);
    expect(page.parts.media.children).toHaveLength(0);
    expect(page.parts.root.hasAttribute('data-viewer-comic-state')).toBe(false);
  });

  it('destroy after a ready comic releases media and removes the comic Retry listener', async () => {
    const { page } = await readyComic();
    await page.status(page.pages()[0], 409);
    const retry = page.comicRetry();
    expect(retry.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
    page.viewer.destroy();
    expect(retry.listeners).toHaveLength(0);
    expect(page.live.size).toBe(0);
    expect(page.parts.media.children).toHaveLength(0);
    expect(page.viewer.retryComic()).toBe(false);
    expect(page.viewer.reconcileComic(null, { session: 1 })).toBe(null);
  });

  it('leaves image sessions without a comic record', async () => {
    const page = comicPage();
    page.viewer.open(sequence([1, 2, 3]), { opener: page.opener });
    expect(page.viewer.getState().comic).toBe(null);
    expect(page.parts.position.textContent).toBe('1 of 3');
    expect(page.viewer.retryComic()).toBe(false);
    expect(page.viewer.reconcileComic({ projectId: 7, assetId: 1 }, { session: 1 })).toBe(null);
    expect(page.viewer.update([rawItem(1), rawItem(2)], { session: 1 })).toMatchObject({ key: keyOf(1) });
  });

  // ─── C1c: reading direction and spread grouping ───────────────────────────

  describe('reader options (C1c)', () => {
    const SEVEN = () => manifest({ pages: [true, true, true, true, true, true, true] });
    const reader = (page) => page.viewer.getState().reader;
    const positions = (items) => items.map((item) => item.position);

    it('starts every comic session on Left-to-Right, Single Page, Cover Alone', async () => {
      const page = comicPage();
      page.open();
      expect(reader(page)).toMatchObject({
        direction: 'ltr', layout: 'single', alignment: 'cover-alone',
        anchorKey: null, anchorPosition: null, groupKeys: [], visibleItems: [], canPrevious: false, canNext: false, label: '',
      });
      await page.json(page.manifests()[0], SEVEN());
      expect(reader(page)).toMatchObject({
        direction: 'ltr', layout: 'single', alignment: 'cover-alone',
        anchorKey: pageKey(1), anchorPosition: 1, groupPositions: [1], groupKeys: [pageKey(1)],
        groupIndex: 0, groupCount: 7, pageCount: 7, canPrevious: false, canNext: true, nextKey: pageKey(2), label: 'Page 1 of 7',
      });
      expect(positions(reader(page).visibleItems)).toEqual([1]);
      expect(Object.isFrozen(reader(page))).toBe(true);
    });

    it('validates options, rejecting invalid patches, other sessions and image sources', async () => {
      const { page, session } = await readyComic({}, SEVEN());
      const seen = [];
      page.viewer.observe((change) => seen.push(change.type));
      for (const bad of [null, 'rtl', { direction: 'up' }, { layout: 'double' }, { alignment: 'odd' }, { direction: 'rtl', layout: 'x' }]) {
        expect(page.viewer.setComicReaderOptions(bad)).toBe(null);
      }
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' }, { session: session + 1 })).toBe(null);
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      expect(seen).toEqual([]);

      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' }, { session })).toMatchObject({ changed: true, reader: { direction: 'rtl' } });
      expect(page.viewer.setComicReaderOptions({ layout: 'spread' })).toMatchObject({ changed: true, reader: { layout: 'spread' } });
      expect(page.viewer.setComicReaderOptions({ alignment: 'pair-from-first' })).toMatchObject({ changed: true, reader: { alignment: 'pair-from-first' } });
      expect(seen).toEqual(['reader', 'reader', 'reader']);

      page.viewer.open(sequence([1, 2, 3]), { opener: page.opener });
      expect(page.viewer.getState().reader).toBe(null);
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' })).toBe(null);
    });

    it('repeating the current options is a no-op without notifications or renders', async () => {
      const { page } = await readyComic({}, SEVEN());
      await page.image(page.pages()[0]);
      const seen = [];
      page.viewer.observe((change) => seen.push(change));
      expect(page.viewer.setComicReaderOptions({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' }))
        .toMatchObject({ changed: false });
      expect(page.viewer.setComicReaderOptions({})).toMatchObject({ changed: false });
      expect(seen).toHaveLength(0);
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        type: 'reader', key: pageKey(1), previousKey: pageKey(1), reload: false, preserveView: true,
        reason: 'reader-options', changed: ['layout'], previousReader: { layout: 'single' }, reader: { layout: 'spread' },
      });
    });

    it('preserves the anchor page across layout and alignment changes', async () => {
      const { page } = await readyComic({}, SEVEN());
      expect(page.viewer.select(pageKey(5))).toBe(true);
      expect(reader(page)).toMatchObject({ anchorPosition: 5, groupPositions: [5], label: 'Page 5 of 7' });

      page.viewer.setComicReaderOptions({ layout: 'spread' });
      expect(reader(page)).toMatchObject({
        anchorKey: pageKey(5), anchorPosition: 5, groupPositions: [4, 5], groupKeys: [pageKey(4), pageKey(5)],
        label: 'Pages 4–5 of 7', canPrevious: true, canNext: true, previousKey: pageKey(2), nextKey: pageKey(6),
      });
      page.viewer.setComicReaderOptions({ alignment: 'pair-from-first' });
      expect(reader(page)).toMatchObject({ anchorPosition: 5, groupPositions: [5, 6], label: 'Pages 5–6 of 7' });
      page.viewer.setComicReaderOptions({ layout: 'single' });
      expect(reader(page)).toMatchObject({ anchorPosition: 5, groupPositions: [5], label: 'Page 5 of 7' });
      expect(page.viewer.getState()).toMatchObject({ key: pageKey(5), index: 4 });
      // The shell still names the one rendered page.
      expect(page.parts.position.textContent).toBe('Page 5 of 7');
    });

    it('changes direction without a media request, view reset or session change', async () => {
      const { page, session } = await readyComic({}, SEVEN());
      await page.image(page.pages()[0]);
      page.viewer.next();
      await page.image(page.pages()[1]);
      page.parts.media.clientWidth = 800;
      page.parts.media.clientHeight = 600;
      page.viewer.media.refreshGeometry();
      // C1e: the spread [2,3] keeps page 2 and loads only its companion.
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2), pageUrl(3)]);
      await page.image(page.pages()[2]);
      page.viewer.media.zoomIn();
      fire(page.dialog, 'keydown', { key: 'ArrowRight', shiftKey: true });
      const media = page.viewer.media.getState();
      const images = page.images();
      expect(images).toHaveLength(2);
      const requests = page.requests.length;
      const sourceBefore = page.viewer.getState().source;
      page.parts.next.focus();

      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      expect(reader(page)).toMatchObject({ direction: 'rtl', anchorPosition: 2, groupPositions: [2, 3] });
      expect(positions(reader(page).visibleItems)).toEqual([3, 2]);
      expect(positions(reader(page).groupItems)).toEqual([2, 3]);
      expect(page.viewer.media.getState()).toEqual(media);
      expect(media.view.mode).toBe('zoom');
      expect(media.view.panX).toBe(-48);
      expect(page.images()).toEqual(images);
      expect(page.requests).toHaveLength(requests);
      expect(page.viewer.getState()).toMatchObject({ session, key: pageKey(2), open: true });
      expect(page.viewer.getState().source).toBe(sourceBefore);
      expect(page.viewer.getState().source.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(page.document.activeElement).toBe(page.parts.next);
      expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
      expect(page.parts.position.textContent).toBe('Pages 2–3 of 7');
    });

    it('a reader change during a page load keeps the anchor request and adds only its companion', async () => {
      const { page } = await readyComic({}, SEVEN());
      expect(page.viewer.media.getState().status).toBe('loading');
      const statusBefore = page.parts.status.textContent;
      page.viewer.setComicReaderOptions({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2)]);
      expect(page.pages()[0].aborted).toBe(false);
      expect(page.viewer.media.getState().status).toBe('loading');
      expect(page.parts.status.textContent).toBe(statusBefore);
      expect(page.parts.media.getAttribute('aria-busy')).toBe('true');
      await page.image(page.pages()[0]);
      expect(page.viewer.media.getState()).toMatchObject({ status: 'loaded', key: pageKey(1) });
      await page.image(page.pages()[1]);
      expect(page.viewer.media.getState().pages.map((entry) => entry.status)).toEqual(['loaded', 'loaded']);
      expect(page.pages()).toHaveLength(2);
    });

    it('steps whole spreads to the first page of each group, Cover Alone and Pair from Page 1', async () => {
      const { page } = await readyComic({}, SEVEN());
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      const walk = [];
      const labels = [];
      for (let index = 0; index < 5; index += 1) {
        walk.push(reader(page).groupPositions);
        labels.push(reader(page).label);
        page.viewer.next();
      }
      expect(walk).toEqual([[1], [2, 3], [4, 5], [6, 7], [6, 7]]);
      expect(labels).toEqual(['Page 1 of 7', 'Pages 2–3 of 7', 'Pages 4–5 of 7', 'Pages 6–7 of 7', 'Pages 6–7 of 7']);
      expect(page.viewer.getState().key).toBe(pageKey(6));
      expect(page.parts.next.disabled).toBe(true);
      expect(page.viewer.next()).toMatchObject({ moved: false, boundary: 'end' });

      page.viewer.select(pageKey(5));
      expect(page.viewer.next()).toMatchObject({ moved: true, key: pageKey(6) });
      page.viewer.select(pageKey(5));
      expect(page.viewer.previous()).toMatchObject({ moved: true, key: pageKey(2) });

      page.viewer.setComicReaderOptions({ alignment: 'pair-from-first' });
      page.viewer.select(pageKey(1));
      const pairs = [];
      for (let index = 0; index < 5; index += 1) {
        pairs.push(reader(page).groupPositions);
        fire(page.parts.next, 'click');
      }
      expect(pairs).toEqual([[1, 2], [3, 4], [5, 6], [7], [7]]);
      expect(page.parts.next.disabled).toBe(true);
      expect(page.parts.previous.disabled).toBe(false);
      fire(page.parts.previous, 'click');
      expect(reader(page)).toMatchObject({ anchorPosition: 5, groupPositions: [5, 6] });
    });

    it('takes group boundaries from the group, not the anchor index', async () => {
      const { page } = await readyComic({}, SEVEN());
      page.viewer.select(pageKey(6));
      expect(page.parts.next.disabled).toBe(false);
      page.parts.next.focus();
      // Page 6 joins the last spread [6,7]: Next is now unavailable.
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      expect(reader(page)).toMatchObject({ groupPositions: [6, 7], canNext: false, canPrevious: true });
      expect(page.parts.next.disabled).toBe(true);
      expect(page.document.activeElement).toBe(page.parts.previous);
      // Pair from Page 1 opens a later group again.
      page.viewer.setComicReaderOptions({ alignment: 'pair-from-first' });
      expect(reader(page)).toMatchObject({ groupPositions: [5, 6], canNext: true });
      expect(page.parts.next.disabled).toBe(false);
      // From the second member of the first spread, Previous still has nowhere to go.
      page.viewer.select(pageKey(2));
      expect(page.parts.previous.disabled).toBe(true);
      expect(page.viewer.previous()).toMatchObject({ moved: false, boundary: 'start', key: pageKey(2) });
    });

    it('keeps single-page navigation one page at a time, including unavailable pages', async () => {
      const { page } = await readyComic({}, manifest({ pages: [true, false, false, true, true] }));
      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      const visited = [];
      for (let index = 0; index < 5; index += 1) {
        visited.push(page.viewer.getState().index + 1);
        page.viewer.next();
      }
      expect(visited).toEqual([1, 2, 3, 4, 5]);
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      page.viewer.select(pageKey(1));
      page.viewer.next();
      expect(reader(page)).toMatchObject({ anchorPosition: 2, groupPositions: [2, 3] });
      expect(reader(page).groupItems.map((item) => item.available)).toEqual([false, false]);
      // C1e: both shown pages are named; neither is ever requested.
      expect(page.parts.status.textContent).toBe('Page 2 is unavailable. Page 3 is unavailable.');
      expect(page.pages().some((request) => /pages\/[23]\?/.test(request.url))).toBe(false);
    });

    it('maps arrows by reading direction, one page or one spread at a time', async () => {
      const { page } = await readyComic({}, SEVEN());
      const key = (name, extra = {}) => fire(page.parts.close, 'keydown', { key: name, ...extra });
      expect(key('ArrowRight').defaultPrevented).toBe(true);
      expect(page.viewer.getState().key).toBe(pageKey(2));
      key('ArrowLeft');
      expect(page.viewer.getState().key).toBe(pageKey(1));

      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      expect(key('ArrowLeft').defaultPrevented).toBe(true);
      expect(page.viewer.getState().key).toBe(pageKey(2));
      key('ArrowLeft');
      expect(page.viewer.getState().key).toBe(pageKey(3));
      key('ArrowRight');
      expect(page.viewer.getState().key).toBe(pageKey(2));

      page.viewer.setComicReaderOptions({ layout: 'spread' });
      key('ArrowLeft');
      expect(reader(page)).toMatchObject({ anchorPosition: 4, groupPositions: [4, 5] });
      key('ArrowRight');
      expect(reader(page)).toMatchObject({ anchorPosition: 2, groupPositions: [2, 3] });
      key('ArrowRight');
      expect(reader(page)).toMatchObject({ anchorPosition: 1 });
      // At the start, RTL Previous (ArrowRight) does not wrap.
      key('ArrowRight');
      expect(reader(page)).toMatchObject({ anchorPosition: 1 });

      page.viewer.setComicReaderOptions({ direction: 'ltr' });
      key('ArrowRight');
      expect(reader(page)).toMatchObject({ anchorPosition: 2 });
    });

    it('leaves Shift+Arrow panning, modifiers and key-owning controls alone in RTL', async () => {
      const { page } = await readyComic({}, SEVEN());
      await page.image(page.pages()[0]);
      page.parts.media.clientWidth = 800;
      page.parts.media.clientHeight = 600;
      page.viewer.media.refreshGeometry();
      page.viewer.media.zoomIn();
      page.viewer.setComicReaderOptions({ direction: 'rtl', layout: 'spread' });
      const panBefore = page.viewer.media.getState().view.panX;
      fire(page.dialog, 'keydown', { key: 'ArrowRight', shiftKey: true });
      // Physical panning: ArrowRight still pans the same way as in LTR.
      expect(page.viewer.media.getState().view.panX).toBe(panBefore - 48);
      expect(page.viewer.getState().key).toBe(pageKey(1));
      for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
        expect(fire(page.parts.close, 'keydown', { key: 'ArrowLeft', [modifier]: true }).defaultPrevented).toBe(false);
      }
      const tools = page.dialog.querySelector('[data-unified-viewer-view-tools]');
      const input = makeElement('input', { type: 'text' });
      const select = makeElement('select');
      const radio = makeElement('input', { type: 'radio' });
      const dropdown = makeElement('details', { 'data-cc-dropdown': '' });
      const summary = makeElement('summary');
      dropdown.appendChild(summary);
      [input, select, radio, dropdown].forEach((control) => tools.appendChild(control));
      for (const target of [input, select, radio, summary]) {
        expect(fire(target, 'keydown', { key: 'ArrowLeft' }).defaultPrevented).toBe(false);
        expect(fire(target, 'keydown', { key: 'ArrowRight' }).defaultPrevented).toBe(false);
      }
      dropdown.setAttribute('open', '');
      fire(page.parts.close, 'keydown', { key: 'ArrowLeft' });
      dropdown.removeAttribute('open');
      expect(page.viewer.getState().key).toBe(pageKey(1));
      fire(page.parts.close, 'keydown', { key: 'ArrowLeft' });
      expect(page.viewer.getState().key).toBe(pageKey(2));
    });

    it('keeps image arrow keys, wrapping and slideshow unaffected by comic options', async () => {
      const { page } = await readyComic({}, SEVEN());
      page.viewer.setComicReaderOptions({ direction: 'rtl', layout: 'spread' });
      page.viewer.open(sequence([1, 2, 3], { wrap: true }), { opener: page.opener });
      expect(page.viewer.getState().reader).toBe(null);
      fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
      expect(page.viewer.getState().key).toBe(keyOf(2));
      fire(page.parts.close, 'keydown', { key: 'ArrowLeft' });
      fire(page.parts.close, 'keydown', { key: 'ArrowLeft' });
      expect(page.viewer.getState().key).toBe(keyOf(3));
      expect(page.parts.position.textContent).toBe('3 of 3');
      expect(page.parts.next.disabled).toBe(false);
      page.open({ assetId: 41 });
      await page.json(page.manifests().at(-1), manifest({ assetId: 41 }));
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      page.open();
      await page.json(page.manifests().at(-1), SEVEN());
      expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone' });
    });

    it('options set while the manifest is pending apply to the published comic from page 1', async () => {
      const page = comicPage();
      const seen = [];
      page.viewer.observe((change) => seen.push(change.type));
      page.open();
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' }))
        .toMatchObject({ changed: true, reader: { anchorKey: null, groupKeys: [] } });
      expect(page.manifests()).toHaveLength(1);
      expect(page.parts.media.querySelector('[data-unified-viewer-comic-loading]')).toBeTruthy();
      await page.json(page.manifests()[0], SEVEN());
      expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread', anchorPosition: 1, groupPositions: [1, 2] });
      expect(positions(reader(page).visibleItems)).toEqual([2, 1]);
      expect(seen).toEqual(['open', 'reader', 'update']);
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2)]);
    });

    it('a late manifest of a replaced session cannot touch the newer session’s reader state', async () => {
      const page = comicPage({ ignoreAbort: true });
      page.open();
      page.viewer.setComicReaderOptions({ direction: 'rtl', layout: 'spread' });
      const first = page.manifests()[0];
      const second = page.open({ assetId: 41 });
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      page.viewer.setComicReaderOptions({ layout: 'spread', alignment: 'pair-from-first' }, { session: second });
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' }, { session: 1 })).toBe(null);
      await page.json(first, SEVEN());
      expect(page.viewer.getState()).toMatchObject({ session: second, key: null, comic: { state: 'loading', assetId: 41 } });
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'spread', alignment: 'pair-from-first' });
      await page.json(page.manifests()[1], manifest({ assetId: 41, pages: [true, true, true] }));
      expect(reader(page)).toMatchObject({ anchorKey: pageKey(1, 41), groupPositions: [1, 2], pageCount: 3 });
    });

    it('a 409 retires the spread; Retry restarts at page 1 grouped from the new page count', async () => {
      const { page, session } = await readyComic({}, SEVEN());
      page.viewer.setComicReaderOptions({ layout: 'spread', direction: 'rtl' });
      page.viewer.select(pageKey(5));
      expect(reader(page)).toMatchObject({ groupPositions: [4, 5] });
      const conflict = page.pages().at(-1);
      expect(conflict.url).toBe(pageUrl(5));
      await page.status(conflict, 409);
      expect(page.viewer.getState()).toMatchObject({ session, key: null, comic: { state: 'changed', httpStatus: 409 } });
      expect(reader(page)).toMatchObject({
        direction: 'rtl', layout: 'spread', anchorKey: null, groupKeys: [], visibleItems: [], canNext: false, label: '',
      });
      expect(page.viewer.next()).toMatchObject({ moved: false });
      expect(page.viewer.select(pageKey(5))).toBe(false);
      fire(page.comicRetry(), 'click');
      await page.json(page.manifests()[1], manifest({ revision: REV_B, pages: [true, true, true, true] }));
      expect(reader(page)).toMatchObject({
        direction: 'rtl', layout: 'spread', anchorKey: pageKey(1), groupPositions: [1], groupCount: 3, pageCount: 4,
      });
      page.viewer.next();
      page.viewer.next();
      expect(reader(page)).toMatchObject({ anchorPosition: 4, groupPositions: [4], label: 'Page 4 of 4', canNext: false });
      // Page 4 starts once the aborted [2,3] attempts have settled (C1e bound).
      await settle();
      expect(page.pages().at(-1).url).toBe(pageUrl(4, REV_B));
    });

    it('a changed host hint refreshes once; old positions never survive the new manifest', async () => {
      const { page, session } = await readyComic({}, SEVEN(), { sourceRevision: 's1' });
      page.viewer.setComicReaderOptions({ layout: 'spread', alignment: 'pair-from-first' });
      page.viewer.select(pageKey(7));
      expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
        .toEqual({ outcome: 'reloading' });
      expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
        .toEqual({ outcome: 'unchanged' });
      expect(page.manifests()).toHaveLength(2);
      expect(reader(page).anchorKey).toBe(null);
      await page.json(page.manifests()[1], manifest({ revision: REV_B, pages: [true, true, true] }));
      expect(reader(page)).toMatchObject({ anchorPosition: 1, groupPositions: [1, 2], pageCount: 3, layout: 'spread' });
      expect(page.viewer.select(pageKey(7))).toBe(false);
      await settle();
      expect(page.manifests()).toHaveLength(2);
    });

    it('reader-change observers that re-enter keep requests deduplicated', async () => {
      const { page, session } = await readyComic({}, SEVEN(), { sourceRevision: 's1' });
      let reentered = false;
      page.viewer.observe((change) => {
        if (change.type !== 'reader' || reentered) return;
        reentered = true;
        page.viewer.setComicReaderOptions({ layout: 'spread' });
        page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session });
      });
      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread' });
      expect(page.manifests()).toHaveLength(2);
      page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session });
      await settle();
      expect(page.manifests()).toHaveLength(2);
    });

    it('is safe after Close and Destroy', async () => {
      const { page, session } = await readyComic({}, SEVEN());
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      fire(page.parts.close, 'click');
      expect(page.viewer.getState().reader).toBe(null);
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' })).toBe(null);
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' }, { session })).toBe(null);
      expect(page.document.activeElement).toBe(page.opener);
      page.open();
      page.viewer.destroy();
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' })).toBe(null);
      expect(fire(page.dialog, 'keydown', { key: 'ArrowLeft' }).defaultPrevented).toBe(false);
    });

    it('keeps fullscreen and the dialog through reader-option changes and spread navigation', async () => {
      const page = comicPage({
        beforeBind(target) {
          target.card = target.dialog.querySelector('[data-unified-viewer-card]');
          target.document.fullscreenElement = null;
          target.document.fullscreenEnabled = true;
          target.document.exitFullscreen = vi.fn(() => {
            target.document.fullscreenElement = null;
            fire(target.document, 'fullscreenchange');
            return Promise.resolve();
          });
          target.card.requestFullscreen = vi.fn(() => {
            target.document.fullscreenElement = target.card;
            fire(target.document, 'fullscreenchange');
            return Promise.resolve();
          });
        },
      });
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      page.viewer.fullscreen.enter();
      await Promise.resolve();
      expect(page.viewer.getState().fullscreen).toBe(true);
      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      page.viewer.setComicReaderOptions({ layout: 'spread', alignment: 'pair-from-first' });
      fire(page.parts.close, 'keydown', { key: 'ArrowLeft' });
      expect(reader(page)).toMatchObject({ anchorPosition: 3, groupPositions: [3, 4] });
      expect(page.viewer.getState().fullscreen).toBe(true);
      expect(page.document.exitFullscreen).not.toHaveBeenCalled();
      expect(page.card.requestFullscreen).toHaveBeenCalledTimes(1);
      expect(page.dialog.open).toBe(true);
      expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
      fire(page.parts.close, 'click');
      await settle();
      expect(page.document.fullscreenElement).toBe(null);
      expect(page.document.activeElement).toBe(page.opener);
      page.viewer.destroy();
    });

    // ── C1e: the spread is rendered by the content participant ──────────────

    const loadedSpread = async (options = {}, body = SEVEN(), descriptor = {}) => {
      const ready = await readyComic(options, body, descriptor);
      const { page } = ready;
      await page.image(page.pages()[0]);
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      page.viewer.next();
      return ready;
    };

    const focusedFailedPair = async (position = 1, options = {}) => {
      const ready = await readyComic(options, SEVEN(), { sourceRevision: 's1' });
      const { page } = ready;
      page.viewer.setComicReaderOptions({ layout: 'spread', alignment: 'pair-from-first' });
      await page.status(page.pages()[position - 1], 503);
      const retry = page.pageRetry(position);
      retry.focus();
      expect(page.document.activeElement).toBe(retry);
      return { ...ready, retry, conflict: page.pages()[position === 1 ? 1 : 0] };
    };

    it.each([1, 2])('rescues focused Retry page %s after the companion retires the revision', async (position) => {
      const { page, session, retry, conflict } = await focusedFailedPair(position);
      const oldFocus = vi.spyOn(retry, 'focus');
      await page.status(conflict, 409);
      const sourceRetry = page.comicRetry();
      expect(retry.isConnected).toBe(false);
      expect(oldFocus).not.toHaveBeenCalled();
      expect(sourceRetry.isConnected).toBe(true);
      expect(page.document.activeElement).toBe(sourceRetry);
      expect(page.dialog.contains(page.document.activeElement)).toBe(true);
      expect(page.viewer.getState()).toMatchObject({ session, open: true, comic: { state: 'changed' } });
      expect(page.viewer.media.getState()).toMatchObject({ status: 'idle', pages: [], pageRequests: 0 });
      expect(page.live.size).toBe(0);
      expect(page.manifests()).toHaveLength(1);
      expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
      const recoveryFocus = vi.spyOn(sourceRetry, 'focus');
      await page.status(conflict, 409);
      expect(recoveryFocus).not.toHaveBeenCalled();
      fire(sourceRetry, 'click');
      expect(page.manifests()).toHaveLength(2);
      expect(page.document.activeElement).toBe(page.parts.close);
      await page.json(page.manifests()[1], manifest({ revision: REV_B }));
      expect(reader(page)).toMatchObject({ anchorPosition: 1, layout: 'spread', alignment: 'pair-from-first' });
      page.viewer.close();
      expect(page.document.activeElement).toBe(page.opener);
    });

    it.each(['absent', 'disabled'])('uses Close when replacement source Retry is %s', async (condition) => {
      const { page, conflict } = await focusedFailedPair();
      const replace = page.parts.media.replaceChildren;
      vi.spyOn(page.parts.media, 'replaceChildren').mockImplementation(function (...nodes) {
        replace.apply(this, nodes);
        const retry = page.comicRetry();
        if (condition === 'absent') retry?.remove();
        else if (retry) retry.disabled = true;
      });
      await page.status(conflict, 409);
      expect(page.document.activeElement).toBe(page.parts.close);
      expect(page.parts.close.isConnected).toBe(true);
      expect(page.manifests()).toHaveLength(1);
    });

    it('uses the connected dialog when both recovery buttons are unusable', async () => {
      const { page, conflict } = await focusedFailedPair();
      page.parts.close.disabled = true;
      const replace = page.parts.media.replaceChildren;
      vi.spyOn(page.parts.media, 'replaceChildren').mockImplementation(function (...nodes) {
        replace.apply(this, nodes);
        const retry = page.comicRetry();
        if (retry) retry.disabled = true;
      });
      await page.status(conflict, 409);
      expect(page.document.activeElement).toBe(page.dialog);
      expect(page.dialog.isConnected).toBe(true);
      expect(page.manifests()).toHaveLength(1);
    });

    it.each(['toolbar', 'dropdown', 'outside', 'modal'])('does not steal %s focus during retirement', async (owner) => {
      const { page, conflict } = await focusedFailedPair();
      let target = page.parts.close;
      if (owner === 'dropdown') target = page.dialog.querySelector('[data-unified-viewer-reader]').querySelector('summary');
      if (owner === 'outside') target = page.opener;
      if (owner === 'modal') {
        const modal = makeElement('dialog', { open: '' });
        page.document.body.appendChild(modal);
        target = modal.appendChild(makeElement('button'));
      }
      target.focus();
      const focus = vi.spyOn(target, 'focus');
      await page.status(conflict, 409);
      expect(page.document.activeElement).toBe(target);
      expect(focus).not.toHaveBeenCalled();
      expect(page.manifests()).toHaveLength(1);
    });

    it.each(['close', 'destroy', 'comic', 'image', 'modal', 'toolbar', 'Retry'])('respects a retirement observer choosing %s', async (action) => {
      const { page, retry, conflict } = await focusedFailedPair();
      let target;
      page.viewer.observe((change) => {
        if (change.outcome !== 'retired') return;
        // Content is the first participant: the old Retry is already gone.
        expect(retry.isConnected).toBe(false);
        if (action === 'close') page.viewer.close();
        else if (action === 'destroy') page.viewer.destroy();
        else if (action === 'comic') page.open({ assetId: 41 });
        else if (action === 'image') page.viewer.open(sequence([1]), { opener: page.opener });
        else if (action === 'Retry') page.viewer.retryComic();
        else if (action === 'toolbar') page.parts.close.focus();
        else {
          const modal = makeElement('dialog', { open: '' });
          page.document.body.appendChild(modal);
          modal.appendChild(makeElement('button')).focus();
        }
        target = page.document.activeElement;
      });
      const closeFocus = vi.spyOn(page.parts.close, 'focus');
      await page.status(conflict, 409);
      expect(page.document.activeElement).toBe(action === 'Retry' ? page.parts.close : target);
      expect(page.document.activeElement.isConnected).toBe(true);
      expect(closeFocus.mock.calls.length).toBe(['comic', 'image', 'toolbar', 'Retry'].includes(action) ? 1 : 0);
      expect(page.manifests()).toHaveLength(['comic', 'Retry'].includes(action) ? 2 : 1);
      if (action === 'close' || action === 'destroy') expect(target).toBe(page.opener);
      if (action === 'comic' || action === 'image') expect(page.viewer.getState().session).toBe(2);
    });

    it('keeps focus connected when a host hint retires a focused page Retry', async () => {
      const { page, session, retry } = await focusedFailedPair();
      page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session });
      expect(retry.isConnected).toBe(false);
      expect(page.document.activeElement).toBe(page.parts.close);
      expect(page.manifests()).toHaveLength(2);
      expect(page.viewer.getState()).toMatchObject({ session, comic: { state: 'loading' } });
    });

    it.each(['entry', 'exit'])('rescues page focus during a pending fullscreen %s', async (phase) => {
      let settleTransition;
      const pending = new Promise((resolve) => { settleTransition = resolve; });
      const { page, conflict } = await focusedFailedPair(1, {
        beforeBind(target) {
          target.card = target.dialog.querySelector('[data-unified-viewer-card]');
          target.document.fullscreenEnabled = true;
          target.document.fullscreenElement = null;
          target.card.requestFullscreen = vi.fn(() => {
            if (phase === 'entry') return pending;
            target.document.fullscreenElement = target.card;
            fire(target.document, 'fullscreenchange');
            return Promise.resolve();
          });
          target.document.exitFullscreen = vi.fn(() => pending);
        },
      });
      page.viewer.fullscreen.enter();
      if (phase === 'exit') {
        await settle();
        page.viewer.fullscreen.exit();
      }
      await page.status(conflict, 409);
      expect(page.document.activeElement).toBe(page.comicRetry());
      expect(page.dialog.open).toBe(true);
      page.document.fullscreenElement = phase === 'entry' ? page.card : null;
      fire(page.document, 'fullscreenchange');
      settleTransition();
      await settle();
      expect(page.document.activeElement).toBe(page.comicRetry());
      page.document.exitFullscreen = vi.fn(() => {
        page.document.fullscreenElement = null;
        fire(page.document, 'fullscreenchange');
        return Promise.resolve();
      });
      page.viewer.close();
      await settle();
      expect(page.document.activeElement).toBe(page.opener);
    });

    it('renders both pages of the group in the one shared media region and names the group', async () => {
      const { page, session } = await loadedSpread();
      expect(page.parts.position.textContent).toBe('Pages 2–3 of 7');
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2), pageUrl(3)]);
      await page.image(page.pages()[1]);
      await page.image(page.pages()[2]);
      expect(page.images().map((image) => image.getAttribute('alt'))).toEqual(['Page 2', 'Page 3']);
      expect(page.parts.media.children).toHaveLength(1);
      expect(page.parts.media.children[0].getAttribute('data-viewer-content')).toBe('spread');
      expect(page.parts.media.hasAttribute('data-viewer-composite')).toBe(true);
      expect(page.viewer.media.getState()).toMatchObject({
        status: 'loaded', composite: true, key: pageKey(2),
        pages: [{ position: 2, status: 'loaded' }, { position: 3, status: 'loaded' }],
      });
      expect(page.viewer.getState()).toMatchObject({ session, key: pageKey(2), mediaStatus: 'loaded' });
      expect(page.dialog.showModal).toHaveBeenCalledTimes(1);

      // RTL keeps the numbers ascending; Single names the anchor page only.
      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      expect(page.parts.position.textContent).toBe('Pages 2–3 of 7');
      page.viewer.setComicReaderOptions({ alignment: 'pair-from-first' });
      expect(page.parts.position.textContent).toBe('Pages 1–2 of 7');
      page.viewer.setComicReaderOptions({ layout: 'single' });
      expect(page.parts.position.textContent).toBe('Page 2 of 7');
      expect(page.pages()).toHaveLength(4);
      expect(page.images().map((image) => image.getAttribute('alt'))).toEqual(['Page 2']);
      expect(page.live.size).toBe(1);
    });

    it('a reader change updates the position without clearing a page failure message', async () => {
      const { page } = await loadedSpread();
      await page.image(page.pages()[1]);
      await page.status(page.pages()[2], 503);
      const message = 'Page 3 is temporarily unavailable. Try again in a moment.';
      expect(page.parts.status.textContent).toBe(message);
      const retry = page.pageRetry(3);
      retry.focus();
      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      expect(page.parts.status.textContent).toBe(message);
      expect(page.pageRetry(3)).toBe(retry);
      expect(page.document.activeElement).toBe(retry);
      // A Retry whose page leaves the composition hands focus to Close.
      page.viewer.next();
      expect(page.pageRetry(3)).toBe(null);
      expect(page.document.activeElement).toBe(page.parts.close);
      // The comic-level Retry is never involved.
      expect(page.comicRetry()).toBe(null);
      expect(page.manifests()).toHaveLength(1);
    });

    it('a 409 from either spread page retires the whole revision; Retry reloads one manifest at page 1', async () => {
      for (const conflicting of [2, 3]) {
        const { page, session } = await loadedSpread();
        page.viewer.setComicReaderOptions({ direction: 'rtl' });
        const seen = [];
        page.viewer.observe((change) => seen.push(`${change.type}:${change.outcome || ''}`));
        const other = conflicting === 2 ? 3 : 2;
        await page.image(page.pages()[other - 1]);
        const shown = page.images()[0];
        expect(page.live.size).toBe(1);
        await page.status(page.pages()[conflicting - 1], 409);
        expect(seen).toEqual(['update:retired']);
        expect(page.viewer.getState()).toMatchObject({
          session, key: null, count: 0, comic: { state: 'changed', httpStatus: 409, revision: null, retryable: true },
        });
        expect(page.images()).toHaveLength(0);
        expect(shown.isConnected).toBe(false);
        expect(page.live.size).toBe(0);
        expect(page.viewer.media.getState()).toMatchObject({ status: 'idle', pages: [], pageRequests: 0 });
        expect(page.parts.status.textContent).toBe('This comic changed while it was open. Retry to load the current version.');
        expect(page.dialog.open).toBe(true);
        await settle();
        expect(page.manifests()).toHaveLength(1);

        fire(page.comicRetry(), 'click');
        expect(page.manifests()).toHaveLength(2);
        await page.json(page.manifests()[1], manifest({ revision: REV_B, pages: [true, true, true, true, true] }));
        expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread', anchorPosition: 1, groupPositions: [1] });
        expect(page.parts.position.textContent).toBe('Page 1 of 5');
        expect(page.pages().at(-1).url).toBe(pageUrl(1, REV_B));
        expect(page.viewer.getState().session).toBe(session);
        expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
      }
    });

    it('two late 409s of one spread retire it once, and a stale 409 never retires a newer comic', async () => {
      const { page } = await loadedSpread({ ignoreAbort: true });
      const retired = [];
      page.viewer.observe((change) => { if (change.outcome === 'retired') retired.push(change.session); });
      const [, second, third] = page.pages();
      await page.status(second, 409);
      await page.status(third, 409);
      expect(retired).toHaveLength(1);
      fire(page.comicRetry(), 'click');
      await page.json(page.manifests()[1], manifest({ revision: REV_B }));
      page.viewer.next();
      const stale = page.pages().filter((request) => request.url.includes(REV_B));
      const newer = page.open({ assetId: 41 });
      await page.json(page.manifests().at(-1), manifest({ assetId: 41 }));
      for (const request of stale) await page.status(request, 409);
      expect(retired).toHaveLength(1);
      expect(page.viewer.getState()).toMatchObject({ session: newer, comic: { state: 'ready', assetId: 41 } });
      expect(page.live.size).toBe(0);
    });

    it('a new host hint retires both spread pages and restarts the fresh revision at page 1', async () => {
      const { page, session } = await loadedSpread({}, SEVEN(), { sourceRevision: 's1' });
      await page.image(page.pages()[1]);
      await page.image(page.pages()[2]);
      expect(page.live.size).toBe(2);
      const before = page.images();
      expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's1' }, { session }))
        .toEqual({ outcome: 'unchanged' });
      expect(page.images()).toEqual(before);
      expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
        .toEqual({ outcome: 'reloading' });
      expect(page.images()).toHaveLength(0);
      expect(before.every((image) => !image.isConnected)).toBe(true);
      expect(page.live.size).toBe(0);
      expect(page.manifests()).toHaveLength(2);
      const pagesBefore = page.pages().length;
      await page.json(page.manifests()[1], manifest({ revision: REV_B, pages: [true, true, true, true] }));
      expect(page.pages().slice(pagesBefore).map((request) => request.url)).toEqual([pageUrl(1, REV_B)]);
      await page.image(page.pages().at(-1));
      page.viewer.next();
      expect(page.pages().slice(pagesBefore + 1).map((request) => request.url)).toEqual([pageUrl(2, REV_B), pageUrl(3, REV_B)]);
      expect(page.parts.position.textContent).toBe('Pages 2–3 of 4');
      expect(page.viewer.getState().session).toBe(session);
    });

    it('reading and changing options never sends anything but page and manifest GETs', async () => {
      const { page } = await loadedSpread();
      page.viewer.setComicReaderOptions({ direction: 'rtl', alignment: 'pair-from-first' });
      page.viewer.next();
      page.viewer.setComicReaderOptions({ layout: 'single' });
      await settle();
      const calls = page.document.defaultView.fetch.mock.calls;
      expect(calls.length).toBeGreaterThan(3);
      expect(calls.every(([, init]) => (init.method || 'GET') === 'GET' && init.body === undefined)).toBe(true);
      expect(calls.every(([url]) => url === MANIFEST_URL || url.includes('/comic/pages/'))).toBe(true);
    });
  });

  // ─── C1f: reader controls and browser-local preferences ──────────────────

  describe('reader controls and per-comic preferences', () => {
    const SEVEN = () => manifest({ pages: [true, true, true, true, true, true, true] });
    const STORAGE_KEY = 'creatorcrate-comic-reader-preferences:v1:comic:7:40';
    const reader = (page) => page.viewer.getState().reader;
    const positions = (items) => items.map((item) => item.position);
    // Shown pages in visual left-to-right order (DOM order stays canonical).
    const visualPages = (page) => page.parts.media.querySelectorAll('[data-viewer-spread-slot]')
      .sort((a, b) => Number(a.getAttribute('data-viewer-spread-index')) - Number(b.getAttribute('data-viewer-spread-index')))
      .map((slot) => slot.querySelector('img')?.getAttribute('alt') ?? null);
    let store;

    function memoryStorage(initial = {}) {
      const data = new Map(Object.entries(initial));
      return {
        data,
        getItem: vi.fn((key) => (data.has(key) ? data.get(key) : null)),
        setItem: vi.fn((key, value) => { data.set(key, String(value)); }),
        removeItem: vi.fn((key) => { data.delete(key); }),
      };
    }
    const stored = () => {
      const { version, ...options } = JSON.parse(store.data.get(STORAGE_KEY));
      expect(version).toBe(1);
      return options;
    };

    beforeEach(() => {
      store = memoryStorage();
      vi.stubGlobal('localStorage', store);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    // The page's document-level dropdown enhancement, as the app binds it.
    function readerPage(options = {}) {
      return comicPage({
        ...options,
        beforeBind(target) {
          options.beforeBind?.(target);
          enhanceDropdowns(target.document);
        },
      });
    }

    function ui(page) {
      const group = page.dialog.querySelector('[data-unified-viewer-reader]');
      const directionMenu = page.dialog.querySelector('#unified-viewer-direction-dropdown');
      const layoutMenu = page.dialog.querySelector('#unified-viewer-layout-dropdown');
      return {
        group,
        direction: group.querySelector('[data-unified-viewer-direction]'),
        layout: group.querySelector('[data-unified-viewer-layout]'),
        directionMenu,
        layoutMenu,
        directionSummary: directionMenu.querySelector('summary'),
        layoutSummary: layoutMenu.querySelector('summary'),
      };
    }
    const shown = (menu) => menu.querySelector('[data-cc-dropdown-summary-current]').textContent;
    const checked = (menu) => menu.querySelectorAll('input').filter((input) => input.checked).map((input) => input.value);
    const radio = (menu, value) => menu.querySelectorAll('input').find((input) => input.value === value);
    // A pick from the open menu, exactly as the shared dropdown handles it.
    function pick(page, menu, value) {
      menu.querySelector('summary').focus();
      menu.open = true;
      menu.setAttribute('open', '');
      const choice = radio(menu, value);
      choice.focus();
      choice.checked = true;
      fire(choice, 'change');
    }

    function fullscreenComicPage() {
      return readerPage({
        beforeBind(target) {
          target.card = target.dialog.querySelector('[data-unified-viewer-card]');
          target.document.fullscreenElement = null;
          target.document.fullscreenEnabled = true;
          target.document.exitFullscreen = vi.fn(() => {
            target.document.fullscreenElement = null;
            fire(target.document, 'fullscreenchange');
            return Promise.resolve();
          });
          target.card.requestFullscreen = vi.fn(() => {
            target.document.fullscreenElement = target.card;
            fire(target.document, 'fullscreenchange');
            return Promise.resolve();
          });
        },
      });
    }

    it('shows both controls only for comic sessions, starting from the defaults', async () => {
      const page = readerPage();
      const controls = ui(page);
      expect(controls.group.hidden).toBe(true);
      expect(controls.group.getAttribute('role')).toBe('group');
      expect(controls.group.getAttribute('aria-label')).toBe('Comic reading');
      expect(radio(controls.directionMenu, 'ltr').parentNode.textContent).toBe('Left-to-Right');
      expect(radio(controls.layoutMenu, 'spread-pair-from-first').parentNode.textContent)
        .toBe('Two-Page Spread — Pair from Page 1');

      page.open();
      // Pending manifest: the choices are already available.
      expect(controls.group.hidden).toBe(false);
      expect(shown(controls.directionMenu)).toBe('Left-to-Right');
      expect(shown(controls.layoutMenu)).toBe('Single Page');
      expect(controls.directionSummary.getAttribute('aria-label')).toBe('Reading direction: Left-to-Right');
      expect(controls.layoutSummary.getAttribute('aria-label')).toBe('Page layout: Single Page');
      expect(checked(controls.directionMenu)).toEqual(['ltr']);
      expect(checked(controls.layoutMenu)).toEqual(['single']);
      await page.json(page.manifests()[0], SEVEN());
      expect(controls.group.hidden).toBe(false);
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone', anchorPosition: 1 });

      // An empty comic keeps the controls; page navigation stays unavailable.
      page.open({ assetId: 41 });
      await page.json(page.manifests().at(-1), manifest({ assetId: 41, pages: [] }));
      expect(page.viewer.getState().comic.empty).toBe(true);
      expect(controls.group.hidden).toBe(false);
      expect(page.parts.controls.hidden).toBe(true);

      // An image session never shows them.
      page.viewer.open(sequence([1, 2, 3]), { opener: page.opener });
      expect(controls.group.hidden).toBe(true);
      expect(page.viewer.getState().reader).toBe(null);
      fire(page.parts.close, 'click');
      expect(controls.group.hidden).toBe(true);
      // Nothing was remembered by merely opening.
      expect(store.setItem).not.toHaveBeenCalled();
    });

    it('starts a new comic in the remembered layout, loading only its first group', async () => {
      store.data.set(STORAGE_KEY, JSON.stringify({ version: 1, direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' }));
      const page = readerPage();
      const seen = [];
      page.viewer.observe((change) => seen.push(change.type));
      page.open();
      const controls = ui(page);
      expect(shown(controls.directionMenu)).toBe('Right-to-Left');
      expect(shown(controls.layoutMenu)).toBe('Two-Page Spread — Pair from Page 1');
      expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
      await page.json(page.manifests()[0], SEVEN());
      // Pages 1–2 at once, page 1 on the right: no Single Page load first.
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2)]);
      expect(reader(page)).toMatchObject({ anchorPosition: 1, groupPositions: [1, 2], label: 'Pages 1–2 of 7' });
      expect(positions(reader(page).visibleItems)).toEqual([2, 1]);
      expect(seen).toEqual(['open', 'update']);
      await page.image(page.pages()[0]);
      await page.image(page.pages()[1]);
      expect(visualPages(page)).toEqual(['Page 2', 'Page 1']);
      expect(page.pages()).toHaveLength(2);
      expect(store.setItem).not.toHaveBeenCalled();

      // Cover Alone remembered: the first group is page 1 alone.
      store.data.set(STORAGE_KEY, JSON.stringify({ version: 1, direction: 'ltr', layout: 'spread', alignment: 'cover-alone' }));
      const other = readerPage();
      other.open();
      await other.json(other.manifests()[0], SEVEN());
      expect(other.pages().map((request) => request.url)).toEqual([pageUrl(1)]);
      expect(reader(other)).toMatchObject({ groupPositions: [1], label: 'Page 1 of 7' });
      expect(shown(ui(other).layoutMenu)).toBe('Two-Page Spread — Cover Alone');
    });

    it('a direction pick swaps placement with no request, keeping images, view, focus and session', async () => {
      const page = readerPage();
      const session = page.open();
      await page.json(page.manifests()[0], SEVEN());
      await page.image(page.pages()[0]);
      const controls = ui(page);
      pick(page, controls.layoutMenu, 'spread-cover-alone');
      page.viewer.next();
      await page.image(page.pages()[1]);
      await page.image(page.pages()[2]);
      page.parts.media.clientWidth = 800;
      page.parts.media.clientHeight = 600;
      page.viewer.media.refreshGeometry();
      page.viewer.media.zoomIn();
      const media = page.viewer.media.getState();
      const images = page.images();
      const requests = page.requests.length;
      const source = page.viewer.getState().source;
      const live = new Set(page.live);
      const seen = [];
      page.viewer.observe((change) => seen.push(change));

      pick(page, controls.directionMenu, 'rtl');
      expect(reader(page)).toMatchObject({ direction: 'rtl', anchorKey: pageKey(2), groupPositions: [2, 3] });
      expect(positions(reader(page).visibleItems)).toEqual([3, 2]);
      expect(visualPages(page)).toEqual(['Page 3', 'Page 2']);
      expect(new Set(page.images())).toEqual(new Set(images));
      expect(page.live).toEqual(live);
      expect(page.requests).toHaveLength(requests);
      expect(page.viewer.media.getState()).toEqual(media);
      expect(media.view.mode).toBe('zoom');
      expect(page.viewer.getState()).toMatchObject({ session, open: true, key: pageKey(2) });
      expect(page.viewer.getState().source).toBe(source);
      expect(page.dialog.showModal).toHaveBeenCalledTimes(1);
      expect(seen.map((change) => change.type)).toEqual(['reader']);
      // The menu shows the controller's accepted value, closed, focus on its trigger.
      expect(shown(controls.directionMenu)).toBe('Right-to-Left');
      expect(controls.directionSummary.getAttribute('aria-label')).toBe('Reading direction: Right-to-Left');
      expect(controls.directionMenu.hasAttribute('open')).toBe(false);
      expect(page.document.activeElement).toBe(controls.directionSummary);
      expect(page.parts.position.textContent).toBe('Pages 2–3 of 7');
      expect(stored()).toEqual({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone' });

      // With focus back on the viewer, arrows follow the reading direction.
      page.parts.close.focus();
      fire(page.parts.close, 'keydown', { key: 'ArrowLeft' });
      expect(reader(page)).toMatchObject({ groupPositions: [4, 5] });
      fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
      expect(reader(page)).toMatchObject({ groupPositions: [2, 3] });
    });

    it('layout picks keep the anchor and reuse loaded pages; Single Page keeps the spread alignment', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      await page.image(page.pages()[0]);
      page.viewer.next();
      await page.image(page.pages()[1]);
      const controls = ui(page);
      const anchorImage = page.images()[0];
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2)]);

      // Single → Cover Alone: [2,3], page 2 kept, only page 3 requested.
      pick(page, controls.layoutMenu, 'spread-cover-alone');
      expect(reader(page)).toMatchObject({ layout: 'spread', alignment: 'cover-alone', anchorKey: pageKey(2), groupPositions: [2, 3] });
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1), pageUrl(2), pageUrl(3)]);
      expect(page.images()).toContain(anchorImage);
      expect(page.viewer.media.getState().view.mode).toBe('fit');
      expect(shown(controls.layoutMenu)).toBe('Two-Page Spread — Cover Alone');
      await page.image(page.pages()[2]);

      // Cover Alone → Pair from Page 1: [1,2], page 2 kept, page 3 released.
      pick(page, controls.layoutMenu, 'spread-pair-from-first');
      expect(reader(page)).toMatchObject({ alignment: 'pair-from-first', anchorKey: pageKey(2), groupPositions: [1, 2] });
      expect(page.pages().slice(3).map((request) => request.url)).toEqual([pageUrl(1)]);
      expect(page.images()).toContain(anchorImage);
      await page.image(page.pages()[3]);
      expect(page.live.size).toBe(2);

      // Spread → Single: the anchor stays, its companion is released.
      pick(page, controls.layoutMenu, 'single');
      expect(reader(page)).toMatchObject({ layout: 'single', alignment: 'pair-from-first', anchorKey: pageKey(2), groupPositions: [2] });
      expect(page.images()).toEqual([anchorImage]);
      expect(page.live.size).toBe(1);
      expect(page.pages()).toHaveLength(4);
      expect(stored()).toEqual({ direction: 'ltr', layout: 'single', alignment: 'pair-from-first' });
      expect(shown(controls.layoutMenu)).toBe('Single Page');

      // Returning to two pages without choosing an alignment restores Pair
      // from Page 1, and the menu follows the controller.
      page.viewer.setComicReaderOptions({ layout: 'spread' });
      expect(reader(page)).toMatchObject({ layout: 'spread', alignment: 'pair-from-first', groupPositions: [1, 2] });
      expect(shown(controls.layoutMenu)).toBe('Two-Page Spread — Pair from Page 1');
      expect(checked(controls.layoutMenu)).toEqual(['spread-pair-from-first']);
      expect(controls.layoutSummary.getAttribute('aria-label')).toBe('Page layout: Two-Page Spread — Pair from Page 1');
      page.viewer.setComicReaderOptions({ direction: 'rtl' });
      expect(shown(controls.directionMenu)).toBe('Right-to-Left');
      expect(page.manifests()).toHaveLength(1);
    });

    it('repeating the current choice changes nothing and writes nothing', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      await page.image(page.pages()[0]);
      const controls = ui(page);
      const seen = [];
      page.viewer.observe((change) => seen.push(change));
      const requests = page.requests.length;
      pick(page, controls.directionMenu, 'ltr');
      pick(page, controls.layoutMenu, 'single');
      expect(seen).toHaveLength(0);
      expect(page.requests).toHaveLength(requests);
      expect(store.setItem).not.toHaveBeenCalled();
      pick(page, controls.layoutMenu, 'spread-pair-from-first');
      pick(page, controls.layoutMenu, 'spread-pair-from-first');
      expect(seen.map((change) => change.type)).toEqual(['reader']);
      expect(store.setItem).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid control values and re-shows the accepted options', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      const controls = ui(page);
      const seen = [];
      page.viewer.observe((change) => seen.push(change));
      for (const value of ['up', '', 'RTL']) {
        controls.direction.value = value;
        fire(controls.direction, 'change');
        expect(controls.direction.value).toBe('ltr');
      }
      for (const value of ['double', 'spread', '__proto__', 'toString']) {
        controls.layout.value = value;
        fire(controls.layout, 'change');
        expect(controls.layout.value).toBe('single');
      }
      expect(shown(controls.directionMenu)).toBe('Left-to-Right');
      expect(shown(controls.layoutMenu)).toBe('Single Page');
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      expect(seen).toHaveLength(0);
      expect(store.setItem).not.toHaveBeenCalled();
    });

    it('menu keys stay with the menu; Escape closes it before fullscreen, then the viewer', async () => {
      const page = fullscreenComicPage();
      const session = page.open();
      await page.json(page.manifests()[0], SEVEN());
      const controls = ui(page);
      page.viewer.fullscreen.enter();
      await Promise.resolve();
      expect(page.viewer.getState().fullscreen).toBe(true);

      // Arrow keys on the trigger, inside an open menu, never turn pages.
      controls.directionSummary.focus();
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        expect(fire(controls.directionSummary, 'keydown', { key }).defaultPrevented).toBe(false);
      }
      controls.directionMenu.open = true;
      controls.directionMenu.setAttribute('open', '');
      for (const key of ['ArrowDown', 'ArrowRight', 'ArrowLeft']) {
        fire(radio(controls.directionMenu, 'rtl'), 'keydown', { key });
      }
      fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
      expect(page.viewer.getState().key).toBe(pageKey(1));

      // Escape: the menu first, focus back on its trigger, fullscreen kept.
      fire(radio(controls.directionMenu, 'rtl'), 'keydown', { key: 'Escape' });
      expect(controls.directionMenu.hasAttribute('open')).toBe(false);
      expect(page.document.activeElement).toBe(controls.directionSummary);
      expect(page.document.exitFullscreen).not.toHaveBeenCalled();
      expect(page.dialog.open).toBe(true);

      // Picks in fullscreen keep fullscreen, the dialog and the session.
      pick(page, controls.directionMenu, 'rtl');
      pick(page, controls.layoutMenu, 'spread-cover-alone');
      expect(page.viewer.getState()).toMatchObject({ session, fullscreen: true, open: true });
      expect(page.card.requestFullscreen).toHaveBeenCalledTimes(1);
      expect(page.document.exitFullscreen).not.toHaveBeenCalled();
      expect(page.dialog.showModal).toHaveBeenCalledTimes(1);

      // Then Escape exits fullscreen only, and the next one closes the viewer.
      fire(controls.layoutSummary, 'keydown', { key: 'Escape' });
      await settle();
      expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(page.dialog.open).toBe(true);
      fire(controls.layoutSummary, 'keydown', { key: 'Escape' });
      await settle();
      expect(page.dialog.open).toBe(false);
      expect(page.document.activeElement).toBe(page.opener);
      expect(controls.group.hidden).toBe(true);
    });

    it('leaves image sessions, slideshow, Original size and image Escape unchanged', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      pick(page, ui(page).directionMenu, 'rtl');
      const slideshow = createSlideshowSource({
        key: 'project-7-slideshow',
        label: 'Project Seven',
        entries: [1, 2, 3].map((id) => ({
          id, projectId: 7, filename: `image-${id}.png`, previewUrl: `/projects/7/assets/${id}/preview`,
          originalUrl: `/projects/7/assets/${id}/original`, revision: 'r1',
        })),
      });
      page.viewer.open(slideshow, { opener: page.opener, autoplay: false });
      const controls = ui(page);
      expect(controls.group.hidden).toBe(true);
      expect(page.dialog.querySelector('[data-unified-viewer-playback]').hidden).toBe(false);
      expect(page.viewer.getState().playback).toMatchObject({ available: true, playing: false });
      await page.image(page.requests.at(-1));
      expect(page.dialog.querySelector('[data-unified-viewer-original]').hidden).toBe(false);
      // Image arrows are never reversed by a comic's direction.
      page.parts.close.focus();
      fire(page.parts.close, 'keydown', { key: 'ArrowRight' });
      expect(page.viewer.getState().key).toBe(slideshow.items[1].key);
      expect(page.parts.position.textContent).toBe('2 of 3');
      fire(page.parts.close, 'keydown', { key: 'Escape' });
      expect(page.dialog.open).toBe(false);
      expect(page.document.activeElement).toBe(page.opener);
    });

    it('keeps the choices through a page 409 Retry, a host-hint refresh and a manifest failure', async () => {
      const page = readerPage();
      const session = page.open({ sourceRevision: 's1' });
      await page.json(page.manifests()[0], SEVEN());
      const controls = ui(page);
      pick(page, controls.directionMenu, 'rtl');
      pick(page, controls.layoutMenu, 'spread-pair-from-first');
      page.viewer.select(pageKey(5));
      await settle();
      await page.status(page.pages().find((request) => request.url === pageUrl(5)), 409);
      expect(page.viewer.getState().comic.state).toBe('changed');
      // Stale page controls are gone; the reader choices remain.
      expect(page.parts.controls.hidden).toBe(true);
      expect(controls.group.hidden).toBe(false);
      expect(shown(controls.directionMenu)).toBe('Right-to-Left');
      expect(shown(controls.layoutMenu)).toBe('Two-Page Spread — Pair from Page 1');
      fire(page.comicRetry(), 'click');
      await page.json(page.manifests()[1], manifest({ revision: REV_B, pages: [true, true, true] }));
      expect(reader(page)).toMatchObject({
        direction: 'rtl', layout: 'spread', alignment: 'pair-from-first', anchorPosition: 1, groupPositions: [1, 2], pageCount: 3,
      });

      expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's2' }, { session }))
        .toEqual({ outcome: 'reloading' });
      expect(controls.group.hidden).toBe(false);
      await page.json(page.manifests()[2], manifest({ revision: REV_A, pages: [true, true, true, true, true] }));
      expect(reader(page)).toMatchObject({
        direction: 'rtl', layout: 'spread', alignment: 'pair-from-first', groupPositions: [1, 2], pageCount: 5,
      });
      expect(page.viewer.getState().session).toBe(session);

      // A retryable manifest failure keeps Retry and the choices.
      expect(page.viewer.reconcileComic({ projectId: 7, assetId: 40, sourceRevision: 's3' }, { session }))
        .toEqual({ outcome: 'reloading' });
      await page.status(page.manifests()[3], 503);
      expect(page.viewer.getState().comic).toMatchObject({ state: 'failed', retryable: true });
      expect(page.comicRetry()).toBeTruthy();
      expect(controls.group.hidden).toBe(false);
      pick(page, controls.layoutMenu, 'single');
      expect(page.manifests()).toHaveLength(4);
      fire(page.comicRetry(), 'click');
      await page.json(page.manifests()[4], SEVEN());
      expect(reader(page)).toMatchObject({ layout: 'single', alignment: 'pair-from-first', groupPositions: [1] });
    });

    it('changing choices while the manifest is pending never repeats the manifest request', async () => {
      const page = readerPage();
      page.open();
      const controls = ui(page);
      pick(page, controls.directionMenu, 'rtl');
      pick(page, controls.layoutMenu, 'spread-cover-alone');
      expect(page.manifests()).toHaveLength(1);
      expect(page.pages()).toHaveLength(0);
      await page.json(page.manifests()[0], SEVEN());
      expect(page.pages().map((request) => request.url)).toEqual([pageUrl(1)]);
      expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread', groupPositions: [1] });
    });

    it('a control event outside the session it was rendered for changes nothing', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      const controls = ui(page);
      page.viewer.open(sequence([1, 2]), { opener: page.opener });
      controls.direction.value = 'rtl';
      fire(controls.direction, 'change');
      controls.layout.value = 'spread-cover-alone';
      fire(controls.layout, 'change');
      expect(page.viewer.getState().reader).toBe(null);
      expect(controls.group.hidden).toBe(true);
      expect(store.setItem).not.toHaveBeenCalled();
      fire(page.parts.close, 'click');
      controls.direction.value = 'rtl';
      fire(controls.direction, 'change');
      expect(store.setItem).not.toHaveBeenCalled();

      // A newer comic shows its own (unchanged) options.
      page.open({ assetId: 41 });
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single' });
      expect(controls.direction.value).toBe('ltr');
      expect(controls.layout.value).toBe('single');
    });

    it('hiding the controls moves focus held in them to Close and closes an open menu', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      const controls = ui(page);
      controls.layoutMenu.open = true;
      controls.layoutMenu.setAttribute('open', '');
      controls.layoutSummary.focus();
      page.viewer.open(sequence([1, 2]));
      expect(controls.group.hidden).toBe(true);
      expect(controls.layoutMenu.hasAttribute('open')).toBe(false);
      expect(page.document.activeElement).toBe(page.parts.close);
      // The image session kept the comic's opener.
      fire(page.parts.close, 'click');
      expect(page.document.activeElement).toBe(page.opener);
    });

    it('adds no listeners across sessions and removes its own on destroy', async () => {
      const page = readerPage();
      const controls = ui(page);
      const counts = () => [controls.direction, controls.layout, page.dialog, page.document].map(listenerCount);
      const before = counts();
      expect(listenerCount(controls.direction)).toBe(1);
      expect(listenerCount(controls.layout)).toBe(1);
      for (let index = 0; index < 3; index += 1) {
        page.open();
        await page.json(page.manifests().at(-1), SEVEN());
        pick(page, controls.directionMenu, index % 2 ? 'ltr' : 'rtl');
        page.viewer.open(sequence([1, 2]), { opener: page.opener });
        fire(page.parts.close, 'click');
      }
      expect(counts()).toEqual(before);
      const remembered = store.data.get(STORAGE_KEY);
      page.viewer.destroy();
      expect(listenerCount(controls.direction)).toBe(0);
      expect(listenerCount(controls.layout)).toBe(0);
      controls.direction.value = 'rtl';
      fire(controls.direction, 'change');
      controls.layout.value = 'spread-cover-alone';
      fire(controls.layout, 'change');
      expect(store.data.get(STORAGE_KEY)).toBe(remembered);
      expect(store.setItem).toHaveBeenCalledTimes(3);
    });

    it('keeps working when storage refuses reads or writes; the document still remembers', async () => {
      store.getItem.mockImplementation(() => { throw new Error('SecurityError'); });
      store.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
      const page = readerPage();
      page.open();
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      await page.json(page.manifests()[0], SEVEN());
      pick(page, ui(page).directionMenu, 'rtl');
      pick(page, ui(page).layoutMenu, 'spread-pair-from-first');
      expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
      expect(shown(ui(page).directionMenu)).toBe('Right-to-Left');
      page.open({ assetId: 41 });
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      page.open({ projectId: '7', assetId: '40', sourceRevision: 'regenerated' });
      expect(reader(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });

      // No storage at all.
      vi.stubGlobal('localStorage', undefined);
      const bare = readerPage();
      bare.open();
      expect(reader(bare)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      await bare.json(bare.manifests()[0], SEVEN());
      pick(bare, ui(bare).directionMenu, 'rtl');
      expect(reader(bare).direction).toBe('rtl');
    });

    it.each(['ltr', 'up'])('adopts merged preferences and rejects stale-session writes (saved direction %s)', async (savedDirection) => {
      const page = readerPage();
      const session = page.open();
      await page.json(page.manifests()[0], SEVEN());
      const controls = ui(page);
      store.getItem.mockImplementationOnce(() => { throw new Error('SecurityError'); });
      pick(page, controls.layoutMenu, 'spread-cover-alone');
      expect(store.setItem).not.toHaveBeenCalled();
      expect(reader(page).groupPositions).toEqual([1]);

      store.data.set(STORAGE_KEY, JSON.stringify({
        version: 1, direction: savedDirection, layout: 'spread', alignment: 'pair-from-first',
      }));
      const changes = [];
      page.viewer.observe((change) => changes.push(change));
      pick(page, controls.directionMenu, 'rtl');
      const merged = { direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' };
      expect(stored()).toEqual(merged);
      expect(reader(page)).toMatchObject({ ...merged, anchorPosition: 1, groupPositions: [1, 2] });
      expect(checked(controls.directionMenu)).toEqual(['rtl']);
      expect(checked(controls.layoutMenu)).toEqual(['spread-pair-from-first']);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        type: 'reader', session, reader: merged, changed: ['direction', 'alignment'], reload: false,
      });
      expect(page.manifests()).toHaveLength(1);
      expect(store.setItem).toHaveBeenCalledTimes(1);

      page.open({ projectId: '8', assetId: '40' });
      expect(page.viewer.setComicReaderOptions({ direction: 'rtl' }, { session })).toBeNull();
      expect(reader(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
      page.open({ projectId: '7', assetId: '40', sourceRevision: 'regenerated' });
      expect(reader(page)).toMatchObject(merged);
      expect(store.setItem).toHaveBeenCalledTimes(1);
    });

    it('applies both spread fields even when the layout is already spread in the active reader', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      const controls = ui(page);
      pick(page, controls.layoutMenu, 'spread-cover-alone');
      store.data.set(STORAGE_KEY, JSON.stringify({
        version: 1, direction: 'rtl', layout: 'single', alignment: 'cover-alone',
      }));
      pick(page, controls.layoutMenu, 'spread-pair-from-first');
      const merged = { direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' };
      expect(stored()).toEqual(merged);
      expect(reader(page)).toMatchObject({ ...merged, groupPositions: [1, 2] });
      expect(store.setItem).toHaveBeenCalledTimes(2);
    });

    it('remembers across viewer controllers through storage, and an explicit openComic reader patch is per session', async () => {
      const first = readerPage();
      first.open();
      await first.json(first.manifests()[0], SEVEN());
      pick(first, ui(first).layoutMenu, 'spread-cover-alone');
      first.viewer.destroy();
      const second = readerPage();
      const previous = second.open();
      expect(reader(second)).toMatchObject({ layout: 'spread', alignment: 'cover-alone' });
      second.open({ assetId: 41 }, { reader: { direction: 'rtl' } });
      expect(reader(second)).toMatchObject({ direction: 'rtl', layout: 'single' });
      expect(shown(ui(second).directionMenu)).toBe('Right-to-Left');
      expect(second.viewer.setComicReaderOptions({ alignment: 'pair-from-first' }, { session: previous })).toBeNull();
      expect(stored()).toEqual({ direction: 'ltr', layout: 'spread', alignment: 'cover-alone' });
      second.open({ assetId: 42 }, { reader: { direction: 'sideways' } });
      expect(reader(second)).toMatchObject({ direction: 'ltr', layout: 'single' });
      // An explicit session override and a page selection write no preferences.
      second.viewer.select(pageKey(1));
      expect(Object.keys(stored()).sort()).toEqual(['alignment', 'direction', 'layout']);
      expect(store.data.size).toBe(1);
    });

    it('changing choices sends nothing but page GETs', async () => {
      const page = readerPage();
      page.open();
      await page.json(page.manifests()[0], SEVEN());
      const before = page.document.defaultView.fetch.mock.calls.length;
      pick(page, ui(page).directionMenu, 'rtl');
      pick(page, ui(page).layoutMenu, 'spread-pair-from-first');
      pick(page, ui(page).layoutMenu, 'single');
      await settle();
      const calls = page.document.defaultView.fetch.mock.calls.slice(before);
      expect(calls.every(([url, init]) => url.includes('/comic/pages/') && (init.method || 'GET') === 'GET' && init.body === undefined))
        .toBe(true);
      expect(page.manifests()).toHaveLength(1);
    });
  });
});

describe('unified viewer asset metadata', () => {
  it('tracks current cross-project slideshow metadata while paused and rejects an old session update', async () => {
    const page = mediaPage();
    const items = [rawItem(1, { filename: 'first  full.png', projectName: 'First' }),
      rawItem(1, { projectId: 8, filename: 'second.webp', detailsUrl: '/projects/8/assets/1' })];
    const source = createViewerSource({ key: 'global', slideshow: true, items });
    const first = page.viewer.open(source, { autoplay: false });
    await page.respond(page.requests[0]);
    expect(page.viewer.getState().context).toMatchObject({ filename: 'first  full.png', projectName: 'First' });
    page.viewer.next();
    expect(page.viewer.getState()).toMatchObject({
      context: { projectId: '8', assetId: '1', filename: 'second.webp', projectName: null, detailsUrl: '/projects/8/assets/1' },
      source: { slideshow: true }, playback: { playing: false },
    });
    expect(page.parts.details.getAttribute('href')).toBe('/projects/8/assets/1');
    expect(page.parts.title.textContent).toBe('second.webp');
    const current = page.viewer.open(source, { autoplay: false });
    expect(page.viewer.update([rawItem(1, { filename: 'obsolete.png' })], { session: first })).toBeNull();
    expect(page.viewer.getState()).toMatchObject({ session: current, context: { filename: 'first  full.png' } });
    page.viewer.close();
    expect(page.viewer.getState().context).toBeNull();
    expect(page.parts.details.hasAttribute('href')).toBe(false);
  });

  it('refreshes full metadata without fetching or decoding media again in a one-image slideshow', async () => {
    const page = mediaPage();
    const changes = [];
    page.viewer.observe((change) => changes.push(change));
    const session = page.viewer.open(sequence([1], { slideshow: true,
      items: [rawItem(1, { filename: 'old.png', projectName: 'Old' })] }), { autoplay: false });
    await page.respond(page.requests[0]);
    const image = page.images()[0];
    const count = page.requests.length;
    page.viewer.update([rawItem(1, { filename: 'new  complete.png', projectName: null,
      detailsUrl: '/projects/7/assets/1?pageSize=all' })], { session });
    expect(page.images()[0]).toBe(image);
    expect(page.requests).toHaveLength(count);
    expect(page.viewer.getState()).toMatchObject({
      context: { filename: 'new  complete.png', projectName: null, detailsUrl: '/projects/7/assets/1?pageSize=all' },
      source: { slideshow: true, mode: 'sequence' }, playback: { playing: false }, mediaStatus: 'loaded',
    });
    expect(changes.at(-1)).toMatchObject({ context: { filename: 'new  complete.png' }, reload: false, preserveView: true });
    expectDialogTitle(page, 'Slideshow');
    page.viewer.destroy();
  });
});
