import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createViewerFullscreen,
  VIEWER_CHROME_IDLE_DELAY,
  viewerFullscreenClaimed,
  viewerFullscreenExiting,
  viewerFullscreenSupported,
} from '../src/static/client/viewer-fullscreen.js';

// Fullscreen entry/exit, request settlement, Escape ordering, close and
// reopen, and fullscreen-only idle chrome, driven through the real
// fullscreen participant with a scripted Fullscreen API and fake timers.
// This proves the state handling only: real fullscreen with the native
// modal dialog, the shared dialog binder and dropdowns is exercised in
// Chromium (tests/browser/unified-viewer-playback.spec.js).

function makeElement(tagName, document) {
  const attributes = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    listeners: [],
    get hidden() { return attributes.has('hidden'); },
    set hidden(value) { if (value) attributes.set('hidden', ''); else attributes.delete('hidden'); },
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
    addEventListener(type, handler, options) {
      element.listeners.push({ type, handler, capture: options === true || options?.capture === true });
    },
    removeEventListener(type, handler, options) {
      const capture = options === true || options?.capture === true;
      const index = element.listeners.findIndex((entry) => entry.type === type && entry.handler === handler && entry.capture === capture);
      if (index >= 0) element.listeners.splice(index, 1);
    },
    querySelector(selector) {
      if (selector === '[data-cc-dropdown][open]') {
        const visit = (node) => {
          for (const child of node.children) {
            if (child.hasAttribute('data-cc-dropdown') && child.hasAttribute('open')) return child;
            const found = visit(child);
            if (found) return found;
          }
          return null;
        };
        return visit(element);
      }
      return null;
    },
    focus() { document.activeElement = element; },
  };
  return element;
}

function makeHarness({ supported = true, requestMode = 'resolve', exitMode = 'resolve' } = {}) {
  const document = { activeElement: null, fullscreenElement: null, fullscreenEnabled: true, listeners: [] };
  document.body = makeElement('body', document);
  document.addEventListener = (type, handler) => document.listeners.push({ type, handler });
  document.removeEventListener = (type, handler) => {
    const index = document.listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
    if (index >= 0) document.listeners.splice(index, 1);
  };
  const dispatchDocument = (type) => {
    document.listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler({ type }));
  };
  const make = (tag, attribute, parent) => {
    const element = makeElement(tag, document);
    if (attribute) element.setAttribute(attribute, '');
    parent?.appendChild(element);
    return element;
  };
  const dialog = make('dialog', 'data-app-dialog', document.body);
  const card = make('div', 'data-unified-viewer-card', dialog);
  const header = make('header', 'data-header', card);
  const close = make('button', 'data-dialog-close', header);
  const root = make('div', 'data-unified-viewer', card);
  const context = make('div', 'data-unified-viewer-context', root);
  const button = make('button', 'data-unified-viewer-fullscreen', context);
  button.hidden = true;
  const stage = make('div', 'data-stage', root);
  const controls = make('div', 'data-controls', root);
  const next = make('button', 'data-next', controls);
  const dropdown = make('details', 'data-cc-dropdown', controls);

  const fullscreenApi = { requests: [], exits: 0, exitRequests: [] };
  if (supported) {
    document.exitFullscreen = vi.fn(() => {
      fullscreenApi.exits += 1;
      if (exitMode !== 'hold') return Promise.resolve();
      // A held exit: settled by the test, like an exit still underway.
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      fullscreenApi.exitRequests.push({ promise, resolve, reject });
      return promise;
    });
    card.requestFullscreen = vi.fn(() => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const request = { promise, resolve, reject };
      fullscreenApi.requests.push(request);
      if (requestMode === 'resolve') {
        harness.grant();
      } else if (requestMode === 'reject') {
        reject(new TypeError('Permissions check failed'));
      } else if (requestMode === 'throw') {
        throw new TypeError('not allowed');
      }
      return promise;
    });
  } else {
    delete document.fullscreenElement;
  }

  const media = { refreshGeometry: vi.fn() };
  const frames = [];
  const view = {
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    requestAnimationFrame: vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    }),
    cancelAnimationFrame: vi.fn((id) => { frames[id - 1] = null; }),
  };

  const observers = new Set();
  let session = 0;
  let open = null;
  const notify = (type) => observers.forEach((listener) => listener(Object.freeze({ type, session: open })));

  const fullscreen = createViewerFullscreen({
    document,
    dialog,
    target: card,
    root,
    button,
    chrome: [header, context, controls],
    observe: (listener) => {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    media,
    view,
  });

  const harness = {
    document,
    dialog,
    fullscreen,
    fullscreenApi,
    media,
    view,
    frames,
    parts: { card, header, close, root, context, button, stage, controls, next, dropdown },
    open() {
      if (open !== null) harness.close();
      session += 1;
      open = session;
      notify('open');
      return session;
    },
    close() {
      notify('close');
      open = null;
    },
    // The browser applies fullscreen to the card, then fires the change.
    grant(index = fullscreenApi.requests.length - 1) {
      document.fullscreenElement = card;
      dispatchDocument('fullscreenchange');
      fullscreenApi.requests[index]?.resolve();
    },
    // The browser leaves fullscreen (exitFullscreen, or the user).
    leave() {
      document.fullscreenElement = null;
      dispatchDocument('fullscreenchange');
    },
    otherElementFullscreen(element) {
      document.fullscreenElement = element;
      dispatchDocument('fullscreenchange');
    },
    keydown(target, key, extra = {}) {
      const event = { type: 'keydown', key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      // Capture on the dialog runs before the binder's bubbling listeners.
      dialog.listeners.filter((entry) => entry.type === 'keydown' && entry.capture).forEach((entry) => entry.handler(event));
      return event;
    },
    pointer(target, type = 'pointermove') {
      card.listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler({ type, target, pointerType: 'mouse' }));
    },
    focusin(target) {
      target.focus();
      card.listeners.filter((entry) => entry.type === 'focusin').forEach((entry) => entry.handler({ type: 'focusin', target }));
    },
    click(element) {
      element.listeners.filter((entry) => entry.type === 'click').forEach((entry) => entry.handler({ type: 'click', preventDefault() {} }));
    },
  };
  return harness;
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('viewer fullscreen support', () => {
  it('detects the Fullscreen API and hides the button where it is missing', () => {
    expect(viewerFullscreenSupported({ fullscreenElement: null, exitFullscreen() {} }, { requestFullscreen() {} })).toBe(true);
    expect(viewerFullscreenSupported({ fullscreenElement: null, exitFullscreen() {}, fullscreenEnabled: false }, { requestFullscreen() {} })).toBe(false);
    expect(viewerFullscreenSupported({}, { requestFullscreen() {} })).toBe(false);
    const h = makeHarness({ supported: false });
    h.open();
    expect(h.parts.button.hidden).toBe(true);
    expect(h.fullscreen.getState()).toMatchObject({ supported: false, active: false });
    expect(h.fullscreen.enter()).toBe(false);
    expect(h.document.listeners).toHaveLength(0);
  });

  it('shows the button only while a session is open', () => {
    const h = makeHarness();
    expect(h.parts.button.hidden).toBe(true);
    h.open();
    expect(h.parts.button.hidden).toBe(false);
    expect(h.parts.button.getAttribute('aria-label')).toBe('Enter fullscreen');
    h.close();
    expect(h.parts.button.hidden).toBe(true);
    expect(h.fullscreen.enter()).toBe(false);
  });
});

describe('viewer fullscreen entry and exit', () => {
  it('enters on the card, synchronizes from fullscreenchange and refreshes geometry', async () => {
    const h = makeHarness();
    h.open();
    h.click(h.parts.button);
    await flush();
    expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState()).toMatchObject({ active: true, pending: false });
    expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(true);
    expect(h.parts.button.getAttribute('aria-label')).toBe('Exit fullscreen');
    expect(h.parts.button.hasAttribute('data-viewer-fullscreen-active')).toBe(true);
    expect(h.media.refreshGeometry).toHaveBeenCalledTimes(1);
    h.frames.at(-1)?.();
    expect(h.media.refreshGeometry).toHaveBeenCalledTimes(2);
  });

  it('exits through the button and resynchronizes when the browser leaves', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    h.click(h.parts.button);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    h.leave();
    expect(h.fullscreen.getState().active).toBe(false);
    expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    await flush();
    expect(h.parts.button.getAttribute('aria-label')).toBe('Enter fullscreen');
    expect(h.media.refreshGeometry).toHaveBeenCalledTimes(2);
    // A browser-initiated exit (F11/Esc handled by the browser) syncs too.
    h.fullscreen.enter();
    await flush();
    h.leave();
    expect(h.fullscreen.getState().active).toBe(false);
  });

  it('stays out of fullscreen after a rejected or throwing request', async () => {
    for (const requestMode of ['reject', 'throw']) {
      const h = makeHarness({ requestMode });
      const states = [];
      h.fullscreen.observe((state, reason) => states.push(reason));
      h.open();
      h.fullscreen.enter();
      await flush();
      expect(h.fullscreen.getState()).toMatchObject({ active: false, pending: false });
      expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
      expect(h.parts.button.getAttribute('aria-label')).toBe('Enter fullscreen');
      expect(states).toContain('rejected');
      // The viewer can try again (a throwing request again reports none made).
      expect(h.fullscreen.enter()).toBe(requestMode === 'reject');
      expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(2);
    }
  });

  it('ignores a second request while one is pending', () => {
    const h = makeHarness({ requestMode: 'hold' });
    h.open();
    expect(h.fullscreen.enter()).toBe(true);
    expect(h.fullscreen.enter()).toBe(false);
    expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState().pending).toBe(true);
  });

  it('never exits fullscreen held by another element', () => {
    const h = makeHarness();
    h.open();
    const video = makeElement('video', h.document);
    h.otherElementFullscreen(video);
    expect(h.fullscreen.getState().active).toBe(false);
    expect(h.fullscreen.exit()).toBe(false);
    h.close();
    expect(h.document.exitFullscreen).not.toHaveBeenCalled();
    expect(h.document.fullscreenElement).toBe(video);
  });
});

