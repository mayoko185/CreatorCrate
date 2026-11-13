import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { projectImagePresentationPolicy } from '../src/services/project-image-policy.js';
import { describe, expect, it, vi } from 'vitest';
import {
  enhanceAssetDetailsViewer,
  openAssetDetailsComic,
  openAssetDetailsImage,
  reconcileAssetDetailsViewer,
} from '../src/static/client/asset-details-viewer.js';
import {
  VIEWER_COMIC_HINT_CLOSED,
  VIEWER_COMIC_HINT_RELOADING,
  VIEWER_COMIC_HINT_UNCHANGED,
} from '../src/static/client/unified-viewer.js';
import {
  ASSET_VIEWER_REFRESH_REGIONS,
  ASSET_VIEWER_REFRESH_STATUS,
  refreshAssetViewer,
  retireAssetViewer,
  supersedeAssetViewerRefresh,
} from '../src/static/client/asset-viewer-refresh.js';
import {
  createViewerSource,
  reconcileViewerSource,
  selectInitialViewerItem,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
  VIEWER_RECONCILE_KEPT,
  VIEWER_SOURCE_MODE_SINGLE,
} from '../src/static/client/viewer-sequence.js';

// B6: the Asset Details host integration for the unified viewer, and its
// reconciliation through the Asset Details refresh (asset-viewer-refresh.js).
// The page is a small purpose-built DOM shim (no jsdom in this project); the
// viewer is a controller double whose open/update follow unified-viewer.js,
// using the real B1 source and reconciliation functions. The real controller,
// media loading, fullscreen and focus restoration run in Chromium
// (tests/browser/asset-details-unified-viewer.spec.js).

// ─── DOM shim ────────────────────────────────────────────────────────────────

function parseSelector(selector) {
  const TOKEN = /#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g;
  const match = selector.trim().match(/^([a-z][a-z0-9]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!match) throw new Error(`Unsupported selector ${selector}`);
  const tokens = (match[2].match(TOKEN) || []).map((token) => {
    if (token.startsWith('#')) return { kind: 'id', value: token.slice(1) };
    if (token.startsWith('.')) return { kind: 'class', value: token.slice(1) };
    const attr = token.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/);
    return { kind: 'attr', name: attr[1], value: attr[2] };
  });
  return { tag: match[1]?.toUpperCase() || null, tokens };
}

