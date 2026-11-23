import {
  calendarLiveApplicationFallbacks,
  calendarLiveSnapshot,
  navigateCalendarLive,
  rememberCalendarApplicationFallbacks,
  subscribeCalendarLive,
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
 * WP14a — Calendar Filters & Defaults transport.
 *
 * Calendar uses Global page defaults only (page key `calendar`); there is no
 * Global/Project-only scope. This module is the Calendar config of the shared
 * explicit defaults core (explicit-page-defaults.js), the same reviewed
 * controller the Asset Library, Projects and Releases dialogs use:
 *   - Save new defaults posts one snapshot of the THREE saveable settings
 *     (Desktop View, Release status, Week start) taken from the INSTALLED
 *     page authority (`current`: what the Calendar actually shows), with the
 *     durable `calendar` defaults generation and an operation identity. The
 *     displayed month, Projects and Project Types are never sent as values.
 *   - Reset filters is a GET to the installed page's Reset destination (the
 *     displayed month only): View, status and week start resolve from the
 *     saved defaults (then the fallbacks); Projects and Project Types clear.
 *   - Reset defaults is one fenced POST to /calendar/defaults/reset; the
 *     refresh keeps the displayed month and the temporary Projects / Types.
 * Ordinary filter edits only navigate through the Calendar live-region
 * engine; they never post defaults.
 *
 * OPT-IN BOUNDARY: only a `#calendar-filters-defaults-form` carrying
 * `data-defaults-explicit-save` (the WP14b combined dialog) binds, and never
 * while a legacy autosave form
 * (`#calendar-defaults-form[data-calendar-defaults-fetch-save]`, which posted
 * to /settings/defaults on every change) is on the page — the two must never
 * both write Calendar defaults. WP14b retired that form and its bootstrap
 * binding, so this adapter is the only page-local Calendar defaults writer.
 * Save and Reset defaults are rendered disabled type="button" controls and
 * are armed last.
 */

export const CALENDAR_DEFAULTS_FORM_SELECTOR = '#calendar-filters-defaults-form';
// The legacy per-control autosave marker. A form carrying it is never bound.
export const CALENDAR_DEFAULTS_AUTOSAVE_ATTRIBUTE = 'data-calendar-defaults-fetch-save';
export const CALENDAR_LEGACY_AUTOSAVE_FORM_SELECTOR = `#calendar-defaults-form[${CALENDAR_DEFAULTS_AUTOSAVE_ATTRIBUTE}]`;
export const CALENDAR_DEFAULTS_DIALOG_ID = 'calendar-filter-dialog';
export const CALENDAR_DEFAULTS_AUTHORITY_SELECTOR = '[data-calendar-live-region] script[data-calendar-defaults-authority]';
export const CALENDAR_DEFAULTS_SAVE_SELECTOR = '[data-calendar-defaults-save]';
export const CALENDAR_DEFAULTS_RESET_SELECTOR = '[data-calendar-defaults-reset]';
export const CALENDAR_FILTERS_RESET_SELECTOR = '[data-calendar-filters-reset]';
export const CALENDAR_DEFAULTS_FIELDS = Object.freeze(['view', 'status', 'weekStart']);
export const CALENDAR_DEFAULTS_GENERATION_FIELD = 'defaultsGeneration';
export const CALENDAR_DEFAULTS_OPERATION_FIELD = 'defaultsOperation';
const DEFAULTS_ENDPOINT = '/calendar/defaults';
const DEFAULTS_RESET_ENDPOINT = '/calendar/defaults/reset';
// The bare Calendar path. Reset filters never navigates here on its own: the
// installed authority's destination keeps the displayed month and, without
// one, calendarResetFiltersDestination derives the same month-only address.
const RESET_FILTERS_URL = '/calendar';
const CALENDAR_LIVE_REGION_SELECTOR = '[data-calendar-live-region]';
const CALENDAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CALENDAR_DEFAULTS_VALUES = {
  view: ['grid', 'list'],
  status: ['all', 'planned', 'published'],
  weekStart: ['monday', 'sunday'],
};

export function supportsCalendarDefaultsValue(field, value) {
  return CALENDAR_DEFAULTS_VALUES[field].includes(value);
}

