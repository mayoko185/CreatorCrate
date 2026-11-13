import { describe, expect, it, vi } from 'vitest';
import {
  createViewerContent,
  loadViewerImage,
  viewerImageContentType,
  ViewerMediaError,
  VIEWER_MEDIA_ERROR_ABORTED,
  VIEWER_MEDIA_ERROR_DECODE,
  VIEWER_MEDIA_ERROR_HTTP,
  VIEWER_MEDIA_ERROR_NETWORK,
  VIEWER_MEDIA_ERROR_REDIRECTED,
  VIEWER_MEDIA_ERROR_TYPE,
} from '../src/static/client/viewer-content.js';
import {
  createViewerSource,
  findViewerItemIndex,
  getViewerItem,
  normalizeComicReaderOptions,
  reconcileViewerSource,
  resolveComicPageGroup,
  stepComicPageGroup,
} from '../src/static/client/viewer-sequence.js';

// B3: foreground media loading, stale-result safety, original inspection and
// resource release. A controllable fetch/decode harness drives the real
// module; the elements are a minimal stand-in (no jsdom in this project).
// Real decoding, layout and pointer input are covered in Chromium
// (tests/browser/unified-viewer-media.spec.js).

// ─── Minimal DOM stand-in ────────────────────────────────────────────────────

function makeElement(tagName, document) {
  const attributes = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    ownerDocument: document,
    parentNode: null,
    children: [],
    listeners: [],
    textContent: '',
    style: { width: '', height: '', transform: '' },
    clientWidth: 0,
    clientHeight: 0,
    get hidden() { return attributes.has('hidden'); },
    set hidden(value) { if (value) attributes.set('hidden', ''); else attributes.delete('hidden'); },
    get disabled() { return attributes.has('disabled'); },
    set disabled(value) {
      if (value) attributes.set('disabled', '');
      else attributes.delete('disabled');
      if (value && document.activeElement === element) document.activeElement = document.body;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    appendChild(child) {
      child.remove();
      element.children.push(child);
      child.parentNode = element;
      return child;
    },
    insertBefore(child, reference) {
      element.appendChild(child);
      if (reference && reference.parentNode === element) {
        element.children.splice(element.children.indexOf(child), 1);
        element.children.splice(element.children.indexOf(reference), 0, child);
      }
      return child;
    },
    // Enough of closest() for the viewport's interactive-target exclusion.
    closest(selector) {
      const buttons = selector.split(',').some((part) => part.trim() === 'button');
      for (let node = element; node && node.tagName; node = node.parentNode) {
        if (buttons && node.tagName === 'BUTTON') return node;
        if (node.hasAttribute?.('data-viewer-interactive')) return node;
      }
      return null;
    },
    replaceChildren(...nodes) {
      element.children.slice().forEach((child) => child.remove());
      nodes.forEach((node) => element.appendChild(node));
    },
    remove() {
      const parent = element.parentNode;
      // Like Chromium, removing the focused element (or its container) blurs it.
      if (parent && element.contains(document.activeElement)) document.activeElement = document.body;
      if (parent) parent.children.splice(parent.children.indexOf(element), 1);
      element.parentNode = null;
    },
    contains(node) {
      for (let current = node; current; current = current.parentNode) if (current === element) return true;
      return false;
    },
    addEventListener(type, handler) { element.listeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const index = element.listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) element.listeners.splice(index, 1);
    },
    querySelector(selector) {
      const name = selector.match(/^\[([\w-]+)\]$/)?.[1];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.hasAttribute(name)) return child;
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(element);
    },
    focus() { document.activeElement = element; },
  };
  return element;
}

function fire(target, type, props = {}) {
  const event = {
    type,
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...props,
  };
  target.listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
  return event;
}

// ─── Fetch, object URL and decode harness ────────────────────────────────────

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let index = 0; index < 6; index += 1) await tick();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function imageResponse({ width = 800, height = 600, type = 'image/webp', status = 200, body } = {}) {
  return new Response(body ?? JSON.stringify({ width, height }), { status, headers: { 'content-type': type } });
}

function makeHarness({ holdDecode = false } = {}) {
  const document = { activeElement: null };
  document.body = makeElement('body', document);
  document.createElement = (tagName) => {
    const element = makeElement(tagName, document);
    if (tagName === 'img') {
      element.naturalWidth = 0;
      element.naturalHeight = 0;
      element.decode = async () => {
        const url = element.src;
        const gate = deferred();
        harness.decodes.push({ url, element, ...gate });
        if (!holdDecode) gate.resolve();
        await gate.promise;
        const blob = harness.live.get(url);
        if (!blob || element.src !== url) throw new Error('EncodingError');
        const { width, height } = JSON.parse(await blob.text());
        element.naturalWidth = width;
        element.naturalHeight = height;
      };
      Object.defineProperty(element, 'src', {
        get() { return element.getAttribute('src') || ''; },
        set(value) { element.setAttribute('src', value); },
      });
      harness.images.push(element);
    }
    return element;
  };
  document.contains = (node) => document.body.contains(node);

  const harness = {
    document,
    requests: [],
    decodes: [],
    images: [],
    live: new Map(),
    created: 0,
  };
  harness.fetch = vi.fn((url, init) => {
    const request = { url, init, ...deferred(), aborted: false };
    init.signal?.addEventListener('abort', () => {
      request.aborted = true;
      request.reject(new DOMException('Aborted', 'AbortError'));
    });
    harness.requests.push(request);
    return request.promise;
  });
  harness.urlApi = {
    createObjectURL: vi.fn((blob) => {
      harness.created += 1;
      const url = `blob:test/${harness.created}`;
      harness.live.set(url, blob);
      return url;
    }),
    revokeObjectURL: vi.fn((url) => { harness.live.delete(url); }),
  };
  harness.respond = async (request, options) => {
    request.resolve(typeof options?.then === 'function' ? await options : imageResponse(options));
    await settle();
  };
  harness.last = () => harness.requests[harness.requests.length - 1];
  harness.pending = () => harness.requests.filter((request) => !request.settledByTest && !request.aborted);
  return harness;
}

// ─── Viewer stand-in: regions and the controller's observe() ────────────────

function rawItem(id, extra = {}) {
  return {
    projectId: 7,
    assetId: id,
    title: `image-${id}.png`,
    mediaUrl: `/projects/7/assets/${id}/preview?v=r1`,
    originalUrl: `/projects/7/assets/${id}/original`,
    detailsUrl: `/projects/7/assets/${id}`,
    revision: 'r1',
    ...extra,
  };
}

function makeViewer(options = {}) {
  const harness = makeHarness(options);
  const { document } = harness;
  const make = (tag, attribute) => {
    const element = makeElement(tag, document);
    if (attribute) element.setAttribute(attribute, '');
    return element;
  };
  const root = make('div', 'data-unified-viewer');
  const media = make('div', 'data-unified-viewer-media');
  media.clientWidth = 1000;
  media.clientHeight = 800;
  media.setPointerCapture = vi.fn();
  media.releasePointerCapture = vi.fn();
  const status = make('p', 'data-unified-viewer-status');
  const viewTools = make('div', 'data-unified-viewer-view-tools');
  viewTools.hidden = true;
  const zoomOut = viewTools.appendChild(make('button', 'data-unified-viewer-zoom-out'));
  const zoomLevel = viewTools.appendChild(make('span', 'data-unified-viewer-zoom-level'));
  const zoomIn = viewTools.appendChild(make('button', 'data-unified-viewer-zoom-in'));
  const fit = viewTools.appendChild(make('button', 'data-unified-viewer-fit'));
  const original = viewTools.appendChild(make('button', 'data-unified-viewer-original'));
  const quality = root.appendChild(make('button', 'data-unified-viewer-quality'));
  const close = make('button', 'data-dialog-close');
  [viewTools, media, status, close].forEach((child) => root.appendChild(child));
  document.body.appendChild(root);

  const observers = new Set();
  const observe = vi.fn((listener) => {
    observers.add(listener);
    return () => observers.delete(listener);
  });
  const content = createViewerContent({
    document,
    regions: { root, media, status, viewTools },
    observe,
    keyTarget: root,
    keyOwned: (target) => target?.tagName === 'INPUT',
    focusFallback: () => close,
    onPageConflict: options.onPageConflict,
    fetch: harness.fetch,
    urlApi: harness.urlApi,
    view: null,
  });

  let session = 0;
  let state = null;
  const send = (type, extra = {}) => {
    const index = findViewerItemIndex(state.source, state.key);
    const change = Object.freeze({
      type,
      session: state.session,
      source: state.source,
      key: state.key,
      index,
      count: state.source.items.length,
      item: getViewerItem(state.source, state.key),
      previousKey: null,
      reload: false,
      preserveView: false,
      reason: null,
      ...extra,
    });
    observers.forEach((listener) => listener(change));
    return change;
  };
  const viewer = {
    open(ids = [1, 2, 3], sourceOptions = {}) {
      session += 1;
      const source = createViewerSource({
        key: 'test',
        mode: 'sequence',
        items: ids.map((id) => (typeof id === 'object' ? id : rawItem(id))),
        ...sourceOptions,
      });
      state = { session, source, key: source.items[0].key };
      return send('open', { reload: true });
    },
    go(id, extra = {}) {
      const previousKey = state.key;
      state.key = `p:7|a:${id}`;
      return send('navigate', { previousKey, reload: true, ...extra });
    },
    update(items) {
      const previousKey = state.key;
      const result = reconcileViewerSource(state.source, state.key, items);
      state.source = result.source;
      state.key = result.key;
      return send('update', {
        previousKey,
        reload: result.reload,
        preserveView: result.preserveView,
        revisionChanged: result.revisionChanged,
        mediaChanged: result.mediaChanged,
        originalChanged: result.originalChanged,
      });
    },
    close() {
      send('close', { reason: 'closed' });
      state = null;
    },
  };
  return {
    ...harness,
    content,
    viewer,
    observe,
    observers,
    parts: { root, media, status, viewTools, zoomOut, zoomIn, zoomLevel, fit, original, quality, close },
    shown: () => media.children.filter((child) => child.tagName === 'IMG' && !child.hidden),
  };
}