class FakeNode {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.ownText = '';
  }

  root() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.isDocumentRoot ? node : null;
  }
  get ownerDocument() { return this.root()?.document || null; }
  get isConnected() { return Boolean(this.root()?.isLive); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  // Nested markup, as a browser serializes it: the refresh compares static
  // media (a notice, a comic frame) by its whole outerHTML.
  get outerHTML() {
    return `<${this.tagName}${[...this.attributes].map(([k, v]) => ` ${k}="${v}"`).join('')}>${this.ownText}${this.childNodes.map((node) => node.outerHTML).join('')}</${this.tagName}>`;
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  appendChild(child) {
    child.parentNode?.removeChildNode(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(node, reference) {
    node.parentNode?.removeChildNode(node);
    node.parentNode = this;
    const index = this.childNodes.indexOf(reference);
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChildNode(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
  }
  remove() { this.parentNode?.removeChildNode(this); }
  replaceChildren(...nodes) {
    [...this.childNodes].forEach((node) => this.removeChildNode(node));
    this.ownText = '';
    nodes.forEach((node) => this.appendChild(node));
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  get textContent() { return this.ownText + this.childNodes.map((node) => node.textContent).join(''); }

  matches(selector) {
    const { tag, tokens } = parseSelector(selector);
    if (tag && this.tagName !== tag) return false;
    return tokens.every((token) => {
      if (token.kind === 'id') return this.getAttribute('id') === token.value;
      if (token.kind === 'class') return (this.getAttribute('class') || '').split(/\s+/).includes(token.value);
      if (!this.hasAttribute(token.name)) return false;
      return token.value === undefined || this.getAttribute(token.name) === token.value;
    });
  }
  descendants() { return this.childNodes.flatMap((node) => [node, ...node.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node && !node.isDocumentRoot; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== listener));
  }
  dispatch(type, init = {}) {
    const event = {
      type, target: this, defaultPrevented: false, button: 0,
      preventDefault() { this.defaultPrevented = true; },
      ...init,
    };
    for (let node = this; node; node = node.parentNode) {
      (node.listeners.get(type) || []).forEach((listener) => listener(event));
    }
    if (this.root()?.isLive) (this.root().document.listeners.get(type) || []).forEach((listener) => listener(event));
    return event;
  }
  focus() { const document = this.ownerDocument; if (document) document.activeElement = this; }
  clone() {
    const copy = new FakeNode(this.tagName, Object.fromEntries(this.attributes));
    copy.ownText = this.ownText;
    this.childNodes.forEach((child) => copy.appendChild(child.clone()));
    return copy;
  }
}

function h(tag, attributes = {}, ...children) {
  const node = new FakeNode(tag, attributes);
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    if (typeof child === 'string') node.ownText += child;
    else node.appendChild(child);
  });
  return node;
}

function createDocument(body, { live = true } = {}) {
  const root = new FakeNode('#document');
  root.isDocumentRoot = true;
  root.isLive = live;
  const document = {
    nodeType: 9,
    activeElement: null,
    listeners: new Map(),
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
    importNode: (node) => node.clone(),
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    getElementById: (id) => root.querySelector(`#${id}`),
    contains: (node) => root.contains(node),
  };
  root.document = document;
  root.appendChild(body);
  document.body = body;
  return document;
}

// ─── Viewer double ───────────────────────────────────────────────────────────

// Comic sessions follow unified-viewer.js openComic()/reconcileComic(): one
// manifest request on open, none for an unchanged hint, exactly one for a
// changed hint, and `null`/`eligible: false` closes. `manifests` records each
// manifest request the controller would send (C1 owns the real ones).
function makeViewer() {
  let counter = 0;
  let active = null;
  const manifests = [];
  const viewer = {
    manifests,
    open: vi.fn((source, options = {}) => {
      const normalized = createViewerSource(source);
      const initial = selectInitialViewerItem(normalized);
      if (initial.index === -1) return 0;
      if (active) active = null;
      counter += 1;
      active = { session: counter, source: normalized, key: initial.key, options };
      return counter;
    }),
    openComic: vi.fn((descriptor, options = {}) => {
      if (!/^[1-9]\d*$/.test(String(descriptor?.projectId)) || !/^[1-9]\d*$/.test(String(descriptor?.assetId))) return 0;
      if (active) active = null;
      counter += 1;
      const comic = {
        projectId: String(descriptor.projectId),
        assetId: String(descriptor.assetId),
        title: descriptor.title,
        sourceRevision: descriptor.sourceRevision ?? null,
      };
      active = { session: counter, comic, options };
      manifests.push({ session: counter, projectId: comic.projectId, assetId: comic.assetId });
      return counter;
    }),
    reconcileComic: vi.fn((hint, options = {}) => {
      if (!active?.comic || options.session !== active.session) return null;
      if (hint === null) { active = null; return { outcome: VIEWER_COMIC_HINT_CLOSED }; }
      if (String(hint.projectId) !== active.comic.projectId || String(hint.assetId) !== active.comic.assetId) return null;
      if (hint.eligible === false) { active = null; return { outcome: VIEWER_COMIC_HINT_CLOSED }; }
      const next = hint.sourceRevision ?? null;
      if (next === null || next === active.comic.sourceRevision) return { outcome: VIEWER_COMIC_HINT_UNCHANGED };
      active.comic.sourceRevision = next;
      manifests.push({ session: active.session, projectId: active.comic.projectId, assetId: active.comic.assetId });
      return { outcome: VIEWER_COMIC_HINT_RELOADING };
    }),
    update: vi.fn((replacement, options = {}) => {
      // A comic's pages come only from its manifest: update() ignores it.
      if (!active || active.comic) return null;
      if (options.session !== undefined && options.session !== active.session) return null;
      const result = reconcileViewerSource(active.source, active.key, replacement);
      if (result.outcome === VIEWER_RECONCILE_CLOSED || result.outcome === VIEWER_RECONCILE_IDLE || !result.item) {
        active = null;
        return result;
      }
      active.source = result.source;
      active.key = result.key;
      return result;
    }),
    close() { active = null; },
    getState() {
      return {
        open: Boolean(active),
        session: active ? active.session : null,
        key: active && !active.comic ? active.key : null,
        source: active && !active.comic ? active.source : null,
        item: active && !active.comic ? active.source.items.find((item) => item.key === active.key) : null,
        comic: active?.comic ? { ...active.comic } : null,
      };
    },
  };
  return viewer;
}

// ─── Page fixture ────────────────────────────────────────────────────────────

const PROJECT_ID = 7;
const ASSET_ID = 42;
const base = `/projects/${PROJECT_ID}/assets/${ASSET_ID}`;

function media({
  kind = 'image', filename = 'hero.png', projectName, imageSources, revision = 'r1', original = true, state = 'loaded', format = 'CBZ',
  comicIdentity = { projectId: PROJECT_ID, assetId: ASSET_ID },
} = {}) {
  if (kind === 'video') {
    return h('figure', { class: 'asset-preview-frame asset-preview-frame--video', 'data-asset-video-playback': '' },
      h('video', { class: 'asset-preview-video', src: `${base}/original`, 'data-asset-video': '' }));
  }
  if (kind === 'unsupported') {
    return h('div', { class: 'notice notice--warning', role: 'status' }, h('p', {}, 'Unsupported asset preview.'));
  }
  if (kind === 'missing') {
    return h('div', { class: 'notice notice--danger', role: 'status' }, h('p', {}, 'Missing at last scan.'));
  }
  if (kind === 'comic') {
    const attributes = {
      href: `/projects/${comicIdentity.projectId}/assets/${comicIdentity.assetId}`,
      'aria-label': `Read comic ${filename}`,
      'data-asset-details-comic-trigger': '',
      'data-comic-project': comicIdentity.projectId,
      'data-comic-asset': comicIdentity.assetId,
      'data-comic-title': filename,
      'data-comic-filename': filename,
      'data-comic-source-revision': revision,
    };
    return h('figure', { class: 'asset-preview-frame', 'data-asset-comic-preview': '', 'data-comic-format': format.toLowerCase(), 'data-preview-enhancement': '', 'data-preview-state': state },
      h('a', { class: 'asset-preview-link', ...attributes, ...(state === 'failed' ? { hidden: '' } : {}) },
        h('img', { class: 'asset-preview-image', src: `${base}/preview?v=${revision}-${format.toLowerCase()}`, alt: `First page of ${filename}`, 'data-preview-image': '', ...(state === 'failed' ? { hidden: '' } : {}) })),
      h('a', { class: 'asset-preview-placeholder asset-preview-fallback', ...attributes, 'data-preview-fallback': '', ...(state === 'failed' ? {} : { hidden: '' }) }, 'Read comic'));
  }
  const previewUrl = `${base}/preview?v=${revision}`;
  const img = h('img', { class: 'asset-preview-image', src: previewUrl, alt: `Preview of ${filename}`, 'data-preview-image': '' });
  const descriptor = {
    'data-asset-details-viewer-trigger': '',
    'data-viewer-filename': filename,
    ...(projectName === undefined ? {} : { 'data-viewer-project-name': projectName }),
    'data-viewer-preview-url': previewUrl,
    'data-viewer-revision': revision,
    ...(imageSources === undefined ? {} : { 'data-viewer-image-sources': JSON.stringify(imageSources) }),
  };
  const trigger = original
    ? h('a', { class: 'asset-preview-link', href: `${base}/original`, 'aria-label': `View original ${filename}`, ...descriptor, 'data-viewer-original-url': `${base}/original` }, img)
    : h('button', { type: 'button', class: 'asset-preview-link asset-preview-view-button', 'aria-label': `View preview of ${filename}`, ...descriptor }, img);
  return h('figure', { class: 'asset-preview-frame', 'data-preview-enhancement': '', 'data-preview-state': state }, trigger);
}

function buildPage({ filename = 'hero.png', assetId = ASSET_ID, projectId = PROJECT_ID, comicIdentity = { projectId, assetId }, ...mediaOptions } = {}) {
  const host = h('div', {
    class: 'asset-preview-viewer',
    'data-asset-viewer-host': '',
    'data-asset-viewer-project-id': projectId,
    'data-asset-viewer-asset-id': assetId,
  },
  media({ filename, comicIdentity, ...mediaOptions }),
  h('a', { class: 'asset-preview-nav asset-preview-nav--previous', rel: 'prev', href: `/projects/${projectId}/assets/41` }),
  h('a', { class: 'asset-preview-nav asset-preview-nav--next', rel: 'next', href: `/projects/${projectId}/assets/43` }));
  const body = h('body', {},
    h('nav', { class: 'asset-viewer-action-toolbar' },
      h('a', { class: 'asset-viewer-back', href: `/projects/${projectId}/assets` }),
      h('a', { class: 'asset-viewer-open-locally', href: 'creatorcrate://open' })),
    h('main', { id: 'main-content' },
      h('div', { 'data-asset-viewer-region': 'filter-notice', 'data-asset-viewer-filtered-out': 'false' }),
      h('section', { class: 'asset-preview-section' }, h('h2', { id: 'asset-preview-heading' }, 'Preview'), host),
      h('dl', { 'data-asset-viewer-region': 'file-summary', 'data-asset-filename': filename, 'data-asset-destination': 'uncategorized', 'data-asset-category-label': 'Uncategorized' },
        h('dd', {}, filename), h('a', { class: 'metadata-link', href: '/releases/3' }, 'Release')),
      h('dl', { 'data-asset-viewer-region': 'file-details' }, h('dd', {}, 'png')),
      h('div', { 'data-asset-viewer-region': 'tags' }, h('p', {}, 'tags'))),
    h('dialog', { id: 'unified-viewer-dialog' }));
  return { body, host, title: `Assets — ${filename}` };
}

const htmlResponse = (html, status = 200) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(html) });

function setup(pageOptions = {}, { withViewer = true } = {}) {
  const page = buildPage(pageOptions);
  const document = createDocument(page.body);
  const viewer = makeViewer();
  if (withViewer) page.body.querySelector('#unified-viewer-dialog').__creatorCrateUnifiedViewer = viewer;
  const requests = [];
  const queue = [];
  const pages = new Map();
  document.defaultView = {
    location: { href: `http://creatorcrate.local${base}?category=all` },
    DOMParser: class {
      parseFromString(html) {
        const options = pages.get(html);
        if (!options) return createDocument(h('body', {}, h('main', {}, 'Sign in')), { live: false });
        const built = buildPage(options);
        const parsed = createDocument(built.body, { live: false });
        parsed.title = built.title;
        return parsed;
      }
    },
    fetch: vi.fn((url, init) => {
      requests.push({ url, method: init.method });
      const next = queue.shift();
      if (!next) throw new Error(`Unexpected ${init.method} ${url}`);
      return typeof next === 'function' ? next() : next;
    }),
  };
  const serverPage = (key, options) => { pages.set(key, options); return htmlResponse(key); };
  const trigger = () => page.host.querySelector('[data-asset-details-viewer-trigger]');
  const refresh = (regions = [ASSET_VIEWER_REFRESH_REGIONS.FILE]) => refreshAssetViewer(document, { projectId: PROJECT_ID, assetId: ASSET_ID, regions });
  return { ...page, document, viewer, requests, queue, serverPage, trigger, refresh };
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

function openViaClick(t, init = {}) {
  enhanceAssetDetailsViewer(t.document);
  return t.trigger().querySelector('img').dispatch('click', init);
}

// ─── Opening ─────────────────────────────────────────────────────────────────

describe('Asset Details unified viewer — opening', () => {
  it('an unmodified click on the original link opens only this image, in single-image mode', () => {
    const t = setup();
    const event = openViaClick(t);
    expect(event.defaultPrevented).toBe(true);
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
    const [source, options] = t.viewer.open.mock.calls[0];
    expect(source.mode).toBe(VIEWER_SOURCE_MODE_SINGLE);
    expect(source.wrap).toBe(false);
    expect(source.slideshow).toBe(false);
    expect(source.key).toBe(`asset-details:${PROJECT_ID}:${ASSET_ID}`);
    expect(source.items).toHaveLength(1);
    expect(source.items[0]).toMatchObject({
      key: `p:${PROJECT_ID}|a:${ASSET_ID}`,
      projectId: String(PROJECT_ID),
      assetId: String(ASSET_ID),
      title: 'hero.png',
      mediaUrl: `${base}/preview?v=r1`,
      originalUrl: `${base}/original`,
      revision: 'r1',
      available: true,
      // Already on its Asset Details page: no View details link to itself.
      detailsUrl: null,
    });
    expect(options.opener).toBe(t.trigger());
    expect(t.requests).toHaveLength(0);
  });

  it('a preview-only image opens with no original URL (Original Size unavailable)', () => {
    const t = setup({ original: false, filename: 'paint.kra' });
    expect(t.trigger().tagName).toBe('BUTTON');
    openViaClick(t);
    const [source] = t.viewer.open.mock.calls[0];
    expect(source.items[0].mediaUrl).toBe(`${base}/preview?v=r1`);
    expect(source.items[0].originalUrl).toBeNull();
    expect(source.items[0].title).toBe('paint.kra');
  });

  it('modified and non-primary clicks keep the link’s own behavior', () => {
    const t = setup();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = openViaClick(t, init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(t.viewer.open).not.toHaveBeenCalled();
  });

  it('page Previous/Next, toolbar and metadata links are never intercepted', () => {
    const t = setup();
    enhanceAssetDetailsViewer(t.document);
    const links = [
      t.host.querySelector('a.asset-preview-nav--previous'),
      t.host.querySelector('a.asset-preview-nav--next'),
      t.body.querySelector('a.asset-viewer-back'),
      t.body.querySelector('a.asset-viewer-open-locally'),
      t.body.querySelector('a.metadata-link'),
    ];
    for (const link of links) expect(link.dispatch('click').defaultPrevented).toBe(false);
    expect(t.viewer.open).not.toHaveBeenCalled();
  });

  it('video and unsupported assets have nothing to intercept', () => {
    for (const kind of ['video', 'unsupported']) {
      const t = setup({ kind });
      enhanceAssetDetailsViewer(t.document);
      expect(t.trigger()).toBeNull();
      expect(openAssetDetailsImage(t.document)).toBe(0);
      const video = t.host.querySelector('video');
      if (video) expect(video.dispatch('click').defaultPrevented).toBe(false);
      expect(t.viewer.open).not.toHaveBeenCalled();
    }
  });

  it('falls back to the link when no viewer is mounted, the URL is unsafe or the page is retired', () => {
    const noViewer = setup({}, { withViewer: false });
    expect(openViaClick(noViewer).defaultPrevented).toBe(false);

    const unsafe = setup();
    unsafe.trigger().setAttribute('data-viewer-preview-url', 'javascript:alert(1)');
    expect(openViaClick(unsafe).defaultPrevented).toBe(false);
    expect(unsafe.viewer.open).not.toHaveBeenCalled();

    const retired = setup();
    retireAssetViewer(retired.document);
    expect(openViaClick(retired).defaultPrevented).toBe(false);
    expect(retired.viewer.open).not.toHaveBeenCalled();
  });

  it('binds once however often it is enhanced', () => {
    const t = setup();
    expect(enhanceAssetDetailsViewer(t.document)).toBe(1);
    expect(enhanceAssetDetailsViewer(t.document)).toBe(1);
    expect(t.document.listeners.get('click')).toHaveLength(1);
    t.trigger().dispatch('click');
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
  });

  it('is inert on a page without the Asset Details media host', () => {
    const document = createDocument(h('body', {}, h('main', {})));
    expect(enhanceAssetDetailsViewer(document)).toBe(0);
    expect(document.listeners.size).toBe(0);
  });
});

// ─── Focus fallback ──────────────────────────────────────────────────────────

describe('Asset Details unified viewer — focus fallback', () => {
  it('resolves the current preview trigger, else the Preview heading', () => {
    const t = setup();
    openViaClick(t);
    const { fallbackFocus } = t.viewer.open.mock.calls[0][1];
    expect(fallbackFocus()).toBe(t.trigger());

    // A rebuilt preview: the new trigger, not the disconnected opener.
    const opener = t.trigger();
    const figure = t.host.querySelector('figure');
    figure.remove();
    t.host.insertBefore(media({ original: false }), t.host.querySelector('a.asset-preview-nav--previous'));
    expect(opener.isConnected).toBe(false);
    expect(fallbackFocus()).toBe(t.trigger());
    expect(fallbackFocus().tagName).toBe('BUTTON');

    // A failed preview hides its trigger; then the heading takes focus.
    t.host.querySelector('figure').setAttribute('data-preview-state', 'failed');
    const heading = t.body.querySelector('#asset-preview-heading');
    expect(fallbackFocus()).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });
});

// ─── Refresh reconciliation ──────────────────────────────────────────────────

describe('Asset Details unified viewer — refresh reconciliation', () => {
  it('a tags or primary-image refresh never touches the viewer', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(t.serverPage('tags', { revision: 'r9', filename: 'other.png' }));
    expect((await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.TAGS])).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(t.viewer.update).not.toHaveBeenCalled();
    expect(t.viewer.getState().item.revision).toBe('r1');
  });

  it('a file refresh that changes nothing the viewer shows keeps the session without an update', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(t.serverPage('same', {}));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(t.viewer.update).not.toHaveBeenCalled();
    expect(t.viewer.getState().open).toBe(true);
  });

  it('a rename updates title and revision and reloads the media, keeping the same item and trigger', async () => {
    const t = setup();
    openViaClick(t);
    const opener = t.trigger();
    t.queue.push(t.serverPage('renamed', { filename: 'hero-final.png', revision: 'r2' }));
    const result = await t.refresh();
    expect(result.status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(result.mediaReplaced).toBe(false);
    // The trigger element stays (focus can return to it); its descriptor moved on.
    expect(t.trigger()).toBe(opener);
    expect(opener.getAttribute('data-viewer-filename')).toBe('hero-final.png');
    expect(opener.getAttribute('data-viewer-revision')).toBe('r2');
    expect(opener.getAttribute('aria-label')).toBe('View original hero-final.png');

    expect(t.viewer.update).toHaveBeenCalledTimes(1);
    const reconciled = t.viewer.update.mock.results[0].value;
    expect(reconciled.outcome).toBe(VIEWER_RECONCILE_KEPT);
    expect(reconciled.revisionChanged).toBe(true);
    expect(reconciled.mediaChanged).toBe(true);
    expect(reconciled.reload).toBe(true);
    expect(reconciled.preserveView).toBe(false);
    expect(t.viewer.getState().item).toMatchObject({ title: 'hero-final.png', revision: 'r2', mediaUrl: `${base}/preview?v=r2` });
  });

  it('a changed URL alone reloads the media', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(t.serverPage('url', {}));
    const parsedUrl = `${base}/preview?v=r1&fmt=webp`;
    // The server render with only the preview URL changed.
    const original = t.document.defaultView.DOMParser;
    t.document.defaultView.DOMParser = class extends original {
      parseFromString(html) {
        const parsed = super.parseFromString(html);
        const trigger = parsed.querySelector('[data-asset-details-viewer-trigger]');
        trigger.setAttribute('data-viewer-preview-url', parsedUrl);
        trigger.querySelector('img').setAttribute('src', parsedUrl);
        return parsed;
      }
    };
    await t.refresh();
    const reconciled = t.viewer.update.mock.results[0].value;
    expect(reconciled.revisionChanged).toBe(false);
    expect(reconciled.mediaChanged).toBe(true);
    expect(reconciled.reload).toBe(true);
    expect(t.viewer.getState().item.mediaUrl).toBe(parsedUrl);
  });

  it('a lost original eligibility updates the controls and returns focus to the rebuilt trigger', async () => {
    const t = setup();
    openViaClick(t);
    const opener = t.trigger();
    t.queue.push(t.serverPage('no-original', { original: false }));
    const result = await t.refresh();
    expect(result.mediaReplaced).toBe(true);
    expect(opener.isConnected).toBe(false);
    const reconciled = t.viewer.update.mock.results[0].value;
    expect(reconciled.outcome).toBe(VIEWER_RECONCILE_KEPT);
    expect(reconciled.originalChanged).toBe(true);
    expect(reconciled.preserveView).toBe(false);
    expect(t.viewer.getState().item.originalUrl).toBeNull();
    const { fallbackFocus } = t.viewer.open.mock.calls[0][1];
    expect(fallbackFocus()).toBe(t.trigger());
    expect(t.trigger().tagName).toBe('BUTTON');
  });

  it.each(['video', 'unsupported'])('an image replaced by %s media closes the viewer', async (kind) => {
    const t = setup();
    openViaClick(t);
    t.queue.push(t.serverPage(kind, { kind }));
    expect((await t.refresh()).mediaReplaced).toBe(true);
    expect(t.viewer.update).toHaveBeenCalledTimes(1);
    expect(t.viewer.update.mock.results[0].value.outcome).toBe(VIEWER_RECONCILE_CLOSED);
    expect(t.viewer.getState().open).toBe(false);
    // The closed session ignores any later refresh.
    t.queue.push(t.serverPage('back', { revision: 'r5' }));
    await t.refresh();
    expect(t.viewer.update).toHaveBeenCalledTimes(1);
  });

  it('a 404 (asset gone) closes the viewer', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(htmlResponse('', 404));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.MISSING);
    expect(t.viewer.getState().open).toBe(false);
    expect(t.viewer.update.mock.calls[0][0].items).toEqual([]);
  });

  it('retiring the page (Delete) closes the viewer and refuses to reopen it', () => {
    const t = setup();
    openViaClick(t);
    retireAssetViewer(t.document);
    expect(t.viewer.getState().open).toBe(false);
    expect(openAssetDetailsImage(t.document)).toBe(0);
  });

  it('a failed or foreign read installs nothing and leaves the viewer as it was', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(htmlResponse('', 500));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    t.queue.push(t.serverPage('other-asset', { assetId: 99, revision: 'r7' }));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    t.queue.push(t.serverPage('other-project', { projectId: 8, revision: 'r7' }));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    expect(t.viewer.update).not.toHaveBeenCalled();
    expect(t.viewer.getState().item.revision).toBe('r1');
  });

  it('a superseded read can never overwrite newer media', async () => {
    const t = setup();
    openViaClick(t);
    let releaseOld;
    t.queue.push(() => new Promise((resolve) => { releaseOld = () => resolve(t.serverPage('old', { revision: 'r-old' })); }));
    const older = t.refresh();
    await flush();
    t.queue.push(t.serverPage('new', { revision: 'r-new' }));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(t.viewer.getState().item.revision).toBe('r-new');
    releaseOld();
    expect((await older).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(t.viewer.getState().item.revision).toBe('r-new');
    expect(t.viewer.update).toHaveBeenCalledTimes(1);
    expect(t.trigger().getAttribute('data-viewer-revision')).toBe('r-new');
  });

  it('a read sent before a mutation began is superseded and never reaches the viewer', async () => {
    const t = setup();
    openViaClick(t);
    let release;
    t.queue.push(() => new Promise((resolve) => { release = () => resolve(t.serverPage('stale', { revision: 'r-stale' })); }));
    const pending = t.refresh();
    await flush();
    supersedeAssetViewerRefresh(t.document);
    release();
    expect((await pending).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(t.viewer.update).not.toHaveBeenCalled();
  });

  it('a new session never receives the old session’s refresh, and reconcile ignores foreign sessions', async () => {
    const t = setup();
    openViaClick(t);
    t.viewer.close();
    // Another host's session (the viewer is shared): never touched.
    t.viewer.open(createViewerSource({ key: 'other', items: [{ assetId: '1', mediaUrl: '/x.png' }] }));
    t.queue.push(t.serverPage('later', { revision: 'r3' }));
    await t.refresh();
    expect(t.viewer.update).not.toHaveBeenCalled();
    expect(reconcileAssetDetailsViewer(t.document, { gone: true })).toBeNull();
    expect(t.viewer.getState().source.key).toBe('other');

    // Reopened from the page: the new session follows the next refresh only.
    t.viewer.close();
    openViaClick(t);
    t.queue.push(t.serverPage('later-2', { revision: 'r4' }));
    await t.refresh();
    expect(t.viewer.update).toHaveBeenCalledTimes(1);
    expect(t.viewer.update.mock.calls[0][1].session).toBe(t.viewer.getState().session);
    expect(t.viewer.getState().item.revision).toBe('r4');
  });

  it('repeated refreshes add no listeners', async () => {
    const t = setup();
    enhanceAssetDetailsViewer(t.document);
    for (let i = 0; i < 3; i += 1) {
      t.queue.push(t.serverPage(`rev-${i}`, { revision: `r${10 + i}`, original: i % 2 === 0 }));
      await t.refresh();
      enhanceAssetDetailsViewer(t.document);
    }
    expect(t.document.listeners.get('click')).toHaveLength(1);
    expect(t.trigger().listeners.size).toBe(0);
    t.trigger().dispatch('click');
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
    expect(t.viewer.open.mock.calls[0][0].items[0].revision).toBe('r12');
  });

  it('opening and refreshing send only the refresh’s own GETs, never a mutation', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(t.serverPage('get', { revision: 'r2' }));
    await t.refresh();
    expect(t.requests.map((request) => request.method)).toEqual(['GET']);
  });
});

