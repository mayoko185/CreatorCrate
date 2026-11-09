import { describe, expect, it, vi } from 'vitest';
import {
  enhanceReleaseAssetsViewer,
  openReleaseAssetsImage,
  refreshReleaseAssetsViewer,
} from '../src/static/client/release-assets-viewer.js';
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

// B7a: Release Manage Assets host integration for the unified viewer. The
// page is a small DOM shim shaped like releases/assets.njk; the viewer is a
// controller double whose open/update follow unified-viewer.js, using the
// real B1 source and reconciliation functions. The real controller, media,
// fullscreen and focus restoration run in Chromium
// (tests/browser/release-manage-assets-unified-viewer.spec.js).

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
    listeners: [],
    dataset: {},
    checked: false,
    value: '',
    get hidden() { return attributes.has('hidden'); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
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

function makeViewer() {
  let counter = 0;
  let active = null;
  return {
    open: vi.fn((source, options = {}) => {
      const normalized = createViewerSource(source);
      const initial = selectInitialViewerItem(normalized);
      if (initial.index === -1) return 0;
      counter += 1;
      active = { session: counter, source: normalized, key: initial.key, options };
      return counter;
    }),
    update: vi.fn((replacement, options = {}) => {
      if (!active) return null;
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
      };
    },
    active: () => active,
  };
}

// ─── Page fixture (releases/assets.njk shape) ────────────────────────────────

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
    selected: false,
    ...extra,
  };
}

function triggerAttributes(asset) {
  return {
    'data-release-assets-viewer-trigger': '',
    'data-viewer-project': String(asset.projectId),
    'data-viewer-asset': String(asset.id),
    'data-viewer-filename': asset.filename,
    'data-viewer-preview-url': asset.previewUrl,
    ...(asset.originalUrl ? { 'data-viewer-original-url': asset.originalUrl } : {}),
    ...(asset.revision ? { 'data-viewer-revision': asset.revision } : {}),
    'data-viewer-details-url': asset.detailsUrl,
  };
}

// One grid or list card: selection label/checkbox, Role form (selected only),
// media frame with the thumbnail link, and the Details link.
function buildCard(asset, view) {
  const article = makeNode('article', {
    class: view === 'grid' ? 'asset-card asset-card--release' : 'asset-list-card asset-list-card--release',
    'data-asset-id': String(asset.id),
    'data-asset-selectable-card': '',
    ...(view === 'grid' ? { tabindex: '0' } : {}),
  });
  const label = makeNode('label', { class: 'asset-selection-control', for: `release-asset-select-${asset.id}` });
  const checkbox = makeNode('input', {
    type: 'checkbox', form: 'release-assets-form', name: 'selectedAssetIds', value: String(asset.id),
  });
  checkbox.checked = asset.selected;
  label.appendChild(checkbox);
  article.appendChild(label);
  let role = null;
  if (asset.selected) {
    const form = makeNode('form', { method: 'post', class: 'release-asset-role-form' });
    role = makeNode('select', { name: 'role', 'data-autosubmit': 'true' });
    role.value = 'attachment';
    form.appendChild(role);
    article.appendChild(form);
  }
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
    link.appendChild(makeNode('img', { 'data-preview-image': '' }));
    media.appendChild(link);
  } else if (asset.kind === 'video') {
    link = makeNode('a', { class: 'asset-video-link', href: asset.detailsUrl, 'data-asset-video-preview-trigger': '' });
    media.appendChild(link);
  } else {
    media.appendChild(makeNode('span', { class: 'asset-card-placeholder' }));
  }
  article.appendChild(media);
  const details = makeNode('a', { class: 'asset-details-link', href: asset.detailsUrl });
  article.appendChild(details);
  return { article, label, checkbox, role, media, link, details };
}

function buildRegion(document, { assets, view = 'grid' }) {
  const region = makeNode('section', { 'data-release-assets-live-region': '' });
  region.ownerDocument = document;
  const nav = makeNode('nav', { class: 'view-switcher' });
  nav.appendChild(makeNode('a', { class: 'view-switcher-option', href: '?view=grid', ...(view === 'grid' ? { 'aria-current': 'page' } : {}) }));
  nav.appendChild(makeNode('a', { class: 'view-switcher-option', href: '?view=list', ...(view === 'list' ? { 'aria-current': 'page' } : {}) }));
  region.appendChild(nav);
  const cards = new Map();
  assets.forEach((asset) => {
    const parts = buildCard(asset, view);
    region.appendChild(parts.article);
    cards.set(asset.id, parts);
  });
  return { region, cards };
}

