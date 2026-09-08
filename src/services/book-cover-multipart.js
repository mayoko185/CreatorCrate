import busboy from 'busboy';

export const BOOK_COVER_MULTIPART_LIMITS = Object.freeze({
  files: 1,
  fileBytes: 10 * 1024 * 1024,
  fields: 16,
  fieldNameBytes: 100,
  fieldBytes: 8 * 1024,
  totalFieldBytes: 100 * 1024,
  requestBytes: 11 * 1024 * 1024,
});

const FAILURES = {
  CONTENT_TYPE: [415, 'Expected multipart/form-data.'],
  MALFORMED_MULTIPART: [400, 'Invalid or incomplete multipart form.'],
  TOO_MANY_FILES: [400, 'Only one cover file is allowed.'],
  UNEXPECTED_FILE: [400, 'Unexpected file field.'],
  FILE_TOO_LARGE: [413, 'Cover file exceeds 10 MiB.'],
  FIELD_LIMIT: [413, 'Multipart text fields exceed the allowed limits.'],
  DUPLICATE_FIELD: [400, 'Duplicate multipart text field.'],
  REQUEST_TOO_LARGE: [413, 'Multipart request exceeds the allowed size.'],
};

export class BookCoverMultipartError extends Error {
  constructor(code) {
    super(FAILURES[code][1]);
    this.name = 'BookCoverMultipartError';
    this.code = code;
    this.status = FAILURES[code][0];
  }
}

/**
 * Consume an unread request without mutating req.body or writing files.
 * Returns { fields, cover: null | { bytes, size } }. Client filenames and MIME
 * are deliberately discarded: managed-image-service validates actual bytes.
 * Later scoped middleware must assign fields to req.body BEFORE requireCsrf,
 * or use the existing X-CSRF-Token gate. Parsing is not CSRF authorization.
 */
export function parseBookCoverMultipart(req) {
  const limits = BOOK_COVER_MULTIPART_LIMITS;
  const contentType = req.headers?.['content-type'];
  if (typeof contentType !== 'string' || !/^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) {
    return Promise.reject(new BookCoverMultipartError('CONTENT_TYPE'));
  }
  let parser;
  try {
    parser = busboy({
      headers: { 'content-type': contentType },
      defCharset: 'utf8',
      limits: {
        files: limits.files,
        fields: limits.fields,
        parts: limits.fields + limits.files + 1,
        // Busboy signals truncation AT the limit; one extra byte makes our
        // public maxima inclusive, with explicit checks before retaining data.
        fileSize: limits.fileBytes + 1,
        fieldSize: limits.fieldBytes + 1,
      },
    });
  } catch {
    return Promise.reject(new BookCoverMultipartError('MALFORMED_MULTIPART'));
  }

  return new Promise((resolve, reject) => {
    const fields = Object.create(null);
    let chunks = [];
    let fileSeen = false;
    let fileInfo;
    let fileBytes = 0;
    let fieldBytes = 0;
    let requestBytes = 0;
    let settled = false;

    function cleanup() {
      req.unpipe(parser);
      req.removeListener('data', countBytes);
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
      // Do not destroy Busboy reentrantly from one of its own callbacks.
      queueMicrotask(() => parser.destroy());
      reject(new BookCoverMultipartError(code));
    }
    function malformed() { fail('MALFORMED_MULTIPART'); }
    function closed() { if (!req.readableEnded) malformed(); }
    function countBytes(chunk) {
      requestBytes += chunk.length;
      if (requestBytes > limits.requestBytes) fail('REQUEST_TOO_LARGE');
    }

    parser.on('file', (name, file, info) => {
      fileInfo = info;
      file.on('error', malformed);
      file.on('limit', () => fail('FILE_TOO_LARGE'));
      file.on('data', (chunk) => {
        if (settled) return;
        fileBytes += chunk.length;
        if (fileBytes > limits.fileBytes) return fail('FILE_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      });
      fileSeen = true;
      if (name !== 'cover') fail('UNEXPECTED_FILE');
    });
    parser.on('field', (name, value, info) => {
      if (settled) return;
      if (typeof name !== 'string' || name.length === 0 || typeof value !== 'string') return malformed();
      const nameBytes = Buffer.byteLength(name);
      const valueBytes = Buffer.byteLength(value);
      fieldBytes += nameBytes + valueBytes;
      if (info.nameTruncated || info.valueTruncated || nameBytes > limits.fieldNameBytes
        || valueBytes > limits.fieldBytes || fieldBytes > limits.totalFieldBytes) {
        return fail('FIELD_LIMIT');
      }
      if (Object.hasOwn(fields, name)) return fail('DUPLICATE_FIELD');
      fields[name] = value;
    });
    parser.on('filesLimit', () => fail('TOO_MANY_FILES'));
    parser.on('fieldsLimit', () => fail('FIELD_LIMIT'));
    parser.on('partsLimit', () => fail('FIELD_LIMIT'));
    parser.on('error', malformed);
    parser.on('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Busboy conflates empty browser filenames with omitted metadata. Only
      // zero-byte, generic octet-stream parts with no filename mean unselected.
      const placeholder = fileSeen && (fileInfo.filename === undefined || fileInfo.filename === '')
        && fileBytes === 0 && fileInfo.mimeType === 'application/octet-stream';
      const cover = fileSeen && !placeholder ? { bytes: Buffer.concat(chunks, fileBytes), size: fileBytes } : null;
      chunks = [];
      resolve({ fields, cover });
    });
    req.on('data', countBytes);
    req.on('aborted', malformed);
    req.on('error', malformed);
    req.on('close', closed);
    if (req.destroyed || req.readableEnded) return malformed();
    req.pipe(parser);
  });
}
