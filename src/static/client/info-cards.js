import { isEnhancementBound, markEnhancementBound } from './dom.js';

const ASSET_VIEWER_INFO_SELECTOR = '[data-asset-info-card]';
const ASSET_VIEWER_PREVIEW_SELECTOR = '[data-asset-viewer-preview]';
const ASSET_VIEWER_INFO_GUTTER = 8;
const PROJECT_INFO_SELECTOR = '[data-project-info-card]';
const PROJECT_PREVIEW_SELECTOR = '[data-project-grid-preview]';

const ASSET_VIEWER_INFO_CONFIG = Object.freeze({
  infoSelector: ASSET_VIEWER_INFO_SELECTOR,
  previewSelector: ASSET_VIEWER_PREVIEW_SELECTOR,
  gutter: ASSET_VIEWER_INFO_GUTTER,
  leftProperty: '--asset-info-left',
  topProperty: '--asset-info-top',
  boundKey: 'assetViewerInfoBound',
});
const PROJECT_INFO_CONFIG = Object.freeze({
  infoSelector: PROJECT_INFO_SELECTOR,
  previewSelector: PROJECT_PREVIEW_SELECTOR,
  gutter: ASSET_VIEWER_INFO_GUTTER,
  leftProperty: '--project-info-left',
  topProperty: '--project-info-top',
  boundKey: 'projectInfoBound',
});

let activeGridInfoPlacement = null;
let gridInfoViewportListenersBound = false;

function positionGridInfo(preview, info, config) {
  if (!preview || !info || typeof preview.getBoundingClientRect !== 'function') return;

  const viewportWidth = Number(globalThis.document?.documentElement?.clientWidth)
    || Number(globalThis.innerWidth);
  const viewportHeight = Number(globalThis.document?.documentElement?.clientHeight)
    || Number(globalThis.innerHeight);
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return;

  const previewRect = preview.getBoundingClientRect();
  const infoRect = typeof info.getBoundingClientRect === 'function'
    ? info.getBoundingClientRect()
    : { width: 0, height: 0 };
  const infoWidth = Math.min(
    Math.max(Number(info.offsetWidth) || Number(infoRect.width) || 0, 0),
    viewportWidth - (config.gutter * 2),
  );
  const infoHeight = Math.max(Number(info.offsetHeight) || Number(infoRect.height) || 0, 0);
  if (!(infoWidth > 0) || !(infoHeight > 0)) return;

  const unclampedLeft = previewRect.left + ((previewRect.width - infoWidth) / 2);
  const left = Math.max(
    config.gutter,
    Math.min(unclampedLeft, viewportWidth - config.gutter - infoWidth),
  );

  const belowTop = previewRect.bottom + config.gutter;
  const aboveTop = previewRect.top - config.gutter - infoHeight;
  let top = belowTop;
  if (belowTop + infoHeight > viewportHeight - config.gutter && aboveTop >= config.gutter) {
    top = aboveTop;
  } else if (belowTop + infoHeight > viewportHeight - config.gutter) {
    top = Math.max(config.gutter, viewportHeight - config.gutter - infoHeight);
  }

  info.style?.setProperty?.(config.leftProperty, `${left - previewRect.left}px`);
  info.style?.setProperty?.(config.topProperty, `${top - previewRect.top}px`);
  info.setAttribute?.('data-positioned', 'true');
}

function repositionActiveGridInfo() {
  if (!activeGridInfoPlacement) return;
  positionGridInfo(
    activeGridInfoPlacement.preview,
    activeGridInfoPlacement.info,
    activeGridInfoPlacement.config,
  );
}

function bindGridInfoViewportListeners() {
  if (gridInfoViewportListenersBound || typeof globalThis.addEventListener !== 'function') return;
  gridInfoViewportListenersBound = true;
  globalThis.addEventListener('resize', repositionActiveGridInfo);
  globalThis.addEventListener('scroll', repositionActiveGridInfo, true);
}

function enhanceGridInfoCards(scope, config) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const previews = scope.querySelectorAll(config.previewSelector);
  let boundCount = 0;
  previews.forEach((preview) => {
    const info = preview.querySelector?.(config.infoSelector);
    if (!info || isEnhancementBound(preview, config.boundKey)) return;

    markEnhancementBound(preview, config.boundKey);
    boundCount += 1;
    const activate = () => {
      activeGridInfoPlacement = { preview, info, config };
      positionGridInfo(preview, info, config);
    };
    const deactivate = () => {
      if (activeGridInfoPlacement?.preview === preview) {
        activeGridInfoPlacement = null;
      }
    };

    preview.addEventListener?.('pointerenter', activate);
    preview.addEventListener?.('focusin', activate);
    preview.addEventListener?.('pointerleave', deactivate);
    preview.addEventListener?.('focusout', (event) => {
      if (!preview.contains?.(event.relatedTarget)) deactivate();
    });
  });

  if (boundCount > 0) bindGridInfoViewportListeners();
  return boundCount;
}

export function enhanceAssetViewerInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, ASSET_VIEWER_INFO_CONFIG);
}

export function enhanceProjectInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, PROJECT_INFO_CONFIG);
}
