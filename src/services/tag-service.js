export const TAG_NAME_MAX = 100;

const DUPLICATE_TAG_NAME_ERROR_CODE = 'SQLITE_CONSTRAINT_UNIQUE';
const DUPLICATE_TAG_NAME_ERROR_MESSAGE = 'UNIQUE constraint failed: tags.normalized_name';

export class TagValidationError extends Error {
  constructor(errors) {
    super('Tag validation failed');
    this.name = 'TagValidationError';
    this.errors = errors;
  }
}

export class TagNotFoundError extends Error {
  constructor(id) {
    super(`Tag ${id} not found`);
    this.name = 'TagNotFoundError';
    this.status = 404;
  }
}

export function isDuplicateTagNameError(error) {
  return error?.code === DUPLICATE_TAG_NAME_ERROR_CODE
    && error?.message === DUPLICATE_TAG_NAME_ERROR_MESSAGE;
}

function assertPlainObject(value, fieldLabel) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TagValidationError({ [fieldLabel]: 'Input must be an object.' });
  }
}

function assertPositiveIntegerId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TagValidationError({ id: 'id must be a positive integer.' });
  }
}

function normalizeTagInput(input) {
  assertPlainObject(input, 'input');

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) {
    throw new TagValidationError({ name: 'Tag name is required.' });
  }
  if (name.length > TAG_NAME_MAX) {
    throw new TagValidationError({ name: `Tag name must be ${TAG_NAME_MAX} characters or fewer.` });
  }

  return {
    displayName: name,
    normalizedName: name.toLowerCase(),
  };
}

function throwDuplicateTagName() {
  throw new TagValidationError({ name: 'A tag with this name already exists.' });
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/tag-repository.js').createTagRepository>} deps.tagRepository
 */
export function createTagService({ tagRepository, applicationLogger = null } = {}) {
  if (!tagRepository) {
    throw new Error('createTagService requires a tagRepository dependency.');
  }

  function requireTag(id) {
    assertPositiveIntegerId(id);
    const tag = tagRepository.findById(id);
    if (!tag) {
      throw new TagNotFoundError(id);
    }
    return tag;
  }

  function logActivity(event, tagId) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'tags',
        message: 'Tag activity completed.',
        context: { tagId },
      });
    } catch {
      // Activity logging must never alter a completed tag mutation.
    }
  }

  function persistTagMutation(operation) {
    try {
      return operation();
    } catch (error) {
      if (isDuplicateTagNameError(error)) {
        throwDuplicateTagName();
      }
      throw error;
    }
  }

  return {
    listTags() {
      return tagRepository.list();
    },

    getTag(id) {
      return requireTag(id);
    },

    createTag(input) {
      const values = normalizeTagInput(input);
      const created = persistTagMutation(() => tagRepository.create(values));
      logActivity('tag.created', created.id);
      return created;
    },

    renameTag(id, input) {
      assertPositiveIntegerId(id);
      const values = normalizeTagInput(input);
      const current = requireTag(id);

      const updated = persistTagMutation(() => {
        const stored = tagRepository.update(id, values);
        if (!stored) {
          throw new TagNotFoundError(id);
        }
        return stored;
      });
      if (current.display_name !== values.displayName) {
        logActivity('tag.renamed', id);
      }
      return updated;
    },

    deleteTag(id) {
      requireTag(id);
      const deleted = tagRepository.deleteById(id);
      if (!deleted) {
        throw new TagNotFoundError(id);
      }
      logActivity('tag.deleted', id);
      return deleted;
    },
  };
}
