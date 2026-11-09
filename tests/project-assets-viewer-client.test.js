import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enhanceProjectAssetsViewer,
  openProjectAssetsImage,
  openProjectAssetsSlideshow,
  refreshProjectAssetsViewer,
} from '../src/static/client/project-assets-viewer.js';
import {
  enhanceProjectAssetsPreviewSlideshow,
  enhanceSlideshow,
} from '../src/static/client/slideshow.js';
import {
  canPlayViewerSlideshow,
  createViewerSource,
  reconcileViewerSource,
  selectInitialViewerItem,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
} from '../src/static/client/viewer-sequence.js';

// B5a: Project Assets host integration for the unified viewer. The page is a
// small DOM shim; the viewer is a controller double whose open/update follow
// unified-viewer.js exactly, using the real B1 source and reconciliation
// functions. The real controller, media reload and focus restoration run in
// Chromium (tests/browser/project-assets-unified-viewer.spec.js).

// ─── DOM shim ────────────────────────────────────────────────────────────────

function matchesSimple(node, selector) {
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
    textContent: '',
    disabled: false,
    checked: false,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    matches(selector) { return selector.split(',').some((part) => matchesSimple(this, part)); },
    closest(selector) {
      let current = this;
      while (current && current.nodeType === 1) {
        if (current.matches(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    appendChild(child) {
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
  };
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

// ─── Controller double (mirrors unified-viewer.js open/update/getState) ─────

function makeViewer() {
  let counter = 0;
  let active = null;
  const viewer = {
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
  return viewer;
}

// ─── Page fixture ────────────────────────────────────────────────────────────

function entry(id, extra = {}) {
  return {
    id,
    projectId: 7,
    filename: `asset-${id}.png`,
    previewUrl: `/projects/7/assets/${id}/preview?v=r${id}`,
    viewerUrl: `/projects/7/assets/${id}`,
    originalUrl: `/projects/7/assets/${id}/original`,
    revision: `r${id}`,
    ...extra,
  };
}

// The rendered page shows only `rendered` cards (one page of a larger
// filtered set); `sequence` is the server's complete filtered image sequence.
function makePage({ sequence = [entry(1), entry(2), entry(3)], rendered = [2, 3], view = 'grid', video = null, withViewer = true } = {}) {
  const document = makeNode('document');
  document.nodeType = 9;
  document.ownerDocument = null;
  const main = makeNode('main', { id: 'main-content' });
  document.appendChild(main);
  const region = makeNode('div', { 'data-project-assets-live-region': '' });
  main.appendChild(region);
  const trigger = makeNode('button', { type: 'button', 'data-project-assets-slideshow-trigger': '' });
  region.appendChild(trigger);
  const cards = new Map();
  const linkClass = view === 'grid' ? 'asset-card-media-link' : 'asset-list-card-media-link';
  rendered.forEach((id) => {
    const card = makeNode('li', { class: 'asset-grid-item' });
    const checkbox = makeNode('input', { type: 'checkbox', name: 'selectedAssetIds', value: String(id) });
    const link = makeNode('a', { class: linkClass, href: `/projects/7/assets/${id}`, 'data-project-assets-preview-id': String(id) });
    const image = makeNode('img', { class: 'asset-card-thumb' });
    link.appendChild(image);
    const details = makeNode('a', { class: 'asset-details-link', href: `/projects/7/assets/${id}` });
    card.appendChild(checkbox);
    card.appendChild(link);
    card.appendChild(details);
    region.appendChild(card);
    cards.set(id, { card, checkbox, link, image, details });
  });
  let videoLink = null;
  if (video) {
    videoLink = makeNode('a', { href: `/projects/7/assets/${video}`, 'data-asset-video-preview-trigger': '' });
    region.appendChild(videoLink);
  }
  const script = makeNode('script', {
    type: 'application/json',
    'data-slideshow-sequence': '',
    'data-project-assets-viewer-sequence': '',
    'data-project-id': '7',
    'data-viewer-label': 'Seven',
  });
  script.textContent = JSON.stringify(sequence);
  document.appendChild(script);

  const viewer = makeViewer();
  const dialog = makeNode('dialog', { id: 'unified-viewer-dialog' });
  if (withViewer) dialog.__creatorCrateUnifiedViewer = viewer;
  document.appendChild(dialog);
  document.getElementById = (id) => (id === 'unified-viewer-dialog' ? dialog : document.querySelector(`[id="${id}"]`));

  const setSequence = (next) => { script.textContent = typeof next === 'string' ? next : JSON.stringify(next); };
  // A live refresh replaces the region (and so every thumbnail and button).
  let currentRegion = region;
  const replaceRegion = (ids = rendered) => {
    const next = makePage({ sequence: [], rendered: ids, view });
    const nextRegion = next.region;
    currentRegion.remove();
    currentRegion = nextRegion;
    main.appendChild(nextRegion);
    const adopt = (current) => {
      current.ownerDocument = document;
      current.children.forEach(adopt);
    };
    adopt(nextRegion);
    return { region: nextRegion, cards: next.cards, trigger: next.trigger };
  };
  return { document, region, trigger, cards, script, viewer, setSequence, replaceRegion, videoLink };
}

const ids = (source) => source.items.map((item) => item.assetId);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Project Assets unified viewer — opening', () => {
  it('an eligible image thumbnail opens only that image in a single-image session', () => {
    const page = makePage();
    expect(enhanceProjectAssetsViewer(page.document)).toBe(1);
    const event = page.cards.get(2).image.dispatch('click');

    expect(event.defaultPrevented).toBe(true);
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    const [source, options] = page.viewer.open.mock.calls[0];
    expect(source.mode).toBe('single');
    expect(ids(source)).toEqual(['2']);
    expect(source.wrap).toBe(false);
    expect(source.slideshow).toBe(false);
    expect(canPlayViewerSlideshow(source)).toBe(false);
    expect(source.key).toBe('project-assets:7');
    expect(source.items[0]).toMatchObject({
      key: 'p:7|a:2',
      projectId: '7',
      mediaUrl: '/projects/7/assets/2/preview?v=r2',
      originalUrl: '/projects/7/assets/2/original',
      detailsUrl: '/projects/7/assets/2',
      revision: 'r2',
      title: 'asset-2.png',
    });
    expect(options.opener).toBe(page.cards.get(2).link);
  });

  it.each(['grid', 'list'])('works for %s thumbnails', (view) => {
    const page = makePage({ view });
    enhanceProjectAssetsViewer(page.document);
    expect(page.cards.get(3).link.dispatch('click').defaultPrevented).toBe(true);
    expect(ids(page.viewer.open.mock.calls[0][0])).toEqual(['3']);
  });

  it('the Slideshow button opens the complete server sequence, in server order, including off-page images', () => {
    // Server order 3, 1, 2; only 2 and 3 are rendered, in a different order.
    const page = makePage({ sequence: [entry(3), entry(1), entry(2)], rendered: [2, 3] });
    enhanceProjectAssetsViewer(page.document);
    page.cards.get(2).checkbox.checked = true;

    const event = page.trigger.dispatch('click');
    expect(event.defaultPrevented).toBe(true);
    const [source, options] = page.viewer.open.mock.calls[0];
    expect(source.mode).toBe('sequence');
    expect(ids(source)).toEqual(['3', '1', '2']);
    expect(source.wrap).toBe(true);
    expect(source.slideshow).toBe(true);
    expect(canPlayViewerSlideshow(source)).toBe(true);
    expect(source.label).toBe('Seven');
    expect(options.opener).toBe(page.trigger);
    // autoplay is left to the viewer default (on unless reduced motion).
    expect(options.autoplay).toBeUndefined();
    expect(page.viewer.getState().key).toBe('p:7|a:3');
    // Selection neither narrows the sequence nor changes.
    expect(page.cards.get(2).checkbox.checked).toBe(true);
    expect(page.cards.get(3).checkbox.checked).toBe(false);
  });

  it('a one-image sequence opens as a slideshow that cannot play', () => {
    const page = makePage({ sequence: [entry(2)], rendered: [2] });
    enhanceProjectAssetsViewer(page.document);
    page.trigger.dispatch('click');
    expect(canPlayViewerSlideshow(page.viewer.open.mock.calls[0][0])).toBe(false);
  });

  it('modified, middle and already-handled clicks keep normal link navigation', () => {
    const page = makePage();
    enhanceProjectAssetsViewer(page.document);
    const link = page.cards.get(2).link;
    for (const props of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(link.dispatch('click', props).defaultPrevented).toBe(false);
    }
    link.addEventListener('click', (event) => event.preventDefault());
    link.dispatch('click');
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('Details links, video triggers and images outside the sequence keep their own behavior', () => {
    // Asset 3 is rendered but not in the server image sequence (e.g. a comic
    // or an unsupported image); asset 9 is a video.
    const page = makePage({ sequence: [entry(1), entry(2)], rendered: [2, 3], video: 9 });
    enhanceProjectAssetsViewer(page.document);
    expect(page.cards.get(2).details.dispatch('click').defaultPrevented).toBe(false);
    expect(page.cards.get(3).link.dispatch('click').defaultPrevented).toBe(false);
    expect(page.videoLink.dispatch('click').defaultPrevented).toBe(false);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('without a bound viewer the thumbnail link still navigates', () => {
    const page = makePage({ withViewer: false });
    enhanceProjectAssetsViewer(page.document);
    expect(page.cards.get(2).link.dispatch('click').defaultPrevented).toBe(false);
    expect(page.trigger.dispatch('click').defaultPrevented).toBe(false);
  });

  it('binds once per document and only on Project Assets', () => {
    const page = makePage();
    expect(enhanceProjectAssetsViewer(page.document)).toBe(1);
    expect(enhanceProjectAssetsViewer(page.document)).toBe(1);
    expect(enhanceProjectAssetsViewer(page.region)).toBe(1);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    page.replaceRegion();
    expect(enhanceProjectAssetsViewer(page.document)).toBe(1);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);

    const other = makeNode('document');
    other.nodeType = 9;
    expect(enhanceProjectAssetsViewer(other)).toBe(0);
    expect(other.listeners).toHaveLength(0);
  });

  it('the legacy slideshow cannot bind to Project Assets', () => {
    const page = makePage();
    expect(enhanceSlideshow(page.document)).toBe(0);
    expect(enhanceProjectAssetsPreviewSlideshow(page.document)).toBe(0);
    expect(page.cards.get(2).link.listeners).toHaveLength(0);
    expect(page.trigger.listeners).toHaveLength(0);
  });

  it('viewing images sends no request and leaves selection untouched', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const page = makePage();
      enhanceProjectAssetsViewer(page.document);
      page.cards.get(3).checkbox.checked = true;
      page.cards.get(2).link.dispatch('click');
      page.trigger.dispatch('click');
      page.setSequence([entry(2), entry(1)]);
      refreshProjectAssetsViewer(page.document);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(page.cards.get(3).checkbox.checked).toBe(true);
      expect(page.cards.get(2).checkbox.checked).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the Slideshow button follows the sequence emptiness', () => {
    const page = makePage({ sequence: [] });
    enhanceProjectAssetsViewer(page.document);
    expect(page.trigger.disabled).toBe(true);
    expect(page.trigger.dispatch('click').defaultPrevented).toBe(false);
    page.setSequence([entry(1)]);
    const next = page.replaceRegion();
    refreshProjectAssetsViewer(next.region);
    expect(next.trigger.disabled).toBe(false);
  });
});

describe('Project Assets unified viewer — live refresh reconciliation', () => {
  function openSlideshow(sequence = [entry(1), entry(2), entry(3)]) {
    const page = makePage({ sequence, rendered: [1, 2, 3] });
    enhanceProjectAssetsViewer(page.document);
    page.trigger.dispatch('click');
    return page;
  }

  it('a filtered or re-sorted sequence keeps the shown asset in the new server order', () => {
    const page = openSlideshow();
    page.viewer.active().key = 'p:7|a:2';
    page.setSequence([entry(3), entry(2), entry(4)]);
    const result = refreshProjectAssetsViewer(page.replaceRegion().region);

    expect(result.outcome).toBe('kept');
    expect(result.reload).toBe(false);
    expect(result.preserveView).toBe(true);
    expect(page.viewer.update.mock.calls[0][1]).toEqual({ session: 1 });
    expect(ids(page.viewer.getState().source)).toEqual(['3', '2', '4']);
    expect(page.viewer.getState().key).toBe('p:7|a:2');
  });

  it('a changed revision or media URL reloads the kept asset and replaces its stale fields', () => {
    const page = openSlideshow();
    page.setSequence([
      entry(1, { revision: 'r1b', previewUrl: '/projects/7/assets/1/preview?v=r1b', filename: 'renamed.png', viewerUrl: '/projects/7/assets/1?x=1' }),
      entry(2),
    ]);
    const result = refreshProjectAssetsViewer(page.document);
    expect(result.outcome).toBe('kept');
    expect(result.revisionChanged).toBe(true);
    expect(result.mediaChanged).toBe(true);
    expect(result.reload).toBe(true);
    expect(result.preserveView).toBe(false);
    expect(result.item).toMatchObject({ title: 'renamed.png', detailsUrl: '/projects/7/assets/1?x=1', revision: 'r1b' });
  });

  it('a removed slideshow item hands over to its nearest surviving successor', () => {
    const page = openSlideshow();
    page.viewer.active().key = 'p:7|a:2';
    page.setSequence([entry(1), entry(3)]);
    const result = refreshProjectAssetsViewer(page.document);
    expect(result.outcome).toBe('replaced');
    expect(result.key).toBe('p:7|a:3');
    expect(result.reload).toBe(true);
    expect(page.viewer.getState().open).toBe(true);
  });

  it('an empty replacement closes the slideshow', () => {
    const page = openSlideshow();
    page.setSequence([]);
    const result = refreshProjectAssetsViewer(page.document);
    expect(result.outcome).toBe('closed');
    expect(page.viewer.getState().open).toBe(false);
  });

  it('a single-image session keeps only its asset and closes once that asset is gone', () => {
    const page = makePage();
    enhanceProjectAssetsViewer(page.document);
    page.cards.get(2).link.dispatch('click');

    page.setSequence([entry(3), entry(2, { revision: 'r2b' }), entry(1)]);
    const kept = refreshProjectAssetsViewer(page.document);
    expect(kept.outcome).toBe('kept');
    expect(kept.reload).toBe(true);
    expect(ids(page.viewer.getState().source)).toEqual(['2']);
    expect(page.viewer.getState().source.mode).toBe('single');

    page.setSequence([entry(3), entry(1)]);
    const removed = refreshProjectAssetsViewer(page.document);
    expect(removed.outcome).toBe('closed');
    expect(page.viewer.getState().open).toBe(false);
  });

  it('unchanged or malformed data never updates, and a closed or replaced session is never touched', () => {
    const page = openSlideshow();
    expect(refreshProjectAssetsViewer(page.document)).toBeNull();
    page.setSequence('{not json');
    expect(refreshProjectAssetsViewer(page.document)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState().open).toBe(true);

    // Another host (or a later open) owns the viewer now.
    page.viewer.open(createViewerSource({ items: [{ assetId: 99 }] }));
    page.setSequence([entry(1)]);
    expect(refreshProjectAssetsViewer(page.document)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();

    page.viewer.close();
    page.setSequence([entry(2)]);
    expect(refreshProjectAssetsViewer(page.document)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
  });

  it('a newer sequence is applied once and an older session id is rejected by the viewer', () => {
    const page = openSlideshow();
    page.trigger.dispatch('click'); // reopen: session 2 supersedes session 1
    page.setSequence([entry(3), entry(1)]);
    refreshProjectAssetsViewer(page.document);
    refreshProjectAssetsViewer(page.document);
    expect(page.viewer.update).toHaveBeenCalledTimes(1);
    expect(page.viewer.update.mock.calls[0][1]).toEqual({ session: 2 });
    expect(page.viewer.update(page.viewer.update.mock.calls[0][0], { session: 1 })).toBeNull();
  });

  it('replaced openers resolve to their replacement thumbnail, else the Slideshow button', () => {
    const page = makePage();
    enhanceProjectAssetsViewer(page.document);
    page.cards.get(2).link.dispatch('click');
    const { fallbackFocus } = page.viewer.open.mock.calls[0][1];
    const next = page.replaceRegion([2, 3]);
    expect(page.cards.get(2).link.isConnected).toBe(false);
    expect(fallbackFocus()).toBe(next.cards.get(2).link);
    const afterRemoval = page.replaceRegion([3]);
    expect(fallbackFocus()).toBe(afterRemoval.trigger);
    afterRemoval.trigger.disabled = true;
    expect(fallbackFocus()).toBeNull();

    page.viewer.close();
    afterRemoval.trigger.disabled = false;
    expect(openProjectAssetsSlideshow(page.document, afterRemoval.trigger)).toBeGreaterThan(0);
    const slideshowFallback = page.viewer.open.mock.calls[1][1].fallbackFocus;
    const last = page.replaceRegion([3]);
    expect(slideshowFallback()).toBe(last.trigger);
  });

  it('ineligible identities open nothing', () => {
    const page = makePage();
    enhanceProjectAssetsViewer(page.document);
    expect(openProjectAssetsImage(page.document, '404', null)).toBe(0);
    expect(openProjectAssetsImage(page.document, 'x"]', null)).toBe(0);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });
});
