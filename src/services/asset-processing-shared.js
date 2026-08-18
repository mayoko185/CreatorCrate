import fs from 'node:fs';
import path from 'node:path';
import { resolveContainedAssetPath } from '../storage/asset-file.js';

export function isValidGeneratedOutputSha256(value) {
  return typeof value === 'string'
    && value.length === 64
    && /^[0-9a-f]{64}$/i.test(value);
}

export function resolveTrustedWatermarkFile(watermarkPath, watermarkRoot) {
  if (!watermarkPath) {
    const error = new Error('No trusted watermark file is configured.');
    error.code = 'WATERMARK_FILE_INVALID';
    throw error;
  }

  let resolved;
  try {
    resolved = path.resolve(watermarkPath);
    if (watermarkRoot) {
      const root = path.resolve(watermarkRoot);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Watermark file is outside the trusted watermark root.');
      }
      const rootStats = fs.lstatSync(root);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw new Error('Trusted watermark root is unsafe.');
      }
      resolved = resolveContainedAssetPath(root, relative);
    }
    if (path.extname(resolved).slice(1).toLowerCase() !== 'png') {
      throw new Error('The trusted watermark file must be a PNG.');
    }
    const stats = fs.lstatSync(resolved);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('The trusted watermark file is not a regular file.');
    }
  } catch (cause) {
    const error = new Error('The trusted watermark file is invalid.');
    error.code = 'WATERMARK_FILE_INVALID';
    error.cause = cause;
    throw error;
  }
  return resolved;
}

export function isOwnedWatermarkDestination({
  destinationAsset,
  destinationStats,
  destinationHash,
  sourceAsset,
  sourceRelativePath,
  outputRelativePath,
  outputCategoryId,
  outputNestedPath,
  variant,
  options,
  assetRepository,
  watermarkId,
}) {
  if (!destinationAsset
    || destinationAsset.project_id !== sourceAsset.project_id
    || destinationAsset.relative_path.replace(/\\/g, '/') !== outputRelativePath
    || destinationAsset.generated_by !== 'watermark'
    || destinationAsset.generated_mode !== options.mode
    || (destinationAsset.generated_variant !== (variant ?? 'single')
      && !(destinationAsset.generated_variant === null && (variant ?? 'single') === 'single')
      && !(destinationAsset.generated_variant === 'single'
        && ['unresized', 'resized'].includes(variant)))
    || destinationAsset.generated_source_relative_path !== sourceRelativePath
    || (watermarkId !== undefined && destinationAsset.generated_watermark_id !== watermarkId)
    || destinationAsset.category_id !== outputCategoryId
    || (destinationAsset.nested_path ?? '') !== outputNestedPath
    || !Number.isSafeInteger(destinationAsset.generated_source_asset_id)
    || destinationAsset.generated_source_asset_id <= 0) {
    return false;
  }

  const generatedOutputSha256 = destinationAsset.generated_output_sha256;
  if (!isValidGeneratedOutputSha256(generatedOutputSha256)) return false;

  if (destinationAsset.generated_source_asset_id !== sourceAsset.id
    && assetRepository.findById(destinationAsset.generated_source_asset_id)) {
    return false;
  }

  if (!destinationStats) return true;
  return destinationHash === generatedOutputSha256.toLowerCase();
}
