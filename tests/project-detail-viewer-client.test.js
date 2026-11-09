import { describe, expect, it, vi } from 'vitest';
import {
  enhanceProjectDetailViewer,
  openProjectDetailImage,
  retireProjectDetailViewer,
} from '../src/static/client/project-detail-viewer.js';
import { enhanceReleaseDetailViewer } from '../src/static/client/release-detail-viewer.js';
import { enhanceReleaseAssetsViewer } from '../src/static/client/release-assets-viewer.js';
import { PROJECT_DELETED_EVENT } from '../src/static/client/project-edit-dialog.js';
import {
  canPlayViewerSlideshow,
  createViewerSource,
  reconcileViewerSource,
  selectInitialViewerItem,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
  VIEWER_SOURCE_MODE_SINGLE,
} from '../src/static/client/viewer-sequence.js';

// B7c: Project Detail release-thumbnail host integration for the unified
// viewer. The page is a small DOM shim shaped like projects/detail.njk (the
// hero region, the release actions region and the Releases list with its
// title links, social-post badges and thumbnail strips); the viewer is a
// controller double whose open/update follow unified-viewer.js, using the
// real B1 source and reconciliation functions. The real controller, media,
// fullscreen and focus restoration run in Chromium
// (tests/browser/project-detail-unified-viewer.spec.js).


// ─── DOM shim (compound, descendant, child and comma selectors) ──────────────

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

// Compounds separated by descendant spaces or child `>` combinators.
function matchesComplex(node, selector) {
  const tokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const match = (current, index) => {
    if (!matchesCompound(current, tokens[index])) return false;
    if (index === 0) return true;
    if (tokens[index - 1] === '>') {
      const parent = current.parentNode;
      return Boolean(parent && parent.nodeType === 1 && match(parent, index - 2));
    }
    let ancestor = current.parentNode;
    while (ancestor && ancestor.nodeType === 1) {
      if (match(ancestor, index - 1)) return true;
      ancestor = ancestor.parentNode;
    }
    return false;
  };
  return match(node, tokens.length - 1);
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


// ─── Page fixture (projects/detail.njk shape) ────────────────────────────────

const TRIGGER = 'data-project-detail-viewer-trigger';

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
    ...extra,
  };
}

function triggerAttributes(asset, releaseId) {
  return {
    [TRIGGER]: '',
    'data-viewer-project': String(asset.projectId),
    'data-viewer-asset': String(asset.id),
    'data-viewer-filename': asset.filename,
    'data-viewer-preview-url': asset.previewUrl,
    ...(asset.originalUrl ? { 'data-viewer-original-url': asset.originalUrl } : {}),
    ...(asset.revision ? { 'data-viewer-revision': asset.revision } : {}),
    'data-viewer-details-url': asset.detailsUrl,
    'data-viewer-release': String(releaseId),
  };
}

// One release list item: title link, status meta, social-post badge and its
// thumbnail strip (image links, video tiles and the "+N more" link).
function buildRelease(release) {
  const li = makeNode('li');
  const title = makeNode('a', { href: `/releases/${release.id}` });
  li.appendChild(title);
  const meta = makeNode('span', { class: 'meta' });
  const badge = makeNode('span', { class: 'status-badge' });
  meta.appendChild(badge);
  li.appendChild(meta);
  const social = makeNode('div', { class: 'release-social-prep-summary', role: 'group' });
  social.appendChild(makeNode('span', { class: 'status-badge status-badge--neutral' }));
  li.appendChild(social);
  const links = [];
  let strip = null;
  let more = null;
  if (release.assets.length) {
    strip = makeNode('div', { class: 'release-thumbnail-strip' });
    release.assets.forEach((asset) => {
      let link;
      if (asset.kind === 'video') {
        const tile = makeNode('span', { class: 'release-thumbnail-video' });
        link = makeNode('a', {
          class: 'asset-list-card-media-link asset-video-link', href: asset.detailsUrl, 'data-asset-video-preview-trigger': '',
        });
        tile.appendChild(link);
        strip.appendChild(tile);
      } else {
        link = makeNode('a', {
          class: 'release-thumbnail-link',
          href: asset.detailsUrl,
          ...(asset.kind === 'image' ? triggerAttributes(asset, release.id) : {}),
        });
        link.appendChild(makeNode('img', { class: 'release-thumbnail-image' }));
        strip.appendChild(link);
      }
      links.push(link);
    });
    if (release.more) {
      more = makeNode('a', { class: 'release-thumbnail-more', href: `/releases/${release.id}` });
      strip.appendChild(more);
    }
    li.appendChild(strip);
  }
  return { li, title, badge, social, strip, links, more };
}