export const CALENDAR_DEFAULTS_MESSAGES = Object.freeze({
  saving: 'Saving defaults.',
  saved: 'Defaults saved.',
  savedRefreshFailed: 'Defaults were saved, but Calendar could not be refreshed. Retry to refresh the page.',
  saveInProgress: 'Defaults are already being saved.',
  loading: 'Calendar is still loading. Save again when it has finished.',
  loadFailed: 'The current Calendar did not load. Retry loading it before saving defaults.',
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
  resetFiltersUnavailable: 'Filters could not be reset because the displayed month could not be read. Reload the page, then reset filters again.',
  resetDefaultsRunning: 'Defaults are already being reset.',
  resettingDefaults: 'Resetting defaults.',
  defaultsReset: 'Defaults reset to the application defaults.',
  defaultsResetRefreshFailed: 'Defaults were reset, but Calendar could not be refreshed. Retry to refresh the page.',
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

export const CALENDAR_SAVED_STATE_MESSAGES = Object.freeze({
  checking: 'Checking the saved defaults.',
  unreadable: 'The saved defaults could not be read. Reopen Filters & Defaults to check again.',
  none: 'No saved defaults',
  all: 'Defaults saved',
  differsFromSaved: 'Current settings differ from the saved defaults',
  differsFromApplication: 'Current settings differ from the application defaults',
});

// The Calendar page config of the shared explicit defaults core.
const CALENDAR_PAGE = Object.freeze({
  key: 'calendar',
  fields: CALENDAR_DEFAULTS_FIELDS,
  multiFields: new Set(),
  supportsValue: supportsCalendarDefaultsValue,
  onMetadataAccepted: rememberCalendarApplicationFallbacks,
  basePath: '/calendar',
  defaultsEndpoint: DEFAULTS_ENDPOINT,
  resetEndpoint: DEFAULTS_RESET_ENDPOINT,
  resetFiltersUrl: RESET_FILTERS_URL,
  generationField: CALENDAR_DEFAULTS_GENERATION_FIELD,
  operationField: CALENDAR_DEFAULTS_OPERATION_FIELD,
  authoritySelector: CALENDAR_DEFAULTS_AUTHORITY_SELECTOR,
  formSelector: CALENDAR_DEFAULTS_FORM_SELECTOR,
  autosaveAttribute: CALENDAR_DEFAULTS_AUTOSAVE_ATTRIBUTE,
  dialogId: CALENDAR_DEFAULTS_DIALOG_ID,
  // The temporary (never saved) context Reset defaults keeps: the displayed
  // month and the repeated Projects / Project Types (mirrors the route's
  // refreshUrl). View, status and week start follow the fallbacks.
  temporaryQueryKeys: Object.freeze(['month', 'project', 'type']),
  neutralTemporaryValues: Object.freeze({}),
  selectors: Object.freeze({
    indicator: '[data-calendar-defaults-indicator]',
    // Calendar has no Grid style: these never match, so the core's Grid
    // style presentation is inert here.
    gridStyleControl: '[data-calendar-grid-style]',
    grid: '[data-calendar-live-region] [data-calendar-grid-style]',
    save: CALENDAR_DEFAULTS_SAVE_SELECTOR,
    defaultsReset: CALENDAR_DEFAULTS_RESET_SELECTOR,
    filtersReset: CALENDAR_FILTERS_RESET_SELECTOR,
    recovery: '[data-calendar-defaults-recovery]',
    retry: '[data-calendar-defaults-retry]',
    check: '[data-calendar-defaults-check]',
  }),
  messages: CALENDAR_DEFAULTS_MESSAGES,
  savedStateMessages: CALENDAR_SAVED_STATE_MESSAGES,
  live: () => ({
    snapshot: calendarLiveSnapshot,
    navigate: navigateCalendarFromDefaults,
    subscribe: subscribeCalendarLive,
  }),
  resetDefaultsDestination: (returnTo, base) => calendarResetDefaultsDestination(returnTo, base),
  resetFiltersFallback: (document) => calendarResetFiltersDestination(document),
});

// Controllers created directly (createCalendarFiltersDefaults) per document;
// enhanced ones are found through the shared registry.
const directControllers = new WeakMap();

/**
 * Cumulative closure P2: the defaults authority this document's controller has
 * CONFIRMED, at its known defaults generation, or null. After a confirmed
 * Reset defaults the installed page still names the deleted saved values
 * until its refresh installs; this is what the omitted Status / View / week
 * start of that refresh (and of any later navigation before an install)
 * resolve to. A confirmed Reset whose answer carried no authority deleted
 * every saved key, so its effective values are the application fallbacks.
 */
function calendarConfirmedDefaultsAuthority(document) {
  const controller = explicitPageDefaultsController(document, CALENDAR_PAGE) || directControllers.get(document);
  if (!controller) return null;
  const generation = controller.generation;
  if (!Number.isSafeInteger(generation)) return null;
  const metadata = controller.savedMetadata();
  if (metadata) return metadata.generation === generation ? metadata : null;
  const operation = controller.operation;
  if (operation?.kind !== 'resetDefaults' || !operation.confirmed) return null;
  const fallbacks = calendarLiveApplicationFallbacks(document);
  return fallbacks ? { generation, defaults: fallbacks } : null;
}

// Every defaults-controller GET (a confirmed Save / Reset defaults refresh,
// its Retry, Reset filters) carries that confirmed authority to the engine.
function navigateCalendarFromDefaults(document, destination, options = {}) {
  let defaultsAuthority = null;
  try {
    defaultsAuthority = calendarConfirmedDefaultsAuthority(document);
  } catch {
    defaultsAuthority = null;
  }
  return navigateCalendarLive(document, destination, { ...options, defaultsAuthority });
}

/**
 * C4: the Reset filters destination when the installed authority is missing,
 * unreadable or carries no destination. It mirrors the route's own
 * `resetFiltersUrl` (and the native Reset form): only the DISPLAYED month —
 * the installed live region's `data-calendar-month`, replaced with each
 * installed response — so Projects / Project Types clear and View, status
 * and week start resolve from the saved defaults (then the fallbacks). Never
 * the current location (it may carry temporary filters) or a pending or
 * failed request's month. Null when the displayed month cannot be read: the
 * caller then refuses instead of navigating to the current month.
 */
export function calendarResetFiltersDestination(document) {
  const month = document?.querySelector?.(CALENDAR_LIVE_REGION_SELECTOR)?.getAttribute?.('data-calendar-month');
  if (typeof month !== 'string' || !CALENDAR_MONTH_PATTERN.test(month)) return null;
  return `${RESET_FILTERS_URL}?${new URLSearchParams({ month })}`;
}

/**
 * The Reset defaults refresh destination when the server's own `refreshUrl`
 * was not received: mirrors the route (the displayed month and repeated
 * Projects / Project Types of `returnTo`; View, status and week start left to
 * their post-deletion fallbacks).
 */
export function calendarResetDefaultsDestination(returnTo, base) {
  return explicitPageResetDefaultsDestination(CALENDAR_PAGE, returnTo, base);
}

export function sameCalendarDefaultsValues(left, right) {
  return sameExplicitPageDefaultsValues(CALENDAR_PAGE, left, right);
}

export function parseCalendarDefaultsAuthority(value, options = {}) {
  return parseExplicitPageDefaultsAuthority(CALENDAR_PAGE, value, options);
}

export function readCalendarDefaultsAuthority(document) {
  return readExplicitPageDefaultsAuthority(CALENDAR_PAGE, document);
}

export function describeCalendarSavedState(metadata, current, options = {}) {
  return describeExplicitPageSavedState(CALENDAR_PAGE, metadata, current, options);
}

/**
 * Creates the Calendar defaults controller for one document. All
 * collaborators are injectable for tests.
 */
export function createCalendarFiltersDefaults(document, options = {}) {
  const controller = createExplicitPageDefaults(document, CALENDAR_PAGE, options);
  if (document && typeof document === 'object') directControllers.set(document, controller);
  return controller;
}

export function bindCalendarFiltersDefaultsDialog(document, controller, options = {}) {
  return bindExplicitPageDefaultsDialog(document, controller, CALENDAR_PAGE, options);
}

export function calendarFiltersDefaultsController(document) {
  return explicitPageDefaultsController(document, CALENDAR_PAGE);
}

/**
 * Binds the explicit-save transport to the WP14b combined dialog. Returns the
 * controller or null: no opted-in form on this page, or the legacy autosave
 * form is still present (it would write the same preferences).
 */
export function enhanceCalendarFiltersDefaults(document = globalThis.document, options = {}) {
  if (document?.querySelector?.(CALENDAR_LEGACY_AUTOSAVE_FORM_SELECTOR)) return null;
  return enhanceExplicitPageDefaults(document, CALENDAR_PAGE, options);
}
