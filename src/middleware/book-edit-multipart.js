import { BookValidationError } from '../services/book-service.js';
import { saveBookWithUploadedCover } from './book-create-multipart.js';

// WP7E HTTP contract (only when a cover file is supplied):
// expectedCoverKind: none | project_asset | managed_asset
// expectedCoverId: empty/omitted for none; canonical positive integer for
// project_asset; exact opaque string for managed_asset (never coerce its ID).
// coverReplacementConfirmed: exactly "true" for either existing source kind.
function expectedCover(body) {
  const kind = body.expectedCoverKind;
  const id = body.expectedCoverId;
  let source;
  if (kind === 'none' && (id === undefined || id === '')) source = null;
  else if (kind === 'project_asset' && typeof id === 'string' && /^[1-9]\d*$/.test(id)
    && Number.isSafeInteger(Number(id))) source = { kind, id: Number(id) };
  else if (kind === 'managed_asset' && typeof id === 'string' && id.length > 0) source = { kind, id };
  else throw new BookValidationError({ general: 'An explicit expected current cover source is required.' });
  if (source !== null && body.coverReplacementConfirmed !== 'true') {
    throw new BookValidationError({ general: 'Confirm replacement of the current Book cover.' });
  }
  return source;
}

export async function updateBookWithUploadedCover(req, res, { bookService, managedImageService }, id, bytes) {
  const input = { title: req.body.title };
  bookService.validateUpdateBook(id, input);
  const expectedSource = expectedCover(req.body);
  // Confirmation applies to the submitted identity. A false "none" claim cannot
  // replace anything: WP7B compares the actual source inside the compound save.
  return saveBookWithUploadedCover(req, res, managedImageService, bytes,
    (managedAssetId) => bookService.updateBookWithManagedPrimaryImage(id, input, managedAssetId, { expectedSource }));
}
