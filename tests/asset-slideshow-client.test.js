import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enhanceDropdowns,
  enhanceProjectAssetsPreviewSlideshow,
  enhanceSlideshow,
} from '../src/static/creatorcrate.js';

const _cssDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(_cssDir, '../src/static/creatorcrate.css'), 'utf-8');

function toDatasetKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function makeNode({ tagName = 'div', attrs = {}, textContent = '' } = {}) {
  const listeners = [];
  const attributes = new Map();
  const children = [];
  let storedTextContent = textContent;
  const node = {
    tagName: tagName.toUpperCase(),
    dataset: {},
    children,
    parentElement: null,
    parentNode: null,
    ownerDocument: null,
    listeners,
    get textContent() {
      return children.length ? children.map((child) => child.textContent).join('') : storedTextContent;
    },
    set textContent(value) { storedTextContent = value; },
    hidden: false,
    inert: false,
    disabled: false,
    focused: false,
    focusCalls: [],
    src: '',
    value: '',
    style: {
      width: '',
      height: '',
      transform: '',
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    },
    clientWidth: 0,
    clientHeight: 0,
    naturalWidth: 0,
    naturalHeight: 0,
    complete: false,
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    setAttribute(name, value) {
      const stringValue = String(value);
      attributes.set(name, stringValue);
      if (name === 'hidden') this.hidden = true;
      if (name === 'inert') this.inert = true;
      if (name === 'disabled') this.disabled = true;
      if (name.startsWith('data-')) this.dataset[toDatasetKey(name)] = stringValue;
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
      if (name === 'inert') this.inert = false;
      if (name === 'disabled') this.disabled = false;
      if (name.startsWith('data-')) delete this.dataset[toDatasetKey(name)];
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        let candidate = part.trim();
        let requiresChecked = false;
        if (candidate.endsWith(':checked')) {
          requiresChecked = true;
          candidate = candidate.slice(0, -':checked'.length);
        }
        if (requiresChecked && this.checked !== true) return false;
        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const attrsInSelector = [...candidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
        return attrsInSelector.every(([, attrName, expected]) => {
          const actual = this.getAttribute(attrName);
          return actual !== null && (expected === undefined || actual === expected);
        });
      });
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    appendChild(child) {
      children.push(child);
      child.parentElement = this;
      child.parentNode = this;
      if (!child.ownerDocument) {
        const doc = this.ownerDocument || (this.tagName === 'DOCUMENT' ? this : null);
        if (doc) {
          const adopt = (n) => { n.ownerDocument = doc; n.children.forEach(adopt); };
          adopt(child);
        }
      }
      return child;
    },
    addEventListener(type, handler, options = {}) {
      listeners.push({ type, handler, capture: options === true || options?.capture === true });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((listener) => listener.type === type && listener.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    querySelectorAll(selector) {
      const results = [];
      const visit = (n) => {
        n.children.forEach((child) => {
          if (child.matches?.(selector)) results.push(child);
          visit(child);
        });
      };
      visit(this);
      return results;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    focus(options) {
      const previous = this.ownerDocument?.activeElement;
      if (previous === this) return;
      this.focused = true;
      this.focusCalls.push(options);
      if (previous) previous.dispatch('focusout', { relatedTarget: this });
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
      this.dispatch('focusin', { relatedTarget: previous });
    },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: props.target || this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this._stopped = true; },
        ...props,
      };
      const path = [];
      let current = this;
      while (current) { path.push(current); current = current.parentElement; }
      for (let i = path.length - 1; i >= 0 && !event._stopped; i--) {
        path[i].listeners
          .filter((l) => l.type === type && l.capture)
          .forEach((l) => l.handler(event));
      }
      for (let i = 0; i < path.length && !event._stopped; i++) {
        path[i].listeners
          .filter((l) => l.type === type && !l.capture)
          .forEach((l) => l.handler(event));
      }
      return event;
    },
  };

  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  node.textContent = textContent;
  return node;
}

function makeDocument() {
  const document = makeNode({ tagName: 'document' });
  document.ownerDocument = document;
  document.activeElement = null;
  document.createElement = (tagName) => {
    const el = makeNode({ tagName });
    el.ownerDocument = document;
    return el;
  };
  return document;
}

function makeSequenceScript(sequence) {
  const el = makeNode({ tagName: 'script', attrs: { 'data-slideshow-sequence': '' } });
  el.textContent = JSON.stringify(sequence);
  return el;
}

function makeSlideshowPage(sequence = [], { fullscreen = false, standardSpeed = false } = {}) {
  const document = makeDocument();

  const trigger = makeNode({ tagName: 'button', attrs: {
    'data-slideshow-trigger': '',
    'aria-label': 'Start slideshow',
    'data-tooltip': 'Start slideshow',
  } });

  const scaffold = makeNode({ attrs: {
    'data-slideshow-scaffold': '',
    hidden: '',
    inert: '',
    role: 'dialog',
    'aria-modal': 'true',
  } });

  const sequenceScript = makeSequenceScript(sequence);
  const preview = makeNode({ attrs: { 'data-slideshow-preview': '' } });
  const prevBtn = makeNode({ tagName: 'button', attrs: { 'data-slideshow-prev': '', 'aria-label': 'Previous' } });
  const status = makeNode({ tagName: 'span', attrs: { 'data-slideshow-status': '' } });
  const nextBtn = makeNode({ tagName: 'button', attrs: { 'data-slideshow-next': '', 'aria-label': 'Next' } });
  const playPauseBtn = makeNode({ tagName: 'button', attrs: { 'data-slideshow-play-pause': '', 'aria-label': 'Play' } });
  const speedSelect = makeNode({ tagName: 'select', attrs: { 'data-slideshow-speed': '' } });
  const speedOptions = [
    makeNode({ tagName: 'option', attrs: { value: '2000' }, textContent: '2 s' }),
    makeNode({ tagName: 'option', attrs: { value: '4000', selected: '' }, textContent: '4 s' }),
    makeNode({ tagName: 'option', attrs: { value: '6000' }, textContent: '6 s' }),
  ];
  speedOptions.forEach((option) => speedSelect.appendChild(option));
  speedSelect.value = '4000';
  let speedField = null;
  let speedDropdown = null;
  let speedSummary = null;
  let speedInputs = [];
  if (standardSpeed) {
    speedField = makeNode({ tagName: 'fieldset', attrs: { class: 'field asset-filter-multiselect-field cc-dropdown-field--compact' } });
    speedDropdown = makeNode({ tagName: 'details', attrs: {
      'data-cc-dropdown': '',
      'data-cc-dropdown-mode': 'single',
      'data-cc-dropdown-dispatch-native-change': '',
    } });
    speedSummary = makeNode({ tagName: 'summary', attrs: {
      'aria-label': 'Slideshow speed: 4 s',
      'aria-expanded': 'false',
      title: '4 s',
    } });
    const speedSummaryText = makeNode({ attrs: { class: 'asset-filter-multiselect-summary' } });
    const speedCurrent = makeNode({
      attrs: { 'data-cc-dropdown-summary-current': '' },
      textContent: '4 s',
    });
    speedSummaryText.appendChild(speedCurrent);
    speedSummary.appendChild(speedSummaryText);
    const speedPanel = makeNode({ tagName: 'div', attrs: { class: 'asset-filter-multiselect-panel' } });
    speedOptions.forEach((option) => {
      const optionValue = option.getAttribute('value');
      const wrapper = makeNode({ attrs: { class: 'asset-filter-multiselect-option' } });
      const label = makeNode({ tagName: 'label' });
      const input = makeNode({ tagName: 'input', attrs: {
        type: 'radio',
        value: optionValue,
      } });
      input.type = 'radio';
      input.value = optionValue;
      input.checked = optionValue === '4000';
      const labelText = makeNode({ tagName: 'span', textContent: option.textContent });
      label.appendChild(input);
      label.appendChild(labelText);
      wrapper.appendChild(label);
      speedPanel.appendChild(wrapper);
      speedInputs.push(input);
    });
    speedSelect.setAttribute('data-cc-dropdown-native-select', '');
    speedSelect.dispatchEvent = vi.fn((event) => speedSelect.dispatch(event.type));
    speedDropdown.appendChild(speedSummary);
    speedDropdown.appendChild(speedPanel);
    speedField.appendChild(speedSelect);
    speedField.appendChild(speedDropdown);
  }
  const fullscreenBtn = makeNode({ tagName: 'button', attrs: {
    'data-slideshow-fullscreen': '',
    'aria-label': 'Enter fullscreen',
    'data-tooltip': 'Enter fullscreen',
    'aria-pressed': 'false',
  } });
  const closeBtn = makeNode({ tagName: 'button', attrs: { 'data-slideshow-close': '', 'aria-label': 'Close slideshow', 'data-tooltip': 'Close slideshow' } });
  const originalSizeBtn = makeNode({ tagName: 'button', attrs: {
    'data-slideshow-original-size': '',
    'aria-label': 'View original size',
    'data-tooltip': 'View original size',
    'aria-pressed': 'false',
  } });
  const mediaStatus = makeNode({ tagName: 'span', attrs: {
    'data-slideshow-media-status': '',
    role: 'status',
    hidden: '',
  } });

  scaffold.appendChild(sequenceScript);
  scaffold.appendChild(preview);
  scaffold.appendChild(prevBtn);
  scaffold.appendChild(status);
  scaffold.appendChild(nextBtn);
  scaffold.appendChild(playPauseBtn);
  scaffold.appendChild(standardSpeed ? speedField : speedSelect);
  scaffold.appendChild(fullscreenBtn);
  scaffold.appendChild(originalSizeBtn);
  scaffold.appendChild(closeBtn);
  scaffold.appendChild(mediaStatus);

  if (fullscreen) {
    document.fullscreenElement = null;
    scaffold.requestFullscreen = vi.fn(() => {
      document.fullscreenElement = scaffold;
      document.dispatch('fullscreenchange');
      return Promise.resolve();
    });
    document.exitFullscreen = vi.fn(() => {
      document.fullscreenElement = null;
      document.dispatch('fullscreenchange');
      return Promise.resolve();
    });
  }

  document.appendChild(trigger);
  document.appendChild(scaffold);

  return {
    document,
    trigger,
    scaffold,
    sequenceScript,
    preview,
    prevBtn,
    status,
    nextBtn,
    playPauseBtn,
    speedSelect,
    speedOptions,
    speedField,
    speedDropdown,
    speedSummary,
    speedInputs,
    fullscreenBtn,
    closeBtn,
    originalSizeBtn,
    mediaStatus,
  };
}

