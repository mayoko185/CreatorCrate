import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enhanceAssetLibraryViewer,
  openAssetLibraryComic,
  openAssetLibraryImage,
  openAssetLibrarySlideshow,
  refreshAssetLibraryViewer,
} from '../src/static/client/asset-library-viewer.js';
import {
  enhanceProjectAssetsViewer,
  refreshProjectAssetsViewer,
} from '../src/static/client/project-assets-viewer.js';
import {
  canPlayViewerSlideshow,
  createViewerSource,
  reconcileViewerSource,
  selectInitialViewerItem,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
} from '../src/static/client/viewer-sequence.js';

// B5b: Global Asset Library host integration for the unified viewer. The page
// is a small DOM shim; the viewer is a controller double whose open/update
// follow unified-viewer.js exactly, using the real B1 source and
// reconciliation functions. The real controller, media reload and focus
// restoration run in Chromium (tests/browser/asset-library-unified-viewer.spec.js).

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
    } else if ((match = rest.match(/^:not\(\[([^\]]+)\]\)/))) {
      if (node.getAttribute(match[1]) !== null) return false;
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

function comicHint(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function makeViewer() {
  let counter = 0;
  let active = null;
  const viewer = {
    // Comic sessions (mirrors unified-viewer.js openComic/reconcileComic):
    // every manifest request the real controller would start is recorded.
    manifestRequests: [],
    openComic: vi.fn((descriptor, options = {}) => {
      counter += 1;
      active = {
        session: counter,
        source: null,
        key: null,
        options,
        comic: { projectId: descriptor.projectId, assetId: descriptor.assetId, sourceHint: comicHint(descriptor.sourceRevision) },
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

// ─── Page fixture ────────────────────────────────────────────────────────────

// Library entries carry their own project: the same filename (and even the
// same file layout) appears in project 1 and project 2.
function entry(id, projectId = 1, extra = {}) {
  return {
    id,
    projectId,
    filename: 'shared.png',
    previewUrl: `/projects/${projectId}/assets/${id}/preview?v=r${id}`,
    viewerUrl: `/projects/${projectId}/assets/${id}`,
    originalUrl: `/projects/${projectId}/assets/${id}/original`,
    revision: `r${id}`,
    ...extra,
  };
}

const DEFAULT_SEQUENCE = [entry(11, 1), entry(21, 2), entry(12, 1)];

// The rendered page shows only `rendered` cards ([projectId, assetId] pairs,
// one page of a larger filtered set); `sequence` is the server's complete
// filtered cross-project image sequence.
function makePage({
  sequence = DEFAULT_SEQUENCE,
  rendered = [[2, 21], [1, 12]],
  view = 'grid',
  video = null,
  withViewer = true,
  document: existingDocument = null,
} = {}) {
  const document = existingDocument || makeNode('document');
  if (!existingDocument) {
    document.nodeType = 9;
    document.ownerDocument = null;
  }
  const main = makeNode('main', { id: 'main-content' });
  document.appendChild(main);
  const region = makeNode('div', { 'data-asset-library-live-region': '' });
  main.appendChild(region);
  const trigger = makeNode('button', { type: 'button', 'data-asset-library-slideshow-trigger': '' });
  region.appendChild(trigger);
  const cards = new Map();
  const linkClass = view === 'grid' ? 'asset-card-media-link' : 'asset-list-card-media-link';
  rendered.forEach(([projectId, id]) => {
    const card = makeNode('li', { class: view === 'grid' ? 'asset-grid-item' : 'asset-list-item' });
    const link = makeNode('a', {
      class: linkClass,
      href: `/projects/${projectId}/assets/${id}`,
      'data-asset-library-preview-id': String(id),
      'data-asset-library-preview-project-id': String(projectId),
    });
    const image = makeNode('img', { class: 'asset-card-thumb' });
    link.appendChild(image);
    const details = makeNode('a', { class: 'asset-details-link', href: `/projects/${projectId}/assets/${id}` });
    const project = makeNode('a', { class: 'asset-project-link', href: `/projects/${projectId}` });
    card.appendChild(link);
    card.appendChild(details);
    card.appendChild(project);
    region.appendChild(card);
    cards.set(`${projectId}:${id}`, { card, link, image, details, project });
  });
  let videoLink = null;
  if (video) {
    videoLink = makeNode('a', { href: `/projects/1/assets/${video}`, 'data-asset-video-preview-trigger': '' });
    region.appendChild(videoLink);
  }
  const script = makeNode('script', {
    type: 'application/json',
    'data-asset-library-viewer-sequence': '',
    'data-viewer-label': 'Asset Viewer',
  });
  script.textContent = JSON.stringify(sequence);
  document.appendChild(script);

  let viewer = null;
  if (!existingDocument) {
    viewer = makeViewer();
    const dialog = makeNode('dialog', { id: 'unified-viewer-dialog' });
    if (withViewer) dialog.__creatorCrateUnifiedViewer = viewer;
    document.appendChild(dialog);
    document.getElementById = (id) => (id === 'unified-viewer-dialog' ? dialog : document.querySelector(`[id="${id}"]`));
  }

  const setSequence = (next) => { script.textContent = typeof next === 'string' ? next : JSON.stringify(next); };
  // A live refresh replaces the region (and so every thumbnail and button).
  let currentRegion = region;
  const replaceRegion = (pairs = rendered) => {
    const next = makePage({ sequence: [], rendered: pairs, view });
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

const keys = (source) => source.items.map((item) => item.key);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Asset Library unified viewer — opening', () => {
  it('an eligible image thumbnail opens only that project-qualified image in a single-image session', () => {
    const page = makePage();
    expect(enhanceAssetLibraryViewer(page.document)).toBe(1);
    const event = page.cards.get('2:21').image.dispatch('click');

    expect(event.defaultPrevented).toBe(true);
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    const [source, options] = page.viewer.open.mock.calls[0];
    expect(source.mode).toBe('single');
    expect(keys(source)).toEqual(['p:2|a:21']);
    expect(source.wrap).toBe(false);
    expect(source.slideshow).toBe(false);
    expect(canPlayViewerSlideshow(source)).toBe(false);
    expect(source.key).toBe('asset-library');
    expect(source.label).toBe('Asset Viewer');
    expect(source.items[0]).toMatchObject({
      projectId: '2',
      assetId: '21',
      mediaUrl: '/projects/2/assets/21/preview?v=r21',
      originalUrl: '/projects/2/assets/21/original',
      detailsUrl: '/projects/2/assets/21',
      revision: 'r21',
      title: 'shared.png',
      alt: 'shared.png',
    });
    expect(options.opener).toBe(page.cards.get('2:21').link);
    expect(options.autoplay).toBeUndefined();
  });

  it.each(['grid', 'list'])('works for %s thumbnails', (view) => {
    const page = makePage({ view });
    enhanceAssetLibraryViewer(page.document);
    expect(page.cards.get('1:12').link.dispatch('click').defaultPrevented).toBe(true);
    expect(keys(page.viewer.open.mock.calls[0][0])).toEqual(['p:1|a:12']);
  });

  it('equal filenames in different projects stay distinct items', () => {
    const page = makePage({ sequence: [entry(5, 1), entry(5, 2)], rendered: [[1, 5], [2, 5]] });
    enhanceAssetLibraryViewer(page.document);
    page.cards.get('2:5').link.dispatch('click');
    expect(keys(page.viewer.open.mock.calls[0][0])).toEqual(['p:2|a:5']);
    page.cards.get('1:5').link.dispatch('click');
    expect(keys(page.viewer.open.mock.calls[1][0])).toEqual(['p:1|a:5']);

    page.trigger.dispatch('click');
    expect(keys(page.viewer.open.mock.calls[2][0])).toEqual(['p:1|a:5', 'p:2|a:5']);
  });

  it('a thumbnail never matches by asset id alone: a missing or wrong project opens nothing', () => {
    const page = makePage();
    enhanceAssetLibraryViewer(page.document);
    const link = page.cards.get('2:21').link;
    link.setAttribute('data-asset-library-preview-project-id', '1');
    expect(link.dispatch('click').defaultPrevented).toBe(false);
    link.setAttribute('data-asset-library-preview-project-id', '');
    expect(link.dispatch('click').defaultPrevented).toBe(false);
    expect(openAssetLibraryImage(page.document, null, '21', null)).toBe(0);
    expect(openAssetLibraryImage(page.document, '2', 'x"]', null)).toBe(0);
    expect(openAssetLibraryImage(page.document, '9', '404', null)).toBe(0);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('the Slideshow button opens the complete cross-project server sequence, in server order, including off-page images', () => {
    // Server order 11 (p1), 21 (p2), 12 (p1); only 21 and 12 are rendered.
    const page = makePage();
    enhanceAssetLibraryViewer(page.document);

    const event = page.trigger.dispatch('click');
    expect(event.defaultPrevented).toBe(true);
    const [source, options] = page.viewer.open.mock.calls[0];
    expect(source.mode).toBe('sequence');
    expect(keys(source)).toEqual(['p:1|a:11', 'p:2|a:21', 'p:1|a:12']);
    expect(source.wrap).toBe(true);
    expect(source.slideshow).toBe(true);
    expect(canPlayViewerSlideshow(source)).toBe(true);
    expect(options.opener).toBe(page.trigger);
    // autoplay is left to the viewer default (on unless reduced motion).
    expect(options.autoplay).toBeUndefined();
    expect(page.viewer.getState().key).toBe('p:1|a:11');
  });

  it('a one-image sequence opens as a slideshow that cannot play', () => {
    const page = makePage({ sequence: [entry(12, 1)], rendered: [[1, 12]] });
    enhanceAssetLibraryViewer(page.document);
    page.trigger.dispatch('click');
    expect(canPlayViewerSlideshow(page.viewer.open.mock.calls[0][0])).toBe(false);
  });

  it('modified, middle and already-handled clicks keep normal link navigation', () => {
    const page = makePage();
    enhanceAssetLibraryViewer(page.document);
    const link = page.cards.get('2:21').link;
    for (const props of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(link.dispatch('click', props).defaultPrevented).toBe(false);
    }
    link.addEventListener('click', (event) => event.preventDefault());
    link.dispatch('click');
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('Details, project links, video triggers and images outside the sequence keep their own behavior', () => {
    // 1:13 is rendered but not in the server image sequence (e.g. a comic or
    // an unsupported image); asset 9 is a video.
    const page = makePage({ sequence: [entry(12, 1)], rendered: [[1, 12], [1, 13]], video: 9 });
    enhanceAssetLibraryViewer(page.document);
    expect(page.cards.get('1:12').details.dispatch('click').defaultPrevented).toBe(false);
    expect(page.cards.get('1:12').project.dispatch('click').defaultPrevented).toBe(false);
    expect(page.cards.get('1:13').link.dispatch('click').defaultPrevented).toBe(false);
    expect(page.videoLink.dispatch('click').defaultPrevented).toBe(false);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('without a bound viewer the thumbnail link still navigates', () => {
    const page = makePage({ withViewer: false });
    enhanceAssetLibraryViewer(page.document);
    expect(page.cards.get('2:21').link.dispatch('click').defaultPrevented).toBe(false);
    expect(page.trigger.dispatch('click').defaultPrevented).toBe(false);
  });

  it('binds once per document and only on the Asset Library', () => {
    const page = makePage();
    expect(enhanceAssetLibraryViewer(page.document)).toBe(1);
    expect(enhanceAssetLibraryViewer(page.document)).toBe(1);
    expect(enhanceAssetLibraryViewer(page.region)).toBe(1);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    page.replaceRegion();
    refreshAssetLibraryViewer(page.document);
    expect(enhanceAssetLibraryViewer(page.document)).toBe(1);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);

    const other = makeNode('document');
    other.nodeType = 9;
    expect(enhanceAssetLibraryViewer(other)).toBe(0);
    expect(other.listeners).toHaveLength(0);
  });

  it('opens once per action after repeated enhancement and live replacement, leaving detached controls inert', () => {
    const page = makePage();
    const enhance = enhanceAssetLibraryViewer;
    enhance(page.document);
    enhance(page.document);
    enhance(page.region);
    for (let count = 1; count <= 3; count += 1) {
      page.cards.get('2:21').link.dispatch('click');
      expect(page.viewer.open).toHaveBeenCalledTimes(count);
    }
    expect(page.viewer.getState().source.mode).toBe('single');
    const oldLink = page.cards.get('2:21').link;
    const oldTrigger = page.trigger;
    const next = page.replaceRegion();
    refreshAssetLibraryViewer(next.region);
    enhance(next.region);
    enhance(page.document);
    oldLink.dispatch('click');
    oldTrigger.dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(3);
    expect(oldLink.listeners).toHaveLength(0);
    expect(oldTrigger.listeners).toHaveLength(0);
    next.cards.get('2:21').link.dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(4);
    expect(page.viewer.getState().source.mode).toBe('single');
    next.trigger.dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(5);
    expect(page.viewer.getState().source.mode).toBe('sequence');
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it('viewing images sends no request', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = makePage();
    enhanceAssetLibraryViewer(page.document);
    page.cards.get('2:21').link.dispatch('click');
    page.trigger.dispatch('click');
    page.setSequence([entry(21, 2), entry(11, 1)]);
    refreshAssetLibraryViewer(page.document);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the Slideshow button follows the sequence emptiness', () => {
    const page = makePage({ sequence: [] });
    enhanceAssetLibraryViewer(page.document);
    expect(page.trigger.disabled).toBe(true);
    expect(page.trigger.dispatch('click').defaultPrevented).toBe(false);
    page.setSequence([entry(11, 1)]);
    const next = page.replaceRegion();
    refreshAssetLibraryViewer(next.region);
    expect(next.trigger.disabled).toBe(false);
  });
});

describe('Asset Library and Project Assets hosts stay separate', () => {
  it('neither host intercepts the other host’s triggers', () => {
    // One document carrying both hosts' hooks (pages never do, but the
    // bindings must still keep to their own selectors).
    const page = makePage();
    const projectRegion = makeNode('div', { 'data-project-assets-live-region': '' });
    const projectTrigger = makeNode('button', { type: 'button', 'data-project-assets-slideshow-trigger': '' });
    const projectLink = makeNode('a', { href: '/projects/1/assets/11', 'data-project-assets-preview-id': '11' });
    projectRegion.appendChild(projectTrigger);
    projectRegion.appendChild(projectLink);
    page.document.appendChild(projectRegion);

    enhanceAssetLibraryViewer(page.document);
    expect(projectLink.dispatch('click').defaultPrevented).toBe(false);
    expect(projectTrigger.dispatch('click').defaultPrevented).toBe(false);
    expect(page.viewer.open).not.toHaveBeenCalled();

    // Project Assets binds nothing here: the page has no Project Assets sequence.
    expect(enhanceProjectAssetsViewer(page.document)).toBe(0);
    page.cards.get('2:21').link.dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it('a session opened by another host is never updated by an Asset Library refresh, and vice versa', () => {
    const page = makePage();
    enhanceAssetLibraryViewer(page.document);
    page.trigger.dispatch('click');
    // Another host opens the shared viewer (session 2).
    page.viewer.open(createViewerSource({ key: 'project-assets:1', items: [{ projectId: 1, assetId: 99, mediaUrl: '/m' }] }));
    page.setSequence([entry(12, 1)]);
    expect(refreshAssetLibraryViewer(page.document)).toBeNull();
    // The Project Assets host has no session of its own on this page.
    expect(refreshProjectAssetsViewer(page.document)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState().key).toBe('p:1|a:99');
  });
});

describe('Asset Library unified viewer — live refresh reconciliation', () => {
  function openSlideshow(sequence = DEFAULT_SEQUENCE) {
    const page = makePage({ sequence, rendered: [[1, 11], [2, 21], [1, 12]] });
    enhanceAssetLibraryViewer(page.document);
    page.trigger.dispatch('click');
    return page;
  }

  it('a filtered or re-sorted sequence keeps the shown asset in the new server order', () => {
    const page = openSlideshow();
    page.viewer.active().key = 'p:2|a:21';
    page.setSequence([entry(12, 1), entry(21, 2), entry(31, 3)]);
    const result = refreshAssetLibraryViewer(page.replaceRegion().region);

    expect(result.outcome).toBe('kept');
    expect(result.reload).toBe(false);
    expect(result.preserveView).toBe(true);
    expect(page.viewer.update.mock.calls[0][1]).toEqual({ session: 1 });
    expect(keys(page.viewer.getState().source)).toEqual(['p:1|a:12', 'p:2|a:21', 'p:3|a:31']);
    expect(page.viewer.getState().key).toBe('p:2|a:21');
  });

  it('the same asset id in another project is a different item', () => {
    const page = openSlideshow([entry(5, 1), entry(6, 1)]);
    // Project 1's asset 5 disappears; project 2 now has an asset 5.
    page.setSequence([entry(5, 2), entry(6, 1)]);
    const result = refreshAssetLibraryViewer(page.document);
    expect(result.outcome).toBe('replaced');
    expect(result.key).toBe('p:1|a:6');
  });

  it('a changed revision or media URL reloads the kept asset and replaces its stale fields', () => {
    const page = openSlideshow();
    page.setSequence([
      entry(11, 1, { revision: 'r11b', previewUrl: '/projects/1/assets/11/preview?v=r11b', filename: 'renamed.png', viewerUrl: '/projects/1/assets/11?pageSize=all' }),
      entry(21, 2),
    ]);
    const result = refreshAssetLibraryViewer(page.document);
    expect(result.outcome).toBe('kept');
    expect(result.revisionChanged).toBe(true);
    expect(result.mediaChanged).toBe(true);
    expect(result.reload).toBe(true);
    expect(result.preserveView).toBe(false);
    expect(result.item).toMatchObject({ title: 'renamed.png', detailsUrl: '/projects/1/assets/11?pageSize=all', revision: 'r11b' });
  });

  it('a removed slideshow item hands over to its nearest surviving successor', () => {
    const page = openSlideshow();
    page.viewer.active().key = 'p:2|a:21';
    page.setSequence([entry(11, 1), entry(12, 1)]);
    const result = refreshAssetLibraryViewer(page.document);
    expect(result.outcome).toBe('replaced');
    expect(result.key).toBe('p:1|a:12');
    expect(result.reload).toBe(true);
    expect(page.viewer.getState().open).toBe(true);
  });

  it('an empty replacement closes the slideshow and forgets the session', () => {
    const page = openSlideshow();
    page.setSequence([]);
    const result = refreshAssetLibraryViewer(page.document);
    expect(result.outcome).toBe('closed');
    expect(page.viewer.getState().open).toBe(false);
    expect(page.trigger.disabled).toBe(true);
    page.setSequence([entry(11, 1)]);
    expect(refreshAssetLibraryViewer(page.document)).toBeNull();
    expect(page.viewer.update).toHaveBeenCalledTimes(1);
  });

  it('a single-image session keeps only its asset and closes once that asset is gone', () => {
    const page = makePage();
    enhanceAssetLibraryViewer(page.document);
    page.cards.get('2:21').link.dispatch('click');

    page.setSequence([entry(12, 1), entry(21, 2, { revision: 'r21b' }), entry(11, 1)]);
    const kept = refreshAssetLibraryViewer(page.document);
    expect(kept.outcome).toBe('kept');
    expect(kept.reload).toBe(true);
    expect(keys(page.viewer.getState().source)).toEqual(['p:2|a:21']);
    expect(page.viewer.getState().source.mode).toBe('single');

    page.setSequence([entry(12, 1), entry(11, 1)]);
    const removed = refreshAssetLibraryViewer(page.document);
    expect(removed.outcome).toBe('closed');
    expect(page.viewer.getState().open).toBe(false);
  });

  it('unchanged or malformed data never updates, and a closed or replaced session is never touched', () => {
    const page = openSlideshow();
    expect(refreshAssetLibraryViewer(page.document)).toBeNull();
    page.setSequence('{not json');
    expect(refreshAssetLibraryViewer(page.document)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState().open).toBe(true);

    page.viewer.close();
    page.setSequence([entry(12, 1)]);
    expect(refreshAssetLibraryViewer(page.document)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
  });

  it('a newer sequence is applied once and an older session id is rejected by the viewer', () => {
    const page = openSlideshow();
    page.trigger.dispatch('click'); // reopen: session 2 supersedes session 1
    page.setSequence([entry(12, 1), entry(11, 1)]);
    refreshAssetLibraryViewer(page.document);
    refreshAssetLibraryViewer(page.document);
    expect(page.viewer.update).toHaveBeenCalledTimes(1);
    expect(page.viewer.update.mock.calls[0][1]).toEqual({ session: 2 });
    expect(page.viewer.update(page.viewer.update.mock.calls[0][0], { session: 1 })).toBeNull();
  });

  it('replaced openers resolve to their replacement thumbnail, else the Slideshow button', () => {
    const page = makePage();
    enhanceAssetLibraryViewer(page.document);
    page.cards.get('2:21').link.dispatch('click');
    const { fallbackFocus } = page.viewer.open.mock.calls[0][1];
    const next = page.replaceRegion([[2, 21], [1, 12]]);
    expect(page.cards.get('2:21').link.isConnected).toBe(false);
    expect(fallbackFocus()).toBe(next.cards.get('2:21').link);
    // Only the same project's asset counts as the replacement.
    const otherProject = page.replaceRegion([[1, 21], [1, 12]]);
    expect(fallbackFocus()).toBe(otherProject.trigger);
    otherProject.trigger.disabled = true;
    expect(fallbackFocus()).toBeNull();

    page.viewer.close();
    otherProject.trigger.disabled = false;
    expect(openAssetLibrarySlideshow(page.document, otherProject.trigger)).toBeGreaterThan(0);
    const slideshowFallback = page.viewer.open.mock.calls[1][1].fallbackFocus;
    const last = page.replaceRegion([[1, 12]]);
    expect(slideshowFallback()).toBe(last.trigger);
  });
});

// ─── Read Comic ──────────────────────────────────────────────────────────────

// A Library comic card as the server renders it: the card <article> carries
// both halves of its identity, and holds either the Read Comic link
// (eligible) or only its ordinary placeholder (missing / unreadable).
function addComicCard(region, {
  projectId, assetId, revision = `c${projectId}-${assetId}`, eligible = true, view = 'grid',
} = {}) {
  const item = makeNode('li', { class: view === 'grid' ? 'asset-grid-item' : 'asset-list-item' });
  const article = makeNode('article', {
    class: view === 'grid' ? 'asset-card' : 'asset-list-card',
    'data-asset-id': String(assetId),
    'data-asset-project-id': String(projectId),
  });
  let link = null;
  if (eligible) {
    link = makeNode('a', {
      class: `${view === 'grid' ? 'asset-card-media-link' : 'asset-list-card-media-link'} asset-comic-link`,
      href: `/projects/${projectId}/assets/${assetId}`,
      'data-asset-library-comic-trigger': '',
      'data-comic-project': String(projectId),
      'data-comic-asset': String(assetId),
      'data-comic-title': 'issue.cbz',
      'data-comic-label': `Project ${projectId}`,
      'data-comic-source-revision': revision,
    });
    link.appendChild(makeNode('span', { class: 'asset-list-card-media-placeholder' }));
    article.appendChild(link);
  } else {
    article.appendChild(makeNode('span', { class: 'asset-card-placeholder' }));
  }
  const details = makeNode('a', { class: 'asset-details-link', href: `/projects/${projectId}/assets/${assetId}` });
  article.appendChild(details);
  item.appendChild(article);
  region.appendChild(item);
  return { item, article, link, details };
}

// The same asset id (40) and filename in projects 1 and 2.
function openComicPage({ view = 'grid', comics = [{ projectId: 1, assetId: 40 }, { projectId: 2, assetId: 40 }] } = {}) {
  const page = makePage({ view });
  const comicCards = new Map(comics.map((spec) => [
    `${spec.projectId}:${spec.assetId}`, addComicCard(page.region, { view, ...spec }),
  ]));
  enhanceAssetLibraryViewer(page.document);
  return { ...page, comicCards };
}

describe('Asset Library unified viewer — Read Comic activation', () => {
  it.each(['grid', 'list'])('an unmodified %s click opens exactly that project-qualified comic', (view) => {
    const page = openComicPage({ view });
    const { link } = page.comicCards.get('2:40');
    expect(link.children[0].dispatch('click').defaultPrevented).toBe(true);
    expect(page.viewer.openComic).toHaveBeenCalledTimes(1);
    const [descriptor, options] = page.viewer.openComic.mock.calls[0];
    expect(descriptor).toEqual({ projectId: 2, assetId: 40, title: 'issue.cbz', label: 'Project 2', sourceRevision: 'c2-40' });
    expect(options.opener).toBe(link);
    expect(page.viewer.manifestRequests).toEqual([{ session: 1, projectId: 2, assetId: 40 }]);
    expect(page.viewer.open).not.toHaveBeenCalled();

    page.comicCards.get('1:40').link.dispatch('click');
    expect(page.viewer.openComic.mock.calls[1][0]).toMatchObject({ projectId: 1, assetId: 40, sourceRevision: 'c1-40' });
    expect(page.viewer.getState()).toMatchObject({ session: 2, comic: { projectId: 1, assetId: 40 } });
  });

  it('modified, middle and already-handled clicks keep the details navigation', () => {
    const page = openComicPage();
    const { link } = page.comicCards.get('1:40');
    for (const props of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(link.dispatch('click', props).defaultPrevented).toBe(false);
    }
    link.addEventListener('click', (event) => event.preventDefault());
    link.dispatch('click');
    expect(page.viewer.openComic).not.toHaveBeenCalled();
  });

  it('a link without both halves of its identity, Details links and ineligible cards open nothing', () => {
    const page = openComicPage({ comics: [{ projectId: 1, assetId: 40 }, { projectId: 2, assetId: 41, eligible: false }] });
    const { link, details } = page.comicCards.get('1:40');
    link.setAttribute('data-comic-project', '');
    expect(link.dispatch('click').defaultPrevented).toBe(false);
    expect(details.dispatch('click').defaultPrevented).toBe(false);
    expect(page.comicCards.get('2:41').article.dispatch('click').defaultPrevented).toBe(false);
    expect(openAssetLibraryComic(page.document, page.cards.get('2:21').link)).toBe(0);
    expect(page.viewer.openComic).not.toHaveBeenCalled();
  });

  it('the two hosts never intercept one another\'s Read Comic links', () => {
    const page = openComicPage();
    enhanceProjectAssetsViewer(page.document);
    page.comicCards.get('1:40').link.dispatch('click');
    expect(page.viewer.openComic).toHaveBeenCalledTimes(1);
    expect(refreshProjectAssetsViewer(page.document)).toBeNull();
  });

  it('opening a comic sends no request from the host and the slideshow stays image-only', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = openComicPage();
    page.comicCards.get('1:40').link.dispatch('click');
    refreshAssetLibraryViewer(page.region);
    expect(fetchSpy).not.toHaveBeenCalled();
    page.trigger.dispatch('click');
    expect(keys(page.viewer.getState().source)).toEqual(DEFAULT_SEQUENCE.map((item) => `p:${item.projectId}|a:${item.id}`));
    expect(page.viewer.getState().comic).toBeNull();
  });
});

describe('Asset Library unified viewer — comic live refresh reconciliation', () => {
  function openComic(options) {
    const page = openComicPage(options);
    page.comicCards.get('1:40').link.dispatch('click');
    return page;
  }

  it('an equivalent card keeps the reader with no new manifest request; a changed hint reloads once', () => {
    const page = openComic();
    let next = page.replaceRegion();
    addComicCard(next.region, { projectId: 1, assetId: 40 });
    expect(refreshAssetLibraryViewer(next.region)).toEqual({ outcome: 'unchanged' });
    expect(page.viewer.manifestRequests).toHaveLength(1);
    for (let index = 0; index < 2; index += 1) {
      next = page.replaceRegion();
      addComicCard(next.region, { projectId: 1, assetId: 40, revision: 'c1-40-b' });
      refreshAssetLibraryViewer(next.region);
    }
    expect(page.viewer.manifestRequests).toHaveLength(2);
    expect(page.viewer.getState()).toMatchObject({ open: true, session: 1 });
  });

  it('another project\'s card for the same asset id never reconciles, retires or reloads the reader', () => {
    const page = openComic();
    let next = page.replaceRegion();
    addComicCard(next.region, { projectId: 2, assetId: 40, revision: 'c2-40-b' });
    expect(refreshAssetLibraryViewer(next.region)).toBeNull();
    next = page.replaceRegion();
    addComicCard(next.region, { projectId: 2, assetId: 40, eligible: false });
    expect(refreshAssetLibraryViewer(next.region)).toBeNull();
    expect(page.viewer.reconcileComic).not.toHaveBeenCalled();
    expect(page.viewer.manifestRequests).toHaveLength(1);
    expect(page.viewer.getState()).toMatchObject({ open: true, comic: { projectId: 1, assetId: 40 } });
  });

  it('absence from the installed region (pagination, filters, sorting) keeps the reader open', () => {
    const page = openComic();
    const next = page.replaceRegion([[1, 12]]);
    expect(refreshAssetLibraryViewer(next.region)).toBeNull();
    page.setSequence([entry(12, 1)]);
    expect(refreshAssetLibraryViewer(page.document)).toBeNull();
    expect(page.viewer.update).not.toHaveBeenCalled();
    expect(page.viewer.getState()).toMatchObject({ open: true, comic: { projectId: 1, assetId: 40 } });
  });

  it('the comic\'s own card without Read Comic retires the reader', () => {
    const page = openComic();
    const next = page.replaceRegion();
    addComicCard(next.region, { projectId: 1, assetId: 40, eligible: false });
    expect(refreshAssetLibraryViewer(next.region)).toEqual({ outcome: 'closed' });
    expect(page.viewer.reconcileComic.mock.calls[0][0]).toEqual({ projectId: 1, assetId: 40, eligible: false });
    expect(page.viewer.getState().open).toBe(false);
  });

  it('a session closed or replaced elsewhere is never touched', () => {
    const page = openComic();
    page.viewer.openComic({ projectId: 2, assetId: 40, sourceRevision: 'c2-40' });
    const next = page.replaceRegion();
    addComicCard(next.region, { projectId: 1, assetId: 40, eligible: false });
    addComicCard(next.region, { projectId: 2, assetId: 40, eligible: false });
    expect(refreshAssetLibraryViewer(next.region)).toBeNull();
    expect(page.viewer.reconcileComic).not.toHaveBeenCalled();
    expect(page.viewer.getState()).toMatchObject({ open: true, session: 2, comic: { projectId: 2 } });
  });

  it('restores focus to the visible Reader fallback after a failed cover is replaced', () => {
    const page = openComic();
    const { fallbackFocus } = page.viewer.openComic.mock.calls[0][1];
    const next = page.replaceRegion();
    const replacement = addComicCard(next.region, { projectId: 1, assetId: 40 });
    const fallback = makeNode('a', {
      'data-asset-library-comic-trigger': '',
      'data-comic-project': '1',
      'data-comic-asset': '40',
      'data-preview-fallback': '',
    });
    replacement.article.appendChild(fallback);
    expect(fallbackFocus()).toBe(fallback);
    fallback.setAttribute('hidden', '');
    expect(fallbackFocus()).toBe(replacement.link);
  });

  it('a replaced opener resolves to the same project-qualified Read Comic link, never another project\'s', () => {
    const page = openComic();
    const { fallbackFocus } = page.viewer.openComic.mock.calls[0][1];
    let next = page.replaceRegion();
    addComicCard(next.region, { projectId: 2, assetId: 40 });
    const replacement = addComicCard(next.region, { projectId: 1, assetId: 40 });
    expect(fallbackFocus()).toBe(replacement.link);
    next = page.replaceRegion();
    addComicCard(next.region, { projectId: 2, assetId: 40 });
    expect(fallbackFocus()).toBe(next.trigger);
  });
});


describe('asset-library authoritative comic metadata', () => {
  it('forwards exact metadata, partial hints and explicit clearing without another open', () => {
    const page = openComicPage();
    const link = page.comicCards.get('1:40').link;
    link.setAttribute('data-comic-filename', '巻 01 & final!.cbz');
    link.setAttribute('data-comic-project-name', 'Authoritative project');
    link.setAttribute('data-comic-details-url', '/projects/1/assets/40');
    link.dispatch('click');
    expect(page.viewer.openComic.mock.calls[0][0]).toMatchObject({
      filename: '巻 01 & final!.cbz', projectName: 'Authoritative project',
      detailsUrl: '/projects/1/assets/40',
    });
    link.setAttribute('data-comic-filename', '巻 02 final.cbz');
    refreshAssetLibraryViewer(page.document);
    expect(page.viewer.reconcileComic.mock.lastCall[0]).toMatchObject({ filename: '巻 02 final.cbz' });
    // This shim omits removeAttribute; null models an absent DOM attribute.
    const getAttribute = link.getAttribute.bind(link);
    link.getAttribute = (name) => name === 'data-comic-project-name' ? null : getAttribute(name);
    refreshAssetLibraryViewer(page.document);
    expect(page.viewer.reconcileComic.mock.lastCall[0]).not.toHaveProperty('projectName');
    link.getAttribute = getAttribute;
    link.setAttribute('data-comic-project-name', '');
    refreshAssetLibraryViewer(page.document);
    expect(page.viewer.reconcileComic.mock.lastCall[0]).toHaveProperty('projectName', '');
    expect(page.viewer.openComic).toHaveBeenCalledTimes(1);
    expect(page.viewer.manifestRequests).toHaveLength(1);
  });
});
