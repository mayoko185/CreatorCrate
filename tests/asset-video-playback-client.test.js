import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIDEO_PREVIEW_DIALOG_ID,
  enhanceAssetVideoPreview,
  enhanceVideoFrames,
  enhanceVideoPlayback,
} from '../src/static/client/asset-video-playback.js';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function makeNode(props = {}) {
  const listeners = {};
  const attributes = new Map();
  return {
    dataset: {},
    hidden: false,
    ...props,
    listeners,
    addEventListener: vi.fn((type, handler) => { listeners[type] = handler; }),
    setAttribute: vi.fn((name, value) => attributes.set(name, value)),
    removeAttribute: vi.fn((name) => attributes.delete(name)),
    attributes,
  };
}

function makeViewerScope({ videoError = null } = {}) {
  const video = makeNode({ error: videoError, loop: false, play: vi.fn(), pause: vi.fn() });
  const message = makeNode({ hidden: true });
  const loop = makeNode({ checked: true });
  const loopControl = makeNode();
  const root = makeNode({
    querySelector: (selector) => ({
      '[data-asset-video]': video,
      '[data-asset-video-error]': message,
      '[data-asset-video-loop]': loop,
      '[data-asset-video-loop-control]': loopControl,
    })[selector] ?? null,
  });
  const view = makeNode();
  const scope = {
    defaultView: view,
    querySelectorAll: (selector) => ({
      '[data-asset-video-playback]': [root],
      '[data-asset-video]': [video],
    })[selector] ?? [],
  };
  return { scope, root, video, message, loop, loopControl, view };
}

