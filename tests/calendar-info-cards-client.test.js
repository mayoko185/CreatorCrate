import { afterEach, describe, expect, it } from 'vitest';
import {
  dismissActiveGridInfoCard,
  enhanceCalendarInfoCards,
} from '../src/static/client/info-cards.js';

function environment() {
  const documentListeners = new Map();
  const windowListeners = new Map();
  let mutationCallback;
  const windowObject = {
    innerWidth: 320,
    innerHeight: 240,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
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
    click(target) {
      documentListeners.get('click')?.({ target });
      target.click?.();
    },
    keydown(key) { documentListeners.get('keydown')?.({ key }); },
    resize() { windowListeners.get('resize')?.(); },
    mutate() { mutationCallback?.([]); },
  };
}

function card(env, surface, id) {
  const triggerListeners = new Map();
  const infoListeners = new Map();
  const attrs = new Map([['aria-expanded', 'false']]);
  const styles = new Map();
  let open = false;
  let visible = true;
  let focusCount = 0;
  let infoHeight = 120;
  const trigger = {
    ownerDocument: env.document,
    isConnected: true,
    addEventListener(type, listener) { triggerListeners.set(type, listener); },
    click() { triggerListeners.get('click')?.(); },
    dispatch(type, event = {}) { triggerListeners.get(type)?.(event); },
    contains(target) { return target === this; },
    focus() { focusCount += 1; },
    getClientRects() { return visible ? [{}] : []; },
    getBoundingClientRect() { return { left: 40, top: 40, width: 100, height: 30, bottom: 70 }; },
    setAttribute(name, value) { attrs.set(name, value); },
  };
  const info = {
    ownerDocument: env.document,
    isConnected: true,
    id: `calendar-info-${surface}-${id}`,
    offsetWidth: 180,
    get offsetHeight() { return infoHeight; },
    showCount: 0,
    hideCount: 0,
    style: { setProperty(name, value) { styles.set(name, value); } },
    getBoundingClientRect() { return { width: 180, height: infoHeight }; },
    addEventListener(type, listener) { infoListeners.set(type, listener); },
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    matches(selector) { return selector === ':popover-open' && open; },
    contains(target) { return target === this || target?.insideInfoCard === true; },
    showPopover() { open = true; this.showCount += 1; },
    hidePopover() { open = false; this.hideCount += 1; },
  };
  const event = {
    ownerDocument: env.document,
    isConnected: true,
    dataset: {},
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    querySelector(selector) {
      if (selector === '[data-calendar-info-trigger]') return trigger;
      if (selector === '[data-calendar-info-card]') return info;
      return null;
    },
  };
  return {
    event, trigger, info, attrs, styles,
    triggerListeners,
    infoListeners,
    isOpen: () => open,
    focusCount: () => focusCount,
    setVisible(value) { visible = value; },
    setInfoHeight(value) { infoHeight = value; },
  };
}

function scope(env, cards) {
  return {
    ownerDocument: env.document,
    querySelectorAll(selector) {
      return selector === '[data-calendar-event]' ? cards.map((item) => item.event) : [];
    },
  };
}

afterEach(() => dismissActiveGridInfoCard());

