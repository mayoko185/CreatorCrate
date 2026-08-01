import { describe, it, expect } from 'vitest';
import {
  validateAssetFilename,
  assertValidAssetFilename,
  AssetFilenameValidationError,
  PORTABLE_FILENAME_MAX_BYTES,
} from '../src/services/asset-filename-validation.js';

describe('asset filename validation', () => {
  it('accepts ordinary unicode, spaces, and punctuation', () => {
    for (const name of [
      'render.png',
      'Sunset Render (final).png',
      "café-scène.kra",
      '日本語のファイル名.psd',
      "it's-a-test_file~1.jpg",
    ]) {
      expect(validateAssetFilename(name)).toBeNull();
    }
  });

  it('rejects empty input', () => {
    expect(validateAssetFilename('')).toBeTruthy();
    expect(validateAssetFilename(undefined)).toBeTruthy();
    expect(validateAssetFilename(null)).toBeTruthy();
  });

  it('rejects "." and ".."', () => {
    expect(validateAssetFilename('.')).toBeTruthy();
    expect(validateAssetFilename('..')).toBeTruthy();
  });

  it('rejects path separators', () => {
    expect(validateAssetFilename('sub/file.png')).toBeTruthy();
    expect(validateAssetFilename('sub\\file.png')).toBeTruthy();
  });

  it('rejects Win32-forbidden characters individually', () => {
    expect(validateAssetFilename('foo<bar')).toBeTruthy();
    expect(validateAssetFilename('foo>bar')).toBeTruthy();
    expect(validateAssetFilename('foo:bar')).toBeTruthy();
    expect(validateAssetFilename('foo"bar')).toBeTruthy();
    expect(validateAssetFilename('foo|bar')).toBeTruthy();
    expect(validateAssetFilename('foo?bar')).toBeTruthy();
    expect(validateAssetFilename('foo*bar')).toBeTruthy();
    expect(validateAssetFilename('C:foo')).toBeTruthy();
  });

  it('rejects absolute and drive-prefixed forms', () => {
    expect(validateAssetFilename('/etc/passwd')).toBeTruthy();
    expect(validateAssetFilename('\\\\server\\share')).toBeTruthy();
    expect(validateAssetFilename('C:\\file.png')).toBeTruthy();
    expect(validateAssetFilename('C:/file.png')).toBeTruthy();
  });

  it('rejects NUL and ASCII control characters', () => {
    expect(validateAssetFilename('file\0.png')).toBeTruthy();
    expect(validateAssetFilename('file\x01.png')).toBeTruthy();
    expect(validateAssetFilename('file\n.png')).toBeTruthy();
    expect(validateAssetFilename('file\t.png')).toBeTruthy();
  });

  it('rejects a trailing dot', () => {
    expect(validateAssetFilename('file.')).toBeTruthy();
  });

  it('rejects a trailing space', () => {
    expect(validateAssetFilename('file.png ')).toBeTruthy();
  });

  it('rejects Windows reserved device names case-insensitively, with or without extension', () => {
    for (const name of [
      'CON', 'con', 'Con',
      'PRN', 'AUX', 'NUL',
      'COM1', 'com3', 'COM9',
      'LPT1', 'lpt5', 'LPT9',
      'CON.txt', 'nul.tar.gz',
    ]) {
      expect(validateAssetFilename(name)).toBeTruthy();
    }
  });

  it('does not reject names that merely contain a reserved token as a substring', () => {
    expect(validateAssetFilename('CONcept.png')).toBeNull();
    expect(validateAssetFilename('falcon.png')).toBeNull();
  });

  it('rejects names exceeding the portable byte limit', () => {
    const tooLong = `${'a'.repeat(PORTABLE_FILENAME_MAX_BYTES - 3)}.png`;
    expect(Buffer.byteLength(tooLong, 'utf8')).toBeGreaterThan(PORTABLE_FILENAME_MAX_BYTES);
    expect(validateAssetFilename(tooLong)).toBeTruthy();
  });

  it('accepts a name exactly at the portable byte limit', () => {
    const exact = `${'a'.repeat(PORTABLE_FILENAME_MAX_BYTES - 4)}.png`;
    expect(Buffer.byteLength(exact, 'utf8')).toBe(PORTABLE_FILENAME_MAX_BYTES);
    expect(validateAssetFilename(exact)).toBeNull();
  });

  it('counts multi-byte unicode by byte length, not character length', () => {
    // Each '日' is 3 bytes in UTF-8, so 90 chars = 270 bytes > 255.
    const longUnicode = '日'.repeat(90);
    expect(validateAssetFilename(longUnicode)).toBeTruthy();
  });

  it('does not normalize unsafe input into a different accepted filename', () => {
    // A trailing-dot name must be rejected outright, not silently trimmed.
    expect(validateAssetFilename('file.png.')).toBe('Filename must not end with a dot.');
  });

  describe('assertValidAssetFilename', () => {
    it('returns the value unchanged when valid', () => {
      expect(assertValidAssetFilename('render.png')).toBe('render.png');
    });

    it('throws AssetFilenameValidationError when invalid', () => {
      expect(() => assertValidAssetFilename('..')).toThrow(AssetFilenameValidationError);
      try {
        assertValidAssetFilename('CON');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AssetFilenameValidationError);
        expect(err.code).toBe('INVALID_FILENAME');
      }
    });
  });
});
