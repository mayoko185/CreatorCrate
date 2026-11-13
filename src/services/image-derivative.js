import { projectImageGeneratedOutput } from './project-image-policy.js';

// One encoder for ordinary image derivatives and admitted static comic covers.
// Policy resolution, source authority and publication belong to the caller.
export const THUMBNAIL_MAX = 256;
export const PREVIEW_MAX = 1600;
export const THUMBNAIL_QUALITY = 80;
export const PREVIEW_QUALITY = 90;

export const IMAGE_DERIVATIVE_CONFIG = Object.freeze({
  thumbnail: Object.freeze({ width: THUMBNAIL_MAX, height: THUMBNAIL_MAX, quality: THUMBNAIL_QUALITY }),
  preview: Object.freeze({ width: PREVIEW_MAX, height: PREVIEW_MAX, quality: PREVIEW_QUALITY }),
});

// Keep native loading lazy for existing Preview Service import-only callers.
let sharpModule = null;
export async function loadDerivativeSharp() {
  sharpModule ??= (await import('sharp')).default;
  return sharpModule;
}

/**
 * Buffer or path input, auto-orientation, inside fit, no enlargement and metadata stripping.
 * Ordinary animated previews retain all frames; static covers explicitly select frame zero.
 * Only the admitted comic execution boundary supplies tightened native decode options.
 */
export async function buildDerivativePipeline(input, { width, height, quality, animated, format = 'webp' },
  { inputOptions, timeoutSeconds } = {}) {
  const sh = await loadDerivativeSharp();
  const ctorOpts = animated ? { animated: true } : {};
  let pipeline = sh(input, inputOptions ? { ...ctorOpts, ...inputOptions } : ctorOpts)
    .autoOrient()
    .resize({ width, height, fit: 'inside', withoutEnlargement: true });
  if (timeoutSeconds !== undefined) pipeline = pipeline.timeout({ seconds: timeoutSeconds });
  return format === 'webp' ? pipeline.webp({ quality }) : pipeline.png();
}

/** Assemble the existing derivative buffer and displayed, per-frame metadata. */
export async function encodeImageDerivative(input, { kind, format = 'webp', ...options }, execution) {
  const pipeline = await buildDerivativePipeline(input, { ...options, format }, execution);
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  const animated = (info.pages ?? 1) > 1;
  return {
    buffer: data,
    width: info.width,
    height: animated ? (info.pageHeight ?? info.height) : info.height,
    animated,
    frameCount: info.pages ?? 1,
    format,
    filename: `${kind}.${format}`,
  };
}

/** Generate one derivative using the effective ordinary image policy. */
export async function generateDerivative(sourceBuffer, kind, sourceAnimated, policy, execution) {
  // Format/quality/dimension rules and per-kind generation identity must agree.
  const output = projectImageGeneratedOutput(policy, sourceAnimated)[kind];
  const format = output.format;
  const config = { width: output.maxDimension, height: output.maxDimension, quality: output.webpQuality };
  const animated = kind === 'preview' && sourceAnimated;
  return encodeImageDerivative(sourceBuffer, { kind, ...config, animated, format }, execution);
}
