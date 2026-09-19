import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { BOOK_EXPORT_FORMAT, BOOK_EXPORT_MANIFEST, BOOK_EXPORT_VERSION } from './book-export-service.js';
import {
  BOOK_TRANSFER_LIMITS,
  isBookTransferUncompressedSizeAllowed,
} from './book-transfer-limits.js';
import { BOOK_TITLE_MAX } from './book-service.js';
import { CHAPTER_TITLE_MAX } from './chapter-service.js';
import {
  MANAGED_IMAGE_LIMITS,
  ManagedImageError,
  validateManagedImageBuffer,
} from './managed-image-service.js';
import { NOTE_TITLE_MAX } from './note-service.js';

const SQLITE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME_FORMATS = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
});
const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});
const UNIX_HOST_SYSTEM = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;

export class BookImportError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookImportError';
    this.code = code;
    this.status = 422;
  }
}

function invalid(message, code = 'INVALID_MANIFEST_SCHEMA', cause) {
  return new BookImportError(message, { code, cause });
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('The Book archive manifest has an invalid structure.');
  }
  return value;
}

function exactKeys(value, keys) {
  plainObject(value);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid('The Book archive manifest has an invalid structure.');
  }
  return value;
}

function string(value, { allowEmpty = false, max = 16_384 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw invalid('The Book archive manifest contains an invalid string value.');
  }
  return value;
}

function title(value, max) {
  string(value, { max });
  if (value.trim().length === 0) throw invalid('The Book archive contains an empty title.');
  return value;
}

function timestamp(value) {
  string(value, { max: 64 });
  const match = SQLITE_TIMESTAMP.exec(value);
  if (!match) {
    throw invalid('The Book archive contains an invalid timestamp.');
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) {
    throw invalid('The Book archive contains an invalid timestamp.');
  }
  return value;
}

function nonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid('The Book archive contains an invalid count.');
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid('The Book archive contains an invalid positive integer.');
  }
  return value;
}

function array(value) {
  if (!Array.isArray(value)) throw invalid('The Book archive manifest contains an invalid list.');
  return value;
}

function uniqueKey(value, keys, scope) {
  const key = string(value, { max: 200 });
  if (keys.has(key)) throw invalid(`The Book archive contains a duplicate ${scope} key.`, 'DUPLICATE_LOCAL_KEY');
  keys.add(key);
  return key;
}

function normalizeEntryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || /[\u0000-\u001f\u007f]/.test(value) || value.includes('\\')
    || value.startsWith('/') || value.startsWith('//') || /^[a-zA-Z]:/.test(value)) {
    throw invalid('The Book archive contains an unsafe entry path.', 'UNSAFE_ENTRY_PATH');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw invalid('The Book archive contains an unsafe entry path.', 'UNSAFE_ENTRY_PATH');
  }
  const normalized = parts.map((part) => part.normalize('NFC')).join('/');
  if (normalized !== value) {
    throw invalid('The Book archive contains an unsafe normalized entry alias.', 'UNSAFE_ENTRY_PATH');
  }
  return normalized;
}

