import { describe, it, expect, vi } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { parseBookCoverMultipart, BOOK_COVER_MULTIPART_LIMITS as L } from '../src/services/book-cover-multipart.js';
import { createCsrfMiddleware, createDisabledModeCsrfMiddleware, deriveCsrfToken,
  deriveDisabledModeCsrfToken } from '../src/middleware/csrf.js';

const type = 'multipart/form-data; boundary=wp7d1';
function body(parts, end = true) {
  return Buffer.concat([...parts.flatMap(({ name, bytes, value = '' }) => [
    Buffer.from(`--wp7d1\r\nContent-Disposition: form-data; name="${name}"${bytes === undefined ? '' : '; filename="../../private.png"'}\r\n${bytes === undefined ? '' : 'Content-Type: image/png\r\n'}\r\n`),
    bytes ?? Buffer.from(value), Buffer.from('\r\n'),
  ]), Buffer.from(end ? '--wp7d1--\r\n' : '')]);
}
function parse(bytes, contentType = type) {
  // Exercise streaming boundaries, including headers and delimiters.
  const req = Readable.from((function* () {
    for (let offset = 0; offset < bytes.length; offset += 4093) yield bytes.subarray(offset, offset + 4093);
  })());
  req.headers = { 'content-type': contentType };
  return parseBookCoverMultipart(req).finally(() => req.destroy());
}
async function rejects(bytes, code, contentType) {
  await expect(parse(bytes, contentType)).rejects.toMatchObject({
    name: 'BookCoverMultipartError', code,
  });
}

describe('Book-cover multipart foundation', () => {
  it('returns bounded fields without a file and preserves literal field names safely', async () => {
    const result = await parse(body([{ name: 'title', value: 'Book' }, { name: '__proto__', value: 'safe' }]));
    expect(result.cover).toBeNull();
    expect(Object.getPrototypeOf(result.fields)).toBeNull();
    expect(result.fields.title).toBe('Book');
    expect(result.fields.__proto__).toBe('safe');
  });
  it('returns bytes and size only; filename and MIME confer no image eligibility', async () => {
    const bytes = Buffer.from('not actually an image');
    expect((await parse(body([{ name: 'cover', bytes }]))).cover).toEqual({ bytes, size: bytes.length });
  });
  it('accepts exactly 10 MiB', async () => {
    expect((await parse(body([{ name: 'cover', bytes: Buffer.alloc(L.fileBytes) }]))).cover.size).toBe(L.fileBytes);
  });
  it('rejects 10 MiB plus one byte', async () => {
    await rejects(body([{ name: 'cover', bytes: Buffer.alloc(L.fileBytes + 1) }]), 'FILE_TOO_LARGE');
  });
  it('rejects a second file even under another name', async () => {
    for (const name of ['cover', 'other']) {
      await rejects(body([{ name: 'cover', bytes: Buffer.from('a') }, { name, bytes: Buffer.from('b') }]), 'TOO_MANY_FILES');
    }
  });
  it('rejects an unexpected first file field', async () => {
    await rejects(body([{ name: 'other', bytes: Buffer.from('a') }]), 'UNEXPECTED_FILE');
  });
  it('rejects wrong type, missing boundary, bad headers and truncated fields/files', async () => {
    await rejects(Buffer.from('x'), 'CONTENT_TYPE', 'application/x-www-form-urlencoded');
    await rejects(Buffer.from('x'), 'MALFORMED_MULTIPART', 'multipart/form-data');
    await rejects(Buffer.from('--wp7d1\r\ninvalid header\r\n\r\nx\r\n--wp7d1--\r\n'), 'MALFORMED_MULTIPART');
    for (const part of [{ name: 'title', value: 'x' }, { name: 'cover', bytes: Buffer.from('x') }]) {
      await rejects(body([part], false), 'MALFORMED_MULTIPART');
    }
  });
  it('enforces inclusive field count and individual byte limits', async () => {
    const parts = Array.from({ length: L.fields }, (_, i) => ({ name: `f${i}`, value: 'x' }));
    expect(Object.keys((await parse(body(parts))).fields)).toHaveLength(L.fields);
    expect((await parse(body([...parts, { name: 'cover', bytes: Buffer.from('x') }]))).cover.size).toBe(1);
    await rejects(body([...parts, { name: 'extra' }]), 'FIELD_LIMIT');
    expect((await parse(body([{ name: 'title', value: 'a'.repeat(L.fieldBytes) }]))).fields.title.length).toBe(L.fieldBytes);
    await rejects(body([{ name: 'title', value: 'a'.repeat(L.fieldBytes + 1) }]), 'FIELD_LIMIT');
    await rejects(body([{ name: 'title', value: 'é'.repeat(L.fieldBytes) }]), 'FIELD_LIMIT');
    await rejects(body([{ name: 'n'.repeat(L.fieldNameBytes + 1) }]), 'FIELD_LIMIT');
  });
  it('bounds total field names plus values and rejects duplicate fields including tokens', async () => {
    await rejects(body(Array.from({ length: 13 }, (_, i) => ({ name: `f${i}`, value: 'a'.repeat(L.fieldBytes) }))), 'FIELD_LIMIT');
    await rejects(body([{ name: '_csrf', value: 'a' }, { name: '_csrf', value: 'b' }]), 'DUPLICATE_FIELD');
  });
  it('rejects nameless fields and unsupported field encodings safely', async () => {
    await rejects(Buffer.from('--wp7d1\r\nContent-Disposition: form-data\r\n\r\nx\r\n--wp7d1--\r\n'), 'MALFORMED_MULTIPART');
    await rejects(Buffer.from('--wp7d1\r\nContent-Disposition: form-data; name="title"\r\nContent-Type: text/plain; charset=bogus\r\n\r\nx\r\n--wp7d1--\r\n'), 'MALFORMED_MULTIPART');
  });
  it('rejects request errors and premature close', async () => {
    for (const event of ['error', 'close']) {
      const req = new PassThrough();
      req.headers = { 'content-type': type };
      const result = parseBookCoverMultipart(req);
      req.emit(event, new Error('private filesystem path'));
      await expect(result).rejects.toMatchObject({ code: 'MALFORMED_MULTIPART', message: 'Invalid or incomplete multipart form.' });
      req.destroy();
    }
  });
  it('bounds the entire wire body, including ignored preamble/epilogue', async () => {
    await rejects(Buffer.concat([body([]), Buffer.alloc(L.requestBytes)]), 'REQUEST_TOO_LARGE');
  });
  it('rejects aborted input and detaches request listeners without destroying the response socket', async () => {
    const req = new PassThrough();
    req.headers = { 'content-type': type };
    const result = parseBookCoverMultipart(req);
    req.write('--wp7d1\r\n');
    req.emit('aborted');
    await expect(result).rejects.toMatchObject({ code: 'MALFORMED_MULTIPART' });
    expect(req.destroyed).toBe(false);
    for (const event of ['data', 'aborted', 'close', 'error']) expect(req.listenerCount(event)).toBe(0);
    req.destroy();
  });
  it('does not call filesystem APIs on success or failure', async () => {
    const fs = await import('node:fs');
    const spies = ['writeFileSync', 'createWriteStream', 'mkdtempSync', 'openSync'].map(name => vi.spyOn(fs.default, name));
    const asyncSpies = ['writeFile', 'mkdtemp', 'open'].map(name => vi.spyOn(fs.default.promises, name));
    try {
      await parse(body([{ name: 'cover', bytes: Buffer.from('x') }]));
      await rejects(body([{ name: 'other', bytes: Buffer.from('x') }]), 'UNEXPECTED_FILE');
      for (const spy of [...spies, ...asyncSpies]) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of [...spies, ...asyncSpies]) spy.mockRestore(); }
  });
});

