import slugify from '@sindresorhus/slugify';
import { PAGE_DEFAULT_DEFINITIONS } from './page-defaults-service.js';
import {
  isProjectOptionCatalogueV1DocumentValid,
  PROJECT_OPTION_CATALOGUE_VERSION,
} from './project-option-catalogue-v1.js';

export { PROJECT_OPTION_CATALOGUE_VERSION } from './project-option-catalogue-v1.js';
export const PROJECT_STATUS_CATALOGUE_KEY = 'project_options.status_catalogue';
export const PROJECT_TYPE_CATALOGUE_KEY = 'project_options.project_type_catalogue';

const NAME_MAX = 100;
const VALUE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const RESERVED_VALUES = new Set(['all']);

const DEFINITIONS = Object.freeze({
  status: Object.freeze({
    key: PROJECT_STATUS_CATALOGUE_KEY,
    addReservedValues: new Set(['all', 'archived']),
    projectReferenceCountMethod: 'countStatusValue',
    projectReassignmentMethod: 'reassignStatusValue',
    forbiddenReplacementValues: new Set(['archived']),
    globalDefaults: Object.freeze([
      Object.freeze({
        code: 'NEW_PROJECT_STATUS_DEFAULT',
        key: PAGE_DEFAULT_DEFINITIONS.new_project.status.key,
        scope: 'global',
        page: 'new_project',
        option: 'status',
        label: 'New Project Status default',
        remediation: Object.freeze({
          href: '/settings/defaults#defaults-new-projects',
          label: 'Settings Defaults — New Projects',
        }),
      }),
      Object.freeze({
        code: 'PROJECTS_GLOBAL_STATUS_DEFAULT',
        key: PAGE_DEFAULT_DEFINITIONS.projects.status.key,
        scope: 'global',
        page: 'projects',
        option: 'status',
        label: 'Global Projects Status filter default',
        remediation: Object.freeze({ href: '/projects?defaults=1', label: 'Projects defaults' }),
      }),
    ]),
    projectDefaultOption: 'status',
    projectDefaultDescriptor: Object.freeze({
      code: 'PROJECTS_PROJECT_STATUS_DEFAULT',
      scope: 'project',
      page: 'projects',
      option: 'status',
      label: 'Project-scoped Projects Status filter default',
    }),
  }),
  projectType: Object.freeze({
    key: PROJECT_TYPE_CATALOGUE_KEY,
    addReservedValues: RESERVED_VALUES,
    projectReferenceCountMethod: 'countProjectTypeValue',
    projectReassignmentMethod: 'reassignProjectTypeValue',
    forbiddenReplacementValues: new Set(),
    globalDefaults: Object.freeze([
      Object.freeze({
        code: 'NEW_PROJECT_TYPE_DEFAULT',
        key: PAGE_DEFAULT_DEFINITIONS.new_project.projectType.key,
        scope: 'global',
        page: 'new_project',
        option: 'projectType',
        label: 'New Project Type default',
        remediation: Object.freeze({
          href: '/settings/defaults#defaults-new-projects',
          label: 'Settings Defaults — New Projects',
        }),
      }),
      Object.freeze({
        code: 'PROJECTS_GLOBAL_PROJECT_TYPE_DEFAULT',
        key: PAGE_DEFAULT_DEFINITIONS.projects.projectType.key,
        scope: 'global',
        page: 'projects',
        option: 'projectType',
        label: 'Global Projects Type filter default',
        remediation: Object.freeze({ href: '/projects?defaults=1', label: 'Projects defaults' }),
      }),
    ]),
    projectDefaultOption: 'projectType',
    projectDefaultDescriptor: Object.freeze({
      code: 'PROJECTS_PROJECT_TYPE_DEFAULT',
      scope: 'project',
      page: 'projects',
      option: 'projectType',
      label: 'Project-scoped Projects Type filter default',
    }),
  }),
});

export class ProjectOptionCatalogueValidationError extends Error {
  constructor(errors) {
    super('Project option catalogue validation failed');
    this.name = 'ProjectOptionCatalogueValidationError';
    this.errors = errors;
    this.status = 422;
  }
}

export class ProjectOptionCatalogueIntegrityError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'ProjectOptionCatalogueIntegrityError';
    this.code = code;
  }
}

export class ProjectOptionCatalogueConflictError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProjectOptionCatalogueConflictError';
    this.code = code;
    this.status = 409;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(errors) {
  throw new ProjectOptionCatalogueValidationError(errors);
}

function requireDefinition(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(DEFINITIONS, kind)) {
    invalid({ kind: `Project option catalogue "${kind}" is not supported.` });
  }
  return DEFINITIONS[kind];
}

function normalizeColor(color) {
  const normalized = typeof color === 'string' ? color.trim().toUpperCase() : '';
  if (!COLOR_PATTERN.test(normalized)) {
    invalid({ color: 'Color must be a six-digit hexadecimal value such as #22D3EE.' });
  }
  return normalized;
}

