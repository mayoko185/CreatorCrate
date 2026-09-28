import { describe, it, expect } from 'vitest';
import {
  classifySupportedVideo,
  deriveExtensionFromFilename,
  mimeFromExtension,
} from '../src/services/asset-metadata.js';
import { classifyPreviewable } from '../src/services/preview-service.js';

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
