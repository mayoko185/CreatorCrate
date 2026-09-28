import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { buildReleaseAssetPresentation } from '../src/services/release-asset-presenter.js';
import { formatIsoTimestamp, formatSqliteTimestamp } from '../src/util/date.js';
import { projectImagePolicyFingerprint, projectImagePresentationPolicy } from '../src/services/project-image-policy.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

function renderComponents(asset) {
  return env.renderString(`
    {% import "partials/asset-presentation.njk" as presentation %}
    {{ presentation.gridCard(asset, { filenameLink: true }) }}
    {{ presentation.listCard(asset) }}
  `, { asset });
}

const minimalReleaseAsset = {
  id: 73,
  project_id: 7,
  filename: 'candidate <final>.png',
  displayFilename: 'candidate <final>',
  extension: 'png',
  typeLabel: 'PNG',
  is_present: true,
  presenceLabel: 'Present',
  preview: { kind: null },
  preview_state: 'unsupported',
  preview_url: null,
  thumbnail_url: null,
  previewAltText: 'Preview of candidate <final>.png',
  viewerUrl: '/projects/7/assets/73',
};

describe('reusable asset presentation macros', () => {
  it('changes both project derivative URL revisions with effective policy', () => {
    const asset = { id: 73, project_id: 7, is_present: true, extension: 'png',
      mime_type: 'image/png', relative_path: 'candidate.png', size_bytes: 1024,
      modified_at: '2026-09-24T10:00:00.000Z' };
    const policy = { thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'webp', webpQuality: 90, maxDimension: 1600 } };
    const before = buildAssetPreviewModel(asset, projectImagePolicyFingerprint(policy));
    const after = buildAssetPreviewModel(asset, projectImagePolicyFingerprint({
      ...policy, preview: { ...policy.preview, maxDimension: 800 },
    }));
    expect(after.revision).not.toBe(before.revision);
    expect(after.urls.thumbnail).not.toBe(before.urls.thumbnail);
    expect(after.urls.preview).not.toBe(before.urls.preview);
    expect(after.urls.thumbnail).toContain('/thumbnail?v=');
    expect(after.urls.preview).toContain('/preview?v=');
  });

  it('selects the normal preview resource by policy and original eligibility', () => {
    const asset = { id: 73, project_id: 7, is_present: true, extension: 'png',
      mime_type: 'image/png', relative_path: 'candidate.png', size_bytes: 1024,
      modified_at: '2026-09-24T10:00:00.000Z' };
    const base = { thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'webp', webpQuality: 90, maxDimension: 1600 } };
    const present = (source, format) => buildAssetPreviewModel(source,
      projectImagePresentationPolicy({ ...base, preview: { ...base.preview, format } }));
    const webp = present(asset, 'webp');
    const png = present(asset, 'png');
    const original = present(asset, 'original');

    expect(webp.urls.preview).toBe(`/projects/7/assets/73/preview?v=${webp.revision}`);
    expect(png.urls.preview).toBe(`/projects/7/assets/73/preview?v=${png.revision}`);
    expect(original.urls.preview).toBe('/projects/7/assets/73/original');
    expect(original.urls.preview).not.toContain('?v=');
    expect(original.urls.thumbnail).toBe(`/projects/7/assets/73/thumbnail?v=${original.revision}`);
    expect(webp.revision).not.toBe(png.revision);
    expect(original.revision).not.toBe(png.revision);
    expect(present(asset, 'png').urls.preview).toBe(png.urls.preview);

    for (const [extension, mime_type] of [
      ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
    ]) {
      expect(present({ ...asset, extension, mime_type }, 'original').urls.preview)
        .toBe('/projects/7/assets/73/original');
    }
    for (const extension of ['kra', 'krz']) {
      const krita = present({ ...asset, extension, mime_type: 'application/x-krita' }, 'original');
      expect(krita.urls.preview).toBe(`/projects/7/assets/73/preview?v=${krita.revision}`);
    }
    expect(present({ ...asset, mime_type: 'image/jpeg' }, 'original').urls.preview).toBeNull();
    expect(present({ ...asset, is_present: false }, 'original').urls.preview).toBeNull();
  });

  it('uses the same policy fingerprint regardless of property insertion order', () => {
    const first = { thumbnail: { format: 'png', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'original', webpQuality: 15, maxDimension: 320 } };
    const reordered = { preview: { maxDimension: 2560, webpQuality: 95, format: 'original' },
      thumbnail: { maxDimension: 256, webpQuality: 21, format: 'png' } };
    expect(projectImagePolicyFingerprint(first)).toBe(projectImagePolicyFingerprint(reordered));
  });
  it('keeps WebP and Original quality applicability for Krita sources', () => {
    const base = { thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'png', webpQuality: 40, maxDimension: 1600 } };
    for (const extension of ['kra', 'krz']) {
      const asset = { extension, source_animated: 0 };
      const changed = { ...base, preview: { ...base.preview, webpQuality: 70 } };
      expect(projectImagePolicyFingerprint(base, asset))
        .toBe(projectImagePolicyFingerprint(changed, asset));
      for (const format of ['webp', 'original']) {
        const first = { ...base, preview: { ...base.preview, format } };
        const second = { ...changed, preview: { ...changed.preview, format } };
        expect(projectImagePolicyFingerprint(first, asset) === projectImagePolicyFingerprint(second, asset))
          .toBe(format === 'original');
      }
    }
  });
  it('renders both minimal release cards with escaped identity, fallback, and viewer links', () => {
    const html = renderComponents(minimalReleaseAsset);

    expect(html).toContain('<article class="asset-card"');
    expect(html).toContain('<article class="asset-list-card"');
    expect((html.match(/PNG — preview not supported/g) || [])).toHaveLength(2);
    expect(html).toContain('candidate &lt;final&gt;');
    expect(html).toContain('<a class="asset-card-title-text asset-file-link" href="/projects/7/assets/73">candidate &lt;final&gt;</a>');
    expect(html).toMatch(/<a class="asset-file-link" href="\/projects\/7\/assets\/73">candidate &lt;final&gt;<\/a>/);
    expect(html).not.toContain('<img ');
    expect(html).not.toContain('asset-card-primary-metadata');
    expect(html).not.toContain('asset-list-card-primary-metadata');
    expect(html).not.toContain('asset-list-card-associations-region');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('href=""');
    expect(html).not.toContain('src=""');
    expect(html).toContain('asset-indicator--present');
    expect(html).toMatch(/aria-label="View details for candidate &lt;final&gt;\.png"\s+data-tooltip="View asset details"/);
    expect(html).not.toContain('asset-details-link--present');
    expect(html).not.toContain('asset-details-link--missing');
  });

  it('moves persisted presence onto an opt-in Details control without changing its destination', () => {
    const html = env.renderString(`
      {% import "partials/asset-presentation.njk" as presentation %}
      {{ presentation.gridCard(presentAsset, { cardClass: 'present-grid', detailsPresenceStatus: true }) }}
      {{ presentation.gridCard(missingAsset, { cardClass: 'missing-grid', detailsPresenceStatus: true }) }}
      {{ presentation.listCard(presentAsset, { cardClass: 'present-list', headerStatusDetails: true, detailsPresenceStatus: true }) }}
      {{ presentation.listCard(missingAsset, { cardClass: 'missing-list', headerStatusDetails: true, detailsPresenceStatus: true }) }}
    `, {
      presentAsset: minimalReleaseAsset,
      missingAsset: { ...minimalReleaseAsset, id: 74, is_present: false, viewerUrl: '/projects/7/assets/74' },
    });
    const presentGrid = html.match(/<article class="asset-card present-grid"[\s\S]*?<\/article>/)?.[0] ?? '';
    const missingGrid = html.match(/<article class="asset-card missing-grid"[\s\S]*?<\/article>/)?.[0] ?? '';
    const presentList = html.match(/<article class="asset-list-card present-list"[\s\S]*?<\/article>/)?.[0] ?? '';
    const missingList = html.match(/<article class="asset-list-card missing-list"[\s\S]*?<\/article>/)?.[0] ?? '';

    expect(presentGrid).not.toContain('class="asset-indicator');
    expect(missingGrid).not.toContain('class="asset-indicator');
    expect(presentGrid).toContain('class="asset-details-link asset-details-link--present asset-tooltip asset-tooltip--right" href="/projects/7/assets/73"');
    expect(presentGrid).toContain('aria-label="Asset details | File present"');
    expect(presentGrid).toContain('data-tooltip="Asset details | File present"');
    expect(missingGrid).toContain('class="asset-details-link asset-details-link--missing asset-tooltip asset-tooltip--right" href="/projects/7/assets/74"');
    expect(missingGrid).toContain('aria-label="Asset details | File missing!"');
    expect(missingGrid).toContain('data-tooltip="Asset details | File missing!"');
    expect(presentList).toContain('asset-indicator--present');
    expect(missingList).toContain('asset-indicator--missing');
    expect(presentList).toContain('asset-details-link--present');
    expect(missingList).toContain('asset-details-link--missing');
  });

  it('uses the normalized preview derivative and keeps list filename navigation', () => {
    const html = renderComponents({
      ...minimalReleaseAsset,
      preview_state: 'previewable',
      preview_url: '/projects/7/assets/73/preview?v=revision',
      thumbnail_url: '/projects/7/assets/73/thumbnail?v=revision',
    });

    expect((html.match(/src="\/projects\/7\/assets\/73\/preview\?v=revision"/g) || [])).toHaveLength(2);
    expect(html).not.toContain('src="/projects/7/assets/73/thumbnail?v=revision"');
    expect(html).toMatch(/<a class="asset-file-link" href="\/projects\/7\/assets\/73">candidate &lt;final&gt;<\/a>/);
    expect(html).toContain('class="asset-card-media-link" href="/projects/7/assets/73"');
    expect(html).toContain('class="asset-list-card-media-link" href="/projects/7/assets/73"');
  });

  it('adds project preview opt-in only when the caller supplies the asset ID', () => {
    const asset = {
      ...minimalReleaseAsset,
      preview_state: 'previewable',
      preview_url: '/projects/7/assets/73/preview?v=revision',
    };
    const html = env.renderString(`
      {% import "partials/asset-presentation.njk" as presentation %}
      {{ presentation.gridCard(asset, { previewSlideshowAssetId: asset.id }) }}
      {{ presentation.listCard(asset, { previewSlideshowAssetId: asset.id }) }}
    `, { asset });

    expect((html.match(/data-project-assets-preview-id="73"/g) || [])).toHaveLength(2);
    expect(html).toContain('class="asset-card-media-link" href="/projects/7/assets/73"');
    expect(html).toContain('class="asset-list-card-media-link" href="/projects/7/assets/73"');
    expect(renderComponents(asset)).not.toContain('data-project-assets-preview-id');
  });

  it('suppresses the complete grid body only when explicitly requested', () => {
    const html = env.renderString(`
      {% import "partials/asset-presentation.njk" as presentation %}
      {{ presentation.gridCard(asset, { cardClass: 'default-body' }) }}
      {% call(slot) presentation.gridCard(asset, { cardClass: 'hidden-body', hideBody: true }) %}
        {% if slot == 'title-row' %}<span data-title-row-slot>Title action</span>{% endif %}
        {% if slot == 'associations' %}<span data-associations-slot>Associations</span>{% endif %}
      {% endcall %}
    `, { asset: minimalReleaseAsset });
    const defaultCard = html.match(/<article class="asset-card default-body"[\s\S]*?<\/article>/)?.[0] ?? '';
    const hiddenCard = html.match(/<article class="asset-card hidden-body"[\s\S]*?<\/article>/)?.[0] ?? '';

    expect(defaultCard).toContain('class="asset-card-body"');
    expect(hiddenCard).not.toContain('class="asset-card-body"');
    expect(hiddenCard).not.toContain('data-title-row-slot');
    expect(hiddenCard).not.toContain('data-associations-slot');
    expect(hiddenCard).toContain('class="asset-card-top"');
    expect(hiddenCard).toContain('class="asset-card-media');
  });
});

