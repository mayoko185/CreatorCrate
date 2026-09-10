import { isEnhancementBound, markEnhancementBound } from './dom.js';

const ASSET_VIEWER_INFO_SELECTOR = '[data-asset-info-card]';
const ASSET_VIEWER_PREVIEW_SELECTOR = '[data-asset-viewer-preview]';
const GRID_INFO_GUTTER = 8;
const GRID_INFO_POINTER_OFFSET = 12;
const PROJECT_INFO_SELECTOR = '[data-project-info-card]';
const PROJECT_PREVIEW_SELECTOR = '[data-project-grid-preview]';
const DIALOG_TRIGGER_SELECTOR = '[data-dialog-open]';

const ASSET_VIEWER_INFO_CONFIG = Object.freeze({
  infoSelector: ASSET_VIEWER_INFO_SELECTOR,
  previewSelector: ASSET_VIEWER_PREVIEW_SELECTOR,
  gutter: GRID_INFO_GUTTER,
  pointerOffset: GRID_INFO_POINTER_OFFSET,
  leftProperty: '--asset-info-left',
  topProperty: '--asset-info-top',
  boundKey: 'assetViewerInfoBound',
});
const PROJECT_INFO_CONFIG = Object.freeze({
  infoSelector: PROJECT_INFO_SELECTOR,
  previewSelector: PROJECT_PREVIEW_SELECTOR,
  gutter: GRID_INFO_GUTTER,
  pointerOffset: GRID_INFO_POINTER_OFFSET,
  leftProperty: '--project-info-left',
  topProperty: '--project-info-top',
  boundKey: 'projectInfoBound',
});

let activeGridInfoPlacement = null;
let pendingGridInfoFrame = null;
const gridInfoBoundDocuments = new WeakSet();
const gridInfoBoundWindows = new WeakSet();

function gridInfoDocument(preview, info) {
  return info?.ownerDocument || preview?.ownerDocument || globalThis.document || null;
}

function gridInfoWindow(document) {
  return document?.defaultView || globalThis;
}

function gridInfoIsConnected(info) {
  return info?.isConnected !== false;
}

function gridInfoViewport(document) {
  const windowObject = gridInfoWindow(document);
  return {
    width: Number(document?.documentElement?.clientWidth) || Number(windowObject?.innerWidth),
    height: Number(document?.documentElement?.clientHeight) || Number(windowObject?.innerHeight),
  };
}

function showGridInfo(info) {
  info.setAttribute?.('data-info-card-open', 'true');
  if (typeof info.showPopover !== 'function') return;
  try {
    if (!info.matches?.(':popover-open')) info.showPopover();
  } catch {
    // The data attribute retains the readable non-Popover API fallback.
  }
}

function hideGridInfo(info) {
  if (!info) return;
  if (typeof info.hidePopover === 'function') {
    try {
      if (!info.matches || info.matches(':popover-open')) info.hidePopover();
    } catch {
      // A removed popover is already absent from the top layer.
    }
  }
  info.removeAttribute?.('data-info-card-open');
  info.removeAttribute?.('data-positioned');
}

function cancelPendingGridInfoFrame() {
  if (!pendingGridInfoFrame) return;
  pendingGridInfoFrame.windowObject?.cancelAnimationFrame?.(pendingGridInfoFrame.id);
  pendingGridInfoFrame = null;
}