// ─── Persistent gone (B6-F1) ─────────────────────────────────────────────────
//
// An accepted authoritative gone (a current 404, or retirement) invalidates
// the page's preview trigger for good: closing the viewer is not enough, the
// stale descriptor must never open it again, whether or not it was open.

const OBSERVERS_KEY = '__creatorCrateAssetViewerRefreshObservers';
const goneMarker = (t) => t.host.querySelector('[data-asset-details-viewer-gone]');
const previewImage = (t) => t.host.querySelector('img[data-preview-image]');

function expectInert(t, { image }) {
  // No trigger: no link to the original, no viewer button, nothing to click.
  expect(t.trigger()).toBeNull();
  expect(t.host.querySelector('a.asset-preview-link')).toBeNull();
  expect(t.host.querySelector('button')).toBeNull();
  const marker = goneMarker(t);
  expect(marker.tagName).toBe('SPAN');
  expect(marker.hasAttribute('href')).toBe(false);
  expect(marker.hasAttribute('aria-label')).toBe(false);
  // The same, already loaded image node: moved, never re-requested.
  expect(previewImage(t)).toBe(image);
  expect(image.parentNode).toBe(marker);
  expect(t.host.querySelector('figure').getAttribute('class')).toContain('asset-preview-frame--gone');
  // Previous/Next are page navigation and stay.
  expect(t.host.querySelector('a.asset-preview-nav--previous')).not.toBeNull();
}

