import { describe, it, expect } from 'vitest';
import {
  hasCompleteCategoryMembership,
  isVisibleCategorySubset,
  noProjectAssetCategoryCapabilities,
  resolveProjectAssetCategoryCapabilities,
} from '../src/services/project-asset-category-capabilities.js';

const membership = (orderedAssetIds, overrides = {}) => ({
  effectiveCategory: { id: 7, displayName: 'Renders', directorySlug: 'renders', enabled: true },
  orderedAssetIds,
  total: orderedAssetIds.length,
  autoRenameAvailable: orderedAssetIds.length > 0,
  ...overrides,
});

describe('project asset category capabilities', () => {
  it.each([
    ['same order', [1, 2, 3], [1, 2, 3], true],
    ['any permutation', [1, 2, 3], [3, 1, 2], true],
    ['omitted asset', [1, 2, 3], [1, 2], false],
    ['duplicated asset', [1, 2, 3], [1, 2, 2], false],
    ['extra asset', [1, 2, 3], [1, 2, 3, 4], false],
    ['outside asset replacing a member', [1, 2, 3], [1, 2, 9], false],
    ['empty category', [], [], false],
  ])('complete membership: %s', (_label, membershipIds, renderedIds, expected) => {
    expect(hasCompleteCategoryMembership(membershipIds, renderedIds)).toBe(expected);
  });

  it.each([
    ['complete membership', [1, 2, 3], [1, 2, 3], true],
    ['ordered subset', [1, 2, 3, 4], [1, 3], true],
    ['single visible asset', [1, 2, 3], [2], true],
    ['permuted subset', [1, 2, 3], [3, 1], true],
    ['empty visible result', [1, 2, 3], [], false],
    ['duplicated visible asset', [1, 2, 3], [1, 1], false],
    ['outside visible asset', [1, 2, 3], [1, 9], false],
    ['more visible than members', [1, 2], [1, 2, 3], false],
    ['empty category', [], [1], false],
  ])('visible category subset: %s', (_label, membershipIds, renderedIds, expected) => {
    expect(isVisibleCategorySubset(membershipIds, renderedIds)).toBe(expected);
  });

  it('grants reorder and Auto Rename for complete membership with the authoritative full order', () => {
    const capabilities = resolveProjectAssetCategoryCapabilities({
      projectArchived: false,
      categoryMembership: membership([2, 3, 1]),
      renderedAssetIds: [2, 3, 1],
    });

    expect(capabilities).toEqual({
      hasCompleteCategoryMembership: true,
      canReorderCategory: true,
      canAutoRename: true,
      category: {
        categoryId: 7,
        displayName: 'Renders',
        directorySlug: 'renders',
        orderedAssetIds: [2, 3, 1],
        orderedAssetIdsJson: '[2,3,1]',
      },
    });
  });

  it.each([
    ['filtered subset', [1, 3]],
    ['current page of a paginated category', [1, 2]],
    ['single visible asset', [4]],
  ])('grants reorder and Auto Rename for a nonempty %s without claiming complete membership', (_label, renderedAssetIds) => {
    const capabilities = resolveProjectAssetCategoryCapabilities({
      projectArchived: false,
      categoryMembership: membership([1, 2, 3, 4]),
      renderedAssetIds,
    });

    expect(capabilities).toEqual({
      hasCompleteCategoryMembership: false,
      canReorderCategory: true,
      canAutoRename: true,
      category: {
        categoryId: 7,
        displayName: 'Renders',
        directorySlug: 'renders',
        orderedAssetIds: [1, 2, 3, 4],
        orderedAssetIdsJson: '[1,2,3,4]',
      },
    });
  });

  it('exposes hidden and off-page members exactly once in the full order', () => {
    const fullOrder = [40, 10, 30, 20, 50];
    const { category } = resolveProjectAssetCategoryCapabilities({
      categoryMembership: membership(fullOrder),
      renderedAssetIds: [30, 40],
    });

    expect(category.orderedAssetIds).toEqual(fullOrder);
    expect(new Set(category.orderedAssetIds).size).toBe(fullOrder.length);
    expect(JSON.parse(category.orderedAssetIdsJson)).toEqual(fullOrder);
    expect(category.orderedAssetIds).not.toBe(fullOrder);
  });

  it.each([
    ['archived project', { projectArchived: true, categoryMembership: membership([1, 2]), renderedAssetIds: [1, 2] }],
    ['unavailable category', {
      categoryMembership: membership([1, 2], { autoRenameAvailable: false }),
      renderedAssetIds: [1, 2],
    }],
    ['disabled category', {
      categoryMembership: membership([1, 2], {
        effectiveCategory: { id: 7, displayName: 'Renders', directorySlug: 'renders', enabled: false },
      }),
      renderedAssetIds: [1],
    }],
    ['archived project with a filtered subset', {
      projectArchived: true, categoryMembership: membership([1, 2, 3]), renderedAssetIds: [1],
    }],
    ['no concrete category', { categoryMembership: null, renderedAssetIds: [1, 2] }],
    ['empty category', { categoryMembership: membership([]), renderedAssetIds: [] }],
    ['empty visible result', { categoryMembership: membership([1, 2, 3]), renderedAssetIds: [] }],
    ['out-of-category visible asset', { categoryMembership: membership([1, 2, 3]), renderedAssetIds: [1, 9] }],
    ['duplicate visible asset', { categoryMembership: membership([1, 2, 3]), renderedAssetIds: [2, 2] }],
    ['invalid duplicate membership', { categoryMembership: membership([1, 1, 2]), renderedAssetIds: [1] }],
    ['invalid membership ids', { categoryMembership: membership([1, '2']), renderedAssetIds: [1] }],
  ])('denies every capability for %s', (_label, input) => {
    expect(resolveProjectAssetCategoryCapabilities(input)).toEqual(noProjectAssetCategoryCapabilities());
  });

  it.each(['sort', 'order'])('rejects presentation-only input %s', (key) => {
    expect(() => resolveProjectAssetCategoryCapabilities({
      categoryMembership: membership([1]),
      renderedAssetIds: [1],
      [key]: 'modified',
    })).toThrow(TypeError);
  });
});