// ─── Loader ──────────────────────────────────────────────────────────────────

describe('viewer image loader', () => {
  it('accepts only the image types CreatorCrate serves', () => {
    expect(viewerImageContentType('image/webp')).toBe('image/webp');
    expect(viewerImageContentType('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(viewerImageContentType('image/jpeg')).toBe('image/jpeg');
    expect(viewerImageContentType('image/gif')).toBe('image/gif');
    expect(viewerImageContentType('text/html; charset=utf-8')).toBeNull();
    expect(viewerImageContentType('image/svg+xml')).toBeNull();
    expect(viewerImageContentType('application/octet-stream')).toBeNull();
    expect(viewerImageContentType(null)).toBeNull();
  });

  it('fetches with application credentials, then decodes and reports intrinsic size', async () => {
    const h = makeHarness();
    const pending = loadViewerImage('/projects/7/assets/1/preview?v=r1', {
      fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img'),
    });
    expect(h.fetch).toHaveBeenCalledWith('/projects/7/assets/1/preview?v=r1', expect.objectContaining({
      method: 'GET', credentials: 'same-origin',
    }));
    await h.respond(h.last(), { width: 1200, height: 900 });
    const result = await pending;
    expect(result).toMatchObject({ width: 1200, height: 900, type: 'image/webp' });
    expect(h.live.size).toBe(1);
    result.release();
    result.release();
    expect(h.live.size).toBe(0);
    expect(h.urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(result.image.hasAttribute('src')).toBe(false);
  });

  it('rejects unsafe URLs without fetching', async () => {
    const h = makeHarness();
    const deps = { fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img') };
    await expect(loadViewerImage('https://evil.example/x.png', deps)).rejects.toMatchObject({ code: 'invalid-url' });
    await expect(loadViewerImage('//evil.example/x.png', deps)).rejects.toMatchObject({ code: 'invalid-url' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP error', { status: 404, type: 'text/plain', body: 'Not found' }, VIEWER_MEDIA_ERROR_HTTP],
    ['HTML masquerading as an image', { type: 'text/html', body: '<html>login</html>' }, VIEWER_MEDIA_ERROR_TYPE],
    ['undecodable bytes', { type: 'image/png', body: 'not json' }, VIEWER_MEDIA_ERROR_DECODE],
  ])('rejects a %s with a controlled code and no leaked object URL', async (_label, response, code) => {
    const h = makeHarness();
    const pending = loadViewerImage('/m/1', {
      fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img'),
    });
    pending.catch(() => {});
    await h.respond(h.last(), response);
    const error = await pending.catch((caught) => caught);
    expect(error).toMatchObject({ name: 'ViewerMediaError', code });
    expect(error.message).not.toMatch(/login|Not found/);
    expect(h.live.size).toBe(0);
  });

  it('maps a network failure and an abort to their own codes', async () => {
    const h = makeHarness();
    const deps = { fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img') };
    const network = loadViewerImage('/m/1', deps);
    h.last().reject(new TypeError('Failed to fetch'));
    await expect(network).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_NETWORK });

    const controller = new AbortController();
    const aborted = loadViewerImage('/m/2', { ...deps, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_ABORTED });
  });

  it('releases the object URL when aborted during decode', async () => {
    const h = makeHarness({ holdDecode: true });
    const controller = new AbortController();
    const pending = loadViewerImage('/m/1', {
      fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img'), signal: controller.signal,
    });
    pending.catch(() => {});
    await h.respond(h.last());
    expect(h.decodes).toHaveLength(1);
    expect(h.live.size).toBe(1);
    controller.abort();
    h.decodes[0].resolve();
    await expect(pending).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_ABORTED });
    expect(h.live.size).toBe(0);
  });
});

// ─── Foreground loading through observe() ───────────────────────────────────

describe('viewer content loading', () => {
  it('loads only the selected item and shows it with alt text and Fit', async () => {
    const v = makeViewer();
    expect(v.observe).toHaveBeenCalledTimes(1);
    v.viewer.open([1, 2, 3]);
    expect(v.fetch).toHaveBeenCalledTimes(1);
    expect(v.last().url).toBe('/projects/7/assets/1/preview?v=r1');
    expect(v.parts.root.getAttribute('data-viewer-media-state')).toBe('loading');
    expect(v.parts.media.getAttribute('aria-busy')).toBe('true');
    expect(v.parts.media.querySelector('[data-unified-viewer-loading]')).not.toBeNull();
    expect(v.parts.status.textContent).toBe('');
    expect(v.content.getState()).toMatchObject({ status: 'loading', key: 'p:7|a:1' });

    await v.respond(v.requests[0], { width: 2000, height: 1000 });
    expect(v.parts.root.getAttribute('data-viewer-media-state')).toBe('loaded');
    expect(v.parts.media.hasAttribute('aria-busy')).toBe(false);
    const [image] = v.shown();
    expect(image.getAttribute('alt')).toBe('image-1.png');
    expect(image.style.width).toBe('1000px');
    expect(v.parts.viewTools.hidden).toBe(false);
    expect(v.parts.zoomLevel.textContent).toBe('Fit');
    expect(v.parts.zoomOut.disabled).toBe(true);
    expect(v.parts.zoomIn.disabled).toBe(false);
    expect(v.parts.fit.disabled).toBe(true);
    expect(v.parts.original.hidden).toBe(false);
    expect(v.content.getState()).toMatchObject({ status: 'loaded', width: 2000, height: 1000, error: null });
  });

  it('shows a failure with Retry, then retries the same item', async () => {
    const v = makeViewer();
    v.viewer.open([1]);
    await v.respond(v.last(), { status: 500, type: 'text/plain', body: 'stack trace' });
    expect(v.content.getState()).toMatchObject({ status: 'failed', error: 'http', retryable: true });
    expect(v.parts.status.textContent).toBe('This image could not be loaded.');
    expect(v.parts.viewTools.hidden).toBe(true);
    const retryButton = v.parts.media.querySelector('[data-unified-viewer-retry]');
    expect(retryButton.textContent).toBe('Retry');
    retryButton.focus();

    fire(retryButton, 'click');
    expect(v.fetch).toHaveBeenCalledTimes(2);
    expect(v.parts.status.textContent).toBe('Trying again…');
    expect(v.content.getState()).toMatchObject({ status: 'loading', attempt: 1 });
    // The pressed Retry left the surface; focus lands on a usable control.
    expect(v.document.activeElement).toBe(v.parts.close);

    await v.respond(v.last(), { width: 300, height: 200 });
    expect(v.content.getState()).toMatchObject({ status: 'loaded', attempt: 1 });
    expect(v.parts.status.textContent).toBe('');
    expect(v.shown()[0].style.width).toBe('300px');
  });

  it('fails safely on a non-image response and a network error', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2]);
    await v.respond(v.last(), { type: 'text/html', body: '<p>Sign in</p>' });
    expect(v.content.getState().error).toBe('type');
    expect(v.shown()).toHaveLength(0);
    v.viewer.go(2);
    v.last().reject(new TypeError('offline'));
    await settle();
    expect(v.content.getState()).toMatchObject({ status: 'failed', error: 'network', key: 'p:7|a:2' });
    expect(v.live.size).toBe(0);
  });

  it('never fetches an unavailable item and keeps the shell message', () => {
    const v = makeViewer();
    v.parts.status.textContent = 'No preview is available for this item.';
    v.viewer.open([rawItem(1, { mediaUrl: null })]);
    expect(v.fetch).not.toHaveBeenCalled();
    expect(v.content.getState()).toMatchObject({ status: 'unavailable', retryable: false });
    expect(v.parts.status.textContent).toBe('No preview is available for this item.');
    expect(v.parts.viewTools.hidden).toBe(true);
    expect(v.content.retry()).toBe(false);
  });
});