function makeProjectPreviewPage(sequence) {
  const page = makeSlideshowPage(sequence);
  page.previewLinks = sequence.map((item) => {
    const link = makeNode({ tagName: 'a', attrs: {
      href: item.viewerUrl,
      'data-project-assets-preview-id': String(item.id),
    } });
    page.document.appendChild(link);
    return link;
  });
  enhanceSlideshow(page.document);
  enhanceProjectAssetsPreviewSlideshow(page.document);
  return page;
}

// ─── Sequence parsing ────────────────────────────────────────────────────────

describe('enhanceSlideshow — sequence parsing', () => {
  it('parses a valid sequence and returns 1', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document } = makeSlideshowPage(seq);
    expect(enhanceSlideshow(document)).toBe(1);
  });

  it('malformed JSON fails closed without throwing', () => {
    const { document, trigger, sequenceScript } = makeSlideshowPage([]);
    sequenceScript.textContent = '{not json at all}';
    expect(() => enhanceSlideshow(document)).not.toThrow();
    expect(trigger.disabled).toBe(true);
  });

  it('non-array JSON (object) fails closed without throwing', () => {
    const { document, trigger, sequenceScript } = makeSlideshowPage([]);
    sequenceScript.textContent = '{"id": 1}';
    expect(() => enhanceSlideshow(document)).not.toThrow();
    expect(trigger.disabled).toBe(true);
  });

  it('null JSON fails closed without throwing', () => {
    const { document, trigger, sequenceScript } = makeSlideshowPage([]);
    sequenceScript.textContent = 'null';
    expect(() => enhanceSlideshow(document)).not.toThrow();
    expect(trigger.disabled).toBe(true);
  });

  it('empty sequence disables the trigger', () => {
    const { document, trigger } = makeSlideshowPage([]);
    enhanceSlideshow(document);
    expect(trigger.disabled).toBe(true);
  });

  it('non-empty sequence leaves trigger enabled', () => {
    const { document, trigger } = makeSlideshowPage([
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    ]);
    enhanceSlideshow(document);
    expect(trigger.disabled).toBe(false);
  });

  it('returns 0 when no trigger is present', () => {
    const document = makeDocument();
    expect(enhanceSlideshow(document)).toBe(0);
  });

  it('returns 0 when no scaffold is present', () => {
    const document = makeDocument();
    document.appendChild(makeNode({ tagName: 'button', attrs: { 'data-slideshow-trigger': '' } }));
    expect(enhanceSlideshow(document)).toBe(0);
  });
});

// ─── Opening ────────────────────────────────────────────────────────────────

