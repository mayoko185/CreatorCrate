import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { createProjectImageSettingsService } from '../src/services/project-image-settings-service.js';

const env = nunjucks.configure(fileURLToPath(new URL('../src/views', import.meta.url)), { autoescape: true, noCache: true });
const source = (extension = 'cbz', overrides = {}) => ({ id: 7, project_id: 3, filename: `book.${extension}`,
  relative_path: `book.${extension}`, extension, is_present: 1, size_bytes: 100, modified_at: '2026-01-01T00:00:00.000Z', ...overrides });
function present(row) {
  const preview = buildAssetPreviewModel(row);
  return { ...row, preview, preview_state: preview.state, preview_url: preview.urls.preview,
    thumbnail_url: preview.urls.thumbnail, typeLabel: row.extension.toUpperCase(), viewerUrl: '/projects/3/assets/7?view=grid' };
}
const render = (row) => env.renderString(`{% import 'partials/asset-presentation.njk' as p %}
  {{ p.gridCard(asset, { nsfwBlur: true, selectable: true, filenameLink: true, comicCover: true, comicTrigger: 'data-test-comic-trigger', viewerTrigger: 'data-test-image-trigger' }) }}
  {{ p.listCard(asset, { nsfwBlur: true, selectable: true, comicCover: true, comicTrigger: 'data-test-comic-trigger', viewerTrigger: 'data-test-image-trigger' }) }}`, { asset: present(row) });

