import sharp from 'sharp';
import { validateArchiveNamePart } from './watermark-archive.js';

export const WATERMARK_OUTPUT_MODES = Object.freeze(['patreon', 'social', 'custom']);
export const WATERMARK_POSITIONS = Object.freeze(['br', 'bl', 'tr', 'tl', 'c']);
export const WATERMARK_OUTPUT_FORMATS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
export const WATERMARK_DEFAULT_MARGIN_RATIO = 0.02;
export const WATERMARK_DEFAULT_OPACITY = 0.65;
export const WATERMARK_DEFAULT_QUALITY = 90;
export const WATERMARK_DEFAULT_SCALE = 0.25;
export const WATERMARK_DEFAULT_WINDOW_ASPECT = 1.777778;
export const WATERMARK_DEFAULT_SUFFIX = '_wm';
export const WATERMARK_SOCIAL_MAX_DIMENSION = 1100;
export const WATERMARK_SOCIAL_SUFFIX = '_lq_wm';

// This is the trusted built-in equivalent of the supplied scale_map.json.
// It remains the legacy Patreon/Social compatibility default until presets
// reference managed resources; new managed/custom calls resolve scaleMapId.
// Resolution keys are intentionally exact and orientation-specific.
export const WATERMARK_RESOLUTION_SCALE_MAP = Object.freeze({
  '1365x768': 0.35,
  '1248x832': 0.35,
  '2496x1664': 0.35,
  '5376x3072': 0.35,
  '4992x3328': 0.35,
  '1024x1024': 0.37,
  '2048x2048': 0.37,
  '2304x2304': 0.37,
  '3072x3072': 0.37,
  '4096x4096': 0.37,
  '1600x2592': 0.31,
  '2560x6144': 0.28,
  '832x1248': 0.32,
  '1365x2048': 0.32,
  '1664x2496': 0.32,
  '3328x4992': 0.32,
  default: 0.10,
});

export const WATERMARK_WINDOW_SCALE_MAP = WATERMARK_RESOLUTION_SCALE_MAP;

const WATERMARK_SUFFIXES = Object.freeze([
  WATERMARK_DEFAULT_SUFFIX,
  WATERMARK_SOCIAL_SUFFIX,
]);

export class WatermarkEngineError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'WatermarkEngineError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveFinite(value) {
  return isFiniteNumber(value) && value > 0;
}

