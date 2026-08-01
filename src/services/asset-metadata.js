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
  gif: 'image/gif',
  kra: 'application/x-krita',
  krz: 'application/x-krita',
};

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
