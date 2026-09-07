import path from 'node:path';
import { deriveExtensionFromFilename } from './asset-metadata.js';

export const CONVERSION_FORMATS = Object.freeze(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);
export const ORIGINAL_HANDLINGS = Object.freeze(['keep', 'move', 'delete']);
export const CONVERSION_QUALITY_MIN = 1;
export const CONVERSION_QUALITY_MAX = 95;
export const CONVERSION_QUALITY_DEFAULT = 85;

const SOURCE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);
export const WATERMARK_SOURCE_IMAGE_EXTENSIONS = Object.freeze(new Set(['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff']));

export class AssetProcessingError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'AssetProcessingError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/');
}

function relativeJoin(parent, basename) {
  return parent ? `${parent}/${basename}` : basename;
}

function relativeParent(relativePath) {
  const parent = path.posix.dirname(relativePath);
  return parent === '.' ? '' : parent;
}

function replaceExtension(filename, extension) {
  const dotIndex = filename.lastIndexOf('.');
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return `${stem}.${extension}`;
}

export function isSupportedConversionSource(extension) {
  return SOURCE_IMAGE_EXTENSIONS.has(extension);
}

export function normalizeConversionOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AssetProcessingError('Conversion options are required.', { code: 'INVALID_OPTIONS' });
  }

  const { format, originalHandling, quality } = options;
  if (!CONVERSION_FORMATS.includes(format)) {
    throw new AssetProcessingError(
      `Conversion format must be one of: ${CONVERSION_FORMATS.join(', ')}.`,
      { code: 'INVALID_FORMAT' },
    );
  }
  if (!ORIGINAL_HANDLINGS.includes(originalHandling)) {
    throw new AssetProcessingError(
      `Original handling must be one of: ${ORIGINAL_HANDLINGS.join(', ')}.`,
      { code: 'INVALID_ORIGINAL_HANDLING' },
    );
  }

  const normalizedQuality = quality === undefined || quality === null
    ? CONVERSION_QUALITY_DEFAULT
    : quality;
  if (!Number.isInteger(normalizedQuality)
    || normalizedQuality < CONVERSION_QUALITY_MIN
    || normalizedQuality > CONVERSION_QUALITY_MAX) {
    throw new AssetProcessingError(
      `Quality must be an integer from ${CONVERSION_QUALITY_MIN} to ${CONVERSION_QUALITY_MAX}.`,
      { code: 'INVALID_QUALITY' },
    );
  }

  return {
    format,
    originalHandling,
    quality: normalizedQuality,
  };
}

export function deriveConversionOutputPlan(sourceRelativePath, options) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const sourceFilename = path.posix.basename(normalizedSourcePath);
  const sourceParent = relativeParent(normalizedSourcePath);
  const sourceExtension = deriveExtensionFromFilename(sourceFilename);
  const sameExtension = sourceExtension === options.format;
  if (sameExtension && options.originalHandling !== 'keep') {
    throw new AssetProcessingError(
      'Same-extension conversion requires originalHandling=keep.',
      { code: 'INVALID_ORIGINAL_HANDLING' },
    );
  }

  const outputFilename = sameExtension
    ? sourceFilename
    : replaceExtension(sourceFilename, options.format);
  const outputRelativePath = sameExtension
    ? normalizedSourcePath
    : relativeJoin(sourceParent, outputFilename);

  const result = {
    sourceRelativePath: normalizedSourcePath,
    sourceFilename,
    sourceParent,
    sourceExtension,
    sameExtension,
    outputFilename,
    outputRelativePath,
  };

  if (options.originalHandling === 'move') {
    const originalsDirRelative = relativeJoin(sourceParent, 'originals');
    result.originalRelativePath = relativeJoin(originalsDirRelative, sourceFilename);
    result.originalsDirRelative = originalsDirRelative;
  }

  return result;
}
