import { describe, it, expect } from 'vitest';
import {
  classifyComicAsset,
  classifySupportedVideo,
  deriveExtensionFromFilename,
  mimeFromExtension,
} from '../src/services/asset-metadata.js';
import { classifyPreviewable } from '../src/services/preview-service.js';
import { inlineMimeFor } from '../src/services/media-service.js';
import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import {
  isSupportedConversionSource,
  WATERMARK_SOURCE_IMAGE_EXTENSIONS,
} from '../src/services/asset-processing-contracts.js';
import { ARCHIVE_SOURCE_IMAGE_EXTENSIONS } from '../src/services/archive-processing.js';

describe('asset metadata', () => {
  it('maps WebM and MP4 through the shared extension map, including uppercase filenames', () => {
    expect(mimeFromExtension(deriveExtensionFromFilename('clip.webm'))).toBe('video/webm');
    expect(mimeFromExtension(deriveExtensionFromFilename('clip.mp4'))).toBe('video/mp4');
    expect(mimeFromExtension(deriveExtensionFromFilename('CLIP.WEBM'))).toBe('video/webm');
    expect(mimeFromExtension(deriveExtensionFromFilename('CLIP.MP4'))).toBe('video/mp4');
  });

  it('keeps other video containers unmapped', () => {
    for (const ext of ['mov', 'mkv', 'avi', 'm4v', 'ogv', 'ogg']) {
      expect(mimeFromExtension(ext)).toBe('application/octet-stream');
    }
  });

  it('keeps existing image and Krita mappings', () => {
    expect(mimeFromExtension('png')).toBe('image/png');
    expect(mimeFromExtension('jpg')).toBe('image/jpeg');
    expect(mimeFromExtension('webp')).toBe('image/webp');
    expect(mimeFromExtension('gif')).toBe('image/gif');
    expect(mimeFromExtension('kra')).toBe('application/x-krita');
    expect(mimeFromExtension('krz')).toBe('application/x-krita');
  });
});

describe('classifySupportedVideo', () => {
  it('accepts WebM and MP4 only when extension and MIME agree', () => {
    expect(classifySupportedVideo({ extension: 'webm', mime_type: 'video/webm' }).supported).toBe(true);
    expect(classifySupportedVideo({ extension: 'mp4', mime_type: 'video/mp4' }).supported).toBe(true);
    expect(classifySupportedVideo({ extension: 'WEBM', mime_type: 'VIDEO/WEBM' }).supported).toBe(true);
  });

  it('rejects mismatched extension/MIME pairs and legacy generic MIME', () => {
    expect(classifySupportedVideo({ extension: 'webm', mime_type: 'video/mp4' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'mp4', mime_type: 'video/webm' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'webm', mime_type: 'application/octet-stream' }).supported)
      .toBe(false);
    expect(classifySupportedVideo({ extension: 'mp4', mime_type: '' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'png', mime_type: 'video/mp4' }).supported).toBe(false);
  });

  it('does not accept arbitrary video/* MIME values', () => {
    expect(classifySupportedVideo({ extension: 'mov', mime_type: 'video/quicktime' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'mkv', mime_type: 'video/x-matroska' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'ogv', mime_type: 'video/ogg' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'bin', mime_type: 'video/webm' }).supported).toBe(false);
  });

  it('does not classify images or Krita files as video', () => {
    expect(classifySupportedVideo({ extension: 'webp', mime_type: 'image/webp' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'gif', mime_type: 'image/gif' }).supported).toBe(false);
    expect(classifySupportedVideo({ extension: 'kra', mime_type: 'application/x-krita' }).supported).toBe(false);
  });

  it('keeps supported videos outside image preview eligibility', () => {
    for (const asset of [
      { extension: 'webm', mime_type: 'video/webm' },
      { extension: 'mp4', mime_type: 'video/mp4' },
    ]) {
      expect(classifyPreviewable(asset)).toMatchObject({ supported: false, kind: null });
    }
    expect(classifyPreviewable({ extension: 'webp', mime_type: 'image/webp' }))
      .toMatchObject({ supported: true, kind: 'image' });
    expect(classifyPreviewable({ extension: 'kra', mime_type: 'application/x-krita' }))
      .toMatchObject({ supported: true, kind: 'krita' });
  });
});