function hasNonFileUnixType(entry) {
  const host = entry.versionMadeBy >>> 8;
  if (host !== UNIX_HOST_SYSTEM) return false;
  const type = (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
  return type !== 0 && type !== UNIX_REGULAR_FILE;
}

async function readEntry(zip, entry, state, limit) {
  let stream;
  try {
    stream = await zip.openReadStreamPromise(entry);
    const chunks = [];
    let entryBytes = 0;
    let entryCrc32 = 0;
    for await (const chunk of stream) {
      const nextEntryBytes = entryBytes + chunk.length;
      const nextActualBytes = state.actualBytes + chunk.length;
      if (nextEntryBytes > limit || !isBookTransferUncompressedSizeAllowed(nextActualBytes)) {
        stream.destroy();
        throw invalid('The Book archive exceeds the allowed resource limits.', 'ARCHIVE_LIMIT_EXCEEDED');
      }
      entryBytes = nextEntryBytes;
      state.actualBytes = nextActualBytes;
      entryCrc32 = crc32(chunk, entryCrc32);
      chunks.push(Buffer.from(chunk));
    }
    if ((entryCrc32 >>> 0) !== (entry.crc32 >>> 0)) {
      stream.destroy();
      throw invalid('The Book archive failed an integrity check.', 'INVALID_ARCHIVE');
    }
    return Buffer.concat(chunks, entryBytes);
  } catch (cause) {
    if (cause instanceof BookImportError) throw cause;
    throw invalid('The Book archive is invalid or truncated.', 'INVALID_ARCHIVE', cause);
  }
}

async function readArchive(archiveBytes) {
  if (!(Buffer.isBuffer(archiveBytes) || archiveBytes instanceof Uint8Array)) {
    throw invalid('The Book archive must be supplied as bytes.', 'INVALID_ARCHIVE');
  }
  const bytes = Buffer.isBuffer(archiveBytes) ? archiveBytes : Buffer.from(archiveBytes);
  if (bytes.length === 0) throw invalid('The supplied file is not a valid ZIP archive.', 'INVALID_ARCHIVE');
  if (bytes.length > BOOK_TRANSFER_LIMITS.compressedArchiveBytes) {
    throw invalid('The Book archive exceeds the allowed resource limits.', 'ARCHIVE_LIMIT_EXCEEDED');
  }

  let zip;
  try {
    zip = await yauzl.fromBufferPromise(bytes, { validateEntrySizes: true, strictFileNames: true });
  } catch (cause) {
    throw invalid('The supplied file is not a valid ZIP archive.', 'INVALID_ARCHIVE', cause);
  }
  if (zip.entryCount > BOOK_TRANSFER_LIMITS.maximumFileEntries) {
    throw invalid('The Book archive exceeds the allowed resource limits.', 'ARCHIVE_LIMIT_EXCEEDED');
  }

  const entries = new Map();
  const normalizedNames = new Set();
  const state = { actualBytes: 0, declaredBytes: 0 };
  try {
    for await (const entry of zip.eachEntry()) {
      const name = normalizeEntryPath(entry.fileName);
      if (hasNonFileUnixType(entry) || name.endsWith('/')) {
        throw invalid('The Book archive contains a non-file entry.', 'UNSAFE_ENTRY_PATH');
      }
      if (entries.has(name) || normalizedNames.has(name.normalize('NFC'))) {
        throw invalid('The Book archive contains a duplicate entry.', 'DUPLICATE_ARCHIVE_ENTRY');
      }
      normalizedNames.add(name.normalize('NFC'));
      const entryLimit = name === BOOK_EXPORT_MANIFEST
        ? BOOK_TRANSFER_LIMITS.manifestBytes : BOOK_TRANSFER_LIMITS.coverBytes;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || entry.uncompressedSize > entryLimit) {
        throw invalid('The Book archive exceeds the allowed resource limits.', 'ARCHIVE_LIMIT_EXCEEDED');
      }
      state.declaredBytes += entry.uncompressedSize;
      if (!isBookTransferUncompressedSizeAllowed(state.declaredBytes)) {
        throw invalid('The Book archive exceeds the allowed resource limits.', 'ARCHIVE_LIMIT_EXCEEDED');
      }
      entries.set(name, await readEntry(zip, entry, state, entryLimit));
    }
  } catch (cause) {
    if (cause instanceof BookImportError) throw cause;
    if (/file.?name|relative path|absolute path|invalid characters|backslash/i.test(cause?.message || '')) {
      throw invalid('The Book archive contains an unsafe entry path.', 'UNSAFE_ENTRY_PATH', cause);
    }
    throw invalid('The supplied file is not a valid ZIP archive.', 'INVALID_ARCHIVE', cause);
  } finally {
    zip.close();
  }
  return entries;
}

function validateProjectLocator(value) {
  exactKeys(value, ['slug', 'title', 'projectType']);
  return {
    slug: string(value.slug, { max: 200 }),
    title: string(value.title, { max: 200 }),
    projectType: string(value.projectType, { max: 100 }),
  };
}

