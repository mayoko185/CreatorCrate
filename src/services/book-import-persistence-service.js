import { createBookImportPersistenceRepository } from '../data/book-import-persistence-repository.js';
import { planBookImportTitles } from './book-import-service.js';

export class BookImportPersistenceError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookImportPersistenceError';
    this.code = code;
    this.status = 500;
  }
}

function integrityError(message) {
  return new BookImportPersistenceError(message, { code: 'IMPORT_INTEGRITY_ERROR' });
}

function persistenceError(cause) {
  return new BookImportPersistenceError('The validated Book import could not be persisted.', {
    code: 'IMPORT_PERSISTENCE_FAILED',
    cause,
  });
}

function requireMappedId(mapping, key, entityName) {
  const id = mapping.get(key);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw integrityError(`The validated import is missing a destination ${entityName} mapping for ${key}.`);
  }
  return id;
}

function buildPageSortOrders(book) {
  const rootPageOrders = new Map();
  let nextRootPageOrder = 0;
  for (const item of book.rootContents) {
    if (item.type === 'page') {
      rootPageOrders.set(item.key, nextRootPageOrder);
      nextRootPageOrder += 1;
    }
  }

  const chapterPageOrders = new Map();
  for (const chapter of book.chapters) {
    chapterPageOrders.set(
      chapter.key,
      new Map(chapter.pageKeys.map((pageKey, index) => [pageKey, index])),
    );
  }
  return { rootPageOrders, chapterPageOrders };
}

function pageSortOrder(page, pageOrders) {
  const mapping = page.chapterKey === null
    ? pageOrders.rootPageOrders
    : pageOrders.chapterPageOrders.get(page.chapterKey);
  const sortOrder = mapping?.get(page.key);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
    throw integrityError(`The validated import is missing the hierarchy position for Page ${page.key}.`);
  }
  return sortOrder;
}

function deferredAssociations(book) {
  return new Map(book.pages.map((page) => [page.key, {
    page: page.associations,
    revisions: new Map(page.revisions.map((revision) => [revision.key, revision.associations])),
  }]));
}

/**
 * Persist a validated WP7 Book plan. The service owns one outer IMMEDIATE
 * transaction; the injected repository must expose non-transactional write
 * primitives so every Book in the plan shares that transaction.
 */
