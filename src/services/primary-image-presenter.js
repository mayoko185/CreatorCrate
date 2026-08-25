import { classifyPreviewable } from './preview-service.js';
import {
  buildAssetPreviewModel,
  buildPreviewAltText,
} from './asset-presentation.js';

export function buildEmptyPrimaryImageModel() {
  return {
    selectedAssetId: null,
    provenance: null,
    state: 'none',
    kind: null,
    mediaModifier: null,
    previewUrl: null,
    thumbnailUrl: null,
    revision: null,
    alt: null,
  };
}

/**
 * Build a primary-image view model from an already-resolved selection and asset.
 *
 * Callers are responsible for enforcing ownership or other domain-specific
 * eligibility rules before passing the asset here.
 *
 * @param {object|null|undefined} selection
 * @param {object|null|undefined} asset
 * @returns {object}
 */
export function buildPrimaryImageModelForAsset(selection, asset) {
  const selectedAssetId = selection?.asset_id ?? null;
  if (selectedAssetId === null) return buildEmptyPrimaryImageModel();

  const provenance = selection?.provenance ?? null;
  const classification = asset ? classifyPreviewable(asset) : null;
  const kind = classification?.kind ?? null;
  const mediaModifier = kind === 'krita' ? 'krita' : null;
  const supportedPrimaryKind = classification?.supported === true
    && (classification.kind === 'image'
      || (classification.kind === 'krita' && classification.extension === 'kra'));

  if (!asset || !asset.is_present || !supportedPrimaryKind) {
    return {
      selectedAssetId,
      provenance,
      state: 'unavailable',
      kind,
      mediaModifier,
      previewUrl: null,
      thumbnailUrl: null,
      revision: null,
      alt: asset ? buildPreviewAltText(asset) : null,
    };
  }

  const preview = buildAssetPreviewModel(asset);
  return {
    selectedAssetId,
    provenance,
    state: 'available',
    kind,
    mediaModifier,
    previewUrl: preview.urls.preview,
    thumbnailUrl: preview.urls.thumbnail,
    revision: preview.revision,
    alt: buildPreviewAltText(asset),
  };
}
