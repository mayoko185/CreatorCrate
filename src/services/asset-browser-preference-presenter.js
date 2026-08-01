import { validateDirectorySlug } from './asset-category-validation.js';

const PROJECT_FALLBACK_MESSAGES = Object.freeze({
  'project-preference-malformed': 'The saved project default is malformed. The browser currently uses All Categories; choose a valid replacement before saving.',
  'project-category-disabled': 'The saved project category is disabled. The browser currently uses All Categories; choose a valid replacement or re-enable that category.',
  'project-category-missing': 'The saved project category no longer exists. The browser currently uses All Categories; choose a valid replacement before saving.',
  'global-preference-malformed': 'The saved global default is malformed. Inherited projects currently use All Categories until a valid global default is saved.',
  'global-category-missing': 'The saved global category is unavailable. Inherited projects currently use All Categories until a valid global default is saved.',
  'global-category-disabled': 'The saved global category is disabled. Inherited projects currently use All Categories until a valid global default is saved.',
  'global-category-not-in-project': 'The inherited global category is unavailable in this project. This project currently uses All Categories.',
  'global-project-category-disabled': 'The inherited global category is disabled in this project. This project currently uses All Categories.',
});

const GLOBAL_FALLBACK_MESSAGES = Object.freeze({
  malformed: 'The saved global default is malformed. Inherited projects use All Categories until a valid global default is saved.',
  missing: 'The saved global category is unavailable or was deleted. Inherited projects use All Categories until a valid global default is saved.',
  disabled: 'The saved global category is disabled. Inherited projects use All Categories until a valid global default is saved.',
});

function isEnabled(row) {
  return row?.enabled === 1 || row?.enabled === true;
}

function normalizeCategory(row) {
  const id = row?.id;
  const displayName = row?.display_name ?? row?.displayName ?? `Category ${id}`;
  const directorySlug = row?.directory_slug ?? row?.directorySlug ?? null;
  return {
    id,
    displayName,
    directorySlug,
    enabled: isEnabled(row),
    value: Number.isSafeInteger(id) && id > 0 ? `category:${id}` : null,
    raw: row,
  };
}

function normalizeCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .map(normalizeCategory)
    .filter((category) => Number.isSafeInteger(category.id) && category.id > 0);
}

function firstValidationMessage(error) {
  const errors = error?.errors;
  if (errors && typeof errors === 'object') {
    for (const field of ['value', 'categoryId']) {
      if (typeof errors[field] === 'string') return errors[field];
    }
    const first = Object.values(errors).find((value) => typeof value === 'string');
    if (first) return first;
  }
  return typeof error === 'string' ? error : null;
}

function makeSubmittedOption(submittedValue, validValues) {
  if (typeof submittedValue !== 'string' || submittedValue.length === 0) return null;
  if (validValues.has(submittedValue)) return null;
  return {
    value: submittedValue,
    label: 'Submitted value is unavailable; choose a valid replacement.',
  };
}

function makeSelectionPlaceholder(selectedValue, unavailableOption) {
  if (selectedValue !== '') return null;
  if (unavailableOption) return unavailableOption;
  return {
    value: '',
    label: 'Choose a valid replacement…',
  };
}

function projectStoredValue(preference) {
  if (preference?.mode === 'inherit' || preference?.mode === 'all') return preference.mode;
  if (
    preference?.mode === 'category'
    && Number.isSafeInteger(preference.categoryId)
    && preference.categoryId > 0
  ) {
    return `category:${preference.categoryId}`;
  }
  return null;
}

function describeProjectStoredPreference(preference, category, storedValue) {
  if (preference?.mode === 'inherit') return 'Inherit global default';
  if (preference?.mode === 'all') return 'All Categories';
  if (preference?.mode === 'category') {
    if (category) {
      return `${category.displayName}${category.enabled ? '' : ' (disabled)'}`;
    }
    if (storedValue) return `Category ${preference.categoryId} (unavailable)`;
  }
  return 'Invalid saved preference';
}

function describeEffectiveCategory(resolution) {
  if (resolution?.effective?.kind === 'category') {
    const category = normalizeCategory(resolution.effective.category);
    return category.displayName;
  }
  return 'All Categories';
}

function projectFallbackExplanation(reason) {
  return reason ? PROJECT_FALLBACK_MESSAGES[reason] || 'The saved default is unavailable. The browser currently uses All Categories.' : null;
}

/**
 * Build the shared project-default presentation model for both project pages.
 * Resolution and validation remain in the injected domain service; this
 * helper only turns those results and category rows into render-ready values.
 */
