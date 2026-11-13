import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createViewerPlayback,
  normalizeViewerPlaybackSpeed,
  VIEWER_CAUSE_PLAYBACK,
  VIEWER_CAUSE_USER,
  VIEWER_PLAYBACK_DEFAULT_SPEED,
  VIEWER_PLAYBACK_SPEEDS,
} from '../src/static/client/viewer-playback.js';
import {
  createSingleImageSource,
  createSlideshowSource,
  createViewerSource,
  findViewerItemIndex,
  getViewerItem,
  reconcileViewerSource,
  stepViewerSequence,
} from '../src/static/client/viewer-sequence.js';

// B4: slideshow playback state, load-aware scheduling and interruption,
// driven through the real playback participant with deterministic fake
// timers. The controller and the content participant are stand-ins that
// follow their real contracts: the content participant observes first, so
// its media state for a change is already that change's (a new item reports
// `loading` before the navigate change reaches playback), and every media
// report carries the session and item key. The real controller wiring,
// fullscreen and dialog behavior are covered in
// tests/unified-viewer-client.test.js, tests/viewer-fullscreen.test.js and
// Chromium (tests/browser/unified-viewer-playback.spec.js).

// ─── Minimal DOM stand-in ────────────────────────────────────────────────────

function makeElement(tagName, document) {
  const attributes = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    listeners: [],
    value: '',
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
      element.children.push(child);
      child.parentNode = element;
      return child;
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
  const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
  target.listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
  return event;
}

// ─── Harness ─────────────────────────────────────────────────────────────────

function rawItem(id, extra = {}) {
  return {
    projectId: 7,
    assetId: id,
    title: `image-${id}.png`,
    mediaUrl: `/projects/7/assets/${id}/preview`,
    originalUrl: `/projects/7/assets/${id}/original`,
    revision: 'r1',
    ...extra,
  };
}

const keyOf = (id) => `p:7|a:${id}`;

function slideshow(ids, extra = {}) {
  return createSlideshowSource({
    key: 'project-7-slideshow',
    label: 'Project Seven',
    entries: ids.map((id) => ({
      id,
      projectId: 7,
      filename: `image-${id}.png`,
      previewUrl: `/projects/7/assets/${id}/preview`,
      originalUrl: `/projects/7/assets/${id}/original`,
      revision: 'r1',
      ...(typeof extra[id] === 'object' ? extra[id] : {}),
    })),
  });
}