describe('shared native comic cover presentation', () => {
  it.each(['cbz', 'cbr', 'cb7', 'CBZ'])('authors a current-source %s descriptor without opening an archive', (extension) => {
    const row = source(extension, { relative_path: 'does-not-exist/untrusted-member.png' });
    const model = buildAssetPreviewModel(row);
    expect(model).toMatchObject({ state: 'unsupported', kind: null, previewable: false });
    expect(model.imageSources).toBeUndefined();
    expect(model.urls).toEqual({ thumbnail: null, preview: null });
    expect(model.comic).toEqual({ format: extension.toLowerCase(),
      sourceRevision: model.comic.sourceRevision,
      cover: { revisionHint: model.comic.cover.revisionHint, urls: {
        preview: `/projects/3/assets/7/preview?v=${model.comic.cover.revisionHint}`,
        thumbnail: `/projects/3/assets/7/thumbnail?v=${model.comic.cover.revisionHint}`,
      } } });
    expect(model.comic.cover.revisionHint).toMatch(/^[a-f0-9]{16}$/);
    expect(model.comic).not.toHaveProperty('thumbnail');
  });
  it.each([{ is_present: 0 }, { modified_at: null }, { project_id: null }, { id: '../evil' }, { id: 0 }])('withholds actionable URLs for ineligible metadata %j', (overrides) => {
    expect(buildAssetPreviewModel(source('cbz', overrides)).comic.cover).toEqual({ revisionHint: null, urls: { preview: null, thumbnail: null } });
  });
  it('binds project, asset and source hints independently of image policy', () => {
    const first = buildAssetPreviewModel(source());
    expect(buildAssetPreviewModel(source(), 'policy').comic).toEqual(first.comic);
    const next = buildAssetPreviewModel(source('cbr', { project_id: 4, id: 9, source_generation: 2 }));
    expect(next.comic.cover.urls.preview).toMatch(/^\/projects\/4\/assets\/9\/preview\?v=[a-f0-9]{16}$/);
    expect(next.comic.sourceRevision).not.toBe(first.comic.sourceRevision);
  });
  it.each(['png', 'mp4', 'zip'])('does not give %s a comic descriptor', (extension) => {
    const mime_type = { png: 'image/png', mp4: 'video/mp4', zip: 'application/zip' }[extension];
    const model = buildAssetPreviewModel(source(extension, { mime_type }));
    expect(model.comic).toBeNull();
    expect(model.state).toBe({ png: 'previewable', mp4: 'video', zip: 'unsupported' }[extension]);
  });
  it.each(['cbz', 'cbr', 'cb7'])('renders shared %s Grid/List media without extra controls', (extension) => {
    const html = render(source(extension));
    expect(html.match(/data-test-comic-trigger/g)).toHaveLength(4);
    expect(html.match(/data-preview-image/g)).toHaveLength(2);
    expect(html.match(/data-preview-enhancement/g)).toHaveLength(2);
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
    expect(html.match(/decoding="async"/g)).toHaveLength(2);
    expect(html).not.toMatch(/data-test-image-trigger|data-comic-thumbnail|asset-comic-|CB[ZR7] comic/);
    expect(html).toContain('asset-card-thumb asset-image--nsfw-blurred');
    expect(html).toContain('asset-list-card-media-image asset-image--nsfw-blurred');
    expect(html).toContain(`alt="Preview of book.${extension}"`);
    expect(html).toContain('data-comic-details-url="/projects/3/assets/7?view=grid"');
    expect(html).toContain(`aria-label="Read comic book.${extension}"`);
    expect(html.match(/data-asset-selectable-card/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button|aria-live|<img[^>]+tabindex/);
    expect(html.match(/data-preview-fallback hidden/g)).toHaveLength(2);
  });
  it('escapes filenames, Reader attributes and existing Details links', () => {
    const html = render(source('cbz', { filename: '"<img onerror=alert(1)>.cbz' }));
    expect(html).not.toContain('<img onerror='); expect(html).toContain('&lt;img');
    expect(html).toContain('data-comic-project="3"');
    expect(html).toContain('data-comic-filename="&quot;&lt;img onerror=alert(1)&gt;.cbz"');
    expect(html).toContain('asset-details-link');
  });
  it('keeps a quiet comic fallback without a host reader trigger', () => {
    const html = env.renderString(`{% import 'partials/asset-presentation.njk' as p %}{{ p.gridCard(asset) }}`, { asset: present(source()) });
    expect(html).not.toContain('data-comic-thumbnail=');
    expect(html).toContain('CBZ — preview not supported');
  });
  it('binds effective policy changes without confusing reader hints with derivative revisions', () => {
    const stored = new Map();
    const settings = createProjectImageSettingsService({ appMetaRepository: {
      getValue: key => stored.get(key), setValue: (key, value) => stored.set(key, value),
    } });
    const build = () => buildAssetPreviewModel(source(), settings.getPresentationPolicy()).comic;
    let previous = build();
    for (const [key, value] of [['format', 'png'], ['max_dimension', '2048'], ['format', 'webp'], ['webp_quality', '45']]) {
      stored.set(`images.preview.${key}`, value);
      const current = build();
      expect(current.cover.revisionHint).toMatch(/^[a-f0-9]{16}$/);
      expect(current.cover.revisionHint).not.toBe(previous.cover.revisionHint);
      expect(current.sourceRevision).toBe(previous.sourceRevision);
      expect(current.cover.urls.preview).toBe(`/projects/3/assets/7/preview?v=${current.cover.revisionHint}`);
      previous = current;
    }
  });
  it('keeps ordinary card Preview precedence and accessible comic naming', () => {
    const image = source('png', { mime_type: 'image/png' });
    const model = buildAssetPreviewModel(image);
    expect(model.urls.preview).toMatch(/^\/projects\/3\/assets\/7\/preview\?v=[a-f0-9]{16}$/);
    expect(model.urls.thumbnail).toMatch(/\/thumbnail\?v=/);
    const html = render(source());
    expect(html).toContain('aria-label="Read comic book.cbz"');
    expect(html).toContain('/preview');
    expect(html).not.toContain('/comic/thumbnail');
  });

  it('uses the actual image branches without changing classification or slideshow membership', () => {
    const row = source();
    const asset = present(row);
    const html = env.renderString(`{% import 'partials/asset-presentation.njk' as p %}
      {{ p.gridCard(asset, { comicCover: true, comicTrigger: 'data-test-comic-trigger', previewSlideshowAssetId: asset.id, nsfwBlur: true }) }}
      {{ p.listCard(asset, { comicCover: true, comicTrigger: 'data-test-comic-trigger', previewSlideshowAssetId: asset.id, nsfwBlur: true }) }}`, { asset });
    expect(asset.preview).toMatchObject({ state: 'unsupported', previewable: false, kind: null, urls: { preview: null, thumbnail: null } });
    expect(asset.preview.imageSources).toBeUndefined();
    expect(asset.preview.comic.cover.revisionHint).not.toBe(asset.preview.comic.sourceRevision);
    expect(html.match(/data-preview-image/g)).toHaveLength(2);
    expect(html.match(/data-preview-enhancement/g)).toHaveLength(2);
    expect(html.match(/data-test-comic-trigger/g)).toHaveLength(4);
    expect(html).toContain('asset-card-thumb asset-image--nsfw-blurred');
    expect(html).toContain('asset-list-card-media-image asset-image--nsfw-blurred');
    expect(html).not.toMatch(/asset-comic-thumbnail|data-comic-thumbnail|CBZ comic|data-project-assets-preview-id/);
    expect(render(row)).not.toMatch(/data-comic-thumbnail|asset-comic-thumbnail/);
  });

  it('changes only the presentation hint on effective cover policy changes and source hints on reindex', () => {
    const policy = fingerprint => ({ comicCoverFingerprint: fingerprint });
    const before = buildAssetPreviewModel(source(), policy('a'.repeat(16))).comic;
    const changedPolicy = buildAssetPreviewModel(source(), policy('b'.repeat(16))).comic;
    const changedSource = buildAssetPreviewModel(source('cbz', { source_generation: 1 }), policy('a'.repeat(16))).comic;
    expect(changedPolicy.sourceRevision).toBe(before.sourceRevision);
    expect(changedPolicy.cover.urls.preview).not.toBe(before.cover.urls.preview);
    expect(changedSource.sourceRevision).not.toBe(before.sourceRevision);
    expect(changedSource.cover.urls.preview).not.toBe(before.cover.urls.preview);
    expect(changedPolicy).not.toHaveProperty('thumbnail');
  });

  it('changes the native cover URL on canonical format reclassification without changing the Reader hint', () => {
    const row = source();
    const policy = { comicCoverFingerprint: 'a'.repeat(16) };
    const comics = ['cbz', 'cbr', 'cb7'].map(extension => buildAssetPreviewModel({ ...row, extension }, policy).comic);
    expect(new Set(comics.map(comic => comic.sourceRevision)).size).toBe(1);
    expect(new Set(comics.map(comic => comic.cover.urls.preview)).size).toBe(3);
    expect(buildAssetPreviewModel({ ...row, extension: 'CBZ' }, policy).comic.cover).toEqual(comics[0].cover);
    expect(buildAssetPreviewModel(row, policy).comic.cover).toEqual(comics[0].cover);
  });
});