describe('viewer content stale results', () => {
  it('aborts and ignores obsolete loads during rapid Next/Previous', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2, 3]);
    v.viewer.go(2);
    v.viewer.go(3);
    v.viewer.go(2);
    expect(v.requests.map((request) => request.aborted)).toEqual([true, true, true, false]);
    await v.respond(v.requests[3], { width: 222, height: 100 });
    // Late completions of earlier requests change nothing.
    v.requests[0].resolve(imageResponse({ width: 111, height: 100 }));
    await settle();
    expect(v.content.getState()).toMatchObject({ key: 'p:7|a:2', status: 'loaded', width: 222 });
    expect(v.shown()).toHaveLength(1);
    expect(v.shown()[0].style.width).toBe('222px');
  });

  it('never lets a late error overwrite the current item', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2]);
    const first = v.last();
    v.viewer.go(2);
    await v.respond(v.last(), { width: 400, height: 300 });
    first.reject(new TypeError('late failure'));
    await settle();
    expect(v.content.getState()).toMatchObject({ key: 'p:7|a:2', status: 'loaded', error: null });
    expect(v.parts.status.textContent).toBe('');
  });

  it('installs nothing after closing during fetch or during decode', async () => {
    const v = makeViewer({ holdDecode: true });
    v.viewer.open([1]);
    v.viewer.close();
    expect(v.requests[0].aborted).toBe(true);

    v.viewer.open([2]);
    await v.respond(v.last());
    expect(v.decodes).toHaveLength(1);
    v.viewer.close();
    v.decodes[0].resolve();
    await settle();
    expect(v.content.getState().status).toBe('idle');
    expect(v.parts.media.children).toHaveLength(0);
    expect(v.live.size).toBe(0);
    expect(v.parts.root.getAttribute('data-viewer-media-state')).toBe('idle');
  });

  it('releases a result whose decode finished in the same turn as the close', async () => {
    const v = makeViewer({ holdDecode: true });
    v.viewer.open([1]);
    await v.respond(v.last());
    v.decodes[0].resolve();
    v.viewer.close();
    await settle();
    expect(v.live.size).toBe(0);
    expect(v.parts.media.children).toHaveLength(0);
  });

  it('never shows an earlier session’s result after reopening', async () => {
    const v = makeViewer();
    v.viewer.open([1]);
    const earlier = v.last();
    v.viewer.close();
    v.viewer.open([5]);
    // Even a completion that ignored its abort stays out.
    earlier.resolve(imageResponse({ width: 999, height: 999 }));
    await v.respond(v.last(), { width: 500, height: 400 });
    expect(v.content.getState()).toMatchObject({ key: 'p:7|a:5', width: 500 });
    expect(v.shown()).toHaveLength(1);
    expect(v.live.size).toBe(1);
  });

  it('reloads on a changed media URL or revision and keeps unchanged media and its zoom', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2]);
    await v.respond(v.last(), { width: 2000, height: 1000 });
    v.content.zoomIn();
    const zoomed = v.content.getState().view.scale;
    expect(zoomed).toBeGreaterThan(0.5);

    v.viewer.update([rawItem(1, { title: 'renamed.png' }), rawItem(2)]);
    expect(v.fetch).toHaveBeenCalledTimes(2); // the neighbour preload only
    expect(v.content.getState()).toMatchObject({ status: 'loaded' });
    expect(v.content.getState().view.scale).toBe(zoomed);
    expect(v.shown()[0].getAttribute('alt')).toBe('renamed.png');

    v.viewer.update([rawItem(1, { revision: 'r2', mediaUrl: '/projects/7/assets/1/preview?v=r2' }), rawItem(2)]);
    expect(v.last().url).toBe('/projects/7/assets/1/preview?v=r2');
    expect(v.content.getState().status).toBe('loading');
    await v.respond(v.last(), { width: 2000, height: 1000 });
    expect(v.content.getState().view).toMatchObject({ mode: 'fit', scale: 0.5 });

    v.viewer.update([rawItem(1, { revision: 'r2', mediaUrl: '/projects/7/assets/1/preview?v=r3' }), rawItem(2)]);
    expect(v.last().url).toBe('/projects/7/assets/1/preview?v=r3');
  });

  it('keeps one object URL per shown image across repeated opens', async () => {
    const v = makeViewer();
    for (let round = 0; round < 4; round += 1) {
      v.viewer.open([round + 1]);
      await v.respond(v.last(), { width: 100, height: 100 });
      expect(v.live.size).toBe(1);
      v.viewer.close();
      expect(v.live.size).toBe(0);
    }
    expect(v.observers.size).toBe(1);
    expect(v.fetch).toHaveBeenCalledTimes(4);
  });
});

function qualityItem(id = 1, { source = '1111111111111111', rendition = '2222222222222222', original = true, optimized = true, ...extra } = {}) {
  return rawItem(id, {
    mediaUrl: `/projects/7/assets/${id}/original`,
    imageSources: {
      projectId: 7, assetId: id, sourceRevision: source,
      optimized: { url: `/projects/7/assets/${id}/preview?rendition=optimized&sourceRevision=${source}&v=${rendition}`, revision: rendition, eligible: optimized },
      original: { url: `/projects/7/assets/${id}/original?sourceRevision=${source}`, eligible: original },
      toggleEligible: optimized && original,
    }, ...extra,
  });
}

async function loadedQuality(options = {}) {
  const v = makeViewer(options);
  v.viewer.open([qualityItem()]);
  await v.respond(v.last(), { width: 2000, height: 1000 });
  return v;
}

