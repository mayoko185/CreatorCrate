import { NoteError } from '../data/note-repository.js';
import { BookNotFoundError } from './book-service.js';
import { ChapterNotFoundError } from './chapter-service.js';

export const NOTE_TITLE_MAX = 200;

const REORDER_VALIDATION_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_SEQUENCE_LENGTH',
  'DUPLICATE_ID',
  'UNKNOWN_ID',
  'INVALID_ID',
]);

export class NoteValidationError extends Error {
  constructor(errors, { code } = {}) {
    super('Note validation failed');
    this.name = 'NoteValidationError';
    this.errors = errors;
    if (code) this.code = code;
  }
}

export class NoteNotFoundError extends Error {
  constructor(id) {
    super(`Note ${id} not found`);
    this.name = 'NoteNotFoundError';
    this.status = 404;
  }
}

export class NoteOperationError extends Error {
  constructor(message, { code = 'NOTE_OPERATION_FAILED', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NoteOperationError';
    this.status = 500;
    this.code = code;
  }
}

function assertPlainObject(value, fieldLabel) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NoteValidationError({ [fieldLabel]: 'Input must be an object.' });
  }
}

function assertPositiveIntegerId(value, fieldLabel = 'id') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new NoteValidationError({
      [fieldLabel]: `${fieldLabel} must be a positive integer.`,
    });
  }
}

function normalizeAssociationIds(value, fieldLabel, errors, { defaultValue } = {}) {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }

  if (!Array.isArray(value)) {
    errors[fieldLabel] = `${fieldLabel} must be an array.`;
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      errors[fieldLabel] = `${fieldLabel} must contain positive integer IDs.`;
      return [];
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }

  return normalized;
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
  } else if (title.length > NOTE_TITLE_MAX) {
    errors.title = `Title must be ${NOTE_TITLE_MAX} characters or fewer.`;
  }
  return title;
}

function normalizeContent(value, errors, fallback = '') {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    errors.content = 'Content must be a string.';
    return '';
  }
  return value;
}

function throwValidationIfNeeded(errors) {
  if (Object.keys(errors).length > 0) {
    throw new NoteValidationError(errors);
  }
}

function isForeignKeyConstraint(error) {
  return error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    || /foreign key constraint failed/i.test(error?.message || '');
}

function isNoteRepositoryError(error) {
  return error instanceof NoteError;
}

/**
 * @param {object} deps
 * @param {object} deps.noteRepository
 * @param {object} deps.projectRepository
 * @param {object} deps.assetRepository
 * @param {object} deps.chapterRepository
 * @param {object} [deps.bookRepository]
 * @param {import('better-sqlite3').Database} [deps.db]
 * @param {object} [deps.bookContentRepository]
 * @param {object} [deps.applicationLogger]
 */