describe('viewer fullscreen Escape and close ordering', () => {
  it('Escape exits fullscreen first and is marked handled, so the dialog stays open', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    const event = h.keydown(h.parts.next, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    h.leave();
    // Out of fullscreen, Escape is left to the shared dialog binder.
    const second = h.keydown(h.parts.next, 'Escape');
    expect(second.defaultPrevented).toBe(false);
  });

  it('leaves Escape to an open dropdown even in fullscreen', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    h.parts.dropdown.setAttribute('open', '');
    const event = h.keydown(h.parts.dropdown, 'Escape');
    expect(event.defaultPrevented).toBe(false);
    expect(h.document.exitFullscreen).not.toHaveBeenCalled();
    // An event the dropdown handler already consumed is not reused either.
    h.parts.dropdown.removeAttribute('open');
    const consumed = h.keydown(h.parts.dropdown, 'Escape', { defaultPrevented: true });
    expect(consumed.defaultPrevented).toBe(true);
    expect(h.document.exitFullscreen).not.toHaveBeenCalled();
  });

  it('Escape during a pending request keeps the dialog and cancels the request when it lands', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    h.open();
    h.fullscreen.enter();
    const event = h.keydown(h.parts.next, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    h.grant();
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState().active).toBe(false);
  });

  it('closing while fullscreen exits it and leaves no stale state', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    h.close();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState()).toMatchObject({ active: false, chromeHidden: false });
    expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    h.leave();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes focus return after a close from fullscreen, once the card has left it', async () => {
    const h = makeHarness();
    const opener = makeElement('button', h.document);
    h.document.body.appendChild(opener);
    h.document.contains = (node) => h.document.body.contains(node);
    h.open();
    h.fullscreen.enter();
    await flush();
    h.parts.next.focus();
    h.close();
    // Chromium keeps the page inert until the exit lands, so the binder's
    // own focus call has no effect; the handoff finishes it.
    expect(h.fullscreen.deferFocus(opener)).toBe(true);
    expect(h.document.activeElement).toBe(h.parts.next);
    h.leave();
    await flush();
    expect(h.document.activeElement).toBe(opener);
    // Nothing is deferred when fullscreen is not held.
    expect(h.fullscreen.deferFocus(opener)).toBe(false);
  });

  it('drops a deferred focus return when the viewer reopened or focus moved elsewhere', async () => {
    const h = makeHarness();
    const opener = makeElement('button', h.document);
    const elsewhere = makeElement('input', h.document);
    h.document.body.appendChild(opener);
    h.document.body.appendChild(elsewhere);
    h.document.contains = (node) => h.document.body.contains(node);
    h.open();
    h.fullscreen.enter();
    await flush();
    h.close();
    h.fullscreen.deferFocus(opener);
    elsewhere.focus();
    h.leave();
    expect(h.document.activeElement).toBe(elsewhere);

    h.open();
    h.fullscreen.enter();
    await flush();
    h.close();
    h.fullscreen.deferFocus(opener);
    h.open();
    h.leave();
    expect(h.document.activeElement).toBe(elsewhere);
  });

  it('a request that lands after close is released, not adopted', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    h.open();
    h.fullscreen.enter();
    h.close();
    h.grant();
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState().active).toBe(false);
    expect(h.parts.button.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a request from an earlier session that lands after reopening is released', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    h.open();
    h.fullscreen.enter();
    h.close();
    h.open();
    h.grant(0);
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState().active).toBe(false);
    // The new session can enter normally.
    h.leave();
    expect(h.fullscreen.enter()).toBe(true);
  });

  it('reopens cleanly after fullscreen and can enter again', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    h.close();
    h.leave();
    await flush();
    h.open();
    expect(h.fullscreen.getState()).toMatchObject({ active: false, pending: false, chromeHidden: false });
    h.fullscreen.enter();
    await flush();
    expect(h.fullscreen.getState().active).toBe(true);
  });
});