function buildPage(document, { projectId = '7', releases }) {
  const main = makeNode('main', { id: 'main-content' });
  document.appendChild(main);
  const feedback = makeNode('div', { class: 'notice', 'data-dialog-feedback': '' });
  main.appendChild(feedback);
  const hero = makeNode('section', {
    class: 'project-detail-hero', 'data-project-detail': projectId, 'data-project-detail-region': 'hero',
  });
  const editProject = makeNode('button', { 'data-project-edit-id': projectId, 'data-dialog-open': 'project-edit-dialog' });
  hero.appendChild(editProject);
  main.appendChild(hero);
  const section = makeNode('section', { class: 'release-summary project-detail-releases project-detail-section' });
  const actions = makeNode('div', { class: 'workflow-actions', 'data-project-detail-region': 'release-actions' });
  const viewReleases = makeNode('a', { class: 'button', href: `/releases?project=${projectId}` });
  const createRelease = makeNode('a', { class: 'button button-secondary', href: `/releases/new?projectId=${projectId}` });
  actions.appendChild(viewReleases);
  actions.appendChild(createRelease);
  section.appendChild(actions);
  const list = makeNode('ul', { class: 'release-list' });
  const items = new Map();
  releases.forEach((release) => {
    const parts = buildRelease(release);
    list.appendChild(parts.li);
    items.set(release.id, parts);
  });
  section.appendChild(list);
  main.appendChild(section);
  return { main, hero, editProject, section, actions, viewReleases, createRelease, list, items };
}

// Two releases share asset 2; asset 4 is a video; asset 3 is preview-only;
// assets 5 and 6 share a filename.
const defaultReleases = () => [
  {
    id: 5,
    more: true,
    assets: [image(1), image(2), image(3, { originalUrl: null }), { ...image(4), kind: 'video' }],
  },
  { id: 6, assets: [image(2), image(5, { filename: 'same.png' }), image(6, { filename: 'same.png' })] },
  { id: 8, assets: [] },
];

function makePage({ releases = defaultReleases(), projectId = '7', withViewer = true } = {}) {
  const document = makeNode('document');
  document.nodeType = 9;
  const fetch = vi.fn();
  document.defaultView = { location: { href: `http://localhost/projects/${projectId}`, pathname: `/projects/${projectId}` }, fetch };
  const built = buildPage(document, { projectId, releases });
  const viewer = makeViewer();
  const dialog = makeNode('dialog', { id: 'unified-viewer-dialog' });
  if (withViewer) dialog.__creatorCrateUnifiedViewer = viewer;
  document.appendChild(dialog);
  const link = (releaseId, index) => built.items.get(releaseId).links[index];
  return { document, viewer, fetch, link, ...built };
}

function snapshotStrips(page) {
  return [...page.items.values()].map((item) => item.strip?.children.map((child) => [
    child.tagName, child.getAttribute('class'), child.getAttribute('href'),
    ...(child.children[0] ? [child.children[0].getAttribute('href')] : []),
  ]) ?? null);
}