export function createNoteService({
  db,
  noteRepository,
  projectRepository,
  assetRepository,
  chapterRepository,
  bookRepository,
  bookContentRepository,
  applicationLogger = null,
} = {}) {
  if (!noteRepository) {
    throw new Error('createNoteService requires a noteRepository dependency.');
  }
  if (!projectRepository) {
    throw new Error('createNoteService requires a projectRepository dependency.');
  }
  if (!assetRepository) {
    throw new Error('createNoteService requires an assetRepository dependency.');
  }
  if (!chapterRepository) {
    throw new Error('createNoteService requires a chapterRepository dependency.');
  }

  function logActivity(event, context) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'notes',
        message: 'Note activity completed.',
        context,
      });
    } catch {
      // Activity logging must never alter the completed Note operation.
    }
  }

  function noteContext(note) {
    return {
      bookId: note.book_id,
      ...(note.chapter_id === null ? {} : { chapterId: note.chapter_id }),
      noteId: note.id,
    };
  }

  function requireNote(id) {
    assertPositiveIntegerId(id);
    const note = noteRepository.findById(id);
    if (!note) {
      throw new NoteNotFoundError(id);
    }
    return note;
  }

  function requireChapter(id, fieldLabel = 'chapterId') {
    assertPositiveIntegerId(id, fieldLabel);
    const chapter = chapterRepository.findById(id);
    if (!chapter) {
      throw new ChapterNotFoundError(id);
    }
    return chapter;
  }

  function requireBook(id) {
    assertPositiveIntegerId(id, 'bookId');
    if (!bookRepository) {
      throw new Error('createNoteService requires a bookRepository dependency for Book-container operations.');
    }
    const book = bookRepository.findById(id);
    if (!book) {
      throw new BookNotFoundError(id);
    }
    return book;
  }

  function throwHierarchyMismatch(chapter, bookId) {
    throw new NoteValidationError({
      chapterId: `Chapter ${chapter.id} belongs to Book ${chapter.book_id}, not Book ${bookId}.`,
    }, { code: 'BOOK_CHAPTER_MISMATCH' });
  }

  function validateAssociationReferences(projectIds, assetIds) {
    const errors = {};

    for (const projectId of projectIds) {
      if (!projectRepository.findById(projectId)) {
        errors.projectIds = `Project ${projectId} not found.`;
        break;
      }
    }

    for (const assetId of assetIds) {
      if (!assetRepository.findById(assetId)) {
        errors.assetIds = `Asset ${assetId} not found.`;
        break;
      }
    }

    throwValidationIfNeeded(errors);
  }

  function normalizeCreateInput(input) {
    assertPlainObject(input, 'input');
    const errors = {};
    const hasChapterId = input.chapterId !== undefined && input.chapterId !== null;
    const hasBookId = input.bookId !== undefined;
    if (hasBookId && (typeof input.bookId !== 'number'
      || !Number.isSafeInteger(input.bookId)
      || input.bookId <= 0)) {
      errors.bookId = 'bookId must be a positive integer.';
    }
    if (hasChapterId && (typeof input.chapterId !== 'number'
      || !Number.isSafeInteger(input.chapterId)
      || input.chapterId <= 0)) {
      errors.chapterId = 'chapterId must be a positive integer.';
    }
    if (!hasBookId && !hasChapterId) {
      errors.bookId = 'bookId must be a positive integer.';
    }
    const title = normalizeTitle(input.title, errors);
    const content = normalizeContent(input.content, errors);
    const projectIds = normalizeAssociationIds(input.projectIds, 'projectIds', errors, {
      defaultValue: [],
    });
    const assetIds = normalizeAssociationIds(input.assetIds, 'assetIds', errors, {
      defaultValue: [],
    });

    throwValidationIfNeeded(errors);

    let bookId = input.bookId;
    let chapter = null;
    if (hasBookId) {
      requireBook(bookId);
    }
    if (hasChapterId) {
      chapter = requireChapter(input.chapterId);
      if (!hasBookId) {
        // Temporary compatibility for the existing chapter-only callers.
        bookId = chapter.book_id;
        if (bookRepository) requireBook(bookId);
      } else if (chapter.book_id !== bookId) {
        throwHierarchyMismatch(chapter, bookId);
      }
    }
    validateAssociationReferences(projectIds, assetIds);
    return {
      bookId,
      chapterId: hasChapterId ? input.chapterId : null,
      title,
      content,
      projectIds,
      assetIds,
    };
  }

  function normalizeUpdateInput(input) {
    assertPlainObject(input, 'input');
    const errors = {};
    if (Object.hasOwn(input, 'bookId')) {
      errors.bookId = 'bookId cannot be changed by updating a Note.';
    }
    if (Object.hasOwn(input, 'chapterId')) {
      errors.chapterId = 'chapterId cannot be changed by updating a Note.';
    }
    const title = Object.hasOwn(input, 'title')
      ? normalizeTitle(input.title, errors)
      : undefined;
    const content = Object.hasOwn(input, 'content')
      ? normalizeContent(input.content, errors)
      : undefined;
    const projectIds = Object.hasOwn(input, 'projectIds')
      ? normalizeAssociationIds(input.projectIds, 'projectIds', errors)
      : undefined;
    const assetIds = Object.hasOwn(input, 'assetIds')
      ? normalizeAssociationIds(input.assetIds, 'assetIds', errors)
      : undefined;

    throwValidationIfNeeded(errors);
    validateAssociationReferences(projectIds ?? [], assetIds ?? []);
    return { title, content, projectIds, assetIds };
  }

  function detail(note, associations = {}) {
    return {
      ...note,
      projectIds: associations.projectIds ?? noteRepository.listProjectsForNote(note.id),
      assetIds: associations.assetIds ?? noteRepository.listAssetsForNote(note.id),
    };
  }

  function persistWithAssociations(id, values) {
    try {
      const result = noteRepository.saveWithAssociations({ id, ...values });
      if (!result) {
        throw new NoteNotFoundError(id);
      }
      return { note: detail(result.note, result), changed: result.changed };
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw error;
      }
      if (isForeignKeyConstraint(error)) {
        throw new NoteValidationError({
          associations: 'One or more referenced projects or assets no longer exist.',
        });
      }
      throw error;
    }
  }

  const createDirectBookPageTx = db && typeof db.transaction === 'function'
    ? db.transaction((values) => {
      const outcome = persistWithAssociations(undefined, values);
      bookContentRepository.append(values.bookId, 'page', outcome.note.id);
      return outcome;
    })
    : null;

  function persistDirectBookPage(values) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page creation.');
    }
    if (!createDirectBookPageTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page creation.');
    }
    return createDirectBookPageTx(values);
  }

  const deleteDirectBookPageTx = db && typeof db.transaction === 'function'
    ? db.transaction((note) => {
      const deleted = noteRepository.deleteById(note.id);
      if (!deleted) {
        throw new NoteNotFoundError(note.id);
      }

      const removed = bookContentRepository.remove(note.book_id, 'page', note.id);
      if (!removed) {
        throw new NoteOperationError(
          `Direct Book Page ${note.id} is missing from Book ${note.book_id}.`,
          { code: 'MEMBERSHIP_NOT_FOUND' },
        );
      }

      return deleted;
    })
    : null;

  function deleteDirectBookPage(note) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page deletion.');
    }
    if (!deleteDirectBookPageTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page deletion.');
    }
    return deleteDirectBookPageTx(note);
  }

  const moveChapterPageToDirectBookTx = db && typeof db.transaction === 'function'
    ? db.transaction((note, target) => {
      const moved = noteRepository.moveToContainer(note.id, target);
      if (!moved) {
        throw new NoteNotFoundError(note.id);
      }

      bookContentRepository.append(target.bookId, 'page', note.id);
      return moved;
    })
    : null;

  function moveChapterPageToDirectBook(note, target) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for Chapter Page movement to a direct Book Page.');
    }
    if (!moveChapterPageToDirectBookTx) {
      throw new Error('createNoteService requires a db dependency for Chapter Page movement to a direct Book Page.');
    }
    return moveChapterPageToDirectBookTx(note, target);
  }

  const moveDirectBookPageToChapterTx = db && typeof db.transaction === 'function'
    ? db.transaction((note, target) => {
      const sourceBookId = note.book_id;
      const moved = noteRepository.moveToContainer(note.id, target);
      if (!moved) {
        throw new NoteNotFoundError(note.id);
      }

      const removed = bookContentRepository.remove(sourceBookId, 'page', note.id);
      if (!removed) {
        throw new NoteOperationError(
          `Direct Book Page ${note.id} is missing from Book ${sourceBookId}.`,
          { code: 'MEMBERSHIP_NOT_FOUND' },
        );
      }

      return moved;
    })
    : null;

  function moveDirectBookPageToChapter(note, target) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page movement to a Chapter Page.');
    }
    if (!moveDirectBookPageToChapterTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page movement to a Chapter Page.');
    }
    return moveDirectBookPageToChapterTx(note, target);
  }

  const moveDirectBookPageToDirectBookTx = db && typeof db.transaction === 'function'
    ? db.transaction((note, target) => {
      const sourceBookId = note.book_id;
      const targetBookId = target.bookId;
      const moved = noteRepository.moveToContainer(note.id, target);
      if (!moved) {
        throw new NoteNotFoundError(note.id);
      }

      const removed = bookContentRepository.remove(sourceBookId, 'page', note.id);
      if (!removed) {
        throw new NoteOperationError(
          `Direct Book Page ${note.id} is missing from Book ${sourceBookId}.`,
          { code: 'MEMBERSHIP_NOT_FOUND' },
        );
      }

      bookContentRepository.append(targetBookId, 'page', note.id);
      return moved;
    })
    : null;

  function moveDirectBookPageToDirectBook(note, target) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page movement between direct Book Pages.');
    }
    if (!moveDirectBookPageToDirectBookTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page movement between direct Book Pages.');
    }
    return moveDirectBookPageToDirectBookTx(note, target);
  }

  function validateReorderInput(orderedIds) {
    if (!Array.isArray(orderedIds)) {
      throw new NoteValidationError({ orderedIds: 'orderedIds must be an array.' });
    }

    const seen = new Set();

    for (const id of orderedIds) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
        throw new NoteValidationError({ orderedIds: 'Note IDs must be positive integers.' });
      }
      if (seen.has(id)) {
        throw new NoteValidationError({ orderedIds: 'Note order must not contain duplicate IDs.' });
      }
      seen.add(id);
    }
  }

  function normalizeMoveTarget(target) {
    assertPlainObject(target, 'target');
    const errors = {};
    const hasChapterId = target.chapterId !== undefined && target.chapterId !== null;
    if (typeof target.bookId !== 'number'
      || !Number.isSafeInteger(target.bookId)
      || target.bookId <= 0) {
      errors.bookId = 'bookId must be a positive integer.';
    }
    if (hasChapterId && (typeof target.chapterId !== 'number'
      || !Number.isSafeInteger(target.chapterId)
      || target.chapterId <= 0)) {
      errors.chapterId = 'chapterId must be a positive integer.';
    }
    throwValidationIfNeeded(errors);
    return {
      bookId: target.bookId,
      chapterId: hasChapterId ? target.chapterId : null,
    };
  }

  function moveNoteToContainer(noteId, target, { knownTargetChapter = null } = {}) {
    const sourceNote = requireNote(noteId);
    const normalizedTarget = normalizeMoveTarget(target);
    if (!knownTargetChapter || bookRepository) {
      requireBook(normalizedTarget.bookId);
    }

    const targetChapter = normalizedTarget.chapterId === null
      ? null
      : knownTargetChapter || requireChapter(normalizedTarget.chapterId, 'chapterId');
    if (targetChapter && targetChapter.book_id !== normalizedTarget.bookId) {
      throwHierarchyMismatch(targetChapter, normalizedTarget.bookId);
    }

    try {
      if (sourceNote.chapter_id !== null && normalizedTarget.chapterId === null) {
        return { sourceNote, moved: moveChapterPageToDirectBook(sourceNote, normalizedTarget) };
      }
      if (sourceNote.chapter_id === null && normalizedTarget.chapterId !== null) {
        return { sourceNote, moved: moveDirectBookPageToChapter(sourceNote, normalizedTarget) };
      }
      if (sourceNote.chapter_id === null && normalizedTarget.chapterId === null) {
        if (sourceNote.book_id !== normalizedTarget.bookId) {
          return { sourceNote, moved: moveDirectBookPageToDirectBook(sourceNote, normalizedTarget) };
        }
      }

      const moved = noteRepository.moveToContainer(noteId, normalizedTarget);
      if (!moved) {
        throw new NoteNotFoundError(noteId);
      }
      return { sourceNote, moved };
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw error;
      }
      if (isNoteRepositoryError(error)) {
        if (error.code === 'TARGET_BOOK_NOT_FOUND' || error.code === 'BOOK_NOT_FOUND') {
          throw new BookNotFoundError(normalizedTarget.bookId);
        }
        if (error.code === 'TARGET_CHAPTER_NOT_FOUND' || error.code === 'CHAPTER_NOT_FOUND') {
          throw new ChapterNotFoundError(normalizedTarget.chapterId);
        }
        if (error.code === 'BOOK_CHAPTER_MISMATCH') {
          throw new NoteValidationError({
            chapterId: 'chapterId must belong to bookId.',
          }, { code: 'BOOK_CHAPTER_MISMATCH' });
        }
        throw new NoteValidationError({ noteId: 'Note move could not be completed.' });
      }
      throw error;
    }
  }

  return {
    createNote(input) {
      const values = normalizeCreateInput(input);
      const { note: created } = values.chapterId === null
        ? persistDirectBookPage(values)
        : persistWithAssociations(undefined, values);
      logActivity('note.created', noteContext(created));
      return created;
    },

    getNote(id) {
      return detail(requireNote(id));
    },

    listNotes() {
      return noteRepository.list();
    },

    listNotesForChapter(chapterId) {
      requireChapter(chapterId);
      return noteRepository.listForChapter(chapterId);
    },

    listNotesForBook(bookId) {
      requireBook(bookId);
      return noteRepository.listForBook(bookId);
    },

    updateNote(id, input) {
      const values = normalizeUpdateInput(input);
      const { note: updated, changed } = persistWithAssociations(id, values);
      if (changed) {
        logActivity('note.updated', noteContext(updated));
      }
      return updated;
    },

    deleteNote(id) {
      const note = requireNote(id);
      if (note.chapter_id === null) {
        const deleted = deleteDirectBookPage(note);
        logActivity('note.deleted', noteContext(note));
        return deleted;
      }

      const deleted = noteRepository.deleteById(id);
      if (!deleted) {
        throw new NoteNotFoundError(id);
      }
      logActivity('note.deleted', noteContext(note));
      return deleted;
    },

    reorderNotes(chapterId, orderedIds) {
      requireChapter(chapterId);
      validateReorderInput(orderedIds);
      try {
        const reordered = noteRepository.reorder(chapterId, orderedIds);
        if (reordered.changed) {
          logActivity('note.reordered', { chapterId, affectedCount: reordered.length });
        }
        return reordered;
      } catch (error) {
        if (isNoteRepositoryError(error) && REORDER_VALIDATION_CODES.has(error.code)) {
          throw new NoteValidationError({
            orderedIds: 'Note order must contain every current note exactly once.',
          });
        }
        throw error;
      }
    },

    reorderBookPages(bookId, orderedIds) {
      requireBook(bookId);
      validateReorderInput(orderedIds);
      try {
        const reordered = noteRepository.reorderForBook(bookId, orderedIds);
        if (reordered.changed) {
          logActivity('note.reordered', { bookId, affectedCount: reordered.length });
        }
        return reordered;
      } catch (error) {
        if (isNoteRepositoryError(error) && REORDER_VALIDATION_CODES.has(error.code)) {
          throw new NoteValidationError({
            orderedIds: 'Note order must contain every current direct Book Page exactly once.',
          });
        }
        if (isNoteRepositoryError(error) && error.code === 'BOOK_NOT_FOUND') {
          throw new BookNotFoundError(bookId);
        }
        throw error;
      }
    },

    moveNote(noteId, target) {
      const { sourceNote, moved } = moveNoteToContainer(noteId, target);
      if (sourceNote.book_id !== moved.book_id || sourceNote.chapter_id !== moved.chapter_id) {
        logActivity('note.moved', {
          ...noteContext(sourceNote),
          destinationBookId: moved.book_id,
          ...(moved.chapter_id === null ? {} : { destinationChapterId: moved.chapter_id }),
        });
      }
      return moved;
    },

    moveNoteToChapter(noteId, targetChapterId) {
      const targetChapter = requireChapter(targetChapterId, 'targetChapterId');
      const { sourceNote, moved } = moveNoteToContainer(
        noteId,
        { bookId: targetChapter.book_id, chapterId: targetChapterId },
        { knownTargetChapter: targetChapter },
      );
      if (sourceNote.book_id !== moved.book_id || sourceNote.chapter_id !== moved.chapter_id) {
        logActivity('note.moved', {
          ...noteContext(sourceNote),
          destinationBookId: moved.book_id,
          ...(moved.chapter_id === null ? {} : { destinationChapterId: moved.chapter_id }),
        });
      }
      return moved;
    },
  };
}