function normalizeFormat(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function normalizePosition(value) {
  const aliases = {
    'bottom-left': 'bl',
    bottom_left: 'bl',
    southwest: 'bl',
    'bottom-right': 'br',
    bottom_right: 'br',
    southeast: 'br',
    'top-left': 'tl',
    top_left: 'tl',
    northwest: 'tl',
    'top-right': 'tr',
    top_right: 'tr',
    northeast: 'tr',
    center: 'c',
  };
  return aliases[value] || value;
}

function normalizeOpacity(value) {
  if (!isFiniteNumber(value)) return null;
  if (value >= 0 && value <= 1) return value;
  if (value >= 0 && value <= 100) return value / 100;
  return null;
}

function positiveSafeIntegerOrZero(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function finiteInteger(value) {
  return Number.isSafeInteger(value);
}

function normalizedMarginValue(margin) {
  if (isFiniteNumber(margin)) return margin;
  if (margin && isFiniteNumber(margin.x) && isFiniteNumber(margin.y) && margin.x === margin.y) {
    return margin.x;
  }
  return null;
}

export function validateScaleMap(scaleMap) {
  if (!scaleMap || typeof scaleMap !== 'object' || Array.isArray(scaleMap)) {
    throw new WatermarkEngineError('The watermark window scale map is invalid.', {
      code: 'INVALID_SCALE_MAP',
    });
  }

  for (const [resolution, scale] of Object.entries(scaleMap)) {
    const validResolution = resolution === 'default'
      || /^[1-9]\d*x[1-9]\d*$/.test(resolution);
    if (!validResolution || !positiveFinite(scale)) {
      throw new WatermarkEngineError('The watermark window scale map is invalid.', {
        code: 'INVALID_SCALE_MAP',
      });
    }
  }
  return scaleMap;
}

export function resolveWatermarkScale(
  width,
  height,
  scaleMap = WATERMARK_WINDOW_SCALE_MAP,
  manualScale = WATERMARK_DEFAULT_SCALE,
) {
  if (!positiveFinite(width) || !positiveFinite(height)) {
    throw new WatermarkEngineError('The image window dimension is invalid.', {
      code: 'INVALID_IMAGE_DIMENSIONS',
    });
  }

  if (!positiveFinite(manualScale)) {
    throw new WatermarkEngineError('Watermark scale must be greater than 0.', {
      code: 'INVALID_SCALE',
    });
  }
  const map = scaleMap === null ? null : validateScaleMap(scaleMap);
  const resolution = `${width}x${height}`;
  return map && Object.prototype.hasOwnProperty.call(map, resolution)
    ? map[resolution]
    : map?.default ?? manualScale;
}

export function calculateWindowBasis(
  width,
  height,
  windowAspect = WATERMARK_DEFAULT_WINDOW_ASPECT,
) {
  if (!positiveFinite(width) || !positiveFinite(height) || !positiveFinite(windowAspect)) {
    throw new WatermarkEngineError('Watermark dimensions are invalid.', {
      code: 'INVALID_IMAGE_DIMENSIONS',
    });
  }
  return Math.max(width / windowAspect, height);
}

export function calculateWatermarkBasis({
  width,
  height,
  scaleBasis = 'window',
  windowAspect = WATERMARK_DEFAULT_WINDOW_ASPECT,
}) {
  if (!positiveFinite(width) || !positiveFinite(height)) {
    throw new WatermarkEngineError('Watermark dimensions are invalid.', {
      code: 'INVALID_IMAGE_DIMENSIONS',
    });
  }
  const bases = {
    width,
    height,
    short: Math.min(width, height),
    long: Math.max(width, height),
    geo: Math.sqrt(width * height),
    diagonal: Math.sqrt((width ** 2) + (height ** 2)),
    window: calculateWindowBasis(width, height, windowAspect),
  };
  if (!Object.prototype.hasOwnProperty.call(bases, scaleBasis)) {
    throw new WatermarkEngineError('The watermark scale basis is unsupported.', {
      code: 'INVALID_SCALE_BASIS',
    });
  }
  return bases[scaleBasis];
}

export function calculateProportionalMargins(
  width,
  height,
  marginRatio,
  windowAspect = WATERMARK_DEFAULT_WINDOW_ASPECT,
  scaleBasis = 'window',
) {
  if (!positiveFinite(width) || !positiveFinite(height) || !isFiniteNumber(marginRatio)) {
    throw new WatermarkEngineError('Watermark margin dimensions are invalid.', {
      code: 'INVALID_MARGIN',
    });
  }
  const effectiveMargin = Math.trunc(calculateWatermarkBasis({
    width,
    height,
    scaleBasis,
    windowAspect,
  }) * marginRatio);
  return {
    x: effectiveMargin,
    y: effectiveMargin,
  };
}

export function calculateWatermarkDimensions({
  targetWidth,
  targetHeight,
  visibleWidth,
  visibleHeight,
  scale,
  scaleBasis = 'window',
  windowAspect = WATERMARK_DEFAULT_WINDOW_ASPECT,
  fixedWatermarkWidthPx = 0,
}) {
  if (!positiveFinite(targetWidth)
    || !positiveFinite(targetHeight)
    || !positiveFinite(visibleWidth)
    || !positiveFinite(visibleHeight)
    || !positiveFinite(scale)
    || !positiveSafeIntegerOrZero(fixedWatermarkWidthPx)) {
    throw new WatermarkEngineError('Watermark dimensions are invalid.', {
      code: 'INVALID_IMAGE_DIMENSIONS',
    });
  }
  const scaleBasisPixels = calculateWatermarkBasis({
    width: targetWidth,
    height: targetHeight,
    scaleBasis,
    windowAspect,
  });
  const width = fixedWatermarkWidthPx > 0
    ? fixedWatermarkWidthPx
    : Math.max(1, Math.trunc(scaleBasisPixels * scale));
  const height = Math.max(1, Math.trunc((visibleHeight * width) / visibleWidth));
  return { width, height, windowDimension: scaleBasisPixels };
}

export function fitWatermarkDimensions({
  targetWidth,
  targetHeight,
  watermarkWidth,
  watermarkHeight,
  margin,
}) {
  if (!positiveFinite(targetWidth)
    || !positiveFinite(targetHeight)
    || !positiveFinite(watermarkWidth)
    || !positiveFinite(watermarkHeight)
    || !margin
    || !Number.isFinite(margin.x)
    || !Number.isFinite(margin.y)
    || margin.x < 0
    || margin.y < 0) {
    throw new WatermarkEngineError('Watermark image dimensions are invalid.', {
      code: 'INVALID_WATERMARK_DIMENSIONS',
    });
  }

  const maximumMarginX = Math.floor((targetWidth - 1) / 2);
  const maximumMarginY = Math.floor((targetHeight - 1) / 2);
  if (maximumMarginX < 0 || maximumMarginY < 0) {
    throw new WatermarkEngineError('Watermark image dimensions are invalid.', {
      code: 'INVALID_WATERMARK_DIMENSIONS',
    });
  }

  const effectiveMargin = {
    x: Math.min(Math.floor(margin.x), maximumMarginX),
    y: Math.min(Math.floor(margin.y), maximumMarginY),
  };
  const availableWidth = targetWidth - (2 * effectiveMargin.x);
  const availableHeight = targetHeight - (2 * effectiveMargin.y);
  if (!positiveFinite(availableWidth) || !positiveFinite(availableHeight)) {
    throw new WatermarkEngineError('Watermark image dimensions are invalid.', {
      code: 'INVALID_WATERMARK_DIMENSIONS',
    });
  }

  const fitScale = Math.min(
    1,
    availableWidth / watermarkWidth,
    availableHeight / watermarkHeight,
  );
  const width = Math.max(1, Math.floor(watermarkWidth * fitScale));
  const height = Math.max(1, Math.floor(watermarkHeight * fitScale));
  if (width > availableWidth || height > availableHeight) {
    throw new WatermarkEngineError('Watermark image dimensions are invalid.', {
      code: 'INVALID_WATERMARK_DIMENSIONS',
    });
  }

  return { width, height, margin: effectiveMargin };
}

export function calculateWatermarkPosition({
  position,
  targetWidth,
  targetHeight,
  watermarkWidth,
  watermarkHeight,
  margin,
}) {
  const normalizedPosition = normalizePosition(position);
  const marginValue = normalizedMarginValue(margin);
  if (!WATERMARK_POSITIONS.includes(normalizedPosition)
    || !positiveFinite(targetWidth)
    || !positiveFinite(targetHeight)
    || !positiveFinite(watermarkWidth)
    || !positiveFinite(watermarkHeight)
    || !isFiniteNumber(marginValue)) {
    throw new WatermarkEngineError('Watermark placement is invalid.', {
      code: 'INVALID_POSITION',
    });
  }

  const effectiveMargin = Math.trunc(marginValue);
  const placements = {
    br: { left: targetWidth - watermarkWidth - effectiveMargin, top: targetHeight - watermarkHeight - effectiveMargin },
    bl: { left: effectiveMargin, top: targetHeight - watermarkHeight - effectiveMargin },
    tr: { left: targetWidth - watermarkWidth - effectiveMargin, top: effectiveMargin },
    tl: { left: effectiveMargin, top: effectiveMargin },
    c: {
      left: Math.floor((targetWidth - watermarkWidth) / 2),
      top: Math.floor((targetHeight - watermarkHeight) / 2),
    },
  };
  return placements[normalizedPosition];
}

export function clampWatermarkCoordinates({
  targetWidth,
  targetHeight,
  watermarkWidth,
  watermarkHeight,
  left,
  top,
}) {
  if (![targetWidth, targetHeight, watermarkWidth, watermarkHeight, left, top].every(isFiniteNumber)) {
    throw new WatermarkEngineError('Watermark placement is invalid.', { code: 'INVALID_POSITION' });
  }
  return {
    left: Math.max(0, Math.min(left, targetWidth - watermarkWidth)),
    top: Math.max(0, Math.min(top, targetHeight - watermarkHeight)),
  };
}

export function calculateVisibleWatermarkOverlay({
  targetWidth,
  targetHeight,
  watermarkWidth,
  watermarkHeight,
  left,
  top,
}) {
  const visibleLeft = Math.max(0, left);
  const visibleTop = Math.max(0, top);
  const visibleRight = Math.min(targetWidth, left + watermarkWidth);
  const visibleBottom = Math.min(targetHeight, top + watermarkHeight);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;
  return {
    left: visibleLeft,
    top: visibleTop,
    width: visibleRight - visibleLeft,
    height: visibleBottom - visibleTop,
    cropLeft: visibleLeft - left,
    cropTop: visibleTop - top,
  };
}

export function deriveWatermarkGeometry({
  sourceWidth,
  sourceHeight,
  compositeWidth,
  compositeHeight,
  watermarkWidth,
  watermarkHeight,
  options,
}) {
  if (!options || !positiveFinite(sourceWidth) || !positiveFinite(sourceHeight)
    || !positiveFinite(compositeWidth) || !positiveFinite(compositeHeight)
    || !positiveFinite(watermarkWidth) || !positiveFinite(watermarkHeight)) {
    throw new WatermarkEngineError('Watermark geometry is invalid.', { code: 'INVALID_IMAGE_DIMENSIONS' });
  }
  const effectiveScale = resolveWatermarkScale(
    sourceWidth,
    sourceHeight,
    options.scaleMap,
    options.scale,
  );
  const scaleBasisPixels = calculateWatermarkBasis({
    width: compositeWidth,
    height: compositeHeight,
    scaleBasis: options.scaleBasis,
    windowAspect: options.windowAspect,
  });
  const sized = calculateWatermarkDimensions({
    targetWidth: compositeWidth,
    targetHeight: compositeHeight,
    visibleWidth: watermarkWidth,
    visibleHeight: watermarkHeight,
    scale: effectiveScale,
    scaleBasis: options.scaleBasis,
    windowAspect: options.windowAspect,
    fixedWatermarkWidthPx: options.fixedWatermarkWidthPx,
  });
  const margin = options.marginRatio !== 0
    ? Math.trunc(scaleBasisPixels * options.marginRatio)
    : options.marginPx;
  const fitted = options.containment === 'shrink'
    ? fitWatermarkDimensions({
      targetWidth: compositeWidth,
      targetHeight: compositeHeight,
      watermarkWidth: sized.width,
      watermarkHeight: sized.height,
      margin: { x: Math.max(0, margin), y: Math.max(0, margin) },
    })
    : { width: sized.width, height: sized.height };
  const initial = calculateWatermarkPosition({
    position: options.position,
    targetWidth: compositeWidth,
    targetHeight: compositeHeight,
    watermarkWidth: fitted.width,
    watermarkHeight: fitted.height,
    margin,
  });
  const nudge = {
    x: options.nudgeXRatio !== 0 ? Math.trunc(compositeWidth * options.nudgeXRatio) : options.nudgeX,
    y: options.nudgeYRatio !== 0 ? Math.trunc(compositeHeight * options.nudgeYRatio) : options.nudgeY,
  };
  const requestedCoordinates = { left: initial.left + nudge.x, top: initial.top + nudge.y };
  const effectiveCoordinates = options.allowOffCanvas
    ? requestedCoordinates
    : clampWatermarkCoordinates({
      targetWidth: compositeWidth,
      targetHeight: compositeHeight,
      watermarkWidth: fitted.width,
      watermarkHeight: fitted.height,
      ...requestedCoordinates,
    });
  return {
    sourceDimensions: { width: sourceWidth, height: sourceHeight },
    compositeDimensions: { width: compositeWidth, height: compositeHeight },
    effectiveScale,
    scaleBasis: options.scaleBasis,
    scaleBasisPixels,
    watermarkDimensions: { width: fitted.width, height: fitted.height },
    margin,
    position: normalizePosition(options.position),
    nudge,
    requestedCoordinates,
    effectiveCoordinates,
    visibleOverlay: calculateVisibleWatermarkOverlay({
      targetWidth: compositeWidth,
      targetHeight: compositeHeight,
      watermarkWidth: fitted.width,
      watermarkHeight: fitted.height,
      ...effectiveCoordinates,
    }),
  };
}

export function normalizeWatermarkOptions(rawOptions = {}, {
  scaleMap = WATERMARK_WINDOW_SCALE_MAP,
} = {}) {
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw new WatermarkEngineError('Watermark options are required.', { code: 'INVALID_OPTIONS' });
  }
  if (Object.prototype.hasOwnProperty.call(rawOptions, 'watermarkPath')
    || Object.prototype.hasOwnProperty.call(rawOptions, 'watermarkFile')) {
    throw new WatermarkEngineError('The watermark file must come from trusted server configuration.', {
      code: 'WATERMARK_PATH_NOT_ALLOWED',
    });
  }
  if (Object.prototype.hasOwnProperty.call(rawOptions, 'scaleMapPath')
    || Object.prototype.hasOwnProperty.call(rawOptions, 'scaleMapFile')) {
    throw new WatermarkEngineError('Watermark scale maps must come from trusted server configuration.', {
      code: 'SCALE_MAP_PATH_NOT_ALLOWED',
    });
  }

  const mode = rawOptions.mode ?? rawOptions.workflow ?? 'custom';
  if (!WATERMARK_OUTPUT_MODES.includes(mode)) {
    throw new WatermarkEngineError(
      `Watermark mode must be one of: ${WATERMARK_OUTPUT_MODES.join(', ')}.`,
      { code: 'INVALID_MODE' },
    );
  }

  const position = normalizePosition(rawOptions.position ?? 'bl');
  if (!WATERMARK_POSITIONS.includes(position)) {
    throw new WatermarkEngineError('The watermark position is unsupported.', {
      code: 'INVALID_POSITION',
    });
  }

  const marginRatio = rawOptions.marginRatio
    ?? rawOptions.margin
    ?? (rawOptions.marginPercent === undefined ? WATERMARK_DEFAULT_MARGIN_RATIO : rawOptions.marginPercent / 100);
  const marginPx = rawOptions.marginPx ?? 0;
  if (!isFiniteNumber(marginRatio) || !finiteInteger(marginPx)) {
    throw new WatermarkEngineError('Watermark margin is invalid.', {
      code: 'INVALID_MARGIN',
    });
  }

  const opacity = normalizeOpacity(rawOptions.opacity ?? (mode === 'custom' ? WATERMARK_DEFAULT_OPACITY : 1));
  if (opacity === null) {
    throw new WatermarkEngineError('Watermark opacity must be from 0 to 1 or 0 to 100.', {
      code: 'INVALID_OPACITY',
    });
  }

  const requestedFormat = rawOptions.outputFormat ?? rawOptions.format ?? 'png';
  const outputFormat = normalizeFormat(requestedFormat);
  if (outputFormat !== 'same' && !WATERMARK_OUTPUT_FORMATS.includes(outputFormat)) {
    throw new WatermarkEngineError(
      `Watermark output format must be one of: ${WATERMARK_OUTPUT_FORMATS.join(', ')}, same.`,
      { code: 'INVALID_FORMAT' },
    );
  }

  const quality = rawOptions.quality ?? WATERMARK_DEFAULT_QUALITY;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new WatermarkEngineError('Watermark quality must be an integer from 1 to 100.', {
      code: 'INVALID_QUALITY',
    });
  }

  const requestedMaxDimension = rawOptions.maxDimension === undefined
    ? (mode === 'social' ? WATERMARK_SOCIAL_MAX_DIMENSION : 0)
    : rawOptions.maxDimension;
  if (requestedMaxDimension !== null
    && (!Number.isSafeInteger(requestedMaxDimension) || requestedMaxDimension < 0)) {
    throw new WatermarkEngineError('Watermark maxDimension must be a non-negative integer.', {
      code: 'INVALID_MAX_DIMENSION',
    });
  }
  const maxDimension = requestedMaxDimension || null;

  const deleteSource = rawOptions.deleteSource
    ?? rawOptions.deleteOriginal
    ?? (mode === 'social');
  if (typeof deleteSource !== 'boolean') {
    throw new WatermarkEngineError('deleteSource must be a boolean.', {
      code: 'INVALID_SOURCE_HANDLING',
    });
  }

  const scale = rawOptions.scale ?? rawOptions.watermarkScale ?? WATERMARK_DEFAULT_SCALE;
  if (!positiveFinite(scale)) {
    throw new WatermarkEngineError('Watermark scale must be greater than 0.', {
      code: 'INVALID_SCALE',
    });
  }

  const scaleBasis = rawOptions.scaleBasis ?? 'window';
  if (!['width', 'height', 'short', 'long', 'geo', 'diagonal', 'window'].includes(scaleBasis)) {
    throw new WatermarkEngineError('The watermark scale basis is unsupported.', {
      code: 'INVALID_SCALE_BASIS',
    });
  }

  const windowAspect = rawOptions.windowAspect ?? WATERMARK_DEFAULT_WINDOW_ASPECT;
  if (!positiveFinite(windowAspect)) {
    throw new WatermarkEngineError('Watermark windowAspect must be greater than 0.', {
      code: 'INVALID_WINDOW_ASPECT',
    });
  }

  const fixedWatermarkWidthPx = rawOptions.fixedWatermarkWidthPx
    ?? rawOptions.fixedWmPx
    ?? 0;
  if (!positiveSafeIntegerOrZero(fixedWatermarkWidthPx)) {
    throw new WatermarkEngineError('Watermark fixed width must be a non-negative integer.', {
      code: 'INVALID_FIXED_WATERMARK_WIDTH',
    });
  }

  const nudgeX = rawOptions.nudgeX ?? 0;
  const nudgeY = rawOptions.nudgeY ?? 0;
  const nudgeXRatio = rawOptions.nudgeXRatio
    ?? (rawOptions.nudgeXPercent === undefined ? 0 : rawOptions.nudgeXPercent / 100);
  const nudgeYRatio = rawOptions.nudgeYRatio
    ?? (rawOptions.nudgeYPercent === undefined ? 0 : rawOptions.nudgeYPercent / 100);
  if (!finiteInteger(nudgeX) || !finiteInteger(nudgeY)
    || !isFiniteNumber(nudgeXRatio) || !isFiniteNumber(nudgeYRatio)) {
    throw new WatermarkEngineError('Watermark nudge is invalid.', { code: 'INVALID_NUDGE' });
  }

  const allowOffCanvas = rawOptions.allowOffCanvas ?? false;
  if (typeof allowOffCanvas !== 'boolean') {
    throw new WatermarkEngineError('allowOffCanvas must be a boolean.', { code: 'INVALID_ALLOW_OFF_CANVAS' });
  }
  const containment = rawOptions.containment ?? 'clamp';
  if (!['clamp', 'shrink'].includes(containment)) {
    throw new WatermarkEngineError('Watermark containment is unsupported.', {
      code: 'INVALID_CONTAINMENT',
    });
  }

  const overwrite = rawOptions.overwrite ?? true;
  if (typeof overwrite !== 'boolean') {
    throw new WatermarkEngineError('overwrite must be a boolean.', {
      code: 'INVALID_OVERWRITE',
    });
  }

  const alsoUnresized = rawOptions.alsoUnresized ?? false;
  if (typeof alsoUnresized !== 'boolean') throw new WatermarkEngineError('alsoUnresized must be a boolean.', { code: 'INVALID_VARIANTS' });
  const dualVariants = alsoUnresized && maxDimension !== null;
  const defaultSuffix = maxDimension === null ? WATERMARK_DEFAULT_SUFFIX : WATERMARK_SOCIAL_SUFFIX;
  const suffix = rawOptions.suffix ?? rawOptions.socialSuffix ?? defaultSuffix;
  const suffixUnresized = rawOptions.suffixUnresized ?? WATERMARK_DEFAULT_SUFFIX;
  const suffixResized = rawOptions.suffixResized ?? WATERMARK_SOCIAL_SUFFIX;
  for (const value of dualVariants ? [suffixUnresized, suffixResized] : [suffix]) {
    if (typeof value !== 'string' || /[\\/\u0000-\u001f\u007f]/.test(value)) throw new WatermarkEngineError('The watermark suffix is unsafe.', { code: 'INVALID_SUFFIX' });
  }
  const outputDirectory = normalizeOutputDirectory(rawOptions.outputDirectory ?? '');
  const trimWatermark = rawOptions.trimWatermark ?? true;
  const watermarkBeforeResize = rawOptions.watermarkBeforeResize ?? false;
  const webpLossless = rawOptions.webpLossless ?? false;
  if (![trimWatermark, watermarkBeforeResize, webpLossless].every((value) => typeof value === 'boolean')) throw new WatermarkEngineError('Watermark boolean options are invalid.', { code: 'INVALID_OPTIONS' });
  const additionalFormats = normalizeAdditionalFormats(rawOptions.additionalFormats ?? []);
  const additionalFormatsResized = normalizeAdditionalFormats(rawOptions.additionalFormatsResized ?? []);
  const jpegBackground = normalizeJpegBackground(rawOptions.jpegBackground ?? 'white');
  const makeArchives = rawOptions.makeArchives ?? false;
  const makeCbz = rawOptions.makeCbz ?? false;
  const archiveIncludeResized = rawOptions.archiveIncludeResized ?? false;
  const replaceExistingArchives = rawOptions.replaceExistingArchives ?? false;
  if (![makeArchives, makeCbz, archiveIncludeResized, replaceExistingArchives].every((value) => typeof value === 'boolean')) {
    throw new WatermarkEngineError('Watermark archive options must be boolean values.', { code: 'INVALID_ARCHIVE_OPTIONS' });
  }
  const archiveFormat = rawOptions.archiveFormat ?? 'zip';
  if (!['zip', '7z'].includes(archiveFormat)) {
    throw new WatermarkEngineError('archiveFormat must be zip or 7z.', { code: 'INVALID_ARCHIVE_FORMAT' });
  }
  const archiveQuality = (name, defaultValue) => {
    const value = rawOptions[name] ?? defaultValue;
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new WatermarkEngineError(`${name} must be an integer from 1 to 100.`, { code: 'INVALID_ARCHIVE_QUALITY' });
    }
    return value;
  };
  const setName = validateArchiveNamePart(rawOptions.setName ?? '', 'setName');
  const archivePrefix = validateArchiveNamePart(rawOptions.archivePrefix ?? '', 'archivePrefix');
  const zipBaseName = validateArchiveNamePart(rawOptions.zipBaseName ?? 'watermarked', 'zipBaseName');
  const cbzPrefix = validateArchiveNamePart(rawOptions.cbzPrefix ?? 'watermarked_', 'cbzPrefix');
  const cbzFrom = rawOptions.cbzFrom ?? 'unresized';
  if (!['unresized', 'resized'].includes(cbzFrom)) throw new WatermarkEngineError('cbzFrom must be unresized or resized.', { code: 'INVALID_CBZ_SOURCE' });
  const archiveBase = setName.trim() || `${archivePrefix}${zipBaseName}`;
  if (!archiveBase.trim()) throw new WatermarkEngineError('The archive filename must not be empty.', { code: 'INVALID_ARCHIVE_NAME' });

  if (scaleMap !== null) validateScaleMap(scaleMap);
  return {
    mode,
    position,
    marginRatio,
    marginPx,
    opacity,
    outputFormat,
    quality,
    maxDimension,
    deleteSource,
    scale,
    scaleBasis,
    windowAspect,
    fixedWatermarkWidthPx,
    nudgeX,
    nudgeY,
    nudgeXRatio,
    nudgeYRatio,
    allowOffCanvas,
    containment,
    scaleMap,
    overwrite,
    socialSuffix: suffix,
    suffix,
    suffixUnresized,
    suffixResized,
    alsoUnresized,
    dualVariants,
    outputDirectory,
    trimWatermark,
    watermarkBeforeResize,
    webpLossless,
    additionalFormats,
    additionalFormatsResized,
    jpegBackground,
    makeArchives,
    archiveFormat,
    archiveIncludeResized,
    zipJpgQuality: archiveQuality('zipJpgQuality', 80),
    zipWebpQuality: archiveQuality('zipWebpQuality', 90),
    setName,
    archivePrefix,
    zipBaseName,
    makeCbz,
    cbzPrefix,
    cbzFrom,
    cbzJpgQuality: archiveQuality('cbzJpgQuality', 85),
    replaceExistingArchives,
    archiveResizedOnlyBlocked: makeArchives && !archiveIncludeResized && !dualVariants && maxDimension !== null,
  };
}

