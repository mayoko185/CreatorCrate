import { describe, expect, it, vi } from 'vitest';
import {
  enhanceReleaseDetailViewer,
  openReleaseDetailComic,
  openReleaseDetailImage,
  reconcileReleaseDetailViewer,
  retireReleaseDetailViewer,
} from '../src/static/client/release-detail-viewer.js';
import { enhanceReleaseAssetsViewer } from '../src/static/client/release-assets-viewer.js';
import {
  observeReleaseDetailRefresh,
  refreshReleaseDetail,
  retireReleaseDetailRefresh,
} from '../src/static/client/release-detail-refresh.js';
import {
  canPlayViewerSlideshow,
  createViewerSource,
  reconcileViewerSource,
  selectInitialViewerItem,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
  VIEWER_RECONCILE_KEPT,
  VIEWER_SOURCE_MODE_SINGLE,
} from '../src/static/client/viewer-sequence.js';

// B7b: Release Detail host integration for the unified viewer. The page is a
// small DOM shim shaped like releases/detail.njk (release regions, read-only
// selected assets with Role/Order, release actions); the viewer is a
// controller double whose open/update follow unified-viewer.js, using the
// real B1 source and reconciliation functions. The real controller, media,
// refresh, fullscreen and focus restoration run in Chromium
// (tests/browser/release-detail-unified-viewer.spec.js).


// ─── DOM shim (compound, descendant and comma selectors) ─────────────────────

function matchesCompound(node, selector) {
  let rest = selector.trim();
  const tag = rest.match(/^[a-z][\w-]*/i)?.[0];
  if (tag) {
    if (node.tagName !== tag.toUpperCase()) return false;
    rest = rest.slice(tag.length);
  }
  while (rest) {
    let match;
    if ((match = rest.match(/^\.([\w-]+)/))) {
      if (!String(node.getAttribute('class') || '').split(/\s+/).includes(match[1])) return false;
    } else if ((match = rest.match(/^\[([^\]=]+)(?:="([^"]*)")?\]/))) {
      const actual = node.getAttribute(match[1]);
      if (actual === null || (match[2] !== undefined && actual !== match[2])) return false;
    } else {
      throw new Error(`Unsupported selector: ${selector}`);
    }
    rest = rest.slice(match[0].length);
  }
  return true;
}

function matchesComplex(node, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesCompound(node, parts.pop())) return false;
  let current = node.parentNode;
  while (parts.length) {
    const wanted = parts[parts.length - 1];
    while (current && current.nodeType === 1 && !matchesCompound(current, wanted)) current = current.parentNode;
    if (!current || current.nodeType !== 1) return false;
    parts.pop();
    current = current.parentNode;
  }
  return true;
}

