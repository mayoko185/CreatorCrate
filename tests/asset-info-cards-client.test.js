import { afterEach, describe, expect, it } from 'vitest';
import {
  dismissActiveGridInfoCard,
  enhanceAssetViewerInfoCards,
  enhanceProjectInfoCards,
} from '../src/static/client/info-cards.js';

function createEnvironment({ width = 320, height = 240 } = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  let mutationCallback = null;
  const windowObject = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type, handler) {
      const handlers = windowListeners.get(type) || [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
    },
  };
  const document = {
    defaultView: windowObject,
    documentElement: { clientWidth: width, clientHeight: height },
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
  };
  return {
    document,
    windowObject,
    dispatchDocument(type, event) {
      (documentListeners.get(type) || []).forEach((handler) => handler(event));
    },
    dispatchWindow(type, event = {}) {
      (windowListeners.get(type) || []).forEach((handler) => handler(event));
    },
    listenerCount(target, type) {
      return (target === 'document' ? documentListeners : windowListeners).get(type)?.length || 0;
    },
    mutate() { mutationCallback?.([]); },
  };
}

function createCard(environment, consumer, rect = { left: 40, top: 40, width: 120, height: 80, bottom: 120 }) {
  const infoSelector = consumer === 'asset' ? '[data-asset-info-card]' : '[data-project-info-card]';
  const previewSelector = consumer === 'asset' ? '[data-asset-viewer-preview]' : '[data-project-grid-preview]';
  const propertyPrefix = consumer === 'asset' ? 'asset' : 'project';
  const previewListeners = new Map();
  const attrs = new Map();
  const styles = new Map();
  let currentRect = { ...rect };
  let popoverOpen = false;
  const info = {
    ownerDocument: environment.document,
    isConnected: true,
    offsetWidth: 100,
    offsetHeight: 60,
    showCount: 0,
    hideCount: 0,
    style: { setProperty(name, value) { styles.set(name, value); } },
    getBoundingClientRect() { return { width: this.offsetWidth, height: this.offsetHeight }; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    matches(selector) { return selector === ':popover-open' && popoverOpen; },
    showPopover() { popoverOpen = true; this.showCount += 1; },
    hidePopover() { popoverOpen = false; this.hideCount += 1; },
  };
  const preview = {
    ownerDocument: environment.document,
    dataset: {},
    querySelector(selector) { return selector === infoSelector ? info : null; },
    getBoundingClientRect() { return currentRect; },
    addEventListener(type, handler) {
      const handlers = previewListeners.get(type) || [];
      handlers.push(handler);
      previewListeners.set(type, handlers);
    },
    contains(target) { return target === info || target?.inside === true; },
  };
  return {
    info,
    preview,
    previewSelector,
    attrs,
    styles,
    propertyPrefix,
    dispatch(type, event = {}) {
      (previewListeners.get(type) || []).forEach((handler) => handler(event));
    },
    listenerCount(type) { return previewListeners.get(type)?.length || 0; },
    setRect(nextRect) { currentRect = { ...nextRect }; },
    isOpen() { return popoverOpen; },
  };
}

function scopeFor(environment, cards) {
  return {
    ownerDocument: environment.document,
    querySelectorAll(selector) {
      return cards.filter((card) => card.previewSelector === selector).map((card) => card.preview);
    },
  };
}

afterEach(() => dismissActiveGridInfoCard());

describe('shared Asset Viewer and Projects grid information cards', () => {
  it.each([
    ['Asset Viewer', 'asset', enhanceAssetViewerInfoCards],
    ['Projects', 'project', enhanceProjectInfoCards],
  ])('%s pointer activation follows movement through the generic enhancer', (_name, consumer, enhance) => {
    const environment = createEnvironment();
    const card = createCard(environment, consumer);
    const scope = scopeFor(environment, [card]);

    expect(enhance(scope)).toBe(1);
    card.dispatch('pointerenter', { clientX: 80, clientY: 70 });
    expect(card.isOpen()).toBe(true);
    expect(card.styles.get(`--${card.propertyPrefix}-info-left`)).toBe('92px');
    expect(card.styles.get(`--${card.propertyPrefix}-info-top`)).toBe('82px');

    card.dispatch('pointermove', { clientX: 110, clientY: 90 });
    expect(card.styles.get(`--${card.propertyPrefix}-info-left`)).toBe('122px');
    expect(card.styles.get(`--${card.propertyPrefix}-info-top`)).toBe('102px');
    expect(card.info.showCount).toBe(1);
  });

  it('flips at right/bottom edges and clamps at left/top edges', () => {
    const environment = createEnvironment({ width: 300, height: 200 });
    const card = createCard(environment, 'asset');
    enhanceAssetViewerInfoCards(scopeFor(environment, [card]));

    card.dispatch('pointerenter', { clientX: 295, clientY: 195 });
    expect(card.styles.get('--asset-info-left')).toBe('183px');
    expect(card.styles.get('--asset-info-top')).toBe('123px');

    card.dispatch('pointermove', { clientX: -20, clientY: -30 });
    expect(card.styles.get('--asset-info-left')).toBe('8px');
    expect(card.styles.get('--asset-info-top')).toBe('8px');
  });

  it('uses a stable preview-relative focus anchor and flips above near the viewport bottom', () => {
    const environment = createEnvironment({ width: 300, height: 200 });
    const card = createCard(environment, 'project', {
      left: 180, top: 150, width: 100, height: 40, bottom: 190,
    });
    enhanceProjectInfoCards(scopeFor(environment, [card]));

    card.dispatch('focusin');
    expect(card.styles.get('--project-info-left')).toBe('180px');
    expect(card.styles.get('--project-info-top')).toBe('82px');
    expect(card.isOpen()).toBe(true);
  });

  it('switches cards, preserves focus-within, and dismisses after pointer and focus leave', () => {
    const environment = createEnvironment();
    const first = createCard(environment, 'asset');
    const second = createCard(environment, 'asset');
    enhanceAssetViewerInfoCards(scopeFor(environment, [first, second]));

    first.dispatch('pointerenter', { clientX: 50, clientY: 50 });
    second.dispatch('pointerenter', { clientX: 180, clientY: 100 });
    expect(first.isOpen()).toBe(false);
    expect(second.isOpen()).toBe(true);

    second.dispatch('focusin');
    second.dispatch('pointerleave');
    expect(second.isOpen()).toBe(true);
    second.dispatch('focusout', { relatedTarget: { inside: true } });
    expect(second.isOpen()).toBe(true);
    second.dispatch('focusout', { relatedTarget: null });
    expect(second.isOpen()).toBe(false);
  });

  it('repositions a focus anchor on resize and scroll but dismisses pointer state on scroll', () => {
    const environment = createEnvironment();
    const card = createCard(environment, 'asset');
    enhanceAssetViewerInfoCards(scopeFor(environment, [card]));
    card.dispatch('focusin');
    card.setRect({ left: 80, top: 50, width: 120, height: 80, bottom: 130 });
    environment.dispatchWindow('resize');
    expect(card.styles.get('--asset-info-left')).toBe('90px');
    environment.dispatchWindow('scroll');
    expect(card.isOpen()).toBe(true);

    card.dispatch('focusout', { relatedTarget: null });
    card.dispatch('pointerenter', { clientX: 100, clientY: 100 });
    environment.dispatchWindow('scroll');
    expect(card.isOpen()).toBe(false);
  });

  it('does not duplicate handlers and cleans up removal, modal triggers, and replacement enhancement', () => {
    const environment = createEnvironment();
    const card = createCard(environment, 'project');
    const scope = scopeFor(environment, [card]);
    expect(enhanceProjectInfoCards(scope)).toBe(1);
    expect(enhanceProjectInfoCards(scope)).toBe(0);
    expect(card.listenerCount('pointermove')).toBe(1);
    expect(environment.listenerCount('window', 'resize')).toBe(1);
    expect(environment.listenerCount('document', 'click')).toBe(1);

    card.dispatch('pointerenter', { clientX: 100, clientY: 100 });
    environment.dispatchDocument('click', {
      target: { closest: (selector) => selector === '[data-dialog-open]' ? {} : null },
    });
    expect(card.isOpen()).toBe(false);

    card.dispatch('pointerenter', { clientX: 100, clientY: 100 });
    card.info.isConnected = false;
    environment.mutate();
    expect(card.attrs.has('data-info-card-open')).toBe(false);

    const replacement = createCard(environment, 'project');
    expect(enhanceProjectInfoCards(scopeFor(environment, [replacement]))).toBe(1);
    expect(replacement.listenerCount('pointerenter')).toBe(1);
  });
});