function normalizeOutputDirectory(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)
    || value.split(/[\\/]/).some((part) => part === '..')) {
    throw new WatermarkEngineError('The output directory must be a safe project-relative path.', { code: 'INVALID_OUTPUT_DIRECTORY' });
  }
  return value.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
}

function normalizeAdditionalFormats(value) {
  if (!Array.isArray(value)) throw new WatermarkEngineError('Additional watermark formats must be an array.', { code: 'INVALID_FORMAT' });
  return value.map((format) => {
    const normalized = normalizeFormat(format);
    if (!WATERMARK_OUTPUT_FORMATS.includes(normalized)) throw new WatermarkEngineError('An additional watermark format is unsupported.', { code: 'INVALID_FORMAT' });
    return normalized;
  });
}

function normalizeJpegBackground(value) {
  if (typeof value === 'string' && (/^#[0-9a-f]{6}$/i.test(value) || /^[a-z]+$/i.test(value))) return value;
  if (value && typeof value === 'object' && [value.r, value.g, value.b].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) return value;
  throw new WatermarkEngineError('JPEG background must be a valid color.', { code: 'INVALID_JPEG_BACKGROUND' });
}

export async function trimTransparentBorder(input, sharpImplementation = sharp) {
  try {
    const { data, info } = await sharpImplementation(input)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = info.width;
    let top = info.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const alpha = data[((y * info.width) + x) * info.channels + 3];
        if (alpha === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < left || bottom < top) {
      throw new WatermarkEngineError('The watermark has no visible content.', {
        code: 'WATERMARK_FILE_INVALID',
      });
    }
    const width = right - left + 1;
    const height = bottom - top + 1;
    const trimmedBuffer = await sharpImplementation(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: info.channels,
      },
    }).extract({ left, top, width, height }).png().toBuffer();
    const metadata = await sharpImplementation(trimmedBuffer).metadata();
    if (!positiveFinite(metadata.width) || !positiveFinite(metadata.height)) {
      throw new Error('Trimmed watermark dimensions are invalid.');
    }
    return {
      buffer: trimmedBuffer,
      width: metadata.width,
      height: metadata.height,
    };
  } catch (err) {
    if (err instanceof WatermarkEngineError) throw err;
    throw new WatermarkEngineError('The watermark image could not be trimmed.', {
      code: 'WATERMARK_PROCESSING_FAILED',
      cause: err,
    });
  }
}

