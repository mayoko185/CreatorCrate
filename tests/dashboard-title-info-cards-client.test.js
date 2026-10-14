import { afterEach, describe, expect, it } from 'vitest';
import {
  dismissActiveGridInfoCard,
  enhanceCalendarInfoCards,
  enhanceDashboardTitleInfoCards,
} from '../src/static/client/info-cards.js';

function environment() {
  const documentListeners = new Map();
  let mutationCallback;
  const windowObject = {
    innerWidth: 320,
    innerHeight: 240,
    addEventListener() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
    },
  };
  const document = {
    defaultView: windowObject,
    documentElement: { clientWidth: 320, clientHeight: 240 },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  return {
    document,
    // Mirrors a real click: the capturing document listener runs first, then
    // the target's own activation.
    click(target) {
      documentListeners.get('click')?.({ target });
      target.click?.();
    },
    keydown(key) { documentListeners.get('keydown')?.({ key }); },
    mutate() { mutationCallback?.([]); },
  };
}

function titleInfo(env, id) {
  const triggerListeners = new Map();
  const attrs = new Map([['aria-expanded', 'false']]);
  const styles = new Map();
  let open = false;
  let focusCount = 0;
  const trigger = {
    ownerDocument: env.document,
    isConnected: true,
    addEventListener(type, listener) {
      expect(triggerListeners.has(type)).toBe(false);
      triggerListeners.set(type, listener);
    },
    click() { triggerListeners.get('click')?.(); },
    dispatch(type, event = {}) { triggerListeners.get(type)?.(event); },
    contains(target) { return target === this; },
    focus() { focusCount += 1; },
    getClientRects() { return [{}]; },
    getBoundingClientRect() { return { left: 40, top: 40, width: 100, height: 20, bottom: 60 }; },
    setAttribute(name, value) { attrs.set(name, value); },
  };
  const action = { insideCard: true, closest: () => null };
  const info = {
    ownerDocument: env.document,
    isConnected: true,
    id: `dashboard-release-info-scheduled-${id}`,
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
  const wrapper = {
    ownerDocument: env.document,
    isConnected: true,
    dataset: {},
    addEventListener() { throw new Error('hybrid titles bind their trigger, not the wrapper'); },
    querySelector(selector) {
      if (selector === '[data-calendar-info-trigger]') return trigger;
      if (selector === '[data-calendar-info-card]') return info;
      return null;
    },
  };
  return {
    wrapper, trigger, info, action, attrs, styles,
    isOpen: () => open,
    focusCount: () => focusCount,
  };
}

function scope(env, items, previewSelector = '[data-dashboard-title-info]') {
  return {
    ownerDocument: env.document,
    querySelectorAll(selector) {
      return selector === previewSelector ? items.map((item) => item.wrapper) : [];
    },
  };
}

const outside = { closest: () => null };

afterEach(() => dismissActiveGridInfoCard());

describe('Dashboard title information cards', () => {
  it('binds each title trigger once and leaves Calendar enhancement untouched', () => {
    const env = environment();
    const region = scope(env, [titleInfo(env, 1), titleInfo(env, 2)]);
    expect(enhanceDashboardTitleInfoCards(region)).toBe(2);
    expect(enhanceDashboardTitleInfoCards(region)).toBe(0);
    expect(enhanceCalendarInfoCards(region)).toBe(0);
  });

  it('follows the mouse while hovering, ignores touch hover, and closes on leave', () => {
    const env = environment();
    const item = titleInfo(env, 1);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.trigger.dispatch('pointerenter', { pointerType: 'touch', clientX: 80, clientY: 50 });
    expect(item.isOpen()).toBe(false);

    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 50 });
    expect(item.isOpen()).toBe(true);
    expect(item.attrs.get('aria-expanded')).toBe('true');
    expect(item.styles.get('--asset-info-left')).toBe('92px');
    expect(item.styles.get('--asset-info-top')).toBe('62px');

    item.trigger.dispatch('pointermove', { pointerType: 'mouse', clientX: 100, clientY: 55 });
    expect(item.styles.get('--asset-info-left')).toBe('112px');
    expect(item.styles.get('--asset-info-top')).toBe('67px');

    item.trigger.dispatch('pointerleave');
    expect(item.isOpen()).toBe(false);
    expect(item.attrs.get('aria-expanded')).toBe('false');
  });

  it('pins on click, stays put after the pointer leaves, and keeps clicks inside the card', () => {
    const env = environment();
    const item = titleInfo(env, 1);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 50 });
    env.click(item.trigger);
    expect(item.isOpen()).toBe(true);
    const pinnedLeft = item.styles.get('--asset-info-left');
    const pinnedTop = item.styles.get('--asset-info-top');

    item.trigger.dispatch('pointermove', { pointerType: 'mouse', clientX: 200, clientY: 150 });
    item.trigger.dispatch('pointerleave');
    expect(item.isOpen()).toBe(true);
    expect(item.styles.get('--asset-info-left')).toBe(pinnedLeft);
    expect(item.styles.get('--asset-info-top')).toBe(pinnedTop);

    env.click(item.action);
    expect(item.isOpen()).toBe(true);

    env.click(outside);
    expect(item.isOpen()).toBe(false);
    expect(item.attrs.get('aria-expanded')).toBe('false');
    expect(item.focusCount()).toBe(0);
  });

  it('pins through keyboard activation and returns focus to the title on Escape', () => {
    const env = environment();
    const item = titleInfo(env, 1);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    // Enter and Space reach a button as a click, with no hover first.
    env.click(item.trigger);
    expect(item.isOpen()).toBe(true);
    expect(item.attrs.get('aria-expanded')).toBe('true');

    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(item.attrs.get('aria-expanded')).toBe('false');
    expect(item.focusCount()).toBe(1);
  });

  it('returns focus from inside a hovered, unpinned card on Escape without pinning it', () => {
    const env = environment();
    const item = titleInfo(env, 1);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 50 });
    env.document.activeElement = item.action;
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(item.attrs.get('aria-expanded')).toBe('false');
    expect(item.focusCount()).toBe(1);

    // The restored title activates as a fresh pin rather than toggling a
    // card that is still considered open.
    env.document.activeElement = item.trigger;
    env.click(item.trigger);
    expect(item.isOpen()).toBe(true);
    expect(item.attrs.get('aria-expanded')).toBe('true');
  });

  it('leaves focus outside a hovered card where it is on Escape', () => {
    const env = environment();
    const item = titleInfo(env, 1);
    enhanceDashboardTitleInfoCards(scope(env, [item]));

    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 50 });
    env.document.activeElement = outside;
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(item.focusCount()).toBe(0);

    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 50 });
    env.document.activeElement = item.trigger;
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(item.focusCount()).toBe(0);
  });

  it('keeps Calendar Escape focus restoration limited to pinned cards', () => {
    const env = environment();
    const item = titleInfo(env, 1);
    enhanceCalendarInfoCards(scope(env, [item], '[data-calendar-event]'));

    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 50 });
    env.document.activeElement = item.action;
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(item.focusCount()).toBe(0);

    env.click(item.trigger);
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(item.focusCount()).toBe(1);
  });

  it('keeps one active card: hover is ignored while pinned and a click switches the pin', () => {
    const env = environment();
    const first = titleInfo(env, 1);
    const second = titleInfo(env, 2);
    enhanceDashboardTitleInfoCards(scope(env, [first, second]));

    env.click(first.trigger);
    second.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 90 });
    expect(first.isOpen()).toBe(true);
    expect(second.isOpen()).toBe(false);

    env.click(second.trigger);
    expect(first.isOpen()).toBe(false);
    expect(first.attrs.get('aria-expanded')).toBe('false');
    expect(second.isOpen()).toBe(true);
    expect(second.attrs.get('aria-expanded')).toBe('true');
  });

  it('dismisses a pinned card whose title was replaced and binds the replacement unpinned', () => {
    const env = environment();
    const item = titleInfo(env, 1);
    enhanceDashboardTitleInfoCards(scope(env, [item]));
    env.click(item.trigger);

    item.trigger.isConnected = false;
    item.info.isConnected = false;
    env.mutate();
    expect(item.isOpen()).toBe(false);
    expect(item.attrs.get('aria-expanded')).toBe('false');

    const replacement = titleInfo(env, 1);
    expect(enhanceDashboardTitleInfoCards(scope(env, [replacement]))).toBe(1);
    expect(replacement.isOpen()).toBe(false);
    expect(replacement.attrs.get('aria-expanded')).toBe('false');

    // The detached title's listeners no longer own the active card.
    env.click(replacement.trigger);
    item.trigger.dispatch('pointerleave');
    expect(replacement.isOpen()).toBe(true);
  });
});