describe('viewer source quality and Actual Size', () => {
  it('defaults explicitly optimized despite legacy Original policy and changes Actual Size without fetching', async () => {
    const v = await loadedQuality();
    expect(v.last().url).toContain('rendition=optimized');
    expect(v.parts.quality.hidden).toBe(false);
    expect(v.content.getState().quality).toMatchObject({ desired: 'optimized', displayed: 'optimized', loading: false });
    v.content.actualSize();
    expect(v.content.getState().view.scale).toBe(1);
    expect(v.requests).toHaveLength(1);
    expect(v.content.getState().quality.displayed).toBe('optimized');
    v.viewer.close();
  });

  it('switches both directions in Fit and retains only one decoded result', async () => {
    const v = await loadedQuality();
    const previous = v.shown()[0];
    fire(v.parts.quality, 'click');
    expect(v.content.getState().quality).toMatchObject({ desired: 'original', displayed: 'optimized', loading: true });
    expect(v.parts.quality.getAttribute('aria-pressed')).toBe('false');
    expect(v.parts.quality.getAttribute('aria-busy')).toBe('true');
    expect(v.shown()[0]).toBe(previous);
    await v.respond(v.last(), { width: 6000, height: 3000 });
    expect(v.content.getState().view).toMatchObject({ mode: 'fit', scale: 1 / 6, contentWidth: 6000 });
    expect(v.parts.quality.getAttribute('aria-pressed')).toBe('true');
    expect(v.live.size).toBe(1);
    fire(v.parts.quality, 'click');
    expect(v.content.getState().quality.displayed).toBe('original');
    await v.respond(v.last(), { width: 2000, height: 1000 });
    expect(v.content.getState().quality).toMatchObject({ displayed: 'optimized', desired: 'optimized' });
    expect(v.live.size).toBe(1);
    v.viewer.close();
    expect(v.live.size).toBe(0);
  });

  it.each(['original', 'optimized'])('keeps the current image after %s HTTP/decode failure and retries explicitly', async (target) => {
    const v = await loadedQuality();
    if (target === 'optimized') {
      v.content.switchQuality('original');
      await v.respond(v.last(), { width: 6000, height: 3000 });
    }
    const image = v.shown()[0];
    v.content.switchQuality(target);
    await v.respond(v.last(), { body: 'not an image' });
    expect(v.shown()[0]).toBe(image);
    expect(v.content.getState().quality).toMatchObject({ loading: false, error: 'decode' });
    const count = v.requests.length;
    await settle();
    expect(v.requests).toHaveLength(count);
    fire(v.parts.quality, 'click');
    expect(v.requests).toHaveLength(count + 1);
    await v.respond(v.last());
    expect(v.content.getState().quality.displayed).toBe(target);
    v.viewer.close();
  });

  it('cancels rapid toggles and retires a delayed decoded original', async () => {
    const v = makeViewer({ holdDecode: true });
    v.viewer.open([qualityItem()]);
    v.last().resolve(imageResponse({ width: 2000, height: 1000 }));
    await settle(); v.decodes[0].resolve(); await settle();
    const image = v.shown()[0];
    v.content.toggleQuality();
    v.last().resolve(imageResponse({ width: 6000, height: 3000 }));
    await settle();
    v.content.toggleQuality();
    expect(v.content.getState().quality).toMatchObject({ desired: 'optimized', displayed: 'optimized', loading: false });
    v.decodes[1].resolve(); await settle();
    expect(v.shown()[0]).toBe(image);
    expect(v.live.size).toBe(1);
    v.viewer.close();
  });

  it('retains Original desire through an ineligible slide and resets on a new session', async () => {
    const v = makeViewer();
    const items = [qualityItem(1), qualityItem(2, { original: false }), qualityItem(3)];
    v.viewer.open(items);
    await v.respond(v.requests[0]);
    v.content.switchQuality('original'); await v.respond(v.last());
    v.viewer.go(2);
    expect(v.last().url).toContain('/2/preview?rendition=optimized');
    await v.respond(v.last());
    expect(v.content.getState().quality).toMatchObject({ desired: 'original', displayed: 'optimized', eligible: false });
    v.viewer.go(3);
    expect(v.last().url).toContain('/3/original?sourceRevision=');
    await v.respond(v.last());
    expect(v.content.getState().quality.displayed).toBe('original');
    v.viewer.close();
    v.viewer.open([qualityItem(3)]);
    expect(v.last().url).toContain('/3/preview?rendition=optimized');
    v.viewer.close();
    expect(v.live.size).toBe(0);
  });

  it.each(['navigate', 'close', 'reopen', 'revision', 'withdraw'])('retires pending source requests on %s', async (action) => {
    const v = makeViewer({ holdDecode: true });
    v.viewer.open([qualityItem(1), qualityItem(2)]);
    v.requests[0].resolve(imageResponse()); await settle(); v.decodes[0].resolve(); await settle();
    v.content.switchQuality('original');
    const old = v.last(); old.resolve(imageResponse({ width: 9000 })); await settle();
    const pending = v.decodes.at(-1);
    if (action === 'navigate') v.viewer.go(2);
    if (action === 'close') v.viewer.close();
    if (action === 'reopen') { v.viewer.close(); v.viewer.open([qualityItem(2)]); }
    if (action === 'revision') v.viewer.update([qualityItem(1, { source: '3333333333333333' })]);
    if (action === 'withdraw') v.viewer.update([qualityItem(1, { original: false })]);
    pending.resolve(); await settle();
    expect(old.aborted).toBe(true);
    expect(v.shown().some((img) => img.naturalWidth === 9000)).toBe(false);
    if (action === 'withdraw') expect(v.parts.quality.hidden).toBe(true);
    if (action !== 'close') v.viewer.close();
    expect(v.live.size).toBe(0);
  });

  it('quarantines a stale 409 without blanking or retrying its URL until authoritative metadata changes', async () => {
    const v = await loadedQuality(); const image = v.shown()[0];
    v.content.switchQuality('original');
    await v.respond(v.last(), { status: 409, type: 'text/plain', body: 'conflict' });
    expect(v.shown()[0]).toBe(image);
    expect(v.content.getState().quality).toMatchObject({ httpStatus: 409, loading: false, eligible: false, displayed: 'optimized' });
    const count = v.requests.length;
    expect(v.content.toggleQuality()).toBe(false);
    v.viewer.update([qualityItem(1, { title: 'Metadata only' })]);
    expect(v.requests).toHaveLength(count);
    v.viewer.update([qualityItem(1, { rendition: '4444444444444444' })]);
    expect(v.requests).toHaveLength(count);
    expect(v.parts.quality.hidden).toBe(true);
    v.viewer.update([qualityItem(1, { source: '3333333333333333' })]);
    expect(v.last().url).toContain('sourceRevision=3333333333333333');
    await v.respond(v.last());
    expect(v.content.getState().quality.displayed).toBe('original');
    v.viewer.close();
  });

  it('keeps an unchanged initial request across metadata refresh and skips a policy-only reload of displayed Original', async () => {
    const v = makeViewer(); v.viewer.open([qualityItem()]); const initial = v.last();
    v.viewer.update([qualityItem(1, { title: 'Metadata' })]);
    expect(v.requests).toHaveLength(1); expect(initial.aborted).toBe(false);
    await v.respond(initial); v.content.switchQuality('original'); await v.respond(v.last());
    const count = v.requests.length;
    v.viewer.update([qualityItem(1, { rendition: '4444444444444444' })]);
    expect(v.requests).toHaveLength(count);
    expect(v.content.getState().quality.displayed).toBe('original');
    v.viewer.close();
  });

  it('bounds a stalled switch, retains the current image and retires late completion', async () => {
    const v = await loadedQuality(); const image = v.shown()[0];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      v.content.switchQuality('original'); const stalled = v.last();
      vi.advanceTimersByTime(30000); await settle();
      expect(stalled.aborted).toBe(true);
      expect(v.shown()[0]).toBe(image);
      expect(v.content.getState().quality).toMatchObject({ loading: false, error: 'network', displayed: 'optimized' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { v.viewer.close(); vi.useRealTimers(); }
  });

  it('preserves a pending request and zoom through a metadata-only refresh without duplicate fetch', async () => {
    const v = await loadedQuality(); v.content.zoomIn();
    const scale = v.content.getState().view.scale;
    v.content.switchQuality('original'); const request = v.last(); const count = v.requests.length;
    v.viewer.update([qualityItem(1, { title: 'Renamed' })]);
    expect(v.requests).toHaveLength(count);
    expect(request.aborted).toBe(false);
    await v.respond(request, { width: 6000, height: 3000 });
    expect(v.content.getState().view.scale).toBeCloseTo(scale / 3);
    v.viewer.close();
  });

  it.each([{ original: false }, { optimized: false }, { imageSources: null }, { available: false }])('hides false choices: %j', async (extra) => {
    const v = makeViewer(); v.viewer.open([qualityItem(1, extra)]);
    if (v.requests.length) await v.respond(v.last());
    expect(v.parts.quality.hidden).toBe(true);
    expect(v.content.toggleQuality()).toBe(false);
    v.viewer.close();
  });
});

// ─── View controls, keys and preload ────────────────────────────────────────

describe('viewer content controls', () => {
  it('never returns focus to secondary controls inside a closed disclosure after Fit', async () => {
    const v = makeViewer();
    v.viewer.open([1]);
    await v.respond(v.last(), { width: 2000, height: 1000 });
    v.content.zoomIn();
    for (const control of [v.parts.zoomOut, v.parts.zoomIn, v.parts.original]) {
      control.getClientRects = () => [];
    }
    v.parts.fit.focus();
    fire(v.parts.fit, 'click');
    expect(v.parts.fit.disabled).toBe(true);
    expect(v.document.activeElement).toBe(v.parts.close);
  });
  it('resets to Fit when navigating and pans with Shift+Arrow only while magnified', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2]);
    await v.respond(v.requests[0], { width: 2000, height: 1000 });
    expect(v.parts.fit.getAttribute('aria-pressed')).toBe('true');
    const plainArrow = fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: false });
    expect(plainArrow.defaultPrevented).toBe(false); // the shell's navigation keeps it
    expect(fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: true }).defaultPrevented).toBe(false);

    fire(v.parts.zoomIn, 'click');
    expect(v.parts.fit.getAttribute('aria-pressed')).toBe('false');
    fire(v.parts.zoomIn, 'click');
    expect(v.parts.zoomLevel.textContent).toBe('100%');
    expect(fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: true }).defaultPrevented).toBe(true);
    expect(v.content.getState().view.panX).toBe(48);
    expect(fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: true, target: { tagName: 'INPUT' } })
      .defaultPrevented).toBe(false);
    expect(fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: true, ctrlKey: true }).defaultPrevented).toBe(false);

    v.viewer.go(2);
    await v.respond(v.last(), { width: 2000, height: 1000 });
    expect(v.content.getState().view).toMatchObject({ mode: 'fit', panX: 0, scale: 0.5 });
    expect(v.parts.fit.getAttribute('aria-pressed')).toBe('true');
  });

  it('moves focus off a zoom control that reaches its limit', async () => {
    const v = makeViewer();
    v.viewer.open([1]);
    await v.respond(v.last(), { width: 2000, height: 1000 });
    v.parts.zoomIn.focus();
    for (let index = 0; index < 20; index += 1) fire(v.parts.zoomIn, 'click');
    expect(v.parts.zoomIn.disabled).toBe(true);
    expect(v.document.activeElement).toBe(v.parts.zoomOut);
  });

  it('preloads at most one available neighbour, in the travel direction, and hands it over', async () => {
    const v = makeViewer();
    v.viewer.open([1, rawItem(2, { mediaUrl: null }), 3, 4]);
    await v.respond(v.requests[0], { width: 100, height: 100 });
    expect(v.fetch).toHaveBeenCalledTimes(2);
    expect(v.last().url).toBe('/projects/7/assets/3/preview?v=r1');
    expect(v.last().init.priority).toBe('low');
    await v.respond(v.last(), { width: 333, height: 100 });
    expect(v.live.size).toBe(2);

    v.viewer.go(3);
    expect(v.content.getState()).toMatchObject({ status: 'loading', key: 'p:7|a:3' });
    await settle();
    expect(v.content.getState()).toMatchObject({ status: 'loaded', width: 333 });
    expect(v.requests.filter((request) => request.url.includes('/3/'))).toHaveLength(1);
    // Next neighbour is 4, and only one preload is ever in flight.
    expect(v.last().url).toBe('/projects/7/assets/4/preview?v=r1');
    expect(v.requests.filter((request) => !request.aborted && request.url.includes('original'))).toHaveLength(0);
  });

  it('cancels and releases the preload when the viewer goes elsewhere or closes', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2, 3]);
    await v.respond(v.requests[0], { width: 100, height: 100 });
    await v.respond(v.last(), { width: 100, height: 100 });
    expect(v.live.size).toBe(2);
    v.viewer.go(3, { wrapped: false });
    expect(v.live.size).toBe(0);
    v.viewer.close();
    expect(v.requests.every((request) => request.aborted || request.url.includes('/1/') || request.url.includes('/2/'))).toBe(true);
    expect(v.live.size).toBe(0);
  });

  it('falls back to a fresh foreground load when an adopted preload failed', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2]);
    await v.respond(v.requests[0], { width: 100, height: 100 });
    const preload = v.last();
    v.viewer.go(2);
    preload.reject(new TypeError('flaky'));
    await settle();
    expect(v.fetch).toHaveBeenCalledTimes(3);
    await v.respond(v.last(), { width: 120, height: 100 });
    expect(v.content.getState()).toMatchObject({ status: 'loaded', width: 120 });
  });

  it('reports media changes to listeners and removes everything on destroy', async () => {
    const v = makeViewer();
    const seen = [];
    const stop = v.content.observe((state, reason) => seen.push(`${reason}:${state.status}`));
    v.viewer.open([1]);
    await v.respond(v.last(), { width: 100, height: 100 });
    expect(seen).toContain('status:loading');
    expect(seen).toContain('status:loaded');
    stop();
    const counts = [v.parts.root, v.parts.zoomIn, v.parts.zoomOut, v.parts.fit, v.parts.original, v.parts.media]
      .map((element) => element.listeners.length);
    expect(counts.every((count) => count > 0)).toBe(true);
    v.content.destroy();
    expect([v.parts.root, v.parts.zoomIn, v.parts.zoomOut, v.parts.fit, v.parts.original, v.parts.media]
      .map((element) => element.listeners.length)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(v.observers.size).toBe(0);
    expect(v.live.size).toBe(0);
  });
});

// ─── C1b: HTTP status and comic page policy ──────────────────────────────────

const COMIC_REVISION = 'a'.repeat(32);

function comicPage(position, extra = {}) {
  return {
    projectId: 7,
    assetId: 40,
    position,
    title: `${String(position).padStart(3, '0')}.jpg`,
    alt: `Page ${position}`,
    mediaUrl: `/projects/7/assets/40/comic/pages/${position}?v=${COMIC_REVISION}`,
    revision: COMIC_REVISION,
    ...extra,
  };
}

// The node of a comic page inside the composition: its slot, image,
// loading panel, failure panel, Retry or unavailable panel.
function pageNode(v, position, part = 'slot') {
  const key = `p:7|a:40|n:${position}`;
  const find = (node, test) => {
    for (const child of node.children) {
      if (test(child)) return child;
      const found = find(child, test);
      if (found) return found;
    }
    return null;
  };
  const tests = {
    slot: (node) => node.getAttribute('data-viewer-spread-slot') === key,
    image: (node) => node.tagName === 'IMG' && node.getAttribute('alt') === `Page ${position}`,
    loading: (node) => node.getAttribute('data-unified-viewer-page-loading') === key,
    failure: (node) => node.getAttribute('data-unified-viewer-page-failure') === key,
    retry: (node) => node.getAttribute('data-unified-viewer-page-retry') === key,
    unavailable: (node) => node.getAttribute('data-unified-viewer-page-unavailable') === key,
  };
  return find(v.parts.media, tests[part]);
}

