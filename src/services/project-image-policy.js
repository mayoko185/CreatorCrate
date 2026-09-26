import crypto from 'node:crypto';

// The ordered tuple describes effective processing, including animation rules.
export function projectImagePolicyFingerprint(policy, asset) {
  const thumbnail = policy.thumbnail;
  const preview = policy.preview;
  const extension = String(asset?.extension || '').toLowerCase();
  const animatedPngSelection = asset?.source_animated === 1 || asset?.source_animated === true
    || (asset?.source_animated == null && (extension === 'gif' || extension === 'webp'));
  const processing = [
    1,
    thumbnail.format,
    thumbnail.format === 'webp' ? thumbnail.webpQuality : null,
    thumbnail.maxDimension,
    'first-frame-inside-no-enlargement',
    preview.format,
    preview.format === 'original' ? 'webp' : preview.format,
    preview.format === 'original' ? 90
      : (preview.format === 'webp' || (preview.format === 'png' && animatedPngSelection))
        ? preview.webpQuality : null,
    preview.format === 'original' ? 1600 : preview.maxDimension,
    'animated-png-selection-webp',
    'original-generated-fallback-webp',
    'animated-preview-inside-no-enlargement',
  ];
  return crypto.createHash('sha256').update(JSON.stringify(processing)).digest('hex').slice(0, 16);
}

// Bumped when the encoder pipeline for a derivative kind changes, so identities
// written by older generations can no longer prove byte compatibility.
export const PROJECT_IMAGE_GENERATION_IDENTITY_VERSION = 1;

/**
 * Effective encoder parameters for the generated thumbnail and preview. This is
 * generated-derivative identity, not presentation: Preview Original still has
 * its fixed WebP fallback for Book export and internal compatibility paths.
 * `sourceAnimated` is the classification the encoder uses for this source.
 */
export function projectImageGeneratedOutput(policy, sourceAnimated) {
  const animated = Boolean(sourceAnimated);
  const thumbnail = {
    format: policy.thumbnail.format,
    webpQuality: policy.thumbnail.format === 'webp' ? policy.thumbnail.webpQuality : null,
    maxDimension: policy.thumbnail.maxDimension,
  };
  let preview;
  if (policy.preview.format === 'original') {
    preview = { format: 'webp', webpQuality: 90, maxDimension: 1600, animated };
  } else {
    const format = policy.preview.format === 'png' && animated ? 'webp' : policy.preview.format;
    preview = {
      format,
      webpQuality: format === 'webp' ? policy.preview.webpQuality : null,
      maxDimension: policy.preview.maxDimension,
      animated,
    };
  }
  return { thumbnail, preview };
}

// Per-kind identities let one derivative of a published pair be proven
// reusable while only the other kind is re-encoded.
export function projectImageGenerationIdentities(policy, sourceAnimated) {
  const output = projectImageGeneratedOutput(policy, sourceAnimated);
  const hash = (tuple) => crypto.createHash('sha256').update(JSON.stringify(tuple)).digest('hex').slice(0, 16);
  return {
    version: PROJECT_IMAGE_GENERATION_IDENTITY_VERSION,
    thumbnail: hash([PROJECT_IMAGE_GENERATION_IDENTITY_VERSION, 'thumbnail', output.thumbnail.format,
      output.thumbnail.webpQuality, output.thumbnail.maxDimension, 'first-frame-inside-no-enlargement']),
    preview: hash([PROJECT_IMAGE_GENERATION_IDENTITY_VERSION, 'preview', output.preview.format,
      output.preview.webpQuality, output.preview.maxDimension, output.preview.animated,
      'animated-preview-inside-no-enlargement']),
  };
}

export function projectImageEffectiveOutput(policy, asset) {
  const extension = String(asset?.extension || '').toLowerCase();
  const animated = asset?.source_animated === 1 || asset?.source_animated === true
    || (asset?.source_animated == null && (extension === 'gif' || extension === 'webp'));
  const krita = extension === 'kra' || extension === 'krz';
  const thumbnail = [policy.thumbnail.format, policy.thumbnail.maxDimension,
    policy.thumbnail.format === 'webp' ? policy.thumbnail.webpQuality : null];
  let preview = null;
  if (policy.preview.format === 'original') {
    if (krita) preview = ['webp', 1600, 90, 'normal'];
  } else {
    const animatedPng = policy.preview.format === 'png' && animated;
    preview = [animatedPng ? 'webp' : policy.preview.format,
      policy.preview.maxDimension,
      policy.preview.format === 'webp' || animatedPng ? policy.preview.webpQuality : null,
      animatedPng ? 'animated-png-exception' : 'normal'];
  }
  return { thumbnail, preview };
}

export function projectImageRebuildScope(previous, target, asset) {
  const before = projectImageEffectiveOutput(previous, asset);
  const after = projectImageEffectiveOutput(target, asset);
  const thumbnail = JSON.stringify(before.thumbnail) !== JSON.stringify(after.thumbnail);
  const preview = after.preview !== null
    && JSON.stringify(before.preview) !== JSON.stringify(after.preview);
  return { thumbnail, preview, needsRebuild: thumbnail || preview };
}

export function projectImagePresentationPolicy(policy, sourceAnimationService) {
  const resolvedUnknown = new Map();
  const resolveAsset = (asset) => {
    if (policy.preview.format !== 'png' || !sourceAnimationService || !asset?.is_present
      || asset.source_animated != null) return asset;
    const key = `${asset.project_id}:${asset.id}:${asset.relative_path}:${asset.size_bytes}:${asset.modified_at}:${asset.source_generation ?? 0}`;
    if (!resolvedUnknown.has(key)) {
      resolvedUnknown.set(key, sourceAnimationService.ensureKnown(asset) ?? asset);
    }
    return resolvedUnknown.get(key);
  };
  const fingerprintForResolved = (asset) => projectImagePolicyFingerprint(policy, asset);
  return {
    resolveAsset,
    fingerprintForResolved,
    fingerprintFor: (asset) => fingerprintForResolved(resolveAsset(asset)),
    previewFormat: policy.preview.format,
  };
}