function validateRelativeLocatorPath(value) {
  const relativePath = string(value, { max: 4096 });
  if (relativePath.includes('\0') || relativePath.includes('\\') || relativePath.startsWith('/')
    || /^[a-zA-Z]:/.test(relativePath)
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw invalid('The Book archive contains an invalid Asset locator.');
  }
  return relativePath;
}

function validateAssetLocator(value) {
  exactKeys(value, ['project', 'relativePath', 'filename', 'extension', 'mimeType']);
  return {
    project: validateProjectLocator(value.project),
    relativePath: validateRelativeLocatorPath(value.relativePath),
    filename: string(value.filename, { max: 255 }),
    extension: string(value.extension, { allowEmpty: true, max: 32 }),
    mimeType: string(value.mimeType, { max: 200 }),
  };
}

function validateProjectAssociations(value) {
  const seenSlugs = new Set();
  return array(value).map((rawLocator) => {
    const locator = validateProjectLocator(rawLocator);
    if (seenSlugs.has(locator.slug)) {
      throw invalid('The Book archive contains a duplicate Project association.');
    }
    seenSlugs.add(locator.slug);
    return locator;
  });
}

function validateAssetAssociations(value) {
  const pathsByProjectSlug = new Map();
  return array(value).map((rawLocator) => {
    const locator = validateAssetLocator(rawLocator);
    const paths = pathsByProjectSlug.get(locator.project.slug) ?? new Set();
    if (paths.has(locator.relativePath)) {
      throw invalid('The Book archive contains a duplicate Asset association.');
    }
    paths.add(locator.relativePath);
    pathsByProjectSlug.set(locator.project.slug, paths);
    return locator;
  });
}

function validateAssociations(value) {
  exactKeys(value, ['projects', 'assets', 'unresolvedProjectCount', 'unresolvedAssetCount']);
  return {
    projects: validateProjectAssociations(value.projects),
    assets: validateAssetAssociations(value.assets),
    unresolvedProjectCount: nonNegativeInteger(value.unresolvedProjectCount),
    unresolvedAssetCount: nonNegativeInteger(value.unresolvedAssetCount),
  };
}

function validateRevision(value, revisionKeys) {
  exactKeys(value, ['key', 'title', 'rawMarkdown', 'sourceUpdatedAt', 'createdAt', 'associations']);
  return {
    key: uniqueKey(value.key, revisionKeys, 'revision'),
    title: title(value.title, NOTE_TITLE_MAX),
    rawMarkdown: string(value.rawMarkdown, { allowEmpty: true, max: BOOK_TRANSFER_LIMITS.manifestBytes }),
    sourceUpdatedAt: timestamp(value.sourceUpdatedAt),
    createdAt: timestamp(value.createdAt),
    associations: validateAssociations(value.associations),
  };
}

function validatePage(value, pageKeys) {
  exactKeys(value, ['key', 'chapterKey', 'title', 'rawMarkdown', 'createdAt', 'updatedAt', 'associations', 'revisions']);
  const revisions = new Set();
  return {
    key: uniqueKey(value.key, pageKeys, 'Page'),
    chapterKey: value.chapterKey === null ? null : string(value.chapterKey, { max: 200 }),
    title: title(value.title, NOTE_TITLE_MAX),
    rawMarkdown: string(value.rawMarkdown, { allowEmpty: true, max: BOOK_TRANSFER_LIMITS.manifestBytes }),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    associations: validateAssociations(value.associations),
    revisions: array(value.revisions).map((revision) => validateRevision(revision, revisions)),
  };
}

function validateChapter(value, chapterKeys) {
  exactKeys(value, ['key', 'title', 'createdAt', 'updatedAt', 'pageKeys']);
  return {
    key: uniqueKey(value.key, chapterKeys, 'Chapter'),
    title: title(value.title, CHAPTER_TITLE_MAX),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    pageKeys: array(value.pageKeys).map((key) => string(key, { max: 200 })),
  };
}

