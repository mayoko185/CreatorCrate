import { describe, expect, it } from 'vitest';
import { buildSocialContent } from '../src/services/social-content-builder.js';

function release(overrides = {}) {
  return {
    id: 41,
    project_id: 7,
    title: 'August release',
    description: 'The release description is the body.',
    notes: 'Internal notes must never appear in prepared content.',
    ...overrides,
  };
}

function asset(overrides = {}) {
  return {
    asset_id: 1,
    project_id: 7,
    role: 'primary',
    sort_order: 0,
    relative_path: 'exports/cover.png',
    nested_path: 'exports',
    filename: 'cover.png',
    extension: 'png',
    mime_type: 'image/png',
    size_bytes: 1234,
    is_present: 1,
    ...overrides,
  };
}

function build(inputRelease = release(), rows = [asset()], platforms = ['patreon', 'x', 'bluesky']) {
  return buildSocialContent({ release: inputRelease, releaseAssets: rows, platforms });
}

describe('buildSocialContent', () => {
  it('uses release title and description to compose platform-effective content without leaking notes', () => {
    const content = build();

    expect(content.patreon).toMatchObject({
      title: 'August release',
      body: 'The release description is the body.',
    });
    expect(content.x).toMatchObject({
      title: 'August release',
      body: 'August release\n\nThe release description is the body.',
    });
    expect(content.bluesky).toMatchObject({
      title: 'August release',
      body: 'August release\n\nThe release description is the body.',
    });
    expect(JSON.stringify(content)).not.toContain('Internal notes must never appear in prepared content.');
  });

  it('includes every valid release role without changing release order', () => {
    const rows = [
      asset({ asset_id: 11, role: 'preview', sort_order: 8, filename: 'preview.jpg' }),
      asset({ asset_id: 12, role: 'attachment', sort_order: 2, filename: 'press-kit.zip' }),
      asset({ asset_id: 14, role: 'primary', sort_order: 0, filename: 'cover.png' }),
    ];
    const content = build(release(), rows);

    for (const platform of ['patreon', 'x', 'bluesky']) {
      expect(content[platform].includedAssets.map(({ assetId, role, sortOrder }) => ({ assetId, role, sortOrder })))
        .toEqual([
          { assetId: 11, role: 'preview', sortOrder: 8 },
          { assetId: 12, role: 'attachment', sortOrder: 2 },
          { assetId: 14, role: 'primary', sortOrder: 0 },
        ]);
      expect(content[platform].excludedAssets).toEqual([]);
    }
  });

  it('reports missing assets as blocking for every platform regardless of role', () => {
    const content = build(release(), [
      asset({ asset_id: 1, role: 'primary', is_present: 0 }),
      asset({ asset_id: 2, role: 'attachment', is_present: 0 }),
      asset({ asset_id: 3, role: 'preview', is_present: 0 }),
    ]);

    for (const platform of ['patreon', 'x', 'bluesky']) {
      expect(content[platform].issues).toEqual([
        { code: 'asset_missing', severity: 'blocking', assetId: 1 },
        { code: 'asset_missing', severity: 'blocking', assetId: 2 },
        { code: 'asset_missing', severity: 'blocking', assetId: 3 },
      ]);
    }
  });

  it('keeps X and Bluesky effective post text valid when Description is empty', () => {
    const content = build(release({ description: '' }));

    expect(content.patreon.body).toBe('');
    expect(content.x.body).toBe('August release');
    expect(content.bluesky.body).toBe('August release');
    for (const platform of [content.patreon, content.x, content.bluesky]) {
      expect(platform.issues).toEqual([{ code: 'body_empty', severity: 'warning' }]);
      expect(platform.issues.some((issue) => issue.severity === 'blocking')).toBe(false);
    }
  });

  it('builds only the requested platforms', () => {
    const content = build(release(), [asset()], ['x']);

    expect(content).toEqual({
      x: expect.objectContaining({
        title: 'August release',
        body: 'August release\n\nThe release description is the body.',
      }),
    });
  });

  it('rejects unknown platforms', () => {
    expect(() => build(release(), [asset()], ['mastodon'])).toThrow(
      'Unsupported social content platform: mastodon',
    );
  });

  it('normalizes equivalent live and session-snapshot rows into identical content', () => {
    const liveRow = asset({
      asset_id: 99,
      project_id: 7,
      role: 'preview',
      sort_order: 5,
      relative_path: 'nested/preview.webp',
      nested_path: 'nested',
      filename: 'preview.webp',
      extension: 'webp',
      mime_type: 'image/webp',
      size_bytes: 800,
      is_present: 1,
    });
    const snapshotRow = {
      assetId: 99,
      projectId: 7,
      role: 'preview',
      sortOrder: 5,
      relativePath: 'nested/preview.webp',
      nestedPath: 'nested',
      filename: 'preview.webp',
      extension: 'webp',
      mimeType: 'image/webp',
      sizeBytes: 800,
      isPresent: 1,
    };

    expect(build(release(), [liveRow])).toEqual(
      buildSocialContent({
        release: release(),
        releaseAssets: [snapshotRow],
        platforms: ['patreon', 'x', 'bluesky'],
      }),
    );
  });
});
