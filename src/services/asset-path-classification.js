/**
 * Classify a project-relative asset path using the same first-segment rules
 * as the asset scanner.
 *
 * Categories include disabled rows because classification describes the
 * filesystem path, not whether the category is currently selectable.
 */
export function classifyAssetPath(relativePath, categories) {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const dirSegments = segments.slice(0, -1);

  if (dirSegments.length === 0) {
    return { categoryId: null, nestedPath: '' };
  }

  const firstSegment = dirSegments[0];
  const exactMatch = categories.find((category) => category.directory_slug === firstSegment);
  if (exactMatch) {
    return { categoryId: exactMatch.id, nestedPath: dirSegments.slice(1).join('/') };
  }

  const lowerFirst = firstSegment.toLowerCase();
  const ciMatches = categories.filter(
    (category) => category.directory_slug.toLowerCase() === lowerFirst,
  );
  if (ciMatches.length === 1) {
    return { categoryId: ciMatches[0].id, nestedPath: dirSegments.slice(1).join('/') };
  }

  return { categoryId: null, nestedPath: dirSegments.join('/') };
}