function validatePreviewSettings(value, pageByKey) {
  exactKeys(value, ['mode', 'randomCount', 'selectedPageKeys']);
  if (value.mode !== 'random' && value.mode !== 'selected') {
    throw invalid('The Book archive contains invalid preview settings.', 'INVALID_PREVIEW_REFERENCE');
  }
  if (!Number.isSafeInteger(value.randomCount) || value.randomCount < 1 || value.randomCount > 25) {
    throw invalid('The Book archive contains invalid preview settings.', 'INVALID_PREVIEW_REFERENCE');
  }
  const seen = new Set();
  const selectedPageKeys = array(value.selectedPageKeys).map((rawKey) => {
    const key = string(rawKey, { max: 200 });
    if (!pageByKey.has(key) || seen.has(key)) {
      throw invalid('The Book archive contains an invalid selected-preview Page reference.', 'INVALID_PREVIEW_REFERENCE');
    }
    seen.add(key);
    return key;
  });
  return { mode: value.mode, randomCount: value.randomCount, selectedPageKeys };
}

function validateMedia(value, { managed }) {
  exactKeys(value, managed
    ? ['path', 'mimeType', 'sizeBytes', 'width', 'height', 'sha256']
    : ['path', 'mimeType', 'sizeBytes', 'sha256']);
  const media = {
    path: normalizeEntryPath(value.path),
    mimeType: string(value.mimeType, { max: 100 }),
    sizeBytes: positiveInteger(value.sizeBytes),
    sha256: string(value.sha256, { max: 64 }),
  };
  if (!Object.hasOwn(MIME_FORMATS, media.mimeType) || !SHA256.test(media.sha256)
    || media.sizeBytes > BOOK_TRANSFER_LIMITS.coverBytes) {
    throw invalid('The Book archive contains invalid cover metadata.', 'INVALID_COVER_METADATA');
  }
  if (managed) {
    media.width = positiveInteger(value.width);
    media.height = positiveInteger(value.height);
    if (media.width > MANAGED_IMAGE_LIMITS.dimension || media.height > MANAGED_IMAGE_LIMITS.dimension
      || media.width * media.height > MANAGED_IMAGE_LIMITS.pixels) {
      throw invalid('The Book archive contains invalid cover metadata.', 'INVALID_COVER_METADATA');
    }
  }
  return media;
}

function validateCover(value, bookKey) {
  plainObject(value);
  if (value.kind === 'none') {
    exactKeys(value, ['kind']);
    return { kind: 'none' };
  }
  if (value.kind === 'managed') {
    exactKeys(value, ['kind', 'media']);
    const media = validateMedia(value.media, { managed: true });
    const expectedPath = `covers/${bookKey}/cover.${MIME_EXTENSIONS[media.mimeType]}`;
    if (media.path !== expectedPath) {
      throw invalid('The Book cover media path does not belong to its Book.', 'INVALID_COVER_METADATA');
    }
    return { kind: 'managed', media };
  }
  if (value.kind === 'project_asset') {
    exactKeys(value, ['kind', 'source', 'media']);
    const media = validateMedia(value.media, { managed: false });
    const expectedPath = `covers/${bookKey}/cover.webp`;
    if (media.mimeType !== 'image/webp' || media.path !== expectedPath) {
      throw invalid('The Book cover media path does not belong to its Book.', 'INVALID_COVER_METADATA');
    }
    return { kind: 'project_asset', source: validateAssetLocator(value.source), media };
  }
  throw invalid('The Book archive contains an invalid cover kind.', 'INVALID_COVER_METADATA');
}