describe('viewer fullscreen idle chrome', () => {
  it('never hides the chrome outside fullscreen', () => {
    const h = makeHarness();
    h.open();
    h.pointer(h.parts.stage);
    vi.advanceTimersByTime(60_000);
    expect(h.parts.card.hasAttribute('data-viewer-chrome-hidden')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hides after inactivity in fullscreen and reveals on pointer and keyboard activity', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    expect(VIEWER_CHROME_IDLE_DELAY).toBe(4000);
    vi.advanceTimersByTime(3999);
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.fullscreen.getState().chromeHidden).toBe(true);
    expect(h.parts.card.hasAttribute('data-viewer-chrome-hidden')).toBe(true);
    h.pointer(h.parts.stage);
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(h.fullscreen.getState().chromeHidden).toBe(true);
    h.keydown(h.parts.stage, 'ArrowRight');
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
    // One idle timer at a time.
    h.pointer(h.parts.stage);
    h.pointer(h.parts.stage);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stays visible while keyboard focus is in the chrome, a dropdown is open, or the pointer is over it', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    // Keyboard focus inside the controls.
    h.keydown(h.parts.next, 'Tab');
    h.focusin(h.parts.next);
    vi.advanceTimersByTime(20_000);
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
    // A pointer user's focus does not hold the chrome.
    h.pointer(h.parts.stage, 'pointerdown');
    vi.advanceTimersByTime(4000);
    expect(h.fullscreen.getState().chromeHidden).toBe(true);
    // An open dropdown holds it.
    h.parts.dropdown.setAttribute('open', '');
    h.pointer(h.parts.stage);
    vi.advanceTimersByTime(20_000);
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
    h.parts.dropdown.removeAttribute('open');
    // Hovering the controls holds it.
    h.pointer(h.parts.next);
    vi.advanceTimersByTime(20_000);
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
    h.pointer(h.parts.stage);
    vi.advanceTimersByTime(4000);
    expect(h.fullscreen.getState().chromeHidden).toBe(true);
    // Focus moving into hidden chrome reveals it.
    h.focusin(h.parts.close);
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
  });

  it('leaving fullscreen restores the chrome and clears the idle timer', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    vi.advanceTimersByTime(4000);
    expect(h.fullscreen.getState().chromeHidden).toBe(true);
    h.leave();
    expect(h.fullscreen.getState().chromeHidden).toBe(false);
    expect(h.parts.card.hasAttribute('data-viewer-chrome-hidden')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('viewer fullscreen cleanup', () => {
  it('destroy exits fullscreen and removes every listener, timer and frame it added', async () => {
    const h = makeHarness();
    h.open();
    h.fullscreen.enter();
    await flush();
    expect(h.document.listeners.map((entry) => entry.type)).toEqual(['fullscreenchange', 'fullscreenerror']);
    h.fullscreen.destroy();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.document.listeners).toHaveLength(0);
    expect(h.dialog.listeners).toHaveLength(0);
    expect(h.parts.card.listeners).toHaveLength(0);
    expect(h.parts.button.listeners).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.parts.card.hasAttribute('data-viewer-chrome-hidden')).toBe(false);
    h.fullscreen.destroy();
  });
});

// The two pending-entry races: a request outstanding when the viewer is
// destroyed or closed, which the browser then grants. Chromium applies the
// grant to the card, blurs focus outside it to <body>, fires
// fullscreenchange and then resolves the request.
describe('viewer fullscreen pending entry after destroy or close', () => {
  function withPage(h) {
    h.document.contains = (node) => h.document.body.contains(node);
    const add = (tag) => {
      const element = makeElement(tag, h.document);
      h.document.body.appendChild(element);
      element.focus = vi.fn(() => { h.document.activeElement = element; });
      return element;
    };
    const page = { opener: add('button'), fallback: add('main'), elsewhere: add('input') };
    // A real focus change outside the dialog (the binder's return, a user).
    page.focus = (element) => {
      element.focus();
      h.document.listeners.filter((entry) => entry.type === 'focusin').forEach((entry) => entry.handler({ type: 'focusin', target: element }));
    };
    page.detach = (element) => {
      const parent = element.parentNode;
      parent.children.splice(parent.children.indexOf(element), 1);
      element.parentNode = null;
    };
    // Chromium's grant: the card goes fullscreen and the inert page loses focus.
    page.grant = (index) => {
      h.document.activeElement = h.document.body;
      h.grant(index);
    };
    page.focusinListeners = () => h.document.listeners.filter((entry) => entry.type === 'focusin').length;
    return page;
  }

  // The controller's close: session change, then the binder's onClose hands
  // the plan over (deferFocus) before it focuses the opener itself.
  function closeLikeController(h, page, fallback = () => page.fallback) {
    h.close();
    const deferred = h.fullscreen.deferFocus(page.opener, fallback);
    if (h.document.contains(page.opener)) page.focus(page.opener);
    return deferred;
  }

  it('A: destroy during pending entry releases a late grant without resurrecting anything', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const reasons = [];
    h.fullscreen.observe((state, reason) => reasons.push(reason));
    h.open();
    expect(h.fullscreen.enter()).toBe(true);
    h.fullscreen.destroy();
    expect(h.document.listeners).toHaveLength(0);
    const recorded = reasons.length;
    const frames = h.view.requestAnimationFrame.mock.calls.length;
    const geometry = h.media.refreshGeometry.mock.calls.length;

    h.grant();
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    h.leave();
    expect(h.document.fullscreenElement).toBe(null);
    // Inactive: no listener, emission, render, frame, timer or geometry work.
    expect(h.document.listeners).toHaveLength(0);
    expect(h.dialog.listeners).toHaveLength(0);
    expect(h.parts.card.listeners).toHaveLength(0);
    expect(h.parts.button.listeners).toHaveLength(0);
    expect(reasons).toHaveLength(recorded);
    expect(h.view.requestAnimationFrame.mock.calls.length).toBe(frames);
    expect(h.media.refreshGeometry.mock.calls.length).toBe(geometry);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.parts.button.hidden).toBe(true);
    expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    expect(h.parts.card.hasAttribute('data-viewer-chrome-hidden')).toBe(false);
    expect(h.fullscreen.getState()).toMatchObject({ active: false, pending: false, chromeHidden: false });
    expect(h.fullscreen.enter()).toBe(false);
    expect(h.fullscreen.deferFocus(h.parts.close)).toBe(false);
  });

  it('A: after destroy, a resolution seen before its fullscreenchange is released the same way', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    h.open();
    h.fullscreen.enter();
    h.fullscreen.destroy();
    h.document.fullscreenElement = h.parts.card;
    h.fullscreenApi.requests[0].resolve();
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('A: after destroy, unrelated fullscreen and a rejected request are left alone', async () => {
    const other = makeHarness({ requestMode: 'hold' });
    other.open();
    other.fullscreen.enter();
    other.fullscreen.destroy();
    const video = makeElement('video', other.document);
    other.document.fullscreenElement = video;
    other.fullscreenApi.requests[0].resolve();
    await flush();
    expect(other.document.exitFullscreen).not.toHaveBeenCalled();
    expect(other.document.fullscreenElement).toBe(video);

    const rejected = makeHarness({ requestMode: 'hold' });
    rejected.open();
    rejected.fullscreen.enter();
    rejected.fullscreen.destroy();
    rejected.fullscreenApi.requests[0].reject(new TypeError('denied'));
    await flush();
    expect(rejected.document.exitFullscreen).not.toHaveBeenCalled();
    rejected.fullscreen.destroy();
    expect(rejected.document.listeners).toHaveLength(0);
  });

  it('B: close during pending entry releases the late grant and returns focus to the opener once', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const page = withPage(h);
    page.focus(page.opener);
    h.open();
    h.parts.button.focus();
    h.fullscreen.enter();
    expect(closeLikeController(h, page)).toBe(true);
    expect(h.document.activeElement).toBe(page.opener);

    page.grant();
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState()).toMatchObject({ active: false, pending: false });
    // Still held: focus is only returned once the card has left fullscreen.
    expect(h.document.activeElement).toBe(h.document.body);
    h.leave();
    expect(h.document.activeElement).toBe(page.opener);
    // Opening, the binder's return, and the deferred return.
    expect(page.opener.focus).toHaveBeenCalledTimes(3);
    expect(page.focusinListeners()).toBe(0);
    // No second restoration.
    h.document.activeElement = h.document.body;
    h.leave();
    expect(page.opener.focus).toHaveBeenCalledTimes(3);
    expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('B: the same holds when the resolution is seen before its fullscreenchange', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const page = withPage(h);
    h.open();
    h.fullscreen.enter();
    closeLikeController(h, page);
    h.document.activeElement = h.document.body;
    h.document.fullscreenElement = h.parts.card;
    h.fullscreenApi.requests[0].resolve();
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    h.grant();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    h.leave();
    expect(h.document.activeElement).toBe(page.opener);
  });

  it('C: an opener removed before settlement falls back to a connected target', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const page = withPage(h);
    h.open();
    h.fullscreen.enter();
    closeLikeController(h, page);
    page.detach(page.opener);
    page.grant();
    await flush();
    h.leave();
    expect(h.document.activeElement).toBe(page.fallback);
    expect(page.opener.focus).toHaveBeenCalledTimes(1);

    // Without any connected target nothing detached is focused.
    const bare = makeHarness({ requestMode: 'hold' });
    const barePage = withPage(bare);
    bare.open();
    bare.fullscreen.enter();
    closeLikeController(bare, barePage, () => barePage.fallback);
    barePage.detach(barePage.opener);
    barePage.detach(barePage.fallback);
    barePage.grant();
    await flush();
    bare.leave();
    expect(bare.document.activeElement).toBe(bare.document.body);
    expect(barePage.fallback.focus).not.toHaveBeenCalled();
  });

  it('C: deliberate focus after closing is kept, not replaced by the opener', async () => {
    // Moved before the grant: the grant's blur is not taken for the user's choice.
    const h = makeHarness({ requestMode: 'hold' });
    const page = withPage(h);
    h.open();
    h.fullscreen.enter();
    closeLikeController(h, page);
    page.focus(page.elsewhere);
    page.grant();
    await flush();
    h.leave();
    expect(h.document.activeElement).toBe(page.elsewhere);
    expect(page.opener.focus).toHaveBeenCalledTimes(1);

    // Moved and the request was refused: focus simply stays.
    const refused = makeHarness({ requestMode: 'hold' });
    const refusedPage = withPage(refused);
    refused.open();
    refused.fullscreen.enter();
    closeLikeController(refused, refusedPage);
    refusedPage.focus(refusedPage.elsewhere);
    refused.fullscreenApi.requests[0].reject(new TypeError('denied'));
    await flush();
    expect(refused.document.activeElement).toBe(refusedPage.elsewhere);
    expect(refusedPage.opener.focus).toHaveBeenCalledTimes(1);
    expect(refusedPage.focusinListeners()).toBe(0);
  });

  it('C: a reopen before the old request settles is never handed the obsolete opener', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const page = withPage(h);
    h.open();
    h.fullscreen.enter();
    closeLikeController(h, page);
    h.open();
    h.parts.close.focus();
    expect(page.focusinListeners()).toBe(0);
    page.grant(0);
    await flush();
    // The stale grant is released, not adopted by the new session.
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.getState().active).toBe(false);
    h.leave();
    expect(h.document.activeElement).toBe(h.document.body);
    expect(page.opener.focus).toHaveBeenCalledTimes(1);
    // The new session enters normally.
    expect(h.fullscreen.enter()).toBe(true);
    h.grant();
    await flush();
    expect(h.fullscreen.getState().active).toBe(true);
  });

  it('D: a refused request after close leaves the binder focus and drops the plan', async () => {
    for (const settle of ['reject', 'error']) {
      const h = makeHarness({ requestMode: 'hold' });
      const page = withPage(h);
      h.open();
      h.fullscreen.enter();
      closeLikeController(h, page);
      if (settle === 'reject') h.fullscreenApi.requests[0].reject(new TypeError('denied'));
      else {
        h.document.listeners.filter((entry) => entry.type === 'fullscreenerror').forEach((entry) => entry.handler({}));
        h.fullscreenApi.requests[0].reject(new TypeError('denied'));
      }
      await flush();
      expect(h.document.exitFullscreen).not.toHaveBeenCalled();
      expect(h.document.activeElement).toBe(page.opener);
      expect(page.opener.focus).toHaveBeenCalledTimes(1);
      expect(page.focusinListeners()).toBe(0);
      expect(h.fullscreen.getState()).toMatchObject({ active: false, pending: false });
    }
  });

  it('D: close then destroy while still pending releases the grant and still returns focus', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const page = withPage(h);
    h.open();
    h.fullscreen.enter();
    closeLikeController(h, page);
    h.fullscreen.destroy();
    h.fullscreen.destroy();
    page.grant();
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(h.document.activeElement).toBe(page.opener);
    expect(page.opener.focus).toHaveBeenCalledTimes(2);
    expect(h.document.listeners).toHaveLength(0);
  });

  it('D: close while already fullscreen still defers through the existing path', async () => {
    const h = makeHarness();
    const page = withPage(h);
    h.open();
    h.fullscreen.enter();
    await flush();
    h.close();
    expect(h.fullscreen.deferFocus(page.opener, () => page.fallback)).toBe(true);
    // The binder's focus has no effect on the inert page.
    h.leave();
    await flush();
    expect(h.document.activeElement).toBe(page.opener);
    expect(page.focusinListeners()).toBe(0);
    // Repeated close is a no-op.
    h.close();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
  });
});

