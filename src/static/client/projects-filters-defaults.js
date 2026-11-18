import {
  navigateProjectsLive,
  projectsLiveSnapshot,
  subscribeProjectsLive,
} from './live-regions.js';
import {
  bindExplicitPageDefaultsDialog,
  createExplicitPageDefaults,
  describeExplicitPageSavedState,
  enhanceExplicitPageDefaults,
  explicitPageDefaultsController,
  explicitPageResetDefaultsDestination,
  parseExplicitPageDefaultsAuthority,
  readExplicitPageDefaultsAuthority,
  sameExplicitPageDefaultsValues,
} from './explicit-page-defaults.js';

/*
 * WP10b — Projects Filters & Defaults transport.
 *
 * Projects uses Global page defaults only (page key `projects`); there is no
 * Global/Project-only scope and no Project ID default. This module is the
 * Projects config of the shared explicit defaults core
 * (explicit-page-defaults.js), the same reviewed controller the Asset Library
 * dialog uses:
 *   - Save new defaults posts one snapshot of the SEVEN saveable settings
 *     (View, Grid style, Sort, Order, Status, Project Type, Tag) taken from
 *     the INSTALLED page authority plus the session Grid style, with the
 *     durable `projects` defaults generation and an operation identity.
 *     Search and the repeated Project restriction are never sent.
 *   - Reset filters is a GET to /projects (the server resolves every
 *     default-backed control from the saved defaults, then the application
 *     fallbacks, and clears Search and Projects).
 *   - Reset defaults is one fenced POST to /projects/defaults/reset; the
 *     refresh keeps the temporary Projects/Search context.
 * Ordinary filter edits only navigate through the Projects live-region
 * engine; they never post defaults (the legacy per-control autosave binding
 * is not bound: the form has no `data-projects-defaults-autosave` marker).
 *
 * OPT-IN BOUNDARY: only a `#projects-defaults-form` carrying
 * `data-defaults-explicit-save` (and not the legacy autosave marker) binds.
 * Save and Reset defaults are rendered disabled type="button" controls and
 * are armed last, so any initialization failure leaves them inert.
 */

export const PROJECTS_DEFAULTS_FORM_SELECTOR = '#projects-defaults-form';
export const PROJECTS_DEFAULTS_AUTOSAVE_ATTRIBUTE = 'data-projects-defaults-autosave';
export const PROJECTS_DEFAULTS_DIALOG_ID = 'projects-filter-dialog';
export const PROJECTS_DEFAULTS_AUTHORITY_SELECTOR = '[data-projects-live-region] script[data-projects-defaults-authority]';
export const PROJECTS_DEFAULTS_SAVE_SELECTOR = '[data-projects-defaults-save]';
export const PROJECTS_DEFAULTS_RESET_SELECTOR = '[data-projects-defaults-reset]';
export const PROJECTS_FILTERS_RESET_SELECTOR = '[data-projects-filters-reset]';
export const PROJECTS_DEFAULTS_FIELDS = Object.freeze([
  'view', 'gridStyle', 'sort', 'order', 'status', 'projectType', 'tag',
]);
export const PROJECTS_DEFAULTS_GENERATION_FIELD = 'defaultsGeneration';
export const PROJECTS_DEFAULTS_OPERATION_FIELD = 'defaultsOperation';
const DEFAULTS_ENDPOINT = '/projects/defaults';
const DEFAULTS_RESET_ENDPOINT = '/projects/defaults/reset';
const RESET_FILTERS_URL = '/projects';

export const PROJECTS_DEFAULTS_MESSAGES = Object.freeze({
  saving: 'Saving defaults.',
  saved: 'Defaults saved.',
  savedRefreshFailed: 'Defaults were saved, but Projects could not be refreshed. Retry to refresh the page.',
  saveInProgress: 'Defaults are already being saved.',
  loading: 'Projects are still loading. Save again when they have finished.',
  loadFailed: 'The current filters did not load. Retry loading them before saving defaults.',
  resetPending: 'Reset filters has not finished. Save again when it has finished.',
  resetIncomplete: 'Reset filters did not finish. Retry loading the page before saving defaults.',
  unreadable: 'The current settings could not be read. Refresh the page before saving defaults.',
  unavailable: 'Defaults cannot be saved right now. Refresh the page and try again.',
  invalid: 'Defaults were not saved. Check the highlighted settings. Your current choices were kept.',
  csrf: 'Defaults were not saved because the session expired. Refresh the page and try again.',
  notSaved: 'Defaults were not saved. Your current choices were kept.',
  uncertain: 'Could not confirm whether the defaults were saved. Check again before changing them.',
  saveUnresolved: 'Could not confirm whether the defaults were saved, and the save may still finish. Reload the page before changing defaults again.',
  saveMatchesUnconfirmed: 'The saved defaults already match these settings, but this save could not be confirmed and may still finish. Reload the page before changing defaults again.',
  checking: 'Checking whether the defaults were saved.',
  resetDefaultsRunning: 'Defaults are already being reset.',
  resettingDefaults: 'Resetting defaults.',
  defaultsReset: 'Defaults reset to the application defaults.',
  defaultsResetRefreshFailed: 'Defaults were reset, but Projects could not be refreshed. Retry to refresh the page.',
  defaultsNotReset: 'Defaults were not reset. Your saved defaults were kept.',
  defaultsResetUncertain: 'Could not confirm whether the defaults were reset. Check again before changing them.',
  resetDefaultsUnresolved: 'Could not confirm whether the defaults were reset, and the reset may still finish. Reload the page before changing defaults again.',
  resetMatchesUnconfirmed: 'No defaults are saved now, but this reset could not be confirmed and may still finish. Reload the page before changing defaults again.',
  busy: 'Wait for the current defaults change to finish.',
  saveConflict: 'Defaults were not saved because the saved defaults changed elsewhere. Your current choices were kept. Check the saved defaults, then save again.',
  resetConflict: 'Defaults were not reset because the saved defaults changed elsewhere. Check the saved defaults, then reset again.',
  saveOutcomeUnknown: 'Could not confirm whether the defaults were saved. The saved defaults have changed since, so this save can no longer finish. Check them before saving again.',
  resetOutcomeUnknown: 'Could not confirm whether the defaults were reset. The saved defaults have changed since, so this reset can no longer finish. Check them before changing them again.',
});

