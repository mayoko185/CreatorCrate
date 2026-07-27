import slugify from '@sindresorhus/slugify';
import {
  createProjectRepository,
  STATUSES,
  WORKFLOW_STATUSES,
  PRIORITIES,
} from '../data/project-repository.js';

export { STATUSES, WORKFLOW_STATUSES, PRIORITIES };

export class ProjectValidationError extends Error {
  constructor(errors) {
    super('Project validation failed');
    this.name = 'ProjectValidationError';
    this.errors = errors;
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id) {
    super(`Project ${id} not found`);
    this.name = 'ProjectNotFoundError';
    this.status = 404;
  }
}

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const NOTES_MAX = 10000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidDate(value) {
  if (!value) return true;
  if (!DATE_RE.test(value)) return false;
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isValidPatreonUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^([^.]+\.)?patreon\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function createProjectService(db) {
  const repository = createProjectRepository(db);

  function validate(input, options = {}) {
    const { existingId } = options;
    const errors = {};

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length < TITLE_MIN) {
      errors.title = 'Title is required.';
    } else if (title.length > TITLE_MAX) {
      errors.title = `Title must be ${TITLE_MAX} characters or fewer.`;
    }

    const description = typeof input.description === 'string' ? input.description : '';
    if (description.length > DESCRIPTION_MAX) {
      errors.description = `Description must be ${DESCRIPTION_MAX} characters or fewer.`;
    }

    const notes = typeof input.notes === 'string' ? input.notes : '';
    if (notes.length > NOTES_MAX) {
      errors.notes = `Notes must be ${NOTES_MAX} characters or fewer.`;
    }

    const status = input.status;
    if (!WORKFLOW_STATUSES.includes(status)) {
      errors.status = `Status must be one of: ${WORKFLOW_STATUSES.join(', ')}.`;
    }

    const priority = input.priority;
    if (!PRIORITIES.includes(priority)) {
      errors.priority = `Priority must be one of: ${PRIORITIES.join(', ')}.`;
    }

    const plannedDate = input.plannedDate || null;
    if (!isValidDate(plannedDate)) {
      errors.plannedDate = 'Planned date must be a valid date (YYYY-MM-DD).';
    }

    const publishedDate = input.publishedDate || null;
    if (!isValidDate(publishedDate)) {
      errors.publishedDate = 'Published date must be a valid date (YYYY-MM-DD).';
    }

    const patreonUrl = input.patreonUrl || null;
    if (!isValidPatreonUrl(patreonUrl)) {
      errors.patreonUrl = 'Patreon URL must be a valid https://patreon.com link.';
    }

    if (Object.keys(errors).length > 0) {
      throw new ProjectValidationError(errors);
    }

    const slug = makeSlug(title);
    if (repository.slugExists(slug, { excludeId: existingId })) {
      throw new ProjectValidationError({ title: 'A project with this title already exists.' });
    }

    return {
      title,
      slug,
      description,
      notes,
      status,
      priority,
      plannedDate,
      publishedDate,
      patreonUrl,
    };
  }

  return {
    STATUSES,
    WORKFLOW_STATUSES,
    PRIORITIES,

    repository,

    create(input) {
      const normalized = validate(input);
      try {
        return repository.create(normalized);
      } catch (err) {
        if (isSlugUniqueConstraintError(err)) {
          throw new ProjectValidationError({
            title: 'A project with this title already exists.',
          });
        }
        throw err;
      }
    },

    update(id, input) {
      const project = repository.findById(id);
      if (!project) {
        throw new ProjectNotFoundError(id);
      }
      const normalized = validate(input, { existingId: id });
      return repository.update(id, normalized);
    },

    archive(id) {
      const project = repository.findById(id);
      if (!project) {
        throw new ProjectNotFoundError(id);
      }
      return repository.archive(id);
    },

    findById(id) {
      return repository.findById(id);
    },

    findBySlug(slug) {
      return repository.findBySlug(slug);
    },

    list(options = {}) {
      return repository.list(options);
    },

    countByStatus() {
      return repository.countByStatus();
    },
  };
}

function makeSlug(title) {
  return slugify(title, { lowercase: true });
}

function isSlugUniqueConstraintError(err) {
  return (
    err != null &&
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof err.message === 'string' &&
    err.message.includes('projects.slug')
  );
}
