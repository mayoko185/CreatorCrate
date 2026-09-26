import { classifyPreviewable, buildAssetRevisionToken } from './preview-service.js';
import { inlineMimeFor } from './media-service.js';

function buildPreviewUrls(asset, revision) {
  if (!revision) {
    return { thumbnail: null, preview: null };
  }

  const query = new URLSearchParams({ v: revision }).toString();
  const basePath = buildAssetViewerUrl(asset.project_id, asset.id);
  if (!basePath) {
    return { thumbnail: null, preview: null };
  }

  return {
    thumbnail: `${basePath}/thumbnail?${query}`,
    preview: `${basePath}/preview?${query}`,
  };
}

/**
 * Build the preview model shared by project and release asset presentation.
 * Generated URLs require source metadata; Original uses the media route's
 * inline MIME eligibility and its own cache behavior.
 *
 * @param {object} asset
 * @returns {{
 *   state: 'missing'|'unsupported'|'previewable',
 *   previewable: boolean,
 *   kind: 'image'|'krita'|null,
 *   sourceMetadataValid: boolean,
 *   revision: string|null,
 *   urls: { thumbnail: string|null, preview: string|null },
 * }}
 */
export function buildAssetPreviewModel(asset, presentationPolicy) {
  const resolvedAsset = presentationPolicy?.resolveAsset?.(asset) ?? asset;
  if (!resolvedAsset?.is_present) {
    return {
      state: 'missing',
      previewable: false,
      kind: null,
      sourceMetadataValid: false,
      revision: null,
      urls: { thumbnail: null, preview: null },
    };
  }

  const classification = classifyPreviewable(resolvedAsset);
  if (!classification.supported) {
    return {
      state: 'unsupported',
      previewable: false,
      kind: null,
      sourceMetadataValid: false,
      revision: null,
      urls: { thumbnail: null, preview: null },
    };
  }

  const fingerprint = presentationPolicy?.fingerprintForResolved?.(resolvedAsset)
    ?? presentationPolicy?.fingerprintFor?.(resolvedAsset)
    ?? presentationPolicy?.fingerprint ?? presentationPolicy;
  const revision = buildAssetRevisionToken(resolvedAsset, fingerprint);
  const urls = buildPreviewUrls(resolvedAsset, revision);
  if (presentationPolicy?.previewFormat === 'original') {
    urls.preview = buildAssetOriginalUrl(resolvedAsset) ?? urls.preview;
  }
  return {
    state: 'previewable',
    previewable: true,
    kind: classification.kind,
    sourceMetadataValid: revision !== null,
    revision,
    urls,
  };
}

/**
 * Format a byte count into the established binary-unit display.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '\u2014';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const decimals = value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

export function buildPreviewAltText(asset) {
  const filename = typeof asset?.filename === 'string' ? asset.filename.trim() : '';
  const identifier = filename || (
    Number.isInteger(asset?.id) && asset.id > 0 ? `Asset ${asset.id}` : 'Unnamed asset'
  );
  return `Preview of ${identifier}`;
}

export function buildAssetLocationLabel(asset) {
  if (asset?.nested_path) return asset.nested_path;
  return asset?.category_id === null || asset?.category_id === undefined ? 'Project root' : '';
}

export function buildDisplayFilename(filename) {
  if (typeof filename !== 'string') return '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) return filename;
  return filename.slice(0, lastDot);
}

export function buildAssetViewerUrl(projectId, assetId) {
  if (projectId === undefined || projectId === null || assetId === undefined || assetId === null) {
    return null;
  }

  return `/projects/${encodeURIComponent(String(projectId))}/assets/${encodeURIComponent(String(assetId))}`;
}

export function buildAssetOriginalUrl(asset) {
  if (!asset?.is_present) return null;
  if (!inlineMimeFor(asset.extension, asset.mime_type)) return null;

  const viewerUrl = buildAssetViewerUrl(asset.project_id, asset.id);
  return viewerUrl ? `${viewerUrl}/original` : null;
}