describe('Project Detail release-thumbnail unified viewer host', () => {
  it('opens only the clicked strip image as a single, non-playing source', async () => {
    const page = makePage();
    const { unifiedViewerFor } = await import('../src/static/client/unified-viewer.js');
    expect(unifiedViewerFor(page.document)).toBe(page.viewer);
    expect(enhanceProjectDetailViewer(page.document)).toBe(1);

    const link = page.link(5, 1);
    const event = link.dispatch('click');
    expect(event.defaultPrevented).toBe(true);
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
    const [source, options] = page.viewer.open.mock.calls[0];
    expect(source.mode).toBe(VIEWER_SOURCE_MODE_SINGLE);
    expect(source.key).toBe('project-detail:7:release:5');
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
    enhanceProjectDetailViewer(page.document);
    page.link(5, 2).dispatch('click');
    const [source] = page.viewer.open.mock.calls[0];
    expect(source.items[0]).toMatchObject({ assetId: '3', originalUrl: null, available: true });
  });

  it('opens the same asset from two release strips as separate, correctly keyed sessions', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    const first = page.link(5, 1);
    const second = page.link(6, 0);
    expect(first.dispatch('click').defaultPrevented).toBe(true);
    page.viewer.close();
    expect(second.dispatch('click').defaultPrevented).toBe(true);
    const [[firstSource, firstOptions], [secondSource, secondOptions]] = page.viewer.open.mock.calls;
    expect(firstSource.key).toBe('project-detail:7:release:5');
    expect(secondSource.key).toBe('project-detail:7:release:6');
    expect(firstSource.items.map((item) => item.key)).toEqual(['p:7|a:2']);
    expect(secondSource.items.map((item) => item.key)).toEqual(['p:7|a:2']);
    expect(firstOptions.opener).toBe(first);
    expect(secondOptions.opener).toBe(second);
    expect(page.viewer.getState().session).toBe(2);
  });

  it('identifies duplicate filenames by asset, never by name or position', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    page.link(6, 2).dispatch('click');
    const [source] = page.viewer.open.mock.calls[0];
    expect(source.items).toHaveLength(1);
    expect(source.items[0]).toMatchObject({ key: 'p:7|a:6', assetId: '6', title: 'same.png' });
  });

  it('leaves modified, middle and already-handled clicks to the link', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    const link = page.link(5, 0);
    for (const props of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(link.dispatch('click', props).defaultPrevented).toBe(false);
    }
    expect(link.dispatch('click', { defaultPrevented: true }).defaultPrevented).toBe(true);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('never opens from release titles, badges, "+N more", release actions, videos or untriggered links', () => {
    const page = makePage({
      releases: [
        { id: 5, more: true, assets: [image(1), { ...image(4), kind: 'video' }, { ...image(9), kind: 'plain' }] },
      ],
    });
    enhanceProjectDetailViewer(page.document);
    const release = page.items.get(5);
    const targets = [
      release.title, release.badge, release.social, release.strip, release.more, release.li,
      release.links[1], release.links[1].parentNode, release.links[2],
      page.viewReleases, page.createRelease, page.editProject, page.hero, page.list,
    ];
    targets.forEach((target) => {
      expect(target.dispatch('click').defaultPrevented).toBe(false);
    });
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('is presentation-only: no request, and strip membership, order and links are untouched', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    const before = snapshotStrips(page);
    const descriptors = page.link(5, 0).getAttribute('data-viewer-preview-url');
    page.link(5, 0).dispatch('click');
    page.viewer.close();
    page.link(6, 1).dispatch('click');
    expect(page.fetch).not.toHaveBeenCalled();
    expect(snapshotStrips(page)).toEqual(before);
    expect(page.link(5, 0).getAttribute('data-viewer-preview-url')).toBe(descriptors);
    expect(page.items.get(5).more.getAttribute('href')).toBe('/releases/5');
    expect(page.items.get(8).strip).toBe(null);
  });

  it('refuses a trigger of another project, outside a strip, without a release or detached', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    const foreign = page.link(5, 0);
    foreign.setAttribute('data-viewer-project', '8');
    expect(foreign.dispatch('click').defaultPrevented).toBe(false);

    const noRelease = page.link(5, 1);
    noRelease.removeAttribute('data-viewer-release');
    expect(noRelease.dispatch('click').defaultPrevented).toBe(false);

    const outside = makeNode('a', { class: 'release-thumbnail-link', href: '/projects/7/assets/3', ...triggerAttributes(image(3), 5) });
    page.section.appendChild(outside);
    expect(outside.dispatch('click').defaultPrevented).toBe(false);

    const detached = page.link(6, 1);
    detached.remove();
    expect(openProjectDetailImage(page.document, detached)).toBe(0);
    expect(page.viewer.open).not.toHaveBeenCalled();
  });

  it('opens nothing without the shared viewer or on a page that is not Project Detail', () => {
    const page = makePage({ withViewer: false });
    expect(enhanceProjectDetailViewer(page.document)).toBe(1);
    expect(page.link(5, 0).dispatch('click').defaultPrevented).toBe(false);

    const other = makeNode('document');
    other.nodeType = 9;
    other.appendChild(makeNode('main', { id: 'main-content' }));
    expect(enhanceProjectDetailViewer(other)).toBe(0);
    const noReleases = makePage();
    noReleases.section.remove();
    expect(enhanceProjectDetailViewer(noReleases.document)).toBe(0);
  });

  it('binds once: repeated enhancement never duplicates a click handler', () => {
    const page = makePage();
    expect(enhanceProjectDetailViewer(page.document)).toBe(1);
    expect(enhanceProjectDetailViewer(page.document)).toBe(1);
    expect(enhanceProjectDetailViewer(page.document)).toBe(1);
    expect(page.document.listeners.filter((listener) => listener.type === 'click')).toHaveLength(1);
    expect(page.document.listeners.filter((listener) => listener.type === PROJECT_DELETED_EVENT)).toHaveLength(1);
    page.link(5, 0).dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
  });

  it('returns focus within the same release when the opener is replaced', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    const opener = page.link(6, 0);
    opener.dispatch('click');
    const { fallbackFocus } = page.viewer.open.mock.calls[0][1];
    // The opener itself is still current.
    expect(fallbackFocus()).toBe(opener);

    // A replacement of the same asset in the same release takes its place,
    // never release 5's thumbnail of the same asset.
    const replacement = makeNode('a', { class: 'release-thumbnail-link', href: '/projects/7/assets/2', ...triggerAttributes(image(2), 6) });
    opener.replaceWith(replacement);
    expect(fallbackFocus()).toBe(replacement);

    // Without one, the same release's title link.
    replacement.remove();
    expect(fallbackFocus()).toBe(page.items.get(6).title);
    expect(fallbackFocus()).not.toBe(page.link(5, 1));

    // Nothing inert is returned (the controller then uses #main-content).
    page.section.setAttribute('inert', '');
    expect(fallbackFocus()).toBe(null);
  });

  it('a Delete that retires the page closes this page’s session and withdraws every trigger', async () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    page.link(5, 0).dispatch('click');
    expect(page.viewer.getState().open).toBe(true);

    // Another project, or a page that was not retired: nothing changes.
    page.document.dispatch(PROJECT_DELETED_EVENT, { detail: { projectId: 8, hostRetired: true } });
    page.document.dispatch(PROJECT_DELETED_EVENT, { detail: { projectId: 7, hostRetired: false } });
    expect(page.viewer.getState().open).toBe(true);
    expect(page.link(5, 0).hasAttribute(TRIGGER)).toBe(true);

    const opener = page.link(5, 0);
    const before = snapshotStrips(page);
    page.main.setAttribute('data-project-deleted-host', '7');
    // The real retire focuses #main-content; the opener must not take it back.
    let openerConnectedAtClose = null;
    const reconcile = page.viewer.update.getMockImplementation();
    page.viewer.update.mockImplementationOnce((replacement, options) => {
      openerConnectedAtClose = opener.isConnected;
      return reconcile(replacement, options);
    });
    page.document.dispatch(PROJECT_DELETED_EVENT, { detail: { projectId: 7, hostRetired: true } });
    expect(page.viewer.update).toHaveBeenLastCalledWith(
      { key: 'project-detail:7:release:5', items: [] }, { session: 1 },
    );
    expect(page.viewer.getState().open).toBe(false);
    // Triggers were withdrawn (and the opener replaced) before the close.
    expect(openerConnectedAtClose).toBe(false);
    expect(opener.isConnected).toBe(false);
    expect(page.document.querySelectorAll(`[${TRIGGER}]`)).toHaveLength(0);
    expect(page.document.querySelectorAll('[data-viewer-asset]')).toHaveLength(0);
    expect(page.document.querySelectorAll('[data-viewer-release]')).toHaveLength(0);
    // The links stay the Asset Details links they always were, in place and order.
    expect(snapshotStrips(page)).toEqual(before);
    const current = page.items.get(5).strip.children[0];
    expect(current.getAttribute('href')).toBe('/projects/7/assets/1');
    expect(current.getAttribute('class')).toBe('release-thumbnail-link');
    expect(current.children).toHaveLength(1);
    // Nothing reopens, through the current link or a stale reference.
    expect(openProjectDetailImage(page.document, opener)).toBe(0);
    expect(openProjectDetailImage(page.document, current)).toBe(0);
    expect(current.dispatch('click').defaultPrevented).toBe(false);
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
  });

  it('never opens on a retired or inert page, even with a trigger left behind', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    page.main.setAttribute('data-project-deleted-host', '7');
    expect(page.link(5, 0).dispatch('click').defaultPrevented).toBe(false);

    const inert = makePage();
    enhanceProjectDetailViewer(inert.document);
    inert.section.setAttribute('inert', '');
    expect(inert.link(5, 0).dispatch('click').defaultPrevented).toBe(false);
    expect(page.viewer.open).not.toHaveBeenCalled();
    expect(inert.viewer.open).not.toHaveBeenCalled();
  });

  it('retirement never touches a session another host opened, or a newer one', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    page.link(5, 0).dispatch('click');
    page.viewer.close();
    // A newer session opened elsewhere (another host's source).
    page.viewer.open({ key: 'elsewhere', mode: 'single', items: [{ projectId: 7, assetId: 1, mediaUrl: '/x' }] });
    const session = page.viewer.getState().session;
    expect(retireProjectDetailViewer(page.document)).toBe(null);
    expect(page.viewer.getState()).toMatchObject({ open: true, session });
    expect(page.viewer.update).not.toHaveBeenCalled();
  });

  it('a closed session cannot be updated later by this host', () => {
    const page = makePage();
    enhanceProjectDetailViewer(page.document);
    page.link(5, 0).dispatch('click');
    page.viewer.close();
    expect(retireProjectDetailViewer(page.document)).toBe(null);
    expect(page.viewer.update).not.toHaveBeenCalled();
  });

  it('leaves Release Detail and Release Manage Assets hosts unbound on Project Detail', () => {
    const page = makePage();
    expect(enhanceReleaseDetailViewer(page.document)).toBe(0);
    expect(enhanceReleaseAssetsViewer(page.document)).toBe(0);
    expect(enhanceProjectDetailViewer(page.document)).toBe(1);
    page.link(5, 0).dispatch('click');
    expect(page.viewer.open).toHaveBeenCalledTimes(1);
  });
});
