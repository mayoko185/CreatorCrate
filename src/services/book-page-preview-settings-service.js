import { BookPagePreviewSettingsRepositoryError } from '../data/book-page-preview-settings-repository.js';

export const BOOK_PAGE_PREVIEW_DEFAULTS = Object.freeze({
  mode: 'random',
  randomCount: 5,
  selectedPageIds: Object.freeze([]),
});

export class BookPagePreviewSettingsError extends Error {
  constructor(message, { code, status = 422, errors, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookPagePreviewSettingsError';
    this.code = code;
    this.status = status;
    if (errors) this.errors = errors;
  }
}

function assertBookId(bookId) {
  if (!Number.isSafeInteger(bookId) || bookId <= 0) {
    throw new BookPagePreviewSettingsError('Book ID must be a positive integer.', {
      code: 'INVALID_BOOK_ID',
      errors: { bookId: 'Book ID must be a positive integer.' },
    });
  }
}

function normalizeSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BookPagePreviewSettingsError('Page preview settings must be an object.', {
      code: 'INVALID_INPUT',
      errors: { settings: 'Page preview settings must be an object.' },
    });
  }

  const errors = {};
  if (input.mode !== 'random' && input.mode !== 'selected') {
    errors.mode = 'Mode must be random or selected.';
  }
  if (!Number.isSafeInteger(input.randomCount) || input.randomCount < 1 || input.randomCount > 25) {
    errors.randomCount = 'Random count must be an integer from 1 through 25.';
  }
  if (!Array.isArray(input.selectedPageIds)
    || input.selectedPageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    errors.selectedPageIds = 'Selected Page IDs must be positive integers.';
  }
  if (Object.keys(errors).length > 0) {
    throw new BookPagePreviewSettingsError('Page preview settings are invalid.', {
      code: 'INVALID_INPUT',
      errors,
    });
  }

  return {
    mode: input.mode,
    randomCount: input.randomCount,
    selectedPageIds: [...new Set(input.selectedPageIds)].sort((left, right) => left - right),
  };
}

function present(row) {
  return {
    mode: row.mode,
    randomCount: row.random_count,
    selectedPageIds: row.selected_page_ids,
  };
}

export function createBookPagePreviewSettingsService({ repository, bookRepository } = {}) {
  if (!repository) {
    throw new Error('createBookPagePreviewSettingsService requires a repository dependency.');
  }
  if (!bookRepository || typeof bookRepository.findById !== 'function') {
    throw new Error('createBookPagePreviewSettingsService requires a bookRepository dependency.');
  }

  function requireBook(bookId) {
    assertBookId(bookId);
    if (!bookRepository.findById(bookId)) {
      throw new BookPagePreviewSettingsError(`Book ${bookId} not found.`, {
        code: 'BOOK_NOT_FOUND',
        status: 404,
      });
    }
  }

  return {
    getBookPagePreviewSettings(bookId) {
      requireBook(bookId);
      try {
        const stored = repository.findByBookId(bookId);
        return stored ? present(stored) : {
          mode: BOOK_PAGE_PREVIEW_DEFAULTS.mode,
          randomCount: BOOK_PAGE_PREVIEW_DEFAULTS.randomCount,
          selectedPageIds: [],
        };
      } catch (error) {
        throw new BookPagePreviewSettingsError('Book Page preview settings could not be read.', {
          code: 'DATABASE_ERROR',
          status: 500,
          cause: error,
        });
      }
    },

    replaceBookPagePreviewSettings(bookId, input) {
      requireBook(bookId);
      const normalized = normalizeSettings(input);
      try {
        return present(repository.replace(bookId, normalized));
      } catch (error) {
        if (error instanceof BookPagePreviewSettingsRepositoryError
          && error.code === 'PAGE_NOT_IN_BOOK') {
          throw new BookPagePreviewSettingsError('Every selected Page must belong to this Book.', {
            code: 'PAGE_NOT_IN_BOOK',
            errors: { selectedPageIds: 'Every selected Page must belong to this Book.' },
            cause: error,
          });
        }
        throw new BookPagePreviewSettingsError('Book Page preview settings could not be saved.', {
          code: 'DATABASE_ERROR',
          status: 500,
          cause: error,
        });
      }
    },
  };
}
