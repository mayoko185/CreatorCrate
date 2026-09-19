import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeArchiveFile } from './archive-processing.js';
import {
  BOOK_TRANSFER_LIMITS,
  isBookTransferUncompressedSizeAllowed,
} from './book-transfer-limits.js';
import { ManagedMediaError } from './managed-media-service.js';
import {
  MediaNotFoundError,
  MediaUnavailableError,
  MediaUnsupportedError,
} from './media-service.js';

export const BOOK_EXPORT_FORMAT = 'creatorcrate-books';
export const BOOK_EXPORT_VERSION = 1;
export const BOOK_EXPORT_MANIFEST = 'creatorcrate-books.json';

const DEFAULT_PREVIEW_MODE = 'random';
const DEFAULT_RANDOM_COUNT = 5;

export class BookExportError extends Error {
  constructor(message, { code, status = 500, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookExportError';
    this.code = code;
    this.status = status;
  }
}

function exportError(message, code, status, cause) {
  return new BookExportError(message, { code, status, cause });
}

function coverUnavailableError(cause) {
  return exportError('A required Book cover is unavailable.', 'COVER_UNAVAILABLE', 409, cause);
}

function exportAssemblyError(cause) {
  return exportError('The Book export could not be assembled.', 'EXPORT_ASSEMBLY_FAILED', 500, cause);
}

function transferLimitError() {
  return exportError(
    'The selected Books exceed the supported transfer limits.',
    'EXPORT_LIMIT_EXCEEDED',
    422,
  );
}

function isKnownCoverAvailabilityError(error) {
  return error instanceof ManagedMediaError
    || error instanceof MediaNotFoundError
    || error instanceof MediaUnavailableError
    || error instanceof MediaUnsupportedError;
}

function isVerificationSourceStateError(error) {
  return error instanceof BookExportError
    && ['BOOK_NOT_FOUND', 'COVER_UNAVAILABLE', 'EXPORT_INTEGRITY_ERROR'].includes(error.code);
}

function assertRequestedIds(bookIds) {
  if (!Array.isArray(bookIds) || bookIds.length === 0) {
    throw exportError('Select at least one Book to export.', 'EMPTY_SELECTION', 422);
  }
  if (bookIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw exportError('Book IDs must be positive integers.', 'MALFORMED_SELECTION', 422);
  }
  const requestedIds = [...new Set(bookIds)];
  if (requestedIds.length > BOOK_TRANSFER_LIMITS.maximumBooks) throw transferLimitError();
  return requestedIds;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function mediaExtension(mimeType) {
  const extension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  }[mimeType];
  if (!extension) throw exportError('A required Book cover is unavailable.', 'COVER_UNAVAILABLE', 409);
  return extension;
}

function projectLocator(row) {
  return {
    slug: row.project_slug,
    title: row.project_title,
    projectType: row.project_type,
  };
}

function assetLocator(row) {
  return {
    project: projectLocator(row),
    relativePath: row.relative_path,
    filename: row.filename,
    extension: row.extension,
    mimeType: row.mime_type,
  };
}

function parseRevisionIds(payload, label) {
  let ids;
  try { ids = JSON.parse(payload); } catch { ids = null; }
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw exportError(`A retained Page revision has invalid ${label}.`, 'EXPORT_INTEGRITY_ERROR', 500);
  }
  return [...new Set(ids)].sort((left, right) => left - right);
}

function associationLocators(ids, findRow, toLocator) {
  const locators = [];
  let unresolvedCount = 0;
  for (const id of ids) {
    const row = findRow(id);
    if (row) locators.push(toLocator(row));
    else unresolvedCount += 1;
  }
  return { locators, unresolvedCount };
}

function currentAssociations(projectRows, assetRows) {
  return {
    projects: projectRows.map(projectLocator),
    assets: assetRows.map(assetLocator),
    unresolvedProjectCount: 0,
    unresolvedAssetCount: 0,
  };
}