export async function applyWatermarkOpacity(input, opacity, sharpImplementation = sharp) {
  if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 1) {
    throw new WatermarkEngineError('Watermark opacity is invalid.', { code: 'INVALID_OPACITY' });
  }

  try {
    const { data, info } = await sharpImplementation(input)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let index = 3; index < data.length; index += info.channels) {
      data[index] = Math.round(data[index] * opacity);
    }
    const buffer = await sharpImplementation(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: info.channels,
      },
    }).png().toBuffer();
    return { buffer, width: info.width, height: info.height };
  } catch (err) {
    if (err instanceof WatermarkEngineError) throw err;
    throw new WatermarkEngineError('The watermark opacity could not be applied.', {
      code: 'WATERMARK_PROCESSING_FAILED',
      cause: err,
    });
  }
}

export async function prepareWatermark(input, sharpImplementation = sharp, trimWatermark = true) {
  if (trimWatermark) return trimTransparentBorder(input, sharpImplementation);
  try {
    const buffer = await sharpImplementation(input).ensureAlpha().png().toBuffer();
    const metadata = await sharpImplementation(buffer).metadata();
    if (!positiveFinite(metadata.width) || !positiveFinite(metadata.height)) throw new Error('Invalid watermark dimensions.');
    return { buffer, width: metadata.width, height: metadata.height };
  } catch (err) {
    throw new WatermarkEngineError('The watermark image could not be prepared.', { code: 'WATERMARK_PROCESSING_FAILED', cause: err });
  }
}

