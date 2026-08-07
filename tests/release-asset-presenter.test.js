import { describe, expect, it } from 'vitest';
import {
  buildReleaseAssetPagePresentation,
  buildReleaseAssetPresentation,
} from '../src/services/release-asset-presenter.js';

function assetRow(overrides = {}) {
  return {
    id: 17,
    asset_id: 17,
    project_id: 7,
    category_id: null,
    relative_path: 'renders/cover.png',
    nested_path: 'renders',
    filename: 'cover.png',
    extension: 'png',
    mime_type: 'image/png',
    size_bytes: 2048,
    modified_at: '2026-08-01 10:00:00',
    is_present: 1,
    role: 'attachment',
    sort_order: 0,
    ...overrides,
  };
}

describe('release asset presenter', () => {
  it('normalizes a selected asset with a preview without mutating its source row', () => {
    const row = assetRow({
      asset_id: 31,
      relative_path: 'renders/cover image & "final".png',
      filename: 'cover image & "final".png',
      role: 'primary',
      sort_order: 4,
    });
    const before = structuredClone(row);

    const view = buildReleaseAssetPresentation(row, { selected: true });

    expect(view).toMatchObject({
      id: 31,
      project_id: 7,
      relative_path: 'renders/cover image & "final".png',
      filename: 'cover image & "final".png',
      displayFilename: 'cover image & "final"',
      locationLabel: 'renders',
      typeLabel: 'PNG',
      formattedSize: '2.0 KB',
      presence_state: 'present',
      presenceLabel: 'Present',
      viewerUrl: '/projects/7/assets/31',
      original_url: '/projects/7/assets/31/original',
      preview_state: 'previewable',
      previewAvailable: true,
      hasThumbnail: true,
      releaseContext: { selected: true, role: 'primary', sortOrder: 4 },
    });
    expect(view.preview.kind).toBe('image');
    expect(view.preview_url).toContain('/projects/7/assets/31/preview?');
    expect(view.thumbnail_url).toContain('/projects/7/assets/31/thumbnail?');
    expect(new URL(view.preview_url, 'https://creatorcrate.test').searchParams.get('v')).toBeTruthy();
    expect(view.viewerUrl).not.toContain(row.filename);
    expect(view.viewerUrl).not.toContain(row.relative_path);
    expect(view).not.toHaveProperty('action');
    expect(row).toEqual(before);
  });

  it('normalizes a selected missing asset without exposing preview URLs', () => {
    const view = buildReleaseAssetPresentation(assetRow({
      asset_id: 32,
      is_present: 0,
      role: 'source',
      sort_order: 9,
    }), { selected: true });

    expect(view).toMatchObject({
      id: 32,
      is_present: 0,
      presence_state: 'missing',
      presenceLabel: 'Missing at last scan',
      preview_state: 'missing',
      previewAvailable: false,
      hasThumbnail: false,
      thumbnail_url: null,
      preview_url: null,
      original_url: null,
      releaseContext: { selected: true, role: 'source', sortOrder: 9 },
    });
  });

  it('normalizes an unselected project asset with the same visual fields and no release action state', () => {
    const row = assetRow({
      id: 33,
      asset_id: undefined,
      relative_path: 'notes/read me & <draft>.txt',
      nested_path: 'notes',
      filename: 'read me & <draft>.txt',
      extension: 'txt',
      mime_type: 'text/plain',
      size_bytes: undefined,
      modified_at: undefined,
    });

    const view = buildReleaseAssetPresentation(row);

    for (const field of [
      'id', 'project_id', 'relative_path', 'filename', 'displayFilename', 'typeLabel',
      'presenceLabel', 'viewerUrl', 'preview', 'previewAvailable', 'releaseContext',
    ]) {
      expect(view).toHaveProperty(field);
    }
    expect(view).toMatchObject({
      id: 33,
      displayFilename: 'read me & <draft>',
      locationLabel: 'notes',
      typeLabel: 'TXT',
      formattedSize: null,
      preview_state: 'unsupported',
      previewAvailable: false,
      releaseContext: { selected: false, role: null, sortOrder: null },
    });
    expect(view.filename).toContain('& <draft>');
    expect(view.relative_path).toContain('& <draft>');
    expect(view.viewerUrl).not.toContain(view.filename);
    expect(view.viewerUrl).not.toContain(view.relative_path);
  });

  it('merges the filtered project page with explicit selected state', () => {
    const selectedRow = assetRow({ id: undefined, asset_id: 41, role: 'preview', sort_order: 0 });
    const unselectedRow = assetRow({ id: 43, asset_id: undefined, filename: 'other.txt' });
    const result = buildReleaseAssetPagePresentation({
      selectedAssets: [selectedRow],
      assets: [unselectedRow, { ...selectedRow, id: 41 }],
      candidateAssets: [unselectedRow],
    });

    expect(result.assets.map((asset) => asset.id)).toEqual([43, 41]);
    expect(result.assets.map((asset) => asset.releaseContext.selected)).toEqual([false, true]);
    expect(result.assets[1].releaseContext).toEqual({ selected: true, role: 'preview', sortOrder: 0 });
    expect(result.selected.map((asset) => asset.id)).toEqual([41]);
    expect(result.candidates.map((asset) => asset.id)).toEqual([43]);
  });

  it('preserves selected and project-page identity and source ordering in the compatibility aliases', () => {
    const result = buildReleaseAssetPagePresentation({
      selectedAssets: [
        assetRow({ asset_id: 41, role: 'preview', sort_order: 7 }),
        assetRow({ asset_id: 42, role: 'primary', sort_order: 2 }),
      ],
      candidateAssets: [
        assetRow({ id: 43, asset_id: undefined }),
        assetRow({ id: 44, asset_id: undefined }),
      ],
    });

    expect(result.selected.map((asset) => asset.id)).toEqual([41, 42]);
    expect(result.selected.map((asset) => asset.releaseContext)).toEqual([
      { selected: true, role: 'preview', sortOrder: 7 },
      { selected: true, role: 'primary', sortOrder: 2 },
    ]);
    expect(result.candidates.map((asset) => asset.id)).toEqual([43, 44]);
    expect(result.candidates.every((asset) => asset.releaseContext.selected === false)).toBe(true);
    expect(result.assets.map((asset) => asset.id)).toEqual([41, 42, 43, 44]);
  });

  it('URL-encodes unsafe path identifiers while keeping preview URLs revisioned', () => {
    const encoded = buildReleaseAssetPresentation(assetRow({
      id: 'asset/45',
      asset_id: 'asset/45',
      project_id: 'project/8',
    }));

    expect(encoded.viewerUrl).toBe('/projects/project%2F8/assets/asset%2F45');
    expect(encoded.preview_url).toBeNull();
    expect(encoded.thumbnail_url).toBeNull();
  });
});