function validateHierarchy(book) {
  const chapters = new Map(book.chapters.map((chapter) => [chapter.key, chapter]));
  const pages = new Map(book.pages.map((page) => [page.key, page]));
  const placedChapters = new Set();
  const placedPages = new Set();

  for (const item of book.rootContents) {
    exactKeys(item, ['type', 'key']);
    const key = string(item.key, { max: 200 });
    if (item.type === 'chapter') {
      if (!chapters.has(key) || placedChapters.has(key)) {
        throw invalid('The Book archive contains an invalid Chapter hierarchy reference.', 'INVALID_HIERARCHY_REFERENCE');
      }
      placedChapters.add(key);
      continue;
    }
    if (item.type !== 'page' || !pages.has(key) || pages.get(key).chapterKey !== null || placedPages.has(key)) {
      throw invalid('The Book archive contains an invalid Page hierarchy reference.', 'INVALID_HIERARCHY_REFERENCE');
    }
    placedPages.add(key);
  }

  for (const chapter of book.chapters) {
    const local = new Set();
    for (const key of chapter.pageKeys) {
      const page = pages.get(key);
      if (!page || page.chapterKey !== chapter.key || local.has(key) || placedPages.has(key)) {
        throw invalid('The Book archive contains an invalid Chapter Page reference.', 'INVALID_HIERARCHY_REFERENCE');
      }
      local.add(key);
      placedPages.add(key);
    }
  }
  if (placedChapters.size !== chapters.size || placedPages.size !== pages.size) {
    throw invalid('The Book archive hierarchy does not account for every Chapter and Page.', 'INVALID_HIERARCHY_REFERENCE');
  }
}

function validateBook(value, bookKeys) {
  exactKeys(value, ['key', 'title', 'createdAt', 'updatedAt', 'rootContents', 'chapters', 'pages', 'previewSettings', 'cover']);
  const key = uniqueKey(value.key, bookKeys, 'Book');
  const chapterKeys = new Set();
  const pageKeys = new Set();
  const book = {
    key,
    title: title(value.title, BOOK_TITLE_MAX),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    rootContents: array(value.rootContents),
    chapters: array(value.chapters).map((chapter) => validateChapter(chapter, chapterKeys)),
    pages: array(value.pages).map((page) => validatePage(page, pageKeys)),
    previewSettings: null,
    cover: validateCover(value.cover, key),
  };
  const pageByKey = new Map(book.pages.map((page) => [page.key, page]));
  book.previewSettings = validatePreviewSettings(value.previewSettings, pageByKey);
  validateHierarchy(book);
  return book;
}

async function validateCoverBytes(book, entries, declaredMediaPaths) {
  if (book.cover.kind === 'none') return;
  const { media } = book.cover;
  if (declaredMediaPaths.has(media.path)) {
    throw invalid('Two Books declare the same cover media entry.', 'DUPLICATE_ARCHIVE_ENTRY');
  }
  declaredMediaPaths.add(media.path);
  const bytes = entries.get(media.path);
  if (!bytes) throw invalid('A required Book cover media entry is missing.', 'MISSING_MEDIA');
  if (bytes.length !== media.sizeBytes) {
    throw invalid('A Book cover media entry has the wrong size.', 'MEDIA_SIZE_MISMATCH');
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== media.sha256) {
    throw invalid('A Book cover media entry has the wrong digest.', 'MEDIA_HASH_MISMATCH');
  }
  let metadata;
  try {
    metadata = await validateManagedImageBuffer(bytes);
  } catch (cause) {
    if (cause instanceof ManagedImageError && cause.code === 'INVALID_IMAGE') {
      throw invalid('A Book cover media entry is not a valid declared image.', 'INVALID_MEDIA_CONTENT', cause);
    }
    throw cause;
  }
  if (metadata.mimeType !== media.mimeType
    || (book.cover.kind === 'managed'
      && (metadata.width !== media.width || metadata.height !== media.height))) {
    throw invalid('A Book cover media entry is not a valid declared image.', 'INVALID_MEDIA_CONTENT');
  }
  media.bytes = Buffer.from(bytes);
}