function assertExactInput(input, allowedKeys, field) {
  if (!isPlainObject(input)) invalid({ [field]: 'Input must be an object.' });
  const unexpected = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    invalid({ [field]: `Unexpected fields are not allowed: ${unexpected.join(', ')}.` });
  }
}

function validateStoredDocument(document, key) {
  const fail = (cause) => {
    throw new ProjectOptionCatalogueIntegrityError(
      `Stored Project option catalogue "${key}" is invalid.`,
      { code: 'CATALOGUE_INVALID', cause },
    );
  };

  if (!isProjectOptionCatalogueV1DocumentValid(document)) fail();

  return {
    version: PROJECT_OPTION_CATALOGUE_VERSION,
    entries: document.entries.map((entry) => ({ ...entry })),
  };
}

function parseStoredDocument(serialized, key) {
  if (serialized === undefined) {
    throw new ProjectOptionCatalogueIntegrityError(
      `Stored Project option catalogue "${key}" is missing.`,
      { code: 'CATALOGUE_MISSING' },
    );
  }
  try {
    return validateStoredDocument(JSON.parse(serialized), key);
  } catch (cause) {
    if (cause instanceof ProjectOptionCatalogueIntegrityError) throw cause;
    throw new ProjectOptionCatalogueIntegrityError(
      `Stored Project option catalogue "${key}" is invalid.`,
      { code: 'CATALOGUE_INVALID', cause },
    );
  }
}

