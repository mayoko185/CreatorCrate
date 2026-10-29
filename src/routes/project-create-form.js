export function createFormValues(values) {
  const formValues = { ...values };
  delete formValues.priority;
  delete formValues.plannedDate;
  delete formValues.publishedDate;
  delete formValues.planned_date;
  delete formValues.published_date;
  return formValues;
}

function createNewProjectFormValues(query, pageDefaultsService) {
  return {
    ...createFormValues(query),
    status: query.status === undefined
      ? pageDefaultsService.getSavedDefault('new_project', 'status')
      : pageDefaultsService.resolve('new_project', 'status', query.status),
    projectType: query.projectType === undefined
      ? pageDefaultsService.getSavedDefault('new_project', 'projectType')
      : pageDefaultsService.resolve('new_project', 'projectType', query.projectType),
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
  const statuses = pageDefaultsService.getOptionCatalogue('new_project', 'status')
    .filter(({ value }) => value !== 'archived');
  const projectTypes = pageDefaultsService.getOptionCatalogue('new_project', 'projectType');

  return {
    values: values === undefined
      ? createNewProjectFormValues(query, pageDefaultsService)
      : createFormValues(values),
    errors,
    statuses,
    projectTypes,
    tags: loadAvailableTags(tagService),
    selectedTagIds,
    resetValues: values === undefined ? null : {
      ...createNewProjectFormValues({}, pageDefaultsService),
      'tagIds[]': [],
    },
  };
}

/**
 * Option lists for a host's Edit Project dialog, rendered without a project:
 * every open loads that project's values and current tags from
 * GET /projects/:id/edit. The lists match Project Detail's edit form.
 */
export function buildProjectEditDialogFormModel({ tagService, pageDefaultsService, tags = null } = {}) {
  // tags: a tag list the host already loaded (for New Project), reused as is.
  if ((!tags && !tagService) || !pageDefaultsService) return null;
  return {
    values: {},
    errors: {},
    statuses: pageDefaultsService.getOptionCatalogue('new_project', 'status'),
    projectTypes: pageDefaultsService.getOptionCatalogue('projects', 'projectType')
      .filter(({ value }) => value !== 'all'),
    tags: tags || loadAvailableTags(tagService),
    selectedTagIds: [],
  };
}