export const PROJECTS_SAVED_STATE_MESSAGES = Object.freeze({
  checking: 'Checking the saved defaults.',
  unreadable: 'The saved defaults could not be read. Reopen Filters & Defaults to check again.',
  none: 'No saved defaults',
  all: 'Defaults saved',
  differsFromSaved: 'Current settings differ from the saved defaults',
  differsFromApplication: 'Current settings differ from the application defaults',
});

// The Projects page config of the shared explicit defaults core.
const PROJECTS_PAGE = Object.freeze({
  key: 'projects',
  fields: PROJECTS_DEFAULTS_FIELDS,
  multiFields: new Set(['status', 'projectType', 'tag']),
  basePath: '/projects',
  defaultsEndpoint: DEFAULTS_ENDPOINT,
  resetEndpoint: DEFAULTS_RESET_ENDPOINT,
  resetFiltersUrl: RESET_FILTERS_URL,
  generationField: PROJECTS_DEFAULTS_GENERATION_FIELD,
  operationField: PROJECTS_DEFAULTS_OPERATION_FIELD,
  authoritySelector: PROJECTS_DEFAULTS_AUTHORITY_SELECTOR,
  formSelector: PROJECTS_DEFAULTS_FORM_SELECTOR,
  autosaveAttribute: PROJECTS_DEFAULTS_AUTOSAVE_ATTRIBUTE,
  dialogId: PROJECTS_DEFAULTS_DIALOG_ID,
  // The temporary (never saved) context Reset defaults keeps: the repeated
  // Project restriction and Search.
  temporaryQueryKeys: Object.freeze(['project', 'search']),
  neutralTemporaryValues: Object.freeze({ project: Object.freeze(['all']) }),
  selectors: Object.freeze({
    indicator: '[data-projects-defaults-indicator]',
    gridStyleControl: '[data-projects-grid-style]',
    grid: '[data-projects-live-region] .project-grid',
    save: PROJECTS_DEFAULTS_SAVE_SELECTOR,
    defaultsReset: PROJECTS_DEFAULTS_RESET_SELECTOR,
    filtersReset: PROJECTS_FILTERS_RESET_SELECTOR,
    recovery: '[data-projects-defaults-recovery]',
    retry: '[data-projects-defaults-retry]',
    check: '[data-projects-defaults-check]',
  }),
  messages: PROJECTS_DEFAULTS_MESSAGES,
  savedStateMessages: PROJECTS_SAVED_STATE_MESSAGES,
  live: () => ({
    snapshot: projectsLiveSnapshot,
    navigate: navigateProjectsLive,
    subscribe: subscribeProjectsLive,
  }),
  resetDefaultsDestination: (returnTo, base) => projectsResetDefaultsDestination(returnTo, base),
});

/**
 * The Reset defaults refresh destination when the server's own `refreshUrl`
 * was not received: mirrors the route (repeated Projects and Search of
 * `returnTo`, page 1, every default-backed control left to its fallback).
 */
export function projectsResetDefaultsDestination(returnTo, base) {
  return explicitPageResetDefaultsDestination(PROJECTS_PAGE, returnTo, base);
}

export function sameProjectsDefaultsValues(left, right) {
  return sameExplicitPageDefaultsValues(PROJECTS_PAGE, left, right);
}

export function parseProjectsDefaultsAuthority(value, options = {}) {
  return parseExplicitPageDefaultsAuthority(PROJECTS_PAGE, value, options);
}

export function readProjectsDefaultsAuthority(document) {
  return readExplicitPageDefaultsAuthority(PROJECTS_PAGE, document);
}

export function describeProjectsSavedState(metadata, current, options = {}) {
  return describeExplicitPageSavedState(PROJECTS_PAGE, metadata, current, options);
}

/**
 * Creates the Projects defaults controller for one document. All
 * collaborators are injectable for tests.
 */
export function createProjectsFiltersDefaults(document, options = {}) {
  return createExplicitPageDefaults(document, PROJECTS_PAGE, options);
}

export function bindProjectsFiltersDefaultsDialog(document, controller, options = {}) {
  return bindExplicitPageDefaultsDialog(document, controller, PROJECTS_PAGE, options);
}

export function projectsFiltersDefaultsController(document) {
  return explicitPageDefaultsController(document, PROJECTS_PAGE);
}

/**
 * Binds the explicit-save transport to the WP10b combined dialog. Returns
 * the controller or null (no opted-in form on this page).
 */
export function enhanceProjectsFiltersDefaults(document = globalThis.document, options = {}) {
  return enhanceExplicitPageDefaults(document, PROJECTS_PAGE, options);
}
