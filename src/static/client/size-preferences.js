import {
  isEnhancementBound,
  liveRegionDocument,
  markEnhancementBound,
} from './dom.js';

const ASSET_GRID_SIZE_CONTROL_SELECTOR = '[data-asset-grid-size-controls]';
const ASSET_GRID_SELECTOR = '.asset-grid';
const ASSET_GRID_SIZE_STORAGE_KEY = 'creatorcrate-asset-grid-size';
const ASSET_LIST_SIZE_CONTROL_SELECTOR = '[data-asset-list-size-controls]';
const ASSET_LIST_SELECTOR = '.asset-list';
const ASSET_LIST_SIZE_STORAGE_KEY = 'creatorcrate-asset-list-size';
const PROJECT_GRID_SELECTOR = '.project-grid';
const PROJECT_GRID_SIZE_STORAGE_KEY = 'creatorcrate-project-grid-size';
const PROJECT_GRID_SIZE_CONTROL_SCOPE_SELECTOR = '[data-project-grid-size-controls]';
const PROJECT_GRID_SIZE_CONTROL_SELECTOR = `${PROJECT_GRID_SIZE_CONTROL_SCOPE_SELECTOR} ${ASSET_GRID_SIZE_CONTROL_SELECTOR}`;
const ASSET_GRID_SIZE_SLIDER_SELECTOR = '[data-grid-size-slider]';
const ASSET_GRID_SIZE_OPTION_LABEL_SELECTOR = '[data-grid-size-option-label]';
const PROJECT_ASSETS_LIVE_REGION_SELECTOR = '[data-project-assets-live-region]';

const ASSET_GRID_SIZES = Object.freeze({
  compact: '12rem',
  default: '15rem',
  large: '20rem',
});
const ASSET_GRID_SIZE_ORDER = Object.freeze(['compact', 'default', 'large']);
const ASSET_GRID_SIZE_LABELS = Object.freeze({
  compact: 'Compact',
  default: 'Default',
  large: 'Large',
});
const ASSET_LIST_SIZES = Object.freeze({
  compact: null,
  large: null,
});
const ASSET_LIST_SIZE_ORDER = Object.freeze(['compact', 'large']);
const ASSET_LIST_SIZE_LABELS = Object.freeze({
  compact: 'Compact',
  large: 'Large',
});

export const ASSET_GRID_SIZE_CONFIG = Object.freeze({
  controlSelector: ASSET_GRID_SIZE_CONTROL_SELECTOR,
  excludeControlScopeSelector: PROJECT_GRID_SIZE_CONTROL_SCOPE_SELECTOR,
  gridSelector: ASSET_GRID_SELECTOR,
  storageKey: ASSET_GRID_SIZE_STORAGE_KEY,
  sizes: ASSET_GRID_SIZES,
  order: ASSET_GRID_SIZE_ORDER,
  labels: ASSET_GRID_SIZE_LABELS,
  defaultSize: 'default',
  sizeAttribute: 'data-grid-size',
  cssVariable: '--asset-card-min',
  boundKey: 'assetGridSizeBound',
  interactiveLabelsSelector: '[data-grid-size-labels-interactive]',
});
export const ASSET_LIST_SIZE_CONFIG = Object.freeze({
  controlSelector: ASSET_LIST_SIZE_CONTROL_SELECTOR,
  gridSelector: ASSET_LIST_SELECTOR,
  storageKey: ASSET_LIST_SIZE_STORAGE_KEY,
  sizes: ASSET_LIST_SIZES,
  order: ASSET_LIST_SIZE_ORDER,
  labels: ASSET_LIST_SIZE_LABELS,
  defaultSize: 'large',
  sizeAttribute: 'data-list-size',
  removeDefaultAttribute: false,
  boundKey: 'assetListSizeBound',
  interactiveLabelsSelector: '[data-grid-size-labels-interactive]',
});
export const PROJECT_GRID_SIZE_CONFIG = Object.freeze({
  controlSelector: PROJECT_GRID_SIZE_CONTROL_SELECTOR,
  gridSelector: PROJECT_GRID_SELECTOR,
  storageKey: PROJECT_GRID_SIZE_STORAGE_KEY,
  sizes: ASSET_GRID_SIZES,
  order: ASSET_GRID_SIZE_ORDER,
  labels: ASSET_GRID_SIZE_LABELS,
  defaultSize: 'default',
  sizeAttribute: 'data-grid-size',
  cssVariable: '--project-card-min',
  boundKey: 'projectGridSizeBound',
  interactiveLabelsSelector: '[data-grid-size-labels-interactive]',
});

export function gridSizeIsValid(size, config) {
  return typeof size === 'string'
    && Object.prototype.hasOwnProperty.call(config.sizes, size);
}