describe('classifyComicAsset', () => {
  const COMIC_MIME = {
    cbz: 'application/vnd.comicbook+zip',
    cbr: 'application/vnd.comicbook-rar',
    cb7: 'application/x-cb7',
  };

  it('maps CBZ, CBR, and CB7 to comic MIME types, including uppercase and mixed-case filenames', () => {
    for (const [filename, format] of [
      ['a.cbz', 'cbz'], ['a.cbr', 'cbr'], ['a.cb7', 'cb7'],
      ['A.CBZ', 'cbz'], ['A.Cbr', 'cbr'], ['A.cB7', 'cb7'],
    ]) {
      const extension = deriveExtensionFromFilename(filename);
      expect(extension).toBe(format);
      expect(mimeFromExtension(extension)).toBe(COMIC_MIME[format]);
      expect(classifyComicAsset({ extension })).toEqual({ comic: true, format, mimeType: COMIC_MIME[format] });
    }
    expect(classifyComicAsset({ extension: 'CBZ' })).toMatchObject({ comic: true, format: 'cbz' });
  });

  it('recognizes comics from the extension even with a legacy generic MIME', () => {
    expect(classifyComicAsset({ extension: 'cbr', mime_type: 'application/octet-stream' }))
      .toEqual({ comic: true, format: 'cbr', mimeType: COMIC_MIME.cbr });
  });

  it('never treats generic archives, other comic-like formats, or media as comics', () => {
    for (const extension of ['zip', 'rar', '7z', 'tar', 'cbt', 'cba', 'pdf', 'png', 'webm', 'kra', '', undefined]) {
      expect(classifyComicAsset({ extension })).toEqual({ comic: false, format: null, mimeType: null });
    }
    for (const extension of ['zip', 'rar', '7z', 'cbt']) {
      expect(mimeFromExtension(extension)).toBe('application/octet-stream');
    }
    expect(classifyComicAsset(null)).toEqual({ comic: false, format: null, mimeType: null });
    expect(classifyComicAsset({ extension: 'toString' }).comic).toBe(false);
  });

  it('keeps comics outside image preview, video, inline-original, and image-processing eligibility', () => {
    for (const [extension, mimeType] of [
      ...Object.entries(COMIC_MIME), ['cbr', 'application/octet-stream'],
    ]) {
      const asset = { extension, mime_type: mimeType };
      expect(classifyPreviewable(asset).supported).toBe(false);
      expect(classifyPreviewable(asset).kind).toBeNull();
      expect(classifySupportedVideo(asset).supported).toBe(false);
      expect(inlineMimeFor(extension, mimeType)).toBeNull();
      expect(isSupportedConversionSource(extension)).toBe(false);
      expect(WATERMARK_SOURCE_IMAGE_EXTENSIONS.has(extension)).toBe(false);
      expect(ARCHIVE_SOURCE_IMAGE_EXTENSIONS.has(extension)).toBe(false);
    }
  });
});

describe('buildAssetPreviewModel comic descriptor', () => {
  const base = { id: 7, project_id: 3, is_present: 1, size_bytes: 10, modified_at: '2026-01-01T00:00:00.000Z' };

  it('marks a present comic as unsupported with no preview, thumbnail, or playback URLs', () => {
    expect(buildAssetPreviewModel({ ...base, extension: 'cb7', mime_type: 'application/x-cb7' }, null)).toEqual({
      state: 'unsupported',
      previewable: false,
      kind: null,
      sourceMetadataValid: false,
      revision: null,
      urls: { thumbnail: null, preview: null },
      playbackUrl: null,
      comic: { format: 'cb7' },
    });
  });

  it('keeps the comic format on a missing comic and null for generic archives', () => {
    expect(buildAssetPreviewModel({ ...base, is_present: 0, extension: 'cbz' }, null))
      .toMatchObject({ state: 'missing', comic: { format: 'cbz' } });
    for (const extension of ['zip', 'rar', '7z', 'pdf']) {
      expect(buildAssetPreviewModel({ ...base, extension, mime_type: 'application/octet-stream' }, null))
        .toMatchObject({ state: 'unsupported', comic: null });
    }
  });

  it('leaves image and video presentation unchanged apart from a null comic descriptor', () => {
    const image = buildAssetPreviewModel({ ...base, extension: 'png', mime_type: 'image/png' }, null);
    expect(image).toMatchObject({ state: 'previewable', previewable: true, kind: 'image', playbackUrl: null, comic: null });

    const video = buildAssetPreviewModel({ ...base, extension: 'mp4', mime_type: 'video/mp4' }, null);
    expect(video).toEqual({
      state: 'video',
      previewable: false,
      kind: 'video',
      sourceMetadataValid: false,
      revision: null,
      urls: { thumbnail: null, preview: null },
      playbackUrl: '/projects/3/assets/7/original',
      comic: null,
    });
  });
});
