import { createAssetRepository } from '../data/asset-repository.js';
import { createBookPrimaryImageRepository } from '../data/book-primary-image-repository.js';
import { createBookRepository } from '../data/book-repository.js';
import { buildPrimaryImageModelForAsset } from './primary-image-presenter.js';
import { classifyPreviewable } from './preview-service.js';

export const BOOK_PRIMARY_IMAGE_ERROR_CODES = Object.freeze({
  INVALID_ID: 'INVALID_ID',
  BOOK_NOT_FOUND: 'BOOK_NOT_FOUND',
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
  ASSET_MISSING: 'ASSET_MISSING',
  ASSET_UNSUPPORTED: 'ASSET_UNSUPPORTED',
  STALE_CLEAR: 'STALE_CLEAR',
  DATABASE_ERROR: 'DATABASE_ERROR',
});

const ERROR_STATUS = Object.freeze({
  INVALID_ID: 422,
  BOOK_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  ASSET_MISSING: 422,
  ASSET_UNSUPPORTED: 422,
  STALE_CLEAR: 409,
  DATABASE_ERROR: 500,
});

export class BookPrimaryImageError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookPrimaryImageError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
  }
}

function assertCanonicalPositiveId(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BookPrimaryImageError(
      `${label} must be a positive integer.`,
      { code: BOOK_PRIMARY_IMAGE_ERROR_CODES.INVALID_ID },
    );
  }
}

/**
 * Book primary-image domain service.
 *
 * A book selection deliberately has no asset ownership constraint: a book can
 * select any retained asset, including one from an archived project.
 *
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<typeof createBookRepository>} [deps.bookRepository]
 * @param {ReturnType<typeof createAssetRepository>} [deps.assetRepository]
 * @param {ReturnType<typeof createBookPrimaryImageRepository>} [deps.bookPrimaryImageRepository]
 * @param {(project: object|number, asset: object) => {quality?: string}|Promise<{quality?: string}>} [deps.previewProbe]
 * @param {object} [deps.applicationLogger]
 */
