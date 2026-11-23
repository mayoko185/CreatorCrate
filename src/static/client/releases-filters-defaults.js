import {
  navigateReleasesLive,
  releasesLiveSnapshot,
  subscribeReleasesLive,
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
 * WP12 — Releases Filters & Defaults transport.
 *
 * Releases uses Global page defaults only (page key `releases`); there is no
 * Global/Project-only scope. This module is the Releases config of the shared
 * explicit defaults core (explicit-page-defaults.js), the same reviewed
 * controller the Asset Library and Projects dialogs use:
 *   - Save new defaults posts one snapshot of the TWO saveable settings (Sort
 *     by, Sort order) taken from the INSTALLED page authority, with the
 *     durable `releases` defaults generation and an operation identity.
 *     Search, Projects, Project Types, Schedule, Include archived, the
 *     exact-asset scope and the URL page size are never sent.
 *   - Reset filters is a GET to the installed page's Reset destination
 *     (/releases, keeping only a non-default URL page size; without a usable
 *     authority, releasesResetFiltersDestination derives it); the server
 *     resolves Sort/Order from the saved defaults, then the application
 *     fallbacks, and clears every temporary filter and the asset scope.
 *   - Reset defaults is one fenced POST to /releases/defaults/reset; the
 *     refresh keeps the temporary Releases context.
 * Ordinary filter edits only navigate through the Releases live-region
 * engine; they never post defaults (the legacy per-control autosave binding
 * is not bound: the form has no `data-releases-defaults-autosave` marker).
 *
 * OPT-IN BOUNDARY: only a `#releases-defaults-form` carrying
 * `data-defaults-explicit-save` (and not the legacy autosave marker) binds.
 * Save and Reset defaults are rendered disabled type="button" controls and
 * are armed last, so any initialization failure leaves them inert.
 */

export const RELEASES_DEFAULTS_FORM_SELECTOR = '#releases-defaults-form';
export const RELEASES_DEFAULTS_AUTOSAVE_ATTRIBUTE = 'data-releases-defaults-autosave';
export const RELEASES_DEFAULTS_DIALOG_ID = 'releases-filter-dialog';
export const RELEASES_DEFAULTS_AUTHORITY_SELECTOR = '[data-releases-live-region] script[data-releases-defaults-authority]';
export const RELEASES_DEFAULTS_SAVE_SELECTOR = '[data-releases-defaults-save]';
export const RELEASES_DEFAULTS_RESET_SELECTOR = '[data-releases-defaults-reset]';
export const RELEASES_FILTERS_RESET_SELECTOR = '[data-releases-filters-reset]';
export const RELEASES_DEFAULTS_FIELDS = Object.freeze(['sort', 'order']);
export const RELEASES_DEFAULTS_GENERATION_FIELD = 'defaultsGeneration';
export const RELEASES_DEFAULTS_OPERATION_FIELD = 'defaultsOperation';
const DEFAULTS_ENDPOINT = '/releases/defaults';
const DEFAULTS_RESET_ENDPOINT = '/releases/defaults/reset';
const RESET_FILTERS_URL = '/releases';
// The Releases filter form (#list-releases-filter). Its hidden `pageSize`
// field is the one page-size intent: server-rendered for the installed page,
// mirrored to every requested destination as it starts (R7) and reconciled to
// each installed response.
const RELEASES_FILTER_FORM_SELECTOR = '[data-releases-filter]';
// The list GET's own page-size rule (workflow-query-service
// normalizeListFilters): a strict positive integer, at most 100, else 25; the
// canonical URL omits the default (buildReleaseManagementUrlQuery).
const RELEASES_DEFAULT_PAGE_SIZE = 25;
const RELEASES_MAX_PAGE_SIZE = 100;
const STRICT_POSITIVE_INTEGER = /^[1-9]\d*$/;

export const RELEASES_DEFAULTS_MESSAGES = Object.freeze({
  saving: 'Saving defaults.',
  saved: 'Defaults saved.',
  savedRefreshFailed: 'Defaults were saved, but Releases could not be refreshed. Retry to refresh the page.',
  saveInProgress: 'Defaults are already being saved.',
  loading: 'Releases are still loading. Save again when they have finished.',
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
  resetFiltersUnavailable: 'Filters could not be reset because the current page size could not be read. Reload the page, then reset filters again.',
  resetDefaultsRunning: 'Defaults are already being reset.',
  resettingDefaults: 'Resetting defaults.',
  defaultsReset: 'Defaults reset to the application defaults.',
  defaultsResetRefreshFailed: 'Defaults were reset, but Releases could not be refreshed. Retry to refresh the page.',
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

export const RELEASES_SAVED_STATE_MESSAGES = Object.freeze({
  checking: 'Checking the saved defaults.',
  unreadable: 'The saved defaults could not be read. Reopen Filters & Defaults to check again.',
  none: 'No saved defaults',
  all: 'Defaults saved',
  differsFromSaved: 'Current settings differ from the saved defaults',
  differsFromApplication: 'Current settings differ from the application defaults',
});

// The Releases page config of the shared explicit defaults core.
const RELEASES_PAGE = Object.freeze({
  key: 'releases',
  fields: RELEASES_DEFAULTS_FIELDS,
  multiFields: new Set(),
  basePath: '/releases',
  defaultsEndpoint: DEFAULTS_ENDPOINT,
  resetEndpoint: DEFAULTS_RESET_ENDPOINT,
  resetFiltersUrl: RESET_FILTERS_URL,
  generationField: RELEASES_DEFAULTS_GENERATION_FIELD,
  operationField: RELEASES_DEFAULTS_OPERATION_FIELD,
  authoritySelector: RELEASES_DEFAULTS_AUTHORITY_SELECTOR,
  formSelector: RELEASES_DEFAULTS_FORM_SELECTOR,
  autosaveAttribute: RELEASES_DEFAULTS_AUTOSAVE_ATTRIBUTE,
  dialogId: RELEASES_DEFAULTS_DIALOG_ID,
  // The temporary (never saved) context Reset defaults keeps: the exact-asset
  // scope, Search, repeated Projects and Project Types, Schedule, Include
  // archived and the URL page size (mirrors the route's refreshUrl).
  temporaryQueryKeys: Object.freeze([
    'asset', 'search', 'project', 'type', 'schedule', 'includeArchived', 'pageSize',
  ]),
  neutralTemporaryValues: Object.freeze({}),
  selectors: Object.freeze({
    indicator: '[data-releases-defaults-indicator]',
    // Releases has no Grid style: these never match, so the core's Grid
    // style presentation is inert here.
    gridStyleControl: '[data-releases-grid-style]',
    grid: '[data-releases-live-region] [data-releases-grid-style]',
    save: RELEASES_DEFAULTS_SAVE_SELECTOR,
    defaultsReset: RELEASES_DEFAULTS_RESET_SELECTOR,
    filtersReset: RELEASES_FILTERS_RESET_SELECTOR,
    recovery: '[data-releases-defaults-recovery]',
    retry: '[data-releases-defaults-retry]',
    check: '[data-releases-defaults-check]',
  }),
  messages: RELEASES_DEFAULTS_MESSAGES,
  savedStateMessages: RELEASES_SAVED_STATE_MESSAGES,
  live: () => ({
    snapshot: releasesLiveSnapshot,
    navigate: navigateReleasesLive,
    subscribe: subscribeReleasesLive,
  }),
  resetDefaultsDestination: (returnTo, base) => releasesResetDefaultsDestination(returnTo, base),
  resetFiltersFallback: (document) => releasesResetFiltersDestination(document),
});

/**
 * P3-B: the Reset filters destination when the installed authority is
 * missing, unreadable or carries no usable destination. It mirrors the
 * route's own `resetFiltersUrl` and the native Reset form: /releases with
 * ONLY a non-default page size — no asset scope, Search, Projects, Project
 * Types, Schedule, Include archived or page; Sort/Order resolve from the
 * saved defaults (then the fallbacks).
 *
 * The size is the filter form's enabled hidden `pageSize` (carriers
 * included): the latest intended size, so a newer pending or failed
 * page-size request wins over the installed one. Never the current location
 * or a wholesale form serialization. The native Reset form is not read: it
 * sits outside the live region and follows only the INSTALLED page size
 * (P3 correction 5), never a pending or failed newer size.
 * The value is normalized by the list GET's own rule, so client-controlled
 * data never yields a size the server would not render. Null (the caller
 * then refuses with a message) when the form is absent or carries
 * conflicting sizes.
 */
export function releasesResetFiltersDestination(document) {
  const form = document?.querySelector?.(RELEASES_FILTER_FORM_SELECTOR);
  if (!form) return null;
  const values = new Set(Array.from(form.querySelectorAll?.('input[name="pageSize"]') || [])
    .filter((input) => input.type === 'hidden' && !input.disabled)
    .map((input) => String(input.value ?? '')));
  if (values.size > 1) return null;
  const raw = values.size === 1 ? [...values][0] : '';
  let pageSize = STRICT_POSITIVE_INTEGER.test(raw) ? Number(raw) : RELEASES_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = RELEASES_DEFAULT_PAGE_SIZE;
  if (pageSize > RELEASES_MAX_PAGE_SIZE) pageSize = RELEASES_MAX_PAGE_SIZE;
  return pageSize === RELEASES_DEFAULT_PAGE_SIZE
    ? RESET_FILTERS_URL
    : `${RESET_FILTERS_URL}?${new URLSearchParams({ pageSize: String(pageSize) })}`;
}

/**
 * The Reset defaults refresh destination when the server's own `refreshUrl`
 * was not received: mirrors the route (the temporary context of `returnTo`,
 * page 1, Sort/Order left to their post-deletion fallbacks).
 */
export function releasesResetDefaultsDestination(returnTo, base) {
  return explicitPageResetDefaultsDestination(RELEASES_PAGE, returnTo, base);
}

export function sameReleasesDefaultsValues(left, right) {
  return sameExplicitPageDefaultsValues(RELEASES_PAGE, left, right);
}

export function parseReleasesDefaultsAuthority(value, options = {}) {
  return parseExplicitPageDefaultsAuthority(RELEASES_PAGE, value, options);
}

export function readReleasesDefaultsAuthority(document) {
  return readExplicitPageDefaultsAuthority(RELEASES_PAGE, document);
}

export function describeReleasesSavedState(metadata, current, options = {}) {
  return describeExplicitPageSavedState(RELEASES_PAGE, metadata, current, options);
}

/**
 * Creates the Releases defaults controller for one document. All
 * collaborators are injectable for tests.
 */
export function createReleasesFiltersDefaults(document, options = {}) {
  return createExplicitPageDefaults(document, RELEASES_PAGE, options);
}

export function bindReleasesFiltersDefaultsDialog(document, controller, options = {}) {
  return bindExplicitPageDefaultsDialog(document, controller, RELEASES_PAGE, options);
}

export function releasesFiltersDefaultsController(document) {
  return explicitPageDefaultsController(document, RELEASES_PAGE);
}

/**
 * Binds the explicit-save transport to the WP12 combined dialog. Returns the
 * controller or null (no opted-in form on this page).
 */
export function enhanceReleasesFiltersDefaults(document = globalThis.document, options = {}) {
  return enhanceExplicitPageDefaults(document, RELEASES_PAGE, options);
}