describe('Asset Details unified viewer — persistent gone (B6-F1)', () => {
  it.each([
    ['original link', { original: true }],
    ['preview-only button', { original: false, filename: 'paint.kra' }],
  ])('an open viewer closes on a current 404, and the old %s never reopens it', async (_label, options) => {
    const t = setup(options);
    openViaClick(t);
    expect(t.viewer.getState().open).toBe(true);
    const opener = t.trigger();
    const image = previewImage(t);
    const { fallbackFocus } = t.viewer.open.mock.calls[0][1];

    t.queue.push(htmlResponse('', 404));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.MISSING);
    expect(t.viewer.getState().open).toBe(false);
    expect(t.viewer.update).toHaveBeenCalledTimes(1);
    expect(t.viewer.update.mock.calls[0][0].items).toEqual([]);
    expectInert(t, { image });

    // The old opener is disconnected: the viewer's focus return falls back to
    // the Preview heading, never to the removed trigger.
    expect(opener.isConnected).toBe(false);
    const heading = t.body.querySelector('#asset-preview-heading');
    expect(fallbackFocus()).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');

    // Clicking the image, the stale (detached) opener, or calling the host
    // directly opens nothing and requests nothing.
    expect(image.dispatch('click').defaultPrevented).toBe(false);
    opener.dispatch('click');
    expect(openAssetDetailsImage(t.document)).toBe(0);
    expect(openAssetDetailsImage(t.document, opener)).toBe(0);
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
    expect(t.viewer.getState().open).toBe(false);
    expect(t.requests).toHaveLength(1);
  });

  it.each([
    ['original link', { original: true }],
    ['preview-only button', { original: false, filename: 'paint.kra' }],
  ])('a 404 while the viewer is already closed invalidates the old %s too', async (_label, options) => {
    const t = setup(options);
    openViaClick(t);
    t.viewer.close();
    const image = previewImage(t);

    t.queue.push(htmlResponse('', 404));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.MISSING);
    // Nothing reopened only to show the gone asset.
    expect(t.viewer.update).not.toHaveBeenCalled();
    expect(t.viewer.getState().open).toBe(false);
    expectInert(t, { image });

    expect(image.dispatch('click').defaultPrevented).toBe(false);
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
    expect(t.viewer.getState().open).toBe(false);
  });

  it('a gone page that was never opened (only enhanced) is invalidated as well', async () => {
    const t = setup();
    enhanceAssetDetailsViewer(t.document);
    const image = previewImage(t);
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expectInert(t, { image });
    expect(image.dispatch('click').defaultPrevented).toBe(false);
    expect(t.viewer.open).not.toHaveBeenCalled();
  });

  it('a focused trigger hands focus to the Preview heading, never to the body or a removed element', async () => {
    const t = setup({ original: false });
    enhanceAssetDetailsViewer(t.document);
    t.trigger().focus();
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    const heading = t.body.querySelector('#asset-preview-heading');
    expect(t.document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('focus elsewhere on the page is left alone', async () => {
    const t = setup();
    enhanceAssetDetailsViewer(t.document);
    const back = t.body.querySelector('a.asset-viewer-back');
    back.focus();
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expect(t.document.activeElement).toBe(back);
  });

  it('a repeated gone (404 again, then retirement) is idempotent: no extra cleanup, observers or listeners', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    const marker = goneMarker(t);
    const figureClass = t.host.querySelector('figure').getAttribute('class');

    t.queue.push(htmlResponse('', 404));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.MISSING);
    retireAssetViewer(t.document);
    enhanceAssetDetailsViewer(t.document);

    expect(t.viewer.update).toHaveBeenCalledTimes(1);
    expect(goneMarker(t)).toBe(marker);
    expect(t.host.querySelectorAll('[data-asset-details-viewer-gone]')).toHaveLength(1);
    expect(t.host.querySelector('figure').getAttribute('class')).toBe(figureClass);
    expect(t.document[OBSERVERS_KEY].size).toBe(1);
    expect(t.document.listeners.get('click')).toHaveLength(1);
    expect(previewImage(t).dispatch('click').defaultPrevented).toBe(false);
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
  });

  it('a failed read (network error or 5xx) never marks the asset gone', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(() => Promise.reject(new TypeError('Failed to fetch')));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    t.queue.push(htmlResponse('', 503));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    expect(goneMarker(t)).toBeNull();
    expect(t.viewer.getState().open).toBe(true);
    t.viewer.close();
    openViaClick(t);
    expect(t.viewer.open).toHaveBeenCalledTimes(2);
    expect(t.viewer.getState().open).toBe(true);
  });

  it('a superseded 404 never invalidates the page or a newer session', async () => {
    const t = setup();
    openViaClick(t);
    let releaseOld;
    t.queue.push(() => new Promise((resolve) => { releaseOld = () => resolve(htmlResponse('', 404)); }));
    const older = t.refresh();
    await flush();
    t.queue.push(t.serverPage('newer', { revision: 'r2' }));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    releaseOld();
    expect((await older).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(goneMarker(t)).toBeNull();
    expect(t.viewer.getState().open).toBe(true);
    expect(t.viewer.getState().item.revision).toBe('r2');

    // Likewise a 404 for a read sent before a mutation began.
    let releaseStale;
    t.queue.push(() => new Promise((resolve) => { releaseStale = () => resolve(htmlResponse('', 404)); }));
    const stale = t.refresh();
    await flush();
    supersedeAssetViewerRefresh(t.document);
    releaseStale();
    expect((await stale).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(goneMarker(t)).toBeNull();
    expect(t.viewer.getState().open).toBe(true);
  });

  it('a foreign asset or project can neither be requested for nor invalidate this page', async () => {
    const t = setup();
    openViaClick(t);
    // Another asset's or project's identity: the refresh is unavailable and
    // sends nothing, so no 404 can be attributed to this page.
    expect((await refreshAssetViewer(t.document, { projectId: PROJECT_ID, assetId: 99 })).status)
      .toBe(ASSET_VIEWER_REFRESH_STATUS.UNAVAILABLE);
    expect((await refreshAssetViewer(t.document, { projectId: 8, assetId: ASSET_ID })).status)
      .toBe(ASSET_VIEWER_REFRESH_STATUS.UNAVAILABLE);
    expect(t.requests).toHaveLength(0);
    // Another asset's page answered: failed, never gone.
    t.queue.push(t.serverPage('other', { assetId: 99 }));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    expect(goneMarker(t)).toBeNull();
    expect(t.viewer.getState().open).toBe(true);
  });

  it('a gone mark recorded for another asset identity never blocks this host', async () => {
    const t = setup();
    enhanceAssetDetailsViewer(t.document);
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expect(openAssetDetailsImage(t.document)).toBe(0);
    // The host now shows another asset (a rebuilt page): its own trigger opens.
    const other = buildPage({ assetId: 43, original: false });
    t.host.replaceChildren(...other.host.childNodes);
    t.host.setAttribute('data-asset-viewer-asset-id', '43');
    expect(openAssetDetailsImage(t.document)).toBeGreaterThan(0);
    expect(t.viewer.getState().source.key).toBe(`asset-details:${PROJECT_ID}:43`);
  });

  it('an older success can never undo a newer gone', async () => {
    const t = setup();
    openViaClick(t);
    let releaseOld;
    t.queue.push(() => new Promise((resolve) => { releaseOld = () => resolve(t.serverPage('older-ok', { revision: 'r-old' })); }));
    const older = t.refresh();
    await flush();
    t.queue.push(htmlResponse('', 404));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.MISSING);
    releaseOld();
    expect((await older).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(goneMarker(t)).not.toBeNull();
    expect(t.trigger()).toBeNull();
    expect(previewImage(t).dispatch('click').defaultPrevented).toBe(false);
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
  });

  it('a later tags-only install keeps the gone mark (its descriptor was never re-read)', async () => {
    const t = setup();
    enhanceAssetDetailsViewer(t.document);
    t.queue.push(htmlResponse('', 404));
    await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.TAGS]);
    t.queue.push(t.serverPage('tags-later', {}));
    expect((await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.TAGS])).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(goneMarker(t)).not.toBeNull();
    expect(openAssetDetailsImage(t.document)).toBe(0);
  });

  it.each([
    ['original link', { original: true }, 'A'],
    ['preview-only button', { original: false }, 'BUTTON'],
  ])('only a newer current file install rebuilds a viewable %s', async (_label, options, tagName) => {
    const t = setup();
    enhanceAssetDetailsViewer(t.document);
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expect(t.trigger()).toBeNull();

    t.queue.push(t.serverPage(`back-${tagName}`, { revision: 'r5', ...options }));
    const result = await t.refresh();
    expect(result.status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(result.mediaReplaced).toBe(true);
    expect(goneMarker(t)).toBeNull();
    expect(t.host.querySelector('figure').getAttribute('class')).not.toContain('asset-preview-frame--gone');
    expect(t.trigger().tagName).toBe(tagName);
    expect(t.trigger().getAttribute('data-viewer-revision')).toBe('r5');
    t.trigger().querySelector('img').dispatch('click');
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
    expect(t.viewer.open.mock.calls[0][0].items[0].revision).toBe('r5');
  });

  it('retirement alone (Delete) invalidates the trigger and closes the viewer, as before', () => {
    const t = setup();
    openViaClick(t);
    const image = previewImage(t);
    retireAssetViewer(t.document);
    expect(t.viewer.getState().open).toBe(false);
    expect(t.host.hasAttribute('data-asset-viewer-retired')).toBe(true);
    expectInert(t, { image });
    expect(openAssetDetailsImage(t.document)).toBe(0);
    expect(image.dispatch('click').defaultPrevented).toBe(false);
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
  });

  it('a gone page with no image (video) records gone without touching its media', async () => {
    const t = setup({ kind: 'video' });
    enhanceAssetDetailsViewer(t.document);
    const video = t.host.querySelector('video');
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expect(t.host.querySelector('video')).toBe(video);
    expect(goneMarker(t)).toBeNull();
    expect(t.viewer.open).not.toHaveBeenCalled();
  });
});