export function dismissActiveGridInfoCard() {
  cancelPendingGridInfoFrame();
  hideGridInfo(activeGridInfoPlacement?.info);
  activeGridInfoPlacement = null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

export function positionGridInfo(preview, info, config, anchor = { type: 'focus' }) {
  if (!preview || !info || typeof preview.getBoundingClientRect !== 'function') return false;

  const document = gridInfoDocument(preview, info);
  const viewport = gridInfoViewport(document);
  if (!(viewport.width > 0) || !(viewport.height > 0)) return false;

  const previewRect = preview.getBoundingClientRect();
  const infoRect = typeof info.getBoundingClientRect === 'function'
    ? info.getBoundingClientRect()
    : { width: 0, height: 0 };
  const availableWidth = Math.max(0, viewport.width - (config.gutter * 2));
  const availableHeight = Math.max(0, viewport.height - (config.gutter * 2));
  const infoWidth = Math.min(
    Math.max(Number(info.offsetWidth) || Number(infoRect.width) || 0, 0),
    availableWidth,
  );
  const infoHeight = Math.min(
    Math.max(Number(info.offsetHeight) || Number(infoRect.height) || 0, 0),
    availableHeight,
  );
  if (!(infoWidth > 0) || !(infoHeight > 0)) return false;

  let left;
  let top;
  if (anchor?.type === 'pointer'
    && Number.isFinite(anchor.clientX)
    && Number.isFinite(anchor.clientY)) {
    left = anchor.clientX + config.pointerOffset;
    if (left + infoWidth > viewport.width - config.gutter) {
      left = anchor.clientX - config.pointerOffset - infoWidth;
    }
    top = anchor.clientY + config.pointerOffset;
    if (top + infoHeight > viewport.height - config.gutter) {
      top = anchor.clientY - config.pointerOffset - infoHeight;
    }
  } else {
    left = previewRect.left + ((previewRect.width - infoWidth) / 2);
    const belowTop = previewRect.bottom + config.gutter;
    const aboveTop = previewRect.top - config.gutter - infoHeight;
    top = belowTop;
    if (belowTop + infoHeight > viewport.height - config.gutter && aboveTop >= config.gutter) {
      top = aboveTop;
    }
  }

  left = clamp(left, config.gutter, viewport.width - config.gutter - infoWidth);
  top = clamp(top, config.gutter, viewport.height - config.gutter - infoHeight);
  info.style?.setProperty?.(config.leftProperty, `${left}px`);
  info.style?.setProperty?.(config.topProperty, `${top}px`);
  info.setAttribute?.('data-positioned', 'true');
  return true;
}

function repositionActiveGridInfo() {
  pendingGridInfoFrame = null;
  if (!activeGridInfoPlacement) return;
  if (!gridInfoIsConnected(activeGridInfoPlacement.info)) {
    dismissActiveGridInfoCard();
    return;
  }
  positionGridInfo(
    activeGridInfoPlacement.preview,
    activeGridInfoPlacement.info,
    activeGridInfoPlacement.config,
    activeGridInfoPlacement.anchor,
  );
}

function scheduleActiveGridInfoPosition() {
  if (!activeGridInfoPlacement || pendingGridInfoFrame) return;
  const windowObject = gridInfoWindow(activeGridInfoPlacement.document);
  if (typeof windowObject?.requestAnimationFrame !== 'function') {
    repositionActiveGridInfo();
    return;
  }
  const frame = { windowObject, id: null };
  pendingGridInfoFrame = frame;
  frame.id = windowObject.requestAnimationFrame(repositionActiveGridInfo);
}

function activateGridInfo(preview, info, config, state, anchor) {
  if (activeGridInfoPlacement?.info !== info) dismissActiveGridInfoCard();
  showGridInfo(info);
  activeGridInfoPlacement = {
    preview,
    info,
    config,
    state,
    anchor,
    document: gridInfoDocument(preview, info),
  };
  scheduleActiveGridInfoPosition();
}

function bindGridInfoLifecycle(document) {
  if (!document || (typeof document !== 'object' && typeof document !== 'function')) return;
  if (!gridInfoBoundDocuments.has(document)) {
    gridInfoBoundDocuments.add(document);
    document.addEventListener?.('click', (event) => {
      if (event.target?.closest?.(DIALOG_TRIGGER_SELECTOR)) dismissActiveGridInfoCard();
    }, true);

    const MutationObserverClass = gridInfoWindow(document)?.MutationObserver;
    if (typeof MutationObserverClass === 'function') {
      const observer = new MutationObserverClass(() => {
        if (activeGridInfoPlacement && !gridInfoIsConnected(activeGridInfoPlacement.info)) {
          dismissActiveGridInfoCard();
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  }

  const windowObject = gridInfoWindow(document);
  if (!windowObject || (typeof windowObject !== 'object' && typeof windowObject !== 'function')
    || gridInfoBoundWindows.has(windowObject)) return;
  gridInfoBoundWindows.add(windowObject);
  windowObject.addEventListener?.('resize', scheduleActiveGridInfoPosition);
  windowObject.addEventListener?.('scroll', (event) => {
    if (activeGridInfoPlacement?.info === event?.target
      || activeGridInfoPlacement?.info?.contains?.(event?.target)) return;
    if (activeGridInfoPlacement?.anchor?.type === 'pointer') dismissActiveGridInfoCard();
    else scheduleActiveGridInfoPosition();
  }, true);
}

function enhanceGridInfoCards(scope, config) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  if (activeGridInfoPlacement && !gridInfoIsConnected(activeGridInfoPlacement.info)) {
    dismissActiveGridInfoCard();
  }

  const previews = scope.querySelectorAll(config.previewSelector);
  let boundCount = 0;
  previews.forEach((preview) => {
    const info = preview.querySelector?.(config.infoSelector);
    if (!info || isEnhancementBound(preview, config.boundKey)) return;

    markEnhancementBound(preview, config.boundKey);
    boundCount += 1;
    const state = {
      focusInside: false,
      pointerInside: false,
      pointer: null,
    };
    const pointerAnchor = (event) => ({
      type: 'pointer',
      clientX: Number(event?.clientX),
      clientY: Number(event?.clientY),
    });

    preview.addEventListener?.('pointerenter', (event) => {
      state.pointerInside = true;
      state.pointer = pointerAnchor(event);
      activateGridInfo(preview, info, config, state, state.pointer);
    });
    preview.addEventListener?.('pointermove', (event) => {
      if (!state.pointerInside) return;
      state.pointer = pointerAnchor(event);
      if (activeGridInfoPlacement?.info !== info) {
        activateGridInfo(preview, info, config, state, state.pointer);
        return;
      }
      activeGridInfoPlacement.anchor = state.pointer;
      scheduleActiveGridInfoPosition();
    });
    preview.addEventListener?.('pointerleave', () => {
      state.pointerInside = false;
      state.pointer = null;
      if (activeGridInfoPlacement?.info !== info) return;
      if (state.focusInside) activateGridInfo(preview, info, config, state, { type: 'focus' });
      else dismissActiveGridInfoCard();
    });
    preview.addEventListener?.('focusin', () => {
      state.focusInside = true;
      if (!state.pointerInside) activateGridInfo(preview, info, config, state, { type: 'focus' });
    });
    preview.addEventListener?.('focusout', (event) => {
      if (preview.contains?.(event.relatedTarget)) return;
      state.focusInside = false;
      if (activeGridInfoPlacement?.info !== info) return;
      if (state.pointerInside && state.pointer) {
        activateGridInfo(preview, info, config, state, state.pointer);
      } else {
        dismissActiveGridInfoCard();
      }
    });
  });

  if (boundCount > 0) bindGridInfoLifecycle(gridInfoDocument(scope));
  return boundCount;
}

export function enhanceAssetViewerInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, ASSET_VIEWER_INFO_CONFIG);
}

export function enhanceProjectInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, PROJECT_INFO_CONFIG);
}