function makePage({ assets = [image(1, { selected: true }), image(2), image(3, { originalUrl: null })], view = 'grid', releaseId = '5', withViewer = true } = {}) {
  const document = makeNode('document');
  document.nodeType = 9;
  // The live engine records each installed response's URL in history.
  const path = releaseId ? `/releases/${releaseId}/assets` : '/releases';
  document.defaultView = { location: { href: `http://localhost${path}?selection=all&view=grid&pageSize=10` } };
  const main = makeNode('main', { id: 'main-content' });
  document.appendChild(main);
  const saveForm = makeNode('form', { id: 'release-assets-form', 'data-asset-selection-form': '' });
  saveForm.submit = vi.fn();
  saveForm.requestSubmit = vi.fn();
  const hidden = makeNode('span', { 'data-release-assets-hidden-membership': '' });
  const hiddenInput = makeNode('input', { type: 'hidden', name: 'selectedAssetIds', value: '99' });
  hidden.appendChild(hiddenInput);
  saveForm.appendChild(hidden);
  main.appendChild(saveForm);
  const built = buildRegion(document, { assets, view });
  main.appendChild(built.region);
  const viewer = makeViewer();
  const dialog = makeNode('dialog', { id: 'unified-viewer-dialog' });
  if (withViewer) dialog.__creatorCrateUnifiedViewer = viewer;
  document.appendChild(dialog);
  return {
    document,
    viewer,
    saveForm,
    hiddenInput,
    get region() { return document.querySelector('[data-release-assets-live-region]'); },
    cards: built.cards,
    // A live refresh: the engine installs the next region, then reconciles.
    install({ href, ...next }) {
      // The engine records the installed response's URL in history first.
      if (href) document.defaultView.location.href = `http://localhost${href}`;
      const replacement = buildRegion(document, { view, ...next });
      document.querySelector('[data-release-assets-live-region]').replaceWith(replacement.region);
      this.cards = replacement.cards;
      return refreshReleaseAssetsViewer(replacement.region);
    },
  };
}