// Shared by the F3 and F4 suites: a page around the harness (an opener, a
// fallback and an unrelated focus target), a focus change that reports
// focusin, Chromium's inert-page blur, open dialogs, and a replacement
// participant bound to the same dialog card after the first is destroyed
// (enhanceUnifiedViewer rebinds a dialog whose controller was destroyed).
function lifecyclePage(h) {
  h.document.contains = (node) => h.document.body.contains(node);
  const openDialogs = [];
  h.document.querySelectorAll = (selector) => (selector === 'dialog[open]' ? openDialogs.slice() : []);
  const add = (tag) => {
    const element = makeElement(tag, h.document);
    h.document.body.appendChild(element);
    element.focus = vi.fn(() => { h.document.activeElement = element; });
    return element;
  };
  const page = { opener: add('button'), fallback: add('main'), elsewhere: add('input'), openDialogs };
  page.focus = (element) => {
    element.focus();
    h.document.listeners.filter((entry) => entry.type === 'focusin').forEach((entry) => entry.handler({ type: 'focusin', target: element }));
  };
  page.detach = (element) => {
    const parent = element.parentNode;
    parent.children.splice(parent.children.indexOf(element), 1);
    element.parentNode = null;
  };
  page.blur = () => { h.document.activeElement = h.document.body; };
  page.listenerCount = (type) => h.document.listeners.filter((entry) => entry.type === type).length;
  // The viewer dialog opening or closing for some session.
  page.setDialogOpen = (open) => {
    h.dialog.open = open;
    const index = openDialogs.indexOf(h.dialog);
    if (open && index === -1) openDialogs.push(h.dialog);
    if (!open && index !== -1) openDialogs.splice(index, 1);
  };
  return page;
}

