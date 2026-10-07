import fs from 'node:fs';
import path from 'node:path';
import { resolveContainedAssetPath } from '../storage/asset-file.js';

export function isValidGeneratedOutputSha256(value) {
  return typeof value === 'string'
    && value.length === 64
    && /^[0-9a-f]{64}$/i.test(value);
}

// Durable generated-output provenance: the exact filesystem object CreatorCrate itself
// published, recorded only at a strict (exact bigint identity) publication boundary.
// Values are exact unsigned decimals, never rounded Numbers. Birth time is an additional
// qualifier against inode-number reuse; it never proves ownership on its own.
// A zero birth time means the filesystem exposes none, so the tuple cannot tell a reused
// (dev, ino) apart: it is never formatted and never grants cross-run authority. Legacy
// `v1:<dev>:<ino>:0` values still parse, but callers must treat them as unproven.
const PROVENANCE_VERSION = 'v1';
const PROVENANCE_PATTERN = /^v1:(0|[1-9]\d{0,19}):([1-9]\d{0,19}):(0|[1-9]\d{0,29})$/;

/** Whether a birth time can serve as a durable anti-reuse discriminator (never 0n). */
export function isDurableBirthtimeNs(value) {
  return typeof value === 'bigint' && value > 0n;
}

/**
 * @param {{ dev: bigint, ino: bigint, birthtimeNs: bigint }} stats owned output tuple
 * @returns {string|null} null when the identity is unknown (zero/non-bigint IDs) or the
 *   birth time is not a durable discriminator
 */
export function formatGeneratedOutputProvenance(stats) {
  if (!stats || typeof stats.dev !== 'bigint' || typeof stats.ino !== 'bigint'
    || !isDurableBirthtimeNs(stats.birthtimeNs)
    || stats.dev < 0n || stats.ino <= 0n) {
    return null;
  }
  return `${PROVENANCE_VERSION}:${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

/**
 * @returns {{ dev: bigint, ino: bigint, birthtimeNs: bigint }|null} null for absent or
 *   malformed provenance, which never authorizes a destructive action
 */
export function parseGeneratedOutputProvenance(value) {
  if (typeof value !== 'string') return null;
  const match = PROVENANCE_PATTERN.exec(value);
  if (!match) return null;
  return { dev: BigInt(match[1]), ino: BigInt(match[2]), birthtimeNs: BigInt(match[3]) };
}

/**
 * Read-only observation for planning: whether the regular file currently at `absPath`
 * is exactly the object a persisted provenance tuple records (exact bigint dev, ino and
 * a durable nonzero birth time). Absent, malformed, zero-birth-time, unmatched or
 * unreadable provenance is false. Never authority: execution re-proves ownership itself.
 */
export function currentFileMatchesGeneratedOutputProvenance(absPath, provenance) {
  const recorded = parseGeneratedOutputProvenance(provenance);
  if (!recorded || !isDurableBirthtimeNs(recorded.birthtimeNs)) return false;
  try {
    const stats = fs.lstatSync(absPath, { bigint: true });
    return !stats.isSymbolicLink() && stats.isFile()
      && stats.dev === recorded.dev && stats.ino === recorded.ino
      && stats.birthtimeNs === recorded.birthtimeNs;
  } catch {
    return false;
  }
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
