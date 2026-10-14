import { afterEach, describe, expect, it } from 'vitest';
import {
  dismissActiveGridInfoCard,
  enhanceCalendarInfoCards,
  enhanceDashboardTitleInfoCards,
} from '../src/static/client/info-cards.js';

function environment() {
  const documentListeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const windowObject = {
    innerWidth: 320,
    innerHeight: 240,
    addEventListener() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    setTimeout(callback) { timers.set(nextTimer, callback); return nextTimer++; },
    clearTimeout(id) { timers.delete(id); },
  };
  const document = {
    activeElement: null,
    defaultView: windowObject,
    documentElement: { clientWidth: 320, clientHeight: 240 },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  return {
    document,
    keydown(key) { documentListeners.get('keydown')?.({ key }); },
    pendingTimers: () => timers.size,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function titleInfo(env, { linkLeft = 20 } = {}) {
  const styles = new Map();
  let open = false;
  const info = {
    ownerDocument: env.document,
    isConnected: true,
    offsetWidth: 180,
    offsetHeight: 120,
    style: { setProperty(name, value) { styles.set(name, value); } },
    getBoundingClientRect() { return { width: 180, height: 120 }; },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    matches(selector) { return selector === ':popover-open' && open; },
    contains(target) { return target === this || target === action; },
    showPopover() { open = true; },
    hidePopover() { open = false; },
  };
  const action = { name: 'Edit release' };
  const link = {
    getBoundingClientRect() { return { left: linkLeft, top: 30, width: 60, height: 20, bottom: 50 }; },
  };
  // The wrapper spans its column, wider than the title link it contains.
  const wrapper = {
    ownerDocument: env.document,
    isConnected: true,
    dataset: {},
    listeners: new Map(),
    addEventListener(type, listener) {
      expect(this.listeners.has(type)).toBe(false);
      this.listeners.set(type, listener);
    },
    dispatch(type, event = {}) { this.listeners.get(type)?.(event); },
    contains(target) { return target === this || target === info || target === action || target === link; },
    getBoundingClientRect() { return { left: 0, top: 30, width: 320, height: 20, bottom: 50 }; },
    querySelector(selector) {
      if (selector === '[data-calendar-info-card]') return info;
      if (selector === ':scope > a[href]') return link;
      return null;
    },
  };
  link.focus = () => moveFocus(env, wrapper, link);
  return { wrapper, info, link, action, styles, isOpen: () => open };
}

// Mirrors browser focus: the element becomes active, then focusout and focusin
// bubble to the wrapper synchronously.
function moveFocus(env, wrapper, target) {
  const previous = env.document.activeElement;
  env.document.activeElement = target;
  if (wrapper.contains(previous)) wrapper.dispatch('focusout', { target: previous, relatedTarget: target });
  if (wrapper.contains(target)) wrapper.dispatch('focusin', { target, relatedTarget: previous });
}

function scope(env, items) {
  return {
    ownerDocument: env.document,
    querySelectorAll(selector) {
      return selector === '[data-dashboard-title-info]' ? items.map((item) => item.wrapper) : [];
    },
  };
}

afterEach(() => dismissActiveGridInfoCard());

describe('Dashboard title information cards', () => {
  it('binds once per title and leaves Calendar enhancement untouched', () => {
    const env = environment();
    const region = scope(env, [titleInfo(env), titleInfo(env)]);
    expect(enhanceDashboardTitleInfoCards(region)).toBe(2);
    expect(enhanceDashboardTitleInfoCards(region)).toBe(0);
    expect(enhanceCalendarInfoCards(region)).toBe(0);
  });

  it('opens on mouse hover flush below the title link and ignores touch hover', () => {
    const env = environment();
    const item = titleInfo(env, { linkLeft: 120 });
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.wrapper.dispatch('pointerenter', { pointerType: 'touch', clientX: 140, clientY: 40 });
    expect(item.isOpen()).toBe(false);

    item.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 140, clientY: 40 });
    expect(item.isOpen()).toBe(true);
    // Centered on the 60px link at 120, not on the full-width wrapper or the pointer.
    expect(item.styles.get('--asset-info-left')).toBe('60px');
    expect(item.styles.get('--asset-info-top')).toBe('50px');

    item.wrapper.dispatch('pointermove', { pointerType: 'mouse', clientX: 170, clientY: 45 });
    expect(item.styles.get('--asset-info-left')).toBe('60px');
    expect(item.styles.get('--asset-info-top')).toBe('50px');
  });

  it('keeps the card open while the pointer crosses from the title into it', () => {
    const env = environment();
    const item = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 40 });
    // Crossing the gutter leaves the wrapper; the card itself is a descendant,
    // so reaching it enters the wrapper again before the grace period ends.
    item.wrapper.dispatch('pointerleave', { pointerType: 'mouse' });
    expect(item.isOpen()).toBe(true);
    item.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 70 });
    expect(env.pendingTimers()).toBe(0);
    env.runTimers();
    expect(item.isOpen()).toBe(true);
  });

  it('dismisses after the pointer leaves both the title and the card', () => {
    const env = environment();
    const item = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 40 });
    item.wrapper.dispatch('pointerleave', { pointerType: 'mouse' });
    expect(item.isOpen()).toBe(true);
    env.runTimers();
    expect(item.isOpen()).toBe(false);
  });

  it('keeps a keyboard-focused card open when the pointer leaves', () => {
    const env = environment();
    const item = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.wrapper.dispatch('focusin');
    item.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 40 });
    item.wrapper.dispatch('pointerleave', { pointerType: 'mouse' });
    env.runTimers();
    expect(item.isOpen()).toBe(true);
  });

  it('opens flush below the title on keyboard focus, keeps focus moves inside open, and dismisses on Escape', () => {
    const env = environment();
    const item = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.wrapper.dispatch('focusin');
    expect(item.isOpen()).toBe(true);
    expect(item.styles.get('--asset-info-top')).toBe('50px');
    item.wrapper.dispatch('focusout', { relatedTarget: item.info });
    expect(item.isOpen()).toBe(true);

    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);

    item.wrapper.dispatch('focusin');
    item.wrapper.dispatch('focusout', { relatedTarget: null });
    expect(item.isOpen()).toBe(false);
  });

  it('returns focus from a card action to its title on Escape without reopening the card', () => {
    const env = environment();
    const item = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.link.focus();
    expect(item.isOpen()).toBe(true);
    moveFocus(env, item.wrapper, item.action);
    expect(item.isOpen()).toBe(true);

    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(env.document.activeElement).toBe(item.link);
    expect(item.info.contains(env.document.activeElement)).toBe(false);
    env.runTimers();
    expect(item.isOpen()).toBe(false);

    // Focus that leaves and comes back to the title opens the card again.
    moveFocus(env, item.wrapper, null);
    item.link.focus();
    expect(item.isOpen()).toBe(true);
  });

  it('leaves focus alone on Escape when it is not inside the card', () => {
    const env = environment();
    const item = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [item]));
    const elsewhere = { blur() { throw new Error('focus must stay put'); } };

    item.link.focus();
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(env.document.activeElement).toBe(item.link);

    item.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 40 });
    env.document.activeElement = elsewhere;
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(env.document.activeElement).toBe(elsewhere);
  });

  it('keeps a single card open while moving rapidly between titles', () => {
    const env = environment();
    const first = titleInfo(env);
    const second = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [first, second]));

    first.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 40 });
    first.wrapper.dispatch('pointerleave', { pointerType: 'mouse' });
    second.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 80 });
    expect(first.isOpen()).toBe(false);
    expect(second.isOpen()).toBe(true);
    // The first title's pending dismissal must not close the second card.
    env.runTimers();
    expect(second.isOpen()).toBe(true);

    second.wrapper.dispatch('pointerleave', { pointerType: 'mouse' });
    first.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 40 });
    env.runTimers();
    expect(first.isOpen()).toBe(true);
    expect(second.isOpen()).toBe(false);
  });

  it('dismisses a hovered card immediately on Escape', () => {
    const env = environment();
    const item = titleInfo(env);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.wrapper.dispatch('pointerenter', { pointerType: 'mouse', clientX: 40, clientY: 40 });
    item.wrapper.dispatch('pointerleave', { pointerType: 'mouse' });
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(env.pendingTimers()).toBe(0);
  });
});
