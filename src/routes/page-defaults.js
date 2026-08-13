import {
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

export function buildPageDefaultsDialogModel({
  pageDefaultsService,
  page,
  labels,
  submittedValues = null,
  errors = {},
} = {}) {
  const pageDefinition = getPageDefaultDefinition(page);
  const values = submittedValues || pageDefaultsService.resolvePageDefaults(page);
  const fields = Object.keys(pageDefinition).map((option) => {
    const definition = pageDefinition[option];
    const value = values?.[option];
    const error = errors[option] || null;
    const showSubmittedValue = Boolean(
      error && typeof value === 'string' && !definition.values.includes(value)
    );

    return {
      id: `${page}-default-${option}`,
      name: option,
      label: labels.fields[option],
      selectedValue: value,
      options: definition.values.map((candidate) => ({
        value: candidate,
        label: labels.options[option][candidate],
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
} = {}) {
  const pageDefinition = getPageDefaultDefinition(page);
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  const submittedValues = Object.fromEntries(
    Object.keys(pageDefinition).map((option) => [option, rawBody[option]])
  );
  const enhanced = String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
  let validatedValues;

  try {
    validatedValues = pageDefaultsService.validatePageDefaults(page, submittedValues);
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

    onValidationError({ submittedValues, errors });
    return;
  }

  try {
    const save = () => {
      for (const option of Object.keys(pageDefinition)) {
        pageDefaultsService.saveDefault(page, option, validatedValues[option]);
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

  onSuccess({ validatedValues });
}