describe('enhanceSlideshow — opening', () => {
  it('removes hidden and inert from scaffold on open', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document, trigger, scaffold } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    expect(scaffold.hidden).toBe(false);
    expect(scaffold.hasAttribute('hidden')).toBe(false);
    expect(scaffold.inert).toBe(false);
    expect(scaffold.hasAttribute('inert')).toBe(false);
  });

  it('opens on the first item', () => {
    const seq = [
      { id: 1, filename: 'first.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'second.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { document, trigger, preview } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    const img = preview.children[0];
    expect(img.src).toBe('/p/1');
  });

  it('renders previewUrl — not original or thumbnail', () => {
    const seq = [{ id: 1, filename: 'img.png', previewUrl: '/preview/1?v=abc', viewerUrl: '/v/1' }];
    const { document, trigger, preview } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    const img = preview.children[0];
    expect(img.src).toBe('/preview/1?v=abc');
    expect(img.src).not.toContain('/original');
  });

  it('status starts at "1 of N" on open', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
      { id: 3, filename: 'c.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
    ];
    const { document, trigger, status } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    expect(status.textContent).toBe('1 of 3');
  });

  it('sets aria-expanded="true" on trigger when opened', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document, trigger } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves focus to the close button on open', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document, trigger, closeBtn } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    expect(closeBtn.focused).toBe(true);
  });

  it('exposes filename as image alt text', () => {
    const seq = [{ id: 1, filename: 'my-art.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document, trigger, preview } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    expect(preview.children[0].getAttribute('alt')).toBe('my-art.png');
  });

  it('exposes filename as visible caption', () => {
    const seq = [{ id: 1, filename: 'my-art.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document, trigger, preview } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    trigger.dispatch('click');
    expect(preview.children[1].textContent).toBe('my-art.png');
  });
});

describe('project-assets preview slideshow opt-in', () => {
  const sequence = [
    { id: 1, filename: 'first.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'second.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
  ];

  it('opens only the clicked project asset and prevents the detail-link navigation', () => {
    const page = makeProjectPreviewPage(sequence);
    const event = page.previewLinks[1].dispatch('click');

    expect(event.defaultPrevented).toBe(true);
    expect(page.status.textContent).toBe('1 of 1');
    expect(page.preview.children[0].src).toBe('/p/2');
    expect(page.prevBtn.disabled).toBe(true);
    expect(page.nextBtn.disabled).toBe(true);
    page.document.dispatch('keydown', { key: 'ArrowRight' });
    page.document.dispatch('keydown', { key: 'ArrowLeft' });
    expect(page.status.textContent).toBe('1 of 1');
  });

  it('restores the full sequence after closing the single-asset slideshow', () => {
    const page = makeProjectPreviewPage(sequence);
    page.previewLinks[0].dispatch('click');
    page.closeBtn.dispatch('click');

    expect(page.previewLinks[0].focused).toBe(true);
    page.trigger.dispatch('click');
    expect(page.status.textContent).toBe('1 of 2');
    page.nextBtn.dispatch('click');
    expect(page.status.textContent).toBe('2 of 2');
  });

  it('uses the newly clicked asset after a previous single-asset close', () => {
    const page = makeProjectPreviewPage(sequence);
    page.previewLinks[0].dispatch('click');
    page.closeBtn.dispatch('click');
    page.previewLinks[1].dispatch('click');

    expect(page.status.textContent).toBe('1 of 1');
    expect(page.preview.children[0].src).toBe('/p/2');
  });

  it('keeps a refreshed normal sequence isolated until the single asset closes', () => {
    const page = makeProjectPreviewPage(sequence);
    page.previewLinks[0].dispatch('click');
    page.scaffold.__creatorCrateSlideshowState.refreshSequence([
      ...sequence,
      { id: 3, filename: 'third.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
    ]);

    expect(page.status.textContent).toBe('1 of 1');
    page.closeBtn.dispatch('click');
    page.trigger.dispatch('click');
    expect(page.status.textContent).toBe('1 of 3');
    page.nextBtn.dispatch('click');
    expect(page.status.textContent).toBe('2 of 3');
  });

  it('does not bind the same preview twice when enhancement repeats', () => {
    const page = makeProjectPreviewPage(sequence);
    expect(enhanceProjectAssetsPreviewSlideshow(page.document)).toBe(2);
    page.previewLinks[0].dispatch('click');

    expect(page.status.textContent).toBe('1 of 1');
  });
});

// ─── Navigation ─────────────────────────────────────────────────────────────

function openPage(seq, options) {
  const page = makeSlideshowPage(seq, options);
  enhanceSlideshow(page.document);
  page.trigger.dispatch('click');
  return page;
}

function openStandardSpeedPage(seq) {
  const page = makeSlideshowPage(seq, { standardSpeed: true });
  enhanceDropdowns(page.document);
  enhanceSlideshow(page.document);
  page.trigger.dispatch('click');
  return page;
}

function openOriginalPage(seq, options = {}, viewport = { width: 800, height: 600 }) {
  const page = openPage(seq, options);
  page.preview.clientWidth = viewport.width;
  page.preview.clientHeight = viewport.height;
  return page;
}

function loadOriginal(page, { width = 1600, height = 1200 } = {}) {
  page.originalSizeBtn.dispatch('click');
  const originalImage = page.preview.children[2];
  originalImage.naturalWidth = width;
  originalImage.naturalHeight = height;
  originalImage.dispatch('load');
  return originalImage;
}

describe('enhanceSlideshow — speed dropdown tooltip', () => {
  const sequence = [
    { id: 1, filename: 'first.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'second.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
  ];

  it('uses the slideshow custom tooltip and restores it after the shared summary updater runs', () => {
    const page = openStandardSpeedPage(sequence);
    const speedCurrent = page.speedSummary.querySelector('[data-cc-dropdown-summary-current]');

    expect(page.speedSummary.getAttribute('class')).toContain('asset-tooltip');
    expect(page.speedSummary.getAttribute('class')).toContain('asset-tooltip--top');
    expect(page.speedSummary.getAttribute('data-tooltip')).toBe(speedCurrent.textContent);
    expect(page.speedSummary.hasAttribute('title')).toBe(false);

    page.speedSelect.value = '6000';
    speedCurrent.textContent = '6 s';
    page.speedSummary.setAttribute('title', '6 s'); // Shared dropdown summary updater.
    page.speedSelect.dispatch('change');

    expect(speedCurrent.textContent).toBe('6 s');
    expect(page.speedSummary.getAttribute('data-tooltip')).toBe('6 s');
    expect(page.speedSummary.hasAttribute('title')).toBe(false);
  });

  it('does not regain the native title after selecting a speed through the enhanced dropdown', () => {
    const page = openStandardSpeedPage(sequence);
    const speedCurrent = page.speedSummary.querySelector('[data-cc-dropdown-summary-current]');
    const sixSecondRadio = page.speedInputs.find((input) => input.value === '6000');

    sixSecondRadio.checked = true;
    sixSecondRadio.dispatch('change');

    expect(speedCurrent.textContent).toBe('6 s');
    expect(page.speedSummary.getAttribute('aria-label')).toBe('Slideshow speed: 6 s');
    expect(page.speedSummary.getAttribute('data-tooltip')).toBe('6 s');
    expect(page.speedSummary.hasAttribute('title')).toBe(false);
    expect(page.speedSummary.getAttribute('class')).toContain('asset-tooltip');
    expect(page.speedSummary.getAttribute('class')).toContain('asset-tooltip--top');
    expect(page.speedDropdown.hasAttribute('open')).toBe(false);
    expect(page.speedSummary.focused).toBe(true);
  });

  it('keeps the corrected tooltip while the speed control is hidden in single-image mode', () => {
    const page = openStandardSpeedPage([{ id: 1, filename: 'only.png', previewUrl: '/p/1', viewerUrl: '/v/1' }]);

    expect(page.speedField.hidden).toBe(true);
    expect(page.speedSelect.disabled).toBe(true);
    expect(page.speedSummary.disabled).toBe(true);
    expect(page.speedSummary.hasAttribute('title')).toBe(false);
    expect(page.speedSummary.getAttribute('class')).toContain('asset-tooltip--top');
    expect(page.speedSummary.getAttribute('data-tooltip')).toBe('4 s');
  });

  it('keeps the corrected tooltip through idle chrome hiding and activity reveal', () => {
    vi.useFakeTimers();
    try {
      const page = openStandardSpeedPage(sequence);

      expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
      vi.advanceTimersByTime(4000);
      expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
      expect(page.speedField.hidden).toBe(false);
      expect(page.speedSummary.hasAttribute('title')).toBe(false);

      page.preview.dispatch('pointermove');
      expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
      expect(page.speedSummary.getAttribute('data-tooltip')).toBe('4 s');
      expect(page.speedSummary.hasAttribute('title')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('enhanceSlideshow — single-image controls', () => {
  const singleSequence = [
    { id: 1, filename: 'only.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
  ];
  const multiSequence = [
    { id: 1, filename: 'first.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'second.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
  ];

  it('hides genuine single-image controls, disables them, and excludes them from focus', () => {
    const page = openStandardSpeedPage(singleSequence);

    expect(page.prevBtn.hidden).toBe(true);
    expect(page.nextBtn.hidden).toBe(true);
    expect(page.playPauseBtn.hidden).toBe(true);
    expect(page.status.hidden).toBe(true);
    expect(page.speedField.hidden).toBe(true);
    expect(page.prevBtn.disabled).toBe(true);
    expect(page.nextBtn.disabled).toBe(true);
    expect(page.playPauseBtn.disabled).toBe(true);
    expect(page.speedSelect.disabled).toBe(true);
    expect(page.speedSummary.disabled).toBe(true);

    page.closeBtn.focus();
    page.document.dispatch('keydown', { key: 'Tab' });
    expect(page.document.activeElement).toBe(page.closeBtn);
    page.document.dispatch('keydown', { key: 'Tab', shiftKey: true });
    expect(page.document.activeElement).toBe(page.closeBtn);
  });

  it('restores multi-image controls and their normal enabled state', () => {
    const page = openStandardSpeedPage(multiSequence);

    expect(page.prevBtn.hidden).toBe(false);
    expect(page.nextBtn.hidden).toBe(false);
    expect(page.playPauseBtn.hidden).toBe(false);
    expect(page.status.hidden).toBe(false);
    expect(page.speedField.hidden).toBe(false);
    expect(page.prevBtn.disabled).toBe(false);
    expect(page.nextBtn.disabled).toBe(false);
    expect(page.playPauseBtn.disabled).toBe(false);
    expect(page.speedSelect.disabled).toBe(false);
    expect(page.speedSummary.disabled).toBe(false);
  });

  it('resynchronizes controls for temporary and refreshed one-item sequences', () => {
    const page = makeProjectPreviewPage(multiSequence);

    page.previewLinks[0].dispatch('click');
    expect(page.playPauseBtn.hidden).toBe(true);
    expect(page.speedSelect.hidden).toBe(true);

    page.closeBtn.dispatch('click');
    expect(page.playPauseBtn.hidden).toBe(false);
    expect(page.speedSelect.hidden).toBe(false);

    page.trigger.dispatch('click');
    page.scaffold.__creatorCrateSlideshowState.refreshSequence([multiSequence[0]]);
    expect(page.prevBtn.hidden).toBe(true);
    expect(page.nextBtn.hidden).toBe(true);
    expect(page.status.hidden).toBe(true);

    page.scaffold.__creatorCrateSlideshowState.refreshSequence(multiSequence);
    expect(page.prevBtn.hidden).toBe(false);
    expect(page.nextBtn.hidden).toBe(false);
    expect(page.status.hidden).toBe(false);
  });
});

// ─── Original-size inspection ─────────────────────────────────────────────────

describe('enhanceSlideshow — original-size inspection', () => {
  const imageSequence = [
    {
      id: 1,
      filename: 'a.png',
      previewUrl: '/preview/1?v=abc',
      viewerUrl: '/v/1',
      originalUrl: '/original/1',
    },
    {
      id: 2,
      filename: 'b.jpg',
      previewUrl: '/preview/2?v=def',
      viewerUrl: '/v/2',
      originalUrl: '/original/2',
    },
  ];

  it('exposes a stateful Original Size control for eligible images', () => {
    const page = openOriginalPage(imageSequence);
    expect(page.originalSizeBtn.disabled).toBe(false);
    expect(page.originalSizeBtn.getAttribute('aria-label')).toBe('View original size');
    expect(page.originalSizeBtn.getAttribute('data-tooltip')).toBe('View original size');
    expect(page.originalSizeBtn.hasAttribute('title')).toBe(false);
    expect(page.originalSizeBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking a fitted single image enters Original Size despite its internal playing state', () => {
    const page = openOriginalPage([imageSequence[0]]);
    const fittedImage = page.preview.children[0];

    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    fittedImage.dispatch('click');

    expect(page.preview.getAttribute('data-slideshow-mode')).toBe('original');
    expect(page.preview.children[2].src).toBe('/original/1');
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Play');
  });

  it('clicking a fitted paused multi-image slideshow enters Original Size', () => {
    const page = openOriginalPage(imageSequence);
    page.playPauseBtn.dispatch('click');
    page.preview.children[0].dispatch('click');

    expect(page.preview.getAttribute('data-slideshow-mode')).toBe('original');
    expect(page.preview.children[2].src).toBe('/original/1');
  });

  it('keeps an actively playing multi-image slideshow unchanged when its fitted image is clicked', () => {
    vi.useFakeTimers();
    const page = openOriginalPage(imageSequence);

    page.preview.children[0].dispatch('click');

    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.preview.children).toHaveLength(2);
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    expect(vi.getTimerCount()).toBe(2);
    vi.useRealTimers();
  });

  it('ignores fitted-image clicks without an available original source', () => {
    const page = openOriginalPage([{
      id: 1,
      filename: 'design.kra',
      previewUrl: '/preview/1?v=abc',
      viewerUrl: '/v/1',
    }]);

    page.preview.children[0].dispatch('click');

    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.preview.children).toHaveLength(2);
  });

  it('does not exit Original Size when the fitted image receives a click', () => {
    const page = openOriginalPage([imageSequence[0]]);
    const originalImage = loadOriginal(page);

    page.preview.children[0].dispatch('click');

    expect(page.preview.getAttribute('data-slideshow-mode')).toBe('original');
    expect(originalImage.src).toBe('/original/1');
  });

  it('ignores modified and non-primary fitted-image clicks', () => {
    const page = openOriginalPage([imageSequence[0]]);
    const fittedImage = page.preview.children[0];

    fittedImage.dispatch('click', { ctrlKey: true });
    fittedImage.dispatch('click', { button: 1 });

    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.preview.children).toHaveLength(2);
  });

  it('keeps the fitted-image zoom affordance synchronized with eligibility', () => {
    const single = openOriginalPage([imageSequence[0]]);
    expect(single.preview.hasAttribute('data-slideshow-image-zoomable')).toBe(true);

    const paused = openOriginalPage(imageSequence);
    paused.playPauseBtn.dispatch('click');
    expect(paused.preview.hasAttribute('data-slideshow-image-zoomable')).toBe(true);

    const playing = openOriginalPage(imageSequence);
    expect(playing.preview.hasAttribute('data-slideshow-image-zoomable')).toBe(false);

    const unavailable = openOriginalPage([{
      id: 1,
      filename: 'design.kra',
      previewUrl: '/preview/1?v=abc',
      viewerUrl: '/v/1',
    }]);
    expect(unavailable.preview.hasAttribute('data-slideshow-image-zoomable')).toBe(false);

    const original = openOriginalPage([imageSequence[0]]);
    loadOriginal(original);
    expect(original.preview.hasAttribute('data-slideshow-image-zoomable')).toBe(false);
  });

  it('loads no original source until the user enters Original Size', () => {
    const page = openPage(imageSequence);
    expect(page.preview.children).toHaveLength(2);
    page.originalSizeBtn.dispatch('click');
    expect(page.preview.children).toHaveLength(3);
    expect(page.preview.children[2].src).toBe('/original/1');
    expect(page.preview.children[0].src).toBe('/preview/1?v=abc');
  });

  it('entering Original Size immediately stops autoplay and shows loading state', () => {
    vi.useFakeTimers();
    const page = openPage(imageSequence);
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    page.originalSizeBtn.dispatch('click');
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Play');
    expect(page.playPauseBtn.hasAttribute('data-slideshow-playing')).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(page.mediaStatus.textContent).toBe('Loading original...');
    vi.advanceTimersByTime(8000);
    expect(page.status.textContent).toBe('1 of 2');
    vi.useRealTimers();
  });

  it('retains the preview while the original is loading', () => {
    const page = openPage(imageSequence);
    page.originalSizeBtn.dispatch('click');
    expect(page.preview.children[0].src).toBe('/preview/1?v=abc');
    expect(page.preview.hasAttribute('data-slideshow-original-loaded')).toBe(false);
    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(true);
  });

  it('switches to the loaded original at intrinsic dimensions', () => {
    const page = openOriginalPage(imageSequence);
    const originalImage = loadOriginal(page, { width: 1600, height: 1200 });
    expect(page.preview.getAttribute('data-slideshow-mode')).toBe('original');
    expect(page.preview.hasAttribute('data-slideshow-original-loaded')).toBe(true);
    expect(originalImage.style.width).toBe('1600px');
    expect(originalImage.style.height).toBe('1200px');
    expect(originalImage.getAttribute('alt')).toBe('a.png');
    expect(page.originalSizeBtn.getAttribute('aria-label')).toBe('Fit to screen');
    expect(page.originalSizeBtn.getAttribute('data-tooltip')).toBe('Fit to screen');
    expect(page.originalSizeBtn.getAttribute('aria-pressed')).toBe('true');
    expect(page.mediaStatus.hidden).toBe(true);
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Play');
  });

  it('Fit to screen restores preview mode and remains paused', () => {
    vi.useFakeTimers();
    const page = openOriginalPage(imageSequence);
    const originalImage = loadOriginal(page);
    page.originalSizeBtn.dispatch('click');
    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.preview.hasAttribute('data-slideshow-original-loaded')).toBe(false);
    expect(page.preview.children[0].src).toBe('/preview/1?v=abc');
    expect(originalImage.getAttribute('src')).toBeNull();
    expect(page.originalSizeBtn.getAttribute('aria-label')).toBe('View original size');
    expect(page.originalSizeBtn.getAttribute('aria-pressed')).toBe('false');
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Play');
    expect(vi.getTimerCount()).toBe(1);
    vi.useRealTimers();
  });

  it('falls back to fit mode with a readable status when original loading fails', () => {
    const page = openOriginalPage(imageSequence);
    page.originalSizeBtn.dispatch('click');
    page.preview.children[2].dispatch('error');
    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.preview.children[0].src).toBe('/preview/1?v=abc');
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Play');
    expect(page.mediaStatus.textContent).toBe('Original size unavailable; showing fit to screen.');
  });

  it('navigation exits Original Size first and remains paused', () => {
    const page = openOriginalPage(imageSequence);
    loadOriginal(page);
    page.nextBtn.dispatch('click');
    expect(page.status.textContent).toBe('2 of 2');
    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.preview.children[0].src).toBe('/preview/2?v=def');
    expect(page.originalSizeBtn.getAttribute('aria-label')).toBe('View original size');
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Play');
  });

  it('arrow navigation exits Original Size first and remains paused', () => {
    const page = openOriginalPage(imageSequence);
    loadOriginal(page);
    const event = page.document.dispatch('keydown', { key: 'ArrowRight' });
    expect(event.defaultPrevented).toBe(true);
    expect(page.status.textContent).toBe('2 of 2');
    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Play');
  });

  it('close resets Original Size and reopen returns to first item with autoplay', () => {
    vi.useFakeTimers();
    const page = openOriginalPage(imageSequence);
    loadOriginal(page);
    page.nextBtn.dispatch('click');
    page.originalSizeBtn.dispatch('click');
    loadOriginal(page, { width: 900, height: 700 });
    page.closeBtn.dispatch('click');
    expect(page.preview.hasAttribute('data-slideshow-mode')).toBe(false);
    expect(page.preview.hasAttribute('data-slideshow-pan-enabled')).toBe(false);
    page.trigger.dispatch('click');
    expect(page.status.textContent).toBe('1 of 2');
    expect(page.preview.children[0].src).toBe('/preview/1?v=abc');
    expect(page.originalSizeBtn.getAttribute('aria-label')).toBe('View original size');
    expect(page.playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    expect(vi.getTimerCount()).toBe(2);
    vi.useRealTimers();
  });

  it('disables Original Size for an entry without an original image URL', () => {
    const page = openPage([{
      id: 1,
      filename: 'design.kra',
      previewUrl: '/preview/1?v=abc',
      viewerUrl: '/v/1',
    }]);
    expect(page.originalSizeBtn.disabled).toBe(true);
    expect(page.originalSizeBtn.getAttribute('aria-label')).toBe('Original size unavailable');
  });
});

// ─── Original-size panning ────────────────────────────────────────────────────

describe('enhanceSlideshow — original-size panning', () => {
  const sequence = [{
    id: 1,
    filename: 'large.png',
    previewUrl: '/preview/1?v=abc',
    viewerUrl: '/v/1',
    originalUrl: '/original/1',
  }];

  function loadedPage(dimensions = { width: 1600, height: 1200 }, viewport = { width: 800, height: 600 }) {
    const page = openOriginalPage(sequence, {}, viewport);
    const originalImage = loadOriginal(page, dimensions);
    return { page, originalImage };
  }

  it('pans an oversized image horizontally with direct pointer movement', () => {
    const { page, originalImage } = loadedPage();
    const down = page.preview.dispatch('pointerdown', {
      pointerId: 7, button: 0, clientX: 100, clientY: 100,
    });
    expect(down.defaultPrevented).toBe(true);
    page.preview.dispatch('pointermove', { pointerId: 7, clientX: 250, clientY: 100 });
    expect(originalImage.style.transform).toContain('150px');
    expect(page.preview.hasAttribute('data-slideshow-dragging')).toBe(true);
    page.preview.dispatch('pointerup', { pointerId: 7, clientX: 250, clientY: 100 });
    expect(page.preview.hasAttribute('data-slideshow-dragging')).toBe(false);
    expect(page.preview.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('pans an oversized image vertically and keeps a fitting axis centered', () => {
    const { page, originalImage } = loadedPage({ width: 800, height: 1600 });
    page.preview.dispatch('pointerdown', {
      pointerId: 8, button: 0, clientX: 100, clientY: 100,
    });
    page.preview.dispatch('pointermove', { pointerId: 8, clientX: 300, clientY: 350 });
    expect(originalImage.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 250px))');
  });

  it('clamps pan offsets to the image/viewport half-difference', () => {
    const { page, originalImage } = loadedPage();
    page.preview.dispatch('pointerdown', {
      pointerId: 9, button: 0, clientX: 0, clientY: 0,
    });
    page.preview.dispatch('pointermove', { pointerId: 9, clientX: 5000, clientY: -5000 });
    expect(originalImage.style.transform).toBe('translate(calc(-50% + 400px), calc(-50% + -300px))');
  });

  it('pointercancel ends dragging and releases captured pointer', () => {
    const { page } = loadedPage();
    page.preview.dispatch('pointerdown', {
      pointerId: 10, button: 0, clientX: 0, clientY: 0,
    });
    expect(page.preview.hasAttribute('data-slideshow-dragging')).toBe(true);
    page.preview.dispatch('pointercancel', { pointerId: 10 });
    expect(page.preview.hasAttribute('data-slideshow-dragging')).toBe(false);
    expect(page.preview.releasePointerCapture).toHaveBeenCalledWith(10);
  });

  it('resets pan and pointer state when returning to fit mode', () => {
    const { page, originalImage } = loadedPage();
    page.preview.dispatch('pointerdown', {
      pointerId: 11, button: 0, clientX: 0, clientY: 0,
    });
    page.preview.dispatch('pointermove', { pointerId: 11, clientX: 200, clientY: 100 });
    page.originalSizeBtn.dispatch('click');
    expect(originalImage.style.transform).toBe('');
    expect(page.preview.hasAttribute('data-slideshow-pan-enabled')).toBe(false);
    expect(page.preview.hasAttribute('data-slideshow-dragging')).toBe(false);
  });

  it('does not pan in fit mode or when the original fits both axes', () => {
    const page = openPage(sequence);
    page.preview.dispatch('pointerdown', {
      pointerId: 12, button: 0, clientX: 0, clientY: 0,
    });
    expect(page.preview.setPointerCapture).not.toHaveBeenCalled();

    const fitting = loadedPage({ width: 600, height: 400 }, { width: 800, height: 600 });
    expect(fitting.page.preview.hasAttribute('data-slideshow-pan-enabled')).toBe(false);
    fitting.page.preview.dispatch('pointerdown', {
      pointerId: 13, button: 0, clientX: 0, clientY: 0,
    });
    expect(fitting.page.preview.setPointerCapture).not.toHaveBeenCalled();
  });
});

// ─── Original-size fullscreen behavior ───────────────────────────────────────

describe('enhanceSlideshow — original-size fullscreen behavior', () => {
  const sequence = [{
    id: 1,
    filename: 'large.png',
    previewUrl: '/preview/1?v=abc',
    viewerUrl: '/v/1',
    originalUrl: '/original/1',
  }];

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('preserves Original Size and the viewed pan region across fullscreen enter/exit', () => {
    const page = openOriginalPage(sequence, { fullscreen: true });
    const originalImage = loadOriginal(page);
    page.preview.dispatch('pointerdown', {
      pointerId: 21, button: 0, clientX: 0, clientY: 0,
    });
    page.preview.dispatch('pointermove', { pointerId: 21, clientX: 200, clientY: 150 });
    const transform = originalImage.style.transform;

    page.fullscreenBtn.dispatch('click');
    expect(page.preview.getAttribute('data-slideshow-mode')).toBe('original');
    expect(originalImage.style.transform).toBe(transform);
    page.fullscreenBtn.dispatch('click');
    expect(page.preview.getAttribute('data-slideshow-mode')).toBe('original');
    expect(originalImage.style.transform).toBe(transform);
  });

  it('recomputes fullscreen bounds and clamps existing offsets without resetting mode', () => {
    const page = openOriginalPage(sequence, { fullscreen: true });
    const originalImage = loadOriginal(page);
    page.preview.dispatch('pointerdown', {
      pointerId: 22, button: 0, clientX: 0, clientY: 0,
    });
    page.preview.dispatch('pointermove', { pointerId: 22, clientX: 5000, clientY: 5000 });
    expect(originalImage.style.transform).toBe('translate(calc(-50% + 400px), calc(-50% + 300px))');

    page.preview.clientWidth = 1200;
    page.preview.clientHeight = 900;
    page.fullscreenBtn.dispatch('click');
    expect(page.preview.getAttribute('data-slideshow-mode')).toBe('original');
    expect(originalImage.style.transform).toBe('translate(calc(-50% + 200px), calc(-50% + 150px))');
  });
});

describe('enhanceSlideshow — next / prev', () => {
  it('Next advances to the next item', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { nextBtn, status } = openPage(seq);
    nextBtn.dispatch('click');
    expect(status.textContent).toBe('2 of 2');
  });

  it('Next updates previewUrl', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { nextBtn, preview } = openPage(seq);
    nextBtn.dispatch('click');
    expect(preview.children[0].src).toBe('/p/2');
  });

  it('Previous advances backward', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
      { id: 3, filename: 'c.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
    ];
    const { nextBtn, prevBtn, status } = openPage(seq);
    nextBtn.dispatch('click'); // 2 of 3
    nextBtn.dispatch('click'); // 3 of 3
    prevBtn.dispatch('click'); // back to 2 of 3
    expect(status.textContent).toBe('2 of 3');
  });

  it('Next on last item wraps to first', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { nextBtn, status } = openPage(seq);
    nextBtn.dispatch('click'); // 2 of 2
    nextBtn.dispatch('click'); // wrap → 1 of 2
    expect(status.textContent).toBe('1 of 2');
  });

  it('Previous on first item wraps to last', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
      { id: 3, filename: 'c.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
    ];
    const { prevBtn, status } = openPage(seq);
    prevBtn.dispatch('click'); // wrap → 3 of 3
    expect(status.textContent).toBe('3 of 3');
  });

  it('single-item sequence is stable after Next', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { nextBtn, status } = openPage(seq);
    nextBtn.dispatch('click');
    expect(status.textContent).toBe('1 of 1');
  });

  it('single-item sequence is stable after Previous', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { prevBtn, status } = openPage(seq);
    prevBtn.dispatch('click');
    expect(status.textContent).toBe('1 of 1');
  });

  it('Next updates filename caption', () => {
    const seq = [
      { id: 1, filename: 'first.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'second.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { nextBtn, preview } = openPage(seq);
    nextBtn.dispatch('click');
    expect(preview.children[1].textContent).toBe('second.png');
  });
});

// ─── Keyboard navigation ─────────────────────────────────────────────────────

describe('enhanceSlideshow — keyboard navigation', () => {
  it('ArrowRight advances to next item', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { document, status } = openPage(seq);
    document.dispatch('keydown', { key: 'ArrowRight' });
    expect(status.textContent).toBe('2 of 2');
  });

  it('ArrowLeft goes to previous item', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
      { id: 3, filename: 'c.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
    ];
    const { document, nextBtn, status } = openPage(seq);
    nextBtn.dispatch('click'); // 2 of 3
    nextBtn.dispatch('click'); // 3 of 3
    document.dispatch('keydown', { key: 'ArrowLeft' });
    expect(status.textContent).toBe('2 of 3');
  });

  it('ArrowLeft on first item wraps to last via keyboard', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { document, status } = openPage(seq);
    document.dispatch('keydown', { key: 'ArrowLeft' });
    expect(status.textContent).toBe('2 of 2');
  });

  it('ArrowRight on last item wraps to first via keyboard', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { document, nextBtn, status } = openPage(seq);
    nextBtn.dispatch('click'); // 2 of 2
    document.dispatch('keydown', { key: 'ArrowRight' });
    expect(status.textContent).toBe('1 of 2');
  });

  it('arrow keys do nothing when dialog is closed', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { document } = makeSlideshowPage(seq);
    enhanceSlideshow(document);
    // do NOT open
    document.dispatch('keydown', { key: 'ArrowRight' });
    const status = document.querySelector('[data-slideshow-status]');
    expect(status.textContent).toBe('');
  });

  it('ArrowRight calls preventDefault when slideshow is open', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document } = openPage(seq);
    const event = document.dispatch('keydown', { key: 'ArrowRight' });
    expect(event.defaultPrevented).toBe(true);
  });

  it('ArrowLeft calls preventDefault when slideshow is open', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document } = openPage(seq);
    const event = document.dispatch('keydown', { key: 'ArrowLeft' });
    expect(event.defaultPrevented).toBe(true);
  });
});