function makeHarness({ reducedMotion = false, speedValue = '4000' } = {}) {
  const document = { activeElement: null, visibilityState: 'visible', hidden: false, listeners: [] };
  document.body = makeElement('body', document);
  document.addEventListener = (type, handler) => document.listeners.push({ type, handler });
  document.removeEventListener = (type, handler) => {
    const index = document.listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
    if (index >= 0) document.listeners.splice(index, 1);
  };
  const make = (tag, attribute) => {
    const element = makeElement(tag, document);
    if (attribute) element.setAttribute(attribute, '');
    return element;
  };
  const root = document.body.appendChild(make('div', 'data-unified-viewer'));
  const position = root.appendChild(make('span', 'data-unified-viewer-position'));
  position.setAttribute('aria-live', 'polite');
  const playback = root.appendChild(make('div', 'data-unified-viewer-playback'));
  playback.hidden = true;
  const play = playback.appendChild(make('button', 'data-unified-viewer-play'));
  const speed = playback.appendChild(make('select', 'data-unified-viewer-speed'));
  speed.value = speedValue;
  const close = root.appendChild(make('button', 'data-dialog-close'));

  const motion = { matches: reducedMotion, listeners: [] };
  motion.addEventListener = (type, handler) => motion.listeners.push(handler);
  motion.removeEventListener = (type, handler) => {
    motion.listeners.splice(motion.listeners.indexOf(handler), 1);
  };
  const view = {
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    matchMedia: vi.fn(() => motion),
  };

  // Content participant stand-in (B3 contract).
  const mediaListeners = new Set();
  let mediaState = null;
  const media = {
    getState: () => mediaState,
    observe: (listener) => {
      mediaListeners.add(listener);
      return () => mediaListeners.delete(listener);
    },
    fit: vi.fn(() => {
      mediaState = { ...mediaState, view: { ...mediaState.view, mode: 'fit' } };
      mediaListeners.forEach((listener) => listener(mediaState, 'view'));
      return true;
    }),
  };
  const report = (patch, reason = 'status') => {
    mediaState = {
      session: null,
      key: null,
      status: 'idle',
      attempt: 0,
      error: null,
      original: { status: 'none' },
      view: { hasContent: false, mode: 'fit' },
      ...mediaState,
      ...patch,
    };
    mediaListeners.forEach((listener) => listener(mediaState, reason));
  };

  // Controller stand-in: observers, session, stepping by B1.
  const observers = new Set();
  const observe = (listener) => {
    observers.add(listener);
    return () => observers.delete(listener);
  };
  let session = 0;
  let active = null;
  const notify = (type, extra = {}) => {
    const s = active;
    const change = Object.freeze({
      type,
      session: s.session,
      source: s.source,
      key: s.key,
      index: findViewerItemIndex(s.source, s.key),
      count: s.source.items.length,
      item: getViewerItem(s.source, s.key),
      previousKey: null,
      reload: false,
      reason: null,
      ...extra,
    });
    observers.forEach((listener) => listener(change));
  };
  // The content participant reacts first: a new available item is loading.
  const beginMedia = () => {
    const item = getViewerItem(active.source, active.key);
    report({
      session: active.session,
      key: active.key,
      status: item.available ? 'loading' : 'unavailable',
      original: { status: 'none' },
      view: { hasContent: false, mode: 'fit' },
    });
  };
  const moveTo = (key, cause, wrapped = false) => {
    const previousKey = active.key;
    active.key = key;
    beginMedia();
    notify('navigate', { previousKey, reload: true, cause, wrapped });
  };
  const step = (direction, cause) => {
    if (!active) return null;
    const result = stepViewerSequence(active.source, active.key, direction);
    if (result.moved) moveTo(result.key, cause, result.wrapped);
    return result;
  };
  const advance = vi.fn(() => step('next', VIEWER_CAUSE_PLAYBACK));

  const controller = {
    open(source, options = {}) {
      if (active) controller.close('replaced');
      session += 1;
      active = { session, source, key: source.initialKey || source.items[0].key };
      beginMedia();
      notify('open', { reload: true, autoplay: options.autoplay !== false });
      return session;
    },
    next: () => step('next', VIEWER_CAUSE_USER),
    previous: () => step('previous', VIEWER_CAUSE_USER),
    select(id) { moveTo(keyOf(id), VIEWER_CAUSE_USER); },
    update(items) {
      const previousKey = active.key;
      const result = reconcileViewerSource(active.source, active.key, items);
      active.source = result.source;
      active.key = result.key;
      if (result.reload || result.key !== previousKey) beginMedia();
      notify('update', { previousKey, reload: result.reload, preserveView: result.preserveView });
      // An unchanged loaded item is restated by the content participant.
      if (!result.reload && result.key === previousKey) report({}, 'status');
    },
    close(reason = 'closed') {
      if (!active) return;
      notify('close', { reason });
      active = null;
      report({ session: null, key: null, status: 'idle', view: { hasContent: false, mode: 'fit' } });
    },
    // Media outcomes for the current item.
    loaded() {
      report({ session: active.session, key: active.key, status: 'loaded', view: { hasContent: true, mode: 'fit' } });
    },
    failed() { report({ session: active.session, key: active.key, status: 'failed', error: 'http' }); },
    retrying() { report({ session: active.session, key: active.key, status: 'loading', attempt: 1, view: { hasContent: false, mode: 'fit' } }); },
    qualityLoading() { report({ quality: { loading: true } }, 'quality'); },
    qualitySettled() { report({ quality: { loading: false } }, 'quality'); },
    originalLoading() { report({ original: { status: 'loading' } }, 'original'); },
    originalActive() { report({ original: { status: 'active' }, view: { hasContent: true, mode: 'zoom' } }, 'original'); },
    originalFailed() { report({ original: { status: 'failed' } }, 'original'); },
    zoomed() { report({ view: { hasContent: true, mode: 'zoom' } }, 'view'); },
    fitted() { report({ view: { hasContent: true, mode: 'fit' } }, 'view'); },
    state: () => active,
  };

  const playbackParticipant = createViewerPlayback({
    document,
    regions: { root, playback },
    observe,
    media,
    advance,
    focusFallback: () => close,
    view,
  });

  return {
    document,
    view,
    motion,
    media,
    report,
    controller,
    advance,
    playback: playbackParticipant,
    parts: { root, position, playback, play, speed, close },
    key: () => active?.key ?? null,
    hide() {
      document.visibilityState = 'hidden';
      document.hidden = true;
      fire(document, 'visibilitychange');
    },
    show() {
      document.visibilityState = 'visible';
      document.hidden = false;
      fire(document, 'visibilitychange');
    },
  };
}

