import {
  buildAssetLocationLabel,
  buildAssetOriginalUrl,
  buildAssetPreviewModel,
  buildAssetViewerUrl,
  buildDisplayFilename,
  buildPreviewAltText,
  formatFileSize,
} from './asset-presentation.js';

function assetIdFromRow(row, selected) {
  return selected ? (row?.asset_id ?? row?.id) : row?.id;
}

function buildReleaseContext(row, selected) {
  return {
    selected,
    role: selected ? row?.role ?? null : null,
    sortOrder: selected ? row?.sort_order ?? null : null,
  };
}

function isEnabledCategory(category) {
  return category?.enabled === 1 || category?.enabled === true;
}

function buildCategoryPresentation(asset, categoriesById) {
  if (asset.category_id === null || asset.category_id === undefined) {
    return {
      category: null,
      categoryLabel: 'Uncategorized',
      categoryDisabled: false,
    };
  }

  const source = categoriesById.get(asset.category_id);
  if (!source) {
    return {
      category: null,
      categoryLabel: null,
      categoryDisabled: false,
    };
  }

  const category = {
    id: source.id,
    displayName: source.display_name ?? source.displayName,
    enabled: isEnabledCategory(source),
    displayOrder: source.display_order ?? source.displayOrder ?? null,
  };
  return {
    category,
    categoryLabel: category.displayName,
    categoryDisabled: !category.enabled,
  };
}

/**
 * Normalize one selected release row or unselected project asset row into the
 * asset presentation shape used by the project asset browser.
 *
 * The input row is never modified. Release mutation routes and action markup
 * are deliberately absent; release-specific state lives under releaseContext.
 *
 * @param {object} row
 * @param {{ selected?: boolean, categoriesById?: Map }} [options]
 * @returns {object}
 */
export function buildReleaseAssetPresentation(row, { selected = false, categoriesById = new Map() } = {}) {
  const assetId = assetIdFromRow(row, selected);
  const asset = {
    id: assetId,
    project_id: row?.project_id ?? null,
    relative_path: row?.relative_path ?? null,
    nested_path: row?.nested_path ?? null,
    category_id: row?.category_id ?? null,
    filename: row?.filename ?? '',
    extension: row?.extension ?? null,
    mime_type: row?.mime_type ?? null,
    size_bytes: row?.size_bytes ?? null,
    modified_at: row?.modified_at ?? null,
    is_present: row?.is_present,
  };
  const preview = buildAssetPreviewModel(asset);
  const viewerUrl = buildAssetViewerUrl(asset.project_id, asset.id);
  const originalUrl = buildAssetOriginalUrl(asset);
  const hasSize = Number.isFinite(asset.size_bytes) && asset.size_bytes >= 0;
  const categoryPresentation = buildCategoryPresentation(asset, categoriesById);

  return {
    id: asset.id,
    project_id: asset.project_id,
    relative_path: asset.relative_path,
    nested_path: asset.nested_path,
    category_id: asset.category_id,
    ...categoryPresentation,
    filename: asset.filename,
    displayFilename: buildDisplayFilename(asset.filename),
    extension: asset.extension,
    typeLabel: asset.extension ? String(asset.extension).toUpperCase() : 'File',
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    formattedSize: hasSize ? formatFileSize(asset.size_bytes) : null,
    modified_at: asset.modified_at,
    is_present: asset.is_present,
    presence_state: asset.is_present ? 'present' : 'missing',
    presenceLabel: asset.is_present ? 'Present' : 'Missing at last scan',
    locationLabel: buildAssetLocationLabel(asset),
    viewerUrl,
    original_url: originalUrl,
    preview,
    preview_state: preview.state,
    preview_revision: preview.revision,
    thumbnail_url: preview.urls.thumbnail,
    preview_url: preview.urls.preview,
    previewAvailable: Boolean(preview.urls.thumbnail || preview.urls.preview),
    previewAltText: buildPreviewAltText(asset),
    isPreviewable: preview.previewable,
    hasThumbnail: Boolean(preview.urls.thumbnail),
    originalEligible: Boolean(originalUrl),
    releaseContext: buildReleaseContext(row, selected),
  };
}

/**
 * Normalize the complete selected collection and the current filtered/page
 * project asset collection. The selected collection remains available for the
 * read-only presentation; `assets` is the editable grid/list collection.
 *
 * @param {{ selectedAssets?: object[], candidateAssets?: object[], assets?: object[], categories?: object[] }} [input]
 * @returns {{ selected: object[], candidates: object[], assets: object[] }}
 */
export function buildReleaseAssetPagePresentation({
  selectedAssets = [],
  candidateAssets = null,
  assets = null,
  categories = [],
} = {}) {
  const categoriesById = new Map(
    (Array.isArray(categories) ? categories : []).map((category) => [category.id, category]),
  );

  const selectedRows = Array.isArray(selectedAssets) ? selectedAssets : [];
  const selectedById = new Map(
    selectedRows
      .map((row) => [row?.asset_id ?? row?.id, row])
      .filter(([id]) => id !== undefined && id !== null)
      .map(([id, row]) => [String(id), row]),
  );
  const assetRows = Array.isArray(assets)
    ? assets
    : [
      ...selectedRows,
      ...(Array.isArray(candidateAssets) ? candidateAssets : []),
    ];
  const candidateRows = Array.isArray(candidateAssets)
    ? candidateAssets
    : assetRows.filter((row) => !selectedById.has(String(row?.id ?? row?.asset_id)));

  const selected = selectedRows.map((row) => buildReleaseAssetPresentation(row, {
    selected: true,
    categoriesById,
  }));
  const candidates = candidateRows.map((row) => buildReleaseAssetPresentation(row, {
    selected: false,
    categoriesById,
  }));
  const presentedAssets = assetRows.map((row) => {
    const assetId = row?.asset_id ?? row?.id;
    const selectedRow = selectedById.get(String(assetId));
    if (!selectedRow) {
      return buildReleaseAssetPresentation(row, { selected: false, categoriesById });
    }

    return buildReleaseAssetPresentation({
      ...row,
      asset_id: assetId,
      role: selectedRow.role,
      sort_order: selectedRow.sort_order,
    }, { selected: true, categoriesById });
  });

  return {
    selected,
    candidates,
    assets: presentedAssets,
  };
}