describe('Calendar information cards', () => {
  it('opens transiently on hover, follows the shared pointer path, and closes on leave', () => {
    const env = environment();
    const item = card(env, 'grid', 1);
    const region = scope(env, [item]);
    expect(enhanceCalendarInfoCards(region)).toBe(1);
    expect(enhanceCalendarInfoCards(region)).toBe(0);
    expect(item.isOpen()).toBe(false);
    expect(item.triggerListeners.has('focusin')).toBe(false);

    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    expect(item.isOpen()).toBe(true);
    expect(item.attrs.get('aria-expanded')).toBe('true');
    expect(item.styles.get('--asset-info-left')).toBe('92px');
    expect(item.styles.get('--asset-info-top')).toBe('82px');
    item.trigger.dispatch('pointermove', { pointerType: 'mouse', clientX: 200, clientY: 150 });
    expect(item.styles.get('--asset-info-left')).toBe('8px');
    expect(item.styles.get('--asset-info-top')).toBe('18px');
    expect(item.info.showCount).toBe(1);
    item.trigger.dispatch('pointerleave');
    expect(item.isOpen()).toBe(false);
    expect(item.attrs.get('aria-expanded')).toBe('false');
  });

  it('promotes the same hover card to pinned, survives leave, and toggles closed', () => {
    const env = environment();
    const item = card(env, 'grid', 1);
    enhanceCalendarInfoCards(scope(env, [item]));
    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    env.click(item.trigger);
    expect(item.isOpen()).toBe(true);
    expect(item.info.showCount).toBe(1);
    expect(item.info.hideCount).toBe(0);
    expect(item.styles.get('--asset-info-left')).toBe('8px');
    expect(item.styles.get('--asset-info-top')).toBe('78px');
    item.trigger.dispatch('pointermove', { pointerType: 'mouse', clientX: 200, clientY: 150 });
    item.trigger.dispatch('pointerleave');
    expect(item.isOpen()).toBe(true);
    expect(item.styles.get('--asset-info-left')).toBe('8px');

    env.click(item.trigger);
    expect(item.isOpen()).toBe(false);
    expect(item.info.showCount).toBe(1);
    expect(item.attrs.get('aria-expanded')).toBe('false');
    item.trigger.dispatch('pointermove', { pointerType: 'mouse', clientX: 90, clientY: 80 });
    expect(item.isOpen()).toBe(false);
  });

  it('repositions an open card when its primary image changes the card height', () => {
    const env = environment();
    const item = card(env, 'grid', 1);
    enhanceCalendarInfoCards(scope(env, [item]));
    item.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    expect(item.styles.get('--asset-info-top')).toBe('82px');
    expect(item.infoListeners.has('load')).toBe(true);
    expect(item.infoListeners.has('error')).toBe(true);
    item.setInfoHeight(180);
    item.infoListeners.get('load')();
    expect(item.styles.get('--asset-info-top')).toBe('8px');
  });

  it('pins via native activation without hover and dismisses with Escape or outside click', () => {
    const env = environment();
    const item = card(env, 'agenda', 2);
    enhanceCalendarInfoCards(scope(env, [item]));

    item.trigger.dispatch('pointerenter', { pointerType: 'touch', clientX: 80, clientY: 70 });
    expect(item.isOpen()).toBe(false);
    env.click(item.trigger);
    expect(item.isOpen()).toBe(true);
    expect(item.triggerListeners.has('keydown')).toBe(false);
    env.click({ insideInfoCard: true, closest: () => null });
    expect(item.isOpen()).toBe(true);
    env.keydown('Escape');
    expect(item.isOpen()).toBe(false);
    expect(item.focusCount()).toBe(1);

    env.click(item.trigger);
    env.click({ closest: () => null });
    expect(item.isOpen()).toBe(false);
    expect(item.focusCount()).toBe(1);
    expect(item.attrs.get('aria-expanded')).toBe('false');
  });

  it('shares ownership across grid and agenda and dismisses a hidden or removed trigger', () => {
    const env = environment();
    const grid = card(env, 'grid', 3);
    const agenda = card(env, 'agenda', 3);
    expect(grid.info.id).not.toBe(agenda.info.id);
    enhanceCalendarInfoCards(scope(env, [grid, agenda]));

    env.click(grid.trigger);
    agenda.trigger.dispatch('pointerenter', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    expect(grid.isOpen()).toBe(true);
    expect(agenda.isOpen()).toBe(false);
    env.click(agenda.trigger);
    expect(grid.isOpen()).toBe(false);
    expect(grid.attrs.get('aria-expanded')).toBe('false');
    expect(agenda.isOpen()).toBe(true);
    expect(agenda.focusCount()).toBe(0);

    agenda.setVisible(false);
    env.resize();
    expect(agenda.isOpen()).toBe(false);

    const replacement = card(env, 'agenda', 3);
    expect(enhanceCalendarInfoCards(scope(env, [replacement]))).toBe(1);
    env.click(replacement.trigger);
    replacement.trigger.isConnected = false;
    env.mutate();
    expect(replacement.isOpen()).toBe(false);
    expect(replacement.attrs.get('aria-expanded')).toBe('false');
  });
});