export function createProjectOptionCatalogueService({
  db,
  appMetaRepository,
  projectRepository,
  projectPageDefaultRepository,
} = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('createProjectOptionCatalogueService requires a database dependency.');
  }
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createProjectOptionCatalogueService requires an appMetaRepository dependency.');
  }
  if (!projectRepository || typeof projectRepository.countStatusValue !== 'function'
    || typeof projectRepository.countProjectTypeValue !== 'function'
    || typeof projectRepository.reassignStatusValue !== 'function'
    || typeof projectRepository.reassignProjectTypeValue !== 'function') {
    throw new Error('createProjectOptionCatalogueService requires a projectRepository dependency.');
  }
  if (!projectPageDefaultRepository
    || typeof projectPageDefaultRepository.listOptionValueReferences !== 'function') {
    throw new Error(
      'createProjectOptionCatalogueService requires a projectPageDefaultRepository dependency.',
    );
  }

  function read(kind) {
    const { key } = requireDefinition(kind);
    return parseStoredDocument(appMetaRepository.getValue(key), key);
  }

  function write(kind, document) {
    const { key } = requireDefinition(kind);
    appMetaRepository.setValue(key, JSON.stringify(document));
    return validateStoredDocument(document, key);
  }

  function addOption(kind, input) {
    const definition = requireDefinition(kind);
    assertExactInput(input, ['name', 'color'], 'option');
    const label = typeof input.name === 'string' ? input.name.trim() : '';
    const errors = {};
    if (label.length < 1) errors.name = 'Name is required.';
    else if (label.length > NAME_MAX) errors.name = `Name must be ${NAME_MAX} characters or fewer.`;

    const value = label ? slugify(label, { lowercase: true }) : '';
    if (!VALUE_PATTERN.test(value)) errors.name = 'Name must produce a valid option value.';
    else if (definition.addReservedValues.has(value)) {
      errors.name = `The value "${value}" is reserved.`;
    }

    let color;
    try {
      color = normalizeColor(input.color);
    } catch (error) {
      if (error instanceof ProjectOptionCatalogueValidationError) Object.assign(errors, error.errors);
      else throw error;
    }
    if (Object.keys(errors).length > 0) invalid(errors);

    const document = read(kind);
    if (document.entries.some((entry) => entry.value === value)) {
      invalid({ name: `An option with value "${value}" already exists.` });
    }
    if (document.entries.some((entry) => entry.label.localeCompare(label, 'en-US', { sensitivity: 'accent' }) === 0)) {
      invalid({ name: `An option named "${label}" already exists.` });
    }

    const entry = { value, label, color };
    write(kind, { ...document, entries: [...document.entries, entry] });
    return { ...entry };
  }

  function updateOptionColor(kind, input) {
    assertExactInput(input, ['value', 'color'], 'option');
    const value = typeof input.value === 'string' ? input.value : '';
    const color = normalizeColor(input.color);
    const document = read(kind);
    const index = document.entries.findIndex((entry) => entry.value === value);
    if (index < 0) invalid({ value: `Project option "${value}" does not exist.` });

    const entries = document.entries.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, color } : entry
    ));
    write(kind, { ...document, entries });
    return { ...entries[index] };
  }

  function reorderOptions(kind, orderedValues) {
    if (!Array.isArray(orderedValues)
      || orderedValues.some((value) => typeof value !== 'string')) {
      invalid({ orderedValues: 'Order must be an array of option values.' });
    }
    if (new Set(orderedValues).size !== orderedValues.length) {
      invalid({ orderedValues: 'Order must not contain duplicate values.' });
    }

    const document = read(kind);
    const currentByValue = new Map(document.entries.map((entry) => [entry.value, entry]));
    if (orderedValues.length !== currentByValue.size
      || orderedValues.some((value) => !currentByValue.has(value))) {
      invalid({ orderedValues: 'Order must contain every current catalogue value exactly once.' });
    }

    return write(kind, {
      ...document,
      entries: orderedValues.map((value) => currentByValue.get(value)),
    }).entries;
  }

  function getSavedDefaultBlockers(definition, value) {
    const blockers = definition.globalDefaults
      .filter(({ key }) => appMetaRepository.getValue(key) === value)
      .map(({ key: _key, ...descriptor }) => ({ ...descriptor, referenceCount: 1 }));
    const projectReferences = projectPageDefaultRepository.listOptionValueReferences(
      'projects', definition.projectDefaultOption, value,
    );
    if (projectReferences.length > 0) {
      blockers.push({
        ...definition.projectDefaultDescriptor,
        referenceCount: projectReferences.length,
      });
    }
    return blockers;
  }

  function getDeletionMetadata(kind) {
    const definition = requireDefinition(kind);
    const document = read(kind);
    return document.entries.map((entry) => ({
      ...entry,
      deletion: {
        projectReferenceCount: projectRepository[definition.projectReferenceCountMethod](entry.value),
        savedDefaultBlockers: getSavedDefaultBlockers(definition, entry.value),
        eligibleReplacements: document.entries
          .filter((candidate) => candidate.value !== entry.value
            && !definition.forbiddenReplacementValues.has(candidate.value))
          .map(({ value, label }) => ({ value, label })),
      },
    }));
  }

  const deleteOptionTx = db.transaction((kind, value, replacement) => {
    const definition = requireDefinition(kind);
    const document = read(kind);
    if (!document.entries.some((entry) => entry.value === value)) {
      invalid({ value: `Project option "${value}" does not exist.` });
    }
    const projectReferenceCount = projectRepository[definition.projectReferenceCountMethod](value);
    const savedDefaultBlockers = getSavedDefaultBlockers(definition, value);
    if (savedDefaultBlockers.length > 0) {
      throw new ProjectOptionCatalogueConflictError(
        `Project option "${value}" is selected by a saved default.`,
        'OPTION_DEFAULT_REFERENCED',
      );
    }

    const replacementSupplied = replacement !== undefined;
    if (projectReferenceCount === 0 && replacementSupplied) {
      throw new ProjectOptionCatalogueConflictError(
        'A replacement is no longer applicable because no Projects use this option.',
        'OPTION_REPLACEMENT_UNEXPECTED',
      );
    }
    if (projectReferenceCount > 0 && !replacementSupplied) {
      throw new ProjectOptionCatalogueConflictError(
        `Project option "${value}" is assigned to a Project and requires a replacement.`,
        'OPTION_REPLACEMENT_REQUIRED',
      );
    }
    if (projectReferenceCount > 0) {
      const replacementEntry = typeof replacement === 'string' && VALUE_PATTERN.test(replacement)
        ? document.entries.find((entry) => entry.value === replacement)
        : undefined;
      if (!replacementEntry || replacement === value
        || definition.forbiddenReplacementValues.has(replacement)) {
        throw new ProjectOptionCatalogueConflictError(
          'The selected replacement is invalid or no longer available.',
          'OPTION_REPLACEMENT_INVALID',
        );
      }

      const changed = projectRepository[definition.projectReassignmentMethod](value, replacement);
      const remaining = projectRepository[definition.projectReferenceCountMethod](value);
      if (changed !== projectReferenceCount || remaining !== 0) {
        throw new ProjectOptionCatalogueIntegrityError(
          'Project option reassignment did not preserve catalogue integrity.',
          { code: 'CATALOGUE_REFERENCE_INTEGRITY' },
        );
      }
    }

    write(kind, {
      ...document,
      entries: document.entries.filter((entry) => entry.value !== value),
    });
    return true;
  });

  return {
    getStatusCatalogue() {
      return read('status').entries;
    },
    getProjectTypeCatalogue() {
      return read('projectType').entries;
    },
    getDeletionMetadata,
    addOption,
    updateOptionColor,
    reorderOptions,
    deleteOption(kind, value, replacement) {
      if (typeof value !== 'string' || !VALUE_PATTERN.test(value)) {
        invalid({ value: 'A valid Project option value is required.' });
      }
      return deleteOptionTx.immediate(kind, value, replacement);
    },
  };
}