// ─── Closing ─────────────────────────────────────────────────────────────────

describe('enhanceSlideshow — closing', () => {
  it('close button restores hidden and inert', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { closeBtn, scaffold } = openPage(seq);
    closeBtn.dispatch('click');
    expect(scaffold.hidden).toBe(true);
    expect(scaffold.hasAttribute('inert')).toBe(true);
  });

  it('Escape key closes the slideshow', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document, scaffold } = openPage(seq);
    document.dispatch('keydown', { key: 'Escape' });
    expect(scaffold.hidden).toBe(true);
  });

  it('focus returns to trigger after close button click', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { closeBtn, trigger } = openPage(seq);
    closeBtn.dispatch('click');
    expect(trigger.focused).toBe(true);
  });

  it('focus returns to trigger after Escape', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document, trigger } = openPage(seq);
    document.dispatch('keydown', { key: 'Escape' });
    expect(trigger.focused).toBe(true);
  });

  it('Escape calls preventDefault', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { document } = openPage(seq);
    const event = document.dispatch('keydown', { key: 'Escape' });
    expect(event.defaultPrevented).toBe(true);
  });

  it('aria-expanded is "false" after close', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { closeBtn, trigger } = openPage(seq);
    closeBtn.dispatch('click');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape does not throw when dialog is already closed', () => {
    const { document } = makeSlideshowPage([{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }]);
    enhanceSlideshow(document);
    expect(() => document.dispatch('keydown', { key: 'Escape' })).not.toThrow();
  });

  it('can reopen after closing', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { closeBtn, trigger, scaffold } = openPage(seq);
    closeBtn.dispatch('click');
    expect(scaffold.hidden).toBe(true);
    trigger.dispatch('click');
    expect(scaffold.hidden).toBe(false);
  });
});