// Document listeners are dispatched through the same helper.
function fireDocument(document, type) {
  document.listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler({ type }));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ─── Availability and autoplay ───────────────────────────────────────────────

describe('viewer playback availability and autoplay', () => {
  it('normalizes only the existing 2/4/6 second choices, 4 s by default', () => {
    expect(VIEWER_PLAYBACK_SPEEDS).toEqual([2000, 4000, 6000]);
    expect(VIEWER_PLAYBACK_DEFAULT_SPEED).toBe(4000);
    expect(normalizeViewerPlaybackSpeed('2000')).toBe(2000);
    expect(normalizeViewerPlaybackSpeed(6000)).toBe(6000);
    expect(normalizeViewerPlaybackSpeed('3000')).toBeNull();
    expect(normalizeViewerPlaybackSpeed('abc')).toBeNull();
    const h = makeHarness({ speedValue: 'nonsense' });
    expect(h.playback.getState().speed).toBe(4000);
    expect(h.parts.speed.value).toBe('4000');
  });

  it('opens an explicit slideshow playing, with controls and a Pause label', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    expect(h.playback.getState()).toMatchObject({ available: true, playing: true, speed: 4000, waiting: true, scheduled: false });
    expect(h.parts.playback.hidden).toBe(false);
    expect(h.parts.play.getAttribute('aria-label')).toBe('Pause slideshow');
    expect(h.parts.play.hasAttribute('data-viewer-playing')).toBe(true);
    expect(h.parts.root.getAttribute('data-viewer-playback')).toBe('playing');
    // An auto-advancing slideshow does not announce every slide.
    expect(h.parts.position.getAttribute('aria-live')).toBe('off');
  });

  it('opens paused, still navigable, when reduced motion is preferred, and Play still works', () => {
    const h = makeHarness({ reducedMotion: true });
    h.controller.open(slideshow([1, 2, 3]));
    expect(h.playback.getState()).toMatchObject({ available: true, playing: false, pauseReason: 'reduced-motion' });
    expect(h.parts.play.getAttribute('aria-label')).toBe('Play slideshow');
    expect(h.parts.position.getAttribute('aria-live')).toBe('polite');
    h.controller.loaded();
    vi.advanceTimersByTime(20_000);
    expect(h.key()).toBe(keyOf(1));
    h.controller.next();
    expect(h.key()).toBe(keyOf(2));
    expect(h.playback.play()).toBe(true);
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(3));
  });

  it('pauses when reduced motion becomes preferred while playing', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2]));
    h.controller.loaded();
    h.motion.matches = true;
    h.motion.listeners.forEach((listener) => listener());
    expect(h.playback.getState()).toMatchObject({ playing: false, scheduled: false, pauseReason: 'reduced-motion' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours an explicit autoplay: false', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2]), { autoplay: false });
    expect(h.playback.getState()).toMatchObject({ available: true, playing: false });
  });

  it('never plays a single image, an ordinary sequence or a comic-style source', () => {
    const h = makeHarness();
    const sources = [
      createSingleImageSource({ key: 'one', entries: [{ id: 1, projectId: 7, previewUrl: '/p/1' }], projectId: 7, assetId: 1 }),
      createViewerSource({ key: 'seq', mode: 'sequence', items: [rawItem(1), rawItem(2)] }),
      createViewerSource({ key: 'comic', mode: 'sequence', wrap: false, slideshow: false, items: [rawItem(1, { position: 1 }), rawItem(1, { position: 2 })] }),
      // A slideshow with one available item cannot advance.
      slideshow([1, 2], { 2: { previewUrl: null } }),
    ];
    for (const source of sources) {
      h.controller.open(source);
      h.controller.loaded();
      expect(h.playback.getState()).toMatchObject({ available: false, playing: false });
      expect(h.parts.playback.hidden).toBe(true);
      expect(h.playback.play()).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

// ─── Load-aware scheduling ───────────────────────────────────────────────────

describe('viewer playback scheduling', () => {
  it('starts each interval only once its slide has loaded, giving a slow slide its full time', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    // Still loading: no timer, however long it takes.
    vi.advanceTimersByTime(30_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.key()).toBe(keyOf(1));
    h.controller.loaded();
    expect(h.playback.getState()).toMatchObject({ scheduled: true, waiting: false });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3999);
    expect(h.key()).toBe(keyOf(1));
    vi.advanceTimersByTime(1);
    expect(h.key()).toBe(keyOf(2));
    expect(h.advance).toHaveBeenCalledTimes(1);
    // Slide 2 is slow: the clock does not run while it loads.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(h.key()).toBe(keyOf(2));
    h.controller.loaded();
    vi.advanceTimersByTime(3999);
    expect(h.key()).toBe(keyOf(2));
    vi.advanceTimersByTime(1);
    expect(h.key()).toBe(keyOf(3));
    // Automatic advance never pauses itself.
    expect(h.playback.getState().playing).toBe(true);
  });

  it('wraps from the last slide to the first, following the source', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2]), {});
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(1));
    expect(h.playback.getState().playing).toBe(true);
  });

  it('stops at the end of a non-wrapping slideshow source', () => {
    const h = makeHarness();
    h.controller.open(createViewerSource({ key: 'nw', mode: 'sequence', slideshow: true, wrap: false, items: [rawItem(1), rawItem(2)] }));
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(2));
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(2));
    expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'end' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies 2, 4 and 6 second speeds and reschedules a running interval from the change', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3, 4]));
    h.parts.speed.value = '2000';
    fire(h.parts.speed, 'change');
    expect(h.playback.getState().speed).toBe(2000);
    h.controller.loaded();
    vi.advanceTimersByTime(2000);
    expect(h.key()).toBe(keyOf(2));
    h.controller.loaded();
    vi.advanceTimersByTime(1500);
    expect(h.playback.setSpeed(6000)).toBe(true);
    expect(h.parts.speed.value).toBe('6000');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5999);
    expect(h.key()).toBe(keyOf(2));
    vi.advanceTimersByTime(1);
    expect(h.key()).toBe(keyOf(3));
    expect(h.playback.setSpeed(3000)).toBe(false);
    expect(h.playback.getState().speed).toBe(6000);
  });

  it('changing speed while paused does not start playback', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2]));
    h.controller.loaded();
    h.playback.pause();
    h.playback.setSpeed(2000);
    expect(h.playback.getState()).toMatchObject({ playing: false, speed: 2000, scheduled: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never creates a second timer from repeated Play or repeated ready reports', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    h.playback.play();
    h.playback.play();
    h.controller.loaded();
    h.controller.fitted();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(4000);
    expect(h.advance).toHaveBeenCalledTimes(1);
    // Pause/Play cycles restart the interval but keep one timer.
    h.controller.loaded();
    fire(h.parts.play, 'click');
    fire(h.parts.play, 'click');
    fire(h.parts.play, 'click');
    fire(h.parts.play, 'click');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps a running interval through an unchanged source update', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    vi.advanceTimersByTime(3000);
    h.controller.update([rawItem(1), rawItem(2), rawItem(3)]);
    vi.advanceTimersByTime(999);
    expect(h.key()).toBe(keyOf(1));
    vi.advanceTimersByTime(1);
    expect(h.key()).toBe(keyOf(2));
  });

  it('restarts the wait when an update replaces or reloads the current slide', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    vi.advanceTimersByTime(3000);
    // The current item was removed: its neighbour takes over and must load.
    h.controller.update([rawItem(2), rawItem(3)]);
    expect(h.key()).toBe(keyOf(2));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(h.key()).toBe(keyOf(2));
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(3));
    expect(h.playback.getState().playing).toBe(true);
  });

  it('stops when an update leaves nothing playable', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2]));
    h.controller.loaded();
    h.controller.update([rawItem(1)]);
    expect(h.playback.getState()).toMatchObject({ available: false, playing: false });
    expect(h.parts.playback.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Media interruption ──────────────────────────────────────────────────────

describe('viewer playback media interruption', () => {
  it('pauses on a failed slide, does not loop through failures, and a retry never resumes', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(2));
    h.controller.failed();
    expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'media' });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(h.key()).toBe(keyOf(2));
    expect(h.advance).toHaveBeenCalledTimes(1);
    h.controller.retrying();
    h.controller.loaded();
    vi.advanceTimersByTime(60_000);
    expect(h.playback.getState().playing).toBe(false);
    expect(h.key()).toBe(keyOf(2));
  });

  it('pauses on a known unavailable slide reached by the slideshow', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3], { 2: { previewUrl: null } }));
    h.controller.loaded();
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(2));
    expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'media' });
    vi.advanceTimersByTime(60_000);
    expect(h.key()).toBe(keyOf(2));
  });

  it('Play on a failed or unavailable slide moves on once and pauses again on the next failure', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]), { autoplay: false });
    h.controller.failed();
    expect(h.playback.play()).toBe(true);
    expect(h.key()).toBe(keyOf(2));
    h.controller.failed();
    expect(h.playback.getState().playing).toBe(false);
    expect(h.advance).toHaveBeenCalledTimes(1);
  });

  it('ignores stale media reports from a previous slide or session', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    const firstSession = h.controller.state().session;
    h.controller.next();
    h.playback.play();
    // A late "loaded" or "failed" for slide 1 cannot schedule or pause slide 2.
    h.report({ session: firstSession, key: keyOf(1), status: 'loaded', view: { hasContent: true, mode: 'fit' } });
    expect(vi.getTimerCount()).toBe(0);
    h.report({ session: firstSession, key: keyOf(1), status: 'failed' });
    expect(h.playback.getState().playing).toBe(true);
    // Nor can a report from an earlier session after reopening.
    h.controller.open(slideshow([1, 2, 3]));
    h.report({ session: firstSession, key: keyOf(1), status: 'failed' });
    expect(h.playback.getState().playing).toBe(true);
    h.report({ session: firstSession, key: keyOf(1), status: 'loaded', view: { hasContent: true, mode: 'fit' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a timer that fires for a slide that is no longer ready does nothing', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    // The media state regresses without a session change (defensive).
    h.report({ status: 'loading' }, 'status');
    vi.advanceTimersByTime(4000);
    expect(h.advance).not.toHaveBeenCalled();
  });
});

