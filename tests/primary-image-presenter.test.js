import { describe, expect, it } from 'vitest';
import {
  buildEmptyPrimaryImageModel,
  buildPrimaryImageModelForAsset,
} from '../src/services/primary-image-presenter.js';

function primaryImageAsset(overrides = {}) {
  return {
    id: 73,
    project_id: 45,
    relative_path: 'covers/cover.png',
    filename: 'cover.png',
    extension: 'png',
    mime_type: 'image/png',
    size_bytes: 2048,
    modified_at: '2026-08-02T12:00:00.000Z',
    is_present: 1,
    ...overrides,
  };
}

describe('primary-image-presenter', () => {
  it('builds the stable none model without a selection', () => {
    expect(buildEmptyPrimaryImageModel()).toEqual({
      selectedAssetId: null,
      provenance: null,
      state: 'none',
      kind: null,
      mediaModifier: null,
      previewUrl: null,
      thumbnailUrl: null,
      revision: null,
      alt: null,
    });
    expect(buildPrimaryImageModelForAsset(null, primaryImageAsset())).toEqual(
      buildEmptyPrimaryImageModel(),
    );
  });

  it('builds an available model with versioned preview URLs and supplied provenance', () => {
    const model = buildPrimaryImageModelForAsset(
      { asset_id: 73, provenance: 'automatic' },
      primaryImageAsset(),
    );

    expect(model).toMatchObject({
      selectedAssetId: 73,
      provenance: 'automatic',
      state: 'available',
      kind: 'image',
      mediaModifier: null,
      revision: expect.any(String),
      alt: 'Preview of cover.png',
    });
    expect(model.previewUrl).toBe(
      `/projects/45/assets/73/preview?v=${model.revision}`,
    );
    expect(model.thumbnailUrl).toBe(
      `/projects/45/assets/73/thumbnail?v=${model.revision}`,
    );
  });

  it('keeps a selected missing asset unavailable while retaining its presentation fields', () => {
    expect(buildPrimaryImageModelForAsset(
      { asset_id: 73, provenance: 'manual' },
      primaryImageAsset({ is_present: 0, filename: 'missing.png' }),
    )).toEqual({
      selectedAssetId: 73,
      provenance: 'manual',
      state: 'unavailable',
      kind: 'image',
      mediaModifier: null,
      previewUrl: null,
      thumbnailUrl: null,
      revision: null,
      alt: 'Preview of missing.png',
    });
  });

  it('accepts a book-style null provenance without project ownership assumptions', () => {
    const model = buildPrimaryImageModelForAsset(
      { asset_id: 73, provenance: null },
      primaryImageAsset({ project_id: 99 }),
    );

    expect(model).toMatchObject({
      selectedAssetId: 73,
      provenance: null,
      state: 'available',
      kind: 'image',
      mediaModifier: null,
      alt: 'Preview of cover.png',
    });
    expect(model.previewUrl).toBe(`/projects/99/assets/73/preview?v=${model.revision}`);
  });
});
