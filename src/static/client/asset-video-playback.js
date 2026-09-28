import {
  hideElement,
  isEnhancementBound,
  markEnhancementBound,
  showElement,
} from './dom.js';

const VIDEO_ROOT_SELECTOR = '[data-asset-video-playback]';
const VIDEO_SELECTOR = '[data-asset-video]';
const VIDEO_ERROR_SELECTOR = '[data-asset-video-error]';
const VIDEO_LOOP_SELECTOR = '[data-asset-video-loop]';
const VIDEO_LOOP_CONTROL_SELECTOR = '[data-asset-video-loop-control]';

// A supported container can still carry a codec the browser cannot decode.
// Surface a static message instead of a broken player; metadata and asset
// actions live outside this root and are unaffected.
export function markVideoPlaybackFailed(root) {
  if (!root) return 'skipped';
  const video = root.querySelector?.(VIDEO_SELECTOR);
  const message = root.querySelector?.(VIDEO_ERROR_SELECTOR);
  if (root.dataset) root.dataset.videoState = 'failed';
  root.setAttribute?.('data-video-state', 'failed');
  hideElement(video);
  hideElement(root.querySelector?.(VIDEO_LOOP_CONTROL_SELECTOR));
  showElement(message);
  return 'failed';
}

// Loop is transient per playable video: it starts off and is never persisted.
export function resetVideoLoop(root) {
  const checkbox = root?.querySelector?.(VIDEO_LOOP_SELECTOR);
  if (checkbox) checkbox.checked = false;
  const video = root?.querySelector?.(VIDEO_SELECTOR);
  if (video) video.loop = false;
}

/**
 * The Loop checkbox only mirrors itself onto the root's current player's
 * native `.loop`; it never plays or pauses. The player is looked up on each
 * change so the preview dialog's per-open player is always the target.
 */
function bindVideoLoop(root) {
  const checkbox = root?.querySelector?.(VIDEO_LOOP_SELECTOR);
  if (!checkbox || isEnhancementBound(checkbox, 'videoLoopBound')) return;
  markEnhancementBound(checkbox, 'videoLoopBound');
  resetVideoLoop(root);
  checkbox.addEventListener?.('change', () => {
    const video = root.querySelector?.(VIDEO_SELECTOR);
    if (video) video.loop = Boolean(checkbox.checked);
  });
}

/**
 * Bind error handling and the Loop toggle for native video players (the Asset
 * Viewer player and the shared preview dialog). This never starts playback:
 * the Asset Viewer element has no `autoplay`, and only the browser's native
 * controls may play it.
 */
export function enhanceVideoPlayback(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const roots = scope.querySelectorAll(VIDEO_ROOT_SELECTOR);
  roots.forEach((root) => {
    if (isEnhancementBound(root, 'videoPlaybackBound')) return;
    markEnhancementBound(root, 'videoPlaybackBound');
    bindVideoLoop(root);
    const video = root.querySelector?.(VIDEO_SELECTOR);
    if (!video) return;
    if (video.error) {
      markVideoPlaybackFailed(root);
      return;
    }
    video.addEventListener?.('error', () => markVideoPlaybackFailed(root), { once: true });
  });

  // Pausing and clearing Loop on pagehide means a page restored from the
  // back/forward cache (which skips this initialization) comes back paused
  // with Loop off instead of resuming or keeping a stale loop.
  const view = scope.defaultView ?? scope.ownerDocument?.defaultView;
  if (roots.length > 0 && view && !isEnhancementBound(view, 'videoPagehideBound')) {
    markEnhancementBound(view, 'videoPagehideBound');
    view.addEventListener?.('pagehide', () => {
      scope.querySelectorAll(VIDEO_SELECTOR).forEach((video) => video.pause?.());
      scope.querySelectorAll(VIDEO_ROOT_SELECTOR).forEach(resetVideoLoop);
    });
  }
  return roots.length;
}

const VIDEO_FRAME_SELECTOR = '[data-asset-video-frame]';
const VIDEO_FRAME_ROOT_SELECTOR = '[data-asset-video-frame-root]';
const VIDEO_PLACEHOLDER_SELECTOR = '[data-asset-video-placeholder]';
const VIDEO_PREVIEW_TRIGGER_SELECTOR = '[data-asset-video-preview-trigger]';
export const VIDEO_PREVIEW_DIALOG_ID = 'asset-video-preview-dialog';
const VIDEO_PREVIEW_ROOT_SELECTOR = '[data-asset-video-preview]';
const VIDEO_PREVIEW_SLOT_SELECTOR = '[data-asset-video-preview-slot]';
const VIDEO_PREVIEW_TITLE_SELECTOR = '[data-asset-video-preview-title]';
const VIDEO_PREVIEW_DETAILS_SELECTOR = '[data-asset-video-preview-details]';

// A card frame that cannot load falls back to the static video placeholder,
// so an undecodable codec never leaves an empty media area.
export function markVideoFrameFailed(frame) {
  const root = frame?.closest?.(VIDEO_FRAME_ROOT_SELECTOR);
  if (!root) return 'skipped';
  hideElement(root);
  showElement(root.parentElement?.querySelector?.(VIDEO_PLACEHOLDER_SELECTOR));
  return 'failed';
}

/**
 * Card frames are inert `<video preload="metadata">` elements used only for
 * their intrinsic size and first frame; nothing here plays them. Media
 * `error` events do not bubble, so one capturing listener covers cards that
 * live regions insert later.
 */