function openComic(v, positions = [1, 2, 3]) {
  return v.viewer.open(
    positions.map((position) => (typeof position === 'object' ? position : comicPage(position))),
    { kind: 'comic' },
  );
}

describe('viewer image loader HTTP status (C1b)', () => {
  it('keeps the numeric status of an unsuccessful response and never reads its body', async () => {
    const h = makeHarness();
    const deps = { fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img') };
    for (const status of [404, 409, 422, 503]) {
      const pending = loadViewerImage(`/m/${status}`, deps);
      const response = new Response('<html>internal stack trace</html>', {
        status,
        headers: { 'content-type': 'text/plain' },
      });
      const text = vi.spyOn(response, 'text');
      const json = vi.spyOn(response, 'json');
      h.last().resolve(response);
      const error = await pending.catch((caught) => caught);
      expect(error).toMatchObject({ code: VIEWER_MEDIA_ERROR_HTTP, status });
      expect(error.message).toBe('Viewer media http');
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    }
  });

  it('carries no status for network, abort, type and decode failures', async () => {
    expect(new ViewerMediaError(VIEWER_MEDIA_ERROR_NETWORK, { status: 409 }).status).toBeNull();
    expect(new ViewerMediaError(VIEWER_MEDIA_ERROR_HTTP, { status: 'x' }).status).toBeNull();
    expect(new ViewerMediaError(VIEWER_MEDIA_ERROR_HTTP).status).toBeNull();
    const h = makeHarness();
    const deps = { fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img') };
    const network = loadViewerImage('/m/1', deps);
    h.last().reject(new TypeError('Failed to fetch'));
    await expect(network).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_NETWORK, status: null });
    const html = loadViewerImage('/m/2', deps);
    h.last().resolve(new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(html).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_TYPE, status: null });
    const controller = new AbortController();
    const aborted = loadViewerImage('/m/3', { ...deps, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_ABORTED, status: null });
  });

  it('follows redirects for images by default but refuses them when asked', async () => {
    const h = makeHarness();
    const deps = { fetch: h.fetch, urlApi: h.urlApi, createImage: () => h.document.createElement('img') };
    const image = loadViewerImage('/m/1', deps);
    expect(h.last().init.redirect).toBe('follow');
    h.last().resolve(imageResponse({ width: 10, height: 10 }));
    await expect(image).resolves.toMatchObject({ width: 10 });

    const strict = loadViewerImage('/m/2', { ...deps, rejectRedirects: true });
    expect(h.last().init.redirect).toBe('manual');
    h.last().resolve({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null });
    await expect(strict).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_REDIRECTED, status: null });

    const followed = loadViewerImage('/m/3', { ...deps, rejectRedirects: true });
    const response = imageResponse({ width: 10, height: 10 });
    Object.defineProperty(response, 'redirected', { value: true });
    h.last().resolve(response);
    await expect(followed).rejects.toMatchObject({ code: VIEWER_MEDIA_ERROR_REDIRECTED });
    expect(h.live.size).toBe(1);
  });
});

describe('viewer content comic pages (C1b)', () => {
  it('loads only the current page: no neighbour preload, no original, page loading text', async () => {
    const v = makeViewer();
    openComic(v, [1, 2, 3]);
    expect(v.requests).toHaveLength(1);
    expect(v.last().url).toBe(`/projects/7/assets/40/comic/pages/1?v=${COMIC_REVISION}`);
    expect(v.last().init.redirect).toBe('manual');
    // C1e: the page sits in the spread composition's one slot.
    expect(pageNode(v, 1, 'loading').children[1].textContent).toBe('Loading page 1…');
    await v.respond(v.last(), { width: 100, height: 150, type: 'image/jpeg' });
    expect(v.content.getState()).toMatchObject({ status: 'loaded', original: { status: 'none' } });
    expect(v.requests).toHaveLength(1);
    expect(v.parts.original.hidden).toBe(true);
    expect(v.content.showOriginal()).toBe(false);
    expect(v.requests).toHaveLength(1);
  });

  it('keeps an image source preloading its neighbour', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2, 3]);
    expect(v.parts.media.children[0].children[1].textContent).toBe('Loading image…');
    await v.respond(v.requests[0], { width: 100, height: 100 });
    expect(v.requests).toHaveLength(2);
    expect(v.last().init.priority).toBe('low');
    expect(v.requests[0].init.redirect).toBe('follow');
  });

  it('never fetches a manifest-declared unavailable page', () => {
    const v = makeViewer();
    openComic(v, [comicPage(1, { available: false, unavailableReason: 'page-too-large' }), 2]);
    expect(v.requests).toHaveLength(0);
    expect(v.content.getState()).toMatchObject({ status: 'unavailable', key: 'p:7|a:40|n:1' });
  });

  it('shows page-specific failures with explicit Retry and keeps the page for 404, 422 and 503', async () => {
    const cases = [
      [404, 'This page could not be loaded.'],
      [422, 'This page could not be read from the comic.'],
      [503, 'This page is temporarily unavailable. Try again in a moment.'],
    ];
    for (const [status, message] of cases) {
      const conflicts = [];
      const v = makeViewer({ onPageConflict: (conflict) => conflicts.push(conflict) });
      openComic(v, [1, 2]);
      await v.respond(v.last(), { status, type: 'text/plain' });
      expect(v.content.getState()).toMatchObject({
        status: 'failed', error: 'http', httpStatus: status, retryable: true, key: 'p:7|a:40|n:1',
      });
      expect(v.parts.status.textContent).toBe(message);
      expect(conflicts).toEqual([]);
      // Nothing is requested again on its own.
      await settle();
      expect(v.requests).toHaveLength(1);
      fire(pageNode(v, 1, 'retry'), 'click');
      expect(v.requests).toHaveLength(2);
      expect(v.last().url).toBe(v.requests[0].url);
      await v.respond(v.last(), { width: 50, height: 50, type: 'image/png' });
      expect(v.content.getState()).toMatchObject({ status: 'loaded', httpStatus: null, key: 'p:7|a:40|n:1' });
    }
  });

  it('shows the safe failure for network and decode errors with Retry', async () => {
    const v = makeViewer();
    openComic(v, [1]);
    v.last().reject(new TypeError('Failed to fetch'));
    await settle();
    expect(v.content.getState()).toMatchObject({ status: 'failed', error: 'network', httpStatus: null });
    expect(v.parts.status.textContent).toBe('This page could not be loaded.');
    expect(v.content.retry()).toBe(true);
    await v.respond(v.last(), { body: 'not an image', type: 'image/png' });
    expect(v.content.getState()).toMatchObject({ status: 'failed', error: 'decode', attempt: 1 });
    expect(v.live.size).toBe(0);
  });

  it('reports a current comic page 409 once, after showing the failure', async () => {
    const conflicts = [];
    const v = makeViewer({
      onPageConflict: (conflict) => conflicts.push({ ...conflict, status: v.content.getState().status }),
    });
    openComic(v, [1, 2]);
    await v.respond(v.last(), { status: 409, type: 'text/plain' });
    expect(conflicts).toEqual([{
      session: 1,
      key: 'p:7|a:40|n:1',
      revision: COMIC_REVISION,
      mediaUrl: `/projects/7/assets/40/comic/pages/1?v=${COMIC_REVISION}`,
      status: 'failed',
    }]);
    expect(v.content.getState()).toMatchObject({ httpStatus: 409 });
  });

  it('never reports a 409 for an image source or for an obsolete comic attempt', async () => {
    const conflicts = [];
    const v = makeViewer({ onPageConflict: (conflict) => conflicts.push(conflict) });
    v.viewer.open([1]);
    await v.respond(v.last(), { status: 409, type: 'text/plain' });
    expect(v.content.getState()).toMatchObject({ status: 'failed', httpStatus: 409 });
    expect(v.parts.status.textContent).toBe('Image source changed. Refresh this view to load current source information.');

    openComic(v, [1, 2]);
    const stale = v.last();
    v.viewer.close();
    stale.resolve(new Response('', { status: 409 }));
    await settle();
    expect(conflicts).toEqual([]);
    expect(v.content.getState().status).toBe('idle');
  });
});

describe('viewer content Retry focus (C1b)', () => {
  it('keeps focus in the viewer when a focused Retry is replaced by the loading panel', async () => {
    const v = makeViewer();
    v.viewer.open([1]);
    await v.respond(v.last(), { status: 503, type: 'text/plain' });
    const retry = v.parts.media.querySelector('[data-unified-viewer-retry]');
    retry.focus();
    fire(retry, 'click');
    expect(v.content.getState().status).toBe('loading');
    expect(v.document.activeElement).toBe(v.parts.close);
  });
});

// ─── C1e: dual-page comic media ──────────────────────────────────────────────

const COMIC_REVISION_B = 'b'.repeat(32);

