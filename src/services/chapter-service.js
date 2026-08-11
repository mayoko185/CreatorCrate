import { BookNotFoundError } from './book-service.js';
import { ChapterError } from '../data/chapter-repository.js';

export const CHAPTER_TITLE_MAX = 200;

const REORDER_VALIDATION_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_SEQUENCE_LENGTH',
  'DUPLICATE_ID',
  'UNKNOWN_ID',
  'INVALID_ID',
]);

export class ChapterValidationError extends Error {
  constructor(errors) {
    super('Chapter validation failed');
    this.name = 'ChapterValidationError';
    this.errors = errors;
  }
}

export class ChapterNotFoundError extends Error {
  constructor(id) {
    super(`Chapter ${id} not found`);
    this.name = 'ChapterNotFoundError';
    this.status = 404;
  }
}

export class ChapterNotEmptyError extends Error {
  constructor(id) {
    super(`Chapter ${id} cannot be deleted while it contains Notes.`);
    this.name = 'ChapterNotEmptyError';
    this.status = 409;
    this.code = 'CHAPTER_NOT_EMPTY';
  }
}

export class ChapterOperationError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ChapterOperationError';
    this.status = 500;
    this.code = 'CHAPTER_OPERATION_FAILED';
  }
}

function assertPlainObject(value, fieldLabel) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChapterValidationError({ [fieldLabel]: 'Input must be an object.' });
  }
}

function assertPositiveIntegerId(value, fieldLabel = 'id') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ChapterValidationError({
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
  } else if (title.length > CHAPTER_TITLE_MAX) {
    errors.title = `Title must be ${CHAPTER_TITLE_MAX} characters or fewer.`;
  }
  return title;
}

function throwValidationIfNeeded(errors) {
  if (Object.keys(errors).length > 0) {
    throw new ChapterValidationError(errors);
  }
}

function isChapterRepositoryError(error) {
  return error instanceof ChapterError;
}

/**
 * @param {object} deps
 * @param {object} deps.chapterRepository
 * @param {object} deps.bookRepository
 */
export function createChapterService({ chapterRepository, bookRepository } = {}) {
  if (!chapterRepository) {
    throw new Error('createChapterService requires a chapterRepository dependency.');
  }
  if (!bookRepository) {
    throw new Error('createChapterService requires a bookRepository dependency.');
  }

  function requireBook(id) {
    assertPositiveIntegerId(id, 'bookId');
    const book = bookRepository.findById(id);
    if (!book) {
      throw new BookNotFoundError(id);
    }
    return book;
  }

  function requireChapter(id) {
    assertPositiveIntegerId(id);
    const chapter = chapterRepository.findById(id);
    if (!chapter) {
      throw new ChapterNotFoundError(id);
    }
    return chapter;
  }

  function normalizeCreateInput(input) {
    assertPlainObject(input, 'input');
    const errors = {};
    const title = normalizeTitle(input.title, errors);
    if (typeof input.bookId !== 'number' || !Number.isSafeInteger(input.bookId) || input.bookId <= 0) {
      errors.bookId = 'bookId must be a positive integer.';
    }
    throwValidationIfNeeded(errors);
    return { bookId: input.bookId, title };
  }

  function normalizeUpdateInput(input, existingTitle) {
    assertPlainObject(input, 'input');
    const errors = {};
    const title = normalizeTitle(input.title, errors, existingTitle);
    throwValidationIfNeeded(errors);
    return { title };
  }

  function validateReorderInput(orderedIds) {
    if (!Array.isArray(orderedIds)) {
      throw new ChapterValidationError({ orderedIds: 'orderedIds must be an array.' });
    }

    if (orderedIds.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
      throw new ChapterValidationError({ orderedIds: 'Chapter IDs must be positive integers.' });
    }
  }

  function unexpectedRepositoryError(error) {
    return new ChapterOperationError('Chapter operation could not be completed.', { cause: error });
  }

  return {
    listChapters(bookId) {
      requireBook(bookId);
      return chapterRepository.listForBook(bookId);
    },

    getChapter(id) {
      return requireChapter(id);
    },

    createChapter(input) {
      const values = normalizeCreateInput(input);
      requireBook(values.bookId);
      return chapterRepository.create(values);
    },

    updateChapter(id, input) {
      const existing = requireChapter(id);
      const updated = chapterRepository.update(id, normalizeUpdateInput(input, existing.title));
      if (!updated) {
        throw new ChapterNotFoundError(id);
      }
      return updated;
    },

    reorderChapters(bookId, orderedIds) {
      requireBook(bookId);
      validateReorderInput(orderedIds);
      try {
        return chapterRepository.reorder(bookId, orderedIds);
      } catch (error) {
        if (isChapterRepositoryError(error) && REORDER_VALIDATION_CODES.has(error.code)) {
          throw new ChapterValidationError({
            orderedIds: 'Chapter order must contain every current chapter exactly once.',
          });
        }
        if (isChapterRepositoryError(error)) {
          throw unexpectedRepositoryError(error);
        }
        throw error;
      }
    },

    deleteChapter(id) {
      requireChapter(id);
      try {
        const deleted = chapterRepository.deleteAndCompact(id);
        if (!deleted) {
          throw new ChapterNotFoundError(id);
        }
        return deleted;
      } catch (error) {
        if (error instanceof ChapterNotFoundError) {
          throw error;
        }
        if (isChapterRepositoryError(error) && error.code === 'NOT_EMPTY') {
          throw new ChapterNotEmptyError(id);
        }
        if (isChapterRepositoryError(error)) {
          throw unexpectedRepositoryError(error);
        }
        throw error;
      }
    },
  };
}
