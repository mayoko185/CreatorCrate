import { describe, it, expect } from 'vitest';
import {
  hasCompleteCategoryMembership,
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

  it('grants reorder and Auto Rename together from complete membership in rendered order', () => {
    const capabilities = resolveProjectAssetCategoryCapabilities({
      projectArchived: false,
      categoryMembership: membership([1, 2, 3]),
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
    ['archived project', { projectArchived: true, categoryMembership: membership([1, 2]), renderedAssetIds: [1, 2] }],
    ['unavailable category', {
      categoryMembership: membership([1, 2], { autoRenameAvailable: false }),
      renderedAssetIds: [1, 2],
    }],
    ['no concrete category', { categoryMembership: null, renderedAssetIds: [1, 2] }],
    ['subset rendered', { categoryMembership: membership([1, 2, 3]), renderedAssetIds: [1, 3] }],
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