// ─── Comics (C2b) ────────────────────────────────────────────────────────────
//
// An eligible comic's Read Comic link opens the shared viewer's comic reader
// (openComic); accepted 'file' installs reconcile it through reconcileComic();
// gone invalidates the link persistently, exactly like the image trigger.

const COMIC_HINT = 'h-aaaa1111';
const comicPage = (options = {}) => ({ kind: 'comic', filename: 'issue.cbz', revision: COMIC_HINT, ...options });
const comicTrigger = (t) => t.host.querySelector('[data-asset-details-comic-trigger]');
const comicGone = (t) => t.host.querySelector('[data-asset-details-viewer-gone]');

function openComicViaClick(t, init = {}) {
  enhanceAssetDetailsViewer(t.document);
  return comicTrigger(t).querySelector('[data-preview-image]').dispatch('click', init);
}

describe('Asset Details comics — opening', () => {
  it('an unmodified click opens this comic through openComic with the page identity and the indexed hint only', () => {
    const t = setup(comicPage());
    const event = openComicViaClick(t);
    expect(event.defaultPrevented).toBe(true);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
    expect(t.viewer.open).not.toHaveBeenCalled();
    const [descriptor, options] = t.viewer.openComic.mock.calls[0];
    expect(descriptor).toEqual({ projectId: PROJECT_ID, assetId: ASSET_ID, title: 'issue.cbz', filename: 'issue.cbz', sourceRevision: COMIC_HINT });
    // No manifest revision is fabricated: the reader obtains it itself.
    expect(Object.keys(descriptor)).not.toContain('revision');
    expect(options.opener).toBe(comicTrigger(t));
    expect(t.viewer.getState()).toMatchObject({ open: true, comic: { projectId: String(PROJECT_ID), assetId: String(ASSET_ID) } });
    expect(t.viewer.manifests).toHaveLength(1);
    // Opening sends nothing of its own: no GET, no mutation.
    expect(t.requests).toHaveLength(0);
  });

  it('keyboard activation (Enter on the link dispatches click with detail 0) opens it too', () => {
    const t = setup(comicPage());
    enhanceAssetDetailsViewer(t.document);
    const event = comicTrigger(t).dispatch('click', { detail: 0 });
    expect(event.defaultPrevented).toBe(true);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
  });

  it('modified and non-primary clicks keep the link’s own navigation', () => {
    const t = setup(comicPage());
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(openComicViaClick(t, init).defaultPrevented).toBe(false);
    }
    expect(t.viewer.openComic).not.toHaveBeenCalled();
    expect(t.viewer.manifests).toHaveLength(0);
  });

  it('enhancing, hovering and other page activation request no manifest or page', () => {
    const t = setup(comicPage());
    enhanceAssetDetailsViewer(t.document);
    comicTrigger(t).dispatch('mouseover');
    comicTrigger(t).dispatch('focus');
    for (const link of [t.host.querySelector('a.asset-preview-nav--next'), t.body.querySelector('a.asset-viewer-back'), t.body.querySelector('a.metadata-link')]) {
      expect(link.dispatch('click').defaultPrevented).toBe(false);
    }
    expect(t.viewer.openComic).not.toHaveBeenCalled();
    expect(t.viewer.manifests).toHaveLength(0);
    expect(t.requests).toHaveLength(0);
  });

  it('never enters the image activation path, and an image never enters the comic path', () => {
    const comic = setup(comicPage());
    openComicViaClick(comic);
    expect(comic.trigger()).toBeNull();
    expect(openAssetDetailsImage(comic.document)).toBe(0);
    expect(comic.viewer.open).not.toHaveBeenCalled();

    const image = setup();
    openViaClick(image);
    expect(openAssetDetailsComic(image.document)).toBe(0);
    expect(image.viewer.openComic).not.toHaveBeenCalled();
    expect(image.viewer.open).toHaveBeenCalledTimes(1);
  });

  it('a link naming another project or asset, or a malformed identity, opens nothing', () => {
    for (const comicIdentity of [{ projectId: 8, assetId: ASSET_ID }, { projectId: PROJECT_ID, assetId: 99 }]) {
      const t = setup(comicPage({ comicIdentity }));
      expect(openComicViaClick(t).defaultPrevented).toBe(false);
      expect(openAssetDetailsComic(t.document)).toBe(0);
      expect(t.viewer.openComic).not.toHaveBeenCalled();
    }
    const malformed = setup(comicPage());
    malformed.host.setAttribute('data-asset-viewer-asset-id', '42abc');
    comicTrigger(malformed).setAttribute('data-comic-asset', '42abc');
    expect(openComicViaClick(malformed).defaultPrevented).toBe(false);
    expect(malformed.viewer.openComic).not.toHaveBeenCalled();

    const noHint = setup(comicPage());
    comicTrigger(noHint).removeAttribute('data-comic-source-revision');
    expect(openAssetDetailsComic(noHint.document)).toBe(0);
    expect(noHint.viewer.openComic).not.toHaveBeenCalled();
  });

  it('falls back to the link’s navigation when no viewer is mounted or the page is retired', () => {
    const noViewer = setup(comicPage(), { withViewer: false });
    expect(openComicViaClick(noViewer).defaultPrevented).toBe(false);
    const retired = setup(comicPage());
    retireAssetViewer(retired.document);
    expect(openAssetDetailsComic(retired.document)).toBe(0);
    expect(retired.viewer.openComic).not.toHaveBeenCalled();
  });

  it('repeated activation reuses the one delegated listener and replaces the session', () => {
    const t = setup(comicPage());
    for (let i = 0; i < 3; i += 1) enhanceAssetDetailsViewer(t.document);
    expect(t.document.listeners.get('click')).toHaveLength(1);
    expect(comicTrigger(t).listeners.size).toBe(0);
    openComicViaClick(t);
    const first = t.viewer.getState().session;
    openComicViaClick(t);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(2);
    expect(t.viewer.getState().session).toBe(first + 1);
    expect(t.viewer.reconcileComic).not.toHaveBeenCalled();
  });

  it('focus falls back to the rebuilt link, else the Preview heading — never a detached element', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    const { fallbackFocus } = t.viewer.openComic.mock.calls[0][1];
    const opener = comicTrigger(t);
    expect(fallbackFocus()).toBe(opener);
    t.queue.push(t.serverPage('renamed-comic', comicPage({ filename: 'issue-2.cbz', revision: 'h-bbbb' })));
    expect((await t.refresh()).mediaReplaced).toBe(false);
    expect(opener.isConnected).toBe(true);
    expect(fallbackFocus()).toBe(opener);
    expect(fallbackFocus().isConnected).toBe(true);
    t.queue.push(t.serverPage('unsupported-now', { kind: 'unsupported' }));
    await t.refresh();
    const heading = t.body.querySelector('#asset-preview-heading');
    expect(fallbackFocus()).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });
});

