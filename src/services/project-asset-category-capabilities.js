// Project Assets category processing capabilities.
//
// Sorting is presentation-only: this resolver deliberately accepts no sort or
// order input. Category reorder and Auto Rename are granted from business
// eligibility plus a valid visible subset of the category membership, never
// from the active sort or from which surface happened to render. The caller's
// membership order is the authoritative complete category order (already in
// the active browser sort); filtered or paginated views only rearrange their
// visible positions within it.

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

function isValidCategoryMembershipOrder(membershipIds) {
  return Array.isArray(membershipIds)
    && membershipIds.length > 0
    && membershipIds.every((id) => Number.isSafeInteger(id) && id > 0)
    && new Set(membershipIds).size === membershipIds.length;
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
 * A valid visible category subset: at least one asset is rendered, each
 * rendered asset appears once, and every rendered asset belongs to the
 * category. Complete membership is the subset that omits nothing.
 * @param {number[]} membershipIds - every asset id in the category
 * @param {number[]} renderedIds - asset ids in rendered (presentation) order
 * @returns {boolean}
 */
export function isVisibleCategorySubset(membershipIds, renderedIds) {
  if (!Array.isArray(membershipIds) || !Array.isArray(renderedIds)) return false;
  if (renderedIds.length === 0 || renderedIds.length > membershipIds.length) return false;

  const membership = new Set(membershipIds);
  return new Set(renderedIds).size === renderedIds.length
    && renderedIds.every((id) => membership.has(id));
}

/**
 * @param {object} input
 * @param {boolean} input.projectArchived
 * @param {object|null} input.categoryMembership - `getProjectAutoRenameCategory` result;
 *   its `orderedAssetIds` is the complete category order in the active sort
 * @param {number[]} input.renderedAssetIds - visible asset ids in rendered order
 * @returns {{
 *   hasCompleteCategoryMembership: boolean,
 *   canReorderCategory: boolean,
 *   canAutoRename: boolean,
 *   category: null | {
 *     categoryId: number, displayName: string, directorySlug: string,
 *     orderedAssetIds: number[], orderedAssetIdsJson: string,
 *   },
 * }}
 *   `category.orderedAssetIds` is always the complete category order,
 *   including assets hidden by filters or pagination, exactly once each.
 */
export function resolveProjectAssetCategoryCapabilities(input = {}) {
  const presentationInput = PRESENTATION_ONLY_INPUTS.find((key) => Object.hasOwn(input, key));
  if (presentationInput) {
    throw new TypeError(`Category capabilities must not depend on presentation input "${presentationInput}".`);
  }

  const { projectArchived = false, categoryMembership = null, renderedAssetIds = [] } = input;
  const category = categoryMembership?.effectiveCategory || null;
  const membershipIds = categoryMembership?.orderedAssetIds;
  const validCategory = Boolean(
    !projectArchived
    && category
    && isValidCategoryMembershipOrder(membershipIds),
  );
  const categoryAvailable = validCategory
    && category.enabled !== false
    && categoryMembership.autoRenameAvailable === true;
  const visibleSubset = validCategory && isVisibleCategorySubset(membershipIds, renderedAssetIds);

  // Evaluated independently; neither requires complete membership. Reorder
  // rearranges only the visible positions of the authoritative order (the
  // temporary arrangement Auto Rename consumes), and Auto Rename submits
  // that complete order, so both accept any valid nonempty visible subset.
  const canReorderCategory = Boolean(categoryAvailable && visibleSubset);
  const canAutoRename = Boolean(categoryAvailable && visibleSubset);
  if (!canReorderCategory && !canAutoRename) return NO_CATEGORY_CAPABILITIES;

  const orderedAssetIds = [...membershipIds];
  return {
    hasCompleteCategoryMembership: hasCompleteCategoryMembership(membershipIds, renderedAssetIds),
    canReorderCategory,
    canAutoRename,
    category: {
      categoryId: category.id,
      displayName: category.displayName,
      directorySlug: category.directorySlug,
      orderedAssetIds,
      orderedAssetIdsJson: JSON.stringify(orderedAssetIds),
    },
  };
}
