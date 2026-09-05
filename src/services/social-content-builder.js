const SOCIAL_CONTENT_PLATFORMS = Object.freeze(['patreon', 'x', 'bluesky']);

function assetValue(row, camelName, snakeName, fallback = null) {
  return row?.[camelName] ?? row?.[snakeName] ?? fallback;
}

function normalizeAsset(row) {
  return {
    assetId: assetValue(row, 'assetId', 'asset_id', assetValue(row, 'id', 'id')),
    role: row?.role ?? null,
    sortOrder: assetValue(row, 'sortOrder', 'sort_order'),
    filename: row?.filename ?? null,
    extension: row?.extension ?? null,
    mimeType: assetValue(row, 'mimeType', 'mime_type'),
    sizeBytes: assetValue(row, 'sizeBytes', 'size_bytes'),
    isPresent: assetValue(row, 'isPresent', 'is_present'),
    relativePath: assetValue(row, 'relativePath', 'relative_path'),
    nestedPath: assetValue(row, 'nestedPath', 'nested_path', ''),
    projectId: assetValue(row, 'projectId', 'project_id'),
  };
}

function buildAssetIssue(asset) {
  return {
    code: 'asset_missing',
    severity: 'blocking',
    assetId: asset.assetId,
  };
}

function buildPlatformContent(platform, release, assets) {
  const includedAssets = assets.map(normalizeAsset);
  const excludedAssets = [];

  const issues = [];
  if (release.description === '') {
    issues.push({ code: 'body_empty', severity: 'warning' });
  }
  for (const asset of includedAssets) {
    if (asset.isPresent === 0) {
      issues.push(buildAssetIssue(asset));
    }
  }

  return {
    title: release.title,
    body: platform === 'patreon'
      ? release.description
      : [release.title, release.description].filter(Boolean).join('\n\n'),
    includedAssets,
    excludedAssets,
    issues,
  };
}

/**
 * Builds platform-neutral Social Preparation content from an authoritative
 * release and its already-ordered asset rows.
 *
 * @param {{ release: { title: string, description: string }, releaseAssets: object[], platforms: string[] }} input
 * @returns {Record<string, object>}
 */
export function buildSocialContent({ release, releaseAssets, platforms }) {
  for (const platform of platforms) {
    if (!SOCIAL_CONTENT_PLATFORMS.includes(platform)) {
      throw new RangeError(`Unsupported social content platform: ${platform}`);
    }
  }

  return Object.fromEntries(
    platforms.map((platform) => [platform, buildPlatformContent(platform, release, releaseAssets)]),
  );
}
