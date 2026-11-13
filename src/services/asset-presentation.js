import { classifyPreviewable, buildAssetRevisionToken } from './preview-service.js';
import { inlineMimeFor } from './media-service.js';
import { classifyComicAsset, classifySupportedVideo } from './asset-metadata.js';

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
 * A supported video gets its own `video` state: it is never previewable and
 * its thumbnail/preview URLs stay null so no `<img>` ever requests video
 * bytes. `playbackUrl` is the authenticated original route, used only by the
 * Asset Viewer's native player.
 *
 * A comic archive (CBZ/CBR/CB7) keeps the `unsupported` (or `missing`) state
 * and null image-preview URLs — it is never previewable, never an image
 * `kind`, and so never a slideshow member. Hosts may opt its cover into the
 * ordinary image card media without changing that classification.
 * `comic.cover` uses the same Preview URLs with source, canonical-format and
 * effective-policy hints; delivery proves the actual derivative authority.
 * `comic` identifies it by extension; it is `null` for every other asset. It is a type classification,
 * not proof the archive is valid, and building it never opens the archive.
 *
 * `comic.sourceRevision` is the indexed-source revision of a present comic:
 * the same unfingerprinted `buildAssetRevision` token (project, asset,
 * relative path, recorded size/mtime, source generation) the comic media
 * service anchors every manifest to. Hosts pass it to the shared reader only
 * as a change hint for an open session; it is never a manifest revision and
 * never authorizes a page request. It is `null` for a missing comic or a row
 * whose scan metadata cannot anchor a revision — the comic service refuses
 * such a source, so no reader is offered for it.
 *
 * `imageSources` is additive only for present, previewable images/Krita.
 * Other media retain their existing descriptor shape. The source revision is
 * policy-independent; optimized.revision includes the generated-output policy.
 * Eligibility is indexed capability, revalidated by delivery on every request.
 *
 * @param {object} asset
 * @returns {{
 *   state: 'missing'|'unsupported'|'previewable'|'video',
 *   previewable: boolean,
 *   kind: 'image'|'krita'|'video'|null,
 *   sourceMetadataValid: boolean,
 *   revision: string|null,
 *   urls: { thumbnail: string|null, preview: string|null },
 *   playbackUrl: string|null,
 *   imageSources: object|undefined,
 *   comic: { format: 'cbz'|'cbr'|'cb7', sourceRevision: string|null, cover: { revisionHint: string|null, urls: { thumbnail: string|null, preview: string|null } } }|null,
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
      playbackUrl: null,
      comic: buildComicDescriptor(resolvedAsset, { present: false }, presentationPolicy),
    };
  }

  const classification = classifyPreviewable(resolvedAsset);
  if (!classification.supported) {
    const viewerUrl = buildAssetViewerUrl(resolvedAsset.project_id, resolvedAsset.id);
    if (viewerUrl && classifySupportedVideo(resolvedAsset).supported) {
      return {
        state: 'video',
        previewable: false,
        kind: 'video',
        sourceMetadataValid: false,
        revision: null,
        urls: { thumbnail: null, preview: null },
        playbackUrl: `${viewerUrl}/original`,
        comic: null,
      };
    }
    return {
      state: 'unsupported',
      previewable: false,
      kind: null,
      sourceMetadataValid: false,
      revision: null,
      urls: { thumbnail: null, preview: null },
      playbackUrl: null,
      comic: buildComicDescriptor(resolvedAsset, { present: true }, presentationPolicy),
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
    playbackUrl: null,
    comic: null,
    imageSources: buildImageSources(resolvedAsset, typeof fingerprint === 'string'
      && /^[a-f0-9]{16}$/.test(fingerprint) ? revision : null),
  };
}

// Eligibility describes the indexed source, not a filesystem or decode probe.
// Delivery revalidates it; a generated source may need on-demand generation.
function buildImageSources(asset, renditionRevision) {
  const sourceRevision = buildAssetRevisionToken(asset);
  const base = sourceRevision
    ? buildAssetViewerUrl(asset.project_id, asset.id) : null;
  const optimized = Boolean(base && renditionRevision);
  const original = base ? buildAssetOriginalUrl(asset) : null;
  return {
    projectId: asset.project_id,
    assetId: asset.id,
    sourceRevision,
    optimized: {
      url: optimized ? `${base}/preview?${new URLSearchParams({
        rendition: 'optimized', sourceRevision, v: renditionRevision,
      })}` : null,
      revision: renditionRevision,
      eligible: optimized,
    },
    original: {
      url: original ? `${original}?${new URLSearchParams({ sourceRevision })}` : null,
      eligible: Boolean(original),
    },
    toggleEligible: Boolean(optimized && original),
  };
}

function buildComicDescriptor(asset, { present }, presentationPolicy) {
  const comic = classifyComicAsset(asset);
  if (!comic.comic) return null;
  // No policy fingerprint: a comic's source identity does not depend on the
  // image presentation policy.
  const sourceRevision = present ? buildAssetRevisionToken(asset) : null;
  const validId = (value) => Number.isSafeInteger(value) && value > 0;
  const eligible = Boolean(sourceRevision && validId(asset.project_id) && validId(asset.id));
  // Canonical format changes must change the native image URL even when the
  // indexed Reader hint is unchanged. Delivery still authorizes the bytes.
  const revisionHint = eligible
    ? buildAssetRevisionToken(asset, `${comic.format}:${presentationPolicy?.comicCoverFingerprint ?? ''}`) : null;
  return {
    format: comic.format,
    sourceRevision,
    cover: { revisionHint, urls: buildPreviewUrls(asset, revisionHint) },
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