describe('asset viewer video playback enhancement', () => {
  it('switches to the static error state when native playback fails', () => {
    const { scope, root, video, message, loopControl } = makeViewerScope();

    expect(enhanceVideoPlayback(scope)).toBe(1);
    expect(root.dataset.videoState).toBeUndefined();
    video.listeners.error();

    expect(root.dataset.videoState).toBe('failed');
    expect(video.hidden).toBe(true);
    expect(loopControl.hidden).toBe(true);
    expect(message.hidden).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('shows the error state immediately when the element already reports an error', () => {
    const { scope, root, video, message } = makeViewerScope({ videoError: { code: 4 } });

    enhanceVideoPlayback(scope);

    expect(root.dataset.videoState).toBe('failed');
    expect(video.hidden).toBe(true);
    expect(message.hidden).toBe(false);
  });

  it('pauses on pagehide so a back/forward-cache restore stays paused, and never plays', () => {
    const { scope, video, view } = makeViewerScope();

    enhanceVideoPlayback(scope);
    enhanceVideoPlayback(scope);
    expect(view.addEventListener).toHaveBeenCalledTimes(1);
    view.listeners.pagehide();

    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('starts Loop off (even if the browser restored the checkbox) and mirrors it onto .loop without playing', () => {
    const { scope, video, loop } = makeViewerScope();

    enhanceVideoPlayback(scope);
    expect(loop.checked).toBe(false);
    expect(video.loop).toBe(false);

    loop.checked = true;
    loop.listeners.change();
    expect(video.loop).toBe(true);
    loop.checked = false;
    loop.listeners.change();
    expect(video.loop).toBe(false);

    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
  });

  it('clears Loop on pagehide so a back/forward-cache restore comes back Loop off without re-initializing', () => {
    const { scope, video, loop, view } = makeViewerScope();

    enhanceVideoPlayback(scope);
    expect(loop.checked).toBe(false);
    expect(video.loop).toBe(false);
    loop.checked = true;
    loop.listeners.change();
    expect(video.loop).toBe(true);

    view.listeners.pagehide();

    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.loop).toBe(false);
    expect(loop.checked).toBe(false);
    expect(video.play).not.toHaveBeenCalled();

    // BFCache restore reuses this same DOM and skips initialization: the
    // preserved state is already Loop off, and the toggle still works.
    enhanceVideoPlayback(scope);
    expect(loop.addEventListener).toHaveBeenCalledTimes(1);
    expect(video.loop).toBe(false);
    expect(loop.checked).toBe(false);
    loop.checked = true;
    loop.listeners.change();
    expect(video.loop).toBe(true);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('only calls play() from the preview dialog opener and never uses autoplay', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:js|njk)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(SRC_DIR, 'static'));
    walk(path.join(SRC_DIR, 'views'));

    const autoplay = files.filter((file) => /<[^>]*\sautoplay\b|\.autoplay\s*=|['"]autoplay['"]/i
      .test(fs.readFileSync(file, 'utf8')));
    expect(autoplay).toEqual([]);

    const playSites = files.flatMap((file) => (fs.readFileSync(file, 'utf8').match(/\.play\??\.?\s*\(/g) || [])
      .map(() => path.relative(SRC_DIR, file).replaceAll('\\', '/')));
    expect(playSites).toEqual(['static/client/asset-video-playback.js']);
    const source = fs.readFileSync(path.join(SRC_DIR, 'static/client/asset-video-playback.js'), 'utf8');
    const playerFn = source.slice(source.indexOf('function playPreviewVideo'), source.indexOf('export function openAssetVideoPreview'));
    expect(playerFn).toMatch(/\.play\?\.\(/);
  });
});

function makeElement(tagName, props = {}) {
  const node = makeNode({ tagName: tagName.toUpperCase(), ...props });
  node.getAttribute = (name) => (node.attributes.has(name) ? node.attributes.get(name) : null);
  node.hasAttribute = (name) => node.attributes.has(name);
  return node;
}

function makePreviewPage({ play } = {}) {
  const created = [];
  const slot = makeElement('div', { children: [] });
  slot.appendChild = vi.fn((child) => { slot.children.push(child); });
  slot.querySelectorAll = (selector) => (selector === '[data-asset-video]'
    ? slot.children.filter((child) => child.hasAttribute('data-asset-video')) : []);
  const title = makeElement('span', { textContent: '' });
  const details = makeElement('a');
  const error = makeElement('p', { hidden: true });
  const loop = makeElement('input', { checked: false });
  const loopControl = makeElement('label');
  const root = makeElement('figure');
  root.querySelector = (selector) => ({
    '[data-asset-video-preview-slot]': slot,
    '[data-asset-video-preview-title]': title,
    '[data-asset-video-preview-details]': details,
    '[data-asset-video-error]': error,
    '[data-asset-video-loop]': loop,
    '[data-asset-video-loop-control]': loopControl,
    '[data-asset-video]': slot.children[0] ?? null,
  })[selector] ?? null;
  const dialogState = { onClose: null };
  const dialog = makeElement('dialog', { __creatorCrateAppDialogState: dialogState });
  dialog.querySelector = (selector) => (selector === '[data-asset-video-preview]' ? root : null);

  const document = makeElement('document', { dataset: undefined, ownerDocument: null });
  document.getElementById = (id) => (id === 'asset-video-preview-dialog' ? dialog : null);
  document.createElement = vi.fn((tag) => {
    const video = makeElement(tag, {
      currentTime: 0,
      loop: false,
      play: vi.fn(play ?? (() => Promise.resolve())),
      pause: vi.fn(),
      load: vi.fn(),
    });
    video.remove = vi.fn(() => {
      slot.children = slot.children.filter((child) => child !== video);
    });
    created.push(video);
    return video;
  });

  const makeTrigger = (attrs) => {
    const trigger = makeElement('a');
    Object.entries(attrs).forEach(([name, value]) => trigger.attributes.set(name, value));
    trigger.closest = (selector) => (selector === '[data-asset-video-preview-trigger]'
      && trigger.hasAttribute('data-asset-video-preview-trigger') ? trigger : null);
    return trigger;
  };
  const videoTrigger = (id, href) => makeTrigger({
    href,
    'data-asset-video-preview-trigger': '',
    'data-video-src': `/projects/7/assets/${id}/original`,
    'data-video-title': `clip-${id}`,
  });
  // The same trigger contract is rendered by every card surface.
  const surfaces = {
    'Project Assets grid': videoTrigger(80, '/projects/7/assets/80?view=grid'),
    'Project Assets list': videoTrigger(80, '/projects/7/assets/80?view=list'),
    'Asset Library grid': videoTrigger(80, '/projects/7/assets/80?returnTo=%2Fasset-viewer%3Fview%3Dgrid'),
    'Asset Library list': videoTrigger(80, '/projects/7/assets/80?returnTo=%2Fasset-viewer%3Fview%3Dlist'),
    'release selection': videoTrigger(80, '/projects/7/assets/80'),
    'release detail grid': videoTrigger(80, '/projects/7/assets/80'),
    'release detail list': videoTrigger(80, '/projects/7/assets/80'),
  };
  const otherVideo = videoTrigger(81, '/projects/7/assets/81');
  const imageTrigger = makeTrigger({ href: '/projects/7/assets/82', 'data-project-assets-preview-id': '82' });
  const plain = (extra = {}) => Object.assign(makeElement('span'), { closest: () => null }, extra);
  const openDialog = vi.fn(() => true);
  const click = (target, extra = {}) => {
    const event = { target, button: 0, defaultPrevented: false, preventDefault: vi.fn(), ...extra };
    document.listeners.click(event);
    return event;
  };
  // The app dialog runs both the native close event and its onClose hook.
  const closeDialog = () => {
    dialog.listeners.close?.();
    dialogState.onClose?.();
  };
  const toggleLoop = (checked) => {
    loop.checked = checked;
    loop.listeners.change();
  };
  const player = () => slot.children[0];
  return {
    document, dialog, root, slot, title, details, error, loop, loopControl, created,
    surfaces, otherVideo, imageTrigger, plain, openDialog, click, closeDialog, toggleLoop, player,
  };
}

describe('shared on-page video preview', () => {
  it.each(Object.keys(makePreviewPage().surfaces))('%s activation opens the shared dialog and plays its player', (surface) => {
    const page = makePreviewPage();
    expect(enhanceAssetVideoPreview(page.document, page.openDialog)).toBe(1);
    const trigger = page.surfaces[surface];

    const event = page.click(trigger);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(page.openDialog).toHaveBeenCalledWith(page.document, VIDEO_PREVIEW_DIALOG_ID, trigger);
    expect(page.slot.children).toHaveLength(1);
    const video = page.player();
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe('/projects/7/assets/80/original');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(0);
    expect(video.loop).toBe(false);
    expect(page.loop.checked).toBe(false);
    expect(page.title.textContent).toBe('clip-80');
    expect(page.details.getAttribute('href')).toBe(trigger.getAttribute('href'));
  });

  it('plays only after the dialog has opened, within the same click handler', () => {
    const page = makePreviewPage();
    const order = [];
    page.openDialog.mockImplementation(() => { order.push('open'); return true; });
    page.document.createElement.mockImplementationOnce((tag) => {
      const video = makeElement(tag, { loop: false, pause: vi.fn(), load: vi.fn(), remove: vi.fn() });
      video.play = vi.fn(() => { order.push('play'); return Promise.resolve(); });
      return video;
    });
    enhanceAssetVideoPreview(page.document, page.openDialog);
    page.click(page.surfaces['Project Assets grid']);
    expect(order).toEqual(['open', 'play']);
  });

  it('never plays passively: binding, pointer-less events, and non-trigger clicks do nothing', () => {
    const page = makePreviewPage();
    enhanceAssetVideoPreview(page.document, page.openDialog);
    enhanceAssetVideoPreview(page.document, page.openDialog);

    expect(Object.keys(page.document.listeners)).toEqual(['click']);
    page.click(page.plain());
    expect(page.document.createElement).not.toHaveBeenCalled();
    expect(page.openDialog).not.toHaveBeenCalled();
  });

  it('pauses, detaches, and resets Loop on close; reopening plays a fresh player at 0 with Loop off', () => {
    const page = makePreviewPage();
    enhanceAssetVideoPreview(page.document, page.openDialog);

    page.click(page.surfaces['Asset Library grid']);
    const first = page.player();
    page.toggleLoop(true);
    expect(first.loop).toBe(true);
    page.toggleLoop(false);
    expect(first.loop).toBe(false);
    page.toggleLoop(true);
    expect(first.play).toHaveBeenCalledTimes(1);
    page.closeDialog();

    expect(first.pause).toHaveBeenCalled();
    expect(first.loop).toBe(false);
    expect(first.removeAttribute).toHaveBeenCalledWith('src');
    expect(first.load).toHaveBeenCalled();
    expect(page.slot.children).toHaveLength(0);
    expect(page.loop.checked).toBe(false);

    page.click(page.surfaces['Asset Library grid']);
    const second = page.player();
    expect(second).not.toBe(first);
    expect(second.currentTime).toBe(0);
    expect(second.loop).toBe(false);
    expect(page.loop.checked).toBe(false);
    expect(second.play).toHaveBeenCalledTimes(1);
    expect(first.play).toHaveBeenCalledTimes(1);
  });

  it('switching from video A to B stops A, resets Loop, and leaves only B playing', () => {
    const page = makePreviewPage();
    enhanceAssetVideoPreview(page.document, page.openDialog);
    page.click(page.surfaces['release detail grid']);
    const first = page.player();
    page.toggleLoop(true);

    page.click(page.otherVideo);

    expect(page.created).toHaveLength(2);
    expect(first.pause).toHaveBeenCalled();
    expect(first.removeAttribute).toHaveBeenCalledWith('src');
    expect(page.slot.children).toEqual([page.created[1]]);
    expect(page.player().getAttribute('src')).toBe('/projects/7/assets/81/original');
    expect(page.player().loop).toBe(false);
    expect(page.loop.checked).toBe(false);
    expect(page.player().play).toHaveBeenCalledTimes(1);
    expect(page.title.textContent).toBe('clip-81');
  });

  it('leaves an open preview paused with Loop off after pagehide, without playing it', () => {
    const page = makePreviewPage();
    enhanceAssetVideoPreview(page.document, page.openDialog);
    page.click(page.surfaces['Project Assets grid']);
    const video = page.player();
    page.toggleLoop(true);
    expect(video.loop).toBe(true);

    const view = makeNode();
    const scope = {
      defaultView: view,
      querySelectorAll: (selector) => ({
        '[data-asset-video-playback]': [page.root],
        '[data-asset-video]': page.slot.children,
      })[selector] ?? [],
    };
    enhanceVideoPlayback(scope);
    view.listeners.pagehide();

    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.loop).toBe(false);
    expect(page.loop.checked).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('ignores the stale close event from re-showing an already open dialog', () => {
    const page = makePreviewPage();
    enhanceAssetVideoPreview(page.document, page.openDialog);
    page.click(page.surfaces['Project Assets grid']);
    const [first] = page.created;
    page.click(page.otherVideo);
    const second = page.player();

    // The re-show's close event lands while the dialog is open again.
    page.dialog.open = true;
    page.closeDialog();
    expect(page.slot.children).toEqual([second]);
    expect(second.pause).not.toHaveBeenCalled();
    expect(first.pause).toHaveBeenCalled();

    page.dialog.open = false;
    page.closeDialog();
    expect(second.pause).toHaveBeenCalled();
    expect(page.slot.children).toHaveLength(0);
  });

  it.each([
    ['rejects', () => Promise.reject(new DOMException('blocked', 'NotAllowedError'))],
    ['throws', () => { throw new Error('legacy play failure'); }],
  ])('keeps the dialog open with native controls and no codec error when play() %s', async (_label, play) => {
    const page = makePreviewPage({ play });
    enhanceAssetVideoPreview(page.document, page.openDialog);

    const event = page.click(page.surfaces['release selection']);
    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(page.slot.children).toHaveLength(1);
    expect(page.player().hasAttribute('controls')).toBe(true);
    expect(page.player().hidden).toBe(false);
    expect(page.root.dataset.videoState).toBeUndefined();
    expect(page.error.hidden).toBe(true);
    expect(page.player().play).toHaveBeenCalledTimes(1);
  });

  it('shows the codec error on a genuine media error and resets it on reopen', () => {
    const page = makePreviewPage();
    enhanceAssetVideoPreview(page.document, page.openDialog);
    page.click(page.surfaces['Project Assets list']);
    page.created[0].listeners.error();
    expect(page.root.dataset.videoState).toBe('failed');
    expect(page.error.hidden).toBe(false);
    expect(page.loopControl.hidden).toBe(true);

    page.closeDialog();
    page.click(page.surfaces['Project Assets list']);
    expect(page.root.dataset.videoState).toBeUndefined();
    expect(page.error.hidden).toBe(true);
    expect(page.loopControl.hidden).toBe(false);
  });

  it('leaves image links, selection/details controls, modified clicks, and handled clicks alone', () => {
    const page = makePreviewPage();
    enhanceAssetVideoPreview(page.document, page.openDialog);
    const trigger = page.surfaces['Asset Library list'];

    expect(page.click(page.imageTrigger).preventDefault).not.toHaveBeenCalled();
    expect(page.click(page.plain({ tagName: 'INPUT' })).preventDefault).not.toHaveBeenCalled();
    expect(page.click(trigger, { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(page.click(trigger, { metaKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(page.click(trigger, { shiftKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(page.click(trigger, { button: 1 }).preventDefault).not.toHaveBeenCalled();
    expect(page.click(trigger, { defaultPrevented: true }).preventDefault).not.toHaveBeenCalled();
    expect(page.openDialog).not.toHaveBeenCalled();
    expect(page.created).toHaveLength(0);
  });

  it('keeps link navigation and never plays when the dialog cannot open', () => {
    const page = makePreviewPage();
    page.openDialog.mockReturnValue(false);
    enhanceAssetVideoPreview(page.document, page.openDialog);
    const event = page.click(page.surfaces['Project Assets grid']);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(page.slot.children).toHaveLength(0);
    expect(page.created[0].play).not.toHaveBeenCalled();
  });

  it('does nothing on pages without the preview dialog', () => {
    const page = makePreviewPage();
    page.document.getElementById = () => null;
    expect(enhanceAssetVideoPreview(page.document, page.openDialog)).toBe(0);
    expect(page.document.addEventListener).not.toHaveBeenCalled();
  });
});

describe('card video frames', () => {
  function makeFrame({ error = null } = {}) {
    const placeholder = makeElement('span', { hidden: true });
    const parent = makeElement('a');
    parent.querySelector = (selector) => (selector === '[data-asset-video-placeholder]' ? placeholder : null);
    const root = makeElement('span', { parentElement: parent });
    const frame = makeElement('video', { error, loop: false, play: vi.fn() });
    frame.closest = (selector) => (selector === '[data-asset-video-frame-root]' ? root : null);
    frame.matches = (selector) => selector === '[data-asset-video-frame]';
    return { frame, root, placeholder };
  }

  it('swaps a failed frame for the static placeholder, including frames inserted later, and never plays or loops', () => {
    const existing = makeFrame({ error: { code: 4 } });
    const later = makeFrame();
    const document = makeElement('document', { dataset: undefined, ownerDocument: null });
    document.querySelectorAll = (selector) => (selector === '[data-asset-video-frame]' ? [existing.frame] : []);

    expect(enhanceVideoFrames(document)).toBe(1);
    expect(existing.root.hidden).toBe(true);
    expect(existing.placeholder.hidden).toBe(false);

    const [, captureHandler, capture] = document.addEventListener.mock.calls.find(([type]) => type === 'error');
    expect(capture).toBe(true);
    captureHandler({ target: later.frame });
    expect(later.root.hidden).toBe(true);
    expect(later.placeholder.hidden).toBe(false);
    for (const { frame } of [existing, later]) {
      expect(frame.play).not.toHaveBeenCalled();
      expect(frame.loop).toBe(false);
    }
  });
});