function bindReplacement(h) {
  const observers = new Set();
  let session = 100;
  let open = null;
  const notify = (type) => observers.forEach((listener) => listener(Object.freeze({ type, session: open })));
  const fullscreen = createViewerFullscreen({
    document: h.document,
    dialog: h.dialog,
    target: h.parts.card,
    root: h.parts.root,
    button: h.parts.button,
    chrome: [h.parts.header, h.parts.context, h.parts.controls],
    observe: (listener) => {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    media: h.media,
    view: h.view,
  });
  return {
    fullscreen,
    open() {
      session += 1;
      open = session;
      notify('open');
      return session;
    },
    close() {
      notify('close');
      open = null;
    },
  };
}

// F3: a viewer closed from active fullscreen owes the opener its focus once
// the card has left fullscreen. The exit is still underway when the
// controller is destroyed; the obligation must outlive the destroy.
describe('viewer fullscreen: destroy while an exit is underway (F3)', () => {
  // Open, enter and hold fullscreen, then close as the controller does: the
  // session closes (starting the exit, held), and the binder's dismissal
  // hands the focus return over (its own focus fails on the inert page).
  function closeFromFullscreen(h, page, fallback = () => page.fallback) {
    h.open();
    h.fullscreen.enter();
    h.parts.button.focus();
    h.close();
    expect(h.fullscreenApi.exitRequests).toHaveLength(1);
    expect(h.fullscreen.deferFocus(page.opener, fallback)).toBe(true);
    page.blur();
  }

  const settleExit = async (h, order = 'change-first') => {
    if (order === 'change-first') {
      h.leave();
      h.fullscreenApi.exitRequests[0].resolve();
    } else {
      h.fullscreenApi.exitRequests[0].resolve();
      await flush();
      h.leave();
    }
    await flush();
  };

  it('returns focus to the opener once the exit lands, after destroy, in either order', async () => {
    for (const order of ['change-first', 'promise-first']) {
      const h = makeHarness({ exitMode: 'hold' });
      const page = lifecyclePage(h);
      closeFromFullscreen(h, page);
      const reasons = [];
      h.fullscreen.observe((state, reason) => reasons.push(reason));
      h.fullscreen.destroy();
      // Only the owed return's temporary listeners remain.
      expect(page.listenerCount('fullscreenerror')).toBe(0);
      expect(page.listenerCount('fullscreenchange')).toBe(1);
      expect(page.listenerCount('focusin')).toBe(1);
      expect(h.document.activeElement).toBe(h.document.body);
      await settleExit(h, order);
      expect(h.document.activeElement, order).toBe(page.opener);
      expect(page.opener.focus).toHaveBeenCalledTimes(1);
      expect(h.document.listeners, order).toHaveLength(0);
      expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
      // No second restoration, no resurrected UI, listener or emission.
      page.blur();
      h.leave();
      expect(page.opener.focus).toHaveBeenCalledTimes(1);
      expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(reasons).toEqual([]);
      expect(h.parts.button.hidden).toBe(true);
      expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(false);
      expect(h.dialog.listeners).toHaveLength(0);
      expect(h.parts.card.listeners).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.fullscreen.enter()).toBe(false);
    }
  });

  it('a disconnected opener falls back to a connected target, and nothing detached is focused', async () => {
    const h = makeHarness({ exitMode: 'hold' });
    const page = lifecyclePage(h);
    closeFromFullscreen(h, page);
    h.fullscreen.destroy();
    page.detach(page.opener);
    await settleExit(h);
    expect(h.document.activeElement).toBe(page.fallback);
    expect(page.opener.focus).not.toHaveBeenCalled();

    const bare = makeHarness({ exitMode: 'hold' });
    const barePage = lifecyclePage(bare);
    closeFromFullscreen(bare, barePage);
    bare.fullscreen.destroy();
    barePage.detach(barePage.opener);
    barePage.detach(barePage.fallback);
    await settleExit(bare);
    expect(bare.document.activeElement).toBe(bare.document.body);
    expect(barePage.fallback.focus).not.toHaveBeenCalled();
    expect(bare.document.listeners).toHaveLength(0);
  });

  it('keeps deliberate focus movement and never steals focus from another open modal', async () => {
    const moved = makeHarness({ exitMode: 'hold' });
    const movedPage = lifecyclePage(moved);
    closeFromFullscreen(moved, movedPage);
    moved.fullscreen.destroy();
    movedPage.focus(movedPage.elsewhere);
    await settleExit(moved);
    expect(moved.document.activeElement).toBe(movedPage.elsewhere);
    expect(movedPage.opener.focus).not.toHaveBeenCalled();
    expect(moved.document.listeners).toHaveLength(0);

    const modal = makeHarness({ exitMode: 'hold' });
    const modalPage = lifecyclePage(modal);
    closeFromFullscreen(modal, modalPage);
    modal.fullscreen.destroy();
    const other = makeElement('dialog', modal.document);
    modal.document.body.appendChild(other);
    modalPage.openDialogs.push(other);
    await settleExit(modal);
    expect(modalPage.opener.focus).not.toHaveBeenCalled();
    expect(modal.document.listeners).toHaveLength(0);
  });

  it('a viewer session reopened on the dialog while the exit is underway is never handed the old opener', async () => {
    // Still open when the exit lands.
    const h = makeHarness({ exitMode: 'hold' });
    const page = lifecyclePage(h);
    closeFromFullscreen(h, page);
    h.fullscreen.destroy();
    const replacement = bindReplacement(h);
    replacement.open();
    page.setDialogOpen(true);
    page.focus(h.parts.close);
    await settleExit(h);
    expect(h.document.activeElement).toBe(h.parts.close);
    expect(page.opener.focus).not.toHaveBeenCalled();
    expect(page.listenerCount('focusin')).toBe(0);
    expect(replacement.fullscreen.getState()).toMatchObject({ active: false, pending: false });
    expect(h.parts.button.hidden).toBe(false);

    // Opened and closed again before the exit lands.
    const again = makeHarness({ exitMode: 'hold' });
    const againPage = lifecyclePage(again);
    closeFromFullscreen(again, againPage);
    again.fullscreen.destroy();
    const next = bindReplacement(again);
    next.open();
    againPage.setDialogOpen(true);
    againPage.focus(again.parts.close);
    next.close();
    againPage.setDialogOpen(false);
    againPage.blur();
    await settleExit(again);
    expect(againPage.opener.focus).not.toHaveBeenCalled();
    expect(again.document.activeElement).toBe(again.document.body);
  });

  it('repeated close and destroy stay safe and restore at most once', async () => {
    const h = makeHarness({ exitMode: 'hold' });
    const page = lifecyclePage(h);
    closeFromFullscreen(h, page);
    h.close();
    h.fullscreen.destroy();
    h.fullscreen.destroy();
    h.close();
    expect(h.fullscreen.deferFocus(page.opener)).toBe(false);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    await settleExit(h);
    expect(page.opener.focus).toHaveBeenCalledTimes(1);
    h.fullscreen.destroy();
    expect(h.document.listeners).toHaveLength(0);
  });

  it('a refused exit drops the owed return without leaking; a refusal after the card left still restores', async () => {
    const h = makeHarness({ exitMode: 'hold' });
    const page = lifecyclePage(h);
    closeFromFullscreen(h, page);
    h.fullscreen.destroy();
    h.fullscreenApi.exitRequests[0].reject(new TypeError('not fullscreen'));
    await flush();
    // Still fullscreen: the page stays inert, so the plan is dropped, once.
    expect(h.document.fullscreenElement).toBe(h.parts.card);
    expect(page.opener.focus).not.toHaveBeenCalled();
    expect(h.document.listeners).toHaveLength(0);
    expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);

    const left = makeHarness({ exitMode: 'hold' });
    const leftPage = lifecyclePage(left);
    closeFromFullscreen(left, leftPage);
    left.fullscreen.destroy();
    left.document.fullscreenElement = null;
    left.fullscreenApi.exitRequests[0].reject(new TypeError('not fullscreen'));
    await flush();
    expect(left.document.activeElement).toBe(leftPage.opener);
    expect(left.document.listeners).toHaveLength(0);
  });

  it('an exit that already landed before destroy restores at once; the live path is unchanged', async () => {
    const h = makeHarness({ exitMode: 'hold' });
    const page = lifecyclePage(h);
    closeFromFullscreen(h, page);
    h.fullscreenApi.exitRequests[0].resolve();
    await flush();
    h.document.fullscreenElement = null;
    h.fullscreen.destroy();
    expect(h.document.activeElement).toBe(page.opener);
    expect(h.document.listeners).toHaveLength(0);

    const live = makeHarness({ exitMode: 'hold' });
    const livePage = lifecyclePage(live);
    closeFromFullscreen(live, livePage);
    live.leave();
    expect(live.document.activeElement).toBe(live.document.body);
    expect(livePage.listenerCount('focusin')).toBe(1);
    live.fullscreenApi.exitRequests[0].resolve();
    await flush();
    expect(live.document.activeElement).toBe(livePage.opener);
    expect(livePage.listenerCount('focusin')).toBe(0);
    expect(livePage.opener.focus).toHaveBeenCalledTimes(1);
  });
});

