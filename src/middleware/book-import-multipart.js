import {
  BookImportMultipartError,
  parseBookImportMultipart,
} from '../services/book-import-multipart.js';

export const BOOK_IMPORT_MULTIPART_PATH = /^\/notes\/books\/import\/?$/i;

export async function parseBookImportUpload(req, res, next) {
  if (!/^multipart\//i.test(req.headers['content-type'] || '')) return next();
  try {
    const { fields, archiveBytes } = await parseBookImportMultipart(req);
    req.body = fields;
    res.locals.bookImportArchiveBytes = archiveBytes;
    const release = () => { delete res.locals.bookImportArchiveBytes; };
    res.once('finish', release);
    res.once('close', release);
    return next();
  } catch (error) {
    res.set('Connection', 'close');
    const socket = req.socket;
    res.once('finish', () => socket?.destroy());
    const safe = error instanceof BookImportMultipartError
      ? error : new BookImportMultipartError('MALFORMED_MULTIPART');
    return res.status(safe.status).json({ success: false, code: safe.code, message: safe.message });
  }
}