export function createBookPrimaryImageService({
  db,
  bookRepository,
  assetRepository,
  bookPrimaryImageRepository,
  previewProbe,
  applicationLogger = null,
} = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('createBookPrimaryImageService requires a db dependency.');
  }

  const books = bookRepository ?? createBookRepository(db);
  const assets = assetRepository ?? createAssetRepository(db);
  const primaryImages = bookPrimaryImageRepository ?? createBookPrimaryImageRepository(db);

  function requireBook(bookId) {
    const book = books.findById(bookId);
    if (!book) {
      throw new BookPrimaryImageError(
        `Book ${bookId} not found.`,
        { code: BOOK_PRIMARY_IMAGE_ERROR_CODES.BOOK_NOT_FOUND },
      );
    }
    return book;
  }

  function requireAsset(assetId) {
    const asset = assets.findById(assetId);
    if (!asset) {
      throw new BookPrimaryImageError(
        `Asset ${assetId} not found.`,
        { code: BOOK_PRIMARY_IMAGE_ERROR_CODES.ASSET_NOT_FOUND },
      );
    }
    return asset;
  }

  function unsupportedAsset(assetId, cause) {
    return new BookPrimaryImageError(
      `Asset ${assetId} is not supported as a primary image.`,
      { code: BOOK_PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED, cause },
    );
  }

  function requireEligiblePresentAsset(assetId, { kritaQuality = null } = {}) {
    const asset = requireAsset(assetId);
    if (asset.is_present !== 1 && asset.is_present !== true) {
      throw new BookPrimaryImageError(
        `Asset ${assetId} is marked missing and cannot be selected.`,
        { code: BOOK_PRIMARY_IMAGE_ERROR_CODES.ASSET_MISSING },
      );
    }

    const classification = classifyPreviewable(asset);
    if (!classification.supported) throw unsupportedAsset(assetId);
    if (classification.kind === 'image') return asset;
    if (
      classification.kind === 'krita'
      && classification.extension === 'kra'
      && kritaQuality === 'merged'
    ) {
      return asset;
    }
    throw unsupportedAsset(assetId);
  }

  function databaseFailure(err) {
    if (err instanceof BookPrimaryImageError) return err;
    return new BookPrimaryImageError(
      'Primary image operation failed due to a database error.',
      { code: BOOK_PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR, cause: err },
    );
  }

  function logActivity(event, context, projectId = null) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'notes',
        message: 'Book primary image activity completed.',
        projectId,
        context,
      });
    } catch {
      // Activity logging must never alter the completed primary-image operation.
    }
  }

  const setPrimaryImageTx = db.transaction((bookId, assetId, kritaQuality = null) => {
    requireBook(bookId);
    const asset = requireEligiblePresentAsset(assetId, { kritaQuality });
    const outcome = primaryImages.setPrimaryImageWithOutcome(bookId, asset.id);
    const stored = outcome.selection;
    if (!stored || stored.book_id !== bookId || stored.asset_id !== assetId) {
      throw new Error('Primary image repository returned an invalid selection.');
    }
    return {
      stored,
      changed: outcome.changed,
      projectId: asset.project_id,
    };
  });

  function setPrimaryImage(bookId, assetId) {
    assertCanonicalPositiveId(bookId, 'bookId');
    assertCanonicalPositiveId(assetId, 'assetId');

    requireBook(bookId);
    const asset = requireAsset(assetId);
    if (asset.is_present !== 1 && asset.is_present !== true) {
      return setPrimaryImageTx(bookId, assetId);
    }

    const classification = classifyPreviewable(asset);
    const isMergedKraCandidate = classification.supported
      && classification.kind === 'krita'
      && classification.extension === 'kra';
    if (!isMergedKraCandidate) return setPrimaryImageTx(bookId, assetId);
    if (typeof previewProbe !== 'function') throw unsupportedAsset(assetId);

    const acceptMerged = (result) => {
      if (result?.quality !== 'merged') throw unsupportedAsset(assetId);
      try {
        return setPrimaryImageTx(bookId, assetId, 'merged');
      } catch (err) {
        throw databaseFailure(err);
      }
    };
    const mapProbeFailure = (err) => {
      if (err instanceof BookPrimaryImageError) throw err;
      throw unsupportedAsset(assetId, err);
    };

    try {
      // The preview service probes the asset's owning project directory. A
      // Book may select an asset from any project, so the Book cannot supply
      // that filesystem context.
      const result = previewProbe(asset.project_id, asset);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(acceptMerged, mapProbeFailure);
      }
      return acceptMerged(result);
    } catch (err) {
      throw err instanceof BookPrimaryImageError ? err : unsupportedAsset(assetId, err);
    }
  }

  const clearPrimaryImageTx = db.transaction((bookId, expectedAssetId) => {
    requireBook(bookId);
    const removed = primaryImages.clearPrimaryImageIfMatches(bookId, expectedAssetId);
    if (!removed) {
      throw new BookPrimaryImageError(
        `Primary image selection for book ${bookId} no longer matches asset ${expectedAssetId}.`,
        { code: BOOK_PRIMARY_IMAGE_ERROR_CODES.STALE_CLEAR },
      );
    }
    return true;
  });

  const getPrimaryImageTx = db.transaction((bookId) => {
    requireBook(bookId);
    const selection = primaryImages.findByBookId(bookId);
    if (!selection) return undefined;

    const asset = assets.findById(selection.asset_id);
    if (!asset) throw new Error('Primary image selection references an unavailable asset.');
    return asset;
  });

  function attachPrimaryImages(bookRows) {
    if (!Array.isArray(bookRows) || bookRows.length === 0) return [];

    try {
      const selections = primaryImages.findByBookIds(bookRows.map((book) => book.id));
      const selectionByBookId = new Map(
        selections.map((selection) => [selection.book_id, selection]),
      );
      const assetIds = [...new Set(
        selections.map((selection) => selection.asset_id).filter((assetId) => assetId != null),
      )];
      const selectedAssets = assetIds.length > 0 ? assets.findByIds(assetIds) : [];
      const assetById = new Map(selectedAssets.map((asset) => [asset.id, asset]));

      return bookRows.map((book) => {
        const selection = selectionByBookId.get(book.id);
        return {
          ...book,
          primaryImage: buildPrimaryImageModelForAsset(
            selection,
            selection ? assetById.get(selection.asset_id) : null,
          ),
        };
      });
    } catch (err) {
      throw databaseFailure(err);
    }
  }

  return {
    getPrimaryImage(bookId) {
      assertCanonicalPositiveId(bookId, 'bookId');
      try {
        return getPrimaryImageTx(bookId);
      } catch (err) {
        throw databaseFailure(err);
      }
    },

    setPrimaryImage(bookId, assetId) {
      try {
        const result = setPrimaryImage(bookId, assetId);
        const logSelection = (outcome) => {
          if (outcome.changed) {
            logActivity(
              'book.primary_image.set',
              { bookId, assetId: outcome.stored.asset_id },
              outcome.projectId,
            );
          }
          return outcome.stored;
        };
        return result && typeof result.then === 'function'
          ? result.then(logSelection)
          : logSelection(result);
      } catch (err) {
        throw databaseFailure(err);
      }
    },

    clearPrimaryImage(bookId, expectedAssetId) {
      assertCanonicalPositiveId(bookId, 'bookId');
      assertCanonicalPositiveId(expectedAssetId, 'expectedAssetId');
      try {
        const cleared = clearPrimaryImageTx(bookId, expectedAssetId);
        logActivity('book.primary_image.cleared', { bookId, assetId: expectedAssetId });
        return cleared;
      } catch (err) {
        throw databaseFailure(err);
      }
    },

    listBooksForAsset(assetId) {
      assertCanonicalPositiveId(assetId, 'assetId');
      try {
        const selectedBookIds = new Set(
          primaryImages.findByAssetId(assetId).map((selection) => selection.book_id),
        );
        if (selectedBookIds.size === 0) return [];
        return books.list().filter((book) => selectedBookIds.has(book.id));
      } catch (err) {
        throw databaseFailure(err);
      }
    },

    attachPrimaryImages,
  };
}