// F4: participant A's fullscreen request is still outstanding (its
// completion delayed) when A is destroyed and B is bound to the same card.
// The card element alone cannot say whose fullscreen it holds.
describe('viewer fullscreen ownership across a replacement participant (F4)', () => {
  function staleRequest(h) {
    h.open();
    expect(h.fullscreen.enter()).toBe(true);
    const old = h.fullscreenApi.requests.length - 1;
    h.fullscreen.destroy();
    return old;
  }

  const fireChange = (h) => {
    h.document.listeners.filter((entry) => entry.type === 'fullscreenchange').forEach((entry) => entry.handler({}));
  };

  it("A's late completion never exits fullscreen B entered on the same card", async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const page = lifecyclePage(h);
    const old = staleRequest(h);
    const b = bindReplacement(h);
    const reasons = [];
    b.fullscreen.observe((state, reason) => reasons.push(reason));
    b.open();
    expect(b.fullscreen.enter()).toBe(true);
    h.parts.button.focus();
    h.grant();
    await flush();
    expect(b.fullscreen.getState().active).toBe(true);
    // A's completion arrives last.
    h.fullscreenApi.requests[old].resolve();
    await flush();
    expect(h.document.exitFullscreen).not.toHaveBeenCalled();
    expect(h.document.fullscreenElement).toBe(h.parts.card);
    expect(b.fullscreen.getState()).toMatchObject({ active: true, pending: false });
    expect(h.parts.root.hasAttribute('data-viewer-fullscreen')).toBe(true);
    expect(h.parts.button.getAttribute('aria-label')).toBe('Exit fullscreen');
    expect(h.document.activeElement).toBe(h.parts.button);
    expect(reasons).toEqual(['request', 'enter']);
    expect(page.opener.focus).not.toHaveBeenCalled();
    // B still leaves normally, and the claim ends with it.
    expect(b.fullscreen.exit()).toBe(true);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    h.leave();
    expect(b.fullscreen.getState().active).toBe(false);
    expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
  });

  it("with no replacement, A's orphaned late grant is still released and its claim ends", async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const old = staleRequest(h);
    expect(viewerFullscreenClaimed(h.parts.card)).toBe(true);
    h.grant(old);
    await flush();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
  });

  it("a replacement bound but not fullscreen does not keep A's orphaned grant", async () => {
    for (const bOpen of [false, true]) {
      const h = makeHarness({ requestMode: 'hold', exitMode: 'hold' });
      const old = staleRequest(h);
      const b = bindReplacement(h);
      if (bOpen) b.open();
      h.grant(old);
      await flush();
      // Released (B's own sync and A's settlement, which share the one exit).
      expect(h.document.exitFullscreen).toHaveBeenCalled();
      h.leave();
      h.fullscreenApi.exitRequests.forEach((request) => request.resolve());
      await flush();
      expect(h.document.fullscreenElement).toBe(null);
      expect(b.fullscreen.getState()).toMatchObject({ active: false, pending: false });
      expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
      if (bOpen) {
        // B then enters normally.
        expect(b.fullscreen.enter()).toBe(true);
        h.grant();
        await flush();
        expect(b.fullscreen.getState().active).toBe(true);
      }
    }
  });

  it("a replacement entry still pending, and completions in either order, keep B's fullscreen", async () => {
    for (const order of ['old-first', 'new-first']) {
      const h = makeHarness({ requestMode: 'hold' });
      const old = staleRequest(h);
      const b = bindReplacement(h);
      b.open();
      b.fullscreen.enter();
      const current = h.fullscreenApi.requests.length - 1;
      // The browser grants the card (either request), then both complete.
      h.document.fullscreenElement = h.parts.card;
      fireChange(h);
      const sequence = order === 'old-first' ? [old, current] : [current, old];
      for (const index of sequence) {
        h.fullscreenApi.requests[index].resolve();
        await flush();
      }
      expect(h.document.exitFullscreen, order).not.toHaveBeenCalled();
      expect(b.fullscreen.getState(), order).toMatchObject({ active: true, pending: false });
      expect(h.document.fullscreenElement).toBe(h.parts.card);
    }
  });

  it("A's rejected request and unrelated fullscreen leave B and the other element alone", async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const old = staleRequest(h);
    const b = bindReplacement(h);
    b.open();
    b.fullscreen.enter();
    h.grant();
    await flush();
    h.fullscreenApi.requests[old].reject(new TypeError('denied'));
    await flush();
    expect(h.document.exitFullscreen).not.toHaveBeenCalled();
    expect(b.fullscreen.getState().active).toBe(true);

    const video = makeHarness({ requestMode: 'hold' });
    const staleVideo = staleRequest(video);
    const element = makeElement('video', video.document);
    video.otherElementFullscreen(element);
    video.fullscreenApi.requests[staleVideo].resolve();
    await flush();
    expect(video.document.exitFullscreen).not.toHaveBeenCalled();
    expect(video.document.fullscreenElement).toBe(element);
  });

  it("A's owed focus return cannot move focus out of B's session", async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const page = lifecyclePage(h);
    h.open();
    h.fullscreen.enter();
    const old = h.fullscreenApi.requests.length - 1;
    h.close();
    expect(h.fullscreen.deferFocus(page.opener, () => page.fallback)).toBe(true);
    page.focus(page.opener);
    h.fullscreen.destroy();
    const b = bindReplacement(h);
    b.open();
    page.setDialogOpen(true);
    page.focus(h.parts.close);
    b.fullscreen.enter();
    h.grant();
    await flush();
    page.blur();
    h.fullscreenApi.requests[old].resolve();
    await flush();
    expect(page.opener.focus).toHaveBeenCalledTimes(1);
    expect(page.listenerCount('focusin')).toBe(0);
    expect(b.fullscreen.getState().active).toBe(true);
    // B's own close from fullscreen still returns focus through its plan.
    b.close();
    page.setDialogOpen(false);
    expect(b.fullscreen.deferFocus(page.elsewhere)).toBe(true);
    h.leave();
    await flush();
    expect(h.document.activeElement).toBe(page.elsewhere);
  });

  it('repeated rebinding leaves no claim, listener or stale ownership behind', async () => {
    const h = makeHarness({ requestMode: 'hold' });
    const participants = [];
    // A, then four replacements, each destroyed with a request outstanding.
    const outstanding = [staleRequest(h)];
    for (let round = 0; round < 4; round += 1) {
      const next = bindReplacement(h);
      participants.push(next);
      next.open();
      next.fullscreen.enter();
      outstanding.push(h.fullscreenApi.requests.length - 1);
      next.fullscreen.destroy();
    }
    const current = bindReplacement(h);
    current.open();
    current.fullscreen.enter();
    h.grant();
    await flush();
    for (const index of outstanding) h.fullscreenApi.requests[index].resolve();
    await flush();
    expect(h.document.exitFullscreen).not.toHaveBeenCalled();
    expect(current.fullscreen.getState().active).toBe(true);
    expect(h.document.listeners.map((entry) => entry.type)).toEqual(['fullscreenchange', 'fullscreenerror']);
    current.fullscreen.exit();
    h.leave();
    current.fullscreen.destroy();
    expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
    expect(h.document.listeners).toHaveLength(0);
    expect(participants.every((participant) => participant.fullscreen.getState().active === false)).toBe(true);
  });
});

