import busboy from 'busboy';
import { BOOK_TRANSFER_LIMITS } from './book-transfer-limits.js';

const MULTIPART_FIELD_BYTES = 8 * 1024;

const FAILURES = Object.freeze({
  CONTENT_TYPE: [415, 'Expected multipart/form-data.'],
  MALFORMED_MULTIPART: [400, 'Invalid or incomplete multipart form.'],
  MISSING_FILE: [400, 'A Book transfer archive is required.'],
  EMPTY_FILE: [400, 'The Book transfer archive is empty.'],
  TOO_MANY_FILES: [400, 'Only one Book transfer archive is allowed.'],
  UNEXPECTED_FILE: [400, 'The Book transfer archive must use the archive field.'],
  UNEXPECTED_FIELD: [400, 'Unexpected multipart text field.'],
  DUPLICATE_FIELD: [400, 'Duplicate multipart text field.'],
  FIELD_LIMIT: [413, 'Multipart text fields exceed the allowed limits.'],
  ARCHIVE_LIMIT_EXCEEDED: [413, 'The Book archive exceeds the allowed resource limits.'],
});

export class BookImportMultipartError extends Error {
  constructor(code) {
    super(FAILURES[code][1]);
    this.name = 'BookImportMultipartError';
    this.code = code;
    this.status = FAILURES[code][0];
  }
}

/**
 * Bounded, memory-only adapter for the single Book-transfer ZIP. Client file
 * metadata is deliberately ignored; WP7 validates the bytes themselves.
 */
export function parseBookImportMultipart(req) {
  const contentType = req.headers?.['content-type'];
  if (typeof contentType !== 'string' || !/^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) {
    return Promise.reject(new BookImportMultipartError('CONTENT_TYPE'));
  }

  let parser;
  try {
    parser = busboy({
      headers: { 'content-type': contentType },
      defCharset: 'utf8',
      limits: {
        files: 1,
        fields: 1,
        // Busboy signals partsLimit at the configured threshold. The extra
        // sentinel slot permits the two valid parts while detecting a third.
        parts: 3,
        fileSize: BOOK_TRANSFER_LIMITS.compressedArchiveBytes + 1,
        fieldSize: MULTIPART_FIELD_BYTES + 1,
      },
    });
  } catch {
    return Promise.reject(new BookImportMultipartError('MALFORMED_MULTIPART'));
  }

  return new Promise((resolve, reject) => {
    const fields = Object.create(null);
    let chunks = [];
    let fileSeen = false;
    let fileBytes = 0;
    let settled = false;

    function cleanup() {
      req.unpipe(parser);
      req.removeListener('aborted', malformed);
      req.removeListener('error', malformed);
      req.removeListener('close', closed);
    }
    function fail(code) {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause();
      chunks = [];
      queueMicrotask(() => parser.destroy());
      reject(new BookImportMultipartError(code));
    }
    function malformed() { fail('MALFORMED_MULTIPART'); }
    function closed() { if (!req.readableEnded) malformed(); }

    parser.on('file', (name, file) => {
      fileSeen = true;
      file.on('error', malformed);
      file.on('limit', () => fail('ARCHIVE_LIMIT_EXCEEDED'));
      file.on('data', (chunk) => {
        if (settled) return;
        fileBytes += chunk.length;
        if (fileBytes > BOOK_TRANSFER_LIMITS.compressedArchiveBytes) {
          return fail('ARCHIVE_LIMIT_EXCEEDED');
        }
        chunks.push(Buffer.from(chunk));
      });
      if (name !== 'archive') fail('UNEXPECTED_FILE');
    });
    parser.on('field', (name, value, info) => {
      if (settled) return;
      if (name !== '_csrf') return fail('UNEXPECTED_FIELD');
      if (typeof value !== 'string' || info.nameTruncated || info.valueTruncated
        || Buffer.byteLength(value) > MULTIPART_FIELD_BYTES) {
        return fail('FIELD_LIMIT');
      }
      if (Object.hasOwn(fields, name)) return fail('DUPLICATE_FIELD');
      fields[name] = value;
    });
    parser.on('filesLimit', () => fail('TOO_MANY_FILES'));
    parser.on('fieldsLimit', () => fail('FIELD_LIMIT'));
    parser.on('partsLimit', () => fail('TOO_MANY_FILES'));
    parser.on('error', malformed);
    parser.on('close', () => {
      if (settled) return;
      if (!fileSeen) return fail('MISSING_FILE');
      if (fileBytes === 0) return fail('EMPTY_FILE');
      settled = true;
      cleanup();
      const archiveBytes = Buffer.concat(chunks, fileBytes);
      chunks = [];
      resolve({ fields, archiveBytes });
    });
    req.on('aborted', malformed);
    req.on('error', malformed);
    req.on('close', closed);
    if (req.destroyed || req.readableEnded) return malformed();
    req.pipe(parser);
  });
}