describe('supported video presentation', () => {
  const videoEnv = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true })
    .addFilter('formatSqliteTimestamp', formatSqliteTimestamp)
    .addFilter('formatIsoTimestamp', formatIsoTimestamp);
  const policy = projectImagePresentationPolicy({
    thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
    preview: { format: 'original', webpQuality: 90, maxDimension: 1600 },
  });
  const videoSource = (overrides = {}) => ({
    id: 80, project_id: 7, is_present: true, relative_path: 'clips/clip.webm',
    filename: 'clip.webm', extension: 'webm', mime_type: 'video/webm',
    size_bytes: 4096, modified_at: '2026-09-24T10:00:00.000Z', ...overrides,
  });

  it.each([
    ['webm', 'video/webm'],
    ['mp4', 'video/mp4'],
  ])('gives %s a video state with the authenticated original as playback URL', (extension, mime_type) => {
    const model = buildAssetPreviewModel(videoSource({ extension, mime_type }), policy);
    expect(model).toEqual({
      state: 'video',
      previewable: false,
      kind: 'video',
      sourceMetadataValid: false,
      revision: null,
      urls: { thumbnail: null, preview: null },
      playbackUrl: '/projects/7/assets/80/original',
    });
  });

  it.each([
    ['mov', 'video/quicktime'],
    ['mkv', 'video/x-matroska'],
    ['avi', 'video/x-msvideo'],
    ['webm', 'video/mp4'],
    ['mp4', 'application/octet-stream'],
  ])('keeps %s (%s) on the unsupported fallback', (extension, mime_type) => {
    const model = buildAssetPreviewModel(videoSource({ extension, mime_type }), policy);
    expect(model.state).toBe('unsupported');
    expect(model.playbackUrl).toBeNull();
    expect(model.urls).toEqual({ thumbnail: null, preview: null });
  });

  it('keeps missing videos missing and image models free of playback URLs', () => {
    expect(buildAssetPreviewModel(videoSource({ is_present: false }), policy))
      .toMatchObject({ state: 'missing', playbackUrl: null });
    const image = buildAssetPreviewModel(videoSource({ extension: 'png', mime_type: 'image/png' }), policy);
    expect(image).toMatchObject({ state: 'previewable', kind: 'image', playbackUrl: null });
  });

  function videoCardAsset(overrides = {}) {
    const source = videoSource(overrides);
    const preview = buildAssetPreviewModel(source, policy);
    return {
      ...source,
      displayFilename: 'clip',
      typeLabel: source.extension.toUpperCase(),
      presenceLabel: 'Present',
      preview,
      preview_state: preview.state,
      preview_url: preview.urls.preview,
      thumbnail_url: preview.urls.thumbnail,
      viewerUrl: '/projects/7/assets/80?view=grid',
    };
  }

  // Inert metadata-only frame: intrinsic geometry, never controls/autoplay/play.
  const INERT_FRAME = /<video class="asset-video-frame-media" src="\/projects\/7\/assets\/80\/original"\s+preload="metadata" playsinline disablepictureinpicture aria-hidden="true" data-asset-video-frame><\/video>/g;

  it.each([
    ['webm', 'video/webm', 'WEBM'],
    ['mp4', 'video/mp4', 'MP4'],
  ])('renders Project Assets %s grid and list cards as on-page video preview triggers with selection intact', (extension, mime_type, label) => {
    const asset = videoCardAsset({ extension, mime_type, filename: `clip.${extension}` });
    const html = videoEnv.renderString(`
      {% import "partials/asset-presentation.njk" as presentation %}
      {{ presentation.gridCard(asset, { projectLayout: true, selectable: true, selectableTabIndex: true, previewSlideshowAssetId: asset.id }) }}
      {{ presentation.listCard(asset, { projectLayout: true, selectable: true, titleControls: true, previewSlideshowAssetId: asset.id }) }}
    `, { asset });

    expect(html).not.toMatch(/<img/);
    expect(html.match(INERT_FRAME)).toHaveLength(2);
    expect(html).not.toMatch(/autoplay|controls|tabindex="-1"/);
    // Videos never join the image slideshow or image preview enhancement.
    expect(html).not.toContain('data-project-assets-preview-id');
    expect(html).not.toContain('data-preview-enhancement');
    expect(html).not.toContain('data-preview-image');
    expect(html.match(/data-asset-video-preview-trigger data-video-src="\/projects\/7\/assets\/80\/original" data-video-title="clip"/g)).toHaveLength(2);
    expect(html).toContain(`<a class="asset-card-media-link asset-video-link" href="/projects/7/assets/80?view=grid" aria-label="Play video clip.${extension}"`);
    expect(html).toContain(`<a class="asset-list-card-media-link asset-video-link" href="/projects/7/assets/80?view=grid" aria-label="Play video clip.${extension}"`);
    // The static placeholder remains only as the hidden failure fallback.
    expect(html.match(/data-asset-video-placeholder hidden/g)).toHaveLength(2);
    expect(html.match(new RegExp(`${label} video`, 'g'))).toHaveLength(2);
    expect(html.match(/data-asset-selectable-card/g)).toHaveLength(2);
    expect(html).toContain(`aria-label="Toggle selection for clip.${extension}"`);
    expect(html).toContain(`View details for clip.${extension}`);
  });

  it('blurs NSFW video frames like NSFW image thumbnails', () => {
    const asset = videoCardAsset();
    const html = videoEnv.renderString(`
      {% import "partials/asset-presentation.njk" as presentation %}
      {{ presentation.gridCard(asset, { previewSlideshowAssetId: asset.id, nsfwBlur: true }) }}
    `, { asset });
    expect(html).toContain('class="asset-video-frame-media asset-image--nsfw-blurred"');
  });

  it('falls back to the visible static placeholder without a playback URL', () => {
    const asset = { ...videoCardAsset(), preview: { ...videoCardAsset().preview, playbackUrl: null } };
    const html = videoEnv.renderString(`
      {% import "partials/asset-presentation.njk" as presentation %}
      {{ presentation.gridCard(asset, { previewSlideshowAssetId: asset.id }) }}
    `, { asset });
    expect(html).not.toMatch(/<video/);
    expect(html).not.toContain('data-asset-video-preview-trigger');
    expect(html).toContain('asset-video-placeholder" data-asset-video-placeholder>');
  });

  it('renders release grid and list cards with inert frames that open the shared video preview', () => {
    for (const [extension, mime_type] of [['webm', 'video/webm'], ['mp4', 'video/mp4']]) {
      const asset = buildReleaseAssetPresentation({
        ...videoSource({ extension, mime_type, filename: `clip.${extension}` }),
        asset_id: 80, role: 'primary', sort_order: 0,
      }, { policyFingerprint: policy, selected: true });
      expect(asset).toMatchObject({
        preview_state: 'video', preview_url: null, thumbnail_url: null,
        previewAvailable: false, isPreviewable: false, hasThumbnail: false,
      });
      expect(asset.preview.playbackUrl).toBe('/projects/7/assets/80/original');

      const html = videoEnv.renderString(`
        {% import "partials/asset-presentation.njk" as presentation %}
        {{ presentation.gridCard(asset, { filenameLink: true }) }}
        {{ presentation.listCard(asset, { cardClass: 'asset-list-card--release', headerStatusDetails: true, hideActions: true }) }}
      `, { asset });
      expect(html).not.toMatch(/<img/);
      expect(html.match(INERT_FRAME)).toHaveLength(2);
      expect(html).not.toMatch(/autoplay|controls/);
      expect(html.match(/data-asset-video-preview-trigger data-video-src="\/projects\/7\/assets\/80\/original"/g)).toHaveLength(2);
      expect(html.match(new RegExp(`${extension.toUpperCase()} video`, 'g'))).toHaveLength(2);
      expect(html.match(/href="\/projects\/7\/assets\/80" aria-label="Play video clip\./g)).toHaveLength(2);
    }
  });

  it('renders release selection cards without links so clicks still toggle selection', () => {
    const asset = { ...videoCardAsset(), viewerUrl: null };
    const html = videoEnv.renderString(`
      {% import "partials/asset-presentation.njk" as presentation %}
      {{ presentation.gridCard(asset, { selectable: true }) }}
    `, { asset });
    expect(html).not.toContain('asset-video-link');
    expect(html.match(INERT_FRAME)).toHaveLength(1);
  });
});