describe('Asset Details comics — accepted file refresh', () => {
  it('an unchanged hint keeps the session, its link and requests no manifest; repeats stay quiet', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    const link = comicTrigger(t);
    const session = t.viewer.getState().session;
    for (let i = 0; i < 3; i += 1) {
      t.queue.push(t.serverPage(`same-${i}`, comicPage()));
      const result = await t.refresh();
      expect(result.status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
      expect(result.mediaReplaced).toBe(false);
    }
    expect(comicTrigger(t)).toBe(link);
    expect(t.viewer.reconcileComic).toHaveBeenCalledTimes(3);
    for (const call of t.viewer.reconcileComic.mock.results) expect(call.value.outcome).toBe(VIEWER_COMIC_HINT_UNCHANGED);
    expect(t.viewer.getState()).toMatchObject({ open: true, session });
    expect(t.viewer.manifests).toHaveLength(1);
    expect(t.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('a tags or primary-image install never reconciles the comic', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.queue.push(t.serverPage('tags-changed-hint', comicPage({ revision: 'h-other' })));
    await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.TAGS]);
    t.queue.push(t.serverPage('primary-changed-hint', comicPage({ revision: 'h-other' })));
    await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.PRIMARY_IMAGE]);
    expect(t.viewer.reconcileComic).not.toHaveBeenCalled();
    expect(t.viewer.manifests).toHaveLength(1);
  });

  it('a changed hint (rename) rebuilds the link and requests exactly one fresh manifest for the same session', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    const session = t.viewer.getState().session;
    t.queue.push(t.serverPage('renamed', comicPage({ filename: 'issue-final.cbz', revision: 'h-bbbb2222' })));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(t.viewer.reconcileComic).toHaveBeenCalledTimes(1);
    const [hint, options] = t.viewer.reconcileComic.mock.calls[0];
    expect(hint).toEqual({ projectId: PROJECT_ID, assetId: ASSET_ID, filename: 'issue-final.cbz', sourceRevision: 'h-bbbb2222' });
    expect(options).toEqual({ session });
    expect(t.viewer.reconcileComic.mock.results[0].value.outcome).toBe(VIEWER_COMIC_HINT_RELOADING);
    expect(t.viewer.manifests).toHaveLength(2);
    expect(t.viewer.getState()).toMatchObject({ open: true, session, comic: { sourceRevision: 'h-bbbb2222' } });
    expect(comicTrigger(t).getAttribute('aria-label')).toBe('Read comic issue-final.cbz');

    // The same new hint again: nothing more.
    t.queue.push(t.serverPage('renamed-again', comicPage({ filename: 'issue-final.cbz', revision: 'h-bbbb2222' })));
    await t.refresh();
    expect(t.viewer.manifests).toHaveLength(2);
    expect(t.viewer.update).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported', { kind: 'unsupported' }],
    ['missing', { kind: 'missing' }],
    ['an image', { filename: 'issue.png' }],
    ['a video', { kind: 'video' }],
  ])('a render showing the comic as %s retires the session and withdraws Read Comic', async (label, options) => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.queue.push(t.serverPage(`now-${label}`, options));
    expect((await t.refresh()).mediaReplaced).toBe(true);
    const [hint] = t.viewer.reconcileComic.mock.calls[0];
    expect(hint).toEqual({ projectId: PROJECT_ID, assetId: ASSET_ID, eligible: false });
    expect(t.viewer.getState().open).toBe(false);
    expect(comicTrigger(t)).toBeNull();
    expect(openAssetDetailsComic(t.document)).toBe(0);
    expect(t.viewer.manifests).toHaveLength(1);
    // The closed session ignores later refreshes, even a comic again.
    t.queue.push(t.serverPage(`back-${label}`, comicPage({ revision: 'h-later' })));
    await t.refresh();
    expect(t.viewer.reconcileComic).toHaveBeenCalledTimes(1);
    expect(t.viewer.getState().open).toBe(false);
  });

  it('a failed, foreign, superseded or aborted read never reaches the comic', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.queue.push(htmlResponse('', 500));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    t.queue.push(t.serverPage('foreign', comicPage({ assetId: 99, revision: 'h-foreign' })));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.FAILED);
    let releaseOld;
    t.queue.push(() => new Promise((resolve) => { releaseOld = () => resolve(t.serverPage('old', comicPage({ revision: 'h-old' }))); }));
    const older = t.refresh();
    await flush();
    t.queue.push(t.serverPage('new', comicPage({ revision: 'h-new' })));
    await t.refresh();
    releaseOld();
    expect((await older).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(t.viewer.reconcileComic).toHaveBeenCalledTimes(1);
    expect(t.viewer.getState().comic.sourceRevision).toBe('h-new');
    expect(comicTrigger(t).getAttribute('data-comic-source-revision')).toBe('h-new');
    expect(t.viewer.manifests).toHaveLength(2);
    // A read sent before a mutation began is ignored as well.
    let releaseStale;
    t.queue.push(() => new Promise((resolve) => { releaseStale = () => resolve(t.serverPage('stale', comicPage({ revision: 'h-stale' }))); }));
    const stale = t.refresh();
    await flush();
    supersedeAssetViewerRefresh(t.document);
    releaseStale();
    expect((await stale).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(t.viewer.getState().comic.sourceRevision).toBe('h-new');
    expect(t.viewer.manifests).toHaveLength(2);
  });

  it('closing the reader before a refresh lands keeps it closed and requests nothing', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    let release;
    t.queue.push(() => new Promise((resolve) => { release = () => resolve(t.serverPage('later', comicPage({ revision: 'h-later' }))); }));
    const pending = t.refresh();
    await flush();
    t.viewer.close();
    release();
    expect((await pending).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(t.viewer.reconcileComic).not.toHaveBeenCalled();
    expect(t.viewer.getState().open).toBe(false);
    expect(t.viewer.manifests).toHaveLength(1);
  });

  it('another host’s (replacing) session is never reconciled by this page', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.viewer.openComic({ projectId: 3, assetId: 5, sourceRevision: 'x' });
    t.queue.push(t.serverPage('changed', comicPage({ revision: 'h-changed' })));
    await t.refresh();
    expect(t.viewer.reconcileComic).not.toHaveBeenCalled();
    expect(reconcileAssetDetailsViewer(t.document, { gone: true })).toBeNull();
    expect(t.viewer.getState()).toMatchObject({ open: true, comic: { projectId: '3', assetId: '5', sourceRevision: 'x' } });
  });

  it('image → comic: an open image closes when its page becomes a comic, and the comic opens fresh', async () => {
    const t = setup();
    openViaClick(t);
    t.queue.push(t.serverPage('became-comic', comicPage()));
    expect((await t.refresh()).mediaReplaced).toBe(true);
    expect(t.viewer.update.mock.results[0].value.outcome).toBe(VIEWER_RECONCILE_CLOSED);
    expect(t.viewer.getState().open).toBe(false);
    expect(t.viewer.manifests).toHaveLength(0);
    openComicViaClick(t);
    expect(t.viewer.getState().comic).toMatchObject({ sourceRevision: COMIC_HINT });
    // An image descriptor coming back only closes the comic (eligible: false).
    t.queue.push(t.serverPage('image-again', { revision: 'r9' }));
    await t.refresh();
    expect(t.viewer.update).toHaveBeenCalledTimes(1);
    expect(t.viewer.reconcileComic.mock.calls[0][0]).toMatchObject({ eligible: false });
    expect(t.viewer.getState().open).toBe(false);
  });

  it('comic → image: a newer image session is never touched by the comic reconciliation', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.queue.push(t.serverPage('became-image', { filename: 'issue.png', revision: 'r2' }));
    await t.refresh();
    expect(t.viewer.getState().open).toBe(false);
    openViaClick(t);
    expect(t.viewer.getState().item.revision).toBe('r2');
    t.queue.push(t.serverPage('image-r3', { filename: 'issue.png', revision: 'r3' }));
    await t.refresh();
    expect(t.viewer.reconcileComic).toHaveBeenCalledTimes(1);
    expect(t.viewer.getState().item.revision).toBe('r3');
  });
});

