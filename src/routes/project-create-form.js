import { WORKFLOW_STATUSES } from '../services/project-service.js';
import { PROJECT_TYPES, DEFAULT_PROJECT_TYPE } from '../data/project-repository.js';

export function createFormValues(values) {
  const formValues = { ...values };
  delete formValues.priority;
  return formValues;
}

function createNewProjectFormValues(query, pageDefaultsService) {
  return {
    ...createFormValues(query),
    status: pageDefaultsService.resolve('new_project', 'status', query.status),
    projectType: query.projectType || DEFAULT_PROJECT_TYPE,
  };
}

function loadAvailableTags(tagService) {
  return tagService.listTags().map((tag) => ({
    id: tag.id,
    displayName: tag.display_name,
  }));
}

export function buildNewProjectFormModel({
  tagService,
  pageDefaultsService,
  query = {},
  values,
  errors = {},
  selectedTagIds = [],
} = {}) {
  return {
    values: values === undefined
      ? createNewProjectFormValues(query, pageDefaultsService)
      : createFormValues(values),
    errors,
    statuses: WORKFLOW_STATUSES,
    projectTypes: PROJECT_TYPES,
    tags: loadAvailableTags(tagService),
    selectedTagIds,
  };
}
