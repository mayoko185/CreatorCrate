import { BookCoverMultipartError, parseBookCoverMultipart } from '../services/book-cover-multipart.js';
import { ManagedImageError } from '../services/managed-image-service.js';

// Mounted only on Book create/edit POSTs, before the existing global CSRF gate.
export async function parseBookCreateMultipart(req, res, next) {
  if (!/^multipart\//i.test(req.headers['content-type'] || '')) return next();
  try {
    const { fields, cover } = await parseBookCoverMultipart(req);
    req.body = fields;
    res.locals.bookCoverUpload = cover;
    const release = () => { delete res.locals.bookCoverUpload; };
    res.once('finish', release);
    res.once('close', release);
    return next();
  } catch (error) {
    // The parser pauses unread input. Close after the safe response, never drain
    // an unbounded rejected body or destroy the socket before sending the error.
    res.set('Connection', 'close');
    const socket = req.socket;
    res.once('finish', () => socket?.destroy());
    const safe = error instanceof BookCoverMultipartError
      ? error : new BookCoverMultipartError('MALFORMED_MULTIPART');
    return res.status(safe.status).json({ status: 'error', code: safe.code, message: safe.message });
  }
}

export async function rollbackBookCover(managedImageService, ownershipToken) {
  try {
    await managedImageService.rollbackCommitted(ownershipToken);
    await managedImageService.compensate(ownershipToken);
  } catch {
    // A refused/uncertain rollback must never fall through to file deletion or
    // masquerade as the original ordinary Book validation failure.
    throw new ManagedImageError('RECOVERY_REQUIRED');
  }
}

export async function createBookWithUploadedCover(req, res, { bookService, managedImageService }, bytes) {
  const input = { title: req.body.title };
  bookService.validateCreateBook(input);
  return saveBookWithUploadedCover(req, res, managedImageService, bytes,
    (managedAssetId) => bookService.createBookWithManagedPrimaryImage(input, managedAssetId));
}

// Shared New/Edit lifecycle. Socket closure cancels, but only terminal handling releases.
export async function saveBookWithUploadedCover(req, res, managedImageService, bytes, saveBook) {
  const disconnected = () => req.aborted || res.destroyed;
  if (disconnected()) return null;
  const operation = req.bookUploadLifetime?.operation;
  if (!operation) throw new Error('Book upload requires early request admission.');
  if (operation.signal.aborted) return null;
  // WP7A has no cancellation API: let ingestion settle before guarded cleanup.
  const { record, ownershipToken } = await managedImageService.createCommittedImage({ bytes, namespace: 'book-covers' });
  if (operation.signal.aborted || disconnected()) {
    await rollbackBookCover(managedImageService, ownershipToken);
    return null;
  }
  try {
    // Synchronous compound transaction; success is the durable boundary.
    return saveBook(record.id);
  } catch (error) {
    await rollbackBookCover(managedImageService, ownershipToken);
    throw error;
  }
}
