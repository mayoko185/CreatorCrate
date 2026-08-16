import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

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
  it('renders a minimal release-style model without project-only fields or mutation markup', () => {
    const html = renderComponents(minimalReleaseAsset);

    expect(html).toContain('<article class="asset-card"');
    expect(html).toContain('<article class="asset-list-card"');
    expect(html).toContain('PNG — preview not supported');
    expect(html).toContain('candidate &lt;final&gt;');
    expect(html).toContain('href="/projects/7/assets/73"');
    expect(html).not.toContain('<img ');
    expect(html).not.toContain('asset-card-tags');
    expect(html).not.toContain('asset-list-card-associations');
    expect(html).not.toContain('asset-list-card-identity');
    expect(html).not.toContain('asset-list-card-primary-metadata');
    expect(html).not.toContain('asset-list-card-associations-region');
    expect(html).not.toContain('Category</dt>');
    expect(html).not.toContain('Size</dt>');
    expect(html).not.toContain('Modified</dt>');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('method="post"');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('href=""');
    expect(html).not.toContain('src=""');
  });

  it('supports an opt-in grid filename link for release cards', () => {
    const html = renderComponents(minimalReleaseAsset);

    expect(html).toContain('<a class="asset-card-title-text asset-file-link" href="/projects/7/assets/73">candidate &lt;final&gt;</a>');
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
});