// ─── Autoplay ────────────────────────────────────────────────────────────────

describe('enhanceSlideshow — autoplay', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const seq3 = [
    { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    { id: 3, filename: 'c.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
  ];
  const seq2 = [
    { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
  ];
  const seq1 = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];

  it('play-pause button is enabled after enhancement (multi-image sequence)', () => {
    const { document, playPauseBtn } = makeSlideshowPage(seq2);
    enhanceSlideshow(document);
    expect(playPauseBtn.disabled).toBe(false);
  });

  it('speed select is enabled after enhancement (multi-image sequence)', () => {
    const { document, speedSelect } = makeSlideshowPage(seq2);
    enhanceSlideshow(document);
    expect(speedSelect.disabled).toBe(false);
  });

  it('play-pause is disabled for empty sequence', () => {
    const { document, playPauseBtn } = makeSlideshowPage([]);
    enhanceSlideshow(document);
    expect(playPauseBtn.disabled).toBe(true);
  });

  it('speed select is disabled for empty sequence', () => {
    const { document, speedSelect } = makeSlideshowPage([]);
    enhanceSlideshow(document);
    expect(speedSelect.disabled).toBe(true);
  });

  it('fullscreen control is disabled for empty sequence when the API is available', () => {
    const { document, fullscreenBtn } = makeSlideshowPage([], { fullscreen: true });
    enhanceSlideshow(document);
    expect(fullscreenBtn.disabled).toBe(true);
  });

  it('opening a multi-item slideshow starts autoplay', () => {
    const { playPauseBtn } = openPage(seq2);
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    expect(playPauseBtn.hasAttribute('data-slideshow-playing')).toBe(true);
  });

  it('default speed is 4000 ms', () => {
    const { status } = openPage(seq2);
    vi.advanceTimersByTime(3999);
    expect(status.textContent).toBe('1 of 2');
    vi.advanceTimersByTime(1);
    expect(status.textContent).toBe('2 of 2');
  });

  it('timer advancement moves to next item', () => {
    const { status } = openPage(seq3);
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 3');
  });

  it('autoplay wraps at end', () => {
    const { status } = openPage(seq2);
    vi.advanceTimersByTime(4000); // → 2 of 2
    vi.advanceTimersByTime(4000); // → wrap to 1 of 2
    expect(status.textContent).toBe('1 of 2');
  });

  it('only one timer is active at a time', () => {
    const { status } = openPage(seq3);
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 3');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('3 of 3');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 3'); // wrapped, not double-advanced
  });

  it('close clears timer — no advancement after close', () => {
    const { status, closeBtn } = openPage(seq3);
    expect(status.textContent).toBe('1 of 3');
    closeBtn.dispatch('click');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 3');
  });

  it('reopen starts a fresh timer without duplicates', () => {
    const { document, trigger, closeBtn, status } = openPage(seq3);
    closeBtn.dispatch('click');
    trigger.dispatch('click');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 3');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('3 of 3');
  });
});

// ─── Speed control ───────────────────────────────────────────────────────────