function parseManifest(entries) {
  const manifestBytes = entries.get(BOOK_EXPORT_MANIFEST);
  if (!manifestBytes) throw invalid('The Book archive manifest is missing.', 'MISSING_MANIFEST');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  } catch (cause) {
    throw invalid('The Book archive manifest is not valid UTF-8 JSON.', 'INVALID_MANIFEST_JSON', cause);
  }
  let manifest;
  try { manifest = JSON.parse(source); }
  catch (cause) { throw invalid('The Book archive manifest is not valid JSON.', 'INVALID_MANIFEST_JSON', cause); }
  plainObject(manifest);
  if (manifest.format !== BOOK_EXPORT_FORMAT) {
    throw invalid('The archive is not a CreatorCrate Books archive.', 'WRONG_FORMAT');
  }
  if (manifest.version !== BOOK_EXPORT_VERSION) {
    throw invalid('The CreatorCrate Books archive version is not supported.', 'UNSUPPORTED_VERSION');
  }
  exactKeys(manifest, ['format', 'version', 'books']);
  if (!Array.isArray(manifest.books)) {
    throw invalid('The Book archive manifest contains an invalid list.');
  }
  if (manifest.books.length < 1) {
    throw invalid('The Book archive manifest must contain at least one Book.');
  }
  if (manifest.books.length > BOOK_TRANSFER_LIMITS.maximumBooks) {
    throw invalid('The Book archive exceeds the allowed resource limits.', 'ARCHIVE_LIMIT_EXCEEDED');
  }
  const bookKeys = new Set();
  return {
    format: manifest.format,
    version: manifest.version,
    books: array(manifest.books).map((book) => validateBook(book, bookKeys)),
  };
}

export async function parseBookImportArchive(archiveBytes) {
  const entries = await readArchive(archiveBytes);
  const result = parseManifest(entries);
  const declaredMediaPaths = new Set();
  for (const book of result.books) await validateCoverBytes(book, entries, declaredMediaPaths);
  const allowed = new Set([BOOK_EXPORT_MANIFEST, ...declaredMediaPaths]);
  for (const name of entries.keys()) {
    if (!allowed.has(name)) throw invalid('The Book archive contains an undeclared payload entry.', 'UNDECLARED_ENTRY');
  }
  return result;
}

function truncateWithoutSplittingSurrogate(value, maxLength) {
  let truncated = value.slice(0, maxLength);
  if (truncated.length > 0 && /[\uD800-\uDBFF]/.test(truncated.at(-1))) truncated = truncated.slice(0, -1);
  return truncated;
}

export function planBookImportTitles(incomingBooks, existingTitles) {
  if (!Array.isArray(incomingBooks) || existingTitles == null || typeof existingTitles[Symbol.iterator] !== 'function') {
    throw invalid('Book title collision planning inputs are invalid.', 'INVALID_TITLE_PLAN');
  }
  const occupied = new Set();
  for (const existing of existingTitles) {
    if (typeof existing !== 'string') throw invalid('Existing Book titles must be strings.', 'INVALID_TITLE_PLAN');
    occupied.add(existing);
  }
  return incomingBooks.map((book) => {
    const sourceTitle = book?.title;
    if (typeof sourceTitle !== 'string') throw invalid('Incoming Book titles must be strings.', 'INVALID_TITLE_PLAN');
    const base = sourceTitle.trim();
    if (!base) throw invalid('An incoming Book title is empty after trimming.', 'INVALID_TITLE_PLAN');
    let destinationTitle = truncateWithoutSplittingSurrogate(base, BOOK_TITLE_MAX);
    if (!occupied.has(destinationTitle)) {
      occupied.add(destinationTitle);
      return { sourceKey: book.key, sourceTitle, destinationTitle };
    }
    for (let index = 1; ; index += 1) {
      const suffix = `-${index}`;
      const stem = truncateWithoutSplittingSurrogate(base, BOOK_TITLE_MAX - suffix.length);
      if (!stem) throw invalid('An incoming Book title cannot fit a collision suffix.', 'INVALID_TITLE_PLAN');
      destinationTitle = `${stem}${suffix}`;
      if (!occupied.has(destinationTitle)) {
        occupied.add(destinationTitle);
        return { sourceKey: book.key, sourceTitle, destinationTitle };
      }
    }
  });
}
