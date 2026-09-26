import { describe, expect, it } from 'vitest';
import {
  buildReleaseAssetPagePresentation,
  buildReleaseAssetPresentation,
} from '../src/services/release-asset-presenter.js';
import { formatLocalDate, formatLocalTime } from '../src/util/date.js';
import { projectImagePresentationPolicy } from '../src/services/project-image-policy.js';

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
  it('uses source animation for Preview-PNG revision identity', () => {
    const base = { thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'png', webpQuality: 52, maxDimension: 1600 } };
    const changed = { ...base, preview: { ...base.preview, webpQuality: 71 } };
    for (const [sourceAnimated, same] of [[0, true], [1, false]]) {
      const row = assetRow({ extension: 'webp', mime_type: 'image/webp', source_animated: sourceAnimated });
      const before = buildReleaseAssetPresentation(row,
        { policyFingerprint: projectImagePresentationPolicy(base) });
      const after = buildReleaseAssetPresentation(row,
        { policyFingerprint: projectImagePresentationPolicy(changed) });
      expect(before.preview_revision === after.preview_revision).toBe(same);
    }
  });
  it('uses the shared Original selection for selected and candidate assets', () => {
    const policyFingerprint = projectImagePresentationPolicy({
      thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'original', webpQuality: 90, maxDimension: 1600 },
    });
    const selected = assetRow();
    const candidate = assetRow({ id: 18, asset_id: undefined });
    const page = buildReleaseAssetPagePresentation({
      selectedAssets: [selected], candidateAssets: [candidate], policyFingerprint,
    });
    expect(page.selected[0].preview_url).toBe('/projects/7/assets/17/original');
    expect(page.candidates[0].preview_url).toBe('/projects/7/assets/18/original');
    expect(page.selected[0].thumbnail_url).toContain('/thumbnail?v=');
  });

  it('uses the selected local clock format without changing the raw modification time', () => {
    const modifiedDate = new Date(2026, 7, 1, 13, 5);
    const row = assetRow({ modified_at: modifiedDate.toISOString() });
    const twelveHour = buildReleaseAssetPagePresentation({
      selectedAssets: [row],
      clockFormat: '12h',
    }).selected[0];
    const twentyFourHour = buildReleaseAssetPagePresentation({
      selectedAssets: [row],
      clockFormat: '24h',
    }).selected[0];

    expect(twelveHour.formattedModified).toBe(`${formatLocalDate(modifiedDate)} ${formatLocalTime(modifiedDate, '12h')}`);
    expect(twentyFourHour.formattedModified).toBe(`${formatLocalDate(modifiedDate)} ${formatLocalTime(modifiedDate, '24h')}`);
    expect(twelveHour.modified_at).toBe(row.modified_at);
    expect(twentyFourHour.modified_at).toBe(row.modified_at);
  });

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
      formattedModified: expect.any(String),
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
    expect(view.formattedModified).not.toBe('—');
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
      role: 'attachment',
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
      releaseContext: { selected: true, role: 'attachment', sortOrder: 9 },
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
      formattedModified: '—',
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
