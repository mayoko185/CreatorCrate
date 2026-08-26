import {
  getPageDefaultOptionCatalogue,
  PageDefaultValidationError,
  PAGE_DEFAULT_DEFINITIONS,
} from '../services/page-defaults-service.js';

function getPageDefaultDefinition(page) {
  const definition = typeof page === 'string' && Object.hasOwn(PAGE_DEFAULT_DEFINITIONS, page)
    ? PAGE_DEFAULT_DEFINITIONS[page]
    : null;
  if (!definition) {
    throw new Error(`Page "${page}" is not supported.`);
  }
  return definition;
}

function hasOptionCatalogues(optionCatalogues) {
  return Boolean(optionCatalogues && typeof optionCatalogues === 'object'
    && Object.keys(optionCatalogues).length > 0);
}

export function buildPageDefaultsDialogModel({
  pageDefaultsService,
  page,
  labels,
  submittedValues = null,
  errors = {},
  optionCatalogues = {},
} = {}) {
  const pageDefinition = getPageDefaultDefinition(page);
  const values = submittedValues || (hasOptionCatalogues(optionCatalogues)
    ? pageDefaultsService.resolvePageDefaults(page, {}, optionCatalogues)
    : pageDefaultsService.resolvePageDefaults(page));
  const fields = Object.keys(pageDefinition).map((option) => {
    const definition = pageDefinition[option];
    const optionCatalogue = getPageDefaultOptionCatalogue(definition, optionCatalogues?.[option]);
    const value = values?.[option];
    const error = errors[option] || null;
    const multi = definition.multi === true;
    const renderedOptionCatalogue = multi
      ? optionCatalogue.filter((candidate) => candidate.value !== 'all')
      : optionCatalogue;
    const showSubmittedValue = Boolean(
      !multi && error && typeof value === 'string'
        && !optionCatalogue.some((candidate) => candidate.value === value)
    );

    return {
      id: `${page}-default-${option}`,
      name: option,
      label: labels.fields[option],
      selectedValue: value,
      ...(multi ? { multi: true, selectedValues: Array.isArray(value) ? value : [] } : {}),
      options: renderedOptionCatalogue.map((candidate) => ({
        value: candidate.value,
        label: candidate.label ?? labels.options[option]?.[candidate.value] ?? candidate.value,
      })),
      error,
      showSubmittedValue,
      submittedOptionValue: showSubmittedValue ? value : null,
      submittedDisplayValue: showSubmittedValue ? value : null,
    };
  });

  return { fields };
}

export function handlePageDefaultsPost(req, res, next, {
  db,
  pageDefaultsService,
  page,
  successMessage,
  saveErrorMessage,
  onValidationError,
  onSuccess,
  optionCatalogues = {},
  validateSubmission = null,
  saveValidatedValues = null,
} = {}) {
  const pageDefinition = getPageDefaultDefinition(page);
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  const submittedValues = Object.fromEntries(
    Object.keys(pageDefinition).map((option) => [
      option,
      pageDefinition[option].multi === true && rawBody[option] === undefined
        ? 'all'
        : rawBody[option],
    ])
  );
  const enhanced = String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
  const useOptionCatalogues = hasOptionCatalogues(optionCatalogues);
  let validatedValues;
  let submission;

  try {
    submission = typeof validateSubmission === 'function'
      ? validateSubmission({ rawBody, submittedValues })
      : undefined;
    validatedValues = useOptionCatalogues
      ? pageDefaultsService.validatePageDefaults(page, submittedValues, optionCatalogues)
      : pageDefaultsService.validatePageDefaults(page, submittedValues);
  } catch (err) {
    if (!(err instanceof PageDefaultValidationError)) return next(err);

    const errors = err.errors || {};
    if (enhanced) {
      res.status(422).json({
        status: 'error',
        errors,
        values: submittedValues,
      });
      return;
    }

    onValidationError({ submittedValues, errors, submission });
    return;
  }

  try {
    const save = () => {
      if (typeof saveValidatedValues === 'function') {
        return saveValidatedValues({ validatedValues, submission });
      }

      for (const option of Object.keys(pageDefinition)) {
        const optionCatalogue = optionCatalogues?.[option];
        if (optionCatalogue !== undefined) {
          pageDefaultsService.saveDefault(page, option, validatedValues[option], optionCatalogue);
        } else {
          pageDefaultsService.saveDefault(page, option, validatedValues[option]);
        }
      }
    };
    if (typeof db?.transaction === 'function') db.transaction(save)();
    else save();
  } catch (err) {
    if (enhanced) {
      res.status(500).json({
        status: 'error',
        message: saveErrorMessage,
      });
      return;
    }
    next(err);
    return;
  }

  if (enhanced) {
    res.json({
      status: 'success',
      message: successMessage,
      values: validatedValues,
    });
    return;
  }

  onSuccess(submission === undefined
    ? { validatedValues }
    : { validatedValues, submission });
}