function snapshotFactory(db) {
  const listBooks = db.prepare('SELECT id, title, sort_order, created_at, updated_at FROM books ORDER BY sort_order ASC, id ASC');
  const listChapters = db.prepare('SELECT id, book_id, title, sort_order, created_at, updated_at FROM chapters WHERE book_id = ? ORDER BY sort_order ASC, id ASC');
  const listPages = db.prepare('SELECT id, book_id, chapter_id, title, content, sort_order, created_at, updated_at FROM notes WHERE book_id = ? ORDER BY id ASC');
  const listRootContents = db.prepare('SELECT item_type, item_id, sort_order FROM book_contents WHERE book_id = ? ORDER BY sort_order ASC');
  const listRevisions = db.prepare(`SELECT id, note_id, title, content, project_ids_json, asset_ids_json,
    source_updated_at, created_at FROM note_revisions WHERE note_id = ? ORDER BY id DESC`);
  const getPreviewSettings = db.prepare('SELECT mode, random_count FROM book_page_preview_settings WHERE book_id = ?');
  const listSelectedPreviews = db.prepare('SELECT page_id FROM book_page_preview_pages WHERE book_id = ? ORDER BY page_id ASC');
  const getCover = db.prepare(`
    SELECT selection.asset_id, selection.managed_asset_id,
      managed.mime_type AS managed_mime_type,
      asset.project_id, asset.relative_path, asset.filename, asset.extension, asset.mime_type,
      asset.size_bytes, asset.modified_at, asset.is_present,
      project.slug AS project_slug, project.title AS project_title, project.project_type
    FROM book_primary_images AS selection
    LEFT JOIN managed_assets AS managed ON managed.id = selection.managed_asset_id
    LEFT JOIN assets AS asset ON asset.id = selection.asset_id
    LEFT JOIN projects AS project ON project.id = asset.project_id
    WHERE selection.book_id = ?
  `);
  const listPageProjects = db.prepare(`
    SELECT project.slug AS project_slug, project.title AS project_title, project.project_type
    FROM note_projects AS link JOIN projects AS project ON project.id = link.project_id
    WHERE link.note_id = ? ORDER BY link.project_id ASC
  `);
  const listPageAssets = db.prepare(`
    SELECT project.slug AS project_slug, project.title AS project_title, project.project_type,
      asset.relative_path, asset.filename, asset.extension, asset.mime_type
    FROM note_assets AS link
    JOIN assets AS asset ON asset.id = link.asset_id
    JOIN projects AS project ON project.id = asset.project_id
    WHERE link.note_id = ? ORDER BY link.asset_id ASC
  `);
  const findProject = db.prepare('SELECT slug AS project_slug, title AS project_title, project_type FROM projects WHERE id = ?');
  const findAsset = db.prepare(`
    SELECT project.slug AS project_slug, project.title AS project_title, project.project_type,
      asset.relative_path, asset.filename, asset.extension, asset.mime_type
    FROM assets AS asset JOIN projects AS project ON project.id = asset.project_id
    WHERE asset.id = ?
  `);

  return db.transaction((requestedIds) => {
    const requested = new Set(requestedIds);
    const books = listBooks.all().filter((book) => requested.has(book.id));
    if (books.length !== requested.size) {
      throw exportError('One or more requested Books no longer exist.', 'BOOK_NOT_FOUND', 404);
    }

    return books.map((book, bookIndex) => {
      const bookKey = `book-${bookIndex + 1}`;
      const chapters = listChapters.all(book.id);
      const pages = listPages.all(book.id);
      const rootRows = listRootContents.all(book.id);
      const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
      const pageById = new Map(pages.map((page) => [page.id, page]));
      const expectedRootKeys = new Set([
        ...chapters.map((chapter) => `chapter:${chapter.id}`),
        ...pages.filter((page) => page.chapter_id === null).map((page) => `page:${page.id}`),
      ]);
      const rootKeys = rootRows.map((row) => `${row.item_type}:${row.item_id}`);
      if (rootKeys.length !== expectedRootKeys.size || new Set(rootKeys).size !== rootKeys.length
        || rootKeys.some((key) => !expectedRootKeys.has(key))) {
        throw exportError('A selected Book has an inconsistent root hierarchy.', 'EXPORT_INTEGRITY_ERROR', 500);
      }

      const orderedPages = [];
      for (const root of rootRows) {
        if (root.item_type === 'page') {
          const page = pageById.get(root.item_id);
          if (!page || page.chapter_id !== null) {
            throw exportError('A selected Book has an inconsistent Page hierarchy.', 'EXPORT_INTEGRITY_ERROR', 500);
          }
          orderedPages.push(page);
          continue;
        }
        const chapter = chapterById.get(root.item_id);
        if (!chapter) {
          throw exportError('A selected Book has an inconsistent Chapter hierarchy.', 'EXPORT_INTEGRITY_ERROR', 500);
        }
        orderedPages.push(...pages.filter((page) => page.chapter_id === chapter.id)
          .sort((left, right) => left.sort_order - right.sort_order || left.id - right.id));
      }
      if (orderedPages.length !== pages.length || new Set(orderedPages.map((page) => page.id)).size !== pages.length) {
        throw exportError('A selected Book has Pages outside its canonical hierarchy.', 'EXPORT_INTEGRITY_ERROR', 500);
      }

      const chapterKeys = new Map(chapters.map((chapter, index) => [chapter.id, `chapter-${index + 1}`]));
      const pageKeys = new Map(orderedPages.map((page, index) => [page.id, `page-${index + 1}`]));
      const exportedPages = orderedPages.map((page) => ({
        key: pageKeys.get(page.id),
        chapterKey: page.chapter_id === null ? null : chapterKeys.get(page.chapter_id),
        title: page.title,
        rawMarkdown: page.content,
        createdAt: page.created_at,
        updatedAt: page.updated_at,
        associations: currentAssociations(listPageProjects.all(page.id), listPageAssets.all(page.id)),
        revisions: listRevisions.all(page.id).map((revision, revisionIndex) => {
          const revisionProjects = associationLocators(
            parseRevisionIds(revision.project_ids_json, 'Project associations'),
            (id) => findProject.get(id), projectLocator,
          );
          const revisionAssets = associationLocators(
            parseRevisionIds(revision.asset_ids_json, 'Asset associations'),
            (id) => findAsset.get(id), assetLocator,
          );
          return {
            key: `revision-${revisionIndex + 1}`,
            title: revision.title,
            rawMarkdown: revision.content,
            sourceUpdatedAt: revision.source_updated_at,
            createdAt: revision.created_at,
            associations: {
              projects: revisionProjects.locators,
              assets: revisionAssets.locators,
              unresolvedProjectCount: revisionProjects.unresolvedCount,
              unresolvedAssetCount: revisionAssets.unresolvedCount,
            },
          };
        }),
      }));

      const previewRow = getPreviewSettings.get(book.id);
      const selectedPageKeys = listSelectedPreviews.all(book.id).map(({ page_id: pageId }) => {
        const key = pageKeys.get(pageId);
        if (!key) throw exportError('A selected preview Page is outside its Book.', 'EXPORT_INTEGRITY_ERROR', 500);
        return key;
      });

      const coverRow = getCover.get(book.id);
      let coverSource = null;
      if (coverRow?.managed_asset_id != null) {
        if (!coverRow.managed_mime_type) throw exportError('A required Book cover is unavailable.', 'COVER_UNAVAILABLE', 409);
        coverSource = { kind: 'managed_asset', internalId: coverRow.managed_asset_id };
      } else if (coverRow?.asset_id != null) {
        if (!coverRow.project_slug || !coverRow.relative_path) {
          throw exportError('A required Book cover is unavailable.', 'COVER_UNAVAILABLE', 409);
        }
        coverSource = {
          kind: 'project_asset',
          internalProjectId: coverRow.project_id,
          internalAssetId: coverRow.asset_id,
          sourceAuthority: {
            relativePath: coverRow.relative_path,
            sizeBytes: coverRow.size_bytes,
            modifiedAt: coverRow.modified_at,
            isPresent: coverRow.is_present,
          },
          locator: assetLocator(coverRow),
        };
      }

      return {
        internalBookId: book.id,
        coverSource,
        manifest: {
          key: bookKey,
          title: book.title,
          createdAt: book.created_at,
          updatedAt: book.updated_at,
          rootContents: rootRows.map((row) => ({
            type: row.item_type,
            key: row.item_type === 'chapter' ? chapterKeys.get(row.item_id) : pageKeys.get(row.item_id),
          })),
          chapters: chapters.map((chapter) => ({
            key: chapterKeys.get(chapter.id),
            title: chapter.title,
            createdAt: chapter.created_at,
            updatedAt: chapter.updated_at,
            pageKeys: orderedPages.filter((page) => page.chapter_id === chapter.id)
              .map((page) => pageKeys.get(page.id)),
          })),
          pages: exportedPages,
          previewSettings: {
            mode: previewRow?.mode ?? DEFAULT_PREVIEW_MODE,
            randomCount: previewRow?.random_count ?? DEFAULT_RANDOM_COUNT,
            selectedPageKeys,
          },
          cover: { kind: 'none' },
        },
      };
    });
  });
}