export function buildProjectAssetBrowserPreferenceModel({
  projectId,
  preferenceService,
  categories,
  submittedValue,
  error,
} = {}) {
  const allCategories = normalizeCategories(categories);
  const enabledCategories = allCategories.filter((category) => category.enabled);
  const state = typeof preferenceService.getProjectPreferenceState === 'function'
    ? preferenceService.getProjectPreferenceState(projectId)
    : null;
  const preference = state?.preference || preferenceService.getProjectPreference(projectId);
  const resolution = state?.resolution || preferenceService.resolveEffectiveCategory(projectId);
  const storedValue = projectStoredValue(preference);
  const storedCategory = preference?.mode === 'category'
    ? allCategories.find((category) => category.id === preference.categoryId)
    : null;
  const storedAvailable = preference?.mode === 'inherit'
    || preference?.mode === 'all'
    || Boolean(storedCategory?.enabled);
  const submittedValueProvided = typeof submittedValue === 'string';
  const selectedValue = submittedValueProvided
    ? submittedValue
    : (storedAvailable && storedValue ? storedValue : '');
  const validValues = new Set(['inherit', 'all', ...enabledCategories.map((category) => category.value)]);
  const submittedOption = submittedValueProvided
    ? makeSubmittedOption(submittedValue, validValues)
    : null;
  const unavailableOption = !submittedOption && !storedAvailable
    ? {
        value: '',
        label: `Saved setting unavailable — ${describeProjectStoredPreference(preference, storedCategory, storedValue)}.`,
      }
    : null;

  return {
    storedMode: preference?.mode ?? 'inherit',
    storedCategoryId: preference?.categoryId ?? null,
    storedValue,
    storedLabel: describeProjectStoredPreference(preference, storedCategory, storedValue),
    storedAvailable,
    effectiveLabel: describeEffectiveCategory(resolution),
    effectiveCategory: resolution?.effective?.kind === 'category' ? resolution.effective.category : null,
    fallback: Boolean(resolution?.fallback),
    fallbackReason: resolution?.fallbackReason || null,
    fallbackExplanation: projectFallbackExplanation(resolution?.fallbackReason),
    enabledCategories,
    selectedValue,
    submittedOption,
    selectionPlaceholder: makeSelectionPlaceholder(selectedValue, unavailableOption),
    errorMessage: firstValidationMessage(error),
  };
}

function globalStoredState(storedValue, categories) {
  if (storedValue === 'all') {
    const sentinelConflict = categories.find((category) => category.directorySlug === 'all');
    return {
      available: true,
      label: 'All Categories',
      category: null,
      warning: sentinelConflict
        ? 'The directory slug "all" is reserved for the All Categories sentinel, so that global category cannot be selected distinctly.'
        : null,
      fallbackExplanation: null,
    };
  }

  if (typeof storedValue !== 'string' || validateDirectorySlug(storedValue) !== null) {
    return {
      available: false,
      label: 'Invalid saved global preference',
      category: null,
      warning: GLOBAL_FALLBACK_MESSAGES.malformed,
      fallbackExplanation: GLOBAL_FALLBACK_MESSAGES.malformed,
    };
  }

  const category = categories.find((candidate) => candidate.directorySlug === storedValue);
  if (!category) {
    return {
      available: false,
      label: `Category "${storedValue}" (unavailable)`,
      category: null,
      warning: GLOBAL_FALLBACK_MESSAGES.missing,
      fallbackExplanation: GLOBAL_FALLBACK_MESSAGES.missing,
    };
  }
  if (!category.enabled) {
    return {
      available: false,
      label: `${category.displayName} (disabled)`,
      category,
      warning: GLOBAL_FALLBACK_MESSAGES.disabled,
      fallbackExplanation: GLOBAL_FALLBACK_MESSAGES.disabled,
    };
  }

  return {
    available: true,
    label: category.displayName,
    category,
    warning: null,
    fallbackExplanation: null,
  };
}

/**
 * Build the Settings presentation model for the raw global default. Missing,
 * malformed, stale, and disabled values remain visible and are never changed.
 */
export function buildGlobalAssetBrowserPreferenceModel({
  preferenceService,
  categories,
  submittedValue,
  error,
} = {}) {
  const allCategories = normalizeCategories(categories);
  const enabledCategories = allCategories.filter((category) => category.enabled && category.directorySlug !== 'all');
  const storedValue = preferenceService.getGlobalPreference();
  const state = globalStoredState(storedValue, allCategories);
  const submittedValueProvided = typeof submittedValue === 'string';
  const selectedValue = submittedValueProvided
    ? submittedValue
    : (state.available ? storedValue : '');
  const validValues = new Set(['all', ...enabledCategories.map((category) => category.directorySlug)]);
  const submittedOption = submittedValueProvided
    ? makeSubmittedOption(submittedValue, validValues)
    : null;
  const unavailableOption = !submittedOption && !state.available
    ? { value: '', label: `Saved setting unavailable — ${state.label}.` }
    : null;

  return {
    storedValue,
    storedLabel: state.label,
    storedAvailable: state.available,
    enabledCategories,
    selectedValue,
    warning: state.warning,
    fallback: !state.available,
    fallbackExplanation: state.fallbackExplanation,
    submittedOption,
    selectionPlaceholder: makeSelectionPlaceholder(selectedValue, unavailableOption),
    errorMessage: firstValidationMessage(error),
  };
}