export function readGridSize(storageKey, config, fallbackSize = config.defaultSize) {
  const fallback = gridSizeIsValid(fallbackSize, config) ? fallbackSize : config.defaultSize;
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    return gridSizeIsValid(stored, config) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function writeGridSize(size, storageKey) {
  try {
    globalThis.localStorage?.setItem(storageKey, size);
  } catch {
    // Storage can be unavailable or blocked; the current page still works.
  }
}

function assetGridSizeFromPosition(value, config) {
  const position = Number(value);
  if (!Number.isInteger(position) || position < 1 || position > config.order.length) return null;
  return config.order[position - 1];
}

function assetGridSizePosition(size, config) {
  const position = config.order.indexOf(size);
  return position < 0 ? null : position + 1;
}

function updateGridSizeControls(controls, size, config) {
  const label = config.labels[size];
  const position = assetGridSizePosition(size, config);

  controls.forEach((group) => {
    group.querySelectorAll(ASSET_GRID_SIZE_SLIDER_SELECTOR).forEach((slider) => {
      slider.value = String(position);
      slider.setAttribute?.('aria-valuenow', String(position));
      slider.setAttribute?.('aria-valuetext', label);
    });

    group.querySelectorAll(ASSET_GRID_SIZE_OPTION_LABEL_SELECTOR).forEach((optionLabel) => {
      const isActive = optionLabel.dataset.gridSizeOptionLabel === size;
      optionLabel.classList?.toggle?.('is-active', isActive);
      if (optionLabel.matches?.('button') || optionLabel.tagName === 'BUTTON') {
        optionLabel.setAttribute?.('aria-pressed', String(isActive));
      }
    });
  });
}

function gridSizeLabelsAreInteractive(group, config) {
  const selector = config.interactiveLabelsSelector;
  const attribute = selector?.slice(1, -1);
  return Boolean(
    selector
      && (group.matches?.(selector)
        || group.hasAttribute?.(attribute)
        || (typeof group.getAttribute === 'function' && group.getAttribute(attribute) !== null)),
  );
}

export function applyGridSize(scope, size, config, controls) {
  const grids = scope.querySelectorAll(config.gridSelector);
  grids.forEach((grid) => {
    const clearDefaultAttribute = size === config.defaultSize && config.removeDefaultAttribute !== false;
    if (clearDefaultAttribute) {
      grid.removeAttribute(config.sizeAttribute);
    } else {
      grid.setAttribute(config.sizeAttribute, size);
    }
    if (config.cssVariable) {
      if (clearDefaultAttribute) {
        grid.style?.removeProperty(config.cssVariable);
      } else {
        grid.style?.setProperty(config.cssVariable, config.sizes[size]);
      }
    }
  });
  updateGridSizeControls(controls, size, config);
}

function getGridSizeControls(scope, config) {
  return Array.from(scope.querySelectorAll(config.controlSelector))
    .filter((control) => !config.excludeControlScopeSelector
      || !control.closest?.(config.excludeControlScopeSelector));
}

function projectAssetsSizeFallback(scope, attribute, config) {
  const document = liveRegionDocument(scope);
  const region = scope?.matches?.(PROJECT_ASSETS_LIVE_REGION_SELECTOR)
    ? scope
    : document?.querySelector?.(PROJECT_ASSETS_LIVE_REGION_SELECTOR);
  const fallbackSize = region?.getAttribute?.(attribute);
  return gridSizeIsValid(fallbackSize, config) ? fallbackSize : config.defaultSize;
}

export function enhanceGridSize(scope, config, fallbackSize = config.defaultSize) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const controls = getGridSizeControls(scope, config);
  const grids = scope.querySelectorAll(config.gridSelector);
  if (controls.length === 0 || grids.length === 0) return 0;

  applyGridSize(scope, readGridSize(config.storageKey, config, fallbackSize), config, controls);
  controls.forEach((group) => {
    const applySelectedSize = (size) => {
      if (!Object.prototype.hasOwnProperty.call(config.sizes, size)) return;
      writeGridSize(size, config.storageKey);
      applyGridSize(scope, size, config, controls);
    };

    group.querySelectorAll(ASSET_GRID_SIZE_SLIDER_SELECTOR).forEach((slider) => {
      if (isEnhancementBound(slider, config.boundKey)) return;
      markEnhancementBound(slider, config.boundKey);
      const applySliderSize = () => {
        applySelectedSize(assetGridSizeFromPosition(slider.value, config));
      };
      slider.addEventListener('input', applySliderSize);
      slider.addEventListener('change', applySliderSize);
    });

    if (gridSizeLabelsAreInteractive(group, config)) {
      group.querySelectorAll(ASSET_GRID_SIZE_OPTION_LABEL_SELECTOR).forEach((optionLabel) => {
        if (isEnhancementBound(optionLabel, config.boundKey)) return;
        markEnhancementBound(optionLabel, config.boundKey);
        optionLabel.addEventListener('click', () => {
          applySelectedSize(optionLabel.dataset.gridSizeOptionLabel);
        });
      });
    }
  });
  return controls.length;
}

export function enhanceAssetGridSize(scope = globalThis.document, fallbackSize) {
  const fallback = fallbackSize === undefined
    ? projectAssetsSizeFallback(scope, 'data-project-assets-grid-size-default', ASSET_GRID_SIZE_CONFIG)
    : fallbackSize;
  return enhanceGridSize(scope, ASSET_GRID_SIZE_CONFIG, fallback);
}

export function enhanceAssetListSize(scope = globalThis.document, fallbackSize) {
  const fallback = fallbackSize === undefined
    ? projectAssetsSizeFallback(scope, 'data-project-assets-list-size-default', ASSET_LIST_SIZE_CONFIG)
    : fallbackSize;
  return enhanceGridSize(scope, ASSET_LIST_SIZE_CONFIG, fallback);
}

export function enhanceProjectGridSize(scope = globalThis.document) {
  return enhanceGridSize(scope, PROJECT_GRID_SIZE_CONFIG);
}
