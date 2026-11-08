/**
 * Shared file-metadata derivation — extension and MIME type from a filename.
 * Used by the scanner (on discovery) and the asset action service (on
 * rename/move, when the filename or its extension changes) so the two never
 * drift into separate MIME maps.
 */

/**
 * MIME type mapping by file extension.
 * Only known asset types are mapped; everything else is application/octet-stream.
 */
const EXTENSION_MIME_MAP = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  kra: 'application/x-krita',
  krz: 'application/x-krita',
  webm: 'video/webm',
  mp4: 'video/mp4',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  cb7: 'application/x-cb7',
};

/**
 * Supported comic archive formats, keyed by extension. Only these comic
 * extensions are comics: a generic .zip, .rar, or .7z is never a comic even
 * though its container is compatible.
 */
const COMIC_MIME_BY_EXTENSION = Object.freeze({
  cbz: EXTENSION_MIME_MAP.cbz,
  cbr: EXTENSION_MIME_MAP.cbr,
  cb7: EXTENSION_MIME_MAP.cb7,
});

/**
 * Supported CreatorCrate video formats. Deliberately separate from the image
 * preview allowlist in preview-service.js: a supported video is recognized as
 * video only and never becomes eligible for Sharp decoding, thumbnails,
 * previews, animation inspection, or primary-image handling.
 */
const SUPPORTED_VIDEO_MIME_BY_EXTENSION = Object.freeze({
  webm: 'video/webm',
  mp4: 'video/mp4',
});

/**
 * Map a file extension to its MIME type.
 * @param {string} ext - Extension without the leading dot, lowercased
 * @returns {string}
 */
export function mimeFromExtension(ext) {
  return EXTENSION_MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * Derive the lowercased, dot-free extension from a filename.
 * @param {string} filename
 * @returns {string} e.g. "png", or "" if the filename has no extension
 */
export function deriveExtensionFromFilename(filename) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return ''; // no dot, or a leading dot only (dotfile)
  return filename.slice(dotIndex + 1).toLowerCase();
}

/**
 * Decide whether an asset record is a supported CreatorCrate video. Both the
 * extension and the recorded MIME must be on the video allowlist and agree;
 * an arbitrary `video/*` MIME or an extension/MIME mismatch is unsupported.
 *
 * @param {{ extension: string, mime_type: string }} asset
 * @returns {{ supported: boolean, extension: string, mimeType: string }}
 */
export function classifySupportedVideo(asset) {
  const ext = String(asset?.extension || '').toLowerCase();
  const mime = String(asset?.mime_type || '').toLowerCase();
  const expected = SUPPORTED_VIDEO_MIME_BY_EXTENSION[ext];
  return { supported: Boolean(expected) && mime === expected, extension: ext, mimeType: mime };
}

/**
 * Decide whether an asset record is a comic archive (CBZ, CBR, or CB7) from
 * its extension alone. Unlike images and videos, the recorded MIME is not
 * consulted: rows indexed before comic recognition carry the generic
 * `application/octet-stream` (CBR was always scanned) until a rescan repairs
 * them, and a MIME could never prove the archive is valid anyway. This is a
 * type classification only — it never makes the asset previewable or eligible
 * for any image processing, and actual archive validation stays with the
 * page-access path.
 *
 * @param {{ extension: string }} asset
 * @returns {{ comic: boolean, format: 'cbz'|'cbr'|'cb7'|null, mimeType: string|null }}
 */
export function classifyComicAsset(asset) {
  const ext = String(asset?.extension || '').toLowerCase();
  const mimeType = Object.hasOwn(COMIC_MIME_BY_EXTENSION, ext) ? COMIC_MIME_BY_EXTENSION[ext] : null;
  return { comic: mimeType !== null, format: mimeType === null ? null : ext, mimeType };
}