export function createBookImportPersistenceService({
  db,
  repository = db ? createBookImportPersistenceRepository(db) : undefined,
} = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new TypeError('createBookImportPersistenceService requires a database.');
  }
  if (!repository) {
    throw new TypeError('createBookImportPersistenceService requires a repository.');
  }

  function persistCore(validatedPlan) {
    const books = validatedPlan?.books;
    if (!Array.isArray(books) || books.length === 0) {
      throw integrityError('Book import persistence requires a non-empty validated WP7 plan.');
    }

    const titlePlan = planBookImportTitles(books, repository.listBookTitles());
    const titleByBookKey = new Map(titlePlan.map((entry) => [entry.sourceKey, entry]));
    let nextBookSortOrder = repository.nextBookSortOrder();
    const results = [];

    for (const book of books) {
      const plannedTitle = titleByBookKey.get(book.key);
      if (!plannedTitle) {
        throw integrityError(`The validated import is missing a title plan for Book ${book.key}.`);
      }

      const persistedBook = repository.insertBook({
        title: plannedTitle.destinationTitle,
        sortOrder: nextBookSortOrder,
        createdAt: book.createdAt,
        updatedAt: book.updatedAt,
      });
      nextBookSortOrder += 1;

      const chapterIdsBySourceKey = new Map();
      for (let index = 0; index < book.chapters.length; index += 1) {
        const chapter = book.chapters[index];
        const persistedChapter = repository.insertChapter({
          bookId: persistedBook.id,
          title: chapter.title,
          sortOrder: index,
          createdAt: chapter.createdAt,
          updatedAt: chapter.updatedAt,
        });
        chapterIdsBySourceKey.set(chapter.key, persistedChapter.id);
      }

      const pageIdsBySourceKey = new Map();
      const pageOrders = buildPageSortOrders(book);
      for (const page of book.pages) {
        const chapterId = page.chapterKey === null
          ? null
          : requireMappedId(chapterIdsBySourceKey, page.chapterKey, 'Chapter');
        const persistedPage = repository.insertPage({
          bookId: persistedBook.id,
          chapterId,
          title: page.title,
          content: page.rawMarkdown,
          sortOrder: pageSortOrder(page, pageOrders),
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        });
        pageIdsBySourceKey.set(page.key, persistedPage.id);
      }

      for (let index = 0; index < book.rootContents.length; index += 1) {
        const item = book.rootContents[index];
        const itemId = item.type === 'chapter'
          ? requireMappedId(chapterIdsBySourceKey, item.key, 'Chapter')
          : requireMappedId(pageIdsBySourceKey, item.key, 'Page');
        repository.insertBookContent({
          bookId: persistedBook.id,
          itemType: item.type,
          itemId,
          sortOrder: index,
        });
      }

      const revisionIdsByPageKey = new Map();
      for (const page of book.pages) {
        const noteId = requireMappedId(pageIdsBySourceKey, page.key, 'Page');
        const revisionIds = new Map();
        for (const revision of [...page.revisions].reverse()) {
          const persistedRevision = repository.insertRevision({
            noteId,
            title: revision.title,
            content: revision.rawMarkdown,
            sourceUpdatedAt: revision.sourceUpdatedAt,
            createdAt: revision.createdAt,
          });
          revisionIds.set(revision.key, persistedRevision.id);
        }
        revisionIdsByPageKey.set(page.key, revisionIds);
      }

      const selectedPageIds = book.previewSettings.selectedPageKeys.map((pageKey) => (
        requireMappedId(pageIdsBySourceKey, pageKey, 'Page')
      ));
      repository.insertPreviewSettings({
        bookId: persistedBook.id,
        mode: book.previewSettings.mode,
        randomCount: book.previewSettings.randomCount,
      });
      for (const pageId of selectedPageIds) {
        const inserted = repository.insertPreviewPage({ bookId: persistedBook.id, pageId });
        if (inserted.changes !== 1) {
          throw integrityError(`Destination Page ${pageId} is not owned by imported Book ${persistedBook.id}.`);
        }
      }

      results.push({
        sourceBookKey: book.key,
        destinationBookId: persistedBook.id,
        sourceTitle: plannedTitle.sourceTitle,
        destinationTitle: plannedTitle.destinationTitle,
        renamed: plannedTitle.sourceTitle !== plannedTitle.destinationTitle,
        chapterIdsBySourceKey,
        pageIdsBySourceKey,
        revisionIdsByPageKey,
        cover: book.cover,
        associations: deferredAssociations(book),
        preview: {
          mode: book.previewSettings.mode,
          randomCount: book.previewSettings.randomCount,
          selectedPageKeys: [...book.previewSettings.selectedPageKeys],
          selectedPageIds,
        },
      });
    }

    return {
      format: validatedPlan.format,
      version: validatedPlan.version,
      transactionMode: 'immediate',
      books: results,
    };
  }

  const persistTransaction = db.transaction(persistCore);

  function persistValidatedPlanInTransaction(validatedPlan) {
    if (!db.inTransaction) {
      throw new BookImportPersistenceError(
        'Book import persistence requires an existing caller-owned database transaction.',
        { code: 'TRANSACTION_CONTEXT_REQUIRED' },
      );
    }
    try {
      return persistCore(validatedPlan);
    } catch (cause) {
      if (cause instanceof BookImportPersistenceError) throw cause;
      throw persistenceError(cause);
    }
  }

  return {
    persistValidatedPlanInTransaction,
    persistValidatedPlan(validatedPlan) {
      if (db.inTransaction) {
        throw new BookImportPersistenceError(
          'Book import persistence must own the outer database transaction.',
          { code: 'TRANSACTION_OWNERSHIP_REQUIRED' },
        );
      }
      try {
        return persistTransaction.immediate(validatedPlan);
      } catch (cause) {
        if (cause instanceof BookImportPersistenceError) throw cause;
        throw persistenceError(cause);
      }
    },
  };
}