function makeNode(tagName = 'div', attrs = {}) {
  const attributes = new Map();
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    parentNode: null,
    ownerDocument: null,
    children: [],
    get childNodes() { return this.children; },
    listeners: [],
    dataset: {},
    checked: false,
    value: '',
    get hidden() { return attributes.has('hidden'); },
    set hidden(value) { if (value) attributes.set('hidden', ''); else attributes.delete('hidden'); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    cloneNode(deep = false) {
      const copy = makeNode(tagName, Object.fromEntries(attributes));
      if (deep) this.children.forEach((child) => copy.appendChild(child.cloneNode(true)));
      return copy;
    },
    matches(selector) { return selector.split(',').some((part) => matchesComplex(this, part)); },
    closest(selector) {
      let current = this;
      while (current && current.nodeType === 1) {
        if (current.matches(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    appendChild(child) {
      if (child.parentNode) child.remove();
      this.children.push(child);
      child.parentNode = this;
      const document = this.nodeType === 9 ? this : this.ownerDocument;
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(child);
      return child;
    },
    replaceWith(next) {
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1, next);
      next.parentNode = this.parentNode;
      const document = this.ownerDocument;
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(next);
      this.parentNode = null;
    },
    remove() {
      const siblings = this.parentNode?.children;
      if (siblings) siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    },
    get isConnected() {
      let current = this;
      while (current) {
        if (current.nodeType === 9) return true;
        current = current.parentNode;
      }
      return false;
    },
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: this,
        button: 0,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      let current = this;
      while (current) {
        current.listeners.filter((listener) => listener.type === type).forEach((listener) => listener.handler(event));
        current = current.parentNode;
      }
      return event;
    },
    querySelectorAll(selector) {
      const result = [];
      const visit = (current) => current.children.forEach((child) => {
        if (child.matches(selector)) result.push(child);
        visit(child);
      });
      visit(this);
      return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getElementById(id) { return this.querySelector(`[id="${id}"]`); },
  };
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

// ─── Controller double (mirrors unified-viewer.js open/update/getState) ─────

// Comic sources' host hint (mirrors unified-viewer.js normalizeSourceHint).
function comicHint(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function makeViewer() {
  let counter = 0;
  let active = null;
  const viewer = {
    // C2c comic sessions (mirror unified-viewer.js openComic/reconcileComic):
    // every manifest request the real controller would start is recorded.
    manifestRequests: [],
    openComic: vi.fn((descriptor, options = {}) => {
      counter += 1;
      active = {
        session: counter,
        source: null,
        key: null,
        options,
        comic: {
          projectId: descriptor.projectId,
          assetId: descriptor.assetId,
          title: descriptor.title,
          sourceHint: comicHint(descriptor.sourceRevision),
        },
      };
      viewer.manifestRequests.push({ session: counter, projectId: descriptor.projectId, assetId: descriptor.assetId });
      return counter;
    }),
    reconcileComic: vi.fn((hint, options = {}) => {
      if (!active?.comic || options.session !== active.session) return null;
      if (hint === null) {
        active = null;
        return { outcome: 'closed' };
      }
      if (!hint || typeof hint !== 'object') return null;
      if (`${hint.projectId}:${hint.assetId}` !== `${active.comic.projectId}:${active.comic.assetId}`) return null;
      if (hint.eligible === false) {
        active = null;
        return { outcome: 'closed' };
      }
      const next = comicHint(hint.sourceRevision);
      if (next === null || next === active.comic.sourceHint) return { outcome: 'unchanged' };
      active.comic.sourceHint = next;
      viewer.manifestRequests.push({ session: active.session, projectId: active.comic.projectId, assetId: active.comic.assetId });
      return { outcome: 'reloading' };
    }),
    open: vi.fn((source, options = {}) => {
      const normalized = createViewerSource(source);
      const initial = selectInitialViewerItem(normalized);
      if (initial.index === -1) return 0;
      counter += 1;
      active = { session: counter, source: normalized, key: initial.key, options };
      return counter;
    }),
    update: vi.fn((replacement, options = {}) => {
      // A comic's pages come only from its manifest: item lists are ignored.
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
        key: active ? active.key : null,
        source: active ? active.source : null,
        comic: active?.comic ? { ...active.comic } : null,
      };
    },
    active: () => active,
  };
  return viewer;
}

// ─── Page fixture (releases/detail.njk shape) ────────────────────────────────

function image(id, extra = {}) {
  return {
    id,
    kind: 'image',
    projectId: 7,
    filename: `asset-${id}.png`,
    previewUrl: `/projects/7/assets/${id}/preview?v=r${id}`,
    originalUrl: `/projects/7/assets/${id}/original`,
    detailsUrl: `/projects/7/assets/${id}`,
    revision: `r${id}`,
    role: 'attachment',
    order: id,
    ...extra,
  };
}

function triggerAttributes(asset) {
  return {
    'data-release-detail-viewer-trigger': '',
    'data-viewer-project': String(asset.projectId),
    'data-viewer-asset': String(asset.id),
    'data-viewer-filename': asset.filename,
    'data-viewer-preview-url': asset.previewUrl,
    ...(asset.originalUrl ? { 'data-viewer-original-url': asset.originalUrl } : {}),
    ...(asset.revision ? { 'data-viewer-revision': asset.revision } : {}),
    'data-viewer-details-url': asset.detailsUrl,
  };
}

// C2c: an eligible saved comic's Read comic link (comicReaderLink's attributes).
function comic(id, extra = {}) {
  return {
    id,
    kind: 'readable-comic',
    projectId: 7,
    filename: `book-${id}.cbz`,
    detailsUrl: `/projects/7/assets/${id}`,
    sourceRevision: `s${id}`,
    role: 'attachment',
    order: id,
    ...extra,
  };
}

function comicAttributes(asset, view) {
  return {
    class: `${view === 'grid' ? 'asset-card-media-link' : 'asset-list-card-media-link'} asset-comic-link`,
    href: asset.detailsUrl,
    'aria-label': `Read comic ${asset.filename}`,
    'data-release-detail-comic-trigger': '',
    'data-comic-project': String(asset.projectId),
    'data-comic-asset': String(asset.id),
    'data-comic-title': asset.filename.replace(/\.\w+$/, ''),
    ...(asset.sourceRevision ? { 'data-comic-source-revision': asset.sourceRevision } : {}),
    ...(asset.attributes || {}),
  };
}

// One read-only selected card: Role and Order details, the Details link, the
// filename link and the media frame (image trigger, video link or placeholder).
function buildCard(asset, view) {
  const article = makeNode('article', {
    class: view === 'grid' ? 'asset-card' : 'asset-list-card asset-list-card--release',
    'data-asset-id': String(asset.id),
    ...(view === 'grid' ? { role: 'option', 'aria-selected': 'false' } : {}),
  });
  const role = makeNode('span', { class: 'release-asset-card-detail', 'data-role': asset.role });
  const order = makeNode('span', { class: 'release-asset-card-detail', 'data-order': String(asset.order) });
  article.appendChild(role);
  article.appendChild(order);
  const details = makeNode('a', { class: 'asset-details-link', href: asset.detailsUrl });
  article.appendChild(details);
  const title = makeNode('a', { class: 'asset-card-title-text asset-file-link', href: asset.detailsUrl });
  article.appendChild(title);
  const media = makeNode('div', { class: view === 'grid' ? 'asset-card-media' : 'asset-list-card-media' });
  let link = null;
  if (asset.kind === 'image') {
    media.setAttribute('data-preview-enhancement', '');
    media.setAttribute('data-preview-state', asset.failed ? 'failed' : 'loaded');
    link = makeNode('a', {
      class: view === 'grid' ? 'asset-card-media-link' : 'asset-list-card-media-link',
      href: asset.detailsUrl,
      ...triggerAttributes(asset),
    });
    link.appendChild(makeNode('img', { 'data-preview-image': '', src: asset.previewUrl }));
    media.appendChild(link);
  } else if (asset.kind === 'video') {
    link = makeNode('a', { class: 'asset-video-link', href: asset.detailsUrl, 'data-asset-video-preview-trigger': '' });
    media.appendChild(link);
  } else if (asset.kind === 'readable-comic') {
    link = makeNode('a', comicAttributes(asset, view));
    media.setAttribute('data-preview-enhancement', '');
    media.setAttribute('data-preview-state', 'loaded');
    link.appendChild(makeNode('img', { 'data-preview-image': '', src: asset.previewUrl || `/projects/7/assets/${asset.id}/preview?v=${asset.sourceRevision}`, alt: asset.filename }));
    media.appendChild(link);
    media.appendChild(makeNode('a', { ...comicAttributes(asset, view), 'data-preview-fallback': '', hidden: '' }));
  } else if (asset.kind === 'comic') {
    // A comic with a cover thumbnail: the plain Asset Details link, no trigger.
    media.setAttribute('data-preview-enhancement', '');
    link = makeNode('a', { class: 'asset-card-media-link', href: asset.detailsUrl });
    media.appendChild(link);
  } else {
    media.appendChild(makeNode('span', { class: 'asset-card-placeholder asset-card-placeholder-missing' }));
  }
  article.appendChild(media);
  return { article, role, order, details, title, media, link };
}

// The release regions, the release actions and the selected assets.
function buildPage(document, { releaseId = '5', assets, view = 'grid' }) {
  const main = makeNode('main', { id: 'main-content' });
  document.appendChild(main);
  const heading = makeNode('div', { 'data-release-detail-region': 'heading', 'data-release-detail': releaseId });
  const publish = makeNode('a', { href: `/releases/${releaseId}/publish`, 'data-dialog-open': 'release-publish-dialog' });
  heading.appendChild(publish);
  main.appendChild(heading);
  const editing = makeNode('div', { 'data-release-detail-editing': '' });
  const edit = makeNode('a', { href: `/releases/${releaseId}?edit=1`, 'data-release-edit-id': releaseId });
  const manage = makeNode('a', { href: `/releases/${releaseId}/assets` });
  editing.appendChild(manage);
  editing.appendChild(edit);
  main.appendChild(editing);
  const selected = makeNode('section', { class: 'asset-browser-layout', 'data-selected-assets': '' });
  const nav = makeNode('nav', { class: 'view-switcher' });
  nav.appendChild(makeNode('a', { class: 'view-switcher-option', href: '?view=grid', ...(view === 'grid' ? { 'aria-current': 'page' } : {}) }));
  nav.appendChild(makeNode('a', { class: 'view-switcher-option', href: '?view=list', ...(view === 'list' ? { 'aria-current': 'page' } : {}) }));
  selected.appendChild(nav);
  const cards = new Map();
  assets.forEach((asset) => {
    const parts = buildCard(asset, view);
    selected.appendChild(parts.article);
    cards.set(asset.id, parts);
  });
  main.appendChild(selected);
  return { main, publish, edit, manage, selected, nav, cards };
}

// An accepted refresh's render (a parsed document of the same shape).
function render(options) {
  const parsed = makeNode('document');
  parsed.nodeType = 9;
  buildPage(parsed, options);
  return parsed;
}

const defaultAssets = () => [
  image(1, { role: 'cover', order: 0 }),
  image(2, { order: 1 }),
  image(3, { originalUrl: null, order: 2 }),
];

function makePage({ assets = defaultAssets(), view = 'grid', releaseId = '5', withViewer = true } = {}) {
  const document = makeNode('document');
  document.nodeType = 9;
  const fetch = vi.fn();
  document.defaultView = {
    location: { href: `http://localhost/releases/${releaseId}` }, fetch, AbortController,
    DOMParser: class {
      parseFromString() { return render({ releaseId, assets }); }
    },
  };
  document.importNode = (node) => node.cloneNode(true);
  const built = buildPage(document, { releaseId, assets, view });
  const viewer = makeViewer();
  const dialog = makeNode('dialog', { id: 'unified-viewer-dialog' });
  if (withViewer) dialog.__creatorCrateUnifiedViewer = viewer;
  document.appendChild(dialog);
  return { document, viewer, fetch, ...built };
}

const descriptorOf = (link) => Object.fromEntries(
  ['data-release-detail-viewer-trigger', 'data-viewer-project', 'data-viewer-asset', 'data-viewer-filename',
    'data-viewer-preview-url', 'data-viewer-original-url', 'data-viewer-revision', 'data-viewer-details-url']
    .map((name) => [name, link.getAttribute(name)]),
);

describe('Release Detail unified viewer host', () => {
  it.each(['grid', 'list'])('opens only the clicked %s image as a single, non-playing source', async (view) => {
    const page = makePage({ view });
    const { unifiedViewerFor } = await import('../src/static/client/unified-viewer.js');
    expect(unifiedViewerFor(page.document)).toBe(page.viewer);
    expect(enhanceReleaseDetailViewer(page.document)).toBe(1);

    const { link } = page.cards.get(2);
    const event = link.dispatch('click');
    expect(event.defaultPrevented).toBe(true);
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    const [source, options] = page.viewer.open.mock.calls[0];
    expect(source.mode).toBe(VIEWER_SOURCE_MODE_SINGLE);
    expect(source.key).toBe('release-detail:5');
    expect(source.wrap).toBe(false);
    expect(source.slideshow).toBe(false);
    expect(canPlayViewerSlideshow(source)).toBe(false);
    expect(source.items).toHaveLength(1);
    expect(source.items[0]).toMatchObject({
      key: 'p:7|a:2',
      projectId: '7',
      assetId: '2',
      title: 'asset-2.png',
      mediaUrl: '/projects/7/assets/2/preview?v=r2',
      originalUrl: '/projects/7/assets/2/original',
      detailsUrl: '/projects/7/assets/2',
      revision: 'r2',
      available: true,
    });
    expect(options.opener).toBe(link);
    expect(page.viewer.getState()).toMatchObject({ open: true, session: 1, key: 'p:7|a:2' });
  });

  it('keeps Original Size unavailable for a preview-only image', () => {
    const page = makePage();
    enhanceReleaseDetailViewer(page.document);
    page.cards.get(3).link.dispatch('click');
    const [source] = page.viewer.open.mock.calls[0];
    expect(source.items[0]).toMatchObject({ assetId: '3', originalUrl: null, available: true });
  });

  it('leaves modified, middle and already-handled clicks to the link', () => {
    const page = makePage();
    enhanceReleaseDetailViewer(page.document);
    const { link } = page.cards.get(2);
    for (const props of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(link.dispatch('click', props).defaultPrevented).toBe(false);
    }
    expect(link.dispatch('click', { defaultPrevented: true }).defaultPrevented).toBe(true);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('never opens from Details, filename, card, release actions, video, comic or placeholder targets', () => {
    const page = makePage({
      assets: [image(1), { ...image(4), kind: 'video' }, { ...image(5), kind: 'comic' }, { ...image(6), kind: 'missing' }],
    });
    enhanceReleaseDetailViewer(page.document);
    const card = page.cards.get(1);
    const targets = [
      card.details, card.title, card.article, card.media, card.role, card.order,
      page.publish, page.edit, page.manage, page.nav,
      page.cards.get(4).link, page.cards.get(4).article, page.cards.get(5).link, page.cards.get(6).media,
    ];
    targets.forEach((target) => {
      expect(target.dispatch('click').defaultPrevented).toBe(false);
    });
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('is presentation-only: no request, and Role, Order and release actions are untouched', () => {
    const page = makePage();
    enhanceReleaseDetailViewer(page.document);
    const snapshot = () => [...page.cards.values()].map((card) => [
      card.role.getAttribute('data-role'), card.order.getAttribute('data-order'), card.details.getAttribute('href'),
    ]);
    const before = snapshot();
    page.cards.get(1).link.dispatch('click');
    page.viewer.close();
    page.cards.get(2).link.dispatch('click');
    page.viewer.close();
    expect(snapshot()).toEqual(before);
    expect(page.selected.children.slice(1).map((article) => article.getAttribute('data-asset-id'))).toEqual(['1', '2', '3']);
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.publish.getAttribute('href')).toBe('/releases/5/publish');
    expect(page.edit.getAttribute('data-release-edit-id')).toBe('5');
    expect(page.document.defaultView.location.href).toBe('http://localhost/releases/5');
  });

  it('binds one click listener and one refresh observer however often it is enhanced', () => {
    const page = makePage();
    expect(enhanceReleaseDetailViewer(page.document)).toBe(1);
    expect(enhanceReleaseDetailViewer(page.document)).toBe(1);
    expect(enhanceReleaseDetailViewer(page.selected)).toBe(1);
    expect(page.document.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
    page.cards.get(1).link.dispatch('click');
    page.viewer.close();
    page.cards.get(2).link.dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(2);
    expect(page.document.__creatorCrateReleaseDetailRefresh.observers.size).toBe(1);
  });

  it('leaves other pages alone, and Release Manage Assets never intercepts Release Detail', () => {
    const page = makePage();
    // B7a binds only on its own live region; this page has none.
    expect(enhanceReleaseAssetsViewer(page.document)).toBe(0);
    expect(enhanceReleaseDetailViewer(page.document)).toBe(1);
    page.cards.get(2).link.dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    expect(page.viewer.open.mock.calls[0][0].key).toBe('release-detail:5');

    const other = makeNode('document');
    other.nodeType = 9;
    other.appendChild(makeNode('section', { 'data-release-assets-live-region': '' }));
    expect(enhanceReleaseDetailViewer(other)).toBe(0);
    expect(other.listeners).toHaveLength(0);
  });

  it('opens nothing without a viewer, a valid descriptor, or outside the selected assets', () => {
    const withoutViewer = makePage({ withViewer: false });
    enhanceReleaseDetailViewer(withoutViewer.document);
    expect(withoutViewer.cards.get(1).link.dispatch('click').defaultPrevented).toBe(false);

    const page = makePage();
    const { link } = page.cards.get(2);
    link.setAttribute('data-viewer-asset', 'x');
    expect(openReleaseDetailImage(page.document, link)).toBe(0);
    const stray = makeNode('a', triggerAttributes(image(9)));
    page.main.appendChild(stray);
    expect(openReleaseDetailImage(page.document, stray)).toBe(0);
    // An inert (retired) page offers nothing.
    page.selected.setAttribute('inert', '');
    expect(openReleaseDetailImage(page.document, page.cards.get(1).link)).toBe(0);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('falls back to the same asset, then the Grid/List switch, when the opener was replaced', () => {
    const page = makePage();
    enhanceReleaseDetailViewer(page.document);
    const opener = page.cards.get(2).link;
    opener.dispatch('click');
    const { fallbackFocus } = page.viewer.open.mock.calls[0][1];
    const replacement = buildCard(image(2), 'grid');
    page.cards.get(2).article.replaceWith(replacement.article);
    expect(opener.isConnected).toBe(false);
    expect(fallbackFocus()).toBe(replacement.link);
    replacement.media.setAttribute('data-preview-state', 'failed');
    expect(fallbackFocus()).toBe(page.nav.children[0]);
    replacement.article.remove();
    expect(fallbackFocus()).toBe(page.nav.children[0]);
    expect(fallbackFocus()).not.toBe(opener);
  });
});

describe('Release Detail viewer: authoritative refresh', () => {
  function openOn(page, id) {
    enhanceReleaseDetailViewer(page.document);
    page.cards.get(id).link.dispatch('click');
    return page.viewer.getState().session;
  }

  it('keeps unchanged media for a metadata-only refresh without updating the viewer', () => {
    const page = makePage();
    openOn(page, 2);
    const before = descriptorOf(page.cards.get(2).link);
    // The release title, link or publication changed; the selection did not.
    expect(reconcileReleaseDetailViewer(page.document, render({ assets: defaultAssets() }))).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState()).toMatchObject({ open: true, session: 1, key: 'p:7|a:2' });
    expect(descriptorOf(page.cards.get(2).link)).toEqual(before);
  });

  it('reloads changed media and updates the page trigger from the current render', () => {
    const page = makePage();
    openOn(page, 2);
    const next = defaultAssets().map((asset) => (asset.id === 2
      ? { ...asset, filename: 'renamed.png', previewUrl: '/projects/7/assets/2/preview?v=r2b', revision: 'r2b' }
      : asset));
    const result = reconcileReleaseDetailViewer(page.document, render({ assets: next }));
    expect(result).toMatchObject({ reload: true, revisionChanged: true, hostReason: 'updated' });
    expect(page.viewer.active().source.items[0]).toMatchObject({
      title: 'renamed.png', mediaUrl: '/projects/7/assets/2/preview?v=r2b', revision: 'r2b',
    });
    expect(page.viewer.getState()).toMatchObject({ open: true, session: 1 });
    // The page's own trigger now carries the current descriptor, so a later
    // opening never uses the superseded one.
    expect(descriptorOf(page.cards.get(2).link)).toMatchObject({
      'data-viewer-filename': 'renamed.png',
      'data-viewer-revision': 'r2b',
      'data-viewer-preview-url': '/projects/7/assets/2/preview?v=r2b',
    });
    // The same render again: nothing more to do.
    expect(reconcileReleaseDetailViewer(page.document, render({ assets: next }))).toBeNull();
  });

  it('a title-only change updates the open session without reloading media', () => {
    const page = makePage();
    openOn(page, 2);
    const next = defaultAssets().map((asset) => (asset.id === 2 ? { ...asset, filename: 'retitled.png' } : asset));
    const result = reconcileReleaseDetailViewer(page.document, render({ assets: next }));
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, reload: false });
    expect(page.viewer.active().source.items[0].title).toBe('retitled.png');
  });

  it('drops a withdrawn original and keeps the image viewable from its preview', () => {
    const page = makePage();
    openOn(page, 2);
    const next = defaultAssets().map((asset) => (asset.id === 2 ? { ...asset, originalUrl: null } : asset));
    reconcileReleaseDetailViewer(page.document, render({ assets: next }));
    expect(page.viewer.active().source.items[0]).toMatchObject({ originalUrl: null, available: true });
    expect(page.cards.get(2).link.getAttribute('data-viewer-original-url')).toBeNull();
  });

  it('closes when the asset left the saved selection, and withdraws its trigger', () => {
    const page = makePage();
    openOn(page, 2);
    const next = defaultAssets().filter((asset) => asset.id !== 2);
    const result = reconcileReleaseDetailViewer(page.document, render({ assets: next }));
    expect(result).toMatchObject({ hostReason: 'removed' });
    expect(page.viewer.getState().open).toBe(false);
    const { link } = page.cards.get(2);
    // Still the Asset Details link it always was, never a viewer trigger.
    expect(link.isConnected).toBe(true);
    expect(link.getAttribute('href')).toBe('/projects/7/assets/2');
    expect(link.hasAttribute('data-release-detail-viewer-trigger')).toBe(false);
    expect(link.getAttribute('data-viewer-preview-url')).toBeNull();
    expect(link.dispatch('click').defaultPrevented).toBe(false);
    expect(openReleaseDetailImage(page.document, link)).toBe(0);
    // The other selected images stay viewable.
    expect(page.cards.get(1).link.dispatch('click').defaultPrevented).toBe(true);
  });

  it.each(['grid', 'list'])('keeps the static %s image and Details actions when saved membership is withdrawn', (view) => {
    const page = makePage({ view });
    openOn(page, 2);
    const { article, media, link, details, title, role, order } = page.cards.get(2);
    const image = link.querySelector('[data-preview-image]');
    const source = image.getAttribute('src');
    const next = defaultAssets().filter((asset) => asset.id !== 2);
    reconcileReleaseDetailViewer(page.document, render({ assets: next, view }));

    expect(page.viewer.getState().open).toBe(false);
    expect(page.selected.contains(article)).toBe(true);
    expect(media.querySelector('[data-preview-image]')).toBe(image);
    expect(image.getAttribute('src')).toBe(source);
    expect(image.hidden).toBe(false);
    expect(link.hidden).toBe(false);
    expect(media.getAttribute('data-preview-state')).toBe('loaded');
    for (const action of [link, details, title]) {
      expect(action.getAttribute('href')).toBe('/projects/7/assets/2');
      expect(action.dispatch('click').defaultPrevented).toBe(false);
    }
    expect(link.hasAttribute('data-release-detail-viewer-trigger')).toBe(false);
    expect(link.getAttribute('data-viewer-preview-url')).toBeNull();
    expect(openReleaseDetailImage(page.document, link)).toBe(0);
    expect(role.getAttribute('data-role')).toBe('attachment');
    expect(order.getAttribute('data-order')).toBe('1');
  });

  it('closes when the underlying asset is missing (rendered without a trigger)', () => {
    const page = makePage();
    openOn(page, 2);
    const next = defaultAssets().map((asset) => (asset.id === 2 ? { ...asset, kind: 'missing' } : asset));
    const result = reconcileReleaseDetailViewer(page.document, render({ assets: next }));
    expect(result).toMatchObject({ hostReason: 'ineligible' });
    expect(page.viewer.getState().open).toBe(false);
    expect(page.cards.get(2).link.hasAttribute('data-release-detail-viewer-trigger')).toBe(false);
    expect(page.cards.get(2).link.dispatch('click').defaultPrevented).toBe(false);
  });

  it('withdraws a closed image whose asset went missing, without opening anything', () => {
    const page = makePage();
    enhanceReleaseDetailViewer(page.document);
    const next = defaultAssets().map((asset) => (asset.id === 3 ? { ...asset, kind: 'missing' } : asset));
    expect(reconcileReleaseDetailViewer(page.document, render({ assets: next }))).toBeNull();
    expect(page.viewer.open).not.toHaveBeenCalled();
    expect(page.cards.get(3).link.dispatch('click').defaultPrevented).toBe(false);
    expect(page.cards.get(1).link.dispatch('click').defaultPrevented).toBe(true);
  });

  it('ignores a render of another release or without the selected assets', () => {
    const page = makePage();
    openOn(page, 2);
    expect(reconcileReleaseDetailViewer(page.document, render({ releaseId: '6', assets: [] }))).toBeNull();
    const bare = makeNode('document');
    bare.nodeType = 9;
    bare.appendChild(makeNode('div', { 'data-release-detail': '5' }));
    expect(reconcileReleaseDetailViewer(page.document, bare)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState().open).toBe(true);
    expect(page.cards.get(2).link.hasAttribute('data-release-detail-viewer-trigger')).toBe(true);
  });

  it('never touches a session it did not open, a closed one or a newer one', () => {
    const page = makePage();
    enhanceReleaseDetailViewer(page.document);
    const foreign = { key: 'other', mode: 'single', items: [{ projectId: '7', assetId: '2', mediaUrl: '/x' }] };
    page.viewer.open(foreign);
    reconcileReleaseDetailViewer(page.document, render({ assets: [] }));
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState().open).toBe(true);
    page.viewer.close();

    // This page's session, closed and then replaced by a newer one elsewhere.
    page.cards.get(2).link.dispatch('click');
    page.viewer.close();
    page.viewer.open(foreign);
    reconcileReleaseDetailViewer(page.document, render({ assets: [] }));
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState().open).toBe(true);
    expect(page.viewer.active().source.key).toBe('other');
  });

  it('does not reopen a closed viewer when a later render changes its image', () => {
    const page = makePage();
    openOn(page, 2);
    page.viewer.close();
    const next = defaultAssets().map((asset) => (asset.id === 2 ? { ...asset, revision: 'r2c' } : asset));
    expect(reconcileReleaseDetailViewer(page.document, render({ assets: next }))).toBeNull();
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    expect(page.viewer.getState().open).toBe(false);
    // The next opening uses the current descriptor.
    page.cards.get(2).link.dispatch('click');
    expect(page.viewer.open.mock.calls[1][0].items[0].revision).toBe('r2c');
  });

  it('a retired page (release deleted) closes its session and withdraws every trigger for good', () => {
    const page = makePage();
    openOn(page, 2);
    // Through the real Release Detail refresh hook.
    expect(retireReleaseDetailRefresh(page.document)).toBe(true);
    expect(page.viewer.getState().open).toBe(false);
    [1, 2, 3].forEach((id) => {
      expect(page.cards.get(id).link.hasAttribute('data-release-detail-viewer-trigger')).toBe(false);
      expect(page.cards.get(id).link.dispatch('click').defaultPrevented).toBe(false);
    });
    // A later render can never revive it.
    expect(reconcileReleaseDetailViewer(page.document, render({ assets: defaultAssets() }))).toBeNull();
    expect(page.cards.get(2).link.hasAttribute('data-release-detail-viewer-trigger')).toBe(false);
    expect(retireReleaseDetailViewer(page.document)).toBeNull();
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
  });
});


describe('Release Detail authoritative 404 retirement', () => {
  function fixture({ opened = true } = {}) {
    const page = makePage();
    enhanceReleaseDetailViewer(page.document);
    const changes = [];
    observeReleaseDetailRefresh(page.document, (change) => changes.push(change));
    if (opened) page.cards.get(2).link.dispatch('click');
    return { ...page, changes };
  }

  const response = (status, extra = {}) => ({ status, ok: status === 200, ...extra });
  function held() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }

  it.each([true, false])('retires an open=%s viewer once, withdraws descriptors and refuses cached activation', async (opened) => {
    const page = fixture({ opened });
    const old = page.cards.get(2).link;
    const cached = old.cloneNode(true);
    const image = old.querySelector('[data-preview-image]');
    const source = image.getAttribute('src');
    const options = page.viewer.active()?.options;
    page.fetch.mockResolvedValue(response(404));
    expect(await refreshReleaseDetail(page.document, '5')).toBe('retired');
    expect(page.changes).toEqual([{ type: 'retired', releaseId: '5' }]);
    expect(page.viewer.getState().open).toBe(false);
    expect(page.document.querySelectorAll('[data-release-detail-viewer-trigger]')).toHaveLength(0);
    expect(image.isConnected).toBe(true);
    expect(image.getAttribute('src')).toBe(source);
    expect(image.hidden).toBe(false);
    expect(image.closest('[data-preview-enhancement]').getAttribute('data-preview-state')).toBe('loaded');
    expect(image.closest('a').getAttribute('href')).toBe('/projects/7/assets/2');
    expect(image.closest('a').dispatch('click').defaultPrevented).toBe(false);
    expect(Object.values(descriptorOf(old))).toEqual(new Array(8).fill(null));
    expect(old.getAttribute('href')).toBe('/projects/7/assets/2');
    expect(old.dispatch('click').defaultPrevented).toBe(false);
    expect(openReleaseDetailImage(page.document, old)).toBe(0);
    page.selected.appendChild(cached);
    expect(openReleaseDetailImage(page.document, cached)).toBe(0);
    expect(reconcileReleaseDetailViewer(page.document, render({ assets: defaultAssets() }))).toBeNull();
    if (opened) {
      expect(options.opener.isConnected).toBe(false);
      expect(options.fallbackFocus()).toBe(page.nav.children[0]);
    }
    const updates = page.viewer.update.mock.calls.length;
    expect(await refreshReleaseDetail(page.document, '5')).toBe('superseded');
    expect(retireReleaseDetailRefresh(page.document)).toBe(false);
    expect(retireReleaseDetailViewer(page.document)).toBeNull();
    expect(page.viewer.update).toHaveBeenCalledTimes(updates);
    expect(page.viewer.open).toHaveBeenCalledTimes(opened ? 1 : 0);
    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(page.changes).toHaveLength(1);
    expect(enhanceReleaseDetailViewer(page.document)).toBe(1);
    expect(page.document.__creatorCrateReleaseDetailRefresh.observers.size).toBe(2);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it.each([500, 503, 401])('does not retire after HTTP %s', async (status) => {
    const page = fixture();
    page.fetch.mockResolvedValue(response(status));
    expect(await refreshReleaseDetail(page.document, '5')).toBe(status === 401 ? 'signed-out' : 'failed');
    expect(page.changes).toEqual([]);
    expect(page.viewer.getState().open).toBe(true);
    expect(page.cards.get(2).link.hasAttribute('data-release-detail-viewer-trigger')).toBe(true);
  });

  it.each(['network', 'abort rejection', 'aborted response'])('does not retire after %s', async (kind) => {
    const page = fixture();
    const pending = held();
    page.fetch.mockReturnValue(pending.promise);
    const refresh = refreshReleaseDetail(page.document, '5');
    if (kind === 'aborted response') {
      page.document.__creatorCrateReleaseDetailRefresh.abort.abort();
      pending.resolve(response(404));
    } else {
      pending.resolve(Promise.reject(Object.assign(new Error(kind), { name: kind === 'network' ? 'TypeError' : 'AbortError' })));
    }
    expect(await refresh).toBe(kind === 'aborted response' ? 'superseded' : 'failed');
    expect(page.changes).toEqual([]);
    expect(page.viewer.getState().open).toBe(true);
    expect(page.document.__creatorCrateReleaseDetailRefresh.loading).toBe(false);
  });

  it('ignores a superseded 404 after a newer successful refresh and viewer session', async () => {
    const page = fixture();
    const old = held();
    page.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(200, { text: async () => 'current' }));
    const first = refreshReleaseDetail(page.document, '5');
    expect(await refreshReleaseDetail(page.document, '5')).toBe('refreshed');
    page.cards.get(1).link.dispatch('click');
    const newer = page.viewer.getState().session;
    old.resolve(response(404));
    expect(await first).toBe('superseded');
    expect(page.changes.map(({ type }) => type)).toEqual(['adopted']);
    expect(page.viewer.getState()).toMatchObject({ open: true, session: newer });
  });

  it('rejects another release request, a foreign final URL, a redirect and a changed page identity', async () => {
    const page = fixture();
    expect(await refreshReleaseDetail(page.document, '99')).toBe('superseded');
    expect(page.fetch).not.toHaveBeenCalled();
    for (const extra of [{ url: 'http://localhost/releases/99' }, { url: 'https://elsewhere.test/releases/5' }, { redirected: true }]) {
      page.fetch.mockResolvedValue(response(404, extra));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('failed');
    }
    const pending = held();
    page.fetch.mockReturnValue(pending.promise);
    const refresh = refreshReleaseDetail(page.document, '5');
    page.document.querySelector('[data-release-detail]').setAttribute('data-release-detail', '99');
    pending.resolve(response(404));
    expect(await refresh).toBe('superseded');
    expect(page.changes).toEqual([]);
    expect(page.viewer.getState().open).toBe(true);
  });

  it('cannot adopt an older successful body after an authoritative 404', async () => {
    const page = fixture();
    const body = held();
    page.fetch.mockResolvedValueOnce(response(200, { text: () => body.promise })).mockResolvedValueOnce(response(404));
    const first = refreshReleaseDetail(page.document, '5');
    await Promise.resolve();
    expect(await refreshReleaseDetail(page.document, '5')).toBe('retired');
    body.resolve('obsolete');
    expect(await first).toBe('superseded');
    expect(page.changes.map(({ type }) => type)).toEqual(['retired']);
    expect(page.document.querySelectorAll('[data-release-detail-viewer-trigger]')).toHaveLength(0);
    expect(page.viewer.getState().open).toBe(false);
  });

  it('retires its triggers without closing a replacement session owned by another host', async () => {
    const page = fixture();
    const session = page.viewer.open(createViewerSource({ key: 'another-host', items: [
      { projectId: '7', assetId: '1', mediaUrl: '/current.png', title: 'Current' },
    ] }));
    page.fetch.mockResolvedValue(response(404));
    expect(await refreshReleaseDetail(page.document, '5')).toBe('retired');
    expect(page.viewer.getState()).toMatchObject({ open: true, session });
    expect(page.viewer.update).not.toHaveBeenCalled();
  });
});

// ─── C2c: Read comic on Release Detail ──────────────────────────────────────

describe('Release Detail Read comic (C2c)', () => {
  const comicAssets = () => [
    image(1, { role: 'cover', order: 0 }),
    comic(40, { order: 1 }),
    comic(41, { order: 2 }),
    { ...image(3), kind: 'video', order: 3 },
  ];
  const withComic = (id, extra) => comicAssets().map((asset) => (asset.id === id ? { ...asset, ...extra } : asset));
  const response = (status, extra = {}) => ({ status, ok: status === 200, ...extra });
  function held() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }

  function comicPage(options = {}) {
    const page = makePage({ assets: comicAssets(), ...options });
    enhanceReleaseDetailViewer(page.document);
    const changes = [];
    observeReleaseDetailRefresh(page.document, (change) => changes.push(change));
    // Accepted refreshes parse whatever the test says the server now renders.
    page.serve = (assets, releaseId = '5') => {
      page.document.defaultView.DOMParser = class {
        parseFromString() { return render({ releaseId, assets }); }
      };
    };
    page.serve(comicAssets());
    return { ...page, changes };
  }

  function openOn(page, id) {
    const event = page.cards.get(id).link.dispatch('click');
    expect(event.defaultPrevented).toBe(true);
    return page.viewer.getState().session;
  }

  const isWithdrawn = (link) => !link.hasAttribute('data-release-detail-comic-trigger')
    && link.hasAttribute('data-release-detail-comic-withdrawn')
    && ['data-comic-project', 'data-comic-asset', 'data-comic-source-revision', 'data-comic-title']
      .every((name) => !link.hasAttribute(name));

  it('forwards authoritative comic metadata on opening and an accepted render', () => {
    const page = comicPage();
    const link = page.cards.get(41).link;
    link.setAttribute('data-comic-filename', '巻 01 & final!.cbz');
    link.setAttribute('data-comic-project-name', 'Project name');
    link.setAttribute('data-comic-details-url', '/projects/7/assets/41');
    openOn(page, 41);
    expect(page.viewer.openComic.mock.calls[0][0]).toMatchObject({ filename: '巻 01 & final!.cbz', projectName: 'Project name', detailsUrl: '/projects/7/assets/41' });
    reconcileReleaseDetailViewer(page.document, render({ releaseId: '5', assets: comicAssets().map((asset) => asset.id === 41 ? { ...asset, attributes: { 'data-comic-filename': '巻 02 final.cbz', 'data-comic-project-name': '' } } : asset) }));
    expect(page.viewer.reconcileComic.mock.lastCall[0]).toMatchObject({ filename: '巻 02 final.cbz', projectName: '' });
    expect(page.viewer.reconcileComic.mock.lastCall[0]).not.toHaveProperty('detailsUrl');
    expect(page.viewer.manifestRequests).toHaveLength(1);
  });

  it.each(['grid', 'list'])('an unmodified %s click opens that saved comic through openComic', (view) => {
    const page = comicPage({ view });
    const { link } = page.cards.get(41);
    expect(link.dispatch('click').defaultPrevented).toBe(true);
    expect(page.viewer.open).not.toHaveBeenCalled();
    const [descriptor, options] = page.viewer.openComic.mock.calls[0];
    expect(descriptor).toEqual({ projectId: 7, assetId: 41, title: 'book-41', label: '', sourceRevision: 's41' });
    expect(options.opener).toBe(link);
    expect(page.viewer.manifestRequests).toEqual([{ session: 1, projectId: 7, assetId: 41 }]);
    // Each saved comic opens on its own; the next one replaces the source.
    openOn(page, 40);
    expect(page.viewer.getState()).toMatchObject({ open: true, session: 2, comic: { assetId: 40 } });
  });

  it('leaves modified, middle and already-handled clicks to the Asset Details link', () => {
    const page = comicPage();
    const { link } = page.cards.get(40);
    for (const props of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(link.dispatch('click', props).defaultPrevented).toBe(false);
    }
    expect(link.dispatch('click', { defaultPrevented: true }).defaultPrevented).toBe(true);
    expect(page.viewer.openComic).not.toHaveBeenCalled();
  });

  it('reading is presentation-only: no request, Role/Order and release actions untouched, one listener', () => {
    const page = comicPage();
    const roles = [...page.cards.values()].map((card) => card.role.getAttribute('data-role'));
    const orders = [...page.cards.values()].map((card) => card.order.getAttribute('data-order'));
    openOn(page, 40);
    page.viewer.close();
    openOn(page, 41);
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect([...page.cards.values()].map((card) => card.role.getAttribute('data-role'))).toEqual(roles);
    expect([...page.cards.values()].map((card) => card.order.getAttribute('data-order'))).toEqual(orders);
    expect(page.publish.isConnected).toBe(true);
    expect(page.edit.isConnected).toBe(true);
    enhanceReleaseDetailViewer(page.document);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(page.document.__creatorCrateReleaseDetailRefresh.observers.size).toBe(2);
  });

  it('refuses malformed, foreign, mismatched, inert and out-of-section comic links', () => {
    const page = comicPage();
    const tampered = [
      comic(50, { attributes: { 'data-comic-asset': '5x' } }),
      comic(51, { attributes: { 'data-comic-project': '8' } }),
      comic(52, { attributes: { href: '/projects/7/assets/53' } }),
    ].map((asset) => {
      const parts = buildCard(asset, 'grid');
      page.selected.appendChild(parts.article);
      return parts.link;
    });
    const misplaced = buildCard(comic(55), 'grid');
    misplaced.article.setAttribute('data-asset-id', '56');
    page.selected.appendChild(misplaced.article);
    const inert = buildCard(comic(57), 'grid');
    inert.article.setAttribute('inert', '');
    page.selected.appendChild(inert.article);
    const outside = buildCard(comic(58), 'grid');
    page.main.appendChild(outside.article);
    [...tampered, misplaced.link, inert.link, outside.link].forEach((link) => {
      expect(link.dispatch('click').defaultPrevented).toBe(false);
    });
    expect(page.viewer.openComic).not.toHaveBeenCalled();
    expect(page.viewer.manifestRequests).toEqual([]);
  });

  describe('accepted renders (complete saved selection)', () => {
    it('keeps an unchanged hint without a request, through the real refresh', async () => {
      const page = comicPage();
      openOn(page, 41);
      page.fetch.mockResolvedValue(response(200, { text: async () => 'render' }));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('refreshed');
      expect(page.changes.map(({ type }) => type)).toEqual(['adopted']);
      expect(page.viewer.reconcileComic).toHaveBeenCalledTimes(1);
      expect(page.viewer.reconcileComic.mock.calls[0][0]).toEqual({ projectId: 7, assetId: 41, sourceRevision: 's41' });
      expect(page.viewer.manifestRequests).toHaveLength(1);
      expect(page.viewer.getState()).toMatchObject({ open: true, session: 1 });
    });

    it('a new indexed-source hint requests one manifest and updates the page link; its repeat requests none', async () => {
      const page = comicPage();
      openOn(page, 41);
      page.serve(withComic(41, { sourceRevision: 's41b', filename: 'renamed.cbz' }));
      page.fetch.mockResolvedValue(response(200, { text: async () => 'render' }));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('refreshed');
      expect(await refreshReleaseDetail(page.document, '5')).toBe('refreshed');
      expect(page.viewer.manifestRequests).toHaveLength(2);
      expect(page.viewer.reconcileComic.mock.results.map(({ value }) => value.outcome)).toEqual(['reloading', 'unchanged']);
      const link = page.cards.get(41).link;
      expect(link.getAttribute('data-comic-source-revision')).toBe('s41b');
      expect(link.getAttribute('data-comic-title')).toBe('renamed');
      // The next opening uses the current hint.
      page.viewer.close();
      openOn(page, 41);
      expect(page.viewer.openComic.mock.calls[1][0].sourceRevision).toBe('s41b');
    });

    it('retires the reader and withdraws its link when the comic leaves the saved selection', () => {
      const page = comicPage();
      openOn(page, 41);
      const opener = page.cards.get(41).link;
      const result = reconcileReleaseDetailViewer(page.document, render({ assets: comicAssets().filter((asset) => asset.id !== 41) }));
      expect(result).toEqual({ outcome: 'closed', hostReason: 'removed' });
      expect(page.viewer.reconcileComic.mock.calls[0][0]).toEqual({ projectId: 7, assetId: 41, eligible: false });
      expect(page.viewer.getState().open).toBe(false);
      // The static card stays, as its plain Asset Details link.
      expect(opener.isConnected).toBe(true);
      expect(isWithdrawn(opener)).toBe(true);
      expect(opener.getAttribute('href')).toBe('/projects/7/assets/41');
      expect(opener.getAttribute('aria-label')).toBe('View details for book-41.cbz');
      expect(opener.querySelector('[data-preview-image]').hasAttribute('src')).toBe(false);
      expect(page.cards.get(41).media.querySelector('[data-preview-fallback]').hasAttribute('data-release-detail-comic-trigger')).toBe(false);
      expect(opener.dispatch('click').defaultPrevented).toBe(false);
      expect(openReleaseDetailComic(page.document, opener)).toBe(0);
      // A later render offering it again does not revive the withdrawn link.
      expect(reconcileReleaseDetailViewer(page.document, render({ assets: comicAssets() }))).toBeNull();
      expect(isWithdrawn(opener)).toBe(true);
      // The other saved comic is still readable.
      openOn(page, 40);
      expect(page.viewer.openComic).toHaveBeenCalledTimes(2);
    });

    it('retires the reader when its saved card is rendered without Read comic (missing or unreadable)', () => {
      const page = comicPage();
      openOn(page, 41);
      const result = reconcileReleaseDetailViewer(page.document, render({ assets: withComic(41, { kind: 'missing' }) }));
      expect(result).toEqual({ outcome: 'closed', hostReason: 'ineligible' });
      expect(page.viewer.getState().open).toBe(false);
      expect(isWithdrawn(page.cards.get(41).link)).toBe(true);
      expect(page.cards.get(40).link.hasAttribute('data-release-detail-comic-trigger')).toBe(true);
    });

    it('withdraws a closed comic\'s link without reopening anything', () => {
      const page = comicPage();
      openOn(page, 41);
      page.viewer.close();
      expect(reconcileReleaseDetailViewer(page.document, render({ assets: withComic(41, { kind: 'missing' }) }))).toBeNull();
      expect(page.viewer.reconcileComic).not.toHaveBeenCalled();
      expect(page.viewer.getState().open).toBe(false);
      expect(isWithdrawn(page.cards.get(41).link)).toBe(true);
    });

    it('ignores a render of another release or without the selected assets', () => {
      const page = comicPage();
      openOn(page, 41);
      expect(reconcileReleaseDetailViewer(page.document, render({ releaseId: '6', assets: [] }))).toBeNull();
      const bare = makeNode('document');
      bare.nodeType = 9;
      expect(reconcileReleaseDetailViewer(page.document, bare)).toBeNull();
      expect(page.viewer.reconcileComic).not.toHaveBeenCalled();
      expect(page.viewer.getState()).toMatchObject({ open: true, session: 1 });
      expect(page.cards.get(41).link.hasAttribute('data-release-detail-comic-trigger')).toBe(true);
    });

    it('never touches a replacement comic, a replacement image or another host\'s session', () => {
      const page = comicPage();
      openOn(page, 41);
      openOn(page, 40);
      // The first comic's removal cannot close the second.
      expect(reconcileReleaseDetailViewer(page.document, render({ assets: comicAssets().filter((asset) => asset.id !== 41) })))
        .toEqual({ outcome: 'unchanged', hostReason: 'updated' });
      expect(page.viewer.getState()).toMatchObject({ open: true, session: 2, comic: { assetId: 40 } });

      openOn(page, 1);
      expect(reconcileReleaseDetailViewer(page.document, render({ assets: withComic(40, { sourceRevision: 'x' }) }))).toBeNull();
      expect(page.viewer.reconcileComic).toHaveBeenCalledTimes(1);
      expect(page.viewer.getState()).toMatchObject({ open: true, session: 3, key: 'p:7|a:1' });

      const other = comicPage();
      openOn(other, 41);
      other.viewer.openComic({ projectId: 7, assetId: 41, sourceRevision: 's41' });
      expect(reconcileReleaseDetailViewer(other.document, render({ assets: [] }))).toBeNull();
      expect(other.viewer.getState()).toMatchObject({ open: true, session: 2 });
    });

    it('falls back to the same comic\'s link, else the Grid/List switch', () => {
      const page = comicPage();
      openOn(page, 41);
      const { fallbackFocus } = page.viewer.openComic.mock.calls[0][1];
      expect(fallbackFocus()).toBe(page.cards.get(41).link);
      reconcileReleaseDetailViewer(page.document, render({ assets: withComic(41, { kind: 'missing' }) }));
      expect(fallbackFocus()).toBe(page.nav.children[0]);
      expect(fallbackFocus().isConnected).toBe(true);
    });
  });

  describe('authoritative 404 retirement', () => {
    it.each([true, false])('retires an open=%s comic once, withdraws every Read comic link and refuses cached activation', async (opened) => {
      const page = comicPage();
      if (opened) openOn(page, 41);
      const old = page.cards.get(41).link;
      const cached = old.cloneNode(true);
      const options = page.viewer.openComic.mock.calls[0]?.[1];
      page.fetch.mockResolvedValue(response(404));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('retired');
      expect(page.changes).toEqual([{ type: 'retired', releaseId: '5' }]);
      expect(page.viewer.getState().open).toBe(false);
      expect(page.document.querySelectorAll('[data-release-detail-comic-trigger]')).toHaveLength(0);
      expect(page.document.querySelectorAll('[data-release-detail-viewer-trigger]')).toHaveLength(0);
      if (opened) {
        expect(page.viewer.reconcileComic).toHaveBeenCalledTimes(1);
        expect(page.viewer.reconcileComic.mock.calls[0]).toEqual([null, { session: 1 }]);
        // The opener was detached, so focus goes to the connected switch.
        expect(options.opener.isConnected).toBe(false);
        expect(options.fallbackFocus()).toBe(page.nav.children[0]);
      }
      const current = page.selected.querySelector('article[data-asset-id="41"] a.asset-comic-link');
      expect(isWithdrawn(current)).toBe(true);
      expect(current.getAttribute('href')).toBe('/projects/7/assets/41');
      expect(current.dispatch('click').defaultPrevented).toBe(false);
      expect(openReleaseDetailComic(page.document, old)).toBe(0);
      expect(openReleaseDetailComic(page.document, current)).toBe(0);
      // Back inside its own card, with its full descriptor: still refused.
      page.cards.get(41).article.appendChild(cached);
      expect(cached.dispatch('click').defaultPrevented).toBe(false);
      expect(openReleaseDetailComic(page.document, cached)).toBe(0);
      // Repeated, late or direct retirement changes nothing more.
      expect(reconcileReleaseDetailViewer(page.document, render({ assets: comicAssets() }))).toBeNull();
      expect(await refreshReleaseDetail(page.document, '5')).toBe('superseded');
      expect(retireReleaseDetailRefresh(page.document)).toBe(false);
      expect(retireReleaseDetailViewer(page.document)).toBeNull();
      expect(page.viewer.reconcileComic).toHaveBeenCalledTimes(opened ? 1 : 0);
      expect(page.viewer.openComic).toHaveBeenCalledTimes(opened ? 1 : 0);
      expect(page.viewer.manifestRequests).toHaveLength(opened ? 1 : 0);
      expect(page.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([500, 503])('does not retire a comic after HTTP %s', async (status) => {
      const page = comicPage();
      openOn(page, 41);
      page.fetch.mockResolvedValue(response(status));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('failed');
      expect(page.changes).toEqual([]);
      expect(page.viewer.getState()).toMatchObject({ open: true, comic: { assetId: 41 } });
      expect(page.cards.get(41).link.hasAttribute('data-release-detail-comic-trigger')).toBe(true);
    });

    it('does not retire a comic after a network failure', async () => {
      const page = comicPage();
      openOn(page, 41);
      page.fetch.mockRejectedValue(Object.assign(new Error('offline'), { name: 'TypeError' }));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('failed');
      expect(page.viewer.getState().open).toBe(true);
    });

    it('a superseded 404 cannot retire a newer comic session', async () => {
      const page = comicPage();
      openOn(page, 41);
      const old = held();
      page.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(200, { text: async () => 'current' }));
      const first = refreshReleaseDetail(page.document, '5');
      expect(await refreshReleaseDetail(page.document, '5')).toBe('refreshed');
      openOn(page, 40);
      old.resolve(response(404));
      expect(await first).toBe('superseded');
      expect(page.changes.map(({ type }) => type)).toEqual(['adopted']);
      expect(page.viewer.getState()).toMatchObject({ open: true, session: 2, comic: { assetId: 40 } });
      expect(page.cards.get(40).link.hasAttribute('data-release-detail-comic-trigger')).toBe(true);
    });

    it('a foreign release notification cannot retire the current comic', async () => {
      const page = comicPage();
      openOn(page, 41);
      // Another page identity: the refresh refuses to fetch at all.
      expect(await refreshReleaseDetail(page.document, '99')).toBe('superseded');
      page.fetch.mockResolvedValue(response(404, { url: 'http://localhost/releases/99' }));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('failed');
      expect(page.changes).toEqual([]);
      expect(page.viewer.getState().open).toBe(true);
    });

    it('retires the triggers without closing a replacement session owned by another host', async () => {
      const page = comicPage();
      openOn(page, 41);
      const session = page.viewer.openComic({ projectId: 7, assetId: 41, sourceRevision: 's41' });
      page.fetch.mockResolvedValue(response(404));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('retired');
      expect(page.viewer.getState()).toMatchObject({ open: true, session });
      expect(page.viewer.reconcileComic).not.toHaveBeenCalled();
      expect(page.document.querySelectorAll('[data-release-detail-comic-trigger]')).toHaveLength(0);
    });

    it('an open image is still retired as before when comics share the page', async () => {
      const page = comicPage();
      openOn(page, 1);
      page.fetch.mockResolvedValue(response(404));
      expect(await refreshReleaseDetail(page.document, '5')).toBe('retired');
      expect(page.viewer.getState().open).toBe(false);
      expect(page.viewer.reconcileComic).not.toHaveBeenCalled();
      expect(page.document.querySelectorAll('[data-release-detail-viewer-trigger], [data-release-detail-comic-trigger]')).toHaveLength(0);
    });
  });
});


describe('retained release native Preview media', () => {
  it.each(['grid', 'list'])('keeps the %s card/image and updates both Reader links once per source', (view) => {
    const first = comic(41, { previewUrl: '/current-preview?v=one' });
    const page = makePage({ assets: [first, image(1)], view });
    const card = page.cards.get(41);
    const nativeImage = card.media.querySelector('[data-preview-image]');
    const write = vi.spyOn(nativeImage, 'setAttribute');
    reconcileReleaseDetailViewer(page.document, render({ assets: [first, image(1)], view }));
    expect(write.mock.calls.filter(([name]) => name === 'src')).toHaveLength(0);
    const next = comic(41, { previewUrl: '/current-preview?v=two', sourceRevision: 'new-source', filename: 'new.cbz' });
    reconcileReleaseDetailViewer(page.document, render({ assets: [next, image(1)], view }));
    expect(page.cards.get(41).article).toBe(card.article);
    expect(card.media.querySelector('[data-preview-image]')).toBe(nativeImage);
    expect(write.mock.calls.filter(([name]) => name === 'src')).toEqual([['src', '/current-preview?v=two']]);
    const triggers = card.media.querySelectorAll('[data-release-detail-comic-trigger]');
    expect(triggers).toHaveLength(2);
    triggers.forEach(trigger => {
      expect(trigger.getAttribute('data-comic-source-revision')).toBe('new-source');
      expect(trigger.getAttribute('aria-label')).toBe('Read comic new.cbz');
    });
    nativeImage.dispatch('load');
    expect(card.media.getAttribute('data-preview-state')).toBe('loaded');
    reconcileReleaseDetailViewer(page.document, render({ assets: [image(1)], view }));
    expect(nativeImage.hasAttribute('src')).toBe(false);
    expect(nativeImage.hidden).toBe(true);
    expect(card.media.querySelectorAll('[data-release-detail-comic-trigger]')).toHaveLength(0);
  });

  it('uses the visible failed-image fallback for Reader close focus', () => {
    const page = makePage({ assets: [comic(41)] });
    enhanceReleaseDetailViewer(page.document);
    const card = page.cards.get(41);
    const fallback = card.media.querySelector('[data-preview-fallback]');
    card.link.setAttribute('hidden', '');
    fallback.removeAttribute('hidden');
    expect(openReleaseDetailComic(page.document, fallback)).toBe(1);
    expect(page.viewer.openComic.mock.calls[0][1].fallbackFocus()).toBe(fallback);
  });
});
