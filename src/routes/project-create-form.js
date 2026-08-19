import { WORKFLOW_STATUSES } from '../services/project-service.js';

export function createFormValues(values) {
  const formValues = { ...values };
  delete formValues.priority;
  return formValues;
}

function createNewProjectFormValues(query, pageDefaultsService) {
  return {
    ...createFormValues(query),
    status: pageDefaultsService.resolve('new_project', 'status', query.status),
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
    tags: loadAvailableTags(tagService),
    selectedTagIds,
  };
}
