import { isEnhancementBound, markEnhancementBound } from './dom.js';

const ASSET_VIEWER_INFO_SELECTOR = '[data-asset-info-card]';
const ASSET_VIEWER_PREVIEW_SELECTOR = '[data-asset-viewer-preview]';
const GRID_INFO_GUTTER = 8;
const GRID_INFO_POINTER_OFFSET = 12;
// Long enough for a mouse that briefly overshoots a title to reach its card,
// short enough that a card left behind still feels transient.
const LINK_INFO_DISMISS_DELAY_MS = 200;
const PROJECT_INFO_SELECTOR = '[data-project-info-card]';
const PROJECT_PREVIEW_SELECTOR = '[data-project-grid-preview]';
const CALENDAR_INFO_SELECTOR = '[data-calendar-info-card]';
const CALENDAR_EVENT_SELECTOR = '[data-calendar-event]';
const CALENDAR_TRIGGER_SELECTOR = '[data-calendar-info-trigger]';
const DASHBOARD_TITLE_SELECTOR = '[data-dashboard-title-info]';
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
const CALENDAR_INFO_CONFIG = Object.freeze({
  infoSelector: CALENDAR_INFO_SELECTOR,
  previewSelector: CALENDAR_EVENT_SELECTOR,
  triggerSelector: CALENDAR_TRIGGER_SELECTOR,
  interaction: 'hybrid',
  gutter: GRID_INFO_GUTTER,
  pointerOffset: GRID_INFO_POINTER_OFFSET,
  leftProperty: '--asset-info-left',
  topProperty: '--asset-info-top',
  boundKey: 'calendarInfoBound',
});
// Dashboard titles are navigation links, so a click cannot pin the card the
// way a Calendar trigger does. Hover and focus open it instead, and Escape
// dismisses it, returning focus to the title link only when focus was inside
// the card being hidden. The card holds actions,
// so it stays anchored to the title link rather than following the pointer.
// It sits flush against the link because dashboard rows stack other titles
// directly below, and any gap would let the pointer cross one of them on the
// way into the card. Leaving the title only dismisses it after a short grace
// period, so a pointer that overshoots on the way in can still reach it.
const DASHBOARD_TITLE_INFO_CONFIG = Object.freeze({
  infoSelector: CALENDAR_INFO_SELECTOR,
  previewSelector: DASHBOARD_TITLE_SELECTOR,
  placementSelector: ':scope > a[href]',
  interaction: 'link',
  gutter: GRID_INFO_GUTTER,
  anchorGap: 0,
  pointerOffset: GRID_INFO_POINTER_OFFSET,
  leftProperty: '--asset-info-left',
  topProperty: '--asset-info-top',
  boundKey: 'dashboardTitleInfoBound',
});

let activeGridInfoPlacement = null;
let pendingGridInfoFrame = null;
let pendingGridInfoDismissal = null;
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

function activeGridInfoIsConnected() {
  return gridInfoIsConnected(activeGridInfoPlacement?.info)
    && gridInfoIsConnected(activeGridInfoPlacement?.preview);
}