// Drives the content participant with the controller's comic change shape,
// including the C1c reader snapshot (resolveComicPageGroup).
function comicDriver(v) {
  let sessions = 100;
  let state = null;
  const snapshot = () => {
    const group = resolveComicPageGroup(state.source, state.key, state.reader);
    if (!group) return null;
    return Object.freeze({
      ...state.reader,
      anchorKey: group.anchorKey,
      anchorPosition: group.anchorPosition,
      groupKeys: group.keys,
      groupItems: group.items,
      visibleItems: group.visibleItems,
      label: group.label,
    });
  };
  const send = (type, extra = {}) => {
    const item = state.key ? getViewerItem(state.source, state.key) : null;
    const change = Object.freeze({
      type,
      session: state.session,
      source: state.source,
      key: item ? item.key : null,
      index: findViewerItemIndex(state.source, state.key),
      count: state.source.items.length,
      item,
      previousKey: null,
      reload: false,
      preserveView: false,
      reason: null,
      reader: snapshot(),
      ...extra,
    });
    v.observers.forEach((listener) => listener(change));
    return change;
  };
  const source = (positions, revision = COMIC_REVISION) => createViewerSource({
    key: 'comic:7:40',
    kind: 'comic',
    items: positions.map((position) => {
      if (typeof position === 'object') return position;
      return comicPage(position, {
        revision,
        mediaUrl: `/projects/7/assets/40/comic/pages/${position}?v=${revision}`,
      });
    }),
  });
  const keyAt = (position) => `p:7|a:40|n:${position}`;
  return {
    get state() { return state; },
    keyAt,
    open(positions = [1, 2, 3, 4, 5, 6, 7], reader = {}, at = 1) {
      sessions += 1;
      const built = source(positions);
      state = { session: sessions, source: built, key: keyAt(at), reader: normalizeComicReaderOptions(reader) };
      return send('open', { reload: true });
    },
    go(position) {
      const previousKey = state.key;
      state.key = keyAt(position);
      return send('navigate', { previousKey, reload: true });
    },
    step(direction) {
      const result = stepComicPageGroup(state.source, state.key, direction, state.reader);
      if (result.moved) {
        const previousKey = state.key;
        state.key = result.key;
        send('navigate', { previousKey, reload: true });
      }
      return result;
    },
    options(patch) {
      state.reader = normalizeComicReaderOptions(patch, state.reader);
      return send('reader', { previousKey: state.key, preserveView: true, reason: 'reader-options' });
    },
    retire(reason = 'conflict') {
      const previousKey = state.key;
      state.source = createViewerSource({ key: 'comic:7:40', kind: 'comic', items: [] });
      state.key = null;
      return send('update', { previousKey, reload: true, reason, outcome: 'retired' });
    },
    publish(positions, revision) {
      state.source = source(positions, revision);
      state.key = state.source.items[0]?.key || null;
      return send('update', { reload: true, reason: 'manifest', outcome: 'published' });
    },
    close() {
      send('close', { reason: 'closed' });
      state = null;
    },
  };
}

const positionOf = (key) => Number(String(key).split('n:')[1]);
const spreadOf = (v) => v.parts.media.children.find((child) => child.getAttribute('data-viewer-content') === 'spread') || null;
// Slot positions in visual left-to-right order.
const visualOrder = (v) => (spreadOf(v)?.children || [])
  .slice()
  .sort((a, b) => Number(a.getAttribute('data-viewer-spread-index')) - Number(b.getAttribute('data-viewer-spread-index')))
  .map((slot) => positionOf(slot.getAttribute('data-viewer-spread-slot')));
const pageUrlOf = (position, revision = COMIC_REVISION) => `/projects/7/assets/40/comic/pages/${position}?v=${revision}`;
const urls = (v) => v.requests.map((request) => request.url);
const pageStatuses = (v) => v.content.getState().pages.map((page) => `${page.position}:${page.status}`);

// A fetch that ignores aborts: the attempt settles only when the test says.
function holdAborts(v) {
  v.fetch.mockImplementation((url, init) => {
    const request = { url, init, ...deferred(), aborted: false };
    init.signal?.addEventListener('abort', () => { request.aborted = true; });
    v.requests.push(request);
    return request.promise;
  });
}

