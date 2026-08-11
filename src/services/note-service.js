import { NoteError } from '../data/note-repository.js';
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
  constructor(errors) {
    super('Note validation failed');
    this.name = 'NoteValidationError';
    this.errors = errors;
  }
}

export class NoteNotFoundError extends Error {
  constructor(id) {
    super(`Note ${id} not found`);
    this.name = 'NoteNotFoundError';
    this.status = 404;
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
 */
export function createNoteService({
  noteRepository,
  projectRepository,
  assetRepository,
  chapterRepository,
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
    if (typeof input.chapterId !== 'number'
      || !Number.isSafeInteger(input.chapterId)
      || input.chapterId <= 0) {
      errors.chapterId = 'chapterId must be a positive integer.';
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
    requireChapter(input.chapterId);
    validateAssociationReferences(projectIds, assetIds);
    return {
      chapterId: input.chapterId,
      title,
      content,
      projectIds,
      assetIds,
    };
  }

  function normalizeUpdateInput(input, existing) {
    assertPlainObject(input, 'input');
    const errors = {};
    if (Object.hasOwn(input, 'chapterId')) {
      errors.chapterId = 'chapterId cannot be changed by updating a Note.';
    }
    const title = normalizeTitle(input.title, errors, existing.title);
    const content = normalizeContent(input.content, errors, existing.content);
    const projectIds = Object.hasOwn(input, 'projectIds')
      ? normalizeAssociationIds(input.projectIds, 'projectIds', errors)
      : noteRepository.listProjectsForNote(existing.id);
    const assetIds = Object.hasOwn(input, 'assetIds')
      ? normalizeAssociationIds(input.assetIds, 'assetIds', errors)
      : noteRepository.listAssetsForNote(existing.id);

    throwValidationIfNeeded(errors);
    validateAssociationReferences(projectIds, assetIds);
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
      return detail(result.note, result);
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

  return {
    createNote(input) {
      const values = normalizeCreateInput(input);
      return persistWithAssociations(undefined, values);
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

    updateNote(id, input) {
      const existing = requireNote(id);
      const values = normalizeUpdateInput(input, existing);
      return persistWithAssociations(id, values);
    },

    deleteNote(id) {
      requireNote(id);
      const deleted = noteRepository.deleteById(id);
      if (!deleted) {
        throw new NoteNotFoundError(id);
      }
      return deleted;
    },

    reorderNotes(chapterId, orderedIds) {
      requireChapter(chapterId);
      validateReorderInput(orderedIds);
      try {
        return noteRepository.reorder(chapterId, orderedIds);
      } catch (error) {
        if (isNoteRepositoryError(error) && REORDER_VALIDATION_CODES.has(error.code)) {
          throw new NoteValidationError({
            orderedIds: 'Note order must contain every current note exactly once.',
          });
        }
        throw error;
      }
    },

    moveNoteToChapter(noteId, targetChapterId) {
      requireNote(noteId);
      requireChapter(targetChapterId, 'targetChapterId');
      try {
        const moved = noteRepository.moveToChapter(noteId, targetChapterId);
        if (!moved) {
          throw new NoteNotFoundError(noteId);
        }
        return moved;
      } catch (error) {
        if (error instanceof NoteNotFoundError) {
          throw error;
        }
        if (isNoteRepositoryError(error) && error.code === 'TARGET_CHAPTER_NOT_FOUND') {
          throw new ChapterNotFoundError(targetChapterId);
        }
        if (isNoteRepositoryError(error)) {
          throw new NoteValidationError({ noteId: 'Note move could not be completed.' });
        }
        throw error;
      }
    },
  };
}