function preparedContentLength(prepared) {
  const headerValue = typeof prepared.headers?.get === 'function'
    ? prepared.headers.get('Content-Length')
    : prepared.headers?.['Content-Length'] ?? prepared.headers?.['content-length'];
  if (typeof headerValue !== 'string' || !/^\d+$/.test(headerValue)) return null;
  const byteLength = Number(headerValue);
  return Number.isSafeInteger(byteLength) ? byteLength : null;
}

async function readPreparedResponse(prepared, maximumBytes) {
  const chunks = [];
  let byteLength = 0;
  try {
    const declaredByteLength = preparedContentLength(prepared);
    if (declaredByteLength !== null && declaredByteLength > maximumBytes) {
      prepared.stream.destroy?.();
      throw transferLimitError();
    }
    for await (const chunk of prepared.stream) {
      const bytes = Buffer.from(chunk);
      if (bytes.length > maximumBytes - byteLength) {
        prepared.stream.destroy?.();
        throw transferLimitError();
      }
      chunks.push(bytes);
      byteLength += bytes.length;
    }
    return Buffer.concat(chunks, byteLength);
  } finally {
    prepared.cleanup?.();
  }
}

function cleanupDirectory(directory) {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}

export function createBookExportService({ db, managedMediaService, mediaService,
  tempRoot = os.tmpdir(), archiveWriter = writeArchiveFile } = {}) {
  if (!db || typeof db.transaction !== 'function') throw new Error('createBookExportService requires a database dependency.');
  if (!managedMediaService || typeof managedMediaService.resolveSource !== 'function') {
    throw new Error('createBookExportService requires managed-media source resolution.');
  }
  const captureSnapshot = snapshotFactory(db);

  async function resolveCover(exportedBook, maximumProjectCoverBytes) {
    const source = exportedBook.coverSource;
    if (!source) return null;
    try {
      if (source.kind === 'managed_asset') {
        const resolved = await managedMediaService.resolveSource(source.internalId);
        const archivePath = `covers/${exportedBook.manifest.key}/cover.${mediaExtension(resolved.record.mime_type)}`;
        return {
          entry: { name: archivePath, buffer: resolved.bytes },
          manifest: { kind: 'managed', media: { path: archivePath, mimeType: resolved.record.mime_type,
            sizeBytes: resolved.bytes.length, width: resolved.record.width, height: resolved.record.height,
            sha256: sha256(resolved.bytes) } },
        };
      }
      if (!mediaService || typeof mediaService.prepareDerivativeResponse !== 'function') throw new Error('Project media unavailable.');
      const prepared = await mediaService.prepareDerivativeResponse('preview', source.internalProjectId, source.internalAssetId);
      const bytes = await readPreparedResponse(prepared, maximumProjectCoverBytes);
      const archivePath = `covers/${exportedBook.manifest.key}/cover.webp`;
      return {
        entry: { name: archivePath, buffer: bytes },
        manifest: { kind: 'project_asset', source: source.locator,
          media: { path: archivePath, mimeType: 'image/webp', sizeBytes: bytes.length, sha256: sha256(bytes) } },
      };
    } catch (cause) {
      if (cause instanceof BookExportError) throw cause;
      if (isKnownCoverAvailabilityError(cause)) throw coverUnavailableError(cause);
      throw exportAssemblyError(cause);
    }
  }

  return Object.freeze({
    async createExport(bookIds) {
      const requestedIds = assertRequestedIds(bookIds);
      let snapshot;
      try { snapshot = captureSnapshot(requestedIds); }
      catch (cause) {
        if (cause instanceof BookExportError) throw cause;
        throw exportAssemblyError(cause);
      }

      const coverEntries = [];
      let coverBytes = 0;
      for (const exportedBook of snapshot) {
        const remainingTransferBytes = BOOK_TRANSFER_LIMITS.totalUncompressedBytes - coverBytes;
        const maximumProjectCoverBytes = Math.min(
          BOOK_TRANSFER_LIMITS.coverBytes,
          remainingTransferBytes,
        );
        const resolved = await resolveCover(exportedBook, maximumProjectCoverBytes);
        if (resolved) {
          if (resolved.entry.buffer.length > BOOK_TRANSFER_LIMITS.coverBytes) throw transferLimitError();
          coverBytes += resolved.entry.buffer.length;
          if (!isBookTransferUncompressedSizeAllowed(coverBytes)) throw transferLimitError();
          exportedBook.manifest.cover = resolved.manifest;
          coverEntries.push(resolved.entry);
        }
      }

      let verification;
      try { verification = captureSnapshot(requestedIds); }
      catch (cause) {
        if (isVerificationSourceStateError(cause)) {
          throw exportError('The selected Books changed during export. Please try again.', 'EXPORT_CHANGED', 409, cause);
        }
        throw exportAssemblyError(cause);
      }
      const stableSnapshot = snapshot.map(({ manifest, ...row }) => ({ ...row, manifest: { ...manifest, cover: { kind: 'none' } } }));
      if (JSON.stringify(stableSnapshot) !== JSON.stringify(verification)) {
        throw exportError('The selected Books changed during export. Please try again.', 'EXPORT_CHANGED', 409);
      }

      const manifest = { format: BOOK_EXPORT_FORMAT, version: BOOK_EXPORT_VERSION,
        books: snapshot.map(({ manifest: exported }) => exported) };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      if (manifestBytes.length > BOOK_TRANSFER_LIMITS.manifestBytes
        || !isBookTransferUncompressedSizeAllowed(manifestBytes.length + coverBytes)) {
        throw transferLimitError();
      }
      const entries = [{ name: BOOK_EXPORT_MANIFEST, buffer: manifestBytes }, ...coverEntries];
      if (entries.length > BOOK_TRANSFER_LIMITS.maximumFileEntries) throw transferLimitError();
      let directory;
      try {
        directory = fs.mkdtempSync(path.join(tempRoot, 'creatorcrate-books-export-'));
        const filePath = path.join(directory, 'creatorcrate-books.zip');
        await archiveWriter(filePath, 'zip', entries);
        if (fs.statSync(filePath).size > BOOK_TRANSFER_LIMITS.compressedArchiveBytes) {
          throw transferLimitError();
        }
        let cleaned = false;
        return { filePath, filename: 'creatorcrate-books.zip', cleanup() {
          if (cleaned) return;
          cleaned = true;
          cleanupDirectory(directory);
        } };
      } catch (cause) {
        cleanupDirectory(directory);
        if (cause instanceof BookExportError) throw cause;
        throw exportError('The Book archive could not be created.', 'ARCHIVE_WRITE_FAILED', 500, cause);
      }
    },
  });
}
