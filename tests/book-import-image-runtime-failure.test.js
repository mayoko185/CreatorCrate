import crypto from 'node:crypto';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { makeZip } from './helpers/zip-fixture.js';

const runtimeState = vi.hoisted(() => ({ failure: new TypeError('synthetic runtime failure') }));

vi.mock('../src/services/sharp-runtime.js', async (importOriginal) => ({
  ...await importOriginal(),
  sharpRuntime: Object.freeze({
    initialize() {
      throw runtimeState.failure;
    },
  }),
}));

const { validateManagedImageBuffer } = await import('../src/services/managed-image-service.js');
const { BookImportError, parseBookImportArchive } = await import('../src/services/book-import-service.js');

function archiveWithManagedCover(bytes) {
  const manifest = {
    format: 'creatorcrate-books',
    version: 1,
    books: [{
      key: 'book-1',
      title: 'Book',
      createdAt: '2026-09-18 10:00:00',
      updatedAt: '2026-09-18 10:00:00',
      rootContents: [],
      chapters: [],
      pages: [],
      previewSettings: { mode: 'selected', randomCount: 5, selectedPageKeys: [] },
      cover: {
        kind: 'managed',
        media: {
          path: 'covers/book-1/cover.png',
          mimeType: 'image/png',
          sizeBytes: bytes.length,
          width: 2,
          height: 2,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      },
    }],
  };
  return makeZip([
    { name: 'creatorcrate-books.json', data: `${JSON.stringify(manifest)}\n` },
    { name: 'covers/book-1/cover.png', data: bytes },
  ]);
}

async function expectInternalFailure(bytes, failure) {
  runtimeState.failure = failure;
  await expect(validateManagedImageBuffer(bytes)).rejects.toBe(failure);

  let rejection;
  try {
    await parseBookImportArchive(archiveWithManagedCover(bytes));
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBe(failure);
  expect(rejection).not.toBeInstanceOf(BookImportError);
}

it.each([
  new Error('VipsJpeg: allocation failed'),
  new Error('pngload: allocation failed'),
  new Error('webpload: allocation failed'),
  new Error('VipsJpeg: initialization failed'),
  new Error('pngload: out of memory'),
  new Error('webpload: internal runtime failure'),
  new TypeError('synthetic type failure'),
  new RangeError('synthetic range failure'),
])('does not classify an unexpected image runtime failure as invalid media: %s', async (runtimeFailure) => {
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#abcdef' },
  }).png().toBuffer();
  await expectInternalFailure(bytes, runtimeFailure);
});
