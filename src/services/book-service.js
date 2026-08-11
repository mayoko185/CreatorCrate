import { BookError } from '../data/book-repository.js';

export const BOOK_TITLE_MAX = 200;

const REORDER_VALIDATION_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_SEQUENCE_LENGTH',
  'DUPLICATE_ID',
  'UNKNOWN_ID',
  'INVALID_ID',
]);

export class BookValidationError extends Error {
  constructor(errors) {
    super('Book validation failed');
    this.name = 'BookValidationError';
    this.errors = errors;
  }
}

export class BookNotFoundError extends Error {
  constructor(id) {
    super(`Book ${id} not found`);
    this.name = 'BookNotFoundError';
    this.status = 404;
  }
}

export class BookNotEmptyError extends Error {
  constructor(id) {
    super(`Book ${id} cannot be deleted while it contains chapters.`);
    this.name = 'BookNotEmptyError';
    this.status = 409;
    this.code = 'BOOK_NOT_EMPTY';
  }
}

export class BookOperationError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookOperationError';
    this.status = 500;
    this.code = 'BOOK_OPERATION_FAILED';
  }
}

function assertPlainObject(value, fieldLabel) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BookValidationError({ [fieldLabel]: 'Input must be an object.' });
  }
}

function assertPositiveIntegerId(value, fieldLabel = 'id') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BookValidationError({
      [fieldLabel]: `${fieldLabel} must be a positive integer.`,
    });
  }
}

function normalizeTitle(value, errors, fallback = undefined) {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    errors.title = 'Title must be a string.';
    return '';
  }

  const title = value.trim();
  if (title.length === 0) {
    errors.title = 'Title is required.';
  } else if (title.length > BOOK_TITLE_MAX) {
    errors.title = `Title must be ${BOOK_TITLE_MAX} characters or fewer.`;
  }
  return title;
}

function throwValidationIfNeeded(errors) {
  if (Object.keys(errors).length > 0) {
    throw new BookValidationError(errors);
  }
}

function isBookRepositoryError(error) {
  return error instanceof BookError;
}

/**
 * @param {object} deps
 * @param {object} deps.bookRepository
 */
export function createBookService({ bookRepository } = {}) {
  if (!bookRepository) {
    throw new Error('createBookService requires a bookRepository dependency.');
  }

  function requireBook(id) {
    assertPositiveIntegerId(id);
    const book = bookRepository.findById(id);
    if (!book) {
      throw new BookNotFoundError(id);
    }
    return book;
  }

  function normalizeInput(input, existingTitle = undefined) {
    assertPlainObject(input, 'input');
    const errors = {};
    const title = normalizeTitle(input.title, errors, existingTitle);
    throwValidationIfNeeded(errors);
    return { title };
  }

  function validateReorderInput(orderedIds) {
    if (!Array.isArray(orderedIds)) {
      throw new BookValidationError({ orderedIds: 'orderedIds must be an array.' });
    }

    if (orderedIds.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
      throw new BookValidationError({ orderedIds: 'Book IDs must be positive integers.' });
    }
  }

  function unexpectedRepositoryError(error) {
    return new BookOperationError('Book operation could not be completed.', { cause: error });
  }

  return {
    listBooks() {
      return bookRepository.list();
    },

    getBook(id) {
      return requireBook(id);
    },

    createBook(input) {
      return bookRepository.create(normalizeInput(input));
    },

    updateBook(id, input) {
      const existing = requireBook(id);
      const updated = bookRepository.update(id, normalizeInput(input, existing.title));
      if (!updated) {
        throw new BookNotFoundError(id);
      }
      return updated;
    },

    reorderBooks(orderedIds) {
      validateReorderInput(orderedIds);
      try {
        return bookRepository.reorder(orderedIds);
      } catch (error) {
        if (isBookRepositoryError(error) && REORDER_VALIDATION_CODES.has(error.code)) {
          throw new BookValidationError({
            orderedIds: 'Book order must contain every current book exactly once.',
          });
        }
        if (isBookRepositoryError(error)) {
          throw unexpectedRepositoryError(error);
        }
        throw error;
      }
    },

    deleteBook(id) {
      requireBook(id);
      try {
        const deleted = bookRepository.deleteAndCompact(id);
        if (!deleted) {
          throw new BookNotFoundError(id);
        }
        return deleted;
      } catch (error) {
        if (error instanceof BookNotFoundError) {
          throw error;
        }
        if (isBookRepositoryError(error) && error.code === 'NOT_EMPTY') {
          throw new BookNotEmptyError(id);
        }
        if (isBookRepositoryError(error)) {
          throw unexpectedRepositoryError(error);
        }
        throw error;
      }
    },
  };
}