describe('Asset Details comics — persistent gone', () => {
  function expectComicInert(t) {
    expect(comicTrigger(t)).toBeNull();
    expect(t.host.querySelector('a.asset-comic-link')).toBeNull();
    const marker = comicGone(t);
    expect(marker.tagName).toBe('SPAN');
    expect(marker.hasAttribute('href')).toBe(false);
    expect(marker.querySelector('[data-preview-image]').hasAttribute('src')).toBe(false);
    expect(marker.querySelector('[data-preview-image]').hidden).toBe(true);
    expect(t.host.querySelectorAll('[data-asset-details-comic-trigger]')).toHaveLength(0);
    expect(t.host.querySelector('[data-asset-comic-preview]').getAttribute('class')).toContain('asset-preview-frame--gone');
    expect(t.host.querySelector('a.asset-preview-nav--previous')).not.toBeNull();
  }

  it('a current 404 closes the open comic; the old link, the inert marker and direct calls never reopen it', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    const opener = comicTrigger(t);
    const { fallbackFocus } = t.viewer.openComic.mock.calls[0][1];
    t.queue.push(htmlResponse('', 404));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.MISSING);
    expect(t.viewer.reconcileComic.mock.calls[0][0]).toEqual({ projectId: PROJECT_ID, assetId: ASSET_ID, eligible: false });
    expect(t.viewer.getState().open).toBe(false);
    expectComicInert(t);
    expect(opener.isConnected).toBe(false);
    expect(fallbackFocus()).toBe(t.body.querySelector('#asset-preview-heading'));

    expect(comicGone(t).dispatch('click').defaultPrevented).toBe(false);
    opener.dispatch('click');
    expect(openAssetDetailsComic(t.document)).toBe(0);
    expect(openAssetDetailsComic(t.document, opener)).toBe(0);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
    expect(t.viewer.manifests).toHaveLength(1);
    expect(t.requests).toHaveLength(1);
  });

  it('a 404 while the reader is already closed invalidates the link without reopening anything', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.viewer.close();
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expect(t.viewer.reconcileComic).not.toHaveBeenCalled();
    expectComicInert(t);
    expect(openAssetDetailsComic(t.document)).toBe(0);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
  });

  it('a focused Read Comic link hands focus to the Preview heading', async () => {
    const t = setup(comicPage());
    enhanceAssetDetailsViewer(t.document);
    comicTrigger(t).focus();
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expect(t.document.activeElement).toBe(t.body.querySelector('#asset-preview-heading'));
  });

  it('a repeated gone (404 again, then retirement) is idempotent', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    const marker = comicGone(t);
    const frameClass = t.host.querySelector('[data-asset-comic-preview]').getAttribute('class');
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    retireAssetViewer(t.document);
    enhanceAssetDetailsViewer(t.document);
    expect(comicGone(t)).toBe(marker);
    expect(t.host.querySelectorAll('[data-asset-details-viewer-gone]')).toHaveLength(2);
    expect(t.host.querySelector('[data-asset-comic-preview]').getAttribute('class')).toBe(frameClass);
    expect(t.viewer.reconcileComic).toHaveBeenCalledTimes(1);
    expect(t.document[OBSERVERS_KEY].size).toBe(1);
    expect(t.document.listeners.get('click')).toHaveLength(1);
    expect(t.viewer.manifests).toHaveLength(1);
  });

  it('a network error or 5xx is never gone', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    t.queue.push(() => Promise.reject(new TypeError('Failed to fetch')));
    await t.refresh();
    t.queue.push(htmlResponse('', 503));
    await t.refresh();
    expect(comicGone(t)).toBeNull();
    expect(t.viewer.getState().open).toBe(true);
    expect(t.viewer.reconcileComic).not.toHaveBeenCalled();
  });

  it('a superseded 404 never retires a newer session', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    let releaseOld;
    t.queue.push(() => new Promise((resolve) => { releaseOld = () => resolve(htmlResponse('', 404)); }));
    const older = t.refresh();
    await flush();
    t.queue.push(t.serverPage('newer', comicPage({ revision: 'h-newer' })));
    await t.refresh();
    releaseOld();
    expect((await older).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(comicGone(t)).toBeNull();
    expect(t.viewer.getState()).toMatchObject({ open: true, comic: { sourceRevision: 'h-newer' } });
  });

  it('an older success can never restore activation after a newer gone', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    let releaseOld;
    t.queue.push(() => new Promise((resolve) => { releaseOld = () => resolve(t.serverPage('older-ok', comicPage({ revision: 'h-old-ok' }))); }));
    const older = t.refresh();
    await flush();
    t.queue.push(htmlResponse('', 404));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.MISSING);
    releaseOld();
    expect((await older).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expectComicInert(t);
    expect(openAssetDetailsComic(t.document)).toBe(0);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
  });

  it('a later tags-only install keeps the comic gone', async () => {
    const t = setup(comicPage());
    enhanceAssetDetailsViewer(t.document);
    t.queue.push(htmlResponse('', 404));
    await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.TAGS]);
    t.queue.push(t.serverPage('tags-later', comicPage()));
    expect((await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.TAGS])).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expectComicInert(t);
    expect(openAssetDetailsComic(t.document)).toBe(0);
  });

  it('only a newer current file install restores a valid link with its current hint; the closed session stays closed', async () => {
    const t = setup(comicPage());
    openComicViaClick(t);
    const oldOpener = comicTrigger(t);
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expect(t.viewer.getState().open).toBe(false);

    t.queue.push(t.serverPage('restored', comicPage({ revision: 'h-restored' })));
    const result = await t.refresh();
    expect(result).toMatchObject({ status: ASSET_VIEWER_REFRESH_STATUS.INSTALLED, mediaReplaced: true });
    expect(comicGone(t)).toBeNull();
    expect(t.host.querySelector('[data-asset-comic-preview]').getAttribute('class')).not.toContain('asset-preview-frame--gone');
    expect(comicTrigger(t).getAttribute('data-comic-source-revision')).toBe('h-restored');
    // Restoration never revives the closed session or requests a manifest.
    expect(t.viewer.getState().open).toBe(false);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
    expect(t.viewer.manifests).toHaveLength(1);
    // The detached old link still opens nothing; the restored one does.
    expect(openAssetDetailsComic(t.document, oldOpener)).toBe(0);
    oldOpener.dispatch('click');
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
    openComicViaClick(t);
    expect(t.viewer.openComic).toHaveBeenCalledTimes(2);
    expect(t.viewer.openComic.mock.calls[1][0].sourceRevision).toBe('h-restored');
  });

  it('an only-enhanced comic page is invalidated too, and image gone handling is unchanged', async () => {
    const t = setup(comicPage());
    enhanceAssetDetailsViewer(t.document);
    t.queue.push(htmlResponse('', 404));
    await t.refresh();
    expectComicInert(t);
    expect(t.viewer.openComic).not.toHaveBeenCalled();

    const image = setup();
    openViaClick(image);
    image.queue.push(htmlResponse('', 404));
    await image.refresh();
    expect(image.viewer.update.mock.calls[0][0].items).toEqual([]);
    expect(image.viewer.reconcileComic).not.toHaveBeenCalled();
    expect(image.host.querySelector('[data-asset-details-viewer-gone]').getAttribute('class')).toBe('asset-preview-link');
  });
});