export async function renderWatermarkedImage({
  baseInput,
  watermarkInput,
  options,
  outputFormat,
  sharpImplementation = sharp,
}) {
  if (!options || !WATERMARK_OUTPUT_MODES.includes(options.mode)) {
    throw new WatermarkEngineError('Normalized watermark options are required.', {
      code: 'INVALID_OPTIONS',
    });
  }
  if (!WATERMARK_OUTPUT_FORMATS.includes(outputFormat)) {
    throw new WatermarkEngineError('A concrete watermark output format is required.', {
      code: 'INVALID_FORMAT',
    });
  }

  try {
    const orientedBuffer = await sharpImplementation(baseInput).rotate().toBuffer();
    const sourceMetadata = await sharpImplementation(orientedBuffer).metadata();
    if (!positiveFinite(sourceMetadata.width) || !positiveFinite(sourceMetadata.height)) {
      throw new Error('Source image dimensions are invalid.');
    }
    const trimmed = watermarkInput?.buffer
      ? watermarkInput
      : await prepareWatermark(watermarkInput, sharpImplementation, options.trimWatermark);
    let basePipeline = sharpImplementation(orientedBuffer);
    if (options.maxDimension !== null && !options.watermarkBeforeResize) {
      basePipeline = basePipeline.resize({
        width: options.maxDimension,
        height: options.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const baseBuffer = await basePipeline.toBuffer();
    const baseMetadata = await sharpImplementation(baseBuffer).metadata();
    if (!positiveFinite(baseMetadata.width) || !positiveFinite(baseMetadata.height)) {
      throw new WatermarkEngineError('Base image dimensions are invalid.', {
        code: 'INVALID_IMAGE_DIMENSIONS',
      });
    }

    const geometry = deriveWatermarkGeometry({
      sourceWidth: sourceMetadata.width,
      sourceHeight: sourceMetadata.height,
      compositeWidth: options.watermarkBeforeResize ? sourceMetadata.width : baseMetadata.width,
      compositeHeight: options.watermarkBeforeResize ? sourceMetadata.height : baseMetadata.height,
      watermarkWidth: trimmed.width,
      watermarkHeight: trimmed.height,
      options,
    });
    const resizedWatermark = await sharpImplementation(trimmed.buffer)
      .resize({
        width: geometry.watermarkDimensions.width,
        height: geometry.watermarkDimensions.height,
        fit: 'fill',
      })
      .png()
      .toBuffer();
    const opaqueWatermark = await applyWatermarkOpacity(
      resizedWatermark,
      options.opacity,
      sharpImplementation,
    );
    let outputPipeline = sharpImplementation(options.watermarkBeforeResize ? orientedBuffer : baseBuffer);
    if (geometry.visibleOverlay) {
      const overlay = geometry.visibleOverlay;
      const clippedWatermark = await sharpImplementation(opaqueWatermark.buffer)
        .extract({
          left: overlay.cropLeft,
          top: overlay.cropTop,
          width: overlay.width,
          height: overlay.height,
        })
        .png()
        .toBuffer();
      outputPipeline = outputPipeline.composite([{
        input: clippedWatermark,
        left: overlay.left,
        top: overlay.top,
      }]);
    }
    if (options.watermarkBeforeResize && options.maxDimension !== null) {
      outputPipeline = outputPipeline.resize({ width: options.maxDimension, height: options.maxDimension, fit: 'inside', withoutEnlargement: true });
    }
    if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
      outputPipeline = outputPipeline
        .flatten({ background: options.jpegBackground })
        .jpeg({ quality: options.quality });
    } else if (outputFormat === 'webp') {
      outputPipeline = outputPipeline.webp({ quality: options.quality, lossless: options.webpLossless });
    } else {
      outputPipeline = outputPipeline.png();
    }

    const buffer = await outputPipeline.toBuffer();
    const outputMetadata = await sharpImplementation(buffer).metadata();
    const expectedFormat = outputFormat === 'jpg' ? 'jpeg' : outputFormat;
    if (outputMetadata.format !== expectedFormat
      || (options.watermarkBeforeResize ? outputMetadata.width > options.maxDimension || outputMetadata.height > options.maxDimension : outputMetadata.width !== baseMetadata.width || outputMetadata.height !== baseMetadata.height)) {
      throw new Error('Sharp produced unexpected watermark output metadata.');
    }
    return {
      buffer,
      width: outputMetadata.width,
      height: outputMetadata.height,
      format: outputMetadata.format,
      watermark: {
        width: opaqueWatermark.width,
        height: opaqueWatermark.height,
        scale: geometry.effectiveScale,
        margin: { x: geometry.margin, y: geometry.margin },
        left: geometry.effectiveCoordinates.left,
        top: geometry.effectiveCoordinates.top,
        geometry,
      },
    };
  } catch (err) {
    if (err instanceof WatermarkEngineError) throw err;
    throw new WatermarkEngineError('The selected image could not be watermarked.', {
      code: 'WATERMARK_PROCESSING_FAILED',
      cause: err,
    });
  }
}

export function outputExtensionForSource(sourceExtension, requestedFormat) {
  const normalizedSource = normalizeFormat(sourceExtension);
  const format = requestedFormat === 'same' ? normalizedSource : normalizeFormat(requestedFormat);
  if (!WATERMARK_OUTPUT_FORMATS.includes(format)) {
    throw new WatermarkEngineError('The source/output image format is unsupported.', {
      code: 'UNSUPPORTED_SOURCE_TYPE',
    });
  }
  return requestedFormat === 'same' && sourceExtension === 'jpg' ? 'jpg' : format;
}

export function watermarkFilenameForSource(filename, { mode, socialSuffix } = {}) {
  const dotIndex = filename.lastIndexOf('.');
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';
  const suffix = socialSuffix ?? (
    mode === 'social' ? WATERMARK_SOCIAL_SUFFIX : WATERMARK_DEFAULT_SUFFIX
  );
  if (WATERMARK_OUTPUT_MODES.includes(mode) && typeof suffix === 'string') {
    return `${stem}${suffix}${extension}`;
  }
  throw new WatermarkEngineError('The watermark output naming mode is unsupported.', {
    code: 'INVALID_MODE',
  });
}

/**
 * Derive the watermark destination without touching the filesystem. Apply and
 * Preview both use this so mode, suffix, extension, and parent-directory rules
 * cannot drift apart.
 */
export function deriveWatermarkOutputPlan(sourceRelativePath, options) {
  if (typeof sourceRelativePath !== 'string' || sourceRelativePath.length === 0) {
    throw new WatermarkEngineError('The watermark source path is invalid.', {
      code: 'SOURCE_PATH_UNSAFE',
    });
  }

  const normalizedSourcePath = sourceRelativePath.replace(/\\/g, '/');
  const separator = normalizedSourcePath.lastIndexOf('/');
  const sourceParent = separator < 0 ? '' : normalizedSourcePath.slice(0, separator);
  const sourceFilename = separator < 0
    ? normalizedSourcePath
    : normalizedSourcePath.slice(separator + 1);
  const extensionStart = sourceFilename.lastIndexOf('.');
  const sourceExtension = extensionStart > 0
    ? sourceFilename.slice(extensionStart + 1).toLowerCase()
    : '';
  const variants = options.dualVariants
    ? [
      { variant: 'unresized', maxDimension: null, suffix: options.suffixUnresized, additionalFormats: options.additionalFormats },
      { variant: 'resized', maxDimension: options.maxDimension, suffix: options.suffixResized, additionalFormats: options.additionalFormatsResized },
    ]
    : [{ variant: 'single', maxDimension: options.maxDimension, suffix: options.suffix, additionalFormats: options.maxDimension === null ? options.additionalFormats : options.additionalFormatsResized }];
  const outputParent = options.outputDirectory
    ? `${options.outputDirectory}/${sourceParent}`.replace(/\/$/, '')
    : options.mode === 'patreon' ? (sourceParent ? `${sourceParent}/wm` : 'wm') : sourceParent;
  const outputs = variants.flatMap((variant) => [...new Set([options.outputFormat, ...variant.additionalFormats])].map((format) => {
    const outputExtension = outputExtensionForSource(sourceExtension, format);
    const namedFilename = watermarkFilenameForSource(sourceFilename, { mode: options.mode, socialSuffix: variant.suffix });
    const outputFilename = extensionStart > 0
      ? `${namedFilename.slice(0, namedFilename.lastIndexOf('.'))}.${outputExtension}`
      : `${namedFilename}.${outputExtension}`;
    return {
      ...variant,
      outputFilename,
      outputExtension,
      outputFormat: format,
      outputRelativePath: outputParent ? `${outputParent}/${outputFilename}` : outputFilename,
    };
  }));
  return {
    sourceRelativePath: normalizedSourcePath,
    sourceParent,
    sourceFilename,
    sourceExtension,
    outputs,
    ...outputs[0],
  };
}