// ─── Manual and inspection interruption ──────────────────────────────────────

describe('viewer playback manual interruption', () => {
  it('pauses on Previous, Next and select, keeping the chosen item, and never restarts', () => {
    for (const act of ['next', 'previous', 'select']) {
      const h = makeHarness();
      h.controller.open(slideshow([1, 2, 3]));
      h.controller.loaded();
      if (act === 'select') h.controller.select(3);
      else h.controller[act]();
      expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'navigation' });
      const key = h.key();
      h.controller.loaded();
      vi.advanceTimersByTime(60_000);
      expect(h.key()).toBe(key);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('pausing keeps the current item, and paused navigation works normally', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    vi.advanceTimersByTime(2000);
    fire(h.parts.play, 'click');
    expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'user' });
    expect(h.key()).toBe(keyOf(1));
    expect(h.parts.play.getAttribute('aria-label')).toBe('Play slideshow');
    expect(h.parts.position.getAttribute('aria-live')).toBe('polite');
    h.controller.next();
    h.controller.next();
    expect(h.key()).toBe(keyOf(3));
    expect(h.playback.getState().playing).toBe(false);
  });

  it('pauses at once when an original starts loading, disables Play meanwhile, and Fit never resumes', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    h.controller.originalLoading();
    expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'inspection' });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.parts.play.disabled).toBe(true);
    expect(h.playback.play()).toBe(false);
    h.controller.originalFailed();
    expect(h.parts.play.disabled).toBe(false);
    expect(h.playback.getState().playing).toBe(false);
    h.controller.originalActive();
    h.controller.fitted();
    vi.advanceTimersByTime(60_000);
    expect(h.playback.getState().playing).toBe(false);
    expect(h.key()).toBe(keyOf(1));
  });

  it('pauses when zooming changes the viewing mode, and Play returns to Fit before playing', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    h.controller.zoomed();
    expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'inspection' });
    expect(h.playback.play()).toBe(true);
    expect(h.media.fit).toHaveBeenCalledTimes(1);
    expect(h.playback.getState()).toMatchObject({ playing: true, scheduled: true });
    vi.advanceTimersByTime(4000);
    expect(h.key()).toBe(keyOf(2));
  });

  it('moves focus off Play when it becomes disabled', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2]), { autoplay: false });
    h.controller.loaded();
    h.parts.play.focus();
    h.controller.originalLoading();
    expect(h.document.activeElement).toBe(h.parts.close);
  });
});

