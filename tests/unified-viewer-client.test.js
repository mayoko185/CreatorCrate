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
    textContent: '',
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
    remove() {
      const parent = this.parentNode;
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
      if (match[5].trim()) top.textContent += decodeEntities(match[5]).replace(/\s+/g, ' ').trim();
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
  it('renders one shared native dialog with a static backdrop and accessible structure', () => {
    const html = renderPartial('unified-viewer.njk');
    expect(html.match(/<dialog\b/g)).toHaveLength(1);
    const dialogTag = html.match(/<dialog [^>]*>/)[0];
    expect(dialogTag).toContain('id="unified-viewer-dialog"');
    expect(dialogTag).toContain('data-app-dialog');
    expect(dialogTag).toContain('data-dialog-backdrop-static');
    expect(dialogTag).toContain('aria-labelledby="unified-viewer-dialog-title"');
    expect(dialogTag).toContain('aria-describedby="unified-viewer-context"');
    expect(dialogTag).not.toMatch(/\sopen[\s>]/);
    expect(html).toContain('<h2 id="unified-viewer-dialog-title">Viewer</h2>');
    expect(html).toContain('aria-label="Close Viewer"');
    expect(html).toContain('id="unified-viewer-context"');
    expect(html).toMatch(/data-unified-viewer-previous aria-label="Previous" data-tooltip="Previous"/);
    expect(html).toMatch(/data-unified-viewer-next aria-label="Next" data-tooltip="Next"/);
    expect(html).toMatch(/data-unified-viewer-status role="status" aria-live="polite"/);
    expect(html).toMatch(/data-unified-viewer-position aria-live="polite" aria-atomic="true"/);
    expect(html).not.toContain('autofocus');
  });

  it('exposes no control that a later package implements', () => {
    const page = makePage();
    const buttons = page.dialog.querySelectorAll('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Close Viewer', 'Zoom out', 'Zoom in', 'Fit to viewer', 'Original size', 'Enter fullscreen',
      'Previous', 'Play slideshow', 'Next',
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

describe('unified viewer opening and navigation', () => {
  it('opens a single image with its context and no sequence controls', () => {
    const page = boundPage();
    const source = createSingleImageSource({
      key: 'project-7-assets',
      label: 'Project Seven',
      entries: [
        { id: 1, projectId: 7, filename: 'one.png', previewUrl: '/p/1', viewerUrl: '/projects/7/assets/1' },
        { id: 2, projectId: 7, filename: 'two.png', previewUrl: '/p/2', viewerUrl: '/projects/7/assets/2' },
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
        rawItem(1, { title: hostile, detailsUrl: 'javascript:alert(1)' }),
        rawItem(2, { detailsUrl: '//evil.example/assets/2' }),
        rawItem(3, { detailsUrl: 'https://evil.example/' }),
      ],
    }), { opener: page.opener });

    expect(page.parts.title.textContent).toBe(hostile);
    expect(page.parts.title.children).toHaveLength(0);
    expect(page.parts.source.textContent).toBe(`<b>${hostile}</b>`);
    expect(page.parts.source.children).toHaveLength(0);
    expect(page.parts.details.hidden).toBe(true);
    expect(page.parts.details.hasAttribute('href')).toBe(false);
    page.viewer.next();
    expect(page.parts.details.hasAttribute('href')).toBe(false);
    page.viewer.next();
    expect(page.parts.details.hasAttribute('href')).toBe(false);
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

  it('never dismisses from the backdrop', () => {
    const page = boundPage();
    page.viewer.open(sequence([1, 2]), { opener: page.opener });
    fire(page.dialog, 'pointerdown', { pointerId: 1 });
    fire(page.dialog, 'pointerup', { pointerId: 1 });
    fire(page.dialog, 'click');
    expect(page.viewer.getState().open).toBe(true);
    expect(page.dialog.open).toBe(true);

    // A drag that starts on the image surface and ends outside is no dismissal either.
    fire(page.parts.media, 'pointerdown', { pointerId: 2 });
    fire(page.dialog, 'pointerup', { pointerId: 2 });
    fire(page.dialog, 'click');
    expect(page.viewer.getState().open).toBe(true);
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
    expect(page.parts.details.hidden).toBe(true);
    expect(page.parts.details.hasAttribute('href')).toBe(false);
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
      items: [rawItem(1), rawItem(2, { title: 'renamed.png', revision: 'r2', detailsUrl: null }), rawItem(3), rawItem(4)],
    }, { session });

    expect(result.outcome).toBe('kept');
    expect(page.parts.title.textContent).toBe('renamed.png');
    expect(page.parts.source.textContent).toBe('Renamed Project');
    expect(page.parts.position.textContent).toBe('2 of 4');
    // A details link the refresh dropped never lingers.
    expect(page.parts.details.hidden).toBe(true);
    expect(page.parts.details.hasAttribute('href')).toBe(false);
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
  page.images = () => page.parts.media.children.filter((child) => child.tagName === 'IMG');
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

  it('pauses on a failed slide and on Original size through B3’s real media state', async () => {
    const page = playbackPage();
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
    expect(page.viewer.media.getState().original.status).toBe('loading');
    expect(page.viewer.playback.getState()).toMatchObject({ playing: false, scheduled: false, pauseReason: 'inspection' });
    await page.respond(page.requests.at(-1));
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
    const dropdown = page.dialog.querySelector('[data-cc-dropdown]');
    dropdown.open = true;
    dropdown.setAttribute('open', '');
    fire(dropdown.querySelector('summary'), 'keydown', { key: 'Escape' });
    expect(dropdown.hasAttribute('open')).toBe(false);
    expect(page.document.exitFullscreen).not.toHaveBeenCalled();
    expect(page.dialog.open).toBe(true);
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
    for (const removeOpener of [false, true]) {
      const page = playbackPage({ holdExits: true });
      page.deferCloseEvents = true;
      page.inert(page.opener, page.hostFallback, page.main);
      page.viewer.open(slideshow([1, 2]), { opener: page.opener, fallbackFocus: () => page.hostFallback });
      await page.respond(page.requests[0]);
      page.viewer.fullscreen.enter();
      await Promise.resolve();
      controlsOf(page).fullscreen.focus();
      page.viewer.close();
      if (removeOpener) page.opener.remove();
      page.viewer.destroy();
      page.viewer.destroy();
      // The binder's queued dismissal runs without the viewer's hook; its
      // own focus return fails on the inert page.
      page.flushCloseEvents();
      expect(page.document.activeElement).not.toBe(page.opener);
      await page.leaveHeld();
      expect(page.document.activeElement).toBe(removeOpener ? page.hostFallback : page.opener);
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