function calendarTriggerIsVisible(trigger) {
  return trigger?.getClientRects?.().length !== 0;
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

function cancelPendingGridInfoDismissal() {
  if (!pendingGridInfoDismissal) return;
  pendingGridInfoDismissal.windowObject.clearTimeout(pendingGridInfoDismissal.id);
  pendingGridInfoDismissal = null;
}

function scheduleGridInfoDismissal(info, delay) {
  cancelPendingGridInfoDismissal();
  const windowObject = gridInfoWindow(activeGridInfoPlacement?.document);
  if (typeof windowObject?.setTimeout !== 'function') {
    dismissActiveGridInfoCard();
    return;
  }
  const dismissal = { windowObject, id: null };
  pendingGridInfoDismissal = dismissal;
  dismissal.id = windowObject.setTimeout(() => {
    if (pendingGridInfoDismissal !== dismissal) return;
    pendingGridInfoDismissal = null;
    if (activeGridInfoPlacement?.info === info) dismissActiveGridInfoCard();
  }, delay);
}

export function dismissActiveGridInfoCard() {
  cancelPendingGridInfoFrame();
  cancelPendingGridInfoDismissal();
  if (activeGridInfoPlacement?.config.interaction === 'hybrid') {
    activeGridInfoPlacement.trigger?.setAttribute?.('aria-expanded', 'false');
  }
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
    const anchorGap = config.anchorGap ?? config.gutter;
    left = previewRect.left + ((previewRect.width - infoWidth) / 2);
    const belowTop = previewRect.bottom + anchorGap;
    const aboveTop = previewRect.top - anchorGap - infoHeight;
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
  if (!activeGridInfoIsConnected()
    || (activeGridInfoPlacement.config.interaction === 'hybrid'
      && !calendarTriggerIsVisible(activeGridInfoPlacement.trigger))) {
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

function activateGridInfo(preview, info, config, state, anchor, trigger = null, pinned = false) {
  cancelPendingGridInfoDismissal();
  if (activeGridInfoPlacement?.info !== info) dismissActiveGridInfoCard();
  showGridInfo(info);
  if (config.interaction === 'hybrid') trigger?.setAttribute?.('aria-expanded', 'true');
  activeGridInfoPlacement = {
    preview,
    info,
    config,
    state,
    anchor,
    trigger,
    pinned,
    document: gridInfoDocument(preview, info),
  };
  scheduleActiveGridInfoPosition();
}

// Hiding a popover leaves focus on its descendant until the next rendering
// update, so a key pressed in between would activate a hidden card action.
// Focus moves synchronously to the link the card describes instead, without
// letting that focus reopen the card just dismissed.
function restoreLinkInfoFocus(info, state) {
  const returnFocus = state?.returnFocus;
  if (returnFocus && gridInfoIsConnected(returnFocus) && typeof returnFocus.focus === 'function') {
    state.restoringFocus = true;
    try {
      returnFocus.focus();
    } finally {
      state.restoringFocus = false;
    }
    if (!info.contains?.(gridInfoDocument(null, info)?.activeElement)) return;
  }
  gridInfoDocument(null, info)?.activeElement?.blur?.();
}

function bindGridInfoLifecycle(document) {
  if (!document || (typeof document !== 'object' && typeof document !== 'function')) return;
  if (!gridInfoBoundDocuments.has(document)) {
    gridInfoBoundDocuments.add(document);
    document.addEventListener?.('click', (event) => {
      if (event.target?.closest?.(DIALOG_TRIGGER_SELECTOR)) dismissActiveGridInfoCard();
      if (activeGridInfoPlacement?.config.interaction !== 'hybrid') return;
      if (activeGridInfoPlacement.info.contains?.(event.target)
        || activeGridInfoPlacement.trigger?.contains?.(event.target)) return;
      dismissActiveGridInfoCard();
    }, true);
    document.addEventListener?.('keydown', (event) => {
      const interaction = activeGridInfoPlacement?.config.interaction;
      if (event.key !== 'Escape' || (interaction !== 'hybrid' && interaction !== 'link')) return;
      const { trigger, pinned, info, state } = activeGridInfoPlacement;
      const focusInCard = interaction === 'link'
        && info.contains?.(gridInfoDocument(null, info)?.activeElement);
      dismissActiveGridInfoCard();
      if (pinned && gridInfoIsConnected(trigger)) trigger?.focus?.();
      if (focusInCard) restoreLinkInfoFocus(info, state);
    });

    const MutationObserverClass = gridInfoWindow(document)?.MutationObserver;
    if (typeof MutationObserverClass === 'function') {
      const observer = new MutationObserverClass(() => {
        if (activeGridInfoPlacement && !activeGridInfoIsConnected()) {
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
    if (activeGridInfoPlacement?.anchor?.type === 'pointer' && !activeGridInfoPlacement.pinned) dismissActiveGridInfoCard();
    else scheduleActiveGridInfoPosition();
  }, true);
}

function enhanceGridInfoCards(scope, config) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  if (activeGridInfoPlacement && !activeGridInfoIsConnected()) {
    dismissActiveGridInfoCard();
  }

  const previews = scope.querySelectorAll(config.previewSelector);
  let boundCount = 0;
  previews.forEach((preview) => {
    const info = preview.querySelector?.(config.infoSelector);
    if (!info || isEnhancementBound(preview, config.boundKey)) return;

    const hybrid = config.interaction === 'hybrid';
    const link = config.interaction === 'link';
    const ignoresTouchHover = hybrid || link;
    const trigger = hybrid ? preview.querySelector?.(config.triggerSelector) : null;
    if (hybrid && !trigger) return;

    markEnhancementBound(preview, config.boundKey);
    boundCount += 1;
    if (hybrid) {
      info.addEventListener?.('load', scheduleActiveGridInfoPosition, true);
      info.addEventListener?.('error', scheduleActiveGridInfoPosition, true);
    }
    // The card is a DOM descendant of a link-mode preview, so pointer
    // boundary events treat the card as part of the hover region.
    const pointerTarget = trigger || preview;
    const placementTarget = (config.placementSelector
      && preview.querySelector?.(config.placementSelector)) || preview;
    const state = {
      focusInside: false,
      pointerInside: false,
      pointer: null,
      suppressHover: false,
      returnFocus: link ? placementTarget : null,
      restoringFocus: false,
    };
    const pointerAnchor = (event) => (link ? { type: 'focus' } : {
      type: 'pointer',
      clientX: Number(event?.clientX),
      clientY: Number(event?.clientY),
    });
    const hoverPlacementTarget = link ? placementTarget : pointerTarget;
    const onPointerEnter = (event) => {
      if (ignoresTouchHover && event.pointerType === 'touch') return;
      if (hybrid && (state.suppressHover || activeGridInfoPlacement?.pinned)) return;
      state.pointerInside = true;
      state.pointer = pointerAnchor(event);
      if (link && activeGridInfoPlacement?.info === info) {
        cancelPendingGridInfoDismissal();
        return;
      }
      activateGridInfo(hoverPlacementTarget, info, config, state, state.pointer, trigger);
    };
    const onPointerMove = (event) => {
      if (ignoresTouchHover && event.pointerType === 'touch') return;
      if (hybrid && (state.suppressHover || activeGridInfoPlacement?.pinned)) return;
      if (!state.pointerInside) return;
      if (activeGridInfoPlacement?.info !== info) {
        state.pointer = pointerAnchor(event);
        activateGridInfo(hoverPlacementTarget, info, config, state, state.pointer, trigger);
        return;
      }
      if (link) return;
      state.pointer = pointerAnchor(event);
      activeGridInfoPlacement.anchor = state.pointer;
      scheduleActiveGridInfoPosition();
    };
    const onPointerLeave = () => {
      state.suppressHover = false;
      state.pointerInside = false;
      state.pointer = null;
      if (activeGridInfoPlacement?.info !== info) return;
      if (activeGridInfoPlacement.pinned) return;
      if (state.focusInside) activateGridInfo(placementTarget, info, config, state, { type: 'focus' });
      else if (link) scheduleGridInfoDismissal(info, LINK_INFO_DISMISS_DELAY_MS);
      else dismissActiveGridInfoCard();
    };
    pointerTarget.addEventListener?.('pointerenter', onPointerEnter);
    pointerTarget.addEventListener?.('pointermove', onPointerMove);
    pointerTarget.addEventListener?.('pointerleave', onPointerLeave);
    if (hybrid) {
      trigger.addEventListener?.('click', () => {
        if (activeGridInfoPlacement?.info === info) {
          if (activeGridInfoPlacement.pinned) {
            state.suppressHover = true;
            dismissActiveGridInfoCard();
          } else {
            activeGridInfoPlacement.pinned = true;
            activeGridInfoPlacement.anchor = { type: 'focus' };
            scheduleActiveGridInfoPosition();
          }
          return;
        }
        activateGridInfo(trigger, info, config, state, { type: 'focus' }, trigger, true);
      });
      return;
    }
    preview.addEventListener?.('focusin', () => {
      state.focusInside = true;
      if (state.restoringFocus) return;
      if (!state.pointerInside) activateGridInfo(placementTarget, info, config, state, { type: 'focus' });
    });
    preview.addEventListener?.('focusout', (event) => {
      if (preview.contains?.(event.relatedTarget)) return;
      state.focusInside = false;
      if (activeGridInfoPlacement?.info !== info) return;
      if (state.pointerInside && state.pointer) {
        activateGridInfo(hoverPlacementTarget, info, config, state, state.pointer);
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

export function enhanceCalendarInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, CALENDAR_INFO_CONFIG);
}

export function enhanceDashboardTitleInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, DASHBOARD_TITLE_INFO_CONFIG);
}