describe('Asset Details authoritative comic metadata', () => {
  it('uses filename attributes instead of display titles on open and accepted reconciliation', () => {
    const t = setup(comicPage());
    const link = comicTrigger(t);
    link.setAttribute('data-comic-title', 'Formatted display title');
    link.setAttribute('data-comic-filename', '巻 01 & final!.cbz');
    link.setAttribute('data-comic-project-name', 'Project name');
    openComicViaClick(t);
    expect(t.viewer.openComic.mock.calls[0][0]).toMatchObject({ filename: '巻 01 & final!.cbz', projectName: 'Project name' });
    link.setAttribute('data-comic-filename', '巻 02 final.cbz');
    link.setAttribute('data-comic-project-name', '');
    reconcileAssetDetailsViewer(t.document);
    expect(t.viewer.reconcileComic.mock.lastCall[0]).toMatchObject({ filename: '巻 02 final.cbz', projectName: '' });
    expect(t.viewer.manifests).toHaveLength(1);
  });
});


describe('Asset Details authoritative image metadata', () => {
  it('copies changed and cleared project names through accepted file refreshes', async () => {
    const t = setup({ projectName: 'Original project' });
    enhanceAssetDetailsViewer(t.document);
    openAssetDetailsImage(t.document);
    const trigger = t.host.querySelector('[data-asset-details-viewer-trigger]');
    expect(t.viewer.getState().item.projectName).toBe('Original project');
    for (const projectName of ['Renamed project', '']) {
      t.queue.push(t.serverPage('project-' + projectName, { projectName }));
      expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
      expect(t.host.querySelector('[data-asset-details-viewer-trigger]')).toBe(trigger);
      expect(t.viewer.getState().item.projectName).toBe(projectName || null);
      expect(t.viewer.getState().item.revision).toBe('r1');
    }
    expect(t.viewer.open).toHaveBeenCalledTimes(1);
  });
});


describe('Asset Details authoritative image-quality refresh', () => {
  function sources(generation) {
    return buildAssetPreviewModel({ id: ASSET_ID, project_id: PROJECT_ID, filename: 'hero.png',
      relative_path: 'hero.png', is_present: 1, extension: 'png', mime_type: 'image/png',
      size_bytes: 100, modified_at: '2026-08-01 10:00:00', source_generation: generation },
    projectImagePresentationPolicy({ thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'webp', webpQuality: 90, maxDimension: 1600 } })).imageSources;
  }
  it('installs quality-only revisions without replacing media, keeps partial regions, rejects stale reads and clears withdrawal', async () => {
    const t = setup({ imageSources: sources(0) });
    openViaClick(t);
    const opened = t.viewer.getState();
    const image = t.trigger().querySelector('img');
    t.queue.push(t.serverPage('quality-only', { imageSources: sources(1) }));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    expect(t.viewer.getState().item.imageSources.sourceRevision).toBe(sources(1).sourceRevision);
    expect(t.viewer.update.mock.results.at(-1).value).toMatchObject({ reload: false, preserveView: true });
    expect(t.trigger().querySelector('img')).toBe(image);
    expect(t.viewer.getState().session).toBe(opened.session);
    t.queue.push(t.serverPage('partial', { imageSources: sources(0) }));
    await t.refresh([ASSET_VIEWER_REFRESH_REGIONS.TAGS]);
    expect(t.viewer.getState().item.imageSources.sourceRevision).toBe(sources(1).sourceRevision);
    let release;
    t.queue.push(() => new Promise((resolve) => { release = () => resolve(t.serverPage('old-quality', { imageSources: sources(0) })); }));
    const stale = t.refresh();
    await flush();
    t.queue.push(t.serverPage('new-quality', { imageSources: sources(2) }));
    expect((await t.refresh()).status).toBe(ASSET_VIEWER_REFRESH_STATUS.INSTALLED);
    release();
    expect((await stale).status).toBe(ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED);
    expect(t.viewer.getState().item.imageSources.sourceRevision).toBe(sources(2).sourceRevision);
    const withdrawn = sources(2);
    withdrawn.original = { eligible: false, url: null };
    withdrawn.toggleEligible = false;
    t.queue.push(t.serverPage('withdrawn-quality', { imageSources: withdrawn }));
    await t.refresh();
    expect(t.viewer.getState().item.imageSources.original).toEqual({ eligible: false, url: null });
    t.queue.push(t.serverPage('no-quality', {}));
    await t.refresh();
    expect(t.trigger().getAttribute('data-viewer-image-sources')).toBeNull();
    expect(t.viewer.getState().item.imageSources).toBeNull();
  });
});


describe('Asset Details native comic cover refresh', () => {
  it('retains the image and focus without setting an unchanged native source', async () => {
    const t = setup(comicPage());
    enhanceAssetDetailsViewer(t.document);
    const image = t.host.querySelector('[data-preview-image]');
    const setter = vi.spyOn(image, 'setAttribute');
    const link = comicTrigger(t); link.focus();
    t.queue.push(t.serverPage('native-same', comicPage()));
    expect((await t.refresh()).mediaReplaced).toBe(false);
    expect(t.host.querySelector('[data-preview-image]')).toBe(image);
    expect(setter.mock.calls.filter(([name]) => name === 'src')).toHaveLength(0);
    expect(t.document.activeElement).toBe(link);
  });

  it('updates the native URL on canonical format changes while retaining the indexed Reader hint', async () => {
    const t = setup(comicPage());
    const image = t.host.querySelector('[data-preview-image]');
    const setter = vi.spyOn(image, 'setAttribute');
    t.queue.push(t.serverPage('format-only', comicPage({ format: 'CBR' })));
    const result = await t.refresh();
    expect(result.mediaReplaced).toBe(false);
    expect(result.mediaChanges).toContain('preview');
    expect(t.host.querySelector('[data-preview-image]')).toBe(image);
    expect(setter).toHaveBeenCalledWith('src', `${base}/preview?v=${COMIC_HINT}-cbr`);
    expect(comicTrigger(t).getAttribute('data-comic-source-revision')).toBe(COMIC_HINT);
    expect(t.host.querySelector('figure').getAttribute('data-comic-format')).toBe('cbr');
    image.dispatch('error');
    expect(t.host.querySelector('figure').getAttribute('data-preview-state')).toBe('failed');
  });

  it('keeps the failed Reader fallback usable and synchronizes both anchors on supported recovery', async () => {
    const t = setup(comicPage({ state: 'failed' }));
    enhanceAssetDetailsViewer(t.document);
    const image = t.host.querySelector('[data-preview-image]');
    const fallback = t.host.querySelector('[data-preview-fallback]');
    fallback.focus(); fallback.dispatch('click', { detail: 0 });
    expect(t.viewer.openComic).toHaveBeenCalledTimes(1);
    expect(t.viewer.openComic.mock.calls[0][1].fallbackFocus()).toBe(fallback);
    t.queue.push(t.serverPage('failed-same', comicPage()));
    await t.refresh();
    expect(fallback.hidden).toBe(false);
    t.queue.push(t.serverPage('recover', comicPage({ filename: 'new.cbz', revision: 'new-source' })));
    expect((await t.refresh()).mediaChanges).toContain('preview');
    expect(t.host.querySelector('[data-preview-image]')).toBe(image);
    expect(image.hidden).toBe(false);
    expect(fallback.hidden).toBe(true);
    for (const anchor of t.host.querySelectorAll('[data-asset-details-comic-trigger]')) {
      expect(anchor.getAttribute('data-comic-filename')).toBe('new.cbz');
      expect(anchor.getAttribute('data-comic-source-revision')).toBe('new-source');
      expect(anchor.getAttribute('aria-label')).toBe('Read comic new.cbz');
    }
    image.dispatch('load');
    expect(t.host.querySelector('figure').getAttribute('data-preview-state')).toBe('loaded');
  });
});