describe('viewer content comic spreads (C1e)', () => {
  it('loads both pages of a spread independently, in either completion order', async () => {
    for (const firstDone of [2, 3]) {
      const v = makeViewer();
      const d = comicDriver(v);
      d.open(undefined, { layout: 'spread' }, 2);
      expect(urls(v)).toEqual([pageUrlOf(2), pageUrlOf(3)]);
      expect(v.requests.every((request) => request.init.redirect === 'manual')).toBe(true);
      expect(pageStatuses(v)).toEqual(['2:loading', '3:loading']);
      expect(v.content.getState()).toMatchObject({ status: 'loading', key: d.keyAt(2), composite: true, pageRequests: 2 });
      expect(pageNode(v, 2, 'loading').children[1].textContent).toBe('Loading page 2…');
      expect(pageNode(v, 3, 'loading').children[1].textContent).toBe('Loading page 3…');
      expect(pageNode(v, 2).getAttribute('aria-label')).toBe('Page 2');
      expect(pageNode(v, 3).getAttribute('aria-label')).toBe('Page 3');
      expect(v.parts.media.getAttribute('aria-busy')).toBe('true');
      // Two touching fallback slots, already in the shared viewport.
      expect(v.content.getState().view).toMatchObject({ hasContent: true, composite: true, contentWidth: 2000, contentHeight: 1500 });
      expect(v.parts.viewTools.hidden).toBe(true);

      const first = v.requests[firstDone - 2];
      const second = v.requests[firstDone === 2 ? 1 : 0];
      const other = firstDone === 2 ? 3 : 2;
      await v.respond(first, { width: 800, height: 1200, type: 'image/jpeg' });
      expect(v.content.getState().status).toBe('loaded');
      expect(pageNode(v, firstDone, 'image')).toBeTruthy();
      expect(pageNode(v, other, 'loading')).toBeTruthy();
      expect(pageNode(v, firstDone).getAttribute('data-viewer-spread-state')).toBe('loaded');
      expect(pageNode(v, other).getAttribute('data-viewer-spread-state')).toBe('pending');
      expect(v.parts.viewTools.hidden).toBe(false);
      expect(v.parts.media.getAttribute('aria-busy')).toBe(null);
      expect(v.content.getState().view).toMatchObject({ mode: 'fit', contentWidth: 1600, contentHeight: 1200 });
      const image = pageNode(v, firstDone, 'image');

      await v.respond(second, { width: 1000, height: 700, type: 'image/png' });
      expect(pageStatuses(v)).toEqual(['2:loaded', '3:loaded']);
      expect(pageNode(v, firstDone, 'image')).toBe(image);
      // Slots grow to the widest and tallest page; neither page is stretched.
      expect(v.content.getState()).toMatchObject({ width: 2000, height: 1200 });
      expect(v.content.getState().view).toMatchObject({ mode: 'fit', panX: 0, panY: 0, contentWidth: 2000 });
      expect(v.requests).toHaveLength(2);
      expect(v.live.size).toBe(2);
      expect(v.content.getState().pageRequests).toBe(0);
    }
  });

  it('places the earlier page on the left for LTR and on the right for RTL', () => {
    for (const [direction, order] of [['ltr', [2, 3]], ['rtl', [3, 2]]]) {
      const v = makeViewer();
      const d = comicDriver(v);
      d.open(undefined, { layout: 'spread', direction }, 3);
      expect(visualOrder(v)).toEqual(order);
      // DOM order stays canonical; requests start with the anchor.
      expect(spreadOf(v).children.map((slot) => positionOf(slot.getAttribute('data-viewer-spread-slot')))).toEqual([2, 3]);
      expect(urls(v)).toEqual([pageUrlOf(3), pageUrlOf(2)]);
    }
  });

  it('shows manifest-unavailable pages in place without requesting them', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open([comicPage(1, { available: false, unavailableReason: 'page-too-large' }), 2, 3, comicPage(4, { available: false }), 5],
      { layout: 'spread', alignment: 'pair-from-first' });
    expect(urls(v)).toEqual([pageUrlOf(2)]);
    expect(pageNode(v, 1, 'unavailable').children[0].textContent).toBe('Page 1 is unavailable.');
    expect(pageNode(v, 1).getAttribute('data-viewer-spread-state')).toBe('unavailable');
    expect(v.parts.status.textContent).toBe('Page 1 is unavailable.');
    await v.respond(v.last(), { width: 500, height: 700 });
    expect(pageStatuses(v)).toEqual(['1:unavailable', '2:loaded']);
    expect(v.content.getState()).toMatchObject({ status: 'loaded', key: d.keyAt(1) });

    d.step('next');
    expect(urls(v).slice(1)).toEqual([pageUrlOf(3)]);
    expect(pageStatuses(v)).toEqual(['3:loading', '4:unavailable']);
    expect(v.parts.status.textContent).toBe('Page 4 is unavailable.');

    // A single unavailable page keeps C1b's message and no request.
    const single = makeViewer();
    comicDriver(single).open([comicPage(1, { available: false }), 2]);
    expect(single.requests).toHaveLength(0);
    expect(single.content.getState()).toMatchObject({ status: 'unavailable', key: 'p:7|a:40|n:1' });
    expect(single.parts.status.textContent).toBe('Page unavailable.');
    expect(pageNode(single, 1, 'unavailable')).toBeTruthy();
  });

  it('keeps a loaded neighbour when the other page fails, with page-named errors and Retry', async () => {
    const cases = [
      [404, 'could not be loaded.'],
      [422, 'could not be read from the comic.'],
      [503, 'is temporarily unavailable. Try again in a moment.'],
      ['network', 'could not be loaded.'],
      ['decode', 'could not be loaded.'],
    ];
    for (const failing of [2, 3]) {
      for (const [kind, message] of cases) {
        const conflicts = [];
        const v = makeViewer({ onPageConflict: (conflict) => conflicts.push(conflict) });
        const d = comicDriver(v);
        d.open(undefined, { layout: 'spread' }, 2);
        const loaded = failing === 2 ? 3 : 2;
        const [failRequest, okRequest] = failing === 2 ? [v.requests[0], v.requests[1]] : [v.requests[1], v.requests[0]];
        await v.respond(okRequest, { width: 600, height: 900 });
        const image = pageNode(v, loaded, 'image');
        if (kind === 'network') {
          failRequest.reject(new TypeError('Failed to fetch'));
          await settle();
        } else if (kind === 'decode') {
          await v.respond(failRequest, { body: 'not an image', type: 'image/png' });
        } else {
          await v.respond(failRequest, { status: kind, type: 'text/html', body: '<b>stack</b>' });
        }
        const text = `Page ${failing} ${message}`;
        expect(pageNode(v, failing, 'failure').children[0].textContent).toBe(text);
        expect(v.parts.status.textContent).toBe(text);
        expect(v.parts.status.textContent).not.toContain('stack');
        expect(v.content.getState()).toMatchObject({ status: 'loaded', retryable: true });
        expect(v.content.getState().pages.find((page) => page.position === failing)).toMatchObject({
          status: 'failed', retryable: true, httpStatus: typeof kind === 'number' ? kind : null,
        });
        const retry = pageNode(v, failing, 'retry');
        expect(retry.getAttribute('aria-label')).toBe(`Retry page ${failing}`);
        expect(retry.textContent).toBe('Retry');
        expect(pageNode(v, loaded, 'image')).toBe(image);
        expect(pageNode(v, failing).getAttribute('data-viewer-spread-state')).toBe('failed');
        // Nothing retries on its own, and nothing was reported as a conflict.
        await settle();
        expect(v.requests).toHaveLength(2);
        expect(conflicts).toEqual([]);

        retry.focus();
        fire(retry, 'click');
        fire(retry, 'click');
        expect(v.requests).toHaveLength(3);
        expect(v.last().url).toBe(pageUrlOf(failing));
        // The replaced Retry hands focus to a connected fallback.
        expect(v.document.activeElement).toBe(v.parts.close);
        expect(v.parts.status.textContent).toBe('');
        await v.respond(v.last(), { width: 600, height: 900 });
        expect(pageStatuses(v)).toEqual(['2:loaded', '3:loaded']);
        expect(pageNode(v, loaded, 'image')).toBe(image);
        expect(v.content.getState().pages.find((page) => page.position === failing).attempt).toBe(1);
        expect(v.live.size).toBe(2);
      }
    }
  });

  it('retries one page through the API, ignores obsolete references and keeps the source Retry apart', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    await v.respond(v.requests[0], { status: 503, type: 'text/plain' });
    await v.respond(v.requests[1], { status: 404, type: 'text/plain' });
    expect(v.content.getState()).toMatchObject({ status: 'failed', error: 'http', httpStatus: 503 });
    expect(v.parts.status.textContent).toBe(
      'Page 2 is temporarily unavailable. Try again in a moment. Page 3 could not be loaded.',
    );
    // The image-level Retry panel is never shown for a comic.
    expect(v.parts.media.querySelector('[data-unified-viewer-retry]')).toBe(null);
    const staleRetry = pageNode(v, 3, 'retry');
    expect(v.content.retry(d.keyAt(3))).toBe(true);
    expect(v.content.retry(d.keyAt(3))).toBe(false);
    expect(urls(v).slice(2)).toEqual([pageUrlOf(3)]);
    expect(pageStatuses(v)).toEqual(['2:failed', '3:loading']);
    expect(v.content.retry(d.keyAt(5))).toBe(false);

    d.step('next');
    await settle();
    const requests = v.requests.length;
    fire(staleRetry, 'click');
    expect(v.content.retry(d.keyAt(2))).toBe(false);
    expect(v.requests).toHaveLength(requests);
    // Without a key, every failed shown page is retried once.
    await v.respond(v.requests.find((request) => request.url === pageUrlOf(4)), { status: 503, type: 'text/plain' });
    await v.respond(v.requests.find((request) => request.url === pageUrlOf(5)), { status: 503, type: 'text/plain' });
    expect(v.content.retry()).toBe(true);
    expect(urls(v).slice(-2)).toEqual([pageUrlOf(4), pageUrlOf(5)]);
  });

  it('changes direction with no request, the same elements, and the same zoom and pan', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    await v.respond(v.requests[0], { width: 800, height: 1200 });
    await v.respond(v.requests[1], { status: 503, type: 'text/plain' });
    v.content.zoomIn();
    fire(v.parts.root, 'keydown', { key: 'ArrowRight', shiftKey: true });
    const view = v.content.getState().view;
    expect(view.mode).toBe('zoom');
    const image = pageNode(v, 2, 'image');
    const slots = spreadOf(v).children.slice();
    const retry = pageNode(v, 3, 'retry');
    retry.focus();
    const created = v.urlApi.createObjectURL.mock.calls.length;

    d.options({ direction: 'rtl' });
    expect(visualOrder(v)).toEqual([3, 2]);
    expect(v.requests).toHaveLength(2);
    expect(v.urlApi.createObjectURL.mock.calls.length).toBe(created);
    expect(pageNode(v, 2, 'image')).toBe(image);
    expect(spreadOf(v).children).toEqual(slots);
    expect(pageNode(v, 3, 'retry')).toBe(retry);
    expect(v.document.activeElement).toBe(retry);
    expect(v.content.getState().view).toEqual(view);
    d.options({ direction: 'ltr' });
    expect(visualOrder(v)).toEqual([2, 3]);
    expect(v.content.getState().view).toEqual(view);
  });

  it('reuses the anchor between Single and Spread and the overlap across alignments', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open(undefined, {}, 3);
    expect(urls(v)).toEqual([pageUrlOf(3)]);
    await v.respond(v.last(), { width: 800, height: 1200 });
    const page3 = pageNode(v, 3, 'image');

    // Single → Spread [2,3]: page 3 is kept, page 2 is the only request.
    d.options({ layout: 'spread' });
    expect(urls(v)).toEqual([pageUrlOf(3), pageUrlOf(2)]);
    expect(pageNode(v, 3, 'image')).toBe(page3);
    await v.respond(v.last(), { width: 800, height: 1200 });
    const page2 = pageNode(v, 2, 'image');
    expect(v.live.size).toBe(2);

    // Cover Alone [2,3] → Pair from Page 1 [3,4]: 3 kept, 2 released, 4 loaded.
    d.options({ alignment: 'pair-from-first' });
    expect(urls(v).slice(2)).toEqual([pageUrlOf(4)]);
    expect(pageNode(v, 3, 'image')).toBe(page3);
    expect(page2.parentNode).toBe(null);
    expect(page2.getAttribute('src')).toBe(null);
    expect(v.live.size).toBe(1);
    expect(v.content.getState().view.mode).toBe('fit');

    // Spread → Single: the anchor stays, the pending companion is cancelled.
    d.options({ layout: 'single' });
    expect(v.last().aborted).toBe(true);
    expect(pageStatuses(v)).toEqual(['3:loaded']);
    expect(pageNode(v, 3, 'image')).toBe(page3);
    expect(v.requests).toHaveLength(3);
    expect(v.content.getState()).toMatchObject({ key: d.keyAt(3), status: 'loaded', width: 800, height: 1200 });
    expect(v.parts.status.textContent).toBe('');
    // Options that leave the group alone change nothing.
    d.options({ alignment: 'cover-alone' });
    expect(v.requests).toHaveLength(3);
    expect(pageNode(v, 3, 'image')).toBe(page3);
  });

  it('releases the previous group on navigation and loads only the new group', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    await v.respond(v.requests[0], { width: 800, height: 1200 });
    await v.respond(v.requests[1], { width: 800, height: 1200 });
    const old = [pageNode(v, 2, 'image'), pageNode(v, 3, 'image')];
    v.content.zoomIn();
    d.step('next');
    expect(old.every((image) => image.parentNode === null && image.getAttribute('src') === null)).toBe(true);
    expect(v.live.size).toBe(0);
    expect(urls(v).slice(2)).toEqual([pageUrlOf(4), pageUrlOf(5)]);
    expect(pageStatuses(v)).toEqual(['4:loading', '5:loading']);
    // A new group starts in Fit.
    expect(v.content.getState().view.mode).toBe('fit');
    d.step('previous');
    expect(v.requests).toHaveLength(4);
    await settle();
    expect(urls(v).slice(4)).toEqual([pageUrlOf(2), pageUrlOf(3)]);
    expect(v.requests[2].aborted && v.requests[3].aborted).toBe(true);
  });

  it('keeps at most two attempts, counting aborted ones until they settle, and loads only the newest group', async () => {
    const v = makeViewer();
    holdAborts(v);
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    expect(urls(v)).toEqual([pageUrlOf(2), pageUrlOf(3)]);
    for (let index = 0; index < 6; index += 1) {
      d.step(index % 2 ? 'previous' : 'next');
      d.step('next');
    }
    expect(d.state.key).toBe(d.keyAt(6));
    // Both slots are still held by the aborted-but-unsettled attempts.
    expect(v.requests).toHaveLength(2);
    expect(v.requests.every((request) => request.aborted)).toBe(true);
    expect(v.content.getState()).toMatchObject({ pageRequests: 2 });
    expect(pageStatuses(v)).toEqual(['6:loading', '7:loading']);

    // One old attempt completes late: its result is released, page 6 starts.
    await v.respond(v.requests[0], { width: 10, height: 10 });
    expect(v.live.size).toBe(0);
    expect(urls(v).slice(2)).toEqual([pageUrlOf(6)]);
    expect(v.content.getState().pageRequests).toBe(2);
    v.requests[1].reject(new DOMException('Aborted', 'AbortError'));
    await settle();
    expect(urls(v).slice(2)).toEqual([pageUrlOf(6), pageUrlOf(7)]);
    expect(pageStatuses(v)).toEqual(['6:loading', '7:loading']);
    await v.respond(v.requests[2], { width: 600, height: 900 });
    await v.respond(v.requests[3], { width: 600, height: 900 });
    expect(pageStatuses(v)).toEqual(['6:loaded', '7:loaded']);
    expect(v.live.size).toBe(2);
    expect(v.content.getState().pageRequests).toBe(0);
  });

  it('never installs a stale decode after navigation, replacement or close', async () => {
    const v = makeViewer({ holdDecode: true });
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    await v.respond(v.requests[0], { width: 600, height: 900 });
    expect(v.decodes).toHaveLength(1);
    d.step('next');
    v.decodes[0].resolve();
    await settle();
    expect(pageNode(v, 2, 'image')).toBe(null);
    expect(v.live.size).toBe(0);

    d.publish([1, 2, 3], COMIC_REVISION_B);
    // The cancelled [4,5] attempts settle before page 1 may start.
    await settle();
    expect(v.last().url).toBe(pageUrlOf(1, COMIC_REVISION_B));
    await v.respond(v.last(), { width: 600, height: 900 });
    expect(v.live.size).toBe(1);
    d.close();
    v.decodes.forEach((gate) => gate.resolve());
    await settle();
    expect(v.live.size).toBe(0);
    expect(v.content.getState().status).toBe('idle');
    expect(v.parts.media.children).toHaveLength(0);
  });

  it('re-fits when a companion resolves in Fit and keeps the zoom relative to Fit otherwise', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    await v.respond(v.requests[0], { width: 800, height: 1200 });
    const fitBefore = v.content.getState().view;
    expect(fitBefore).toMatchObject({ mode: 'fit', contentWidth: 1600 });
    await v.respond(v.requests[1], { width: 1200, height: 800 });
    const fitAfter = v.content.getState().view;
    expect(fitAfter).toMatchObject({ mode: 'fit', panX: 0, panY: 0, contentWidth: 2400, contentHeight: 1200 });
    expect(fitAfter.scale).toBeCloseTo(Math.min(1000 / 2400, 800 / 1200));

    // Zoomed and panned before the companion arrives.
    d.step('next');
    await settle();
    await v.respond(v.requests.find((request) => request.url === pageUrlOf(4)), { width: 800, height: 1200 });
    v.content.zoomIn();
    v.content.zoomIn();
    fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: true });
    fire(v.parts.root, 'keydown', { key: 'ArrowUp', shiftKey: true });
    const zoomed = v.content.getState().view;
    const relative = zoomed.scale / zoomed.fitScale;
    await v.respond(v.requests.find((request) => request.url === pageUrlOf(5)), { width: 1200, height: 800 });
    const resized = v.content.getState().view;
    expect(resized.mode).toBe('zoom');
    expect(resized.scale / resized.fitScale).toBeCloseTo(relative);
    expect(Math.abs(resized.panX)).toBeLessThanOrEqual(resized.maxPanX);
    expect(Math.abs(resized.panY)).toBeLessThanOrEqual(resized.maxPanY);
    expect(resized.panX).toBeGreaterThan(0);
  });

  it('a press on a page Retry never starts a pan', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    await v.respond(v.requests[0], { width: 800, height: 1200 });
    await v.respond(v.requests[1], { status: 503, type: 'text/plain' });
    v.content.zoomIn();
    v.content.zoomIn();
    expect(v.content.getState().view.canPan).toBe(true);
    const retry = pageNode(v, 3, 'retry');
    const press = fire(v.parts.media, 'pointerdown', { target: retry, button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    expect(press.defaultPrevented).toBe(false);
    expect(v.parts.media.hasAttribute('data-viewer-dragging')).toBe(false);
    const image = pageNode(v, 2, 'image');
    const drag = fire(v.parts.media, 'pointerdown', { target: image, button: 0, pointerId: 2, clientX: 5, clientY: 5 });
    expect(drag.defaultPrevented).toBe(true);
    expect(v.parts.media.hasAttribute('data-viewer-dragging')).toBe(true);
  });

  it('reports a 409 from either spread page once, and retirement releases both pages', async () => {
    for (const conflicting of [2, 3, 'both']) {
      const conflicts = [];
      const v = makeViewer({
        onPageConflict: (conflict) => {
          conflicts.push(conflict);
          if (conflicting !== 'both') d.retire();
        },
      });
      const d = comicDriver(v);
      d.open(undefined, { layout: 'spread' }, 2);
      if (conflicting === 'both') {
        await v.respond(v.requests[0], { status: 409, type: 'text/plain' });
        await v.respond(v.requests[1], { status: 409, type: 'text/plain' });
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ key: d.keyAt(2), revision: COMIC_REVISION, mediaUrl: pageUrlOf(2) });
        continue;
      }
      const other = conflicting === 2 ? 3 : 2;
      await v.respond(v.requests[other - 2], { width: 800, height: 1200 });
      const image = pageNode(v, other, 'image');
      expect(v.live.size).toBe(1);
      await v.respond(v.requests[conflicting - 2], { status: 409, type: 'text/plain' });
      expect(conflicts).toEqual([{
        session: d.state.session, key: d.keyAt(conflicting), revision: COMIC_REVISION, mediaUrl: pageUrlOf(conflicting),
      }]);
      expect(v.live.size).toBe(0);
      expect(image.parentNode).toBe(null);
      expect(spreadOf(v)).toBe(null);
      expect(v.content.getState()).toMatchObject({ status: 'idle', pages: [], pageRequests: 0, composite: false });
      expect(v.content.getState().view.hasContent).toBe(false);
      expect(v.parts.media.hasAttribute('data-viewer-composite')).toBe(false);
      await settle();
      expect(v.requests).toHaveLength(2);

      // The replacement revision starts again at page 1, keeping the options.
      d.publish([1, 2, 3, 4], COMIC_REVISION_B);
      expect(urls(v).slice(2)).toEqual([pageUrlOf(1, COMIC_REVISION_B)]);
      d.step('next');
      await settle();
      expect(urls(v).slice(3)).toEqual([pageUrlOf(2, COMIC_REVISION_B), pageUrlOf(3, COMIC_REVISION_B)]);
    }
  });

  it.each([1, 2])('preserves focused Retry page %s until the controller begins retirement', async (position) => {
    let retry;
    let notifications = 0;
    const v = makeViewer({
      onPageConflict: () => {
        notifications += 1;
        expect(v.document.activeElement).toBe(retry);
        expect(v.document.contains(retry)).toBe(true);
        d.retire();
        expect(v.document.contains(retry)).toBe(false);
        // The controller owns recovery after this cleanup and panel replacement.
        expect(v.document.activeElement).toBe(v.document.body);
      },
    });
    const d = comicDriver(v);
    d.open([1, 2], { layout: 'spread', alignment: 'pair-from-first' });
    await v.respond(v.requests[position - 1], { status: 503, type: 'text/plain' });
    retry = pageNode(v, position, 'retry');
    retry.focus();
    const focus = vi.spyOn(retry, 'focus');
    await v.respond(v.requests[position === 1 ? 1 : 0], { status: 409, type: 'text/plain' });
    expect(notifications).toBe(1);
    expect(focus).not.toHaveBeenCalled();
    expect(v.content.getState()).toMatchObject({ status: 'idle', pages: [], pageRequests: 0 });
    expect(v.live.size).toBe(0);
    expect(v.requests).toHaveLength(2);
  });

  it('ignores a 409 from an obsolete attempt', async () => {
    const conflicts = [];
    const v = makeViewer({ onPageConflict: (conflict) => conflicts.push(conflict) });
    holdAborts(v);
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    const old = v.requests.slice();
    d.step('next');
    await v.respond(old[0], { status: 409, type: 'text/plain' });
    await v.respond(old[1], { status: 409, type: 'text/plain' });
    expect(conflicts).toEqual([]);
    expect(pageStatuses(v)).toEqual(['4:loading', '5:loading']);
    // A new revision is never matched against an old revision's pages.
    await v.respond(v.requests[2], { width: 600, height: 900 });
    const image = pageNode(v, 4, 'image');
    d.publish([1, 2, 3, 4, 5], COMIC_REVISION_B);
    expect(image.parentNode).toBe(null);
    expect(v.live.size).toBe(0);
    expect(v.last().url).toBe(pageUrlOf(1, COMIC_REVISION_B));
  });

  it('cleans up on close, destroy and replacement, leaving the media region usable for images', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open(undefined, { layout: 'spread' }, 2);
    await v.respond(v.requests[0], { width: 800, height: 1200 });
    d.close();
    expect(v.requests[1].aborted).toBe(true);
    expect(v.live.size).toBe(0);
    expect(v.parts.media.children).toHaveLength(0);
    expect(v.parts.media.hasAttribute('data-viewer-composite')).toBe(false);

    // An image source after a comic uses the established single-image path.
    v.viewer.open([1, 2]);
    await v.respond(v.requests[2], { width: 400, height: 300 });
    expect(v.parts.media.children).toHaveLength(1);
    expect(v.parts.media.children[0].getAttribute('class')).toBe('unified-viewer-image');
    expect(v.content.getState()).toMatchObject({ status: 'loaded', composite: false, pages: [], width: 400 });
    expect(v.content.getState().view.composite).toBe(false);
    // ...and its neighbour preload.
    expect(v.last().init.priority).toBe('low');

    // A comic replacing the image ends it; destroy releases the comic.
    d.open(undefined, { layout: 'spread' }, 4);
    expect(v.live.size).toBe(0);
    await v.respond(v.requests.find((request) => request.url === pageUrlOf(4)), { width: 800, height: 1200 });
    expect(v.live.size).toBe(1);
    v.content.destroy();
    expect(v.live.size).toBe(0);
    expect(v.requests.filter((request) => request.url === pageUrlOf(5)).every((request) => request.aborted)).toBe(true);
  });

  it('shows a one-page comic as one slot in either layout and an empty comic as nothing', async () => {
    const v = makeViewer();
    const d = comicDriver(v);
    d.open([1], { layout: 'spread', alignment: 'pair-from-first' });
    expect(urls(v)).toEqual([pageUrlOf(1)]);
    await v.respond(v.last(), { width: 640, height: 960 });
    expect(visualOrder(v)).toEqual([1]);
    expect(v.content.getState()).toMatchObject({ status: 'loaded', width: 640, height: 960 });
    expect(v.content.getState().view).toMatchObject({ contentWidth: 640, contentHeight: 960 });
    expect(v.content.showOriginal()).toBe(false);
    expect(v.parts.original.hidden).toBe(true);

    d.retire('manifest');
    expect(v.content.getState()).toMatchObject({ status: 'idle', key: null });
    expect(v.parts.media.children).toHaveLength(0);
    expect(v.live.size).toBe(0);
  });
});
