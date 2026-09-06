import { classifyPreviewable } from './preview-service.js';
import { ManagedMediaError } from './managed-media-service.js';
import {
  buildAssetPreviewModel,
  buildPreviewAltText,
} from './asset-presentation.js';

/** Book-only source model; Project primary-image presentation stays unchanged. */
export function buildBookPrimaryImageModel(selection, asset) {
  const selectedSource = selection?.source ?? null;
  if (selectedSource?.kind === 'managed_asset') {
    return {
      ...buildEmptyPrimaryImageModel(),
      selectedSource,
      state: 'unavailable',
      kind: 'image',
      unavailableReason: 'source_unavailable',
    };
  }
  return { ...buildPrimaryImageModelForAsset(selection, asset), selectedSource };
}

/** Resolve managed availability at the asynchronous presentation boundary.
 * The synchronous selection model remains conservative until source verification.
 */
export async function resolveBookPrimaryImageMedia(books, managedMediaService) {
  const resolved = new Map();
  const result = [];
  for (const book of books) {
    const image = book.primaryImage;
    const source = image?.selectedSource;
    if (source?.kind !== 'managed_asset') {
      result.push(book);
      continue;
    }
    if (!resolved.has(source.id)) {
      try {
        const { revision } = await managedMediaService.resolveSource(source.id);
        const base = `/managed-assets/${encodeURIComponent(source.id)}`;
        resolved.set(source.id, {
          ...buildEmptyPrimaryImageModel(), selectedSource: source,
          state: 'available', kind: 'image', revision,
          thumbnailUrl: `${base}/thumbnail`, previewUrl: `${base}/preview`,
          alt: 'Book cover',
        });
      } catch (err) {
        if (!(err instanceof ManagedMediaError)) throw err;
        resolved.set(source.id, {
          ...buildEmptyPrimaryImageModel(), selectedSource: source,
          state: 'unavailable', kind: 'image', unavailableReason: 'source_unavailable',
        });
      }
    }
    result.push({ ...book, primaryImage: resolved.get(source.id) });
  }
  return result;
}

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
