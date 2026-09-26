// Project Assets category processing capabilities.
//
// Sorting is presentation-only: this resolver deliberately accepts no sort or
// order input. Category reorder and Auto Rename are granted from business
// eligibility plus complete category membership, never from the active sort
// or from which surface happened to render.

const PRESENTATION_ONLY_INPUTS = ['sort', 'order'];

const NO_CATEGORY_CAPABILITIES = Object.freeze({
  hasCompleteCategoryMembership: false,
  canReorderCategory: false,
  canAutoRename: false,
  category: null,
});

export function noProjectAssetCategoryCapabilities() {
  return NO_CATEGORY_CAPABILITIES;
}

/**
 * The single definition of complete category membership: every category
 * asset is rendered exactly once and nothing outside the category is
 * rendered. Rendered order is irrelevant; any permutation is complete.
 * @param {number[]} membershipIds - every asset id in the category
 * @param {number[]} renderedIds - asset ids in rendered (presentation) order
 * @returns {boolean}
 */
export function hasCompleteCategoryMembership(membershipIds, renderedIds) {
  if (!Array.isArray(membershipIds) || !Array.isArray(renderedIds)) return false;
  if (membershipIds.length === 0 || renderedIds.length !== membershipIds.length) return false;

  const rendered = new Set(renderedIds);
  return rendered.size === renderedIds.length
    && membershipIds.every((id) => rendered.has(id));
}

/**
 * @param {object} input
 * @param {boolean} input.projectArchived
 * @param {object|null} input.categoryMembership - `getProjectAutoRenameCategory` result
 * @param {number[]} input.renderedAssetIds - asset ids in rendered order
 * @returns {{
 *   hasCompleteCategoryMembership: boolean,
 *   canReorderCategory: boolean,
 *   canAutoRename: boolean,
 *   category: null | {
 *     categoryId: number, displayName: string, directorySlug: string,
 *     orderedAssetIds: number[], orderedAssetIdsJson: string,
 *   },
 * }}
 */
export function resolveProjectAssetCategoryCapabilities(input = {}) {
  const presentationInput = PRESENTATION_ONLY_INPUTS.find((key) => Object.hasOwn(input, key));
  if (presentationInput) {
    throw new TypeError(`Category capabilities must not depend on presentation input "${presentationInput}".`);
  }

  const { projectArchived = false, categoryMembership = null, renderedAssetIds = [] } = input;
  const category = categoryMembership?.effectiveCategory || null;
  const eligible = Boolean(
    !projectArchived
    && category
    && categoryMembership.autoRenameAvailable === true,
  );
  if (!eligible || !hasCompleteCategoryMembership(categoryMembership.orderedAssetIds, renderedAssetIds)) {
    return NO_CATEGORY_CAPABILITIES;
  }

  const orderedAssetIds = [...renderedAssetIds];
  return {
    hasCompleteCategoryMembership: true,
    canReorderCategory: true,
    canAutoRename: true,
    category: {
      categoryId: category.id,
      displayName: category.displayName,
      directorySlug: category.directorySlug,
      orderedAssetIds,
      orderedAssetIdsJson: JSON.stringify(orderedAssetIds),
    },
  };
}