export function enhanceVideoFrames(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const frames = Array.from(scope.querySelectorAll(VIDEO_FRAME_SELECTOR));
  frames.forEach((frame) => {
    if (frame.error) markVideoFrameFailed(frame);
  });
  const document = scope.ownerDocument ?? scope;
  if (!isEnhancementBound(document, 'videoFrameErrorsBound')) {
    markEnhancementBound(document, 'videoFrameErrorsBound');
    document.addEventListener?.('error', (event) => {
      if (event.target?.matches?.(VIDEO_FRAME_SELECTOR)) markVideoFrameFailed(event.target);
    }, true);
  }
  return frames.length;
}

function stopPreviewVideo(root) {
  const slot = root?.querySelector?.(VIDEO_PREVIEW_SLOT_SELECTOR);
  slot?.querySelectorAll?.(VIDEO_SELECTOR).forEach((video) => {
    video.pause?.();
    video.loop = false;
    // Dropping the source aborts any in-flight range request.
    video.removeAttribute?.('src');
    video.load?.();
    video.remove?.();
  });
  const checkbox = root?.querySelector?.(VIDEO_LOOP_SELECTOR);
  if (checkbox) checkbox.checked = false;
}

function resetPreviewError(root) {
  if (root.dataset) delete root.dataset.videoState;
  root.removeAttribute?.('data-video-state');
  hideElement(root.querySelector?.(VIDEO_ERROR_SELECTOR));
  showElement(root.querySelector?.(VIDEO_LOOP_CONTROL_SELECTOR));
}

function bindPreviewDialogClose(dialog, root) {
  if (isEnhancementBound(dialog, 'videoPreviewCloseBound')) return;
  markEnhancementBound(dialog, 'videoPreviewCloseBound');
  // Re-opening an already open dialog closes and re-shows it, and that close
  // event arrives after the next video was inserted; only a close that leaves
  // the dialog shut may stop playback.
  const stop = () => {
    if (dialog.open) return;
    stopPreviewVideo(root);
  };
  dialog.addEventListener?.('close', stop);
  const state = dialog.__creatorCrateAppDialogState;
  if (state) {
    const previousOnClose = state.onClose;
    state.onClose = () => {
      stop();
      previousOnClose?.();
    };
  }
}

/**
 * Start the dialog's own player from the click that opened it. A rejected
 * play() (autoplay policy, lost activation) is not a media failure: the dialog
 * stays open with native controls so the user can press Play, and genuine
 * decode errors still arrive through the element's `error` event.
 */
function playPreviewVideo(video) {
  try {
    const result = video.play?.();
    result?.catch?.(() => {});
  } catch {
    // Older engines may throw synchronously; the native controls stay usable.
  }
}

/**
 * Open the shared video preview dialog for a card link and play it. A fresh
 * `<video controls playsinline preload="metadata">` is inserted each time at
 * time 0 with Loop off; any previous player is stopped and removed first, so
 * only one preview player ever exists. Closing pauses and removes it. Card
 * frame videos are never touched: the only element played is the one created
 * here.
 */
export function openAssetVideoPreview(document, trigger, openDialog) {
  const dialog = document?.getElementById?.(VIDEO_PREVIEW_DIALOG_ID);
  const root = dialog?.querySelector?.(VIDEO_PREVIEW_ROOT_SELECTOR);
  const slot = root?.querySelector?.(VIDEO_PREVIEW_SLOT_SELECTOR);
  const src = trigger?.getAttribute?.('data-video-src');
  if (!dialog || !root || !slot || !src || typeof document.createElement !== 'function') return false;

  bindPreviewDialogClose(dialog, root);
  bindVideoLoop(root);
  stopPreviewVideo(root);
  resetPreviewError(root);

  const video = document.createElement('video');
  video.className = 'asset-preview-video asset-video-preview-media';
  video.setAttribute('controls', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('preload', 'metadata');
  video.setAttribute('data-asset-video', '');
  video.loop = false;
  video.addEventListener?.('error', () => markVideoPlaybackFailed(root), { once: true });
  video.setAttribute('src', src);
  slot.appendChild(video);
  resetVideoLoop(root);

  const title = root.querySelector?.(VIDEO_PREVIEW_TITLE_SELECTOR);
  if (title) title.textContent = trigger.getAttribute?.('data-video-title') || '';
  const details = root.querySelector?.(VIDEO_PREVIEW_DETAILS_SELECTOR);
  const href = trigger.getAttribute?.('href');
  if (details && href) details.setAttribute('href', href);

  if (!openDialog(document, VIDEO_PREVIEW_DIALOG_ID, trigger)) {
    stopPreviewVideo(root);
    return false;
  }
  playPreviewVideo(video);
  return true;
}

/**
 * Delegated so video cards on every surface (Project Assets, Asset Library,
 * release selection, release detail), including cards re-rendered by live
 * filtering or Grid/List switching, share the one layout-level dialog without
 * rebinding. Only an unmodified primary activation (mouse click, or Enter on
 * the focused link) opens and plays; modified and middle clicks keep the
 * link's navigation to the Asset Viewer.
 */
export function enhanceAssetVideoPreview(scope = globalThis.document, openDialog) {
  const document = scope?.ownerDocument ?? scope;
  if (!document || typeof document.addEventListener !== 'function' || typeof openDialog !== 'function') return 0;
  if (!document.getElementById?.(VIDEO_PREVIEW_DIALOG_ID)) return 0;
  if (isEnhancementBound(document, 'videoPreviewTriggersBound')) return 1;
  markEnhancementBound(document, 'videoPreviewTriggersBound');
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const trigger = event.target?.closest?.(VIDEO_PREVIEW_TRIGGER_SELECTOR);
    if (!trigger) return;
    if (openAssetVideoPreview(document, trigger, openDialog)) event.preventDefault?.();
  });
  return 1;
}
