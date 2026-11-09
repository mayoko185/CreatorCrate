import { describe, expect, it, vi } from 'vitest';
import {
  createViewerContent,
  loadViewerImage,
  viewerImageContentType,
  VIEWER_MEDIA_ERROR_ABORTED,
  VIEWER_MEDIA_ERROR_DECODE,
  VIEWER_MEDIA_ERROR_HTTP,
  VIEWER_MEDIA_ERROR_NETWORK,
  VIEWER_MEDIA_ERROR_TYPE,
} from '../src/static/client/viewer-content.js';
import {
  createViewerSource,
  findViewerItemIndex,
  getViewerItem,
  reconcileViewerSource,
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
    replaceChildren(...nodes) {
      element.children.slice().forEach((child) => child.remove());
      nodes.forEach((node) => element.appendChild(node));
    },
    remove() {
      const parent = element.parentNode;
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
    parts: { root, media, status, viewTools, zoomOut, zoomIn, zoomLevel, fit, original, close },
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

// ─── Original-size inspection ───────────────────────────────────────────────

describe('viewer content original size', () => {
  async function loadedSingle(item = rawItem(1)) {
    const v = makeViewer();
    v.viewer.open([item]);
    await v.respond(v.last(), { width: 1600, height: 1200 });
    return v;
  }

  it('loads the original only on explicit activation, at 1:1, keeping the preview until decoded', async () => {
    const v = await loadedSingle();
    expect(v.fetch).toHaveBeenCalledTimes(1);
    expect(v.content.getState().original.status).toBe('available');

    fire(v.parts.original, 'click');
    expect(v.fetch).toHaveBeenCalledTimes(2);
    expect(v.last().url).toBe('/projects/7/assets/1/original');
    expect(v.parts.status.textContent).toBe('Loading original size…');
    expect(v.parts.original.disabled).toBe(true);
    expect(v.shown()).toHaveLength(1);
    expect(v.shown()[0].getAttribute('data-viewer-content')).toBe('preview');

    await v.respond(v.last(), { width: 6000, height: 4000, type: 'image/png' });
    const shown = v.shown();
    expect(shown).toHaveLength(1);
    expect(shown[0].getAttribute('data-viewer-content')).toBe('original');
    expect(v.content.getState().original).toEqual({ status: 'active', width: 6000, height: 4000 });
    expect(v.content.getState().view).toMatchObject({ scale: 1, contentWidth: 6000, maxPanX: 2500, maxPanY: 1600 });
    expect(shown[0].style.width).toBe('6000px');
    expect(v.parts.status.textContent).toBe('Showing original size, 6000 × 4000 pixels.');
    expect(v.parts.zoomLevel.textContent).toBe('100%');
  });

  it('returns to Fit on the original and reuses it without fetching again', async () => {
    const v = await loadedSingle();
    v.content.showOriginal();
    await v.respond(v.last(), { width: 6000, height: 4000 });
    fire(v.parts.fit, 'click');
    expect(v.content.getState().view).toMatchObject({ mode: 'fit', contentWidth: 6000 });
    expect(v.parts.status.textContent).toBe('');
    expect(v.parts.original.disabled).toBe(false);
    v.content.showOriginal();
    expect(v.fetch).toHaveBeenCalledTimes(2);
    expect(v.content.getState().view.scale).toBe(1);
  });

  it('keeps the fitted preview with a non-destructive message when the original fails', async () => {
    const v = await loadedSingle();
    v.content.showOriginal();
    await v.respond(v.last(), { status: 415, type: 'text/plain', body: 'Unsupported' });
    expect(v.content.getState()).toMatchObject({ status: 'loaded', original: { status: 'failed' } });
    expect(v.shown()).toHaveLength(1);
    expect(v.shown()[0].getAttribute('data-viewer-content')).toBe('preview');
    expect(v.content.getState().view).toMatchObject({ mode: 'fit', contentWidth: 1600 });
    expect(v.parts.status.textContent).toBe('The original could not be loaded. Showing the fitted image.');
    expect(v.parts.original.disabled).toBe(false);
    expect(v.live.size).toBe(1);
  });

  it('cancels the original on navigation and on close, releasing it', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2]);
    await v.respond(v.requests[0], { width: 1600, height: 1200 });
    const preload = v.last();
    v.content.showOriginal();
    expect(preload.aborted).toBe(true); // the neighbour preload yields to the original
    const original = v.last();
    v.viewer.go(2);
    expect(original.aborted).toBe(true);
    await v.respond(v.last(), { width: 100, height: 100 });

    v.content.showOriginal();
    await v.respond(v.last(), { width: 500, height: 500 });
    expect(v.live.size).toBe(2);
    v.viewer.close();
    expect(v.live.size).toBe(0);
  });

  it('drops a shown original when a refresh removes its URL, falling back to the fitted preview', async () => {
    const v = await loadedSingle();
    v.content.showOriginal();
    await v.respond(v.last(), { width: 6000, height: 4000 });
    v.viewer.update([rawItem(1, { originalUrl: null })]);
    expect(v.content.getState()).toMatchObject({ status: 'loaded', original: { status: 'none' } });
    expect(v.shown()[0].getAttribute('data-viewer-content')).toBe('preview');
    expect(v.content.getState().view).toMatchObject({ mode: 'fit', contentWidth: 1600 });
    expect(v.parts.original.hidden).toBe(true);
    expect(v.live.size).toBe(1);
    expect(v.content.showOriginal()).toBe(false);
  });

  it('offers nothing for items without an eligible original', async () => {
    const v = await loadedSingle(rawItem(1, { originalUrl: null }));
    expect(v.parts.original.hidden).toBe(true);
    expect(v.content.showOriginal()).toBe(false);
    expect(v.fetch).toHaveBeenCalledTimes(1);
  });
});

// ─── View controls, keys and preload ────────────────────────────────────────

describe('viewer content controls', () => {
  it('resets to Fit when navigating and pans with Shift+Arrow only while magnified', async () => {
    const v = makeViewer();
    v.viewer.open([1, 2]);
    await v.respond(v.requests[0], { width: 2000, height: 1000 });
    const plainArrow = fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: false });
    expect(plainArrow.defaultPrevented).toBe(false); // the shell's navigation keeps it
    expect(fire(v.parts.root, 'keydown', { key: 'ArrowLeft', shiftKey: true }).defaultPrevented).toBe(false);

    fire(v.parts.zoomIn, 'click');
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