// ─── Visibility and lifecycle ────────────────────────────────────────────────

describe('viewer playback visibility and lifecycle', () => {
  it('pauses when the tab is hidden, keeps the item, and does not resume when visible', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    vi.advanceTimersByTime(3000);
    h.hide();
    expect(h.playback.getState()).toMatchObject({ playing: false, pauseReason: 'hidden' });
    expect(vi.getTimerCount()).toBe(0);
    // Throttled background time never turns into a burst of advances.
    vi.advanceTimersByTime(120_000);
    h.show();
    vi.advanceTimersByTime(120_000);
    expect(h.key()).toBe(keyOf(1));
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.playback.getState().playing).toBe(false);
  });

  it('is safe when the tab hides during loading', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.hide();
    h.controller.loaded();
    vi.advanceTimersByTime(10_000);
    expect(h.key()).toBe(keyOf(1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing clears the timer, and a late media result cannot reactivate playback', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    expect(vi.getTimerCount()).toBe(1);
    const { session } = h.controller.state();
    h.controller.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.playback.getState()).toMatchObject({ session: null, available: false, playing: false, pauseReason: 'closed' });
    expect(h.parts.playback.hidden).toBe(true);
    h.report({ session, key: keyOf(1), status: 'loaded', view: { hasContent: true, mode: 'fit' } });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.playback.play()).toBe(false);
  });

  it('closing while loading prevents any later scheduling', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    const { session } = h.controller.state();
    h.controller.close();
    h.report({ session, key: keyOf(1), status: 'loaded', view: { hasContent: true, mode: 'fit' } });
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replacing the source drops the old timer and resets playback for the new one', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3]));
    h.controller.loaded();
    h.playback.pause();
    h.controller.open(slideshow([7, 8]));
    expect(h.playback.getState()).toMatchObject({ playing: true, key: keyOf(7) });
    expect(vi.getTimerCount()).toBe(0);
    h.controller.open(createViewerSource({ key: 'seq', mode: 'sequence', items: [rawItem(1), rawItem(2)] }));
    expect(h.playback.getState()).toMatchObject({ playing: false, available: false });
  });

  it('keeps the chosen speed across sessions', () => {
    const h = makeHarness();
    h.controller.open(slideshow([1, 2]));
    h.playback.setSpeed(6000);
    h.controller.close();
    h.controller.open(slideshow([1, 2]));
    expect(h.playback.getState().speed).toBe(6000);
  });

  it('reports changes to observers and removes every listener and timer on destroy', () => {
    const h = makeHarness();
    const reasons = [];
    h.playback.observe((state, reason) => reasons.push(reason));
    h.controller.open(slideshow([1, 2]));
    h.controller.loaded();
    h.playback.pause();
    expect(reasons).toEqual(['open', 'scheduled', 'pause']);
    h.playback.play();
    expect(vi.getTimerCount()).toBe(1);
    h.playback.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.document.listeners).toHaveLength(0);
    expect(h.motion.listeners).toHaveLength(0);
    expect(h.parts.play.listeners).toHaveLength(0);
    expect(h.parts.speed.listeners).toHaveLength(0);
    expect(h.parts.playback.hidden).toBe(true);
    h.controller.loaded();
    fireDocument(h.document, 'visibilitychange');
    expect(vi.getTimerCount()).toBe(0);
    h.playback.destroy();
  });
});


describe('quality switch countdown ownership', () => {
  it.each(['success', 'controlled failure'])('suspends and resumes the same playing slideshow after %s at the selected speed', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.controller.open(slideshow([1, 2, 3])); h.controller.loaded();
    h.playback.setSpeed(6000);
    vi.advanceTimersByTime(5000);
    h.controller.qualityLoading();
    expect(h.playback.getState()).toMatchObject({ playing: true, waiting: true, scheduled: false, speed: 6000 });
    vi.advanceTimersByTime(20000);
    expect(h.key()).toBe(keyOf(1));
    h.controller.qualitySettled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5999); expect(h.key()).toBe(keyOf(1));
    vi.advanceTimersByTime(1); expect(h.key()).toBe(keyOf(2));
    h.playback.destroy(); vi.useRealTimers();
  });

  it('respects an explicit pause during switching and never adds a timer', () => {
    vi.useFakeTimers();
    const h = makeHarness(); h.controller.open(slideshow([1, 2])); h.controller.loaded();
    h.controller.qualityLoading(); h.playback.pause(); h.controller.qualitySettled();
    expect(h.playback.getState().playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    h.playback.destroy(); vi.useRealTimers();
  });
});