describe('enhanceSlideshow — speed control', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const seq3 = [
    { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    { id: 3, filename: 'c.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
  ];

  it('keeps 2 s, 4 s, and 6 s options with 4 s selected by default', () => {
    const { document, speedSelect, speedOptions } = makeSlideshowPage(seq3);
    enhanceSlideshow(document);
    expect(speedOptions.map((option) => option.getAttribute('value'))).toEqual(['2000', '4000', '6000']);
    expect(speedOptions.map((option) => option.textContent)).toEqual(['2 s', '4 s', '6 s']);
    expect(speedSelect.value).toBe('4000');
  });

  it('changing speed while playing replaces the active timer', () => {
    const { speedSelect, status } = openPage(seq3);
    speedSelect.value = '2000';
    speedSelect.dispatch('change');
    vi.advanceTimersByTime(2000);
    expect(status.textContent).toBe('2 of 3');
  });

  it('speed change does not advance slide immediately', () => {
    const { speedSelect, status } = openPage(seq3);
    vi.advanceTimersByTime(2000); // halfway through default 4s interval
    speedSelect.value = '2000';
    speedSelect.dispatch('change');
    expect(status.textContent).toBe('1 of 3'); // no immediate advance
  });

  it('changing speed while paused does not resume autoplay', () => {
    const { playPauseBtn, speedSelect, status } = openPage(seq3);
    playPauseBtn.dispatch('click'); // pause
    speedSelect.value = '2000';
    speedSelect.dispatch('change');
    vi.advanceTimersByTime(2000);
    expect(status.textContent).toBe('1 of 3'); // no auto-advance
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
  });

  it('no multiple timers left after speed change while playing', () => {
    const { speedSelect, status } = openPage(seq3);
    speedSelect.value = '2000';
    speedSelect.dispatch('change');
    vi.advanceTimersByTime(2000);
    expect(status.textContent).toBe('2 of 3');
    vi.advanceTimersByTime(2000);
    expect(status.textContent).toBe('3 of 3'); // exactly one advance per interval
  });

  it('standard speed selection dispatches once and updates the autoplay interval', () => {
    const page = openStandardSpeedPage(seq3);
    page.speedInputs[0].checked = true;
    page.speedInputs[0].dispatch('change');

    expect(page.speedSelect.dispatchEvent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1999);
    expect(page.status.textContent).toBe('1 of 3');
    vi.advanceTimersByTime(1);
    expect(page.status.textContent).toBe('2 of 3');
  });

  it('standard speed trigger stays synchronized with slideshow availability', () => {
    const page = makeSlideshowPage([], { standardSpeed: true });
    enhanceDropdowns(page.document);
    enhanceSlideshow(page.document);
    expect(page.speedSelect.disabled).toBe(true);
    expect(page.speedSummary.disabled).toBe(true);

    page.scaffold.__creatorCrateSlideshowState.refreshSequence([{
      id: 1,
      filename: 'a.png',
      previewUrl: '/p/1',
      viewerUrl: '/v/1',
    }, { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' }]);
    expect(page.speedSelect.disabled).toBe(false);
    expect(page.speedSummary.disabled).toBe(false);

    page.scaffold.__creatorCrateSlideshowState.refreshSequence([]);
    expect(page.speedSelect.disabled).toBe(true);
    expect(page.speedSummary.disabled).toBe(true);
  });
});

// ─── Fullscreen ──────────────────────────────────────────────────────────────

describe('enhanceSlideshow — fullscreen', () => {
  const seq2 = [
    { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
  ];

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const chromeHideDelay = 4000;

  it('entering fullscreen starts with visible chrome', () => {
    const { scaffold, fullscreenBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(chromeHideDelay - 1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
  });

  it('hides fullscreen chrome after inactivity', () => {
    const { scaffold, fullscreenBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    vi.advanceTimersByTime(chromeHideDelay);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('auto-hides chrome outside fullscreen after the same delay', () => {
    const { scaffold } = openPage(seq2);
    vi.advanceTimersByTime(chromeHideDelay - 1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('uses one idle state for the complete applicable chrome set and activity reveals it together', () => {
    const page = makeSlideshowPage(seq2, { fullscreen: true, standardSpeed: true });
    enhanceDropdowns(page.document);
    enhanceSlideshow(page.document);
    page.trigger.dispatch('click');

    expect(page.fullscreenBtn.hidden).toBe(false);
    expect(page.originalSizeBtn.hidden).toBe(false);
    expect(page.closeBtn.hidden).toBe(false);
    expect(page.prevBtn.hidden).toBe(false);
    expect(page.nextBtn.hidden).toBe(false);
    expect(page.playPauseBtn.hidden).toBe(false);
    expect(page.status.hidden).toBe(false);
    expect(page.speedField.hidden).toBe(false);

    vi.advanceTimersByTime(chromeHideDelay);
    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);

    page.scaffold.dispatch('pointermove');
    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    expect(page.prevBtn.hidden).toBe(false);
    expect(page.nextBtn.hidden).toBe(false);
    expect(page.playPauseBtn.hidden).toBe(false);
    expect(page.status.hidden).toBe(false);
    expect(page.speedField.hidden).toBe(false);
  });

  it('uses the same inactivity behavior for single-image mode', () => {
    const single = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { scaffold } = openPage(single);

    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(chromeHideDelay);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('replaces the prior inactivity timer when pointer activity repeats', () => {
    const single = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { scaffold } = openPage(single);

    vi.advanceTimersByTime(chromeHideDelay - 1);
    scaffold.dispatch('pointermove');
    vi.advanceTimersByTime(1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(chromeHideDelay - 2);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('pointer movement reveals chrome and restarts the inactivity timer', () => {
    const { scaffold, fullscreenBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    vi.advanceTimersByTime(chromeHideDelay);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);

    scaffold.dispatch('pointermove');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(chromeHideDelay - 1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('the first control interaction reveals chrome and still activates the control', () => {
    const { scaffold, fullscreenBtn, nextBtn, playPauseBtn, status } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    playPauseBtn.dispatch('click');
    vi.advanceTimersByTime(chromeHideDelay);

    nextBtn.dispatch('click');
    expect(status.textContent).toBe('2 of 2');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
  });

  it('keyboard interaction reveals chrome and restarts the inactivity timer', () => {
    const { document, scaffold, fullscreenBtn, playPauseBtn, status } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    playPauseBtn.dispatch('click');
    vi.advanceTimersByTime(chromeHideDelay);

    document.dispatch('keydown', { key: 'ArrowRight' });
    expect(status.textContent).toBe('2 of 2');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(chromeHideDelay);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('focus entering slideshow chrome reveals and restarts the inactivity timer', () => {
    const { scaffold, fullscreenBtn, closeBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    vi.advanceTimersByTime(chromeHideDelay);

    closeBtn.dispatch('focusin');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(chromeHideDelay);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('does not retain initial programmatic Close focus during idle hiding', () => {
    const page = openPage(seq2, { fullscreen: true });

    expect(page.document.activeElement).toBe(page.closeBtn);
    vi.advanceTimersByTime(chromeHideDelay);

    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect(page.closeBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);
    expect(page.fullscreenBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);
  });

  it('does not retain pointer-focused Exit Fullscreen during idle hiding', () => {
    const page = openPage(seq2, { fullscreen: true });

    page.fullscreenBtn.focus();
    page.fullscreenBtn.dispatch('click');
    expect(page.fullscreenBtn.getAttribute('aria-label')).toBe('Exit fullscreen');
    vi.advanceTimersByTime(chromeHideDelay);

    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect(page.fullscreenBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);
  });

  it('keeps only genuinely keyboard-focused navigation or enhanced speed surfaces eligible', () => {
    const navigationPage = openPage(seq2);

    navigationPage.document.dispatch('keydown', { key: 'Tab' });
    vi.advanceTimersByTime(chromeHideDelay);

    expect(navigationPage.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect(navigationPage.document.activeElement).toBe(navigationPage.prevBtn);
    expect(navigationPage.prevBtn.hasAttribute('data-slideshow-ui-focused')).toBe(true);
    expect(navigationPage.closeBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);
    expect(navigationPage.playPauseBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);

    const speedPage = openStandardSpeedPage(seq2);
    speedPage.speedSummary.focus();
    speedPage.document.dispatch('keydown', { key: 'ArrowDown' });
    vi.advanceTimersByTime(chromeHideDelay);

    expect(speedPage.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect(speedPage.document.activeElement).toBe(speedPage.speedSummary);
    expect(speedPage.speedDropdown.hasAttribute('data-slideshow-ui-focused')).toBe(true);
    expect(speedPage.playPauseBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);
    expect(speedPage.nextBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);
  });

  it('clears the focused surface on focusout when focus leaves the hidden slideshow', () => {
    const page = openPage(seq2);
    const outside = makeNode({ tagName: 'button' });
    page.document.appendChild(outside);

    page.document.dispatch('keydown', { key: 'Tab' });
    vi.advanceTimersByTime(chromeHideDelay);

    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect(page.document.activeElement).toBe(page.prevBtn);
    expect(page.prevBtn.hasAttribute('data-slideshow-ui-focused')).toBe(true);

    outside.focus();

    expect(page.document.activeElement).toBe(outside);
    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect([
      page.fullscreenBtn,
      page.originalSizeBtn,
      page.closeBtn,
      page.prevBtn,
      page.playPauseBtn,
      page.speedSelect,
      page.nextBtn,
    ].some((surface) => surface.hasAttribute('data-slideshow-ui-focused'))).toBe(false);
  });

  it('clears keyboard-qualified chrome before idle hiding after slideshow pointer interaction', () => {
    const page = openPage(seq2);

    page.document.dispatch('keydown', { key: 'Tab' });
    vi.advanceTimersByTime(chromeHideDelay);

    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect(page.document.activeElement).toBe(page.prevBtn);
    expect(page.prevBtn.hasAttribute('data-slideshow-ui-focused')).toBe(true);

    page.scaffold.dispatch('pointerdown');
    vi.advanceTimersByTime(chromeHideDelay);

    expect(page.scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    expect(page.prevBtn.hasAttribute('data-slideshow-ui-focused')).toBe(false);
    expect([
      page.fullscreenBtn,
      page.originalSizeBtn,
      page.closeBtn,
      page.playPauseBtn,
      page.speedSelect,
      page.nextBtn,
    ].some((surface) => surface.hasAttribute('data-slideshow-ui-focused'))).toBe(false);
  });

  it('hides the control when the Fullscreen API is unavailable without throwing', () => {
    const page = makeSlideshowPage(seq2);
    expect(() => enhanceSlideshow(page.document)).not.toThrow();
    expect(page.fullscreenBtn.hidden).toBe(true);
    expect(page.fullscreenBtn.disabled).toBe(true);
    expect(() => {
      page.trigger.dispatch('click');
      page.fullscreenBtn.dispatch('click');
    }).not.toThrow();
  });

  it('requests fullscreen on the slideshow scaffold', () => {
    const { scaffold, fullscreenBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    expect(scaffold.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('updates label, pressed state, and icon state while fullscreen is active', () => {
    const { document, scaffold, fullscreenBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    expect(document.fullscreenElement).toBe(scaffold);
    expect(fullscreenBtn.getAttribute('aria-label')).toBe('Exit fullscreen');
    expect(fullscreenBtn.getAttribute('data-tooltip')).toBe('Exit fullscreen');
    expect(fullscreenBtn.hasAttribute('title')).toBe(false);
    expect(fullscreenBtn.getAttribute('aria-pressed')).toBe('true');
    expect(fullscreenBtn.hasAttribute('data-slideshow-fullscreen-active')).toBe(true);
  });

  it('second click exits fullscreen and restores the enter state', () => {
    const { document, fullscreenBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    fullscreenBtn.dispatch('click');
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(document.fullscreenElement).toBeNull();
    expect(fullscreenBtn.getAttribute('aria-label')).toBe('Enter fullscreen');
    expect(fullscreenBtn.getAttribute('aria-pressed')).toBe('false');
    expect(fullscreenBtn.hasAttribute('data-slideshow-fullscreen-active')).toBe(false);
  });

  it('exiting fullscreen restarts the normal viewer inactivity timer', () => {
    const seq1 = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { scaffold, fullscreenBtn } = openPage(seq1, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(1);
    fullscreenBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(1);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    vi.advanceTimersByTime(chromeHideDelay);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('closing clears the chrome timer and reopening starts visible with one new timer', () => {
    const seq1 = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { scaffold, trigger, closeBtn } = openPage(seq1);

    expect(vi.getTimerCount()).toBe(1);
    closeBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(0);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);

    trigger.dispatch('click');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(chromeHideDelay);
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
  });

  it('repeated fullscreen enter/exit keeps one chrome timer without duplicates', () => {
    const seq1 = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { fullscreenBtn, closeBtn } = openPage(seq1, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(1);
    fullscreenBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(1);
    fullscreenBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(1);
    fullscreenBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(1);
    closeBtn.dispatch('click');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('synchronizes state after an external fullscreenchange exit', () => {
    const { document, scaffold, fullscreenBtn } = openPage(seq2, { fullscreen: true });
    document.fullscreenElement = scaffold;
    document.dispatch('fullscreenchange');
    expect(fullscreenBtn.getAttribute('aria-label')).toBe('Exit fullscreen');

    document.fullscreenElement = null;
    document.dispatch('fullscreenchange');
    expect(fullscreenBtn.getAttribute('aria-label')).toBe('Enter fullscreen');
    expect(fullscreenBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('closing fullscreen slideshow exits fullscreen and does not leave stale state on reopen', () => {
    const { document, trigger, scaffold, fullscreenBtn, closeBtn } = openPage(seq2, { fullscreen: true });
    fullscreenBtn.dispatch('click');
    closeBtn.dispatch('click');
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(document.fullscreenElement).toBeNull();
    expect(scaffold.hidden).toBe(true);
    expect(fullscreenBtn.getAttribute('aria-label')).toBe('Enter fullscreen');

    trigger.dispatch('click');
    expect(fullscreenBtn.getAttribute('aria-label')).toBe('Enter fullscreen');
    expect(fullscreenBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('entering and exiting fullscreen does not stop autoplay', () => {
    const { scaffold, fullscreenBtn, status, playPauseBtn } = openPage(seq2, { fullscreen: true });
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    fullscreenBtn.dispatch('click');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 2');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(true);
    scaffold.dispatch('pointermove');
    expect(scaffold.hasAttribute('data-slideshow-ui-hidden')).toBe(false);
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    fullscreenBtn.dispatch('click');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 2');
  });
});

// ─── Play / Pause ────────────────────────────────────────────────────────────

describe('enhanceSlideshow — play / pause', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const seq2 = [
    { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
  ];

  it('initial open state is Pause/running', () => {
    const { playPauseBtn } = openPage(seq2);
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    expect(playPauseBtn.hasAttribute('data-slideshow-playing')).toBe(true);
  });

  it('clicking Pause stops autoplay', () => {
    const { playPauseBtn, status } = openPage(seq2);
    playPauseBtn.dispatch('click');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    expect(playPauseBtn.hasAttribute('data-slideshow-playing')).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 2'); // no advancement
  });

  it('clicking Play resumes autoplay from current slide', () => {
    const { playPauseBtn, status } = openPage(seq2);
    playPauseBtn.dispatch('click'); // pause
    playPauseBtn.dispatch('click'); // resume
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 2');
  });

  it('resumed timer waits the full selected interval before advancing', () => {
    const { playPauseBtn, status } = openPage(seq2);
    playPauseBtn.dispatch('click'); // pause
    playPauseBtn.dispatch('click'); // resume
    vi.advanceTimersByTime(3999);
    expect(status.textContent).toBe('1 of 2'); // not yet
    vi.advanceTimersByTime(1);
    expect(status.textContent).toBe('2 of 2');
  });

  it('ARIA label reflects Play vs Pause state', () => {
    const { playPauseBtn } = openPage(seq2);
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    playPauseBtn.dispatch('click');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    playPauseBtn.dispatch('click');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
  });
});

// ─── Manual navigation stops autoplay ────────────────────────────────────────

describe('enhanceSlideshow — manual navigation stops autoplay', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const seq3 = [
    { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    { id: 3, filename: 'c.png', previewUrl: '/p/3', viewerUrl: '/v/3' },
  ];

  it('Previous click stops autoplay and navigates once', () => {
    const { prevBtn, playPauseBtn, status } = openPage(seq3);
    vi.advanceTimersByTime(4000); // autoplay → 2 of 3
    prevBtn.dispatch('click');
    expect(status.textContent).toBe('1 of 3');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 3'); // no further advance
  });

  it('Next click stops autoplay and navigates once', () => {
    const { nextBtn, playPauseBtn, status } = openPage(seq3);
    nextBtn.dispatch('click');
    expect(status.textContent).toBe('2 of 3');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 3'); // no further advance
  });

  it('ArrowLeft stops autoplay and navigates once', () => {
    const { document, playPauseBtn, status } = openPage(seq3);
    vi.advanceTimersByTime(4000); // → 2 of 3
    document.dispatch('keydown', { key: 'ArrowLeft' });
    expect(status.textContent).toBe('1 of 3');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 3');
  });

  it('ArrowRight stops autoplay and navigates once', () => {
    const { document, playPauseBtn, status } = openPage(seq3);
    document.dispatch('keydown', { key: 'ArrowRight' });
    expect(status.textContent).toBe('2 of 3');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 3');
  });

  it('does not auto-restart until Play is explicitly pressed', () => {
    const { nextBtn, playPauseBtn, status } = openPage(seq3);
    nextBtn.dispatch('click'); // manual nav stops autoplay
    vi.advanceTimersByTime(8000); // 2× default interval
    expect(status.textContent).toBe('2 of 3'); // stayed put
    playPauseBtn.dispatch('click'); // explicit Play
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('3 of 3');
  });
});

// ─── Autoplay edge cases ─────────────────────────────────────────────────────

describe('enhanceSlideshow — autoplay edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('single-item sequence: no timer advancement', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { status, playPauseBtn } = openPage(seq);
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 1');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
  });

  it('single-item Play/Pause control is hidden and disabled', () => {
    const seq = [{ id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' }];
    const { playPauseBtn } = openPage(seq);
    expect(playPauseBtn.hidden).toBe(true);
    expect(playPauseBtn.disabled).toBe(true);
  });

  it('Escape closes and clears the timer', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { document, scaffold, status } = openPage(seq);
    document.dispatch('keydown', { key: 'Escape' });
    expect(scaffold.hidden).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 2'); // no advance after close
  });

  it('navigation while paused remains paused', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const { nextBtn, playPauseBtn, status } = openPage(seq);
    playPauseBtn.dispatch('click'); // pause
    nextBtn.dispatch('click'); // manual navigate while paused
    expect(status.textContent).toBe('2 of 2');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 2'); // no auto-advance
  });

  it('reduced-motion prevents autoplay on open', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const origMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
    const { playPauseBtn, status } = openPage(seq);
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('1 of 2'); // no auto-advance
    globalThis.matchMedia = origMatchMedia;
  });

  it('reduced-motion: user can still explicitly start Play', () => {
    const seq = [
      { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
      { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
    ];
    const origMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
    const { playPauseBtn, status } = openPage(seq);
    playPauseBtn.dispatch('click'); // explicit Play
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    vi.advanceTimersByTime(4000);
    expect(status.textContent).toBe('2 of 2');
    globalThis.matchMedia = origMatchMedia;
  });
});

// ─── Focus trap ──────────────────────────────────────────────────────────────

describe('enhanceSlideshow — focus trap', () => {
  const seq1 = [
    { id: 1, filename: 'a.png', previewUrl: '/p/1', viewerUrl: '/v/1' },
    { id: 2, filename: 'b.png', previewUrl: '/p/2', viewerUrl: '/v/2' },
  ];
  const originalSeq = [
    {
      id: 1,
      filename: 'a.png',
      previewUrl: '/p/1',
      viewerUrl: '/v/1',
      originalUrl: '/o/1',
    },
    {
      id: 2,
      filename: 'b.png',
      previewUrl: '/p/2',
      viewerUrl: '/v/2',
      originalUrl: '/o/2',
    },
  ];

  it('Tab from last focusable wraps to first', () => {
    const { document, closeBtn, prevBtn } = openPage(seq1);
    closeBtn.focus();
    document.dispatch('keydown', { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(prevBtn);
  });

  it('Shift+Tab from first focusable wraps to last', () => {
    const { document, prevBtn, closeBtn } = openPage(seq1);
    prevBtn.focus();
    document.dispatch('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(closeBtn);
  });

  it('Tab skips disabled controls', () => {
    const { document, closeBtn, prevBtn, playPauseBtn } = openPage(seq1);
    playPauseBtn.disabled = true;
    closeBtn.focus();
    document.dispatch('keydown', { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(prevBtn);
  });

  it('focus-trap order follows fullscreen, Original Size, then Close when supported', () => {
    const { document, fullscreenBtn, originalSizeBtn, closeBtn } = openPage(originalSeq, { fullscreen: true });
    fullscreenBtn.focus();
    document.dispatch('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(originalSizeBtn);
    document.dispatch('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);
    closeBtn.focus();
    document.dispatch('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(originalSizeBtn);
  });

  it('focus trap includes Original Size and cycles back to Close', () => {
    const { document, nextBtn, originalSizeBtn, closeBtn } = openPage(originalSeq);
    nextBtn.focus();
    document.dispatch('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(originalSizeBtn);
    document.dispatch('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);
  });

  it('keeps Play and Pause tooltip labels synchronized with accessibility labels', () => {
    const { playPauseBtn } = openPage(seq1);
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause');
    expect(playPauseBtn.getAttribute('data-tooltip')).toBe('Pause');
    playPauseBtn.dispatch('click');
    expect(playPauseBtn.getAttribute('aria-label')).toBe('Play');
    expect(playPauseBtn.getAttribute('data-tooltip')).toBe('Play');
  });

  it('Tab trap is inactive while dialog is closed', () => {
    const { document, trigger } = makeSlideshowPage(seq1);
    enhanceSlideshow(document);
    trigger.focus();
    const event = document.dispatch('keydown', { key: 'Tab', shiftKey: false });
    expect(event.defaultPrevented).toBe(false);
  });
});

// ─── CSS presentation contract ────────────────────────────────────────────────

describe('slideshow CSS — presentation contract', () => {
  it('scaffold uses position:fixed covering the full viewport', () => {
    expect(css).toMatch(/\.slideshow-scaffold\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.slideshow-scaffold\s*\{[^}]*inset:\s*0/);
  });

  it('scaffold inner is an inset overlay layer without flex allocation', () => {
    expect(css).toMatch(/\.slideshow-scaffold-inner\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
    expect(css).toMatch(/\.slideshow-scaffold-inner\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/);
    expect(css).not.toMatch(/\.slideshow-scaffold-inner\s*\{[^}]*max-width:/);
    expect(css).not.toMatch(/\.slideshow-scaffold-inner\s*\{[^}]*flex:/);
    expect(css).toMatch(/\.slideshow-scaffold-inner\s*\{[^}]*min-height:\s*0/);
  });

  it('preview fills the scaffold as an absolute layer', () => {
    expect(css).toMatch(/\.slideshow-preview\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
    expect(css).toMatch(/\.slideshow-preview\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/);
    expect(css).not.toMatch(/\.slideshow-preview\s*\{[^}]*flex:/);
  });

  it('preview clips the image layer without changing its available size', () => {
    expect(css).toMatch(/\.slideshow-preview\s*\{[^}]*overflow:\s*hidden/);
  });

  it('slideshow-img is positioned to fill the preview container', () => {
    expect(css).toMatch(/\.slideshow-img\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.slideshow-img\s*\{[^}]*width:\s*100%/);
    expect(css).toMatch(/\.slideshow-img\s*\{[^}]*height:\s*100%/);
  });

  it('slideshow-img uses object-fit:contain (preserves aspect ratio, never crops)', () => {
    expect(css).toMatch(/\.slideshow-img\s*\{[^}]*object-fit:\s*contain/);
  });

  it('original mode uses native dimensions without fit constraints and centers the image', () => {
    expect(css).toMatch(/\.slideshow-original-img\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.slideshow-preview\[data-slideshow-mode="original"\]\s+\.slideshow-original-img\s*\{[^}]*top:\s*50%[^}]*left:\s*50%/);
    expect(css).toMatch(/\.slideshow-preview\[data-slideshow-mode="original"\]\s+\.slideshow-original-img\s*\{[^}]*width:\s*auto[^}]*height:\s*auto/);
    expect(css).toMatch(/\.slideshow-preview\[data-slideshow-mode="original"\]\s+\.slideshow-original-img\s*\{[^}]*max-width:\s*none[^}]*max-height:\s*none/);
  });

  it('original mode exposes scoped grab/grabbing cursors and disables native image dragging', () => {
    expect(css).toMatch(/data-slideshow-pan-enabled\].*\.slideshow-original-img\s*\{[^}]*cursor:\s*grab/);
    expect(css).toMatch(/data-slideshow-dragging\].*\.slideshow-original-img\s*\{[^}]*cursor:\s*grabbing/);
    expect(css).toMatch(/\.slideshow-preview\[data-slideshow-mode="original"\]\s*\{[^}]*touch-action:\s*none/);
    expect(css).toMatch(/\.slideshow-preview\[data-slideshow-mode="original"\]\s+\.slideshow-original-img\s*\{[^}]*user-select:\s*none/);
  });

  it('slideshow-caption truncates long filenames without expanding the modal', () => {
    expect(css).toMatch(/\.slideshow-caption\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.slideshow-caption\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.slideshow-caption\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('nav/close buttons have explicit display and minimum touch target', () => {
    expect(css).toMatch(/\.slideshow-nav-btn[^{]*\{[^}]*display:\s*inline-flex/);
    expect(css).toMatch(/\.slideshow-nav-btn[^{]*\{[^}]*min-height:/);
    expect(css).toMatch(/\.slideshow-nav-btn[^{]*\{[^}]*min-width:/);
  });

  it('header and controls overlay the image instead of consuming preview space', () => {
    expect(css).toMatch(/\.slideshow-header\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*4/);
    expect(css).toMatch(/\.slideshow-controls\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*z-index:\s*3/);
    expect(css).not.toMatch(/\.slideshow-header\s*\{[^}]*background:/);
    expect(css).not.toMatch(/\.slideshow-controls\s*\{[^}]*background:/);
  });

  it('chrome surfaces are translucent, theme-aware, and above the preview layer', () => {
    expect(css).toMatch(/\.slideshow-status\s*\{[^}]*background:\s*rgba\(13 15 19 \/ 0\.72\)/);
    const controlsStart = css.indexOf('.slideshow-nav-btn,');
    const controlsEnd = css.indexOf('.slideshow-nav-btn:hover', controlsStart);
    const controlsCss = css.slice(controlsStart, controlsEnd);
    expect(controlsCss).toContain('border: 1px solid rgba(232 236 241 / 0.28);');
    expect(controlsCss).toContain('background: rgba(13 15 19 / 0.72);');
    expect(css).toMatch(/\.slideshow-preview\s*\{[^}]*z-index:\s*0/);
    expect(css).toMatch(/\.slideshow-caption\s*\{[^}]*z-index:\s*2/);
  });

  it('previous and next controls are edge overlays, not horizontal reservations', () => {
    expect(css).toMatch(/\.slideshow-controls\s*>\s*\[data-slideshow-prev\]\s*\{[^}]*left:\s*var\(--space-lg\)/);
    expect(css).toMatch(/\.slideshow-controls\s*>\s*\[data-slideshow-next\]\s*\{[^}]*right:\s*var\(--space-lg\)/);
    expect(css).toMatch(/\.slideshow-controls\s*>\s*\.slideshow-nav-btn\s*\{[^}]*position:\s*absolute/);
  });

  it('supports above-control tooltips for bottom slideshow controls', () => {
    expect(css).toMatch(/\.asset-tooltip--top\[data-tooltip\]::after\s*\{[^}]*top:\s*auto[^}]*bottom:\s*calc\(100% \+ var\(--space-xs\)\)/);
    expect(css).toMatch(/\.asset-tooltip--top\[data-tooltip\]:hover::after,[\s\S]*\.asset-tooltip--top\[data-tooltip\]:focus-visible::after\s*\{[^}]*transform:\s*translate\(-50%, 0\)/);
  });

  it('uses a zoom cursor only for fitted images that can activate Original Size', () => {
    expect(css).toMatch(/\.slideshow-preview\[data-slideshow-image-zoomable\]\s+\.slideshow-preview-img\s*\{[^}]*cursor:\s*zoom-in/);
  });

  it('fullscreen keeps the same full-size scaffold geometry', () => {
    expect(css).toMatch(/\.slideshow-scaffold:fullscreen\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/);
    expect(css).toMatch(/\.slideshow-scaffold::backdrop\s*\{[^}]*background:\s*var\(--bg\)/);
  });

  it('hidden fullscreen chrome does not alter preview geometry', () => {
    const hiddenStart = css.indexOf('[data-slideshow-ui-hidden] .slideshow-header,');
    const chromeStart = css.indexOf('.slideshow-nav-btn,', hiddenStart);
    const hiddenCss = css.slice(hiddenStart, chromeStart);
    expect(hiddenCss).not.toContain('.slideshow-preview');
    expect(hiddenCss).not.toMatch(/(?:width|height|inset|flex):/);
  });

  it('keeps header actions right-aligned when sequence state hides the status', () => {
    expect(css).toMatch(/\.slideshow-header\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.slideshow-header\s*\{[^}]*justify-content:\s*space-between/);
    expect(css).toMatch(/\.slideshow-header-actions\s*\{[^}]*margin-left:\s*auto/);
    expect(css).not.toMatch(/\[data-slideshow-[^\]]+\][^{]*\.slideshow-header-actions\s*\{[^}]*(?:left|margin-left):/);
  });

  it('slideshow speed uses the dark native theme and player control surface', () => {
    const speedStart = css.indexOf('.slideshow-speed {');
    const speedEnd = css.indexOf('@media (max-width: 540px)', speedStart);
    const speedCss = css.slice(speedStart, speedEnd);
    expect(speedCss).toContain('color-scheme: dark;');
    expect(speedCss).toContain('background: rgba(13 15 19 / 0.72);');
    expect(speedCss).toContain('border: 1px solid rgba(232 236 241 / 0.28);');
    expect(speedCss).toContain('color: var(--text);');
    expect(speedCss).toContain('background-color: var(--surface-card);');
    expect(speedCss).not.toContain('color-scheme: light');
    expect(speedCss).not.toContain('background-color: #fff');
    expect(css).toMatch(/\.slideshow-speed:disabled\s*\{[^}]*color:\s*var\(--muted\)[^}]*opacity:\s*1/);
    expect(css).toMatch(/\.slideshow-speed:disabled\s+option\s*\{[^}]*color:\s*var\(--muted\)[^}]*background-color:\s*var\(--surface-card\)/);
  });

  it('uses a per-surface idle exception without restoring chrome containers', () => {
    expect(css).toMatch(/\[data-slideshow-ui-hidden\]\s+\.slideshow-header-actions\s*>\s*\*,[\s\S]*\[data-slideshow-ui-hidden\]\s+\.slideshow-controls\s*>\s*:not\(\.asset-filter-multiselect-field\),[\s\S]*\.cc-dropdown-native-select,[\s\S]*\.cc-dropdown,[\s\S]*opacity:\s*0[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\[data-slideshow-ui-hidden\]\s+\.slideshow-header-actions\s*>\s*\[data-slideshow-ui-focused\],[\s\S]*\[data-slideshow-ui-hidden\]\s+\.slideshow-controls\s*>\s*\[data-slideshow-ui-focused\],[\s\S]*\[data-slideshow-ui-hidden\]\s+\.slideshow-controls\s*>\s*\.asset-filter-multiselect-field\s*>\s*\[data-slideshow-ui-focused\]\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    expect(css).not.toMatch(/\[data-slideshow-ui-hidden\]\s+\[data-slideshow-ui-focused\]\s*\{/);
    expect(css).not.toMatch(/\.slideshow-header:focus-within|\.slideshow-controls:focus-within/);
  });
});