// F5: an exit already issued to the browser cannot be cancelled by replacing
// the claim. Participant A's late grant is released after A was destroyed;
// while that native exit is still in flight, a replacement B on the same card
// must not request fullscreen (Chromium grants it, then A's exit removes it).
describe('viewer fullscreen entry while an earlier exit is in flight (F5)', () => {
  const CLAIM_KEY = Symbol.for('creatorcrate.viewerFullscreenClaim');

  // A requests, is destroyed before completion, and its late grant is
  // released: one held native exit. B is bound (and opened) before or after
  // the grant; either way the card has a single exit in flight.
  function orphanedExit(h, { bindBeforeGrant = false } = {}) {
    h.open();
    expect(h.fullscreen.enter()).toBe(true);
    const old = h.fullscreenApi.requests.length - 1;
    h.fullscreen.destroy();
    let b = null;
    if (bindBeforeGrant) {
      b = bindReplacement(h);
      b.open();
    }
    h.grant(old);
    return { old, b };
  }

  const completeExit = async (h, order, index = 0) => {
    if (order === 'change-first') {
      h.leave();
      h.fullscreenApi.exitRequests[index].resolve();
    } else {
      h.fullscreenApi.exitRequests[index].resolve();
      await flush();
      h.leave();
    }
    await flush();
  };

  const orders = ['change-first', 'promise-first'];

  it("refuses B while A's exit is in flight, then lets a fresh request in once it lands", async () => {
    for (const bindBeforeGrant of [false, true]) {
      for (const order of orders) {
        const label = `${bindBeforeGrant ? 'bound-before-grant' : 'bound-after-grant'} / ${order}`;
        const h = makeHarness({ requestMode: 'hold', exitMode: 'hold' });
        let { b } = orphanedExit(h, { bindBeforeGrant });
        await flush();
        // One native exit, shared by A's release and B's own sync.
        expect(h.document.exitFullscreen, label).toHaveBeenCalledTimes(1);
        expect(viewerFullscreenExiting(h.parts.card), label).toBe(true);
        if (!b) {
          b = bindReplacement(h);
          b.open();
        }
        const reasons = [];
        b.fullscreen.observe((state, reason) => reasons.push(reason));
        expect(b.fullscreen.getState(), label).toMatchObject({ active: false, pending: false, entryBlocked: true });
        expect(h.parts.button.getAttribute('aria-disabled'), label).toBe('true');
        expect(h.parts.button.getAttribute('aria-label'), label).toBe('Enter fullscreen (unavailable while fullscreen closes)');
        expect(h.parts.button.hidden, label).toBe(false);

        // Direct calls and the button are both refused before the native API,
        // and the refused request does not take over the claim.
        const claimBefore = h.parts.card[CLAIM_KEY];
        expect(b.fullscreen.enter(), label).toBe(false);
        expect(b.fullscreen.toggle(), label).toBe(false);
        h.click(h.parts.button);
        expect(h.parts.card.requestFullscreen, label).toHaveBeenCalledTimes(1);
        expect(h.parts.card[CLAIM_KEY], label).toBe(claimBefore);
        expect(b.fullscreen.getState(), label).toMatchObject({ active: false, pending: false });
        expect(h.parts.root.hasAttribute('data-viewer-fullscreen'), label).toBe(false);
        expect(h.document.exitFullscreen, label).toHaveBeenCalledTimes(1);

        await completeExit(h, order);
        expect(viewerFullscreenExiting(h.parts.card), label).toBe(false);
        expect(viewerFullscreenClaimed(h.parts.card), label).toBe(false);
        expect(b.fullscreen.getState(), label).toMatchObject({ active: false, entryBlocked: false });
        expect(h.parts.button.hasAttribute('aria-disabled'), label).toBe(false);
        expect(h.parts.button.getAttribute('aria-label'), label).toBe('Enter fullscreen');
        expect(reasons, label).toEqual(['available']);
        // Nothing was queued for the refused clicks.
        expect(h.parts.card.requestFullscreen, label).toHaveBeenCalledTimes(1);
        expect(h.document.listeners.map((entry) => entry.type), label).toEqual(['fullscreenchange', 'fullscreenerror']);

        // A fresh, explicit request enters and stays.
        expect(b.fullscreen.enter(), label).toBe(true);
        h.grant();
        await flush();
        expect(b.fullscreen.getState(), label).toMatchObject({ active: true, pending: false, entryBlocked: false });
        expect(h.document.fullscreenElement, label).toBe(h.parts.card);
        expect(h.document.exitFullscreen, label).toHaveBeenCalledTimes(1);

        // B leaves normally, and the card ends with no claim, exit or listener.
        expect(b.fullscreen.exit(), label).toBe(true);
        expect(h.document.exitFullscreen, label).toHaveBeenCalledTimes(2);
        await completeExit(h, order, 1);
        expect(b.fullscreen.getState(), label).toMatchObject({ active: false, entryBlocked: false });
        expect(viewerFullscreenClaimed(h.parts.card), label).toBe(false);
        expect(viewerFullscreenExiting(h.parts.card), label).toBe(false);
        b.fullscreen.destroy();
        expect(h.document.listeners, label).toHaveLength(0);
      }
    }
  });

  it('neither destroying nor rebinding a participant removes the guard', async () => {
    const h = makeHarness({ requestMode: 'hold', exitMode: 'hold' });
    orphanedExit(h);
    await flush();
    const b = bindReplacement(h);
    b.open();
    expect(b.fullscreen.getState().entryBlocked).toBe(true);
    b.close();
    b.fullscreen.destroy();
    b.fullscreen.destroy();
    expect(viewerFullscreenExiting(h.parts.card)).toBe(true);
    const c = bindReplacement(h);
    c.open();
    c.close();
    c.open();
    expect(c.fullscreen.getState().entryBlocked).toBe(true);
    expect(c.fullscreen.enter()).toBe(false);
    expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    await completeExit(h, 'promise-first');
    expect(c.fullscreen.getState().entryBlocked).toBe(false);
    expect(c.fullscreen.enter()).toBe(true);
    h.grant();
    await flush();
    expect(c.fullscreen.getState().active).toBe(true);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    // The destroyed participants' stale handles cannot alter C afterwards.
    expect(h.fullscreen.exit()).toBe(false);
    expect(h.fullscreen.enter()).toBe(false);
    expect(h.fullscreen.toggle()).toBe(false);
    expect(b.fullscreen.exit()).toBe(false);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(c.fullscreen.getState().active).toBe(true);
  });

  it('a refused native exit clears the guard and leaves the control usable', async () => {
    for (const bindBeforeGrant of [false, true]) {
      const h = makeHarness({ requestMode: 'hold', exitMode: 'hold' });
      let { b } = orphanedExit(h, { bindBeforeGrant });
      await flush();
      if (!b) {
        b = bindReplacement(h);
        b.open();
      }
      expect(b.fullscreen.getState().entryBlocked).toBe(true);
      h.fullscreenApi.exitRequests[0].reject(new TypeError('not allowed'));
      await flush();
      expect(viewerFullscreenExiting(h.parts.card)).toBe(false);
      expect(b.fullscreen.getState()).toMatchObject({ active: false, entryBlocked: false });
      expect(h.parts.button.hasAttribute('aria-disabled')).toBe(false);
      // No retry loop: the refused exit is not reissued on its own.
      expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
      // An explicit request is a request again.
      expect(b.fullscreen.enter()).toBe(true);
      expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(2);
    }
  });

  it('a synchronously throwing exit or a promise-less exit never leaves a stuck guard', async () => {
    const thrown = makeHarness({ requestMode: 'hold' });
    thrown.document.exitFullscreen = vi.fn(() => { throw new TypeError('not fullscreen'); });
    orphanedExit(thrown);
    await flush();
    expect(thrown.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(viewerFullscreenExiting(thrown.parts.card)).toBe(false);
    expect(thrown.document.listeners).toHaveLength(0);

    const legacy = makeHarness({ requestMode: 'hold' });
    legacy.document.exitFullscreen = vi.fn(() => undefined);
    orphanedExit(legacy);
    await flush();
    expect(viewerFullscreenExiting(legacy.parts.card)).toBe(true);
    const b = bindReplacement(legacy);
    b.open();
    expect(b.fullscreen.enter()).toBe(false);
    legacy.leave();
    expect(viewerFullscreenExiting(legacy.parts.card)).toBe(false);
    expect(b.fullscreen.getState().entryBlocked).toBe(false);
    b.fullscreen.destroy();
    expect(legacy.document.listeners).toHaveLength(0);
  });

  it('the same participant closed and reopened during its own exit waits for it too', async () => {
    const h = makeHarness({ exitMode: 'hold' });
    h.open();
    h.fullscreen.enter();
    await flush();
    h.close();
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    h.open();
    expect(h.fullscreen.getState()).toMatchObject({ active: false, entryBlocked: true });
    expect(h.fullscreen.enter()).toBe(false);
    expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
    await completeExit(h, 'promise-first');
    expect(h.fullscreen.getState()).toMatchObject({ active: false, entryBlocked: false });
    expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(h.fullscreen.enter()).toBe(true);
    await flush();
    expect(h.fullscreen.getState().active).toBe(true);
  });

  it('an ordinary exit permits entry only after its promise settles', async () => {
    const h = makeHarness({ exitMode: 'hold' });
    h.open();
    h.fullscreen.enter();
    await flush();
    h.fullscreen.exit();
    // The control still reads Exit until the card leaves; no Enter is offered.
    expect(h.fullscreen.getState()).toMatchObject({ active: true, entryBlocked: false });
    expect(h.fullscreen.enter()).toBe(false);
    h.leave();
    expect(h.fullscreen.getState()).toMatchObject({ active: false, entryBlocked: true });
    expect(h.fullscreen.enter()).toBe(false);
    h.fullscreenApi.exitRequests[0].resolve();
    await flush();
    expect(h.fullscreen.getState()).toMatchObject({ active: false, entryBlocked: false });
    expect(viewerFullscreenExiting(h.parts.card)).toBe(false);
    expect(h.fullscreen.enter()).toBe(true);
  });

  it('fullscreen held by another element, or an exit on another card, does not block this viewer', async () => {
    const h = makeHarness();
    h.open();
    const video = makeElement('video', h.document);
    h.otherElementFullscreen(video);
    expect(h.fullscreen.getState().entryBlocked).toBe(false);
    expect(h.document.exitFullscreen).not.toHaveBeenCalled();
    expect(h.document.fullscreenElement).toBe(video);

    const other = makeHarness({ exitMode: 'hold' });
    other.open();
    other.fullscreen.enter();
    await flush();
    other.close();
    expect(viewerFullscreenExiting(other.parts.card)).toBe(true);
    const mine = makeHarness();
    mine.open();
    expect(mine.fullscreen.getState().entryBlocked).toBe(false);
    expect(mine.fullscreen.enter()).toBe(true);
  });

  it("A's owed focus return still settles once, and never into B's session", async () => {
    for (const bOpens of [false, true]) {
      const h = makeHarness({ exitMode: 'hold' });
      const page = lifecyclePage(h);
      // Closed from fullscreen with the focus return handed over, then
      // destroyed while the exit is held (F3).
      h.open();
      h.fullscreen.enter();
      h.parts.button.focus();
      h.close();
      expect(h.fullscreen.deferFocus(page.opener, () => page.fallback)).toBe(true);
      page.blur();
      h.fullscreen.destroy();
      const b = bindReplacement(h);
      if (bOpens) {
        b.open();
        page.setDialogOpen(true);
        page.focus(h.parts.close);
        expect(b.fullscreen.enter()).toBe(false);
      }
      await completeExit(h, 'change-first');
      expect(page.opener.focus).toHaveBeenCalledTimes(bOpens ? 0 : 1);
      expect(page.listenerCount('focusin')).toBe(0);
      expect(viewerFullscreenExiting(h.parts.card)).toBe(false);
      if (bOpens) {
        expect(h.document.activeElement).toBe(h.parts.close);
        expect(b.fullscreen.enter()).toBe(true);
      }
      b.fullscreen.destroy();
      expect(page.listenerCount('fullscreenchange')).toBe(0);
    }
  });

  it('holds across separately evaluated copies of the module on the same card', async () => {
    vi.resetModules();
    const copy = await import('../src/static/client/viewer-fullscreen.js');
    expect(copy.createViewerFullscreen).not.toBe(createViewerFullscreen);
    const h = makeHarness({ requestMode: 'hold', exitMode: 'hold' });
    orphanedExit(h);
    await flush();
    const observers = new Set();
    const b = copy.createViewerFullscreen({
      document: h.document,
      dialog: h.dialog,
      target: h.parts.card,
      root: h.parts.root,
      button: h.parts.button,
      chrome: [h.parts.header, h.parts.context, h.parts.controls],
      observe: (listener) => {
        observers.add(listener);
        return () => observers.delete(listener);
      },
      media: h.media,
      view: h.view,
    });
    observers.forEach((listener) => listener(Object.freeze({ type: 'open', session: 500 })));
    expect(copy.viewerFullscreenExiting(h.parts.card)).toBe(true);
    expect(b.getState().entryBlocked).toBe(true);
    expect(b.enter()).toBe(false);
    expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
    await completeExit(h, 'promise-first');
    expect(b.getState().entryBlocked).toBe(false);
    expect(b.enter()).toBe(true);
    h.grant();
    await flush();
    expect(b.getState().active).toBe(true);
    expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
    b.destroy();
  });
});

describe('viewer fullscreen authoritative exit settlement (F6)', () => {
  const EXIT_KEY = Symbol.for('creatorcrate.viewerFullscreenExit');
  const CLAIM_KEY = Symbol.for('creatorcrate.viewerFullscreenClaim');

  it('keeps the original promise guard across other-element fullscreen, destruction and rebinding', async () => {
    for (const bindBeforeChange of [false, true]) {
      for (const outcome of ['resolve', 'reject']) {
        const h = makeHarness({ requestMode: 'hold', exitMode: 'hold' });
        h.open();
        h.fullscreen.enter();
        h.grant();
        await flush();
        h.close();
        const record = h.parts.card[EXIT_KEY];
        const settled = vi.fn();
        record.waiters.add(settled);
        h.fullscreen.destroy();
        let b = bindBeforeChange ? bindReplacement(h) : null;
        b?.open();
        const other = makeElement('html', h.document);
        h.otherElementFullscreen(other);
        if (!b) {
          b = bindReplacement(h);
          b.open();
        }
        // A second observer joins the same record, without issuing an exit.
        const c = bindReplacement(h);
        c.open();
        const reasons = [];
        b.fullscreen.observe((state, reason) => reasons.push(reason));
        expect(h.parts.card[EXIT_KEY]).toBe(record);
        expect(viewerFullscreenExiting(h.parts.card)).toBe(true);
        expect(b.fullscreen.getState()).toMatchObject({ active: false, entryBlocked: true });
        expect(c.fullscreen.getState().entryBlocked).toBe(true);
        expect(h.parts.button.getAttribute('aria-disabled')).toBe('true');
        expect(h.parts.button.getAttribute('aria-label')).toContain('unavailable');
        const claim = h.parts.card[CLAIM_KEY];
        expect(b.fullscreen.enter()).toBe(false);
        expect(b.fullscreen.toggle()).toBe(false);
        h.click(h.parts.button);
        expect(h.parts.card[CLAIM_KEY]).toBe(claim);
        expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
        expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
        expect(settled).not.toHaveBeenCalled();

        h.fullscreenApi.exitRequests[0][outcome](new TypeError('refused'));
        await flush();
        expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === 'resolve' ? 'exited' : 'failed');
        expect(record.waiters.size).toBe(0);
        expect(viewerFullscreenExiting(h.parts.card)).toBe(false);
        expect(b.fullscreen.getState().entryBlocked).toBe(false);
        expect(c.fullscreen.getState().entryBlocked).toBe(false);
        expect(reasons).toEqual(['available']);
        expect(h.parts.button.hasAttribute('aria-disabled')).toBe(false);
        expect(h.document.fullscreenElement).toBe(other);
        expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
        expect(h.parts.card.requestFullscreen).toHaveBeenCalledTimes(1);
        c.fullscreen.destroy();

        expect(b.fullscreen.enter()).toBe(true);
        h.grant();
        await flush();
        const replacementClaim = h.parts.card[CLAIM_KEY];
        h.fullscreenApi.exitRequests[0].resolve();
        h.fullscreenApi.requests[0].resolve();
        h.otherElementFullscreen(h.parts.card);
        await flush();
        expect(h.fullscreen.exit()).toBe(false);
        expect(b.fullscreen.getState().active).toBe(true);
        expect(h.parts.card[CLAIM_KEY]).toBe(replacementClaim);
        expect(h.document.exitFullscreen).toHaveBeenCalledTimes(1);
        b.fullscreen.exit();
        h.leave();
        h.fullscreenApi.exitRequests[1].resolve();
        await flush();
        b.fullscreen.destroy();
        expect(h.document.listeners).toHaveLength(0);
        expect(viewerFullscreenExiting(h.parts.card)).toBe(false);
        expect(viewerFullscreenClaimed(h.parts.card)).toBe(false);
      }
    }
  });

  it('ignores duplicate old completion callbacks after a newer exit starts', async () => {
    const h = makeHarness();
    const callbacks = [];
    h.document.exitFullscreen = vi.fn(() => ({ then(resolve, reject) { callbacks.push({ resolve, reject }); } }));
    h.open();
    h.fullscreen.enter();
    await flush();
    h.fullscreen.exit();
    h.leave();
    callbacks[0].resolve();
    expect(h.fullscreen.getState().entryBlocked).toBe(false);
    h.fullscreen.enter();
    await flush();
    h.fullscreen.exit();
    const newer = h.parts.card[EXIT_KEY];
    const settled = vi.fn();
    newer.waiters.add(settled);
    h.leave();
    callbacks[0].resolve();
    callbacks[0].reject();
    expect(h.parts.card[EXIT_KEY]).toBe(newer);
    expect(h.fullscreen.getState().entryBlocked).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    callbacks[1].resolve();
    expect(settled).toHaveBeenCalledExactlyOnceWith('exited');
    expect(viewerFullscreenExiting(h.parts.card)).toBe(false);
    h.fullscreen.destroy();
    expect(h.document.listeners).toHaveLength(0);
  });

  it('completes a promise-less synchronous exit without waiting for an already-delivered event', async () => {
    const h = makeHarness();
    h.document.exitFullscreen = vi.fn(() => { h.leave(); });
    h.open();
    h.fullscreen.enter();
    await flush();
    h.fullscreen.exit();
    expect(viewerFullscreenExiting(h.parts.card)).toBe(false);
    expect(h.fullscreen.getState().entryBlocked).toBe(false);
    h.fullscreen.destroy();
    expect(h.document.listeners).toHaveLength(0);
  });

  it('keeps an owed focus plan until promise settlement, including destruction after the change', async () => {
    for (const destroy of [false, true]) {
      const h = makeHarness({ exitMode: 'hold' });
      const page = lifecyclePage(h);
      h.open();
      h.fullscreen.enter();
      await flush();
      h.close();
      expect(h.fullscreen.deferFocus(page.opener)).toBe(true);
      page.blur();
      h.leave();
      if (destroy) h.fullscreen.destroy();
      expect(page.opener.focus).not.toHaveBeenCalled();
      expect(page.listenerCount('focusin')).toBe(1);
      expect(viewerFullscreenExiting(h.parts.card)).toBe(true);
      h.fullscreenApi.exitRequests[0].resolve();
      await flush();
      expect(page.opener.focus).toHaveBeenCalledTimes(1);
      expect(page.listenerCount('focusin')).toBe(0);
      h.fullscreen.destroy();
      expect(h.document.listeners).toHaveLength(0);
    }
  });
});