describe('Release Manage Assets unified viewer host', () => {
  it('opens only the clicked eligible image as a single, non-playing source', async () => {
    const page = makePage();
    const { unifiedViewerFor } = await import('../src/static/client/unified-viewer.js');
    expect(unifiedViewerFor(page.document)).toBe(page.viewer);
    expect(enhanceReleaseAssetsViewer(page.document)).toBe(1);

    const { link } = page.cards.get(2);
    const event = link.dispatch('click');
    expect(event.defaultPrevented).toBe(true);
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    const [source, options] = page.viewer.open.mock.calls[0];
    expect(source.mode).toBe(VIEWER_SOURCE_MODE_SINGLE);
    expect(source.key).toBe('release-assets:5');
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
    enhanceReleaseAssetsViewer(page.document);
    page.cards.get(3).link.dispatch('click');
    const [source] = page.viewer.open.mock.calls[0];
    expect(source.items[0]).toMatchObject({ assetId: '3', originalUrl: null, available: true });
  });

  it('leaves modified, middle and already-handled clicks to the link', () => {
    const page = makePage();
    enhanceReleaseAssetsViewer(page.document);
    const { link } = page.cards.get(2);
    for (const props of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(link.dispatch('click', props).defaultPrevented).toBe(false);
    }
    const handled = link.dispatch('click', { defaultPrevented: true });
    expect(handled.defaultPrevented).toBe(true);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('never opens from selection, Role, Details, card, video or placeholder targets', () => {
    const page = makePage({
      assets: [image(1, { selected: true }), { ...image(4), kind: 'video' }, { ...image(5), kind: 'comic' }],
    });
    enhanceReleaseAssetsViewer(page.document);
    const selected = page.cards.get(1);
    const targets = [
      selected.checkbox, selected.label, selected.role, selected.details, selected.article, selected.media,
      page.cards.get(4).link, page.cards.get(4).article, page.cards.get(5).media,
    ];
    targets.forEach((target) => {
      expect(target.dispatch('click').defaultPrevented).toBe(false);
    });
    expect(page.viewer.open).not.toHaveBeenCalled();
    // Keyboard activation of a focused card is the selection path, never the viewer.
    selected.article.dispatch('keydown', { key: 'Enter' });
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('is presentation-only: no checkbox, Role, hidden membership or Save form change', () => {
    const page = makePage();
    enhanceReleaseAssetsViewer(page.document);
    const before = [...page.cards.values()].map((card) => card.checkbox.checked);
    page.cards.get(1).link.dispatch('click');
    page.viewer.close();
    page.cards.get(2).link.dispatch('click');
    page.viewer.close();
    expect([...page.cards.values()].map((card) => card.checkbox.checked)).toEqual(before);
    expect(page.cards.get(1).role.value).toBe('attachment');
    expect(page.hiddenInput.isConnected).toBe(true);
    expect(page.hiddenInput.getAttribute('value')).toBe('99');
    expect(page.saveForm.submit).not.toHaveBeenCalled();
    expect(page.saveForm.requestSubmit).not.toHaveBeenCalled();
  });

  it('refuses detached, foreign, malformed or frameless triggers', () => {
    const page = makePage();
    enhanceReleaseAssetsViewer(page.document);
    const stale = page.cards.get(2).link;
    page.install({ assets: [image(2)] });
    // The old thumbnail is detached by the refresh and can never reopen.
    expect(stale.dispatch('click').defaultPrevented).toBe(false);
    expect(openReleaseAssetsImage(page.document, stale)).toBe(0);

    const outside = makeNode('a', triggerAttributes(image(8)));
    const frame = makeNode('div', { 'data-preview-enhancement': '' });
    frame.appendChild(outside);
    page.document.querySelector('main').appendChild(frame);
    expect(outside.dispatch('click').defaultPrevented).toBe(false);

    const region = page.region;
    const malformed = makeNode('a', { ...triggerAttributes(image(9)), 'data-viewer-asset': '9x' });
    const absolute = makeNode('a', { ...triggerAttributes(image(10)), 'data-viewer-preview-url': 'https://evil.example/x.png' });
    const frameless = makeNode('a', triggerAttributes(image(11)));
    [malformed, absolute].forEach((link) => {
      const media = makeNode('div', { 'data-preview-enhancement': '' });
      media.appendChild(link);
      region.appendChild(media);
    });
    region.appendChild(frameless);
    [malformed, absolute, frameless].forEach((link) => {
      expect(link.dispatch('click').defaultPrevented).toBe(false);
    });
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('binds one delegated listener however often it is enhanced, and only on the release workspace', () => {
    const page = makePage();
    expect(enhanceReleaseAssetsViewer(page.document)).toBe(1);
    expect(enhanceReleaseAssetsViewer(page.document)).toBe(1);
    expect(enhanceReleaseAssetsViewer(page.region)).toBe(1);
    expect(page.document.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
    page.cards.get(2).link.dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(1);

    const other = makePage({ releaseId: null });
    expect(enhanceReleaseAssetsViewer(other.document)).toBe(0);
    expect(other.document.listeners).toHaveLength(0);

    const empty = makeNode('document');
    empty.nodeType = 9;
    expect(enhanceReleaseAssetsViewer(empty)).toBe(0);
  });

  it('opens nothing without a viewer controller', () => {
    const page = makePage({ withViewer: false });
    enhanceReleaseAssetsViewer(page.document);
    expect(page.cards.get(2).link.dispatch('click').defaultPrevented).toBe(false);
  });

  describe('live refresh reconciliation', () => {
    function opened(view = 'grid') {
      const page = makePage({ view });
      enhanceReleaseAssetsViewer(page.document);
      page.cards.get(2).link.dispatch('click');
      return page;
    }

    it('ignores unchanged descriptors (Grid/List, filter or page change that still shows the asset)', () => {
      const page = opened();
      expect(page.install({ assets: [image(2), image(1, { selected: true })], view: 'list' })).toBeNull();
      expect(page.viewer.update).not.toHaveBeenCalled();
      expect(page.viewer.getState()).toMatchObject({ open: true, session: 1 });
    });

    it('updates the kept item for a changed revision, media, original, title or Details URL', () => {
      const page = opened();
      const result = page.install({ assets: [image(2, {
        filename: 'renamed.png',
        previewUrl: '/projects/7/assets/2/preview?v=r2b',
        originalUrl: null,
        detailsUrl: '/projects/7/assets/2?updated=1',
        revision: 'r2b',
      })] });
      expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, reload: true, revisionChanged: true, originalChanged: true });
      expect(page.viewer.update).toHaveBeenCalledWith(
        { key: 'release-assets:5', items: [expect.objectContaining({ assetId: '2', projectId: '7', revision: 'r2b' })] },
        { session: 1 },
      );
      const item = page.viewer.getState().source.items[0];
      expect(item).toMatchObject({ title: 'renamed.png', mediaUrl: '/projects/7/assets/2/preview?v=r2b', originalUrl: null, detailsUrl: '/projects/7/assets/2?updated=1' });
      // The same data again is not a change.
      expect(page.install({ assets: [image(2, {
        filename: 'renamed.png', previewUrl: '/projects/7/assets/2/preview?v=r2b', originalUrl: null, detailsUrl: '/projects/7/assets/2?updated=1', revision: 'r2b',
      })] })).toBeNull();
      expect(page.viewer.update).toHaveBeenCalledTimes(1);
    });

    it('leaves the session alone when the asset merely left the visible page', () => {
      const page = opened();
      const filtered = '/releases/5/assets?selection=all&view=grid&pageSize=10&search=asset-1';
      expect(page.install({ href: filtered, assets: [image(1, { selected: true })] })).toBeNull();
      expect(page.install({ href: '/releases/5/assets?selection=all&pageSize=10&page=2', assets: [] })).toBeNull();
      expect(page.install({ href: '/releases/5/assets?view=grid&pageSize=10', assets: [] })).toBeNull();
      expect(page.viewer.update).not.toHaveBeenCalled();
      expect(page.viewer.getState()).toMatchObject({ open: true, key: 'p:7|a:2' });
    });

    it('keeps the same source when a new earlier row displaces the image onto page 2', () => {
      const initial = [image(1, { selected: true }), ...Array.from({ length: 8 }, (_, index) => image(index + 3)), image(2)];
      const page = makePage({ assets: initial });
      enhanceReleaseAssetsViewer(page.document);
      page.cards.get(2).link.dispatch('click');
      const before = page.viewer.getState();
      const opener = page.cards.get(2).link;
      const { fallbackFocus } = page.viewer.open.mock.calls[0][1];
      const ordered = [image(11), ...initial];
      const page1 = ordered.slice(0, 10);
      const page2 = ordered.slice(10);
      expect(page2[0].id).toBe(2);
      // The installed result still answers the exact same page/filter URL.
      expect(page.install({ assets: page1 })).toBeNull();
      expect(page.cards.has(2)).toBe(false);
      expect(page.viewer.getState()).toEqual(before);
      expect(page.viewer.getState().source).toBe(before.source);
      expect(page.viewer.update).not.toHaveBeenCalled();
      expect(page.viewer.open).toHaveBeenCalledTimes(1);
      expect(opener.isConnected).toBe(false);
      expect(fallbackFocus().isConnected).toBe(true);
      expect(page.hiddenInput.getAttribute('value')).toBe('99');
      expect(page.cards.get(1).checkbox.checked).toBe(true);
      expect(page.saveForm.submit).not.toHaveBeenCalled();
      expect(page.saveForm.requestSubmit).not.toHaveBeenCalled();

      // Grid/List and parameter order cannot turn an omission into removal.
      expect(page.install({ href: '/releases/5/assets?pageSize=10&view=list&selection=all', assets: page1, view: 'list' })).toBeNull();
      expect(page.viewer.getState().source).toBe(before.source);
      expect(page.install({ href: '/releases/5/assets?view=list&pageSize=10', assets: [image(1, { selected: true })] })).toBeNull();
      expect(page.viewer.getState()).toEqual(before);
      expect(page.hiddenInput.isConnected).toBe(true);
      expect(page.viewer.update).not.toHaveBeenCalled();

      const unknown = opened();
      unknown.document.defaultView.location.href = 'not a url';
      expect(unknown.install({ assets: [] })).toBeNull();
      expect(unknown.viewer.getState().open).toBe(true);
    });

    it('updates metadata without reloading unchanged media after an ambiguous omission', () => {
      const page = opened();
      expect(page.install({ assets: [] })).toBeNull();
      const result = page.install({ assets: [image(2, { filename: 'new title.png', detailsUrl: '/projects/7/assets/2?new=1' })] });
      expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, reload: false });
      expect(page.viewer.getState()).toMatchObject({ session: 1, source: { items: [expect.objectContaining({ title: 'new title.png', detailsUrl: '/projects/7/assets/2?new=1' })] } });
    });

    it('reconciles only the current source when another image opens during a refresh', () => {
      const page = opened();
      page.cards.get(3).link.dispatch('click');
      const session = page.viewer.getState().session;
      // A later installation for the previous image supplies no descriptor
      // for the new session's image, and therefore cannot replace its source.
      const before = page.viewer.getState().source;
      expect(page.install({ assets: [image(2, { revision: 'new' })] })).toBeNull();
      expect(page.viewer.getState()).toMatchObject({ open: true, session, key: 'p:7|a:3' });
      expect(page.viewer.getState().source).toBe(before);
      expect(page.viewer.update).not.toHaveBeenCalled();
    });

    it('does not duplicate activation listeners over repeated omitted-result refreshes', () => {
      const page = opened();
      for (let count = 0; count < 3; count += 1) {
        expect(page.install({ assets: [image(1)] })).toBeNull();
        enhanceReleaseAssetsViewer(page.region);
      }
      expect(page.document.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
      page.cards.get(1).link.dispatch('click');
      expect(page.viewer.open).toHaveBeenCalledTimes(2);
      expect(page.viewer.getState().key).toBe('p:7|a:1');
    });

    it('closes when the asset is rendered but no longer an eligible image', () => {
      for (const kind of ['missing', 'video', 'comic']) {
        const page = opened();
        const result = page.install({ assets: [{ ...image(2), kind }] });
        expect(result.outcome).toBe(VIEWER_RECONCILE_CLOSED);
        expect(page.viewer.getState().open).toBe(false);
        // Nothing remains to reconcile afterwards.
        expect(page.install({ assets: [image(2)] })).toBeNull();
      }
    });

    it('closes for another release workspace and ignores a location without its identity', () => {
      const page = opened();
      expect(page.install({ assets: [image(2)], href: '/releases/5/other' })).toBeNull();
      expect(page.viewer.getState().open).toBe(true);
      const result = page.install({ assets: [image(2)], href: '/releases/6/assets?selection=all&pageSize=10' });
      expect(result.reason).toBe('source-changed');
      expect(page.viewer.getState().open).toBe(false);
    });

    it('never touches a closed session or one another host opened', () => {
      const page = opened();
      page.viewer.close();
      expect(page.install({ assets: [image(2, { revision: 'new' })] })).toBeNull();
      expect(page.viewer.update).not.toHaveBeenCalled();

      const other = opened();
      other.viewer.open(createViewerSource({ key: 'project-assets:7', items: [{ assetId: '2', projectId: '7', mediaUrl: '/x' }] }));
      expect(other.install({ assets: [image(2, { revision: 'new' })] })).toBeNull();
      expect(other.viewer.update).not.toHaveBeenCalled();
      expect(other.viewer.getState().key).toBe('p:7|a:2');
      expect(other.viewer.getState().source.key).toBe('project-assets:7');
    });

    it('returns focus to the re-rendered thumbnail, else the current Grid/List switch', () => {
      const page = opened();
      const { fallbackFocus } = page.viewer.open.mock.calls[0][1];
      page.install({ assets: [image(2)], view: 'list' });
      expect(fallbackFocus()).toBe(page.cards.get(2).link);
      expect(fallbackFocus().isConnected).toBe(true);

      page.install({ assets: [image(2, { failed: true })], view: 'list' });
      const current = page.region.querySelector('nav.view-switcher a[aria-current="page"]');
      expect(fallbackFocus()).toBe(current);
      expect(current.getAttribute('href')).toBe('?view=list');

      page.install({ assets: [image(1, { selected: true })] });
      expect(fallbackFocus()).toBe(page.region.querySelector('nav.view-switcher a[aria-current="page"]'));
    });
  });
});