describe.each(['authenticated', 'disabled'])('multipart CSRF composition: %s', mode => {
  function app() {
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use((_req, res, next) => { res.locals.auth = { authenticated: true, csrfSecret: 'secret' }; next(); });
    app.use((req, res, next) => {
      if (!req.is('multipart/form-data')) return next();
      parseBookCoverMultipart(req).then(({ fields }) => { req.body = fields; next(); }, next);
    });
    app.use((mode === 'authenticated' ? createCsrfMiddleware()
      : createDisabledModeCsrfMiddleware({ csrfPepper: 'pepper' })).requireCsrf);
    app.post('/book-fixture', (req, res) => res.json({ title: req.body.title }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code, message: err.message }));
    return app;
  }
  const token = mode === 'authenticated' ? deriveCsrfToken('secret') : deriveDisabledModeCsrfToken('pepper', 'visitor');
  it('validates extracted _csrf and rejects missing/invalid tokens without an exemption', async () => {
    for (const submitted of [token, 'bad', null]) {
      const parts = [{ name: 'title', value: 'Book' }];
      if (submitted !== null) parts.push({ name: '_csrf', value: submitted });
      await request(app()).post('/book-fixture').set('Cookie', 'cc_csrf_anon=visitor')
        .set('Content-Type', type).send(body(parts)).expect(submitted === token ? 200 : 403);
    }
  });
  it('preserves URL-encoded CSRF submission', async () => {
    await request(app()).post('/book-fixture').set('Cookie', 'cc_csrf_anon=visitor')
      .type('form').send({ title: 'Book', _csrf: token }).expect(200, { title: 'Book' });
  });
  it('serializes only safe failure details', async () => {
    const res = await request(app()).post('/book-fixture').set('Content-Type', type)
      .send(body([{ name: 'wrong', bytes: Buffer.from('SECRET UPLOADED BYTES') }])).expect(400);
    expect(res.body).toEqual({ code: 'UNEXPECTED_FILE', message: 'Unexpected file field.' });
  });
});
